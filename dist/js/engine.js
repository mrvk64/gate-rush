// js/engine.js — Gate Rush core loop (ARCHITECTURE §6.2, §4.2, §5).
//
// Exports: EventBus, detectTier, maxAutoTierFor, StateMachine, Engine.
//
// The Engine owns ctx.time / ctx.state / ctx.input / ctx.debug, adopts ctx.quality (created by
// render.init), runs the requestAnimationFrame loop with the fixed-step accumulator (§2.2), owns
// every input listener on #app (pointer steering with capture, keyboard, gamepad), the audio
// unlock gesture, resize / orientation / visibility / context-loss listeners, the quality
// auto-scaler (GDD §16) and the debug overlay text (§13).
//
// This module never touches document / window / navigator at import time: every browser access
// happens inside init() or a listener, and every optional API is guarded (§14 rule 4).
import { clamp, isIOS, warnOnce } from './util.js';
import { WORLD, SQUAD, QUALITY_TIERS, MUSIC, JUICE, STRINGS } from './data.js';

// ---------------------------------------------------------------------------------------------
// Module constants (every literal names its data.js source)
// ---------------------------------------------------------------------------------------------

const STEP = WORLD.step;                        // 1/60 fixed simulation step
const MAX_SUBSTEPS = WORLD.maxSubSteps;         // 5
const DT_CLAMP = WORLD.dtClamp;                 // 0.05 s
const TIME_SCALE_MIN = WORLD.timeScaleMin;      // 0.25
const STEER_RANGE = WORLD.steerRange;           // ±2.1 m
const STEER = SQUAD.steer;                      // k, kFraction, deadZonePx, keyboardSpeed, keyboardAccel, gamepadDeadZone, iosEdgePx
const SCALER = QUALITY_TIERS.scaler;            // window, dropFactor, dropAfter, raiseFactor, raiseJsMs, raiseAfter, hysteresis, refreshSamples, refreshSnap, targetMinMs, refreshMinSamples, refreshProbeMs
const TIER_ORDER = QUALITY_TIERS.order;         // ['low', 'med', 'high']
const PAUSE_FRAME_MS = 1000 / QUALITY_TIERS.pauseFps;   // 33 ms redraw gate while paused on High
const BUDGET = QUALITY_TIERS.budget;            // { jsMs, mainCalls, shadowCalls, postCalls } — overlay red flags
const DEBUG_HZ = JUICE.ui.debugHz;              // 4 Hz overlay refresh
const REF_WIDTH_PX = JUICE.ui.refBox[0];        // 390 px fallback viewport width for getSteerK before the first resize
const REF_HEIGHT_PX = JUICE.ui.refBox[1];       // 844 px fallback viewport height

const RESIZE_DEBOUNCE_MS = JUICE.ui.resizeDebounceMs;   // 120 ms trailing edge of a resize / orientation burst (GDD §14, CORE-10)
const HITCH_IGNORE_MS = SCALER.hitchIgnoreMs;           // 250 ms: rAF gaps above this (tab switch, GC, debugger) are excluded from the scaler means and the refresh measurement
const TARGET_MIN_MS = SCALER.targetMinMs;               // 16.67 ms: the scaler target is max(refresh, this) — Medium is the 60 fps contract (CORE-6)
const HISTOGRAM_CAP = 240;        // debug-only: samples kept per ctx.debug.histograms key (overlay statistic, not a tuning value)
const EVENT_DEPTH_MAX = 8;        // ARCHITECTURE §5: "depth guard 8 throws in debug"
const RESTORE_WARMUP_TIMEOUT_MS = 8000;   // CORE-3: the 'Reloading graphics…' overlay waits at most this long on render.warmup() before the first draw

