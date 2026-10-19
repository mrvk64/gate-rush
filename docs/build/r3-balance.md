# Round 3: campaign L1–L12 and endless balance

Owner: balance and level generation (`js/level.js`, `js/levelgen.js`, `tools/validate-levels.js`; data keys `LEVELS.*`, `LEAK_MODEL.*`, `WAVE_*`, `ECONOMY.*`, `STARS.*`, `SCORE.*`, `GATE_RULES.generation.*`; GDD §4.4, §6.3, §9, §10, §10.1).
Date: 2026-10-09. All test output is under `E:/Temp/claude/gate-rush-evidence/r3/balance/`, written as `$EV` below.

## Verdict against the lead's decisions

| # | Decision | Before (original code) | After (installed) | Status |
|---|---|---|---|---|
| 1 | **Endless must end.** A strong player (lane picking, shop ranks 3) has a median death chunk of 9–14 (≈ 4–7 min) and never passes chunk 25. A passive player (ranks 0) has a median death chunk of 3–5. At least 5 seeds; death comes from a horde, not a spike. | Smart r3: median 13, but 5 of 12 runs reached chunk 40–54 (18–24 min). QA-strong r3: 4 of 12 runs passed chunk 25. Passive r0: median 9. | 12 seeds per bot. Smart r3: median 11 (9–23), 5.4 min. QA-strong r3: 9.5 (5–21). Passive r0: 5 (3–16). Worst r0: 3. Smart r6: 12.5 (10–25). **0 of 60 runs passed chunk 25.** Bites and spit cause 96 % of smart losses (90 % for QA-strong), and the squad count falls over a median of 4 chunks. | met |
| 2 | **Wave leak inside the GDD §6.3 bands** for an on-curve player with realistic ranks (greedy L1→L12 shop). No early wave (first two of a level) kills more than 35 % of an on-curve squad. A fresh-save rank-0 player may lose L12, but not to the first wave. | Canonical levels: L2 28.0, L3 23.6, L4 22.8 and L7 30.1 % were above band; L6 10.4, L8 10.4 and L10 18.3 % were below. Worst early wave: 45 %. Over 12 layouts, 18 of 288 early waves went over 35 % (max 67 %), and the on-curve squad lost 8 of 24 L11/L12 runs. Fresh rank-0 L12: smart and passive both died, passive at the 2nd wave. | Canonical levels: all 12 inside their band within run-to-run noise (table §2). Worst early wave: 25 %. Over 12 layouts, 1 of 288 early waves went over 35 % (37 %, L5 seed 2005), and no on-curve run failed. Fresh rank-0 L12: smart clears with 3★; passive dies at 41 % of the level, and its first two waves cost 1 and 3 soldiers. | met (one residual wave, §7) |
| 3 | **Stars and coins reward skill.** Strong player 3★ on at least 10 of L1–L12. Passive player averages 2★ or less and fails at least 2 levels. Worst-lane bot fails most levels after L3. Strong income is at least 1.3× passive on every level both clear. | Smart 3★ 12/12; QA-strong 8/12. Passive: 2.00★ average, 3★ on 4 levels, 2 first-attempt fails, and the 0.25·E_boss assist handed it 3★ on L12. Worst: 5 of 9 first-attempt fails after L3. Income ratio 0.90–1.30, under 1.0 on L1, L6, L8, L12. | Smart 3★ 12/12; QA-strong 8/12 (9/12 in the previous identical run). Passive: 1.83★ average, 3★ only on L1 and L6, first-attempt fails on L9, L11, L12. Worst: 5 of 9 first-attempt fails after L3. Income ratio 1.31–1.94 on L2–L12, 1.07 on L1. | met with the smart bot (a strong human); L1 ratio and QA-strong 8–9/12 still open (§7) |
| 4 | **A struggling player can progress.** Two failures plus one win on any level up to L12 pay for at least one new rank. Retries may reroll the seed. A fail-streak assist shows the hint "Reinforcements: +N soldiers". | The economy check passed (old payouts were generous). RETRY replayed the same seed. Assist was 0.25·E_boss·k with no hint. | Passes on all 12 levels for the worst and passive bots, both estimated and measured. RETRY after a failure plays seed 1000 + L + 100·fails. Assist is ceil(0.08·E_boss·k), k ≤ 4, with hint:show "REINFORCEMENTS: +N SOLDIERS" on every assisted attempt. | met |
| 5 | **Keep L1 = GDD §11 authored and keep boss HP squad scaling.** | — | L1 script and seed are untouched (validator row identical before and after). `BOSSES.squadScale`, `shopScale` and `hpPerE` are unchanged. | met |

