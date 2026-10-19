# Round-2 fixer report — group "level"

Files edited: `js/level.js`, `js/levelgen.js`, `tools/validate-levels.js`; targeted keys in `js/data.js` (all inside the assigned
key list: `LEAK_MODEL.*`, `BOSSES.squadScale/shopScale`, `LEVELS.endless.*`, `LEVELS.authored[1]`, `LEVELS.curve.assist*/intro*`,
`ECONOMY.starBonus/failBonusFrac`, `GATE_RULES.plus.maxCoins`, `GATE_RULES.mult.openReach`, `GATE_RULES.generation.opener/greedyProfiles`,
`HINTS.x2/tryx2`); `docs/GDD.md` §0, §1, §1.1, §4.2, §4.4, §6.3, §7, §9.1, §9.2, §10, §10.1, §11; `docs/ARCHITECTURE.md` §6.16.

Evidence root: `docs/build/qa2/fix-level/` (tools in `fix-level/tools/`: `launch.mjs`, `lab.mjs` wave lab, `labana.cjs`,
`campfast.mjs` = feel-balance/camp.mjs + `--speed K` (rAF / performance.now run K× faster; protocolTimeout raised),
`waveana.cjs` (feel-balance waves.cjs method per level), `bossttk.mjs`, `endana.cjs`; edge tests `t17b.mjs`, `t5-squad.mjs`, `spikes-fix.mjs`).

