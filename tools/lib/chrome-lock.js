// tools/lib/chrome-lock.js — machine-wide Chrome lock and node slots for the repo tools (r8 build protocol, D24).
//
// Chrome lock: ONE headless Chrome process tree at a time on the build machine. The lock file named by the environment
// variable GR_CHROME_LOCK holds JSON { pid, owner, t } (a bare PID number is also understood); it is taken with an
// exclusive create and is stale when its PID is no longer alive, or when it is unparseable and older than 60 s — a
// stale lock is removed and the take retried. A waiter polls every 3 s and logs '[chrome.lock] waiting; held by …'
// (stderr) when it starts waiting and once a minute after that. The algorithm and file format are those of the frozen
// balance harness (E:/Temp/claude/r8build/harness/lib/chrome-lock.mjs is the same lock), so a repo tool and a harness
// launcher wait for each other.
//
// Node slots: at most GR_HEAVY_SLOTS (default 2) node jobs longer than about 10 s machine-wide. GR_HEAVY_LOCK is a file
// prefix; slot i is the lock file `<prefix>.<i>.lock` with the same JSON, staleness and polling. A Chrome job takes its
// node slot FIRST and the Chrome lock second, so nothing ever waits for a slot while holding Chrome.
//
// Both are opt-in: with the variable unset (a player's or contributor's machine) every call is a no-op, so the repo
// hard-codes no machine path. Locks this process holds are released on exit / SIGINT / SIGTERM / SIGBREAK; only a lock
// whose PID is this process is ever released.
//
//   import { acquireHeavySlot, acquireChromeLock, releaseChromeLock, releaseHeavySlot } from './lib/chrome-lock.js';
//   await acquireHeavySlot('smoke'); await acquireChromeLock('smoke'); … releaseChromeLock(); releaseHeavySlot();
import fs from 'node:fs';

const STALE_UNPARSEABLE_MS = 60000;   // an unparseable lock file older than this is stale (D24)
const LOG_EVERY_MS = 60000;           // a waiter repeats its 'waiting' line this often
const DEFAULT_POLL_MS = 3000;         // poll interval (GR_LOCK_POLL_MS overrides it, for the lock self-test only)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pollMs = () => { const v = Number(process.env.GR_LOCK_POLL_MS); return v > 0 ? v : DEFAULT_POLL_MS; };

/** True while `pid` is a live process (EPERM = alive but not ours). */
function alive(pid) {
  if (!(pid > 0)) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** { pid, age, txt } of a lock file, or null when it does not exist. */
function readLock(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').trim();
    let pid = NaN;
    try { const j = JSON.parse(txt); pid = typeof j === 'number' ? j : +(j && j.pid); } catch (_) { pid = parseInt(txt, 10); }
    let age = 0;
    try { age = Date.now() - fs.statSync(file).mtimeMs; } catch (_) { /* vanished meanwhile */ }
    return { pid, age, txt };
  } catch (_) { return null; }
}

