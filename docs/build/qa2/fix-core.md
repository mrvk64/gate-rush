# QA round 2 — fixer "core" report

Files edited: `js/engine.js`, `js/main.js`, and targeted keys/sections only in `js/data.js` (`QUALITY_TIERS.scaler`,
`SQUAD.steer.landscapeWidthFactor` (new), `JUICE.ui.resizeDebounceMs` (new)), `docs/GDD.md` (§2 time row, §3.2,
§16 auto-scaler paragraph) and `docs/ARCHITECTURE.md` (§2.2, §6.2). `js/util.js` needed no change.
All verification scripts and outputs are in `docs/build/qa2/fix-core/`.

Checks: `node --check js/engine.js js/main.js js/data.js` OK; `node tools/check-imports.js`: 0 errors, 0 warnings.
`node tools/smoke.js --scenario all --seconds 60 --out docs/build/qa2/fix-core/smoke-all` → verdict CLEAN (no page
errors, console errors, warnings or failed requests). I looked at the screenshots: title, shop, levels, settings, pause
and play all render correctly. The debug overlay now prints `refresh … ms (target 16.67)`.

**Caveat on the machine.** Ten fixers were running Chrome at the same time (≈ 80–90 chrome.exe processes), so the
absolute frame and boot timings are inflated and noisy. Where it mattered I used A/B runs alternated in the same
session (bootcmp), or reruns.

---

## CORE-5 (major): a second finger's tap kills steering — **FIXED**

- **Change.** `js/engine.js:336-338`: `_onLostCapture = (e) => { if (e && e.pointerId === this._pointerId) this._releasePointer(); }`.
  A second finger's implicit-capture `lostpointercapture` (it bubbles from `#gl-canvas` to `#app`) no longer releases
  the steering pointer. pointerup and pointercancel were already filtered by pointerId.
- **Verify** (scripts copied to `fix-core/{lib,secondtap,twofinger}.mjs`, output in `fix-core/touch/`):
  - **secondtap, iphone14.** After finger 1 lifts, pid stays 2 and pointerDown stays true. The final step reaches
    targetX **2.1** (the clamp; the unclamped expectation is 3.31). Before the fix it stayed at 1.323.
  - **secondtap, android360.** Same result: pid 2, targetX **2.1** (was stuck at 1.434).
  - **twofinger** (`touch/twofinger.json`). pid stays 2 through every phase, and the second finger's moves do not
    change targetX (1.323). Before the fix, pid became 4 and targetX went to −0.993, so the second finger took over.

## CORE-6 (major): the auto-scaler chases 90/120 Hz and demotes 60 fps devices — **FIXED**

- **Changes**
  - **Target.** `js/engine.js:1328` adds `get frameTargetMs()` = max(`time.refreshMs`, `QUALITY_TIERS.scaler.targetMinMs`).
    The new key `targetMinMs` = 16.67 is at `js/data.js:844`. The target is used for both the drop test (1.4×) and the
    raise test (1.05×) (`engine.js:1362`).
  - **Refresh measurement** (`engine.js:1262-1325`). `measureRefresh()` runs its own rAF chain that draws nothing:
    - It keeps an interval only when no `renderer.render()` ran in that interval or in the one before it
      (`renderer.info.render.frame` is unchanged; three r170 increments it on every render, including the warm-up and
      composer passes).
    - The interval must also be under `hitchIgnoreMs`. The hitch filter is kept, and is now read from data instead of
      a literal.
    - The median is taken over 90 samples, or over ≥ `refreshMinSamples` (60) samples once `refreshProbeMs` (5 s) has
      passed. It is snapped to {8.33, 11.1, 16.67}. With fewer samples, the previous value stays.
    - The probe starts at `Engine.init()` (boot step 8: the boot screen, before the warm-up). It restarts on
      visibilitychange → visible (`engine.js:885`), after each trailing resize (`_onResizeTrailing`) and on `pause()`.
    - Title and gameplay frames never count. The old title-frame sampling in `_sampleScaler` is removed.
  - **Anti-flap (new, small).** `QUALITY_TIERS.scaler.raiseBackoff` = 2 (`data.js:850`, `engine.js:1379-1383`). Once the
    120 Hz panels are judged against 16.67 ms, the existing 60 Hz behaviour applies everywhere: "Low holds 60 fps,
    Medium does not" would flip low ⇄ med every 15 s. With the back-off, raising back to a tier the scaler already
    dropped from n times needs raiseAfter·2ⁿ s. `setQuality('auto')` clears the counts.
  - **Freeze clock.** `freezeQuality` deadlines and the frozen check now use `time.theatre` (CORE-7), so a pause during
    the boss intro does not use up the freeze (`engine.js:1342, 1557`).
  - **Docs.** GDD §16 auto-scaler paragraph and ARCH §6.2 amended: target, probe, back-off, theatre freeze, and the new
    `measureRefresh()` and `frameTargetMs` in the API block.
