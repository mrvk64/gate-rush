# QA round 2: cross-group integrator report

I read all ten fixer reports in full: `docs/build/qa2/fix-{audio,characters,core,enemies,fx,gates,level,ui,visual,weapons}.md`. This report covers every item under "needsOtherGroup" and the documentation updates the reports asked for. Each item is marked applied, already landed, deferred, or rejected, with the reason.

## Gates (final code)

| Check | Result |
|---|---|
| `node --check` on every `js/*.js` and `tools/*.js` | OK |
| `node tools/check-imports.js` | 0 errors, 0 warnings |
| `node tools/callsites.js` | `docs/build/CALLSITES.md` regenerated (605 lines) |
| `node tools/validate-levels.js` | 30 levels, 0 errors, 6 warnings (the same 6 the level fixer reported). Output in `cross/validate.txt` |
| `node tools/build-artifact.js` | `artifact.html` rebuilt with 34 module preloads; the sw.js PRECACHE check passes |
| `node tools/smoke.js --scenario boot --out docs/build/qa2/cross/final-boot` | **CLEAN** |
| `node tools/smoke.js --scenario play --level 1 --out docs/build/qa2/cross/final-l1` | **CLEAN**. L1 cleared with 3 stars and 239 survivors; frame p95 7.0 ms |

Extra smoke runs, all **CLEAN** (0 page errors, 0 console errors, 0 failed requests):

- `cross/all`: `--scenario all`.
- `cross/l14laser`: label over 8 laser beams.
- `cross/l9low`: Low tier, which checks the overlay layer on the no-composer path.
- `cross/l5boss`: Spitter Queen with the sniper and the drone added.
- `cross/l17twins`: Hulk Twins at 400 soldiers. Main pass 43 draw calls, shadow pass 12.
- `cross/sandbox` and `cross/artifact`: the artifact shell with module preloads. The sandbox run shows only the expected "Progress won't be saved" warning.

I looked at the screenshots: title, play, laser, Low tier, both boss fights and the results screen.

**Disk.** C: hit 0 bytes free during this session, because other processes on the machine were writing to it. One `sed -i` of mine failed with ENOSPC, but it left the file intact.
- To unblock the gates, I *moved* `docs/build/qa/verify` (361 MB of round-1 evidence, idle since 09:36) to `E:/Temp/claude/gate-rush-evidence-moved/docs-build-qa/verify`. I verified the copy first (460 files, identical bytes) and left an NTFS junction at the original path, so every path still resolves.
- `docs/build/qa2/cross/` is also a junction to `E:/Temp/claude/gate-rush-evidence-moved/qa2-cross`.
- My small tools are a real folder on C: `docs/build/qa2/cross-tools/`.

---

## Item by item

### fix-audio

| # | Item | Status |
|---|---|---|
| 1 | ARCH §6.13: unlock contract, setTimeScale, graph; §11 mode switches | **Applied.** §6.13 now covers: the context and graph are built in `init()`, `unlock()` only resumes, the scheduler starts at the first 'running', setTimeScale's live / future / `noTimeScale` rules, the graph comp → limiter → clip, and the restart and beat rules. I also amended §4.1 step 7, the §4.2 scheduler sentence and the §11 graph and amendments paragraph. |
| 2 | main.js boot comment / `PROGRESS.audio` weight | **Comment applied** (`js/main.js` step 7). The weight is **not changed**: the AudioContext constructor is synchronous, so the bar cannot move during it, and a larger weight would only enlarge the jump that follows. |
| 3 | Profile the first-PLAY hitch (62–201 ms) | **Deferred.** This is investigation work outside audio, and audio's share is already 0.4 ms. The UI report attributes the L1 start frame to render (≈ 45 ms) and level (≈ 17 ms); see the UI table, item 5. |
| 4 | Every gate pass ≥ 6 dB: an "approach" event or a post-compressor reward bus | **Deferred: design decision.** The report presents both options as choices for the lead, and neither is a defect fix. |
| 5 | Disk space | **Handled** by the evidence move above. Nothing was deleted. |

### fix-characters

