// js/main.js — Gate Rush boot (ARCHITECTURE §4.1, §13, §15).
//
// Step 0 installs window.onerror / unhandledrejection → showFatal (replacing the shells' inline
// BOOTGUARD handler) before anything else runs; boot() then builds `ctx` and attaches every
// system in the §4.1 order, exposes window.__game, hides the boot screen and starts the loop.
//
// Browser globals are touched only inside functions (never at module scope), so the file passes
// tools/check-imports.js's import-time heuristic and can at least be syntax-checked in node.
import { Rng, warnOnce, storage } from './util.js';
import { STRINGS, WORLD } from './data.js';
import { EventBus, Engine } from './engine.js';
import { SaveStore } from './save.js';
import { UI } from './ui.js';
import { RenderSystem } from './render.js';
import { ModelLibrary } from './models.js';
import { AudioSystem } from './audio.js';
import { Fx } from './fx.js';
import { Squad } from './squad.js';
import { Zombies } from './zombies.js';
import { BossSystem } from './boss.js';
import { Gates } from './gates.js';
import { Pickups } from './pickups.js';
import { Weapons } from './weapons.js';
import { Troops } from './troops.js';
import { LevelRunner } from './level.js';

const VERSION = '1.2.1';            // ARCHITECTURE §3 ctx.version (= package.json version; round-5d release 1.2.1, sw.js v6)
const RNG_BOOT_SEED = 1;            // §4.1 step 1: boot RNG for the title idle scene
const RNG_FX_FORK = 7;              // §3: ctx.rngFx = ctx.rng.fork(7) — cosmetics never perturb gameplay
const MAX_LEVEL_PARAM = 999;        // ?level= sanity cap (the campaign loops beyond LEVELS.count, §6.16)

// Boot-bar progress ranges (fractions of the whole boot, §4.1 "steps 5–11 call ui.setBootProgress").
// CORE-9 / round-3 boot polish: weighted by each step's measured share of the boot (first bar → title) at 4× CPU
// throttling, 390 × 844 @ 2.75 (docs/build/r3-boot-polish.md): render.init (textures, materials, environment) ≈ 17 %,
// models ≈ 3.5 %, audio ≈ 3.5 %, engine < 1 %, the gameplay systems ≈ 12 %, the chunked shader warm-up (render.warmup,
// VIS-2 / VIS-17) ≈ 29 %, the frame-by-frame UI first-raster prewarm (ui.prewarm, UI-19) ≈ 27 %, the first scene ≈ 4 %.
// render.init / render.warmup / ui.prewarm report 0..1 from inside their step, so the bar moves with the work.
const PROGRESS = Object.freeze({
  uiReady: 0.04, renderFrom: 0.05, renderTo: 0.22, models: 0.255, audio: 0.29, engine: 0.30, systemsTo: 0.42,
  warmFrom: 0.42, warmTo: 0.70, prewarmTo: 0.96, done: 1,
});
// STRINGS.boot.steps indices (UI-29: one caption per real boot step, set by main through ui.setBootCaption; `ui` is
// the round-3 caption of the UI prewarm — an older data.js without it keeps showing the shaders caption)
const STEP = Object.freeze({ page: 0, textures: 1, models: 2, audio: 3, systems: 4, shaders: 5, ui: 6 });
const YIELD_FALLBACK_MS = 100;      // yieldFrame() resolves by this time even when rAF is throttled (hidden tab)
const WARMUP_TIMEOUT_MS = 8000;     // boot never waits longer than this on the shader warm-up (the first frame then finishes the job)
const WARMUP_TICK_MS = 100;         // boot-bar creep interval while the warm-up runs
const WARMUP_CREEP = 0.15;          // fraction of the remaining creep range the bar advances per tick (asymptotic)
const WARMUP_CREEP_AHEAD = 0.25;    // with render.warmup(onProgress) reporting, the creep stays within this share of the warm-up range above the last report
// boot never waits longer than this on ui.prewarm() (UI-19); round 3: the prewarm paints one surface per frame now
// (≈ 0.9 s unthrottled at DPR 2.75 — GPU raster bound —, ≈ 1.1 s at 4×), and ui holds the boot screen until it ends
// even past this cap (hideBoot)
const PREWARM_TIMEOUT_MS = 5000;
// step 9: before the next system's init, yield a frame once this slice has run this long since the last paint (CORE-9:
// no frozen bar; round 3: one 60 Hz frame instead of 40 ms, so the boss rigs never share a frozen task with the systems
// before them)
const SYSTEMS_SLICE_MS = 16;
// a system whose measured init (SYSTEMS, ms at 4×) is at least this long always starts a frame of its own
const SYSTEMS_ALONE_MS = 100;
// step 9 systems in the §4.1 contract order (level last: it reads every other system), each with its share of the
// [engine, systemsTo] bar range = its measured init cost at 4× CPU throttling in ms (round-3 boot polish; boss rigs
// dominate), so the bar no longer advances 1/9 per system whatever the work. Round-3 verify: a system may defer init
// work into slices (`initSteps` left, `initStep()` runs one) that main runs one per frame after its init — the boss
// rigs (≈ 45–60 ms each at 4×; 266 = the set) and the level generator's JIT warm-up (≈ 75 ms at 4×; level 1 → 76)
const SYSTEMS = Object.freeze([
  ['fx', Fx, 136], ['squad', Squad, 28], ['zombies', Zombies, 9], ['boss', BossSystem, 266],
  ['gates', Gates, 33], ['pickups', Pickups, 16], ['weapons', Weapons, 8], ['troops', Troops, 13], ['level', LevelRunner, 76],
]);

