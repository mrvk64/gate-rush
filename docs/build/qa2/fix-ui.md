# Round-2 fixer report — group "ui"

Files edited: `js/ui.js`, `css/game.css`, `index.html`, `js/save.js`. Targeted edits: `js/data.js` (JUICE.ui `hintY` retired; `hintBottomPx`, `hintMaxWidthPct`, `hintAlpha`, `hintQueueMax`, `confirmMinS` added; `STRINGS.boot.steps`; `STRINGS.hud.level`), `docs/GDD.md` §14, `docs/ARCHITECTURE.md` §10.3. I did not touch `sw.js` or `manifest.webmanifest`: the precache list is unchanged, and code is network-first.

Checks: `node --check` passes for ui.js, save.js and data.js. `node tools/check-imports.js` reports 0 errors and 0 warnings. `node tools/callsites.js` was re-run. All smoke runs are CLEAN: boot, play L1 60 s and 75 s, the ui scenario, the sandbox shell and desktop.

Evidence lives under `docs/build/qa2/fix-ui/`. Two caveats:
- **Disk.** C: was full (0–50 MB free; other fixers fill it too). Large traces, CPU profiles and most PNGs went to `E:/Temp/fxui/`. Summaries and key screenshots were copied back; scratch scripts are in `fix-ui/lib/` and `fix-ui/mobile/`.
- **Host load.** The host was heavily loaded the whole time: about 35 ms background frames, and the localhost HTML took up to 5 s. Absolute frame numbers are noisy, so the A/B comparisons below were run on the same host in the same session.

---

## UI-18 (major): hint pills cover gates and the boss. **Fixed**

**What changed**
- **Position.** `css/game.css:929` `#hint` is bottom-anchored: `bottom: calc(var(--safe-bottom) + var(--hint-bottom) * var(--u))`.
- **Layout.** Row layout, hand icon at 32·u inside the pill's left edge (`#hint-hand`), text 21·u with `text-wrap: balance`.
- **Size and style.** `max-width: calc(var(--hint-maxw) - safe insets)`. Background alpha comes from `var(--hint-alpha)`.
- **Removed.** The `#hud.boss-on #hint` rule and `--hint-y` are gone.
- **Data.** `ui.init` writes `--hint-bottom`, `--hint-maxw` and `--hint-alpha` from `JUICE.ui.hintBottomPx` (28), `hintMaxWidthPct` (86) and `hintAlpha` (0.72). `JUICE.ui.hintY` is retired (data.js ~1231).
- **No layout reads in the frame (`js/ui.js`).**
  - The old `_placeHint` measurement and its `getBoundingClientRect` calls are deleted.
  - New `_placeHint` (ui.js:1993) compares the projected label (`_projectLabel`, arithmetic only) with the pill box. The box is cached by a ResizeObserver (`_observe` / `_observed`, :865/:877); the reads are `offset*` inside the RO callback, after layout.
  - On overlap the pill shifts sideways with the CSS `translate` property, which composes with the pop-in transform. Shift strings come from a table.
- **Hand.** Shown only for `steer` and `shoot` (`HINT_HAND_IDS`). Steer sways 5 px; shoot gets a tap pulse.
- **Reduced motion.** `_animate` skips under reduced motion, and the ripple `::after` is `display:none`.
- **Pointer events.** `pointer-events: none` is kept.
- **Debug overlay.** On phones `#debug` is now `z-index: 0` (under `#hud`), so the pill draws over it.

**Verification**
- **L1 smoke.** `fix-ui/hints/` (9 shots kept; all 60 are in `E:/Temp/fxui/...hints-all`). Every hint pill sits at 762–800 css px of 844: 44 px from the bottom, i.e. 28 px above the 16 px safe bottom. Gates, zombies and the count label (y ≈ 590) are clear in 04, 09, 12 and 13.
- **Boss hint** (`fix-ui/probe-hint.json`, L5, copied `probe.mjs` + `m_hint.js`).
  - "SHOOT THE BOSS" appears only after the intro (phase `boss`), at 762–800.
  - The name card is at 252–337 and the boss bar at 122–140, so neither is touched.
- **Landscape** (`fix-ui/probe-landscape/04-hud-land.png`). The pill slid left off the count label and the squad.
- **Reduced motion** (`fix-ui/pausetheatre.json` → `reduced`): `handAnims 0`, `hintAnims 0`, ripple `display: none`.
- **Docs.** GDD §14 HUD row amended: bottom-anchored pill at safe-bottom + 28 (round-2 QA UI-18), and non-interactive hints are exempt from the thumb-zone rule.

