import type {
  ColorMode,
  JobSource,
  JobStatus,
  JobType,
  MediaSize,
  PrinterStatus,
  Role,
  ScanStatus,
  Severity,
  Sides,
  SnmpVersion,
  TransportPreference,
  TransportUsed,
} from './constants.js';

/**
 * API-facing entity shapes.
 *
 * These are DTOs, not database rows. Two differences are deliberate and
 * enforced by the model layer: field names are camelCase where the database is
 * snake_case, and secret-bearing columns (`password_hash`, `snmp_community`,
 * `api_key_hash`, `token_hash`) have no representation here at all. INV-08 is
 * easier to keep when the type system has no slot to put a secret in.
 */

/** ISO-8601 UTC. INV-10: local time exists only in the presentation layer. */
export type IsoTimestamp = string;

export interface Zone {
  id: number;
  /** Short token used in reports: RECEP, POOL, ACAD. */
  code: string;
  label: string;
  isActive: boolean;
  /** Denormalised for the zone picker; absent on write paths. */
  printerCount?: number;
  createdAt: IsoTimestamp;
}

/**
 * Capability record produced by the probe (§B7.3).
 *
 * `probedVia: 'none'` is not the same as an empty object: it means we asked and
 * got no answer, and the UI must then present print options as *unverified*
 * rather than implying they will take effect. Showing a duplex toggle that
 * silently does nothing is worse than not showing it.
 */
export interface PrinterCapabilities {
  ipp: {
    supported: boolean | null;
    versions: string[];
    uri: string | null;
  };
  formats: string[];
  sides: Sides[];
  colorModes: ColorMode[];
  maxCopies: number | null;
  media: string[];
  /**
   * `orientation-requested-supported` values (IPP enum: 3=portrait,
   * 4=landscape, 5=reverse-landscape, 6=reverse-portrait). Empty means the
   * device did not advertise the attribute at all — many PDF-only workflows
   * don't, since orientation is already baked into the document.
   */
  orientations: number[];
  probedVia: 'ipp' | 'snmp' | 'none';
  counters: {
    life: boolean;
    print: boolean;
    copy: boolean;
  };
  /** Set when an engineer confirmed these against the physical device. */
  verifiedAgainstHardware?: boolean;
}

