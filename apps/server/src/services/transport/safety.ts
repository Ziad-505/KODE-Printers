import {
  AppError,
  blockingReasons,
  stripReasonSuffix,
  type AppSettings,
  type Severity,
} from '@kode/shared';
import type { PrinterWithSecrets } from '../../models/printers.js';

/**
 * The printer-safety gate.
 *
 * Nothing in KODE-TECH-0005 specifies this layer; it exists because "safe for
 * printers" is a requirement in its own right and the failure modes it prevents
 * are real, cheap to prevent, and expensive to clean up:
 *
 *   · A 4,000-page job submitted by accident empties a tray, a toner cartridge
 *     and an afternoon. Nothing in the delivered design stops it.
 *   · A job fired at a jammed device is not "queued at the printer" — on many
 *     MFPs it is discarded when the jam clears, so the user waits for output
 *     that will never appear.
 *   · A device that is failing every send gets hammered by the retry loop,
 *     which is how a printer mid-firmware-update ends up bricked.
 *   · Concurrent jobs to one engine interleave on some models, producing two
 *     half-documents.
 *
 * Every check returns a *reason*, not a boolean, so the interface can tell
 * someone what to do about it rather than saying "failed".
 */

export type SafetyDecision =
  { allowed: true } | { allowed: false; error: AppError; severity: Severity };

export interface SafetyContext {
  printer: PrinterWithSecrets;
  settings: AppSettings;
  impressions: number;
  /** Set once the user has acknowledged a large-job warning in the UI. */
  confirmedLargeJob: boolean;
}

/**
 * The effective per-job impression ceiling.
 *
 * A per-printer override exists because the estate is not uniform: the A3
 * device in the academy office legitimately runs 500-page tournament draws,
 * while the reception desk printer never should.
 */
export function impressionCeiling(
  printer: Pick<PrinterWithSecrets, 'maxJobImpressions'>,
  settings: AppSettings,
): number {
  return printer.maxJobImpressions ?? settings.maxJobImpressions;
}

/** Checks that do not need the device's live state. Run at submission time. */
export function checkSubmission(context: SafetyContext): SafetyDecision {
  const { printer, settings, impressions } = context;

  if (!printer.isActive) {
    return {
      allowed: false,
      severity: 'info',
      error: new AppError('PRINTER_INACTIVE', 'This printer has been disabled.', {
        details: { printerId: printer.id },
      }),
    };
  }

  /* A collector-served printer cannot be printed to from here.
   *
   * §B11 gives a collector one job: observe a segment this server cannot reach,
   * and report upward over a connection it opened itself. Nothing in that
   * design carries a document back down, so the transport has no route to the
   * device. The queue used to accept these jobs anyway and discover the problem
   * three retries later, which told the user their printer was unreachable when
   * the truth is that this feature does not cover their building yet.
   *
   * Refusing at submission is the honest version. It is also where the fix
   * lands: when the collector print relay exists, this check becomes a handoff. */
  if (printer.collectorId !== null) {
    return {
      allowed: false,
      severity: 'warning',
      error: new AppError(
        'PRINTER_NOT_READY',
        `${printer.name} is served by a site collector, and printing to collector sites is ` +
          'not available yet. Walk-up activity and scans from it are still tracked. Use a ' +
          'printer in this building, or ask IT to print it locally.',
        { details: { printerId: printer.id, collectorId: printer.collectorId }, retryable: false },
      ),
    };
  }

  if (printer.isDraining) {
    return {
      allowed: false,
      severity: 'info',
      error: new AppError(
        'PRINTER_NOT_READY',
        `${printer.name} is in maintenance mode and is not accepting new jobs.`,
        { details: { printerId: printer.id }, retryable: false },
      ),
    };
  }

  const ceiling = impressionCeiling(printer, settings);
  if (impressions > ceiling) {
    return {
      allowed: false,
      severity: 'warning',
      error: new AppError(
        'JOB_TOO_LARGE',
        `This job is ${impressions} pages, above the ${ceiling}-page limit for ${printer.name}. ` +
          'Split it, or ask an administrator to raise the limit for this printer.',
        { details: { printerId: printer.id, impressions, limit: ceiling }, retryable: false },
      ),
    };
  }

  // Not a refusal — a speed bump. The client re-submits with confirmLargeJob
  // once the user has seen the number. This is the check that catches "printed
  // the whole 300-page handbook instead of page 3".
  if (impressions > settings.largeJobWarnImpressions && !context.confirmedLargeJob) {
    return {
      allowed: false,
      severity: 'info',
      error: new AppError(
        'VALIDATION_FAILED',
        `This will print ${impressions} pages. Confirm to continue.`,
        {
          details: {
            printerId: printer.id,
            impressions,
            warnThreshold: settings.largeJobWarnImpressions,
            requiresConfirmation: true,
          },
          retryable: false,
        },
      ),
    };
  }

  return { allowed: true };
}

