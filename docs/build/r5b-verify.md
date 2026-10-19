# Round 5b: verification

This pass verifies the two round-5b changes on top of the shipped 1.2.0:
- `r5b-boss-draws.md`: `js/models.js` and `js/boss.js`. Every boss rig now draws in 3 main-pass draws.
- `r5b-sw.md`: `sw.js` and `js/ui.js`. The update pill shows only for another build.

The evidence root is `E:/Temp/claude/gate-rush-evidence/r5b/verify/`, written `EV/` below.

**Verdict: PASS, after one fix.**
- **Static checks.** All green.
- **Smoke matrix.** All 10 requested runs are CLEAN. 0 frames went over 50 ms. Main-pass draws peak at 43 (budget 50).
- **Boss rigs.** Their look is unchanged.
- **The fix.** As handed over, the tree could not be released. `sw.js` still said `VERSION 'v4'`, but v4 already shipped in the 1.2.0 `dist/`. `tools/package.js --check` refused the build, and a v4 player would never have received the new code. I bumped `VERSION` to `'v5'` (§2).
- **Rebuilt.** `dist/` (v5) and `gate-rush-dist.zip`. A served update from 1.2.0 (v4) to this build (v5) works, and so does the pill tap.

## 1. Static checks (`EV/static/`)

| Check | Handed over | Final |
|---|---|---|
| `node --check` on `js/*.js` (22), `tools/*.js` (8) and `sw.js` | 31 files, 0 failures | 31 files, 0 failures |
| `node tools/check-imports.js` | 0 errors, 0 warnings | 0 errors, 0 warnings |
| `node tools/validate-levels.js` | 30 levels · 7 warnings · **0 errors** | identical, timings aside |
| `node tools/build-artifact.js` | pass: "PRECACHE covers all 22 files"; 189 lines, 15 681 bytes; `artifact.html` unchanged (md5 `bb48e979…`) | same |
| `node tools/package.js --check` | **FAIL**: "sw.js VERSION is still 'v4' but the build changed (58d6a2c25386 → d1fe1b88b0fc)"; `dist/` left untouched | **pass**: "precache OK (31 files …; cache version v5; build fc83863cc030)"; `dist/` holds 33 files, 2 538 KB |
| `console.log` / `Math.random` in `js/` and `sw.js` | comments only (5 lines) | same |

**Code review of the two r5b diffs** (against `dist/` 1.2.0):
- `boss.js` (+50 lines), `models.js` (+289), `ui.js` (+117), `sw.js` (+43).
- ARCH §14 holds:
  - nothing allocates per frame: `_renderUnit` writes preallocated `Vector3`s, and `Float32Array.from` runs at record build;
  - every new browser API is guarded (`MessageChannel`, `postMessage`, `caches`);
  - no `console.log`, no `Math.random`.
- The merged rig's skinned meshes keep `frustumCulled = false`, so a flying plate bone is never culled.
- The glow formulas match the old eyes, sacs and core formulas term for term.

## 2. Fix: the service-worker version

**The problem.**
- 1.2.0 shipped `dist/` and `gate-rush-dist.zip` with `sw.js` `VERSION 'v4'`, stamp `58d6a2c25386` (r5-release §2.1).
- r5b-sw kept `'v4'` on the premise that "no v4 build has reached players". That stopped being true when 1.2.0 shipped.
- r5b changes `boss.js`, `models.js`, `ui.js` and `sw.js`. Under the same cache name, a v4 player would keep the cache-first 1.2.0 build.
- `package.js` enforces the §15.4 release rule, so it refused to build.

**The change.**
- `sw.js`: `VERSION = 'v5'`, plus a header line, "v4 → v5: the round-5b build of 1.2.0".
- `docs/ARCHITECTURE.md`: two places (the `ctx.version` row in §3 and §15.4) now name v5.
- `ctx.version` stays `'1.2.0'`. This is the "hotfix under the same `ctx.version`" case that r5b-sw tested (§4.4). Raising it to 1.2.1 is a lead decision (§6).

