# Round-2 fixer report: group "fx"

Files edited:
- `js/fx.js`. The pre-fix copy is `docs/build/qa2/fix-fx/fx.before.js`.
- `js/data.js`, only the listed keys: `JUICE.caps.bossNumbers` (l.1206), `JUICE.damageNumber.{bossScale, bossSide, bossRise, bossSlots}` (l.1210-1213) and `JUICE.label.{plateAlpha, platePad}` (l.1218-1219). `mergeSeconds` stays at 0.12; only its comment block moved.
- `docs/GDD.md`: the §3.1 count-label row (l.108) and the §6.1 damage-number sentence (l.219).

Checks:
- `node --check js/fx.js js/data.js` passes.
- `node tools/check-imports.js` reports 0 errors and 0 warnings.
- Every smoke run below is verdict CLEAN: 0 page errors, 0 console errors, 0 warnings. This includes `--scenario all` and a Low-tier L9 run.

**Disk note.** C: was full during this session (0 to 57 MB free, filled by other writers). Smoke and probe `--out` directories therefore went to `E:/Temp/claude/fxruns/…`. The evidence below was copied into `docs/build/qa2/fix-fx/evidence/` (about 5 MB). The scratch probes live in `docs/build/qa2/fix-fx/`:
- `labelprobe.mjs`: label plate contrast.
- `overlap-pre.js`: damage-number box overlap, used with `optprobe.mjs`.
- `optprobe.mjs`: a perfprobe copy with `--js-flags`, `--pre` probe output and all-site heap output.
- `microalloc.mjs`: per-call allocation of fx entry points in steady state.
- `burst.mjs`: the visual-2 burst capture.
- `strip.mjs`, `hstrip.mjs`: montages.
- Others: `dlog*-pre.js`, `protowatch-pre.js`, `optstat.js`.

---

## FX-10: the count label merges with beams, flashes and gate glyphs. Mostly fixed (partial)

**Changes**
1. **Backing plate.** `_buildPlate()` (fx.js:1119) adds `fx.labelPlate`, one billboarded rounded rectangle.
   - Colour `PALETTE.glyph.outline` at `JUICE.label.plateAlpha` (0.45). Normal blending, depthTest off.
   - Sized in `_writeLabel` (fx.js:2053) from the label's `nDigits` advance run: + 2·`platePad` (0.15 em) in width, and ink height (`PLATE_INK_EM` 0.74) + 2·pad in height.
   - Shader: `PLATE_VERT` / `PLATE_FRAG` (fx.js:314-360). The SDF has an anti-aliased rim; corner radius is `PLATE_RADIUS` × half height.
2. **HDR cap under and around the plate.** A second quad, `fx.labelClamp`, uses MIN blending (`CustomBlending` + `MinEquation`).
   - Under the plate it caps every colour channel at `PLATE_CEIL` (0.16 linear, fx.js:208).
   - In a 0.6 em halo around the plate (`PLATE_HALO_EM`, fx.js:210) it caps them at 0.9 × `RENDER.bloom.threshold`. The cap fades out over the outer 40 % of the halo.
   - Result: a laser, tracer or flash behind the digits cannot shine through, and nothing next to the label seeds bloom that would spill over the digits.
   - This was the root cause of the l14laser smear. A plate at 0.45 alpha alone barely dimmed an HDR beam: measured contrast stayed about 1:1.
3. **Draw order.** All five orders are integers. A fractional order would turn `Object3D.renderOrder` from a Smi into a Double on the shared InstancedMesh map, which deoptimises every module (see FX-14). `ORDER_*` is at fx.js:219:

   | Mesh | renderOrder |
   |---|---|
   | numbers | 40 |
   | clamp | 41 |
   | plate | 42 |
   | floaters | 43 |
   | label | 44 |

   The floaters ("+N", "−k") stay above the plate and undimmed, and the label stays last.
