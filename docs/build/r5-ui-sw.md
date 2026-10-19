# Round 5: ui + service worker (district banner, district bands, music 70, consistent-build SW, HOME)

Owner files touched: `js/ui.js`, `css/game.css`, `index.html`, `sw.js`, `js/save.js`, and one `js/data.js` key (`STRINGS.update`, a targeted edit after a fresh re-read). `artifact.html` was regenerated with `node tools/build-artifact.js`. Docs: ARCHITECTURE §10.1, §10.3 and §15.4, and GDD §14. ARCH §12 already showed music 70 (the lead edited it), so I left it alone.

Evidence root: `E:/Temp/claude/gate-rush-evidence/r5/ui-sw/` (written `EV/` below). Tools are in `EV/tools/`.

## 1. District banner (DISTRICTS.md §5, §8.6)

**Behaviour**
- **When it shows.**
  - It shows on `district:change` with `banner: true` while the state is `playing`.
  - Level's flag decides the cases: the start of a run in a new district (not RETRY / REPLAY / RESTART), every endless rotation, and never the title.
  - The payload is copied and never retained. A partial payload (no label or no accent) is completed from `DISTRICTS` by id, or by the run's `level:start.district` id.
- **When it is cleared.**
  - `level:start`, which comes before the run's own `district:change`.
  - Leaving `playing` / `paused`.
  - A newer banner.
  - The boss bar: while `_bossOn` is true, a showing banner is hidden and any new request is dropped (spec: never under the boss bar).
- **Placement.**
  - Portrait and desktop: centred in the `#powerups` row, at `safe-top + icon-btn + 32u`.
  - While at least one power-up pill is visible, `#hud.pu-on` drops it one row (`+ pill-h + 8u`). `_syncPills` sets `pu-on` when the visible-pill count crosses 0.
  - Landscape phones (`max-height: 500px`): **top-left under the pause button**. This is the closest correct placement, see needsOtherGroup 1.
- **Look.**
  - A hint-style pill (the hint gradient at `--hint-alpha`, radius 999px, padding 6u 16u).
  - Text: Lilita One at `--fs-body`, letter-spacing 0.06em, white, `--stroke-2` plus a 3 px drop.
  - A 3 px accent rule (an `::after` 60 % wide) with a soft glow in the same hue.
  - A faint accent radial glow at the pill's foot. ui writes `--db-accent` / `--db-glow`, and only when a banner shows.
- **Timing.**
  - One Web Animation (opacity and transform only, so it runs on the compositor) built from `DISTRICT_RULES.banner`: 0.22 s fade with a 6 px rise, hold, 0.3 s fade, 1.6 s in total.
  - The animation is paused and played with the game, and the hide deadline runs on `_tclock` (theatre time: it holds while paused).
  - Reduced motion: opacity-only keyframes, no translate.
- **Boot prewarm.** The banner joins the HUD prewarm surface and runs its real animation there, so the first real banner pays no first-raster cost.
- **Per-frame cost.** One branch, and it runs only while a banner is pending or showing. No allocation.

**Evidence (`EV/tools/ui-check.mjs`)**