| # | Item | Status |
|---|---|---|
| 1 | FX-13: sniper beam from `p.y` | **Already landed** in fx (`_onTroopFire`, `p.y` when finite). |
| 2 | `'skin'` in boss `SHADOW_PARTS`; drop models' `lockCastShadow` | **Applied.** `js/boss.js` SHADOW_PARTS lists `'skin'`, and the twin arm / head toggles now act only on Mesh joints, since on the skinned rig they hit Bones and did nothing. In `js/models.js` the `Object.defineProperty` accessor lock is gone and the code sets `skin.castShadow = true` plainly. That accessor also gave the mesh an instance accessor property, which is a V8 shape hazard. In the twins smoke, the shadow pass was 12 draws and the skin still casts. |
| 3 | ARCH §6.4: Bones, the `skin` / `eyes` / `glow` SkinnedMeshes, `rig.skin` / `rig.skeleton` | **Applied** (§6.4 and the §9.1 scene graph). |
| 4 | ARCH §6.6: APC 3.5 m, sniper flank perch, drone placement, non-lethal flamer, `troop:fire.y` | **Applied** (§6.6 and §5.1). The §7 flamer row was stale (7 m range, lethal), so I fixed it too. |
| 5 | Periodic "dependent prototype chain changed" deopts | **Root-caused and fixed.** See the section on mass deopts below. |
| 6 | Re-check L10 / L11 margins with the support-only flamer | **Deferred to the balance owner.** It needs camp runs and a balance decision; it is not an integration fix. |
| 7 | `TROOPS.anim` cleanup | **Applied.** troops.js now reads `const ANIM = TROOPS.anim`, and I verified all 50 shared keys were equal first. The 15 local-only keys (`droneAhead`, `droneMaxX`, the flamer aim and volley keys, `flamerHpFloor`, `flamePilotReach`, `sniperSideMargin`, `sniperMinX`, `droneDiscFlicker`) moved into data.js. `sniperRearMargin` is removed. troops.js's 4 remaining DATA-MISSING literals now read their existing data keys. |

### fix-core

| # | Item | Status |
|---|---|---|
| 1 | render VIS-17: `warmup(onProgress)`, yields, tiled grain, chunked warm draws | **Already landed** (visual report VIS-17). `render.warmup(onProgress)` exists and main passes the callback. The 4× acceptance still needs a quiet host (see fix-visual item 5). |
| 2 | ui `BOOT_STEP_AT` boundaries | **Applied.** It is now `[0.05, 0.30, 0.36, 0.37, 0.50]`, matching CORE-9's `PROGRESS`. |
| 3 | ARCH §4.1 (step 9c `await ui.prewarm()`, `setBootCaption`, `onProgress`) and §9.5 (leading and trailing resize) | **Applied.** §4.1 now has steps 9b and 9c, the weights and captions, and the yields. §9.5 has the leading and trailing edge plus the orientation-flip rule. |

### fix-enemies

| # | Item | Status |
|---|---|---|
| 1 | ARCH §6.7 / §6.8: `hitTestSeg`, front-only brute contact, theatre timers, cosmetic `out.x` / `out.y`, light offset | **Applied.** |
| 2 | `ZOMBIES.brute.backoffM` key | **Applied.** `ZOMBIES.brute.backoffM: 2.0` now exists and zombies.js reads it. I also wired every other `DATA-MISSING` literal whose data key already existed with a deep-equal value. That was 64 constants in zombies (23), weapons (28), squad (4), render (3), materials (4) and fx (2), plus troops' 4 and the new backoff key. All values are unchanged; the script compares by JSON before rewriting. |
| 3 | L11 brute HP at C ≈ 34 / endless brutes reaching the swing cap | **Deferred to level / balance** (HP curve decision). |
| 4 | WPN-9: boss-aimed tracers end at the hit height | **Already landed** (weapons `BOSS_TRACER_Y`, from `BOSSES.hitYRange`). |
| 5 | Optional: lower the boss light toward the road | **Rejected.** It is optional, the fixer had no reliable measurement, and nothing requires a warm pool on the road. |

### fix-fx

| # | Item | Status |
|---|---|---|
| 1 | render: draw the count label after bloom (FX-10 residual) | **Applied:** `render.overlayLayer` (30) plus an `OverlayRenderPass` placed between `TierBloomPass` and `GradeOutputPass`. Details below the tables. |
| 2 | All modules: seed fraction fields as Doubles; `ctx` in dictionary mode | **Applied.** See the section on mass deopts below. |
| 3 | troops `P_FIRE.ty` | **Applied.** Sniper: `TROOPS.sniper.hitY` on a zombie, `BOSSES.coreY` on the boss. Drone: `FIRE.bullet.y`. fx already reads `p.ty`. ARCH §5.1 is updated. |
| 4 | ARCH: fx draws +2, renderOrders, label hide in complete / gameover, JIT warm-up, `troop:fire` y / ty, slot grid | **Applied** (§6.12, §9.1, §10.1, §5.1). |
| 5 | perfprobe keeps only the top-60 sites | **Applied.** `docs/build/qa/perf/perfprobe.mjs` adds `allocByFileKB`, which totals every sampled site per file. `alloc` (top 60) is unchanged for comparability. |

