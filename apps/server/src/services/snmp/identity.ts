import type { Db } from '../../db/pool.js';
import { printersModel, type PrinterWithSecrets } from '../../models/printers.js';
import { notificationsModel } from '../../models/notifications.js';
import { subsystem } from '../../utilities/logger.js';
import { asInteger, asString, snmpGet } from './client.js';
import { HOST_RESOURCES, PRINTER_MIB, SYSTEM, VENDOR_COUNTERS, vendorKeyFrom } from './oids.js';

const log = subsystem('snmp:identity');

/**
 * Printer identity (ADR-006, §B7.1).
 *
 * A printer is identified by its serial number, not its IP address. The failure
 * this prevents is specific and damaging: in a DHCP estate the device takes a
 * new lease, every poll fails, status flips to offline, and an admin "fixes" it
 * by adding the printer again — producing two rows, a split audit trail, and a
 * permission set attached to the wrong one.
 */

export interface IdentityReading {
  serialNumber: string | null;
  sysName: string | null;
  description: string | null;
  vendor: string | null;
  model: string | null;
}

export async function readIdentity(printer: PrinterWithSecrets): Promise<IdentityReading> {
  const values = await snmpGet(printer, [
    PRINTER_MIB.serialNumber,
    SYSTEM.sysName,
    SYSTEM.sysDescr,
    HOST_RESOURCES.deviceDescr,
  ]);

  const description =
    asString(values.get(HOST_RESOURCES.deviceDescr) ?? null) ??
    asString(values.get(SYSTEM.sysDescr) ?? null);

  const { vendor, model } = splitDescription(description);

  return {
    serialNumber: asString(values.get(PRINTER_MIB.serialNumber) ?? null),
    sysName: asString(values.get(SYSTEM.sysName) ?? null),
    description,
    vendor,
    model,
  };
}

export type IdentityVerdict =
  | { kind: 'match' }
  | { kind: 'first-seen'; serialNumber: string }
  | { kind: 'no-serial' }
  | { kind: 'mismatch'; expected: string; found: string };

/**
 * Compares an observed serial against the stored one.
 *
 * The `mismatch` case is deliberately not self-healing. §B7.1: "If the serial
 * does not match the stored value, the device at that address MUST NOT be
 * treated as this printer. Do not silently rebind: a swapped device is exactly
 * the case where silently continuing corrupts the record."
 *
 * Concretely — someone swaps a broken MFP for a spare and it takes the old
 * lease. Rebinding silently would attribute the new device's counters, its
 * walk-up activity and its permission grants to the old device's history.
 */
export function compareIdentity(stored: string | null, observed: string | null): IdentityVerdict {
  if (observed === null) return { kind: 'no-serial' };
  if (stored === null) return { kind: 'first-seen', serialNumber: observed };
  if (normalise(stored) === normalise(observed)) return { kind: 'match' };
  return { kind: 'mismatch', expected: stored, found: observed };
}

/**
 * Reads identity and reconciles it with the stored record.
 *
 * Returns false when the caller must stop touching this printer — a mismatch
 * means we do not know what device is at that address, and polling counters
 * from an unknown device is how bad data enters the audit trail.
 */
export async function reconcileIdentity(
  db: Db,
  printer: PrinterWithSecrets,
): Promise<{ ok: boolean; reading: IdentityReading }> {
  const reading = await readIdentity(printer);
  const verdict = compareIdentity(printer.serialNumber, reading.serialNumber);

  switch (verdict.kind) {
    case 'match':
      return { ok: true, reading };

    case 'no-serial':
      // Not an error. Some devices expose no serial; §B7.1 says such printers
      // fall back to IP identity and that the limitation is recorded per
      // printer rather than assumed away.
      return { ok: true, reading };

    case 'first-seen': {
      await printersModel.update(db, printer.id, {
        serialNumber: verdict.serialNumber,
        ...(reading.vendor ? { vendor: reading.vendor } : {}),
        ...(reading.model ? { model: reading.model } : {}),
      });
      log.info(
        { printerId: printer.id, serialNumber: verdict.serialNumber },
        'anchored printer identity on serial number',
      );
      return { ok: true, reading };
    }

    case 'mismatch': {
      await printersModel.setStatus(db, printer.id, 'degraded', ['device-mismatch']);
      await notificationsModel.create(db, {
        type: 'printer.identity_mismatch',
        severity: 'critical',
        printerId: printer.id,
        message:
          `${printer.name} at ${printer.ipAddress} reports a different serial number than ` +
          'the one on record. The device may have been swapped or the address reassigned. ' +
          'Polling is paused for this printer until an administrator confirms.',
        payload: { expected: verdict.expected, found: verdict.found, ip: printer.ipAddress },
        // One alert per printer per condition, not one every four seconds.
        dedupeKey: `printer:${printer.id}:identity-mismatch`,
      });
      log.warn(
        { printerId: printer.id, expected: verdict.expected, found: verdict.found },
        'serial mismatch — refusing to rebind',
      );
      return { ok: false, reading };
    }
  }
}

