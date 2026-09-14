import type { ColorMode, MediaSize, Sides } from '@kode/shared';

/**
 * PJL framing for the RAW/9100 path (§B6.4).
 *
 * PJL is HP-originated and honoured by most PCL-family devices, but it is not a
 * standard and there is no feedback channel over RAW to tell us whether it took
 * effect. That is precisely the limitation IPP removes, and why this path is the
 * fallback rather than the default.
 *
 * ── The injection problem ──────────────────────────────────────────────────
 *
 * RAW/9100 is a socket into which bytes are written; the device parses whatever
 * arrives. A plain-text document whose own content contains PJL directives is
 * therefore not inert data — it is executable configuration. A file containing
 *
 *     <ESC>%-12345X@PJL DEFAULT PASSWORD=0
 *     @PJL DEFAULT LPARM:IP ADDRESS=...
 *
 * can reset a device's admin password, change its network configuration, or
 * take it permanently offline via `@PJL SET HOLD=ON`. Any user with permission
 * to print a `.txt` file can do this, and nothing in the transport layer would
 * notice.
 *
 * The delivered build sends text straight through. This module refuses to,
 * because "very safe for printers" has to mean something concrete.
 */

export interface PjlOptions {
  copies: number;
  sides: Sides;
  colorMode: ColorMode;
  media: MediaSize;
  orientation: 'portrait' | 'landscape';
  jobName: string;
  username: string;
  /** MIME type of the document following this header — determines the PJL LANGUAGE. */
  contentType: string;
}

const CONTENT_TYPE_TO_PJL_LANGUAGE: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'application/postscript': 'POSTSCRIPT',
  'application/vnd.hp-pcl': 'PCL',
};

/** Universal Exit Language — the escape sequence that opens a PJL block. */
const UEL = '\u001B%-12345X';

const MEDIA_TO_PJL: Readonly<Record<MediaSize, string>> = {
  iso_a4_210x297mm: 'A4',
  iso_a3_297x420mm: 'A3',
  iso_a5_148x210mm: 'A5',
  'na_letter_8.5x11in': 'LETTER',
  'na_legal_8.5x14in': 'LEGAL',
};

/**
 * PJL values are unquoted tokens in a line-oriented protocol, so anything that
 * could terminate a line or start a new directive must not survive into one.
 * Applied to the job name and username, both of which are user-controlled.
 */
function sanitizePjlValue(value: string, maxLength = 60): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- matching control bytes is the point
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/["@]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength)
  );
}

/**
 * Detects PJL or PCL control sequences inside content that will be sent as a
 * document body.
 *
 * Deliberately conservative: this runs only on formats whose bytes are passed
 * through uninterpreted (plain text). A PDF or PostScript file is wrapped by
 * its own language and the device's parser will not act on a `@PJL` string
 * buried inside it, so scanning those would reject legitimate documents that
 * merely mention the word.
 */
export function containsPjlDirectives(content: Buffer): boolean {
  // Only the head matters: a directive is acted on when the interpreter is in
  // PJL context, which is at the start of the stream or immediately after a UEL.
  const sample = content.subarray(0, Math.min(content.length, 64 * 1024)).toString('latin1');
  if (sample.includes(UEL)) return true;
  return /^\s*@PJL\b/im.test(sample);
}

export interface PjlGuardResult {
  safe: boolean;
  reason?: string;
}

/**
 * The guard applied before any byte reaches port 9100.
 *
 * The test is "can I prove this is a wrapped document?", not "does it claim to
 * be text?", and the difference is the whole value of the guard.
 *
 * Asking whether the content type was `text/*` looked equivalent and was not.
 * The pipeline sets its content type to what it *intends* to produce, which is
 * `application/pdf` from the first line of the job onward, so the guard never
 * ran on any real job. It passed its own unit tests and protected nothing. The
 * one path that could hand a device raw text was a conversion falling back to
 * its input, and that path kept the PDF label all the way to the socket.
 *
 * Verifying the claim against the bytes closes that structurally: a buffer
 * labelled `application/pdf` that does not begin `%PDF-` gets scanned, whatever
 * the pipeline believed about it.
 *
 * Text is refused rather than stripped. Silently removing lines from someone's
 * document produces a print that differs from what they submitted, which is a
 * worse outcome than a clear refusal they can act on.
 */
export function guardRawContent(content: Buffer, contentType: string): PjlGuardResult {
  const head = content.subarray(0, 5).toString('latin1');
  const isWrappedDocument =
    (contentType === 'application/pdf' && head.startsWith('%PDF-')) ||
    (contentType === 'application/postscript' && head.startsWith('%!'));

  if (isWrappedDocument) return { safe: true };

  if (containsPjlDirectives(content)) {
    return {
      safe: false,
      reason:
        'This file contains printer control commands (PJL). Sending it could reconfigure ' +
        'the device, so it has been refused. Convert it to PDF and try again.',
    };
  }
  return { safe: true };
}

