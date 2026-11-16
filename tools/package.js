#!/usr/bin/env node
// Builds dist/ — exactly the files a static host needs to serve Gate Rush as an installable web app (PWA).
// Usage: node tools/package.js            → dist/ (index.html, artifact.html, manifest, sw.js, css/, js/, icons/)
//        node tools/package.js --check    → also verifies every file sw.js pre-caches exists in dist/
//        node tools/package.js --lint     → 1.4.0 (A12, D46): NO build — checks that sw.js PRECACHE and index.html's
//                                           modulepreload list name exactly the js/*.js files, and prints the js/ download
//                                           size: raw bytes and gzip bytes (zlib level 9, summed per file — what a server
//                                           sends; the concatenated figure is printed beside it). Writes nothing, unless
//                                           --size-log <file> [--label <text>] appends one size row to that file.
//                                           --vs <file> (read only) or --size-log also print the change against the
//                                           log's newest row (the r8-140 head; every merge appends one); --allow <KB>
//                                           (1 KB = 1000 B) then FAILs when js/ raw grew by more (D46 allowances).
//                                           1.5.0: FAILs too when js/ is over JS_CAP (the owner's download caps).
// Upload the dist/ folder to any static host with HTTPS (Netlify Drop, GitHub Pages, Cloudflare Pages, Vercel …).
//
// Round 5 (r5-ui-sw needsOtherGroup 4) — the release rule is enforced here: sw.js v4 serves every precached file
// cache-first from its own `gaterush-<VERSION>` cache, so a release whose sw.js is byte-identical never reaches an
// installed player, and a changed build under an UNCHANGED VERSION would install into the cache the running build still
// serves from. dist/sw.js therefore ends with a `// build <sha-256>` stamp of every shipped file (sw.js without its stamp
// included), and the build stops — before dist/ is touched — when the previous dist/sw.js has the same VERSION and a
// different stamp: bump VERSION in sw.js (or delete dist/ when the previous build never shipped).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
/** 1.5.0 (owner default Q1, PLAN §3): the js/ download caps --lint enforces (1.4.0: 3,000,000 / 945,000, in the docs only). */
const JS_CAP = { raw: 3220000, gzip: 1005000 };

if (process.argv.includes('--lint')) process.exit(lint());

/** --lint: the PRECACHE / modulepreload lists against js/, and the js/ raw / gzip bytes. Returns the exit code. */
function lint() {
  const js = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).sort();
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const pre = /\bPRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(sw);
  const precached = new Set(pre ? [...pre[1].matchAll(/["']\.\/js\/([^"']+\.js)["']/g)].map((m) => m[1]) : []);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const preloaded = new Set([...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*href="js\/([^"]+\.js)"/g)].map((m) => m[1]));
  const problems = [];
  for (const [name, set] of [['sw.js PRECACHE', precached], ['index.html modulepreload', preloaded]]) {
    const missing = js.filter((f) => !set.has(f)), stale = [...set].filter((f) => !js.includes(f));
    if (missing.length) problems.push(`${name} is missing ${missing.join(', ')}`);
    if (stale.length) problems.push(`${name} lists files not in js/: ${stale.join(', ')}`);
  }
  let raw = 0, gz = 0;
  const bufs = [];
  for (const f of js) { const b = fs.readFileSync(path.join(ROOT, 'js', f)); bufs.push(b); raw += b.length; gz += zlib.gzipSync(b, { level: 9 }).length; }
  const cat = zlib.gzipSync(Buffer.concat(bufs), { level: 9 }).length;
  const n = (v) => v.toLocaleString('en-US');
  console.log(`package --lint: ${js.length} js files; PRECACHE ${js.filter((f) => precached.has(f)).length}/${js.length}, modulepreload ${js.filter((f) => preloaded.has(f)).length}/${js.length}`);
  console.log(`package --lint: js/ raw ${n(raw)} B, gzip ${n(gz)} B (zlib 9 per file; concatenated ${n(cat)} B); caps ${n(JS_CAP.raw)} / ${n(JS_CAP.gzip)}`);
  if (raw > JS_CAP.raw) problems.push(`js/ raw ${n(raw)} B is over the ${n(JS_CAP.raw)} B cap`);
  if (gz > JS_CAP.gzip) problems.push(`js/ gzip ${n(gz)} B is over the ${n(JS_CAP.gzip)} B cap`);
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null; };
  const logFile = arg('--size-log'), allow = arg('--allow'), ref = logFile || arg('--vs');
  const rows = ref && fs.existsSync(ref) ? fs.readFileSync(ref, 'utf8').split('\n').filter((l) => /\| raw \d+ \| gzip \d+/.test(l)) : [];
  let delta = '';
  if (rows.length) {
    const last = rows[rows.length - 1], sg = (v) => (v >= 0 ? '+' : '') + n(v);
    const dr = raw - Number(/raw (\d+)/.exec(last)[1]), dg = gz - Number(/gzip (\d+)/.exec(last)[1]);
    delta = `raw ${sg(dr)} gzip ${sg(dg)} vs ${last.split(' | ')[1]}`;
    if (allow) {
      const over = dr - Math.round(Number(allow) * 1000);
      delta += `, allowance ${allow} KB ${over > 0 ? `OVER by ${n(over)} B` : 'OK'}`;
      if (over > 0) problems.push(`js/ raw grew ${n(dr)} B: ${n(over)} B over the ${allow} KB allowance (D46: trim, or the steward rebalances)`);
    }
    console.log(`package --lint: ${delta}`);
  } else if (allow) problems.push('--allow needs --vs or --size-log naming a size log with at least one row');
  if (logFile) {
    let rev = '?';
    try { rev = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { rev = '?'; }
    const label = arg('--label') || rev;
    fs.appendFileSync(logFile, `${new Date().toISOString().slice(0, 16).replace('T', ' ')} | ${label} | ${rev} | ${js.length} files | raw ${raw} | gzip ${gz} | concat-gzip ${cat}${delta ? ' | ' + delta : ''}\n`);
    console.log(`package --lint: size row appended to ${logFile}`);
  }
  for (const p of problems) console.error('package --lint: ' + p);
  console.log(problems.length ? `package --lint: FAIL (${problems.length})` : 'package --lint: OK');
  return problems.length ? 1 : 0;
}

