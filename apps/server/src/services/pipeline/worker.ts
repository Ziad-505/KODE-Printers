import { readFile } from 'node:fs/promises';
import {
  AppError,
  computeImpressions,
  DEFAULT_PRINT_OPTIONS,
  fileExtension,
  isAppError,
  type PrintOptions,
} from '@kode/shared';
import { config } from '../../config/index.js';
import { pool, withAdvisoryLock, ADVISORY_LOCKS, withTransaction } from '../../db/pool.js';
import { jobsModel, type DequeuedJob } from '../../models/jobs.js';
import { ledgerModel } from '../../models/ledger.js';
import { printersModel } from '../../models/printers.js';
import { getSettings } from '../../models/settings.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';
import { events } from '../events.js';
import { notify } from '../notify.js';
import { checkDispatch, retryDelayMs } from '../transport/safety.js';
import { send } from '../transport/select.js';
import {
  isImage,
  needsOfficeConversion,
  officeToPdf,
  pdfToPostScript,
  printerAcceptsPdf,
  requiredStage,
  stage,
  textToPdfStrict,
  toGrayscale,
} from './convert.js';
import { applyWatermark, countPdfPages, imageToPdf, selectPages } from './prepare.js';

const log = subsystem('pipeline:worker');

/**
 * The queue worker (§B10.1 steps 4–10, §B10.4).
 *
 * Concurrency is deliberately low — two by default. The converters are the
 * bottleneck and LibreOffice serialises anyway, so the only question is whether
 * it serialises gracefully or by blocking the event loop. Raising this number
 * does not increase throughput; it increases the number of `soffice` processes
 * competing for the same CPU.
 */

let running = false;
let activeCount = 0;
let stopping = false;
const timers = new Set<NodeJS.Timeout>();

export function startWorker(): void {
  if (running || !config.queue.enabled) return;
  running = true;
  stopping = false;

  log.info(
    { concurrency: config.queue.concurrency, workerId: config.queue.workerId },
    'queue worker started',
  );

  // Reclaim first. This is the single mechanism that makes a mid-job crash
  // recoverable (§B14): rows left in `processing` by a killed worker return to
  // `queued` and complete on restart instead of sitting there forever.
  void reclaim();

  for (let slot = 0; slot < config.queue.concurrency; slot += 1) {
    void loop(slot);
  }

  const reclaimTimer = setInterval(() => void reclaim(), 60_000);
  reclaimTimer.unref();
  timers.add(reclaimTimer);

  const depthTimer = setInterval(() => void publishDepth(), 10_000);
  depthTimer.unref();
  timers.add(depthTimer);
}

export async function stopWorker(timeoutMs = 30_000): Promise<void> {
  if (!running) return;
  stopping = true;
  for (const timer of timers) clearInterval(timer);
  timers.clear();

  // Let in-flight jobs finish rather than orphaning them in `processing`.
  const deadline = Date.now() + timeoutMs;
  while (activeCount > 0 && Date.now() < deadline) {
    await sleep(200);
  }

  running = false;
  log.info({ abandoned: activeCount }, 'queue worker stopped');
}

async function loop(slot: number): Promise<void> {
  while (!stopping) {
    let job: DequeuedJob | null = null;
    try {
      const settings = await getSettings();
      job = await jobsModel.dequeue(
        pool,
        `${config.queue.workerId}#${slot}`,
        settings.maxConcurrentJobsPerPrinter,
        settings.printerCooldownSeconds,
      );
    } catch (error) {
      log.error({ ...serialiseError(error) }, 'dequeue failed');
    }

    if (!job) {
      await sleep(config.queue.pollIntervalMs);
      continue;
    }

    activeCount += 1;
    try {
      await processJob(job);
    } catch (error) {
      log.error({ jobId: job.id, ...serialiseError(error) }, 'unhandled error processing job');
    } finally {
      activeCount -= 1;
    }
  }
}