/** The shared context; module-level so showFatal can reach ctx.ui / ctx.events once they exist. */
let ctx = null;
let fatalShown = false;

// ---------------------------------------------------------------------------------------------
// Step 0 — fatal error surface (§14 rule 5: never a blank page)
// ---------------------------------------------------------------------------------------------

function errorMessage(err) {
  if (err === null || err === undefined) return STRINGS.errors.fatal;
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message.length > 0) return err.message;
  if (err.reason) return errorMessage(err.reason);
  try { return String(err); } catch (_) { return STRINGS.errors.fatal; }
}

/**
 * Shows a fatal error with a RELOAD button. Prefers ctx.ui.showError(msg, true) once ui exists;
 * before that (or if ui itself is broken) it writes straight into #error-box / #error-text.
 */
export function showFatal(err) {
  const msg = errorMessage(err);
  warnOnce('fatal:' + msg, 'fatal: ' + msg + (err && err.stack ? '\n' + err.stack : ''));
  let shown = false;
  if (ctx && ctx.ui && typeof ctx.ui.showError === 'function') {
    try { ctx.ui.showError(msg, true); shown = true; } catch (_) { shown = false; }
  }
  if (!shown) {
    try {
      const box = document.getElementById('error-box');
      const text = document.getElementById('error-text');
      if (text) text.textContent = msg;
      if (box) box.hidden = false;
      const btn = document.getElementById('btn-reload');
      if (btn && !btn.dataset.wired) {
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => { try { location.reload(); } catch (_) { /* sandboxed */ } });
      }
    } catch (_) { /* no DOM at all: nothing more we can do */ }
  }
  if (!fatalShown && ctx && ctx.events) {
    fatalShown = true;
    try { ctx.events.emit('error', { message: msg, fatal: true }); } catch (_) { /* ignore */ }
  }
  fatalShown = true;
}

function installErrorHooks() {
  if (typeof window === 'undefined') return;
  window.onerror = function onError(message, source, lineno, colno, error) {
    showFatal(error || message);
    return false;   // let the browser log it too
  };
  window.onunhandledrejection = function onRejection(e) {
    showFatal(e && e.reason !== undefined ? e.reason : e);
  };
}

// ---------------------------------------------------------------------------------------------
// URL parameters (§13): ?debug=1 ?level=N ?seed=N ?quality=low|med|high ?nomusic=1 ?reset=1 ?endless=1
// ---------------------------------------------------------------------------------------------