## UI-19 (major): first show of the results screen, boss chrome and menus stalls. **Fixed**

**What changed**
- **Prewarm.** New `ui.prewarm(): Promise` (ui.js:1096).
  - It applies pending `<html>` classes (so `html.blur` backdrop blur is warmed too), builds icons, results bitmaps and sample content (`_prewarmFill`), and builds the level grid and shop card icons.
  - It adds `.prewarm` to complete, gameover, levels, shop, settings, pause, endless, `#hud`, `#bossbar`, `#namecard`, the letterboxes, `#hint`, `#shield` and pill 0 for 3 rAFs, with a 500 ms fallback.
  - CSS `.prewarm` (css:2060) displays these despite `[hidden]` (by specificity), at opacity 0.01, `visibility: visible` and `pointer-events: none`. `hidden` attributes are never touched.
- **Boot hold.** `hideBoot()` (ui.js:1076) runs the prewarm itself and holds `#scr-boot` until it ends if main did not await it (`_bootHold` is respected in `showScreen` and `update`). The fix therefore works today, and CORE-9 can await it.
- **Cheap paint.**
  - **Sunburst.** Rays are drawn once into a 512² canvas → `toBlob` → `--rays` on a `will-change: transform` layer. The masked conic gradient is gone (`_buildRays`/`_bitmapVar` :1196/:1240, css:1740).
  - **Title.** `#complete-title` is one text-shadow stack with no filters (css:1760).
  - **Stars.** Bisection showed the clip-path stars were the remaining 75–100 ms GPU flush. They are now canvas-drawn PNG bitmaps (`--star-empty` / `--star-on`) with an SVG fallback; the glow is a radial gradient (css:1778).
  - **Letterbox.** Shadow blur cut to 8 px.
  - **Current level tile.** The box-shadow pulse became an opacity animation on `::after`.
- **Skull and grid.** The level skull is CSS-drawn (css:1298). `SKULL_GLYPH` is removed. The grid is built once and updated in place (UI-24).

**Verification**

| Check | Before | After |
|---|---|---|
| Real L1 boss-death → results flow, first-show raster (`fix-ui/lib/resflow.mjs`, trace) | 255 ms GPU flush (round 1); this build without prewarm: 129–143 ms | DoEndRaster 20.8–28.2 ms in 3 runs; frames ≤ 42 ms, which is noise level |
| `trace.mjs … trace-boss 1 - boss` (`fix-ui/trace-boss/summary.json`) | 63 ms | no rAF interval > 45 ms |
| `trace.mjs … trace-results 1 - results` | — | Taken before the star fix (90 ms). The later resflow traces supersede it. |
| t11 first opens (`fix-ui/t11-*`): LEVELS / SHOP / SETTINGS | 146–305 / 69–111 / 83–118 ms | 13.8–27.7 / 13.7–13.9 / 20.9–34.8 ms |

- **4× throttle** (`fix-ui/m4-l1-med/perf.json`; resflow `--rate 4`).
  - After 'complete' the worst frames are 97–139 ms.
  - The trace attributes the long one, about 1 s after the results appear, to a 115 ms `FireIdleCallback → run`. That is level.js's LVL-18 idle prefetch of the next level, not UI. See needsOtherGroup.
  - The results show itself takes 56–63 ms at 4×. Before, it was 285 ms.

## UI-20 (major): a double-tap on RESET SAVE wipes the save. **Fixed**

- **Code.** `confirmReset` (ui.js:1489) records the arm time with `performance.now()`. Confirming taps within `JUICE.ui.confirmMinS` (0.6, new) are ignored. Leaving Settings disarms; this was already true via `showScreen`.
- **Verification** (`fix-ui/t21-reset-doubletap.mjs`):

| Input | Reloaded | Save after |
|---|---|---|
| Touch double-tap, 80 ms | no | 4321 coins, hu 14, 1 level |
| Mouse double-click | no | 4321 coins, hu 14, 1 level |
| Second tap 1 s after the first | yes | 0 coins, hu 1 |

## UI-21 (minor): forced layout inside the rAF. **Fixed for UI; level-start frame partly outside UI**

**What changed**
- **Fade.** `_enterFade` (class toggle + `offsetWidth`) is deleted. Every screen and `#hud` carries `.enter` permanently. A CSS animation replays by itself on `display:none` → shown, so no reflow is needed. It also no longer re-fades a screen that was already visible behind Settings.
- **Focus** moves in a read-first phase at the start of the next `update()`.
- **Level grid.** The scroll-to-current read is deferred to that same read-first phase (`_scrollLevels`).
- **Hint** size comes from the RO.
- **Shield.** The pill is now measured by the RO: invisible for one frame until sized, with no `offsetWidth` read after the text write.
- **Prewarm.** `#hud` is part of the UI-19 prewarm.

