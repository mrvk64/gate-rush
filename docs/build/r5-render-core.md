# Round 5: render core (visual districts in render.js, title idle gates)

Owner: render core (`js/render.js`). Docs touched: `docs/ARCHITECTURE.md` §6.3 (targeted edits: the class block gains `setDistrict` / `district` / `bloomBase`, the `applyQuality` fog note, and one implementation bullet under "Round 5, visual districts"). `docs/DISTRICTS.md` and `js/data.js` are unchanged. `docs/GDD.md` is unchanged: no designed behaviour changed.

Evidence root: `E:/Temp/claude/gate-rush-evidence/r5/render-core/` (written `EV/` below). The tools are in `EV/tools/`, and the pre-change `render.js` with the tree md5s is in `EV/src-before/`. Final `js/render.js` md5 `c3e593e9a300a935fbde2bc153cab024`, 3033 lines.

**Summary**
- `render.setDistrict(district, seconds)` is implemented per DISTRICTS.md §6.1 / §8.2:
  - it covers the lights, the shadow box, the fog and clear colour, exposure, bloom, the grade, `uRoadBg` and the eye glow;
  - fades run on the theatre clock, and `seconds = 0` snaps;
  - it forwards to `env.setDistrict` in the same call.
- `renderer.info.programs` stays flat on every tier:
  - 58 / 58 / 42 programs on Medium / High / Low;
  - checked across all six districts, a 4 s cross-fade, an interrupted fade and a real endless rotation.
- District 1 is identical at boot on Low, Medium and High: 21 fields of render state match the pre-change `render.js` bit for bit.
- r4-release issue 5 (the title's idle gates cross the camera's near field) is **not fixed in render.js**. Measurements show that no title camera keeps the sky band and also keeps the gates out of the near field. The fix belongs to the decorative gates' lifetime and is written up under needsOtherGroup with numbers.

## 1. Changes (`js/render.js`)