- **Verify**
  - **scalersim** (`fix-core/scalersim.mjs`, output in `fix-core/scalersim.out`). It ports the sim to the new rule: the
    probe is fed the panel interval, and the time also sets `time.theatre`.
    - **Original scenarios.** A (120 Hz), B (90 Hz), D (120 Hz Apple) and F (m4-end-adreno as observed): **no change,
      120 s on Med**. Before, each spent 114 s on Low. C (60 Hz) is unchanged, and E (60 Hz dense spike) still drops at
      23.9 s as before.
    - **Added scenarios.**
      - G: 120 Hz with Med at 33 ms. It still drops at 7 s, and the back-off spaces the re-raises out: 28 s, then 84 s.
      - H: Med at 22.5 ms. No demotion.
      - I: Apple ceiling. It raises Med → High at 13 s and keeps High at 60 fps.
      - K: a 4 s freeze. No change.
  - **`throttle.mjs --rate 4 --level 9 --quality auto --seconds 90 --out fix-core/q4-l9-auto`.** tierLog is empty: High
    is kept for the whole run with mean interval 17.06 ms. Before, it went High → Med at 23.9 s and Med → Low at 39 s.
  - **`… --rate 4 --endless --quality auto --gpu "Adreno (TM) 618" --seconds 90`.**
    - **First run** (`fix-core/m4-end-adreno`). Machine contention made JS 31–95 ms/frame (normally 7.8 ms) and the
      mean interval 45 ms (20 fps), so the drop at 5.7 s is the correct behaviour.
    - **Rerun** (`fix-core/m4-end-adreno-2`). Med held while the game ran at 38–57 fps (the 5 s buckets).
    - **Rerun, the drop.** Med → Low happened only at 42.7 s, when the run fell to 29.5 fps (34 ms, above 23.3 ms). JS
      then went to 211 ms per frame, which is contention.
    - **Before the fix.** It dropped at 21.8 s while running at 77–96 fps.
    - **Verdict.** There is no demotion while the mean interval stays ≤ 23 ms.
  - **6× run** (`fix-core/m6-l9-auto`, Adreno spoof, L9). Med → Low at 6.8 s while running at 17 fps, so the scaler
    still works.
  - **Refresh after the fix.** The q4/m4/m6 runs measured refreshMs 16.67 at the start; the headless boot window gives
    too few draw-free samples at 60 Hz, so the default stays. In the t2-boss run the pause probe measured 8.33 on the
    unthrottled 144 fps headless pane (debug overlay, `ec/t2-boss/01-A-after-resume.png`). Either way the target is
    16.67.

## CORE-7 (minor): pausing burns the theatre timers and the slow-mo — **FIXED** (engine part; the owners' switch has landed)

- **Changes**
  - **New clock.** `ctx.time.theatre` (ms) starts at `performance.now()` in `Engine.init` (`engine.js:400-402`).
  - **Advance rule.** `beginFrame` advances it by `unscaledDt·1000` (the clamped real interval) except while
    `state === 'paused'` or the WebGL context is lost (`engine.js:1174-1177`).
  - **Slow-mo.** The `slowmoLeft` countdown also holds under the same condition (`engine.js:1180`).
  - **Docs.** ARCH §2.2 Clocks and Theatre-timers rows, and the GDD §2 time-scale row, document it.