export interface Printer {
  id: number;
  zoneId: number | null;
  zoneLabel: string | null;
  zoneCode: string | null;
  collectorId: number | null;
  name: string;
  /** Identity anchor. ADR-006. Null on devices that expose no serial. */
  serialNumber: string | null;
  macAddress: string | null;
  hostname: string | null;
  ipAddress: string;
  /**
   * Where the device physically is, e.g. "Reception", "Back office".
   * There is no `floor`: every KODE building is single-storey, so a floor field
   * would be a column of nulls that no report could use.
   */
  area: string | null;
  vendor: string | null;
  model: string | null;
  transport: TransportPreference;
  ippUri: string | null;
  capabilities: PrinterCapabilities;
  capabilitiesProbedAt: IsoTimestamp | null;
  snmpVersion: SnmpVersion;
  /** True when a community string is configured. The value itself never leaves the server. */
  snmpConfigured: boolean;
  lastPageCount: number | null;
  lastPageCountAt: IsoTimestamp | null;
  scanFolder: string | null;
  status: PrinterStatus;
  stateReasons: string[];
  consecutiveFailures: number;
  lastCheckedAt: IsoTimestamp | null;
  isActive: boolean;
  /** Operator-set "accept no new jobs" flag, for maintenance. */
  isDraining: boolean;
  /** Per-printer ceiling on impressions in a single job. Null uses the global default. */
  maxJobImpressions: number | null;
  /** Live supply levels where the device reports them, 0–100. */
  supplies: PrinterSupply[];
  /**
   * True when SNMP is disabled or unreachable, so walk-up activity for this
   * device is not tracked. §B8.5 — a known gap that is visible is a limitation;
   * a known gap that is invisible is a false report.
   */
  walkupTrackingUnavailable: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PrinterSupply {
  name: string;
  colorant: string | null;
  level: number | null;
  maxLevel: number | null;
  /**
   * What `level` counts — `percent`, `impressions`, `sheets`, … Null where the
   * device did not say. See `prtMarkerSuppliesSupplyUnit` and migration 004.
   */
  unit: string | null;
  /**
   * Percentage remaining, **only where the device reports one**.
   *
   * Null for a supply measured in a count, because `level / maxLevel` is then a
   * fraction of rated yield rather than the figure the device displays — a
   * Xerox toner reporting 260 pages of a 26,000-page cartridge gives 1% against
   * a machine showing 10%. Render `level` with `unit` instead of inventing one.
   */
  percent: number | null;
  /** Linear projection from recent consumption. Null until enough history exists. */
  estimatedDaysRemaining: number | null;
}

export interface User {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  /** Reporting only. INV-01: this MUST NOT influence access. */
  department: string | null;
  /**
   * Reporting / default-printer-picker hint only. Same INV-01 guarantee as
   * department: this MUST NOT influence access or what a user is permitted
   * to print to.
   */
  zoneId: number | null;
  /** 'local' or an external provider id once AD is wired in. */
  authProvider: string;
  mustChangePassword: boolean;
  lockedUntil: IsoTimestamp | null;
  lastLoginAt: IsoTimestamp | null;
  isActive: boolean;
  isSystem: boolean;
  /** False while an account exists but nobody has chosen a password for it yet. */
  hasPassword: boolean;
  /**
   * When the outstanding set-password link stops working, or null when there
   * is none. Drives the "waiting to set a password" list.
   */
  setupLinkExpiresAt: IsoTimestamp | null;
  printerIds?: number[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * A freshly minted set-password link.
 *
 * `url` is the whole thing an administrator copies. It is returned exactly
 * once — only the hash is stored — so a client that loses it must mint another.
 */
export interface SetupLink {
  url: string;
  purpose: 'setup' | 'reset';
  expiresAt: IsoTimestamp;
  user: { id: number; username: string; displayName: string | null };
}

/** What the set-password page may know before anyone has authenticated. */
export interface SetupLinkSubject {
  username: string;
  displayName: string | null;
  purpose: 'setup' | 'reset';
  expiresAt: IsoTimestamp;
}

export interface PrintOptions {
  copies: number;
  sides: Sides;
  colorMode: ColorMode;
  media: MediaSize;
  /** 1-based inclusive ranges, e.g. [[1,3],[7,7]]. Empty means the whole document. */
  pageRanges: Array<[number, number]>;
  orientation: 'portrait' | 'landscape';
  /** Stamps username and timestamp into a footer. For confidential documents. */
  watermark: boolean;
  /** Hold at the server until released from a phone at the device. */
  holdForRelease: boolean;
}

export interface Job {
  id: number;
  printerId: number | null;
  zoneId: number | null;
  userId: number | null;
  /** INV-06 — the record stays readable after the user or printer is removed. */
  usernameSnapshot: string;
  printerNameSnapshot: string;
  source: JobSource;
  jobType: JobType;
  status: JobStatus;
  pages: number;
  copies: number;
  /** What the print engine will actually mark. The ledger in §B8.3 depends on it. */
  impressions: number | null;
  colorMode: ColorMode | null;
  duplex: boolean | null;
  documentName: string | null;
  fileHash: string | null;
  printOptions: Partial<PrintOptions>;
  transportUsed: TransportUsed | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: IsoTimestamp | null;
  errorCode: string | null;
  notes: string | null;
  /** Set when the page count came from the unreliable byte-scan fallback. §B10.3. */
  pageCountEstimated: boolean;
  createdAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
}

export interface Scan {
  id: number;
  printerId: number | null;
  printerNameSnapshot: string;
  zoneId: number | null;
  /** Set once claimed, or auto-assigned by a scan-to-me reservation. */
  userId: number | null;
  usernameSnapshot: string | null;
  status: ScanStatus;
  originalFilename: string;
  storedFilename: string;
  sizeBytes: number;
  pageCount: number | null;
  contentType: string;
  /** How the owner was determined. 'reservation' is the scan-to-me path. */
  claimedVia: 'reservation' | 'manual' | null;
  scannedAt: IsoTimestamp;
  claimedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

export interface Notification {
  id: number;
  type: string;
  severity: Severity;
  printerId: number | null;
  printerName: string | null;
  jobId: number | null;
  message: string;
  payload: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: IsoTimestamp;
}

export interface AuditEntry {
  id: number;
  actorUserId: number | null;
  actorUsername: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  requestId: string | null;
  createdAt: IsoTimestamp;
}

export interface PrintTemplate {
  id: number;
  name: string;
  description: string | null;
  storedFilename: string;
  originalFilename: string;
  pageCount: number | null;
  defaultOptions: Partial<PrintOptions>;
  zoneId: number | null;
  isActive: boolean;
  timesUsed: number;
  createdAt: IsoTimestamp;
}

export interface Collector {
  id: number;
  name: string;
  zoneId: number | null;
  version: string | null;
  lastSeenAt: IsoTimestamp | null;
  isActive: boolean;
  /** Derived: three missed heartbeats. §B11.3. */
  isHealthy: boolean;
  createdAt: IsoTimestamp;
}

/** Runtime-editable configuration. Every change writes an audit row. */
export interface AppSettings {
  /** 0 means delete the original on a successful print. DEC-03. */
  uploadRetentionDays: number;
  scanRetentionDays: number;
  notificationRetentionDays: number;
  /** Refuse any single job above this many impressions. Printer safety. */
  maxJobImpressions: number;
  /** Warn the user above this before they can confirm. */
  largeJobWarnImpressions: number;
  maxConcurrentJobsPerPrinter: number;
  /** Seconds a printer must idle between jobs. Protects older fusers. */
  printerCooldownSeconds: number;
  costPerPageMono: number;
  costPerPageColor: number;
  currency: string;
  /** Grams of CO2e per impression, for the sustainability panel. */
  co2GramsPerImpression: number;
  emailEnabled: boolean;
  webPushEnabled: boolean;
  /** Minutes a scan-to-me reservation stays open. */
  scanReservationMinutes: number;
  /** DEC-06 — until vendor counters land, walk-up totals are "device activity". */
  walkupReportLabel: string;
}

/* ---------------------------------------------------------------- responses */

export interface Paginated<T> {
  items: T[];
  /** Opaque keyset cursor. Offset pagination is forbidden by §B5.4. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AuthTokens {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export interface LoginResult extends AuthTokens {
  user: User;
  mustChangePassword: boolean;
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail?: string;
  durationMs?: number;
}

export interface ReadinessReport {
  status: 'pass' | 'warn' | 'fail';
  version: string;
  uptimeSeconds: number;
  checks: HealthCheck[];
}

/* ------------------------------------------------------------- statistics  */

export interface UsageSummary {
  totalJobs: number;
  totalImpressions: number;
  colorImpressions: number;
  monoImpressions: number;
  duplexJobs: number;
  scanCount: number;
  estimatedCost: number;
  currency: string;
  co2Grams: number;
  /** Sheets saved by duplex, versus the same jobs printed one-sided. */
  sheetsSavedByDuplex: number;
  /**
   * True when any printer in the reported scope has walk-up tracking
   * unavailable. Reports carrying this MUST show a coverage note. §B8.5.
   */
  hasCoverageGap: boolean;
  /** Printers in scope whose activity is not tracked, by name. */
  coverageGapPrinters: string[];
  /**
   * True when any counted activity has job_type `unknown` — meaning photocopies
   * may be included. The label comes from settings.walkupReportLabel. DEC-06.
   */
  includesUntypedDeviceActivity: boolean;
}

export interface TimeSeriesPoint {
  bucket: IsoTimestamp;
  impressions: number;
  jobs: number;
  colorImpressions: number;
}

export interface LeaderboardRow {
  key: string;
  label: string;
  impressions: number;
  jobs: number;
  cost: number;
}

/* ------------------------------------------------------ server-sent events  */

export type ServerEvent =
  | { type: 'job.updated'; job: Job }
  | { type: 'printer.updated'; printer: Printer }
  | { type: 'notification.created'; notification: Notification }
  | { type: 'scan.created'; scan: Scan }
  | { type: 'queue.depth'; depth: number; oldestSeconds: number }
  | { type: 'heartbeat'; at: IsoTimestamp };
