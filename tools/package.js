#!/usr/bin/env node
// Builds dist/ — exactly the files a static host needs to serve Gate Rush as an installable web app (PWA).
// Usage: node tools/package.js            → dist/ (index.html, artifact.html, manifest, sw.js, css/, js/, icons/)
//        node tools/package.js --check    → also verifies every file sw.js pre-caches exists in dist/
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

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
