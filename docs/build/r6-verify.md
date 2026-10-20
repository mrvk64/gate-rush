# Round 6: verification

This pass verifies the three round-6 changes for the owner's phone playtest, on top of the shipped 1.2.1 (`sw.js` v6):
- `r6-weapons.md`: stored weapons and the HUD FIRE button (owner item 1). `js/weapons.js`, `js/pickups.js`, `js/ui.js`, `js/level.js`, `js/data.js`, `css/game.css`, `index.html`, `tools/smoke.js`.
- `r6-backguard.md`: the Android Back guard (owner item 2). `js/engine.js`, `js/main.js`.
- `r6-textures.md`: procedural textures that survive a GPU-process loss (owner item 3). `js/render.js`.

The evidence root is `E:/Temp/claude/gate-rush-evidence/r6/verify/`, written `EV/` below. The handed-over tree is copied byte for byte in `EV/src-before/` (md5 list `EV/src-before-md5.txt`). `EV/head/` is `git archive HEAD`, the shipped 1.2.1, used as the control.

**Verdict: PASS, after one fix.**
- **Static checks.** All green (§3).
- **Smoke matrix.** All 11 runs are **CLEAN**, on the handed-over tree (m1) and on the final tree (m2). 0 frames over 50 ms. Main-pass draws peak at 48 (budget 50).
- **The three owner items.** Each passes its targeted repro on the final tree (§2). On 1.2.1 the texture repro fails exactly like the owner's phone (§2.1).
- **The fix: the Back guard let the second Back close the app.** It was found with a browser-initiated Back, the path Android's back gesture takes (§2.2).
  - **Measured.** `page.goBack()` and `history.back()` passed every check. A real browser Back paused the first time, but a second Back with no touch in between closed the app.
  - **Cause.** Chrome's history-manipulation intervention. The guard entry re-pushed from `popstate` never has a fresh user activation, so Chrome marked the page's own entry skippable.
  - **Change.** The guard is now re-armed with `history.forward()` onto the entry the Back just left. A history move adds no entry, so Chrome has nothing to skip.
  - **Result.** Every Back during a run now pauses (4 in a row tested), and the history never grows.
- **Release request applied.**
  - `sw.js` `VERSION` is now `'v7'`.
  - `dist/` and `gate-rush-dist.zip` are rebuilt.
  - The v6 → v7 update path works, both on the next launch and through the pill (§5).

## 1. needsOtherGroup requests

| Source | Request | Status | Where |
|---|---|---|---|
| backguard → release | "Bump the `sw.js` VERSION and rebuild with `node tools/package.js`, or an installed PWA keeps serving the cached 1.2.1 engine.js" | **Applied** | `sw.js` `'v6'` → `'v7'` plus a header line. ARCH §3 `ctx.version` row and §15.4 name v7. `dist/` (package.js --check) and `gate-rush-dist.zip` are rebuilt (§5) |
| backguard → ui | "Nothing required". An optional public `ui.back()` would replace engine's `click()` on the screens' buttons | **Not applied.** It is optional and changes no behaviour, and the DOM-click path passed all 43 Back checks. The ids engine relies on (`[data-back]`, `#btn-complete-home`, `#btn-home`, `#btn-endless-home`) are unchanged | — |
| textures → release | "dist/ and artifact.html need the usual rebuild" | **Applied** | `artifact.html` rebuilt; its bytes are unchanged (md5 `5e3a7b8f…`), because `index.html` did not change in this pass. `dist/` rebuilt |
| weapons (note) | `callsites.js` was run but `CALLSITES.md` was reverted, because it would have picked up the other teams' in-flight edits | **Applied** now that the tree is final | `docs/build/CALLSITES.md` regenerated (640 lines). It now lists `weapons.storeWeapon` / `requestFire` / `storedCount` / `storedId`, `engine.armBackGuard`, and the `weapon:stored` and `ui:screen` events |
| weapons, textures, backguard (notes for the lead) | Hint timing; the two weapon displays; the cost of a phone restore; the owner phone checks | Lead / owner items, listed in §7 | — |

## 2. Targeted repros