/**
 * Suggests vendor print/copy counter OIDs for a newly discovered device (§B8.4).
 *
 * These are proposals, not facts. They are offered to the admin during the
 * inventory pass and only stored once a probe returns a plausible value,
 * because a wrong vendor OID reads as "no such object" and would silently
 * downgrade the printer to untyped device activity.
 */
export function suggestVendorCounters(
  description: string | null,
): { print: string | null; copy: string | null; label: string } | null {
  if (!description) return null;
  const key = vendorKeyFrom(description);
  const entry = key ? (VENDOR_COUNTERS[key] ?? null) : null;
  // A recognised vendor with no known pair is still worth returning: the label
  // tells the inventory pass which family it is looking at, and a null pair
  // says "ask the admin" rather than "this is not a Xerox".
  return entry;
}

/**
 * Verifies suggested vendor counters actually answer *and mean what we think*
 * before they are stored.
 *
 * Answering is not enough, and assuming it was is how the Xerox default
 * survived: `…13.2.1.6.1.20.1` replies instantly on a WorkCentre, with the same
 * number `prtMarkerLifeCount` returns, because it is the total-impressions
 * counter rather than a print-only one. Stored as `snmp_print_oid`, it made
 * every photocopy in the club arrive in the reports as somebody's print job.
 *
 * A print counter that tracks the life counter exactly is therefore rejected.
 * `unknown` activity is a limitation the reports already state; misattributed
 * activity is a number someone will act on.
 */
export async function verifyVendorCounters(
  printer: PrinterWithSecrets,
  candidate: { print: string | null; copy: string | null },
): Promise<{ print: string | null; copy: string | null }> {
  if (!candidate.print && !candidate.copy) return { print: null, copy: null };

  const wanted: string[] = [PRINTER_MIB.markerLifeCount];
  if (candidate.print) wanted.push(candidate.print);
  if (candidate.copy) wanted.push(candidate.copy);

  try {
    const values = await snmpGet(printer, wanted);
    const life = asInteger(values.get(PRINTER_MIB.markerLifeCount) ?? null);

    const accept = (oid: string | null): string | null => {
      if (!oid) return null;
      const value = values.get(oid);
      if (value === null || value === undefined) return null;
      // Equal to the lifetime total means it *is* the lifetime total.
      if (life !== null && asInteger(value) === life) {
        log.warn(
          { printerId: printer.id, oid, value: life },
          'vendor counter matches prtMarkerLifeCount exactly; it is a total, not a per-type counter',
        );
        return null;
      }
      return oid;
    };

    return { print: accept(candidate.print), copy: accept(candidate.copy) };
  } catch {
    return { print: null, copy: null };
  }
}

function normalise(serial: string): string {
  return serial.replace(/[\s-]/g, '').toUpperCase();
}

function splitDescription(description: string | null): {
  vendor: string | null;
  model: string | null;
} {
  if (!description) return { vendor: null, model: null };
  const cleaned = description.replace(/\s+/g, ' ').trim();
  const first = cleaned.split(' ')[0];
  if (!first) return { vendor: null, model: null };
  return {
    vendor: first,
    model: cleaned.slice(first.length).trim() || null,
  };
}
