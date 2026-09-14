import {
  computeCo2Grams,
  computeCost,
  type AppSettings,
  type JobSource,
  type LeaderboardRow,
  type TimeSeriesPoint,
  type UsageSummary,
} from '@kode/shared';
import type { Db } from '../db/pool.js';
import { WhereBuilder } from '../db/sql.js';

/**
 * Reporting queries.
 *
 * Every figure produced here carries its own honesty markers, because §A7.1 and
 * §B8.5 both describe ways this system can produce a confident wrong number:
 *
 *   · `hasCoverageGap` — printers with SNMP disabled report no walk-up activity
 *     at all, which looks identical to a printer nobody uses.
 *   · `includesUntypedDeviceActivity` — without vendor print/copy counters, a
 *     photocopy is indistinguishable from a print, so the total MUST NOT be
 *     labelled "prints" (DEC-06).
 *
 * Returning these alongside the numbers rather than documenting them elsewhere
 * is the difference between a limitation and a false report.
 */

export interface StatsScope {
  from: string;
  to: string;
  zoneId?: number | undefined;
  printerId?: number | undefined;
  userId?: number | undefined;
  /** Narrows to one source, so app jobs and walk-ups can be plotted apart. */
  source?: JobSource | undefined;
  /** INV-01 — non-admin callers are scoped to their permitted printers. */
  permittedPrinterIds?: readonly number[] | undefined;
}

function scopeWhere(scope: StatsScope, alias = 'j'): WhereBuilder {
  const where = new WhereBuilder();
  where.add(`${alias}.created_at >= ?::timestamptz`, scope.from);
  where.add(`${alias}.created_at < (?::timestamptz + interval '1 day')`, scope.to);
  where.add(`${alias}.status IN ('sent','completed')`);
  where.addIf(scope.zoneId, `${alias}.zone_id = ?`, scope.zoneId);
  where.addIf(scope.printerId, `${alias}.printer_id = ?`, scope.printerId);
  where.addIf(scope.userId, `${alias}.user_id = ?`, scope.userId);
  where.addIf(scope.source, `${alias}.source = ?`, scope.source);
  if (scope.permittedPrinterIds) {
    where.add(`${alias}.printer_id = ANY(?::int[])`, [...scope.permittedPrinterIds]);
  }
  return where;
}

