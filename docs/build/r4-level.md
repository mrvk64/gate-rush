# Round 4: level (÷ ladder hint, endless shop effect, label-yield keys)

Owner: level / levelgen (`js/level.js`, `js/levelgen.js`; data keys `HINTS.div`, `LEVELS.endless.*`, `GATE_RULES.glyph.labelYieldS` / `labelYieldMargin`).
Date: 2026-10-09. All evidence is under `E:/Temp/claude/gate-rush-evidence/r4/level/`, written `$EV` below. The sources as handed over are in `$EV/src-before/`, with their md5 list in `md5.txt`.

## Verdict against the lead's decisions

| # | Decision | Result | Status |
|---|---|---|---|
| 1 | Teach the ÷ ladder with a once-ever hint at the first ÷ lane spawn | `HINTS.div` = "SHOOT ÷ TO CLIMB: ÷2 → ×1 → ×2", shown by `level._onGateSpawn`. L3 shows it at 170 m (canonical seed, the ÷2 \| −13 pair). It fits on 2 lines in the pill at 390 px, does not repeat on a replay, and is marked done in the save | **done** |
| 2 | Endless: the shop moves the strong / smart bot's median death chunk by ≈ 3 from rank 0 to rank 10, keeping r3 at 9–14 and passive r0 at 3–5 | On the current code it **already does**. Pooled over 36 seeds, the smart bot's medians are 8 / 10 / 13 at r0 / r3 / r10. The paired per-seed gain from r0 to r10 is a median of **+4** chunks (mean +6.1). r3 is 9–10.5 on every seed set; passive r0 is 3.5–5. `profileExp` stays 0, because any value > 0 pushes r3 under 9 (§2) | **met with no data change** |
| 3 | Move `GATE_RULES.glyph.labelYieldS` / `labelYieldMargin` into data.js | The round-3 verifier had already done it: `js/data.js:195–197` holds 0.1 / 1.1, and `js/gates.js:106–107` reads them with guarded fallbacks. I verified it and changed nothing | **already done** |
| — | `node tools/validate-levels.js` at 0 errors | 30 levels · 10 warnings · **0 errors**. The output is identical to the round-3 audit's apart from timings (`$EV/validate-after.txt`) | ok |

## 1. The ÷ ladder hint

### Changes

| File:line | Change |
|---|---|
| `js/data.js:1482–1486` (line numbers as of 11:07; other owners edit data.js above it) | New `HINTS.div: 'SHOOT\u00A0÷\u00A0TO\u00A0CLIMB: ÷2\u00A0→\u00A0×1\u00A0→\u00A0×2'`, with a comment. |
| `js/level.js:1593–1598` | `_onGateSpawn`: a ÷ gate (`gate.op === '/'`) whose script lane can still flip to ×2 (`lane.cap > 1`, or no script lane) calls `showHint('div')`. |
| `docs/GDD.md:159` | The ÷D row of the gate table names the hint. |
| `docs/ARCHITECTURE.md:726` | The `showHint` block in the level API. |
| `docs/ARCHITECTURE.md:825` | The round-4 data note. |
| `docs/ARCHITECTURE.md:1009` | The `HINTS` listing. |

**Hint rules.** The hint goes through `showHint`, so it follows the existing rules:
- unknown or done ids are skipped;
- it shows at most once per run;
- ui queues it and calls `save.markHint` when it is actually displayed;
- it uses the bottom-anchored pill, which never sits over the gates.

**The endless exception.** The endless gate guard caps a ÷ lane at ×1 (`cap 1`) on a big squad. The hint would be false on such a lane, so it is skipped there.

**Allocation.** The cost is one string compare per lane spawn. Nothing is allocated, and there is no `console.log` and no `Math.random`.

### Wording

The lead's text, "÷ GATES CLIMB: ÷2 → ×1 → ×2 — KEEP SHOOTING", rendered on **3 lines** at 390 × 844 with real fonts: the pill was 319 × 85 px (`$EV/divhint/L3-first-div-1.png`).

The tighter "SHOOT ÷ TO CLIMB: ÷2 → ×1 → ×2" keeps the instruction (shoot) and the ladder.
- At first it broke as "SHOOT ÷ TO / CLIMB: …", because `#hint-text` uses `text-wrap: balance` (`$EV/divhint2/L3-first-div-0.png`).
- With no-break spaces, the only break opportunity is after the colon. The final pill has **2 lines**: "SHOOT ÷ TO CLIMB:" over "÷2 → ×1 → ×2", 319 × 61 px at y 739–800 of 844 (`$EV/divhint3/L3-first-div-1.png`, `$EV/divhint3/divhint.json`).
- In the screenshot, the pill sits under the squad, clear of the ÷2 | −13 gates and the count label.

### Behaviour

Measured with `$EV/tools/divhint.mjs`: the real rAF loop and ui, real Google fonts, Medium quality, DPR 2.75, fresh save, L3 played twice.