- **Owners.** boss.js, level.js and render.js already read `time.theatre` with a fallback to `time.now` (ENE-17,
  LVL-29, VIS-18).
- **Verify** (copies in `fix-core/ec/t2-boss.mjs` and `fix-core/visboss.mjs`):
  - **Case A** (pause 0.51 s into the 2.4 s intro, 5 s paused). After RESUME the intro continues: still `inIntro`
    1.05 s later, and the boss walks in from z −38.5 to −25.4. Before, the intro was already over at RESUME.
  - **Case B** (pause 0.27 s after boss:dead, 3.6 s paused).
    - **Slow-mo.** It resumes at **0.25** with slowmoLeft 0.92 and runs out about 1 s later.
    - **Results.** They arrive 2.73 s after RESUME; 0.27 + 2.73 = 3.0 s = `BOSSES.death.resultsAfterMs` (3000), which
      is exactly the remaining theatre.
    - **On the triage note.** The "≈ 1.6 s" in the triage assumed an older results delay.
    - **Before the fix.** Results appeared 20–300 ms after RESUME.
  - **Case F** (tab hidden 5 s during the death). It stays paused with slowmoLeft held. After RESUME, slow-mo is 0.25
    and phase is `won`; there are no results until the theatre finishes.
  - **visboss, iphone14** (`fix-core/visboss/iphone14/visboss.json`).
    - **After the intro app-switch.** `introResumed` has intro true and is locked (before: intro false). 4 s later the
      fight runs, and steering works (targetX 0 → 1.59).
    - **After the death app-switch.** `deathResumed` has state playing and scale 0.25 (before: state complete at once),
      and `final` reaches complete.

## CORE-8 (minor): landscape steering lags the finger — **FIXED**

- **Changes**
  - **Formula.** `getSteerK` (`engine.js:1576-1593`): when w/h ≥ `WORLD.camera.portraitBelow`,
    W_eff = min(W, `SQUAD.steer.landscapeWidthFactor`·H).
  - **New key.** `landscapeWidthFactor` = **0.7** (`data.js:134`).
  - **Docs.** GDD §3.2 and the ARCH §6.2 `getSteerK` comment are amended.
- **Tuning note.** The triage's "about 1.35" does not reach the 0.6–0.75 target. The squad's on-screen travel per metre
  in landscape is only 14.4 px/m, because the camera follows 0.4·sx. The tuned value is 0.7, which gives
  k = 0.0473 m/px at 844×390.
- **Verify** (`fix-core/fingerratio.mjs`). The script takes a `DRAG` env and adds k and an unclamped ratio, k × squad
  px per metre. The QA original drags 100 px from the centre, which hits the ±2.1 m clamp on the phones (and now in
  landscape), so the 100 px ratio is capped by the range rather than set by k. Results in `fix-core/fingerratio/`:

  | device | k before → after | ratio (40 px drag, unclamped) |
  |---|---|---|
  | iPhone 14 portrait | 0.03309 → 0.03309 | 1.02 (unchanged) |
  | 360×740 | 0.03584 → 0.03584 | 1.01 (unchanged) |
  | 412×915 | 0.03132 → 0.03132 | 1.02 (unchanged) |
  | iPad portrait | 0.01574 → 0.01574 | 0.73 (unchanged) |
  | **landscape 844×390** | 0.01529 → **0.04726** | **0.68** (was 0.22) |
  | iPad landscape 1180×820 (extra) | 0.0109 → 0.0225 | 0.63 |
  | desktop 1280×800 (extra) | 0.0101 → 0.0230 | 0.70 |

  - **Portrait.** The 100 px rows are identical to QA (0.64 / 0.59 / 0.68 / 0.73), because they are clamp-capped.
  - **Landscape crossing.** Crossing the ±2.1 m range in landscape now takes 89 finger px, down from 275.

