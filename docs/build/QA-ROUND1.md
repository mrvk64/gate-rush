# Gate Rush — QA Round 1 triage

QA lead triage of the round-1 reports (lead + 7 testers: levels-early, levels-mid, bosses, ui-shells, visual, rules-audit, perf), 116 raw issues → **87 fixer issues** in 10 groups plus 12 rejected / deferred items. Every root cause below was spot-checked against the code at the cited lines (and screenshots where the claim was visual) during triage; the GDD (docs/GDD.md) is authoritative unless an issue explicitly records a GDD amendment.

## Summary

| Group | Files the group may edit | Blocker | Major | Minor | Polish | Total |
|---|---|---|---|---|---|---|
| visual | js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js | 1 | 7 | 2 | 1 | 11 |
| gates | js/gates.js, js/pickups.js | 0 | 4 | 1 | 0 | 5 |
| fx | js/fx.js | 0 | 2 | 3 | 4 | 9 |
| characters | js/models.js, js/squad.js, js/troops.js | 0 | 2 | 4 | 2 | 8 |
| enemies | js/zombies.js, js/boss.js | 0 | 6 | 3 | 2 | 11 |
| weapons | js/weapons.js | 0 | 1 | 4 | 1 | 6 |
| level | js/level.js, js/levelgen.js, tools/validate-levels.js | 0 | 6 | 5 | 2 | 13 |
| ui | js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js | 0 | 1 | 7 | 9 | 17 |
| audio | js/audio.js | 0 | 1 | 1 | 1 | 3 |
| core | js/engine.js, js/main.js, js/util.js | 0 | 1 | 1 | 2 | 4 |
| **all** | | **1** | **31** | **31** | **24** | **87** |

## Rules for fixers