### fix-gates

| # | Item | Status |
|---|---|---|
| 1 | render `_compileChunked` `Object.create(o)` proxies as the suspected deopt source | **Applied, but it was not the cause.** A/B on L9 (`cross/deopt-proxyA` vs `deopt-standB`) gave 117 vs 123 prototype deopts. I kept the change as hygiene: a plain stand-in (`COMPILE_STAND`) carries exactly what three r170's `compile()` / `getParameters()` read, so meshes no longer become V8 prototype objects. The Low → Medium → High program sets match the proxy version exactly (`cross-tools/tierprog.mjs`: 42 / 42 / 108 / 108 programs, no difference). The real cause is in the section on mass deopts below. |
| 2 | Measure the gates / pickups budget with warm-up | **Noted, no code change.** perfprobe `allocByFileKB` and `cross-tools/deoptab.mjs` support it. |
| 3 | fx `HDR_WHITE` follows emissive 0.82 | **No change needed.** fx re-checked readability (FX-10 / FX-12). |
| 4 | MAX badge size key | **Rejected.** The fixer reports it looks fine and no design ask exists. |
| 5 | Re-measure glyph contrast now that GAT-7 and VIS-12 have both landed | **Done.** `glyphprobe.mjs` on High / Med / Low (`cross/glyph-*`): every op is ≥ 3:1 on every tier. Behind-glyph minimum is 3.84 (Med ×), surround minimum 3.19 (Med ×), and the strictest surround+halo minimum is 3.06 (Med ×). The + / − / ÷ panels are 4.3–5.6. **GAT-7 acceptance (≥ 3:1) is met.** |
| 6 | ARCH §6.9 / §6.10 / §5.1: `hitTestSeg`, dead-squad miss-all, pickups after death, crate depth material | **Applied.** |
| 7 | "Coins kept +1" after death | **Intended.** It is the LVL-21 fail consolation (`coin:pickup` source 'bonus' at game over). |
| 8 | CALLSITES | **Regenerated.** |
| 9 | Disk | **Handled** (see the disk note at the top). |

### fix-level

| Item | Status |
|---|---|
| data.js incident | **Verified.** data.js parses and every group's round-2 keys are present: spot-checked `TROOPS.anim`, `ZOMBIES.brute.*`, `MUSIC.limiter`, `JUICE.ui.hint*`, `QUALITY_TIERS.med.bloomMips`, `BOSSES.hitYRange`, `LEAK_MODEL.calib`. All smoke runs are clean. |
| UI-25: ui marks hints on display | **Already landed** (`ui._markHint` → `save.markHint`). ARCH §5 "Who listens" was stale, so I fixed it. |
| CORE-7 theatre clock | **Landed.** ARCH §6.16 now describes the results deadline on the theatre clock. |
| Boss fights below the curve | **Deferred** (observation for the enemies and balance owners). |
| Design contradictions: §6.3 leak bands vs §17 "8–12 % of C", LVL-23 payout term, endless end condition | **Deferred to the design owner.** These need decisions; integration cannot settle them. |
| QA tooling: no gear / pickup data in the smoke timeline; 30 s boot timeout | **Applied.** `tools/smoke.js` adds `gear` to every timeline sample, `report.pickups` (`{t, item, duplicate}` per `item:pickup`, reset on `level:start`) and `--bootTimeout S` (default 30). The L1 run shows `[{t:19.8, item:'weapon.shotgun'}]`. |
| ARCH §6.17 levelgen exports | **Applied**, plus the new `levelGenerator`. |

### fix-ui