4. **Label stays LDR** (round-1 FX-1 unchanged: gain 0.82). GAT-7 has landed (`PALETTE.glyph.emissive` is 0.82). fx's white floaters use that gain and so are LDR too, with no other effect.
5. **The plate hides with the label.** `_plateCount()` sets the count on both meshes. See FX-11.

**Verification**
- **Label/laser smoke.** `smoke.js --scenario play --level 14 --seconds 20 --shots 2 --after "g.squad.setCount(22,'debug'); g.weapons.startWeapon('weapon.laser')"` is CLEAN. See `evidence/label-laser-strip.png` and the crops in `evidence/label-laser-plate-crops.png`: '22', '78' and '88' are crisp on the plate, and the beams behind are subdued stripes.
- **Burst capture.** Ran `docs/build/qa2/fix-fx/burst.mjs 4 … "g.squad.setCount(60,'debug') + steer into lane 0"` with until `activeEvent.z > −5.5` and 4 shots. The original visual-2 arguments were not recorded, so this setup is reconstructed. See `evidence/burst-wave-strip.png`.
  - '60' passes over the '×4' / '×5' panel glyph.
  - The digits sit on their dark plate and the gate glyph behind is dimmed. No '+7660'-style merge reads.
- **Contrast, `labelprobe.mjs`.** Each sample crops the plate and computes (L_fill + 0.05) / (L_bg + 0.05). L_fill is the 97th percentile of the digit band. L_bg is either the 90th percentile ("p90", strict) or the median ("med") of the plate's padding strips. Files: `evidence/lp-laser-labelprobe.json` and `lp-l9-labelprobe.json`.

  | Scenario | Before | After |
  |---|---|---|
  | L14, laser active (14 samples) | p90 median 1.18, med-based median 2.4 | p90 median 3.38 (min 1.0), med-based median 7.5 (min 1.6) |
  | L14, laser off (13 samples) | p90 median 4.9 | p90 median 8.9 (min 5.7), med-based median 11.9 |
  | L9, 150 squad, normal play (38 samples) | n/a | p90 median 8.7 (min 2.1), med-based median 12 (min 7.3) |

  In the L9 samples, the p90 minimum comes from single bright tracer streaks inside the strip. Those crops are fully legible.

**Not met: "≥ 4.5:1 in every frame".** With 3+ HDR laser beams running through the label, the post-bloom haze of the beam parts outside the halo still lifts the plate to about 3.4:1 (p90) in the median frame, and lower in the worst frame. The digits stay legible through their outline, but the fx-side cap cannot remove bloom that the beam outside the label adds after the scene pass. The full fix is to draw the label after the bloom pass; it belongs to render (see needsOtherGroup 1).

## FX-11: the count label renders behind the results and game-over screens. Fixed

**Changes**
- `_labelStateOk` (fx.js:1379) is now true only for 'playing' and 'paused'.
- `_onState` (fx.js:2755) handles the switch:
  - Entering 'complete' or 'gameover' while visible starts `_labelHideT`.
  - `update()` (fx.js:1500) advances it in real time.
  - `_writeLabel` multiplies the label, badge and plate colours and the plate alpha by the fade, and lifts the clamp caps, over `LABEL_HIDE_S` 0.25 s. After that, `_hideLabel()` sets the draw count to 0 on the label and both plate meshes.
  - Any other non-play state hides at once.
- The 'won' theatre runs in state 'playing', so the label stays visible there.

**Verification**
- `smoke.js --scenario play --level 1 --seconds 75` is CLEAN, and its result shot `evidence/results-l1.png` has no count digits.
- `smoke.js --scenario play --level 10 --boss --nobot --after "g.squad.setCount(3,'debug')"` is CLEAN, and `evidence/gameover-l10.png` shows SQUAD LOST with no '0'.

**Contract note.** ARCH §10 (l.1089) says "The HUD is visible … during complete/gameover behind the panel". The world-space count label no longer is, per GDD §9.3 / §14 and this issue. See needsOtherGroup 4.

## FX-12: boss damage numbers overprint each other. Fixed

