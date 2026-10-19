# Gate Rush — round-2 release verification

Release verifier pass after QA round 2 (inputs: `docs/build/QA-ROUND2.md`, the ten `docs/build/qa2/fix-*.md`, `docs/build/qa2/cross.md`).

**Verdict: releasable with known design-level issues.**

- **Static gates.** All green.
- **Smoke matrix.** All 13 runs **CLEAN** on the final code: 0 page errors, 0 console errors, 0 failed requests. The only warning is the expected sandbox "Progress won't be saved". No non-screenshot frame is over 50 ms; the worst is 27.7 ms.
- **Fixes made in this pass.** One regression and two defects that the first matrix pass and the targeted checks exposed:
  - a skinned-boss shadow program that linked mid-play at every first boss spawn;
  - a 48–56 ms first-pickup GPU stall on desktop and in the artifact shell;
  - the LVL-32 HUD / results metres off by one.
- **Not met.** The boss-fight length target (≈ 8–25 s) is **not met** below or at the curve on milestone levels: L10 at C = 140 takes **≈ 50 s** and L15 at C = 410 takes **≈ 26 s**. This is a design-level conflict (GDD §7 "never below the table" + the WPN-7 yield); it is not a code defect, and it is documented with measurements below.

## Environment and method

- **Host.**
  - Quiet Windows 11 host with an AMD RX 6800 (ANGLE D3D11). Headless Chrome; the panel runs at 144 Hz, so ≈ 6.9 ms frames are the norm.
  - No other headless browsers ran during timing-sensitive runs. Parallel streams were used only for checks that do not depend on frame timing.
- **Disk.** C: had about 300 MB free.
  - `docs/build/qa2/verify/` is an NTFS junction to `E:\Temp\claude\gate-rush-evidence-moved\qa2-verify` (the same approach as `qa2/cross`). Every path below resolves through it.
  - All 600 MB of trace data was deleted after analysis.
- **Tools.** My scripts are in a real folder on C:, `docs/build/qa2/verify-tools/`:
  - copies of the fixers' and testers' probes, with output retargeted to `docs/build/qa2/verify/fc-*`;
  - new probes: `members-rt`, `bossttk`, `brute`, `leak`, `firstuse`, `l1hitch`, `endless-hitch`, `progflat`, `depthkeys`, `tierswitch`, `hintprobe`, `audiograph`, `bossdps`, `firstspawn`, `msum`, `trwin`.
- **Pre-pass sources.** The three changed files as they were before this pass are in `docs/build/qa2/verify/before-verify-src/`.

## 1. Static checks

| Check | Result |
|---|---|
| `node --check` on `js/*.js` (22), `tools/*.js` (7) and `sw.js` | OK, before and after the fixes |
| `node tools/check-imports.js` | 0 errors, 0 warnings |
| `node tools/callsites.js` | `docs/build/CALLSITES.md` regenerated (605 lines) |
| Callsite members on the live game (`verify-tools/members-rt.mjs`) | **0 real gaps** (details below) |
| `node tools/validate-levels.js` | 30 levels, **0 errors**, 6 warnings (`verify/static/validate-final.txt`). The warnings are the 4 L1 authored-wave leak predictions plus the L15 / L19 weak line at 2 % / 9 %; the level fixer reported the same 6. Output is identical before and after this pass's fixes. |
| `node tools/build-artifact.js` | OK: 34 module preloads, and sw.js PRECACHE covers all 22 js files. artifact.html is byte-identical to the integrated one; the pass's changes are all in `js/`, which the artifact loads by URL. |

**How the callsite member check works.** It probes each of the 449 member references on the live `window.__game` at the title, during L1 and during a boss fight (`verify/static/members-final.json`).

- 416 members resolve.
- I read the call sites of the 33 that do not. All 33 are tool false positives:

