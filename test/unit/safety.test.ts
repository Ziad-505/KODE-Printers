import { describe, expect, it } from 'vitest';
import {
  computeImpressions,
  computeSheets,
  sheetsSavedByDuplex,
  parsePageRanges,
  expandPageRanges,
} from '../../packages/shared/src/util.js';
import {
  containsPjlDirectives,
  frameDocument,
  guardRawContent,
} from '../../apps/server/src/services/transport/pjl.js';
import {
  describeBlockingState,
  retryDelayMs,
} from '../../apps/server/src/services/transport/safety.js';
import { BLOCKING_STATE_REASONS } from '../../packages/shared/src/constants.js';
import { verifyMagicBytes } from '../../apps/server/src/services/pipeline/prepare.js';
import { csvField } from '../../apps/server/src/utilities/csv.js';
import { generateSetupToken } from '../../apps/server/src/services/auth/hash.js';

/**
 * Printer-safety and input-handling tests.
 *
 * Scenarios 12 ("executable renamed to .pdf: rejected before reaching any
 * converter") from §B17.2 lives here, alongside the guards this build adds
 * beyond the document.
 */

describe('impressions vs sheets', () => {
  it('duplex halves sheets but never impressions', () => {
    const job = { pages: 10, copies: 1, sides: 'two-sided-long-edge' as const };

    // The subtlety that makes or breaks the ledger. A 10-page duplex job still
    // marks 10 impressions across 5 sheets; treating it as 5 would leave 5
    // unattributed and produce a phantom walk-up on the next poll.
    expect(computeImpressions(job)).toBe(10);
    expect(computeSheets(job)).toBe(5);
    expect(sheetsSavedByDuplex(job)).toBe(5);
  });

  it('rounds an odd duplex page count up to whole sheets', () => {
    const job = { pages: 7, copies: 2, sides: 'two-sided-long-edge' as const };

    expect(computeImpressions(job)).toBe(14);
    // Each copy needs 4 sheets: 3 double-sided plus one with a blank back.
    expect(computeSheets(job)).toBe(8);
  });

  it('reports no saving for a single-sided job', () => {
    expect(sheetsSavedByDuplex({ pages: 10, copies: 1, sides: 'one-sided' })).toBe(0);
  });

  it('multiplies by copies', () => {
    expect(computeImpressions({ pages: 3, copies: 40, sides: 'one-sided' })).toBe(120);
  });
});

