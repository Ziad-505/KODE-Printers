import { z } from 'zod';
import {
  COLOR_MODES,
  JOB_SOURCES,
  JOB_STATUSES,
  JOB_TYPES,
  MEDIA_SIZES,
  PAGINATION,
  ROLES,
  SEVERITIES,
  SIDES,
  SNMP_VERSIONS,
  TRANSPORTS,
} from './constants.js';

/**
 * The single definition of every request shape.
 *
 * The server validates with these and the web client drives its forms from the
 * same objects, so a rule such as "a page range cannot end before it starts"
 * is stated once and cannot drift between the two.
 */

/* ------------------------------------------------------------- primitives  */

export const idSchema = z.coerce.number().int().positive();

export const isoDateSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'));

/**
 * Characters that must never survive into stored text: C0/C1 controls, the
 * zero-width set, and the bidirectional overrides.
 *
 * The last group is the one that matters. A right-to-left override embedded in
 * a filename makes "invoice.exe" render as "invoice.txt" in the job list —
 * a spoofing vector rather than a cosmetic problem.
 *
 * Stripped rather than rejected: printer firmware and Office metadata emit
 * these routinely, and failing an upload over an invisible byte helps nobody.
 * Arabic, accented Latin and CJK pass through untouched — the UI is English,
 * the documents are not.
 */

const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex -- matching control bytes is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export const safeTextSchema = (max: number, label = 'Value') =>
  z
    .string()
    .transform((value) => value.replace(CONTROL_CHARS, '').trim())
    .pipe(z.string().min(1, `${label} is required.`).max(max, `${label} is too long.`));

export const optionalTextSchema = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(CONTROL_CHARS, '').trim())
    .pipe(z.string().max(max))
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * A printer address must parse as IPv4 **and** sit in a private range.
 *
 * This is the A10/SSRF control from §B16.4 expressed where it cannot be
 * forgotten. Without it an admin — or anyone who reached an admin session —
 * could point a "printer" at an internal service and use the print path as a
 * blind request forwarder. The club's estate is entirely RFC1918, so the
 * restriction costs nothing operationally.
 */
export const privateIpv4Schema = z
  .string()
  .trim()
  .refine((value) => IPV4.test(value), 'Enter a valid IPv4 address.')
  .refine((value) => {
    const parts = value.split('.').map(Number);
    return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  }, 'Each part of the address must be between 0 and 255.')
  .refine((value) => isPrivateIpv4(value), 'Printers must be on a private network address.');

export function isPrivateIpv4(value: string): boolean {
  const match = IPV4.exec(value);
  if (!match) return false;
  // `Number()` of a captured group is always a number; NaN is the only failure
  // mode, and it is what a missing group produces.
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local, seen on freshly racked devices
  return false;
}

/**
 * An IPP URI that can only address a printer on the club network.
 *
 * `privateIpv4Schema` confines `ipAddress` to RFC1918 as the A10/SSRF control
 * from §B16.4, and the transport then dials `ippUri` instead whenever one is
 * set — so validating only the address left the control with a way around it.
 * The transport rewrites `ipp://` to `http://` and POSTs to it, which turns a
 * printer record into a request forwarder aimed at anything the server can
 * reach.
 *
 * The host must therefore be a private IPv4 literal here too. A hostname is
 * refused rather than resolved: what a name resolves to at validation time is
 * not what it resolves to at send time, and this schema also runs in a browser
 * where there is nothing to resolve with.
 */
export const ippUriSchema = z
  .string()
  .trim()
  .max(500)
  .regex(/^ipps?:\/\//i, 'An IPP URI starts with ipp:// or ipps://')
  .refine((value) => ippUriHost(value) !== null, 'That is not a valid IPP URI.')
  .refine(
    (value) => isPrivateIpv4(ippUriHost(value) ?? ''),
    'An IPP URI must address a printer by private IPv4 address, for example ipp://10.0.4.12/ipp/print.',
  );

/**
 * The hostname inside an IPP URI, or null when it will not parse.
 *
 * Exported because the transport re-checks it immediately before dialling: a
 * row written before this rule existed, or edited straight in the database,
 * must not reach the socket either.
 */
export function ippUriHost(value: string): string | null {
  try {
    // `URL` does not know the ipp scheme well enough to expose a host, so it is
    // swapped for one it does. The port and path are irrelevant to this check.
    const url = new URL(value.replace(/^ipps:/i, 'https:').replace(/^ipp:/i, 'http:'));
    return url.hostname === '' ? null : url.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * A dotted OID. Validated because these values are read from the database and
 * handed to the SNMP layer; a malformed one should fail at the edge with a
 * clear message rather than deep inside a BER encoder.
 */
export const oidSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+){3,}$/, 'Enter a valid dotted OID, for example 1.3.6.1.2.1.43.10.2.1.4.1.1');

/* ----------------------------------------------------------------- paging  */

export const paginationSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).default(PAGINATION.defaultLimit),
});

