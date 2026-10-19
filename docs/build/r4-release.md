# Round 4: release 1.1.0

This is the release engineer's pass after round 4. Inputs: `docs/build/r3-verify.md` and the four round-4 reports, `r4-audio.md`, `r4-level.md`, `r4-ui.md` and `r4-visual-fx.md`. The method follows the round-3 verification.

**Verdict: ship 1.1.0.** The remaining items in §7 are design decisions, 4× CPU frames, and one cosmetic observation.

- **Static checks.** All green: `node --check` passes on 31 files, `check-imports` reports 0 errors and 0 warnings, and `validate-levels` reports 30 levels, 0 errors and the same 10 warnings as round 3. `build-artifact` passes. `package.js --check` passes with 31 precached files, cache version v3.
- **Version.**
  - The service-worker cache `VERSION` goes from `'v2'` to `'v3'`.
  - `ctx.version` goes from `'1.0.0'` to `'1.1.0'`; the title shows **v1.1.0**. `package.json` and `package-lock.json` say 1.1.0 too.
  - `artifact.html` is rebuilt. It is byte-identical, because `index.html` did not change.
  - `dist/` is rebuilt: 33 files, all byte-identical to the sources.
- **Smoke matrix.** All 11 requested runs are **CLEAN**, plus one extra visual run (12 in all). Each run has 0 page errors, 0 console errors and 0 failed requests. The only warning is the expected sandbox "Progress won't be saved".
  - The host was quiet, and **no frame went over 50 ms in ≈ 94 800 frames.** The worst is 27.8 ms, or 34.6 ms in the run that takes a screenshot every 2 s.
  - The three `--scenario all` runs now end with a real tap on HOME: a mouse click on desktop, and a touch tap in the artifact shell and inside the sandbox iframe. All three land on the title.
- **dist/ served on its own port: PASS.**
  - **First visit.** The page boots to the title with no errors. The v3 worker activates and controls the page, and after a reload 43 of 56 responses come from the worker. The other 13 are `data:` URLs.
  - **Upgrade from v2.** A returning v1.0.0 player's first launch already runs 1.1.0. The v3 worker activates 2.9 s later and deletes the v2 caches.
  - **Offline launch.** It boots to the title with the real fonts. It also works straight after a single first visit.
- **needsOtherGroup.**
  - **Applied:** the guarded audio data reads (level 1) and the HOME step in the smoke harness (ui 2).
  - **Done:** the quiet-host frame measurement (ui 3).
  - The rest are lead or art decisions, or 4×-only frames. Reasons are in §1.

The evidence root is `E:/Temp/claude/gate-rush-evidence/r4/release/`, written `EV/` below. I wrote nothing under the project root except the files listed in §8 and the `dist/` build.

## 0. Host and method

- **Host.** The same machine as round 3: i7-8700K, RX 6800 (ANGLE D3D11), headless Chrome 155 on the real GPU, a 144 Hz panel.
  - **What was running.** Only the user's own desktop Chrome (11 idle processes since 05:43) and an unrelated `node serve.mjs 8791`.
  - No other agent's browser ran during the matrix. A mid-matrix count found 22 Chrome processes: 11 mine and 11 the user's.
  - This answers r4-ui needsOtherGroup 3. The round-4 owners' 55–354 ms frames came from host contention, and they are absent here.
- **Baseline.** The tree as handed over is in `EV/src-before/` (`EV/src-before-md5.txt`). The final md5s are in `EV/md5-final.txt`. Every edit went through `EV/tools/rep.cjs`, an anchor-checked replacement; the edit files are in `EV/tools/edits/`.
- **Tools.**
  - **Matrix:** `EV/tools/matrix.sh <tag>` (sequential, `--bootTimeout 90`), `summ.cjs` and `mdtable.cjs`, copied from the round-3 verifier with the round-4 run list.
  - **dist check:** `EV/tools/distcheck.mjs`, which serves a `dist/` folder on its own port (§5).
  - **Guard proof:** `EV/guardtest/probe.mjs` (§1).

## 1. needsOtherGroup requests