| Kind | Count | Members |
|---|---|---|
| Comment text | 5 | `render.textures()`, `profile.damage()`, `profile.fireRate()`, `debug.enabled()`, `time.theatre()` |
| Numeric `.toFixed()` | 4 | |
| Alias resolved to the wrong object | 21 | e.g. `fx.setWorldPos` is really `fx.label.setWorldPos`; `render.w/h` is `render.size.*`; `models.tracer/muzzle/rocket` is `models.geo.*`; `quality.bloom/vmax/…` is `quality.params.*`; `profile.hitTestSeg` is `pickups.hitTestSeg` (the alias `p` is reused); `input.style` is a DOM `<input>` parameter |
| Lazily written debug fields | 3 | `debug.levelGenMs/Hits/Misses` |

I checked each real target at runtime (`verify-tools/paths-rt.mjs`), and every one exists.

## 2. Smoke matrix

All runs use `node tools/smoke.js … --bootTimeout 60 --out docs/build/qa2/verify/<tag>-<run>` (runner: `verify-tools/matrix.sh`).

- **m2** is the final code; that is the table below.
- **m1** is the same matrix on the code as handed over. It was also all CLEAN, but had three frames over 50 ms; see the note after the table.

**Final matrix (m2)**

| Run | Command (beyond `--out`) | Verdict | page err / console err / warn / failed req | End state | fps mean / p95 / worst (ms) | longFrames > 50 ms |
|---|---|---|---|---|---|---|
| boot | `--scenario boot` | CLEAN | 0/0/0/0 | title (boot 4.8 s) | – | – |
| ui | `--scenario ui` | CLEAN | 0/0/0/0 | shop, buy, levels, settings, play, pause, resume, quit | – | – |
| play L1 | `--scenario play --level 1` | CLEAN | 0/0/0/0 | complete 3★, 239 survivors | 143.8 / 7.1 / 21.0 | none |
| play L2 nobot | `--level 2 --nobot` | CLEAN | 0/0/0/0 | complete 3★, 140 | 143.9 / 7.1 / 27.7 | none |
| play L4 | `--level 4` | CLEAN | 0/0/0/0 | complete 2★, 127 (magnet picked up at 37.9 s in m1) | 143.9 / 7.1 / 20.8 | none |
| play L7 r3 | `--level 7 --pre "g.save.setUpgrade('squad',3); …fireRate 3; damage 3"` | CLEAN | 0/0/0/0 | complete 1★, 83 | 144.0 / 7.1 / 14.0 | none |
| play L10 boss | `--level 10 --boss --after "g.squad.setCount(140,'debug')"` | CLEAN | 0/0/0/0 | complete 1★, 45 (TTK ≈ 50 s) | 144.0 / 7.1 / 7.2 | none |
| play L15 boss | `--level 15 --boss --after "g.squad.setCount(410,'debug')"` | CLEAN | 0/0/0/0 | complete 3★, 314 (TTK ≈ 25 s) | 144.0 / 7.1 / 7.2 | none |
| endless 120 s | `--endless --seconds 120` | CLEAN | 0/0/0/0 | alive at 120 s, C 288; C/E ≤ 2.23 | 144.0 / 7.1 / 20.9 | none |
| all, sandbox | `--scenario all --shell sandbox` | CLEAN | 0/0/1/0 (expected "Progress won't be saved") | L1 complete 3★ | 143.9 / 7.1 / 20.9 | none |
| all, artifact | `--scenario all --shell artifact` | CLEAN | 0/0/0/0 | L1 complete 3★ | 143.9 / 7.1 / 20.9 | none |
| play Low 60 s | `--quality low --seconds 60` | CLEAN | 0/0/0/0 | tier low, alive at 60 s | 143.8 / 7.1 / 21.0 | none |
| all, desktop | `--scenario all --desktop` | CLEAN | 0/0/0/0 | L1 complete 3★ | 143.9 / 7.1 / 20.8 | none |

**Pre-fix matrix (m1) long frames:**

| Run | Frame | Cause | Fix |
|---|---|---|---|
| all, artifact | **55.5 ms** at 19.4 s | First power-up pill raster | §5 fix 2 |
| all, desktop | **55.6 ms** at 18.7 s | Same | §5 fix 2 |
| endless | **69.3 ms** at 85.3 s | Most likely the same first-pill raster (a gear.chip pill 2 s earlier); not reproduced, see remaining issue 8 | — |

m1 also had worst frames of 34.8 ms (L10 boss) and 13.9 ms (L15 boss). After the shadow-program fix (§5 fix 1) both are **7.2 ms**.