/** Exclusive create; true when this process now owns `file`. */
function tryCreate(file, owner) {
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, owner, t: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

/**
 * Inspects an existing lock: 'mine' (this PID), 'stale' (removed here — dead PID, or unparseable and > 60 s old) or
 * 'busy'. The stale file is re-read just before the unlink, so a lock re-created by a racing process meanwhile survives.
 */
function inspect(file) {
  const l = readLock(file);
  if (!l) return 'stale';                                       // gone meanwhile: retry the create
  if (Number.isFinite(l.pid) && l.pid === process.pid) return 'mine';
  const stale = Number.isFinite(l.pid) ? !alive(l.pid) : l.age > STALE_UNPARSEABLE_MS;
  if (!stale) return 'busy';
  const again = readLock(file);
  if (again && again.txt === l.txt) {
    try { fs.unlinkSync(file); process.stderr.write(`[lock] removed stale ${file}: ${l.txt.slice(0, 80)}\n`); } catch (_) { /* raced */ }
  }
  return 'stale';
}

// ---------------------------------------------------------------------------------------------
// Chrome lock
// ---------------------------------------------------------------------------------------------

let chromeHeld = null;   // path of the Chrome lock this process holds

/** The Chrome lock path (GR_CHROME_LOCK), or null when locking is off. */
export function chromeLockPath() {
  const p = process.env.GR_CHROME_LOCK;
  return p ? p : null;
}

/** Waits for and takes the Chrome lock (no-op without GR_CHROME_LOCK or when already held). Resolves with the path. */
export async function acquireChromeLock(owner = 'repo-tool') {
  const file = chromeLockPath();
  if (!file || chromeHeld) return chromeHeld;
  const t0 = Date.now();
  let logged = 0;
  for (;;) {
    if (tryCreate(file, owner)) break;
    const st = inspect(file);
    if (st === 'mine') break;
    if (st === 'stale') continue;
    if (Date.now() - logged >= LOG_EVERY_MS) {
      logged = Date.now();
      const l = readLock(file);
      process.stderr.write(`[chrome.lock] waiting; held by ${l ? l.txt.slice(0, 120) : '?'}\n`);
    }
    await sleep(pollMs());
  }
  chromeHeld = file;
  if (Date.now() - t0 > 1000) process.stderr.write(`[chrome.lock] acquired after ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  return file;
}

/** Releases the Chrome lock if this process holds it. */
export function releaseChromeLock() {
  const file = chromeHeld;
  if (!file) return;
  chromeHeld = null;
  const l = readLock(file);
  if (l && l.pid === process.pid) { try { fs.unlinkSync(file); } catch (_) { /* already gone */ } }
}

// ---------------------------------------------------------------------------------------------
// Node slots
// ---------------------------------------------------------------------------------------------

let slotHeld = null;     // path of the node slot this process holds

/** The node-slot prefix (GR_HEAVY_LOCK), or null when slots are off. */
export function heavyLockPrefix() {
  const p = process.env.GR_HEAVY_LOCK;
  return p ? p : null;
}

/** Number of machine-wide node slots (GR_HEAVY_SLOTS, default 2). */
function slotCount() {
  const n = parseInt(process.env.GR_HEAVY_SLOTS || '', 10);
  return n > 0 ? n : 2;
}

/** Waits for and takes a node slot (no-op without GR_HEAVY_LOCK or when one is held). Resolves with its path. */
export async function acquireHeavySlot(owner = 'repo-tool') {
  const prefix = heavyLockPrefix();
  if (!prefix || slotHeld) return slotHeld;
  const n = slotCount();
  const t0 = Date.now();
  let logged = 0;
  for (;;) {
    for (let i = 1; i <= n && !slotHeld; i++) {
      const file = `${prefix}.${i}.lock`;
      if (tryCreate(file, owner)) { slotHeld = file; break; }
      const st = inspect(file);
      if (st === 'mine') { slotHeld = file; break; }
      if (st === 'stale' && tryCreate(file, owner)) { slotHeld = file; break; }
    }
    if (slotHeld) break;
    if (Date.now() - logged >= LOG_EVERY_MS) {
      logged = Date.now();
      const held = [];
      for (let i = 1; i <= n; i++) { const l = readLock(`${prefix}.${i}.lock`); if (l) held.push(l.txt.slice(0, 80)); }
      process.stderr.write(`[nodeheavy] waiting for a node slot; held by ${held.join(' | ') || '?'}\n`);
    }
    await sleep(pollMs());
  }
  if (Date.now() - t0 > 1000) process.stderr.write(`[nodeheavy] slot acquired after ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  return slotHeld;
}

/** Releases the node slot if this process holds it. */
export function releaseHeavySlot() {
  const file = slotHeld;
  if (!file) return;
  slotHeld = null;
  const l = readLock(file);
  if (l && l.pid === process.pid) { try { fs.unlinkSync(file); } catch (_) { /* already gone */ } }
}

// release on every exit path (only locks whose PID is this process)
process.on('exit', () => { releaseChromeLock(); releaseHeavySlot(); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { releaseChromeLock(); releaseHeavySlot(); process.exit(130); });
}
