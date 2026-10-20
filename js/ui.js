// js/ui.js — GATE RUSH DOM layer: screens, HUD, hints, shop, level select, results, settings, error box,
// overlay, debug panel DOM, screen transitions and focus management.
//
// Contract: docs/ARCHITECTURE.md §6.14 (class shape), §10 (DOM contract, CSS variables, event → element
// table, button wiring), §6.2 (state → screen mapping), §5 (events: listeners only store values and set
// dirty bits; every DOM write happens in update(), step F), §12 (save/settings shape), §14 (coding rules).
// Numbers come from data.js (JUICE.ui timings, LEVELS, BOSSES, UPGRADES, PALETTE, RENDER …); copy comes
// from STRINGS / HINTS / BOSSES.archetypes names / UPGRADES names.
//
// Lifecycle
//   init()   (boot step 4, before render/engine exist): caches the DOM, builds the static pools (pills,
//            shop cards, progress ticks, settings segments), wires DOM listeners, subscribes to events,
//            shows #scr-boot, applies the settings to <html> classes and writes --ui (refit).
//   update() (every frame, step F, also while paused): pending screen, coin tween, flash / vignette,
//            hint / name card / letterbox / boss bar timers, the 10 Hz HUD block (progress, pills, shield,
//            boss fill), results animations, shop count-down, confirm-reset timeout.
//   dispose() removes every DOM listener, event subscription, timer and running animation.
//
// Methods other modules call (CALLSITES.md + §6.14): setBootProgress, hideBoot, showScreen, refit,
// showError, flash, vignette, showHint, hideHint, coinIconScreenPos, powerupIconScreenPos, debugPanel,
// setDebugText, confirmReset, showOverlay, hideOverlay, update, init, dispose. Extra (documented in the
// report): punchCoinIcon() for fx's J19 icon punch; round 2: setBootCaption(i) (UI-29, boot step captions)
// and prewarm(): Promise (UI-19, lays out + paints every first-use screen behind #scr-boot; main awaits it
// before hideBoot — hideBoot also runs it, holding the boot screen, when main did not).
//
// Layout reads (UI-21): never in the frame that wrote the DOM. Element sizes come from one ResizeObserver
// (hint pill, shield pill, progress bar); the level grid's scroll target is read at the start of the next
// update() (read-first phase); the screen fade restarts by itself when a screen goes display:none → shown.
// Theatre deadlines (name card, hint, boss bar out, hint queue ages) run on _tclock, which stops while the
// state is 'paused' (UI-28, ARCH §2.2); flashes, vignette, coin tweens and the reset confirm use _clock.
//
// Per-frame rule (§14 rule 2): update() allocates nothing in steady state. Percent / opacity / seconds
// strings come from tables built once in init(); other strings are built only when the displayed value
// changes (coin text, shield value, results count-up). Web Animations (guarded) are started only on
// discrete transitions (a screen, a star, a purchase), never per frame, and are skipped under reduced
// motion. Browser APIs (matchMedia, fullscreen, element.animate, canvas, focus) are all guarded; the
// module touches no browser global at import time.
import { clamp, ease, fmtCoins, storage, hasHaptics } from './util.js';
import {
  STRINGS, HINTS, JUICE, LEVELS, BOSSES, UPGRADES, upgradeCost, PALETTE, RENDER, WEAPONS, GEAR, PICKUPS, SQUAD,
  DISTRICTS, DISTRICT_RULES, districtForLevel,
} from './data.js';

// ---------------------------------------------------------------------------------------------
// Constants (every literal names its data.js source or is a pure rendering quantisation)
// ---------------------------------------------------------------------------------------------

const UIJ = JUICE.ui;                                   // GDD §14 / ARCH §10.3 UI timings
const REF_W = UIJ.refBox[0];                            // 390 px reference width for --ui
const REF_H = UIJ.refBox[1];                            // 844 px reference height
const UI_MIN = UIJ.uiScaleClamp[0];                     // 0.85
const UI_MAX = UIJ.uiScaleClamp[1];                     // 1.25
const HUD_PERIOD = 1 / UIJ.hudHz;                       // 10 Hz HUD block
const FADE_MS = UIJ.screenFadeMs;                       // 160 ms screen fade (exported to CSS as --screen-fade)
const COIN_TWEEN_S = UIJ.coinTweenMs / 1000;            // 300 ms HUD coin tween
const SHOP_TWEEN_S = UIJ.purchaseFlashMs / 1000;        // 300 ms purchase flash + coin count-down
const HINT_S = UIJ.hintSeconds;                         // 2.5 s hint display (real time)
const STAR_STAGGER = UIJ.starStagger;                   // 0.25 s per star
const STAR_FROM = UIJ.starScaleFrom;                    // stars slam in from 3× scale
const COUNT_RATE = UIJ.countUpPerSec;                   // results coin count-up rate (coins / s)
const CONFIRM_S = UIJ.confirmResetSeconds;              // 3 s "Tap again to confirm"
const CONFIRM_MIN_S = UIJ.confirmMinS;                  // UI-20: confirming taps are ignored this long after arming
const HINT_BOTTOM = UIJ.hintBottomPx;                   // UI-18: pill bottom = safe-bottom + 28 design px (css --hint-bottom)
const HINT_MAXW_PCT = UIJ.hintMaxWidthPct;              // UI-18: pill max-width % of the safe box (css --hint-maxw)
const HINT_ALPHA = UIJ.hintAlpha;                       // UI-18: pill panel alpha (css --hint-alpha)
const HINT_QMAX = UIJ.hintQueueMax;                     // UI-25: hints waiting behind the one on screen
// round-3 FTUE: with another hint waiting, the one on screen yields after this long instead of the full 2.5 s — L1 fires
// "GRAB THE CRATE", "×3 MULTIPLIES YOUR SQUAD", the first pickup and "RED TAKES SOLDIERS" within 5 s, and in strict
// 2.5 s turns the ×3 lesson came 2 s after its pass and the red one 3 s after its gate appeared
const HINT_MIN_S = UIJ.hintMinSeconds > 0 ? Math.min(UIJ.hintMinSeconds, HINT_S) : HINT_S;
const HINT_QUEUE_AGE_S = 6;                             // DATA-MISSING: JUICE.ui.hintQueueMaxAgeS — a queued hint older than this is dropped (UI-25)
// UI-18: the hand icon shows inside the pill for these hints only. Round-3 FTUE: both sway (a drag) — the shoot hint used
// a tap bounce, which told first-time players to TAP to shoot; the squad fires on its own and the finger only steers.
const HINT_HAND_IDS = Object.freeze({ steer: true, shoot: true });
// round 6 — the HUD FIRE button (stored weapons, weapons.storeWeapon / requestFire; css #btn-fire)
const FIRE_ICON_PX = 128;                               // DATA-MISSING: JUICE.ui.fireIconPx — pictogram bitmap (2× the 44 px CSS box, retina)
const FIRE_CLICK_SUPPRESS_S = 0.6;                      // structural: the click that follows a pointerdown / key activation is not a second FIRE
const GAMEPAD_FIRE_BUTTON = 0;                          // standard mapping: A / Cross fires (engine owns Start = pause)
const FIRE_WEAPON_IDS = Object.freeze([WEAPONS.shotgun.id, WEAPONS.minigun.id, WEAPONS.rocket.id, WEAPONS.railgun.id, WEAPONS.laser.id]);
const ERROR_HIDE_MS = UIJ.errorAutoHideSeconds * 1000;  // non-fatal error toast auto-hide
const BOSS_IN_MS = UIJ.bossBarInMs;                     // boss bar slide-in
const BOSS_OUT_S = UIJ.bossBarOutMs / 1000;             // boss bar hides 1.5 s after boss:dead
const NAMECARD_S = BOSSES.intro.nameCard;               // 1.5 s name card
const SKULL_PERIOD_MS = 1000 / UIJ.skullPulseHz;        // 1 Hz run-up skull pulse
const BLINK_LAST = JUICE.powerup.pillBlinkLast;         // pills blink in their last 2 s …
const BLINK_HZ = JUICE.powerup.pillBlinkHz;             // … at 2 Hz
const LETTERBOX_PCT = RENDER.letterboxPct;              // 8 % bars
const MAX_PILLS = 3;                                    // ARCH §10.1 "≤ 3 power-up pills" (weapon + chip + booster)
const FIRE_POS = MAX_PILLS + 2;                         // round 6: _puPos slot of the FIRE button's icon (icon-flight target of every weapon pickup)
const MAX_TICKS = PICKUPS.perLevel.cap * 3;             // ≥ specials per level (PICKUPS.perLevel.cap) — crates + item lanes, with headroom
const PILL_ICON_PX = 64;                                // DATA-MISSING: JUICE.ui.pillIconPx — DOM icon bitmap size (2× the 28–32 px CSS box for retina)
const CARD_ICON_PX = 96;                                // DATA-MISSING: JUICE.ui.cardIconPx — shop card icon bitmap size
const COUNT_UP_MAX_S = 1.5;                             // DATA-MISSING: JUICE.ui.countUpMaxSeconds — GDD J17 results theatre is 1.5 s; the 30/s count-up is capped to it
const PCT_STEPS = 1000;                                 // rendering quantisation: widths in 0.1 % steps (string table, zero per-frame allocation)
const OPA_STEPS = 100;                                  // rendering quantisation: opacities in 0.01 steps
const RING_STEPS = 72;                                  // rendering quantisation: pill ring in 5° steps
const SECONDS_TABLE = 100;                              // cached "Ns" strings 0..99 (weapon/gear durations ≤ GEAR.chip.duration 20 s)
// result-star outline (100-unit box, 10 points: x, y) — the bitmap star and the css SVG fallback share it
const STAR_POINTS = Object.freeze([50, 2, 62.5, 34, 97, 36, 70, 58, 79.5, 93, 50, 73.5, 20.5, 93, 30, 58, 3, 36, 37.5, 34]);
const STAR_PITCH = [1, 1.12, 1.26];                     // DATA-MISSING: JUICE.ui.starPitch — rising ui_star pitch per star (major-third steps)
const VIGNETTE_ALPHA = 0.75;                            // DATA-MISSING: JUICE.ui.vignetteAlpha — edge alpha of the damage vignette gradient
const HAND_SWAY_PX = 5;                                 // DATA-MISSING: JUICE.ui.hintSwayPx — steer-hint hand sway inside the pill (CSS px; was 28 when the hand sat above the text)
const HAND_SWAY_MS = 900;                               // DATA-MISSING: JUICE.ui.hintSwayMs — one left→right sweep of the steer-hint hand
const BLINK_DIM = 0.3;                                  // DATA-MISSING: JUICE.powerup.pillBlinkDim — pill opacity in the "off" half of the J14 blink
const BLINK_DIM_IDX = Math.round(BLINK_DIM * OPA_STEPS);
const COIN_FALLBACK_PX = [64, 36];                      // DATA-MISSING: JUICE.ui.coinPillFallbackPx — coin-flight target (from the right / top edge) while the HUD is not laid out (GDD §14 pill 96 × 36 top-right)
const PILL_ROW_FALLBACK_PX = 82;                        // DATA-MISSING: JUICE.ui.pillRowY — icon-flight target y while the HUD is not laid out (GDD §14 pills at safe-top + 70)
const STAR_PLAY_OPTS = [{ volume: 1, pitch: STAR_PITCH[0] }, { volume: 1, pitch: STAR_PITCH[1] }, { volume: 1, pitch: STAR_PITCH[2] }];   // one opts object per star (audio may queue them)
// Count-label anchoring (UI-1 hint clearance, UI-9 shield beside the count). The label is fx's world billboard
// (GDD §3.1, SQUAD.label.px tall, RENDER.atlas digit advance); ui only reads ctx.fx.label and projects it.
const LABEL_PX = SQUAD.label.px + 2 * SQUAD.label.outlinePx;   // on-screen glyph height incl. the 3 px outline
const LABEL_ADV = RENDER.atlas.advance.digit;          // em advance per digit
const HINT_LABEL_MARGIN = 12;                           // DATA-MISSING: JUICE.ui.hintLabelMarginPx — clearance kept between the hint and the count label
const SHIFT_STEP_PX = 4;                                // hint sideways shift quantisation (string table, zero per-frame allocation)
const SHIFT_STEPS = 512;                                // ± 512 × 4 px
const PROG_BAR_PX = 220;                                // GDD §14 progress bar 220 design px (fallback width until the ResizeObserver reports it)
const LEVEL_WINDOW = 30;                                // UI-24: tiles shown past LEVELS.count (a window ending at the highest unlocked level)
// UI-29 fallback until main calls setBootCaption: main's PROGRESS boundaries of the real boot steps
// (page < renderFrom, textures < renderTo, models < models, audio < audio, engine + systems < warmFrom, shader warm-up <
// warmTo, UI prewarm ≥ warmTo); round 3: follows main.js's re-weighted PROGRESS (main calls setBootCaption itself today)
const BOOT_STEP_AT = [0.05, 0.22, 0.255, 0.29, 0.42, 0.70];
// UI-19 boot prewarm pacing (round-3 boot polish; rendering / scheduling quantities, not tuning): JS-only steps share
// a frame up to this many ms; a shown surface stays displayed this many frames (commit → raster → activation done);
// a frame waits for rAF or this many ms (hidden tab); the steps report this share of the prewarm's progress, the
// retire frames the rest; a step that shows a surface weighs this many JS-only steps in that progress (measured at 4×
// CPU throttling: a surface frame ≈ 120–220 ms of style / layout / paint, an icon or bitmap encode ≈ 10–30 ms)
const PREWARM_BUDGET_MS = 12;
const PREWARM_SHOW_FRAMES = 3;
const PREWARM_FALLBACK_MS = 100;
const PREWARM_STEPS_SHARE = 0.9;
const PREWARM_SHOW_WEIGHT = 8;
const CANVAS_CPU = Object.freeze({ willReadFrequently: true });   // 2D context option: CPU-backed canvas (no GPU read-back on encode)
const SHIELD_GAP_PX = 8;                                // DATA-MISSING: JUICE.ui.shieldGapPx — shield pill sits this far right of the count (GDD §8.2 / §14)
const EDGE_PX = [12, 8, 16, 8];                         // safe-area floors (top, right, bottom, left) of css --safe-* (ARCH §10.2) for clamps
const PX_STEPS = 4096;                                  // cached 'Npx' strings 0..4095 (zero-allocation shield positioning)
const BOSS_P2 = BOSSES.phaseThresholds[0];              // 0.6 — twins: bar colour follows the summed HP (GDD §7 "one boss bar")
const BOSS_P3 = BOSSES.phaseThresholds[1];              // 0.25
const ENDLESS_CHUNK = LEVELS.endless.chunk;             // 300 m
const MINI_EVERY = LEVELS.endless.miniBossEvery;        // mini-boss every 5th chunk (levelgen: D % miniBossEvery === 0)
const FULLSCREEN_OPTS = { navigationUI: 'hide' };
const NOOP = () => {};

// round 5: district banner (DISTRICTS.md §5, DISTRICT_RULES.banner): fade + 6 px rise in, hold, fade out, on the theatre
// clock (the Web Animation is paused with the game). One keyframe list per motion setting, built once.
const DB = DISTRICT_RULES && DISTRICT_RULES.banner ? DISTRICT_RULES.banner : { seconds: 1.6, inSeconds: 0.22, outSeconds: 0.3, risePx: 6 };   // §8.1 values as the guard
const DB_S = DB.seconds > 0 ? DB.seconds : 1.6;                       // DISTRICT_RULES.banner.seconds (total on screen)
const DB_IN = clamp(DB.inSeconds / DB_S, 0, 0.5);                     // in / total → keyframe offset
const DB_OUT = clamp(DB.outSeconds / DB_S, 0, 0.5);                   // out / total → keyframe offset
const KF_DB = [
  { opacity: 0, transform: 'translateY(-' + DB.risePx + 'px)', easing: 'ease-out' },
  { opacity: 1, transform: 'translateY(0)', offset: DB_IN },
  { opacity: 1, transform: 'translateY(0)', offset: 1 - DB_OUT, easing: 'ease-in' },
  { opacity: 0, transform: 'translateY(0)' },
];
const KF_DB_RM = [                                                    // html.reduced-motion: opacity only, no translate
  { opacity: 0, easing: 'ease-out' }, { opacity: 1, offset: DB_IN }, { opacity: 1, offset: 1 - DB_OUT, easing: 'ease-in' }, { opacity: 0 },
];
const T_DB = { duration: DB_S * 1000, fill: 'both' };
const DB_GLOW_ALPHA = 0.32;                                           // DATA-MISSING: JUICE.ui.bannerGlowAlpha — accent glow under the banner rule
const TILE_BAND_LEVELS = DISTRICT_RULES && DISTRICT_RULES.levelsPerDistrict > 0 ? DISTRICT_RULES.levelsPerDistrict : 5;   // DISTRICT_RULES.levelsPerDistrict
const TILE_TINT_ALPHA = 0.16;                                        // DATA-MISSING: JUICE.ui.levelTileTintAlpha — district tint at the foot of a level tile

// round 5: consistent-build service worker (sw.js v4, ARCH §15.4): the waiting worker is announced by the title's
// "Update ready" pill; a tap posts SKIP_WAITING and the page reloads on controllerchange (index shell only).
const SW_CHECK_S = 1800;                                              // DATA-MISSING: JUICE.ui.swUpdateCheckS — registration.update() at the first title, then at most every 30 min
const SW_FIRST_CHECK_MS = 2500;                                       // DATA-MISSING: JUICE.ui.swFirstCheckMs — the launch's first update check, this long after the title shows
const SW_RELOAD_FALLBACK_MS = 4000;                                   // DATA-MISSING: JUICE.ui.swReloadFallbackMs — reload anyway if no controllerchange arrives
const SW_SKIP_MSG = Object.freeze({ type: 'SKIP_WAITING' });           // sw.js message contract
// r5b: the pill shows only when the waiting worker's build differs from the page's own: sw.js answers GET_BUILD (on a
// MessagePort) with { type: 'BUILD', version: <sw VERSION>, app: <ctx.version of its cached build> }; the 1.1.0 worker (v3) never answers
const SW_BUILD_MSG = Object.freeze({ type: 'GET_BUILD' });             // sw.js message contract (r5b)
const SW_ASK_MS = 3000;                                               // DATA-MISSING: JUICE.ui.swBuildAskMs — how long a worker has to answer GET_BUILD (a waiting worker may need a cold start)
const SW_ASK_PAGE = 0, SW_ASK_CAND = 1;                               // _swAsk slots: the page's own controller (at boot), the update candidate

// Screens (§10.1). Non-overlay screens are exclusive; overlays stack above them.
const SCREEN_EL_ID = Object.freeze({
  boot: 'scr-boot', title: 'scr-title', levels: 'scr-levels', shop: 'scr-shop', settings: 'scr-settings',
  pause: 'scr-pause', complete: 'scr-complete', gameover: 'scr-gameover', endless: 'scr-endless',
});
const SCREEN_IDS = Object.freeze(['boot', 'title', 'levels', 'shop', 'settings', 'pause', 'complete', 'gameover', 'endless']);
// screens behind which the HUD stays visible (§10.1 "HUD is visible in playing, paused and during complete/gameover")
const HUD_UNDER = Object.freeze({ pause: true, complete: true, gameover: true, endless: true });
// BACK returns to these states, anything else falls back to the title (§10.3)
const BACK_STATES = Object.freeze(['title', 'complete', 'gameover']);
const UPGRADE_IDS = Object.freeze(Object.keys(UPGRADES));
const QUALITY_OPTIONS = Object.freeze(['auto', 'low', 'med', 'high']);

// Reused event payloads (§5: emitters reuse module-level objects)
const P_SCREEN = { id: null, prev: null };
const P_BUTTON = { id: '' };
const P_SETTINGS = { key: '', value: null };
const P_BUY = { id: '', rank: 0, cost: 0 };

// Web Animations keyframes / timings, built once (no allocation when an animation starts)
const KF_SLIDE_DOWN = [{ transform: 'translateY(-140%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }];
const KF_POP_IN = [{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }];
const KF_STAR = [{ transform: 'scale(' + STAR_FROM + ') rotate(-25deg)', opacity: 0 }, { transform: 'scale(0.9) rotate(4deg)', opacity: 1, offset: 0.75 }, { transform: 'scale(1) rotate(0deg)', opacity: 1 }];
const KF_PUNCH = [{ transform: 'scale(1)' }, { transform: 'scale(' + JUICE.coinFlight.punch + ')' }, { transform: 'scale(1)' }];
const KF_PULSE = [{ transform: 'scale(1)', opacity: 0.85 }, { transform: 'scale(1.35)', opacity: 1 }, { transform: 'scale(1)', opacity: 0.85 }];
const KF_SHAKE = [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }];
const KF_FLASH = [{ filter: 'brightness(1.8)' }, { filter: 'brightness(1)' }];
const KF_LB_TOP = [{ transform: 'translateY(-100%)' }, { transform: 'translateY(0)' }];
const KF_LB_BOTTOM = [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }];
const KF_HAND = [{ transform: 'translateX(-' + HAND_SWAY_PX + 'px)' }, { transform: 'translateX(' + HAND_SWAY_PX + 'px)' }];
const KF_BOSS_RAGE = [{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }];
const T_BOSS_IN = { duration: BOSS_IN_MS, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)', fill: 'backwards' };
const T_NAMECARD = { duration: UIJ.bossBarInMs, easing: 'ease-out', fill: 'backwards' };
const T_STAR = { duration: STAR_STAGGER * 1000, easing: 'ease-out', fill: 'backwards' };
const T_PUNCH = { duration: JUICE.coinFlight.seconds * 500, easing: 'ease-out' };   // half the J19 flight time (0.2 s)
const T_PULSE = { duration: SKULL_PERIOD_MS, iterations: Infinity, easing: 'ease-in-out' };
const T_SHAKE = { duration: UIJ.purchaseFlashMs, easing: 'ease-out' };
const T_FLASH = { duration: UIJ.purchaseFlashMs, easing: 'ease-out' };
const T_LETTERBOX = { duration: UIJ.bossBarInMs, easing: 'ease-out', fill: 'backwards' };
const T_HAND = { duration: HAND_SWAY_MS, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' };
const T_RAGE = { duration: SKULL_PERIOD_MS * 0.6, iterations: Infinity, easing: 'ease-in-out' };
// round 6: FIRE refused (a weapon is running) — a small head-shake; FIRE accepted — the J19 punch
const KF_FIRE_DENY = [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }];
const T_FIRE_DENY = { duration: 260, easing: 'ease-out' };

// ---------------------------------------------------------------------------------------------
// Small helpers (no per-frame use except the table lookups)
// ---------------------------------------------------------------------------------------------

function hexCss(hex) {
  return '#' + (((hex >>> 0) & 0xFFFFFF).toString(16).padStart(6, '0'));
}

function rgbaCss(hex, a) {
  const h = (hex >>> 0) & 0xFFFFFF;
  return 'rgba(' + ((h >> 16) & 255) + ',' + ((h >> 8) & 255) + ',' + (h & 255) + ',' + a + ')';
}

/** data id 'weapon.minigun' → its data.js entry (WEAPONS / GEAR); null for troops / coins / unknown. */
function itemEntry(id) {
  if (typeof id !== 'string') return null;
  const dot = id.indexOf('.');
  if (dot < 0) return null;
  const cat = id.slice(0, dot), key = id.slice(dot + 1);
  if (cat === 'weapon') return WEAPONS[key] || null;
  if (cat === 'gear') return GEAR[key] || null;
  return null;
}

function isWeaponId(id) { return typeof id === 'string' && id.indexOf('weapon.') === 0; }

function prefersReducedMotion() {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      return !!(mq && mq.matches);
    }
  } catch (_) { /* sandboxed frames may deny matchMedia */ }
  return false;
}

/** UI-16: a fine pointer or no touch support → the steer hint also teaches the keyboard (ARCH §6.2 A/D/←/→). */
function prefersDesktopSteerHint() {
  try {
    const fine = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !!window.matchMedia('(pointer: fine)').matches;
    const noTouch = typeof navigator !== 'undefined' && !!navigator && navigator.maxTouchPoints === 0;
    return fine || noTouch;
  } catch (_) {
    return false;
  }
}

/** Endless HUD label: live metres with no-break thousands spacing ("1 240 m"). */
function fmtMetres(m) {
  return String(m).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0') + '\u00A0m';   // DATA-MISSING: STRINGS.hud.metres
}

function byId(doc, id) {
  try { return doc.getElementById(id); } catch (_) { return null; }
}

