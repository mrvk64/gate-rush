# Round-2 fixer report: group "weapons"

Files edited:
- `js/weapons.js`
- `js/data.js`, two keys only: `FIRE.bossAimYieldM` (new) and `WEAPONS.rocket.smoke.colorIdx` (new)
- `docs/GDD.md`: §15 Tracers row
- `docs/ARCHITECTURE.md`: §6.8 damage weight comment, §6.11, §7, §8.4

Checks:
- `node --check js/weapons.js js/data.js`: OK.
- `node tools/check-imports.js`: 0 errors, 0 warnings.
- `node tools/smoke.js --scenario all --out docs/build/qa2/fix-weapons/all`: **CLEAN** on the final code, with no warnings and the level completed.
- No `console.log` or `Math.random` calls in weapons.js.
- The public API is unchanged. Every new method is private (`_detectQueries`, `_computeAim` (extended), `_cfgValid`, `_baseRifleConfig`, `_stepDiagnostics`, `_bossLine`). `_gatesAlongLine` now takes its inputs through scratch arrays.

Evidence harnesses are in `docs/build/qa2/fix-weapons/`:
- `wsmoke.mjs`: a copy of tools/smoke.js. Each timeline sample adds `x = window.__wx()`, and the report gets `report.wrec`.
- `rec.js`: a 250 ms recorder of boss HP, C, bullets, shots/s, aim/yield and brute positions/HP.
- `perfprobe-w.mjs`: perfprobe with `--heapFrom S`, which starts heap sampling late.
- `heapsum.cjs`: per-site weapons.js totals and MB/min over the sampled window.
- `wsmoke-nat.mjs` with `rec-opt2.js`: V8 tier tracking through `%GetOptimizationStatus`.

---

## [WPN-7] Boss re-aim ignores contact zombies; harden firing: **fixed**

Changes:
- **Yield the re-aim to contact threats.** `js/weapons.js:999` `_computeAim`:
  - Once per step during a boss fight it calls `zombies.nearest(squad.x, −3, OUT_N)`. OUT_N is module scratch at :171.
  - When the nearest living zombie has −`FIRE.bossAimYieldM` ≤ z ≤ +0.5 and |x − squad.x| ≤ `world.squadHalfWidth` + 1, `_aimOn` is false for that step and `_aimYield` is true.
  - Bullets, rockets (`_launchRocket`) and laser beams (`_stepLaser`) then fly straight into the threat. The rail is always straight. The drone and sniper keep their own targeting because they are not in weapons.
  - Constants are at :67-71.
  - **Deviation from the spec text (deliberate):** the query point is the middle of the 6 m window (z = −3) instead of z = 0, and zombies more than 0.5 m behind the front row are excluded. A zombie behind the front row cannot be hit by forward fire. With the spec's (x, 0) query, such a zombie could also mask a real threat in front and keep the yield on for nothing.
- **Data.** `js/data.js` `FIRE.bossAimYieldM: 6` is a new key (data.js:159 at the time of writing), with a comment.
- **Hardening, invalid fire config.**
  - `_cfgValid()` (:1063) checks that `_cfgPer`, `_cfgScale` and `_cfgWeight` are finite and > 0.
  - `_baseRifleConfig(C)` (:1073) supplies the fallback: FIRE.rateBase, no multipliers, spawn-cap fold, rifle kind. It calls `warnOnce('weapons.fireConfig', …)` once, with the bad values in the message.
  - `_fireRifles` (:1095) uses the fallback when `_aimBad` is set or the config is invalid.
- **Hardening, non-finite aim point.** `_computeAim` sets `_aimBad` when `boss.aimPoint()` returns a non-finite x, y or z. The re-aim is then off and the base config is used for that step.
- **Diagnostics.** `_stepDiagnostics(dt, C)` (:928):
  - Writes `ctx.debug.shotsPerSec` (trigger pulls per s over 1 s windows, an integer) and `ctx.debug.laserBeams`.
  - Under `?debug=1`, calls `warnOnce('weapons.noShots', …)` when C > 0, the state is `playing`, and nothing was fired (no shot and no laser beam) for ≥ 1 s while ≥ 2 shots were due. The second condition stops a single slow shooter from tripping it.
  - Each warning string is built once, guarded by a flag.
  - The on-screen overlay line is in engine.js; see needsOtherGroup.