| Run | Verdict | Notes |
|---|---|---|
| 390×844 @2 (`EV/ui-check-390/`) | PASS 14/14 | L6 start: **level.js emitted `district:change {overcast, start, banner:true}` itself**. The banner is "DISTRICT 2 · OVERCAST HIGHWAY", 315 px wide, rect 92–127. The progress bar ends above it. Opacity 0.10 → 0.66 → 0.96 → 1 with translateY −5.4 → −2.1 → −0.2 → 0 in the first 0.23 s, then a hold, faded out by 1.6 s, then hidden. With a pill up it drops to 136–171 (pill 92–128). The boss bar hides it, and a request during the boss is dropped. Paused for 2.2 s: still shown, animation `paused`; still shown 0.4 s after resume, hidden 1.9 s after resume. Reduced motion: transform `none` while opacity rises 0.29 → 1. Hidden after quit, never shown on the title. Screenshots: `05/06-banner-l6-*`, `07-banner-pu-on`, `08-boss-on`, `09-paused-hold`, `10-reduced-motion`, `12-banner-l26` (Frozen). |
| 390×844, `--safe-top` 47 px (`EV/ui-check-390-safetop47/`) | PASS | Banner at 127–162. |
| 1280×800 desktop (`EV/ui-check-1280x800/`) | PASS | With a pill up the banner sits at 132–165, above the horizon where gates spawn (≈ 178). |
| 844×390 landscape (`EV/ui-check-844x390/`) | PASS except `puOnDrops` (by design) | Top-left at 72–101 (x 8–210), clear of the road band. The centred placement (and the existing centred pill row) sat on the far gates, see `07-banner-pu-on.png` of the first landscape run, which was overwritten. The landscape layout does not move it for `pu-on`. |
| Endless (`EV/endless-banner/`, 200 s, seed 4242, squad held ≥ 400) | ok | `district:change rotate` at 900 m (overcast) and at 1800 m (night). The banner shows within 25 ms each time and hides ≈ 1.8 s later. `banner-1/2.png` show the Overcast rain and the Night banner. |

## 2. District bands on the level grid; district line on the title

- **Level tiles** (`js/ui.js` `_buildLevelGrid` / `_setTile`).
  - Each tile gets a `.tile-band` child (aria-hidden): a short `--d-accent` rule at the top (28 %, or 48 % on `.band-start`, the district's first level) and a `--d-tint` wash at the foot (accent at alpha 0.16).
  - The district comes from `districtForLevel(n)`, so L31+ cycles.
  - Each tile also gets `data-district`, and its aria-label ends with "· NIGHT CITY" etc.
  - These are written only when a tile is built or renumbered.
  - Locked tiles show the band at 40 % opacity. Numbers and stars sit above the wash.
  - Screenshot: `EV/ui-check-390/03-levels-top.png`. It is subtle: the milestone skull and the current-tile glow keep priority.
- **Title caption.**
  - A second caption line, `.caption-district` ("● DISTRICT 3 · NIGHT CITY", micro display font, accent dot), from `districtForLevel(highestUnlocked)`. That is the district the title scene shows (§3.5).
  - The node is created once and re-appended by `_fillTitle`.
  - `#title-caption` is `flex-shrink: 0`, so the two lines are never squeezed under the SHOP / LEVELS row (that overlap appeared in landscape before the fix).
  - Screenshots: `EV/ui-check-390/02-title-l14.png`, `EV/pill-shots/*.png`.

## 3. Music default 70 (`js/save.js:62–64`, `js/ui.js:357`)

`defaultSave().settings.music` is 70, and so is the stub-harness `DEFAULT_SETTINGS`. Migration is unchanged: `fillDefaults` only fills keys that are missing.

`EV/tools/music-default.mjs` → `EV/music-default.json`: **PASS**.

| Input | Music after load |
|---|---|
| Fresh profile | 70 |
| Saved v1 music 80 | **80** |
| Saved v1 music 35 | 35 |
| Saved v1 music 0 | 0 |
| v1 save with no music key | 70 |
| v1 save with no settings | 70 |
| v0 blob | 70 |
| Music `'abc'` | 70 |
| Music `'55'` | 55 |

## 4. Consistent-build service worker (`sw.js` v4; r4-release §7 item 4)

**Design**
- **Install.**
  - The new worker pre-caches the **whole** PRECACHE list into `gaterush-<VERSION>` with `cache: 'reload'`.
  - Any failed file deletes the half-filled cache and **fails the install**. The old worker keeps serving its own complete build, and the browser retries later.
  - The CDN cache **copies the previous version's entries forward** (three r170 is pinned and the font URLs are immutable) and fetches only what is missing. The new worker is therefore offline-ready the moment it takes over, and the install does not wait on jsdelivr. Before this change, one run took over 60 s to reach `installed`.
  - There is **no `skipWaiting()`**: the worker waits.
- **Takeover.** Either:
  - the next launch after every old page has closed, or
  - the title's "Update ready — tap to reload" pill: ui posts `{type:'SKIP_WAITING'}` to `reg.waiting`, the worker runs `skipWaiting()` and `activate` claims the page, ui reloads on `controllerchange` (with a fallback reload after 4 s).
- **Fetch, same origin.**
  - Precached path with no query: the active cache (cache-first). A file missing from the cache comes from the network and is **not** written back.
  - Navigation to `/` or `/index.html` (any query): the cached shell.
  - Other navigations: the network, with the cached shell offline.
  - Other same-origin files: the network, with the cache as fallback.
  - The CDN keeps stale-while-revalidate.
- **Activate** deletes the other `gaterush-*` caches and claims clients.
- **Release rule** (in the header and ARCH §15.4): every release must change `sw.js`.

**ui wiring** (index shell only; `ctx.config.isArtifact` skips it)
- **Detecting an update.** `navigator.serviceWorker` is guarded. ui listens for `controllerchange`, the registration's `updatefound`, and the installing worker's `statechange`. A worker that is `installed` while another is `active`, or `reg.waiting` present at init, means an update is ready.
- **Another tab's update.** A `controllerchange` caused by another tab's update (the page had a controller and did not ask) shows the pill again instead of reloading mid-game.
- **Update checks.** ui calls `reg.update()` 2.5 s after the launch's first title, then at most every 30 min on entering the title. Chrome defers its own post-navigation check: the first run waited 58 s, and one 1.5 s check right at the title still took 52 s (my guess: it was folded into the page's own pending `register()` job; that cause is not proven). With the delayed check, `waiting` arrived 2–11 s after boot over six runs on this loaded host.
- **The pill.**
  - Its DOM write happens in `update()`.
  - Placement: bottom centre in portrait and desktop, with `#scr-title.has-update` giving it a row of its own; bottom-left on landscape phones.
  - Text: `STRINGS.update.ready`, with an aria label.

