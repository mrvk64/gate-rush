# Round 5: release 1.2.0

This is the release engineer's pass after round 5. Inputs: the eight round-5 reports (`r5-render-core.md`, `r5-env-art.md`, `r5-level-balance.md`, `r5-ui-sw.md`, `r5-perf-audio.md`, `r5-integrate.md`, `r5-balance-audit.md`, `r5-art.md`) and the round-4 release (`r4-release.md`). The method follows round 4.

**Verdict: ship 1.2.0.** Two findings are left open in §7: one frame over the draw-call budget in the endless run, and a mixed build on the first launch after the update on a slow network. Neither blocks the release. The rest of §7 is lead and art decisions, and checks that need a real phone.

- **Static checks: all green.**
  - `node --check` passes on 31 files.
  - `check-imports` reports 0 errors and 0 warnings.
  - `validate-levels` reports 30 levels, 7 warnings and **0 errors**. The output is the same as the hand-over's, timings aside.
  - `build-artifact` passes.
  - `package.js --check` passes: 31 precached files, cache version v4, build `58d6a2c25386`.
- **Version.**
  - `ctx.version` goes from `'1.1.0'` to **`'1.2.0'`**, so the title shows **v1.2.0**. `package.json` and `package-lock.json` say 1.2.0 too.
  - `sw.js` keeps `VERSION 'v4'`, as the ui-sw owner set it. No v4 build ever shipped: `dist/` and the zip held v3 until this pass. So v4 is new to every installed player, and the release rule passes (v3 → v4).
  - `dist/` is rebuilt (33 files). `gate-rush-dist.zip` is regenerated from it.
- **Smoke matrix: all 14 runs are CLEAN.** The 15th run is the 4× throttled one (§4).
  - Every run has 0 page errors, 0 console errors and 0 failed requests. The only warning is the expected sandbox "Progress won't be saved".
  - **No unthrottled frame went over 50 ms in ≈ 124 100 frames.** The worst frame is 41.6 ms (endless); every other run's worst is ≤ 27.8 ms.
  - Programs stay flat while playing: 58 on High, 42 on Low.
  - **Draw calls stay within budget in 13 of the 14 runs.** In the endless run, one Overcast frame peaked at **53 main draws** (budget 50) during a Hulk mini-boss fight (§4.2, §7 item 1).
- **Update path from the shipped 1.1.0 (sw v3) to 1.2.0 (v4), served from `dist/`.**
  - On a normal network, every launch is one consistent build.
  - On a slow network, the first launch through the old v3 worker can mix the two builds. A mix whose modules link boots and plays. The one mix that cannot link (an old `data.js` under new modules) failed with a raw `SyntaxError` box. This pass fixes that case in `index.html`: the app now finishes the update and reloads into one consistent 1.2.0 build (§5).
- **needsOtherGroup.** Two items are applied:
  - the item icon is tone-mapped on Low (r5-art 1);
  - the report correction in r5-level-balance (r5-balance-audit 4).
  
  Everything else was applied earlier in the round or is a lead or art decision (§1).

The evidence root is `E:/Temp/claude/gate-rush-evidence/r5/release/`, written `EV/` below. Under the project root I wrote only the files listed in §8, plus `dist/` and `gate-rush-dist.zip`.

## 0. Host and method

- **Host.** The same machine as rounds 3–5: i7-8700K, RX 6800 (ANGLE D3D11), headless Chrome on the real GPU, a 144 Hz panel.
  - During every measurement, the only other processes were the user's own desktop Chrome (12 idle processes since 05:43 on Oct 9) and an unrelated `node serve.mjs 8791`. CPU load before the matrix was 10–22 %.
  - Every browser run in this pass was sequential.
- **Baseline.**
  - The tree as handed over is in `EV/src-before/` (`EV/src-before-md5.txt`, 76 files). The final md5s are in `EV/md5-final.txt`.
  - The shipped 1.1.0 build is `EV/dist-handover/`. It is byte-identical to the handed-over `gate-rush-dist.zip` (33 files).
  - It differs from round 4's `r4/release/dist-final/` in `index.html` and `artifact.html` only: the "visible boot time" watchdog fix of the post-round-4 release check.
  - So the update test in §5 uses the real 1.1.0 bytes, not a reconstructed v3 baseline.
- **Edits.** Every edit went through `EV/tools/rep.cjs`, an anchor-checked replacement. The edit files are `EV/tools/edits/01…09`. `04-bootguard-heal.REVERTED.txt` is a first attempt: `build-artifact` refused it, because it put the word `serviceWorker` into the shared BOOTGUARD. It was replaced by `04-boot-heal.txt` (§2.2).
- **Tools** (`EV/tools/`):
  - `matrix.sh`, `summ.cjs`: the smoke matrix and its summary.
  - `throttle.mjs`: the integration's 4× throttle tool, plus a `--request` option that starts the level the way the menus do.
  - `upcheck.mjs`, `upsum.cjs`, `healneg.mjs`, `uppath.sh`: the update path (§5).
  - `linkmatrix.cjs`, `mixrun.sh`: build mixes.
  - `iconprobe.mjs`, `iconlum.mjs`: the icon A/B.
  - `static.sh`, `mkzip.cjs`, `psheet.mjs`, `pair.mjs`: static checks, the zip, contact sheets and crops.

## 1. needsOtherGroup requests

