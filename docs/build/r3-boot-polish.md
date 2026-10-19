# Round 3: boot smoothness and UI polish

**Owner files:** `js/main.js`, `js/engine.js`, `js/render.js`, `js/ui.js`, `css/game.css`, `index.html`.

**Also touched:**
- My `STRINGS` keys in `js/data.js` (targeted edits, re-read before each one; another owner edited data.js in between and my keys are intact).
- `artifact.html`, regenerated from `index.html` by `node tools/build-artifact.js`. Only my index changes differ.
- `docs/ARCHITECTURE.md` §3, §4.1, §6.3, §6.14, §10.1 and §10.3.
- `docs/GDD.md` §14.

**Evidence root:** `E:/Temp/claude/gate-rush-evidence/r3/boot-polish/`, written `EV/` below.
- `EV/src-before/` holds the pre-change copies of my files. Every A/B below serves those copies through a request override, interleaved with the shipped files in the same session (`EV/tools/ab.sh`, `EV/tools/encab.sh`).
- `EV/v1-prof-a/` is the trace of my first iteration. Two of the stalls below only showed once the bigger ones were gone.
- `EV/tools/` holds my scratch tools: `bootprof.mjs`, `barshare.mjs`, `encounter.mjs`, `framesplit.mjs`, `gpuwin.mjs`, `screens.mjs`, `probe.mjs`, `bootshots.mjs`, `bootdiag.mjs`, `fontprobe.mjs`, `playab.mjs`, `timeline.mjs`, `lib.mjs`, the `ab.sh` / `encab.sh` / `matrix*.sh` / `rerun3.sh` runners, and `throttle.mjs` (a copy of the QA tool).

## Summary

All acceptance numbers come from interleaved OLD/NEW runs at 4× CPU (390 × 844 @ 2.75, Medium) on a quiet host.

| Item | Before | After |
|---|---|---|
| Painted boot gaps > 300 ms | 2–3 per boot: 584–604 ms at 97 %, 542–563 ms at 94 %, up to 326 ms at 30 %; 257–299 ms at 40 % (306–326 ms in the traced baselines) | **0** in all 6 runs plus the QA tool's run. Worst gap 222–299 ms: the boss rigs' init in boss.js (needsOtherGroup 1) |
| Same, unthrottled | 2 per boot (570–618 ms, 340–361 ms) | 0 in 2 runs, worst 146–153 ms. A third ran on a saturated host (everything 2.5× slower) and had 4 gaps of 347–801 ms |
| Bar honesty (share of boot time against share of bar) | the last 5 % of the bar took 24–31 % of the time; the warm-up took 24–32 % of the time for 45 % of the bar | every range within 2 points of its time share (table in §a.3) |
| Boot span, first bar to title (4× / 1×) | 3.9–5.2 s / 1.8–2.4 s | 4.06–4.08 s / 2.29–2.34 s |
| Results screen | show frame 34.8 ms; a 69.4 ms frame 0.33 s later | show frame 34.7–34.8 ms. The 62.5 ms frame 0.30–0.43 s later is still there: level.js's idle prefetch (needsOtherGroup 2) |
| Boss arrival frame | 48.5–48.6 ms (39 ms JS) | 48.6 ms, unchanged. My modules hold 11–13 ms of it at their normal per-frame cost; the rest is level, audio and boss (needsOtherGroup 3–4) |
| Level naming | title "Level 7"; game over showed no level | "LEVEL 7" everywhere, from one template; game over shows "LEVEL N" |
| `ctx.debug` | 5 fields added lazily by weapons and level | every field declared in `Engine.init` |
| Visual polish | 6 issues at 390 / 360 / 844 | fixed (§c) |

**Host caveat.** Other owners ran batch tests during this round. At times the CPU was at 100 % with up to 80 Chrome processes.
- In those windows everything slows down 2–3×. For example, AudioContext creation took 0.4–2.4 s, against 0.15 s on a quiet host.
- The acceptance numbers come from quiet windows (CPU 20–45 %, under 30 Chrome processes). The loaded runs are listed separately in §a.3 so the variance is visible.

