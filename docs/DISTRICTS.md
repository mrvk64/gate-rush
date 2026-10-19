# GATE RUSH — Visual Districts (DISTRICTS.md)

Status: IMPLEMENTED, round 5 (art direction + tech art), revised by the round-5 tech-art / UX review (§12 lists every change and why) and amended by the round-5 integration (§13) and the round-5 art review (§14). `js/data.js` exports `DISTRICTS`, `DISTRICT_PROPS`, `DISTRICT_RULES`, `districtForLevel(L)` and `districtForChunk(D)`; render.js, environment.js, models.js, level.js, ui.js, fx.js, index.html and css implement them (reports: `docs/build/r5-render-core.md`, `r5-env-art.md`, `r5-level-balance.md`, `r5-ui-sw.md`, `r5-integrate.md`). This document is the contract for those modules. Ownership follows ARCHITECTURE §1.

Evidence lives under `E:/Temp/claude/gate-rush-evidence/r5/artdir/`, written `EV/` below. It has the live prototype screenshots, the measured readability tables and the tools (§11). The review's independent checks and the current validator live under `E:/Temp/claude/gate-rush-evidence/r5/techart-review/`, written `TR/` below.

Screenshots of the six districts, with their lighting, fog, sky, grade, road and building values applied live to the shipped build on Medium, High and Low: `EV/districts-med.png`, `EV/districts-high.png`, `EV/districts-low.png`, `EV/districts-title-med.png`, `EV/districts-zombies-med.png`. They predate the review's data changes (§12) and show none of the new dressing (props, weather shapes, stars, light pools, puddles, anchored smoke). The full-dressing pass of §10.3 is the readability authority once the dressing exists.

---

## 0. At a glance

| # | District | Campaign | Endless chunks | Mood | Fog (on screen) | Weather | Signature props |
|---|---|---|---|---|---|---|---|
| 1 | SUNSET BOULEVARD | L1–5 (L31–35 …) | 1–3, 19–21 … | The ad, unchanged: orange dusk, teal shadows | #D8744A (#E68544) | dust motes | barricades, sandbags, wrecked cars, dead trees, rubble, lamps, smoke |
| 2 | OVERCAST HIGHWAY | L6–10 | 4–6 | Grey-blue midday under a cloud deck, wet dark asphalt with a soft sheen | #56625E (#566963) | light rain streaks | concrete highway barriers, traffic cones, billboards, overturned trucks, intact (unlit) highway lamps, few buildings |
| 3 | NIGHT CITY | L11–15 | 7–9 | Navy night, sodium streetlights with light pools on the road, lit windows, neon (moon and stars dress the title rig, §2.1) | #1F2237 (#0E122C) | falling ash | neon blade signs, streetlights all on, dense lit towers |
| 4 | TOXIC INDUSTRIAL | L16–20 | 10–12 | Sickly yellow-olive smog, chemical glow | #6E6A2E (#79740C) | drifting pale spores | chemical barrels with glowing ooze, shipping containers, smokestacks with plumes, pipe racks, glowing puddles |
| 5 | ASH WASTELAND | L21–25 | 13–15 | Blood-red sky over grey-black ash land, fires | #4A403C (#42342E) | rising embers | burning wrecks (ember glow + fire plume), dunes, rocks, charred trees, dead lamps |
| 6 | FROZEN OUTSKIRTS | L26–30 | 16–18 | Pale blue-white sky, snowfields, cold haze | #909A98 (#9CA6A4) | snow | snowbanks, pines, frozen cars, snow roofs, barricades |

The "on screen" colour is the fog after ACES, exposure, grade and sRGB, which is what the player sees at the horizon.

**What the camera actually sees of the sky.** The portrait preset (vertical FOV ≈ 55° on 390 × 844, pitch −18.8°) shows the sky up to +8.7° above the horizon; the landscape preset up to +2.9°. The top ≈ 60–130 CSS px of that band is HUD. In gameplay the sky is therefore the horizon band, the skyline silhouettes (≤ 4.9°) and the fog blend; sun / moon discs above ≈ 6°, the zenith colours and the stars are title-rig dressing (title view: up to +12.8°). Far gates (z −70) sit 4.3° *below* the horizon and are always seen against fog, never against sky.

---

## 1. Binding rules

1. **District 1 is the shipped look.** `DISTRICTS[0]` reads every value from `WORLD`, `RENDER` and `PALETTE`, so L1–5 cannot drift. The sky-shader literals that become uniforms (disc edge 0.9995 / 0.9998, skyline threshold 0.965) and the roof-snow colour (unused at amount 0) carry literal values (§6.2). Every shader edit below must reduce to today's output at the District 1 values; §10 lists the identity tests.
2. **The gates never change.** `GATE_RULES.colors`, the gate shaders, `GATE_FOG_CAP`, `PANEL_*` and `PLATE_*` stay as they are. Where a district's fog fought a gate tint, the district was changed (§4.5). (The round-5 art review made three gate-wide legibility fixes in materials.js. They apply in every district, the ad included, and leave every colour unchanged: the ring-gauge fill stays under the bloom threshold, item lanes get a near-black icon plate, and `PLATE_ALPHA` goes 0 → 0.6; §14.)
3. **Values that are fixed across districts on purpose:**
   - `bloom.threshold` equals `RENDER.bloom.threshold` (0.85). The value glyph's emissive 0.82 sits just under it (GAT-7). The count-label halo ceiling in fx is computed from it.
   - `grade.saturation` is at least 1.12, because hue is a gate-type cue. The mood comes from the palette, never from desaturation.
   - `fog.near` is at least 38, so the 36 px gate at z = −26 (view depth 37.4 m) stays unfogged.
   - `fog.farScale` is between 0.95 and 1.05, so zombies at the 70 m spawn line keep their warning distance.
   - The road stays dark asphalt in every district, so the count label and the zombies read against it.
   - The shoulder colour (`ground.shoulder`) stays mid-dark, because the gates' outer frame posts are seen against it. GROUND_FRAG blends shoulder → `ground.ground` across |x| 5.0 → 7.2 m (± 0.6 m noise), so the beyond-the-ditch colour is already ≈ 18 % present at |x| 5.7 (where the view ray past the top of an outer post at the 36 px point lands) and 50 % at |x| 6.1. The glyph plates see |x| ≤ 4.5 (gutter / shoulder) at every distance. Frozen's white `ground.ground` is the case this bounds; its frames were measured with this blend (§4.4). Do not move the bands per district.
   - `sun.offset` is a direction and a distance: its azimuth stays within ±31° of −z, and its length keeps the shadow camera's near plane behind z ≈ −23 m (§6.1 shadow box), so shadows reach as far up the road as in District 1 (validator, §10.4).
   - Weather never outshines the value glyph (§2, weather rule).
   - No non-builtin prop footprint, and no prop glow, comes nearer than `DISTRICT_RULES.edgeClearX` (4.5 m) to the road centre line (§7.2). The lanes and the curb (|x| ≤ 4.3) only ever show gates, zombies, pickups, the squad and their effects.
4. **Readability floors (§4.3)** hold for every district, on Low, Medium and High, at 17, 29 and 36 px. They are measured on real pixels in the engine, in two passes: bare (dressing hidden, the regression baseline of §4.4) and full dressing (props, weather, smoke, light pools, puddles and stars on; §10.3).
5. **Zero extra draw calls.** The environment keeps its 8 prop InstancedMeshes, plus the manhole and curbs. Each district maps the 8 slots to 8 kinds. A slot swaps its geometry, never its material. Weather re-themes the one `env.dust` Points object.
6. **No new shader programs.** Every district difference is a uniform, a geometry, a projection matrix or per-instance data. A swapped geometry keeps the slot's attribute layout, so no program key changes:
   - position, normal, uv and color (itemSize 3), plus iEmit on emissive slots;
   - no uv1, tangent or morph attributes.

   Weather blending flips between Additive and Normal on a transparent material, which is not a program key in r170 (`getParameters`: `opaque = transparent === false && blending === NormalBlending && …`, false either way; `premultipliedAlpha` stays false). Fog colour / near / far, light colour / intensity / direction, exposure, roughness, material colours and the shadow camera's projection are uniform or matrix updates. What would recompile — and is therefore never done per district — is switching the fog type (Fog ⇄ FogExp2), adding, removing or hiding a light (the two point lights stay at intensity 0), toggling a light's `castShadow`, or changing `material.fog`, `vertexColors`, a map's presence, `defines`, or a geometry's uv1 / tangent / morph attributes. A slot mesh's `castShadow` (an object flag, §7.2) is not a program key. Every shader edit is compiled once at boot, as today.
7. **Allocation-free fades.** Every district's linear colours and scalars are precomputed into typed arrays at init. A fade writes only into existing uniform values and the preallocated current-state mirror (§6.1).
8. **Hitch budget.** No frame over 50 ms at level start or during an endless cross-fade on this machine. Every district geometry is uploaded and drawn once at boot (§3.6).

---

## 2. District values (`js/data.js`)

These tables mirror `js/data.js` (regenerate with `EV/tools/doc-tables.mjs` after updating it for the §12 schema changes; until then they are hand-maintained). Colours are sRGB hex; gains and intensities are linear.

**Sky dome (env.sky uniforms)**

| | 1 SUNSET BOULEVARD | 2 OVERCAST HIGHWAY | 3 NIGHT CITY | 4 TOXIC INDUSTRIAL | 5 ASH WASTELAND | 6 FROZEN OUTSKIRTS |
|---|---|---|---|---|---|---|
| zenith / upper | #182544 / #5B3A6E | #3C4A58 / #6A7A8A | #03050E / #0A1230 | #1E2614 / #4A5428 | #140606 / #3A0E0C | #5C7EA4 / #9CB6D0 |
| horizon / glow | #FF7A2F / #FFC46B | #93A2AE / #8C9A9E | #1A2450 / #2E3460 | #A8AC48 / #C8C878 | #A8281E / #D85A2A | #D4E2EE / #E8F0F6 |
| stops (dome y: zenith, upper, horizon, glow) | [1, 0.45, 0.12, 0] | [1, 0.5, 0.14, 0] | [1, 0.4, 0.1, 0] | [1, 0.45, 0.12, 0] | [1, 0.45, 0.12, 0] | [1, 0.45, 0.12, 0] |
| fog blend (dome y) | 0.15 | 0.17 | 0.15 | 0.18 | 0.16 | 0.16 |
| disc (sun / moon) colour | #FFF1C2 | #F2F5F8 | #DCE6FF | #F4F0B0 | #FF9A70 | #FFFFFF |
| disc azimuth / elevation (deg) | 35 / 9 | 20 / 26 | 3 / 11 | 30 / 10 | 6 / 3 | 30 / 8 |
| disc edge cos (outer, inner) | [0.9995, 0.9998] | [0.9985, 0.9995] | [0.9993, 0.99965] | [0.9992, 0.9997] | [0.9993, 0.99975] | [0.9993, 0.9997] |
| disc boost / halo wide / halo tight | 3 / 0.18 / 0.45 | 0.35 / 0.3 / 0.12 | 1.4 / 0.1 / 0.22 | 1 / 0.3 / 0.25 | 1.2 / 0.22 / 0.3 | 1.6 / 0.25 / 0.45 |
| disc mottle (moon craters) | 0 | 0 | 0.35 | 0 | 0 | 0 |
| horizon warm / away darken | 0.45 / 0.86 | 0.08 / 0.94 | 0.15 / 0.8 | 0.35 / 0.78 | 0.55 / 0.7 | 0.08 / 0.92 |
| clouds opacity / cover / drift | 0.4 / 0 / [0.006, 0.002] | 0.85 / 0.3 / [0.012, 0.004] | 0.15 / 0 / [0.004, 0.001] | 0.3 / 0.1 / [0.008, 0.003] | 0.35 / 0.05 / [0.01, 0.003] | 0.35 / 0.1 / [0.006, 0.002] |
| stars density / gain | off | off | **on** 0.012 / 0.7 | off | off | off |
| skyline mix / dark / cols | 0.3 / 0.9 / 42 | 0.5 / 0.85 / 30 | 0.12 / 0.55 / 52 | 0.55 / 0.75 / 36 | 0.25 / 0.8 / 34 | 0.6 / 0.7 / 28 |
| skyline lit windows: gain / density / colour | 0.7 / 0.035 / #FFB36B | 0 / 0 / #FFE0B0 | 1.6 / 0.12 / #FFC27A | 0.4 / 0.02 / #C8F0A0 | 0.6 / 0.02 / #FF6A2A | 0.25 / 0.015 / #FFD8A0 |

Only Ash's low sun (3°, azimuth 6°) is inside the portrait gameplay view (it sits behind the progress bar, above the far gates; it was in the measured frames of §4.4). Every other disc is outside it or above it.

**Fog, lights, exposure, bloom**

| | 1 SUNSET BOULEVARD | 2 OVERCAST HIGHWAY | 3 NIGHT CITY | 4 TOXIC INDUSTRIAL | 5 ASH WASTELAND | 6 FROZEN OUTSKIRTS |
|---|---|---|---|---|---|---|
| fog colour | #D8744A | #56625E | #1F2237 | #6E6A2E | #4A403C | #909A98 |
| fog near / far (High-Med; Low) | 40 / 100 (90) | 38 / 95 (85.5) | 40 / 104 (93.6) | 38 / 95 (85.5) | 38 / 95 (85.5) | 38 / 95 (85.5) |
| run-up fog near | 32 | 31 | 32 | 31 | 31 | 31 |
| sun / moon light colour × intensity | #FFD2A0 × 3 | #E6ECF2 × 1.5 | #B4C2E8 × 2.4 | #F4E8A0 × 2.4 | #FFC0A0 × 2.4 | #EEF4FF × 2 |
| light offset from the squad (direction and distance, §6.1) | [8, 12, -14] | [4, 16, -10] | [-7, 14, -12] | [7, 12, -14] | [6.5, 10.5, -21] | [8, 10, -14] |
| light elevation / azimuth (deg) | 36.7 / 29.7 | 56.1 / 21.8 | 45.2 / −30.3 | 37.5 / 26.6 | 25.5 / 17.2 | 31.8 / 29.7 |
| shadow box bottom (§6.1) / reach on the road centre (z) | −12 / −23.2 | −17.8 / −23.2 | −14.2 / −23.2 | −12.6 / −23.2 | −12 / −27.2 | −12 / −24.4 |
| hemi sky / ground × intensity | #7FB0E0 / #5A4634 × 0.9 | #A9B8C6 / #3E4246 × 1.5 | #6A6A78 / #24242A × 1.9 | #A8A490 / #3C3A2C × 1.35 | #8A8E90 / #2E2420 × 1.6 | #C4D6EA / #8A949E × 1.1 |
| title rig: hemi / sun swing (deg) | 1.8 / 175 | 2.6 / 175 | 3 / 175 | 2.7 / 175 | 3 / 175 | 2.2 / 175 |
| exposure (ACES) | 1.05 | 1.1 | 1.2 | 1.1 | 1.1 | 0.95 |
| bloom strength / radius / threshold | 0.6 / 0.4 / 0.85 | 0.5 / 0.4 / 0.85 | 0.7 / 0.45 / 0.85 | 0.7 / 0.45 / 0.85 | 0.65 / 0.5 / 0.85 | 0.55 / 0.4 / 0.85 |

**Colour grade (GradeOutputPass)**

| | 1 SUNSET BOULEVARD | 2 OVERCAST HIGHWAY | 3 NIGHT CITY | 4 TOXIC INDUSTRIAL | 5 ASH WASTELAND | 6 FROZEN OUTSKIRTS |
|---|---|---|---|---|---|---|
| shadow tint × mix (luma) | #1E6C7A × 0.08 (0.3) | #24485A × 0.06 (0.3) | #14286A × 0.1 (0.3) | #1C4628 × 0.1 (0.3) | #3A1410 × 0.12 (0.3) | #24486E × 0.08 (0.3) |
| highlight tint × mix (luma) | #FFB070 × 0.1 (0.7) | #E4ECF4 × 0.05 (0.7) | #FFB070 × 0.12 (0.7) | #E6F07C × 0.08 (0.7) | #FF9050 × 0.12 (0.7) | #EEF6FF × 0.06 (0.7) |
| saturation | 1.12 | 1.12 | 1.15 | 1.12 | 1.12 | 1.18 |
| vignette strength (a, b) | 0.35 (0.5, 1.4) | 0.32 (0.5, 1.4) | 0.42 (0.5, 1.4) | 0.4 (0.5, 1.4) | 0.45 (0.5, 1.4) | 0.3 (0.5, 1.4) |

**Road and ground**