| # | Item | Status |
|---|---|---|
| 1 | main: `await ui.prewarm()`, `setBootCaption` | **Already landed** (CORE-9: main.js steps 9c and `caption()`). |
| 2 | ARCH §6.14 / §4.1 / §10.2 | **Applied.** §6.14 now has `prewarm()` and `setBootCaption()`. §10.2 has the hint CSS variables, the retired `--hint-y` and the 12 px floor. |
| 3 | level LVL-18 idle prefetch runs a whole generation in one 115 ms task | **Applied.** levelgen exports `levelGenerator(L, seed)`, which runs one generation attempt per `step()`, and `generateLevel` loops it. The output is byte-identical: a SHA-256 over L2–L30 × 2 seeds matches before and after, and validate-levels' determinism check passes. `level._runPrefetch(deadline)` runs attempts while `timeRemaining() ≥ 6 ms` (8 ms slices without rIC, at least one per slot). A `start()` that hits an in-flight key finishes that generator. `cross-tools/prefetch.mjs`: at 1× there are no long tasks, L9 + L13 are cached in 263 ms, the cached script equals `generateLevel`, and `start(9)` is a memo hit (0 ms). At 4×, one long task of 90 ms remains (the largest single attempt), against a whole generation per task before. |
| 4 | Rebuild artifact.html; module preloads in the artifact shell | **Applied.** `tools/build-artifact.js` copies the `<link rel="modulepreload">` tags after the import map, because Chrome rejects an import map once a module preload has started. artifact.html is rebuilt and the sandbox and artifact smokes are clean. ARCH §15.2 is updated. |
| 5 | L1 start frame 78 ms at 4× (render.draw ≈ 45 ms, level ≈ 17 ms) | **Deferred.** It needs a render / level profile on a quiet host; no code change could be identified from the reports. |
| 6 | Optional: fx DOM coin sprites | **Rejected** (optional; FX-14 already quantises and skips unchanged typed-OM writes). |

### fix-visual

| # | Item | Status |
|---|---|---|
| 1 | Debug overlay prints `callStats.materials` | **Applied** (`mats N` on the calls line). |
| 2 | `matrixAutoUpdate = false` on hidden rigs, shared boss / troop materials | **Rejected.** three r170's `updateMatrixWorld` recurses into every child regardless of `matrixAutoUpdate` / `matrixWorldAutoUpdate`, so skipping a hidden rig would need detaching it from the scene. That breaks the VIS-1 / VIS-17 contract that the warm-up and tier pre-compile see every object, and saves only microseconds. Per-boss material clones are required: boss.js drives per-rig rage and flash emissive on them. |
| 3 | ARCH §9.4 (Medium 3 mips), §9.5 (`rebuild()` drops lost-context objects), §8.1 / §8.9 new keys | **Applied.** §8 has a round-2 key-change summary per subsection. |
| 4 | gates digit spacing at close range | **Rejected** (optional; no issue at decision distance). |
| 5 | Quiet-host re-runs (VIS-13 / VIS-17 throttled, VIS-12 glyphs) | **Partly done.** VIS-12 glyphs were re-run (fix-gates table, item 5). VIS-13 and VIS-17 at 4× are **not** re-run: the host is still shared, so those acceptances remain unverified. |

### fix-weapons

| # | Item | Status |
|---|---|---|
| 1 | Overlay shots/s | **Applied** (`shots/s N`, and `beams N` while lasers are live). |
| 2 | ARCH §8.1 `FIRE.bossAimYieldM` | **Applied** (§8 key summary; §6.11 already had it). |
| 3 | Typed damage variants (`zombies.damageHit` …) | **Deferred** (optional, ≈ 0.3–0.6 MB/min). It would add API surface in three modules for a non-required budget item. |
| 4 | soak-l4 balance observation | No change requested. |

### Overlay pass (fix-fx item 1)

How it works:
- `render.overlayLayer` is layer 30. `OverlayRenderPass` sits between `TierBloomPass` and `GradeOutputPass`.
- The pass draws into the bloomed buffer with no clear and no swap.
- For that render the camera sees only the overlay layer: no lights are gathered, no shadow pass runs, and `scene.matrixWorldAutoUpdate` is suppressed.
- On Low (no composer), the camera enables the layer for the single scene render.

What fx puts on the layer:
- The label and the plate are only on the overlay layer.
- The HDR clamp is on layers 0 and 30. It caps before bloom, so nothing under the label seeds bloom, and again after it, so it caps haze that reaches the plate.
- The floaters are also on layers 0 and 30. They still bloom in the main pass and are drawn crisp above the plate.

Draw calls: the overlay draws count as **main** in `callStats`, so the §9.1 budget semantics are unchanged.

Result (`fix-fx/labelprobe.mjs`, same arguments as FX-10, `cross/lp-laser2` vs `fix-fx/evidence/lp-laser`):

| Frames | Plate contrast before | After |
|---|---|---|
| Laser on | 2.7–3.8:1 | **5.85:1 in every frame** |
| No laser | 6–12:1 | 7–12:1 |

The single 0.98 sample is the probe's transitional frame where the count jumps from 22 to 88 and the plate resizes. The before run has the same artefact. In the crops the teal haze over the digits and outline is gone.

