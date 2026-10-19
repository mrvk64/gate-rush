# Round 5b: boss-rig draw calls

Owner: `js/models.js`, `js/boss.js`. Input: `r5-release.md` §4.2 / §7 item 1. In 1.2.0, one endless frame drew **53 main-pass draws** (budget 50). It was a Hulk mini-boss fight at rank 0, with two troops, five zombie types and a live gate event. The Hulk rig alone was 7 of those draws: core, four plates, skin and eyes.

**Result: every boss rig now draws in 3 main-pass draws.** The Colossus shield adds 1 while it is up, as before.

| Archetype | Main draws per frame, before → after | Shadow draws, before → after |
|---|---|---|
| Hulk | 7 → **3** | 1 → 1 |
| Spitter Queen | 8 → **3** | 1 → 1 |
| Juggernaut | 7 → **3** | 1 → 1 |
| Colossus / Colossus Prime | 9 → **3** (shield up: 10 → **4**) | 1 → 1 |
| Hulk Twins | 14 → **6** | 2 → 2 |

- **The 1.2.0 overrun.** That frame was 53 = 46 + 7 Hulk draws. With the same content it is now **49** (≤ 50). The composition rebuilt on purpose drops by exactly 4 (§3.3).
- **The look is unchanged.**
  - Each archetype was compared in 10–11 fixed poses: walk, roar, hit flash, rage glow, plate fly-off, shield, and death collapse.
  - With every other scene object hidden, before and after renders match pixel for pixel, apart from 1–4 stray edge pixels per frame.
  - The one larger difference is in the Hulk Twins' roar frame. It is sub-pixel rasterisation noise: moving the old rig by 0.2 mm changes that frame twice as much (§4).
- **Programs stay flat:**
  - 58 on High and on Medium, 42 on Low;
  - the same before and after, at the title, in play and after every boss pose.
- **Shadow draws are unchanged.** The body was already the rig's only shadow caster. Plates, chains, eyes and core never cast, and they still do not.
- **Smoke runs.**
  - All 14 smoke runs are CLEAN.
  - The end states match between before and after.
  - No frame went over 50 ms.

The evidence root is `E:/Temp/claude/gate-rush-evidence/r5b/boss-draws/`, written `EV/` below.

## 1. What changed

### 1.1 `js/models.js`: `skinRig` / `BossRigFactory.build`

Since CHR-11 the rig's seven joints were Bones of one `SkinnedMesh` `'skin'`. This pass extends the same idea to everything else on the rig.

**Three skinned draws per rig, all bound to one Skeleton.**

| Draw | Material | Contents | Shadow |
|---|---|---|---|
| `'skin'` | body (`boss.body`, standard, vertex colours, skin roughness / metalness) | legs, torso, arms, head, jaw | casts (`SHADOW_PARTS`) |
| `'armour'` **(new)** | `boss.armour`: standard, vertex colours, **metal** roughness 0.5 / metalness 0.6, white × the `PALETTE.boss.plates` vertex colour | `plate0`–`plate3` and the Colossus `chain0`–`chain1` | no (as before) |
| `'glow'` (now one draw, replacing `'eyes'`, `'glow'` and the `core` mesh) | `boss.glow`: HDR basic, `toneMapped: false`, vertex colours, plus one `uGlowCol[3]` multiply in the fragment shader, picked by a per-vertex `aGlow`: 0 eyes, 1 sacs, 2 core | eyes, the Spitter Queen's sacs, the core sphere | no (as before) |

**The core, the plates and the chains are now Bones.**
- Each keeps the same name, parent, rest position, rotation and scale as the mesh it replaces. `boneFor()` swaps it in place in the parent's child list.
- Each geometry is baked in rig space at the rest pose and bound rigidly (weight 1) to its node's bone.

So everything `boss.js` writes still moves exactly what it moved before:
- the joints' `rotation.x` / `position.y`;
- the core's pulsing `scale`;
- the chains' sway;
- `Object3D.attach` of a detached plate to the scene, then its world-space flight.

