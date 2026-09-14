/**
 * The error taxonomy from KODE-TECH-0005 §B5.3, plus the codes the additional
 * feature bundles required.
 *
 * Two rules govern this file, both from the invariants:
 *   INV-12 — stack traces and driver-level text never reach a response body.
 *   B5.2   — every non-2xx body matches {@link ApiErrorBody} exactly.
 *
 * The way both are guaranteed is that `AppError` is the *only* thing the error
 * handler will render. Anything else that reaches it becomes INTERNAL_ERROR with
 * the detail confined to the log.
 */

export const ERROR_CODES = {
  // Validation and input
  VALIDATION_FAILED: 400,
  FILE_TYPE_REJECTED: 400,
  FILE_CORRUPT: 400,
  PJL_INJECTION_REJECTED: 400,
  FILE_TOO_LARGE: 413,

  // Authentication and authorisation
  UNAUTHENTICATED: 401,
  TOKEN_REUSE_DETECTED: 401,
  CREDENTIALS_INVALID: 401,
  ACCOUNT_LOCKED: 423,
  PASSWORD_CHANGE_REQUIRED: 403,
  PASSWORD_POLICY_VIOLATION: 400,
  /** A set-password link that is unknown, already used, or past its expiry. */
  SETUP_LINK_INVALID: 410,
  FORBIDDEN: 403,

  // Resources
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRINTER_INACTIVE: 409,
  PRINTER_HAS_HISTORY: 409,
  DUPLICATE_SUBMISSION: 409,

  // Printer-safety refusals (see services/transport/safety.ts)
  PRINTER_NOT_READY: 409,
  PRINTER_BUSY: 429,
  JOB_TOO_LARGE: 409,
  PRINTER_CIRCUIT_OPEN: 503,

  // Rate limiting
  RATE_LIMITED: 429,

  // Upstream and processing
  PRINTER_UNREACHABLE: 502,
  CONVERSION_FAILED: 502,
  CONVERSION_TIMEOUT: 504,
  DEPENDENCY_UNAVAILABLE: 503,

  // Catch-all
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Machine-readable details. Never contains a stack, a SQL string or a secret. */
export type ErrorDetails = Record<string, string | number | boolean | null | string[]>;

/** The exact shape of every non-2xx response body. §B5.2. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetails;
    /** Join key between a user's complaint and the logs. Also in `X-Request-Id`. */
    requestId: string;
  };
}

export interface AppErrorOptions {
  details?: ErrorDetails;
  /** Underlying failure. Logged, never serialised to the client. */
  cause?: unknown;
  /**
   * Whether a retry could plausibly succeed. The queue worker reads this to
   * decide between backoff and permanent failure (§B10.4) — getting it wrong is
   * how a printer that is merely asleep gets permanently demoted.
   */
  retryable?: boolean;
  /** Seconds, for 429 responses. Rendered into the `Retry-After` header. */
  retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = options.details;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
    this.retryAfterSeconds = options.retryAfterSeconds;
    // Node's types declare this unconditionally, but @kode/shared also runs in
    // the browser, where it does not exist.
    Error.captureStackTrace?.(this, AppError);
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        requestId,
      },
    };
  }
}

/**
 * Codes whose default is "a retry might work".
 *
 * Everything absent from this set defaults to permanent, which is the safe
 * direction: retrying a rejected file type forever is worse than failing a
 * transient error once.
 */
const DEFAULT_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'PRINTER_UNREACHABLE',
  'PRINTER_NOT_READY',
  'PRINTER_BUSY',
  'PRINTER_CIRCUIT_OPEN',
  'CONVERSION_TIMEOUT',
  'DEPENDENCY_UNAVAILABLE',
]);

export const isAppError = (value: unknown): value is AppError =>
  value instanceof AppError ||
  (typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'status' in value &&
    (value as { name?: unknown }).name === 'AppError');

/* Constructors for the codes raised from more than one place, so the message
 * a user sees for a given failure is identical wherever it originates. */

export const errors = {
  unauthenticated: (message = 'Sign in to continue.') => new AppError('UNAUTHENTICATED', message),

  forbidden: (message = 'You do not have access to this.') => new AppError('FORBIDDEN', message),

  notFound: (entity: string, id?: string | number) =>
    new AppError('NOT_FOUND', `${entity} not found.`, {
      ...(id === undefined ? {} : { details: { id: String(id) } }),
    }),

  validation: (message: string, details?: ErrorDetails) =>
    new AppError('VALIDATION_FAILED', message, { ...(details ? { details } : {}) }),

  printerUnreachable: (printerId: number, transport: string, cause?: unknown) =>
    new AppError('PRINTER_UNREACHABLE', 'The printer did not accept the connection.', {
      details: { printerId, transport },
      retryable: true,
      ...(cause === undefined ? {} : { cause }),
    }),

  printerInactive: (printerId: number) =>
    new AppError('PRINTER_INACTIVE', 'This printer has been disabled.', {
      details: { printerId },
    }),

  internal: (cause?: unknown) =>
    new AppError('INTERNAL_ERROR', 'Something went wrong on our side.', {
      ...(cause === undefined ? {} : { cause }),
    }),
} as const;
