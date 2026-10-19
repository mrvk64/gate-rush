#!/usr/bin/env node
// tools/build-artifact.js — strips index.html down to artifact.html (ARCHITECTURE §15.2 / §15.3).
//
// Reads index.html, extracts the <!-- BEGIN APP --> … <!-- END APP --> and
// <!-- BEGIN BOOTGUARD --> … <!-- END BOOTGUARD --> blocks, copies the font
// <link> tags, the css <link rel="stylesheet"> and the <script type="importmap">
// verbatim from <head>, then the <link rel="modulepreload"> tags (round-2 UI-29:
// placed AFTER the import map — Chrome rejects an import map once a module or
// module preload has started loading), swaps data-shell="index" for data-shell="artifact",
// appends the module <script> and writes artifact.html — with no doctype,
// <html>, <head>, <body>, manifest, icons, theme-color or service-worker script.
//
// Also parses sw.js's PRECACHE list and fails if any js/*.js file is missing
// from it (§15.4). Zero dependencies, node ≥ 18.
//
// Usage: node tools/build-artifact.js [--in index.html] [--out artifact.html]
//                                     [--sw sw.js] [--js js] [--no-sw-check] [--quiet]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    in: path.join(ROOT, 'index.html'),
    out: path.join(ROOT, 'artifact.html'),
    sw: path.join(ROOT, 'sw.js'),
    js: path.join(ROOT, 'js'),
    swCheck: true,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value after ${a}`);
      return path.resolve(ROOT, v);
    };
    if (a === '--in') opts.in = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--sw') opts.sw = next();
    else if (a === '--js') opts.js = next();
    else if (a === '--no-sw-check') opts.swCheck = false;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else fail(`unknown argument ${a} (try --help)`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    'build-artifact: index.html → artifact.html\n' +
    '  --in <file>      source shell (default index.html)\n' +
    '  --out <file>     output (default artifact.html)\n' +
    '  --sw <file>      service worker to cross-check (default sw.js)\n' +
    '  --js <dir>       script folder whose files must be precached (default js)\n' +
    '  --no-sw-check    skip the PRECACHE check (prints a warning)\n' +
    '  --quiet          only print errors\n');
}

function fail(msg) {
  process.stderr.write(`build-artifact: ERROR: ${msg}\n`);
  process.exit(1);
}

/** Repo-relative path with forward slashes for messages (absolute when outside the repo). */
function rel(p) {
  const r = path.relative(ROOT, p);
  return (r.startsWith('..') || path.isAbsolute(r) ? p : r).replace(/\\/g, '/');
}

function warn(msg) {
  process.stderr.write(`build-artifact: WARNING: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Extraction helpers (string-based; the shells are hand-written, not minified)
// ---------------------------------------------------------------------------

/** Text strictly between two marker comments; both must appear exactly once, in order. */
function extractBlock(html, name) {
  const begin = `<!-- BEGIN ${name} -->`;
  const end = `<!-- END ${name} -->`;
  const b = html.indexOf(begin);
  if (b < 0) fail(`marker ${begin} not found in index.html`);
  if (html.indexOf(begin, b + begin.length) >= 0) fail(`marker ${begin} appears more than once`);
  const e = html.indexOf(end, b + begin.length);
  if (e < 0) fail(`marker ${end} not found after ${begin}`);
  if (html.indexOf(end, e + end.length) >= 0) fail(`marker ${end} appears more than once`);
  return html.slice(b + begin.length, e).trim();
}

/** Inner text of <head> … </head>. */
function extractHead(html) {
  const m = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  if (!m) fail('<head> … </head> not found in index.html');
  return m[1];
}

/** Attribute value (unquoted / single / double) of a tag string, or null. */
function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
}

function hasRel(tag, rel) {
  const r = attr(tag, 'rel');
  if (r === null) return false;
  return r.toLowerCase().split(/\s+/).includes(rel);
}

/**
 * Picks the <link> tags the artifact needs, in source order:
 * the font preconnects, the Google Fonts stylesheet and the game stylesheet.
 * manifest / icon / apple-touch-icon links are deliberately dropped.
 */
