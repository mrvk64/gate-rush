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
//            boss fill), results animations, confirm-reset timeout. Round 7 (r7, flow-coins:2): a state's screen
//            is also applied at the end of the click / key task that caused it and by a 250 ms fallback timer;
//            one wallet model writes every coin pill (HUD, title, shop: flow-coins:5).
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
// state is 'paused' (UI-28, ARCH §2.2); flashes, vignette and the reset confirm use _clock. Round 7 (r7, flow-coins:6):
// the coin tweens and the results theatre run on real time (performance.now() steps, each clamped to JUICE.ui.realDtMax).
//
// Per-frame rule (§14 rule 2): update() allocates nothing in steady state. Percent / opacity / seconds
// strings come from tables built once in init(); other strings are built only when the displayed value
// changes (coin text, shield value, results count-up). Web Animations (guarded) are started only on
// discrete transitions (a screen, a star, a purchase), never per frame, and are skipped under reduced
// motion. Browser APIs (matchMedia, fullscreen, element.animate, canvas, focus) are all guarded; the
// module touches no browser global at import time.
import { clamp, ease, fmtCoins, fmtCompact, storage, hasHaptics } from './util.js';
import {
  STRINGS, HINTS, JUICE, LEVELS, BOSSES, UPGRADES, upgradeCost, PALETTE, RENDER, WEAPONS, GEAR, PICKUPS, SQUAD,
  DISTRICTS, DISTRICT_RULES, districtForLevel,
  starNeed, eBossOf,                                    // round 7 (r7, explain:0): star thresholds on the results / title captions
  CODEX, GATE_RULES,                                    // round 7 (r7, teaching:5): the FIELD GUIDE and its gate chips
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
const COIN_TWEEN_S = UIJ.coinTweenMs / 1000;            // 300 ms coin tween (r7: the ONE wallet display — HUD, title and shop pills)
// Hint timings run on the THEATRE clock (_tclock: the engine's frame step, paused time excluded — not real time below
// 20 fps until WP-A's frame-following step lands). Round 7 (r7, teaching:0 A): a hint stays max(HINT_S, base + per word ×
// words) s, at most HINT_MAX_S (the 9-word red lesson 3.7 s)
const HINT_S = UIJ.hintSeconds;                         // 3.0 s minimum
const HINT_BASE_S = UIJ.hintBaseSeconds > 0 ? UIJ.hintBaseSeconds : 0;
const HINT_WORD_S = UIJ.hintPerWordSeconds > 0 ? UIJ.hintPerWordSeconds : 0;
const HINT_MAX_S = UIJ.hintMaxSeconds > HINT_S ? UIJ.hintMaxSeconds : HINT_S;
const HINT_MARK_S = UIJ.hintMarkSeconds > 0 ? UIJ.hintMarkSeconds : 0;          // r7 (teaching:0 F): marked done after this long on screen
const HINT_IDLE_S = UIJ.hintIdleS > 0 ? UIJ.hintIdleS : Infinity;              // r7 final fix: ...and only with trusted input this recent (_attended)
const HINT_HOLD_MAX_S = UIJ.hintHoldMaxSeconds > 0 ? UIJ.hintHoldMaxSeconds : HINT_MAX_S;   // r7: a subject-bound hint's longest stay
const HINT_CUT_S = UIJ.hintCutSeconds >= 0 ? UIJ.hintCutSeconds : 0.15;          // r7: a priority hint cuts a normal one to this
const HINT_WORD_RE = /\s+/;                             // words of a hint (\s includes the no-break spaces HINTS use)
// r7 (teaching:0 D): the pill's 2 px rim by what the lesson is about — warn (it costs soldiers / dodge it), gain (it grows
// the squad); the rest are info (no rim). Hint ids with a prefix match by prefix ('dodge.*', 'boss.<arch>.<n>')
const HINT_TONE = Object.freeze({ red: 'warn', single: 'warn', bite: 'warn', brute: 'warn', spitter: 'warn', runner: 'warn',
  crawler: 'warn', lesser: 'warn', 'boss.stomp': 'warn', more: 'gain', x2: 'gain', div: 'gain', tryx2: 'gain' });
// r7 (teaching:0, lead decision): the core gate lessons get a brief slow-mo the first time they are on screen (JUICE.slowmo.lesson)
const LESSON_SLOWMO = Object.freeze({ red: true, single: true, div: true });
const HINT_BACK_OPTS = { hold: 0, until: null, event: -1 };   // reused: the options of a cut hint re-queued (_hideHintDom)
// r7 (teaching:5): the FIELD GUIDE's entry ids in order, and their save keys ('seen:<id>' set by level at the first
// encounter, 'read:<id>' set when the guide that showed it closes), built once; 'codex:v1' = the one-time migration ran
const GUIDE_IDS = Object.freeze(CODEX.sections.reduce((a, s) => a.concat(s.ids), []));
const SEEN_K = Object.freeze(GUIDE_IDS.reduce((o, id) => { o[id] = 'seen:' + id; return o; }, {}));
const READ_K = Object.freeze(GUIDE_IDS.reduce((o, id) => { o[id] = 'read:' + id; return o; }, {}));
const CODEX_MIGRATED = 'codex:v1';
// r7 (teaching:5): how each entry's icon is drawn (css .ci-*): an item pictogram (texture factory), a gate chip in the
// gate's colours (GATE_RULES.colors) with its glyph, a key cap, a zombie face (PALETTE.zombie), the boss skull, or a small
// drawing of a HUD part. Presentation only — the numbers in the copy come from data.js
const CODEX_ICON_DEFAULT = Object.freeze({ k: 'key', t: '?' });
const CODEX_ICON = (() => {
  const o = {
    'ctl.steer': { k: 'key', t: '← →' }, 'ctl.fire': { k: 'key', t: 'SPACE' }, 'ctl.pause': { k: 'key', t: 'ESC' }, 'ctl.mute': { k: 'key', t: 'M' },
    'gate.plus': { k: 'gate', g: 'plus', t: '+5' }, 'gate.max': { k: 'gate', g: 'max', t: 'MAX' }, 'gate.minus': { k: 'gate', g: 'minus', t: '−8' },
    'gate.mult': { k: 'gate', g: 'mult', t: '×2' }, 'gate.div': { k: 'gate', g: 'div', t: '÷2' }, 'gate.zero': { k: 'gate', g: 'zero', t: '×1' },
    'gate.item': { k: 'gate', g: 'item', t: '' }, 'gate.single': { k: 'gate', g: 'minus', t: '−N', wide: true },
    'gate.guards': { k: 'zombie', z: 'walker', t: '' },
    'pickup.crate': { k: 'crate' }, 'pickup.coins': { k: 'item', id: 'coins' }, coins: { k: 'item', id: 'coins' },
    'pickup.duplicate': { k: 'item', id: 'coins' },
    'hud.progress': { k: 'bar' }, 'hud.bossbar': { k: 'bossbar' }, 'hud.stars': { k: 'stars', t: '★★★' }, 'hud.fire': { k: 'fire', t: 'FIRE' },
    'hud.shield': { k: 'item', id: 'gear.armor' }, 'hud.pills': { k: 'pill' },
  };
  for (let s = 0; s < CODEX.sections.length; s++) {
    const sec = CODEX.sections[s];
    for (const id of sec.ids) {
      if (o[id]) continue;
      if (sec.id === 'weapons' || sec.id === 'gear' || sec.id === 'troops') o[id] = { k: 'item' };
      else if (sec.id === 'zombies') o[id] = { k: 'zombie', z: id.slice(id.indexOf('.') + 1) };
      else if (sec.id === 'bosses') o[id] = { k: 'boss' };
    }
  }
  return Object.freeze(o);
})();
// r7 (teaching:5): the NEW card (#newcard) — JUICE.ui.newCardSeconds on screen, JUICE.ui.newCardQueueMax waiting
const NEWCARD_S = UIJ.newCardSeconds > 0 ? UIJ.newCardSeconds : 3.5;
const NEWCARD_QMAX = UIJ.newCardQueueMax > 0 ? UIJ.newCardQueueMax : 2;
const PHASE_LABEL_S = UIJ.bossPhaseLabelSeconds > 0 ? UIJ.bossPhaseLabelSeconds : 1.5;   // r7 (teaching:3): "PHASE 2" in the bar's name
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
const HINT_QUEUE_AGE_S = UIJ.hintQueueMaxAgeS > 0 ? UIJ.hintQueueMaxAgeS : 10;   // UI-25: a queued hint older than this is dropped
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
// round 7 (r7, layout:0 / :1): the scroll box of each screen that has one, by screen id (SCREEN_EL_ID keys) → element
// id. While that screen is up, a wheel anywhere on it (ui._wheel) and PageUp / PageDown / Home / End with the focus
// outside the box (ui._pageKey) scroll it: the boxes are narrower than their screens, and the screens let the pointer
// through to the canvas, so a wheel beside the grid or next to BACK (where the pointer rests after the title button that
// opened the screen) scrolled nothing, and SHOP opens with the focus on BACK. To give another screen the same
// forwarding, add one entry here (its element is looked up once, in _cacheDom).
const SCROLL_LIST_ID = Object.freeze({ title: 'scr-title', levels: 'level-grid', shop: 'shop-list', endless: 'endless-stats',
  guide: 'guide-list' });                               // r7 (teaching:5): the FIELD GUIDE's list
// r7 fix round 3 (layout verifier): the scroll boxes whose edges fade (css mask). The fade marks more content beyond an
// edge, so each edge fades only while there is some: .fade-t once scrolled down, .fade-b until the end is reached (the
// last shop card's "~1 run away" read dimmed when the list fitted exactly at 568 × 320 / 585 × 340 / 640 × 360, and up to
// 340 px tall even scrolled to the end: the 18 px fade outlasted the 3–7 px bottom pad). Set on scroll and on any size
// change of the box or its rows (ResizeObserver), never per frame
const FADE_LIST_IDS = Object.freeze(['level-grid', 'shop-list', 'guide-list']);
// r7 (layout:3): a key typed into one of these is text, not the F (fullscreen) command — engine.js's TEXT_ENTRY_SELECTOR
const TEXT_ENTRY_SELECTOR = 'input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="email"], input[type="password"], input[type="tel"], input[type="url"], textarea, select, [contenteditable]:not([contenteditable="false"])';
const WHEEL_LINE_PX = 40;                               // structural: px per wheel "line" (deltaMode 1, Firefox) — Chrome's own line step
const PAGE_FRAC = 0.85;                                 // structural: a PageUp / PageDown step in box heights (the browser's own page step is ≈ 0.85–0.9)
const BOSS_NAME_PAD_R = 4;                              // structural: #boss-name's right padding in px (css), which may sit under the coin pill
// round 7 (r7, flow-coins:2): screen switches no longer wait for a frame — the click / key task that changed the state shows
// its screen, a state change from elsewhere shows at the next frame or after this fallback (rAF starved: a busy no-GPU box)
const PENDING_FALLBACK_MS = UIJ.pendingScreenFallbackMs > 0 ? UIJ.pendingScreenFallbackMs : 250;   // JUICE.ui.pendingScreenFallbackMs
// r7 (flow-coins:2): stale-click guard — a trusted pointer click pressed before the screen under it was painted was aimed at
// the screen before (a second NEXT restarted the level; a late results HOME hit the HUD pause button in the same corner).
// "Painted" = the end of the frame that renders the switch (see showScreen / _armPaintMark), at most this long after it
const STALE_CLICK_MAX_MS = UIJ.staleClickMaxMs > 0 ? UIJ.staleClickMaxMs : 2000;   // JUICE.ui.staleClickMaxMs
// r7 fix (flow-coins:0 / :2): the HUD's pause and FIRE buttons take pointer presses only this long after the HUD of a new run
// has painted — results HOME sits where the HUD pause button appears, and a HOME press 0.73 s after the next level painted
// paused it (a press that soon was aimed at the results; nobody pauses a level in its first second)
const HUD_ARM_MS = UIJ.hudArmMs > 0 ? UIJ.hudArmMs : 1000;   // JUICE.ui.hudArmMs
// r7 (flow-coins:6): coin tweens and the results theatre on real time, one frame's step clamped (JUICE.ui.realDtMax)
const REAL_DT_MAX = UIJ.realDtMax > 0 ? UIJ.realDtMax : 0.25;
// r7 (explain:7): results chip order (run.breakdown keys; 'bonus' becomes the ★ and Survivors chips when split)
const BD_KEYS = Object.freeze(['kills', 'gates', 'piles', 'boss', 'bonus']);
// r7 fix (teaching:3): the boss tagline's phrase separators (STRINGS.boss.tagline: " · ", and data.js's DASH — a no-break
// space, "—", a space), split with the separator kept: each phrase but the last ends with its own mark, glued to its last
// word by a no-break space, so a wrap comes only after the mark (and _breakTagline then removes it)
const TAG_SPLIT = /( · |\u00A0— )/;
const TAG_MARK_DOT = '\u00A0·';
const TAG_MARK_DASH = '\u00A0—';
const TAG_SPLIT_DOT = ' · ';

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
// round 7 (r7, explain:4): the big "NEW DISTRICT" card (DISTRICT_RULES.banner.newSeconds) has its own keyframe offsets (the
// same in / out seconds over a longer hold). Both animations are paused at creation and driven by the theatre clock
// (_updateBanner sets currentTime), so a slow machine still shows the whole fade, held while paused
const DB_NEW_S = DB.newSeconds > DB_S ? DB.newSeconds : DB_S;
const DB_NEW_IN = clamp(DB.inSeconds / DB_NEW_S, 0, 0.5);
const DB_NEW_OUT = clamp(DB.outSeconds / DB_NEW_S, 0, 0.5);
const KF_DB_NEW = [
  { opacity: 0, transform: 'translateY(-' + DB.risePx + 'px) scale(0.96)', easing: 'ease-out' },
  { opacity: 1, transform: 'translateY(0) scale(1)', offset: DB_NEW_IN },
  { opacity: 1, transform: 'translateY(0) scale(1)', offset: 1 - DB_NEW_OUT, easing: 'ease-in' },
  { opacity: 0, transform: 'translateY(0) scale(1)' },
];
const KF_DB_NEW_RM = [
  { opacity: 0, easing: 'ease-out' }, { opacity: 1, offset: DB_NEW_IN }, { opacity: 1, offset: 1 - DB_NEW_OUT, easing: 'ease-in' }, { opacity: 0 },
];
const T_DB_NEW = { duration: DB_NEW_S * 1000, fill: 'both' };
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

// Screens (§10.1). Non-overlay screens are exclusive; overlays stack above them. Round 7 (r7, teaching:5): 'guide' (the
// FIELD GUIDE) is an overlay like 'settings' — over the title or in place of the pause panel — and never a state
const SCREEN_EL_ID = Object.freeze({
  boot: 'scr-boot', title: 'scr-title', levels: 'scr-levels', shop: 'scr-shop', settings: 'scr-settings',
  pause: 'scr-pause', complete: 'scr-complete', gameover: 'scr-gameover', endless: 'scr-endless', guide: 'scr-guide',
});
const SCREEN_IDS = Object.freeze(['boot', 'title', 'levels', 'shop', 'settings', 'pause', 'complete', 'gameover', 'endless', 'guide']);
const OVERLAY_IDS = Object.freeze({ settings: true, guide: true });
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
// round 7 (r7, controls:3): Space / gamepad A with nothing stored — the empty slot fades in, shakes "no", holds and fades out
// (JUICE.ui.fireEmptyMs); reduced motion: _animate is skipped and the slot just shows for that long
const FIRE_EMPTY_S = (UIJ.fireEmptyMs > 0 ? UIJ.fireEmptyMs : 900) / 1000;
const KF_FIRE_EMPTY = [
  { opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'translateX(-5px)', offset: 0.12 }, { transform: 'translateX(5px)', offset: 0.24 },
  { transform: 'translateX(-3px)', offset: 0.36 }, { opacity: 1, transform: 'translateX(0)', offset: 0.75 }, { opacity: 0, transform: 'scale(0.96)' },
];
const T_FIRE_EMPTY = { duration: FIRE_EMPTY_S * 1000, easing: 'ease-out' };

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

/** r7 (teaching:3): a lesson about the boss fight ('boss', 'bossFire', 'boss.<arch>.<n>', 'boss.stomp', 'dodge.*') — dropped
 *  when the boss dies. */
function isBossHint(id) { return typeof id === 'string' && (id.indexOf('boss') === 0 || id.indexOf('dodge.') === 0); }

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
    this._pendingTimer = 0;          // r7 (flow-coins:2): PENDING_FALLBACK_MS timer for a state change no click / frame has shown yet
    this._onPendingTimer = () => { this._pendingTimer = 0; if (this._pendingSet) this._flushPendingScreen(); };
    // r7 (flow-coins:2) stale-click guard, performance.now() ms: the last trusted press (_downStamp); the switch to the current
    // screen (_shownAt) and the end of the frame that painted it (_shownStamp, Infinity until known). _shownWait = updates
    // until the painting frame (1: a switch from a click / key / timer task paints in the next frame); _paintArmed = that
    // frame ran and its post-frame mark (_onPaintMark, a 0 ms timer: runs once the frame's rendering is done) is due
    this._downStamp = 0;
    this._shownStamp = 0;
    this._shownWait = 0;
    this._shownAt = 0;
    this._paintArmed = false;
    this._inUpdate = false;
    this._hudArm = false;            // r7 fix: the current HUD opened a run (not a resume) — its buttons wait HUD_ARM_MS after its paint
    // r7 fix: a switch outside update() (a click / key / timer task) has its paint marked from ui's own animation frame too,
    // so a stopped engine loop (frame error, fatal box) does not leave the screen "unpainted" for STALE_CLICK_MAX_MS
    this._paintRaf = 0;
    this._onPaintFrame = () => { this._paintRaf = 0; if (this._shownWait > 0) { this._shownWait = 0; this._armPaintMark(); } };
    this._onPaintMark = () => {
      if (!this._paintArmed) return;
      this._paintArmed = false;
      this._shownStamp = Math.min(this._perfMs(), this._shownAt + STALE_CLICK_MAX_MS);
    };
    this._lastReal = 0.5; this._lastReal = 0;           // r7 (flow-coins:6): _realNow() of the previous update (real-time rdt)
    this._ncTagText = '';            // r7 fix (teaching:3): the tagline the name card's phrase spans hold, the gap spans between
    this._ncTagGaps = [];            // them, and a wrap check due in the next update's read-first phase (_breakTagline)
    this._ncTagCheck = false;
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
    this._fireEmptyUntil = 0;        // r7 (controls:3): _realNow() s at which the empty-slot flash ends (0 = not showing)
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

    // HUD: hint (UI-25 queue: the one on screen + ≤ HINT_QMAX waiting, de-duplicated by id). Round 7 (r7, teaching:0 / :3):
    // each slot also keeps its hold (s it cannot be cut by a waiting hint), its release key (null = none), priority, the
    // gate event that pulses while it is up (−1) and whether it is a cut hint coming back (no second ui_tap); a hint is
    // marked done only after HINT_MARK_S on screen (_hintMarked)
    this._hintId = '';
    this._hintText = '';
    this._hintHideReq = false;
    this._hintShown = false;
    this._hintUntil = 0.5; this._hintUntil = 0;
    this._hintAt = 0.5; this._hintAt = 0;          // _tclock when the hint on screen appeared
    this._hintHold = 0.5; this._hintHold = 0;
    this._hintKey = null;
    this._hintPri = false;
    this._hintEv = -1;
    this._hintMarked = false;
    this._hintCut = false;                          // a priority hint cut it (it comes back unless it was marked)
    this._hintTone = '';                            // #hint data-tone written
    this._handAnim = null;
    this._hqId = new Array(HINT_QMAX).fill('');
    this._hqText = new Array(HINT_QMAX).fill('');
    this._hqAt = new Float64Array(HINT_QMAX);
    this._hqHold = new Float64Array(HINT_QMAX);
    this._hqKey = new Array(HINT_QMAX).fill(null);
    this._hqPri = new Uint8Array(HINT_QMAX);
    this._hqEv = new Float64Array(HINT_QMAX).fill(-1);
    this._hqBack = new Uint8Array(HINT_QMAX);       // a cut hint re-queued (no second ui_tap when it comes back)
    this._hqLen = 0;
    this._slowedRun = [];                           // r7: lesson ids slowed this run (JUICE.slowmo.lesson, once per run and ever)
    // r7 (teaching:5): NEW card queue (codex:new ids) and the card on screen
    this._ncdQ = [];
    this._ncdShown = false;
    this._ncOn = false;                             // r7 INT: #hud.nc-on while the card is up (narrow landscape: the pill row steps aside, css)
    this._ncdUntil = 0.5; this._ncdUntil = 0;
    this._ncdHideReq = false;
    // r7 (teaching:5): FIELD GUIDE — built on first fill; the ids shown as seen at the last fill (marked read on close)
    this._guideBuilt = false;
    this._guideRows = null;                         // id → { row, icon, name, tag, line, state }
    this._guideSeen = [];
    this._guideScrollTo = null;                     // read-first: the first NEW row to bring into view after an open
    this._guideNew = -1;                            // the "?" buttons' has-new state written (−1 = never)
    this._codexMigrated = false;
    // r7 (teaching:3 / explain:3 / :6): boss archetype (boss:spawn), the boss bar's phase label flash, the letterbox dock
    this._bossArch = '';
    this._bossPhaseLabel = '';                      // "PHASE 2" / "ENRAGED" pending / shown (in place of the name; css)
    this._bossPhaseUntil = 0.5; this._bossPhaseUntil = 0;
    this._bossPhaseReq = false;
    this._lbDock = false;
    this._lbDockN = -1;
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
    this._vigA0 = 0.5; this._vigA0 = 1;   // r7 (teaching:1): the vignette's strength (vignette's optional alpha)
    this._vigOn = false;
    this._vigOpa = -1;

    // screen-position caches for fx flights
    this._coinPosDirty = true;
    this._coinX = 0.5; this._coinX = 0; this._coinY = 0.5; this._coinY = 0;
    this._mx = 0.5; this._mx = 0; this._my = 0.5; this._my = 0;      // scratch result of _measureRaw
    this._puPosDirty = true;
    this._puPos = new Float32Array(MAX_PILLS * 2 + 6);   // pills (x, y) × 3, then the shield, the generic target, the FIRE icon (round 6)
    this._puPosOk = new Uint8Array(MAX_PILLS + 3);

    // results (r7, explain:7: bonusStars / bonusSurv = the level bonus's star and survivor parts, split = the payload had them)
    this._cmp = { level: 1, stars: 0, coins: 0, survivors: 0, eBoss: 0, score: 0, kills: 0, gates: 0, piles: 0, boss: 0, bonus: 0,
      bonusStars: 0, bonusSurv: 0, split: false };
    this._cmpFresh = false;
    this._cmpAnimating = false;
    this._cmpT = 0.5; this._cmpT = 0;
    this._cmpStarsShown = 0;
    this._cmpCoinShown = -1;
    // r7 (flow-coins:6): while the fresh results theatre counts this run's payout, it drives the wallet header from the same
    // count (_cmpDrive): header = max(what it showed, wallet before the payout + the count) — it never moves down
    this._cmpDrive = false;
    this._cmpBase = 0;               // save.data.coins − payout (the wallet before this run)
    this._cmpWalletFrom = 0;         // the header's value when the results appeared
    this._fail = { level: 1, fraction: 0, coinsKept: 0 };
    this._end = { distance: 0, score: 0, best: 0, coins: 0, chunks: 0, newBest: false };

    // shop (r7, flow-coins:5: no shop coin tween any more — the one wallet model below drives the HUD, title and shop pills)
    this._cards = null;              // id → { card, icon, name, what, pips[], effect, estimate, buy, price, then }
    this._cardIconsDone = false;
    this._shopNoteText = '';         // r7 (explain:2): text in #shop-note

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
    this._onWheelDom = (e) => this._wheel(e);          // r7 (layout:0): wheel forwarder (SCROLL_LIST_ID)
    this._onFirePointer = (e) => this._firePointer(e);
    this._onGamepad = () => { this._gpSeen = true; };
    // r7 (flow-coins:2): window capture pointerdown also stamps the press for the stale-click guard (Event.timeStamp shares
    // performance.now()'s time base; a browser without a usable stamp gives 0 and is never guarded)
    this._onPointerDom = (e) => {
      if (this._paintArmed) this._onPaintMark();      // input ahead of the post-frame mark was pressed during the painting frame
      if (e && e.isTrusted && e.timeStamp > 0) this._downStamp = e.timeStamp;
      if (!this._pointerMode) this._setPointerMode(true);
    };
    this._onFsChange = () => this._fsChanged();
    this._onFsRefused = () => this._syncFullscreenButton();   // r7 (layout:3): a refused request un-ticks the SETTINGS toggle
    this._scrollLists = null;        // r7: screen id → its scroll box (SCROLL_LIST_ID), built in _cacheDom
    this._fadeLists = [];            // r7 fix round 3: the FADE_LIST_IDS elements present (edge fades, _listFade)
    this._fadeCss = [];              // r7 final fix: their live computed styles (_listFade reads the padding), fetched once each
    this._bnRoom = -1;               // r7 fix round 3: px the boss name may run past its bar before the HUD coin pill (--bn-room)
    this._onListScroll = (e) => { if (e && e.currentTarget) this._listFade(e.currentTarget); };
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
    // r7 (explain:4): the big "NEW DISTRICT" card variant (requested / shown), its kicker, and the theatre time it showed
    this._dbNew = false;
    this._dbKicker = '';
    this._dbShownKicker = null;
    this._dbShownNew = false;
    this._dbShownAt = 0.5; this._dbShownAt = 0;
    this._dbDur = 0.5; this._dbDur = 0;
    this._dbAnimMs = -1;                             // currentTime last written (ms, integer)
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
    // r7 (layout:3): the SETTINGS Fullscreen row exists only where the title icon does (never in the artifact shell, on
    // iPhone Safari or in a display-mode: fullscreen PWA) — set now, so the boot prewarm lays SETTINGS out as it will show
    if (el.rowFullscreen && el.rowFullscreen.hidden === this._fsAvailable) el.rowFullscreen.hidden = !this._fsAvailable;
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
    if (this._pendingTimer) { try { clearTimeout(this._pendingTimer); } catch (_) { /* ignore */ } this._pendingTimer = 0; }
    if (this._paintRaf) { try { cancelAnimationFrame(this._paintRaf); } catch (_) { /* ignore */ } this._paintRaf = 0; }
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
      setFullscreen: g('set-fullscreen'), rowFullscreen: g('row-fullscreen'),   // r7 (layout:3): the SETTINGS Fullscreen toggle
      qualityNote: g('quality-note'), shopNote: g('shop-note'), pauseControls: g('pause-controls'), retryNote: g('retry-note'),   // r7 (D1) captions
      btnResume: g('btn-resume'), btnRestart: g('btn-restart'), btnPauseSettings: g('btn-pause-settings'), btnQuit: g('btn-quit'),
      completeTitle: g('complete-title'), stars: null, completeCoins: g('complete-coins'), completeBreakdown: g('complete-breakdown'),
      completeBest: g('complete-best'), btnNext: g('btn-next'), btnReplay: g('btn-replay'), btnCompleteShop: g('btn-complete-shop'), btnCompleteHome: g('btn-complete-home'),
      gameoverLevel: g('gameover-level'), gameoverInfo: g('gameover-info'), btnRetry: g('btn-retry'), btnGameoverShop: g('btn-gameover-shop'), btnHome: g('btn-home'),
      endlessStats: g('endless-stats'), btnEndlessRetry: g('btn-endless-retry'), btnEndlessHome: g('btn-endless-home'),
      overlayMsg: g('overlay-msg'), overlayText: g('overlay-text'),
      errorBox: g('error-box'), errorText: g('error-text'), btnReload: g('btn-reload'),
      debug: g('debug'),
      btnFire: g('btn-fire'), fireRing: null, fireIcon: null, fireBadge: null, fireLabel: null, fireKey: null,   // round 6 (r7: + the SPACE key cap)
      districtBanner: g('district-banner'), dbText: null, titleDistrict: null, btnUpdate: g('btn-update'), updText: null,   // round 5
      dbKicker: null, ncTag: null, lbCount: null, bnName: null, bnPhase: null,                                    // r7 (explain:4 / teaching:3 / explain:6), built below
      // r7 (teaching:5): the NEW card and the FIELD GUIDE (its "?" buttons on the title and the pause panel); r7 (explain:3)
      newcard: g('newcard'), ncdIcon: null, ncdKicker: null, ncdName: null, ncdLine: null,
      guideList: g('guide-list'), btnGuide: g('btn-guide'), btnPauseGuide: g('btn-pause-guide'), levelsLegend: g('levels-legend'),
    };
    try { if (el.districtBanner) el.dbText = el.districtBanner.querySelector('.db-text'); } catch (_) { el.dbText = null; }
    // r7 (explain:4): the big card's kicker ("NEW DISTRICT 2") above the name — created once (both shells share the markup)
    if (el.districtBanner && el.dbText) {
      try {
        el.dbKicker = el.districtBanner.querySelector('.db-kicker');
        if (!el.dbKicker) {
          el.dbKicker = doc.createElement('span'); el.dbKicker.className = 'db-kicker'; el.dbKicker.hidden = true;
          el.districtBanner.insertBefore(el.dbKicker, el.dbText);
        }
      } catch (_) { el.dbKicker = null; }
    }
    if (el.newcard) {
      try {
        el.ncdIcon = el.newcard.querySelector('.ncd-icon'); el.ncdKicker = el.newcard.querySelector('.ncd-kicker');
        el.ncdName = el.newcard.querySelector('.ncd-name'); el.ncdLine = el.newcard.querySelector('.ncd-line');
      } catch (_) { el.ncdIcon = null; }
      if (el.ncdKicker) el.ncdKicker.textContent = STRINGS.codex.kicker;
    }
    // r7 (teaching:3): the boss bar's name in two spans — the archetype, and the phase flash ("PHASE 2" / "ENRAGED"), shown
    // in place of the name while it flashes (#bossbar.phase-flash hides .bn-name, css; r7 fix: at every size, no separator)
    if (el.bossName) {
      el.bossName.textContent = '';
      el.bnName = doc.createElement('span'); el.bnName.className = 'bn-name';
      el.bnPhase = doc.createElement('span'); el.bnPhase.className = 'bn-phase'; el.bnPhase.hidden = true;
      el.bossName.appendChild(el.bnName); el.bossName.appendChild(el.bnPhase);
    }
    // r7 (explain:6): the squad count docked in the bottom letterbox bar while the boss-intro dolly hides the world label
    if (el.letterboxBottom) {
      el.lbCount = doc.createElement('span'); el.lbCount.className = 'lb-count'; el.lbCount.hidden = true;
      el.letterboxBottom.appendChild(el.lbCount);
    }
    try { if (el.btnUpdate) el.updText = el.btnUpdate.querySelector('.upd-text'); } catch (_) { el.updText = null; }
    if (el.btnFire) {
      try {
        el.fireRing = el.btnFire.querySelector('.fire-ring');
        el.fireIcon = el.btnFire.querySelector('.fire-icon');
        el.fireBadge = el.btnFire.querySelector('.fire-badge');
        el.fireLabel = el.btnFire.querySelector('.fire-label');
        el.fireKey = el.btnFire.querySelector('.fire-key');   // r7 (controls:4 / teaching:8): css shows it with a fine pointer only
      } catch (_) { el.fireRing = null; el.fireIcon = null; el.fireBadge = null; el.fireLabel = null; el.fireKey = null; }
      if (el.fireLabel) el.fireLabel.textContent = STRINGS.fire.label;
      if (el.fireKey) el.fireKey.textContent = STRINGS.fire.key;
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
      // r7 (teaching:3): the archetype's tagline under its name ("DODGE HIS SLAM · HE CHARGES LATER")
      el.ncTag = doc.createElement('span'); el.ncTag.className = 'nc-tag';
      el.namecard.appendChild(el.ncLabel); el.namecard.appendChild(el.ncName); el.namecard.appendChild(el.ncTag);
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
    // r7 (layout:0 / :1): the wheel / page-key forwarding targets (a missing element simply gets no forwarding)
    const lists = {};
    const listScreens = Object.keys(SCROLL_LIST_ID);
    for (let i = 0; i < listScreens.length; i++) lists[listScreens[i]] = g(SCROLL_LIST_ID[listScreens[i]]);
    this._scrollLists = lists;
    for (let i = 0; i < FADE_LIST_IDS.length; i++) { const f = g(FADE_LIST_IDS[i]); if (f) this._fadeLists.push(f); }
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
      // round 7 (r7, from balance:8): what a rank really buys, as a line on the card (it was only the hover title, which a
      // touch player never sees)
      const what = doc.createElement('div'); what.className = 'card-what'; what.textContent = u.desc || '';
      const pips = doc.createElement('div'); pips.className = 'pips';
      const pipEls = [];
      for (let k = 0; k < u.ranks; k++) { const p = doc.createElement('i'); pips.appendChild(p); pipEls.push(p); }
      const effect = doc.createElement('div'); effect.className = 'card-effect';
      const estimate = doc.createElement('div'); estimate.className = 'card-estimate';
      body.appendChild(name); body.appendChild(what); body.appendChild(pips); body.appendChild(effect);
      // r7 (from balance:9): BUY and, under it, the price of the rank after this one ("then 1,230") in one column. r7 fix: the
      // "~2 runs away" / "Fully upgraded" caption joins them there (it is about the price) — as a fifth line of the body it
      // made the cards too tall for five to fit a 390 × 844 phone (704 px in a 596 px list; 1.2.2: 546)
      const act = doc.createElement('div'); act.className = 'card-act';
      const buy = doc.createElement('button'); buy.className = 'btn primary buy'; buy.dataset.id = id; buy.type = 'button';
      const bIcon = doc.createElement('span'); bIcon.className = 'coin-icon'; bIcon.setAttribute('aria-hidden', 'true');
      const price = doc.createElement('span'); price.className = 'price';
      buy.appendChild(bIcon); buy.appendChild(price);
      const then = doc.createElement('div'); then.className = 'card-then';
      act.appendChild(buy); act.appendChild(then); act.appendChild(estimate);
      card.appendChild(icon); card.appendChild(body); card.appendChild(act);
      if (host) host.appendChild(card);
      cards[id] = { card, icon, name, what, pips: pipEls, pipsHost: pips, effect, estimate, buy, bIcon, price, then, iconDone: false, tip: '' };
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
    // round 7 (r7): the Quality caption (perf-render:9 item 4) and the game-over RETRY note (from balance:10; _fillGameover
    // hides it for the authored L1, which replays its own road)
    set(el.qualityNote, STRINGS.settings.qualityNote); set(el.retryNote, STRINGS.gameover.retryNote);
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
    // round 7 (r7): the FIELD GUIDE's "?" buttons (title, pause panel) and the LEVELS skull legend (explain:3)
    aria(el.btnGuide, STRINGS.aria.guide); aria(el.btnPauseGuide, STRINGS.aria.guide);
    if (el.levelsLegend) {
      try { const t = el.levelsLegend.querySelector('.legend-text'); if (t) t.textContent = STRINGS.levels.legend; } catch (_) { /* ignore */ }
    }
    const titles = { levels: STRINGS.levels.title, shop: STRINGS.shop.title, settings: STRINGS.settings.title, pause: STRINGS.pause.title, gameover: STRINGS.gameover.title, endless: STRINGS.endless.title,
      guide: STRINGS.codex.title };
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
    // settings row labels: the row's .row-label span (round 7: a real element, so it can shrink to its longest word
    // before a narrow row moves its control to a second line — css #scr-settings > .row); a markup without the span
    // (an artifact.html built before round 7) keeps its leading text node
    const rows = [[el.setSound, STRINGS.settings.sound], [el.setMusic, STRINGS.settings.music], [el.setHaptics, STRINGS.settings.haptics],
      [el.setQuality, STRINGS.settings.quality], [el.setReduced, STRINGS.settings.reducedMotion], [el.setHc, STRINGS.settings.hcGates],
      [el.setLarge, STRINGS.settings.largeText], [el.setSens, STRINGS.settings.sensitivity], [el.setFullscreen, STRINGS.settings.fullscreen]];
    for (let i = 0; i < rows.length; i++) {
      const ctl = rows[i][0];
      if (!ctl || !ctl.parentNode) continue;
      const first = ctl.parentNode.firstChild;
      if (first && first.nodeType === 1 && first.classList && first.classList.contains('row-label')) first.textContent = rows[i][1];
      else if (first && first.nodeType === 3) first.nodeValue = rows[i][1];
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
      // r7 fix round 3: the HUD coin pill and the boss bar's track — the room between them bounds the boss name (_bossNameRoom)
      if (el.coins) ro.observe(el.coins);
      if (el.bossTrack) ro.observe(el.bossTrack);
      this._ro = ro;
    } catch (_) { this._ro = null; }
    for (let i = 0; i < this._fadeLists.length; i++) this._observeList(this._fadeLists[i]);
  }

  /** r7 fix round 3: the observer also watches a fading list's box and its rows (a screen shown, a resize, a card whose
   *  estimate line came or went) — called again by the lazy builders (levels, FIELD GUIDE); re-observing is a no-op. */
  _observeList(list) {
    const ro = this._ro;
    if (!ro || !list) return;
    try {
      ro.observe(list);
      for (let c = list.firstElementChild; c; c = c.nextElementSibling) ro.observe(c);
    } catch (_) { /* cosmetic */ }
  }

  /** r7 fix round 3: a fading list's edge classes — .fade-t while scrolled down, .fade-b while more is below (css masks
   *  only those edges). Reads scroll metrics (from scroll / ResizeObserver callbacks: layout is clean), writes on change.
   *  r7 final fix (lead decision 3): an edge fades only when CONTENT lies beyond it. scrollHeight counts the list's own
   *  padding, so a list whose cards fitted while its bottom pad did not (360 × 640; Large text 568 × 320 / 585 × 340)
   *  dimmed the last card on open, and one scrolled less than its top pad dimmed the first: the content spans
   *  [paddingTop, scrollHeight − paddingBottom] of the scroll range. */
  _listFade(list) {
    const max = list.scrollHeight - list.clientHeight;
    const top = list.scrollTop;
    let t = false, b = false;
    if (max > 1) {
      const cs = this._fadeStyle(list);
      const padT = cs ? parseFloat(cs.paddingTop) || 0 : 0;
      const padB = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
      t = top > padT + 1;
      b = top < max - padB - 1;
    }
    try {
      const cl = list.classList;
      if (cl.contains('fade-t') !== t) cl.toggle('fade-t', t);
      if (cl.contains('fade-b') !== b) cl.toggle('fade-b', b);
    } catch (_) { /* cosmetic */ }
  }

  /** r7 final fix: the live CSSStyleDeclaration of a fading list (one getComputedStyle per list per session; null when
   *  unavailable — then the padding counts as 0, the round-3 rule). */
  _fadeStyle(list) {
    const fl = this._fadeLists;
    for (let i = 0; i < fl.length; i++) {
      if (fl[i] !== list) continue;
      let cs = this._fadeCss[i];
      if (cs === undefined) {
        const view = this._doc ? this._doc.defaultView : null;
        try { cs = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(list) : null; } catch (_) { cs = null; }
        this._fadeCss[i] = cs;
      }
      return cs;
    }
    return null;
  }

  _observed(entries) {
    const el = this._el;
    if (!el) return;
    let hint = false;
    let bossName = false;                                // r7 fix round 3: the coin pill or the boss track changed size
    let fade = 0;                                        // r7 fix round 3: bit k = this._fadeLists[k] changed size
    const fl = this._fadeLists;
    for (let i = 0; i < entries.length; i++) {
      const t = entries[i].target;
      let k = -1;
      for (let j = 0; j < fl.length; j++) if (t === fl[j] || t.parentElement === fl[j]) { k = j; break; }
      if (k >= 0) {
        fade |= 1 << k;
      } else if (t === el.coins || t === el.bossTrack) {
        bossName = true;
      } else if (t === el.shield) {
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
    for (let j = 0; j < fl.length; j++) if (fade & (1 << j)) this._listFade(fl[j]);
    if (bossName) this._bossNameRoom();
  }

  /** r7 fix round 3 (hud / walker verifiers, 512 × 297 at 200 % zoom with Large text): where the boss name is left-aligned
   *  over its bar and may run past the bar's end (css, landscape ≤ 500 px tall under 640 px wide) it stops at the HUD coin
   *  pill — --bn-room = the px between the track's right end and the pill's left edge (+ the name's right pad, − 1 px): a
   *  fixed 36u ran "COLOSSUS PR…" 7 px into a 12,345-coin pill. Layout offsets in #hud's frame (no transforms: the bar's
   *  slide-in and the pill's bump do not move them); from the ResizeObserver callback, written on change. */
  _bossNameRoom() {
    const el = this._el;
    const bb = el.bossbar, tr = el.bossTrack, co = el.coins;
    if (!bb || !tr || !co) return;
    const tw = tr.offsetWidth, cw = co.offsetWidth;
    if (!(tw > 0) || !(cw > 0) || tr.offsetParent !== bb || co.offsetParent !== bb.offsetParent) return;   // hidden: keep the last value
    let room = Math.floor(co.offsetLeft - (bb.offsetLeft + tr.offsetLeft + tw) + BOSS_NAME_PAD_R - 1);
    if (room < 0) room = 0;
    if (room === this._bnRoom) return;
    this._bnRoom = room;
    try { bb.style.setProperty('--bn-room', room + 'px'); } catch (_) { /* cosmetic */ }
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
    // r7 (layout:0): a wheel anywhere in the app scrolls the current screen's list (passive: it never blocks scrolling)
    this._listen(el.app, 'wheel', this._onWheelDom, { passive: true });
    // r7 fix round 3: each fading list re-checks its edges when it scrolls (wheel, keys, touch, scrollIntoView)
    for (let i = 0; i < this._fadeLists.length; i++) this._listen(this._fadeLists[i], 'scroll', this._onListScroll, { passive: true });
    this._listen(doc, 'fullscreenchange', this._onFsChange, false);
    this._listen(doc, 'webkitfullscreenchange', this._onFsChange, false);
    this._listen(doc, 'fullscreenerror', this._onFsRefused, false);         // r7 (layout:3): the prefixed request returns no promise
    this._listen(doc, 'webkitfullscreenerror', this._onFsRefused, false);
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
    // r7 fix round 2: weapon:start comes only from the player's FIRE (weapons.requestFire) — "TAP FIRE TO USE IT" is learnt
    on('weapon:start', (p) => { if (p) { this._pillAdd(p.id, p.duration); this._hintActed('fire'); } });
    on('weapon:end', (p) => { if (p) this._pillRemove(p.id); });
    on('gear:start', (p) => { if (p && Number.isFinite(p.duration)) this._pillAdd(p.id, p.duration); });
    on('gear:end', (p) => { if (p) this._pillRemove(p.id); });
    on('armor:change', (p) => { if (p) this._plates = p.plates | 0; });
    on('boss:spawn', (p) => this._onBossSpawn(p));
    on('boss:intro', (p) => this._onBossIntro(p));
    on('boss:hp', (p) => { if (p) { this._bossFrac = p.fraction; this._bossDirty = true; } });
    on('boss:phase', (p) => this._onBossPhase(p));
    on('boss:shield', (p) => { if (p) { this._bossShieldUp = !!p.up; this._bossDirty = true; } });
    on('boss:dead', () => this._onBossDead());
    on('hint:show', (p) => { if (p) this.showHint(p.id, p.text, p); });   // r7: p carries hold / until / priority / event
    on('hint:release', (p) => { if (p) this._releaseHint(p.key); });      // r7 (teaching:0 B): the held hint's subject is resolved
    on('codex:new', (p) => this._onCodexNew(p));                          // r7 (teaching:5): the NEW card
    on('boss:fight', () => { if (!this._bossMini) this._lbOn = false; });  // r7 (perf-render:7): the bars retract when the fight starts
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
      // one earned + two empty stars: both star images get rastered. Round 7 (r7): a four-digit "Earned +1,340" (the comma),
      // the split ★ / Survivors chips and the survivors line with its ★★ / ★★★ thresholds, as the real results lay out
      c.level = 1; c.stars = 1; c.coins = 1340; c.survivors = 20; c.eBoss = 140; c.kills = 120; c.gates = 60; c.piles = 30; c.boss = 40; c.bonus = 20;
      c.bonusStars = 15; c.bonusSurv = 5; c.split = true;
      this._cmpFresh = false;
      this._enterComplete();
      this._cmpAnimating = false;
      // round 3: the earned star also runs the J17 slam (KF_STAR, from 3× scale) — the first real reveal composites and
      // rasters the star layer at that scale, a 60–70 ms frame at 4× CPU throttling right after the results appear
      const st = el.stars;
      if (st && st.length > 0) this._prewarmStarAnim = this._animate(st[0], KF_STAR, T_STAR);
      return [S.complete];
    }, W);
    // r7: a generated level's game over (L2), so its "New road each retry" note rasters too (_prewarmRestore resets it)
    steps.push(() => { this._fail.level = 2; this._fail.coinsKept = 1234; this._fillGameover(); return [S.gameover]; }, W);
    steps.push(() => { this._fillEndless(); return [S.endless]; }, W);
    steps.push(() => { this._fillLevels(false); return [S.levels]; }, W);
    for (let i = 0; i < UPGRADE_IDS.length; i++) { const id = UPGRADE_IDS[i]; steps.push(() => { this._drawCardIcon(id); return null; }, 1); }
    steps.push(() => { this._fillShop(); return [S.shop]; }, W);
    steps.push(() => { this._syncSettings(); return [S.settings]; }, W);
    steps.push(() => { this._fillPauseControls(); return [S.pause]; }, W);   // r7: with its controls line
    // r7 (teaching:5): the FIELD GUIDE — every row built and filled (its first open rasters 50 rows, icons and the fallback
    // glyphs ★ ← → that the game fonts lack), each row drawn met so every icon / gate chip rasters now; _prewarmRestore
    // resets the rows, so the first real open fills them from the save
    steps.push(() => { this._buildGuide(); this._prewarmGuideRows(); return [S.guide]; }, W);
    // round 3: the title (the logo's six drop-shadow filters, the PLAY ring) is the first screen after boot — warm its
    // raster too. Sample caption / coins only: _fillTitle() would spend the one-time volatile-save caption
    steps.push(() => {
      if (el.titleCaption) el.titleCaption.textContent = STRINGS.title.caption(1, 2, starNeed(eBossOf(1), 3));   // r7: with the ★★★ goal
      if (el.titleCoinsValue) el.titleCoinsValue.textContent = fmtCoins(12345);   // r7: full numbers with a comma (_prewarmRestore re-syncs the pill)
      return [S.title];
    }, W);
    // the HUD in two surfaces (both keep their #hud parent displayed): the boss chrome, then hint / shield / pill —
    // the whole HUD in one frame was the prewarm's heaviest raster (≈ 0.3 s on a loaded host at 4×)
    steps.push(() => {
      if (el.bnName) el.bnName.textContent = STRINGS.boss.label;
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
      // round 5: the district banner (a composited pill with an accent rule) runs its real animation here too. Round 7 (r7,
      // explain:4): as the big "NEW DISTRICT" card with the longest name (its kicker line, the larger text), so neither
      // variant's first show rasters anything new (UI-19)
      const db = el.districtBanner;
      if (db) {
        let longest = DISTRICTS[0];
        for (let i = 1; i < DISTRICTS.length; i++) if (DISTRICTS[i].name.length > longest.name.length) longest = DISTRICTS[i];
        if (el.dbText) el.dbText.textContent = longest.name;
        if (el.dbKicker && STRINGS.district) { el.dbKicker.textContent = STRINGS.district.kicker(longest.index); el.dbKicker.hidden = false; }
        try { db.classList.add('db-new'); } catch (_) { /* cosmetic */ }
        try { db.style.setProperty('--db-accent', hexCss(DISTRICTS[0].accent)); db.style.setProperty('--db-glow', rgbaCss(DISTRICTS[0].accent, DB_GLOW_ALPHA)); } catch (_) { /* cosmetic */ }
        if (typeof db.animate === 'function') { try { this._prewarmDbAnim = db.animate(KF_DB_NEW, T_DB_NEW); } catch (_) { this._prewarmDbAnim = null; } }
      }
      // r7 (teaching:5): the NEW card (pill, accent rule, a pictogram) with a long sample; r7 (teaching:0 D): the hint's rim
      if (el.newcard) { this._prewarmNewCard(); }
      if (el.hint) { try { el.hint.setAttribute('data-tone', 'warn'); } catch (_) { /* cosmetic */ } }
      // round 6: the FIRE button (ring mask, disc, pictogram, badge and its ready pulse) rasters here, not at the first pickup
      if (el.btnFire) {
        this._applyIcon(el.fireIcon, this._fireIconUrl(WEAPONS.rocket.id));
        if (el.fireRing) el.fireRing.style.background = this._ringStrings(WEAPONS.rocket.id)[RING_STEPS];
        if (el.fireBadge) { el.fireBadge.textContent = STRINGS.fire.badge(2); el.fireBadge.hidden = false; }
        try { el.btnFire.classList.add('ready'); } catch (_) { /* cosmetic */ }
      }
      return [el.hud, el.hint, el.shield, pu ? pu.root : null, db, el.btnFire, el.newcard];
    }, W);
    return steps;
  }

  /** r7 (teaching:5): the NEW card's prewarm sample — the longest card line, an item pictogram and its accent. */
  _prewarmNewCard() {
    const el = this._el;
    const E = STRINGS.codex.entries;
    let id = 'troop.medic', len = 0;
    for (const k of CODEX.cards) { const c = E[k] ? (E[k].card || '') : ''; if (c.length > len) { len = c.length; id = k; } }
    if (el.ncdName) el.ncdName.textContent = E[id].name;
    if (el.ncdLine) el.ncdLine.textContent = E[id].card || E[id].line;
    this._fillCodexIcon(el.ncdIcon, id);
    try { el.newcard.style.setProperty('--ncd-accent', this._codexAccent(id)); } catch (_) { /* cosmetic */ }
  }

  /** r7 (teaching:5): every guide row drawn as met (its icon / chip / face / skull rasters at boot); reset afterwards. */
  _prewarmGuideRows() {
    const rows = this._guideRows;
    if (!rows) return;
    const E = STRINGS.codex.entries;
    for (let i = 0; i < GUIDE_IDS.length; i++) {
      const id = GUIDE_IDS[i];
      const r = rows[id];
      if (!r) continue;
      r.name.textContent = this._codexName(E[id]);
      r.line.textContent = this._codexLine(E[id]);
      this._fillCodexIcon(r.icon, id);
      r.tag.hidden = i % 4 !== 0;                   // a few NEW tags rastered too
      r.state = '';                                 // the first real fill rewrites every row
    }
  }

  /** Undo the sample content that a later show would not overwrite by itself. */
  _prewarmRestore() {
    const el = this._el;
    this._cmp.stars = 0; this._cmp.coins = 0;
    // round 7 (r7): the sample results / game-over fields, and the title pill's sample text (the wallet rewrites every pill)
    this._cmp.eBoss = 0; this._cmp.bonusStars = 0; this._cmp.bonusSurv = 0; this._cmp.split = false;
    this._fail.level = 1; this._fail.coinsKept = 0;
    this._coinShown = -1;
    if (el.bnName) el.bnName.textContent = this._bossName;
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
    // r7: the sample big-card variant, the NEW card, the hint's rim and the guide rows are rewritten by their first real show
    this._dbShownKicker = null;
    this._dbShownNew = true;                        // the banner holds .db-new now: the first real show toggles it as needed
    if (el.hint) { try { el.hint.removeAttribute('data-tone'); } catch (_) { /* cosmetic */ } }
    this._hintTone = '';
    if (el.ncdIcon) el.ncdIcon.dataset.id = '';
    if (this._guideRows) { for (const id in this._guideRows) { const r = this._guideRows[id]; r.state = ''; r.tag.hidden = true; } }
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
    // r7 (teaching:5): settings and the FIELD GUIDE are overlays — over the screen they were opened from (the title: shown
    // under them, .under), in place of the pause panel; _beforeSettings keeps that screen for either
    const overlay = target !== null && OVERLAY_IDS[target] === true;
    if (overlay && OVERLAY_IDS[prev] !== true) this._beforeSettings = prev;
    if (prev === 'guide' && target !== 'guide') this._closeGuide();       // r7: the rows it showed are read now
    // round 7 (r7, flow-coins:6): leaving the results during their theatre (SHOP / NEXT / HOME straight away) ends it first —
    // stars, count and the wallet header it drives are final (silently), so no screen ever shows a half-counted header
    if (prev === 'complete' && target !== 'complete' && !overlay && this._cmpAnimating) this._finishCompleteAnim(false);
    const base = overlay ? this._beforeSettings : target;
    const screens = this._screens;
    for (let i = 0; i < SCREEN_IDS.length; i++) {
      const sid = SCREEN_IDS[i];
      const node = screens[sid];
      if (!node) continue;
      let vis = sid === target;
      let under = false;
      if (!vis && overlay && sid === base && sid !== 'pause' && sid !== 'boot') { vis = true; under = true; }
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
    // round 7 (r7, flow-coins:2): a new screen is "unpainted" until the frame that renders it has finished — this one when the
    // switch runs inside update(), else the next (or STALE_CLICK_MAX_MS) — a pointer press before that was aimed at the
    // screen it replaced (_click ignores it)
    if (target !== prev) {
      this._shownStamp = Infinity;
      this._shownAt = this._perfMs();
      this._paintArmed = false;
      this._shownWait = 1;
      if (this._inUpdate) { this._shownWait = 0; this._armPaintMark(); }
      else if (!this._paintRaf && typeof requestAnimationFrame === 'function') {
        try { this._paintRaf = requestAnimationFrame(this._onPaintFrame); } catch (_) { this._paintRaf = 0; }
      }
      // r7 fix: the HUD of a new run (from the results, a menu, the title) arms its buttons late; a resume does not
      if (target === null) this._hudArm = prev !== 'pause';
    }

    switch (target) {
      case 'title': this._fillTitle(); break;
      case 'levels': this._fillLevels(true); break;
      case 'shop': this._fillShop(); break;
      case 'settings': this._syncSettings(); break;
      case 'guide': this._fillGuide(true); break;           // r7 (teaching:5): the FIELD GUIDE, refreshed on every open
      case 'pause': this._fillPauseControls(); this._syncGuideBadge(); break;   // r7: the controls line; the "?" badge
      case 'complete': this._enterComplete(); break;
      case 'gameover': this._fillGameover(); break;
      case 'endless': this._fillEndless(); break;
      default: break;
    }
    if (target === 'complete' || target === 'gameover' || target === 'endless') {
      // the run's coins are final now (game over keeps only ECONOMY.gameOverKeep): settle the wallet (r7, flow-coins:5: the one
      // wallet model — the header tweens once from what it shows). r7 (flow-coins:6): a fresh results theatre drives the
      // header from its own count instead (_updateComplete), so the header holds where it is until the count passes it
      const save = this.ctx.save;
      if (save && save.data) {
        if (this._cmpDrive) { this._coinTotal = save.data.coins; this._coinHold = false; this._coinTween = false; }
        else this._walletSync(save.data.coins, true);
      }
    }

    // UI-21: no fade restart here (.enter replays by itself on display:none → shown); focus moves at the start of
    // the next update(), when style is clean, instead of flushing style + layout inside this frame
    const shown = target === null ? this._el.hud : screens[target];
    if (target !== prev) this._focusPending = target === null ? this._el.app : (shown || null);
    if (target !== null && target !== 'pause' && !overlay) this._hintQueueClear(true);   // UI-25: quit / results / menus (not the overlays over pause)

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
      // r7 INT (engine's context-loss give-up, STRINGS.errors.gpuGone): the "Reloading graphics…" panel under a fatal box showed
      // faintly through it, a spinner promising a reload that will not come. The overlay itself stays (engine keeps it as the
      // input blocker); only its panel goes, for good — a fatal box is final (RELOAD)
      if (el.overlayText) el.overlayText.hidden = true;
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

  /** Edge vignette in a colour (damage / negative gate / chew), fading out over `seconds`. Round 7 (r7, teaching:1, the C → D
   *  contract): optional `alpha` (0..1) multiplies its strength (VIGNETTE_ALPHA at the edge) — the bite cue starts at 0.35
   *  and grows with the bite burst; absent = full strength, as before. The gradient string is unchanged (built once per
   *  colour); the alpha scales the element's opacity ramp. */
  vignette(colorHex, seconds, alpha) {
    const hex = Number.isFinite(colorHex) ? colorHex >>> 0 : PALETTE.flash.red;
    if (hex !== this._vigHex) {
      this._vigHex = hex;
      this._vigCss = 'radial-gradient(ellipse at center, ' + rgbaCss(hex, 0) + ' 45%, ' + rgbaCss(hex, VIGNETTE_ALPHA) + ' 100%)';
      this._vigCssDirty = true;
    }
    this._vigDur = Number.isFinite(seconds) && seconds > 0 ? seconds : JUICE.flashes.negVignette;
    this._vigA0 = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 1;
    this._vigT = 0;
    this._vigOn = true;
  }

  /**
   * Tutorial hint (hint:show). UI-25: queued — at most JUICE.ui.hintQueueMax waiting, de-duplicated by id (on screen or
   * waiting), dropped when older than HINT_QUEUE_AGE_S theatre seconds or when the run ends; 'steer' also hides as soon as
   * the player has steered. Round 7 (r7, teaching:0 / :3) — `opts` (the hint:show payload, all optional):
   *   hold      theatre s the hint may not be cut by a waiting one (a subject-bound lesson: its gate's time on the road)
   *   until     release key: the hint stays (≤ HINT_HOLD_MAX_S) until hint:release with that key — and leaves at once then
   *   priority  a boss attack's lesson: queued ahead of the others and cuts a normal hint on screen to HINT_CUT_S; the cut
   *             one comes back first unless it had been up HINT_MARK_S (then it counts as read)
   *   event     the gate event whose gates pulse while the hint is up (C's gates.pulseEvent, guarded), −1 none
   * Each hint is on screen for max(HINT_S, base + per-word × words) s (≤ HINT_MAX_S), a held one for max(that, hold), and is
   * marked done in the save only after HINT_MARK_S on screen (a lesson cut or never seen comes back in a later run).
   */
  showHint(id, text, opts) {
    const hid = typeof id === 'string' ? id : '';
    let t = typeof text === 'string' ? text : (HINTS[hid] || '');
    if (typeof t === 'function') t = t();
    // UI-16: with a mouse / keyboard the steer hint names the keys too (A/D/←/→ steer, ARCH §6.2); round 7 (r7, controls:4 /
    // teaching:8): so does the first stored weapon's FIRE hint (click it or press Space — "TAP" told a desktop player nothing)
    if (hid === 'steer' && HINTS.steerDesktop && prefersDesktopSteerHint()) t = HINTS.steerDesktop;
    else if (hid === 'fire' && HINTS.fireDesktop && prefersDesktopSteerHint()) t = HINTS.fireDesktop;
    if (!t) return;
    const pri = !!(opts && opts.priority);
    if (hid) {
      if (this._hintShown && this._hintId === hid) return;
      for (let i = 0; i < this._hqLen; i++) {
        if (this._hqId[i] !== hid) continue;
        if (!pri || i === 0) return;
        this._hintQueueRemove(i);                   // a priority hint already waiting moves to the front (below)
        break;
      }
      // round 7 (r7, teaching:3): a boss phase's lesson ('boss.hulk.3') replaces the same archetype's earlier phase lesson
      // still waiting ('boss.hulk.2'): a fast fight reached phase 3 before "PHASE 2: HE CHARGES" was shown, which then read
      // during the enrage. The dropped one was never on screen, so it stays unmarked and teaches at the next fight's phase 2
      const dot = hid.lastIndexOf('.');
      const c = dot > 0 ? hid.charCodeAt(dot + 1) : 0;
      if (dot > 0 && c >= 48 && c <= 57 && hid.indexOf('boss.') === 0) {
        const pre = hid.slice(0, dot + 1);
        for (let i = this._hqLen - 1; i >= 0; i--) {
          const q = this._hqId[i];
          if (q !== hid && q.length > pre.length && q.indexOf(pre) === 0) this._hintQueueRemove(i);
        }
      }
    }
    const max = this._hqId.length;
    if (max <= 0) return;
    // the front holds the priority hints in arrival order; a normal hint joins the back
    let lead = 0;
    while (lead < this._hqLen && this._hqPri[lead] === 1) lead++;
    if (this._hqLen >= max) {
      // full: drop the oldest normal hint (the oldest priority one only when every waiting hint is a priority one)
      this._hintQueueRemove(lead < this._hqLen ? lead : 0);
      if (lead > this._hqLen) lead = this._hqLen;
    }
    const k = pri ? Math.min(lead, this._hqLen) : this._hqLen;
    this._hintQueueInsert(k, hid, t, opts, pri, false);
    // a priority lesson cuts a normal hint on screen short (it returns afterwards, _hideHintDom)
    if (pri && this._hintShown && !this._hintPri) {
      const cut = this._tclock + HINT_CUT_S;
      if (this._hintUntil > cut) this._hintUntil = cut;
      this._hintCut = true;
    }
  }

  /** Inserts one waiting hint at index k (k ≤ _hqLen < capacity). */
  _hintQueueInsert(k, hid, text, opts, pri, back) {
    const n = this._hqLen;
    for (let i = n; i > k; i--) {
      this._hqId[i] = this._hqId[i - 1]; this._hqText[i] = this._hqText[i - 1]; this._hqAt[i] = this._hqAt[i - 1];
      this._hqHold[i] = this._hqHold[i - 1]; this._hqKey[i] = this._hqKey[i - 1]; this._hqPri[i] = this._hqPri[i - 1];
      this._hqEv[i] = this._hqEv[i - 1]; this._hqBack[i] = this._hqBack[i - 1];
    }
    this._hqId[k] = hid;
    this._hqText[k] = text;
    this._hqAt[k] = this._tclock;
    this._hqHold[k] = opts && opts.hold > 0 ? opts.hold : 0;
    this._hqKey[k] = opts && opts.until !== undefined ? opts.until : null;
    this._hqPri[k] = pri ? 1 : 0;
    this._hqEv[k] = opts && opts.event >= 0 ? opts.event : -1;
    this._hqBack[k] = back ? 1 : 0;
    this._hqLen = n + 1;
  }

  /** Removes the waiting hint at index i. */
  _hintQueueRemove(i) {
    const n = this._hqLen;
    if (i < 0 || i >= n) return;
    for (let j = i + 1; j < n; j++) {
      this._hqId[j - 1] = this._hqId[j]; this._hqText[j - 1] = this._hqText[j]; this._hqAt[j - 1] = this._hqAt[j];
      this._hqHold[j - 1] = this._hqHold[j]; this._hqKey[j - 1] = this._hqKey[j]; this._hqPri[j - 1] = this._hqPri[j];
      this._hqEv[j - 1] = this._hqEv[j]; this._hqBack[j - 1] = this._hqBack[j];
    }
    this._hqLen = n - 1;
    this._hqId[n - 1] = ''; this._hqText[n - 1] = ''; this._hqKey[n - 1] = null; this._hqPri[n - 1] = 0; this._hqEv[n - 1] = -1; this._hqBack[n - 1] = 0;
  }

  /** Round 7 (r7, teaching:0 B): hint:release — the hint bound to `key` leaves the screen now, or the queue unshown. */
  _releaseHint(key) {
    if (key === null || key === undefined) return;
    for (let i = this._hqLen - 1; i >= 0; i--) if (this._hqKey[i] === key) this._hintQueueRemove(i);
    if (this._hintShown && this._hintKey === key) { this._hintKey = null; this._hintCut = false; this._hintHideReq = true; }
  }

  /** r7 fix round 2: the player already did what lesson `id` asks (FIRE pressed, weapon:start) — it leaves the queue unshown
   *  or the screen at once, marked done, as 'steer' does once the player has steered. The 'fire' lesson waited behind a
   *  2.5 s hint and then asked for a FIRE press that had already started the shotgun (L1, Space at the pickup). */
  _hintActed(id) {
    let done = false;
    for (let i = this._hqLen - 1; i >= 0; i--) if (this._hqId[i] === id) { this._hintQueueRemove(i); done = true; }
    if (this._hintShown && this._hintId === id) { this._hintMarked = true; this._hintCut = false; this._hintHideReq = true; done = true; }
    if (done) this._markHint(id);
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
      this._ncdQ.length = 0;                        // r7 (teaching:5): nor the NEW cards (the FIELD GUIDE keeps them)
      this._ncdHideReq = true;
    }
    if (to === 'complete' && data) {
      if (data.endless) this._copyEndless(data);
      else { this._copyComplete(data); this._cmpFresh = true; }
    } else if (to === 'gameover' && data) {
      this._copyFailed(data);
    }
    this._pendingId = this._mapState(to, data);
    this._pendingSet = true;
    // round 7 (r7, flow-coins:2): shown by the click / key task that caused it (_click, _key), else by the next update(), else
    // by this timer — a starved animation frame can no longer hold a screen switch
    if (!this._pendingTimer) {
      try { this._pendingTimer = setTimeout(this._onPendingTimer, PENDING_FALLBACK_MS); } catch (_) { this._pendingTimer = 0; }
    }
  }

  /** Round 7 (r7, flow-coins:2): applies the pending state screen now (update(), the end of a click / key task, the
   *  fallback timer). Takes .starting / aria-busy off the menu button that waited for its script. */
  _flushPendingScreen() {
    this._pendingSet = false;
    if (this._pendingTimer) { try { clearTimeout(this._pendingTimer); } catch (_) { /* ignore */ } this._pendingTimer = 0; }
    this._clearStarting();
    this.showScreen(this._pendingId);
  }

  /** The menu button waiting for its generated script (.starting, aria-busy) goes back to normal. */
  _clearStarting() {
    const b = this._startingBtn;
    if (!b) return;
    this._startingBtn = null;
    try { b.classList.remove('starting'); b.removeAttribute('aria-busy'); } catch (_) { /* cosmetic */ }
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
    if (b) {
      c.kills = b.kills | 0; c.gates = b.gates | 0; c.piles = b.piles | 0; c.boss = b.boss | 0; c.bonus = b.bonus | 0;
      // round 7 (r7, explain:7): the level bonus's star and survivor parts (absent from an older level.js: one Bonus chip)
      c.split = Number.isFinite(b.bonusStars) && Number.isFinite(b.bonusSurvivors);
      c.bonusStars = c.split ? b.bonusStars | 0 : 0;
      c.bonusSurv = c.split ? b.bonusSurvivors | 0 : 0;
    }
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

  /**
   * Round 7 (r7, flow-coins:5): the ONE wallet display. The HUD model (_coinValue / _coinTo / the tween) is the only source
   * of every coin pill — HUD (#coins-value, the results header too), title and shop — so all of them show the same number at
   * the same moment and a purchase animates once (737 → 327 played twice before: on the shop pill, then again on the
   * results header after BACK, from a stale 737). Outside play the wallet moves only when the save changes. `animate`:
   * tween from the value on screen (an unchanged target keeps a running tween), else set at once and written now. While the
   * fresh results theatre drives the header from its count (_cmpDrive) this does nothing; the theatre syncs at its end.
   */
  _walletSync(coins, animate) {
    if (!Number.isFinite(coins) || this._cmpDrive) return;
    this._coinTotal = coins;
    this._coinHold = false;
    if (animate) {
      if (this._coinTween && coins === this._coinTo) return;                                                    // already heading there
      if (!this._coinTween && this._coinValue === coins && Math.round(coins) === this._coinShown) return;       // already there
      this._tweenCoins(coins);
      return;
    }
    this._coinFrom = this._coinTo = this._coinValue = coins;
    this._coinT = 0;
    this._coinTween = false;
    this._writeWallet(Math.round(coins));
  }

  /** Writes the integer `v` into every coin pill (HUD, title, shop), only when it changed; the string is built then. */
  _writeWallet(v) {
    if (v === this._coinShown) return;
    this._coinShown = v;
    const el = this._el;
    const s = fmtCoins(v);
    if (el.coinsValue) el.coinsValue.textContent = s;
    if (el.titleCoinsValue) el.titleCoinsValue.textContent = s;
    if (el.shopCoinsValue) el.shopCoinsValue.textContent = s;
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
    // r7: per run — lessons slowed, NEW cards waiting / shown, the boss archetype, the phase flash, the letterbox dock
    this._slowedRun.length = 0;
    this._ncdQ.length = 0;
    this._ncdHideReq = true;
    this._bossArch = '';
    this._bossPhaseReq = false;
    this._bossPhaseUntil = 0;
    this._bossPhaseLabel = '';
    this._flashOn = false;
    this._vigOn = false;
    this._hudResetPending = true;
    const save = this.ctx.save;
    const coins = save && save.data ? save.data.coins : 0;
    this._cmpDrive = false;                         // r7 (flow-coins:6): the run's coins:change drive the header again
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
    this._bossArch = typeof p.archetype === 'string' ? p.archetype : '';   // r7 (teaching:3): the name card's tagline
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

  /** boss:dead. Round 7 (r7, perf-render:7, lead decision): the bars retract at boss:fight and come back for the death
   *  cinematic (slow-mo, collapse) of a campaign boss; the results screen hides them, level:start clears them. */
  _onBossDead() {
    this._bossHideAt = this._tclock + BOSS_OUT_S;
    this._lbOn = !this._bossMini && !this._runEndless;
    this._ncUntil = 0;
    this._ncPending = false;
    // r7 (teaching:3): the fight's lessons are moot once the boss is dead — a queued "ENRAGED! …" showed over the collapse.
    // They stay un-marked (unless already read), so the next boss teaches them
    for (let i = this._hqLen - 1; i >= 0; i--) if (isBossHint(this._hqId[i])) this._hintQueueRemove(i);
    if (this._hintShown && isBossHint(this._hintId)) { this._hintCut = false; this._hintHideReq = true; }
  }

  /** boss:phase → the bar's colour (10 Hz block) and (r7, teaching:3) a 1.5 s "PHASE 2" / "ENRAGED" in place of its name. */
  _onBossPhase(p) {
    if (!p) return;
    const n = p.phase | 0;
    this._bossPhase = n;
    this._bossDirty = true;
    if (n < 2) return;
    const B = STRINGS.boss;
    this._bossPhaseLabel = (n >= 3 && B.enraged ? B.enraged : B.phase(n));   // event time
    this._bossPhaseReq = true;
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
    // round 7 (r7, explain:4): a district's first level (and an endless start / rotation) → the big card ("NEW DISTRICT 2"
    // over the name; "ENDLESS RUN" at an endless start); any other start, retries included → a small tag "NAME · 3/5", or
    // "NAME · FINALE" on the skull level. An older level.js (no `first` / `step`) keeps the round-5 label
    const D = STRINGS.district;
    let name = typeof p.name === 'string' && p.name ? p.name : '';
    let index = p.index | 0;
    if (!name) {
      for (let i = 0; i < DISTRICTS.length; i++) { const d = DISTRICTS[i]; if (d && d.label === label) { name = d.name; index = d.index; break; } }
    }
    this._dbNew = p.first === true && !!name;
    if (this._dbNew && D) {
      this._dbKicker = p.reason === 'start' && this._runEndless ? D.endless : D.kicker(index);
      this._dbLabel = name;
    } else {
      this._dbKicker = '';
      const step = p.step | 0, steps = p.steps | 0;
      // r7 fix: an endless start that is not new (a RETRY: no step) shows the district's name — the round-5 label
      // "DISTRICT 1 · SUNSET BOULEVARD" is the old format the tester saw; only an older level.js (no name) still gets it
      if (D && name) this._dbLabel = step > 0 && steps > 0 ? (step >= steps ? D.finale(name) : D.tag(name, step, steps)) : name;
      else this._dbLabel = label;
    }
    this._dbAccent = accent >= 0 ? accent : PALETTE.ui.primary;
    this._dbReq = true;
  }

  /** Round 7: the name card's three lines — "BOSS" or (explain:3) "DISTRICT FINALE" on a campaign milestone level, the
   *  archetype's name, and (teaching:3) its tagline from data (STRINGS.boss.tagline; '' hides the line). */
  _fillNameCard() {
    const el = this._el;
    const fin = !this._runEndless && BOSSES.milestones.indexOf(Math.min(this._runLevel, LEVELS.curve.loopAfter)) !== -1;
    const label = fin && STRINGS.boss.finale ? STRINGS.boss.finale : STRINGS.boss.label;
    if (el.ncLabel && el.ncLabel.textContent !== label) el.ncLabel.textContent = label;
    if (el.ncName) el.ncName.textContent = this._bossName;
    const tags = STRINGS.boss.tagline;
    const tag = tags && typeof tags[this._bossArch] === 'string' ? tags[this._bossArch] : '';
    if (el.ncTag) {
      if (tag !== this._ncTagText) { this._ncTagText = tag; this._buildTagline(el.ncTag, tag); }
      else this._unbreakTagline();
      if (el.ncTag.hidden === !!tag) el.ncTag.hidden = !tag;
      this._ncTagCheck = this._ncTagGaps.length > 0;
    }
  }

  /** r7 fix (teaching:3): the tagline as phrase boxes ("ACID FROM ABOVE ·" "STEER OUT OF THE CIRCLES"): each phrase is an
   *  inline-block that keeps its words together (and still wraps inside when it alone is wider than the line), its
   *  separator mark (" ·", or " —" for data's DASH) inside it after a no-break space, and a gap span between phrases — the
   *  only place a line can break. _breakTagline turns a gap that broke into the line break and hides the mark before it.
   *  A boss intro's event time (a few spans). */
  _buildTagline(node, tag) {
    const doc = this._doc;
    this._ncTagGaps.length = 0;
    node.textContent = '';
    if (!tag || !doc) { node.textContent = tag || ''; return; }
    const parts = tag.split(TAG_SPLIT);             // phrase, separator, phrase, …
    for (let i = 0; i < parts.length; i += 2) {
      const ph = doc.createElement('span');
      ph.className = 'nc-ph';
      ph.textContent = parts[i];
      if (i + 2 < parts.length) {
        const dot = doc.createElement('span');
        dot.className = 'nc-dot';
        dot.textContent = parts[i + 1] === TAG_SPLIT_DOT ? TAG_MARK_DOT : TAG_MARK_DASH;
        ph.appendChild(dot);
      }
      node.appendChild(ph);
      if (i + 2 < parts.length) {
        const gap = doc.createElement('span');
        gap.className = 'nc-gap';
        gap.textContent = ' ';
        node.appendChild(gap);
        this._ncTagGaps.push(gap);
      }
    }
  }

  /** r7 fix: a gap whose next phrase starts on a lower line than the phrase before it broke the line: it becomes the line
   *  break and that phrase's dot goes, so no line ends in a hanging " ·" ("ACID FROM ABOVE ·" / "STEER OUT OF THE CIRCLES"
   *  at 1024 × 594). Read-first phase of the update after the card was shown (layout clean; the card is still at the start
   *  of its pop-in, so the change is not seen). Reads first, then writes. */
  _breakTagline() {
    const gaps = this._ncTagGaps;
    let mask = 0;
    for (let i = 0; i < gaps.length && i < 30; i++) {
      const a = gaps[i].previousSibling, b = gaps[i].nextSibling;
      if (a && b && b.offsetTop > a.offsetTop + 1) mask |= 1 << i;
    }
    for (let i = 0; i < gaps.length && i < 30; i++) {
      if ((mask & (1 << i)) === 0) continue;
      gaps[i].classList.add('nc-br');
      const a = gaps[i].previousSibling;
      if (a && a.lastChild && a.lastChild.classList) a.lastChild.classList.add('nc-br');
    }
  }

  /** The line breaks of a tagline shown before are undone (a new show measures its own layout). */
  _unbreakTagline() {
    const gaps = this._ncTagGaps;
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i];
      if (!g.classList.contains('nc-br')) continue;
      g.classList.remove('nc-br');
      const a = g.previousSibling;
      if (a && a.lastChild && a.lastChild.classList) a.lastChild.classList.remove('nc-br');
    }
  }

  /** Round 7 (r7, teaching:3): the first time ever per archetype the name card holds through the intro
   *  (BOSSES.intro.fightAfter, 2.4 s) so its tagline is read; afterwards BOSSES.intro.nameCard (1.5 s). */
  _nameCardSeconds() {
    const save = this.ctx.save;
    const key = this._bossArch ? 'bosscard.' + this._bossArch : '';   // once per boss intro (event time)
    if (!key || !save || typeof save.hintDone !== 'function' || save.hintDone(key)) return NAMECARD_S;
    if (this._attended()) this._markHint(key);   // r7 final fix: an idle screen's intro keeps the first-time hold for next time
    const hold = BOSSES.intro.fightAfter;
    return hold > NAMECARD_S ? hold : NAMECARD_S;
  }

  /** Round 5: the district banner per frame (theatre clock; DOM writes only on a show / hide change). Round 7 (r7,
   *  explain:4): the fade follows the theatre clock — the animation is paused at creation and its currentTime is set from
   *  _tclock here (whole ms, written on change), so a slow machine shows the whole fade (the real-time 1.6 s animation got
   *  a few painted frames at the heavy level start) and a pause holds it. */
  _updateBanner(tnow, paused) {
    if (this._dbHideReq) { this._dbHideReq = false; if (this._dbShown) this._hideBanner(); }
    // hidden under the boss bar (#hud.boss-on): a request while it is up is dropped, a showing banner goes
    if (this._dbReq && !paused) { this._dbReq = false; if (!this._bossOn) this._showBanner(tnow); }
    if (!this._dbShown) return;
    if (this._bossOn || tnow >= this._dbUntil) { this._hideBanner(); return; }
    const a = this._dbAnim;
    if (a) {
      const ms = Math.round(Math.min(this._dbDur, Math.max(0, tnow - this._dbShownAt)) * 1000);
      if (ms !== this._dbAnimMs) { this._dbAnimMs = ms; try { a.currentTime = ms; } catch (_) { /* cosmetic */ } }
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
    if (this._dbShownKicker !== this._dbKicker && el.dbKicker) {
      this._dbShownKicker = this._dbKicker;
      el.dbKicker.textContent = this._dbKicker;
      el.dbKicker.hidden = !this._dbKicker;
    }
    if (this._dbShownNew !== this._dbNew) {
      this._dbShownNew = this._dbNew;
      try { node.classList.toggle('db-new', this._dbNew); } catch (_) { /* cosmetic */ }
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
    const big = this._dbNew;
    const S = big ? DB_NEW_S : DB_S;
    // reduced motion: opacity only (no translate); _animate skips reduced motion, the banner's fade is not motion
    if (typeof node.animate === 'function') {
      try {
        this._dbAnim = node.animate(this._reduced ? (big ? KF_DB_NEW_RM : KF_DB_RM) : (big ? KF_DB_NEW : KF_DB), big ? T_DB_NEW : T_DB);
        this._dbAnim.pause();                       // r7: driven by the theatre clock (_updateBanner)
        this._dbAnim.currentTime = 0;
      } catch (_) { this._dbAnim = null; }
    }
    this._dbAnimMs = 0;
    this._dbAnimPaused = true;
    this._dbShown = true;
    this._dbShownAt = tnow;
    this._dbDur = S;
    this._dbUntil = tnow + S;
  }

  _hideBanner() {
    this._dbShown = false;
    this._cancelAnim(this._dbAnim);
    this._dbAnim = null;
    this._dbAnimPaused = false;
    if (this._el.districtBanner) this._el.districtBanner.hidden = true;
  }

  // -------------------------------------------------------------------------------------------
  // Round 7 (r7, teaching:5) — the NEW card and the FIELD GUIDE. Entries and copy: data.js CODEX / STRINGS.codex (every
  // number templated from the tables). level marks an entry seen in the save at its first encounter ('seen:<id>') and
  // announces a CODEX.cards entry with codex:new; closing the guide marks the rows it showed read ('read:<id>'). A one-time
  // migration ('codex:v1') marks what an older profile already met as seen and read, so it is not flooded with NEW tags.
  // -------------------------------------------------------------------------------------------

  /** codex:new { id } → the NEW card queue (≤ NEWCARD_QMAX waiting; the oldest goes when full). */
  _onCodexNew(p) {
    if (!p || typeof p.id !== 'string') return;
    const E = STRINGS.codex && STRINGS.codex.entries ? STRINGS.codex.entries[p.id] : null;
    if (!E || this._ncdQ.indexOf(p.id) !== -1) return;
    if (this._ncdQ.length >= NEWCARD_QMAX) this._ncdQ.shift();
    this._ncdQ.push(p.id);                          // event time (a handful per run)
  }

  /** The NEW card per frame (theatre clock): one at a time for NEWCARD_S, in play only, never under the boss bar and never
   *  over the district banner (it waits for both). DOM writes only on show / hide. */
  _updateNewCard(tnow, paused) {
    if (this._ncdHideReq) { this._ncdHideReq = false; if (this._ncdShown) this._hideNewCard(); }
    if (this._ncdShown) {
      if (this._bossOn || tnow >= this._ncdUntil) this._hideNewCard();
      return;
    }
    if (paused || this._current !== null || this._ncdQ.length === 0) return;
    if (this._bossOn || this._dbShown || this._dbReq) return;
    this._showNewCard(this._ncdQ.shift(), tnow);
  }

  _showNewCard(id, tnow) {
    const el = this._el;
    const node = el.newcard;
    const E = STRINGS.codex.entries[id];
    if (!node || !E) return;
    if (el.ncdName) el.ncdName.textContent = E.name;
    if (el.ncdLine) el.ncdLine.textContent = E.card || E.line;
    this._fillCodexIcon(el.ncdIcon, id);
    try { node.style.setProperty('--ncd-accent', this._codexAccent(id)); } catch (_) { /* cosmetic */ }
    node.hidden = false;
    this._animate(node, KF_POP_IN, T_NAMECARD);
    this._ncdShown = true;
    this._setNcOn(true);
    this._ncdUntil = tnow + NEWCARD_S;
  }

  _hideNewCard() {
    this._ncdShown = false;
    if (this._el.newcard) this._el.newcard.hidden = true;
    this._setNcOn(false);
  }

  /** r7 INT (merged-HUD audit): #hud.nc-on while the NEW card is up — on a landscape box under 800 px wide the power-up row
   *  steps to the right edge meanwhile (css), out of the card's top-left slot; the pill positions the icon flights aim at
   *  are re-read. Written on change only. */
  _setNcOn(on) {
    if (on === this._ncOn) return;
    this._ncOn = on;
    const hud = this._el ? this._el.hud : null;
    if (hud) { try { hud.classList.toggle('nc-on', on); } catch (_) { /* ignore */ } }
    this._puPosDirty = true;
  }

  /** The accent rule of a NEW card: the gate's colour for gate rules, the item's (WEAPONS / GEAR) colour, else the purple of
   *  the item gate (the specials arrive on it). */
  _codexAccent(id) {
    const C = GATE_RULES.colors;
    if (id === 'gate.max') return hexCss(C.max);
    if (id === 'gate.zero') return hexCss(C.zero.tint);
    const it = itemEntry(id);
    return hexCss(it && Number.isFinite(it.color) ? it.color : C.item.tint);
  }

  /** r7 fix: a guide entry's name / line — the nameFs / lineFs variant where fullscreen exists (STRINGS.codex 'ctl.mute':
   *  "F toggles fullscreen" only where F does something, like the pause legend's STRINGS.pause.controlsKeys(fs)). */
  _codexName(E) { return this._fsAvailable && typeof E.nameFs === 'string' ? E.nameFs : E.name; }
  _codexLine(E) { return this._fsAvailable && typeof E.lineFs === 'string' ? E.lineFs : E.line; }

  /**
   * Paints a codex icon box (the NEW card's, or a guide row's) for entry `id`: an item pictogram from the texture factory
   * on a light disc; a gate chip in the gate's own colours with its glyph; a key cap; a zombie's face in its palette; the
   * boss skull; or a small drawing of a HUD part. Class + inline custom properties + text, written when the id changes.
   */
  _fillCodexIcon(node, id) {
    if (!node || node.dataset.id === id) return;
    node.dataset.id = id;
    const ic = CODEX_ICON[id] || CODEX_ICON_DEFAULT;
    const st = node.style;
    st.backgroundImage = '';
    node.textContent = '';
    let cls = 'ci ci-' + ic.k;
    if (ic.k === 'item') {
      const url = this._iconUrl(ic.id || id);
      if (url) this._applyIcon(node, url);
    } else if (ic.k === 'gate') {
      const C = GATE_RULES.colors;
      const g = ic.g === 'max' ? { tint: C.max, frame: C.max } : (C[ic.g] || C.plus);
      try { st.setProperty('--ci-tint', rgbaCss(g.tint, 0.62)); st.setProperty('--ci-frame', hexCss(g.frame)); } catch (_) { /* cosmetic */ }
      node.textContent = ic.t || '';
      if (ic.wide) cls += ' ci-wide';
      if (ic.t && ic.t.length > 2) cls += ' ci-long';
    } else if (ic.k === 'zombie') {
      const z = PALETTE.zombie[ic.z] || PALETTE.zombie.walker;
      try { st.setProperty('--ci-skin', hexCss(z.skin)); st.setProperty('--ci-eyes', hexCss(z.eyes)); } catch (_) { /* cosmetic */ }
      if (ic.t) node.textContent = ic.t;
    } else if (ic.t) {
      node.textContent = ic.t;
      if (ic.k === 'key' && ic.t.length > 3) cls += ' ci-long';
    }
    if (node.className !== cls) node.className = cls;
  }

  /** One-time migration (save hint 'codex:v1'): an entry an older profile already met — its old once-ever hint is done,
   *  or the profile is past its unlock level, or (for the always-open rows) the profile is past L1 — is marked seen and
   *  read, so the guide opens without a wall of NEW tags. A fresh profile marks nothing. */
  _codexMigrate() {
    if (this._codexMigrated) return;
    this._codexMigrated = true;
    const save = this.ctx.save;
    if (!save || typeof save.hintDone !== 'function' || save.hintDone(CODEX_MIGRATED)) return;
    const hl = this._highestUnlocked();
    for (let i = 0; i < GUIDE_IDS.length; i++) {
      const id = GUIDE_IDS[i];
      const unlock = CODEX.unlock[id];
      let met = unlock > 0 ? hl > unlock : hl > 1;
      const old = CODEX.legacy[id];
      if (!met && old) for (let k = 0; k < old.length; k++) if (save.hintDone(old[k])) { met = true; break; }
      if (!met) continue;
      this._markHint(SEEN_K[id]);
      this._markHint(READ_K[id]);
    }
    this._markHint(CODEX_MIGRATED);
  }

  /** The "?" buttons wear a badge while any entry was met and not read yet (title and pause; written on change). */
  _syncGuideBadge() {
    this._codexMigrate();
    const save = this.ctx.save;
    let any = false;
    if (save && typeof save.hintDone === 'function') {
      for (let i = 0; i < GUIDE_IDS.length && !any; i++) { const id = GUIDE_IDS[i]; if (save.hintDone(SEEN_K[id]) && !save.hintDone(READ_K[id])) any = true; }
    }
    const v = any ? 1 : 0;
    if (v === this._guideNew) return;
    this._guideNew = v;
    const el = this._el;
    const label = any ? STRINGS.aria.guideNew : STRINGS.aria.guide;
    const set = (b) => { if (!b) return; try { b.classList.toggle('has-new', any); b.setAttribute('aria-label', label); } catch (_) { /* ignore */ } };
    set(el.btnGuide); set(el.btnPauseGuide);
  }

  /** Builds the guide's rows once (sections in CODEX order, an icon, the name with a NEW tag, the line). */
  _buildGuide() {
    if (this._guideBuilt || !this._doc || !this._el.guideList) return;
    this._guideBuilt = true;
    const doc = this._doc;
    const host = this._el.guideList;
    host.textContent = '';
    const rows = {};
    const C = STRINGS.codex;
    for (let s = 0; s < CODEX.sections.length; s++) {
      const sec = CODEX.sections[s];
      const head = doc.createElement('div'); head.className = 'gd-head'; head.setAttribute('role', 'heading'); head.setAttribute('aria-level', '2');
      head.textContent = C.sections[sec.id] || sec.id.toUpperCase();
      host.appendChild(head);
      if (C.notes && C.notes[sec.id]) { const n = doc.createElement('p'); n.className = 'gd-note'; n.textContent = C.notes[sec.id]; host.appendChild(n); }
      for (let i = 0; i < sec.ids.length; i++) {
        const id = sec.ids[i];
        const E = C.entries[id];
        if (!E) continue;
        const row = doc.createElement('div'); row.className = 'gd-row'; row.setAttribute('role', 'listitem');
        const icon = doc.createElement('span'); icon.setAttribute('aria-hidden', 'true');
        const body = doc.createElement('div'); body.className = 'gd-body';
        const nameRow = doc.createElement('div'); nameRow.className = 'gd-name';
        const name = doc.createElement('span'); name.className = 'gd-title';
        const tag = doc.createElement('span'); tag.className = 'gd-new'; tag.textContent = C.kicker; tag.hidden = true;
        const line = doc.createElement('div'); line.className = 'gd-line';
        nameRow.appendChild(name); nameRow.appendChild(tag);
        body.appendChild(nameRow); body.appendChild(line);
        row.appendChild(icon); row.appendChild(body);
        host.appendChild(row);
        rows[id] = { row, icon, name, tag, line, state: '' };
      }
    }
    this._guideRows = rows;
    this._observeList(host);                             // r7 fix round 3: edge fades (built lazily, after _observe)
  }

  /** Fills the guide (built once): each row's state — met (its icon, name and line), NEW (met, not read), or locked
   *  ("???" — "MEET IT ON LEVEL n" until it is met or its level is reached; rows without an unlock level are open). Writes
   *  a row only when its state changed. `show`: a real open (not the boot prewarm) — remembers the met ids (read on close)
   *  and scrolls the first NEW row into view at the start of the next update. */
  _fillGuide(show) {
    this._buildGuide();
    const rows = this._guideRows;
    if (!rows) return;
    this._codexMigrate();
    const save = this.ctx.save;
    const done = (k) => !!(save && typeof save.hintDone === 'function' && save.hintDone(k));
    const hl = this._highestUnlocked();
    const C = STRINGS.codex;
    if (show) this._guideSeen.length = 0;
    let firstNew = null;
    for (let i = 0; i < GUIDE_IDS.length; i++) {
      const id = GUIDE_IDS[i];
      const r = rows[id];
      if (!r) continue;
      const seen = done(SEEN_K[id]);
      const unlock = CODEX.unlock[id];
      const locked = !seen && unlock > 0 && hl < unlock;
      const isNew = seen && !done(READ_K[id]);
      const state = locked ? 'L' : (isNew ? 'N' : 'O');
      if (show && seen) this._guideSeen.push(id);
      if (isNew && !firstNew) firstNew = r.row;
      if (state === r.state) continue;
      const E = C.entries[id];
      r.state = state;
      if (locked) {
        r.name.textContent = C.lockedName;
        r.line.textContent = C.locked(unlock);
        r.icon.dataset.id = '';
        r.icon.className = 'ci ci-locked';
        r.icon.textContent = '';
        r.icon.style.backgroundImage = '';
      } else {
        r.name.textContent = this._codexName(E);
        r.line.textContent = this._codexLine(E);
        this._fillCodexIcon(r.icon, id);
      }
      r.tag.hidden = !isNew;
      try { r.row.classList.toggle('locked', locked); r.row.classList.toggle('new', isNew); } catch (_) { /* ignore */ }
    }
    if (show) this._guideScrollTo = firstNew;
  }

  /** Leaving the guide: every met row it showed is read (the "?" badge goes once nothing new is left). */
  _closeGuide() {
    const ids = this._guideSeen;
    const save = this.ctx.save;
    for (let i = 0; i < ids.length; i++) { const k = READ_K[ids[i]]; if (k && save && typeof save.hintDone === 'function' && !save.hintDone(k)) this._markHint(k); }
    ids.length = 0;
    this._guideScrollTo = null;
    this._syncGuideBadge();
  }

  /** Read-first phase (start of update, after the guide opened): the first NEW row is brought into view inside the list. */
  _scrollGuide() {
    const list = this._el.guideList;
    const row = this._guideScrollTo;
    this._guideScrollTo = null;
    if (!list || !row || this._current !== 'guide') return;
    try {
      const top = row.offsetTop;                    // the list is the rows' offsetParent (css: position relative)
      if (top + row.offsetHeight > list.scrollTop + list.clientHeight || top < list.scrollTop) list.scrollTop = Math.max(0, top - list.clientHeight * 0.25);
    } catch (_) { /* cosmetic */ }
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
    // round 7 (r7, flow-coins:6): real time for the coin tweens and the results theatre (one step clamped to REAL_DT_MAX);
    // the 50 ms-clamped dt stretched the 1.5 s J17 count-up to 5–30 s on a 1–4 fps box. Hints and the other theatre
    // deadlines keep dt (and _tclock)
    const rnow = this._realNow();
    const rdt = this._lastReal > 0 ? clamp(rnow - this._lastReal, 0, REAL_DT_MAX) : dt;
    this._lastReal = rnow;
    // r7 (flow-coins:2): this frame renders a screen switched between frames — its paint is marked once the frame is done
    this._inUpdate = true;
    if (this._shownWait > 0 && --this._shownWait === 0) this._armPaintMark();
    // UI-28: theatre deadlines (name card, hint, boss bar out) do not run while paused (ARCH §2.2)
    let paused = false, playing = false;
    try { const st = this.ctx.state; const cur = st ? st.current : ''; paused = cur === 'paused'; playing = cur === 'playing'; } catch (_) { paused = false; playing = false; }
    if (!paused) this._tclock += dt;
    const tnow = this._tclock;

    // read-first phase (UI-21): layout is still clean from the last rendered frame — measure / focus before any write
    if (this._lvScrollPending) { this._lvScrollPending = false; this._scrollLevels(); }
    if (this._guideScrollTo) this._scrollGuide();      // r7 (teaching:5)
    if (this._ncTagCheck) { this._ncTagCheck = false; this._breakTagline(); }   // r7 fix (teaching:3): no hanging " ·"
    if (this._focusPending) { const f = this._focusPending; this._focusPending = null; this._focusFirst(f === this._el.app ? null : f); }

    if (this._pendingSet) {
      this._flushPendingScreen();
    } else if (this._bootHiding) {
      this._bootHiding = false;
      if (this._screens.boot && !this._bootHold) this._screens.boot.hidden = true;
    }
    if (this._htmlDirty) this._applyHtmlClasses();
    if (this._pendingErr) { const m = this._pendingErr; this._pendingErr = ''; this.showError(m, false); }
    if (this._saveDirty) { this._saveDirty = false; this._refreshSaveViews(); }
    if (this._hudResetPending) { this._hudResetPending = false; this._applyHudReset(); }

    this._updateCoins(rdt);
    this._updateFlash(dt);
    this._updateVignette(dt);
    this._updateTheatre(tnow);
    if (this._dbShown || this._dbReq || this._dbHideReq) this._updateBanner(tnow, paused);
    if (this._ncdShown || this._ncdHideReq || this._ncdQ.length > 0) this._updateNewCard(tnow, paused);   // r7 (teaching:5)
    if (this._swDirty) this._syncUpdatePill();
    this._updateBlink(now);
    this._updateFire();
    // round 6: gamepad A fires while the FIRE button shows; r7 (controls:3): also while playing with nothing stored, so A can
    // show the empty slot like Space (polled only after a gamepadconnected event)
    if (this._gpSeen && (this._fireShown || playing)) this._pollGamepadFire();
    if (this._plates > 0 || this._platesShown > 0) { this._placeShield(); this._syncShield(); }

    this._hudAcc += dt;
    if (this._hudAcc >= HUD_PERIOD) {
      this._hudAcc -= HUD_PERIOD;
      if (this._hudAcc >= HUD_PERIOD) this._hudAcc = 0;
      this._updateHudBlock(now);
    }

    if (this._cmpAnimating && this._current === 'complete') this._updateComplete(rdt);
    if (this._confirmArmed && now >= this._confirmUntil) this._disarmReset();
    this._inUpdate = false;
  }

  /** r7 (flow-coins:2): the frame running now renders the switched screen — a 0 ms timer marks its paint once the frame's
   *  rendering is done. A press handled before that timer (Chrome runs queued input first) was queued during this frame,
   *  i.e. before the paint: _onPointerDom then closes the mark at that instant, so the press counts as stale. */
  _armPaintMark() {
    this._paintArmed = true;
    try { setTimeout(this._onPaintMark, 0); } catch (_) { this._onPaintMark(); }
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
    if (el.lbCount && !el.lbCount.hidden) el.lbCount.hidden = true;   // r7 (explain:6)
    this._lbDock = false;
    this._lbDockN = -1;
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
    this._writeWallet(Math.round(this._coinValue));   // r7 (flow-coins:5): every coin pill (HUD, title, shop) from this one model
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
    const idx = Math.round(this._vigA0 * u * u * OPA_STEPS);   // ease-out fade from its strength (r7: × the optional alpha)
    if (idx !== this._vigOpa && node) { this._vigOpa = idx; node.style.opacity = this._opa[idx]; }
    if (k >= 1) this._vigOn = false;
  }

  /** Boss bar show/hide, letterbox, name card and hint deadlines (theatre time: real seconds, paused time excluded). */
  _updateTheatre(now) {
    const el = this._el;
    if (this._bossShowPending) {
      this._bossShowPending = false;
      if (el.bnName) el.bnName.textContent = this._bossName;
      this._bossPhaseUntil = 0;
      if (el.bnPhase && !el.bnPhase.hidden) el.bnPhase.hidden = true;
      if (el.bossbar) {
        el.bossbar.hidden = false;
        try { el.bossbar.classList.remove('shielded', 'phase2', 'phase3', 'phase-flash'); } catch (_) { /* ignore */ }
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
    // r7 (teaching:3): the phase flash in place of the bar's name ("PHASE 2"; css hides .bn-name), then the name again
    if (this._bossPhaseReq && this._bossOn) {
      this._bossPhaseReq = false;
      if (el.bnPhase) { el.bnPhase.textContent = this._bossPhaseLabel; el.bnPhase.hidden = false; }
      if (el.bossbar) { try { el.bossbar.classList.add('phase-flash'); } catch (_) { /* cosmetic */ } }
      this._bossPhaseUntil = now + PHASE_LABEL_S;
    }
    if (this._bossPhaseUntil > 0 && now >= this._bossPhaseUntil) {
      this._bossPhaseUntil = 0;
      if (el.bnPhase) el.bnPhase.hidden = true;
      if (el.bossbar) { try { el.bossbar.classList.remove('phase-flash'); } catch (_) { /* cosmetic */ } }
    }

    if (this._lbOn !== this._lbShown) {
      this._lbShown = this._lbOn;
      if (el.letterbox) el.letterbox.hidden = !this._lbOn;
      if (el.letterboxBottom) el.letterboxBottom.hidden = !this._lbOn;
      if (this._lbOn) {
        this._animate(el.letterbox, KF_LB_TOP, T_LETTERBOX);
        this._animate(el.letterboxBottom, KF_LB_BOTTOM, T_LETTERBOX);
      }
    }
    // r7 (explain:6): while the boss-intro dolly has the world count label faded (fx) and the squad under the bars, the
    // count sits in the bottom bar ("144 SOLDIERS") — on a slow machine the intro lasted 13–24 s with no count on screen.
    // Reduced motion has no dolly. DOM writes only on a dock change or a new count
    const rnd = this.ctx.render;
    const dock = this._lbShown && !!rnd && rnd.dollying === true;
    if (dock !== this._lbDock) {
      this._lbDock = dock;
      if (el.lbCount) el.lbCount.hidden = !dock;
      this._lbDockN = -1;
    }
    if (dock && el.lbCount) {
      const sq = this.ctx.squad;
      const n = sq ? sq.count | 0 : 0;
      if (n !== this._lbDockN) { this._lbDockN = n; el.lbCount.textContent = STRINGS.boss.squad(n); }
    }

    if (this._ncPending) {
      this._ncPending = false;
      this._fillNameCard();
      if (el.namecard) { el.namecard.hidden = false; this._animate(el.namecard, KF_POP_IN, T_NAMECARD); }
      this._ncShown = true;
      this._ncUntil = now + this._nameCardSeconds();
    }
    if (this._ncShown && now >= this._ncUntil) {
      this._ncShown = false;
      if (el.namecard) el.namecard.hidden = true;
    }

    if (this._hintHideReq) { this._hintHideReq = false; if (this._hintShown) this._hideHintDom(); }
    // r7: a waiting hint past HINT_QUEUE_AGE_S leaves the queue now (a stale head used to block the yield rule below)
    while (this._hqLen > 0 && now - this._hqAt[0] > HINT_QUEUE_AGE_S) this._hintQueueRemove(0);
    if (this._hintShown) {
      const input = this.ctx.input;
      const on = now - this._hintAt;
      // r7 (teaching:0 F): marked done once it has really been on screen HINT_MARK_S (not when it appeared)
      // r7 final fix (lead decision 5): ...and only while someone is playing (trusted input within HINT_IDLE_S real s); an
      // unattended showing leaves it unread, so it teaches again next time (the tester's L1 ended in another window)
      if (!this._hintMarked && on >= HINT_MARK_S) { this._hintMarked = true; if (this._attended()) this._markHint(this._hintId); }
      // a waiting hint takes over after HINT_MIN_S on screen — a held hint after its hold, a priority one never (it runs
      // its course; another priority lesson queues behind it)
      const yieldAt = this._hintHold > HINT_MIN_S ? this._hintHold : HINT_MIN_S;
      if (now >= this._hintUntil || (this._hintId === 'steer' && input && input.hasSteered)
        || (this._hqLen > 0 && !this._hintPri && on >= yieldAt && now - this._hqAt[0] <= HINT_QUEUE_AGE_S)) this._hideHintDom();
    }
    if (!this._hintShown && this._hqLen > 0 && this._current === null) this._nextHint(now);
  }

  /** UI-25: the oldest still-fresh queued hint goes on screen (a steer hint the player already acted on is
   *  marked done and skipped). Round 7: the front holds the priority hints and the cut hints coming back. */
  _nextHint(now) {
    const input = this.ctx.input;
    while (this._hqLen > 0) {
      const id = this._hqId[0], text = this._hqText[0], at = this._hqAt[0];
      const hold = this._hqHold[0], key = this._hqKey[0], pri = this._hqPri[0] === 1, ev = this._hqEv[0], back = this._hqBack[0] === 1;
      this._hintQueueRemove(0);
      if (now - at > HINT_QUEUE_AGE_S) continue;
      if (id === 'steer' && input && input.hasSteered) { this._markHint(id); continue; }
      // r7 fix: a held lesson whose subject passes in less than HINT_MIN_S never goes up — it would flash and be released
      // (L3's first [÷2 | −13]: 'lesser' waited behind 'div' and showed for 0.64 s after the red lane had flipped). It stays
      // unmarked and teaches at its next subject. (A cut hint coming back keeps its full hold: it is not judged here)
      if (key !== null && hold > 0 && !back && hold - (now - at) < HINT_MIN_S) continue;
      this._showHintDom(id, text, now, hold, key, pri, ev, back);
      return;
    }
  }

  /** Drops every waiting hint; `hide` also takes the one on screen down (next update; it does not come back). */
  _hintQueueClear(hide) {
    for (let i = 0; i < this._hqLen; i++) { this._hqId[i] = ''; this._hqText[i] = ''; this._hqKey[i] = null; this._hqPri[i] = 0; this._hqEv[i] = -1; this._hqBack[i] = 0; }
    this._hqLen = 0;
    if (hide) { this._hintHideReq = true; this._hintCut = false; }
  }

  _markHint(id) {
    const save = this.ctx.save;
    if (!id || !save || typeof save.markHint !== 'function') return;
    try { save.markHint(id); } catch (_) { /* the save reports its own errors */ }
  }

  /** r7 final fix (lead decision 5): someone is playing — trusted input within JUICE.ui.hintIdleS real seconds
   *  (engine.inputIdleS). A harness without the engine counts as attended (the old behaviour). */
  _attended() {
    const e = this.ctx.engine;
    return !e || typeof e.inputIdleS !== 'function' || e.inputIdleS() <= HINT_IDLE_S;
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

  /** Puts one hint on screen (UI-18 pill; hand inside it for steer / shoot). No layout read: the ResizeObserver reports
   *  the pill box after this frame's layout; the label check starts then. Round 7 (r7, teaching:0): its duration from its
   *  words (and hold), its tone rim, a ui_tap on its first showing, its gate pulse, the first-time lesson slow-mo; it is
   *  marked done later, after HINT_MARK_S on screen (_updateTheatre). */
  _showHintDom(id, text, now, hold, key, pri, ev, back) {
    const el = this._el;
    this._hintId = id;
    this._hintText = text;
    const hand = HINT_HAND_IDS[id] === true;
    if (el.hintText) el.hintText.textContent = text;
    if (el.hintHand) el.hintHand.hidden = !hand;
    this._hintShown = true;
    this._hintAt = now;
    this._hintHold = hold > 0 ? hold : 0;
    this._hintKey = key === undefined ? null : key;
    this._hintPri = !!pri;
    this._hintEv = ev >= 0 ? ev : -1;
    this._hintMarked = false;
    this._hintCut = false;
    // max(HINT_S, base + per word) ≤ HINT_MAX_S; a held hint stays its hold (≤ HINT_HOLD_MAX_S) unless released earlier
    const words = typeof text === 'string' ? text.split(HINT_WORD_RE).length : 0;     // one split per hint shown (event time)
    let dur = Math.min(HINT_MAX_S, Math.max(HINT_S, HINT_BASE_S + HINT_WORD_S * words));
    if (this._hintHold > dur) dur = Math.min(HINT_HOLD_MAX_S, this._hintHold);
    this._hintUntil = now + dur;
    this._hintBoxOk = false;
    if (el.hint) {
      if (this._hintShift !== 0) { this._hintShift = 0; el.hint.style.translate = ''; }
      // r7 (teaching:0 D): a 2 px rim by tone — warn (red: it costs soldiers, dodge it), gain (green), info (none)
      const tone = HINT_TONE[id] || (id.indexOf('dodge.') === 0 || (id.indexOf('boss.') === 0 && id !== 'boss') ? 'warn' : 'info');
      if (tone !== this._hintTone) { this._hintTone = tone; el.hint.setAttribute('data-tone', tone); }
      el.hint.hidden = false;
      this._animate(el.hint, KF_POP_IN, T_NAMECARD);
    }
    this._cancelAnim(this._handAnim);
    this._handAnim = !hand ? null : this._animate(el.hintHand, KF_HAND, T_HAND);
    // r7 (teaching:0 D): a short sound draws the eye on its first showing (a cut hint coming back is silent)
    const audio = this.ctx.audio;
    if (!back && audio && typeof audio.play === 'function') { try { audio.play('ui_tap'); } catch (_) { /* audio reports its own errors */ } }
    // r7 (teaching:0 E, C's contract): the gates this lesson is about pulse while it is up (guarded: absent before the merge)
    this._pulseGates(this._hintEv, dur);
    // r7 (teaching:0, lead decision): the first time ever a core gate lesson is on screen, a brief slow-mo while it is read
    this._lessonSlowmo(id);
  }

  _hideHintDom() {
    const id = this._hintId;
    // r7 (teaching:0 F / critic): a hint a priority lesson cut before it was read (HINT_MARK_S) comes back first, after the
    // priority hints; a steer hint hidden because the player steered counts as learnt
    if (this._hintCut && !this._hintMarked && id) {
      let lead = 0;
      while (lead < this._hqLen && this._hqPri[lead] === 1) lead++;
      if (this._hqLen >= this._hqId.length) this._hintQueueRemove(this._hqLen - 1);
      HINT_BACK_OPTS.hold = this._hintHold; HINT_BACK_OPTS.until = this._hintKey; HINT_BACK_OPTS.event = this._hintEv;
      this._hintQueueInsert(Math.min(lead, this._hqLen), id, this._hintText, HINT_BACK_OPTS, false, true);
    } else if (!this._hintMarked && id === 'steer') {
      const input = this.ctx.input;
      if (input && input.hasSteered) { this._hintMarked = true; this._markHint(id); }
    }
    if (this._hintEv >= 0) this._pulseGates(this._hintEv, 0);
    // r7: the time a priority lesson held the screen does not age the hints waiting behind it ("FIRE YOUR STORED WEAPON AT
    // THE BOSS!" aged out behind two slowed attack lessons)
    if (this._hintPri) {
      const held = this._tclock - this._hintAt;
      if (held > 0) for (let i = 0; i < this._hqLen; i++) if (this._hqPri[i] !== 1) this._hqAt[i] += held;
    }
    this._hintShown = false;
    this._hintCut = false;
    this._hintKey = null;
    this._hintEv = -1;
    this._hintBoxOk = false;
    this._cancelAnim(this._handAnim);
    this._handAnim = null;
    if (this._el.hint) this._el.hint.hidden = true;
  }

  /** r7 (teaching:0 E): C's gates.pulseEvent(eventId, seconds) — pulse (or, with 0, stop) the frames of that gate event
   *  (DECISIONS §6 contract C → D; both sides are in the build since the round-7 integration, so the typeof guard is gone). */
  _pulseGates(eventId, seconds) {
    if (!(eventId >= 0)) return;
    const gates = this.ctx.gates;
    if (gates) { try { gates.pulseEvent(eventId, seconds); } catch (_) { /* cosmetic */ } }
  }

  /** r7 (teaching:0, lead decision): the first time ever 'red', 'single' or 'div' is on screen (not yet marked in the save,
   *  not slowed this run), time dips to JUICE.slowmo.lesson[0] for [1] s of real time while it is read (fx.slowmo). */
  _lessonSlowmo(id) {
    if (LESSON_SLOWMO[id] !== true || this._slowedRun.indexOf(id) !== -1) return;
    const S = JUICE.slowmo ? JUICE.slowmo.lesson : null;
    const save = this.ctx.save, fx = this.ctx.fx, st = this.ctx.state;
    if (!S || !fx || typeof fx.slowmo !== 'function' || (save && typeof save.hintDone === 'function' && save.hintDone(id))) return;
    if (!st || typeof st.is !== 'function' || !st.is('playing')) return;
    this._slowedRun.push(id);
    try { fx.slowmo(S[0], S[1]); } catch (_) { /* fx reports its own errors */ }
  }

  _hideBossBar() {
    this._bossOn = false;
    this._bossHideAt = 0;
    this._bossPhaseReq = false;                     // r7: no phase flash left behind
    this._bossPhaseUntil = 0;
    if (this._el.bnPhase && !this._el.bnPhase.hidden) this._el.bnPhase.hidden = true;
    if (this._el.bossbar) { try { this._el.bossbar.classList.remove('phase-flash'); } catch (_) { /* cosmetic */ } }
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
    this._walletSync(coins, false);                 // r7 (flow-coins:5): the title pill is a view of the one wallet model
    const hl = this._highestUnlocked();
    const rec = d && d.levels ? d.levels[hl] : null;
    const stars = rec ? rec.stars | 0 : 0;
    if (el.titleCaption) {
      // r7 (explain:0): the caption names the survivors the 3★ need on the level PLAY starts ("★★★ at 176")
      el.titleCaption.textContent = STRINGS.title.caption(hl, stars, starNeed(eBossOf(hl), 3));
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
    this._syncGuideBadge();                         // r7 (teaching:5): "?" wears a badge while a met entry is unread
    if (el.btnFullscreen) el.btnFullscreen.hidden = !this._fsAvailable;
    // r7: the title's icon cluster lays out by count (css: the fullscreen icon takes the third slot after "?")
    const tscr = this._screens ? this._screens.title : null;
    if (tscr) { try { tscr.classList.toggle('has-fs', this._fsAvailable); } catch (_) { /* ignore */ } }
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
      const txt = endlessOn && best > 0 ? STRINGS.endless.best(fmtCompact(best)) : '';   // r7 (flow-coins:7): the one compact label
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
    this._observeList(grid);                             // r7 fix round 3: its edge fades follow the tiles shown
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
    // r7 (explain:3): a skull tile is a district finale (every level has a boss) — "Level 5 · District finale · SUNSET …"
    t.btn.setAttribute('aria-label', (locked ? STRINGS.aria.level(n) + sep + STRINGS.levels.locked
      : (milestone ? STRINGS.aria.level(n) + sep + STRINGS.levels.finale : STRINGS.aria.level(n))) + dsuffix);
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
    const d = this._saveData();
    const coins = d ? d.coins : 0;
    this._walletSync(coins, false);                 // r7 (flow-coins:5): the shop pill is a view of the one wallet model
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
    let estimates = false;
    // round 7 (r7, explain:2): the legend under the coin pill says what "~N runs away" counts, while a card shows one
    const legend = income > 0 ? STRINGS.shop.note(fmtCoins(income)) : '';
    for (let i = 0; i < UPGRADE_IDS.length; i++) if (this._refreshCard(UPGRADE_IDS[i], d, coins, income, legend)) estimates = true;
    const note = estimates ? legend : '';
    if (note !== this._shopNoteText) {
      this._shopNoteText = note;
      if (this._el.shopNote) this._el.shopNote.textContent = note;
    }
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

  /** One card in place; returns true when it shows a "~N runs away" estimate (round 7: the shop legend's condition).
   *  `legend` = the #shop-note text that explains it (r7 final fix: also the estimate's title / description, _estimateTip). */
  _refreshCard(id, d, coins, income, legend) {
    const c = this._cards ? this._cards[id] : null;
    if (!c) return false;
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
      // round 7 (r7, explain:2): a maxed card says so (css: success green), next to the final value and the green pips
      c.estimate.textContent = STRINGS.shop.maxed;
      c.estimate.hidden = false;
      this._estimateTip(c, '');
      if (c.then) c.then.textContent = '';
      return false;
    }
    const cost = upgradeCost(id, rank + 1);
    const afford = coins >= cost;
    // one-line caption: an upgrade with a unit suffix prints it once ("9 → 11 soldiers", UPGRADES.*.fmtDelta)
    c.effect.textContent = typeof u.fmtDelta === 'function' ? u.fmtDelta(cur, u.effect(rank + 1))
      : STRINGS.shop.delta('', u.fmt(cur), u.fmt(u.effect(rank + 1))).trim();
    const price = fmtCoins(cost);                    // r7 (flow-coins:7): "1,130", as the coin pill prints it
    c.price.textContent = price;
    c.bIcon.hidden = false;
    c.buy.disabled = false;
    try { c.buy.classList.remove('max'); c.buy.classList.toggle('cant', !afford); } catch (_) { /* ignore */ }
    if (afford) c.buy.removeAttribute('aria-disabled'); else c.buy.setAttribute('aria-disabled', 'true');
    c.buy.setAttribute('aria-label', STRINGS.shop.buy + ' ' + u.name + STRINGS.common.separator + price + ' ' + STRINGS.common.coins);
    // r7 (from balance:9): the price of the rank after this one — upgradeCost(id, rank + 2), so it follows the data's price
    // growth — under BUY on every card that has one
    if (c.then) c.then.textContent = rank + 2 <= u.ranks ? STRINGS.shop.then(fmtCoins(upgradeCost(id, rank + 2))) : '';
    if (!afford && income > 0) {
      c.estimate.textContent = STRINGS.shop.estimate(Math.ceil((cost - coins) / income));
      c.estimate.hidden = false;
      this._estimateTip(c, legend || '');
      return true;
    }
    c.estimate.textContent = '';
    c.estimate.hidden = true;
    this._estimateTip(c, '');
    return false;
  }

  /**
   * r7 final fix (lead decision 6): a "~N runs away" estimate carries the legend's meaning itself — a title (the hover
   * tooltip) with the legend text and aria-describedby → #shop-note (an accessible description reads a display:none node
   * it names) — for the boxes whose css hides the legend (landscape ≤ 330 px tall: 512 × 297 = the tester's 200 % zoom,
   * 568 × 320); set on every box (where the legend shows it only repeats it). Attributes only: the layout does not
   * change. Written on change (c.tip).
   */
  _estimateTip(c, text) {
    if (c.tip === text) return;
    c.tip = text;
    const n = c.estimate;
    try {
      if (text) { n.title = text; n.setAttribute('aria-describedby', 'shop-note'); }
      else { n.removeAttribute('title'); n.removeAttribute('aria-describedby'); }
    } catch (_) { /* cosmetic */ }
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
    // r7 (flow-coins:5): the purchase counts down once, on the one wallet model, from the value on screen
    this._walletSync(after, true);
    this._refreshCards(after);
    const c = this._cards[id];
    if (c) {
      this._animate(c.card, KF_FLASH, T_FLASH);
      const pip = c.pips[rank];
      if (pip) this._animate(pip, KF_POP_IN, T_NAMECARD);
    }
  }

  /** save:change → the wallet (outside a run), the SHOP badges and the shop cards (whichever is visible). Round 7 (r7,
   *  flow-coins:5): the coin pills follow the one wallet model — not while playing / paused, where the run's coins:change
   *  are authoritative (the header shows the saved coins plus the run's, and a markHint save:change must not drop it). */
  _refreshSaveViews() {
    const cur = OVERLAY_IDS[this._current] === true ? this._beforeSettings : this._current;
    if (cur === 'title' || cur === 'pause') this._syncGuideBadge();   // r7 (teaching:5): the "?" badge (a new entry met)
    const d = this._saveData();
    const coins = d ? d.coins : 0;
    let inRun = false;
    try { const st = this.ctx.state; inRun = !!st && (st.current === 'playing' || st.current === 'paused'); } catch (_) { inRun = false; }
    if (!inRun) this._walletSync(coins, true);
    if (cur === 'title' || cur === 'complete' || cur === 'gameover') this._syncShopBadges();
    if (cur === 'shop') this._refreshCards(coins);
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
    if (el.rowFullscreen && el.rowFullscreen.hidden === this._fsAvailable) el.rowFullscreen.hidden = !this._fsAvailable;
    this._syncFullscreenButton();                    // r7 (layout:3): the toggle shows the real fullscreen state
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
    // r7 (flow-coins:6 / :7): "Earned +1,340" — this run's payout, in full
    if (el.completeCoins) el.completeCoins.textContent = STRINGS.complete.coins(fmtCoins(this._cmpCoinShown));
    const list = el.completeBreakdown;
    if (list && this._doc) {
      list.textContent = '';
      const B = STRINGS.complete.breakdown;
      for (let i = 0; i < BD_KEYS.length; i++) {
        const key = BD_KEYS[i];
        // r7 (explain:7): the level bonus as its two parts — the stars' reward ("★★★ +160") and the survivors' ("Survivors +69")
        if (key === 'bonus' && c.split) {
          this._chip(list, 'bd-bonus bd-stars', STRINGS.common.star.repeat(c.stars), c.bonusStars);
          this._chip(list, 'bd-bonus bd-survivors', B.survivors, c.bonusSurv);
          continue;
        }
        this._chip(list, 'bd-' + key, B[key], c[key] | 0);
      }
    }
    if (el.completeBest) {
      const d = this._saveData();
      const rec = d && d.levels ? d.levels[c.level] : null;
      const best = rec && Number.isFinite(rec.bestSurvivors) ? rec.bestSurvivors : c.survivors;
      const sep = STRINGS.common.separator;
      // round-3 FTUE: a first clear prints its survivors alone (the "best" was this very run: "239 survivors · Best survivors
      // at boss: 239"); beating an earlier best says NEW BEST!; otherwise the best stays the target to beat
      const prev = c.level === this._runLevel ? this._prevBest : -2;
      let line = STRINGS.complete.survivors(c.survivors);
      // r7 (explain:0): the star thresholds of this level (data.starNeed, the rule level._commitWon awarded them by) —
      // "172 survivors · ★★★ at 176" (2★), "65 survivors · ★★ at 178 · ★★★ at 284" (1★), "172 survivors · ★★★ at 164" (3★)
      if (c.eBoss > 0) {
        const g3 = STRINGS.complete.goal(3, starNeed(c.eBoss, 3));
        line += sep + (c.stars < 2 ? STRINGS.complete.goal(2, starNeed(c.eBoss, 2)) + sep + g3 : g3);
      }
      if (prev >= 0 && c.survivors > prev && STRINGS.complete.newBest) line += sep + STRINGS.complete.newBest;
      else if (prev !== -1 && best > c.survivors) line += sep + STRINGS.complete.best(best);
      el.completeBest.textContent = line;
    }
    this._cmpT = 0;
    this._cmpStarsShown = fresh ? 0 : c.stars;
    this._cmpAnimating = fresh;
    if (fresh) {
      // r7 (flow-coins:6): the header counts with the payout — from what it shows (the run's coins, a few still in the air)
      // to the new total, never down; _cmpBase = the wallet before this run (level._commitWon added exactly c.coins)
      const d = this._saveData();
      const total = d ? d.coins : 0;
      this._cmpBase = Math.max(0, total - c.coins);
      this._cmpWalletFrom = Math.round(this._coinValue);
      this._cmpDrive = true;
    }
    this._syncShopBadges();
  }

  /** One results chip "Label +N" (N in full, fmtCoins); none for N ≤ 0. Built on entering the screen only. */
  _chip(list, cls, label, n) {
    if (!(n > 0) || !this._doc) return;
    const li = this._doc.createElement('li');
    li.className = cls;
    li.textContent = STRINGS.complete.breakdownLine(label, fmtCoins(n));
    list.appendChild(li);
  }

  /** Results theatre (J17): stars slam in one by one (0.25 s each, ui_star) while the coins count up (30/s, capped at
   *  COUNT_UP_MAX_S). Round 7 (r7, flow-coins:6): on real time (rdt), and the count starts with the first star, so "+0"
   *  shows for at most 0.25 s and the whole theatre ends within 0.25 + 1.5 s on any machine; the wallet header follows the
   *  count (_driveWallet). */
  _updateComplete(dt) {
    this._cmpT += dt;
    const t = this._cmpT;
    const c = this._cmp;
    while (this._cmpStarsShown < c.stars && t >= STAR_STAGGER * (this._cmpStarsShown + 1)) this._revealStar(this._cmpStarsShown++, true);
    const countStart = STAR_STAGGER;
    if (t < countStart) return;
    const dur = c.coins > 0 ? Math.min(COUNT_UP_MAX_S, c.coins / COUNT_RATE) : 0;
    const k = dur > 0 ? Math.min(1, (t - countStart) / dur) : 1;
    const v = Math.round(c.coins * ease.outQuad(k));
    if (v !== this._cmpCoinShown) {
      this._cmpCoinShown = v;
      if (this._el.completeCoins) this._el.completeCoins.textContent = STRINGS.complete.coins(fmtCoins(v));
      if (this._cmpDrive) this._driveWallet(v);
    }
    if (k >= 1 && this._cmpStarsShown >= c.stars) this._endCompleteTheatre();
  }

  /** r7 (flow-coins:6): header = max(what it showed when the results appeared, wallet before the run + the count so far). */
  _driveWallet(v) {
    const w = Math.max(this._cmpWalletFrom, this._cmpBase + v);
    if (!(w > this._coinValue)) return;
    this._coinTween = false;
    this._coinHold = false;
    this._coinFrom = this._coinTo = this._coinValue = w;
    this._writeWallet(Math.round(w));
  }

  /** The results theatre is over (counted out, skipped by a tap, or left): the header lets go of the count and settles on
   *  the save (both end on the same total). */
  _endCompleteTheatre() {
    this._cmpAnimating = false;
    if (!this._cmpDrive) return;
    this._cmpDrive = false;
    const d = this._saveData();
    if (d) this._walletSync(d.coins, false);
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

  /** Tap on the results panel skips the theatre; round 7 (r7): leaving the screen mid-theatre ends it too (`withSound`
   *  false: no last star sting). Stars, the "Earned" line and the wallet header go final at once. */
  _finishCompleteAnim(withSound) {
    const c = this._cmp;
    const sound = withSound !== false;
    while (this._cmpStarsShown < c.stars) this._revealStar(this._cmpStarsShown++, sound && this._cmpStarsShown === c.stars);
    this._cmpCoinShown = c.coins;
    if (this._el.completeCoins) this._el.completeCoins.textContent = STRINGS.complete.coins(fmtCoins(c.coins));
    this._endCompleteTheatre();
  }

  _fillGameover() {
    const f = this._fail;
    // round 3 (GDD §14 UI-33): the failed level as a kicker above SQUAD LOST, spelled like the HUD and results ('LEVEL 7')
    const lv = this._el.gameoverLevel;
    if (lv) lv.textContent = (STRINGS.gameover.level || STRINGS.hud.level)(f.level);
    if (this._el.gameoverInfo) this._el.gameoverInfo.textContent = STRINGS.gameover.info(Math.round(clamp(f.fraction, 0, 1) * 100), fmtCoins(f.coinsKept));
    // round 7 (r7, from balance:10): RETRY after a failure plays a new road (seed 1000 + L + 100·failures); the authored L1
    // always replays its own, so it gets no note
    const note = this._el.retryNote;
    if (note) { const show = !LEVELS.authored[f.level]; if (note.hidden === show) note.hidden = !show; }
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
    // round 7 (r7, flow-coins:7): score, best and coins in full with separators, like every other coin number
    line('es-score', STRINGS.endless.score(fmtCoins(e.score)));
    line('es-best', STRINGS.endless.best(fmtCoins(e.best)));
    line('es-coins', STRINGS.endless.coins(fmtCoins(e.coins)));
  }

  /**
   * Round 7 (r7, controls:4 + teaching:8): the pause panel's one controls line — STRINGS.pause.controlsKeys with a fine pointer
   * / no touch (the steerDesktop rule; "F FULLSCREEN" only where fullscreen exists), else controlsTouch. Its " · " items
   * become nowrap spans that wrap as whole items (css #pause-controls: a centred flex row with gaps, so no line starts or
   * ends on a stray "·"); in the keys line each item's last word is the action and the words before it are keys, drawn as
   * key caps (<kbd>; "/" stays a plain "or"). Rebuilt only when the text changes (at most once per input kind).
   */
  _fillPauseControls() {
    const n = this._el ? this._el.pauseControls : null;
    const doc = this._doc;
    if (!n || !doc) return;
    const keys = prefersDesktopSteerHint();
    const t = keys ? STRINGS.pause.controlsKeys(this._fsAvailable) : STRINGS.pause.controlsTouch;
    if (n.dataset.text === t) return;
    n.dataset.text = t;
    n.textContent = '';
    try { n.classList.toggle('keys', keys); } catch (_) { /* cosmetic */ }
    const items = t.split(' · ');
    for (let i = 0; i < items.length; i++) {
      const item = doc.createElement('span');
      item.className = 'pc-item';
      const words = items[i].split(/[  ]+/);
      if (!keys || words.length < 2) item.textContent = items[i];
      else {
        for (let w = 0; w < words.length - 1; w++) {
          const k = doc.createElement(words[w] === '/' ? 'span' : 'kbd');
          if (words[w] === '/') k.className = 'pc-or';
          k.textContent = words[w];
          item.appendChild(k);
        }
        const act = doc.createElement('span');
        act.className = 'pc-act';
        act.textContent = words[words.length - 1];
        item.appendChild(act);
      }
      n.appendChild(item);
    }
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
    // round 7 (r7, flow-coins:2): a pointer click (trusted, detail > 0) whose press came before the screen under it was
    // painted was aimed at the screen before — a second NEXT on a slow box restarted the level, a late results HOME paused
    // the next level from the HUD pause button in the same corner (r7 fix: _staleAt also holds a new run's HUD buttons for
    // HUD_ARM_MS after its paint). Keyboard / assistive clicks (detail 0) and synthetic ones (engine's Back guard,
    // element.click()) are never stale
    const id = btn.id || '';
    if (e.isTrusted && e.detail > 0 && this._downStamp > 0 && this._staleAt(this._downStamp, id)) return;
    // round 6: FIRE fired on its pointerdown (or the key); only a click with no activation just before it (Enter on the
    // focused button, assistive tech) fires here. No ui:button — the weapon's own sting is the feedback, not ui_tap
    if (id === 'btn-fire') { if (this._realNow() >= this._fireClickUntil) this._fireTap(); return; }
    P_BUTTON.id = id || this._buttonKind(btn);
    const events = this.ctx.events;
    if (events) events.emit('ui:button', P_BUTTON);
    this._route(btn, id);
    // r7 (flow-coins:2): the screen of the state this click set shows now, in the click's own task — not one (multi-second)
    // frame later, while the old buttons stay up and take more clicks
    if (this._pendingSet) this._flushPendingScreen();
  }

  /** r7 (flow-coins:2): true when a trusted press at `stamp` (performance.now() ms) on button `id` was aimed at the screen
   *  before — pressed before the current screen painted; r7 fix: or, on the HUD pause / FIRE button of a new run, less than
   *  HUD_ARM_MS after that paint. The error box's RELOAD is never stale (it covers every screen; no screen is under it). */
  _staleAt(stamp, id) {
    if (id === 'btn-reload') return false;
    const painted = this._paintedStamp();
    if (stamp < painted) return true;
    return this._hudArm && this._current === null && (id === 'btn-pause' || id === 'btn-fire') && stamp < painted + HUD_ARM_MS;
  }

  /** r7 (flow-coins:2): performance.now() ms from which the current screen counts as painted (showScreen, _armPaintMark);
   *  while that is not known yet, STALE_CLICK_MAX_MS after the switch (frames that never come must not eat every click). */
  _paintedStamp() {
    const s = this._shownStamp;
    return s === Infinity ? this._shownAt + STALE_CLICK_MAX_MS : s;
  }

  /** performance.now() in ms (guarded; NaN without it, which disables the stale-click guard). */
  _perfMs() {
    try {
      if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
    } catch (_) { /* fall through */ }
    return NaN;
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
      case 'btn-guide':
      case 'btn-pause-guide': this.showScreen('guide'); return;   // r7 (teaching:5): the FIELD GUIDE (title / pause "?")
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
    this._clearStarting();
    if (typeof level.requestStart !== 'function') { level.start(n); return; }
    if (level.requestStart(n)) return;
    this._markStarting(btn);
  }

  /** Round 5 integration: RETRY / REPLAY / RESTART through level.requestRestart (same rule as restart(), no synchronous
   *  generation; .starting while it waits). Older levels without it: restart(). */
  _restartLevel(btn) {
    const level = this.ctx.level;
    if (!level) return;
    this._clearStarting();
    if (typeof level.requestRestart !== 'function') { level.restart(); return; }
    if (level.requestRestart()) return;
    this._markStarting(btn);
  }

  /** The tapped menu button waits for its generated script: .starting (round 7, flow-coins:3: css draws a spinner on it — the
   *  0.5 s brightness pulse alone was missed) and aria-busy, until the next screen change (_flushPendingScreen). */
  _markStarting(btn) {
    if (!btn || !btn.classList) return;
    try { btn.classList.add('starting'); btn.setAttribute('aria-busy', 'true'); this._startingBtn = btn; } catch (_) { /* cosmetic */ }
  }

  /** BACK (§10.3): closes the settings overlay (r7: or the FIELD GUIDE), else returns to title / complete / gameover. */
  _back() {
    const state = this.ctx.state;
    if (OVERLAY_IDS[this._current] === true) {
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
      // r7 (layout:3): not a saved setting — the toggle asks for the opposite of the real state (the change event runs
      // inside the click's / Space's user activation, so requestFullscreen is allowed); fullscreenchange or a refusal
      // re-syncs the box (_syncFullscreenButton)
      case 'set-fullscreen': if (isChange) this._toggleFullscreen(); return;
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

  /** Escape closes the settings overlay / leaves levels and shop (consumed so engine does not also resume).
   *  Round 7 (r7): F toggles fullscreen (layout:3); PageUp / PageDown / Home / End scroll the screen's list (layout:1). */
  _key(e) {
    if (!e) return;
    if (this._pointerMode) this._setPointerMode(false);      // keyboard user: show the focus ring again
    const code = e.code || e.key;
    if (code === 'Space' || code === ' ') { this._fireKey(e); return; }   // round 6: Space fires a stored weapon
    if (code === 'KeyF') { this._fullscreenKey(e); return; }
    if (code === 'PageDown' || code === 'PageUp' || code === 'Home' || code === 'End') { this._pageKey(e, code); return; }
    if (code !== 'Escape' || e.repeat) return;
    const cur = this._current;
    if (cur !== 'settings' && cur !== 'guide' && cur !== 'levels' && cur !== 'shop') return;
    try { e.preventDefault(); e.stopPropagation(); } catch (_) { /* ignore */ }
    P_BUTTON.id = 'back';
    const events = this.ctx.events;
    if (events) events.emit('ui:button', P_BUTTON);
    this._back();
    if (this._pendingSet) this._flushPendingScreen();   // r7 (flow-coins:2): the state's screen shows in this key task
  }

  /** Input modality (UI-14): html.pointer-input scopes out the :focus-visible ring (css) after a pointer press
   *  and from boot until the first key press; any keydown removes it so Tab / arrows show focus. */
  _setPointerMode(on) {
    this._pointerMode = on;
    const doc = this._doc;
    if (!doc || !doc.documentElement) return;
    try { doc.documentElement.classList.toggle('pointer-input', on); } catch (_) { /* ignore */ }
  }

  /** Title icon, SETTINGS toggle (r7) and F (r7): leave fullscreen when in it, else ask for it. A refused request
   *  (policy, no user activation) re-syncs the controls, so the SETTINGS toggle never stays ticked by mistake. */
  _toggleFullscreen() {
    const d = this._doc;
    if (!d || !this._fsAvailable) return;
    try {
      if (this._fsActive()) {
        const exit = d.exitFullscreen || d.webkitExitFullscreen;
        if (typeof exit === 'function') {
          const p = exit.call(d);
          if (p && typeof p.catch === 'function') p.catch(this._onFsRefused);
        }
        return;
      }
      const root = d.documentElement;
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (typeof req !== 'function') { this._syncFullscreenButton(); return; }
      const p = req.call(root, FULLSCREEN_OPTS);
      if (p && typeof p.then === 'function') p.then(lockPortrait, this._onFsRefused);
    } catch (_) { this._syncFullscreenButton(); }   // refused (iframe / policy)
  }

  /** True while the document is in fullscreen (guarded). */
  _fsActive() {
    const d = this._doc;
    if (!d) return false;
    try { return !!(d.fullscreenElement || d.webkitFullscreenElement); } catch (_) { return false; }
  }

  /** The title icon's aria-pressed and (r7, layout:3) the SETTINGS toggle follow the real fullscreen state. */
  _syncFullscreenButton() {
    const el = this._el;
    if (!el || !this._doc) return;
    const on = this._fsActive();
    if (el.btnFullscreen) el.btnFullscreen.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (el.setFullscreen && el.setFullscreen.checked !== on) el.setFullscreen.checked = on;
    this._coinPosDirty = true;
    this._puPosDirty = true;
  }

  /** fullscreenchange. Round 7 (r7, layout:3): leaving fullscreen while playing pauses the run — the browser keeps the
   *  Esc that exits fullscreen (the page never sees it, so engine's Esc-to-pause cannot run) and the run would carry
   *  on in a window that just shrank. engine.pause() is not a toggle: an already paused run stays paused. */
  _fsChanged() {
    this._syncFullscreenButton();
    if (this._fsActive()) return;
    const st = this.ctx.state, engine = this.ctx.engine;
    if (st && typeof st.is === 'function' && st.is('playing') && engine && typeof engine.pause === 'function') engine.pause();
  }

  /** Round 7 (r7, layout:3): F toggles fullscreen in every state (the desktop convention; keydown is a user
   *  activation). Never with a modifier (Ctrl+F is the browser's find), held, while typing, or where unavailable. */
  _fullscreenKey(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !this._fsAvailable) return;
    const t = e.target;
    let typing = false;
    try { typing = !!(t && typeof t.closest === 'function' && t.closest(TEXT_ENTRY_SELECTOR)); } catch (_) { typing = false; }
    if (typing) return;
    try { e.preventDefault(); } catch (_) { /* ignore */ }
    this._toggleFullscreen();
  }

  // -------------------------------------------------------------------------------------------
  // Round 7 (r7, layout:0 / :1): wheel and page-key forwarding to the current screen's scroll box (SCROLL_LIST_ID).
  // DOM-event handlers like _key / _click, so the scroll write happens here, not in update().
  // -------------------------------------------------------------------------------------------

  /** The current screen's scroll box (SCROLL_LIST_ID), or null. */
  _scrollList() {
    const lists = this._scrollLists;
    const cur = this._current;
    if (!lists || !cur || !Object.prototype.hasOwnProperty.call(lists, cur)) return null;
    return lists[cur] || null;
  }

  /** True when the browser scrolls this wheel by itself: `t` or an ancestor below #app is a vertical scroll box whose
   *  content overflows (the list itself, a results / pause screen that scrolls, SETTINGS) — overscroll-behavior:
   *  contain keeps the wheel there even at its end, so forwarding it too would scroll twice. */
  _nativeScroll(t) {
    const stop = this._el ? this._el.app : null;
    const view = this._doc ? this._doc.defaultView : null;
    for (let n = t; n && n !== stop && n.nodeType === 1; n = n.parentElement) {
      if (!(n.scrollHeight > n.clientHeight + 1)) continue;
      let oy = '';
      try { oy = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(n).overflowY : ''; } catch (_) { oy = ''; }
      if (oy === 'auto' || oy === 'scroll') return true;
    }
    return false;
  }

  /** wheel on #app (passive): scrolls the current screen's list when nothing under the pointer scrolls natively.
   *  ctrl + wheel (and a trackpad pinch) is the browser's zoom; a horizontal-only wheel is left alone. */
  _wheel(e) {
    if (!e || e.ctrlKey) return;
    const list = this._scrollList();
    if (!list) return;
    let dy = e.deltaY;
    if (!(dy > 0 || dy < 0)) return;
    if (this._nativeScroll(e.target)) return;
    const max = list.scrollHeight - list.clientHeight;
    if (!(max > 1)) return;
    if (e.deltaMode === 1) dy *= WHEEL_LINE_PX;
    else if (e.deltaMode === 2) dy *= list.clientHeight;
    const top = list.scrollTop;
    const to = clamp(top + dy, 0, max);
    if (to !== top) list.scrollTop = to;
  }

  /** PageUp / PageDown / Home / End with the focus outside the current screen's list (SHOP opens with it on BACK)
   *  scroll that list; with the focus inside it the browser scrolls the focused control's own box. Not with a
   *  modifier (Ctrl+PageDown switches tabs), and only when the list overflows. */
  _pageKey(e, code) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const list = this._scrollList();
    if (!list) return;
    let inside = false;
    try { const a = this._doc ? this._doc.activeElement : null; inside = !!a && list.contains(a); } catch (_) { inside = false; }
    if (inside) return;
    const max = list.scrollHeight - list.clientHeight;
    if (!(max > 1)) return;
    const top = list.scrollTop;
    const page = Math.max(WHEEL_LINE_PX, list.clientHeight * PAGE_FRAC);
    const to = code === 'Home' ? 0 : code === 'End' ? max : clamp(top + (code === 'PageDown' ? page : -page), 0, max);
    if (to !== top) list.scrollTop = to;
    try { e.preventDefault(); } catch (_) { /* ignore */ }
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
      if (this._fireEmptyUntil > 0) this._endFireEmpty();   // r7 (controls:3): a weapon arrived during the empty flash
      this._fireShown = show;
      b.hidden = !show;
      this._puPosOk[FIRE_POS] = 0;
      const hud = el.hud;
      if (hud) { try { hud.classList.toggle('fire-on', show); } catch (_) { /* ignore */ } }
      if (show) { this._cancelAnim(this._fireAnim); this._fireAnim = this._animate(b, KF_POP_IN, T_NAMECARD); }
      // (r7: gamepad A is polled all through a run now, so its edge state stays true to the pad when the button hides)
    }
    if (!show) {
      if (this._fireEmptyUntil > 0 && this._realNow() >= this._fireEmptyUntil) this._endFireEmpty();
      return;
    }
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
    // r7 fix (flow-coins:2): FIRE fires on its press, so the stale-press rule of _click applies here (a press aimed at the
    // pause panel or the results must not spend a stored weapon)
    if (e.isTrusted && e.timeStamp > 0 && this._staleAt(e.timeStamp, 'btn-fire')) return;
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
    if (ok || !this._el.btnFire) return;
    if (this._fireShown) {
      this._cancelAnim(this._fireAnim);
      this._fireAnim = this._animate(this._el.btnFire, KF_FIRE_DENY, T_FIRE_DENY);
    } else this._fireEmpty();   // r7 (controls:3): nothing stored — only Space / gamepad A get here (the button is hidden)
  }

  /**
   * Round 7 (r7, controls:3): Space / gamepad A with no weapon stored or running briefly shows the empty FIRE slot ("EMPTY",
   * dark ring, no pictogram; css #btn-fire.empty — it takes no pointer), so the player learns where weapons go and what the
   * key does. One flash at a time (FIRE_EMPTY_S); a weapon arriving meanwhile takes the normal pop-in path (_updateFire).
   */
  _fireEmpty() {
    const el = this._el;
    const b = el ? el.btnFire : null;
    if (!b) return;
    const now = this._realNow();
    if (now < this._fireEmptyUntil) return;
    this._fireEmptyUntil = now + FIRE_EMPTY_S;
    try { b.classList.add('empty'); b.classList.remove('ready', 'busy'); } catch (_) { /* cosmetic */ }
    if (el.fireLabel) el.fireLabel.textContent = STRINGS.fire.empty;
    if (el.fireBadge && !el.fireBadge.hidden) el.fireBadge.hidden = true;
    b.setAttribute('aria-label', STRINGS.fire.ariaEmpty);
    b.hidden = false;
    if (el.hud) { try { el.hud.classList.add('fire-on'); } catch (_) { /* ignore */ } }   // the hint pill moves left, as for a weapon
    this._puPosOk[FIRE_POS] = 0;
    this._cancelAnim(this._fireAnim);
    this._fireAnim = this._animate(b, KF_FIRE_EMPTY, T_FIRE_EMPTY);
  }

  /** Ends the empty-slot flash: label and classes back; hidden again unless a weapon now shows (the normal sync redraws). */
  _endFireEmpty() {
    this._fireEmptyUntil = 0;
    const el = this._el;
    const b = el ? el.btnFire : null;
    if (!b) return;
    try { b.classList.remove('empty'); } catch (_) { /* cosmetic */ }
    if (el.fireLabel) el.fireLabel.textContent = STRINGS.fire.label;
    if (!this._fireShown) {
      b.hidden = true;
      if (el.hud) { try { el.hud.classList.remove('fire-on'); } catch (_) { /* ignore */ } }
      this._cancelAnim(this._fireAnim);
      this._fireAnim = null;
    }
    this._fireId = ''; this._fireBusy = -1; this._fireCount = -1; this._fireRingId = '';
    this._puPosOk[FIRE_POS] = 0;
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