**Matrix anomaly.** The m2 endless run took **22.5 s to boot**; the other 25 boots took 3.6–7.3 s. three.js is loaded from cdn.jsdelivr.net, so this is most likely a network stall. The game still booted, and the 20 s "Still loading…" watchdog behaved as designed. It did not recur.

### 4× CPU-throttled L1 (custom script)

Script: `verify-tools/throttle.mjs`, a copy of `perf-throttled/throttle.mjs`. Command: `--rate 4 --level 1 --quality med --seconds 100`. Viewport 390×844 at DPR 2.75, smoke bot. Final code: `verify/throttle4-l1-med-final/perf.json`; pre-fix: `throttle4-l1-med/`.

| Metric | Final | Pre-fix |
|---|---|---|
| fps mean (Medium) | **120.8** (98.8 % of frames ≥ 55 fps) | 120.6 |
| JS ms mean / p95 / p99 | 5.69 / 8.7 / 12.5 | – |
| render.draw ms mean | 4.79 | – |
| Frames > 7.5 ms JS | 9.1 % | – |
| Tier changes | none | – |
| Frames > 50 ms | **1**: 62.5 ms as the results screen appears | **2**: 69.4 ms at results, 55.5 ms at the first weapon pickup |
| Boot: longest painted gaps | **604 ms and 576 ms** at 94–97 % ("Warming up the guns…") | – |

The VIS-17 / CORE-9 acceptance is ≤ 300 ms per painted boot gap, so the boot gaps fail it; see remaining issue 4.

The VIS-13 acceptance run (`--rate 4 --level 9 --quality med --seconds 90`, `verify/throttle4-l9-med`) gave:

| Metric | Result | Target / baseline |
|---|---|---|
| fps | 117 | – |
| JS mean | 6.33 ms | quiet-host baseline 7.51 |
| JS p95 | **9.6 ms** | ≤ 9 (just missed) |
| Frames over 7.5 ms | **14.4 %** | ≤ 15 % (met; was 41.9 %) |
| Frames > 50 ms | one 97 ms frame at 58.3 s, an 82 ms non-rAF long task with nothing else happening (likely GC at 4×) | – |

## 3. Screenshot review: L1, L10 boss, L15 boss

The screenshots are in `verify/m2-play-l1/`, `m2-play-l10-boss/` and `m2-play-l15-boss/` (m1 copies alongside).

- **Hints no longer cover gates. Confirmed.**
  - In `m2-play-l1/02-play-9s.png` "MORE SOLDIERS!" and in `03-play-17s.png` "×3 MULTIPLIES YOUR SQUAD" sit in a bottom pill under the squad; the gates are at the horizon.
  - `verify-tools/hintprobe.mjs` (`verify/fc-hints/hints.json`) sampled the hint every 100 ms through L1:
    - all 8 L1 hints showed in order, about 2.4 s each, at css y 748–796 of 844;
    - **0 samples** overlap a projected gate panel, the name card or the boss bar;
    - "SHOOT THE BOSS" first shows with `inIntro` false and HP 4060 / 4100;
    - all 8 ids are marked in the save only after they were displayed.
- **The boss screenshots look right.**
  - Boss damage numbers form a clean two-column grid (FX-12), and impact sparks land in the torso band, not the feet (ENE-13 / WPN-9).
  - The count label sits on its plate above everything (FX-10), shadows still render, and the boss chrome is clear.
  - On the result screen the label is hidden (FX-11), the reward chips sit 2 × 2, and the Boss chip is gold (UI-30).
  - At 200 visible soldiers every row is on screen (`m1-play-l1/07-play-49s.png`, VIS-19).
  - The title squad reads olive, not as black silhouettes (VIS-15, `m1-boot/00-title.png`).
- **No hitch > 50 ms. Confirmed** on the final code: `report.frames.worst` is 21.0 / 7.2 / 7.2 ms, and `longFrames` is empty in all three runs and in the whole m2 matrix.

### Boss fight length (TTK)

Measured with `verify-tools/bossttk.mjs`, which uses the same setup as smoke `--boss --after setCount`, a fresh page per case and smoke's bot. TTK is boss:fight → boss:dead in game seconds. Output: `verify/fc-ttk/*.json`.

