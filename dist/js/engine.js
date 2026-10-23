// js/engine.js — Gate Rush core loop (ARCHITECTURE §6.2, §4.2, §5).
//
// Exports: EventBus, detectTier, maxAutoTierFor, isSoftwareGpu, StateMachine, Engine.
//
// The Engine owns ctx.time / ctx.state / ctx.input / ctx.debug, adopts ctx.quality (created by
// render.init), runs the requestAnimationFrame loop with the fixed-step accumulator (§2.2), owns
// every input listener on #app (pointer steering with capture, keyboard, gamepad), the audio
// unlock gesture, resize / orientation / visibility / context-loss listeners, the quality
// auto-scaler (GDD §16) and the debug overlay text (§13). Round 7 adds the render-scale rungs (software GL), the frozen
// slow-device menus, the context-loss give-up, the pause on window blur and the diagnostics ring buffer
// (window.__gateRushDiag(), ARCH §13).
//
// This module never touches document / window / navigator at import time: every browser access
// happens inside init() or a listener, and every optional API is guarded (§14 rule 4).
import { clamp, isIOS, warnOnce } from './util.js';
import { WORLD, SQUAD, QUALITY_TIERS, MUSIC, JUICE, STRINGS } from './data.js';

// ---------------------------------------------------------------------------------------------
// Module constants (every literal names its data.js source)
// ---------------------------------------------------------------------------------------------

const STEP = WORLD.step;                        // 1/60 fixed simulation step
const MAX_SUBSTEPS = WORLD.maxSubSteps;         // 12 (r7: = dtClampMax / step)
const DT_CLAMP = WORLD.dtClamp;                 // 0.05 s: the clamp while the sustained frame time is short
// round 7 (r7, perf-render:0): the frame dt clamp follows the sustained frame interval (WORLD.dtFollow × the EMA of the
// rAF intervals of drawing frames, between dtClamp and dtClampMax), so a 5–20 fps device plays in real time
const DT_CLAMP_MAX = WORLD.dtClampMax;          // 0.2 s (real time down to 5 fps)
const DT_FOLLOW = WORLD.dtFollow;               // 1.25 × the sustained interval
const DT_EMA_RATE = WORLD.dtEmaRate;            // 0.1 per frame
const DT_EMA_CAP_MS = WORLD.dtEmaCapMs;         // 1000 ms: longer gaps (tab switch, debugger, stall) never feed the EMA
const TIME_SCALE_MIN = WORLD.timeScaleMin;      // 0.25
const STEER_RANGE = WORLD.steerRange;           // ±2.1 m
const STEER = SQUAD.steer;                      // k, kFraction, deadZonePx, smoothRate, maxSpeed, keyboardSpeed, gamepadSpeed, gamepadDeadZone, iosEdgePx
// r7 (controls:0): on a key press edge the steering target leads the squad by the distance the squad's exponential
// follow trails a target moving at maxSpeed (maxSpeed / smoothRate = 0.857 m), so the squad leaves at full speed
const KB_LEAD = STEER.maxSpeed / STEER.smoothRate;
const SCALER = QUALITY_TIERS.scaler;            // window, dropFactor, dropAfter, raiseFactor, raiseJsMs, raiseAfter, hysteresis, refreshSamples, refreshSnap, targetMinMs, refreshMinSamples, refreshProbeMs, windowSec, windowMin, hitchFactor, hitchMaxMs, emergencyFactor, emergencyHysteresis
const RS = QUALITY_TIERS.renderScale;           // r7 (perf-render:1): ladder, softwareStart, dropAfter, raiseAfter, hysteresis, raiseMargin, minBackingPx (software GL only, r7 final fix)
const TIER_ORDER = QUALITY_TIERS.order;         // ['low', 'med', 'high']
const PAUSE_FRAME_MS = 1000 / QUALITY_TIERS.pauseFps;   // 33 ms redraw gate while paused on High
// r7 (perf-render:9): the paused High redraw gate runs only on a device that held ≥ 15 fps (sustained frame time ≤ two
// pause frames) while playing, and never on software GL: a 330 ms paused High frame starved the menus and the tier compile
const PAUSE_REDRAW_MAX_MS = 2 * PAUSE_FRAME_MS;
// r7 (flow-coins:1): states whose 3D scene sits under a menu scrim; on a slow device they stop redrawing after the settle
// (QUALITY_TIERS.menuSettleMs of real time — r7 fix: was the theatre clock) and draw only on render.dirty. 'title' always draws.
const MENU_STATES = Object.freeze({ complete: true, gameover: true, shop: true, levels: true });
const MENU_LITE_MS = QUALITY_TIERS.menuLiteFrameMs;   // 40 ms sustained frame time (25 fps) at menu entry → lite
const MENU_SETTLE_MS = QUALITY_TIERS.menuSettleMs;    // 1000 ms: the boss collapse / confetti / game-over dolly finish first
const MENU_SETTLE_MAX_FRAME_MS = QUALITY_TIERS.menuSettleMaxFrameMs;   // r7 fix: 250 ms sustained frames (≤ 4 fps) → no settle
const SW_AUTO_ONCE = 'quality.swAuto';   // r7 fix: save hint id — the one-time saved Low → Auto on software GL (_softwareAutoOnce)
const RESTORE_GIVEUP_MS = QUALITY_TIERS.restoreGiveUpMs;   // r7 (flow-coins:4): 12 s of visible time without webglcontextrestored → fatal box
const DIAG = QUALITY_TIERS.diag;                // r7: diagnostics ring buffer (entries, gapMs, watchdogMs, stallMs, screenDelayMs, overlayLines)
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

// Back guard (round 6, ARCH §6.2 "Back guard"): the history.state of the one entry engine keeps above the page's own
// while the player is anywhere but the title, so the Android back gesture / button pauses (or steps back a screen)
// instead of closing the installed app. Protocol values, not tuning: the marker only has to be recognisable.
const BACK_GUARD_STATE = Object.freeze({ gateRush: 'back-guard' });
const BACK_GUARD_RESYNC_MS = 1000;   // a dropped guard whose popstate never arrived re-reads history.state after this
// r6 verify: after a Back the guard is re-armed by stepping FORWARD onto the entry the Back just left (a traversal adds
// no entry). A pushState from popstate never has a fresh user activation, and Chrome's history-manipulation
// intervention then marks the page's own entry skippable, so the second Back in a row closed the app (measured with a
// browser-initiated Back, chrome.tabs.goBack, docs/build/r6-verify.md §2.2). A forward whose popstate never arrives
// (no forward entry) falls back to the push after this.
const BACK_GUARD_FORWARD_MS = 600;
// the results screens' Back is their HOME icon (they have no [data-back] button)
const BACK_HOME_BTN = Object.freeze({ complete: 'btn-complete-home', gameover: 'btn-home', endless: 'btn-endless-home' });

const VALID_STATES = Object.freeze(['boot', 'title', 'levels', 'shop', 'playing', 'paused', 'complete', 'gameover']);

// Reused payload objects (§5: emitters reuse module-level payloads; listeners never retain them)
const _statePayload = { from: 'boot', to: 'boot', data: null };
const _resizePayload = { w: 0, h: 0, dpr: 1, portrait: true };
const _qualityPayload = { tier: 'med', params: null, reason: 'init' };
const _scalePayload = { scale: 0.5, reason: 'init', meanInt: 0.5 };   // r7 quality:scale (fraction fields seeded as Doubles, §14 rule 11)
const _emptyPayload = {};
const _errorPayload = { message: '', fatal: false };