The integration pass (`r5-integrate.md` §1) already applied or answered every request in the first five round-5 reports. Two reports came after it: the balance audit and the art review. This table covers what was still open.

| Source | Request | Status | Where |
|---|---|---|---|
| r5-art 1 | `gates.js`: the item-icon quad is `toneMapped: false`, so Low (no composer) renders it darker than High and Medium do. Proposal: `toneMapped: true`; the shader already includes `<tonemapping_fragment>` | **Applied** (details after the table) | `js/gates.js`; ARCH §9.4; GDD §15 |
| r5-art 1 (optional part) | A larger `ICON_H` | **Not applied.** It changes the gate layout, and the art director gave no target. With the darker plate and the tone mapping, the icon reads 8.2 : 1 on Low | §7 |
| r5-art 2 | `GATE_RULES.glow.pulseAmp`, the Low glow breathing: the last lever on the Low Frozen 17 px MAX cell | **Not applied.** The art director accepted that cell in DISTRICTS §14 (median 13.3 passes; it reads by its gold badge and frame) | §7 |
| r5-art 3–5, 7 | Frozen ×1 panel, Toxic saturation, the full-ring reward, Medium shimmer | Accepted or decided by the art director; nothing to apply | — |
| r5-art 6, r5-integrate §5 item 9 | GPU cost on a real mid-range phone: the road-shader terms, the rain fill, the 4× Overcast frame | **Not done.** It needs a device; this desktop GPU hides fragment cost. The quiet-host A/Bs show no CPU cost | §7 |
| r5-balance-audit 4 | Report correction: r5-level-balance says the passive bot clears "every level within 3 attempts"; L23 needs 4 | **Applied** (details after the table) | `docs/build/r5-level-balance.md` lines 14, 114, 224 |
| r5-balance-audit 1 | Per-layout leak spread (SD 3.4–7.1 points against a 4–6-point band); the fix belongs in the generator's leak solve | **Not applied.** It is generator design work for the level owner, with a re-calibration; not a release change | §7 |
| r5-balance-audit 2, 3, 5 | L31 loop leak 43.8 %; boss TTK flat below E_boss at high ranks; round-3 residuals (L12, L10) | Lead decisions; not changed | §7 |
| r5-ui-sw 5, 6; r5-integrate §5 item 5 | Bump the version to the round-5 release and rebuild `dist/` | **Done** in this pass (§2) | — |
| r5-integrate §5 item 5 | Publishing the claude.ai artifact link is the release owner's call | **Not published.** The README's link still serves 1.1.0; details after the table | §7 |
| r5-level-balance 3, 4, 5, 7; r5-perf-audio 5 | Passive fail rate; the boss-damage upgrade's value; accepted validator warnings; the banner on the first L1 run; the reward-lift record | Lead decisions; unchanged | §7 |

**r5-art 1: the icon tone mapping.**
- **Change.** `makeQuadMaterial(map, uvAttr, toneMapped = false)` now takes the flag from the caller.
  - The icon passes `true`.
  - The glyph fallback quad, which only stub harnesses use, keeps `false`: HDR glyphs clip on Low, per ARCH §9.4.
- **Why it changes nothing on High and Medium.** three r170 compiles tone mapping out for render targets: `WebGLPrograms.getParameters` sets `toneMapping = NoToneMapping` unless the target is the screen. The composer tiers therefore compile the identical program, and their output pass tone-maps every pixel as before.
- **Programs**, from `EV/iconprobe-{before,after}/iconprobe.json`, with an item gate live and tier switches in the same page:

  | Tier | Before | After |
  |---|---|---|
  | Low | 42 | 42 |
  | Medium | 58 | 58 |
  | High | 58 | 58 |
  | After switches | 93 / 98 / 100 | 93 / 98 / 100 |

  No program is compiled at run time.
- **Look**, from `EV/iconprobe-low-ab-crop.png` and `EV/tools/iconlum.mjs`. The icon's main orange (Y at the 90th percentile):
  - **Low: 0.44 before, 0.499 after.**
  - Medium and High: 0.506 both before and after.
  - Icon : plate on Low went from 7.3 to 8.2 : 1 (Medium 8.6, High 8.4).
  - In the matrix, the Low run's item gate shows a drone icon that reads cleanly on its dark plate (`EV/sheets/low-item-crop.png`).

**r5-balance-audit 4: the report correction.**
- The three claims now read "within 4 attempts (L23 on the 4th)", each marked as a release correction.
- I checked the owner's own campaign rows first: `r5/level-balance/after/camp/passive.rows.json` shows L23 at a = 1, 2, 3 failing and a = 4 at 2★.

**The claude.ai artifact.**
- The link in the README (claude.ai/artifact/BCGzG6hs8jdLmkwtF12nnu: private, owned by the user, 24 files) still holds the 1.1.0 shell: no `#district-banner` and no update pill.
- Updating it is one publish to that URL, with `artifact.html` and the `css/` and `js/` files.
- It was not asked for in this pass, and it changes a page the user may have shared, so it is left for the user.

## 2. Release changes

### 2.1 Version and builds

