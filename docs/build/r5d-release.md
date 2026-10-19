# Round 5d: release 1.2.1

Owner: release engineer. Date: 2026-10-17.

**Scope.** This pass releases the round-5d endless work as 1.2.1. It covers:
- the fixer's A–D;
- the lead's T3 data;
- the pool-safe change in `r5d-endless.md`;
- the auditor's one-line `_expectedAt` fix in `r5d-audit.md` §2.

**Baseline.** `dist/` as handed over: the round-5b build of 1.2.0, `sw.js` v5. The first 1.2.0 dist (v4) is `E:/Temp/claude/gate-rush-evidence/r5b/verify/dist-1.2.0/`.

**Evidence.** `E:/Temp/claude/gate-rush-evidence/r5d/release/`, written `EV/` below.
- `src-before/` and `src-before-md5.txt` hold the handed-over tree.
- `src-final-md5.txt` holds the final tree.
- `dist-before/` and `gate-rush-dist-before.zip` hold the previous build.
- `dist-1.2.1/` and `gate-rush-dist-1.2.1.zip` hold this build.

**Verdict: PASS. Release 1.2.1 is ready.**
- **Static checks.** All green. The validator reports **0 errors**. The two pool errors in the lead handoff were closed by the pool-safe change before this pass.
- **Smoke matrix.** All 13 runs are **CLEAN**.
  - 0 frames went over 50 ms.
  - Main-pass draws peak at **48** (budget 50), shadow at 18 (budget 20).
- **Endless.** In both 330-s runs, the first mini-boss died. Its HP fell at every sample, and no gate came during the fight. Each squad was later lost to the horde, with no boss alive. No run stalled on a boss.
- **Update path.** v5 → v6 and v4 → v6 both work, and so does the pill tap.
- **Regressions.** None found. No game code changed in this pass.

## 1. Version

| File | Change |
|---|---|
| `js/main.js` | `VERSION '1.2.0'` → `'1.2.1'`; comment "round-5d release 1.2.1, sw.js v6". The title shows "v1.2.1" (`m1-boot/00-title.png`) |
| `package.json` | `"version": "1.2.1"` |
| `package-lock.json` | `"version": "1.2.1"` in the root and in `packages[""]`. The third "1.2.0" is the `pend` dependency and stays |
| `sw.js` | `VERSION 'v5'` → `'v6'`; header line "v5 → v6: release 1.2.1 (round 5d: endless numbers not HP, the mini-boss hold, pool-safe waves)" |

## 2. Docs

**`docs/ARCHITECTURE.md`:**
- **§3 `ctx.version` row.** `'1.2.1'`, "v1.2.1", `sw.js` `'v6'`. It also records that 1.2.0 shipped with v4 and its round-5b build with v5.
- **§6.4 `buildBossRig`.** The CHR-11 comment now describes the r5b rig:
  - core, plates and chains are Bones;
  - the rig draws in three SkinnedMeshes on one Skeleton: `'skin'`, `'armour'` and `'glow'`;
  - only the Colossus shield stays a Mesh;
  - plates are hidden by `visible = false` plus scale 0;
  - the Twins share geometry.

  Draws per rig: **3 main (+1 while the shield is up), 1 shadow; Hulk Twins 6 / 2**. It was "Hulk / Juggernaut 7, Queen 8, Colossus 10".
- **§9.1 scene tree.** `boss.rig`: Bones plus the three SkinnedMeshes plus the shield. "3 main draws per rig (+1 shield up), Hulk Twins 6".
- **§9.1 draw budget.** "boss ≤ 4" now adds "(round 5b: 3 per rig + 1 Colossus shield; the Hulk Twins' two rigs are 6)".
- **§15.4.** `sw.js` names `'v6'` for release 1.2.1.

**`README.md`:**
- one line, "This is version 1.2.1";
- "30 campaign levels in six districts": each district with its weather. Sunset dust, Overcast rain, Night City ash under neon, Toxic spores, Ash Wasteland embers, Frozen snow (from `DISTRICTS[*].weather.kind` in `js/data.js`);
- an **Endless mode** bullet: unlock after L10, generated road, six-district rotation, a mini-boss every fifth stretch, the hold, and the horde growing "in numbers more than toughness".

## 3. Static checks (`EV/static/`)

| Check | Result |
|---|---|
| `node --check` on `js/*.js` (22), `tools/*.js` (8) and `sw.js` | 31 files, 0 failures |
| `node tools/check-imports.js` | 0 errors, 0 warnings |
| `node tools/validate-levels.js` | 30 levels · 7 warnings · **0 errors**. Pools over D1–30 peak at 114/54/30/13/21 of 120/60/40/16/24 (`validate.txt`) |
| `node tools/build-artifact.js` | "PRECACHE covers all 22 files"; 189 lines, 15 681 bytes. `artifact.html` is byte-identical (md5 `bb48e979…`), because `index.html` did not change |
| `node tools/package.js --check` | "precache OK (31 files …; cache version v6; build f7f1faf4f05a)"; `dist/` holds 33 files, 2 570 KB |
| `console.log` / `Math.random` in `js/` and `sw.js` | comments only |

