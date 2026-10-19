# Round 5 — districts: environment world + district prop art (env-art)

Owner files: `js/environment.js`, `js/models.js`, `js/materials.js` (unchanged: `MaterialLibrary.sky()` already delegates to
`environment.makeSkyMaterial`, which owns the sky uniforms). Spec: docs/DISTRICTS.md §3, §6.2, §6.3, §7 (data in js/data.js
not touched). Docs: ARCHITECTURE §6.3 (environment implementation note) and §6.4 (models note) updated.
Evidence: `E:/Temp/claude/gate-rush-evidence/r5/env-art/` (`EA/` below).

## Result

All six districts render with their sky, ground, road, buildings, props, weather, light pools and anchored smoke.
District 1 is pixel-identical to the shipped build. Draw calls are unchanged and no program compiles at run time.

| Check | Result | Evidence |
|---|---|---|
| D1 pixel identity (§10.1): environment-only frame, fixed uTime / camera / sun, seed 1001; this tree vs the same tree with the round-4 environment.js + models.js | max channel diff **0** on Low, Medium and High; also 0 after `setDistrict` night → frozen → toxic → sunset, then `setLevel` | `EA/tools/pixid.mjs` (`--roundtrip`), `EA/treeA`, `EA/treeB` |
| D1 placement identity (§10.2): hash of every visible instance matrix / colour / iEmit, seeds 1–5 and 1001–1005 × Low / Medium / High densities, at layout and after 400 m of recycles | 60 / 60 equal to the round-4 environment | `EA/node-identity.txt`, `EA/tools/node/identity.mjs` |
| Edge clearance (§10.11): 6 districts × 5 seeds × 3 densities, non-builtin footprints (random-yaw kinds as circles, per §7.2) | 0 violations of \|x\| − across ≥ 4.5 m | `EA/node-edgeclear.txt` |
| Draw calls, environment only, per district | 19 env objects (17 on Low) in every district. Main pass 28–29 (Medium) and 26–27 (Low). Shadow pass 7, or 5 in Toxic (smokestack and puddle cast no shadow) | `EA/tools/p_calls.js` |
| Draw calls in play (L1 with the district switched live) | main 29–38, shadow 9–11, post 10 (Medium) / 14 (High): within 50 / 20 / 14 | `EA/shots-{low,med,high}/shots.json` |
| Program count over six full 4 s fades with drain → swap → refill (High, road scrolling at 12 m/s) | 58 → 58 programs; `info.memory.geometries` constant (every district geometry uploaded at boot); 0 frames over 40 ms | `EA/tools/p_prog.js` |
| District snap cost | `env.setDistrict(d, 0)` 0.3–1.2 ms; `render.setDistrict` (which forwards to it) 0.2–0.8 ms; re-layout 0.1–0.5 ms | `EA/tools/p_snap.js` |
| Smoke | boot Medium, play L1 / L6 / L11 Medium, L16 High, L26 Low and endless Medium 150 s (rotated into Overcast at 900 m): all CLEAN, 0 page errors, 0 console errors or warnings | `EA/smoke-*` |
| `node --check` (3 files), `node tools/check-imports.js` | OK; 0 errors, 0 warnings | |
| Data validator `TR/tools/validate-districts.mjs js/data.js` | ok | |

Screenshots of every district, all looked at:
- `EA/shots-{med,high,low}/sheet-play.png`: L1 in play, switched live with `render.setDistrict`.
- `sheet-gates.png`: a frozen pair at z −62 and a triple at z −33.
- `sheet-title.png`: the title rig.
- `EA/shots-med/sheet-fade-<id>.png`: six endless-style 4 s fades, at 0.8 / 1.8 / 2.6 / 4.3 / 9 / 16 / 19 s after the call.
- `EA/title-night-nohud.png`: the moon, cirrus, neon and lit windows at the title, with the HUD hidden.

## Changes

### js/models.js
- **The 16 district kinds (§7)**, `buildDistrictGeometries` at :1765:
  - Kinds: barrier :1371, cones, billboard, truck, neon :1486, barrel, container, smokestack, pipe, puddle, burningWreck, dune, rock, snowbank, frozenCar :1709 and pine :1751.
  - They are called from `init()` after `buildStaticGeometries`.
  - Style: low-poly, merged and indexed. Attributes are position, normal, uv and color (linear, itemSize 3), with feet at y = 0.
  - Colours come only from `DISTRICT_PROPS[kind].colors`. The frozen car's base parts use PALETTE, like the environment car.
  - Emissive parts use the excess encoding `1 + lin(hex) × DISTRICT_PROPS[kind].emissive`.