function pickLinks(head) {
  const links = head.match(/<link\b[^>]*>/gi) || [];
  const kept = [];
  let fontCss = 0, gameCss = 0, preconnect = 0;
  for (const tag of links) {
    const href = attr(tag, 'href') || '';
    const isFontHost = /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(href);
    if (hasRel(tag, 'preconnect') && isFontHost) { kept.push(tag); preconnect++; continue; }
    if (hasRel(tag, 'stylesheet')) {
      if (isFontHost) fontCss++;
      else gameCss++;
      kept.push(tag);
      continue;
    }
    // manifest, icon, apple-touch-icon, … → dropped
  }
  if (preconnect === 0) warn('no font <link rel="preconnect"> tags found in <head>');
  if (fontCss === 0) fail('Google Fonts stylesheet <link> not found in <head> (§10.3 requires it in both shells)');
  if (gameCss === 0) fail('<link rel="stylesheet" href="css/game.css"> not found in <head>');
  if (gameCss > 1) warn(`${gameCss} non-font stylesheet links found; all copied`);
  return kept;
}

/** Every <link rel="modulepreload"> tag of <head>, in source order (UI-29: the module graph in one fetch wave). */
function pickModulePreloads(head) {
  const links = head.match(/<link\b[^>]*>/gi) || [];
  return links.filter((tag) => hasRel(tag, 'modulepreload'));
}

