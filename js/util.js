// js/util.js — Gate Rush foundation helpers (ARCHITECTURE §6.1).
// Pure helpers plus a few guarded browser probes. This file is imported by node
// tools as well as by the browser shells, so every navigator/window/document
// access lives inside a `typeof` check or a try/catch — nothing here touches a
// browser global unconditionally at import time.
import { Vector3, Quaternion, Matrix4 } from 'three';

// ---------------------------------------------------------------------------
// Random numbers — mulberry32 (deterministic, 32-bit state, [0, 1) output)
// ---------------------------------------------------------------------------

/**
 * Returns a mulberry32 generator closed over its own state.
 * @param {number} seed any finite number; coerced to uint32
 * @returns {() => number} next() in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded RNG (mulberry32). `ctx.rng` drives every gameplay roll, `ctx.rngFx`
 * (= rng.fork(7)) every cosmetic one, so cosmetics never perturb gameplay.
 * All methods are allocation-free except shuffle (in place, no allocation) and
 * fork (one new Rng, called once per run).
 */
export class Rng {
  /** @param {number} seed */
  constructor(seed) {
    this._seed = (Number.isFinite(seed) ? seed : 1) >>> 0;
    this._a = this._seed;
  }

  /** The seed this generator was constructed with (uint32). */
  get seed() { return this._seed; }

  /** Re-seeds and restarts the sequence (used by tests and the level restart). */
  reseed(seed) {
    this._seed = (Number.isFinite(seed) ? seed : 1) >>> 0;
    this._a = this._seed;
    return this;
  }