| Source | Request | Status | Where |
|---|---|---|---|
| level 1 | audio.js read `MUSIC.warm.*` unguarded; the game failed to boot while data.js lacked the key | **Applied** (details below the table) | `js/audio.js`; ARCH §8 round-4 note |
| ui 2 | The smoke `ui` scenario never visits a results screen; add a HOME tap after the L1 result in `--scenario all` | **Applied** (details below the table) | `tools/smoke.js` (header, `runHome()`); ARCH §15.3 |
| ui 3 | Release verifier: re-measure frame pacing on a quiet host | **Done** (§4) | `EV/m-*` |
| audio 4 | QA / verify: re-run the audio battery | **Not re-run** (reasons below the table) | `EV/audio-probe/report.json` |
| audio 5, ui (artifact) | Integrator: nothing to rebuild | **Verified**: `build-artifact` reproduces `artifact.html` byte for byte (md5 c832e4d0…). It was rebuilt anyway, together with `dist/` | — |
| level 2 | The → in `HINTS.div` falls back to a thin system arrow next to Lilita One | **Not applied**: a cosmetic call for ui / art. It reads (`r4/level/divhint3/L3-first-div-1.png`). A path-drawn arrow needs a markup change in the hint pill, which is too much risk at release time for the gain | §7 |
| visual-fx 2 | Optional: a larger pill icon box (26 px icon in a 34–36 px ring) | **Not applied**: optional, and the ui owner sized the pill this round | — |
| audio 2 | Boss-arrival frame at 4× CPU, 42–56 ms: `_fireBoss` 9–10 ms plus `boss.render` ≈ 4 ms | **Not applied**, as in round 3: 4×-only, and no safe deferral without the level / boss owners. At 1× the L10 boss run's worst frame is 7.2 ms | §7 |
| audio 3 | Main: optional single boot-slice protocol | Not needed, as the audio owner says | — |
| visual-fx 1, visual-fx 3, ui 1 | FYI: pill pictograms on the light disc; railgun rails colour | No action. The icons were tuned on the round-4 pill (`r4-visual-fx.md` §1) | — |
| audio 1a, 1b; level 3, 4; ui 4 | Lead decisions: per-use node cost of the `hup` chorus / music pad; sound 50 reaching only +3.8 dB; a negative `profileExp`; the "KEEP SHOOTING" wording; HOME replacing the text HOME | Lead; not changed | §7 |

**Level 1: the guarded audio reads.**
- **Change.** The round-4 keys `MUSIC.queue.deferMinMs`, `deferLeadMs`, `deferCapacity`, `shaperPool` and `MUSIC.warm.*` are now read with their shipped values as fallbacks. `_rewardVolume()` plays no trim when `MUSIC.duck.rewardStack` is missing.
- **Why it matters beyond the mid-edit tree.** The service worker serves code network-first with a 3 s budget per file. On a slow first launch after an update, one file can come from the network and another from the old cache. A new `audio.js` that meets an older `data.js` threw at import time and showed "Load error".
- **Proof.** `EV/guardtest/`: a `data.js` without the round-4 keys.
  - The handed-over `audio.js` fails with "Cannot read properties of undefined (reading 'idleMinMs')".
  - The new one imports.
  - With the full `data.js`, both import.
- **Runtime unchanged.** `EV/audio-probe/report.json` (smoke `--pre` probe, CLEAN) shows the deferred table at 8 slots, the shaper pools at 8 per drive (2 drives) and the warm-up finished by the title (39 items: 4 oscillator types and 35 cues). Those are the data.js values.
- **Other round-4 cross-file reads were already guarded:** `HINTS.div` (showHint skips unknown ids), `JUICE.damageNumber.bossRows` (`> 0` fallback) and `STRINGS.aria.home` (falls back to `gameover.home`).