/**
 * Builds the PJL prologue.
 *
 * `SET` rather than `DEFAULT` throughout: `DEFAULT` writes the device's
 * persistent configuration and would leave every subsequent walk-up user with
 * this job's settings. `SET` applies to the current job only. The delivered
 * build's choice here was correct and is preserved deliberately.
 */
export function buildPjlHeader(options: PjlOptions, includeLanguage: boolean): Buffer {
  const lines: string[] = [
    UEL,
    '@PJL SET JOBATTR="JobAcct1=' + sanitizePjlValue(options.username, 32) + '"',
    '@PJL JOB NAME="' + sanitizePjlValue(options.jobName) + '"',
    '@PJL SET COPIES=' + String(clampCopies(options.copies)),
    '@PJL SET DUPLEX=' + (options.sides === 'one-sided' ? 'OFF' : 'ON'),
  ];

  if (options.sides !== 'one-sided') {
    lines.push(
      '@PJL SET BINDING=' + (options.sides === 'two-sided-long-edge' ? 'LONGEDGE' : 'SHORTEDGE'),
    );
  }

  lines.push(
    '@PJL SET RENDERMODE=' + (options.colorMode === 'color' ? 'COLOR' : 'GRAYSCALE'),
    '@PJL SET PAPER=' + (MEDIA_TO_PJL[options.media] ?? 'A4'),
    '@PJL SET ORIENTATION=' + (options.orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT'),
    '@PJL SET RESOLUTION=600',
  );

  if (includeLanguage) {
    const language = CONTENT_TYPE_TO_PJL_LANGUAGE[options.contentType];
    if (language) lines.push('@PJL ENTER LANGUAGE=' + language);
  }

  return Buffer.from(lines.join('\r\n') + '\r\n', 'latin1');
}

export function buildPjlFooter(): Buffer {
  return Buffer.from(`${UEL}@PJL EOJ\r\n${UEL}`, 'latin1');
}

function clampCopies(copies: number): number {
  // A device asked for 10,000 copies will happily attempt them. The application
  // enforces its own ceiling upstream; this is the last line of defence.
  return Math.max(1, Math.min(999, Math.round(copies)));
}

/**
 * Framing strategies, tried in order until the device accepts one (§B6.4).
 *
 * Some Xerox devices reject a PJL block carrying an explicit LANGUAGE line but
 * accept the same block without it; some older devices reject PJL entirely and
 * print it as text. Trying all three and keeping the first that the connection
 * accepts costs one reconnect and removes a per-printer configuration step.
 */
export type FramingStrategy = 'pjl-with-language' | 'pjl-plain' | 'raw-only';

export const FRAMING_ORDER: readonly FramingStrategy[] = [
  'pjl-with-language',
  'pjl-plain',
  'raw-only',
] as const;

/**
 * Vendors whose consumer/SMB device lines are known to treat unsolicited PJL
 * as literal text instead of rejecting it — i.e. exactly the failure mode
 * this ladder cannot detect via a socket-level signal (§B6.4 follow-up).
 * Matched case-insensitively against the vendor token parsed from
 * `printer-make-and-model`.
 */
const NO_FEEDBACK_TEXT_FALLBACK_VENDORS = new Set(['hp', 'hewlett-packard']);

/**
 * Picks the framing ladder to try, in order.
 *
 * For a vendor known to swallow bad PJL as plain text rather than resetting
 * the connection, starting with `raw-only` means the *first* attempt is one
 * whose success is actually observable (a well-formed PDF/PostScript either
 * autosenses correctly or it doesn't) rather than betting the whole job on a
 * framing we have no way to verify. PJL variants stay in the ladder after it,
 * in case the device does want duplex/media set explicitly.
 *
 * Unknown or PJL-friendly vendors keep the original order.
 */
export function getFramingOrder(vendor?: string | null): readonly FramingStrategy[] {
  if (vendor && NO_FEEDBACK_TEXT_FALLBACK_VENDORS.has(vendor.trim().toLowerCase())) {
    return ['raw-only', 'pjl-plain', 'pjl-with-language'];
  }
  return FRAMING_ORDER;
}

export function frameDocument(
  document: Buffer,
  options: PjlOptions,
  strategy: FramingStrategy,
): Buffer {
  if (strategy === 'raw-only') return document;
  return Buffer.concat([
    buildPjlHeader(options, strategy === 'pjl-with-language'),
    document,
    buildPjlFooter(),
  ]);
}