- **Triangles**: 3 728 in total. Per kind: barrier 180, cones 296, billboard 216, truck 396, neon 180, barrel 360, container 204, smokestack 248, pipe 260, puddle 28, burning wreck 356, dune 130, rock 100, snowbank 120, frozen car 532, pine 122.
- **Extents**: every kind fits its data `half` extents and `poseY` heights: truck roof 3.2, burning wreck 1.30, frozen car 1.51 (limit 1.52). See `EA/node-geo.txt`.
- **Helpers**:
  - `mergeKind` :1342 accepts `rgb`, `hex`/`k` or a per-vertex `fn` colour.
  - `indexed()` gives the Polyhedron and Extrude parts a sequential index, so each kind keeps the slot's attribute layout and merges.
  - `colorBy`, `blobDisc` and `hash3` hold shape detail only, with no `Math.random`.
- **Dunes are faceted** (flat normals) so they match the boxy prop style.
- **`setEyeGlow(v)`** :1865 (§6.3) writes to the five zombie classes only. A value set before a class material exists is used when it is created. Boss rigs are untouched.
- **`init()` end** :1858 calls `ctx.render.env.warmDistricts()` (guarded; failures go through `warnOnce`).

### js/environment.js (2 600 lines; the class was rewritten around the districts, District 1 behaviour byte for byte)

**Shaders.** Every edit reduces to the shipped arithmetic at the District 1 values.
- **Sky** (`SKY_FRAG` :525):
  - `uDisc` replaces the disc edge and adds moon mottle; `uCloudCover`; stars (`uStars`, :587); `uSkyLitTh`; `uSkyDip`.
  - Plus `uCloudOff`: the cirrus position is integrated across a drift change, so the clouds never race during a fade.
- **Ground**: light pools on the shoulder (`GROUND_FRAG_EMIT` :667, world-z phase `uGrLampPhase` written in `_sync` :2072).
- **Road**: new `gr:road` program (:691 / :702 / :720):
  - asphalt, dash and edge multipliers;
  - puddles (cover, roughness, darkening);
  - segment-local light pools.
  - Additions: a puddle **horizon reflection** (`uGrWet`, :996 `WET_REFLECT`), and puddle roughness that follows pud³ (see below).
- **Buildings** (:786): `uGrWin` adds or drops lit windows per window cell from the instance seed, with the `_drawWindows` layout and gradient. `uGrSnow` whitens roofs. Material colour is a multiplier; emissive colour and intensity, `uGrDark` and `uGrBounce` follow the district.
- **Lamps and beacons** (:831):
  - Split uniform sets, `uGrEmitGain` and the beacon `uGrBlink`.
  - Plus `uGrUnlit`: an unlit emissive part (unlit ooze, neon, reflector, lens) shows its own dim hue instead of the clamped white. It is 0 in District 1.
- **Weather** (`DUST_VERT` :916 / `DUST_FRAG` :937): one program for every kind.
  - Uniforms: `uFall`, `uSway`, `uFlicker`, `uStreak`, `uSlant`.
  - Rain is drawn as a slanted streak.
  - Blending flips Additive ⇄ Normal; this is not a program key in r170.

**Data resolution** (:963–:1096):
- Every district is resolved once at module load into a flat `Float64Array` (layout `V`) plus per-slot entries (kind, merged layout, weight, tint, frost) and a weather theme.
- `SLOT_CAP` (:976) gives the tree slot 60; every other slot keeps today's capacity.

**API:**
- `setDistrict(d, seconds)` :1525:
  - **Snap**: every uniform, weather theme, skyline columns, lit mode, blink rate and fog near / far; slot geometry swaps; the ring is re-laid only when something changed.
  - **Fade**: theatre clock; a from-snapshot; fog near / far on the same clock (`setFog` takes it over); cirrus continuity.
  - **Drain on fade**: 6 recycles for every slot whose shown kind differs; a slot whose target is the kind it already shows cancels its drain.
- `_stepDistrict` :1852: lerp the mirror and apply it (`_applyVec` :1905).
  - The swap dip at 0.45–0.55 swaps the weather theme and `uCols` at the trough.
  - At 0.5 it applies `lamps.lit` and the blink rate (`_relightLamps` :2046). The rate switches rather than lerps, because a lerped rate sweeps `rate·uTime` through many blink cycles.
- `districtWarmList(out)` :1583 returns every (slot mesh, alternative geometry) pair; render.warmup now draws them.
- `warmDistricts()` :1601 parks 16 hidden `InstancedMesh` proxies, each sharing its slot's material, depth material and instance buffers.
  - They draw nothing.
  - Every "draw each renderable once" pass creates their VAOs: render.warmup at boot, and `_warmHiddenChunked` after a tier change (the Low → shadows case included).
- `get district` :1471.
- `applyQuality` :1637 writes fog far × farScale (into a running lerp) and dust drawRange × weather density.
- A district can be passed as an object, a 0-based index or an id (as `render.setDistrict` accepts).

