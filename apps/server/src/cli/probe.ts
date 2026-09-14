import {
  decodeErrorState,
  ERROR_STATE_BITS,
  HOST_RESOURCES,
  PRINTER_MIB,
  SYSTEM,
  VENDOR_COUNTERS,
  vendorKeyFrom,
} from '../services/snmp/oids.js';
import { asInteger, asString, snmpGet, snmpWalk } from '../services/snmp/client.js';
import { readState, readSupplies, supplyPercent } from '../services/snmp/counters.js';
import { defaultIppUri, probeIpp, readIppState, IppError } from '../services/transport/ipp.js';
import { probePort, RAW_PORT } from '../services/transport/raw9100.js';
import { IPP_PORT } from '../services/transport/ipp.js';
import { blockingReasons, isBlockingReason, stripReasonSuffix } from '@kode/shared';
import type { PrinterWithSecrets } from '../models/printers.js';

/**
 * `npm run probe -- <ip> [community]` — what one printer actually says.
 *
 * The package declared this command and the file did not exist, so the one
 * tool for answering "is the device wrong or are we?" was a stack trace. It
 * exists now because that question came up the first time a Xerox was pointed
 * at this system and took a day to answer by hand.
 *
 * It reads the device through the same functions the watchers use — not a
 * parallel implementation — so a discrepancy here is a discrepancy in
 * production. The raw bytes are printed alongside the decoded result for
 * exactly that reason: a bit field and the words we made of it, side by side,
 * is the whole diagnosis.
 *
 * Nothing here writes to the database or sends a job.
 */

const [, , hostArg, community = 'public'] = process.argv;

if (!hostArg) {
  process.stderr.write('usage: npm run probe -- <printer-ip> [snmp-community]\n');
  process.exit(2);
}

const host: string = hostArg;

/** A probe target is a printer-shaped object, not a printer: nothing is stored. */
const target = {
  id: 0,
  name: host,
  ipAddress: host,
  snmpVersion: '2c',
  snmpCommunity: community,
  snmpUsername: null,
  snmpAuthKey: null,
  snmpPrivKey: null,
  snmpPageOid: PRINTER_MIB.markerLifeCount,
  snmpPrintOid: null,
  snmpCopyOid: null,
} as unknown as PrinterWithSecrets;

const heading = (text: string): void => {
  process.stdout.write(`\n\x1b[1m── ${text} ${'─'.repeat(Math.max(0, 58 - text.length))}\x1b[0m\n`);
};
const row = (label: string, value: unknown): void => {
  // Padded, then a single space guaranteed: `subunit-unrecoverable-failure` is
  // longer than the column and ran straight into its own value.
  process.stdout.write(`  ${label.padEnd(29)} ${String(value)}\n`);
};