## CORE-9 (minor): the boot bar's weights and captions don't follow the work — **PARTIAL** (main part done; the remaining long gaps are inside render.js, VIS-17)

- **Changes** (`js/main.js`)
  - **`PROGRESS` re-weighted** (`main.js:36-39`). Page 0–4 %, render.init 5–30 % (textures), models, audio, engine and
    systems 30–50 %, warm-up 50–95 %, UI prewarm 95–99 %.
  - **Captions.** `ui.setBootCaption(step)` (UI-29) is called before each real step (textures, models, audio, systems,
    shaders), guarded.
  - **Systems step.** It yields a frame whenever the inits since the last paint exceed `SYSTEMS_SLICE_MS` (40 ms)
    (`main.js:356-366`). It was one frozen block of 450–570 ms at 4×.
  - **Warm-up.** `warmRender` passes `onProgress` to `render.warmup(onProgress)` (VIS-17) and maps it onto 50–95 %. A
    bounded creep (≤ 25 % of the range above the last report) runs between reports. The compileAsync fallback path
    yields a frame between the compile and the draw.
  - **UI prewarm.** `await ui.prewarm()` (UI-19) runs before `hideBoot`, capped at 2 s (`prewarmUi`, `main.js:253`).
  - **Helper.** A `capped()` helper shares the timeout logic.
- **Verify**
  - **A/B with request interception** (`fix-core/bootcmp.mjs`). It serves the pre-fix `main.js.before` or the shipped
    main.js, alternating within the same session. Results in `fix-core/bootcmp/`.
  - **Unthrottled, 5 rounds** (median).
    - First bar → hidden: 939 → **834 ms**. Navigation → hidden: 1250 → **1048 ms**.
    - So boot is **not** longer: it is about 100–200 ms shorter, because the prewarm runs inside boot instead of being
      held after `hideBoot`.
    - Painted bar steps: 15 → 16.
  - **4×, 4 rounds.**
    - **Painted steps.** **16–17** distinct bar/caption steps, against the ≥ 8 required (13–17 before).
    - **Worst gap.** 1.2–2.5 s, against 1.6–4.6 s before; the machine was saturated.
    - **Where the worst gap is.** Always at the start of the warm-up (bar 50 %, inside render.warmup: the compileAsync
      synchronous part plus the single warm-up draw) or in render.init's texture build (bar 9–22 %).
  - **`throttle.mjs --rate 4 --level 1 --quality med` (`fix-core/boot4-after-*`).**
    - **Long tasks still over 300 ms.** render.init texture build (583/340 ms), the warm-up compile (345 ms) and the
      warm-up draw (635 ms).
    - **Ownership.** All of these are in render.js and are VIS-17's scope (the per-pixel grain loops and the one-shot
      warm-up draw).
    - **Systems step.** Now ≤ 170 ms per slice.
  - **Not met.** The "no painted gap > 300 ms at 4×" criterion cannot be met from main.js alone: see needsOtherGroup 1.
  - **Interface state.** `render.warmup` does not take `onProgress` yet in the current tree; main already passes it, and
    the creep covers the range until it does.

## CORE-10 (polish): the scene renders squashed for ≈ 120 ms after a rotation — **FIXED**

- **Changes**
  - **Leading and trailing edge** (`engine.js:883-912`). `_scheduleResize` resizes at once on the first event of a
    burst, then re-arms the trailing `_doResize` `JUICE.ui.resizeDebounceMs` after the last event.
  - **Orientation flip.** An event inside a burst that flips portrait ⇄ landscape against the applied render size
    (`_orientationMismatch`) also resizes at once. This covers `orientationchange` arriving before layout.
  - **Debounce constant.** The literal is moved to `JUICE.ui.resizeDebounceMs` = 120 (`data.js:1201`).
  - **Timer callback.** It is bound once as `_onResizeTrailing`, with no per-event closure.