Verification:
1. **Rifle run.** `soak-l4`: L4 `--boss`, C = 93, two 400 HP brutes at 9 s, through wsmoke with rec.js. Result: CLEAN with **no warnings**.
   - The brutes reached contact at 9.47 s; both were dead by 14.3 s, **4.8 s after contact**. Before the fix, round-1 p4 took 4.7 s to deal only 220 HP to one brute.
   - Boss HP kept falling afterwards: 2870 at 14.7 s, 1651 at 53 s, phase 1 → 2.
   - Every 2 s sample with the boss alive shows live bullets or HP progress. The squad fired 80 → 10 shots/s as C fell.
   - Yield was active for 43 % of boss-fight samples, always with walkers inside 6 m (phase-1 bursts every 4 s). The 93-strong squad still dies to the phase-1 minion bursts in this synthetic setup (C 85 → 0 in about 40 s). That is a balance issue, not a fire stall: shots/s stays at C·f.
   - Before the final refinement of the query point, an identical run gave 4.8 s and the same picture.
2. **Heavy weapons.** `soak-l4-rocket` and `soak-l4-laser`: the same scenario with `startWeapon` at 9 s. Both were CLEAN with no warnings.
   - **Rocket:** the injected brutes were dead within about 1 s of contact. The boss went from 3031 at 8.9 s to dead at about 31 s; the level completed.
   - **Laser:** the brutes were dead less than 3 s after contact (9.6 s → none at 12.6 s). Boss HP fell through the laser window with `bullets 0`, because beam damage needs no bullets: 2604 → 1240. The boss died at about 28 s; the level completed.
   - Phase-3 boss-spawned brutes in contact were also focus-killed, with `yld` true while they were in contact.
   - An earlier run of both, before other groups' concurrent balance changes, also showed the phase-3 brutes taking full fire: 387 → 0 at C·d DPS.
3. **Hardening.** `hardening`: L1, with `_cfgScale` forced to NaN from 3 s and `_fireRifles` disabled from 9 s.
   - Exactly one `weapons: invalid fire config (per 2, scale NaN …) - firing the base rifle config` warning.
   - shots/s stayed at 10 (C = 5 × 2/s) through the NaN window.
   - Exactly one `weapons: no shot for 1.00 s with C = 25 …` warning after the stall.
   - In every normal run (`all`, `l1`, the soak runs, `impacts15`, `rocket-l9`) neither warning appears.

## [WPN-8] Weapons allocations (round-1 WPN-5 incomplete): **partial**

The steady-state target is met. A full-window perfprobe still lands about 2.5–3 MB/min, from V8 tier-up and first-event deopts; details below.

Changes, all in js/weapons.js:
- **Typed segment queries.**
  - `_sweep` (:1237) calls `zombies.hitTestSeg(SEG, radius, OUT_Z)`, `boss.hitTestSeg(SEG, radius, OUT_B)`, `gates.hitTestSeg(SEG, OUT_G)` and `pickups.hitTestSeg(SEG, OUT_C)` on the module `Float64Array(4)` SEG (:181).
  - `_detectQueries()` (:981) checks per step whether each target has `hitTestSeg`. A target without it falls back to `hitTestSegment`, boxing SEG once per sweep into the tagged SEGT (`boxSeg`, :199).
  - All four `hitTestSeg` implementations have now landed (ENE-16, GAT-9), so the fallback is dormant.
- **Line queries.** The rail, laser and rocket-blast boss tests use `_bossLine(boss, radius, out)` (:1273) on SEGL (:182). `_gatesAlongLine()` (:1549) reads SEGL plus the weight GW[0] and walks with SEGW through `gates.hitTestSeg`. It previously took 5 doubles per beam per step.
- **Radii and module state.**
  - Query radii are module constants (`BULLET_R`, `ROCKET_RADIUS`, `ROCKET_SPLASH`, `RAIL_HW`, `LASER_HW`; :63-66), passed as the same tagged value every call. `_stepBullets` used to pass `FIRE.bullet.radius`, boxing it per bullet.
  - `render()` hands alpha and tNow to `_renderTracers`, `_renderMuzzles` and `_renderRockets` through `RT` (:191) instead of double arguments.
  - The flicker LCG state moved from a module `let` (a HeapNumber per call) to `FLICK` (:336).
- **Deopt cascades removed** (found with `%GetOptimizationStatus` tracking):
  - Weapons fields that later hold doubles started as Smi 0. The first fractional store, at the first weapon or gear pickup, generalised the field, deprecated the map and dropped `_renderTracers`, `_stepBullets` and `_renderMuzzles` back to the interpreter for 1–3 s at 240 bullets.
  - Those fields now start at `D0 = -0` (:160), which is Double from the start.
  - `_renderTracers` picks colour and scale per kind from `TR_COL` and `TR_SCALE` (:195), so there are no kind branches; a pickup no longer deoptimises it (verified in `opt-l9c`).
  - The cosmetic y clamps in `_stepBullets` (:1209) and `_renderTracers` are branch-free and run their compares for every bullet.
  - `_renderRail` and `_stepRailVisual` early-out on a boolean `_railOn` instead of loading the double `_railT` in baseline code every frame.
