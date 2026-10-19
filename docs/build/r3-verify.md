# Round 3 — release verification

This is the release verifier's pass after round 3. Inputs: `docs/build/r3-audio.md`, `r3-balance.md`, `r3-balance-audit.md`, `r3-boot-polish.md` and `r3-ftue.md`. The method and baselines follow the round-2 verification, `docs/build/qa2/verify.md`.

**Verdict: releasable.** Open items are design decisions and 4× first-use frames (§5).

- **Static checks.** All green.
- **Smoke matrix.** All 13 runs are **CLEAN** on the final code: 0 page errors, 0 console errors, 0 failed requests. The only warning is the expected sandbox "Progress won't be saved".
  - **No frame over 50 ms in any run.** The worst is 27.9 ms.
  - **One run needed a retry.** L8's first attempt failed to boot on a transient loopback socket error, `net::ERR_NO_BUFFER_SPACE` for `js/models.js`; the game showed its designed "Load error" box. The re-run was CLEAN.
- **Results.**
  - **Boss TTK** at C = E_boss: L10 18.7 s, L20 22.0 s.
  - **Endless** at 150 s: alive, 1 392 m (chunk 5), C 257.
  - **4× CPU-throttled L1 at Medium**: 116.3 and 110.9 fps mean.
  - **No painted boot gap over 300 ms at 4×.** The worst gap is 201–222 ms; it was 236–257 ms before this pass.
- **Fixes made in this pass** (§4):
  1. Endless mini-bosses died to one sniper shot (a gameplay bug).
  2. The boss rigs no longer freeze one boot frame.
  3. The long frame after the results screen is gone: its root cause was levelgen running JIT-cold.
  4. The digit atlas no longer stalls the boot on a system-font fallback.
  5. The smoke harness now keeps frame stats for runs over 139 s.

  Also: the requested GDD / ARCH text, two FTUE residuals, the QA tools, and `CALLSITES.md`.

Evidence root: `E:/Temp/claude/gate-rush-evidence/r3/verify/`, written `EV/` below. I wrote nothing under the project root except the edited sources and docs.

## Environment and method

- **Host.**
  - Windows 11, i7-8700K (6 cores, 12 threads), AMD RX 6800 (ANGLE D3D11), headless Chrome on the real GPU.
  - The panel runs at 144 Hz, so ≈ 6.9 ms frames are the norm.
  - No other agent ran during this pass.
- **Baseline (m1).**
  - The code as handed over was copied byte for byte to `EV/src-before/` (md5 list in `md5.txt`).
  - The whole matrix ran against that copy, with `EV/src-before/tools/smoke-mirror.js`: the project's smoke.js with only its puppeteer import made path-independent.
  - This let me change the project while m1 ran. Every old / new A/B below serves the same copy (`GR_SERVE`).
- **Final (m2).** The same matrix on the final code, with the project's own `tools/smoke.js`.
  - Runner: `EV/tools/matrix.sh <tag> <smoke.js>`, with `--bootTimeout 90`.
  - One-line summaries: `EV/<tag>-summary.txt`. Tables: `EV/<tag>-table.md`, from `EV/tools/mdtable.cjs`.
- **Boss TTK instrumentation.**
  - The L10 and L20 `--after` strings append two listeners to the task's command. `boss:fight` and `boss:dead` push their game time into `window.__bot.choices`, which smoke already reports.
  - The harness is unchanged. TTK = fight → dead, in game seconds.
- **Tools** (`EV/tools/`):
  - matrix: `matrix.sh`, `summ.cjs`, `mdtable.cjs`, `tlboss.cjs`;
  - throttling: `throttle.mjs`, the boot-polish copy of the QA tool (transform-aware boot bar, `--bootOnly`) plus a `GR_SERVE` root; `bootab.sh` for interleaved old / new 4× boots; `bp/bootprof.mjs` for traced boots;
  - probes: `bootcheck.mjs`, `genjit.mjs`, `glyphstall.mjs`, `atlasprobe.mjs` / `atlasprobe2.mjs`, `atlasshot.mjs`;
  - `fast/`: the balance audit's fast runner, `bossprobe.mjs`, `camp.mjs` and `l5cap.sh`;
  - `rep.cjs`: anchor-checked text replacement, used for every edit.

