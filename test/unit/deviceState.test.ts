import { describe, expect, it } from 'vitest';
import {
  blockingReasons,
  isBlockingReason,
  reasonSeverity,
  stripReasonSuffix,
} from '../../packages/shared/src/constants.js';
import { decodeErrorState, ERROR_STATE_BITS } from '../../apps/server/src/services/snmp/oids.js';
import { describeBlockingState } from '../../apps/server/src/services/transport/safety.js';
import {
  printerCondition,
  supplyGaugePercent,
  supplyLevelText,
  supplyName,
} from '../../apps/web/src/lib/plain.js';
import {
  supplyFraction,
  supplyPercent,
  type SupplyReading,
} from '../../apps/server/src/services/snmp/counters.js';
import type { PrinterSupply } from '../../packages/shared/src/types.js';

/**
 * Device-state decoding.
 *
 * Every case here is taken from a real Xerox WorkCentre 7835 at 10.29.14.248,
 * not invented. It is the device that exposed the defect: paper in tray 1,
 * trays 2–5 empty, four toners near end of life, an outstanding image-overwrite
 * request, and `printer-state: idle` throughout — a printer that was ready to
 * work and that this system refused to send a single page to.
 *
 * Two independent bugs produced that, and both are pinned below:
 *
 *   1. IPP's `-warning` suffix was stripped before the blocking check, so
 *      `media-empty-warning` (one tray of five) became `media-empty` (the
 *      machine cannot feed paper).
 *   2. `ERROR_STATE_BITS` assigned RFC 3805 bits 2–15 to the wrong keywords,
 *      so the same device decoded over SNMP as three output-tray faults it had
 *      never reported.
 */

/* ═══════════════════════════════════════════════ IPP severity suffixes ═══ */

describe('IPP state-reason severity', () => {
  it('reads the suffix RFC 8011 appends', () => {
    expect(reasonSeverity('media-empty-warning')).toBe('warning');
    expect(reasonSeverity('media-empty-error')).toBe('error');
    expect(reasonSeverity('subunit-power-saver-report')).toBe('report');
    // SNMP and `device-mismatch` carry no suffix; null is "the source could not
    // say", not "the source said it was fine".
    expect(reasonSeverity('device-mismatch')).toBeNull();
  });

  it('strips the suffix for display without losing the keyword', () => {
    expect(stripReasonSuffix('marker-supply-low-warning')).toBe('marker-supply-low');
    expect(stripReasonSuffix('media-jam-error')).toBe('media-jam');
    expect(stripReasonSuffix('media-jam')).toBe('media-jam');
    // Only a trailing suffix, never a keyword that merely contains one.
    expect(stripReasonSuffix('subunit-unrecoverable-failure')).toBe(
      'subunit-unrecoverable-failure',
    );
  });

  it('does not block on a warning, however alarming the keyword', () => {
    // The regression. A 7835 with paper in tray 1 says exactly this.
    expect(isBlockingReason('media-empty-warning')).toBe(false);
    expect(isBlockingReason('marker-supply-empty-warning')).toBe(false);
    expect(isBlockingReason('media-jam-warning')).toBe(false);
  });

  it('blocks on the same keyword when the device calls it an error', () => {
    expect(isBlockingReason('media-empty-error')).toBe(true);
    expect(isBlockingReason('media-jam-error')).toBe(true);
    expect(isBlockingReason('door-open-error')).toBe(true);
  });

  it('blocks a bare blocking keyword, since no suffix means no verdict', () => {
    expect(isBlockingReason('media-empty')).toBe(true);
    expect(isBlockingReason('device-mismatch')).toBe(true);
  });

  it('never blocks on a reason that is not in the blocking set', () => {
    expect(isBlockingReason('toner-low-warning')).toBe(false);
    expect(isBlockingReason('toner-low-error')).toBe(false);
    expect(isBlockingReason('subunit-power-saver-report')).toBe(false);
  });

  it('clears the exact reason list the 7835 reports', () => {
    // Verbatim from `Get-Printer-Attributes`, duplicates included.
    const reported = [
      'subunit-unrecoverable-failure-warning',
      'media-empty-warning',
      'media-empty-warning',
      'toner-low-warning',
      'toner-low-warning',
      'toner-low-warning',
      'toner-low-warning',
      'subunit-recoverable-failure-warning',
      'media-empty-warning',
    ];

    expect(blockingReasons(reported)).toEqual([]);
  });
});

/* ════════════════════════════ hrPrinterDetectedErrorState (RFC 3805) ═══ */