| What | Before | After |
|---|---|---|
| `js/main.js` `VERSION` → `ctx.version` → `#version` | `'1.1.0'` / "v1.1.0" | **`'1.2.0'` / "v1.2.0"** (title screenshots, §6) |
| `package.json` and `package-lock.json` root version | 1.1.0 | 1.2.0 |
| `sw.js` | `VERSION 'v4'`, set by ui-sw | **`'v4'` kept**. Its v4 header line now names release 1.2.0. The `SKIP_WAITING` handler's comment records that `index.html`'s update heal sends that message too, so every future `sw.js` must keep answering it |
| `artifact.html` | md5 5faecc04… | rebuilt (md5 bb48e979…, 189 lines): the shared BOOTGUARD gains the heal hook (§2.2). It contains no worker code; `build-artifact` enforces that |
| `dist/` | 1.1.0 (sw v3) | `node tools/package.js --check`: 33 files, 2 521 KB, `dist/sw.js` stamped `// build 58d6a2c25386…`. Every other file is byte-identical to its source. A second run on the unchanged tree gives the same stamp and the same bytes |
| `gate-rush-dist.zip` | 1.1.0 (backslash entry names) | 1.2.0. Written by `EV/tools/mkzip.cjs` (deflate, forward slashes, the dist contents at the archive root as before). `unzip -t` passes; extracted, it equals `dist/` file for file |

**Release rule, checked in a sandbox copy (`EV/pkgtest/`).** The rc2 `dist/` (v4, stamp `6973d685…`) was combined with the final sources. `package.js` stopped with "sw.js VERSION is still 'v4' but the build changed (… 6973d685f458 → 58d6a2c25386)" and left `dist/` untouched. The real `dist/` replaced the v3 build, so the rule passes there (v3 ≠ v4).

### 2.2 The update heal (`index.html`; found by the §5 test)

**The problem.** The 1.1.0 worker (sw.js v3) serves code network-first with a 3 s budget per file. So on a slow network, the first launch after the update loads some modules from the network (1.2.0) and others from v3's cache (1.1.0).

`EV/tools/linkmatrix.cjs` lists every cross-version import. The only pairs that cannot link are a 1.2.0 `environment.js`, `level.js`, `models.js`, `render.js` or `ui.js` against the 1.1.0 `data.js`: the new modules import `DISTRICTS`, `DISTRICT_PROPS`, `DISTRICT_RULES`, `districtForLevel` and `districtForChunk`. Such a launch never runs `main.js`.

Before this fix, such a launch showed the player an error box reading "Uncaught SyntaxError: The requested module './data.js' does not provide an export named 'DISTRICTS'" (`EV/up-rc1-slowdata/3-B-launch-1.png`). RELOAD did recover, but only once the old worker's background refresh had stored the new `data.js`.

**The change.**
- A second inline script after `<!-- END BOOTGUARD -->` defines `window.__gateRushHeal(message, show)`. It sits in `index.html` only, so `build-artifact` never copies it into the artifact.
- The BOOTGUARD's two load-error listeners call it before they show `#error-box`. When the page is controlled by a worker and the registration has a newer worker installing or waiting:
  1. the heal writes "Finishing the update…" into `#boot-text`;
  2. it waits for that worker to reach `installed`, or calls `registration.update()` when none is pending;
  3. it posts `{ type: 'SKIP_WAITING' }` and reloads on `controllerchange`.
- The reload then runs v4's verified, complete build.
- Limits:
  - It runs once per session (`sessionStorage['gaterush.heal']`), or once per page when storage is blocked.
  - With no controller, no newer worker after the update check, a redundant worker, or 60 s without a takeover, it puts the boot text back and shows the plain error box with RELOAD, as before.
  - The 20 s stall watchdog waits while a heal runs.
- Cost: ≈ 40 lines of ES5 that run only on a boot failure; a healthy boot never calls them.
- Owner: `index.html` is the ui-sw owner's file. This is a release fix for that owner to review. ARCH §15.1 and §15.4 document it.

## 3. Static checks

Run on the handed-over code (`EV/static/before-*`) and on the final code (`EV/static/final-*`).

| Check | Result |
|---|---|
| `node --check` on `js/*.js` (22), `tools/*.js` (8) and `sw.js` | 31 files, 0 failures (before and after) |
| `node tools/check-imports.js` | 0 errors, 0 warnings |
| `node tools/validate-levels.js` | 30 levels · 7 warnings · **0 errors**. The output is identical before and after, timings aside. The 7 warnings are the round-5 set that GDD §10 justifies: L1 authored-wave leak ×4, the L6 no-steer line, and the weak-shooter line on L13 and L19 |
| `node tools/build-artifact.js` | "sw.js PRECACHE covers all 22 files in js/"; 189 lines, 15 681 bytes; 4 link tags, import map, 34 module preloads, APP, BOOTGUARD and the module script; no `serviceWorker` |
| `node tools/package.js --check` | "sw.js precache OK (31 files, all present in dist/; every js/ file listed; cache version v4; build 58d6a2c25386)"; "dist/ ready: 33 files, 2521 KB" |
| `node tools/callsites.js` | `docs/build/CALLSITES.md` regenerated (627 lines). The diff is line numbers only (gates.js), so no cross-module member was added |
| `grep console.log / Math.random` in `js/` | comments only (5 lines, as before) |

## 4. Smoke matrix

### 4.1 The matrix

**How the runs were made.**
- The code is final. Every run is `node tools/smoke.js … --bootTimeout 90 --out EV/m1-<run>`, sequential from 03:22 to 03:42, through `EV/tools/matrix.sh m1`.
- The two boss runs append round 4's TTK listeners to `--after`.
- All runs use the default quality, which is auto → High on this machine, except the Low run. They start from a fresh profile, so the shop is at rank 0.

