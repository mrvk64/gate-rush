# r6 — Android Back guard (owner report item 2)

Owner (installed PWA, Android Chrome, gesture navigation): "I put my finger down to swipe [the soldiers] … that closed
the game". A touch that starts at the left / right screen edge is Android's back gesture; in a standalone PWA with no
history entry of its own, Back closes the app. A web page cannot block or reserve the gesture (no gesture-exclusion API
for the web), so the fix makes Back harmless: it pauses the run instead of closing the app.

Files: `js/engine.js` (back guard), `js/main.js` (boot step 13), `docs/ARCHITECTURE.md` §4.1 step 13 + §6.2 (API line
and the "Back guard" paragraph), `docs/GDD.md` §"Lifecycle" line. No data.js keys. No ui.js edits.

## Behaviour

| Screen when Back arrives | Result | Guard entry afterwards |
|---|---|---|
| playing | `engine.pause()` → pause screen | pushed again (the next Back also pauses) |
| paused | stays paused | pushed again |
| settings overlay (over title, pause or results) | that overlay's BACK (`[data-back]` click) | pushed again unless it closed onto the title |
| levels / shop | their BACK → title | none (title) |
| complete / gameover / endless results | their HOME icon → title (`level.quitToTitle()` if the icon is missing) | none (title) |
| title | nothing: the browser's Back leaves the app (one Back) | none |
| boot screen | guard not armed yet: Back leaves | none |

## Mechanism (`Engine.armBackGuard()`, called by main as boot step 13)

- **One entry at most.** `history.pushState({ gateRush: 'back-guard' }, '')` is called only when the guard is not the
  current entry (`_guardOn`). A reload on the guard entry finds `history.state` already marked and pushes nothing. In the
  tests `history.length` never goes above base + 1.
- **Not on the title.** The guard is wanted whenever state ≠ `title`/`boot` or the settings overlay is open (tracked from
  `ui:screen`). It is pushed on the first screen change away from the title and dropped with `history.back()` when the
  player arrives back at the title (QUIT, HOME, BACK). Engine ignores the `popstate` from that drop, and a 1 s resync
  re-reads `history.state` if the event never comes. Result: one Back on the title still leaves the app, as the brief asks.
- **Pushed inside a tap's activation window.** The push happens on a screen change, and those follow a tap (PLAY, a level
  tile, SHOP…). That matters because of Chrome's history-manipulation intervention: Back skips over entries a page added
  with no user activation.
- **Back runs the screen's own flow.** Engine `click()`s that screen's own button, so ui runs exactly what a tap does
  (`ui:button` → tap cue, `_back`, `quitToTitle`). Engine copies no ui logic.
- **Guarded.** The guard is not armed when `ctx.config.isArtifact` is set (artifact and sandbox shells), when
  `window.top !== window.self`, or when `history.pushState` / `history.back` are missing or throw. Reason for framed
  pages: pushState writes the host tab's joint history, and a `history.back()` could navigate the host page, e.g.
  claude.ai. If pushState throws (blocked or rate-limited), the game logs one `warnOnce` and Back keeps the browser
  default. No allocation per frame: the work runs only on `popstate` and `ui:screen`.
- **Edge strip (`iosEdgePx`) not extended to Android.** When Android decides an edge touch is a back swipe, it takes the
  pointer itself, and the page gets `pointercancel`. That already releases the steer, and Back now pauses. Ignoring
  Android edge touches would not stop the gesture. It would only make the steering area smaller. So `SQUAD.steer.iosEdgePx`
  stays iOS-only and the steering area is unchanged.

## Verification (headless Chrome 390×844 touch; evidence in `E:/Temp/claude/gate-rush-evidence/r6/engine-main/`)

The project tree was mid-edit by other groups during this round: render.js `this._record`, then ui.js `MAX_PILLS`
temporal-dead-zone boot failures, not caused by this change. So the main runs used a snapshot: `git archive HEAD` plus
only my `js/engine.js` and `js/main.js` (`snapshot/`).

- `backguard-test.mjs` → `backguard-report.json` (live tree, before the other groups' edits landed) and
  `backguard-report-snapshot.json`: **25 / 25 PASS, 0 page errors, 0 console errors**, in both. It covers:
  - title after boot: no entry;
  - PLAY tap → guard pushed once;
  - `page.goBack()` while playing → paused, guard back; repeated Back while paused → stays paused;
  - `history.back()` after RESUME → paused;
  - settings over pause → Back → pause screen;
  - QUIT → guard dropped;
  - levels and shop: Back → title, no re-push; their BACK buttons → guard dropped;
  - settings over title → Back → title;
  - gameover, complete and endless results → Back → title (HOME);
  - reload on the guard entry → no extra entry;
  - Back on the title leaves the page (`about:blank`);
  - `history.length` stays at base + 1 throughout.
- `backguard-edge.mjs` → `backguard-edge-report.json`:
  - pushState throwing → boots and plays, one warning, no error;
  - index.html in a same-origin iframe → guard not armed, plays.
- `node tools/smoke.js --scenario all` from the snapshot, index / `--shell artifact` / `--shell sandbox`: **all CLEAN**.
  The level is won and the HOME tap reaches the title. `--pre` shows `guardOk=false hstate=null` in both artifact
  shells (`snap-*-all/report.json`).
- On the live tree, before the other groups' breakage: `--shell artifact|sandbox --scenario ui` and `--scenario play`
  are CLEAN (`smoke-*-ui`, `smoke-*-play`, `smoke-probe-*`).
- `node tools/check-imports.js`: OK.

## Residual risk / owner phone check

`page.goBack()` / `history.back()` cannot reproduce Chrome Android's back-skip rules. On one point their exact form is
uncertain: does an entry need a fresh user activation for each push, or only one activation since load? If it is per
push, a guard re-pushed after Back while **paused**, with no tap in between, might be skipped by a second immediate Back.
In that case the app could still close after two Backs in a row on the pause screen with no touch between them. Every
other path pushes right after a tap, or during play, where steering touches give constant activations. Please check on
the phone after release:
- (a) edge-swipe during a run → pause screen;
- (b) Back again → still paused;
- (c) RESUME, Back → pause;
- (d) QUIT, Back on the title → app closes;
- (e) levels / shop / settings → Back returns to the title.

## needsOtherGroup

- **ui**: nothing required. Engine drives ui only through its existing buttons (`#scr-settings|levels|shop [data-back]`,
  `#btn-complete-home`, `#btn-home`, `#btn-endless-home`). Those ids and the `[data-back]` attribute must keep existing.
  Optional: a public `ui.back()` (same as a `[data-back]` tap, returning false on a screen with no back) would let engine
  call it instead of `click()`ing DOM.
- **release**: this is a shipped behaviour change. Bump the `sw.js` VERSION and rebuild with `node tools/package.js`, or
  an installed PWA keeps serving the cached 1.2.1 engine.js.