| Lines | Change |
|---|---|
| 50 | Imports `DISTRICTS`. |
| 139–207 | District state layout: `DS_*` offsets into one `Float64Array(40)`. Helpers: `finiteOr`, `setScalar` (writes a uniform scalar only when it changes), `packDistrict` (linear colours via `Color.setHex`, scalars, light offset), `lightYz` (the world-z of the shadow camera's light-space y axis, using the same arithmetic as `_setSunAzimuth`). |
| 1327–1349 (constructor) | All six districts are packed once into `_dPacks`. Also allocated once: the spare `_dCustom` (for any object with the district key tree), the `_cur` mirror, the `_dFrom` snapshot, the target and the fade window. Further state: `_bloomHold` (frame stamp), `_eyeApplied`, the cached `uRoadBg`, `_yz1` (0.518 for `RENDER.sun.offset`) and the un-swung `_baseOff*`. |
| 1483 (`init`) | `_applyDistrictState(true)` writes District 1 into every consumer. The values equal the ones `init` already wrote (identity test, §2.1). |
| 1524–1531 (`update`) | Runs a fade step while a fade is on. Otherwise it restores the bloom base on the first frame without a hold (see the `setBloomStrength` row). It re-tries `models.setEyeGlow` until models exists (boot step 6 runs after render). |
| 1549–1592 `setDistrict` | Takes a district object, a 0-based index or an id (the same inputs `env.setDistrict` accepts). With `seconds > 0` it snapshots `_cur` as "from" (so a call during a fade starts from the mid-fade values) and sets `t0 = ctx.time.theatre`. With `seconds = 0` it snaps and applies at once. Then it forwards `env.setDistrict(d, s)`, guarded. Fallback when env has no `setDistrict`: `env.setFog(d.fog.near, params.fogFar × farScale, s)`. |
| 1595, 1598 | `get district`, `get bloomBase`. |
| 1602–1620 `_stepDistrictFade` | `k = ease.inOutCubic((theatre − t0) / dur)`. Every value is lerped linearly. The light offset uses a normalized lerp: the direction is nlerped and the length lerped. At k = 1 the target is copied exactly. |
| 1623–1666 `_applyDistrictState` | Writes, in order: sun colour and intensity; `_baseOff` → `_updateShadowBox` → `_setSunAzimuth` (current title swing); hemisphere colours; `_updateTitleLight`; `fog.color` + `setClearColor`; exposure; bloom strength (unless held this frame on a fade frame; a snap always resets it); bloom radius; the 10 grade uniforms; `uRoadBg`; eye glow. On a snap it also places the sun before the next draw. |
| 1669–1690 | `_roadBgUniform` (cached lookup of `materials.gatePanel().uniforms.uRoadBg`). `_applyEyeGlow` (calls `models.setEyeGlow` only when the value changes; guarded). |
| 1693–1704 `_updateShadowBox` | `sun.shadow.camera.bottom = RENDER.sun.frustum.b × max(1, yz / yz₁)` from the un-swung offset, then `updateProjectionMatrix` (only when the value changed) and the texel size. |
| 1707–1729 | `_updateTitleLight` reads `_cur`: hemisphere intensity → title value, swing `sun.titleAzimuthDeg`. `_setSunAzimuth` rotates the district offset instead of `RENDER.sun.offset`. |
| 1878–1883 (`applyQuality`) | The `env.setFog(fog.near, p.fogFar, 0)` call is removed. It cancelled a run-up or district fog lerp mid-way and dropped `farScale`. `env.applyQuality` already writes `params.fogFar × farScale` (into a running lerp's target). render writes `fog.far` only before env exists. |
| 2036–2068 (`_warmDrawChunked`) | A list entry may be a `{ mesh, geometry }` pair. The geometry is assigned for the draw and restored with the other saved fields (6-tuples). |
| 2414, 2443–2470 | `warmup` appends `_appendDistrictWarm(list)`. That calls `env.districtWarmList(out)` (spec name) or falls back to `env.warmDistricts(out)`, and keeps only valid pairs. 16 pairs are drawn at boot. |
| 2294 (`_configureComposer`) | A new bloom pass (High ⇄ Medium, Low → composer) gets `_cur`'s radius and the current strength. |
| 2488–2504 `setBloomStrength` | A non-finite `v` gives `bloomBase`. A finite `v` holds for this frame (`ctx.time.frame` stamp): fx's pulse beats a running fade, and once nobody holds it the base comes back. |
| 2767–2776 `_updateTexelSize` | Reads the shadow camera's live bounds, since the bottom now follows the light elevation. |
| 2970–2991 (`rebuild`) | Exposure and clear colour come from `_cur` / `scene.fog`. After `_applyTierState` it runs `_applyDistrictState(true)`: no `setDistrict` call and no environment re-layout (DISTRICTS.md §3.4). |

Rules (ARCH §14):
- A fade frame makes no object allocation: index arithmetic into preallocated typed arrays, `Color.setRGB`, and scalar writes only on change.
- No `console.log`, no `Math.random`.
- Every browser and collaborator call is guarded (`env.setDistrict`, `districtWarmList` / `warmDistricts`, `models.setEyeGlow`, `materials.gatePanel`).
- No light is added, removed or re-flagged, and no material is touched, so no program key can change.

## 2. Evidence

### 2.1 District 1 identity (`EV/identity/`)
`tools/district-check.mjs --mode state` dumps 21 fields of render state at boot:
- sun colour, intensity, swung offset and azimuth;
- shadow bounds, texel size and light basis;
- hemisphere colours and intensity;
- fog colour, near and far; clear colour; exposure;
- bloom strength, radius and threshold;
- the 11 grade uniforms; `uRoadBg`; the program count.

It ran with the pre-change `render.js` (served in its place) and with the new one, on Medium, High and Low. Result: **IDENTICAL on all three tiers**.

### 2.2 Six districts, cross-fade, interrupt, bloom hold (`EV/district-{med,high,low}`, `EV/district-high-2`, `EV/district-med-final`)

**Programs.** The count is 58 at boot on Medium and High and 42 on Low. It stays there after each of the six snaps, after the screenshots, through every frame of the Overcast → Night fade, at the end on the title, and after a level started in a non-D1 district (L11, L16, L21 or L26).

**Shadow box bottom per district.** These match the DISTRICTS.md §2 table.

| District | Shadow box bottom |
|---|---|
| Sunset | −12.00 |
| Overcast | −17.83 |
| Night | −14.19 |
| Toxic | −12.60 |
| Ash | −12.00 |
| Frozen | −12.00 |

**Fog near / far per district** (written by env): 40 / 100, 38 / 95, 40 / 104, 38 / 95, 38 / 95, 38 / 95.

**Bloom.** Strength / radius per district: 0.6 / 0.4, 0.5 / 0.4, 0.7 / 0.45, 0.7 / 0.45, 0.65 / 0.5, 0.55 / 0.4. The threshold stays 0.85.

**Fade (Overcast → Night, 4 s).**
- 651 frames on Medium (final run); the longest frame was 12 ms.
- Exposure, sun intensity, bloom and the shadow bottom ease smoothly.
- The bottom passes −18.97 mid-fade (the nlerped light swings through azimuth 0), so the shadow reach never drops below the end values.
- `fadeOn` clears at 4 s, with exposure exactly 1.2.
- High, run 1: frames of 66–203 ms appeared mid-fade. Run 2 had 658 frames and none above 25 ms. Run 1's long frames were host load: 13 Chrome processes were running from other owners' runs, and the same clusters show with the old `render.js` (§2.5).

**Interrupted fade.** Night → Toxic, then Frozen at 2 s:
- exposure was 1.149985 just before the second call and 1.149985 two frames after it, so there was no jump;
- it ended at exactly 0.95.

**Bloom hold.**
- With fx.update patched to call `setBloomStrength(1.7)` every frame, a running fade kept 1.7 on every frame.
- `setBloomStrength()` then restored the mid-fade base (0.55), and the fade ended at 0.6.
- A single `setBloomStrength(1.3)` outside a fade (Night) was back to 0.7 two frames later (`EV/misc-med-final`).

**Tier switches and context loss under Night** (`EV/misc-med`, `EV/misc-med-final`).
- Medium → Low → High → Medium: every render consumer equals the Night values except fog far on Low (93.6 = 90 × 1.04, as it should be).
- The bloom pass comes back at 0.7 / 0.45 on High and Medium.
- `WEBGL_lose_context` lose → restore: all consumers equal the Night values, bloom is 0.7 / 0.45 / 0.85, programs are back at 58, and `after-restore.png` shows Night.

**Allocation** (`EV/alloc-*`, CDP sampling heap profiler at a 32-byte interval over a 4 s fade). render's own district functions sampled about 4–5 KB per fade in total:

| Function | Sampled per fade |
|---|---|
| `_stepDistrictFade` | ≈ 1 KB |
| `_applyDistrictState` | 1.5–2.6 KB |
| `_updateShadowBox` | ≈ 1 KB |
| everything else | < 0.4 KB |

- That is ≈ 8 bytes per frame of V8 double boxing (un-optimized tiers and three's tagged uniform `value` slots). There are no object allocations.
- Before `setScalar` and the skip-unchanged writes it was ≈ 38 KB.
- For scale, the shipped `_updateCamera` samples 12–32 KB per 4 s with no fade.

**Screens.**
- `district-med/title-d1..6.png`: the title in each district, through the real `setDistrict` + env path.
- `district-med/play-L11-b.png`: Night City gameplay with the moon light, shadows, lit windows, neon, pools and fog.
- `district-high/play-L21*.png` (Ash), `district-low/play-L26*.png` (Frozen, Low) and `district-med-final/play-L16*.png` (Toxic).

**Draw calls** (main / shadow / post, under the 50 / 20 / 14 budget):

| Run | Main | Shadow | Post |
|---|---|---|---|
| Night L11, Medium | 28 | 8 | 10 |
| Toxic L16, Medium | 29 | 7 | 10 |
| Ash L21, High | 31 | 9 | 14 |
| Frozen L26, Low | 30 | 0 | 0 |

### 2.3 Title rule (DISTRICTS.md §3.5, acceptance 8)
With `--pre "g.save.data.highestUnlocked = 14; g.level.quitToTitle()"`, the title shows Night City on the phone and on desktop (`EV/title-hu14-phone/01.png`, `EV/title-hu14-desktop/01.png`). On the phone the moon sits right of centre above the logo. Programs stay at 58. At boot (highestUnlocked 1) the title is Sunset.

### 2.4 Endless rotation (real run, level owner's trigger; `EV/endless-med*`)
`tools/endless-rot.mjs` starts endless at seed 4242 and keeps the squad at 150 or more.

**What happened.**
- `district:change` fired as `sunset/start/0/banner` at 0 m, then `overcast/rotate/4/banner` at 900 m.
- Programs stayed at 58 before, during and after.
- The calls maximum was 46 / 13 / 10 (main / shadow / post).
- Screenshots `rot-00..07.png` show the fade: rain, a grey haze, the props draining and refilling.

**Frame times.** No frame went over 50 ms inside the 4 s fade in either of the runs without screenshots:
- run 1 (6 s window): 574 frames in the fade, longest 14.8 ms;
- run 2 (25 s window): 574 frames in the fade, longest 8.2 ms.

Clusters of 55–182 ms frames show up later (5.8 s in one run; 12.8 s and 19.7 s in the other), at different times in each run. With screenshots on, the four long frames are the screenshot stalls themselves. §2.5 shows the same clusters with the old `render.js`. The environment owner could still re-check the slot-swap moment (about 180 m, or 18–20 s, after the call) on a quiet host.

### 2.5 Smoke and static checks
- `node --check js/render.js`: OK.
- `node tools/check-imports.js`: 0 errors, 0 warnings.
- `smoke --scenario boot` (Medium, Low): CLEAN.
- `smoke --scenario all --desktop`: CLEAN.
- `smoke --scenario play`, all CLEAN with no frame over 50 ms in the first 2 s (acceptance 5); output in `EV/smoke-play-L*-*/`:

| Tier | Levels |
|---|---|
| Medium | L1, L6, L11, L16, L21, L26 |
| High | L1, L11, L26 |
| Low | L16 |

- p99 is 7.1 ms in every run except L1 High (13.8 ms).
- Clusters of 55–277 ms frames appear mid-run at random times, in D1-only L1 as well.
- An A/B run with `tools/longframes.mjs` (L11, 20 s, two rounds; `EV/longframes/ab.txt`) shows the same clusters with the **pre-change** `render.js` (216 ms at 14.7 s) and with the new one (231 ms, 65 ms). So this is host contention, not render.

## 3. r4-release remaining issue 5: title idle gates in the camera's near field

**Before.** Captured with `tools/titleseq.mjs` in `EV/title-before-desktop/` and `EV/title-before-phone/`.
- Desktop frames 06 and 13: the ×2 gate fills the left half of the screen at z = 3.7 and z = 6.1.
- Phone frame 23 shows the same pair behind PLAY: the "7" and "×" panels fill the lower half.

**Cause.** These are measurements:
- Decorative gates travel to `WORLD.despawnZ` = +14, past the title camera at z = +11.
- The title camera sits only 1.7 m above the gate's top bar (y 5 against 3.32).
- On landscape it also sits 0.16 m from the right gate's outer post line (x 4 against 3.84).
- The analytic sweep `tools/gatenear.mjs` samples the frame posts, bar and panel of the pair from z −70 to +14 against the frustum. The closest distance at which a gate point is still in view:

| Rig | Closest visible gate point |
|---|---|
| Phone | 2.38 m |
| 1280 × 800 | 2.62 m |
| 844 × 390 | 2.86 m |
| Gameplay preset, portrait | 7.7 m |
| Gameplay preset, landscape | 10.1 m |

**Why not the camera.** `tools/rigsearch.mjs` searched about 50 k landscape title rigs over aspect ratios 4:3 to 19.5:9, keeping the squad left of the button column and between the logo and PLAY:
- for the closest visible gate point to reach 6 m, the camera must sit at y ≈ 9.5 with pitch ≈ 36°;
- for 8 m it must sit at y ≈ 11;
- either way the top of the frame drops 13° or more below the horizon, so the sky band disappears from the title. The districts' title dressing (moon, stars, sky, skyline, acceptance 8) needs that band.
- Shifting the current rig sideways (x 5–7) only moves the closest point to 2.4–3.9 m.
- A title-only near plane would slice the gates and also cut nearby props.
- So I left `WORLD.camera.title` / `titleLandscape` unchanged.

**The fix that works (analytic).**
- Sink each decorative gate into the road once the title squad has marched through it: y offset = −2 × (z − z₀) from z₀ ≈ squad depth + 0.5 m (≈ 1.5–2.5 m for the 7-soldier title squad), freed once fully under the road.
- Result: the closest visible gate point becomes 8.0–8.9 m on the phone, desktop and 844 × 390 rigs, the same as gameplay. The squad framing is unchanged.
- The road occludes the sinking frame (it is opaque, and the panels are depth-tested). No program change is involved: it is the instance matrix's y.

The request is in needsOtherGroup.

## needsOtherGroup

1. **gates.js (decorative events), or level.js `idleStep`: title idle gates leave through the near field** (r4-release issue 5, §3).
   - Change, in the `_evDecorative` branch of `Gates.step` (it already marks them missed at z ≥ 0): sink each decorative pair below the road once the squad has passed it. Translate y by −2 m per metre of z beyond z₀ = `world.squadDepth` + 0.5 (≈ 2 m on the title), and free the event once fully below y = 0 (the top bar is 3.32 m, so 1.7 m of travel).
   - Effect: the closest visible gate point goes from 2.4–2.9 m to 8.0–8.9 m on the phone, desktop and 844 × 390 title rigs, with the squad framing kept.
   - Alternative: free decorative events at z ≥ 1.5. That gives 9.6 m, but the gate pops out while it is about 10 m from the camera, so it is a visible pop.
   - If that is preferred, a level-side alternative is a title-only despawn line in `idleStep`.
   - Data, if wanted: `WORLD.idleGateSink { z0Pad: 0.5, rate: 2 }`.
   - Evidence: `EV/tools/gatenear.mjs` (the sink and free options are built in), `EV/tools/rigsearch.mjs`, `EV/title-before-*`.
2. **fx.js (≈ 1454, ≈ 2727): the boss-death bloom pulse still uses `RENDER.bloom.strength`.** DISTRICTS.md §8.7 wants it to peak at `render.bloomBase + (deathPeak − RENDER.bloom.strength)` and return to `render.bloomBase`. fx's reset path also calls `setBloomStrength(RENDER.bloom.strength)` instead of `setBloomStrength()`.
   - render now defends against both: a finite value holds for one frame, and the district's base comes back on the next frame without a hold.
   - Still to fix in fx: the pulse in Night / Toxic / Ash / Frozen is computed around 0.6, not the district's base.
3. **environment.js: both district warm paths are drawn at boot.**
   - `warmDistricts()` parks 16 hidden proxy meshes, which `warmup` traverses, and `districtWarmList()` returns 16 pairs. render draws both sets, so the 16 geometries get 32 warm draws. That is harmless and inside the chunked budget.
   - Pick one if you like: the spec names `districtWarmList`. If the proxies are kept, `_warmHiddenChunked` also covers tier changes, which is a plus.
   - Note: the task text for render named `env.warmDistricts`. render accepts it as a fallback, called with `out`.
4. **environment.js: allocation during a district fade.**
   - With `env.setDistrict` stubbed out, `render.update`'s self-sampled allocation over a 4 s fade is 4 KB. With env's fade running it is 24–76 KB, attributed to `update` because env's code is inlined into it (`EV/alloc-new-fade*`, `EV/alloc-new-fade-noenv`).
   - Likely sources: typed-array reads in un-optimized tiers and double writes into tagged uniform `value` slots.
   - Skipping unchanged writes (what render's `setScalar` does) cut render's share from ≈ 38 KB to ≈ 5 KB.
5. **DISTRICTS.md §6.1 / §8.2: no spec error found.** One clarification for the owner: render resets the bloom strength to the base on every snap even when it is held that frame. The old level `_undoRuntimeState` called `setBloomStrength(RENDER.bloom.strength)` right before the snap. With a frame hold, a Night level would otherwise have started at bloom 0.6. Level now calls `setBloomStrength()`.