describe('page ranges', () => {
  it('parses the compact form people type', () => {
    expect(parsePageRanges('1-3, 7, 11-12')).toEqual([
      [1, 3],
      [7, 7],
      [11, 12],
    ]);
  });

  it('normalises a reversed range rather than rejecting it', () => {
    expect(parsePageRanges('9-4')).toEqual([[4, 9]]);
  });

  it('drops fragments it cannot understand instead of throwing', () => {
    expect(parsePageRanges('1-3, banana, 8')).toEqual([
      [1, 3],
      [8, 8],
    ]);
  });

  it('clamps an expansion to the document and de-duplicates overlaps', () => {
    expect(
      expandPageRanges(
        [
          [1, 3],
          [2, 5],
        ],
        4,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it('treats an empty range list as the whole document', () => {
    expect(expandPageRanges([], 3)).toEqual([1, 2, 3]);
  });
});

describe('PJL injection guard', () => {
  it('refuses a text file whose content is printer configuration', () => {
    // The attack: any user who can print a .txt can reset the device admin
    // password or take it offline. Nothing in the delivered build stops this.
    const malicious = Buffer.from('\u001B%-12345X@PJL DEFAULT PASSWORD=0\r\n', 'latin1');

    const verdict = guardRawContent(malicious, 'text/plain');
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toMatch(/printer control commands/i);
  });

  it('refuses a bare @PJL directive at the head of a text stream', () => {
    const malicious = Buffer.from('@PJL SET HOLD=ON\r\nhello\r\n', 'latin1');
    expect(guardRawContent(malicious, 'text/plain').safe).toBe(false);
  });

  it('allows ordinary text that merely mentions PJL', () => {
    const innocent = Buffer.from('Notes from the meeting about PJL support.\n', 'utf8');
    expect(guardRawContent(innocent, 'text/plain').safe).toBe(true);
  });

  it('does not scan a PDF, whose bytes the device never interprets as PJL', () => {
    // A PDF is wrapped in its own language. Scanning it would reject legitimate
    // documents that happen to contain the string.
    const pdf = Buffer.from('%PDF-1.7\n... @PJL appears inside a content stream ...', 'latin1');
    expect(guardRawContent(pdf, 'application/pdf').safe).toBe(true);
  });

  it('scans content labelled as a PDF that is not one', () => {
    // The hole this closes. The pipeline labels its output `application/pdf`
    // from the first line of the job, so a conversion that fell back to its
    // input carried that label all the way to the socket while still holding
    // raw text. Trusting the label meant the guard never ran on a real job.
    const notReallyPdf = Buffer.from('@PJL SET HOLD=ON\r\nthe rest of the file\r\n', 'latin1');
    const verdict = guardRawContent(notReallyPdf, 'application/pdf');

    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toMatch(/printer control commands/i);
  });

  it('accepts genuine PostScript and scans anything else claiming to be it', () => {
    const postscript = Buffer.from('%!PS-Adobe-3.0\n% @PJL in a comment\n', 'latin1');
    expect(guardRawContent(postscript, 'application/postscript').safe).toBe(true);

    const impostor = Buffer.from('%-12345X@PJL DEFAULT PASSWORD=0\r\n', 'latin1');
    expect(guardRawContent(impostor, 'application/postscript').safe).toBe(false);
  });

  it('detects directives regardless of case', () => {
    expect(containsPjlDirectives(Buffer.from('@pjl set copies=2\r\n', 'latin1'))).toBe(true);
  });
});

describe('PJL framing', () => {
  const options = {
    copies: 3,
    sides: 'two-sided-long-edge' as const,
    colorMode: 'grayscale' as const,
    media: 'iso_a4_210x297mm' as const,
    orientation: 'portrait' as const,
    jobName: 'Membership form',
    username: 'a.hassan',
    // Required by PjlOptions, and what decides the ENTER LANGUAGE line.
    contentType: 'application/pdf',
  };

  const document = Buffer.from('%PDF-1.7 body');

  it('sets job-scoped values, never device defaults', () => {
    const framed = frameDocument(document, options, 'pjl-plain').toString('latin1');

    // @PJL DEFAULT writes the device's persistent configuration and would leave
    // every subsequent walk-up user with this job's settings.
    expect(framed).toContain('@PJL SET COPIES=3');
    expect(framed).toContain('@PJL SET DUPLEX=ON');
    expect(framed).not.toContain('@PJL DEFAULT');
  });

  it('adds a language line only for the first framing in the ladder', () => {
    expect(frameDocument(document, options, 'pjl-with-language').toString('latin1')).toContain(
      '@PJL ENTER LANGUAGE',
    );
    expect(frameDocument(document, options, 'pjl-plain').toString('latin1')).not.toContain(
      '@PJL ENTER LANGUAGE',
    );
  });

  it('sends the document untouched under raw-only framing', () => {
    expect(frameDocument(document, options, 'raw-only')).toEqual(document);
  });

  it('neutralises quotes and newlines in a user-supplied job name', () => {
    const framed = frameDocument(
      document,
      { ...options, jobName: 'evil"\r\n@PJL SET HOLD=ON' },
      'pjl-plain',
    ).toString('latin1');

    const header = framed.slice(0, framed.indexOf('%PDF'));
    const jobNameLine = header.split('\r\n').find((line) => line.startsWith('@PJL JOB NAME'));

    // The security property is that the attacker's payload cannot *become a
    // directive*: it stays inside one quoted value on one line. The literal
    // text "HOLD=ON" surviving there is inert — the device reads it as part of
    // the job's name, which is exactly what a job called that should do.
    expect(jobNameLine).toBe('@PJL JOB NAME="evil PJL SET HOLD=ON"');

    // No extra directive line was smuggled in: the count matches the eight this
    // configuration emits (JOBATTR, JOB NAME, COPIES, DUPLEX, BINDING,
    // RENDERMODE, PAPER, ORIENTATION, RESOLUTION) plus the trailing EOJ.
    expect(header.match(/^@PJL /gm)).toHaveLength(9);
    expect(framed).not.toMatch(/^@PJL SET HOLD/m);
  });

  it('clamps an absurd copy count', () => {
    const framed = frameDocument(document, { ...options, copies: 100_000 }, 'pjl-plain');
    expect(framed.toString('latin1')).toContain('@PJL SET COPIES=999');
  });
});

describe('dispatch blocking', () => {
  it('refuses to send to a device whose serial stopped matching', () => {
    // §B7.1 stops polling a mismatched device so its counters cannot corrupt
    // another printer's history. Sending to one is the same mistake pointed the
    // other way: the address answers for a machine nobody has identified, and
    // the document prints wherever that machine is.
    expect(BLOCKING_STATE_REASONS.has('device-mismatch')).toBe(true);

    const message = describeBlockingState('Reception MFP', ['device-mismatch']);
    expect(message).toMatch(/not the one on record/i);
  });

  it('names every blocking reason in plain words', () => {
    // A reason with no phrase falls back to "it reported a problem", which
    // tells the person standing next to the printer nothing they can act on.
    for (const reason of BLOCKING_STATE_REASONS) {
      expect(describeBlockingState('Printer', [reason])).not.toMatch(/reported a problem/);
    }
  });

  it('joins several reasons into one readable sentence', () => {
    expect(describeBlockingState('Reception MFP', ['media-empty', 'door-open'])).toBe(
      'Reception MFP is not ready: the paper tray is empty and a door or cover is open.',
    );
  });
});

describe('retry backoff — §B10.4', () => {
  // No jitter, so the schedule itself is what is being asserted.
  const noJitter = () => 0;

  it('waits 30s, then 2m, then 10m', () => {
    // `attempts` is already 1 after the dequeue claims the row, so the first
    // failure is attempt 1. Treating it as 0-based skipped the 30s entry
    // entirely and made every first retry wait two minutes.
    expect(retryDelayMs(1, noJitter)).toBe(15_000);
    expect(retryDelayMs(2, noJitter)).toBe(60_000);
    expect(retryDelayMs(3, noJitter)).toBe(300_000);
  });

  it('holds at the longest delay beyond the schedule', () => {
    expect(retryDelayMs(9, noJitter)).toBe(300_000);
  });

  it('never indexes below the first entry', () => {
    expect(retryDelayMs(0, noJitter)).toBe(15_000);
  });

  it('spreads a fleet-wide retry across half the window', () => {
    // Full jitter: half the base, plus up to half again. A synchronised storm
    // the moment a network returns looks to the switch like the outage itself.
    expect(retryDelayMs(1, () => 0)).toBe(15_000);
    expect(retryDelayMs(1, () => 0.999)).toBeLessThanOrEqual(30_000);
    expect(retryDelayMs(1, () => 0.999)).toBeGreaterThan(29_000);
  });
});

describe('magic bytes — §B17.2 scenario 12', () => {
  it('rejects a Windows executable renamed to .pdf', () => {
    const executable = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]);

    const verdict = verifyMagicBytes(executable, 'quarterly-report.pdf');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/executable/i);
  });

  it('rejects an ELF binary and a shell script whatever they are called', () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]);
    const script = Buffer.from('#!/bin/sh\nrm -rf /\n');

    expect(verifyMagicBytes(elf, 'invoice.docx').ok).toBe(false);
    expect(verifyMagicBytes(script, 'notes.txt').ok).toBe(false);
  });

  it('rejects a PNG wearing a .pdf extension', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)]);

    const verdict = verifyMagicBytes(png, 'scan.pdf');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/actually a png/i);
  });

  it('accepts a genuine PDF', () => {
    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
    expect(verifyMagicBytes(pdf, 'report.pdf')).toMatchObject({ ok: true, detectedAs: 'pdf' });
  });

  it('accepts plain text, which has no signature to check', () => {
    expect(verifyMagicBytes(Buffer.from('hello, club\n'), 'note.txt').ok).toBe(true);
  });

  it('rejects binary content claiming to be text', () => {
    const binary = Buffer.from([0x68, 0x69, 0x00, 0xff, 0xfe]);
    expect(verifyMagicBytes(binary, 'note.txt').ok).toBe(false);
  });

  it('accepts a DOCX, which is a zip container', () => {
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);
    expect(verifyMagicBytes(docx, 'form.docx').ok).toBe(true);
  });
});