/* ------------------------------------------------------------ the pipeline */

async function processJob(job: DequeuedJob): Promise<void> {
  const startedAt = Date.now();
  const degradations: string[] = [];

  const printer =
    job.printerId === null ? null : await printersModel.findWithSecrets(pool, job.printerId);
  if (!printer) {
    await fail(job, 'NOT_FOUND', 'The printer for this job no longer exists.');
    return;
  }

  // State at submission time is stale by the time a job dequeues. Re-checking
  // here is what stops a job being fired at a device that jammed in between.
  const dispatchCheck = checkDispatch(printer);
  if (!dispatchCheck.allowed) {
    await handleFailure(job, dispatchCheck.error, printer.name);
    return;
  }

  if (!job.filePath) {
    await fail(job, 'NOT_FOUND', 'The uploaded file is no longer available.');
    return;
  }

  let content: Buffer;
  try {
    content = await readFile(job.filePath);
  } catch (error) {
    log.warn({ jobId: job.id, ...serialiseError(error) }, 'upload missing from disk');
    await fail(job, 'NOT_FOUND', 'The uploaded file could not be read. It may have been purged.');
    return;
  }

  const options: PrintOptions = { ...DEFAULT_PRINT_OPTIONS, ...job.printOptions };
  const filename = job.documentName ?? 'document';
  let contentType = 'application/pdf';

  try {
    /* [5] Office / image / text → PDF ------------------------------------
     *
     * These three are `requiredStage`, not `stage`: a device cannot render
     * OOXML or a JPEG, and text it *can* read is text it can be instructed by.
     * Falling back to the input here would report success while sending the
     * printer something unprintable, or in the text case something dangerous. */
    if (fileExtension(filename) === 'txt') {
      content = await textToPdfStrict(content, filename, job.id, degradations);
    } else if (needsOfficeConversion(filename)) {
      content = await requiredStage('office-to-pdf', filename, () =>
        officeToPdf(content, filename, job.id),
      );
    } else if (isImage(filename)) {
      content = await requiredStage('image-to-pdf', filename, () => imageToPdf(content, filename));
    }

    /* [6] page selection -------------------------------------------------- */
    let pages = job.pages;
    let pageCountEstimated = job.pageCountEstimated;

    try {
      const selection = await selectPages(content, options.pageRanges);
      content = selection.content;
      pages = selection.pages;
      pageCountEstimated = false;
    } catch (error) {
      if (isAppError(error) && error.code === 'VALIDATION_FAILED') throw error;
      degradations.push('page-selection');
      const counted = await countPdfPages(content);
      pages = counted.pages;
      pageCountEstimated = counted.estimated;
    }

    /* Re-check the impression ceiling against the *real* page count --------
     * The submission-time figure was an estimate for Office documents. A
     * 40 KB .docx that expands to 900 pages must be caught here, before any
     * byte reaches the device, rather than discovered from a paper tray. */
    const impressions = computeImpressions({ pages, copies: options.copies, sides: options.sides });
    const settings = await getSettings();
    const ceiling = printer.maxJobImpressions ?? settings.maxJobImpressions;
    if (impressions > ceiling) {
      await fail(
        job,
        'JOB_TOO_LARGE',
        `After conversion this job is ${impressions} pages, above the ${ceiling}-page limit.`,
      );
      return;
    }

       /* [8] PDF → PostScript, only where the device cannot take PDF ---------- */
    const acceptsPdf = printerAcceptsPdf(printer);

    const wantsGrayscale = options.colorMode === 'grayscale';

    /* [7] greyscale -----------------------------------------------------
     * Only run as its own pdfwrite pass when the device takes PDF directly.
     * When the device needs PostScript, the Gray conversion is folded into
     * that single ps2write pass below instead of stacking two Ghostscript
     * invocations — see the comment on pdfToPostScript for why. */
    if (wantsGrayscale && acceptsPdf) {
      content = await stage('grayscale', content, () => toGrayscale(content, job.id), degradations);
    }

    /* watermark ------------------------------------------------------------ */
    if (options.watermark) {
      const stamp = `${job.usernameSnapshot} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · KODE Printer job ${job.id}`;
      content = await applyWatermark(content, stamp);
    }

    if (!acceptsPdf) {
      const converted = await stage(
        'pdf-to-postscript',
        content,
        async () => {
          const ps = await pdfToPostScript(content, job.id, { grayscale: wantsGrayscale });
          // تحقق إن الناتج PostScript حقيقي قبل ما نبعته
          if (!ps.subarray(0, 2).toString('latin1').startsWith('%!')) {
            throw new Error('Ghostscript produced invalid PostScript output');
          }
          return ps;
        },
        degradations,
      );
      if (converted !== content) {
        content = converted;
        contentType = 'application/postscript';
      }
    }

    /* Ledger before send ---------------------------------------------------
     * ADR-008: the entry must exist before the impressions can appear on the
     * counter. Adding it after a successful send leaves a window in which the
     * poller sees the delta with nothing outstanding and logs a walk-up job
     * that never happened. */
    await withTransaction(async (tx) => {
      await ledgerModel.add(tx, printer.id, job.id, impressions);
    });

    /* [9] send ------------------------------------------------------------- */
    const outcome = await send(pool, {
      printer,
      document: content,
      contentType,
      options,
      jobName: filename,
      username: job.usernameSnapshot,
    });

    /* [10] finalise -------------------------------------------------------- */
    const updated = await jobsModel.markSent(pool, job.id, {
      transportUsed: outcome.transport,
      pages,
      impressions,
      ippJobUri: outcome.jobUri,
      pageCountEstimated,
      notes: degradations.length > 0 ? `Fell back at: ${degradations.join(', ')}` : null,
    });

    /* `sent` becomes `completed` when the counter confirms the impressions —
     * which never happens on a device nobody polls. Those jobs sat in `sent`
     * forever: the queue was fine, but the history showed every job on an
     * SNMP-less printer as permanently in flight, and its ledger entry hung
     * around until it expired. Where there is no counter to reconcile against,
     * the bytes leaving the machine is the most this system can ever know, so
     * that is what the job is closed on. */
    let finalJob = updated;
    if (!countersWillReport(printer)) {
      await ledgerModel.dropForJob(pool, job.id);
      await jobsModel.markCompleted(pool, job.id, impressions);
      finalJob = (await jobsModel.find(pool, job.id)) ?? updated;
    }

    await printersModel.setStatus(
      pool,
      printer.id,
      printer.status === 'unknown' ? 'online' : printer.status,
      printer.stateReasons,
      {
        resetFailures: true,
      },
    );

    if (finalJob) events.jobUpdated(finalJob);

    log.info(
      {
        jobId: job.id,
        printerId: printer.id,
        transport: outcome.transport,
        pages,
        impressions,
        totalMs: Date.now() - startedAt,
        degradations,
      },
      'job sent',
    );

    await notify(
      {
        type: 'job.sent',
        severity: 'info',
        printerId: printer.id,
        jobId: job.id,
        userId: job.userId,
        message: `"${filename}" was sent to ${printer.name} — ${pages} page${pages === 1 ? '' : 's'}.`,
        push: true,
      },
      pool,
    );
  } catch (error) {
    // The send failed, so those impressions will never appear. Leaving the
    // ledger entry would make it absorb a later genuine walk-up.
    await ledgerModel.dropForJob(pool, job.id).catch(() => undefined);
    await handleFailure(job, error, printer.name);
  }
}

