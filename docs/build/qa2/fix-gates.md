# Round-2 fixer report: group "gates" (js/gates.js, js/pickups.js)

Files edited: `js/gates.js`, `js/pickups.js`, plus targeted edits in `js/data.js` (`PALETTE.glyph.emissive`, `GATE_RULES.glyph.icon`, and the new keys `PICKUPS.crate.hitFlashGain` / `hitFlashRetrigger`; `PICKUPS.crate.hitFlash` already existed at 0.08 and is now read by pickups.js) and `docs/GDD.md` (§4.1, §12 J3 row, §15 Gates row).
Checks: `node --check` passes on all three JS files. `node tools/check-imports.js` reports 0 errors and 0 warnings. The final boot smoke is CLEAN. The final play smoke (`--level 2 --seconds 40`, `docs/build/qa2/fix-gates/final-l2`) is CLEAN, with no page or console errors and no warnings.
Evidence lives in `docs/build/qa2/fix-gates/`. The scripts there are copies of the harness pattern: `lib.mjs`, `t5-squad.mjs`, `glyph-contrast.mjs`, `max-badge.mjs`, `crate-fire.mjs`, `crate-shadow.mjs`, `microalloc.mjs`, `allocab.mjs`, `deopt-trace.mjs`, `optstatus.mjs` and `protowatch.mjs`.

Summary: GAT-6 fixed · GAT-7 partial (the glyph side is done; ≥ 3:1 on + and × panels needs VIS-12) · GAT-8 fixed · GAT-9 partial · GAT-10 fixed.

---

## [GAT-6] A dead squad is revived by a + gate: **fixed**

Changes:
- `js/gates.js:1173`: when an event reaches z ≥ 0 in `step()`, `_squadGone()` (`:1180`) checks for `ctx.squad.count === 0` or `ctx.level.phase === 'lost'`. If either holds, the event goes to `_resolveMissAll(e)` (`:1192`) instead of `_resolvePass`. Every lane is set to ST_MISSED and `gate:miss` is emitted once per lane. Nothing else happens: no `squad.applyGate`, no `gate:pass`, no gate coins and no item grant. The lane lock and the lane decal are released exactly as they are after a pass.
- `js/pickups.js`:
  - `_squadGone()` at `:359` applies the same rule.
  - `grantItem` (`:442`) and `hit` (`:540`) do nothing once the squad is dead.
  - `step` (`:573`) skips contact-open and the magnet capture.
  - Coins already flying to the squad vanish without paying (`:605`).
  - Crates and idle coins keep scrolling and despawn.

Verification: `docs/build/qa2/fix-gates/t5-squad.mjs` (a copy of edge-cases t5 that also logs `gate:miss` and `coin:pickup`) → `t5-squad.log`, `t5-squad/report.json`. There were 0 page or console errors.
- **Killed 0.15 s before the pass.** Log: `1.76 squad:dead ph=lost`, `1.90 gate:miss +21`, `1.90 gate:miss +24`. There is no `gate:pass` and no gate `coin:pickup`, and the final count is 0. `t5-squad/04-dead-then-gate-0.15.png` shows the label at 0 with no soldiers standing.
- **Killed 0.6 s before the pass.** `1.93 gate:miss` × 2, no pass, count 0.
- **Coins kept.** "Coins kept +1" in both cases. That coin comes from a level-side `coin:pickup source:'bonus'` emitted at game-over, not from the gate, and it is identical in both cases (before the fix the gate added its +3 and revived the squad to 22).

## [GAT-7] Gate glyph contrast (glyph side): **partial** (my side done; acceptance needs VIS-12)