- Edit only your group's files. `js/data.js` is shared: edit **only** the keys listed in your issues' *Data keys* (new keys marked "(new)"; add a comment with the GDD reference). Read any other key freely, never edit it.
- Verification runs: always pass a unique `--out docs/build/qa/fix-<group>/<run>` (never overwrite the testers' evidence directories). Boss runs: add `window.__qaClearGates=1; $(cat docs/build/qa/bosses/probe.js)` to `--after` and read them with `node docs/build/qa/bosses/qa.cjs ../fix-<group>/<run>` / `qa2.cjs` (paths are relative to docs/build/qa/bosses). Until LVL-11 lands, `--boss` runs must clear leftovers that way.
- Before handing back: `node tools/check-imports.js`, `node tools/smoke.js --scenario all --out docs/build/qa/fix-<group>/all` must stay CLEAN (zero page/console errors), and the level group also runs `node tools/validate-levels.js`.
- Never hand-edit `artifact.html`; it is regenerated from index.html + js by `node tools/build-artifact.js` at integration.
- Zero per-frame allocations, pools allocated once, no texture uploads during play (GDD §16, §0) — every fix keeps these.

## Cross-group interfaces

- **VIS-2 → CORE-1, CORE-3, VIS-1** — visual adds `RenderSystem.warmup(): Promise<void>` (compiles every scene material incl. shadow-depth variants, restores visibility, never throws). core awaits it in main.js before hiding the boot screen and in engine.js after `webglcontextrestored`; render reuses it after a tier switch.
- **GAT-2 ↔ VIS-7** — gates adds `GATE_RULES.glyph.badgeLift` (≈0.5 m) and places the MAX letters at panel top + badgeLift; visual centres the gold pill at the same height (reads the key, never edits it).
- **GAT-3 ↔ VIS-5** — gates draws × / ÷ op glyphs at `GATE_RULES.glyph.opMultDiv` (≈1.0–1.1 m); visual redraws the ÷ atlas cell. Both are needed for ÷ to read at 30 px.
- **GAT-1 → FX-1, FX-3** — gates lowers `PALETTE.glyph.emissive` to ≈1.2; fx derives HDR_WHITE from it (floaters / numbers get dimmer — intended). fx gives the count label its own `JUICE.label.gain`.
- **GAT-1 ↔ VIS-9** — gates rate-limits and caps the flash value in iPanel.z; visual makes the panel shader brighten the type colour instead of adding white.
- **ENE-3 ↔ CHR-7, CHR-1** — enemies rate-limits flash re-triggers (zombies.js, boss.js) and moves the boss rage glow to eyes/core/light (+ glow seams if CHR-1 adds them); characters lowers the shader's flash amplitude in models.js.
- **ENE-9 ↔ CHR-1, CHR-5** — enemies restricts castShadow to big rig parts (boss.js overrides models.js); characters merges new sub-pieces into the existing part meshes so main-pass draw calls do not grow.
- **ENE-5 ↔ VIS-3** — enemies anchors boss telegraphs at z ≈ −1 (squad front) with x-only tests; visual keeps z ∈ [−3, +1] above the letterbox in the boss framing.
- **ENE-6 ↔ WPN-4** — weapons multiplies heavy-weapon gate/shield weights by w; the boss shield intake bucket (40/s) bounds them.
- **FX-7 ↔ AUD-3** — both classify a gate pass by its effective op/value (red / neutral / positive) instead of after ≥ before.
- **FX-9 ↔ WPN-3** — fx owns the rocket blast (flash size, scorch); weapons owns the projectile, flame and smoke trail.
- **VIS-6 → fx.js** — visual owns `RENDER.bloom.deathPeak` (fx.js `_updateRamps` reads it) and the particle brightness in fxmaterials.js; fx.js is not edited for VIS-6.
- **UI-1, UI-9 → fx / render** — ui reads `ctx.fx.label` (x, y, z, hasPos, height, nDigits) and `ctx.render.camera` read-only to place the hint and the shield pill.
- **LVL-4 / LVL-1 vs ZOMBIES / BOSSES data** — level must not edit `ZOMBIES.*` or `BOSSES.*` (enemies own them); LVL-13 only reads `BOSSES.intro.roadLerp`.
- **ENE-7 first** — enemies moves boss.js onto `BOSSES.*` data before ENE-2/3/5/10/11 so those become data tweaks.

## data.js key ownership (round 1)

| Group | Keys it may edit |
|---|---|
| visual | `QUALITY_TIERS.high.shadowType`, `WORLD.camera.fovClamp.landscape`, `WORLD.camera.landscape`, `WORLD.camera.portrait`, `WORLD.camera.countDolly (new)`, `WORLD.camera.title (new)`, `RENDER.idleCameraDrop`, `RENDER.bloom.deathPeak` |
| gates | `PALETTE.glyph.emissive`, `GATE_RULES.fx.emissiveFlash`, `GATE_RULES.fx.flashRetrigger (new)`, `GATE_RULES.panel.hitFlash`, `GATE_RULES.glyph.badgeLift (new)`, `GATE_RULES.glyph.opMultDiv (new)` |
| fx | `JUICE.label.gain (new)`, `JUICE.damageNumber.mergeSeconds (new)`, `JUICE.caps.coinFlights` |
| characters | `PALETTE.boss.muscle (new)`, `PALETTE.soldier.magnetGlow (new)`, `PALETTE.soldier.helmet`, `PALETTE.soldier.uniform`, `PALETTE.soldier.accent (new)`, `TROOPS.*.scale (new)`, `TROOPS.flamer.range`, `TROOPS.flamer.coneDeg` |
| enemies | `BOSSES.attackRangeM (new)`, `BOSSES.firstAttackDelay`, `BOSSES.approachSpeed`, `BOSSES.approachZ`, `BOSSES.chargeStopZ`, `BOSSES.arriveM`, `ZOMBIES.common.hitFlashRetrigger (new)`, `BOSSES.anim.flashEmissive`, `BOSSES.anim.rageEmissive`, `BOSSES.anim.flashTint (new)`, `ZOMBIES.brute.contactHoming (new)`, `BOSSES.rainBox`, `BOSSES.spit3SpreadM`, `BOSSES.archetypes.hulkTwins.name`, `BOSSES.archetypes.colossusPrime.name`, `BOSSES.twinOffsetX`, `BOSSES.twinStaggerZ (new)`, `BOSSES.glob` |
| weapons | `WEAPONS.laser.tracer`, `PALETTE.tracer.laser`, `WEAPONS.laser.glowGain (new)`, `WEAPONS.laser.glowRadius (new)`, `WEAPONS.laser.light (new)`, `PALETTE.tracer.rifle`, `PALETTE.tracer.minigun`, `WEAPONS.minigun.tracer`, `WEAPONS.minigun.tracerScale (new)`, `WEAPONS.rocket.smoke (new)`, `WEAPONS.rocket.flame (new)`, `WEAPONS.rocket.meshScale (new)`, `FIRE.muzzleFlash.ms` |
| level | `GATE_RULES.mult.stepFraction`, `GATE_RULES.mult.stepMin`, `GATE_RULES.mult.cap`, `GATE_RULES.hits`, `GATE_RULES.div.stepFraction`, `GATE_RULES.div.stepMin`, `GATE_RULES.div.flipStepMult`, `LEVELS.endless.rubber`, `LEAK_MODEL`, `WAVE_RULES`, `GATE_RULES.generation (new newFeature keys)`, `LEVELS.curve.staleEventSkipM (new)`, `LEVELS.curve.introAheadM (new)` |
| ui | `JUICE.ui.hintY`, `UPGRADES.squad.fmtDelta (new)`, `HINTS.steerDesktop (new)` |
| audio | — |
| core | — |

## Issues by severity

### Blocker (1)

#### [VIS-1] Auto quality tier change freezes the game for 3.0–3.9 s (every shader program recompiles synchronously mid-level)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** blocker
- **What:** when the auto-scaler changes tier (engine._applyTier → quality:change), render.applyQuality (js/render.js:1082-1143) switches program-affecting state in one frame: shadowMap.type PCFSoft↔PCF (+ materials.markAllNeedsUpdate), sun.castShadow on/off (lights hash) and the composer on/off (_configureComposer: Low draws straight to the canvas, so every material's toneMapping/outputColorSpace program key changes). The next draw relinks 26–29 programs synchronously: 3055.7 ms at high→med (programs 35→64) and 3861.5 ms at med→low (58→84) on an RX 6800/ANGLE; content that was hidden at the switch (pickups etc.) recompiles again later (138–224 ms). This hits exactly the struggling devices the scaler exists for.
- **Expected:** GDD §16 — a tier change protects the 60 fps contract and must never freeze play; acceptance: no frame > 100 ms caused by a tier change.
- **Fix (js/render.js only; engine keeps emitting quality:change as today and other listeners keep reacting immediately):** (1) apply cheap state at once (DPR, fog far, anisotropy, blob shadows) but defer render's program-affecting switch (shadow type, castShadow, composer on/off): temporarily put the renderer/light/target state into the target tier, compile the scene for it (renderer.compileAsync(scene, camera) — r170 uses KHR_parallel_shader_compile — plus the shadow-depth variants through the VIS-2 warm-up render into an offscreen target), restore the current state, keep drawing the old tier and commit when the promise resolves (fallback: commit after 3 s). Without KHR_parallel_shader_compile, compile a few materials per frame (temporary Scene per chunk). (2) Remove free differences between tiers, e.g. PCFShadowMap on High too (vary only mapSize/radius) so High↔Med never changes shadowMap.type (QUALITY_TIERS.high.shadowType). (3) After the commit run the VIS-2 warm-up for the new tier so pickups/troops/boss don't compile on first use.
- **Verify:** node docs/build/qa/perf/perfprobe2.mjs --level 9 --seconds 75 --slowAt 4 --slowMs 30 --slowFor 25 --out docs/build/qa/fix-visual/life-slow → perf.json tierLog still shows high→med→low and worst[] has no frame > 100 ms around the switches (was 3055.7 / 3861.5 ms); a manual Quality change in Settings shows no multi-second freeze.
- **Evidence:** docs/build/qa/perf/life-slow/perf.json (tierLog; worst[] 3055.7 ms at t=10.5 and 3861.5 ms at t=26.34 with programs 35→64 / 58→84, pickups 138–224 ms at t=17.2/43.0); js/render.js:1082-1190 (applyQuality, _configureComposer)
- **Data keys:** `QUALITY_TIERS.high.shadowType`

### Major (31)

#### [VIS-2] No shader warm-up: the first appearance of content compiles programs mid-play (boss 392–505 ms, troops up to 533 ms, crate 195–277 ms, first shot 76 ms, level start 120–215 ms)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** major
- **What:** every mesh already exists after init (boss rigs in boss.init, troops in troops.init, crates in pickups.init, weapon meshes in weapons.init) but is hidden, and three compiles programs lazily on the first draw; nothing calls renderer.compile/compileAsync (grep). Shadow-depth variants (MeshDepthMaterial, charDepth.* customDepthMaterial) compile on the first shadow render of each caster. renderer.debug.checkShaderErrors is left at true (synchronous getProgramInfoLog, 22.7 ms in the level-start profile). Measured: first shot 75.8 ms, first crate 194.8 ms, boss spawn 391.6–504.9 ms, flamer troop 291–483 ms, medic 195 ms, sniper up to 533 ms, rocket pickup 205 + 100 ms, item-gate icon 54.6 ms, level start 118–215 ms (native compile/link), lead smoke frames.worst 291.8 ms, boss reveal 236/285 ms and results screen 368/278 ms (N1), boot first frame 2.8 s (CORE-1).
- **Expected:** GDD §16 frame budget, no visible hitch.
- **Fix (js/render.js):** add RenderSystem.warmup(): Promise<void> — (1) save visible/frustumCulled of every scene object (and InstancedMesh.count; set count ≥ 1 temporarily), set visible = true and frustumCulled = false; (2) render one frame through the tier's normal path (composer target on High/Med, canvas on Low — the boot screen DOM covers the canvas) so main-pass and shadow-depth programs compile, then await renderer.compileAsync(scene, camera) for anything left; (3) restore every saved value exactly (rigs, shields, crates, troops must be hidden again) and mark dirty; (4) never throw (catch + warnOnce), safe to call repeatedly; allocations are fine (boot/tier change only). Set renderer.debug.checkShaderErrors = !!ctx.config.debug where the renderer is created. Reuse warmup() after a tier commit (VIS-1).
- **Interface:** CORE-1 awaits ctx.render.warmup() during boot; CORE-3 awaits it after webglcontextrestored.
- **Verify:** node docs/build/qa/perf/perfprobe.mjs --level 1 --seconds 110 --out docs/build/qa/fix-visual/probe-l1 and node docs/build/qa/perf/perfprobe.mjs --level 9 --quality high --seconds 60 --after "g.squad.setCount(600,'debug')" --out docs/build/qa/fix-visual/probe-l9 → renderer.info.programs flat after boot, no frame > 50 ms at first shot / crate / troop / rocket / boss spawn; node tools/smoke.js --scenario play --level 1 --out docs/build/qa/fix-visual/l1 → frames.worst < 60 ms (was 291.8).
- **Evidence:** docs/build/qa/perf/probe-l1/perf.json, probe-l9-600/perf.json, probe2-boss-high/perf.json (events[]/worst[] aligned with renderer.info.programs jumps); docs/build/qa/perf/startprof.mjs (getProgramInfoLog 22.7 ms, 213 ms native); docs/build/qa/bosses/N1 (qa.cjs N1 longframe); docs/build/smoke-play.json frames.worst 291.8
- **Data keys:** none

#### [VIS-3] Camera framing: the squad leaves the screen in landscape/wide windows, big squads are cut off in portrait, and the title squad hides behind the buttons

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** major
- **What:** (a) Landscape preset (WORLD.camera.landscape pos (0.4·sx, 10.5, 13), look (0.6·sx, 1, −16), vFOV clamp [36, 55]): at aspect ≳ 2.0 the vertical FOV clamps at 36° and the bottom frustum edge meets the ground at z ≈ −1.4, so the squad (z 0…+3) is below the screen — 1280×600: feet at sy 651 > 600; 844×390 landscape phone: sy 404 > 390; only the count label is visible. A 1366×768 laptop browser viewport (≈1366×625) is affected. (b) Portrait (GDD camera): ground is visible only to z ≈ +1.9 while the formation is 4–5.9 m deep at 120–200 soldiers, so the back half never shows; during the boss the squad centre (z 2.35–3.23) projects to y 869–926 css on an 844 px screen. (c) Title: the marching squad projects to y 669–812 css, behind PLAY (633–697) and SHOP/LEVELS (746–798) — the title shows an empty road.
- **Root cause:** js/render.js verticalFov (:85-88) and _updateCamera (:1263-1330) apply the presets with no framing check.
- **Expected:** the squad and its count stay in frame in every preset (GDD §1 pillar 5 and 'watch the blob swell', §2 camera, §14 Title 'squad marching').
- **Fix (js/render.js + WORLD.camera / RENDER keys):** (1) after computing fov/pos/look each frame, enforce a framing constraint: the ground point (squadX, 0, zBack) with zBack = squad front + min(ctx.world.squadDepth, 4 m) must project at ndc y ≥ −0.80 (above the letterbox during the boss); if not, ease the look-at toward the squad / raise or pull back the camera (reuse the preset tween, never snap); in landscape raise the effective vFOV floor (e.g. fovClamp.landscape min ≈ 42°) if that alone fixes it. (2) Portrait count-driven dolly: camera z/y += k·(√V − √40), clamped (V = visible count), look-at unchanged, eased ≈0.5 s, so ≥ 80 % of a 200-soldier formation is visible. (3) Title: move the title camera/look-at (RENDER.idleCameraDrop or a new WORLD.camera.title) so the squad sits between the logo bottom (≈245 css) and PLAY (≈633 css) on 390×844. Keep the 8 m road framing and gate pixel sizes as close to the GDD as possible.
- **Interface:** ENE-5 moves boss telegraphs to z ≈ −1; keep z ∈ [−3, +1] visible above the letterbox in the boss framing.
- **Verify:** node docs/build/qa/ui-shells/probe.mjs wide --out docs/build/qa/fix-visual/probe-wide and node docs/build/qa/ui-shells/probe.mjs landscape --out docs/build/qa/fix-visual/probe-landscape (squad feet project inside the viewport); node docs/build/qa/perf/perfprobe2.mjs --level 3 --seconds 25 --resizeAt 8 --out docs/build/qa/fix-visual/life-resize (01-landscape.png shows soldiers); node tools/smoke.js --scenario play --level 2 --seconds 40 --shots 4 --after "g.squad.setCount(200,'debug')" --out docs/build/qa/fix-visual/big; node tools/smoke.js --scenario boot --out docs/build/qa/fix-visual/title (00-title.png shows the squad).
- **Evidence:** docs/build/qa/ui-shells/probe-wide/probe.json + 00-hud-1280x600.png, probe-landscape/04-hud-land.png; docs/build/qa/perf/life-resize/01-landscape.png; docs/build/qa/levels-early/l2/14-play-53s.png, f2/15-play-44s.png, l3nobot/19-play-73s.png; docs/build/qa/bosses Q1/Q5/Q10 probe2 projections (centre z 2.35–3.23 → y 869–926); docs/build/qa/visual/titleprobe preResult, l1/00-title.png
- **Data keys:** `WORLD.camera.fovClamp.landscape`, `WORLD.camera.landscape`, `WORLD.camera.portrait`, `WORLD.camera.countDolly (new)`, `WORLD.camera.title (new)`, `RENDER.idleCameraDrop`

#### [VIS-4] Bloom draws hard rectangular halos around tracers and glyphs (near-box blur kernel)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** major
- **What:** every tracer sits in a soft-edged axis-aligned square on High/Medium; with bloom strength 0 the squares disappear.
- **Root cause:** UnrealBloomPass.getSeperableBlurMaterial uses sigma = kernelRadius (node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js:299-305, kernel sizes 3/5/7/9/11), so the weights only fall to ≈0.6–0.8 at the kernel edge — nearly a box blur; TierBloomPass (js/render.js:227-236) inherits it.
- **Expected:** GDD §15 bloom strength 0.6, radius 0.4, threshold 0.85 with a soft round glow.
- **Fix (js/render.js):** in the TierBloomPass constructor after super(), rewrite each this.separableBlurMaterials[i].uniforms.gaussianCoefficients.value with a Gaussian of sigma = KERNEL_RADIUS/3 (the blur shader divides by weightSum, so no normalisation is needed); if the reach shrinks visibly, rebuild the blur materials with larger kernels (e.g. 4/6/8/10/12). Keep strength/radius/threshold per GDD and the pass cost about the same.
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 20 --shots 3 --quality high --out docs/build/qa/fix-visual/bloom-high and --quality med --out docs/build/qa/fix-visual/bloom-med → tracer/glyph halos are round and soft (compare docs/build/qa/visual/crop-tracers9.png / crop-tracers14.png); frame time unchanged.
- **Evidence:** docs/build/qa/visual/l1/03-play-9s.png + crop-tracers9.png (High), l1/04-play-14s.png + crop-tracers14.png (Medium), l9/07-play-25s.png; l1-nobloom/03-play-5s.png + crop-nb5.png (strength 0: no squares)
- **Data keys:** none

#### [VIS-5] The ÷ glyph in the digit atlas reads as '+' at gate distance (a red ÷2 looks like +2)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** major
- **What:** at 17–36 px the two dots of the font ÷ glyph blur into the bar's vertical axis and the operator reads '+': players take the most punishing gate for a bonus. The op glyph comes from the Lilita One digit atlas (js/render.js:294-297 OP_MAP '/'→'÷', RENDER.atlas.rows[1]).
- **Expected:** GDD §4.1 four-way type encoding — the glyph (+ × − ÷) must identify the gate without colour; pillar 5.
- **Fix (js/render.js TextureFactory atlas build):** draw a custom ÷ cell instead of the font glyph — a horizontal bar ≈0.7 of the cell width and ≈0.12 of the cell height thick, two round dots of diameter ≈0.22–0.26 of the cell height with a clear gap ≥ 0.12 of the cell height above/below the bar, and the same #0B0F1A outline as the digits (PALETTE.glyph.outline); check that × keeps thick strokes and reads as ×. No texture uploads during play (atlas is built once at boot).
- **Interface:** GAT-3 renders × and ÷ op glyphs at ≈1.0–1.1 m instead of 0.7 m; both fixes together must pass the check.
- **Verify:** node tools/smoke.js --scenario play --level 9 --shots 4 --out docs/build/qa/fix-visual/l9 (pair '−25 | ÷3' around 20–35 s) and node tools/smoke.js --scenario play --endless --seconds 90 --pre "g.save.data.highestUnlocked=11" --out docs/build/qa/fix-visual/endless → in a ≈30 px-tall crop at z ≈ −36 the ÷ is clearly not a '+' (docs/build/qa/levels-early/crop.mjs / docs/build/qa/visual/tools/crop.mjs).
- **Evidence:** docs/build/qa/levels-early/crop_div.png, crop_div2.png (from p4/19-play-55s.png, 20-play-58s.png: '−90 | ÷2' reads '+2'); docs/build/qa/levels-mid/crop-endless-div.png, crop-l5-divglyph.png; docs/build/qa/visual/crop-div35.png (l9/09-play-35s.png '−25 | /3' reads '-25 | +3')
- **Data keys:** none

#### [VIS-6] Boss death whites out the screen for ~1.5 s (HDR additive confetti and coin fountain under the 1.6 bloom pulse)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** major
- **What:** 0.16 s after boss:dead the #flash overlay is already at opacity 0 while bloom strength is 1.557; the white glare comes from 200 additive confetti (js/fxmaterials.js particle shader kind 6, bright 1.5) and the 60-coin gold fountain (kind 4, bright ≈2.4, additive) blooming over the HDR core — the collapsing rig (the payoff) can't be seen.
- **Expected:** GDD §7/J16 — white flash 0.15 s, bloom 0.6 → 1.6 → 0.6 over 1.5 s, a punchy beat with the 1.8 s collapse visible; reduced motion → 150 ms dim.
- **Fix (js/fxmaterials.js + data):** confetti must not be HDR — render it in the normal-blended particle mesh (PARTICLE_ADDITIVE in fxmaterials.js) or cap its brightness ≤ 0.8; cap gold / coinSparkle brightness at ≈1.2; if a glare remains, lower RENDER.bloom.deathPeak (fx.js _updateRamps reads it; visual owns the value) to ≈1.1–1.2. Do not edit js/fx.js (fx group) or js/boss.js (enemies).
- **Verify:** node tools/smoke.js --scenario play --level 1 --boss --seconds 30 --shots 0.5 --after "g.squad.setCount(140,'debug'); window.__qaClearGates=1; $(cat docs/build/qa/bosses/probe.js)" --out docs/build/qa/fix-visual/death → the screenshots 0–1.5 s after boss:dead show the falling rig and no frame is more than half near-white; confetti still reads as confetti.
- **Evidence:** docs/build/smoke/10-play-55s.png; docs/build/qa/bosses/L1/08-play-22s.png; node docs/build/qa/bosses/qa2.cjs P1 (t=15.80: flash 0.00, bloom 1.557)
- **Data keys:** `RENDER.bloom.deathPeak`

#### [VIS-7] The MAX pill is centred on the panel's top edge, behind the frame's top bar (pairs with GAT-2: the badge reads 'MAY')

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** major
- **What:** the gate panel shader draws the gold MAX pill centred on the panel's top edge (js/materials.js PANEL_FRAG MAX block :322-338, bp = vP − (0, uHalf.y)); the frame's top bar (≈3.19–3.33 m high, ±0.08 m deep) crosses it and, together with the letters GAT-2 draws, hides their lower half → 'MAY'.
- **Expected:** GDD §4.1 / J4 gold 'MAX' badge fully readable.
- **Fix (js/materials.js):** centre the pill at panel top + GATE_RULES.glyph.badgeLift (new key added and owned by gates in GAT-2, ≈0.5 m) so the whole pill sits above the bar and its sign lamps, and make sure the maxed panel's quad extension (header note 'top on MAX panels so the badge pill can extend above the panel edge') covers the moved pill; keep the pill's look and pop.
- **Interface:** GAT-2 moves the 3 letters to the same height and in front of the bar.
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 12 --shots 1 --quality high --out docs/build/qa/fix-visual/max → a complete 'MAX' badge above the +20 gate at 7–9 s.
- **Evidence:** docs/build/smoke/02-play-7s.png (badge reads 'MAY'); js/materials.js:322-338; js/gates.js:1316
- **Data keys:** none

#### [VIS-8] env.prop material re-resolves its shader program twice per frame (curbs share it without instanceColor)

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** major
- **What:** env.curbs (js/environment.js:1036-1039) is an InstancedMesh using the shared prop material without an instanceColor attribute, while env.sandbags/tree/rubble use the same material with instanceColor → the program key flips between draws and WebGLPrograms.getParameters/customProgramCacheKey run 2×/frame for env.prop (progchurn detail 'env.curbs iColor=false | prev iColor=true' ×305 frames). getParameters is ≈3.2 MB/s of garbage game-wide — the largest single allocation source (GDD §16 zero per-frame allocations; GAT-4 and FX-2 fix the other two materials).
- **Fix (js/environment.js):** give env.curbs an instanceColor filled with 1.0 (the existing fill(1) path in _initInstanced around :1164) or give the curbs their own material instance.
- **Verify:** node docs/build/qa/perf/progchurn.mjs --level 9 --quality high --wait 8 > docs/build/qa/fix-visual/progchurn.json → env.prop customProgramCacheKey ≈ 0 calls/frame after the first frames.
- **Evidence:** docs/build/qa/perf/progchurn-l9-high.json (env.prop #22, 2.0×/frame); docs/build/qa/perf/probe2-alloc/perf.json allocExt (getParameters 90.3 MB, join 22.3 MB, getProgramCacheKeyParameters 14.2 MB in 40 s)
- **Data keys:** none

#### [GAT-1] Gate panels and value glyphs wash out to white while being shot (hit flash re-triggers on every hit; glyphs are HDR 2.5)

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** major
- **What:** gates.render (js/gates.js:1352-1367) restarts the hit flash on every hit (_popTime per hit; hitFlash = 1 − age/GATE_RULES.panel.hitFlash) and writes GATE_RULES.fx.emissiveFlash·hitFlash into iPanel.z (panel), iFrame.w (frame) and the glow gain; at ≥ 8.3 hits/s (normal fire is 10–40/s) it never decays, so the panel shader keeps adding white (materials.js:310) — the x3 gate is nearly unreadable on High and the '+31' panel is neutral grey even on Low with no bloom. Value glyphs are PALETTE.glyph.fill × PALETTE.glyph.emissive 2.5 (gates.js:1318-1320, toneMapped false), so on High the bloom covers their own #0B0F1A outline.
- **Expected:** GDD pillar 5 (gate values among the three most legible things), J3 (+1.0 emissive decaying over 120 ms reads as a pulse), §4.1 hue readable while shot.
- **Fix (js/gates.js + data):** (1) keep the per-hit glyph pop if wanted, but drive the panel/frame flash from a per-gate _flashTime that only restarts when t − _flashTime ≥ GATE_RULES.fx.flashRetrigger (new, ≈0.15 s); (2) attenuate under sustained fire — scale the flash by 1/(1 + hitsInLast250ms/4) (the intake bucket already tracks recent intake) and cap the hit-flash value written to iPanel.z / iFrame.w at ≈0.45 (the flip flash keeps 1.0); same for the glow gain; (3) set PALETTE.glyph.emissive to ≈1.2 (≤ 1.3) so bloom only haloes the white digits and the dark outline stays visible (fx.js derives HDR_WHITE from this key, so floaters and damage numbers get dimmer too — intended; the count label gets its own gain in FX-1).
- **Interface:** VIS-9 changes how the panel shader renders the flash value (tint-preserving).
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 20 --shots 2 --quality high --out docs/build/qa/fix-gates/l1hi and --quality low --out docs/build/qa/fix-gates/l1low → at 13–15 s the shot x2/x3 panel stays green with crisp white digits; node docs/build/qa/visual/tools/sample.mjs on the shot panel keeps the type hue.
- **Evidence:** docs/build/smoke/03-play-13s.png (x3 washed out), 02-play-7s.png; docs/build/qa/visual/l9/12-play-48s.png (Low, '+31' #C7C1C5/#CBC5C7); js/gates.js:1318-1320, 1352-1367; js/materials.js:309-311
- **Data keys:** `PALETTE.glyph.emissive`, `GATE_RULES.fx.emissiveFlash`, `GATE_RULES.fx.flashRetrigger (new)`, `GATE_RULES.panel.hitFlash`

#### [GAT-2] MAX badge letters are hidden behind the frame's top bar ('MAX' reads 'MAY')

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** major
- **What:** gates.render places the three 'MAX' glyphs centred at badgeY = panel bottom + panel height = 3.4 m (js/gates.js:1316, 1443-1460), GATE_RULES.glyph.icon (0.7 m) tall, at z = panel + 0.03; the frame's top bar (≈3.19–3.33 m, ±0.08 m deep, i.e. in front of z + 0.03) depth-occludes the lower half of the letters → 'MAY'.
- **Expected:** GDD §4.1 / J4 gold 'MAX' badge fully readable.
- **Fix (js/gates.js + data):** add GATE_RULES.glyph.badgeLift (new, ≈0.5 m) and centre the letters at panel top + badgeLift (fully above the bar and its sign lamps) with a z offset ≥ 0.12 m in front of the panel so no frame part can occlude them; keep the J4 2→1 scale pop. Do not change GATE_RULES.glyph.icon (it also sizes the pill).
- **Interface:** VIS-7 moves the gold pill (materials.js) to panel top + GATE_RULES.glyph.badgeLift — add the key early; only gates edits it.
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 12 --shots 1 --quality high --out docs/build/qa/fix-gates/max → complete 'MAX' badge above the +20 gate at 7–9 s.
- **Evidence:** docs/build/smoke/02-play-7s.png; js/gates.js:1316, 1443-1460
- **Data keys:** `GATE_RULES.glyph.badgeLift (new)`

#### [GAT-3] × and ÷ operator glyphs are drawn at 0.7 m, too small to read at decision distance (÷2 reads '+2')

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** major
- **What:** _rebuildText (js/gates.js ~1246-1296) draws the op glyph at GATE_RULES.glyph.icon (0.7 m) next to 1.35–1.7 m digits; at 17–36 px the ÷ dots vanish and the operator reads '+' (see VIS-5).
- **Expected:** GDD §4.1 four-way encoding, pillar 5.
- **Fix (js/gates.js + data):** render the × and ÷ op glyphs at GATE_RULES.glyph.opMultDiv (new, ≈1.0–1.1 m), vertically centred with the digits (+ and − may stay 0.7 m or go to 0.8 m); the TEXT_FIT (90 % of panel width) shrink still applies on triple lanes. Leave GATE_RULES.glyph.icon unchanged (MAX letters / pill).
- **Interface:** VIS-5 redraws the ÷ atlas cell.
- **Verify:** node tools/smoke.js --scenario play --level 9 --shots 4 --out docs/build/qa/fix-gates/l9 → in a ≈30 px-tall crop of the ÷3 lane at z ≈ −36 the operator is clearly ÷; text still fits on triple panels (node tools/smoke.js --scenario play --level 11 --shots 4 --out docs/build/qa/fix-gates/l11).
- **Evidence:** docs/build/qa/visual/crop-div35.png; docs/build/qa/levels-early/crop_div.png; docs/build/qa/levels-mid/crop-l5-divglyph.png; js/gates.js:1274-1296
- **Data keys:** `GATE_RULES.glyph.opMultDiv (new)`

#### [GAT-4] Perf: gate glow quads take three's two-pass path (program lookup twice per frame) and markUpdate reallocates updateRanges every frame (gates.js, pickups.js)

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** major
- **What:** (1) glowMat (js/gates.js:447-449) is transparent + DoubleSide without forceSinglePass, so three renders it in two passes and bumps material.version twice per frame → WebGLPrograms.getParameters 2×/frame plus 2 draw calls (progchurn: gates MeshBasicMaterial #78; verstack: 162 version bumps per 2 s from renderObject:30481/30485). Together with VIS-8 and FX-2 this is the ≈3.2 MB/s getParameters garbage. (2) markUpdate (js/gates.js:165-177) and js/pickups.js:78 push attr._grRange after three's clearUpdateRanges() set updateRanges.length = 0 — V8 frees and reallocates the array's backing store every frame (gates 4.1–5.1 MB/min, pickups 0.25 MB/min).
- **Expected:** GDD §16 zero per-frame allocations, ≤ 50 main-pass draw calls.
- **Fix:** glowMat.forceSinglePass = true (an additive glow needs no back/front ordering); in tagRange keep the range object permanently in attr.updateRanges and replace attr.clearUpdateRanges with a shared module-level no-op, so markUpdate only sets r.start/r.count and needsUpdate (uploads still happen only on a version change); same pattern in pickups.js.
- **Verify:** node docs/build/qa/perf/progchurn.mjs --level 9 --quality high --wait 8 > docs/build/qa/fix-gates/progchurn.json (gates materials ≈0 customProgramCacheKey calls/frame); node docs/build/qa/perf/perfprobe.mjs --level 9 --quality high --seconds 60 --heapprof --out docs/build/qa/fix-gates/heap (no markUpdate gates.js/pickups.js entries in alloc[]).
- **Evidence:** docs/build/qa/perf/progchurn-l9-high.json; docs/build/qa/perf/dbl.js via evalprobe.mjs ('gates / MeshBasicMaterial'); docs/build/qa/perf/probe-l9-high/perf.json and probe-l9-600/perf.json alloc[] (markUpdate gates.js:165, pickups.js:78)
- **Data keys:** none

#### [FX-1] Squad count label renders as a blurry white glow instead of a crisp white number with a dark outline

- **Group:** fx (js/fx.js) · **Severity:** major
- **What:** fx colours the label with this._white = PALETTE.glyph.fill × HDR_WHITE where HDR_WHITE = PALETTE.glyph.emissive (2.5) (js/fx.js:56, :622-623, _writeLabel :1407-1455); on High the bloom spreads over the atlas' #0B0F1A outline and the 72 px number becomes a glowing blob ('23', '137'). On Medium the same label reads fine (docs/build/qa/visual/l1/05-play-21s.png), so HDR + bloom is the cause, not the atlas or the outline.
- **Expected:** GDD §3.1 count label — digit-atlas quads, 72 px, 3 px #0B0F1A outline, above the blob; pillar 5.
- **Fix (js/fx.js + data):** give the count label its own gain JUICE.label.gain (new, ≈1.0 linear) instead of HDR_WHITE, and cap the gain/loss flash colours used on the label (PALETTE.flash.gain/loss × HDR_TINT 2.0) at ≈1.1 peak; the 'x3' badge ≤ ≈1.2. Do not edit PALETTE.glyph.emissive (owned by GAT-1, which lowers it to ≈1.2; floaters and damage numbers inherit that).
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 55 --shots 6 --quality high --out docs/build/qa/fix-fx/label → crisp white count with a visible dark outline at ~13 s and during the boss; gain/loss flashes still visible.
- **Evidence:** docs/build/smoke/03-play-13s.png ('23'), 09-play-49s.png; docs/build/qa/bosses/M1/06-play-11s.png ('137'); contrast docs/build/qa/visual/l1/05-play-21s.png (Medium, readable)
- **Data keys:** `JUICE.label.gain (new)`

#### [FX-2] Perf: fx.shards takes three's two-pass path every frame, stays visible at count 0, and markItems reallocates updateRanges

- **Group:** fx (js/fx.js) · **Severity:** major
- **What:** gr.fx.shards (js/fx.js:785-795) is transparent + DoubleSide without forceSinglePass → three's two-pass path bumps material.version twice per frame → WebGLPrograms.getParameters 2×/frame plus 2 draw calls (progchurn gr.fx.shards #34); fx.js:1675 sets mesh.count = n but never mesh.visible, so the empty mesh is projected and rendered every frame (dbl.js: 'fx.shards / gr.fx.shards visible=true count=0'); markItems (js/fx.js:283-298) has the same updateRanges reallocation as GAT-4.
- **Expected:** GDD §16 zero per-frame allocations; pooled meshes cost nothing when empty (weapons commitMesh and gates already hide empty meshes).
- **Fix (js/fx.js):** mat.forceSinglePass = true for gr.fx.shards; mesh.count = n; mesh.visible = n > 0 for the shards and every other pooled fx mesh whose count is set directly (floaters, numbers, label, decals, beams — check each); markItems keeps its range object permanently in updateRanges and replaces attr.clearUpdateRanges with a shared no-op.
- **Verify:** node docs/build/qa/perf/progchurn.mjs --level 9 --quality high --wait 8 > docs/build/qa/fix-fx/progchurn.json (gr.fx.shards ≈0 calls/frame); node docs/build/qa/perf/evalprobe.mjs --level 9 --wait 6 --code docs/build/qa/perf/dbl.js (no 'visible=true count=0'); perfprobe --heapprof shows no markItems entries.
- **Evidence:** docs/build/qa/perf/progchurn-l9-high.json; docs/build/qa/perf/dbl.js output via evalprobe.mjs; docs/build/qa/perf/probe-l9-high/perf.json alloc[] (markItems fx.js:283)
- **Data keys:** none

#### [CHR-1] The Hulk boss rig reads as crude dark boxes with red slabs (brute muscle colour kept, no readable jaw, protruding core, plank shield)

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** major
- **What:** bossBodyParts (js/models.js:1777-1830) only recolours skin → PALETTE.boss.skin and cloth → plates; the brute's muscle #9C3C3C stays as big red slabs, the small head has no visible hinged jaw, the orange core sphere sticks out of the chest and the car-door shield is a thin blue-purple plank.
- **Expected:** GDD §7 'Hulk / Brute King: 3.2× brute, car-door shield, hinged jaw'; §15 boss skin #4F6B47, plates #2F2F33, core #FF4A1F emissive 3, eyes #FFE14D emissive 1.5 — a menacing, readable monster at 12 m on a phone.
- **Fix (js/models.js + data):** in bossBodyParts('brute') map the muscle colour to a darker boss tone (new PALETTE.boss.muscle ≈ #6B3A2E; don't change PALETTE.zombie.brute.muscle); a visible jaw block with teeth under a heavier brow; shoulder pads, knuckles/fists and a belt; 2–4 dark #2F2F33 armour plates as the plate0–3 children boss.js detaches in phase 2; seat the core in a chest recess with a dark rim; a recognisable car door for the shield (frame, window, handle, 0.15–0.2 m thick, PALETTE.props.car colour + rust); optional thin glow 'seam' strips (glow material) that ENE-3 can light in phase 3. Keep the rig contract (named children torso, head, jaw, armL, armR, legL, legR, core, plate0–3, shield; joint origins; BOSSES.rigHeight 7 m; coreY) and merge new sub-pieces into the existing part meshes (no extra mesh per piece) so draw calls don't grow (GDD §16; see ENE-9). The phase-3 pink tint is ENE-3's (boss.js).
- **Verify:** unshot rig — node tools/smoke.js --scenario play --level 1 --boss --nobot --seconds 16 --shots 2 --after "g.squad.setCount(140,'debug'); g.profile = Object.assign({}, g.profile, { fireRate: 0.000001 }); window.__qaClearGates=1; $(cat docs/build/qa/bosses/probe.js)" --out docs/build/qa/fix-characters/M1 → a readable Hulk; overlay main-pass calls not higher than before.
- **Evidence:** docs/build/qa/bosses/M1/06-play-11s.png (unshot rig); docs/build/smoke/10-play-55s.png; js/models.js:1777-1830
- **Data keys:** `PALETTE.boss.muscle (new)`

#### [CHR-2] Magnet and armor give no lasting on-squad feedback (the magnet is invisible once picked up)

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** major
- **What:** no gear visual exists in squad.js, models.js or materials.js (grep gear:start / magnet / armor): fx only flashes a vignette on gear:start (js/fx.js:2216) and sparks on plate loss (fx.js:2125); PALETTE.fx.armor 'shoulder glint' (js/data.js:890) is unused and the magnet has no HUD pill (ARCH UI table). After the L4 magnet pickup (radius 5 — the effect works) and with L2 armor, the squad looks unchanged.
- **Expected:** GDD §8.2 magnet 'helmet rings glow purple' for the rest of the level; armor 'blue shoulder glint' while plates remain — a new player must see that the special is active.
- **Fix (js/models.js soldier material + js/squad.js):** two uniforms on the soldier character material — uMagnet (0/1): purple emissive (GEAR.magnet colour × ≈0.8, slow 1.5 Hz pulse) on the helmet (brim) part; uArmor (0/1 or plates fraction): blue emissive glint (PALETTE.fx.armor × ≈0.6, moving sweep) on the shoulder/webbing part. squad.js subscribes to gear:start/gear:end (id 'gear.magnet') and armor:change (plates > 0) and resets both on level:start. Uniforms only — no new defines or program variants (no recompiles).
- **Verify:** node docs/build/qa/levels-early/qasmoke.mjs --scenario play --level 4 --nobot --shots 3 --after "$(cat docs/build/qa/levels-early/probe2.js)" --out docs/build/qa/fix-characters/f4 (purple helmets after gear:start magnet) and the same with --level 2 --out docs/build/qa/fix-characters/f2 (blue shoulders while armor > 0).
- **Evidence:** docs/build/qa/levels-early/f4 screenshots 23–26 (unchanged after the magnet; report.qa.mag = 5), f2/15-play-44s.png (armored soldiers unchanged)
- **Data keys:** `PALETTE.soldier.magnetGlow (new)`

#### [ENE-1] The boss takes full damage during the 2.4 s intro walk-in (3–13 % of HP gone before boss:fight; the lead's L1 run entered the fight at 1972/2800 and won in 1.6 s)

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** major
- **What:** BossSystem.damage() (js/boss.js:655-680) has no intro guard; bullets already aim at the boss during the intro (GDD §3.3/§7 'squad … still firing'), so HP at boss:fight is L1 2800 → 2450 (−12.5 %), L5 4750 → 4593, L10 7000 → 6559, L15 10250 → 9123, L17 10560 → 9144, L20 15000 → 13860 with only the squad shooting (with fire disabled it stays 2800). The DPS maths itself is on target: from boss:fight, TTK at E_boss is 11.2–16.3 s (L1 11.3, L5 14.1, L10 12.2, L15 12.7, L17 16.3, L20 13.4).
- **Expected:** GDD §7 the intro is theatre and the fight starts at full HP (12.5 s of shooting at E_boss + theatre ≈ 16–18 s; §17 TTK 12–22 s).
- **Fix (js/boss.js):** while this._inIntro, damage() returns false without changing HP, shield hits or phase; keep light feedback only (a throttled spark via this._fx.emit('spark', x, y, z, 1), ≤ ~10/s) and don't emit boss:hit (no damage numbers or thip spam).
- **Verify:** node tools/smoke.js --scenario play --level 1 --boss --seconds 40 --shots 2 --after "g.squad.setCount(140,'debug'); window.__qaClearGates=1; $(cat docs/build/qa/bosses/probe.js)" --out docs/build/qa/fix-enemies/P1 then node docs/build/qa/bosses/qa2.cjs ../fix-enemies/P1 → hp 2800 at boss:fight and TTK ≈12–14 s at base stats.
- **Evidence:** docs/build/smoke-play.json (t=51.4 bossIntro boss 1972/2800; bossTtk 1.57); node docs/build/qa/bosses/qa2.cjs P1/P5/P10/P15/P17/P20 (HP at boss:fight), M1 (fire disabled → 2800)
- **Data keys:** none

#### [ENE-2] Boss attacks run late or never: the interval only counts while idle, attacks wait for 'arrived' (reset by every phase change), the first attack waits 2 s, and charges lunge to 2–3 m

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** major
- **What:** (1) _attackStep decrements unit.cool only in A_IDLE (js/boss.js:977) and resets it to phase.interval when an attack starts (:997), so the real period is interval + telegraph/exec + 0.6 s recover: Hulk slam every 6.42 s (GDD 5), Juggernaut stomp 4.72 (3.5), lane charge 6.82 (4), Colossus 6.6–8.8 (6), Queen phase-3 spit 2.21 (1.6). (2) Attacks require unit.arrived (|z − holdZ| ≤ ARRIVE_M 3, :979); _enterPhase moves the hold 2 m closer and sets arrived = false (:736-741); the approach from approachZ −45 is capped at roadSpeed + 3 m/s (:955), so at boss:fight the Hulk is still at z ≈ −35 and reaches the hold at ≈7.9 s — after phase 2 began at 6.65 s: no phase-1 slam at E_boss (P1), none for the twins (P17), one spit3 for the Queen (P5), one stomp for the Juggernaut (P10); in short fights (p4: 3.3 s) there is no boss:attack at all and the phase-2 charge (pendingAttack) never resolves; with rank-3 upgrades (5–6 s fights) the Queen's triple spit and the Juggernaut's stomp never fire. FIRST_ATTACK_DELAY 2.0 s adds to this. (3) Charges move at vz = roadSpeed + atk.speed (:951, 8.8–10 m/s), clamped only at CHARGE_STOP_Z −2 → the 7 m rig ends at z −2…−3.4 and covers ≈80 % of the frame.
- **Expected:** GDD §7 phases[].interval is the attack period (slam 5/3 s, stomp 3.5/2.2, lane 4, Colossus 6/4, spit 2.5/1.6); phase 1 includes the archetype's basic attack; each phase special fires on entering the phase; Hulk charge '1 s, 6 m/s' — a ≈6 m lunge from the 10–12 m hold.
- **Fix (js/boss.js + BOSSES data; do ENE-7 first):** (a) make the interval start-to-start — decrement unit.cool in every attack state, never start a new attack before A_RECOVER ends; (b) allow attacks once the boss is within BOSSES.attackRangeM (new, ≈30 m) of the squad front instead of requiring 'arrived'; a phase change only moves the hold z; (c) BOSSES.firstAttackDelay 2.0 → ≈0.8 s counted from the end of the intro; on phase entry set cool = min(cool, 1.0) and run onEnter attacks (pendingAttack) as soon as the unit is idle, regardless of distance; (d) raise BOSSES.approachSpeed (or start the approach closer once the dolly has framed the boss) so it is ≈15–18 m away at boss:fight; (e) charges lunge at vz = atk.speed in the squad frame (the hold is already squad-stationary) and BOSSES.chargeStopZ ≈ −5. Note: these rules shorten nothing for the player — they make the GDD's attacks actually happen.
- **Verify:** P-style runs (ENE-1 command) for L1/140, L5/190, L10/280, L15/410, L17/480 and node docs/build/qa/bosses/qa.cjs ../fix-enemies/P<L> boss:attack → first basic attack within ≈1 s of boss:fight, start-to-start = interval ±0.15 s, the phase-2 special within ≈1 s of boss:phase 2, charges stop at z ≈ −5; repeat L5 with --pre "g.save.setUpgrade('squad',3); g.save.setUpgrade('fireRate',3); g.save.setUpgrade('damage',3)" → at least one Triple spit in phase 1.
- **Evidence:** node docs/build/qa/bosses/qa.cjs V1, S10, S15, P5 boss:attack (periods); qa2.cjs P1, P5, P10, P17 (phase 2 before arrival); docs/build/qa/levels-early/p4 (no boss:attack); docs/build/qa/levels-mid/l5boss, l10boss, l8boss-base, l10boss-base (qaLog.boss); docs/build/qa/bosses/L1/04-play-10s.png, Q1/06-play-11s.png (charge to z −3.4); js/boss.js:736-741, 951-958, 974-1000
- **Data keys:** `BOSSES.attackRangeM (new)`, `BOSSES.firstAttackDelay`, `BOSSES.approachSpeed`, `BOSSES.approachZ`, `BOSSES.chargeStopZ`, `BOSSES.arriveM`

#### [ENE-3] Hit flash never decays under sustained fire: zombies, brutes and bosses render as solid white silhouettes; phase-3 rage tints the whole Hulk pink

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** major
- **What:** zombies — _damageSlot calls inst.setHit(i, uTime) on every hit (js/zombies.js:819) and the character shader flashes over ZOMBIES.common.hitFlash 0.06 s, so at ≥ 17 hits/s walkers become white mannequins and brutes white blobs inside the tracer stream. Bosses — damage() sets unit.hitT = t on every hit (js/boss.js:674) and render lerps every body material's emissive to white × ANIM.flashEmissive 1.2 (js/boss.js:1536-1541; bloom threshold 0.85), so Hulk, Queen, Juggernaut and Colossus are flat white for the whole fight (≈100 hits/s; 690 boss:hit in ≈6 s): plates, shading, the phase-3 rage and the model are lost. The phase-3 rage (PALETTE.boss.rage × 0.4) is written to the same body materials → the whole rig turns pink/red.
- **Expected:** GDD §6.1 '0.06 s white emissive flash on every hit' is a blink; §15 boss #4F6B47 skin, #2F2F33 plates and core #FF4A1F stay readable; §7 phase 3 'rage glow' (eyes/core/seams), not a pink body.
- **Fix (js/zombies.js, js/boss.js + data):** (a) per-slot _flashT in zombies — call inst.setHit only when t − _flashT[slot] ≥ ZOMBIES.common.hitFlashRetrigger (new, ≈0.2 s); damage, HP bars and sparks unchanged; (b) boss — the same ≈0.2 s retrigger for unit.hitT; BOSSES.anim.flashEmissive 1.2 → ≈0.35 with a warm tint (new BOSSES.anim.flashTint ≈ #FFD9B0) added on top of the rage colour instead of lerping it away; (c) rage — body emissive rage ≤ ≈0.12 (BOSSES.anim.rageEmissive) and the rage glow on rig.glowMaterial (eyes), the core and the core light (pulse toward PALETTE.boss.rage), plus any glow 'seam' parts CHR-1 adds.
- **Interface:** CHR-7 lowers the character shader's flash amplitude in models.js; don't edit models.js.
- **Verify:** node tools/smoke.js --scenario play --level 3 --nobot --seconds 75 --shots 3 --out docs/build/qa/fix-enemies/l3nobot (zombies under fire blink but keep their colours); boss runs (ENE-1 command) at L1/L5/L10/L15 → the rig keeps skin/plate colours all fight; phase 3 shows red eyes/core, the body is not pink.
- **Evidence:** docs/build/qa/levels-early/l3nobot/03-play-9s.png, p3/16-play-46s.png, l3nobot/19-play-73s.png, f4/32-play-94s.png; docs/build/qa/levels-mid/l5boss/03-play-5s.png, 05-play-9s.png, l10boss/02-play-3s.png, 04-play-7s.png, l6item/11-play-41s.png; docs/build/qa/bosses/L1/03-play-7s.png, L1/06-play-16s.png, P5/02-play-4s.png, Q10/05-play-9s.png, P15/05-play-13s.png, Q1/07-play-13s.png and L1/05-play-13s.png (pink phase 3); docs/build/qa/visual/l1boss120/04-play-6s.png, 05-play-8s.png, l5/25-play-97s.png
- **Data keys:** `ZOMBIES.common.hitFlashRetrigger (new)`, `BOSSES.anim.flashEmissive`, `BOSSES.anim.rageEmissive`, `BOSSES.anim.flashTint (new)`

#### [ENE-4] A brute that reaches the formation parks at its edge and is almost unkillable (one L4 wave brute kills 15–78 soldiers and survives into the boss fight)

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** major
- **What:** on contact the brute sets vz = 0; vx = 0 (js/zombies.js:1262-1270), so it stays at whatever edge it touched (x = 0.01 with squad.x = −2); bullets fly straight (±2°), so only shooters within ≈1 m of its x can hit it. Forced-left L4: wave brute 221:0 (679 HP) stays in contact from d 418 to 562 (≈28 s) through the gate pass, run-up, boss intro and into the boss fight, swings 26 times (3 kills each) and loses only ≈30 HP/s against 115–194 soldiers; bot run: survives 7 s at 289 soldiers (2.9·E) and kills 15.
- **Expected:** GDD §6.1 the brute swings every 1.0 s until dead and is meant to be focus-fired; §6.3 L4–9 leak 15–22 % (≈0.6 expected bites for a one-brute wave) and 'a squad at 2·E leaks 0'.
- **Fix (js/zombies.js + data):** while in contact with the squad keep homing the brute's x toward clamp(squad.x, …) at ZOMBIES.brute.contactHoming (new, ≈2 m/s) so it stands in front of the centre shooters (it still holds z and swings); the APC-contact branch keeps holding against the APC.
- **Verify:** node docs/build/qa/levels-early/qasmoke.mjs --scenario play --level 4 --nobot --shots 3 --after "$(cat docs/build/qa/levels-early/probe2.js)" --out docs/build/qa/fix-enemies/f4 and node docs/build/qa/levels-early/ana.cjs docs/build/qa/fix-enemies/f4/report.json → the wave brute dies within ≈3–4 s of contact with ≤ 6 kills; bot run (same without --nobot, probe.js, out .../p4) → ≤ 3 kills at 2.9·E.
- **Evidence:** docs/build/qa/levels-early/f4/report.json (report.qa.tr['221:0']), f4/28-play-82s.png; docs/build/qa/levels-early/p4/report.json, p4/20-play-58s.png; js/zombies.js:1262-1270
- **Data keys:** `ZOMBIES.brute.contactHoming (new)`

#### [ENE-5] Boss telegraphs are anchored at squad.centerZ — off-screen or under the bottom letterbox — and the splash hit tests don't match what visibly lands on the formation

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** major
- **What:** (1) _startAttack anchors the slam ring, the car x-band and the spit3 arcs at (squad.x, squad.centerZ) (js/boss.js:1044-1125), rain targets at z ∈ [cz − 1, cz + 4] (:1296-1305) and the car lands at cz; the squad centre (z 2.35–3.23) projects to y 869–926 css on an 844 px screen and the bottom letterbox starts at y 776, so only the far arc of the slam ring (not its left/right dodge limits) is visible and the 1 s spit/rain arc previews and the thrown-car impact never show (globs fall into the squad with no marker; '−32' from an unseen car). (2) Triple-spit flank splashes (x ± SPIT3_SPREAD 1.8) land on the formation but _globImpact tests the formation centre with |dx| < 1.2 (:1321-1333), so flanks never kill (P5/P15/P20: flank kills 0, centre 1–2). (3) Spit tests are axis-aligned boxes (js/zombies.js:1395-1399, js/boss.js:1329) → kills up to 1.7 m diagonally.
- **Expected:** GDD §7 'ring telegraph 0.8 s', '1 s arc preview', 'red x-band marker 3 m wide, 1.2 s' must be seen to be dodged (pillar 5); triple spit '3 splashes, 1 soldier each (2 from L10)'; §6.1 splash radius 1.2 m from the formation centre.
- **Fix (js/boss.js, js/zombies.js; the player only steers in x):** (a) draw ring/band/arc/car decals and land the globs and the car at z ≈ squad front − 1 m (≈ −1, visible above the letterbox), keeping x as now; (b) resolve slam/car/lane with x-only tests (|squad.x − ax| ≤ r) and boss splashes against the formation footprint in x: |squad.x − x| ≤ ctx.world.squadHalfWidth + splash·0.5 (flank splashes that land on the formation count); (c) zombie spitter globs (zombies.js _impact): Euclidean dx² + dz² < splash² against the formation centre (GDD §6.1); kills 1 (2 from L10) unchanged.
- **Interface:** VIS-3 keeps z ∈ [−3, +1] visible in the boss framing.
- **Verify:** node tools/smoke.js --scenario play --level 5 --boss --nobot --seconds 40 --shots 2 --after "g.squad.setCount(190,'debug'); window.__qaClearGates=1; $(cat docs/build/qa/bosses/probe.js); $(cat docs/build/qa/bosses/probe2.js)" --out docs/build/qa/fix-enemies/Q5 (also L1/140 and L10/280) then node docs/build/qa/bosses/qa.cjs ../fix-enemies/Q5 atk → every target projects between the HUD and y 776; spit:impact flank kills > 0 when the splash overlaps the formation.
- **Evidence:** node docs/build/qa/bosses/qa.cjs Q1/Q5/Q10/S15 atk (probe2 projections); docs/build/qa/bosses/Q5/08-play-15s.png, Q10/05-play-9s.png, Q1/07-play-13s.png; qa2.cjs P5/P15/P20 spit:impact; docs/build/qa/levels-mid/l8boss-base/report.json qaLog.impacts
- **Data keys:** `BOSSES.rainBox`, `BOSSES.spit3SpreadM`

#### [ENE-6] Colossus / Colossus Prime shield drops 0.04–0.06 s after it goes up (≈4 bullets): the phase-2 special does nothing and the bar never turns grey

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** major
- **What:** damage() adds the full weight to sh.hits with no intake cap (js/boss.js:657-664); the rifle weight is w = C/40 = 10.25 at C 410 and 15 at 600, so 40 (60 for Prime) hits arrive in ≈4 bullets: P15 up 7.06 → down 7.10, P20 6.98 → 7.04, slow run S15 24.52 → 24.57; #bossbar.shielded is never sampled; the regen never matters (6150 → 6159).
- **Expected:** GDD §7 shield = 15 % of max HP regenerating 2 %/s, drops after 40 weighted hits (60 Prime) with a ring gauge and a grey bar; shield weights follow the gate equivalences of §8.1, which are 'subject to the 40 hits/s intake cap' → the shield holds ≥ 1.0 s (1.5 s Prime) at any squad size.
- **Fix (js/boss.js):** feed the shield weight through a token bucket like gates.js (GATE_RULES.intakePerSec 40/s, burst GATE_RULES.intakeWindowS 0.25 → 10; read-only keys) refilled in step(); clamp each weight to the bucket and discard the excess before sh.hits += w; optionally a minimum shield-up time ≈1 s.
- **Interface:** WPN-4 multiplies heavy-weapon weights by w — the bucket bounds them.
- **Verify:** node tools/smoke.js --scenario play --level 15 --boss --seconds 60 --shots 3 --after "g.squad.setCount(410,'debug'); window.__qaClearGates=1; $(cat docs/build/qa/bosses/probe.js)" --out docs/build/qa/fix-enemies/P15 and node docs/build/qa/bosses/qa2.cjs ../fix-enemies/P15 → shield up → down ≥ 1.0 s and barCls 'shielded' sampled; L20 with count 600 → ≥ 1.5 s.
- **Evidence:** node docs/build/qa/bosses/qa2.cjs P15, P20, S15 (boss:shield up/down times; barCls ''→'phase2')
- **Data keys:** none

#### [WPN-1] The laser washes the whole screen magenta; the beam colour contradicts the cyan icon, the light and GDD §8.1

- **Group:** weapons (js/weapons.js) · **Severity:** major
- **What:** beams use WEAPONS.laser.tracer [4.0, 1.0, 3.6] (magenta) while WEAPONS.laser.color 0x4AF0FF (cyan) drives the HUD icon and the point light (render.js:1383); LASER_GLOW_GAIN 0.55, LASER_GLOW_R 0.17 m and LASER_LIGHT_INTENSITY 6 / distance 14 (js/weapons.js:89-96) bathe the frame in magenta: roadside luma 125 → 180 (#8B7B6E → #DCA5D2), gates (+4, +20) and the label (400/403) nearly unreadable.
- **Expected:** GDD §8.1 'one cyan beam per 5 visible shooters', bloom-heavy beams with gates and count still readable (the §15 tracer table's magenta conflicts with §8.1; resolved to cyan — GDD amendment noted).
- **Fix (js/weapons.js + data):** WEAPONS.laser.tracer and PALETTE.tracer.laser → ≈[0.5, 2.6, 3.2]; glow gain 0.55 → 0.25, glow radius 0.17 → 0.12 m; light intensity 6 → 2.5, distance 14 → 10; move these DATA-MISSING literals into WEAPONS.laser.glowGain / glowRadius / light.{intensity, distance}.
- **Verify:** node tools/smoke.js --scenario play --level 12 --seconds 26 --shots 1.5 --quality high --after "g.squad.setCount(80,'debug'); setTimeout(()=>g.weapons.startWeapon('weapon.laser'),15000)" --out docs/build/qa/fix-weapons/laser → beams cyan; roadside luma rises ≤ 25 % while the laser is on (node docs/build/qa/visual/tools/sample.mjs <png> 600 900 40 40); gate glyphs keep ≥ 3:1 contrast with their panel.
- **Evidence:** docs/build/qa/visual/weapons/10-play-15s.png, 12-play-18s.png vs 08-play-12s.png (sample.mjs roadside [600,900] #8B7B6E → #DCA5D2, [60,900] #3F342F → #884F7C); js/weapons.js:89-96; js/data.js:469-470
- **Data keys:** `WEAPONS.laser.tracer`, `PALETTE.tracer.laser`, `WEAPONS.laser.glowGain (new)`, `WEAPONS.laser.glowRadius (new)`, `WEAPONS.laser.light (new)`

#### [LVL-1] Multiplier gates are too cheap: x gates max out on the first gates, squads reach 1.6–4× E_boss and bosses die in 1–4 s

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major
- **What:** gateDefaults (js/levelgen.js:300-319) sizes K_M = max(12·M, round(0.25·H·M)) with H = expectedHits(E, v) = min(40, E·2.0·0.5)·(34.5/v) (:289-293), where E is the cautious E-trace (CAUTIOUS_HITS 0.3, :49). A squad aligned with its lane lands ≈100 % of its shots (not 50 %) and saturates the 40 hits/s intake once C·f ≥ 40, so early x gates (E(z) ≈ 7 → step 24) are maxed by 11 soldiers and the count snowballs: L4 5 → 21 → 105, 347 at the boss vs E_boss 175 and a 3.3 s boss fight; L2 242–246 vs 150 (3★); L10 with rank-3 upgrades 'x3:armed' → 'x5:locked' in 2 s, 11 → 55 → 275 → 1076, 1151 survivors vs 280, boss dead 1.2 s after the intro; L8 842 vs 240; validate-levels Σ EV 3052 vs 252 (L10) and 1657 vs 234 (L9). The trace credits +10 at L2 gate 1 where every run maxes +16.
- **Expected:** GDD §4.2 ('x4 needs the full window' for an on-curve squad), §17 (25–40 % of gates ≥ 2× base at L10; boss TTK 12–22 s), §10 first-try completion targets, §9.3 3★ (0.75·E_boss) is an achievement; GDD §11's L1 greedy line (≈1.9× E_boss) is the ceiling for a perfect player. The authored L1 script stays as is.
- **Fix (js/levelgen.js, tools/validate-levels.js, generator keys in data.js):** size step costs from the window's achievable intake, not E·2.0·0.5: I = min(GATE_RULES.intakePerSec, E_ref·f_ref)·t_w at full accuracy, and require (cumulative hits; gates.js scales each step with the current M): x3 reachable by an on-curve squad at base fire, x4 needing ≈0.9–1.0 of the window at the 40/s cap, x5 unreachable in one window (> 1.1·40·t_w) — or cap generated x gates at x4 (x3 before L15) through the lane cap. Feed the greedy line (gates shot at 0.6·H, GDD §4.4) into later gate values and solveWaveHp instead of the 0.3·H cautious line; keep the cautious line only for the 'must stay survivable' check. Keep tunables in data (GATE_RULES.mult.*, GATE_RULES.hits).
- **Validator:** add a greedy line to tools/validate-levels.js — every lane shot at min(40, C·f)·t_w hits (C = running greedy count; profiles base f 2.0/d 1.0 and rank-3 f 2.6/d 1.45), best lane chosen, ÷ ladders included (LVL-2) — and fail when the greedy count at the boss exceeds 1.6·E_boss (base) or 2.2·E_boss (rank 3) for L2–L30, or the cautious line misses E_boss ± 15 %.
- **Verify:** node tools/validate-levels.js; node tools/smoke.js --scenario play --level 4 --seconds 120 --shots 6 --out docs/build/qa/fix-level/l4 (count at boss ≤ ≈1.6·175, boss fight ≥ 8 s); node tools/smoke.js --scenario play --level 10 --seconds 150 --shots 6 --pre "g.save.setUpgrade('squad',3); g.save.setUpgrade('fireRate',3); g.save.setUpgrade('damage',3)" --out docs/build/qa/fix-level/l10 (no x5 on the first gates; survivors ≤ ≈2.2·280).
- **Evidence:** docs/build/qa/levels-early/l4 and p4 (count 5→21→105→347; boss:fight→dead 97.86→101.14); docs/build/qa/levels-early/l2, p2 (242–246 vs 150); node docs/build/qa/levels-early/dump.mjs 4 ('x2 step 26' sized at E=13); docs/build/qa/levels-mid/l10/report.json (x3→x5 in 2 s, 1151 survivors), l8, l5, l6; node tools/validate-levels.js (Σ EV 3052 vs 252 at L10)
- **Data keys:** `GATE_RULES.mult.stepFraction`, `GATE_RULES.mult.stepMin`, `GATE_RULES.mult.cap`, `GATE_RULES.hits`

#### [LVL-2] The ÷ 'lesser evil' ladder is a free x2: the count doubles at nearly every ÷ gate

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major
- **What:** K_÷ = max(8, round(0.12·H)) (gateDefaults '/', js/levelgen.js:312-315); the whole ladder ÷3 → ÷2 → x1 → (2·K_÷) x2 costs ≈0.48·H and any squad that fills the 40 hits/s intake (C ≳ 16) finishes it in ≈1.7 s of a 3.5 s window — ÷3 → ÷2 at 29.8 s, → x1 at 30.2 s, → x2 at 31.1 s; passes 1074 → 2148, 2204 → 4408, 4408 → 8816 (8816 survivors vs E_boss 280); plain bot runs l5 221 → 442, l6item 189 → 378, l8 353 → 706.
- **Expected:** GDD §4.3/§4.4 −A | ÷D is the 'lesser evil' choice and the ladder a real trade-off.
- **Fix (js/levelgen.js; no gates.js change needed):** size K_÷ per lane from the window intake I = min(40, E·f_ref)·t_w (full accuracy) so that an on-curve squad can pump ÷D up to x1 (no loss) but x2 needs more than one full window at the 40/s cap — e.g. ÷3 lanes K ≈ 0.3·I (x1 at 0.6·I, x2 at 1.2·I) and ÷2 lanes K ≈ 0.45·I (x1 at 0.45·I, x2 at 1.35·I), with I capped at 40·t_w for the x2 test. Keep 'trap' and rubber-band lanes consistent (LVL-3) and include ÷ ladders in the LVL-1 greedy validator.
- **Verify:** node tools/validate-levels.js (the greedy line never doubles C at a ÷ lane); node docs/build/qa/levels-mid/qa-smoke.mjs --level 10 --nobot --seconds 140 --pre "g.save.setUpgrade('squad',3); g.save.setUpgrade('fireRate',3); g.save.setUpgrade('damage',3)" --after "window.__qaMode='div'; $(cat docs/build/qa/levels-mid/probe.js)" --out docs/build/qa/fix-level/l10div → qaLog.passes has no ×2 from a ÷ lane.
- **Evidence:** docs/build/qa/levels-mid/l10div/report.json (qaLog.steps / qaLog.passes); docs/build/qa/levels-mid/l5, l6item, l8 timelines ('/2'→'/1'→'/2', 221→442 etc.)
- **Data keys:** `GATE_RULES.div.stepFraction`, `GATE_RULES.div.stepMin`, `GATE_RULES.div.flipStepMult`

#### [LVL-3] The endless rubber band rewards runaway squads: 'C > 2·E → ÷2 on both halves' doubles C, the count pins at 9 999 and the mini-boss dies in 0.1 s

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major
- **What:** Level._applyRubberBand (js/level.js:739-775) builds ÷2 | ÷2 with one lane stepping per gateDefaults('/') — a 2·E squad always fills the intake, so it always reaches x2: t = 77.9 s 4240 → 8480 and the count is pinned at 9 999 from 83.7 s to the end; in the long run 7 of 18 gate events are the rubber band ('/' 2593 → 5186) and the mini-boss Hulk (2 000 HP) goes spawn → dead in 0.1 s at C = 9 997.
- **Expected:** GDD §10.1 the rubber band pulls the squad back when C > 2·E. (The GDD's 'one shootable to x2' defeats this; resolved to 'shootable to x1' — GDD amendment noted.)
- **Fix (js/level.js):** the shootable lane may climb ÷2 → x1 but not to x2 — give it a step K with K ≤ 0.5·I and 3·K > 40·t_w (I = min(40, C·f)·t_w, t_w = 34.5/v); the other lane never steps (IDLE_NEVER_STEP, as now); optionally, if C > 4·E, both lanes unshootable.
- **Verify:** node tools/smoke.js --scenario play --endless --seconds 150 --shots 8 --pre "g.save.data.highestUnlocked=11; g.save.setUpgrade('squad',3); g.save.setUpgrade('fireRate',3); g.save.setUpgrade('damage',3)" --out docs/build/qa/fix-level/endless → after each rubber-band pass C_after ≤ C_before and the count never pins at 9 999 within 150 s.
- **Evidence:** docs/build/qa/levels-mid/endless/report.json (t=70.5 '/2|/2', t=77.9 4240→8480, 9999 from 83.7 s); docs/build/qa/levels-mid/endless-long/report.json (qaLog.passes; qaLog.boss mini-boss dead at 151.7–151.8 s)
- **Data keys:** `LEVELS.endless.rubber`

#### [LVL-4] L1–9 waves leak 2–4× the GDD band: crawlers are solved for a 40 m window but hittable only in the last 8 m, runners outrun their wave and hide behind the previous gate, edge walkers get almost no fire

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major
- **What:** (a) solveWaveHp/expectedLeak (js/levelgen.js:330-360) use win = 0.8·40/(v + s̄) for every type, but crawlers are unhittable until z > ZOMBIES.crawler.hittableZ (−8, js/data.js:251), ≈0.5 s plus a 0.21 s lunge: in p3, 3 of 4 crawlers bite (intro crawler 180:0, 39 HP, takes 0 damage; pack 181:0/183:0, 71 HP, bite on 25/35 HP). (b) A mixed wave is placed with ev.at = round(contact − SPAWN_DIST·v/(v + s̄)) (js/levelgen.js ~1170) using the population-mean speed, so at v = 8.4 a runner (12.9 m/s) arrives ≈2 s / 17 m before the walkers, inside the previous gate's armed window where every bullet hits the panel in front of it (GDD §3.3 panel shielding): runner 121:1 (35 HP) zig-zags from z −69 to −9.8 without taking damage and bites; runner bites land 1–9 m after gate passes in p3 (d 158.5 / 248.5 after passes at 149.9 / 240), p2 (221 after 215), f2 (146.5 after 138). (c) 'line'/'horde' patterns put walkers at x ≈ ±3 on the formation's outer column; bullets fly straight (±2°, GDD §3.3, js/weapons.js:828) so few shooters cover them: L3 waves leak 3/7, 3/7, 2/7 (+1/1 intro) with C above E (bites at x −2.08/−3.01 with squad.x −2; 2.33/2.86 with squad.x +2); the solve assumes all of E·2·0.8 DPS reaches every zombie.
- **Expected:** GDD §6.3 leak bands (L1–3 10–15 % ≈ 0.9 bites per 7-zombie wave; L4–9 15–22 %), and a squad above E leaks less; §6.2 a wave reaches the squad after the gate at its planned contact.
- **Fix (js/levelgen.js + LEAK_MODEL/WAVE_RULES data; do not change ZOMBIES.* zombie behaviour data such as crawler.hittableZ — enemies own it):** (a) per-type exposure windows — crawlers win_c = |hittableZ|/(v + crawler.speed) + lunge.dist/(v + lunge.speed), the 40 m model for the others — and solve HP so each type's share fits its own window; (b) per-type spawn timing at_t = contact − SPAWN_DIST·v/(v + speed_t) (or spawn faster types further back via a z offset) so runners arrive with the walkers, and reject placements where any unit's arrival falls inside a gate's armed window (waveAfterGateM clearance); (c) a pattern coverage factor — the fraction of the wave's zombies whose contact x lies inside the formation's shooter columns (formation half-width for E at that point, GDD §3.1, centred on the lane the cautious line takes) scales the DPS in the solve — or bias pattern x toward the lanes; update expectedLeak identically so the validator reports the real leak.
- **Verify:** node tools/validate-levels.js (every wave inside its band); node docs/build/qa/levels-early/qasmoke.mjs --scenario play --level 3 --shots 3 --after "$(cat docs/build/qa/levels-early/probe.js)" --out docs/build/qa/fix-level/p3 then node docs/build/qa/levels-early/ana.cjs docs/build/qa/fix-level/p3/report.json → ≈1 bite per 7-zombie wave, no runner bite within 10 m after a gate pass, ≤ 1 crawler bite per pack; repeat for --level 2 and --level 4.
- **Evidence:** docs/build/qa/levels-early/p3, p2, f2 (report.qa.tr / qa.ev via ana.cjs); docs/build/qa/levels-early/l3/10-play-37s.png ('lostPerWave'); js/levelgen.js:330-360, ~1170; js/data.js:251
- **Data keys:** `LEAK_MODEL`, `WAVE_RULES`

#### [LVL-5] The level that introduces a gate feature never shows it: no x3 at L6, no triple gate before L11, no ÷3 at L8

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major
- **What:** tools/validate-levels.js prints gates p/s/t L7 '7 6/1/0', L8 '8 7/1/0', L9 '8 8/0/0', L10 '9 9/0/0' and the first triple at L11 ('6/1/2'); docs/build/qa/levels-mid/stats.mjs: L6 x-lanes [] (no multiplier gate at all), L7 [2], L8 [2] with 0 ÷3, first x3 at L11; a live L7 run shows only single|pair layouts. The gain-band re-roll and the variant sweep (js/levelgen.js ~1031-1062) fold triples back into pairs.
- **Expected:** GDD §10 'New' column — L6 x3 gates, L7 triple gates, L8 ÷3 gates (§4.4 triples from L7, x3 base 25 % from L6, D ∈ {2, 3 (L8+)}); like §8's guaranteed new special and §6.2's newest zombie type in the last wave, the intro level must show its feature.
- **Fix (js/levelgen.js + tools/validate-levels.js):** a newFeature guarantee in generateLevel — L6 at least one xM with M = 3, L7 at least one triple event, L8 at least one ÷3 lane — exempt that event from the gain-band re-roll and the variant sweep (still within the survivability checks), and add a validator check that fails if an intro level lacks its feature; later levels keep their distribution.
- **Verify:** node tools/validate-levels.js and node docs/build/qa/levels-mid/stats.mjs → L6 shows an x3, L7 a triple, L8 a ÷3; node docs/build/qa/levels-mid/qa-smoke.mjs --level 7 --seconds 90 --after "$(cat docs/build/qa/levels-mid/probe.js)" --out docs/build/qa/fix-level/l7 → qaLog.gateEvents contains a triple.
- **Evidence:** node tools/validate-levels.js (gates p/s/t column); node docs/build/qa/levels-mid/stats.mjs; docs/build/qa/levels-mid/l7item/report.json (qaLog.gateEvents single|pair only)
- **Data keys:** `GATE_RULES.generation (new newFeature keys)`

#### [LVL-6] Coins are rounded per pickup, so replay ×0.6, endless ×0.6 and coin-multiplier ranks 1–4 do nothing on 1-coin events

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** major
- **What:** Level._addCoins (js/level.js:1131-1150) credits delta = Math.round(n·mult) per coin:pickup; 1-coin sources (walker/crawler kills, pile coins, MAX coins, which arrive one coin at a time) pay round(0.6) = 1 and round(1.4) = 1, while rank 5 (×1.5) pays 2 (×2). Replay run: base {max 10, gate 8, kill 12} → credited {10, 5, 10}, failed.runCoins 25 vs base 30 (×0.83 instead of ×0.6); coinMult rank 4 (×1.4): kill base 12 → 14 instead of ≈17.
- **Expected:** GDD §9.1 replay and endless pay 'everything × 0.6'; kill and boss coins × coin multiplier (§9.2 1 + 0.10n) — a smooth economy.
- **Fix (js/level.js):** keep a float accumulator per run (and per breakdown bucket), credit delta = floor(accumulated) − credited so far, and round only displayed/credited totals; a pickup may then credit 0 whole coins (emit coins:change with delta 0 or skip it — ui/fx must tolerate this; fx's J19 flight is driven by coin:pickup, not coins:change).
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 40 --out docs/build/qa/fix-level/replay --pre "$(head -n -1 docs/build/qa/rules-audit/probe-pre.js); g.save.recordLevel(1,{stars:1,survivors:1,score:1,coins:1})" --after "setTimeout(()=>g.squad.setCount(0,'debug'),26000)" then node docs/build/qa/rules-audit/readqa.cjs docs/build/qa/fix-level/replay/report.json → credited ≈ 0.6 × base (±1); the same with --pre "$(head -n -1 docs/build/qa/rules-audit/probe-pre.js); g.save.setUpgrade('coinMult',4)" → kill coins ≈ 1.4 × base.
- **Evidence:** docs/build/qa/rules-audit/replay-gameover and coinmult (readqa.cjs coins vs deltas; failed.runCoins 25); js/level.js:1131-1150
- **Data keys:** none

#### [UI-1] The tutorial hint pill covers the squad count exactly when the count matters (L1 'DRAG TO STEER', crate, red-gate, single-gate and boss hints)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** major
- **What:** #hint top (css/game.css:893) = min(--hint-y 73.46 % − 58u, 100 % − thumb − safe − 116u) ≈ 548–555 px on 390×844 (≈70 px tall), while the count label (GDD §3.1 world (squadX, 2.6 + 0.08√V, 0.8), 72 px) projects to y ≈ 589 — inside the hint box (probe 'labelY=589 hint=555-624'). 'DRAG TO STEER' hides '5'/'7' at the start of L1; 'GRAB THE CRATE' hides 34/158; 'RED TAKES SOLDIERS — SHOOT IT BLUE OR AVOID IT' hides 63/43 for the whole decision window; 'NO WAY AROUND — SHOOT IT DOWN' hides 39 while the single −40 approaches; 'SHOOT THE BOSS' covers 280.
- **Expected:** GDD pillar 5 / §5 — the count is the main readout and gate choices depend on it; §14 puts the hint at y 620, which collides with the §3.1 label at the GDD camera → move the hint (GDD amendment noted).
- **Fix (css/game.css, js/ui.js, data):** place #hint in the band below the HUD and above the gates' armed line — top = safe-top + 150·u (≈150–250 css on 390×844, below the boss bar at safe-top + 110 and the power-up row), hand icon above the text — and update JUICE.ui.hintY / --hint-y to match. For robustness on other aspects/cameras: whenever a hint is shown and on resize, project ctx.fx.label (x, y, z, hasPos; read-only) with ctx.render.camera to CSS px and, if the hint rect (+12 px margin) would overlap the label rect, move the hint above it. Keep it out of the thumb zone.
- **Verify:** node tools/smoke.js --scenario ui --out docs/build/qa/fix-ui/ui (05-play-start.png: count visible with 'DRAG TO STEER'); node tools/smoke.js --scenario play --level 3 --seconds 45 --shots 2 --out docs/build/qa/fix-ui/l3 (crate and red hints); node tools/smoke.js --scenario play --level 10 --boss --seconds 15 --shots 1 --after "g.squad.setCount(280,'debug')" --out docs/build/qa/fix-ui/boss ('SHOOT THE BOSS') → no hint overlaps the label, HUD, power-up pills or boss bar.
- **Evidence:** docs/build/qa/visual/ui/05-play-start.png + hintprobe afterResult; docs/build/qa/ui-shells/artifact/05-play-start.png, probe-settings/03-hud-large-low.png, probe-hud/probe.json; docs/build/qa/levels-early/l3/10-play-37s.png, l3/11-play-41s.png, l3nobot/10-play-37s.png, l4/10-play-37s.png; docs/build/qa/levels-mid/l8/07-play-37s.png, l6item/11-play-41s.png, l10boss/02-play-3s.png
- **Data keys:** `JUICE.ui.hintY`

#### [AUD-1] The gate tick pitch falls while shooting a red (−N) gate, and barely moves on × / ÷ gates

- **Group:** audio (js/audio.js) · **Severity:** major
- **What:** the gate:hit listener sets o.value = Math.abs(p.value − g.base) (js/audio.js:1670-1680); for a −N gate p.value is signed (−15 … +15) while the view's base is the magnitude (gates _syncView base = |raw|, js/gates.js:612-618), so the value is 30 at spawn and falls: −15 → −14 at 794 Hz, 0 at 710 Hz, +14 at 626 Hz, +15 at 620 Hz — the pitch drops through all 30 hits. x2/x3/x4 sit at 620/626/632 Hz.
- **Expected:** GDD pillar 1 'a pitch-climbing tick', J3/§13 f = clamp(620 + 6·(value − base), 620, 2200) with base = the spawn value (−15 for a red gate) → 620 Hz climbing to ≈800 Hz.
- **Fix (js/audio.js only):** signedBase = g.op === '-' ? −g.base : g.base; o.value = p.value − signedBase for + and − gates; for x and ÷ gates drive the pitch from the cumulative weighted hits on that gate (sum p.weight into a preallocated Float32Array indexed by g.id & 0xFFF, reset on gate:spawn / gate:pass) so it climbs with the ring progress; no per-hit allocation.
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 12 --nobot --out docs/build/qa/fix-audio/gates --pre "$(cat docs/build/qa/rules-audit/probe-pre.js)" --after "$(cat docs/build/qa/rules-audit/probe-after-gates.js)" then node docs/build/qa/rules-audit/readqa.cjs docs/build/qa/fix-audio/gates/report.json → tick Hz rises monotonically on the −15 gate and on x gates.
- **Evidence:** docs/build/qa/rules-audit/gates-probe2 (readqa.cjs ticks: 794 → 620 Hz falling; x2/x3/x4 620/626/632 Hz); js/audio.js:1670-1680; js/gates.js:612-618, 773
- **Data keys:** none

#### [CORE-1] Boot: the boot bar freezes, then a 2.8 s first-frame stall while shader programs link — await the render warm-up during boot

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** major
- **What:** the boot bar stays at 46 % 'Painting the road…' from 3.78 s to 8.83 s and then jumps to the title; a CPU profile of boot shows 2839 ms of three's WebGLProgram link (onFirstUse) inside Engine._onFrame → render.draw versus 464 ms for the whole main.js boot(). main.js never yields between steps and nothing pre-compiles shaders.
- **Expected:** GDD §14 Boot — the bar reflects the texture build (≈120 ms) and font wait (≤ 1.5 s) and the title appears responsive.
- **Fix (js/main.js):** after step 9 (systems) and before ui.hideBoot(), await ctx.render.warmup() when it exists (VIS-2; guard typeof === 'function', catch errors) mapped to a new PROGRESS range (e.g. 0.95 → 0.99); insert an await yieldFrame() (requestAnimationFrame / setTimeout 0) between the boot steps so the bar repaints.
- **Interface:** VIS-2 implements render.warmup(): Promise<void>.
- **Verify:** node docs/build/qa/ui-shells/boottime.mjs → the bar advances without a multi-second freeze and the title is responsive on arrival; node tools/smoke.js --scenario boot --out docs/build/qa/fix-core/boot is CLEAN; the first gameplay frames after PLAY stay < 60 ms.
- **Evidence:** node docs/build/qa/ui-shells/boottime.mjs (46 % from 3.78 s to 8.83 s); node docs/build/qa/ui-shells/bootprof.mjs (2839 ms onFirstUse vs 464 ms boot()); js/main.js:150-239
- **Data keys:** none

### Minor (31)

#### [VIS-9] Gate panel shader: the hit flash adds pure white (panel hue lost under fire, also on Low) and far +N panels read lavender/purple

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** minor
- **What:** (a) PANEL_FRAG adds col += vec3(1.0)·flash·0.9 (js/materials.js:309-311), so any sustained flash turns the panel neutral white/grey — on Low (no bloom) the '+31' panel under fire averaged #C7C1C5 instead of blue. (b) At spawn/armed distance the 38 %-opacity +N panel over the orange fog/sky reads lavender (#BBA9C7 / #BAA7C7, hue ≈275°), close to the special-gate purple (#C684A7).
- **Expected:** GDD §4.1 hue is a primary cue (+N #2E9BFF, special #C77DFF) and must stay readable while shot and ~2 s before the armed line.
- **Fix (js/materials.js only; GATE_RULES keys belong to gates):** (a) the hit flash brightens the type's own colour — e.g. col = mix(col, tint·1.6 + 0.12, clamp(flash, 0, 1)·0.6) — and a white flash is kept only for the flip flash (flash > 1 path); (b) cap the gates' fog factor at ≈0.5 and fog toward a desaturated fog colour in the panel/frame/glyph shaders, and raise panel alpha/saturation with distance (e.g. alpha ×(1 + 0.6·fogFactor)) so the hue survives over the orange background.
- **Interface:** GAT-1 lowers and rate-limits the flash value (iPanel.z) this shader receives.
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 20 --shots 1 --quality low --out docs/build/qa/fix-visual/l1low (and --quality high --out docs/build/qa/fix-visual/l1high); sample panel colours with node docs/build/qa/visual/tools/sample.mjs <png> x y w h → +N panel hue 200–225° at spawn (z ≈ −60) and under fire; item lane hue ≥ 270°.
- **Evidence:** docs/build/qa/visual/l9/12-play-48s.png (Low, '+31' panel #C7C1C5/#CBC5C7 under fire); docs/build/qa/visual/l1/01-play-1s.png and weapons/08-play-12s.png (+N panels #BBA9C7/#BAA7C7/#BBA1C1); l9/12-play-48s.png (item lane #C684A7)
- **Data keys:** none

#### [VIS-10] Four-way gate type encoding incomplete: no double chevrons on × / ÷, no pentagon top on item lanes, ÷ panels look like −

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** minor
- **What:** the gate frame (js/models.js:826-856 buildGateFrame) is one shared shape with single chevrons and materials.js only rotates chevrons on negative types; all panels have one shape. So + vs × vs item differ only by hue (the purple item frame is identical to a + gate) and ÷ (#E0346E) vs − (#FF3B4E) are near-identical red striped panels.
- **Expected:** GDD §4.1 encoding without colour: rounded top + up-chevrons (positive), square top + hazard stripes + down-chevrons (negative), double chevrons for × and ÷, pentagon top for specials.
- **Fix (js/materials.js panel shader, keyed on the per-instance type in iPanel.x — the frame geometry in models.js stays as is):** (1) corner shape per type: rounded for + / × / item, square for − / ÷; (2) a chevron mark in the panel's top band: '^' for +, '^^' for ×, 'v' for −, 'vv' for ÷; (3) a pentagon (peaked) top edge for item lanes; (4) ÷ hazard stripes in the opposite diagonal (or a dotted pattern) so ÷ ≠ − without colour. Keep the ring gauge and the MAX pill (VIS-7) working.
- **Verify:** node tools/smoke.js --scenario play --level 5 --seconds 40 --shots 4 --out docs/build/qa/fix-visual/l5 ('+7 | item' gate) and the L9 run of VIS-5 ('−25 | ÷3') → each type distinguishable in a greyscale crop.
- **Evidence:** docs/build/qa/levels-mid/crop-l5-item.png (from l5/05-play-25s.png), levels-mid/l10/05-play-25s.png (single chevrons on x); docs/build/qa/visual/crop-div35.png (÷ vs − panels)
- **Data keys:** none

#### [GAT-5] A flipped red gate shot up to +base becomes a gold MAX gate and pays MAX coins

- **Group:** gates (js/gates.js, js/pickups.js) · **Severity:** minor
- **What:** for OP_MINUS gates.js sets maxedNow once flipped and value ≥ flipCap (js/gates.js:911-915), accrues per-hit MAX coins (:902-903) and pays GATE_RULES.coins.max (5) on pass (:1177); probes show the −15 gate maxed (maxes ['-', 15, 15, 30]) and 10 c of MAX coins from it, also in the L1 bot run.
- **Expected:** GDD §4.2 — the −N row's terminal state is 'continues +1 per hit up to +base' with no MAX badge; MAX coins (§9.1) belong to +N gates.
- **Fix (js/gates.js):** for OP_MINUS clamp the value at flipCap without setting _maxed, without _maxCoinAcc and without gate:max; pay GATE_RULES.coins.pass on pass.
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 12 --nobot --out docs/build/qa/fix-gates/red --pre "$(cat docs/build/qa/rules-audit/probe-pre.js)" --after "$(cat docs/build/qa/rules-audit/probe-after-gates.js)" then node docs/build/qa/rules-audit/readqa.cjs docs/build/qa/fix-gates/red/report.json → no maxes entry for the '-' gate and no 'max' coins from it.
- **Evidence:** docs/build/qa/rules-audit/gates-probe2 and l1-econ (readqa.cjs: maxes ['-',15,15,30] / ['-',15,15,31.59], coins.max includes 10 c from the −15 gate); js/gates.js:902-915, 1177
- **Data keys:** none

#### [FX-3] Boss/brute damage numbers bloom into white blobs, pile on top of each other and repeat identical merged totals ('275 275')

- **Group:** fx (js/fx.js) · **Severity:** minor
- **What:** _numberSpawn (js/fx.js:1262-1290) uses HDR_WHITE (2.5) for white numbers; boss hits are merged per NUMBER_FLUSH_S = 0.3 s (fx.js:130), so constant DPS yields identical consecutive totals ('275 275', '406 406'); the ±0.5 m spawn jitter is too small at boss scale ('100 154 9' piled over the rig).
- **Expected:** GDD §6.1 floating damage numbers on brutes and bosses (value = round(w·d)) that are legible and read as varied hits; only crits (sniper, gold) glow.
- **Fix (js/fx.js + data):** normal numbers at gain ≤ 1.0 with the atlas outline, crits keep HDR ≈1.6 and NUMBER_CRIT_SCALE; JUICE.damageNumber.mergeSeconds (new) ≈0.12 s; alternate boss numbers ±0.6–0.9 m in x and rise vertically; at most 3 live numbers per boss (fade the oldest early).
- **Verify:** node tools/smoke.js --scenario play --level 1 --boss --seconds 25 --shots 1 --quality high --after "g.squad.setCount(120,'debug')" --out docs/build/qa/fix-fx/numbers → numbers readable, varied, not stacked.
- **Evidence:** docs/build/qa/visual/l1boss120/08-play-12s.png, 09-play-14s.png; docs/build/qa/bosses/P15/05-play-13s.png, P17/05-play-13s.png, L1/06-play-16s.png; docs/build/qa/levels-mid/l5boss/05-play-9s.png ('275 275'), l10boss/04-play-7s.png ('406 406')
- **Data keys:** `JUICE.damageNumber.mergeSeconds (new)`

#### [FX-4] Gate-pass shatter shards fly into the camera and hide the squad, the count and the '+N' payoff

- **Group:** fx (js/fx.js) · **Severity:** minor
- **What:** on a positive pass ≈20 opaque light-blue shards 80–120 px wide cover the squad and the count at the moment it jumps: shards are ≈0.6 × 0.6 m (cw/0.5 scale), opacity 0.8, SHARD_GLOW 1.6 HDR (toneMapped false), z velocity 3–6 m/s + road speed toward the camera, no fade (js/fx.js ~1580-1680, SHARD_GLOW :139).
- **Expected:** GDD J7 — the panel shatters, but the hero beat is the soldiers spawning, the count tween and the '+N' burst.
- **Fix (js/fx.js):** on positive passes use vz = 0.35·sp + road (not the full speed toward the camera), lateral out·(2 + 2·rnd), vy 2–4 m/s; size ×0.55; fade colour/opacity by (1 − u)²; SHARD_GLOW 1.6 → 1.0; renderOrder below the label (42) and floaters (41).
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 12 --shots 0.25 --quality high --out docs/build/qa/fix-fx/shards → squad, count and '+N' burst visible 0.1–0.4 s after the first pass.
- **Evidence:** docs/build/qa/visual/l1-nobloom/05-play-9s.png; docs/build/qa/visual/weapons/12-play-18s.png
- **Data keys:** none

#### [FX-5] '−1' soldier-loss floaters spawn under the count label and get hidden or garbled by it

- **Group:** fx (js/fx.js) · **Severity:** minor
- **What:** loss floaters start at the death position with LOSS_FLOATER_Y 1.9 (js/fx.js:143); front-row deaths project onto the label, which is drawn after the floaters (label renderOrder 42 > floaters 41), so '−1' is half hidden behind '36' or reads as glyph debris next to '107'.
- **Expected:** GDD §5 / J10 — the '−1' floater (merged '−k' within 100 ms), the count snap and the red flash read as a loss.
- **Fix (js/fx.js):** spawn loss floaters beside the label — x = label.x − (label width/2 + 0.45 m), y = label.y, z = label.z, rising up-left (keep the −k merge) — or keep the world position but start at label.y + 0.9 m with renderOrder 43.
- **Verify:** node tools/smoke.js --scenario play --level 5 --seconds 60 --shots 3 --out docs/build/qa/fix-fx/loss → '−1/−k' readable next to the count whenever soldiers die.
- **Evidence:** docs/build/qa/visual/l5/08-play-29s.png, l5/14-play-54s.png, l1boss120/09-play-14s.png
- **Data keys:** none

#### [CHR-3] The squad has no contrast against the road: olive soldiers on dark asphalt read as a dark carpet (Medium/Low)

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** minor
- **What:** sample.mjs — Medium l1/05-play-21s.png squad region #262714 (luma 37) vs road #2F2422 (38); High rocket/06-play-6s.png 59 vs 41; Low a uniform dark-olive slab; makeCharacterMaterial (js/models.js:1241) has no rim/fresnel term and the palette is uniform #5E6B3A, helmet #556039.
- **Expected:** GDD §1/§3.1 the squad (the player's avatar) must pop on every tier (§16 'low tier still looks good').
- **Fix (js/models.js + PALETTE.soldier):** a cheap rim/top light for soldier classes only (fragment injection: totalEmissiveRadiance += vec3(1.0, 0.82, 0.6)·0.3·pow(1 − saturate(dot(normal, viewDir)), 2.5) + ≈0.1 up-facing sky fill); helmet → ≈#7C8C4A and uniform ≈+20 % value; optionally a small team accent (helmet band #2E9BFF or backpack #D9B25A). Zombies keep their palettes. Target: squad mean luma ≥ 1.5× road luma on Medium and Low.
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 25 --shots 4 --quality med --out docs/build/qa/fix-characters/med (and --quality low --out docs/build/qa/fix-characters/low) + node docs/build/qa/visual/tools/sample.mjs on squad vs road regions.
- **Evidence:** docs/build/qa/visual/l1/05-play-21s.png + crop-squad21.png, rocket/06-play-6s.png, l1/10-play-46s.png, l1/16-play-67s.png
- **Data keys:** `PALETTE.soldier.helmet`, `PALETTE.soldier.uniform`, `PALETTE.soldier.accent (new)`

#### [CHR-4] From L10 a spitter splash consumes 2 armour plates instead of 1 (GEAR.armor.costSpit unused)

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** minor
- **What:** spit globs call squad.removeSoldiers(2, 'spit') from L10 (js/zombies.js:1355, 1401; boss spit3/rain also use reason 'spit') and removeSoldiers consumes min(n, plates) plates for absorbing reasons (js/squad.js:493-504): every spit shows platesBefore 50 → 48 → 46. GEAR.armor.costSpit / costBrute (js/data.js:481) are never read.
- **Expected:** GDD §6.1/§8.2 'brute swing consumes 3 plates, spit 1' — one plate absorbs a whole splash.
- **Fix (js/squad.js):** for reason 'spit' with plates > 0 consume min(GEAR.armor.costSpit, plates) plates and absorb the whole splash (all n soldiers); 'bite' keeps consuming min(n, plates) (a brute swing is one call with n = 3 = costBrute).
- **Verify:** node tools/smoke.js --scenario play --level 10 --seconds 24 --nobot --out docs/build/qa/fix-characters/spit --after "$(cat docs/build/qa/rules-audit/probe-after-spit.js)" then node docs/build/qa/rules-audit/readqa.cjs docs/build/qa/fix-characters/spit/report.json → each spit {n: 2, platesBefore: 50, platesAfter: 49}.
- **Evidence:** docs/build/qa/rules-audit/spit-probe (readqa.cjs: {n:2, platesBefore:50, platesAfter:48}, then 48→46); js/squad.js:493-504; js/data.js:481
- **Data keys:** none

#### [CHR-5] Spitter Queen and Juggernaut are base zombies uniformly stretched to 7 m (spindly silhouettes instead of 'bloated' / 'armoured')

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** minor
- **What:** BossRigFactory.build (js/models.js:1896-1925) scales every rig uniformly to BOSSES.rigHeight (scale = H / partsTop(parts)), so archetype proportions never change; bossBodyParts adds only a lower arm pair for the Queen and pauldrons, helmet and one thin chest plate for the Juggernaut. Unshot: the Queen is a thin torso on very long thin legs with an unreadable second arm pair; the Juggernaut is a tall hunched walker on stick legs.
- **Expected:** GDD §7 'Spitter Queen: 2.6× spitter, bloated, 4 arms, pulsing sacs'; 'Juggernaut: 4.5× walker, armour plates' — identifiable at 12 m on a phone.
- **Fix (js/models.js):** per-archetype non-uniform scaling before height normalisation — Queen: torso width/depth ×1.6, legs ×0.7, a large abdomen/sac cluster (sacs #C7E84B in the glow material so they can pulse), a readable second arm pair; Juggernaut: legs ×0.75 and thicker, wider shoulders, 4 large plates (chest, shoulders, thighs) as plate0–3. Same rig contract and draw-call rule as CHR-1.
- **Verify:** unshot rigs with the CHR-1 command at --level 5 (count 190) and --level 10 (count 280), out docs/build/qa/fix-characters/M5 and M10.
- **Evidence:** docs/build/qa/bosses/M5/06-play-11s.png, M10/06-play-11s.png
- **Data keys:** none

#### [CHR-6] Troops can't be told apart inside the blob: the drone is a flat cross, the APC an untextured slab, the medic a 10 px dot

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** minor
- **What:** with all five troops added only the APC (featureless khaki box) and the drone (flat beige 'X') are visible; the medic is a 10 px white-blue dot and the sniper and flamer are indistinguishable; at L5 the sniper is a dark helmet clipped at the bottom edge.
- **Expected:** GDD §8.3/§15 — sniper on a crate with a #7FE8FF lens, medic with a white cross, flamer with a #E07A2A tank, drone LED #39E58C, APC headlights #FFF1C2; each troop is a purchase-level reward and must be identifiable.
- **Fix (js/troops.js, js/models.js + data):** scale troops ×1.4; raise the sniper crate 0.5 → 1.0 m; a coloured additive ground ring per troop (0.6 m, ≈0.5: medic #3BE57A, sniper #7FE8FF, flamer #FFB347); APC wheels, hatch, panel lines and emissive headlights (≈1.5); drone semi-transparent spinning rotor discs + LED emissive ≈2.0; medic cross readable from above. Keep draw calls in budget (instancing / merged parts).
- **Verify:** node tools/smoke.js --scenario play --level 12 --seconds 10 --shots 1 --quality high --after "g.squad.setCount(80,'debug'); ['troop.sniper','troop.medic','troop.flamer','troop.drone','troop.apc'].forEach((id)=>g.pickups.grantItem(id,0,0))" --out docs/build/qa/fix-characters/troops → each troop identifiable.
- **Evidence:** docs/build/qa/visual/weapons/02-play-3s.png + crop-troops3.png; docs/build/qa/visual/l5/14-play-54s.png
- **Data keys:** `TROOPS.*.scale (new)`

#### [ENE-7] boss.js ignores the BOSSES tuning in data.js: duplicate DATA-MISSING literals shadow approachSpeed, holdGain, anim, glob, car, plateFly, death.fall… (do this first)

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** minor
- **What:** js/boss.js:29-79 defines APPROACH_SPEED, HOLD_GAIN, ARRIVE_M, FIRST_ATTACK_DELAY, RECOVER_SECONDS, CHARGE_SPEED/DURATION, CHARGE_STOP_Z, STOMP_RADIUS, SPIT3_SPREAD, SPIT_JITTER, RAIN_*, GLOB_*, MINION_BEHIND_M, PLATE_*, CAR_*, ANIM, FALL_*, BLOB_SCALE as literals while js/data.js:363-386 already holds the same values (BOSSES.approachSpeed, holdGain, arriveM, firstAttackDelay, recoverSeconds, chargeDefaults, chargeStopZ, stompRadius, spit3SpreadM, spitJitterM, rainBox, minionSpawnBehindM, glob, plateFly, car, blobShadowScale, anim, death.fall); grep finds those keys only in boss.js comments.
- **Expected:** ARCHITECTURE §1 — tuning lives in data.js and the module reads it; ENE-2/3/5/10/11 are data tweaks.
- **Fix (js/boss.js):** replace the literals with reads of BOSSES.* (e.g. const APPROACH_SPEED = BOSSES.approachSpeed; const ANIM = BOSSES.anim) and delete the DATA-MISSING block; behaviour must be identical before the other ENE fixes.
- **Verify:** node tools/smoke.js --scenario play --level 1 --boss --seconds 40 --after "g.squad.setCount(140,'debug')" --out docs/build/qa/fix-enemies/data → CLEAN, same boss behaviour.
- **Evidence:** js/boss.js:29-79 vs js/data.js:363-386
- **Data keys:** none

#### [ENE-8] Hulk Twins and Colossus Prime show the base name ('HULK' / 'COLOSSUS') on the name card and boss bar

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** minor
- **What:** resolveArchetype (js/boss.js:122-150) seeds name from the root archetype and BOSSES.archetypes.hulkTwins / colossusPrime have no name key → ncText 'BOSSHULK' (L17) and 'BOSSCOLOSSUS' (L20); boss:spawn name 'HULK'/'COLOSSUS'.
- **Expected:** GDD §7/§10 'Hulk Twins' (L17, L25, L29) and 'Colossus Prime' (L20, L30) are milestone reveals on the 1.5 s name card.
- **Fix (data):** add name: 'HULK TWINS' and name: 'COLOSSUS PRIME' to BOSSES.archetypes.hulkTwins / colossusPrime (the merge loop already lets derived keys win).
- **Verify:** L17/L20 boss runs (ENE-6 command with --level 17/count 480 and --level 20/count 600) → node docs/build/qa/bosses/qa.cjs <run> s | grep ncText shows the new names.
- **Evidence:** node docs/build/qa/bosses/qa.cjs P17 s (ncText 'BOSSHULK'), P20 ('BOSSCOLOSSUS')
- **Data keys:** `BOSSES.archetypes.hulkTwins.name`, `BOSSES.archetypes.colossusPrime.name`

#### [ENE-9] Boss rigs cast shadows from every small part: twins 101 draw calls (shadow 34); a single boss reaches main 52 / shadow 25

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** minor
- **What:** _buildRigRecord sets castShadow on every rig mesh except 'shield' and 'core' (js/boss.js:300-305), overriding models.js, so the jaw, glow children (eyes), plates and chains each add a shadow draw: twins main 53 / shadow 34 / post 14 (P17 overlay '!!'); single boss on High with 600 soldiers shadowMax 25 and mainMax 52 (298 of 965 frames over 50).
- **Expected:** GDD §16 ≤ 50 main-pass draws (+ ≈20 shadow, ≤ 14 post).
- **Fix (js/boss.js):** castShadow only for the big parts (torso, legs, arms, head) — not jaw, glow meshes, plates, chains, core or shield; for twins consider torso + legs only. Main-pass savings come from CHR-1/CHR-5 merging sub-pieces into part meshes.
- **Verify:** node docs/build/qa/perf/perfprobe2.mjs --level 9 --quality high --boss --seconds 25 --after "g.squad.setCount(600,'debug')" --out docs/build/qa/fix-enemies/boss-high → shadowMax ≤ 20; L17 twins run overlay shadow ≤ 24.
- **Evidence:** docs/build/qa/bosses/P17/02-play-4s.png, M17/06-play-11s.png (overlay calls); docs/build/qa/perf/probe2-boss-high/perf.json drawCalls (mainMax 52, shadowMax 25)
- **Data keys:** none

#### [WPN-2] Tracers clip to white: the rifle isn't warm, the minigun's 'thin yellow tracers' look identical to the rifle, and Low draws aliased 1 px white slashes

- **Group:** weapons (js/weapons.js) · **Severity:** minor
- **What:** PALETTE.tracer.rifle (3.0, 2.6, 1.6) and WEAPONS.minigun.tracer (3.5, 3.5, 2.5) both tone-map to near-white, so the minigun stream (240 bullets) looks exactly like the rifle; on Low the 0.04 m tracer boxes (js/weapons.js:381-386) render as stair-stepped white slashes with no glow substitute (only gates get Low glow quads).
- **Expected:** GDD J1 warm tracer; §8.1 minigun 'thin yellow tracers'; §16 Low 'bloom off → glow quads + emissive +30 %'.
- **Fix (js/weapons.js + data):** PALETTE.tracer.rifle → ≈[2.6, 1.7, 0.6] (stays golden through ACES); WEAPONS.minigun.tracer and PALETTE.tracer.minigun → ≈[3.4, 2.6, 0.35] (blue near 0) with a thinner minigun tracer (x/y scale ≈0.6 via the instance matrix, new WEAPONS.minigun.tracerScale); on Low (ctx.quality.params.bloom === 'off') add an additive glow quad per tracer head (render.textures.glow, ×1.3, one extra InstancedMesh created at init) or widen tracers into a 0.10 m camera-facing ribbon. Keep the fire-rate chip's cyan tint.
- **Verify:** node tools/smoke.js --scenario play --level 3 --seconds 45 --shots 3 --quality high --out docs/build/qa/fix-weapons/tracers (rifle golden; minigun yellow and thinner once picked up) and --quality low --out docs/build/qa/fix-weapons/tracers-low (soft glow, no 1 px slashes).
- **Evidence:** docs/build/qa/visual/l1/03-play-9s.png + crop-tracers9.png; docs/build/qa/visual/l1/10-play-46s.png and l2low/03-play-11s.png (Low); docs/build/qa/levels-early/l3nobot/09-play-33s.png (rifle) vs 11-play-41s.png (minigun)
- **Data keys:** `PALETTE.tracer.rifle`, `PALETTE.tracer.minigun`, `WEAPONS.minigun.tracer`, `WEAPONS.minigun.tracerScale (new)`

#### [WPN-3] The rocket launcher reads weakly: tiny projectile, smoke trail invisible on the asphalt

- **Group:** weapons (js/weapons.js) · **Severity:** minor
- **What:** the rocket is ≈15 px with a small flame, and the trail is FX smoke #5A5A5A on #3B3B44 asphalt, 0.45 m, 0.8 s (js/weapons.js:70-80, O_SMOKE :145, fx.emit('smoke') :1085-1088).
- **Expected:** GDD §8.1 rocket 'smoke trail, orange burst' — the most visible pickup at L9.
- **Fix (js/weapons.js + data):** emit the trail with opts.colorIdx = FX_COLOR.dust (light tan, exported by js/fxmaterials.js; don't change PALETTE.fx.smoke) or white at reduced alpha, size 0.45 → 0.8 m, life 0.8 → 1.2 s; rocket mesh scale ×1.6; flame cone length ×2 with HDR ≈[3.0, 1.6, 0.5]; move these literals to WEAPONS.rocket.smoke / flame / meshScale.
- **Interface:** FX-9 enlarges the blast.
- **Verify:** node tools/smoke.js --scenario play --level 9 --seconds 9 --shots 0.4 --quality high --after "g.squad.setCount(40,'debug'); g.weapons.startWeapon('weapon.rocket')" --out docs/build/qa/fix-weapons/rocket → visible trail and projectile.
- **Evidence:** docs/build/qa/visual/rocket/03-play-3s.png, crop-rocket3.png
- **Data keys:** `WEAPONS.rocket.smoke (new)`, `WEAPONS.rocket.flame (new)`, `WEAPONS.rocket.meshScale (new)`

#### [WPN-4] Rocket, railgun and laser gate and shield hits ignore the bullet weight w

- **Group:** weapons (js/weapons.js) · **Severity:** minor
- **What:** gates.applyHit(..., def.gateHits = 8) for rockets (js/weapons.js:1128, 1139), 10 for rail bolts (:1188) and gateHitsPerSec·dt for the laser (:1270); boss.damage gets the same unweighted values as the shield weight (:1124, :1186).
- **Expected:** GDD §8.1 (authoritative) 'Gate hit equivalences are weighted hits (×w) and are subject to the 40 hits/s intake cap' → rocket 8·w, rail 10·w, laser 10·w/s (the data.js:444 comment agrees; ARCH §7 lists fixed 8/10 — ARCH amendment noted).
- **Fix (js/weapons.js):** multiply these gate and shield weights by the base bullet weight w = max(1, C/FIRE.weightDiv); the gates' intake bucket and ENE-6's shield intake cap still bound them.
- **Verify:** node tools/smoke.js --scenario play --level 9 --seconds 30 --shots 4 --after "g.squad.setCount(400,'debug'); setTimeout(()=>g.weapons.startWeapon('weapon.rocket'),3000)" --out docs/build/qa/fix-weapons/rocketw → rocket hits on a gate register 8·w (capped by the 40 hits/s intake; debug overlay hitsPerGate).
- **Evidence:** js/weapons.js:1124-1139, 1186-1188, 1270; GDD §8.1 header; js/data.js:444
- **Data keys:** none

#### [WPN-5] Weapons hot paths allocate ≈1 MB/s (boxed doubles across non-inlined calls) and markUpdate reallocates updateRanges

- **Group:** weapons (js/weapons.js) · **Severity:** minor
- **What:** the sampling heap profile attributes 26.6–33.4 MB/min to _stepBullets (js/weapons.js:939) and 18.2–31.1 MB/min to _renderTracers (:1376) although the bodies allocate nothing at source level: doubles passed to non-inlined calls are boxed — writeDirMatrix with 12 numeric args (:1406), this._sweep(..., px, pz + road, nx, nz, radius) (:960) fanning out to four zombies.hitTestSegment(x0, z0, x1, z1, r, OUT) calls (:968-971); %GetOptimizationStatus shows them maglev/maybeDeopted. markUpdate (js/weapons.js:198-210) has the updateRanges reallocation of GAT-4.
- **Expected:** GDD §16 zero per-frame allocations.
- **Fix (js/weapons.js only; do not change zombies.hitTestSegment's signature):** inline the matrix write into the tracer loop (or pass the tracer index and read x/z/yaw from the typed arrays inside the callee); make _sweep read its segment from scratch Float64Array fields instead of 5 numeric args; keep these functions monomorphic (check with --js-flags=--trace-deopt); markUpdate keeps its range permanently (no-op clearUpdateRanges).
- **Verify:** node docs/build/qa/perf/perfprobe.mjs --level 9 --quality high --seconds 60 --after "g.squad.setCount(600,'debug')" --heapprof --out docs/build/qa/fix-weapons/heap → weapons.js entries in alloc[] < 2 MB/min in total; no fps regression.
- **Evidence:** docs/build/qa/perf/probe-l9-high/perf.json and probe-l9-600/perf.json alloc[]; docs/build/qa/perf/probe2-alloc/perf.json opt (maglev / maybeDeopted)
- **Data keys:** none

#### [LVL-7] L2's guaranteed new special (armor crate) lands on a random half and is missed by a player following the gates (same for L4's magnet)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor
- **What:** crates get x = rng.pick(WORLD.laneCenters.pair) (js/levelgen.js:1243); at L2 the armor crate ({at:190, x:−2}) arrives at d ≈ 260 just as the next gate (−15 | +11, armed from d ≈ 257) asks for x = +2, so the bot runs l2/p2 never collect it (armor 0 all level, no crate:open gear.armor) while forcing the left lane (f2) collects it. In L4 the guaranteed magnet competes with +15 and the armor with +35; the bot collected neither.
- **Expected:** GDD §8 'the level's newly unlocked special is guaranteed' — a first-time player should meet it without giving up the obvious gate lane.
- **Fix (js/levelgen.js):** put the guaranteed (newly unlocked) special's crate on the half of the next gate's cautious/better lane (or x = 0), or deliver it as an item lane ('item | +A'); bag specials stay random.
- **Verify:** node tools/smoke.js --scenario play --level 2 --out docs/build/qa/fix-level/l2 → timeline armor > 0 after the crate; node tools/smoke.js --scenario play --level 4 --out docs/build/qa/fix-level/l4bot → the magnet is collected.
- **Evidence:** docs/build/qa/levels-early/l2 and p2 (armor 0; no crate:open gear.armor), f2 (crate:open gear.armor at z=−31); node docs/build/qa/levels-early/dump.mjs 2 and 4
- **Data keys:** none

#### [LVL-8] Crawlers never come in packs of 6–10 at their unlock level (L3: one solo crawler plus a group of 3)

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor
- **What:** js/levelgen.js:826-833 accumulates crawlerDebt += P·share = 7·0.15 = 1.05 per wave, which never reaches pack[0] = 6; the last-wave newest-type insertion (:873) adds min(6, floor(P/2)) = 3 (dump.mjs 3: intro {at 238, crawler 1}, last wave {walker 2, runner 2, crawler 3}).
- **Expected:** GDD §6.1 crawler 'packs of 6–10' — L3's headline type should show its swarm (dust trails, lunging carpet) at least once.
- **Fix (js/levelgen.js):** at the unlock level insert one full pack (≥ pack[0] = 6, taking slots from walkers/runners, allowed to exceed the P share once), or seed crawlerDebt with pack[0] − P·share at the first eligible wave; re-solve that wave's HP with LVL-4's per-type window.
- **Verify:** node docs/build/qa/levels-early/dump.mjs 3 → one wave with ≥ 6 crawlers; validate-levels keeps it inside the leak band.
- **Evidence:** node docs/build/qa/levels-early/dump.mjs 3; docs/build/qa/levels-early/p3 (4 crawlers in total)
- **Data keys:** none

#### [LVL-9] Endless crates hand out specials that aren't unlocked yet, and endless never uses item-lane gates

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor
- **What:** generateChunk uses item: rng.pick(PICKUP_SCHEDULE) (js/levelgen.js:1495) over all 14 specials: at D1 (Leq 11) crates include weapon.laser ×4 (unlock L14), weapon.railgun ×2 (L13) and troop.apc ×7 (L12) over 40 seeds; no endless chunk has an 'item | +A' gate.
- **Expected:** GDD §8 'after its unlock level a special joins the random bag'; delivery 50 % special gate / 50 % crate; the endless equivalent level is endlessUnlock + D (js/level.js:53).
- **Fix (js/levelgen.js):** build the bag from PICKUP_SCHEDULE entries with unlock ≤ p.Leq (reuse the campaign bag helper around :927-946) and route about half of the deliveries through the itemPlus gate pattern like generateLevel.
- **Verify:** node docs/build/qa/levels-mid/endless-crates.mjs → no locked specials at D1/D2 and some item|+A gates.
- **Evidence:** node docs/build/qa/levels-mid/endless-crates.mjs; docs/build/qa/levels-mid/endless-long/report.json qaLog.items (weapon.railgun crate)
- **Data keys:** none

#### [LVL-10] Endless results distance disagrees with the score, and campaign 'Reached N %' is measured after the death run-on

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor
- **What:** metres are scored only while running (js/level.js:712), but _finishEndless (:1327-1331) and _finishLost (:1305-1311) read ctx.world.distance 1.2 s after squad:dead while the road keeps scrolling → 'Score 33 / Distance 40 m' with 0 kills and 0 gates.
- **Expected:** GDD §10.1 score = metres + …, so the results distance and the score's metres match; §14 game over 'Reached N %' is where the squad was lost.
- **Fix (js/level.js):** store this._deathDistance = ctx.world.distance in _onSquadDead (:1205) and use it in both finishers (reset on level start).
- **Verify:** node tools/smoke.js --scenario play --endless --nobot --seconds 25 --pre "g.save.data.highestUnlocked=11" --after "setTimeout(()=>g.squad.setCount(0,'debug'),4000)" --out docs/build/qa/fix-level/endless-die → 02-result.png distance equals the metres in the score.
- **Evidence:** docs/build/qa/ui-shells/endless-die/02-result.png; js/level.js:712, 1205, 1305-1331
- **Data keys:** none

#### [LVL-11] Debug distance jumps (smoke --boss) spawn every skipped wave and gate at once into the boss fight

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** minor
- **What:** tools/smoke.js --boss sets world.distance = length − 20; the event cursor loop in Level.step (js/level.js:638-641) then fires every skipped event in one step: 131 zombies at t = 1.6 s (L10), 206 (L15), 231 (L17), 255 (L20); boss HP stuck, squad lost; gate hints ('SHOOT THE GATE!', 'X2 DOUBLES YOUR SQUAD') pop during the boss and L1 survivors inflate to 402 through gate passes after the boss died — boss QA numbers are invalid without manual clearing. tools/smoke.js belongs to no fixer group, so fix it in the game.
- **Expected:** a distance jump yields a representative boss fight (run-up horde only).
- **Fix (js/level.js + data):** in the cursor loop consume without spawning any event whose at is more than LEVELS.curve.staleEventSkipM (new, ≈40 m) behind world.distance, except 'runup' and 'boss' events. Normal play advances ≤ ≈1 m per frame, so this never triggers outside debug jumps.
- **Verify:** node tools/smoke.js --scenario play --level 10 --boss --after "g.squad.setCount(280,'debug')" --seconds 40 --shots 3 --out docs/build/qa/fix-level/boss10 → zombies at the jump ≤ the run-up size (25), no gate hints during the boss, the squad survives at E_boss.
- **Evidence:** docs/build/qa/bosses/L10 (timeline zombies 131 at t=1.6; L10/07-play-19s.png 'dropped: zombies.brute 12…32, gates 3–8'), L15, L17, L20, L1 (402 survivors)
- **Data keys:** `LEVELS.curve.staleEventSkipM (new)`

#### [UI-2] Hulk Twins: the boss bar turns orange at 77 % and red at 40 % fill, away from its 60 % / 25 % ticks

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor
- **What:** ui toggles the bossbar phase2/phase3 classes from boss:phase (js/ui.js:1521-1525); for twins boss.js reports the furthest-advanced twin's phase while the bar shows the summed HP: phase 2 at 8172/10560 = 77 %, phase 3 at 40 % (class 'phase2' at fill 70 %, 'phase3' at 35 %).
- **Expected:** GDD §7 twins 'phases per twin; one boss bar'; §14 boss bar phase ticks at 60 % / 25 % — the colour must match the ticks.
- **Fix (js/ui.js):** when boss:spawn has twins: true, drive phase2/phase3 from the summed boss:hp fraction (≤ 0.6 → phase2, ≤ 0.25 → phase3) instead of boss:phase; single bosses unchanged.
- **Verify:** node tools/smoke.js --scenario play --level 17 --boss --seconds 40 --shots 2 --after "g.squad.setCount(480,'debug'); window.__qaClearGates=1; $(cat docs/build/qa/bosses/probe.js)" --out docs/build/qa/fix-ui/twins then node docs/build/qa/bosses/qa2.cjs ../fix-ui/twins → barCls changes at fill ≈60 % and ≈25 %.
- **Evidence:** node docs/build/qa/bosses/qa2.cjs P17 (phase 2 at 4.60 s with 77 % HP; phase 3 at 8.67 s with 40 %); index.html:32 ticks; js/ui.js:1521-1525
- **Data keys:** none

#### [UI-3] Level-grid star ratings are unreadable: empty ☆ is drawn in the same gold glow as earned ★

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor
- **What:** the tile emits star.repeat(n) + starEmpty.repeat(3 − n) in one span (js/ui.js:1657-1674) and .tile-stars colours every glyph var(--coin) with the gold glow (css/game.css:1206-1216): tile 6 ('6 ★☆☆') and tile 14 ('14 ☆☆☆') both look like three gold stars at 13 px.
- **Expected:** GDD §14 Levels — number + 3 stars; earned vs unearned must read at a glance.
- **Fix (js/ui.js, css):** separate spans (<span class="on">★★</span><span class="off">★</span>); .off = filled ★ in rgba(255,255,255,0.22) with no glow (or a dark outline-only star); optionally hide stars on a never-played current tile; keep the aria-label.
- **Verify:** node docs/build/qa/ui-shells/probe.mjs levels --out docs/build/qa/fix-ui/probe-levels → 00-levels-progress.png distinguishes 0/1/3-star tiles.
- **Evidence:** docs/build/qa/ui-shells/probe-levels/00-levels-progress.png + probe.json
- **Data keys:** none

#### [UI-4] The boot screen can hang forever with no error or RELOAD when module downloads stall

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor
- **What:** the index.html BOOTGUARD (index.html:72-111) only reacts to error events; on a stalled CDN/module load the boot bar sits at 0 % 'Building the apocalypse…' indefinitely (smoke ui run: navigation timeout after 30 s, hasGame false, errorBox null).
- **Expected:** GDD §14 Boot 'error box if boot fails'; Overlays — error box with message and RELOAD.
- **Fix (index.html):** add a watchdog to BOOTGUARD — after 20 s, if the game hasn't finished booting (boot screen still visible / no window.__game.engine running), show the error box with 'Still loading… check your connection' and the RELOAD button (reuse the existing wiring); cancel it when boot completes. Don't hand-edit artifact.html: it is regenerated from index.html by node tools/build-artifact.js at integration.
- **Verify:** node tools/smoke.js --scenario boot --out docs/build/qa/fix-ui/boot (normal boot unaffected, CLEAN); a one-off puppeteer run that blocks js/main.js shows the error box after 20 s.
- **Evidence:** docs/build/qa/ui-shells/ui/report.json (boot.ok false, 'Navigation timeout of 30000 ms exceeded', errorBox null), ui/00-title.png
- **Data keys:** none

#### [UI-5] The endless HUD shows the campaign progress bar with a boss skull at the end of every 300 m chunk

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor
- **What:** level:progress in endless is the fraction of the current chunk (js/level.js:661-677) and ui never hides #progress-skull (js/ui.js ~1500), so every chunk promises a boss that only comes every 5th chunk; there is no distance or score readout.
- **Expected:** GDD §10.1 mini-boss every 5th chunk; §14 the skull marks the boss.
- **Fix (js/ui.js, css):** on level:start with endless add class 'endless' to #progress; show #progress-skull only for a mini-boss chunk (derive from endless:chunk.difficulty with the generator's mini-boss rule — every 5th chunk; confirm in levelgen generateChunk); optionally show live metres in #progress-label (e.g. '1 240 m').
- **Verify:** node tools/smoke.js --scenario play --endless --seconds 60 --shots 6 --pre "g.save.data.highestUnlocked=11" --out docs/build/qa/fix-ui/endless → no skull on normal chunks.
- **Evidence:** docs/build/qa/ui-shells/probe-flow/09-endless-hud.png, endless-die/02-result.png
- **Data keys:** none

#### [UI-6] Settings segmented buttons and sliders are smaller than the 48 × 48 minimum hit area

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor
- **What:** Quality buttons 53×40, 46×40, 50×40, 50×40; sensitivity 50×40, 44×40, 44×40; range inputs set-sound and set-music 156×28.
- **Expected:** GDD §14 'hit areas ≥ 48 × 48' (rows are 56 px).
- **Fix (css/game.css):** .seg > button { min-height: 48px; min-width: 48px } (reduce padding inside the 56 px row); input[type=range] height 48px with the visual track centred via ::-webkit-slider-runnable-track / ::-moz-range-track so the look is unchanged.
- **Verify:** node docs/build/qa/ui-shells/probe.mjs hit --out docs/build/qa/fix-ui/probe-hit → every settings button and slider ≥ 48×48.
- **Evidence:** docs/build/qa/ui-shells/probe-hit/probe.json
- **Data keys:** none

#### [UI-7] apple-touch-icon.png has transparent rounded corners, which iOS fills black

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor
- **What:** index.html:13 links icons/apple-touch-icon.png, drawn with an alpha-masked rounded square (corner pixel RGBA 0,0,0,0 — re-checked during triage); iOS applies its own corner mask and fills transparent pixels black. icons/icon-maskable-192.png is opaque (corner alpha 255).
- **Expected:** an opaque full-bleed home-screen icon (ARCH §15.3/§15.4 icon set).
- **Fix (within ui files; regenerating via tools/make-icons.js is out of scope):** point the apple-touch-icon link at icons/icon-maskable-192.png and make sure sw.js PRECACHE contains it.
- **Verify:** index.html link target has corner alpha 255; node tools/smoke.js --scenario boot --out docs/build/qa/fix-ui/icon has no failed requests.
- **Evidence:** icons/apple-touch-icon.png corner alpha 0 vs icons/icon-maskable-192.png alpha 255 (checked); tools/make-icons.js:135-138, 193; index.html:13
- **Data keys:** none

#### [UI-8] The service worker serves index.html and js/*.js cache-first under a hand-bumped VERSION, so returning PWA players can keep stale code

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** minor
- **What:** sw.js:18 VERSION = 'v1'; cacheFirst (sw.js:140-159) answers every same-origin GET from the app cache. A release that edits js/*.js without touching sw.js leaves sw.js byte-identical → no SW update → installed players run the old JS indefinitely.
- **Expected:** ARCH §15.4 'bump with releases' — releases must reach installed players.
- **Fix (sw.js):** serve navigations and same-origin .js/.css/.webmanifest network-first with a short timeout and cache fallback (offline still works), or stale-while-revalidate so the next launch picks up new code; keep cache-first for icons/fonts and the CDN handling as is. (A build-time VERSION stamp in tools/build-artifact.js is out of scope.)
- **Verify:** code review; node tools/smoke.js --scenario boot --out docs/build/qa/fix-ui/sw boots CLEAN with the SW registered.
- **Evidence:** sw.js:18, 130-165
- **Data keys:** none

#### [AUD-2] Gunfire volume never rises with squad size: countDb gets shots per 1/60 s step instead of shooters

- **Group:** audio (js/audio.js) · **Severity:** minor
- **What:** weapons emits shot with P_SHOT.count = shots fired this fixed step (js/weapons.js:773-779, 908) — 1–6 — and the audio 'shot' listener passes it to countDb (js/audio.js:1626-1629; :971 floor(count/8) dB), so the boost is always 0 dB (shotMax 6 with 40 shooters).
- **Expected:** GDD J1 / ARCH §11 shot +1 dB per 8 shooters, cap +12 dB (40 shooters → +5 dB).
- **Fix (js/audio.js only; leave weapons' payload as is):** set o.count = min(ctx.squad.count, 40) (the visible shooters, GDD §3.3) in the 'shot' listener.
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 8 --nobot --out docs/build/qa/fix-audio/shot --pre "$(head -n -1 docs/build/qa/rules-audit/probe-pre.js); const ap2 = g.audio.play.bind(g.audio); g.audio.play = function (n, o) { if (n === 'shot' && o) window.__qa.shotOpt = Math.max(window.__qa.shotOpt || 0, o.count || 0); return ap2(n, o); }" --after "g.squad.setCount(150,'debug'); setTimeout(()=>window.__qaDump('S'),5000)" + readqa.cjs → shotOpt ≈ 40 (countDb +5 dB).
- **Evidence:** docs/build/qa/rules-audit/shot-probe (shotMax 6, shotHist {1:116, 2:62, 3:9, 4:9, 6:9} with 40 shooters); js/audio.js:965-975, 1626-1629
- **Data keys:** none

#### [CORE-2] Esc / P cannot unpause: the pause screen focuses RESUME and the engine ignores keys whose target is a button

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** minor
- **What:** FORM_CONTROL_SELECTOR includes 'button' (js/engine.js:43) and _keyDown skips _togglePause when the event target is a control (:744-758); ui._focusFirst focuses RESUME on the pause screen (js/ui.js:2284), so the second Escape does nothing (escState 'paused', focusAfterPause 'btn-resume', esc2State 'paused').
- **Expected:** ARCH §6.2 'P/Esc pause' toggles (resumes when paused); GDD §14 Pause → RESUME.
- **Fix (js/engine.js):** for KeyP/Escape treat only text-entry targets as controls (input[type=text|search|number|email|password], textarea, select, [contenteditable]); buttons, checkboxes and range inputs must not block P/Escape (range inputs may keep the arrow keys).
- **Verify:** node docs/build/qa/ui-shells/probe.mjs pause --out docs/build/qa/fix-core/probe-pause → esc2State 'playing'; Tab/Enter navigation still works.
- **Evidence:** docs/build/qa/ui-shells/probe-pause/probe.json; js/engine.js:43, 744-758; js/ui.js:2284
- **Data keys:** none

### Polish (24)

#### [VIS-11] Road texture repeats every 15 m: the same manhole and cracks recur every ~1.9 s

- **Group:** visual (js/render.js, js/materials.js, js/environment.js, js/fxmaterials.js) · **Severity:** polish
- **What:** one shared 8 × 15 m road texture is mapped twice per 30 m segment (repV = 2, js/environment.js:444-460) and render.js bakes a manhole into it (js/render.js:538), so identical manholes appear in the same lane at a fixed period.
- **Expected:** GDD §15 road — asphalt noise, cracks, patches and tyre marks read as continuous, varied road.
- **Fix:** remove the manhole from the baked texture and place 0–2 manhole/patch decals per segment from the segment rng (mulberry32(levelSeed·1000 + k)), or bake 8 × 30 m (repV 1) and offset v by floor(rng·4)/4 per segment; no texture uploads during play (GDD §0).
- **Verify:** node tools/smoke.js --scenario play --level 1 --seconds 20 --shots 2 --out docs/build/qa/fix-visual/road → no manhole repeating in the same lane at a fixed period.
- **Evidence:** docs/build/qa/visual/l1/01-play-1s.png (manholes at y≈1250 and ≈815), l1/03-play-9s.png (y≈985)
- **Data keys:** none

#### [FX-6] Coin-flight pool overflows during heavy kills, so coins are credited without the J19 flight

- **Group:** fx (js/fx.js) · **Severity:** polish
- **What:** the debug overlay shows 'dropped: fx.coinFlights 6' in the L12 laser run (400 soldiers); JUICE.caps.coinFlights is 16 (js/data.js:1023).
- **Expected:** GDD J19 every coin pickup flies to the HUD icon (0.4 s bezier) with an icon punch.
- **Fix (js/fx.js + data):** JUICE.caps.coinFlights 16 → 48 (pool still allocated once at High capacity); when the pool is full, merge the new coin into the youngest in-flight coin (it then counts 2) instead of dropping it; keep the HUD count-up in step with arrivals.
- **Verify:** the WPN-1 laser run → no 'fx.coinFlights' in the debug overlay's dropped list.
- **Evidence:** docs/build/qa/visual/weapons/10-play-15s.png, 12-play-18s.png (dropped: fx.coinFlights 6)
- **Data keys:** `JUICE.caps.coinFlights`

#### [FX-7] Zero-change gate passes (C = 1 through a red gate, grey x1, flipped '+0') play positive J7 juice

- **Group:** fx (js/fx.js) · **Severity:** polish
- **What:** _onGatePass sets positive = op === 'item' || after >= before (js/fx.js:2198), so after === before plays shards toward the camera, trauma 0.15 and the passUp haptic (e.g. applyGate('-', 15) at C = 1 returns before = after = 1, js/squad.js:536).
- **Expected:** GDD J7/J8 — a negative gate gives shards flying away, a red vignette and the [30,30,30] haptic; a neutral grey x1 pass should not read as a reward.
- **Fix (js/fx.js):** classify by the gate's effective op/value from the payload/view: red ('-' not flipped, '/' with divisor > 1) → J8 juice; neutral (x1 or value 0) → a small grey puff, no shards toward the camera, no trauma/haptic; otherwise positive.
- **Interface:** AUD-3 applies the same classification to the pass sound.
- **Verify:** debug run passing a red gate at C = 1 (e.g. --after "setTimeout(()=>g.squad.setCount(1,'debug'),26000)" on L1) shows J8 juice.
- **Evidence:** js/fx.js:2192-2212; js/squad.js:536
- **Data keys:** none

#### [FX-8] ÷→x2 flip bursts blue sparks although the gate turns green

- **Group:** fx (js/fx.js) · **Severity:** polish
- **What:** gates emits gate:flip when the ÷ ladder reaches x2 (js/gates.js:941-943, :971) and _onGateFlip always bursts C_BLUE (js/fx.js:2164-2169) while the panel recolours to the green x type (gates.js:580).
- **Expected:** GDD J5 blue sparks are for a red gate flipping to blue '+'; a ÷ gate reaching x2 becomes the green x type (§4.1).
- **Fix (js/fx.js):** use C_GATE[this._gateType(g.op, g.value, g)] in _onGateFlip (green for a flipped '/', blue for a flipped '-').
- **Verify:** code review; a ÷ ladder run (LVL-2 command) shows green sparks at the flip.
- **Evidence:** js/fx.js:2164-2169; js/gates.js:580, 941-943, 971
- **Data keys:** none

#### [FX-9] Rocket explosion is a dim orange smudge (blast flash too small and short, no scorch)

- **Group:** fx (js/fx.js) · **Severity:** polish
- **What:** the B_ROCKET burst (js/fx.js:1209-1214) emits a K_MUZZLE flash of size 2.4 for 0.18 s plus sparks, smoke and dust; at the gate it reads as a dim smudge.
- **Expected:** GDD §8.1 / J21 rocket — 'orange burst', trauma 0.3, FOV kick.
- **Fix (js/fx.js):** K_MUZZLE size 2.4 → ≈4.5 and life 0.18 → 0.3 s; add a 2.5 m dark ground scorch decal for ≈1.5 s via the existing decal pool; stay within particle caps.
- **Interface:** WPN-3 makes the projectile and smoke trail readable.
- **Verify:** node tools/smoke.js --scenario play --level 9 --seconds 9 --shots 0.4 --quality high --after "g.squad.setCount(40,'debug'); g.weapons.startWeapon('weapon.rocket')" --out docs/build/qa/fix-fx/rocket → visible orange burst and scorch.
- **Evidence:** docs/build/qa/visual/rocket/03-play-3s.png, crop-rocket3.png; js/fx.js:1209-1214
- **Data keys:** none

#### [CHR-7] Character hit flash goes to full white (diffuse += 1.0 plus emissive 0.6) instead of a tinted blink

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** polish
- **What:** GLSL_COLOR_FRAG adds diffuseColor.rgb += vec3(grFlash) and GLSL_EMISSIVE_FRAG adds grFlash × HIT_FLASH_EMISSIVE 0.6 (js/models.js:84, 237-248) — even a single 60 ms flash saturates to pure white through bloom.
- **Expected:** GDD §6.1 a 0.06 s white emissive blink with the §15 colour identity readable.
- **Fix (js/models.js):** diffuse = mix(diffuse, vec3(1.0), 0.5·grFlash) and HIT_FLASH_EMISSIVE 0.6 → ≈0.35; keep ZOMBIES.common.hitFlash (owned by enemies) unchanged.
- **Interface:** ENE-3 rate-limits re-triggers in zombies.js.
- **Verify:** with ENE-3 merged, the L3 nobot run (node tools/smoke.js --scenario play --level 3 --nobot --seconds 75 --shots 3 --out docs/build/qa/fix-characters/l3nobot) shows zombies blinking but keeping their colours.
- **Evidence:** js/models.js:84, 237-248; docs/build/qa/levels-early/l3nobot/03-play-9s.png
- **Data keys:** none

#### [CHR-8] The flamethrower trooper barely ever engages: the squad kills everything before the 7 m cone

- **Group:** characters (js/models.js, js/squad.js, js/troops.js) · **Severity:** polish
- **What:** troop.flamer joins at 34.1 s in the L8 item run and qaLog.cone = {calls 1747, kills 2} for the rest of the level (L9: 1984 calls, 4 kills); screenshots show only the pilot flame — waves die at 20 m+.
- **Expected:** GDD §8.3 flamethrower trooper (cone 25°, 7 m, 15·hz·d DPS, burning +20 % bullet damage) should be a visible, felt pickup at its unlock level (L8 'New: flamethrower'); the 7 m is a tunable and the intent is engagement (GDD amendment noted).
- **Fix (js/troops.js + data):** TROOPS.flamer.range 7 → ≈13 m (cone 25°) with flame particles reaching the new range, and/or projected flame volleys at the nearest zombie within 15 m that apply the burn tag; prioritise brutes/spitters holding at 18 m.
- **Verify:** node docs/build/qa/levels-mid/qa-smoke.mjs --level 8 --nobot --seconds 130 --pre "g.save.setUpgrade('squad',3); g.save.setUpgrade('fireRate',3); g.save.setUpgrade('damage',3)" --after "window.__qaMode='item'; $(cat docs/build/qa/levels-mid/probe.js)" --out docs/build/qa/fix-characters/l8item → qaLog.cone kills ≥ 10 % of kills after the flamer joins.
- **Evidence:** docs/build/qa/levels-mid/l8item/report.json, l9item/report.json (qaLog.cone); docs/build/qa/levels-mid/l8/07-play-37s.png
- **Data keys:** `TROOPS.flamer.range`, `TROOPS.flamer.coneDeg`

#### [ENE-10] Hulk Twins overlap at x ±2.2: the 7 m rigs clip arms and car-door shields

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** polish
- **What:** BOSSES.twinOffsetX 2.2 (js/data.js:357) with a ≈4.5 m wide Hulk rig → the left twin's shield and arm pass through the right twin's torso and the pair fills the road.
- **Expected:** GDD §7 Hulk Twins — two readable rigs, one boss bar (ARCH: rigs at x ±2.2 can change).
- **Fix (data + js/boss.js):** twinOffsetX ≈3.0 clamped to the road, stagger the twins in z by ≈1.5 m (new BOSSES.twinStaggerZ), or scale twin rigs ×0.8 when placing them.
- **Verify:** L17 unshot run (CHR-1 command pattern with --level 17 and count 480, out docs/build/qa/fix-enemies/M17) → two separate silhouettes.
- **Evidence:** docs/build/qa/bosses/M17/06-play-11s.png, P17/02-play-4s.png
- **Data keys:** `BOSSES.twinOffsetX`, `BOSSES.twinStaggerZ (new)`

#### [ENE-11] Spitter Queen's 1.8× acid globs hover in front of her chest and hide the body

- **Group:** enemies (js/zombies.js, js/boss.js) · **Severity:** polish
- **What:** boss globs use GLOB_SCALE 1.8 and launch from a fixed GLOB_MOUTH_Y 5.0 at the rig's x/z (js/boss.js:48, _launchGlob ≈1270-1283); in the unshot rig three large globs cover the torso.
- **Expected:** GDD §7 'Spitter Queen … bloated, 4 arms, pulsing sacs' identifiable.
- **Fix:** BOSSES.glob.scale 1.8 → ≈1.1 and launch from the rig's head/mouth world position instead of a fixed height.
- **Verify:** L5 unshot run (CHR-1 command pattern with --level 5 and count 190, out docs/build/qa/fix-enemies/M5) → body readable while spitting.
- **Evidence:** docs/build/qa/bosses/M5/06-play-11s.png
- **Data keys:** `BOSSES.glob`

#### [WPN-6] Muzzle flash lives 60 ms instead of J1's 33 ms (2 frames)

- **Group:** weapons (js/weapons.js) · **Severity:** polish
- **What:** FIRE.muzzleFlash.ms = 60 (js/data.js:146) → MUZZLE_LIFE (js/weapons.js:48).
- **Expected:** GDD §12 J1 'muzzle flash quad 0.35 m additive #FFE38A 2 frames', 33 ms (GDD is authoritative; ARCH §6.11's 60 ms needs an amendment).
- **Fix (data):** FIRE.muzzleFlash.ms → 33.
- **Verify:** code review; an L1 run looks the same except for shorter flashes.
- **Evidence:** js/data.js:146; js/weapons.js:48
- **Data keys:** `FIRE.muzzleFlash.ms`

#### [LVL-12] L2's runner solo introduction spawns 1 m after the single gate and only 30 m before the first mixed wave

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** polish
- **What:** dump.mjs 2: single gate {at 68, +3}, runner intro {at 69}, first mixed wave {at 99, walker 5 + runner 1}; the intro is placed at the midpoint between the previous wave's contact and the gate arrival (js/levelgen.js:1194-1196) requiring only introAt ≥ previous gate spawn + 25 and wv.at − introAt ≤ 120, so the intro runner is shot during the 'NO WAY AROUND' single gate and gets no stage of its own.
- **Expected:** GDD §6.2 'each new type's first appearance is a solo introduction spawn 60 m before its first mixed wave'.
- **Fix (js/levelgen.js + data):** target introAt = firstMixed.at − LEVELS.curve.introAheadM (new, 60); reject positions whose contact falls inside a gate's armed window (arrival − 36 m … arrival); if none fits, move the first mixed wave rather than the intro.
- **Verify:** node docs/build/qa/levels-early/dump.mjs 2 (and 3, 4, 5) → each intro ≈60 m before its first mixed wave and outside gate windows.
- **Evidence:** node docs/build/qa/levels-early/dump.mjs 2; docs/build/qa/levels-early/p2 (tr '120:0')
- **Data keys:** `LEVELS.curve.introAheadM (new)`

#### [LVL-13] The boss road slow-down is an exponential ease (rate 3), not the 1 s lerp; BOSSES.intro.roadLerp is unused

- **Group:** level (js/level.js, js/levelgen.js, tools/validate-levels.js) · **Severity:** polish
- **What:** js/level.js:625 roadSpeed = lerpExp(roadSpeed, target, LEVELS.curve.roadLerpRate 3, dt) — 95 % after 1 s, ≈99 % after 1.5 s; BOSSES.intro.roadLerp: 1.0 (js/data.js:388) is never read.
- **Expected:** GDD §0/§7 'road speed lerps to 35 % over 1 s'.
- **Fix (js/level.js):** when _fireBoss starts the slow-down, run a linear (or ease-out) tween from the current speed to 0.35·v over BOSSES.intro.roadLerp seconds (level only reads this key; enemies don't edit it).
- **Verify:** a boss run with docs/build/qa/bosses/probe.js → the 'rs' samples reach 0.35·v 1.0 s after the boss event.
- **Evidence:** js/level.js:625; js/data.js:388
- **Data keys:** none

#### [UI-9] The armor shield counter is pinned to a fixed screen spot instead of sitting beside the squad count

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish
- **What:** #shield is positioned statically (css/game.css:764-770: left 50 % + 96u, bottom = thumb zone): with the squad on the left half the '50' pill sits over empty road at x ≈ 650/780 while the count is at x ≈ 250.
- **Expected:** GDD §8.2/§14 'shield counter beside the squad count'.
- **Fix (js/ui.js + css):** in ui.update (at the HUD rate) project ctx.fx.label (x, y, z, hasPos, height, nDigits; read-only) with ctx.render.camera and place #shield at labelScreenX + labelHalfWidth + 8 px, vertically centred on the label, clamped to the safe area; hide it when the label is hidden.
- **Verify:** node docs/build/qa/levels-early/qasmoke.mjs --scenario play --level 2 --nobot --shots 3 --after "$(cat docs/build/qa/levels-early/probe2.js)" --out docs/build/qa/fix-ui/armor → the pill sits right of the count on both halves.
- **Evidence:** docs/build/qa/levels-early/f2/15-play-44s.png, l3nobot/17-play-65s.png
- **Data keys:** none

#### [UI-10] The boss bar sits ≈24 px lower than specified

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish
- **What:** #bossbar top = safe-top + icon-btn + 74u (css/game.css:797) → rect '50@134' (track ≈162 css on 390×844).
- **Expected:** GDD §14 'boss bar 330 × 18 at safe-top + 110 with name'.
- **Fix (css/game.css):** position #bossbar so the 18 px track's top sits at safe-top + 110·u with the name above it; check it clears the power-up pills (centred at safe-top + 70) and the 8 % top letterbox.
- **Verify:** a boss run with docs/build/qa/bosses/probe.js (the 'bar' field) → track top ≈110 css.
- **Evidence:** node docs/build/qa/bosses/qa2.cjs P1 (#bossbar rect '50@134'); css/game.css:793-800
- **Data keys:** none

#### [UI-11] Shop: the 'Start squad' effect caption wraps to two lines (card 110 px tall instead of 96)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish
- **What:** UPGRADES.squad.fmt v => `${v} soldiers` (js/data.js:558) is applied to both sides of the delta (js/ui.js:1743) → '9 soldiers → 11 soldiers' wraps; cards also measure 350 instead of 358 px.
- **Expected:** GDD §14 Shop — 5 cards 358 × 96 with a one-line effect delta ('Fire rate 2.0 → 2.2/s').
- **Fix (js/ui.js / data, css):** print the unit once ('9 → 11 soldiers'), e.g. a new UPGRADES.squad.fmtDelta or stripping the unit from the left side; check #shop-list side padding for 358 px cards.
- **Verify:** node docs/build/qa/ui-shells/probe.mjs persist --out docs/build/qa/fix-ui/probe-persist → all five cards 96 px tall.
- **Evidence:** docs/build/qa/ui-shells/probe-persist/probe.json (squad card 350×110), 00-shop-poor.png, artifact/01-shop.png
- **Data keys:** `UPGRADES.squad.fmtDelta (new)`

#### [UI-12] Empty upgrade pips on shop cards are invisible (≈1.1:1 contrast)

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish
- **What:** empty pips are #222A3D with an inset dark shadow on a #29334D card (css/game.css:1361-1369); sampled #1E2637 vs card #29334D.
- **Expected:** GDD §14 Shop '10 pips' show rank progress at a glance.
- **Fix (css):** .pips > i { background: rgba(255,255,255,0.12); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.22), inset 0 1px 2px rgba(0,0,0,0.5) }, keeping the orange .on and green .maxed fills.
- **Verify:** node tools/smoke.js --scenario ui --out docs/build/qa/fix-ui/shop → the 10-pip track is visible on every card.
- **Evidence:** docs/build/qa/visual/ui/01-shop.png (sample.mjs [216,362] #1E2637 vs #29334D); docs/build/qa/ui-shells/artifact/01-shop.png, probe-persist/00-shop-poor.png
- **Data keys:** none

#### [UI-13] The shop coin pill is unformatted ('100050') while the title and HUD abbreviate ('1.2K')

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish
- **What:** _fillShop / _updateShopCoins / _refreshSaveViews write String(n) to #shop-coins (js/ui.js:1698, 1797, 1811) while _fillTitle uses fmtCoins (js/ui.js:1625).
- **Expected:** consistent coin formatting (GDD §14 coin balance header / coin pill).
- **Fix (js/ui.js):** use fmtCoins (or one thousands-separated exact format everywhere).
- **Verify:** node docs/build/qa/ui-shells/probe.mjs persist --out docs/build/qa/fix-ui/probe-persist → shopCoinsRich formatted like titleCoins.
- **Evidence:** docs/build/qa/ui-shells/probe-persist/probe.json (shopCoinsRich '100050' vs titleCoins '1.2K')
- **Data keys:** none

#### [UI-14] The keyboard focus ring is drawn around PLAY / NEXT / RETRY on touch devices

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish
- **What:** _focusFirst (js/ui.js:2284) calls focus() programmatically on every screen and Chrome then matches :focus-visible, so a blue 3 px outline shows at boot and after touch drags, against css/game.css:187-189 'focus: keyboard only, never on tap'.
- **Expected:** GDD §14/§15 --focus #2E9BFF is a keyboard affordance.
- **Fix (js/ui.js, css):** track the input modality (pointerdown → html.pointer-input; keydown → remove) and scope the focus outline to html:not(.pointer-input) #ui :focus-visible; optionally skip _focusFirst after a pointer interaction. Keyboard behaviour (CORE-2) must keep working.
- **Verify:** node tools/smoke.js --scenario all --shell sandbox --out docs/build/qa/fix-ui/sandbox → no focus ring on 00-title.png / 16-result.png; Tab still shows it.
- **Evidence:** docs/build/qa/ui-shells/artifact/00-title.png, sandbox/00-title.png, sandbox/16-result.png
- **Data keys:** none

#### [UI-15] The ?debug=1 overlay covers the logo, shop coins, level tiles and progress bar in every QA screenshot at 390×844

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish
- **What:** #debug (css/game.css:1894) is a large panel under the HUD; screenshots lose the logo, the shop coin pill, the first tile row and the progress bar.
- **Expected:** debug aids must not hide what QA judges (ARCH §13 overlay).
- **Fix (css/game.css):** on narrow screens dock #debug inside the bottom thumb zone (it is not interactive: pointer-events none), 10 px font, ≈60 % background, max-width ≈70 %, at most ≈6 lines (overflow hidden). Number formatting is CORE-4.
- **Verify:** node tools/smoke.js --scenario all --out docs/build/qa/fix-ui/debug → logo, shop coin pill, level tiles row 1 and the progress bar visible.
- **Evidence:** docs/build/qa/ui-shells/artifact/00-title.png, 01-shop.png, 03-levels.png, 05-play-start.png
- **Data keys:** none

#### [UI-16] Desktop players are told 'DRAG TO STEER' although keyboard steering exists

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish
- **What:** HINTS.steer is a single string (js/data.js:1156) and ui shows it with the touch hand at 1280×800 with a mouse.
- **Expected:** GDD §14 the hint teaches the actual control (A/D/←/→ exist, ARCH §6.2).
- **Fix (js/ui.js + data):** add HINTS.steerDesktop = 'DRAG OR ← → TO STEER' and have ui.showHint('steer') use it when matchMedia('(pointer: fine)').matches or navigator.maxTouchPoints === 0.
- **Verify:** node tools/smoke.js --scenario all --desktop --out docs/build/qa/fix-ui/desktop → 05-play-start.png shows the desktop text; the phone run is unchanged.
- **Evidence:** docs/build/qa/ui-shells/desktop/05-play-start.png
- **Data keys:** `HINTS.steerDesktop (new)`

#### [UI-17] Landscape phone (844×390): the shop list is a 190 px scroll box showing two of five cards, and Settings' BACK is off-screen

- **Group:** ui (js/ui.js, css/game.css, index.html, sw.js, manifest.webmanifest, js/save.js) · **Severity:** polish
- **What:** shopScroll {lsh 464, lch 190}; 02-shop-land.png shows Start squad and Fire rate with no scroll affordance; Settings scrolls (689 / 390) with BACK below the fold.
- **Expected:** GDD §14 Shop 5 cards; with --ui clamped at 0.85 on short heights the screens should use the width.
- **Fix (css/game.css):** @media (orientation: landscape) and (max-height: 500px): #shop-list as a 2-column grid, smaller h1/coin header, and a sticky BACK footer on #scr-shop and #scr-settings.
- **Verify:** node docs/build/qa/ui-shells/probe.mjs landscape --out docs/build/qa/fix-ui/probe-landscape → all five cards and BACK visible.
- **Evidence:** docs/build/qa/ui-shells/probe-landscape/probe.json, 02-shop-land.png
- **Data keys:** none

#### [AUD-3] Zero-change gate passes (C = 1 through a red gate, grey x1, flipped '+0') play no pass sound

- **Group:** audio (js/audio.js) · **Severity:** polish
- **What:** gate:pass plays pass_up only when after > before and pass_down only when after < before (js/audio.js:1684-1697), so equal counts are silent.
- **Expected:** GDD J8 passing a negative gate gives pass_down; a neutral grey x1 pass should still acknowledge the pass.
- **Fix (js/audio.js):** classify by the pass's effective op/value (same rule as FX-7): red ('-' not flipped, '/' with divisor > 1) → pass_down; neutral (x1 / value 0) → a soft neutral cue (e.g. pass_down at −6 dB or ui_tap); positive → pass_up + hup.
- **Verify:** code review; a debug run passing a red gate at C = 1.
- **Evidence:** js/audio.js:1684-1697
- **Data keys:** none

#### [CORE-3] The 'Reloading graphics…' overlay hides before the 645 ms recompile after webglcontextrestored

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** polish
- **What:** _contextRestoredHandler (js/engine.js:887-895) calls ui.hideOverlay() right after render.rebuild(); programs recompile lazily on the next draw → a 659.9 ms frame (jsMsPrevFrame 644.8) after the overlay is gone, so the app looks frozen; recovery itself works.
- **Expected:** GDD §14 Overlays — 'Reloading graphics…' stays up until graphics are ready.
- **Fix (js/engine.js):** after rebuild, await ctx.render.warmup() (VIS-2, guarded) — or wait for the first completed draw — then hide the overlay.
- **Verify:** node docs/build/qa/perf/perfprobe2.mjs --level 3 --seconds 25 --ctxlossAt 8 --out docs/build/qa/fix-core/life-ctx → no long frame after the overlay hides; 02-ctx-resumed.png renders correctly.
- **Evidence:** docs/build/qa/perf/life-ctx/perf.json (worst[] 659.9 ms at t=9.82 after the restore; lifecycle[])
- **Data keys:** none

#### [CORE-4] Debug overlay histogram values are unrounded ('last 1.6833333333332376')

- **Group:** core (js/engine.js, js/main.js, js/util.js) · **Severity:** polish
- **What:** the histogram line appends arr[arr.length − 1] raw (js/engine.js:1268-1276): 'bossTtk n=1 mean 1.7 last 1.6833333333332376', 'hitsPerGate … last 6.099999904632568'.
- **Expected:** a readable overlay (ARCH §13).
- **Fix (js/engine.js):** format 'last' with toFixed(2) (mean already uses toFixed(1)); integers stay integers.
- **Verify:** any ?debug=1 smoke screenshot (e.g. node tools/smoke.js --scenario play --level 1 --seconds 60 --out docs/build/qa/fix-core/debug).
- **Evidence:** docs/build/qa/ui-shells/sandbox/16-result.png; js/engine.js:1268-1276
- **Data keys:** none

## Rejected / deferred

- R8 (rules-audit) 'Boss-damage rank 7 costs 1360 but the GDD table lists 1350' — not a code defect: js/data.js follows the GDD's own formula round10(180·1.4^6) = 1360; the §9.2 table (1350, grand total 59 350) is the typo. Doc fix for the design owner (no fixer group owns docs/GDD.md).
- R7 (rules-audit) 'Multiplier step costs after the first use the rounded base step (78/104 vs 77/103)' — rejected as negligible: ±1 hit at x3→x4 / x4→x5 is not perceptible, and an exact fix needs the unrounded H carried across groups (levelgen → lane → gates). Revisit only if LVL-1 changes the step model.
- U7 (ui-shells) 'Smoke harness reports ERRORS for artifact/sandbox runs because of a favicon.ico 404' — not a game defect: the 404 comes from tools/smoke.js's own host pages (hostSkeleton, /__sandbox.html), which no fixer group owns. QA lead follow-up: add <link rel="icon" href="data:,"> there or ignore /favicon.ico in the listeners.
- U6 part (ui-shells) 'tools/smoke.js should use waitUntil: domcontentloaded' — harness-only, QA lead follow-up; the game-side watchdog is UI-4.
- U11 / U12 parts (ui-shells) 'Regenerate the apple-touch icon with tools/make-icons.js' and 'fail the build in tools/build-artifact.js on a version mismatch' — outside every fixer group's files; covered within ownership by UI-7 (link an opaque icon) and UI-8 (network-first SW). The ARCH §15.3 filename drift (apple-touch-icon-180.png) is a doc fix.
- M8 part (levels-mid) 'Multiply boss HP by the shop DPS factor' — rejected: contradicts GDD §0/§7 (boss HP = 20·E_boss is tuned at base stats; fire-rate/damage/boss-damage upgrades are meant to shorten fights). The real defect (phase-1 and phase specials never fire in short fights) is ENE-2.
- M2 part (levels-mid) 'As a safety net, scale boss HP with max(E_boss, count at run-up)' — rejected: contradicts GDD §7 (HP = 20·E_boss, ×1.25 on milestones). The count snowball is fixed at its source (LVL-1, LVL-2, LVL-3).
- E6 alternative (levels-early) 'Give rifle bullets auto-aim on zombies' — rejected as a design change: GDD §3.3 has bullets fly straight (±2°) and re-aim only at the boss; the leak fix stays in the HP solve (LVL-4).
- M6 part (levels-mid) 'Grow endless E/pop/HP with the live count and size the mini-boss from max(E, C)' — rejected: GDD §10.1 fixes E(D) and mini-boss HP = 10·E; with the rubber band fixed (LVL-3) the count stays near 2·E.
- P4 parts (perf) 'Boxed-double allocations in squad.render/step, zombies._stepAlive/render/hitTestSegment and gates.render' — deferred to round 2: measured 0.1–0.2 MB/s each, versus ≈3.2 MB/s from three's getParameters (fixed by GAT-4, FX-2, VIS-8) and ≈1 MB/s in weapons (WPN-5); hot-loop refactors in those modules are high-risk for little gain. Re-measure with perfprobe --heapprof after round 1.
- P8 part (perf) 'Run levelgen during the title→play fade' — deferred: level.start() costs ≈35 ms once, under the fade; the 120–215 ms post-start stall is shader compile/link, fixed by VIS-2 + CORE-1.
- L4 sub-request (lead) 'verify boss DPS math (weight × damage, accuracy) against GDD §3.3' — no defect: from boss:fight the TTK at E_boss is 11.2–16.3 s (L1 11.3, L5 14.1, L10 12.2, L15 12.7, L17 16.3, L20 13.4), on the GDD's 12.5 s; only the intro damage (ENE-1) and the snowball (LVL-1/2) shortened fights.

## GDD / ARCHITECTURE amendments for the design owner

- GDD §14: tutorial hint position (y 620 collides with the §3.1 count label) → band below the HUD (UI-1).
- GDD §15: glyph emissive 2.5 → ≈1.2; count label rendered LDR with outline (GAT-1, FX-1). §12 J3: the per-hit panel flash is rate-limited/attenuated under sustained fire (GAT-1).
- GDD §15 tracer table: laser (4.0, 1.0, 3.6) → cyan to match §8.1; rifle ≈(2.6, 1.7, 0.6); minigun ≈(3.4, 2.6, 0.35) (WPN-1, WPN-2).
- GDD §10.1: rubber band "one shootable to x2" → "one shootable to x1" (LVL-3).
- GDD §4.2 / §4.4: K_M and K_÷ sized from the window's achievable intake (full accuracy, 40 hits/s cap) instead of E·2.0·0.5; ÷ ladder x2 effectively out of reach in one window (LVL-1, LVL-2).
- GDD §6.3: leak model uses per-type exposure windows (crawler hittable zone) and a pattern coverage factor (LVL-4).
- GDD §7: the boss is immune during the intro (ENE-1); attacks start within an attack range rather than on arrival, first attack ≈0.8 s after the intro, phase specials within 1 s of phase entry, interval = start-to-start, charge stops ≈5 m (ENE-2); telegraphs drawn at the squad front with x-only hit tests (ENE-5).
- GDD §2: camera framing constraint + count-driven dolly; landscape vFOV floor (VIS-3).
- GDD §8.3: flamethrower trooper range 7 m → ≈13 m (CHR-8).
- GDD §9.2 table: boss damage rank 7 = 1360, grand total 59 360 (R8).
- ARCH §7: heavy-weapon gate/shield hits are ×w (WPN-4); ARCH §6.11: muzzle flash 33 ms (WPN-6); ARCH §15.3: apple-touch icon file name; ARCH UI table: the magnet has an on-squad visual (CHR-2).

## QA tooling follow-ups (QA lead, not fixer groups)

- tools/smoke.js: add `<link rel="icon" href="data:,">` to hostSkeleton() and /__sandbox.html (favicon 404, U7); use `waitUntil: 'domcontentloaded'` (U6).
- tools/make-icons.js: render apple-touch-icon.png opaque (maskable); tools/build-artifact.js: fail on sw.js VERSION ≠ main.js VERSION (U11, U12).
- Round 2: re-run the boss suite (P/Q/M/S runs) with fresh out dirs after ENE-*, LVL-1/2/11; re-measure GC with `perfprobe.mjs --heapprof` after GAT-4/FX-2/VIS-8/WPN-5 and decide on the deferred P4 parts.

## Raw report → triage mapping

| Tester | Raw issue | Triage |
|---|---|---|
| lead | Gate numbers/panels wash out to white while shot | GAT-1, VIS-9 |
| lead | MAX badge clipped ("MAY") | GAT-2, VIS-7 |
| lead | Squad count label is a blurry glow | FX-1 |
| lead | Boss fight ~1.6 s at L1 (intro shred) | ENE-1 (+ LVL-1 snowball) |
| lead | Boss death whites out the screen | VIS-6 |
| lead | Hulk reads as crude pink/red boxes | CHR-1, ENE-3 (rage tint) |
| lead | ~290 ms first-appearance hitch | VIS-2, CORE-1 |
| levels-early | Brute parks at the formation edge | ENE-4 |
| levels-early | Crawler HP solved for 40 m, hittable 8 m | LVL-4 |
| levels-early | Runners outrun their wave, shielded by the gate panel | LVL-4 |
| levels-early | E-trace 0.3·H → x-gates cheap, snowball 1.6–2× E_boss | LVL-1 |
| levels-early | Magnet/armor give no on-squad feedback | CHR-2 |
| levels-early | L3 waves leak 29–43 % (edge walkers) | LVL-4 |
| levels-early | L2 guaranteed special on a random half | LVL-7 |
| levels-early | Hint banner covers the squad count | UI-1 |
| levels-early | Boss attacks wait for arrived; reset per phase | ENE-2 |
| levels-early | Zombies/boss turn solid white under fire | ENE-3, CHR-7 |
| levels-early | ÷ glyph reads as + | VIS-5, GAT-3 |
| levels-early | No crawler packs at L3 | LVL-8 |
| levels-early | Minigun tracers look like rifle tracers | WPN-2 |
| levels-early | Shield counter pinned to a fixed spot | UI-9 |
| levels-early | Large squads run off the bottom edge | VIS-3 |
| levels-early | L2 runner intro 1 m after the single gate | LVL-12 |
| levels-mid | ÷ lesser evil is a free x2 | LVL-2 |
| levels-mid | x5 on the first gates of L8/L10, bosses die in the intro | LVL-1 (boss-HP safety net rejected) |
| levels-mid | L6/L7/L8 never show x3 / triple / ÷3 | LVL-5 |
| levels-mid | Bosses and brutes turn white (flash never decays) | ENE-3 |
| levels-mid | ÷ reads as + on the gate; ÷ tint close to − | VIS-5, GAT-3, VIS-10 |
| levels-mid | Endless rubber band doubles runaway squads | LVL-3 (E/HP growth rejected) |
| levels-mid | Boss cadence 40–70 % slower | ENE-2 |
| levels-mid | Phase-1 attack never fires with normal shop progress | ENE-2 (HP × shop factor rejected) |
| levels-mid | Hint pill covers the count | UI-1 |
| levels-mid | Frame shape encoding missing | VIS-10 |
| levels-mid | Endless crates give locked specials, no item gates | LVL-9 |
| levels-mid | Spit splash test is a square | ENE-5 |
| levels-mid | Boss damage numbers identical merged totals | FX-3 |
| levels-mid | Flamethrower trooper barely engages | CHR-8 |
| bosses | Telegraphs anchored off-screen / under the letterbox | ENE-5, VIS-3 |
| bosses | Colossus shield drops in 0.05 s | ENE-6 |
| bosses | Attack cadence slower than GDD; specials skipped | ENE-2 |
| bosses | Boss rigs flat white for the whole fight | ENE-3 |
| bosses | Phase 1 has no basic attack (still walking in) | ENE-2 |
| bosses | [seed] Boss loses 3–13 % HP in the intro | ENE-1 |
| bosses | [seed] Hulk boxes + pink phase 3 | CHR-1, ENE-3 |
| bosses | [seed] Death whiteout from bloom + HDR confetti | VIS-6 |
| bosses | Twins / Prime show the base name | ENE-8 |
| bosses | Twins bar colour vs 60/25 % ticks | UI-2 |
| bosses | Twins exceed the draw-call budget | ENE-9 (+ CHR-1/CHR-5 merge rule) |
| bosses | Queen / Juggernaut spindly silhouettes | CHR-5, ENE-11 |
| bosses | Triple-spit flanks never kill | ENE-5 |
| bosses | [seed] Hitches at boss reveal and results | VIS-2 |
| bosses | Charges lunge to 2–3 m | ENE-2 |
| bosses | Twin rigs overlap | ENE-10 |
| bosses | Boss damage numbers stack as HDR blobs | FX-3 |
| bosses | boss.js ignores BOSSES data | ENE-7 |
| bosses | Smoke --boss dumps every skipped wave | LVL-11 |
| bosses | Boss bar 24 px lower | UI-10 |
| ui-shells | Wide aspect puts the squad below the screen | VIS-3 |
| ui-shells | Esc/P cannot unpause | CORE-2 |
| ui-shells | Level-grid stars unreadable | UI-3 |
| ui-shells | Hint bubble covers the count at level start | UI-1 |
| ui-shells | Boot bar freeze + 2.8 s first-frame stall | CORE-1, VIS-2 |
| ui-shells | Boot can hang forever without an error | UI-4 (harness part → QA follow-up) |
| ui-shells | favicon.ico 404 makes the harness report ERRORS | rejected (harness-only) |
| ui-shells | Endless results distance vs score | LVL-10 |
| ui-shells | Endless HUD skull every chunk | UI-5 |
| ui-shells | Settings hit areas < 48 px | UI-6 |
| ui-shells | apple-touch-icon transparent corners | UI-7 |
| ui-shells | Service-worker version hand-maintained | UI-8 |
| ui-shells | Shop caption wraps | UI-11 |
| ui-shells | Unfilled shop pips invisible | UI-12 |
| ui-shells | Shop coin pill unformatted | UI-13 |
| ui-shells | Focus ring on touch devices | UI-14 |
| ui-shells | Debug overlay covers UI; unrounded values | UI-15, CORE-4 |
| ui-shells | Desktop told DRAG TO STEER | UI-16 |
| ui-shells | Landscape phone shop list | UI-17 |
| visual | DRAG TO STEER covers the count at L1 start | UI-1 |
| visual | ÷N reads +N; ÷ panel looks like − | VIS-5, GAT-3, VIS-10 |
| visual | Bosses turn solid white | ENE-3 |
| visual | Bloom draws rectangular halos | VIS-4 |
| visual | Distant +N gates read purple | VIS-9 |
| visual | Squad has no contrast against the road | CHR-3 |
| visual | Laser washes the screen pink | WPN-1 |
| visual | (known gate whiteout) also on Low | GAT-1, VIS-9 |
| visual | Shatter shards fly into the camera | FX-4 |
| visual | −1 floaters under the count label | FX-5 |
| visual | Title squad hidden behind the buttons | VIS-3 |
| visual | Damage numbers bloom into blobs | FX-3 |
| visual | Rifle tracers white; Low aliased | WPN-2 |
| visual | Rocket launcher reads weakly | WPN-3, FX-9 |
| visual | Troops cannot be told apart | CHR-6 |
| visual | Road texture repeats every 15 m | VIS-11 |
| visual | Empty shop pips invisible | UI-12 |
| visual | Coin-flight pool overflows | FX-6 |
| rules-audit | Coins rounded per event | LVL-6 |
| rules-audit | Tick pitch falls on red gates | AUD-1 |
| rules-audit | Gunfire volume never rises | AUD-2 |
| rules-audit | Spit consumes 2 plates from L10 | CHR-4 |
| rules-audit | Flipped red gate pays MAX | GAT-5 |
| rules-audit | Rocket/rail/laser gate hits ignore w | WPN-4 |
| rules-audit | Multiplier step rounding (78 vs 77) | rejected (negligible) |
| rules-audit | Boss-damage rank 7 1360 vs 1350 | rejected (GDD table typo) |
| rules-audit | Zero-change passes play positive juice | FX-7, AUD-3 |
| rules-audit | ÷→x2 flip bursts blue sparks | FX-8 |
| rules-audit | Muzzle flash 60 ms vs 33 ms | WPN-6 |
| rules-audit | Boss road slow-down exponential | LVL-13 |
| perf | Tier change freezes 3.0–3.9 s | VIS-1 |
| perf | First-appearance compile hitches itemised | VIS-2, CORE-1 |
| perf | getParameters twice per frame (two-pass, env.prop) | GAT-4, FX-2, VIS-8 |
| perf | Heavy GC churn 6–10 MB/s | GAT-4, FX-2, VIS-8, WPN-5 (squad/zombies/gates parts deferred) |
| perf | Landscape phone squad off-screen | VIS-3 |
| perf | updateRanges reallocated per frame | GAT-4, FX-2, WPN-5 |
| perf | Boss fight over the draw-call budget | ENE-9 |
| perf | Level-start stall 120–215 ms | VIS-2, CORE-1 (levelgen-under-fade deferred) |
| perf | Reloading graphics overlay hides too early | CORE-3 |
| perf | fx.shards visible at count 0 | FX-2 |