**Two-build test** (`EV/tools/mkbuilds.cjs` + `EV/tools/swcheck.mjs`)
- **The two builds.** Marked copies of the tree. distA is v4, marker "A". distB is the same tree with marker "B" and `VERSION 'v5'`.
- **The markers.** An index meta tag, the main.js VERSION suffix in `#version`, a CSS `::after`, and trailing comments in ui.js / data.js / save.js fetched through the worker.
- **Server.** One origin, switched from A to B mid-run.
- **Result.** `EV/sw-test/final/report.json` **PASS 16/16**. The slow-network variant (`--delay 400` ms per response, `EV/sw-test/final-slow/`) also **PASSES**.

| Phase | Build seen | Notes |
|---|---|---|
| A first visit | A (all 6 markers) | v4 active and controlling; `gaterush-v4` 32 entries |
| A reload | A | 45/58 responses served by the worker, 1 network hit (sw.js check) |
| **The origin now serves B**; reload | **A, not mixed** | Only the v5 install hit the network (sw.js + 32 files); v5 `installed` and **waiting** after 11.4 s (10.1 s on the slow network); caches v4 and v5 side by side; **pill shown** (`EV/sw-test/run1/s1-3-pill.png`, `final/s1-4-pill-after-run.png`) |
| Reload again; play L1 3 s, quit | A; 0 navigations | The waiting worker does not take over on a single-tab reload or mid-session |
| Real touch tap on the pill (hit test = `btn-update`) | **B** after one reload | `controllerchange` → reload; only `gaterush-v5*` caches remain; pill gone |
| Offline reload | B | Server closed, page offline |
| Scenario 2: install A, release B (v5 waiting after 1.8 s), close the tab, open a new one | **B** | Takeover at the next launch with no old page open |

- Worker errors: 0. Page errors: 0. Console errors: 0.
- Runs `run2`–`run12` are the development history: the CDN carry-forward, then the first-check delay. `swcheck-dbg.mjs` wraps `registration.update()` to log its calls.

**Pill layout** (`EV/tools/pill-shots.mjs`, `EV/pill-shots/`)
- Tested at 390×844, 390×844 with large text, 360×640, 844×390 and 1280×800.
- At every size the pill wins its hit test, overlaps no title control (logo, buttons, caption, version) and does not ellipsize.

## 5. HOME icon on game over / endless (r4-release lead question)

