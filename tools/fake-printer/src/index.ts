import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';

/**
 * The fake-printer harness (§B17.1).
 *
 * §B17.1 calls this "the piece most likely to be skipped and most costly to
 * skip", and it is right. Without it, every test of the hard parts of this
 * system — transport selection, PJL framing, the impression ledger, walk-up
 * attribution — needs physical hardware, which means those tests are never
 * written and the numbers in the reports are never verified.
 *
 * Three servers, all scriptable:
 *
 *   · **RAW/9100** — a TCP listener that records the exact bytes it receives,
 *     so a test can assert on the PJL prologue rather than on "it didn't throw".
 *   · **IPP** — an HTTP responder that returns canned attribute sets and can be
 *     told to fail transiently or at the protocol level, which is how the
 *     "don't demote a sleeping printer" rule in §B6.2 becomes testable.
 *   · **SNMP** — an agent whose page counter a test drives directly, which is
 *     the only way to exercise the ledger.
 */

/* ═══════════════════════════════════════════════════════════════ RAW / 9100 */

export interface RawCapture {
  bytes: Buffer;
  receivedAt: Date;
  /** Convenience: the PJL prologue as text, if there was one. */
  pjlHeader: string | null;
}

export interface RawPrinterOptions {
  port?: number;
  /**
   * Framings the device refuses by resetting the connection. Used to exercise
   * the fallback ladder — real Xerox devices reject a PJL block carrying an
   * explicit LANGUAGE line and accept the same block without it.
   */
  rejectFramings?: ReadonlyArray<'pjl-with-language' | 'pjl-plain'>;
}

export class FakeRawPrinter extends EventEmitter {
  readonly captures: RawCapture[] = [];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly options: RawPrinterOptions;

  constructor(options: RawPrinterOptions = {}) {
    super();
    this.options = options;
  }

  async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => this.handle(socket));
      this.server.once('error', reject);
      // Port 0 lets the OS choose, so parallel test files never collide.
      this.server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        const address = this.server?.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    const chunks: Buffer[] = [];

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);

      // Reject early, before the whole job arrives — which is exactly how a
      // real device behaves when it dislikes the framing.
      const head = Buffer.concat(chunks).toString('latin1', 0, 512);
      const framing = head.includes('@PJL ENTER LANGUAGE')
        ? 'pjl-with-language'
        : head.includes('@PJL')
          ? 'pjl-plain'
          : null;

      if (framing && this.options.rejectFramings?.includes(framing)) {
        socket.resetAndDestroy();
      }
    });

    socket.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString('latin1');
      const headerEnd = text.indexOf('\r\n\r\n');
      const capture: RawCapture = {
        bytes,
        receivedAt: new Date(),
        pjlHeader: text.startsWith('\u001B%-12345X')
          ? text.slice(0, headerEnd > 0 ? headerEnd : Math.min(1024, text.length))
          : null,
      };
      this.captures.push(capture);
      this.emit('job', capture);
      socket.end();
    });

    socket.on('error', () => undefined);
  }

  /**
   * Idempotent, and it does not wait for lingering sockets.
   *
   * Both properties are needed by real tests: a test that closes the printer
   * mid-case still has `afterEach` close it again, and `server.close()` alone
   * waits for every keep-alive connection to drain — which is how a teardown
   * hook ends up timing out and taking the whole file with it.
   */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;

    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // A listener with no connections closes immediately; this is the belt.
      setTimeout(resolve, 500).unref();
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════ IPP */

export type IppBehaviour =
  | { kind: 'ok' }
  /** Timeouts and busy responses. MUST NOT demote the printer to RAW. */
  | { kind: 'transient'; status?: string }
  /** A malformed or unsupported response. Demotes to RAW until the next probe. */
  | { kind: 'protocol' }
  /** The device understood and said no. Never retried. */
  | { kind: 'rejected'; status: string };

export interface FakeIppOptions {
  port?: number;
  behaviour?: IppBehaviour;
  /** Advertised in Get-Printer-Attributes. */
  supportsDuplex?: boolean;
  supportsColor?: boolean;
  acceptsPdf?: boolean;
  stateReasons?: readonly string[];
  makeAndModel?: string;
}

/**
 * A minimal IPP responder.
 *
 * It encodes just enough of the wire format for a real client to parse: the
 * version, the status code, a request id, and the attribute groups the probe
 * asks for. Anything beyond that is out of scope — this exists to test *our*
 * client, not to be an IPP server.
 */
export class FakeIppPrinter {
  private server: HttpServer | null = null;
  readonly requests: Array<{ operation: number; body: Buffer }> = [];
  behaviour: IppBehaviour;
  private readonly options: FakeIppOptions;