**ui 2: the HOME step in the smoke harness.**
- **What it does.** After the played level, `--scenario all` finds the visible results screen's HOME (`#btn-complete-home`, `#btn-home` or `#btn-endless-home`) and taps its centre for real. It uses touch on the phone viewport, mouse with `--desktop`, and touch offset by the iframe in the sandbox shell.
- **Pass conditions.** HOME must win the hit test, `ui:button` must carry its id, and the title must appear within 3 s.
- **Failure verdict.** A failed check gives the new verdict `CHECK FAILED (n)`, with `report.checkFailures` and exit 1. A results screen without a visible HOME also fails. A run that never reached a results screen skips the step.
- **Verified both ways.**
  - Passes: phone, desktop and sandbox in `EV/dev/home-*`, and the three `all` matrix runs.
  - Two negative runs give `CHECK FAILED (1)`, exit 1. In `EV/dev/home-neg-cover` a div covers HOME, and the hit test reports "cover". In `EV/dev/home-neg-missing` HOME is removed, and the report says "#scr-complete is shown without a visible #btn-complete-home".

**Why the audio battery was not re-run (audio 4).**
- The audio owner ran it on this code at 12:19.
- My `audio.js` change is behaviour-neutral with the shipped `data.js`: every fallback is skipped when its key exists, and the probe above confirms the runtime values.
- The full battery takes ≈ 10 min of real-time capture.

## 2. Release changes

| What | Before | After |
|---|---|---|
| `sw.js` `VERSION` (caches `gaterush-<v>`, `gaterush-cdn-<v>`) | `'v2'` | **`'v3'`**, with a header note: "a release bump also re-precaches every file in one consistent set" |
| `js/main.js` `VERSION` → `ctx.version` → `#version` | `'1.0.0'` / "v1.0.0" | **`'1.1.0'` / "v1.1.0"** (title screenshots, §6) |
| `package.json` and `package-lock.json` root version | 1.0.0 | 1.1.0 |
| `artifact.html` | md5 c832e4d0… | rebuilt: identical (`index.html` did not change; the version lives in `main.js`) |
| `dist/` | absent | `node tools/package.js --check`: 33 files, 2 301 KB. Every file is byte-identical to its source (md5 compare), so the matrix, which serves the project root, covers the shipped bytes |
| `tools/package.js --check` | printed "34 entries": it counted the three repeated `'./index.html'` fallbacks | counts unique files and prints the cache version: "sw.js precache OK (31 files, all present in dist/; every js/ file listed; cache version v3)" |

**Docs.**
- ARCH §3: `ctx.version` is 1.1.0.
- ARCH §15.4 now describes the service worker as shipped. It still said `gaterush-v1` and cache-first code; code has been network-first since round-1 UI-8, and the precache list has 32 entries.
- ARCH §15.3 lists `tools/package.js` and `tools/smoke.js`.
- ARCH §8 has the round-4 release note.
- No designed gameplay behaviour changed, so `docs/GDD.md` is unchanged.
- `docs/build/CALLSITES.md` is regenerated. The diff is line numbers only, so round 4 changed no cross-module member.

## 3. Static checks

Run on the handed-over code (`EV/static/*-before.txt`) and again on the final code (`*-final.txt`).

| Check | Result |
|---|---|
| `node --check` on `js/*.js` (22), `tools/*.js` (8) and `sw.js` | 31 files, 0 failures (`node-check-final.txt` is empty) |
| `node tools/check-imports.js` | 0 errors, 0 warnings |
| `node tools/validate-levels.js` | 30 levels · 10 warnings · **0 errors**. The output is identical before and after, timings aside, and identical to `r4/level/validate-after.txt`. The warnings are those of round 3: L1 authored-wave leak ×4, the L6 no-steer line at 88 %, and the weak-shooter line on L13, L19, L23, L25 and L28 |
| `node tools/build-artifact.js` | "sw.js PRECACHE covers all 22 files in js/"; 174 lines, 4 link tags, import map, 34 module preloads, APP, BOOTGUARD |
| `node tools/package.js --check` | as in §2 |
| `grep console.log / Math.random` in `js/` | comments only |

## 4. Smoke matrix

Final code. Every run is `node tools/smoke.js … --bootTimeout 90 --out EV/m-<run>`, run sequentially from 12:34 to 12:49. Boot is smoke's wall time from navigation to the first state.