/**
 * Whether this printer's page counter will ever confirm what it printed.
 *
 * The same test the fleet board shows as `walkupTrackingUnavailable`: SNMP
 * switched off, or no credential configured to poll with. Kept beside its one
 * caller because it decides a job's terminal state, not a display label.
 */
function countersWillReport(printer: {
  snmpVersion: string;
  snmpCommunity: string | null;
  snmpUsername: string | null;
}): boolean {
  if (printer.snmpVersion === 'disabled') return false;
  return printer.snmpCommunity !== null || printer.snmpUsername !== null;
}

/* ---------------------------------------------------------------- failure  */

/**
 * Retry only on transient failures (§B10.4).
 *
 * Permanent failures — a rejected file type, a disabled printer, a job that is
 * too large — MUST NOT retry. Retrying them burns three attempts, delays the
 * user's error message by twelve minutes, and changes nothing.
 */
async function handleFailure(job: DequeuedJob, error: unknown, printerName: string): Promise<void> {
  const appError = isAppError(error)
    ? error
    : new AppError('INTERNAL_ERROR', 'The job could not be sent.', { cause: error });

  const attemptsUsed = job.attempts;
  const canRetry = appError.retryable && attemptsUsed < job.maxAttempts;

  if (canRetry) {
    const delay = retryDelayMs(attemptsUsed);
    await jobsModel.scheduleRetry(
      pool,
      job.id,
      delay,
      appError.code,
      `Attempt ${attemptsUsed} failed: ${appError.message}`,
    );
    log.warn(
      { jobId: job.id, attempt: attemptsUsed, retryInMs: delay, code: appError.code },
      'job failed; retrying',
    );

    if (job.printerId !== null) await openCircuitIfFlapping(job.printerId);
    return;
  }

  await fail(job, appError.code, appError.message, printerName);
}

