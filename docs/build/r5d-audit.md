# Round 5d: independent audit of the endless changes

Owner: auditor. Date: 2026-10-17.

**Scope.** The round-5d endless work:
- the fixer's A–D;
- the lead's T3 data;
- the pool-safe change written up in `docs/build/r5d-endless.md`.

**Baseline.** The shipped 1.2.0 build in `dist/js/`.

**Evidence.** `E:/Temp/claude/gate-rush-evidence/r5d/auditor/r2/`, written `$AU` below.
- `orig/` holds the files as handed to the audit: level.js 542e579f, levelgen.js d7474173, data.js 98160562, validate-levels.js d0cf0097.
- `runs/` holds the fast-runner sets, with per-set `*.summary.txt` and `*.audit.txt` and the before / after table `tables.md`.
- `smoke/` holds the four real-time endless runs.
- `boss/` holds the campaign boss runs on the current tree and on `dist/`.
- `probe/` holds the fight probes.
- `tools/` holds the instrumentation: `audit.js`, `auditana.mjs`, `smokeaudit.js`, `stallprobe.mjs`, `dropprobe.mjs` and `bossruns.sh`.

**Installed after the audit:**
- `js/level.js` d694c732 (one fix, §2).
- `js/levelgen.js`, `js/data.js` and `tools/validate-levels.js` are unchanged.
- `docs/ARCHITECTURE.md` §6.16: one clause for the fix.

## Verdicts

| # | Claim | Measured | Verdict |
|---|---|---|---|
| 1 | Smart r3 median death chunk 9–14 | 10.5 on set H before the fix and after it; 9 on set I; **9** pooled over 24 seeds (range 7–17) | **confirmed** |
| 2 | Strong r3 median ≥ 8 | 8.5 on H and H2; 11 on I; **9.5** pooled (range 7–15) | **confirmed** |
| 3 | Passive r0 median 3–5 | 3.5 on H and H2; 3 on I; **3.5** pooled (range 2–12) | **confirmed** |
| 4 | Nobody past chunk 25 at rank ≤ 3 | Highest: smart 17, strong 15, passive 14. Rank 10 reaches 23 at most | **confirmed** |
| 5 | Most deaths are horde deaths | 169 of 192 runs on the final code: 169 horde, 19 gate (12 of those are passive r0, borderline: a small squad, a red gate and the horde), 4 mini-boss | **confirmed** |
| 6 | No zombie's HP exceeds `hpCapSeconds` × the design DPS at E(D) | **Refuted on the handed-over code:** after the first mini-boss hold, 1 292–3 436 spawns per config exceeded the cap of their own chunk by up to **6.3 %**, and by **12.5 %** after a 327 m shift. A defect, fixed (§2). After the fix: **max ratio 1.000** in every chunk, D1–D23, over 395 131 spawns in sets H2 + I + H2b + Ib; contact-chunk ratio 1.000; 0 over the cap. The four smoke runs also show 1.000 | **fixed, then confirmed** |
| 7 | Mini-boss fights never stall: boss HP falls whenever the boss is in range | Of 283 fights on the final code (sets H2b + Ib), 273 never had > 2 s in range without an HP fall. 10 had 2.3–25 s, 4 had > 5 s, 2 had > 10 s. Every fight > 5 s is a Hulk (or one Juggernaut) entered at 0.11–0.89·E by a non-dodging or passive bot. Cause: capped wave brutes still in contact soak all the fire (§3). Fights entered at ≥ 0.6·E: worst 5.35 s, all killed. Smoke rank-0 seed 2024 (entry 0.46·E): Hulk HP 5 968 → 5 944 over 20 s, squad lost | **refuted for weak entries** (a tuning finding, not a code defect) |
| 8 | No gate / wave / crate / coins event during a fight | 0 held events fired, 0 gate passes, 0 non-minion zombie spawns, `_holdOn` true on every frame of every fight. Covers 283 + 284 fast-runner fights and 5 smoke fights. Release gap: first held event 60–86 m after the kill | **confirmed** |
| 9 | Zombie pools never overflow (`ctx.debug.dropped`) | Rank ≤ 3: 0 refusals. Rank 6 / 10: spitter refusals 5 (H2), 10 (I), 7 (H2b) per 48 runs, in the deep chunks (chunks 17–18 in the two probed runs). Cause: the live clamp counts alive spitters, but dying bodies still hold pool slots (§4). Peak alive 114 / 54 / 30 / 14 / 22 of 120 / 60 / 40 / 16 / 24. Smoke: none | **refuted at rank 6–10** (harmless; fix needs a zombies.js accessor) |
| 10 | Validator 0 errors | `node tools/validate-levels.js`: 30 levels · 7 warnings · **0 errors**. Same at `--chunks 40` | **confirmed** |
| 11 | Campaign untouched: validator lines | The campaign section, timings stripped, is **byte-identical** to `level/validate-after2.txt`. The whole output is byte-identical before and after the audit fix | **confirmed** |
| 12 | Campaign untouched: boss TTK within ±10 % | L5 / 190 **22.7 s** (dist 22.7; 136 survivors as r5b-verify). L10 / 280 **18.6 s** (r4-release 19.0, −2 %; dist 19.1). L20 / 600 **22.0 s** (r3-verify 22.0; dist 22.6). r5-release's two: L16 / 445 **21.7 s** (21.4, +1 %), L26 / 600 **20.5 s** (20.6) | **confirmed** |