**Columns.**
- **Boot** is smoke's wall time from navigation to the first state.
- **Frames** excludes the harness's own screenshot stalls, as in rounds 3–5.
- **Start** is the worst interval from the `level.start` call through its first 2 s.
- **Calls** are per-frame maxima per district: main / shadow / post, against the budget 50 / 20 / 14.

| Run | Command | Verdict | Page err / console err / warn / failed req | Boot (s) | End | Frames: n, fps, p95 / p99 / worst (ms) | > 50 ms | Start (ms) | Calls max | Programs | Extra |
|---|---|---|---|---|---|---|---|---|---|---|---|
| boot | `--scenario boot` | **CLEAN** | 0 / 0 / 0 / 0 | 8.0 | title, High, "v1.2.0", "● DISTRICT 1 · SUNSET BOULEVARD" | – | – | – | – | – | – |
| ui | `--scenario ui` | **CLEAN** | 0 / 0 / 0 / 0 | 7.1 | shop, buy, back, levels (district bands), settings, play, pause, resume, quit → title | – | – | – | – | – | – |
| all-desktop | `--scenario all --desktop` | **CLEAN** | 0 / 0 / 0 / 0 | 7.8 | L1 clear ★★★, 256 survivors | 8 819, 143.9, 7.1 / 7.1 / 20.8 | 0 | 7.1 | sunset 35 / 12 / 14 | 58 | HOME mouse tap → title ✓ |
| play-l1 | `--level 1` | **CLEAN** | 0 / 0 / 0 / 0 | 7.5 | L1 clear ★★★, 242 survivors | 8 731, 143.9, 7.1 / 7.1 / 20.8 | 0 | 27.9 | sunset 35 / 12 / 14 | 58 | banner |
| play-l3-nobot | `--level 3 --nobot` | **CLEAN** | 0 / 0 / 0 / 0 | 7.5 | L3 clear ★★☆, 118 survivors | 10 898, 143.9, 7.1 / 7.1 / 20.8 | 0 | 20.8 | sunset 35 / 11 / 14 | 58 | – |
| play-l6 | `--level 6` | **CLEAN** | 0 / 0 / 0 / 0 | 7.7 | L6 clear ★★☆, 163 survivors | 12 857, 143.9, 7.1 / 7.1 / 20.8 | 0 | 34.6 | overcast 42 / 14 / 14 | 58 | banner |
| play-l11 | `--level 11` | **CLEAN** | 0 / 0 / 0 / 0 | 7.6 | alive at 110 s: 969 m, C 238 (rank 0) | 14 998, 143.9, 7.1 / 7.1 / 27.8 | 0 | 34.7 | night 40 / 13 / 14 | 58 | banner |
| play-l16-boss | `--level 16 --boss --after "g.squad.setCount(445,'debug')"` | **CLEAN** | 0 / 0 / 0 / 0 | 7.9 | L16 clear ★★☆, 286 survivors | 4 103, 144.0, 7.1 / 7.1 / 7.2 | 0 | 20.8 | toxic 38 / 10 / 14 | 58 | **TTK 21.4 s** (Juggernaut, HP 8 900, C 445 → 286) |
| play-l21 | `--level 21` | **CLEAN** | 0 / 0 / 0 / 0 | 6.8 | game over at 42 % (rank 0; round-5 calibration assumes rank ≈ 8) | 7 100, 143.9, 7.1 / 7.1 / 13.8 | 0 | 14.0 | ash 40 / 12 / 14 | 58 | – |
| play-l26-boss | `--level 26 --boss --after "g.squad.setCount(600,'debug')"` | **CLEAN** | 0 / 0 / 0 / 0 | 7.6 | L26 clear ★★★, 492 survivors | 3 808, 144.0, 7.1 / 7.1 / 7.2 | 0 | 20.8 | frozen 39 / 11 / 14 | 58 | **TTK 20.6 s** (Spitter Queen, HP 12 000, C 600 → 492) |
| play-endless | `--endless --seconds 200` | **CLEAN** | 0 / 0 / 0 / 0 | 7.7 | alive at 200 s: 1 866 m, C 21 (peak 338) | 27 048, 143.9, 7.1 / 7.1 / 41.6 | 0 | 7.1 | sunset 42 / 15 / 14; **overcast 53** / 17 / 14 | 58 | Overcast at 900 m: fade worst 7.2 ms, banner |
| all-sandbox | `--scenario all --shell sandbox` | **CLEAN** | 0 / 0 / 1 (expected "Progress won't be saved") / 0 | 5.4 | L1 clear ★★★, 258 survivors | 8 728, 143.9, 7.1 / 7.1 / 27.8 | 0 | 7.1 | sunset 35 / 12 / 14 | 58 | HOME touch tap (in the iframe) → title ✓ |
| all-artifact | `--scenario all --shell artifact` | **CLEAN** | 0 / 0 / 0 / 0 | 6.7 | L1 clear ★★★, 256 survivors | 8 728, 143.9, 7.1 / 7.1 / 20.8 | 0 | 7.2 | sunset 35 / 12 / 14 | 58 | HOME touch tap → title ✓ |
| play-low-l11 | `--quality low --level 11 --seconds 60` | **CLEAN** | 0 / 0 / 0 / 0 | 6.4 | tier Low; alive at 60 s: 606 m, C 163 | 8 299, 144.0, 7.1 / 7.1 / 13.9 | 0 | 20.8 | night 37 / 0 / 0 | 42 | item gate on Low (§1) |