describe('hrPrinterDetectedErrorState', () => {
  it('assigns every bit the keyword RFC 3805 gives it', () => {
    // The table is the bug surface: pinning it whole means a future edit that
    // shifts one row fails here rather than in a building.
    expect(ERROR_STATE_BITS.map((entry) => [entry.bit, entry.reason])).toEqual([
      [0, 'media-low'],
      [1, 'media-empty'],
      [2, 'marker-supply-low'],
      [3, 'marker-supply-empty'],
      [4, 'door-open'],
      [5, 'media-jam'],
      [6, 'offline'],
      [7, 'service-request'],
      [8, 'input-tray-missing'],
      [9, 'output-tray-missing'],
      [10, 'marker-supply-missing'],
      [11, 'output-area-almost-full'],
      [12, 'output-area-full'],
      [13, 'input-tray-empty'],
      [14, 'overdue-prevent-maint'],
    ]);
  });

  it('decodes the live 7835 byte pair to what the device says in words', () => {
    // 0x21 0x04, read back from the device. Its own prtAlertTable lists four
    // toners near end of life, an image-overwrite request, and trays 2–5 empty.
    const decoded = decodeErrorState(Buffer.from([0x21, 0x04]));

    expect(decoded).toEqual([
      'marker-supply-low-warning',
      'service-request-warning',
      'input-tray-empty-warning',
    ]);
    expect(blockingReasons(decoded)).toEqual([]);
  });

  it('reads bit 0 as the most significant bit of octet 0', () => {
    expect(decodeErrorState(Buffer.from([0x80, 0x00]))).toEqual(['media-low-warning']);
    expect(decodeErrorState(Buffer.from([0x01, 0x00]))).toEqual(['service-request-warning']);
    expect(decodeErrorState(Buffer.from([0x00, 0x80]))).toEqual(['input-tray-missing-error']);
  });

  it('separates "no paper anywhere" from "one tray is empty"', () => {
    // The distinction the old table did not have, and the whole point of the
    // fix: bit 1 stops the queue, bit 13 does not.
    const noPaper = decodeErrorState(Buffer.from([0x40, 0x00]));
    expect(noPaper).toEqual(['media-empty-error']);
    expect(blockingReasons(noPaper)).toEqual(['media-empty-error']);

    const oneTrayEmpty = decodeErrorState(Buffer.from([0x00, 0x04]));
    expect(oneTrayEmpty).toEqual(['input-tray-empty-warning']);
    expect(blockingReasons(oneTrayEmpty)).toEqual([]);
  });

  it('still catches a device that is genuinely stuck', () => {
    // Jam (bit 5) and door open (bit 4) — 0b00001100.
    const decoded = decodeErrorState(Buffer.from([0x0c, 0x00]));
    expect(decoded).toEqual(['door-open-error', 'media-jam-error']);
    expect(blockingReasons(decoded)).toHaveLength(2);
  });

  it('reports nothing on a healthy device', () => {
    expect(decodeErrorState(Buffer.from([0x00, 0x00]))).toEqual([]);
  });

  it('tolerates a single-octet field from firmware that truncates it', () => {
    expect(decodeErrorState(Buffer.from([0x20]))).toEqual(['marker-supply-low-warning']);
  });
});

/* ═══════════════════════════════════════════════════ operator wording ═══ */

describe('describeBlockingState', () => {
  it('names the condition from a suffixed reason', () => {
    expect(describeBlockingState('Reception', ['media-empty-error'])).toBe(
      'Reception is not ready: the paper tray is empty.',
    );
  });

  it('collapses the per-subunit repeats a device sends', () => {
    // Three empty trays are one sentence, not "the paper tray is empty, the
    // paper tray is empty and the paper tray is empty".
    expect(describeBlockingState('Reception', ['media-empty-error', 'media-empty-error'])).toBe(
      'Reception is not ready: the paper tray is empty.',
    );
  });

  it('joins distinct conditions', () => {
    expect(describeBlockingState('Academy', ['media-jam-error', 'door-open-error'])).toBe(
      'Academy is not ready: there is a paper jam and a door or cover is open.',
    );
  });
});

/* ═══════════════════════════════════════════════════ the fleet-board card ═══ */

describe('printerCondition', () => {
  const printerWith = (stateReasons: string[]): Parameters<typeof printerCondition>[0] =>
    ({
      status: 'degraded',
      stateReasons,
      supplies: [],
      isDraining: false,
      isActive: true,
    }) as unknown as Parameters<typeof printerCondition>[0];

  it('surfaces the condition somebody can act on, not the first one listed', () => {
    // The live 7835 card. The device lists the subunit fault first; the useful
    // fact is that all four cartridges are at 1%.
    const condition = printerCondition(
      printerWith([
        'subunit-unrecoverable-failure-warning',
        'media-empty-warning',
        'toner-low-warning',
        'subunit-recoverable-failure-warning',
        'subunit-power-saver-report',
      ]),
    );

    expect(condition).toEqual({ kind: 'attention', text: 'Low on ink' });
  });

  it('never calls a warning "stopped"', () => {
    expect(printerCondition(printerWith(['media-empty-warning'])).kind).toBe('attention');
  });

  it('still calls an error "stopped"', () => {
    expect(printerCondition(printerWith(['media-empty-error']))).toEqual({
      kind: 'stopped',
      text: 'Out of paper',
    });
  });

  it('falls back to the subunit wording when nothing actionable is reported', () => {
    expect(printerCondition(printerWith(['subunit-unrecoverable-failure-warning']))).toEqual({
      kind: 'attention',
      text: 'Needs attention',
    });
  });
});

