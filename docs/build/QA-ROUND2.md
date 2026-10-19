# Gate Rush — QA Round 2 triage

QA lead triage of the round-2 reports: the lead's seed list (5 issues) and seven testers (feel-balance 11, audio 9, mobile 8, perf-throttled 9, edge-cases 9, visual-2 15, carryover-check 13). The 79 raw issues become **96 fixer issues** in 10 groups (24 major, 48 minor, 24 polish, no blocker), plus 11 rejected or deferred items.

- **Duplicates merged.** For example, the lead's boss-TTK seed and feel-balance's shop-multiplier TTK became LVL-14. The mobile and edge-cases pause reports became CORE-7 plus its parts. Four allocation reports became WPN-8 / ENE-16 / GAT-9 / CHR-13 / FX-14.
- **Cross-group issues split.** Each was split into per-group parts with interface notes.
- **GDD is authoritative.** docs/GDD.md wins unless an issue records an amendment, and that issue names the group that writes it.

**Spot-checks during triage.** Evidence is under `docs/build/qa2/triage/`.

- I read the code at every cited root cause. The file:line references below are from this build.
- I ran `node tools/smoke.js --scenario play --level 1 --seconds 75 --shots 4 --out docs/build/qa2/triage/l1`. The verdict was CLEAN.
  - Count at the boss was 342 (2.44 × E_boss) and the Hulk died about 3.5 s after the fight started (LVL-14).
  - Hint pills sat on the horizon over the ×3 | +10 gates (UI-18, `04-play-13s.png`).
  - The title squad is black silhouettes (VIS-15, `00-title.png`).
  - The 200-soldier formation runs past the bottom edge (VIS-19, `12-play-45s.png`).
  - The count label shows under the results card (FX-11, `17-result.png`).
  - The worst frame outside screenshots was 62.6 ms, at the boss intro.
- I traced the boss intro and the results screen:
  - `node docs/build/qa2/carryover-check/trace.mjs docs/build/qa2/triage/trace-boss 1 - boss`
  - `node docs/build/qa2/carryover-check/trace.mjs docs/build/qa2/triage/trace-results 1 - results`
  - Scan: `node docs/build/qa2/triage/trscan.cjs <trace.json> 0 99999 12`
- What the traces show:
  - **Boss intro.** The 63 ms frame is three GPU-process raster flushes (`RasterDecoderImpl::DoEndRasterCHROMIUM` 28.5 + 22.5 + 22.4 ms).
  - **Results screen.** The first frame is **285 ms unthrottled**, and 255 ms of it is one DOM raster flush.
  - **Neither has a long JS task or a shader link.** Neither has a main-thread task over 30 ms or a shader program link.
  - **The warm-up premise is re-scoped.** This is why the lead's warm-up premise is re-scoped; see Rejected.

## Summary

| Group | Files the group may edit | Major | Minor | Polish | Total |
|---|---|---|---|---|---|
| visual | js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js | 1 | 6 | 5 | 12 |
| gates | js/gates.js, js/pickups.js | 2 | 2 | 1 | 5 |
| fx | js/fx.js | 0 | 4 | 1 | 5 |
| characters | js/models.js, js/squad.js, js/troops.js | 2 | 3 | 1 | 6 |
| enemies | js/zombies.js, js/boss.js | 1 | 5 | 2 | 8 |
| weapons | js/weapons.js | 1 | 2 | 1 | 4 |
| level | js/level.js, js/levelgen.js, tools/validate-levels.js | 7 | 9 | 6 | 22 |
| ui | js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js | 3 | 9 | 5 | 17 |
| audio | js/audio.js | 5 | 5 | 0 | 10 |
| core | js/engine.js, js/main.js, js/util.js | 2 | 3 | 2 | 7 |
| **all** | | **24** | **48** | **24** | **96** |

## Rules for fixers (round 2)

- **Files.** Edit only your group's files. Three files are shared: `js/data.js`, `docs/GDD.md` and `docs/ARCHITECTURE.md`.
  - Edit only the keys or sections listed in your issues' *Data keys*. The table below gives the owner of each.
  - Mark new keys "(new)" and give each a comment with the GDD section and the QA id, e.g. `// QA LVL-14`.
  - Tag every amended GDD/ARCH line "(round-2 QA <ID>)". For round-1 items, use "(round-1 QA <ID>)".
- **Evidence.** Every run uses its own `--out docs/build/qa2/fix-<group>/<run>`. Never overwrite the testers' folders.
  - Some tester scripts write to a fixed folder: `docs/build/qa2/edge-cases/t*.mjs`, `docs/build/qa2/mobile/*.mjs`, and `docs/build/qa2/visual-2/tools/*` (which also has an absolute ROOT).
  - Copy those scripts, plus their `lib.mjs`, into `docs/build/qa2/fix-<group>/` first. The folder is at the same depth, so ROOT still resolves.
  - Then change the hard-coded output path, and run the copy.
  - camp.mjs, throttle.mjs, perfprobe.mjs, rec.mjs and smoke.js take `--out`.
- **Before handing back:**
  - `node tools/check-imports.js`
  - `node tools/smoke.js --scenario all --out docs/build/qa2/fix-<group>/all` must stay CLEAN.
  - Level also runs `node tools/validate-levels.js`.
  - Run `node tools/callsites.js` after changing a public method.
- **artifact.html.** Never hand-edit it. `tools/build-artifact.js` regenerates it at integration.
- **Budgets.** GDD §16: zero per-frame allocations, pools allocated once, no texture uploads during play, and no new shader programs during play.
- **Harness.** On this machine headless Chrome renders at about 144 fps, and the engine snaps refresh to 8.33 ms. Until CORE-6 lands, the auto-scaler can demote the tier mid-run, so pass `--quality high|med|low` to every perf or visual verification. `report.frames` excludes screenshot stalls, and that exclusion also hid the 285 ms results frame. Use `trace.mjs` for first-frame checks.
- **Order of work:**
  1. CORE-7 (theatre clock), VIS-14 (depth-material helper), and LVL-15 then LVL-14 (the balance baseline) land first.
  2. ENE-16 and GAT-9 implement `hitTestSeg` before WPN-8 switches to it. WPN-8 keeps a fallback.
  3. UI-25 and LVL-24 land together.
  4. Re-measure the balance issues LVL-21/22/23/27 after LVL-14/15/16.

## Cross-group interfaces (round 2)

- **LVL-14 → enemies / ui:** no API change. level scales `spec.hp` before `boss.spawn(spec)`. boss.js already derives maxHp, the twins split, the Colossus shield (15 % of max) and the phase thresholds from `spec.hp`. ui draws `boss:spawn.maxHp`. Neither boss.js nor ui.js may cache the table HP.
- **CORE-7 → ENE-17, LVL-29, VIS-18, UI-28:** core adds `ctx.time.theatre`, in ms. It advances by real frame time only while the state is not `paused`. Every theatre deadline moves to it, with fallback to `time.now` while it is undefined:
  - boss intro, fight start and collapse
  - level `_finishAt`
  - render dolly and game-over camera
  - ui name card, hint and boss-bar-out timers

  core also stops the slow-mo countdown while paused.
- **VIS-14 → ENE-15, GAT-8:** visual adds `MaterialLibrary.depthFor({ instanced, instanceColor, map })`. It returns a cached `MeshDepthMaterial({ depthPacking: RGBADepthPacking })` for each combination. Environment casters use it.
  - zombies' acid globs (ENE-15) and pickups' crates (GAT-8) either use it or stop casting shadows.
  - Non-instanced casters (boss rig parts, troops, the thrown car) keep three's default, so the default only ever sees one combination.
- **ENE-16 + GAT-9 → WPN-8:** new typed-segment queries `zombies.hitTestSeg(seg, radius, out)`, `boss.hitTestSeg(seg, radius, out)`, `gates.hitTestSeg(seg, out)` and `pickups.hitTestSeg(seg, out)`.
  - `seg` is the weapons module's `Float64Array(4)` `[x0, z0, x1, z1]`.
  - Semantics and the `out` shape are identical to the existing `hitTestSegment`, which stays for other callers.
  - weapons uses `hitTestSeg` when present and falls back to `hitTestSegment` otherwise.
- **CHR-10 + GAT-6 + LVL-20 (dead squad):** each part stands alone, together they are defence in depth.
  - squad ignores `applyGate` and `addSoldiers` once `squad:dead` has fired (until `reset`).
  - gates resolves no pass and pickups grants nothing at C = 0 or in phase `lost`.
  - level ignores `gate:pass` and gate/crate coins in phase `lost`.
- **VIS-12 + GAT-7 (glyph contrast):** visual darkens a plate behind the glyph block in the panel shader, caps panel luminance and thickens the atlas outline. gates lowers `PALETTE.glyph.emissive` and enlarges the + / − op glyphs. Acceptance (≥ 3:1 on every tier) is measured with both landed.
  - fx derives its HDR white for floaters and damage numbers from `PALETTE.glyph.emissive` (round-1 FX-1). FX-10 and FX-12 check that floaters still read, and fx may use its own gain.
- **ENE-12 + WPN-7 (brutes):** enemies keeps a contact brute at the formation's front edge, on the straight bullet path. weapons drops the boss re-aim while a zombie is in contact range, using the existing `zombies.nearest()`.
- **ENE-13 + WPN-9 (boss impacts):** enemies puts the cosmetic impact point in a chest band (`BOSSES.hitYRange`). weapons makes boss-aimed tracers climb to that band. Hit tests stay XZ.
- **CHR-14 → FX-13:** `troop:fire` gains `y`, the muzzle world height. fx starts the sniper beam there, with fallback to the old formula.
- **FX-11 + UI-30:** fx hides the count label in `complete` and `gameover`. ui lays out the reward chips 2 × 2.
- **UI-25 + LVL-24 (hint marking):**
  - level stops calling `save.markHint` in `showHint`. It keeps the `hintDone` check and a per-run emitted set.
  - ui queues hints and calls `ctx.save.markHint(id)` when the hint is actually displayed.
  - The `hint:show` payload is unchanged.
- **LVL-25 + UI-18:** level fires the boss hint from `boss:fight`. ui bottom-anchors every hint, the boss hint included.
- **CORE-9 ↔ UI-19, UI-29, VIS-17 (boot):**
  - main awaits `ui.prewarm()` (UI-19) before `hideBoot`.
  - main calls `ui.setBootCaption(step)` (UI-29) at each step.
  - main maps `render.warmup(onProgress)` (VIS-17) onto the boot bar.
- **UI-18 ↔ VIS-19:** the bottom-anchored hint may cover the rear soldier rows. The lead accepted this ("under the squad, like the ads"). VIS-19 keeps the whole formation on screen.

## Shared-key ownership (round 2): js/data.js, docs/GDD.md, docs/ARCHITECTURE.md

No key is assigned to two groups. Read any other key freely; never edit it.

| Group | data.js keys it may edit | GDD / ARCH sections it may edit |
|---|---|---|
| visual | `RENDER.atlas.strokePx`, `QUALITY_TIERS.med.bloomMips (new)`, `RENDER.title (new)`, `WORLD.camera.countDolly`, `WORLD.camera.title`, `WORLD.camera.titleLandscape (new)`, `RENDER.env.manhole (new)` | GDD §2 (camera rows), GDD §15 (Materials paragraph), GDD §16 (tier table), ARCH §6.3 |
| gates | `PALETTE.glyph.emissive`, `GATE_RULES.glyph.icon`, `PICKUPS.crate.hitFlash (new)`, `PICKUPS.crate.hitFlashGain (new)`, `PICKUPS.crate.hitFlashRetrigger (new)` | GDD §4.1, GDD §15 (Gates row), GDD §12 (J3 row) |
| fx | `JUICE.label.plateAlpha (new)`, `JUICE.label.platePad (new)`, `JUICE.damageNumber.bossScale (new)`, `JUICE.damageNumber.bossSide (new)`, `JUICE.damageNumber.bossRise (new)`, `JUICE.damageNumber.bossSlots (new)`, `JUICE.damageNumber.mergeSeconds`, `JUICE.caps.bossNumbers (new)` | — |
| characters | `TROOPS.drone.hover`, `TROOPS.anim.droneSideX (new)`, `TROOPS.sniper.scale`, `TROOPS.sniper.crateH`, `TROOPS.apc.ahead`, `TROOPS.flamer` | GDD §8.3, ARCH §5.1, ARCH §6.5 |
| enemies | `ZOMBIES.brute.maxContactZ (new)`, `ZOMBIES.brute.contactHomingZ (new)`, `ZOMBIES.brute.maxSwings (new)`, `ZOMBIES.brute.contactHoming`, `ZOMBIES.common.introAheadM` (delete), `BOSSES.hitYRange (new)`, `BOSSES.anim.sacPulseMin`, `BOSSES.anim.sacPulseMax`, `BOSSES.anim.sacGain (new)`, `BOSSES.anim.flashTint`, `BOSSES.anim.lightIntensity`, `BOSSES.anim.lightOffsetZ (new)`, `BOSSES.retreatSpeed / gaitRefMs / phaseEntryCool / targetZ / introSparkEvery (new)` | GDD §6.1 |
| weapons | `FIRE.bossAimYieldM (new)`, `WEAPONS.rocket.smoke.colorIdx (new)` | GDD §15 (Tracers row), ARCH §6.8 (damage weight comment), ARCH §6.11, ARCH §7, ARCH §8.4 |
| level | `BOSSES.squadScale (new)`, `BOSSES.shopScale (new)`, `LEAK_MODEL`, `LEVELS.endless`, `LEVELS.authored[1] (LEVEL_1)`, `LEVELS.curve.assistAfterFails (new)`, `LEVELS.curve.assistStartFrac (new)`, `LEVELS.curve.introSearchM / introShiftStepM / introShiftMaxM (new)`, `ECONOMY.starBonus`, `ECONOMY.failBonusFrac (new)`, `GATE_RULES.plus.maxCoins`, `GATE_RULES.mult`, `GATE_RULES.generation.opener (new)`, `GATE_RULES.generation.greedyProfiles (new)`, `HINTS.x2`, `HINTS.tryx2` | GDD §0, §1 (incl. §1.1), §4.2, §4.4, §6.3, §7, §9, §10, §10.1, §11, ARCH §6.16 |
| ui | `JUICE.ui.hintY` (retire), `JUICE.ui.hintBottomPx (new)`, `JUICE.ui.hintMaxWidthPct (new)`, `JUICE.ui.hintAlpha (new)`, `JUICE.ui.hintQueueMax (new)`, `JUICE.ui.confirmMinS (new)`, `STRINGS.boot.steps`, `STRINGS.hud.level` | GDD §14, ARCH §10.3 |
| audio | `AUDIO_CUES` (all), `MUSIC` (all) | GDD §13 |
| core | `QUALITY_TIERS.scaler`, `SQUAD.steer.landscapeWidthFactor (new)`, `JUICE.ui.resizeDebounceMs (new)` | GDD §2 (time row), GDD §3.2, GDD §16 (auto-scaler paragraph), ARCH §2.2, ARCH §6.2 |

`BOSSES.squadScale` and `BOSSES.shopScale` are read only by level.js. That is why level owns them even though the other `BOSSES.*` keys belong to enemies.

## Issues by severity

### Major (24)