| Run | Command | Verdict | page err / console err / warn / failed req | Boot (s) | End state | frames: n, fps, p95 / p99 / worst (ms) | long frames > 50 ms | Boss TTK / HOME tap |
|---|---|---|---|---|---|---|---|---|
| boot | `--scenario boot` | **CLEAN** | 0 / 0 / 0 / 0 | 6.4 | title (High), "v1.1.0" | – | – | – |
| ui | `--scenario ui` | **CLEAN** | 0 / 0 / 0 / 0 | 5.9 | shop, buy, back, levels, settings, play, pause, resume, quit → title | – | – | – |
| all-desktop | `--scenario all --desktop` | **CLEAN** | 0 / 0 / 0 / 0 | 6.1 | L1 clear ★★★, 258 survivors | 8 827, 143.9, 7.1 / 7.1 / 27.7 | none | HOME mouse tap → title ✓ |
| play-l1 | `--scenario play --level 1` | **CLEAN** | 0 / 0 / 0 / 0 | 7.0 | L1 clear ★★★, 242 survivors | 8 703, 143.9, 7.1 / 7.1 / 20.8 | none | – |
| play-l3-nobot | `--level 3 --nobot` | **CLEAN** | 0 / 0 / 0 / 0 | 5.9 | L3 clear ★★☆, 121 survivors | 10 907, 144.0, 7.1 / 7.1 / 20.8 | none | – |
| play-l6 | `--level 6` | **CLEAN** | 0 / 0 / 0 / 0 | 6.5 | L6 clear ★★☆, 160 survivors (Hulk, 4 100 HP, ≈ 16 s on the timeline) | 12 788, 143.9, 7.1 / 7.1 / 27.8 | none | – |
| play-l10-boss | `--level 10 --boss --after "g.squad.setCount(280,'debug')"`, plus the round-3 TTK listeners | **CLEAN** | 0 / 0 / 0 / 0 | 7.0 | L10 clear ★★☆, 187 survivors | 3 534, 144.0, 7.1 / 7.1 / 7.2 | none | **TTK 19.0 s** (HP 7 000, C 280 → 187) |
| play-endless | `--endless --seconds 120` | **CLEAN** | 0 / 0 / 0 / 0 | 6.2 | alive at 120 s: 1 108 m (chunk 4), C 178 (peak 226) | 16 329, 143.9, 7.1 / 7.1 / 20.9 | none | – |
| all-sandbox | `--scenario all --shell sandbox` | **CLEAN** | 0 / 0 / 1 (expected "Progress won't be saved in this browser") / 0 | 5.3 | L1 clear ★★★, 256 survivors | 8 734, 143.9, 7.1 / 7.1 / 20.9 | none | HOME touch tap (in the iframe) → title ✓ |
| all-artifact | `--scenario all --shell artifact` | **CLEAN** | 0 / 0 / 0 / 0 | 6.9 | L1 clear ★★★, 256 survivors | 8 733, 143.9, 7.1 / 7.1 / 20.9 | none | HOME touch tap → title ✓ |
| play-low | `--quality low --seconds 60` | **CLEAN** | 0 / 0 / 0 / 0 | 7.0 | tier Low; boss dead at 60 s (phase won), C 247 | 8 273, 143.9, 7.1 / 7.1 / 27.7 | none | – |
| l1-visual (extra) | `--level 1 --shots 2`: the 5 s / 15 s screenshots | **CLEAN** | 0 / 0 / 0 / 0 | 5.9 | L1 clear ★★★, 242 survivors | 7 924, 143.9, 7.1 / 7.1 / 34.6 (30 screenshots, 1 035 intervals excluded) | none | – |

**Against round 3 (r3-verify m2).** The end states match within bot variance:

| Run | Round 3 | Round 4 |
|---|---|---|
| L1 | ★★★, 239 survivors | ★★★, 242 survivors |
| all, sandbox / artifact | 256 survivors | 256 survivors (identical) |
| all, desktop | 256 survivors | 258 survivors |
| Low, 60 s | boss dead at 60 s, C 247 | identical |
| L10 TTK at C = E_boss | 18.7 s | 19.0 s, same HP and same 187 survivors |
| Endless | 1 392 m at 150 s | 1 108 m at 120 s; GDD §10.1's strong player dies around chunk 9–14 |