| Check | Result |
|---|---|
| `hint:show` order in L3 | `red` and `div` at 20.25 s / 170 m (the first ÷ event also carries `red`: a fresh save never played L1), then `crate` 29.5 s, the pickups, `boss`, `dodge` |
| Replay of L3 | no `div` hint (0 shots) |
| `save.hintDone('div')` after the first run | true |
| Page errors | 0 |

**Timing.** The hint queues behind `red` (1.5 s, because another hint waits) and then shows for 2.5 s. That is while the gate is still 70 → 40 m out, with time to shoot it.

**Where it first fires.** The first ÷ lane per level on the canonical seeds (`$EV/tools/firstdiv.mjs`) is at L3 170 m (÷2), L5 174 m, L6 160 m and later. Every one has cap 2, so the hint fires at L3 for a normal player.

## 2. Endless: the shop's effect (decision 2)

### Method

- **Runner.** The round-3 audit's fast runner, copied to `$EV/tools/` (`endless.mjs`, `harness.js`, `fastlib.mjs`, `datapatch.mjs`; output path changed only). It uses headless Chrome with the engine stepped by hand, about 250× real time, on the installed project files.
- **Configurations.** `batch.sh` runs the bots and ranks. r3 = 3/3/3/3/3, r6 = 6/6/6/3/6, r10 = 10 on all five upgrades (squad, fire, damage, coin, boss).
- **Summaries.** `endana.mjs` gives per-set summaries; `pool.mjs` gives pooled medians and paired per-seed differences.
- **Seed sets** (12 each):
  - A = 9001 + 37·i, the audit's set;
  - B = 4242 + 17·i, the balance owner's set;
  - C = 7001 + 29·i, new.

### Results

Current code; `profileExp` 0 throughout.

| Bot (ranks) | Set A | Set B | Set C | Pooled median (n) | Past chunk 25 |
|---|---|---|---|---|---|
| smart r0 | 8 (6–15) | 8.5 (6–17) | 8 (5–10) | **8** (36) | 0 |
| smart r3 | 10 (6–17) | 10.5 (9–21) | 9 (7–11) | **10** (36) | 0 |
| smart r6 | 10 (8–25) | — | 10 (9–25) | 10 (24) | 0 |
| smart r10 | 11.5 (9–27) | 14 (11–25) | 12 (10–27) | **13** (36) | 3 of 36 |
| QA-strong r0 | — | 7.5 (4–16) | — | 7.5 (12) | 0 |
| QA-strong r3 | 8 (6–15) | — | 8.5 (6–17) | 8.5 (24) | 0 |
| QA-strong r10 | — | 13.5 (9–25) | — | 13.5 (12) | 0 |
| passive r0 | 3.5 (3–6) | 5 (4–14) | 4 (3–7) | **4** (36) | 0 |

Paired per-seed differences in death chunk (`$EV/endless-before-pooled.txt`):

| Comparison | Median | Mean |
|---|---|---|
| smart r3 − r0 | +1 | +1.6 |
| smart r10 − r3 | +3 | +4.5 |
| **smart r10 − r0** | **+4** | +6.1 |
| QA-strong r10 − r0 (12 seeds) | +6 | — |

**How runs end** is unchanged: bites + spit make up 93–96 % of smart losses, and the decline from the peak takes a median of 4–6.5 chunks.

### Why profileExp stays 0

- **The premise is out of date.** Round 3's "≈ 1 chunk from rank 0 to rank 10" came from the audit, run before the verifier's sniper boss-shot cap (r3-verify fix 1).
  - The uncapped sniper one-shot every mini-boss whatever the ranks.
  - On the audit's own seeds (set A), smart r0 went from 9 to 8 with the cap, while r3 (10) and r10 (11.5) are unchanged.
  - The shop's effect is now +3.5 (set A), +5.5 (set B) and +4 (set C) in medians, ≥ the lead's ≈ 3 on every set.
- **The lever only works one way.** `LEVELS.endless.profileExp` scales wave HP by p^profileExp, with p = (fireRate / base) × damage: 1.885 at r3 and 5.0 at r10.
  - With the guard `profileExp >= 0` (level.js `_liveHpMult`, levelgen `simulateEndless`), it can only damp the shop.
  - A value that pulled r0 → r10 down toward exactly +3 would also take ≈ 0.5 chunk off r3. Set C's r3 is already 9, the bottom of its 9–14 band.
  - Pushing the shop further would need a negative exponent, which the guard rejects. The lead did not ask for more than ≈ 3, so I did not widen the guard.
- **No data change.** The only "necessary" change was none.
- **GDD §10.1 updated.** It replaces the stale "only by ≈ 1 chunk" with the measured 8 / 10 / 13 and +4, and says that profileExp > 0 only damps the shop. It also adds the r10 tail (3 of 36 past chunk 25) next to the audit's figure.

### Changes

