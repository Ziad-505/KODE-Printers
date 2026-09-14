import ipp from 'ipp';
import {
  AppError,
  ippUriHost,
  isBlockingReason,
  isPrivateIpv4,
  stripReasonSuffix,
  type ColorMode,
  type MediaSize,
  type PrinterCapabilities,
  type PrinterStatus,
  type Sides,
} from '@kode/shared';
import { config } from '../../config/index.js';
import { subsystem } from '../../utilities/logger.js';

const log = subsystem('transport:ipp');

/**
 * IPP — the primary transport (ADR-001, §B6.3).
 *
 * What IPP buys over RAW/9100 is a *feedback channel*: the device reports
 * whether it accepted the job, how many impressions it actually marked, and why
 * it is unhappy. Two of the document's open gaps close on that alone — GAP-25
 * (status was reachability only) and GAP-24 (PJL option support unverified per
 * model) — because both are questions RAW structurally cannot answer.
 *
 * The library is wrapped rather than used directly so the byte-level code stays
 * behind one stable export (§A4). Swapping it touches this file and nothing
 * else.
 */

export const IPP_PORT = 631;

/**
 * The distinction this whole module turns on.
 *
 * §B6.2: "A protocol-level IPP failure demotes the printer to RAW permanently
 * until the next probe. A transient failure MUST NOT demote it: a printer that
 * is merely asleep is not a printer without IPP. Conflating the two is the most
 * likely defect in this section."
 *
 * So it is modelled explicitly in the type rather than inferred from an error
 * message at the call site.
 */
export type IppFailureKind = 'transient' | 'protocol' | 'rejected';

export class IppError extends Error {
  readonly kind: IppFailureKind;
  readonly statusCode: string | undefined;