**Frame pacing on a quiet host.**
- The 10 play runs drew ≈ 94 800 frames at 143.9 fps mean, p99 7.1 ms in every run, and **0 frames over 50 ms**.
- The worst frame per run is 7.2–27.8 ms, or 34.6 ms in the 2 s screenshot run. Round 3's worst was 27.9 ms.
- So the 55–354 ms frames that the round-4 owners logged with 20–70 Chrome processes on the host were host contention, as their traces said: ≈ 3 ms of thread CPU in a descheduled RunTask. They are not a regression.

## 5. dist/ served by itself (`EV/tools/distcheck.mjs`)

**How the check works.**
- **Server.** A tiny static server on its own port (8797–8799) serves `dist/` with `Cache-Control: no-cache`.
- **Browser.** Headless Chrome with a fresh profile, 390 × 844 at DPR 2 with touch, and no debug flags. It loads `/index.html`, the manifest's `start_url`.
- **What it records.**
  - The page's errors, console messages and failed requests.
  - Every response and whether the service worker served it.
  - The worker target's console and exceptions, through CDP.
  - `navigator.serviceWorker` state and the contents of each cache.
- **The offline step.** It closes the server, sets the page offline (`page.setOfflineMode`) and sets the worker target offline (`Network.emulateNetworkConditions`). A worker that restarts later is taken offline as it starts. Then it reloads.