## 1. Diff review: `js/` against `dist/js/`

**level.js.** The changes are those `docs/build/r5d-endless.md` §2 lists:
- `HOLD_TYPES`, `_holdOn`, `_holdShiftM` and `_releaseHold`;
- the shifted `_appendChunk` and `_guardEndlessGate`;
- `_clampEndlessUnits`, `_capEndlessHp` and `_miniMinionMult`;
- the miniBoss shares;
- `_crowdEndlessWave` without the pressure.

Every change is endless-gated. The campaign paths compute the same values as 1.2.0:
- `_fireBoss` minion HP takes the `_liveHpMult` branch;
- the guard / wave solve is only refactored into an `eContact` variable.

**levelgen.js.**
- New: `endlessParams` (`pop` × p^popShare baked in, `wavesBase` / `need` / `waves` / `popWave`, extra waves), `endlessWaveWindow`, `capWaveToPoolShare`, `fitEndlessPools`, `endlessHpCap`, `endlessPoolReserve` and `endlessPoolPeaks`.
- The validator's sim takes the cap.
- `checkPoolOverlap` is split into `poolSpans`.
- Only `generateChunk` and the endless sim use them.

**data.js.**
- `LEVELS.endless` keys (T3 `pop` / `waves`; `maxPerChunk`, `minSpacingM`, `wavePoolShare`, `poolReserve`, `miniMinions`, `miniBossLead/Tail/WaveCut/HpShare/KillsShare`, `hpCapSeconds`, `miniBossHold`).
- `JUICE.caps.decals` 12 → 24 (r5c lead; FX only).

**Rules (ARCHITECTURE §14).**
- No `console.log` or `Math.random` in the three files.
- Allocations only at event time or chunk generation (`_capEndlessHp`'s fresh table, the fit's arrays).
- `_clampEndlessUnits` and the hold loop allocate nothing.
- `node --check` and `tools/check-imports.js` pass.

**Things that are not defects but are worth knowing:**
- `this._holdShiftM = 0.5; this._holdShiftM = 0;` is the project's double-field idiom.
- `endlessMinionUnits` reads `LEVELS.endless.miniMinions.sharedSolve`, which data.js does not set. r5c ran it as config E (`r5c/endless/subsE.json`) and shipped D without it. So each mini-boss's minions are solved over its own union. The Juggernaut's walker-only bursts carry the whole solve: 575 HP at D10 rank 0 (2.7× the walker cap) and 789 HP at rank 3 (p^0.5).
  - The data.js comment "the mini-boss's own minions (miniMinions) sit far below it [the cap]" is therefore wrong for the Juggernaut.
  - Juggernaut TTK medians are 6–15 s, so this is not a wall. Not changed. The lead can set `sharedSolve: true` or fix the comment.

## 2. Defect fixed: the hold shift moved the HP cap and solve one chunk up

