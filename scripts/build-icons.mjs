import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * `npm run icons` — rasterise the icon sources into the PNGs the manifest ships.
 *
 * The SVGs in `apps/web/src/assets` are the source of truth; the PNGs in
 * `apps/web/public` are build output that happens to be committed, because the
 * PWA plugin needs them on disk and a native image dependency is a poor trade
 * for a file that changes twice a year.
 *
 * It renders with whichever Chromium is already on the machine rather than
 * pulling in `sharp` or `@resvg/resvg-js`. Both are native modules that need a
 * toolchain on every developer's machine and in CI, to convert two files. Edge
 * ships with Windows and Chrome is on every workstation here, so the dependency
 * is one this project already has.
 *
 * If neither is present the script says so and exits 0 rather than failing a
 * build: the committed PNGs are still valid, and an icon refresh is not worth
 * breaking someone's `npm install` over.
 */

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'apps', 'web', 'src', 'assets');
const publicDir = join(here, '..', 'apps', 'web', 'public');

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** Each output: which source, and at what pixel size. */
const TARGETS = [
  { source: 'icon-source.svg', out: 'icon-512.png', size: 512 },
  { source: 'icon-source.svg', out: 'icon-192.png', size: 192 },
  /* 180px is the size iOS actually asks for, and it is drawn from the
     square-cornered *maskable* art: iOS applies its own superellipse mask, so
     supplying pre-rounded corners leaves the same pale crescents Android would.
     This was the one that shipped wrong. */
  { source: 'icon-maskable-source.svg', out: 'apple-touch-icon.png', size: 180 },
  { source: 'icon-maskable-source.svg', out: 'icon-maskable.png', size: 512 },
];

async function findBrowser() {
  for (const candidate of CANDIDATES) {
    try {
      await access(candidate, FS.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

async function render(browser, sourcePath, outPath, size) {
  const svg = await readFile(sourcePath, 'utf8');

  /* The SVG is inlined into a page with no margin and an exact viewport rather
   * than screenshotted directly. Chromium renders a bare .svg file centred in a
   * white document with default margins, which produces a letterboxed image
   * with a white frame — the shot has to be of a page built to the right size. */
  const html =
    `<!doctype html><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;background:transparent}` +
    `svg{display:block;width:${size}px;height:${size}px}</style>` +
    svg;

  const staging = await mkdtemp(join(tmpdir(), 'kode-icons-'));
  const page = join(staging, 'page.html');
  const shot = join(staging, 'shot.png');

  try {
    await (await import('node:fs/promises')).writeFile(page, html, 'utf8');
    await execFileAsync(browser, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      // Transparent, so the icon's own corners stay transparent instead of
      // being filled with the page's white.
      '--default-background-color=00000000',
      `--screenshot=${shot}`,
      `--window-size=${size},${size}`,
      `--force-device-scale-factor=1`,
      page,
    ]);
    await rename(shot, outPath);
    process.stdout.write(`  ${outPath.split(/[\\/]/).pop()}  ${size}×${size}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

const browser = await findBrowser();

if (!browser) {
  process.stdout.write(
    'No Chrome or Edge found; leaving the committed icon PNGs as they are.\n' +
      'Install either, or render apps/web/src/assets/*.svg by hand at 512, 192 and 180px.\n',
  );
  process.exit(0);
}

process.stdout.write(`Rendering icons with ${browser}\n`);
for (const target of TARGETS) {
  await render(browser, join(assets, target.source), join(publicDir, target.out), target.size);
}
process.stdout.write('Done.\n');