Confirmed: yes, and the shipped markup already does it.
- `#btn-home` and `#btn-endless-home` are the 48×48 house icon buttons. `index.html` and `artifact.html` contain no text HOME (`grep ">HOME<"` → 0).
- `EV/home-results-390/` re-runs the round-4 `results.mjs` on the current tree: complete, game over and endless each **pass**. HOME is top-left with no overlap, a real tap lands on the title, and `ui:button` carries the button id. See `02-gameover.png`.
- GDD §14 now records the decision.

## 6. Static checks and smoke

- `node --check` passes on every file in `js/` and `tools/`, and on `sw.js`.
- `node tools/check-imports.js`: 0 errors, 0 warnings.
- `node tools/build-artifact.js`: "sw.js PRECACHE covers all 22 files"; 181 lines, 34 preloads. The artifact contains no `serviceWorker` (enforced by the tool); `#district-banner` and `#btn-update` are present.
- No `console.log` / `Math.random` added.
- `tools/package.js` was **not** run: it rewrites `dist/`, which is release output. Its `--check` regex counts every `'./…'` string in sw.js; the new `SHELL` list holds only `./index.html` and `./`, so the count is unaffected.

| Smoke (`--out EV/smoke-*`) | Verdict | Errors (page / console / failed) | Notes |
|---|---|---|---|
| `--scenario boot --quality med` | CLEAN | 0/0/0 | `smoke-boot/00-title.png` shows the district line |
| `--scenario all` | CLEAN | 0/0/0 | HOME touch tap → title |
| `--scenario all --shell artifact` | CLEAN | 0/0/0 | HOME → title |
| `--scenario all --shell sandbox` | CLEAN | 0/0/0 | 1 expected warning: volatile save |
| `--scenario all --desktop` | CLEAN | 0/0/0 | HOME mouse → title |
| `--scenario ui` | CLEAN | 0/0/0 | |
| `--scenario play --level 6 --quality med --seconds 60` | CLEAN | 0/0/0 | |
| `--scenario play --endless --seconds 60` | CLEAN | 0/0/0 | |

**Frames and draw calls.** p95 is 7 ms everywhere. The worst frames were 170–440 ms, at 52–60 s into the `all` runs and 3 / 15 / 28 / 38 s into L6, while other groups' Chrome runs shared the host. None falls inside a banner window: the banners are at 0–1.6 s, and endless shows no long frame at all. My changes are DOM / CSS only and add no draw call. The smoke `calls` field read up to 63 (L1), 67 (L6) and 65 (endless) on Medium; see needsOtherGroup 3.

## 7. Changes (file:line)

**`js/ui.js`**

| Line(s) | Change |
|---|---|
| 41 | Imports `DISTRICTS`, `DISTRICT_RULES`, `districtForLevel` |
| 136–162 | Banner constants and keyframes (`KF_DB`, `KF_DB_RM`, `T_DB`); tint alphas; `TILE_BAND_LEVELS`; SW constants |
| 357 | `DEFAULT_SETTINGS.music` 70 |
| ≈600–630 | Constructor fields for the banner, `pu-on` and the SW |
| 673 | `_swInit()` in `init()` |
| ≈690 | `dispose()` cancels the banner animation and the SW timer |
| 770–778 | DOM cache: `districtBanner`, `dbText`, `btnUpdate`, `updText`, `titleDistrict` |
| 929–931 | Pill text and aria |
| 1042 | `district:change` listener |
| 1350–1362 | Banner prewarm (and its restore) |
| 1771–1775, 1831–1834 | Clear on state exit / `level:start` |
| 1957–2033 | `_onDistrictChange`, `_updateBanner`, `_showBanner`, `_hideBanner` |
| 2035–2130 | SW: `_swContainer`, `_swInit`, `_swWatch`, `_swTrack`, `_swReady`, `_swControllerChanged`, `_applyUpdate`, `_syncUpdatePill`, `_swMaybeCheck`, `_swCheckNow` |
| 2166–2167 | `update()` hooks |
| 2622–2629 | `#hud.pu-on` |
| 2700–2709 | Title district line |
| 2725 | Update check on the title |
| 2780–2784, 2817–2840 | Tile band, `band-start`, `data-district`, aria |
| 3230 | `btn-update` route |

