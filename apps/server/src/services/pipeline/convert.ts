import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { AppError, fileExtension } from '@kode/shared';
import { config } from '../../config/index.js';
import { serialiseError, subsystem } from '../../utilities/logger.js';
import { textToPdf } from './prepare.js';
import { runSandboxed, withTempDir } from './sandbox.js';

const log = subsystem('pipeline:convert');

const OFFICE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'csv',
  'txt',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

export function needsOfficeConversion(filename: string): boolean {
  return OFFICE_EXTENSIONS.has(fileExtension(filename));
}

export function isImage(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(filename));
}

export interface ConversionOutcome {
  content: Buffer;
  contentType: string;
  degradations: string[];
}

export async function officeToPdf(
  input: Buffer,
  originalFilename: string,
  jobId: number,
): Promise<Buffer> {
  return withTempDir(`lo-${jobId}`, async (dir) => {
    const safeName = `input${extname(originalFilename) || '.tmp'}`;
    const inputPath = join(dir, safeName);
    const profileDir = join(dir, 'profile');
    const outDir = join(dir, 'out');

    await writeFile(inputPath, input);

    await runSandboxed({
      command: config.convert.libreOfficePath,
      args: [
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        `-env:UserInstallation=file://${profileDir.replace(/\\/g, '/')}`,
        '--convert-to',
        'pdf:writer_pdf_Export',
        '--outdir',
        outDir,
        inputPath,
      ],
      cwd: dir,
      env: { TMPDIR: dir },
    });

    const produced = await readdir(outDir).catch(() => [] as string[]);
    const pdfName = produced.find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!pdfName) {
      throw new AppError('CONVERSION_FAILED', 'The document could not be converted to PDF.', {
        details: { originalFilename: basename(originalFilename) },
      });
    }
    return readFile(join(outDir, pdfName));
  });
}

export async function toGrayscale(input: Buffer, jobId: number): Promise<Buffer> {
  return withTempDir(`gs-gray-${jobId}`, async (dir) => {
    const inputPath = join(dir, 'input.pdf');
    const outputPath = join(dir, 'output.pdf');
    await writeFile(inputPath, input);

    await runSandboxed({
      command: config.convert.ghostscriptPath,
      args: [
        '-sDEVICE=pdfwrite',
        '-dProcessColorModel=/DeviceGray',
        '-sColorConversionStrategy=Gray',
        '-dOverrideICC',
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-dQUIET',
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      cwd: dir,
      env: { TMPDIR: dir },
    });

    return readFile(outputPath);
  });
}


export function printerAcceptsPdf(printer: {
  vendor: string | null;
  model: string | null;
  capabilities: { formats: readonly string[] };
}): boolean {
  const identity = `${printer.vendor ?? ''} ${printer.model ?? ''}`.toLowerCase();

  const isAltaLink = identity.includes('altalink');
  if (isAltaLink) {
    return (
      printer.capabilities.formats.length === 0 ||
      printer.capabilities.formats.includes('application/pdf')

  return (
    printer.capabilities.formats.length === 0 ||
    printer.capabilities.formats.includes('application/pdf')
  );
}



/**
 * PDF → PostScript, for devices that do not accept `application/pdf`.
 *
 * §B6.1 notes this stage becomes unnecessary on IPP Everywhere devices, which
 * mandate PDF acceptance — so the pipeline skips it entirely when the device's
 * capabilities say PDF is supported, dropping a Ghostscript invocation from the
 * hot path.
 */
export async function pdfToPostScript(
  input: Buffer,
  jobId: number,
  options: { grayscale?: boolean } = {},
): Promise<Buffer> {
  return withTempDir(`gs-ps-${jobId}`, async (dir) => {
    const inputPath = join(dir, 'input.pdf');
    const outputPath = join(dir, 'output.ps');
    await writeFile(inputPath, input);

    await runSandboxed({
      command: config.convert.ghostscriptPath,
      args: [
        '-sDEVICE=ps2write',
        ...(options.grayscale
          ? ['-dProcessColorModel=/DeviceGray', '-sColorConversionStrategy=Gray', '-dOverrideICC']
          : []),
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        '-dQUIET',
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      cwd: dir,
      env: { TMPDIR: dir },
    });

    return readFile(outputPath);
  });
}

export async function stage(
  name: string,
  input: Buffer,
  fn: () => Promise<Buffer>,
  degradations: string[],
): Promise<Buffer> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONVERSION_TIMEOUT') throw error;
    log.warn({ stage: name, ...serialiseError(error) }, 'conversion stage failed; falling back');
    degradations.push(name);
    return input;
  }
}

export async function requiredStage(
  name: string,
  filename: string,
  fn: () => Promise<Buffer>,
): Promise<Buffer> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError) throw error;
    log.warn({ stage: name, ...serialiseError(error) }, 'required conversion stage failed');
    throw new AppError(
      'CONVERSION_FAILED',
      `"${basename(filename)}" could not be prepared for printing.`,
      { details: { stage: name }, retryable: false, cause: error },
    );
  }
}

export async function textToPdfStrict(
  input: Buffer,
  filename: string,
  jobId: number,
  degradations: string[],
): Promise<Buffer> {
  try {
    return await officeToPdf(input, filename, jobId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONVERSION_TIMEOUT') throw error;
    log.warn(
      { stage: 'text-office-to-pdf', ...serialiseError(error) },
      'LibreOffice could not render the text; falling back to the built-in writer',
    );
    degradations.push('text-office-to-pdf');
  }

  try {
    return await textToPdf(input);
  } catch (error) {
    throw new AppError(
      'CONVERSION_FAILED',
      `"${basename(filename)}" could not be turned into a printable document. If it contains ` +
        'Arabic or other non-Latin text, the document converter is not available on this ' +
        'server. Save it as a PDF and try again.',
      { details: { stage: 'text-to-pdf' }, retryable: false, cause: error },
    );
  }
}