## How it was measured

**Fast runner** (`$EV/tools/`):
- Headless Chrome (puppeteer-core from the project's `node_modules`) loads the real `index.html` and `js/` from a local static server. three.js CDN requests are served from `node_modules/three`.
- The engine loop is stopped and stepped by hand (`H.now += 50; g.engine.frame(H.now)`, which is 3 fixed steps). Drawing is throttled and `ui.update` is stubbed. This runs about 250× real time (L1 takes 0.23 s wall time).
- The game code is not modified. Bots steer the squad the same way a player does.
- "Before" serves the original `level.js`, `levelgen.js` and `data.js` from `$EV/base/js` (md5 351468d1, bac5574d, b8732279) with env `BASEDIR`. "After" serves the installed files with env `NOWIP=1`.

**Bots** (`$EV/tools/harness.js`):

| Bot | Behaviour |
|---|---|
| smart | Picks the lane with the best anticipated result: the gate's value after the hits it will actually land, read from the gate's own cap, step and flip state. Dodges boss-attack telegraphs. Stands in for a strong human. |
| strong | QA's bot: picks the lane with the best face value right now. |
| passive | Never steers. Commits to the lane nearest the centre (ties go left; on a triple, the middle lane). |
| worst | Always takes the worst lane. |

**Campaign runs.** L1→L12 with a greedy shop (buy the cheapest next rank after every run) and up to 4 attempts per level. Attempts use the game's own default seeds, so after the change a retry rerolls.

**Endless runs.** 12 seeds (4242 + 17·i), sim time capped at 2400 s.

**On-curve lab** (`lab.mjs`):
- The smart bot plays with the squad pinned to the design line after every gate pass: C = round(E(d + 15)).
- Ranks are those a player who spends every coin owns at that level, in that economy (squad, fire, damage, coin, boss):
  - Before, L1–L12: 00000, 00010, 10020, 11121, 21131, 22132, 32232, 32243, 43343, 43354, 44454, 54464.
  - After, L1–L12: 00000, 10010, 10021, 11121, 21121, 21132, 22232, 32243, 33343, 43353, 43354, 44454.
- Two sets per level:
  - (a) Canonical: seed 1000 + L, 12 repeats with human noise (0.4 s reaction, ±0.5 m aim).
  - (b) 12 layouts: seeds 1000·(k + 1) + L for k = 0…11.
- Leak = biters / spawned for each wave or run-up, averaged over the level. GDD §6.3 bands: L1–3 10–15 %, L4–9 15–22 %, L10+ 22–28 %.

## 1. Endless (decision 1)

| Bot (shop ranks) | Before: median death chunk (min–max) | Before: runs past chunk 25 | Before: median time | After: median death chunk (min–max) | After: runs past 25 | After: median time |
|---|---|---|---|---|---|---|
| smart (3) | 13 (11–54) | 5 / 12 | 378 s | 11 (9–23) | 0 / 12 | 326 s (5.4 min) |
| QA strong (3) | 13 (6–50) | 4 / 12 | 373 s | 9.5 (5–21) | 0 / 12 | 283 s (4.7 min) |
| passive (0) | 9 (5–19) | 0 / 12 | 274 s | 5 (3–16) | 0 / 12 | 151 s |
| worst (0) | 6 (5–9) | 0 / 12 | 181 s | 3 (2–4) | 0 / 12 | 82 s |
| smart (6) | — | — | — | 12.5 (10–25) | 0 / 12 | 366 s |

Death chunk per seed, after:

| Bot | Seeds 1–12 |
|---|---|
| smart r3 | 12, 17, 10, 11, 23, 9, 9, 10, 22, 19, 9, 11 |
| QA-strong r3 | 10, 13, 9, 6, 21, 7, 5, 6, 21, 17, 8, 11 |
| passive r0 | 6, 4, 5, 4, 5, 16, 5, 4, 15, 16, 4, 3 |

**How runs end now.** Losses by cause, after:

| Bot | Bite | Spit | Other |
|---|---|---|---|
| smart | 72 % | 24 % | stomp 2 %, gate 1 % |
| QA-strong | 68 % | 22 % | slam 6 % |
| passive | 59 % | 29 % | gate 10 % |

A strong squad peaks and then shrinks over a median of 4 chunks (smart bot, minimum 3) as the horde outgrows it; no single event wipes it out.

**How runs ended before.** A strong run either died at chunk 11–14, or the rubber band and growing gates carried it indefinitely. ÷2 | ÷2 gates pinned C/E near 1.8–3.2, producing runs of 18–24 min.

**What changed** (GDD §10.1):
- From chunk 4, a compounding pressure p = 1.07^(D − 4) multiplies:
  - wave HP;
  - wave population (each type capped at ¼ of its pool);
  - mini-boss HP and attack kills;
  - the score.

  It also divides the gate gain cap.
- Waves are designed for 9·E(D), ramped in from ×1 at D1, and solved at E(D):
  - never at the live count;
  - with no shop compensation.

  The shop's fire × damage is what carries a strong player further: r6 dies about 1.5 chunks later than r3.
- Gates are sized from E(min(D, 4)), and every lane is scaled so the best one adds at most 0.35·E(4)/p.
- The high-side ÷2 | ÷2 rubber band is gone; the low side stays.
- Waves per chunk are capped at 3. Population is min(16, 10 + 2D) before the pressure.
- Mini-boss HP is 30·E × the pressure.

## 2. Campaign leak (decision 2)

Mean leak per level (% of a wave that bites) from the on-curve lab. ▲ = above band, ▼ = below band.

| L | Band | Canonical, before | Canonical, after | 12 layouts, before | 12 layouts, after |
|---|---|---|---|---|---|
| 1* | 10–15 | 14.1 | 14.3 | 11.5 | 10.9 |
| 2 | 10–15 | 28.0 ▲ | 13.3 | 27.9 ▲ | 7.3 ▼ |
| 3 | 10–15 | 23.6 ▲ | 12.9 | 20.6 ▲ | 13.2 |
| 4 | 15–22 | 22.8 ▲ | 19.3 | 27.2 ▲ | 20.7 |
| 5 | 15–22 | 16.8 | 14.4 (noise: 15.7 in the run before) | 22.7 ▲ | 22.5 (≈) |
| 6 | 15–22 | 10.4 ▼ | 17.4 | 16.1 | 22.0 |
| 7 | 15–22 | 30.1 ▲ | 19.0 | 15.6 | 18.1 |
| 8 | 15–22 | 10.4 ▼ | 15.8 | 12.1 ▼ | 17.6 |
| 9 | 15–22 | 19.3 | 21.8 | 12.6 ▼ | 17.7 |
| 10 | 22–28 | 18.3 ▼ | 26.3 | 19.4 ▼ | 18.1 ▼ |
| 11 | 22–28 | 26.4 | 24.8 | 24.2 (6 of 12 runs failed) | 22.2 |
| 12 | 22–28 | 25.0 | 27.9 | 22.1 (2 of 12 runs failed) | 26.5 |
| Worst early wave (first two of a level) | ≤ 35 % | 45 % (L12) | 25 % (L5) | 67 % (L11); 18 of 288 over 35 % | 37 % (L5); 1 of 288 over 35 % |

\* L1 is authored. Canonical means average 12 noisy repeats and move by about ±2 points from run to run.

QA measured L7 / L9 / L12 at 28.6 / 25 / 31.3 %. They are now 19.0 / 21.8 / 27.9 %.

**Fresh save, rank 0, L12 (seed 1012).**
- Before: smart died at 38 % of the level and passive at 20 %. The passive squad of 17 was wiped by the second wave (4 walkers + 2 brutes + 2 spitters + 8 runners).
- After: smart clears with 3★ (340 soldiers at the boss). Passive dies at 41 % of the level. Its first two waves (6 walkers; then 5 walkers + 2 runners) cost 1 of 17 and 3 of 23 soldiers.

**What changed** (GDD §6.3):
- A per-level capacity factor, `LEAK_MODEL.calibByLevel`, fitted on the canonical levels with the greedy ranks.
- An early-level ramp, `LEAK_MODEL.earlyRamp`: waves in the first 40 % of a level meet the bare squad.
- `WAVE_RULES.small`: a wave never outnumbers its squad.
  - At most max(4, 0.3·E) zombies.
  - Brutes and spitters only from E = 25.
  - At most max(2, 0.25·E) runners.
  - The one new brute or spitter in the unlocking level's intro mix takes 4 places of that cap. This last rule was added in the final pass, after L5's mixed spitter wave cost 36–37 % on 2 of 12 layouts. It removed one of those two waves (seed 4005: now 23 %) and changes no canonical level (validator output identical).

## 3. Stars and income (decision 3)

| Bot | Before: avg ★ / 3★ levels / first-attempt fails | After: avg ★ / 3★ levels / first-attempt fails |
|---|---|---|
| smart | 3.00 / 12 / 0 | 3.00 / 12 / 0 |
| QA strong | 2.50 / 8 / 1 (L11) | 2.58 / 8 / 0 (previous identical run: 2.75 / 9) |
| passive | 2.00 / 4 / 2 (L11, L12) | 1.83 / 2 (L1, L6) / 3 (L9, L11, L12) |
| worst | 1.25 / 1 / 5 | 1.17 / 0 / 5 (L4, L7, L9, L10, L11; L10 not cleared within 4 attempts) |

Passive stars at clear, per level (attempt and assist in brackets):

| | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 | L9 | L10 | L11 | L12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Before | 3 | 2 | 2 | 2 | 2 | 3 | 1 | 3 | 1 | 1 | 1 (a3) | 3 (a3, +82) |
| After | 3 | 2 | 1 | 1 | 2 | 3 | 2 | 2 | 1 (a2) | 1 | 2 (a2) | 2 (a3, +26) |

Income from the clearing run, smart / passive (coins):

| L | Before: smart / passive = ratio | After: smart / passive = ratio |
|---|---|---|
| 1 | 252 / 277 = 0.91 | 412 / 384 = 1.07 |
| 2 | 353 / 317 = 1.11 | 318 / 169 = 1.88 |
| 3 | 428 / 366 = 1.17 | 363 / 195 = 1.86 |
| 4 | 470 / 454 = 1.04 | 398 / 212 = 1.88 |
| 5 | 569 / 478 = 1.19 | 481 / 285 = 1.69 |
| 6 | 700 / 767 = 0.91 | 672 / 505 = 1.33 |
| 7 | 817 / 629 = 1.30 | 781 / 486 = 1.61 |
| 8 | 877 / 901 = 0.97 | 859 / 560 = 1.53 |
| 9 | 957 / 792 = 1.21 | 816 / 509 = 1.60 (same seed 1109: 1.81) |
| 10 | 1211 / 1044 = 1.16 | 893 / 566 = 1.58 |
| 11 | 1284 / 1153 = 1.11 | 1182 / 608 = 1.94 (same seed 1111: 1.64) |
| 12 | 1706 / 1906 = 0.90 | 1360 / 1038 = 1.31 (same seed 1212: 1.36) |

The passive's L9, L11 and L12 clears were retries on rerolled seeds. `matched.mjs` replays the smart bot on the same seed with its own ranks; those are the "same seed" ratios. The smart bot also takes 3★ on every level L13–L30 (incomes in `$EV/after/smart30`), which gives the GDD §9.1 income line.

**What changed** (GDD §9):
- Skill-independent income is halved: boss kill 15 + 5L, level bonus 20 + 10L.
- The level bonus is ×0.5 / ×1 / ×2 for 1★ / 2★ / 3★.
- +1.4 coins per survivor beyond 0.6·E_boss.
- Campaign kill coins during the boss fight are ×0.25, so a longer fight does not pay more.
- 3★ now needs 0.8·E_boss.
- The generator keeps the never-steering squad below 0.85·E_boss at the boss (`GATE_RULES.generation.noSteerMax`, validator column "no-steer").
- L6 introduces the x3 gate as a +A | x3 pair instead of a single.

## 4. Struggling player (decision 4)

Two failures plus one win, compared with the cheapest next rank. Source: `failecon2.mjs` on the worst bot's own runs; a failure pays ½ of the run's coins + levelBonus·1.0·fraction reached.

| L | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cheapest next rank | 120 | 150 | 150 | 170 | 200 | 200 | 210 | 250 | 280 | 330 | 390 | 490 |
| 2 fails at 50 % + win | 187 | 218 | 222 | 311 | 286 | 457 | 446 | 673 | 669 | 398* | 1189 | 1236 |

\* The worst bot did not clear L10 within 4 attempts; its four failures alone paid 1066.

Measured on actual failures:

| Bot, level | 2 fails + win | Needed |
|---|---|---|
| passive, L12 | 192 + 149 + 1038 = 1379 | 460 |
| worst, L9 | 203 + 181 + 417 = 801 | 280 |
| worst, L11 | 148 + 160 + 807 = 1115 | 390 |

With 8 attempts the worst bot clears L9 on the 3rd, L10 on the 5th, L11 on the 3rd and L12 on the 1st (`$EV/after/worst8`).

**Retry reroll and assist hint** (`hintcheck.mjs`: fresh save, passive bot, L10):

| Attempt | Seed | Result |
|---|---|---|
| 1 | 1010 | failed |
| 2 | 1110 | failed |
| 3 | 1210 | starts with +23 soldiers and hint:show `{ id: 'assist', text: 'REINFORCEMENTS: +23 SOLDIERS' }`; clears |

Before, the assist was 0.25·E_boss (+82 on L12) and it turned the passive's third L12 attempt into a 3★ run with 371 survivors.

## 5. L1 and bosses (decision 5)

- L1 is still the authored GDD §11 script on seed 1001. Its validator row is identical before and after, and L1 retries keep seed 1001. Only the economy around it changed: the level bonus formula and 3★ at 0.8.
- Boss HP keeps its squad and shop scaling: `BOSSES.squadScale` 0.6 / ×2, `shopScale` 0.75 / ×4, `hpPerE` 20 are untouched.
- Endless mini-bosses additionally get the pressure: HP and attack kills × p.

## 6. Changes (installed files, file:line)

### js/data.js (my keys only; targeted edits, re-read before each)

| Key | Lines | Change |
|---|---|---|
| `GATE_RULES.generation.noSteerMax` | 274–277 | new: 0.85 |
| `LEAK_MODEL.calibByLevel` | 382–385 | new: [[2, 0.33], [3, 0.5], [4, 0.7], [5, 1.1], [6, 0.95], [7, 1.1], [8, 1.45], [9, 1.8], [10, 0.8], [11, 0.9], [12, 1.0]] |
| `LEAK_MODEL.earlyRamp` | 386–388 | new: 0.4 |
| `WAVE_RULES.small` | 429–434 | new: { perE 0.3, min 4, heavyMinE 25, bruteAsWalkers 2, runnerPerE 0.25, runnerMin 2, keepWeight 4 } |
| `ECONOMY.bossCoins` | 726 | 30 + 10L → 15 + 5L |
| `ECONOMY.levelBonus` | 728 | 40 + 20L → 20 + 10L |
| `ECONOMY.starBonus` | 729 | [0, 0, 0.5, 1.0] → [0, −0.5, 0, 1.0] |
| `ECONOMY.failBonusFrac` | 730 | 0.5 → 1.0 |
| `ECONOMY.survivorCoins` / `survivorFrom` | 731 | new: 1.4 / 0.6 |
| `ECONOMY.bossFightKillMult` | 732 | new: 0.25 |
| `STARS.three` | 741 | 0.75 → 0.8 |
| `SCORE.endless.pressure` | 747–748 | new: true |
| `LEVELS.curve` assist and reroll | 825–830 | assistStartFrac 0.25 → 0.08; new: assistMaxSteps 4, `assistHint: n => \`REINFORCEMENTS: +${n} SOLDIERS\``, retrySeedStep 100 |
| `LEVELS.endless.waves` | 848 | {2, 1} → {2, 1, cap 3} |
| `LEVELS.endless.pop` | 849 | {6, 2, cap 36} → {10, 2, cap 16} |
| `LEVELS.endless.heavyPerD` | 850 | 0.04 → 0 |
| `LEVELS.endless.rubber` | 855 | removed the high-side keys highStepFrac, highFlipBlock, lockMult; nothing else reads them |
| `LEVELS.endless.bandPerD` | 860 | 0.015 → 0 |
| `LEVELS.endless.crowdMax` | 863 | 2 → 1 |
| `LEVELS.endless.pressure` | 870 | new: { fromD 4, perD 0.07, hpShare 1, popShare 1, gainShare 1 } |
| `LEVELS.endless` design keys | 875 | new: designMult 9, designRampD 3, liveExp 0, profileExp 0 |
| `LEVELS.endless` gate keys | 879 | new: gateEMaxD 4, gainCapFrac 0.35 |

### js/levelgen.js

| Lines | Change |
|---|---|
| 143–144 | `NO_STEER_PENALTY = 2`: attempt-score cost of a no-steer line above noSteerMax (marked DATA-MISSING `GATE_RULES.generation.noSteerPenalty`). |
| 534–537 | `waveDps` × `wc.calib`. |
| 546–553 | New `earlyCalib(progress, leak)`. |
| 561–572 | New export `levelCalib(L)`. |
| 742–770 | `chooseLane` mode 'nosteer' (centre lane, ties left, triple middle). |
| 1493–1503 | `choiceMode` / `lineHits` treat 'nosteer' as full intake. |
| 840–843 | New `introducedType`. |
| 845–904 | New `shrinkForSquad` (the `WAVE_RULES.small` rule; the keepWeight branch is at 878–892). |
| 990 | `simulate` uses calibL × the early ramp. |
| 1653 | The x3 intro becomes a +A \| x3 pair. |
| 1910, 1938 | Guards carry the level factor and the early ramp. |
| 1947 | `hooks.wave` calls `shrinkForSquad`. |
| 2064–2067 | Attempt score adds the no-steer penalty; the generator keeps trying while the best attempt's no-steer line is high. |
| 2090–2116 | `endlessParams`: eGate, waves cap, gainCap. |
| 2122 | New export `endlessPressure(D)`. |
| 2132 | New export `endlessDesignMult(D)`. |
| 2162–2310 | `generateChunk`: gates sized at `eGate` (2247). |
| 2338–2413 | `endlessGateGuard(…, gainCap)`: proportional gain cap; ÷2 \| ÷2 branch removed; the keep rule's cap includes the gain cap and caps − flips. |
| 2423–2503 | `simulateEndless`: liveExp, design multiple, pressure; preallocated `_laneGains` at 2509. |
| 2927–2936 | `validateLevel`: the no-steer line (`noSteerFinal`, warning above noSteerMax, `noSteerHigh`). |
| removed | `rubberBandAdjust`. |

### js/level.js

| Lines | Change |
|---|---|
| 22 | Imports `endlessPressure`, `endlessParams`, `endlessDesignMult`, `leakCalib`; `windowCapacity` no longer imported. |
| 230–250 | New `pressurePhases(phases, k)`: mini-boss attack kills × pressure, allocated at event time. |
| 545, 564–569 | `start()` / `_defaultSeed`: seedBase + L + retrySeedStep·failStreak; authored levels keep their own seed. |
| 672 | Game-over prefetch uses the rerolled seed. |
| 707–709 | `restart()`: RETRY after a failure rerolls; pause-menu restart and replay keep the seed. |
| 1039, 1043–1045, 1614, 1629, 1730 | Endless score terms × `_scorePressure()`. |
| 1072–1089 | `_applyRubberBand`: low side only. |
| 1182–1208 | `_guardEndlessGate`: prune `>=`; passes `endlessParams(D).gainCap`. |
| 1288–1305 | `_crowdEndlessWave`: population × pressure^popShare, ≤ ¼ of each pool. |
| 1432–1435 | `_fireBoss`: endless mini-boss HP × pressure; phases via `pressurePhases`. |
| 1477–1505 | `_liveHpMult`: endless liveExp / profileExp, designMult, pressure. |
| 1660 | `_addCoins`: campaign boss-fight kill coins × bossFightKillMult. |
| 1867–1868 | `_commitWon`: survivor surplus pays survivorCoins. |
| 1984–2006 | `_applyAssist`: 0.08·E_boss·k, k ≤ assistMaxSteps, plus `hint:show { id: 'assist', text: assistHint(n) }` on every assisted attempt. |

### tools/validate-levels.js

| Lines | Change |
|---|---|
| 181, 208, 219 | New "no-steer" column (the never-steering squad at the boss, % of E_boss). |
| 342 | Legend updated. |

The endless line now runs through `simulateEndless` with the round-3 rules.

### Docs

- `docs/GDD.md`:
  - §4.4 (≈ line 184): no-steer line and the x3 pair.
  - §6.3 (line 256): round-3 calibration (a)–(c), including keepWeight.
  - §9.1 (lines 336–351): zombie kill ×0.25 in the boss fight, boss kill 15 + 5L, level complete formula, game over, expected incomes.
  - §9.3 (line 369): 3★ at 0.8·E_boss.
  - §10 (line 377): assist 0.08·E_boss·k, the hint, retry reroll.
  - §10.1 (lines 405–418): rewritten — endless must end, pressure, waves, gate cap, low-side band, score.
- `docs/ARCHITECTURE.md`:
  - §6.16 (lines 705, 739): restart and reroll, finish formula, assist hint.
  - §6.17 (lines 750–753 and the generateChunk / endlessParams rows): new and changed exports.
  - §8.5 / §8.6 (lines 922, 935–937): ECONOMY, STARS, SCORE, LEVELS.endless, and the new curve / LEAK_MODEL / WAVE_RULES / GATE_RULES keys.

### Coding rules (ARCHITECTURE §14)

- No per-frame allocation: `pressurePhases` runs once per mini-boss event, and `_laneGains` is preallocated.
- Every new data read is guarded (`> 0` / `>= 0` / `typeof fn === 'function'`).
- No `console.log` and no `Math.random` in game code. The bot's test-only noise lives in `$EV/tools/harness.js`, not in the project.
- Files were installed atomically (tmp + verify + rename). data.js was patched in place, my keys only.

## 7. Verification

From the project root:

| Command | Result | Evidence |
|---|---|---|
| `node tools/validate-levels.js` | 30 levels · 10 warnings · 0 errors (before: 6 warnings · 0 errors) | `$EV/validate-final.txt`; before: `$EV/validate-before.txt` |
| `node tools/check-imports.js` | 0 errors, 0 warnings | `$EV/check-imports.txt` |
| `node --check js/level.js` (and `js/levelgen.js`, `js/data.js`, `tools/validate-levels.js`) | all OK | — |
| `node tools/smoke.js --scenario all --bootTimeout 90 --shots 30 --out $EV/smoke-final/all` | CLEAN: L1 3★, 258 survivors | `$EV/smoke-final/all` |
| `node tools/smoke.js --scenario play --endless --seconds 150 --shots 50 --bootTimeout 90 --pre "g.save.data.highestUnlocked=11; g.save.setUpgrade('squad',3); g.save.setUpgrade('fireRate',3); g.save.setUpgrade('damage',3)" --out $EV/smoke-final/endless` | CLEAN: 1420 m, 349 alive at 150 s | `$EV/smoke-final/endless` |
| `node tools/smoke.js --scenario play --level 7 --seconds 120 --shots 40 --bootTimeout 90 --pre "g.save.setUpgrade('squad',2); g.save.setUpgrade('fireRate',2); g.save.setUpgrade('damage',2)" --out $EV/smoke-final/l7` | CLEAN: L7 3★ | `$EV/smoke-final/l7` |

Validator warnings after:
- L1 ×4: authored waves; pre-existing.
- L6: the no-steer line is 88 % of E_boss (limit 85 %).
- Weak-shooter line below 20 % on L13 (16 %), L19 (5 %), L23 (9 %), L25 (20 %), L28 (14 %). Before, the warnings were on L15 (2 %) and L19 (9 %).

Fast runner, run from `$EV/tools`. `NOWIP=1` = installed files; adding `BASEDIR=$EV/base` = original code.

| Command | Output |
|---|---|
| `NOWIP=1 EXOUT=$EV/after/endless/ node exbatch.mjs specFinal.json --conc 4` | `$EV/after/endless/final` (+ `log.txt`). Endless: 12 seeds × smart r3, strong r3, passive r0, worst r0, smart r6. |
| `NOWIP=1 BASEDIR=$EV/base EXOUT=$EV/before2/endless/ node exbatch.mjs specBase.json --conc 4` | `$EV/before2/endless/base` |
| `NOWIP=1 node camps.mjs ../after/camp`, then `node ana.mjs ../after/camp`, `node matched.mjs ../after/camp`, `node failecon.mjs ../after/camp`, `node failecon2.mjs ../after/camp worst` | `$EV/after/camp/{ana,matched,failecon,failecon2-*}.txt`; before: `$EV/before2/camp` |
| `NOWIP=1 node lab.mjs --levels 1-6 --sets 0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11 --jitter '{"react":0.4,"dx":0.5}' --auto '<after ranks>' --out ../after/lab-final --tag default-1` (also 7-12; and `--sets 0,1,…,11` without jitter for the 12 layouts) | `$EV/after/lab-final`; before: `$EV/before2/lab` |
| `NOWIP=1 node camp.mjs --player worst --from 9 --to 12 --attempts 8 --ranks '{"squad":3,"fireRate":2,"damage":2,"coinMult":4,"bossDamage":2}' --out ../after/worst8 --tag worst8` | `$EV/after/worst8` |
| `NOWIP=1 node camp.mjs --player passive --only 12 --attempts 1 --shop none --out ../f-l12r0 --tag passive` (also smart) | `$EV/f-l12r0`; before: `$EV/before2/f-l12r0` |
| `NOWIP=1 node hintcheck.mjs` | `$EV/after/hintcheck.json` |
| `NOWIP=1 node camp.mjs --player smart --from 1 --to 30 --attempts 2 --out ../after/smart30 --tag smart30` | `$EV/after/smart30` (L1–L30 incomes) |

Other evidence:
- Endless tuning experiments: `$EV/ex/` (log in `$EV/ex/log.txt`).
- Calibration iterations: `$EV/lab/`.
- Original code: `$EV/base/js`.

## Residuals (mine, open)

- **One early wave over 35 %.** L5 seed 2005 (not canonical; retries play 1105, 1205, …): the wave right after the second gate (6 walkers, 1 spitter, 2 runners; E ≥ 25 so the spitter is allowed) costs an on-curve squad of 27 10 soldiers (37 %): 6 bites and 4 spit. All 287 other early waves over the 12 layouts are ≤ 35 %, and canonical levels are ≤ 25 %.
- **Spread across layouts.** The per-level factor is fitted on the canonical seeds. Over 12 layouts, L2 (7.3 %) and L10 (18.1 %) average below band and L5 (22.5 %) just above.
- **L13–L30 are not calibrated.** `calibByLevel` holds 1.0 from L12 on. The weak-shooter warnings listed above are on these levels. The smart bot still takes 3★ on all of L13–L30.
- **L6 no-steer line is 88 %**, above the 85 % limit; the generator keeps its best attempt. The passive bot takes 3★ on L6.
- **`NO_STEER_PENALTY`** is still a DATA-MISSING constant (`levelgen.js:143–144`).

## needsOtherGroup

1. **GDD owner (§0, §6.2, §11 are not mine):**
   - §0 resolutions table, "Stars" row: "3★ ≥ 75 % E_boss" → 80 %.
   - §11 L1 E-trace: "3★ (105 survivors)" → 112 (0.8 × 140).
   - §6.2 population rule: add the squad bound (`WAVE_RULES.small`, described in §6.3 (c)).
2. **QA:**
   - Please re-run the round-3 suites.
   - Your "strong" bot (best face value now) takes 3★ on 8–9 of L1–L12. The misses on L4, L9 and L10 are near misses at 0.76–0.79·E_boss, plus one collapse on L11. A bot that anticipates the lane's outcome takes 12/12. Either judge "strong" with anticipation or accept 2★ on those levels.
   - RETRY after a failure now rerolls the layout (seed 1000 + L + 100·fails). Scripts that expect the same layout must pass the seed explicitly.
   - Expect endless runs of 4–7 min for a strong player.
3. **Boss / enemies owner:** a mini-boss's kill time does not follow its HP. Across 63 endless mini-bosses with HP from 15k to 112k, time-to-kill ran 0–48 s, and the correlation between HP and kill time was −0.28. The Spitter Queen dies in 1.6–6.6 s even at 107k HP. So the pressure on mini-boss HP has almost no effect; the pressure on its attacks does. Please check endless boss damage taken and phase timing. Evidence: `$EV/after/endless/final/*.runs.json` (`minibosses[].maxHp`, `ttk`).
4. **Lead decision: L1 income ratio is 1.07** (smart 412 vs passive 384). A never-steering squad commits to the left lane on ties, and L1's authored left lanes are the ad's route: +5, x2, then the red −15, which the squad shoots straight into and flips to +15, then x2. With L1 kept authored this cannot reach 1.3. Options:
   - accept it as the onboarding level;
   - change the no-steer default lane (gates / input owner);
   - retune L1's lane values.
5. **docs/build/CALLSITES.md:** I regenerated it by accident; `tools/callsites.js` writes the file on every run, including when I ran it to look for a usage line. Only call-site line numbers changed. The owner should regenerate it after the final round-3 edits.
6. **UI (FYI, no action needed):** the assist hint is sent on every assisted attempt (`hint:show` id 'assist', text included). `ui.showHint` only de-duplicates while the hint is on screen or queued, so it shows on each assisted retry as intended.
