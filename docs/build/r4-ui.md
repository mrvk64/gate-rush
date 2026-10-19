# Round 4: ui (HOME on the results screens, FTUE ui residuals)

**Owner files:** `js/ui.js`, `css/game.css`, `index.html` (and `artifact.html`, regenerated with `node tools/build-artifact.js`).

**Also touched:**
- `js/data.js`: one key, `STRINGS.aria.home` (a targeted anchor-checked edit, file re-read right before it; data.js had changed under me since my snapshot, the other owner's edits are intact).
- `docs/GDD.md` §14 (Boot, HUD, Level complete, Game over, Endless results rows).
- `docs/ARCHITECTURE.md` §10.1 markup (`#powerups` comment, `#scr-boot`, `#scr-complete`, `#scr-gameover`, `#scr-endless`, a round-4 note) and §10.3 button routing.

**Evidence root:** `E:/Temp/claude/gate-rush-evidence/r4/ui/`, written `EV/` below. Nothing was written under the project root except the sources and docs listed here.

| Path | Contents |
|---|---|
| `EV/src-before/` | `js/ui.js`, `css/game.css`, `index.html`, `artifact.html` as handed over (`md5.txt`); every "before" run serves them as an overlay |
| `EV/tools/results.mjs` | results-screen check at one viewport: complete / game over / endless screenshots, rects of every control, overlap and off-screen tests for HOME, a **real tap** on HOME (touch on phones, mouse on desktop) that must land on the title and emit `ui:button` with the button id, Tab order, a zoomed power-up pill shot |
| `EV/tools/bootlogo.mjs` | boot-logo font probe: fresh profile, `--mode normal / slowfont` (font files delayed 3 s) `/ blockfont` (aborted) |
| `EV/tools/icons.mjs` | every pill pictogram on the dark pill vs a light disc (`EV/icons/pictograms.png`) |
| `EV/tools/smoke-mirror.mjs` | the project's `tools/smoke.js` with only an overlay root added (`GR_OVERLAY`), for interleaved old / new A/B |
| `EV/tools/edit-*.cjs` | the anchor-checked edits applied to index / ui / css / docs |
| `EV/before-390x844/` | before: results screens + pill |
| `EV/after-390x844/`, `EV/after-360x740/`, `EV/after-844x390/`, `EV/after-desktop/` | after, each with `info.json` |
| `EV/bootlogo-before/`, `EV/bootlogo-after/` | boot-logo shots and timings |
| `EV/smoke-ui/`, `EV/smoke-all/`, `EV/smoke-all-desktop/`, `EV/smoke-all-artifact/` | project smoke harness on the final code |
| `EV/ab/old-N`, `EV/ab/new-N` | interleaved L1 A/B (frame pacing) |

## 1. HOME on every results screen (lead decision 1)

**Before.** Level complete had no way home except NEXT → pause → QUIT, which starts a level first (r3-ftue residual 1). Game over had a text HOME next to SHOP; endless had a wide text HOME under RETRY. `EV/before-390x844/01-complete.png`, `03-endless.png`.

**After.** One 48 × 48 icon button with a house glyph, top-left inside the safe area (`top: var(--safe-top); left: var(--safe-left)`, where the pause button sits in play; the HUD coin pill stays top-right), `aria-label="Home"`, on all three results screens.
- **Wiring.** `btn-complete-home` (new), `btn-home`, `btn-endless-home` → `level.quitToTitle()`; every tap emits `ui:button { id }` through the existing `_click` path like the other buttons (audio's `ui_tap` plays from it).
- **Decision: the text HOMEs of game over and endless are replaced, not duplicated.** Two HOME controls on one screen would be redundant and give screen readers two "Home" buttons; the ids are kept, so nothing that listens for `btn-home` / `btn-endless-home` changes. NEXT / REPLAY / SHOP / RETRY are untouched: the icon is absolutely positioned outside the flex column, so the stacks lay out exactly as before (complete: identical rects to the before run). On game over SHOP now sits alone, centred, in its row; on endless RETRY stands alone. If the lead wants the text HOME back on those two screens, re-adding the old `<button>` to the row is a one-line markup change; I did not, to avoid the duplicate.
- **Glyph.** Inline SVG in `currentColor` (crisp at any DPR, no font dependency, visible in forced-colours mode); ui writes only the accessible name (`STRINGS.aria.home`) and never `textContent` on these buttons, which would wipe the glyph.
- **Focus.** `_focusFirst` still focuses NEXT / RETRY first (HOME is not `.btn.primary`); HOME is reachable by Tab (DOM-first, so it follows SHOP when the order wraps): `info.json` `focusOrder` = NEXT, REPLAY, SHOP, (app), HOME.

**Verification** (`EV/tools/results.mjs`, final code; every row: HOME rect 8,12,48,48, no overlap with any other visible element of the screen or the HUD coin pill, nothing outside the viewport, `elementFromPoint` at its centre = the HOME button, the tap lands on the title and emits `ui:button` with the button id, 0 page / console errors or warnings):

| Viewport | complete | game over | endless | Shots |
|---|---|---|---|---|
| 390 × 844 @3 (touch) | pass | pass | pass | `EV/after-390x844/01-complete.png`, `02-gameover.png`, `03-endless.png`, `01b-after-home.png` (title after the tap) |
| 360 × 740 @3 (touch) | pass | pass | pass | `EV/after-360x740/` |
| 844 × 390 @2 (touch) | pass | pass | pass | `EV/after-844x390/` (title, stars and coin pill clear of HOME) |
| 1280 × 800 desktop (mouse) | pass | pass | pass | `EV/after-desktop/` |

A HOME during the results theatre (stars / count-up still running) is safe: `quitToTitle()` already runs `_commitPending()` and the coins were committed before the screen appeared.

## 2. FTUE residuals that are mine

r3-ftue §7 listed six residuals; r3-verify closed 2 (coin-multiplier badge) and 6 (data keys). 1 is §1 above. 4 (boss damage-number cap) is fx's. That leaves 3 and 5, both in my files.

### 2.1 Residual 3: the weapon pill icon read as "an orange ring around a dark shape"

**Root cause (ui / css side).** The pill drew the pictogram in a 28 × 18 box (a square bitmap → 18 px) straight on the dark pill panel. The texture-factory pictograms are outlined in the glyph outline colour #0B0F1A, and several have large dark parts (the shotgun stock, the minigun drum, the rocket fins), which vanish on rgba(15,22,38) at 18 px. `EV/icons/pictograms.png` shows all nine pill pictograms on the dark panel (rows 1, 3) and on a light disc (rows 2, 4).

**Fix (`css/game.css`).** The ring grows 28 → 32 px; its hole holds a light disc (`#powerups > .pu::before`, a static radial gradient, non-interactive, part of the pill so ui.prewarm's pill-0 pop-in already rasters it at boot) under a 20 px pictogram, centred on the ring. The ring keeps the item colour and the countdown. No JS change; no per-frame cost.

| Before | After |
|---|---|
| `EV/before-390x844/00-pills-zoom.png`: shotgun = dark blob with two orange bars at 18 px | `EV/after-390x844/00-pills-zoom.png`: shotgun and chip read on the disc; `EV/smoke-all/11-play-25s.png` in play |

Sizes at --ui 0.85 (844 × 390): ring 27 px, icon 17 px; 390 × 844: 32 / 20 px.

### 2.2 Residual 5: the boot logo swapped from the fallback face to Lilita One on a first visit

**Fix (`index.html` BOOTGUARD `logoFont`, `css/game.css` `#scr-boot .logo.font-wait`).** The boot logo starts with `.font-wait` (opacity 0) and fades in (0.2 s) when `document.fonts.load('400 1em "Lilita One"')` settles or after 1.2 s, whichever comes first. The bar and the boot text stay visible throughout, so the screen is never blank. Without a FontFaceSet, or with the font CSS / files unreachable (the load settles at once), the logo shows immediately in the fallback, as before. This is the bounded version of the `font-display: block` trade-off r3-verify left open: up to 1.2 s without the logo instead of up to 3 s, and on a network slower than that the swap still happens (unavoidable without blocking longer).

| Probe (`EV/tools/bootlogo.mjs`, fresh profile, cache off) | Result |
|---|---|
| before, font files delayed 3 s | logo painted in Arial Black from the first frame (`EV/bootlogo-before/slowfont-800ms.png`), swapped later |
| after, font files delayed 3 s | logo hidden, bar and text visible (`EV/bootlogo-after/slowfont-800ms.png`); shown at the 1.2 s cap (`slowfont-1500ms.png` / `-3500ms.png`) |
| after, normal network | the font arrived before DOMContentLoaded; `.font-wait` already gone, logo in Lilita One from its first paint (`normal-250ms.png`) |
| after, font files aborted | `load` rejected at once → logo shown immediately in the fallback (`blockfont-250ms.png`) |

## 3. Verification

**Static.** `node --check js/ui.js js/data.js` OK; `node tools/check-imports.js` 0 errors / 0 warnings; `node tools/build-artifact.js` ("sw.js PRECACHE covers all 22 files in js/", 34 module preloads, APP + BOOTGUARD); a second build to `EV/artifact-check.html` is byte-identical to the shipped `artifact.html` (md5 c832e4d0…); no `console.log` / `Math.random` added. ARCH §14: no new per-frame code (the HOME wiring runs on a click, the aria labels once at init, the pill disc is CSS); guarded: the `aria()` helper now writes only strings.

**Project smoke harness** (final code, `--bootTimeout 120`):

| Run | Verdict | Errors / warnings / failed req | Result | Screens checked |
|---|---|---|---|---|
| `--scenario ui` (`EV/smoke-ui/`) | CLEAN | 0 / 0 / 0 | title → shop → buy → levels → settings → play → pause → resume → quit → title | `00-title`, `02-shop-bought`, `06-paused`, `07-back-to-title` |
| `--scenario all` (`EV/smoke-all/`) | CLEAN | 0 / 0 / 0 | L1 ★★★, 256 survivors | `11-play-25s` (new pill), `17-result` (HOME top-left, badged SHOP, coin pill) |
| `--scenario all --desktop` (`EV/smoke-all-desktop/`) | CLEAN | 0 / 0 / 0 | L1 ★★★, 256 | `15-result` |
| `--scenario all --shell artifact` (`EV/smoke-all-artifact/`) | CLEAN | 0 / 0 / 0 | L1 ★★★, 256 | `17-result` |

**Frame pacing.** The three `all` runs show p99 7.1 ms but long frames of 90–264 ms (r3: worst 20.9 ms). They ran while my `results.mjs` runs and other groups' browsers were active (≈ 32 chrome processes on the host). To separate my change from the host I ran interleaved L1 A/B with the before overlay (`EV/ab/`, smoke mirror, same seed, first shotgun pickup at 19.8 s in every run):

| Run | Worst (ms) | Long frames > 50 ms (s: ms) |
|---|---|---|
| old-1 / old-2 / old-3 | 20.8 / 27.9 / 166.6 | – / – / 30.87: 167, 31.12: 139 |
| new-1 / new-2 / new-3 | 76.3 / 194.4 / 159.7 | 5.74: 63, 6.11: 76 / 9.35: 83, 21.85: 104, 22.14: 194, 22.23: 90, 31.23: 83 / 7.63: 146, 7.92: 160, 30.63: 63 |
| new-4 / new-5 / new-6 | 256.9 / 152.8 / 159.7 | 9.94–12.34: six of 70–257 / 3.25: 153, 3.52: 132, 20.52: 104, 20.71: 56, 20.77: 56 / 4.74–5.10: three of 69–160 |
| old-4 / old-5 / old-6 | 20.9 / 152.7 / 20.9 | – / 4.28–4.64: three of 111–153 / – |

All 12 runs CLEAN, p99 7.1–7.2 ms. The new runs had more long frames (6 of 6 runs vs 2 of 6), so I traced where they come from (`EV/tools/trace.mjs`, new code, L1, a devtools timeline trace with a user-timing mark at every rAF interval > 50 ms; `EV/tools/analyze.cjs`; `EV/trace-new-5/`, `EV/trace-new-6/`):

| Long frame | What the renderer main thread did in it |
|---|---|
| 125 ms | one RunTask, **wall 122.4 ms, thread CPU 3.1 ms**; its rAF FunctionCall wall 81.7 ms, CPU 2.1 ms |
| 70 ms | RunTask wall 67.5 ms, CPU 2.9 ms |
| 56 / 63 / 76 ms | RunTasks of wall 28–74 ms, CPU 2.6–3.1 ms |

No GC, style, layout or paint event over 4 ms in any of them. The game's frame does its normal ≈ 2–3 ms of CPU work, and the thread is descheduled for the rest: the host was CPU-starved (22–32 chrome processes of other groups' runs while I measured; the level group's concurrent smoke runs on the same host logged 250–354 ms frames, `r4/level/smoke-l3/`, `smoke-all2/`). The frames also land at moments where nothing I changed is on screen or first used (3–12 s and 30–31 s of L1: no pill, no results screen, HOME and the boot logo not in play). No CSS of mine runs per frame. I read the old / new asymmetry as host scheduling, not a regression; the release verifier should still re-measure frames on a quiet host.

## 4. Changes (file:line, final code)

| File | Lines | Change |
|---|---|---|
| `index.html` | 61 | boot logo starts `.font-wait` |
| `index.html` | 86–88 | `btn-complete-home` / `btn-home` / `btn-endless-home` icon buttons (inline SVG house) at the top of `#scr-complete` / `#scr-gameover` / `#scr-endless`; text HOME buttons removed from the game-over row and the endless stack |
| `index.html` | 113–130 | BOOTGUARD `logoFont()`: bounded font wait, cap 1.2 s |
| `js/ui.js` | 702 | element cache `btnCompleteHome` |
| `js/ui.js` | 847–856 | no `textContent` on the HOME buttons; aria labels from `STRINGS.aria.home`; `aria()` writes strings only |
| `js/ui.js` | 2919–2921 | `btn-complete-home` routes to `level.quitToTitle()` |
| `js/data.js` | 1544 | `STRINGS.aria.home: 'Home'` |
| `css/game.css` | 473–476 | `#btn-endless-home` left the wide-secondary rule |
| `css/game.css` | 534–547 | `.icon-btn.home-btn` (absolute top-left in the safe area), `.home-glyph` |
| `css/game.css` | 805–841 | pill ring 32 px, `#powerups > .pu::before` light disc, 20 px icon |
| `css/game.css` | 1162–1165 | boot logo opacity transition, `.font-wait` |
| `artifact.html` | — | regenerated |
| `docs/GDD.md` | 519, 521, 526–528 | boot logo, pill, HOME rows |
| `docs/ARCHITECTURE.md` | 1112, 1120, 1145–1148, 1204 | markup and button routing |

`STRINGS.gameover.home` / `STRINGS.endless.home` stay in data.js; ui uses `gameover.home` only as the aria fallback.

## needsOtherGroup

1. **render (icon pictograms).** `js/render.js` changed during this round (10:51) and the pill pictograms now differ from the r3 set I sampled in `EV/icons/pictograms.png` (the shotgun is a gun silhouette now). They read well on the new light disc (`EV/after-390x844/00-pills-zoom.png`), but the owner should know the pill shows `iconDataURL` art on a light disc (#FFFFFF → #B9C2D2) from now on; pure-white parts of a pictogram would need their outline.
2. **Smoke harness owner (`tools/smoke.js`).** The `ui` scenario never visits a results screen; consider a step that taps `btn-complete-home` after the L1 result in `--scenario all` (`EV/tools/results.mjs` is a ready reference).
3. **Release verifier.** Re-measure frame pacing on a quiet host (§3): this pass's long frames are wall-clock stalls with ≈ 3 ms of thread CPU (host contention), and appear in the before build too.
4. **Lead.** Confirm the consolidation in §1 (text HOME on game over / endless replaced by the icon). GDD §14 now says so.