- **`dist/` against the previous build.** Exactly five files differ: `js/data.js`, `js/level.js`, `js/levelgen.js`, `js/main.js` and `sw.js`. Every other file is byte-identical to the previous build.
- **The gameplay files** match the audit's installed md5s: level.js d694c732, levelgen.js d7474173, data.js 98160562, validate-levels.js d0cf0097.

## 4. Smoke matrix

**How the runs were made.**
- Every run used `node tools/smoke.js … --bootTimeout 90 --out EV/m1-<run>`, sequentially, from 20:39 to 20:59, through `EV/tools/matrix.sh`.
- The tree was the final one (v6 / 1.2.1).
- Host: i7-8700K, RX 6800, headless Chrome on the GPU. Auto quality → High. Phone viewport, except `--desktop`.
- Fresh profile, so shop rank 0 unless `--pre` says otherwise.
- The summary is `EV/m1-summary.txt`, made by `EV/tools/summ.cjs`. The endless fight read-out is from `EV/tools/endana.cjs`.

**Columns.**
- **Frames** excludes the screenshot stalls, as the harness defines it. "> 50" counts `longFrames`.
- **Start** is the worst frame from `level.start()` through the first 2 s.
- **Calls max** is the per-frame main / shadow / post maximum over the run (`report.callsMax`).

| Run | Command | Verdict | Page err / console err / warn / failed req | Boot (s) | End | Frames: n, p99 / worst (ms) | > 50 ms | Start (ms) | Calls max | Programs |
|---|---|---|---|---|---|---|---|---|---|---|
| boot | `--scenario boot` | **CLEAN** | 0 / 0 / 0 / 0 | 5.9 | title, "v1.2.1", District 1 caption | – | – | – | – | – |
| ui | `--scenario ui` | **CLEAN** | 0 / 0 / 0 / 0 | 5.6 | every menu → title | – | – | – | – | – |
| all desktop | `--scenario all --desktop` | **CLEAN** | 0 / 0 / 0 / 0 | 6.1 | ★★★, 258 survivors; HOME click → title | 8 829, 7.1 / 20.8 | 0 | 7.1 | sunset 34 / 12 / 14 | 58 |
| play L1 | `--level 1` | **CLEAN** | 0 / 0 / 0 / 0 | 6.0 | ★★★, 239 survivors (re-run: 242) | 8 726, 7.1 / 20.8 | 0 | 48.5 (re-run 27.8) | sunset 34 / 12 / 14 | 58 |
| play L6 | `--level 6` | **CLEAN** | 0 / 0 / 0 / 0 | 6.1 | ★★☆, 161 survivors | 12 868, 7.1 / 20.9 | 0 | 21.0 | overcast 42 / 14 / 14 | 58 |
| play L11 | `--level 11` | **CLEAN** | 0 / 0 / 0 / 0 | 5.5 | alive at 110 s, 969 m, count 234, boss at 1 134 / 6 000 (r5b: 969 m, 235) | 14 998, 7.1 / 27.7 | 0 | 20.8 | night 39 / 13 / 14 | 58 |
| play L16 boss | `--level 16 --boss --after "g.squad.setCount(445,'debug')"` | **CLEAN** | 0 / 0 / 0 / 0 | 5.9 | ★★☆, 286 survivors (audit: 286) | 4 115, 7.1 / 7.2 | 0 | 20.8 | toxic 34 / 10 / 14; Hulk Twins peak frame | 58 |
| play L26 boss | `--level 26 --boss --after "g.squad.setCount(600,'debug')"` | **CLEAN** | 0 / 0 / 0 / 0 | 5.7 | ★★★, 492 survivors (audit: 492) | 3 818, 7.1 / 7.2 | 0 | 13.9 | frozen 34 / 11 / 14; boss draws 3 | 58 |
| endless rank 3 | `--endless --seconds 330 --pre "<squad, fireRate, damage, bossDamage = 3>"` | **CLEAN** | 0 / 0 / 0 / 0 | 5.9 | first mini-boss killed; squad lost at 212 s, 2 030 m, Night City, horde (§4.1) | 29 559, 7.1 / 27.8 | 0 | 7.1 | sunset 41 / 14 / 14; overcast 43 / 14 / 14; night 40 / 14 / 14 | 58 |
| endless rank 0 | `--endless --seconds 330` | **CLEAN** | 0 / 0 / 0 / 0 | 5.9 | first mini-boss killed; squad lost at 243 s, 2 341 m, Night City, horde (§4.1) | 33 618, 7.1 / 20.8 | 0 | 7.1 | sunset 41 / 14 / 14; **overcast 48 / 18 / 14; night 48 / 18 / 14** | 58 |
| all artifact | `--scenario all --shell artifact` | **CLEAN** | 0 / 0 / 0 / 0 | 5.6 | ★★★, 256 survivors; HOME tap → title | 8 736, 7.1 / 20.8 | 0 | 7.1 | sunset 34 / 12 / 14 | 58 |
| all sandbox | `--scenario all --shell sandbox` | **CLEAN** | 0 / 0 / 1 (the expected "Progress won't be saved") / 0 | 4.3 | ★★★, 259 survivors; HOME tap → title | 8 743, 7.1 / 27.9 | 0 | 7.1 | sunset 34 / 12 / 14 | 58 |
| play low L21 | `--quality low --level 21 --seconds 50` | **CLEAN** | 0 / 0 / 0 / 0 | 5.4 | tier Low; squad lost at 49 s, 587 m (rank 0; 1.2.0 also lost L21 at rank 0, at 42 %: r5-release matrix) | 6 945, 7.1 / 13.9 | 0 | 20.8 | ash 38 / 0 / 0 | 42 |