### Mass deopts (fix-characters item 5, fix-fx item 2)

**Measurement.** `cross-tools/deoptab.mjs` plays L9 High with 600 soldiers for 40 s, with optional module substitution. V8 runs with `--log-deopt`, plus `--log-maps --log-maps-details` for map logging. `mapgen.cjs` lists, per object shape, the fields whose representation was generalised after a given time.

**Cause.** The storms are **field representation generalisations (Smi → Double) on shared objects**, not prototype mutations. The first fractional store into a field created from 0 / 1 / −1 deprecates the object's map, and V8 shares that map with every literal of the same shape across modules. Every optimised function that touched the map then deoptimises ("dependent prototype chain changed"). Examples:
- `ctx.time.scale` at the first slow-mo. At 47 s this one change deoptimised level, audio, pickups, engine, render and others together.
- `elapsed` / `levelTime`.
- UI fields: 1 200+ deprecations per run.
- `AudioSystem._rate` and related fields.
- The RunStats coins.
- Event payloads shared across modules, such as `{ amount, x, y, z, source }` in five modules and `{ count, x, z, … }`.
- The boss unit's `deathAt` at `boss:dead`.

In addition:
- `ctx` was in **dictionary mode**: nine systems were added through computed keys after 12+ out-of-object properties.
- render's VIS-13 counter wrote a `_grMatStamp` property onto three materials.

**Fixes.**
- `ctx` declares every member up front (`main.js`).
- Fraction fields are seeded as Doubles: `this.f = 0.5; this.f = 0;`, or `-0` in module-level payloads that are always written before an emit. This covers `ctx.time` / `input` / `world` / `debug.jsMs`, RunStats, LevelRunner, the UI, AudioSystem fields, OPTS, cue-state and queue entries, Engine, Environment, render camera and light fields, the boss units and payloads, the point-light intensities, and about 60 event payload / query-out literals in 11 modules.
- `_grMatStamp` is replaced by an `Int32Array` indexed by `Material.id`.

**Result.**

| Run | Prototype-chain deopts before | After | After level start |
|---|---|---|---|
| L9 | 117 (storms at 10, 38 and 45 s) | **22** | **0** |
| L5 boss run with slow-mo and results | 57 (storms at 26 and 29 s) | **29** | **0** |

The remaining deopts all fall in boot. Map-log runs after the fix show no mid-play deprecation except levelgen's own temporary objects.

A heap probe (`cross/heap-l9`, perfprobe L9 / 600 / 45 s, all sites) measured 20.5 MB in total. The fixers' runs of the same command earlier today measured 25.4–28.7 MB. This is a single run on a shared host, so it is indicative only.

I added rule 11 (V8 hygiene) to ARCH §14 so new code keeps the pattern.

## Documentation edits

**ARCHITECTURE.md**
- §3 `ctx` (declared up front; `time.theatre`).
- §4.1 (steps 1, 7, 9b, 9c; weights and captions) and §4.2.
- §5.1 (`gate:miss` dead squad, `troop:fire` ty) and "Who listens" (markHint).
- §6.2 overlay line.
- §6.3 (`overlayLayer` / `overlayPass`, `callStats`, compile stand-in).
- §6.4, §6.6, §6.7, §6.8, §6.9, §6.10, §6.12, §6.13, §6.14, §6.16, §6.17.
- §7 (flamer row).
- §8 (round-2 key summary).
- §9.1, §9.4, §9.5, §10.1, §10.2, §11.
- §14 (rule 11), §15.2.

**GDD.md**
- §3.1 count-label row (drawn after bloom).

The other GDD sections were amended by their owners in round 2.

## Files changed by this pass

**js:**
- `main.js`, `engine.js`, `render.js`, `fx.js`, `troops.js`, `boss.js`, `models.js`, `zombies.js`, `weapons.js`, `squad.js`, `materials.js`, `ui.js`, `audio.js`, `level.js`, `levelgen.js`, `environment.js`, `gates.js`, `pickups.js`.
- `data.js`: `TROOPS.anim` keys, `ZOMBIES.brute.backoffM`.

**Tools and evidence scripts:**
- `tools/smoke.js`, `tools/build-artifact.js`, `docs/build/qa/perf/perfprobe.mjs`.

**Regenerated:**
- `artifact.html`, `docs/build/CALLSITES.md`.

**Docs:**
- `docs/ARCHITECTURE.md`, `docs/GDD.md`.

**Pre-pass copies** of js, css, tools, index.html, sw.js and the docs are in the session scratchpad, under `…/scratchpad/before/`.