| | 1 SUNSET BOULEVARD | 2 OVERCAST HIGHWAY | 3 NIGHT CITY | 4 TOXIC INDUSTRIAL | 5 ASH WASTELAND | 6 FROZEN OUTSKIRTS |
|---|---|---|---|---|---|---|
| asphalt / dash / edge | #3B3B44 / #E6CF72 / #D6D6CC | #32322F / #D9C66C / #C8CCCC | #363432 / #D9C46A / #C8C8C0 | #2E3036 / #D8C860 / #C8CCB0 | #2E3032 / #CDAE62 / #BFB3A0 | #3E3C40 / #E0D07A / #D6D6CC (was #E4E8EC, §13) |
| curb | #7A7570 | #6C6E70 | #5E5C5A | #6A6A5E | #6E6660 | #8A9098 |
| roughness | 0.92 | 0.55 | 0.6 | 0.85 | 0.95 | 0.8 |
| puddle cover (puddle roughness); > 0 = wet road | 0 (dry) | 0.2 (0.32) (cover was 0.35: §4.4 step 1, §13) | 0.25 (0.32) | 0.12 (0.32) | 0 (dry) | 0.15 (0.32) |
| light pools (lamp heads) | — | — | #FFB36B × 2.4 (was 1.2, §14), r [2.6, 3.8] m | — | — | — |
| ground (beyond the ditch) | #5A4634 | #43483F | #24221E | #45422C | #5A524C | #C0CCD8 |
| shoulder (blends into the ground across 5.0–7.2 m) | #6B5A48 | #50544E | #302C26 | #524E34 | #6A5A48 | #6E7884 |
| grass / drift layer | #6B6440 | #4E5A3E | #2A2C22 | #6A6834 | #2A2624 | #E4ECF4 |

**Buildings and windows**

| | 1 SUNSET BOULEVARD | 2 OVERCAST HIGHWAY | 3 NIGHT CITY | 4 TOXIC INDUSTRIAL | 5 ASH WASTELAND | 6 FROZEN OUTSKIRTS |
|---|---|---|---|---|---|---|
| facade colour (× texture via material.color) | #6B6058 | #6A6C6E | #4E5060 | #5C5E52 | #3C3430 | #6E727A |
| lit-window fraction | 0.15 | 0.04 | 0.5 | 0.08 | 0.05 | 0.1 |
| window colour × emissive | #FFB36B × 1.6 | #FFE0B0 × 1.2 | #FFB36B × 2 | #D4F0B8 × 1.4 | #FF7A2A × 2.2 | #FFD08A × 1.6 |
| dark (abandoned) buildings | 0.25 | 0.4 | 0.1 | 0.35 | 0.5 | 0.3 |
| fog-coloured bounce | 0.45 | 0.35 | 0.35 | 0.4 | 0.4 | 0.3 |
| snow on roofs (amount) / colour | 0 / #EEF4F8 | 0 / #EEF4F8 | 0 / #EEF4F8 | 0 / #EEF4F8 | 0 / #EEF4F8 | 1 / #EEF4F8 |
| near-row presence × (building weight) / far-row × (`layout.far`) | 1 / 1 | 0.15 / 0.58 | 1.15 / 1.17 | 0.6 / 1 | 0.35 / 0.25 | 0.3 / 0.25 |

**Prop slots (kind · weight · overrides)**

Each cell reads kind · weight · overrides. The weight scales the per-segment count (count placers) or the presence chance (lamps, buildings, chance-gated kinds; §7.2). `layout` keys override the kind's layout. `tint` is a linear multiplier on the per-instance colour. The building slot's weight multiplies District 1's near-row presence at the same density (`0.45 + 0.55 × propDensity`: 1 on High, 0.835 on Medium, 0.67 on Low) and may exceed 1 (≤ 1.25; the result is clamped to 1); `layout.far` multiplies District 1's far-row presence (`0.2 + 0.4 × propDensity`). The first data used `layout.present` / `farPresent` overrides, which through `present + (1 − present) × density` were 1.0 on High in every district: Overcast's "highway" showed a full city block.

| | 1 SUNSET BOULEVARD | 2 OVERCAST HIGHWAY | 3 NIGHT CITY | 4 TOXIC INDUSTRIAL | 5 ASH WASTELAND | 6 FROZEN OUTSKIRTS |
|---|---|---|---|---|---|---|
| barricade | **barricade** · 1 | **barrier** · 1 | **neon** · 1 | **barrel** · 1 | **burningWreck** · 1 | **barricade** · 0.6 |
| sandbags | **sandbags** · 1 | **cones** · 0.8 | **sandbags** · 0.6 | **container** · 1 | **dune** · 1 | **snowbank** · 1 |
| car | **car** · 1 | **car** · 1 · burnt 0.15 | **car** · 1 | **car** · 0.6 · burnt 0.4 | **car** · 0.7 · burnt 1 | **frozenCar** · 1 |
| building | **building** · 1 | **building** · 0.15 · far 0.58 | **building** · 1.15 · far 1.17 | **building** · 0.6 · storeys [2, 4], farStoreys [4, 7] | **building** · 0.35 · storeys [1, 3], far 0.25 | **building** · 0.3 · storeys [1, 3], far 0.25 |
| tree | **tree** · 1 | **billboard** · 1 | **tree** · 0.4 | **smokestack** · 1 | **tree** · 0.7 · tint [0.22, 0.2, 0.19] (charred) | **pine** · 1 |
| rubble | **rubble** · 1 | **truck** · 1 | **rubble** · 0.8 | **pipe** · 1 | **rock** · 1 | **rock** · 0.8 · tint [1.25, 1.3, 1.4] (frost) |
| lamppost | **lamppost** · 1 | **lamppost** · 1 | **lamppost** · 1 | **puddle** · 1 | **lamppost** · 1 · broken 0.5 | **lamppost** · 1 |
| smoke | **smoke** · 1 | **smoke** · 1 | **smoke** · 1 | **smoke** · 1 | **smoke** · 1 | **smoke** · 1 |

**Lamps, slot-1 emissive, smoke columns**

The "slot-1 emissive" row drives the barricade slot's material: beacons, neon, ooze or embers. The blink term is `smoothstep(duty[0], duty[1], sin(rate·t + 2.31·x))`; a duty of [−3, −2] means always on.

| | 1 SUNSET BOULEVARD | 2 OVERCAST HIGHWAY | 3 NIGHT CITY | 4 TOXIC INDUSTRIAL | 5 ASH WASTELAND | 6 FROZEN OUTSKIRTS |
|---|---|---|---|---|---|---|
| street lamps (layout / lit · lens gain) | mixed / mixed · 1 | all / none · 1 | all / all · 1.35 | — (puddles; mixed / none) | mixed / none · 1 (broken 0.5) | mixed / none · 1 |
| slot-1 emissive gain · blink rate (rad/s) · duty | 1 · 4.2 · [-0.2, 0.4] | 1 · 0 · [-3, -2] | 1 · 1.9 · [-0.98, -0.9] | 1 · 1.4 · [-1.6, 1] | 1 · 9 · [-1.4, 0.8] | 1 · 4.2 · [-0.2, 0.4] |
| smoke bottom → top | #5A5A5A → #2A2A2A | #6A6E72 → #3A3E42 | #2A2C34 → #15161C | #6E7058 → #3A3C2C | #2E2622 → #121010 | #8A9098 → #5A6068 |
| smoke ember colour × gain | #FFB347 × 2.6 | #FFB347 × 1.2 | #FFB347 × 3 | #C8FF5A × 1.5 | #FF8A2A × 3.4 | #FFB347 × 0.6 |
| smoke alpha / glow bounce | 0.9 / 0.12 | 0.75 / 0.05 | 0.85 / 0.04 | 0.8 / 0.1 | 0.95 / 0.15 | 0.7 / 0.05 |
| columns per slot chance · anchor · w × h (m) | 0.4 · — · [5.5, 9.5] × [16, 28] | 0.2 · — · [5.5, 9.5] × [16, 28] | 0.25 · — · [5.5, 9.5] × [16, 28] | 1 · tree (stack tops, smokeY 20.5) · [4, 6] × [12, 20] | 0.85 · barricade (burning wrecks, smokeY 0.4) · [3.5, 5.5] × [10, 18] | 0.15 · — · [5.5, 9.5] × [16, 28] |

Lamps (`lamps.layout`, `lamps.lit`, `lamps.gain`) describe the `lamppost` kind only; they are inert in a district whose lamppost slot shows another kind (Toxic):
- `layout: 'mixed'` is today's `RENDER.env.layout.lamp`: presence `0.55 + 0.45 × propDensity` × weight, broken 0.16 (a slot `layout.broken` override changes it), dark 0.12. `layout: 'all'`: every lamp present and upright at every density and weight.
- `lit: 'mixed'`: an upright lamp is lit unless its seeded "dark" draw says otherwise (today); `'all'`: every upright lamp lit; `'none'`: no lamp lit.
- Road light pools (`road.pools`) assume a lit lamp at every lamp position. They therefore need `layout: 'all'` and `lit: 'all'` in their district, and `layout: 'all'` in every district that rotates into it with the lamppost kind unchanged (Overcast → Night): presence cannot change on placed instances without a pop, but `lit` can (§3.3). The validator enforces both.

**Weather (env.dust Points, re-themed)**

| | 1 SUNSET BOULEVARD | 2 OVERCAST HIGHWAY | 3 NIGHT CITY | 4 TOXIC INDUSTRIAL | 5 ASH WASTELAND | 6 FROZEN OUTSKIRTS |
|---|---|---|---|---|---|---|
| kind | **dust** | **rain** | **ash** | **spores** | **embers** | **snow** |
| colour × gain / opacity / blend | #FFD9A8 × 1 / 0.18 / add | #C8D4E0 × 1 / 0.22 / add | #B8B4B0 × 0.35 / 0.45 / normal | #CFCBA0 × 1 / 0.32 / add | #FF8A3A × 2.8 / 0.9 / add | #F4F8FF × 0.5 / 0.85 / normal |
| brightness check (normal: luma·gain ≤ 0.5; add: luma·gain·opacity ≤ 0.26) | 0.133 | 0.142 | 0.161 | 0.187 | HDR (exempt) | 0.468 |
| density (× tier count 300 / 150 / 0) | 1 | 1 | 0.6 | 0.7 | 0.75 | 1 |
| size (m) / drift x (m/s) / fall y (m/s) | 0.06 / 0.4 / 0 | 0.22 / 0.6 / -9 | 0.055 / 0.25 / -0.45 | 0.05 / 0.2 / -0.12 | 0.045 / 0.35 / 0.7 | 0.075 / 0.15 / -1.1 |
| sway / streak half-width / slant (rad) / flicker | 1 / 0 / 0 / 1 | 0.05 / 0.06 / 0.2 / 0.2 | 0.7 / 0 / 0 / 0.3 | 0.9 / 0 / 0 / 0.6 | 0.5 / 0 / 0 / 1 | 0.8 / 0 / 0 / 0.15 |
| box (m) | [12, 6, 40] | [12, 6, 28] | [12, 6, 40] | [12, 6, 40] | [12, 6, 40] | [12, 6, 34] |
| sprite fill, Medium / High (% of the frame, TR/tools/weatherfill.mjs) | 0.9 / 1.8 | 18 / 36 | 0.5 / 0.9 | 0.5 / 0.9 | 0.4 / 0.8 | 1.7 / 3.5 |

**Weather rule.** The particles are unlit (`DUST_FRAG` writes `uColor` straight out), so their colour is their on-screen radiance whatever the scene's light level. A particle must never be brighter than the value glyph (linear 0.82) or approach the bloom threshold, and must look lit by its district: on Normal blending `luma(lin(color)) × gain ≤ 0.5`; on Additive blending the added radiance `luma × gain × opacity ≤ 0.26`; embers are the one HDR weather, on purpose (tiny, additive, they bloom on High and Medium). Night's ash is set lower still (0.16): the Night road is lit to ≈ 0.013 linear, and at gain 1 (0.46) the specks were 35 × brighter than the road. Low has no weather at all (`QUALITY_TIERS.low.dust` is 0), as today.

**Characters and UI**

| | 1 SUNSET BOULEVARD | 2 OVERCAST HIGHWAY | 3 NIGHT CITY | 4 TOXIC INDUSTRIAL | 5 ASH WASTELAND | 6 FROZEN OUTSKIRTS |
|---|---|---|---|---|---|---|
| zombie eye (and acid-sac) emissive | 1.5 | 1.5 | 2.6 | 1.8 | 2 | 1.6 |
| banner accent | #FFB02E | #9FB8CC | #FF4FD8 | #B8E83A | #FF5A2A | #BFE6FF |
| banner label | DISTRICT 1 · SUNSET BOULEVARD | DISTRICT 2 · OVERCAST HIGHWAY | DISTRICT 3 · NIGHT CITY | DISTRICT 4 · TOXIC INDUSTRIAL | DISTRICT 5 · ASH WASTELAND | DISTRICT 6 · FROZEN OUTSKIRTS |
| white HUD text vs the sky band behind the HUD (WCAG, §4.7) | 2.3 : 1 | 2.1 : 1 | 17.4 : 1 | 2.0 : 1 | 6.7 : 1 | 1.5 : 1 |

### 2.1 Art notes (what sells each district, what to avoid)

- **1 Sunset Boulevard.** Untouched. It is the ad and the reference every other district is measured against.
- **2 Overcast Highway.**
  - **What sells it:** flat, shadow-soft light (sun 1.5, hemi 1.5); a heavy cloud deck (cover 0.3); a grey-blue sky band over a grey-slate haze; dark wet asphalt with puddles and a broad sun sheen (roughness 0.55); thin slanted rain; highway kit instead of city blocks (near buildings 15 % present on High); a regular row of intact, unlit highway lamps.
  - **Avoid:** a light neutral grey fog, which washes out the ×1 gate and the −/÷ pair at 17 px, and a blue fog, which fights the + gate (§4.5). The final grey-slate #56625E is dark (L* about 43 on screen) and leans slightly green.
  - **Rain** is 0.22 m streaks at 0.22 opacity, slanted 0.2 rad: 0.35 m streaks at 0.32 filled 45 % of a Medium frame with blended sprites and drew upright bright lines the size of a "1" beside the value glyphs.
- **3 Night City.**
  - **What sells it:** the lit city. Half of all windows are lit; every streetlight is on, with warm pools on the road; neon blade signs flicker; the skyline is dense with lit windows. Zombie eyes glow at 2.6.
  - **The moon and stars are title dressing.** The disc sits at azimuth 3°, elevation 11°: above the portrait gameplay view (top edge +8.7°) and right of centre on the title rig, between the settings / fullscreen buttons and the coin pill. At its first position (−12°, 8°) it peeked out behind the pause button in gameplay.
  - **The light is neutral slate:** moon #B4C2E8, hemi #6A6A78. A saturated blue night tinted the road the colour of the + gate (36 px panel ΔE 13.9, then 20.4 after the fix). The key light comes from the left at azimuth −30° (−42° pushed the road out of the shadow box at z −21, §6.1).
  - **Bloom is "stronger" at 0.7 / 0.45** (the ad: 0.6 / 0.4). It stops there: 0.9 / 0.55 with exposure 1.3 put the 36 px glyph:plate contrast at 3.21:1 on Medium, and 0.75 / 0.5 still gave 4.31:1 on High.
  - **Ash is dim grey** (gain 0.35): falling specks, not glowing ones.
  - **Risk to measure (§10.3):** the light pools sit under the outer lanes (heads at |x| 3.63, rx 2.6) and show through the translucent glyph plates at the armed line. The model puts the 36 px glyph:plate drop at ≈ 18 % at full pool intensity; the measured 5.68 : 1 (Medium) would land near 4.7 against a 4.5 floor. The fallback ladder of §4.4 starts with the pool intensity. Art review (§14): at 1.2 the pools were invisible on screen (≈ +30 sRGB levels of red at the very centre, pow 3 falloff over a 0.036 albedo): the night road read as one evenly moon-lit grey. They are 2.4 now, and a puddle inside a pool mirrors the lamp; the armed-line glyph : panel stays 4.0–8.6 : 1 over every gate type in Night on Medium (§14).
- **4 Toxic Industrial.**
  - **What sells it:** yellow-olive smog; chimney plumes that glow chartreuse at the mouth; ooze glowing from barrels and puddles on the shoulders; pale spores drifting.
  - **The chemical glow is chartreuse #A8FF3A (about 100° hue), not green,** so it never reads as a × gate (#3BE57A, about 145°). It is the spitter's acid hue, though (`PALETTE.fx.acid` #9BE84B, about 92°: the globs, the splash and the landing telegraph), so the glow stays off the road: the ooze lives only in props kept outside |x| 4.5 (§1 rule 3, §7.2), and the spores — which drift over the lanes and the squad — are pale khaki #CFCBA0, not chartreuse (#D8F07A at first).
  - **Avoid:** a bright yellow-green fog. It collides with the gold MAX frame and the green × gate (§4.5).
