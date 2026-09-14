import { Router } from 'express';
import { z } from 'zod';
import { statsQuerySchema } from '@kode/shared';
import { pool } from '../db/pool.js';
import { getSettings } from '../models/settings.js';
import { statsModel } from '../models/stats.js';
import { actorOf, authenticate, requirePasswordChanged } from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/context.js';
import { query, validateQuery } from '../middlewares/validate.js';
import { permittedPrinterIds } from '../services/printerAccess.js';

/**
 * Reporting.
 *
 * Every response here carries its own caveats alongside the numbers. §A7.1 and
 * §B8.5 each describe a way this system can produce a confident wrong figure,
 * and DEC-06 settles what to do about it: label walk-up totals "device
 * activity", not "prints", until vendor counters can tell a photocopy from a
 * print.
 *
 * Shipping the caveat *in the payload* rather than documenting it elsewhere is
 * the difference between a stated limitation and a false report — a number
 * exported without its footnote is a number that gets quoted without it.
 */
export const statsRouter = Router();

statsRouter.use(authenticate, requirePasswordChanged);

const leaderboardQuery = statsQuerySchema.and(
  z.object({
    dimension: z.enum(['user', 'printer', 'zone', 'department']).default('user'),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  }),
);

async function scopeFor(req: Express.Request): Promise<{ permittedPrinterIds?: number[] }> {
  const actor = actorOf(req);
  if (actor.role === 'admin') return {};
  const permitted = await permittedPrinterIds(actor);
  return { permittedPrinterIds: permitted ?? [] };
}

statsRouter.get(
  '/summary',
  validateQuery(statsQuerySchema),
  asyncHandler(async (req, res) => {
    const filter = query(req, statsQuerySchema);
    const settings = await getSettings();
    const scope = { ...filter, ...(await scopeFor(req)) };

    const summary = await statsModel.usageSummary(pool, scope, settings);

    res.json({
      ...summary,
      // DEC-06 travels with the data.
      walkupLabel: settings.walkupReportLabel,
      /* The caveats §B8.5 and DEC-06 require, in words a person reads.
       *
       * These strings are rendered verbatim beside the totals, so they are
       * user-facing copy rather than diagnostics — "walk-up activity is not
       * tracked" is the server's own vocabulary and told a reader nothing
       * about what to do with the number they were looking at. */
      coverageNote: summary.hasCoverageGap
        ? `${summary.coverageGapPrinters.length === 1 ? 'One printer' : `${summary.coverageGapPrinters.length} printers`} ` +
          `(${summary.coverageGapPrinters.join(', ')}) cannot tell us when someone uses ` +
          `${summary.coverageGapPrinters.length === 1 ? 'it' : 'them'} directly, so these totals are a little low.`
        : null,
      typeNote: summary.includesUntypedDeviceActivity
        ? 'Some of this was done standing at a printer that cannot tell a print from a ' +
          `photocopy, so it is counted as ${settings.walkupReportLabel.toLowerCase()} rather than printing.`
        : null,
    });
  }),
);

statsRouter.get(
  '/series',
  validateQuery(statsQuerySchema),
  asyncHandler(async (req, res) => {
    const filter = query(req, statsQuerySchema);
    const scope = { ...filter, ...(await scopeFor(req)) };
    res.json(await statsModel.timeSeries(pool, scope, filter.bucket));
  }),
);

statsRouter.get(
  '/leaderboard',
  validateQuery(leaderboardQuery),
  asyncHandler(async (req, res) => {
    const filter = query(req, leaderboardQuery);
    const settings = await getSettings();
    const scope = { ...filter, ...(await scopeFor(req)) };
    res.json(await statsModel.leaderboard(pool, scope, filter.dimension, settings, filter.limit));
  }),
);

/**
 * The dashboard's opening view: today plus the current queue.
 *
 * A single request rather than four, because the first paint of the home screen
 * on a phone over club wifi is the one place round trips are actually felt.
 */
statsRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const scope = await scopeFor(req);
    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

    const [todaySummary, monthSummary, series, topPrinters] = await Promise.all([
      statsModel.usageSummary(pool, { from: today, to: today, ...scope }, settings),
      statsModel.usageSummary(pool, { from: thirtyDaysAgo, to: today, ...scope }, settings),
      statsModel.timeSeries(pool, { from: thirtyDaysAgo, to: today, ...scope }, 'day'),
      statsModel.leaderboard(
        pool,
        { from: thirtyDaysAgo, to: today, ...scope },
        'printer',
        settings,
        5,
      ),
    ]);

    res.json({
      today: todaySummary,
      last30Days: monthSummary,
      series,
      topPrinters,
      currency: settings.currency,
      walkupLabel: settings.walkupReportLabel,
    });
  }),
);