| Case | C / E_boss | max HP (count × shop scale) | TTK (s) | Target (LVL-14 / task) | |
|---|---|---|---|---|---|
| **L1 smoke bot run (matrix)** | 266 / 140 = 1.9 | 4 100 (1.46) | **≈ 8** (timeline) | 8–25 | ok |
| L1 C = 70 | 0.5 | 2 800 (1.00) | 30.1 | 15–25 | over |
| L1 C = 140 | 1.0 | 2 800 (1.00) | 12.4 | 10–16 | ok |
| L1 C = 336 | 2.4 | 4 750 (1.69) | 7.6 | 7–11 | ok |
| **L10 C = 140 (matrix setup)** | 0.5 | 7 000 (1.00) | **50.0 / 50.8 / 50.7** | 8–25 | **over**; the safety valve chews from 46 s |
| L10 C = 280 | 1.0 | 7 000 (1.00) | 19.7 | 10–16 | over |
| L10 C = 672 | 2.4 | 11 850 (1.69) | 12.1 | 7–11 | over |
| L10 C = 280, fire / damage / boss-damage rank 3 | 1.0 | 14 900 (2.13) | 14.3 | ≥ 8 | ok |
| **L15 C = 410 (matrix setup)** | 1.0 | 10 250 (1.00) | **26.0 / 26.1** | 8–25 | **just over** |

- **Working as specified.** TTK falls strictly with C and with the shop multiplier, HP is never below the table, and the bar shows the scaled maximum.
- **Why the targets are missed.** `verify-tools/bossdps.mjs` (`verify/static/bossdps.txt`) measured the boss HP removed per soldier-second, split by the WPN-7 yield:

| Case | Re-aim yielded | Per soldier-second, yielded | Not yielded | Overall |
|---|---|---|---|---|
| L15 / 410 | 54 % of the fight | 0.62 | 1.71 | 1.11 |
| L10 / 280 | 64 % | 1.28 | 1.86 | 1.50 |
| L10 / 140 | 33 % | 0.89 | 2.01 | 1.57 |

  - **The yield costs on-curve boss DPS.** The boss's minion bursts keep a zombie within 6 m ahead of the front row, so the whole squad fires straight; the outer columns then miss the 1.6 m capsule. The overall rate on L15 is 1.11, against the GDD §7 assumption of 1.6.
  - **Attrition and the table floor dominate below the curve.** At 0.5·E on a milestone level the squad shrinks from 140 to 45, and the HP floor is the ×1.25 table. Even at 1.6 per soldier-second the fight would be ≥ 31 s.

  See remaining issue 1 for the levers.

## 4. Fix-check table (round-2 issues marked fixed or partial)

Coverage: all **24 majors**, plus 20 minor and polish issues. "Evidence" paths are relative to `docs/build/qa2/verify/` unless noted.

