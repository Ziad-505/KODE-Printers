/**
 * Object identifiers used against printers.
 *
 * Named constants rather than literals at the call sites: `1.3.6.1.2.1.43.5.1.1.17.1`
 * appearing in three files is three chances to transpose a digit, and a
 * transposed OID returns "no such object" rather than a wrong number, so it
 * fails as a silent gap in the audit trail rather than as an error.
 */

/* ------------------------------------------------------- RFC 1213, system  */

export const SYSTEM = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
} as const;

/* ---------------------------------------------- RFC 3805, the Printer-MIB  */

export const PRINTER_MIB = {
  /**
   * prtGeneralSerialNumber — the identity anchor (ADR-006).
   *
   * An IP address is a lease; a serial number is the device. Anchoring on the
   * former means a DHCP renewal silently turns a working printer into an
   * unreachable one, and the admin's natural fix — re-adding it — splits the
   * audit trail across two records with the permissions on the wrong one.
   */
  serialNumber: '1.3.6.1.2.1.43.5.1.1.17.1',

  /**
   * prtMarkerLifeCount — lifetime impressions.
   *
   * This counts *everything the print engine marks*: prints, photocopies,
   * received faxes and internally generated report pages. §A7.1 is blunt about
   * the consequence — on an MFP fleet in a sports club, where reception copies
   * membership forms all day, treating this delta as "prints" materially
   * overstates printing. Hence `walkupReportLabel` and the vendor OIDs below.
   */
  markerLifeCount: '1.3.6.1.2.1.43.10.2.1.4.1.1',

  /**
   * prtMarkerColorantValue — "black", "cyan". Lives in the *colorant* table
   * (43.12), not the supplies table, and is indexed by colorant rather than by
   * supply. This pointed at 43.11.1.1.6 — which is the supplies description —
   * so every cartridge's colorant came back as a copy of its own name.
   * `suppliesColorantIndex` below is what joins the two.
   */
  markerColorantValue: '1.3.6.1.2.1.43.12.1.1.4',
  /** prtMarkerSuppliesDescription — walked to enumerate cartridges. */
  suppliesDescription: '1.3.6.1.2.1.43.11.1.1.6.1',
  /** prtMarkerSuppliesColorantIndex — supply index → colorant index, or 0 for none. */
  suppliesColorantIndex: '1.3.6.1.2.1.43.11.1.1.3.1',
  /** prtMarkerSuppliesLevel — current level; -2 means "unknown", -3 "some left". */
  suppliesLevel: '1.3.6.1.2.1.43.11.1.1.9.1',
  /** prtMarkerSuppliesMaxCapacity — denominator for the percentage. */
  suppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8.1',
  /**
   * prtMarkerSuppliesSupplyUnit — what the level and the maximum actually count.
   *
   * Ignored until a WorkCentre 7835 made the cost visible. Its drums report
   * `percent`; its toners report `impressions`, where the level is estimated
   * pages remaining and the maximum is the cartridge's rated yield. Those are
   * different quantities, so dividing them produced "1%" beside a device
   * displaying "10% — Reorder — 268 pages". Without this OID there is no way to
   * know which supplies may be divided and which may not.
   */
  suppliesUnit: '1.3.6.1.2.1.43.11.1.1.7.1',
  suppliesType: '1.3.6.1.2.1.43.11.1.1.5.1',
} as const;

/**
 * prtMarkerSuppliesSupplyUnitTC (RFC 3805).
 *
 * Only `percent` is safe to publish as a percentage. Everything else is a
 * count or a measure whose maximum is a rated capacity rather than a full-scale
 * reading, and the two are not interchangeable.
 */
export const SUPPLY_UNITS: Readonly<Record<number, string>> = {
  1: 'other',
  2: 'unknown',
  3: 'ten-thousandths-of-inches',
  4: 'micrometers',
  7: 'impressions',
  8: 'sheets',
  11: 'hours',
  12: 'thousandths-of-ounces',
  13: 'tenths-of-grams',
  14: 'hundredths-of-fluid-ounces',
  15: 'tenths-of-millilitres',
  16: 'feet',
  17: 'meters',
  18: 'items',
  19: 'percent',
} as const;