#### [VIS-12] Gate value glyphs read at only 1.1–1.8:1 against their own panels: white digits on pastel panels, and the glyphs bloom on High (panel side)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** major · **From:** visual-2 (glyph contrast); lead seed #4 (h)
- **What:**
  - **High.** The white value glyph (about #F5F0ED, luma about 241) sits on panel interiors of luma 177–230.
    - '×4' on #D1EECF / #AEE7B0 is about 1.1–1.2:1.
    - '+10' on #74BDEA / #9AC8EC is about 1.8:1.
  - **Low.** Still under 3:1 (panel 131–166 against glyph 215).
  - **Outline.** The 12 px atlas outline is invisible at play distance.
  - **Bloom.** Glyphs still bloom on High (round-1 carry-over (h)).
  - Pillar 5 says gate values are one of the three things that must read first.
- **Root cause:** `js/materials.js` PANEL_FRAG (:266-440) composites the panel body with no luminance cap. The body is the tint, plus the far-background compensation mixed by `uFogK.z`, plus the sheen at :437-438. Lit or far panels therefore reach 0.7–0.9 linear right behind the glyph. `RENDER.atlas.strokePx` is 12 on a 100 px glyph (js/data.js:848).
- **Expected:** GDD §1 pillar 5 and §4.1. Every value glyph reaches ≥ 3:1 against the panel area behind it at the armed line (z = −36, glyph about 29 px), on High, Medium and Low. The type hue stays recognisable (four-way encoding).
- **Fix (js/materials.js, js/render.js):**
  1. In PANEL_FRAG, cap body luminance before compositing: `lum = dot(col, vec3(0.2126, 0.7152, 0.0722)); col *= min(1.0, 0.45 / max(lum, 1e-3));`
  2. Clamp the far compensation: `col = mix(col, min(comp, vec3(0.5)), uFogK.z)`.
  3. Darken a rounded backing plate under the glyph block:
     - `plate = 1.0 − smoothstep(0.0, aa, grRoundBox(vP − vec2(0, −0.05·h), vec2(0.78·vHalfW, 0.36·uHalf.y), 0.25))`
     - `col = mix(col, uDark, 0.45·plate)`
     - No sheen inside the plate.
  4. `RENDER.atlas.strokePx` 12 → 18. The atlas is built once at boot, so there are no uploads in play.
  5. Leave the MAX badge, ring gauge, hazard stripes and the hit/flip flash path unchanged.
  6. Note the plate in GDD §15's Materials paragraph.
- **Interface:** GAT-7 sets `PALETTE.glyph.emissive` and the size of the + / − op glyphs. Acceptance is measured with both landed.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 1 --seconds 40 --shots 2 --quality high --out docs/build/qa2/fix-visual/glyph-high`. Repeat with `--quality med` and `--quality low`.
  2. Sample the gates at z ≈ −36 with docs/build/qa2/visual-2/tools/sample.mjs, using the 9 s, 17 s and 29 s shots.
  3. Glyph-to-plate contrast is ≥ 3:1 for +, ×, − and ÷ on all three tiers.
  4. The panel rim hue is still identifiable. Compare against docs/build/qa2/visual-2/crops/l1-gate17.png.
- **Evidence:** docs/build/qa2/visual-2/shots/l1c_09-play-17s.png, crops/l1-gate17.png, crops/l1-gate29.png, shots/l13rail_21-result.png (Low); docs/build/lead/l1/04-play-13s.png; docs/build/round1-crossgroup.txt (fx: "gate glyphs still bloom noticeably on High")
- **Data keys:** `RENDER.atlas.strokePx`, `GDD §15 (Materials paragraph)`

#### [GAT-6] A dead squad is revived by a + gate during the game-over run-on (gates / pickups part)

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** major · **From:** edge-cases (dead squad revived)
- **What:**
  - **Setup.** L2 with C = 3 and a '+20|+20' pair at z = −12. The last 3 soldiers are bitten 0.15 s before the pass.
  - **Event log.** '2.07 squad:dead ph=lost', then '2.22 gate:pass +22 0>22 ph=lost'.
  - **On screen.** The label shows 22, soldiers stand behind SQUAD LOST, and 'Coins kept' includes that gate's coins.
- **Root cause:**
  - `js/gates.js:1086` resolves every event that reaches z ≥ 0 (`_resolvePass` :1161) with no squad-alive or phase check.
  - Crate contact, hit-open and `grantItem` in `js/pickups.js` have no check either.
- **Expected:** GDD §7 / §10: the run is lost at C = 0. After `squad:dead`, nothing changes the count and no gate or crate reward applies.
- **Fix (js/gates.js, js/pickups.js):**
  1. **gates.step.** When an event reaches z ≥ 0 and `ctx.squad.count === 0` or `ctx.level.phase === 'lost'`, mark every lane ST_MISSED and emit `gate:miss` instead of calling `_resolvePass`.
  2. **pickups.** Crate contact, hit-open and `grantItem` do nothing while `ctx.squad.count === 0`. The crate keeps scrolling and despawns.
- **Interface:** CHR-10 makes `squad.applyGate` / `addSoldiers` no-ops after death. LVL-20 ignores passes and gate/crate coins in phase `lost`.
- **Verify:**
  1. Copy docs/build/qa2/edge-cases/{lib.mjs,t5-squad.mjs} into docs/build/qa2/fix-gates/, with out → docs/build/qa2/fix-gates/t5-squad.
  2. After `squad:dead` there is no `gate:pass`; a `gate:miss` appears instead.
  3. The count stays 0 on screen.
  4. 'Coins kept' is unaffected by the gate in both the 0.15 s and the 0.6 s cases.
- **Evidence:** docs/build/qa2/edge-cases/t5-squad/report.json, 04-dead-then-gate-0.15.png, 05-dead-then-gate-0.15-result.png
- **Data keys:** none

#### [GAT-7] Gate glyph contrast: glyph side (HDR glyph emissive blooms, + / − op glyph drawn small and grey) and the round-1 gate doc lines

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** major · **From:** visual-2 (glyph contrast); lead seed #4 (h)
- **What:**
  - **Bloom.** This is VIS-12's defect from the glyph side. The glyph quads are HDR: `PALETTE.glyph.emissive` 1.2 is above `RENDER.bloom.threshold` 0.85, so on High every value glyph blooms into its panel.
  - **Op glyph.** The + / − op glyph is drawn at `GATE_RULES.glyph.icon` 0.7 m, about a third of the digit height, in pale grey.
- **Root cause:** js/gates.js glyph quads use `PALETTE.glyph.emissive` (js/data.js:945) and, for + −, `GATE_RULES.glyph.icon` (js/data.js:179).
- **Expected:**
  - GDD §1 pillar 5 / §4.1: glyph ≥ 3:1 against its panel at z = −36 on every tier.
  - No bloom halo bleeding into the panel.
  - The op glyph reads as part of the value.
- **Fix (js/gates.js + data):**
  1. **Emissive.** `PALETTE.glyph.emissive` 1.2 → ≤ 0.9, under the bloom threshold. Check the digits stay white, not grey, after ACES on High and Medium.
  2. **Op glyph size and colour.** `GATE_RULES.glyph.icon` 0.7 → 0.95 m for + and −; × and ÷ stay at `opMultDiv` 1.05. Draw op glyphs in the glyph fill colour.
  3. **Round-1 doc lines in sections you own:**
     - GDD §4.1 "glyph (+ × − ÷ at 0.7 m)" → "+ − 0.95 m, × ÷ 1.05 m (round-1 QA GAT-3, round-2 QA GAT-7)".
     - GDD §15 Gates row "emissive 2.5" → the new value.
     - GDD §12 J3 "panel emissive +1.0 decaying 120 ms" → "tinted, rate-limited, capped at 0.45 under sustained fire (round-1 QA GAT-1)".
- **Interface:**
  - VIS-12 adds the panel plate, the luminance cap and the thicker outline.
  - fx derives its floater/damage-number white from `PALETTE.glyph.emissive`. FX-10 and FX-12 re-check readability, and fx may decouple with its own gain.
- **Verify:**
  1. Repeat VIS-12's runs with `--out docs/build/qa2/fix-gates/glyph-<tier>`.
  2. Contrast is ≥ 3:1 on every tier.
  3. A 3× crop around a +N glyph on High shows no halo outside the glyph outline.
- **Evidence:** as VIS-12; js/data.js:179, :945
- **Data keys:** `PALETTE.glyph.emissive`, `GATE_RULES.glyph.icon`, `GDD §4.1`, `GDD §15 (Gates row)`, `GDD §12 (J3 row)`

#### [CHR-9] With all five troops the props hide the squad and crowd the count label (drone over the label, oversized sniper running off-screen, APC over the front rows)

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** major · **From:** visual-2 (troops hide the squad)
- **What:** Probe at L13 on 390×844 (css px):
  - **Drone.** Rect [200,548]–[333,625], over the label (centre 195,618).
  - **Sniper.** Sniper plus crate is 168 × 253 px, about 2× a soldier column of 91 px, and its bottom is at 849 > 844.
  - **APC.** Rect [129,465]–[261,641], covering the label area and the front rows.
  - **Small squads.** With 5 soldiers the squad cannot be seen at all (l14laser_03).
- **Root cause:** `js/troops.js` `_computeTarget` (:616-650) plus the TROOPS data:
  - The drone hovers 3 m up, with `droneSideX` 1.0 m (local ANIM in troops.js:69).
  - The sniper is scale 1.4 on a 0.5 m crate at the blob's rear centre.
  - The APC sits 2.5 m ahead at full body height.
- **Expected:** GDD §8.3: troops support the squad's read, not replace it. GDD §3.1 and pillar 5: the count label and the squad stay readable. Nothing troop-related leaves the viewport.
- **Fix (js/troops.js, js/models.js + TROOPS data):**
  1. **Drone.** `TROOPS.drone.hover` 3 → 4.6 m. Side offset 1.0 → 2.2 m (`TROOPS.anim.droneSideX`, new: moves the troops.js literal into data), which clears a 4-digit label (about ±0.9 m).
  2. **Sniper.** Target the rear-left corner, x = −(blob half-width + 0.6 m). `TROOPS.sniper.scale` 1.4 → 1.15. `TROOPS.sniper.crateH` 0.5 → 0.3.
  3. **APC.** `TROOPS.apc.ahead` 2.5 → 3.5 m, or scale the body height ×0.75 in `models.buildTroopMesh`. Keep the hit box at `TROOPS.apc.width × length`.
  4. **Docs.** Amend the GDD §8.3 Position column (drone 4.6 m, APC 3.5 m ahead, sniper rear-left).
- **Interface:** none for fx. The count label already draws on top of everything (renderOrder 42, depthTest off). The sniper beam origin is CHR-14 → FX-13.
- **Verify:**
  1. Copy docs/build/qa2/visual-2/tools/probe.mjs and m_troops.js into docs/build/qa2/fix-characters/ (see Rules), then run the visual-2 troops probe at L13.
     - No troop rect intersects the label rect.
     - Sniper plus crate is ≤ 1.3× a soldier column and fully inside 844 px.
     - The APC does not cover the two front soldier rows.
  2. Run `node tools/smoke.js --scenario play --level 14 --seconds 20 --shots 2 --after "['troop.sniper','troop.medic','troop.flamer','troop.drone','troop.apc'].forEach(t=>g.troops.add(t))" --out docs/build/qa2/fix-characters/troops14`. The squad and its count are unobstructed in every shot.
- **Evidence:** docs/build/qa2/visual-2/reports/probe-troops13.json; shots/l13rail_04-play-10s.png, l14laser_05-play-9s.png, l14laser_03-play-5s.png, l13rail_21-result.png; crops/l13-troops10.png
- **Data keys:** `TROOPS.drone.hover`, `TROOPS.anim.droneSideX (new)`, `TROOPS.sniper.scale`, `TROOPS.sniper.crateH`, `TROOPS.apc.ahead`, `GDD §8.3`

#### [CHR-10] A dead squad is revived by a + gate (squad part: `applyGate` lifts C = 0 to ≥ 1)

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** major · **From:** edge-cases (dead squad revived)
- **What:** See GAT-6. A pass at C = 0 lifts the squad to max(1, 0 + 22) = 22. `addSoldiers` also accepts additions at C = 0.
- **Root cause:** `js/squad.js:577` `applyGate` clamps the result to ≥ 1 ("a gate never takes C below 1"), even when `before` is 0. `addSoldiers` (:504-514) has no dead check.
- **Expected:** GDD §7 / §10: once `squad:dead` fired, the count is final until the next level starts. "Never below 1" applies only to a living squad.
- **Fix (js/squad.js):**
  1. Keep a `_dead` flag. Set it where `squad:dead` is emitted; clear it in `reset()`.
  2. While dead, `applyGate` returns `{ before: 0, after: 0 }` without invulnerability or events.
  3. While dead, `addSoldiers` returns early.
  4. `setCount(n, 'debug')` keeps working for QA hooks.
- **Interface:** GAT-6, LVL-20.
- **Verify:**
  1. The t5-squad copy (docs/build/qa2/fix-characters/t5-squad) shows the count stays 0 after `squad:dead`.
  2. `node tools/smoke.js --scenario all --out docs/build/qa2/fix-characters/all` is CLEAN.
- **Evidence:** docs/build/qa2/edge-cases/t5-squad/report.json
- **Data keys:** none

#### [ENE-12] A brute that touches the formation from the side latches inside it, behind every muzzle, and cannot be killed

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** major · **From:** feel-balance (brute latch); lead seed #5 (brute contact kills 9–12 per encounter)
- **What:**
  - **bruteprobe L10.** Brute slot 222 spawns at x = +3.1 in a flank wave.
    - It passes the front row at z −0.45 without contact (the formation's half-width is 1.8 m).
    - It touches the formation's flank at z = +2.66, and contact homing pulls it to x = 0.
    - It stays there from 81.1 s to 93 s: HP 304 → 289, 10 swings, 30 soldiers.
    - It is finally removed by 'cleanup', never killed.
  - **Campaign.** L10 cost 30 soldiers and L11 cost 33 to one brute.
  - **Endless.** Single brutes stayed latched for 365 swings, killing 1 095 soldiers.
  - **On screen.** Every tracer flies forward past it (latchshot2/latch-1.png).
  - **Lead seed.** The seed's "brute contact kills 9–12 per encounter" is the same contact rule seen on-curve.
- **Root cause:** `js/zombies.js:1270-1281`.
  - Contact is tested anywhere along the formation (`z > CONTACT_Z && squad.intersectsCircle`).
  - Once in contact, the brute holds its z (vz = 0) while homing x to the squad centre at `ZOMBIES.brute.contactHoming` 3.5 m/s.
  - Shooters fire along −Z from the front rows, so a brute at z > 0 is never on a bullet path.
- **Expected:**
  - GDD §6.1: the brute "does not die on contact" but is focus-fired, with a stagger every 25 %.
  - Pillar 4: losses are fair and telegraphed.
  - Lead target: ≤ 6 soldiers per brute encounter on-curve.
- **Fix (js/zombies.js + data):**
  1. **Front-edge only.** A brute may hold and swing only at the formation's front edge. While in contact with z > `ZOMBIES.brute.maxContactZ` (new, about −0.3 m, i.e. in front of the front row):
     - it walks toward the front at `ZOMBIES.brute.contactHomingZ` (new, about 4 m/s; vz = −contactHomingZ in the squad frame) while still homing x;
     - it does not swing until z ≤ maxContactZ;
     - a latched brute's z never exceeds maxContactZ + 0.5 m.
  2. **Telegraph.** Keep the swing cooldown. The 0.8 s ring fill restarts when the brute reaches the front.
  3. **Backstop.** After `ZOMBIES.brute.maxSwings` (new, 6) swings, the brute staggers back 2 m and re-telegraphs instead of swinging again. It never dies without being killed.
  4. **Docs.** Amend the GDD §6.1 brute row: "contacts and swings only at the formation front; a flank contact walks to the front first".
- **Interface:** WPN-7 stops the boss re-aim while a zombie is in contact range, so these brutes are focus-fired during boss fights too.
- **Verify:**
  1. Run `node docs/build/qa2/feel-balance/camp3.mjs --player passive --only 10 --shop none --ranks '{"squad":4,"fireRate":3,"damage":3,"coinMult":5,"bossDamage":3}' --after "<brute sampler from bruteprobe/L10-a1.json>" --dump window.__bp --out docs/build/qa2/fix-enemies/bruteprobe-10`. Repeat with `--only 11`.
     - Every brute dies by bullet, explosion or flame; none is removed by 'cleanup' while latched.
     - Max latched z ≤ maxContactZ.
     - Median soldiers lost per brute ≤ 6.
  2. Run `camp.mjs --player strong --from 1 --to 0 --endless 1 --maxsec 900 --ranks '{"squad":3,"fireRate":2,"damage":2,"coinMult":4,"bossDamage":2}' --out docs/build/qa2/fix-enemies/endless`. No brute swings more than 6 times.
- **Evidence:** docs/build/qa2/feel-balance/bruteprobe/L10-a1.json; latchshot2/latch-1.png; camp-passive/L10-a1.json, L11-a1.json; endless-strong/endless-1.json; QA-ROUND1 verifier remaining #3 (lead seed #5)
- **Data keys:** `ZOMBIES.brute.maxContactZ (new)`, `ZOMBIES.brute.contactHomingZ (new)`, `ZOMBIES.brute.maxSwings (new)`, `ZOMBIES.brute.contactHoming`, `GDD §6.1`

#### [WPN-7] The boss re-aim ignores zombies in contact (a brute chews the squad while every shot goes to the boss); harden firing so shooters can never silently stop

- **Group:** weapons (js/weapons.js) · **Severity:** major · **From:** lead seed #4 (a) and (b)
- **What:**
  - **(a) Contact zombies are ignored.** During a boss fight every shooter aims at the boss core (`js/weapons.js:878-889` `_computeAim`; :953-958 `_shoot`). A phase-3 brute or minion at the squad front takes almost no bullets while it swings for 3 soldiers per second. Round-1 p4: 4.7 s in contact, HP 331 → 111.
  - **(b) Firing can stop.** Round-1 L4 report: a squad of 93 "fired 0 bullets from 88 s" while the Hulk sat at 606 HP in phase 3, and the squad was lost. This was not reproduced.
    - In docs/build/qa/fix-level/l4 the phase-3 samples show live bullets 2–16 while the boss stalled at 261 → 252 HP and C fell 131 → 114: shots soaked at point blank.
    - Nothing guards against a NaN or zero fire config: `if (!(adv > 0)) return` in `_fireRifles` silently stops every shooter.
- **Root cause:**
  - (a) `_computeAim` returns true whenever the boss is within `FIRE.bossAimRange`, regardless of nearer threats.
  - (b) No invariant or diagnostic on the `_fireConfig` results (:913-933) or on V_AIM.
- **Expected:**
  - GDD §3.3 "minions on the line still soak"; §6.1 brutes are focus-fired.
  - The squad never stops shooting while C > 0 and a target exists.
  - Pillar 4: losses are fair.
- **Fix (js/weapons.js + data):**
  1. **Yield the boss re-aim to contact threats.** In `_computeAim`, query `zombies.nearest(squad.x, 0, OUT)` once per step. Disable the boss re-aim for this step when both hold:
     - a living zombie is within `FIRE.bossAimYieldM` (new, 6 m) ahead of the front row (OUT.z ≥ −bossAimYieldM);
     - |OUT.x − squad.x| ≤ `world.squadHalfWidth` + 1 m.

     Bullets then fly straight and hit it. The drone and sniper keep their own targeting.
  2. **Hardening:**
     - If V_AIM has a non-finite component, or `_cfgPer`, `_cfgScale` or `_cfgWeight` is not finite and > 0, use the base rifle config for the step and `warnOnce('weapons.fireConfig')`.
     - Expose shots/s in `ctx.debug` and on the overlay.
     - Under `?debug=1`, `warnOnce` when C > 0, the state is 'playing', and there have been 0 shots for 1 s.
- **Interface:** ENE-12 keeps contact brutes at the front edge, on the straight bullet path. `zombies.nearest()` is an existing query (ARCH §6.7).
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 4 --boss --seconds 60 --after "g.squad.setCount(93,'debug'); setTimeout(()=>{ g.zombies.spawn('brute',-1,-6,400,{}); g.zombies.spawn('brute',1,-6,400,{}); }, 9000)" --out docs/build/qa2/fix-weapons/soak-l4`.
     - Both brutes die within about 5 s of contact.
     - The boss HP keeps falling afterwards.
     - No 2 s timeline sample has the boss alive with neither bullets nor HP progress.
     - There is no hardening `warnOnce`.
  2. Repeat with a heavy weapon active: add `g.weapons.startWeapon('weapon.rocket')` (and, separately, `'weapon.laser'`) to `--after` at 9 s. The same acceptance holds.
- **Evidence:** docs/build/round1-crossgroup.txt (characters: "phase-3 brute in contact … takes little damage because bullets keep aiming at the boss"; level: "squad of 93 fired 0 bullets from 88 s"); docs/build/qa/fix-level/l4/report.json (phase-3 samples)
- **Data keys:** `FIRE.bossAimYieldM (new)`

#### [LVL-14] Boss HP ignores the arriving squad and the shop: fights last 2–5 s even on or under the curve

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major · **From:** lead seed #2; feel-balance (boss TTK collapses with shop multipliers)
- **What:**
  - **Above the curve.** The L1 bot arrives with 342 soldiers (2.44 × E_boss) and kills the 2 800 HP Hulk about 3.5 s after the fight starts (docs/build/qa2/triage/l1 timeline 52.6 → 56.2 s).
  - **Strong bot.** TTK L1 3.9, L6 4.9, L7 4.4, L10 4.3, L11 2.3 and L12 2.1 s. Only 2 of 12 levels fall in 12–22 s.
  - **Passive player, below the curve.** L10 3.8 s at 74 % of E_boss, L11 4.8 s at 57 %, L12 2.9 s at 79 %. The fire-rate × damage × boss-damage ranks multiply DPS by ×1.6–3.6 while boss HP stays at 20·E_boss.
  - **Attacks never seen.** In a 2–4 s fight the Hulk's 5 s slam never fires: L12 boss losses were {} for every player type.
- **Root cause:** `js/level.js:1113-1146` `_fireBoss`: `hp = ev.hp` or `roundBossHp(BOSSES.hpPerE · E_boss)` (:1136). Nothing depends on the live count or on `ctx.profile`.
- **Expected:**
  - Lead decision, with GDD §17 boss TTK 12–22 s: every boss fight lasts about 8–25 s, so its phases and attacks are seen.
  - A bigger army or a better shop still wins faster: TTK strictly decreases with C and with the shop multiplier.
  - HP is never below the designed value, and the HP bar shows the scaled max.
- **Fix (js/level.js + data):** In `_fireBoss`, after `hp` is resolved, for campaign bosses and endless mini-bosses (E = `endlessE(D)`):
  1. **Count scale (lead decision).** C = squad.count, E = E_boss. `countScale = clamp((C/E)^BOSSES.squadScale.exp, 1, BOSSES.squadScale.maxMult)`, with `exp` 0.6 and `maxMult` 2.0 (new keys).
  2. **Shop scale (new rule).**
     - m = (profile.fireRate / FIRE.rateBase) · profile.damage · profile.bossDamage, which is 1.0 at base ranks.
     - `shopScale = clamp(m^BOSSES.shopScale.exp, 1, BOSSES.shopScale.maxMult)`, with `exp` 0.75 and `maxMult` 4.0 (new keys).
     - Tune `exp` within 0.6–1.0 to meet the targets below.
  3. **Apply.** `spec.hp = roundBossHp(hp · countScale · shopScale)`. `boss.spawn` already derives maxHp (twins split it), the shield and the phase thresholds from `spec.hp`, and the bar draws `boss:spawn.maxHp`.
  4. **Record.** Store `run.bossHpScale` and emit it as a debug histogram.
  5. **Docs.** Rewrite GDD §7's "HP = 20·E_boss …" as "table HP × count scale × shop scale (never below the table)" and note it under §0 Boss.
  6. This reverses round-1's rejection of M8/M2 in damped form, on the lead's decision and the new TTK evidence.
- **Verify:**
  1. **Count sweep, base ranks.** `node tools/smoke.js --scenario play --level 1 --boss --seconds 45 --after "g.squad.setCount(70,'debug')" --out docs/build/qa2/fix-level/ttk-l1-70`, repeated with 140 and 336. Repeat at `--level 10` with 140, 280 and 672.
     - TTK (boss:fight → boss:dead) is about 15–25 s, 10–16 s and 7–11 s respectively.
     - TTK strictly decreases with C.
  2. **Shop ranks.** With `--pre "g.save.setUpgrade('fireRate',3); g.save.setUpgrade('damage',3); g.save.setUpgrade('bossDamage',3)"` and C = E on L10, TTK ≥ 8 s.
  3. **Strong-bot campaign.** `node docs/build/qa2/feel-balance/camp.mjs --player strong --from 1 --to 12 --retries 2 --out docs/build/qa2/fix-level/camp-strong`.
     - ≥ 10 of 12 boss TTKs fall in 8–22 s.
     - The phase-2 special fires on ≥ 10 of 12 levels.
- **Evidence:** docs/build/lead/l1/report.json; docs/build/qa2/triage/l1/report.json; docs/build/qa2/feel-balance/table.txt (ttk / mult columns); QA-ROUND1 verifier remaining #1
- **Data keys:** `BOSSES.squadScale (new)`, `BOSSES.shopScale (new)`, `GDD §7`, `GDD §0`

#### [LVL-15] Waves almost never bite: measured leak is 2–3 % against the 10–28 % bands at any squad size (the leak model is mis-calibrated and ignores shop ranks)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major · **From:** feel-balance (waves never cost soldiers); lead seed #5 (crawler-wave leak, weak line); carryover-check (balance evidence)
- **What:**
  - **Share that bit.** Across 118 wave groups per player type: 2.5 % (strong), 2.0 % (passive), 3.4 % (bad).
  - **Free waves.** 82 % of waves cost 0 soldiers.
  - **Even far under the curve:**
    - L9 at C = 35 against E = 232 lost 0 of 9 and 2 of 9.
    - L10 at C = 40 against E = 184 lost 0 of 10.
  - **L12.** No soldiers lost to waves for any of the three players.
  - **HP experiment.** ×3 HP gives 5–10 % leak; ×6 gives 18–24 %.
  - **Model mismatch.** tools/validate-levels.js predicts 41–52 % for crawler-heavy waves (L5–L13, L16–L28). The model and the game disagree, in both directions.
- **Root cause:**
  - **Model.** `js/levelgen.js:518-548` (`waveDps` / `solveWaveHp` / `typeWindow`) underestimates the real kill rate: the reach/usable window, the coverage and the crawler `windowScale` are pessimistic. Base-stat L2–L3 already leak 0 %.
  - **Live solves.** `js/level.js:983` (guards), :1016 (waves) and :1093 (run-up) use base fire rate and damage and ignore `ctx.profile`. For the campaign bot that is ×1.32 at L6 and ×1.89 at L9.
- **Expected:**
  - GDD §6.3 bands: L1–3 10–15 %, L4–9 15–22 %, L10–19 22–28 %, L20+ 28–32 %.
  - GDD §17: median soldiers lost per wave 8–12 % of C.
  - Pillar 3: about 88 % of a horde dies before contact.
  - The validator's prediction matches play.
- **Fix (js/levelgen.js, js/level.js, tools/validate-levels.js + LEAK_MODEL):**
  1. **Calibrate against play.** Add `LEAK_MODEL.calib` (new, start at about 3), applied to the solved HP. Re-fit `LEAK_MODEL.windowScale` / `coverage` per type, so the passive player's predicted leak at base ranks matches measured leak within ±5 points for walker, runner, crawler, brute and spitter waves.
  2. **Shop ranks, damped.** In the live solves (level.js :983, :1016, :1093 and the boss-minion solve in `_fireBoss`), multiply HP by p^`LEAK_MODEL.profileExp` (new, 0.5), with p = (profile.fireRate / FIRE.rateBase) · profile.damage.
     - Upgrades keep shortening waves, but never to zero bites.
     - The generator and validator keep p = 1.
  3. **L1.** The authored L1 waves keep their GDD §11 HP. Adjust LEVEL_1 `hpMult` only if L1's measured leak falls outside 10–15 %.
  4. **Docs.** Amend GDD §6.3 with the calibration factor and the profile exponent.
- **Interface:** LVL-14 (boss minions use the same solve) and LVL-17 (endless). LVL-21, LVL-22, LVL-23 and LVL-27 re-measure after this lands.
- **Verify:**
  1. Run `node docs/build/qa2/feel-balance/camp.mjs --player passive --from 2 --to 12 --retries 0 --out docs/build/qa2/fix-level/camp-passive`. Repeat with `--player strong`, and with the campaign-shop ranks from table.txt via `--ranks`.
  2. Aggregate with docs/build/qa2/feel-balance/waves.cjs as in the feel-balance report.
     - Median wave leak is inside the level's band ±4 points.
     - Median soldiers lost per wave is 8–12 % of C.
  3. Run `node tools/validate-levels.js > docs/build/qa2/fix-level/validate.txt`. Sampled waves are predicted within ±5 points of measured, and there are no 41–52 % crawler warnings.
- **Evidence:** docs/build/qa2/feel-balance/camp-strong, camp-passive, camp-bad (+ .log), hpx3-L6, hpx3-L9, hpx6-L6, hpx6-L9 (.log), validate.txt; docs/build/qa2/carryover-check/validate.txt (crawler walls 43–52 % at L16–L28)
- **Data keys:** `LEAK_MODEL`, `GDD §6.3`

#### [LVL-16] Gate events never alternate on L2–L3: every pair holds its better lane on the left, so a player who never steers plays the optimal route

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major · **From:** feel-balance (no side alternation)
- **What:**
  - **Best-lane pattern.** In validate.txt, L2 and L3 are both p0 s0 p0 s0 p0; L4–L7 are mostly lane 0.
  - **Passive player.** The no-input player took the better lane in 3 of 3 pairs on L2 and L3.
  - **On L3** the passive player matched the strong bot exactly: 177 at the boss, 136 survivors, 3★.
- **Root cause:** `js/levelgen.js:1038` `const side = spec.idx % 2` counts every gate event, singles included. L2 and L3 alternate pair, single, pair…, so every pair gets side 0.
- **Expected:** GDD §1: "Gate events alternate which half holds the better option". Steering must matter on every level.
- **Fix (js/levelgen.js, tools/validate-levels.js):**
  1. **Alternation.** Alternate on a counter of multi-lane events only (pairs and triples), assigned as the spec is built (`spec.side = multiIdx++ % 2`). Alternatively, use a seeded choice with "never 3 in a row on one side" and about 50 % per level. Singles don't count.
  2. **Validator check.** Per level, the best lane of pairs and triples lies on each side 40–60 % of the time (±1 event). Fail otherwise.
- **Verify:**
  1. `node tools/validate-levels.js > docs/build/qa2/fix-level/validate-alt.txt`: the new check passes on L2–L30.
  2. `node docs/build/qa2/feel-balance/camp.mjs --player passive --only "2,3,4" --out docs/build/qa2/fix-level/alt-passive`, then the same with `--player strong`.
     - The passive player takes the better lane in about 50 % of pairs.
     - On L2 and L3 it reaches the boss with fewer soldiers than the strong bot.
- **Evidence:** docs/build/qa2/feel-balance/validate.txt; camp-passive/L03-a1.json vs camp-strong/L03-a1.json (commits, passes)
- **Data keys:** none

#### [LVL-17] Endless never ends: 15-minute runs reach D 33 and the squad never drops below 216. The rubber band is undone by the next ×3 / +A event, and mini-bosses die in under 2 s

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major · **From:** feel-balance (endless never ends); carryover-check (endless runaway ~20× E)
- **What:**
  - **Runs never end.** Strong and passive players, rank-3 shop, 900 s cap: both were alive at 866 s, about 9.5 km, D 33.
  - **Almost nothing bites.** Minimum count after the first minute was 300 / 216. Of about 4 250 zombies, only 10 / 5 bit.
  - **Mini-bosses.** HP 10·E; they die in 0.4–1.6 s.
  - **Rubber band dominates.** '÷2 | ÷2' was 30 of 68 and 34 of 67 gate passes. The count yo-yos between 400 and 2 400 (×3 → ÷2 → ÷2 → ×3).
  - **carryover-check smoke:**
    - 832 → (÷2) 416.
    - Then '−75 | x3' takes it to 1 248.
    - Then 'x2→x3 | +140' takes it to 3 744 at D3, which is 20.9 × E.
  - **Infinite farm.** A passive player survives just as long, and endless pays 0.6× with no risk.
- **Root cause:**
  - **Rubber band timing.** `js/level.js` `_applyRubberBand` (:810) acts only at chunk boundaries.
  - **Lock evaluated too early.** `_lockRunaway` (:937-952) checks the count when an event *spawns*, about 7 s before it arrives. The 'x2→x3 | +140' event spawned at C = 416, just before the ×3 pass took C to 1 248.
  - **Lane sizing.** `generateChunk` (js/levelgen.js) still sizes + lanes and × steps from E(D), e.g. D2 '+290 (cap 1160) | x3' and D11 'x3 | +530'.
  - **Fixed E.** Waves and mini-bosses are solved at E(D) ≤ 600 while C runs at 2–20 × E (GDD: a squad at 2·E leaks 0).
- **Expected:**
  - GDD §10.1: difficulty rises per chunk, the run ends at C = 0, the rubber band holds C near 2·E, and the mini-boss is a fight.
  - Target: median run 3–6 min for a mid-shop (rank-3) player.
- **Fix (js/level.js, js/levelgen.js, tools/validate-levels.js + LEVELS.endless):**
  1. **Rubber band at every event.**
     - Evaluate the rubber-band and lock conditions against the worst-case count after the events still pending ahead (C × the best lane of each unpassed event), not the current count.
     - Apply them to every gate event while C > `rubber.highMult`·E.
     - While C > 2·E, suppress × lanes and cap +A at 0.5·E.
  2. **Waves at the live count.** Solve endless waves at E_eff = max(E(D), live C at spawn). Raise the leak band with D: `LEVELS.endless.bandPerD` (new), about +1 point per D, up to 40 %.
  3. **Mini-bosses.** Apply the LVL-14 count and shop scaling on top of 10·E.
  4. **Count-independent ramp.** Population beyond 24, and the brute/spitter share growing with D.
  5. **Validator.** The endless greedy line for the rank-3 profile keeps C/E ≤ 3 at every chunk boundary.
  6. **Docs.** Amend GDD §10.1. This reverses round-1's M6 rejection with the evidence above.
- **Verify:**
  1. Run `node docs/build/qa2/feel-balance/camp.mjs --player strong --from 1 --to 0 --endless 1 --maxsec 900 --ranks '{"squad":3,"fireRate":2,"damage":2,"coinMult":4,"bossDamage":2}' --out docs/build/qa2/fix-level/endless-strong`. Repeat with `--player passive`.
     - Both runs end, each lasting 120–480 s.
     - C/E ≤ 3 at every boundary after D2.
     - '÷2 | ÷2' is ≤ 25 % of passes.
     - Mini-boss TTK ≥ 6 s.
  2. Run `node tools/smoke.js --scenario play --endless --seconds 150 --shots 15 --pre "g.save.data.highestUnlocked=11; g.save.setUpgrade('squad',3); g.save.setUpgrade('fireRate',3); g.save.setUpgrade('damage',3)" --out docs/build/qa2/fix-level/endless-r3`. The count never exceeds 3·E(D).
- **Evidence:** docs/build/qa2/feel-balance/endless-strong/endless-1.json, endless-passive/endless-1.json; docs/build/qa2/carryover-check/ev/endless-r3.report.json, validate.txt (endless table)
- **Data keys:** `LEVELS.endless`, `GDD §10.1`

#### [LVL-18] PLAY, NEXT and RETRY freeze the main thread 0.25–0.5 s at 4× while generateLevel runs in the click handler, and a retry regenerates the identical script

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major · **From:** perf-throttled (generateLevel on PLAY); lead seed #3 (level-start frame)
- **What:**
  - **Synchronous generation.** `level.start` runs `generateLevel(curveL, runSeed)` synchronously (`js/level.js:443`). `restart()` (:471-474) regenerates the same seed.
  - **Browser, quiet host:**
    - `level.start(9)` takes 52 ms unthrottled, of which `generateLevel` is 48 ms: buildAttempt → simulate → selectSpec → tuneDraw → gainError (levelgen.js:1483/781/1389/1319/1300).
    - At 4× it takes 259 ms.
  - **Node, cold calls.** 14–125 ms, median 68 ms. That projects to about 270 ms median and 500 ms worst at 4×.
  - **Not shader compile.** The first gameplay frame at 4× is 118–139 ms with programs flat at 53.
  - **Round-1 assumption.** Round 1 deferred this (P8), assuming about 35 ms.
- **Expected:** GDD §1 / §14 flow: taps respond within a frame or two. No main-thread task over 50 ms at level start on the mid-range lens.
- **Fix (js/level.js; levelgen stays pure):**
  1. **Memoize.** Cache scripts in a Map keyed `${curveL}|${seed}`.
     - Treat cached campaign scripts as read-only (deep-freeze them or copy any event that gets mutated).
     - Never cache endless scripts; `_lockRunaway` mutates them.
  2. **Prefetch** in idle time (`requestIdleCallback` with a 1 s timeout, or a `setTimeout(0)` after that screen's first frame):
     - state 'complete' → level + 1;
     - 'title' → highest unlocked;
     - 'gameover' and the levels screen → the current or selected level.
  3. **Fallback.** Keep the synchronous path for a cache miss.
  4. **Debug.** Write generate time to `ctx.debug` so misses are visible on the overlay.
- **Verify:**
  1. `node docs/build/qa2/perf-throttled/spikes.mjs --rate 4 --quality med --out docs/build/qa2/fix-level/spikes-r4`:
     - level-start-L9 callMs ≤ 20 ms after ≥ 2 s on the title (prefetched);
     - ≤ 5 ms for RETRY (memo).
  2. `node docs/build/qa2/perf-throttled/throttle.mjs --rate 4 --level 9 --quality med --seconds 30 --out docs/build/qa2/fix-level/q4-l9-med`: the first gameplay frame interval is under 60 ms.
- **Evidence:** docs/build/qa2/perf-throttled/spikes-r1q/spikes.json (+ level-start-L9.cpuprofile), spikes-r4q, spikes-r4, levelgen-cold.txt; q4-l9-med / q4-l9-low / m4-l9-adreno perf.json worst[]
- **Data keys:** none

#### [LVL-19] A boss kill is thrown away if the player pauses and taps QUIT or RESTART during the 3 s death theatre (also after the auto-pause from hiding the tab)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major · **From:** edge-cases (won run lost on quit)
- **What:**
  - **Repro.** L1 with 200 soldiers. The boss is killed (phase 'won', run.coins 42). 0.6 s later: pause → QUIT.
  - **Result.** State title, save coins 0, levels['1'] null, highestUnlocked 1.
  - **RESTART** does the same.
  - **Tab hide.** Hiding the tab during the death auto-pauses in phase 'won', so a returning player who quits also loses the clear.
- **Root cause:**
  - The win reaches the save only in `finish(true)` → `_finishWon` (`js/level.js:1446-1491`). `step()` calls it once `_finishAt` (`time.now + 3000`, :1372) has passed (:725-728).
  - `quitToTitle` (:477) and `_beginRun` (:562, used by restart) reset the runner without committing a 'won' or 'lost' run.
- **Expected:** GDD §7 Death / §9.3: the level is cleared when the boss HP reaches 0, with survivors sampled then. The 3 s collapse is presentation only.
- **Fix (js/level.js):**
  1. **Split commit from present.** Split `_finishWon` / `_finishLost` into:
     - **commit:** stars, payout including `_settleCoins`, `save.addCoins` / `recordLevel` / `setLastIncome` / `addStats`. Exactly once, behind a `_committed` flag that `_beginRun` resets.
     - **present:** `state.set('complete'|'gameover')` and `level:complete` / `level:failed`.
  2. **When to commit.** Run commit at the top of `quitToTitle` / `restart` / `_beginRun` when the phase is 'won' or 'lost' and the run is not finished. Also run it in `finish()`, whichever comes first.
  3. **When to present.** Present when `_finishAt` passes.
- **Verify:**
  1. Copy docs/build/qa2/edge-cases/{lib.mjs,t17-won-quit.mjs} into docs/build/qa2/fix-level/, with out → docs/build/qa2/fix-level/t17-won-quit.
  2. After QUIT, and after RESTART, during the theatre: save coins equal the run payout, levels['1'].stars ≥ 1, highestUnlocked 2.
  3. A normal clear credits once (coins not doubled).
  4. Pause in phase 'lost' then QUIT keeps the 50 % coins.
- **Evidence:** docs/build/qa2/edge-cases/t17-won-quit/report.json; t2-boss/report.json (F: "hidden {st:paused, ph:won}")
- **Data keys:** none

#### [LVL-20] A dead squad is revived by a + gate (level part: gate passes and gate / crate coins still count in phase 'lost')

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major · **From:** edge-cases (dead squad revived)
- **What:** See GAT-6. After `squad:dead` (phase 'lost'), `level._onGatePass` (`js/level.js:1228`) still counts the pass (stats, hints), and `_onCoinPickup` (:1271) credits the gate's coins ('Coins kept +2').
- **Root cause:** Neither handler checks for phase 'lost'.
- **Expected:** GDD §7 / §10: no rewards after C = 0.
- **Fix (js/level.js):**
  1. `_onGatePass` returns early in phase 'lost' (and 'won').
  2. In phase 'lost', `_onCoinPickup` ignores the sources gate, max, crate, pile, duplicate and refund.
  3. Kill coins from bullets already in flight may still land. Boss and bonus coins in 'won' are unchanged.
- **Interface:** GAT-6 (no pass after death); CHR-10 (the squad stays at 0).
- **Verify:**
  1. Use the t5-squad copy (docs/build/qa2/fix-level/t5-squad).
  2. 'Coins kept' is identical with and without the gate in front.
  3. `run.gatesPassed` does not change after death.
- **Evidence:** docs/build/qa2/edge-cases/t5-squad/report.json, 05-dead-then-gate-0.15-result.png
- **Data keys:** none

#### [UI-18] Tutorial and hint pills sit on the horizon and cover the gates as they arrive; the boss hint covers the name card and the Spitter Queen's face

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** major · **From:** lead seed #1; visual-2 (boss hint placement, orphaned hint lines)
- **What:**
  - **Pills over gates.** 'MORE SOLDIERS!' covers the x2 | +10 pair, and 'ZOMBIES BITE!' covers ×3 | +10. See lead l1 03-play-9s, 04-play-13s and 14-play-53s, and this triage's l1/04-play-13s.png.
  - **Boss hint.** During the boss the pill sits at safe-top + 196, flush on the name card (pill 208–251, card 252–337 css px), and over the Spitter Queen's head (l5boss_02).
  - **Two-line hints** break with orphans: 'NO WAY AROUND — SHOOT / IT DOWN'.
- **Root cause:**
  - `css/game.css:88` (`--hint-y: 150`) and :901-914 (`#hint` top = safe-top + 150·u; boss-on 196·u), plus `JUICE.ui.hintY` (js/data.js:1111). The round-1 UI-1 band, "below the HUD, above the gates", is exactly where gates and the boss appear.
  - `#hint-text` (:945) has no text-wrap balance.
- **Expected (lead decision):**
  - Hints never hide gates, zombies, the boss or the count label.
  - A compact pill, bottom-anchored at safe-bottom + 28 px under the squad (like the tutorial hand in the ads).
  - Hand icon inside the pill, max-width about 86 %, slightly translucent.
  - The boss hint behaves the same.
  - Reduced motion is respected: no ripple, pop or hand loop.
- **Fix (css/game.css, js/ui.js + data):**
  1. **Position.** `#hint`: `top: auto; bottom: calc(var(--safe-bottom) + var(--hint-bottom) * var(--u))`, from `JUICE.ui.hintBottomPx` = 28 (new). Retire `JUICE.ui.hintY` and remove the `#hud.boss-on #hint` rule.
  2. **Layout.** Row direction, with the hand icon at about 32·u inside the pill's left edge, only for steer and shoot. Text 20–22·u.
  3. **Size and style.**
     - Max-width = `JUICE.ui.hintMaxWidthPct` (new, 86) % minus the safe insets.
     - Background alpha = `JUICE.ui.hintAlpha` (new, about 0.72).
     - `text-wrap: balance`.
  4. **No layout reads in the frame (js/ui.js).**
     - Delete the portrait label-avoidance measurement (`_placeHint` :1572-1599 and its `_measureRaw` / `getBoundingClientRect` calls).
     - For landscape or wide boxes, compare the projected label rect (`_projectLabel`, no DOM reads) with a cached hint size from a ResizeObserver on `#hint`.
     - On overlap, shift the pill sideways with `transform`.
     - Never read layout in the frame that wrote the text.
  5. **Pointer events.** Keep `pointer-events: none`. Drags pass through, so the §14 thumb zone stays usable.
  6. **Docs.** Amend the GDD §14 HUD row: "tutorial hint … at y 620" → "bottom-anchored pill at safe-bottom + 28 under the squad (round-2 QA UI-18)". Note that the thumb-zone rule exempts non-interactive hints.
- **Interface:**
  - LVL-25 fires the boss hint on `boss:fight`.
  - UI-25 queues hints.
  - VIS-19 keeps big formations on screen; the pill may cover the rear rows, which the lead accepted.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 1 --seconds 60 --shots 1 --out docs/build/qa2/fix-ui/hints`. In every shot with a hint, the pill sits 24–32 px above the safe bottom and intersects no gate panel, zombie or count label.
  2. Run the visual-2 boss-hint probe (copy probe.mjs + m_hint.js into docs/build/qa2/fix-ui/). The boss hint appears only after `boss:fight` and touches neither `#namecard` nor `#bossbar`.
  3. Run `node docs/build/qa/ui-shells/probe.mjs landscape --out docs/build/qa2/fix-ui/probe-landscape`. The hint and the label don't overlap.
  4. A reduced-motion run shows no hand loop.
- **Evidence:** docs/build/lead/l1/03-play-9s.png, 04-play-13s.png, 14-play-53s.png; docs/build/qa2/triage/l1/04-play-13s.png, 14-play-53s.png; docs/build/qa2/visual-2/reports/probe-hint.json, shots/l1c_29-play-57s.png, l5boss_02-play-3s.png, reports/rocketlow.json (frame 04)
- **Data keys:** `JUICE.ui.hintY`, `JUICE.ui.hintBottomPx (new)`, `JUICE.ui.hintMaxWidthPct (new)`, `JUICE.ui.hintAlpha (new)`, `GDD §14`

#### [UI-19] The first appearance of the results screen, the boss-intro chrome and the menus stalls 63–305 ms (DOM first raster and layout, not shaders)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** major · **From:** lead seed #3 (results / boss-spawn hitches); edge-cases (first menu opens); carryover-check (seed #3 evidence: HUD raster at level start)
- **What:** This build, unthrottled:
  - **Results screen.** The first frame is 285 ms. The trace shows one GPU-process `DoEndRasterCHROMIUM` flush of 255 ms and no main-thread task over 30 ms.
  - **Boss intro.** The frame is 63 ms: three raster flushes (28.5 / 22.5 / 22.4 ms) while `#bossbar`, `#namecard` and the letterbox appear.
  - **First menu opens:**
    - LEVELS 146 / 305 ms (nomusic / music).
    - SHOP 69–111 ms.
    - SETTINGS 83–118 ms.
    - Second opens take about 21 ms.
  - **Skull glyph.** The milestone skull '☠' is not in the game fonts and costs 90 ms of the first LEVELS layout.
  - **At 4×.** The results frame is 285 ms (m4-l1-med). Round 1 measured 257–319 ms.
  - **Not shaders.** `renderer.info.programs` stays at 53 throughout: the round-1 warm-up works, and the cost is DOM.
- **Root cause:** Expensive paint on first show, and no layer is rastered before its first use:
  - **Results sunburst.** `#scr-complete::before` is a 620·u px masked `repeating-conic-gradient` that rotates forever (`css/game.css:1649-1664`).
  - **Title.** `#complete-title` stacks six `drop-shadow` filters plus background-clip text (:1666-1683).
  - **Stars.** `#stars` has `drop-shadow` filters (:1721).
  - **Letterbox.** 24 px `box-shadow` blurs.
  - **Level grid.** Rebuilt by `innerHTML` on every open, with a fallback-font glyph (`js/ui.js:1873-1910`, `SKULL_GLYPH` :284).
- **Expected:** GDD §16 frame budget. Lead seed acceptance: no frame over 50 ms during normal play on this machine after boot, with the work done behind the boot bar.
- **Fix (css/game.css, js/ui.js):**
  1. **Prewarm.** Add `ui.prewarm(): Promise`. During boot, behind `#scr-boot`, lay out and paint these for two rAFs, then restore:
     - `#scr-complete` (stars, title and chips filled with sample text), `#scr-gameover`, `#scr-levels`, `#scr-shop` and `#scr-settings`;
     - `#hud`, `#bossbar`, `#namecard` and the letterbox.

     Use `visibility: visible`, `opacity: 0.01` and `pointer-events: none` while prewarming.
  2. **Make paint cheap:**
     - Sunburst: a pre-rendered image (rays drawn once into a canvas at boot → blob/data URL) on a `will-change: transform` layer, so rotation never re-rasters.
     - Title outline: one text-shadow stack or `-webkit-text-stroke`; at most one filter.
     - Star glows: baked into the star background.
     - Letterbox shadow: ≤ 8 px, or a gradient strip.
  3. **Skull and grid.** Draw the skull as inline SVG/CSS like the HUD skull. Build the level grid once and update tile classes and text in place (capped as in UI-24).
- **Interface:** CORE-9 awaits `ui.prewarm()` before `hideBoot` (boot step 10).
- **Verify:**
  1. `node docs/build/qa2/carryover-check/trace.mjs docs/build/qa2/fix-ui/trace-results 1 - results`, then the same with `trace-boss 1 - boss`. No rAF interval over 50 ms in either (was 285 / 63 ms).
  2. Copy docs/build/qa2/edge-cases/{lib.mjs,t11-first-gesture.mjs} into docs/build/qa2/fix-ui/. The first LEVELS, SHOP and SETTINGS opens have a worst frame under 50 ms.
  3. `node docs/build/qa2/perf-throttled/throttle.mjs --rate 4 --level 1 --quality med --seconds 70 --out docs/build/qa2/fix-ui/m4-l1-med`. No frame over 100 ms after 'complete'.
- **Evidence:** docs/build/qa2/triage/trace-results (summary.json; trscan output in this triage), trace-boss; docs/build/qa2/perf-throttled/m4-l1-med/perf.json (60.37 s: 284.7 ms, jsPrev 10.1 ms); docs/build/qa2/edge-cases/t11-firstplay, t11-nomusic, t11-music, t10-levels-hitch.mjs output; docs/build/qa2/carryover-check/ev/prog-*.report.json (programs flat), trace-levelstart-summary.json
- **Data keys:** none

#### [UI-20] An accidental double-tap on RESET SAVE wipes the whole save

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** major · **From:** edge-cases (reset double-tap)
- **What:**
  - **Touch.** In Settings, two taps on RESET SAVE 80 ms apart (a normal double-tap) reload the page with the save at {coins 0, hu 1, levels 0}. Before, it held 4 321 coins, hu 14 and a 3★ L13.
  - **Mouse.** A mouse double-click does the same.
- **Root cause:** `js/ui.js:1128-1153` `confirmReset` arms on the first tap (`_confirmUntil` = clock + 3 s). Any second tap before then wipes the save; there is no minimum delay.
- **Expected:** GDD §14 Settings: "Reset save (turns into 'Tap again to confirm' for 3 s)". The wipe needs a deliberate second tap.
- **Fix (js/ui.js + data):**
  1. Record the arm time.
  2. Ignore confirming taps for `JUICE.ui.confirmMinS` (new, 0.6 s) after arming.
  3. A tap after that and before 3 s confirms.
  4. Leaving Settings disarms.
- **Verify:**
  1. Copy docs/build/qa2/edge-cases/{lib.mjs,t21-reset-doubletap.mjs} into docs/build/qa2/fix-ui/.
  2. An 80 ms touch double-tap and a mouse double-click keep the save.
  3. A second tap 1 s after the first wipes it.
- **Evidence:** docs/build/qa2/edge-cases/t21-reset-touch-80ms/report.json, t21-reset-mouse-dblclick
- **Data keys:** `JUICE.ui.confirmMinS (new)`

#### [AUD-4] The boss-death fanfare plays 617 cents flat (F#-ish over the A-minor boss loop): cues scheduled during slow-mo keep the slow-mo detune

- **Group:** audio (js/audio.js) · **Severity:** major · **From:** audio (fanfare flat)
- **What:**
  - **Fanfare pitch.** Spectral peaks after boss:dead + 0.9 s are 367 / 459 / 550 / 734 / 925 / 1100 Hz, where C5 E5 G5 C6 E6 G6 (523…1568 Hz) are expected. Every note is ×0.70, in the L1 run and the boss run.
  - **exp.mjs.** All 12 fanfare layers are built at −617 cents. Six of them start after `setTimeScale(1)` (which arrives 1 189 ms after play) and still sound at −617.
  - **Music lookahead.** 3 notes sound at −617 cents up to 42 ms after the return, and 1 note plays at normal pitch when slow-mo starts.
- **Root cause:**
  - `_startLayer` and `_musicNote` write `o.detune.setValueAtTime(base + rateCents, t)` at the future start time t (`js/audio.js:1108`, :1494).
  - `setTimeScale` (:1300-1322) only adds `setTargetAtTime(…, now)`, which the later `setValueAtTime` overrides.
  - Sequence: boss:dead → `fx.slowmo(0.25, 1.2 s)` → rate 0.7 → fanfare queued with `delayMs` 900 (`FANFARE_AFTER_ROAR_MS` :53, play :1806-1809).
- **Expected:** GDD §13: rate = 0.6 + 0.4·scale, applied on every change including the return to 1 (ARCH §6.13). J16: "roar at rate 0.4, then fanfare", in C major.
- **Fix (js/audio.js + data):**
  1. **Re-time live sources.** In `setTimeScale`, for every live source call `param.cancelScheduledValues(now)`, then `setValueAtTime(current, now)` and `setTargetAtTime(new, now, PARAM_SMOOTH_S)`.
  2. **Future starts.** Store each voice's start time. If the start is still in the future, `cancelScheduledValues(start)` and `setValueAtTime(newValue, start)`. Do the same for the music scheduler's queued notes.
  3. **Reward stings ignore the time scale.** `AUDIO_CUES.fanfare`, `chime3` and `ui_*` get `noTimeScale: true` (new) and are built at rate 1.
  4. **Fanfare delay.** Move `FANFARE_AFTER_ROAR_MS` to `AUDIO_CUES.fanfare.afterRoarMs` (new). Set it ≥ `JUICE.slowmo.bossDeath[1]`·1000 + 100 (1 300 ms) unless step 3 already makes the overlap clean.
- **Verify:**
  1. Run docs/build/qa2/audio/exp.mjs (copy it; out → docs/build/qa2/fix-audio/exp.json). No layer is built at −617 after the return, and 'lookaheadStale' is 0.
  2. Run `node docs/build/qa2/audio/rec.mjs --phase boss --out docs/build/qa2/fix-audio/boss`, then `node docs/build/qa2/audio/pitch.mjs docs/build/qa2/fix-audio/boss evt:boss:dead+0.9 0.9 55 300 2200`. Peaks are 523 / 659 / 784 / 1047 / 1319 / 1568 Hz ±1 %.
- **Evidence:** docs/build/qa2/audio/exp.json ('fanfare', 'lookaheadStale'); docs/build/qa2/audio/l1, boss (pitch.mjs output)
- **Data keys:** `AUDIO_CUES`, `GDD §13`

#### [AUD-5] The master bus clips: the compressor's knee is left at Chrome's 30 dB default, so the "−18 dB 6:1" compressor barely compresses and nothing limits the output

- **Group:** audio (js/audio.js) · **Severity:** major · **From:** audio (master clipping)
- **What:**
  - **Static curve with knee 30:** −18 dBFS in → −16.6 out, 0 → −0.84, +3 → +1.08, +6 → +2.63. That is about 1.14:1 above the threshold.
  - **L1, 54.9 s** (boss:phase crash + 4 screech + 3 ugh + shots): master peak +1.9 dBFS, 10 samples ≥ 0.999.
  - **Boss run, 17.2 s:** +0.5 dBFS, 14 clipped samples.
  - **Reduction.** `comp.reduction` never went below −2.8 dB.
- **Root cause:** `js/audio.js:622-626` `_buildGraph` sets threshold, ratio, attack and release but not knee. There is no limiter after the compressor.
- **Expected:** GDD §13 / ARCH §6.13: a real bus compressor (threshold −18, ratio 6), and the destination never receives samples ≥ 0 dBFS.
- **Fix (js/audio.js + MUSIC):**
  1. **Knee.** Add `MUSIC.compressor.knee` = 6 (new) and set `comp.knee`.
  2. **Makeup gain.** Compensate Chrome's automatic makeup gain (about +6.4 dB more): trim the buses by about −6 dB (`MUSIC.buses` sfx −12, gun −16, music −14), or add a fixed −6 dB pre-compressor gain.
  3. **Limiter.** Add a safety limiter after the compressor: `MUSIC.limiter` (new), a second DynamicsCompressor with threshold −1, knee 0, ratio 20, attack 0.001, release 0.05. A tanh WaveShaper soft clip also works.
  4. **Docs.** Amend the GDD §13 graph line.
- **Verify:**
  1. `node docs/build/qa2/audio/compcurve.mjs 6` matches the knee-6 reference.
  2. Run `node docs/build/qa2/audio/rec.mjs --phase l1 --out docs/build/qa2/fix-audio/l1` and `… --phase boss --out docs/build/qa2/fix-audio/boss`, then `node docs/build/qa2/audio/analyze.mjs <dir>` on each:
     - 0 samples ≥ 0.999 at the destination;
     - `comp.reduction` reaches −6 to −10 dB on boss events;
     - the gameplay bed's median RMS stays within ±2 dB of round 2 (−22 dBFS in L1).
- **Evidence:** docs/build/qa2/audio/compcurve.json, compcurve-knee6.json, l1/analysis.json (spikes, clipCauseBlocks), boss/analysis.json
- **Data keys:** `MUSIC`, `GDD §13`

#### [AUD-6] Identical cues started in the same frame sum phase-coherently (up to 4 copies, +12 dB) and clip

- **Group:** audio (js/audio.js) · **Severity:** major · **From:** audio (same-frame stacking)
- **What:**
  - **Stack test, ×1 / ×2 / ×3 / ×4:**
    - ugh peaks −12.8 / −5.6 / −4.0 / −1.9 dBFS (+10.9 dB).
    - thud −5.0 / −0.5 / +1.8 / +3.3, with 170 and 298 clipped samples at ×3 and ×4.
    - pop reaches +0.6 dBFS at ×4, with 18 clipped samples.
    - The noise-only splat rises only +5.9 dB at ×4.
  - **In game:**
    - Three ugh plus a thud in one frame at 17.109 s and 17.269 s (7 squad:loss) give +0.5 dBFS and 14 clipped samples.
    - Two brute roars in one frame at 14.38 s push master RMS to −5.6 dBFS, 14 dB over the 2 s median.
- **Root cause:**
  - The same-frame cap admits `SAME_FRAME_MAX` = 4 instances (`js/audio.js:70`, used at :814).
  - All of them start at the same `t0 = now + START_LATENCY_S` (:939), with the same frequency and phase-0 oscillators.
  - ugh, thud, pop and max have no rateJitter.
- **Expected:** GDD §6.1 / §12 / §13: a burst of identical events reads as one thicker hit (the crunch model: +3 dB per extra kill, cap +9). It is never an n× amplitude sum.
- **Fix (js/audio.js + AUDIO_CUES / MUSIC):**
  1. **Merge duplicates.** Treat same-frame duplicates like crunch: merge them into the first queued instance with a capped stack gain. Either:
     - give ugh, thud, roar, pop, screech and hup `coalesceMs` 30–50 and `stackDb { per: 2, cap: 6 }`; or
     - have the same-frame path call `_stack(st, {per: 2, cap: 6})`.
  2. **If copies must play**, decorrelate them:
     - offset each extra copy by 5–15 ms;
     - add ±3–6 % rateJitter from `ctx.rngFx`;
     - lower `MUSIC.queue.maxPerFrame` 4 → 2, and read it instead of the `SAME_FRAME_MAX` literal.
- **Verify:**
  1. Run `node docs/build/qa2/audio/rec.mjs --phase stack --out docs/build/qa2/fix-audio/stack` and analyze.mjs. For ugh, thud, pop and hup, ×4 is ≤ +6 dB over ×1 with 0 clipped samples.
  2. The AUD-5 boss run shows no clipping at the multi-loss moments.
- **Evidence:** docs/build/qa2/audio/stack (analysis); boss/meta.json (log), boss/analysis.json
- **Data keys:** `AUDIO_CUES`, `MUSIC`

#### [AUD-7] The roar (boss intro, boss death, brutes) is 14–20 dB louder than the rest of the mix

- **Group:** audio (js/audio.js) · **Severity:** major · **From:** audio (roar too loud)
- **What:**
  - **Isolated.** The roar peaks at −3.7 dBFS with active RMS −8.2, the loudest cue by about 6 dB RMS (shot −23.8, tick −18.9).
  - **L1 boss intro.** Master RMS goes to −6.5 dBFS against a 2 s median of −27 (+20.5 dB).
  - **Boss death.** −6.5 to −7.2 dBFS for 0.8 s (+13 dB).
  - **Double brute roar.** +14.4 dB.
- **Root cause:**
  - `AUDIO_CUES.roar` (js/data.js:1166) is a sawtooth at 70 Hz, gain 0.9, plus noise at 0.4, both through shaper 0.6 (k = 25, nearly square).
  - boss:intro and boss:dead play it with no `pos` (no distance attenuation) at full volume (`BOSS_*` constants in js/audio.js:45-50).
- **Expected:** GDD §13: the roar is a telegraph and impact accent inside the mix. Event peaks sit about 6–8 dB over the gameplay bed (L1 median −22 dBFS RMS).
- **Fix (data + js/audio.js):**
  1. **Gains.** Roar layer gains 0.9 / 0.4 → about 0.4 / 0.2, or shaper 0.6 → 0.35.
  2. **Boss volume.** boss:intro and boss:dead pass `AUDIO_CUES.roar.bossVolume` (new, about 0.6).
  3. **Constants to data.** Move `BOSS_DEATH_ROAR_PITCH` and `BOSS_DEATH_ROAR_STRETCH` into `AUDIO_CUES.roar.bossDeathPitch` and `bossDeathStretch` (new; these are the DATA-MISSING tags at :45-50).
  4. **Re-check after AUD-5**, since the knee changes loudness.
- **Verify:**
  1. Run rec.mjs `--phase l1` and `--phase boss` (docs/build/qa2/fix-audio/…), then analyze.mjs 'spikes'.
  2. Roar events are ≤ +8 dB over the 2 s median.
  3. The roar is still the loudest single event of the intro.
- **Evidence:** docs/build/qa2/audio/cues/analysis.json; l1/analysis.json, boss/analysis.json (spikes)
- **Data keys:** `AUDIO_CUES`

#### [AUD-8] The first tap of a session freezes the game for 0.8–1.7 s because the AudioContext is constructed inside the gesture

- **Group:** audio (js/audio.js) · **Severity:** major · **From:** edge-cases (first-gesture freeze); lead seed #3 (first-appearance hitches)
- **What:**
  - **First tap = PLAY** on a fresh page: worst frames afterwards are [1680.9, 291.6, 76.3] ms. A second PLAY gives [28, 27.9, 27.7].
  - **`audio.unlock()`** alone takes 765 ms (nomusic) or 873 ms (music), followed by 902 / 722 ms frames.
  - **`new AudioContext()`** alone in a blank page takes 911 ms on this Windows Chrome, which also runs the desktop and artifact shells.
- **Root cause:** `engine._unlockGesture` → `audio.unlock` → `_createContext` (`js/engine.js:671-674`, `js/audio.js:552-611`). It constructs the context and builds the whole graph (noise buffers, shaper curves) synchronously, in the same task as the PLAY / level-start work.
- **Expected:** GDD §16 frame budget: no visible hitch, and the first tap must not freeze. GDD §13: the context is resumed on gestures.
- **Fix (js/audio.js):**
  1. **Build at boot.** Construct the AudioContext and build the graph in `audio.init()` (boot step 7, behind the boot bar; main.js already calls it). Without a gesture it starts 'suspended'.
  2. **unlock() only resumes.** `unlock()` then just calls `ac.resume()` and `_primeSilent()`. Keep the resume, needsGesture and iOS re-arm logic.
  3. **Lazy fallback.** If construction throws at boot, retry in the gesture.
  4. **Scheduler.** Keep the scheduler interval stopped until the context runs.
- **Verify:**
  1. Copy docs/build/qa2/edge-cases/{lib.mjs,t11-first-gesture.mjs,t12-ac.mjs} into docs/build/qa2/fix-audio/.
     - The worst frame after the first PLAY tap is under 50 ms (was 1 680 ms).
     - The audio state is 'running' after the first tap.
  2. `node tools/smoke.js --scenario all --out docs/build/qa2/fix-audio/all` is CLEAN.
  3. The harness passes `--autoplay-policy=no-user-gesture-required`, so also check without that flag that music starts on the first tap.
  4. Boot grows by no more than the constructor cost.
- **Evidence:** docs/build/qa2/edge-cases/t11-firstplay/report.json, t11-music, t11-nomusic, t12-ac.mjs output
- **Data keys:** none

#### [CORE-5] A second finger that taps mid-drag kills steering for the rest of the drag

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** major · **From:** mobile (second-finger tap)
- **What:** secondtap on iPhone 14 and 360×740:
  1. Finger 0 drags 40 px (pid 2, targetX 1.323).
  2. Finger 1 taps and lifts: `pointerDown` becomes false and `_pointerId` −1.
  3. Finger 0 drags 60 px more: targetX stays at 1.323, where 2.1 is expected.
  4. The next pointerdown from either finger adopts steering, so the second thumb takes over.

  Log: `pointerup:3@gl-canvas`, `lostpointercapture:3@gl-canvas`, then the engine drops pointer 2.
- **Root cause:** `js/engine.js:334` `this._onLostCapture = () => this._releasePointer();` (registered on #app at :586) releases the steering pointer for *any* pointer's `lostpointercapture`. pointerup and pointercancel are filtered by pointerId (:727-729).
- **Expected:** GDD §3.2 / ARCH §6.2: steering uses the first pointerId only and is released on up, cancel or blur of *that* pointer. A second thumb, or a tap on pause, must not stop or redirect the steer.
- **Fix (js/engine.js):** `this._onLostCapture = (e) => { if (e && e.pointerId === this._pointerId) this._releasePointer(); };`
- **Verify:**
  1. Copy docs/build/qa2/mobile/{lib.mjs,secondtap.mjs,twofinger.mjs} into docs/build/qa2/fix-core/, with the output path → docs/build/qa2/fix-core/touch.
  2. After finger 1 lifts, pid is still 2 and the final step reaches targetX 2.1, on iphone14 and android360.
  3. In twofinger, the second finger does not take over.
- **Evidence:** docs/build/qa2/mobile/touch/secondtap-iphone14.json, secondtap-android360.json, twofinger.json
- **Data keys:** none

#### [CORE-6] The auto quality scaler measures "refresh" from the title screen, so on any 90/120 Hz panel it demotes Medium or High to Low while the game holds 59–85 fps, and never raises again

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** major · **From:** perf-throttled (scaler chases 90/120 fps)
- **What:**
  - **q4-l9-auto.** refreshMs 8.33. High at 81 fps → Med at 23.9 s. Med at 59 fps → Low at 38.95 s, and it stays on Low.
  - **m4-end-adreno (Med ceiling).** Med at 77–96 fps (11.73 ms) dropped to Low at 21.8 s, because 1.4 × 8.33 = 11.66 ms. A raise would need ≤ 8.75 ms.
  - **Unstable refresh.** Identical runs measured refresh as 8.33, 11.1 or 16.67 ms.
  - **scalersim.** On 120/90 Hz with Med locked at 60 fps it drops to Low at 6 s and spends 114 of 120 s there. At 60 Hz it stays on Med.
- **Root cause:**
  - `js/engine.js:1201-1215` `_finishRefresh` snaps the median of the first 90 rAF intervals after boot. Those are title-scene frames, so it measures how fast the title renders, once per session.
  - `_sampleScaler` (:1217-1268) drops at meanInt > 1.4 × refreshMs and raises at ≤ 1.05 × refreshMs, so it chases 90 and 120 fps.
- **Expected:** GDD §16 / §0: Medium is the 60 fps contract. A device sustaining ≥ 60 fps on Medium is never demoted, and "refresh" means the panel's refresh.
- **Fix (js/engine.js + QUALITY_TIERS.scaler):**
  1. **Target.** `target = max(time.refreshMs, QUALITY_TIERS.scaler.targetMinMs)` (new, 16.67), used for both the drop test (1.4 × target) and the raise test (1.05 × target).
  2. **Measure refresh properly.** Use a draw-free rAF loop during the boot screen, before the warm-up: the median of ≥ 60 intervals. Re-measure on `visibilitychange` (visible) and on resize. Keep the hitch filter.
  3. **Docs.** Amend the GDD §16 auto-scaler paragraph ("relative to max(refresh, 16.67 ms)") and ARCH §6.2.
- **Verify:**
  1. Port the new rule into docs/build/qa2/perf-throttled/scalersim.mjs (copy into docs/build/qa2/fix-core/). Med at 60 fps on 90/120 Hz never drops.
  2. `node docs/build/qa2/perf-throttled/throttle.mjs --rate 4 --level 9 --quality auto --seconds 90 --out docs/build/qa2/fix-core/q4-l9-auto`.
  3. `… --rate 4 --endless --quality auto --gpu "Adreno (TM) 618" --seconds 90 --out docs/build/qa2/fix-core/m4-end-adreno`.
     - In both, tierLog shows no demotion while the mean interval stays ≤ 23 ms.
  4. A 6× run still drops to Low (the scaler still works).
- **Evidence:** docs/build/qa2/perf-throttled/q4-l9-auto/perf.json, m4-end-adreno/perf.json, m4-l9-auto/shot-45s.png, table.json, scalersim.out
- **Data keys:** `QUALITY_TIERS.scaler`, `GDD §16 (auto-scaler paragraph)`, `ARCH §6.2`

### Minor (48)

#### [VIS-13] Medium has no CPU headroom on the mid-range lens: engine JS exceeds 7.5 ms on 42–47 % of frames at 4× and on every frame at 6×, and render.draw is 84–87 % of it

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** minor · **From:** perf-throttled (Medium headroom)
- **What:** Quiet host, Medium, 390×844@2.75 (DPR capped at 1.5):
  - **q4-l9-med:** 77.6 fps; JS mean 7.51 / p95 10.0 / p99 11.9 ms; 41.9 % of frames over 7.5 ms; draw 6.46 ms (86 %).
  - **q4-end-med:** 46.9 % of frames over 7.5 ms.
  - **q6-l9-med:** 39.3 fps; JS 15.2 / p95 20.5 ms.
  - **Scene:** 54 draw calls (31 main / 9 shadow / 14 post) and 537 GL calls per frame; 143 drawables using 79 distinct materials; 119 of 164 objects have matrixAutoUpdate.
  - **Profile (p4-l9-med):** setProgram 31 % (uniform re-upload on every material switch), UnrealBloomPass 16 %, shadow pass 12.8 %, projectObject 13 %, updateMatrixWorld 4.3 %.
- **Root cause:** Three things combine:
  - many materials for identical parameter sets force program and uniform switches;
  - static props recompute world matrices every frame;
  - Medium runs a 5-mip bloom.
- **Expected:** GDD §16 frame budget: JS ≤ 7.5 ms on Medium, the 60 fps contract for 2021 mid-range phones.
- **Fix (visual files only; measure after each step with the command below):**
  1. **Static matrices (environment.js).** Static props, buildings, road pieces and their InstancedMeshes get `matrixAutoUpdate = false` plus one `updateMatrix()` after placement and after every `env.setLevel` re-seed. Leave dynamic objects untouched.
  2. **Shared materials (materials.js).** MaterialLibrary returns one shared material per parameter set for env and props, with variation through vertex or instance colour. Report the distinct material count in `render.callStats` and on the overlay.
  3. **Medium bloom.** TierBloomPass uses 3 mips on Medium (`QUALITY_TIERS.med.bloomMips` = 3, new); High keeps 5. Check that halos stay round (round-1 VIS-4), and amend the GDD §16 tier table's bloom row.
  4. **Out of scope** (see Rejected): `scene.matrixWorldAutoUpdate = false` and a 30 Hz shadow map.
- **Verify:**
  1. Run `node docs/build/qa2/perf-throttled/throttle.mjs --rate 4 --level 9 --quality med --seconds 90 --out docs/build/qa2/fix-visual/q4-l9-med`.
     - JS p95 ≤ 9 ms.
     - ≤ 15 % of frames over 7.5 ms (was 41.9 %).
  2. Run glcalls.mjs (copy into docs/build/qa2/fix-visual/). There are fewer program switches per frame.
  3. The L9 Medium screenshots are visually unchanged.
- **Evidence:** docs/build/qa2/perf-throttled/q4-l9-med, q4-end-med, q6-l9-med (perf.json); p4-l9-med/cpu.cpuprofile (analyze.mjs, top15.mjs); glcalls-med.json; sceneinfo/perf.json
- **Data keys:** `QUALITY_TIERS.med.bloomMips (new)`, `GDD §16 (tier table)`

#### [VIS-14] The shared shadow-depth material re-resolves its program 1–2 times per frame (instanced, plain and mapped casters alternate): add a depth-material helper and fix the environment casters

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** minor · **From:** perf-throttled (shadow depth churn); carryover-check (boss-fight depth churn)
- **What:**
  - **shadowchurn2 (L9 Medium, 15–45 s).** 4 326 re-resolutions in 4 307 frames: zombies.globs[inst] 1 865, env.barricade[inst] 2 163, pickups[inst] 298.
  - **churn2 (L1 High).** In the boss window, 'env.barricade(inst)' ×189 plus 'torso' ×189 per 189 frames; 0 in the run window.
  - **Cost.** getProgram and getParameters take about 2.2 % of frame time, and getParameters produces 93 KB/s of garbage.
- **Root cause:**
  - three's `WebGLShadowMap.getDepthMaterial` (`node_modules/three/build/three.module.js:22552`) uses one shared `_depthMaterial` for every caster without a `customDepthMaterial`, and copies `map` / `alphaTest` onto it (:22589-22591).
  - Env instanced casters (instanceColor; castShadow at environment.js ≈:1198; env.building has a map) alternate with plain boss rig parts and troops, and with instanced casters that lack instanceColor (zombies.globs, crates).
  - As a result the 'instancing', 'instancingColor' and 'map' program parameters flip every frame.
- **Expected:** GDD §16: zero per-frame allocations. No program re-resolution in steady state (the round-1 VIS-8 / GAT-4 acceptance).
- **Fix (js/materials.js, js/environment.js):**
  1. Add `MaterialLibrary.depthFor({ instanced, instanceColor, map })`. It returns a cached `MeshDepthMaterial({ depthPacking: RGBADepthPacking })` per combination, allocated once.
  2. Give every env shadow caster its `customDepthMaterial` from `depthFor`: one set for instanced-with-colour casters, one for the mapped buildings.
  3. Leave non-instanced casters on three's default, so the default only ever sees one combination.
  4. Document the helper in ARCH §6.3.
- **Interface:** ENE-15 (acid globs) and GAT-8 (crates) use `depthFor` or stop casting shadows. Boss parts and troops need nothing.
- **Verify:**
  1. Run `node docs/build/qa2/perf-throttled/throttle.mjs --rate 1 --level 9 --quality med --seconds 50 --after "$(cat docs/build/qa2/perf-throttled/shadowchurn2.js)" --out docs/build/qa2/fix-visual/shadowchurn2`. The SHADOWCHURN console line shows about 0 re-resolutions in 15–45 s once ENE-15 and GAT-8 have landed, and no env entries before that.
  2. Run `node docs/build/qa2/carryover-check/churn2.mjs docs/build/qa2/fix-visual/churn-l1.json 1 high`. The boss window has 0 calls.
- **Evidence:** docs/build/qa2/perf-throttled/shadowchurn2.log, casters2, casters3/perf.json; docs/build/qa2/carryover-check/ev/churn-l1-high2.json, prof-l1.json
- **Data keys:** `ARCH §6.3`

#### [VIS-15] The title-screen squad reads as black silhouettes because the camera sees their unlit backs

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** minor · **From:** visual-2 (title squad black)
- **What:**
  - **Measured.** Soldier backs on the title sample #030807 (luma 6–7), against asphalt at luma 25–30. Only the helmets catch light.
  - **Also seen** on the desktop title and in this triage's l1/00-title.png.
- **Root cause:** The sun sits ahead of the squad (GDD §15: azimuth +35°, elevation 9°). The title camera (`WORLD.camera.title`, the render.js idle camera) looks over their backs, and the 0.9 hemisphere fill is too weak for back faces.
- **Expected:** GDD §14 Title, "3D scene idles behind (squad marching …)", is the key-art frame. The §15 soldier palette must be readable: backs at least as bright as the road (luma ≥ 40).
- **Fix (js/render.js + RENDER.title):**
  1. On the title state only, change uniforms, not programs:
     - raise the HemisphereLight intensity (`RENDER.title.hemi`, new, about 1.6); and/or
     - swing the sun direction toward the camera side while the idle camera is active (`RENDER.title.sunAzimuthDeg`, new).
  2. Restore both on `level:start`.
  3. A permanent extra fill light at intensity 0 outside the title is acceptable only if its Medium cost is measured. Never create or remove lights at runtime.
- **Verify:**
  1. Run `node tools/smoke.js --scenario boot --out docs/build/qa2/fix-visual/title`, plus a `--desktop` run.
  2. Soldier backs sampled in 00-title.png have luma ≥ 40, and olive and webbing are readable.
  3. The title → play transition shows no new programs and no frame over 50 ms.
- **Evidence:** docs/build/qa2/visual-2/shots/ui_00-title.png, crops/title-squad.png; docs/build/qa2/triage/l1/00-title.png
- **Data keys:** `RENDER.title (new)`

#### [VIS-16] The shotgun and railgun power-up pill icons render as dark blobs

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** minor · **From:** visual-2 (pill icons)
- **What:**
  - **Shotgun.** The bars sample #4B3423 (luma 56), although `WEAPONS.shotgun.color` is #FF9A3C.
  - **Railgun.** The bolt samples #374A5B (luma 71), against #9FDCFF.
  - **Background.** The pill background is about luma 30.
  - The rocket and laser icons read fine.
- **Root cause:** `js/render.js:840` `paint()` fills, then strokes a 2-unit #0B0F1A outline centred on the path. At the 28 × 18 css px pill size, that outline covers most of the 5-unit shotgun bars and the roughly 6-unit rail bolt.
- **Expected:** GDD §8.1 / §15: weapon icons read at a glance in their weapon colour, consistent with the rocket and laser pills.
- **Fix (js/render.js `_paintIcon`):**
  1. Stroke first (lineWidth 3), then fill, so only the outer half of the outline shows. Alternatively, use lineWidth 1.2 for weapon icons.
  2. Thicken the shotgun bars from 5 to 7 units, and widen the rail bolt polygon by about 40 %.
  3. Icons are still drawn once at boot (UI-23 pre-warms every id).
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 13 --seconds 20 --shots 2 --after "g.weapons.startWeapon('weapon.railgun')" --out docs/build/qa2/fix-visual/pills13`, and the same with `'weapon.shotgun'`.
  2. Pill pixels keep their hue: shotgun luma ≥ 120, rail luma ≥ 140. Compare with crops/pills.png.
- **Evidence:** docs/build/qa2/visual-2/crops/pills.png
- **Data keys:** none

#### [VIS-17] Boot freezes for 0.5–1.2 s at about 97 % under throttling: per-pixel texture grain loops and a single giant warm-up draw (render part)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** minor · **From:** perf-throttled (boot bar)
- **What:** From the boot profile:
  - `TextureFactory._drawRoad` takes 138–143 ms: a per-pixel grain loop over a 512×1024 getImageData (render.js:608-612).
  - `_drawWindows` takes 80–84 ms (render.js:787-789).
  - The warm-up compile (the synchronous part of compileAsync) is 279 ms, and the warm-up draw is 374 ms, in one task.
  - At 4–6× throttling, the bar shows one frozen frame of 0.5–1.24 s at about 97 %.
- **Root cause:** Full-texture per-pixel noise loops on the main thread, and `render.warmup` draws every object in a single frame.
- **Expected:** GDD §14 Boot row (texture build about 120 ms). Round-1 CORE-1 intent: the bar reflects the work and never freezes.
- **Fix (js/render.js):**
  1. Generate grain from a tiled 64×64 noise pattern (`createPattern`), or in the shader, instead of getImageData loops.
  2. Give `warmup` a progress callback, `warmup(onProgress)`.
  3. Split the warm-up draw into chunks with a yield between them (env, characters, bosses, weapons/fx), and resolve when everything has been drawn once.
- **Interface:** CORE-9 maps the progress onto the boot bar and sets per-step captions. UI-29 adds the module preloads.
- **Verify:**
  1. Run bootprof.mjs (copy into docs/build/qa2/fix-visual/bootprof). The texture build is ≤ 120 ms in total, unthrottled.
  2. Run `node docs/build/qa2/perf-throttled/throttle.mjs --rate 4 --level 1 --quality med --seconds 10 --out docs/build/qa2/fix-visual/boot4`. No boot frame is over 300 ms (was 500–827 ms).
- **Evidence:** docs/build/qa2/perf-throttled/bootprof-r1 (boot.cpuprofile, resources.json); q4-* / q6-* perf.json boot.detail
- **Data keys:** none

#### [VIS-18] Pausing burns the theatre timers (render part: the boss dolly and the game-over camera finish while paused)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** minor · **From:** mobile (pause theatre); edge-cases (pause theatre)
- **What:** In t2-boss case A, only 0.69 s of the 2.4 s intro is seen: the dolly had already ended before RESUME.
- **Root cause:** `render.dollyTo` stores `_dollyStart = ctx.time.now` (`js/render.js:1734`), and the game-over camera stores `_goStart` the same way (:1761). Both clocks advance during a pause.
- **Expected:** ARCH §2.2: theatre timers are real time so they span slow-mo, not so they run through a pause. GDD §14: resume continues where the player left off.
- **Fix (js/render.js):** Use `ctx.time.theatre` (CORE-7; fall back to `time.now`) for `_dollyStart`, `_goStart` and every elapsed calculation of those tweens (render.js ≈:1095).
- **Interface:** CORE-7 provides the clock. ENE-17, LVL-29 and UI-28 convert their own deadlines.
- **Verify:**
  1. Copy docs/build/qa2/mobile/{lib.mjs,visboss.mjs} into docs/build/qa2/fix-visual/. After RESUME the dolly runs its remaining time.
  2. Copy the edge-cases t2-boss.mjs. In case A, the boss's z at resume equals its z at pause.
- **Evidence:** docs/build/qa2/mobile/visboss/iphone14/visboss.json; docs/build/qa2/edge-cases/t2-boss/report.json
- **Data keys:** none

#### [GAT-8] Shadow-depth program churn (crates part)

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** minor · **From:** perf-throttled (shadow depth churn)
- **What:** The pickups crates (an InstancedMesh without instanceColor) share three's default depth material with other caster kinds: pickups[inst] caused 298 re-resolutions in 30 s (shadowchurn2).
- **Root cause:** See VIS-14. The crate mesh has no `customDepthMaterial`.
- **Expected:** GDD §16: no program re-resolution in steady state.
- **Fix (js/pickups.js):** Set `crates.customDepthMaterial = materials.depthFor({ instanced: true, instanceColor: false, map: <whether the crate material has a map> })` (VIS-14). Alternatively, set `castShadow = false` if the Low-tier blob disc reads well enough for a 0.8 m box.
- **Interface:** VIS-14 provides `depthFor`.
- **Verify:** Repeat VIS-14's shadowchurn2 run with out → docs/build/qa2/fix-gates/shadowchurn2. The pickups entries are 0.
- **Evidence:** docs/build/qa2/perf-throttled/shadowchurn2.log
- **Data keys:** none

#### [GAT-9] Allocation: gates and pickups segment queries, and gates.render (round-1 carry-over: about 3.8 MB/min)

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** minor · **From:** lead seed #4 (i); perf-throttled (heap churn); carryover-check (WPN-5 incomplete)
- **What:**
  - **gates.render** (`js/gates.js:1336`): 84 KB/s at 4× (t4-l9-med), about 3.8 MB/min.
  - **Segment queries called from `weapons._sweep`:** `gates.hitTestSegment` (:696) 252 KB and `pickups.hitTestSegment` (:408) 268 KB per 46 s.
- **Root cause:**
  - Doubles passed to non-inlined calls are boxed into HeapNumbers: weapons.js:1067-1070 unpacks SEGT into locals and passes them.
  - gates.render passes doubles to helpers per instance.
- **Expected:** GDD §16: zero per-frame allocations.
- **Fix (js/gates.js, js/pickups.js):**
  1. Add `gates.hitTestSeg(seg, out)` and `pickups.hitTestSeg(seg, out)`. They read x0 / z0 / x1 / z1 from the shared `Float64Array(4)`, with the same semantics and `out` shape as `hitTestSegment`, which stays.
  2. In gates.render, keep the per-instance math inside the loop, or pass indices and typed arrays instead of doubles.
- **Interface:** WPN-8 passes its module-level segment array. ENE-16 provides the zombies and boss versions.
- **Verify:** Run `node docs/build/qa/perf/perfprobe.mjs --level 9 --quality high --seconds 45 --after "g.squad.setCount(600,'debug')" --heapprof --out docs/build/qa2/fix-gates/heap-l9`. gates.js and pickups.js each stay under 0.5 MB/min in alloc[].
- **Evidence:** docs/build/qa2/perf-throttled/t4-l9-med (alloc), heap-l9-med; docs/build/qa2/carryover-check/ev/heap-l9-perf.json, allocscan2.txt; docs/build/round1-crossgroup.txt (gates: "about 3.8 MB/min")
- **Data keys:** none

#### [FX-10] The count label merges with whatever crosses it: laser beams and flashes bloom over its digits, and a gate's value glyph overprints it during a pass ('+16' under '60' reads '+7660')

- **Group:** fx (js/fx.js) · **Severity:** minor · **From:** lead seed #4 (g); visual-2 (label merges with the gate glyph)
- **What:**
  - **Beams.** In l14laser_05 a cyan beam streaks across '22'.
  - **Gate glyphs.** In burst-wave frame 4 the white '60' sits on the white '+16' panel glyph in the same font. desk1 shows '23' under '×4', and L9 shows '39' over '+15'.
  - Round-1 carry-over (g).
- **Root cause:** The label already draws last (fx.label renderOrder 42, depthTest off, `js/fx.js:830-848`). But it is white digits with a thin outline, so:
  - bright beams or flashes behind it bloom over the digits in the post pass;
  - same-font white glyphs right behind it merge with it.
- **Expected:** GDD §3.1 / pillar 5: the count is the most legible thing on screen. The J7 pass payoff never overprints.
- **Fix (js/fx.js + JUICE.label):**
  1. Give the label a dark rounded backing plate: one extra quad behind the digits, in `PALETTE.glyph.outline` at `JUICE.label.plateAlpha` (new, about 0.45), with padding `JUICE.label.platePad` (new, about 0.15 em).
  2. Draw the plate at a renderOrder just under the label, with depthTest off, sized from nDigits.
  3. Keep the label LDR (round-1 FX-1). Thicken the outline if needed.
  4. The plate hides together with the label (FX-11).
- **Interface:** GAT-7 lowers `PALETTE.glyph.emissive`; re-check the floaters if fx still derives its white from it.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 14 --seconds 20 --shots 2 --after "g.squad.setCount(22,'debug'); g.weapons.startWeapon('weapon.laser')" --out docs/build/qa2/fix-fx/label-laser`.
  2. Run the visual-2 burst capture (copy docs/build/qa2/visual-2/tools/burst.mjs; same arguments as in its report; out under docs/build/qa2/fix-fx/).
  3. The digits keep ≥ 4.5:1 against the plate in every frame, and no '+7660'-style merge is readable.
- **Evidence:** docs/build/qa2/visual-2/shots/l14laser_05-play-9s.png, burst-wave_b6.png, crops/burst-wave.png, desk1_04-play-16s.png; docs/build/round1-crossgroup.txt (weapons: label outline / draw order)
- **Data keys:** `JUICE.label.plateAlpha (new)`, `JUICE.label.platePad (new)`

#### [FX-11] The squad count label keeps rendering behind the results and game-over screens

- **Group:** fx (js/fx.js) · **Severity:** minor · **From:** visual-2 (label behind results)
- **What:**
  - **Results.** In this triage's l1/17-result.png a large '339' sits behind the 'Bonus +90' chip.
  - **Game over.** gameover2_03-result.png shows a '0' under SHOP and HOME.
- **Root cause:** `js/fx.js:1101-1103` `_labelStateOk` returns true for 'complete' and 'gameover'.
- **Expected:** GDD §9.3 / §14: the results and game-over screens show only their own panel over a dimmed world, with no gameplay HUD numbers.
- **Fix (js/fx.js):**
  1. When the state becomes 'complete' or 'gameover', fade the label (plus its FX-10 plate) to 0 over 0.25 s.
  2. Then `setDrawCount(label, 0)`.
  3. Keep the label during the 'won' theatre (state 'playing').
- **Interface:** UI-30 handles the reward-chip layout.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 1 --seconds 75 --out docs/build/qa2/fix-fx/results`.
  2. Run `node tools/smoke.js --scenario play --level 10 --boss --nobot --after "g.squad.setCount(3,'debug')" --out docs/build/qa2/fix-fx/gameover`.
  3. No count digits are visible in either result screenshot.
- **Evidence:** docs/build/qa2/triage/l1/17-result.png; docs/build/qa2/visual-2/shots/l1c_34-result.png, gameover2_03-result.png
- **Data keys:** none

#### [FX-12] Boss damage numbers still overprint each other (round-1 FX-3 carry-over), and their tuning lives in DATA-MISSING literals

- **Group:** fx (js/fx.js) · **Severity:** minor · **From:** visual-2 (boss numbers stack); carryover-check (data hygiene, fx.js:145-148)
- **What:**
  - l15boss_06 shows '19' over '19', plus a third '19'.
  - l15boss_03 shows '32' over '21'.
  - queen13 shows '27' over '18'.
- **Root cause:** `js/fx.js:141-148`: boss numbers alternate ±0.6–0.9 m in x, rise only 1.2 m, merge for 0.12 s and live 0.7 s. That leaves about 6 alive in 2 columns, each about 0.78 m tall, so successive spawns overlap.
- **Expected:** GDD §6.1 / the J-table: each total is readable and separate.
- **Fix (js/fx.js + JUICE):**
  1. Per boss target, use a vertical slot queue: slot = n % `JUICE.damageNumber.bossSlots` (new, 3), spawn at y0 + slot·0.85 m, retire by slot. Alternatively, merge boss numbers for 0.25 s and give them a 0.5 s life.
  2. Move `NUMBER_BOSS_SCALE`, `SIDE`, `RISE` and `LIVE` (fx.js:145-148) into `JUICE.damageNumber.bossScale`, `bossSide` and `bossRise` and `JUICE.caps.bossNumbers` (all new).
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 15 --boss --seconds 30 --shots 1 --after "g.squad.setCount(400,'debug')" --out docs/build/qa2/fix-fx/boss15`, and the same with `--level 5`.
  2. No two boss-number boxes overlap in any shot.
- **Evidence:** docs/build/qa2/visual-2/shots/l15boss_06-play-16s.png, l15boss_03-play-7s.png, crops/queen13.png
- **Data keys:** `JUICE.damageNumber.bossScale (new)`, `JUICE.damageNumber.bossSide (new)`, `JUICE.damageNumber.bossRise (new)`, `JUICE.damageNumber.bossSlots (new)`, `JUICE.caps.bossNumbers (new)`, `JUICE.damageNumber.mergeSeconds`

#### [FX-14] fx allocates about 114 KB/s in steady state

- **Group:** fx (js/fx.js) · **Severity:** minor · **From:** perf-throttled (heap churn)
- **What:**
  - **Allocation.** fx.js allocates 114 KB/s at 4× (t4-l9-med), about 6.8 MB/min.
  - **Not event-time code.** The allocation scan finds only the Typed-OM fallback (fx.js:482-483) as event-time code, so the rest is per-frame boxing.
  - **DOM coin sprites.** Their Typed-OM transform writes (fx.js:476-477) cause 78 invalidations per second.
- **Root cause:** Doubles boxed across non-inlined calls in fx's per-frame paths, plus per-frame Typed-OM value objects for the DOM coin sprites.
- **Expected:** GDD §16: zero per-frame allocations.
- **Fix (js/fx.js):**
  1. Profile with `--heapprof` and remove the top fx sites, keeping doubles in typed arrays across non-inlined calls.
  2. Reuse the CSSTranslate / CSSUnitValue objects for the coin sprites, or switch them to a cached transform-string table like ui's px tables.
- **Verify:** Run `node docs/build/qa/perf/perfprobe.mjs --level 9 --quality high --seconds 45 --after "g.squad.setCount(600,'debug')" --heapprof --out docs/build/qa2/fix-fx/heap-l9`. fx.js stays under 1 MB/min.
- **Evidence:** docs/build/qa2/perf-throttled/t4-l9-med (alloc), dom-a/perf.json (coin-sprite invalidations)
- **Data keys:** none

#### [CHR-11] Boss fights exceed the 50 main-pass draw-call budget (Hulk Twins reach 57; over budget in 51 % of fight frames)

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** minor · **From:** lead seed #4 (e); carryover-check (draw calls)
- **What:**
  - **L17, High, C = 480.** Intro main-pass max 54 (75 of 80 frames over 50). Fight max 57 (586 of 1 149 frames over 50); shadow 17, post 14.
  - **Other bosses.** The L1 boss peaks at 42, and L20 Prime at 46.
  - **Round-1 note:** "needs part-mesh merging in models.js". ENE-9 only reduced shadow casters.
- **Root cause:** `js/models.js` BossRigFactory builds every sub-piece (plates, spikes, chain links, sac blobs, teeth …) as its own Mesh. Twins double that.
- **Expected:** GDD §16 / `QUALITY_TIERS.budget.mainCalls`: ≤ 50 main-pass draws on every tier.
- **Fix (js/models.js):**
  1. Merge every rig sub-piece that shares a material into its parent part mesh (`mergeGeometries`).
  2. Keep as separate meshes only the animated joints boss.js drives (torso, head, jaw, armL/R, legL/R), plus core, shield, plate0–3 and the glow pieces.
  3. For twins, consider one InstancedMesh per part across both rigs.
  4. Keep the rig contract: named children and joint origins (ARCH §6.4 / §6.8).
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 17 --boss --quality high --seconds 45 --pre "$(cat docs/build/qa2/carryover-check/callprobe.js)" --after "g.squad.setCount(480,'debug')" --out docs/build/qa2/fix-characters/calls-l17`.
  2. The last 'QA|calls' line shows main max ≤ 50 in both the intro and the fight.
  3. The L5, L10, L15 and L20 bosses look unchanged in screenshots.
- **Evidence:** docs/build/qa2/carryover-check/ev/calls-l17.report.json, calls-l1 / calls-l20 / calls-l9.report.json, l17-twins-5s.png
- **Data keys:** none

#### [CHR-12] The flamethrower trooper is overtuned: he takes about 72 % of all kills once he joins

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** minor · **From:** lead seed #5 (flamer)
- **What:** QA-ROUND1 verifier remaining #4. Round-1 CHR-8 extended the flamer:
  - range 7 → 13 m;
  - the cone swings ±0.6 rad toward zombies within 15 m;
  - a jet lobs at spitters and brutes within 19 m every 0.5 s.

  Since then the trooper is the squad's main damage source.
- **Root cause:**
  - `TROOPS.flamer` (js/data.js:553) deals 15·hz·d DPS to every zombie in the 13 m cone, plus the jet, plus the burn bonus.
  - The leak solve does not count troop DPS.
- **Expected:** GDD §8.3: troops are support. The flamer engages and burns (+20 % bullet damage), but the squad's fire stays the main kill source. Target: the flamer takes ≤ 25–30 % of kills on L8–L12.
- **Fix (js/troops.js + TROOPS.flamer):**
  1. Lower `TROOPS.flamer.dps` (e.g. 15 → 6–8) and/or the jet cadence and range.
  2. Keep the cone engaging at least once per wave it can reach.
  3. Make sure kills are attributed by cause so QA can measure.
  4. Amend GDD §8.3 if the numbers change.
- **Verify:** Run `node docs/build/qa2/feel-balance/camp.mjs --player strong --from 8 --to 12 --out docs/build/qa2/fix-characters/flamer`.
  - Flamer kills are ≤ 30 % of each level's kills.
  - The flamer still burns or kills in every wave it can reach.
- **Evidence:** docs/build/QA-ROUND1.md (CHR-8) and the round-1 verifier remaining #4 quoted in lead seed #5
- **Data keys:** `TROOPS.flamer`, `GDD §8.3`

#### [CHR-13] squad.render and squad.step allocate about 13 MB/min, now the top allocator

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** minor · **From:** perf-throttled (heap churn); carryover-check (WPN-5 incomplete)
- **What:**
  - **squad.render** (`js/squad.js:414`) allocates 10 199 KB per 46 s, about 13.3 MB/min (round 1: 8.5 MB/min).
  - **squad.step** (:337) allocates 3 369 KB.
  - At 4× squad.js allocates 137 KB/s.
- **Root cause:** `js/squad.js:462` calls `this._writeMatrix(ii, wx, 0, wz, yaw, pitch, r, scale)` per soldier per frame, boxing 7 doubles per non-inlined call. step has similar helpers.
- **Expected:** GDD §16: zero per-frame allocations. Round 1 deferred P4 and asked for this re-measure.
- **Fix (js/squad.js):** Write the instance matrix inline from the typed arrays, or pass only (ii, slot) and read x, z, yaw, pitch, roll and scale from the SoA arrays inside `_writeMatrix`. Do the same for step's helpers.
- **Verify:** Run perfprobe `--heapprof` with out → docs/build/qa2/fix-characters/heap-l9. squad.js stays under 1 MB/min.
- **Evidence:** docs/build/qa2/carryover-check/ev/heap-l9-perf.json; docs/build/qa2/perf-throttled/t4-l9-med (alloc)
- **Data keys:** none

#### [ENE-13] Bullet impacts on bosses land at shin height (0.95 m), so the whole stream converges on one spark point at the boss's feet

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** minor · **From:** visual-2 (boss impact height)
- **What:**
  - **Colossus.** In l15boss_06 and l15boss_16 every tracer converges on one spark burst at the belt or feet (y ≈ 720–750 device px), while the core glows at about 490.
  - **Queen.** The same happens under her belly (l5boss_07).
  - **Triage run.** Visible in this triage's l1/14-play-53s.png.
- **Root cause:**
  - `js/boss.js:626` `hitTestSegment` sets `out.y = FIRE.bullet.y` (0.95 m), and boss:hit sparks and numbers use it.
  - Rails and lasers already use `BOSSES.coreY` (weapons.js:1229 / 1293 / 1418).
- **Expected:** GDD §7: hit capsule radius 1.6 m, core at 4.5 m. Hits visibly land on the body and core and spread over it, so damage reads at 10–12 m.
- **Fix (js/boss.js + BOSSES.hitYRange):** Cosmetic only; hit tests stay XZ.
  1. `out.y = BOSSES.coreY · lerp(hitYRange[0], hitYRange[1], rngFx())`, with `BOSSES.hitYRange` = [0.45, 0.95] (new).
  2. Offset `out.x` by up to ±0.3·`BOSSES.radius` (rngFx), inside the capsule.
- **Interface:** WPN-9 lifts boss-aimed tracers so they end in this band.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 15 --boss --seconds 30 --shots 1 --after "g.squad.setCount(400,'debug')" --out docs/build/qa2/fix-enemies/impacts15`.
  2. Sparks spread over the torso and core band, and none sit at the feet.
- **Evidence:** docs/build/qa2/visual-2/shots/l15boss_06-play-16s.png, l15boss_16-play-37s.png, l5boss_07-play-13s.png
- **Data keys:** `BOSSES.hitYRange (new)`

#### [ENE-14] The Spitter Queen's acid sacs bloom to cream-white blobs, losing her acid-green identity (also check the Queen's hit blink for the reported pale frame)

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** minor · **From:** visual-2 (Queen sacs bloom); lead seed #4 (l)
- **What:**
  - **Sac colour.** queen13 sac samples are #E4E39D, #ECEAAF and #EFEDB6 (luma 222–233), against the authored #C7E84B.
  - **Glare.** The head and shoulders read as white glare.
  - **Hit blink.** Round-1 carry-over (l) reports a pale frame on the Queen's hit blink.
- **Root cause:**
  - models.js:2405 sets `glowMaterial.color` = `PALETTE.boss.eyesEmissive` (1.5) × the sac vertex colour. In linear that is about (0.86, 1.21, 0.10), luminance about 1.05, above the 0.85 bloom threshold.
  - boss.js render (:1604-1611) multiplies it by sacPulse, up to 1.1.
  - ACES then desaturates it.
- **Expected:**
  - GDD §15: spitter sacs are #C7E84B.
  - GDD §7: "pulsing sacs", saturated acid-green pods that glow without clipping.
  - The data.js:436 comment itself says "no extra bloom".
- **Fix (js/boss.js + BOSSES.anim):**
  1. Give sac glow pieces their own gain: `k = rig.glowSac[i] ? sacK · BOSSES.anim.sacGain : 1`, with `sacGain` new, about 0.55. Alternatively, change sacPulseMin / sacPulseMax from 0.55 / 1.1 to 0.35 / 0.65.
  2. The eyes stay at 1.5.
  3. Sample one Queen hit-blink frame: the body hue must hold, with no whitish frame. If it fails, tune `BOSSES.anim.flashTint` toward the body colour.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 5 --boss --seconds 30 --shots 1 --after "g.squad.setCount(190,'debug')" --out docs/build/qa2/fix-enemies/queen`.
  2. Sampled sac pixels keep G − B > 80 and luma < 200.
  3. Blink frames keep the body hue.
- **Evidence:** docs/build/qa2/visual-2/shots/l5boss_07-play-13s.png, crops/queen13.png, reports/l5boss.json
- **Data keys:** `BOSSES.anim.sacPulseMin`, `BOSSES.anim.sacPulseMax`, `BOSSES.anim.sacGain (new)`, `BOSSES.anim.flashTint`

#### [ENE-15] Shadow-depth program churn (zombie acid-glob part)

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** minor · **From:** perf-throttled (shadow depth churn)
- **What:** zombies.globs (an InstancedMesh without instanceColor) shares three's default depth material with the instanced env casters and the plain boss parts: 1 865 re-resolutions in 30 s (shadowchurn2).
- **Root cause:** See VIS-14. The glob meshes cast shadows without a `customDepthMaterial`.
- **Expected:** GDD §16: no program re-resolution in steady state.
- **Fix (js/zombies.js; js/boss.js if its glob mesh casts):** Set `castShadow = false` on the glob meshes: they are tiny and in flight, and the arc-preview decal already shows the landing. Alternatively, set `customDepthMaterial = materials.depthFor({ instanced: true })` (VIS-14).
- **Interface:** VIS-14 provides `depthFor`.
- **Verify:** Repeat the VIS-14 run with out → docs/build/qa2/fix-enemies/shadowchurn2. The zombies.globs entries are 0.
- **Evidence:** docs/build/qa2/perf-throttled/shadowchurn2.log
- **Data keys:** none

#### [ENE-16] Allocation: zombies and boss segment queries, the zombies hot loops, and the boss glob update ranges

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** minor · **From:** lead seed #4 (i); perf-throttled (heap churn); carryover-check (WPN-5 incomplete)
- **What:**
  - **Zombies, L9 High 600 (perfprobe `--heapprof`, per 46 s).**

    | Site | Allocation |
    |---|---|
    | zombies.render (:1431) | 3 397 KB |
    | `_stepAlive` (:1138) | 2 456 KB |
    | `hitTestSegment` (:764) | 533 KB |

    At 4× that is 181 KB/s.
  - **Boss spit globs.** They re-push an update range every frame (boss.js:100, :1656-1659), the pattern GAT-4 replaced.
- **Root cause:**
  - Doubles are boxed across non-inlined calls.
  - The boss globs push a range record into `attr.updateRanges` every frame, instead of keeping one permanent range (gates.js:166-190, `tagRange` / `keepUpdateRanges`).
- **Expected:** GDD §16: zero per-frame allocations.
- **Fix (js/zombies.js, js/boss.js):**
  1. Add `zombies.hitTestSeg(seg, radius, out)` and `boss.hitTestSeg(seg, radius, out)`. They read the shared `Float64Array(4)`, with the same semantics and `out` shape as `hitTestSegment`, which stays.
  2. Remove the boxing in `_stepAlive` and render: inline, or pass slot indices.
  3. Give the boss glob attributes the permanent-range pattern.
- **Interface:** WPN-8 calls the new queries. GAT-9 does gates and pickups.
- **Verify:** Run perfprobe `--heapprof` with out → docs/build/qa2/fix-enemies/heap-l9. zombies.js and boss.js each stay under 1 MB/min.
- **Evidence:** docs/build/qa2/carryover-check/ev/heap-l9-perf.json, allocscan2.txt; docs/build/qa2/perf-throttled/t4-l9-med; docs/build/round1-crossgroup.txt (weapons: "hitTestSeg")
- **Data keys:** none

#### [ENE-17] Pausing burns the theatre timers (boss part: the intro choreography and the death collapse finish while paused)

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** minor · **From:** mobile (pause theatre); edge-cases (pause theatre)
- **What:**
  - **Pause in the intro** (0.36–0.7 s into the 2.4 s intro). Within 300 ms of RESUME the intro is over: intro false, locked false, HP 2757 / 2800. The player sees 0.69 s of the intro, and the boss is still at z −39.5 when the fight starts.
  - **Hide during the death slow-mo.** The state is 'complete' 300 ms after RESUME: the 1.8 s collapse ran during the pause.
- **Root cause:** These are real-time deadlines on `ctx.time.now`, which keeps advancing while paused:
  - `_fightAt` (`js/boss.js:526-531`, checked at :930-931);
  - `skipIntro` (:574);
  - `deathAt` (:828);
  - the collapse in render (:1462).
- **Expected:** ARCH §2.2: theatre timers span slow-mo, not pauses. GDD §14: resume continues where the player left off.
- **Fix (js/boss.js):** Use `ctx.time.theatre` (CORE-7; fall back to `time.now`) for `_introAt`, `_fightAt`, `deathAt` and every elapsed calculation of the intro and the collapse.
- **Interface:** CORE-7 provides the clock. LVL-29, VIS-18 and UI-28 convert their own deadlines.
- **Verify:**
  1. Copy docs/build/qa2/mobile/{lib.mjs,visboss.mjs} into docs/build/qa2/fix-enemies/.
     - introResumed shows intro:true.
     - The fight starts about 1.7 s after RESUME.
     - The collapse takes its full 1.8 s after RESUME.
  2. Copy edge-cases t2-boss.mjs. Cases A, B and F pass.
- **Evidence:** docs/build/qa2/mobile/visboss/iphone14/visboss.json; docs/build/qa2/edge-cases/t2-boss/report.json
- **Data keys:** none

#### [WPN-8] Weapons still allocate about 18 MB/min (round-1 WPN-5 incomplete; target < 2 MB/min)

- **Group:** weapons (js/weapons.js) · **Severity:** minor · **From:** lead seed #4 (i); carryover-check (WPN-5 incomplete); perf-throttled (heap churn)
- **What:**
  - **Per site, perfprobe `--heapprof`, L9 High 600, per 46 s.**

    | Site | Allocation |
    |---|---|
    | `weapons._sweep` (:1058) | 9 090 KB |
    | `_stepBullets` (:1012) | 2 752 KB |
    | `_renderTracers` (:1490) | 1 142 KB |
    | zombies `hitTestSegment` (called from `_sweep`) | 533 KB |
    | pickups `hitTestSegment` | 268 KB |
    | gates `hitTestSegment` | 252 KB |

  - **Total.** About 14 MB per 46 s, i.e. about 18 MB/min. The WPN-5 target is under 2 MB/min.
  - **Other runs.** 268 KB/s at 4×, and 12.6 MB/min in heap-l9-med.
- **Root cause:** `js/weapons.js:1065-1070` unpacks SEGT into locals and passes four doubles plus the radius to each target's `hitTestSegment`, so HeapNumbers are boxed per call. `_stepBullets` and `_renderTracers` box similarly.
- **Expected:** GDD §16: zero per-frame allocations. WPN-5 acceptance: under 2 MB/min.
- **Fix (js/weapons.js):**
  1. Call the typed-segment queries with a module-level `Float64Array(4)`:
     - `zombies.hitTestSeg(SEGT, radius, OUT_Z)`
     - `boss.hitTestSeg(SEGT, radius, OUT_B)`
     - `gates.hitTestSeg(SEGT, OUT_G)`
     - `pickups.hitTestSeg(SEGT, OUT_C)`
  2. Fall back to `hitTestSegment` when a target lacks `hitTestSeg`.
  3. Remove the remaining boxing in `_stepBullets` and `_renderTracers`.
  4. Document `hitTestSeg` in ARCH §7.
- **Interface:** ENE-16 (zombies, boss) and GAT-9 (gates, pickups) implement the queries.
- **Verify:**
  1. Run perfprobe `--heapprof` with out → docs/build/qa2/fix-weapons/heap-l9. weapons.js totals under 2 MB/min.
  2. `node tools/smoke.js --scenario all --out docs/build/qa2/fix-weapons/all` is CLEAN.
  3. Run `node tools/smoke.js --scenario play --level 1 --out docs/build/qa2/fix-weapons/l1`. Final gate values match the triage run's within ±1 hit.
- **Evidence:** docs/build/qa2/carryover-check/ev/heap-l9-perf.json, allocscan2.txt; docs/build/qa2/perf-throttled/heap-l9-med, t4-l9-med
- **Data keys:** `ARCH §7`

#### [WPN-9] Boss-aimed tracers fly at 0.95 m into the boss's feet; make them climb toward the chest

- **Group:** weapons (js/weapons.js) · **Severity:** minor · **From:** visual-2 (boss impact height)
- **What:** See ENE-13. The tracers of re-aimed bullets stay at `FIRE.bullet.y` and end at the boss's shins. Even with chest-height sparks, the stream would read as aimed at the feet.
- **Root cause:** `_shoot` (`js/weapons.js:948-990`) re-aims bullets at the boss in XZ only. Their vertical velocity stays 0, so every boss-aimed tracer flies at 0.95 m.
- **Expected:** GDD §7: hits visibly land on the body and core (see ENE-13).
- **Fix (js/weapons.js):**
  1. When a bullet spawns under the boss re-aim (`_aimOn`), give it a vertical velocity through the existing `_bvy` channel (used by drone bullets, :995).
  2. The tracer climbs from `FIRE.bullet.y` to about 0.7·`BOSSES.coreY` at the boss's z, clamped at coreY.
  3. Cosmetic only: hit tests stay XZ.
- **Interface:** ENE-13 puts the impact sparks in the same band.
- **Verify:**
  1. Repeat ENE-13's run with out → docs/build/qa2/fix-weapons/impacts15.
  2. Tracers converge on the torso.
  3. Damage and TTK are unchanged.
- **Evidence:** docs/build/qa2/visual-2/shots/l15boss_06-play-16s.png, l5boss_07-play-13s.png
- **Data keys:** none

#### [LVL-21] A struggling player cannot buy their way past a wall: failed runs pay 68–184 c against ranks costing 200–550 c, and retries replay the same seed

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor · **From:** feel-balance (cannot buy past a wall)
- **What:**
  - **Repeated failures.** The worst-lane bot spending every coin fails L4, L7, L9 and L11 three times each. Every failure happens at the boss, after a full 98–137 s run.
  - **Coins kept per failure vs. the next rank:**

    | Level | Coins kept | Next rank |
    |---|---|---|
    | L4 | 68–71 | 200–210 |
    | L7 | 125–138 | 290 |
    | L9 | 182–185 | 390 |
    | L11 | 359–361 | 490–550 |

  - **Count at the boss barely moves:** L4 34 → 34; L9 35 → 35 → 35; L11 47 → 48 → 48.
  - **Non-monotonic difficulty.** The same player then clears L12 trivially.
- **Root cause:** `js/level.js` `_finishLost` pays `round(run.coins · ECONOMY.gameOverKeep)` (0.5) and nothing else. `restart()` replays the same seed, and nothing adapts to repeated failure.
- **Expected:**
  - GDD §9: "a player feels progression every 2–3 runs".
  - Pillar 4: losing is fair.
  - GDD §17 first-try completion: L5 ≥ 60 %, L10 ≥ 45 %.
- **Fix (js/level.js + data):** Do this after LVL-14 and LVL-15, then re-measure.
  1. **Consolation.** On failure, pay `ECONOMY.levelBonus(L) · ECONOMY.failBonusFrac` (new, 0.5) · the fraction reached, through the coin path (breakdown 'bonus'). Keep `gameOverKeep` at 0.5 (GDD §9.1).
  2. **Fail-streak assist.** After `LEVELS.curve.assistAfterFails` (new, 2) consecutive failures of the same level in a session, the next attempt starts with + ceil(`LEVELS.curve.assistStartFrac` (new, 0.15) · E_boss) soldiers.
     - Applied at level start, shown by the normal count roll-up.
     - Reset on a clear.
  3. **Docs.** Amend GDD §9.1 (failure row) and §10 (assist).
- **Verify:**
  1. Run `node docs/build/qa2/feel-balance/camp.mjs --player bad --from 1 --to 12 --retries 3 --out docs/build/qa2/fix-level/camp-bad`.
     - Every level is cleared within ≤ 4 attempts.
     - Each retry raises the count at the boss by ≥ 10 %, or clears.
  2. The strong bot's first-clear incomes are unchanged.
- **Evidence:** docs/build/qa2/feel-balance/camp-bad.log, table.txt
- **Data keys:** `ECONOMY.failBonusFrac (new)`, `LEVELS.curve.assistAfterFails (new)`, `LEVELS.curve.assistStartFrac (new)`, `GDD §9`, `GDD §10`

#### [LVL-22] Stars barely depend on skill: a player who never steers gets 3★ on 6 of 12 levels, and a worst-lane bot gets 3★ on L1 and L2

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor · **From:** feel-balance (stars vs skill)
- **What:**
  - **Passive player (no input).** 3★ on L1, L2, L3, L5, L8 and L12.
  - **Worst lane every event.** 3★ on L1 (131 survivors, needs 105) and on L2 (124 survivors).
  - **Why the worst lane still wins on L1.** The lane the squad sits in absorbs all its bullets, so the +2 decoy is shot to +12 MAX and the x2 to x3 or x4 with 17 soldiers. Routes: 5 → 17 → 51 → 65 → 165, and 5 → 17 → 68 → 82 → 246.
- **Root cause:** Mostly LVL-15 (waves never bite) and LVL-16 (no alternation). On L1 specifically, the authored decoys in LEVEL_1 (js/data.js:670-689: '+2' cap 12, x2 step 52) let the worse lane catch up.
- **Expected:**
  - GDD §11: 3★ is the on-curve result, and 2★ is reachable with one misread.
  - GDD §9.3: stars reward survival.
  - The worst lane every time should not earn 3★.
- **Fix (js/data.js LEVEL_1; re-measure after LVL-15 and LVL-16):**
  1. '+2' cap 12 → 6.
  2. First x2 step 52 → about 80: a 20-soldier squad can no longer reach x4 in the 4.3 s window, and the on-curve squad (E ≈ 25, about 103 hits) still reaches x3.
  3. Keep GDD §1.1's beats, and update the §1.1 and §11 rows.
  4. Re-run the validator's L1 cautious line.
- **Verify:**
  1. Run `node docs/build/qa2/feel-balance/camp.mjs --player bad --only "1,2,3" --out docs/build/qa2/fix-level/stars-bad`, plus the strong and passive players.
     - The bad bot gets ≤ 2★ on L1–L3.
     - The strong bot gets 3★ on L1.
  2. After LVL-15 and LVL-16, the passive player gets ≤ 2★ on at least half of L2–L12.
- **Evidence:** docs/build/qa2/feel-balance/table.txt, camp-bad/L01-a1.json, hintprobe/L01-a1.json
- **Data keys:** `LEVELS.authored[1] (LEVEL_1)`, `GDD §1`, `GDD §11`

#### [LVL-23] Coin income ignores play quality: the passive player out-earns the strong one on 8 of 12 levels

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor · **From:** feel-balance (income vs quality)
- **What:**
  - **Passive earns at least as much** as strong on L1 (234 vs 212), L2, L3, L4, L6, L9, L10 and L12 (1 729 vs 1 680).
  - **The 1★ bad bot** earns 1 616 on L12, against 1 680 for the 3★ strong bot. On L1 the worst-lane bot earns the most of anyone (264).
  - **Why:**
    - Kill coins dominate and are identical for everyone.
    - Gate coins favour camping a + lane past MAX (passive 58–128 vs strong 36–84).
    - A longer boss fight spawns more minions to kill.
- **Root cause:** `ECONOMY.starBonus` [0, 0, 0.25, 0.5] is the only skill term. `GATE_RULES.plus.maxCoins` 10 rewards overflow camping.
- **Expected:** GDD §9.1 / §9.3: better runs (more survivors, more stars) pay more.
- **Fix (data; js/level.js only if a new payout term is added):**
  1. `ECONOMY.starBonus` → [0, 0, 0.5, 1.0].
  2. `GATE_RULES.plus.maxCoins` 10 → 5.
  3. Re-measure after LVL-14 and LVL-15, since boss minions and wave bites change kill coins.
  4. Keep first-clear incomes within ±15 % of GDD §9.1 (L1 ≈ 190, L5 ≈ 470, L10 ≈ 880).
  5. Amend GDD §9.1 and the §0 Economy row (MAX bonus cap).
- **Verify:** Run camp.mjs strong vs passive on L1–L12 (`--out docs/build/qa2/fix-level/coins-strong` and `… coins-passive`).
  - Strong earns ≥ passive + 10 % on ≥ 10 of 12 levels.
  - Strong first-clear incomes are within ±15 % of §9.1.
- **Evidence:** docs/build/qa2/feel-balance/table.txt (coin columns)
- **Data keys:** `ECONOMY.starBonus`, `GATE_RULES.plus.maxCoins`, `GDD §9`, `GDD §0`

#### [LVL-24] L1 tutorial: 'GRAB THE CRATE' is overwritten in the same frame by 'ZOMBIES BITE!' and, being once-ever, is never shown (level part)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor · **From:** feel-balance (crate hint never shown)
- **What:**
  - **hintprobe.** The crate and bite hints both fire at 11.25 s, crate first.
  - **Visible.** The pill shows 'ZOMBIES BITE!' from 11.38 to 13.78 s. 'GRAB THE CRATE' is never visible.
  - **Marked anyway.** `save.markHint('crate')` is still recorded, so the player never sees it.
- **Root cause:**
  - LEVEL_1 fires the crate hint when the crate spawns at the horizon (data.js:681, `{ at: 90, type: 'hint', id: 'crate' }`), the same moment wave A makes contact.
  - `level.showHint` (`js/level.js:411-424`) marks the hint done before ui shows it.
  - ui then overwrites it (UI-25).
- **Expected:** GDD §1.1: 'GRAB THE CRATE' at the crate beat. Every first-run hint is seen once.
- **Fix (js/data.js LEVEL_1, js/level.js):**
  1. Move the crate hint row to `at` ≈ 120 (t ≈ 15 s, crate at z ≈ −40, about 5 s to steer).
  2. Stop calling `save.markHint` in `level.showHint`.
     - Keep the `hintDone` check.
     - Add a per-run emitted set (`run.hintsShown`) so each id is emitted at most once per run.
     - ui marks a hint when it is actually displayed (UI-25).
  3. Update GDD §11 (crate hint row) and ARCH §6.16 (the `showHint` contract).
- **Interface:** UI-25 (queue, mark on display) lands together.
- **Verify:**
  1. Run `node docs/build/qa2/feel-balance/camp2.mjs --player strong --only 1 --hintprobe --out docs/build/qa2/fix-level/hintprobe`.
  2. 'GRAB THE CRATE' is visible ≥ 2 s before the crate passes.
  3. Every L1 hint id is visible at least once.
  4. `save.hints` gains an id only after it was shown.
- **Evidence:** docs/build/qa2/feel-balance/hintprobe-strong/hintlog.json, hintprobe/hintlog.json
- **Data keys:** `LEVELS.authored[1] (LEVEL_1)`, `GDD §11`, `ARCH §6.16`

#### [LVL-25] 'SHOOT THE BOSS' fires at the start of the intro, while the boss is still immune (level part)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor · **From:** visual-2 (boss hint timing)
- **What:**
  - **probe-hint.** The hint is visible from 27.48 s to 29.53 s, and every sample in that window has inIntro true and HP 2800 / 2800.
  - **Hides at the fight.** It hides at 29.83 s, exactly when the fight starts.
  - Its placement over the name card and the Queen is UI-18.
- **Root cause:**
  - `js/levelgen.js:1741` pushes `{ at: len, type: 'hint', id: 'boss' }`, and LEVEL_1 has the same row at 400 (data.js).
  - The hint lasts 2.5 s (`JUICE.ui.hintSeconds`), and intro immunity lasts 2.6 s (`BOSSES.intro.invuln`).
- **Expected:** GDD §1.1 ("50.0 Boss … Hint SHOOT THE BOSS") and §7 (immune intro): the hint appears when shooting starts to count.
- **Fix (js/levelgen.js, js/level.js, LEVEL_1):**
  1. Remove the boss hint rows, both generated and authored.
  2. In `_onBossFight` (`js/level.js:1339`), call `this.showHint('boss')` for campaign bosses.
  3. Update the GDD §11 boss row.
- **Verify:**
  1. Run the visual-2 boss-hint probe (copy probe.mjs + m_hint.js; out → docs/build/qa2/fix-level/probe-hint).
  2. The first visible hint sample has inIntro false and HP < max.
- **Evidence:** docs/build/qa2/visual-2/reports/probe-hint.json, shots/l1c_29-play-57s.png; docs/build/qa2/triage/l1/14-play-53s.png
- **Data keys:** `LEVELS.authored[1] (LEVEL_1)`, `GDD §11`

#### [LVL-26] L4's guaranteed magnet is an item lane paired with +9, so a player following the gates never gets it (round-1 LVL-7 incomplete)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor · **From:** carryover-check (LVL-7 partly fixed)
- **What:**
  - **validate-levels, L4.** 'gate @236 → 306 m pair item gear.magnet | +9 (cap 36) greedy lane 1: 46 → 82'. Both the design and greedy lines take the +9.
  - **Bot run.** 28 → 52 at 27.6 s (the + lane), and no magnet afterwards.
  - **L2 holds.** The armor crate on the design half is collected (armor 50 from 29.1 s).
- **Root cause:** `js/levelgen.js` delivers the guaranteed special as an item lane against a + lane that the design line prefers. The LVL-7 crate rule (:1705-1715) only covers the crate path.
- **Expected:** GDD §8: "the level's newly unlocked special is guaranteed". Round-1 LVL-7: a first-time player meets it without giving up the obvious lane.
- **Fix (js/levelgen.js, tools/validate-levels.js):**
  1. Deliver the guaranteed special through the crate path on the design half, or pair the item lane with a lane the design line would not take (a red or small + lane).
  2. Add a validator check: the design line collects every guaranteed special.
- **Verify:**
  1. `node tools/validate-levels.js`: the new check passes for every unlock level (L2–L14).
  2. Run `node tools/smoke.js --scenario play --level 4 --out docs/build/qa2/fix-level/l4bot`. gear.magnet becomes active in the timeline.
- **Evidence:** docs/build/qa2/carryover-check/validate.txt (L4), ev/l4bot.report.json, ev/l2bot.report.json
- **Data keys:** none

#### [LVL-27] Balance carry-overs: the opening x3 step is unreachable on L6, L26 and L28; the weak-shooter line is under 20 % of E_boss on 16 levels; L2's greedy line is 147 %

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor · **From:** lead seed #5; carryover-check (balance evidence update)
- **What:** validate-levels reports 37 warnings:
  - **Unreachable x3 step.** "x3 step exceeds the hits a full squad can land" at L6 @75 (167 vs 81), L26 @0 and L28 @0 (128 vs 58).
  - **Weak line (0.3·H) below 20 % of E_boss:**

    | Weak line | Levels |
    |---|---|
    | 0 % | L8, L14, L27 |
    | 8–9 % | L18, L22, L23, L25 |
    | 14–15 % | L15, L16, L20, L21, L29, L30 |
    | 19 % | L9 |

  - **L2's greedy line** is 147 %.
  - **Elsewhere.** The lead's seed #5 parts are handled in other issues: crawler-wave leak is the model calibration in LVL-15, brute contact losses are ENE-12, and the flamer is CHR-12.
- **Root cause:**
  - `js/levelgen.js` `gateDefaults` sizes an opening x step from E·f·t_w without clamping to the window's achievable intake.
  - The weak line collapses where red and ÷ events dominate.
- **Expected:** GDD §4.4 / §10: every generated feature is reachable, and the survivability line holds.
- **Fix (js/levelgen.js, tools/validate-levels.js + GATE_RULES.mult):**
  1. Clamp opening x steps so step ≤ 0.9 · min(40, E·f) · t_w.
  2. Re-roll or soften events that drop the weak line below 20 %. Do this after LVL-15, which changes every wave.
  3. Make the validator fail, not warn, on an unreachable step and on a 0 % weak line.
  4. Bring L2's greedy line to ≤ 130 %.
- **Verify:** Run `node tools/validate-levels.js > docs/build/qa2/fix-level/validate-balance.txt`.
  - No unreachable-step or 0 % weak-line failures.
  - The weak line is ≥ 20 % everywhere, or justified per level.
  - L2's greedy line is ≤ 130 %.
- **Evidence:** docs/build/qa2/carryover-check/validate.txt; docs/build/qa2/feel-balance/validate.txt
- **Data keys:** `GATE_RULES.mult`

#### [LVL-28] Apply the round-1 GDD amendments in the level-owned sections (the "authoritative" GDD contradicts the shipped code)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor · **From:** carryover-check (GDD amendments not applied)
- **What:** The QA-ROUND1 "GDD / ARCHITECTURE amendments" were not applied; only §8.3's flamer and ARCH's setGearGlow landed. Still stale in level-owned sections:

  | Location | Stale text | Round-1 change |
  |---|---|---|
  | GDD:156 | H = min(40, E·2.0·0.5)·t_w | LVL-1 intake model |
  | GDD:396 | the rubber band is "one shootable to x2" | LVL-3: x1, plus the > 4·E lock |
  | §4.4 | design line without full-intake ceilings | LVL-1: design line at 0.75·H with full-intake ceilings |
  | §6.3 | old leak windows | LVL-4: per-type windows and coverage |
  | §7 | intro immunity, attack range, first attack 0.8 s after boss:fight, phase specials within 1 s, start-to-start interval, charge stop about 5 m, telegraphs at the squad front with x-only tests — all missing | ENE-1 / ENE-2 / ENE-5 |
  | §9.2 | boss-damage rank 7 = 1 350, grand total 59 350 | R8: 1 360 and 59 360 |
- **Root cause:** The round-1 doc amendments had no owner group, so nobody applied them.
- **Expected:** docs/GDD.md is authoritative, so round-3 testers must not file issues against, or "fix back" toward, stale numbers.
- **Fix (docs/GDD.md only, in the sections you own):**
  1. Rewrite the lines above to match the code. Read the values from data.js: `GATE_RULES.hits` / `mult` / `div`, `LEAK_MODEL`, `BOSSES.intro` / `attackRangeM` / `firstAttackDelay` / `chargeStopZ`, `LEVELS.endless.rubber`.
  2. Tag each amended line "(round-1 QA <ID>)".
- **Verify:**
  1. Grep the GDD for "0.5)·t_w", "shootable to x2", "1 350" and "59 350". None remain.
  2. Every amended line carries its QA tag.
- **Evidence:** docs/build/QA-ROUND1.md ("GDD / ARCHITECTURE amendments"); the carryover-check docs issue (line list)
- **Data keys:** `GDD §4.2`, `GDD §4.4`, `GDD §6.3`, `GDD §7`, `GDD §9`, `GDD §10.1`

#### [LVL-29] Pausing burns the theatre timers (level part: the results and game-over delay elapses while paused)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor · **From:** mobile (pause theatre); edge-cases (pause theatre)
- **What:** Pausing 1.4 s into the boss death for 5 s fires level:complete 20 ms after resume (t2-boss case B).
- **Root cause:** `_finishAt = ctx.time.now + 3000` / `GAMEOVER_RESULTS_MS` (`js/level.js:1372`, :1397, checked at :726) advances while paused.
- **Expected:** ARCH §2.2: theatre timers span slow-mo, not pauses.
- **Fix (js/level.js):** Use `ctx.time.theatre` (CORE-7; fall back to `time.now`) for `_finishAt`.
- **Interface:** CORE-7 provides the clock.
- **Verify:** Run the t2-boss copy (docs/build/qa2/fix-level/t2-boss). In case B, complete fires (3 000 − elapsed-before-pause) ms after resume.
- **Evidence:** docs/build/qa2/edge-cases/t2-boss/report.json
- **Data keys:** none

#### [UI-21] Screen changes and hint display force synchronous layout inside the rAF (level-start frame 38 ms unthrottled, 111 ms at 4×)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor · **From:** perf-throttled (forced layout); carryover-check (seed #3 evidence)
- **What:**
  - **Unthrottled.** The level-start frame is a 38 ms task: `ui.update` → `showScreen` 16 ms, with `_enterFade` at 11 ms self.
  - **At 4×.** 110.8 ms: `_enterFade` 62 ms self, `_placeHint` 11 ms, `getBoundingClientRect` 8 ms.
  - **Trace of `level.start(1)`.** `Document::UpdateStyleAndLayout` takes 54.1 ms inside `Engine._onFrame`, of which layout is 44.1 ms. A 232 ms DOM raster task follows at +418 ms: the first HUD raster.
- **Root cause:**
  - **Fade.** `js/ui.js:2519-2526` `_enterFade` does `classList.remove('enter'); void node.offsetWidth; classList.add('enter')` right after `showScreen` toggled `hidden` on every screen. That forces a whole-document style and layout pass.
  - **Hint.** `_showHintDom` → `_placeHint` → `_measureRaw` (:1640-1652, :1572-1599, :2403-2416) reads `getBoundingClientRect` twice right after writing `textContent` and `hidden`.
- **Expected:** GDD §14 / ARCH §6.14: UI work stays layout-light. No frame over 50 ms at level start.
- **Fix (js/ui.js):**
  1. Restart the 160 ms fade with the Web Animations API: `this._animate(node, KF_FADE_IN, { duration: JUICE.ui.screenFadeMs })`, cancelling the previous animation. No reflow needed.
  2. Never read layout in the same frame after DOM writes:
     - the hint size comes from a ResizeObserver (UI-18);
     - any other measurement happens in a read-first phase at the start of `ui.update`, or is cached per resize.
  3. Make sure `#hud` is part of the UI-19 boot prewarm, so its first raster happens behind the boot screen.
- **Verify:**
  1. Run `node docs/build/qa2/carryover-check/trace.mjs docs/build/qa2/fix-ui/trace-start 1`. There is no `UpdateStyleAndLayout` over 5 ms inside `Engine._onFrame`, and no long frame at level start.
  2. Run `node docs/build/qa2/perf-throttled/spikes.mjs --rate 4 --quality med --out docs/build/qa2/fix-ui/spikes-r4`. The L1 start frame is under 60 ms (was 110.8 ms).
- **Evidence:** docs/build/qa2/perf-throttled/spikes-r1q, spikes-r4q (longframes.mjs); docs/build/qa2/carryover-check/ev/trace-levelstart-summary.json
- **Data keys:** none

#### [UI-22] HUD CSS transitions and animations force style recalculation, layout and paint every frame (31 % of the main thread's per-frame CPU, invisible to jsMs)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor · **From:** perf-throttled (HUD transitions)
- **What:** A/B test, L9 Medium, 20 s trace:
  - **As shipped.** 0.79 ms/frame of DOM CPU: UpdateLayoutTree on every frame, Layout 1 998 times, Paint 7 922 times.
  - **`#progress-fill` with `transition: none`.** 0.60 ms/frame.
  - **All `#hud` animations off.** 0.24 ms/frame.
  - **Saving.** About 0.55 ms/frame unthrottled, about 2.2 ms at 4× and 3.3 ms at 6×.
  - **Invalidations per second:**
    - `#progress-fill` and `#progress-squad`: 'Animation' 96 each, plus Layout 96.
    - The stripes `::after`: 136.
    - The DOM coin sprites: 78.
- **Root cause:**
  - `css/game.css:611` (`transition: width 110ms`) and :634 (`transition: left 110ms`) are retriggered by the 10 Hz writes at `js/ui.js:1692-1693`.
  - The marker carries a 5-layer `drop-shadow` filter (:633) that repaints as it moves.
  - The stripe keyframes (:621, :1092) run on non-composited `::after` layers.
- **Expected:** GDD §16 budget and the §14 per-frame rule: steady-state HUD updates are compositor-only, or happen at the 10 Hz cadence.
- **Fix (css/game.css, js/ui.js):**
  1. **Progress fill.** An inner element with `transform: scaleX(f)` and `transform-origin: left`.
  2. **Marker.** `transform: translateX(…)`, computed from the cached bar width.
  3. **Transitions.** Transition `transform` only, or nothing.
  4. **Marker outline.** Bake it into the background (SVG or data URI) instead of 5 `drop-shadow` filters.
  5. **Containment.** `will-change: transform` on the stripe layers, and `contain: layout paint` on the `#hud` blocks.
- **Verify:** Run `node docs/build/qa2/perf-throttled/throttle.mjs --rate 1 --level 9 --quality med --seconds 40 --traceAt 15 --traceFor 20 --inv --out docs/build/qa2/fix-ui/dom`.
  - `domCpuPerFrame` is ≤ 0.3 ms.
  - The Layout count is far below the frame count.
- **Evidence:** docs/build/qa2/perf-throttled/dom-a, dom-b, dom-c (perf.json, trace-1.json)
- **Data keys:** none

#### [UI-23] The first pickup of each power-up type PNG-encodes its pill icon on the main thread (55–90 ms frame at 4×)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor · **From:** perf-throttled (icon encoding); lead seed #3 (weapon pickup hitch)
- **What:**
  - **Unthrottled (spikes-r1q, shotgun pickup).** `_syncPills` (ui.js:1756) → `_iconUrl` (:2469-2479) → `render.iconDataURL` (render.js:444-458) → `toDataURL`, 9 ms self.
  - **At 4×.** First rocket pickup 62.6 / 90.3 ms; first minigun pickup 62.5 ms.
  - **Not shader compile.** Programs stay flat.
- **Root cause:** The icon cache fills lazily. `_setupIcons` (:2452-2466) pre-builds only coins, armor and the hand.
- **Expected:** ARCH §9.6: icon data URLs come from the factory cache built at boot. No canvas encoding during play.
- **Fix (js/ui.js):**
  1. In `_setupIcons`, pre-warm `_iconUrl(id)` for every `RENDER.icons.order` id at `PILL_ICON_PX`: 16 icons, about 10 ms once at boot.
  2. Better: build one sprite-sheet blob URL (`canvas.toBlob`, async) and use `background-position`.
- **Verify:**
  1. Run `node docs/build/qa2/perf-throttled/spikes.mjs --rate 4 --quality med --out docs/build/qa2/fix-ui/spikes-icons`. Weapon pickup frames are under 33 ms.
  2. A CPU profile shows no `toDataURL` after boot.
- **Evidence:** docs/build/qa2/perf-throttled/spikes-r1q (weapon-shotgun); q4-l9-med, q4-l9-low, m4-end-adreno worst[]
- **Data keys:** none

#### [UI-24] An unbounded highestUnlocked in the save hangs the LEVELS screen and kills the game loop on every launch (severity lowered: needs a hand-edited or corrupted save)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor · **From:** edge-cases (unbounded highestUnlocked)
- **What:**
  - **Corrupted value.** With `localStorage['gaterush.v1']` = `{highestUnlocked: 2000000}`, opening LEVELS produces an 11 258 ms frame, then the fatal box "Invalid string length" (`UI._fillLevels`, js/ui.js:1900).
  - **Persistent.** The engine stops, and the crash returns on every launch.
  - **Legit maximum.** A value the code can produce (`MAX_LEVEL_KEY` 9 999) still takes 4 347 ms and 60 306 DOM nodes.
  - **Why minor.** Raised by the tester as major; lowered here because reaching it needs a hand-edited or corrupted save.
- **Root cause:** `js/save.js:160` `sanitize` only applies `Math.max(1, …)`. `js/ui.js:1873-1910` `_fillLevels` builds one tile per level, up to max(LEVELS.count, hl), in a single string.
- **Expected:** The save.js header promises per-field sanitation, so a corrupted save cannot poison the game. LEVELS opens within one frame for any save.
- **Fix (js/save.js, js/ui.js):**
  1. Clamp `highestUnlocked` to min(`MAX_LEVEL_KEY`, largest cleared level key + 1), and to 1 when nothing is cleared.
  2. `_fillLevels` renders 1..LEVELS.count plus at most a 30-tile window around the current level, or one 'LOOP n' tile.
  3. Share the build-once grid with UI-19.
- **Verify:**
  1. Copy docs/build/qa2/edge-cases/{lib.mjs,t9-levels.mjs,t8-meta.mjs} into docs/build/qa2/fix-ui/.
  2. For hu 2e6 and hu 9 999: LEVELS opens in under 50 ms, there is no fatal box, and highestUnlocked is sane after reload.
- **Evidence:** docs/build/qa2/edge-cases/t9-levels-hu2e6/report.json, t8-loop/report.json, t8-corrupt-huge-unlock
- **Data keys:** none

#### [UI-25] Hints overwrite each other (no queue) and are marked done before they are seen (ui part)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor · **From:** feel-balance (crate hint never shown)
- **What:** 'GRAB THE CRATE' and 'ZOMBIES BITE!' fire in the same frame. The pill shows only the second, and the first is marked done forever.
- **Root cause:** `ui.showHint` (`js/ui.js:1064`) replaces the current hint immediately. Marking happens in `level.showHint`, before display.
- **Expected:** GDD §1.1 / §11: every first-run hint is shown once.
- **Fix (js/ui.js; js/save.js usage):**
  1. **Queue hints:**
     - at most `JUICE.ui.hintQueueMax` entries (new, 2);
     - de-duplicate by id;
     - drop entries older than 6 s or from a previous level.
  2. **Show in turn.** Show the next hint after the current one's 2.5 s.
  3. **Mark on display.** Call `ctx.save.markHint(id)` when a hint is actually displayed (save.js is ui's file).
  4. **Reset.** Clear the queue on level start and on quit.
  5. Document this in ARCH §10.3.
- **Interface:** LVL-24 removes `markHint` from `level.showHint`; the two land together. The `hint:show` payload is unchanged.
- **Verify:**
  1. Repeat LVL-24's hintprobe with out → docs/build/qa2/fix-ui/hintprobe, plus the UI-18 screenshots.
  2. Each hint id is visible once, in order, for ≥ 2 s each.
- **Evidence:** docs/build/qa2/feel-balance/hintprobe-strong/hintlog.json
- **Data keys:** `JUICE.ui.hintQueueMax (new)`, `ARCH §10.3`

#### [UI-26] Landscape phone: the boss name and HP bar sit on top of the boss's head and upper chest for the whole fight

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor · **From:** mobile (landscape boss bar)
- **What:**
  - **Landscape 844×390, hold z = −12 (css px):**

    | Element | Screen y |
    |---|---|
    | boss head (7 m) | 84–86 |
    | boss chest / core (4.5 m) | 132 |
    | `#boss-name` | 78–101 |
    | `#boss-track` | 106–121 |

    So the bar spans the top third of the rig.
  - **On screen.** 02-landscape-2s shows 'SPITTER QUEEN' and the red bar over her face.
  - **Portrait is clear.** The head is at 226, and the bar ends at 140.
- **Root cause:** `css/game.css` places `#bossbar` at safe-top + 110·u with no landscape variant.
- **Expected:** GDD §7 / §14: the boss is the focus, and HUD chrome never hides its face, core or sacs in any supported orientation.
- **Fix (css/game.css):** In `@media (orientation: landscape) and (max-height: 500px)`:
  1. Move `#bossbar` into the top row, beside or under `#progress` (top: safe-top + 4 px).
  2. Make it narrower, with a smaller name.
  3. The bar's bottom must be ≥ 8 px above the projected head.
- **Verify:**
  1. Copy docs/build/qa2/mobile/{lib.mjs,bossframe.mjs} into docs/build/qa2/fix-ui/.
  2. For 'landscape 5' and 'landscape 10': head y ≥ bar bottom + 8.
  3. Portrait is unchanged.
- **Evidence:** docs/build/qa2/mobile/bossframe/*/bossframe.json, rotate/iphone14-boss/02-landscape-2s.png
- **Data keys:** none

#### [UI-27] Text falls below 12 px on small phones and in landscape (the --ui floor of 0.85 is applied to the 12/13/14 px tokens)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor · **From:** mobile (text < 12 px)
- **What:**
  - **360×740 (--ui 0.877):** the shop's `.card-effect` is 11.4 px on all 5 cards, the level-tile stars 11.4 px, and `#version` 10.5 px.
  - **844×390 (--ui 0.850):** `.card-effect` 11.1, `#title-caption` 11.9, the results breakdown items 11.9, `#complete-best` 11.9, `#version` 10.2.
  - **Unaffected:** Large text fixes all of these, and iPhone 14, 412 px and iPad are fine.
- **Root cause:** `css/game.css:115-116` (`--fs-small` = 14·ui, `--fs-micro` = 12·ui), :1220 and :1392 (13px·ui), and :1399.
- **Expected:** Body and readout text is ≥ 12 css px on every supported phone. The shop effect and the results breakdown are decision and reward information.
- **Fix (css/game.css):**
  1. `--fs-small: max(12.5px, calc(14px * var(--ui) * var(--text-scale)))` and `--fs-micro: max(12px, …)`.
  2. The same `max(12px, …)` for the two 13px·ui rules.
  3. `#version` may stay decorative, but at ≥ 11 px.
  4. Amend GDD §14 (type-scale floor of 12 px).
- **Verify:**
  1. Copy docs/build/qa2/mobile/{lib.mjs,layout.mjs} into docs/build/qa2/fix-ui/ and run it for android360 and landscape.
  2. 'tiny' lists only the `#btn-pause` and star glyphs, which have font-size 0 by design.
- **Evidence:** docs/build/qa2/mobile/layout/<device>/layout.json and screenshots
- **Data keys:** `GDD §14`

#### [UI-28] Pausing burns the theatre timers (ui part: the boss name card, hint and boss-bar-out timers expire while paused)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor · **From:** mobile (pause theatre); edge-cases (pause theatre)
- **What:** The name card has disappeared by the time the player resumes, even if they paused while it was showing.
- **Root cause:** `ui._clock` advances in `update(unscaledDt)`, which runs every frame while paused (ARCH §2.2). So `_ncUntil` (ui.js:1522), `_hintUntil` (:1643) and `_bossHideAt` (:1361) expire during a pause.
- **Expected:** ARCH §2.2: theatre timers span slow-mo, not pauses.
- **Fix (js/ui.js):**
  1. Keep a second clock that advances only while the state is not 'paused', or read `ctx.time.theatre` (CORE-7).
  2. Use it for the name card, hint and boss-bar-out deadlines.
  3. Flashes, the vignette and coin flights keep animating during pause, as today.
- **Interface:** CORE-7.
- **Verify:** Run the visboss copy (docs/build/qa2/fix-ui/visboss). The name card is still showing for its remaining time after RESUME.
- **Evidence:** docs/build/qa2/mobile/visboss/iphone14/visboss.json
- **Data keys:** none

#### [UI-29] Boot shows 0 % for half the boot under throttling: the module waterfall, and captions picked by fraction (ui part)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor · **From:** perf-throttled (boot bar)
- **What:**
  - **At 4×, quiet host.** The first bar update arrives at 2.45–3.30 s, and the boot screen hides at 5.25–6.76 s.
  - **150 ms RTT, 1.6 MB/s.** The bar shows 0 % for about 65 % of the boot.
  - **Request waves.** The module graph loads in 5 waves: main.js → 17 modules → three → 10 → 5.
  - **modulepreload helps.** `<link rel=modulepreload>` for every module made both marks about 430 ms earlier.
  - **Wrong caption.** Captions are picked by fraction (ui.js:906-909), so 'Tuning the sirens…' (audio) shows from 75 % to 100 %, during models, systems and the shader warm-up.
- **Root cause:** index.html declares no module preloads, so the browser discovers modules wave by wave. `setBootProgress` derives the caption from the fraction instead of from the step that is actually running.
- **Expected:** GDD §14 Boot row. Round-1 CORE-1 intent: the bar reflects the work.
- **Fix (index.html, js/ui.js):**
  1. **Preloads.** Add `<link rel="modulepreload">` to index.html for js/*.js and the three CDN modules (the import-map URLs).
  2. **Download phase.** Add an inline creeping or indeterminate state for the bar (0–4 %, in the inline boot script).
  3. **Step captions.** Add `ui.setBootCaption(index)`, and stop deriving captions from the fraction. `STRINGS.boot.steps` gets one entry per real step: page, textures, models, audio, systems, shaders.
- **Interface:** CORE-9 calls `setBootCaption` at each step. If the artifact build needs the preload links, that is a QA follow-up for tools/build-artifact.js.
- **Verify:**
  1. Run bootnet.mjs (copy into docs/build/qa2/fix-ui/bootnet).
  2. At 150 ms RTT the bar first moves ≤ 0.5 s after navigation start.
  3. The shipped index.html matches the modulepreload variant.
  4. Captions match the running step.
- **Evidence:** docs/build/qa2/perf-throttled/bootnet.json, bootnet-contended.json, bootprof-r1/resources.json; q4-* / q6-* boot.detail
- **Data keys:** `STRINGS.boot.steps`

#### [AUD-9] The shotgun pickup sting and the gate-flip cue are nearly silent under the gunfire bed

- **Group:** audio (js/audio.js) · **Severity:** minor · **From:** audio (quiet sting and flip)
- **What:**
  - **Shotgun sting.** Isolated peak −21.3 dBFS, RMS −33.8. That is 11–15 dB below the other stings (peaks: minigun −6.6, rocket −6.2, laser −7.1, rail −9.9).
  - **Flip.** Peak −23.0, RMS −37.9: 13 dB below the tick and max cues it accompanies.
  - **In L1.** Master RMS rises only +0.9 dB at both cues.
  - **Flip sweep.** Its 1–3 kHz half is 20–40 dB down.
  - **Phone-weighted.** −38.9 / −41.7 dB RMS.
- **Root cause:**
  - `sting_shotgun` (js/data.js:1187) is white noise through a 600 Hz low-pass, which removes about 97 % of the power.
  - `flip` (:1173) uses the default envelope (decay = attack = 2 ms), so it decays from the start of its 150 ms sweep.
- **Expected:** GDD §12 J13 / J5 are headline feedback moments. Stings sit within about 3 dB of each other, and the flip sweep is audible over its whole 150 ms.
- **Fix (data):**
  1. **sting_shotgun:**
     - src 'brown' (or 'band'), low-pass 1 800 Hz, gain 1.0, attack 2, decay 30;
     - add a sine 140 → 60 Hz layer, 120 ms, gain 0.6;
     - target an isolated peak of about −8 dBFS.
  2. **flip:** attack 10, decay 110, q 0.8, gain 1.0.
  3. Update the GDD §13 recipes.
- **Verify:**
  1. Run `node docs/build/qa2/audio/rec.mjs --phase cues --out docs/build/qa2/fix-audio/cues`, then analyze.mjs.
     - flip's active RMS is ≥ −22 dBFS.
     - sting_shotgun's peak is within 3 dB of sting_minigun's.
  2. phone.cjs shows a loss of ≤ 8 dB for both.
- **Evidence:** docs/build/qa2/audio/cues/analysis.json, cues/phone-weighted.json; l1 meta/stats
- **Data keys:** `AUDIO_CUES`, `GDD §13`

#### [AUD-10] The gate-pass reward barely rises above the gunfire, and the 8-voice 'hup' crowd is quieter than one voice

- **Group:** audio (js/audio.js) · **Severity:** minor · **From:** audio (gate-pass reward)
- **What:**
  - **L1 passes.** Master RMS rises only +3.7 / +1.7 / +1.0 / +3.2 dB.
  - **Masked by the bed.** The gunfire bed (about −22.9 dBFS) equals pass_up's active RMS (−20.7).
  - **hup.** One voice peaks at −12.4 with RMS −28.2. Eight voices (count 32) give −14.9 / −28.5, i.e. quieter.
  - **Adds nothing.** pass_up + hup32 measures the same as pass_up alone.
- **Root cause:**
  - `js/audio.js:1042` uses vGain = 1/n^0.35 across 8 randomly detuned sawtooths that sum incoherently.
  - pass_up's layer gains are 0.45 (js/data.js).
  - There is no gun-bus duck on reward moments.
- **Expected:** Pillar 2 / J7: the pass is the reward moment, ≥ 6 dB over the gunfire bed. More soldiers gained sounds bigger.
- **Fix (js/audio.js + data):**
  1. **Gun-bus duck.** Duck the gun bus by −6 dB for 0.4 s on gate:pass, weapon:start and gate:flip. Reuse `duck()` on a gun-bus gain (`MUSIC.duck.gunOnReward`, new).
  2. **pass_up gains** 0.45 → 0.65.
  3. **hup:**
     - gain 0.5 → 0.9, attack 5, decay 40;
     - per-voice gain 1/n^0.2, so 8 voices are about +5 dB over 1.
- **Verify:**
  1. Run rec.mjs `--phase l1` (docs/build/qa2/fix-audio/l1-reward), then analyze.mjs.
  2. Every L1 pass rises ≥ 6 dB over the preceding 300 ms.
  3. hup ×8 is ≥ ×1 + 4 dB.
- **Evidence:** docs/build/qa2/audio/l1 (meta + stats), l1/analysis.json (plays)
- **Data keys:** `AUDIO_CUES`, `MUSIC`

#### [AUD-11] Sub-bass-only cues are inaudible on phone speakers yet use the most headroom (whomp, thud, explosion, rail, drone_down, the music kick)

- **Group:** audio (js/audio.js) · **Severity:** minor · **From:** audio (phone speakers)
- **What:** With a 400 Hz 4th-order high-pass (typical phone speaker):
  - **RMS loss (full band → phone):**

    | Cue | Loss |
    |---|---|
    | whomp | −14.8 → −47.5 dB (−32.7) |
    | thud | −29.7 |
    | boss stomp thud | −30.3 |
    | explosion | −16.2 |
    | rail | −16.3 |
    | drone_down | −15.3 |
    | sting_rocket | −13.1 |

  - **Headroom.** whomp's full-band peak (−1.4 dBFS) is the second highest cue, and each whomp raises master RMS by 4.5–7 dB.
- **Root cause:** The recipes are built from sines at ≤ 90 Hz: thud 60 Hz (data.js:1168), whomp 90 / 45 Hz (:1174), drone_down low-passed at 400 Hz, the music kick at 50 Hz.
- **Expected:** Mobile-first (BRIEF / GDD). Gameplay-critical cues (J4 gate step, J11 brute bite, J18 game over) keep their identity on a phone speaker, within about 6–8 dB of full band.
- **Fix (data):** Add mid-band layers and trim the sub:
  1. **whomp.**
     - Add a triangle 180 → 153 Hz, 200 ms, gain 0.5.
     - Add band noise (band-pass 500 Hz, q 1), 60 ms, gain 0.4.
     - Sines 0.9 → 0.6.
  2. **thud.**
     - Shaper 0.3 on the 60 Hz sine.
     - Band-pass the noise at 400 Hz (q 0.8), gain 0.7.
  3. **drone_down.** Low-pass 400 → 1 200 Hz.
  4. **Kick.** Add a 2 ms noise click (high-pass 2 kHz, gain 0.2).
  5. **Others.** Apply the same idea to explosion, rail and sting_rocket.
  6. **Docs.** Update GDD §13.
- **Verify:** Record with rec.mjs `--phase cues` into docs/build/qa2/fix-audio/cues, then run `node docs/build/qa2/audio/phone.cjs docs/build/qa2/fix-audio/cues`.
  - Each cue loses ≤ 8 dB.
  - Full-band peaks are no higher than before.
- **Evidence:** docs/build/qa2/audio/cues/phone-weighted.json; l1 stats
- **Data keys:** `AUDIO_CUES`, `MUSIC`, `GDD §13`

#### [AUD-12] Music mode switches wait for the next bar line (up to 2 s): level music starts late, the boss loop misses short fights, and level drums play on the title for 1.5 s after QUIT

- **Group:** audio (js/audio.js) · **Severity:** minor · **From:** audio (mode switch latency)
- **What:** Switch latency per mode:

  | Trigger | Mode reached after |
  |---|---|
  | level:start | 'level' after 1.56–1.99 s |
  | boss:fight | 'boss' after 1.89 s (the whole L1 fight lasted 3.97 s) |
  | runup | 1.18 s |
  | quitToTitle | 'menu' after 1.54 s |
- **Root cause:** `js/audio.js:1387` `_schedulerTick` switches only when `this._step % STEPS_PER_BAR === 0`, and the step counter keeps running from the previous mode. A bar is 2 s.
- **Expected:** ARCH §11: 'level' on level:start, 'boss' on boss:fight, 'menu' on the title. Each starts with its own music.
- **Fix (js/audio.js):**
  1. **Beat switch.** Switch on the next beat (`step % 4 === 0`, ≤ 0.5 s).
  2. **Restart the loop** for level:start, boss:fight and quitToTitle:
     - `_step = 0`;
     - `_nextT = now + MUSIC.startDelayS`;
     - `_applyDrone(_nextT)`.
  3. **Crossfade.** 100–150 ms on the music fade gain.
- **Verify:** Run exp.mjs (copy it; out → docs/build/qa2/fix-audio/exp-mode.json). modeLatency is ≤ 0.5 s for every switch.
- **Evidence:** docs/build/qa2/audio/exp.json (modeLatency), l1/analysis.json (modeChanges)
- **Data keys:** `MUSIC`

#### [AUD-13] The boss-death music dip ends 0.1 s before the fanfare starts, so the fanfare plays over the full-level boss loop and drone for 3.4 s

- **Group:** audio (js/audio.js) · **Severity:** minor · **From:** audio (boss-death dip)
- **What:**
  - **The dip.** At boss:dead (57.35 s) the music drops to −28 to −31.8 dBFS for 0.8 s, and is back at −23.5 to −26 by 58.2 s.
  - **The fanfare.** It starts at 58.25 s (900 ms delay), exactly when the duck releases (`MUSIC.duck.bossDead` [−6, 0.8], data.js:1020).
  - **The loop.** The boss loop then plays at full level until level:complete → `setMusic('none')` at 60.77 s.
- **Root cause:** The boss-death duck lasts 0.8 s, shorter than the 0.9 s roar-to-fanfare delay plus the fanfare itself. Music stops only at level:complete.
- **Expected:** GDD §13: music ducks during the boss death. J16: the roar, then the fanfare, over a dipped bed. ARCH: 'none' after the fanfare.
- **Fix (data + js/audio.js):** Either:
  - `MUSIC.duck.bossDead` → [−9, 2.0], covering roar plus fanfare (≥ 0.9 + 0.77 + 0.3 s); or
  - `setMusic('none')` with a 400 ms fade at boss:dead.
- **Verify:**
  1. Run rec.mjs `--phase l1` (docs/build/qa2/fix-audio/l1-dip).
  2. Music-tap RMS in [boss:dead + 0.9, + 1.7] s is ≥ 8 dB below the pre-death level.
- **Evidence:** docs/build/qa2/audio/l1 stats (music tap); boss run
- **Data keys:** `MUSIC`

#### [CORE-7] Pausing (app switch or the pause button) burns the theatre timers and the slow-mo countdown (engine clock)

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** minor · **From:** mobile (pause theatre); edge-cases (pause theatre)
- **What:**
  - **Pause during the boss intro.** On RESUME the intro is over: 0.69 s of 2.4 s was seen.
  - **Pause or hide during the boss death.** Results appear 20–300 ms after RESUME: the 1.8 s collapse and the coin fountain ran during the pause.
  - **Also affected:** the game-over theatre, the 2.5 s hint and the name card.
- **Root cause:**
  - Theatre deadlines are absolute times on `ctx.time.now`, which advances while paused (ARCH §2.2).
  - The engine's slow-mo countdown (`js/engine.js:1129-1135`, `beginFrame`) also runs on unscaled time during a pause.
- **Expected:**
  - ARCH §2.2: theatre timers are real time so they span slow-mo, not so they run through a pause.
  - GDD §14: pause freezes play, and resume continues where the player left off.
- **Fix (js/engine.js):**
  1. **New clock.** Add `ctx.time.theatre` (ms). `beginFrame` advances it by the clamped real interval only while the state is not 'paused' (and not while the context is lost). Expose it from `Engine.init`.
  2. **Slow-mo.** Stop the `slowmoLeft` countdown while paused.
  3. **Docs.** Document in ARCH §2.2 ("theatre timers use time.theatre") and amend the GDD §2 time-scale row.
- **Interface:** The owners switch their deadlines: ENE-17 (boss), LVL-29 (results delay), VIS-18 (dolly and game-over camera), UI-28 (name card and hint). Each falls back to `time.now` while `theatre` is undefined.
- **Verify:** After all parts land, run the visboss.mjs and t2-boss.mjs copies (docs/build/qa2/fix-core/…).
  - Case A: the intro resumes with about 1.7 s left.
  - Cases B and F: results appear about 1.6 s after RESUME, the remaining theatre.
  - Slow-mo resumes at 0.25 after RESUME.
- **Evidence:** docs/build/qa2/mobile/visboss/iphone14/visboss.json; docs/build/qa2/edge-cases/t2-boss/report.json
- **Data keys:** `GDD §2 (time row)`, `ARCH §2.2`

#### [CORE-8] Landscape steering: the squad moves only 0.22 px per finger px (0.59–0.73 in portrait), so it lags far behind the finger

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** minor · **From:** mobile (landscape steering)
- **What:**
  - **Ratio by device:**

    | Device | Squad px per finger px |
    |---|---|
    | iPhone 14 portrait | about 1:1 |
    | 360×740 | 0.59 |
    | 412×915 | 0.68 |
    | iPad | 0.73 |
    | landscape 844×390 | 0.22 |

  - **Landscape crossing.** Crossing the ±2.1 m range takes 275 finger px, while the squad moves only about 60 screen px.
  - **Formula is correct.** It is implemented exactly as written: k = 8 / (0.62·W).
- **Root cause:** `js/engine.js:1461` `getSteerK` uses the viewport width. The landscape camera shows the road at the squad only about 228 px wide on an 844 px screen.
- **Expected:** GDD §3.2's intent: the relative drag tracks the squad proportionally in every supported orientation.
- **Fix (js/engine.js + SQUAD.steer):**
  1. In landscape (aspect ≥ `WORLD.camera.portraitBelow`), use W_eff = min(W, `SQUAD.steer.landscapeWidthFactor` · H) in k = 8 / (0.62·W_eff), with the factor new and about 1.35.
  2. Tune it so 844×390 lands at a ratio of 0.6–0.75.
  3. Amend GDD §3.2.
- **Verify:**
  1. Copy docs/build/qa2/mobile/{lib.mjs,fingerratio.mjs} into docs/build/qa2/fix-core/.
  2. The landscape ratio is 0.6–0.75, and the portrait values are unchanged.
- **Evidence:** docs/build/qa2/mobile/fingerratio/fingerratio.json, touch/all.json
- **Data keys:** `SQUAD.steer.landscapeWidthFactor (new)`, `GDD §3.2`

#### [CORE-9] The boot bar's weights and captions don't follow the work, and the warm-up freezes the bar (main part)

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** minor · **From:** perf-throttled (boot bar)
- **What:**
  - **At 4×.** The bar races from 50 % to 88 %, then crawls through the last 12–20 % for 1.7–2.8 s, with one frozen frame of 0.5–1.24 s at about 97 %.
  - **Measured split vs. the bar's weights:**

    | Phase | Share of boot time | Bar range in PROGRESS (main.js:34) |
    |---|---|---|
    | Texture build | about 20 % | render 6–70 % |
    | Warm-up | about 45 % | 95–99 % |
- **Root cause:**
  - The `PROGRESS` weights at `js/main.js:34`.
  - `compileAsync` and the warm-up draw run back to back without a yield.
  - Captions come from the fraction (UI-29).
- **Expected:** Round-1 CORE-1 intent: the bar reflects the work and never freezes. GDD §14 Boot row.
- **Fix (js/main.js):**
  1. Re-weight `PROGRESS` from the measured split (textures about 20 %, models and systems about 15 %, warm-up about 45 %).
  2. Yield a frame between `compileAsync` resolving and the warm-up draw.
  3. Pass a progress callback to `render.warmup` (VIS-17) and map it onto the warm-up range.
  4. Call `ui.setBootCaption(step)` (UI-29) at each step.
  5. Await `ui.prewarm()` (UI-19) before `hideBoot`.
- **Interface:** VIS-17, UI-19, UI-29.
- **Verify:**
  1. Run `node docs/build/qa2/perf-throttled/throttle.mjs --rate 4 --level 1 --quality med --seconds 10 --out docs/build/qa2/fix-core/boot4`.
     - boot.detail shows no painted gap over 300 ms.
     - The bar advances in ≥ 8 visible steps.
  2. Unthrottled boot is no longer than before + 50 ms (excluding UI-19's prewarm frames).
- **Evidence:** docs/build/qa2/perf-throttled/q4-* / q6-* perf.json (boot.detail), bootprof-r1/boot.cpuprofile
- **Data keys:** none

### Polish (24)

#### [VIS-19] At 200 visible soldiers the rear rows' feet run 55 css px past the bottom of the screen

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** polish · **From:** visual-2 (200-soldier framing)
- **What:** L1 High probe:

  | Visible soldiers | Max feet y (css px) | Notes |
  |---|---|---|
  | 60 | 760 | |
  | 120 | 797 | |
  | 200 | 899 (> 844) | 12 of 200 feet off-screen; camera z stops at 14.13; squadDepth 6.47 m |

  This triage's l1/12-play-45s.png shows the formation running under the debug panel.
- **Root cause:** `WORLD.camera.countDolly` (js/data.js:93, { ref 40, z 0.4, y 0.1, maxS 8 }) saturates before V = 200.
- **Expected:** The round-1 VIS-3 framing constraint (GDD §2) keeps the whole formation on screen.
- **Fix (js/render.js + WORLD.camera.countDolly):**
  1. Extend the dolly so that at squadDepth ≥ 6 m the camera backs off about 1 m more in z and rises about 0.5 m (raise `maxS` and the coefficients).
  2. Keep the 8 m road framing and the gate pixel sizes as close to the GDD as possible.
- **Interface:** UI-18's bottom hint may cover the rear rows; the lead accepted this.
- **Verify:**
  1. Run the visual-2 probe with m_frame.js (copy; out → docs/build/qa2/fix-visual/frame).
  2. `feetOutPct` = 0 at V = 200 and at V = 340.
  3. Gate glyph height at z −36 is within 10 % of before.
- **Evidence:** docs/build/qa2/visual-2/shots/l1c_26-play-51s.png, l5boss_02-play-3s.png; docs/build/qa2/triage/l1/12-play-45s.png
- **Data keys:** `WORLD.camera.countDolly`

#### [VIS-20] Landscape phone title: the marching squad hides behind PLAY and its caption (round-1 VIS-3(c) only fixed portrait)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** polish · **From:** carryover-check (landscape title)
- **What:** On 844×390 the squad projects at sy 282 (feet), 242 (1 m) and 191 (2.2 m). The title buttons sit right over it:

  | Element | Screen y (css px) |
  |---|---|
  | btn-play | 211–265 |
  | caption | 274–290 |
  | SHOP / LEVELS | 301–349 |

  Only a sliver of the squad shows.
- **Root cause:** `WORLD.camera.title` (js/data.js:96) has no landscape variant.
- **Expected:** GDD §14 Title: "3D scene idles behind (squad marching …)" on every supported aspect.
- **Fix (js/render.js + WORLD.camera.titleLandscape (new)):** Use a landscape title camera and look-at so the squad projects above btn-play (sy < 200 on 844×390), or beside the centred button column.
- **Verify:**
  1. Run `node docs/build/qa/ui-shells/probe.mjs landscape --out docs/build/qa2/fix-visual/probe-landscape`.
  2. `squadScreenPhoneLand` feet sy < 200, or x outside the button column.
  3. The title screenshot shows the squad.
- **Evidence:** docs/build/qa2/carryover-check/ev/probe-wide.json, probe-landscape.json, landscape-title-844x390.png
- **Data keys:** `WORLD.camera.title`, `WORLD.camera.titleLandscape (new)`

#### [VIS-21] A WebGL context restore floods the console with 118 INVALID_OPERATION warnings

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** polish · **From:** edge-cases (context restore warnings)
- **What:**
  - **Test.** t16-gfx loses and restores the context twice.
  - **Warnings.** "delete: object does not belong to this context" ×100, and "deleteVertexArray: object does not belong to this context" ×18.
  - **Gameplay recovers:** programs are back to 53 and there are no page errors.
- **Root cause:** `engine._contextRestoredHandler` → `render.rebuild()` (`js/render.js:2188-2205`). It calls `renderer.setSize` and `composer.setSize`, which dispose render targets and VAOs that belong to the lost context.
- **Expected:** The round-1 rule that runs stay console-clean; ARCH §9.5 restore path.
- **Fix (js/render.js):**
  1. In `rebuild()`, skip `renderer.setSize` and `composer.setSize` when the size and DPR are unchanged.
  2. Drop references to the lost context's GL resources without calling `dispose`; re-create the composer render targets instead.
- **Verify:**
  1. Copy docs/build/qa2/edge-cases/{lib.mjs,t16-gfx.mjs} into docs/build/qa2/fix-visual/.
  2. consoleWarnings is empty, and gameplay still recovers.
- **Evidence:** docs/build/qa2/edge-cases/t16-gfx/report.json
- **Data keys:** none

#### [VIS-22] Raising the tier after a Low boot links charDepth.walker on the first shadow frame (about 37 ms)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** polish · **From:** lead seed #4 (j)
- **What:** A session that boots on Low and is then raised (by the auto-scaler or in Settings) links the characters' custom depth program on the first shadow frame.
- **Root cause:**
  - On Low, `render.warmup` never compiles the shadow-depth variants, because shadows are off.
  - The tier commit (`_requestTier`, render.js ≈:1200) compiles the main-pass programs for the target state.
  - The depth variants compile only during the first shadow render after the commit.
- **Expected:** GDD §16 and round-1 VIS-1 / VIS-2: no program links mid-play.
- **Fix (js/render.js):**
  1. When the target tier enables shadows, before committing, render one hidden shadow pass into the warm-up target, using the target shadow state with every caster visible.
  2. Alternatively, compile the depth materials through a temporary scene with KHR_parallel_shader_compile.
  3. Commit after it resolves.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 9 --quality low --seconds 40 --pre "$(cat docs/build/qa2/carryover-check/progprobe.js)" --after "setTimeout(()=>g.engine.setQuality('med'), 5000)" --out docs/build/qa2/fix-visual/raise-low`.
  2. Once the switch commits, progprobe logs no new program names, and no frame is over 50 ms.
- **Evidence:** docs/build/round1-crossgroup.txt (visual: "charDepth.walker still links on the first shadow frame (about 37 ms)")
- **Data keys:** none

#### [VIS-23] Round-1 doc amendments in visual-owned sections, and two DATA-MISSING literals from round-1 fixes

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** polish · **From:** carryover-check (GDD amendments, data hygiene)
- **What:**
  - **Missing doc rules.** GDD §2 still lacks the round-1 VIS-3 framing rules: the framing constraint, the count-driven dolly, the 42° landscape vFOV floor, and the title camera.
  - **DATA-MISSING literals left by round-1 fixes:**
    - the manhole literal in `js/environment.js:125` (VIS-11);
    - the `BADGE_LIFT_M` fallback in `js/materials.js:94`, which reads `GATE_RULES.glyph.badgeLift`.
- **Root cause:** The round-1 doc amendments had no owner group, and the round-1 fixers could not edit the data keys they needed.
- **Expected:** GDD is authoritative; ARCH §1 / §14 rule 10: tuning lives in data.js, one key per tunable.
- **Fix:**
  1. Amend the GDD §2 camera rows, tagged "(round-1 QA VIS-3)".
  2. Move the manhole literal to `RENDER.env.manhole` (new).
  3. Delete the `BADGE_LIFT_M` fallback; `GATE_RULES.glyph.badgeLift` always exists.
- **Verify:**
  1. `grep -n DATA-MISSING js/environment.js js/materials.js`: the two tags are gone.
  2. Smoke `--scenario all` is CLEAN.
  3. The road and the MAX badge look unchanged in screenshots.
- **Evidence:** carryover-check data-hygiene issue (js/environment.js:125, js/materials.js:94); docs/build/QA-ROUND1.md amendments (VIS-3)
- **Data keys:** `GDD §2 (camera rows)`, `RENDER.env.manhole (new)`

#### [GAT-10] Crates turn into a solid white cube while being shot

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** polish · **From:** visual-2 (crate whiteout)
- **What:** In l1-crate19 the crate measures #F0EAE6 (luma 235) with a bloom halo. Its seams and item colours are gone.
- **Root cause:**
  - `js/pickups.js:151` `totalEmissiveRadiance += vec3(vFlash)` adds +1.0 white for `CRATE_HIT_FLASH` 0.08 s (pickups.js:39, a DATA-MISSING literal) on every hit.
  - There is no retrigger limit (`_chitTime`, :453).
- **Expected:** Round-1 GAT-1 / ENE-3 rule: blinks are tinted, rate-limited, and keep the seam colour.
- **Fix (js/pickups.js + PICKUPS.crate):**
  1. Flash = `uSeamColor · vFlash · PICKUPS.crate.hitFlashGain` (new, 0.35).
  2. Update `_chitTime` at most every `PICKUPS.crate.hitFlashRetrigger` (new, 0.15 s).
  3. Move `CRATE_HIT_FLASH` to `PICKUPS.crate.hitFlash` (new).
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 1 --seconds 25 --shots 1 --out docs/build/qa2/fix-gates/crate`.
  2. Crate frames under fire keep the seam hue (luma < 200).
- **Evidence:** docs/build/qa2/visual-2/shots/l1c_10-play-19s.png, crops/l1-crate19.png
- **Data keys:** `PICKUPS.crate.hitFlash (new)`, `PICKUPS.crate.hitFlashGain (new)`, `PICKUPS.crate.hitFlashRetrigger (new)`

#### [FX-13] The sniper's red beam starts about 0.9 m below his muzzle

- **Group:** fx (js/fx.js) · **Severity:** polish · **From:** lead seed #4 (k)
- **What:** Round-1 carry-over (k): the beam visibly leaves from below the sniper's rifle.
- **Root cause:**
  - `js/fx.js:2599` computes the beam start as `TROOPS.sniper.crateH + FIRE.muzzleOffset[1]`, ignoring the troop scale (1.4) and the pose.
  - `troop:fire` carries only x and z.
- **Expected:** GDD §8.3 "long red tracer" from the sniper's rifle.
- **Fix (js/fx.js):** Use `p.y` from `troop:fire` when present (CHR-14); otherwise keep the current formula.
- **Interface:** CHR-14 adds `y` to the payload.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 5 --seconds 30 --shots 1 --after "g.troops.add('troop.sniper')" --out docs/build/qa2/fix-fx/sniper`.
  2. The beam starts at the rifle muzzle in the shots.
- **Evidence:** docs/build/round1-crossgroup.txt (carry-over list in lead seed #4)
- **Data keys:** none

#### [CHR-14] troop:fire carries no y, so the sniper beam can't start at the muzzle; the ARCH squad / troop contract lines are stale

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** polish · **From:** lead seed #4 (k); carryover-check (ARCH amendments)
- **What:**
  - **Payload.** The `troop:fire` payload has x, z, tx and tz but no height (`js/troops.js` ≈:711-713).
  - **Stale ARCH §6.5.** It still says squad listens to nothing, and it uses the old troop child names.
- **Root cause:** The round-1 sniper and drone changes did not extend the event payload, and the round-1 ARCH notes had no owner group.
- **Expected:** ARCH matches the shipped contracts (ARCH §5.1, §6.5).
- **Fix (js/troops.js + docs):**
  1. Add `y` (the muzzle world y, V_B.y) to the `troop:fire` payload for the sniper and the drone.
  2. Document it in ARCH §5.1.
  3. Apply the round-1 ARCH §6.5 note: squad listens to gear:start, gear:end, armor:change and level:start; the troop child names are APC 'wheels' and drone 'discs'.
- **Interface:** FX-13 reads `p.y`.
- **Verify:**
  1. Run `node tools/callsites.js`.
  2. `node tools/smoke.js --scenario all --out docs/build/qa2/fix-characters/all` is CLEAN.
- **Evidence:** docs/build/round1-crossgroup.txt (characters doc notes)
- **Data keys:** `ARCH §5.1`, `ARCH §6.5`

#### [ENE-18] The boss core point light over-lights its own torso

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** polish · **From:** lead seed #4 (f)
- **What:** `BOSSES.anim.lightIntensity` 40, placed at the core, paints the torso panels around the core orange-red. See the Colossus in l15boss_06 and the Queen's upper torso in queen13.
- **Root cause:** `js/boss.js:1624-1633` `_renderLight` places the light at the core's world position, which is on the torso surface.
- **Expected:** GDD §15 lighting: at most 2 point lights (boss core, laser). The core lights the scene around the boss, not the boss's own torso.
- **Fix (js/boss.js + BOSSES.anim):**
  1. Place the light `BOSSES.anim.lightOffsetZ` (new, about 1.5 m) in front of the core, toward the squad.
  2. Lower `BOSSES.anim.lightIntensity` to about 20, so it lights the road and squad rather than the torso.
- **Verify:**
  1. Take L15 and L5 boss screenshots (docs/build/qa2/fix-enemies/light).
  2. Torso pixels within 1 m of the core keep the body hue.
  3. The road in front of the boss picks up the warm light.
- **Evidence:** docs/build/qa2/visual-2/shots/l15boss_06-play-16s.png, crops/queen13.png; docs/build/round1-crossgroup.txt (characters: boss core light)
- **Data keys:** `BOSSES.anim.lightIntensity`, `BOSSES.anim.lightOffsetZ (new)`

#### [ENE-19] Data hygiene: boss.js literals added by round-1 fixes, and the duplicate ZOMBIES.common.introAheadM

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** polish · **From:** carryover-check (data hygiene)
- **What:**
  - **Literals.** `js/boss.js:53-57` holds `RETREAT_SPEED`, `GAIT_REF_MS`, `PHASE_ENTRY_COOL`, `TARGET_Z` (−1.0, from ENE-5) and `INTRO_SPARK_EVERY` (from ENE-1) as DATA-MISSING literals.
  - **Dead key.** `ZOMBIES.common.introAheadM` (js/data.js:303) is never read; levelgen reads `LEVELS.curve.introAheadM`.
- **Root cause:** The round-1 fixers could not add keys outside their key list, so they left literals. LVL-12 added the curve key without removing the old one.
- **Expected:** ARCH §1 / §14 rule 10: tuning lives in data.js, with one key per tunable.
- **Fix:**
  1. Move the five literals into `BOSSES.retreatSpeed`, `gaitRefMs`, `phaseEntryCool`, `targetZ` and `introSparkEvery` (all new).
  2. Delete `ZOMBIES.common.introAheadM`.
- **Verify:**
  1. `grep -n DATA-MISSING js/boss.js`: those five are gone.
  2. `node tools/check-imports.js` passes.
  3. Smoke `--scenario all` is CLEAN.
  4. A boss run is unchanged.
- **Evidence:** carryover-check data-hygiene issue (js/boss.js:53-57, js/data.js:303)
- **Data keys:** `BOSSES.retreatSpeed (new)`, `BOSSES.gaitRefMs (new)`, `BOSSES.phaseEntryCool (new)`, `BOSSES.targetZ (new)`, `BOSSES.introSparkEvery (new)`, `ZOMBIES.common.introAheadM`

#### [WPN-10] Round-1 doc amendments in weapons-owned sections, and one hand-mirrored colour index

- **Group:** weapons (js/weapons.js) · **Severity:** polish · **From:** carryover-check (GDD / ARCH amendments, data hygiene)
- **What:**
  - **GDD §15 tracer table.** It still lists rifle (3.0, 2.6, 1.6), minigun (3.5, 3.5, 2.5) and laser (4.0, 1.0, 3.6) magenta. The code uses a warm rifle, a yellow minigun and a cyan laser.
  - **ARCH.**
    - Line 511 (§6.8 boss.damage weight comment): heavy-weapon shield weights are listed unweighted; WPN-4 made them ×w.
    - Line 844: laser tracer magenta, gateHits 8 / 10; should be 8·w / 10·w.
    - §6.11: muzzle flash 60 ms; WPN-6 made it 33 ms.
  - **Colour index.** `js/weapons.js:77` `ROCKET_SMOKE_COLOR_IDX = 8` mirrors `FX_COLOR.dust` by hand.
- **Root cause:** The round-1 doc amendments had no owner group. The smoke colour index had no data key.
- **Expected:** GDD / ARCH match the shipped weapons. Data is not mirrored by hand.
- **Fix:**
  1. Amend the GDD §15 Tracers row, the ARCH §6.8 boss.damage weight comment, ARCH §6.11 and ARCH §8.4 from data.js `PALETTE.tracer` / `WEAPONS`, tagged with the round-1 QA ids. The ARCH §7 lines come with WPN-8.
  2. Add `WEAPONS.rocket.smoke.colorIdx` (new) and read it.
- **Verify:**
  1. Grep the docs for 'magenta' and '(4.0, 1.0, 3.6)'. Neither remains.
  2. The L9 rocket smoke is unchanged.
- **Evidence:** docs/build/QA-ROUND1.md amendments; carryover-check docs and data-hygiene issues
- **Data keys:** `GDD §15 (Tracers row)`, `ARCH §6.8 (damage weight comment)`, `ARCH §6.11`, `ARCH §8.4`, `WEAPONS.rocket.smoke.colorIdx (new)`

#### [LVL-30] Every level opens the same way: '+4 | +3' is the first gate on 13 of 19 generated levels, and '÷3 | −N' is second on L8 and L10–L16

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** polish · **From:** feel-balance (same opener)
- **What:**
  - **First event.** On L2, L3, L4, L5, L7, L8, L9, L11, L14, L15, L16 and L17 it is '+4 (cap 16) | +3 (cap 12)'.
  - **Second event.** On L8 and L10–L15 it is the lesser-evil '÷3 | −N'.
  - **In play.** The first 15–20 s of most mid-campaign levels is the same "shoot +4, then lose a few" sequence.
- **Root cause:** `js/levelgen.js:903-907` forces the opener to plusPlus or plusMult, sized from E_start 5–10, where GEN.minValue 3 and rounding collapse the values to 4 and 3. The second slot draws mostly minusDiv.
- **Expected:** GDD §4.4: a varied pattern bag. GDD §1: a welcoming opener, but each level reads differently.
- **Fix (js/levelgen.js):**
  1. Size the opener from `LEVELS.curve.s0Assumed`, or draw it from `GATE_RULES.generation.opener` (new): +A|xM 50 %, +A|+B 30 %, item|+A 20 %.
  2. Forbid identical opener values on consecutive levels.
  3. Draw the second slot from the full bag.
- **Verify:** Run `node tools/validate-levels.js > docs/build/qa2/fix-level/validate-opener.txt`.
  - No opener repeats on consecutive levels.
  - ≤ 30 % of levels share an opener.
- **Evidence:** docs/build/qa2/feel-balance/validate.txt
- **Data keys:** `GATE_RULES.generation.opener (new)`

#### [LVL-31] The gate rhythm is 8–10.7 s, not the GDD's 12–15 s loop (the GDD contradicts itself above L1)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** polish · **From:** feel-balance (gate rhythm)
- **What:**
  - **Measured.** Median gaps between gate passes run from 9.4 s (L2) down to 8.8 s (L12), with a minimum of 7.8 s. Only the authored L1 hits 12–13 s.
  - **Why.** G = round(Len/100) at v 8.2–10.2 m/s gives about 85–90 m per loop.
  - **GDD conflict.** GDD §1 also says "per 100 m of road", which is 12.5 s only at 8 m/s.
- **Root cause:** The two GDD rules (loop period and gates per 100 m) only agree at 8 m/s. Generated levels follow the per-100 m rule.
- **Expected:** One consistent rule, reported per level.
- **Fix (docs/GDD.md + tools/validate-levels.js):**
  1. Amend the GDD §1 'Loop period' to "12–13 s on L1, 9–11 s on generated levels (one gate per about 100 m of road)".
  2. Have validate-levels report the gate period per level.
  3. Changing G(L) is rejected; see Rejected.
- **Verify:** validate-levels output has a gate-period column showing 9–11 s for L2–L30.
- **Evidence:** docs/build/qa2/feel-balance/camp-strong (ana.json passGaps), ana-strong.txt
- **Data keys:** `GDD §1`

#### [LVL-32] The HUD distance keeps counting after the squad dies (the HUD reads 42 m behind a results card that says 36 m)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** polish · **From:** carryover-check (endless HUD distance); lead seed #4 (d)
- **What:** In endless-die-result.png the HUD label reads '42 m' while the card says 'Distance 36 m'.
- **Root cause:** `js/level.js` `_emitProgress` (:731-747) keeps emitting `w.distance` during the death run-on. The round-1 LVL-10 results already use `_deathDistance`.
- **Expected:** GDD §10.1 / §14: one distance, the one where the squad was lost.
- **Fix (js/level.js):** After `squad:dead` (phase 'lost'), emit `level:progress` with `_deathDistance`, both for the campaign fraction and for endless metres.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --endless --nobot --seconds 25 --pre "g.save.data.highestUnlocked=11" --after "setTimeout(()=>g.squad.setCount(0,'debug'),4000)" --out docs/build/qa2/fix-level/endless-die`.
  2. The HUD metres equal the results distance.
- **Evidence:** docs/build/qa2/carryover-check/ev/endless-die-result.png, endless-die.report.json
- **Data keys:** none

#### [LVL-33] Tutorial copy names the wrong multiplier and prints 'X2' instead of '×2'

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** polish · **From:** visual-2 (stale hint copy)
- **What:**
  - **Wrong multiplier.** In l1c_10 the squad passed the gate as ×4 ('92 ×4'), but the hint reads 'X2 DOUBLES YOUR SQUAD'.
  - **Wrong glyph.** Uppercase turns 'x2' into the letter 'X2', while the gates show '×'.
- **Root cause:** `js/level.js:1246-1247` fires `HINTS.x2` on any pass through that lane. `HINTS.x2` and `HINTS.tryx2` (js/data.js) are fixed strings with 'x'.
- **Expected:** GDD §1.1 / §4.1: hints describe what just happened and use the gates' operator glyph.
- **Fix (js/level.js + HINTS):**
  1. `HINTS.x2` becomes n => `×${n} MULTIPLIES YOUR SQUAD`, called with the pass's effective multiplier (`gate.mult`).
  2. `HINTS.tryx2` becomes 'TRY THE ×2 NEXT TIME' (U+00D7).
  3. `level.showHint` accepts template hints: `text = typeof HINTS[id] === 'function' ? HINTS[id](arg) : HINTS[id]`.
  4. Update the GDD §1.1 hint text. The text-wrap balance part is in UI-18.
- **Verify:**
  1. Run `node tools/smoke.js --scenario play --level 1 --seconds 25 --shots 1 --out docs/build/qa2/fix-level/copy`.
  2. The hint after the ×4 pass reads '×4 MULTIPLIES YOUR SQUAD'.
- **Evidence:** docs/build/qa2/visual-2/shots/l1c_10-play-19s.png
- **Data keys:** `HINTS.x2`, `HINTS.tryx2`, `GDD §1`

#### [LVL-34] validate-levels flags GDD-authored L1 content (8 false warnings)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** polish · **From:** carryover-check (QA tooling noise)
- **What:**
  - **Rule warnings.** '+2 below minValue 3' and 'runner unlocks at L2' contradict GDD §11 (R +2; 2 runners at 110 m).
  - **Leak warnings.** The validator's cautious line (5 → 16 at gate 1) disagrees with GDD §11's expected samples (5 → 25), which produces the 42 % / 41 % / 0 % leak warnings.
- **Root cause:** tools/validate-levels.js applies generator rules to authored events and recomputes L1's cautious line instead of using the script's expected samples.
- **Expected:** QA tools report real defects only.
- **Fix (tools/validate-levels.js):**
  1. Skip the unlock and minValue checks for authored events.
  2. Use the script's `expected[]` samples as L1's cautious line.
- **Verify:** The validate-levels L1 block has no warnings that contradict GDD §11.
- **Evidence:** docs/build/qa2/carryover-check/validate.txt (L1 block)
- **Data keys:** none

#### [LVL-35] Data hygiene: levelgen literals added by round-1 fixes

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** polish · **From:** carryover-check (data hygiene)
- **What:** `INTRO_SEARCH_M`, `INTRO_SHIFT_STEP_M` and `INTRO_SHIFT_MAX_M` (`js/levelgen.js` ≈:107-109, from LVL-12) and `GREEDY_PROFILES` (from LVL-1) are DATA-MISSING literals.
- **Root cause:** The round-1 fixers could not add keys outside their key list.
- **Expected:** ARCH §14 rule 10: tuning lives in data.js.
- **Fix:**
  1. Move the three intro literals to `LEVELS.curve.introSearchM`, `introShiftStepM` and `introShiftMaxM` (new).
  2. Move `GREEDY_PROFILES` to `GATE_RULES.generation.greedyProfiles` (new).
- **Verify:**
  1. The validate-levels output is identical before and after (diff).
  2. Those tags are gone from `grep -n DATA-MISSING js/levelgen.js`.
- **Evidence:** carryover-check data-hygiene issue (js/levelgen.js ≈:107-109)
- **Data keys:** `LEVELS.curve.introSearchM (new)`, `LEVELS.curve.introShiftStepM (new)`, `LEVELS.curve.introShiftMaxM (new)`, `GATE_RULES.generation.greedyProfiles (new)`

#### [UI-30] Results screen: the four reward chips wrap 3 + 1, and the 'Boss +40' chip uses the danger-red outline

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish · **From:** visual-2 (label behind results; chip layout)
- **What:**
  - **Wrap.** On a 390 px phone the four reward chips wrap 3 + 1, and the lone chip lands over the count label (fixed separately in FX-11).
  - **Colour.** The 'Boss +40' chip uses the danger-red outline, so it reads as a penalty.
- **Root cause:** The chip row's width and gap don't fit four chips at 390 px, and the boss chip shares the danger style.
- **Expected:** GDD §9.3 / §14 results breakdown, with the reward colour (`--coin`).
- **Fix (css/game.css):**
  1. Lay the chips out 2 × 2 (`grid-template-columns: repeat(2, auto)`), or use a smaller gap so 4 fit on one row at 390 px.
  2. Give the boss chip `--coin` gold.
- **Interface:** FX-11 hides the count label on this screen.
- **Verify:** Run `node tools/smoke.js --scenario play --level 1 --seconds 75 --out docs/build/qa2/fix-ui/results`. The result screenshot shows the chips laid out cleanly.
- **Evidence:** docs/build/qa2/triage/l1/17-result.png; docs/build/qa2/visual-2/shots/l1c_34-result.png
- **Data keys:** none

#### [UI-31] The landscape LEVELS screen shows exactly 10 tiles with no partial row or scroll cue, so ENDLESS and levels 11–30 look absent

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish · **From:** mobile (landscape levels)
- **What:**
  - **Grid size.** `#level-grid` clientHeight is 237 against a scrollHeight of 693.
  - **No visible cue:**
    - the rows end 12 px above the grid bottom;
    - the 22 px mask fade (css/game.css:1172) falls in empty space;
    - scrollbars are hidden (:1169).
  - **Touch scrolling does work.**
- **Root cause:** In the landscape (max-height: 500px) block the grid height is a whole number of rows, so no partial row signals more content.
- **Expected:** A scroll container shows that it scrolls, as portrait does.
- **Fix (css/game.css):** In the landscape (max-height: 500px) block, either:
  - size the grid to 3.5 rows, so a fractional row is visible under the fade; or
  - use 5–6 columns, so ENDLESS is in the first screenful.
- **Verify:**
  1. Copy docs/build/qa2/mobile/{lib.mjs,levelscroll.mjs} into docs/build/qa2/fix-ui/.
  2. In landscape, a partial row is visible.
- **Evidence:** docs/build/qa2/mobile/levelscroll/landscape/levelscroll.json, layout/landscape/02-levels.png
- **Data keys:** none

#### [UI-32] The Haptics toggle is shown, and ON, on iPhone and iPad, where navigator.vibrate does not exist

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish · **From:** mobile (haptics on iOS)
- **What:** The settings screenshots for the iOS profiles show the Haptics toggle ON (iphone14 and landscape 03-settings.png). This was confirmed by code review, since Chrome emulation still exposes vibrate.
- **Root cause:**
  - index.html:41 always renders the row, and `js/ui.js:752` always labels it.
  - `DEFAULT_SETTINGS.haptics` is true (:283).
  - `util.hasHaptics` (js/util.js:335) exists but ui never uses it.
- **Expected:** Settings only offer controls that do something on the device (GDD §14).
- **Fix (js/ui.js):**
  1. When `!hasHaptics`, hide the row (`closest('.row').hidden = true`), or disable it with the caption 'Not supported on this device'.
  2. Leave the saved setting untouched.
- **Verify:**
  1. Copy layout.mjs into docs/build/qa2/fix-ui/.
  2. Add `page.evaluateOnNewDocument(() => { delete Navigator.prototype.vibrate; })`.
  3. The Haptics row is hidden or disabled.
- **Evidence:** docs/build/qa2/mobile/layout/iphone14/03-settings.png, layout/landscape/03-settings.png
- **Data keys:** none

#### [UI-33] Menu polish: the coin-multiplier icon reads as a 'close' ×, Settings uses three different "on" colours, RESET SAVE is as loud as BACK, and the level label is written three ways

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish · **From:** visual-2 (menu polish)
- **What:**
  - **Coin-multiplier icon.** The shop card shows a green crossed '×' at the coin's corner, which reads as delete or close.
  - **Settings on-states.** Orange for sliders, green for the toggle, blue for the segmented control.
  - **RESET SAVE.** A full-size red button flush above BACK.
  - **Level label.** Written 'LVL 1' (HUD), 'Level 1' (title) and 'LEVEL 1 CLEAR' (results).
- **Root cause:**
  - The icon is drawn at `js/ui.js:252-258`.
  - The on-colours come from three tokens (css :1508 `--primary`, :1569 `:checked` green, :1600 `--secondary`).
  - `STRINGS.hud.level` is `LVL ${n}`.
- **Expected:** GDD §14 / §15 UI tokens: one visual language across menus and HUD. Destructive actions are visually secondary.
- **Fix (js/ui.js, css/game.css + STRINGS.hud.level):**
  1. Redraw the coinMult icon as a gold coin with a '×2' badge, or stacked coins with an up arrow.
  2. Use one on-colour (`--secondary`) for the toggle and slider fill.
  3. Make RESET SAVE a text-style danger button 24 px below BACK (pairs with UI-20).
  4. Set `STRINGS.hud.level` to n => `LEVEL ${n}`, and check it fits at 390 px.
- **Verify:** The screenshots of `node tools/smoke.js --scenario ui --out docs/build/qa2/fix-ui/menus` show all four changes.
- **Evidence:** docs/build/qa2/visual-2/shots/ui_01-shop.png, ui_04-settings.png
- **Data keys:** `STRINGS.hud.level`

#### [UI-34] The ?debug=1 overlay clips its long rows at 390 px, so triangles, scale and particles are unreadable in every QA screenshot

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish · **From:** carryover-check (debug overlay clipping)
- **What:** The rows end in 'tris 2', 'scale 1.6' and 'particl' in every phone screenshot (e.g. this triage's l1/04-play-13s.png). This is a round-1 carry-over.
- **Root cause:** `#debug` doesn't wrap long rows at 390 px.
- **Expected:** ARCH §13: the overlay is readable.
- **Fix (css/game.css):** Give `#debug` `white-space: pre-wrap` and `overflow-wrap: anywhere`, keeping its max-height.
- **Verify:** Any phone smoke screenshot shows the full rows.
- **Evidence:** docs/build/qa2/triage/l1/04-play-13s.png; docs/build/round1-crossgroup.txt
- **Data keys:** none

#### [CORE-10] The 3D scene renders squashed for about 120 ms after every rotation (the canvas resizes only after the debounce)

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** polish · **From:** mobile (rotation squash)
- **What:**
  - **Distorted frames.** In rotframe, 18 frames (113–231 ms after rotating) render with canvas CSS 844×390 but a 679×1471 drawing buffer and camera.aspect 0.462: about a 4.7× horizontal stretch.
  - **No spike.** The resize itself causes no frame spike.
- **Root cause:** `js/engine.js:33` `RESIZE_DEBOUNCE_MS` 120 and `_scheduleResize` (:862-867) act on the trailing edge only.
- **Expected:** GDD §14 debounces the heavy work, but the visible frame is never distorted.
- **Fix (js/engine.js):**
  1. Leading plus trailing edge: call `_doResize()` at once on the first resize or orientation event of a burst, then again 120 ms after the last one.
  2. Move the literal to `JUICE.ui.resizeDebounceMs` (new).
- **Verify:**
  1. Copy docs/build/qa2/mobile/{lib.mjs,rotframe.mjs} into docs/build/qa2/fix-core/.
     - After the first resize event, no frame has a buffer aspect that differs from the CSS aspect.
  2. rothitch.mjs shows the worst frame unchanged.
- **Evidence:** docs/build/qa2/mobile/rotframe/rotframe.json, landscape-30ms.png; rothitch/
- **Data keys:** `JUICE.ui.resizeDebounceMs (new)`

#### [CORE-11] ?reset=1 stays in the URL, so every reload of that link wipes the save again

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** polish · **From:** edge-cases (reset param)
- **What:**
  - **Repro.** Boot with `?reset=1`: the save is wiped (coins 0). Earn 55 coins, then reload the same URL.
  - **Result.** Coins are 0 again, and `location.search` still contains reset=1.
- **Root cause:** `js/main.js:226` calls `ctx.save.reset()` whenever `config.reset` is set, and never removes the parameter.
- **Expected:** ARCH §13: `?reset=1` is a one-shot debug action.
- **Fix (js/main.js):** After the reset, call `history.replaceState` with 'reset' removed from the URL, guarded by try/catch for sandboxed and artifact shells.
- **Verify:**
  1. Copy docs/build/qa2/edge-cases/{lib.mjs,t8-meta.mjs} (the reset case) into docs/build/qa2/fix-core/.
  2. The second load keeps the coins, and `location.search` has no reset.
- **Evidence:** docs/build/qa2/edge-cases/t8-reset (run log)
- **Data keys:** none

## Rejected / deferred (11)

- **Lead seed #3 premise: "render.warmup() not implemented; shaders cause the hitches".** Stale.
  - `render.warmup()` exists (js/render.js:1669-1700), and boot and the context-restore path both await it.
  - `renderer.info.programs` stays at 53 from the title through level start, first shot, crates, troops, boss spawn and death, and results (docs/build/qa2/carryover-check/ev/prog-l1, prog-l1high, prog-l9 reports).
  - This triage's traces show the remaining hitches are DOM raster and layout, not program links.
  - The seed itself is kept, re-scoped to its real causes:
    - UI-19: DOM first raster (results, boss chrome, menus, HUD);
    - UI-21: forced layout;
    - UI-23: icon PNG encoding;
    - LVL-18: synchronous levelgen;
    - AUD-8: AudioContext construction;
    - VIS-22: tier-raise depth link.
- **Carry-over (c): "rockets mostly detonate on gate panels".** By design.
  - GDD §4.2 makes a panel a full-height wall for bullets, rockets, rail bolts and lasers.
  - GDD §8.1 credits a rocket with 8 weighted gate hits.
  - The rocket flies straight from the blob centre (js/weapons.js:1130-1150, re-aimed only at the boss), so a rocket fired down a gated lane must hit that gate. A hidden scorch is cosmetic.
- **visual-2: "the level art never changes (one dusk palette for 30 levels)".** Deferred to the design owner.
  - GDD §15 defines a single palette.
  - The gate-tint readability decisions (§0 ÷ colour, §4.1 pixel checks) were validated only against the dusk fog.
  - Night, toxic or ash districts need a design and readability pass first. This is a feature request, not a defect against the GDD.
- **feel-balance: "raise ECONOMY.gameOverKeep 0.5 → 1.0".** Rejected. It removes any cost of failing and contradicts GDD §9.1. Replaced by a fraction-based consolation and a fail-streak assist (LVL-21).
- **feel-balance: "multiply wave HP by the full shop DPS factor" and "boss hp = max(tableHp, liveDps·10 s)".** Not taken as written.
  - Full cancellation would erase the fire-rate and damage upgrades (GDD §9 progression).
  - A pure floor makes every big army tie at 10 s, contradicting the lead's "a bigger army still wins faster".
  - Replaced by damped exponents: LVL-15 `profileExp`, LVL-14 `shopScale`.
- **perf-throttled Medium headroom fixes (b) `scene.matrixWorldAutoUpdate = false` and (e) a shadow map every 2nd frame.** Rejected for round 2 as high risk. Every module relies on automatic world matrices, and a 30 Hz shadow map judders under the moving squad. The safe subset is VIS-13.
- **visual-2: "lift the count label +0.6 m when the APC is present".** Not needed. The label renders with depthTest off at renderOrder 42 (js/fx.js:830-848), so props never occlude it. The clutter is fixed at the source (CHR-9).
- **feel-balance: "compute G(L) = round(runLength / (v·12 s))".** Rejected in favour of amending GDD §1 (LVL-31). Fewer gates would shrink every generated E-curve and force a full re-balance, and the 9–11 s rhythm follows the GDD's own "one gate per 100 m".
- **feel-balance endless option: "LEVELS.endless.e cap 600 → no cap, or growth 1.06 → 1.10".** Not taken. GDD §10 / §10.1 cap E at 600 so gate values stay readable. LVL-17 makes endless bite through the live-count wave solve, the per-D band and the count-independent ramp instead.
- **carryover-check tooling parts 2–3: tools/callsites.js and members.mjs.** tools/callsites.js lists comments and locals as members and writes CALLSITES.md non-atomically. docs/build/qa/verify/tools/members.mjs reports 26 false "missing" members. No fixer group owns these files, so they move to the QA tooling follow-ups below. The validate-levels part is LVL-34.
- **Lead seed #5: "crawler-heavy waves leak 41–52 % on L5–L13" as an in-game over-leak.** This is the validator's prediction. Measured play leak is 2–3 % (feel-balance campaigns), so the defect is the leak model's calibration, handled in LVL-15, not a separate over-leak fix.

Severity notes:

- edge-cases "unbounded highestUnlocked" was lowered from major to minor (UI-24), because it needs a hand-edited or corrupted save.
- Round-1 rejections M8 / M2 (boss HP vs. squad or shop) and M6 (endless sized from the live count) are reversed with the new evidence and the lead's decision (LVL-14, LVL-17).

## GDD / ARCHITECTURE amendments by section (who writes what)

| Section | Owner group | Issues |
|---|---|---|
| GDD §0 (Boss, Economy rows) | level | LVL-14, LVL-23 |
| GDD §1 incl. §1.1 | level | LVL-22, LVL-31, LVL-33 |
| GDD §2 (camera rows) | visual | VIS-23 (round-1 VIS-3 framing, count dolly, 42° landscape floor) |
| GDD §2 (time row) | core | CORE-7 |
| GDD §3.2 | core | CORE-8 |
| GDD §4.1 | gates | GAT-7 (op glyph sizes) |
| GDD §4.2, §4.4 | level | LVL-28 (round-1 LVL-1 / LVL-2) |
| GDD §6.1 | enemies | ENE-12 |
| GDD §6.3 | level | LVL-15, LVL-28 |
| GDD §7 | level | LVL-14, LVL-28 (round-1 ENE-1 / 2 / 5 text) |
| GDD §8.3 | characters | CHR-9, CHR-12 |
| GDD §9 | level | LVL-21, LVL-23, LVL-28 (§9.2 typo) |
| GDD §10, §10.1 | level | LVL-17, LVL-21, LVL-28 |
| GDD §11 | level | LVL-22, LVL-24, LVL-25 |
| GDD §12 (J3 row) | gates | GAT-7 |
| GDD §13 | audio | AUD-4, AUD-5, AUD-9, AUD-11 |
| GDD §14 | ui | UI-18, UI-27 |
| GDD §15 (Gates row) | gates | GAT-7 |
| GDD §15 (Tracers row) | weapons | WPN-10 |
| GDD §15 (Materials paragraph) | visual | VIS-12 |
| GDD §16 (tier table) | visual | VIS-13 |
| GDD §16 (auto-scaler paragraph) | core | CORE-6 |
| ARCH §2.2 | core | CORE-7 |
| ARCH §5.1, §6.5 | characters | CHR-14 |
| ARCH §6.2 | core | CORE-6 |
| ARCH §6.3 | visual | VIS-14 |
| ARCH §6.8 (boss.damage weight comment), §6.11, §8.4 | weapons | WPN-10 |
| ARCH §7 | weapons | WPN-8 |
| ARCH §6.16 | level | LVL-24 |
| ARCH §10.3 | ui | UI-25 |

## QA tooling follow-ups (QA lead, not fixer groups)

- **tools/callsites.js:**
  - strip comments before matching;
  - ignore numeric `.toFixed` and DOM-local names;
  - write CALLSITES.md.tmp and then rename it (it left a 0-byte file on ENOSPC).

  Fix docs/build/qa/verify/tools/members.mjs the same way.
- **tools/smoke.js:** the screenshot-stall exclusion also hides the results-screen hitch (285 ms in this triage's trace).
  - Record the frames around state changes (level start, boss:spawn, complete) in their own `transitions[]` list.
  - Never schedule a screenshot within 1 s after a state change.
- **tools/build-artifact.js:** carry index.html's modulepreload links (UI-29) into artifact.html if the artifact inlines modules differently. Regenerate artifact.html at integration.
- **Round 3:** re-run the following with fresh output folders:
  - feel-balance campaigns (strong / passive / bad, endless, bruteprobe, hintprobe);
  - audio rec / analyze (l1, boss, stack, cues, exp);
  - the perf-throttled matrix (q4 / q6, auto with the Adreno spoof);
  - the mobile scripts (secondtap, fingerratio, visboss, bossframe, layout);
  - the edge-cases scripts.

## Raw report → triage mapping

| Tester | Raw issue | Triage |
|---|---|---|
| lead | Hint pills on the horizon cover the gates | UI-18 (+ LVL-25 boss-hint timing) |
| lead | Boss fights collapse to 3–4 s far above the curve | LVL-14 |
| lead | Warm-up missing; first-appearance hitches | UI-19, UI-21, UI-23, LVL-18, AUD-8, VIS-22 (premise rejected) |
| lead | Carry-over (a) contact zombies before the boss | WPN-7 (+ ENE-12) |
| lead | Carry-over (b) L4 squad fired 0 bullets | WPN-7 (hardening + soak) |
| lead | Carry-over (c) rockets detonate on gates | rejected (by design) |
| lead | Carry-over (d) HUD distance after death | LVL-32 |
| lead | Carry-over (e) boss draw calls 54 | CHR-11 |
| lead | Carry-over (f) boss core light over-lights torso | ENE-18 |
| lead | Carry-over (g) count label under beams / flashes | FX-10 |
| lead | Carry-over (h) gate glyphs bloom on High | GAT-7, VIS-12 |
| lead | Carry-over (i) gates.render alloc, boss glob ranges, hitTestSeg boxing | GAT-9, ENE-16, WPN-8 |
| lead | Carry-over (j) Low → raised links charDepth.walker | VIS-22 |
| lead | Carry-over (k) sniper beam below the muzzle | FX-13, CHR-14 |
| lead | Carry-over (l) Queen hit blink pale frame | ENE-14 (check) |
| lead | Balance carry-overs (brute, flamer, crawler leak, weak line, x3 step, L2 greedy) | ENE-12, CHR-12, LVL-15, LVL-27 |
| feel-balance | Brute latches inside the formation | ENE-12 (+ WPN-7) |
| feel-balance | Waves almost never cost soldiers | LVL-15 |
| feel-balance | Boss TTK collapses with shop multipliers | LVL-14 |
| feel-balance | Gate events never alternate sides | LVL-16 |
| feel-balance | Endless never ends | LVL-17 |
| feel-balance | Cannot buy past a wall | LVL-21 (gameOverKeep 1.0 rejected) |
| feel-balance | Stars barely depend on skill | LVL-22 |
| feel-balance | Coin income ignores play quality | LVL-23 |
| feel-balance | 'GRAB THE CRATE' never shown | LVL-24, UI-25 |
| feel-balance | Every level opens '+4 \| +3' | LVL-30 |
| feel-balance | Gate rhythm 8–10.7 s | LVL-31 (G(L) change rejected) |
| audio | Fanfare 617 cents flat | AUD-4 |
| audio | Master bus clips (knee 30) | AUD-5 |
| audio | Same-frame identical cues stack | AUD-6 |
| audio | Roar 14–20 dB too loud | AUD-7 |
| audio | Shotgun sting / flip nearly silent | AUD-9 |
| audio | Gate-pass reward under the gunfire | AUD-10 |
| audio | Sub-bass cues inaudible on phones | AUD-11 |
| audio | Music mode switch waits a bar | AUD-12 |
| audio | Boss-death dip ends before the fanfare | AUD-13 |
| mobile | Second finger kills steering | CORE-5 |
| mobile | Landscape steering ratio 0.22 | CORE-8 |
| mobile | Pause doesn't freeze theatre timers | CORE-7, ENE-17, LVL-29, VIS-18, UI-28 |
| mobile | Landscape boss bar over the boss's head | UI-26 |
| mobile | Text under 12 px | UI-27 |
| mobile | Scene squashed 120 ms after rotation | CORE-10 |
| mobile | Landscape LEVELS shows 10 tiles | UI-31 |
| mobile | Haptics toggle on iOS | UI-32 |
| perf-throttled | Scaler chases 90 / 120 Hz | CORE-6 |
| perf-throttled | generateLevel freezes PLAY / NEXT / RETRY | LVL-18 |
| perf-throttled | Medium has no CPU headroom | VIS-13 (parts (b), (e) rejected) |
| perf-throttled | Forced synchronous layout | UI-21 (+ UI-18 hint measurement) |
| perf-throttled | HUD transitions layout / paint every frame | UI-22 |
| perf-throttled | Shadow-pass depth program churn | VIS-14, ENE-15, GAT-8 |
| perf-throttled | Pill icon toDataURL on first pickup | UI-23 |
| perf-throttled | Boot bar under throttling | CORE-9, UI-29, VIS-17 |
| perf-throttled | Steady-state heap churn about 2 MB/s | WPN-8, ENE-16, GAT-9, CHR-13, FX-14 (+ VIS-13 / VIS-14 for three's uniform and getParameters garbage) |
| edge-cases | Dead squad revived by a + gate | GAT-6, CHR-10, LVL-20 |
| edge-cases | Boss kill lost on QUIT / RESTART | LVL-19 |
| edge-cases | RESET SAVE double-tap | UI-20 |
| edge-cases | Unbounded highestUnlocked | UI-24 (minor) |
| edge-cases | First tap freezes (AudioContext) | AUD-8 |
| edge-cases | Pause burns theatre deadlines | CORE-7, ENE-17, LVL-29, VIS-18, UI-28 (duplicate of mobile) |
| edge-cases | First LEVELS / SHOP / SETTINGS open hitch | UI-19 |
| edge-cases | ?reset=1 stays in the URL | CORE-11 |
| edge-cases | Context restore console warnings | VIS-21 |
| visual-2 | Gate glyph contrast 1.1–1.8:1 | VIS-12, GAT-7 |
| visual-2 | Troops hide the squad | CHR-9 (label lift rejected) |
| visual-2 | 'SHOOT THE BOSS' during the immune intro | LVL-25, UI-18 |
| visual-2 | Queen sacs bloom white | ENE-14 |
| visual-2 | Boss impacts at shin height | ENE-13, WPN-9 |
| visual-2 | Count label behind results / game over | FX-11, UI-30 |
| visual-2 | Boss damage numbers overprint | FX-12 |
| visual-2 | Title squad black silhouettes | VIS-15 |
| visual-2 | Shotgun / rail pill icons dark | VIS-16 |
| visual-2 | Level art never changes | deferred (rejected) |
| visual-2 | Tutorial copy stale, orphaned lines | LVL-33, UI-18 (text-wrap) |
| visual-2 | Count label merges with the gate glyph | FX-10 |
| visual-2 | Crates turn solid white | GAT-10 |
| visual-2 | Menu polish | UI-33 |
| visual-2 | 200 soldiers' feet off-screen | VIS-19 |
| carryover-check | Endless runaway to about 20× E | LVL-17 |
| carryover-check | Boss draw calls over budget | CHR-11 |
| carryover-check | Shadow-depth churn in boss fights | VIS-14 (+ ENE-15, GAT-8) |
| carryover-check | WPN-5 incomplete; squad.render top allocator | WPN-8, CHR-13, ENE-16, GAT-9 |
| carryover-check | Seed #3 evidence: warm-up works; layout + raster | UI-21, UI-19 (warm-up premise rejected) |
| carryover-check | LVL-7 L4 magnet lost to +9 | LVL-26 |
| carryover-check | Balance evidence update | LVL-27 |
| carryover-check | GDD / ARCH amendments not applied | LVL-28, GAT-7, WPN-10, VIS-23, CHR-14, UI-18 (§14) |
| carryover-check | Endless HUD distance after death | LVL-32 |
| carryover-check | Landscape title squad hidden | VIS-20 |
| carryover-check | Debug overlay clipped | UI-34 |
| carryover-check | Data hygiene (DATA-MISSING, duplicate key) | ENE-19, FX-12, LVL-35, VIS-23, WPN-10 (+ AUD-4 / AUD-7 / CORE-10 / GAT-10 move their literals) |
| carryover-check | QA tooling noise | LVL-34 (callsites / members → QA follow-up) |