/**
 * Checks that need live device state. Run by the worker immediately before the
 * send, because state at submission time is stale by the time the job dequeues.
 *
 * A refusal here is retryable: the job stays queued and tries again after the
 * backoff, which is exactly right for "someone is refilling the paper".
 */
export function checkDispatch(printer: PrinterWithSecrets): SafetyDecision {
  const blocking = blockingReasons(printer.stateReasons);

  if (blocking.length > 0) {
    return {
      allowed: false,
      severity: 'warning',
      error: new AppError('PRINTER_NOT_READY', describeBlockingState(printer.name, blocking), {
        details: { printerId: printer.id, stateReasons: blocking },
        retryable: true,
      }),
    };
  }

  if (printer.circuitOpenUntil && Date.parse(printer.circuitOpenUntil) > Date.now()) {
    return {
      allowed: false,
      severity: 'warning',
      error: new AppError(
        'PRINTER_CIRCUIT_OPEN',
        `${printer.name} has failed repeatedly and is being left alone briefly. ` +
          'Your job is still queued and will be sent automatically.',
        { details: { printerId: printer.id }, retryable: true },
      ),
    };
  }

  return { allowed: true };
}

/**
 * Turns IPP state reasons into a sentence someone can act on.
 *
 * "media-empty" tells an engineer something; "Tray is empty — add paper" tells
 * the person standing next to it what to do. The audit record keeps the raw
 * keywords either way.
 */
export function describeBlockingState(printerName: string, reasons: readonly string[]): string {
  const PHRASES: Readonly<Record<string, string>> = {
    'media-jam': 'there is a paper jam',
    jam: 'there is a paper jam',
    'media-empty': 'the paper tray is empty',
    'toner-empty': 'the toner is empty',
    'marker-supply-empty': 'a toner cartridge is empty',
    'door-open': 'a door or cover is open',
    'cover-open': 'a door or cover is open',
    'input-tray-missing': 'a paper tray is missing',
    'output-area-full': 'the output tray is full',
    shutdown: 'it is powered down',
    offline: 'it is offline',
    'service-request': 'it needs servicing',
    'device-mismatch':
      'the device at that address is not the one on record, so it is not safe to send to',
  };

  // Reasons arrive with their IPP severity suffix attached; the phrase table is
  // keyed on the bare keyword, and a `media-empty-error` that fell through to
  // "it reported a problem" would be a worse message than the one it replaced.
  const described = [
    ...new Set(
      reasons
        .map((reason) => PHRASES[stripReasonSuffix(reason)])
        .filter((phrase): phrase is string => phrase !== undefined),
    ),
  ];

  const detail =
    described.length === 0
      ? 'it reported a problem'
      : described.length === 1
        ? described[0]
        : `${described.slice(0, -1).join(', ')} and ${described.at(-1)}`;

  return `${printerName} is not ready: ${detail}.`;
}

/**
 * The per-printer circuit breaker.
 *
 * Backs off on consecutive failures rather than on a fixed schedule, so a
 * device that is genuinely down stops absorbing the poll and retry budget while
 * a device that recovers is picked up on the next attempt. The ceiling is five
 * minutes: long enough to stop hammering, short enough that a printer switched
 * back on is usable again before anyone files a ticket.
 */
export const CIRCUIT = {
  /** Failures before the circuit opens at all. Two allows for one bad packet. */
  threshold: 3,
  baseMs: 4_000,
  maxMs: 300_000,
} as const;

export function circuitDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures < CIRCUIT.threshold) return 0;
  const exponent = consecutiveFailures - CIRCUIT.threshold;
  return Math.min(CIRCUIT.maxMs, CIRCUIT.baseMs * 2 ** exponent);
}

/**
 * Retry backoff for a failed send. §B10.4 specifies 30s, 2m, 10m.
 *
 * `attemptsUsed` is 1-based, because that is what `jobs.attempts` holds by the
 * time a failure is handled: the dequeue claims the row and increments the
 * count in the same statement, so the first failure is attempt 1. The function
 * owns that convention rather than leaving it to the call site, which is what
 * made every first retry wait two minutes instead of thirty seconds.
 *
 * Full jitter is applied on top so a fleet-wide outage does not produce a
 * synchronised retry storm the moment the network returns, which would look to
 * the switch exactly like the outage that just ended.
 */
export function retryDelayMs(attemptsUsed: number, random: () => number = Math.random): number {
  const schedule = [30_000, 120_000, 600_000];
  const index = Math.min(Math.max(0, attemptsUsed - 1), schedule.length - 1);
  const base = schedule[index] ?? 600_000;
  return Math.round(base / 2 + random() * (base / 2));
}