**Changes**
- **Literals moved to data.** `NUMBER_BOSS_SCALE`, `NUMBER_SIDE`, `NUMBER_TRACK_RISE`, `NUMBER_ROWS` and `NUMBER_TRACK_SLOTS` (fx.js:156-160) now come from the new keys:

  | Key | Value | Meaning |
  |---|---|---|
  | `JUICE.damageNumber.bossScale` | 1.2 | boss number size |
  | `JUICE.damageNumber.bossSide` | 0.12 m | half-gap between the columns |
  | `JUICE.damageNumber.bossRise` | 0.25 m | rise |
  | `JUICE.damageNumber.bossSlots` | 3 | rows per column |
  | `JUICE.caps.bossNumbers` | 6 | live numbers per target (2 columns × 3 rows) |

  `NUMBER_BOSS_SIDE`, `NUMBER_BOSS_RISE`, `NUMBER_BOSS_LIVE` and `NUMBER_EVICT_U` are gone.
- **Slot grid.** `_numberSpawn` (fx.js:1770) gives each tracked target (boss −2, brute id) its own grid:
  - The new number takes the slot after the target's newest live number (ordered by spawn sequence) and retires that slot's occupant at once.
  - Column = slot & 1, on the left or right of the target, with the inner edge `bossSide` from it.
  - Row = slot >> 1. Rows are centred on the anchor height, `NUMBER_ROW_EM` 1.3 glyph heights apart along the camera's up axis.
  - The rise in `_updateNumbers` (fx.js:1973) also follows the camera's up axis and is less than the row gap.
- **Anchor on the target, not the hit point, and ride along with it** (`_nFollow`):
  - The boss uses `ctx.world.bossX / bossZ` when the hit is within `BOSS_ANCHOR_SNAP` (2 × `BOSSES.radius`). After death it uses the last known anchor, so the boss:dead flush lands on the same grid.
  - If the twin mirror switches, the numbers are re-based in place (fx.js:1506).
  - Brutes use `zombies.position(id)`.
  - Boss crits use the same grid at `BOSSES.coreY + 1.6`.
- **Data.** `mergeSeconds` is unchanged at 0.12.

**Verification**
- **Smoke.** `--level 15 --boss --seconds 30 --shots 1 --after "g.squad.setCount(400,'debug')"` and the same with `--level 5` are both CLEAN. See `evidence/boss15-numbers-strip.png`: a clean 2×3 grid ('55 64 / 46 73 / 46') sits below the HUD boss bar.
- **Box-overlap probe** (`overlap-pre.js` via `optprobe.mjs`). Every frame it projects each drawn number's ink box. Results are in `evidence/overlap-summary.json`.

  | Run | Before | After |
  |---|---|---|
  | L15 boss | 37 overlapping frames (worst 78 % area) | 0 overlapping pairs in 3 203 frames with numbers |
  | L5 boss, incl. boss death | 6 frames | 0 in 3 of 3 runs, about 1 700 frames each |
  | L9 brutes, same-target pairs | 218 frames (worst 99 %) | 0 |

  The L9 brute run still shows numbers of different targets (two brutes, untracked crits) touching. That case is outside this issue.

## FX-14: fx allocates about 114 KB/s in steady state. Fixed

