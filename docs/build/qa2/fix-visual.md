# Round-2 fixes — group "visual" (fix-visual)

Files edited: js/render.js, js/materials.js, js/environment.js; targeted keys in js/data.js (`RENDER.atlas.strokePx`, `QUALITY_TIERS.med.bloomMips` (new), `RENDER.title` (new), `WORLD.camera.countDolly`, `WORLD.camera.titleLandscape` (new), `RENDER.env.manhole` (new); the `WORLD.camera.title` value is unchanged), docs/GDD.md (§2 camera rows, §15 Materials paragraph, §16 bloom row) and docs/ARCHITECTURE.md §6.3. Evidence lives under docs/build/qa2/fix-visual/ (scripts + JSON + small crops).

**Environment caveats (read first).**
- **Disk.** Drive C: was at 0–35 MB free during the whole session (other fixers' runs). Two PNG writes came out empty. Full-size screenshots therefore went to `E:/Temp/fixvis/<run>` and only JSON reports and small crops were kept under docs/build/qa2/fix-visual/. I moved my own earlier large PNGs to `E:/Temp/fixvis/archive/`.
- **Host load.** The host ran at 70–100 % CPU with 60–80 Chrome processes from concurrent QA and fix sessions. All absolute throttled timings (VIS-13, VIS-17) are inflated far beyond the quiet-host baselines; for example, the unthrottled-equivalent game ran at 23 fps in the official 4× run. I give relative numbers from interleaved A/B runs in one session where possible.

Checks: `node --check js/*.js` OK; `node tools/check-imports.js` → 0 errors / 0 warnings. `node tools/smoke.js --scenario all` → **CLEAN** (0 page errors, 0 console errors or warnings; L1 completed with 288 soldiers; out E:/Temp/fixvis/all).

---

## [VIS-12] Gate value glyph contrast — FIXED (acceptance with GAT-7 still to re-measure)
**Changes**
- **js/materials.js PANEL_FRAG**
  - Body luminance cap: `col *= min(1, uPlateK.z / lum)` with cap 0.45 (:357-359).
  - Far-background compensation clamp at 0.5 (:378-381). It scales by the brightest channel instead of a per-channel `min`: the per-channel clamp turned blue panels teal over the orange fog.
  - Rounded dark backing plate under the glyph block (:383-386, :409-411):
    - 0.84 × panel half width, 0.52 × panel half height, centred on the text (gates centre the quads on the panel mid-line), corner 0.25 m.
    - Mixed 45 % toward `uDark`.
    - No sheen inside it (:465).
  - Plate luminance cap 0.06 applied after the hit flash; the white J5 flip flash is exempt (:474-477). The spec's darken alone left the green ×N plate at 2.2–2.8:1 under sustained fire.
  - The MAX badge, ring gauge, hazard stripes and hit/flip flash code are untouched.
- **Constants and uniforms:** constants :113-125 (`PANEL_LUM_CAP`, `PANEL_COMP_CAP`, `PLATE_*`); uniforms `uPlate` / `uPlateK` / `uPlateCap` (:295-297, built at :925-927).
- **js/data.js `RENDER.atlas.strokePx`:** 12 → 18. The atlas is still built once at boot.
- **docs/GDD.md §15** Materials paragraph: plate, caps and the 18 px outline are noted.

**Verification**
- **Tool.** `docs/build/qa2/fix-visual/glyphprobe.mjs` is an in-page probe at the armed line, z −38…−34, glyph ≈ 28.5–29.5 css px.
- **Method.** It draws the real frame twice in one task (glyph quads on / off), reads back with `gl.readPixels`, and computes WCAG ratios of the glyph fill against the panel right behind it and against the surrounding plate including the bloom halo. Summaries via `gsum.mjs`.
- **Baseline**, with the new uniforms neutralised (glyph-base-high): 1.08–1.57:1. The green ×2 was 1.16 / 1.08.
- **After** (min behind / surround / surround+halo):

| Run | Behind | Surround | Surround+halo | Notes |
|---|---|---|---|---|
| L1 High (glyph-e-high) | 4.13 | 3.69 | 3.49 | +, ×, − |
| L1 Medium (glyph-e-med) | 4.02 | 3.96 | 3.70 | |
| L1 Low (glyph-e-low) | 5.02 | 4.45 | 4.03 | |
| L9 High (glyph-l9-high) | 3.39 | 3.51 | 3.28 | ÷ gates 4.2–5.0; the −N was hit or flipping at the time |

- **Every op ≥ 3:1 on every tier.** Crops: `glyph-e-montage.png` (High +5 / ×2 / −15 / +6 and Low ×2), `glyph-d-montage.png`, per-gate crops in each `glyph-*` dir.
- **Rim hue.** The panel rim and body hue stay identifiable (blue / green / red / pink frames and rims). Compare against visual-2 `crops/l1-gate17.png`. Full shots: `glyph-high-a/09-play-17s.png` (an earlier iteration with a 0.45-only plate).
- **GAT-7 interface.** Measured with `PALETTE.glyph.emissive` = 1.2 as found. If GAT-7 lowers it, Lfill drops: about −10 % at 0.8, which still leaves ≥ 3:1 by the margins above. Re-run `glyphprobe.mjs --quality high|med|low` once GAT-7 lands.
- **Side note.** The 18 px outline makes neighbouring digit quads overlap a little more while they pop at very close range (E:/Temp/fixvis/l9med/03-play-25s.png, "+180" passing the squad). Glyph advances are a gates layout matter. No issue at decision distance.

## [VIS-13] Medium CPU headroom — PARTIAL (all in-scope steps done; the ≤ 15 % target could not be verified on this host)
**Changes**
- **Medium bloom: 3 mips** (`QUALITY_TIERS.med.bloomMips: 3`, new; High keeps 5).
  - `TierBloomPass` (js/render.js :285-309) blurs only `mips` levels and disposes the unused targets.
  - It keeps all 5 blur materials and the 5-mip composite shader. The missing mips are bound to the last blurred level with a zero tint, so the composite alpha is unchanged.
  - **Result: High and Medium still share identical programs.** The round-1 VIS-1 rule holds: a High ⇄ Medium switch links no program, and `_programKey` is unchanged.
  - `_configureComposer` keys the pass on mode + mips (:1633-1647).
  - `TierBloomPass.dispose` / `_disposeComposer` no longer dispose three's shared Pass.js quad geometry (see VIS-21).
  - Post draw calls on Medium: 14 → 10. GL calls per frame: bindFramebuffer 17 → 13, clear 15 → 11, drawArrays 15 → 11 (`glcalls-med.json` vs perf-throttled baseline; `glcalls.mjs` copy keeps the squad alive).
  - GDD §16 bloom row amended. Halos stay round and soft (VIS-4 Gaussian kept; E:/Temp/fixvis/l9med/03-play-25s.png MAX pill / tracer glow).
- **Static matrices.**
  - Every environment object already had `matrixAutoUpdate = false` with one `updateMatrix()` after placement or re-seed. Moving ring meshes and segments call `updateMatrix()` only when they move.
  - The render-owned lights that were still auto-updating are now static: sun, sun.target and hemi (js/render.js `_buildLights` :2149-2156, `_updateSun` :2193-2198).
  - The remaining roughly 115 auto-updating objects belong to boss rigs, troops and characters (see needsOtherGroup).
- **Materials.**
  - `MaterialLibrary.standard()` / `hdrBasic()` were already cached per parameter set, and the env materials are one per parameter set (env.prop is shared by sandbags / tree / rubble / manhole / curbs).
  - `render.callStats.materials` (new) counts the distinct materials of visible drawables, resampled every 30 draws with an allocation-free stamp (:970-977, :1241-1255). L9 play: 20–26 drawn materials.
  - The 79 scene materials are mostly per-boss clones (boss.body / boss.glow / gr.hdr / gr.standard ×5 bosses) and troop parts, all hidden during the run.
- **VIS-14's depth materials** also remove the shadow-pass program re-resolution (getParameters garbage).

**Verification**
- **Interleaved A/B** (`ab.mjs`): one 4×-throttled L9 Medium session, mine (A) vs the old config (B: 5 mips, no env depth materials, auto-updating lights), 10 s segments alternated. Host saturated.

| Run | JS mean, A vs B | Draw mean, A vs B | p95 JS, A vs B |
|---|---|---|---|
| `ab-vis13b/ab.json` | 17.6 vs 19.1 ms (−8 %) | 13.1 vs 14.5 ms (−10 %) | 32.6 vs 36.5 |
| `ab-vis13/ab.json` (heavier load) | 45.4 vs 52.5 ms (−14 %) | 31.3 vs 39.1 ms | |

- **Official command** (`throttle.mjs --rate 4 --level 9 --quality med --seconds 90`): copied to `q4-l9-med/perf.json`, plus an earlier run `q4-l9-med-a`.
  - The host was saturated: fps 23–66, JS mean 10–30 ms.
  - **These runs cannot confirm or refute the p95 ≤ 9 ms / ≤ 15 %-over-7.5 ms target.** The quiet-host baseline was 7.51 ms mean.
  - **Re-run the official command on a quiet host.** If it still misses 15 %, the remaining lever is outside my files (needsOtherGroup 1–2).

## [VIS-14] Shared shadow-depth program churn — FIXED
**Changes**
- **`MaterialLibrary.depthFor({ instanced, instanceColor, map })`** (js/materials.js :874-894): a cached `MeshDepthMaterial({ depthPacking: RGBADepthPacking })` per combination, allocated once. It is included in `markAllNeedsUpdate` / `dispose`.
- **Environment casters.** Every env caster (barricade, sandbags, car, tree, rubble, lamppost: instanced + colour; building: + map) gets its `customDepthMaterial` from it in `_initInstanced` (js/environment.js :1199-1206).
- **Non-instanced casters** stay on three's default.
- **ARCH §6.3** documents the helper and the rule.

**Verification**
- `shadowchurn2` (L9 Medium, 15–45 s): `SHADOWCHURN {"frames":3379,"counts":{}}`, i.e. 0 re-resolutions. Zombie globs and crates are also 0, so ENE-15 and GAT-8 appear to have landed (`shadowchurn2/perf.json`).
- `churn2.mjs fix-visual/churn-l1.json 1 high`: play / boss / wonTheatre / results windows all have 0 rows (`churn-l1.json`).

## [VIS-15] Title squad black silhouettes — FIXED
**Changes**
- **New key `RENDER.title`** `{ hemi: 1.8, sunAzimuthDeg: 175 }`.
- **js/render.js `_updateTitleLight` / `_setSunAzimuth`** (:1181-1213).
  - While the title rig is on (eased with `_idleBlend`, so it is fully restored when `level:start` turns the idle camera off), the HemisphereLight intensity lerps 0.9 → 1.8.
  - The sun offset swings 175° about +Y toward the camera side.
  - The light-space basis used for texel snapping is rebuilt for the swung direction. `_updateSun` uses the current offset.
  - Uniforms only: no lights created or removed, no program changes.
- **GDD §2** "Camera (title)" row documents it.

**Verification**
- `smoke --scenario boot` → CLEAN (E:/Temp/fixvis/title/00-title.png). Soldier backs (backpacks) sample luma **44 / 43** (was 6), road 27.
  - Crops: `title-squad-before.png`, `title-squad-after.png`, `title-squad-compare.png`. The olive uniform and webbing are readable.
- `--desktop` → CLEAN, squad lit and left of the buttons (`title-desktop-squad.png`, E:/Temp/fixvis/title-desktop/00-title.png).
- Title → play: `level.start` runs with no new programs. The t2-boss run, the smoke `all` run and the raise-low progprobe start from the title and show no title-related program additions.

## [VIS-16] Shotgun / railgun pill icons — FIXED
**Changes** (js/render.js `_paintIcon` :906-921)
- The outline is stroked first (`ICON_STROKE` 3) and then filled, so only the outer 1.5 units show. This applies to every icon, consistently.
- Shotgun bars 5 → 7 units.
- Rail bolt polygon ~40 % wider.
- Icons are still drawn once at boot or on the UI-23 pre-warm.

**Verification**
- `smoke --level 13 --after "g.weapons.startWeapon('weapon.railgun' | 'weapon.shotgun')"` → both CLEAN (E:/Temp/fixvis/pills13-*).
- Pill pixels: shotgun bars #FF9A3C luma **169** / 143 (≥ 120), rail bolt #84B7D5 luma **174** (≥ 140). They read in weapon colour, consistent with the rocket and laser icons.
- Crops: `pills13/pills-after.png` vs visual-2 `crops/pills.png`.

## [VIS-17] Boot freeze (texture grain + single warm-up draw) — FIXED in code; throttled acceptance UNVERIFIED (host)
**Texture changes**
- **Road grain.** A tiled 64×64 noise pattern composited with `overlay` (`_grain`, js/render.js :660-683) instead of a getImageData loop over 512×1024. Facade grain uses the same helper.
- **Smoke fbm.** The 4 octave lattices are hashed once (`latticeNoise`, :393-402, :797-809) instead of 16 hashes per pixel. Same noise.
- **Result.** In-page timing of every `TextureFactory._draw*`, unthrottled: **≈ 11–27 ms total** (was ≈ 60–70 ms on the same host; road 20–40 → 1–4 ms, windows 6–10 → 1 ms, smoke 12–17 → 7–8 ms). This is under the ≤ 120 ms target.

**Warm-up changes: `render.warmup(onProgress)`** (:1813-1890)
- The VIS-1 `_compileChunked` gained limits and progress parameters. Boot uses `WARMUP_COMPILE` (≤ 8 new programs / 16 ms per frame).
- `_warmDrawChunked` is the generalised `_warmHiddenChunked`: every renderable is drawn once out of sight, 16 ms of chunks per frame, in scene order: env, characters, bosses, gates, pickups, weapons/fx.
- The composer's first use runs in its own frame with the scene pass disabled. The first real frame then runs in its own task.
- `onProgress` reports 0..1 monotonically, ending at 1. The signature is backward compatible: the engine's restore path calls `warmup()` without an argument.
- Obsolete `_compileFor` / `_forceAllVisible` / `_restoreVisible` were removed. ARCH §6.3 documents `warmup(onProgress)`.

**Verification**
- **Chunk timings** from a temporary instrumentation pass (removed afterwards), at 4× on the saturated host:

| Item | Duration |
|---|---|
| Warm-draw chunks | ≤ 77 ms |
| Single program compiles | 40–255 ms |
| First real draw | 257 ms |

  So the longest boot task ≈ one program compile plus the 16 ms budget.
- **Official runs** (`throttle.mjs --rate 4 --level 1 --quality med --seconds 10`): `boot4/perf.json`, and the boot part of `q4-l9-med/perf.json`. Both were taken with the host at 80–100 % CPU. Boot to title took 15–37 s, the main thread waited 0.6–3.5 s between frames, and these gaps also hit steps that are not mine ("Raising the dead…" 0.6–2.2 s, "Painting the road…" at 4 %).
- **Not decidable here.** I could not establish the "no boot frame > 300 ms" acceptance on this host; the quiet-host baseline gaps were 500–827 ms.
- Unthrottled boot is CLEAN (smoke boot / all).
- **Re-run** `throttle.mjs --rate 4 … boot4` and `bootprof.mjs` on a quiet host.

## [VIS-18] Pause burns the dolly / game-over camera — FIXED
**Changes**
- `theatreNow(time)` (js/render.js :128-135) returns `ctx.time.theatre` (CORE-7, present in engine.js), falling back to `time.now`.
- It is used for `_dollyStart` (`dollyTo`), `_goStart` (`gameOverCamera`) and the `now` passed to every elapsed calculation in `update()` → `_updateCamera`.

**Verification:** `t2-boss.mjs` copy (`t2-boss/report.json`; shots on E:), case A:
- At pause: boss z −39.5, dolly active.
- After 6 s paused and then resuming: the first sample has boss z **−39.5** (equal), dolly still active through the next 1.2 s, and the intro then continues.

## [VIS-19] 200-soldier formation feet off-screen — FIXED
**Changes**
- `WORLD.camera.countDolly` → `{ ref 40, z 0.53, y 0.165, maxS 11 }`: about 1 m further back and 0.5 m higher at V = 200.
- The framing constraint's back limit (`FRAMING.backMaxM`, js/render.js :77) goes 4 → 8 m. The solver now keeps the real squad back (6.5 m deep at 200) above ndc −0.8 by pitching first, then pulling back.
- GDD §2 rows "Camera framing constraint" and "Camera count dolly".

**Verification:** m_frame probe (`m_frame.js` adds `glyph36`, the css px of a 1.7 m glyph at z −36):

| Visible soldiers | feetOutPct | maxFeetY | glyph36 |
|---|---|---|---|
| 200 (before) | 6 | 899 | 28.4 |
| 200 | **0** | 760 | 27.4 (−3.5 %) |
| count 340 (visible 200) | **0** | 760 | 27.4 |
| 120 | 0 | — | 28.7 |
| 5 | 0 | — | 29.7 |

- Results: `frame-b-*.json`; before: `frame-before*-*.json`.
- The smoke `all` shot E:/Temp/fixvis/all/11-play-46s.png shows the whole 288/200 formation above the debug panel.

## [VIS-20] Landscape title squad behind PLAY — FIXED
**Changes**
- New `WORLD.camera.titleLandscape` `{ pos [4, 5, 11], look [4, 0, -8] }`, with absolute x.
- `_updateCamera` blends title ↔ titleLandscape by the preset blend (js/render.js title-rig block).
- The squad stands left of the centred button column on landscape phones and desktop.

**Verification** (`probe.mjs --w 844 --h 390` + `m_title.js`)
- Squad feet sx 251 / sy 282; formation box x 228–259.
- btn-play x 303–541, caption 401–443, SHOP / LEVELS 303–541.
- **The squad is outside the button column** (`title-land-b.png`). Desktop: `title-desktop-squad.png`.
- I did not run `ui-shells/probe.mjs landscape`: it does not measure the title squad, and it writes about 8 full screenshots onto the full C: drive. Its `squadScreenPhoneLand` step lives in the `wide` test during play.

## [VIS-21] Context restore console warnings — FIXED
**Changes** (js/render.js)
- **`rebuild()`** (:2357-2391):
  - Cancels a pending tier.
  - `_dropLostContextObjects()` (:1797-1813) drops, without `dispose()`, the composer and bloom targets, the stale bloom pass, the warm target and `sun.shadow.map`.
  - Resizes the canvas only when size or DPR changed.
  - Rebuilds the composer for the committed tier via `_applyTierState(_committedParams)`.
- **`TierBloomPass.dispose`** (:331-343) and **`_disposeComposer`** (:1771-1782) no longer dispose three's shared full-screen quad geometry.
  - That geometry is module-level in Pass.js and shared by every pass. Its pre-loss dispose listener produced the `deleteVertexArray` warnings.

**Verification:** `t16-gfx.mjs` copy (`t16-gfx/report.json`): **consoleWarnings `[]`** (was 118), 0 page or console errors; programs back to 54. Tier changes to low / high / med after the restores also produced no warnings. `ctxloss.mjs` (`ctxloss-before/report.json`) shows no gl.delete* calls other than three's normal post-link `deleteShader`.

## [VIS-22] Low → raised tier links charDepth.walker — VERIFIED, no change needed
**Verification:** `smoke --level 9 --quality low` + progprobe + `setQuality('med')` at 5 s (`raise-low-before/report.json`; run after the VIS-14 changes):
- Every new program, including `charDepth.walker` / `charDepth.soldier` / `charDepth.sniper` and the `gr.depth.*` variants, is created by the chunked pre-compile, one per frame, at 5.09–6.00 s, before the commit.
- After the commit: no new program names and no frame over 45 ms until the result screenshots at 19 s and later, which are harness stalls.
- The VIS-1 prepare path (`customDepthMaterial` items) already covers the characters' depth programs. The extra hidden shadow pass was therefore not added.

## [VIS-23] Doc amendments + data literals — FIXED
- **GDD §2:** landscape vFOV floor 42° and four new rows, tagged "(round-1 QA VIS-3)" plus the round-2 tags: framing constraint, count dolly, title rigs, title light.
- **Manhole literal** moved to `RENDER.env.manhole` (new; js/environment.js :125-128 now `const MANHOLE = ENV.manhole`).
- **`BADGE_LIFT_M`** fallback deleted (js/materials.js :92-94 reads `GATE_RULES.glyph.badgeLift`).
- `grep -n DATA-MISSING js/environment.js js/materials.js` → neither the manhole tag nor the badge tag remains.
- `smoke --scenario all` CLEAN. Road manholes and the MAX badge are unchanged (E:/Temp/fixvis/all/11-play-46s.png; E:/Temp/fixvis/l9med/03-play-25s.png MAX pill).

---

## needsOtherGroup
1. **core (js/engine.js, debug overlay):** print `ctx.render.callStats.materials` (new: distinct materials drawn, resampled every 30 draws) next to the calls split (VIS-13 "report on the overlay").
2. **characters / enemies / troops (js/models.js, js/boss.js, js/troops.js):** these owners hold the remaining VIS-13 levers.
   - About 115 of the remaining auto-updating objects are boss rig parts (torso / arms / legs / plates / chain ×5 bosses), troop parts (lens / ring / barrel / nozzle / discs / led / hull / wheels / headlights) and the character / zombie pool meshes. Set `matrixAutoUpdate = false` on rigs that are hidden or posed only by their owner, and `updateMatrix()` on pose.
   - Each boss clones its own `boss.body` / `boss.glow` / `gr.hdr` / `gr.standard` materials. Share them through `ctx.render.materials.standard()` / `hdrBasic()` (cached per parameter set) unless the rage glow needs a per-boss mutable copy.
   - Troop parts use unnamed one-off MeshStandardMaterials. Use `materials.standard()` or vertex colours on one shared material.
3. **ARCHITECTURE.md §9.4** (not mine) still says the bloom pass's 5 mips are never changed. Amend: "Medium blurs `QUALITY_TIERS.med.bloomMips` (3) mips; same programs as High (VIS-13)".
   - **§9.5** should mention that `rebuild()` drops render's lost-context GL objects without dispose (VIS-21).
   - **§8.1** should list the new `WORLD.camera.titleLandscape`, and **§8.9** the new `RENDER.title` / `RENDER.env.manhole`.
4. **gates (js/gates.js), optional:** the 18 px atlas outline makes adjacent digit quads overlap more while they pop up close (the "+180" passing the squad). If that matters, widen the digit spacing slightly (layout, not atlas).
5. **QA re-runs on a quiet host:** C: has to have free space, and the host was saturated during this session. Re-run:
   - VIS-13 `throttle.mjs --rate 4 --level 9 --quality med --seconds 90 --out docs/build/qa2/fix-visual/q4-l9-med`;
   - VIS-17 `throttle.mjs --rate 4 --level 1 --quality med --seconds 10 --out …/boot4` and `bootprof.mjs`;
   - VIS-12 `glyphprobe.mjs` on each tier once GAT-7 lands.
