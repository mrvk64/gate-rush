# Round 5: art direction and readability review (r5-art)

This is the art director and readability reviewer's pass over the six visual districts, after the round-5 integration (`docs/build/r5-integrate.md`).

- **Owner files:** `js/environment.js`, `js/render.js`, `js/materials.js`, `js/models.js` (unchanged), and the DISTRICTS data in `js/data.js` (`DISTRICTS`, `DISTRICT_RULES`).
- **Docs:** `docs/DISTRICTS.md` (§1 rule 2, §2, §2.1, §4.4, §6.2, §8.1–8.3, §10 items 13–14, new §14); `docs/ARCHITECTURE.md` (§6.3, §8); `docs/GDD.md` (§14 Title, §15, §15.1); `docs/build/CALLSITES.md` (regenerated).
- **Untouched:** the fixed gate colours (`GATE_RULES.colors`).

**Evidence** lives under `E:/Temp/claude/gate-rush-evidence/r5/art-review/`, written `AR/` below.
- The tree as handed over is in `AR/src-before/` (md5s in `AR/src-before-md5.txt`); the final md5s are in `AR/md5-final.txt`.
- The tools are in `AR/tools/`. Every code and doc edit is an anchor-checked edit file in `AR/tools/edits/` (01…18), applied with `AR/tools/rep.cjs`.
- The A/B "before" sources are in `AR/ab-before/js/` and are served in place of `js/` with `SRC_JS=…`. They are my four files as handed over, plus `data.js`, which is the current file with my keys reverted, so that another owner's concurrent comment edit stays.

Host: i7-8700K, RX 6800 (ANGLE D3D11), headless Chrome on the real GPU, and a 390 × 844 @ 2 phone viewport unless stated. Other owners' runs shared the host during the screenshot series, so the series' worst-frame numbers are contention noise; §5 has a quiet, interleaved frame-time A/B.

**Verdict.** The six districts are distinct, rich and readable. The review found six defects and fixed each at its root. It accepts the remaining weak spots with numbers: Frozen's ×1 panel, and the integration's four open readability cells (DISTRICTS §14). It passes two requests to other owners.

1. **Gate legibility, measured on screenshot crops.**
   - **Full rings.** At the armed line (29.7 css px glyphs), the full-ring gates (a × at its cap, a ÷ flipped to ×2) read **1.9–3.0 : 1** glyph : panel on Medium and High in every district, the ad included. The bright ring bloomed into the plate it frames. At the 36 px point (z −26) they read 1.8–2.4.
   - **Item icon.** On Low it read **2.7–3.2 : 1** at the armed line and **1.6–1.9 : 1** at the 36 px point. At 36 px it also failed in Sunset on Medium (2.99) and in Frozen on High (2.82).
   - **Other types at the 36 px point.** ×2, ×1 and the full rings read **2.2–2.8 : 1** on Low in every district: the 38 % panel let the road and the glow quad lift the plate.
   - **After:** every gate type is **≥ 3 : 1 at both depths, on every tier, in every district** (§3). Before, 41 cells failed; after, none do.
2. **Puddles.** Near the camera they read as black holes ringed by a bright crescent (Overcast, Night, Toxic, Frozen, every tier). Now they mirror the sky band (§2, §4.2).
3. **Night City's light pools** were invisible, and the night road read as one evenly moon-lit grey. Now the pools are warm sodium light, and a puddle inside a pool mirrors the lamp (§2.3).
4. **Desktop / landscape title.** Every right-shoulder streetlight swept through the camera every 2.5 s (r5-integrate §5 issue 2). The lamp row beside the title camera is now cleared, on the title rig only (§4.3).

## 1. Screenshot series (before / after)

**How the runs were made.** Every run is `node tools/smoke.js`, started from the project root by `AR/tools/series.sh`.
- Shop ranks are typical of each band, as in the integration matrix: 0 / 2 / 4 / 6 / 8 / 9 for L1 / L6 / L11 / L16 / L21 / L26.
- `--shots 3` and `--seconds 170`, or 45 for a boss run.

**Results.**
- All 48 runs are CLEAN (24 before, 24 after): 0 page errors, 0 console errors or warnings, 0 failed requests.
- Every level is cleared.
- The program count is flat: 58 on High and Medium, 42 on Low.
- The per-frame call maxima stay within the budget (main ≤ 50 / shadow ≤ 20 / post ≤ 14) in both trees: main 34–46, shadow 10–16, post 10 / 14 (`node AR/tools/summ.cjs AR/before`, `… AR/after`).

