import type { Job, Printer, PrinterSupply } from '@kode/shared';
export type PrinterCondition = {
    kind: 'stopped';
    text: string;
} | {
    kind: 'attention';
    text: string;
} | {
    kind: 'unknown';
    text: string;
} | {
    kind: 'ready';
    text: string;
};
/**
 * What to say about a printer, and how loudly.
 *
 * Returns a `kind` as well as the words so callers colour it consistently
 * instead of each deciding for itself what counts as bad.
 */
export declare function printerCondition(printer: Printer): PrinterCondition;
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
export declare function supplyName(description: string): string;
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
export declare function supplyLevelText(supply: PrinterSupply): string | null;
/**
 * How full the gauge should look, 0–100.
 *
 * The fraction of rated capacity, which is meaningful for every unit — it is
 * the same comparison the forecast makes. It drives the *bar* only; the number
 * beside it comes from `supplyLevelText`. A nearly-empty bar next to
 * "260 pages" is two true statements, where a bar labelled "1%" was one true
 * statement and one that argued with the printer.
 */
export declare function supplyGaugePercent(supply: PrinterSupply): number | null;
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
export declare function inkPhrase(printer: Printer): string | null;
/**
 * One line describing what happened, in the right tense.
 *
 * The tense is the whole point. "Ahmed printed Price list.xlsx" is a lie while
 * the job is still sitting in the queue, and it was being told for every job
 * regardless of status — which made the activity list read as though
 * everything had succeeded.
 */
export declare function jobHeadline(job: Job): string;
export type JobTone = 'good' | 'bad' | 'waiting' | 'neutral';
export interface JobStatusLabel {
    text: string;
    tone: JobTone;
}
/** The short status word beside a job, and how to colour it. */
export declare function jobStatus(job: Job): JobStatusLabel;
/** Maps a job tone onto the badge modifiers the stylesheet already defines. */
export declare function badgeToneFor(tone: JobTone): '' | 'online' | 'offline' | 'degraded';
/**
 * A time a person would say out loud.
 *
 * Today gets a clock time, this week gets a weekday, anything older gets a
 * date. Seconds are never shown: nobody has ever needed them in a job list,
 * and they made every row a wall of digits.
 */
export declare function friendlyTime(iso: string): string;
/** "3 pages", "1 page". The unit people actually use for impressions. */
export declare function pageCount(job: Job): string;
//# sourceMappingURL=plain.d.ts.map