| File:line | Change |
|---|---|
| `docs/GDD.md:409` | The tail at ranks 6–10, round-4 numbers. |
| `docs/GDD.md:413` | The shop's measured effect, and what profileExp does. |
| `js/data.js` `LEVELS.endless.*` | unchanged (`profileExp: 0`) |

## 3. Verification

From the project root.

| Command | Result | Evidence |
|---|---|---|
| `node --check` on `js/*.js` and `tools/*.js` | all OK | — |
| `node tools/check-imports.js` | 0 errors, 0 warnings | — |
| `node tools/validate-levels.js` | 30 levels · 10 warnings · 0 errors; identical to `r3/balance-audit/validate.txt` apart from timings | `$EV/validate-after.txt` |
| `grep console.log\|Math.random js/level.js js/levelgen.js` | none | — |
| `node tools/smoke.js --scenario play --level 3 --shots 4 --bootTimeout 90 --out $EV/smoke-l3` | CLEAN (0 page errors, 0 console errors, 0 failed requests); L3 won, 133 survivors. Five long frames (97, 56, 354, 76, 139 ms) while other round-4 agents were running browsers on the host; none is at the `div` hint (20.25 s game time). See the re-run below | `$EV/smoke-l3/report.json` |
| `node tools/smoke.js --scenario play --endless --seconds 150 --shots 30 --bootTimeout 90 --out $EV/smoke-endless` | CLEAN; alive at 148 s, 1 395 m (chunk 5), C 338; worst frame 27.8 ms | `$EV/smoke-endless/report.json` |
| `node tools/smoke.js --scenario all --shots 30 --bootTimeout 90 --out $EV/smoke-all` | **boot failed: not mine.** `TypeError … reading 'idleMinMs'` at `js/audio.js:122`. audio.js reads `MUSIC.warm.idleMinMs`, which data.js did not contain at the time; another owner was mid-edit (audio.js and data.js were both written at 11:04:11). See the re-run below | `$EV/smoke-all/report.json` |

**Re-runs at 11:07** (the audio owner had landed `MUSIC.warm` by then, data.js line 1208).

| Command | Result | Evidence |
|---|---|---|
| `node tools/smoke.js --scenario all --shots 30 --bootTimeout 90 --out $EV/smoke-all2` | **CLEAN** (0 page errors, 0 console errors, 0 warnings, 0 failed requests); L1 won, 256 survivors; 8 766 frames, 141 fps mean | `$EV/smoke-all2/report.json` |
| `node tools/smoke.js --scenario play --level 3 --shots 4 --bootTimeout 90 --out $EV/smoke-l3b` | **CLEAN**; L3 won, 130 survivors; 10 123 frames, 140 fps mean | `$EV/smoke-l3b/report.json` |

**Long frames are host load, not this change.** Both re-runs show frames of 55–250 ms. They appear in L1 too, which has no ÷ gate, so my change never runs there. About 20 Chrome processes from other round-4 agents were alive at the time.
- The round-3 verifier measured no frame over 50 ms on a quiet host (r3-verify §3).
- The only per-frame code this change adds is one comparison per gate-lane spawn.
- An A/B on a quiet host is left to the round-4 verifier.

Evidence index:
- `$EV/endless-before{,-b,-c}/`: per-config `*.rows.json`, `*.runs.json` and logs; summaries in `$EV/endless-before*.txt`; pooled numbers in `$EV/endless-before-pooled.txt`.
- `$EV/divhint/`: the lead's wording, 3 lines.
- `$EV/divhint2/`: the balance-wrap split.
- `$EV/divhint3/`: the final wording, 2 lines.

## needsOtherGroup

1. **Audio owner / integrator:** at 11:04, audio.js read `MUSIC.warm.idleMinMs`, `timeoutMs` and `timerMs` with no guard, and data.js had no `MUSIC.warm`. The game failed to boot (smoke `all`). ARCH §14 asks for guarded data reads. Please land the data key with the code, or guard the reads.
2. **ui / art (minor):** Lilita One has no arrow glyph, so the → in `HINTS.div` (and in `steerDesktop`'s ← →) falls back to a thin system arrow next to the heavy display digits (`$EV/divhint3/L3-first-div-1.png`). It reads, but a path-drawn arrow or a heavier fallback would match the style. Changing the text to "TO" would make the hint longer.
3. **Lead (FYI):** decision 2 is met by the build as it stands (+4 chunks paired, r0 → r10). If the lead wants the shop to count *more* than this, `profileExp` cannot do it: its guard accepts only ≥ 0, which damps the shop. The lever would need a negative exponent, a one-line guard change in `level._liveHpMult` and `levelgen.simulateEndless`. The r10 tail past chunk 25 (3 of 36) is the existing `pressure.perD` question.
4. **Lead / FTUE (FYI):** I shortened the lead's wording to fit 2 lines (§1). If "KEEP SHOOTING" must stay, the pill takes 3 lines at 390 px.
