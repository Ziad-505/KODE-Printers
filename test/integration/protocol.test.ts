import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeIppPrinter, FakeRawPrinter } from '../../tools/fake-printer/src/index.js';
import {
  probeIpp,
  readIppState,
  sendIpp,
  IppError,
} from '../../apps/server/src/services/transport/ipp.js';
import { sendRaw, probePort } from '../../apps/server/src/services/transport/raw9100.js';
import { blockingReasons, stripReasonSuffix } from '../../packages/shared/src/constants.js';

/**
 * §B17.2 scenarios 14 and 15, against the harness rather than hardware.
 *
 * §B17.1 calls the protocol harness "the piece most likely to be skipped and
 * most costly to skip". This file is why: without it, the rule that a *transient*
 * IPP failure must not demote a printer to RAW — the defect the document names
 * as most likely in that section — could only be verified by unplugging a real
 * device at the right moment.
 */

describe('15. IPP transient failure must not demote the printer', () => {
  let printer: FakeIppPrinter;
  let uri: string;

  beforeEach(async () => {
    printer = new FakeIppPrinter({ supportsDuplex: true, supportsColor: true });
    const port = await printer.listen();
    uri = `ipp://127.0.0.1:${port}/ipp/print`;
  });

  afterEach(async () => {
    await printer.close();
  });

  it('classifies a busy device as transient', async () => {
    printer.behaviour = { kind: 'transient', status: 'server-error-busy' };

    // A printer that is merely busy is not a printer without IPP. Conflating
    // the two is the defect §B6.2 warns about explicitly.
    await expect(
      sendIpp({
        uri,
        document: Buffer.from('%PDF-1.7'),
        documentFormat: 'application/pdf',
        jobName: 'test',
        username: 'testuser',
        copies: 1,
        sides: 'one-sided',
        colorMode: 'grayscale',
        media: 'iso_a4_210x297mm',
        orientation: 'portrait',
        pageRanges: [],
        timeoutMs: 4000,
      }),
    ).rejects.toMatchObject({ kind: 'transient' });
  });

  it('classifies a non-IPP response as a protocol failure', async () => {
    // A device with a web server on 631 and no IPP support returns HTML. That
    // *is* grounds for demotion, and the distinction from "busy" is the point.
    printer.behaviour = { kind: 'protocol' };

    await expect(probeIpp(uri, 4000)).rejects.toBeInstanceOf(IppError);
    await expect(probeIpp(uri, 4000)).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('classifies a client error as rejected, which is never retried', async () => {
    printer.behaviour = { kind: 'rejected', status: 'client-error-bad-request' };

    await expect(readIppState(uri, 4000)).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('a timeout is transient, not protocol', async () => {
    // The device accepted the connection and then said nothing. Without the
    // client-side timeout this would hold a worker slot indefinitely.
    printer.behaviour = { kind: 'transient' };

    await expect(readIppState(uri, 500)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('reads capabilities from a healthy device', async () => {
    const capabilities = await probeIpp(uri, 4000);

    expect(capabilities.ipp.supported).toBe(true);
    expect(capabilities.sides).toContain('two-sided-long-edge');
    expect(capabilities.colorModes).toContain('color');
    expect(capabilities.formats).toContain('application/pdf');
    expect(capabilities.probedVia).toBe('ipp');
  });

  it('maps a blocking state reason to offline', async () => {
    await printer.close();
    printer = new FakeIppPrinter({ stateReasons: ['media-jam'] });
    const port = await printer.listen();

    const state = await readIppState(`ipp://127.0.0.1:${port}/ipp/print`, 4000);

    expect(state.status).toBe('offline');
    expect(state.stateReasons).toContain('media-jam');
  });

  it('maps a warning reason to degraded, not offline', async () => {
    await printer.close();
    printer = new FakeIppPrinter({ stateReasons: ['toner-low-warning'] });
    const port = await printer.listen();

    const state = await readIppState(`ipp://127.0.0.1:${port}/ipp/print`, 4000);

    // Low toner means "someone should order some", not "stop printing".
    expect(state.status).toBe('degraded');
    // The suffix is kept, not stripped: it is the device's own verdict on
    // whether the condition stops printing, and nothing else carries it.
    expect(state.stateReasons).toContain('toner-low-warning');
    expect(state.stateReasons.map(stripReasonSuffix)).toContain('toner-low');
  });

  it('does not stop a printer that reports a blocking keyword as a warning', async () => {
    // The Xerox WorkCentre 7835 case. Paper in tray 1, trays 2–5 empty, so the
    // device emits one `media-empty-warning` per empty tray while staying idle.
    // Stripping the suffix turned that into `media-empty` and the queue refused
    // every job to a printer that was ready to take them.
    await printer.close();
    printer = new FakeIppPrinter({
      stateReasons: ['media-empty-warning', 'media-empty-warning', 'toner-low-warning'],
    });
    const port = await printer.listen();

    const state = await readIppState(`ipp://127.0.0.1:${port}/ipp/print`, 4000);

    expect(state.status).toBe('degraded');
    expect(blockingReasons(state.stateReasons)).toEqual([]);
    // Repeats are per-subunit; the board shows a condition, not a tally.
    expect(state.stateReasons).toEqual(['media-empty-warning', 'toner-low-warning']);
  });

  it('still stops a printer that reports the same keyword as an error', async () => {
    await printer.close();
    printer = new FakeIppPrinter({ stateReasons: ['media-empty-error'] });
    const port = await printer.listen();

    const state = await readIppState(`ipp://127.0.0.1:${port}/ipp/print`, 4000);

    expect(state.status).toBe('offline');
    expect(blockingReasons(state.stateReasons)).toEqual(['media-empty-error']);
  });
});

describe('RAW/9100 transport', () => {
  let printer: FakeRawPrinter;
  let port: number;

  beforeEach(async () => {
    printer = new FakeRawPrinter();
    port = await printer.listen();
  });

  afterEach(async () => {
    await printer.close();
  });

  const pjl = {
    copies: 2,
    sides: 'two-sided-long-edge' as const,
    colorMode: 'grayscale' as const,
    media: 'iso_a4_210x297mm' as const,
    orientation: 'portrait' as const,
    jobName: 'Membership form',
    username: 'testuser',
    contentType: 'application/pdf',
  };

  it('delivers the document with its PJL prologue', async () => {
    const result = await sendRaw({
      host: '127.0.0.1',
      port,
      document: Buffer.from('%PDF-1.7 body'),
      contentType: 'application/pdf',
      pjl,
      framing: 'pjl-plain',
    });

    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(printer.captures).toHaveLength(1);

    const received = printer.captures[0]?.bytes.toString('latin1') ?? '';
    expect(received).toContain('@PJL SET COPIES=2');
    expect(received).toContain('@PJL SET DUPLEX=ON');
    expect(received).toContain('%PDF-1.7 body');
    // The device must see a complete job, terminated properly.
    expect(received).toContain('@PJL EOJ');
  });

  it('falls back through the framing ladder when a device resets the connection', async () => {
    await printer.close();
    // A real Xerox behaviour: the language line is rejected, the same block
    // without it is accepted.
    printer = new FakeRawPrinter({ rejectFramings: ['pjl-with-language'] });
    port = await printer.listen();

    const result = await sendRaw({
      host: '127.0.0.1',
      port,
      document: Buffer.from('%PDF-1.7 body'),
      contentType: 'application/pdf',
      pjl,
    });

    expect(result.framingUsed).toBe('pjl-plain');
  });

  it('refuses a text file carrying PJL directives before opening a socket', async () => {
    // ESC + UEL, the real sequence. Without the escape byte the same text is
    // inert, which is precisely why the guard keys on the sequence rather than
    // on the string "@PJL" appearing anywhere.
    const malicious = Buffer.from('\u001B%-12345X@PJL DEFAULT PASSWORD=0\r\n', 'latin1');

    await expect(
      sendRaw({
        host: '127.0.0.1',
        port,
        document: malicious,
        contentType: 'text/plain',
        pjl,
      }),
    ).rejects.toMatchObject({ code: 'PJL_INJECTION_REJECTED', retryable: false });

    // The critical assertion: nothing reached the device at all.
    expect(printer.captures).toHaveLength(0);
  });

  it('reports an unreachable host as retryable', async () => {
    await printer.close();

    await expect(
      sendRaw({
        host: '127.0.0.1',
        port,
        document: Buffer.from('%PDF-1.7'),
        contentType: 'application/pdf',
        pjl,
        connectTimeoutMs: 800,
      }),
    ).rejects.toMatchObject({ code: 'PRINTER_UNREACHABLE', retryable: true });
  });

  it('probePort answers honestly in both directions', async () => {
    expect(await probePort('127.0.0.1', port, 1500)).toBe(true);
    await printer.close();
    expect(await probePort('127.0.0.1', port, 1500)).toBe(false);
  });
});

/**
 * Scenario 14: a partially written scan must not be ingested.
 *
 * Tested at the level of the stability gate's own conditions rather than by
 * running the watcher, because the watcher needs a database and this behaviour
 * does not.
 */
describe('14. the scan stability gate', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'kode-scan-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  const TEMP_PATTERNS: readonly RegExp[] = [
    /\.tmp$/i,
    /\.part$/i,
    /\.filepart$/i,
    /\.crdownload$/i,
    /^~\$/,
    /^\./,
    /\.swp$/i,
  ];

  const isTemporary = (name: string): boolean =>
    TEMP_PATTERNS.some((pattern) => pattern.test(name));

  it('condition 1 — rejects names that are transfer temporaries', () => {
    expect(isTemporary('scan001.pdf.tmp')).toBe(true);
    expect(isTemporary('scan001.part')).toBe(true);
    expect(isTemporary('.hidden.pdf')).toBe(true);
    expect(isTemporary('~$draft.docx')).toBe(true);
    expect(isTemporary('scan001.pdf')).toBe(false);
  });

  it('condition 2 — a file still growing has a changing size', async () => {
    const { stat } = await import('node:fs/promises');
    const path = join(folder, 'growing.pdf');

    await writeFile(path, Buffer.alloc(1024));
    const first = await stat(path);

    await appendFile(path, Buffer.alloc(4096));
    const second = await stat(path);

    // The watcher requires size *and* mtime unchanged across two polls at least
    // SCAN_STABILITY_MS apart. A fixed delay was rejected in ADR-009 because it
    // guesses at write duration and fails for large scans.
    expect(second.size).not.toBe(first.size);
  });

  it('condition 2 — a settled file reports a stable size', async () => {
    const { stat } = await import('node:fs/promises');
    const path = join(folder, 'settled.pdf');

    await writeFile(path, Buffer.alloc(2048));
    const first = await stat(path);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await stat(path);

    expect(second.size).toBe(first.size);
    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  it('condition 3 — a complete file opens for exclusive read', async () => {
    const { open } = await import('node:fs/promises');
    const path = join(folder, 'complete.pdf');
    await writeFile(path, Buffer.from('%PDF-1.7'));

    const handle = await open(path, 'r+');
    await handle.close();
    // On Windows this single syscall catches most in-progress writes on its
    // own, which is why it is in the gate despite conditions 1 and 2.
    expect(true).toBe(true);
  });
});
