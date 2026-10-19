# Round 5d: endless — numbers not HP, the mini-boss hold, pool-safe waves

Owner: level / balance (`js/level.js`, `js/levelgen.js`, `tools/validate-levels.js`; data keys `LEVELS.endless.*`, `LEAK_MODEL.*`).
Date: 2026-10-15. Evidence: `E:/Temp/claude/gate-rush-evidence/r5d/pool/` (written `$EV` below: the pool-safe change, this report's measurements), `E:/Temp/claude/gate-rush-evidence/r5d/level/` (the fixer's batches T1–T3b, `$LV`), `E:/Temp/claude/gate-rush-evidence/r5c/lead/r3/` (the lead's root-cause probe). The files as handed over (the fixer's A–D + the lead's T3 data) are `$EV/orig/{level.js, levelgen.js, data.js, validate-levels.js}`; the shipped 1.2.0 build is `dist/js/`. Installed md5 after this round: level.js 542e579f, levelgen.js d7474173, data.js 98160562, validate-levels.js d0cf0097.

## Verdict

| # | Task | Result | Status |
|---|---|---|---|
| 1 | Endless waves pool-safe by construction (generator rule + live clamp); the hold releases; the boss's bursts respect the pools | Generator: a wave ≤ a quarter of every pool with a type's excess moved into the other types' headroom; the population a chunk owes spreads over more, smaller waves (≤ 6 per chunk, contacts ≥ 30 m apart) instead of being dropped; every chunk is then fitted so the validator's live count (spawn → contact, waves + guards) stays within pool − reserve for every type at every moment. Runtime: `level._clampEndlessUnits` clamps each wave / guard spawn to pool − alive − reserve (`ctx.debug.dropped['level.waveClamp']`). Hold: verified in the real-time runs (§7) — every event waits, the boss dies, the road resumes 60 m after the kill. Bursts: `boss._spawnMinions` → `zombies.spawnWave` → `zombies.spawn`, which drops at the pool edge; no drop in either smoke run, 1 brute + 1 spitter refusal over 96 fast runs (was 27) | done |
| 2 | `node tools/validate-levels.js` → 0 errors; campaign lines unchanged | 30 levels · 7 warnings · **0 errors** at the new default of 30 endless chunks (and at `--chunks 40`); the campaign section is byte-identical to `$LV/validate-after2.txt` with timings stripped (`$EV/campaign-{lead-after2,final}.txt`, `diff` empty) | met |
| 3 | Re-measure on a new seed set, T3 targets | 12 new seeds (12007 + 47·i), the same seeds through the T3 code and the pool-safe code: every paired median unchanged — smart r3 **9** (target 9–14), strong r3 **9** (≥ 8), passive r0 **4** (3–5), nobody past 25 at any rank (max 23 at r10), 93 / 96 deaths horde deaths, first mini-boss killed 12/12 in every steering config, 128 / 130 mini-bosses killed, TTK medians 8–15 s, no fight over 40 s | met |
| 4 | Smoke `--endless --seconds 330` at rank 3 and rank 0 | §7: the first mini-boss fight ends with the boss dead, HP falling at every in-range sample, no gate / wave / crate during the fight, no zombie-pool drop (`ctx.debug.dropped`) | met |
| 5 | Docs | GDD §6.3 (the HP cap), §10.1 (T3 numbers, the cap, the hold, the pool rule, measured); ARCHITECTURE §6.16 (hold, cap, clamp), §6.17 (new exports, `endlessParams` fields, the pool fit), §8.6 (keys), §13 (validator scope) | done |

## 1. Diagnosis

**Root cause (the lead, r5c probe `$EV/../r5c/lead/r3/report.json` 147–188 s, `r3-151.png`, `r3-181.png`).** Endless wave zombies carried the chunk pressure as per-zombie HP (the design multiple ×9 × 1.07^(D−4) on the calibrated solve): a brute at the formation front soaked the whole squad's fire for 10–100 s while swinging 3 soldiers a second — a wall — and the mini-boss fight stacked on it while the next chunk's ÷3 gate and 25–48-zombie waves arrived mid-fight. The fixer's answer (A–C below) moved the pressure into numbers (`hpCapSeconds`, `pop`), held the road's events during the fight (`miniBossHold`) and taught the validator the new columns; the lead tuned the numbers (T1–T3b, §3) and chose T3.

**What T3 left open: the pools.** With T3's population (pop = min(32, 8 + 4·D) × 1.07^(D−4): 67 at chunk 15, 94 at 20, 132 at 25) every wave saturates its pool shares (30 w / 15 r / 10 c / 4 b / 6 s = 65) from chunk 15 and `node tools/validate-levels.js` reported *"endless D20: wave @5759: 126 walkers alive at once exceed the pool (120)"*. The static model (`$EV/pools-before-4242.txt`, the validator's pool rule: a zombie lives from its spawn distance to its contact, the live count peaks at spawn moments) shows the shape of it:

| chunk | waves | contacts (m into the chunk) | peak alive w/r/c/b/s (pools 120/60/40/16/24) |
|---|---|---|---|
| 15 (mini-boss) | 3 | 125, 125, 125 | 90/45/26/12/18 |
| 16 (after the boss) | 4 | 204, 248, 259, 287 | 90/45/27/12/18 |
| 19 | 4 | 143, 169, 248, 274 | 66/30/20/8/12 |
| 20 (mini-boss) | 4 | 125, 125, 125, 125 | **126**/60/40/16/24 |
| 21 (after the boss) | 5 | 201, 248, 248, 267, 289 | 120/60/40/16/24 |
| 25 (mini-boss) | 4 | 125 ×4 | **126**/60/40/16/24 |
| 26 (after the boss) | 5 | 201, 248, 248, 267, 289 | **126**/60/40/16/24 |

On a mini-boss chunk the waves must make contact in a 40-m window (`miniBossLeadM` 100 before the boss, the last gate's arrival before that) and the one-wave-per-gate nudge (`contact = arrival + waveAfterGateM` for a wave within 20 m of a gate arrival) snaps all of them onto the same metre: four 65-zombie waves and the gate's 6 guards alive at once. The chunk after a boss holds its waves `miniBossTailM` (100 m) and packs 5 waves into 90 m, three or four of them overlapping. Normal chunks never came close (peak 90 walkers at 5 waves). So the overflow is structural, not a seed: every mini-boss chunk from D20 and every after-boss chunk from D26 overflowed, and the chunk's waves were already "silently dropping" the population T3 asked for (94 per wave at D20, 65 delivered).

**Why "by construction" is possible.** In the validator's model a chunk's events never overlap the previous chunk's: a wave's contact lies ≥ 90 m into its chunk (`spanLo` 70 + `waveAfterGateM` 20 + half a spacing), every spawn → contact window is shorter than 70 m (walkers at 12 m/s: 64.6 m), so a wave spawns ≥ 23 m into its chunk, while the previous chunk's last wave contact is at most its end (the nudge bound `spanHi + 20`) and its last guards die by `end − 36`. A per-chunk fit of the waves against the pools therefore makes the whole run pool-safe, and the mini-boss hold (which shifts every later event uniformly) keeps the spacing. The validator proves it per seed by validating the concatenated run (now D1–30 by default).

## 2. Mechanisms and keys (`LEVELS.endless.*`)

| Key | Value | Meaning | Code |
|---|---|---|---|
| `pop` | `{ base 8, per 4, cap 32 }` | population per wave before the pressure: min(32, 8 + 4·D) (round 3: min(16, 10 + 2·D)) | `levelgen.endlessParams` |
| `pressure` | `{ fromD 4, perD 0.07, hpShare 1, popShare 1, gainShare 1 }` | p = 1.07^max(0, D − 4); × population (`pop × p^popShare`, baked into the chunk's units), × wave HP (moot above the cap), ÷ gate gain cap, × score | `endlessParams`, `level._liveHpMult`, `endlessGateGuard` |
| `waves` | `{ base 2, per4 1, cap 3, extraFromD 12, extraEveryD 8, extraCap 2, maxPerChunk 6, minSpacingM 30 }` | min(3, 2 + ⌊D/4⌋) + one more per 8 chunks from D12 (≤ 2 more) = the count the chunk owes its population at (`wavesBase`); round 5d: once pop exceeds a wave's pool shares (65) the owed population pop × wavesBase spreads over ⌈owed / 65⌉ waves, ≤ maxPerChunk, contacts ≥ minSpacingM apart in the chunk's wave window (`endlessWaveWindow`); absent keys = the old counts, excess dropped | `endlessParams` (`waves`, `need`, `popWave`), `generateChunk` |
| `hpCapSeconds` | `{ walker 0.5, runner 0.4, crawler 0.35, brute 3.0, spitter 1.2 }` | (A) per-zombie HP ceiling = seconds × the on-curve design DPS E(D)·`FIRE.rateBase`·`FIRE.dmgBase`·`FIRE.accuracy`·p^`profileExp` (p = the shop's fire rate × damage), never below `LEAK_MODEL.minHp`; applied after every live multiplier to waves and gate guards | `levelgen.endlessHpCap`, `level._capEndlessHp` |
| `profileExp` | 0 | the shop's p exponent on endless wave HP and on the cap | `_liveHpMult`, `endlessHpCap` |
| `miniBossHold` | `{ releaseM 60 }` | (B) from `boss:spawn` to `boss:dead` the script cursor waits at the first `gates` / `wave` / `crate` / `coins` event (`HOLD_TYPES`); at the kill every event from the cursor on slides by `distance + releaseM − evs[cursor].at` (nothing when ≤ 0), `_holdShiftM` accumulates it, later chunks are generated at `chunkEnd + _holdShiftM`, `_guardEndlessGate` reads an event's chunk from `at − _holdShiftM` | `level._fireBoss`, `_releaseHold`, `_appendChunk`, `_onBossDead` |
| `miniBossLeadM` / `miniBossTailM` / `miniBossWaveCut` | 100 / 100 / 1 | (r5c) the boss chunk's waves make contact ≥ 100 m before the boss, the chunk after it holds its waves 100 m, the boss chunk gives up one wave | `endlessWaveWindow`, `endlessParams` |
| `miniBossHpShare` / `miniBossKillsShare` | 0 / 1 | (r5c) the mini-boss's HP ignores the pressure, its attack kills keep it | `level._fireBoss` |
| `miniMinions` | `{ hpMult 1, pressureShare 0, profileExp 0.5 }` | (r5c) the mini-boss's minions are soak: the calibrated solve at E(D) × `LEAK_MODEL.minionScale`, no design multiple, no pressure | `level._miniMinionMult`, `generateChunk` |
| `wavePoolShare` | 4 | a wave carries ≤ ⌊pool / 4⌋ of every type (30/15/10/4/6 = 65); round 5d: a type's excess moves into the other types' headroom under the same shares, largest headroom first (it became walkers before, and the walkers' own excess was dropped) | `levelgen.capWaveToPoolShare` |
| `poolReserve` | `{ walker 6, runner 6, crawler 10, brute 2, spitter 2 }` | (round 5d) pool slots every endless wave / guard leaves free: the rotation's minion union (`BOSSES.minionBurst.count` walkers, the Hulk's 6 runners / 2 brutes, the Queen's 10 crawlers), spitters 2 for bodies still toppling (`ZOMBIES.common.death.free` holds a slot 1.4 s). The generator's fit and the live clamp both budget pool − reserve; the validator's hard limit stays the pool | `levelgen.endlessPoolReserve`, `fitEndlessPools`, `level._clampEndlessUnits` |
| `designMult` / `designRampD`, `gateEMaxD` / `gainCapFrac`, `rubber`, `keepMult` / `plusCapFrac`, `crowdMax`, `bandPerD` / `bandMax`, `heavyPerD`, `liveExp` | unchanged (round 3) | the wave design multiple, the gate E freeze and gain cap, the low-side rubber band, the keep rule, the crowd factor (off), the band ramp (off) | `endlessParams`, `endlessGateGuard`, `level._applyRubberBand` |

The validator (C): `tools/validate-levels.js` runs endless D1–30 (was 20; `--chunks N`), each chunk alone and the whole run concatenated, and prints per chunk the wave count (the owed count in brackets when the pool-safe ramp added waves), the population per wave (the owed population in brackets), the horde delivered / owed, the peak pool use per type, the per-zombie HP cap, the largest capped / uncapped zombie and the mini-boss; a `pools over D1–N` line gives the peak use against the pools and the budget, the horde delivered against the population owed and the chunks below it. The JSON report (`--json`) carries the same fields and `poolReserve`.

## 3. The fixer's batches (seed set F: 11003 + 43·i, 12 seeds; `$LV/runs/<cfg>-F.summary.txt`)

All with the HP cap (A), the hold (B) and the r5c mini-boss rules; `subs-*.json` are the data patches. Death chunk = median (min–max); `1st MB` = first mini-boss killed; TTK = mini-boss time-to-kill median.

| config | `pop` | `waves` | `pressure.popShare` | smart r0 / r3 / r6 / r10 | strong r0 / r3 / r6 | passive r0 / r3 / r6 | past 25 | horde deaths | 1st MB (smart r3) | TTK (smart r3) |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 (pre-5d numbers) | 10 / 2 / 16 | cap 3 | 1 | 13 (10–24) / 22.5 (15–27) / 26.5 (18–32) / 38 (23–48) | 17 (6–22) / 20.5 (14–24) / 22.5 (15–27) | 15.5 (3–21) / 19.5 (12–23) / 22 (15–25) | 23 of 132 | 120 of 132 | 12/12 | 8.1 s |
| T2a | 8 / 4 / 64 | cap 4 | 1 | 7.5 (7–10) / 8.5 (8–12) / — / — | — / 9 (7–13) / — | 3.5 (2–7) / — / — | 0 | 43 of 48 | 12/12 | 10.9 s |
| T2b | 6 / 6 / 64 | cap 5 | 1 | 7 (4–9) / 8 (7–12) / — / — | — / 8 (7–12) / — | 3.5 (2–7) / — / — | 0 | 40 of 48 | 12/12 | 11.5 s |
| T2c | 8 / 3 / 64 | cap 5 | 1.25 | 8 (7–12) / 9 (8–13) / — / — | — / 10 (8–13) / — | 7 (3–10) / — / — | 0 | 43 of 48 | 12/12 | 10.5 s |
| **T3 (chosen)** | **8 / 4 / 32** | **cap 3 + extra 12 / 8 / 2** | 1 | **8 (7–13) / 10.5 (8–17) / 14.5 (10–19) / 21 (13–25)** | **7 (4–13) / 12 (7–16) / 13 (8–19)** | **3.5 (2–7) / 9.5 (4–14) / 13 (8–17)** | **0 of 132** | **116 of 132** | 12/12 | 9.8 s |
| T3b | 8 / 4 / 36 | cap 3 + extra 10 / 6 / 3 | 1 | — / 10 (8–15) / 12.5 (10–18) / — | — / 12 (7–14) / — | — | 0 | 34 of 36 | 12/12 | 10.75 s |

T3 per config (the full lines are in `$LV/runs/T3-F.summary.txt`): every death horde / gate except strong r0 (3 mini-boss deaths, first mini-boss killed 9/11) and passive r0 (1); mini-boss TTK medians 6.1–13.1 s (smart), 6.7–10.6 s (strong); losses bites + spit ≥ 90 % for the steering bots. The lead wrote T3 into `js/data.js` and noted the validator's two pool errors (§1), which this round closes.

## 4. The pool-safe change

### 4.1 Generator rule (`js/levelgen.js`)

1. **Composition at the owed population.** `endlessParams(D)` now returns `wavesBase` (the GDD count after the mini-boss cut), `need = pop × wavesBase` (the population the chunk owes), `waves` (= `wavesBase`, or once `need > 65 × wavesBase` the smallest count that fits the owed population at 65 per wave, clamped to `waves.maxPerChunk` (6) and to the chunk's wave window / `minSpacingM` (30 m) — `endlessWaveWindow` is the r5c span logic factored out of `generateChunk` so both agree) and `popWave = ⌈need / waves⌉`. `generateChunk` composes every wave at `popWave`. Chunks 1–16 keep their counts; 17 gets 5 waves (owed 77 × 4 = 308 → 5 × 62), 18–19 and 22–24, 27–29 get 6 (the ceiling: 6 × 65 = 390 of the 540–870 owed; the mini-boss chunk's 40-m window and the chunk after it keep 4 / 5).
2. **Shares with headroom.** `capWaveToPoolShare(units)`: every type ≤ ⌊pool / `wavePoolShare`⌋, a type's excess moved into the type with the most headroom (ties in `TYPES` order), what nothing can take dropped. Chunks 1–13 are byte-identical to T3 for every seed tested (`$EV/chunks-{before,final}.json`, `cmp.mjs`); chunks 14–16 differ by one or two crawlers per wave (the walkers' former drop now fills the crawler headroom: 30/15/8 vs 30/15/7 at D14, 30/15/10 vs 30/15/8 at D15–16).
3. **The pool fit.** After the sizing pass (gates, guards, wave HP) `fitEndlessPools(waves, events, v)` takes the chunk's wave spans [`at`, contact] and guard spans [`at`, guard contact] and, per type, (i) thins the pile at the peak moment evenly — every wave alive there scaled by the same factor (budget − guards) / Σ waves, floored, repeated while a peak exceeds the budget — then (ii) an exact pass in spawn order clamps what rounding left: room = budget − the most alive beside the wave at its own spawn or at any guard spawn during its life (earlier waves and guards; a later wave subtracts this one itself). Budget = pool − `poolReserve`. Guards (≤ 6 walkers) are never trimmed; a wave is never emptied; a trimmed wave's HP is re-solved on the same line (same E, shield and lane). Every peak the validator evaluates is then ≤ budget ≤ pool, so `checkPoolOverlap` passes by construction; `endlessPoolPeaks` exports the same model for the validator table.

The gate-nudged piles are what the fit touches: at D20 the four 65-zombie waves on the one metre become 4 × 55 (27/13/7/3/5 — 108 walkers + 6 guards = 114, the budget), at D21 / D26 the four overlapping waves 55–56 and the fifth, alone at 289 m, keeps 64. Everything else is untouched (static tables: `$EV/pools-final-4242.txt` against `pools-before-4242.txt`).

| chunk | T3: waves · per wave (w/r/c/b/s) · peak alive | pool-safe: waves · per wave · peak alive |
|---|---|---|---|
| 14 | 4 · 30/15/7/4/6 · 66/30/17/8/12 | 4 · 30/15/8/4/6 · 66/30/18/8/12 |
| 15 (mini-boss) | 3 · 30/15/8/4/6 · 90/45/26/12/18 | 3 · 30/15/10/4/6 · 90/45/30/12/18 |
| 17 | 4 · 30/15/9/4/6 · 60/30/19/8/12 | **5** · 30/15/7/4/6 ×3 + 27/15/10/4/6 ×2 · 87/45/24/12/18 |
| 18 | 4 · 30/15/9/4/6 · 66/30/19/8/12 | **6** · 22–25/13–15/6–10/4/6 · 72/44/23/12/18 |
| 20 (mini-boss) | 4 · 30/15/10/4/6 · **126**/60/40/16/24 | 4 · **27/13/7/3/5** · 114/52/28/12/20 |
| 21 (after the boss) | 5 · 30/15/10/4/6 · 120/60/40/16/24 | 5 · 28/13/6–7/3/5 ×4 + 30/15/9/4/6 · 114/54/27/13/21 |
| 22 | 5 · 30/15/10/4/6 · 90/45/30/12/18 | **6** · 30/15/10/4/6 · 90/45/30/12/18 |
| 26 (after the boss) | 5 · 30/15/10/4/6 · **126**/60/40/16/24 | 5 · 27/13/6–7/3/5 ×4 + 30/15/9/4/6 · 114/54/27/13/21 |

Over D1–30 (seed 4242) the chunks deliver 6 699 of the 10 198 zombies T3's numbers owe (66 %): chunks 1–14 everything, 15–19 ≥ 90 %, the mini-boss chunks 20 / 25 / 30 ≈ 220 of 376–744 (the pile is pool-bound), the 6-wave chunks 390 of 540–870. The validator prints it per chunk (§5), so the drop is no longer silent.

### 4.2 Live clamp (`js/level.js`)

`_clampEndlessUnits(units)` runs on every endless wave (after `_crowdEndlessWave`, before the HP solve and the stagger) and on every endless gate guard squad: `units[t] = min(units[t], ZOMBIES[t].pool − zombies.aliveOfType(t) − poolReserve[t])`, trimmed zombies counted in `ctx.debug.dropped['level.waveClamp']`. It is the backstop for the road's live state — stragglers of earlier waves still in contact, a wave the hold slid onto the boss's last minions — not the rule: in 96 fast runs it trimmed 0–36 zombies per 12 runs (§6), and the pool's own refusals (`zombies.<type>`, `zombies.spawn` returning −1) fell from 27 to 2. Per run the trims sit where the live road is fullest: the runs that reach the piled chunks (smart r10 dying at D19 / D20 / D23: 7 / 13 / 12 trimmed; smart r6 at D19: 16) and the slow rank-0 runs around chunks 6–8 (2–5 each: a squad that thins the D6 pile slowly still has its brutes and spitters alive when the next wave spawns); every other run 0–2. In-place on the run's own events (fresh per run, never frozen), allocation-free, event time. `_poolReserve` is read once per runner from `levelgen.endlessPoolReserve()`.

### 4.3 The hold and the boss's bursts

`_releaseHold` is unchanged and verified live (§7): the cursor waits at the first held event, the shift lands the first held event `releaseM` after the kill, later chunks are generated in the shifted frame, `ctx.debug.holdShiftM` shows the accumulated shift. The boss's phase-1 bursts (`BOSSES.minionBurst`: 6 walkers / 4 s) and phase spawns (Hulk 6 runners, 2 brutes; Queen 10 crawlers) go through `zombies.spawnWave` → `zombies.spawn`, which refuses at the pool edge (counted `zombies.<type>`) — with the hold the road is clear of waves during the fight and the reserve keeps the union free, so no burst was refused in either smoke run; the fast runs show the one brute and one spitter refusal left (both outside fights, piled waves at rank 6–10).

### 4.4 Static checks

`node tools/validate-levels.js`: 30 levels · 7 warnings · 0 errors (`$EV/validate-final.txt`; `--chunks 40`: `validate-final-40.txt`, 0 errors). `tools/check-imports.js`: OK. `node --check` on the three modules: OK. No `console.log`, no `Math.random` in the touched files; the new generator code allocates only at chunk generation (event time), the runner's clamp not at all.

## 5. Validator

Campaign section: byte-identical to the lead's `$LV/validate-after2.txt` and to `$EV/validate-before.txt` with timings stripped (`$EV/campaign-lead-after2.txt` vs `campaign-final.txt`, empty diff). Endless table excerpt (seed 4242; waves = count (owed count), pop/wave = per wave (owed per wave), horde = delivered / owed, pool peak w/r/c/b/s):

| D | v | E | waves | pop/wave | horde | pool peak | hp cap w/r/c/b/s | max HP (uncapped) | mini-boss |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 11.10 | 339 | 4 | 63 | 252/252 | 66/30/18/8/12 | 271/217/190/1628/651 | 1628 (81475) | |
| 15 | 11.25 | 359 | 3 | 67 | 195/201 | 90/45/30/12/18 | 288/230/201/1726/690 | 1726 (6327) | spitterQueen 10800 |
| 17 | 11.55 | 404 | 5 (4) | 62 (77) | 310/308 | 87/45/24/12/18 | 323/259/226/1939/776 | 1939 (13772) | |
| 18 | 11.70 | 428 | 6 (4) | 56 (83) | 336/332 | 72/44/23/12/18 | 343/274/240/2055/822 | 2055 (128473) | |
| 20 | 12.00 | 481 | 4 | 94 | 220/376 | 114/52/28/12/20 | 385/308/269/2309/924 | 2309 (161436) | hulk 14450 |
| 21 | 12.00 | 510 | 5 | 101 | 285/505 | 114/54/27/13/21 | 408/326/286/2448/979 | 2448 (32011) | |
| 22 | 12.00 | 541 | 6 (5) | 90 (108) | 390/540 | 90/45/30/12/18 | 432/346/303/2595/1038 | 2595 (26799) | |
| 25 | 12.00 | 600 | 4 | 132 | 220/528 | 114/52/28/12/20 | 480/384/336/2880/1152 | 2880 (282395) | juggernaut 18000 |
| 30 | 12.00 | 600 | 4 | 186 | 224/744 | 112/52/28/12/20 | 480/384/336/2880/1152 | 2880 (36952) | spitterQueen 18000 |

`pools over D1–30: peak alive w/r/c/b/s 114/54/30/13/21 of 120/60/40/16/24 (budget 114/54/30/14/22); horde delivered 6699 of 10198 owed (66 %), 13 chunk(s) below the owed population`. Deeper and on other seeds (`$EV/validate-seeds-60.txt`: `--seed 4242 / 777 / 12007 / 31337 --chunks 60`) the pools peak at the same 114/54/30/13/21 through chunk 60 with no pool error; the errors those runs do print are the campaign's full-intake greedy lines at non-canonical seeds (`--seed S` also reseeds L2–L30 as S + L), identical in the original tree (`$EV/origtree/`, the handed-over validator and generator) — pre-existing and outside this round. A sweep of 3 000 seeds × 60 chunks through the same pool model (`$EV/tools/sweep.mjs`, `sweep-3000x60.txt`; 200 × 40 in `sweep-200x40.txt`): 0 pool violations, 0 non-deterministic chunks, peak alive 114/54/30/13/21 of 120/60/40/16/24, peak total 229 of 260 (21.5 s). The rank-3 and rank-0 endless lines (full-intake greedy, mini-bosses not modelled) still peak at C/E 2.23 / 2.21 (limit 3) and now lose the squad at 7 148 m / 5 648 m, at the deeper end than before (T3: 7 1xx / 5 825 m) — the validator's line meets the same waves; it is not a play measurement.

## 6. Re-measure: seed set G (12007 + 47·i, 12 seeds)

Fast runner `$EV/tools/fast/` (the r5c harness; `harness.js` now records each run's own `ctx.debug.dropped` delta, `sched2.mjs` runs the "before" jobs with `OVERDIR=$EV/orig` — the T3 level.js / levelgen.js over the live data, which the old code reads unchanged — and the "after" jobs on the installed tree). Runs: `$EV/runs/before-G/`, `$EV/runs/after-G2/` (`after-G/` is the same with `poolReserve.spitter` 0; it showed 17 refused spitter spawns at rank 10 from bodies still toppling, hence 2), summaries `*.summary.txt`, the tables `$EV/runs/tables.md`. 12 seeds × 8 configs × 2 = 192 runs, 0 page errors.

Death chunk median (min–max) IQR; past 25 / deaths horde · gate · mini-boss:

| config | T3-F (lead, set F) | before (T3 code, set G) | after (pool-safe, set G) | T3-F | before G | after G |
|---|---|---|---|---|---|---|
| smart r0 | 8 (7–13) 7–12 | 7 (7–12) 7–10 | **7** (7–12) 7–10 | 0 / 12·0·0 | 0 / 11·0·1 | 0 / 11·1·0 |
| smart r3 | 10.5 (8–17) 9–14 | 9 (8–13) 8–13 | **9** (8–17) 8–13 | 0 / 12·0·0 | 0 / 12·0·0 | 0 / 12·0·0 |
| smart r6 | 14.5 (10–19) 12–18 | 12 (9–20) 12–15 | **12** (10–19) 12–15 | 0 / 11·1·0 | 0 / 12·0·0 | 0 / 10·0·2 |
| smart r10 | 21 (13–25) 14–23 | 15 (13–25) 14–20 | **15** (13–23) 14–19 | 0 / 12·0·0 | 0 / 12·0·0 | 0 / 12·0·0 |
| strong r0 | 7 (4–13) 7–11 | 7 (5–11) 7–9 | **7** (7–12) 7–9 | 0 / 9·0·3 | 0 / 10·1·1 | 0 / 12·0·0 |
| strong r3 | 12 (7–16) 8–12 | 9 (7–15) 8–12 | **9** (7–14) 8–12 | 0 / 10·1·1 | 0 / 12·0·0 | 0 / 12·0·0 |
| passive r0 | 3.5 (2–7) 3–7 | 4 (2–10) 3–7 | **4** (2–10) 3–7 | 0 / 7·4·1 | 0 / 6·6·0 | 0 / 7·5·0 |
| passive r3 | 9.5 (4–14) 7–12 | 7 (5–12) 7–12 | **7** (5–12) 7–12 | 0 / 11·1·0 | 0 / 11·1·0 | 0 / 11·1·0 |

Mini-bosses (first killed · all killed · TTK median / p90 / max s) and pool events per 12 runs (`refused` = `zombies.<type>` spawn refusals, `clamped` = zombies `level.waveClamp` trimmed):

| config | T3-F | before G | after G | T3-F pool | before G pool | after G pool |
|---|---|---|---|---|---|---|
| smart r0 | 12/12 · 15/15 · 13.1 / 17.7 / 21.9 | 11/12 · 13/14 · 13.7 / 16.6 / 22.8 | 12/12 · 14/14 · 14.1 / 27.3 / 34.1 | 0 | refused brute 4 | clamped 17 |
| smart r3 | 12/12 · 19/19 · 9.8 / 13.7 / 14.4 | 12/12 · 17/17 · 8.5 / 11.4 / 11.7 | 12/12 · 18/18 · 8.7 / 11.4 / 11.7 | 0 | 0 | clamped 4 |
| smart r6 | 12/12 · 28/28 · 8.2 / 12.5 / 14.7 | 12/12 · 24/24 · 8.6 / 10.8 / 27.1 | 12/12 · 23/25 · 8.0 / 10.3 / 10.8 | 0 | refused spitter 2 | clamped 18, refused spitter 1 |
| smart r10 | 12/12 · 37/37 · 6.1 / 9.3 / 9.9 | 12/12 · 30/30 · 7.8 / 10.1 / 12.4 | 12/12 · 29/29 · 7.7 / 9.8 / 11.6 | 0 | refused spitter 13, brute 2, walker 6 | clamped 36, refused brute 1 |
| strong r0 | 9/11 · 11/14 · 10.6 / 21.5 / 28.9 | 10/10 · 10/11 · 13.4 / 24.6 / 24.6 | 12/12 · 13/13 · 15.2 / 24.3 / 36.2 | 0 | 0 | 0 |
| strong r3 | 12/12 · 19/20 · 7.6 / 12.7 / 13.8 | 12/12 · 17/17 · 9.3 / 11.2 / 13.3 | 12/12 · 17/17 · 9.3 / 11.2 / 13.9 | 0 | 0 | 0 |
| passive r0 | 3/4 · 3/4 · 28.5 / 35.7 / 35.7 | 4/4 · 4/4 · 9.3 / 19.6 / 19.6 | 4/4 · 4/4 · 8.6 / 16.7 / 16.7 | 0 | 0 | 0 |
| passive r3 | 11/11 · 16/16 · 8.8 / 13.7 / 15.0 | 11/11 · 14/14 · 9.8 / 12.9 / 16.0 | 11/11 · 14/14 · 9.8 / 12.8 / 33.4 | 0 | 0 | clamped 1 |

Reading: (a) paired on the same seeds every median is unchanged and the per-seed deaths move by at most ±2 chunks in both directions (smart r3 seed 12148: 13 → 17; smart r10 12007: 22 → 20, 12148: 25 → 23; strong r0 12524: 5 → 7) — the composition shift at chunks 14–16 and the frequency waves from 17 are inside the seed noise at these ranks; (b) set G is a harder set than F (the T3 code itself lands at 9 / 9 / 12 / 15 on G against 10.5 / 12 / 14.5 / 21 on F), so the T3 targets are read on the paired columns: smart r3 median 9 ∈ 9–14, strong r3 9 ≥ 8, passive r0 4 ∈ 3–5, nobody past 25 at rank ≤ 3 (nor at 6 or 10); (c) 93 of 96 after-deaths are horde deaths; the three "mini-boss" ones are squads that reached the boss already dying to waves (smart r6 seeds 12195 / 12242: losses in the last 60 s 94–99 % wave bites and spit, the Juggernaut at 9219 / 9400 and 8144 / 8350 HP when the last soldier fell to a stomp; smart r0 and strong r0 before: the same shape at a D5 Hulk); (d) no fight stalls: every killed mini-boss died within 36 s, p90 ≤ 27 s, the medians 8–15 s; (e) the T3 code's refused spawns (walker 6, brute 6, spitter 15 over 96 runs) are 2 after; the live clamp trims 0–36 zombies per 12 runs — at rank 10 the piled waves of chunks 20–23 meet stragglers of the previous wave; (f) losses stay bites + spit ≥ 94 % for the steering bots.

## 7. Smoke evidence (real time, `tools/smoke.js --endless --seconds 330`, seed 777)

Both runs: `--pre "g.config.seed=777"` (+ the four rank-3 upgrades for the rank-3 run), `--after` = `$EV/tools/probe.js` (event log + `ctx.debug.dropped` sent as one `console.warn` at the run's end; smoke keeps it in `report.consoleWarnings`, truncated past 360 characters — the `dropped` record survives, the fight itself is read from the 2-s timeline with `$EV/tools/smoketl.mjs`). Reports: `$EV/smoke-r3/report.json` (+ 18 PNGs), `$EV/smoke-r0/report.json` (+ 13 PNGs). Verdict CLEAN in both: 0 page errors, 0 console errors, frames p50 / p95 / p99 6.9 / 7.1 / 7.1 ms (worst 55.6 ms rank 3 at a district fade, 34.7 ms rank 0).

**Rank 3** (squad / fireRate / damage / bossDamage 3): the Hulk (19 150 HP after the count and shop scales) is first sampled at 152.7 s / 1 441 m with 17 988 HP and a squad of 307; HP 17 988 → 14 298 → 11 019 → 7 837 → 5 313 → 2 849 → 535 at every 2-s sample (falling 6 of 6 steps, phase 1 → 3), the next sample at 165.9 s has no boss, phase `run`, 244 soldiers, 0 zombies — **the boss is dead after ≈ 13 s**; no gate event is sampled during the fight (`gate` null at every sample), live zombies during it 0 / 0 / 10 / 0 / 0 / 6 / 0 (the Hulk's own bursts and spawns — a wave would read ≥ 40), `ctx.debug.dropped = {}` at the run's end (nothing at all was refused, zombie or otherwise). The road resumed afterwards (district fade at 191.8 s, chunk 7) and the squad was lost at 212 s / 2 031 m to the horde. `10-play-151s.png`: the squad of 307 at 1 412 m with the road empty 18 m before the boss spawn — the r5c lead (100 m) and the hold's clean entry.

**Rank 0** (fresh save; the smoke bot picks lanes by face value and never dodges): the Hulk (6 000 HP, the table) is first sampled at 153 s / 1 443 m with 5 727 HP and a squad of 130 (E 201 — a 0.65·E entry); HP falls at 20 of 21 sample steps (one flat step, 1 382 → 1 380 at 176.9–178.9 s while the phase-3 brutes landed and the count fell 68 → 42) down to 887 / 6 000, the squad 130 → 120 → 108 → 96 → 78 → 68 → 42 → 32 → 22 → 12 → 2 → 0 at 193 s — **the squad lost a fight it was 85 % through**; no gate event during it, live zombies ≤ 12 (minions only), `ctx.debug.dropped = { fx.numbers: 36 }` — no zombie-pool drop. `11-play-181s.png`: the Hulk at ≈ 25 % under the squad of 42, slam ring telegraphed, zombies 0, dropped fx.numbers only. This is the weak-entry loss the fast runner also shows for non-dodging rank-0 bots (T3-F strong r0: first mini-boss killed 9/11; the fixer's and the lead's numbers), not a wall: the boss took damage at every sample and the fight lasted 40 s against a 0.65·E squad with no dodging. The steering bots at rank 0 (fast runner, §6) kill the first mini-boss 12/12.

**Real-time probe (the lead's `$LV/tools/fightprobe-rt.mjs`, the game's own rAF loop, the smoke bot's lane choice, 0.5-s samples; `$EV/fightprobe-r3.{json,txt}`, `fightprobe-r0.{json,txt}`, seed 777, 330 s).** Rank 3: the Hulk (18 900 HP) spawns at 151.7 s / 1 430 m with 301 soldiers and dies at 165.2 s / 1 562 m with 238 — TTK 13.5 s, 12.0 s in range, **0.0 s with boss damage under 20 % of the rifle DPS** (643–2 024 HP/s against a rifle DPS of 718–908 at every sample: the boss, not a brute, takes the fire), 0 gate events and 0 wave zombies during the fight, 24 minions; `level._holdOn` is true at all 28 boss samples and false at every sample after the kill, `boss:dead` carries `holdShiftM` 69 (60 m release + the 9 m the first held event was short of the kill), `ctx.debug.holdShiftM` 69 at the run's end, 30 samples after the kill show 0 live zombies on the road (the held waves start 60 m later); the run ends at 2 052 m (chunk 7, the horde) after 8 chunks. The longest any zombie stayed in contact with the formation over the whole run: a brute, 5.98 s (8 brutes over 4 s, none during the fight; the lead's r5c probe measured 10–100 s) — the HP cap holds in play.

(rank-0 probe and the second rank-0 run: filled below)

## 8. Docs

- `docs/GDD.md` §6.3: the endless per-zombie HP cap (round 5d paragraph). §10.1: the chunk formulas at T3 (pop, waves + extra, the r5c mini-boss rules), new bullets *Numbers, never HP*, *Mini-boss hold*, *Pool-safe by construction*, *Measured*.
- `docs/ARCHITECTURE.md` §6.16: the round-5d endless bullet (HP cap, the hold's mechanics, the pool clamp). §6.17: `endlessHpCap`, `endlessPoolReserve`, `endlessPoolPeaks`, the `endlessParams` fields, the generator's pool-safe chunk paragraph. §8.6: the round-5c / 5d `LEVELS.endless` keys. §13: the validator's endless scope.
- `js/data.js`: the key comments (`waves`, `pop`, `wavePoolShare`, `poolReserve`).

## 9. For the lead

1. **The levers.** `waves.maxPerChunk` / `minSpacingM` bound the frequency ramp (6 waves ≈ 390 zombies per normal chunk from chunk 22; every chunk from 22 on is at that ceiling, the validator's `horde` column shows what is still dropped). `poolReserve` trades pile size for slack. `extraFromD / extraEveryD / extraCap` still add waves below the saturation point (D12 / D20); from chunk 17 the frequency rule supersedes them.
2. **Nudge piles.** The one-wave-per-gate nudge still lands neighbouring waves on the same metre (D18+: 143, 143, 178, 248, 248, 283 — six waves on four moments; every mini-boss chunk: all waves on 125). The pool fit makes them safe, not spread. Spreading a nudged wave to the far side of the gate (arrival − `waveAfterGateM` − its window) would keep the chunk's rhythm; it changes contact order and every seed's layout, so it is a tuning decision, not a fix.
3. **Spitters linger.** The static model ends a zombie at contact; a spitter holds at 18 m for up to 6 s, so piled spitters can outlive their span — the reserve of 2 and the live clamp cover it (1 refusal in 96 runs).
4. **Not changed.** The mini-boss's own numbers (HP 30·E, the r5c lead / tail / cut, minions), the HP cap seconds, the hold's 60 m.