A plate whose bone is attached to the scene still deforms its vertices correctly. With the default `'attached'` bind mode, a skinned vertex's world position is `boneWorld · boneInverse · bindMatrix · v`, which does not depend on where the skinned mesh itself sits.

**Colours.** The old glow colours are reproduced exactly:
- eyes and sacs had a scalar `PALETTE.boss.eyesEmissive` material colour, now `uGlowCol[0]` and `[1]`;
- the core was an `hdrBasic(core, coreEmissive)` linear colour, now `uGlowCol[2]`, on white core vertex colours.

The sac test that `boss.js` used to make per mesh is now made per piece at build time. The head glow is group 1 (sacs) only when every vertex is the acid-sac colour (`isSacGeometry`, tolerance 0.02 as before). Every other part's glow is group 1, and the head glow otherwise is group 0. That is the same classification as before.

**Draw order.**
- `'armour'` is added to the rig before `'skin'`.
- `boss.js` clones the rig's standard materials in traversal order, so the armour clone gets the lower material id.
- three's opaque sort is by material id before depth, so the plates still draw before the body, as the separate plate meshes did.
- Where a plate edge meets the chest at equal depth, the body still wins the LessEqual depth test.

**Twins share geometry.**
- `BossRigFactory._geo[archetype]` caches the three merged geometries.
- The second Hulk rig (the twins) reuses them: same bone order and same rest pose.
- That saves the merge work and one copy of the GPU buffers.

**Vertex counts are unchanged.** For example, the Hulk was core 165 + plates 4 × 144 + skin 1 877 + eyes 48 = 2 666. It is now armour 576 + skin 1 877 + glow 213 = 2 666.

**Build cost** (`EV/tools/buildtime.mjs`, unthrottled, median of 7): Hulk 3.2 → 2.6 ms, Colossus 1.6 → 1.2 ms. These are repeat builds, which take the cache path. A first build does the same merge work as before.

**`animateRig`** (the optional helper; `boss.js` does not use it) follows the same conventions:
- it hides a plate by scale 0;
- it copies the body emissive to the armour material.

**Header and `buildBossRig` comments.** They describe the new tree and the `userData.rig` fields:
- new: `armourMaterial`, `skin`, `armour`, `glow`, `skeleton`;
- changed: `coreMaterial` now points to the glow material, because the core is glow group 2.

### 1.2 `js/boss.js`: `_buildRigRecord`, `_restoreRig`, `_renderUnit`

- **Plates.** A plate is collected when it is a Mesh *or* a Bone named `plate0`–`plate3`. After its 1.3 s flight it is hidden with `visible = false` **and** `scale 0`, because a Bone has no visibility of its own. `_restoreRig` already restored the scale and the parent (`plateParent.attach`).
- **Glow.** The merged glow material is recognised by `userData.glowCols`. It is **not cloned**: it is already per rig, and a clone would drop its `onBeforeCompile`. `_renderUnit` writes its three group colours with exactly the formulas the eye, sac and core materials used:
  - eyes: rage lerp toward `PALETTE.boss.rage × gk`;
  - sacs: the same, × `sacK · SAC_GAIN`, breathing at `sacPulseHz`;
  - core: rage lerp toward `rage × coreEmissive·(0.8 + 0.4·pulse)`.
  
  `_restoreRig` puts them back to their rest values.
- **Hit flash and rage emissive.** No change: they still go to every cloned standard material of the rig, now body + armour, as body + plates before.
- **Kept for other rigs.** The old per-material glow and core paths remain for a rig built without the merge: the fallback rig and stub harnesses.
- **No per-frame allocation.** `Vector3.set` on preallocated vectors only. `Float32Array.from` runs once, at record build.
- **Rules.** ARCH §14 holds: guarded lookups, no `console.log`, no `Math.random`.

## 2. Method

