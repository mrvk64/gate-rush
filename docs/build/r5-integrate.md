# Round 5: integration (visual districts end to end)

Integrator's pass after round 5. Inputs: `docs/DISTRICTS.md` and the five round-5 reports — `r5-render-core.md`, `r5-env-art.md`, `r5-level-balance.md`, `r5-ui-sw.md`, `r5-perf-audio.md`. Evidence root: `E:/Temp/claude/gate-rush-evidence/r5/integrate/`, written `IV/` below; the tree as handed over is in `IV/src-before/` (md5s in `IV/src-before-md5.txt`), the tools in `IV/tools/`, every edit as an anchor-checked edit file in `IV/tools/edits/` (applied with `IV/tools/rep.cjs`), the final md5s in `IV/md5-final.txt`.

**Verdict: the district feature works end to end.**
- **Title.** The title scene and its caption show the district of the highest unlocked level, at boot from a saved profile (14 → Night City, 22 → Ash Wasteland, 27 → Frozen Outskirts) and after `quitToTitle`.
- **Campaign.** L1 / L6 / L11 / L16 / L21 / L26 start in Sunset / Overcast / Night / Toxic / Ash / Frozen, each with its banner.
- **Endless.** It rotates at 900 m (Overcast) and 1 800 m (Night) with 4 s cross-fades, banners, and no frame over 50 ms in the fade windows; the cross-fade screenshots are in §4.
- **Programs.** `renderer.info.programs` is flat: 58 / 58 / 42 on Medium / High / Low over the title in all six districts, six endless fades, six level starts and the title again.
- **Draw calls.** Within main ≤ 50 / shadow ≤ 20 / post ≤ 14 in every district (per-frame maxima, §4). Districts add no draw; gameplay content had pushed heavy frames to 51–54 main draws in every district, and the six road segments are now one draw.
- **Hitches.** No frame over 50 ms at a district change or a level start: menu starts no longer run a whole level generation in the click handler (a cold L13 / L19 / L28 was a 104–139 ms frame).

Every valid needsOtherGroup request is applied (§1). The §10.3 full-dressing readability pass was run for the first time (§2.6): 50 of 54 (district, depth, tier) cells pass; three data changes fixed five failing cells, and the four residual misses are listed with their causes.