**Prop slots:**
- **Adoption**: `_adopt` :1972 builds view geometries over `ctx.models.geo`. They share models' attributes and index and are never mutated or disposed here. The emissive slots add their shared `iEmit`.
- **Fallback**: a kind with no geometry falls back to the slot's built-in kind.
- **Swap**: `_swapSlot` :2015 sets stride and `count` (6 × per) and `castShadow`, and hides the buffer. `_onRecycle` :2034 counts the drain down, swaps, then re-places the segments beyond −100 m once.
- **Placement** (`_placeSlot` :2190): built-in kinds keep their routines with weight, tint, far, storeys, broken and burnt overrides; at weight 1 they reduce exactly to today's.
  - Lamps (:2236): layout 'all' or 'mixed', lit 'all' / 'mixed' / 'none', and upright / seeded-lit bits.
  - New kinds use the §7.2 placers `_genChain` :2439, `_genScatter` :2484 and `_genCars` :2519: count or chance gates, edge clearance, poses, paint / frost / neutral colour, `emitOn`.
  - Pending (draining) slots run the target placer with writes suppressed: the same RNG draws, and their instances stay hidden.
  - Anchor records are kept even in dry runs, so the smoke placer `_placeSmoke` :2589 consumes the same stream either way. Columns are hidden while the anchor slot is pending.

## Art and behaviour decisions beyond the spec text

1. **Puddles reflect the sky's horizon colour.** The term is `horizon × 0.5 × Schlick fresnel × puddle mask`. With the spec formula alone, the puddles read as black potholes in Night and Overcast; the darkened, low-roughness patches lose the broad specular sheen away from the sun's mirror point. They now read as wet patches. It is a no-op in District 1 (cover 0).
2. **Puddle roughness follows pud³.** With the linear mix, a low sun in front (Toxic, Frozen) drew a bright mid-roughness glint ring around every puddle.
3. **`uGrUnlit`.** The 30 % of barrels that are unlit showed a white ooze disc, because the diffuse is clamped to 1 on excess-encoded vertices.
4. **Container paint.** The data says "paint: one per instance", but §7.2's scatter placer has no paint rule. The cars rule is applied in scatter; before this, containers rendered white.
5. **Lamps relight whenever the slot still shows lamps**, whatever the target kind. §3.3 says "when the lamppost kind is unchanged" but also "Night → Toxic switches them off". The second rule needs the first one widened, and Toxic's `lamps.lit: 'none'` exists for exactly that. Verified: the Night lamps go dark at 0.5 of the Night → Toxic fade (`EA/shots-med/sheet-fade-toxic.png`).
6. **Neon tubes are 0.08 m** (spec 0.06): they kept some width at 9 m beside the road. The barrel cluster's tipped drum leans on two upright drums so that all of it fits inside r 0.9 m.

## needsOtherGroup

- **level / levelgen.** The first *generated* level start takes 63–73 ms of CPU inside `level.start(6)`, on Medium and High. That is over the §1.8 hitch budget. L11 takes 21–26 ms; a repeat L7 takes 11 ms. The district part is ≤ 2 ms (snap plus re-layout), so the cost is level generation or first-run JIT (`EA/tools/p_hitch.js`, `p_snap.js`).
- **docs (DISTRICTS.md, spec owner).** Three amendments:
  - §3.3: the relight rule should read "re-applied while the lamppost slot still shows lamps" (decision 5).
  - §7.2 scatter: add the paint rule for kinds with `colors.paint` (decision 4).
  - §6.2: list `uCloudOff`, `uGrUnlit` and `uGrWet` (decisions 1–3). They are already in ARCHITECTURE §6.3.
- **data owner.** `WET_REFLECT` is a module constant (`DATA-MISSING`); `DISTRICT_RULES.puddleReflect` would be its home.
- **Readability QA (§10.3 full-dressing pass).** Not run here.
  - Decision 1 makes Overcast and Night puddles behind the gate plates lighter than the spec formula alone would.
  - The Night light pools are implemented exactly as specified (`road.pools` intensity 1.2, pow 3). They show as +≈ 30 sRGB levels of red under the lamp heads: subtle on screen. Any change goes through the §4.4 fallback ladder, which only lowers it.
- **art direction.**
  - Toxic smokestacks stand 15–26 m out with plumes from 20.5 m. That is above the portrait gameplay view, so the plumes show only far away and on the title rig.
  - If they should read in play, the data band or `smokeY` would have to change.
- **perf QA.** The §10.12 weather cost (throttle profile, `--level 6` vs `--level 1`) was not measured here. Rain fills up to 18 % of a Medium frame, per the spec.

Every test output is under `E:/Temp/claude/gate-rush-evidence/r5/env-art/`. The node test scripts are archived in `tools/node/` and run from `<root>/tools/_envart/`.