/** Whether a level in this unit is itself a percentage. */
export function unitIsPercent(unit: string | null): boolean {
  return unit === 'percent';
}

/** The plural noun for a count unit, for "268 pages left". */
export function unitNoun(unit: string | null): string | null {
  if (unit === 'impressions') return 'pages';
  if (unit === 'sheets') return 'sheets';
  if (unit === 'items') return 'items';
  if (unit === 'hours') return 'hours';
  return null;
}

/* ------------------------------------------- RFC 2790, host resources MIB  */

export const HOST_RESOURCES = {
  deviceDescr: '1.3.6.1.2.1.25.3.2.1.3.1',
  /**
   * hrPrinterDetectedErrorState — a bit field, used where IPP is absent.
   *
   * Bit order is defined by the MIB and is *big-endian within each octet*, which
   * is the detail most implementations get wrong. See `ERROR_STATE_BITS`.
   */
  printerDetectedErrorState: '1.3.6.1.2.1.25.3.5.1.2.1',
  printerStatus: '1.3.6.1.2.1.25.3.5.1.1.1',
} as const;

/**
 * hrPrinterDetectedErrorState bit assignments (RFC 3805 §2 / RFC 2790).
 *
 * Bit 0 is the most significant bit of the first octet — that part was never
 * the problem. The assignments were: bits 2 upwards carried an invented order
 * that happened to look like IPP's keyword list, so a WorkCentre 7835 returning
 * `0x21 0x04` — lowToner, serviceRequested, inputTrayEmpty, corroborated
 * exactly by its own `prtAlertTable` — decoded as `output-area-almost-full`,
 * `output-media-empty` and `output-tray-missing`. Three conditions the device
 * never reported, none of them the four toners that were actually low.
 *
 * The RFC's order is below and is not negotiable; each entry carries the
 * severity the keyword implies, because SNMP has no equivalent of IPP's
 * `-warning` suffix and the dispatch gate needs one.
 *
 * The pair that matters most is bits 1 and 13. `noPaper` is the device saying
 * it cannot feed a sheet from anywhere; `inputTrayEmpty` is one tray of five
 * being empty while the others are loaded. Collapsing them — as the old table
 * did by not having bit 13 at all — is what turns a routine "tray 3 needs
 * refilling" into a printer the queue refuses to send to.
 */
export const ERROR_STATE_BITS: ReadonlyArray<{
  bit: number;
  reason: string;
  severity: 'warning' | 'error';
}> = [
  { bit: 0, reason: 'media-low', severity: 'warning' },
  { bit: 1, reason: 'media-empty', severity: 'error' },
  { bit: 2, reason: 'marker-supply-low', severity: 'warning' },
  { bit: 3, reason: 'marker-supply-empty', severity: 'error' },
  { bit: 4, reason: 'door-open', severity: 'error' },
  { bit: 5, reason: 'media-jam', severity: 'error' },
  { bit: 6, reason: 'offline', severity: 'error' },
  /**
   * serviceRequested is a warning, not an error.
   *
   * RFC 3805 defines it as "service requested", which covers everything from a
   * failed engine to a maintenance reminder. The 7835 sets it for
   * `19-506-00 Immediate Image Overwrite error`, whose own text ends "Print
   * service can continue; other machine services are unaffected." Treating the
   * bit as blocking would refuse every job on a printer that is telling us, in
   * words, that it can print.
   */
  { bit: 7, reason: 'service-request', severity: 'warning' },
  { bit: 8, reason: 'input-tray-missing', severity: 'error' },
  { bit: 9, reason: 'output-tray-missing', severity: 'warning' },
  { bit: 10, reason: 'marker-supply-missing', severity: 'error' },
  { bit: 11, reason: 'output-area-almost-full', severity: 'warning' },
  { bit: 12, reason: 'output-area-full', severity: 'error' },
  { bit: 13, reason: 'input-tray-empty', severity: 'warning' },
  { bit: 14, reason: 'overdue-prevent-maint', severity: 'warning' },
];