export const sortDirectionSchema = z.enum(['asc', 'desc']).default('desc');

/* ------------------------------------------------------------------- auth  */

/**
 * §B12.4 (GAP-18): minimum length 12. Length is the only rule that reliably
 * buys entropy; character-class requirements mostly produce `Password1!` and a
 * sticky note, so they are not imposed. A breached-password denylist check runs
 * server-side in addition to this.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'That is longer than we can store.')
  .refine((v) => v.trim().length >= 12, 'Spaces alone do not count towards the length.');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Usernames need at least 2 characters.')
  .max(64)
  .regex(/^[a-z0-9._-]+$/, 'Use letters, numbers, dots, underscores and hyphens only.');

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, 'Enter your password.').max(200),
  /** Opt-in longer refresh lifetime on a personal device. */
  rememberMe: z.boolean().default(false),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'The two passwords do not match.',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'Choose a password you have not used here before.',
    path: ['newPassword'],
  });

/* ------------------------------------------------------------------ zones  */

export const zoneCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(12)
    .regex(/^[A-Z0-9-]+$/, 'Use capital letters, numbers and hyphens.'),
  label: safeTextSchema(120, 'Zone label'),
  isActive: z.boolean().default(true),
});

export const zoneUpdateSchema = zoneCreateSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update.');

/* --------------------------------------------------------------- printers  */

export const printerCreateSchema = z.object({
  name: safeTextSchema(120, 'Printer name'),
  ipAddress: privateIpv4Schema,
  zoneId: idSchema.nullable().optional(),
  /** No `floor`: every KODE building is single-storey. */
  area: optionalTextSchema(120),
  hostname: optionalTextSchema(253),
  transport: z.enum(TRANSPORTS).default('auto'),
  ippUri: ippUriSchema.nullable().optional(),
  snmpVersion: z.enum(SNMP_VERSIONS).default('2c'),
  /** Write-only. Never returned by any read path. INV-08. */
  snmpCommunity: z.string().max(200).nullable().optional(),
  snmpUsername: z.string().max(120).nullable().optional(),
  snmpAuthKey: z.string().max(200).nullable().optional(),
  snmpPrivKey: z.string().max(200).nullable().optional(),
  snmpPageOid: oidSchema.default('1.3.6.1.2.1.43.10.2.1.4.1.1'),
  snmpPrintOid: oidSchema.nullable().optional(),
  snmpCopyOid: oidSchema.nullable().optional(),
  scanFolder: optionalTextSchema(500),
  maxJobImpressions: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  /** Run the capability probe immediately after creation. */
  probeNow: z.boolean().default(true),
});

export const printerUpdateSchema = printerCreateSchema
  .omit({ probeNow: true })
  .partial()
  .extend({
    isActive: z.boolean().optional(),
    isDraining: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update.');

export const printerQuerySchema = paginationSchema.extend({
  zoneId: idSchema.optional(),
  status: z.enum(['online', 'offline', 'degraded', 'unknown']).optional(),
  search: z.string().trim().max(120).optional(),
  includeInactive: z.coerce.boolean().default(false),
});

/* ------------------------------------------------------------ print options */

const pageRangeSchema = z
  .tuple([z.number().int().min(1).max(10_000), z.number().int().min(1).max(10_000)])
  .refine(([from, to]) => from <= to, 'A page range cannot end before it starts.');

export const printOptionsSchema = z.object({
  copies: z.coerce.number().int().min(1).max(999).default(1),
  sides: z.enum(SIDES).default('one-sided'),
  colorMode: z.enum(COLOR_MODES).default('grayscale'),
  media: z.enum(MEDIA_SIZES).default('iso_a4_210x297mm'),
  pageRanges: z.array(pageRangeSchema).max(50).default([]),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  watermark: z.boolean().default(false),
  holdForRelease: z.boolean().default(false),
});

/**
 * Multipart bodies arrive as strings. This accepts the JSON-encoded option blob
 * the client sends alongside the file and validates it with the same schema, so
 * there is no second, laxer parser on the upload path.
 */
export const printOptionsFromFormSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value) return {};
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Print options were not valid JSON.' });
      return z.NEVER;
    }
  })
  .pipe(printOptionsSchema);

/** Grayscale is the default everywhere: colour costs roughly ten times as much. */
export const printSubmitSchema = z.object({
  options: printOptionsSchema,
  /** Set by the client after the user acknowledges a large-job warning. */
  confirmLargeJob: z.boolean().default(false),
});

/* ------------------------------------------------------------------- jobs  */