**Totals.**
- 11 play runs, ≈ 141 000 frames (plus the L1 re-run, 8 731).
- p99 is 7.1 ms in every run, and **0 frames went over 50 ms**.
- The worst in-play frame is 27.9 ms. The worst start frame is 48.5 ms, on L1's first run. Re-run on the same tree, it was 27.8 ms (`EV/m2-play-l1`). It is the third frame after `level.start()`, so it is first-draw variance, not a steady cost.
- **Main-pass draws.** The worst frame is **48**, in endless rank 0 at 141.8 s (Overcast) and 241.7 s (Night City). Neither frame had a boss on screen. Each had two troops (drone and sniper) and 25–64 zombies.
- **Boss rigs.** Every boss peak frame counts **3** boss draws. With the boss alive, the endless timeline stayed at 28–38.

### 4.1 Endless: the first mini-boss

Read from the 2-s timeline (`EV/tools/endana.cjs m1-endless-*/report.json`).

| Run | Boss (max HP) | Entry | HP at each 2-s sample | Live zombies during the fight | Gate during the fight | Outcome |
|---|---|---|---|---|---|---|
| rank 3 | Hulk, 18 950 | 152.7 s, 1 440 m, squad 302 | 18 818 → 16 266 → 12 924 → 9 946 → 6 268 → 3 655 → 1 347 (falls 6 of 6) | 0–11 (its minions) | 0 of 7 samples | dead by 165.7 s (≈ 13 s), squad 243, road empty. Squad later lost at 212.1 s / 2 030 m, Night City, 51 zombies alive, no boss: **horde** |
| rank 0 | Hulk, 7 450 | 153.1 s, 1 444 m, squad 288 | 5 920 → 4 043 → 2 467 → 1 310 → 146 (falls 4 of 4) | 0–9 (its minions) | 0 of 5 samples | dead by 162.0 s (≈ 9 s), squad 229, road empty. Squad later lost at 242.7 s / 2 341 m, Night City, 38 zombies alive, no boss: **horde** |

- Both district cross-fades (Overcast at ≈ 98 s, Night City at ≈ 194 s) peaked at 7.1–7.2 ms.
- `m1-endless-r3/25-play-161s.png` shows the Hulk at ≈ 45 % HP, with an empty road and the squad of 292 firing into it.
- `m1-endless-r0/39-play-241s.png` shows the horde death: a squad of 64, 61 zombies in front of it, and the Night City neon.

### 4.2 Service-worker update path (`EV/up-*`, r5b's `upcheck2.mjs`)

Build A is the previous `dist/` (v5) or the first 1.2.0 (v4). Build B is `EV/dist-1.2.1/` (v6).

| Scenario | Launch | Build served | Boot | Worker / caches / pill |
|---|---|---|---|---|
| next, v5 → v6 | launch 1 after the release | **A**, 26 / 26 files from v5 | 0.89 s | v6 installed and waiting (`v6/1.2.1`); **pill shown** |
| | next launch, then offline | **B**, 26 / 26 from v6 | 0.87 s / 0.87 s | "v1.2.1"; only the v6 caches; no pill |
| pill, v5 → v6 | launch 1 | A | 0.88 s | pill shown |
| | real tap on the pill | **B** after one reload | 0.77 s | controller `v6/1.2.1`; only the v6 caches |
| next, v4 → v6 | launch 1 | A, 26 / 26 from v4 | 0.88 s | v4 does not answer GET_BUILD (pre-r5b, as expected); v6 waiting; pill shown |
| | next launch, then offline | B | 0.97 s / 0.88 s | only the v6 caches |