| Run | Phase | Boot to title | Errors / warnings / failed requests | Served by the worker | Worker and caches |
|---|---|---|---|---|---|
| **fresh** (`EV/dist-check-fresh/`): **PASS** | first visit | 2.40 s, "v1.1.0" | 0 / 0 / 0 | 1 / 56 | v3 installed and activated by the time the title showed, and it already controls the page (`clients.claim`); `gaterush-v3` 32 entries (= PRECACHE), `gaterush-cdn-v3` 13 (12 three.js modules plus the fonts CSS) |
| | reload | 0.86 s, "v1.1.0" | 0 / 0 / 0 | 43 / 56 (the other 13 are `data:` URLs) | `controller.state` activated; every PRECACHE entry present; CDN cache 15 (plus the two woff2 files) |
| | **offline** reload | 0.76 s, "v1.1.0" | 0 / 0 / 0 | 43 / 59 | fonts loaded: Lilita One 400, Nunito 600 and 800 (`offline-title.png`) |
| **upgrade** v1.0.0 → v1.1.0, one origin (`EV/dist-check-upgrade/`): **PASS** | old build: first visit, then reload | 2.41 s / 0.78 s, "v1.0.0" | 0 / 0 / 0 | 1 / 56, then 43 / 56 | `gaterush-v2` 32, `gaterush-cdn-v2` 15; the v2 worker controls the page |
| | the release: same origin, first launch | 0.84 s, **"v1.1.0"** (the v2 worker's network-first fetched the new code) | 0 / 0 / 0 | 42 / 58 | **v3 activated 2.9 s later; only `gaterush-v3` and `gaterush-cdn-v3` remain** (v2 deleted) |
| | reload | 0.76 s, "v1.1.0" | 0 / 0 / 0 | 43 / 56 | the v3 worker controls the page; PRECACHE complete |
| | **offline** reload | 0.76 s, "v1.1.0" | 0 / 0 / 0 | 43 / 56 | fonts loaded |
| **offline straight after a first visit** (`EV/dist-check-offline-first/`) | first visit, then offline | 2.41 s, then 0.84 s, "v1.1.0" | 0 / 0 / 0 | 43 / 56 offline | boots with the real fonts (the woff2 files came from the browser's HTTP cache) |

Worker console errors and exceptions: none in any run. The dist served here is `dist/` itself; `EV/dist-final/` is a copy, and `EV/dist-old/` is the handed-over tree packaged like `package.js` does (`sw.js` v2, `main.js` 1.0.0).

## 6. Screens reviewed

Nothing is visibly broken.

| Screen | File | What it shows |
|---|---|---|
| Title (phone) | `EV/m-boot/00-title.png` | Logo, PLAY, "LEVEL 1", SHOP, LEVELS, settings and fullscreen buttons, coin pill, **v1.1.0** bottom right |
| L1 at 5 s | `EV/m-l1-visual/03-play-5s.png` | Squad of 5 with its count label, the first pair (+20 at MAX in yellow, +2), the "SHOOT THE GATE!" hint pill with the hand. The `?debug=1` overlay sits under the hint; players never see that overlay |
| L1 at 15 s | `EV/m-l1-visual/08-play-15s.png` | Count 23, the ×3 (green) and +10 pair, a crate ahead, zombies in the fog, tracers |
| L1 in play, with a pill | `EV/m-play-l1/04-play-25s.png` | The shotgun pill (5 s) on the light disc, the −15 / +6 pair, count 67 |
| Boss fight | `EV/m-play-l10-boss/03-play-17s.png` | JUGGERNAUT name and HP bar, the two-row damage numbers (97 / 103 59), the charge telegraph, count 215 |
| Boss fight | `EV/m-play-l6/11-play-81s.png` | HULK at about 40 % HP, numbers "80 55 / 106", count 201, a medic in the squad |
| Results | `EV/m-play-l1/09-result.png`, `m-play-l3-nobot/11-result.png`, `m-play-l10-boss/05-result.png`, `m-all-desktop/16-result.png` | HOME icon top-left, "LEVEL n CLEAR", stars, coins and chips, survivors, NEXT, REPLAY, a badged SHOP |
| HOME → title | `EV/m-all-sandbox/17-home.png`, `m-all-desktop/17-home.png` | The title with "LEVEL 2" (L1 cleared), the badged SHOP and v1.1.0 |
| Shop | `EV/m-ui/02-shop-bought.png` | 4.8K coins, five cards with their icons, one start-squad pip bought, prices |
| Low tier | `EV/m-play-low/07-play-49s.png` | No shadows, DPR 1, 27 calls, count 275 |
| Offline title from dist/ | `EV/dist-check-upgrade/offline-title.png` | The title in Lilita One with v1.1.0, served with no network |

## 7. Remaining issues (honest list)

1. **Lead decisions are still open.** None is a code defect; the owners' reports have the measurements.
   - **Audio:**
     - The `hup` chorus and the music pad cost ≈ 10 ms and 8–9 ms at 4× CPU per big pass and per bar. A shared filter would make that cheaper, at the price of a small timbre change.
     - At sound 50 / music 80 the pass reward rises +3.8 dB, not 6 dB.
   - **Level:**
     - `profileExp` can only damp the shop's endless effect; a negative exponent needs a guard change.
     - The lead's longer ÷ hint wording takes 3 lines.
   - **ui:** confirm that the HOME icon replaces the text HOME on game over and endless.
   - **Still open from round 3** and outside this round's scope:
     - in endless, 3 of 36 rank-10 seeds pass chunk 25 (`pressure.perD`);
     - the L1 income ratio is 1.07;
     - "the passive player fails ≥ 2 levels" holds on the canonical seeds only;
     - L2 leaks 4.8 % on rerolled layouts;
     - L5's shiny-lane opener;
     - L4 stays 2★ for a human-like player.
2. **Not applied: two cosmetic or optional items (§1).** The thin system → in the ÷ hint, and a larger pill icon.
3. **4× CPU first-use frames.** I did not re-measure them in this pass. The audio owner's round-4 throttled runs show:
   - the boss arrival still at 42–56 ms at 4× (`_fireBoss` 9–10 ms plus `boss.render` ≈ 4 ms; level / boss owners);
   - an occasional 107–128 ms GC-like task outside rAF mid boss fight (once in round 3, once in round 4).

   At 1× no matrix frame exceeds 34.6 ms.
4. **Mixed builds on a slow first launch after an update.**
   - **Cause.** The worker serves code network-first with a 3 s budget per file. Through the old worker, a launch where some files time out mixes 1.0.x files from the old cache with 1.1.0 files from the network.
   - **Crash path closed.** I guarded the one path that threw (`audio.js` against an older `data.js`, §1) and checked the other round-4 cross-file reads.
   - **What remains is cosmetic.** For example, an old `index.html` with the new `ui.js` shows the text HOME of 1.0.
   - **Self-healing.** It lasts one launch: the v3 worker precaches one consistent set and takes over within seconds (§5).
   - **Real fix.** Loading every file at one build version would need a design change, such as version-keyed module URLs or a worker that serves a matched set. That is for a later round.
5. **Desktop title scene (cosmetic, pre-existing).**
   - **What happens.** On a landscape or desktop viewport, the title's idle gates slide through the near field of the side camera. For a moment a gate post and a dark panel with its glowing edge fill part of the view.
   - **Evidence.** `EV/m-all-desktop/17-home.png`; the same is in `r4/ui/after-desktop/01b-after-home.png`. Not a regression; render / level could keep the idle gates out of the camera's near field.
6. **Validator.** The 10 warnings are unchanged. L13–L30 are not calibrated, and levelgen still carries `DATA-MISSING` literals.
7. **Not re-measured here.** The audio battery, the balance and endless tables, the FTUE session and the 4× throttled boot. This pass verified that the shipped bytes are the code those owners measured. My only code changes on top are behaviour-neutral: the audio guards (probed) and the version strings.
8. **Boot time.** Smoke's boot wall time is 5.3–7.0 s, against 5.1–6.8 s in round 3. Served from `dist/`, the first visit reaches the title in 2.4 s with a cold cache, and a controlled or offline launch in 0.76–0.86 s.

## 8. Files changed in this pass

| File | Change |
|---|---|
| `sw.js` | `VERSION` `'v2'` → `'v3'`; header note on the release bump |
| `js/main.js` | `VERSION` `'1.0.0'` → `'1.1.0'` |
| `package.json`, `package-lock.json` | version 1.1.0 |
| `js/audio.js` | round-4 `MUSIC.queue` / `MUSIC.warm` reads guarded with the shipped values as fallbacks; `_rewardVolume()` guarded (r4-level needsOtherGroup 1) |
| `tools/smoke.js` | `--scenario all` ends with a real HOME tap check; the `CHECK FAILED` verdict, `report.home` and `report.checkFailures`; header (r4-ui needsOtherGroup 2) |
| `tools/package.js` | `--check` counts unique files and prints the cache version |
| `docs/ARCHITECTURE.md` | §3 `ctx.version`; §8 round-4 release note; §15.3 `package.js` and `smoke.js`; §15.4 the service worker as shipped |
| `docs/build/CALLSITES.md` | regenerated (line numbers only) |
| `artifact.html` | rebuilt (identical bytes) |
| `dist/` | rebuilt (33 files) |
| `docs/build/r4-release.md` | this report |

ARCH §14 holds:
- the guards are module-level constants plus one branch in an event-time method, so there is no per-frame work and no allocation;
- no `console.log` and no `Math.random`.

## Evidence index

| Path | Contents |
|---|---|
| `EV/src-before/`, `EV/src-before-md5.txt`, `EV/md5-final.txt` | The tree as handed over, and the md5s before and after |
| `EV/static/` | Static-check outputs, before and after |
| `EV/m-<run>/` | Matrix reports and screenshots |
| `EV/m-summary.txt`, `EV/m-table.md` | Matrix summaries |
| `EV/dev/home-*` | The HOME step's development runs, positive and negative |
| `EV/guardtest/` | The audio import proof |
| `EV/audio-probe/` | Runtime audio constants |
| `EV/dist-check-fresh/`, `EV/dist-check-upgrade/`, `EV/dist-check-offline-first/` | `report.json` and the title shots of each dist check |
| `EV/dist-old/`, `EV/dist-final/` | The pre-release and release dist folders |
| `EV/tools/` | `matrix.sh`, `summ.cjs`, `mdtable.cjs`, `distcheck.mjs`, `rep.cjs` and `edits/` |