- **5 Ash Wasteland.**
  - **What sells it:** a dark red sky (horizon #A8281E) and a low blood-red sun over grey-black ash ground; sand shoulders; burning wrecks with ember glow and black plumes; charred trees; embers rising.
  - **The haze is ash-grey, not orange.** An orange-brown haze read as "Sunset again" in the prototype.
  - **Fill light:** a neutral-cool hemi (#8A8E90) against a warm key light keeps the green zombies separate from the warm road (zombie/road ΔE 3.2 → 14+ in the model).
  - **The key light** keeps its low 25° from the front, but sits 24.4 m from the squad (the same direction as the first [5, 8, −16]): at 18.6 m the shadow camera's near plane cut the road at z −20.
- **6 Frozen Outskirts.**
  - **What sells it:** a pale blue-white sky band, white snowfields beyond the ditch, white roofs, snowbanks and snowy pines, frosted cars, falling snow, and a pale neutral-grey haze.
  - **The haze is not white.** A white-out fog drops the 17 px glyph contrast to about 2.1:1 and the −/÷ separation to about 3 ΔE (§4.5).
  - **The shoulder is grey slush** (#6E7884, L* about 49): it is what the gate frames are seen against. The snowfield colour blends in across the shoulder band (§1 rule 3); it is bright from the ditch out.
  - **Snow is grey-white, not glowing** (gain 0.5, linear 0.47): at gain 1 a flake was brighter than the white value glyph and at the bloom threshold.
  - **The HUD sky band is the palest of all** (1.5 : 1 against white text): the HUD keeps its outlines and dark plates (§4.7).

---

## 3. Rotation, transitions, title

### 3.1 Campaign

- **Mapping:** `districtForLevel(L)` gives district ⌊(L − 1) / 5⌋ mod 6 + 1. L31+ cycles: L31 maps to Sunset Boulevard, L36 to Overcast Highway.
- **At level start** the district snaps with `seconds = 0`, under the boot / level-start hitch budget. RESTART, RETRY and NEXT go through the same path.

### 3.2 Endless rotation

- **Mapping:** `districtForChunk(D)` gives district ⌊(D − 1) / 3⌋ mod 6 + 1, where D is the 1-based chunk (difficulty) index. A run starts in Sunset Boulevard (chunks 1–3) and rotates every 3 chunks (900 m, about 80 s). A strong player (chunks 9–14) sees four or five districts.
- **Trigger:** `LevelRunner.step` checks it every step while a rotation is due. A rotation starts at the first step where all hold:
  - (a) `distance ≥ (D_new − 1) × LEVELS.endless.chunk`;
  - (b) no live gate event is between the spawn line and the 36 px point: `distance − lastGatesAt ≥ −WORLD.spawnZ + DISTRICT_RULES.fadeGateClearZ` (70 − 26 = 44 m), where `lastGatesAt` is the `at` of the last fired `'gates'` event (an event spawned at `s` sits at z = −70 + (distance − s); no gates API is needed);
  - (c) the next gate event spawns late enough in the fade: `nextGatesAt − distance ≥ fadeNextGateFrac × fadeSeconds × world.roadSpeed` (0.8 × 4 s × v), where `nextGatesAt` is the `at` of the first unfired `'gates'` event (the next chunk is always appended by then; none → true). The first new gate then appears at eased fade progress ≥ 0.968;
  - (d) no boss is alive: `!ctx.world.bossActive` (the endless mini-boss, every 5th chunk, can still be fighting at the D 16 boundary).

  The trigger stops waiting `fadeDeferMaxM` (150 m) past the boundary and rotates anyway.
- **Why:** cross-fade midpoints pass through weaker fog colours (§4.6), and a district change in the middle of a mini-boss fight would hide the banner and re-light the boss. With today's generator (`generateChunk`: G gate events at `start + (i + 0.5) × span / G`, span = 300 − 70 − 20 m, or − 70 more in a mini-boss chunk), the last gate of a chunk spawns 125 m (D ≤ 4) or 142.5 m (D ≥ 5) before the boundary and the first gate of the next chunk 35 m (D ≤ 4, and mini-boss chunks) or 52.5 m after it. At the rotation boundaries (D 4, 7, 10, 13, 16, 19; v = 9.6 … 11.85 m/s) (b) holds and (c) needs ≤ 37.9 m, so every rotation starts at its boundary unless a mini-boss is alive. Gates are 70 m apart inside a D ≤ 4 chunk, so a rotation could never fit between two gates mid-chunk: the boundary is the window. (The first spec claimed "endless gate events are at least 100 m apart"; they are not.)
- **Event:** level emits `district:change { reason: 'rotate', seconds: DISTRICT_RULES.fadeSeconds (4), banner: true }` and calls `render.setDistrict(next, 4)`.

### 3.3 Cross-fade (seconds > 0)

**Clock.** The fade advances on the theatre clock: `k = ease.inOutCubic(clamp((ctx.time.theatre − t0) / (seconds × 1000), 0, 1))` (`theatre` is in ms; it holds while paused and while the context is lost). render and environment start their fades in the same `setDistrict` call with the same `t0`, so they run in lockstep.

**What lerps:**
- **Colours** lerp in linear working space (precomputed linear values; `Color.lerpColors` into existing objects).
- **Scalars** lerp linearly.
- **Directions** use a normalized lerp. This covers the light offset from the squad (lerped as a vector, so its length lerps too; the light-space basis and the shadow box bottom are rebuilt each fade frame, §6.1) and the disc direction from az / el.
- **Fog near / far** are written by the district fade itself (same clock); `setDistrict` cancels a running `env.setFog` lerp. A `setFog` call during a fade (campaign run-up only) takes near / far over and the fade stops writing them.

**Swap dip** (`DISTRICT_RULES.swapDip` [0.45, 0.55]):
- **Weather:** opacity eases to 0 by 0.45; at the trough the theme swaps (colour, gain, blend, fall, sway, streak, slant, flicker, size, box and drawRange); opacity eases back to the new target from 0.55. No mixed rain and snow is ever drawn.
- **Skyline:** the silhouette's coverage eases to 0 by 0.45 (new `uSkyDip`, §6.2), `uCols` switches at the trough, coverage eases back from 0.55. Switching the column count without the dip redraws every skyline building at once in the horizon band under the HUD.

**Switches at 0.5:** `lamps.lit` is re-applied to the lamppost instances already placed, as long as the lamppost slot still shows lamps (whatever the target kind — integration amendment, r5-env-art decision 5): Overcast → Night lights the intact highway lamps as the pools fade in; Night → Toxic switches them off (Toxic's `lamps.lit: 'none'` exists for exactly this) as the pools fade out, before they drain. The beacon blink rate switches at the same point (a lerped rate sweeps `rate·uTime` through many blink cycles). Everything that belongs to placement — `lamps.layout`, `smoke.anchor`, slot weights, layouts and tints — applies to segments placed after the call.

**Props: drain, swap, refill.** These steps apply per slot whose kind changes. Unchanged slots keep their geometry; their new weight, layout and tint apply as segments recycle.

1. **Drain.** From the call on, every recycled segment (placed at the far end of the ring, invisible) is *pending* for that slot: the slot's placer runs for the target kind exactly as it will after the swap — same RNG draws, so every other slot in the segment gets the values it will keep — but writes nothing, and the slot's instances in that segment stay hidden. A smoke column anchored to a pending slot is hidden the same way.
2. **Swap.** When the last segment placed before the call recycles (6 recycles, 180 m after the call), no old-kind instance is left anywhere. The slot then:
   - assigns the target kind's view geometry;
   - sets its instance stride and `mesh.count` to 6 × the target kind's `per`;
   - sets `mesh.castShadow = kind.castShadow !== false`;
   - hides its whole instance buffer, then re-runs `_placeSegment(k)` for every ring segment whose near edge is beyond `DISTRICT_RULES.hiddenBeyondZ` (−100 m, fully fogged in every district and tier). Every other slot rewrites identical data there.
3. **Refill.** Later recycles place the target kind normally.

**Cost of the drain.** Once per changing slot, that slot is empty over the whole visible ring (−100 → +20 m = 120 m, 10–13 s at endless speed), from about 60 m after the call until about 180 m after it, then refills from the fog. That is 4 or 5 of the 8 slots per transition (see the table below). Cars, buildings, lamps and smoke usually carry over, so the road is never bare; the stretch reads as a district border. No other order is shorter while nothing pops: an old and a new kind cannot share a slot's geometry, and a new instance may only appear beyond −100 m. Popping every visible old prop into the new kind would be worse. Per-segment kinds would need either a second mesh per slot (+8 draws) or merged dual-kind geometries (2× vertex work plus kind-aware depth materials). Both were rejected.

Slots that swap per endless transition:

| Transition | Slots that swap |
|---|---|
| 1 → 2 | barricade, sandbags, tree, rubble |
| 2 → 3 | barricade, sandbags, tree, rubble |
| 3 → 4 | barricade, sandbags, tree, rubble, lamppost |
| 4 → 5 | barricade, sandbags, tree, rubble, lamppost |
| 5 → 6 | barricade, sandbags, car, tree |
| 6 → 1 | sandbags, car, tree, rubble |

**A new `setDistrict` during a fade** starts from the current mid-fade values (render snapshots its current-state mirror as the new "from"). Each slot compares its new target kind with the kind its geometry shows: equal → the drain is cancelled (segments placed as pending stay hidden until they recycle); different → the drain continues toward the new target, and its swap point moves to 6 recycles after the new call. Any snap (`seconds = 0`) cancels every drain.

### 3.4 Snap (seconds = 0)

Every value is set before the next draw. Every slot whose kind differs swaps geometry immediately (stride, `mesh.count`, `castShadow`), and the ring is re-laid (`_layoutAll` at the current seed and density). The weather theme and the skyline columns swap immediately.

This is used at level start (campaign and endless run start) and at the title. It is **not** used after `webglcontextrestored`: a re-layout mid-run would re-seed every visible prop. `render.rebuild()` re-applies the current district's uniform and light state only (§6.1); geometries and instance buffers persist in JS and three re-uploads them lazily.

### 3.5 Title rule

The title idle scene shows `districtForLevel(save.data.highestUnlocked)`: a returning player at L14 sees Night City behind the logo. `level.quitToTitle()` calls `render.setDistrict(d, 0)` and emits `district:change { reason: 'title', banner: false }`.

The title rig's light uses the district's values. The hemisphere eases from `hemi.intensity` to `hemi.title`, and the sun swings `sun.titleAzimuthDeg` about +Y. For District 1 these equal today's `RENDER.title`.

### 3.6 Boot and warm-up (zero first-use hitches)

- **Step 5:** `Environment.build` builds the District 1 look exactly as today, with environment.js's own built-in geometries. The tree slot is built at capacity 60 (was 40).
- **Step 6:** `ModelLibrary.init` builds the 16 new kind geometries (§7): about 4 k triangles, roughly 0.3–0.5 MB of vertex and index data in total.
- **First need:** Environment adopts them lazily, either at `districtWarmList` or at the first `setDistrict`. For each new kind it makes a view geometry that shares models' BufferAttributes and index, plus the slot's shared `iEmit` InstancedBufferAttribute on the two emissive slots. Models' geometries are never mutated.
- **Step 6 (as built):** `ModelLibrary.init` also calls `env.warmDistricts()`, which parks one hidden InstancedMesh proxy per (slot, alternative kind) — the kind's view geometry with the slot's material, depth material and shared instance buffers. Hidden objects draw nothing; every "draw each renderable once" pass draws them out of sight: render.warmup at boot and `_warmHiddenChunked` after a tier change (a session that boots on Low and later gains shadows gets the depth-pass VAOs then).
- **Step 9b:** `render.warmup()` appends `env.districtWarmList(out)`, which lists every (slot mesh, alternative geometry) pair. Each pair is drawn once out of sight with the geometry temporarily assigned and then restored, inside the existing `_warmDrawChunked` budget, on a tier with shadows when the session has them (so the depth-pass VAOs exist too). This uploads every buffer and creates every VAO with the real instance buffers, so a later swap is a pointer change.

No new programs exist (rule 6), so the compile step is unchanged apart from `gr:road` replacing the plain road program.

---

## 4. Readability

### 4.1 Method

Two independent checks were run. Both are needed, because the gate shaders do non-trivial things at distance:
- frames and glyphs fog toward a desaturated fog colour, capped at 0.5;
- panels fog only up to 0.25 and gain opacity against a fogged background with colour compensation;
- additive glow quads sit behind every panel.

**Check 1: analytic (GDD §4.1 style).** The model is `EV/tools/evalcore.mjs`:
- It uses the portrait camera (0, 9.5, 11), looking at (0, 1, −14), and computes the view-space fog depth of a gate centred at y = 2.2 m.
- At z = −70, −36 and −26, the glyph heights are 16.9, 28.9 and 36.5 px (GDD formula, 844 px), and the view depths are 79.0, 46.9 and 37.4 m.
- Fog factor `smoothstep(near, far, depth)`: 0.72 / 0.036 / 0 at 40 / 100. At 38 / 95 it is 0.81 / 0.065 / 0.
- Gate fog target: G = mix(luma F, F, 0.35), capped at 0.5 for frames and glyphs and 0.25 for panels.
- The panel compensation and luminance caps are copied from materials.js.
- Lighting follows three r170's `BRDF_Lambert`, followed by ACESFilmic with exposure, the GATE RUSH grade and sRGB.
- Colour differences are CIEDE2000; contrast uses the WCAG relative-luminance ratio.

**Independent re-check (review).** `TR/tools/check.mjs` re-derives the 17 px numbers from materials.js and render.js without evalcore: on-screen fog, the glyph against its plate, the glyph against bare fog, and every panel against the fog. It agrees with §4.2 within 0.2 ΔE and 0.06 : 1. It also corrects one model detail: `GRADE_FRAG` computes `luma` once, before the shadow / highlight tints, and uses it for the saturation mix too (evalcore recomputes it after the tints); the effect is under 0.2 ΔE everywhere. The three pairs the review was asked to re-derive:

| Pair (17 px, spawn line) | Result | Sunset reference |
|---|---|---|
| Frozen: white value glyph vs its plate / vs the bare grey fog | 3.11 : 1 / 1.50 : 1 | 3.18 : 1 / 1.68 : 1 |
| Night: + panel (#2E9BFF) vs the slate-indigo fog | ΔE 31.5 (fog L* 6) | 40.7 |
| Toxic: × panel (#3BE57A) vs the yellow-olive fog | ΔE 28.5 | 41.1 |

The glyph is never read against bare fog: the dark plate (≥ 0.85 opaque against a fogged background) carries it, and the glyph:plate ratio in Frozen is the ad's. The weak cell is the ×1 / 0 panel in Frozen (ΔE 7.4 against a neutral fog by design); it reads by its glowing frame (ΔE 29.9 in-engine at 17 px). Toxic's grade shadow tint (#1C4628, green) was suspected of pulling the road behind the × gate toward green; the model shows < 0.1 ΔE change for any olive replacement, so it stays.

**Check 2: in-engine, authoritative.** `EV/tools/proto.mjs` boots a snapshot of the shipped build (`EV/snap/`) in headless Chrome on the real GPU (390 × 844 @ 2, ANGLE / D3D11, RX 6800):
1. It freezes a level: no scroll, no bullets, no script.
2. It applies each district's lighting, fog, sky, grade, exposure, bloom, road, building and weather values to the live objects. This is a stand-in for `render.setDistrict`.
3. It spawns single decorative gates of every type (+, ×, −, ÷, ×1, item, MAX) at z = −70, −36 and −26.
4. It reads the final canvas back with `readPixels` right after `render.draw()`. Weather and smoke are hidden for the read.
5. It samples: the panel body (y 3.05 m); the plate at ±1.32 m; the brightest glyph pixel; the most distinct pixel on the frame at the three chevron rows; and the backdrop at ±2.7 m.

Every number in §4.4 is the minimum of two full runs per tier. They are the **bare** pass: none of the new props, weather shapes, light pools, puddles, stars or anchored smoke existed, and the light offsets of Night and Ash have since moved (§12). §10.3 adds the full-dressing pass.

### 4.2 Analytic pixel check (fog colour vs gate tints)

At 17 px, each gate type's frame and panel is compared with the fog it sits in. At 29 and 36 px, the minimum over types is compared with the fogged road behind the gate. Type order is + / × / − / ÷ / ×1 / item / MAX.

| District | fog (data → on screen) | gate fog target G | 17 px: frame ΔE00 vs fog | 17 px: panel ΔE00 vs fog | 29 px min frame / panel | 36 px min frame / panel | glyph:plate 17 / 29 px |
|---|---|---|---|---|---|---|---|
| SUNSET BOULEVARD | #D8744A → #E68544 | #C1998C | 35.5 / 22.4 / 21.2 / 23.1 / 21.3 / 36.8 / 13.6 | 40.7 / 41.1 / 20.3 / 28.4 / 24.9 / 41.3 / 40.7 | 18.2 / 10.9 | 9.6 / 17.1 | 3.17 / 6.39 |
| OVERCAST HIGHWAY | #56625E → #566963 | #606664 | 23.9 / 13.2 / 33.2 / 31.4 / 8.0 / 27.4 / 23.5 | 24.6 / 31.6 / 38.0 / 39.5 / 30.0 / 28.2 / 24.6 | 29.0 / 29.1 | 32.5 / 26.1 | 4.94 / 7.76 |
| NIGHT CITY | #1F2237 → #0E122C | #12131D | 11.9 / 33.9 / 23.9 / 19.3 / 13.8 / 14.5 / 44.1 | 31.6 / 63.8 / 40.6 / 37.6 / 61.4 / 32.7 / 31.6 | 33.1 / 30.0 | 34.2 / 24.9 | 7.10 / 10.17 |
| TOXIC INDUSTRIAL | #6E6A2E → #79740C | #74725A | 44.5 / 17.8 / 29.6 / 29.6 / 19.1 / 49.9 / 10.9 | 54.1 / 28.4 / 41.5 / 49.1 / 32.5 / 59.6 / 54.1 | 28.9 / 39.4 | 38.5 / 31.8 | 4.66 / 7.62 |
| ASH WASTELAND | #4A403C → #42342E | #3B3634 | 23.5 / 29.1 / 14.9 / 13.8 / 7.1 / 25.0 / 24.9 | 32.0 / 51.7 / 26.0 / 26.8 / 50.0 / 33.0 / 32.0 | 23.6 / 31.1 | 27.2 / 27.3 | 6.40 / 9.17 |
| FROZEN OUTSKIRTS | #909A98 → #9CA6A4 | #A1A5A4 | 20.6 / 14.8 / 25.3 / 23.6 / 10.9 / 25.1 / 14.7 | 22.5 / 22.0 / 34.5 / 35.1 / 7.4 / 24.6 / 22.5 | 23.3 / 17.8 | 21.2 / 18.4 | 3.10 / 5.83 |

How to read the model:
- **At 17 px the panel carries the type colour.** The 0.12 m frame posts are about 1 px wide there, so their raw value is reported but not used as a pass criterion. The ad itself has a MAX post of 13.6 against its own orange fog.
- **The ×1 / 0 gate is neutral grey by design** (opacity 0.30). Against a neutral haze it reads by its frame glow and its glyph, not by tint. It is judged in-engine on its frame (§4.4: ≥ 20 everywhere).
- **The model is conservative near the camera and optimistic at 17 px.** It does not include the additive glow quad behind every panel. The in-engine numbers in §4.4 are what the floors check.
- The light-offset changes of §12 do not move any model number (lighting depends on the direction only; Ash's direction is unchanged, Night's moved 12° in azimuth: every value within 0.1).

### 4.3 Floors (pass criteria, per tier)

A district passes at a distance if each metric reaches the absolute floor below **or 90 % of Sunset Boulevard's own value on the same tier and distance, whichever is lower**. In other words, no district may read worse than the shipped ad, within 10 %. The floors apply to both passes; in the full-dressing pass they apply to the **median** of 30 frames, and the 10th percentile must reach 85 % of the floor (moving weather and blinking neon are transient).

| Metric (in-engine, ΔE00 against the pixels beside the gate) | 17 px (z −70) | 29 px (z −36, armed) | 36 px (z −26) |
|---|---|---|---|
| Tint panel, every type but ×1 | 13 | 15 | 15 |
| Frame / edge, every type | 15 | 20 | 20 |
| ×1 / 0 frame | 15 | 15 | 15 |
| −/÷ panel separation (they also differ by stripe direction and glyph) | 4.8 | 7.7 | 9.2 |
| Value glyph : plate (WCAG) | 2.1 : 1 | 3.6 : 1 (GDD floor 3 : 1) | 4.5 : 1 |

### 4.4 Measured (bare pass, final palettes before the review, minimum of two runs)

`EV/final/readability-final-{low,med,high}.md`

| Medium | distance (glyph css px) | min tint panel ΔE00 (type) | min frame ΔE00 | ×1 frame ΔE00 | −/÷ ΔE00 | glyph:plate | verdict |
|---|---|---|---|---|---|---|---|
| sunset | 17 (18.0) | 18.0 (−) | 23.4 | 28.8 | 5.6 | 2.15:1 | pass |
| sunset | 29 (29.3) | 16.3 (−) | 29.8 | 39.5 | 9.0 | 4.22:1 | pass |
| sunset | 36 (36.7) | 21.3 (−) | 30.1 | 36.8 | 10.7 | 5.38:1 | pass |
| overcast | 17 | 18.0 (×) | 27.7 | 37.8 | 10.1 | 2.30:1 | pass |
| overcast | 29 | 17.4 (×) | 36.7 | 42.5 | 11.4 | 5.18:1 | pass |
| overcast | 36 | 17.8 (×) | 36.0 | 39.5 | 12.7 | 5.91:1 | pass |
| night | 17 | 25.2 (÷) | 42.0 | 35.2 | 18.9 | 2.86:1 | pass |
| night | 29 | 22.5 (÷) | 39.8 | 38.4 | 12.0 | 5.44:1 | pass |
| night | 36 | 18.8 (+) | 32.0 | 32.1 | 13.0 | 5.68:1 | pass |
| toxic | 17 | 18.5 (×) | 29.7 | 36.3 | 9.6 | 2.38:1 | pass |
| toxic | 29 | 18.0 (×) | 34.0 | 49.9 | 10.5 | 4.29:1 | pass |
| toxic | 36 | 16.0 (×) | 32.6 | 42.0 | 12.0 | 5.12:1 | pass |
| ash | 17 | 19.9 (÷) | 52.8 | 52.6 | 11.5 | 2.20:1 | pass |
| ash | 29 | 17.9 (÷) | 31.8 | 34.7 | 11.7 | 4.59:1 | pass |
| ash | 36 | 17.4 (−) | 31.8 | 31.8 | 12.8 | 6.46:1 | pass |
| frozen | 17 | 16.2 (MAX) | 20.6 | 29.9 | 7.6 | 2.20:1 | pass |
| frozen | 29 | 20.8 (+) | 25.5 | 41.6 | 10.7 | 3.91:1 | pass |
| frozen | 36 | 16.3 (×) | 30.0 | 39.7 | 14.2 | 4.82:1 | pass |

High and Low: every row passes; the tables are in `EV/final/`. The weakest cells are:
- High: Frozen at 17 px, panel 14.7 (MAX).
- Low: Frozen at 17 px, panel 13.3 (MAX); Toxic and Frozen at 36 px, glyph 4.40 and 4.20 : 1. The ad itself measures 4.41 : 1 there on Low, where there is no bloom and toneMapped is false.
- Thinnest margin overall: Toxic × at 36 px on Medium, 16.0 against a floor of 15.

The count label (white on its 0.45 #0B0F1A plate over the road) is 13.8–15.3 : 1 in the model in every district (the ad: 14.2), because the road is dark asphalt everywhere.

**What the bare pass did not see, and the fallback ladder.** The full-dressing pass (§10.3) adds every one of these. If a row fails, apply the district's steps in order, re-measure after each, and stop at the first pass. Every step is a data edit in `DISTRICTS` (no shader change), and the table below is the authority, so the implementer does not need to ask.

| District | New thing in front of / behind the gates | Why it is a risk | Fallback steps (in order) |
|---|---|---|---|
| Night | road light pools under the outer lanes; neon (emissive 2.6, bloom) at \|x\| 8.8–10.2; falling ash | pools show through the translucent plates (model: −18 % glyph:plate at 36 px); neon bloom haze beside the far gates | `road.pools.intensity` 2.4 → 1.2 → 0.8 (2.4 since the art review, §14); `neon.emissive` 2.6 → 2.0; `weather.opacity` 0.45 → 0.3 |
| Toxic | ooze puddles (1.8) and barrels (2.2) on the shoulders; spores | glow beside the × gate, whose margin is the thinnest | `puddle.emissive` 1.8 → 1.2; `barrel.emissive` 2.2 → 1.6; `weather.opacity` 0.32 → 0.22 |
| Ash | burning wrecks (2.8) and anchored plume bases (3.4) at \|x\| ≥ 6.6; embers (HDR) | orange bloom beside the − and MAX gates | `burningWreck.emissive` 2.8 → 2.0; `smoke.ember` 3.4 → 2.4; `weather.gain` 2.8 → 2.0 |
| Overcast | puddle sheen; rain | brighter road patches behind the plates; streaks over the glyphs | `road.puddles` 0.35 → 0.2 (**applied** by the round-5 integration, §13); `weather.opacity` 0.22 → 0.15 |
| Frozen | snow flakes over the plates; the snowfield blend behind the outer posts | white specks beside a white glyph; brighter backdrop for the frame | `weather.opacity` 0.85 → 0.6; then `ground.ground` #C0CCD8 → #A8B4C0 (only for a failing frame row) |

### 4.5 Rejected palettes (why each fog is where it is)

| District | First pick | What failed (model, or in-engine where marked) | Fix |
|---|---|---|---|
| Overcast | grey-blue fog #8E9CAC | ×1 panel 7.7 and chevron 6.8 ΔE against its own fog at 17 px; −/÷ 5.2; grade saturation 1.02 also dropped the −/÷ pair | Saturation 1.12; fog moved off blue (the + gate) and off neutral (×1). Teal #4E6D72 passed but read as "swamp", slate-blue #4C5E66 failed the + panel on Low (12.6, in-engine); final grey-slate #56625E passes everywhere |
| Night | navy fog #1C2848, moon #9DB4FF, hemi #5068A8 | + frame 6.2 against navy at 17 px; in-engine the blue-lit road put the 36 px + panel at 13.9; zombies ΔE 7.4 against the road | Slate-indigo fog #1F2237; neutral slate moon and hemi; warm-grey asphalt; hemi 1.9 |
| Night | bloom 0.9 / 0.55, exposure 1.3 | 36 px glyph:plate 3.21 : 1 on Medium; at 0.75 / 0.5 still 4.31 : 1 on High (bloom haze from the frame chevrons into the plate on a dark background) | Bloom 0.7 / 0.45, exposure 1.2 → 5.68 (Medium) and 5.09 (High) : 1 |
| Toxic | yellow-green fog #8C9450 (L* 60) | MAX frame 9.9 and × chevron 13.2 at 17 px (gold and green both near the haze) | Darker yellow-olive #6E6A2E; paler sun; grey-olive hemi |
| Ash | red-orange fog #8A6A58, orange hemi | MAX frame 6.6 at 17 px; zombie/road ΔE 3.2 (green skin under orange light on warm asphalt); in-engine the umber variant read as a second Sunset | Ash-grey fog #4A403C under a dark red sky; neutral-cool hemi; cool asphalt; bloom 0.65 (at 0.8 the 29 px glyph:plate was 3.26 : 1) |
| Frozen | pale blue-white fog #B8C8D8 | 17 px glyph:plate 2.09 : 1; −/÷ 2.9; ×1 panel 4.5 — fogging a dark plate toward white kills contrast | Fog luminance capped (≈ L* 63); neutral pale-grey #909A98 (the bluer #8A989C failed the MAX panel on Low, 7.5); the pale blue-white lives in the sky band, the snowfields and the weather |

### 4.6 Cross-fade midpoints

The model was run on linear-space interpolations of every consecutive pair at t = 0.25, 0.5 and 0.75 (`EV/tools/transitions.mjs`; re-run on the reviewed data: unchanged). Ten of the eighteen midpoints dip below the floors. Most are the ×1 frame at 17 px (ΔE 3.1–9.2), where two hues cross through grey; the others are the −/÷ separation at 17 px (7.6–7.9) and the armed-line panel next to the Sunset end (12.7). Overcast → Night and Ash → Frozen fail at all three midpoints.

This is why an endless rotation waits for a gate-clear window (§3.2): no gate is read at the spawn line before the fade is ≥ 0.968 done.

### 4.7 Zombies, threat cues, count label, HUD

- **Zombies** walk on dark asphalt in every district. In-engine shots with walkers, runners, a brute and spitters show every type reading in all six districts (`EV/districts-zombies-med.png`, `EV/final-crop-zombies.png`).
- **Zombie body against the road, in the model** (walker skin, camera-facing side, ΔE00): the ad 19.3; Overcast 18.2, Night 11.5, Toxic 13.6, Ash 15.0, Frozen 24.4. Top-lit contrast is 3.0–5.0 : 1 everywhere (the ad: 4.1).
- **Night zombies** read by silhouette against the light pools and by eyes at 2.6; that is why Night is the lowest model value. `setEyeGlow` drives the 0.5-tagged pieces, which are the eyes and the spitters' acid sacs: sacs glow brighter at night too, which helps (§6.3).
- **Acid is a reserved hue.** The spitter's globs, splash and landing telegraph use `PALETTE.fx.acid` #9BE84B in every district. Toxic's chartreuse ooze shares that hue, so it stays in props outside |x| 4.5 (the telegraph lands on the road, under the squad), and Toxic's spores are pale khaki. No other district puts a yellow-green glow near the road.
- **Toxic** zombie green (about 110°) differs from the prop glow (about 95°) and the yellow-olive haze.
- **Shadows reach as far up the road as in the ad** (z ≈ −23 on the road centre, §6.1) in every district, so zombies gain their shadows at the same depth everywhere. Before the review, Overcast's steep sun ended them at z −15.6 and Night's oblique moon at −21 (−16.5 on the lane edges): a shadow popping on under every zombie in the middle of the screen.
- **The count label** is unaffected: it sits on its own plate over dark asphalt.
- **The HUD is DOM, so the grade does not touch it, but its backdrop changes.** In portrait the HUD sits over the sky band (+4° to +8.7°). White against that band: Sunset 2.3 : 1, Overcast 2.1, Night 17.4, Toxic 2.0, Ash 6.7, Frozen 1.5 (`TR/tools/check2.mjs`). The HUD never relies on that contrast: the pause button, coin pill, progress track, power-up pills, boss bar and banner are dark plates, and the only bare text (the LEVEL label) carries the 2 px `--stroke-2` outline plus a 3 px drop. Frozen is the stress case; §10.9 checks it on screen. Do not add a district-dependent scrim.

---

## 5. District banner (HUD)

| Item | Spec |
|---|---|
| DOM | `<div id="district-banner" role="status" aria-live="polite" hidden><span class="db-text"></span></div>`, inside `#hud`, after `#namecard`. index.html (E1) adds it; artifact.html is regenerated; ui caches it in `init()` |
| Text | `district.label`, e.g. `DISTRICT 3 · NIGHT CITY`, from data. ui writes `textContent` only when a banner shows, never per frame |
| When | On `district:change` with `banner: true` while `playing`. Level sets `banner`: run start (`reason 'start'`) is true unless the previous run this session was the same level (RETRY / REPLAY / RESTART; for endless, "the same level" means the previous run was also endless); endless rotation is always true; the title is false. Not shown while `#hud.boss-on` (rotations wait for a live mini-boss, §3.2, so this only happens when the 150 m cap forced one). Cleared on `level:start` (before the run's own `district:change`), on leaving playing / paused, and by a newer banner |
| Placement | Centred; `top: calc(var(--safe-top) + var(--icon-btn) + 32 * var(--u))`, the `#powerups` row, which is empty at level start. While at least one power-up pill is visible, ui adds `#hud.pu-on` (a new class; ui toggles it in `update` when the visible-pill count crosses 0) and the banner drops a row: `+ var(--pill-h) + 8 * var(--u)`. `z-index: 2`; pointer-events none (`#hud > :not(#btn-pause)` already). Dropped a row it reaches ≈ 200 px on a 844 px screen, where the far gates' MAX badges are; a rotation's first gate spawns ≥ 3 s after the banner starts (§3.2), so they never overlap in time. **Landscape phones** (`max-height: 500px`, integration amendment from r5-ui-sw): the camera puts the road and its far gates in the top-centre band, so the banner sits top-left under the pause button (`top: safe-top + icon-btn + 12px`, `max-width: 50% − safe-left − 100px`), over the buildings; `.pu-on` does not move it there (the centred pill row cannot reach it) |
| Look | A pill like the hint pill (`--bg-panel` at `--hint-alpha`, radius 999px, padding `6u 16u`). Text: `--font-display`, `--fs-body`, letter-spacing 0.06em, `#FFFFFF`, `--stroke-2` outline. A 3 px rule in `district.accent` under the text (an `::after` 60 % wide; ui writes the accent into a CSS variable when the banner shows). `white-space: nowrap; max-width: calc(100% - 32px)`. The longest label is about 310 px at `--ui` 1 (fits 390 px; 357 px with large text) |
| Timing | Theatre time (holds while paused), `DISTRICT_RULES.banner`: fade and rise in 0.22 s (opacity 0 → 1, `translateY(-6px)` → 0), hold, fade out 0.3 s; 1.6 s in total. Web Animations on transform and opacity only (compositor), like `#hint` / `#namecard` |
| Reduced motion | `html.reduced-motion`: opacity only, no translate. The existing global rule zeroes transition durations, so the banner appears, holds 1.6 s and disappears |
| Audio | None. An optional soft whoosh is a later audio-owner call |

---

## 6. Rendering changes (shader and uniform contract)

Each item lists its uniforms. `D1` means the value that reproduces today's output exactly.

### 6.1 render.js (RenderSystem)

**State.** render keeps `_dTarget` (the target district), a preallocated current-state mirror `_cur` (every lerpable value of a district: linear `Color`s, numbers, a `Vector3` light offset, a disc direction), per-district precomputed linear typed arrays (built once at init), a "from" snapshot array, `_fadeT0` (ms) and `_fadeDur` (ms). A fade frame writes `_cur` from (from, target, k); every consumer below reads `_cur`, never `RENDER.*` and never the frozen district directly.

- **Sun light.**
  - `lights.sun.color` and `intensity` come from `_cur.sun`.
  - The base offset is `_cur.sun.offset` (a vector: direction and distance both matter). `_setSunAzimuth(az)` takes it instead of `RENDER.sun.offset` and rebuilds the light-space texel basis. It runs when the title swing angle changes **or** on any fade frame.
- **Shadow box (new).** The ortho shadow camera's bottom bound limits how far up the road shadows reach, and that reach depends on the light's elevation: the box's light-space y axis has a world-z component `yz = (û × x̂)·ẑ`, where û = normalize(offset) and x̂ = normalize((û.z, 0, −û.x)) (the `_setSunAzimuth` basis). Set `sun.shadow.camera.bottom = RENDER.sun.frustum.b × max(1, yz / yz₁)`, with yz₁ the same quantity for `RENDER.sun.offset` (0.518; computed with the same code, so District 1 gives exactly ×1), then `updateProjectionMatrix()` and `_updateTexelSize()` (`_texelV = (t − b) / mapSize`). It is computed from the un-swung district offset (the title swing leaves it unchanged), at a snap and on fade frames; allocation-free. The data keeps the other two bounds in reach: azimuth ≤ 31° (light-space x, ±14 m) and a light distance whose near plane (1 m) lies beyond z −23 on the road (validator). Reach on the road centre: every district −23.2 or further (table in §2). Texel density along the light falls by at most 1.1× (Overcast) — invisible on PCF.
- **Hemisphere light.** `color`, `groundColor` and the base `intensity` come from `_cur.hemi`. `_updateTitleLight` computes `hemi.intensity = lerp(_cur.hemi.intensity, _cur.hemi.title, idleBlend)` and the swing from `_cur.sun.titleAzimuthDeg` (it overwrites `hemi.intensity` every frame today, so a fade must not write it directly). District 1 equals `RENDER.title`.
- **Fog colour.** `scene.fog.color` and `renderer.setClearColor(fog)`. Every `fog: true` material, including the fx particles and the gate shaders, picks the colour up through three's `refreshFogUniforms`. fxmaterials.js's initial `PALETTE.fog` needs no change.
- **Fog near and far** are owned by environment (§6.2): render forwards the district; environment writes `scene.fog.near / far`.
- **Exposure:** `renderer.toneMappingExposure = _cur.exposure` (every tier).
- **Bloom.**
  - `bloomBase = _cur.bloom.strength`; `bloomPass.radius = _cur.bloom.radius`. The threshold is never touched.
  - `setBloomStrength(v)` keeps its API; a non-finite `v` now restores `bloomBase` (it restored `RENDER.bloom.strength` before). A finite `v` holds the strength for that frame (stamp `ctx.time.frame`).
  - fx updates before render (ARCH §4.2 C before E), so on a fade frame render writes `bloomPass.strength = bloomBase` only when no hold is stamped for the frame: fx's boss-death pulse (§8.7) wins.
  - A snap (`seconds = 0`: level start, title) always resets the strength to the base, even when a finite value was held that frame (r5-render-core clarification 5): a run never starts with the previous run's pulse.
  - On a High ⇄ Medium pass rebuild, the new pass is created with `_cur`'s strength (or the held value) and radius.
- **Grade.** `gradePass.uniforms` (they exist today): `uShadowTint`, `uShadowMix`, `uShadowLuma`, `uHighTint`, `uHighMix`, `uHighLuma`, `uSat`, `uVignette`, `uVigA`, `uVigB` from `_cur.grade`. `uDesat` stays fx's.
- **Gate panel.** `materials.gatePanel().uniforms.uRoadBg` = linear `_cur.road.asphalt`, the panel's near-background estimate.
- **Zombie eyes.** `ctx.models.setEyeGlow(_cur.zombie.eyesEmissive)`, guarded until models exists.
- **`rebuild()` (context restored).** Re-applies the current state — exposure, clear colour, fog colour, lights, shadow box, bloom, grade, `uRoadBg`, eye glow — from `_cur` (today it writes `RENDER.exposure` and `RENDER.fogColor`). It does not call `setDistrict` and does not touch the environment's layout (§3.4).
- **Low tier.** There is no composer and the material values are unchanged, so everything above still applies except bloom and grade, as today.

### 6.2 environment.js (Environment)

**Fog near / far.** `setDistrict(d, seconds)` drives `scene.fog.near` → `d.fog.near` and `scene.fog.far` → `params.fogFar × d.fog.farScale` on the district clock (§3.3) and cancels a running `setFog` lerp; a later `setFog` takes over. `applyQuality(params)` (it also runs from environment's own `quality:change` listener) writes `params.fogFar × district.fog.farScale` (today `params.fogFar`), into the active lerp's target when one runs. level's run-up and `_undoRuntimeState` pass the district's values (§8.5).

**Sky** (`SKY_FRAG`, `makeSkyMaterial`).

These existing uniforms are lerped:
- `uZenith`, `uUpper`, `uHorizon`, `uGlow`, `uSun` (`disc.color`), `uFog`;
- `uLit` (`skyline.litColor` × `skyline.lit`), `uStops`, `uFogMix`;
- `uSunDir` (from `disc.azimuthDeg` / `elevationDeg`, the same formula as today);
- `uSunK` (haloWide, haloTight, boost, horizonWarm), `uCloud` (opacity, drift x, drift z, awayDarken), `uSkyK` (skyline mix, dark);
- `uCols`, which switches at the swap-dip trough.

These uniforms are new (each line's D1 value is in parentheses):
- `uDisc` vec3 (edge outer, edge inner, mottle) replaces `smoothstep(0.9995, 0.9998, s)`. The disc term becomes `smoothstep(uDisc.x, uDisc.y, s) × uSunK.z × (1 − uDisc.z × grNoise((d − uSunDir).xy × 600.0))`. (D1: 0.9995, 0.9998, 0.)
- `uCloudCover` float: `c = smoothstep(0.52 − cover, 0.8 − cover, n)`. (D1: 0.)
- `uStars` vec2 (density, gain): `col += gain × step(1 − density, grHash(floor(d × 160).xy + floor(d × 160).z × 17.3)) × (1 − smoothstep(0.06, 0.38, length(fract(d × 160) − 0.5))) × (0.6 + 0.4 sin(uTime × (1.5 + 3h) + 40h)) × smoothstep(0.03, 0.15, y) × (1 − c × uCloud.x)`, added before the fog blend. (D1: 0, 0, so the term is exactly 0.)
- `uSkyLitTh` float replaces the literal in `step(0.965, …)`. Set it to `1 − skyline.litDensity`, computed in doubles on the CPU. (D1: 0.965.)
- `uSkyDip` float multiplies the skyline coverage: `outc = mix(outc, skc, sk × (0.65 + 0.35 × smoothstep(0.0, 0.03, y)) × uSkyDip)`. 1 outside a fade; 1 → 0 → 1 across `swapDip` (§3.3). (D1: 1.)
- `uCloudOff` vec2 (as built, r5-env-art): the cirrus position offset, integrated on the CPU across a drift change so the clouds never race during a fade. (D1: 0, 0.)

**Ground** (`GROUND_FRAG`).
- `uGrGround`, `uGrShoulder` and `uGrGrass` lerp from `d.ground`. The bands (`uGrBands`) never change.
- Night City pools on the shoulder: `uGrPool` (rgb × intensity; D1 0), `uGrPoolK` (radius x, radius z, lamp-head |x|, pitch) and `uGrLampPhase`, updated in `_sync()` as (RING_START + lamp offset + _dist) mod pitch.
- These shade |x| > 4.3 with the same pool term as the road, in world z. Curbs get no pool, which is accepted.

**Road** (new `onBeforeCompile`, `customProgramCacheKey 'gr:road'`). One program replaces the plain standard one; it is compiled at boot. ARCHITECTURE §9.1's "no onBeforeCompile on the road" is amended accordingly (the segments still move; the shader reads segment-local position). As built (r5-env-art decisions 1–2): `uGrWet` (vec3) adds a puddle reflection of the sky's horizon colour, `horizon × DISTRICT_RULES.puddleReflect (0.5) × Schlick fresnel × the puddle mask` — without it the darkened, low-roughness puddles read as black potholes in Overcast and Night — and the puddle roughness follows pud³ (the linear mix drew a glint ring around every puddle under a low sun). Both are 0 / inert at cover 0 (District 1, Ash). Art review (§14): near the camera the steep-view fresnel (≈ 0.02–0.05) still left the smooth puddles as black holes ringed by a bright crescent (they lose the rough asphalt's broad key-light sheen, and the rough → smooth rim catches it), so: the reflection factor is `max(0.02 + 0.98·F, puddleReflectFloor (0.3) × (1 − smoothstep(18, 35, view distance)))` (`DISTRICT_RULES.puddleFloorFadeM`; the floor is gone before the 36 px gate, so the integration's numbers there hold); the roughness switches inside the puddle only (`smoothstep(0.7, 1, pud)`); a chunk after `<lights_fragment_end>` scales the direct specular by `1 − 0.9 · smoothstep(0.45, 0.7, pud) · (1 − smoothstep(0.92, 1, pud))` (no crescent on the rim; the puddle core keeps its glint, the dry road its sheen); `road.puddleRoughness` 0.18 → 0.32. All inert at cover 0.

| Uniform | Meaning | D1 |
|---|---|---|
| `uGrAsphaltMul`, `uGrDashMul`, `uGrEdgeMul` vec3 | lin(d.road.X) / lin(PALETTE.road.X) per channel; dash and edge are told apart by u (`abs(vMapUv.x − 0.5) < 0.1` is the centre dash; the edge lines sit at u 0.044 / 0.956), paint by luminance (`smoothstep(0.08, 0.30, luma)`): `diffuseColor.rgb = t × mix(uGrAsphaltMul, mix(uGrEdgeMul, uGrDashMul, dashSel), paint)` | (1,1,1) ×3 |
| `uGrPuddles` vec2 (cover, roughness) | `pud = smoothstep(1 − cover, 1.08 − cover, grNoise(vMapUv × vec2(6, 12)))`; `roughnessFactor = mix(roughnessFactor, puddleRoughness, pud)`; `diffuseColor.rgb *= 1 − 0.25·pud`. There is no env map, so the sheen comes from the sun's specular lobe only: sharp puddle glints land near the squad (mirror point z ≈ +5 for Overcast's 56° light), the broad 0.55 sheen behind the gates | (0, 0.18), so pud is 0 |
| material `roughness` | `d.road.roughness` | 0.92 |
| `uGrPool` vec4 (rgb × intensity), `uGrPoolK` vec4 (rx, rz, head \|x\|, pitch), `uGrPoolZ` vec2 (left, right phase) | Segment-local pools: `dz = mod(local.z − phase + pitch/2, pitch) − pitch/2`, `dx = local.x ± head`, `m = pow(max(0, 1 − (dx/rx)² − (dz/rz)²), 3)`; `totalEmissiveRadiance += uGrPool.rgb × (diffuseColor.rgb + poolPuddleGlint (0.12) × pud) × (mL·row.x + mR·row.y)` (art review, §14: a puddle inside a pool mirrors the lamp; `uGrLampRow` = row, the title-rig lamp clearance below, (1, 1) in play). Heads at \|x\| = lamp.x − 1.12 (3.63); lamps stand at segment far edge + 1.0 + 15 j (left) and + 8.5 + 15 j (right); the mesh-local z of the centred segment differs by 15 m = one pitch, so the phases 1.0 / 8.5 hold in either frame | rgb 0 |
| curbs | `instanceColor` = lin(d.road.curb) / lin(PALETTE.road.curb), written as segments are placed | 1 |

**Buildings** (`gr:building`).
- `material.color` is a multiplier: lin(d.building.color) / lin(PALETTE.props.building). `material.emissive` = `windowColor`, `emissiveIntensity` = `windowEmissive`, `uGrDark` = `darkFraction`, `uGrBounce` = lin(fog) × `bounce` (lerped with the fog).
- **New `uGrWin` vec2 (add, drop)** for the lit-window fraction f against the baked 0.15:
  - add = max(0, (f − 0.15) / 0.85) and drop = max(0, (0.15 − f) / 0.15), both computed on the CPU;
  - per window cell, hashed from `floor(vMapUv × vec2(4, 2))` and the instance seed, `h1 < drop` zeroes the baked emissive;
  - `h2 < add` adds emissive × intensity × the window mask × the vertical gradient (1 → 0.55), using the `_drawWindows` layout: 4 windows × 2 storeys per 6 m tile, window 0.6 × 0.47 of the cell, 0.23 from the storey top;
  - D1: (0, 0).
- **New `uGrSnow` vec4 (lin(`building.snowColor`), `roofSnow`):** roof faces (|normal.y| > 0.5, `vGrRoof`) get `diffuse = mix(diffuse, snow, amount)`. D1 amount: 0.

**Lamp and slot-1 materials** (`gr:envlamp`, `gr:envblink`). As built (r5-env-art decision 3): `uGrUnlit` lets an unlit emissive part (unlit ooze, neon, reflector, lens) show its own dim hue instead of the clamped white of its excess-encoded colour (0 in District 1).
- Split the shared uniform object (today `beaconMat.onBeforeCompile = lampMat.onBeforeCompile` shares one closure and one `blinkU`): two closures, so each material owns `uGrEmitGain` and the beacon material its `uGrBlink`.
- `vGrEmit = max(color − 1, 0) × iEmit × uGrEmitGain`.
- Lamp gain = `d.lamps.gain` (the lamppost slot's material, so it also scales Toxic's puddle glow: Toxic's `lamps.gain` is 1). Beacon gain and blink = `d.beacon`.
- D1: gain 1; blink (4.2, −0.2, 0.4).
- **Lamp state per instance:** the lamps placer stores two bits per lamppost instance in a `Uint8Array(capacity)` allocated at build: upright (present and not broken) and seeded-lit (not "dark"). `lit` resolves to iEmit = upright && (lit === 'all' || (lit === 'mixed' && seededLit)). At the fade's 0.5 point (§3.3) the slot rewrites `iEmit` for its placed instances from these bits and uploads once.

**Smoke** (`env.smoke`).
- `uColBottom`, `uColTop`, `uEmber` (`emberColor` × `ember`), `uGlow` (= `d.sky.glow`), `uGlowBounce` and `uSmokeK.z` (alpha) lerp.
- Placement uses `d.smoke`: `chance`, `w`, `h`, and `anchor`. With an anchor, the smoke placer walks that slot's visible instances in the segment in index order and gives each one a column with probability `chance`, up to the smoke slot's `per` (2): base = the anchor instance's (x, z), y = `kind.smokeY` × the instance's y scale (smokestack 20.5; burning wreck 0.4).
- **Placement order:** place smoke after the other slots of its segment, so its anchors are known. This applies to non-D1 districts only. D1 keeps today's order and RNG stream.

**Weather** (`env.dust`).
- **Uniforms:** `uColor` = lin(color) × gain, `uOpacity`, `uSpeed` = drift, `uSize`, `uBox`. The `_onDustRender` centre uses the active district box (`box[1] × 0.5`, camera z − `box[2] × 0.5` − 1).
- **`_sync()`:** `uScroll = _dist mod box[2]` of the **active** box (today `ENV.dust.box[2]`). A box depth change at the swap trough (opacity 0) is invisible; a stale period would make every particle jump at each wrap.
- **New uniforms:** `uFall`, `uSway`, `uStreak`, `uSlant`, `uFlicker`.
- **Vertex shader.**
  - Drift becomes `(uTime·uSpeed + sin(…)·0.6·uSway, uFall·uTime + sin(…)·0.35·uSway, uScroll + cos(…)·0.6·uSway)`.
  - Twinkle becomes `mix(1, 0.55 + 0.45 sin(…), uFlicker)`.
  - `gl_PointSize` is unchanged. For streak kinds, `size` is the streak length (the sprite edge); the line inside it is thin. Rain at 0.22 m makes sprites of ≈ 29 px on average and ≤ 145 px near the camera on Medium (≤ 209 px on High): under every GPU's point-size limit (iOS reports 511).
- **Fragment shader.** When `uStreak > 0`: a slanted thin line, `(1 − smoothstep(0, uStreak, |p.x|)) × (1 − smoothstep(0.3, 0.5, |p.y|))` with `p` = gl_PointCoord − 0.5 rotated by `uSlant`. Otherwise today's disc.
- **Blending:** `material.blending` = Additive or Normal.
- **drawRange** = round(`params.dust` × `density`), also in `applyQuality` (today it writes `params.dust`).
- **D1:** fall 0, sway 1, flicker 1, streak 0, density 1. The output is identical.

**Prop slots** (§3.3, §7).
- Slot capacity = max(`RENDER.env.props[slot]`, 6 × max `per` of the slot's kinds). The tree slot grows from 40 to 60; every other slot keeps today's capacity.
- A slot's instance stride and `mesh.count` = 6 × the active kind's `per`. For D1 the visible result is identical, because today's extra capacity is always hidden. (Hidden instances still run the vertex shader: vertex work = 6 × per × tris per slot, §9.)
- `mesh.castShadow` = `kind.castShadow !== false` (smokestack and puddle cast none; the slot keeps today's flag otherwise). Set at a snap and at a swap.
- **D1 keeps today's placement byte for byte:** the same per-segment seed (`levelSeed·propSeedMult + index`), the same single RNG stream, the same placer order, and the same per-segment counts (`per` = floor(RENDER.env.props / 6)).
- New kinds use the placer named in `DISTRICT_PROPS` with their `layout`, per the placer contract of §7.2.

### 6.3 models.js

- `setEyeGlow(v)`. Today's eye emissive comes from `PALETTE.zombie.eyesEmissive` (`uEyeEmissive`, models.js ≈ 1395).
- It writes `v` to `uEyeEmissive` of the five zombie classes only (walker, runner, crawler, brute, spitter). The uniform drives every 0.5-tagged piece: eyes and the spitter's acid sacs. Soldier classes keep theirs.
- **Bosses are not touched.** Their glow lives on per-rig `MeshBasicMaterial` clones whose colour boss.js rewrites every frame from `rig.glowBase` (rage pulse, sac breathing; boss.js ≈ 1691); a write from models would be overwritten the next frame. Boss eyes stay at `PALETTE.boss.eyesEmissive` in every district (a boss is close and large).
- It does uniform writes only, never a recompile.
- D1: 1.5.

---

## 7. models.js: new prop geometries

All 16 follow the environment-prop convention:
- merged primitives (`mergeProps`), indexed;
- attributes `position`, `normal`, `uv` (kept, unused) and `color` (linear, itemSize 3);
- no uv1, tangent or morph attributes;
- feet at y = 0, origin at the footprint centre; the long axis of chain / scatter kinds is local x, of cars-placer kinds local z (nose −z), "front" is +z;
- for kinds on the two emissive slots (barricade, lamppost), emissive parts encode radiance as colour excess over 1.0: `1 + lin(hex) × emissive`, gated per instance by iEmit (`mergeProps`' colourise step needs that variant; the built-in barricade and lamppost do the same with `paintRGB`).

Shape counts are approximate triangle budgets. Colours come from `DISTRICT_PROPS[kind].colors` and never from literals. Each geometry must fit its `half` extents (data) and, for cars-placer kinds, its `poseY` heights.

| geo name | slot | Size and local frame | Construction | ≈ tris | Palette (data) |
|---|---|---|---|---|---|
| `barrier` | barricade | 3.0 (x, along the road) × 1.07 × 0.6 m | F-shape concrete highway barrier: footing, two stepped slopes, top; a worn white band; stain blotches; 3 amber reflector studs per face (emissive 1.4, Overcast keeps them unlit) | 220 | concrete #A4A39C, stripe #E8E4D8, stain #6E6A62, reflector #FFB02E |
| `cones` | sandbags | cluster within r 0.8 m | 3 traffic cones (r 0.17 → 0.03, h 0.7, 12 seg, 2 white bands, black square bases) plus 1 orange drum (r 0.29, h 0.9, 12 seg, 2 bands) | 300 | cone #F06A2A, band #F2F2EA, base #2A2A30, drum #E8662A |
| `billboard` | tree | 6.8 × 9.6 m; board faces +z (toward the camera) | 2 I-beam posts at x ±2.2 (to 6.3 m); catwalk with railing at 6.2 m; board 6.8 × 3.2 × 0.25 at 6.4–9.6 m split into 3 faded colour blocks with a pale margin; back bracing (depth ≤ 1.2 m) | 190 | post #5A5A5E, frame #3A3A3E, panel [#C8B48A, #8AA4B4, #B4786A], faded #D8D2C4 |
| `truck` | rubble | 8.8 (z, nose −z) × 2.5 × 3.2 m | Box truck: cab 2.4 × 2.3 × 2.0, box 2.5 × 2.7 × 6.4, chassis rails, 6 wheels (r 0.5, 10 seg), windscreen. Cab and box are near-white (0.95); the cars placer writes one `paint` per instance into instanceColor; poses on its side 35 % (y 1.25), on its roof 5 % (y 3.2), jackknifed by yawJitter | 420 | paint [#D8D4CC, #9AA6B0, #B04A3A, #C8C2B4], chassis #2A2A2E, glass #1C2430, tyre #1E1E1E, rust #6B3A1E |
| `neon` | barricade | blade sign 1.2 (x) × 2.4 (y) × 0.2 (z), face +z, on a 0.1 m pole with a bracket, sign 2.6–5.0 m | Dark box; on both faces neon tubes as thin boxes (0.06 m): a magenta border, a cyan word bar (3–4 strokes), an amber arrow. All three colours are in every sign (the excess encoding is per vertex) | 160 | box #26262E, pole #3A3A40, tubes [#FF4FD8, #46F2FF, #FFB347], emissive 2.6 |
| `barrel` | barricade | cluster within r 0.9 m (puddle included) | 3 upright drums (r 0.29, h 0.88, 12 seg) of the three drum colours, 2 dark bands and a yellow hazard label each; 1 tipped drum; an irregular ooze puddle disc (r 0.6–0.9, y 0.01, centred on the cluster) and drips on the tipped lid in ooze (emissive 2.2) | 380 | drum [#C8A020, #2E5A8A, #8A3A2A], band #2A2A2A, hazard #E8C020, ooze #A8FF3A |
| `container` | sandbags | 6.06 (x) × 2.59 × 2.44 m | ISO container: body (near-white 0.9, so the instance `paint` colours it); 10 vertical ribs per long side at 0.75; door bars at +x; corner castings | 140 | paint [#8A4A2A, #2E6A6A, #707070, #A88A3A], rib #2A2A2E, door #4A4A4E |
| `smokestack` | tree | r 1.1 → 0.8, top y 20.5 m | Tapered brick cylinder (10 seg); white and red bands near the top; dark cap ring; side ladder (thin boxes); plinth 2.8 × 1.2 × 2.8. The smoke slot anchors a plume at `smokeY` × scale. Casts no shadow (it stands 15–26 m out; its upper part lies beyond the shadow camera's near plane, so its shadow would be cut mid-length) | 260 | brick #6A3A2A, band [#E8E4D8, #B83A2E], cap #2A2624, ladder #4A4A4E |
| `pipe` | rubble | 6.0 (x) × 2.3 × 1.0 m | Pipe rack section: 2 pipes (r 0.22 and 0.32, 10 seg) at y 1.2 / 1.9 on 2 H-supports at x ±2.4; a valve wheel; rust patches. Chains end to end along the road | 300 | pipe [#8A8A70, #B0A040], support #4A4A4E, rust #6B3A1E, valve #B83A2E |
| `puddle` | lamppost | 1.6 × 1.2 m, y 0.012 | Irregular flat blob: a 14-segment disc with fixed-seed radii; dark rim ring plus an inner ooze area (emissive 1.8). The lamp material's metalness makes the rim read wet. Casts no shadow (a flat decal 4 cm above the ground) | 60 | rim #3A3C24, ooze #A8FF3A |
| `burningWreck` | barricade | 4.2 (z) × 1.8 × 1.3 m | Charred sedan shell (the car silhouette with a crushed roof and no glass, holes in #141414), rust patches, 5–6 ember patches along the sills, wheel wells and engine bay (emissive 2.8, fast flicker from the slot blink). Geometry colours are final (no instance paint). The smoke slot anchors a black plume with an ember base at y 0.4 | 420 | char #2A2422, rust #5A2E1A, glass #141414, ember #FF6A1A |
| `dune` | sandbags | 8 (x) × 1.0 × 4.4 m before scale | Flattened half-ellipsoid (12 × 6 seg) plus a thinner offset crest; vertex colour by height, sand → crest, with ash patches near the base | 120 | sand #8A6A44, crest #A88458, ash #4A403A |
| `rock` | rubble | cluster within r 1.0 m | 3 boulders (IcosahedronGeometry(r, 0), fixed-seed scale and rotation) plus 2 stones, one rock colour per boulder | 140 | rock [#6A5E54, #7A6E62, #54504C] |
| `snowbank` | sandbags | 4.5 (x) × 0.9 × 1.6 m | 3 overlapping flattened half-ellipsoids along x; white tops, blue-grey shaded flanks, a grey slush band at the base | 100 | snow #E4ECF4, shade #B8C6D4, dirt #6E7884 |
| `frozenCar` | car | as the car: 4.2 (z) | The environment car parts (same proportions) plus snow caps on the roof, hood, trunk and bumpers (roof cap ≤ 0.15 m: on its roof it rests at y 1.52), and 4–6 icicles along the roof edge. Body near-white 0.95; the placer writes frost(paint) = mix(paint, frost, 0.6) so the snow stays near-white | 560 | snow #F0F4F8, ice #B8D0E0, frost #E4ECF4 (plus PALETTE.props car parts) |
| `pine` | tree | about 6.5 m tall before scale, crown r 1.6 | Trunk (r 0.12 → 0.2, h 1.2, 7 seg); 4 stacked cones (r 1.6 → 0.6, h 1.6, 9 seg) in alternating needle greens, each with a white snow cap cone | 200 | trunk #4A3A2E, needles [#2E4A3A, #3A5444], snow #EEF4F8 |

`burntTree` reuses `tree` with the Ash Wasteland tint (no new geometry). `streetlight` and the highway lamps reuse `lamppost`.

### 7.1 Placement (`DISTRICT_PROPS`)

Per kind: the slot it may occupy, instances per 30 m segment (`per`), the triangle budget, the environment placer, its half extents and its layout. Built-in kinds keep `RENDER.env.layout` unchanged. In `x`, the band is |x| of the instance centre from the road centre line in metres.

| kind | slot | per segment | ≈ tris | placer | half [hx, hz] | layout and extras |
|---|---|---|---|---|---|---|
| barricade | barricade | 8 | built-in | chain | — | RENDER.env.layout.barricade |
| sandbags | sandbags | 5 | built-in | scatter | — | RENDER.env.layout.sandbags |
| car | car | 4 | built-in | cars | — | RENDER.env.layout.car |
| building | building | 5 | built-in | buildings | — | RENDER.env.layout.building |
| tree | tree | 6 | built-in | scatter | — | RENDER.env.layout.tree |
| rubble | rubble | 8 | built-in | scatter | — | RENDER.env.layout.rubble |
| lamppost | lamppost | 4 | built-in | lamps | — | RENDER.env.layout.lamp |
| smoke | smoke | 2 | built-in | smoke | — | RENDER.env.layout.smoke |
| barrier | barricade | 6 | 220 | chain | [1.5, 0.3] | x [4.9, 5.5], chain 3.05, maxChain 4, yaw along, jitter 0.1, diagonal 0, toppled 0.05, emitOn 0 |
| cones | sandbags | 5 | 300 | scatter | [0.8, 0.8] | x [5.4, 6.8], yaw random, scale [0.9, 1.15] |
| billboard | tree | 1 | 190 | scatter | [3.4, 0.6] | x [10, 14], yaw face, jitter 0.35, scale [0.9, 1.1], chance 0.6 |
| truck | rubble | 1 | 420 | cars | [1.25, 4.4] | x [8.2, 11], cross 0.15, flipped 0.05, onSide 0.35, yawJitter 0.5, burnt 0, dark [0.75, 1], chance 0.7; poseY [3.2, 1.25] |
| neon | barricade | 3 | 160 | chain | [0.6, 0.1] | x [8.8, 10.2], chain 1, maxChain 1, yaw face, jitter 0.4, diagonal 0, toppled 0, emitOn 0.92 |
| barrel | barricade | 6 | 380 | chain | [0.9, 0.9] | x [5.4, 7.4], chain 1.4, maxChain 2, yaw random, jitter 0, diagonal 0, toppled 0, emitOn 0.7 |
| container | sandbags | 2 | 140 | scatter | [3.03, 1.22] | x [8, 12.5], yaw along, jitter 0.25, scale [1, 1] |
| smokestack | tree | 1 | 260 | scatter | [1.4, 1.4] | x [15, 26], yaw random, scale [0.85, 1.25], chance 0.75; smokeY 20.5; castShadow false |
| pipe | rubble | 3 | 300 | chain | [3.0, 0.5] | x [6.4, 7.6], chain 6, maxChain 3, yaw along, jitter 0.04, diagonal 0, toppled 0, emitOn 0 |
| puddle | lamppost | 4 | 60 | scatter | [0.8, 0.6] | x [5.6, 8], yaw random, scale [0.8, 1.3], emitOn 1; castShadow false |
| burningWreck | barricade | 2 | 420 | cars | [0.9, 2.1] | x [6.6, 9.6], cross 0.2, flipped 0.15, onSide 0.1, yawJitter 0.9, burnt 0, dark [1, 1], emitOn 1; poseY [1.3, 0.9]; smokeY 0.4 |
| dune | sandbags | 3 | 120 | scatter | [4.0, 2.2] | x [8.5, 15], yaw along, jitter 0.6, scale [0.8, 1.6], squash [0.7, 1.2] |
| rock | rubble | 6 | 140 | scatter | [1.0, 1.0] | x [6, 14], bias shoulder, yaw random, scale [0.6, 1.6], squash [0.6, 1.1] |
| snowbank | sandbags | 4 | 100 | scatter | [2.25, 0.8] | x [5.9, 7.4], yaw along, jitter 0.15, scale [0.9, 1.4] |
| frozenCar | car | 4 | 560 | cars | [0.9, 2.1] | x [6.7, 9.8], cross 0.15, flipped 0.05, onSide 0.04, yawJitter 0.9, burnt 0, dark [0.72, 1], frost 0.6; poseY [1.52, 0.9] |
| pine | tree | 10 | 200 | scatter | [1.6, 1.6] | x [7.8, 16], yaw random, lean 0.05, scale [0.8, 1.5] |

### 7.2 Placer contract (non-builtin kinds)

The built-in kinds keep today's routines and `RENDER.env.layout` byte for byte. For the 16 new kinds, each placer reads only the keys below; a key the kind leaves out takes the default in brackets — **never** the `RENDER.env.layout` value of the built-in kind of that slot (e.g. a burning wreck must not inherit the car's `burnt` 0.22 and get repainted in car colours).

**Common to every placer**
- Instance index range of segment k: `[k × per, (k + 1) × per)`; unused indices are hidden (zero matrix, iEmit 0).
- **Count:** count placers use today's `_count(per)` with the slot weight folded in: `round(per × weight × density × U(densityFloor, densityFloor + densitySpread))`, clamped to [0, per].
- **Chance-gated kinds** (`layout.chance` present; per 1 in the data): place `per` candidates, each present with probability `chance × weight × min(1, density × (densityFloor + densitySpread / 2))` (= 0.95 × density). `_count`'s rounding gave a per-1 kind almost nothing on Low (round(0.4 × U(0.6, 1.3)) is 1 in 7 % of segments).
- **Edge clearance:** after choosing x, yaw and scale, the placer clamps |x| ≥ `DISTRICT_RULES.edgeClearX` + across × scale, where across = |cos yaw| × hx + |sin yaw| × hz (local x maps to world (cos yaw, 0, −sin yaw), local z to (sin yaw, 0, cos yaw)): an 'along' chain / scatter kind (yaw π/2) gives hz, a car-frame kind along the road (yaw 0 or π) gives hx, a crossed one ≈ hz. Random-yaw kinds use max(hx, hz) (their footprint is a circle). Poses on a side or roof swap the across extent for the matching height (poseY) — use max(across, poseY[1]) for on-side poses. The data bands are set so the clamp only acts on outliers (validator).
- **Tint:** today's `_tintJitter(LAYOUT.tintJitter)` per instance, then × the slot's `tint` when present.
- **iEmit** (emissive slots only): 1 with probability `emitOn` [0], except toppled / on-side / on-roof poses (0).

**chain** (barricade routine): `x` band, `chain` spacing (m) [2], `maxChain` [1], `yaw` 'along' (long axis along the road: π/2) | 'face' (front +z toward the camera: 0) | 'random' (U(0, 2π)) ['along'], `jitter` = yaw jitter, full range (rnd − 0.5) × jitter (rad) [0], `diagonal` = share of 'along' chains turned 0.7 rad toward the road side [0; ignored for other yaws], `toppled` share [0] (pose: lying on its side, y = hz, pitch ±π/2), `emitOn`. Chain members are offset along the chain's local x by `(c − (n − 1) / 2) × chain`, plus today's ±0.075 m position jitter.

**scatter** (sandbags / tree / rubble routine): `x` band, `bias` 'shoulder' (today's rubble x² bias toward the inner edge) [none: uniform], `yaw` as above ['random'], `jitter` [0], `scale` [1, 1] uniform, `squash` [1, 1] (y scale × U(squash)), `lean` [0] (pitch / roll ± lean / 2, the tree rule), `chance` [none], `emitOn`. A kind with `colors.paint` (the container) takes the cars rule's paint: one paint from the list × U(`dark`) per instance (integration amendment, r5-env-art decision 4: without it the near-white container body rendered white).

**cars** (car routine): `x` band, `cross` share (yaw π/2 ± 0.3) [0], `flipped` share (on its roof: roll π, y = poseY[0]) [0], `onSide` share (roll ±π/2, y = poseY[1]) [0], `yawJitter` (rad, full range, along-road poses at yaw 0 or π) [0], `chance` [none], `emitOn`. Instance colour, in this order:
- kind has `colors.paint` (truck): one paint from the list × U(`dark`) [dark [1, 1]], or the burnt rust tint with probability `burnt` [0];
- kind has `layout.frost` (frozenCar): paint from `PALETTE.props.car` × U(dark), then `mix(paint, colors.frost, frost)`; burnt [0];
- otherwise (burningWreck): neutral `_tintJitter` only; the geometry colours are final.

**Smoke anchors:** §6.2 Smoke.

**Buildings** (built-in kind, district overrides): near-row presence = min(1, weight × (B.present + (1 − B.present) × density)); far-row presence = min(1, `layout.far` [1] × (B.farPresent + (1 − B.farPresent) × density × 0.5)), with B = `RENDER.env.layout.building` (District 1 reduces to today). `storeys` / `farStoreys` overrides replace the ranges.

**Lamps** (built-in kind): §2 lamp rules; presence for `layout: 'mixed'` = (L.present + (1 − L.present) × density) × weight; `'all'` ignores density and weight; `layout.broken` overrides L.broken.

---

## 8. Module interface contract

### 8.1 data.js (in the tree)

```js
export const DISTRICTS: readonly District[6];            // deep-frozen; index 1..6; DISTRICTS[0] reads WORLD / RENDER / PALETTE
export const DISTRICT_PROPS: Record<kind, PropKind>;     // the 8 built-in kinds + 16 new
export const DISTRICT_RULES: { slots: string[8], levelsPerDistrict: 5, endlessChunksPerDistrict: 3, fadeSeconds: 4,
  fadeGateClearZ: -26, fadeDeferMaxM: 150, fadeNextGateFrac: 0.8, swapDip: [0.45, 0.55], hiddenBeyondZ: -100, edgeClearX: 4.5,
  puddleReflect: 0.3,                                    // round-5 integration: the uGrWet puddle reflection gain (§6.2 Road; 0.5 → 0.3, §13)
  puddleReflectFloor: 0.3, puddleFloorFadeM: [18, 35],   // round-5 art review: reflection floor near the camera, faded out by 35 m (§6.2 Road, §14)
  poolPuddleGlint: 0.12,                                 // round-5 art review: a puddle inside a light pool adds pool radiance × this (§14)
  banner: { seconds: 1.6, inSeconds: 0.22, outSeconds: 0.3, risePx: 6 } };
export function districtForLevel(L: number): District;   // ⌊(L−1)/5⌋ mod 6; non-finite or < 1 → DISTRICTS[0]
export function districtForChunk(D: number): District;   // ⌊(D−1)/3⌋ mod 6; non-finite or < 1 → DISTRICTS[0]

PropKind = { slot, per, placer: 'chain'|'scatter'|'cars'|'buildings'|'lamps'|'smoke', builtin: true }
         | { slot, per, placer, tris, half: [hx, hz], layout, colors, emissive?, poseY?: [roofY, sideY], smokeY?, castShadow?: false }

District = { id: 'sunset'|'overcast'|'night'|'toxic'|'ash'|'frozen', index, name, label, levels: [first, last], accent,
  sky: { zenith, upper, horizon, glow, stops[4], fogMix, disc: { color, azimuthDeg, elevationDeg, edge[2], boost, haloWide, haloTight, mottle },
         horizonWarm, awayDarken, cloud: { opacity, cover, drift[2] }, stars: { density, gain },
         skyline: { mix, dark, cols, lit, litDensity, litColor } },
  fog: { color, near, farScale, runupNear },
  sun: { color, intensity, offset[3], titleAzimuthDeg },  hemi: { sky, ground, intensity, title },
  exposure, bloom: { strength, radius, threshold },  grade: { shadowTint, shadowMix, shadowLuma, highlightTint, highlightMix, highlightLuma, saturation, vignette: { strength, a, b } },
  road: { asphalt, dash, edge, curb, roughness, puddles, puddleRoughness, pools: null | { color, intensity, radius[2] } },
  ground: { ground, shoulder, grass },
  building: { color, roofSnow, snowColor, litFraction, windowColor, windowEmissive, darkFraction, bounce },
  props: { [slot]: { kind, weight, layout?, tint?[3] } },          // all 8 slots; building: weight ≤ 1.25, layout.far
  lamps: { layout: 'mixed'|'all', lit: 'mixed'|'all'|'none', gain },  beacon: { gain, blinkRate, blinkDuty[2] },
  smoke: { bottom, top, emberColor, ember, alpha, glowBounce, chance, anchor: null|slot, w[2], h[2] },
  weather: { kind: 'dust'|'rain'|'ash'|'spores'|'embers'|'snow', color, gain, opacity, blend: 'add'|'normal', density, size, drift, fall, sway, streak, slant, flicker, box[3] },
  zombie: { eyesEmissive } }
```

Every district has exactly District 1's key tree. `node TR/tools/validate-districts.mjs js/data.js` checks the schema, District 1 identity, mapping, capacities and the review's rules (weather brightness, light azimuth, pools vs lamps, smoke anchors, kind extents and edge clearance); `EV/tools/validate-districts.mjs` predates the §12 schema and fails on it.

### 8.2 render.js

```js
setDistrict(district, seconds = 0): void   // §6.1; theatre clock (0 = snap before the next draw); forwards env.setDistrict(district, seconds); idempotent; allocation-free
get district(): District                   // the target district (DISTRICTS[0] until the first call)
get bloomBase(): number                    // _cur.bloom.strength
get titleBlend(): number                   // art review (§14): eased title idle-rig weight (0 in play) — read by env's title-rig lamp clearance
setBloomStrength(v?): void                 // unchanged; non-finite v → bloomBase (was RENDER.bloom.strength); finite v holds for the frame
warmup(onProgress): Promise<void>          // also draws env.districtWarmList() pairs once (§3.6)
rebuild(): void                            // re-applies _cur (no setDistrict, no layout) (§3.4)
```

### 8.3 environment.js

```js
setDistrict(district, seconds = 0): void   // §3.3 / §3.4 / §6.2; seconds 0 = snap and _layoutAll; > 0 = uniform fades, fog near / far, swap dip, lit switch, slot drain → swap → refill
districtWarmList(out = []): Array<{ mesh, geometry }>   // every slot mesh × every alternative kind geometry (adopts ctx.models.geo lazily)
get district(): District
setFog(near, far, lerpSeconds)             // unchanged; a call during a district fade takes near / far over
setLevel(seed, propDensity)                // unchanged; lays the ring out with the active district's kinds
applyQuality(params)                       // fog far × district farScale, dust drawRange × weather density (§6.2)
```

Art review (§14): every frame `_titleClear()` reads `render.titleBlend` and the camera's x and writes `uGrLampRow` (vec2, left / right lamp row, 1 = shown): a row within [1.8, 2.8] m of the camera's x is scaled to its feet by the lamp material (`LAMP_VERT_ROW`; the beacon material never clears), its light pools fade with it (road and ground) and the lamp slot casts no shadow meanwhile. Only the landscape / desktop title rig (camera x 4, 0.75 m inside the right row) clears a row; play and the portrait title see (1, 1).

### 8.4 models.js

```js
geo.barrier, geo.cones, geo.billboard, geo.truck, geo.neon, geo.barrel, geo.container, geo.smokestack, geo.pipe, geo.puddle,
geo.burningWreck, geo.dune, geo.rock, geo.snowbank, geo.frozenCar, geo.pine   // §7, built in ModelLibrary.init()
setEyeGlow(v: number): void                // §6.3: the five zombie classes' uEyeEmissive (eyes + sacs); bosses untouched
```

### 8.5 level.js and events

- `get district(): District`.
- **`_beginRun`** (start, startEndless, restart):
  1. After `_undoRuntimeState` — which now calls `render.setBloomStrength()` with no argument and `env.setFog(d.fog.near, params.fogFar × d.fog.farScale, 0)` — and before `env.setLevel`, call `render.setDistrict(d, 0)`. Here d = `districtForLevel(level)`, or `districtForChunk(1)` for endless.
  2. Set `P_START.district = d.id` and emit `level:start`.
  3. Emit `district:change` with `reason 'start'`.
- **Run-up:** `env.setFog(d.fog.runupNear, params.fogFar × d.fog.farScale, 1)`.
- **`quitToTitle()`:** `render.setDistrict(districtForLevel(save.data.highestUnlocked), 0)` and `district:change` with `reason 'title'`, `banner: false`.
- **Endless `step()`:** the rotation of §3.2. level tracks `lastGatesAt` (set in `_fireGates`) and finds `nextGatesAt` by scanning forward from `_cursor` for the first `'gates'` event (a short scan, only while a rotation is due).

| Event | Emitter | Payload |
|---|---|---|
| `level:start` | level | `{ level, seed, endless, script, district }` (adds `district`, the id string) |
| `district:change` | level | `{ id, name, index, label, accent, seconds, reason: 'start'\|'rotate'\|'title', banner }`, emitted after `level:start` at a run start; a reused payload object |

Listeners:
- ui (banner, §5);
- audio, optionally (no change required);
- fx, nothing;
- render does not listen: level calls it directly, like today's `setFog` and `setBloomStrength`.

### 8.6 ui.js, index.html, css

ui:
- caches `#district-banner`;
- on `district:change` stores the label and accent and sets a dirty bit;
- `ui.update` shows and animates the banner per §5 (DOM writes only in `update`) and toggles `#hud.pu-on`;
- hides it on `level:start` and on state exit.

css adds `#district-banner`, `.pu-on` placement and the reduced-motion variant. index.html adds the element; artifact.html is regenerated.

### 8.7 fx.js

The boss-death bloom pulse (fx.js ≈ 1454, ≈ 2727) peaks at `render.bloomBase + (RENDER.bloom.deathPeak − RENDER.bloom.strength)` and returns to `render.bloomBase`; its per-frame `setBloomStrength(v)` holds the strength against a running fade (§6.1).

### 8.8 Call order

| Moment | Order |
|---|---|
| Boot | step 5 `Environment.build` (District 1, tree capacity 60) → step 6 models (16 geometries) → step 9b `render.warmup` (+ `districtWarmList`) → step 10 `quitToTitle` → `render.setDistrict(title district, 0)` |
| Level start | `_undoRuntimeState` → `render.setDistrict(d, 0)` (→ `env.setDistrict(d, 0)`) → `env.setLevel(seed, density)` → system resets → `state 'playing'` → `level:start { district }` → `district:change` |
| Endless rotation | `step()`: boundary reached, gates clear, next gate far enough, no live boss (or 150 m past the boundary) → `render.setDistrict(next, 4)` → `district:change { reason 'rotate' }` → fades over 4 s (swap dip 0.45–0.55, lamps lit at 0.5); changing slots empty from ≈ 60 m to ≈ 180 m after the call, refilling from the fog |
| Title | `quitToTitle()` → `render.setDistrict(districtForLevel(highestUnlocked), 0)` → `district:change { reason 'title', banner: false }` |
| Context restored | `render.rebuild()` re-applies `_cur` (uniforms, lights, shadow box); no layout |

---

## 9. Performance budget

| Item | Today | Districts |
|---|---|---|
| Main-pass draws | about 44 typical, ≤ 50 | unchanged by districts (8 prop slots, manhole, curbs, sky, ground, road, smoke, dust): measured equal in every district at the same gameplay moment (Toxic −2 shadow: smokestacks and puddles cast none). Round-5 integration: the six road segments became ONE draw (merged planes moved in the vertex shader, ARCH §9.1) — gameplay content (3+ troops, five zombie types, the label overlay) had pushed heavy frames to 51–54 main draws in every district |
| Shadow / post draws | about 20 / ≤ 14 | unchanged (same casters, same composer); −1 shadow draw while a smokestack or puddle slot is shown |
| Programs | n | n: the road gains one `gr:road` program that replaces the plain standard road program; sky, ground, building, lamp, beacon and dust programs are edited, not added |
| Prop instances × tris (vertex work, incl. manhole and curbs; hidden instances run the vertex shader too) | about 63 k tris (Sunset Boulevard, with the stride = 6 × per rule) | 46–59 k in every other district (Frozen highest: frozen cars 24 × 560, pines 60 × 200); never above Sunset; casting slots run again in the shadow pass, as today |
| Weather points | 300 / 150 / 0 | ≤ the same (density ≤ 1) |
| Weather fill (blended sprite area) | dust 0.9 % of a Medium frame | rain 18 % of a Medium frame (36 % High), every other kind ≤ 3.5 %; the rain fragment is a few ALU ops, so the cost is blend bandwidth (≈ 0.13 Mpx on Medium) |
| Geometry memory | — | + roughly 0.3–0.5 MB (16 kinds, ≈ 4 k tris), uploaded at boot; instance buffers grow by 20 tree matrices (+1.3 KB) |
| Boot | — | models + about 10–20 ms for 16 merges (sliceable through `initStep` if a boot gap nears 300 ms at 4×); warm-up + 16–40 draws |
| Fade frame | — | about 60 uniform writes, one light-basis rebuild and one shadow projection update; zero allocations; one iEmit upload at the lamps' 0.5 point |
| Level start | `setLevel` re-layout | + `setDistrict` snap (uniform writes, geometry pointer swaps, one extra `_layoutAll` ≈ 0.3 ms); no uploads, no links (warmed) |

---

## 10. Acceptance checklist (for the implementers)

Test output goes under `E:/Temp/claude/gate-rush-evidence/r5/<your name>/`.

1. **District 1 pixel identity.** On the snapshot procedure of `EV/tools/proto.mjs`, compare L1 frames before and after at seed 1001 on Low, Medium and High: max channel difference ≤ 1 / 255 outside particles. The road, sky (including `uSkyDip` = 1), ground, building, lamp, beacon, dust, smoke and shadow-box edits must all reduce exactly (`sun.shadow.camera.bottom === RENDER.sun.frustum.b` in District 1).
2. **District 1 placement identity.** After `env.setLevel(seed, density)` for seeds 1–5 and 1001–1005 at each tier density, a hash of every slot's visible instance matrices and colours is unchanged against today.
3. **Readability, two passes.** Re-run `EV/tools/proto.mjs` against the implemented `render.setDistrict` (replace `__proto.apply` with `g.render.setDistrict(d, 0)`) on Low, Medium and High, then `final-analyze.mjs`:
   - **bare** (as today: dressing hidden, weather and smoke off) — every row passes §4.3;
   - **full dressing** — props laid out by `setLevel` (a seed whose first segments put a lamp, a neon sign, a barrel / puddle, a burning wreck and a snowbank within 10 m of each gate depth), weather and smoke visible, `uTime` running while the scroll is frozen; 30 reads 0.1 s apart per row; the median passes §4.3 and the 10th percentile reaches 85 % of the floor. A failing row walks the fallback ladder of §4.4.
4. **Data.** `node TR/tools/validate-districts.mjs js/data.js` reports ok.
5. **Hitch.** `node tools/smoke.js --scenario play --level N --quality med --shots 30` for N = 1, 6, 11, 16, 21, 26 (and `--quality high`): no frame over 50 ms in the first 2 s, and draw calls within budget.
6. **Endless rotation.** An endless run past chunk 7 (`--endless --seconds 240 --pre` with a strong profile) has these properties:
   - two rotations, each fading in 4 s with no frame over 50 ms;
   - every rotation started with no gate inside z < −26, the next gate ≥ 0.8 × 4 s × v ahead and no boss alive (or 150 m past the boundary);
   - no prop is visible as a pop, and no skyline column jump outside the dip;
   - every changing slot is empty for at most about 120 m of visible road, then refills from the fog;
   - weather and skyline swap at the trough;
   - at the 2 → 3 rotation (L-equivalent Overcast → Night): every light pool has a lit lamp above it at the end of the fade.
7. **Banner.** It shows at L6 start (not on an L6 RETRY), at endless chunk 4 and 7, and never on the title. It sits under the progress bar, moves down a row with a power-up pill and hides under the boss bar. Reduced motion uses opacity only.
8. **Title.** With `highestUnlocked` 14 the title shows Night City with the moon right of centre, clear of the buttons and the logo; with 3, Sunset Boulevard.
9. **HUD over the sky band.** Screenshots at the start of L6, 11, 16, 21 and 26 (Medium, 390 × 844, with and without a 47 px safe-top): the LEVEL label, coin count, progress bar, a power-up pill and the banner are legible in every district; Frozen is the stress case (§4.7).
10. **Shadows.** In every district on Medium, a zombie walking down the road centre gains its shadow at z ≈ −23 or further (debug: `g.render.lights.sun.shadow.camera.bottom` equals §6.1's formula; `TR/tools/shadowbox.mjs` gives the reach for the data).
11. **Edge clearance.** After `setLevel` in each district at High density, no non-builtin instance's footprint (|x| − across × scale) is under 4.5 m (a one-off debug scan of the slot instance matrices with the kinds' `half`).
12. **Weather cost.** `--quality med --level 6` vs `--level 1` on the round-3 throttle profile (`E:/Temp/claude/gate-rush-evidence/r3/` throttle.mjs): median frame time within +0.5 ms.
13. **Gate legibility on screenshots** (art review, §14). The tool is `E:/Temp/claude/gate-rush-evidence/r5/art-review/tools/legibility.mjs <tier> <out> "" 4 -36` and `… 3 -26`, then `leg-analyze.mjs`. The check covers every gate type: +, ×, −, ÷, ×1, item, MAX, a flipped −, a flipped ÷ (×2) and a × at its cap. In every district, on Low, Medium and High, at the armed line and the 36 px point, glyph : panel must be ≥ 3 : 1, the item icon judged on its main colour (p90).
14. **Title clearance** (art review, §14). On the desktop / landscape title rig no lamp crosses the frame (`titles.mjs <out> auto desktop`, second frame of each district). With `render.titleBlend` 0, `env._lampRowU.value` is (1, 1).

---

## 11. Evidence and tools

`E:/Temp/claude/gate-rush-evidence/r5/artdir/` (`EV/`):

| Path | What |
|---|---|
| `districts-{med,high,low}.png`, `districts-title-med.png`, `districts-zombies-med.png` | Palettes before the review, applied live (lighting, fog, sky, grade, road and building tints; no new props yet) |
| `final/readability-final-{low,med,high}.md`, `final/run{1,2}/measure-*.json`, `final/analytic.md` | §4.2 and §4.4 tables and raw pixel samples (bare pass) |
| `proto-v2`, `proto-v3`, `proto-v4`, `proto-va`, `proto-vb`, `proto-vc` | Earlier iterations and rejected variants (§4.5) |
| `tools/proto.mjs` | Live prototype and pixel measurement (headless Chrome, snapshot `snap/`) |
| `tools/evalcore.mjs`, `readability.mjs`, `colormath.mjs`, `sweep.mjs`, `transitions.mjs`, `analytic-table.mjs` | Analytic model (ACES, grade, CIEDE2000, gate fog and panel maths) |
| `tools/analyze.mjs`, `final-analyze.mjs` | Floors and verdicts from measurements |
| `tools/validate-districts.mjs` | The pre-review validator (superseded by `TR/`) |
| `tools/doc-tables.mjs` | Regenerates the §2 tables from `js/data.js` (needs the §12 schema: lamps layout / lit, no road.wet, building snowColor / far) |
| `smoke-boot/` | `node tools/smoke.js --scenario boot --quality med` on the tree with the first data: CLEAN |

`E:/Temp/claude/gate-rush-evidence/r5/techart-review/` (`TR/`):

| Path | What |
|---|---|
| `tools/validate-districts.mjs` | Current validator (schema, identity, mapping, capacities, weather brightness, light azimuth, pools vs lamps, anchors, kind extents, edge clearance) |
| `tools/check.mjs` | Independent 17 px re-derivation (fog on screen, glyph:plate, glyph vs fog, panels vs fog) with the exact GRADE_FRAG luma |
| `tools/check2.mjs` | Weather radiance vs road / glyph / bloom threshold, sky band behind the HUD, shadow reach per district |
| `tools/shadowbox.mjs` | Shadow-camera reach on the road centre and edges for any light offset, with and without the §6.1 bottom rescale |
| `tools/weatherfill.mjs` | Monte-Carlo sprite fill per weather kind and tier |
| `tools/pools.mjs` | Night light pools vs the 36 px glyph:plate (model) |
| `tools/sweep-toxic.mjs`, `tools/night-offset.mjs` | Toxic shadow-tint sweep; model numbers before / after the light-offset changes |
| `districts-section-before.js`, `DISTRICTS-before.md` | The data section and this document before the review |
| `smoke-boot/` | `node tools/smoke.js --scenario boot --quality med` on the reviewed data: CLEAN |

---

## 12. Round-5 tech-art / UX review: what changed and why

Data (`js/data.js` DISTRICTS section) and this document were changed together; ARCHITECTURE §6.3, §6.4, §6.16, §8.10, §9.1, §9.3 and GDD §15.1 carry the interface consequences.

| # | Finding | Change |
|---|---|---|
| 1 | Snow flakes were unlit at linear 0.94: brighter than the white value glyph (0.82), at the bloom threshold, 3 × the sunlit snowfield | Frozen `weather.gain` 1 → 0.5; weather brightness rule (§2) in the validator |
| 2 | Night ash specks were 35 × brighter than the lit road (glowing grey dots over the glyph plates) | Night `weather.gain` 1 → 0.35 |
| 3 | Rain: 0.35 m upright streaks filled 45 % of a Medium frame and drew "1"-like bright lines beside value glyphs | Overcast rain size 0.22, opacity 0.22, slant 0.2 |
| 4 | Toxic chartreuse spores (and ooze reaching the lanes) share the spitter's acid hue, a threat cue | Spores #D8F07A → pale khaki #CFCBA0; acid declared a reserved hue (§4.7) |
| 5 | Toxic puddles (x 4.5–8, radius to 1.28 m) and barrels (x from 4.9 with a 0.9 m ooze disc) put glow on the curb and the lanes; crossed trucks reached x 3.8 | Kind `half` extents, `DISTRICT_RULES.edgeClearX` 4.5 and a placer clamp (§7.2); puddle x [5.6, 8] scale ≤ 1.3, barrel x from 5.4, cones / rock / dune / snowbank bands moved out |
| 6 | Shadows ended at z −15.6 (Overcast, 56° light), −21 (Night, azimuth −42°) and −20.5 (Ash, near plane) instead of the ad's −23.2: shadow pop-in mid-screen | Shadow-box bottom rescale in render (§6.1); Night offset [−7, 14, −12]; Ash offset [6.5, 10.5, −21] (same direction); azimuth / reach rule in the validator |
| 7 | Building `present` / `farPresent` overrides were defeated by `present + (1 − present) × density` (1.0 on High everywhere: Overcast's highway was a city block) | Building weight = near-row multiplier, `layout.far` = far-row multiplier (§7.2); values converted |
| 8 | Night light pools assumed a lamp at every position, but Overcast's mixed lamp layout rotated into Night left pools under missing / unlit lamps for 180 m; `lamps.mode: 'off'` in Toxic was ambiguous for the puddle glow | `lamps.mode` → `layout` + `lit`; Overcast lamps `all / none`; `lit` re-applied at the fade's 0.5 point; pools rule in the validator |
| 9 | "Endless gate events are at least 100 m apart" was false (70 m inside D ≤ 4 and mini-boss chunks); a rotation could also start mid mini-boss | Trigger conditions (c) next gate and (d) no live boss, `fadeNextGateFrac` 0.8 (§3.2) |
| 10 | The skyline column count switched at the fade midpoint: every skyline building redrawn at once under the HUD | `uSkyDip` and `swapDip` (renamed from `weatherDip`) for weather and skyline |
| 11 | The moon (−12°, 8°) peeked out behind the pause button in gameplay; stars and moon are not visible in portrait gameplay anyway | Moon at 3°, 11°; §0 / §2.1 say what the camera sees |
| 12 | `setEyeGlow` writing the boss glow material would be overwritten every frame by boss.js; the uniform also drives spitter sacs | Zombie classes only, sacs included, bosses untouched (§6.3) |
| 13 | `_updateTitleLight` rewrites `hemi.intensity` every frame from `RENDER`; env's `applyQuality` writes `fog.far = params.fogFar` and `drawRange = params.dust`; `_sync` wraps the dust scroll by `ENV.dust.box`; render's fade would overwrite fx's bloom pulse (fx updates first) | Current-state mirror `_cur`, env owns fog near / far and the quality paths, active-box scroll, frame-stamped bloom hold (§6.1, §6.2) |
| 14 | Context restore re-laying the ring would re-seed every visible prop | `rebuild()` re-applies state only (§3.4) |
| 15 | Missing data: roof-snow colour, cars-pose heights for trucks / wrecks / frozen cars (the car's 1.37 / 0.9 would sink a truck), smoke anchor heights, per-placer defaults (a burning wreck would inherit the car's 22 % burnt repaint), chance-gated kinds vanishing on Low, castShadow for smokestacks / puddles | `building.snowColor`, `poseY`, `smokeY` (was `topY`), `castShadow`, placer contract §7.2; `jitter` / `yawJitter` unified per placer |
| 16 | Drain-and-swap re-placement would have changed other slots' RNG draws; the empty stretch was quoted as 100 m | Pending placers run with writes suppressed; the stretch is 120 m (§3.3) |
| 17 | The "near shoulder stays mid-dark, snow starts beyond the ditch" statement did not match GROUND_FRAG's 5.0 → 7.2 blend | Rule 3 restated with the blend and the sight lines |
| 18 | "The HUD is DOM and unaffected": its backdrop (the sky band) drops to 1.5 : 1 against white in Frozen | §4.7 documents it; acceptance 9 |
| 19 | `road.wet` duplicated `puddles > 0`; geometry memory quoted at 1.5 MB (≈ 0.3–0.5 MB); the readability evidence did not include any of the new dressing | `wet` removed; §9 corrected; full-dressing pass and fallback ladder (§4.3, §4.4, §10.3) |

---

## 13. Round-5 integration: amendments and acceptance results

The integration pass (`docs/build/r5-integrate.md`; evidence `E:/Temp/claude/gate-rush-evidence/r5/integrate/`, written `IV/`) ran the §10 acceptance on the implemented build and folded in the implementers' spec requests.

**Spec amendments** (the as-built behaviour, requested by the implementers): the lamps' lit mode is re-applied at the fade's 0.5 point while the lamppost slot still shows lamps (§3.3); the scatter placer paints kinds with `colors.paint` (§7.2); `uCloudOff`, `uGrWet`, `uGrUnlit` and the pud³ puddle roughness are listed (§6.2); `DISTRICT_RULES.puddleReflect` holds the puddle reflection gain (§8.1); a snap always resets the bloom strength to the base (§6.1); the banner's landscape-phone placement (§5); both warm-up paths, the step-6 proxies and the step-9b list, are drawn at boot (§3.6).

**Draw calls (§9).** Districts add no draw: the same gameplay frame measured in all six districts draws the same main-pass calls (Toxic two shadow draws fewer). Gameplay content, not districts, had pushed heavy frames past the main budget (51 in L16, 54 in endless, High); the six road segments are now one draw (ARCHITECTURE §9.1), and the integration matrix peaks at 28–46 main / 12–17 shadow / 14 post across the six districts (per-frame maxima, High).

**Readability, full-dressing pass (§10.3)**, on the implemented build: `IV/tools/readability.mjs` (proto.mjs's sampling, with each district reached through `level.start` — the real `render.setDistrict` + `env.setLevel`, props, weather, smoke, pools, puddles and stars) and `IV/tools/full-analyze.mjs` (median and 10th percentile of 30 reads per gate type and depth, floors per §4.3 with Sunset's own full-pass median). The first pass failed five cells on Medium and High; three data changes followed, each tied to its cause:

| Change | Cause (measured) | Effect |
|---|---|---|
| `DISTRICT_RULES.puddleReflect` 0.5 → 0.3 | the grazing-angle sky reflection on the far puddles lifted the road beside the 36 px gates (bluish grey): Overcast item panel 14.7, Toxic × panel 14.7 (bare) on Medium; with the reflection off, 17.2 and 16.6 | Overcast 36 px 15.4, Toxic 16.6 (Medium) |
| Overcast `road.puddles` 0.35 → 0.2 | §4.4 fallback step 1 for Overcast | (applied with the line above) |
| Frozen `road.edge` #E4E8EC → #D6D6CC (District 1's paint) | the 29 / 36 px backdrop windows beside a gate take in the far road's edge line; the near-white paint (never applied by the bare-pass stand-in, which tinted the whole road by the asphalt ratio) pulled Frozen's panels and frames under the floors (36 px panel 14.4, frame 19.2 on Medium) | Frozen 29 / 36 px panel 16.0 / 15.5, frame 24.2 / 21.3 (Medium) |

Final verdicts (full pass; the bare single reads swing ±2 ΔE00 with the gates' glow breathing and are reported in `IV/readability-final/analysis-*.md`):

| Tier | Cells passing | Residual misses |
|---|---|---|
| Medium | 17 / 18 | Sunset 36 px panel p10 12.3 against 12.75 — District 1 itself, unchanged (its warm dust motes and the glow breathing at the panel sample) |
| High | 16 / 18 | Ash 36 px panel median 14.9 against 15; Frozen armed-line frame median 19.8 against 20. The §4.4 steps (burning-wreck emissive 2.8 → 2.0; snow opacity 0.85 → 0.6, then snowfield #C0CCD8 → #A8B4C0) were applied and re-measured: 14.9 and 19.8 again, so they were reverted |
| Low | 17 / 18 | Frozen 17 px MAX panel p10 8.8 against 11.05 (median 13.3 passes 13): the glow quad (Low's bloom substitute) at the dim phase of its breathing against the pale fog; no §4.4 step reaches it on Low |

The three residual district cells miss by 0.1–0.2 ΔE00 (medians) or in the dim phase of the glow breathing; they are open for the art director (an Ash or Frozen palette or glow decision, not a data step of the ladder).

**Hitches (§1 rule 8, §10.5).** No frame over 50 ms at a district change or a level start in any district: the menus now start levels through `level.requestStart` (a script that is not memoized generates in frame slices), because a cold L13 / L19 / L28 generation was a 104–139 ms frame in the click handler (§10.5's smoke runs never saw it: the harness's frame window began after the start).

---

## 14. Round-5 art review: findings, changes and measurements

**Scope.** The art director's pass (`docs/build/r5-art.md`; evidence `E:/Temp/claude/gate-rush-evidence/r5/art-review/`, written `AR/`) reviewed the six districts:
- in play on the default tier, Medium and Low, at the boss, and on the title (phone, Low, desktop);
- with gate legibility measured on screenshot crops: glyph : panel (WCAG) for every gate type on every tier, at the armed line (29.7 css px glyphs) and at the 36 px point.

The method is in r5-art §3. In short: each sample is shot twice with time frozen, with and without the gate glyphs; the differing pixels are the glyph, and the second frame gives the panel area behind it.

**District changes** (data and environment; inert in District 1, which stays pixel-identical, and in Ash):

| Change | Cause (measured) | Effect |
|---|---|---|
| Night `road.pools.intensity` 1.2 → 2.4, and a puddle inside a pool mirrors the lamp (`DISTRICT_RULES.poolPuddleGlint` 0.12) | The pools were invisible (≈ +30 red levels at the very centre). The night road read as one evenly moon-lit grey: the moon's sheen on the 0.6-roughness asphalt is most of its brightness near the camera | Warm sodium pools along both edge lines. Road roughness 0.85 was tried and rejected: backlit zombies lost silhouette contrast against the darker road (walker 1.43 → 1.28 : 1) |
| Puddles (§6.2 Road): reflection floor near the camera (`puddleReflectFloor` 0.3, faded out over `puddleFloorFadeM` [18, 35] m, so the 36 px gate at 37 m is untouched); roughness switches inside the puddle only; no direct specular across the rim; `road.puddleRoughness` 0.18 → 0.32 (Overcast, Night, Toxic, Frozen) | Near-camera puddles read as black holes ringed by a bright crescent, on every tier. The smooth patch lost the rough asphalt's broad key-light sheen, the steep-view fresnel was ≈ 0.02–0.05, and the rough → smooth rim caught the key light | Sky-tinted wet patches; no crescent |
| Title-rig lamp clearance (§8.3, `uGrLampRow`, `render.titleBlend`) | On the landscape / desktop title the camera sits 0.75 m inside the right lamp row: every lamp swept through the frame every 2.5 s (r5-integrate §5 issue 2) | That row and its pools are cleared on the title rig only; play is untouched |

**Gate-wide changes** (materials.js; no colour changed, §1 rule 2):
- **Ring-gauge fill** ≤ 0.80 linear luminance, with a full ring pulsing 30 % below it. A full ring (× at its cap, ÷ flipped to ×2) bloomed into the plate it frames: 1.9–3.0 : 1 on Medium and High in every district, the ad included.
- **Item lanes:** a near-black plate behind the icon (darken 0.85, opacity ≥ 0.9, luminance ≤ 0.02). The icon read 2.7–3.2 : 1 on Low at the armed line and 1.6–1.9 : 1 at the 36 px point, judged on its main colour. At 36 px it also failed in Sunset on Medium (2.99) and in Frozen on High (2.82).
- **`PLATE_ALPHA` 0 → 0.6.** At the 36 px point a 38 % panel let the road and the glow quad lift the plate: ×2, ×1 and full rings read 2.2–2.8 : 1 on Low in every district, and 2.9 in Toxic on High.

**Measured, after:**
- Every gate type is ≥ 3 : 1 glyph : panel at both depths, on every tier, in every district: the worst is 3.50 at the armed line (High, Sunset MAX +20) and 3.40 at the 36 px point (High, Toxic MAX +20). Before, 41 (tier, district, depth, group) cells were under 3 : 1, the worst 1.57 (the Low item icon at 36 px) and 1.76 (a High full ring at 36 px).
- Count label 12.4–16.1 : 1; MAX letters on their pill 3.3–4.5 : 1.
- Zombie silhouette : road is unchanged (the road behind the line-up measures the same).
- `renderer.info.programs` is flat at 58 / 58 / 42.
- District 1 frozen frames are pixel-identical for the environment / render edits.
- The §10.3 full-dressing pass, re-run on the final tree: 17 / 16 / 17 of 18 cells pass on Medium / High / Low, the same as the integration's final pass, with the same residual cells (below). The lowest glyph : plate median rises from 2.17 to 2.93 (Medium / High) and from 2.72 to 3.18 (Low). With the pools at 2.4, Night's panels stay at 17.7–25.3 ΔE00 against the backdrop (16.6–25.3 in the integration's pass) (`AR/final/iv-readability/`, `AR/final/iv-compare.md`).

**The integration's open cells (§13), decided by the art director:**
- **High: Ash 36 px panel, median 14.9 against 15.** Re-run: 14.9. **Accepted.** It is 0.1 ΔE00 under the absolute floor, inside the ± 2 ΔE00 read-to-read swing of the glow breathing. The same gate clears every other floor by a wide margin (frame 26.8, glyph : plate 5.58 : 1). The §4.4 steps did not move it (§13); the remaining lever, the haze colour, would change the district's look for a 0.1 ΔE00 gain.
- **High: Frozen armed-line frame, median 19.8 against 20.** Re-run: 19.6. **Accepted** for the same reason. The 0.12 m posts are one cue of four (panel 15.9, glyph : plate 5.53 : 1).
- **Low: Frozen 17 px MAX panel p10, 8.8 against 11.05.** Re-run: 9.5; the median, 13.3, passes. **Accepted.** At the dim phase of the Low glow quad's breathing, the MAX panel meets the pale fog at the spawn line; the gate reads there by its gold badge and frame (23.9). The lever is the breathing amplitude on Low (`GATE_RULES.glow.pulseAmp`, gates data), not district data.
- **Medium: Sunset 36 px panel p10, 12.3 against 12.75.** Re-run: 12.5; the median, 21.3, passes. **Accepted:** District 1 is the ad, unchanged by rule 1.

**Accepted, with numbers:**
- **Frozen's ×1 panel** melts into the pale haze: panel : surroundings ΔE00 5 on every tier. It reads by its frame, plate and glyph (≥ 4 : 1). The neutral gate is meant to look neutral, and a bluer fog failed the MAX panel on Low (§4.5).
- **Toxic** is the most saturated district (mean saturation 0.67): that is the brief.