describe('CSV export escaping', () => {
  it('neutralises a formula so an export cannot execute in Excel', () => {
    // The export is the artefact that gets emailed around, which makes it the
    // worst place for a document name that Excel treats as code.
    expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvField('+1234')).toBe("'+1234");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvField('Smith, "Bob"')).toBe('"Smith, ""Bob"""');
  });

  it('quotes a value containing a newline', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('renders null and undefined as empty rather than as text', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('leaves an ordinary value alone', () => {
    expect(csvField('Reception MFP')).toBe('Reception MFP');
  });
});

/**
 * Set-password link tokens.
 *
 * The shape matters beyond aesthetics: the value goes in a URL path and is
 * pasted by hand into a chat window, so `+`, `/` and `=` would all be mangled
 * somewhere between the administrator and the person receiving it.
 */
describe('set-password link tokens', () => {
  it('is URL-safe, so it survives being pasted into a chat', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { token } = generateSetupToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThanOrEqual(40);
    }
  });

  it('never repeats, and never stores what it hands out', () => {
    const first = generateSetupToken();
    const second = generateSetupToken();

    expect(first.token).not.toBe(second.token);
    // What is stored must not be the credential itself.
    expect(first.hash).not.toBe(first.token);
    expect(first.hash).toHaveLength(64);
  });
});