## (a) Boot under 4× CPU throttling

### a.1 Where the frozen frames came from

**Tools.** `EV/tools/bootprof.mjs` uses the QA tool's gap rule (rAF gaps > 100 ms while `#scr-boot` is up) and adds:
- a trace with CPU samples, giving each long task's top JS frames and its rendering and GPU events;
- `--wrap`, which times each system's init through prototype wrappers without touching the sources.

**Baseline evidence:** `EV/base-boot4-a` (QA tool copy), `EV/base-prof-a` and `EV/base-prof-b` (traced), `EV/base-steps-a` (wrapped).

| Gap (4×) | What ran in it | Root cause |
|---|---|---|
| 584–604 ms at 97 % (667 ms traced) | a 269 ms rAF task: the prewarm's end, then `hideBoot` and `level.quitToTitle()`. Between "bar 99 %" and "boot hidden" the GPU process ran 588 ms of raster (83 `DoEndRasterCHROMIUM`) for the prewarmed surfaces | `ui.prewarm()` displayed all ten first-use surfaces in one frame, and the title setup ran in the same frozen stretch |
| 542–563 ms at 94 % (655 ms traced) | one rAF task: the warm-up's last `draw()`, the synchronous part of `ui.prewarm()` (259 ms wrapped: 3 bitmaps, 15 icon encodes, 5 card icons, level grid, sample content), then style, layout and paint of every surface (≈ 430 ms of those events) | the `await` continuation after the warm-up's rAF callback ran the prewarm inside the same rAF task |
| 285–326 ms at 30 % | `ModelLibrary.init` (144 ms) and `AudioSystem.init` (144 ms) | no yield between steps 6 and 7 |
| 257–299 ms at 40 % | squad (28 ms), zombies (9 ms) and `BossSystem.init` (266 ms) | the 40 ms slice threshold was checked after each init, so the cheap inits let the boss init join their frame |
| ≈ 300 ms at 72 % (`base-prof-a`) | one warm-up poll tick: 8 × `getUniforms()` (self time in three's `onFirstUse` and `WebGLUniforms`) | each first `getUniforms()` is a synchronous GPU round trip, plus 3 info-log reads under `?debug=1` |
| 271 ms at 64 % (`v1-prof-a`) | a 226 ms GPU raster task that ended by storing 2 new Skia shaders (`GrShaderCache::store`). The renderer's next `GetProgramiv` waited 235 ms behind it (`WaitForCmd`) | `#boot-fill` animated **width**, so every bar step re-laid out and re-rastered the bar on the GPU thread the warm-up's compiles use |
| 208–222 ms at 4–22 % | context creation + road + atlas in one task; materials, passes, `applyQuality`, `Environment.build` (124 ms) and resize in another | `TextureFactory.build` yielded with `setTimeout(0)`, which does not guarantee a paint, and `render.init` had no yields after the textures |

### a.2 Changes

**`js/ui.js`**

1. **Frame-by-frame prewarm.** `prewarm(onProgress)` (ui.js:1132) runs `_prewarmSteps()` (ui.js:1209) one animation frame at a time. Each frame waits for rAF, with a 100 ms timeout fallback.
   - JS-only steps share a frame up to 12 ms (`PREWARM_BUDGET_MS`, ui.js:114).
   - A step that shows a surface ends its frame.
   - Each surface stays displayed for 3 frames (ui.js:115) and then loses `.prewarm`.
   - A node shown again by a later step keeps `.prewarm` until its last entry retires (ui.js:1165–1173).
   - The steps run in this order:
     1. the three result bitmaps, the icons, and the 15 item icons;
     2. the results screen, including the J17 star slam (ui.js:1229);
     3. game over, endless results and levels;
     4. the 5 shop card icons, then shop, settings and pause;
     5. the title (new, ui.js:1239);
     6. the HUD as **two** surfaces (ui.js:1246).
   - Progress is weighted by cost: a surface weighs 8 JS steps (ui.js:118).
   - A probe after boot (`EV/probe-prewarm-final/out.json`) finds no `.prewarm` left and no sample content in the HUD.
2. **Result bitmaps.**
   - `_buildResultBitmap(k)` (ui.js:1299) builds one bitmap per call.
   - `_bitmapVar` now uses a CPU-backed canvas (`willReadFrequently`, ui.js:1351 / 119).
   - The reason: a 512 px canvas is GPU-accelerated by default, and its `toBlob` started with a synchronous GPU read-back (36 ms and 29 ms `WaitForCmd` in the baseline trace).
3. **Card icons.** `_drawCardIcon(id)` (ui.js:2546) draws one card icon per call, so the prewarm encodes them one per step.
4. **Boot bar.**
   - `setBootProgress` (ui.js:1061) writes `transform: translateX(f − 100 %)` from the existing `_txFill` table (ui.js:1070) instead of `width`.
   - It also writes `aria-valuenow` on `#boot-bar` (ui.js:1076).
   - `_bootProgress` is now created as a Double (§14 rule 11, ui.js:368).

**`css/game.css` and `index.html`**

5. **Boot fill.**
   - `#boot-fill` (css:1116) is a full-width strip sliding inside the bar's rounded clip: a compositor-only transform transition plus `will-change`, the UI-22 HUD technique.
   - `width: 100% !important` guards against a stale shell's inline width.
   - index.html:61: `#boot-bar` is now a labelled `role=progressbar`.
   - index.html:108: the BOOTGUARD creep writes the same transform.

**`js/main.js`**

6. **Yields between steps.**
   - Yield between models and audio (main.js:370–371).
   - Step 9 yields before an init once the slice has run ≥ 16 ms (main.js:57), and always before an init measured at ≥ 100 ms (`SYSTEMS_ALONE_MS`, main.js:59 / 396).
   - Yield after the warm-up (main.js:411–412).
   - The first scene (`quitToTitle` / `start` / `startEndless`) runs **under the boot screen, in a task of its own**. A painted full bar follows, then `hideBoot` and `engine.start` (main.js:416–430).
7. **Honest bar.**
   - `PROGRESS` is re-weighted from the measured shares (main.js:38).
   - Each system advances the bar by its measured init cost (`SYSTEMS`, main.js:63).
   - The prewarm reports through `onProgress` (main.js:273–281).
   - A 7th caption, "Polishing the medals…", names the prewarm step (`STEP.ui`, main.js:44; data.js:1447).
   - The prewarm cap is now 5 s (main.js:53). ui holds the boot screen until the prewarm ends regardless.

**`js/render.js`**

8. **`yieldPaint()`** (render.js:457) resolves after rAF and then a macrotask, with a 100 ms fallback. `init()` now paints:
   - after the context and scene setup (render.js:1211);
   - after the textures (render.js:1216);
   - after materials, passes and applyQuality (render.js:1228);
   - after `Environment.build` (render.js:1234).

   `TextureFactory.build` paints between its steps once they have run > 16 ms since the last paint (render.js:534–540).
9. **Link poll.** The poll in `_compileChunked` is bounded by the tier's `budgetMs`, with at least one program per tick (render.js:1759–1763). This also paces the in-play VIS-1 tier pre-compile (6 ms).

**Not changed, by choice**
- **`renderer.compileAsync`.** The boot compile is already `_compileChunked`: per-object `compile()` plus `isReady()` polling under `KHR_parallel_shader_compile`. That is compileAsync's own mechanism, chunked.
- **`Environment.build`** costs 124 ms at 4× in environment.js and is now alone in its frame. Splitting it further needs its owner.
- **An intermittent 0.8–1.3 s atlas-step stall** at 9.4 % appeared in 2 of about 20 runs, on a loaded host, in old and new code alike.
  - The symbol glyphs ★ / ⚡ use the system-font fallback.
  - `EV/tools/fontprobe.mjs` measures that first use at only 7–50 ms in a fresh browser.
  - So I did not change glyph rendering, which other groups own visually.

### a.3 Results

**Quiet-host interleaved A/B:** `EV/tools/ab.sh 4 3 ab4-final` and `ab.sh 1 3 ab1-final`, on the final code.

| Run | Gaps > 300 ms | Worst gaps (bar %) | Span first bar → title | Title worst frame |
|---|---|---|---|---|
| OLD 4× #1 | 3 | 597 (97), 542 (94.3), 326 (30), 299 (40.2) | 5 221 ms | 34.6 ms |
| **NEW 4× #1** | **0** | 229 (34.1, boss rigs), 181 (4), 181 (22), 174 (93.4, prewarm) | 4 060 ms | 27.8 ms |
| OLD 4× #2 | 2 | 604 (97), 563 (93.6), 285 (30), 257 (40.2) | 3 967 ms | 27.9 ms |
| **NEW 4× #2** | **0** | 271 (34.1, boss rigs), 236 (93.4, prewarm), 167 (0) | 4 083 ms | 41.6 ms |
| OLD 4× #3 | 2 | 584 (97), 542 (94.3), 299 (30), 271 (40.2) | 3 886 ms | 34.8 ms |
| **NEW 4× #3** | **0** | 236 (33.9, boss rigs), 236 (93.4, prewarm), 188 (8) | 4 077 ms | 20.9 ms |
| OLD 1× ×3 | 2 / 2 / 2 | 570–618 (97–100), 340–361 (94.3) | 1 808–2 440 ms | 13.9–20.9 ms |
| NEW 1× ×3 | 0 / 0, plus one saturated run with 4 | 146–153 (2 runs). Saturated run: 801 (AudioContext), 396, 375, 347 (70, prewarm) | 2 288–2 336 ms (saturated: 5 785 ms) | 7.2 ms |

**Other runs on the final code:**
- `EV/v5-boot4-{1,2,3}` (host at ≈ 43 % CPU): 0 / 0 / 0 gaps over 300 ms at 4×. Worst 222–299 ms, the boss rigs.
- **QA tool.** My copy of the QA throttle tool reads the bar from the transform; nothing else changed. Command: `node EV/tools/throttle.mjs --rate 4 --level 1 --quality med --seconds 100 --prio --out EV/throttle4-l1-med-r3`.
  - Boot gaps 229 ms (34.1 %, boss rigs) and 208 ms (93.4 %). None over 300 ms.
  - Title frames: worst 27.8 ms, none over 50 ms.

**Loaded host, same A/B** (`EV/ab4q`, `EV/ab4`, `EV/ab1-loaded`):
- `ab4q` (60–100 % CPU, before the HUD split): NEW had 0 / 1 / 1 / 2 gaps over 300 ms. They were:
  - 313 and 306 ms in `BossSystem.init`;
  - 417 ms in `AudioSystem.init`;
  - one 306 ms prewarm frame that showed the whole HUD. That frame is why the HUD is now two surfaces.

  OLD had 2 / 4 / 4 / 4 gaps, of 313–854 ms.
- `ab4`: three of the six NEW runs, and none of the OLD runs, landed in saturation windows: spans of 9.6–14 s, AudioContext 1.3–2.4 s, and 7–11 gaps spread over every step. The other three NEW runs had 0 gaps; OLD had 3–5 per boot (306–882 ms).
- `ab1-loaded` (1×): NEW 0 / 0 / 0, OLD 5 / 2 / 2.

**Bar honesty at 4×.** This table gives the share of the boot span (first bar to boot hidden) spent in each bar range. It comes from `node EV/tools/barshare.mjs` over `EV/ab4-final/*` and `EV/v5-boot4-*`.

| Step | NEW bar share | NEW time share | OLD bar share → time share |
|---|---|---|---|
| render.init, with its first paint | 18 % (4–22) | 16.5–18.0 % | 26 % → 17 % (35 % in the run with the atlas stall) |
| models | 3.5 % | 3.5–4.4 % | 6 % → 6.2–7.8 % for models + audio (no paint between them) |
| audio | 3.5 % | 3.2–3.9 % | 1 % → (above) |
| engine | 1 % | 0.4–0.7 % | 2 % → 0.6–0.7 % |
| systems | 12 % | 11.5–13.3 % | 11 % → 10.6–13.2 % |
| shader warm-up | 28 % | 29.4–29.7 % (31.7–35.8 % in the loaded v5 runs) | 45 % → 23.7–31.9 % |
| UI prewarm | 26 % | 25.2–27.5 % | 4 % → 11.4–15.6 % |
| first scene | 4 % | 3.6–5.7 % | 1 % → 3.9–4.7 % |
| after the bar is full | | 0.6–1.5 % | 8.5–11.3 % (hideBoot + title setup) |

**Boot screen screenshots:** `EV/bootshots/` shows the boot screen mid-boot at the three viewports, CPU-throttled so the bar is caught moving. The fill strip has its rounded front, stripes and glow.

### a.4 Results screen and boss arrival at 4×

**Tools.**
- `EV/tools/encounter.mjs`: boots unthrottled, throttles to 4×, starts L1 with C = 140, jumps to the run-up (as smoke `--boss` does) and records every rAF interval.
- `EV/tools/encab.sh 2 encab-final`: the OLD / NEW A/B of that encounter.
- `EV/tools/framesplit.mjs`: per-system JS for each long frame, through wrapped prototypes.
- `--trace`: traces the results window (`EV/v2-enc4-res`, `EV/v5-enc4-res`).

**Results screen**
- **The show frame** is 34.7–34.8 ms in all four `encab-final` runs, OLD and NEW alike.
  - With tracing on it is 41.6 ms (`EV/v5-enc4-res`): ≈ 16 ms of JS (level.finish → commit, listeners, `_enterComplete`), 13.8 ms of style recalc, 2.5 ms of layout and 3 ms of paint.
- **The frame QA saw** (62.5 ms) comes 0.30–0.43 s after the results appear (up to 1.0 s in the traced runs), with only 4.6–4.7 ms of engine JS. It is 62.5 ms in both NEW runs; OLD had 69.4 ms and 222 ms (the latter on a loaded host).
  - The trace shows a task outside rAF: `level.js _runPrefetch → levelgen step / buildAttempt / validateLevel`, 66–97 ms at 4×. That is the LVL-18 idle prefetch of the next level.
  - The QA tool shows the same: a 66 ms long task at results + 0.39 s, and a 69.4 ms frame at + 0.46 s with 4.1 ms of JS (`EV/throttle4-l1-med-r3/perf.json`).
- I now also prewarm the J17 star slam (KF_STAR from 3×, ui.js:1229), so the first real reveal is not a first-use raster at 3× scale.
  - That does not remove the prefetch frame, which is level.js's (needsOtherGroup 2).

**Boss arrival**
- 48.5–48.6 ms in all four `encab-final` runs, OLD and NEW alike, with 39 ms of JS in the frame before.
- JS split of the spawn frame (`EV/v2-split4`):

  | Component | JS at 4× |
  |---|---|
  | `level.step` (boss spawn via `_fireBoss`) | 9.0–9.6 ms |
  | `audio.update` (the boss cue layers: `_chain` / `_startLayer` create gain, filter and panner nodes) | 9.2–9.6 ms |
  | `render.draw` (its normal cost for that scene) | 9.4 ms |
  | `boss.render` | 3.7–4.2 ms |
  | `boss.step` | 1.0–1.7 ms |
  | `weapons.step` | 1.6–1.8 ms |
  | `ui.update` (boss bar, letterbox, name card) | 1.4–1.8 ms |
  | `render.update` | 0.6–1.4 ms |
- The same pattern shows on other first-use frames:

  | Frame | Split at 4× |
  |---|---|
  | first shot | audio 11.6 ms, weapons 7.8 ms |
  | first gate pass | audio 15.6 ms, gates 7.1 ms |
  | boss death | audio 17.5–18.1 ms, weapons 5.6–6 ms |
- My modules spend nothing above their normal per-frame cost in these frames, so this goes to the owners (needsOtherGroup 3–4).
- The QA tool's worst play frames on the final code are 76.4 ms at the first gate (55.9 ms JS), 69.4 ms at the boss arrival (54.2 ms JS) and 69.4 ms after the results (the prefetch).

## (b) Level naming and `ctx.debug`

**One spelling (GDD §14 UI-33).** Every visible level label comes from one template, `LEVEL_NAME = n => \`LEVEL ${n}\`` (data.js:1435).

| Where | Before | After | Source |
|---|---|---|---|
| HUD label | `LEVEL 1` | unchanged, now from the shared template | `STRINGS.hud.level` (data.js:1451) |
| Title caption | `Level 7` / `Level 7 · Best ★★☆` | `LEVEL 7` / `LEVEL 7 · Best ★★☆` | `STRINGS.title.caption` (data.js:1449) |
| Results title | `LEVEL 1 CLEAR` | unchanged (`${LEVEL_NAME(n)} CLEAR`) | `STRINGS.complete.title` (data.js:1463) |
| Game over | no level shown | "LEVEL 2" above SQUAD LOST, in the HUD label's type | `STRINGS.gameover.level` (data.js:1468), `#gameover-level` (index.html:87, css:1874), `_fillGameover` (ui.js:2785) |
| Level grid | bare tile numbers under the LEVELS header | unchanged: there is no level word to respell | the accessible names stay "Level N" (`STRINGS.aria.level`). They are spoken, so sentence case is deliberate |

**`ctx.debug` is declared up front** (engine.js:419–429).
- The literal now declares:
  - `shotsPerSec`: −1 until weapons' first 1 s window; the overlay prints "-" (engine.js:1461);
  - `laserBeams`;
  - `levelGenMs`, created from 0.5 so it starts as a Double;
  - `levelGenHits` and `levelGenMisses`.
- **Live check** (`EV/probe-debug`): the keys are `enabled, calls, jsMs, dropped, histograms, shotsPerSec, laserBeams, levelGenMs, levelGenHits, levelGenMisses`, in that order. The overlay reads "shots/s -" on the title and "shots/s 10" in play.
- **Call sites.** I ran a copy of `tools/callsites.js` into `EV/static/CALLSITES.md`. Its member list is the same as before apart from the new `engine.js` declaration of `levelGenMs`. The project's `docs/build/CALLSITES.md` is untouched.
- So the round-2 verification's three "lazily written" `debug.levelGen*` findings now resolve.

## (c) Visual polish

**Method.** `EV/tools/screens.mjs` captured, at 390 × 844, 360 × 740 and 844 × 390 (DPR 2, phone emulation), with a save of 1 234 coins and levels 1–6 cleared:
- title, shop, levels, and settings over the title;
- the HUD with a shotgun pill and 3 armor plates;
- pause, and settings from pause;
- boss intro and boss fight;
- results, mid-theatre and settled;
- game over;
- the endless HUD and endless results;
- the title after quitting.

**Before:** `EV/screens-before-{390,360,844}/`.

**After:** `EV/screens-final-{390x844,360x740,844x390}/`, plus `EV/screens-final-360x740-large/` with Large text on.
- These were taken before the HUD prewarm split, which changes only the boot.
- The final-code smoke screenshots (`EV/smoke/m2-*`, `m3-*`, `m4-*`) show the same HUD and results.

| # | Issue before | Viewports | Fix |
|---|---|---|---|
| 1 | Settings opened from the title: the title's PLAY ring, "Level 7" caption and SHOP / LEVELS buttons showed through the scrim right behind BACK and RESET SAVE | all | `showScreen` puts `.under` on the screen that settings stacks over (ui.js:1398). css hides that screen's children once the overlay has faded in (css:235) |
| 2 | Landscape results: "LEVEL 1 CLEAR" and "RUN OVER" were drawn over the HUD's LEVEL label, progress bar and skull | 844 × 390 | `#hud.results` is set while complete / gameover / endless is up (ui.js:1407; css:235). The HUD keeps only its coin pill, whose count settles there, plus its effects. Portrait results also lose the dimmed, redundant label and bar |
| 3 | Boss intro: the armor shield pill was clamped to the bottom edge, alone in the black letterbox bar (the camera dolly drops the squad's count below the screen) | all | `_labelOnScreen()` (ui.js:2103) gates the shield anchor (ui.js:2151). The pill hides while the projected count label is outside the app box or under a letterbox bar |
| 4 | Landscape pause: the 330 × 380 panel was taller than the 390 px box and covered the HUD's top row | 844 × 390 | a landscape rule (css:2151): RESUME spans the panel, and RESTART / SETTINGS / QUIT share one row of equal columns. The panel is ≈ 215 px tall and clears the HUD |
| 5 | Landscape shop: the 5th card hung alone in the left column | 844 × 390 | the odd last card spans both columns, centred at one column's width (css:2146) |
| 6 | Level label spelled two ways; game over named no level | all | see (b) |

**Checked and left alone**
- Shop, levels, settings, HUD and pause at 390 and 360: spacing, truncation and contrast are fine. With Large text at 360, "SQUAD LOST", "LEVEL 1 CLEAR" and the title caption all fit.
- The PLAY "breathing ring" looks like a dark frame only at its faded end state. That is the intended cta-ring animation.
- Result chips sit 2 × 2 in portrait and in one row in landscape.
- The boss bar and its name share the landscape top row correctly.

## Verification

```
node --check js/*.js tools/*.js sw.js        # 0 failures (EV/static/node-check-final.txt is empty)
node tools/check-imports.js                  # 0 errors, 0 warnings (EV/static/check-imports-final.txt)
node tools/validate-levels.js                # 30 levels, 0 errors, 6 warnings: unchanged (EV/static/validate-levels.txt)
node tools/build-artifact.js --out EV/static/artifact-final.html
                                             # byte-identical to artifact.html; "sw.js PRECACHE covers all 22 files in js/"
copy of tools/callsites.js -> EV/static/CALLSITES.md
                                             # member list unchanged apart from the engine.js levelGenMs declaration
grep console.log / Math.random in my js files   # none
```

**Smoke runs on the final code** (`EV/tools/matrix2.sh m2`, then reruns; output under `EV/smoke/`). They all use `node tools/smoke.js --scenario <s> [--shell artifact | --desktop] --bootTimeout 60 --out …`.

| Run | Verdict | Boot (smoke wall time) | Play frames | Notes |
|---|---|---|---|---|
| m2-boot | CLEAN | 25.2 s | | loaded host. The m4-boot rerun was CLEAN in 9.2 s |
| m2-ui | CLEAN | 12.0 s | | the whole UI walk: shop buy, levels, settings, play, pause, resume, quit |
| m2-all | CLEAN | 12.6 s | 8 707 frames, worst 20.8 ms, none over 50 ms | "LEVEL 1 CLEAR ★ ★ ★", results shown |
| m2-all-artifact | CLEAN | 6.1 s | worst 243 ms: 16 long frames at 12–17 s, with nothing special in play | host spike. The m3 rerun was CLEAN: 8 717 frames, worst 20.8 ms, none over 50 ms |
| m2-all-desktop | CLEAN | 7.2 s | worst 222 ms: 3 long frames at 59.5–60.4 s | m3 rerun: worst 181 ms (2 frames at 23 s). m4 rerun: 8 824 frames, worst 20.9 ms, none over 50 ms. The long frames never repeat at the same moment, so they are environmental |

All runs had 0 page errors, 0 console errors, 0 console warnings and 0 failed requests.

**Earlier runs.** In round `m1`, `--shell sandbox`, L10 `--boss --after setCount(140)` and `--endless --seconds 60` were also CLEAN; the sandbox run showed only the expected "Progress won't be saved" warning.
- Two `m1` desktop runs hit the 30 s default boot timeout while 60–80 other Chrome processes ran.
- Diagnosis: `EV/tools/bootdiag.mjs --desktop` reached the title in 6.8 s, and `bootprof --desktop` gave a 2.8 s span with no gap over 300 ms.
- So the slowness was page and module load under contention.

**Screens:** `EV/screens-final-*`, `EV/bootshots/`, and the smoke screenshots.

**Throttled numbers:** `EV/ab4-final/`, `EV/ab1-final/`, `EV/v5-boot4-*`, `EV/throttle4-l1-med-r3/perf.json`, `EV/encab-final/`, `EV/v2-split4/`, `EV/v5-enc4-res/`.

## needsOtherGroup

1. **boss (`js/boss.js`).** `BossSystem.init` builds every archetype's rigs synchronously (`_buildRigRecord` → `models.buildBossRig`). That costs 226–266 ms at 4× on a quiet host and 296–316 ms when traced or loaded.
   - It is now the boot's longest frozen frame: 222–299 ms, alone in its frame, since main yields before it.
   - Ask, either of:
     - build the rigs per root in steps that main can yield between, e.g. `init()` builds the first root and main calls `prepareRigs(budgetMs)` / `buildNextRig()` once per frame;
     - build the twin and milestone roots lazily during the warm-up.
2. **level (`js/level.js`, the LVL-18 prefetch).** The idle prefetch of the next level always runs at least one levelgen attempt per idle slot.
   - That attempt takes 66–97 ms at 4× and lands 0.3–1.0 s after the results screen appears. It is the "results first frame" over 50 ms that QA reported (62.5 ms).
   - Ask, any of:
     - do not force an attempt unless `deadline.didTimeout`;
     - split `buildAttempt` / `validateLevel` across idle slots;
     - start the prefetch after the results theatre (stars plus count-up, ≈ 1.75 s).
3. **audio (`js/audio.js`).** First-use cue starts create node chains (`_chain` / `_startLayer` → createGain / createBiquadFilter / createStereoPanner / createOscillator). These are the largest single shares of those spike frames at 4×:

   | Frame | `audio.update` at 4× |
   |---|---|
   | first shot | 11.6 ms |
   | first gate pass | 15.6 ms |
   | boss spawn | 9.2–9.6 ms |
   | boss death | 17.5–18.1 ms |

   - Ask: pre-build or pool the layered voices (boss roar, fanfare, gate pass) at init, or spread the layer starts over 2–3 frames.
   - Also: the AudioContext constructor (AUD-8, boot step 7) takes 144 ms at 4× on a quiet host but 0.4–2.4 s on a loaded one.
4. **level / boss (boss spawn frame).** `level.step` → `_fireBoss` → spawn costs 9–9.6 ms at 4×, and `boss.render` adds 3.7–4.2 ms, in the boss-arrival frame (48.6 ms in total). Any warm-up or deferral of the spawn work, such as showing the pre-posed rig or re-attaching plates, helps.
5. **QA tooling.** `E:/Temp/claude/gate-rush-evidence/qa2/perf-throttled/throttle.mjs` and `qa2/verify-tools/throttle.mjs` read `#boot-fill.style.width` for their bar labels (lines 82–84).
   - The fill now moves by transform, so those labels read ''. The gap numbers are unaffected.
   - Read `#boot-bar[aria-valuenow]` instead, or parse `translateX`; `EV/tools/throttle.mjs` lines 84–85 show how.
6. **Lead / integrator.** I regenerated `artifact.html` from my `index.html` (boot-bar markup, BOOTGUARD creep, `#gameover-level`). Nothing else in it changed. `sw.js` needs nothing, since there are no new files.
7. **environment owner (optional).** `Environment.build` (124 ms at 4×) is now alone in its frame. A future, heavier environment should chunk its build.