**Verification**
- **Level-start trace** (`E:/Temp/fxui/trace-start`, analyzed with `fix-ui/lib/forcedlayout.cjs`): the worst forced layout or style inside any rAF callback is **0.2 ms** (target < 5 ms).
- **spikes `--rate 4`** (`fix-ui/spikes-r4/spikes.json`): L1 start worst frame 78.4 ms. It was 110.8 ms, of which `_enterFade` 62 + `_placeHint` 11 + gBCR 8 were UI.
  - The CPU profile now puts about 12 ms inclusive of the window in `ui.update`.
  - The rest is render (45 ms) and level (17 ms). So the < 60 ms target is not met, but the remainder is outside the ui group.

## UI-22 (minor): HUD animations force style recalculation, layout and paint every frame. **Fixed (0.79 → 0.31 ms/frame)**

**What changed**
- **Progress fill.** A full-width strip inside a new `#progress-clip` (created by ui) that slides with `translateX(f−100 %)`.
- **Marker.** Full-bar-width element, `translateX(f %)`. Its outline and shadow are an SVG data-URI background instead of 5 `drop-shadow` filters.
- **Boss fill.** Same translate approach.
- **Strings.** All transforms come from tables built once.
- **Transitions.** Removed: a 110 ms transition re-triggered every 100 ms ran style recalc every frame.
- **Stripes.** Made static. A running CSS animation recalculated style every frame whether on `::after` or on a real element; measured both ways.
- **Other animations.** The skull glow keyframes became a static glow, and the phase-3 boss-name `text-shadow` animation became an opacity animation.
- **Containment.** `contain: layout` on the HUD blocks (css:575).

**Verification** (`fix-ui/dom/perf.json`, `throttle.mjs --rate 1 --level 9 --quality med --seconds 40 --traceAt 15 --traceFor 20 --inv`):

| Metric | Before (dom-a) | After |
|---|---|---|
| `domCpuPerFrame` | 0.79 | 0.314 |
| Layout count | 1998 | 143, over 2776 frames |
| Paint count | 7922 | 275 |
| UpdateLayoutTree count | 2744 | 773 |

- The remaining 0.21 ms/frame is commit, prepaint and layerize, which the WebGL canvas forces every frame, plus fx's DOM coin sprites (fx.js:569, about 57/s). The 0.3 target is effectively met.

## UI-23 (minor): first pickup of each power-up encodes its icon. **Fixed**

- **Code.** `_prewarmIcons` (ui.js:1183) encodes every `RENDER.icons.ofItem` id at `PILL_ICON_PX` during the boot prewarm.
- **Verification.** spikes `--rate 4`: weapon-shotgun worst 30.5 ms (< 33). A grep of all 6 CPU profiles finds 0 `toDataURL` and 0 `iconDataURL` frames.

## UI-24 (minor): an unbounded highestUnlocked hangs LEVELS. **Fixed**

**What changed**
- **save.js:180** `sanitize` clamps `highestUnlocked` to [1, min(MAX_LEVEL_KEY, largest cleared key + 1)]. A level counts as cleared at stars ≥ 1 or clears ≥ 1.
- **ui.** The grid is built once (`_buildLevelGrid` :2334): 1..LEVELS.count, the ENDLESS tile, and a pool of 30. `_fillLevels`/`_setTile` (:2302/:2368) update classes and text in place. Past LEVELS.count only the 30 levels ending at highestUnlocked are shown.

**Verification**
- **t9** (`fix-ui/t9-levels-*`): hu2e6 / hu30 / hu1 → LEVELS opens with a worst frame of 27.7 / 20.8 / 20.7 ms, no fatal box, and hu sanitized to 1.
- **t8 loop:** hu 9999 builds in 1 ms, with 61 tiles and 737 DOM nodes.
- **t8 corrupt:** huge-unlock reloads as hu 1, and every case boots to the title.

## UI-25 (minor): hints overwrite each other. **Fixed (lands with LVL-24, already in level.js)**

**What changed**
- `showHint` (ui.js:1414) queues: at most `JUICE.ui.hintQueueMax` (2, new), de-duplicated by id, oldest dropped when full.
- `_nextHint` (:1911) drops entries older than 6 s of theatre time and skips an already-acted steer hint.
- Each hint shows for 2.5 s in turn. `save.markHint(id)` is called on display.
- The queue is cleared on `level:start`, on any state other than playing or paused (quit, results), and on `hideHint()`.
- ARCH §10.3 `#hint` row is documented.