function nowMs() {
  if (typeof performance !== 'undefined' && performance !== null && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function isBackGuardState(s) {
  return s !== null && typeof s === 'object' && s.gateRush === BACK_GUARD_STATE.gateRush;
}

function tierIndex(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return i < 0 ? 0 : i;
}

/** Index of the QUALITY_TIERS.renderScale.ladder rung nearest to `s` (r7). */
function rungIndex(s) {
  const L = RS.ladder;
  let k = 0;
  for (let j = 1; j < L.length; j++) if (Math.abs(L[j] - s) < Math.abs(L[k] - s)) k = j;
  return k;
}

/** 'id.class1.class2' of a DOM node for the diagnostics log (r7; event-driven, never per frame). */
function nodeTag(el) {
  if (!el || typeof el !== 'object') return '?';
  let s = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : String(el.nodeName || 'window');
  try {
    if (el.id) s += '#' + el.id;
    const c = typeof el.getAttribute === 'function' ? el.getAttribute('class') : null;
    if (c) s += '.' + c.trim().split(/\s+/).slice(0, 2).join('.');
  } catch (_) { /* detached / foreign node */ }
  return s;
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

/**
 * Round 7 (r7, perf-render:2): true when the GPU string names a software rasteriser (the QUALITY_TIERS.heuristics rule
 * with `software: true` — SwiftShader, llvmpipe / softpipe / lavapipe, WARP, OSMesa). render.init also treats a context
 * that fails `failIfMajorPerformanceCaveat` as software. Pure.
 * @param {string|null} gpuString
 * @returns {boolean}
 */
export function isSoftwareGpu(gpuString) {
  if (typeof gpuString !== 'string' || gpuString.length === 0) return false;
  const rule = matchRule(gpuString);
  return !!(rule && rule.software);
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
    // r7 (perf-render:0): EMA of the rAF intervals of frames that drew (ms; 0 = none yet) — the sustained frame time the
    // dt clamp, the scaler's hitch filter, the paused redraw gate and the lite-menu decision follow (sustainedFrameMs)
    this._ivEma = 0.5; this._ivEma = 0;
    this._drewFrame = false;     // step H of the previous frame drew (its interval may feed _ivEma)
    this._pauseEma = 0.5; this._pauseEma = 0;         // _ivEma when pause() ran (perf-render:9 paused redraw gate)
    this._beginMs = 0.5; this._beginMs = 0;           // performance.now() at beginFrame (jsMs measurement)
    this._frameFailed = false;   // a frame threw: reported once, loop stopped
    this._contextLost = false;
    this._gfxWarming = false;      // after webglcontextrestored: programs recompiling behind the overlay (draws skipped)
    this._restoreGen = 0;          // bumps on every loss / restore so a stale warm-up completion is ignored
    this._hideOverlayAfterDraw = false;   // hide 'Reloading graphics…' once the first post-restore draw has completed
    this._restoreTimer = 0;
    this._lastPausedDraw = 0;
    // r7 (flow-coins:4): give-up timer of a context loss (visible time only); armed while lost and visible
    this._giveUpTimer = 0;
    this._onGiveUp = () => this._giveUp();
    // r7 (flow-coins:1): lite menus — rAF time (ms) the current menu run began (-1: not in a menu), the slow-device
    // decision taken at its entry and its settle (ms: menuSettleMs, or 0 on a device slower than menuSettleMaxFrameMs),
    // and a dirty redraw due next frame (so the DOM screen change paints first)
    this._menuSince = 0.5; this._menuSince = -1;
    this._menuLite = false;
    this._menuSettle = 0.5; this._menuSettle = MENU_SETTLE_MS;
    this._menuDrawDue = false;

    // pointer steering
    this._pointerId = -1;
    this._lastX = 0;
    this._gestureAbs = 0;

    // keyboard / gamepad (r7 controls:0: no velocity ramp)
    this._kbDir = 0;             // steering direction applied last frame (−1 / 0 / +1): a change is a press / release edge
    this._kbLastDir = 0;         // direction of the most recent key press (wins while both keys are held)
    this._kbTap = 0;             // presses since the last simulation step (bit 1 left, bit 2 right): every tap steers ≥ 1 step
    this._gamepadOk = false;
    this._gamepadSeen = false;
    this._gpStartDown = false;
    this._muted = false;

    // settings cache
    this._sensitivity = 1;

    // back guard (armBackGuard): one history entry above the page's own while not on the title
    this._guardOk = false;       // armed: popstate listened to, history usable, top-level index shell
    this._guardOn = false;       // the guard entry is the current history entry
    this._guardDropping = false; // history.back() issued to leave the guard on arriving at the title; its popstate is ours
    this._guardTimer = 0;
    this._guardForwarding = false; // history.forward() issued to re-arm the guard after a Back; its popstate is ours
    this._guardFwdTimer = 0;
    this._screen = 'boot';       // last ui:screen id (null = HUD only); 'settings' is an overlay, not a state

    // r7: pause on window blur — the page had focus (document.hasFocus() at init, then window focus / blur), and the
    // player gave a trusted input (pointer, key, gamepad) since the last title screen (the click that started the run counts)
    this._hasFocus = false;
    this._polledFocus = false;   // document.hasFocus() at the last 1 s poll (_pollFocus)
    this._userInput = false;
    this._visible = true;        // document.visibilityState, mirrored by the visibilitychange listener
    this._visibleSince = 0.5; this._visibleSince = 0;   // nowMs() of the last hidden → visible change (diag frame gaps)

    // r7: DPR change listener — matchMedia('(resolution: <dpr>dppx)') (a window moved to another monitor fires no ResizeObserver)
    this._dprQuery = null;

    // r7: diagnostics ring buffer (window.__gateRushDiag(), ARCH §13): preallocated, written only on events, never per frame
    this._diagT = new Float64Array(DIAG.entries);
    this._diagTxt = new Array(DIAG.entries).fill('');
    this._diagHead = 0;
    this._diagN = 0;
    this._diagWatch = 0;         // setInterval id of the 1 s watch (rAF watchdog + the focus poll)
    this._diagScreenTimer = 0;   // pending "visible screens" read after a state change
    this._diagStall = false;     // the watchdog logged the current rAF silence (cleared by the next frame)
    this._diagFn = null;         // the function installed as window.__gateRushDiag

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
    this._onFocus = () => this._focus();
    this._onVisibility = () => this._visibilityChange();
    this._onDprChange = () => this._dprChange();
    // r7 diagnostics: window pointerdown (capture) target + state, errors, the rAF watchdog, the post-state-change screen read
    this._onDiagPointer = (e) => this._diagPointer(e);
    this._onDiagError = (e) => this._diag(e && e.message
      ? 'error ' + e.message + (e.filename ? ' @ ' + String(e.filename).replace(/^.*\//, '') + ':' + (e.lineno | 0) : '')
      : 'load error on ' + nodeTag(e ? e.target : null));   // capture phase: a failed <img>/<script>/<link> as well
    this._onDiagRejection = (e) => { const r = e ? e.reason : null; this._diag('rejection ' + (r && r.message ? r.message : String(r))); };
    this._onDiagWatch = () => { this._diagWatchdog(); this._pollFocus(); };
    this._onDiagScreen = () => { this._diagScreenTimer = 0; this._diag('screens ' + this._visibleScreens() + ' (state ' + this._ctx.state.current + ')'); };
    this._onDiagState = (p) => this._diagState(p);
    this._onDiagBusError = (p) => { if (p) this._diag((p.fatal ? 'fatal ' : 'error ') + String(p.message)); };
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
    this._onPopState = (e) => this._popState(e);
    this._onUiScreen = (p) => this._uiScreen(p);
    this._onGuardResync = () => this._guardResync();
    this._onGuardForwardTimeout = () => this._guardForwardTimeout();
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
    // r7 (perf-render:1): render-scale rungs below the lowest tier — software GL only (r7 final fix, _sampleRenderScale)
    this._rsChangedAt = -Infinity;   // time.now of the last rung change (RS.hysteresis)
    this._rsFastSince = -1;          // the raise condition holds since (ms), -1 = not
    this._rsDrops = new Uint8Array(RS.ladder.length);   // auto drops FROM each rung this session (raise back-off)
    // r7 final fix (lead decision 5): real-clock time (nowMs) of the last trusted player input — a pointer press or a steering
    // drag's move, a key, a gamepad stick or button. ui marks a once-ever lesson done only while the last input is at most
    // JUICE.ui.hintIdleS s old (inputIdleS): a lesson shown to an idle screen comes back. −Infinity until the first input
    this.lastInputMs = -Infinity;

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
    this._installDiag();
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
        window.removeEventListener('focus', this._onFocus);
        window.removeEventListener('gamepadconnected', this._onGamepadConnected);
        window.removeEventListener('resize', this._onResizeAny);
        window.removeEventListener('orientationchange', this._onResizeAny);
        window.removeEventListener('popstate', this._onPopState);
        window.removeEventListener('pointerdown', this._onDiagPointer, true);
        window.removeEventListener('error', this._onDiagError, true);
        window.removeEventListener('unhandledrejection', this._onDiagRejection);
        if (this._diagFn !== null && window.__gateRushDiag === this._diagFn) delete window.__gateRushDiag;
      } catch (_) { /* ignore */ }
    }
    this._diagFn = null;
    this._unwatchDpr();
    if (this._diagWatch) { try { clearInterval(this._diagWatch); } catch (_) { /* ignore */ } this._diagWatch = 0; }
    if (this._diagScreenTimer) { try { clearTimeout(this._diagScreenTimer); } catch (_) { /* ignore */ } this._diagScreenTimer = 0; }
    this._clearGiveUp();
    if (this._guardTimer) {
      try { clearTimeout(this._guardTimer); } catch (_) { /* ignore */ }
      this._guardTimer = 0;
    }
    if (this._guardFwdTimer) {
      try { clearTimeout(this._guardFwdTimer); } catch (_) { /* ignore */ }
      this._guardFwdTimer = 0;
    }
    this._guardForwarding = false;
    this._guardOk = false;
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
      // dpr / renderScale hold fractions: created from 0.5 (ARCH §14 rule 11), then set
      ctx.quality = { tier, initialTier: tier, maxAutoTier: maxAutoTierFor(null, tier), auto: cfgQuality == null, params: QUALITY_TIERS[tier], dpr: 0.5, frozenUntil: 0,
        renderScale: 0.5, software: false };
      ctx.quality.dpr = 1;
      ctx.quality.renderScale = 1;
      warnOnce('engine.qualityStub', 'ctx.quality was missing at Engine.init(); created a fallback (render stubbed?)');
    }
    const q = ctx.quality;
    if (TIER_ORDER.indexOf(q.tier) === -1) q.tier = QUALITY_TIERS.fallbackTier;
    if (!q.params) q.params = QUALITY_TIERS[q.tier];
    if (TIER_ORDER.indexOf(q.maxAutoTier) === -1) q.maxAutoTier = q.tier;
    if (typeof q.frozenUntil !== 'number') q.frozenUntil = 0;
    if (!(q.renderScale > 0)) q.renderScale = 1;
    if (typeof q.software !== 'boolean') q.software = false;
    // A saved manual quality (settings.quality !== 'auto') applies at boot unless ?quality= forces a tier.
    let saved = this._savedQuality();
    if (cfgQuality == null && q.software) saved = this._softwareAutoOnce(saved);
    if (cfgQuality == null && saved !== null && saved !== 'auto') {
      q.auto = false;
      if (saved !== q.tier) { q.tier = saved; q.params = QUALITY_TIERS[saved]; }
    } else if (cfgQuality != null) {
      q.auto = false;
    }
    // r7 (perf-render:1): the render-scale rungs belong to Auto; a manual tier (saved or ?quality=) renders at scale 1.
    // The init quality:change that follows re-sizes the canvas (render.applyQuality → _applySize) before anything draws.
    if (!q.auto) q.renderScale = 1;
  }

  /**
   * r7 fix (perf-render:1 B): the first boot of this build on software GL turns a saved manual Low into Auto, once (save
   * hint SW_AUTO_ONCE, set on that boot whatever the setting was, so a Low chosen afterwards stays). On software GL Auto
   * IS Low — no AA, a Low ceiling — plus the render-scale rungs a manual tier never gets: 21.7 fps against 9.6 at manual
   * Low on the tester's kind of box. 1.2.x players picked Low because Auto was the slow choice there (the tester did).
   */
  _softwareAutoOnce(saved) {
    const save = this._ctx.save;
    if (!save || typeof save.hintDone !== 'function' || typeof save.markHint !== 'function') return saved;
    try {
      if (save.hintDone(SW_AUTO_ONCE)) return saved;
      save.markHint(SW_AUTO_ONCE);
      if (saved !== 'low' || typeof save.setSetting !== 'function') return saved;
      save.setSetting('quality', 'auto');
    } catch (_) { return saved; }
    this._diag('quality: the saved Low is Auto now (software GL, once)');
    return 'auto';
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
    this._unsubs.push(events.on('state:change', this._onDiagState));   // r7: diagnostics + the blur-pause input reset
    this._unsubs.push(events.on('error', this._onDiagBusError));
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
      window.addEventListener('focus', this._onFocus);
      try { window.addEventListener('gamepadconnected', this._onGamepadConnected); } catch (_) { /* ignore */ }
    }
    if (hasDoc) {
      document.addEventListener('visibilitychange', this._onVisibility);
      // r7 blur pause: a page that never had focus (a background tab, a framed page the player has not clicked into, a
      // headless harness) cannot lose it; window 'focus' marks it focused later
      try { this._hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() === true : false; } catch (_) { this._hasFocus = false; }
      this._polledFocus = this._hasFocus;
      try { this._visible = document.visibilityState !== 'hidden'; } catch (_) { this._visible = true; }
    }

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
      this._watchDpr();   // r7 (perf-render:6): DPR-only changes (another monitor) resize too
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
    // r7 fix: a drag steers only while playing (beginFrame drops steerDx in every other state). Capturing a press on a
    // menu retargeted its click to #app, outside ui's #ui listener — a tap on the results panel never skipped the count-up
    if (!ctx.state.is('playing')) return;
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
    if (e.isTrusted) this.lastInputMs = nowMs();   // r7 final fix: a held steering drag is input too (lessons, inputIdleS)
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
    if (e.isTrusted) { this._userInput = true; this.lastInputMs = nowMs(); }   // r7 blur pause / r7 final fix: the player is here
    if (inGame && (command ? !onTextEntry : !onControl) && PREVENT_KEY_CODES.indexOf(code) !== -1) {
      try { e.preventDefault(); } catch (_) { /* ignore */ }
    }
    switch (code) {
      // r7 (controls:0): a non-repeat press records the direction (last pressed wins a roll-over) and latches a tap bit,
      // so every press steers for at least one 1/60 s simulation step (beginFrame reads the latch, frame() step B clears it
      // once a step ran — r7 fix round 2: it lasted one rendered frame, and a frame that ran no step lost the tap)
      case 'KeyA': case 'ArrowLeft':
        if (!onControl) {
          ctx.input.keyLeft = true;
          if (!e.repeat) { this._kbLastDir = -1; this._kbTap |= 1; }
        }
        break;
      case 'KeyD': case 'ArrowRight':
        if (!onControl) {
          ctx.input.keyRight = true;
          if (!e.repeat) { this._kbLastDir = 1; this._kbTap |= 2; }
        }
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
        // r7 final fix: any pressed button (A fires a stored weapon, ui) counts for the last-input time as the stick does
        let anyDown = startDown;
        if (buttons) for (let b = 0; b < buttons.length && !anyDown; b++) if (buttons[b] && buttons[b].pressed) anyDown = true;
        if (x !== 0 || anyDown) this.lastInputMs = nowMs();
        if (x !== 0 || startDown) this._userInput = true;   // r7 blur pause: the player is here
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
    this._kbRelease();
    this._releasePointer();
  }

  /**
   * r7 fix (controls:0): ends keyboard steering with the release rule — a key that was steering leaves the target AT the
   * squad, so nothing slides afterwards. Pause, blur, a hidden tab and the boss intro's lockInput used to zero the direction
   * with the target still KB_LEAD (0.86 m) ahead: the squad slid ≈ 0.9 m by itself after the resume.
   */
  _kbRelease() {
    if (this._kbDir !== 0) {
      const w = this._ctx.world;
      if (w) this._ctx.input.targetX = w.squadX;
    }
    this._kbDir = 0;
    this._kbTap = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Window / document lifecycle
  // -------------------------------------------------------------------------------------------

  /**
   * Window blur: clears held input and — round 7 — pauses a run in progress: the tester's L1 finished (and its
   * once-ever boss lessons were spent) while they were in another window; only visibilitychange → hidden used to pause.
   * Pauses only while playing with the loop running, when the page had focus and the player gave a trusted input
   * since the last title screen (a ?level= boot or a harness that never touched the page is never paused this way).
   */
  _blur() {
    this._focusLost('blur');
  }

  _focus() {
    this._hasFocus = true;
    this._diag('focus (state ' + this._ctx.state.current + ')');
  }

  /** The page lost the focus (window blur, or the 1 s poll below): clear held input; pause a run (see _blur). */
  _focusLost(how) {
    this._clearTransientInput();
    const st = this._ctx.state;
    const pausing = this._running && this._hasFocus && this._userInput && !!st && st.is('playing');
    this._diag(how + ' (state ' + (st ? st.current : '?') + (pausing ? ', pausing' : '') + ')');
    this._hasFocus = false;
    if (pausing) this.pause();
  }

  /**
   * r7: document.hasFocus() once a second (the watch interval) — a focus change whose window blur / focus event never
   * arrived (measured: a Chrome popup taking the focus in a puppeteer-driven browser fired no blur on the page) is caught
   * within a second. Only a true → false change the poll itself observed counts, so a browser whose hasFocus() never
   * reports true (some embedded web views) is never paused by it; event-driven focus changes keep this a no-op.
   */
  _pollFocus() {
    if (typeof document === 'undefined' || document === null || typeof document.hasFocus !== 'function') return;
    let f = false;
    try { f = document.hasFocus() === true; } catch (_) { return; }
    const was = this._polledFocus;
    this._polledFocus = f;
    if (was && !f && this._hasFocus) this._focusLost('focus lost (poll)');
    else if (!was && f && !this._hasFocus) { this._hasFocus = true; this._diag('focus (poll, state ' + this._ctx.state.current + ')'); }
  }

  _visibilityChange() {
    let hidden = false;
    try { hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'; } catch (_) { hidden = false; }
    this._visible = !hidden;
    this._diag(hidden ? 'hidden (state ' + this._ctx.state.current + ')' : 'visible (state ' + this._ctx.state.current + ')');
    if (hidden) {
      this._clearTransientInput();
      if (this._ctx.state.is('playing')) this.pause();
      this._clearGiveUp();         // r7: the give-up counts visible time only (a backgrounded phone may restore later)
    } else {
      this._visibleSince = nowMs();
      this._resetScalerWindow();   // the first visible frame carries a huge interval; start clean
      this.requestRedraw();
      this.measureRefresh();       // the panel may have changed while hidden (external display, power mode)
      if (this._contextLost) this._armGiveUp();
    }
  }

  /** r7 (perf-render:6): (re)arms a change listener on matchMedia('(resolution: <current dpr>dppx)'). */
  _watchDpr() {
    this._unwatchDpr();
    try {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
      const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      const mq = window.matchMedia('(resolution: ' + dpr + 'dppx)');
      if (!mq) return;
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', this._onDprChange);
      else if (typeof mq.addListener === 'function') mq.addListener(this._onDprChange);
      else return;
      this._dprQuery = mq;
    } catch (_) { this._dprQuery = null; }
  }

  _unwatchDpr() {
    const mq = this._dprQuery;
    this._dprQuery = null;
    if (!mq) return;
    try {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', this._onDprChange);
      else if (typeof mq.removeListener === 'function') mq.removeListener(this._onDprChange);
    } catch (_) { /* ignore */ }
  }

  /** The device pixel ratio changed (window moved to another monitor, page zoom): re-arm for the new value and resize. */
  _dprChange() {
    this._watchDpr();
    this._scheduleResize();
  }

  // -------------------------------------------------------------------------------------------
  // Back guard (round 6, ARCH §6.2): the Android back gesture / button never closes the app mid-run
  // -------------------------------------------------------------------------------------------

  /**
   * Boot step 13 (main): arms the back guard. In a standalone PWA with no history entry of its own, Back (an edge
   * swipe with gesture navigation) closes the app, and a page cannot block the gesture — so while the player is
   * anywhere but the title, engine keeps exactly one history entry (state BACK_GUARD_STATE) above the page's own,
   * and Back pops it: popstate → pause / the screen's own back (`_backAction`) → the guard is re-armed by stepping
   * forward onto that same entry (`_rearmGuard`, history.forward(): no new entry). On the title the guard is dropped, so
   * one Back leaves the app as before. The entry is pushed on the first screen change away from the title, which
   * normally follows a tap (Chrome's history-manipulation intervention skips entries a page added without a user
   * activation — which is also why the re-arm steps forward instead of pushing). Not armed in the artifact shells or any framed page (pushState there writes the
   * host tab's joint session history, and a history.back() could navigate the host), nor when history is unusable.
   */
  armBackGuard() {
    if (this._guardOk) return;
    const ctx = this._ctx;
    if (ctx.config && ctx.config.isArtifact) return;
    try {
      if (typeof window === 'undefined' || window === null || typeof history === 'undefined' || history === null) return;
      if (typeof history.pushState !== 'function' || typeof history.back !== 'function') return;
      if (window.top !== window.self) return;
      this._guardOn = isBackGuardState(history.state);   // a reload on the guard entry keeps it (no second push)
      window.addEventListener('popstate', this._onPopState);
    } catch (_) {
      return;   // SecurityError (opaque origin) or no history: Back keeps the browser's default
    }
    this._guardOk = true;
    const st = ctx.state;
    if (st) this._screen = st.is('playing') ? null : (st.is('paused') ? 'pause' : st.current);
    if (ctx.events) this._unsubs.push(ctx.events.on('ui:screen', this._onUiScreen));
    this._syncGuard();
  }

  /** True while the current screen needs the guard: anything but the title (settings or the FIELD GUIDE over the title included). */
  _wantsGuard() {
    if (this._screen === 'settings' || this._screen === 'guide') return true;   // r7 INT: the guide is an overlay like settings
    const st = this._ctx.state;
    return !!st && !st.is('title') && !st.is('boot');
  }

  _syncGuard() {
    if (!this._guardOk || this._guardDropping || this._guardForwarding) return;   // a pending drop / re-arm re-syncs from its popstate
    const want = this._wantsGuard();
    if (want && !this._guardOn) this._pushGuard();
    else if (!want && this._guardOn) this._dropGuard();
  }

  _pushGuard() {
    try {
      history.pushState(BACK_GUARD_STATE, '');
      this._guardOn = true;
    } catch (err) {
      // pushState rate limit or a blocked history: this Back keeps the browser's default
      warnOnce('engine.backGuard', 'back guard: pushState failed: ' + ((err && err.message) ? err.message : String(err)));
    }
  }

  /** Arriving at the title: leaves the guard entry (history.back(); its popstate is consumed by `_popState`). */
  _dropGuard() {
    this._guardOn = false;
    try {
      if (!isBackGuardState(history.state)) return;   // not on the guard any more (navigated elsewhere in the history)
      this._guardDropping = true;
      history.back();
    } catch (_) {
      this._guardDropping = false;
      return;
    }
    if (this._guardTimer) clearTimeout(this._guardTimer);
    this._guardTimer = setTimeout(this._onGuardResync, BACK_GUARD_RESYNC_MS);
  }

  /** The drop's popstate never came (history.back() was a no-op): trust history.state. */
  _guardResync() {
    this._guardTimer = 0;
    if (!this._guardDropping) return;
    this._guardDropping = false;
    try { this._guardOn = isBackGuardState(history.state); } catch (_) { this._guardOn = false; }
    this._syncGuard();
  }

  /**
   * r6 verify: re-arms the guard after a Back popped it by stepping forward onto that same entry (history.forward(): a
   * traversal, so no entry is added and Chrome's history-manipulation intervention has nothing to mark skippable; a
   * pushState here would have no fresh user activation, and the next Back would skip the page's entry and close the
   * app). Its popstate is consumed by `_popState`; without one (no forward entry) `_guardForwardTimeout` pushes.
   */
  _rearmGuard() {
    try {
      history.forward();
    } catch (_) {
      this._guardForwarding = false;
      this._syncGuard();
      return;
    }
    if (this._guardFwdTimer) clearTimeout(this._guardFwdTimer);
    this._guardFwdTimer = setTimeout(this._onGuardForwardTimeout, BACK_GUARD_FORWARD_MS);
  }

  /** The re-arm's popstate never came (no forward entry, or the traversal was dropped): trust history.state, then push. */
  _guardForwardTimeout() {
    this._guardFwdTimer = 0;
    if (!this._guardForwarding) return;
    this._guardForwarding = false;
    try { this._guardOn = isBackGuardState(history.state); } catch (_) { this._guardOn = false; }
    this._syncGuard();
  }

  _uiScreen(p) {
    this._screen = p ? p.id : null;
    this._syncGuard();
  }

  _popState(e) {
    let onGuard = false;
    try { onGuard = isBackGuardState(e && e.state !== undefined ? e.state : history.state); } catch (_) { onGuard = false; }
    if (this._guardDropping) {
      // our own history.back() on arriving at the title
      this._guardDropping = false;
      if (this._guardTimer) { clearTimeout(this._guardTimer); this._guardTimer = 0; }
      this._guardOn = onGuard;
      this._syncGuard();   // the player may have left the title again meanwhile
      return;
    }
    if (this._guardForwarding) {
      // our own history.forward() re-arming the guard after a Back
      this._guardForwarding = false;
      if (this._guardFwdTimer) { clearTimeout(this._guardFwdTimer); this._guardFwdTimer = 0; }
      this._guardOn = onGuard;
      this._syncGuard();   // pushes if the forward did not land on the guard; drops it if the title came meanwhile
      return;
    }
    if (onGuard) {        // Forward onto the guard entry
      this._guardOn = true;
      this._syncGuard();
      return;
    }
    // Back popped the guard: the page is on its own entry now. The screen's Back runs with the nested ui:screen syncs
    // held (_guardForwarding), then the guard is re-armed by stepping forward onto the entry this Back left — unless
    // this Back landed on the title (one more Back leaves the app there)
    this._guardOn = false;
    this._guardForwarding = true;
    try { this._backAction(); } catch (err) { warnOnce('engine.backAction', 'back guard: back action failed: ' + ((err && err.message) ? err.message : String(err))); }
    if (this._wantsGuard()) this._rearmGuard();
    else { this._guardForwarding = false; this._syncGuard(); }
  }

  /**
   * What Back does on the current screen: settings overlay → its BACK; FIELD GUIDE overlay (round 7, over the title or the
   * pause panel) → its BACK; playing → pause(); paused → stays paused;
   * levels / shop → their BACK; results → their HOME icon; title → nothing (the guard is gone: the next Back leaves).
   * Buttons are clicked rather than re-implemented, so ui runs its own flow (ui:button tap cue, _back, quitToTitle).
   */
  _backAction() {
    const ctx = this._ctx;
    const st = ctx.state;
    if (!st) return;
    if (this._screen === 'settings' && this._clickIn('scr-settings', '[data-back]')) return;
    if (this._screen === 'guide' && this._clickIn('scr-guide', '[data-back]')) return;   // r7 INT (D3 teaching:5)
    if (st.is('playing')) { this.pause(); return; }
    if (st.is('paused')) return;
    if (st.is('levels')) { this._clickIn('scr-levels', '[data-back]'); return; }
    if (st.is('shop')) { this._clickIn('scr-shop', '[data-back]'); return; }
    if (st.is('complete') || st.is('gameover')) {
      let id = BACK_HOME_BTN[this._screen];
      if (id === undefined) id = st.is('gameover') ? BACK_HOME_BTN.gameover : BACK_HOME_BTN.complete;
      if (!this._clickId(id) && ctx.level && typeof ctx.level.quitToTitle === 'function') ctx.level.quitToTitle();
    }
  }

  /** Clicks the first `selector` inside #`screenId` (guarded); false when it is missing. */
  _clickIn(screenId, selector) {
    try {
      const scr = document.getElementById(screenId);
      const btn = scr ? scr.querySelector(selector) : null;
      if (!btn || typeof btn.click !== 'function') return false;
      btn.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  _clickId(id) {
    try {
      const btn = document.getElementById(id);
      if (!btn || typeof btn.click !== 'function') return false;
      btn.click();
      return true;
    } catch (_) {
      return false;
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

  /**
   * render.resize() + the `resize` event (§6.2 "Other listeners", §5.1 emitter = engine). Round 7 (perf-render:6):
   * render.resize() re-allocates the canvas only when the size or DPR really changed (render._sizeDirty), and then the
   * scene is drawn again in this same task (ResizeObserver callback / timer), before the browser composites: a resized
   * WebGL canvas that has not been drawn since has no frame to present, and the compositor showed the bare #app
   * background behind the HUD for a frame — 250 ms and more at 4 fps (the tester's "zoom blanks the canvas for ~2 s").
   */
  _doResize() {
    const ctx = this._ctx;
    const render = ctx.render;
    let drewNow = false;
    let blank = true;   // the drawing buffer may differ from the last drawn frame (unknown for a render without _sizeDirty)
    if (render && typeof render.resize === 'function') {
      try { render.resize(); } catch (err) { this._reportError('render.resize', err); }
      if (typeof render._sizeDirty === 'boolean') blank = render._sizeDirty;
      if (blank && this._running && !this._contextLost && !this._gfxWarming && typeof render.draw === 'function') {
        try {
          render.draw();
          this._draws++;
          drewNow = true;
          if (this._hideOverlayAfterDraw) this._hideRestoreOverlay();
        } catch (err) { this._reportError('render.draw', err); }
      }
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
    // a synchronous draw above already shows the new size, and a same-size resize changed nothing: no second paused / menu draw
    if (blank && !drewNow) this.requestRedraw();
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
    this._diag('context lost (state ' + ctx.state.current + ')');
    if (ctx.ui && typeof ctx.ui.showOverlay === 'function') {
      try { ctx.ui.showOverlay(STRINGS.reloadingGfx); } catch (_) { /* ignore */ }
    }
    if (ctx.state.is('playing')) this.pause();
    this._armGiveUp();   // r7 (flow-coins:4): the overlay is never a dead end
  }

  /** r7 (flow-coins:4): (re)starts the give-up timer while the context is lost and the page is visible. */
  _armGiveUp() {
    this._clearGiveUp();
    if (!this._contextLost || !this._visible || typeof setTimeout !== 'function') return;
    try { this._giveUpTimer = setTimeout(this._onGiveUp, RESTORE_GIVEUP_MS); } catch (_) { this._giveUpTimer = 0; }
  }

  _clearGiveUp() {
    if (this._giveUpTimer) {
      try { clearTimeout(this._giveUpTimer); } catch (_) { /* ignore */ }
      this._giveUpTimer = 0;
    }
  }

  /**
   * No webglcontextrestored after QUALITY_TIERS.restoreGiveUpMs of visible time (Chrome gave up on the GPU process, or
   * blocked WebGL for the page): the fatal box (z 60, above the z 40 'Reloading graphics…' overlay) with RELOAD. The save
   * is committed before the results appear, so a reload loses at most an unfinished run.
   */
  _giveUp() {
    this._giveUpTimer = 0;
    if (!this._contextLost) return;
    this._diag('context not restored after ' + RESTORE_GIVEUP_MS + ' ms: showing RELOAD');
    const ui = this._ctx.ui;
    if (ui && typeof ui.showError === 'function') {
      try { ui.showError(STRINGS.errors.gpuGone, true); } catch (_) { /* ignore */ }
    }
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
    this._clearGiveUp();
    this._diag('context restored (state ' + ctx.state.current + ')');
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
        this._diag('frame error, loop stopped: ' + msg);
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
      // r7 fix round 2 (controls:0): a key tap counts for at least one simulation step (≥ maxSpeed · STEP = 0.2 m): its latch
      // holds the direction through frames that run no step and is cleared once one has (beginFrame reads it)
      if (n > 0) this._kbTap = 0;
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

    const paused = state.is('paused');
    // r7 (flow-coins:1): results / shop / levels on a slow device ("lite", decided once when the menu run opens: software GL
    // or a sustained frame time above QUALITY_TIERS.menuLiteFrameMs) stop drawing the 3D scene menuSettleMs after they open
    // and draw only on render.dirty; fast devices keep the live background, and the title always draws. r7 fix: decided
    // after step B, so the frame whose step opened the results is already a menu frame; the settle runs on the rAF clock
    // (real ms: the theatre clock's clamped steps stretched it to 3.3 s of 0.55 s frames at High on software GL), and a
    // device slower than menuSettleMaxFrameMs per frame skips it (each such frame held the results' count and its clicks)
    const menu = !paused && MENU_STATES[state.current] === true;
    if (!menu) {
      this._menuSince = -1;
      this._menuLite = false;
      this._menuDrawDue = false;
    } else if (this._menuSince < 0) {
      this._menuSince = now;
      const q = ctx.quality;
      this._menuLite = !!(q && q.software) || this._ivEma > MENU_LITE_MS;
      this._menuSettle = this._ivEma > MENU_SETTLE_MAX_FRAME_MS ? 0 : MENU_SETTLE_MS;
      if (this._menuLite) this._diag('lite menu (' + state.current + ', sustained ' + this._ivEma.toFixed(1) + ' ms' + (q && q.software ? ', software' : '') + (this._menuSettle > 0 ? '' : ', no settle') + ')');
    }
    const live = !paused && (!this._menuLite || now - this._menuSince < this._menuSettle);

    // C — fx (paused: dt 0 so flashes / coin flights keep animating on the unscaled clock)
    const fx = ctx.fx;
    if (fx) fx.update(paused ? 0 : time.dt, time.unscaledDt);

    if (live || this._menuDrawDue) {
      // D — instance matrix writes only (a frozen lite menu runs D and E only for its on-demand draw)
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

    // H — draw (paused: ≤ 30 fps on High, otherwise only on render.dirty; r7: frozen lite menus only on render.dirty)
    const render = ctx.render;
    let drew = false;
    if (render && !this._contextLost && !this._gfxWarming) {
      if (live) {
        render.draw();
        drew = true;
      } else if (paused) {
        // r7 (perf-render:9): the ≤ 30 fps paused redraw runs only on High (params.blur) on a device that held ≥ 15 fps
        // while playing, never on software GL
        const q = ctx.quality;
        const highTier = !!(q && q.params && q.params.blur) && !(q && q.software) && this._pauseEma <= PAUSE_REDRAW_MAX_MS;
        if ((highTier && now - this._lastPausedDraw >= PAUSE_FRAME_MS) || render.dirty) {
          render.draw();                                // draw() clears render.dirty
          drew = true;
          this._lastPausedDraw = now;
        }
      } else if (render.dirty) {
        // frozen lite menu: draw on demand ONE frame after the request, so the DOM screen change paints before a slow
        // WebGL frame (render.dirty: ui.showScreen, resize, context restore, texture repaint, quality change)
        if (this._menuDrawDue) {
          render.draw();
          drew = true;
          this._menuDrawDue = false;
        } else {
          this._menuDrawDue = true;
        }
      }
      if (drew) {
        this._draws++;
        if (this._hideOverlayAfterDraw) this._hideRestoreOverlay();
      }
    }
    this._drewFrame = drew;   // r7: only the intervals of drawing frames feed the sustained frame time

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
    // r7 (perf-render:0): the clamp follows the sustained frame interval of the frames BEFORE this one, so one 400 ms
    // hitch on a 60 fps device is still clamped to dtClamp (50 ms) while a 5–20 fps device keeps real time
    const ema = this._ivEma;
    let clampS = ema * DT_FOLLOW * 0.001;
    if (clampS < DT_CLAMP) clampS = DT_CLAMP; else if (clampS > DT_CLAMP_MAX) clampS = DT_CLAMP_MAX;
    const unscaled = rawInterval > 0 ? Math.min(clampS, rawInterval / 1000) : 0;
    time.unscaledDt = unscaled;
    // only the interval after a frame that drew the scene feeds the EMA: a paused or frozen-menu frame (no draw) would
    // pull it down and slow the first seconds after a resume; a gap ≥ dtEmaCapMs (tab switch, debugger) never feeds it
    if (this._drewFrame && rawInterval > 0 && rawInterval < DT_EMA_CAP_MS) {
      this._ivEma = ema > 0 ? ema + (rawInterval - ema) * DT_EMA_RATE : rawInterval;
    }
    // r7 diagnostics: a frame gap over DIAG.gapMs while the page stayed visible (rAF starved: a compositor / GPU stall)
    if (rawInterval > DIAG.gapMs && this._visible && this._visibleSince < this._lastNow) {
      this._diag('frame gap ' + Math.round(rawInterval) + ' ms (state ' + ctx.state.current + ')');
    }
    this._diagStall = false;

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
      // r7 (controls:0) keyboard: held keys (or a tap latched since the last simulation step) give the direction, the last
      // pressed key wins while both are held; on a press edge the target leads the squad by KB_LEAD (never pulled backward,
      // e.g. after a drag) so the squad leaves at full speed; on release it stops AT the squad (no drift); while held it
      // moves at keyboardSpeed (= maxSpeed) with no ramp. The gamepad stick adds gamepadX · gamepadSpeed. r7 fix round 2:
      // the tap latch is cleared by frame() step B once a fixed step has run (it was cleared here: a frame that ran no step
      // — above 60 Hz, in slow-mo — released the tap before the squad moved, and 11 of 20 one-frame taps were lost at 144 Hz)
      const L = input.keyLeft || (this._kbTap & 1) !== 0;
      const R = input.keyRight || (this._kbTap & 2) !== 0;
      const dir = L && R ? this._kbLastDir : (R ? 1 : (L ? -1 : 0));
      let tx = input.targetX;
      if (dir !== this._kbDir) {
        const sx = ctx.world ? ctx.world.squadX : tx;
        if (dir > 0) { if (tx < sx + KB_LEAD) tx = sx + KB_LEAD; }
        else if (dir < 0) { if (tx > sx - KB_LEAD) tx = sx - KB_LEAD; }
        else tx = sx;
        this._kbDir = dir;
      }
      if (dir !== 0 || input.gamepadX !== 0) input.hasSteered = true;   // r7: keys and the stick dismiss the steer hint too
      const vel = dir * STEER.keyboardSpeed + input.gamepadX * STEER.gamepadSpeed;
      input.targetX = clamp(tx + input.steerDx * this.getSteerK() + vel * unscaled, -STEER_RANGE, STEER_RANGE);
    } else {
      this._kbRelease();   // r7 fix: any other way out of a held key (a state change, the lock) stops at the squad too
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
    // r7 (perf-render:3a): a hitch is relative to the sustained frame time — max(hitchIgnoreMs, min(hitchMaxMs,
    // hitchFactor × sustained)) — so a 4 fps device is no longer "all hitches" (a 60 fps device keeps the 250 ms filter)
    let hitchMs = SCALER.hitchFactor * this._ivEma;
    if (hitchMs > SCALER.hitchMaxMs) hitchMs = SCALER.hitchMaxMs;
    if (hitchMs < HITCH_IGNORE_MS) hitchMs = HITCH_IGNORE_MS;
    const validInterval = intervalMs > 0 && intervalMs < hitchMs;
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
    // r7 (perf-render:3b): a time-based rolling window — the last windowSec of frames, at least windowMin, at most W
    // (60 frames: the same window as before at 60 fps) — so a 5 fps device decides in ~2 s instead of 12
    let need = Math.ceil(SCALER.windowSec * 1000 * this._winCount / this._sumInt);
    if (need < SCALER.windowMin) need = SCALER.windowMin;
    if (need > W) need = W;
    while (this._winCount > need) {          // evict the oldest samples (window = the winCount slots before winIdx)
      let o = this._winIdx - this._winCount;
      if (o < 0) o += W;
      this._sumInt -= this._winInt[o];
      this._sumJs -= this._winJs[o];
      this._winCount--;
    }
    if (this._winCount < need) return;

    const meanInt = this._sumInt / this._winCount;
    const meanJs = this._sumJs / this._winCount;
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

    // r7 (perf-render:1): on the lowest tier of software GL the render-scale rungs move first; tiers move only at full scale.
    // r7 final fix (lead decision 1): a hardware GPU never enters the rungs — its render scale is always 1, so its tiers drop
    // and recover on 1.2.2's timing (see _sampleRenderScale)
    if (idx === 0 && q.software && this._sampleRenderScale(now, meanInt, rf)) return;
    if (q.renderScale < 1) return;

    const slow = this._slowSince >= 0 && now - this._slowSince >= SCALER.dropAfter * 1000 && idx > 0;
    // r7 (perf-render:3c): an emergency drop (under ≈ 20 fps at a 60 Hz target) waits emergencyHysteresis, not 15 s
    const hyst = slow && meanInt > SCALER.emergencyFactor * rf ? SCALER.emergencyHysteresis : SCALER.hysteresis;
    if (now - this._lastChangeAt < hyst * 1000) return;
    if (slow) {
      if (this._autoDrops[idx] < 255) this._autoDrops[idx]++;
      this._applyTier(TIER_ORDER[idx - 1], 'auto');
    } else if (this._fastSince >= 0 && idx < TIER_ORDER.length - 1
      && now - this._fastSince >= SCALER.raiseAfter * 1000 * Math.pow(SCALER.raiseBackoff, this._autoDrops[idx + 1])) {
      this._applyTier(TIER_ORDER[idx + 1], 'auto');
    }
  }

  /**
   * r7 (perf-render:1): the render-scale rungs below the lowest tier (QUALITY_TIERS.renderScale), on software GL only.
   * Called from the scaler with a full window while the tier is the lowest and ctx.quality.software is true; returns true
   * when it changed the scale. One rung down after RS.dropAfter s of the tier "slow" rule; one rung up after RS.raiseAfter
   * s × raiseBackoff^(drops from that rung this session) while the interval predicted at the next rung (mean × (next /
   * cur)², fill-bound — a CPU rasteriser always is: SwiftShader's draw cost 176 → 113 → 82 → 72 → 55 ms for scale 1 → 0.5)
   * stays ≤ RS.raiseMargin × the drop line, or while the frame target is held (vsync hides the headroom, so it probes up
   * and a slow result drops it back); RS.hysteresis s between rung changes.
   * r7 final fix (lead decision 1): a hardware GPU never comes here. Rounds 0–3 ran the rungs there too, behind a gain
   * check (a drop kept only when the mean frame interval fell by gainMin, else undone, with strikes and retry back-offs):
   * on a CPU-bound hardware GPU fewer pixels gain nothing, yet the check's noise kept drops it should have undone and the
   * scale sank to 0.5 for whole sessions at unchanged fps (perf verifier, 3 of 4 cpusession runs), and after a transient
   * load the climb back (≈ 13 s per rung, four rungs) held the tiers at Low ≈ 50 s longer than 1.2.2. The check and its
   * state are gone; a hardware GPU keeps render scale 1 and the tier ladder alone.
   */
  _sampleRenderScale(now, meanInt, rf) {
    const q = this._ctx.quality;
    const L = RS.ladder;
    const cur = q.renderScale > 0 ? q.renderScale : 1;
    const k = rungIndex(cur);
    if (now - this._rsChangedAt < RS.hysteresis * 1000) return false;
    if (this._slowSince >= 0 && now - this._slowSince >= RS.dropAfter * 1000 && k < L.length - 1) {
      if (this._rsDrops[k] < 255) this._rsDrops[k]++;
      this._setRenderScale(L[k + 1], 'auto', meanInt);
      return true;
    }
    if (k > 0) {
      const nx = L[k - 1];
      const r = nx / cur;
      const fits = meanInt * r * r <= RS.raiseMargin * SCALER.dropFactor * rf || meanInt <= SCALER.raiseFactor * rf;
      if (fits) { if (this._rsFastSince < 0) this._rsFastSince = now; } else this._rsFastSince = -1;
      if (this._rsFastSince >= 0 && now - this._rsFastSince >= RS.raiseAfter * 1000 * Math.pow(SCALER.raiseBackoff, this._rsDrops[k - 1])) {
        this._setRenderScale(nx, 'auto', meanInt);
        return true;
      }
    } else {
      this._rsFastSince = -1;
    }
    return false;
  }

  /** r7: applies a render scale (ctx.quality.renderScale → render.setRenderScale, re-allocated inside the next draw),
   *  restarts the scaler window and emits `quality:scale`. No-op when unchanged. */
  _setRenderScale(s, reason, meanInt) {
    const ctx = this._ctx;
    const q = ctx.quality;
    if (!q || !(s > 0)) return;
    this._rsChangedAt = ctx.time ? ctx.time.now : 0;
    this._rsFastSince = -1;
    this._resetScalerWindow();
    if (q.renderScale === s) return;
    q.renderScale = s;
    const render = ctx.render;
    if (render && typeof render.setRenderScale === 'function') {
      try { render.setRenderScale(s); } catch (err) { this._reportError('render.setRenderScale', err); }
    } else {
      this.requestRedraw();
    }
    this._diag('render scale ' + s + ' (' + reason + (meanInt > 0 ? ', mean ' + meanInt.toFixed(1) + ' ms' : '') + ')');
    _scalePayload.scale = s;
    _scalePayload.reason = reason;
    _scalePayload.meanInt = meanInt > 0 ? meanInt : 0;
    if (ctx.events) ctx.events.emit('quality:scale', _scalePayload);
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
    this._diag('quality ' + q.tier + ' (' + reason + (q.auto ? ', auto' : ', manual') + ')');
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
    // render.draw() samples the main-pass calls after the RenderPass; field names are the integration contract. r7 fix: only
    // from a frame that drew — a frozen lite menu or a paused Med / Low frame keeps the LAST draw's split ("calls 0 (main 16
    // / shadow 8 / post 14)"), so a frame without a draw says so instead
    const stats = this._drewFrame && render && render.callStats ? render.callStats : null;
    const mainCalls = stats ? stats.main : calls;
    const shadowCalls = stats ? stats.shadow : 0;
    const postCalls = stats ? stats.post : 0;

    const redCalls = stats ? mainCalls > BUDGET.mainCalls : calls > BUDGET.mainCalls + BUDGET.shadowCalls + BUDGET.postCalls;
    const redJs = meanJs > BUDGET.jsMs;

    let text = 'fps ' + fps.toFixed(1) + ' | refresh ' + time.refreshMs.toFixed(2) + ' ms (target ' + this.frameTargetMs.toFixed(2) + ') | js ' + meanJs.toFixed(2) + ' ms' + (redJs ? ' !!' : '') + '\n';
    text += 'calls ' + calls + (stats ? ' (main ' + mainCalls + ' / shadow ' + shadowCalls + ' / post ' + postCalls + ')' : (this._drewFrame ? '' : ' (no draw)')) + (redCalls ? ' !!' : '') + ' | tris ' + tris
      + (stats && typeof stats.materials === 'number' ? ' | mats ' + stats.materials : '') + '\n';   // VIS-13: distinct materials drawn (render resamples every 30 draws)
    // r7: ' sw' after a software-GL tier (perf-render:2), the render scale (perf-render:1), the sustained frame time and
    // the dt clamp it gives (perf-render:0), and ' lite' while a menu's scene is frozen (flow-coins:1)
    const susMs = this._ivEma;
    let clampMs = susMs * DT_FOLLOW;
    if (clampMs < DT_CLAMP * 1000) clampMs = DT_CLAMP * 1000; else if (clampMs > DT_CLAMP_MAX * 1000) clampMs = DT_CLAMP_MAX * 1000;
    text += 'tier ' + (q ? q.tier + (q.software ? ' sw' : '') : '?') + (q ? ' (max ' + q.maxAutoTier + (q.auto ? ', auto' : ', manual') + ')' : '')
      + ' | dpr ' + (render && render.size && typeof render.size.dpr === 'number' ? render.size.dpr.toFixed(2) : (q ? String(q.dpr) : '?'))
      + ' | rscale ' + (q && q.renderScale > 0 ? q.renderScale.toFixed(2) : '1.00')
      + ' | scale ' + time.scale.toFixed(2) + ' | state ' + ctx.state.current + (this._menuLite ? ' lite' : '') + ' | frame ' + time.frame + '\n';
    text += 'sustained ' + susMs.toFixed(1) + ' ms | dt clamp ' + clampMs.toFixed(0) + ' ms\n';

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

    // r7: the newest diagnostics entries (the whole log: window.__gateRushDiag() in the console)
    const nd = this._diagN < DIAG.overlayLines ? this._diagN : DIAG.overlayLines;
    for (let j = nd; j >= 1; j--) text += 'diag ' + this._diagLine(j) + '\n';

    try {
      ui.setDebugText(text);
      const panel = ui.debugPanel;
      if (panel && panel.classList) panel.classList.toggle('red', redCalls || redJs);
    } catch (_) { /* overlay is best-effort */ }
  }

  // -------------------------------------------------------------------------------------------
  // Diagnostics (round 7, ARCH §13): a ring buffer of the last QUALITY_TIERS.diag.entries events, written only when
  // something happens (never per frame), dumped by window.__gateRushDiag() — the line testers run when a screen freezes
  // -------------------------------------------------------------------------------------------

  _installDiag() {
    if (typeof window === 'undefined' || window === null) return;
    try {
      window.addEventListener('pointerdown', this._onDiagPointer, true);
      window.addEventListener('error', this._onDiagError, true);
      window.addEventListener('unhandledrejection', this._onDiagRejection);
    } catch (_) { /* diagnostics are best-effort */ }
    try { if (typeof setInterval === 'function') this._diagWatch = setInterval(this._onDiagWatch, DIAG.watchdogMs); } catch (_) { this._diagWatch = 0; }
    const fn = () => this.diagText(true);
    try { window.__gateRushDiag = fn; this._diagFn = fn; } catch (_) { this._diagFn = null; }
    const q = this._ctx.quality;
    this._diag('engine init (tier ' + (q ? q.tier + (q.software ? ' sw' : '') + (q.auto ? ' auto' : ' manual') : '?')
      + ', focus ' + (this._hasFocus ? 'yes' : 'no') + ', visible ' + (this._visible ? 'yes' : 'no') + ')');
  }

  /** Appends one entry (the text is built by the caller, on an event). */
  _diag(text) {
    const i = this._diagHead;
    this._diagT[i] = nowMs();
    this._diagTxt[i] = text;
    this._diagHead = i + 1 === DIAG.entries ? 0 : i + 1;
    if (this._diagN < DIAG.entries) this._diagN++;
  }

  /** The entry `back` steps from the newest (1 = newest), as 'seconds-since-page-load  text'. */
  _diagLine(back) {
    let i = this._diagHead - back;
    if (i < 0) i += DIAG.entries;
    return (this._diagT[i] / 1000).toFixed(2).padStart(8) + ' s  ' + this._diagTxt[i];
  }

  /** window pointerdown (capture): what the press hit and in which state — a click on a stale or covered screen shows here. */
  _diagPointer(e) {
    if (!e) return;
    if (e.isTrusted) { this._userInput = true; this.lastInputMs = nowMs(); }   // r7 blur pause / r7 final fix: the player is here
    const st = this._ctx.state;
    this._diag('down ' + nodeTag(e.target) + ' ' + (e.pointerType || '') + ' (state ' + (st ? st.current : '?') + ')');
  }

  /** state:change → an entry now, and the visible screens DIAG.screenDelayMs later (a state whose screen never shows). */
  _diagState(p) {
    if (!p) return;
    this._diag('state ' + p.from + ' → ' + p.to);
    if (p.to === 'title') this._userInput = false;   // blur pause: input counts since the last title screen
    if (typeof setTimeout !== 'function') return;
    if (this._diagScreenTimer) { try { clearTimeout(this._diagScreenTimer); } catch (_) { /* ignore */ } }
    try { this._diagScreenTimer = setTimeout(this._onDiagScreen, DIAG.screenDelayMs); } catch (_) { this._diagScreenTimer = 0; }
  }

  /** 1 s watchdog: no rAF frame for over DIAG.stallMs while the page is visible (logged once per silence). */
  _diagWatchdog() {
    if (this._diagStall || !this._visible || this._beginMs <= 0) return;
    const gap = nowMs() - this._beginMs;
    if (gap <= DIAG.stallMs) return;
    this._diagStall = true;
    this._diag('no frame for ' + Math.round(gap) + ' ms while visible (state ' + this._ctx.state.current + ', loop '
      + (this._running ? 'running' : 'stopped') + ', screens ' + this._visibleScreens() + ')');
  }

  /** Ids of the visible #ui screens (the HUD included), comma-separated. */
  _visibleScreens() {
    try {
      if (typeof document === 'undefined') return '?';
      const list = document.querySelectorAll('#ui .screen:not([hidden])');
      let s = '';
      for (let i = 0; i < list.length; i++) s += (i ? ',' : '') + (list[i].id || '?');
      return s || 'none';
    } catch (_) { return '?'; }
  }

  /**
   * The diagnostics report: a header (version, state, visible screens, focus / visibility, quality, render scale, canvas,
   * sustained frame time, GPU string, loop / context state) and the ring buffer oldest first. window.__gateRushDiag()
   * calls this with log = true, which also prints it to the console (the one sanctioned direct console call in js/: a
   * dump the user asked for, ARCH §14 rule 5).
   * @param {boolean} [log]
   * @returns {string}
   */
  diagText(log) {
    const ctx = this._ctx;
    const q = ctx.quality;
    const r = ctx.render;
    let canvas = '?';
    try { const c = ctx.canvas; if (c) canvas = c.width + 'x' + c.height + ' (css ' + c.clientWidth + 'x' + c.clientHeight + ')'; } catch (_) { /* ignore */ }
    let focus = '?';
    try { focus = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? (document.hasFocus() ? 'yes' : 'no') : '?'; } catch (_) { /* ignore */ }
    const lines = [];
    lines.push('Gate Rush diagnostics — v' + ctx.version + ' · page time ' + (nowMs() / 1000).toFixed(2) + ' s');
    lines.push('state ' + ctx.state.current + ' · screens ' + this._visibleScreens() + ' · visible ' + (this._visible ? 'yes' : 'no') + ' · focus ' + focus
      + ' · loop ' + (this._running ? 'running' : 'stopped') + (this._frameFailed ? ' (frame error)' : '')
      + ' · context ' + (this._contextLost ? 'LOST' : (this._gfxWarming ? 'warming' : 'ok')) + ' · frames ' + (ctx.time ? ctx.time.frame : 0) + ' · draws ' + this._draws);
    lines.push('quality ' + (q ? q.tier + (q.software ? ' (software GL)' : '') + ' · ' + (q.auto ? 'auto' : 'manual') + ' · max ' + q.maxAutoTier + ' · detected ' + q.initialTier
      + ' · render scale ' + q.renderScale + ' · dpr ' + (r && r.size ? r.size.dpr.toFixed(3) : String(q.dpr)) : '?')
      + ' · canvas ' + canvas + ' · sustained frame ' + this._ivEma.toFixed(1) + ' ms' + (this._menuLite ? ' · lite menu' : ''));
    lines.push('gpu ' + (r && r.gpu ? r.gpu : 'unknown'));
    lines.push('--- last ' + this._diagN + ' events (seconds since page load) ---');
    for (let j = this._diagN; j >= 1; j--) lines.push(this._diagLine(j));
    const text = lines.join('\n');
    if (log && typeof console !== 'undefined' && typeof console.info === 'function') console.info(text);
    return text;
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
    this._pauseEma = this._ivEma;   // r7 (perf-render:9): the paused redraw gate follows the frame time the run held
    this._diag('pause');
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
    this._diag('resume');
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
   * r7 final fix (lead decision 5): real seconds since the last trusted player input (lastInputMs: a pointer press or a
   * steering drag's move, a key, a gamepad stick or button); Infinity before the first. ui marks a once-ever lesson done
   * only while this is ≤ JUICE.ui.hintIdleS, and level the lesson a NEW card stood in for: a lesson an idle screen showed
   * comes back next time. Pure read, no allocation.
   */
  inputIdleS() {
    return (nowMs() - this.lastInputMs) / 1000;
  }

  /**
   * Manual tier ('low' | 'med' | 'high') disables auto, renders at render scale 1 and emits quality:change
   * {reason:'manual'}. 'auto' re-enables the scaler and — round 7 (perf-render:3e) — returns to the detected tier
   * (q.initialTier) when the current tier is above it (a manual High on a weak box used to stay High for good) and
   * restarts the render scale (RS.softwareStart on software GL, else 1); going up stays the scaler's job.
   */
  setQuality(tier) {
    const q = this._ctx.quality;
    if (!q) return;
    if (tier === 'auto') {
      if (q.auto) return;        // already Auto (a re-tap, or the reset-save broadcast): the scaler keeps its state
      q.auto = true;
      this._autoDrops.fill(0);   // a fresh opt-in to auto starts without raise back-off
      this._rsDrops.fill(0);
      this._diag('quality auto (from ' + q.tier + ', detected ' + q.initialTier + ')');
      if (tierIndex(q.tier) > tierIndex(q.initialTier)) this._applyTier(q.initialTier, 'auto');
      this._setRenderScale(q.software ? RS.softwareStart : 1, 'auto', 0);
      this._resetScalerWindow();
      return;
    }
    if (TIER_ORDER.indexOf(tier) === -1) {
      warnOnce('engine.badTier.' + tier, 'setQuality: unknown tier "' + tier + '"');
      return;
    }
    q.auto = false;
    this._setRenderScale(1, 'manual', 0);   // the rungs belong to Auto
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
    if (locked) this._kbRelease();   // r7 fix: a key held into the boss intro stops at the squad (no slide under the lock)
  }

  /** targetX = 0, steerDx = 0 (LevelRunner.start); hasSteered is left untouched. */
  resetSteering() {
    const input = this._ctx.input;
    input.targetX = 0;
    input.steerDx = 0;
    this._kbDir = 0;
    this._kbTap = 0;
  }

  /**
   * r7 (perf-render:0): the sustained frame time (ms) — the EMA of the rAF intervals of frames that drew the scene
   * (0 before the first). The dt clamp, the scaler's hitch filter, the paused redraw gate and the lite-menu decision
   * follow it; ui may read it (guarded).
   */
  get sustainedFrameMs() { return this._ivEma; }

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