async function main(): Promise<void> {
  process.stdout.write(`\nKODE Printer — probing ${host} (SNMP v2c, community "${community}")\n`);

  /* ------------------------------------------------------------ reachability */

  heading('reachability');
  const ippOpen = await probePort(host, IPP_PORT, 2500);
  const rawOpen = await probePort(host, RAW_PORT, 2500);
  row(`tcp/${IPP_PORT} (IPP)`, ippOpen ? 'open' : 'closed');
  row(`tcp/${RAW_PORT} (RAW)`, rawOpen ? 'open' : 'closed');

  /* -------------------------------------------------------------- identity  */

  heading('identity (SNMP)');
  let sysDescr: string | null = null;
  try {
    const values = await snmpGet(target, [
      SYSTEM.sysDescr,
      SYSTEM.sysName,
      PRINTER_MIB.serialNumber,
      PRINTER_MIB.markerLifeCount,
      HOST_RESOURCES.printerStatus,
    ]);
    sysDescr = asString(values.get(SYSTEM.sysDescr) ?? null);
    row('sysDescr', sysDescr ?? '(none)');
    row('sysName', asString(values.get(SYSTEM.sysName) ?? null) ?? '(none)');
    row('serial number', asString(values.get(PRINTER_MIB.serialNumber) ?? null) ?? '(none)');
    row(
      'prtMarkerLifeCount',
      asInteger(values.get(PRINTER_MIB.markerLifeCount) ?? null) ?? '(none)',
    );
    row('hrPrinterStatus', asInteger(values.get(HOST_RESOURCES.printerStatus) ?? null) ?? '(none)');
  } catch (error) {
    row('SNMP', `unavailable — ${error instanceof Error ? error.message : String(error)}`);
  }

  /* ------------------------------------------------- error-state bit field  */

  heading('hrPrinterDetectedErrorState');
  try {
    const values = await snmpGet(target, [HOST_RESOURCES.printerDetectedErrorState]);
    const raw = values.get(HOST_RESOURCES.printerDetectedErrorState);

    if (raw === null || raw === undefined) {
      row('raw', '(not implemented by this device)');
    } else {
      const octets = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'latin1');
      row('raw octets', `0x${octets.toString('hex')}`);
      row('binary', [...octets].map((byte) => byte.toString(2).padStart(8, '0')).join(' '));

      // Bit by bit, so a wrong table is visible rather than inferred.
      for (const { bit, reason, severity } of ERROR_STATE_BITS) {
        const byte = octets[Math.floor(bit / 8)];
        if (byte === undefined) continue;
        if ((byte & (0x80 >> (bit % 8))) === 0) continue;
        row(`  bit ${String(bit).padStart(2)} set`, `${reason}-${severity}`);
      }

      const decoded = decodeErrorState(octets);
      row('decoded', decoded.length > 0 ? decoded.join(', ') : '(no conditions)');
      row('blocking', blockingReasons(decoded).join(', ') || 'none — safe to send');
    }

    const state = await readState(target);
    if (state) row('→ status', state.status);
  } catch (error) {
    row('SNMP', `unavailable — ${error instanceof Error ? error.message : String(error)}`);
  }

  /* ----------------------------------------------------------- alert table  */

  heading('prtAlertTable (what the device says in words)');
  try {
    const alerts = await snmpWalk(target, '1.3.6.1.2.1.43.18.1.1.8', 20);
    if (alerts.length === 0) row('alerts', '(none)');
    for (const alert of alerts) {
      const text = asString(alert.value);
      if (text) process.stdout.write(`  • ${text}\n`);
    }
  } catch {
    row('alerts', '(unavailable)');
  }

  /* -------------------------------------------------------------- supplies  */

  heading('supplies');
  try {
    const supplies = await readSupplies(target);
    if (supplies.length === 0) row('supplies', '(none reported)');
    for (const supply of supplies) {
      const percent = supplyPercent(supply);
      row(
        `[${supply.index}] ${supply.colorant ?? '—'}`,
        `${supply.name} — ${percent === null ? 'level not quantified' : `${percent}%`}`,
      );
    }
  } catch {
    row('supplies', '(unavailable)');
  }

  /* ------------------------------------------------------ vendor counters   */

  heading('vendor counters');
  const vendorKey = sysDescr ? vendorKeyFrom(sysDescr) : null;
  const vendor = vendorKey ? VENDOR_COUNTERS[vendorKey] : null;

  if (!vendor) {
    row('vendor', 'not recognised — walk-up activity will be reported as "unknown"');
  } else if (!vendor.print && !vendor.copy) {
    row(vendor.label, 'no default print/copy pair for this family');
    row('', "read the device's Usage Counters page and set snmp_print_oid / snmp_copy_oid");
  } else {
    const life = asInteger(
      (await snmpGet(target, [PRINTER_MIB.markerLifeCount])).get(PRINTER_MIB.markerLifeCount) ??
        null,
    );
    for (const [label, oid] of [
      ['print', vendor.print],
      ['copy', vendor.copy],
    ] as const) {
      if (!oid) continue;
      const value = asInteger((await snmpGet(target, [oid])).get(oid) ?? null);
      const suspect = value !== null && value === life;
      row(
        `${vendor.label} ${label}`,
        value === null
          ? `${oid} → no such object`
          : `${oid} → ${value}${suspect ? '  ⚠ equals prtMarkerLifeCount: this is a TOTAL, not a per-type counter' : ''}`,
      );
    }
  }

  /* ------------------------------------------------------------------- IPP  */

  heading('IPP');
  if (!ippOpen) {
    row('IPP', `tcp/${IPP_PORT} closed — this device is RAW/9100 only`);
  } else {
    const uri = defaultIppUri(host);
    row('uri', uri);
    try {
      const capabilities = await probeIpp(uri);
      row('make and model', capabilities.makeAndModel ?? '(not reported)');
      row('ipp versions', capabilities.ipp.versions.join(', ') || '(none)');
      row('formats', capabilities.formats.join(', ') || '(none)');
      row('duplex', capabilities.sides.length > 1 ? 'yes' : 'no');
      row('colour', capabilities.colorModes.includes('color') ? 'yes' : 'no');

      const state = await readIppState(uri);
      row('→ status', state.status);
      if (state.stateReasons.length === 0) {
        row('state reasons', '(none)');
      } else {
        for (const reason of state.stateReasons) {
          row(
            `  ${stripReasonSuffix(reason)}`,
            `${reason}  ${isBlockingReason(reason) ? '\x1b[31mBLOCKS PRINTING\x1b[0m' : 'informational'}`,
          );
        }
      }
      const blocking = blockingReasons(state.stateReasons);
      row(
        'verdict',
        blocking.length > 0
          ? `jobs will be held: ${blocking.join(', ')}`
          : 'this printer will accept jobs',
      );
    } catch (error) {
      const kind = error instanceof IppError ? error.kind : 'protocol';
      row('probe failed', `${kind} — ${error instanceof Error ? error.message : String(error)}`);
      row(
        'consequence',
        kind === 'transient'
          ? 'capability left unknown; it will be probed again'
          : 'this printer would be demoted to RAW/9100',
      );
    }
  }

  process.stdout.write('\n');
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`probe failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