**Totals.** The 12 play runs drew ≈ 124 100 frames at 143.9 fps mean, with p99 7.1 ms in every run and **0 frames over 50 ms**. The worst frame per run is 7.2–41.6 ms. The raw intervals including screenshot stalls reach 250 ms; those are excluded by design.

**Against round 4 (1.1.0)**, the end states match within bot variance:

| Run | 1.1.0 | 1.2.0 |
|---|---|---|
| L1 | ★★★, 242 survivors | ★★★, 242 survivors |
| L3 nobot | ★★☆, 121 survivors | ★★☆, 118 survivors |
| L6 | ★★☆, 160 survivors | ★★☆, 163 survivors |
| all, desktop / sandbox / artifact | 258 / 256 / 256 survivors | 256 / 258 / 256 survivors |

**Boot.** Smoke's boot is 5.4–8.0 s against 5.3–7.0 s in round 4. Served from `dist/` (§5), a first visit reaches the title in 2.8 s against 2.6–2.7 s for 1.1.0 in the same harness, and a controlled launch in 0.86–0.98 s against 0.76–0.97 s. Round 5 added the district warm-up, the boss rehearsals and the audio pre-render jobs to boot.

### 4.2 The one budget overrun

**What happened.** In the endless run's Overcast stretch, the frame at 176.8 s drew 53 main-pass draws (`callsPeak.overcast`). It came during a Hulk mini-boss fight at rank 0, with 35 zombies.

| Group | Draws |
|---|---|
| Hulk: core, four plates, skin, eyes | 7 |
| All five zombie types and the globs | 6 |
| Two troops: the medic (body, cross, ground ring) and the drone (body, LED, rotor discs) | 6 |
| Gates (an event was live) | 5 |
| fx: particles ×2, numbers, decals, floaters ×2, label, plate, clamp ×2 | 10 |
| Environment: 12 draws, plus smoke and rain | 14 |
| Soldiers, pickups, tracers, muzzles, HP bars | 5 |

**Context.** ARCH §9.1 already records that content can exceed 50: "the cap is still ≈ 60 with every troop and a boss on screen" (`r5-integrate.md` §5 item 4).
- Before the integration merged the road into one draw, the same kind of frame drew 51–54 in every district.
- The integration's own endless run, at rank 6, killed its bosses fast and peaked at 44.

**Why it is not a regression.** It is the content composition, and 1.1.0's six-segment road made every such frame 5 draws heavier.

**Frame time.** This run's p99 is 7.1 ms, and its worst frame (41.6 ms) is not that frame.

It is left open in §7 with the fix options.

### 4.3 4× CPU, L11, Medium (`EV/thr-l11-med/perf.json`)

**Setup.** The round-3 throttle profile: CDP CPU throttling ×4, 390 × 844 at DPR 2.75 with touch, Medium, the lane bot, 90 s. The level starts through `level.requestStart`, the way the menus start it.

| | Result |
|---|---|
| Frames | n 10 253, mean 8.8 ms, p50 7.0, p90 13.9, p95 14.0, **p99 20.9**, max 76.4 |
| Frame-rate distribution | 97.9 % of frames at ≥ 55 fps, 1.8 % at 45–55, 0.3 % below 45 |
| JS / draw (ms, mean / p99) | 6.35 / 13.9, and 5.2 / 11.2. No tier change |
| Frames over 50 ms | **2**: 69.4 ms at 0.14 s and 76.4 ms at 0.21 s. Both are the level-start frames: L11 was not yet generated in this page, so at 4× a generation slice runs one attempt of about 70 ms. In play the levels screen and NEXT prefetch the script. During the run itself the worst frame is 41.7 ms |
| Heap churn | 1.97 MB/s (17.7 KB per frame) |
| Boot, wall time to the title | 9.9 s. Worst painted gap 333 ms, at "Raising the dead…" (22 %). Title frames: p50 7.0 ms, worst 27.8 ms, none over 50 ms |

**Against the integration's L1 / L6 runs at 4×** (`r5/integrate/thr-l{1,6}-{a,b}`):

| | Integration | This run |
|---|---|---|
| Frame mean | 8.2–8.5 ms | 8.8 ms |
| p99 | 20.8–20.9 ms | 20.9 ms |
| Heap churn | 1.8–2.1 MB/s | 1.97 MB/s |
| Boot | 8.9–9.5 s | 9.9 s |
| Worst painted boot gap | 229–319 ms | 333 ms |

The numbers agree.

## 5. dist/ served: the update path from 1.1.0 to 1.2.0

### 5.1 How the check works

**Tool.** `EV/tools/upcheck.mjs`, plus `EV/tools/uppath.sh final`.

**Server.** One origin on port 8831 with `Cache-Control: no-cache`.
- It serves `EV/dist-handover/`, the shipped 1.1.0 with sw v3, then switches to the project's `dist/` (1.2.0, v4), the way a host deploy does.
- A throttle mode shares a fixed bandwidth among all open responses and adds a per-response round trip. An optional extra delay applies to named files.

**Browser.** Headless Chrome with a fresh context, 390 × 844 at DPR 2 with touch.