## 1. needsOtherGroup requests

| Source | Request | Status | Where |
|---|---|---|---|
| balance-audit 1, balance 3 | The sniper one-shots endless mini-bosses (mini-boss TTK ignores HP) | **Applied** (fix 1) | `js/troops.js`; `js/data.js` `TROOPS.sniper.bossCapFrac`; GDD §8.3; ARCH §6.6, §7, §8.4 |
| balance-audit 3 | GDD §10.1: "nobody gets past chunk 25" holds only at ranks ≤ 3; "not a single unfair blow" holds only for a steering player | **Applied** | GDD §10.1. It now also states the measured rank 6–10 tail, the passive player's red-gate ending and the shop's ≈ 1-chunk effect, each with its lever |
| balance 1 | GDD §0 "3★ ≥ 75 %" → 80 %; §11 "3★ (105 survivors)" → 112; §6.2 wave population bounded by the squad | **Applied** | GDD §0, §6.2, §10 (formula line), §11 |
| balance 5 | Regenerate `docs/build/CALLSITES.md` after round 3 | **Applied** | 613 lines. New since the last regeneration: `fx.label` `width` / `plateH` / `hasPos` / `y` / `z` and `render.dollying` (FTUE), `boss.maxHp` (fix 1); level now listens to `boss:attack` and `item:pickup` |
| boot-polish 1 | `BossSystem.init` builds every rig in one frozen frame (222–299 ms at 4×) | **Applied** (fix 2) | `js/boss.js`, `js/main.js`; ARCH §4.1, §6.8 |
| boot-polish 2 | The 62.5 ms frame after the results appear (level's idle prefetch) | **Applied at the root cause** (fix 3): the prefetched attempt was slow because levelgen ran JIT-cold | `js/level.js`, `js/main.js`; ARCH §4.1, §6.16 |
| boot-polish 5 | The QA throttle tools read `#boot-fill.style.width` | **Applied** to `qa2/verify-tools/throttle.mjs` and `qa2/perf-throttled/throttle.mjs` (originals kept as `*.pre-r3`) | E: tools only |
| boot-polish 6, audio 3 | Integrator: nothing to rebuild | **Verified**: `build-artifact` reproduces the shipped `artifact.html` byte for byte | — |
| FTUE 2 | The coin-multiplier card icon reads "×2" while rank 1 is ×1.0 → ×1.1 | **Applied**: the badge is now an up arrow drawn as a path, with no number and no font | `js/ui.js` `CARD_ICON_DRAW.coinMult`; `EV/m2-ui/02-shop-bought.png` |
| FTUE 6 | Move gates.js's two DATA-MISSING constants into data.js | **Applied** | `GATE_RULES.glyph.labelYieldS` / `labelYieldMargin`; ARCH §8 |
| boot-polish 3 | Audio first-use node chains: 9–18 ms of `audio.update` at 4× in the first shot, gate-pass and boss frames | **Not applied** (reasons below the table) | — |
| boot-polish 4 | Boss spawn frame: `_fireBoss` 9–9.6 ms plus `boss.render` ≈ 4 ms at 4× | **Not applied**: I found no safe deferral in this pass (remaining issue 3) | — |
| boot-polish 7 | Chunk `Environment.build` (optional) | Not needed: 124 ms at 4×, alone in its frame | — |
| audio 1a, 1b, 2 | Should stings and the flip read ≥ 6 dB?; roar recipe; fader law | Design decisions for the lead. The fader law also involves ui / save | — |
| balance-audit 2, balance 4 | Endless decision-1 wording; L1 income ratio 1.07 | Lead decisions. The measured facts are now in GDD §10.1 | — |
| FTUE 1, 3, 4, 5 and FTUE §6 | HOME on results; weapon-pill icon; cap on boss damage numbers; boot logo font swap; L5's shiny lane, the ÷ ladder hint, L4 at 2★ | Lead, art or balance decisions; not changed | — |
| balance-audit 4, balance 2, balance 6 | Residuals stand; QA re-run; FYI | This pass is the re-run | — |

Why boot-polish 3 was not applied:
- Web Audio source nodes are single-use, so pooling covers only gains, filters and panners. That means restructuring the round-3 mix engine.
- Spreading layer starts over frames would smear the transients the audio owner tuned.

Why the boot logo font swap (FTUE 5) was not changed: `font-display: block` hides the logo for up to 3 s on a slow first visit, so it is a trade-off for the boot owner and the lead.

## 2. Static checks

Run before this pass and again on the final code (`EV/static/`).

| Check | Result |
|---|---|
| `node --check` on `js/*.js` (22), `tools/*.js` (8) and `sw.js` | 31 files, 0 failures (`node-check-final.txt` is empty) |
| `node tools/check-imports.js` | 0 errors, 0 warnings |
| `node tools/validate-levels.js` | 30 levels · **0 errors** · 10 warnings (listed after the table) |
| `node tools/build-artifact.js` | OK: "sw.js PRECACHE covers all 22 files in js/", 34 module preloads, APP and BOOTGUARD blocks (details after the table) |
| `node tools/callsites.js` | `docs/build/CALLSITES.md` regenerated (613 lines) |
| `grep` for `console.log` / `Math.random` in `js/` | comments only; util.js owns randomness |

**Validator.** The output is identical, timings aside, before and after this pass and to the balance owner's `validate-final.txt`. The 10 warnings:
- L1 authored-wave leak ×4;
- L6 no-steer line at 88 % (limit 85 %);
- weak-shooter line under 20 % on L13, L19, L23, L25 and L28.

**Artifact.** `artifact.html` is byte-identical to the shipped one (md5 9437fa0b…).
- It has no doctype, `<html>`, `<head>` or `<body>`, and carries `data-shell="artifact"`.
- sw.js PRECACHE lists all 22 `js/*.js` files, also checked against the directory.

## 3. Results

### Smoke matrix, final code (m2)

All runs use `node tools/smoke.js … --bootTimeout 90 --out EV/m2-<run>`. Boot is smoke's wall time from navigation to the first state.

| Run | Command | Verdict | page err / console err / warn / failed req | Boot (s) | End state | frames: n, fps, p95 / p99 / worst (ms) | long frames > 50 ms | Boss TTK |
|---|---|---|---|---|---|---|---|---|
| boot | `--scenario boot` | **CLEAN** | 0 / 0 / 0 / 0 | 6.6 | title (High) | – | – | – |
| ui | `--scenario ui` | **CLEAN** | 0 / 0 / 0 / 0 | 6.5 | shop, buy, levels, settings, play, pause, resume, quit | – | – | – |
| play L1 | `--scenario play --level 1` | **CLEAN** | 0 / 0 / 0 / 0 | 6.8 | L1 clear ★★★, 239 survivors | 8 710, 143.9, 7.1 / 7.1 / 13.9 | none | – |
| play L2 nobot | `--level 2 --nobot` | **CLEAN** | 0 / 0 / 0 / 0 | 6.6 | L2 clear ★★☆, 93 survivors | 10 610, 143.9, 7.1 / 7.1 / 27.9 | none | – |
| play L5 | `--level 5` | **CLEAN** | 0 / 0 / 0 / 0 | 6.8 | L5 clear ★★☆, 145 survivors (m1: ★★★ 165, see fix 1) | 12 238, 143.9, 7.1 / 7.1 / 20.9 | none | ≈ 15 s (timeline) |
| play L8 rank 3 | `--level 8 --pre "g.save.setUpgrade('squad',3);…('fireRate',3);…('damage',3)"` | **CLEAN** (re-run, details after the table) | 0 / 0 / 0 / 0 | 6.1 | L8 clear ★★★, 303 survivors | 13 082, 143.9, 7.1 / 7.1 / 27.6 | none | – |
| play L10 boss | `--level 10 --boss --after "g.squad.setCount(280,'debug')"` | **CLEAN** | 0 / 0 / 0 / 0 | 6.6 | L10 clear ★★☆, 187 survivors | 3 520, 144.0, 7.1 / 7.1 / 7.2 | none | **18.7 s** (HP 7 000, C 280 → 187) |
| play L20 boss | `--level 20 --boss --after "g.squad.setCount(600,'debug')"` | **CLEAN** | 0 / 0 / 0 / 0 | 6.7 | L20 clear ★★★, 482 survivors | 4 101, 144.0, 7.1 / 7.1 / 7.2 | none | **22.0 s** (HP 15 000, C 600 → 482) |
| play endless | `--endless --seconds 150` | **CLEAN** | 0 / 0 / 0 / 0 | 6.6 | alive at 150 s: 1 392 m (chunk 5), C 257 (peak 330) | 20 410, 143.9, 7.1 / 7.1 / 27.9 | none | – |
| all, sandbox | `--scenario all --shell sandbox` | **CLEAN** | 0 / 0 / 1 (expected "Progress won't be saved") / 0 | 5.1 | L1 clear ★★★, 256 survivors | 8 716, 143.9, 7.1 / 7.1 / 20.9 | none | – |
| all, artifact | `--scenario all --shell artifact` | **CLEAN** | 0 / 0 / 0 / 0 | 5.5 | L1 clear ★★★, 256 survivors | 8 730, 143.9, 7.1 / 7.1 / 20.8 | none | – |
| play Low 60 s | `--quality low --seconds 60` | **CLEAN** | 0 / 0 / 0 / 0 | 5.9 | tier Low; boss dead at 60 s (phase won), C 247 | 8 262, 143.9, 7.1 / 7.1 / 27.9 | none | – |
| all, desktop | `--scenario all --desktop` | **CLEAN** | 0 / 0 / 0 / 0 | 6.5 | L1 clear ★★★, 256 survivors | 8 826, 143.9, 7.1 / 7.1 / 20.9 | none | – |

**The L8 retry.** The first attempt (`EV/m2-play-l8-r3-bootfail-attempt1/`) failed to boot:
- `net::ERR_NO_BUFFER_SPACE` on the loopback fetch of `js/models.js`. That is the Windows socket error WSAENOBUFS, raised before any game code ran.
- The page showed the designed "Load error" box.
- The socket table was normal right after (175 TCP entries). The re-run and every later boot were clean.

**Screenshots checked.**
- `m2-play-l1/07-play-49s.png`: a 267-soldier blob with a clean count label.
- `m2-play-l1/09-result.png`: "LEVEL 1 CLEAR", three stars, chips, "239 survivors", a badged SHOP and the bright coin pill.
- `m2-play-l20-boss/03-play-17s.png`: Colossus Prime with its bar, two-column damage numbers and the count label.
- `m2-ui/02-shop-bought.png`: the new coin-multiplier badge.

**Baseline (m1, the handed-over code): all 13 runs CLEAN** (`EV/m1-table.md`).
- End states match m2 within bot variance, except L5: ★★★ 165 against ★★☆ 145 (fix 1).
- Two frames went over 50 ms: 83.3 ms in L8 at 40.65 s and 138.9 ms in L10 at 7.82 s. Both fell inside my own concurrent browser probes (`genjit`, `bossprobe`); m2 ran with nothing else on the host.
- m1's endless frame stats cover only its last 931 frames (fix 5).

### Boss TTK

| Case | m1 (handed over) | m2 (final) | Target |
|---|---|---|---|
| L10 Juggernaut, C = 280 = E_boss | 18.8 s (7 000 HP, C → 187, 2★) | **18.7 s** (7 000 HP, C → 187, 2★) | ≈ 8–25 s (GDD §7); 10–16 s at C = E in the LVL-14 table |
| L20 Colossus Prime, C = 600 = E_boss | 22.1 s (15 000 HP, C → 482, 3★) | **22.0 s** (15 000 HP, C → 482, 3★) | ≈ 8–25 s; §17's 12–22 s |
| L5 Spitter Queen, smoke bot (timeline, ± 1 s) | ≈ 10 s; one sniper shot took the last 43 % | ≈ 15 s, through phase 3 | ≈ 8–25 s |

L10 at E is still above the LVL-14 table's 10–16 s, as in round 2, where it measured 19.7 s.

### Endless

- **This pass's run.** The m2 run (`--seconds 150`) is alive at 150 s, at 1 392 m (chunk 5).
  - C peaked at 330 and plateaued at 210–290 from 60 s on; 257 at the end. No mini-boss was reached.
  - Pickups: armor, minigun, railgun, chip.
  - Worst frame 27.9 ms over 20 410 frames.
- **m1** (another random seed) was alive at 1 390 m with C 340.
- **Consistency with the design.** Both runs fit GDD §10.1: a strong player dies around chunk 9–14 (≈ 4–7 min).
- **Fix 1 in endless.** The balance audit's seed 9075 still ends: chunk 27 before the fix, chunk 25 after.

### 4× CPU-throttled L1 at Medium

`EV/tools/throttle.mjs --rate 4 --level 1 --quality med --seconds 100 --prio`, 390 × 844 at DPR 2.75, smoke's bot. Runs a and b already carry fixes 1–3; final-1 and final-2 add fix 4, which only touches the boot.

| Run | Code | fps mean | frames ≥ 55 fps | frame p50 / p95 / p99 / max (ms) | JS mean / p95 (ms) | draw mean (ms) | Long tasks (s: ms) |
|---|---|---|---|---|---|---|---|
| old-a | handed over | 80.1 | 80.9 % | 13.8 / 20.9 / 27.9 / 159.8 | 8.48 / 15.3 | 6.87 | **64.7: 136 (results + 1.0 s)**, 50.0: 96 (boss arrival), 63.7: 93 (results), 60.7: 63 |
| old-b | handed over | 63.8 | 66.1 % | 13.9 / 21.0 / 27.9 / 159.6 | 10.96 / 15.9 | 8.83 | 53.7: 134 (boss fight), **64.9: 112 (results + 0.9 s)**, 50.0: 82, 8.7: 76 (first gate) |
| a | fixes 1–3 | 68.0 | 76.5 % | 13.9 / 27.9 / 41.7 / 90.4 | 8.35 / 12.0 | 6.70 | 50.0: 62 (boss arrival), 63.6: 59 (results show) |
| b | fixes 1–3 | 94.5 | 96.5 % | 7.1 / 14.0 / 20.9 / 55.7 | 7.26 / 10.5 | 5.96 | 8.7: 59 (first gate), 0.0: 52 |
| **final-1** | final | **116.3** | 98.2 % | 7.0 / 14.0 / 20.8 / 62.5 | 5.74 / 9.6 | 4.71 | none |
| **final-2** | final | **110.9** | 97.7 % | 7.0 / 14.0 / 20.9 / 118.1 | 6.14 / 10.2 | 5.06 | 57.9: 107 (outside rAF, mid boss fight; that frame's JS was 7.9 ms, most likely GC) |

- **The results long task is gone.** The old code's 112–136 ms task 0.9–1.0 s after the results (frames of 125–160 ms) appears in none of the four runs with fix 3.
- **No tier changes.** Every run cleared L1 (241–242 survivors). 0 errors, 0 warnings.
- **The host decides the absolute numbers.** The same code gave 68–94.5 fps in runs a and b and 111–116 fps in the final pair, later on a quieter host. Judge 4× numbers as interleaved pairs only.
- **Other long frames in the final pair** (4×):
  - the boss arrival, 48.7 ms (38 ms of JS);
  - the results show, 48.7 ms;
  - the run-up and the boss death, 55.5–62.5 ms;
  - the first gate pass, 34.8 ms.

  Round 2 measured a 34.8 ms results show plus the 62.5 ms prefetch frame.

### Boot under 4× CPU throttling (VIS-17 / CORE-9: no painted gap > 300 ms)

`EV/tools/bootab.sh`: interleaved old / new boots, `throttle.mjs --bootOnly`, Medium, 390 × 844 at DPR 2.75.

| Set | Gaps > 300 ms | Worst gaps, ms at bar % | Span, first bar → title |
|---|---|---|---|
| `bootab-final`, quiet host, old ×4 | 0 / 0 / 0 / 0 | 236–257 at 33.9–34.1 % (boss rigs) | 4.14–4.28 s |
| `bootab-final`, quiet host, **new ×4** | 0 / 0 / 0 / 0 | **201–222** at 25.5 % (AudioContext) or 93.4 % (prewarm) | 4.08–4.36 s |
| `bootab4`, loaded host, before fix 4: old ×4 | 1 / 0 / 0 / 3 | 257–417 at 34.1 %, 326–472 elsewhere | 4.8–7.0 s |
| `bootab4`, loaded host, before fix 4: new ×4 | 0 / 0 / 0 / 0 | 229–292 at 30 % (fx init) | 4.9–5.6 s |

- The boss-rig frame at 34 % is gone, and so is the atlas step at 8 %.
- In the final throttled runs the boot's worst gaps were 222 ms and 229 ms, and the title's worst frames 20.9 ms and 62.5 ms.

## 4. What I fixed

1. **Endless mini-bosses died to one sniper shot** (balance-audit §5; gameplay).
   - **Root cause.** The sniper's boss shot is `40·hz·d·0.5`, with hz = the latest wave's HP scalar.
     - Round 3 made endless wave hz carry the ×9 design multiple and the pressure. The mini-boss HP carries neither, so one shot was 110–420 % of a mini-boss.
     - In the campaign, the L5 run-up hz is ≈ 190, so a clear boss shot is ≈ 3 800 HP, ≈ 80 % of the L5 table HP. GDD §7 wants every phase seen.
   - **Fix.** `TROOPS.sniper.bossCapFrac` 0.05: a boss shot is at most 5 % of the boss's max HP, before the shop's boss-damage multiplier (`js/troops.js` `_stepSniper`, `SNIPER_BOSS_CAP`).
     - Zombie shots are unchanged.
     - GDD §8.3 and ARCH §6.6, §7 and §8.4 updated.
   - **Verified in endless** with the audit's probe: `EV/tools/fast/bossprobe.mjs 9075`, smart bot, ranks 6 / 6 / 6 / 3 / 6; output in `EV/sniper-{before,after}-9075.json`.

     | Mini-boss | Before: TTK, sniper hit | After: TTK, sniper hits |
     |---|---|---|
     | Juggernaut, 66.5–66.9k HP | **0.48 s**: one hit of 63 694 (95 % of max) | **6.55 s**: 4 hits of 6 318 (9.5 % = 5 % × boss damage 1.9) |
     | Spitter Queen, 107–114k HP | **1.57 s**: one hit of 105 309 | **8.68 s**: 5 hits of 10 198 |
     | Hulk, 139–144k HP | **2.43 s**: one hit of 135 337 | **12.52 s**: 7 hits of 13 210 |
     | First Hulk (no sniper yet) | 12.25 s | 12.25 s |

     The run still ends: chunk 27 before, chunk 25 after on this seed. The audit's own experiment (bossMult 0.02) found the death distribution unchanged.
   - **Campaign impact, measured** (`EV/l5cap.txt`; `EV/tools/fast/l5cap.sh`).
     - Setup: L5, the rank-L5 profile 2 / 1 / 1 / 3 / 1, the canonical seed plus layout sets 40–44, the smart, QA-strong and passive bots, capped against uncapped through a data substitution.
     - **Stars are identical in all 18 pairs:** smart 3★ ×6; QA-strong 3, 3, 2, 3, 2, 3; passive 2, 2, 2, 1, 2, 1.
     - Survivors change by −11 to +3. TTK grows only where the sniper got a boss shot: canonical 9 → 12–14 s, passive 9–29 → 14–42 s.
     - The smoke bot plays L5 on a fresh save at rank 0, so its ★★★ 165 became ★★☆ 145. The uncapped shot had ended that fight 43 % early and skipped phase 3.

2. **Boot: the boss rigs were one 222–299 ms frozen frame at 4×** (boot-polish needsOtherGroup 1).
   - **Change.**
     - `BossSystem.init()` resolves the archetypes and queues one rig per root (two for the twin root); `initStep()` builds the next one.
     - `main.js` step 9 runs any system's deferred init slices one per painted frame (`initSteps` / `initStep()`, bounded by the count read after init) and advances the bar by each slice's share.
     - `spawn()` first builds anything still queued, so a host that never runs the slices still works.
     - ARCH §4.1 and the boss / level API blocks document the protocol.
   - **Verified.**
     - `EV/tools/bootcheck.mjs`: all 5 rigs are built by the title (hulk ×2, spitterQueen, juggernaut, colossus) and `initSteps` is 0.
     - A Spitter Queen (L5) and Hulk Twins (L17) spawn and fight, and every boss in m2 does.
     - Boot A/B in §3.

3. **The long frame after the results appear.** This is boot-polish needsOtherGroup 2, and QA's "results first frame" at 4× since round 2.
   - **Root cause.** It is the page's first levelgen attempt, run JIT-cold by the idle prefetch of L+1.
     - `EV/tools/genjit.mjs` at the title: the first attempt takes **11 ms** unthrottled and **75.5 ms** at 4×; the next ones 2.4–2.8 ms and 12.7–14.1 ms. Warm in node: 1.5–6.5 ms.
     - Splitting build and validate would not help: validate is 0.3–0.6 ms of an attempt.
   - **Fix.** `LevelRunner.initStep()`, a boot slice after the systems, runs one throwaway attempt of the first generated level (L2, seed 1002). That warms the generator behind the bar.
     - Generation is deterministic per L + seed.
     - It keeps no module state between attempts: `featurePending` is reset per attempt.
     - So nothing a player sees changes, and the validator output is identical.
   - **Verified** in the throttled runs of §3: the old code's 112–136 ms task after the results is absent in all four new runs.

4. **Boot: the atlas step's intermittent 285–510 ms stall.** Pre-existing: I saw it once at 1× and once at 4× in my first boots, and boot-polish saw it in 2 of ≈ 20 runs.
   - **Root cause.** The digit atlas draws ★ and ⚡ through the system-font fallback.
     - In a fresh page, the first `measureText('★︎')` through `system-ui` took **49–115 ms** at 4×, and the second, resized one **6–143 ms**.
     - That is 70–250 ms of a 109–370 ms atlas paint (`EV/atlasprobe-b.txt`; `EV/atlasprobe-a.txt` times the steps, `EV/tools/glyphstall.mjs` reproduces it on a blank page).
     - Nothing in the game draws these two glyphs today, but their cells are part of the ARCH §6.3 atlas.
   - **Fix.** `TextureFactory._paintSymbol` draws ★ (a 5-point star) and ⚡ (a bolt) as paths with the digits' outline and fill, sized to the old font glyphs. It is the same approach as ÷ (VIS-5).
     - `RENDER.atlas.fallbackFont` remains for any other symbol cell.
     - ARCH §6.3 and the data comment are updated.
   - **Verified.**
     - Atlas paint at 4×: **43–65 ms** over 8 boots, against 109–370 ms (`EV/atlasprobe-c.txt`).
     - Images: `EV/atlas-old.png` against `EV/atlas-new.png`. Same layout; the star and bolt no longer depend on the platform's fonts.

5. **Harness: smoke's frame sampler reset at 20 000 intervals.**
   - At 144 Hz a run over 139 s, such as the task's `--endless --seconds 150`, discarded every earlier interval. m1's endless report covers only its last 931 frames.
   - The cap is now 200 000 (`tools/smoke.js`, commented). m2's endless run reports all 20 410 frames.

6. **Smaller items:**
   - the coin-multiplier badge (FTUE 2);
   - the label-yield data keys (FTUE 6);
   - the QA throttle tools (boot-polish 5);
   - `docs/build/CALLSITES.md` regenerated;
   - the GDD and ARCH text listed in §1.

All changes follow ARCH §14:
- **No per-frame allocation.** The new code runs at boot, once per sniper boss shot with numeric locals, or once per atlas paint.
- **Data reads are guarded** with `> 0` fallbacks.
- **No `console.log` and no `Math.random`.**

## 5. Remaining issues (honest list)

1. **Design decisions are still open.** None is a code defect; each owner's report has the measurements.
   - **Audio:**
     - should stings and the J5 flip also read ≥ 6 dB over the bed?
     - the shipped roar against V6;
     - the squared sound fader: sound 50 is −12 dB, which puts every sfx under the music at the default 80.
   - **Endless:**
     - QA's face-value "strong" bot dies at a median chunk of 7.5 (3.7 min) on the audit's seeds;
     - the shop moves endless death by only ≈ 1 chunk from rank 0 to rank 10 (lever: `profileExp`);
     - ranks 6–10 reach chunk 26–27 on ≈ 1 seed in 12 (lever: `pressure.perD`).

     These are now stated in GDD §10.1.
   - **Campaign:**
     - the L1 income ratio is 1.07;
     - "the passive player fails ≥ 2 levels" holds only on the canonical seeds;
     - L2 on rerolled layouts leaks 4.8 %, below its band;
     - L5's shiny-lane opener punishes a first-timer;
     - the ÷ ladder is never taught;
     - L4 stays 2★ for a human-like player;
     - there is no HOME button on the results screen.
2. **Validator warnings.** The 10 warnings are unchanged (§2); L13–L30 are not calibrated. levelgen still carries `NO_STEER_PENALTY` and other `DATA-MISSING` literals.
3. **4× first-use frames.** At 4× CPU, the boss arrival and the results show still cost ≈ 49 ms frames, and the run-up and boss death 55–63 ms, in the final pair. Earlier runs on a loaded host: up to 97 ms at the boss arrival and 76 ms at the first gate. The causes are audio node creation (9–18 ms), `_fireBoss` (9–10 ms) and `boss.render` (4 ms); see boot-polish needsOtherGroup 3–4, not applied (§1).
   - One 107 ms task outside rAF in the middle of a boss fight, most likely GC, appeared in 1 of the 2 final runs. old-b had a 134 ms one.
   - Unthrottled, no matrix frame exceeds 27.9 ms.
4. **Throttled numbers swing with the host.** The same code gave 68 to 116 fps mean at 4× within an hour. Compare 4× results only as interleaved pairs.
5. **Boot timing.**
   - Smoke boot wall time is 5.1–6.8 s in m2 and was 7.9–13.4 s in m1. Most of it is the three.js and font downloads from the CDNs: the game's own boot, first bar → title, is ≈ 2.5 s unthrottled (`EV/boot1-a`).
   - Under 4× the worst painted gaps are now the AudioContext construction (≈ 200–220 ms quiet, up to 550 ms on a loaded host) and the prewarm (≈ 180–230 ms).
6. **Not re-measured here:** the audio mix battery, the balance tables and the FTUE session.
   - This pass checked that the code they measured is what ships. The only gameplay change on top is fix 1, which touches the sniper's boss shot alone; its L5 effect is measured above.
   - The audio, balance and FTUE owners' numbers still describe the release.

## 6. Files changed in this pass

| File | Change |
|---|---|
| `js/troops.js` | `SNIPER_BOSS_CAP`; the capped boss shot in `_stepSniper` (fix 1) |
| `js/data.js` | `TROOPS.sniper.bossCapFrac` 0.05; `GATE_RULES.glyph.labelYieldS` / `labelYieldMargin`; the `RENDER.atlas.fallbackFont` comment |
| `js/boss.js` | rig queue, `initSteps` / `initStep()`, the spawn-time build of anything still queued (fix 2) |
| `js/level.js` | `initSteps` / `initStep()`: the levelgen JIT warm-up (fix 3) |
| `js/main.js` | step 9 runs init slices one per painted frame; `SYSTEMS` level weight 1 → 76 |
| `js/render.js` | `_paintSymbol` for ★ / ⚡ and its shape constants (fix 4) |
| `js/gates.js` | label-yield constants read from data |
| `js/ui.js` | coin-multiplier badge: an up arrow |
| `tools/smoke.js` | frame-sampler cap 20 000 → 200 000 (fix 5) |
| `docs/GDD.md` | §0 stars, §6.2 and §10 population bound, §8.3 sniper cap, §10.1 endless text, §11 3★ = 112 |
| `docs/ARCHITECTURE.md` | §4.1 boot slices; boss and level `initSteps` / `initStep`; sniper rows (§6.6, §7); atlas symbols (§6.3); data rows (TROOPS, GATE_RULES.glyph) |
| `docs/build/CALLSITES.md` | regenerated |

`index.html`, `artifact.html`, `css/` and `sw.js` are unchanged. No new files, so the PRECACHE list needs nothing.