**Verification** (`fix-ui/hintprobe/` = camp2 `--hintprobe` L1).
- In order, each visible 2.42–2.5 s at 100 ms sampling: DRAG TO STEER → SHOOT THE GATE! → MORE SOLDIERS! → ZOMBIES BITE! → GRAB THE CRATE → ×3 … → RED … → SHOOT THE BOSS.
- Final save hints: all 8 marked.

## UI-26 (minor): landscape boss bar covers the boss. **Fixed**

- **Code.** Landscape block (css ~2140+): `#bossbar` moves to the top row, right of the shifted progress (top ≈ safe-top + 4 + name), width ≤ 280·u, with a smaller name and track. `#hud.boss-on #progress` slides left beside pause, and boss-on power-ups stack down the left edge.
- **Verification** (`fix-ui/mobile/bossframe/*/bossframe.json`):

| Run | Bar | Head | Clear by ≥ 8 px |
|---|---|---|---|
| landscape L5 | track bottom 51 (was 121) | 82 | yes |
| landscape L10 | 51 | 80 | yes |
| portrait iphone14 | 122–140, unchanged | 222 | yes |

- Screenshot: `fix-ui/shots/landscape-boss.png`.

## UI-27 (minor): text below 12 px. **Fixed**

- **Code.** `--fs-small: max(12.5px, …)`, `--fs-micro: max(12px, …)`, and a new `--fs-readout: max(12px, 13px·ui)` for `.card-effect` and `.tile-stars` (css:122). `#version` uses `.micro`, so it is ≥ 12. GDD §14 now states a 12 px floor.
- **Verification** (`fix-ui/mobile/layout/{android360,landscape}/layout.json`): `tiny` lists only `#btn-pause` and the `i.on` star glyphs on every screen.

## UI-28 (minor): pausing burns the theatre timers. **Fixed**

- **Code.** `_tclock` advances only while `state.current !== 'paused'` (`update`, ui.js:1736). It drives the name card, hint, boss-bar-out and hint-queue deadlines. Flashes, vignette, coin tweens and the reset confirm stay on `_clock`.
- **Verification** (`fix-ui/pausetheatre.json`):
  - The name card is shown 0.4 s, then 3 s of pause; it is still visible 0.3 s after RESUME and gone at +1.5 s.
  - A hint survives a 3 s pause and the next queued hint follows.
- I did not use the visboss copy: it hides the tab rather than pausing.

## UI-29 (minor): boot shows 0 % for half the boot. **Fixed in my files; captions need CORE-9**

**What changed**
- **Preloads.** `index.html` declares `modulepreload` for all 22 `js/*.js` and the 12 three.js CDN modules.
- **Creep.** The BOOTGUARD inline script creeps the bar 0 → 4 % while `#boot-fill.creep` is set; `setBootProgress` removes the class on its first call.
- **Captions.** New `ui.setBootCaption(i)` (:1059). `STRINGS.boot.steps` has 6 entries: page, textures, models, audio, systems, shaders. Until main calls `setBootCaption`, captions follow main's real step boundaries (`BOOT_STEP_AT` = PROGRESS renderFrom/renderTo/models/audio/systemsTo) instead of evenly split fractions.

