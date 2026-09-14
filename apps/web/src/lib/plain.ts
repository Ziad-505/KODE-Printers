import type { Job, Printer, PrinterSupply } from '@kode/shared';

/**
 * Plain language, in one place.
 *
 * The server's vocabulary is IPP's: `media-empty`, `marker-supply-low`,
 * `walkup`, `sent`. That vocabulary is correct and it belongs in the audit
 * record, where an engineer reads it — but it had been reaching the screen
 * verbatim, so the fleet board told a receptionist her printer was
 * "MEDIA EMPTY" twice over, in capitals.
 *
 * Every translation lives here rather than in each screen. Two reasons: the
 * same condition has to read identically on the home page, the fleet board and
 * the job list, and a keyword that has no phrase yet must fail visibly in one
 * place instead of silently rendering as a hyphenated fragment somewhere.
 */

/* ══════════════════════════════════════════════════════════════════ printers */

/**
 * Conditions that mean the printer cannot print at all.
 *
 * These mirror `BLOCKING_STATE_REASONS` on the server — the same set the
 * dispatch gate refuses on — so the interface never says "Ready" about a
 * device the queue is holding jobs back from.
 */
const STOPPED: Readonly<Record<string, string>> = {
  'media-empty': 'Out of paper',
  'media-jam': 'Paper jam',
  jam: 'Paper jam',
  'toner-empty': 'Out of ink',
  'marker-supply-empty': 'Out of ink',
  'door-open': 'A door is open',
  'cover-open': 'A cover is open',
  'input-tray-missing': 'A paper tray is missing',
  'output-area-full': 'The output tray is full',
  shutdown: 'Switched off',
  offline: 'Cannot be reached',
  'service-request': 'Needs servicing',
  'device-mismatch': 'This is not the printer we have on record',
};

/**
 * Conditions worth mentioning that do not stop anything.
 *
 * Kept apart from the list above because the difference decides whether a job
 * will print. A printer that is low on toner still prints; one that is out of
 * paper does not, and a screen that renders both the same way teaches people
 * to ignore the warning that mattered.
 */
const NIGGLES: Readonly<Record<string, string>> = {
  'toner-low': 'Low on ink',
  'marker-supply-low': 'Low on ink',
  'developer-low': 'Low on developer',
  'media-low': 'Low on paper',
  'input-tray-empty': 'A tray is empty',
  'output-area-almost-full': 'Output tray nearly full',
  'opc-life-over': 'Drum due for replacement',
  'marker-supply-missing': 'A cartridge is missing',
  'output-media-low': 'Low on paper',
  'output-tray-missing': 'An output tray is missing',
  'overdue-prevent-maint': 'A service is overdue',
  'subunit-recoverable-failure': 'Reported a fault',
  'subunit-unrecoverable-failure': 'Needs attention',
  paused: 'Paused at the device',
};

/**
 * Which niggle to show when a device reports several.
 *
 * A WorkCentre reports five at once — a subunit fault, an empty tray, low
 * toner, a recoverable fault and power saver. Taking the first the device
 * happened to list put "Part of the device needs attention" on the card of a
 * printer whose four cartridges were at 1%: the vaguest of the five, and the
 * only one nobody can act on.
 *
 * So they are ranked by what the person reading the card can *do*. Order a
 * cartridge, refill a tray, empty the output — then, only if none of those
 * apply, the subunit faults that mean "call the engineer eventually".
 */
const NIGGLE_ORDER: readonly string[] = [
  'marker-supply-missing',
  'toner-low',
  'marker-supply-low',
  'developer-low',
  'opc-life-over',
  'media-low',
  'input-tray-empty',
  'output-area-almost-full',
  'output-media-low',
  'output-tray-missing',
  'paused',
  'overdue-prevent-maint',
  'subunit-unrecoverable-failure',
  'subunit-recoverable-failure',
];

/**
 * The device's own verdict, which the keyword alone does not carry.
 *
 * `media-empty-warning` and `media-empty-error` are the same words and opposite
 * situations: one tray of five is empty, versus the machine cannot feed paper
 * at all. Reading the suffix here is what stops the fleet board announcing
 * "Out of paper" over a printer that is quietly working — which is precisely
 * what it did before, on every Xerox in the building.
 */
const SUFFIX = /-(?:report|warning|error)$/;
const bare = (reason: string): string => reason.replace(SUFFIX, '');
const isWarning = (reason: string): boolean => /-(?:warning|report)$/.test(reason);

export type PrinterCondition =
  | { kind: 'stopped'; text: string }
  | { kind: 'attention'; text: string }
  | { kind: 'unknown'; text: string }
  | { kind: 'ready'; text: string };

