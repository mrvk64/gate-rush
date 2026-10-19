# Round 3: balance audit (independent re-measurement of r3-balance.md)

Auditor: balance audit. Date: 2026-10-09. Subject: `docs/build/r3-balance.md` (the five lead decisions) against the installed `js/level.js` (md5 e5373fb9), `js/levelgen.js` (2b6051bf) and `js/data.js` (9df4e6ea; contains other owners' later edits).
All evidence is under `E:/Temp/claude/gate-rush-evidence/r3/balance-audit/`, written as `$AU` below. No project file was changed by this audit (no fix was needed in my scope; see §7).

## Verdict

| # | Decision / claim | My measurement (different seeds) | Verdict |
|---|---|---|---|
| 1a | Strong player (lane picking, ranks 3): median death chunk 9–14, ≈ 4–7 min | Anticipating bot ("smart") 10 (6–19), 4.9 min; with human noise 9 (5–15), 4.5 min. QA's face-value bot ("strong") **7.5 (6–18), 3.7 min**; with noise 8.5 (6–18), 4.1 min | **confirmed for an anticipating player; refuted for QA's strong bot** (their seeds gave it 9.5) |
| 1b | Passive player (ranks 0): median death chunk 3–5 | 3.5 (3–6), 1.8 min | confirmed |
| 1c | Nobody passes chunk 25 (0 of 60 runs) | 0 of 12 for every ranks-0/3 configuration (96 runs). **Smart r6: 1 of 12 (chunk 26, 11.9 min); smart r10: 1 of 12 (chunk 27, 12.3 min)** — the same seed 9075 | **confirmed at ranks ≤ 3; refuted at ranks 6 and 10** (1 of 60 in their own 5 configurations) |
| 1d | Death comes from a horde: bites + spit ≈ 96 % (smart) / 90 % (QA-strong) of losses; the squad falls over a median of 4 chunks (min 3) | Bites + spit 96 % smart, 87 % QA-strong, 78 % passive (gate 20 %). Decline from peak: median 5.5 chunks (min 2) smart, 3.5 (min 1) QA-strong | confirmed for steering players; the passive player's run usually ends on a red gate (§1.3) |
| 1e | Smart r6 dies ≈ 1.5 chunks later than r3 ("the shop carries a strong player further") | Smart r0 9, r3 10, r6 10, r10 11.5 (medians) | **refuted: the shop is worth ≈ 0–1.5 chunks from rank 0 to rank 10** |
| 2a | Canonical levels: leak inside the GDD §6.3 band on all 12 (on-curve lab) | 11 of 12 inside; L9 22.3 % vs 15–22 % (0.3 above, inside their ±2 noise) | confirmed |
| 2b | 12 other layouts: L2 and L10 below band, L5 just above (their residual) | 12 new layouts (seeds 41000 + L … 52000 + L): L2 4.8 % ▼, L10 15.9 % ▼, L5 22.7 % (≈), the other 9 inside | confirmed (residual reproduced; L2 lower than they found) |
| 2c | Worst early wave ≤ 35 % (1 of 288 over, at 37 %) | Canonical: 0 of 288 over, max 25 %. 12 layouts: 1 of 288 over (36 %, L5 seed 46005, 1 walker + 1 spitter against a squad of 11) | confirmed |
| 2d | Fresh rank-0 L12: smart clears 3★; passive dies but not to the first wave | Canonical seed: identical to theirs (smart 3★, 334 at the boss; passive dies at 41 %, first two waves cost 1 and 3). Real RETRY seeds 1112 / 1212: passive dies at 41 %, then clears 2★ with +26. **6 other layouts: the 2nd wave wipes the passive squad on 2 (41012, 42012: 13 zombies incl. 2 brutes, 2 spitters, 6 runners vs 17–18 soldiers, at 19–20 % of the level)**; smart clears 5 of 6 | confirmed on the seeds a player actually gets; layout-dependent |
| 3a | Strong player 3★ on ≥ 10 of L1–L12 | Smart 11.8 avg over 5 layout sets (11–12); smart with human noise 12/12 on canonical ×3. QA-strong 9.0 (7–12); QA-strong with noise 9.3 (9–10) on canonical | confirmed with anticipation; QA's bot misses (as they reported) |
| 3b | Passive averages ≤ 2★ and fails ≥ 2 levels (first attempt) | Canonical: 1.83★, fails L9, L11, L12 (identical to theirs). 5 layout sets: 1.90★ (1.83–2.00), **first-attempt fails 1, 0, 2, 1, 1** | avg ★ confirmed; **"fails ≥ 2" holds on canonical seeds only (1 of 5 other sets)** |
| 3c | Worst bot fails most levels after L3 | 6–8 of L4–L12 first-attempt fails on every set (canonical 5) | confirmed |
| 3d | Strong income ≥ 1.3× passive on every level both clear (L1 1.07 is a known lead decision) | Canonical: identical to theirs (L2–L12 1.30–1.97). Over 5 layout sets, same-seed pairs: median ≥ 1.45 on every L2–L12, but **5 of 50 L2–L12 pairs are below 1.3** (L2 1.18; L3 1.14 and 1.298; L8 1.27; L10 1.17). L1 1.12–1.16 | confirmed on canonical; ≈ 10 % of other-layout pairs miss |
| 4a | Two fails + one win buy a rank on every level up to L12 | 39 of 39 measured (bot, layout, level) cases with a win, using the *smallest* failure payout twice. The 3 cases without a win in 4 attempts (worst bot) were paid ≥ 1 rank by their 4 failures alone | confirmed |
| 4b | A struggling player can progress | Worst bot, 10 attempts, real lock rule (no skipping): clears every level L1–L12 on canonical and 2 layout sets, never needing more than 5 attempts | confirmed |
| 4c | RETRY rerolls (1000 + L + 100·fails); assist ceil(0.08·E_boss·k); hint "REINFORCEMENTS: +N SOLDIERS" | Through the **real UI** (rAF loop, game-over screen, `#btn-retry` clicked): L10 1010 → 1110 → 1210 with +23 and the pill showing the text; L4 +14, L7 +18 in the same session (hint not swallowed by the save's hint-done flag). Escalation measured in campaigns: L10 +23 / +45 / +68 | confirmed |
| 5 | L1 authored and untouched; boss HP scaling keys untouched | Validator L1 row identical to their "before" file; `BOSSES.hpPerE` 20, `squadScale` 0.6 / ×2, `shopScale` 0.75 / ×4 unchanged | confirmed |
| — | Validator 30 levels · 10 warnings · 0 errors; check-imports clean | identical output (`$AU/validate.txt`, diff vs their validate-final.txt empty apart from timing) | confirmed |

Nothing in `level.js`, `levelgen.js` or the balance keys is clearly broken. The one clearly broken behaviour I found is in the troops / boss domain (§5): it is reported, not fixed.

## How I measured

- **Runner.** Their fast runner (headless Chrome on the GPU, engine stepped by hand at 50 ms, ≈ 250× real time) copied to `$AU/tools`. I changed it to serve **only the installed project files**: the `wip`, `BASEDIR` and `NOWIP` paths are removed, and `datapatch.mjs` serves the live `data.js` unchanged unless a run passes `--subs`. Added: `--jitter` (human noise) for campaign and endless; a death record (last loss event and a loss log) in `harness.js`.
- **Bots.** The same four (smart = anticipates the lane's outcome; strong = QA's face value; passive = never steers; worst = worst face value), plus smart J / strong J = the same with 0.4 s reaction and ±0.5 m aim noise.
- **Seeds (none of theirs).**
  - Endless: 9001 + 37·i, i = 0…11 (theirs: 4242 + 17·i).
  - Campaign: layout sets 40–44, seed 1000·(N + 1) + L, retry k plays seed + 100·k (theirs: canonical 1000 + L and sets 0–11). Canonical runs were repeated only to check reproducibility and with noise.
  - On-curve lab: 12 layouts, sets 40–51; canonical with 12 noisy repeats. Ranks per level are my own smart campaigns' modal ranks: 00000, 10010, 10021, 11121, 21131, 21132, 32232, 32243, 33343, 43353, 44354, 54454 (squad, fire, damage, coin, boss). Theirs differ by one rank on L5, L7, L11 and L12.
- **Reproducibility.** Canonical campaign runs with the bots unchanged reproduce their tables to within a few coins (smart 12/12 3★; QA-strong 9/12; passive 1.83★ with fails L9, L11, L12; worst 5 fails, L10 never cleared in 4). Endless runs are not perfectly deterministic: the same seed repeated moved the death chunk by ±1 on 3 of 12 seeds (smart, QA-strong). Passive and worst repeated exactly.

## 1. Endless (decision 1)

12 seeds each (9001 + 37·i), sim time ≤ 2400 s. Death chunk = floor(distance / 300) + 1.

| Bot (shop ranks) | Median death chunk (min–max) | Past chunk 25 | Median time | Death chunk per seed | Losses by cause |
|---|---|---|---|---|---|
| smart r3 | 10 (6–19) | 0 | 293 s (4.9 min) | 6, 17, 19, 10, 10, 10, 8, 11, 10, 9, 9, 15 | bite 66 %, spit 30 %, gate 2 % |
| smart J r3 (noise) | 9 (5–15) | 0 | 271 s | 6, 5, 6, 9, 10, 11, 8, 11, 10, 9, 8, 15 | bite 67 %, spit 28 %, gate 4 % |
| QA-strong r3 | **7.5 (6–18)** | 0 | **223 s (3.7 min)** | 6, 7, 6, 8, 17, 7, 7, 9, 8, 10, 18, 7 | bite 62 %, spit 25 %, slam 7 %, gate 4 % |
| QA-strong J r3 | 8.5 (6–18) | 0 | 248 s | 6, 6, 6, 9, 16, 7, 8, 9, 9, 10, 18, 7 | bite 62 %, spit 25 %, slam 6 % |
| passive r0 | 3.5 (3–6) | 0 | 110 s | 3, 3, 3, 6, 4, 4, 3, 4, 3, 6, 5, 3 | bite 61 %, **gate 20 %**, spit 17 % |
| worst r0 | 3 (2–12) | 0 | 85 s | 2, 2, 3, 3, 12, 3, 3, 2, 2, 4, 2, 3 | bite 55 %, spit 28 %, gate 15 % |
| smart r0 | 9 (6–16) | 0 | 250 s | | |
| QA-strong r0 | 6.5 (4–16) | 0 | 191 s | | |
| passive r3 | 5 (3–15) | 0 | 152 s | | |
| smart r6 | 10 (8–26) | **1** | 298 s | 8, 10, **26**, 10, 10, 12, 9, 12, 10, 10, 10, 16 | |
| smart r10 | 11.5 (10–27) | **1** | 341 s | 10, 19, **27**, 12, 11, 14, 11, 10, 11, 11, 24, 18 | |

### 1.1 What this says

- **Strong player.** In the 9–14 band only for the anticipating bot (10; 9 with human noise). QA's face-value bot dies at 7.5 on my seeds against 9.5 on theirs. The seed spread is wide: a few seeds produce long runs (smart: 9038, 9075, 9408; QA-strong: 9149, 9371).
- **Passive player.** 3.5, inside 3–5.
- **The shop barely moves endless.** Median death chunk is 9 / 10 / 10 / 11.5 at ranks 0 / 3 / 6 / 10 for the smart bot (6.5 → 7.5 for QA-strong from rank 0 to 3). GDD §10.1 says "the shop's fire rate × damage is what carries a strong player deeper". That is true, but only by about a chunk. This is a matter of taste, so I made no change. If the lead wants the shop to count, `LEVELS.endless.profileExp` (now 0) is the existing lever.
- **The chunk-25 ceiling holds only up to rank 3.** Seed 9075 lets the smart bot hold 500–620 soldiers from chunk 10 to 20 at ranks 6 and 10, and it dies at chunk 26–27 (≈ 12 min). That is 1 of 12 seeds; at rank 3 the same seed dies at 19. GDD §10.1's "nobody gets past chunk 25" should read "at shop ranks ≤ 3". Alternatively, the lead accepts a ≈ 1-in-12 tail of about 12 min for a near-maxed shop.

### 1.2 How runs end (steering players)

- The squad peaks and declines over 5.5 chunks (smart, minimum 2) or 3.5 chunks (QA-strong, minimum 1).
- The killing blow is a bite or spit in 23 of 24 runs; the 24th is one mini-boss stomp of 4 soldiers.
- A gate is still the biggest single loss in the last 90 s of 4 of 12 smart runs and 5 of 12 QA-strong runs: a "lesser evil" event (−A | ÷D) whose −A is sized from E(4) while the squad has already fallen far below E. For example, smart seed 9223 took −58 at C 72 (the ÷ lane would have left 24), and smart seed 9001 took ÷3 at C 128 (the other lane would have left 1).
- I read these blows as the designed red gate finishing a squad that was already declining, not as an unfair spike. The squad was already 50–70 % below its peak.

### 1.3 How runs end (passive and worst)

- A passive squad loses 20 % of its soldiers to gates.
- In 10 of 12 passive runs the largest single loss in the last 90 s is a red gate, taking 37–98 % of the squad (for example −62 at C 63, or −158 at C 237). Bites finish the run.
- This is the intended punishment for never steering, but GDD §10.1's sentence "bites and spit, not a single unfair blow" describes steering players only.

### 1.4 Endless mini-bosses

- Of 142 mini-bosses, 107 were killed. Kill time does not follow HP. Correlation between HP and kill time: Hulk −0.51, Spitter Queen −0.68, Juggernaut −0.20.
- Juggernauts at 29k–74k HP die 0–0.5 s after spawning.
- §5 gives the cause: the sniper troop, not the boss code.

## 2. Campaign leak (decision 2): on-curve lab

Mean leak (biters / spawned per wave or run-up, > 1 zombie), smart bot, squad reset to the design line after every gate pass, my ranks. ▲ = above the band, ▼ = below it.

| L | Band | Canonical, theirs | Canonical, mine (12 noisy repeats) | 12 layouts, theirs (sets 0–11) | 12 layouts, mine (sets 40–51) | Clears (mine, layouts) |
|---|---|---|---|---|---|---|
| 1 | 10–15 | 14.3 | 12.9 | 10.9 | 11.8 | 12 × 3★ |
| 2 | 10–15 | 13.3 | 13.9 | 7.3 ▼ | **4.8 ▼** (median wave 0) | 12 × 3★ |
| 3 | 10–15 | 12.9 | 13.1 | 13.2 | 13.5 | 12 × 3★ |
| 4 | 15–22 | 19.3 | 20.4 | 20.7 | 17.6 | 12 × 3★ |
| 5 | 15–22 | 14.4 | 15.5 | 22.5 | 22.7 (≈) | 12 × 3★ |
| 6 | 15–22 | 17.4 | 17.8 | 22.0 | 17.7 | 12 × 3★ |
| 7 | 15–22 | 19.0 | 20.7 | 18.1 | 18.1 | 12 × 3★ |
| 8 | 15–22 | 15.8 | 16.5 | 17.6 | 17.7 | 12 × 3★ |
| 9 | 15–22 | 21.8 | 22.3 (≈) | 17.7 | 20.3 | 12 × 3★ |
| 10 | 22–28 | 26.3 | 26.4 | 18.1 ▼ | **15.9 ▼** | 10 × 3★, 2 × 2★ |
| 11 | 22–28 | 24.8 | 23.4 | 22.2 | 26.1 | 12 × 3★ |
| 12 | 22–28 | 27.9 | 27.0 | 26.5 | 22.7 | 12 × 3★ |
| Early waves (first two) over 35 % | | 0 / 288 (max 25 %) | 0 / 288 (max 25 %) | 1 / 288 (37 %) | 1 / 288 (36 %: L5 seed 46005, 1 walker + 1 spitter vs C 11) | |

- Natural (not pinned) squads leak below the bands on most levels: smart 2.5–23.1 %, QA-strong 2.2–19.2 %, passive 2.5–28.7 % (`$AU/camp`, `campana.mjs`). A steering squad outruns the design line.
- The bands describe the on-curve squad, and they hold there.
- One off-curve case: QA-strong, layout 45008, L8, first attempt. It took the medic lane at gate 1 (face value 14 vs a +3 that the smart bot shoots to +12), met the second wave at 11 soldiers against a design E of ≈ 25 (4 walkers, 3 runners, 1 brute, 1 spitter) and was wiped at 24 % of the level. It cleared on the retry.

## 3. Stars and income (decision 3)

Stars at clear, first-attempt fails, over layout sets 40–44 (greedy shop, 4 attempts, retries rerolled):

| Bot | s40 | s41 | s42 | s43 | s44 | Mean | Canonical (repeat of theirs) |
|---|---|---|---|---|---|---|---|
| smart | 2.92 / 11×3★ / 0 | 3.00 / 12 / 0 | 3.00 / 12 / 0 | 3.00 / 12 / 0 | 3.00 / 12 / 0 | 2.98, 3★ 11.8 | 3.00 / 12 / 0 |
| QA-strong | 2.83 / 10 / 0 | 2.58 / 7 / 0 | 3.00 / 12 / 0 | 2.50 / 7 / 1 (L7) | 2.75 / 9 / 1 (L8) | 2.73, 3★ 9.0 | 2.67 / 9 / 0 |
| passive | 1.92 / 2 / 1 (L9) | 1.83 / 3 / **0** | 2.00 / 4 / 2 (L6, L11) | 1.83 / 2 / 1 (L12) | 1.92 / 2 / 1 (L6) | 1.90, 3★ 2.6, fails 1.0 | 1.83 / 2 / 3 (L9, L11, L12) |
| worst | 1.17 / 0 / 7 | 1.25 / 0 / 7 | 1.33 / 1 / 6 | 1.25 / 0 / 6 | 1.17 / 0 / 8 | 1.23, fails 6.8 | 1.17 / 0 / 5 |

Noise variants on the canonical seeds (3 runs each): smart J 12, 12, 12 3★; QA-strong J 9, 10, 9 3★. Its misses are L9 / L10 at 0.64–0.78·E_boss (near misses), plus one L11 collapse to 1★: its face value picks the item lane over a + lane the smart bot shoots to +140, then a ÷2 the smart bot shoots to ÷1.

Passive 3★ on L6 (the level whose no-steer line is 88 % against the 85 % limit): canonical yes, layouts 2 of 5 (s43, and s44 after an assisted retry).

Income from the clearing run, smart / passive. These are same-seed pairs (both cleared on the same attempt), except where marked ~.

| L | Canonical (mine; theirs) | Layout sets 40–44 | Median | Min |
|---|---|---|---|---|
| 1 | 1.07 (1.07) | 1.16, 1.16, 1.18, 1.12, 1.14 | 1.16 | 1.12 |
| 2 | 1.87 (1.88) | 1.87, 1.44, **1.18**, 1.89, 1.84 | 1.84 | 1.18 |
| 3 | 1.83 (1.86) | 1.30, 1.73, **1.14**, 1.50, 1.45 | 1.45 | 1.14 |
| 4 | 1.88 | 1.60, 1.92, 1.53, 1.74, 1.64 | 1.64 | 1.53 |
| 5 | 1.69 | 1.79, 1.56, 1.93, 1.68, 1.88 | 1.79 | 1.56 |
| 6 | 1.33 | 1.91, 1.73, 2.08~, 1.35, 1.27~ | 1.73 | 1.27~ |
| 7 | 1.60 | 2.45, 2.30, 1.73, 2.09, 1.72 | 2.09 | 1.72 |
| 8 | 1.54 | **1.27**, 1.30, 1.58, 1.60, 1.69 | 1.58 | 1.27 |
| 9 | 1.62~ | 1.55~, 2.01, 2.02, 1.93, 1.74 | 1.93 | 1.55 |
| 10 | 1.57 | 1.73, 1.58, **1.17**, 1.53, 1.69 | 1.58 | 1.17 |
| 11 | 1.97~ | 1.41, 1.63, 1.56~, 1.52, 1.77 | 1.56 | 1.41 |
| 12 | 1.30~ | 1.36, 1.69, 1.54, 1.60~, 1.50 | 1.54 | 1.36 |

GDD §9.1 expected first-clear incomes (L1 ≈ 410, L5 ≈ 480, L10 ≈ 880, L12 ≈ 1340). Mine, from the smart bot on 5 sets: L1 424–443, L5 410–481, L10 938–1175, L12 1273–1537. Consistent.

## 4. Struggling player (decision 4)

- **Two failures plus one win, against the cheapest next rank.** I used the smallest failure payout twice plus the win's payout, on every (bot, set, level) with a failure (`failecon.mjs`). 39 of 39 cases with a win pass, with margins of 1.3–3.3×. Examples:
  - worst-s44 L5: 72 + 72 + 187 = 331 ≥ 200.
  - worst-s44 L8: 28 + 28 + 395 = 451 ≥ 280.
  - QA-strong-s44 L8: 27 + 27 + 388 = 442 ≥ 330. The 27-coin failure is the 24 % wipe in §2.

  Three cases had no win within 4 attempts (worst-def L10, worst-s40 L7, worst-s43 L7). Their 4 failures paid 1068, 640 and 627.
- **Progress with retries** (`$AU/camp10`, worst bot, 10 attempts, stops at the first level it cannot clear):

  | Run | Attempts per level (L1→L12) | Most attempts | Assist on that level |
  |---|---|---|---|
  | Canonical | 1, 1, 1, 2, 1, 1, 2, 1, 3, 5, 3, 1 | 5 (L10) | +68 |
  | s40 | 1, 1, 1, 1, 3, 4, 1, 1, 1, 4, 4, 1 | 4 | |
  | s43 | 1, 1, 1, 4, 1, 1, 5, 4, 3, 1, 3, 2 | 5 (L7) | +53 |
- **Real-UI fail-assist path** (`$AU/assist`, `assistui.mjs`, the normal rAF loop with ui.update live, the squad forced to 0 mid-level, `#btn-retry` clicked on the visible game-over screen):

  | Level | Attempt seeds | Fail streak per attempt | Start count, attempt 3 | Hint pill, attempt 3 |
  |---|---|---|---|---|
  | L10 | 1010, 1110, 1210 | 0, 1, 2 | 5 + 23 | "REINFORCEMENTS: +23 SOLDIERS" |
  | L4 (same session) | | | +14 | shown |
  | L7 (same session) | | | +18 | shown |

  So the hint is not swallowed after its first display. Screenshots: `$AU/assist/L7-attempt3-hint.png` and the others. No page errors.

## 5. Found while auditing: the sniper one-shots endless mini-bosses (troops / boss domain, not fixed)

- `bossprobe.mjs` (seed 9075, smart r6) logs every `boss:hit` with its call stack:
  - Juggernaut, 66 800 HP: dies 0.48 s after spawning; one hit of 63 697 (95 % of its HP).
  - Spitter Queen, 112 400 HP: one hit of 104 242 at 1.57 s.
  - Hulk, 143 600 HP: one hit of 135 576 at 2.43 s.
- All three hits come from `troops.js:651`, `_stepSniper`. Its boss shot is `TROOPS.sniper.dmg · level.waveHz() · d · bossMult` = 40·hz·d·0.5.
- **Root cause: a round-3 interaction.**
  - Endless wave hz now carries the design multiple (×9) and the pressure. Wave hz is 750 at chunk 5, 1 900 at chunk 10 and 4 000 at chunk 15. Walkers have 1.6k–25k HP.
  - The mini-boss HP (30·E × scales × p) carries neither. One sniper shot is therefore 110 % (chunk 5), 165 % (chunk 10) and 418 % (chunk 15) of a mini-boss's HP.
  - Troops persist for the whole endless run, so every mini-boss after the first sniper crate dies this way, before most of its (pressure-scaled) attacks fire.
  - In the campaign the sniper exists only on the level that hands it out. The probe shows 1 shot of 28 % on L5 and none on L6–L12. Campaign boss kill times are 8–20 s.
- **Experiment, data substitution in the runner only.** I set `TROOPS.sniper.bossMult` 0.5 → 0.02:
  - Mini-boss kill time becomes 5–17 s.
  - The endless death distribution is unchanged: smart r3 9.5 (6–19), QA-strong r3 7.5 (6–16) (`$AU/endless-nosnipe`).

  So fixing it does not move decision 1.
- **Suggested fix (troops owner):** cap the sniper's boss shot at a fraction of the boss's max HP, for example ≤ 5 % per shot, or key it to `weapons.squadDps()` instead of the wave hz. A lower `bossMult` alone would also weaken the campaign L5 shot.

## 6. Smaller observations

- **L2 on rerolled layouts is very easy.** On-curve leak is 4.8 % (median wave 0 %) because `calibByLevel` L2 = 0.33 is fitted on the canonical seed 1002. Every L2 retry plays a rerolled layout, so a player who fails L2 gets an easier one. This is acceptable for an early level.
- **The passive "fails ≥ 2 levels" target** depends on the layout. It holds on the canonical seeds, which every first attempt plays, and not on 4 of 5 other sets.
- **Fresh rank-0 L12 on other layouts.** On 41012 and 42012 the second wave is designed for E ≈ 40 (the design line shoots the gates), so a never-steering squad of 17 is wiped. The real retry seeds (1112, 1212) do not show this. A rank-0 passive player on L12 is hypothetical anyway.
- **Endless determinism.** The same seed and bot repeated moved the death chunk by ±1 on 3 of 12 seeds for steering bots (the fast runner steps the engine identically). Some gameplay path reads a real-time clock. This does not affect the verdicts. Repeated runs: `$AU/endless` vs `$AU/endless2`.

## 7. Changes

None to `js/` or `docs/GDD.md` / `docs/ARCHITECTURE.md`. Nothing in my scope is clearly broken. The refuted items (QA-strong endless 7.5, the shop's small endless effect, the chunk-25 tail at ranks 6–10, the layout-dependent passive targets) are tuning choices for the lead, and §5 is in another owner's file.

## needsOtherGroup

1. **Troops / boss owner:** the endless sniper one-shot (§5), with evidence in `$AU/tools/bossprobe.mjs` (stack-traced hits) and `$AU/endless-nosnipe`.
2. **Lead (decision 1 wording):**
   - Accept, or tune, that QA's face-value strong bot dies at a median 7.5 (3.7 min) on these seeds. The anticipating bot dies at 10.
   - Accept, or tune, that the shop moves endless death by only ≈ 1 chunk from rank 0 to rank 10. The lever is `LEVELS.endless.profileExp` (now 0).
   - Rank 6–10 runs can pass chunk 25 (1 in 12, ≈ 12 min). If they must not, the lever is `LEVELS.endless.pressure.perD` or a profile term in the pressure.
3. **GDD owner (§10.1 text, owned by the balance owner):**
   - "nobody gets past chunk 25" → add "at shop ranks ≤ 3".
   - "bites and spit, not a single unfair blow" → add "for a steering player; a never-steering squad usually ends on a red gate".
4. **Balance owner:** the residuals stand as reported. L2 on non-canonical layouts is lower than they measured (4.8 % against 7.3 %).

## Reproduce (from `$AU/tools`)

| Command | Output |
|---|---|
| `./endbatch.sh` (11 endless configurations × seeds 9001 + 37·i), then `node endana.mjs ../endless` | `$AU/endless` |
| `./campbatch.sh` then `./rerun.sh` (4 bots × sets 40–44, canonical bots and noise variants), then `node campana.mjs ../camp s40,s41,s42,s43,s44`, `node campana.mjs ../camp def`, `node campana.mjs ../camp def1,def2,def3 smartJ,strongJ` | `$AU/camp` |
| `node failecon.mjs ../camp`; worst bot with 10 attempts: `node camp.mjs --player worst --seeds 40 --reroll 1 --attempts 10 --continue 0 --out ../camp10 --tag worst-s40` (also `--seeds 43`, and canonical with `--reroll 0`) | `$AU/camp10` |
| `./labbatch.sh` (on-curve lab, layouts 40–51 and canonical ×12 with noise); early waves from `lay-*.json` / `can-*.json` | `$AU/lab` |
| `node camp.mjs --player passive\|smart --only 12 --attempts 1 --shop none [--seeds 40…45]`; real retry chain: `--attempts 4 --reroll 0` | `$AU/l12r0` |
| `node assistui.mjs 10` and `node assistui.mjs 4,7` | `$AU/assist` |
| `node bossprobe.mjs 9075`, `node bossprobe2.mjs def\|40`, sniper experiment `node endless.mjs … --subs '[["every: 1.5, dmg: 40, bossMult: 0.5,","every: 1.5, dmg: 40, bossMult: 0.02,"]]'` | `$AU/endless-nosnipe` |
| From the project root: `node tools/validate-levels.js > $AU/validate.txt`, `node tools/check-imports.js` | 30 levels · 10 warnings · 0 errors; 0 / 0 |