export async function usageSummary(
  db: Db,
  scope: StatsScope,
  settings: AppSettings,
): Promise<UsageSummary> {
  const where = scopeWhere(scope);

  const { rows } = await db.query<{
    total_jobs: number;
    total_impressions: number;
    color_impressions: number;
    mono_impressions: number;
    duplex_jobs: number;
    duplex_pages: number;
    untyped: number;
  }>(
    `SELECT count(*) FILTER (WHERE j.job_type <> 'scan')::int          AS total_jobs,
            COALESCE(sum(COALESCE(j.impressions, j.pages * j.copies))
                     FILTER (WHERE j.job_type <> 'scan'), 0)::int      AS total_impressions,
            COALESCE(sum(COALESCE(j.impressions, j.pages * j.copies))
                     FILTER (WHERE j.color_mode = 'color'), 0)::int    AS color_impressions,
            COALESCE(sum(COALESCE(j.impressions, j.pages * j.copies))
                     FILTER (WHERE j.color_mode IS DISTINCT FROM 'color'
                               AND j.job_type <> 'scan'), 0)::int      AS mono_impressions,
            count(*) FILTER (WHERE j.duplex)::int                      AS duplex_jobs,
            COALESCE(sum(COALESCE(j.impressions, j.pages * j.copies))
                     FILTER (WHERE j.duplex), 0)::int                  AS duplex_pages,
            count(*) FILTER (WHERE j.job_type = 'unknown')::int        AS untyped
       FROM jobs j ${where.sql}`,
    where.params,
  );

  const row = rows[0] ?? {
    total_jobs: 0,
    total_impressions: 0,
    color_impressions: 0,
    mono_impressions: 0,
    duplex_jobs: 0,
    duplex_pages: 0,
    untyped: 0,
  };

  /* Scans live in their own table, so counting `jobs WHERE job_type = 'scan'`
   * counted nothing: the scan watcher writes a `scans` row and no job row, and
   * only an admin's manual entry can carry that type. Every report showed zero
   * scans however busy the inbox was. */
  const scanWhere = new WhereBuilder();
  scanWhere.add('sc.created_at >= ?::timestamptz', scope.from);
  scanWhere.add("sc.created_at < (?::timestamptz + interval '1 day')", scope.to);
  scanWhere.addIf(scope.zoneId, 'sc.zone_id = ?', scope.zoneId);
  scanWhere.addIf(scope.printerId, 'sc.printer_id = ?', scope.printerId);
  scanWhere.addIf(scope.userId, 'sc.user_id = ?', scope.userId);
  if (scope.permittedPrinterIds) {
    scanWhere.add('sc.printer_id = ANY(?::int[])', [...scope.permittedPrinterIds]);
  }
  const { rows: scanRows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM scans sc ${scanWhere.sql}`,
    scanWhere.params,
  );

  const gapWhere = new WhereBuilder();
  gapWhere.add('p.is_active');
  /* The same test the printer read path uses for `walkupTrackingUnavailable`.
   * Keying on the community string alone reported every SNMPv3 printer as an
   * untracked gap: v3 authenticates with a username and keys and leaves that
   * column null, so the two halves of the system disagreed about which devices
   * were covered. */
  gapWhere.add(
    "(p.snmp_version = 'disabled' OR (p.snmp_community IS NULL AND p.snmp_username IS NULL))",
  );
  gapWhere.addIf(scope.zoneId, 'p.zone_id = ?', scope.zoneId);
  gapWhere.addIf(scope.printerId, 'p.id = ?', scope.printerId);
  if (scope.permittedPrinterIds) {
    gapWhere.add('p.id = ANY(?::int[])', [...scope.permittedPrinterIds]);
  }
  const { rows: gapRows } = await db.query<{ name: string }>(
    `SELECT p.name FROM printers p ${gapWhere.sql} ORDER BY p.name`,
    gapWhere.params,
  );

  return {
    totalJobs: row.total_jobs,
    totalImpressions: row.total_impressions,
    colorImpressions: row.color_impressions,
    monoImpressions: row.mono_impressions,
    duplexJobs: row.duplex_jobs,
    scanCount: scanRows[0]?.count ?? 0,
    estimatedCost: computeCost({
      monoImpressions: row.mono_impressions,
      colorImpressions: row.color_impressions,
      costPerPageMono: settings.costPerPageMono,
      costPerPageColor: settings.costPerPageColor,
    }),
    currency: settings.currency,
    co2Grams: computeCo2Grams(row.total_impressions, settings.co2GramsPerImpression),
    // Duplex halves sheets, not impressions; the saving is the rounded half.
    sheetsSavedByDuplex: Math.floor(row.duplex_pages / 2),
    hasCoverageGap: gapRows.length > 0,
    coverageGapPrinters: gapRows.map((r) => r.name),
    includesUntypedDeviceActivity: row.untyped > 0,
  };
}

export async function timeSeries(
  db: Db,
  scope: StatsScope,
  bucket: string,
): Promise<TimeSeriesPoint[]> {
  // `bucket` is validated by the route's zod enum, so only these four literals
  // can reach here. Mapping through a closed record makes that structural
  // rather than a matter of trusting the caller. INV-04.
  const TRUNC: Readonly<Record<string, string>> = {
    hour: 'hour',
    day: 'day',
    week: 'week',
    month: 'month',
  };
  const unit = TRUNC[bucket] ?? 'day';

  const where = scopeWhere(scope);
  const { rows } = await db.query<{
    bucket: string;
    impressions: number;
    jobs: number;
    color_impressions: number;
  }>(
    `SELECT date_trunc('${unit}', j.created_at) AS bucket,
            COALESCE(sum(COALESCE(j.impressions, j.pages * j.copies)), 0)::int AS impressions,
            count(*)::int AS jobs,
            COALESCE(sum(COALESCE(j.impressions, j.pages * j.copies))
                     FILTER (WHERE j.color_mode = 'color'), 0)::int AS color_impressions
       FROM jobs j ${where.sql}
      GROUP BY 1 ORDER BY 1`,
    where.params,
  );

  return rows.map((row) => ({
    bucket: row.bucket,
    impressions: row.impressions,
    jobs: row.jobs,
    colorImpressions: row.color_impressions,
  }));
}

export type LeaderboardDimension = 'user' | 'printer' | 'zone' | 'department';

export async function leaderboard(
  db: Db,
  scope: StatsScope,
  dimension: LeaderboardDimension,
  settings: AppSettings,
  limit = 10,
): Promise<LeaderboardRow[]> {
  const DIMENSIONS: Readonly<
    Record<LeaderboardDimension, { key: string; label: string; join: string }>
  > = {
    user: {
      key: "COALESCE(j.user_id::text, 'system')",
      label: 'j.username_snapshot',
      join: '',
    },
    printer: {
      key: "COALESCE(j.printer_id::text, 'unknown')",
      label: 'j.printer_name_snapshot',
      join: '',
    },
    zone: {
      key: "COALESCE(j.zone_id::text, 'none')",
      label: "COALESCE(z.label, 'Unassigned')",
      join: 'LEFT JOIN zones z ON z.id = j.zone_id',
    },
    department: {
      key: "COALESCE(u.department, 'Unassigned')",
      label: "COALESCE(u.department, 'Unassigned')",
      join: 'LEFT JOIN users u ON u.id = j.user_id',
    },
  };

  const spec = DIMENSIONS[dimension];
  const where = scopeWhere(scope);
  const limitParam = where.push(limit);

  const { rows } = await db.query<{
    key: string;
    label: string;
    impressions: number;
    jobs: number;
    color_impressions: number;
    mono_impressions: number;
  }>(
    `SELECT ${spec.key} AS key, ${spec.label} AS label,
            COALESCE(sum(COALESCE(j.impressions, j.pages * j.copies)), 0)::int AS impressions,
            count(*)::int AS jobs,
            COALESCE(sum(COALESCE(j.impressions, j.pages * j.copies))
                     FILTER (WHERE j.color_mode = 'color'), 0)::int AS color_impressions,
            COALESCE(sum(COALESCE(j.impressions, j.pages * j.copies))
                     FILTER (WHERE j.color_mode IS DISTINCT FROM 'color'), 0)::int AS mono_impressions
       FROM jobs j ${spec.join} ${where.sql}
      GROUP BY 1, 2 ORDER BY impressions DESC LIMIT ${limitParam}`,
    where.params,
  );

  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    impressions: row.impressions,
    jobs: row.jobs,
    cost: computeCost({
      monoImpressions: row.mono_impressions,
      colorImpressions: row.color_impressions,
      costPerPageMono: settings.costPerPageMono,
      costPerPageColor: settings.costPerPageColor,
    }),
  }));
}

/** Feeds the "days until empty" forecast on the fleet board. */
export async function supplyBurnRate(
  db: Db,
  printerId: number,
  supplyIndex: number,
): Promise<{ percentPerDay: number; samples: number } | null> {
  // Least squares over the retained window, computed in SQL so this and the
  // figure the fleet board shows come from one definition. They used to be two:
  // this function took the difference between the first and last readings while
  // the read path returned nothing at all, so a notification could say "about
  // four days" beside a panel showing no forecast.
  const { rows } = await db.query<{
    percent_per_day: number | null;
    samples: number;
    span_days: number | null;
  }>(
    `SELECT -regr_slope(percent, EXTRACT(EPOCH FROM observed_at) / 86400) AS percent_per_day,
            count(*)::int AS samples,
            EXTRACT(EPOCH FROM (max(observed_at) - min(observed_at))) / 86400 AS span_days
       FROM printer_supply_history
      WHERE printer_id = $1 AND supply_index = $2
        AND observed_at > now() - interval '21 days'`,
    [printerId, supplyIndex],
  );

  const row = rows[0];
  if (!row) return null;
  // A line through fewer than four points, or across less than a day, is noise.
  if (row.samples < 4 || row.span_days === null || row.span_days < 1) return null;
  // Not falling means the cartridge was replaced. No forecast until fresh
  // history accumulates on the new one.
  if (row.percent_per_day === null || row.percent_per_day <= 0) return null;

  return { percentPerDay: row.percent_per_day, samples: row.samples };
}

export const statsModel = {
  usageSummary,
  timeSeries,
  leaderboard,
  supplyBurnRate,
} as const;