**Other files**

| File:line | Change |
|---|---|
| `css/game.css:1123–1173` | `#district-banner`, `.db-text`, `::after` rule, `#hud.pu-on` |
| `css/game.css:1292–1335` | `#title-caption` no-shrink, `.caption-district`, `#btn-update`, `.has-update` |
| `css/game.css:1417–1440` | `.tile-band`, `.band-start` |
| `css/game.css` prewarm rule | `#district-banner.prewarm` |
| `css/game.css:2396–2409` | Landscape phones: update pill bottom-left; banner top-left |
| `index.html:59` | `#district-banner` (ARCH §10.1 markup) |
| `index.html:69` | `#btn-update` in `#scr-title` |
| `sw.js:1–35` | Header with the design and the release rule |
| `sw.js:38` | `VERSION 'v4'` |
| `sw.js:103–110` | `PRECACHE_URLS`, `SHELL`, match options |
| `sw.js:131–165` | Mandatory precache; CDN carry-forward; no skipWaiting |
| `sw.js:167–172` | `SKIP_WAITING` message |
| `sw.js:192–275` | `fromBuild`, `shellNavigation`, `networkWithFallback`, routing |
| `js/save.js:62–64` | Music default 70 with a migration note |
| `js/data.js` (STRINGS, after `errors`) | `update: { ready: 'Update ready — tap to reload', aria: … }`; ui falls back to the literal if the key is missing |
| `docs/ARCHITECTURE.md` | §10.1 `#btn-update`; §10.3 rows for `#district-banner`, `#hud.pu-on`, `.caption-district`, tile band, `#btn-update`; §15.4 service-worker paragraph rewritten for v4 |
| `docs/GDD.md` §14 | Title (district line, update pill), HUD (banner), Settings (music 70), Levels (bands), Game over / Endless (HOME confirmed) |

## needsOtherGroup

1. **DISTRICTS.md §5 placement in landscape (spec owner).** "Centred in the `#powerups` row" puts the banner on the far gates on landscape phones (844×390): the road and its gates occupy the top-centre band there. I implemented the closest correct behaviour, which is top-left under the pause button with no `pu-on` drop. Please add the landscape rule to §5. The existing centred **power-up pill row** has the same problem in landscape: it sat on the far gates in `EV/ui-check-844x390/07-banner-pu-on.png`. That is pre-existing, and moving it is a GDD/HUD decision.
2. **audio.js (audio owner).** `js/audio.js:479` (`this._music = 80`) and `:542` (`num(settings.music, 80)`) still fall back to 80. The comments at :205–206 and `data.js:1514` (`MUSIC.buses.music −15.94` "so the default 80 is unchanged") were calibrated for a default of 80. With a default of 70, a new profile's music bed is −1.16 dB lower than the round-4 mix, and the "sound 50 / music 80 reward rise" lead question now applies at music 70. Please change the fallbacks to 70 and either re-trim `MUSIC.buses.music` (+1.16 dB to keep the old default loudness) or confirm that the quieter bed is the intent.
3. **Draw calls (render / environment).** The smoke timeline's `calls` reached 63 (L1), 67 (L6) and 65 (endless) on Medium against "main ≤ 50". It may be main + shadow summed; my changes add no draw. Please confirm against `?debug=1` main / shadow / post.
4. **tools/package.js (release owner).** sw.js is cache-first now, so a release whose `sw.js` is byte-identical never reaches installed players. Suggestions:
   - `package.js --check` fails when `VERSION` equals the last shipped `dist/sw.js` while any precached file changed; or
   - it stamps a content hash of the PRECACHE files into `dist/sw.js` (for example a `// build <hash>` line).
5. **main.js (lead).** `VERSION` is still `'1.1.0'` (the title shows v1.1.0). Bump it with the round-5 release. My sw `VERSION` is `v4`.
6. **dist/ is stale.** It still holds the v3 worker and the 1.1.0 files. The release owner should run `node tools/package.js --check` once the round-5 tree is final; I did not overwrite release output.