/** Parses location.search into ctx.config (isArtifact is filled in after #app resolves). */
export function parseParams(search) {
  const cfg = { debug: false, level: null, seed: null, quality: null, nomusic: false, endless: false, reset: false, isArtifact: false };
  let params = null;
  try { params = new URLSearchParams(search || ''); } catch (_) { return cfg; }
  const flag = (key) => {
    const v = params.get(key);
    return v !== null && v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'no';
  };
  cfg.debug = flag('debug');
  cfg.nomusic = flag('nomusic');
  cfg.endless = flag('endless');
  cfg.reset = flag('reset');
  const level = parseInt(params.get('level') || '', 10);
  cfg.level = Number.isFinite(level) && level >= 1 && level <= MAX_LEVEL_PARAM ? level : null;
  const seed = parseInt(params.get('seed') || '', 10);
  cfg.seed = Number.isFinite(seed) ? (seed >>> 0) : null;
  const q = (params.get('quality') || '').toLowerCase();
  if (q === 'low' || q === 'med' || q === 'high') cfg.quality = q;
  else if (q === 'medium' || q === 'mid') cfg.quality = 'med';
  return cfg;
}

// ---------------------------------------------------------------------------------------------
// Boot (§4.1)
// ---------------------------------------------------------------------------------------------

function progress(t) {
  if (ctx && ctx.ui && typeof ctx.ui.setBootProgress === 'function') {
    try { ctx.ui.setBootProgress(t); } catch (_) { /* boot bar is cosmetic */ }
  }
}

/** UI-29: the caption of the boot step about to run (guarded: older ui builds derive captions from the fraction). */
function caption(step) {
  if (ctx && ctx.ui && typeof ctx.ui.setBootCaption === 'function') {
    try { ctx.ui.setBootCaption(step); } catch (_) { /* boot caption is cosmetic */ }
  }
}

function nowMs() {
  try { if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now(); } catch (_) { /* ignore */ }
  return Date.now();
}

/**
 * CORE-11: `?reset=1` is a one-shot debug action (ARCH §13): once the save is wiped, drop the parameter from the
 * address bar so a reload of the same tab does not wipe the progress again. Guarded: sandboxed / artifact shells
 * (opaque origin, about:srcdoc, blocked history) simply keep the URL.
 */
