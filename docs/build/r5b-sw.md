# Round 5b: the update pill shows only for another build (ui-sw)

Owner: ui-sw (`sw.js`, `index.html`, `js/ui.js`). Input: `r5-release.md` §7 item 2, "Still open": on the one transition launch from 1.1.0 (sw v3) to 1.2.0 (v4), the title showed "Update ready — tap to reload" even though the page already ran 1.2.0. Tapping it reloaded into the same version.

Evidence root: `E:/Temp/claude/gate-rush-evidence/r5b/ui-sw/`, written `EV/` below.

**Result.**
- The pill now shows only when the waiting worker's build differs from the build the running page uses.
- On the 1.1.0 → 1.2.0 transition launch it no longer shows, on normal or slow networks.
- On a real later update (1.2.0 → 1.2.0-next, and a hotfix that keeps `ctx.version`), it still shows. A tap still reloads into the new build.
- Every other r5 update-path result is unchanged: one consistent build per launch from v4 on, the "Finishing the update…" heal, offline launches, and the heal's negative cases.
- `VERSION` stays `'v4'`. `index.html` is unchanged, and `build-artifact` reproduces the same `artifact.html` (md5 `bb48e979…`).

## 1. Cause

- `ui._swReady` treated any installed worker that waited behind an active worker as "an update is ready".
- During the transition, the active worker is the 1.1.0 worker (v3), which serves code network-first. On a normal network, that launch therefore loads all 18 changed files from the network as 1.2.0 (r5-release §5.2).
- The v4 worker installs the same 1.2.0 build and waits, so the pill offered a reload into the build the page was already running.
- The page had no way to know which build a worker holds.

## 2. Change

### 2.1 `sw.js`: the worker reports its build (`VERSION` stays `'v4'`)

