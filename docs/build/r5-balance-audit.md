# Round 5: balance audit (L13–L30), independent re-measurement of r5-level-balance.md

Auditor: balance audit. Date: 2026-10-10.

**Subject.** The calibration claims in `docs/build/r5-level-balance.md` §2, checked against the installed tree:
- `js/level.js` md5 3e27a93e. Integrate added request-start and the boss warm-up after the level owner's c4b2ebe9. No balance effect: the canonical runs reproduce the owner's numbers (§1).
- `js/levelgen.js` d00d5f26, the same file the owner installed.
- `js/data.js` e4abbca9. The balance keys are byte-identical to the owner's. Every other diff since the handover is render or audio data.

**Evidence.** Everything is under `E:/Temp/claude/gate-rush-evidence/r5/balance-audit/`, written `$AU` below.

**Changes.** The only project changes are corrections to three comments or doc lines (§4). No balance value changed. I found no clear defect that a targeted level, levelgen or data change would fix without a trade-off the lead has to make (§6).

## Verdict

| # | Claim (r5-level-balance) | My measurement (different seeds) | Verdict |
|---|---|---|---|
| 2a | L13–L30 leak inside the GDD §6.3 band, on-curve, realistic ranks | **Pooled per level** (the owner's 12 runs plus my 11–19): every level is within ±0.2 points of its band. Two levels sit at the edge: L20 32.2 ± 0.9 and L24 27.9 ± 1.6. **My own 11 layouts alone**: 7 of 18 levels fall outside the band by 0.5–2.4 points: L17 19.6 ▼, and L20, L23, L27, L28 and L30 at 32.5–33.5 ▲. **The canonical layout alone** (seed 1000 + L, the first one every player meets): out of band on L23 (25.0 ▼), L24 (36.5 ▲), L30 (26.0 ▼), marginal on L16 (21.8) and L29 (32.8) | **confirmed for the per-level mean**; the per-layout spread (SD 3.4–7.1 points within a level) is larger than the band. See §2 |
| 2a′ | The ranks used are realistic | My smart campaigns own the owner's ranks to within one rank. QA-strong (face value) owns about one rank fewer in two slots. At those ranks, leak is +0 to +3 points (L20 34.0, L23 33.9, L27 34.7, L30 33.8) | confirmed; the band is set for the greedy-smart player |
| 2b | No early wave wipes more than 35 % of an on-curve squad (lab max 32 %) | Lab: 1 of 632 first-two waves above 35 %: 37 % on L21 fresh layout 30021, where 1 brute, 1 spitter and 2 runners met 27 soldiers and cost 10; that run still cleared 3★. Every other wave ≤ 31 % (L19); 95th percentile ≤ 26 % on every level. Natural campaigns L13–L30: smart ≤ 17.8 %, QA-strong ≤ 16 %, passive ≤ 20 %, worst ≤ 23.8 % (0 of 822 waves above 35 %) | confirmed (round 3 saw the same 1-in-several-hundred at 37 %) |
| 2c | Boss TTK 12–25 s at E_boss with realistic ranks (12.9–20.3 s per-level medians) | Medians 13.2–20.1 s on L13–L30. Run range 9.4–21.8 s. C/E_boss median 0.97–1.08 | confirmed |
| 2d-1 | Smart 3★ 18/18 | 53 of 54 (3 campaigns; one 2★ on L13) | confirmed |
| 2d-2 | QA-strong 3★ 13/18, 1 first-attempt fail | 13–15 of 18, average 2.72–2.83★, 0–1 first-attempt fails (4 campaigns) | confirmed |
| 2d-3 | Passive 1.72★; first-attempt fails on 11 of 18; **every level cleared within 3 attempts** | 1.67–1.89★; first-attempt fails on 10, 12 and 11 of 18. **L23 needs 4 attempts on the canonical seeds** (F58 / F42 / F70 / 2★). The owner's own table shows the same (L23: F57 / F43 / F70 / 2★) | stars and fails confirmed; **"within 3 attempts" refuted** (4; a report error) |
| 2d-4 | Worst bot needs a 5th or 6th attempt on L21, L22, L25, L26 | With a budget of 6 attempts, all 3 campaigns clear every level L13–L30 within 5 attempts. 5 attempts on L15, L21 (×3), L22 and L25 | confirmed |
| C1 | L12 → L13 continuity (not claimed; my task) | No cliff. On-curve leak eases from L12 29.3 to L13 25.0. Smart stays 3★; QA-strong drops from 3★ to 2★ on L13–L14 in 3 of 4 campaigns (C/E_boss 0.75–0.86). Passive and worst attempts are unchanged. Smart income dips about 10 % (L12 1 323–1 483 → L13 1 137–1 300) and recovers at L14 | OK (one soft step, §3) |
| C2 | L30 → L31 loop (GDD §10: L30 curve, seed 1000 + L) | Works: L31–L38 generate, play and pay. Smart and QA-strong 3★ on L31–L32 in every campaign. **But L31's canonical layout leaks 43.8 % on curve** (5 runs, 42.9–45.6; band 28–32), the highest of any layout I measured. L32–L38 canonical: 24.6–36.6 % | works; L31 is a layout outlier (§3, needsOtherGroup 2) |
| 2e | Validator 30 levels · 7 warnings · 0 errors | Identical output apart from generation times (`$AU/validate-after.txt`) | confirmed |
| new | GDD §7 / ARCH comments: "TTK still falls strictly with C and with m" | **Refuted below E_boss at high ranks.** Controlled test: same ranks, the squad set to a fraction of E_boss just before the boss spawns. L28 at 9·8·8·10·9: 11.5 s at 0.45·E, 16.0 s at 0.8·E, 15.1 s at E. L25: flat (14.4–15.6 s from 0.3·E to 1.3·E) | refuted; documented, lead decision (§4) |

## 1. How I measured

**Runner and lab.**
- The owner's fast runner (headless Chrome, engine stepped at 50 ms, about 250× real time) is copied to `$AU/tools`, with output paths moved to `$AU`.
- It serves the installed files only; no data substitution was used.
- The lab script gained `--offs`: seed = 1000 + L + off, so the game's own RETRY layouts (+100·k) can be measured.
- `labpool.cjs` pools runs per level.
- `bossfrac.mjs` is the controlled TTK-versus-C test.

**Seeds (none of the owner's).**

| Measurement | Seeds |
|---|---|
| Lab, per level | Canonical ×2 with noise; RETRY layouts 1100 / 1200 / 1300 + L; 6 fresh layouts 21000 … 26000 + L. On L12, L13, L17, L21 and L30 also RETRY 1400–1600 + L and fresh 27000–30000 + L. All with human noise (0.4 s reaction, ±0.5 m aim) |
| Ranks | The owner's table (`ranks.json`), plus a second table taken from my QA-strong campaign (`ranks-strong.json`) |
| Campaigns, L1 → L32 | 6 attempts each; the game's own RETRY seeds |

**Reproducibility.** The canonical runs reproduce the owner's figures to within about 2 points per level (§2 table, "canonical" column against their final-a / final-b). The campaigns are not bit-reproducible: my canonical passive and worst runs drift from theirs by a soldier or two from L1 / L4 on.

**Campaign runs** (`$AU/camp/*.rows.json`; summary with `node $AU/tools/campsum2.cjs $AU/camp 13 30`):

| Bot | Runs |
|---|---|
| smart | ×2 with noise (`smartJ1`, `smartJ2`), and layout set 70 (`smart-s70`) |
| QA-strong | ×3 with noise (`strongJ1`–`strongJ3`), and layout set 70 (`strong-s70`) |
| passive | canonical (`passive-def`), and layout sets 70 and 71 |
| worst | canonical (`worst-def`), and layout sets 70 and 71 |

## 2. Leak, early waves and boss TTK (on-curve lab)

Leak is the mean over waves and run-ups of biters ÷ spawned; the squad is pinned to E after every gate pass, with the smart bot plus noise.

| L | Band | Mine, owner ranks: mean (run range) | Mine, QA-strong ranks | Canonical (owner + mine) | Pooled, owner + mine (± s.e.) | Early-wave max (%) | Boss TTK median [range] (s) |
|---|---|---|---|---|---|---|---|
| 13 | 22–28 | 25.3 (18.1–32) | 22.2 | 23.7 | 25.0 ± 0.7 | 24 | 14.6 [13.4–17.1] |
| 14 | 22–28 | 23.6 (16.8–28.8) | 28.4 | 25.1 | 24.1 ± 0.9 | 26 | 14.0 [9.5–15.6] |
| 15 | 22–28 | 27.0 (20.6–33.5) | 26.6 | 25.4 | 27.3 ± 1.3 | 21 | 18.3 [14.8–21.8] |
| 16 | 22–28 | 23.8 (16.9–29.2) | 24.8 | 21.8 | 23.9 ± 1.0 | 25 | 13.9 [11.2–16.2] |
| 17 | 22–28 | **19.6** (15.7–27.3) | 22.5 | 25.6 | 22.1 ± 0.7 | 22 | 14.5 [11.4–16.7] |
| 18 | 22–28 | 26.8 (14.7–33) | 26.3 | 27.1 | 25.9 ± 1.1 | 25 | 13.8 [9.6–15.2] |
| 19 | 22–28 | 25.9 (20–30.8) | 28.6 | 24.4 | 25.3 ± 1.1 | 31 | 13.8 [9.4–16.4] |
| 20 | 28–32 | **33.5** (29.4–39.6) | 34.0 | 29.7 | 32.2 ± 0.9 | 25 | 20.1 [15.5–21] |
| 21 | 28–32 | 29.0 (20.9–36) | 29.0 | 28.3 | 29.4 ± 0.9 | 21 | 13.2 [10.9–15.4] |
| 22 | 28–32 | 31.4 (23.9–37.9) | 30.5 | 31.0 | 30.5 ± 1.0 | 25 | 13.2 [10.5–15.5] |
| 23 | 28–32 | **32.5** (23.8–37) | 33.9 | **25.0** | 30.7 ± 1.1 | 24 | 13.2 [10.7–15.6] |
| 24 | 28–32 | 26.1 (7–38.3) | 32.9 | **36.5** | 27.9 ± 1.6 | 21 | 13.8 [11–17.4] |
| 25 | 28–32 | 30.4 (24.4–36.3) | 31.5 | 31.2 | 30.2 ± 0.6 | 22 | 18.5 [15.4–19.8] |
| 26 | 28–32 | 28.4 (20.9–32.5) | 29.5 | 30.4 | 29.0 ± 0.7 | 21 | 13.4 [9.5–14.8] |
| 27 | 28–32 | **33.1** (28.2–37.7) | 34.7 | 30.3 | 31.7 ± 1.1 | 21 | 13.6 [11.1–20.1] |
| 28 | 28–32 | **33.3** (29.3–38.6) | 32.8 | 29.6 | 31.0 ± 0.9 | 25 | 15.0 [9.6–18.1] |
| 29 | 28–32 | 29.5 (17.1–39.4) | 30.3 | 32.8 | 30.2 ± 1.3 | 23 | 14.6 [11.6–16] |
| 30 | 28–32 | **33.1** (22.8–41.5) | 33.8 | **26.0** | 31.5 ± 0.9 | 30 | 17.3 [15.4–19.5] |

Sources: `$AU/lab/{retry,lay}-*.json`, `more*.json` and `strk-*.json`; `$AU/lab-pooled-owner-ranks.json`, `lab-pooled-strong-ranks.json` and `pooled-leak.txt`. Every lab run cleared the level, with 3★ or occasionally 2★.

**What the numbers say.**
- **The per-level factor does its job on the mean.** Pooled over 23–31 runs, every L13–L30 level is inside its band or within one standard error of it.
- **The layout spread is larger than the band.** Within a level, the run means of different layouts have an SD of 3.4–7.1 points, so 9–12 layouts move a level's mean by about ±2.
  - L17 is the clearest case. Its canonical layout is at 25.6; its 25 other layouts average 21.2, and the game's RETRY layouts 1117 / 1217 / 1317 are at 15.8–17.9.
  - L24 is the reverse. Canonical is 36.5 (5 runs, 35.7–37.8); the other 18 layouts average 25.4.
- The owner fitted the factor with the canonical layout counted 3 times in 12 runs. A single per-level factor cannot hold every layout in a 4–6-point band: it moves all of them together.
- Round 3 measured the same property on L2 and L10 (r3-balance-audit 2b).
- Raising the L17 factor would push its canonical layout toward 28; lowering L24's would make its other layouts too easy. **I changed neither.**

## 3. Campaigns and continuity

Stars per run (L12–L32). `a:s` means a clear at attempt a with s stars; no prefix means a first-attempt clear. Sources: `$AU/camp/*.rows.json`.

| L | smart (3 runs) | QA-strong (4) | passive (3) | worst (3) |
|---|---|---|---|---|
| 12 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 3:2 · 3:3 · 2 | 1 · 3:1 · 3:1 |
| 13 | 3 · 2 · 3 | 2 · 2 · 2 · 3 | 1 · 2:2 · 1 | 3:1 · 1 · 4:1 |
| 14 | 3 · 3 · 3 | 3 · 2 · 2 · 3 | 1 · 3:1 · 1 | 3:2 · 4:1 · 3:2 |
| 15 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 3 · 3:2 · 2 | 1 · 5:1 · 4:1 |
| 16 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 2 · 2 · 2 | 1 · 4:1 · 1 |
| 17 | 3 · 3 · 3 | 2 · 3 · 2 · 3 | 3:2 · 2 · 2 | 4:2 · 1 · 3:1 |
| 18 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 1 · 2:1 · 2 | 4:1 · 3:1 · 1 |
| 19 | 3 · 3 · 3 | 2 · 3 · 3 · 3 | 2:1 · 2:2 · 2:1 | 4:2 · 3:1 · 3:1 |
| 20 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 1 · 3:1 · 3:2 | 3:1 · 4:2 · 3:2 |
| 21 | 3 · 3 · 3 | 3 · 3 · 2 · 3 | 3:3 · 2:1 · 3:2 | 5:1 · 5:1 · 5:1 |
| 22 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 3:2 · 2 · 3:2 | 5:2 · 4:1 · 3:1 |
| 23 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 4:2 · 2 · 3:1 | 4:1 · 1 · 4:1 |
| 24 | 3 · 3 · 3 | 2 · 3 · 2 · 3 | 3:2 · 2:3 · 3:2 | 4:1 · 2:1 · 4:1 |
| 25 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 2 · 2 · 3:2 | 5:1 · 4:1 · 3:2 |
| 26 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 1 · 2:2 · 1 | 3:1 · 2:1 · 3:1 |
| 27 | 3 · 3 · 3 | 3 · 3 · 3 · 2:2 | 2:1 · 3:2 · 2:2 | 4:1 · 4:1 · 3:2 |
| 28 | 3 · 3 · 3 | 3 · 2 · 3 · 2 | 3:3 · 3:3 · 3:1 | 3:1 · 3:1 · 3:1 |
| 29 | 3 · 3 · 3 | 3 · 3 · 3 · 2 | 3:2 · 2 · 2:1 | 4:1 · 1 · 4:1 |
| 30 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 2:1 · 3:2 · 3:3 | 4:1 · 3:1 · 3:1 |
| 31 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 3:3 · 3:1 · 2 | 3:1 · 6:1 · 3:1 |
| 32 | 3 · 3 · 3 | 3 · 3 · 3 · 3 | 3 · 2:1 · 3:2 | 1 · 4:2 · 3:2 |

**Summary over L13–L30.**

| Bot | Average ★ | 3★ | First-attempt fails | Most attempts | Payout of a clearing run |
|---|---|---|---|---|---|
| smart | 2.94–3.00 | — | 0 | 1 | 1 137–3 672 |
| QA-strong | 2.72–2.83 | 13–15 | 0–1 | 2 | 1 025–3 672 |
| passive | 1.67–1.89 | — | 10–12 | 4 (L23) | 899–3 710 |
| worst | 1.06–1.22 | 0 | 14–16 | 5 | 825–2 851 |

Payouts of failed runs: passive 178–1 012, worst 110–1 262. No campaign page error (0 in all 13).

**Boss TTK in natural play.** In L20–L30 clears from all bots (143), the median per C/E_boss bin stays at 11.6–17 s: 0.45–0.6 → 11.6 s, 0.9–1.0 → 13.8 s, above 1.3 → 14.3 s. 4 of 143 fights are under 8 s: worst-def L27 5.1 s at C/E 0.42, worst-s71 L27 5.9 s at 0.65, smart-s70 L26 6.6 s at 1.38, and strong-s70 L26 7.1 s at 1.04.

**L12 → L13.**
- No difficulty cliff; on curve L13 is easier than L12.
- L12, a round-3 level, leaks 29.3 % pooled (canonical 27.3; RETRY layouts 26.8–33.9). That is 1.3 above its band, a round-3 residual outside my scope.
- L13 leaks 25.0 %. The step that does show: the face-value player arrives at L13 and L14 bosses at 0.74–0.86·E_boss and takes 2★ (3★ on L12).
  - This is the "steering matters" layout effect the validator warns about on L13 (weak line 16 %).
  - Passive clears L13 at once on 2 of 3 runs.
- The economy is continuous: smart income dips about 10 % at L13 and is above L12's by L14.

**L30 → L31 (loop).**
- `start(31)` uses the L30 curve and calibration with seed 1031. District 1 is lit again (owner's probe).
- Every bot cleared L31 and L32 (worst within 6).
- At max ranks, on-curve TTK is 17–19.5 s on L31–L35 and 12.8–17.7 s on L34–L38. The milestone-sized boss holds L30's 15 000 HP table, because the loop uses L30's curve.
- **L31's canonical layout is an outlier: 43.8 % leak** (`$AU/lab/loop-31-38.json`, 5 runs at 42.9–45.6, every run 3★). From the third wave on, it carries 12 of the 14 waves at the 24-zombie cap (mostly 8 walkers, 4 brutes, 4 spitters, 8 runners) against C 82–638, letting 6–16 biters through each (median 12), where the same-sized waves of L30 canonical let 0–15 through (median 4).
- L32–L38 canonical are 31.2, 29.6, 33.4, 32.0, 28.4, 24.6 and 36.6 %: the L30 curve's ordinary layout spread.
- The practical cost is small: the squad at the boss is still on curve and the bots' stars are unchanged. But it is the first level a finishing player meets after L30.

## 4. Boss TTK against the arriving count (the GDD §7 monotonicity claim)

**The claim.** `_bossHpScale` multiplies the table HP by countScale · shopScale, with shopScale = clamp(m^(0.9·min(1, C/E)), 1, 10). The code comment, the data.js comment and GDD §7 said TTK "still falls strictly with C and with m".

**Analysis.** For C below E_boss, TTK ∝ HP / (C·m) ∝ m^(0.9·c − 1) / c with c = C/E. Its derivative in c is positive once c > 1 / (0.9·ln m):
- about 0.44 at rank 10 (m = 12.5);
- about 0.50 for ranks 9·8·8·10·9 (m = 9.3);
- the same algebra at round 4's exponent 0.75 gives 0.53. There the ×4 cap flattened the rise before c = 0.73.

**Controlled test** (`$AU/bossfrac/*.json`; smart bot plus noise, pinned on curve, the squad set to frac·E_boss just before the boss event; 3 runs each, canonical ×2 and RETRY 1):

| Level, ranks | 0.3·E | 0.45·E | 0.6·E | 0.8·E | 1.0·E | 1.3·E |
|---|---|---|---|---|---|---|
| L28, 9·8·8·10·9 | 13.6 s | **11.5 s** | 14.3 s | 16.0 s | 15.1 s | 14.0 s |
| L25, 9·8·8·10·9 | 15.6 | 14.9 | 14.4 | 14.8 | 15.2 | 14.8 |
| L20, 6·5·5·7·5 | 29.0 | 24.7 | 21.5 | 21.2 | 22.0 | 19.9 |
| L15, 6·5·5·7·5 | 27.5 | 20.9 | 19.3 | 19.9 | 20.0 | 17.1 |

**Result.**
- At high ranks the fight is flat in C below E_boss.
- On L28 a squad at 0.45·E kills the boss 24 % faster than one at E. The theatre (immunity, shield, minions, the 5 % shot cap) mutes the formula's predicted 1.57×.
- The stars still reward the bigger squad: 1★ at 0.3–0.45, 2★ at 0.6–0.8, 3★ at 1.0+.
- The fade exists on purpose (level.js: the bad bot at 0.3·E with rank-2 upgrades "was chewed by the safety valve").
- A strictly monotone form is possible. For example, shopScale = 1 + (S − 1)·min(1, C/E) with S = clamp(m^0.9, 1, 10) keeps every fight at C ≥ E unchanged. But it lengthens below-curve fights: on paper, 1.3× T_E at 0.3·E, and up to 2× at 0.12·E against 0.8–1.4× today. That makes the boss harder for exactly the players needsOtherGroup 3 of the owner's report asks the lead about.

**What I changed (documentation of the as-built behaviour, no balance value):**
- `js/level.js` `_bossHpScale` doc comment (lines 1743–1745).
- `js/data.js` BOSSES comment (lines 481–482).
- GDD §7: "TTK falls strictly with m, and with C from E_boss up; below E_boss … flat or slightly rising … lead decision pending".

`node --check` passes on both JS files. `tools/check-imports.js` reports 0 / 0.

## 5. Other claims checked

- **Early waves (2b): confirmed.**
  - Lab, 632 first-two waves at owner and QA-strong ranks: one above 35 % (37 %, L21 seed 30021, wave 2: 8 zombies, among them a brute and a spitter, against 27 soldiers); every other wave ≤ 31 %.
  - Campaigns: 822 L13–L30 first-two waves across the 13 runs, max 23.8 % (the worst bot), none above 35 %.
- **Boss TTK at E_boss (2c): confirmed.**
  - Per-level medians on L13–L30: 13.2–20.1 s at owner ranks and 13.2–20.7 s at QA-strong ranks.
  - The longest are the milestone levels: L15 18.3, L20 20.1, L25 18.5, L30 17.3.
  - L12 is 12.2 s.
- **Validator (2e):** 30 levels · 7 warnings · 0 errors, the same as the owner's `validate-after.txt` apart from generation times.
- **No tree drift:** the balance keys in `data.js` (calibByLevel, shopScale, generator keys) are byte-identical to the owner's report. The canonical lab reproduces their canonical leak to within about 2 points per level.

## 6. Why no balance value changed

Every miss I measured is one of two kinds:
- **(a)** layout-to-layout spread inside a level, which the per-level `calibByLevel` factor cannot address without moving the other layouts out of band (L17, L23, L24, L30, L31);
- **(b)** a design trade-off already open with the lead (the passive fail rate; the boss-damage upgrade's value; the TTK fade in §4).

Each pooled level mean is in band within its standard error. Early waves and boss TTK hold everywhere.

## needsOtherGroup

1. **Level / generator owner: the per-layout leak spread.**
   - Within a level the layouts' leak SD is 3.4–7.1 points against a 4–6-point band. The canonical layout, the first one every player plays, is at 36.5 % on L24 (band 28–32), 25.0 % on L23 and 26.0 % on L30. L17's RETRY layouts sit at 15.8–17.9 % (band 22–28).
   - A root fix is in the generator's leak solve, the per-wave model error on a given layout, not in `calibByLevel`.
   - Before it, a cheaper option: the generator already makes 24–32 attempts per level. It could score each attempt's predicted-versus-band leak error, but its prediction is the very model that is off here.
2. **Lead: L31 (the first looped level) canonical leaks 43.8 %**, the highest of any layout measured. Options:
   - accept it (bots' stars are unchanged);
   - loop with a different seed rule (e.g. 1000 + 30 + 100·cycle + (L − 30); a spec change, GDD §10);
   - fix it through item 1.
3. **Lead: the boss TTK fade (§4).** TTK is flat, and on L28 24 % shorter at 0.45·E than at E, at high ranks below E_boss. Options:
   - accept it, as now documented;
   - adopt a strictly monotone shop scale (the linear form in §4), which lengthens below-curve fights by up to about 1.3× at 0.3·E. It would need the passive and worst campaigns re-run.
4. **Lead / level owner: report correction.** r5-level-balance.md's "every level cleared within 3 attempts" (passive) should read "within 4 (L23)". Their own table shows it.
5. **Round-3 residual (not in my scope):** L12 leaks 29.3 % pooled (canonical 27.3), above its 22–28 band, and L10's non-canonical layouts sit at 8–17 % (canonical 27.7). These are the r3 calibration's layout spread again.
