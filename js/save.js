// js/save.js — SaveStore: versioned, guarded, additively-migrated persistence (ARCHITECTURE §6.15, §12).
//
// Responsibilities
//   • one JSON blob under `gaterush.v1` (util.storage: guarded localStorage with a Map fallback)
//   • defaults → load → additive migration (never throws, never loses a known field)
//   • debounced flush (250 ms) + immediate flush on visibilitychange(hidden) / pagehide
//   • `volatile` = the store is memory-only or a write failed (ui shows STRINGS.volatileSave once)
//   • derived `profile()` from UPGRADES ranks; `load()`, `setUpgrade()` and `reset()` reassign ctx.profile
//   • event listeners ONLY call flush() (§5): every mutation is a direct method call from level / ui
//
// Rules honoured (§14): no console.log, no Math.random, every browser API guarded, private fields `_`,
// all tuning numbers from data.js (the two persistence literals below are flagged DATA-MISSING).
import { UPGRADES } from './data.js';
import { storage, warnOnce, clamp } from './util.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** localStorage key — ARCHITECTURE §12 "gaterush.v1". */
const SAVE_KEY = 'gaterush.v1';
/** Current schema version (ARCHITECTURE §12 `v: 1`). */
const SAVE_VERSION = 1;
// DATA-MISSING: SAVE.flushDebounceMs — ARCHITECTURE §6.15 / §12 "flush() is debounced 250 ms"
const FLUSH_DEBOUNCE_MS = 250;
// DATA-MISSING: SAVE.maxLevelKey — sanity cap for level ids accepted into data.levels (campaign loops past LEVELS.count)
const MAX_LEVEL_KEY = 9999;

/** Upgrade id (UPGRADES key) → profile field (ARCHITECTURE §3 ctx.profile). */
const PROFILE_FIELD = Object.freeze({ squad: 'startSquad', fireRate: 'fireRate', damage: 'damage', coinMult: 'coinMult', bossDamage: 'bossDamage' });
/** Upgrade ids in UPGRADES order (the only five that exist; iterating UPGRADES is the contract). */
const UPGRADE_IDS = Object.freeze(Object.keys(UPGRADES));

/** Quality values a save may hold (QUALITY_TIERS.order + 'auto'); anything else → 'auto'. */
const QUALITY_VALUES = Object.freeze(['auto', 'low', 'med', 'high']);

/** Events whose only effect on the save store is a flush() (ARCHITECTURE §5 "save subscribes … ONLY to call flush()"). */
const FLUSH_EVENTS = Object.freeze(['level:complete', 'level:failed', 'endless:end', 'shop:buy', 'settings:change', 'hint:show']);

/** Reused `save:change` payload (§5: payloads are module-level objects, listeners must not retain them). */
const P_CHANGE = { reason: '' };

// ---------------------------------------------------------------------------------------------
// Defaults and migration (ARCHITECTURE §12)
// ---------------------------------------------------------------------------------------------