Changes:
- `js/data.js` `PALETTE.glyph.emissive` 1.2 → **0.82**, just under `RENDER.bloom.threshold` 0.85 (the same rule the count label's gain uses), with a comment explaining why.
- `js/data.js` `GATE_RULES.glyph.icon` 0.7 → **0.95**, for the + / − op glyph. × and ÷ stay at `opMultDiv` 1.05.
- `js/gates.js`: the op glyph and the digits are written with the same fill colour, `PALETTE.glyph.fill × emissive`, in the render glyph loop. It was already the same colour; the attribute protocol comment now says so (header `iColor` lines and `_rebuildText` doc).
- `docs/GDD.md`:
  - §4.1: "glyph (+ − 0.95 m, × ÷ 1.05 m (round-1 QA GAT-3, round-2 QA GAT-7))".
  - §15 Gates row: "emissive 0.82 (under the 0.85 bloom threshold …; round-2 QA GAT-7)".
  - §12 J3: "panel emissive flash tinted, rate-limited, capped at 0.45 under sustained fire (round-1 QA GAT-1)".

Verification: `glyph-contrast.mjs <tier>` freezes a gate pair at z ≈ −37 and z ≈ −35 (time scale 0.05) on each tier. It measures the brightest 5 % of the text box against the median of the panel band around the text (WCAG ratio), writing `glyph-{high,med,low}/report.json`, plus `glyph-high/crop3x-plus-*.png`. VIS-12's plate was already visible in the crops when these were taken; its luminance cap may not have been.

| tier | glyph core (sRGB) | + | × | − | ÷ |
|---|---|---|---|---|---|
| High | 220–223 | 2.2–2.3 | 2.5–2.7 | 4.0–5.0 | 5.3–5.4 |
| Med | 220–222 | 2.2–2.4 | 2.5–2.7 | 4.0–5.0 | 5.3 |
| Low | 228–230 | 3.0–3.2 | 3.05–3.2 | 5.1–5.9 | 6.1–6.4 |

- **Halo.** In the 3× crop around "+10" on High there is no halo outside the glyph outline (`glyph-high/crop3x-plus-z37.2.png`).
- **Digits are not grey.** After ACES the digit core is sRGB about 220 (it was about 241 at emissive 1.2). Any value ≤ 0.9 lands within about 5 levels of this, so this is the cost of staying under the bloom threshold.
- **Not yet met.** ≥ 3:1 is not met on the + and × panels on High and Medium (2.2–2.7). The remaining gap is panel luminance, which is VIS-12's cap and plate. Re-measure with `node docs/build/qa2/fix-gates/glyph-contrast.mjs high|med|low` once VIS-12 has fully landed.
- **MAX badge.** The MAX letters and the gold pill both derive from `GATE_RULES.glyph.icon` (materials.js:90-91), so they grew from 0.7 m to 0.95 m together. `max-badge/01-max-near.png` shows them still aligned and clear of the panel and frame. See needsOtherGroup if the old badge size is wanted.

## [GAT-8] Shadow-depth program churn (crates): **fixed**

Change: `js/pickups.js:218`: `crates.customDepthMaterial = this._depthMaterial(render)` (`:346`).
- It uses `MaterialLibrary.depthFor({ instanced: true, instanceColor: false, map: false })` when that exists (VIS-14).
- Until then it uses an owned `MeshDepthMaterial({ depthPacking: RGBADepthPacking })`. This is the same program three's internal depth material uses for instanced casters, but a material of its own, so it is never re-resolved for another caster kind. It is disposed in `dispose()`.
- The lid hinge is not mirrored in the shadow (a 0.8 m box; the lid pop lasts 0.35 s).
- render.js's tier pre-compile already handles `customDepthMaterial`.

Verification:
- **shadowchurn2.** The run re-done with out → `docs/build/qa2/fix-gates/shadowchurn2` (`shadowchurn2.log`) logged `SHADOWCHURN {"frames":4208,"counts":{}}`: zero re-resolutions in 15–45 s.
- **Targeted.** `crate-shadow.mjs` (L3 Medium, crates streamed past the squad and the env casters) → `crate-shadow/report.json`: `crateShadowDraws` 1720 over 1720 frames, re-resolution counts `{}`, `depthMat` "MeshDepthMaterial packing 3201". Crates still cast shadows (`crate-shadow/00-crates-med.png`).

## [GAT-9] Allocation (segment queries, gates.render): **partial**

The code side is done: optimized code allocates nothing. Real-play sampling still shows JIT tier churn, much of it triggered outside these files.

Changes:
- **Typed-segment queries.** `gates.hitTestSeg(seg, out)` (`js/gates.js:780`) and `pickups.hitTestSeg(seg, out)` (`js/pickups.js:494`) read x0 / z0 / x1 / z1 from a shared `Float64Array(4)`. The semantics and the `out` shape are the same as before. Both return early when there is no gate or crate on the road. `hitTestSegment` stays as a wrapper (`:771` / `:485`). The profiles show weapons already calls `hitTestSeg` (WPN-8).
- **`gates.render` (`:1462`) rewritten with no double phis.**
  - Conditions became 0 / 1 integers that scale the double terms. Clamps use `Math.min` / `Math.max`.
  - The glyph pen is kept in a `Float64Array` slot (`PEN`). The step cost goes through `_stepNeedTo(g)` (`:643`, result in `NEED`). `_currentRGB` (`:689`) is branch-free on doubles.
  - The MAX-badge width is summed directly instead of in a loop accumulator.
  - Behaviour is identical: the same formulas, re-derived term by term.
- **`applyHit`.** `const w = Math.min(weight, intake)` (`:988`) replaces the if-reassigned `let`.
- **`markUpdate`.** Both files now use `attr.version++` (`:191` / `:103`). This is exactly what three's `needsUpdate = true` setter does, without the setter lookup through the prototype chain.
- **`pickups.render` (`:644`).** The crate lid and scale are written to a `CR` scratch array inside the branches. `ease.outBack` and `ease.inOutCubic` are inlined branch-free, so no double arguments are passed to util and the `ease` import was dropped. The coin bob and extrapolation are scaled by an integer `idle` flag.
- **`pickups.step`.** A `z ≥ −r` prefilter (the same near bound `squad.intersectsCircle` uses) skips the call and its three boxed double arguments while crates and coins are far away (`:591`, `:617`).
- **JIT feedback priming at init** (`gates._primeRender` `:395`, `pickups._primeRender` `:243`).
  - Throwaway decorative gates, crates and coins take every render / hitTestSeg / step branch with fractional values about 8–12 times. Then `reset()` frees them.
  - Decorative events emit nothing and own no decal; the meshes are hidden again.
  - Side effect: a few `ctx.rngFx` draws at init (cosmetic RNG only).
  - Why: without priming, V8 optimizes `render` while the per-gate branches have never run. The first gate, hit, flip or MAX then deoptimizes it into the baseline tier for seconds, and the baseline tier boxes every double.

Verification:
- **Micro (`microalloc.mjs`, `micro-D/micro.json`).** Direct calls with five live gates, two crates and eight coins:

  | call | bytes per call |
  |---|---|
  | `gates.render` | 0.1–0.6 |
  | `pickups.render` | 0.1 |
  | `gates.hitTestSeg` / `pickups.hitTestSeg` | 0 |

  This holds under default tiering and with `--no-turbofan` (Maglev only). Before the change, the Maglev-only `pickups.hitTestSeg` cost was 12 B/call.
- **Real play, steady state** (`allocab.mjs E-steady 30 25` → `allocab-E-steady/allocab.json`: L9 High, 600 soldiers, sampled from 30 s for 25 s):

  | file | MB/min | target |
  |---|---|---|
  | gates.js | **0.32** | < 0.5 (met) |
  | pickups.js | 2.34 | < 0.5 (not met) |

  The pickups figure comes from the render, step and hitTestSeg deopt windows listed below. Before the render changes, the same kind of window (`deopt-trace.mjs`, 25–45 s) measured 4.52 MB/min for gates and 3.76 MB/min for pickups.
- **Official probe** (`perfprobe.mjs --level 9 --quality high --seconds 45 --after "g.squad.setCount(600,'debug')" --heapprof --out docs/build/qa2/fix-gates/heap-l9`), compared with the same probe run on this tree before my GAT-9 work (`heap-l9-base`):

  | file | before (MB/min) | after (MB/min) | gates.render (KB / 45 s) |
  |---|---|---|---|
  | gates.js | 4.72 | 2.39 | 2568 → 1118 |
  | pickups.js | 1.81 | 2.62 | |

  The pickups figures vary from run to run between about 1.4 and 2.9 MB/min (`allocab-C`, `-D`, `-F`), depending on how many crates and coins happen to be live during the baseline-tier windows. **The target is not met inside a 45 s window that starts at boot.**
- **Why the remainder (V8 `--log-code` / `--log-deopt`; see `allocab-*/allocab.json` → `tiers`, `deopts`).**
  - `render` and `step` of both modules run in Maglev; TurboFan never takes over within 45 s.
  - Every deopt drops them back to Sparkplug, which boxes every double, for 2–9 s before Maglev recompiles.
  - The remaining deopts are mostly periodic **"dependent prototype chain changed"**. They come every 10–15 s, plus "embedded weak objects cleared", and hit gates and pickups `render` / `step` at the same instant, so the trigger is outside these files. `protowatch.mjs` shows no `Object.create` or `setPrototypeOf` calls during play. The suspect is render.js's boot warm-up, which turns every scene mesh into a prototype through `Object.create(mesh)` proxies; later shape changes on those objects would then fire this deopt kind. See needsOtherGroup.
  - There are also first-use "insufficient type feedback" and "wrong map" deopts. Priming removed most of the ones in `gates.render` (it now deopts only on the external dependency changes), but some feedback on the pickups side is apparently lost again (weak map feedback cleared by GC).
- A tried-and-reverted experiment, a no-op `dispose` listener on each mesh so three's first-draw `_listeners` add would not change the mesh's map, did not change the deopt pattern (`allocab-F`, measured with it) and was removed.

## [GAT-10] Crates turn into a solid white cube while shot: **fixed**

Changes (`js/pickups.js`):
- **Tinted flash.** The flash is `totalEmissiveRadiance += uSeamColor · vFlash · PICKUPS.crate.hitFlashGain` (`:160`, gain 0.35; `uSeamColor` is the HDR seam colour × `seamEmissive`), replacing `+= vec3(vFlash)`.
- **Rate limit.** `_chitTime` (the flash and punch start) is updated at most every `PICKUPS.crate.hitFlashRetrigger` 0.15 s (`:544`). Hits still count toward opening.
- **Data.** `CRATE_HIT_FLASH` now reads `PICKUPS.crate.hitFlash`. All the other crate and coin feel literals were moved to the existing `PICKUPS.crate.*`, `PICKUPS.coin.*` and `PALETTE.crate.*` keys (same values), so no DATA-MISSING literal is left in pickups.js.
- **New keys** in `js/data.js` (PICKUPS.crate, with a comment): `hitFlashGain: 0.35`, `hitFlashRetrigger: 0.15`.

Verification:
- **Smoke.** `node tools/smoke.js --scenario play --level 1 --seconds 25 --shots 1 --out docs/build/qa2/fix-gates/crate` came back CLEAN, but the bot never shot the crate in that run (it steered to the other lane).
- **Deterministic probe.** `crate-fire.mjs` spawns a crate in front of 40 soldiers and holds it closed by clamping its hit count at 3 (a test hook), then samples the crate's screen box. With `crate-fire-high/report.json` + `crop4x-*.png`, mean luma is **159–199**, the hue is amber and seams stay visible (it was #F0EAE6, luma 235, in visual-2).
- **A/B with request interception.** Flash gain 0 measures 157–178 and gain 0.35 measures 177–181, so the flash now adds only about 3 luma. What brightness remains under fire comes from the hit-brightened seams, bloom and tracers crossing the box. One noisy rerun read 205–210 with tracers covering 12–16 % of the box.

---

## needsOtherGroup

1. **visual (js/render.js), for GAT-9: suspected source of the periodic V8 deopts.**
   - `_compileChunked` (boot warm-up and tier changes) compiles every scene object through `Object.create(o)` proxies (render.js ≈ :1553), which turns every mesh into a prototype object. From then on, any shape change on those meshes or their chain can invalidate dependent optimized code all at once.
   - The V8 deopt log shows "dependent prototype chain changed" every 10–15 s, hitting gates and pickups `render` / `step` at the same instant. That drops them into the boxing baseline tier for 2–9 s each time (`docs/build/qa2/fix-gates/allocab-*/allocab.json`, `deopts` + `tiers`). `protowatch.mjs` shows no `Object.create` / `setPrototypeOf` calls during play, so the boot-time proxies are the remaining suspect.
   - Please compile through a non-prototype-linked stand-in, for example a reusable proxy `InstancedMesh` or `Mesh` whose `geometry`, `material`, `count`, `instanceColor`, `castShadow` and `receiveShadow` are copied from the item. Then re-run `node docs/build/qa2/fix-gates/allocab.mjs <tag> 5 40` and check that `deopts` has no dependency-change entries.
2. **lead / perf, for GAT-9 acceptance.**
   - With the code now allocation-free when optimized (micro 0 B/call), the 45 s probe that starts at boot is dominated by JIT warm-up and deopt windows.
   - Please measure the gates/pickups budget with a warm-up as well, for example `allocab.mjs <tag> 30 25` (gates.js 0.32 MB/min) or perfprobe sampling after the title idle. Treat the remaining pickups figure as dependent on item 1.
3. **fx (js/fx.js:57 `HDR_WHITE = PALETTE.glyph.emissive`), from GAT-7.** The emissive is now 0.82 (was 1.2), so white floaters and damage numbers are dimmer and no longer bloom. FX-10 / FX-12 should re-check readability; fx may want to decouple with its own gain.
4. **visual (js/materials.js:89-91, MAX pill), from GAT-7.** The pill half-size derives from `GATE_RULES.glyph.icon`, which is now 0.95 m, so the pill and the MAX letters grew together. They look fine (`docs/build/qa2/fix-gates/max-badge/01-max-near.png`). If design wants the old 0.7 m badge, add `GATE_RULES.glyph.badge: 0.7` and use it in materials.js. gates.js then needs a one-line switch: render's badge `bh` uses `GATE_RULES.glyph.icon` (`js/gates.js`, the MAX-letters block). I can make that change.
5. **visual (VIS-12), GAT-7 acceptance.** On the + and × panels, contrast is 2.2–2.7:1 on High and Medium with the glyph at 0.82. The panel luminance cap and plate are what remain. Re-run `node docs/build/qa2/fix-gates/glyph-contrast.mjs high|med|low` after VIS-12.
6. **ARCHITECTURE.md (lead / doc owner).**
   - §6.9 / §6.10: new public queries `gates.hitTestSeg(seg: Float64Array(4), out)` and `pickups.hitTestSeg(seg, out)`, with the same semantics and `out` as `hitTestSegment`, which stays.
   - §5.1 / §6.9: when an event reaches z ≥ 0 after `squad:dead` (C = 0 or level phase 'lost'), gates emits `gate:miss` for **every** lane and no `gate:pass` / gate coins.
   - §6.10: pickups ignores contact, hits and `grantItem` after squad death.
   - §6.10: crates own a shadow `customDepthMaterial`.
7. **level (LVL-20).** After `squad:dead`, a `coin:pickup { source:'bonus', amount:1 }` still arrives at game-over ("Coins kept +1" in t5). It is not from gates or pickups; please confirm it is intended.
8. **CALLSITES.md.** Not regenerated here (C: is full, see 9). Run `node tools/callsites.js` once the parallel edits settle.
9. **Environment (lead).** C: had 18–75 MB free during this session. Several runs failed with ENOSPC and other agents' runs will too. I pruned my own screenshots; the space is being used elsewhere.