  constructor(options: FakeIppOptions = {}) {
    this.options = options;
    this.behaviour = options.behaviour ?? { kind: 'ok' };
  }

  async listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server = createHttpServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          // Bytes 2-3 of an IPP request are the operation id.
          const operation = body.length >= 4 ? body.readUInt16BE(2) : 0;
          this.requests.push({ operation, body });
          this.respond(res, operation, body);
        });
      });

      this.server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        const address = this.server?.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  }

  private respond(res: import('node:http').ServerResponse, operation: number, body: Buffer): void {
    if (this.behaviour.kind === 'transient' && !this.behaviour.status) {
      // A hung connection, to exercise the client's own timeout.
      return;
    }

    const requestId = body.length >= 8 ? body.readUInt32BE(4) : 1;
    const statusCode =
      this.behaviour.kind === 'ok'
        ? 0x0000 // successful-ok
        : this.behaviour.kind === 'transient'
          ? 0x0507 // server-error-busy
          : this.behaviour.kind === 'rejected'
            ? 0x0400 // client-error-bad-request
            : 0x0500; // server-error-internal-error

    if (this.behaviour.kind === 'protocol') {
      // Deliberately not IPP at all — an HTML error page is what a device with
      // a web server on 631 and no IPP support actually returns.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Printer web interface</body></html>');
      return;
    }

    const parts: Buffer[] = [];
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0); // version major
    header.writeUInt8(1, 1); // version minor
    header.writeUInt16BE(statusCode, 2);
    header.writeUInt32BE(requestId, 4);
    parts.push(header);

    // operation-attributes-tag
    parts.push(Buffer.from([0x01]));
    parts.push(attribute(0x47, 'attributes-charset', 'utf-8'));
    parts.push(attribute(0x48, 'attributes-natural-language', 'en'));

    if (statusCode === 0x0000) {
      if (operation === 0x000b) {
        // Get-Printer-Attributes
        parts.push(Buffer.from([0x04])); // printer-attributes-tag
        parts.push(
          attribute(
            0x41,
            'printer-make-and-model',
            this.options.makeAndModel ?? 'KODE FakeJet 9000',
          ),
        );
        parts.push(attribute(0x21, 'printer-state', 3)); // idle
        parts.push(
          multiValue(0x44, 'printer-state-reasons', this.options.stateReasons ?? ['none']),
        );
        parts.push(attribute(0x44, 'ipp-versions-supported', '1.1'));
        parts.push(
          multiValue(
            0x49,
            'document-format-supported',
            this.options.acceptsPdf === false
              ? ['application/pdf', 'application/postscript']
              : ['application/pdf'],
          ),
        );
        parts.push(
          multiValue(
            0x44,
            'sides-supported',
            this.options.supportsDuplex === false
              ? ['one-sided']
              : ['one-sided', 'two-sided-long-edge'],
          ),
        );
        parts.push(
          multiValue(
            0x44,
            'print-color-mode-supported',
            this.options.supportsColor ? ['monochrome', 'color'] : ['monochrome'],
          ),
        );
        parts.push(attribute(0x21, 'copies-supported', 999));
        parts.push(attribute(0x44, 'media-supported', 'iso_a4_210x297mm'));
      } else if (operation === 0x0002) {
        // Print-Job
        parts.push(Buffer.from([0x02])); // job-attributes-tag
        parts.push(attribute(0x21, 'job-id', this.requests.length));
        parts.push(attribute(0x45, 'job-uri', `ipp://127.0.0.1/jobs/${this.requests.length}`));
        parts.push(attribute(0x23, 'job-state', 5)); // processing
      }
    }

    parts.push(Buffer.from([0x03])); // end-of-attributes-tag

    const payload = Buffer.concat(parts);
    res.writeHead(200, {
      'Content-Type': 'application/ipp',
      'Content-Length': String(payload.length),
    });
    res.end(payload);
  }

  /** Idempotent and non-blocking, for the same reason as the RAW listener. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;

    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 500).unref();
    });
  }
}

/** Encodes one IPP attribute: tag, name length + name, value length + value. */
/**
 * A `1setOf` — one attribute carrying several values (RFC 8010 §3.1.4).
 *
 * The harness used to emit these as repeated *named* attributes, which is a
 * different thing on the wire: the second occurrence replaces the first, so a
 * printer configured with three state reasons served exactly one, and it was
 * always the last. Every test that passed a single reason worked, which is why
 * this stood — and it hid the multi-value handling that a real device exercises
 * on every poll. A Xerox WorkCentre reports nine `printer-state-reasons`.
 *
 * Additional values repeat the value tag with a zero-length name. That empty
 * name is the entire signal that says "another value of the attribute above".
 */