- **Docs.** ARCH §7 now documents `hitTestSeg`: the table rows and a new "Typed-segment queries" paragraph (ARCHITECTURE.md:758).

Verification: perfprobe `--heapprof`, L9 High, C = 600, 45 s, the same arguments as the carry-over evidence. weapons.js site totals:

| Run | Window | weapons.js total | MB/min |
|---|---|---|---|
| before (carryover `heap-l9-perf.json`) | 46 s, from level start | 13 456 KB (`_sweep` 9 090, `_stepBullets` 2 752, `_renderTracers` 1 142) | **17.1** |
| `heap-l9` (final) | 45.9 s, from level start | 1 919 KB (`_renderTracers` 653, `_stepBullets` 381, writeDirMatrix 260, rocket 412, `_sweep` 100) | **2.45** |
| `heap-l9-r2` (final, repeat) | 48.7 s, from level start | 2 484 KB (`_stepBullets` 1 286 …) | 2.99 |
| `heap-l9-steady` (final, `perfprobe-w --heapFrom 12`) | 42.7 s after JIT warm-up, rocket active in the window | 1 394 KB | **1.91** |
| steady, intermediate build (no weapon pickup in the window) | 44.5 s | 461 KB | 0.61 |

- **The structural allocation is gone.** The `_sweep` per-bullet boxing fell from 9.1 MB to 0.1–0.2 MB, and the radius boxing in `_stepBullets` is gone.
- **What remains is not source-level per-frame allocation.**
  1. **JIT warm-up.** C = 600 is set on the first frame, so about 240 bullets run in Ignition, Sparkplug and Maglev for the first 3–5 s. Those tiers box every double.
  2. **First-event soft deopts.** The first crate hit, first boss aim, first drone bullet and so on drop `_stepBullets` to Maglev, which boxes more, for several seconds. That causes the run-to-run variance in `_stepBullets`.
  3. **Rocket cold path.** `_stepRockets`, `_renderRockets` and writeDirMatrix stay in baseline for most of an 8 s rocket window (about 0.5–1 MB/min while it is active).
  4. **Boxing inside the target APIs.** `zombies.damage(id, amount, x, y, z)`, `gates.applyHit(…, x, y, z)`, `boss.damage` and `fx.emit` take doubles, which is about 0.3–0.6 MB/min at 150+ hits/s.
- Items 1 and 2 are one-time costs. In real play C ramps up gradually, so warm-up runs with few bullets. Item 4 needs other groups (see needsOtherGroup). The full-window number is therefore 2.45–3.0 MB/min against the 2 MB/min target, hence **partial**.
- **Gate counting is unchanged.**
  - A/B on the same codebase: `l1-ab-typed` against `l1-ab-fallback` (fallback forced through `_detectQueries`). Passed gates were identical: +20 (other +2), x3 (+10), +24 (+15), x3 (+29), so **0 hits** of difference.
  - `l1`: CLEAN; the bot's decision values match the triage run exactly ("+5|+2", "x2|+10", "--15|+6", "x2|+25").
  - C differs from the triage run (69 against 92 at gate 3) because of other groups' concurrent balance changes since triage. The A/B isolates the weapons change.
- `all`: CLEAN.

## [WPN-9] Boss-aimed tracers climb toward the chest: **fixed**

Changes:
- `_shoot` (:1120-1131): under `_aimOn`, each bullet gets `vy = (BOSS_TRACER_Y − muzzleY)·speed / max(1, l − BOSSES.radius)`. The tracer therefore reaches `BOSS_TRACER_Y` where it enters the capsule.
- `BOSS_TRACER_Y` (:74) is the midpoint of ENE-13's `BOSSES.hitYRange` × coreY, which is 0.7·4.5 = 3.15 m, clamped to coreY. It falls back to 0.7 while hitYRange is missing. `BOSSES.hitYRange` has since landed in data.js, owned by enemies.
- `_spawn` (:1168) stores `SP[SP_VY]` into the existing `_bvy` channel; drone descent is unchanged.
- `_stepBullets` and `_renderTracers` clamp y to [FIRE.bullet.y, coreY], and `vy` stops at either bound.
- This is cosmetic only: hit tests and damage are untouched (XZ).

Verification:
- `impacts15`: ENE-13's run, `--level 15 --boss --seconds 30 --shots 1`, C = 400. CLEAN, and the boss died at about 23 s with a timeline equivalent to before.
- `impacts15-y`: a numeric probe of the heights of live aimed bullets against distance from the boss centre.
  - 1–3 m from the centre (the capsule surface is at 1.6 m): **mean y 2.67–2.77 m, max 3.2 m**, inside ENE-13's band of 2.0–4.3 m.
  - 9–12 m out: 1.3–1.4 m.
  - The screenshots (`impacts15/16-play-16s.png`, `impacts15-y/03-play-9s.png`) show the stream rising into the Colossus's torso and shield.