- **New message.** `{ type: 'GET_BUILD' }` with a `MessagePort`. The worker answers on that port with `{ type: 'BUILD', version: VERSION, app }`.
- **Where `app` comes from.** `app` is the `ctx.version` of the build in this worker's own cache.
  - The worker reads it from its cached `js/main.js` with the same `const VERSION = '…'` pattern that `tools/package.js` uses on `sw.js`.
  - So a release still sets one version string, and the worker cannot drift from it.
  - The value is memoised (a worker's cache never changes after install). It is `null` when the cache cannot be read.
- **`SKIP_WAITING`** is handled exactly as before. Its comment now says that future workers must answer `GET_BUILD` too.
- **Why `VERSION` stays `'v4'`.** No v4 build has reached players. Bumping it would change nothing for a v3 player.
- **The v3 worker never answers.** Its message handler ignores every other type.

### 2.2 `js/ui.js`: decide on the pill from the two builds

- **The page's own build, asked once at `_swInit`.** If the page has a controller, ui asks it `GET_BUILD`.
  - A v4+ controller serves the whole page cache-first from its own cache. Its `version` is therefore the page's build, provided its `app` equals `ctx.version`; this guards against an eviction fallback.
  - No answer within `SW_ASK_MS` (3 s) means the v3 worker, or no controller at all. In that case the page's build is known by `ctx.version` alone.
- **A candidate is asked too.** That is a waiting worker (`_swReady`), or a new controller after another tab's update (`controllerchange` that this page did not ask for). The decision (`_swDecide`) runs once both answers are in.
- **`_swOtherBuild(info)` returns true, so the pill shows, when:**

  | Candidate's answer | Page's build | Pill |
  |---|---|---|
  | none (cannot tell) | any | **shows** (the r5 behaviour) |
  | `app` ≠ `ctx.version` | any | **shows** (another release) |
  | `app` = `ctx.version` | known (`v4+`) | shows iff `version` ≠ the page's `version` (a hotfix under the same `ctx.version`) |
  | `app` = `ctx.version` | unknown (v3, or no controller) | **hidden** (the transition launch) |
  | `app` unknown | unknown | **shows** |

- **Plumbing.**
  - Two ask slots, one for the page and one for the candidate. Each has a generation counter, so a newer question drops an older answer.
  - The `MessageChannel` and its timer are cleaned up in `_swAskEnd`, and `dispose()` ends both slots.
  - Everything is guarded: `typeof MessageChannel`, try/catch around `postMessage`, and a missing worker resolves to "no answer".
  - All of it is event-time; nothing runs per frame. The per-frame `update()` still only syncs the pill when `_swDirty`.
- **Unchanged:** `_applyUpdate` (`SKIP_WAITING` → reload on `controllerchange`, with the 4 s fallback), `_swMaybeCheck` / `_swCheckNow`, the pill markup, the CSS and the strings.

### 2.3 `index.html`

- Not changed. The heal still posts `SKIP_WAITING` on a load failure whenever a newer worker is pending, which is right for a page that failed to link.
- `node tools/build-artifact.js` was run anyway: "sw.js PRECACHE covers all 22 files in js/"; 189 lines, 15 681 bytes; `artifact.html` byte-identical.

## 3. Static checks

| Check | Result |
|---|---|
| `node --check js/ui.js sw.js` | pass |
| `node tools/check-imports.js` | 0 errors, 0 warnings |
| `node tools/build-artifact.js` | pass; `artifact.html` unchanged (md5 `bb48e979…`) |
| `package.js --check` in a sandbox copy (`EV/trees/b`) | "precache OK (31 files …; cache version v4; build 4851f9629261)", 33 files. Against the shipped `dist/`, only `js/ui.js` and `sw.js` differ |
| `console.log` / `Math.random` in my files | none |
| `smoke.js` (boot, ui, `all` on index / artifact / sandbox; `EV/smoke-*`) | all **CLEAN**: 0 page errors, 0 failed requests; L1 clear, 256 survivors on every shell |

## 4. Update-path test

### 4.1 Builds and tool

**Tool.** `EV/tools/upcheck2.mjs` is the release engineer's `r5/release/tools/upcheck.mjs` with four additions:
- **Pill tracking.** Every page logs from document start whether `#btn-update` was **ever** visible, and when (`pillEver`).
- **Pill settle.** Launch 1 waits up to 8 s after a worker is waiting before it records the pill.
- **Build answers.** Every state probe also asks the controller and the waiting worker `GET_BUILD` (shown as `version/app`).
- **Scenarios.** `pill` taps only a visible pill. A new `tabs` scenario: a second tab takes the update with `SKIP_WAITING` and reloads, and the first tab's pill is recorded.

The battery is `EV/tools/battery.sh`, the summary is `EV/tools/sum.cjs`, and the run log is `EV/battery.log`. Everything ran sequentially, 04:10–04:25.

**Builds.** Every sandbox build was made by `package.js` in `EV/trees/*`:

| Name | What |
|---|---|
| A | the shipped 1.1.0 (`r5/release/dist-handover`, sw v3) |
| B0 | the project's current `dist/` (r5 code, v4 `58d6a2c2…`), the "before" |
| **B** | this change: 1.2.0, v4, build `4851f962…` |
| **B-next** | B with `main.js` `VERSION '1.2.0-next'` and `sw.js` `VERSION 'v5'` (the marker release) |
| **B-hotfix** | B with a marker comment in `gates.js` and `VERSION 'v5'`; `ctx.version` stays `'1.2.0'` |

### 4.2 Transition 1.1.0 → 1.2.0 (A → B): the pill must not show

| Run | Launch 1 after the deploy | Pill on launch 1 (ever) | Next launches |
|---|---|---|---|
| **before** (A → B0, `next`) | B, boot 1.3 s; v4 waiting; the waiting worker does not answer `GET_BUILD` (r5 code) | **shown at 3.2 s**: the bug reproduced | B, only v4 caches, no pill; offline B with 3 fonts |
| fresh (B only) | first visit B 2.9 s; relaunch 26/26 from the worker; controller says `v4/1.2.0` | never | offline B |
| next | B, boot 1.4 s; controller v3 (no answer); waiting says `v4/1.2.0` | **never** (8 s settle, plus the whole launch) | B from v4, no pill; offline B with fonts |
| pill | as next | **never**: nothing to tap | B, then offline B |
| tabs | tab 1 and tab 2 both B with no pill; tab 2 posts `SKIP_WAITING` and reloads → tab 1 gets `controllerchange` (controller now `v4/1.2.0`) | **never, in either tab** | B |
| slow250 (250 KB/s, 150 ms) | **MIXED**: the same split as r5 (main, data, render, ui, environment … 1.2.0; audio, models, boss, gates, fx, level, levelgen 1.1.0); boots to the title; v4 waiting after 16.3 s | never (see §5) | reload B; next B from v4; offline B |
| slowdata (`data.js` 4 s late) | document 1 MIXED → `SyntaxError` → **heal** → document 2 B; title at 7.3 s, no error box | never | reload / next / offline B |
| slow250data | document 1 MIXED → heal; the boot text read "Finishing the update…" at 3, 6 and 12 s; document 2 B at 25.5 s (r5: 25.2 s) | never | reload / next / offline B |

### 4.3 A real update, 1.2.0 → 1.2.0-next (B → B-next): the pill must show

| Run | Launch 1 after the deploy | Pill | After |
|---|---|---|---|
| next | B (still the old build, cache-first from v4); controller `v4/1.2.0`, waiting `v5/1.2.0-next` | **shown at 3.3 s** | next launch B-next ("v1.2.0-next"), only v5 caches; offline B-next with fonts |
| **pill** | as next | **shown at 3.5 s**; a real touch tap hits `btn-update` | one reload → **B-next** (controller `v5/1.2.0-next`), pill gone; next and offline launches B-next |
| tabs | tab 1 and tab 2 show the pill; tab 2 takes the update | tab 1 keeps the pill after its `controllerchange` (controller now `v5`), as it should: it still runs 1.2.0 | next B-next |
| slow250 | B from v4 (no mix); v5 installs over the slow link and waits after 15.3 s | **shown at 18.9 s**; on the reload (still v4) at 1.1 s | next launch B-next; offline B-next |

### 4.4 Hotfix under the same `ctx.version` (B → B-hotfix, `pill`)

- On launch 1 the controller says `v4/1.2.0` and the waiting worker `v5/1.2.0`. **The pill shows at 3.1 s.**
- The tap reloads into the hotfix (`v5`); the next and offline launches stay on `v5`.

### 4.5 The heal's negative cases (`EV/healneg/`, the release engineer's `healneg.mjs` on B)

Identical to `r5/release/healneg-final`:
- **N1:** the plain error box at once (4 ms).
- **N2:** "Finishing the update…", then the box after 116 ms with the boot text restored.
- **N2, second time:** the plain box (the session flag).
- **N3:** the artifact shell; `__gateRushHeal` is undefined.

Across all 13 update runs:
- 0 worker errors and 0 console errors.
- The only page errors are the two link-time `SyntaxError`s in the `data.js`-late runs, which the heal handles, as in r5.

## 5. Behaviour change to note: a mixed transition launch no longer offers the pill

- **What changed.** On a slow first launch through v3, the page can run a mix. In r5 the pill appeared about 18 s later and gave that session a way into a consistent build. With this change the pill stays hidden when the mix's `main.js` is 1.2.0, because the page reports `ctx.version` 1.2.0 and nothing in a v3-served page tells which modules came from v3's cache.
- **Why I accept it.**
  - It happens only on that one launch.
  - A mix that links plays (seven mixes, r5-release §5.4).
  - A mix that cannot link heals.
  - The next launch is v4's consistent build.
- **The alternative.** Show the pill whenever the controller cannot report its build. That brings the reported false pill back on every fast transition launch, which is the common case. A per-module check would need a build stamp in every module, which is outside my files.

## 6. needsOtherGroup

1. **Release owner: `dist/` and `gate-rush-dist.zip` are stale.**
   - Both still hold the r5 build (`dist/sw.js` md5 `54550037…`, stamp `58d6a2c2…`), so they do not contain this fix.
   - **Fix:** delete `dist/` (v4 never shipped, so this is the documented way past the release rule's refusal), run `node tools/package.js --check`, and regenerate the zip.
   - **Expected:** stamp `4851f9629261…`, identical to `EV/trees/b/dist`.
   - I did not touch them; they are not my files.
2. **ARCHITECTURE owner.**
   - §15.4: the sentence "(the pill shows, although the page already runs 1.2.0)" is now wrong. Replace it with: the pill shows only when the waiting worker's `GET_BUILD` answer names another build (§2.2 table).
   - Add `GET_BUILD` → `{ type: 'BUILD', version, app }` to the `sw.js` message contract next to `SKIP_WAITING`. Note that `app` is parsed from the cached `js/main.js` `const VERSION = '…'`, so `main.js` must keep that declaration form.
   - Add the §5 behaviour note.
   - §10.3: same pill note.
3. **Integrator:** `docs/build/CALLSITES.md` lists `ui.js` line numbers, which are now shifted by about 90 lines. Rerun `node tools/callsites.js`. No cross-module member was added: every new member is a private `_sw*`.
4. **`r5-release.md` §7 item 2:** the "update pill" sub-item can be closed by this report once `dist/` is rebuilt.

## 7. Files changed

| File | Change |
|---|---|
| `sw.js` | header note; `APP_VERSION_RE`, `buildInfo()`; the message handler answers `GET_BUILD` on the given port. `VERSION 'v4'` unchanged |
| `js/ui.js` | `SW_BUILD_MSG`, `SW_ASK_MS`, slot constants; `_swPage*`, `_swCand*`, `_swAsk*` fields; `_swInit` asks the controller; `_swReady` / `_swControllerChanged` go through `_swConsider` → `_swDecide` → `_swOtherBuild`; `_swAsk` / `_swAskEnd`; `dispose()` ends the asks |
| `index.html` | none (`build-artifact` re-run; `artifact.html` unchanged) |
| `docs/build/r5b-sw.md` | this report |

The sources before my edits are in `EV/src-before/` (md5s in `src-before/md5.txt`); the final md5s are in `EV/md5-final.txt`.

ARCH §14 holds:
- no per-frame work or allocation (the asks are event-time);
- every API is guarded (`navigator.serviceWorker`, `MessageChannel`, `postMessage`, timers);
- no `console.log` and no `Math.random`.