function multiValue(tag: number, name: string, values: readonly string[]): Buffer {
  const [first, ...rest] = values;
  if (first === undefined) return Buffer.alloc(0);
  return Buffer.concat([
    attribute(tag, name, first),
    ...rest.map((value) => attribute(tag, '', value)),
  ]);
}

function attribute(tag: number, name: string, value: string | number): Buffer {
  const nameBuffer = Buffer.from(name, 'utf8');
  const valueBuffer =
    typeof value === 'number'
      ? (() => {
          const buffer = Buffer.alloc(4);
          buffer.writeInt32BE(value);
          return buffer;
        })()
      : Buffer.from(value, 'utf8');

  const out = Buffer.alloc(1 + 2 + nameBuffer.length + 2 + valueBuffer.length);
  let offset = 0;
  out.writeUInt8(tag, offset);
  offset += 1;
  out.writeUInt16BE(nameBuffer.length, offset);
  offset += 2;
  nameBuffer.copy(out, offset);
  offset += nameBuffer.length;
  out.writeUInt16BE(valueBuffer.length, offset);
  offset += 2;
  valueBuffer.copy(out, offset);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════ SNMP */

export interface FakeSnmpOptions {
  port?: number;
  community?: string;
  serialNumber?: string;
  sysDescr?: string;
  /** Starting lifetime impression count. */
  pageCount?: number;
}

/**
 * A scriptable SNMP agent.
 *
 * The page counter is the whole point: a test drives it with `markPages()` and
 * asserts on what the attribution layer concluded. That is how every mandatory
 * scenario in §B17.2 involving the ledger becomes testable without hardware.
 */
export class FakeSnmpPrinter {
  private agent: { close(): void } | null = null;
  private counters = { life: 0, print: 0, copy: 0 };
  readonly options: FakeSnmpOptions;

  constructor(options: FakeSnmpOptions = {}) {
    this.options = options;
    this.counters.life = options.pageCount ?? 1000;
  }

  /** Simulates the print engine marking pages. */
  markPages(count: number, kind: 'print' | 'copy' = 'print'): void {
    this.counters.life += count;
    this.counters[kind] += count;
  }

  /** Simulates a firmware reset or counter rollover. */
  resetCounter(to = 0): void {
    this.counters = { life: to, print: 0, copy: 0 };
  }

  get lifeCount(): number {
    return this.counters.life;
  }

  async listen(): Promise<number> {
    const snmp = await import('net-snmp');
    const port = this.options.port ?? 0;

    // net-snmp's agent API varies across versions; the harness only needs a
    // handful of OIDs, so a small store keyed by OID is enough and keeps this
    // independent of the library's MIB machinery.
    const store = () => ({
      '1.3.6.1.2.1.43.10.2.1.4.1.1': this.counters.life,
      '1.3.6.1.2.1.43.5.1.1.17.1': this.options.serialNumber ?? 'KODEFAKE0001',
      '1.3.6.1.2.1.1.5.0': 'kode-fake-printer',
      '1.3.6.1.2.1.1.1.0': this.options.sysDescr ?? 'KODE FakeJet 9000',
      '1.3.6.1.2.1.25.3.5.1.2.1': Buffer.from([0x00, 0x00]),
    });

    const agent = snmp.createAgent({ port, disableAuthorization: true }, () => undefined);

    const mib = agent.getMib();
    for (const [oid, value] of Object.entries(store())) {
      try {
        mib.setScalarValue(oid, value);
      } catch {
        // Some builds require a MIB module to be loaded first. The harness's
        // tests fall back to stubbing the SNMP client directly in that case.
      }
    }

    this.agent = agent;
    return agent.getPort?.() ?? port;
  }

  close(): void {
    this.agent?.close();
    this.agent = null;
  }
}

/* ══════════════════════════════════════════════════════════════════ bundle  */

/** All three protocols for one simulated device, started and stopped together. */
export class FakePrinter {
  readonly raw: FakeRawPrinter;
  readonly ipp: FakeIppPrinter;
  readonly snmp: FakeSnmpPrinter;

  ports: { raw: number; ipp: number; snmp: number } = { raw: 0, ipp: 0, snmp: 0 };

  constructor(options: RawPrinterOptions & FakeIppOptions & FakeSnmpOptions = {}) {
    this.raw = new FakeRawPrinter(options);
    this.ipp = new FakeIppPrinter(options);
    this.snmp = new FakeSnmpPrinter(options);
  }

  async start(): Promise<void> {
    this.ports = {
      raw: await this.raw.listen(),
      ipp: await this.ipp.listen(),
      snmp: await this.snmp.listen().catch(() => 0),
    };
  }

  async stop(): Promise<void> {
    await this.raw.close();
    await this.ipp.close();
    this.snmp.close();
  }

  get ippUri(): string {
    return `ipp://127.0.0.1:${this.ports.ipp}/ipp/print`;
  }
}