/**
 * Decodes the bit field into IPP-style reason keywords, so the rest of the
 * system has one vocabulary for device state regardless of which protocol
 * reported it.
 *
 * The IPP severity suffix is appended here rather than left off, so a reason
 * that arrived over SNMP and one that arrived over IPP are the same string and
 * reach `isBlockingReason` on equal terms.
 */
export function decodeErrorState(octets: Buffer): string[] {
  const reasons: string[] = [];
  for (const { bit, reason, severity } of ERROR_STATE_BITS) {
    const byteIndex = Math.floor(bit / 8);
    const byte = octets[byteIndex];
    if (byte === undefined) continue;
    // Bit 0 is the MSB of octet 0.
    const mask = 0x80 >> (bit % 8);
    if ((byte & mask) !== 0) reasons.push(`${reason}-${severity}`);
  }
  return reasons;
}

/**
 * Vendor-private counters that separate prints from photocopies (§B8.4, GAP-08).
 *
 * There is no standard equivalent — each manufacturer exposes its own tree,
 * which is why these are stored per printer in `snmp_print_oid` and
 * `snmp_copy_oid` rather than assumed. The values below are the defaults the
 * inventory pass (§B19.2) starts from; a device that answers none of them gets
 * `job_type = 'unknown'` and its activity is labelled, never counted as prints.
 */
export const VENDOR_COUNTERS: Readonly<
  Record<string, { print: string | null; copy: string | null; label: string }>
> = {
  hp: {
    print: '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.5.0',
    copy: '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.7.0',
    label: 'HP',
  },
  /**
   * Xerox has no default pair, and that is the honest answer rather than a gap.
   *
   * The previous default named `…13.2.1.6.1.20.1` as the print counter. On a
   * WorkCentre 7835 that OID returns 15023 — the same value as
   * `prtMarkerLifeCount` to the impression, because index 1 of the Xerox usage
   * table *is* Total Impressions. `verifyVendorCounters` accepted it, since it
   * only asked whether the OID answered, and from then on every photocopy the
   * device made was booked as a print by someone.
   *
   * The neighbouring indices split the total by colour, not by origin
   * (`.20.101` + `.20.102` = `.20.1`; `.20.201` + `.20.202` = `.20.200`
   * sheets), so there is no print/copy pair to substitute blind. The indices
   * differ across the WorkCentre, VersaLink and AltaLink families, so the right
   * source is the device's own Usage Counters page, entered per printer in
   * `snmp_print_oid` / `snmp_copy_oid`.
   *
   * Until an admin does that, this fleet reports Xerox walk-up activity as
   * `unknown` — §B8.4's stated requirement, and the reason `classifyDelta`
   * never returns `print` on a guess.
   */
  xerox: {
    print: null,
    copy: null,
    label: 'Xerox',
  },
  canon: {
    print: '1.3.6.1.4.1.1602.1.11.1.3.1.4.101',
    copy: '1.3.6.1.4.1.1602.1.11.1.3.1.4.102',
    label: 'Canon',
  },
  konica: {
    print: '1.3.6.1.4.1.18334.1.1.1.5.7.2.2.1.5.1.2',
    copy: '1.3.6.1.4.1.18334.1.1.1.5.7.2.2.1.5.2.2',
    label: 'Konica Minolta',
  },
  brother: {
    print: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8.0',
    copy: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.9.0',
    label: 'Brother',
  },
};

/** Guesses the vendor family from an SNMP sysDescr or IPP make-and-model string. */
export function vendorKeyFrom(description: string): keyof typeof VENDOR_COUNTERS | null {
  const lower = description.toLowerCase();
  if (lower.includes('hewlett') || /\bhp\b/.test(lower)) return 'hp';
  if (lower.includes('xerox')) return 'xerox';
  if (lower.includes('canon')) return 'canon';
  if (lower.includes('konica') || lower.includes('minolta')) return 'konica';
  if (lower.includes('brother')) return 'brother';
  return null;
}