async function fail(
  job: DequeuedJob,
  code: string,
  message: string,
  printerName = job.printerNameSnapshot,
): Promise<void> {
  const updated = await jobsModel.markFailed(pool, job.id, code, message);
  if (updated) events.jobUpdated(updated);

  log.warn({ jobId: job.id, code }, 'job failed permanently');

  await notify(
    {
      type: 'job.failed',
      severity: 'warning',
      printerId: job.printerId,
      jobId: job.id,
      userId: job.userId,
      message: `"${job.documentName ?? 'Your document'}" could not be printed on ${printerName}. ${message}`,
      push: true,
    },
    pool,
  );
}

/**
 * Opens the circuit after repeated failures.
 *
 * Two purposes: it stops the retry loop hammering a device that is mid-firmware
 * update, and it lets `dequeueJob` skip that printer's jobs entirely so one bad
 * device does not consume both worker slots.
 */
async function openCircuitIfFlapping(printerId: number): Promise<void> {
  const printer = await printersModel.findWithSecrets(pool, printerId);
  if (!printer) return;

  const failures = printer.consecutiveFailures + 1;
  await printersModel.setStatus(pool, printerId, 'degraded', printer.stateReasons, {
    incrementFailures: true,
  });

  if (failures >= 3) {
    const delay = Math.min(300_000, 4000 * 2 ** (failures - 3));
    await printersModel.openCircuit(pool, printerId, delay);
    log.warn({ printerId, failures, delayMs: delay }, 'printer circuit opened');
  }
}

/* -------------------------------------------------------------- reclaim    */

async function reclaim(): Promise<void> {
  await withAdvisoryLock(ADVISORY_LOCKS.queueReclaim, async () => {
    const count = await jobsModel.reclaimStuck(pool, config.queue.lockTimeoutMs);
    if (count > 0) log.warn({ count }, 'requeued jobs abandoned by a previous worker');
  });
}

async function publishDepth(): Promise<void> {
  try {
    const { depth, oldestSeconds } = await jobsModel.queueStats(pool);
    events.queueDepth(depth, oldestSeconds);
  } catch {
    // Diagnostic only; never worth logging an error for.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export const workerStatus = (): { running: boolean; active: number } => ({
  running,
  active: activeCount,
});