| Series | Command (per L in 1, 6, 11, 16, 21, 26) | Before | After |
|---|---|---|---|
| Play, default tier (auto → High here) | `--scenario play --level L --shots 3` | `AR/before/play-L/` | `AR/after/play-L/` |
| Play, Medium (the 60 fps contract tier) | `… --quality med` | `AR/before/med-L/` | `AR/after/med-L/` |
| Play, Low | `… --quality low` | `AR/before/low-L/` | `AR/after/low-L/` |
| Boss at E_boss | `--boss --after "g.squad.setCount(g.level.script.eBoss,'debug')" --seconds 45` | `AR/before/boss-L/` | `AR/after/boss-L/` |
| Title per district: phone High, phone Low, desktop 1280 × 800 | `AR/tools/titles.mjs`: levels 1 … N−1 cleared through `save.recordLevel`, `highestUnlocked = N`, persisted, page reloaded | `AR/before/titles/` | `AR/after/titles/` |
| Contact sheets and packs | `AR/tools/sheet2.mjs`, `pack.mjs` | `AR/before/sheets/` | `AR/after/sheets/` |
| Look-dev frames, all tiers: same seed, frozen scroll, gates at −36 / −62, a five-type zombie line-up, squad 120, HUD hidden | `AR/tools/lookdev.mjs` | `AR/final/lookdev/before-<tier>-<district>.png` | `AR/final/lookdev/after-<tier>-<district>.png` |
| Gate crops, every type, all tiers, at the armed line and the 36 px point | `AR/tools/legibility.mjs` | `AR/final/leg-before/`, `AR/final/leg-before-z26/` (`<tier>-<district>-gates.png`) | `AR/final/leg-after/`, `AR/final/leg-after-z26/` |

**Side-by-side packs.**
- Look-dev: `AR/final/compare/lookdev-<tier>-{night-overcast,toxic-frozen,sunset-ash}.png`.
- Gates: `AR/final/compare/gates-{med,low}-{armed,z26}-before-after.png`.
- Night street: `AR/after/sheets/night-before-after-37s.png`.
- Desktop title: `AR/before/sheets/titles-desktop-b.png` against `AR/after/sheets/titles-desktop-b.png`.

**Other notes.**
- `AR/after-pass1/` is an intermediate after series, shot before the plate-opacity fix (§4.1) and kept for the record.
- `--pre "g.save.data.highestUnlocked = N"` cannot set the title district, because smoke.js shoots the title right after boot, before `--pre` runs. The titles therefore use the save API and a reload, which is also how a returning player boots.

## 2. Art-lead review, district by district

The look-dev and play frames are listed in §1. The exposure statistics come from `AR/tools/exposure.mjs`, run over every play frame of the 3D view only (HUD bands cut); they are in `AR/final/exposure-table.md` and summarized in §2.7.

### 2.1 Sunset Boulevard (District 1, the ad; reference)
- **Look.** Orange dusk, teal shadows, a warm haze, and the densest dressing of all: barricades, wrecks, dead trees, lamps and smoke. It is rich and immediately readable. Only the gate fixes touch it, and those apply to every district (§4.1).
- **Gates.** Before, the full rings read 2.4 : 1 on Medium and 2.1 : 1 on High; at the 36 px point on Low, ×2 and ×1 read 2.2–2.3 : 1 and the item 1.6 : 1. All are fixed.
- **The red gate on orange.** The − and T−30 panels have the smallest hue separation of any district: ΔE00 12.3–12.9, luminance 1.0–1.1 : 1. They read by their red frame, hazard stripes and down-chevrons. That is the ad's look, and it is kept.
- **Zombies.** Backlit dark silhouettes with glowing eyes: zombie : road 1.27–1.39 : 1 (ΔE 13–16), the reference for the other districts.
- **Count label:** 13.2 : 1.
- **Low:** warm and clean; dust is off on Low by design.

### 2.2 Overcast Highway
- **Look.** A grey-green rainy highway: box trucks, cones and drums, F-barriers, billboards, and a regular row of unlit highway lamps. It is the only daylight-grey district, moody and coherent, with deliberately flat light (cloud deck, sun 1.5).
- **Defect, fixed: puddles.** Near the camera the wet-road puddles were black holes with a bright rim, the darkest thing on the road. A puddle under an overcast sky should mirror the bright sky. They are now sky-grey wet patches (§4.2).
- **Rain.** Streaks of 0.22 m, slanted, at 0.22 opacity. They read as weather and never cover a glyph in any frame of the series. No change.
- **Gates.** The − / ÷ pair reads best here. The full ring was 2.8–3.0 : 1, the best of the six, because Overcast has the lowest bloom (0.5).

### 2.3 Night City
- **Look.** Navy night, half the windows lit, neon blade signs and every streetlight on: the most premium-looking district.
- **Defect, fixed: an evenly lit road.** The road read as one evenly moon-lit grey: the near road's Y of 0.031 matches the day districts. The moon's mirror point sits by the squad, so most of the road's brightness is the specular sheen of the 0.6-roughness asphalt.
- **Defect, fixed: invisible pools.** The designed sodium pools, the district's hero feature, added only about +30 red levels at the very centre, with a pow-3 falloff over a 0.036 albedo. The fix raises `road.pools.intensity` from 1.2 to 2.4 and makes a puddle inside a pool mirror the lamp. Warm pools now recede along both edge lines (`AR/after/sheets/play-11-a.png`, `AR/after/sheets/night-before-after-37s.png`).
- **Tried and rejected: road roughness 0.6 → 0.85.** It gave a darker, more nocturnal road. But zombies are backlit and darker than the road, so their silhouette contrast dropped (walker 1.43 → 1.28 : 1, `AR/exp/zomb/`). The road keeps its moon sheen.
- **Puddles** were black holes with a blue crescent; fixed (§4.2).
- **Gates** read best against the dark. Before the fix, Night had the worst full-ring cells of the matrix: 1.9 : 1 at the armed line and 1.8 at 36 px on High.