**How a launch is judged.**
- Every same-origin response the page receives is hashed (md5 of the body).
- Each hash is mapped to 1.1.0 or 1.2.0 by the md5 tables of the two dists. 18 files differ; files equal in both count for neither.
- A launch is **A**, **B** or **MIXED**, judged per document when a reload happens inside it.
- It also records: the boot outcome (the title or the error box's text), `#version`, the worker states, the cache names and entry counts, the pill, and the fonts on the offline launch.

### 5.2 Results on the final `dist/` (`EV/up-final-*`)

| Scenario | Launch | Build | Boot to title | Worker / caches |
|---|---|---|---|---|
| **fresh** (a new player) | first visit | B, "v1.2.0" | 2.8 s | v4 activated, controlling; `gaterush-v4` 32 |
| | relaunch | B, 26 / 26 from the worker | 0.98 s | `gaterush-cdn-v4` 15 |
| | offline | B | 0.98 s | Lilita One 400, Nunito 600 and 800 loaded |
| **next** (the 1.1.0 player relaunches; normal network) | 1.1.0 first visit, then relaunch | A, "v1.1.0" | 2.6 s / 0.76 s | v3 active; `gaterush-v3` 32 |
| | **first launch after the deploy** | **B**: all 18 changed files are 1.2.0, through v3's network-first | 1.2 s | v4 **installed and waiting**; the pill shows; v3 and v4 caches side by side |
| | next launch (the old page closed) | B, 26 / 26 from the worker | 0.98 s | v4 active; **only v4 caches**; no pill |
| | offline | B | 0.98 s | fonts loaded |
| **pill** | first launch after the deploy | B | 1.2 s | v4 waiting; pill "Update ready — tap to reload" |
| | real touch tap on the pill (the hit test lands on `btn-update`) | B after one reload | 0.86 s | only v4 caches; the pill gone |
| | next / offline launch | B | 0.98 s | — |
| **slow250** (250 KB/s shared, 150 ms per response) | first launch after the deploy | **MIXED**: 1.2.0 `index.html`, css, `main`, `save`, `materials`, `data`, `render`, `ui`, `environment`; 1.1.0 `audio`, `models`, `gates`, `boss`, `fx`, `level`, `levelgen` (they missed v3's 3 s budget) | 1.1 s after the page loaded; 9.0 s wall | **boots to the title, no error**; v4 waiting 18.4 s later; pill |
| | reload (still slow, still under v3) | B (v3's background refresh had stored the 1.2.0 files) | 0.87 s | — |
| | next launch | B, from v4 | 0.88 s | only v4 caches |
| **slowdata** (`data.js` 4 s late) | first launch after the deploy | document 1 **MIXED**: everything 1.2.0 except `data.js` → `SyntaxError` at link time → **heal**. Document 2 is B, 26 / 26 from v4 | **6.5 s**, no error box | v4 took over (`SKIP_WAITING`); only v4 caches |
| | reload, next launch, offline | B | 0.87–0.98 s | — |
| **slow250data** (both) | first launch after the deploy | document 1 MIXED (old `data.js` plus 7 more old modules) → heal; the boot screen read "Finishing the update…" at 3, 6 and 12 s while v4 installed over the slow link. Document 2 is B | **25.2 s** | v4 active; only v4 caches |
| | reload, next launch, offline | B | 0.86–0.90 s | — |

- Worker console errors and exceptions: **none** in any scenario.
- Page errors: none, except the `SyntaxError` of the two data-late launches. That is the link failure itself, which the heal handles.
- The rc1 run of the slowdata scenario, before the heal (`EV/up-rc1-slowdata/`), showed the raw error box. RELOAD recovered it then because the refresh had completed.

### 5.3 The heal's negative cases (`EV/healneg-final/`)

| Case | Result |
|---|---|
| **N1:** first visit with no worker, and a 1.1.0 `data.js` | the plain error box at once (10 ms); no heal, because nothing controls the page |
| **N2:** controlled by v4 with no newer worker; `js/data.js` evicted from `gaterush-v4` while the network serves a bad one | "Finishing the update…", then the update check finds nothing, then the error box 105 ms later with the boot text restored |
| **N2, second reload in the same session** | the plain box at once: the session flag stops a second heal |
| **N3:** the artifact shell with the bad `data.js` | the plain box; `window.__gateRushHeal` is undefined there |

### 5.4 Mixes that link

**What was run.** `smoke --scenario all` (boot, menus, L1 played, HOME) on seven static mixed trees, `EV/mix/out-*`, with no worker.

| Mix | 1.1.0 parts | 1.2.0 parts |
|---|---|---|
| mix1 | audio, models, boss, fx, level, gates, levelgen | everything else (the rc1 slow250 mix) |
| mix2 | every changed module | `index.html`, css, `main.js`, `data.js` |
| mix3 | `level.js` | everything else |
| mix4 | `ui.js` | everything else |
| mix5 | `environment.js`, `models.js`, `render.js` | everything else |
| mix6 | `index.html`, css | every module |
| **mixF** | the final slow250 mix | the final build, heal script included |

**Result.** **All seven are CLEAN**: L1 clear ★★★, HOME → title, 0 errors.

**Why they work.** The round-4 and round-5 cross-module guards hold. For example, ui falls back to `level.start` without `requestStart`.

**What a player sees in such a launch.** Degraded but working; for example, with an old `level.js` the scene stays District 1.

**Summary.** On a normal network every launch is one consistent build. On a slow network:
- the first launch through the old worker can mix the builds once;
- a mix that links plays;
- a mix that cannot link now finishes the update instead of failing;
- from v4 on, a launch never mixes, as in r5-ui-sw's two-build test.

## 6. Screens reviewed

Nothing is visibly broken. The `?debug=1` overlay in the smoke shots is not shown to players.

| Screen | File | What it shows |
|---|---|---|
| Title (phone) | `EV/m1-boot/00-title.png` | Logo, the title squad, PLAY, "LEVEL 1", "● DISTRICT 1 · SUNSET BOULEVARD", SHOP, LEVELS, settings, fullscreen, coins, **v1.2.0** bottom right |
| Title (desktop, after HOME) | `EV/m1-all-desktop/17-home.png` | Side rig, "LEVEL 2", badged SHOP, v1.2.0; no lamp or gate in the near field |
| One per district | `EV/sheets/districts.png` (sources: `m1-play-l1/03`, `m1-play-l6/04`, `m1-play-l11/04`, `m1-play-l16-boss/01`, `m1-play-l21/03`, `m1-play-l26-boss/01`) | Sunset: orange haze, ×3 gate, the crate hint. Overcast: rain, the ÷2 pair, +12. Night City: neon, lit windows, count 61. Toxic: olive smog, the JUGGERNAUT name card. Ash: red sky, a +3 gate. Frozen: snow, pines, the SPITTER QUEEN card. All six are distinct and readable |
| Boss fights | `EV/sheets/boss-results.png` (`m1-play-l16-boss/03-play-17s.png`, `m1-play-l26-boss/03-play-17s.png`); endless Hulk in `EV/sheets/endless.png` | HP bars, two-row damage numbers, counts 325 and 528 |
| Endless rotation | `EV/sheets/endless.png` (`m1-play-endless/13…17, 26…30`) | At 892 m Sunset; at 906 m the "DISTRICT 2 · OVERCAST HIGHWAY" banner as the fade starts; at 940 m Overcast with rain |
| Results | `m1-play-l16-boss/05-result.png`, `m1-play-l26-boss/05-result.png`, `m1-play-l3-nobot/11-result.png`, `m1-play-l21/08-result.png` | HOME icon, "LEVEL n CLEAR", stars, coins and chips, survivors, NEXT / REPLAY / badged SHOP; the L21 game over shows "SQUAD LOST, Reached 42 % · Coins kept +137" with RETRY |
| Shop | `EV/m1-ui/02-shop-bought.png` | 4.8K coins, five cards with icons, one start-squad pip bought, prices |
| Levels | `EV/m1-ui/03-levels.png` | District accent rules on the tiles, milestone skulls, the ENDLESS row |
| Low tier | `EV/m1-play-low-l11/05-play-33s.png`, `EV/sheets/low-item-crop.png` | Night City on Low with no shadows; the drone item icon on its dark plate next to a MAX +48 gate |
| Update path | `EV/up-final-slow250data/3-B-launch-1-at6000ms.png`; `EV/up-final-pill/3-B-launch-1.png` | The boot screen with "Finishing the update…"; the update pill on the title |

## 7. Remaining issues (honest list)

1. **Draw-call budget: one endless frame at 53 main draws** (§4.2). It happens with a mini-boss, two troops, five zombie types and a live gate event on screen. It is not a regression, and frame time is unaffected on this host, but the release criterion "draw calls within budget" is not met for that frame.
   - Fix options (content, for the boss / models / troops owners):
     - draw the Hulk and Colossus plates as one instanced draw (−3);
     - instance the troop rings and merge the troops' glow parts (−2 to −4);
     - or count the overlay pass's second clamp and floaters draws against post, not main.
   - The integration's §5 item 4 already proposed a content budget.
2. **The first launch after the update can mix builds on a slow network** (§5).
   - **Cause.** The installed v3 worker serves code network-first; nothing in 1.2.0 can change it.
   - **What happens now.**
     - A mix that links plays: seven mixes tested.
     - A mix that cannot link finishes the update ("Finishing the update…"). On a very slow link that took 25 s in the test.
   - **Still open (cosmetic, that one launch only).**
     - The scene and the HUD can disagree. For example, the title caption names the player's district while an old `level.js` keeps District 1 on screen.
     - On a fast first launch, the update pill says "Update ready" although the page already runs 1.2.0; tapping it reloads into the same version.
3. **The claude.ai artifact still serves 1.1.0** (§1). It is the README's "Option 1"; updating it is one publish to its URL, left for the user.
4. **Lead decisions, still open; none is a code defect.**
   - **From the balance audit:**
     - the per-layout leak spread is larger than the band; the fix is in the generator's leak solve;
     - L31's canonical layout leaks 43.8 %;
     - boss TTK is flat, or shorter, below E_boss at high ranks.
   - **From the level owner:**
     - the passive bot fails 10–12 of 18 levels on the first attempt (L13–L30), and L23 needs 4 attempts;
     - the boss-damage upgrade is worth less at E_boss;
     - the 7 validator warnings are accepted;
     - suppressing the banner on the first L1 run.
   - **Round-3 residuals:** L12 leaks 29.3 % against its 22–28 band; L10's non-canonical layouts.
5. **Art.**
   - The four readability cells are accepted in DISTRICTS §14, and so is Frozen's ×1 panel.
   - Toxic's smokestack plumes do not show in portrait play; that is an art-direction call.
   - The Low glow breathing (`GATE_RULES.glow.pulseAmp`) and a larger `ICON_H` are not used.
6. **Needs a real mid-range phone (perf QA).**
   - The art review's road-shader ALU terms, the rain's fill cost (DISTRICTS §10.12), and the 4× Overcast GPU-process stall (r5-integrate §5 item 9).
   - This desktop GPU hides fragment cost; the quiet-host A/Bs show no CPU cost.
   - The audio pre-render buffers cost ≈ 3 MB of memory (r5-perf-audio).
7. **4× CPU.**
   - A level started from the title before its script exists gives one 69–76 ms start frame (§4.3). The menus' prefetch normally prevents it.
   - The throttled boot's worst painted gap was 333 ms in this run (319 ms in the integration's).
   - fx's first `boss:intro` stays cold: the cost is `navigator.vibrate`, which cannot be warmed before a gesture.
8. **Development workflow.** v4 serves code cache-first.
   - Any browser that opened `node tools/serve.js` on `localhost` (a secure context, so the worker registers) keeps its cached build after edits until `sw.js` changes.
   - The smoke harness uses fresh profiles and is not affected.
   - Developers should use DevTools' "Update on reload" or "Bypass for network".
   - On a LAN IP over plain HTTP (README Option 3), no worker registers.
   - **Why `VERSION` stays v4.** No shipped build carried v4: production served v3 until this release, so v4 names a fresh cache for every installed player.
   - **The caveat.** A developer profile that installed a round-5 v4 worker from `localhost` would get this build under the same cache name. That is the hazard the release rule exists for, and clearing that site's data once removes it.
9. **Not re-measured here:**
   - the audio battery and the same-sound proof (r5-perf-audio);
   - the balance and endless suites;
   - the FTUE session;
   - the §10.3 readability pass.

   They measured this code. My code changes on top are:
   - the item icon on Low (verified in §1; inert on the composer tiers);
   - the boot heal, which runs on load failures only;
   - the version strings.

## 8. Files changed in this pass

| File | Change |
|---|---|
| `js/gates.js` | `makeQuadMaterial(map, uvAttr, toneMapped = false)`; the item icon passes `true` (r5-art 1); comment |
| `index.html` | BOOTGUARD: `fail()` asks `window.__gateRushHeal` before the error box, and the stall watchdog waits during a heal. New inline script after `END BOOTGUARD`: the update heal (§2.2) |
| `artifact.html` | rebuilt (the BOOTGUARD hook; no heal script, no worker code) |
| `js/main.js` | `VERSION` `'1.1.0'` → `'1.2.0'` |
| `package.json`, `package-lock.json` | version 1.2.0 |
| `sw.js` | comments only: the v4 header line names release 1.2.0; the `SKIP_WAITING` handler records the heal's use. `VERSION 'v4'` unchanged |
| `docs/ARCHITECTURE.md` | §3 `ctx.version`; §9.4 the LDR icon is tone-mapped on Low; §15.1 the update heal; §15.4 the 1.1.0 → 1.2.0 transition |
| `docs/GDD.md` | §14 Overlays: "Finishing the update…"; §15 materials: the item icon is tone-mapped on every tier |
| `docs/build/r5-level-balance.md` | three "within 3 attempts" claims corrected to 4 (L23), marked as release corrections (r5-balance-audit 4) |
| `docs/build/CALLSITES.md` | regenerated (line numbers only) |
| `dist/` | rebuilt (33 files, sw v4, build `58d6a2c25386`) |
| `gate-rush-dist.zip` | regenerated from `dist/` (1.2.0) |
| `docs/build/r5-release.md` | this report |

ARCH §14 holds:
- the heal is event-time code on a failure path, with no per-frame work and every browser API guarded (`navigator.serviceWorker`, `sessionStorage`, `postMessage`, `reload`);
- the icon change is a material flag set at init;
- no `console.log` and no `Math.random`.

## Evidence index

| Path | Contents |
|---|---|
| `EV/src-before/`, `EV/src-before-md5.txt`, `EV/md5-final.txt` | The tree as handed over, and the md5s before and after |
| `EV/dist-handover/`, `EV/gate-rush-dist-handover.zip`, `EV/dist-final-md5.txt`, `EV/gate-rush-dist-1.2.0.zip`, `EV/zip-check/` | The shipped 1.1.0 build; the 1.2.0 dist md5s, zip and extraction check |
| `EV/static/` | Static-check outputs (`before-*`, `final-*`), `package.js` re-run, the release-rule refusal test (`pkgtest-refusal.txt`) |
| `EV/m1-<run>/`, `EV/m1-matrix.log`, `EV/m1-summary.json` | Matrix reports and screenshots |
| `EV/thr-l11-med/` | The 4× throttled run (`perf.json`, title and final shots) |
| `EV/up-final-<scenario>/`, `EV/up-final-*.stdout.json`, `EV/up-final.log` | Update path on the final `dist/` (report, per-launch screenshots) |
| `EV/up-rc1-*`, `EV/up-rc2-*` | The same scenarios on the release candidates (rc1: the raw `SyntaxError` before the heal) |
| `EV/healneg-final/` | The heal's negative cases |
| `EV/mix/` | The seven mixed trees and their smoke reports (`out-mix*`) |
| `EV/iconprobe-{before,after}/`, `EV/iconprobe-low-ab*.png`, `EV/iconprobe-med-vs-low-after.png` | The icon A/B |
| `EV/sheets/` | Contact sheets: districts, bosses and results, endless, the Low item crop |
| `EV/tools/` | Every tool above, and `edits/01…09` |