**Two trees.** `EV/tree-before/` and `EV/tree-after/` are snapshots of the project.
- They are identical except for the two files: md5s in `EV/md5-tree-{before,after}.txt`.
- The originals are in `EV/src-before/js/`.
- Every comparison ran before then after, sequentially, on the same host (i7-8700K, RX 6800, headless Chrome on the GPU, ANGLE D3D11).

**Measurements:**
1. **Deterministic rig probe** (`EV/tools/rigprobe.mjs`). It runs one fresh page per archetype at High, phone viewport.
   - It boots, then starts the level the archetype appears at: L1 Hulk, L5 Queen, L10 Juggernaut, L15 Colossus, L17 Twins, L20 Prime.
   - It resets zombies, gates, pickups, fx and weapons, then stops the engine loop.
   - It spawns the boss with `mini: true` at z −14 and drives each frame by hand at fixed clocks.
   - Frames: baseline (no boss), walk, roar (arms 0.6, jaw 1, lean 0.5), hit flash, rage (×2), plates detached (`_detachPlates`, then 24 frames of flight at 1/60 s with `rngFx` reseeded), shield (Colossus), and death at 40 % and 90 % of the collapse.
   - Each frame records `render.callStats` (the `?debug=1` overlay numbers), `renderer.info.programs`, and the draw list (the `renderBufferDirect` hook from `tools/smoke.js`).
   - It also records two images: the full canvas, and an *isolated* render with every non-boss scene object hidden (lights kept). The isolated render does not depend on how far the road had scrolled, so before and after compare pixel for pixel.
   - The probe is exactly repeatable: two before runs are byte-identical (`EV/pixdiff-noise/`).
2. **Smoke matrix** (`EV/tools/matrix.sh m1`). It ran 14 runs, before and after interleaved:
   - `node tools/smoke.js --level L --boss --after "g.squad.setCount(g.level.script.eBoss,'debug')"`, with E = the level's own E_boss, for L1, 5, 10, 15, 17 and 20;
   - and `--endless --seconds 200`.
3. **The overrun composition rebuilt on purpose** (`EV/tools/worstframe.mjs`, 3 × before / after).
   - Content: L6 Overcast, a Hulk mini-boss, medic + drone, a 27-zombie horde of all five types, and a live gate event.
   - The engine runs normally for 6 s, and the peak main frame keeps its object list.
4. **Programs on every tier.** The probe ran for Hulk and Colossus at `quality=low` and `med`, before and after.

## 3. Draw calls

### 3.1 Rig probe (High, `EV/probe-before/`, `EV/probe-final/`)

Values are main / shadow draws of the frame minus the boss-free baseline of the same page, with the draw list of the boss's own objects.

| Archetype | Before (every pose) | After (every pose) | Boss objects before → after |
|---|---|---|---|
| Hulk | +7 / +1 | **+3 / +1** | core, plate0–3, skin, eyes → glow, armour, skin |
| Spitter Queen | +8 / +1 | **+3 / +1** | core, plate0–3, skin, eyes, glow → glow, armour, skin |
| Juggernaut | +7 / +1 | **+3 / +1** | as the Hulk |
| Colossus | +9 / +1; shield +10 / +1 | **+3 / +1; shield +4 / +1** | core, plate0–3, chain0–1, skin, eyes (+ shield) → glow, armour, skin (+ shield) |
| Hulk Twins | +14 / +2 | **+6 / +2** | 2 × (core, plate0–3, skin, eyes) → 2 × (glow, armour, skin) |
| Colossus Prime | +9 / +1; shield +10 / +1 | **+3 / +1; shield +4 / +1** | as the Colossus |

- The plates-detached and death frames show one more draw in both trees: the plate sparks (an fx particle draw).
- The shield frame's extra draw beyond the boss's own is the fx gauge, in both trees.
- Low and Medium give the same boss deltas (`EV/probe-{low,med}-{before,after}/`). On Low there is no shadow pass.

### 3.2 Smoke matrix (`EV/m1/`, `EV/m1/summary.json`)