- **Verify**
  - **rotframe** (`fix-core/rotframe/rotframe.json`). Stretched frames: 19 → **1**. The one left is the frame whose rAF
    ran before that frame's ResizeObserver callback: CSS has already changed and the RO resize happens in the same
    rendering step. There are none after the first resize event.
  - **Screenshot.** `landscape-30ms.png` shows an undistorted landscape scene 30 ms after the rotation.
  - **rothitch auto, 2 runs** (`fix-core/rothitch/`). The worst frame within 100 ms of a rotation is 7–35 ms, against
    14–28 ms before (`rothitch-before`) and 21–28 ms in QA, so it is unchanged.
  - **Late spike.** One rotation per run shows a 111 ms frame about 1.2–1.5 s later. The baseline run shows the same
    (187 ms at 1238 ms), so it is pre-existing and not resize-related.

## CORE-11 (polish): ?reset=1 stays in the URL — **FIXED**

- **Change.** `js/main.js:162-171` adds `dropResetParam()`: `history.replaceState` with `reset` removed, inside
  try/catch, a no-op when history is unavailable or blocked. It is called right after `ctx.save.reset()`
  (`main.js:298-301`).
- **Verify** (`fix-core/ec/t8-meta.mjs reset`, output in `fix-core/ec/t8-reset/`).
  - After `?debug=1&nomusic=1&reset=1`, coins are 0 and `location.search` is `?debug=1&nomusic=1`.
  - After earning 55 coins and reloading, coins are **55** and the URL has no reset.

---

## Public API / contract notes (ARCH is partly not mine)

- **`Engine` additions.**
  - `measureRefresh()`, `get frameTargetMs()`, and the `ctx.time.theatre` field.
  - All are documented in ARCH §2.2 and §6.2, which are mine.
- **`freezeQuality`.** The deadline moved from `time.now` to `time.theatre`. `quality.frozenUntil` is read only by
  engine.js.
- **Boot sequence (ARCH §4.1, not mine).** It is now 9 → 9b warm-up (with onProgress) → 9c `await ui.prewarm()` →
  10 hideBoot, with `ui.setBootCaption` at each step.

## needsOtherGroup

1. **visual (js/render.js, VIS-17): needed for CORE-9's "no painted gap > 300 ms at 4×".**
   - **Progress callback.** Make `warmup(onProgress)` call `onProgress(t)` with t in 0..1 at each phase. For example:
     0.1 after starting the compile, 0.5 when `compileAsync` resolves, then one step per draw chunk, and 1 at the end.
     Main already passes the callback (`main.js` `warmRender`).
   - **Yield.** In `_warmupRun`, yield a frame (rAF → setTimeout 0) between `await p` (compileAsync resolving) and the
     first `this.draw()`, and between the draw chunks. Today the compile completion and the full forced-visible draw
     run in one task (345 + 635 ms at 4× on this machine).
   - **Texture build.** It still produces 340–580 ms tasks at 4× (the `_drawRoad` / `_drawWindows` grain loops); per
     VIS-17, use tiled patterns.
   - **Warm-up chunks.** Split the forced-visible draw into chunks, as VIS-17 step 3 asks.
2. **ui (js/ui.js, UI-29), cosmetic.** `BOOT_STEP_AT = [0.06, 0.70, 0.80, 0.84, 0.95]` (ui.js:105) mirrors the old
   PROGRESS boundaries. Main now calls `setBootCaption` from the first step, so the fallback is never used with this
   main.js. If you keep it, update it to the new boundaries `[0.05, 0.30, 0.36, 0.37, 0.50]`.
3. **Docs (lead / whoever owns ARCH §4.1 and §9.5).**
   - **§4.1.** Add step 9c `await ctx.ui.prewarm()` (capped at 2 s) before step 10, and say that main calls
     `ui.setBootCaption(i)` at each step and passes `onProgress` to `render.warmup`.
   - **§9.5.** It says "both debounced 120 ms into `render.resize()`". Change it to "leading + trailing edge
     (`JUICE.ui.resizeDebounceMs`), see §6.2".