All runs use headless Chrome 155 on the real GPU: 390 × 844 @ 2, touch, real CDP touch input. Host: i7-8700K, RX 6800, ANGLE D3D11, 144 Hz. The harnesses are in `EV/tools/`.

### 2.1 (a) Textures after context loss, canvas loss and resume — `EV/tools/tex.mjs`

**Scene for every step.** The setup matches the owner's screenshot (`EV/tex-final/00-baseline.png`):
- L6 Overcast, in the rain;
- a gate pair in view with one `+` lane driven to MAX through `gates.applyHit`, so the gold badge and the "MAX" letters show;
- the squad count plate;
- HUD icons: a running weapon pill, a chip gear pill and the FIRE button pictogram;
- the game PAUSED.

**Checks after each step.**
- **Textures.** Every TextureFactory canvas is read twice: its ink on the CPU canvas, and its ink on the GPU copy (a framebuffer readback of three's WebGL texture). Both must equal the boot baseline (atlas 88 448 px, icons 9 195, road 524 288 …).
- **Screenshots.**
  - The paused scene, with the screens hidden: gate digits, MAX badge, count label.
  - Then resumed, with a forced floater (`+25`), three damage numbers (120 / 127 / 134) and an icon flight.
- **DOM HUD icons.** Each visible icon's `background-image` is decoded and ink-counted.
- **Frames.** The interval timings are recorded.

| Step | What it does | Final tree | 1.2.1 (control) |
|---|---|---|---|
| webgl | `WEBGL_lose_context` mid-level (running), restore 0.8 s later | **PASS**. `all:webgl` re-draw, 48 ms; 2 events (WebGL only). One 62.5 ms frame behind "Reloading graphics…"; resumed play ≤ 7.1 ms | PASS (a WebGL-only loss keeps GPU canvases) |
| 2d | `contextlost` on every canvas → cleared → the blanks uploaded (`04-2d-broken.png`: no digits, no lane paint, no windows) → `contextrestored` | **PASS**. Each recipe re-drawn on its own event (`<name>:2d`, ≤ 3 ms); no frame > 14 ms | **FAIL**: every canvas stays blank (`EV/tex-head-1.2.1/`) |
| frozen | The phone state: the atlas canvas blank AND that blank uploaded (`07-frozen-broken.png` matches the owner's screenshot), then hidden → CDP `frozen` 2 s → `active` → visible | **PASS**. `verify()` on resume → `all:blank:digitAtlas`, 62 ms. It ran in the resume task, so the first visible frame was 13.9 ms | **FAIL**: the digits stay missing (`EV/tex-head-frozen/`) |
| longhidden | The same phone state, then hidden for 30 s → visible | **PASS**. 58 ms re-draw on `visibilitychange`; frames ≤ 13.9 ms | **FAIL**: the digits stay missing (`EV/tex-head-longhidden/`) |
| gpucrash | CDP `Browser.crashGpuProcess`, the real thing (Android reclaiming the GPU process) | **PASS**. **No 2D events at all**: the CPU-backed canvases survived. The WebGL restore re-draws (`all:webgl`, 68 ms) | **FAIL** (`EV/tex-head-gpucrash/`, run with no 2D readback first): 20 2D events, every GPU texture 0 ink, `03-gpucrash-fx.png` shows no digits, MAX, count, floaters, damage numbers or lane paint |

**Extra runs.**
- **Low tier** (`EV/tex-live-low/`): 2d, frozen and gpucrash all PASS; 42 programs.
- **No-readback GPU crash** (`EV/tex-live-gpucrash-noread/`): PASS. Chrome moves a canvas that was read back to the CPU, which would hide the bug, so this run reads nothing first.

**Common to every step.**
- `renderer.info.programs` stays at 58 (42 on Low).
- HUD icons stay inked: coin, chip, shotgun pill, and the FIRE pictogram at 128 px (`weapon.rocket` 6 824 px).
- 0 page or console errors. The only warning is Chrome's own `loseContext`.

**Restore cost.** The crash step's long frames, 207 / 198 / 146 ms in the first 0.6 s, are the GPU process restarting and the programs being re-linked; 1.2.1 shows the same profile (205–237 ms). After a WebGL-only loss the restore frame is 62–69 ms (1.2.1: 48.5 ms). The re-draw itself takes 48–68 ms on this host, so plan for about 3× that on a phone.

**Pixels.** `EV/tools/texdiff.mjs` compared every canvas, 1.2.1 against this round (`EV/texdiff/texdiff.json`).
- **Identical:** glow, particle, dust, windows and muzzle.
- **Within 1/255 per channel:** road (26 % of pixels), atlas (226 px), smoke (2.2 %) and icons (27 px).
- **Facade:** 8 % of pixels, ≤ 3/255.
- No pixel differs by more than 3/255, so `_wrapY`'s skipped seam copies drop no shapes. The ±1 values are rounding in the un- and re-premultiply step, not visible. The ink counts are identical.

**Boot at 4× CPU** (`EV/tools/bootgap.mjs`, 390 × 844 @ 2.75, alternating, 3 + 3 boots):

| | Time to title | Worst rAF gap from document start to title + 1 s |
|---|---|---|
| 1.2.1 | 9.68–9.89 s | 243–320 ms |
| this round | 9.78–10.02 s | 250–319 ms |

The worst gap sits at ≈ 6.2–6.5 s in both trees, with the same size. The texture change does not move boot.

### 2.2 (b) Android Back guard — `EV/tools/back.mjs`, `back-fallback.mjs`, `backguard-test-author.mjs`

**Part 1: index shell, `page.goBack()` / `history.back()`.** The task's list; results and HOME are reached by real play. **25 / 25 PASS** on both the handed-over and the final tree.

| Check | Result |
|---|---|
| title after boot | guard armed, no entry (`history.length` L0) |
| PLAY tap | playing, guard pushed once (L0 + 1) |
| `page.goBack()` while playing | **paused**, URL unchanged (not exited), guard back |
| `page.goBack()` again; `history.back()` again | **still paused** |
| RESUME → `history.back()` | paused |
| settings over pause → Back | settings' BACK → pause screen, guard kept |
| QUIT | title, guard dropped |
| levels / shop → Back | their BACK (`ui:button` 'back') → title, not re-pushed; their BACK buttons drop the guard |
| settings over title → Back | title, no re-push |
| level complete (boss killed), game over (squad killed by the boss), endless results (horde) → Back | their HOME (`ui:button` `btn-complete-home` / `btn-home` / `btn-endless-home`) → title |
| reload on the guard entry | title, guard dropped, no extra entry |
| Back on the title | **leaves** (about:blank) |
| at most one guard entry | `history.length` and the CDP entry list never exceed L0 + 1 |

**Parts 2 and 3: artifact and sandbox shells.** **6 / 6 PASS.**
- The guard is not armed (`_guardOk` false).
- PLAY pushes no entry, in the top page and in the frame.
- Back keeps the browser default: it leaves the page.
- Only the expected sandbox warning appears ("Progress won't be saved").

**Part 4: a browser-initiated Back.**
- **Method.**
  - A test-only extension (`EV/tools/backext/`) calls `chrome.tabs.goBack` → `NavigationController::GoBack`. That is the code path Android's back gesture and button take, and the only one where Chrome's history-manipulation intervention applies.
  - `page.goBack()` (`Page.navigateToHistoryEntry`) and `history.back()` bypass the intervention, so they cannot show it.
  - Every page read in this part uses `Runtime.evaluate { userGesture: false }`, so the harness grants no user activation of its own.
- **The rule, first measured on a two-page probe** (`EV/navprobe/probe4*.json`).
  - A push made after a tap is honoured.
  - A push made with no fresh activation marks the entry it was made from as skippable. Back then jumps over it.
  - An activation from *before* a Back does not carry over that Back (probe F).
  - A tap after the push clears the mark again.
  - Stepping forward with `history.forward()` adds no entry, and four Backs in a row never left the page (probe J).
- **Handed-over tree** (`EV/back-handover/`, `EV/back-handover-part4/`).
  - Back #1 while playing pauses.
  - **Back #2 with no touch in between left the page**, at `0/3 about:blank`. On the phone that closes the app.
  - Owner check (b) of r6-backguard, "Back again → still paused", would have failed.
- **Fix in `js/engine.js`.**
  - `_popState` runs the screen's Back with the nested `ui:screen` syncs held (`_guardForwarding`).
  - Then `_rearmGuard()` steps forward onto the guard entry: `history.forward()`, whose popstate is consumed like the drop's. It does this unless that Back landed on the title.
  - If no forward popstate arrives within `BACK_GUARD_FORWARD_MS` (600 ms), or `forward()` throws, it falls back to the push.
  - About 35 added lines, plus ARCH §6.2 ("Re-arm") and the GDD Lifecycle line.

**Final tree** (`EV/back-final/`): **43 / 43 PASS**, 0 page or console errors.

| Part 4 sequence (browser-initiated Back, no harness activation) | Result |
|---|---|
| A: PLAY tap + a steering drag, then Back #1 | paused |
| A: Backs #2, #3, #4 with no touch in between | **paused every time, still in the app**; entries 3 before and after (nothing added) |
| A: RESUME, Back | paused again |
| E: settings over pause → Back → Back (no touch) | pause screen, then still paused |
| E: QUIT → title → Back | leaves the app |
| B: RESUME + steering between Backs; a tap on the pause screen between Backs | paused each time |
| C: levels → Back → Back | title, then leaves |
| D: level complete → Back → Back | title (HOME), then leaves |

- **Fallbacks** (`EV/back-final/fallback.txt`): **4 / 4 PASS**.
  - With `history.forward` stubbed as a no-op, the guard is pushed again after 600 ms (one entry).
  - With a throwing `forward`, it is pushed at once.
  - With the real `forward`, the traversal re-arms it.
- **Cross-check.** The back-guard author's own 25-check test, re-run on the final tree: **25 / 25 PASS** (`EV/back-author-test/`).

### 2.3 (c) Stored weapons — `EV/tools/weapons.mjs`

Real pickup paths are used: a crate spawned on the road, or `pickups.grantItem`. Every FIRE press is a real CDP touch tap on `#btn-fire`. **21 / 21 PASS** on the final tree (`EV/weapons-final/`), 0 page or console errors, 0 warnings. The handed-over tree passed the same suite (`EV/weapons-live/`, before the refund-bucket check was tightened).

| Check | Result |
|---|---|
| crate pickup | weapon **stored, not started**; `weapon:stored` before `item:pickup` |
| FIRE button | shown `.ready`, shotgun pictogram, aria "Fire shotgun", 76 px (≥ 64) |
| hint | "TAP THE GUN BUTTON TO FIRE" shown (after "DRAG TO STEER") |
| waits | 5 s later still stored, nothing running |
| tap FIRE | shotgun starts, `weapon:start` duration **10** |
| full duration | level clock from start to end: **9.983 s** (one fixed step under 10) |
| 2nd weapon while one runs | stored; the tap is **refused** (shotgun keeps running, minigun waits, button `.busy` shows the minigun) |
| 2 stored | "×2" badge |
| 3rd pickup | nothing replaced; **25 c `refund`**; `item:pickup` duplicate |
| after the run | ready with the next one (FIFO: the minigun, full 10 s); the rocket stays stored |
| level won with 2 stored | none started on their own through the boss intro and fight; **2 × 25 c `refund` at phase `won`**, credited before the survivor bonus (`run.breakdown.bonus` +50 exactly); slot emptied |
| boss fight with a saved rocket (L9) | the rocket is kept through the intro (stored, `.ready`); FIRE in the fight starts it (duration 8, phase `boss`); 5 rockets fired; boss HP rate 527 → 1 023 / s |
| endless | FIRE starts a stored weapon; the run lost with 2 stored → slot cleared, **no refund emitted after `lost`**, button hidden |
| RESTART with 2 stored | cleared, no payout, button hidden |
| two fingers | the steering drag keeps steering (`targetX` 0 → 2.1) while a second finger taps FIRE (the rocket starts) |
| Space | fires the stored weapon |

The screenshots show the ready state with the FIRE tag and the hint pill moved left (`00-w1-stored-ready.png`), the "×2" badge (`02-…`), the busy ring during the boss fight (`05-…`), and no FIRE button on the results screen (`03-…`).

## 3. Static checks (`EV/static/`)

| Check | Handed over | Final |
|---|---|---|
| `node --check` on `js/*.js` (22), `tools/*.js` (8) and `sw.js` | 31 files, 0 failures | 31 files, 0 failures |
| `node tools/check-imports.js` | 0 errors, 0 warnings | 0 errors, 0 warnings |
| `node tools/validate-levels.js` | 30 levels · 7 warnings · **0 errors** | identical, timings aside |
| `node tools/build-artifact.js` | "PRECACHE covers all 22 files"; 190 lines, 15 979 bytes; `artifact.html` unchanged (md5 `5e3a7b8f…`) | same |
| `node tools/package.js --check` | **refused**: "VERSION is still 'v6' but the build changed (f7f1faf4f05a → 45ba3490ea4a)" | **pass**: "precache OK (31 files …; cache version v7; build 3a88a60917ba)"; `dist/` 33 files, 2 623 KB |
| `console.log` / `Math.random` in `js/` and `sw.js` | comments only (util.js owns randomness) | same |

**Review against ARCH §14.**
- **No per-frame allocation in the new code.**
  - ui's `_updateFire` reads getters and writes the DOM on change only.
  - `_pollGamepadFire` allocates the gamepad list only after a `gamepadconnected` and while the button shows, as engine's own pad poll does.
  - The texture probe and re-draw paths run on resume or restore only.
  - The back guard runs on `popstate` and `ui:screen` only.
- **Every new browser API is guarded:** history, `document.fonts`, `getImageData`, `ctx.reset`, canvas events and `getGamepads`.

## 4. Smoke matrix

**How the runs were made.**
- Every run used `node tools/smoke.js … --bootTimeout 90 --out EV/<tag>-<run>`, sequentially, through `EV/tools/matrix.sh`.
- **m1:** the handed-over tree, run through `EV/src-before/tools/smoke.js` so its own root is served.
- **m2:** the final tree, with `tools/smoke.js` from the project.
- Auto quality → High. Fresh profile, so shop rank 0.

**Columns.**
- **> 50 ms** counts `longFrames` (the screenshot stalls are excluded, as the harness defines it).
- **Start** is the worst frame from `level.start()` through the first 2 s.
- **Calls max** is the per-frame main / shadow / post maximum per district.
- **FIRE** counts the bot's real taps on `#btn-fire`, all of which started their weapon.

**m1, the handed-over tree** (`EV/m1-summary.txt`, `EV/m1-table.md`):

| Run | Command | Verdict | Page err / console err / warn / failed req | Boot (s) | End | Frames: n, p99 / worst (ms) | > 50 ms | Start (ms) | Calls max main / shadow / post | Programs | FIRE presses |
|---|---|---|---|---|---|---|---|---|---|---|---|
| boot | `--scenario boot` | **CLEAN** | 0 / 0 / 0 / 0 | 7.8 | title, high | – | – | – | – | – | – |
| ui | `--scenario ui` | **CLEAN** | 0 / 0 / 0 / 0 | 7.3 | title, high; shop, buy, levels, settings, play, pause, resume, quit → title | – | – | – | – | – | – |
| all-desktop | `--scenario all --desktop` | **CLEAN** | 0 / 0 / 0 / 0 | 7.5 | ★★★, 258 survivors; HOME mouse → title | 8 814, 7.1 / 13.8 | 0 | 7.1 | sunset 34 / 12 / 14 | 58 | 1 (1 started) |
| play-l1 | `--level 1` | **CLEAN** | 0 / 0 / 0 / 0 | 8.0 | ★★★, 242 survivors | 8 747, 7.1 / 20.8 | 0 | 34.7 | sunset 34 / 12 / 14 | 58 | 1 (1 started) |
| play-l6 | `--level 6` | **CLEAN** | 0 / 0 / 0 / 0 | 7.6 | ★★★, 166 survivors | 12 871, 7.1 / 20.7 | 0 | 48.6 | overcast 42 / 14 / 14 | 58 | 1 (1 started) |
| play-l11 | `--level 11` | **CLEAN** | 0 / 0 / 0 / 0 | 7.8 | alive at 109 s, 969 m, C 240, boss 1275/6000 p3 | 14 973, 7.1 / 21 | 0 | 27.7 | night 39 / 13 / 14 | 58 | 1 (1 started) |
| play-l16-boss | `--level 16 --boss --after "g.squad.setCount(445,'debug')"` | **CLEAN** | 0 / 0 / 0 / 0 | 7.6 | ★★☆, 286 survivors | 4 128, 7.1 / 7.2 | 0 | 34.7 | toxic 34 / 10 / 14 | 58 | 0 (0 started) |
| endless-240 | `--endless --seconds 240` | **CLEAN** | 0 / 0 / 0 / 0 | 7.4 | alive at 234 s, 2252 m, C 181 | 32 314, 7.1 / 48.6 | 0 | 7.1 | sunset 41 / 15 / 14; overcast 45 / 17 / 14; night 48 / 17 / 14 | 58 | 1 (1 started) |
| all-artifact | `--scenario all --shell artifact` | **CLEAN** | 0 / 0 / 0 / 0 | 6.6 | ★★★, 256 survivors; HOME touch → title | 8 714, 7.1 / 20.9 | 0 | 7.1 | sunset 34 / 12 / 14 | 58 | 1 (1 started) |
| all-sandbox | `--scenario all --shell sandbox` | **CLEAN** | 0 / 0 / 1 (the expected "Progress won't be saved") / 0 | 5.4 | ★★★, 258 survivors; HOME touch → title | 8 724, 7.1 / 20.9 | 0 | 7.2 | sunset 34 / 12 / 14 | 58 | 1 (1 started) |
| low-l21 | `--quality low --level 21 --seconds 50` | **CLEAN** | 0 / 0 / 0 / 0 | 7.7 | squad lost at 600 m (reached 42 %) | 6 941, 7.1 / 13.9 | 0 | 27.8 | ash 38 / 0 / 0 | 42 | 0 (0 started) |

**m2, the final tree** (`EV/m2-summary.txt`, `EV/m2-table.md`):

| Run | Command | Verdict | Page err / console err / warn / failed req | Boot (s) | End | Frames: n, p99 / worst (ms) | > 50 ms | Start (ms) | Calls max main / shadow / post | Programs | FIRE presses |
|---|---|---|---|---|---|---|---|---|---|---|---|
| boot | `--scenario boot` | **CLEAN** | 0 / 0 / 0 / 0 | 7.1 | title, high | – | – | – | – | – | – |
| ui | `--scenario ui` | **CLEAN** | 0 / 0 / 0 / 0 | 7.4 | title, high; shop, buy, levels, settings, play, pause, resume, quit → title | – | – | – | – | – | – |
| all-desktop | `--scenario all --desktop` | **CLEAN** | 0 / 0 / 0 / 0 | 7.5 | ★★★, 258 survivors; HOME mouse → title | 8 841, 7.1 / 20.9 | 0 | 7.1 | sunset 34 / 12 / 14 | 58 | 1 (1 started) |
| play-l1 | `--level 1` | **CLEAN** | 0 / 0 / 0 / 0 | 7.7 | ★★★, 239 survivors | 8 739, 7.1 / 20.9 | 0 | 27.8 | sunset 34 / 12 / 14 | 58 | 1 (1 started) |
| play-l6 | `--level 6` | **CLEAN** | 0 / 0 / 0 / 0 | 7.5 | ★★☆, 162 survivors | 12 874, 7.1 / 20.8 | 0 | 20.8 | overcast 42 / 14 / 14 | 58 | 1 (1 started) |
| play-l11 | `--level 11` | **CLEAN** | 0 / 0 / 0 / 0 | 7.1 | alive at 109 s, 969 m, C 240, boss 1093/6050 p3 | 14 993, 7.1 / 20.9 | 0 | 27.7 | night 39 / 13 / 14 | 58 | 1 (1 started) |
| play-l16-boss | `--level 16 --boss --after "g.squad.setCount(445,'debug')"` | **CLEAN** | 0 / 0 / 0 / 0 | 7.8 | ★★☆, 285 survivors | 4 118, 7.1 / 7.2 | 0 | 34.7 | toxic 34 / 10 / 14 | 58 | 0 (0 started) |
| endless-240 | `--endless --seconds 240` | **CLEAN** | 0 / 0 / 0 / 0 | 7.3 | alive at 234 s, 2253 m, C 233 | 32 312, 7.1 / 48.4 | 0 | 7.1 | sunset 41 / 17 / 14; overcast 48 / 18 / 14; night 47 / 18 / 14 | 58 | 0 (0 started) |
| all-artifact | `--scenario all --shell artifact` | **CLEAN** | 0 / 0 / 0 / 0 | 6.6 | ★★★, 256 survivors; HOME touch → title | 8 740, 7.1 / 20.8 | 0 | 7.2 | sunset 34 / 12 / 14 | 58 | 1 (1 started) |
| all-sandbox | `--scenario all --shell sandbox` | **CLEAN** | 0 / 0 / 1 (the expected "Progress won't be saved") / 0 | 5.6 | ★★★, 256 survivors; HOME touch → title | 8 741, 7.1 / 20.8 | 0 | 7.1 | sunset 34 / 12 / 14 | 58 | 1 (1 started) |
| low-l21 | `--quality low --level 21 --seconds 50` | **CLEAN** | 0 / 0 / 0 / 0 | 7.0 | squad lost at 604 m (reached 42 %) | 6 968, 7.1 / 20.8 | 0 | 34.6 | ash 38 / 0 / 0 | 42 | 0 (0 started) |

**Notes.**
- **The requested limits hold in every run:** CLEAN, 0 frames over 50 ms, main-pass draws ≤ 50.
- **The worst in-play frame** is 48.6 ms in endless (m1; m2 48.4 ms). It is the same as r5b's rank-4 endless worst, and under 50.
- **The worst start frame** is 48.6 ms (L6, m1), inside the first 2 s after `level.start()`. It was 20.8 ms on the m2 re-run: first-draw variance, like r5d's 48.5 ms.
- **The FIRE bot.** Every press started its weapon. The L16 boss jump, L21 Low and m2's endless run picked up no weapon, so there was nothing to fire.
- **Results versus r5d.** Run-to-run bot variance aside, they match.
  - L1 has 242 / 239 survivors (r5d: 239 / 242). L6 has ★★★ 166 / ★★☆ 162 (r5d: ★★☆ 161).
  - L16 boss has 286 / 285 (r5d: 286).
  - L21 Low is lost at 42 % at rank 0, like 1.2.0 and 1.2.1.
  - Endless is alive at 240 s in both, at 2 252 / 2 253 m (r5d's rank-0 run was lost at 243 s).

## 5. Builds and the update path

| What | Result |
|---|---|
| `sw.js` | `VERSION = 'v7'`, plus the header line "v6 → v7: the round-6 build …". v6 shipped in the 1.2.1 `dist/`, so this build needs its own cache |
| `dist/` | `node tools/package.js --check`: 33 files, 2 623 KB; `dist/sw.js` stamp `3a88a609…`. Every other file is byte-identical to its source. Exactly 12 files differ from the 1.2.1 `dist/`: `artifact.html`, `css/game.css`, `index.html`, `sw.js`, and `js/` data, engine, level, main, pickups, render, ui and weapons |
| `gate-rush-dist.zip` | 33 entries, 1 000 557 bytes, md5 `0c571339…`; forward-slash names (0 backslashes); `unzip -t` OK; extracted, it equals `dist/` file for file. Written by `EV/tools/mkzip.cjs` (the r5 release writer, not PowerShell `Compress-Archive`). The 1.2.1 zip is kept as `EV/gate-rush-dist-1.2.1.zip` |

**Update path** (r5b's `upcheck2.mjs`, `EV/up-next/`, `EV/up-pill/`). Build A is the shipped 1.2.1 `dist/` (v6), copied to `EV/dist-1.2.1/`. Build B is this `dist/` (v7), copied to `EV/dist-final/`. Both are served on one origin.

| Scenario | Launch | Build served | Boot | Worker / caches / pill |
|---|---|---|---|---|
| next | launch 1 after the release | **A**, 26 / 26 files from the v6 cache | 0.88 s | v7 installed and waiting (`v7/1.2.1`); **pill shown at 2.9 s** |
| | next launch, then offline | **B**, 26 / 26 from v7 | 0.92 s / 0.92 s | only the v7 caches; no pill |
| pill | launch 1 | A | 0.88 s | pill shown at 3.0 s |
| | real tap on the pill (it hits `btn-update`) | **B** after one reload | 0.81 s | controller `v7/1.2.1`; only the v7 caches |

Page, worker and console errors: 0 in both scenarios.

## 6. Changes in this pass

| File | Change |
|---|---|
| `js/engine.js` | **The fix (§2.2).** The back guard is re-armed with `history.forward()` after a Back, not pushed again. Adds `_rearmGuard`, `_guardForwardTimeout`, `BACK_GUARD_FORWARD_MS`; `_popState` holds the nested syncs while the Back action runs; `dispose` clears the timer. The fallback is the old push |
| `js/render.js` | Comment only: the `ICON_FIT` shape-constant comment had been moved onto `DUST_STOPS` by the round's edit; it is back on `ICON_FIT` |
| `sw.js` | `VERSION 'v7'`, plus a header line (the release request) |
| `tools/smoke.js` | The pickup and stored-weapon listeners are hooked once. `installProbes` runs once per scenario, so `--scenario all` listed every pickup and every `weapon:stored` twice (m1 `all-*`: "2 stored" for one weapon) |
| `docs/ARCHITECTURE.md` | §6.2 Back guard: the "Re-arm" paragraph (why a forward and not a push, measured). The `ctx.version` row (§3) and §15.4 name v7 |
| `docs/GDD.md` | §14 Lifecycle: repeated Backs in a run keep pausing |
| `docs/build/CALLSITES.md` | regenerated (640 lines) |
| `artifact.html` | rebuilt (unchanged bytes) |
| `dist/`, `gate-rush-dist.zip` | rebuilt (§5) |
| `docs/build/r6-verify.md` | this report |

Nothing was committed.

## 7. Open items

1. **`ctx.version`.** The title still reads "v1.2.1", although 12 shipped files changed.
   - The update reaches installed phones without a bump: same `ctx.version` with another sw `VERSION` counts as another build (§5).
   - But the owner cannot tell from the title whether his phone runs the new build.
   - The README release routine bumps `js/main.js` and `package.json` too, so 1.2.2 or 1.3.0 is a lead / release call.
   - If it changes: v7 has not shipped, so delete `dist/` and run `node tools/package.js --check` again (the packager refuses a changed build under the same `VERSION` while the old `dist/` is there).
2. **Owner phone checks (after release).**
   - **Back** (r6-backguard's list, now expected to pass all of them):
     - (a) an edge swipe during a run → pause screen;
     - (b) Back again, with no touch → still paused;
     - (c) RESUME, Back → pause;
     - (d) QUIT, Back on the title → the app closes;
     - (e) levels / shop / settings → Back returns to the title.
   - **Textures:** pause, lock the phone for a long while, come back. The digits, MAX letters, count plate, lane paint and windows should be there.
   - **Weapons:** the FIRE button bottom-right; the hint; the "×2" badge; a tap that is refused while a weapon runs.
3. **A Back trap in a desktop browser tab.** With the re-arm, repeated Backs in a browser tab also stay in the game until QUIT. That is the designed behaviour (GDD §14 Lifecycle). Desktop Back is not a player path, but it is noted.
4. **Phone cost of a real restore.** About 3 × the desktop 48–68 ms re-draw, so ≈ 150–200 ms. It lands behind "Reloading graphics…" or in the one resume frame after a real loss (r6-textures §5).
5. **Not measured here:**
   - the real Android back gesture (Part 4 is the closest desktop stand-in: the same `NavigationController` code);
   - iOS;
   - the 4× throttled play lens;
   - the audio and balance suites.
