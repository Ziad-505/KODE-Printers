/**
 * Enumerations shared by the database CHECK constraints, the API validators and
 * the client. Defined once so a value can never be legal in one layer and
 * rejected in another.
 */

export const ROLES = ['admin', 'user'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Deliberately two roles. §B12.1 considered and rejected a third: at club scale
 * it adds a permission matrix to maintain without a real separation of duty.
 */

export const PRINTER_STATUSES = ['online', 'offline', 'degraded', 'unknown'] as const;
export type PrinterStatus = (typeof PRINTER_STATUSES)[number];

export const TRANSPORTS = ['auto', 'ipp', 'raw9100'] as const;
export type TransportPreference = (typeof TRANSPORTS)[number];

export const TRANSPORTS_USED = ['ipp', 'raw9100'] as const;
export type TransportUsed = (typeof TRANSPORTS_USED)[number];

export const SNMP_VERSIONS = ['1', '2c', '3', 'disabled'] as const;
export type SnmpVersion = (typeof SNMP_VERSIONS)[number];

export const JOB_SOURCES = ['app', 'walkup', 'manual'] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

/**
 * `unknown` is load-bearing, not a placeholder. §B8.4: a device without vendor
 * print/copy counters cannot distinguish a print from a photocopy, and
 * recording such an event as `print` is the measurement flaw the document calls
 * out in A7.1. Reports MUST label these "device activity".
 */
export const JOB_TYPES = ['print', 'scan', 'copy', 'fax', 'unknown'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  'queued',
  'held', // awaiting release at the device — the hold-and-release feature
  'processing',
  'sent',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses from which no further transition happens. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

export const COLOR_MODES = ['color', 'grayscale'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const SIDES = ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'] as const;
export type Sides = (typeof SIDES)[number];

export const MEDIA_SIZES = [
  'iso_a4_210x297mm',
  'iso_a3_297x420mm',
  'iso_a5_148x210mm',
  'na_letter_8.5x11in',
  'na_legal_8.5x14in',
] as const;
export type MediaSize = (typeof MEDIA_SIZES)[number];

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SCAN_STATUSES = ['unclaimed', 'claimed', 'archived'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/**
 * IPP `printer-state-reasons` values mapped to our three-state model. The keys
 * are the IPP keywords with any `-report`/`-warning`/`-error` suffix stripped.
 * §B7.4.
 */
export const STATE_REASON_SEVERITY: Readonly<Record<string, Severity>> = {
  none: 'info',
  'toner-low': 'warning',
  'marker-supply-low': 'warning',
  'media-low': 'warning',
  'developer-low': 'warning',
  'opc-life-over': 'warning',
  'input-tray-empty': 'warning',
  'output-tray-missing': 'warning',
  'output-area-almost-full': 'warning',
  'overdue-prevent-maint': 'warning',
  'subunit-recoverable-failure': 'warning',
  'subunit-unrecoverable-failure': 'warning',
  'marker-supply-missing': 'critical',
  'toner-empty': 'critical',
  'marker-supply-empty': 'critical',
  'media-empty': 'critical',
  'media-jam': 'critical',
  jam: 'critical',
  'door-open': 'critical',
  'cover-open': 'critical',
  'input-tray-missing': 'critical',
  'output-area-full': 'critical',
  shutdown: 'critical',
  offline: 'critical',
  paused: 'critical',
  'service-request': 'critical',
} as const;

/* ------------------------------------------------- state-reason severities */

/**
 * The `-report` / `-warning` / `-error` suffix RFC 8011 §5.4.12 appends to every
 * `printer-state-reasons` keyword.
 *
 * The suffix *is* the severity, and dropping it is not a normalisation — it is
 * the loss of the only field that says whether the condition stops printing.
 *
 * A Xerox WorkCentre 7835 with paper in tray 1 and empty trays 2–5 reports
 * `media-empty-warning` three times while `printer-state` stays `idle`: a
 * per-tray notice from a device that is ready to print. Strip the suffix and it
 * becomes `media-empty`, which the dispatch gate refuses on — so every job to a
 * working printer was held, retried and held again, and the fleet board showed
 * a critical "not reachable" alert for a device sitting idle.
 *
 * So the suffix is carried through storage and stripped only for display.
 */
export const REASON_SUFFIX_PATTERN = /-(?:report|warning|error)$/;

export type ReasonSeverity = 'report' | 'warning' | 'error';

/** The bare keyword, for display and for severity lookup. */
export function stripReasonSuffix(reason: string): string {
  return reason.replace(REASON_SUFFIX_PATTERN, '');
}

/**
 * The severity the device declared, or null where it declared none.
 *
 * Null is not "fine". SNMP's `hrPrinterDetectedErrorState` carries no severity
 * at all, and `device-mismatch` is ours rather than the device's, so an absent
 * suffix has to fall back to the keyword's own meaning — see `isBlockingReason`.
 */
export function reasonSeverity(reason: string): ReasonSeverity | null {
  const match = REASON_SUFFIX_PATTERN.exec(reason);
  return match === null ? null : (match[0].slice(1) as ReasonSeverity);
}

/**
 * Whether a reason means "hold the job".
 *
 * The device's own severity wins where it gave one: a `-warning` or `-report`
 * never blocks, however alarming the keyword reads. Only an `-error`, or a bare
 * keyword from a source that cannot express severity, is checked against
 * `BLOCKING_STATE_REASONS`.
 */
export function isBlockingReason(reason: string): boolean {
  const severity = reasonSeverity(reason);
  if (severity === 'warning' || severity === 'report') return false;
  return BLOCKING_STATE_REASONS.has(stripReasonSuffix(reason));
}

/** The blocking subset of a device's reasons, suffixes intact. */
export function blockingReasons(reasons: readonly string[]): string[] {
  return reasons.filter(isBlockingReason);
}

/**
 * Reasons that mean "do not send anything to this device right now".
 *
 * This is the core of the printer-safety promise: a job destined for a jammed
 * or empty device is held, not fired into the void where it becomes a paper
 * spill or a silent loss.
 */
export const BLOCKING_STATE_REASONS: ReadonlySet<string> = new Set([
  'media-jam',
  'jam',
  'media-empty',
  'toner-empty',
  'marker-supply-empty',
  'door-open',
  'cover-open',
  'input-tray-missing',
  'output-area-full',
  'shutdown',
  'offline',
  'service-request',
  /**
   * Not a device state: this one is raised by `reconcileIdentity` when the
   * serial number at a printer's address stops matching the record (ADR-006).
   *
   * It belongs here because the consequence is worse than a jam. §B7.1 already
   * stops *polling* a mismatched device, on the grounds that absorbing another
   * unit's counters corrupts the audit trail. Sending to one is the same
   * mistake pointed the other way: the address now answers for a machine
   * nobody has identified, possibly in a different building or a different
   * organisation, and the document goes to whoever is standing next to it.
   * Holding the job until an administrator confirms what is physically there
   * costs a delay; not holding it costs a confidentiality breach.
   */
  'device-mismatch',
]);

export const AUDIT_ACTIONS = [
  'user.create',
  'user.update',
  'user.deactivate',
  'user.password_set',
  /** An administrator minted a set-password or reset link. */
  'user.setup_link',
  /** Someone redeemed one and chose their own password. */
  'user.password_chosen',
  'user.printers_set',
  'printer.create',
  'printer.update',
  'printer.deactivate',
  'printer.delete',
  'printer.probe',
  'printer.drain',
  'zone.create',
  'zone.update',
  'collector.create',
  'collector.revoke',
  'settings.update',
  'template.create',
  'template.update',
  'template.delete',
  'auth.login_success',
  'auth.login_failure',
  'auth.logout_all',
  'auth.token_reuse',
  'job.cancel',
  'job.retry',
  'job.release',
  /** An administrator recording activity the system could not observe. §B8.5. */
  'job.manual_entry',
  'scan.claim',
  'scan.delete',
  'retention.purge',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Upload allow-list. Re-verified against magic bytes before any byte is used. §B10.2. */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  'pdf',
  'txt',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'rtf',
  'csv',
  'png',
  'jpg',
  'jpeg',
] as const;
export type AllowedExtension = (typeof ALLOWED_UPLOAD_EXTENSIONS)[number];

export const PAGINATION = {
  defaultLimit: 50,
  maxLimit: 200,
  /** §B5.4 — an export wider than this is a memory-exhaustion vector. */
  maxExportRangeDays: 366,
} as const;