Columns:
- **callsMax main**: the per-frame maximum while playing, from `report.callsMax`.
- **Boss-alive timeline**: the `report.timeline` samples (the overlay's `callsMain` / `callsShadow`, every 2 s) taken while the boss is alive.
- **Boss draws in the peak frame**: from `report.callsPeak`.

| Run | Boss | callsMax main, before → after | Boss-alive timeline main (max / median), before → after | Shadow max, before → after | Boss draws in the peak frame, before → after | End, before / after |
|---|---|---|---|---|---|---|
| L1 | Hulk | 35 → 34 | 35 / 33 → 34 / 31 | 12 → 12 | 7 → 3 | ★★★ 116 / ★★★ 116 |
| L5 | Spitter Queen | 39 → **34** | 39 / 34 → 34 / 32 | 11 → 11 | 8 → 3 | ★★☆ 135 / ★★☆ 135 |
| L10 | Juggernaut | 38 → **34** | 38 / 33 → 34 / 30 | 12 → 12 | 7 → 3 | ★★☆ 188 / ★★☆ 187 |
| L15 | Colossus | 40 → **34** | 39 / 34 → 34 / 30 | 11 → 11 | 10 → 4 (shield up) | ★★☆ 309 / ★★☆ 309 |
| L17 | Hulk Twins | 44 → **37** | 42 / 39 → 37 / 32 | 11 → 11 | 14 → 6 | ★★☆ 290 / ★★☆ 287 |
| L20 | Colossus Prime | 40 → **34** | 40 / 34 → 34 / 30 | 9 → 9 | 9 → 3 | ★★★ 480 / ★★★ 482 |
| endless 200 s | Hulk mini (Overcast) | sunset 41 → 42, **overcast 49 → 42** | 48 / 41 → 39 / 37 | 15 → 15 | 7 → — (the after peak frame has no boss) | both reach Overcast at 900 m |

Every run is **CLEAN**:
- 0 page errors and 0 console errors;
- programs 58–58 while playing;
- p99 7.1–7.2 ms;
- 0 frames over 50 ms;
- worst frame 14–34.8 ms before and 20.7–27.9 ms after.

The squad counts differ by up to 3 in either direction, which is bot variance; the stars are identical.

**The before endless run** peaked at 49 in Overcast during the Hulk fight, with one troop (medic) this time; the release run had two. Its draw list is the §4.2 composition minus one troop, the globs and one gate draw, with all 7 Hulk draws. **The after endless run's** worst frame with the boss alive was 39.

### 3.3 The overrun composition (`EV/worst/`)

Content: L6 Overcast, a Hulk mini-boss, medic and drone, all five zombie types (27), and a live gate event. The peak main frame over 6 s:

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Before | 48 | 48 | 48 |
| After | 44 | 45 | 44 |

- **Shadow** is 17 in every run.
- **Programs** stay 58.
- **What the peak frames contain.** The draw lists (`peak.mainObjects`) are the same group for group, except the boss: core, plate0–3, skin and eyes before; glow, armour and skin after. Run 2 after also caught the floaters.
- **The release's 53-draw frame** had on top of this the globs, a fifth gate draw, the floaters and a pickup. Its non-boss part is unchanged by this work, so that frame is now **53 − 4 = 49**.

## 4. Look (`EV/sheets/`, `EV/pixdiff-final/`, `EV/pixdiff-final.txt`)

**Contact sheets.** `EV/sheets/<archetype>-iso.png` (isolated) and `<archetype>.png` (full scene) put before on the top row and after on the bottom row. Columns: walk, roar, hit, rage, plates 0 s, plates 0.4 s, death 40 %, death 90 %, and the shield.

Each of the following is the same in both trees:
- the walk swing and the roar pose (arms, jaw, head-back);
- the hit-flash green blink on body *and* plates;
- the rage tint, plus the eyes and core lerping to red;
- the Queen's sac colour;
- the four plates flying off with their sparks;
- the Colossus chains and shield bubble;
- the collapse.

**Pixel comparison of the isolated renders** (998 809 px each; differing pixels at max channel delta > 8):

| Archetype | Worst frame |
|---|---|
| Hulk | 2 px |
| Spitter Queen | 4 px |
| Juggernaut | 1 px |
| Colossus | 2 px |
| Colossus Prime | 1 px |
| Hulk Twins (all frames but roar) | 1 px |
| **Hulk Twins, roar** | **907 px** (126 px > 32) |

- Baselines (no boss) match in every archetype: 0 px.
- **The Hulk Twins' roar frame, traced:**
  - It disappears when the plates are hidden in both trees (`EV/pixdiff-hide-plat/`: 2 px). It does not disappear when the glow is hidden.
  - The core light's position and intensity, and every core position, are identical to 5 decimals (`probe.json` `light` / `cores`).
  - The pixels are one edge-on face of the right upper plate. It sits within centimetres of the core point light (which is 1 m inside the torso), so a sub-pixel change in its coverage moves an HDR-bright sliver, and bloom spreads it.
  - Moving the **old** rig by 0.2 mm changes that frame by 1 938 px > 8, and every other frame by 230–340 px (`EV/pixdiff-gnudge/`). Moving the light by 1 mm changes nothing (`EV/pixdiff-nudge/`).
  - So the difference is float-precision noise of the skinned transform, not a look change.
- **Draw order.** Drawing the armour after the body (first candidate, `EV/probe-after-rc1/`) gave the same numbers. The final order (armour first) matches the old order regardless (§1.1).

## 5. Programs

| Tier | Title | Playing | After every boss pose / the whole fight | Before |
|---|---|---|---|---|
| High | 58 | 58 | 58 (smoke: 58–58 in all 14 runs) | 58 |
| Medium | 58 | 58 | 58 | 58 |
| Low | 42 | 42 | 42 | 42 |

**Why the count does not move:**
- The armour uses the body's program: skinned standard with vertex colours; roughness and metalness are uniforms.
- The glow's `gr:bossglow` program replaces the old skinned basic program that only the eyes and glow meshes used.
- The core's old `hdrBasic` program is shared with fx, so it stays in use.

`render.warmup` compiles the glow program at boot, because the pre-compile walks the hidden rigs. No program is compiled at run time.

## 6. Notes, limits and requests

1. **Detached plates go with the rig's visibility.**
   - Before, a plate in mid-flight when its boss finished collapsing (`U_GONE`) froze in the air, unanimated, until the unit was released.
   - Now it is hidden with the rig: it is a bone of the rig's armour draw.
   - This needs a kill within 1.3 s of the phase-2 detach *plus* the 1.8 s collapse. It is cosmetic, and arguably better.
2. **Bones have no visibility of their own.** Any future code that hides a plate, chain or the core must use scale 0. `visible` stays as the logical flag. Both files say this at the point of use.
3. **Shadows are unchanged on purpose.**
   - Merging the armour into the body draw (2 draws per rig) would need per-vertex roughness and metalness, through a map or an attribute.
   - It would also make the plates cast shadows: flying plates would throw shadows they never threw.
   - So the plates stay a separate draw.
4. **needsOtherGroup (docs and release; files not owned here):**
   - **`docs/ARCHITECTURE.md` §6.4** (lines 438–441, the CHR-11 comment under `buildBossRig`). Replace "SkinnedMeshes 'eyes' … and 'glow' … core, plate0–3, chain0–1 and shield stay plain Meshes … Draws per rig: Hulk / Juggernaut 7, Queen 8, Colossus 10" with:
     - three SkinnedMeshes: `'skin'` (casts), `'armour'` (plates + chains) and `'glow'` (eyes, sacs, core; `uGlowCol[aGlow]`);
     - core, plates and chains are Bones, and a plate hides by scale 0;
     - the shield stays a Mesh;
     - 3 draws per rig (+1 shield).
   - **`docs/ARCHITECTURE.md`** line 1111 (the scene tree). It now reads "Bones + ONE SkinnedMesh 'skin' + 'eyes' / 'glow' SkinnedMeshes + core, plates, chains, shield Meshes (Hulk 7 draws, Queen 8, Colossus 10)". It should name the skin, armour and glow SkinnedMeshes plus the shield Mesh, with 3 draws per rig, Hulk Twins 6, and Colossus 4 while the shield is up.
   - **§9.1 draw budget.** "boss ≤ 4" now holds for every archetype except the Twins (6). The r5-release §7 item 1 fix option "draw the Hulk and Colossus plates as one instanced draw (−3)" is done, and gives −4 / −6 / −5 with the glow merge. The troop options in that item remain.
   - **Release.** `dist/` and `gate-rush-dist.zip` still hold the 1.2.0 `models.js` and `boss.js`. The next release must rebuild them and apply the sw `VERSION` rule. `tools/callsites.js` needs no run: no cross-module member was added (`boss.js` reads the glow material's `userData`, which `models.js` builds for it).
5. **Not re-measured here:** the 4× CPU throttle and the boot timeline.
   - The rig build is cheaper, or the same on a first build.
   - Per frame, the CPU does less: 4–8 fewer render items per rig, and one skeleton update with 14 bones instead of 7.

## 7. Files changed

| File | Change |
|---|---|
| `js/models.js` | `makeBossGlowMaterial`, `isSacGeometry` and `boneFor` added; `skinRig` makes three draws (skin, armour, glow) with core, plates and chains as Bones, armour added first, and a per-archetype geometry cache; `BossRigFactory`: the armour material, the glow material, the core placeholder, `_geo`; rig-tree and `buildBossRig` comments; `animateRig` hides plates by scale and copies the emissive to the armour |
| `js/boss.js` | Plates collected as Meshes or Bones, hidden by scale 0 after the flight; the merged glow material recognised (not cloned), its three group colours written in `_renderUnit` and restored in `_restoreRig`; the `SHADOW_PARTS` comment |
| `docs/build/r5b-boss-draws.md` | this report |

Static checks:
- `node --check` passes on both files;
- `node tools/check-imports.js` reports 0 errors and 0 warnings;
- `grep console.log / Math.random` finds one comment only (models.js, unchanged).

## Evidence index (`EV/` = `E:/Temp/claude/gate-rush-evidence/r5b/boss-draws/`)

| Path | Contents |
|---|---|
| `src-before/js/`, `src-before-md5.txt`, `tree-before/`, `tree-after/`, `md5-tree-*.txt` | the original files and the two snapshot trees (`node_modules` is a junction to the project's) |
| `tools/rigprobe.mjs`, `pixdiff.mjs`, `looksheet.mjs`, `sheet.mjs`, `worstframe.mjs`, `buildtime.mjs`, `matrix.sh`, `summ.cjs`, `rep2.cjs`, `vlib.mjs`, `png.mjs` | the tools; `rep2.cjs` is the anchor-checked editor used for every source edit |
| `tools/edits/models/`, `tools/edits/models2/`, `tools/edits/boss/` | every source edit as old / new anchor pairs |
| `probe-before/`, `probe-final/` (`probe-after-rc1/` = before the draw-order fix), `probe-*.log` | per-archetype probe frames (`<pose>.png`, `<pose>-iso.png`) and `probe.json` (calls, draw lists, programs) |
| `probe-{low,med}-{before,after}/` | Low and Medium tiers |
| `pixdiff-final/`, `pixdiff-final.txt`, `pixdiff-noise/`, `pixdiff-hide-{plat,core}/`, `pixdiff-nudge/`, `pixdiff-gnudge/`, `probe-tw-*`, `probe-hide-*` | the pixel comparisons and the Hulk Twins roar trace (§4) |
| `sheets/` | before / after contact sheets per archetype |
| `m1/`, `m1.log`, `m1/summary.json` | the smoke matrix (reports and screenshots per run) |
| `worst/` | the overrun composition, 3 × before / after |