### 2.4 Toxic Industrial
- **Look.** Yellow-olive smog, chartreuse ooze glowing at barrel bases and in puddles (kept off the lanes), containers, pipe racks and smokestacks. Unmistakable.
- **Saturation, kept.** Toxic is the most saturated district (mean saturation 0.67, against the ad's 0.53), and its distant haze is flat. That matches the "sickly" brief, and the fixed gate tints box the fog in (DISTRICTS §4.5). The ooze halos bloom softly and stay on the shoulders.
- **Zombies.** They have the smallest hue separation from the road (olive on olive, ΔE ≈ 6–7). Their luminance contrast is the same as everywhere (1.35–1.43 : 1), though, and their eyes glow, so they read (`AR/exp/toxic/eyes-cmp.png`). A stronger eye glow (2.6) made no visible difference, so the data is unchanged.
- **Gates.** Before, the full rings read 2.0–2.5 : 1 at the armed line and 1.8–1.9 at 36 px, and ×2 read 2.9 : 1 at the 36 px point on High. All are fixed.
- **J5 flip flash.** The 0.25 s white flip flash (by design) whites out a flipped gate in two High frames (`AR/before/crops/toxic-white-gates.png`). `AR/tools/gatefire.mjs` shows the gate under sustained fire is blue and legible right after the flash (`AR/before/gatefire/`).

### 2.5 Ash Wasteland
- **Look.** Blood-red sky, ash-grey haze, brown-grey ash land, dunes, burning wrecks with ember plumes, charred trees, broken lamps and rising embers. Distinct and atmospheric.
- **Darks.** Ash is the second-darkest district: median Y 0.030–0.034 and a crushed-dark share of 3.2–6.9 %, against the ad's 3.3–5.9 %. Its darks are no muddier than the reference.
- **Gates** read best here, against the dark. The road is dry, so the puddle changes do not apply.

### 2.6 Frozen Outskirts
- **Look.** Pale blue-white sky, white snowfields, snowy pines, snowbanks, frozen cars and falling snow. The prettiest district at a glance. The snow is bright but never clipped (≤ 0.12 % of pixels).
- **Accepted: the ×1 panel.** The neutral grey ×1 panel (30 % opacity) melts into the pale grey haze: panel : surroundings ΔE 5–8 and 1.02 : 1 on every tier. It still reads by its frame and its dark plate (glyph ≥ 4 : 1). The neutral gate is meant to look neutral, and a bluer fog that would separate it failed the MAX panel on Low (DISTRICTS §4.5).
- **Item icon:** 1.7–3.2 : 1 before (lowest at 36 px on Low), ≥ 4.8 after.
- **Slush puddles:** fixed.

### 2.7 Cross-district checks

| Check | Result |
|---|---|
| Distinct palettes and silhouettes | Yes — in play, on the title, and on Low. There are six fog / sky families (orange, grey-green, navy, olive, red-brown, pale grey-blue) and six prop sets (`AR/before/sheets/`) |
| Overexposure: pixels with every channel ≥ 250, 3D view only | ≤ 0.12 % before and ≤ 0.07 % after, in every district and tier |
| Muddy darks: share of pixels with Y < 0.004 | Night 5.2–8.9 %, Ash 3.2–6.9 %, against the ad's 3.3–5.9 %. Overcast, Toxic and Frozen sit at 1.3–4.2 %. The pools lowered Night's share: 8.9 → 8.3 % on Medium, 6.5 → 5.9 % on High, 6.2 → 5.2 % on Low |
| Banding | The hazes step one 8-bit code value every 10–25 device px, and no frame shows a visible band. The output pass has no dithering; nothing here needs it |
| Z-fighting | None seen. The ground sits 3 cm under the road, and the flat prop decals (Toxic ooze puddles) sit 4 cm above the ground |
| Popping props | None in play: segments refill beyond −100 m, which is fully fogged in every district and tier, and the endless drain is by design (DISTRICTS §3.3). On the desktop / landscape title, lamps swept through the camera; **fixed** (§4.3) |
| Shimmering | Medium has no MSAA (GDD §16 performance contract), so thin poles and gate posts crawl at distance, as designed. High (4× MSAA) is clean |
| Weather | Atmosphere without noise in every district. Rain streaks, ash specks, spores, embers and snow stay small and never cover a glyph in the series. Low has no weather, by design |
| Count label | Digits : plate 12.4–16.1 : 1 on every tier (§3) |
| Zombies: silhouette : road, median of five types, look-dev line-up | 1.10–1.43 : 1 everywhere (ΔE 5.5–16), including the ad's 1.27–1.39: backlit silhouettes plus glowing eyes in every district. This pass did not change it. The road behind the line-up measures the same before and after, and each zombie's value moves ± 0.2 with its walk pose (`AR/final/lookdev-*.log`) |
| Boss | Reads in all six districts (`AR/before/sheets/boss-pack-7s.png`, `AR/after/sheets/boss-pack-7s.png`): a dark silhouette against the Toxic haze, and sacs, core and eyes against Night and Ash |
| Low tier | Still good-looking: the same palettes and props at 0.4 density, blob shadows, glow quads standing in for bloom, and no weather (`AR/final/lookdev/*-low-*`, `AR/after/sheets/low-pack-19s.png`). It had three defects, all fixed: the item icon, the 36 px plates, and black puddles |

## 3. Gate legibility, measured on screenshot crops

**What is measured.** `AR/tools/legibility.mjs` works on `page.screenshot` PNGs: the canvas at the tier's DPR, upscaled by the compositor to the 780 × 1688 phone frame, which is what the player sees. The DOM HUD is hidden.

**Setup.**
- Each district is reached through `level.start` (L1 / 6 / 11 / 16 / 21 / 26), so the real `render.setDistrict` and `env.setLevel` lay out the props, weather, smoke, pools, puddles and stars. The scroll is then frozen.
- Decorative gate pairs (and one triple) stand at one depth: the armed line (z −36, 29.7 css px glyphs) or the 36 px point (z −26).
- The gates cover every type: +5, ×2, −15, ÷3, ×1 (a ÷ at its ×1 rung), item (shotgun icon), MAX (+20), a flipped − (+8), a flipped ÷ (×2, full ring), a × at its cap (×5, full ring), +24, +5, and the triple −30 / ×3 / +120.

**Sampling.**
- Each sample is two frames with `time.scale` at 0, which holds uTime, the glow breathing, the sheen, the ring pulse and the weather. Frame W is shot as rendered. Frame N is the same frame with the gate glyph and icon materials hidden.
- The pixels where W differs from N are the glyph. Under them, N holds the exact panel area behind the glyph: the dark plate, translucent over the scene.

**Metrics.**
- **glyph : panel** is the WCAG ratio of the glyph's white fill core to the panel behind it. The fill core is the median relative luminance of the brighter half of the fill pixels in W; the panel behind is the median of N under every glyph pixel.
- **The item icon** is a colour pictogram, so it is judged on its main fill colour: the 90th percentile of its pixels. (Once the plate is darker than the icon's gunmetal parts, the median of the brighter half would mix those parts in.)
- **panel : surroundings** is the WCAG ratio and ΔE00 of the panel body against the outer side of the frame and the band above the gate. The body sample is a lower band clear of the plate, ring, stripes and chevrons.
- **Also measured:** the MAX letters against their pill, and the count-label digits against the label plate.

**Repeats and A/B.**
- Each configuration is sampled four times at the armed line and three times at 36 px, at different phases of the breathing and the weather.
- The before tree runs the same tool with `SRC_JS=AR/ab-before/js`.
- Raw rows: `AR/final/leg-{before,after}{,-z26}/legibility-<tier>.json`.
- Full per-type tables: `AR/final/legibility-{before,after}{,-z26}-tables.md`, from `node AR/tools/leg-analyze.mjs <dir>`.
- Summary (below): `AR/final/legibility-summary.md`, from `node AR/tools/leg-summary2.mjs AR/final/leg-before AR/final/leg-after AR/final/leg-before-z26 AR/final/leg-after-z26`.

**Target: glyph : panel ≥ 3 : 1 for every gate type, district and tier.** Each cell below is the minimum over the samples, before → after; bold marks a value under 3 : 1. "Full ring" means a ÷ flipped to ×2 or a × at its cap.

| tier | district | armed line: other types | armed line: full ring | armed line: item icon | 36 px: other types | 36 px: full ring | 36 px: item icon |
|---|---|---|---|---|---|---|---|
| low | sunset | 4.18 → 4.19 | 4.10 → 4.11 | **2.74** → 5.54 | **2.24** → 3.61 | **2.30** → 3.79 | **1.57** → 6.85 |
| low | overcast | 4.73 → 4.73 | 4.63 → 4.64 | 3.08 → 5.25 | **2.54** → 3.55 | **2.52** → 3.62 | **1.75** → 6.77 |
| low | night | 4.25 → 4.06 | 4.05 → 4.08 | **2.88** → 5.86 | **2.58** → 3.98 | **2.53** → 3.67 | **1.86** → 6.86 |
| low | toxic | 4.69 → 4.69 | 4.61 → 4.61 | 3.09 → 5.12 | **2.39** → 3.46 | **2.44** → 3.62 | **1.69** → 6.69 |
| low | ash | 5.00 → 5.00 | 4.89 → 4.89 | 3.22 → 5.51 | **2.73** → 3.86 | **2.78** → 3.84 | **1.79** → 6.93 |
| low | frozen | 4.75 → 4.72 | 4.73 → 4.78 | **3.00** → 4.82 | **2.32** → 3.49 | **2.39** → 3.64 | **1.66** → 6.90 |
| med | sunset | 3.49 → 3.52 | **2.38** → 3.85 | 3.09 → 6.92 | 3.08 → 4.10 | **2.06** → 3.97 | **2.99** → 8.11 |
| med | overcast | 4.59 → 4.57 | **3.00** → 4.84 | 3.95 → 7.48 | 3.47 → 4.26 | **2.41** → 4.26 | 3.22 → 8.25 |
| med | night | 3.85 → 3.98 | **2.29** → 4.48 | 4.36 → 8.63 | 3.24 → 4.02 | **1.83** → 3.94 | 3.55 → 8.67 |
| med | toxic | 3.77 → 3.77 | **2.45** → 4.58 | 3.80 → 7.27 | 3.17 → 3.86 | **1.87** → 4.08 | 3.18 → 8.12 |
| med | ash | 4.55 → 4.49 | **2.80** → 5.42 | 4.37 → 8.08 | 3.44 → 4.08 | **2.12** → 4.41 | 3.63 → 8.51 |
| med | frozen | 3.77 → 3.82 | **2.70** → 4.04 | 3.11 → 6.05 | 3.18 → 4.17 | **2.20** → 4.28 | 3.05 → 7.82 |
| high | sunset | 3.39 → 3.50 | **2.12** → 3.59 | 3.09 → 6.98 | 3.10 → 4.01 | **2.01** → 3.77 | 3.03 → 8.11 |
| high | overcast | 4.65 → 4.61 | **2.84** → 4.52 | 3.90 → 7.49 | 3.22 → 4.10 | **2.39** → 4.15 | 3.22 → 8.29 |
| high | night | 4.03 → 4.11 | **1.94** → 4.12 | 4.32 → 8.68 | 3.08 → 3.47 | **1.76** → 3.78 | 3.56 → 8.74 |
| high | toxic | 3.73 → 3.73 | **1.99** → 4.17 | 3.74 → 7.23 | **2.89** → 3.40 | **1.78** → 3.46 | 3.20 → 8.03 |
| high | ash | 4.54 → 4.54 | **2.28** → 4.85 | 4.63 → 8.13 | 3.31 → 3.90 | **2.04** → 4.17 | 3.52 → 8.48 |
| high | frozen | 3.77 → 3.81 | **2.45** → 3.63 | 3.21 → 6.05 | 3.05 → 4.10 | **2.15** → 4.23 | **2.82** → 7.86 |

**Overall:** 41 of these (tier, district, depth, group) cells were under 3 : 1 before, and none are after. The worst cells after are 3.50 at the armed line (High, Sunset MAX +20) and 3.40 at the 36 px point (High, Toxic MAX +20).

**Why each group failed before.**
- **Full rings.** They failed in every district on Medium and High, the ad included: 1.9–3.0 : 1 at the armed line and 1.8–2.4 at 36 px. The fill of a full ring had a luminance of about 1.0–1.7, so it bloomed in from all four sides of the plate it frames. With bloom off, the same gate read 4.4–5.2 : 1 (`AR/exp/ring/e1-nobloom`); halving the ring width still left 2.6–3.9 (`e2-thin`).
- **Item icon.** It failed on Low: 2.7–3.2 : 1 at the armed line and 1.6–1.9 at 36 px. At 36 px it also failed in Sunset on Medium (2.99) and in Frozen on High (2.82). The icon quad is not tone-mapped on Low (`toneMapped: false` in gates.js; only Medium and High tone-map everything in the output pass). Its orange is therefore Y 0.36 instead of 0.49, and it sat on a translucent violet plate lit by the violet glow quad behind it.
- **The 36 px point.** A 38 % panel let the road and the glow quad behind it lift the plate. On Low, ×2, ×1 and the full rings read 2.2–2.8 : 1 in every district, and ×2 read 2.9 : 1 in Toxic on High.

**After the fixes.**
- At the armed line, the types the fixes did not target move by less than the sampling noise of the glow breathing (± 0.2). At 36 px they gain from the more opaque plate.
- Count label: 12.4–16.1 : 1. MAX letters on their pill: 3.3–4.6 : 1.

**Panel : surroundings.**
- Hue separation is at least 12 ΔE00 in every cell, with three exceptions:
  - Frozen: the ×1 panel sits at 5–8 ΔE00, and the blue and MAX panels at 10–12 against the pale blue-grey haze.
  - Overcast on Low: MAX at the 36 px point, 9.4–9.9.
  - Toxic on High: the full ring at the 36 px point, about 11.
- These cells were the same before and after.
- Luminance separation is small (1.0–1.4 : 1) for most types in Sunset, Toxic and Overcast, the ad included. Gates are told apart from the world by hue, frame shape, stripes and chevrons, as designed (GDD §4.1).

**Under fire** (`AR/tools/gatefire.mjs`, 24 weighted hits/s through `gates.applyHit`). A − gate shot through its flip turns blue and stays legible. The 0.25 s J5 flip flash whites it out, by design.

**DISTRICTS §10.3 full-dressing pass, re-run on the final tree.** The re-run uses the integration's own tools unchanged: `AR/tools/iv/readability.mjs` and `full-analyze.mjs`, with 30 reads per type and depth. Its output is in `AR/final/iv-readability/analysis-<tier>.md`. The comparison with the integration's final pass (`r5/integrate/readability-final/`) is in `AR/final/iv-compare.md`:

| tier | cells passing (full pass), integration → final | lowest glyph : plate median, integration → final | Night (pools), panel ΔE00 / glyph median, integration → final | failing cells (final) |
|---|---|---|---|---|
| Medium | 17 / 18 → 17 / 18 | 2.17 → 2.93 | spawn 24.0 / 3.06 → 24.0 / 4.80; armed 21.9 / 4.88 → 21.5 / 4.81; 36 px 20.8 / 5.67 → 23.8 / 5.61 | Sunset 36 px panel p10 12.5 (12.3 before; median 21.3) |
| High | 16 / 18 → 16 / 18 | 2.17 → 2.93 | spawn 25.3 / 3.03 → 25.3 / 4.78; armed 22.0 / 6.49 → 21.3 / 6.57; 36 px 17.6 / 5.34 → 18.5 / 5.45 | Ash 36 px panel median 14.9 (14.9 before); Frozen armed frame median 19.6 (19.8 before) |
| Low | 17 / 18 → 17 / 18 | 2.72 → 3.18 | spawn 20.8 / 2.72 → 19.0 / 3.18; armed 22.7 / 4.66 → 21.9 / 7.42; 36 px 16.6 / 4.54 → 17.7 / 7.66 | Frozen 17 px MAX panel p10 9.5 (8.8 before; median 13.3) |

The residual cells are the integration's own (§13). This pass did not move them, and DISTRICTS §14 records the art director's decision on each: accepted, with reasons. Every glyph : plate median rose. The doubled Night pools left Night's panel separation where it was.

## 4. Changes

### 4.1 Gate panel (`js/materials.js`)

| Line | Change | Why |
|---|---|---|
| 83–89 | `RING_LUM_CAP` = `RENDER.bloom.threshold − 0.05` (0.80), `RING_PULSE` 0.3 | The full ring bloomed into the plate (§3) |
| 441–446 | Ring fill: `mix(tint·1.8, white, 0.5)`, normalized to luminance `RING_LUM_CAP`; a full ring pulses down to 70 % of it. It was × 1.3 × (1 ± 0.25) | The ring now stays under the bloom threshold, the rule the value glyph has followed since GAT-7 (emissive 0.82 under 0.85). The progress band, the bright head at the progress end and the empty track are unchanged |
| 131–135 | `PLATE_ALPHA` (minimum plate opacity) 0 → 0.6 | The 36 px point: 2.2–2.8 : 1 on Low, 2.9 in Toxic on High |
| 137–143, 428–429, 498 | Item lanes: the plate is mixed `ITEM_PLATE_DARKEN` 0.85 toward the outline colour, with opacity ≥ `ITEM_PLATE_ALPHA` 0.9 and luminance ≤ `ITEM_PLATE_LUM_CAP` 0.02. Every other type keeps `PLATE_*` | The item icon (§3) |

**What the player sees** (`AR/final/compare/gates-*-before-after.png`).
- **Full ring.** It was a neon halo washing out the panel; it is now a crisp, pale, pulsing band around a dark plate. The closed band and its pulse are the "complete" cue.
- **Plates.** They are darker and more solid, a dark tinted display on a coloured glass sign. They stay 40 % translucent, so a zombie behind a gate still shows through.
- **Item gate.** It gains a dark display behind its pictogram; its violet panel, pentagon top and frame are unchanged.
- **Colours.** No gate colour changed.

### 4.2 Wet roads (`js/environment.js`, `js/data.js`)

| Where | Change |
|---|---|
| environment.js 723–733 | `WET_FLOOR`, `WET_FLOOR_FADE` and `POOL_GLINT` are read from `DISTRICT_RULES`, guarded, with these values as fallbacks |
| environment.js 734–739 (`ROAD_FRAG_ROUGH`) | Roughness switches inside the puddle only: `smoothstep(0.7, 1, pud)` (was pud³) |
| environment.js 740–746 (`ROAD_FRAG_EMIT`) | Reflection factor `max(0.02 + 0.98·F, 0.3 · (1 − smoothstep(18, 35, view distance)))`. The floor has faded out before the 36 px gate (37 m), so the integration's readability numbers there hold |
| environment.js 754 | Inside a light pool: `uGrPool × (albedo + 0.12 · pud)`, so the puddle mirrors the streetlight |
| environment.js 757–762, 1381–1382 (`ROAD_FRAG_SPEC`, injected after `<lights_fragment_end>`) | Direct specular is scaled by `1 − 0.9 · smoothstep(0.45, 0.7, pud) · (1 − smoothstep(0.92, 1, pud))`. The rim loses its bright crescent; the puddle core keeps its glint |
| data.js 1306–1313 | `DISTRICT_RULES.puddleReflectFloor` 0.3, `puddleFloorFadeM` [18, 35], `poolPuddleGlint` 0.12 |
| data.js 1376, 1408, 1439, 1502 | `road.puddleRoughness` 0.18 → 0.32 (Overcast, Night, Toxic, Frozen): a softer lobe, with no pinhole glints |
| data.js 1409 | Night City `road.pools.intensity` 1.2 → 2.4 |

All of these are inert at puddle cover 0 and pool 0, so District 1 and Ash are pixel-identical (§5).
- Before / after look-dev: `AR/final/compare/lookdev-<tier>-night-overcast.png` and `lookdev-<tier>-toxic-frozen.png`.
- Rejected variants: `AR/exp/puddle/` (A–F, with the shader patched in memory through `PATCH=`) and `AR/exp/night/` (v0–v4).

### 4.3 Title-rig lamp clearance (`js/environment.js`, `js/render.js`)

**The problem.**
- `WORLD.camera.titleLandscape` puts the landscape / desktop title camera at x 4, y 5. That is 0.75 m inside the right lamp row (x 4.75), at the height of the lamp heads.
- Every 15 m, a lamp's pole, arm and head swept across the frame beside the logo and PLAY. At the title's 6 m/s, that is every 2.5 s (`AR/before/sheets/titles-desktop-b.png`; r5-integrate §5 issue 2).

**Options the integration left open,** each with a cost:
- Moving the rig: the rig is not my data, and moving it costs the sky band.
- Dithering every prop material: a `discard` in the opaque prop shaders defeats early-Z / HSR on mobile GPUs.
- Hiding the lamps outright: their shadows and Night's pools would stay behind.

**The fix: while the title rig is on, the lamp row beside the camera is cleared.**
- `render.titleBlend` (render.js 1596–1598) exposes the eased idle-rig weight.
- `env._titleClear()` (environment.js 1898–1925) runs once per frame and writes `uGrLampRow`. For each row, the value is `1 − blend · (1 − smoothstep(1.8, 2.8, |row x − camera x|))`.
- The lamp material scales that row's instances down to their feet (`LAMP_VERT_ROW`, after `<begin_vertex>`, lamp material only; lines 861–866 and 1416–1419).
- The road and ground pools of that row fade with it (lines 677 and 754).
- While a row is cleared, the lamp slot casts no shadow. `castShadow` is an object flag, not a program key, and `_swapSlot` keeps the hold (line 2117).

**What it affects.**
- Play (blend 0) and the portrait title (camera at x 0, rows 4.75 m away) see (1, 1).
- At a level start, the ring is re-laid under the 0.3 s camera tween anyway.
- After: `AR/after/sheets/titles-desktop-b.png`.

### 4.4 Docs

- **DISTRICTS.md**
  - §1 rule 2: the gate-wide legibility fixes; colours unchanged.
  - §2: road table (puddle roughness, pools 2.4) and §2.1 Night.
  - §4.4: Night ladder 2.4 → 1.2 → 0.8.
  - §6.2 Road: the art-review shader terms and `uGrLampRow`.
  - §8.1 `DISTRICT_RULES`: `puddleReflect` 0.3 as built, plus the three new keys.
  - §8.2 `titleBlend`; §8.3 the title clearance.
  - §10: acceptance items 13 (gate legibility on screenshots) and 14 (title clearance).
  - New §14: findings, changes, measurements, and decisions on the integration's open cells.
- **ARCHITECTURE.md:** §6.3 (`titleBlend`, `gatePanel`, and a "Round 5, art review" implementation bullet); §8 data keys; the `DISTRICT_RULES` key list.
- **GDD.md:** §14 Title (the lamp clearance); §15 materials (ring under the bloom threshold, item plate, plate ≥ 60 % opaque); §15.1 (wet roads, pools).
- **CALLSITES.md:** regenerated. It lists two new cross-module reads by environment: `render.titleBlend` and `render.camera.position`.

## 5. Verification

| Check | Result |
|---|---|
| District 1 frozen frame, environment / render edits (`AR/tools/pixid.mjs`; `AR/treeA` = this tree, `AR/treeB` = the same tree with environment.js and render.js as handed over) | Max channel diff 0 on Low, Medium and High |
| Programs (`AR/tools/progflat.mjs`: the title snapped to six districts, six 4 s fades, six level starts, back to the title; 21 samples per tier) | 58–58 on Medium, 58–58 on High, 42–42 on Low: the integration's numbers. The plate-opacity change is a uniform value |
| Smoke series: 48 runs, before and after | All CLEAN, every level cleared. Per-frame call maxima: main 34–46, shadow 10–16, post 10 or 14 |
| Frame time on a quiet host (`AR/tools/frametime.mjs`): Medium, before / after interleaved twice, L11 (Night: pools, puddles) and L6 (Overcast: rain, puddles), 40 s each | Identical in all 8 runs: median 6.9 ms, mean 6.95, p95 / p99 7.1, 0 frames over 50 ms (worst 14–28 ms), JS median 0.8 ms on a 144 Hz panel (`AR/final/frametime/ft.jsonl`). This desktop GPU hides fragment cost; see §6 item 6 |
| Exposure, 3D view of every play frame | Clipped ≤ 0.12 % before, ≤ 0.07 % after. Night's dark share fell slightly (§2.7) |
| Zombie silhouette : road | Unchanged on every tier: the road behind the look-dev line-up measures the same before and after |
| `TR/tools/validate-districts.mjs js/data.js` | ok, 0 errors |
| `node --check js/*.js` (22 files); `node tools/check-imports.js` | ok; 0 errors, 0 warnings |
| `node tools/build-artifact.js` | `artifact.html` byte-identical (md5 5faecc04…, index.html unchanged); the sw.js PRECACHE file list is unchanged |
| ARCHITECTURE §14 | No per-frame allocation: `_titleClear` writes numbers, and `Vector2.set` runs only on change. The shader terms are compile-time constants. No `console.log` and no `Math.random` were added. Every new data key is read guarded |

## 6. Open items and requests to other owners

1. **gates.js (gates owner): the item icon on Low.**
   - The icon quad material is `toneMapped: false`. On Medium and High the output pass tone-maps it with everything else; on Low (no composer) nothing does, so the icon renders darker: main colour Y 0.36 against 0.49.
   - Proposal: `toneMapped: true` plus `#include <tonemapping_fragment>` in `QUAD_FRAG`, as the glyph shader has.
   - The icon is also small on its plate, about 30 % of the plate width at the armed line. A larger `ICON_H` would read faster.
   - The darker item plate already brings the icon to ≥ 4.8 : 1 on Low; these changes would make Low match the other tiers.
2. **Gates data (`GATE_RULES.glow.pulseAmp`): the Low glow breathing.** It is the only lever left on the integration's Low cell (Frozen 17 px MAX panel p10 9.5, median 13.3); see DISTRICTS §14.
3. **Frozen ×1 panel: accepted.** It blends with the pale haze at 5–8 ΔE00, but reads by its frame, plate and glyph (≥ 4 : 1).
4. **Toxic saturation: accepted.** Mean saturation 0.67 and a flat distant smog: that is the brief, and the fixed gate tints box the fog in.
5. **Full-ring reward feel: art call, made.** The full ring no longer glows into the panel. If the team wants more celebration at a × cap, put it outside the plate: an fx burst on `gate:step` at the cap, or a gold-style rim like MAX. A bloom source next to the glyph is not the place.
6. **GPU cost on a real phone (perf QA).**
   - The road shader gains a handful of ALU ops per fragment: one `length`, two `smoothstep`s, a `max` and a few multiplies.
   - The lamp vertex shader gains one multiply.
   - The quiet desktop A/B shows no difference. A mid-range phone at Medium is the place to confirm it, together with r5-integrate §5 item 9.
7. **Medium shimmer: by design.** Thin poles and gate posts crawl at distance without MSAA (GDD §16).

## 7. How to re-run

```bash
AR=E:/Temp/claude/gate-rush-evidence/r5/art-review
node $AR/tools/legibility.mjs <low|med|high> <outdir> [ids] [reps=4] [z=-36] [after-js]   # SRC_JS=$AR/ab-before/js for the before tree
node $AR/tools/leg-analyze.mjs <outdir>
node $AR/tools/leg-summary2.mjs <before36> <after36> <before26> <after26>
node $AR/tools/lookdev.mjs <outdir> <tag> [quality] [ids] [apply-js]                    # PATCH=<module.mjs> patches served sources in memory
node $AR/tools/titles.mjs <outdir> [auto|low|med|high] [phone|desktop|landscape]
bash $AR/tools/series.sh <tag> play-1 med-6 low-11 boss-16 …                           # the screenshot series (smoke.js)
node $AR/tools/exposure.mjs <run dirs…>; node $AR/tools/summ.cjs <series dir>
node $AR/tools/frametime.mjs <quality> <level> <seconds>                                # SRC_JS=… for the before tree
node $AR/tools/pixid.mjs <treeA> <treeB> --quality <tier>                              # District 1 frozen-frame identity
node $AR/tools/progflat.mjs                                                             # programs per tier over districts / fades / starts
(cd $AR/tools/iv && node readability.mjs <tier> <outdir> 30 && node full-analyze.mjs <tier> <outdir>/bare-<tier>.json <outdir>/full-<tier>.json)
node $AR/tools/iv-compare.mjs <integration readability-final dir> <outdir>
```