// pointerdown targets that are UI controls and never start a steering drag (§6.2 / §10.2)
const STEER_UI_SELECTOR = 'button, input, .seg, .card, [data-ui]';
// keyboard: keys whose default is prevented while playing / paused (§6.2)
const PREVENT_KEY_CODES = Object.freeze(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyA', 'KeyD', 'KeyP', 'Escape']);
// form controls keep their own keyboard handling for steering keys (sliders in the settings overlay,
// Space/Enter on buttons, Tab navigation)
const FORM_CONTROL_SELECTOR = 'input, select, textarea, button, [contenteditable]';
// text-entry controls also swallow P / Esc / M (typing); buttons, checkboxes and range inputs do not,
// so Esc / P resume from the pause screen whose RESUME button holds focus (CORE-2, ARCH §6.2)
const TEXT_ENTRY_SELECTOR = 'input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="email"], input[type="password"], input[type="tel"], input[type="url"], textarea, select, [contenteditable]:not([contenteditable="false"])';
// standard gamepad mapping: button 9 = Start
const GAMEPAD_START_BUTTON = 9;

const VALID_STATES = Object.freeze(['boot', 'title', 'levels', 'shop', 'playing', 'paused', 'complete', 'gameover']);

// Reused payload objects (§5: emitters reuse module-level payloads; listeners never retain them)
const _statePayload = { from: 'boot', to: 'boot', data: null };
const _resizePayload = { w: 0, h: 0, dpr: 1, portrait: true };
const _qualityPayload = { tier: 'med', params: null, reason: 'init' };
const _emptyPayload = {};
const _errorPayload = { message: '', fatal: false };

function nowMs() {
  if (typeof performance !== 'undefined' && performance !== null && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function tierIndex(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return i < 0 ? 0 : i;
}

// ---------------------------------------------------------------------------------------------
// EventBus (§5)
// ---------------------------------------------------------------------------------------------

/**
 * Synchronous event bus. Listeners run in subscription order; `emit` allocates nothing when no
 * listener subscribes or unsubscribes during the emit (copy-on-write only in that rare case).
 * Listener errors are caught, reported once per event name through `onListenerError` (engine
 * routes it to ui.showError when ?debug=1) and otherwise swallowed.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, { fns: Function[], depth: number }>} */
    this._lists = new Map();
    this.debug = false;
    /** @type {((name:string, err:any) => void) | null} set by Engine.init() */
    this.onListenerError = null;
    this._reported = new Set();
  }

  /** Subscribes fn(payload); returns an unsubscribe function. */
  on(name, fn) {
    if (typeof fn !== 'function') return () => {};
    let entry = this._lists.get(name);
    if (entry === undefined) {
      entry = { fns: [], depth: 0 };
      this._lists.set(name, entry);
    }
    if (entry.depth > 0) {
      // subscribing from inside an emit of the same event: copy so the running loop is unaffected
      entry.fns = entry.fns.slice();
    }
    entry.fns.push(fn);
    return () => this.off(name, fn);
  }

  /** Subscribes a listener that removes itself after its first call; returns an unsubscribe function. */
  once(name, fn) {
    if (typeof fn !== 'function') return () => {};
    const bus = this;
    const wrapper = function onceWrapper(payload) {
      bus.off(name, wrapper);
      fn(payload);
    };
    return this.on(name, wrapper);
  }

  /** Removes fn from name's list (no-op when absent). Safe during an emit of the same event. */
  off(name, fn) {
    const entry = this._lists.get(name);
    if (entry === undefined) return;
    const i = entry.fns.indexOf(fn);
    if (i < 0) return;
    if (entry.depth > 0) {
      // copy-on-write: the in-flight loop keeps iterating the old array
      const copy = entry.fns.slice();
      copy.splice(i, 1);
      entry.fns = copy;
    } else {
      entry.fns.splice(i, 1);
    }
  }

  /**
   * Emits synchronously. `payload` may be a reused scratch object.
   * Re-entrant emits of the same name are allowed up to EVENT_DEPTH_MAX levels; beyond that the
   * emit is dropped (throws instead when `debug` is set).
   */
  emit(name, payload) {
    const entry = this._lists.get(name);
    if (entry === undefined) return;
    const fns = entry.fns;
    const n = fns.length;
    if (n === 0) return;
    if (entry.depth >= EVENT_DEPTH_MAX) {
      if (this.debug) throw new Error('EventBus: re-entrant emit depth exceeded for "' + name + '"');
      warnOnce('events.depth.' + name, 'EventBus: re-entrant emit depth exceeded for "' + name + '" (dropped)');
      return;
    }
    entry.depth++;
    for (let i = 0; i < n; i++) {
      try {
        fns[i](payload);
      } catch (err) {
        this._listenerError(name, err);
      }
    }
    entry.depth--;
  }

  /** Number of listeners for name (tests / debug). */
  count(name) {
    const entry = this._lists.get(name);
    return entry === undefined ? 0 : entry.fns.length;
  }

  /** Drops every listener (dispose / tests). */
  clear() {
    this._lists.clear();
    this._reported.clear();
  }

  _listenerError(name, err) {
    const msg = (err && err.message) ? err.message : String(err);
    warnOnce('events.listener.' + name + ':' + msg, 'listener error in "' + name + '": ' + msg);
    if (this._reported.has(name)) return;
    this._reported.add(name);
    if (typeof this.onListenerError === 'function') {
      try { this.onListenerError(name, err); } catch (_) { /* reporter must never break the emit */ }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Quality tier heuristics (pure; called by render.init, §4.1 step 5d)
// ---------------------------------------------------------------------------------------------

function matchRule(gpuString) {
  const rules = QUALITY_TIERS.heuristics;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.re.test(gpuString)) return rule;   // first match wins (the A14+/M rule precedes the generic 'Apple GPU')
  }
  return null;
}

/**
 * Initial quality tier (GDD §16). `configQuality` (?quality=) wins outright; otherwise the first
 * QUALITY_TIERS.heuristics rule whose regex matches the GPU string decides, a string that matches
 * nothing → unknownGpuTier, no string → fallbackTier, and deviceMemory ≤ lowMemoryGB caps the
 * heuristic result at 'low'.
 * @param {string|null} gpuString
 * @param {number|null} deviceMemoryGB
 * @param {string|null} configQuality
 * @returns {'low'|'med'|'high'}
 */
export function detectTier(gpuString, deviceMemoryGB, configQuality) {
  if (typeof configQuality === 'string' && TIER_ORDER.indexOf(configQuality) !== -1) return configQuality;
  let tier;
  if (typeof gpuString !== 'string' || gpuString.length === 0) {
    tier = QUALITY_TIERS.fallbackTier;
  } else {
    const rule = matchRule(gpuString);
    tier = rule !== null ? rule.tier : QUALITY_TIERS.unknownGpuTier;
  }
  if (typeof deviceMemoryGB === 'number' && Number.isFinite(deviceMemoryGB) && deviceMemoryGB > 0 && deviceMemoryGB <= QUALITY_TIERS.lowMemoryGB) {
    tier = TIER_ORDER[0];   // 'low'
  }
  return tier;
}

/**
 * Auto-scaler ceiling (GDD §16 "the matched rule's ceiling, else the initial tier").
 * Matched rule → its maxAuto (or its own tier); a string that matches nothing → unknownMaxAuto;
 * no string → tier. The result is never below `tier`.
 * @param {string|null} gpuString
 * @param {'low'|'med'|'high'} tier
 * @returns {'low'|'med'|'high'}
 */
export function maxAutoTierFor(gpuString, tier) {
  let max = tier;
  if (typeof gpuString === 'string' && gpuString.length > 0) {
    const rule = matchRule(gpuString);
    max = rule !== null ? (rule.maxAuto || rule.tier) : QUALITY_TIERS.unknownMaxAuto;
  }
  if (TIER_ORDER.indexOf(max) === -1) max = tier;
  return tierIndex(max) >= tierIndex(tier) ? max : tier;
}

// ---------------------------------------------------------------------------------------------
// StateMachine (§3 ctx.state, §6.2)
// ---------------------------------------------------------------------------------------------

/**
 * Game state: boot, title, levels, shop, playing, paused, complete, gameover. `set` emits
 * `state:change { from, to, data }` and nothing else — ui maps states to screens in its own
 * listener (D11). `settings` is a UI overlay, not a state.
 */
export class StateMachine {
  constructor(ctx) {
    this._ctx = ctx;
    this._current = 'boot';
    this._prev = 'boot';
    this._data = null;
  }

  get current() { return this._current; }
  get prev() { return this._prev; }
  get data() { return this._data; }

  /** True when the current state is name. */
  is(name) { return this._current === name; }

  /**
   * Switches state and emits `state:change`. Setting the current state again re-emits with
   * from === to and the new data (prev is untouched), so ui can refresh a screen idempotently.
   */
  set(name, data) {
    if (VALID_STATES.indexOf(name) === -1) {
      warnOnce('state.unknown.' + name, 'StateMachine: unknown state "' + name + '"');
    }
    const from = this._current;
    if (name !== from) this._prev = from;
    this._current = name;
    this._data = data === undefined ? null : data;
    _statePayload.from = from;
    _statePayload.to = name;
    _statePayload.data = this._data;
    const events = this._ctx && this._ctx.events;
    if (events) events.emit('state:change', _statePayload);
    _statePayload.data = null;   // listeners copy what they need (§5)
  }
}

// ---------------------------------------------------------------------------------------------
// Engine (§6.2 / §4.2)
// ---------------------------------------------------------------------------------------------

/**
 * The frame loop, time, input, resize, quality auto-scaler, audio unlock gesture and debug
 * overlay. Created at boot step 8 (after ui, render, models, audio exist; before the gameplay
 * systems). Every per-frame method is allocation-free; strings are built only for the 4 Hz
 * debug overlay when ?debug=1.
 */
export class Engine {
  constructor(ctx) {
    this._ctx = ctx;

    // loop
    this._running = false;
    this._raf = 0;
    // Fields written `this.F = 0.5; this.F = <start>;` are seeded as Doubles (round-2 cross-group, FX-14 item 2: no V8
    // map deprecation when the first fraction is stored).
    this._lastNow = -0.5; this._lastNow = -1;          // previous rAF timestamp (ms); -1 before the first frame
    this._lastInterval = 0.5; this._lastInterval = 0;      // raw rAF interval of the current frame (ms), fed to the scaler
    this._acc = 0.5; this._acc = 0;               // fixed-step accumulator (s)
    this._beginMs = 0.5; this._beginMs = 0;           // performance.now() at beginFrame (jsMs measurement)
    this._frameFailed = false;   // a frame threw: reported once, loop stopped
    this._contextLost = false;
    this._gfxWarming = false;      // after webglcontextrestored: programs recompiling behind the overlay (draws skipped)
    this._restoreGen = 0;          // bumps on every loss / restore so a stale warm-up completion is ignored
    this._hideOverlayAfterDraw = false;   // hide 'Reloading graphics…' once the first post-restore draw has completed
    this._restoreTimer = 0;
    this._lastPausedDraw = 0;

    // pointer steering
    this._pointerId = -1;
    this._lastX = 0;
    this._gestureAbs = 0;

    // keyboard / gamepad
    this._kbVel = 0;             // ramped keyboard velocity (m/s)
    this._gamepadOk = false;
    this._gamepadSeen = false;
    this._gpStartDown = false;
    this._muted = false;

    // settings cache
    this._sensitivity = 1;

    // listeners (bound once; removed in dispose)
    this._onFrame = (now) => this._frameSafe(now);
    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
    // CORE-5: only the steering pointer's own capture loss releases the steer (a second finger's
    // tap also fires lostpointercapture on #app, for ITS pointerId)
    this._onLostCapture = (e) => { if (e && e.pointerId === this._pointerId) this._releasePointer(); };
    this._onContextMenu = (e) => { try { e.preventDefault(); } catch (_) { /* ignore */ } };
    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);
    this._onBlur = () => this._blur();
    this._onVisibility = () => this._visibilityChange();
    this._onGamepadConnected = () => { this._gamepadSeen = true; };
    this._onResizeAny = () => this._scheduleResize();
    this._onResizeTrailing = () => { this._resizeTimer = 0; this._doResize(); this.measureRefresh(); };
    this._onProbe = (t) => this._probeFrame(t);
    this._onContextLost = (e) => this._contextLostHandler(e);
    this._onContextRestored = () => this._contextRestoredHandler();
    this._onUnlockGesture = () => this._unlockGesture();
    this._onSettingsChange = (p) => this._settingsChange(p);
    this._onAudioUnlocked = () => this._removeUnlockListeners();
    this._onDebugHistogram = (p) => this._histogram(p);
    this._unsubs = [];
    this._unlockArmed = false;
    this._resizeTimer = 0;
    this._resizeObserver = null;
    this._orientationTarget = null;

    // auto-scaler (GDD §16)
    this._refreshSamples = new Float64Array(SCALER.refreshSamples);
    this._refreshCount = 0;
    // refresh probe (CORE-6): its own draw-free rAF chain; an interval counts only when no renderer.render()
    // ran in it or in the interval before it (renderer.info.render.frame / this._draws unchanged)
    this._probeOn = false;
    this._probeRaf = 0;
    this._probeLast = -1;
    this._probeDeadline = 0;
    this._probeDrawMark = -1;
    this._probeDrewPrev = true;
    this._draws = 0;             // step-H draws (fallback draw counter when renderer.info is unavailable)
    this._winInt = new Float64Array(SCALER.window);
    this._winJs = new Float64Array(SCALER.window);
    this._winIdx = 0;
    this._winCount = 0;
    this._sumInt = 0;
    this._sumJs = 0;
    this._slowSince = -1;
    this._fastSince = -1;
    this._lastChangeAt = -Infinity;
    this._fpsSmooth = 0.5; this._fpsSmooth = 0;
    this._autoDrops = new Uint8Array(TIER_ORDER.length);   // auto drops FROM each tier this session (raise back-off)

    // debug overlay
    this._debugAccum = 0.5; this._debugAccum = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Creates ctx.time / ctx.state / ctx.input / ctx.debug, adopts ctx.quality, installs listeners. */
  init() {
    const ctx = this._ctx;
    const t0 = nowMs();

    // Round-2 cross-group (FX-14 item 2): every fraction-holding field is created from a fraction (0.5) and then set to
    // its start value, so V8 gives it a Double representation from the start. The first slow-mo (scale 0.25) or the
    // first fractional elapsed / levelTime used to deprecate ctx.time's map mid-play and deoptimise every module at once
    // (V8 log: "dependent prototype chain changed" storms at level start and at the first slow-mo).
    const time = {
      now: 0.5, unscaledDt: 0.5, dt: 0.5, step: STEP, alpha: 0.5, scale: 0.5,
      elapsed: 0.5, levelTime: 0.5, frame: 0, slowmoLeft: 0.5,
      // CORE-7: theatre clock (ms) — advances by the clamped real frame interval (unscaledDt·1000) except while
      // 'paused' or the WebGL context is lost, so theatre deadlines span slow-mo but not a pause (ARCH §2.2)
      theatre: 0.5,
      refreshMs: SCALER.refreshSnap[SCALER.refreshSnap.length - 1],   // 16.67 until measured
    };
    time.now = t0; time.unscaledDt = 0; time.dt = 0; time.alpha = 0; time.scale = 1;
    time.elapsed = 0; time.levelTime = 0; time.slowmoLeft = 0; time.theatre = t0;
    ctx.time = time;
    ctx.state = new StateMachine(ctx);
    const input = { steerDx: 0.5, targetX: 0.5, pointerDown: false, keyLeft: false, keyRight: false, gamepadX: 0.5, hasSteered: false, locked: false };
    input.steerDx = 0; input.targetX = 0; input.gamepadX = 0;
    ctx.input = input;
    const debugOn = !!(ctx.config && ctx.config.debug);
    // Every field other modules write is declared here (round-3 polish, ARCH §14 rule 11): weapons writes shotsPerSec /
    // laserBeams each step (WPN-7; −1 = no 1 s window measured yet, the overlay prints '-'), level writes levelGenMs
    // (a fraction: created from 0.5) / levelGenHits / levelGenMisses at each start (LVL-18). They used to be added
    // lazily from those modules, changing the object's shape mid-run. `dropped` stays a by-name counter record.
    ctx.debug = {
      enabled: debugOn, calls: 0, jsMs: 0.5, dropped: {},
      histograms: { hitsPerGate: [], finalVsBase: [], lostPerWave: [], bossTtk: [], countAtBoss: [] },
      shotsPerSec: -1, laserBeams: 0, levelGenMs: 0.5, levelGenHits: 0, levelGenMisses: 0,
    };
    ctx.debug.jsMs = 0;
    ctx.debug.levelGenMs = 0;

    if (ctx.events) {
      ctx.events.debug = debugOn;
      ctx.events.onListenerError = (name, err) => this._reportListenerError(name, err);
    }

    this._adoptQuality();
    this._sensitivity = this._readSensitivity();
    this._installListeners();
    this._subscribe();
    this._emitQuality('init');
    this._doResize();
    this.measureRefresh();   // boot screen (step 8, before the warm-up): draw-free frames until the loop starts drawing
    return this;
  }

  /** Starts the requestAnimationFrame loop (boot step 12). */
  start() {
    if (this._running) return;
    if (typeof requestAnimationFrame !== 'function') {
      warnOnce('engine.noRaf', 'requestAnimationFrame is not available; the game loop cannot start');
      return;
    }
    this._running = true;
    this._lastNow = -1;
    this._raf = requestAnimationFrame(this._onFrame);
  }

  /** Stops the loop (dispose, fatal error). */
  stop() {
    this._running = false;
    if (this._raf && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(this._raf); } catch (_) { /* ignore */ }
    }
    this._raf = 0;
    this._stopProbe();
  }

  /** Removes every listener and stops the loop. */
  dispose() {
    this.stop();
    const ctx = this._ctx;
    const app = ctx.app;
    this._removeUnlockListeners();
    if (app) {
      try {
        app.removeEventListener('pointerdown', this._onPointerDown);
        app.removeEventListener('pointermove', this._onPointerMove);
        app.removeEventListener('pointerup', this._onPointerUp);
        app.removeEventListener('pointercancel', this._onPointerUp);
        app.removeEventListener('lostpointercapture', this._onLostCapture);
        app.removeEventListener('contextmenu', this._onContextMenu);
      } catch (_) { /* ignore */ }
    }
    if (typeof window !== 'undefined') {
      try {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        window.removeEventListener('blur', this._onBlur);
        window.removeEventListener('gamepadconnected', this._onGamepadConnected);
        window.removeEventListener('resize', this._onResizeAny);
        window.removeEventListener('orientationchange', this._onResizeAny);
      } catch (_) { /* ignore */ }
    }
    if (typeof document !== 'undefined') {
      try { document.removeEventListener('visibilitychange', this._onVisibility); } catch (_) { /* ignore */ }
    }
    if (this._orientationTarget) {
      try { this._orientationTarget.removeEventListener('change', this._onResizeAny); } catch (_) { /* ignore */ }
      this._orientationTarget = null;
    }
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (_) { /* ignore */ }
      this._resizeObserver = null;
    }
    if (ctx.canvas) {
      try {
        ctx.canvas.removeEventListener('webglcontextlost', this._onContextLost);
        ctx.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
      } catch (_) { /* ignore */ }
    }
    if (this._resizeTimer) {
      try { clearTimeout(this._resizeTimer); } catch (_) { /* ignore */ }
      this._resizeTimer = 0;
    }
    this._clearRestoreTimer();
    for (let i = 0; i < this._unsubs.length; i++) this._unsubs[i]();
    this._unsubs.length = 0;
    if (ctx.events) ctx.events.onListenerError = null;
  }

  // -------------------------------------------------------------------------------------------
  // Quality adoption (§4.1 step 8) and the settings bridge
  // -------------------------------------------------------------------------------------------

  _adoptQuality() {
    const ctx = this._ctx;
    const cfgQuality = ctx.config ? ctx.config.quality : null;
    if (!ctx.quality) {
      // render.init normally creates this (§4.1 step 5d); a stub harness without render gets an equivalent object
      const tier = detectTier(null, null, cfgQuality);
      ctx.quality = { tier, initialTier: tier, maxAutoTier: maxAutoTierFor(null, tier), auto: cfgQuality == null, params: QUALITY_TIERS[tier], dpr: 1, frozenUntil: 0 };
      warnOnce('engine.qualityStub', 'ctx.quality was missing at Engine.init(); created a fallback (render stubbed?)');
    }
    const q = ctx.quality;
    if (TIER_ORDER.indexOf(q.tier) === -1) q.tier = QUALITY_TIERS.fallbackTier;
    if (!q.params) q.params = QUALITY_TIERS[q.tier];
    if (TIER_ORDER.indexOf(q.maxAutoTier) === -1) q.maxAutoTier = q.tier;
    if (typeof q.frozenUntil !== 'number') q.frozenUntil = 0;
    // A saved manual quality (settings.quality !== 'auto') applies at boot unless ?quality= forces a tier.
    const saved = this._savedQuality();
    if (cfgQuality == null && saved !== null && saved !== 'auto') {
      q.auto = false;
      if (saved !== q.tier) { q.tier = saved; q.params = QUALITY_TIERS[saved]; }
    } else if (cfgQuality != null) {
      q.auto = false;
    }
  }

  _savedQuality() {
    const save = this._ctx.save;
    if (!save) return null;
    try {
      const s = save.settings;
      if (!s) return null;
      const v = s.quality;
      if (v === 'auto' || TIER_ORDER.indexOf(v) !== -1) return v;
    } catch (_) { /* settings getter may not exist in a stub */ }
    return null;
  }

  _readSensitivity() {
    const save = this._ctx.save;
    if (!save) return 1;
    try {
      const s = save.settings;
      const v = s ? parseFloat(s.sensitivity) : NaN;
      return Number.isFinite(v) && v > 0 ? v : 1;
    } catch (_) {
      return 1;
    }
  }

  _settingsChange(p) {
    if (!p) return;
    if (p.key === 'quality') {
      this.setQuality(p.value);
    } else if (p.key === 'sensitivity') {
      const v = parseFloat(p.value);
      this._sensitivity = Number.isFinite(v) && v > 0 ? v : 1;
    }
  }

  _subscribe() {
    const events = this._ctx.events;
    if (!events) return;
    this._unsubs.push(events.on('settings:change', this._onSettingsChange));
    this._unsubs.push(events.on('audio:unlocked', this._onAudioUnlocked));
    if (this._ctx.debug.enabled) this._unsubs.push(events.on('debug:histogram', this._onDebugHistogram));
  }

  _histogram(p) {
    if (!p || typeof p.key !== 'string') return;
    const h = this._ctx.debug.histograms;
    let arr = h[p.key];
    if (!arr) { arr = []; h[p.key] = arr; }
    if (arr.length >= HISTOGRAM_CAP) arr.shift();
    arr.push(+p.value);
  }

  _reportListenerError(name, err) {
    const ctx = this._ctx;
    if (!ctx.debug || !ctx.debug.enabled) return;
    const ui = ctx.ui;
    if (ui && typeof ui.showError === 'function') {
      const msg = STRINGS.errors.listener(name) + ': ' + ((err && err.message) ? err.message : String(err));
      try { ui.showError(msg, false); } catch (_) { /* never recurse */ }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Listener installation (§6.2 "Input", "Audio unlock gesture", "Other listeners", §9.5)
  // -------------------------------------------------------------------------------------------

  _installListeners() {
    const ctx = this._ctx;
    const app = ctx.app;
    const hasWin = typeof window !== 'undefined' && window !== null;
    const hasDoc = typeof document !== 'undefined' && document !== null;

    if (app) {
      app.addEventListener('pointerdown', this._onPointerDown);
      app.addEventListener('pointermove', this._onPointerMove);
      app.addEventListener('pointerup', this._onPointerUp);
      app.addEventListener('pointercancel', this._onPointerUp);
      app.addEventListener('lostpointercapture', this._onLostCapture);
      app.addEventListener('contextmenu', this._onContextMenu);
    }
    if (hasWin) {
      // keyboard on window so A/D/P/Esc/M work before #app has been focused (desktop); #app is
      // focused on every steering pointerdown anyway
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
      try { window.addEventListener('gamepadconnected', this._onGamepadConnected); } catch (_) { /* ignore */ }
    }
    if (hasDoc) document.addEventListener('visibilitychange', this._onVisibility);

    // gamepad probe (a cross-origin iframe without the gamepad permissions policy throws SecurityError)
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
        navigator.getGamepads();
        this._gamepadOk = true;
      }
    } catch (_) {
      this._gamepadOk = false;
    }

    // resize: ResizeObserver on #app (guarded) with window.resize fallback + orientation change
    let observed = false;
    if (app && hasWin && typeof window.ResizeObserver === 'function') {
      try {
        this._resizeObserver = new window.ResizeObserver(this._onResizeAny);
        this._resizeObserver.observe(app);
        observed = true;
      } catch (_) {
        this._resizeObserver = null;
      }
    }
    if (hasWin) {
      if (!observed) window.addEventListener('resize', this._onResizeAny);
      let orientationDone = false;
      try {
        if (typeof screen !== 'undefined' && screen && screen.orientation && typeof screen.orientation.addEventListener === 'function') {
          screen.orientation.addEventListener('change', this._onResizeAny);
          this._orientationTarget = screen.orientation;
          orientationDone = true;
        }
      } catch (_) { /* ignore */ }
      if (!orientationDone) window.addEventListener('orientationchange', this._onResizeAny);
    }

    // WebGL context loss on the canvas (§9.5)
    if (ctx.canvas) {
      ctx.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
      ctx.canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
    }

    this._armUnlockListeners();
  }

  _armUnlockListeners() {
    if (this._unlockArmed) return;
    const app = this._ctx.app;
    if (!app) return;
    const opts = { capture: true, passive: true };
    app.addEventListener('pointerdown', this._onUnlockGesture, opts);
    app.addEventListener('pointerup', this._onUnlockGesture, opts);
    app.addEventListener('touchend', this._onUnlockGesture, opts);
    app.addEventListener('click', this._onUnlockGesture, opts);
    app.addEventListener('keydown', this._onUnlockGesture, opts);
    if (typeof window !== 'undefined') window.addEventListener('keydown', this._onUnlockGesture, opts);   // keys arrive on window when #app is not focused
    this._unlockArmed = true;
  }

  _removeUnlockListeners() {
    if (!this._unlockArmed) return;
    const app = this._ctx.app;
    const opts = { capture: true };
    if (app) {
      app.removeEventListener('pointerdown', this._onUnlockGesture, opts);
      app.removeEventListener('pointerup', this._onUnlockGesture, opts);
      app.removeEventListener('touchend', this._onUnlockGesture, opts);
      app.removeEventListener('click', this._onUnlockGesture, opts);
      app.removeEventListener('keydown', this._onUnlockGesture, opts);
    }
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this._onUnlockGesture, opts);
    this._unlockArmed = false;
  }

  _unlockGesture() {
    const audio = this._ctx.audio;
    if (!audio || typeof audio.unlock !== 'function') return;
    try { audio.unlock(); } catch (_) { /* audio reports its own errors */ }
  }

  // -------------------------------------------------------------------------------------------
  // Pointer steering (§6.2): relative drag, first pointer only, capture, 2 px dead zone
  // -------------------------------------------------------------------------------------------

  _pointerDown(e) {
    const ctx = this._ctx;
    const target = e.target;
    if (target && typeof target.closest === 'function') {
      let hit = null;
      try { hit = target.closest(STEER_UI_SELECTOR); } catch (_) { hit = null; }
      if (hit !== null) return;                                   // UI control: never a steering drag
    }
    if (isIOS && e.clientX < STEER.iosEdgePx) return;              // iOS edge swipe (back gesture)
    if (this._pointerId !== -1) return;                            // first pointer only
    this._pointerId = e.pointerId;
    this._lastX = e.clientX;
    this._gestureAbs = 0;
    ctx.input.pointerDown = true;
    const app = ctx.app;
    if (app) {
      try { app.setPointerCapture(e.pointerId); } catch (_) { /* unsupported / already captured */ }
      try { app.focus({ preventScroll: true }); } catch (_) { try { app.focus(); } catch (__) { /* ignore */ } }
    }
  }

  _pointerMove(e) {
    if (e.pointerId !== this._pointerId) return;
    let list = null;
    if (typeof e.getCoalescedEvents === 'function') {
      try { list = e.getCoalescedEvents(); } catch (_) { list = null; }
      if (list !== null && list.length === 0) list = null;
    }
    if (list === null) {
      this._acceptDelta(e.clientX);
    } else {
      for (let i = 0; i < list.length; i++) this._acceptDelta(list[i].clientX);
    }
  }

  _acceptDelta(clientX) {
    const input = this._ctx.input;
    const dx = clientX - this._lastX;
    this._lastX = clientX;
    if (dx === 0) return;
    this._gestureAbs += dx < 0 ? -dx : dx;
    if (this._gestureAbs <= STEER.deadZonePx) return;            // first 2 px of the gesture are discarded
    input.steerDx += dx;
    if (!input.locked && this._ctx.state.is('playing')) input.hasSteered = true;
  }

  _pointerUp(e) {
    if (e.pointerId !== this._pointerId) return;
    this._releasePointer();
  }

  _releasePointer() {
    if (this._pointerId !== -1) {
      const app = this._ctx.app;
      if (app && typeof app.releasePointerCapture === 'function') {
        try { if (app.hasPointerCapture && app.hasPointerCapture(this._pointerId)) app.releasePointerCapture(this._pointerId); } catch (_) { /* ignore */ }
      }
    }
    this._pointerId = -1;
    this._ctx.input.pointerDown = false;
  }

  // -------------------------------------------------------------------------------------------
  // Keyboard (A/D/arrows steer, P/Esc pause, M mute) and gamepad
  // -------------------------------------------------------------------------------------------

  _keyDown(e) {
    const ctx = this._ctx;
    const code = e.code || '';
    const state = ctx.state;
    const inGame = state.is('playing') || state.is('paused');
    const target = e.target;
    let onControl = false;    // any form control: steering keys stay with the control
    let onTextEntry = false;  // text entry: P / Esc / M are typing, not commands
    if (target && typeof target.closest === 'function') {
      try { onControl = target.closest(FORM_CONTROL_SELECTOR) !== null; } catch (_) { onControl = false; }
      if (onControl) {
        try { onTextEntry = target.closest(TEXT_ENTRY_SELECTOR) !== null; } catch (_) { onTextEntry = false; }
      }
    }
    const command = code === 'KeyP' || code === 'Escape';
    if (inGame && (command ? !onTextEntry : !onControl) && PREVENT_KEY_CODES.indexOf(code) !== -1) {
      try { e.preventDefault(); } catch (_) { /* ignore */ }
    }
    switch (code) {
      case 'KeyA': case 'ArrowLeft':
        if (!onControl) ctx.input.keyLeft = true;
        break;
      case 'KeyD': case 'ArrowRight':
        if (!onControl) ctx.input.keyRight = true;
        break;
      case 'KeyP': case 'Escape':
        if (!e.repeat && !onTextEntry) this._togglePause();
        break;
      case 'KeyM':
        if (!e.repeat && !onTextEntry) this._toggleMute();
        break;
      default:
        break;
    }
  }

  _keyUp(e) {
    const code = e.code || '';
    if (code === 'KeyA' || code === 'ArrowLeft') this._ctx.input.keyLeft = false;
    else if (code === 'KeyD' || code === 'ArrowRight') this._ctx.input.keyRight = false;
  }

  _togglePause() {
    const state = this._ctx.state;
    if (state.is('playing')) this.pause();
    else if (state.is('paused')) this.resume();
  }

  _toggleMute() {
    const audio = this._ctx.audio;
    if (!audio || typeof audio.setMuted !== 'function') return;
    this._muted = !this._muted;
    try { audio.setMuted(this._muted); } catch (_) { /* ignore */ }
  }

  _pollGamepad() {
    if (!this._gamepadOk || !this._gamepadSeen) return;
    const input = this._ctx.input;
    try {
      const pads = navigator.getGamepads();
      if (!pads) return;
      let found = false;
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (!pad || !pad.connected) continue;
        const axes = pad.axes;
        let x = axes && axes.length > 0 ? axes[0] : 0;
        const dz = STEER.gamepadDeadZone;
        const ax = x < 0 ? -x : x;
        x = ax < dz ? 0 : (x < 0 ? -1 : 1) * (ax - dz) / (1 - dz);   // dead zone re-scaled to a full ±1 range
        input.gamepadX = clamp(x, -1, 1);
        const buttons = pad.buttons;
        const startDown = !!(buttons && buttons.length > GAMEPAD_START_BUTTON && buttons[GAMEPAD_START_BUTTON] && buttons[GAMEPAD_START_BUTTON].pressed);
        if (startDown && !this._gpStartDown) this._togglePause();
        this._gpStartDown = startDown;
        found = true;
        break;
      }
      if (!found) { input.gamepadX = 0; this._gpStartDown = false; }
    } catch (_) {
      this._gamepadOk = false;
      input.gamepadX = 0;
    }
  }

  _clearTransientInput() {
    const input = this._ctx.input;
    input.keyLeft = false;
    input.keyRight = false;
    input.gamepadX = 0;
    input.steerDx = 0;
    this._kbVel = 0;
    this._releasePointer();
  }

  // -------------------------------------------------------------------------------------------
  // Window / document lifecycle
  // -------------------------------------------------------------------------------------------

  _blur() {
    this._clearTransientInput();
  }

  _visibilityChange() {
    let hidden = false;
    try { hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'; } catch (_) { hidden = false; }
    if (hidden) {
      this._clearTransientInput();
      if (this._ctx.state.is('playing')) this.pause();
    } else {
      this._resetScalerWindow();   // the first visible frame carries a huge interval; start clean
      this.requestRedraw();
      this.measureRefresh();       // the panel may have changed while hidden (external display, power mode)
    }
  }

  /**
   * CORE-10: leading + trailing edge. The first event of a burst resizes at once (so no frame is drawn with a
   * stale drawing buffer / camera aspect); later events of the burst only re-arm the trailing resize
   * (JUICE.ui.resizeDebounceMs after the last event) — except one that flips portrait ⇄ landscape against the
   * applied size (orientationchange can fire before layout, so the leading call saw the old box), which also
   * resizes at once. A desktop drag-resize therefore still costs one resize per burst plus the trailing one.
   */
  _scheduleResize() {
    const leading = this._resizeTimer === 0;
    if (!leading) {
      try { clearTimeout(this._resizeTimer); } catch (_) { /* ignore */ }
    }
    this._resizeTimer = setTimeout(this._onResizeTrailing, RESIZE_DEBOUNCE_MS);
    if (leading || this._orientationMismatch()) this._doResize();
  }

  /** True when #app's current box is on the other side of WORLD.camera.portraitBelow than the applied render size. */
  _orientationMismatch() {
    const ctx = this._ctx;
    const size = ctx.render && ctx.render.size;
    const app = ctx.app;
    if (!size || !app || !(size.w > 0) || !(size.h > 0)) return false;
    const w = app.clientWidth, h = app.clientHeight;
    if (!(w > 0) || !(h > 0)) return false;
    const portraitNow = (w / h) < WORLD.camera.portraitBelow;
    const portraitApplied = (size.w / size.h) < WORLD.camera.portraitBelow;
    return portraitNow !== portraitApplied;
  }

  /** render.resize() + the `resize` event (§6.2 "Other listeners", §5.1 emitter = engine). */
  _doResize() {
    const ctx = this._ctx;
    const render = ctx.render;
    if (render && typeof render.resize === 'function') {
      try { render.resize(); } catch (err) { this._reportError('render.resize', err); }
    }
    let w = 0, h = 0, dpr = 1;
    if (render && render.size) {
      w = render.size.w; h = render.size.h; dpr = render.size.dpr;
    } else if (ctx.app) {
      w = ctx.app.clientWidth; h = ctx.app.clientHeight;
    }
    if (!(w > 0)) w = REF_WIDTH_PX;
    if (!(h > 0)) h = JUICE.ui.refBox[1];
    _resizePayload.w = w;
    _resizePayload.h = h;
    _resizePayload.dpr = dpr > 0 ? dpr : 1;
    _resizePayload.portrait = (render && render.size && typeof render.size.portrait === 'boolean') ? render.size.portrait : (w / h) < WORLD.camera.portraitBelow;
    this.requestRedraw();
    if (ctx.events) ctx.events.emit('resize', _resizePayload);
  }

  _contextLostHandler(e) {
    try { e.preventDefault(); } catch (_) { /* ignore */ }
    this._contextLost = true;
    this._restoreGen++;            // a warm-up still running from an earlier restore is now stale
    this._gfxWarming = false;
    this._hideOverlayAfterDraw = false;
    this._clearRestoreTimer();
    const ctx = this._ctx;
    if (ctx.ui && typeof ctx.ui.showOverlay === 'function') {
      try { ctx.ui.showOverlay(STRINGS.reloadingGfx); } catch (_) { /* ignore */ }
    }
    if (ctx.state.is('playing')) this.pause();
  }

  /**
   * webglcontextrestored (§9.5, CORE-3): render.rebuild(), then — with the 'Reloading graphics…'
   * overlay still up and draws skipped — await render.warmup() (VIS-2, guarded, capped at
   * RESTORE_WARMUP_TIMEOUT_MS) so the programs recompile behind the overlay; the overlay hides only
   * after the first completed draw (frame step H), so no long frame follows its removal.
   */
  _contextRestoredHandler() {
    const ctx = this._ctx;
    this._contextLost = false;
    const gen = ++this._restoreGen;
    this._hideOverlayAfterDraw = false;
    this._clearRestoreTimer();
    const render = ctx.render;
    if (render && typeof render.rebuild === 'function') {
      try { render.rebuild(); } catch (err) { this._reportError('render.rebuild', err); }
    }
    let p = null;
    if (render && typeof render.warmup === 'function') {
      try { p = render.warmup(); } catch (err) { warnOnce('engine.restoreWarmup', 'render.warmup after context restore failed: ' + ((err && err.message) ? err.message : String(err))); p = null; }
    }
    if (p && typeof p.then === 'function') {
      this._gfxWarming = true;
      const done = () => this._restoreWarmDone(gen);
      try {
        p.then(done, (err) => {
          warnOnce('engine.restoreWarmup', 'render.warmup after context restore failed: ' + ((err && err.message) ? err.message : String(err)));
          done();
        });
      } catch (_) { done(); }
      if (this._gfxWarming && typeof setTimeout === 'function') this._restoreTimer = setTimeout(done, RESTORE_WARMUP_TIMEOUT_MS);
    } else {
      this._hideOverlayAfterDraw = true;   // no warm-up available: the first completed draw recompiles, then the overlay hides
    }
    this.requestRedraw();
  }

  /** The post-restore warm-up finished (or timed out): draw again and hide the overlay after that draw. */
  _restoreWarmDone(gen) {
    if (gen !== this._restoreGen || this._contextLost || !this._gfxWarming) return;   // stale, or already handled (timeout, then a late resolve)
    this._clearRestoreTimer();
    this._gfxWarming = false;
    this._hideOverlayAfterDraw = true;
    this.requestRedraw();
  }

  _clearRestoreTimer() {
    if (this._restoreTimer) {
      try { clearTimeout(this._restoreTimer); } catch (_) { /* ignore */ }
      this._restoreTimer = 0;
    }
  }

  _hideRestoreOverlay() {
    this._hideOverlayAfterDraw = false;
    const ui = this._ctx.ui;
    if (ui && typeof ui.hideOverlay === 'function') {
      try { ui.hideOverlay(); } catch (_) { /* ignore */ }
    }
  }

  _reportError(where, err) {
    const msg = where + ': ' + ((err && err.message) ? err.message : String(err));
    warnOnce('engine.error.' + where, msg);
    const ui = this._ctx.ui;
    if (ui && typeof ui.showError === 'function') {
      try { ui.showError(msg, false); } catch (_) { /* ignore */ }
    }
    if (this._ctx.events) {
      _errorPayload.message = msg;
      _errorPayload.fatal = false;
      this._ctx.events.emit('error', _errorPayload);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Frame (§4.2) — the exact order A..I
  // -------------------------------------------------------------------------------------------

  _frameSafe(now) {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._onFrame);
    try {
      this.frame(now);
    } catch (err) {
      // A throwing frame would repeat every 16 ms: report once (fatal → RELOAD) and stop the loop.
      if (!this._frameFailed) {
        this._frameFailed = true;
        const msg = (err && err.message) ? err.message : String(err);
        warnOnce('engine.frameError', 'frame error: ' + msg + (err && err.stack ? '\n' + err.stack : ''));
        const ctx = this._ctx;
        if (ctx.events) {
          _errorPayload.message = msg;
          _errorPayload.fatal = true;
          try { ctx.events.emit('error', _errorPayload); } catch (_) { /* ignore */ }
        }
        if (ctx.ui && typeof ctx.ui.showError === 'function') {
          try { ctx.ui.showError(msg, true); } catch (_) { /* ignore */ }
        }
      }
      this.stop();
    }
  }

  /** One frame, in the §4.2 order. `now` is the rAF timestamp (ms). */
  frame(now) {
    const ctx = this._ctx;
    const time = ctx.time;
    const state = ctx.state;

    // A
    this.beginFrame(now);

    const paused = state.is('paused');

    // B — fixed-step simulation (playing) or the title idle loop
    if (state.is('playing')) {
      this._acc += time.dt;
      let n = 0;
      while (this._acc >= STEP && n < MAX_SUBSTEPS && state.is('playing')) {
        this._stepAll(STEP);
        this._acc -= STEP;
        n++;
      }
      if (n === MAX_SUBSTEPS) this._acc = 0;        // drop time, never spiral
      time.alpha = this._acc / STEP;
    } else if (state.is('title')) {
      const level = ctx.level;
      this._acc += time.dt;
      let n = 0;
      while (this._acc >= STEP && n < MAX_SUBSTEPS) {
        if (level && typeof level.idleStep === 'function') level.idleStep(STEP);
        this._acc -= STEP;
        n++;
      }
      if (n === MAX_SUBSTEPS) this._acc = 0;
      time.alpha = this._acc / STEP;
    } else {
      this._acc = 0;
      time.alpha = 0;
    }

    // C — fx (paused: dt 0 so flashes / coin flights keep animating on the unscaled clock)
    const fx = ctx.fx;
    if (fx) fx.update(paused ? 0 : time.dt, time.unscaledDt);

    if (!paused) {
      // D — instance matrix writes only
      const alpha = time.alpha;
      const squad = ctx.squad; if (squad) squad.render(alpha);
      const zombies = ctx.zombies; if (zombies) zombies.render(alpha);
      const boss = ctx.boss; if (boss) boss.render(alpha);
      const gates = ctx.gates; if (gates) gates.render(alpha);
      const pickups = ctx.pickups; if (pickups) pickups.render(alpha);
      const weapons = ctx.weapons; if (weapons) weapons.render(alpha);
      const troops = ctx.troops; if (troops) troops.render(alpha);
      // E — camera, environment scroll, lights, uTime
      const render = ctx.render;
      if (render) render.update(time.dt);
    }

    // F — HUD DOM
    const ui = ctx.ui;
    if (ui) ui.update(time.unscaledDt);

    // G — queued cues, music scheduler
    const audio = ctx.audio;
    if (audio) audio.update(time.unscaledDt);

    // H — draw (paused: ≤ 30 fps on High, otherwise only on render.dirty)
    const render = ctx.render;
    if (render && !this._contextLost && !this._gfxWarming) {
      if (!paused) {
        render.draw();
        this._draws++;
        if (this._hideOverlayAfterDraw) this._hideRestoreOverlay();
      } else {
        const highTier = !!(ctx.quality && ctx.quality.params && ctx.quality.params.blur);
        if ((highTier && now - this._lastPausedDraw >= PAUSE_FRAME_MS) || render.dirty) {
          render.draw();                                // draw() clears render.dirty
          this._draws++;
          this._lastPausedDraw = now;
          if (this._hideOverlayAfterDraw) this._hideRestoreOverlay();
        }
      }
    }

    // I
    this.endFrame();
  }

  _stepAll(dt) {
    const ctx = this._ctx;
    const level = ctx.level; if (level) level.step(dt);
    const squad = ctx.squad; if (squad) squad.step(dt);
    const troops = ctx.troops; if (troops) troops.step(dt);
    const weapons = ctx.weapons; if (weapons) weapons.step(dt);
    const zombies = ctx.zombies; if (zombies) zombies.step(dt);
    const boss = ctx.boss; if (boss) boss.step(dt);
    const gates = ctx.gates; if (gates) gates.step(dt);
    const pickups = ctx.pickups; if (pickups) pickups.step(dt);
  }

  /**
   * Step A: renderer.info.reset(), clocks, slow-mo countdown, gamepad poll and the ONE steering
   * integration per frame into input.targetX (D2). Steering integrates only while playing and
   * not locked; in every other state steerDx is discarded.
   */
  beginFrame(now) {
    const ctx = this._ctx;
    const time = ctx.time;
    const input = ctx.input;

    this._beginMs = nowMs();
    const render = ctx.render;
    if (render && render.renderer && render.renderer.info && typeof render.renderer.info.reset === 'function') {
      render.renderer.info.reset();
    }

    const rawInterval = this._lastNow < 0 ? 0 : now - this._lastNow;
    this._lastInterval = rawInterval;
    time.now = now;
    const unscaled = rawInterval > 0 ? Math.min(DT_CLAMP, rawInterval / 1000) : 0;
    time.unscaledDt = unscaled;

    // CORE-7: the theatre clock and the slow-mo countdown hold while paused (and while the context is lost),
    // so a pause during the boss intro / boss death / game-over theatre resumes where it left off (GDD §14)
    const holdTheatre = ctx.state.is('paused') || this._contextLost;
    if (!holdTheatre) time.theatre += unscaled * 1000;

    // slow-mo countdown on the unscaled clock; the return to 1.0 also notifies audio
    if (time.slowmoLeft > 0 && !holdTheatre) {
      time.slowmoLeft -= unscaled;
      if (time.slowmoLeft <= 0) {
        time.slowmoLeft = 0;
        this.setTimeScale(1, 0);
      }
    }

    time.dt = unscaled * time.scale;
    time.elapsed += time.dt;

    const playing = ctx.state.is('playing');
    if (playing) time.levelTime += time.dt;

    this._pollGamepad();

    if (playing && !input.locked) {
      // keyboard velocity ramps to ±keyboardSpeed over keyboardAccel seconds
      const kbTarget = ((input.keyRight ? 1 : 0) - (input.keyLeft ? 1 : 0)) * STEER.keyboardSpeed;
      const maxStep = STEER.keyboardAccel > 0 ? STEER.keyboardSpeed * unscaled / STEER.keyboardAccel : Math.abs(kbTarget - this._kbVel);
      const diff = kbTarget - this._kbVel;
      this._kbVel += diff > maxStep ? maxStep : (diff < -maxStep ? -maxStep : diff);
      const vel = this._kbVel + input.gamepadX * STEER.keyboardSpeed;
      input.targetX = clamp(input.targetX + input.steerDx * this.getSteerK() + vel * unscaled, -STEER_RANGE, STEER_RANGE);
    } else {
      this._kbVel = 0;
    }
    input.steerDx = 0;
  }

  /** Step I: quality sampler, debug overlay (4 Hz), unlock re-arm, frame counter. */
  endFrame() {
    const ctx = this._ctx;
    const time = ctx.time;
    const jsMs = nowMs() - this._beginMs;
    ctx.debug.jsMs = jsMs;

    const render = ctx.render;
    const info = render && render.renderer ? render.renderer.info : null;
    ctx.debug.calls = info && info.render ? info.render.calls : 0;

    this._sampleScaler(time.now, this._lastInterval, jsMs);

    if (ctx.debug.enabled) {
      this._debugAccum += time.unscaledDt;
      if (this._debugAccum >= 1 / DEBUG_HZ) {
        this._debugAccum = 0;
        this._writeDebugText(info);
      }
    }

    // audio lost its running state (iOS interruption): re-arm the gesture listeners
    const audio = ctx.audio;
    if (audio && !this._unlockArmed && audio.needsGesture === true) this._armUnlockListeners();

    time.frame++;
    this._lastNow = time.now;
  }

  // -------------------------------------------------------------------------------------------
  // Auto-scaler (GDD §16, §6.2)
  // -------------------------------------------------------------------------------------------

  _resetScalerWindow() {
    this._winIdx = 0;
    this._winCount = 0;
    this._sumInt = 0;
    this._sumJs = 0;
    this._slowSince = -1;
    this._fastSince = -1;
  }

  // ---- refresh probe (CORE-6) ---------------------------------------------------------------

  /**
   * (Re)measures the display refresh: a separate rAF chain that draws nothing and keeps only the intervals in
   * which no renderer.render() ran (boot screen before the warm-up, pause on Med/Low, menus never count since
   * they draw every frame), hitch-filtered. The median of ≥ refreshMinSamples such intervals, snapped to
   * refreshSnap, becomes time.refreshMs; with fewer by refreshProbeMs the previous value stays. Called at
   * init (boot step 8), on visibilitychange → visible, after each trailing resize and on pause. A call while a
   * probe runs only extends its deadline (samples kept).
   */
  measureRefresh() {
    if (typeof requestAnimationFrame !== 'function') return;
    this._probeDeadline = nowMs() + SCALER.refreshProbeMs;
    if (this._probeOn) return;
    this._probeOn = true;
    this._refreshCount = 0;
    this._probeLast = -1;
    this._probeDrawMark = -1;
    this._probeDrewPrev = true;
    try { this._probeRaf = requestAnimationFrame(this._onProbe); } catch (_) { this._probeOn = false; }
  }

  _stopProbe() {
    if (this._probeRaf && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(this._probeRaf); } catch (_) { /* ignore */ }
    }
    this._probeRaf = 0;
    this._probeOn = false;
  }

  /** Draw counter: three's renderer.info.render.frame (every renderer.render, warm-up and passes included). */
  _drawMark() {
    const render = this._ctx.render;
    const r = render ? render.renderer : null;
    if (r && r.info && r.info.render && typeof r.info.render.frame === 'number') return r.info.render.frame + this._draws;
    return this._draws;
  }

  _probeFrame(t) {
    this._probeRaf = 0;
    if (!this._probeOn) return;
    const mark = this._drawMark();
    const drew = mark !== this._probeDrawMark;
    this._probeDrawMark = mark;
    if (this._probeLast >= 0 && !drew && !this._probeDrewPrev && !this._contextLost) {
      const iv = t - this._probeLast;
      if (iv > 0 && iv < HITCH_IGNORE_MS && this._refreshCount < SCALER.refreshSamples) this._refreshSamples[this._refreshCount++] = iv;
    }
    this._probeDrewPrev = drew;
    this._probeLast = t;
    if (this._refreshCount >= SCALER.refreshSamples || nowMs() >= this._probeDeadline) {
      this._probeOn = false;
      if (this._refreshCount >= SCALER.refreshMinSamples) this._finishRefresh();
      return;
    }
    try { this._probeRaf = requestAnimationFrame(this._onProbe); } catch (_) { this._probeOn = false; }
  }

  _finishRefresh() {
    // median of the collected draw-free intervals, snapped to the nearest refresh interval
    const n = this._refreshCount;
    if (n <= 0) return;
    const arr = this._refreshSamples.subarray(0, n);
    arr.sort();
    const median = n % 2 === 1 ? arr[(n - 1) >> 1] : 0.5 * (arr[(n >> 1) - 1] + arr[n >> 1]);
    const snaps = SCALER.refreshSnap;
    let best = snaps[snaps.length - 1];
    let bestDiff = Infinity;
    for (let i = 0; i < snaps.length; i++) {
      const d = Math.abs(snaps[i] - median);
      if (d < bestDiff) { bestDiff = d; best = snaps[i]; }
    }
    this._ctx.time.refreshMs = best;
  }

  /** The scaler's frame-interval target: max(time.refreshMs, QUALITY_TIERS.scaler.targetMinMs) (GDD §16, CORE-6). */
  get frameTargetMs() {
    const rf = this._ctx.time ? this._ctx.time.refreshMs : TARGET_MIN_MS;
    return rf > TARGET_MIN_MS ? rf : TARGET_MIN_MS;
  }

  _sampleScaler(now, intervalMs, jsMs) {
    const ctx = this._ctx;
    const validInterval = intervalMs > 0 && intervalMs < HITCH_IGNORE_MS;
    if (validInterval) {
      this._fpsSmooth = this._fpsSmooth === 0 ? intervalMs : this._fpsSmooth + (intervalMs - this._fpsSmooth) * 0.1;   // display smoothing only
    }

    const q = ctx.quality;
    if (!ctx.state.is('playing') || !q) { this._resetScalerWindow(); return; }
    if (!q.auto || ctx.time.theatre < q.frozenUntil) { this._resetScalerWindow(); return; }
    if (!validInterval) return;

    const W = SCALER.window;
    const i = this._winIdx;
    if (this._winCount === W) {
      this._sumInt -= this._winInt[i];
      this._sumJs -= this._winJs[i];
    } else {
      this._winCount++;
    }
    this._winInt[i] = intervalMs;
    this._winJs[i] = jsMs;
    this._sumInt += intervalMs;
    this._sumJs += jsMs;
    this._winIdx = i + 1 === W ? 0 : i + 1;
    if (this._winCount < W) return;

    const meanInt = this._sumInt / W;
    const meanJs = this._sumJs / W;
    const rf = this.frameTargetMs;   // max(refresh, 16.67): a 90/120 Hz panel never demotes a tier holding 60 fps
    const idx = tierIndex(q.tier);

    if (meanInt > SCALER.dropFactor * rf) {
      if (this._slowSince < 0) this._slowSince = now;
    } else {
      this._slowSince = -1;
    }
    const raiseOk = meanInt <= SCALER.raiseFactor * rf && meanJs < SCALER.raiseJsMs && idx < tierIndex(q.maxAutoTier);
    if (raiseOk) {
      if (this._fastSince < 0) this._fastSince = now;
    } else {
      this._fastSince = -1;
    }

    if (now - this._lastChangeAt < SCALER.hysteresis * 1000) return;
    if (this._slowSince >= 0 && now - this._slowSince >= SCALER.dropAfter * 1000 && idx > 0) {
      if (this._autoDrops[idx] < 255) this._autoDrops[idx]++;
      this._applyTier(TIER_ORDER[idx - 1], 'auto');
    } else if (this._fastSince >= 0 && idx < TIER_ORDER.length - 1
      && now - this._fastSince >= SCALER.raiseAfter * 1000 * Math.pow(SCALER.raiseBackoff, this._autoDrops[idx + 1])) {
      this._applyTier(TIER_ORDER[idx + 1], 'auto');
    }
  }

  _applyTier(tier, reason) {
    const q = this._ctx.quality;
    if (TIER_ORDER.indexOf(tier) === -1) return;
    q.tier = tier;
    q.params = QUALITY_TIERS[tier];
    this._lastChangeAt = this._ctx.time.now;
    this._resetScalerWindow();
    this._emitQuality(reason);
    this.requestRedraw();
  }

  _emitQuality(reason) {
    const ctx = this._ctx;
    const q = ctx.quality;
    _qualityPayload.tier = q.tier;
    _qualityPayload.params = q.params;
    _qualityPayload.reason = reason;
    if (ctx.events) ctx.events.emit('quality:change', _qualityPayload);
  }

  // -------------------------------------------------------------------------------------------
  // Debug overlay (§13) — strings built at 4 Hz only, never per frame
  // -------------------------------------------------------------------------------------------

  _writeDebugText(info) {
    const ctx = this._ctx;
    const ui = ctx.ui;
    if (!ui || typeof ui.setDebugText !== 'function') return;
    const time = ctx.time;
    const q = ctx.quality;
    const render = ctx.render;
    const fps = this._fpsSmooth > 0 ? 1000 / this._fpsSmooth : 0;
    const meanJs = this._winCount > 0 ? this._sumJs / this._winCount : ctx.debug.jsMs;
    const calls = info && info.render ? info.render.calls : 0;
    const tris = info && info.render ? info.render.triangles : 0;
    // render.draw() samples the main-pass calls after the RenderPass; field names are the integration contract
    const stats = render && render.callStats ? render.callStats : null;
    const mainCalls = stats ? stats.main : calls;
    const shadowCalls = stats ? stats.shadow : 0;
    const postCalls = stats ? stats.post : 0;

    const redCalls = stats ? mainCalls > BUDGET.mainCalls : calls > BUDGET.mainCalls + BUDGET.shadowCalls + BUDGET.postCalls;
    const redJs = meanJs > BUDGET.jsMs;

    let text = 'fps ' + fps.toFixed(1) + ' | refresh ' + time.refreshMs.toFixed(2) + ' ms (target ' + this.frameTargetMs.toFixed(2) + ') | js ' + meanJs.toFixed(2) + ' ms' + (redJs ? ' !!' : '') + '\n';
    text += 'calls ' + calls + (stats ? ' (main ' + mainCalls + ' / shadow ' + shadowCalls + ' / post ' + postCalls + ')' : '') + (redCalls ? ' !!' : '') + ' | tris ' + tris
      + (stats && typeof stats.materials === 'number' ? ' | mats ' + stats.materials : '') + '\n';   // VIS-13: distinct materials drawn (render resamples every 30 draws)
    text += 'tier ' + (q ? q.tier : '?') + (q ? ' (max ' + q.maxAutoTier + (q.auto ? ', auto' : ', manual') + ')' : '')
      + ' | dpr ' + (render && render.size && typeof render.size.dpr === 'number' ? render.size.dpr.toFixed(2) : (q ? String(q.dpr) : '?'))
      + ' | scale ' + time.scale.toFixed(2) + ' | state ' + ctx.state.current + ' | frame ' + time.frame + '\n';

    const squad = ctx.squad, zombies = ctx.zombies, weapons = ctx.weapons, fx = ctx.fx;
    text += 'squad ' + (squad ? squad.count + '/' + squad.visible : '-')
      + ' | zombies ' + (zombies ? zombies.alive : '-')
      + ' | bullets ' + (weapons ? weapons.liveBullets : '-')
      // WPN-7: trigger pulls per second (weapons refreshes it each second) and live laser beams
      + ' | shots/s ' + (ctx.debug.shotsPerSec >= 0 ? ctx.debug.shotsPerSec : '-') + (ctx.debug.laserBeams > 0 ? ' | beams ' + ctx.debug.laserBeams : '')
      + ' | particles ' + (fx && typeof fx.particleCount === 'number' ? fx.particleCount : '-')
      + ' | x ' + (ctx.world && typeof ctx.world.squadX === 'number' ? ctx.world.squadX.toFixed(2) : '-') + ' target ' + ctx.input.targetX.toFixed(2) + '\n';

    const dropped = ctx.debug.dropped;
    let droppedText = '';
    for (const k in dropped) {
      if (Object.prototype.hasOwnProperty.call(dropped, k) && dropped[k] > 0) droppedText += (droppedText ? ', ' : '') + k + ' ' + dropped[k];
    }
    if (droppedText) text += 'dropped: ' + droppedText + '\n';

    const hist = ctx.debug.histograms;
    for (const key in hist) {
      if (!Object.prototype.hasOwnProperty.call(hist, key)) continue;
      const arr = hist[key];
      if (!arr || arr.length === 0) continue;
      const last = arr[arr.length - 1];   // CORE-4: rounded like mean (integers stay integers)
      let sum = 0;
      for (let i = 0; i < arr.length; i++) sum += arr[i];
      text += key + ' n=' + arr.length + ' mean ' + (sum / arr.length).toFixed(1) + ' last ' + (Number.isInteger(last) ? String(last) : last.toFixed(2)) + '\n';
    }

    try {
      ui.setDebugText(text);
      const panel = ui.debugPanel;
      if (panel && panel.classList) panel.classList.toggle('red', redCalls || redJs);
    } catch (_) { /* overlay is best-effort */ }
  }

  // -------------------------------------------------------------------------------------------
  // Public API (§6.2)
  // -------------------------------------------------------------------------------------------

  /**
   * Slow-mo (used by fx.slowmo): sets time.scale (clamped to [WORLD.timeScaleMin, 1]) and the
   * unscaled countdown; notifies audio on every call, including the return to 1.0.
   */
  setTimeScale(scale, seconds) {
    const time = this._ctx.time;
    const s = clamp(Number.isFinite(scale) ? scale : 1, TIME_SCALE_MIN, 1);
    time.scale = s;
    time.slowmoLeft = s < 1 && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const audio = this._ctx.audio;
    if (audio && typeof audio.setTimeScale === 'function') {
      try { audio.setTimeScale(s); } catch (_) { /* audio reports its own errors */ }
    }
  }

  /** playing → paused; emits `pause`; ducks music; arms the paused redraw gate. */
  pause() {
    const ctx = this._ctx;
    if (!ctx.state.is('playing')) return;
    this._clearTransientInput();
    ctx.state.set('paused');
    const audio = ctx.audio;
    if (audio && typeof audio.duck === 'function') {
      try { audio.duck(MUSIC.duck.pause, 0); } catch (_) { /* ignore */ }
    }
    this._lastPausedDraw = 0;
    this.requestRedraw();
    this.measureRefresh();   // paused frames are draw-free on Med / Low: a clean refresh sample window
    if (ctx.events) ctx.events.emit('pause', _emptyPayload);
  }

  /** paused → playing; emits `resume`; restores the duck and the continuous redraw. */
  resume() {
    const ctx = this._ctx;
    if (!ctx.state.is('paused')) return;
    if (this._contextLost || this._gfxWarming) return;   // wait for webglcontextrestored + the shader warm-up
    this._clearTransientInput();
    ctx.state.set('playing');
    const audio = ctx.audio;
    if (audio && typeof audio.duck === 'function') {
      try { audio.duck(0, 0); } catch (_) { /* ignore */ }
    }
    this._resetScalerWindow();
    this.requestRedraw();
    if (ctx.events) ctx.events.emit('resume', _emptyPayload);
  }

  /** Marks the scene dirty so the next paused frame runs step H once. */
  requestRedraw() {
    const render = this._ctx.render;
    if (render) render.dirty = true;
  }

  /** time.levelTime = 0 (LevelRunner.start / startEndless / restart). */
  resetLevelClock() {
    this._ctx.time.levelTime = 0;
  }

  /**
   * Manual tier ('low' | 'med' | 'high') disables auto and emits quality:change {reason:'manual'};
   * 'auto' re-enables the scaler on the current tier.
   */
  setQuality(tier) {
    const q = this._ctx.quality;
    if (!q) return;
    if (tier === 'auto') {
      q.auto = true;
      this._autoDrops.fill(0);   // a fresh opt-in to auto starts without raise back-off
      this._resetScalerWindow();
      return;
    }
    if (TIER_ORDER.indexOf(tier) === -1) {
      warnOnce('engine.badTier.' + tier, 'setQuality: unknown tier "' + tier + '"');
      return;
    }
    q.auto = false;
    if (tier === q.tier) return;
    this._applyTier(tier, 'manual');
  }

  /** Freezes the auto-scaler until time.theatre + seconds·1000 (boss intro, level start; a pause does not use it up). */
  freezeQuality(seconds) {
    const q = this._ctx.quality;
    if (!q || !Number.isFinite(seconds)) return;
    const until = this._ctx.time.theatre + seconds * 1000;
    if (until > q.frozenUntil) q.frozenUntil = until;
    this._resetScalerWindow();
  }

  /** Suspends steering integration and hasSteered (boss intro). */
  lockInput(locked) {
    this._ctx.input.locked = !!locked;
    if (locked) this._kbVel = 0;
  }

  /** targetX = 0, steerDx = 0 (LevelRunner.start); hasSteered is left untouched. */
  resetSteering() {
    const input = this._ctx.input;
    input.targetX = 0;
    input.steerDx = 0;
    this._kbVel = 0;
  }

  /**
   * Metres per CSS pixel: SQUAD.steer.k / (SQUAD.steer.kFraction · W_eff) · sensitivity, with W_eff = viewport width
   * in portrait and min(width, SQUAD.steer.landscapeWidthFactor · height) in landscape (aspect ≥
   * WORLD.camera.portraitBelow), where the camera frames the road by the height (CORE-8, GDD §3.2).
   */
  getSteerK() {
    const ctx = this._ctx;
    let w = 0, h = 0;
    const render = ctx.render;
    if (render && render.size && render.size.w > 0 && render.size.h > 0) { w = render.size.w; h = render.size.h; }
    else if (ctx.app && ctx.app.clientWidth > 0 && ctx.app.clientHeight > 0) { w = ctx.app.clientWidth; h = ctx.app.clientHeight; }
    else { w = REF_WIDTH_PX; h = REF_HEIGHT_PX; }
    if (w / h >= WORLD.camera.portraitBelow) {
      const lw = STEER.landscapeWidthFactor * h;
      if (lw > 0 && lw < w) w = lw;
    }
    return STEER.k / (STEER.kFraction * w) * this._sensitivity;
  }

  /** True while the WebGL context is lost (draws are skipped). */
  get contextLost() { return this._contextLost; }

  /** True while the rAF loop runs. */
  get running() { return this._running; }
}