**Incident — please read.** Drive C: is at 100 % (other groups' evidence). At ≈ 18:35 UTC one of my `writeFileSync` edits of
`js/data.js` hit ENOSPC and truncated the file to 0 bytes for ≈ 3 minutes. I restored it byte-exact from the module source of
a live headless page that loaded it at 18:31 (CDP `Debugger.getScriptSource`; the 18:27 and 18:31 copies were identical, so no
concurrent edit was lost in that window), then re-applied my one pending edit. Any group whose browser loaded the game between
≈ 18:35 and 18:38 UTC saw an empty data.js and must re-run that check. All my later edits use write-to-`.tmp`-verify-rename.
I also deleted my own regenerable screenshots (fix-level PNGs) to free space; C: still has < 100 MB free.

Final checks: `node --check` on the three files; `node tools/check-imports.js` → 0 errors; `node tools/validate-levels.js` →
0 errors, 6 warnings (`fix-level/validate.txt`); `node tools/smoke.js --scenario all --out docs/build/qa2/fix-level/all` → CLEAN;
`node tools/callsites.js` re-run (new public `level.prefetch`, `showHint(id, arg)`).

## Per issue

### LVL-14 Boss HP scales with the arriving squad and the shop — FIXED (targets partly met)
Changes: `js/level.js` `_fireBoss` (≈1342) applies `_bossHpScale(E)` (≈1390): `clamp((C/E)^0.6,1,2)·clamp(m^(0.75·min(1,C/E)),1,4)` (the shop exponent fades for squads below the curve — added after the bad-bot L7 runs),
m = (fireRate/FIRE.rateBase)·damage·bossDamage, `hp = max(table, roundBossHp(table·scale))`; `run.bossHpScale` + debug histogram
`bossHpScale`; endless mini-bosses too. Boss minions now take `LEAK_MODEL.minionScale` (0.15) of the calibrated solve (at full
calibration they soaked the whole fight). data: `BOSSES.squadScale {exp 0.6, maxMult 2}`, `BOSSES.shopScale {exp 0.75, maxMult 4}`
(new). GDD §0 Boss row and §7 rewritten (round-2 QA LVL-14).
Verification (`fix-level/ttk/base3.json`, `bossttk.mjs` = the smoke `--boss --after setCount` setup, strong-bot steering):
| case | TTK (s) | target |
|---|---|---|
| L1 C=70 / 140 / 336 | 30.3 / 12.0 / 7.5 (maxHp 2800 / 2800 / 4750) | 15–25 / 10–16 / 7–11 |
| L10 C=140 / 280 / 672 | 48.2 / 18.5 / 12.4 (maxHp 7000 / 7000 / 11850) | 15–25 / 10–16 / 7–11 |
| L10 C=280, fire/dmg/bossDmg rank 3 (`ttk/shop3.json`) | 13.2 (maxHp 14 900, scale 2.13) | ≥ 8 |
TTK falls strictly with C and with the shop multiplier. Above-the-curve squads land in range; below the curve (C ≤ E) the HP is
the unchanged table value (the issue forbids going below it), so 0.5·E fights stay long (L1 30 s, L10 milestone 48 s — the
squad also shrinks under slams/stomps). Strong-bot campaign (`fix-level/camp-strong`, greedy shop): TTK 8.1, 15.6, 15.2, 15.6,
16.6, 7.6, 33.3, 10.1, 13.8, 12.0, 13.7 (L11 a2), 6.2 → 9 of 12 in 8–22 s (target ≥ 10); the phase-2 special (charge / acid
rain / car) fired on 12 of 12 levels. Before: only 2 of 12 in range, L12 attacks never seen.

### LVL-15 Leak model calibrated against play; damped shop ranks — PARTIAL
Changes: `js/levelgen.js` `waveDps` × `leakCalib(leak)` (≈531–560: `LEAK_MODEL.calib` × piecewise `calibByLeak`), `survivorFactor`
/ `leakOfRatio` (≈561–575: TTK = win/(1−leak)^`leakExp`, inverted for the predicted leak), the band target threaded into
`expectedLeak` / `waveLeakSlack` / the validator rows, `runupShare` (≈744: a run-up horde is solved per burst share, ≥ 0.6).
`js/level.js` `_liveHpMult` (≈1413): wave / guard / run-up / minion HP × p^`profileExp` (p = fireRate/2·damage), applied to baked
and solved tables in `_fireWave`, `_fireGates`, `_fireRunup`, `_fireBoss`; `hpMult` now also scales authored `hp` (as the validator
already modelled). data `LEAK_MODEL`: `calib 2.0`, `leakExp 3`, `calibByLeak [[.125,1],[.185,1.25],[.25,1.8],[.30,2.2]]`,
`windowScale {walker 1.5, runner 0.6, crawler 0.33, brute 0.35, spitter 1}`, `runupShareMin 0.6`, `minionScale 0.15`,
`profileExp 0.5` (new keys). L1: `hpMult` 1.5 / 2 / 1.5 on waves B, C and the run-up (wave A keeps its HP; it already bit 1–2).
GDD §6.3 amended (round-2 QA LVL-15 + the round-1 LVL-4 text).
Method: a controlled wave lab (`fix-level/lab/types-L9.json`, `types-L14.json`; `tools/lab.mjs`) spawning pure walker / runner /
crawler / brute / spitter waves at C = E with HP = k × the old solve: walkers reach their band at k ≈ 4.5, runners ≈ 1.7, crawlers
≈ 2.1, brutes ≈ 1 (their contact chews), spitters lose soldiers to spit regardless of HP; leak rises very slowly with HP (walker
12 → 27 → 35 % at k 4, 5, 8) → the exponent. In-level runs then showed capacity rising with the level (specials / troops), hence
the per-band factor; two iterations (cal3) overshot (strong bot failed L7 / L10, run-up walkers at 1 500 HP) and were backed off.
Verification (`fix-level/camp-strong`, `camp-passive`, 12 levels, greedy shop; `node fix-level/tools/waveana.cjs camp-strong camp-passive`):
- share of waves that bit: strong 63 % (was 2.5 %), passive 54 % (was 2 %); median wave leak strong 12.5 %, passive 7.7 % (was ≈ 0);
- levels whose median leak is inside its band ± 4: strong 5 / 13 runs, passive 3 / 12 — NOT met. Per level it is strongly bimodal:
  L2/L3/L9/L11 at or above the band, L6/L8/L10/L12 ≈ 0 % (each level has 5–14 waves of 6–24 zombies, so one biter = 4–17 points;
  the per-level medians are noisy);
- median soldiers lost per wave 2.2 % (strong) / 1.1 % (passive) of C — target 8–12 % NOT met (with P ≤ 24 per wave and C ≈ E ≈ 200–600 a
  25 % leak is ≈ 1–3 % of C: GDD §6.3's band and §17's 8–12 % of C contradict each other above L5 — design owner);
- validator (`fix-level/validate.txt`): the 41–52 % crawler warnings are gone; generated waves predict their band by construction; L1's
  authored waves predict 0–5 % (play: wave A 1–2 of 6 bite).

### LVL-16 Gate events alternate over pairs/triples — FIXED
`js/levelgen.js` `assignSide` (≈1369) gives multi-lane events a side from a counter (`gx.multi`, start = seed+1 parity) after the spec is
final; `materializeGate` uses `spec.side`; singles hold side 0; endless chunks continue the counter from the chunk's gate base.
Validator: `validateLevel` (≈2769) fails a level whose better option (design face-value pick, guards ignored, ties skipped) is on the
left outside 40–60 % ± 1 event; `validate-levels.js` prints `L/R` per level. Verification: `fix-level/validate-alt.txt` — check passes
on L1–L30 (L2 1/1 + tie opener, L3 2/1, …, L30 5/5). Play (`camp-passive` vs `camp-strong`): the no-input player now reaches the L2 boss
with 85 % of E_boss vs 109 % (strong), L3 92 % vs 96 %; passive stars L2/L3 2★ (were 3★ = identical to the strong bot).

### LVL-17 Endless — PARTIAL (rubber band, C/E, mini-boss fixed; runs still do not end)
Changes: `js/levelgen.js` `eventWorstCase` (≈2184), `endlessGateGuard` (≈2205, shared by runner and validator): at every gate event
C > 2·E → ÷2 | ÷2 (one lane shootable to x1 only while C ≤ 2.84·E, else both halve — the shootable lane had let the bot pump ÷2 → x1 at
every event); else worst case (C × best lane of every unpassed event, full window) > 2·E → × lanes become small + lanes, + lanes capped at
min(0.5·E, 2·E − worst-before), ÷ lanes cannot flip to x2. `generateChunk`: population cap 36, brute/spitter share × (1 + 0.04·D), each
heavy type ≤ ¼ of its pool per wave; mini-boss minions via `scaleMinions`. `simulateEndless` (≈2266) = the validator's endless line.
`js/level.js`: `_guardEndlessGate` (≈1131, replaces `_lockRunaway`, keeps a pending-gates table), `_applyRubberBand` keeps only the
low side, `_crowdEndlessWave` (≈1237: wave population × min(2, √(C/E))), `_liveHpMult` endless part (E_eff = max(E(D), C), band +1.5
pts/D ≤ 45 %), mini-boss count/shop scale via `_bossHpScale`. data `LEVELS.endless`: `pop.cap 36`, `heavyPerD 0.04`,
`miniBossHpPerE 30`, `bandPerD 0.015`, `bandMax 0.45`, `crowdMax 2`, `keepMult 2`, `plusCapFrac 0.5` (new). Validator: endless line
for rank 3 and rank 0, error if C/E > 3 at any boundary after D2. GDD §10.1 amended (round-2 QA LVL-17; round-1 LVL-3 x1 text).
Verification: validator endless line max C/E after D2 = 2.23 (rank 3) / 2.17 (rank 0); rubber-band 'high' 11 events, 'keep' 25.
In play — see "Endless results" below: C/E, ÷ share and early mini-bosses fixed; runs still do not end.

### LVL-18 Level generation memo + idle prefetch — FIXED
`js/level.js` `_generatedScript` (≈530: Map memo `${curveL}|${seed}`, deep-frozen read-only scripts, ≤ 8 entries), `prefetch()` (≈564,
requestIdleCallback 1 s timeout / setTimeout fallback, skipped while playing / paused), `_onStateChange` (≈602: complete → L+1;
title / levels → highest unlocked + current; gameover → same level), sync fallback on a miss, `ctx.debug.levelGenMs / levelGenHits /
levelGenMisses`. Endless scripts are never cached (they are mutated). Verification (`fix-level/spikes-r4/spikes.json`,
`spikes-fix.mjs --rate 4 --quality med`, 4 other browsers running): cold `level.start(9)` 384 ms; after 2.5 s on the title with
highestUnlocked 9: `level.start(9)` 7.2 ms (≤ 20 ✓), RETRY 1.0 ms (≤ 5 ✓); first frame after the prefetched start 21 ms.
The issue's literal `throttle.mjs` q4-l9-med run was not repeated (disk full; the spikes case covers the start).

### LVL-19 Boss kill / game over survive QUIT and RESTART during the theatre — FIXED
`js/level.js` `finish` (≈1718) = `_commit` (once, `_committed`) + `_present*`; `_commitPending` (≈1734) at the top of `start`,
`startEndless`, `quitToTitle` (restart → start); `_commitWon` / `_commitLost` / `_commitEndless` store `_resultData` for the
presentation; late coins after a commit are ignored. Verification (`fix-level/t17-won-quit/report.json`, `t17b.mjs`):
QUIT 0.6 s into the theatre → title, save coins 162 = run payout (42 + 120 bonus), levels['1'].stars 3, highestUnlocked 2; RESTART →
same; a normal clear credits once (results 162 = save 162); pause in 'lost' then QUIT keeps the game-over payout.

### LVL-20 No rewards after C = 0 — FIXED
`_onGatePass` returns in phase 'lost'/'won'; `_onCoinPickup` drops gate/max/crate/pile/duplicate/refund in 'lost' (`LOST_BLOCKED_SOURCES`).
Verification: `t17b` case E (run.gatesPassed 0 → 0, gate coins unchanged after death); `fix-level/t5-squad/report.json`: both
"killed 0.6 s / 0.15 s before a +20 pass" runs show no gate:pass and identical "Coins kept +1".

### LVL-21 Fail consolation + fail-streak assist — PARTIAL
`_commitLost` (≈1829) pays kept 50 % + `levelBonus(L)·ECONOMY.failBonusFrac·fraction` through `coin:pickup 'bonus'`; per-session
`_failStreak` per level; `_applyAssist` (≈1905) adds ceil(0.15·E_boss) soldiers (`addSoldiers(n,'assist')`, `run.assist`) after 2
consecutive failures, reset on a clear. data `ECONOMY.failBonusFrac 0.5`, `LEVELS.curve.assistAfterFails 2`, `assistStartFrac 0.15`
(new; assistStartFrac raised to 0.25 and the assist escalates k = 1…4 per further failure); GDD §9.1 failure row, §10 assist (round-2 QA LVL-21). PARTIAL — see "Bad-bot campaign" below.

### LVL-22 Stars depend on skill — FIXED for L1 / passive (bad L1–3 below)
LEVEL_1: '+2' cap 12 → 6, first x2 step 52 → 80, last '+25' cap 100 → 75 (the worst-lane route +2 → +10 → −15 flipped → +25 reached
the boss at 125 = 3★); expected samples 336/362/400 → 139/133/133 (cautious line 95 % of E_boss). GDD §1.1, §11 rows and the E-trace
paragraph updated. Verification: strong 3★ on L1 (`camp-strong`); passive ≤ 2★ on 9 of 11 levels L2–L12 (`camp-passive`, was 6/12 3★);
bad L1–L3 (`fix-level/stars-bad`): 2★, 2★, 1★ ✓.

### LVL-23 Income rewards skill — PARTIAL
data `ECONOMY.starBonus [0,0,0.5,1.0]`, `GATE_RULES.plus.maxCoins 5`; GDD §0 Economy row, §9.1 rows. Verification (`camp-strong` vs
`camp-passive`, both greedy shop): strong ≥ passive + 10 % on L3, L9, L11, L12 only (4/12, target 10/12); first clears L1 263 (GDD 190,
+38 %), L5 398 (−15 %), L10 1165 (+32 %). Kill coins still dominate and the passive player kills more (its waves and fights last longer);
a further payout term (e.g. survivors-weighted bonus) needs a design decision — not done.

### LVL-24 'GRAB THE CRATE' shown and marked only when displayed — FIXED (level part)
`showHint(id, arg)` (≈476) no longer calls `save.markHint`; keeps `hintDone` and a per-run emitted set (`run.hintsShown`). LEVEL_1 crate
hint row 90 → 120 (moved after wave B to keep the order); generated levels place it `CRATE_HINT_AFTER_M` (30 m) after the crate spawn.
GDD §11 crate row, ARCH §6.16 showHint contract. Verification (`fix-level/hintprobe/hintlog.json`, camp2 `--hintprobe`): GRAB THE CRATE
visible 15.07–17.57 s, crate picked at 19.8 s (≥ 2 s before ✓); every L1 hint id visible once (steer, shoot, more, bite, crate, ×3, red,
boss). Marking on display is ui (UI-25).

### LVL-25 'SHOOT THE BOSS' at boss:fight — FIXED
Boss hint rows removed (generated `events.push({…id:'boss'})` and LEVEL_1 row 400); `_onBossFight` (≈1631) calls `showHint('boss')` for
campaign bosses. Verification (`fix-level/probe-hint.json`, visual-2 probe + m_hint.js): first visible sample t 23.52 s, inIntro false,
HP 3405 < max 3450.

### LVL-26 Guaranteed special via the design-half crate — FIXED
`buildAttempt` (≈1749) moves the earliest crate delivery to the front when items[0] is the level's newly unlocked special, so it always
rides a crate (which the existing LVL-7 rule puts on the design half). Validator check (≈2792): error if the design line does not collect
the guaranteed special (item lane taken, or crate on the half the design lane holds when it arrives). Verification: `validate.txt` passes
for every unlock level L2–L14. `fix-level/l4bot` (smoke L4) completes CLEAN (2★); the smoke timeline has no gear field, so the magnet is
confirmed from the validator rather than from the timeline.

### LVL-27 Balance carry-overs — FIXED / justified
`GATE_RULES.mult.openReach 0.9` (new) clamps the first x step to 0.9·min(40, E·f)·t_w (`multStep` ≈378); unreachable steps and a weak line
< 2 % of E_boss are now validator ERRORS; `generateLevel` penalises weak-line attempts. Verification (`validate-balance.txt`): no
unreachable-step or 0 % failures; L2 design line 104 % (≤ 130 ✓; was 147 %); weak line ≥ 20 % on all levels except L15 (2.4 %) and L19
(9 %) — both are lesser-evil chains where the 0.3·H line cannot flip the ÷/− lanes; the design and full-intake lines are in their windows.

### LVL-28 Round-1 GDD amendments — FIXED
§4.2 H definition and step formulas (round-1 LVL-1 / LVL-2), §4.4 design line / shadow lines, §6.3 per-type windows and coverage
(round-1 LVL-4), §7 intro immunity / attack range / first attack / phase specials / start-to-start / charge stop / telegraph (round-1
ENE-1/2/5), §9.2 1 360 and 59 360 (round-1 R8), §10.1 "shootable to x1" (round-1 LVL-3). `grep` for "0.5)·t_w", "shootable to x2",
"1 350", "59 350": none.

### LVL-29 Theatre deadlines frozen while paused — FIXED
`_finishAt` on `_theatreNow()` (≈916): `ctx.time.theatre` (CORE-7) when present, else level's own clock advanced by dt/timeScale per step
(no steps while paused). Verification (`t17b` case D): pause 1.4 s into the death for 5 s → level:complete 1 602 ms after resume
(expected 1 600).

### LVL-30 Varied openers — FIXED
`openerDraw` (≈1276): own rng fork, bag `GATE_RULES.generation.opener` (+A|xM 50, +A|+B 30, item|+A 20 — the item lane carries the
level's last non-guaranteed special), re-drawn while equal to the previous level's opener (L1's for L2), x2 only; the second gate keeps
its best bag roll unless its error exceeds 0.15 (DATA-MISSING `secondSlotMaxErr`). Sizing from s0Assumed was tried and dropped (it pushed
the full-intake line to 166–212 % on L2/L6/L13–L20). Validator: fails consecutive repeats and > 30 % share. Verification
(`validate-opener.txt`): no consecutive repeat; most common opener "+3|+4" on 7 of 29 (24 %).

### LVL-31 Gate period — FIXED (docs + report)
GDD §1 loop period: "12–13 s on L1; ≈ 8–11 s on generated levels". validate-levels prints a `period` column: L2–L30 7.9–10.7 s (the
issue expected 9–11; L21–L30 at 12 m/s are 7.9–8.4 s, which is what one gate per ≈ 100 m gives).

### LVL-32 HUD distance after death — FIXED
`_emitProgress` (≈921) uses `_deathDistance` in phase 'lost'. Verification: `fix-level/endless-die/02-result.png` — HUD 33 m = "Distance 33 m".

### LVL-33 Hint copy — FIXED
`HINTS.x2 = n => "×n MULTIPLIES YOUR SQUAD"`, `HINTS.tryx2 'TRY THE ×2 NEXT TIME'`; `showHint(id, arg)` calls template hints; the
hintOnPass call passes `gate.mult`. Verification: `fix-level/copy/22-play-24s.png` shows "×3 MULTIPLIES YOUR SQUAD" after the ×3 pass.

### LVL-34 validate-levels and the authored L1 — FIXED
`validateLevel`: `authored` flag (≈2302) skips minValue / unlock / breakeven checks for LEVEL_1; L1's modelled line follows its declared
samples (`declaredBefore`, step reading) and the design final is the declared value; no drift warning. Remaining L1 warnings are the
calibrated model's leak predictions for GDD §11's HP (wave A 0 %, B 4.9 %, C 0 %, run-up 3.9 %) — real model output, not rule clashes.

### LVL-35 Data hygiene — FIXED
`INTRO_*` → `LEVELS.curve.introSearchM/introShiftStepM/introShiftMaxM`, `GREEDY_PROFILES` → `GATE_RULES.generation.greedyProfiles`;
validate output was identical before/after (`validate-before.txt` vs `validate-lvl35.txt`). New literals I had to add are tagged
DATA-MISSING: `CRATE_HINT_AFTER_M` (LEVELS.curve.crateHintAfterM), `WEAK_LINE_FAIL` (LEVELS.curve.weakLineFail),
`SECOND_SLOT_MAX_ERR` (GATE_RULES.generation.secondSlotMaxErr).


### Endless results (LVL-17)
`campfast.mjs --from 1 --to 0 --endless 1 --maxsec 900 --speed 3 --ranks '{"squad":3,"fireRate":2,"damage":2,"coinMult":4,"bossDamage":2}'`
(`fix-level/endless-strong/endless-1.json`, `fix-level/endless-passive/endless-1.summary.json`; `node fix-level/tools/endana.cjs …`):
| | strong | passive | target |
|---|---|---|---|
| run ends | no (alive at the 900 s cap, D 28, peak 1 200) | no (alive at 900 s, D 30, peak 1 145) | 120–480 s ✗ |
| C/E at every boundary after D2 | 1.63–1.98 | 0.96–2.22 | ≤ 3 ✓ |
| '÷2 \| ÷2' share of passes | 7 / 58 = 12 % | 7 / 62 = 11 % | ≤ 25 % ✓ (was 44–51 %; 67 % in my intermediate build) |
| mini-boss TTK | 9.4, 8.8, 6.0, 1.6, 1.4 s | 10.4, 12.6, 8.6, 1.9, 2.3 s | ≥ 6 s: first three ✓, D20 / D25 ✗ (count scale capped at 2× while C ≈ 1 000) |
| losses | bite 25, spit 520, boss attacks 208, gate 106 | bite 636, spit 2 288, boss 208, gate 316 | waves bite now (were 10 / 5 of 4 250 zombies) |
The rubber band now holds C near 2·E and waves at the live count bite, but a squad of ~1 000 at 2·E(=600) still out-gains its losses:
per-gate gains (≤ 0.5·E) exceed what a wave of ≤ 72 zombies can take. Making runs end needs a design decision (lead rejected
E beyond 600): e.g. +A lanes ≤ 0.25·E above E, a leak target that keeps rising past 45 %, or mini-boss count scale beyond 2×.
`smoke --endless … endless-r3` was not re-run separately (disk); the validator's endless line (rank 3) never exceeds 2.23·E.

### Bad-bot campaign (LVL-21, LVL-22)
`fix-level/camp-bad` (L1–L5, then L6–L12 restarted after the ENOSPC crash with the bot's ranks/coins, `camp-bad-6.log`; this run
used the first, flat assist of 0.15·E_boss and the old L1 '+25 cap 100'):
L1 3★, L2 2★, L3 1★, L4 1★, L5 cleared a3 (boss count 45 → 45 → 74), L6 a1, L7 not cleared in 4 (boss count —, —, 27, 29),
L8 a1, L9 a3 (94 → 91 → 137), L10 a3 (dead early twice, then 136), L11 not cleared (—, —, 10, 17), L12 a3 (282, 3★).
Coins kept per failure: L7 105–196 (was 125–138), L9 270 (was 182), L11 119–395 (was 359).
Follow-ups in this session: the assist now ESCALATES (k = 1…4 × 0.25·E_boss per further failure) and the boss shop scale fades with
C/E (a 0.3·E squad with rank-2 upgrades met 1.7× table HP). Re-run of L7 alone (`fix-level/bad-l7/summary.json`, bad bot, ranks
squad2/fire1/dmg1/boss2): boss count —, —, 39, 69, 102 → cleared on attempt 5 (1★). So "every level within ≤ 4 attempts" is
NOT fully met (L7 needs 5; L11 not re-measured with the escalation); "each retry raises the count at the boss by ≥ 10 %" holds once
the bot reaches the boss. `stars-bad` (L1–L3 with the final LEVEL_1): 2★ (99 survivors), 2★, 1★ → ≤ 2★ ✓.

## needsOtherGroup
- **ALL groups / QA lead — data.js incident.** `js/data.js` was 0 bytes from ≈ 18:35 to ≈ 18:38 UTC (ENOSPC on C:, restored from
  the 18:31 module source). Re-run any check that booted the game in that window; verify your own data.js keys are present. C: is
  at 100 % (≈ 30 MB free) — evidence folders (perf-throttled 326 MB, triage 183 MB, audio 154 MB, mobile 135 MB …) should be pruned.
- **ui (UI-25):** level no longer calls `save.markHint`; ui must call `ctx.save.markHint(id)` when it actually displays a hint
  (queue + mark on display). Until then a hint id stays un-marked and re-emits once per run. `hint:show` payload unchanged; `text`
  may now come from a template (`×3 MULTIPLIES YOUR SQUAD`).
- **core (CORE-7):** level reads `ctx.time.theatre` (ms) for the results / game-over deadline when it exists; it falls back to its
  own step-driven real-time clock, so nothing breaks either way.
- **enemies (ENE-12 / boss balance):** below the curve the boss fight is decided by boss attacks and brute contact, not by HP:
  L1 at 0.5·E_boss lasts 30 s, L10 (Juggernaut, milestone) 48 s; a 0.3·E squad loses ~6 soldiers per Hulk slam at L7. In the wave
  lab two brutes at 3× HP killed 43–63 soldiers by contact. Level now hands boss minions 0.15× the calibrated solve.
- **design owner (GDD):** §6.3's leak bands (10–32 % of a wave of ≤ 24) and §17's "median soldiers lost per wave 8–12 % of C" cannot
  both hold once C ≫ P (L5+: 25 % of 20 zombies ≈ 2 % of C = 250); LVL-23 needs a payout term beyond stars (kill coins dominate and
  the passive player kills more); endless needs an end condition (see Endless results).
- **QA tooling:** `tools/smoke.js` timeline has no gear/troop-pickup field (LVL-26 magnet check had to rely on the validator);
  `tools/smoke.js` boot timeout (30 s) fails under 4–5 concurrent browsers.
- **ARCHITECTURE:** I edited ARCH §6.16 myself (showHint(id, arg) contract, new `prefetch()`, commit/present split, new RunStats
  fields) as allowed; no other ARCH section needs changes. Public API: `showHint(id, arg?)` (arg optional), new `prefetch(level, seed?)`;
  new levelgen exports `leakCalib`, `eventWorstCase`, `endlessGateGuard`, `simulateEndless` (ARCH §6.17 lists exports — the design
  owner may want to add them there; §6.17 is not in my section list).