Host: i7-8700K, RX 6800 (ANGLE D3D11), headless Chrome on the real GPU, 144 Hz panel; quiet (the user's desktop Chrome only) for every frame-time measurement.

## 1. needsOtherGroup requests

| Source | Request | Status | Where |
|---|---|---|---|
| render-core 1, level-balance 2 | Title idle gates sweep through the camera's near field (r4-release issue 5) | **Applied**: decorative gates sink into the road behind the title squad (`WORLD.idleGateSink { z0Pad 0.5, rate 2 }`, y offset in `gates.render()`, the event freed once fully under the road) | `js/gates.js`, `js/data.js`; ARCH §6.9, GDD §14; §2.3 |
| render-core 2 | fx's boss-death bloom pulse still centred on `RENDER.bloom.strength` | **Applied**: it peaks at `bloomBase + (deathPeak − strength)` and ends with `setBloomStrength()`; the reset path too | `js/fx.js`; ARCH §6.3 note; §2.4 |
| render-core 3 | Both district warm paths are drawn at boot | **Kept, documented**: the step-6 proxies also cover tier changes (`_warmHiddenChunked`), the 16 extra warm draws reuse the same VAOs | DISTRICTS §3.6 |
| render-core 4 | env allocation during a fade (24–76 KB per 4 s) | **Investigated, no change**: V8 HeapNumber boxing of scalar uniform writes into three's tagged `{ value }` slots — no object, array or closure is allocated; the same mechanism as every per-frame uniform (uTime, fog). Skipping unchanged writes would only cut the channels two districts share | — |
| render-core 5 | Spec clarification: a snap resets the bloom strength | **Applied** | DISTRICTS §6.1 |
| env-art: level / levelgen | The first generated level start is a 63–73 ms frame | **Fixed at the root** (§2.5): `level.requestStart` / `requestRestart` for the menus (generation in frame slices when the script is not memoized), the levels screen prefetches every unlocked level, the memo holds the campaign | `js/level.js`, `js/ui.js`, `css/game.css`, `tools/smoke.js`; ARCH §6.16, §10.3; GDD §14 |
| env-art: docs | DISTRICTS amendments: relight rule, scatter paint, `uCloudOff` / `uGrUnlit` / `uGrWet` | **Applied** | DISTRICTS §3.3, §6.2, §7.2, §13 |
| env-art: data | `WET_REFLECT` is a module literal | **Applied**: `DISTRICT_RULES.puddleReflect`, read guarded (then 0.5 → 0.3, §2.6) | `js/data.js`, `js/environment.js`; ARCH §8 |
| env-art: readability QA | The §10.3 full-dressing pass was never run | **Run** on all tiers (§2.6); three data changes | `IV/readability-final/` |
| env-art: art direction | Toxic smokestack plumes sit above the portrait gameplay view | **Confirmed, left to art direction**: the x band 15–26 m is outside the portrait camera's 27° horizontal FOV nearer than ≈ 62 m, and the mouths (20.5 m) are above the view's top edge nearer than ≈ 75 m, so in portrait play the plumes show only in the fog; they read on the title rig and in landscape. Moving the band or `smokeY` changes the art | §5 |
| env-art: perf QA | §10.12 weather cost not measured | **Measured** (§2.8) | `IV/thr-*` |
| level-balance 1 | Run DISTRICTS §10.5 once `setDistrict` landed | **Done** (§2.5, §4) | — |
| level-balance 3, 4, 5 | Passive-player fail rate, boss-damage rank value, accepted validator warnings | Lead decisions; not changed | — |
| level-balance 6 | QA re-runs | The integration matrix (§4); the balance suites are unchanged code-wise (only menu-start timing changed) | — |
| level-balance 7 | Maybe suppress the banner on the first L1 run (FTUE) | **Not applied**: the banner sits under the progress bar, the steer hint at the bottom, both readable at once (`IV/banner-l1/start-1-700ms.png`); the GDD shows it at a run start in a new district | — |
| ui-sw 1 | DISTRICTS §5: landscape banner placement | **Applied** | DISTRICTS §5 |
| ui-sw 2 | audio.js music fallbacks 80 → 70 | Already done by perf-audio | — |
| ui-sw 3 | Smoke `calls` 63–67 against "main ≤ 50" | **Confirmed**: `calls` is main + shadow + post; the smoke report now carries the split and its per-frame maxima per district (`callsMax`) and names the objects of each peak frame (`callsPeak`) | `tools/smoke.js`; ARCH §15.3 |
| ui-sw 4 | package.js: a release must change sw.js | **Applied**: `dist/sw.js` gets a build stamp; packaging stops when the stamp changes under an unchanged `VERSION` | `tools/package.js`; ARCH §15.3 / §15.4; §2.9 |
| ui-sw 5, 6 | Bump `VERSION` / rebuild `dist/` with the round-5 release | Release step, not run here (no release was asked for): `main.js` still says 1.1.0, `dist/` holds 1.1.0, `sw.js` is v4. The release engineer runs `node tools/package.js --check` | — |
| perf-audio 1 | level's cold `_fireBoss` helpers at the first boss | **Applied**: a silent dry run of the helpers 45 m before each boss event | `js/level.js`; ARCH §6.16; §2.7 |
| perf-audio 2 | fx / ui first boss handling is cold | **Applied for ui**: the boss chrome's entry animations (bar, letterbox, name card) run once in the boot prewarm, like the pill and the banner. **fx not changed**: its `_onBossIntro` is a trauma add plus `navigator.vibrate`, which Chrome blocks (with a console intervention) before a user gesture, so it cannot be warmed silently at boot | `js/ui.js`; ARCH §6.14 |
| perf-audio 3 | The 4× arrival frame target ≤ 33 ms | **Re-measured** (§2.7) | — |
| perf-audio 4, 5, 6 | Nothing to do / lead record / QA | — | — |

## 2. Measurements

### 2.1 Title, campaign bands, banner

| Check | Result | Evidence |
|---|---|---|
| Boot with a saved profile (levels cleared through `save.recordLevel`, page reloaded) | highestUnlocked 14 → `night` (level, render and environment), caption "DISTRICT 3 · NIGHT CITY"; 22 → `ash`; 27 → `frozen`; 0 page / console errors | `IV/bootdistrict/boot-hu*.png`, `IV/tools/bootdistrict.mjs` |
| `quitToTitle` with highestUnlocked 14, desktop | Night City title with moon, neon and lit windows | `IV/title-night-desktop/` |
| Campaign starts (final matrix, High) | L1 sunset, L6 overcast, L11 night, L16 toxic, L21 ash, L26 frozen; each `district:change { reason 'start', banner }` | §4 |
| Banner | L1 start: "DISTRICT 1 · SUNSET BOULEVARD" under the progress bar while the steer hint sits at the bottom; endless: a banner at each rotation | `IV/banner-l1/`, §4 |

### 2.2 Programs

`IV/tools/progflat.mjs`: one page per tier; the title snapped to each of the six districts, an endless run with six 4 s fades (Overcast → Night → Toxic → Ash → Frozen → Sunset), L1 / L6 / L11 / L16 / L21 / L26 started, back to the title — 21 samples per tier.

| Tier | Programs (min–max) |
|---|---|
| Medium | 58–58 |
| High | 58–58 |
| Low | 42–42 |

Every final-matrix play run also reports its program count per frame while playing (§4).

### 2.3 Title idle gates (r4-release issue 5)

- **Before** (`r5/render-core/title-before-desktop/06.png`): the ×2 gate filled the left half of the desktop title at z 3.7.
- **After**, with the scroll frozen and the pair placed at fixed z (`IV/tools/sinkshots.mjs`, `IV/sink-desktop/z*.png`): at z ≤ squad depth + 0.5 (≈ 1.1 m) the gate is unchanged; at z 1.5 it is lowered 0.8 m, at z 2 it is half sunk, at z 3 it is under the road, and the event is freed at z ≈ 3.3.
- **Live** (`IV/titlepass-desktop/`, `IV/title-after-desktop/`, `IV/title-after-phone/`): no gate in the camera's near field.
- **Not fixed (pre-existing, not a gate):** on the landscape / desktop title rig (camera x 4, y 5) a right-shoulder lamppost passes 0.75 m beside the camera every 15 m of road, its arm and head crossing the top of the view (`IV/title-after-desktop/12.png`, `IV/title-night-desktop/04.png`). It is the same with the handed-over tree (`r5/render-core/title-before-desktop/07.png`), and lamp presence is 1.0 on High in every district. §5 lists it.

### 2.4 Boss-death bloom pulse per district

`IV/tools/bloompulse.mjs`, High: the pulse started in each district (`fx._bloomT = 0`), `bloomPass.strength` sampled every frame for 2 s.

| District | Base | Peak | End |
|---|---|---|---|
| Sunset | 0.60 | 1.60 | 0.60 |
| Overcast | 0.50 | 1.50 | 0.50 |
| Night | 0.70 | 1.70 | 0.70 |
| Toxic | 0.70 | 1.70 | 0.70 |
| Ash | 0.65 | 1.65 | 0.65 |
| Frozen | 0.55 | 1.55 | 0.55 |

District 1 is unchanged (0.6 → 1.6 → 0.6).

### 2.5 Level start and district change frames

**Cause.** A district snap costs ≤ 2 ms (r5-env-art). The long level-start frames are level generation: a menu start whose script is not memoized ran `generateLevel` in the click handler. Round-5 calibration gave L13 / L19 / L28 29–32 attempts, and the levels screen prefetched only the highest and the last level. smoke's `--level` runs never saw it: their frame window opened about 1 s after the start.

**Fix.**
- `level.requestStart(n)` and `requestRestart()` are the menus' entry points. ui routes PLAY, NEXT, the level tiles and RETRY / REPLAY / RESTART through them.
- A memoized or authored script starts at once. Otherwise the generation moves to the front of the prefetch queue and runs in animation-frame slices of 8 ms (one attempt minimum), and the run starts in the frame the script is ready; the tapped button pulses (`.starting`) meanwhile.
- A state change, a newer request or a direct start drops a pending request.
- The levels screen also prefetches every unlocked level, nearest the frontier first, and the memo holds `LEVELS.count + 10` scripts (3–6 KB of JSON each).
- `start()` keeps its synchronous contract (boot with `?level=N`, tools).

`IV/tools/startprobe2.mjs`, Medium; fresh page per level, 2.5 s on the title, then the start; every rAF interval from the call to 2.5 s after the run began:

| Level | Direct `start()` (before): call / worst frame | Menu path `requestStart`: frames until playing / worst frame | After 1.5 s on the levels screen |
|---|---|---|---|
| L6 | 48.8 ms / **55.6 ms** | 6 frames (55 ms) / 27.7 ms | — |
| L11 | 22.9 ms / 21.0 ms | 4 (44 ms) / 20.8 ms | — |
| L13 | 94.6 ms / **104.3 ms** | 11 (110 ms) / 20.9 ms | prefetched: 2.4 ms call, worst 20.9 ms |
| L19 | 136.5 ms / **138.9 ms** | 14 (154 ms) / 20.7 ms | — |
| L28 | 141.3 ms / **139.0 ms** | 15 (161 ms) / 20.8 ms | prefetched: 2.6 ms call, worst 20.9 ms |

The 20.8–27.7 ms frame is the run's first gameplay frame, the same for an authored L1 (20.9 ms).

**UI flows** (`IV/tools/reqflow.mjs`, real button clicks):
- **Cold tile 19.** `.starting` is on the tile and `level.starting` is true while the state stays `levels`; then L19 plays and the class is gone.
- **Tile 28, then BACK.** The request is dropped (title, not starting).
- **Tile 13, then tile 19.** L19 starts.
- **RETRY after a game over.** It plays with the rerolled seed (1019 → 1119).
- No page or console errors.

District changes during play (fades, banners) are in the final matrix (§4): the worst frame of every fade window plus 1 s, and `startFrames` (the start frame and the first 2 s) for every level run.

### 2.6 Readability, full-dressing pass (DISTRICTS §10.3)

**Method.** `IV/tools/readability.mjs` takes proto.mjs's sampling unchanged — panel body, plates, brightest glyph pixel, frame posts at the chevron rows, and the backdrop at ±2.7 m. Each district is reached through `level.start` (L2 / L7 / L12 / L17 / L22 / L27), so the real `render.setDistrict` and `env.setLevel` lay out its props, puddles, pools, stars, weather and smoke. The scroll is then frozen and decorative gates of every type are placed at z −70 / −36 / −26.
- **Bare:** one read with dust and smoke hidden.
- **Full:** 30 reads, 0.1 s apart, everything running.

`IV/tools/full-analyze.mjs` applies the §4.3 floors. The full pass checks its median against min(absolute, 0.9 × Sunset's full median) and its 10th percentile against 85 % of that. The Sunset bare numbers reproduce §4.4 (Medium 36 px: 21.2 (−), frame 29.9, ×1 36.8, −/÷ 10.8, 5.39 : 1).

**First pass (handed-over data)** (`IV/readability/analysis-*.md`). The full pass failed four cells on Medium and four on High, plus Low's Frozen 17 px MAX p10. Medium's four include Sunset's own 36 px p10 (12.6), the reference district; Toxic's bare 36 px read was 14.7, but its full pass passed:
- Overcast 36 px item panel 14.7 (Medium) and 14.8 (High);
- Frozen armed-line panel 14.6 and 36 px panel 14.4 / frame 19.2 (Medium); Frozen armed-line frame 18.0 and 36 px panel 14.5 (High);
- Ash 36 px panel 14.9 (High).

**Causes, isolated with uniform overrides** (`IV/readability-nowet/`, `IV/readability-exp/`, candidates `IV/readability-cand{A,B,C}/`):
- **Overcast and Toxic.** The puddles' horizon reflection (`uGrWet`, an env-art addition the spec never measured) brightens and blues the far road beside the gates at grazing angles. With it off, Overcast's 36 px panel goes from 14.7 to 17.2 and Toxic's from 14.7 to 16.6. §4.4's Overcast step 1 (puddles 0.35 → 0.2) alone left 14.7.
- **Frozen.** The backdrop windows take in the far road's edge line. Frozen's near-white paint #E4E8EC (the bare-pass stand-in only tinted the whole road by the asphalt ratio, so it was never measured) costs ≈ 2–3 ΔE00. District 1's #D6D6CC restores the panels and frames on Medium; #DCE0E4 was not enough.

**Data changes** (`js/data.js`):
- `DISTRICT_RULES.puddleReflect` 0.5 → 0.3;
- Overcast `road.puddles` 0.35 → 0.2 (§4.4 step 1);
- Frozen `road.edge` #E4E8EC → #D6D6CC.

**Final pass** (`IV/readability-final/analysis-{med,high,low}.md`), full-pass verdicts:

| Tier | Pass | Residual misses |
|---|---|---|
| Medium | 17 / 18 | Sunset (District 1, unchanged) 36 px panel p10 12.3 against 12.75 |
| High | 16 / 18 | Ash 36 px panel median 14.9 against 15; Frozen armed-line frame median 19.8 against 20 |
| Low | 17 / 18 | Frozen 17 px MAX panel p10 8.8 against 11.05 (median 13.3 passes 13) |

- **The §4.4 steps for the two High misses do not move them.** Ash's burning-wreck emissive 2.8 → 2.0, and Frozen's snow opacity 0.85 → 0.6 then snowfield #C0CCD8 → #A8B4C0, were applied and re-measured (`IV/readability-ladder/`): 14.9 and 19.8 again. They were reverted; `js/data.js` is byte-identical to the pre-ladder copy.
- **The Low miss is the glow quad's breathing.** On Low the glow quad stands in for bloom, and at the dim phase of its breathing it meets the pale fog; the median passes.
- **Bare single reads swing ±2 ΔE00 between runs** (the gates' glow breathing), so the full pass is the verdict.
- **Fixed by the three data changes: five cells.**
  - Medium: Overcast 36 px panel 15.4; Frozen armed / 36 px panel 16.0 / 15.5, frame 24.2 / 21.3.
  - High: Overcast 36 px panel 15.9; Frozen 36 px panel 15.6.
  - Toxic's bare 36 px read now passes as well.

### 2.7 Boss arrival at 4× CPU (perf-audio 1–3)

**What changed.**
- **level.** 45 m before each boss event — armed at the run start in the campaign, or when an endless mini-boss chunk is appended — level dry-runs `_fireBoss`'s own helpers with every result discarded: archetype resolution, the minion union, `solveWaveHp`, `_liveHpMult`, `_bossHpScale`, and in endless the pressure copy. It runs once per boss in 0–0.4 ms (`IV/tools/bosswarm.mjs`: L1 at 355 m for the boss at 400, L10 at 805 / 850, endless at 1 385 / 1 430). A debug jump past the warm point skips it, so it never lands in the arrival frame.
- **ui.** The boss chrome's entry animations run in the boot prewarm.

**Method.** `IV/tools/batch-split.sh`, perf-audio's framesplit2 with a `--preBoss 70` jump (to 70 m before the boss, so the warm-up can run), 390 × 844 @ 2.75, Medium. Three interleaved pairs: before = the handed-over `level.js` + `ui.js`, after = this tree (`IV/split-ab/`).

| | Before (3 runs) | After (3 runs) |
|---|---|---|
| Arrival frame JS (ms) | 23.2 / 24.0 / 31.5 | 24.6 / 21.8 / 22.8 |
| `level._fireBoss` incl. `boss.spawn` (ms) | 5.0 / 4.2 / 4.9 | 4.2 / 4.2 / 3.7 |
| … of which level's own code (ms) | 2.9 / 2.0 / 2.4 | 1.5 / 1.8 / 1.7 |
| rAF interval over 30 ms at the arrival | 34.7 ms, none, 41.6 ms | none, none, none |

On this quiet host the arrival frame now stays under the 33 ms target in all three runs. The remaining JS is `render.draw` (10–12 ms) and `boss.spawn` (2–2.7 ms).

### 2.8 Weather cost (DISTRICTS §10.12)

**Method.** The round-3 throttle profile (`IV/tools/throttle.mjs`: 4× CPU, 390 × 844 @ 2.75, Medium, lane bot, 40 s), interleaved L1, L6, L1, L6 (`IV/thr-l{1,6}-{a,b}/perf.json`).

| Run | Frame interval median / mean (ms) | JS median (ms) | Draw median (ms) | Intervals > 50 ms |
|---|---|---|---|---|
| L1 a | 7.0 / 8.23 | 5.1 | 4.2 | 0 |
| L6 a | 7.0 / 8.49 | 5.5 | 4.6 | 2 (62.6 ms: the tool starts the level with a direct `start()`, a cold generation; and 76.4 ms, below) |
| L1 b | 7.0 / 8.20 | 4.9 | 4.1 | 0 |
| L6 b | 7.0 / 8.31 | 5.4 | 4.5 | 0 |

**Verdict.** The median frame time is equal and the mean is +0.11 to +0.26 ms, inside §10.12's +0.5 ms. The rain's CPU side (JS + draw) costs ≈ 0.4 ms per frame at 4×. The fill cost is a GPU matter; this desktop GPU does not show it.

**One open observation.** L6 at 4× has one long frame at the same moment in both runs: 76.4 ms at 23.65 s in run a, 48.6 ms at 23.62 s in run b.
- It is absent with Sunset forced on the same L6 run (`IV/thr-l6-sunset/`, worst 34.8 ms) and with the rain hidden (`IV/thr-l6-nodust/`, worst 34.8 ms). So the rain plus something in that moment of play causes it.
- The CPU profile (`IV/thr-l6-prof/cpu.cpuprofile`, `IV/tools/profspike.cjs`) puts the time in the main pass's uniform, texture and scissor / viewport calls. That is a GPU-process stall, not game JS.
- At 1× there is no such frame (`IV/tools/spikes.mjs`: nothing over 21 ms in 30 s of L6). It is open for perf QA on a real device (§5).

### 2.9 package.js release rule (ui-sw 4)

**Test.** A sandbox copy of the tree (`IV/pkgtest/`), packaged four times:
1. Fresh: dist/ is built, and `dist/sw.js` ends with `// build 71275c680ebb…`.
2. Unchanged tree: the same stamp, so the build passes.
3. One js/ file changed under the same `VERSION`: the build stops ("sw.js VERSION is still 'v4' but the build changed … Bump VERSION …") and dist/ is left untouched.
4. `VERSION` bumped to v5: the build passes with a new stamp.

The real `dist/` (1.1.0, v3) was not touched.

### 2.10 Road ring: one draw instead of six

**Why.** Per-frame maxima from the handed-over tree (`IV/m0-*`, High):
- L16 (Toxic) peaked at **51** main draws;
- endless peaked at **54** (Overcast).

**Cause: content, not districts.** At the same gameplay moment the six districts draw the same calls (`IV/dl-l16-high.json`: main 34–35, shadow 11–13). A peak frame (`IV/dp-*.json`) holds:
- 17 environment draws, 6 of them road segments;
- 6–7 characters and globs;
- 4–5 gate draws;
- 5–8 troop draws (models: sniper 4, medic 3, flamer 2, drone 3, APC 3);
- 10 fx draws, the label overlay included.
The ARCH §9.1 table (environment 10, troops ≤ 5, fx 6) had drifted.

**Change** (`js/environment.js`).
- The six segment planes are merged into one mesh, each vertex tagged with its segment (`aGrSeg`).
- The `gr:road` vertex shader moves segment k to `uGrSegZ[k]`, the segment centre `_sync` used to write into six mesh matrices.
- `vGrLocal` stays segment-local, so the pools are unchanged.
- No program is added (still `gr:road`), and the road never casts.

**Pixel identity.** `IV/tools/pixid.mjs` (env-art's frozen L1 frame: same seed, uTime, camera and sun; environment objects only) compares this tree with the tree just before the merge (`IV/treeB/`):

| Tier | Result |
|---|---|
| Low | identical |
| Medium | 2 pixels differ by 1 / 255 |
| High | 1 pixel at 7 / 255 (a far segment seam, x 435, y 975) and 1 at 1 / 255 |

The seam pixel is float32 rounding of the seam position, which differs between a vertex-shader offset and a per-mesh model-view matrix; neither path was watertight at the ulp level.

### 2.11 Static checks and call sites

| Check | Result |
|---|---|
| `node --check` on js/ (22), tools/ (8) and sw.js | 31 files, no failure |
| `node tools/check-imports.js` | 0 errors, 0 warnings |
| `node tools/validate-levels.js` | 30 levels · 7 warnings · **0 errors** — the same 7 warnings as r5-level-balance's hand-over (`IV/validate-levels.txt`) |
| `node tools/build-artifact.js` | "sw.js PRECACHE covers all 22 files in js/"; `artifact.html` byte-identical (md5 5faecc04…; index.html unchanged) |
| `node r5/techart-review/tools/validate-districts.mjs js/data.js` | ok, 0 errors |
| `node tools/callsites.js` | `docs/build/CALLSITES.md` regenerated (625 lines). New cross-module members: `render.bloomBase` (fx), `level.requestStart` / `requestRestart` (ui), `world.squadDepth` (gates) |
| Call sites exist at runtime (`IV/tools/members-rt.mjs`, qa2's checker: every CALLSITES member probed on the live objects at the title, in play and in a boss fight) | 468 members. The 38 "missing" are the checker's alias false positives (`fx.label.*` read through `lab`, `quality.params.*`, `render.size.w`, number `.toFixed`…), the same 38 as on the handed-over tree (463 members, `IV/members-before.json`). None of the new members is missing |
| `grep console.log / Math.random` in js/ | comments only; none added |

## 3. Changes (file:line, as of this hand-off)

| File:line | Change |
|---|---|
| `js/level.js:63` | `SCRIPT_CACHE_MAX` 8 → `LEVELS.count + 10` |
| `js/level.js:72–79` | `START_SLICE_MS` (8), `BOSS_WARM_LEAD_M` (45) |
| `js/level.js:341–354` | request-start and boss-warm fields (seeded per ARCH §14 rule 11) |
| `js/level.js:626–702` | `requestStart`, `get starting`, `requestRestart`, `_scheduleRequest` (rAF, setTimeout, sync fallback), `_cancelRequest`, `_runRequest` |
| `js/level.js:` start / startEndless / quitToTitle / dispose | a direct start drops a pending request |
| `js/level.js:814, 830` | `_onStateChange`: a pending request leaves with its menu; the levels screen prefetches every unlocked level |
| `js/level.js:1082, 1206, 1306, 1651, 1702–1737` | boss-path warm-up: armed at the run start / by a mini-boss chunk, run 45 m ahead, skipped when the boss fires first; `_armBossWarm`, `_warmBossPath` |
| `js/ui.js:412–413, 1342–1345, 1390–1391` | boss-chrome animations in the prewarm; `_startingBtn` |
| `js/ui.js:2162, 3222–3248, 3262–3280` | PLAY / NEXT / tiles → `_startLevel`; RETRY / REPLAY / RESTART → `_restartLevel`; `.starting` on and off |
| `css/game.css:445–449` | `.btn.starting, .tile.starting` (the `confirm-pulse`; static under reduced motion) |
| `js/gates.js:116–124, 1158, 1489, 1560` and the six instance-matrix writes | decorative gates sink behind the title squad and are freed under the road |
| `js/fx.js:1451–1456, 2724–2742` | bloom pulse on `render.bloomBase`; `setBloomStrength()` at its end and in `reset()` |
| `js/environment.js:685–697, 1338, 1347–1362, 2088–2091` | the road ring as one draw (`aGrSeg`, `uGrSegZ`, `env.road`) |
| `js/environment.js:1001–1003` | `WET_REFLECT` from `DISTRICT_RULES.puddleReflect` (guarded) |
| `js/data.js:80–84` | `WORLD.idleGateSink` |
| `js/data.js:1300–1304` | `DISTRICT_RULES.puddleReflect` 0.3 |
| `js/data.js:1366–1367, 1491–1493` | Overcast `road.puddles` 0.2; Frozen `road.edge` #D6D6CC |
| `tools/smoke.js` | header; per-sample `district` / `callsMain|Shadow|Post` / `programs`; `callsMax`, `callsPeak` (draw hook installed once), `programs`, `districts` (+ worst fade frame), `startFrames`; `--level` through `requestStart`; four screenshots across each endless rotation |
| `tools/package.js` | build stamp in `dist/sw.js`; the release rule enforced before `dist/` is touched |
| `docs/DISTRICTS.md` | status; §3.3, §3.6, §5, §6.1, §6.2, §7.2, §8.1, §9 amendments; §2 / §4.4 data rows; new §13 |
| `docs/ARCHITECTURE.md` | §6.3 (pulse), §6.9 (sink), §6.14 (prewarm), §6.16 (`requestStart`, `requestRestart`, `starting`, prefetch, boss warm-up), §8 (round-5 integration keys), §8.10, §9.1 (`env.road`, budget), §10.3 (button routing), §15.3 (smoke, package), §15.4 (release rule) |
| `docs/GDD.md` §14 | Title (the sinking idle gates), Levels (prefetch, `.starting`) |
| `docs/build/CALLSITES.md` | regenerated |

No file outside this list changed; `index.html`, `artifact.html`, `sw.js` and `dist/` are as handed over.

## 4. Smoke matrix (final tree)

`IV/tools/matrix2.sh m1`, sequential on the quiet host, default quality (auto → High on this machine), 390 × 844 @ 2 touch phone, `?debug=1&nomusic=1`, `--bootTimeout 90`; L6–L26 with shop ranks typical of their band (`--pre`: every upgrade at 2 / 4 / 6 / 8 / 9) and `--seconds 150–170` so every boss is fought; endless with ranks 6. The artifact run was repeated as `m2` after the harness's listener fix (one `district:change` record per change). Calls are per-frame maxima, main / shadow / post. Frames exclude screenshot stalls; "start" is the worst frame from the start call through its first 2 s; "fade" is the worst frame over each district change + its fade + 1 s.

| Run | Verdict | errors (page / console err / warn / failed req) | End | frames: n, fps, p95 / p99 / worst (ms) | > 50 ms | start / fade worst (ms) | calls max | programs |
|---|---|---|---|---|---|---|---|---|
| `--scenario boot` | **CLEAN** | 0 / 0 / 0 / 0 | title (High), boot 7.2 s | – | – | – | – | – |
| `--level 1 --shots 6` | **CLEAN** | 0 / 0 / 0 / 0 | L1 clear ★★★ | 8 816, 143.9, 7.1 / 7.1 / 21.0 | 0 | 27.8 | sunset 35 / 12 / 14 | 58 |
| `--level 6` (ranks 2) | **CLEAN** | 0 / 0 / 0 / 0 | L6 clear ★★★ | 12 089, 143.9, 7.1 / 7.1 / 27.9 | 0 | 34.6 | overcast 40 / 14 / 14 | 58 |
| `--level 11` (ranks 4) | **CLEAN** | 0 / 0 / 0 / 0 | L11 clear ★★☆ | 14 705, 144.0, 7.1 / 7.1 / 20.9 | 0 | 34.7 | night 42 / 15 / 14 | 58 |
| `--level 16` (ranks 6) | **CLEAN** | 0 / 0 / 0 / 0 | L16 clear ★★★ | 16 359, 143.9, 7.1 / 7.1 / 20.9 | 0 | 34.7 | toxic 46 / 16 / 14 | 58 |
| `--level 21` (ranks 8) | **CLEAN** | 0 / 0 / 0 / 0 | L21 clear ★★★ | 18 562, 143.9, 7.1 / 7.1 / 34.7 | 0 | 20.8 | ash 40 / 13 / 14 | 58 |
| `--level 26` (ranks 9) | **CLEAN** | 0 / 0 / 0 / 0 | L26 clear ★★★ | 18 454, 143.9, 7.1 / 7.1 / 27.9 | 0 | 27.9 | frozen 43 / 15 / 14 | 58 |
| `--endless --seconds 200` (ranks 6) | **CLEAN** | 0 / 0 / 0 / 0 | alive at 1 840 m (timeout) | 26 333, 143.9, 7.1 / 7.1 / 34.7 | 0 | start 7.1; overcast at 900 m 7.1; night at 1 800 m 7.1 | sunset 41 / 15 / 14, overcast 44 / 17 / 14, night 28 / 12 / 14 | 58 |
| `--scenario ui` | **CLEAN** | 0 / 0 / 0 / 0 | shop, buy, levels (district bands), settings, play, pause, resume, quit → title | – | – | – | – | – |
| `--scenario all --shell artifact` | **CLEAN** | 0 / 0 / 0 / 0 | L1 clear ★★★; HOME touch tap → title | 8 724, 143.9, 7.1 / 7.1 / 20.8 | 0 | 7.1 | sunset 35 / 12 / 14 | 58 |

- **Screenshots.** Every run's screenshots were looked at as contact sheets (`IV/sheets/m1-*.png`), and the endless cross-fades at full size (`IV/sheets/m1-endless-fades.png`, `IV/m1-endless/18…22-fade1-*`, `38…40-fade2-*`).
- **Sunset → Overcast at 900 m.** The banner shows at 0.6 s. The orange haze turns grey-green through 1.8–2.8 s, and Overcast with rain is complete at 4.6 s. The roadside props are still Sunset's: they drain and refill as designed (DISTRICTS §3.3).
- **Overcast → Night at 1 800 m.** Banner at 0.6 s, dusk at 2.8 s, Night at 199 s.
- **Every level.** Its district, its banner, the boss of the level and the clear screen are shown.
- **L26 133 s.** That frame is the boss-death white flash (J16).
- **Endless soldiers' purple helmet rings.** They are the magnet gear's glow (CHR-2), picked up at 19 s.
- **Handed-over tree for comparison.** The same matrix (`IV/m0-*`, fresh profile, default `--seconds`) was CLEAN with per-frame main maxima of 40 / 46 / 45 / 51 / 45 / 43 (L1–L26) and 47 / 54 / 36 (endless sunset / overcast / night).

## 5. Remaining issues (honest list)

1. **Four readability cells miss the §4.3 floors** (§2.6). These are open for the art director:
   - High, Ash 36 px panel: median 14.9 against 15.
   - High, Frozen armed-line frame: median 19.8 against 20.
   - Low, Frozen 17 px MAX panel: p10 8.8 against 11.05 (median 13.3 passes).
   - Medium, Sunset 36 px panel: p10 12.3 against 12.75 — District 1 itself, which rule 1 keeps unchanged.

   The §4.4 steps for Ash and Frozen were applied and re-measured, did not move the numbers, and were reverted. A fix needs a palette or glow decision: for example the Frozen fog or panel against it, the glow breathing amplitude on Low, or Ash's near-road haze. The bare single reads swing ±2 ΔE00 with the glow breathing; a regression baseline needs several reads, or the breathing frozen for the read.
2. **Landscape / desktop title: right-shoulder lampposts pass through the side camera** (§2.3).
   - The rig sits at x 4, y 5, so every lamp's pole passes 0.75 m away and its arm and head cross the top of the view. That happens every 2.5 s at the title's 6 m/s on High, where lamp presence is 1.0 in every district.
   - It is pre-existing and not a gate.
   - Options: hide the right-shoulder lamps while the landscape idle rig is on; add a near-camera dither to the prop materials; or move the rig, which render-core's search shows costs the sky band.
3. **Toxic's smokestack plumes do not show in portrait play** (§1, env-art: art direction). They read on the title rig and in landscape; it is an art-direction call (x band or `smokeY`).
4. **The main-pass budget can still be exceeded by content.**
   - With the road at one draw, the heaviest frames of this matrix stay ≤ 50 (§4).
   - The theoretical cap is still ≈ 60: environment 12, characters and globs 7, all five troops 15, the boss ≈ 5, gates 5, weapons ≤ 4, pickups 3, fx 10.
   - A content budget is a follow-up: one InstancedMesh for the troop rings, or the troops' glow parts merged into their bodies.
   - ARCH §9.1 now records the measured composition.
5. **Release step not run.** `js/main.js` still says 1.1.0, `dist/` and `gate-rush-dist.zip` hold 1.1.0 (sw v3), and the tree's `sw.js` is v4.
   - The round-5 release bumps the version and runs `node tools/package.js --check`.
   - That build passes the new release-rule check, because v3 ≠ v4.
   - Publishing the claude.ai artifact link is also the release owner's call.
6. **fx's first `boss:intro` stays cold.** Its cost is `navigator.vibrate`, which Chrome blocks with a console intervention before a user gesture. It cannot be pre-run silently; the arrival frame met the 33 ms target in all three runs without it (§2.7).
7. **Members check: 38 false positives** (alias resolution in `tools/callsites.js` / qa2's checker), unchanged from the handed-over tree. This is tooling noise, as in QA-ROUND2.
8. **Road seam.** One far seam pixel differs by 7 / 255 on High in the frozen-frame identity test (§2.10); it is not visible in play.
9. **A 4× CPU frame in Overcast.** One 48.6–76.4 ms frame appears at the same moment of L6 at 4× CPU (§2.8). It needs the rain (it is absent with Sunset forced and with the rain hidden). The profile shows a GPU-process stall inside the main pass, and nothing over 21 ms happens at 1×. It needs a check on a real mid-range phone (perf QA): a GPU trace of that frame, and the rain's point sizes and overdraw at that moment.

## 6. How to re-run

The tools live in `IV/tools/` and run from there; outputs go under `IV/`:

```bash
bash IV/tools/matrix2.sh <tag> [boot l1 l6 l11 l16 l21 l26 endless ui artifact]   # final smoke matrix → IV/<tag>-*
node IV/tools/summ.cjs IV <tag>
node IV/tools/startprobe2.mjs med 6,13,19,28 [--direct] [--levels]
node IV/tools/readability.mjs <low|med|high> IV/<dir> 30 [ids] [after-js]   # then full-analyze.mjs <tier> <bare.json> <full.json>
node IV/tools/progflat.mjs
node IV/tools/drawpeak.mjs IV/<out>.json high <endless|L> <seconds>
bash IV/tools/batch-split.sh <tag>                                      # boss arrival at 4×, before / after
node IV/tools/pixid.mjs <treeA> <treeB> --quality med                   # frozen-frame pixel identity
```