Page errors, worker errors and console errors: 0 in every scenario.

## 5. `gate-rush-dist.zip`

**How it was made.** `node EV/tools/mkzip.cjs dist gate-rush-dist.zip`.
- It is the 1.2.0 / r5b release writer, `r5b/verify/tools/mkzip.cjs`, byte-identical to `r5/release/tools/mkzip.cjs`.
- Deflate level 9, UTF-8 forward-slash names, the `dist/` contents at the archive root.
- Not PowerShell `Compress-Archive`.

| Check | Result |
|---|---|
| Size / md5 | 984 527 bytes, `cde8e533…` (was 974 155, `9d1366f9…`) |
| Entries (`unzip -Z1`) | **33**: 4 at the root (`artifact.html`, `index.html`, `manifest.webmanifest`, `sw.js`) and 29 under `css/`, `icons/` and `js/`, all with `/`. **0 entries contain a backslash** (`EV/zipcheck/entries.txt`) |
| `unzip -t` | "No errors detected in compressed data" |
| Extracted to `EV/zipcheck/x/`, then `diff -r dist EV/zipcheck/x` | **identical** |

## 6. Remaining issues

None of these blocks 1.2.1.

1. **Brute piles for weak entries** (r5d-audit verdict 7, §3). The audit found 4 of 283 fast-runner fights with > 5 s in range and no boss HP fall. Every one was a Hulk or Juggernaut entered at 0.11–0.89·E by a bot that does not dodge. Capped wave brutes at the formation front soak the fire. Neither of this pass's endless runs met it: both entered at 288–302 soldiers. It is open for the lead: the levers are `hpCapSeconds.brute`, the per-wave brute share, `miniBossLeadM`, and a cap solved at min(E, C).
2. **Spitter pool refusals at rank 6–10** (r5d-audit §4). 1–5 spitters are dropped per run from chunk 17 on. Bodies still dying hold their pool slots. It is guarded and counted, so it is harmless. The fix needs a `zombies.usedOfType()` accessor.
3. **Juggernaut minions** (r5d-audit §1). `miniMinions.sharedSolve` is unset, so the Juggernaut's walker bursts reach 2.7× the walker cap. The data.js comment "the mini-boss's own minions … sit far below it" is wrong for it. TTK medians are 6–15 s, so this is not a wall.
4. **Deep endless chunks are pool-bound** (r5d-endless §4.1). Over D1–30 the chunks deliver 66 % of the population T3 owes. From chunk 22 on, every normal chunk sits at the 6-wave ceiling. This is by design and the validator prints it, but the late ramp is flatter than the T3 numbers suggest.
5. **One run per endless config.** Both runs use the default seed and the smoke bot. Rank 0 got further than rank 3 (2 341 m against 2 030 m), which is bot and layout variance, not a ranking. The balance claims rest on the fast-runner sets in r5d-endless §6 and r5d-audit §5.
6. **Main-pass headroom.** 48 of 50, in endless with two troops and up to 64 zombies. r5b's worst was 43. This pass's run carried one more troop. 50 has not been crossed, but the margin is two draws.
7. **The claude.ai artifact** (README option 1, `BCGzG6hs8jdLmkwtF12nnu`) was not republished in this pass. It still serves an older build (r5b-verify §6 item 5: 1.1.0).
8. **A doc placeholder.** r5d-endless.md §7 still ends with "(rank-0 probe and the second rank-0 run: filled below)" with nothing below it. The rank-0 smoke evidence is in r5d-audit §5.
9. **Not re-measured here:** the 4× CPU throttle, the slow-network update scenarios, the audio and FTUE suites, and the fast-runner balance sets (the auditor's are the latest).

## 7. Files changed in this pass

| File | Change |
|---|---|
| `js/main.js` | `VERSION '1.2.1'` (+ comment) |
| `package.json`, `package-lock.json` | version 1.2.1 |
| `sw.js` | `VERSION 'v6'`; one header line |
| `docs/ARCHITECTURE.md` | §3 `ctx.version` row, §6.4 `buildBossRig` comment, §9.1 scene tree and boss budget, §15.4 VERSION |
| `README.md` | version, six districts with weather, endless mode |
| `artifact.html` | rebuilt (bytes unchanged) |
| `dist/`, `gate-rush-dist.zip` | rebuilt (§3, §5) |
| `docs/build/r5d-release.md` | this report |

The handed-over md5s are in `EV/src-before-md5.txt` and the final ones in `EV/src-final-md5.txt`. `diff` shows only the files above.
