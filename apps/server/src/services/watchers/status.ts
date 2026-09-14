import { jitteredInterval, type PrinterStatus } from '@kode/shared';
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { printersModel, type PrinterWithSecrets } from '../../models/printers.js';
import { statsModel } from '../../models/stats.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';
import { recordStatus, targets } from '../collector/registry.js';
import { events } from '../events.js';
import { notify, resolveCondition } from '../notify.js';
import { defaultIppUri, readIppState } from '../transport/ipp.js';
import { probePort, RAW_PORT } from '../transport/raw9100.js';
import { readState, readSupplies, supplyFraction, supplyPercent } from '../snmp/counters.js';
import { unitNoun } from '../snmp/oids.js';
import { IPP_PORT } from '../transport/ipp.js';

const log = subsystem('watcher:status');

/**
 * Printer state and supply monitoring (§B7.4).
 *
 * The delivered build spawned an ICMP ping per printer per sweep. That answers
 * "the network interface responds", not "this device can print right now", and
 * it costs an OS process per check. Three sources are tried in preference
 * order instead, each strictly more informative than the last:
 *
 *   1. **IPP** `printer-state-reasons` — real state: toner, paper, jams, doors.
 *   2. **SNMP** `hrPrinterDetectedErrorState` — the same information as a bit
 *      field, where IPP is absent.
 *   3. **TCP connect** to 631 or 9100 — the reachability floor. Cheaper than
 *      spawning a process, and it tests the port that actually carries print
 *      traffic. A device answering ping with 9100 closed is offline for every
 *      purpose this system has.
 */

let timer: NodeJS.Timeout | null = null;
let stopping = false;
let sweeping = false;

export function startStatusWatcher(collectorId: number | null = null): void {
  if (!config.polling.enabled) return;
  stopping = false;
  void sweep(collectorId);
}