  /** @returns {number} uniform in [0, 1) */
  next() {
    this._a = (this._a + 0x6D2B79F5) | 0;
    let t = Math.imul(this._a ^ (this._a >>> 15), 1 | this._a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], both inclusive (arguments may arrive swapped). */
  int(min, max) {
    if (min > max) { const s = min; min = max; max = s; }
    min = Math.ceil(min); max = Math.floor(max);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  range(min, max) { return min + (max - min) * this.next(); }

  /** One element of a non-empty array (undefined for an empty one). */
  pick(arr) {
    const n = arr.length;
    if (n === 0) return undefined;
    return arr[Math.floor(this.next() * n)];
  }

  /** True with probability p (p ≤ 0 → never, p ≥ 1 → always). */
  chance(p) { return this.next() < p; }

  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  /** Independent stream seeded `seed + offset` (uint32 wrap). */
  fork(offset) { return new Rng((this._seed + (offset | 0)) >>> 0); }
}

// ---------------------------------------------------------------------------
// Easing and math helpers
// ---------------------------------------------------------------------------

export const ease = {
  linear(t) { return t; },
  outQuad(t) { return 1 - (1 - t) * (1 - t); },
  outCubic(t) { const u = 1 - t; return 1 - u * u * u; },
  inOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
  // s = 1.70158 is the classic Penner overshoot constant (≈ 10 % overshoot)
  outBack(t, s = 1.70158) { const u = t - 1; return 1 + u * u * ((s + 1) * u + s); },
};

/** Clamps v into [a, b] (a ≤ b assumed). */
export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/** Linear interpolation a → b by t (unclamped). */
export function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Frame-rate independent exponential approach:
 * cur + (target − cur)·(1 − e^(−rate·dt)). rate in 1/s.
 */
export function lerpExp(cur, target, rate, dt) {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** Hermite smoothstep of x across [a, b]; a === b degenerates to a step. */
export function smoothstep(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Rounds to the nearest multiple of 5. */
export function round5(v) { return Math.round(v / 5) * 5; }

/** Rounds to the nearest multiple of 10. */
export function round10(v) { return Math.round(v / 10) * 10; }

/**
 * GDD §4.4 design rounding for gate values: to 1 below 30, to 5 below 100,
 * to 10 at 100 and above (thresholds compared on |v|; sign preserved).
 */
export function roundDesign(v) {
  const m = Math.abs(v);
  if (m < 30) return Math.round(v);
  if (m < 100) return round5(v);
  return round10(v);
}

/** FNV-1a 32-bit string hash → uint32 (stable across sessions). */
export function hashString(s) {
  let h = 0x811C9DC5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Formats a coin amount in full with comma thousands separators: "999", "1,000", "1,130", "12,345", "1,234,567";
 * negative values keep a leading "-". Round 7 (r7, flow-coins:7): every coin pill, price and results line uses it — the
 * "1.1K" header could not tell whether it affords a 1,080 or a 1,130 rank. No Intl: the same output in every locale.
 */
export function fmtCoins(n) {
  n = Math.round(Number.isFinite(n) ? n : 0);
  const neg = n < 0;
  let s = String(Math.abs(n));
  for (let i = s.length - 3; i > 0; i -= 3) s = s.slice(0, i) + ',' + s.slice(i);
  return neg ? '-' + s : s;
}

/**
 * Compact form for a tight label: "999", "1.2K", "12.5K", "250K", "1.3M" (trailing ".0" dropped: "12K"). Round 7: only
 * the LEVELS screen's ENDLESS tile best score uses it (the fmtCoins of rounds 1–6).
 */
export function fmtCompact(n) {
  n = Math.round(Number.isFinite(n) ? n : 0);
  const neg = n < 0;
  const m = Math.abs(n);
  let out;
  if (m <= 999) out = String(m);
  else if (m < 100000) out = trimZero((m / 1000).toFixed(1)) + 'K';
  else if (m < 1000000) out = String(Math.round(m / 1000)) + 'K';
  else if (m < 100000000) out = trimZero((m / 1000000).toFixed(1)) + 'M';
  else out = String(Math.round(m / 1000000)) + 'M';
  return neg ? '-' + out : out;
}

function trimZero(str) {
  return str.endsWith('.0') ? str.slice(0, -2) : str;
}

// Integer hash → [0, 1) used by noise1 (deterministic, no state).
function hashInt01(i) {
  let h = Math.imul(i | 0, 0x27D4EB2D) ^ 0x165667B1;
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  h = Math.imul(h ^ (h >>> 12), 0x297A2D39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * 1-D value noise in [−1, 1], C¹ continuous (smoothstep blend between lattice
 * values), deterministic for a given t. Used by the camera shake and prop
 * jitter; no RNG state involved.
 */
export function noise1(t) {
  const i = Math.floor(t);
  const f = t - i;
  const a = hashInt01(i) * 2 - 1;
  const b = hashInt01(i + 1) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

// ---------------------------------------------------------------------------
// Pool — fixed-capacity, swap-remove, indexed object pool
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity pool of objects created once by `factory(i)` (§14 rule 3).
 * The live set is the dense prefix [0, count); `free` swap-removes so
 * iteration order is not stable across frees. Each pooled object carries a
 * `_poolIndex` field maintained by the pool (do not write it).
 */
export class Pool {
  /**
   * @param {number} capacity number of objects to create up front (never grows)
   * @param {(index:number) => object} factory called once per slot at construction
   */
  constructor(capacity, factory) {
    this._capacity = Math.max(0, capacity | 0);
    this._items = new Array(this._capacity);
    this._count = 0;
    for (let i = 0; i < this._capacity; i++) {
      const obj = factory(i);
      obj._poolIndex = i;
      this._items[i] = obj;
    }
  }

  /** Live object count. */
  get count() { return this._count; }

  /** Total slots. */
  get capacity() { return this._capacity; }

  /** Live object at dense index i (0 ≤ i < count); undefined otherwise. */
  at(i) { return i < this._count ? this._items[i] : undefined; }

  /** Next free object, or null when the pool is exhausted. Allocation-free. */
  alloc() {
    if (this._count >= this._capacity) return null;
    const obj = this._items[this._count];
    obj._poolIndex = this._count;
    this._count++;
    return obj;
  }

  /**
   * Returns obj to the free region by swapping it with the last live object.
   * Returns false (and does nothing) when obj is not currently live.
   */
  free(obj) {
    const i = obj._poolIndex;
    if (i === undefined || i < 0 || i >= this._count || this._items[i] !== obj) return false;
    const last = this._count - 1;
    if (i !== last) {
      const moved = this._items[last];
      this._items[i] = moved;
      moved._poolIndex = i;
      this._items[last] = obj;
      obj._poolIndex = last;
    }
    this._count = last;
    return true;
  }

  /**
   * Calls fn(obj, index) for every live object in dense order. Allocation-free.
   * Freeing the current object inside fn is safe (the loop re-visits the index);
   * freeing any other object is not.
   */
  forEach(fn) {
    for (let i = 0; i < this._count; i++) {
      const before = this._count;
      fn(this._items[i], i);
      if (this._count < before) i--;   // current slot now holds the swapped-in object
    }
  }

  /** Marks every object free (objects are kept for reuse). */
  clear() { this._count = 0; }
}

// ---------------------------------------------------------------------------
// Shared THREE scratch objects (module-level; never retained across calls)
// ---------------------------------------------------------------------------

export const scratch = {
  v3a: new Vector3(),
  v3b: new Vector3(),
  v3c: new Vector3(),
  q: new Quaternion(),
  m4: new Matrix4(),
  m4b: new Matrix4(),
};

// ---------------------------------------------------------------------------
// Platform probes — evaluated once at module load, every access guarded
// ---------------------------------------------------------------------------

const HAS_NAV = typeof navigator !== 'undefined' && navigator !== null;
const HAS_WIN = typeof window !== 'undefined' && window !== null;

function probeIOS() {
  if (!HAS_NAV) return false;
  try {
    const platform = String(navigator.platform || '');
    if (/iP(hone|od|ad)/.test(platform)) return true;
    // iPadOS reports 'MacIntel' with a touch screen (§6.1)
    return platform === 'MacIntel' && (navigator.maxTouchPoints | 0) > 1;
  } catch (_) {
    return false;
  }
}

function probeTouch() {
  if (!HAS_WIN && !HAS_NAV) return false;
  try {
    if (HAS_NAV && (navigator.maxTouchPoints | 0) > 0) return true;
    if (HAS_WIN && 'ontouchstart' in window) return true;
    if (HAS_WIN && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(pointer: coarse)');
      return !!(mq && mq.matches);
    }
  } catch (_) { /* a sandboxed frame may deny matchMedia */ }
  return false;
}

function probeHaptics() {
  if (!HAS_NAV) return false;
  try {
    return typeof navigator.vibrate === 'function';
  } catch (_) {
    return false;
  }
}

/** True on iPhone/iPod/iPad (including iPadOS masquerading as MacIntel). */
export const isIOS = probeIOS();
/** True when the device exposes a touch pointer. */
export const isTouch = probeTouch();
/** True when navigator.vibrate exists (iOS Safari never has it). */
export const hasHaptics = probeHaptics();

/**
 * Guarded navigator.vibrate. Returns true when the call was accepted.
 * Callers (fx.haptic) are responsible for the settings check (§14 rule 9).
 * @param {number|number[]} pattern
 */
export function vibrate(pattern) {
  if (!hasHaptics) return false;
  try {
    return !!navigator.vibrate(pattern);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// storage — localStorage resolved once, Map fallback, every call guarded
// ---------------------------------------------------------------------------

// In a sandboxed iframe the `window.localStorage` getter itself throws, so the
// probe (write + remove of '__t') runs inside try/catch at module load (§6.1).
let ls = null;
if (HAS_WIN) {
  try {
    ls = window.localStorage;
    ls.setItem('__t', '1');
    ls.removeItem('__t');
  } catch (_) {
    ls = null;
  }
}
const memStore = new Map();

export const storage = {
  /** True when no persistent backing store is available (Map fallback in use). */
  volatile: ls === null,

  /** @returns {string|null} */
  get(key) {
    if (ls !== null) {
      try {
        const v = ls.getItem(key);
        if (v !== null) return v;
      } catch (_) { /* fall through to the memory copy */ }
    }
    const m = memStore.get(key);
    return m === undefined ? null : m;
  },

  /** @returns {boolean} true when the value reached the persistent store */
  set(key, value) {
    const str = String(value);
    memStore.set(key, str);
    if (ls === null) return false;
    try {
      ls.setItem(key, str);
      return true;
    } catch (_) {
      // quota exceeded / private mode: keep the in-memory copy, report failure
      storage.volatile = true;
      return false;
    }
  },

  /** @returns {boolean} true when the key was removed from the persistent store */
  remove(key) {
    memStore.delete(key);
    if (ls === null) return false;
    try {
      ls.removeItem(key);
      return true;
    } catch (_) {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// warnOnce — the only sanctioned console.warn path (§14 rule 5)
// ---------------------------------------------------------------------------

const warned = new Set();

/**
 * Emits console.warn(msg) the first time `key` is seen; silent afterwards.
 * Keys are free-form strings ('audio.noContext', 'pool.bullets.full', …).
 */
export function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[gate-rush] ' + msg);
    }
  } catch (_) { /* consoles can be stubbed out by hosts */ }
}