function dropResetParam() {
  try {
    if (typeof location === 'undefined' || typeof history === 'undefined' || typeof history.replaceState !== 'function') return;
    const url = new URL(location.href);
    if (!url.searchParams.has('reset')) return;
    url.searchParams.delete('reset');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch (_) { /* SecurityError in a sandboxed frame: harmless */ }
}

/** Resolves with `p` or after `ms`, whichever comes first (never rejects; `onTimeout` runs on the timeout path). */
function capped(p, ms, onTimeout) {
  let timer = 0;
  return Promise.race([
    Promise.resolve(p).catch((err) => { warnOnce('boot.capped', 'boot step failed: ' + errorMessage(err)); }),
    new Promise((resolve) => { timer = setTimeout(() => { if (onTimeout) onTimeout(); resolve(); }, ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Resolves after the browser has had a chance to paint (rAF → macrotask), so the boot bar repaints
 * between boot steps. The setTimeout fallback keeps boot moving when rAF is paused (hidden tab).
 */
function yieldFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { setTimeout(finish, 0); });
    } catch (_) { /* no rAF: the timeout below resolves */ }
    setTimeout(finish, YIELD_FALLBACK_MS);
  });
}

/**
 * Boot step 9b (CORE-1, CORE-9): pre-compiles the shader programs so the first frame after hideBoot does not
 * stall on WebGLProgram linking. Uses render.warmup(onProgress) (VIS-2 / VIS-17) when present — its 0..1
 * reports map onto [warmFrom, warmTo] — else three's renderer.compileAsync(scene, camera) followed by a yielded
 * frame and one draw (so the compile's completion and the draw never share one frozen task). Between reports the
 * bar creeps (asymptotically, never more than WARMUP_CREEP_AHEAD of the range above the last report); the wait is
 * capped at WARMUP_TIMEOUT_MS and a failure is only a warning (draw compiles lazily anyway).
 */
async function warmRender(render) {
  const span = PROGRESS.warmTo - PROGRESS.warmFrom;
  let f = PROGRESS.warmFrom;                // last value shown
  let reported = -1;                        // last onProgress value mapped into the range (-1: none yet)
  progress(f);
  if (!render) return;
  const onProgress = (t) => {
    const u = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
    const v = PROGRESS.warmFrom + span * u;
    if (v > reported) reported = v;
    if (v > f) { f = v; progress(f); }
  };
  let p = null;
  try {
    if (typeof render.warmup === 'function') {
      p = render.warmup(onProgress);
    } else if (render.renderer && typeof render.renderer.compileAsync === 'function' && render.scene && render.camera) {
      p = Promise.resolve(render.renderer.compileAsync(render.scene, render.camera)).then(async () => {
        onProgress(0.6);
        await yieldFrame();                 // paint the bar between the compile and the (long) first draw
        if (typeof render.draw === 'function') render.draw();
        onProgress(1);
      });
    }
  } catch (err) {
    warnOnce('boot.warmup', 'render warm-up failed: ' + errorMessage(err));
    p = null;
  }
  if (p && typeof p.then === 'function') {
    let tick = 0;
    try {
      tick = setInterval(() => {
        const ceil = reported < 0 ? PROGRESS.warmTo : Math.min(PROGRESS.warmTo, reported + span * WARMUP_CREEP_AHEAD);
        if (ceil > f) { f += (ceil - f) * WARMUP_CREEP; progress(f); }
      }, WARMUP_TICK_MS);
      await capped(p, WARMUP_TIMEOUT_MS, () => {
        warnOnce('boot.warmupTimeout', 'render warm-up still running after ' + WARMUP_TIMEOUT_MS + ' ms; continuing boot');
      });
    } finally {
      if (tick) clearInterval(tick);
    }
  }
  progress(PROGRESS.warmTo);
}

/**
 * Boot step 9c (CORE-9 ↔ UI-19): ui.prewarm(onProgress) lays out and paints every first-use DOM surface behind the
 * boot screen, one surface per frame (round 3: all of them in one frame was a 0.5–0.6 s frozen bar at 4× CPU
 * throttling, plus a GPU raster burst of the same size); awaited (capped) so its frames happen under the bar, and its
 * 0..1 reports map onto [warmTo, prewarmTo].
 */
async function prewarmUi(ui) {
  if (!ui || typeof ui.prewarm !== 'function') return;
  const span = PROGRESS.prewarmTo - PROGRESS.warmTo;
  const onProgress = (t) => {
    const u = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
    progress(PROGRESS.warmTo + span * u);
  };
  let p = null;
  try { p = ui.prewarm(onProgress); } catch (err) { warnOnce('boot.prewarm', 'ui prewarm failed: ' + errorMessage(err)); p = null; }
  if (p && typeof p.then === 'function') await capped(p, PREWARM_TIMEOUT_MS, null);
  progress(PROGRESS.prewarmTo);
}

/** The world state object (§3 ctx.world): created once here, fields overwritten in place by their owners. */
function newWorld() {
  // Round-2 cross-group (FX-14 item 2, V8 map deprecation): fraction-holding fields are created from a fraction and then
  // set to their start value, so V8 gives them a Double representation from the start; storing the first fraction in
  // play would otherwise deprecate the shared map and deoptimise every module reading ctx.world.
  const w = {
    roadSpeed: 0.5, roadSpeedBase: 0.5, distance: 0.5,
    squadX: 0.5, squadHalfWidth: 0.5, squadDepth: 0.5, squadCount: 0, invulnerable: false,
    bossActive: false, bossZ: 0.5, bossX: 0.5,
  };
  w.roadSpeed = WORLD.idleRoadSpeed; w.roadSpeedBase = WORLD.idleRoadSpeed; w.distance = 0;
  w.squadX = 0; w.squadHalfWidth = 0; w.squadDepth = 0; w.bossZ = 0; w.bossX = 0;
  return w;
}

export async function boot() {
  // 1. ctx skeleton
  const app = document.getElementById('app');
  const canvas = document.getElementById('gl-canvas');
  if (!app || !canvas) throw new Error(STRINGS.errors.loadError + ': #app / #gl-canvas missing');
  // Every ctx member is declared up front (round-2 cross-group, FX-14 item 2): the systems used to be added one by
  // one, the last nine through computed keys (ctx[name] = …), which pushed ctx past V8's fast-property limit for keyed
  // stores and into dictionary mode — every ctx.<system> read in every module was then a hash lookup.
  ctx = {
    version: VERSION,
    config: parseParams(typeof location !== 'undefined' ? location.search : ''),
    app, canvas,
    rng: null, rngFx: null, world: null, run: null, quality: null, events: null, save: null, profile: null,
    ui: null, render: null, models: null, audio: null, engine: null,
    time: null, state: null, input: null, debug: null,
    fx: null, squad: null, zombies: null, boss: null, gates: null, pickups: null, weapons: null, troops: null, level: null,
  };
  ctx.config.isArtifact = app.dataset.shell === 'artifact';   // both shells put data-shell on #app (§3)
  ctx.rng = new Rng(RNG_BOOT_SEED);
  ctx.rngFx = ctx.rng.fork(RNG_FX_FORK);
  ctx.world = newWorld();
  ctx.run = null;
  ctx.quality = null;     // created by render.init (step 5), owned by engine afterwards
  if (typeof window !== 'undefined') window.__game = ctx;   // available for console debugging even if boot fails later

  // 2. events
  ctx.events = new EventBus();
  ctx.events.on('error', (p) => { if (p && p.fatal && !fatalShown) showFatal(p.message); });

  // 3. save → profile
  ctx.save = new SaveStore(ctx);
  ctx.save.load();
  if (ctx.config.reset) {
    ctx.save.reset();
    dropResetParam();   // CORE-11: one-shot — a reload of the same tab keeps the new progress
  }
  ctx.profile = ctx.save.profile();
  if (storage.volatile) warnOnce('save.volatile', STRINGS.volatileSave);

  // 4. ui (caches DOM, shows #scr-boot, applies settings classes, refit)
  ctx.ui = new UI(ctx);
  ctx.ui.init();
  progress(PROGRESS.uiReady);
  caption(STEP.textures);   // UI-29: from here on each caption names the step that is running
  await yieldFrame();   // paint the boot screen before the heavy render.init (CORE-1: the bar repaints between steps)

  // 5. render — reports its own 0..1 progress; map it into [renderFrom, renderTo] so the bar stays monotonic
  ctx.render = new RenderSystem(ctx);
  const ui = ctx.ui;
  const realSetBootProgress = typeof ui.setBootProgress === 'function' ? ui.setBootProgress : null;
  if (realSetBootProgress) {
    ui.setBootProgress = function scaledBootProgress(t) {
      const f = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
      realSetBootProgress.call(ui, PROGRESS.renderFrom + (PROGRESS.renderTo - PROGRESS.renderFrom) * f);
    };
  }
  try {
    await ctx.render.init();      // throws Error(STRINGS.noWebGL2) when WebGL 2 is unavailable → showFatal (RELOAD)
  } finally {
    if (realSetBootProgress) ui.setBootProgress = realSetBootProgress;
  }
  progress(PROGRESS.renderTo);
  caption(STEP.models);
  await yieldFrame();

  // 6. models (asserts the vertex-attribute budget)
  ctx.models = new ModelLibrary(ctx);
  ctx.models.init();
  progress(PROGRESS.models);
  caption(STEP.audio);
  await yieldFrame();   // round 3: models (≈ 145 ms at 4×) and the AudioContext build (≈ 145 ms) no longer share one frozen frame

  // 7. audio (no listeners; the unlock gesture belongs to engine). Since round-2 AUD-8 init() builds the AudioContext
  // and the whole graph here (suspended until the first gesture; unlock() then only resumes): the constructor alone
  // takes 0.1–1 s on some Windows Chrome builds, which is part of the models → audio stretch of the bar.
  ctx.audio = new AudioSystem(ctx);
  ctx.audio.init();
  progress(PROGRESS.audio);
  caption(STEP.systems);
  await yieldFrame();

  // 8. engine (time, state, input, quality adoption, listeners, quality:change init, resize, refresh probe)
  ctx.engine = new Engine(ctx);
  ctx.engine.init();
  progress(PROGRESS.engine);
  await yieldFrame();

  // 9. gameplay systems, in the contract order (level last: it reads every other system). Before each init a frame is
  // yielded once the inits since the last paint exceed SYSTEMS_SLICE_MS, or before a heavy one (SYSTEMS_ALONE_MS), and
  // the bar advances by each system's measured share (SYSTEMS), so it keeps moving on slow devices and is never stale
  let weightSum = 0;
  for (let i = 0; i < SYSTEMS.length; i++) weightSum += SYSTEMS[i][2];
  let weightDone = 0;
  let sliceStart = nowMs();
  for (let i = 0; i < SYSTEMS.length; i++) {
    if (i > 0 && (nowMs() - sliceStart >= SYSTEMS_SLICE_MS || SYSTEMS[i][2] >= SYSTEMS_ALONE_MS)) {
      await yieldFrame();
      sliceStart = nowMs();
    }
    const name = SYSTEMS[i][0];
    const Ctor = SYSTEMS[i][1];
    const sys = new Ctor(ctx).init();
    ctx[name] = sys;
    // round-3 verify: deferred init slices, one per painted frame, each advancing the bar by its share of the weight
    // (bounded by the count read here: a slice that fails to make progress cannot hold the boot — whatever is left
    // is done on first use, e.g. boss.spawn builds rigs still queued)
    const steps = sys && sys.initSteps > 0 ? sys.initSteps : 0;
    for (let k = 0; k < steps && sys.initSteps > 0; k++) {
      await yieldFrame();
      sliceStart = nowMs();
      sys.initStep();
      progress(PROGRESS.engine + (PROGRESS.systemsTo - PROGRESS.engine) * ((weightDone + SYSTEMS[i][2] * (k + 1) / steps) / weightSum));
    }
    weightDone += SYSTEMS[i][2];
    progress(PROGRESS.engine + (PROGRESS.systemsTo - PROGRESS.engine) * (weightDone / weightSum));
  }
  caption(STEP.shaders);
  await yieldFrame();

  // 9b. shader warm-up while the boot screen is still up, so the first frame after hideBoot stays short
  await warmRender(ctx.render);
  caption(STEP.ui);
  await yieldFrame();   // round 3: the warm-up's last draw (a rAF callback) and the prewarm's first surface never share a frame

  // 9c. first raster / layout of every first-use DOM surface, still behind the boot screen (UI-19)
  await prewarmUi(ctx.ui);

  // 10. expose + first scene, still under the boot screen (round 3: the title idle setup / level start runs in a task
  // of its own — ≈ 0.2 s at 4× — instead of after hideBoot in the same frozen frame as the prewarm's end)
  if (typeof window !== 'undefined') window.__game = ctx;
  if (ctx.config.endless) ctx.level.startEndless(ctx.config.seed === null ? undefined : ctx.config.seed);
  else if (ctx.config.level !== null) ctx.level.start(ctx.config.level, ctx.config.seed === null ? undefined : ctx.config.seed);
  else ctx.level.quitToTitle();
  progress(PROGRESS.done);
  await yieldFrame();   // paint the full bar before the first scene frame

  // 11. hide boot (the boot screen leaves in the first loop frame, when ui applies the first state screen)
  ctx.ui.hideBoot();

  // 12. loop
  ctx.engine.start();
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

installErrorHooks();
boot().catch((err) => {
  showFatal(err);
});