- Damage and TTK are unchanged by construction: the bullet's XZ path and its hit tests are identical.

## [WPN-10] Doc amendments and the smoke colour index: **fixed**

Changes:
- **GDD §15 Tracers row** (GDD.md:530): it now carries the data.js values.
  - rifle (2.6, 1.7, 0.6), minigun (3.4, 2.6, 0.35) at 0.6× cross-section, laser (0.5, 2.6, 3.2) cyan, drone, chip tint.
  - Tagged round-1 QA WPN-1/WPN-2, plus the WPN-9 boss-aim climb.
- **ARCH §6.8** (ARCHITECTURE.md:514): the boss.damage weight comment now gives rocket `gateHits·w`, rail `gateHits·w` and laser `gateHitsPerSec·w·dt`, tagged WPN-4.
- **ARCH §6.11** (:579):
  - Muzzle flash 33 ms (WPN-6).
  - Rocket, rail and laser gate and shield weights ×w (WPN-4).
  - The boss re-aim yield, hardening and diagnostics (WPN-7), the tracer climb (WPN-9), `hitTestSeg` (WPN-8), and `ctx.world.squadHalfWidth` added to Reads.
- **ARCH §7**: `hitTestSeg` rows and paragraph (WPN-8), and the rocket, rail and laser rows now read 8·w / 10·w / 10·w·dt (WPN-4).
- **ARCH §8.4** (:840-856): the minigun tracer is [3.4, 2.6, 0.35] with tracerScale 0.6, and the laser tracer is [0.5, 2.6, 3.2]. An amendment comment covers WPN-1/2/4 weighted hits and the rocket smoke colorIdx (WPN-10).
- **Colour index.** `js/data.js` `WEAPONS.rocket.smoke.colorIdx: 8` is new, with a comment giving FX_COLOR.dust (data.js:573 at the time of writing). weapons.js:101 reads it, so it is no longer hand-mirrored.

Verification:
- Grepping docs for `(4.0, 1.0, 3.6)` / `[4.0, 1.0, 3.6]` returns nothing.
- Grepping docs for `magenta` returns only GDD.md:27, "÷ gate colour | Crimson-magenta #E0346E". That is the divide-gate colour, not a tracer, and is not weapons-owned.
- `rocket-l9`: L9 High with the rocket at 3 s. CLEAN, and the light-tan smoke trail is visible (`rocket-l9/03-play-5s.png`). The colour index is the same value (8), so the smoke is unchanged.

---

## needsOtherGroup

1. **core (js/engine.js `_writeDebugText`, about line 1411). Required for the WPN-7 "on the overlay" part.** Append shots/s to the overlay's squad line. weapons.js already writes `ctx.debug.shotsPerSec` (an integer, refreshed each second) and `ctx.debug.laserBeams`. For example, after `' | bullets ' + …` add:
   `+ ' | shots/s ' + (typeof ctx.debug.shotsPerSec === 'number' ? ctx.debug.shotsPerSec : '-') + (ctx.debug.laserBeams > 0 ? ' | beams ' + ctx.debug.laserBeams : '')`
   This string is built at 4 Hz only, so it adds no per-frame allocation.
2. **Design-doc owner (ARCHITECTURE §8.1 FIRE listing). Optional.** The new key `FIRE.bossAimYieldM: 6` (round-2 QA WPN-7) is documented in §6.11 but not in the §8.1 FIRE block, which is not a weapons-owned section.
3. **enemies (js/zombies.js, js/boss.js) and gates (js/gates.js). Optional, for the last part of WPN-8.** `zombies.damage(id, amount, x, y, z, cause)`, `gates.applyHit(id, w, x, y, z)` and `boss.damage(amount, weight, x, y, z)` box 4 doubles per bullet hit, about 0.3–0.6 MB/min at 150+ hits/s.
   - A typed variant such as `zombies.damageHit(id, amount, out, cause)`, reading x, y and z from the `out` the query just filled (OUT_Z / OUT_G / OUT_B), would remove three of the four.
   - weapons would adopt it with a `typeof` fallback, as for `hitTestSeg`.
   - This is not required for correctness.
4. **level / enemies (balance observation, no change requested from weapons).** In the synthetic `soak-l4` scenario, phase-1 minion bursts wear a 93-strong squad down to 0 in about 40 s while it fires at full rate (80 → 10 shots/s, yield or aim working as designed). This is outside weapons; it is flagged only because the round-1 "squad of 93 lost at the L4 Hulk" report could be read as a fire stall. No stall reproduces, and `weapons.noShots` never fired.
