# Round 5: level / balance (districts hookup, L13–L30 calibration, generator data)

Owner: level / balance (`js/level.js`, `js/levelgen.js`, `tools/validate-levels.js`; data keys `LEVELS.*`, `LEAK_MODEL.*`, `LEAK_BANDS`, `ECONOMY.*`, `STARS.*`, `BOSSES.squadScale / shopScale / hpPerE`, `WAVE_*`, `GATE_RULES.generation.*`).
Date: 2026-10-09. Evidence: `E:/Temp/claude/gate-rush-evidence/r5/level-balance/`, written `$EV` below. The files as handed over: `$EV/level.js.orig`, `levelgen.js.orig`, `data.js.orig`, `validate-levels.js.orig`. Installed md5: level.js c4b2ebe9, levelgen.js d00d5f26, validate-levels.js f0bcd178 (unchanged); data.js 089a73d5 also contains other owners' concurrent edits.

## Verdict

| # | Task | Result | Status |
|---|---|---|---|
| 1 | Districts hookup (DISTRICTS.md §3, §8.5) | `render.setDistrict(d, 0)` at run start (before `env.setLevel`) and at the title (the highest unlocked level's district). `level:start` carries `district`. `district:change` follows it, and fires at every endless rotation (4 s, at the 3-chunk boundary in a gate-clear window) and at the title. Probe: rotations at 900 / 1800 / 2700 / 3600 m, the banner rule holds, the title shows Night City at highestUnlocked 14 | done (render's `setDistrict` is not in the tree yet; level calls it guarded) |
| 2a | L13–L30 leak inside the GDD §6.3 bands, on-curve, realistic ranks | Before: 10.7–21.4 % on every level, below every band. After (canonical ×3 with noise + 9 layouts): L13–L19 23.7–27.6 % (band 22–28), L20–L30 29.0–31.0 % (band 28–32) | met |
| 2b | No early wave wipes more than 35 % of an on-curve squad | Lab maximum 32 % (L13, L15). Natural campaigns: smart ≤ 10.8 %, QA-strong ≤ 14.3 %, passive ≤ 17.8 % | met |
| 2c | Boss TTK 12–25 s at E_boss with realistic ranks | Before: per-level medians 5.0–15.8 s, 11 of 18 levels under 10 s. After: 12.9–20.3 s on every L13–L30 level | met |
| 2d | Strong bot 3★ on most levels; passive fails a fair share | Smart 3★ 18/18. QA-strong 3★ 13/18 with 1 first-attempt fail. Passive 1.72★ average, 11 of 18 levels failed on the first attempt (before: 4), every level cleared within 4 attempts (L23 on the 4th; *1.2.0 release correction, r5-balance-audit needsOtherGroup 4: this read "within 3", which this report's own campaign rows contradict*). Worst bot clears L21, L22, L25 on its 5th attempt and L26 on its 6th | met (passive and worst rates are for the lead, see needsOtherGroup) |
| 2e | Validator warnings to zero or justified in GDD | 10 → 7 warnings, 0 errors. L23, L25 and L28 are now clean. The 7 left (L1 ×4, L6, L13, L19) are each justified in GDD §10 "Validator status (round 5)" | met (justified) |
| 2f | Move levelgen's DATA-MISSING literals into data.js | All 19 are now data reads. 11 keys were new, the rest already existed in data.js. Every script L2–L30 and endless is byte-identical before and after this refactor (md5 per script) | done |
| 3 | Title idle gates near field | render-core is fixing this on the camera rig (`r5/render-core/tools/rigsearch.mjs`). No `r5-render-core.md` exists yet. `level.idleStep` can only choose when gates spawn: a gate always travels to `despawnZ` +14, past the camera at z 11, and the gates API has no despawn or fade. No level change | handed to render-core (needsOtherGroup 2) |
| — | `node tools/validate-levels.js` | 30 levels · 7 warnings · **0 errors** | ok |

## 1. Districts hookup (js/level.js)

| File:line | Change |
|---|---|
| level.js:21 | Imports `DISTRICT_RULES`, `districtForLevel`, `districtForChunk`. |
| level.js:93–95 | `P_START.district`; a new reused payload `P_DISTRICT { id, name, index, label, accent, seconds, reason, banner }`. |
| level.js:370–372 | Fields `_district`, `_lastRunKey` (campaign L, −1 for endless, 0 = no run yet) and `_lastGatesAt` (Doubles from the start). |
| level.js:529 | `get district()`. |
| level.js:754–758, 778 | `quitToTitle`: district = `districtForLevel(save.data.highestUnlocked)`, set before the undo list so the fog uses it. `render.setDistrict(d, 0)`, then `district:change { reason 'title', banner false }` after `state 'title'`. |
| level.js:784–860 | New `_applyDistrict(seconds)` (calls render only when `setDistrict` exists), `_emitDistrict`, `_districtFogNear(runup)`, `_districtFogFar()` (fogFar × `farScale`) and `_stepDistrictRotation()` (§3.2 (a)–(d) plus the `fadeDeferMaxM` cap; allocation-free; scans forward from `_cursor` only while a rotation is due). |
| level.js:883, 887 | Undo list: `setBloomStrength()` with no argument (the district's bloom base); `env.setFog(d.fog.near, fogFar × d.fog.farScale, 0)`. |
| level.js:916–925 | `_beginRun` (start, startEndless, restart): `d = districtForLevel(L)`, or `districtForChunk(1)` for endless. The banner is shown unless the previous run this session was the same level (endless: also endless). Order: undo list, `setDistrict(d, 0)`, then `env.setLevel`. |
| level.js:970–972 | `level:start { …, district: d.id }`, then `district:change { reason 'start', seconds 0, banner }`. |
| level.js:1154 | Endless `_stepEndless` calls the rotation check every step. |
| level.js:1341 | `_fireGates` records `_lastGatesAt = ev.at`. |
| level.js:1493 | Run-up fog: `env.setFog(d.fog.runupNear, fogFar × d.fog.farScale, 1)`. |

**Probe** (`$EV/tools/distprobe.mjs` → `$EV/districts/distprobe.json`, `$EV/distprobe.log`): the real build in headless Chrome. `render.setDistrict` is recorded through a wrapper; it is absent in the tree today.

| Step | Recorded |
|---|---|
| Boot title, then L1 | setDistrict(sunset, 0), title change (banner false); L1: `level:start { district: 'sunset' }`, then change 'start' with banner true |
| L6 start / L6 RETRY / L7 | overcast with banner true / banner false / banner true |
| Title, highestUnlocked 14 / 3 / 31 | night / sunset / sunset (L31 cycles); banner false each time |
| Endless, smart bot, ranks 10, seed 4242 | sunset at start, then rotations at 900.1, 1800.1, 2700.1 and 3600.1 m (chunks 4, 7, 10, 13 → overcast, night, toxic, ash) with seconds 4 and banner true. At each rotation: last gate event 125–142 m behind (≥ 44 needed), next gate 34.9–52.9 m ahead (≥ 0.8 × 4 × v = 30–35 needed), no boss alive. Died in chunk 15 |
| Endless restart | banner false |
| Page errors | 0 |

The hitch budget at run start (§10 item 5) cannot be measured until render lands `setDistrict`. Level's own per-call cost is a few field writes and one event.

## 2. L13–L30 calibration

### Method (round-3 tools, `$EV/tools/`)

- **Runner.** The round-3 audit's fast runner (headless Chrome, engine stepped by hand, ≈ 250× real time), with all output paths moved to `$EV`.
- **lab.mjs.** Now also records the boss (C, TTK, HP) and takes array ranks, so rank 10 fits.
- **mksubs.mjs.** Builds the data substitutions used for the iterations.
- **Ranks.** Those a greedy cheapest-next-rank smart campaign owns before each level, from `$EV/before/camp/smart30.rows.json`; written to `$EV/tools/ranks.json`. Order is squad · fire · damage · coin · boss:

  | Level | Ranks |
  |---|---|
  | L13 | 5·4·4·6·5 |
  | L16 | 6·6·5·7·6 |
  | L20 | 8·7·7·8·7 |
  | L25 | 9·8·8·10·9 |
  | L30 | 10·10·9·10·10 |

- **On-curve lab.** The squad is pinned to E after every gate pass. Each level runs the canonical seed 3 times with human noise (0.4 s reaction, ±0.5 m aim), plus 9 layouts (seeds 1000·(k + 1) + L). Leak is the mean over waves of biters ÷ spawned. TTK runs from `boss:fight` to `boss:dead`.

### What changed and why

- **`LEAK_MODEL.calibByLevel` L13–L30** (data.js:398–401). Before, L13 on held 1.0, and an on-curve squad with those ranks leaked 11–21 %: the shop's fire × damage outgrows the p^0.5 wave compensation. The factor was fitted in three iterations (`$EV/lab/it1-*`, `it2-*`, `it3-*`); the response is ≈ 35–45 leak points per ln unit. Final values: L13 1.2, L14 1.16, L15 1.25, L16 1.25, L17 1.28, L18 1.44, L19 1.57, L20 1.29, L21 1.28, L22 1.32, L23 1.43, L24 1.31, L25 1.32, L26 1.27, L27 1.42, L28 1.47, L29 1.43, L30 1.53.
  - The factor scales both sides of the solve (wave HP and the modelled squad DPS), so the validator's weak and no-steer lines barely move.
  - L2–L12 scripts are byte-identical (md5).
- **`BOSSES.shopScale` { exp 0.75 → 0.9, maxMult 4 → 10 }** (data.js:477–481).
  - m = (fire / 2)·damage·boss damage reaches 12.5 at rank 10. The ×4 cap bound from about L18, so late bosses died in 5–10 s at E_boss.
  - Raising the cap alone (iteration 1) still left L21–L30 at 7–12 s.
  - With exp 0.9, TTK at C = E_boss scales as m^−0.1: a better shop still wins faster, which keeps GDD §7's rule.
  - L2–L12 fights lengthen by 3–20 %. Smart bot L1–L12 TTK is 8.5–17.6 s (before: 7.7–16.1 s), and stars are unchanged (below).
  - Endless is unaffected: the table below matches round 4's set A.

### Results

| L | Ranks | Leak before (%) | Leak after (%) | Band | Early-wave max lost, after (%) | Boss TTK median before (s) | Boss TTK median after [min–max] (s) |
|---|---|---|---|---|---|---|---|
| 13 | 5·4·4·6·5 | 20.3 | 25.2 | 22–28 | 32 | 11.8 | 14.4 [13.8–17.5] |
| 14 | 5·5·5·6·5 | 17.4 | 24.6 | 22–28 | 27 | 10.4 | 14.3 [9.5–16.9] |
| 15 | 6·5·5·7·5 | 19.1 | 27.6 | 22–28 | 32 | 15.8 | 19.6 [15.1–22.8] |
| 16 | 6·6·5·7·6 | 19.0 | 24.0 | 22–28 | 20 | 9.6 | 12.9 [10.7–16.5] |
| 17 | 7·6·6·7·6 | 17.7 | 23.7 | 22–28 | 21 | 11.0 | 15.0 [13.0–16.2] |
| 18 | 7·6·6·8·6 | 14.7 | 25.0 | 22–28 | 21 | 9.8 | 13.6 [9.9–15.2] |
| 19 | 7·7·6·8·7 | 10.7 | 24.7 | 22–28 | 23 | 9.2 | 13.4 [10.7–16.9] |
| 20 | 8·7·7·8·7 | 21.4 | 31.0 | 28–32 | 31 | 14.8 | 20.3 [16.6–21.4] |
| 21 | 8·7·7·9·8 | 19.1 | 30.5 | 28–32 | 21 | 8.1 | 13.9 [7.8–14.8] |
| 22 | 8·8·7·9·8 | 18.7 | 29.6 | 28–32 | 28 | 9.6 | 14.0 [10.0–17.0] |
| 23 | 9·8·8·9·8 | 18.9 | 29.0 | 28–32 | 30 | 5.8 | 13.8 [10.8–17.1] |
| 24 | 9·8·8·10·8 | 16.5 | 29.4 | 28–32 | 22 | 9.4 | 14.4 [10.9–19.0] |
| 25 | 9·8·8·10·9 | 21.4 | 30.0 | 28–32 | 19 | 10.5 | 16.4 [12.4–19.1] |
| 26 | 9·9·8·10·9 | 20.8 | 29.5 | 28–32 | 20 | 5.8 | 13.0 [11.6–17.9] |
| 27 | 9·9·9·10·9 | 20.5 | 30.4 | 28–32 | 22 | 5.0 | 13.3 [10.8–16.3] |
| 28 | 10·9·9·10·9 | 13.6 | 29.0 | 28–32 | 26 | 5.7 | 15.2 [10.7–18.7] |
| 29 | 10·9·9·10·10 | 16.3 | 30.8 | 28–32 | 31 | 5.8 | 15.1 [11.2–16.5] |
| 30 | 10·10·9·10·10 | 11.6 | 30.5 | 28–32 | 31 | 7.0 | 17.3 [15.8–19.5] |

Sources: before `$EV/lab/base-{a,b}.{log,json}` (9 runs per level); after `$EV/after/lab-final-{a,b}.log` and `$EV/after/lab/final-*.json` (12 runs per level, installed tree, no substitutions). The pinned squad clears every run; a few runs end 2★ on L13, L16 and L19.

### Campaigns (installed tree; greedy shop; 4 attempts; the game's own retry seeds)

Sources: `$EV/after/camp/*.rows.json`; `node $EV/tools/campsum.cjs $EV/after/camp 13 30`. Before: `$EV/before/camp/{smart30,passive30}`.

| Bot | L13–L30 after | L13–L30 before | L1–L12 after (stars and fails as in round 3) |
|---|---|---|---|
| smart (anticipates the lane) | 3★ 18/18; boss C/E 0.95–1.46; TTK 10.2–19.0 s (natural squads arrive above E) | 3★ 18/18; TTK 4.2–13.2 s | 3★ 12/12 |
| QA-strong (face value) | 3★ 13/18, avg 2.72★; 1 first-attempt fail (L28 at 45 %) | — | 3★ 9/12 |
| passive (never steers) | avg 1.72★; first-attempt fails on 11/18 (L17, L19–L24, L27–L30); all cleared by the 4th attempt (L23: fail, fail, fail, 2★; *release correction, was "3rd"*); 3★ on L15, and on L21 and L28 after the assist | avg 1.67★; 4 first-attempt fails | 1.83★; fails L9, L11, L12 (round 3: identical) |
| worst (always the worst lane) | 14/18 cleared within 4 attempts | — | 11/12 (L10 not within 4; round 3: the same) |

**Worst bot with 10 attempts on the four levels it did not clear** (`$EV/after/worst10/`):

| Level | Attempts | Payouts before the clear |
|---|---|---|
| L21 | F44, F39, F100, F100, then 1★ (a5, +144 assist) | 208–1095 per failure |
| L22 | F40, F37, F75, F97, then 2★ (a5) | 279–1089 per failure |
| L25 | cleared at a5, 1★ | 293–1255 per failure |
| L26 | cleared at a6, 3★ | 428–1129 per failure |

Fx is a failure at x % of the level. Two failures plus the win exceed the cheapest next rank (1 770–2 950) on every one of them.

**Early waves in natural play** (L13–L30, first two waves): max lost 10.8 % (smart), 14.3 % (QA-strong), 17.8 % (passive).

**Income from the clearing run** (smart / passive, L13–L30): 1 313–3 632 / 991–3 399. The same-seed ratio is 1.04 on L15 (the passive got 3★ there) and 1.17 on L25; most levels are 1.3–1.75.

### Endless check (shopScale also scales mini-bosses)

Seed set A (9001 + 37·i, 12 seeds), installed tree, `$EV/after/endless.summary.txt`:

| Configuration | Median death chunk (min–max), after | Round 4, set A |
|---|---|---|
| smart r0 | 8 (4–14) | 8 |
| smart r3 | 9.5 (6–17) | 10 |
| smart r10 | 11.5 (9–27); 1 run past chunk 25 | 11.5 |
| QA-strong r3 | 7.5 (6–15) | 8 |
| passive r0 | 3.5 (3–6) | 3.5 |

This is unchanged within the ±1 run-to-run noise the round-3 audit measured.

## 3. Generator data and the validator

### levelgen.js

| File:line | Change |
|---|---|
| levelgen.js:3–5 | Header: every tuning number now comes from data.js. |
| levelgen.js:49–151 | The `DATA-MISSING` block is replaced by data reads; a `num(v, d)` fallback covers a mixed build, where a new levelgen.js is served next to an older data.js during a worker update (r4-release §4). The values read:<br>• `LEVELS.curve.traceTolerance`, `cautiousFloor`, `weakLineFail`, `crateHintAfterM`, `coinLineEveryGates`, `pickupClearM`, `generator.{attempts, weakAttempts, specTries, gainBand, surviveMult, uSteps}`;<br>• `GATE_RULES.generation.{cautiousHits, designHits, lineGuards, faceItem, guards, secondSlotMaxErr, noSteerPenalty, patterns[itemPlus].aScale}`;<br>• `WAVE_RULES.{introHpFrac, burstEvery}`, `WAVE_PATTERNS[*].weight`;<br>• `LEVELS.endless.{crates, coinLines}`. |
| levelgen.js:2070–2074 | Attempt loop: the early stop also waits while the best attempt's weak line is under 20 %, and such a level gets `generator.weakAttempts` (32) attempts instead of 24. This cleared L23, L25 and L28. L2–L12, which never have a weak shortfall, generate exactly as before. |

`grep DATA-MISSING js/levelgen.js` now finds only the header note. level.js keeps its four non-levelgen ones: `WORLD.*`, `JUICE.*` and the run-up spread, which are outside this task.

**Generation time** (`$EV/tools/gentime.mjs`, node, warm, on the loaded host): L13 32 attempts / 141 ms, L19 32 / 178 ms, L28 29 / 178 ms, L6 24 / 65 ms. The worst single attempt is 9.1 ms, and the prefetch slices per attempt.

### data.js (my keys; targeted edits, re-read before each)

| Lines | Change |
|---|---|
| 251 | `GATE_RULES.generation.patterns[itemPlus].aScale [0.5, 1.3]` |
| 282–290 | `GATE_RULES.generation.designHits 0.75`, `lineGuards { 1.3, 5, 0.3, 0.3 }`, `faceItem { 1.15, 2 }`, `secondSlotMaxErr 0.15`, `noSteerPenalty 2` |
| 397–401 | `LEAK_MODEL.calibByLevel` L13–L30 |
| 451–452 | `WAVE_RULES.introHpFrac 0.8` |
| 477–481 | `BOSSES.shopScale { exp: 0.9, maxMult: 10.0 }`, with the rationale in a comment |
| 852–856 | `LEVELS.curve.cautiousFloor 0.2`, `weakLineFail 0.02`, `crateHintAfterM 30`, `coinLineEveryGates 2` |
| 866 | `LEVELS.curve.generator.weakAttempts 32` |

### Validator

`tools/validate-levels.js` is unchanged. Before: 10 warnings (L1 ×4, L6, L13, L19, L23, L25, L28). After (`$EV/validate-after.txt`): 7 warnings, 0 errors. The 7 are justified in GDD §10 "Validator status (round 5)":

| Warning | Why it stays |
|---|---|
| L1 ×4: authored waves predicted at 0–5 % leak | The authored script has no level calibration; its waves carry play-measured `hpMult`. Measured leak is 12.9–14.3 %, inside the band. |
| L6: no-steer line 88 % (limit 85 %) | All 24 attempts are above the limit; the x3 bet sits on the left lane. A round-3 residual, and L6 is a round-3-calibrated layout. |
| L13: weak-shooter line 16 % (floor 20 %) | Every one of the 32 attempts either breaks the full-intake cap (an error) or is weak-low. The late single −A gates (A ≤ 0.9·H) cost a 0.3·H shooter ≈ 0.6·H each. Passive clears at once with 1★; worst clears at the 3rd attempt. |
| L19: weak-shooter line 5 % (floor 20 %) | Same cause as L13. Passive clears at the 2nd attempt; worst at the 4th. |

A larger weak-line weight in the gate selection (`lineGuards.cautiousWeight` 0.5 / 0.8 / 1.5, `$EV/wip/dump-cw*.txt`) produced errors on L14 and L19 and changed L8, so it was rejected.

## 4. Docs

- **GDD:**
  - §4.4 (line 186): the weak-line attempt budget.
  - §6.3 (line 260): round-5 calibration paragraph.
  - §7 (line 270): shop scale 0.9 / 10 and its rationale.
  - §10 (line 409): validator status and justifications.
- **ARCHITECTURE:**
  - §6.16 (after `quitToTitle`): `get district()` and the hookup contract.
  - §6.16 `runup` bullet: the district fog.
  - §8.6 (line 977): round-5 data keys.

## 5. Verification

| Command (from the project root) | Result | Evidence |
|---|---|---|
| `node --check` js/level.js, js/levelgen.js, js/data.js, tools/validate-levels.js | all OK | — |
| `node tools/check-imports.js` | 0 errors, 0 warnings | — |
| `node tools/validate-levels.js` | 30 levels · 7 warnings · 0 errors (exit 0) | `$EV/validate-after.txt`; before: `$EV/validate-before.txt` |
| `grep console.log\|Math.random js/level.js js/levelgen.js` | none | — |
| `node tools/smoke.js --scenario all --shots 30 --bootTimeout 90 --out $EV/smoke-all` | CLEAN; L1 won 3★, 258 survivors; HOME tap back to the title | `$EV/smoke-all/report.json` |
| `node tools/smoke.js --scenario play --level 21 --quality med --seconds 150 --shots 30 --pre "<highestUnlocked 31, ranks 8·7·7·8·7>" --out $EV/smoke-l21` | CLEAN; won, 509 survivors; 38 draw calls; 134 fps mean, p99 14 ms | `$EV/smoke-l21/report.json` |
| `node tools/smoke.js --scenario play --endless --seconds 150 --shots 30 --pre "<ranks 3>" --out $EV/smoke-endless` | CLEAN; alive at 146 s, 1 374 m | `$EV/smoke-endless/report.json` |

Script identity: `$EV/dump-live-before.txt`, `dump-live-after1.txt` (the DATA-MISSING refactor) and `dump-live-after2.txt` (calibration).

**Long frames are host load.** All three smoke runs, L1 included, show clusters of 55–430 ms frames about every 11–12 s. During the runs the host had 43 Chrome processes from other agents and 66 % CPU load. The only per-frame code this round adds is the endless rotation check: one `districtForChunk` call and a compare per step, nothing in campaign play. A quiet-host re-measure belongs to the verifier.

## needsOtherGroup

1. **Render-core: `render.setDistrict` is not in the tree yet.**
   - level calls it guarded, with `typeof … === 'function'`.
   - Once it lands, please run DISTRICTS.md §10 item 5: `--level 1/6/11/16/21/26 --quality med|high`, no frame over 50 ms in the first 2 s. The level-start order is undo list, then `setDistrict(d, 0)`, then `env.setLevel`, then resets.
   - The endless cross-fade starts exactly at the 3-chunk boundaries (probe above).
2. **Render-core / gates: the title idle gates near field.** I made no level change.
   - **Why level cannot fix it.** A decorative pair spawned by `idleStep` always scrolls to `WORLD.despawnZ` (+14), past the title camera at z 11. The gates API has no per-event despawn or fade, and a `gates.reset()` would pop the gate on screen.
   - **Render-core is already searching for a title rig** (`r5/render-core/tools/rigsearch.mjs`, gates ≥ 8 m from the camera on every landscape aspect).
   - **If the rig cannot hold it,** gates.js could fade decorative gates once they pass the squad (z ≥ 0). Level can adopt any idle-cadence change the fix needs: `WORLD.idleGateEveryM` is read in `idleStep` only.
3. **Lead: the passive player's first-attempt fails on L13–L30 went from 4 to 11 of 18.**
   - It still clears every level within 4 attempts: L23 needs 4 (*1.2.0 release correction per r5-balance-audit needsOtherGroup 4; this read "within 3"*).
   - The worst bot needs 5–6 attempts on L21, L22, L25 and L26; each failure pays 200–1 250 coins, and the assist escalates.
   - I read this as "steering must matter" late in the campaign. If it is too hard for a casual player, lower `calibByLevel` on L20–L24, where the passive fails twice.
4. **Lead / UX: the boss-damage upgrade is now worth less in a fight at E_boss.** With shopScale exp 0.9, rank 10 shortens a fight at C = E_boss by ≈ 9 % (2.5^−0.1), where it was 21 % at exp 0.75. Its value shows mainly below the curve, because the exponent fades with C / E. Options:
   - accept it;
   - exempt `bossDamage` from m;
   - redefine the upgrade.
5. **Lead: two validator warnings each on L13 / L19 and the L6 no-steer line are accepted in GDD §10.** Fixing them needs a generator design change, for example single −A gates capped below 0.9·H from L13, or the x3 intro bet on the right lane. Either would re-layout levels; the L6 change would re-layout a round-3-calibrated level.
6. **QA / verifier:**
   - Re-run the round-3 / round-4 suites on a quiet host.
   - Income ratio (smart / passive, same seed) is 1.04 on L15, where the passive gets 3★ (no-steer line 84 %), and 1.17 on L25.
   - L13–L30 scripts changed: the HP is baked in, and L13, L14, L19, L23, L25 and L28 have new layouts from the weak-line retry. Scripts that depend on a layout must regenerate.
7. **DISTRICTS.md (no spec error found).**
   - I implemented §3.2 and §8.5 as written.
   - The banner rule shows the banner on the very first L1 run of a session ("previous run was not the same level"). The spec allows it; ui may want to suppress it at L1 for the FTUE.