| ID | Sev | Fixer status | Check in this pass | Evidence | Result |
|---|---|---|---|---|---|
| VIS-12 + GAT-7 | major ×2 | fixed; partial → met (cross) | `glyphprobe.mjs` (real frame read-back at z −38…−34) on High, Medium and Low | `fc-glyph-{high,med,low}/glyph.json` | **PASS.** Minimum glyph contrast:<br>• High: 3.91 behind, 3.58 surround, 3.39 surround+halo<br>• Medium: 4.24 / 4.00 / 3.70<br>• Low: 4.90 / 4.21 / 3.75<br>All ≥ 3:1. |
| GAT-6 + CHR-10 + LVL-20 | major ×3 | fixed | `t5-squad` (squad killed 0.6 s and 0.15 s before a +20 pair) and `t17b` case E | `fc-logs/t5-squad.log`, `fc-logs/t17b.log` | **PASS.** `gate:miss` ×2, no `gate:pass`, count stays 0. The only coin is the 1-coin LVL-21 consolation, and `run.gatesPassed` stays 0 → 0. |
| CHR-9 | major | fixed (APC under label) | smoke L14 with all five troops, 2 s shots | `fc-troops14/*.png` | **PASS.** The squad and the label read. The sniper stands on the left flank and is fully on screen, the drone is ahead-right, the APC is ahead (the label draws over its rear deck, as documented). See remaining issue 6 for draw calls. |
| ENE-12 | major | fixed | `brute.mjs`: 4 approach cases, plus 2 brutes spawned touching the flank behind the front row (z +1 / +2) | `fc-brute/report.json`, `fc-brute-inside/report.json` | **PASS.** Flank contacts walk to the front, and every bite lands at z ≤ −0.33 (maxContactZ −0.3). All 6 brutes die by bullet after 1–2 swings, costing 3–6 soldiers each. |
| WPN-7 | major | fixed | `vsmoke` L4 boss, C = 93, two 400 HP brutes at 9 s; rifle, and separately laser | `fc-soak-l4`, `fc-soak-l4-laser` (`report.json`: `wrec`) | **PASS.** Rifle: the brutes die 2.6 s and 4.9 s after contact. Laser: under 1 s. Boss HP keeps falling, there is no weapons `warnOnce`, and shots/s = C·f. |
| LVL-14 | major | fixed (targets partly met) | `bossttk.mjs` count sweep, reps, shop rank 3 | `fc-ttk/*.json` | **PARTIAL.** Monotonic and floor-correct, but TTK misses the targets below and at the curve (§3). |
| LVL-15 | major | partial | `leak.mjs`: L4, L7, L9, L12 at base ranks with the bot, per wave | `fc-leak/leak.json` | **PARTIAL.** Waves bite now (5/7, 5/7, 5/8 and 4/4 waves). Median leak is 16.7 / 28.6 / 25 / 31.3 %: L4 is inside its band, L7, L9 and L12 are above it. A fresh-save bot dies on L12's early waves. |
| LVL-16 | major | fixed | validate-levels L/R column and the new check | `static/validate.txt` | **PASS** (the validator check passes on L1–L30). Note: smoke L2 `--nobot` still gets 3★, because the squad parks in the right lane and that lane is the one shot to MAX. |
| LVL-17 | major | partial | endless smoke 120 s (m1 + m2) | `m2-play-endless/report.json` | **PARTIAL.** C/E stays ≤ 2.23 (m2) and ≤ 2.2 (m1). The guard shrinks the lanes ("+15 \| +15") or halves both ("÷2 \| ÷2", m1) as C nears 2·E. Whether runs end was not re-measured; the fixer's 900 s runs were still alive. |
| LVL-18 | major | fixed | `spikes-fix.mjs` at 4× Medium | `fc-spikes-r4/spikes.json` | **PASS.** Cold `start(9)` takes 109.7 ms; the prefetched `start(9)` takes **5.2 ms** (≤ 20) and RETRY **3.8 ms** (≤ 5). Programs stay flat at 58. |
| LVL-19 (+ LVL-29) | major | fixed | `t17b` cases A–E | `fc-logs/t17b.log` | **PASS.** QUIT and RESTART in the death theatre commit the clear (162 / 160 coins, 3★, highestUnlocked 2). A normal clear credits once. A pause in the theatre delays the results to 1601 ms after resume (expected 1600). |
| UI-18 (+ UI-25, LVL-24, LVL-25, LVL-33) | major | fixed | `hintprobe.mjs` plus L1 screenshots | `fc-hints/hints.json` | **PASS** (see §3). |
| UI-19 | major | fixed | `t11-ui` first opens, `resflow` (×2 and 4×), `firstuse` on desktop | `fc-ui-t11-*`, `fc-firstuse-desk*` | **PASS after this pass's fix 2.** First LEVELS / SHOP / SETTINGS opens peak at 7.1–7.2 ms. The results screen has no rAF over 30 ms unthrottled (one 63 ms frame at 4×). The first-pill 48 ms flush on desktop and in the artifact shell is **fixed here**. |
| UI-20 | major | fixed | `t21-reset-doubletap` | `fc-logs/t21-reset-doubletap.log` | **PASS.** An 80 ms touch double-tap and a mouse double-click keep the save; a second tap after 1 s wipes it. |
| AUD-4 | major | fixed | `audiograph.mjs`: fanfare started inside slow-mo 0.25 | `fc-audio/audio.json` | **PASS.** The fanfare voice is `fixedRate`, with all 12 sources at 0 cents; an ordinary cue at the same moment is at −617 cents. |
| AUD-5 | major | fixed | live graph | `fc-audio/audio.json` | **PASS.** Compressor −18 dB, knee 6, 6:1, then a limiter (−1 dB, knee 0, 20:1), then a soft clip (4097-point curve), then the master. |
| AUD-6 / AUD-7 | major ×2 | fixed | cue data on the live build | `fc-audio/audio.json` | **PASS** (data level). The cues have `coalesceMs` 40 and `stackDb` {2, 6}, `maxPerFrame` is 2, the roar layers are 0.4 / 0.2 and the boss volume is 0.4. The dB results are the fixer's recordings and were not re-recorded. |
| AUD-8 | major | fixed | `t11-audio` (with and without the autoplay flag) and `t11-ui` | `fc-aud-t11-*`, `fc-ui-t11-firstplay` | **PASS.** The AudioContext is built at boot (88 ms, behind the bar). The first PLAY tap's worst frame is **27.8 ms** (was 1 680), `unlock()` takes 0 ms, and the music is in 'level' after the tap. |
| CORE-5 | major | fixed | `secondtap` on iphone14 and android360, `twofinger` | `fc-touch/*.json`, `fc-logs/twofinger-iphone14.log` | **PASS.** The pointer id stays 2 and targetX reaches 2.1; a second finger does not take over. |
| CORE-6 | major | fixed | `scalersim` (11 scenarios), and the 4× throttle runs | `static/scalersim.out` | **PASS.** On 120 Hz and 90 Hz panels a 60 fps Medium is never demoted; 30 fps still drops; a 4 s freeze does not trigger a change. |
| CORE-7 + ENE-17 + VIS-18 + UI-28 | minor | fixed | `t2-boss` cases A–F | `fc-t2-boss/report.json`, `fc-logs/t2-boss.log` | **PASS.** After a 4.5 s pause the intro resumes (inIntro true, the boss walks in from z −39.9). Slow-mo resumes at 0.25 with 0.94 s left. A hidden tab during the death stays paused. |
| VIS-22 (+ the no-mid-play-link part of VIS-14 / ENE-15 / GAT-8) | polish (+ minor ×3) | fixed | `progflat.mjs` (L1, L5, L10, L15, L17, L20 on High; L1, L5, L17 on Medium; L1, L15 on Low; all five troops, rocket, every boss) and `tierswitch.mjs` | `static/progflat.txt` | **PASS after this pass's fix 1.** Programs stay flat (58 / 58 / 42) from the title through every fight. Tier switches while paused have no hitch. The shadowchurn2 re-resolution count (VIS-14) was not re-run. |
| VIS-21 | polish | fixed | `t16-gfx` (context loss and restore ×2, run alone) | `fc-t16-gfx-alone/report.json` | **PASS.** 0 console warnings, programs back to 58, gameplay recovers. |
| CHR-11 | minor | fixed | main-pass draws in the boss runs | m2 L10 / L15 overlays | **PASS.** Main pass 37–40 during the fights (budget 50). |
| FX-10 / FX-11 / FX-12 / UI-30 | minor ×3 + polish | fixed | screenshots | `m2-play-l1/10-result.png`, `m2-play-l15-boss/03-play-17s.png` | **PASS.** |
| VIS-15 / VIS-19 | minor + polish | fixed | screenshots | `m1-boot/00-title.png`, `m1-play-l1/07-play-49s.png` | **PASS.** |
| LVL-26 | minor | fixed | `report.pickups` of the L4 smoke run | `m1-play-l4/report.json` | **PASS.** `gear.magnet` is picked up at 37.9 s. |
| LVL-32 | polish | fixed | the issue's own smoke command | `fc-endless-die/02-result.png` → `fc-endless-die-fixed/02-result.png` | **FAIL → fixed here (fix 3).** Before: HUD "36 m" against "Distance 37 m". After: 37 = 37. |
| CORE-11 + UI-24 | polish + minor | fixed | `t8-meta all` | `fc-logs/t8-meta-all.log` | **PASS.** `?reset=1` is dropped from the URL, and a reload keeps 55 coins. highestUnlocked 9999 opens LEVELS in 0 ms (61 tiles, 737 nodes). A corrupt huge unlock reloads as 1. |
| VIS-13 | minor | partial | `throttle.mjs` 4× L9 Medium, 90 s, quiet host | `throttle4-l9-med/perf.json` | **MOSTLY MET.** 14.4 % of frames over 7.5 ms (≤ 15 %), JS p95 9.6 ms (target ≤ 9). |
| VIS-17 + CORE-9 | minor ×2 | fixed / partial | `throttle.mjs` 4× boot | `throttle4-l1-med-final/perf.json` | **FAIL.** Painted gaps of 604 / 576 ms at 94–97 % (target ≤ 300). |