**Finding.** After a mini-boss hold, every later event's `at` carries `_holdShiftM` (`_releaseHold`), and chunks are generated at `chunkEnd + _holdShiftM`. `_guardEndlessGate` already reads an event's chunk as `(at − _holdShiftM)`. But `_expectedAt(d)` (E(z) for the endless runner) still used `floor(d / chunk) + 1`.

So the waves of the last `_holdShiftM` metres of every chunk took the next chunk's E for three things:
- the live HP solve (`eContact`);
- the HP cap (`_capEndlessHp(hp, units, eContact)`);
- `expectedSquad()` (the medic's cap).

After a long fight the shift passes a whole chunk: 327 m after a 40-s Hulk fight (H, strong r0, seed 13221).

**Measured on set H, handed-over code.** The instrument divides `zombie:spawn` hp by `hpCapSeconds[type]` × E(D)·`FIRE.rateBase`·`dmgBase`·`accuracy`, with D the chunk the content was generated for.
- Every chunk before the first hold (D1–D5), and every mini-boss chunk, sits at ≤ 1.000.
- Every other chunk from D6 sits at 1.060–1.063, i.e. one E step. Example (smart r3, seed 13327): a walker at 203 HP against a cap of 191.
- D6 of strong r0 seed 13221 sits at 1.125 (two steps, 327-m shift).
- Measured against the distance chunk at contact instead, the ratio is exactly 1.000, so the cap itself works and only its E frame was wrong.

**Fix.** One line in `js/level.js` `_expectedAt` (`$AU/audit-fix.diff`): the endless branch reads `floor((d − this._holdShiftM) / chunk) + 1`. This is the frame `_guardEndlessGate` uses.
- `_holdShiftM` is 0 before the first hold and in the campaign, so D1–5 and every campaign path are unchanged.
- The validator does not read level.js; its output is byte-identical.

**Re-measured on the same 12 seeds, H → H2.**
- Max ratio is 1.000 in every chunk of every config, with 0 spawns over the cap.
- Every median is unchanged: smart 7 / 10.5 / 13.5 / 19, strong 7 / 8.5, passive 3.5 / 7.
- 15 of 96 runs move ±1–2 chunks. That is exactly the run-to-run noise: re-running the same code (H2 → H2b) also moves 15 of 96 runs by ±1–2. The fast runner is not bit-deterministic across page instances.

**Left as it is.** The runner's `_difficulty` stays distance-based, as r5d-endless.md §2 decided for bookkeeping. It sets speed, `eBoss`, the band and the pressure / design multiple in `_liveHpMult`. The cap binds every type except crawlers, so the leftover offset only touches crawler HP (below the cap) by one pressure step (×1.07) in the shifted tail of a chunk.

## 3. Finding: brute piles at the formation front

The cap is per zombie: a brute dies within 3 s of on-curve fire. But a wave carries up to 4 brutes (pool share 16 / 4), and the gate nudge and the 100-m mini-boss lead pile 2–3 waves together. So brute piles still hold the front for a long time.

**Fast runner, final code, H2b + Ib.** Longest continuous stretch with a brute in contact (z ∈ [−3.5, 2]):

| config | longest stretch | runs with a > 10 s stretch |
|---|---|---|
| smart r0 | 26–32 s | 20 of 24 |
| strong r0 | 22–39 s | 15 of 24 |
| passive r0 | 18–23 s | 17 of 24 |
| smart r3 | 17–18 s | 9 of 24 |
| strong r3 | 24–27 s | 8 of 24 |
| smart r10 | 6.6–8 s | 0 |

- Most of the long stretches are the squad's last seconds (count → 0 under the pile): the "numbers" death the round wants.
- Smart r0 meets the D5 Hulk on almost every seed with 7–8 brutes (964 HP each, the D5 cap) in contact for 13–16 s (count 140–250). The boss still dies: 24 of 24, TTK median 16.8 s.

**The two 17–25 s boss stalls (§ verdict 7).**
- `probe/stall-14542.txt`, strong r0 seed 14542: 6 wave brutes (964 HP) sit at x = 0, z −0.7…−2.9 in front of a squad of 58–100 (0.3–0.5·E) at rank 0.
- The bot never dodges, so the shooters' converging lines to the boss cross the brutes.
- The brutes lose HP the whole time (4 714 → 3 093 HP over 21 s), and the boss takes 0 hits for 20 s.
- Real-time: smoke r0 seed 2024 shows the same shape (`smoke/r0-2024/10-play-151s.png`: a brute pile at the front, 4 zombies, squad 92).

**For the lead.** This is the old wall at a much smaller scale: 4–6 brutes at the cap instead of one uncapped brute, and only for squads below the curve. Levers:
- `hpCapSeconds.brute` (3.0);
- the brute pool share per wave;
- `miniBossLeadM` (100 m is ~10 s at D5; an 8-brute pile at rank 0 needs ~24 s);
- solving the cap at min(E, live C) instead of E.

Not changed: this is tuning.

## 4. Finding: spitter refusals at rank 6–10

**Measured** (`tools/dropprobe.mjs`, smart r10 seed 14011, smart r6 seed 13274). Every refused spawn is a staggered wave spawn (`_fireWave` → `_spawnStaggered` → `spawnWave` → `_spawnUnit`):
- at the moment of the refusal, 18–20 spitters were alive and 4–6 were dying;
- alive + dying = 24, the pool;
- no slot was free.

**Cause.** `_clampEndlessUnits` budgets `pool − aliveOfType(t) − reserve`. A dying body keeps its pool slot for `ZOMBIES.common.death.free` (1.4 s), so with more than 2 spitters dying (the reserve) the clamp lets through more than the pool holds.

**Impact.** 1–5 spitters dropped in some rank-6/10 runs from chunk 17 on, 0 at rank ≤ 3. The spawn is guarded and counted, so nothing breaks.

**Fix (not applied).** It needs a slot-occupancy accessor on zombies.js (e.g. `usedOfType(type)` = pool − free slots), used in `_clampEndlessUnits`. zombies.js is outside this round's files, and reading `_freeTop` from level.js would break the guarded-API rule. Raising `poolReserve.spitter` is a data alternative but changes the deep chunks' composition.

## 5. Measurements

**Fast runner.** Tools: the r5c / r5d harness plus `audit.js`, which instruments:
- the per-spawn HP cap against the generated, distance and contact chunks;
- per-fight in-range time (`boss.aimPoint` within `FIRE.bossAimRange`) and the longest in-range stretch without an HP fall;
- events, gate passes and non-minion spawns during the fight;
- the `_holdOn` sampling and the release gap;
- per-frame pool peaks and brute contact.

Seed sets, 8 configs each (smart r0 / r3 / r6 / r10, strong r0 / r3, passive r0 / r3), 0 page errors:
- **H**: 13009 + 53·i, handed-over code.
- **H2**: the same seeds, audited code.
- **I**: 14011 + 59·i, audited code.
- **H2b / Ib**: H2 / I re-run with the brute counter. These measure the noise.

Some logs show a Chrome "AudioContext encountered an error from the audio device" console line when 8 browsers run at once. That is the host audio device, not game code.

Death chunk median (min–max), 12 seeds each:

| config | H (handed over) | H2 (audited) | I (audited) |
|---|---|---|---|
| smart r0 | 7 (7–12) | 7 (7–13) | 7 (7–10) |
| smart r3 | 10.5 (7–17) | 10.5 (7–17) | 9 (8–17) |
| smart r6 | 13.5 (8–19) | 13.5 (8–19) | 14 (12–18) |
| smart r10 | 19 (12–22) | 19 (13–22) | 18 (14–23) |
| strong r0 | 7 (5–12) | 7 (5–12) | 7 (7–14) |
| strong r3 | 8.5 (7–15) | 8.5 (7–15) | 11 (7–16) |
| passive r0 | 3.5 (3–7) | 3.5 (2–7) | 3 (2–12) |
| passive r3 | 7 (5–11) | 7 (5–12) | 8.5 (6–14) |

Mini-bosses on the final code, pooled H2b + Ib (24 seeds each):

| config | first mini-boss killed | all killed | TTK median / max |
|---|---|---|---|
| smart r0 | 24/24 | 25/25 | 16.8 / 38.4 s |
| smart r3 | 24/24 | 38/38 | 9.1 / 14.5 s |
| smart r6 | 24/24 | 51/52 | 7.6 / 13.9 s |
| smart r10 | 24/24 | 73/73 | 6.1 / 13.6 s |
| strong r0 | 22/23 | 25/26 | 12.7 / 40 s |
| strong r3 | 24/24 | 34/34 | 10.3 / 30.1 s |
| passive r0 | 5/5 | 6/6 | 14.1 / 19 s |
| passive r3 | 21/23 | 27/29 | 10.3 / 19.4 s |

Pool peaks over every run: 114 / 54 / 30 / 14 / 22, total 224 of 260. Live clamp trims per 12 runs: 0–88, most at rank 10. The full tables are in `$AU/runs/tables.md`.

**Smoke.** Command: `node tools/smoke.js --endless --seconds 330 --shots 30 --pre "g.config.seed=S[;rank-3 upgrades]" --after "<tools/smokeaudit.js>"`, audited code. Every run is CLEAN: 0 page errors, 0 console errors, frames p50 / p95 / p99 6.9 / 7.1 / 7.1 ms.

The long frames in the two rank-3 runs (104–132 ms at 13–16 s) come from the audit probe. Without it, the same seed shows worst frame 41.6 ms on the current tree and 41.7 ms on `dist/`, with no long frames.

| run | fights (TTK, in range, 1-s steps with no HP fall, hold on) | events / gate passes / non-minion spawns during fights | release gap | max HP / cap | `ctx.debug.dropped` | end |
|---|---|---|---|---|---|---|
| r3 seed 31337 | Hulk 21 750 HP, C 380: 10.6 s, 10 s, 0/11, 11/11. Juggernaut 20 850 HP, C 290: 7.7 s, 8 s, 0/8, 8/8 | 0 / 0 / 0 | 60 m, 60 m | 1.000 | `{}` | alive at 320 s, 3 156 m |
| r3 seed 2024 | Hulk 17 800 HP, C 272: 13.7 s, 14 s, 0/14, 14/14 | 0 / 0 / 0 | 60 m | 1.000 | `fx.decals 2` | lost at 198 s, 1 892 m (horde) |
| r0 seed 31337 | Hulk 7 950 HP, C 321: 13.3 s, 13 s, 0/13, 13/13 | 0 / 0 / 0 | 60 m | 1.000 | `{}` | lost at 271 s, 2 633 m (horde) |
| r0 seed 2024 | Hulk 6 000 HP, C 92 (0.46·E): not killed, 38 s in range, flat 13/38 (HP 5 968 → 5 944 over 153–173 s, then 5 454 at the loss), 38/38 | 0 / 0 / 0 | – | 1.000 | `{}` | lost at 189 s, 1 796 m, to the brute pile + Hulk (§3) |

**Campaign bosses.** Command: `$AU/tools/bossruns.sh`, `--level N --boss --after "g.squad.setCount(C,'debug')"` plus TTK listeners. Run on the current tree and on a copy of `dist/` (`$AU/distroot`). All 10 runs are CLEAN and all won. TTK in seconds, current / dist:

| level / count | current | dist | survivors (current / dist) |
|---|---|---|---|
| L5 / 190 | 22.7 | 22.7 | 136 / 135 |
| L10 / 280 | 18.6 | 19.1 | 187 / 186 |
| L16 / 445 | 21.7 | 21.7 | 286 / 285 |
| L20 / 600 | 22.0 | 22.6 | 482 / 480 |
| L26 / 600 | 20.5 | 20.5 | 492 / 492 |

**Static.**
- `node tools/validate-levels.js`: 0 errors, 7 warnings (`$AU/validate-final.txt`).
- Campaign section identical to `level/validate-after2.txt` (`$AU/campaign-{after2,final}.txt`, empty diff).
- The whole output is identical to the handed-over tree's (`validate-orig.txt`).
- `--chunks 40`: 0 errors.
- `node --check js/level.js` and `tools/check-imports.js`: OK.