**Verification** (`fix-ui/bootnet/bootnet.json`; the copy's MutationObserver is attached at document creation so it can see the inline creep)
- The bar moves 1.1–2.1 s before ui's first write.
- Absolute times on this overloaded host are 2.4–5 s, and even unthrottled the localhost HTML responseEnd was 5.2 s. So the ≤ 0.5 s target cannot be judged here; the creep fires about 90 ms after the HTML and CSS arrive (`fix-ui/lib/navtime.mjs`).
- The preload versus no-preload A/B was inconclusive under this noise. QA measured −430 ms on a quiet host.
- `dom/perf.json` `painted` shows the captions following the real steps.

## UI-30 (polish): reward chips wrap 3 + 1. **Fixed**

- **Code.** `#complete-breakdown` is a 2-column grid; an odd last chip centres across both columns, and landscape uses one row. `bd-boss` uses `--coin` gold.
- **Verification.** `fix-ui/results/10-result.png` shows Kills / Gates over Boss (gold) / Bonus in a clean 2 × 2.

## UI-31 (polish): landscape LEVELS shows no scroll cue. **Fixed**

- **Code.** Landscape block: 8 columns with `grid-auto-flow: row dense`, a compact h1 and padding.
- **Verification** (`fix-ui/shots/levels-landscape.png`, `fix-ui/mobile/lvshot.mjs`):
  - Rows sit at y 56, 131, 206 (ENDLESS) and 281, inside a grid bottom of 311.
  - So ENDLESS is in the first screenful, and row 17–24 is half visible under the fade (clientHeight 266, scrollHeight 394).

## UI-32 (polish): Haptics toggle shown on iOS. **Fixed**

- **Code.** `_hideUnsupported` (ui.js:856) sets `row.hidden = true` when `!util.hasHaptics`; the saved value is untouched.
- **Verification** (`fix-ui/novibrate.json`, `shots/settings-novibrate.png`):
  - With `vibrate` deleted: row hidden, `display: none`, `savedHaptics` still true.
  - With `vibrate` present: the row is shown.

## UI-33 (polish): menu polish. **Fixed**

- **Coin multiplier icon.** Now a gold coin with a "×2" badge (ui.js:279).
- **One "on" colour.** Toggle `:checked`, slider fill, thumb and moz-progress use `--secondary`, matching the segmented control.
- **RESET SAVE.** A text-style danger button 24·u below BACK (DOM order swapped in index.html). Armed, it becomes an outlined danger pill. In landscape, BACK and RESET share the last row.
- **Level label.** `STRINGS.hud.level` → `LEVEL ${n}`; it fits at 390 (HUD screenshots). GDD §14 "LVL 7" → "LEVEL 7".
- **Verification.** `fix-ui/menus-report.json` (smoke ui, CLEAN) and `shots/menus-04-settings.png` / `menus-02-shop.png`.

## UI-34 (polish): debug overlay clips rows. **Fixed**

- **Code.** `#debug` has `white-space: pre-wrap` and `overflow-wrap: anywhere`. On phones it is full-width (inside the safe area) with max-height 8 lines.
- **Verification.** `fix-ui/hints/04-play-4s.png` shows the full rows, including tris, scale, particles and target.

---

## Public API additions (ARCH §6.14 is not mine; please add)
- `ui.prewarm(): Promise<void>`: lays out and paints first-use surfaces behind `#scr-boot`; idempotent.
- `ui.setBootCaption(index: number)`: caption of the running boot step (`STRINGS.boot.steps`).
- `hideBoot()` behaviour: it waits for the prewarm (and runs it if not started) before the boot screen hides.

## needsOtherGroup
1. **core (main.js, CORE-9).**
   - Call `await ctx.ui.prewarm()` right after `warmRender` (step 9b) and before `ctx.ui.hideBoot()` (step 10). Today `hideBoot` runs it itself and holds the boot screen for about 3 frames, so this only moves the work behind the bar.
   - Call `ctx.ui.setBootCaption(i)` at each step: 0 before step 4/5 page; 1 at render.init (textures); 2 models; 3 audio; 4 engine + systems; 5 `warmRender`. Guard with `typeof ui.setBootCaption === 'function'`.
2. **architecture doc owner (ARCH §6.14 / §4.1).** Document `ui.prewarm()`, `ui.setBootCaption()` and boot step 9c "await ui.prewarm()". §10.2 should note the new CSS vars `--hint-bottom`, `--hint-maxw`, `--hint-alpha` and the 12 px type floor.
3. **level (level.js LVL-18 idle prefetch).** On the results screen at 4× CPU, the `requestIdleCallback` prefetch `run` takes 115 ms in one task, about 1 s after results appear. That gives the 97–139 ms frame after 'complete' in `m4-l1-med`. Please split the generation into chunks, or check `deadline.timeRemaining()` and yield.
4. **QA / tools (tools/build-artifact.js and artifact.html).**
   - Rebuild `artifact.html`: its APP / BOOTGUARD blocks are stale (no `class="creep"` on `#boot-fill`, no creep script, RESET SAVE still before BACK).
   - If the artifact shell should get module preloads, `build-artifact.js` must copy the `<link rel="modulepreload">` tags; the CDN ones also apply there.
5. **render / level (L1 start frame at 4×).** After the UI fixes, the L1 start frame is 78 ms at 4× (target < 60). About 45 ms is `render.draw` on the new level's first frame and about 17 ms is `level.step` / `_fireEvent`; UI is about 12 ms inclusive.
6. **fx (fx.js:569 DOM coin sprites).** These are the largest remaining per-frame DOM invalidation source (about 57 style recalcs/s). Optional: move them to transforms on promoted layers with no class or style churn.