## 5. What I fixed

1. **Regression: a shader program linked mid-play at the first boss spawn on every shadow tier.**
   - **Symptom.** `verify/static/depthkeys.txt`, before vs. after: programs went 58 → 59 at the first boss spawn on High and Medium. The new program was `depth` with skinning, numDirLights 0 and numDirLightShadows 0. That breaks GDD §16 "no new shader programs during play", and on mobile it is a link hitch inside the boss intro.
   - **Root cause.**
     - The round-2 cross-group `OverlayRenderPass` renders the same `scene` object, with a camera that sees only layer 30. So three's per-scene render state is left with **zero lights** after every frame.
     - three r170 renders the shadow map *before* `setupLights()`. The next frame's shadow pass therefore resolved depth programs with a no-light key, unlike the warm-up compile, which keys them with the sun.
     - The shared depth material links a new program whenever it changes object kind. The CHR-11 skinned boss body was the first such change, and it hit at every first boss spawn.
   - **Fix** (`js/render.js`).
     - The lights carry `OVERLAY_LAYER`, as they already carry `WARM_LAYER` for the warm camera, so the overlay render leaves the main pass's light setup in place.
     - `OverlayRenderPass` turns `shadowMap.autoUpdate` off for its own render. Its camera sees no casters, so a shadow render there would clear the map.
     - ARCH §6.3 `overlayLayer` is amended to match.
   - **Verified.**
     - `progflat`: flat on High, Medium and Low through L1, L5, L10, L15, L17 and L20 with all troops.
     - The boss-run worst frame went from 34.8 to 7.2 ms (L10) and from 13.9 to 7.2 ms (L15).
     - Tier switches link fewer programs: High / Medium settle at 100 / 98 programs, against 104 / 102 before (the Low set also grew 93 → 97 on a second cycle).
     - Shadows and the post-bloom label render as before (m2 screenshots).