**The update path from 1.2.0 to this build, served** (`EV/up-*`, r5b-sw's `upcheck2.mjs`):
- Build A is `EV/dist-1.2.0/`, a copy of the shipped `dist/`. Build B is `EV/dist-final/`. Four files differ: `boss.js`, `models.js`, `ui.js` and `sw.js`.

| Scenario | Launch | Build | Boot | Worker / caches / pill |
|---|---|---|---|---|
| fresh (B only) | first visit / relaunch / offline | B, "v1.2.0" | 2.7 s / 0.86 s / 0.88 s | controller answers `v5/1.2.0`; `gaterush-v5` 32 entries; pill never shown |
| next (A installed → B deployed) | launch 1 | **A**, 26 / 26 files from v4 (one consistent old build) | 0.88 s | v5 installed and waiting (answers `v5/1.2.0`); v4 does not answer; **pill shown at 3.0 s** |
| | next launch, then offline | B, 26 / 26 from v5 | 0.98 s / 0.88 s | only the v5 caches; no pill |
| pill | launch 1 | A | 0.97 s | pill shown at 3.0 s |
| | real touch tap (it hits `btn-update`) | **B after one reload** | 0.98 s | controller `v5/1.2.0`; only the v5 caches |

- Page errors: 0. Worker errors: 0. Console errors: 0.
- Launch 1 runs the old 1.2.0 code, so the old `ui.js` shows the pill whenever a worker waits. That is correct here, because the waiting build differs.

## 3. Smoke matrix

**How the runs were made.**
- Every run used `node tools/smoke.js … --bootTimeout 90 --out EV/m1-<run>`, sequentially, from 12:51 to 13:04, through `EV/tools/matrix.sh`.
- The tree was the handed-over code. The v5 bump came after; it changes no game code.
- The default quality is auto → High on this host (i7-8700K, RX 6800, headless Chrome on the GPU). The fresh profile means shop rank 0.
- The summary is `EV/m1-summary.json`, made by `EV/tools/summ.cjs`.

**Columns.**
- **Calls max** is the per-frame maximum of main / shadow / post while playing (`report.callsMax`). The budget is 50 / 20 / 14.
- **Boss draws** counts the boss objects in the peak main frame.

| Run | Verdict | Page err / console err / warn / failed req | Boot (s) | End | Frames: n, fps, p99 / worst (ms) | > 50 ms | Calls max | Programs | Boss draws |
|---|---|---|---|---|---|---|---|---|---|
| boot | **CLEAN** | 0 / 0 / 0 / 0 | 7.5 | title, High, "v1.2.0", District 1 caption | – | – | – | – | – |
| ui | **CLEAN** | 0 / 0 / 0 / 0 | 7.1 | shop, buy, levels, settings, play, pause, quit → title | – | – | – | – | – |
| play L1 | **CLEAN** | 0 / 0 / 0 / 0 | 7.4 | ★★★, 242 survivors (1.2.0: 242) | 8 720, 143.9, 7.1 / 27.7 | 0 | sunset 34 / 12 / 14 (1.2.0: 35) | 58 | Hulk 3 |
| play L11 | **CLEAN** | 0 / 0 / 0 / 0 | 7.6 | alive at 110 s, 969 m, count 235 (1.2.0: 969 m, 238) | 14 979, 143.9, 7.1 / 27.8 | 0 | night 39 / 13 / 14 | 58 | – |
| play L5 `--boss`, `setCount(190)` | **CLEAN** | 0 / 0 / 0 / 0 | 7.5 | ★★☆, 136 survivors (r5b after: 135) | 4 105, 144.0, 7.1 / 7.2 | 0 | sunset 34 / 11 / 14 | 58 | Spitter Queen **3** |
| play L17 `--boss`, `setCount(480)` | **CLEAN** | 0 / 0 / 0 / 0 | 7.5 | ★★☆, 287 survivors (r5b after: 287) | 4 408, 144.0, 7.1 / 7.2 | 0 | toxic 37 / 11 / 14 | 58 | Hulk Twins **6** |
| play `--endless --seconds 240` | **CLEAN** | 0 / 0 / 0 / 0 | 7.9 | squad lost at 169 s, 1 600 m, Overcast, to the 1 450 m Hulk mini-boss (see below) | 23 478, 143.9, 7.1 / 20.9 | 0 | sunset 38 / 14 / 14; **overcast 43** / 14 / 14 | 58 | Hulk 3 (fight 153–169 s, main 30–39) |
| all `--shell artifact` | **CLEAN** | 0 / 0 / 0 / 0 | 6.9 | ★★★, 256 survivors; HOME tap → title | 8 726, 143.9, 7.1 / 27.9 | 0 | sunset 34 / 12 / 14 | 58 | 3 |
| all `--shell sandbox` | **CLEAN** | 0 / 0 / 1 (the expected "Progress won't be saved") / 0 | 6.0 | ★★★, 256 survivors; HOME tap → title | 8 722, 143.9, 7.1 / 20.9 | 0 | sunset 34 / 12 / 14 | 58 | 3 |
| play `--quality low --level 16 --seconds 50` | **CLEAN** | 0 / 0 / 0 / 0 | 7.6 | tier Low; alive at 50 s, 560 m, count 48 | 6 939, 143.8, 7.1 / 20.9 | 0 | toxic 40 / 0 / 0 | 42 | – |

**Re-run on the final tree (v5)** (`EV/m2-*`, all **CLEAN**, 0 errors):
- **boot:** 7.9 s; title "v1.2.0".
- **all (index shell):** ★★★, 256 survivors. HOME tap → title. Worst frame 20.8 ms. Calls 34 / 12 / 14.
- **endless 240 s at shop rank 4** (`--pre` sets squad, fireRate, damage and bossDamage to 4), so a full mini-boss fight is on screen:
  - frames: 25 358, p99 7.1, worst **48.6 ms**, 0 over 50 ms;
  - calls: sunset 39 / 12 / 14, **overcast 43** / 16 / 14;
  - the peak main frame was in a Hulk fight, with 3 boss draws and 21 zombies;
  - the squad was lost at 182 s, 1 728 m.

**Endless main-pass draws.** The target is ≤ 50.

| Run | Timeline max (2 s samples) | Per-frame max (`callsMax`) | With the boss alive |
|---|---|---|---|
| m1, rank 0, 240 s | **42**, at 115.9 s, Overcast, 21 zombies plus a medic | 43, Overcast | timeline 30–39 |
| m2, rank 4, 240 s | **41**, at 178.4 s, Overcast, Hulk p3 | 43, Overcast, at 176.8 s with the Hulk on screen | timeline 28–41 |

- 1.2.0 had 53 in this situation (r5-release §4.2), so the release's open item 1 is closed in this content.
- Totals: 10 play runs (8 in m1, 2 in m2), ≈ 114 200 frames, p99 7.1 ms in every run, **0 frames over 50 ms**. The worst frame is 48.6 ms (endless at rank 4). Every other run's worst is ≤ 27.9 ms.

**Endless runs that end before 240 s.** Neither endless run reached 240 s: the squad was lost at the 1 450 m mini-boss.
- This is not an r5b regression. r5b changed only rig drawing, and no gameplay data.
- r5b-boss-draws' own runs lost at the same mini-boss, both before and after the change (177 s and 174 s; `r5b/boss-draws/m1/{before,after}-endless`).
- In all of these runs, the boss's HP stops dropping once it reaches the squad line, for example 2 155 / 28 050 from 176 s to 182 s in m2.
- The 1.2.0 release run survived to 200 s by bot variance. This is noted for the boss and balance owners (§6).

## 4. Boss rigs (`EV/sheets/`)

**Contact sheets.** `l5-boss.png` and `l17-boss.png` put r5b-boss-draws' *before* runs (the 1.2.0 rig, `r5b/boss-draws/m1/before-L{5,17}-boss`) next to this pass, at 9 s and 17 s into each fight. `boss-crops.png` and `twins-crops.png` are full-resolution crops.

**Spitter Queen.** Unchanged:
- the dark-green body with the lime acid sacs;
- the shoulder plates;
- the orange core and the spikes.

The plates fly off in phase 2 as dark metal slabs, as they did in 1.2.0. r5b's isolated `spitterQueen.png` sheet shows the same plate flight in both trees.

**Hulk Twins.** Unchanged:
- the rage-red twin, with its red glowing core and orange eyes, and the green twin, with its orange core and yellow eyes;
- the plates and the jaw.

**Endless Hulk** (`endless-low.png`, `endless-r4-boss.png`). Plates, yellow eyes, the orange core turning red in rage, and the plates flown off in p3.

**Programs** are flat: 58 on High in every run, 42 on Low.

## 5. Builds

| What | Result |
|---|---|
| `artifact.html` | rebuilt; byte-identical (md5 `bb48e979…`), because `index.html` did not change |
| `dist/` | `node tools/package.js --check`: 33 files, 2 538 KB; `dist/sw.js` `VERSION 'v5'`, stamp `fc83863cc030…`. Every other file is byte-identical to its source |
| `gate-rush-dist.zip` | 33 files, 974 155 bytes, md5 `9d1366f9…`. `unzip -t` passes; extracted, it equals `dist/` file for file; forward-slash entry names |

**How the zip was made.**
- The requested `Compress-Archive -Path dist\* -DestinationPath gate-rush-dist.zip -Force` ran first. On this host's Windows PowerShell 5.1 it writes **backslash entry names**: 29 of 33, for example `js\main.js`.
- Extractors on macOS and Linux turn those into flat files named `js\main.js`. That is the 1.1.0 defect r5-release §2.1 fixed.
- The Compress-Archive output is kept as `EV/gate-rush-dist-compress-archive.zip`.
- The shipped zip was written by r5-release's `mkzip.cjs` (`EV/tools/mkzip.cjs`): deflate, forward slashes, the `dist/` contents at the archive root.
- Baselines: the 1.2.0 zip and `dist/` are saved as `EV/gate-rush-dist-1.2.0.zip` and `EV/dist-1.2.0/`.

## 6. Open items

1. **`ctx.version`.** This build shows "v1.2.0" like the shipped 1.2.0, although four files differ. The update path works, as the hotfix case in §2 shows. A 1.2.1 label is a lead or release decision, for bug reports. It would touch `js/main.js`, `package.json`, `package-lock.json` and the ARCH §3 `ctx.version` row.
2. **Stale docs, from r5b-boss-draws needsOtherGroup 4, not applied.**
   - ARCH §6.4: the CHR-11 comment under `buildBossRig`.
   - ARCH line ≈ 1111: the scene tree.
   - Both still describe 7–10 draws per rig. They should say 3 (+1 shield), and Twins 6.
   - §9.1 "boss ≤ 4" holds for every archetype except the Twins.
3. **Endless mini-boss at 1 450 m.** The squad was lost in all four endless runs since r5b-boss-draws: rank 0 and rank 4, before and after r5b. The boss takes no damage once it stands at the squad line. This is for the boss and balance owners.
4. **Worst endless frame: 48.6 ms at rank 4.** It is under 50 ms, but above 1.2.0's 41.6 ms. It is a single frame, and the smoke report does not locate it. The district fade's worst frame was 7.2 ms.
5. **The claude.ai artifact** still serves 1.1.0 (r5-release §7 item 3).
6. **Not re-measured here:** the 4× CPU throttle, the slow-network update scenarios (r5b-sw covered them on v4 → v5 test builds), and the audio, balance and FTUE suites.

## 7. Files changed in this pass

| File | Change |
|---|---|
| `sw.js` | `VERSION 'v4'` → `'v5'`; one header line |
| `docs/ARCHITECTURE.md` | the `ctx.version` row (§3) and §15.4 now name v5 |
| `artifact.html` | rebuilt (unchanged bytes) |
| `dist/`, `gate-rush-dist.zip` | rebuilt (§5) |
| `docs/build/r5b-verify.md` | this report |

The final md5s are in `EV/md5-final.txt`, and the handed-over ones in `EV/src-before-md5.txt` (snapshot: `EV/src-before/`). The only source difference is `sw.js`.