export const jobQuerySchema = paginationSchema.extend({
  printerId: idSchema.optional(),
  zoneId: idSchema.optional(),
  userId: idSchema.optional(),
  status: z.enum(JOB_STATUSES).optional(),
  source: z.enum(JOB_SOURCES).optional(),
  jobType: z.enum(JOB_TYPES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  search: z.string().trim().max(120).optional(),
});

/**
 * §B5.4 — an export MUST carry an explicit range no wider than 366 days.
 * Unbounded exports are both a slow query and a memory-exhaustion vector.
 */
export const jobExportSchema = jobQuerySchema
  .omit({ cursor: true, limit: true })
  .extend({
    from: isoDateSchema,
    to: isoDateSchema,
    format: z.enum(['csv', 'xlsx']).default('csv'),
  })
  .refine((v) => new Date(v.from) <= new Date(v.to), {
    message: 'The start date must fall before the end date.',
    path: ['from'],
  })
  .refine(
    (v) => {
      const span = new Date(v.to).getTime() - new Date(v.from).getTime();
      return span <= PAGINATION.maxExportRangeDays * 86_400_000;
    },
    { message: `Exports cover at most ${PAGINATION.maxExportRangeDays} days.`, path: ['to'] },
  );

/** Admin-entered record of activity the system could not observe. */
export const manualJobSchema = z.object({
  printerId: idSchema,
  userId: idSchema.nullable().optional(),
  jobType: z.enum(JOB_TYPES).default('print'),
  pages: z.coerce.number().int().min(1).max(100_000),
  copies: z.coerce.number().int().min(1).max(999).default(1),
  documentName: optionalTextSchema(300),
  notes: safeTextSchema(1000, 'Reason'),
});

/* ------------------------------------------------------------------ users  */

/**
 * Creating an account no longer asks for a password.
 *
 * An administrator who types one has to transmit it, and the only channels
 * available are the ones this system cannot audit. The account is created
 * without a password and a single-use link is minted instead; the person
 * chooses their own. `password` remains accepted so an operator can still set
 * one deliberately, but nothing in the interface asks for it.
 */
export const userCreateSchema = z.object({
  username: usernameSchema,
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address.')
    .nullable()
    .optional(),
  displayName: optionalTextSchema(120),
  password: passwordSchema.optional(),
  role: z.enum(ROLES).default('user'),
  department: optionalTextSchema(120),
  printerIds: z.array(idSchema).max(200).default([]),
  /** Forces a rotation at first sign-in when a password *was* supplied. */
  mustChangePassword: z.boolean().default(true),
});

/** Which kind of link an administrator is minting. */
export const setupLinkSchema = z.object({
  purpose: z.enum(['setup', 'reset']).default('setup'),
});

/**
 * Redeeming a link. The token arrives from the URL rather than from a form,
 * so it is validated for shape here before it is used to look anything up.
 */
export const redeemSetupLinkSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(20, 'That link is not complete.')
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/, 'That link is not valid.'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'The two passwords do not match.',
    path: ['confirmPassword'],
  });