2. **First power-up pill: a 48–56 ms GPU raster stall** on desktop (1280×800) and in the artifact shell. It was also the most likely cause of the m1 endless 69 ms frame.
   - **Root cause.**
     - A trace (`l1hitch --trace`, analysed with `trwin.cjs`) showed the frame was not JS (1.3 ms). It was a 47 ms `RasterDecoderImpl::DoEndRasterCHROMIUM` on the GPU main thread, waiting on ANGLE shader-compile worker tasks, right after `#powerups` was painted.
     - UI-19's prewarm painted pill 0 statically. The real first show runs the `KF_POP_IN` Web Animation, which composites the pill on its own layer with the ring mask and the icon drop-shadow. That path was never rastered before the first pickup.
   - **Fix** (`js/ui.js`).
     - `_prewarmFill` runs the same `KF_POP_IN` animation on the prewarmed pill.
     - `_prewarmRestore` cancels it.
     - `_prewarmAnim` is declared in the constructor (ARCH §14 rule 11).
     - ARCH §6.14 `prewarm()` is amended.
   - **Verified.**
     - `firstuse --desktop`: the first item's frame went from 48.5 ms to none over 30 ms (`fc-firstuse-desk` vs. `fc-firstuse-desk-fixed`).
     - The `l1hitch` desktop UI-first run has no frame over 30 ms.
     - The m2 desktop and artifact matrix runs have worst frames of 20.8 / 20.9 ms.
     - At 4×, the first weapon pickup no longer exceeds 50 ms.