**Root cause (measured; the issue's "boxing across non-inlined calls" was only part of it).** Before the fix, fx's per-frame functions spent much of each run in Sparkplug/baseline code, where every double is a fresh HeapNumber. Over 45 s of L9, `update` was optimised in only 33 % of frames and `_updateShards` in 8 %. Measured with `%GetOptimizationStatus`, V8 `--log-deopt --log-maps --log-function-events`.
- **Map deprecations.** Fields created from a Smi (0 or −1) and later given a fraction are generalised Smi → Double. That deprecates the object's map and deoptimises everything compiled against it. Examples: `Fx._lastHitDmg`, `_trauma`, `_real`, `_shakeT`, `_lastHaptic`; `CountLabel.shown`, `from`, `tweenT`, `x/y/z`; `pm.liveUntil`. That produced about 120 mass deopts per field, and V8 took 6-17 s to re-tier each function.
- **First-path deopts.** "Insufficient type feedback" on branches first reached in play: first boss, rocket, ring wrap, icon flight, and so on.
- **Boxing that remained even in optimised code:**
  - `writeTRS` with 8 double arguments.
  - `util.noise1` / `hashInt01` in `getShake`.
  - `ease.*` and `L._scale()` returning doubles.
  - Writes to three.js `{value}` uniform fields, which are Tagged.
  - Typed-array loads passed as `_emitRaw` arguments in the per-hit handlers.
  - The per-emit `rngFx.next()` draw.
  - Typed-OM setters receiving fresh doubles.

**Changes (all in js/fx.js)**
- **Double seeds.** `F64 = −0` (fx.js:228). Every fraction-holding field of Fx, CountLabel, `pm`, `SCREEN_OUT` and `TARGET_OUT` is created from it, so its field starts out Double.
- **No doubles across calls:**
  - `writeTRS(arr, o)` reads the `TRS` Float64 scratch (fx.js:460).
  - fx-local `eOutQuad`, `eOutCubic`, `eInOutCubic` and `eOutBack` (fx.js:470); the `ease` import is gone.
  - `getShake` uses an inline value noise over `hash30`, which returns Smis (fx.js:479, 2596); the `noise1` import is gone.
  - The punch scale and the sim clock are read inline.
  - The per-hit handlers pass module-constant spark parameters (fx.js:100).
  - The plate uniforms are written only when the fade changes.
  - The camera and size are cached via `_camera()` (fx.js:1542), so a RenderSystem map deprecation no longer deoptimises fx.
  - The cosmetic xorshift is seeded once per reset instead of once per emit.
  - `particleCount` reads an Int32 death-ms ring (fx.js:1578), with no Float32 loads.
- **Typed-OM coin and icon sprites** (`DomSprite.move`, fx.js:610):
  - Integer px values are passed as Smis.
  - Scale and opacity are quantised to 1/256 and taken from a pre-boxed `SPRITE_QV` table.
  - Nothing is written when the quantised values are unchanged; opacity is written only when it changes. This also cuts the Blink style invalidations.
- **JIT and type-feedback warm-up.** `_primeFeedback()` / `_primeWave()` (fx.js:912) run once on the first 'title' state change, when every system exists.
  - The warm-up runs 900 simulated frames that exercise every pool branch (and both `_writeLabel` paths), then `reset()`.
  - Measured cost is about 27-31 ms, once (`g.fx._primeMs`).
  - Audio ticks are muted while it runs (`_priming`).
  - Squad already does the same ("JIT-warmed in init()", ARCH §6.5).

**Verification.** The spec command was `node docs/build/qa/perf/perfprobe.mjs --level 9 --quality high --seconds 45 --after "g.squad.setCount(600,'debug')" --heapprof`. Results are in `evidence/heap-summary.json`.

| Run | fx allocation |
|---|---|
| Before, perfprobe (top-60 sites) | 4 953 KB / 45.8 s = **6.5 MB/min** |
| After, perfprobe (top-60 sites) | 418 KB / 45.7 s = **0.55 MB/min** |
| After, all sites (`optprobe` without the top-60 cut), run 1 | **0.85 MB/min** |
| After, all sites, run 2 | **0.89 MB/min** |

- Steady state (`microalloc.mjs`, optimised code, bytes per call):

  | Entry point | Before | After |
  |---|---|---|
  | `label.setWorldPos` / `_writeLabel` | 57.6 | 0.27 |
  | `fx.update` | 8.5 | 4.2 |
  | `getShake` | 76 | about 6 (the caller's `out` stores) |
- **What remains:** baseline windows after other modules' map deprecations (see needsOtherGroup 2) and event-time paths (`_shatter`, `emit(opts)`, coin launches).

## FX-13: the sniper's red beam starts about 0.9 m below his muzzle. Fixed

**Changes**
- `_onTroopFire` (fx.js:3016) starts the beam at `p.y` when it is a finite number, and falls back to the old crate + muzzle-offset formula otherwise. CHR-14 has landed: troops.js sets `P_FIRE.y = V_B.y`, the posed muzzle.
- It also accepts an optional `p.ty` for the beam end, defaulting to `BEAM_TARGET_Y`.

**Verification**
- `smoke.js --scenario play --level 5 --seconds 30 --shots 1 --after "g.troops.add('troop.sniper')"` is CLEAN.
- The beam lasts 80 ms, which 1 s shots miss, so a burst capture froze the beam age on the first `troop:fire`. See `evidence/sniper-beam.png` and `evidence/sniper-beam-crop.png`: the red tracer leaves from the sniper's raised rifle at helmet height, not from below it.

---

## needsOtherGroup

1. **render.js: draw the count label after bloom (residual FX-10).**
   - Render `fx.labelClamp`, `fx.labelPlate` and `fx.label` (renderOrders 41, 42, 44) in a second RenderPass after `TierBloomPass`, before `GradeOutputPass`: clear false, same camera, layer-filtered.
   - Expose the layer as `render.overlayLayer` (an integer), then ask fx to `mesh.layers.set(render.overlayLayer)` on those three meshes. fx does not set layers yet, so the label is not lost if the pass is absent.
   - This removes the bloom haze of HDR laser beams over the digits. That haze is the only case still under 4.5:1: about 3.4:1 p90 in the median frame with 3+ beams through the label.
2. **All modules (render.js, ui.js, level.js, audio.js, environment.js, main.js world/time objects): seed fraction-holding fields as Doubles (V8 map deprecation).**
   - Fields created from Smi literals and later given fractions deprecate their object's map. That deoptimises every function compiled against it, in every module that reads those objects; V8 then needs 5-17 s to re-tier, running baseline code that boxes every double.
   - Seen with `--log-maps` on L9: Deprecate events attributed to `UI` (≈180 at ui.js ~1700/1705/1731/937/1786/1569/1570/934/1784/1939-1943/2028/2862-2873), `LevelRunner` (~869/552/763/899/1285), `RenderSystem` (~1201/1958-2022, e.g. `_frameBackT`, `_presetBlend`, `_idleBlend`), `AudioSystem` (~893), and plain objects (world/time). Line numbers are from the measurement time.
   - Mass "dependent prototype chain changed" deopts also hit every module at about 8 s, 35 s and 39 s into play.
   - Fix pattern, as in fx.js:228: create such fields from `-0`, or assign a fraction first in the constructor. Never use a fractional `renderOrder` on a shared three.js class.
   - The `ctx` object itself is in dictionary mode: main.js assigns `ctx[name] = …` with computed names (main.js ~348). Literal property assignments would keep it fast.
3. **troops.js (optional):** add `P_FIRE.ty`, the target height. Use `BOSSES.coreY` for the boss shot and `SNIPER_HIT_Y` for zombies; fx then ends the red tracer at the real hit height instead of 1.0 m.
4. **docs/ARCHITECTURE.md (not mine):**
   - §6.12 / §9.1 (l.987-992): fx adds `fx.labelPlate` + `fx.labelClamp`, so +2 main-pass draw calls while the label is visible (fx 6 → 8).
   - fx text renderOrders are now numbers 40, clamp 41, plate 42, floaters 43, label 44 (were 40 / 41 / 42).
   - The label hides in 'complete' and 'gameover' with a 0.25 s fade (FX-11). §10 l.1089 "HUD visible during complete/gameover" no longer covers the world-space count.
   - fx runs a one-time JIT warm-up (`_primeFeedback`, about 30 ms) on the first 'title' state.
   - `troop:fire` payload (§5.1 l.254): fx consumes `y` (CHR-14) and an optional `ty`.
   - Damage numbers: the per-target slot grid that rides along with its target (§6.12).
5. **qa / perf tooling:** `docs/build/qa/perf/perfprobe.mjs` keeps only the top 60 allocation sites (all modules together), so per-file totals are underestimates. `docs/build/qa2/fix-fx/optprobe.mjs` keeps 2 000.