// Rebuild artifact.html from index.html first so both shells match.
execFileSync(process.execPath, [path.join(ROOT, 'tools/build-artifact.js')], { stdio: 'inherit', cwd: ROOT });

// the shipped file list (dist/ mirrors it) and its build stamp
const SHIP = ['index.html', 'artifact.html', 'manifest.webmanifest', 'sw.js'];
for (const dir of ['css', 'js', 'icons']) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).sort()) {
    if (fs.statSync(path.join(ROOT, dir, f)).isFile()) SHIP.push(`${dir}/${f}`);
  }
}
const STAMP_RE = /\n\/\/ build [0-9a-f]{64}\n?$/;
const swVersion = (src) => (/\bconst\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(src) || [])[1] || null;
const hash = crypto.createHash('sha256');
for (const rel of SHIP) {
  let buf = fs.readFileSync(path.join(ROOT, rel));
  if (rel === 'sw.js') buf = Buffer.from(String(buf).replace(STAMP_RE, '\n'));
  hash.update(rel + '\0').update(buf).update('\0');
}
const BUILD = hash.digest('hex');
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const VERSION = swVersion(swSrc);
let prevSw = null;
try { prevSw = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8'); } catch { prevSw = null; }
if (prevSw) {
  const prevVersion = swVersion(prevSw);
  const prevBuild = (/\n\/\/ build ([0-9a-f]{64})\n?$/.exec(prevSw) || [])[1] || null;
  if (prevVersion === VERSION && prevBuild !== BUILD) {
    console.error(`sw.js VERSION is still '${VERSION}' but the build changed (previous dist/sw.js stamp ${prevBuild ? prevBuild.slice(0, 12) : 'none'} → ${BUILD.slice(0, 12)}).`
      + '\nBump VERSION in sw.js for this release (ARCHITECTURE §15.4 release rule), or delete dist/ if the previous build never shipped. dist/ is unchanged.');
    process.exit(1);
  }
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const copy = (rel) => {
  const src = path.join(ROOT, rel);
  const dst = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return fs.statSync(dst).size;
};

let bytes = 0;
const files = [];
for (const rel of SHIP) { bytes += copy(rel); files.push(rel); }
// the build stamp ends dist/sw.js (its bytes change with any shipped file, so the browser installs the new worker)
{
  const dst = path.join(DIST, 'sw.js');
  const stamped = String(fs.readFileSync(dst, 'utf8')).replace(STAMP_RE, '\n').replace(/\n*$/, '\n') + `// build ${BUILD}\n`;
  fs.writeFileSync(dst, stamped);
  bytes += stamped.length - fs.statSync(path.join(ROOT, 'sw.js')).size;
}

if (process.argv.includes('--check')) {
  const sw = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8');
  // every './…' file path sw.js names (the PRECACHE list and the shell fallbacks), once each (round 4: the count printed
  // below used to include the three repeated './index.html' fallbacks)
  const listed = [...new Set([...sw.matchAll(/["'](\.\/[^"']+)["']/g)].map((m) => m[1].replace(/^\.\//, '')).filter((p) => p && !p.endsWith('/')))];
  const missing = listed.filter((p) => !fs.existsSync(path.join(DIST, p)));
  const jsFiles = files.filter((f) => f.startsWith('js/'));
  const notCached = jsFiles.filter((f) => !listed.includes(f));
  if (missing.length || notCached.length) {
    console.error('sw.js precache problems:', { missing, notCached });
    process.exit(1);
  }
  const version = (/\bconst\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(sw) || [])[1] || '?';
  console.log(`sw.js precache OK (${listed.length} files, all present in dist/; every js/ file listed; cache version ${version}; build ${BUILD.slice(0, 12)})`);
}

console.log(`dist/ ready: ${files.length} files, ${(bytes / 1024).toFixed(0)} KB`);