export function stopStatusWatcher(): void {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

async function sweep(collectorId: number | null): Promise<void> {
  if (stopping || sweeping) return;
  sweeping = true;

  try {
    void collectorId; // the source already knows which estate it serves
    const polled = await targets().pollTargets();
    const allPrinters = config.collector.mode ? [] : await printersModel.listAll(pool);

    // Sequential with a small gap rather than Promise.all: fifty simultaneous
    // IPP requests across an inter-building link is exactly the burst §A6.4
    // warns about.
    for (const printer of polled) {
      if (stopping) break;
      await checkPrinter(printer).catch((error: unknown) => {
        log.debug({ printerId: printer.id, ...serialiseError(error) }, 'status check failed');
      });
      await sleep(120);
    }

    // Printers with SNMP disabled still need a reachability answer, or the
    // fleet board shows them permanently "unknown".
    for (const printer of allPrinters) {
      if (stopping) break;
      if (polled.some((target) => target.id === printer.id)) continue;
      const full = await targets().find(printer.id);
      if (full) await checkReachabilityOnly(full);
    }
  } catch (error) {
    log.error({ ...serialiseError(error) }, 'status sweep failed');
  } finally {
    sweeping = false;
    if (!stopping) {
      timer = setTimeout(
        () => void sweep(collectorId),
        jitteredInterval(config.polling.statusIntervalMs, 0.15),
      );
      timer.unref();
    }
  }
}

async function checkPrinter(printer: PrinterWithSecrets): Promise<void> {
  const previousStatus = printer.status;
  let status: PrinterStatus = 'unknown';
  let reasons: string[] = [];

  // 1. IPP, where the device supports it.
  if (printer.capabilities.ipp.supported === true) {
    try {
      const state = await readIppState(printer.ippUri ?? defaultIppUri(printer.ipAddress));
      status = state.status;
      reasons = state.stateReasons;
    } catch {
      // Fall through — a failed IPP state read is not evidence of anything by
      // itself, and demoting the transport here would conflate "asleep" with
      // "does not speak IPP" (§B6.2).
    }
  }

  // 2. SNMP error-state bit field.
  if (status === 'unknown' && printer.snmpVersion !== 'disabled') {
    try {
      const state = await readState(printer);
      if (state) {
        status = state.status;
        reasons = state.stateReasons;
      }
    } catch {
      // Handled by the reachability floor below.
    }
  }

  // 3. Reachability floor.
  if (status === 'unknown') {
    const reachable = await probeAnyPort(printer.ipAddress);
    status = reachable ? 'online' : 'offline';
    reasons = reachable ? [] : ['offline'];
  }

  await applyStatus(printer, status, reasons, previousStatus);

  if (printer.snmpVersion !== 'disabled') {
    await updateSupplies(printer).catch(() => undefined);
  }
}

async function checkReachabilityOnly(printer: PrinterWithSecrets): Promise<void> {
  const reachable = await probeAnyPort(printer.ipAddress);
  await applyStatus(
    printer,
    reachable ? 'online' : 'offline',
    reachable ? [] : ['offline'],
    printer.status,
  );
}

async function probeAnyPort(host: string): Promise<boolean> {
  if (await probePort(host, IPP_PORT, 2500)) return true;
  return probePort(host, RAW_PORT, 2500);
}

async function applyStatus(
  printer: PrinterWithSecrets,
  status: PrinterStatus,
  reasons: string[],
  previousStatus: PrinterStatus,
): Promise<void> {
  await recordStatus(printer.id, status, reasons, {
    resetFailures: status === 'online',
    incrementFailures: status === 'offline',
  });

  // A collector has no database to read back from and no browsers attached;
  // the status reaches the server in the next heartbeat instead.
  if (!config.collector.mode) {
    const updated = await printersModel.find(pool, printer.id);
    if (updated) events.printerUpdated(updated);
  }

  if (status === previousStatus) return;

  const dedupeKey = `printer:${printer.id}:state`;

  if (status === 'online') {
    // Clearing the key lets the next fault raise a fresh alert rather than
    // silently incrementing the resolved one.
    await resolveCondition(dedupeKey, pool);
    return;
  }

  await notify(
    {
      type: 'printer.state_changed',
      severity: status === 'offline' ? 'critical' : 'warning',
      printerId: printer.id,
      message:
        status === 'offline'
          ? `${printer.name} is not reachable${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}.`
          : `${printer.name} needs attention: ${reasons.join(', ')}.`,
      payload: { status, reasons },
      dedupeKey,
      push: status === 'offline',
    },
    pool,
  );
}

/**
 * Reads toner levels and projects a days-to-empty figure.
 *
 * The forecast is a straight line through recent consumption, and it is
 * withheld until there are at least four observations spanning a day —
 * extrapolating from two points produces confident nonsense, and a dashboard
 * that says "3 days" and means it is worth more than one that always shows a
 * number.
 */
async function updateSupplies(printer: PrinterWithSecrets): Promise<void> {
  const supplies = await readSupplies(printer);
  if (supplies.length === 0) return;

  await printersModel.replaceSupplies(
    pool,
    printer.id,
    supplies.map((supply) => ({
      index: supply.index,
      name: supply.name,
      colorant: supply.colorant,
      level: supply.level,
      maxLevel: supply.maxLevel,
      unit: supply.unit,
    })),
  );

  for (const supply of supplies) {
    /* The threshold runs on the fraction, the message on what the device said.
     *
     * `supplyPercent` is null for a cartridge measured in pages, because a
     * percentage derived from a rated yield contradicts the printer's own
     * display. The *fraction* is still the right thing to compare against a
     * threshold — a cartridge with 260 of 26,000 pages left does need
     * reordering — so the alert fires on that and describes the level in the
     * unit the device chose, rather than announcing a number nobody can find
     * on the machine. */
    const fraction = supplyFraction(supply);
    if (fraction === null) continue;

    const percent = supplyPercent(supply);
    const remaining =
      percent !== null
        ? `${percent}%`
        : supply.level !== null && unitNoun(supply.unit)
          ? `about ${supply.level} ${unitNoun(supply.unit)} from empty`
          : `low`;

    if (fraction <= 0.1) {
      await notify(
        {
          type: 'printer.supply_low',
          severity: fraction <= 0.03 ? 'critical' : 'warning',
          printerId: printer.id,
          message: `${printer.name}: ${supply.name} is ${remaining}.`,
          payload: { supply: supply.name, percent, level: supply.level, unit: supply.unit },
          dedupeKey: `printer:${printer.id}:supply:${supply.index}`,
        },
        pool,
      );
      continue;
    }

    const burn = await statsModel.supplyBurnRate(pool, printer.id, supply.index);
    if (!burn || burn.percentPerDay <= 0) continue;

    const daysRemaining = Math.floor((fraction * 100) / burn.percentPerDay);
    if (daysRemaining <= 14) {
      await notify(
        {
          type: 'printer.supply_forecast',
          severity: 'info',
          printerId: printer.id,
          message:
            `${printer.name}: ${supply.name} is ${remaining} and is on track to run out in ` +
            `about ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.`,
          payload: { supply: supply.name, percent, level: supply.level, daysRemaining },
          dedupeKey: `printer:${printer.id}:supply-forecast:${supply.index}`,
        },
        pool,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
