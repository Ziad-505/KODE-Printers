import type { ReactElement } from 'react';
import '../styles/next.css';
/**
 * The fleet board, rebuilt — a proposal, not a replacement.
 *
 * Lives at `/fleet/next` beside the current screen at `/fleet` so the two can
 * be opened one after the other on the same phone. Nothing here is imported by
 * anything else, and every style is scoped under `.nx`, so the eleven screens
 * we have not looked at yet are untouched either way.
 *
 * The data, the queries and the vocabulary are identical to `Fleet.tsx` on
 * purpose. If the two screens read differently it is the design that changed,
 * not the information — which is the only way the comparison answers anything.
 *
 * What is actually different:
 *
 *   · **17px body type**, not 14.5px, and nothing under 13px anywhere. The
 *     search field is 16px because mobile Safari force-zooms the page when you
 *     focus anything smaller, and never zooms back.
 *   · **One container per card.** Hairlines between rows, inset to the text
 *     column; no box around the card, the rows or the gauges.
 *   · **Four cartridges, not five arbitrary supplies.** The old card sliced the
 *     first five of twelve, which on a WorkCentre meant four toners and one
 *     drum — a cut with no meaning. Toners are what run out; the eight service
 *     parts sit behind a disclosure.
 *   · **44px targets.** The old QR and scan buttons were 36px.
 *   · **A dot and a sentence** instead of a coloured pill.
 */
export declare function FleetNext(): ReactElement;
//# sourceMappingURL=FleetNext.d.ts.map