/** Creates a canvas, runs draw(g, px) and returns a PNG data URL ('' when canvases are unavailable). */
function drawIcon(px, draw) {
  try {
    if (typeof document === 'undefined') return '';
    const c = document.createElement('canvas');
    c.width = px; c.height = px;
    const g = c.getContext('2d');
    if (!g) return '';
    g.scale(px / 64, px / 64);              // every drawing below is authored on a 64 × 64 grid
    draw(g);
    return c.toDataURL('image/png');
  } catch (_) {
    return '';
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

const OUTLINE = hexCss(PALETTE.glyph.outline);

/** Procedural shop-card icons (64-unit grid), drawn once per session. */
const CARD_ICON_DRAW = {
  squad(g) {
    const heads = [[20, 38], [44, 38], [32, 28]];
    for (let i = 0; i < heads.length; i++) {
      const x = heads[i][0], y = heads[i][1];
      g.fillStyle = hexCss(PALETTE.soldier.uniform);
      roundRect(g, x - 11, y + 8, 22, 18, 7); g.fill(); g.lineWidth = 3; g.strokeStyle = OUTLINE; g.stroke();
      g.beginPath(); g.arc(x, y + 2, 8, 0, Math.PI * 2); g.fillStyle = hexCss(PALETTE.soldier.skin); g.fill(); g.stroke();
      g.beginPath(); g.arc(x, y, 10, Math.PI, 0); g.closePath(); g.fillStyle = hexCss(PALETTE.soldier.helmet); g.fill(); g.stroke();
    }
  },
  fireRate(g) {
    g.lineWidth = 3; g.strokeStyle = OUTLINE;
    for (let i = 0; i < 3; i++) {
      const y = 16 + i * 14, x = 18 + i * 6;
      g.fillStyle = hexCss(PALETTE.gate.max);
      g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 22, y - 5); g.quadraticCurveTo(x + 34, y, x + 22, y + 5); g.lineTo(x, y + 5); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = rgbaCss(PALETTE.ui.text, 0.75); g.beginPath(); g.moveTo(x - 14, y); g.lineTo(x - 4, y); g.stroke(); g.strokeStyle = OUTLINE;
    }
  },
  damage(g) {
    const n = 8;
    g.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2, r = i % 2 === 0 ? 28 : 13;
      const x = 32 + Math.cos(a) * r, y = 32 + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath(); g.fillStyle = hexCss(PALETTE.ui.danger); g.fill(); g.lineWidth = 3; g.strokeStyle = OUTLINE; g.stroke();
    g.beginPath(); g.arc(32, 32, 9, 0, Math.PI * 2); g.fillStyle = hexCss(PALETTE.ui.primary); g.fill();
  },
  // UI-33: a gold coin with a badge (the old green crossed strokes read as a close / delete ×). Round-3 verify (FTUE
  // residual 2): the badge read "×2" while the first rank is ×1.0 → ×1.1 — an up arrow says "more coins" without a number
  coinMult(g) {
    g.beginPath(); g.arc(26, 38, 21, 0, Math.PI * 2); g.fillStyle = hexCss(PALETTE.ui.coin); g.fill(); g.lineWidth = 3; g.strokeStyle = OUTLINE; g.stroke();
    g.beginPath(); g.arc(26, 38, 14, 0, Math.PI * 2); g.strokeStyle = hexCss(PALETTE.ui.primaryBorder); g.lineWidth = 2.5; g.stroke();
    g.fillStyle = rgbaCss(0xFFFFFF, 0.55); g.beginPath(); g.arc(19, 31, 5, 0, Math.PI * 2); g.fill();
    roundRect(g, 30, 4, 32, 24, 11); g.fillStyle = hexCss(PALETTE.ui.primary); g.fill(); g.lineWidth = 3; g.strokeStyle = OUTLINE; g.stroke();
    g.fillStyle = hexCss(PALETTE.ui.primaryText); g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(46, 7.5); g.lineTo(55, 16.5); g.lineTo(50, 16.5); g.lineTo(50, 24.5); g.lineTo(42, 24.5); g.lineTo(42, 16.5); g.lineTo(37, 16.5);
    g.closePath(); g.fill(); g.stroke();
  },
  bossDamage(g) {
    g.lineWidth = 3; g.strokeStyle = OUTLINE;
    g.fillStyle = hexCss(PALETTE.ui.text);
    g.beginPath(); g.arc(32, 28, 20, Math.PI * 0.9, Math.PI * 2.1); g.lineTo(46, 46); g.lineTo(18, 46); g.closePath(); g.fill(); g.stroke();
    roundRect(g, 22, 42, 20, 12, 3); g.fill(); g.stroke();
    g.fillStyle = hexCss(PALETTE.ui.danger);
    g.beginPath(); g.arc(24, 30, 6, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(40, 30, 6, 0, Math.PI * 2); g.fill();
    g.fillStyle = OUTLINE; g.beginPath(); g.moveTo(32, 36); g.lineTo(29, 42); g.lineTo(35, 42); g.closePath(); g.fill();
  },
};

/** Steer hint: a touch point with left / right arrows (64-unit grid). */
function drawHandIcon(g) {
  g.lineWidth = 4; g.strokeStyle = OUTLINE; g.lineJoin = 'round';
  g.fillStyle = hexCss(PALETTE.ui.text);
  for (let s = -1; s <= 1; s += 2) {
    g.beginPath(); g.moveTo(32 + s * 30, 32); g.lineTo(32 + s * 19, 22); g.lineTo(32 + s * 19, 42); g.closePath(); g.fill(); g.stroke();
  }
  g.beginPath(); g.arc(32, 32, 13, 0, Math.PI * 2); g.fillStyle = rgbaCss(PALETTE.ui.text, 0.35); g.fill();
  g.beginPath(); g.arc(32, 32, 8, 0, Math.PI * 2); g.fillStyle = hexCss(PALETTE.ui.text); g.fill(); g.stroke();
}

/** §12 settings defaults, used only when the save store is missing (stub harness). */
const DEFAULT_SETTINGS = Object.freeze({ sound: 100, music: 70, haptics: true, quality: 'auto', reducedMotion: null, hcGates: false, largeText: false, sensitivity: 1 });


// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------

export class UI {
  constructor(ctx) {
    this.ctx = ctx;
    /** #debug <pre>, exposed for engine's overlay (it toggles a 'red' class on it). */
    this.debugPanel = null;

    this._doc = null;
    this._el = null;                 // cached elements (filled by _cacheDom)
    this._screens = null;            // screen id → element
    this._unsubs = [];
    this._domOff = [];               // [target, type, fn, options] for dispose()
    this._mq = null;                 // prefers-reduced-motion MediaQueryList
    this._mqReduced = false;

    // string tables (built in init)
    this._pct = null;                // '0%' … '100%' in 0.1 % steps
    this._opa = null;                // '0' … '1' in 0.01 steps
    this._secs = null;               // STRINGS.hud.seconds(0 … 99)
    this._ringCache = new Map();     // item id → conic-gradient strings (RING_STEPS + 1)
    this._iconCache = new Map();     // item id → 'url("data:…")' ('' when unavailable)

    // clocks / flags
    this._clock = 0.5; this._clock = 0;                 // real seconds, advanced by update(unscaledDt)
    this._tclock = 0.5; this._tclock = 0;                // theatre seconds: real time that stops while the state is 'paused' (UI-28)
    this._hudAcc = 0.5; this._hudAcc = 0;
    this._reduced = false;
    this._blur = false;
    this._htmlDirty = false;
    this._uiScale = 1;
    this._uiScaleStr = '';

    // screens
    this._current = 'boot';
    this._beforeSettings = null;
    this._pendingSet = false;
    this._pendingId = null;
    this._bootHiding = false;
    this._bootProgress = 0.5; this._bootProgress = 0;
    this._bootPct = -1;              // integer percent last written to #boot-bar aria-valuenow
    this._bootStep = -1;
    this._bootCaptionSet = false;    // main drives the captions (setBootCaption) → the fraction fallback stops
    this._prewarmP = null;           // UI-19 prewarm promise (once)
    this._prewarmDone = false;
    this._bootHold = false;          // the boot screen stays up until the prewarm finished
    this._bootHideReq = false;       // hideBoot() ran while the prewarm was still holding
    this._prewarmAnim = null;        // the prewarmed pill's pop animation (cancelled when the prewarm ends)
    // round 6: HUD FIRE button (stored weapons). Model read from weapons each frame (storedCount / storedId / weapon /
    // weaponTimeLeft — a handful of getters); the DOM is written only when a shown value changes
    this._fireShown = false;         // #btn-fire displayed (a weapon stored or running)
    this._fireId = '';               // pictogram shown: the next stored weapon, else the running one
    this._fireBusy = -1;             // 1 = a weapon is running (ring drains, taps refused), 0 = ready, -1 = not drawn yet
    this._fireCount = -1;            // stored count shown (the "×2" badge at 2)
    this._fireRingId = '';           // weapon whose colour the ring uses
    this._fireRingStr = null;        // its conic-gradient strings (_ringStrings)
    this._fireRing = -1;             // ring step shown (0..RING_STEPS)
    this._fireDur = 0.5; this._fireDur = 0;   // WEAPONS.*.duration of the ring's weapon (Double field from the start)
    this._fireClickUntil = 0;        // _realNow() s: a click before this is the tail of a pointer / key activation
    this._fireAnim = null;
    this._fireIcons = new Map();     // id → 'url("…")' at FIRE_ICON_PX (encoded at boot, UI-23)
    this._gpSeen = false;            // a gamepad connected: poll its A button while the FIRE button shows
    this._gpOk = true;
    this._gpA = false;
    this._prewarmStarAnim = null;    // round 3: the prewarmed results star's slam animation (cancelled when the prewarm ends)
    this._prewarmDbAnim = null;      // round 5: the prewarmed district banner's animation
    this._prewarmBossAnims = [];     // round 5 integration: the prewarmed boss chrome's animations (bar, letterbox, name card)
    this._startingBtn = null;        // round 5 integration: the menu button whose requestStart waits for its script (.starting)
    this._hudVisible = false;
    this._lastCompleteEndless = false;
    this._saveDirty = false;
    this._shopBadge = false;         // round-3 FTUE: the SHOP buttons wear the "upgrade affordable" badge (_syncShopBadges)
    this._prevBest = -1;             // round-3 FTUE: best survivors of the running level before this run (−1 = never cleared)
    this._volatileShown = false;
    this._fsAvailable = false;
    this._iconsReady = false;

    // HUD: run
    this._hudResetPending = false;
    this._runLevel = 1;
    this._runEndless = false;
    this._tickFrac = new Float32Array(MAX_TICKS);
    this._tickCount = 0;
    this._ticksDirty = false;
    this._tickEls = null;
    this._txPct = null;              // 'translateX(N%)' table (UI-22: progress fill / marker / boss fill are transforms)
    // Fraction-holding fields below are created from 0.5 (or -0.5) and set to their start value on the same line
    // (round-2 cross-group, FX-14 item 2): a Double representation from the start, so the first fractional store in
    // play does not deprecate the UI map and deoptimise every reader (V8 --log-maps: 1 200+ UI deprecations per run).
    this._progBarW = 0.5; this._progBarW = 0;              // #progress-bar width (ResizeObserver) — fallback PROG_BAR_PX × --ui
    this._progFrac = 0.5; this._progFrac = 0;
    this._progDirty = false;
    this._progIdx = -1;
    this._skullPulse = false;
    this._skullDirty = false;
    this._skullAnim = null;

    // HUD: coins
    this._coinShown = -1;            // integer currently in #coins-value
    this._coinValue = 0.5; this._coinValue = 0;             // tweened value (float)
    this._coinFrom = 0.5; this._coinFrom = 0;
    this._coinTo = 0.5; this._coinTo = 0;
    this._coinT = 0.5; this._coinT = 0;
    this._coinTween = false;
    this._coinTotal = 0.5; this._coinTotal = 0;             // latest credited total (coins:change); the pill shows it minus fx.coinsInFlight
    this._coinHold = false;          // re-evaluate the held-back target (a coins:change arrived or coins are still flying)

    // HUD: power-up pills (model in arrays, DOM in _puEls)
    this._puId = ['', '', ''];
    this._puDur = new Float64Array(MAX_PILLS);
    this._puStart = new Float64Array(MAX_PILLS);
    this._puLeft = new Float64Array(MAX_PILLS);
    this._puFlash = new Uint8Array(MAX_PILLS);
    this._puCount = 0;
    this._puEls = null;              // [{ root, ring, icon, time }]
    this._puShownId = ['', '', ''];
    this._puRing = new Int16Array(MAX_PILLS);
    this._puSec = new Int16Array(MAX_PILLS);
    this._puOpa = new Int16Array(MAX_PILLS);
    this._puRings = [null, null, null];

    // HUD: shield (positioned beside the projected count label every frame while plates > 0)
    this._plates = 0;
    this._platesShown = -1;
    this._shieldAnchorOk = false;
    this._shieldW = 0;
    this._shieldH = 0;
    this._shieldX = -0.5; this._shieldX = -1;
    this._shieldY = -0.5; this._shieldY = -1;

    // projected count label (CSS px relative to #app): centre, half extents
    this._lx = 0.5; this._lx = 0; this._ly = 0.5; this._ly = 0; this._lhw = 0.5; this._lhw = 0; this._lhh = 0.5; this._lhh = 0;
    this._appW = 0; this._appH = 0;
    this._px = null;                 // 'Npx' string table (built in init)

    // endless HUD (UI-5)
    this._progDist = 0.5; this._progDist = 0;
    this._progLen = 0.5; this._progLen = 0;
    this._skullShown = true;
    this._metresShown = -1;

    // focus modality (UI-14): html.pointer-input hides the keyboard focus ring until a key is pressed
    this._pointerMode = false;

    // HUD: boss bar / letterbox / name card
    this._bossShowPending = false;
    this._bossOn = false;
    this._bossName = '';
    this._bossMini = false;
    this._bossTwins = false;
    this._bossFrac = 0.5; this._bossFrac = 1;
    this._bossPhase = 1;
    this._bossShieldUp = false;
    this._bossDirty = false;
    this._bossHideAt = 0.5; this._bossHideAt = 0;
    this._bossIdx = -1;
    this._bossColor = '';
    this._bossRage = null;
    this._bossColors = null;         // css strings by state (built in init)
    this._lbOn = false;
    this._lbShown = false;
    this._ncPending = false;
    this._ncUntil = 0.5; this._ncUntil = 0;
    this._ncShown = false;

    // HUD: hint (UI-25 queue: the one on screen + ≤ HINT_QMAX waiting, de-duplicated by id, marked done on display)
    this._hintId = '';
    this._hintText = '';
    this._hintHideReq = false;
    this._hintShown = false;
    this._hintUntil = 0.5; this._hintUntil = 0;
    this._handAnim = null;
    this._hqId = new Array(HINT_QMAX).fill('');
    this._hqText = new Array(HINT_QMAX).fill('');
    this._hqAt = new Float64Array(HINT_QMAX);
    this._hqLen = 0;
    // UI-18 label avoidance (wide boxes): pill box from the ResizeObserver (offset*, no forced layout), sideways shift
    this._ro = null;
    this._hintBoxOk = false;
    this._hintBL = 0; this._hintBT = 0; this._hintBW = 0; this._hintBH = 0;
    this._hintShift = 0;             // applied shift in SHIFT_STEP_PX units
    this._shiftStr = null;           // 'Npx 0px' strings for the css `translate` property

    // HUD: flash / vignette
    this._flashHex = -1;
    this._flashCss = '';
    this._flashCssDirty = false;
    this._flashA0 = 0.5; this._flashA0 = 0;
    this._flashDur = 0.5; this._flashDur = 0;
    this._flashT = 0.5; this._flashT = 0;
    this._flashOn = false;
    this._flashOpa = -1;
    this._vigHex = -1;
    this._vigCss = '';
    this._vigCssDirty = false;
    this._vigDur = 0.5; this._vigDur = 0;
    this._vigT = 0.5; this._vigT = 0;
    this._vigOn = false;
    this._vigOpa = -1;

    // screen-position caches for fx flights
    this._coinPosDirty = true;
    this._coinX = 0.5; this._coinX = 0; this._coinY = 0.5; this._coinY = 0;
    this._mx = 0.5; this._mx = 0; this._my = 0.5; this._my = 0;      // scratch result of _measureRaw
    this._puPosDirty = true;
    this._puPos = new Float32Array(MAX_PILLS * 2 + 6);   // pills (x, y) × 3, then the shield, the generic target, the FIRE icon (round 6)
    this._puPosOk = new Uint8Array(MAX_PILLS + 3);

    // results
    this._cmp = { level: 1, stars: 0, coins: 0, survivors: 0, eBoss: 0, score: 0, kills: 0, gates: 0, piles: 0, boss: 0, bonus: 0 };
    this._cmpFresh = false;
    this._cmpAnimating = false;
    this._cmpT = 0.5; this._cmpT = 0;
    this._cmpStarsShown = 0;
    this._cmpCoinShown = -1;
    this._fail = { level: 1, fraction: 0, coinsKept: 0 };
    this._end = { distance: 0, score: 0, best: 0, coins: 0, chunks: 0, newBest: false };

    // shop
    this._cards = null;              // id → { card, icon, name, pips[], effect, estimate, buy, price }
    this._cardIconsDone = false;
    this._shopCoinShown = -1;
    this._shopFrom = 0;
    this._shopTo = 0;
    this._shopT = 0;
    this._shopTween = false;

    // settings / reset
    this._confirmArmed = false;
    this._confirmUntil = 0;
    this._confirmArmedAt = 0;        // UI-20: performance.now() seconds of the arming tap

    // level grid (UI-19 / UI-24: built once, updated in place)
    this._lvTiles = null;            // [{ btn, num, on, off, stars, skull, n }] for 1..LEVELS.count, then the window pool
    this._lvEndless = null;          // { btn, num, stars }
    this._lvScrollPending = false;   // read-first: scroll the current tile into view at the start of the next update()

    // errors / debug
    this._fatalShown = false;
    this._fatalMsg = '';
    this._errorTimer = 0;
    this._pendingErr = '';
    this._debugText = '';

    // bound handlers (created once)
    this._onClickDom = (e) => this._click(e);
    this._onInputDom = (e) => this._input(e, false);
    this._onChangeDom = (e) => this._input(e, true);
    this._onKeyDom = (e) => this._key(e);
    this._onFirePointer = (e) => this._firePointer(e);
    this._onGamepad = () => { this._gpSeen = true; };
    this._onPointerDom = () => { if (!this._pointerMode) this._setPointerMode(true); };
    this._onFsChange = () => this._syncFullscreenButton();
    this._onMqChange = () => this._mediaChanged();
    this._onErrorTimeout = () => this._hideErrorToast();
    this._onResize = (entries) => this._observed(entries);
    this._bitmapsReq = 0;            // UI-19 results bitmaps requested, bit k = _buildResultBitmap(k) (sunburst, empty star, earned star)
    this._blobUrls = [];             // blob: URLs to revoke in dispose()
    this._shieldWaiting = false;     // shield laid out invisibly until the observer reports its size
    this._focusPending = null;       // UI-21: focus moves at the start of the next update (no style flush mid-frame)

    // round 5: district banner (DISTRICTS.md §5) — listeners store, update() writes
    this._dbLabel = '';              // label of the requested banner (district.label)
    this._dbAccent = -1;             // accent of the requested banner (0xRRGGBB)
    this._dbShownLabel = '';         // what #district-banner's text holds
    this._dbShownAccent = -1;        // what --db-accent holds
    this._dbReq = false;             // a banner is due (district:change with banner: true while playing)
    this._dbHideReq = false;         // level:start / leaving the run: hide it
    this._dbShown = false;
    this._dbUntil = 0.5; this._dbUntil = 0;   // theatre-clock deadline
    this._dbAnim = null;
    this._dbAnimPaused = false;
    this._puOn = false;              // #hud.pu-on (a power-up pill is visible: the banner drops a row)
    this._runDistrict = '';          // level:start district id (round 5)

    // round 5: service-worker update pill (index shell only; ARCH §15.4)
    this._swReg = null;
    this._swHadController = false;
    this._swWaiting = null;          // the installed worker waiting to take over (null: a plain reload is enough)
    this._swUpdate = false;          // an update is ready → the pill shows on the title
    this._swShown = false;
    this._swDirty = false;
    this._swReloading = false;
    this._swCheckedAt = 0.5; this._swCheckedAt = -SW_CHECK_S;   // _clock seconds of the last registration.update(): the first title checks at once
    this._swCheckTimer = 0;          // pending registration.update() timer
    this._swFirstDone = false;       // the launch's first (delayed) update check ran
    // r5b: which build this page runs, and which build an update candidate holds (GET_BUILD, sw.js)
    this._swPageSw = '';             // the sw VERSION whose cache served this page ('' = unknown: no controller, or the v3 worker)
    this._swPageKnown = false;       // the boot-time question to the page's controller is settled (answer or timeout)
    this._swCand = null;             // the worker whose build is being asked (a waiting worker, or a new controller)
    this._swCandInfo = null;         // its answer (null: none)
    this._swCandDone = false;        // the candidate's answer (or its timeout) is in
    this._swAskTimer = [0, 0];       // per _swAsk slot: the pending timeout
    this._swAskPort = [null, null];  // per _swAsk slot: the open MessagePort
    this._swAskGen = [0, 0];         // per _swAsk slot: generation (a newer question drops the older answer)
    this._onSwCheck = () => this._swCheckNow();
    this._onSwController = () => this._swControllerChanged();
    this._onSwUpdateFound = () => { const r = this._swReg; if (r && r.installing) this._swTrack(r.installing); };
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Boot step 4: DOM cache, static pools, listeners, boot screen, <html> classes, --ui. */
  init() {
    const doc = typeof document !== 'undefined' ? document : null;
    this._doc = doc;
    if (!doc) return this;
    this._buildTables();
    this._cacheDom(doc);
    this._buildPills(doc);
    this._buildTicks(doc);
    this._buildShopCards(doc);
    this._buildSegments(doc);
    this._applyStaticText(doc);
    this._hideUnsupported();
    this._wireDom(doc);
    this._subscribe();
    this._probeMedia();
    this._applyHtmlClasses();
    const el = this._el;
    this.debugPanel = el.debug || null;
    if (el.debug) el.debug.hidden = !(this.ctx.config && this.ctx.config.debug);
    this._fsAvailable = this._probeFullscreen();
    try {
      const rs = doc.documentElement.style;
      rs.setProperty('--screen-fade', FADE_MS + 'ms');
      rs.setProperty('--hint-bottom', String(HINT_BOTTOM));         // UI-18 pill placement / size / alpha from JUICE.ui
      rs.setProperty('--hint-maxw', HINT_MAXW_PCT + '%');
      rs.setProperty('--hint-alpha', String(HINT_ALPHA));
    } catch (_) { /* ignore */ }
    // UI-21: every screen carries .enter permanently — a CSS animation restarts by itself when the element goes
    // from display:none to shown, so a screen change needs no class toggle + forced reflow
    for (let i = 0; i < SCREEN_IDS.length; i++) {
      const s = this._screens[SCREEN_IDS[i]];
      if (s) { try { s.classList.add('enter'); } catch (_) { /* ignore */ } }
    }
    if (el.hud) { try { el.hud.classList.add('enter'); } catch (_) { /* ignore */ } }
    this._observe();
    this._swInit();
    this.showScreen('boot');
    this.refit();
    return this;
  }

  /** Removes every DOM listener, event subscription, timer and running animation. */
  dispose() {
    for (let i = 0; i < this._unsubs.length; i++) {
      try { this._unsubs[i](); } catch (_) { /* ignore */ }
    }
    this._unsubs.length = 0;
    for (let i = 0; i < this._domOff.length; i++) {
      const d = this._domOff[i];
      try { d[0].removeEventListener(d[1], d[2], d[3]); } catch (_) { /* ignore */ }
    }
    this._domOff.length = 0;
    if (this._mq) {
      try {
        if (typeof this._mq.removeEventListener === 'function') this._mq.removeEventListener('change', this._onMqChange);
        else if (typeof this._mq.removeListener === 'function') this._mq.removeListener(this._onMqChange);
      } catch (_) { /* ignore */ }
      this._mq = null;
    }
    if (this._errorTimer) { try { clearTimeout(this._errorTimer); } catch (_) { /* ignore */ } this._errorTimer = 0; }
    this._cancelAnim(this._skullAnim); this._skullAnim = null;
    this._cancelAnim(this._bossRage); this._bossRage = null;
    this._cancelAnim(this._handAnim); this._handAnim = null;
    this._cancelAnim(this._dbAnim); this._dbAnim = null;
    this._swReg = null; this._swWaiting = null;
    if (this._swCheckTimer) { try { clearTimeout(this._swCheckTimer); } catch (_) { /* ignore */ } this._swCheckTimer = 0; }
    this._swAskEnd(SW_ASK_PAGE); this._swAskEnd(SW_ASK_CAND); this._swCand = null;
    if (this._ro) { try { this._ro.disconnect(); } catch (_) { /* ignore */ } this._ro = null; }
    for (let i = 0; i < this._blobUrls.length; i++) { try { URL.revokeObjectURL(this._blobUrls[i]); } catch (_) { /* ignore */ } }
    this._blobUrls.length = 0;
    this._bitmapsReq = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Init helpers
  // -------------------------------------------------------------------------------------------

  _buildTables() {
    const pct = new Array(PCT_STEPS + 1);
    for (let i = 0; i <= PCT_STEPS; i++) pct[i] = (i / (PCT_STEPS / 100)) + '%';
    this._pct = pct;
    const opa = new Array(OPA_STEPS + 1);
    for (let i = 0; i <= OPA_STEPS; i++) opa[i] = String(i / OPA_STEPS);
    this._opa = opa;
    const secs = new Array(SECONDS_TABLE);
    for (let i = 0; i < SECONDS_TABLE; i++) secs[i] = STRINGS.hud.seconds(i);
    this._secs = secs;
    const px = new Array(PX_STEPS);
    for (let i = 0; i < PX_STEPS; i++) px[i] = i + 'px';
    this._px = px;
    // UI-22: progress fill / boss fill slide inside a clip (translateX(f − 100 %)), the marker spans the bar and
    // slides by f (translateX(f %) of its own full-bar width): compositor-only transforms, no width/left writes
    const txFill = new Array(PCT_STEPS + 1), txPos = new Array(PCT_STEPS + 1);
    for (let i = 0; i <= PCT_STEPS; i++) {
      const p = i / (PCT_STEPS / 100);
      txFill[i] = 'translateX(' + (p - 100) + '%)';
      txPos[i] = 'translateX(' + p + '%)';
    }
    this._txFill = txFill;
    this._txPct = txPos;
    const sh = new Array(SHIFT_STEPS * 2 + 1);
    for (let k = -SHIFT_STEPS; k <= SHIFT_STEPS; k++) sh[k + SHIFT_STEPS] = (k * SHIFT_STEP_PX) + 'px 0px';
    this._shiftStr = sh;
    const U = PALETTE.ui;
    this._bossColors = { base: hexCss(U.bossBar), p2: hexCss(U.bossBarPhase2), p3: hexCss(U.bossBarPhase3), shield: hexCss(U.bossBarShield) };
  }

  _cacheDom(doc) {
    const g = (id) => byId(doc, id);
    const el = {
      app: this.ctx.app || g('app'), ui: g('ui'), hud: g('hud'),
      btnPause: g('btn-pause'), progressLabel: g('progress-label'), progressFill: g('progress-fill'), progressSquad: g('progress-squad'),
      progressSkull: g('progress-skull'), progressTicks: g('progress-ticks'),
      coins: g('coins'), coinsValue: g('coins-value'), coinIcon: null,
      powerups: g('powerups'), shield: g('shield'), shieldValue: g('shield-value'), shieldIcon: null,
      bossbar: g('bossbar'), bossName: g('boss-name'), bossTrack: g('boss-track'), bossFill: g('boss-fill'),
      letterbox: g('letterbox'), letterboxBottom: g('letterbox-bottom'),
      hint: g('hint'), hintHand: g('hint-hand'), hintText: g('hint-text'), namecard: g('namecard'), ncLabel: null, ncName: null,
      flash: g('flash'), vignette: g('vignette'),
      bootBar: g('boot-bar'), bootFill: g('boot-fill'), bootText: g('boot-text'),
      btnSettings: g('btn-settings'), titleCoins: g('title-coins'), titleCoinsValue: null, btnPlay: g('btn-play'), titleCaption: g('title-caption'),
      btnShop: g('btn-shop'), btnLevels: g('btn-levels'), btnEndless: g('btn-endless'), btnFullscreen: g('btn-fullscreen'), version: g('version'),
      levelGrid: g('level-grid'), shopCoins: g('shop-coins'), shopCoinsValue: null, shopList: g('shop-list'),
      setSound: g('set-sound'), setMusic: g('set-music'), setHaptics: g('set-haptics'), setQuality: g('set-quality'),
      setReduced: g('set-reduced'), setHc: g('set-hc'), setLarge: g('set-large'), setSens: g('set-sens'), btnResetSave: g('btn-reset-save'),
      btnResume: g('btn-resume'), btnRestart: g('btn-restart'), btnPauseSettings: g('btn-pause-settings'), btnQuit: g('btn-quit'),
      completeTitle: g('complete-title'), stars: null, completeCoins: g('complete-coins'), completeBreakdown: g('complete-breakdown'),
      completeBest: g('complete-best'), btnNext: g('btn-next'), btnReplay: g('btn-replay'), btnCompleteShop: g('btn-complete-shop'), btnCompleteHome: g('btn-complete-home'),
      gameoverLevel: g('gameover-level'), gameoverInfo: g('gameover-info'), btnRetry: g('btn-retry'), btnGameoverShop: g('btn-gameover-shop'), btnHome: g('btn-home'),
      endlessStats: g('endless-stats'), btnEndlessRetry: g('btn-endless-retry'), btnEndlessHome: g('btn-endless-home'),
      overlayMsg: g('overlay-msg'), overlayText: g('overlay-text'),
      errorBox: g('error-box'), errorText: g('error-text'), btnReload: g('btn-reload'),
      debug: g('debug'),
      btnFire: g('btn-fire'), fireRing: null, fireIcon: null, fireBadge: null, fireLabel: null,   // round 6
      districtBanner: g('district-banner'), dbText: null, titleDistrict: null, btnUpdate: g('btn-update'), updText: null,   // round 5
    };
    try { if (el.districtBanner) el.dbText = el.districtBanner.querySelector('.db-text'); } catch (_) { el.dbText = null; }
    try { if (el.btnUpdate) el.updText = el.btnUpdate.querySelector('.upd-text'); } catch (_) { el.updText = null; }
    if (el.btnFire) {
      try {
        el.fireRing = el.btnFire.querySelector('.fire-ring');
        el.fireIcon = el.btnFire.querySelector('.fire-icon');
        el.fireBadge = el.btnFire.querySelector('.fire-badge');
        el.fireLabel = el.btnFire.querySelector('.fire-label');
      } catch (_) { el.fireRing = null; el.fireIcon = null; el.fireBadge = null; el.fireLabel = null; }
      if (el.fireLabel) el.fireLabel.textContent = STRINGS.fire.label;
      el.btnFire.setAttribute('aria-label', STRINGS.fire.label);
    }
    // round 5: the title caption carries a small district line (created once, re-appended by _fillTitle)
    if (el.titleCaption) {
      el.titleDistrict = doc.createElement('span');
      el.titleDistrict.className = 'caption-district';
    }
    try { if (el.coins) el.coinIcon = el.coins.querySelector('.coin-icon'); } catch (_) { el.coinIcon = null; }
    try { if (el.shield) el.shieldIcon = el.shield.querySelector('.shield-icon'); } catch (_) { el.shieldIcon = null; }
    try { const s = g('stars'); el.stars = s ? s.querySelectorAll('i') : null; } catch (_) { el.stars = null; }
    // value spans inside the title / shop coin pills (the §10.1 markup leaves them empty)
    el.titleCoinsValue = this._fillCoinPill(doc, el.titleCoins);
    el.shopCoinsValue = this._fillCoinPill(doc, el.shopCoins);
    // name card: small "BOSS" label above the archetype name
    if (el.namecard) {
      el.namecard.textContent = '';
      el.ncLabel = doc.createElement('span'); el.ncLabel.className = 'nc-label'; el.ncLabel.textContent = STRINGS.boss.label;
      el.ncName = doc.createElement('span'); el.ncName.className = 'nc-name';
      el.namecard.appendChild(el.ncLabel); el.namecard.appendChild(el.ncName);
    }
    // UI-22: the progress fill slides inside a rounded clip (created here so both shells share the markup)
    if (el.progressFill && el.progressFill.parentNode && el.progressFill.parentNode.id !== 'progress-clip') {
      try {
        const clip = doc.createElement('div');
        clip.id = 'progress-clip';
        el.progressFill.parentNode.insertBefore(clip, el.progressFill);
        clip.appendChild(el.progressFill);
      } catch (_) { /* cosmetic */ }
    }
    // letterbox bars: RENDER.letterboxPct of the app height
    if (el.letterbox) el.letterbox.style.height = LETTERBOX_PCT + '%';
    if (el.letterboxBottom) el.letterboxBottom.style.height = LETTERBOX_PCT + '%';
    // boss phase ticks at BOSSES.phaseThresholds (60 % / 25 %)
    if (el.bossTrack) {
      try {
        const ticks = el.bossTrack.querySelectorAll('.tick');
        for (let i = 0; i < ticks.length && i < BOSSES.phaseThresholds.length; i++) ticks[i].style.left = (BOSSES.phaseThresholds[i] * 100) + '%';
      } catch (_) { /* cosmetic */ }
    }
    this._el = el;
    const screens = {};
    for (let i = 0; i < SCREEN_IDS.length; i++) screens[SCREEN_IDS[i]] = g(SCREEN_EL_ID[SCREEN_IDS[i]]);
    this._screens = screens;
  }

  /** Puts <span class="coin-icon"></span><span class="pill-value"></span> into an empty coin pill; returns the value span. */
  _fillCoinPill(doc, pill) {
    if (!pill) return null;
    let value = null;
    try { value = pill.querySelector('.pill-value'); } catch (_) { value = null; }
    if (value) return value;
    pill.textContent = '';
    const icon = doc.createElement('span'); icon.className = 'coin-icon'; icon.setAttribute('aria-hidden', 'true');
    value = doc.createElement('span'); value.className = 'pill-value';
    pill.appendChild(icon); pill.appendChild(value);
    pill.setAttribute('aria-label', STRINGS.aria.coins);
    return value;
  }

  _buildPills(doc) {
    const host = this._el.powerups;
    const els = [];
    if (host) host.textContent = '';
    for (let i = 0; i < MAX_PILLS; i++) {
      const root = doc.createElement('div'); root.className = 'pill pu'; root.hidden = true;
      const ring = doc.createElement('div'); ring.className = 'ring';
      const icon = doc.createElement('span'); icon.className = 'pu-icon'; icon.setAttribute('aria-hidden', 'true');
      const time = doc.createElement('span'); time.className = 'pu-time';
      root.appendChild(ring); root.appendChild(icon); root.appendChild(time);
      if (host) host.appendChild(root);
      els.push({ root, ring, icon, time });
    }
    this._puEls = els;
  }

  _buildTicks(doc) {
    const host = this._el.progressTicks;
    const els = [];
    if (host) host.textContent = '';
    for (let i = 0; i < MAX_TICKS; i++) {
      const t = doc.createElement('i'); t.className = 'tick'; t.hidden = true;
      if (host) host.appendChild(t);
      els.push(t);
    }
    this._tickEls = els;
  }

  _buildShopCards(doc) {
    const host = this._el.shopList;
    const cards = {};
    if (host) host.textContent = '';
    for (let i = 0; i < UPGRADE_IDS.length; i++) {
      const id = UPGRADE_IDS[i];
      const u = UPGRADES[id];
      const card = doc.createElement('div'); card.className = 'card'; card.dataset.id = id;
      const icon = doc.createElement('span'); icon.className = 'card-icon'; icon.setAttribute('aria-hidden', 'true');
      const body = doc.createElement('div'); body.className = 'card-body';
      const name = doc.createElement('div'); name.className = 'card-name'; name.textContent = u.name;
      if (u.desc) card.title = u.desc;
      const pips = doc.createElement('div'); pips.className = 'pips';
      const pipEls = [];
      for (let k = 0; k < u.ranks; k++) { const p = doc.createElement('i'); pips.appendChild(p); pipEls.push(p); }
      const effect = doc.createElement('div'); effect.className = 'card-effect';
      const estimate = doc.createElement('div'); estimate.className = 'card-estimate';
      body.appendChild(name); body.appendChild(pips); body.appendChild(effect); body.appendChild(estimate);
      const buy = doc.createElement('button'); buy.className = 'btn primary buy'; buy.dataset.id = id; buy.type = 'button';
      const bIcon = doc.createElement('span'); bIcon.className = 'coin-icon'; bIcon.setAttribute('aria-hidden', 'true');
      const price = doc.createElement('span'); price.className = 'price';
      buy.appendChild(bIcon); buy.appendChild(price);
      card.appendChild(icon); card.appendChild(body); card.appendChild(buy);
      if (host) host.appendChild(card);
      cards[id] = { card, icon, name, pips: pipEls, pipsHost: pips, effect, estimate, buy, bIcon, price, iconDone: false };
    }
    this._cards = cards;
  }

  /** Fills the two .seg controls from their data-options (labels from STRINGS.settings.*Options). */
  _buildSegments(doc) {
    const segs = [[this._el.setQuality, STRINGS.settings.qualityOptions], [this._el.setSens, STRINGS.settings.sensitivityOptions]];
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s][0], labels = segs[s][1];
      if (!seg) continue;
      const opts = String(seg.getAttribute('data-options') || '').split(',');
      seg.textContent = '';
      seg.setAttribute('role', 'group');
      for (let i = 0; i < opts.length; i++) {
        const v = opts[i].trim();
        if (!v) continue;
        const b = doc.createElement('button');
        b.type = 'button';
        b.dataset.value = v;
        b.textContent = labels && labels[v] !== undefined ? labels[v] : v;
        b.setAttribute('aria-pressed', 'false');
        seg.appendChild(b);
      }
    }
  }

  /** Copy from STRINGS onto the static markup (index.html carries the same English text as a no-JS fallback). */
  _applyStaticText(doc) {
    const el = this._el;
    const set = (node, text) => { if (node && typeof text === 'string') node.textContent = text; };
    set(el.btnPlay, STRINGS.title.play); set(el.btnShop, STRINGS.title.shop); set(el.btnLevels, STRINGS.title.levels); set(el.btnEndless, STRINGS.title.endless);
    set(el.btnResume, STRINGS.pause.resume); set(el.btnRestart, STRINGS.pause.restart); set(el.btnPauseSettings, STRINGS.pause.settings); set(el.btnQuit, STRINGS.pause.quit);
    set(el.btnNext, STRINGS.complete.next); set(el.btnReplay, STRINGS.complete.replay); set(el.btnCompleteShop, STRINGS.complete.shop);
    set(el.btnRetry, STRINGS.gameover.retry); set(el.btnGameoverShop, STRINGS.gameover.shop);
    set(el.btnEndlessRetry, STRINGS.endless.retry);
    set(el.btnResetSave, STRINGS.settings.resetSave); set(el.btnReload, STRINGS.errors.reload);
    set(el.bootText, STRINGS.boot.text);
    const aria = (node, label) => { if (node && typeof label === 'string') node.setAttribute('aria-label', label); };
    aria(el.btnPause, STRINGS.aria.pause); aria(el.btnSettings, STRINGS.aria.settings); aria(el.btnFullscreen, STRINGS.aria.fullscreen);
    // round 4 (lead): HOME on every results screen is a 48 × 48 house icon top-left (its glyph is markup SVG, so only
    // the accessible name is written here — never textContent, which would wipe the glyph)
    const homeLabel = STRINGS.aria.home || STRINGS.gameover.home;
    aria(el.btnCompleteHome, homeLabel); aria(el.btnHome, homeLabel); aria(el.btnEndlessHome, homeLabel);
    aria(el.coins, STRINGS.aria.coins);
    // round 5: the title's update pill (sw.js v4); guarded so an older data.js without the key still boots
    const upd = STRINGS.update || null;
    set(el.updText, upd && typeof upd.ready === 'string' ? upd.ready : 'Update ready — tap to reload');   // DATA-MISSING fallback: STRINGS.update.ready
    aria(el.btnUpdate, upd && typeof upd.aria === 'string' ? upd.aria : 'Update ready. Reload to update the game');
    const titles = { levels: STRINGS.levels.title, shop: STRINGS.shop.title, settings: STRINGS.settings.title, pause: STRINGS.pause.title, gameover: STRINGS.gameover.title, endless: STRINGS.endless.title };
    const keys = Object.keys(titles);
    for (let i = 0; i < keys.length; i++) {
      const scr = this._screens ? this._screens[keys[i]] : null;
      if (!scr) continue;
      try { const h = scr.querySelector('h1'); if (h) h.textContent = titles[keys[i]]; } catch (_) { /* ignore */ }
    }
    try {
      const logos = doc.querySelectorAll('#ui .logo');
      for (let i = 0; i < logos.length; i++) logos[i].textContent = STRINGS.boot.logo;
      const backs = doc.querySelectorAll('#ui [data-back]');
      for (let i = 0; i < backs.length; i++) { backs[i].textContent = STRINGS.common.back; backs[i].setAttribute('aria-label', STRINGS.aria.back); }
    } catch (_) { /* ignore */ }
    // settings row labels: the leading text node of each row
    const rows = [[el.setSound, STRINGS.settings.sound], [el.setMusic, STRINGS.settings.music], [el.setHaptics, STRINGS.settings.haptics],
      [el.setQuality, STRINGS.settings.quality], [el.setReduced, STRINGS.settings.reducedMotion], [el.setHc, STRINGS.settings.hcGates],
      [el.setLarge, STRINGS.settings.largeText], [el.setSens, STRINGS.settings.sensitivity]];
    for (let i = 0; i < rows.length; i++) {
      const ctl = rows[i][0];
      if (!ctl || !ctl.parentNode) continue;
      const first = ctl.parentNode.firstChild;
      if (first && first.nodeType === 3) first.nodeValue = rows[i][1];
      ctl.setAttribute('aria-label', rows[i][1]);
    }
  }

  /** UI-32: settings rows for controls this device cannot honour are hidden (the saved value is left untouched). */
  _hideUnsupported() {
    const hap = this._el.setHaptics;
    if (hap && !hasHaptics) {
      try { const row = hap.closest('.row'); if (row) row.hidden = true; } catch (_) { /* ignore */ }
    }
  }

  /** One ResizeObserver (UI-18 / UI-21): hint pill box, shield pill size and #app. Its callback runs after layout,
   *  so the offset* reads there never force a layout. Without ResizeObserver the hint simply never shifts. */
  _observe() {
    if (typeof ResizeObserver !== 'function') return;
    const el = this._el;
    try {
      const ro = new ResizeObserver(this._onResize);
      if (el.hint) ro.observe(el.hint);
      if (el.shield) ro.observe(el.shield);
      if (el.app) ro.observe(el.app);
      this._ro = ro;
    } catch (_) { this._ro = null; }
  }

  _observed(entries) {
    const el = this._el;
    if (!el) return;
    let hint = false;
    for (let i = 0; i < entries.length; i++) {
      const t = entries[i].target;
      if (t === el.shield) {
        const w = el.shield.offsetWidth, h = el.shield.offsetHeight;
        if (w > 0 && h > 0) { this._shieldW = w; this._shieldH = h; }
      } else {
        hint = true;                                     // the hint itself or #app (its bottom anchor moved)
      }
    }
    if (hint && el.hint) {
      const h = el.hint;
      const w = h.offsetWidth, hh = h.offsetHeight;
      if (this._hintShown && w > 0 && hh > 0) {
        this._hintBL = h.offsetLeft; this._hintBT = h.offsetTop; this._hintBW = w; this._hintBH = hh;
        this._hintBoxOk = true;
      } else {
        this._hintBoxOk = false;
      }
    }
  }

  _listen(target, type, fn, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    try {
      target.addEventListener(type, fn, options);
      this._domOff.push([target, type, fn, options]);
    } catch (_) { /* ignore */ }
  }

  _wireDom(doc) {
    const el = this._el;
    this._listen(el.ui, 'click', this._onClickDom, false);
    const settings = this._screens.settings;
    this._listen(settings, 'input', this._onInputDom, false);
    this._listen(settings, 'change', this._onChangeDom, false);
    if (typeof window !== 'undefined') {
      this._listen(window, 'keydown', this._onKeyDom, true);
      this._listen(window, 'pointerdown', this._onPointerDom, true);
      this._listen(window, 'gamepadconnected', this._onGamepad, false);   // round 6: gamepad A fires a stored weapon
    }
    // until the first key press the focus ring stays hidden: _focusFirst() focuses PLAY / NEXT / RETRY
    // programmatically, which Chrome would otherwise paint as :focus-visible on touch devices (UI-14)
    this._setPointerMode(true);
    // round 6: FIRE answers on pointerdown (no wait for the release, and a thumb that slides off still fired); the
    // engine never steers from a pointerdown on a button, and the delegated click that follows is swallowed (_click)
    this._listen(el.btnFire, 'pointerdown', this._onFirePointer, false);
    this._listen(doc, 'fullscreenchange', this._onFsChange, false);
    this._listen(doc, 'webkitfullscreenchange', this._onFsChange, false);
    // RELOAD lives inside #ui (handled by the delegated click); the BOOTGUARD / main.js fallbacks check
    // this flag before wiring it themselves.
    if (el.btnReload && el.btnReload.dataset) el.btnReload.dataset.wired = '1';
  }

  _subscribe() {
    const events = this.ctx.events;
    if (!events) return;
    const on = (name, fn) => { this._unsubs.push(events.on(name, fn)); };
    on('state:change', (p) => this._onState(p));
    // J19: the target is evaluated in _updateCoins (after every coin:pickup listener ran, so fx has launched the flight)
    on('coins:change', (p) => { if (p && Number.isFinite(p.total)) { this._coinTotal = p.total; this._coinHold = true; } });
    on('save:change', () => { this._saveDirty = true; });
    on('level:start', (p) => this._onLevelStart(p));
    on('district:change', (p) => this._onDistrictChange(p));   // round 5: banner (DISTRICTS.md §5, §8.6)
    on('level:progress', (p) => { if (p) { this._progFrac = p.fraction; this._progDist = p.distance; this._progLen = p.length; this._progDirty = true; } });
    on('level:runup', () => { this._skullPulse = true; this._skullDirty = true; });
    on('weapon:start', (p) => { if (p) this._pillAdd(p.id, p.duration); });
    on('weapon:end', (p) => { if (p) this._pillRemove(p.id); });
    on('gear:start', (p) => { if (p && Number.isFinite(p.duration)) this._pillAdd(p.id, p.duration); });
    on('gear:end', (p) => { if (p) this._pillRemove(p.id); });
    on('armor:change', (p) => { if (p) this._plates = p.plates | 0; });
    on('boss:spawn', (p) => this._onBossSpawn(p));
    on('boss:intro', (p) => this._onBossIntro(p));
    on('boss:hp', (p) => { if (p) { this._bossFrac = p.fraction; this._bossDirty = true; } });
    on('boss:phase', (p) => { if (p) { this._bossPhase = p.phase | 0; this._bossDirty = true; } });
    on('boss:shield', (p) => { if (p) { this._bossShieldUp = !!p.up; this._bossDirty = true; } });
    on('boss:dead', () => this._onBossDead());
    on('hint:show', (p) => { if (p) this.showHint(p.id, p.text); });
    on('level:complete', (p) => this._copyComplete(p));
    on('level:failed', (p) => this._copyFailed(p));
    on('endless:end', (p) => this._copyEndless(p));
    on('quality:change', (p) => {
      const b = !!(p && p.params && p.params.blur);
      if (b !== this._blur) { this._blur = b; this._htmlDirty = true; }
    });
    on('settings:change', (p) => {
      if (p && (p.key === 'largeText' || p.key === 'reducedMotion' || p.key === 'hcGates')) this._htmlDirty = true;
    });
    on('error', (p) => {
      if (!p) return;
      if (p.fatal) this.showError(p.message, true);       // the loop may be dead: show now
      else this._pendingErr = typeof p.message === 'string' && p.message ? p.message : STRINGS.errors.generic;
    });
  }

  _probeMedia() {
    try {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (mq) {
          this._mq = mq;
          this._mqReduced = !!mq.matches;
          if (typeof mq.addEventListener === 'function') mq.addEventListener('change', this._onMqChange);
          else if (typeof mq.addListener === 'function') mq.addListener(this._onMqChange);
        }
      }
    } catch (_) { this._mq = null; this._mqReduced = false; }
  }

  _mediaChanged() {
    this._mqReduced = this._mq ? !!this._mq.matches : prefersReducedMotion();
    this._htmlDirty = true;
  }

  _settings() {
    const save = this.ctx.save;
    let s = null;
    try { s = save ? save.settings : null; } catch (_) { s = null; }
    return s || DEFAULT_SETTINGS;
  }

  /** settings → <html> classes (§10.2): large-text, reduced-motion (null follows the media query), hc-gates, blur (High tier). */
  _applyHtmlClasses() {
    this._htmlDirty = false;
    const doc = this._doc;
    if (!doc || !doc.documentElement) return;
    const s = this._settings();
    const reduced = s.reducedMotion === null || s.reducedMotion === undefined ? this._mqReduced : !!s.reducedMotion;
    this._reduced = reduced;
    const cl = doc.documentElement.classList;
    try {
      cl.toggle('reduced-motion', reduced);
      cl.toggle('large-text', !!s.largeText);
      cl.toggle('hc-gates', !!s.hcGates);
      cl.toggle('blur', this._blur);
    } catch (_) { /* ignore */ }
    this._coinPosDirty = true;
    this._puPosDirty = true;
  }

  _probeFullscreen() {
    if (this.ctx.config && this.ctx.config.isArtifact) return false;     // §15.2: the artifact shell never offers fullscreen
    try {
      const d = this._doc;
      const root = d.documentElement;
      const enabled = !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (!enabled || typeof req !== 'function') return false;
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        const mq = window.matchMedia('(display-mode: fullscreen)');
        if (mq && mq.matches) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Public API (§6.14)
  // -------------------------------------------------------------------------------------------

  /** Boot bar (main maps render's own 0..1 into its range); monotonic. Captions follow the running step
   *  (setBootCaption); until main calls it they follow main's step boundaries (BOOT_STEP_AT), not the fraction.
   *  Round-3 boot polish: the fill is a full-width strip sliding inside the bar's rounded clip (transform
   *  translateX(f − 100 %), compositor-only — the UI-22 HUD progress technique): a width write re-laid out and
   *  re-rastered the bar every boot frame, and some of those rasters needed new Skia shaders that compiled behind the
   *  shader warm-up (one 0.23 s frozen frame at 4× CPU throttling). #boot-bar's aria-valuenow carries the percent. */
  setBootProgress(t01) {
    if (!this._el || !this._txFill) return;
    const f = Number.isFinite(t01) ? clamp(t01, 0, 1) : 0;
    if (f < this._bootProgress) return;
    this._bootProgress = f;
    const fill = this._el.bootFill;
    if (fill) {
      // UI-29: the markup's .creep class animates 0 → 4 % while the module graph downloads; real progress takes over
      try { if (fill.classList.contains('creep')) fill.classList.remove('creep'); } catch (_) { /* ignore */ }
      fill.style.transform = this._txFill[Math.round(f * PCT_STEPS)];
    }
    const bar = this._el.bootBar;
    const pct = Math.round(f * 100);
    if (bar && pct !== this._bootPct) {
      this._bootPct = pct;
      try { bar.setAttribute('aria-valuenow', String(pct)); } catch (_) { /* ignore */ }
    }
    if (!this._bootCaptionSet) {
      let k = 0;
      while (k < BOOT_STEP_AT.length && f >= BOOT_STEP_AT[k]) k++;
      this._writeBootCaption(k);
    }
  }

  /** UI-29: caption of the boot step that is running now (STRINGS.boot.steps: page, textures, models, audio,
   *  systems, shaders). Main calls it at each step; from the first call on, setBootProgress no longer picks captions. */
  setBootCaption(index) {
    this._bootCaptionSet = true;
    this._writeBootCaption(Number.isFinite(index) ? index | 0 : 0);
  }

  _writeBootCaption(k) {
    const steps = STRINGS.boot.steps;
    const node = this._el ? this._el.bootText : null;
    if (!steps || steps.length === 0 || !node) return;
    const i = clamp(k, 0, steps.length - 1);
    if (i === this._bootStep) return;
    this._bootStep = i;
    node.textContent = steps[i];
  }

  /** Boot step 10: the boot screen leaves when the first state screen is applied (next update), never earlier —
   *  and never before the UI-19 prewarm finished (run here, holding the boot screen, if main did not await it). */
  hideBoot() {
    this.setBootProgress(1);
    this._setupIcons();
    if (!this._prewarmDone) {
      this._bootHideReq = true;
      this.prewarm();
      return;
    }
    this._bootHiding = true;
  }

  /**
   * UI-19 / UI-21 / UI-23: lays out and paints every first-use DOM surface behind #scr-boot so their first raster
   * (Skia shaders, glyphs, images), layout and the canvas encodes happen during boot instead of on their first
   * appearance: results (stars, title, chips with sample content), game over, endless results, levels (the grid is
   * built here), shop (card icons drawn here), settings, pause, the HUD with the boss bar, name card, letterbox, hint
   * and a power-up pill. Elements get .prewarm (css: displayed, opacity 0.01, no pointer events) — their `hidden`
   * attributes are never touched, so a concurrent showScreen stays authoritative.
   *
   * Round-3 boot polish (VIS-17 / CORE-9): the work runs as a list of steps (_prewarmSteps), one animation frame at a
   * time — JS-only steps (icon encodes, bitmaps) batch up to PREWARM_BUDGET_MS per frame, and a step that shows a
   * surface ends its frame — and each surface stays displayed for PREWARM_SHOW_FRAMES frames (its commit has been
   * rastered and activated by then) before its .prewarm comes off. Doing it all in one frame froze the boot bar for
   * ≈ 0.6 s at 4× CPU throttling (≈ 0.26 s of JS, then style / layout / paint of every surface at once) and queued
   * ≈ 0.5 s of GPU raster behind it. Each frame waits for rAF or PREWARM_FALLBACK_MS (hidden / throttled tab), so
   * the prewarm always ends. `onProgress(t)` (optional, 0..1, monotonic) after each frame's work. Idempotent: a later
   * call returns the same promise.
   */
  prewarm(onProgress) {
    if (this._prewarmP) return this._prewarmP;
    const el = this._el;
    if (!el || !this._doc) { this._prewarmDone = true; this._prewarmP = Promise.resolve(); return this._prewarmP; }
    this._bootHold = true;
    const steps = this._prewarmSteps();   // [run, weight] pairs, flattened
    let total = 0;
    for (let i = 1; i < steps.length; i += 2) total += steps[i];
    this._prewarmP = new Promise((resolve) => {
      const shown = [];                   // [node, frame it was shown in] pairs, retired after PREWARM_SHOW_FRAMES
      let next = 0, frame = 0, seq = 0, done = false, workDone = 0;
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
      const report = (t) => { if (typeof onProgress === 'function') { try { onProgress(t); } catch (_) { /* cosmetic */ } } };
      const finish = () => {
        if (done) return;
        done = true;
        for (let i = 0; i < shown.length; i += 2) { try { shown[i].classList.remove('prewarm'); } catch (_) { /* ignore */ } }
        shown.length = 0;
        this._prewarmRestore();
        this._prewarmDone = true;
        this._bootHold = false;
        if (this._bootHideReq) { this._bootHideReq = false; this._bootHiding = true; }
        report(1);
        resolve();
      };
      const schedule = (fn) => {
        const my = ++seq;
        const run = () => { if (my === seq && !done) fn(); };
        try { if (raf) raf(run); } catch (_) { /* the timeout below runs it */ }
        try { setTimeout(run, PREWARM_FALLBACK_MS); } catch (_) { run(); }
      };
      const tick = () => {
        frame++;
        // retire the surfaces shown PREWARM_SHOW_FRAMES frames ago (pairs stay in show order); a node a later step
        // showed again (the #hud parent of both HUD steps) keeps .prewarm until its last entry retires
        while (shown.length > 0 && frame - shown[1] >= PREWARM_SHOW_FRAMES) {
          const n = shown[0];
          let again = false;
          for (let i = 2; i < shown.length; i += 2) if (shown[i] === n) { again = true; break; }
          if (!again) { try { n.classList.remove('prewarm'); } catch (_) { /* ignore */ } }
          shown.splice(0, 2);
        }
        if (next < steps.length) {
          const t0 = this._realNow();
          do {
            let nodes = null;
            try { nodes = steps[next](); } catch (_) { nodes = null; }
            workDone += steps[next + 1];
            next += 2;
            if (nodes) {
              for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                if (!n) continue;
                try { n.classList.add('prewarm'); shown.push(n, frame); } catch (_) { /* ignore */ }
              }
              break;                      // one surface per frame: its style / layout / paint / raster are this frame's
            }
          } while (next < steps.length && (this._realNow() - t0) * 1000 < PREWARM_BUDGET_MS);
          report(PREWARM_STEPS_SHARE * (total > 0 ? workDone / total : 1));
        } else if (shown.length === 0) {
          finish();
          return;
        }
        schedule(tick);
      };
      schedule(tick);
    });
    return this._prewarmP;
  }

  /**
   * The prewarm's work list (round 3) as flattened [run, weight] pairs: each run() returns null (JS only) or the
   * surfaces it filled with sample content, which the runner shows for PREWARM_SHOW_FRAMES frames; the weight is its
   * share of the reported progress (1, or PREWARM_SHOW_WEIGHT for a surface). The result bitmaps come first (their
   * toBlob encodes finish off-thread while the icons encode), the results screen right after them (UI-19's worst
   * first show), then the other screens, the title and the HUD last. Boot only (allocates the step closures).
   */
  _prewarmSteps() {
    const el = this._el;
    const S = this._screens;
    const W = PREWARM_SHOW_WEIGHT;
    const steps = [];
    for (let k = 0; k < 3; k++) steps.push(() => { this._buildResultBitmap(k); return null; }, 1);
    steps.push(() => { if (this._htmlDirty) this._applyHtmlClasses(); this._setupIcons(); return null; }, 1);   // html.blur (High tier) too
    // UI-23: every item icon the pills / shield / coin pill can use is encoded once at boot (no toDataURL in play)
    const ids = RENDER.icons && RENDER.icons.ofItem ? Object.keys(RENDER.icons.ofItem) : [];
    for (let i = 0; i < ids.length; i++) { const id = ids[i]; steps.push(() => { this._iconUrl(id); return null; }, 1); }
    // round 6: the FIRE button's larger pictograms (one per weapon), encoded at boot too
    for (let i = 0; i < FIRE_WEAPON_IDS.length; i++) { const id = FIRE_WEAPON_IDS[i]; steps.push(() => { this._fireIconUrl(id); return null; }, 1); }
    steps.push(() => {
      const c = this._cmp;
      // one earned + two empty stars: both star images get rastered
      c.level = 1; c.stars = 1; c.coins = 340; c.survivors = 20; c.kills = 120; c.gates = 60; c.piles = 30; c.boss = 40; c.bonus = 20;
      this._cmpFresh = false;
      this._enterComplete();
      this._cmpAnimating = false;
      // round 3: the earned star also runs the J17 slam (KF_STAR, from 3× scale) — the first real reveal composites and
      // rasters the star layer at that scale, a 60–70 ms frame at 4× CPU throttling right after the results appear
      const st = el.stars;
      if (st && st.length > 0) this._prewarmStarAnim = this._animate(st[0], KF_STAR, T_STAR);
      return [S.complete];
    }, W);
    steps.push(() => { this._fillGameover(); return [S.gameover]; }, W);
    steps.push(() => { this._fillEndless(); return [S.endless]; }, W);
    steps.push(() => { this._fillLevels(false); return [S.levels]; }, W);
    for (let i = 0; i < UPGRADE_IDS.length; i++) { const id = UPGRADE_IDS[i]; steps.push(() => { this._drawCardIcon(id); return null; }, 1); }
    steps.push(() => { this._fillShop(); return [S.shop]; }, W);
    steps.push(() => { this._syncSettings(); return [S.settings]; }, W);
    steps.push(() => [S.pause], W);
    // round 3: the title (the logo's six drop-shadow filters, the PLAY ring) is the first screen after boot — warm its
    // raster too. Sample caption / coins only: _fillTitle() would spend the one-time volatile-save caption
    steps.push(() => {
      if (el.titleCaption) el.titleCaption.textContent = STRINGS.title.caption(1, 3);
      if (el.titleCoinsValue) el.titleCoinsValue.textContent = fmtCoins(0);
      return [S.title];
    }, W);
    // the HUD in two surfaces (both keep their #hud parent displayed): the boss chrome, then hint / shield / pill —
    // the whole HUD in one frame was the prewarm's heaviest raster (≈ 0.3 s on a loaded host at 4×)
    steps.push(() => {
      if (el.bossName) el.bossName.textContent = STRINGS.boss.label;
      if (el.ncName) el.ncName.textContent = STRINGS.boss.label;
      // round 5 integration (r5-perf-audio needsOtherGroup 2): the boss chrome's own entry animations run here once too — the
      // bar's slide-down, the two letterbox bars and the name card's pop-in — like the pill and the banner below, so the
      // boss arrival frame is not their first animation / composite (cancelled by _prewarmRestore)
      const a = this._prewarmBossAnims;
      a.push(this._animate(el.bossbar, KF_SLIDE_DOWN, T_BOSS_IN), this._animate(el.letterbox, KF_LB_TOP, T_LETTERBOX),
        this._animate(el.letterboxBottom, KF_LB_BOTTOM, T_LETTERBOX), this._animate(el.namecard, KF_POP_IN, T_NAMECARD));
      return [el.hud, el.bossbar, el.namecard, el.letterbox, el.letterboxBottom];
    }, W);
    steps.push(() => {
      if (el.hintText) el.hintText.textContent = HINTS.shoot || '';
      if (el.hintHand) el.hintHand.hidden = false;
      if (el.shieldValue) el.shieldValue.textContent = STRINGS.hud.shield(3);
      const pu = this._puEls ? this._puEls[0] : null;
      if (pu) {
        const id = 'weapon.minigun';
        this._applyIcon(pu.icon, this._iconUrl(id));
        const rings = this._ringStrings(id);
        pu.ring.style.background = rings[RING_STEPS >> 1];
        pu.time.textContent = this._secs[9];
        // the first real pill pops in with KF_POP_IN: that transform / opacity animation composites the pill on a
        // layer of its own, with the ring's mask and the icon's drop-shadow. Run the same animation here, behind the
        // boot screen, or that first raster / composite is a ≈ 48 ms GPU flush at the first pickup (round-2 release
        // verification: desktop and artifact shells; a static prewarm does not cover the animated path)
        this._prewarmAnim = this._animate(pu.root, KF_POP_IN, T_NAMECARD);
      }
      // round 5: the district banner (a composited pill with an accent rule) runs its real animation here too
      const db = el.districtBanner;
      if (db) {
        if (el.dbText) el.dbText.textContent = DISTRICTS[DISTRICTS.length - 1].label;
        try { db.style.setProperty('--db-accent', hexCss(DISTRICTS[0].accent)); db.style.setProperty('--db-glow', rgbaCss(DISTRICTS[0].accent, DB_GLOW_ALPHA)); } catch (_) { /* cosmetic */ }
        if (typeof db.animate === 'function') { try { this._prewarmDbAnim = db.animate(KF_DB, T_DB); } catch (_) { this._prewarmDbAnim = null; } }
      }
      // round 6: the FIRE button (ring mask, disc, pictogram, badge and its ready pulse) rasters here, not at the first pickup
      if (el.btnFire) {
        this._applyIcon(el.fireIcon, this._fireIconUrl(WEAPONS.rocket.id));
        if (el.fireRing) el.fireRing.style.background = this._ringStrings(WEAPONS.rocket.id)[RING_STEPS];
        if (el.fireBadge) { el.fireBadge.textContent = STRINGS.fire.badge(2); el.fireBadge.hidden = false; }
        try { el.btnFire.classList.add('ready'); } catch (_) { /* cosmetic */ }
      }
      return [el.hud, el.hint, el.shield, pu ? pu.root : null, db, el.btnFire];
    }, W);
    return steps;
  }

  /** Undo the sample content that a later show would not overwrite by itself. */
  _prewarmRestore() {
    const el = this._el;
    this._cmp.stars = 0; this._cmp.coins = 0;
    if (el.bossName) el.bossName.textContent = this._bossName;
    if (el.hintText) el.hintText.textContent = '';
    if (el.shieldValue) el.shieldValue.textContent = '';
    this._platesShown = -1;
    this._puShownId[0] = '';
    this._puRing[0] = -1;
    this._puSec[0] = -1;
    // round 6: the sample FIRE button content is rewritten by the first real show
    this._fireId = ''; this._fireRingId = ''; this._fireRing = -1; this._fireCount = -1; this._fireBusy = -1;
    if (this._el.btnFire) { try { this._el.btnFire.classList.remove('ready'); } catch (_) { /* cosmetic */ } }
    if (this._prewarmAnim) { this._cancelAnim(this._prewarmAnim); this._prewarmAnim = null; }
    if (this._prewarmStarAnim) { this._cancelAnim(this._prewarmStarAnim); this._prewarmStarAnim = null; }
    if (this._prewarmDbAnim) { this._cancelAnim(this._prewarmDbAnim); this._prewarmDbAnim = null; }
    for (let i = 0; i < this._prewarmBossAnims.length; i++) this._cancelAnim(this._prewarmBossAnims[i]);
    this._prewarmBossAnims.length = 0;
    this._dbShownLabel = '';                        // round 5: the sample banner text / accent are rewritten on the first real show
    this._dbShownAccent = -1;
  }

  /**
   * UI-19: results art drawn once at boot into bitmaps (blob URLs set as css custom properties on #scr-complete):
   *   --rays       the sunburst (rays + radial fade), only rotated on its own composited layer afterwards — the
   *                masked repeating-conic-gradient re-rastered on first show (≈ 255 ms GPU flush);
   *   --star-empty / --star-on   the result stars — vector stars (clip-path, then SVG) still cost 40–100 ms of GPU
   *                raster on the first results screen; a PNG costs a ~2 ms decode.
   * Without canvas the css fallbacks (glow / SVG stars) stay. Round 3: one bitmap per call (k = 0 sunburst, 1 empty
   * star, 2 earned star), so the boot prewarm spreads them over its frames; each is built once.
   */
  _buildResultBitmap(k) {
    const bit = 1 << k;
    if ((this._bitmapsReq & bit) !== 0 || !this._doc) return;
    const scr = this._screens ? this._screens.complete : null;
    if (!scr) return;
    this._bitmapsReq |= bit;
    if (k === 0) this._bitmapVar(scr, '--rays', 512, (g, px) => {      // DATA-MISSING: JUICE.ui.raysPx — bitmap size (shown at 620 design px)
      const r = px / 2, rays = 20;                    // 18° period, 9° rays (the old 0–9° / 9–18° conic pattern)
      g.fillStyle = rgbaCss(PALETTE.ui.coin, 0.13);
      for (let i = 0; i < rays; i++) {
        const a0 = (i / rays) * Math.PI * 2, a1 = a0 + Math.PI / rays;
        g.beginPath(); g.moveTo(r, r); g.arc(r, r, r, a0, a1); g.closePath(); g.fill();
      }
      g.globalCompositeOperation = 'destination-in';  // the old mask: opaque to 15 %, fading out at the edge
      const grad = g.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(0.15, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, px, px);
    });
    const star = (on) => (g, px) => {
      const P = STAR_POINTS;
      const path = (inset) => {
        const k = (1 - 2 * inset) * px / 100, o = inset * px;
        g.beginPath();
        for (let i = 0; i < P.length; i += 2) { const x = o + P[i] * k, y = o + P[i + 1] * k; if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
        g.closePath();
      };
      g.lineJoin = 'round';
      path(0); g.fillStyle = OUTLINE; g.fill();
      const lin = g.createLinearGradient(0, 0.11 * px, 0, 0.89 * px);
      if (on) { lin.addColorStop(0, hexCss(PALETTE.ui.coinHi !== undefined ? PALETTE.ui.coinHi : 0xFFF3B0)); lin.addColorStop(0.45, hexCss(PALETTE.ui.coin)); lin.addColorStop(1, '#FF9A1F'); }
      else { lin.addColorStop(0, '#3B4560'); lin.addColorStop(1, '#232A3C'); }
      path(0.11); g.fillStyle = lin; g.fill();
      if (on) {
        const gl = g.createLinearGradient(0.2 * px, 0.1 * px, 0.5 * px, 0.6 * px);
        gl.addColorStop(0, 'rgba(255,255,255,0.75)'); gl.addColorStop(0.55, 'rgba(255,255,255,0)');
        g.fillStyle = gl; g.fill();
      }
    };
    if (k === 1) this._bitmapVar(scr, '--star-empty', 256, star(false));   // DATA-MISSING: JUICE.ui.starPx — bitmap size (88 design px × dpr)
    else if (k === 2) this._bitmapVar(scr, '--star-on', 256, star(true));
  }

  /** Draws `draw(g, px)` into a px² canvas and sets `url(blob…)` (toBlob is async: no main-thread PNG encode;
   *  toDataURL fallback) as the css custom property `name` on `host`. Blob URLs are revoked in dispose(). */
  _bitmapVar(host, name, px, draw) {
    let c = null;
    try {
      c = this._doc.createElement('canvas');
      c.width = px; c.height = px;
      // round 3: a CPU-backed canvas — a 256–512 px canvas is GPU-accelerated by default, and its toBlob then starts
      // with a synchronous GPU read-back on the main thread (the 2 MB sunburst was the prewarm's slowest JS step)
      const g = c.getContext('2d', CANVAS_CPU);
      if (!g) return;
      draw(g, px);
    } catch (_) { return; }
    const apply = (url) => {
      if (!url || !this._screens) return;
      if (url.indexOf('blob:') === 0) this._blobUrls.push(url);
      try { host.style.setProperty(name, 'url("' + url + '")'); } catch (_) { /* cosmetic */ }
    };
    try {
      if (typeof c.toBlob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        c.toBlob((b) => { if (b) { try { apply(URL.createObjectURL(b)); } catch (_) { /* cosmetic */ } } }, 'image/png');
      } else {
        apply(c.toDataURL('image/png'));
      }
    } catch (_) { /* the css fallback stays */ }
  }

  /**
   * Shows one screen (null = HUD only, closes every overlay). Non-overlay screens are exclusive; 'settings'
   * stacks over the screen it was opened from ('pause' is replaced while settings is open). Sets `hidden`,
   * builds the screen's content, restarts the .enter fade (skipped under reduced motion), moves focus to the
   * first control, emits ui:screen and marks the scene dirty for the paused redraw.
   */
  showScreen(id, data) {
    if (!this._el) return;
    const target = id === undefined || id === null ? null : id;
    if (target !== null && SCREEN_EL_ID[target] === undefined) return;
    const prev = this._current;
    if (data) {
      if (target === 'complete') { this._copyComplete(data); this._cmpFresh = true; }
      else if (target === 'gameover') this._copyFailed(data);
      else if (target === 'endless') this._copyEndless(data);
    }
    if (target === 'settings' && prev !== 'settings') this._beforeSettings = prev;
    const base = target === 'settings' ? this._beforeSettings : target;
    const screens = this._screens;
    for (let i = 0; i < SCREEN_IDS.length; i++) {
      const sid = SCREEN_IDS[i];
      const node = screens[sid];
      if (!node) continue;
      let vis = sid === target;
      let under = false;
      if (!vis && target === 'settings' && sid === base && sid !== 'pause' && sid !== 'boot') { vis = true; under = true; }
      if (!vis && sid === 'boot' && this._bootHold) vis = true;     // UI-19: the boot screen covers the prewarm
      if (node.hidden === vis) node.hidden = !vis;
      // round-3 polish: the screen under the settings overlay hides its content (css .screen.under)
      try { if (node.classList.contains('under') !== under) node.classList.toggle('under', under); } catch (_) { /* ignore */ }
    }
    this._bootHiding = false;
    const hudVis = base === null || HUD_UNDER[base] === true;
    const hud = this._el.hud;
    if (hud && hud.hidden === hudVis) hud.hidden = !hudVis;
    this._hudVisible = hudVis;
    // round-3 polish: under the results screens the HUD keeps only its coin pill (css #hud.results)
    const results = base === 'complete' || base === 'gameover' || base === 'endless';
    if (hud) { try { if (hud.classList.contains('results') !== results) hud.classList.toggle('results', results); } catch (_) { /* ignore */ } }
    if (this._el.btnPause) this._el.btnPause.hidden = target !== null;
    // debug overlay: on phones it docks in the in-game thumb zone; over a menu / results panel (whose
    // buttons live there) css hides it via .menu so it never covers what QA screenshots judge (UI-15)
    if (this.debugPanel) { try { this.debugPanel.classList.toggle('menu', target !== null); } catch (_) { /* ignore */ } }
    if (target === null && this._el.overlayMsg) this._el.overlayMsg.hidden = true;
    if (target !== 'settings' && this._confirmArmed) this._disarmReset();
    this._current = target;

    switch (target) {
      case 'title': this._fillTitle(); break;
      case 'levels': this._fillLevels(true); break;
      case 'shop': this._fillShop(); break;
      case 'settings': this._syncSettings(); break;
      case 'complete': this._enterComplete(); break;
      case 'gameover': this._fillGameover(); break;
      case 'endless': this._fillEndless(); break;
      default: break;
    }
    if (target === 'complete' || target === 'gameover' || target === 'endless') {
      // the run's coins are final now (game over keeps only ECONOMY.gameOverKeep): settle the HUD pill
      const save = this.ctx.save;
      if (save && save.data) { this._coinTotal = save.data.coins; this._coinHold = false; this._tweenCoins(save.data.coins); }
    }

    // UI-21: no fade restart here (.enter replays by itself on display:none → shown); focus moves at the start of
    // the next update(), when style is clean, instead of flushing style + layout inside this frame
    const shown = target === null ? this._el.hud : screens[target];
    if (target !== prev) this._focusPending = target === null ? this._el.app : (shown || null);
    if (target !== null && target !== 'pause' && target !== 'settings') this._hintQueueClear(true);   // UI-25: quit / results / menus

    this._coinPosDirty = true;
    this._puPosDirty = true;
    P_SCREEN.id = target;
    P_SCREEN.prev = prev;
    const events = this.ctx.events;
    if (events) events.emit('ui:screen', P_SCREEN);
    const render = this.ctx.render;
    if (render) render.dirty = true;
  }

  /** Writes the unitless --ui custom property from #app's box (§10.2); called by init() and render.resize(). */
  refit() {
    const doc = this._doc;
    if (!doc || !doc.documentElement) return;
    const app = this._el ? this._el.app : null;
    let w = app ? app.clientWidth : 0, h = app ? app.clientHeight : 0;
    if (!(w > 0 && h > 0)) {
      try { w = window.innerWidth; h = window.innerHeight; } catch (_) { w = REF_W; h = REF_H; }
      if (!(w > 0 && h > 0)) { w = REF_W; h = REF_H; }
    }
    const s = clamp(Math.min(w / REF_W, h / REF_H), UI_MIN, UI_MAX);
    const str = s.toFixed(3);
    if (str !== this._uiScaleStr) {
      this._uiScaleStr = str;
      try { doc.documentElement.style.setProperty('--ui', str); } catch (_) { /* ignore */ }
    }
    this._uiScale = s;
    this._appW = w;
    this._appH = h;
    this._coinPosDirty = true;
    this._puPosDirty = true;
    if (!this._ro) this._shieldW = 0;  // without the ResizeObserver the shield pill is re-measured at the new --ui
  }

  /** Fatal: box with RELOAD, stays (idempotent for a repeated message). Non-fatal: toast without RELOAD for 6 s. */
  showError(message, fatal) {
    const el = this._el;
    const msg = typeof message === 'string' && message.length > 0 ? message : (fatal ? STRINGS.errors.fatal : STRINGS.errors.generic);
    if (!el || !el.errorBox) return;
    if (fatal) {
      if (this._fatalShown && msg === this._fatalMsg) return;
      this._fatalShown = true;
      this._fatalMsg = msg;
      if (this._errorTimer) { try { clearTimeout(this._errorTimer); } catch (_) { /* ignore */ } this._errorTimer = 0; }
      if (el.errorText) el.errorText.textContent = msg;
      if (el.btnReload) el.btnReload.hidden = false;
      try { el.errorBox.classList.add('fatal'); el.errorBox.classList.remove('toast'); } catch (_) { /* ignore */ }
      el.errorBox.hidden = false;
      if (el.btnReload) { try { el.btnReload.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
      return;
    }
    if (this._fatalShown) return;                 // never cover a fatal box with a toast
    if (el.errorText) el.errorText.textContent = msg;
    if (el.btnReload) el.btnReload.hidden = true;
    try { el.errorBox.classList.add('toast'); el.errorBox.classList.remove('fatal'); } catch (_) { /* ignore */ }
    el.errorBox.hidden = false;
    if (this._errorTimer) { try { clearTimeout(this._errorTimer); } catch (_) { /* ignore */ } }
    try { this._errorTimer = setTimeout(this._onErrorTimeout, ERROR_HIDE_MS); } catch (_) { this._errorTimer = 0; }
  }

  /** Full-screen colour flash (fx J5/J15/J16/J21; reduced motion: fx passes a 150 ms dim). Stored; drawn in update(). */
  flash(colorHex, seconds, alpha) {
    const hex = Number.isFinite(colorHex) ? colorHex >>> 0 : PALETTE.flash.white;
    if (hex !== this._flashHex) { this._flashHex = hex; this._flashCss = hexCss(hex); this._flashCssDirty = true; }
    this._flashA0 = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
    this._flashDur = Number.isFinite(seconds) && seconds > 0 ? seconds : JUICE.flashes.bossPhase;
    this._flashT = 0;
    this._flashOn = true;
  }

  /** Edge vignette in a colour (damage / negative gate / chew), fading out over `seconds`. */
  vignette(colorHex, seconds) {
    const hex = Number.isFinite(colorHex) ? colorHex >>> 0 : PALETTE.flash.red;
    if (hex !== this._vigHex) {
      this._vigHex = hex;
      this._vigCss = 'radial-gradient(ellipse at center, ' + rgbaCss(hex, 0) + ' 45%, ' + rgbaCss(hex, VIGNETTE_ALPHA) + ' 100%)';
      this._vigCssDirty = true;
    }
    this._vigDur = Number.isFinite(seconds) && seconds > 0 ? seconds : JUICE.flashes.negVignette;
    this._vigT = 0;
    this._vigOn = true;
  }

  /**
   * Tutorial hint (hint:show). UI-25: queued — at most JUICE.ui.hintQueueMax waiting (the oldest is dropped when
   * full), de-duplicated by id (on screen or waiting), dropped when older than HINT_QUEUE_AGE_S theatre seconds or
   * when the run ends; each is shown for 2.5 s (real time, paused time excluded) in turn and marked done in the
   * save only when it is actually displayed. 'steer' also hides as soon as the player has steered.
   */
  showHint(id, text) {
    const hid = typeof id === 'string' ? id : '';
    let t = typeof text === 'string' ? text : (HINTS[hid] || '');
    // UI-16: with a mouse / keyboard the steer hint names the keys too (A/D/←/→ steer, ARCH §6.2)
    if (hid === 'steer' && HINTS.steerDesktop && prefersDesktopSteerHint()) t = HINTS.steerDesktop;
    if (!t) return;
    if (hid) {
      if (this._hintShown && this._hintId === hid) return;
      for (let i = 0; i < this._hqLen; i++) if (this._hqId[i] === hid) return;
    }
    const max = this._hqId.length;
    if (max <= 0) return;
    if (this._hqLen >= max) this._hintQueueShift();
    const k = this._hqLen++;
    this._hqId[k] = hid;
    this._hqText[k] = t;
    this._hqAt[k] = this._tclock;
  }

  /** Hides the hint on screen and drops the waiting ones (they stay un-marked, so a later run shows them). */
  hideHint() {
    this._hintQueueClear(true);
  }

  /** Centre of the HUD coin icon in CSS px relative to #app (coin-flight target, cached until layout changes). */
  coinIconScreenPos(out) {
    if (!out) return out;
    if (this._coinPosDirty) this._measureCoin();
    out.x = this._coinX;
    out.y = this._coinY;
    return out;
  }

  /**
   * Target of an item's icon flight (J12): round 6 — a weapon flies into the FIRE button (stored, not started; the
   * button is synced first, so the one this pickup shows is measured where it is drawn); its power-up pill (chip,
   * booster), the shield pill (armor), the coin icon ('coins'), otherwise the centre of the power-up row (troops,
   * magnet). Pending pill DOM is synced first so a pill created by this same pickup is measured where it will be drawn.
   */
  powerupIconScreenPos(item, out) {
    if (!out) return out;
    if (item === 'coins') return this.coinIconScreenPos(out);
    if (this._puPosDirty) { this._puPosOk.fill(0); this._puPosDirty = false; }
    if (isWeaponId(item) && this._el && this._el.btnFire) {
      this._updateFire();
      if (this._fireShown) {
        if (!this._puPosOk[FIRE_POS]) this._measureInto(this._el.fireIcon || this._el.btnFire, FIRE_POS);
        if (this._puPosOk[FIRE_POS]) { out.x = this._puPos[FIRE_POS * 2]; out.y = this._puPos[FIRE_POS * 2 + 1]; return out; }
      }
    }
    let slot = -1;
    for (let i = 0; i < this._puCount; i++) if (this._puId[i] === item) { slot = i; break; }
    if (slot >= 0) {
      this._syncPills();
      if (!this._puPosOk[slot]) this._measureInto(this._puEls[slot].icon, slot);
      if (this._puPosOk[slot]) { out.x = this._puPos[slot * 2]; out.y = this._puPos[slot * 2 + 1]; return out; }
    } else if (item === 'gear.armor') {
      this._placeShield();
      this._syncShield();
      const k = MAX_PILLS;
      if (!this._puPosOk[k]) this._measureInto(this._el.shieldIcon || this._el.shield, k);
      if (this._puPosOk[k]) { out.x = this._puPos[k * 2]; out.y = this._puPos[k * 2 + 1]; return out; }
    }
    const g = MAX_PILLS + 1;
    if (!this._puPosOk[g]) this._measureInto(this._el.powerups, g);
    if (this._puPosOk[g]) { out.x = this._puPos[g * 2]; out.y = this._puPos[g * 2 + 1]; return out; }
    this._fallbackTop(out);
    return out;
  }

  /** Debug overlay text (engine, 4 Hz; multi-line). */
  setDebugText(text) {
    const panel = this.debugPanel;
    if (!panel) return;
    const t = typeof text === 'string' ? text : String(text);
    if (t === this._debugText) return;
    this._debugText = t;
    if (panel.hidden && this.ctx.config && this.ctx.config.debug) panel.hidden = false;
    panel.textContent = t;
  }

  /** RESET SAVE: the first tap arms "TAP AGAIN TO CONFIRM" for 3 s; a second tap at least JUICE.ui.confirmMinS
   *  later (UI-20: a double-tap / double-click is ignored) wipes the save and reloads (guarded). */
  confirmReset() {
    const btn = this._el ? this._el.btnResetSave : null;
    const t = this._realNow();
    if (!this._confirmArmed) {
      this._confirmArmed = true;
      this._confirmArmedAt = t;
      this._confirmUntil = this._clock + CONFIRM_S;
      if (btn) {
        btn.textContent = STRINGS.settings.confirmReset;
        try { btn.classList.add('confirm'); } catch (_) { /* ignore */ }
        this._animate(btn, KF_SHAKE, T_SHAKE);
      }
      return;
    }
    if (t - this._confirmArmedAt < CONFIRM_MIN_S) return;          // the second half of a double-tap: not deliberate
    this._disarmReset();
    const ctx = this.ctx;
    const save = ctx.save;
    if (save && typeof save.reset === 'function') {
      try { save.reset(); } catch (_) { /* the reload below still runs */ }
    }
    // push the default settings to every listener (audio volumes, engine quality/sensitivity, render, fx)
    const s = this._settings();
    const keys = Object.keys(DEFAULT_SETTINGS);
    for (let i = 0; i < keys.length; i++) this._emitSetting(keys[i], s[keys[i]] !== undefined ? s[keys[i]] : DEFAULT_SETTINGS[keys[i]]);
    this._applyHtmlClasses();
    this._syncSettings();
    this._saveDirty = true;
    try { if (typeof location !== 'undefined' && location && typeof location.reload === 'function') location.reload(); } catch (_) { /* sandboxed: the in-memory reset above already applied */ }
  }

  /** Blocking message (context loss): #overlay-msg above everything. */
  showOverlay(text) {
    const el = this._el;
    if (!el || !el.overlayMsg) return;
    if (el.overlayText) el.overlayText.textContent = typeof text === 'string' && text ? text : STRINGS.reloadingGfx;
    el.overlayMsg.hidden = false;
    const render = this.ctx.render;
    if (render) render.dirty = true;
  }

  hideOverlay() {
    const el = this._el;
    if (!el || !el.overlayMsg) return;
    el.overlayMsg.hidden = true;
  }

  /** Extra (fx J19): 1.2× punch of the HUD coin icon when a flying coin lands. */
  punchCoinIcon() {
    if (this._el && this._el.coinIcon) this._animate(this._el.coinIcon, KF_PUNCH, T_PUNCH);
  }

  // -------------------------------------------------------------------------------------------
  // Event stores (listeners only copy values and set dirty bits, §5)
  // -------------------------------------------------------------------------------------------

  _mapState(name, data) {
    switch (name) {
      case 'boot': return 'boot';
      case 'title': return 'title';
      case 'levels': return 'levels';
      case 'shop': return 'shop';
      case 'playing': return null;
      case 'paused': return 'pause';
      case 'complete': return (data ? !!data.endless : this._lastCompleteEndless) ? 'endless' : 'complete';
      case 'gameover': return 'gameover';
      default: return this._current;
    }
  }

  _onState(p) {
    if (!p) return;
    const to = p.to, data = p.data;
    if (to !== 'playing' && to !== 'paused') {
      this._hintQueueClear(false);                  // UI-25: queued hints never outlive the run
      this._dbReq = false;                          // round 5: nor does the district banner (DISTRICTS.md §5)
      this._dbHideReq = true;
    }
    if (to === 'complete' && data) {
      if (data.endless) this._copyEndless(data);
      else { this._copyComplete(data); this._cmpFresh = true; }
    } else if (to === 'gameover' && data) {
      this._copyFailed(data);
    }
    this._pendingId = this._mapState(to, data);
    this._pendingSet = true;
  }

  _copyComplete(p) {
    if (!p) return;
    const c = this._cmp;
    if (Number.isFinite(p.level)) c.level = p.level;
    if (Number.isFinite(p.stars)) c.stars = clamp(p.stars | 0, 0, 3);
    if (Number.isFinite(p.coins)) c.coins = p.coins;
    if (Number.isFinite(p.survivors)) c.survivors = p.survivors;
    if (Number.isFinite(p.eBoss)) c.eBoss = p.eBoss;
    if (Number.isFinite(p.score)) c.score = p.score;
    const b = p.breakdown;
    if (b) { c.kills = b.kills | 0; c.gates = b.gates | 0; c.piles = b.piles | 0; c.boss = b.boss | 0; c.bonus = b.bonus | 0; }
    this._lastCompleteEndless = false;
  }

  _copyFailed(p) {
    if (!p) return;
    const f = this._fail;
    if (Number.isFinite(p.level)) f.level = p.level;
    if (Number.isFinite(p.fraction)) f.fraction = p.fraction;
    if (Number.isFinite(p.coinsKept)) f.coinsKept = p.coinsKept;
  }

  _copyEndless(p) {
    if (!p) return;
    const e = this._end;
    if (Number.isFinite(p.distance)) e.distance = p.distance;
    if (Number.isFinite(p.score)) e.score = p.score;
    if (Number.isFinite(p.best)) e.best = p.best;
    if (Number.isFinite(p.coins)) e.coins = p.coins;
    if (Number.isFinite(p.chunks)) e.chunks = p.chunks;
    e.newBest = !!p.newBest;
    this._lastCompleteEndless = true;
  }

  _tweenCoins(total) {
    this._coinFrom = this._coinValue;
    this._coinTo = total;
    this._coinT = 0;
    this._coinTween = true;
  }

  _onLevelStart(p) {
    if (!p) return;
    this._runLevel = Number.isFinite(p.level) ? p.level : 1;
    this._runEndless = !!p.endless;
    // round 5 (DISTRICTS.md §5): a run start clears any banner; the run's own district:change follows this event
    this._runDistrict = typeof p.district === 'string' ? p.district : '';
    this._dbReq = false;
    this._dbHideReq = true;
    // round-3 FTUE: the level's best survivors before this run (−1 = never cleared), so the results line can name a new best
    const d0 = this._saveData();
    const r0 = !this._runEndless && d0 && d0.levels ? d0.levels[this._runLevel] : null;
    this._prevBest = r0 && Number.isFinite(r0.bestSurvivors) ? r0.bestSurvivors : -1;
    // progress ticks: special deliveries (crates, gate events with an item lane) at at/length (§10.3)
    let n = 0;
    const script = p.script;
    if (!this._runEndless && script && Array.isArray(script.events) && script.length > 0) {
      const evs = script.events;
      for (let i = 0; i < evs.length && n < MAX_TICKS; i++) {
        const ev = evs[i];
        let special = ev.type === 'crate';
        if (!special && ev.type === 'gates' && Array.isArray(ev.lanes)) {
          for (let k = 0; k < ev.lanes.length; k++) if (ev.lanes[k] && ev.lanes[k].op === 'item') { special = true; break; }
        }
        if (special) this._tickFrac[n++] = clamp(ev.at / script.length, 0, 1);
      }
    }
    this._tickCount = n;
    this._ticksDirty = true;
    this._progFrac = 0;
    this._progDirty = true;
    this._skullPulse = false;
    this._skullDirty = true;
    this._puCount = 0;
    this._plates = 0;
    this._bossShowPending = false;
    this._bossHideAt = 0;
    this._bossShieldUp = false;
    this._bossPhase = 1;
    this._bossFrac = 1;
    this._lbOn = false;
    this._ncPending = false;
    this._ncUntil = 0;
    this._hintQueueClear(true);                     // UI-25: level start clears the queue and hides the pill
    this._flashOn = false;
    this._vigOn = false;
    this._hudResetPending = true;
    const save = this.ctx.save;
    const coins = save && save.data ? save.data.coins : 0;
    this._coinFrom = coins; this._coinTo = coins; this._coinValue = coins; this._coinT = 0; this._coinTween = true;
    this._coinTotal = coins; this._coinHold = false;
  }

  /** weapon:start / gear:start with a finite duration: add a pill or refresh it (a new weapon replaces the old one). */
  _pillAdd(id, duration) {
    if (typeof id !== 'string' || !(duration > 0) || !Number.isFinite(duration)) return;
    let slot = -1;
    const weapon = isWeaponId(id);
    for (let i = 0; i < this._puCount; i++) {
      const cur = this._puId[i];
      if (cur === id || (weapon && isWeaponId(cur))) { slot = i; break; }
    }
    if (slot < 0) {
      if (this._puCount >= MAX_PILLS) {
        // full: drop the pill closest to expiry
        let best = 0;
        for (let i = 1; i < MAX_PILLS; i++) if (this._puLeft[i] < this._puLeft[best]) best = i;
        this._pillRemoveAt(best);
      }
      slot = this._puCount++;
    }
    this._puId[slot] = id;
    this._puDur[slot] = duration;
    this._puStart[slot] = this._clock;
    this._puLeft[slot] = duration;
    this._puFlash[slot] = 1;
    this._puPosDirty = true;
  }

  _pillRemove(id) {
    for (let i = 0; i < this._puCount; i++) {
      if (this._puId[i] === id) { this._pillRemoveAt(i); return; }
    }
  }

  _pillRemoveAt(slot) {
    for (let i = slot; i < this._puCount - 1; i++) {
      this._puId[i] = this._puId[i + 1];
      this._puDur[i] = this._puDur[i + 1];
      this._puStart[i] = this._puStart[i + 1];
      this._puLeft[i] = this._puLeft[i + 1];
      this._puFlash[i] = this._puFlash[i + 1];
    }
    this._puCount--;
    this._puId[this._puCount] = '';
    this._puFlash[this._puCount] = 0;
    this._puPosDirty = true;
  }

  _onBossSpawn(p) {
    if (!p) return;
    this._bossName = typeof p.name === 'string' ? p.name : '';
    this._bossMini = !!p.mini;
    this._bossTwins = !!p.twins;
    this._bossFrac = 1;
    this._bossPhase = 1;
    this._bossShieldUp = false;
    this._bossHideAt = 0;
    this._bossShowPending = true;
    this._bossDirty = true;
  }

  _onBossIntro(p) {
    if (this._bossMini) return;                     // mini-bosses: no letterbox, no name card (boss:intro is still emitted)
    if (p && typeof p.name === 'string' && p.name) this._bossName = p.name;
    this._lbOn = true;
    this._ncPending = true;
  }

  _onBossDead() {
    this._bossHideAt = this._tclock + BOSS_OUT_S;
    this._lbOn = false;
    this._ncUntil = 0;
    this._ncPending = false;
  }

  /**
   * Round 5, DISTRICTS.md §5 / §8.6: `district:change { id, label, accent, reason, banner }` (a reused payload: copied,
   * never retained). Only `banner: true` while the run is playing requests the banner (level decides: run start unless
   * it repeats the previous run's level, every endless rotation, never the title); update() shows it.
   */
  _onDistrictChange(p) {
    if (!p || p.banner !== true) return;
    let playing = true;
    try { const st = this.ctx.state; playing = !st || st.current === 'playing'; } catch (_) { playing = true; }
    if (!playing) return;
    let label = typeof p.label === 'string' ? p.label : '';
    let accent = Number.isFinite(p.accent) ? p.accent : -1;
    if (!label || accent < 0) {                     // a partial payload: complete it from the data by id
      const id = typeof p.id === 'string' && p.id ? p.id : this._runDistrict;
      for (let i = 0; i < DISTRICTS.length; i++) {
        const d = DISTRICTS[i];
        if (d && d.id === id) { if (!label) label = d.label; if (accent < 0) accent = d.accent; break; }
      }
    }
    if (!label) return;
    this._dbLabel = label;
    this._dbAccent = accent >= 0 ? accent : PALETTE.ui.primary;
    this._dbReq = true;
  }

  /** Round 5: the district banner per frame (theatre clock; DOM writes only on a show / hide / pause change). */
  _updateBanner(tnow, paused) {
    if (this._dbHideReq) { this._dbHideReq = false; if (this._dbShown) this._hideBanner(); }
    // hidden under the boss bar (#hud.boss-on): a request while it is up is dropped, a showing banner goes
    if (this._dbReq && !paused) { this._dbReq = false; if (!this._bossOn) this._showBanner(tnow); }
    if (!this._dbShown) return;
    if (this._bossOn || tnow >= this._dbUntil) { this._hideBanner(); return; }
    if (paused !== this._dbAnimPaused) {
      this._dbAnimPaused = paused;                  // theatre time: the animation holds while the game is paused
      const a = this._dbAnim;
      if (a) { try { if (paused) a.pause(); else a.play(); } catch (_) { /* cosmetic */ } }
    }
  }

  _showBanner(tnow) {
    const el = this._el;
    const node = el.districtBanner;
    if (!node) return;
    if (this._dbShownLabel !== this._dbLabel) {
      this._dbShownLabel = this._dbLabel;
      if (el.dbText) el.dbText.textContent = this._dbLabel; else node.textContent = this._dbLabel;
    }
    if (this._dbShownAccent !== this._dbAccent) {
      this._dbShownAccent = this._dbAccent;
      try {
        node.style.setProperty('--db-accent', hexCss(this._dbAccent));
        node.style.setProperty('--db-glow', rgbaCss(this._dbAccent, DB_GLOW_ALPHA));
      } catch (_) { /* cosmetic */ }
    }
    this._cancelAnim(this._dbAnim);
    this._dbAnim = null;
    node.hidden = false;
    // reduced motion: opacity only (no translate); _animate skips reduced motion, the banner's fade is not motion
    if (typeof node.animate === 'function') {
      try { this._dbAnim = node.animate(this._reduced ? KF_DB_RM : KF_DB, T_DB); } catch (_) { this._dbAnim = null; }
    }
    this._dbAnimPaused = false;
    this._dbShown = true;
    this._dbUntil = tnow + DB_S;
  }

  _hideBanner() {
    this._dbShown = false;
    this._cancelAnim(this._dbAnim);
    this._dbAnim = null;
    this._dbAnimPaused = false;
    if (this._el.districtBanner) this._el.districtBanner.hidden = true;
  }

  // -------------------------------------------------------------------------------------------
  // Service-worker update (round 5, sw.js v4: every launch runs one consistent build from the active worker's cache;
  // a new build installs in the background and waits; ARCH §15.4). Index shell only — the artifact shells never
  // register a worker (§15.2). Every browser API is guarded; nothing here runs per frame.
  // -------------------------------------------------------------------------------------------

  _swContainer() {
    if (this.ctx.config && this.ctx.config.isArtifact) return null;
    try {
      const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
      return sw && typeof sw.getRegistration === 'function' ? sw : null;
    } catch (_) { return null; }
  }

  _swInit() {
    const sw = this._swContainer();
    if (!sw) return;
    let ctl = null;
    try { ctl = sw.controller || null; } catch (_) { ctl = null; }
    this._swHadController = !!ctl;
    // r5b: the page's own build. A v4+ controller serves the whole page cache-first from its own build, so its answer
    // names the page's build (when its `app` matches ctx.version). The 1.1.0 worker (v3, network-first) never answers:
    // the page's build is then known by ctx.version alone.
    if (ctl) this._swAsk(SW_ASK_PAGE, ctl, (info) => this._swPageBuild(info));
    else this._swPageKnown = true;
    this._listen(sw, 'controllerchange', this._onSwController, false);
    // index.html registers the worker before this module runs; on a first visit the registration may still be
    // pending, then `ready` resolves once it is active (a first install has nothing to update anyway)
    try { sw.getRegistration().then((reg) => { if (reg) this._swWatch(reg); else sw.ready.then((r) => this._swWatch(r), NOOP); }, NOOP); } catch (_) { /* ignore */ }
  }

  _swWatch(reg) {
    if (!reg || this._swReg === reg) return;
    this._swReg = reg;
    this._listen(reg, 'updatefound', this._onSwUpdateFound, false);
    try {
      if (reg.waiting && reg.active) this._swReady(reg.waiting);
      else if (reg.installing) this._swTrack(reg.installing);
    } catch (_) { /* ignore */ }
  }

  /** A worker that is installing: once it is `installed` while another one is active, it is an update waiting. */
  _swTrack(worker) {
    if (!worker) return;
    const onState = () => {
      let st = '';
      try { st = worker.state; } catch (_) { st = ''; }
      if (st !== 'installed') return;
      let active = null;
      try { active = this._swReg ? this._swReg.active : null; } catch (_) { active = null; }
      if (active) this._swReady(worker);
    };
    this._listen(worker, 'statechange', onState, false);
    onState();
  }

  /** An installed worker waits to take over: ask it which build it holds; the pill shows only for another build (r5b). */
  _swReady(worker) {
    if (!worker || worker === this._swWaiting) return;
    this._swWaiting = worker;
    this._swConsider(worker);
  }

  /** controllerchange: our own SKIP_WAITING → reload into the new build; another tab's update → offer the reload when
   *  the new controller's build is not the one this page runs (the r5b check, as for a waiting worker). */
  _swControllerChanged() {
    if (this._swReloading) { this._reload(); return; }
    if (this._swHadController) {
      this._swWaiting = null;
      let ctl = null;
      try { const sw = this._swContainer(); ctl = sw ? sw.controller : null; } catch (_) { ctl = null; }
      this._swConsider(ctl);   // no controller to ask → no answer → the pill, as before r5b
    }
    this._swHadController = true;
  }

  /** Asks `worker` for its build (an update candidate); decided once the page's own build is settled too. */
  _swConsider(worker) {
    if (this._swUpdate) return;
    this._swCand = worker;
    this._swCandInfo = null;
    this._swCandDone = false;
    this._swAsk(SW_ASK_CAND, worker, (info) => { this._swCandInfo = info; this._swCandDone = true; this._swDecide(); });
  }

  /** The boot-time answer of the page's controller (null: none, e.g. the v3 worker). */
  _swPageBuild(info) {
    // the controller's build is the page's only when it carries this page's ctx.version (cache-first, one build per launch)
    if (info && info.app && info.app === (this.ctx.version || '') && typeof info.version === 'string') this._swPageSw = info.version;
    this._swPageKnown = true;
    this._swDecide();
  }

  _swDecide() {
    if (!this._swPageKnown || !this._swCandDone || !this._swCand) return;
    this._swCand = null;
    if (this._swUpdate || !this._swOtherBuild(this._swCandInfo)) return;
    this._swUpdate = true;
    this._swDirty = true;
  }

  /** Whether a worker's GET_BUILD answer names a build other than the one this page runs. */
  _swOtherBuild(info) {
    if (!info) return true;                              // a worker that cannot tell: offer the reload (the r5 behaviour)
    const page = this.ctx.version || '';
    if (info.app && info.app !== page) return true;      // another release (ctx.version differs)
    if (this._swPageSw) return info.version !== this._swPageSw;   // same ctx.version, another sw VERSION: another build
    return !info.app;                                    // page served by v3 / no controller: same ctx.version = same build
  }

  /** Posts GET_BUILD to `worker` on a fresh MessageChannel; `done(info | null)` runs once (answer, or SW_ASK_MS). */
  _swAsk(slot, worker, done) {
    this._swAskEnd(slot);
    const gen = ++this._swAskGen[slot];
    const finish = (info) => {
      if (gen !== this._swAskGen[slot]) return;
      this._swAskEnd(slot);
      done(info && typeof info === 'object' && info.type === 'BUILD' ? info : null);
    };
    if (!worker || typeof MessageChannel !== 'function') { finish(null); return; }
    try {
      const ch = new MessageChannel();
      this._swAskPort[slot] = ch.port1;
      ch.port1.onmessage = (e) => finish(e ? e.data : null);
      this._swAskTimer[slot] = setTimeout(() => finish(null), SW_ASK_MS);
      worker.postMessage(SW_BUILD_MSG, [ch.port2]);
    } catch (_) { finish(null); }
  }

  /** Drops a slot's pending question (timer, port); a late answer is ignored by its generation. */
  _swAskEnd(slot) {
    this._swAskGen[slot]++;
    const t = this._swAskTimer[slot];
    if (t) { try { clearTimeout(t); } catch (_) { /* ignore */ } this._swAskTimer[slot] = 0; }
    const p = this._swAskPort[slot];
    if (p) { try { p.onmessage = null; p.close(); } catch (_) { /* ignore */ } this._swAskPort[slot] = null; }
  }

  /** The pill: activate the waiting worker (postMessage SKIP_WAITING) and reload on controllerchange. */
  _applyUpdate() {
    if (this._swReloading) return;
    this._swReloading = true;
    const w = this._swWaiting;
    let posted = false;
    if (w) { try { w.postMessage(SW_SKIP_MSG); posted = true; } catch (_) { posted = false; } }
    if (!posted) { this._reload(); return; }
    try { setTimeout(() => this._reload(), SW_RELOAD_FALLBACK_MS); } catch (_) { this._reload(); }
  }

  _syncUpdatePill() {
    this._swDirty = false;
    const on = this._swUpdate;
    if (on === this._swShown) return;
    this._swShown = on;
    const btn = this._el.btnUpdate;
    if (btn) btn.hidden = !on;
    const title = this._screens ? this._screens.title : null;
    if (title) { try { title.classList.toggle('has-update', on); } catch (_) { /* ignore */ } }
  }

  /** On entering the title: ask the browser to re-check sw.js — at the first title of a launch (Chrome defers its own
   *  post-navigation check until the controlling worker idles, ≈ 1 min in the r5 test), then at most every SW_CHECK_S so a
   *  long session learns of a release too. One sw.js request; the install runs in the background. */
  _swMaybeCheck() {
    if (!this._swReg || this._swUpdate || this._swCheckTimer || this._clock - this._swCheckedAt < SW_CHECK_S) return;
    this._swCheckedAt = this._clock;
    // the launch's first check waits SW_FIRST_CHECK_MS: index.html's register() job for the same script can still be
    // queued, and an update() folded into it may not byte-check sw.js (one r5 run waited 52 s for the browser's own check)
    try { this._swCheckTimer = setTimeout(this._onSwCheck, this._swFirstDone ? 0 : SW_FIRST_CHECK_MS); } catch (_) { this._swCheckNow(); }
  }

  _swCheckNow() {
    this._swCheckTimer = 0;
    this._swFirstDone = true;
    const reg = this._swReg;
    if (!reg || this._swUpdate) return;
    try { const p = reg.update(); if (p && typeof p.then === 'function') p.then(NOOP, NOOP); } catch (_) { /* offline / unsupported */ }
  }

  // -------------------------------------------------------------------------------------------
  // Frame update (step F) — every DOM write driven by events happens here
  // -------------------------------------------------------------------------------------------

  /** Called every frame with the unscaled dt (also while paused). Allocation-free in steady state. */
  update(unscaledDt) {
    if (!this._el) return;
    const dt = unscaledDt > 0 && unscaledDt < 1 ? unscaledDt : 0;
    this._clock += dt;
    const now = this._clock;
    // UI-28: theatre deadlines (name card, hint, boss bar out) do not run while paused (ARCH §2.2)
    let paused = false;
    try { const st = this.ctx.state; paused = !!st && st.current === 'paused'; } catch (_) { paused = false; }
    if (!paused) this._tclock += dt;
    const tnow = this._tclock;

    // read-first phase (UI-21): layout is still clean from the last rendered frame — measure / focus before any write
    if (this._lvScrollPending) { this._lvScrollPending = false; this._scrollLevels(); }
    if (this._focusPending) { const f = this._focusPending; this._focusPending = null; this._focusFirst(f === this._el.app ? null : f); }

    if (this._pendingSet) {
      this._pendingSet = false;
      if (this._startingBtn) { try { this._startingBtn.classList.remove('starting'); } catch (_) { /* ignore */ } this._startingBtn = null; }
      this.showScreen(this._pendingId);
    } else if (this._bootHiding) {
      this._bootHiding = false;
      if (this._screens.boot && !this._bootHold) this._screens.boot.hidden = true;
    }
    if (this._htmlDirty) this._applyHtmlClasses();
    if (this._pendingErr) { const m = this._pendingErr; this._pendingErr = ''; this.showError(m, false); }
    if (this._saveDirty) { this._saveDirty = false; this._refreshSaveViews(); }
    if (this._hudResetPending) { this._hudResetPending = false; this._applyHudReset(); }

    this._updateCoins(dt);
    this._updateFlash(dt);
    this._updateVignette(dt);
    this._updateTheatre(tnow);
    if (this._dbShown || this._dbReq || this._dbHideReq) this._updateBanner(tnow, paused);
    if (this._swDirty) this._syncUpdatePill();
    this._updateBlink(now);
    this._updateFire();
    if (this._fireShown && this._gpSeen) this._pollGamepadFire();
    if (this._plates > 0 || this._platesShown > 0) { this._placeShield(); this._syncShield(); }

    this._hudAcc += dt;
    if (this._hudAcc >= HUD_PERIOD) {
      this._hudAcc -= HUD_PERIOD;
      if (this._hudAcc >= HUD_PERIOD) this._hudAcc = 0;
      this._updateHudBlock(now);
    }

    if (this._cmpAnimating && this._current === 'complete') this._updateComplete(dt);
    if (this._shopTween) this._updateShopCoins(dt);
    if (this._confirmArmed && now >= this._confirmUntil) this._disarmReset();
  }

  _applyHudReset() {
    const el = this._el;
    if (el.progressLabel) el.progressLabel.textContent = this._runEndless ? fmtMetres(0) : STRINGS.hud.level(this._runLevel);
    this._metresShown = 0;
    // endless (UI-5): the bar is the current 300 m chunk; the skull only marks a mini-boss chunk
    const prog = el.progressLabel ? el.progressLabel.parentNode : null;
    if (prog && prog.classList) { try { prog.classList.toggle('endless', this._runEndless); } catch (_) { /* ignore */ } }
    this._skullShown = !this._runEndless;
    if (el.progressSkull) el.progressSkull.hidden = !this._skullShown;
    this._hideBossBar();
    this._bossShowPending = false;
    if (el.letterbox) el.letterbox.hidden = true;
    if (el.letterboxBottom) el.letterboxBottom.hidden = true;
    this._lbShown = false;
    this._lbOn = false;
    if (el.namecard) el.namecard.hidden = true;
    this._ncShown = false;
    this._hideHintDom();
    this._hintHideReq = false;
    if (el.flash) { el.flash.style.opacity = this._opa[0]; this._flashOpa = 0; }
    if (el.vignette) { el.vignette.style.opacity = this._opa[0]; this._vigOpa = 0; }
    if (el.overlayMsg) el.overlayMsg.hidden = true;
    this._cancelAnim(this._skullAnim); this._skullAnim = null;
    this._platesShown = -1;
    this._syncShield();
    this._syncPills();
    this._hudAcc = HUD_PERIOD;                    // run the 10 Hz block this frame
  }

  _updateCoins(dt) {
    if (this._coinHold) {
      // J19: coins still flying to the icon are held back; never counts down while they are in the air
      const fx = this.ctx.fx;
      const air = fx && typeof fx.coinsInFlight === 'number' ? fx.coinsInFlight : 0;
      let target = air > 0 ? Math.floor(this._coinTotal - air + 1e-6) : this._coinTotal;
      if (target < this._coinTo) target = this._coinTo;
      if (target > this._coinTotal) target = this._coinTotal;
      this._coinHold = air > 0;
      if (target !== this._coinTo) this._tweenCoins(target);
    }
    if (!this._coinTween) return;
    this._coinT += dt;
    const k = COIN_TWEEN_S > 0 ? Math.min(1, this._coinT / COIN_TWEEN_S) : 1;
    this._coinValue = this._coinFrom + (this._coinTo - this._coinFrom) * ease.outCubic(k);
    if (k >= 1) { this._coinValue = this._coinTo; this._coinTween = false; }
    const v = Math.round(this._coinValue);
    if (v !== this._coinShown) {
      this._coinShown = v;
      if (this._el.coinsValue) this._el.coinsValue.textContent = fmtCoins(v);
    }
  }

  _updateFlash(dt) {
    if (!this._flashOn) return;
    const node = this._el.flash;
    if (this._flashCssDirty && node) { node.style.background = this._flashCss; this._flashCssDirty = false; }
    this._flashT += dt;
    const k = Math.min(1, this._flashT / this._flashDur);
    const idx = Math.round(this._flashA0 * (1 - k) * OPA_STEPS);
    if (idx !== this._flashOpa && node) { this._flashOpa = idx; node.style.opacity = this._opa[idx]; }
    if (k >= 1) this._flashOn = false;
  }

  _updateVignette(dt) {
    if (!this._vigOn) return;
    const node = this._el.vignette;
    if (this._vigCssDirty && node) { node.style.background = this._vigCss; this._vigCssDirty = false; }
    this._vigT += dt;
    const k = Math.min(1, this._vigT / this._vigDur);
    const u = 1 - k;
    const idx = Math.round(u * u * OPA_STEPS);    // ease-out fade from full strength
    if (idx !== this._vigOpa && node) { this._vigOpa = idx; node.style.opacity = this._opa[idx]; }
    if (k >= 1) this._vigOn = false;
  }

  /** Boss bar show/hide, letterbox, name card and hint deadlines (theatre time: real seconds, paused time excluded). */
  _updateTheatre(now) {
    const el = this._el;
    if (this._bossShowPending) {
      this._bossShowPending = false;
      if (el.bossName) el.bossName.textContent = this._bossName;
      if (el.bossbar) {
        el.bossbar.hidden = false;
        try { el.bossbar.classList.remove('shielded', 'phase2', 'phase3'); } catch (_) { /* ignore */ }
        this._animate(el.bossbar, KF_SLIDE_DOWN, T_BOSS_IN);
      }
      // the power-up row drops below the boss bar while it is up (css #hud.boss-on; the hint pill is bottom-anchored)
      if (el.hud) { try { el.hud.classList.add('boss-on'); } catch (_) { /* ignore */ } }
      this._puPosDirty = true;
      this._bossOn = true;
      this._bossIdx = -1;
      this._bossColor = '';
      this._bossDirty = true;
      this._hudAcc = HUD_PERIOD;
    }
    if (this._bossOn && this._bossHideAt > 0 && now >= this._bossHideAt) this._hideBossBar();

    if (this._lbOn !== this._lbShown) {
      this._lbShown = this._lbOn;
      if (el.letterbox) el.letterbox.hidden = !this._lbOn;
      if (el.letterboxBottom) el.letterboxBottom.hidden = !this._lbOn;
      if (this._lbOn) {
        this._animate(el.letterbox, KF_LB_TOP, T_LETTERBOX);
        this._animate(el.letterboxBottom, KF_LB_BOTTOM, T_LETTERBOX);
      }
    }

    if (this._ncPending) {
      this._ncPending = false;
      if (el.ncName) el.ncName.textContent = this._bossName;
      if (el.namecard) { el.namecard.hidden = false; this._animate(el.namecard, KF_POP_IN, T_NAMECARD); }
      this._ncShown = true;
      this._ncUntil = now + NAMECARD_S;
    }
    if (this._ncShown && now >= this._ncUntil) {
      this._ncShown = false;
      if (el.namecard) el.namecard.hidden = true;
    }

    if (this._hintHideReq) { this._hintHideReq = false; if (this._hintShown) this._hideHintDom(); }
    if (this._hintShown) {
      const input = this.ctx.input;
      if (now >= this._hintUntil || (this._hintId === 'steer' && input && input.hasSteered)
        || (this._hqLen > 0 && now >= this._hintUntil - HINT_S + HINT_MIN_S && now - this._hqAt[0] <= HINT_QUEUE_AGE_S)) this._hideHintDom();
    }
    if (!this._hintShown && this._hqLen > 0 && this._current === null) this._nextHint(now);
  }

  /** UI-25: the oldest still-fresh queued hint goes on screen (a steer hint the player already acted on is
   *  marked done and skipped). */
  _nextHint(now) {
    const input = this.ctx.input;
    while (this._hqLen > 0) {
      const id = this._hqId[0], text = this._hqText[0], at = this._hqAt[0];
      this._hintQueueShift();
      if (now - at > HINT_QUEUE_AGE_S) continue;
      if (id === 'steer' && input && input.hasSteered) { this._markHint(id); continue; }
      this._showHintDom(id, text, now);
      return;
    }
  }

  _hintQueueShift() {
    const n = this._hqLen;
    if (n <= 0) return;
    for (let i = 1; i < n; i++) { this._hqId[i - 1] = this._hqId[i]; this._hqText[i - 1] = this._hqText[i]; this._hqAt[i - 1] = this._hqAt[i]; }
    this._hqLen = n - 1;
    this._hqId[n - 1] = '';
    this._hqText[n - 1] = '';
  }

  /** Drops every waiting hint; `hide` also takes the one on screen down (next update). */
  _hintQueueClear(hide) {
    for (let i = 0; i < this._hqLen; i++) { this._hqId[i] = ''; this._hqText[i] = ''; }
    this._hqLen = 0;
    if (hide) this._hintHideReq = true;
  }

  _markHint(id) {
    const save = this.ctx.save;
    if (!id || !save || typeof save.markHint !== 'function') return;
    try { save.markHint(id); } catch (_) { /* the save reports its own errors */ }
  }

  /** performance.now() in seconds (guarded; falls back to the update clock). */
  _realNow() {
    try {
      if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now() / 1000;
    } catch (_) { /* fall through */ }
    return this._clock;
  }

  /**
   * Projects ctx.fx.label (read-only: x, y, z, hasPos, nDigits) with ctx.render.camera into CSS px relative
   * to #app → this._lx / _ly (centre) and _lhw / _lhh (half extents). False when the label is not drawn.
   * Pure arithmetic on the camera's matrices (no allocation).
   */
  _projectLabel() {
    const fx = this.ctx.fx;
    const render = this.ctx.render;
    const L = fx ? fx.label : null;
    const cam = render ? render.camera : null;
    if (!L || !L.hasPos || !cam || !cam.matrixWorldInverse || !cam.projectionMatrix) return false;
    const mesh = fx.labelMesh;
    if (mesh && mesh.count === 0) return false;
    const W = this._appW, H = this._appH;
    if (!(W > 0 && H > 0)) return false;
    const v = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
    const x = L.x, y = L.y, z = L.z;
    const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
    const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
    const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
    const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    if (!(cw > 1e-4)) return false;                      // behind the camera
    const cx = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / cw;
    const cy = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / cw;
    if (!(cx === cx && cy === cy)) return false;
    this._lx = (cx + 1) * 0.5 * W;
    this._ly = (1 - cy) * 0.5 * H;
    const n = L.nDigits > 0 ? L.nDigits : 1;
    this._lhw = n * LABEL_ADV * LABEL_PX * 0.5;
    this._lhh = LABEL_PX * 0.5;
    return true;
  }

  /** Round-3 polish: true while the projected count label (this._ly ± _lhh, set by _projectLabel) is inside the
   *  visible band — the app box minus the cinematic letterbox bars while they are up. The boss-intro dolly frames the
   *  boss and drops the squad below the screen: the shield pill used to stay clamped to the bottom edge, alone in the
   *  letterbox bar. Pure arithmetic. */
  _labelOnScreen() {
    const H = this._appH;
    const bar = this._lbShown ? H * LETTERBOX_PCT * 0.01 : 0;
    return this._ly + this._lhh > bar && this._ly - this._lhh < H - bar;
  }

  /**
   * UI-18: the hint is a bottom-anchored pill under the squad (css: safe-bottom + JUICE.ui.hintBottomPx). On wide /
   * landscape boxes the projected count label can reach that band: when the pill's unshifted box (cached by the
   * ResizeObserver, no layout read here) overlaps the label (+ 12 px), the pill slides sideways with the css
   * `translate` property (composes with the pop-in transform) to the nearer side that fits. Pure arithmetic;
   * the shift string comes from a table and is written only when the 4 px step changes.
   */
  _placeHint() {
    const hint = this._el ? this._el.hint : null;
    if (!hint || !this._hintShown || !this._shiftStr) return;
    let k = 0;
    if (this._hintBoxOk && this._projectLabel()) {
      const m = HINT_LABEL_MARGIN;
      const L = this._hintBL, T = this._hintBT, W = this._hintBW, H = this._hintBH;
      const lt = this._ly - this._lhh - m, lb = this._ly + this._lhh + m;
      const ll = this._lx - this._lhw - m, lr = this._lx + this._lhw + m;
      if (T < lb && T + H > lt && L < lr && L + W > ll) {
        const toLeft = ll - (L + W);                     // ≤ 0: the pill's right edge to the label's left
        const toRight = lr - L;                          // ≥ 0: the pill's left edge to the label's right
        const okL = L + toLeft >= EDGE_PX[3];
        const okR = L + W + toRight <= this._appW - EDGE_PX[1];
        let s = 0;
        if (okL && okR) s = -toLeft < toRight ? toLeft : toRight;
        else if (okL) s = toLeft;
        else if (okR) s = toRight;
        k = clamp(Math.round(s / SHIFT_STEP_PX), -SHIFT_STEPS, SHIFT_STEPS);
      }
    }
    if (k === this._hintShift) return;
    this._hintShift = k;
    hint.style.translate = k === 0 ? '' : this._shiftStr[k + SHIFT_STEPS];
  }

  /**
   * UI-9: the armor shield counter sits right of the count label (GDD §8.2 / §14 "beside the squad count"),
   * vertically centred on it, clamped to the safe area; hidden while the label is not drawn. Runs every frame
   * while plates > 0 so it tracks the steering squad (zero allocation: positions come from the 'Npx' table and
   * are written only when the integer pixel changes).
   */
  _placeShield() {
    const sh = this._el ? this._el.shield : null;
    if (!sh || !this._px) return;
    // round-3 FTUE: not during the boss-intro dolly — the squad (and fx's count label, faded meanwhile) is under the
    // letterbox, and the clamp below parked the pill alone in the bottom bar
    const rnd = this.ctx.render;
    this._shieldAnchorOk = this._plates > 0 && this._hudVisible && !(rnd && rnd.dollying === true) && this._projectLabel() && this._labelOnScreen();
    if (!this._shieldAnchorOk) return;
    if (!(this._shieldW > 0)) {
      if (sh.hidden) sh.hidden = false;                  // laid out (invisible) so the ResizeObserver reports its size
      if (this._ro) {
        // UI-21: no offsetWidth read after the text write — wait for the observer (next frame), invisible meanwhile
        if (!this._shieldWaiting) { this._shieldWaiting = true; sh.style.visibility = 'hidden'; }
        return;
      }
      this._shieldW = sh.offsetWidth;                    // no ResizeObserver: legacy measurement
      this._shieldH = sh.offsetHeight;
      if (!(this._shieldW > 0)) { this._shieldAnchorOk = false; return; }
    }
    if (this._shieldWaiting) { this._shieldWaiting = false; sh.style.visibility = ''; }
    const W = this._appW, H = this._appH;
    let x = this._lx + this._lhw + SHIELD_GAP_PX;
    let y = this._ly - this._shieldH * 0.5;
    // no room right of the count (squad hard right, long counts): sit on its left instead of overlapping it
    if (x > W - EDGE_PX[1] - this._shieldW) {
      const left = this._lx - this._lhw - SHIELD_GAP_PX - this._shieldW;
      if (left >= EDGE_PX[3]) x = left;
    }
    x = clamp(x, EDGE_PX[3], Math.max(EDGE_PX[3], W - EDGE_PX[1] - this._shieldW));
    y = clamp(y, EDGE_PX[0], Math.max(EDGE_PX[0], H - EDGE_PX[2] - this._shieldH));
    const xi = clamp(Math.round(x), 0, PX_STEPS - 1), yi = clamp(Math.round(y), 0, PX_STEPS - 1);
    if (xi !== this._shieldX) { this._shieldX = xi; sh.style.left = this._px[xi]; this._puPosOk[MAX_PILLS] = 0; }
    if (yi !== this._shieldY) { this._shieldY = yi; sh.style.top = this._px[yi]; this._puPosOk[MAX_PILLS] = 0; }
  }

  /** Puts one hint on screen (UI-18 pill; hand inside it for steer / shoot) and marks it done (UI-25). No layout
   *  read: the ResizeObserver reports the pill box after this frame's layout; the label check starts then. */
  _showHintDom(id, text, now) {
    const el = this._el;
    this._hintId = id;
    this._hintText = text;
    const hand = HINT_HAND_IDS[id] === true;
    if (el.hintText) el.hintText.textContent = text;
    if (el.hintHand) el.hintHand.hidden = !hand;
    this._hintShown = true;
    this._hintUntil = now + HINT_S;
    this._hintBoxOk = false;
    if (el.hint) {
      if (this._hintShift !== 0) { this._hintShift = 0; el.hint.style.translate = ''; }
      el.hint.hidden = false;
      this._animate(el.hint, KF_POP_IN, T_NAMECARD);
    }
    this._cancelAnim(this._handAnim);
    this._handAnim = !hand ? null : this._animate(el.hintHand, KF_HAND, T_HAND);
    this._markHint(id);
  }

  _hideHintDom() {
    this._hintShown = false;
    this._hintBoxOk = false;
    this._cancelAnim(this._handAnim);
    this._handAnim = null;
    if (this._el.hint) this._el.hint.hidden = true;
  }

  _hideBossBar() {
    this._bossOn = false;
    this._bossHideAt = 0;
    this._cancelAnim(this._bossRage);
    this._bossRage = null;
    if (this._el.bossbar) this._el.bossbar.hidden = true;
    if (this._el.hud) { try { this._el.hud.classList.remove('boss-on'); } catch (_) { /* ignore */ } }
    this._puPosDirty = true;
  }

  /** Power-up pills blink at JUICE.powerup.pillBlinkHz in their last pillBlinkLast seconds (opacity, per frame). */
  _updateBlink(now) {
    const els = this._puEls;
    for (let i = 0; i < this._puCount; i++) {
      const left = this._puLeft[i];
      let idx = OPA_STEPS;
      if (left > 0 && left <= BLINK_LAST && (Math.floor(now * BLINK_HZ * 2) & 1) === 1) idx = BLINK_DIM_IDX;
      if (idx !== this._puOpa[i]) { this._puOpa[i] = idx; els[i].root.style.opacity = this._opa[idx]; }
    }
  }

  /** The 10 Hz HUD block (§10.3): progress, ticks, skull, pills, shield, boss fill / colour. */
  _updateHudBlock(now) {
    const el = this._el;
    const pct = this._pct;
    if (this._progDirty) {
      this._progDirty = false;
      const idx = Math.round(clamp(Number.isFinite(this._progFrac) ? this._progFrac : 0, 0, 1) * PCT_STEPS);
      if (idx !== this._progIdx) {
        this._progIdx = idx;
        if (el.progressFill) el.progressFill.style.transform = this._txFill[idx];   // UI-22: compositor-only
        if (el.progressSquad) el.progressSquad.style.transform = this._txPct[idx];
      }
      if (this._runEndless) {
        // the bar is the chunk the squad is in (D = length / chunk); the skull marks a mini-boss chunk only
        const D = Math.max(1, Math.round((Number.isFinite(this._progLen) ? this._progLen : 0) / ENDLESS_CHUNK));
        const skull = D % MINI_EVERY === 0;
        if (skull !== this._skullShown) { this._skullShown = skull; if (el.progressSkull) el.progressSkull.hidden = !skull; }
        const m = Math.max(0, Math.floor(Number.isFinite(this._progDist) ? this._progDist : 0));
        if (m !== this._metresShown) { this._metresShown = m; if (el.progressLabel) el.progressLabel.textContent = fmtMetres(m); }
      }
    }
    if (this._ticksDirty) {
      this._ticksDirty = false;
      const ticks = this._tickEls;
      for (let i = 0; i < MAX_TICKS; i++) {
        const t = ticks[i];
        const on = i < this._tickCount;
        if (on) t.style.left = pct[Math.round(this._tickFrac[i] * PCT_STEPS)];
        if (t.hidden === on) t.hidden = !on;
      }
    }
    if (this._skullDirty) {
      this._skullDirty = false;
      const skull = el.progressSkull;
      if (skull) {
        try { skull.classList.toggle('pulse', this._skullPulse); } catch (_) { /* ignore */ }
        this._cancelAnim(this._skullAnim);
        this._skullAnim = this._skullPulse ? this._animate(skull, KF_PULSE, T_PULSE) : null;
      }
    }
    this._syncPills();
    this._updatePillTimes(now);
    this._syncShield();
    if (this._hintShown) this._placeHint();
    if (this._bossOn && this._bossDirty) {
      this._bossDirty = false;
      const frac = clamp(Number.isFinite(this._bossFrac) ? this._bossFrac : 0, 0, 1);
      const idx = Math.round(frac * PCT_STEPS);
      if (idx !== this._bossIdx && el.bossFill) { this._bossIdx = idx; el.bossFill.style.transform = this._txFill[idx]; }
      const C = this._bossColors;
      const shielded = this._bossShieldUp;
      // twins: boss:phase reports the furthest-advanced twin while the bar shows the pair's summed HP, so the
      // colour follows the summed fraction at the 60 % / 25 % ticks instead (GDD §7 "one boss bar", §14)
      const phase = this._bossTwins ? (frac <= BOSS_P3 + 1e-6 ? 3 : (frac <= BOSS_P2 + 1e-6 ? 2 : 1)) : this._bossPhase;   // 1e-6: chunked fractions land on the tick
      const col = shielded ? C.shield : (phase >= 3 ? C.p3 : (phase === 2 ? C.p2 : C.base));
      if (col !== this._bossColor) {
        this._bossColor = col;
        if (el.bossFill) el.bossFill.style.background = col;
        if (el.bossbar) {
          try {
            el.bossbar.classList.toggle('shielded', shielded);
            el.bossbar.classList.toggle('phase2', phase === 2);
            el.bossbar.classList.toggle('phase3', phase >= 3);
          } catch (_) { /* ignore */ }
        }
        const rage = phase >= 3 && !shielded;
        if (rage && !this._bossRage) this._bossRage = this._animate(el.bossFill, KF_BOSS_RAGE, T_RAGE);
        else if (!rage && this._bossRage) { this._cancelAnim(this._bossRage); this._bossRage = null; }
      }
    }
  }

  /** Assigns pill DOM to the pill model (ids → icon, ring colour table); hides unused pills. */
  _syncPills() {
    const els = this._puEls;
    if (!els) return;
    for (let i = 0; i < MAX_PILLS; i++) {
      const e = els[i];
      if (i >= this._puCount) {
        if (!e.root.hidden) { e.root.hidden = true; this._puPosDirty = true; }
        this._puShownId[i] = '';
        continue;
      }
      const id = this._puId[i];
      if (this._puShownId[i] !== id) {
        this._puShownId[i] = id;
        e.root.dataset.id = id;
        this._applyIcon(e.icon, this._iconUrl(id));
        this._puRings[i] = this._ringStrings(id);
        this._puRing[i] = -1;
        this._puSec[i] = -1;
        this._puOpa[i] = -1;
        if (e.root.hidden) e.root.hidden = false;
        this._puPosDirty = true;
      }
      if (this._puFlash[i]) {
        this._puFlash[i] = 0;
        this._animate(e.root, KF_POP_IN, T_NAMECARD);
      }
    }
    // round 5 (DISTRICTS.md §5): #hud.pu-on while a pill is visible — the district banner then drops a row
    const puOn = this._puCount > 0;
    if (puOn !== this._puOn) {
      this._puOn = puOn;
      const hud = this._el.hud;
      if (hud) { try { hud.classList.toggle('pu-on', puOn); } catch (_) { /* ignore */ } }
    }
  }

  /** Reads weapons.weaponTimeLeft / weapons.gear (10 Hz) → conic ring and seconds; falls back to the event's duration. */
  _updatePillTimes(now) {
    const weapons = this.ctx.weapons;
    const els = this._puEls;
    for (let i = 0; i < this._puCount; i++) {
      const id = this._puId[i];
      let left = -1;
      if (weapons) {
        try {
          if (isWeaponId(id)) { if (weapons.weapon === id) left = weapons.weaponTimeLeft; }
          else { const g = weapons.gear; if (g) { const v = g[id]; if (typeof v === 'number') left = v; } }
        } catch (_) { left = -1; }
      }
      if (!(left >= 0) || !Number.isFinite(left)) left = Math.max(0, this._puDur[i] - (now - this._puStart[i]));
      if (left <= 0) { this._pillRemoveAt(i); i--; continue; }   // expired without an *:end (stub / reset race)
      this._puLeft[i] = left;
      const e = els[i];
      const dur = this._puDur[i];
      const r = Math.round(clamp(dur > 0 ? left / dur : 0, 0, 1) * RING_STEPS);
      if (r !== this._puRing[i]) {
        this._puRing[i] = r;
        const rings = this._puRings[i];
        if (rings) e.ring.style.background = rings[r];
      }
      const s = Math.min(SECONDS_TABLE - 1, Math.ceil(left));
      if (s !== this._puSec[i]) { this._puSec[i] = s; e.time.textContent = this._secs[s]; }
    }
    if (this._puCount < MAX_PILLS) this._syncPills();
  }

  _syncShield() {
    const p = this._plates;
    const el = this._el;
    if (p !== this._platesShown) {
      this._platesShown = p;
      if (p > 0 && el.shieldValue) { el.shieldValue.textContent = STRINGS.hud.shield(p); if (!this._ro) this._shieldW = 0; }
    }
    if (el.shield) {
      const hide = p <= 0 || !this._shieldAnchorOk;      // beside the count label, so hidden with it
      if (el.shield.hidden !== hide) { el.shield.hidden = hide; this._puPosDirty = true; }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------------------------

  _saveData() {
    const save = this.ctx.save;
    try { return save && save.data ? save.data : null; } catch (_) { return null; }
  }

  _highestUnlocked() {
    const d = this._saveData();
    return d ? Math.max(1, d.highestUnlocked | 0) : 1;
  }

  _fillTitle() {
    const el = this._el;
    const d = this._saveData();
    const coins = d ? d.coins : 0;
    if (el.titleCoinsValue) el.titleCoinsValue.textContent = fmtCoins(coins);
    const hl = this._highestUnlocked();
    const rec = d && d.levels ? d.levels[hl] : null;
    const stars = rec ? rec.stars | 0 : 0;
    if (el.titleCaption) {
      el.titleCaption.textContent = STRINGS.title.caption(hl, stars);
      // round 5: the district the title scene shows (DISTRICTS.md §3.5: districtForLevel(highestUnlocked)) as a small
      // second line with its accent dot
      const td = el.titleDistrict;
      if (td) {
        const dist = districtForLevel(hl);
        if (td.textContent !== dist.label) td.textContent = dist.label;
        try { td.style.setProperty('--d-accent', hexCss(dist.accent)); } catch (_) { /* cosmetic */ }
        el.titleCaption.appendChild(td);
      }
      const save = this.ctx.save;
      let vol = storage.volatile;
      try { vol = vol || !!(save && save.volatile); } catch (_) { /* ignore */ }
      if (vol && !this._volatileShown && this._doc) {
        this._volatileShown = true;                   // one-time caption (§12)
        el.titleCaption.appendChild(this._doc.createElement('br'));
        const warn = this._doc.createElement('span');
        warn.className = 'caption-warn';
        warn.textContent = STRINGS.volatileSave;
        el.titleCaption.appendChild(warn);
      }
    }
    if (el.btnEndless) el.btnEndless.hidden = !(hl > LEVELS.endlessUnlock);
    this._syncShopBadges();
    if (el.btnFullscreen) el.btnFullscreen.hidden = !this._fsAvailable;
    this._syncFullscreenButton();
    if (el.version) el.version.textContent = STRINGS.title.version(this.ctx.version || '');
    this._swMaybeCheck();                           // round 5: a long session learns of a release on its next title
  }

  /**
   * UI-19 / UI-24: the level grid is built once (tiles 1..LEVELS.count, the ENDLESS tile after
   * LEVELS.endlessUnlock, and a pool of LEVEL_WINDOW tiles for the looped campaign past LEVELS.count) and
   * updated in place on every open: classes, labels, stars, the CSS-drawn milestone skull. Past LEVELS.count only
   * the LEVEL_WINDOW levels ending at the highest unlocked one are shown, so any save opens LEVELS in one frame.
   * `show` (a real open, not the boot prewarm) queues the scroll-to-current read for the next update.
   */
  _fillLevels(show) {
    const grid = this._el.levelGrid;
    if (!grid) return;
    this._buildLevelGrid(grid);
    if (!this._lvTiles) return;
    const d = this._saveData();
    const hl = this._highestUnlocked();
    const tiles = this._lvTiles;
    const base = LEVELS.count;
    for (let i = 0; i < base; i++) this._setTile(tiles[i], i + 1, hl, d);
    const from = Math.max(base + 1, hl - LEVEL_WINDOW + 1);
    for (let i = 0; i < LEVEL_WINDOW; i++) {
      const t = tiles[base + i];
      const n = from + i;
      const on = n <= hl;
      if (on) this._setTile(t, n, hl, d);
      if (t.btn.hidden === on) t.btn.hidden = !on;
    }
    const e = this._lvEndless;
    if (e) {
      const endlessOn = hl > LEVELS.endlessUnlock;
      const cls = endlessOn ? 'tile endless' : 'tile endless locked';
      if (e.btn.className !== cls) e.btn.className = cls;
      e.btn.disabled = !endlessOn;
      e.btn.setAttribute('aria-label', STRINGS.levels.endless + (endlessOn ? '' : STRINGS.common.separator + STRINGS.levels.locked));
      const best = d && d.endless ? d.endless.bestScore | 0 : 0;
      const txt = endlessOn && best > 0 ? STRINGS.endless.best(fmtCoins(best)) : '';
      if (e.stars.textContent !== txt) e.stars.textContent = txt;
    }
    if (show) this._lvScrollPending = true;
  }

  _buildLevelGrid(grid) {
    if (this._lvTiles || !this._doc) return;
    const doc = this._doc;
    const tiles = [];
    grid.textContent = '';
    const mk = () => {
      const btn = doc.createElement('button'); btn.type = 'button'; btn.className = 'tile';
      const num = doc.createElement('span'); num.className = 'tile-num';
      const stars = doc.createElement('span'); stars.className = 'tile-stars'; stars.setAttribute('aria-hidden', 'true');
      const on = doc.createElement('span'); on.className = 'on';
      const off = doc.createElement('span'); off.className = 'off';
      stars.appendChild(on); stars.appendChild(off);
      // milestone badge: a CSS-drawn skull (the ☠ glyph is in neither game font: its fallback lookup cost 90 ms)
      const skull = doc.createElement('span'); skull.className = 'skull'; skull.setAttribute('aria-hidden', 'true'); skull.hidden = true;
      // round 5: district band — a short accent rule at the tile's top and a faint accent wash at its foot (css .tile-band)
      const band = doc.createElement('span'); band.className = 'tile-band'; band.setAttribute('aria-hidden', 'true');
      btn.appendChild(band); btn.appendChild(num); btn.appendChild(stars); btn.appendChild(skull);
      grid.appendChild(btn);
      return { btn, num, stars, on, off, skull, n: 0, key: '', dname: '' };
    };
    for (let n = 1; n <= LEVELS.count; n++) {
      tiles.push(mk());
      if (n === LEVELS.endlessUnlock) {
        const btn = doc.createElement('button'); btn.type = 'button'; btn.className = 'tile endless locked'; btn.dataset.endless = '1';
        const num = doc.createElement('span'); num.className = 'tile-num'; num.textContent = STRINGS.levels.endless;
        const stars = doc.createElement('span'); stars.className = 'tile-stars'; stars.setAttribute('aria-hidden', 'true');
        btn.appendChild(num); btn.appendChild(stars);
        grid.appendChild(btn);
        this._lvEndless = { btn, num, stars };
      }
    }
    for (let i = 0; i < LEVEL_WINDOW; i++) { const t = mk(); t.btn.hidden = true; tiles.push(t); }
    this._lvTiles = tiles;
  }

  /** One tile in place (writes only what changed since its last fill). */
  _setTile(t, n, hl, d) {
    const locked = n > hl;
    const current = n === hl;
    const rec = d && d.levels ? d.levels[n] : null;
    const stars = rec ? clamp(rec.stars | 0, 0, 3) : 0;
    const milestone = BOSSES.milestones.indexOf(Math.min(n, LEVELS.curve.loopAfter)) !== -1;
    const blank = locked || (current && !rec);           // a never-played current tile shows no stars at all
    const key = n + (locked ? 'L' : '') + (current ? 'C' : '') + (blank ? 'b' : stars);
    if (t.key === key) return;
    t.key = key;
    if (t.n !== n) {
      t.n = n;
      t.btn.dataset.level = String(n);
      t.num.textContent = STRINGS.levels.tile(n);
      t.skull.hidden = !milestone;
      // round 5: the tile wears its district band (districtForLevel: L31+ cycles like the campaign); a band's first
      // level carries .band-start (a slightly longer rule) so the five-level runs read as groups in the 4-column grid
      const dist = districtForLevel(n);
      t.dname = dist.name;
      t.btn.dataset.district = dist.id;
      try {
        t.btn.style.setProperty('--d-accent', hexCss(dist.accent));
        t.btn.style.setProperty('--d-tint', rgbaCss(dist.accent, TILE_TINT_ALPHA));
      } catch (_) { /* cosmetic */ }
    }
    let cls = 'tile';
    if (locked) cls += ' locked';
    if (current) cls += ' current';
    if (milestone) cls += ' milestone';
    if ((n - 1) % TILE_BAND_LEVELS === 0) cls += ' band-start';
    if (t.btn.className !== cls) t.btn.className = cls;
    t.btn.disabled = locked;
    if (current) t.btn.setAttribute('aria-current', 'true'); else t.btn.removeAttribute('aria-current');
    const sep = STRINGS.common.separator;
    const dsuffix = t.dname ? sep + t.dname : '';     // round 5: the district is part of the tile's name
    t.btn.setAttribute('aria-label', (locked ? STRINGS.aria.level(n) + sep + STRINGS.levels.locked
      : (milestone ? STRINGS.aria.level(n) + sep + STRINGS.levels.boss : STRINGS.aria.level(n))) + dsuffix);
    const star = STRINGS.common.star;
    t.on.textContent = blank ? '' : star.repeat(stars);
    t.off.textContent = blank ? '' : star.repeat(3 - stars);
  }

  /** Read-first phase (start of update): bring the current tile into view inside the grid (never scrollIntoView:
   *  it would scroll #app). */
  _scrollLevels() {
    const grid = this._el.levelGrid;
    if (!grid || this._current !== 'levels') return;
    try {
      const cur = grid.querySelector('.current');
      if (cur && grid.scrollHeight > grid.clientHeight) grid.scrollTop = Math.max(0, cur.offsetTop - grid.offsetTop - grid.clientHeight / 2 + cur.offsetHeight / 2);
    } catch (_) { /* cosmetic */ }
  }

  _fillShop() {
    const el = this._el;
    const d = this._saveData();
    const coins = d ? d.coins : 0;
    if (!this._shopTween) { this._shopCoinShown = Math.round(coins); if (el.shopCoinsValue) el.shopCoinsValue.textContent = fmtCoins(this._shopCoinShown); }
    if (!this._cardIconsDone) {
      this._cardIconsDone = true;
      for (let i = 0; i < UPGRADE_IDS.length; i++) this._drawCardIcon(UPGRADE_IDS[i]);
    }
    this._refreshCards(coins);
  }

  /** One shop card's procedural icon (canvas + PNG encode), once per session — the boot prewarm encodes them one
   *  per step before the shop surface is shown (round 3), the first _fillShop draws any still missing. */
  _drawCardIcon(id) {
    const c = this._cards ? this._cards[id] : null;
    if (!c || c.iconDone) return;
    c.iconDone = true;
    const draw = CARD_ICON_DRAW[id];
    const url = draw ? drawIcon(CARD_ICON_PX, draw) : '';
    if (url) this._applyIcon(c.icon, 'url("' + url + '")');
  }

  _refreshCards(coins) {
    const d = this._saveData();
    const income = d ? d.lastRunIncome | 0 : 0;
    for (let i = 0; i < UPGRADE_IDS.length; i++) this._refreshCard(UPGRADE_IDS[i], d, coins, income);
  }

  /**
   * Round-3 FTUE: the SHOP buttons (title, results, game over) wear a pulsing "!" badge (css .has-upgrade) while the
   * coins buy at least one more rank. A first clear pays 300–400 coins — every rank-1 upgrade — and nothing told a new
   * player the shop exists (the FTUE run never opened it until it was sent there). Runs when those screens fill and on
   * save:change; writes the DOM only when the answer changes.
   */
  _syncShopBadges() {
    const d = this._saveData();
    const coins = d ? d.coins : 0;
    let any = false;
    for (let i = 0; i < UPGRADE_IDS.length && !any; i++) {
      const id = UPGRADE_IDS[i];
      const u = UPGRADES[id];
      const rank = clamp(d && d.upgrades ? d.upgrades[id] | 0 : 0, 0, u.ranks);
      if (rank < u.ranks && coins >= upgradeCost(id, rank + 1)) any = true;
    }
    if (any === this._shopBadge) return;
    this._shopBadge = any;
    const el = this._el;
    this._badgeButton(el.btnShop, any);
    this._badgeButton(el.btnCompleteShop, any);
    this._badgeButton(el.btnGameoverShop, any);
  }

  _badgeButton(btn, on) {
    if (!btn) return;
    try { btn.classList.toggle('has-upgrade', on); } catch (_) { /* ignore */ }
    if (on) btn.setAttribute('aria-label', (btn.textContent || STRINGS.title.shop) + STRINGS.common.separator + (STRINGS.shop.available || ''));
    else btn.removeAttribute('aria-label');
  }

  _refreshCard(id, d, coins, income) {
    const c = this._cards ? this._cards[id] : null;
    if (!c) return;
    const u = UPGRADES[id];
    const rank = clamp(d && d.upgrades ? d.upgrades[id] | 0 : 0, 0, u.ranks);
    for (let k = 0; k < c.pips.length; k++) {
      try { c.pips[k].classList.toggle('on', k < rank); } catch (_) { /* ignore */ }
    }
    c.pipsHost.setAttribute('aria-label', STRINGS.shop.rank(rank, u.ranks));
    const cur = u.effect(rank);
    const maxed = rank >= u.ranks;
    try { c.card.classList.toggle('maxed', maxed); } catch (_) { /* ignore */ }
    if (maxed) {
      c.effect.textContent = u.fmt(cur);
      c.price.textContent = STRINGS.shop.max;
      c.bIcon.hidden = true;
      c.buy.disabled = true;
      c.buy.removeAttribute('aria-disabled');
      try { c.buy.classList.remove('cant'); c.buy.classList.add('max'); } catch (_) { /* ignore */ }
      c.buy.setAttribute('aria-label', u.name + STRINGS.common.separator + STRINGS.shop.max);
      c.estimate.textContent = '';
      c.estimate.hidden = true;
      return;
    }
    const cost = upgradeCost(id, rank + 1);
    const afford = coins >= cost;
    // one-line caption: an upgrade with a unit suffix prints it once ("9 → 11 soldiers", UPGRADES.*.fmtDelta)
    c.effect.textContent = typeof u.fmtDelta === 'function' ? u.fmtDelta(cur, u.effect(rank + 1))
      : STRINGS.shop.delta('', u.fmt(cur), u.fmt(u.effect(rank + 1))).trim();
    c.price.textContent = String(cost);
    c.bIcon.hidden = false;
    c.buy.disabled = false;
    try { c.buy.classList.remove('max'); c.buy.classList.toggle('cant', !afford); } catch (_) { /* ignore */ }
    if (afford) c.buy.removeAttribute('aria-disabled'); else c.buy.setAttribute('aria-disabled', 'true');
    c.buy.setAttribute('aria-label', STRINGS.shop.buy + ' ' + u.name + STRINGS.common.separator + cost + ' ' + STRINGS.common.coins);
    if (!afford && income > 0) {
      c.estimate.textContent = STRINGS.shop.estimate(Math.ceil((cost - coins) / income));
      c.estimate.hidden = false;
    } else {
      c.estimate.textContent = '';
      c.estimate.hidden = true;
    }
  }

  _buy(id, btn) {
    const save = this.ctx.save;
    const d = this._saveData();
    const u = UPGRADES[id];
    if (!save || !d || !u) return;
    const rank = clamp(d.upgrades ? d.upgrades[id] | 0 : 0, 0, u.ranks);
    if (rank >= u.ranks) return;
    const cost = upgradeCost(id, rank + 1);
    const before = d.coins;
    let ok = false;
    try { ok = !!save.spend(cost); } catch (_) { ok = false; }
    if (!ok) { this._animate(btn, KF_SHAKE, T_SHAKE); return; }
    try { save.setUpgrade(id, rank + 1); } catch (_) { /* the coins are spent; the rank write is the save's job */ }
    P_BUY.id = id;
    P_BUY.rank = rank + 1;
    P_BUY.cost = cost;
    const events = this.ctx.events;
    if (events) events.emit('shop:buy', P_BUY);
    const after = this._saveData() ? this._saveData().coins : before - cost;
    this._shopFrom = this._shopCoinShown >= 0 ? this._shopCoinShown : before;
    this._shopTo = after;
    this._shopT = 0;
    this._shopTween = true;
    this._refreshCards(after);
    const c = this._cards[id];
    if (c) {
      this._animate(c.card, KF_FLASH, T_FLASH);
      const pip = c.pips[rank];
      if (pip) this._animate(pip, KF_POP_IN, T_NAMECARD);
    }
  }

  _updateShopCoins(dt) {
    this._shopT += dt;
    const k = SHOP_TWEEN_S > 0 ? Math.min(1, this._shopT / SHOP_TWEEN_S) : 1;
    const v = Math.round(this._shopFrom + (this._shopTo - this._shopFrom) * ease.outCubic(k));
    if (v !== this._shopCoinShown) {
      this._shopCoinShown = v;
      if (this._el.shopCoinsValue) this._el.shopCoinsValue.textContent = fmtCoins(v);
    }
    if (k >= 1) this._shopTween = false;
  }

  /** save:change → title / shop coin pills and shop cards (whichever is visible). */
  _refreshSaveViews() {
    const cur = this._current === 'settings' ? this._beforeSettings : this._current;
    const d = this._saveData();
    const coins = d ? d.coins : 0;
    if (cur === 'title' && this._el.titleCoinsValue) this._el.titleCoinsValue.textContent = fmtCoins(coins);
    if (cur === 'title' || cur === 'complete' || cur === 'gameover') this._syncShopBadges();
    if (cur === 'shop') {
      if (!this._shopTween) {
        this._shopCoinShown = Math.round(coins);
        if (this._el.shopCoinsValue) this._el.shopCoinsValue.textContent = fmtCoins(this._shopCoinShown);
      }
      this._refreshCards(coins);
    }
  }

  _syncSettings() {
    const el = this._el;
    const s = this._settings();
    if (el.setSound) { el.setSound.value = String(s.sound); this._sliderFill(el.setSound, s.sound); }
    if (el.setMusic) { el.setMusic.value = String(s.music); this._sliderFill(el.setMusic, s.music); }
    if (el.setHaptics) el.setHaptics.checked = !!s.haptics;
    if (el.setReduced) el.setReduced.checked = this._reduced;
    if (el.setHc) el.setHc.checked = !!s.hcGates;
    if (el.setLarge) el.setLarge.checked = !!s.largeText;
    this._syncSeg(el.setQuality, String(s.quality));
    this._syncSeg(el.setSens, String(s.sensitivity));
    if (this._confirmArmed) this._disarmReset();
  }

  /** Slider track fill (css --f, 0..1 from the cached opacity strings): the 48 px-tall input paints its
   *  28 px track with a gradient up to the thumb instead of a clipped thumb shadow (UI-6). */
  _sliderFill(input, value) {
    if (!input || !input.style || !this._opa) return;
    const v = clamp(Math.round(Number(value) || 0), 0, OPA_STEPS);
    try { input.style.setProperty('--f', this._opa[v]); } catch (_) { /* cosmetic */ }
  }

  _syncSeg(seg, value) {
    if (!seg) return;
    const kids = seg.children;
    const num = parseFloat(value);
    for (let i = 0; i < kids.length; i++) {
      const b = kids[i];
      const v = b.dataset ? b.dataset.value : '';
      const on = v === value || (Number.isFinite(num) && parseFloat(v) === num);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      try { b.classList.toggle('on', on); } catch (_) { /* ignore */ }
    }
  }

  _enterComplete() {
    const el = this._el;
    const c = this._cmp;
    const fresh = this._cmpFresh;
    this._cmpFresh = false;
    if (el.completeTitle) el.completeTitle.textContent = STRINGS.complete.title(c.level);
    const stars = el.stars;
    if (stars) {
      for (let i = 0; i < stars.length; i++) {
        const earned = !fresh && i < c.stars;
        stars[i].textContent = earned ? STRINGS.common.star : STRINGS.common.starEmpty;
        try { stars[i].classList.toggle('on', earned); } catch (_) { /* ignore */ }
      }
      const host = stars.length > 0 ? stars[0].parentNode : null;
      if (host && host.setAttribute) host.setAttribute('aria-label', STRINGS.common.star.repeat(c.stars) + STRINGS.common.starEmpty.repeat(3 - c.stars));
    }
    this._cmpCoinShown = fresh ? 0 : c.coins;
    if (el.completeCoins) el.completeCoins.textContent = STRINGS.complete.coins(this._cmpCoinShown);
    const list = el.completeBreakdown;
    if (list && this._doc) {
      list.textContent = '';
      const keys = ['kills', 'gates', 'piles', 'boss', 'bonus'];
      for (let i = 0; i < keys.length; i++) {
        const n = c[keys[i]] | 0;
        if (n <= 0) continue;
        const li = this._doc.createElement('li');
        li.className = 'bd-' + keys[i];
        li.textContent = STRINGS.complete.breakdownLine(STRINGS.complete.breakdown[keys[i]], n);
        list.appendChild(li);
      }
    }
    if (el.completeBest) {
      const d = this._saveData();
      const rec = d && d.levels ? d.levels[c.level] : null;
      const best = rec && Number.isFinite(rec.bestSurvivors) ? rec.bestSurvivors : c.survivors;
      // round-3 FTUE: a first clear prints its survivors alone (the "best" was this very run: "239 survivors · Best survivors
      // at boss: 239"); beating an earlier best says NEW BEST!; otherwise the best stays the target to beat
      const prev = c.level === this._runLevel ? this._prevBest : -2;
      let line = STRINGS.complete.survivors(c.survivors);
      if (prev >= 0 && c.survivors > prev && STRINGS.complete.newBest) line += STRINGS.common.separator + STRINGS.complete.newBest;
      else if (prev !== -1 && best > c.survivors) line += STRINGS.common.separator + STRINGS.complete.best(best);
      el.completeBest.textContent = line;
    }
    this._cmpT = 0;
    this._cmpStarsShown = fresh ? 0 : c.stars;
    this._cmpAnimating = fresh;
    this._syncShopBadges();
  }

  /** Results theatre (J17): stars slam in one by one (0.25 s each, ui_star), then the coins count up (30/s, capped). */
  _updateComplete(dt) {
    this._cmpT += dt;
    const t = this._cmpT;
    const c = this._cmp;
    while (this._cmpStarsShown < c.stars && t >= STAR_STAGGER * (this._cmpStarsShown + 1)) this._revealStar(this._cmpStarsShown++, true);
    const countStart = STAR_STAGGER * (c.stars + 1);
    if (t < countStart) return;
    const dur = c.coins > 0 ? Math.min(COUNT_UP_MAX_S, c.coins / COUNT_RATE) : 0;
    const k = dur > 0 ? Math.min(1, (t - countStart) / dur) : 1;
    const v = Math.round(c.coins * ease.outQuad(k));
    if (v !== this._cmpCoinShown) {
      this._cmpCoinShown = v;
      if (this._el.completeCoins) this._el.completeCoins.textContent = STRINGS.complete.coins(v);
    }
    if (k >= 1 && this._cmpStarsShown >= c.stars) this._cmpAnimating = false;
  }

  _revealStar(i, withSound) {
    const stars = this._el.stars;
    const star = stars && i < stars.length ? stars[i] : null;
    if (star) {
      star.textContent = STRINGS.common.star;
      try { star.classList.add('on'); } catch (_) { /* ignore */ }
      this._animate(star, KF_STAR, T_STAR);
    }
    const audio = this.ctx.audio;
    if (withSound && audio && typeof audio.play === 'function') {
      try { audio.play('ui_star', STAR_PLAY_OPTS[Math.min(i, STAR_PLAY_OPTS.length - 1)]); } catch (_) { /* audio reports its own errors */ }
    }
  }

  /** Tap on the results panel skips the theatre. */
  _finishCompleteAnim() {
    const c = this._cmp;
    while (this._cmpStarsShown < c.stars) this._revealStar(this._cmpStarsShown++, this._cmpStarsShown === c.stars);
    this._cmpCoinShown = c.coins;
    if (this._el.completeCoins) this._el.completeCoins.textContent = STRINGS.complete.coins(c.coins);
    this._cmpAnimating = false;
  }

  _fillGameover() {
    const f = this._fail;
    // round 3 (GDD §14 UI-33): the failed level as a kicker above SQUAD LOST, spelled like the HUD and results ('LEVEL 7')
    const lv = this._el.gameoverLevel;
    if (lv) lv.textContent = (STRINGS.gameover.level || STRINGS.hud.level)(f.level);
    if (this._el.gameoverInfo) this._el.gameoverInfo.textContent = STRINGS.gameover.info(Math.round(clamp(f.fraction, 0, 1) * 100), f.coinsKept);
    this._syncShopBadges();
  }

  _fillEndless() {
    const host = this._el.endlessStats;
    const doc = this._doc;
    if (!host || !doc) return;
    const e = this._end;
    host.textContent = '';
    const line = (cls, text) => { const d = doc.createElement('div'); d.className = cls; d.textContent = text; host.appendChild(d); };
    if (e.newBest) line('new-best', STRINGS.endless.newBest);
    line('es-distance', STRINGS.endless.distance(e.distance));
    line('es-score', STRINGS.endless.score(e.score));
    line('es-best', STRINGS.endless.best(e.best));
    line('es-coins', STRINGS.endless.coins(e.coins));
  }

  // -------------------------------------------------------------------------------------------
  // DOM input (buttons call systems directly, §10.3; every click also emits ui:button)
  // -------------------------------------------------------------------------------------------

  _click(e) {
    const t = e ? e.target : null;
    if (!t || typeof t.closest !== 'function') return;
    let btn = null;
    try { btn = t.closest('button'); } catch (_) { btn = null; }
    if (!btn || (this._el.ui && !this._el.ui.contains(btn))) {
      // a tap anywhere on the results panel skips the stars / count-up theatre
      if (this._cmpAnimating && this._current === 'complete') {
        let onPanel = false;
        try { onPanel = !!t.closest('#scr-complete'); } catch (_) { onPanel = false; }
        if (onPanel) this._finishCompleteAnim();
      }
      return;
    }
    if (btn.disabled) return;
    const id = btn.id || '';
    // round 6: FIRE fired on its pointerdown (or the key); only a click with no activation just before it (Enter on the
    // focused button, assistive tech) fires here. No ui:button — the weapon's own sting is the feedback, not ui_tap
    if (id === 'btn-fire') { if (this._realNow() >= this._fireClickUntil) this._fireTap(); return; }
    P_BUTTON.id = id || this._buttonKind(btn);
    const events = this.ctx.events;
    if (events) events.emit('ui:button', P_BUTTON);
    this._route(btn, id);
  }

  _buttonKind(btn) {
    if (btn.hasAttribute('data-back')) return 'back';
    const ds = btn.dataset || {};
    if (ds.level !== undefined) return 'level';
    if (ds.endless !== undefined) return 'endless';
    if (btn.classList.contains('buy')) return 'buy';
    const p = btn.parentNode;
    if (p && p.classList && p.classList.contains('seg')) return 'seg';
    return 'button';
  }

  _route(btn, id) {
    const ctx = this.ctx;
    const level = ctx.level, engine = ctx.engine, state = ctx.state;
    switch (id) {
      case 'btn-pause': if (engine) engine.pause(); return;
      case 'btn-settings':
      case 'btn-pause-settings': this.showScreen('settings'); return;
      case 'btn-play': this._startLevel(this._highestUnlocked(), btn); return;
      case 'btn-shop':
      case 'btn-complete-shop':
      case 'btn-gameover-shop': if (state) state.set('shop'); return;
      case 'btn-levels': if (state) state.set('levels'); return;
      case 'btn-endless':
      case 'btn-endless-retry': if (level) level.startEndless(); return;
      case 'btn-fullscreen': this._toggleFullscreen(); return;
      case 'btn-resume': if (engine) engine.resume(); return;
      case 'btn-restart':
      case 'btn-replay':
      case 'btn-retry': this._restartLevel(btn); return;
      case 'btn-quit':
      case 'btn-complete-home':
      case 'btn-home':
      case 'btn-endless-home': if (level) level.quitToTitle(); return;
      case 'btn-next': this._startLevel((this._cmp.level | 0) + 1, btn); return;
      case 'btn-reset-save': this.confirmReset(); return;
      case 'btn-reload': this._reload(); return;
      case 'btn-update': this._applyUpdate(); return;      // round 5: the title's "Update ready" pill (sw.js v4)
      default: break;
    }
    if (btn.hasAttribute('data-back')) { this._back(); return; }
    const ds = btn.dataset || {};
    if (ds.level !== undefined) {
      const n = parseInt(ds.level, 10);
      if (n >= 1) this._startLevel(n, btn);
      return;
    }
    if (ds.endless !== undefined) { if (level) level.startEndless(); return; }
    if (btn.classList.contains('buy')) { this._buy(ds.id, btn); return; }
    const seg = btn.parentNode;
    if (seg && seg.classList && seg.classList.contains('seg')) this._segPick(seg, btn);
  }

  /**
   * Round 5 integration: a menu start (PLAY, NEXT, a level tile) goes through level.requestStart — a memoized or authored
   * script starts at once; a miss generates in frame slices first (no frame waits on a whole generateLevel), and the tapped
   * button wears .starting meanwhile (taken off with the next screen change). Older levels without requestStart: start().
   */
  _startLevel(n, btn) {
    const level = this.ctx.level;
    if (!level) return;
    if (this._startingBtn) { try { this._startingBtn.classList.remove('starting'); } catch (_) { /* ignore */ } this._startingBtn = null; }
    if (typeof level.requestStart !== 'function') { level.start(n); return; }
    if (level.requestStart(n) || !btn || !btn.classList) return;
    try { btn.classList.add('starting'); this._startingBtn = btn; } catch (_) { /* cosmetic */ }
  }

  /** Round 5 integration: RETRY / REPLAY / RESTART through level.requestRestart (same rule as restart(), no synchronous
   *  generation; .starting while it waits). Older levels without it: restart(). */
  _restartLevel(btn) {
    const level = this.ctx.level;
    if (!level) return;
    if (this._startingBtn) { try { this._startingBtn.classList.remove('starting'); } catch (_) { /* ignore */ } this._startingBtn = null; }
    if (typeof level.requestRestart !== 'function') { level.restart(); return; }
    if (level.requestRestart() || !btn || !btn.classList) return;
    try { btn.classList.add('starting'); this._startingBtn = btn; } catch (_) { /* cosmetic */ }
  }

  /** BACK (§10.3): closes the settings overlay, else returns to title / complete / gameover. */
  _back() {
    const state = this.ctx.state;
    if (this._current === 'settings') {
      this.showScreen(state ? this._mapState(state.current, state.data) : this._beforeSettings);
      return;
    }
    if (!state) return;
    const prev = state.prev;
    state.set(BACK_STATES.indexOf(prev) !== -1 ? prev : 'title');
  }

  _segPick(seg, btn) {
    const v = btn.dataset ? btn.dataset.value : '';
    if (seg.id === 'set-quality') {
      if (QUALITY_OPTIONS.indexOf(v) === -1) return;
      this._setSetting('quality', v);
      this._syncSeg(seg, v);
    } else if (seg.id === 'set-sens') {
      const n = parseFloat(v);
      if (!(n > 0)) return;
      this._setSetting('sensitivity', n);
      this._syncSeg(seg, v);
    }
  }

  /** Settings controls: sliders on `input` (live volume), toggles on `change`. */
  _input(e, isChange) {
    const t = e ? e.target : null;
    if (!t || !t.id) return;
    switch (t.id) {
      case 'set-sound':
      case 'set-music': {
        if (isChange) return;
        const v = clamp(parseInt(t.value, 10) || 0, 0, 100);
        this._sliderFill(t, v);
        this._setSetting(t.id === 'set-sound' ? 'sound' : 'music', v);
        return;
      }
      case 'set-haptics': if (isChange) this._setSetting('haptics', !!t.checked); return;
      case 'set-reduced': if (isChange) this._setSetting('reducedMotion', !!t.checked); return;
      case 'set-hc': if (isChange) this._setSetting('hcGates', !!t.checked); return;
      case 'set-large': if (isChange) this._setSetting('largeText', !!t.checked); return;
      default: return;
    }
  }

  /** save.setSetting(key, value), then settings:change (§10.3 — ui never calls engine/audio setters itself). */
  _setSetting(key, value) {
    const save = this.ctx.save;
    if (save && typeof save.setSetting === 'function') {
      try { save.setSetting(key, value); } catch (_) { /* in-memory value still broadcast below */ }
    }
    this._emitSetting(key, value);
    if (key === 'largeText' || key === 'reducedMotion' || key === 'hcGates') {
      this._applyHtmlClasses();
      if (key === 'reducedMotion' && this._el.setReduced) this._el.setReduced.checked = this._reduced;
    }
  }

  _emitSetting(key, value) {
    const events = this.ctx.events;
    if (!events) return;
    P_SETTINGS.key = key;
    P_SETTINGS.value = value;
    events.emit('settings:change', P_SETTINGS);
  }

  /** Escape closes the settings overlay / leaves levels and shop (consumed so engine does not also resume). */
  _key(e) {
    if (!e) return;
    if (this._pointerMode) this._setPointerMode(false);      // keyboard user: show the focus ring again
    const code = e.code || e.key;
    if (code === 'Space' || code === ' ') { this._fireKey(e); return; }   // round 6: Space fires a stored weapon
    if (code !== 'Escape' || e.repeat) return;
    const cur = this._current;
    if (cur !== 'settings' && cur !== 'levels' && cur !== 'shop') return;
    try { e.preventDefault(); e.stopPropagation(); } catch (_) { /* ignore */ }
    P_BUTTON.id = 'back';
    const events = this.ctx.events;
    if (events) events.emit('ui:button', P_BUTTON);
    this._back();
  }

  /** Input modality (UI-14): html.pointer-input scopes out the :focus-visible ring (css) after a pointer press
   *  and from boot until the first key press; any keydown removes it so Tab / arrows show focus. */
  _setPointerMode(on) {
    this._pointerMode = on;
    const doc = this._doc;
    if (!doc || !doc.documentElement) return;
    try { doc.documentElement.classList.toggle('pointer-input', on); } catch (_) { /* ignore */ }
  }

  _toggleFullscreen() {
    const d = this._doc;
    if (!d || !this._fsAvailable) return;
    try {
      const active = d.fullscreenElement || d.webkitFullscreenElement;
      if (active) {
        const exit = d.exitFullscreen || d.webkitExitFullscreen;
        if (typeof exit === 'function') {
          const p = exit.call(d);
          if (p && typeof p.catch === 'function') p.catch(NOOP);
        }
        return;
      }
      const root = d.documentElement;
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (typeof req !== 'function') return;
      const p = req.call(root, FULLSCREEN_OPTS);
      if (p && typeof p.then === 'function') p.then(lockPortrait, NOOP);
    } catch (_) { /* refused (iframe / policy): nothing to do */ }
  }

  _syncFullscreenButton() {
    const btn = this._el ? this._el.btnFullscreen : null;
    const d = this._doc;
    if (!btn || !d) return;
    let on = false;
    try { on = !!(d.fullscreenElement || d.webkitFullscreenElement); } catch (_) { on = false; }
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    this._coinPosDirty = true;
    this._puPosDirty = true;
  }

  _reload() {
    try { if (typeof location !== 'undefined' && location) location.reload(); } catch (_) { /* sandboxed */ }
  }

  _hideErrorToast() {
    this._errorTimer = 0;
    if (!this._fatalShown && this._el && this._el.errorBox) this._el.errorBox.hidden = true;
  }

  _disarmReset() {
    this._confirmArmed = false;
    const btn = this._el ? this._el.btnResetSave : null;
    if (!btn) return;
    btn.textContent = STRINGS.settings.resetSave;
    try { btn.classList.remove('confirm'); } catch (_) { /* ignore */ }
  }

  // -------------------------------------------------------------------------------------------
  // Screen positions for fx flights (CSS px relative to #app; cached until layout changes)
  // -------------------------------------------------------------------------------------------

  /** Centre of `node` relative to #app into this._mx / this._my; false when it is not laid out. */
  _measureRaw(node) {
    const app = this._el ? this._el.app : null;
    if (!node || !app || typeof node.getBoundingClientRect !== 'function') return false;
    try {
      const r = node.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      const a = app.getBoundingClientRect();
      this._mx = r.left - a.left + r.width * 0.5;
      this._my = r.top - a.top + r.height * 0.5;
      return true;
    } catch (_) {
      return false;
    }
  }

  _measureCoin() {
    if (this._measureRaw(this._el.coinIcon) || this._measureRaw(this._el.coins)) {
      this._coinX = this._mx;
      this._coinY = this._my;
      this._coinPosDirty = false;
      return;
    }
    // HUD not laid out (hidden): approximate the top-right coin pill, retry on the next call
    const app = this._el.app;
    const w = app && app.clientWidth > 0 ? app.clientWidth : REF_W;
    this._coinX = w - COIN_FALLBACK_PX[0] * this._uiScale;
    this._coinY = COIN_FALLBACK_PX[1] * this._uiScale;
  }

  _measureInto(node, k) {
    if (this._measureRaw(node)) {
      this._puPos[k * 2] = this._mx;
      this._puPos[k * 2 + 1] = this._my;
      this._puPosOk[k] = 1;
    }
  }

  _fallbackTop(out) {
    const app = this._el ? this._el.app : null;
    const w = app && app.clientWidth > 0 ? app.clientWidth : REF_W;
    out.x = w * 0.5;
    out.y = PILL_ROW_FALLBACK_PX * this._uiScale;
  }

  // -------------------------------------------------------------------------------------------
  // Icons and animation helpers
  // -------------------------------------------------------------------------------------------

  /** After render.init: coin / shield icons from the texture factory, the steer-hint touch icon. */
  _setupIcons() {
    if (this._iconsReady || !this._doc) return;
    const coin = this._iconUrl('coins');
    if (coin) {
      try {
        const nodes = this._doc.querySelectorAll('#ui .coin-icon');
        for (let i = 0; i < nodes.length; i++) this._applyIcon(nodes[i], coin);
      } catch (_) { /* cosmetic */ }
    }
    const armor = this._iconUrl('gear.armor');
    if (armor && this._el.shieldIcon) this._applyIcon(this._el.shieldIcon, armor);
    const hand = drawIcon(UIJ.hintHandPx, drawHandIcon);
    if (hand && this._el.hintHand) this._applyIcon(this._el.hintHand, 'url("' + hand + '")');
    this._iconsReady = !!coin;
  }

  /** 'url("data:…")' for an item icon from render.textures.iconDataURL (cached once the textures exist). */
  _iconUrl(id) {
    const hit = this._iconCache.get(id);
    if (hit !== undefined) return hit;
    const render = this.ctx.render;
    const tex = render ? render.textures : null;
    if (!tex || typeof tex.iconDataURL !== 'function') return '';
    let url = '';
    try { url = tex.iconDataURL(id, PILL_ICON_PX) || ''; } catch (_) { url = ''; }
    const css = url ? 'url("' + url + '")' : '';
    this._iconCache.set(id, css);
    return css;
  }

  /** Round 6: 'url("data:…")' of a weapon pictogram at FIRE_ICON_PX for the FIRE button (cached; encoded at boot). */
  _fireIconUrl(id) {
    const hit = this._fireIcons.get(id);
    if (hit !== undefined) return hit;
    const render = this.ctx.render;
    const tex = render ? render.textures : null;
    if (!tex || typeof tex.iconDataURL !== 'function') return this._iconUrl(id);
    let url = '';
    try { url = tex.iconDataURL(id, FIRE_ICON_PX) || ''; } catch (_) { url = ''; }
    const css = url ? 'url("' + url + '")' : this._iconUrl(id);
    if (css) this._fireIcons.set(id, css);
    return css;
  }

  // -------------------------------------------------------------------------------------------
  // Round 6 — HUD FIRE button (stored weapons)
  // -------------------------------------------------------------------------------------------

  /**
   * Model → DOM, every frame (cheap getter reads; DOM writes only on change). Shown while a weapon is stored or running
   * (ready: the next stored pictogram in a full ring of its colour, pulsing; busy: the ring drains with the running
   * weapon's time left and the pictogram dims — the next stored one if any, else the running one). "×2" badge with two
   * stored. #hud.fire-on while shown (css moves the hint pill clear of it).
   */
  _updateFire() {
    const el = this._el;
    const b = el ? el.btnFire : null;
    if (!b) return;
    const w = this.ctx.weapons;
    let count = 0, active = null, next = null, left = 0;
    if (w && typeof w.storedId === 'function') {
      try {
        count = w.storedCount | 0;
        active = w.weapon;
        next = count > 0 ? w.storedId(0) : null;
        left = active !== null ? w.weaponTimeLeft : 0;
      } catch (_) { count = 0; active = null; next = null; left = 0; }
    }
    const show = count > 0 || active !== null;
    if (show !== this._fireShown) {
      this._fireShown = show;
      b.hidden = !show;
      this._puPosOk[FIRE_POS] = 0;
      const hud = el.hud;
      if (hud) { try { hud.classList.toggle('fire-on', show); } catch (_) { /* ignore */ } }
      if (show) { this._cancelAnim(this._fireAnim); this._fireAnim = this._animate(b, KF_POP_IN, T_NAMECARD); }
      else this._gpA = false;
    }
    if (!show) return;
    const busy = active !== null;
    const id = next !== null ? next : active;
    if (id !== this._fireId) {
      this._fireId = id;
      b.dataset.id = id;
      this._applyIcon(el.fireIcon, this._fireIconUrl(id));
      this._fireAria(busy, active, id);
    }
    const busyI = busy ? 1 : 0;
    if (busyI !== this._fireBusy) {
      const wasBusy = this._fireBusy === 1;
      this._fireBusy = busyI;
      try { b.classList.toggle('busy', busy); b.classList.toggle('ready', !busy); } catch (_) { /* ignore */ }
      b.setAttribute('aria-disabled', busy ? 'true' : 'false');
      this._fireAria(busy, active, id);
      if (busy && !wasBusy) { this._cancelAnim(this._fireAnim); this._fireAnim = this._animate(b, KF_PUNCH, T_PUNCH); }   // accepted
    }
    if (count !== this._fireCount) {
      this._fireCount = count;
      if (el.fireBadge) {
        const on = count >= 2;
        if (on) el.fireBadge.textContent = STRINGS.fire.badge(count);
        if (el.fireBadge.hidden === on) el.fireBadge.hidden = !on;
      }
    }
    const ringId = busy ? active : id;
    if (ringId !== this._fireRingId) {
      this._fireRingId = ringId;
      this._fireRingStr = this._ringStrings(ringId);
      this._fireRing = -1;
      const entry = itemEntry(ringId);                 // on change only (itemEntry slices the id)
      this._fireDur = entry && entry.duration > 0 ? entry.duration : 0;
    }
    const dur = this._fireDur;
    const r = busy && dur > 0 ? Math.round(clamp(left / dur, 0, 1) * RING_STEPS) : RING_STEPS;
    if (r !== this._fireRing) {
      this._fireRing = r;
      if (el.fireRing && this._fireRingStr) el.fireRing.style.background = this._fireRingStr[r];
    }
  }

  /** Screen-reader name of the FIRE button ("Fire rocket" / "shotgun firing"); built on change only. */
  _fireAria(busy, active, id) {
    const b = this._el.btnFire;
    if (!b) return;
    const name = (busy ? active : id) || '';
    const short = name.indexOf('.') >= 0 ? name.slice(name.indexOf('.') + 1) : name;
    b.setAttribute('aria-label', busy ? STRINGS.fire.ariaBusy(short) : STRINGS.fire.aria(short));
  }

  /** pointerdown on the FIRE button (primary button / touch / pen): fire now; no focus, no compat mouse events. */
  _firePointer(e) {
    if (!e || (typeof e.button === 'number' && e.button > 0)) return;
    try { e.preventDefault(); } catch (_) { /* ignore */ }   // the button never takes focus: keyboard steering stays on #app
    this._fireTap();
  }

  /** Space while playing (not repeated): FIRE. preventDefault so a focused button's own Space click never doubles it. */
  _fireKey(e) {
    const st = this.ctx.state;
    if (e.repeat || !st || typeof st.is !== 'function' || !st.is('playing')) return;
    try { e.preventDefault(); } catch (_) { /* ignore */ }
    this._fireTap();
  }

  /** Gamepad A (rising edge) while the FIRE button shows; polled only after a gamepadconnected event (guarded). */
  _pollGamepadFire() {
    if (!this._gpOk || typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    let down = false;
    try {
      const pads = navigator.getGamepads();
      if (pads) {
        for (let i = 0; i < pads.length; i++) {
          const p = pads[i];
          if (!p || !p.connected || !p.buttons || p.buttons.length <= GAMEPAD_FIRE_BUTTON) continue;
          const bt = p.buttons[GAMEPAD_FIRE_BUTTON];
          if (bt && bt.pressed) { down = true; break; }
        }
      }
    } catch (_) { this._gpOk = false; return; }
    if (down && !this._gpA) this._fireTap();
    this._gpA = down;
  }

  /**
   * One FIRE press (pointer, Space, gamepad A, or a bare click): weapons.requestFire() while playing. Refused (a weapon
   * is running — the stored one waits for it, lead decision) → a small head-shake on the button (none under reduced
   * motion); accepted → the button turns busy on the next step's weapon:start (punch, draining ring).
   */
  _fireTap() {
    this._fireClickUntil = this._realNow() + FIRE_CLICK_SUPPRESS_S;
    const st = this.ctx.state;
    if (!st || typeof st.is !== 'function' || !st.is('playing')) return;
    const w = this.ctx.weapons;
    let ok = false;
    if (w && typeof w.requestFire === 'function') { try { ok = w.requestFire() === true; } catch (_) { ok = false; } }
    if (!ok && this._fireShown && this._el.btnFire) {
      this._cancelAnim(this._fireAnim);
      this._fireAnim = this._animate(this._el.btnFire, KF_FIRE_DENY, T_FIRE_DENY);
    }
  }

  _applyIcon(node, css) {
    if (!node || !css) return;
    const st = node.style;
    st.backgroundImage = css;
    st.backgroundSize = 'contain';
    st.backgroundRepeat = 'no-repeat';
    st.backgroundPosition = 'center';
  }

  /** conic-gradient ring strings for one item (its WEAPONS / GEAR colour over the panel colour), built once per id. */
  _ringStrings(id) {
    const hit = this._ringCache.get(id);
    if (hit) return hit;
    const entry = itemEntry(id);
    const col = hexCss(entry && Number.isFinite(entry.color) ? entry.color : PALETTE.flash.weaponEdge);
    const track = rgbaCss(PALETTE.ui.bgPanel, PALETTE.ui.bgPanelAlpha);
    const arr = new Array(RING_STEPS + 1);
    for (let i = 0; i <= RING_STEPS; i++) {
      const deg = (i * 360 / RING_STEPS).toFixed(1);
      arr[i] = 'conic-gradient(' + col + ' 0deg ' + deg + 'deg, ' + track + ' ' + deg + 'deg 360deg)';
    }
    this._ringCache.set(id, arr);
    return arr;
  }

  /** Web Animations (guarded); skipped under reduced motion. Returns the Animation or null. */
  _animate(node, keyframes, timing) {
    if (!node || this._reduced || typeof node.animate !== 'function') return null;
    try { return node.animate(keyframes, timing); } catch (_) { return null; }
  }

  _cancelAnim(anim) {
    if (!anim) return;
    try { anim.cancel(); } catch (_) { /* ignore */ }
  }


  /** Focus: the screen's primary button (current level tile, BACK), else its first enabled control; HUD → #app (keyboard steering). */
  _focusFirst(scr) {
    let target = null;
    try {
      if (!scr) target = this._el.app;
      else target = scr.querySelector('.btn.primary:not(.buy):not([disabled]):not([hidden])')
        || scr.querySelector('.tile.current')
        || scr.querySelector('[data-back]')
        || scr.querySelector('button:not([disabled]):not([hidden]), input:not([disabled])');
    } catch (_) { target = null; }
    if (!target || typeof target.focus !== 'function') return;
    try { target.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
  }
}

/** Fullscreen success: try to keep the game in portrait (manifest orientation), ignore refusals. */
function lockPortrait() {
  try {
    if (typeof screen !== 'undefined' && screen && screen.orientation && typeof screen.orientation.lock === 'function') {
      const p = screen.orientation.lock('portrait');
      if (p && typeof p.catch === 'function') p.catch(NOOP);
    }
  } catch (_) { /* unsupported */ }
}