/** The single <script type="importmap"> … </script> block from <head>, verbatim. */
function pickImportMap(head) {
  const all = head.match(/<script\b[^>]*\btype\s*=\s*["']?importmap["']?[^>]*>[\s\S]*?<\/script>/gi) || [];
  if (all.length === 0) fail('<script type="importmap"> not found in <head>');
  if (all.length > 1) fail(`${all.length} import maps found in <head>; exactly one expected`);
  const map = all[0];
  const json = />([\s\S]*)<\/script>$/i.exec(map)[1];
  let parsed;
  try { parsed = JSON.parse(json); } catch (e) { fail(`import map is not valid JSON: ${e.message}`); }
  if (!parsed || !parsed.imports || typeof parsed.imports.three !== 'string' || typeof parsed.imports['three/addons/'] !== 'string') {
    fail('import map must map both "three" and "three/addons/"');
  }
  return map;
}

/** The <script type="module" src="js/main.js"></script> tag (outside the marker blocks). */
function pickModuleScript(html) {
  const all = html.match(/<script\b[^>]*\btype\s*=\s*["']?module["']?[^>]*>\s*<\/script>/gi) || [];
  if (all.length === 0) fail('<script type="module" src="…"> not found in index.html');
  if (all.length > 1) fail(`${all.length} module script tags found; exactly one expected`);
  const src = attr(all[0], 'src');
  if (!src) fail('module script tag has no src attribute');
  if (!/(^|\/)main\.js$/.test(src)) warn(`module script src is "${src}" (expected js/main.js)`);
  return all[0];
}

// ---------------------------------------------------------------------------
// Service-worker PRECACHE cross-check (§15.4)
// ---------------------------------------------------------------------------

function normalizePrecachePath(p) {
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  else if (s.startsWith('/')) s = s.slice(1);
  return s;
}

function checkServiceWorker(opts) {
  if (!opts.swCheck) {
    warn('--no-sw-check given: skipping the sw.js PRECACHE check');
    return;
  }
  if (!fs.existsSync(opts.sw)) {
    fail(`${rel(opts.sw)} not found; every js/*.js file must be in its PRECACHE list ` +
         '(pass --no-sw-check while the service worker does not exist yet)');
  }
  const src = fs.readFileSync(opts.sw, 'utf8');
  const m = /\bPRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) fail('sw.js has no `PRECACHE = [ … ]` array');
  const entries = [];
  const strRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let s;
  while ((s = strRe.exec(m[1])) !== null) entries.push(normalizePrecachePath(s[2]));
  if (entries.length === 0) fail('sw.js PRECACHE list is empty');
  const set = new Set(entries);

  const jsFiles = fs.existsSync(opts.js)
    ? fs.readdirSync(opts.js).filter((f) => f.endsWith('.js')).sort()
    : [];
  // PRECACHE paths are relative to the service worker's own directory (the site root)
  const jsDirName = path.relative(path.dirname(opts.sw), opts.js).replace(/\\/g, '/') || 'js';
  if (jsDirName.startsWith('..') || path.isAbsolute(jsDirName)) {
    fail(`${rel(opts.js)} is not inside the service worker's directory ${rel(path.dirname(opts.sw))}; PRECACHE cannot reference it`);
  }
  const missing = jsFiles.filter((f) => !set.has(`${jsDirName}/${f}`));
  if (missing.length) {
    fail(`sw.js PRECACHE is missing: ${missing.map((f) => `./${jsDirName}/${f}`).join(', ')}`);
  }
  // stale entries are not fatal (a file may be mid-rename), but worth a warning
  const stale = entries.filter((e) => e.startsWith(`${jsDirName}/`) && !jsFiles.includes(e.slice(jsDirName.length + 1)));
  if (stale.length) warn(`sw.js PRECACHE lists files that do not exist: ${stale.join(', ')}`);
  if (!set.has('index.html')) warn('sw.js PRECACHE does not list ./index.html');
  if (!set.has('css/game.css')) warn('sw.js PRECACHE does not list ./css/game.css');
  if (!opts.quiet) process.stdout.write(`build-artifact: sw.js PRECACHE covers all ${jsFiles.length} files in ${jsDirName}/\n`);
}

// ---------------------------------------------------------------------------
// Output sanity (the artifact shell is injected into a host skeleton)
// ---------------------------------------------------------------------------

function assertArtifactClean(out) {
  const banned = [
    [/<!doctype/i, '<!doctype>'],
    [/<html\b/i, '<html>'],
    [/<\/?head\b/i, '<head>'],
    [/<\/?body\b/i, '<body>'],
    [/rel\s*=\s*["']?manifest/i, 'manifest link'],
    [/rel\s*=\s*["']?(apple-touch-icon|icon)\b/i, 'icon link'],
    [/name\s*=\s*["']?theme-color/i, 'theme-color meta'],
    [/serviceWorker/, 'service-worker registration'],
    [/<meta\b/i, '<meta>'],
  ];
  for (const [re, what] of banned) {
    if (re.test(out)) fail(`generated artifact still contains a ${what}; refusing to write`);
  }
  // exactly one <title>, inside the first 8 KB (the artifact viewer names the page from it)
  const titles = out.match(/<title\b/gi) || [];
  if (titles.length !== 1) fail(`generated artifact must contain exactly one <title> (found ${titles.length})`);
  if (out.indexOf('<title') > 8000) fail('generated artifact <title> must sit in the first 8 KB');
  if (!/data-shell="artifact"/.test(out)) fail('generated artifact lacks data-shell="artifact"');
  if (/data-shell="index"/.test(out)) fail('generated artifact still contains data-shell="index"');
  const ids = ['id="app"', 'id="gl-canvas"', 'id="ui"', 'id="error-box"', 'id="error-text"'];
  for (const id of ids) {
    if (!out.includes(id)) fail(`generated artifact lacks the required element ${id} (§10.1)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.in)) fail(`${rel(opts.in)} not found`);
  const html = fs.readFileSync(opts.in, 'utf8');

  const appBlock = extractBlock(html, 'APP');
  const bootguard = extractBlock(html, 'BOOTGUARD');
  const head = extractHead(html);
  const links = pickLinks(head);
  const importMap = pickImportMap(head);
  const preloads = pickModulePreloads(head);
  const moduleScript = pickModuleScript(html);

  const shellCount = (appBlock.match(/data-shell="index"/g) || []).length;
  if (shellCount !== 1) fail(`expected exactly one data-shell="index" inside the APP block, found ${shellCount}`);
  if (!/<div\b[^>]*\bid="app"/.test(appBlock)) fail('APP block does not start with <div id="app" …>');
  const app = appBlock.replace('data-shell="index"', 'data-shell="artifact"');

  if (!/<script\b/i.test(bootguard) || !/<\/script>/i.test(bootguard)) {
    fail('BOOTGUARD block does not contain an inline <script> … </script>');
  }
  if (/type\s*=\s*["']?module/i.test(bootguard)) fail('BOOTGUARD script must be a classic script, not a module');

  const parts = [
    '<!-- Gate Rush — artifact shell. GENERATED by tools/build-artifact.js from index.html; do not edit by hand. -->',
    // the host skeleton has no <title>; the artifact viewer reads the first one in the first 8 KB
    '<title>Gate Rush</title>',
    ...links,
    importMap,
    ...preloads,
    app,
    bootguard,
    moduleScript,
    '',
  ];
  const out = parts.join('\n');
  assertArtifactClean(out);

  checkServiceWorker(opts);

  fs.writeFileSync(opts.out, out, 'utf8');
  if (!opts.quiet) {
    const lines = out.split('\n').length - 1;
    process.stdout.write(`build-artifact: wrote ${rel(opts.out)} (${lines} lines, ${Buffer.byteLength(out)} bytes; ` +
      `${links.length} link tags, import map, ${preloads.length} module preloads, APP, BOOTGUARD, module script)\n`);
  }
}

main();