  constructor(kind: IppFailureKind, message: string, statusCode?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'IppError';
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

/**
 * IPP status codes that mean "ask again later".
 *
 * `server-error-busy` and `server-error-temporary-error` are the device saying
 * it is occupied, not that it lacks IPP. Everything outside this set that is
 * still an error is treated as a protocol failure.
 */
const TRANSIENT_STATUS = new Set([
  'server-error-busy',
  'server-error-temporary-error',
  'server-error-service-unavailable',
  'server-error-job-canceled',
]);

/** Node error codes that mean the network, not the protocol, failed. */
const TRANSIENT_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

function classify(error: unknown, statusCode?: string): IppFailureKind {
  if (statusCode) {
    if (TRANSIENT_STATUS.has(statusCode)) return 'transient';
    if (statusCode.startsWith('client-error')) return 'rejected';
    return 'protocol';
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && TRANSIENT_ERRNO.has(code)) return 'transient';
  return 'protocol';
}

/**
 * Issues one IPP operation.
 *
 * The transport is driven here rather than through the library's own
 * `Printer.execute`, for a reason the fake-printer harness surfaced
 * immediately: the library parses the response inside an `IncomingMessage`
 * handler, so a body that is not IPP — an HTML page from a device that has a
 * web server on 631 and no IPP support, which is a common configuration —
 * makes its parser throw a `RangeError` **outside any promise**. That is an
 * uncaught exception, and it takes the process down.
 *
 * Owning the request means the body can be validated before it is handed to
 * the parser, and the parse itself can be wrapped. A device that answers on 631
 * with a login page now demotes cleanly to RAW/9100 instead of crashing the
 * server.
 */
async function execute(
  uri: string,
  operation: string,
  message: ipp.IppAttributes,
  timeoutMs: number,
): Promise<ipp.IppResponse> {
  const host = ippUriHost(uri);
  if (host === null || !isReachablePrinterHost(host)) {
    throw new IppError(
      'protocol',
      `refusing to contact ${host ?? 'an unparseable IPP URI'}: a printer must be on a private network address`,
    );
  }

  const target = new URL(uri.replace(/^ipps:/i, 'https:').replace(/^ipp:/i, 'http:'));
  if (!target.port) target.port = String(IPP_PORT);

  const operationId = OPERATION_IDS[operation];
  if (operationId === undefined)
    throw new IppError('protocol', `unknown IPP operation ${operation}`);

  let body: Buffer;
  try {
    body = ipp.serialize({ ...message, operation });
  } catch (error) {
    throw new IppError('protocol', `could not encode IPP ${operation}`, undefined, error);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(target.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/ipp', 'Content-Length': String(body.length) },
      body: new Uint8Array(body),
      signal: controller.signal,
    });
  } catch (error) {
    // An abort is our own timeout; anything else is a socket-level failure.
    // Both are transient — the device may simply be asleep, and §B6.2 is
    // explicit that this must not demote it.
    const aborted = (error as Error).name === 'AbortError';
    throw new IppError(
      aborted ? 'transient' : classify(error),
      aborted ? `IPP ${operation} to ${uri} timed out` : `IPP ${operation} failed`,
      undefined,
      error,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new IppError(
      response.status >= 500 ? 'transient' : 'protocol',
      `IPP ${operation} got HTTP ${response.status}`,
    );
  }

  const raw = Buffer.from(await response.arrayBuffer());

  /* The guard the harness demanded.
   *
   * An IPP response is at minimum a 8-byte header, and its first byte is the
   * major version — 1 or 2 in every version in the wild. An HTML page starts
   * with `<`, which is 0x3C, and feeding that to the parser is what produced
   * the crash. */
  const contentType = response.headers.get('content-type') ?? '';
  const looksLikeIpp = raw.length >= 8 && (raw[0] === 0x01 || raw[0] === 0x02);

  if (!looksLikeIpp || (contentType && !contentType.includes('ipp'))) {
    throw new IppError(
      'protocol',
      `${uri} answered on 631 but not with IPP (content-type "${contentType || 'none'}")`,
    );
  }

  let parsed: ipp.IppResponse;
  try {
    parsed = ipp.parse(raw);
  } catch (error) {
    // A truncated or malformed IPP body. Still a protocol failure, but now a
    // rejected promise rather than a process-ending throw.
    throw new IppError(
      'protocol',
      `could not parse the IPP response from ${uri}`,
      undefined,
      error,
    );
  }

    const status = parsed.statusCode;
  if (status && !status.startsWith('successful')) {
    const unsupported = parsed['unsupported-attributes-tag'];
const unsupportedEntries = unsupported ? Object.entries(unsupported) : [];
const detail =
  unsupportedEntries.length > 0
    ? ` (unsupported: ${unsupportedEntries
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(', ')})`
    : '';
    log.warn(
      { operation, status, unsupportedAttributes: unsupported ?? null },
      'IPP request rejected by device',
    );

    throw new IppError(classify(null, status), `IPP ${operation} returned ${status}${detail}`, status);
  }

  return parsed;
}
/**
 * The SSRF control, re-applied at the socket.
 *
 * `ippUriSchema` refuses a non-private host on the way in, but this URI can
 * also come from a row written before that rule existed or edited straight in
 * the database — and what happens next is an outbound POST to whatever it
 * names. A record that would turn the print path into a request forwarder is
 * refused here rather than dialled.
 *
 * Loopback is allowed outside production, and only there: the fake-printer
 * harness binds 127.0.0.1, and a test suite that cannot reach it is a test
 * suite nobody runs. In production loopback is the *worst* target to allow,
 * since it is where this application's own API listens.
 */
function isReachablePrinterHost(host: string): boolean {
  if (isPrivateIpv4(host)) return true;
  if (config.isProduction) return false;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Operation codes for the three operations §B6.3 names. */
const OPERATION_IDS: Readonly<Record<string, number>> = {
  'Print-Job': 0x0002,
  'Get-Job-Attributes': 0x0009,
  'Get-Printer-Attributes': 0x000b,
};

export function defaultIppUri(host: string): string {
  return `ipp://${host}:${IPP_PORT}/ipp/print`;
}

/* ------------------------------------------------------------------ probe  */

const SIDES_VALUES: readonly Sides[] = ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'];

/**
 * `Get-Printer-Attributes` (0x000B) — the capability probe.
 *
 * The result feeds `printers.capabilities`, which is what allows the UI to show
 * a duplex toggle only where duplex will actually happen. §B7.3 is emphatic
 * about the alternative: showing a control that silently does nothing is worse
 * than not showing it.
 */
export async function probeIpp(
  uri: string,
  timeoutMs = 8000,
): Promise<PrinterCapabilities & { makeAndModel: string | null }> {
  const response = await execute(
    uri,
    'Get-Printer-Attributes',
    {
      'operation-attributes-tag': {
        'attributes-charset': 'utf-8',
        'attributes-natural-language': 'en',
        'printer-uri': uri,
        'requested-attributes': [
          'printer-make-and-model',
          'printer-state',
          'printer-state-reasons',
          'ipp-versions-supported',
          'document-format-supported',
          'sides-supported',
          'print-color-mode-supported',
          'copies-supported',
          'media-supported',
          'color-supported',
          'orientation-requested-supported',
        ],
      },
    },
    timeoutMs,
  );

  const attrs = response['printer-attributes-tag'] ?? {};
  const asArray = (value: ipp.IppValue | undefined): string[] => {
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map(String);
  };

  const sidesSupported = asArray(attrs['sides-supported']).filter((value): value is Sides =>
    (SIDES_VALUES as readonly string[]).includes(value),
  );

  const colorModes = asArray(attrs['print-color-mode-supported'])
    .map((value): ColorMode | null =>
      value === 'color'
        ? 'color'
        : value === 'monochrome' || value === 'auto-monochrome'
          ? 'grayscale'
          : null,
    )
    .filter((value): value is ColorMode => value !== null);

    const orientations = asArray(attrs['orientation-requested-supported'])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));

  const copiesSupported = attrs['copies-supported'];
  const maxCopies =
    typeof copiesSupported === 'number'
      ? copiesSupported
      : Array.isArray(copiesSupported) && typeof copiesSupported.at(-1) === 'number'
        ? Number(copiesSupported.at(-1))
        : null;

  const makeAndModel = attrs['printer-make-and-model'];

   return {
    ipp: {
      supported: true,
      versions: asArray(attrs['ipp-versions-supported']),
      uri,
    },
    formats: asArray(attrs['document-format-supported']),
    sides: sidesSupported.length > 0 ? sidesSupported : ['one-sided'],
    colorModes: colorModes.length > 0 ? [...new Set(colorModes)] : ['grayscale'],
    maxCopies,
    media: asArray(attrs['media-supported']).slice(0, 40),
    orientations,
    probedVia: 'ipp',
    counters: { life: false, print: false, copy: false },
    makeAndModel: typeof makeAndModel === 'string' ? makeAndModel : null,
  };
}

/* ------------------------------------------------------------------- state */

export interface IppState {
  status: PrinterStatus;
  stateReasons: string[];
}

/**
 * Live device state — the thing RAW cannot report at all.
 *
 * IPP appends `-warning`, `-error` or `-report` to each reason, and that suffix
 * is kept. It used to be stripped here, on the reasoning that `toner-low-warning`
 * and a bare `toner-low` are the same condition. They are — but the suffix is
 * not a spelling of the condition, it is the device's own verdict on whether
 * the condition stops printing, and it is the only place that verdict exists.
 *
 * A WorkCentre 7835 with paper in tray 1 and empty trays 2–5 answers
 * `printer-state: idle` alongside three `media-empty-warning` entries, one per
 * empty tray. Stripped, those became `media-empty`, which is in
 * `BLOCKING_STATE_REASONS`, so the device was marked offline, raised a critical
 * alert, opened its circuit breaker and refused every job with "the paper tray
 * is empty" — while standing idle with paper in it.
 *
 * Duplicates are collapsed because the count is per-subunit and the fleet board
 * shows a condition, not a tally: nine reasons from a 7835 are four distinct
 * ones. `plain.ts` strips the suffix for display; `isBlockingReason` reads it.
 */
export async function readIppState(uri: string, timeoutMs = 5000): Promise<IppState> {
  const response = await execute(
    uri,
    'Get-Printer-Attributes',
    {
      'operation-attributes-tag': {
        'attributes-charset': 'utf-8',
        'attributes-natural-language': 'en',
        'printer-uri': uri,
        'requested-attributes': ['printer-state', 'printer-state-reasons'],
      },
    },
    timeoutMs,
  );

  const attrs = response['printer-attributes-tag'] ?? {};
  const raw = attrs['printer-state-reasons'];
  const reasons = [
    ...new Set(
      (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
        .map(String)
        .filter((reason) => stripReasonSuffix(reason) !== 'none'),
    ),
  ];

  const printerState = attrs['printer-state'];
  const blocked = reasons.some(isBlockingReason);

  // `printer-state` 3 = idle, 4 = processing, 5 = stopped.
  const stopped = printerState === 5 || printerState === 'stopped';

  /* `stopped` is authoritative, `blocked` is corroborating.
   *
   * A device that says it is stopped is stopped whatever its reasons say. The
   * converse does not hold: an `-error` reason on a printer reporting `idle`
   * is a subunit fault the engine is working around, so it degrades rather
   * than going offline, and the dispatch gate still holds jobs on it. */
  return {
    status: stopped || blocked ? 'offline' : reasons.length > 0 ? 'degraded' : 'online',
    stateReasons: reasons,
  };
}

/* -------------------------------------------------------------------- send */

export interface IppSendOptions {
  uri: string;
  document: Buffer;
  documentFormat: string;
  jobName: string;
  username: string;
  copies: number;
  sides: Sides;
  colorMode: ColorMode;
  media: MediaSize;
  orientation: 'portrait' | 'landscape';
  timeoutMs?: number;
}

export interface IppSendResult {
  jobUri: string | null;
  jobId: number | null;
  jobState: string | null;
}

/**
 * `Print-Job` (0x0002).
 *
 * Options travel as standard IPP job attributes rather than as PJL text, which
 * is the substantive difference: the device either supports `sides` or reports
 * that it does not, instead of silently ignoring a line it did not understand.
 */
export async function sendIpp(options: IppSendOptions): Promise<IppSendResult> {
  const jobAttributes: Record<string, ipp.IppValue> = {
    copies: Math.max(1, Math.min(999, Math.round(options.copies))),
    sides: options.sides,
    'print-color-mode': options.colorMode === 'color' ? 'color' : 'monochrome',
    media: options.media,
    'orientation-requested': options.orientation === 'landscape' ? 4 : 3,
  };

  // `page-ranges` is deliberately NOT sent here. `prepare.ts#selectPages` has
  // already cut `options.document` down to exactly the wanted pages before it
  // reaches this function, so `options.pageRanges` describes page numbers in
  // the *original* upload, not this (already-trimmed) buffer. Re-applying it
  // as an IPP attribute asks the device to select page 3 out of a document
  // that is now one page long — which a device either rejects outright
  // (`client-error-attributes-or-values-not-supported`) or silently
  // misinterprets. The impression count also has to come from what we
  // physically sent, not from a range the device applied itself (see the
  // comment on `selectPages`), which is the same reason it must not be
  // re-declared here.

  const response = await execute(
    options.uri,
    'Print-Job',
    {
      'operation-attributes-tag': {
        'attributes-charset': 'utf-8',
        'attributes-natural-language': 'en',
        'printer-uri': options.uri,
        'requesting-user-name': options.username.slice(0, 60),
        'job-name': options.jobName.slice(0, 120),
        'document-format': options.documentFormat,
      },
      'job-attributes-tag': jobAttributes,
      data: options.document,
    },
    options.timeoutMs ?? 120_000,
  );

  const job = response['job-attributes-tag'] ?? {};
  const jobUri = job['job-uri'];
  const jobId = job['job-id'];
  const jobState = job['job-state'];

  log.debug({ uri: options.uri, jobId, jobState }, 'IPP job accepted');

  return {
    jobUri: typeof jobUri === 'string' ? jobUri : null,
    jobId: typeof jobId === 'number' ? jobId : null,
    jobState: jobState === undefined ? null : String(jobState),
  };
}

/* --------------------------------------------------------- job completion  */

export interface IppJobStatus {
  state: string;
  impressionsCompleted: number | null;
  isTerminal: boolean;
}

/**
 * `Get-Job-Attributes` (0x0009).
 *
 * `job-impressions-completed` is the payoff: the device's own count of what it
 * actually marked. Where it is available the impression ledger reconciles
 * against a measured figure rather than a computed estimate, which removes the
 * last source of drift in walk-up attribution.
 */
export async function readJobStatus(
  printerUri: string,
  jobId: number,
  timeoutMs = 5000,
): Promise<IppJobStatus> {
  const response = await execute(
    printerUri,
    'Get-Job-Attributes',
    {
      'operation-attributes-tag': {
        'attributes-charset': 'utf-8',
        'attributes-natural-language': 'en',
        'printer-uri': printerUri,
        'job-id': jobId,
        'requested-attributes': ['job-state', 'job-state-reasons', 'job-impressions-completed'],
      },
    },
    timeoutMs,
  );

  const job = response['job-attributes-tag'] ?? {};
  const state = String(job['job-state'] ?? 'unknown');
  const completed = job['job-impressions-completed'];

  return {
    state,
    impressionsCompleted: typeof completed === 'number' ? completed : null,
    isTerminal: ['completed', 'canceled', 'aborted', '9', '7', '8'].includes(state),
  };
}

/** Translates an IppError into the API error taxonomy at the service boundary. */
export function toAppError(error: unknown, printerId: number): AppError {
  if (error instanceof IppError) {
    return new AppError('PRINTER_UNREACHABLE', 'The printer did not accept the job over IPP.', {
      details: { printerId, transport: 'ipp', kind: error.kind },
      retryable: error.kind === 'transient',
      cause: error,
    });
  }
  return new AppError('PRINTER_UNREACHABLE', 'The printer did not accept the job.', {
    details: { printerId, transport: 'ipp' },
    retryable: true,
    cause: error,
  });
}