/**
 * What to say about a printer, and how loudly.
 *
 * Returns a `kind` as well as the words so callers colour it consistently
 * instead of each deciding for itself what counts as bad.
 */
export function printerCondition(printer: Printer): PrinterCondition {
  for (const reason of printer.stateReasons) {
    if (isWarning(reason)) continue;
    const stopped = STOPPED[bare(reason)];
    if (stopped) return { kind: 'stopped', text: stopped };
  }

  /* Ranked, not first-come. See `NIGGLE_ORDER`. */
  const present = new Set(printer.stateReasons.map(bare));
  for (const keyword of NIGGLE_ORDER) {
    const phrase = NIGGLES[keyword];
    if (phrase !== undefined && present.has(keyword)) {
      return { kind: 'attention', text: phrase };
    }
  }

  /* A blocking keyword the device downgraded to a warning still deserves a
   * mention — "a tray is empty" on a machine that is printing from another
   * tray — but only after every ranked niggle, and never as `stopped`. */
  for (const reason of printer.stateReasons) {
    if (!isWarning(reason)) continue;
    const stopped = STOPPED[bare(reason)];
    if (stopped) return { kind: 'attention', text: stopped };
  }

  /* `offline` and `unknown` without a reason attached.
   *
   * A printer nobody can reach is not "ready", and saying so is the difference
   * between someone walking to a machine and someone picking another one. */
  if (printer.status === 'offline') return { kind: 'stopped', text: 'Cannot be reached' };
  if (printer.status === 'unknown') {
    return { kind: 'unknown', text: 'Not checked yet' };
  }
  if (printer.status === 'degraded') {
    return { kind: 'attention', text: 'Needs attention' };
  }

  if (printer.isDraining) return { kind: 'attention', text: 'Finishing up before maintenance' };
  if (!printer.isActive) return { kind: 'unknown', text: 'Turned off' };

  return { kind: 'ready', text: 'Ready' };
}

/**
 * A cartridge name a person would recognise.
 *
 * `prtMarkerSuppliesDescription` is an inventory field, not a label. A Xerox
 * WorkCentre answers:
 *
 *   Black Toner, PN 006R01509;SN56195b80e00004d6
 *
 * and the fleet board was rendering all forty-three characters of it, so five
 * cartridge rows read as five part numbers and the one thing that mattered —
 * the word "Black" — was the part that fitted. The part and serial numbers
 * belong in the printer's detail view for whoever is ordering a replacement;
 * they are noise on a status card.
 *
 * The convention is `<name>, PN <part>;SN <serial>`, but it is a convention
 * rather than a standard, so this trims only what it recognises and leaves
 * anything unfamiliar intact — a name we do not understand is better shown
 * whole than truncated by a guess.
 */
export function supplyName(description: string): string {
  const trimmed = description.replace(/,?\s*(?:PN|P\/N)\s+[^;]*(?:;\s*SN\s*\S*)?\s*$/i, '').trim();
  return trimmed === '' ? description : trimmed;
}

/**
 * How much of a supply is left, in whatever the device actually measured.
 *
 * A percentage where the device reports one, a count where it reports a count,
 * and nothing at all where it reports neither. The one thing this never does is
 * turn a count into a percentage: a Xerox toner with 260 pages left of a
 * 26,000-page cartridge is 1% by that arithmetic and 10% on the machine's own
 * screen, and the person standing at the printer believes the machine.
 *
 * "260 pages" is also the more useful sentence. It is what the device's own
 * supplies page prints, and it answers the question someone actually has.
 */
export function supplyLevelText(supply: PrinterSupply): string | null {
  if (supply.percent !== null) return `${supply.percent}%`;
  if (supply.level === null) return null;

  const NOUNS: Readonly<Record<string, string>> = {
    impressions: 'pages',
    sheets: 'sheets',
    items: 'items',
    hours: 'hours',
  };
  const noun = supply.unit === null ? null : NOUNS[supply.unit];
  return noun ? `${supply.level.toLocaleString()} ${noun}` : null;
}

/**
 * How full the gauge should look, 0–100.
 *
 * The fraction of rated capacity, which is meaningful for every unit — it is
 * the same comparison the forecast makes. It drives the *bar* only; the number
 * beside it comes from `supplyLevelText`. A nearly-empty bar next to
 * "260 pages" is two true statements, where a bar labelled "1%" was one true
 * statement and one that argued with the printer.
 */
