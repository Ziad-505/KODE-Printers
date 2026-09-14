import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../../config/index.js';
import { ADVISORY_LOCKS, pool, withAdvisoryLock } from '../../db/pool.js';
import { auditModel } from '../../models/audit.js';
import { collectorsModel } from '../../models/collectors.js';
import { jobsModel } from '../../models/jobs.js';
import { ledgerModel } from '../../models/ledger.js';
import { notificationsModel } from '../../models/notifications.js';
import { passwordTokensModel } from '../../models/passwordTokens.js';
import { refreshTokensModel } from '../../models/refreshTokens.js';
import { scansModel } from '../../models/scans.js';
import { getSettings } from '../../models/settings.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';
import { notify } from '../notify.js';

const log = subsystem('watcher:retention');

/**
 * The retention sweep (DEC-03, §B10.7, R9).
 *
 * The distinction that governs everything here: **file bytes are purged, job
 * records are not.** NFR-12 requires job history for three years minimum
 * because the record is the point of the system; DEC-03 governs only how long
 * the original documents sit on disk.
 *
 * So a purged job keeps its user, printer, page count, cost and timestamp — it
 * simply can no longer be reprinted from the original, and its notes say so.
 */

let timer: NodeJS.Timeout | null = null;
let stopping = false;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function startRetentionSweep(): void {
  stopping = false;
  // Delayed first run: boot is busy enough with migrations and probes.
  timer = setTimeout(() => void run(), 5 * 60 * 1000);
  timer.unref();
}

export function stopRetentionSweep(): void {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

async function run(): Promise<void> {
  if (stopping) return;

  // Advisory lock so a collector or a second instance cannot delete the same
  // files concurrently. `withAdvisoryLock` returns without waiting when the
  // lock is held, which is right for a periodic job.
  await withAdvisoryLock(ADVISORY_LOCKS.retentionSweep, async () => {
    try {
      await sweep();
    } catch (error) {
      log.error({ ...serialiseError(error) }, 'retention sweep failed');
    }
  });

  if (!stopping) {
    timer = setTimeout(() => void run(), SWEEP_INTERVAL_MS);
    timer.unref();
  }
}

export async function sweep(): Promise<{
  uploadsPurged: number;
  scansPurged: number;
  notificationsPurged: number;
  tokensPurged: number;
}> {
  const settings = await getSettings();
  const startedAt = Date.now();

  const uploadsPurged = await purgeUploads(settings.uploadRetentionDays);
  const scansPurged = await purgeScans(settings.scanRetentionDays);
  const notificationsPurged = await notificationsModel.purgeOld(
    pool,
    settings.notificationRetentionDays,
  );
  const tokensPurged = await refreshTokensModel.purgeExpired(pool);

  await ledgerModel.expire(pool);
  await scansModel.expireReservations(pool);
  await collectorsModel.purgeOldEventKeys(pool);
  // Spent and expired set-password links. Kept a week past their end so
  // "did she ever use that link?" still has an answer.
  await passwordTokensModel.purgeSpent(pool);

  // §B10.7 — purge activity is logged. An auditor asking "where did the
  // original go" gets an answer rather than a shrug.
  if (uploadsPurged + scansPurged > 0) {
    await auditModel.write(pool, {
      actorUserId: null,
      actorUsername: 'system',
      action: 'retention.purge',
      entityType: 'retention',
      after: {
        uploadsPurged,
        scansPurged,
        notificationsPurged,
        tokensPurged,
        uploadRetentionDays: settings.uploadRetentionDays,
        scanRetentionDays: settings.scanRetentionDays,
      },
    });
  }

  log.info(
    {
      uploadsPurged,
      scansPurged,
      notificationsPurged,
      tokensPurged,
      durationMs: Date.now() - startedAt,
    },
    'retention sweep complete',
  );

  await checkDiskPressure();

  return { uploadsPurged, scansPurged, notificationsPurged, tokensPurged };
}

/**
 * Removes uploaded originals past the retention window.
 *
 * A retention of 0 means "delete on successful print", which the sweep honours
 * by treating any completed job as immediately eligible.
 */
async function purgeUploads(retentionDays: number): Promise<number> {
  const uploadDir = resolve(config.storage.uploadDir);
  const candidates = await jobsModel.listPurgeableFiles(pool, retentionDays, uploadDir);
  let purged = 0;

  for (const candidate of candidates) {
    // Never delete outside the upload directory, whatever the stored path says.
    // The query already excludes those; this is the check that makes it a
    // guarantee rather than an assumption about how paths were written.
    if (!resolve(candidate.filePath).startsWith(uploadDir)) {
      log.error({ jobId: candidate.id }, 'refusing to purge a file outside the upload directory');
      continue;
    }

    await rm(candidate.filePath, { force: true }).catch((error: unknown) => {
      log.warn({ jobId: candidate.id, ...serialiseError(error) }, 'could not remove upload');
    });
    // The row is updated whether or not the unlink succeeded: a missing file
    // and a purged file are the same state as far as the record is concerned.
    await jobsModel.clearFilePath(pool, candidate.id);
    purged += 1;
  }

  return purged;
}

async function purgeScans(retentionDays: number): Promise<number> {
  const candidates = await scansModel.listPurgeable(pool, retentionDays);
  let purged = 0;

  for (const candidate of candidates) {
    const path = join(config.storage.scanDir, candidate.storedFilename);
    if (!resolve(path).startsWith(resolve(config.storage.scanDir))) continue;

    await rm(path, { force: true }).catch(() => undefined);
    await scansModel.remove(pool, candidate.id);
    purged += 1;
  }

  return purged;
}

/**
 * R9 — the upload directory grows without bound unless someone is watching.
 *
 * Reported as a notification as well as a metric, because the Zabbix alert
 * (§B13.4) only helps if Zabbix is configured, and this system should be able
 * to say "I am running out of disk" on its own.
 */
async function checkDiskPressure(): Promise<void> {
  try {
    const { statfs } = await import('node:fs/promises');
    const stats = await statfs(config.storage.uploadDir);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    if (total === 0) return;

    const usedRatio = 1 - free / total;
    if (usedRatio < 0.8) return;

    await notify(
      {
        type: 'system.disk_pressure',
        severity: usedRatio >= 0.92 ? 'critical' : 'warning',
        message:
          `The upload volume is ${Math.round(usedRatio * 100)}% full. ` +
          'Reduce the retention window or extend the disk.',
        dedupeKey: 'system:disk-pressure',
      },
      pool,
    );
  } catch {
    // statfs is unavailable on some platforms. Not worth an error.
  }
}