export const userUpdateSchema = userCreateSchema
  .omit({ password: true, username: true, printerIds: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update.');

export const setUserPasswordSchema = z.object({
  password: passwordSchema,
  mustChangePassword: z.boolean().default(true),
});

/** The only write path to user_printers. INV-01. */
export const setUserPrintersSchema = z.object({
  printerIds: z.array(idSchema).max(200),
});

export const userQuerySchema = paginationSchema.extend({
  role: z.enum(ROLES).optional(),
  search: z.string().trim().max(120).optional(),
  includeInactive: z.coerce.boolean().default(false),
});

/* ------------------------------------------------------------------ scans  */

export const scanQuerySchema = paginationSchema.extend({
  printerId: idSchema.optional(),
  status: z.enum(['unclaimed', 'claimed', 'archived']).optional(),
  mine: z.coerce.boolean().default(false),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

/**
 * Scan-to-me. The user declares intent at a printer, then walks over and
 * scans; the watcher assigns the next arrival from that device to them.
 */
export const scanReservationSchema = z.object({
  printerId: idSchema,
});

export const scanClaimSchema = z.object({
  /** Admins may assign a scan to someone else; users may only claim their own. */
  userId: idSchema.optional(),
});

/* -------------------------------------------------------------- templates  */

export const templateCreateSchema = z.object({
  name: safeTextSchema(120, 'Template name'),
  description: optionalTextSchema(500),
  zoneId: idSchema.nullable().optional(),
  defaultOptions: printOptionsSchema.partial().default({}),
});

/* --------------------------------------------------------------- settings  */

export const settingsUpdateSchema = z
  .object({
    uploadRetentionDays: z.coerce.number().int().min(0).max(3650),
    scanRetentionDays: z.coerce.number().int().min(1).max(3650),
    notificationRetentionDays: z.coerce.number().int().min(7).max(3650),
    maxJobImpressions: z.coerce.number().int().min(1).max(100_000),
    largeJobWarnImpressions: z.coerce.number().int().min(1).max(100_000),
    maxConcurrentJobsPerPrinter: z.coerce.number().int().min(1).max(10),
    printerCooldownSeconds: z.coerce.number().int().min(0).max(300),
    costPerPageMono: z.coerce.number().min(0).max(100),
    costPerPageColor: z.coerce.number().min(0).max(100),
    currency: z.string().trim().length(3).toUpperCase(),
    co2GramsPerImpression: z.coerce.number().min(0).max(1000),
    emailEnabled: z.boolean(),
    webPushEnabled: z.boolean(),
    scanReservationMinutes: z.coerce.number().int().min(1).max(120),
    walkupReportLabel: safeTextSchema(60, 'Walk-up label'),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one setting to update.')
  .refine(
    (v) =>
      v.largeJobWarnImpressions === undefined ||
      v.maxJobImpressions === undefined ||
      v.largeJobWarnImpressions <= v.maxJobImpressions,
    {
      message: 'The warning threshold cannot exceed the hard limit.',
      path: ['largeJobWarnImpressions'],
    },
  );

/* ---------------------------------------------------------------- reports  */

export const statsQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    zoneId: idSchema.optional(),
    printerId: idSchema.optional(),
    userId: idSchema.optional(),
    /**
     * Narrows a series to jobs from one source.
     *
     * The dashboard draws app jobs and walk-up activity as two separate lines,
     * because DEC-06 refuses to call the second one printing and a single
     * combined line would do exactly that. Without this the client could only
     * plot the total.
     */
    source: z.enum(JOB_SOURCES).optional(),
    bucket: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  })
  .refine((v) => new Date(v.from) <= new Date(v.to), {
    message: 'The start date must fall before the end date.',
    path: ['from'],
  });

/* ---------------------------------------------------------- notifications  */

export const notificationQuerySchema = paginationSchema.extend({
  severity: z.enum(SEVERITIES).optional(),
  unreadOnly: z.coerce.boolean().default(false),
});

/* ----------------------------------------------------------------- audit   */

export const auditQuerySchema = paginationSchema.extend({
  actorUserId: idSchema.optional(),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(80).optional(),
  entityId: z.string().trim().max(80).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

/* ------------------------------------------------------------ collectors   */

export const collectorCreateSchema = z.object({
  name: safeTextSchema(120, 'Collector name'),
  zoneId: idSchema,
});

export const collectorHeartbeatSchema = z.object({
  version: z.string().max(40),
  uptimeSeconds: z.coerce.number().int().min(0),
  printers: z
    .array(
      z.object({
        printerId: idSchema,
        reachable: z.boolean(),
        status: z.enum(['online', 'offline', 'degraded', 'unknown']),
        stateReasons: z.array(z.string().max(80)).max(30).default([]),
      }),
    )
    .max(200),
});

/**
 * Collector event batch. Every event carries an idempotency key generated by
 * the collector, so a replay after a dropped uplink cannot double-log. §B11.4.
 */
export const collectorEventsSchema = z.object({
  events: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('counter'),
          idempotencyKey: z.string().min(8).max(120),
          printerId: idSchema,
          observedAt: z.string().datetime({ offset: true }),
          lifeCount: z.coerce.number().int().min(0),
          printCount: z.coerce.number().int().min(0).nullable().optional(),
          copyCount: z.coerce.number().int().min(0).nullable().optional(),
        }),
        z.object({
          kind: z.literal('scan'),
          idempotencyKey: z.string().min(8).max(120),
          printerId: idSchema,
          observedAt: z.string().datetime({ offset: true }),
          filename: z.string().max(400),
          sizeBytes: z.coerce.number().int().min(0),
          contentType: z.string().max(120),
        }),
      ]),
    )
    .max(500),
});

/* --------------------------------------------------------------- web push  */

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(600),
  keys: z.object({
    p256dh: z.string().max(200),
    auth: z.string().max(200),
  }),
});

/* ----------------------------------------------------------------- exports */

export type LoginInput = z.input<typeof loginSchema>;
export type PrintOptionsInput = z.input<typeof printOptionsSchema>;
export type PrintOptionsOutput = z.output<typeof printOptionsSchema>;
export type PrinterCreateInput = z.input<typeof printerCreateSchema>;
export type PrinterUpdateInput = z.input<typeof printerUpdateSchema>;
export type UserCreateInput = z.input<typeof userCreateSchema>;
export type RedeemSetupLinkInput = z.input<typeof redeemSetupLinkSchema>;
export type SettingsUpdateInput = z.input<typeof settingsUpdateSchema>;
export type JobQueryInput = z.input<typeof jobQuerySchema>;
export type StatsQueryInput = z.input<typeof statsQuerySchema>;
export type CollectorEventsInput = z.input<typeof collectorEventsSchema>;