export function supplyGaugePercent(supply: PrinterSupply): number | null {
  if (supply.percent !== null) return supply.percent;
  if (supply.level === null || supply.maxLevel === null || supply.maxLevel <= 0) return null;
  return Math.min(100, Math.max(0, (supply.level / supply.maxLevel) * 100));
}

/**
 * Ink level and how long it is expected to last, when the device reports it.
 *
 * The supply has to be an *ink* one, which used to be assumed rather than
 * checked: this took the first entry with a percentage, and once toners
 * measured in pages stopped publishing one, the first match on a WorkCentre
 * became a drum cartridge — so the home page would have announced "35% ink
 * left" about a photoreceptor. A colorant is what distinguishes a cartridge
 * that holds ink from a consumable that does not.
 */
export function inkPhrase(printer: Printer): string | null {
  const supply = printer.supplies.find(
    (entry) => entry.colorant !== null && supplyLevelText(entry) !== null,
  );
  if (!supply) return null;

  const level = `${supplyLevelText(supply) ?? ''} of ink left`;
  return supply.estimatedDaysRemaining === null
    ? level
    : `${level} · about ${supply.estimatedDaysRemaining} day${supply.estimatedDaysRemaining === 1 ? '' : 's'}`;
}

/* ══════════════════════════════════════════════════════════════════════ jobs */

/**
 * One line describing what happened, in the right tense.
 *
 * The tense is the whole point. "Ahmed printed Price list.xlsx" is a lie while
 * the job is still sitting in the queue, and it was being told for every job
 * regardless of status — which made the activity list read as though
 * everything had succeeded.
 */
export function jobHeadline(job: Job): string {
  const document = job.documentName ?? 'a document';

  if (job.source === 'walkup') {
    if (job.jobType === 'copy') return 'Someone made a photocopy at the printer';
    if (job.jobType === 'print') return 'Someone printed something at the printer';
    // DEC-06: with no vendor counter a print and a photocopy are the same
    // event to us, and calling it either would be inventing a fact.
    return 'Someone used the printer directly';
  }

  if (job.source === 'manual') {
    return `${job.usernameSnapshot} recorded ${document} by hand`;
  }

  switch (job.status) {
    case 'completed':
    case 'sent':
      return `${job.usernameSnapshot} printed ${document}`;
    case 'failed':
      return `${document} did not print`;
    case 'cancelled':
      return `${job.usernameSnapshot} cancelled ${document}`;
    case 'held':
      return `${document} is waiting to be released`;
    case 'processing':
      return `${document} is printing now`;
    default:
      return `${document} is waiting to print`;
  }
}

export type JobTone = 'good' | 'bad' | 'waiting' | 'neutral';

export interface JobStatusLabel {
  text: string;
  tone: JobTone;
}

/** The short status word beside a job, and how to colour it. */
export function jobStatus(job: Job): JobStatusLabel {
  if (job.source === 'walkup') return { text: 'At the printer', tone: 'neutral' };

  switch (job.status) {
    case 'completed':
    case 'sent':
      return { text: 'Printed', tone: 'good' };
    case 'failed':
      return { text: 'Did not print', tone: 'bad' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'neutral' };
    case 'held':
      return { text: 'Held', tone: 'waiting' };
    case 'processing':
      return { text: 'Printing', tone: 'waiting' };
    default:
      return { text: 'Waiting', tone: 'waiting' };
  }
}

/** Maps a job tone onto the badge modifiers the stylesheet already defines. */
export function badgeToneFor(tone: JobTone): '' | 'online' | 'offline' | 'degraded' {
  if (tone === 'good') return 'online';
  if (tone === 'bad') return 'offline';
  if (tone === 'waiting') return 'degraded';
  return '';
}

/* ═════════════════════════════════════════════════════════════════ formatting */

/**
 * A time a person would say out loud.
 *
 * Today gets a clock time, this week gets a weekday, anything older gets a
 * date. Seconds are never shown: nobody has ever needed them in a job list,
 * and they made every row a wall of digits.
 */
export function friendlyTime(iso: string): string {
  const then = new Date(iso);
  const elapsed = Date.now() - then.getTime();

  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) {
    const minutes = Math.round(elapsed / 60_000);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  const isToday = then.toDateString() === new Date().toDateString();
  if (isToday) return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (elapsed < 7 * 86_400_000) {
    return then.toLocaleDateString(undefined, { weekday: 'long' });
  }

  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "3 pages", "1 page". The unit people actually use for impressions. */
export function pageCount(job: Job): string {
  const pages = job.impressions ?? job.pages;
  return `${pages} page${pages === 1 ? '' : 's'}`;
}