3. **LVL-32 residual: endless HUD metres ≠ results distance.**
   - **Root cause.** The ui HUD floors the metres, but `_commitEndless` rounds them.
   - **Fix** (`js/level.js` `_emitProgress`). In phase 'lost' the HUD now gets `Math.round(_deathDistance)`.
   - **Verified.** The issue's own smoke command now shows HUD 37 m = Distance 37 m.

All three changes passed `node --check`, check-imports, callsites, validate-levels (identical output) and build-artifact, followed by the full m2 matrix (all CLEAN, no frame over 50 ms).

## 6. Remaining issues (honest list)

1. **Boss fights fall outside ≈ 8–25 s below and at the curve** (LVL-14 targets partly met). **Design decision needed.**
   - **Measured:**

     | Case | TTK |
     |---|---|
     | L10 at 0.5·E | ≈ 50 s (the safety valve decides the end) |
     | L1 at 0.5·E | 30 s |
     | L15 at E | 26 s |
     | L10 at E | 19.7 s, against the 10–16 target |

   - **Cause.** GDD §7's "never below the table", plus the milestone ×1.25, plus the WPN-7 yield. Minion bursts keep the re-aim yielded for 33–64 % of a fight, which costs 30–64 % of boss DPS.
   - **Levers for the lead:**
     - yield only the columns in a threat's lane, or only to brutes / zombies inside about 2 m;
     - lower `BOSSES.hpPerE` or the milestone factor;
     - allow a count scale below 1 under the curve.
2. **LVL-15 partial.**
   - Leak runs above its band on L7, L9 and L12 at base ranks (25–31 %).
   - The bands in GDD §6.3 and the "8–12 % of C" in §17 contradict each other (fixer).
   - A fresh-save bot dies on L12's opening waves; acceptable only if L12 is never reached without upgrades.
3. **LVL-17 partial.** C/E is now held at about 2 or less, but endless runs still do not end (fixer's 900 s runs). An end condition is a design decision.
4. **Boot under 4× throttling.** Painted gaps of 604 / 576 ms remain at the end of the warm-up (target ≤ 300 ms; VIS-17 / CORE-9). The unthrottled boot is about 5 s to the title.
5. **4× lens frames.**
   - The results first show is 62.5 ms.
   - The boss arrival frame is 41.8 ms (35 ms of JS).
   - One 82 ms non-rAF task in L9, likely GC.
   - Medium JS p95 at 4× on L9 is 9.6 ms (VIS-13 target ≤ 9).
6. **Draw budget with all five troops.** The main pass is 51 and the shadow pass 22 at L14 with C = 52 (budget 50 / 20; `fc-troops14/08-play-15s.png` overlay). Boss fights are within budget.
7. **Fixer-reported partials not re-measured here:**
   - LVL-21: the bad bot needs 5 attempts on L7.
   - LVL-22 / LVL-23: income rewards skill on only 4 of 12 levels.
   - AUD-10: the gate-pass reward rises 4.4–5.5 dB at minimum, against ≥ 6 dB.
   - ENE-18: the light offset is −1.0 m instead of +1.5 m, and the Colossus belt plate is still warm.
   - The WPN-8 / ENE-16 / GAT-9 / FX-14 45 s allocation windows are above target because of JIT warm-up; steady state is met.
8. **The m1 endless 69 ms frame is unattributed.** Six replays (the five candidate seeds recovered from the run's gate sequence, `findseed.mjs`, plus one more) and the m2 run show no frame over 30 ms after fix 2. The cause is probably the first gear pill, but that is not proven.
9. **Polish:**
   - The title caption reads "Level 1" while the HUD and results read "LEVEL 1" (GDD §14 UI-33 says "one spelling").
   - `ctx.debug` gains `shotsPerSec`, `laserBeams` and `levelGen*` lazily, not declared up front (ARCH §14 rule 11).
   - levelgen still carries 23 `DATA-MISSING` literal lines, 3 of them new in round 2.
   - `tools/callsites.js` reports 33 false-positive members (QA tooling follow-up).
10. **Environment.**
    - C: has about 300 MB free; evidence lives on E: through junctions.
    - three.js is CDN-loaded, so one boot in 26 took 22.5 s.