/** Fresh defaults object — ARCHITECTURE §12 verbatim. Always a new object (saves are mutated in place). */
export function defaultSave(now) {
  const t = Number.isFinite(now) ? now : 0;
  const upgrades = {};
  for (let i = 0; i < UPGRADE_IDS.length; i++) upgrades[UPGRADE_IDS[i]] = 0;
  return {
    v: SAVE_VERSION,
    createdAt: t,
    updatedAt: t,
    coins: 0,
    upgrades,                                    // ranks 0..UPGRADES[id].ranks
    highestUnlocked: 1,                          // highest playable level
    levels: {},                                  // "1": { stars, bestSurvivors, bestScore, bestCoins, clears }
    endless: { bestDistance: 0, bestScore: 0, runs: 0 },
    hints: {},                                   // id: true
    // round 5 (lead decision): music defaults to 70 (was 80). Only a profile without a stored music value gets it: the
    // additive fill (fillDefaults) never overwrites a stored value, so a player's saved 80 (or any other) is kept
    settings: { sound: 100, music: 70, haptics: true, quality: 'auto', reducedMotion: null, hcGates: false, largeText: false, sensitivity: 1 },
    stats: { runs: 0, kills: 0, gatesPassed: 0, coinsEarned: 0, playSeconds: 0 },
    lastRunIncome: 0,
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Finite number ≥ min (default 0), else `fallback`. */
function num(v, fallback, min) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
  if (!Number.isFinite(n)) return fallback;
  return min !== undefined && n < min ? min : n;
}

/** Non-negative integer, else fallback. */
function uint(v, fallback) {
  const n = num(v, NaN, 0);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/**
 * Additive fill: every key of `defaults` that is missing (or of the wrong shape) in `target` is copied
 * from the defaults; nested plain objects recurse; unknown extra keys in `target` are left alone so a
 * newer build's fields survive a round trip through an older one.
 */
function fillDefaults(target, defaults) {
  const keys = Object.keys(defaults);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const d = defaults[k];
    const t = target[k];
    if (isPlainObject(d)) {
      if (!isPlainObject(t)) target[k] = cloneDefault(d);
      else fillDefaults(t, d);
    } else if (t === undefined) {
      target[k] = d;
    }
  }
  return target;
}

function cloneDefault(d) {
  if (!isPlainObject(d)) return d;
  const out = {};
  const keys = Object.keys(d);
  for (let i = 0; i < keys.length; i++) out[keys[i]] = cloneDefault(d[keys[i]]);
  return out;
}

/**
 * MIGRATIONS[v] upgrades a blob from schema v to v + 1. Index 0 (v0 → v1) is the additive fill; a future
 * `v: 2` adds MIGRATIONS[1] (ARCHITECTURE §12). Each step receives the live object and mutates it.
 */
const MIGRATIONS = [
  function v0toV1(data, defaults) {
    fillDefaults(data, defaults);
  },
];

/**
 * Brings any parsed blob to the current schema without ever throwing: version steps, additive fill,
 * then per-field sanitation (types, ranges) so a hand-edited or corrupted save cannot poison the game.
 */
export function migrate(input, now) {
  const defaults = defaultSave(now);
  const data = isPlainObject(input) ? input : {};
  let v = uint(data.v, 0);
  while (v < SAVE_VERSION) {
    const step = MIGRATIONS[v];
    if (typeof step === 'function') step(data, defaults);
    v++;
    data.v = v;
  }
  // a blob from a NEWER build keeps its version but still gets every current default filled in
  fillDefaults(data, defaults);
  sanitize(data, defaults, now);
  return data;
}

/** Type/range sanitation of every known field (in place). */
function sanitize(d, defaults, now) {
  d.v = Math.max(SAVE_VERSION, uint(d.v, SAVE_VERSION));
  d.createdAt = num(d.createdAt, defaults.createdAt, 0);
  d.updatedAt = num(d.updatedAt, defaults.updatedAt, 0);
  if (d.createdAt === 0 && Number.isFinite(now)) d.createdAt = now;
  d.coins = Math.round(num(d.coins, 0, 0));
  d.lastRunIncome = Math.round(num(d.lastRunIncome, 0, 0));

  // upgrades: only the five UPGRADES ids, ranks clamped to [0, ranks]
  const up = isPlainObject(d.upgrades) ? d.upgrades : (d.upgrades = {});
  for (let i = 0; i < UPGRADE_IDS.length; i++) {
    const id = UPGRADE_IDS[i];
    up[id] = clamp(uint(up[id], 0), 0, UPGRADES[id].ranks);
  }

  // levels: dictionary of per-level records
  if (!isPlainObject(d.levels)) d.levels = {};
  const levelKeys = Object.keys(d.levels);
  let cleared = 0;                               // largest level key with a clear (stars ≥ 1 or a counted clear)
  for (let i = 0; i < levelKeys.length; i++) {
    const key = levelKeys[i];
    const n = uint(key, 0);
    const rec = d.levels[key];
    if (n < 1 || n > MAX_LEVEL_KEY || !isPlainObject(rec)) { delete d.levels[key]; continue; }
    rec.stars = clamp(uint(rec.stars, 0), 0, 3);
    rec.bestSurvivors = uint(rec.bestSurvivors, 0);
    rec.bestScore = uint(rec.bestScore, 0);
    rec.bestCoins = uint(rec.bestCoins, 0);
    rec.clears = uint(rec.clears, 0);
    if ((rec.stars >= 1 || rec.clears >= 1) && n > cleared) cleared = n;
  }

  // round-2 QA UI-24: highestUnlocked is what recordLevel can have produced — the level after the largest cleared
  // one (1 when nothing is cleared), never above MAX_LEVEL_KEY — so a hand-edited or corrupted value
  // (e.g. 2 000 000) cannot hang the LEVELS screen or PLAY into a level no clear unlocked
  d.highestUnlocked = clamp(uint(d.highestUnlocked, 1), 1, Math.min(MAX_LEVEL_KEY, cleared + 1));

  // endless
  if (!isPlainObject(d.endless)) d.endless = cloneDefault(defaults.endless);
  d.endless.bestDistance = uint(d.endless.bestDistance, 0);
  d.endless.bestScore = uint(d.endless.bestScore, 0);
  d.endless.runs = uint(d.endless.runs, 0);

  // hints: id → true (anything falsy is dropped)
  if (!isPlainObject(d.hints)) d.hints = {};
  const hintKeys = Object.keys(d.hints);
  for (let i = 0; i < hintKeys.length; i++) {
    if (d.hints[hintKeys[i]]) d.hints[hintKeys[i]] = true;
    else delete d.hints[hintKeys[i]];
  }

  // settings
  if (!isPlainObject(d.settings)) d.settings = cloneDefault(defaults.settings);
  const s = d.settings;
  s.sound = clamp(Math.round(num(s.sound, defaults.settings.sound)), 0, 100);
  s.music = clamp(Math.round(num(s.music, defaults.settings.music)), 0, 100);
  s.haptics = s.haptics === undefined ? defaults.settings.haptics : !!s.haptics;
  s.quality = QUALITY_VALUES.indexOf(s.quality) === -1 ? defaults.settings.quality : s.quality;
  s.reducedMotion = (s.reducedMotion === null || s.reducedMotion === undefined) ? null : !!s.reducedMotion;
  s.hcGates = !!s.hcGates;
  s.largeText = !!s.largeText;
  const sens = num(s.sensitivity, defaults.settings.sensitivity);
  s.sensitivity = sens > 0 ? sens : defaults.settings.sensitivity;

  // stats
  if (!isPlainObject(d.stats)) d.stats = cloneDefault(defaults.stats);
  const statKeys = Object.keys(defaults.stats);
  for (let i = 0; i < statKeys.length; i++) {
    const k = statKeys[i];
    d.stats[k] = num(d.stats[k], 0, 0);
  }
}

/** Coerces one settings value to the type its default has (ARCHITECTURE §12 settings shape). */
function coerceSetting(key, value, defaults) {
  switch (key) {
    case 'sound':
    case 'music':
      return clamp(Math.round(num(value, defaults[key])), 0, 100);
    case 'haptics':
    case 'hcGates':
    case 'largeText':
      return !!value;
    case 'reducedMotion':
      return (value === null || value === undefined) ? null : !!value;
    case 'quality': {
      const q = String(value).toLowerCase();
      return QUALITY_VALUES.indexOf(q) === -1 ? defaults.quality : q;
    }
    case 'sensitivity': {
      const v = num(value, defaults.sensitivity);
      return v > 0 ? v : defaults.sensitivity;
    }
    default:
      return value;
  }
}

function nowMs() {
  try { return Date.now(); } catch (_) { return 0; }
}

/** Backup key for a blob that failed to parse (kept once so a corrupted save can be recovered by hand). */
const CORRUPT_KEY = SAVE_KEY + '.corrupt';

/** Frozen §12 settings defaults (key whitelist + coercion fallbacks for setSetting). */
const SETTINGS_DEFAULTS = Object.freeze(defaultSave(0).settings);

/** Guarded timer helpers (node / stripped hosts may lack them; then flush() writes synchronously). */
function setTimer(fn, ms) {
  try {
    if (typeof setTimeout === 'function') return setTimeout(fn, ms);
  } catch (_) { /* fall through */ }
  return null;
}

function clearTimer(id) {
  if (id === null) return;
  try { if (typeof clearTimeout === 'function') clearTimeout(id); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------
// SaveStore (ARCHITECTURE §6.15)
// ---------------------------------------------------------------------------------------------

export class SaveStore {
  constructor(ctx) {
    this.ctx = ctx;
    this._data = defaultSave(nowMs());           // usable before load() (stub harnesses, early reads)
    this._loaded = false;
    this._dirty = false;
    this._timer = null;
    this._volatile = !!storage.volatile;
    this._unsubs = [];                           // event-bus unsubscribe functions
    this._domBound = false;
    this._onTimer = () => { this._timer = null; this._write(); };
    this._onFlushEvent = () => { this.flush(); };
    this._onVisibility = () => {
      let hidden = false;
      try { hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'; } catch (_) { hidden = false; }
      if (hidden) this.flushNow();
    };
    this._onPageHide = () => { this.flushNow(); };
  }

  /** Optional: installs the flush-only listeners (load() does the same). Returns this (§14). */
  init() {
    this._bind();
    return this;
  }

  // -------------------------------------------------------------------------------------------
  // Loading / persistence
  // -------------------------------------------------------------------------------------------

  /** Reads `gaterush.v1`, migrates additively, never throws. Reassigns ctx.profile. */
  load() {
    const now = nowMs();
    let raw = null;
    try { raw = storage.get(SAVE_KEY); } catch (_) { raw = null; }
    let parsed = null;
    let fresh = false;
    if (raw === null || raw === undefined || raw === '') {
      fresh = true;
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        parsed = null;
        warnOnce('save.corrupt', 'Save data was unreadable; starting a fresh profile (backup kept under ' + CORRUPT_KEY + ')');
        try { storage.set(CORRUPT_KEY, raw); } catch (_) { /* best effort */ }
      }
      if (!isPlainObject(parsed)) fresh = true;
    }
    let data;
    try {
      data = fresh ? defaultSave(now) : migrate(parsed, now);
    } catch (_) {
      data = defaultSave(now);
      fresh = true;
    }
    this._data = data;
    this._loaded = true;
    this._volatile = this._volatile || !!storage.volatile;
    this._bind();
    this._syncProfile();
    // a fresh or migrated profile is written back once (createdAt, filled defaults)
    let same = false;
    if (!fresh) {
      try { same = raw === JSON.stringify(data); } catch (_) { same = false; }
    }
    if (!same) this.flush();
    this._changed('load');
  }

  /** Debounced (FLUSH_DEBOUNCE_MS) guarded write; the first call in a quiet period arms the timer. */
  flush() {
    this._dirty = true;
    if (this._timer !== null) return;
    this._timer = setTimer(this._onTimer, FLUSH_DEBOUNCE_MS);
    if (this._timer === null) this._write();      // no timers available → write synchronously
  }

  /** Immediate guarded write of pending changes (visibilitychange hidden, pagehide, reset, dispose). */
  flushNow() {
    clearTimer(this._timer);
    this._timer = null;
    if (this._dirty) this._write();
  }

  /** Current save blob (live object; callers other than this store treat it as read-only). */
  get data() { return this._data; }

  /** Live settings object (§12 shape). The CALLER (ui) emits settings:change after setSetting. */
  get settings() { return this._data.settings; }

  /** True when storage is memory-only or a write failed (ui shows STRINGS.volatileSave once). */
  get volatile() { return this._volatile || !!storage.volatile; }

  /** Whether load() has run. */
  get loaded() { return this._loaded; }

  // -------------------------------------------------------------------------------------------
  // Derived profile
  // -------------------------------------------------------------------------------------------

  /** { startSquad, fireRate, damage, coinMult, bossDamage, ranks } from UPGRADES and data.upgrades (fresh object). */
  profile() {
    const up = this._data.upgrades || {};
    const ranks = {};
    const out = { startSquad: 0, fireRate: 0, damage: 0, coinMult: 0, bossDamage: 0, ranks };
    for (let i = 0; i < UPGRADE_IDS.length; i++) {
      const id = UPGRADE_IDS[i];
      const u = UPGRADES[id];
      const r = clamp(uint(up[id], 0), 0, u.ranks);
      ranks[id] = r;
      out[PROFILE_FIELD[id]] = u.effect(r);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Mutations (direct calls from level / ui; never from event listeners)
  // -------------------------------------------------------------------------------------------

  /** Credits n coins (rounded; non-positive / non-finite amounts are ignored). */
  addCoins(n) {
    const v = Math.round(num(n, 0));
    if (v <= 0) return;
    this._data.coins = Math.max(0, uint(this._data.coins, 0) + v);
    this._commit('coins');
  }

  /** Spends n coins if affordable; returns false (and changes nothing) otherwise. */
  spend(n) {
    const v = Math.round(num(n, NaN));
    if (!Number.isFinite(v) || v < 0) return false;
    const have = uint(this._data.coins, 0);
    if (have < v) return false;
    if (v === 0) return true;
    this._data.coins = have - v;
    this._commit('coins');
    return true;
  }

  /** Sets an upgrade rank (clamped to [0, UPGRADES[id].ranks]); reassigns ctx.profile. */
  setUpgrade(id, rank) {
    const u = UPGRADES[id];
    if (!u || PROFILE_FIELD[id] === undefined) {
      warnOnce('save.upgrade.' + id, 'SaveStore.setUpgrade: unknown upgrade id "' + id + '"');
      return;
    }
    const r = clamp(uint(rank, 0), 0, u.ranks);
    this._data.upgrades[id] = r;
    this._syncProfile();
    this._commit('upgrade');
  }

  /** Keeps per-level bests; a clear (stars ≥ 1) counts and unlocks level + 1. */
  recordLevel(level, r) {
    const n = uint(level, 0);
    if (n < 1 || n > MAX_LEVEL_KEY) return;
    const res = isPlainObject(r) ? r : {};
    const stars = clamp(uint(res.stars, 0), 0, 3);
    const levels = this._data.levels;
    const key = String(n);
    let rec = levels[key];
    if (!isPlainObject(rec)) {
      rec = { stars: 0, bestSurvivors: 0, bestScore: 0, bestCoins: 0, clears: 0 };
      levels[key] = rec;
    }
    rec.stars = Math.max(uint(rec.stars, 0), stars);
    rec.bestSurvivors = Math.max(uint(rec.bestSurvivors, 0), uint(res.survivors, 0));
    rec.bestScore = Math.max(uint(rec.bestScore, 0), uint(res.score, 0));
    rec.bestCoins = Math.max(uint(rec.bestCoins, 0), uint(res.coins, 0));
    if (stars >= 1) {
      rec.clears = uint(rec.clears, 0) + 1;
      const next = Math.min(MAX_LEVEL_KEY, n + 1);
      if (next > this._data.highestUnlocked) this._data.highestUnlocked = next;
    }
    this._commit('level');
  }

  /** Endless bests (distance in whole metres, score) and runs++. */
  recordEndless(r) {
    const res = isPlainObject(r) ? r : {};
    const e = this._data.endless;
    e.bestDistance = Math.max(uint(e.bestDistance, 0), Math.round(num(res.distance, 0, 0)));
    e.bestScore = Math.max(uint(e.bestScore, 0), Math.round(num(res.score, 0, 0)));
    e.runs = uint(e.runs, 0) + 1;
    this._commit('endless');
  }

  /** Adds every finite, positive field of `partial` into data.stats (known keys only). */
  addStats(partial) {
    if (!isPlainObject(partial)) return;
    const stats = this._data.stats;
    let changed = false;
    const keys = Object.keys(stats);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = num(partial[k], NaN);
      if (!Number.isFinite(v) || v <= 0) continue;
      stats[k] = num(stats[k], 0, 0) + v;
      changed = true;
    }
    if (changed) this._commit('stats');
  }

  /** Marks a once-ever hint as shown. */
  markHint(id) {
    if (typeof id !== 'string' || id === '') return;
    if (this._data.hints[id] === true) return;
    this._data.hints[id] = true;
    this._commit('hint');
  }

  /** True when the hint was already shown once. */
  hintDone(id) {
    return typeof id === 'string' && this._data.hints[id] === true;
  }

  /** Stores one setting (coerced to its §12 type). Unknown keys are ignored. The caller emits settings:change. */
  setSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key)) {
      warnOnce('save.setting.' + key, 'SaveStore.setSetting: unknown setting "' + key + '"');
      return;
    }
    const s = this._data.settings;
    const v = coerceSetting(key, value, SETTINGS_DEFAULTS);
    if (s[key] === v) return;
    s[key] = v;
    this._commit('settings');
  }

  /** Remembers the last run's payout (shop "+N runs" estimate). */
  setLastIncome(n) {
    const v = Math.max(0, Math.round(num(n, 0)));
    if (v === this._data.lastRunIncome) return;
    this._data.lastRunIncome = v;
    this._commit('income');
  }

  /** Back to defaults, written immediately (ui reloads right after); reassigns ctx.profile. */
  reset() {
    clearTimer(this._timer);
    this._timer = null;
    this._data = defaultSave(nowMs());
    this._syncProfile();
    this._dirty = true;
    this._write();
    this._changed('reset');
  }

  /** Writes pending changes and removes every listener this store added. */
  dispose() {
    this.flushNow();
    for (let i = 0; i < this._unsubs.length; i++) {
      try { this._unsubs[i](); } catch (_) { /* ignore */ }
    }
    this._unsubs.length = 0;
    if (this._domBound) {
      try {
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', this._onVisibility);
          document.removeEventListener('freeze', this._onPageHide);
        }
      } catch (_) { /* ignore */ }
      try {
        if (typeof window !== 'undefined') window.removeEventListener('pagehide', this._onPageHide);
      } catch (_) { /* ignore */ }
      this._domBound = false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------------------------

  /** Flush-only listeners: bus events (end of run, purchases, settings, hints) and page lifecycle. Idempotent. */
  _bind() {
    const events = this.ctx && this.ctx.events;
    if (this._unsubs.length === 0 && events && typeof events.on === 'function') {
      for (let i = 0; i < FLUSH_EVENTS.length; i++) {
        const off = events.on(FLUSH_EVENTS[i], this._onFlushEvent);
        if (typeof off === 'function') this._unsubs.push(off);
      }
    }
    if (this._domBound) return;
    let bound = false;
    try {
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this._onVisibility);
        document.addEventListener('freeze', this._onPageHide);     // Page Lifecycle API (Chromium); never fires elsewhere
        bound = true;
      }
    } catch (_) { /* ignore */ }
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', this._onPageHide);
        bound = true;
      }
    } catch (_) { /* ignore */ }
    this._domBound = bound;
  }

  _syncProfile() {
    if (this.ctx) this.ctx.profile = this.profile();
  }

  /** Schedule a write and announce the change. */
  _commit(reason) {
    this.flush();
    this._changed(reason);
  }

  _changed(reason) {
    const events = this.ctx && this.ctx.events;
    if (!events || typeof events.emit !== 'function') return;
    P_CHANGE.reason = reason;
    events.emit('save:change', P_CHANGE);
  }

  /** Serialises and writes; a failure keeps the in-memory copy and marks the store volatile. */
  _write() {
    this._dirty = false;
    const d = this._data;
    d.updatedAt = nowMs();
    let json = null;
    try {
      json = JSON.stringify(d);
    } catch (_) {
      json = null;
    }
    if (json === null) {
      warnOnce('save.serialise', 'SaveStore: the save could not be serialised; keeping it in memory');
      this._volatile = true;
      return;
    }
    let ok = false;
    try { ok = storage.set(SAVE_KEY, json); } catch (_) { ok = false; }
    if (!ok) this._volatile = true;
  }
}