describe('supplyName', () => {
  it('drops the part and serial number a Xerox appends', () => {
    expect(supplyName('Black Toner, PN 006R01509;SN56195b80e00004d6')).toBe('Black Toner');
    expect(supplyName('Drum Cartridge (R1), PN 013R00662;SN49245580e000042a')).toBe(
      'Drum Cartridge (R1)',
    );
    expect(supplyName('Fuser, PN unknown;SNunknown')).toBe('Fuser');
  });

  it('leaves a name it does not recognise intact', () => {
    // Better whole than truncated by a guess.
    expect(supplyName('Black Toner')).toBe('Black Toner');
    expect(supplyName('Toner Cartridge, Black, High Yield')).toBe(
      'Toner Cartridge, Black, High Yield',
    );
  });
});

/* ═══════════════════════════════════════════════════════ supply units ═══ */

describe('supplyPercent', () => {
  const supply = (over: Partial<SupplyReading>): SupplyReading => ({
    index: 1,
    name: 'Supply',
    colorant: null,
    level: null,
    maxLevel: null,
    unit: null,
    ...over,
  });

  it('publishes a percentage when the device reports one', () => {
    // Drum Cartridge (R1) on the live 7835 — the device's page says 35%.
    expect(supplyPercent(supply({ unit: 'percent', level: 35, maxLevel: 100 }))).toBe(35);
  });

  it('refuses to invent one from a count', () => {
    // Black Toner: 260 pages left of a 26,000-page cartridge. The division
    // gives 1%; the printer's own page says 10%. Publishing neither beats
    // publishing a number that argues with the machine.
    expect(supplyPercent(supply({ unit: 'impressions', level: 260, maxLevel: 26000 }))).toBeNull();
    expect(supplyPercent(supply({ unit: 'sheets', level: 150, maxLevel: 15000 }))).toBeNull();
  });

  it('reads an unlabelled level out of 100 as a percentage', () => {
    expect(supplyPercent(supply({ unit: null, level: 62, maxLevel: 100 }))).toBe(62);
  });

  it('stays silent when it cannot tell what it is dividing', () => {
    expect(supplyPercent(supply({ unit: null, level: 260, maxLevel: 26000 }))).toBeNull();
    expect(supplyPercent(supply({ unit: 'percent', level: null }))).toBeNull();
  });
});

describe('supplyFraction', () => {
  it('still measures every supply, whatever the unit', () => {
    // Thresholds and the burn-rate forecast need this, and it is valid because
    // it is only ever compared against itself over time.
    const toner = {
      index: 1,
      name: 'Black Toner',
      colorant: 'black',
      level: 260,
      maxLevel: 26000,
      unit: 'impressions',
    };
    expect(supplyFraction(toner)).toBeCloseTo(0.01, 5);
    // Low enough to raise the reorder alert the device is also asking for.
    expect(supplyFraction(toner)).toBeLessThanOrEqual(0.1);
  });
});

describe('supplyLevelText', () => {
  const supply = (over: Partial<PrinterSupply>): PrinterSupply => ({
    name: 'Supply',
    colorant: null,
    level: null,
    maxLevel: null,
    unit: null,
    percent: null,
    estimatedDaysRemaining: null,
    ...over,
  });

  it('shows a percentage where there is one', () => {
    expect(supplyLevelText(supply({ percent: 35 }))).toBe('35%');
  });

  it('shows the count the device actually reported', () => {
    // Matches the "Estimated Pages" column on the printer's own supplies page.
    expect(supplyLevelText(supply({ level: 260, unit: 'impressions' }))).toBe('260 pages');
    expect(supplyLevelText(supply({ level: 1500, unit: 'sheets' }))).toBe('1,500 sheets');
  });

  it('shows nothing rather than a bare number in an unknown unit', () => {
    expect(supplyLevelText(supply({ level: 42, unit: 'tenths-of-grams' }))).toBeNull();
    expect(supplyLevelText(supply({ level: null }))).toBeNull();
  });
});

describe('supplyGaugePercent', () => {
  it('fills the bar from the fraction of rated capacity', () => {
    // A nearly-empty bar beside "260 pages" — two true statements.
    expect(
      supplyGaugePercent({
        name: 'Black Toner',
        colorant: 'black',
        level: 260,
        maxLevel: 26000,
        unit: 'impressions',
        percent: null,
        estimatedDaysRemaining: null,
      }),
    ).toBeCloseTo(1, 5);
  });
});
