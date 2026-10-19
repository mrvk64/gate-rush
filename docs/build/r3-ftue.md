# Round 3: first-time player (FTUE) review

**Role:** first-time player and mobile-games producer review of a fresh install, with fixes.

**Files changed:**

| File | What |
|---|---|
| `js/gates.js` | the count label wins every overlap with a gate's value text (F1) |
| `js/fx.js` | the label's plate size is exposed (F1); the label fades out during the boss-intro dolly (F2); the "−k" loss floater picks the side it fits on (F9) |
| `js/render.js` | a `dollying` getter (F2) |
| `js/ui.js` | the SHOP badge (F4); the shield pill is hidden during the dolly (F2); the shoot-hint hand sways instead of tapping (F3); a hint yields early when another one waits (F7); the results survivors line (F8) |
| `js/level.js` | the `dodge` hint and the first-pickup hints (F5, F6) |
| `css/game.css` | the badge; the results coin pill now draws above the scrim (F4) |
| `js/data.js` | `HINTS`, `STRINGS.shop.available`, `STRINGS.complete.newBest`, `JUICE.ui.hintMinSeconds`, `JUICE.damageNumber.bossSide`, and one L1 hint row |

**data.js scope:** no balance number was touched. That means nothing in `LEVELS` / `LEAK` / `ECONOMY` / `STARS` / `WAVE` / `GATE_RULES.generation`.
- The validator output is identical to the balance owner's final run, apart from generation timings (§5).
- The one `LEVELS` edit is L1's `type: 'hint'` row, which only moves when the text appears.

**Docs:**
- `docs/GDD.md` §1.1, §3.1, §4.1, §6.1, §8, §11 and §14.
- `docs/ARCHITECTURE.md` §6.3, §6.9, §6.12, §6.16, §8 (round-3 key changes), §8.8 `HINTS` and §10.3.

**Evidence:** everything is under `E:/Temp/claude/gate-rush-evidence/r3/ftue/`, written `EV/` below.

| Path | Contents |
|---|---|
| `EV/tools/` | `ftue.mjs` (the session player), `hitch.mjs`, `shots.mjs`, `timeline.cjs`, `matrix.sh`, `nbsp.cjs` |
| `EV/src-before/` | the js / css / index.html as they were when this review started (md5 list in `md5.txt`); every "before" run serves them through `--src` |
| `EV/run1/` | before, seed 7: L1–L4, shop skipped, the post-L5 tail. L5 was lost to a harness artefact, see §4 |
| `EV/run2-before/` | before, seed 11: L1–L5, the L3 shop and the tail |
| `EV/run3-after/` | after, seed 11: the same session on the final code (except the last two text and spacing edits, see §5) |
| `EV/pass-before/`, `EV/pass-after/` | seed 7, L1–L2, with an extra screenshot at every gate pass (`--passShots`) |
| `EV/run4-final/` | after, L1 only, on the final code |
| `EV/shots-390x844/`, `EV/shots-844x390/` | the badge / results / game-over / boss-intro screens in portrait and landscape |
| `EV/hitch-before-ftue/`, `EV/hitch-after-ftue/` | frame-pacing probes |
| `EV/smoke-a1/`, `EV/smoke-final/` | the project's smoke harness |
| `EV/static/` | validator output and the artifact check |

Each run folder holds JPEG screenshots every 3 s, named `NNN-<seconds>s-<phase>.jpg`, plus event shots. Its `log.json` has every hint as it appeared on screen, every gameplay event, frame stats and errors; `timeline.txt` is the per-level digest.

## 1. How the review was played

`EV/tools/ftue.mjs` plays the game the way a new phone player would.
- **Setup:**
  - a fresh Chrome profile, so the save is fresh;
  - `index.html` with no query string: no `?debug`, the debug overlay hidden, music on;
  - 390 × 844 at DPR 3, mobile with touch (`pointer: coarse` true), an Android Chrome UA;
  - the real GPU at High tier, and the real network for fonts and the CDN.
- **Input:** every tap and drag is a real CDP `Input.dispatchTouchEvent`.
  - Taps hit the button's visible box.
  - Drags are thumb-zone strokes of up to 150 px at ~10 px per 16 ms.
  - Nothing in the game is called. `window.__game` is only read: event listeners, gate / crate / zombie positions, and the hint DOM.
- **The player's policy:**

  | Situation | What the bot does |
  |---|---|
  | Level start | nothing until "DRAG TO STEER" has been up ~1 s |
  | A gate within ~50 m | picks the lane with the best face value (what the panel reads now), 0.45–0.7 s after it becomes readable; re-evaluates as the numbers change |
  | A crate ahead (no gate near) | steers under it |
  | Otherwise, between gates | steers under the densest cluster of zombies ahead |
  | Boss attack telegraph | the far side, after a 0.3–0.5 s reaction |

- **The session:**
  1. boot, title (read for ~2 s), PLAY;
  2. L1 with the tutorial hints, results, NEXT;
  3. L2, then L3;
  4. SHOP from the L3 results: buy "Start squad", BACK, NEXT;
  5. L4, then L5 (Spitter Queen);
  6. NEXT, pause, QUIT, to see the title after L5 (there is no HOME on the results screen);
  7. LEVELS, BACK, SETTINGS, BACK.

  A loss would mean RETRY, up to 3 attempts.

## 2. Verdict

**What already works.** The first minute already sells the game.
- In the first 10 s:
  - 5 soldiers start firing on their own;
  - "DRAG TO STEER" is the only instruction until the player drags;
  - the +5 | +2 pair is readable at the horizon and the first hits land at 4.3 s;
  - 6, 7, 8 … +20 roll up with ticks, and the gold MAX badge lands 1.2 s later;
  - the pass bursts "+20" and the count reads 25 by 9 s.
- **The squad feels powerful.**
  - L1 ends with 239–279 soldiers, in a blob that fills the lane.
  - The L1 Hulk melts in ≈ 8–9 s; the L2–L4 Hulks take 11–19 s, inside the GDD §7 8–25 s target.
  - Every level L1–L5 cleared on the first attempt with this bot: 3★ L1–L3, 2★ L4, 2★ / 3★ L5 across seeds.
- **Results and shop.** The results screen is juicy: stars slam in over a sunburst and the coins count up. The shop is clean, priced so that every rank-1 upgrade is affordable after one clear.

**What was wrong.** A demanding player hits seven things in the first five levels that read as unfinished.
1. At every gate pass the count label and the gate's number print on top of each other: "+695", "8×33", "+16/4".
2. The boss intro shows a stray digit and a lone shield pill in the letterbox.
3. "SHOOT THE GATE!" animates a TAP.
4. Nothing ever says that the red ring under the squad is dodgeable.
5. Armor, magnet, minigun and sniper arrive with no word on what they are.
6. Nothing points at the shop: a first clear pays 361–420 coins, and the run had 916 unspent coins after L3, when it was sent there.
7. Small text issues:
   - a hint line starting with "—";
   - "239 survivors · Best survivors at boss: 239";
   - a greyed-out coin total;
   - boss damage numbers merging into one.

All seven are fixed (F1–F10, below). The remaining concerns are balance-owned (§6) or minor (§7).

## 3. Findings and fixes

Before / after shots are seed-matched where possible: `run2-before` vs `run3-after`, and `pass-before` vs `pass-after`.

### F1 (major): the count label and the passed gate's value glyph merge at every pass

**What the player sees.**
- In the last ≈ 0.3–0.6 s before a pass, the value text of the lane the squad takes sits exactly where fx draws the count label.
- The label's 45 % plate darkens the glyph under it but not the parts outside it.
- So the most important number of the game reads wrong at its payoff moment:

  | Shot | What it reads |
  |---|---|
  | `EV/run1/016-0048s-L1a1-play.jpg` | "69" over "+15": "+695" |
  | `EV/run1/020-0060s-L1a1-play.jpg` | "83" over a ghost "×3" |
  | `EV/run1/066-0174s-L3a1-play.jpg` | "4" under "+16" |
  | `EV/pass-before/018-0045s-L1-pass-z3.3.jpg` | "+24" stacked on "71" |

- It happens at every pass, at every squad size. With a big squad the camera dolly makes it start earlier (≈ gate z −6 m at V = 120).

**Fix: the label wins.**
- **gates.js.** `render()` projects two boxes into view-space tan extents through `render.camera.matrixWorld`:
  - fx's count-label plate, from `fx.label` x / y / z / `width` / `plateH`;
  - each gate's op + digit block.

  Code: `js/gates.js:1512-1535`, `1638-1661`.
- **The fade.** While the two boxes overlap (× 1.1 margin) during play or pause, that gate's text fades out over 0.1 s.
  - `LABEL_YIELD_S` / `LABEL_YIELD_MARGIN` are at `js/gates.js:100-107`.
  - The glyph colour is multiplied by fade³, so the glyph shader's coverage knee does not leave a dark ghost.
  - The text fades back if the overlap ends, for example on a lane the squad steered away from.
- **What stays.** The MAX badge, the other lanes and the title's decorative gates are untouched. `_textFade` is reset at spawn (`:919`) and `_camera()` is cached (`:1743`).
- **fx.js.** Exposes the plate's world size, `label.width` / `plateH` (`js/fx.js:666-667`, `2092-2093`).
- **What the player sees now.** The "×N" badge and the "+N" burst still announce the result at the label (GDD §5).
- **§14.** No allocation: numeric locals only.

**After:**

| Shot | What it shows |
|---|---|
| `EV/pass-after/018-0044s-L1-pass-z3.5.jpg` | a clean "71" under the MAX badge; the other lane's "−15" intact |
| `EV/run3-after/012-0028s-L1-pass-z3.5.jpg` | the ×3 gone, a clean "24" |
| `EV/run3-after/136-0302s-L4-pass-z3.1.jpg` | a clean "81" |

### F2 (major, ugly frame at every boss): the boss-intro dolly cuts the count label into a stray digit; the shield pill sits alone in the letterbox

**What the player sees.**
- `EV/run1/023-0069s-L1a1-boss.jpg`: a lone "9" in the bottom-left corner under the bar.
- `EV/run1/052-0144s-L2a1-boss.jpg`: a shield pill reading "45" parked inside the bottom black bar.

**Root cause.** The dolly drops the squad below the frame while the letterbox is up.
- fx kept drawing the label, and the bar clipped it.
- ui's shield pill passed its "label on the visible band" test because a sliver of the label was still above the bar. Its clamp then put the pill inside the bar.

**Fix:**
- `render.dollying` getter (`js/render.js:2034`).
- fx fades the label and plate out over 0.25 s while the dolly runs, and back in when the camera has returned (`js/fx.js:1522-1531`, `2076-2078`).
  - The fight starts with the camera back.
  - Reduced motion has no dolly, so the label stays.
- ui hides `#shield` while dollying (`js/ui.js:2163-2165`).

**After:** `EV/pass-after/060-0139s-L2a1-boss.jpg` (armor 45 in that run) and `EV/shots-844x390/03-boss-intro-1.png` show clean cinematic frames.

### F3 (major for comprehension): the "SHOOT THE GATE!" hand animates a tap

**Problem.**
- The pill's hand played a tap bounce plus the ripple for the shoot hint.
- The squad fires on its own and the finger only steers, so the hint taught the one gesture that does nothing.

**Fix (`js/ui.js:71-73`, `2212`):**
- Both hand hints (steer, shoot) sway like a drag: "steer into the gate you want to grow".
- `KF_TAP` / `T_TAP` are removed.

**Docs:** GDD §14, ARCH §10.3.

### F4 (major for retention): nothing points at the shop; the results coin total looked disabled

**Producer view.**
- A first clear pays 361–420 coins.
- Start squad 150, coin ×1.1 120, boss damage 180 and fire rate / damage 200 are all affordable after L1.
- The FTUE run never visited the shop until it was sent there after L3, holding 916 coins: `EV/run1/096-0254s-shop-open.jpg`.
- The run's total settled in a coin pill dimmed under the results scrim (0.72–0.9 dark): `EV/run1/033-0087s-L1a1-complete.jpg`. It reads as a greyed-out control.

**Fix:**
- **The badge.** `ui._syncShopBadges()` (`js/ui.js:2576-2605`) gives every SHOP button (title, results, game over):
  - class `has-upgrade` while the coins buy at least one more rank;
  - an aria-label "SHOP · upgrade available" (`STRINGS.shop.available`).

  It runs on title / complete / game-over fill and on `save:change`, and writes the DOM only when the answer changes.
- **The badge's look** (`css/game.css:446-471`): a red "!" notification badge pulsing on the compositor. It holds still under reduced motion.
- **The coin pill.** `#hud.results { z-index: 13 }` (`css/game.css:220-223`) lifts the HUD above the results screens (12) while they are up.
  - Only the coin pill is visible there. The HUD is pointer-events none and its pause button is hidden.
  - So the settled total reads at full brightness.

**After:** `EV/run3-after/112-0247s-after-shop-back.jpg`, `EV/pass-after/036-0082s-L1a1-complete.jpg` and `EV/run3-after/196-0436s-title-after-L5.jpg`.
- Landscape and portrait: `EV/shots-844x390/0{2,4,5,6}-*.png` and `EV/shots-390x844/`.
- Checks in `info.json` for both viewports:
  - title badge off at 0 coins, on at 400;
  - results badge on;
  - game-over badge on;
  - the pill visible at z 13.

### F5 (major): boss telegraphs are never explained

**Problem.**
- The only boss hint is "SHOOT THE BOSS", which needs no action because the squad auto-fires.
- 0.8 s later a red ring appears under the squad, and nothing says that steering out of it saves soldiers. In `EV/run1/024-0072s-L1a1-boss.jpg` the slam ring is right under the squad.
- L5's Spitter Queen marks its spit with **green** acid rings (`EV/run3-after/184-0415s-L5a1-boss.jpg`). So the lesson cannot be "red".

**Fix:**
- `HINTS.dodge` = "STEER CLEAR OF THE MARKS!".
- Shown on the first `boss:attack` of any kind but stomp / chew (they have no mark), once ever (`js/level.js:416`, `1717-1729`).
- It queues behind "SHOOT THE BOSS". With F7 it is on screen 1.5 s into the fight: 0.75 s after the first slam's telegraph and before the charge.

**After:**
- `EV/run3-after/timeline.txt`:
  - L1 at 52.46 s: "SHOOT THE BOSS";
  - 53.20 s: the first slam;
  - 53.95 s: the dodge hint;
  - 55.35 s: the charge, with the hint up.
- `EV/run3-after/027-0066s-L1a1-boss.jpg` shows it under its first wording, "DODGE THE RED MARKS!". It was renamed after the green Queen marks; the final text is in `EV/run4-final/`.

### F6 (medium): new specials appear with no word on what they are

**Problem.** Each level of L1–L5 introduces a new toy:

| Level | New toy |
|---|---|
| L1 | shotgun |
| L2 | armor (a "45" counter appears beside the count) |
| L3 | minigun |
| L4 | magnet (only the helmets turn purple) |
| L5 | sniper |

Only the shotgun got a hint, and that one was "GRAB THE CRATE" before the pickup, not what it is.

**Fix:**
- **The hints.** One `HINTS['<item id>']` per `PICKUP_SCHEDULE` id, for example:
  - "SHOTGUN! WIDE SPREAD, SHORT RANGE";
  - "ARMOR! EACH PLATE STOPS A BITE";
  - "MINIGUN! TRIPLE FIRE RATE";
  - "MAGNET! COINS FLY TO YOU";
  - "A SNIPER JOINS YOUR SQUAD!".

  The texts are checked against GDD §8 and carry no numbers that would duplicate data (`js/data.js:1472-1485`).
- **The trigger.** `level` shows the hint on the first non-duplicate `item:pickup` of that id, once ever (`js/level.js:417`, `1731-1739`).
- **After** (`EV/run3-after/timeline.txt`):

  | Level, time | Hint on screen |
  |---|---|
  | L1 19.65 s | SHOTGUN |
  | L2 27.70 s | ARMOR |
  | L3 30.47 s | MINIGUN |
  | L4 36.01 s | MAGNET |
  | L5 39.39 s | SNIPER |

  Repeat pickups showed nothing.

### F7 (medium): L1's crate hint lured the player off the ×2; the queue had to keep the lessons on their beat

**Problem 1: "GRAB THE CRATE" lured players off the ×2.**
- It fired at 15.0 s, while the x2 | +10 choice was still open (`EV/run2-before/timeline.txt`).
- The crate is on the +10 side. A player who obeys the hint gives up the ×3, about 40 soldiers in this run, and then reads "TRY THE ×2 NEXT TIME".

**Problem 2: moving the crate hint (and adding F6's shotgun hint) piles four lessons into 5 s.**
- In the original code the ×3 lesson showed 0.5 s after its pass, because the crate hint had been on screen since 15.0 s.
- With the crate hint inside the commit window and the shotgun hint after it, strict 2.5 s turns would show the ×3 lesson 2.2 s after its pass and the red-gate hint 2.9 s after its pair spawned. That is the intermediate run `EV/pass-after/`, made before the queue change.

**Fix:**
1. **Crate hint.** L1's row moves from 120 m to 133 m (`js/data.js:782`).
   - It now fires inside the x2 pair's 4 m commit window (gate z −3 m, 16.6 s), when the lane is already locked.
   - The crate is still 27 m out, 3.4 s to steer.
2. **Queue.** `JUICE.ui.hintMinSeconds` 1.5: a hint with another one waiting yields after 1.5 s instead of 2.5 s (`js/ui.js:66-69`, `2026-2029`).

**After (L1):**

| Time | Event |
|---|---|
| 16.65 | crate hint |
| 17.0 | pass |
| 18.13 | "×3 MULTIPLIES YOUR SQUAD" |
| 19.65 | shotgun hint |
| 21.25 | red-gate hint, the moment its pair spawns |

So the ×3 lesson comes 1.1 s after its pass, and the red-gate hint the moment its pair spawns, as in the original code.

### F8 (minor, text): the results line repeated itself

**Problem.** A first clear printed "239 survivors · Best survivors at boss: 239".

**Fix:**
- ui records the level's best at `level:start` (`js/ui.js:1737-1740`).
- The results line then reads (`js/ui.js:2780-2786`, `STRINGS.complete.newBest`):

  | Case | Line |
  |---|---|
  | first clear | "N survivors" |
  | the run beats the best | "N survivors · NEW BEST!" (a reason to REPLAY) |
  | otherwise | "N survivors · Best survivors at boss: B" |

**After:**
- `EV/shots-844x390/04-results.png`: "129 survivors".
- `05-results-replay-better.png`: "362 survivors · NEW BEST!".

### F9 (minor, text and layout)

1. **Em dash at a line start.** Two-line hints broke before the em dash, so the second line started with "—" ("SPITTERS LOB ACID / — SHOOT THEM FIRST", `EV/run2-before/150-0427s-L5a1-play.jpg`).
   - Fix: a no-break space before every em dash in `HINTS` (`\u00A0`, `js/data.js:1462-1485`).
   - After: "RED TAKES SOLDIERS — / SHOOT IT BLUE OR AVOID IT" (`EV/run3-after/014-0033s-L1a1-play.jpg`).
2. **Loss floater cut off.** The "−k" loss floater beside a wide (3-digit) label left of centre was cut by the screen edge (`EV/run2-before/173-0497s-L5a1-boss.jpg`, "−4" at x = 0).
   - Fix: `_lossSide()` now puts it right of the label whenever it would not fit on the left (`js/fx.js:1936-1958`).

### F10 (minor, visual noise): a row's two boss damage numbers read as one

**Problem.** "110" + "48" read as "11048" (`EV/run3-after/027-0066s-L1a1-boss.jpg`).
- The grid's columns had inner edges ±0.12 m from the boss: a 0.24 m gap against 0.72 m boss glyphs, narrower than one digit.

**Fix:** `JUICE.damageNumber.bossSide` 0.12 → 0.3 (`js/data.js:1268-1272`; GDD §6.1).

## 4. Things checked that are fine (or were not the game's)

- **Frame pacing.** run1 and run2-before logged 68 / 334 frames over 50 ms in play, with worst frames of 500 / 614 ms. Those windows coincided with other agents' batch tests: 126 Chrome processes, CPU 100 %.
  - `EV/tools/hitch.mjs` reproduces the FTUE conditions: no query, DPR 3, music, CDP touch, 25 s of L1.
  - On a quiet host it measured **0 rAF intervals over 40 ms** in 3620 frames (before code, `EV/hitch-before-ftue/`) and in 3624 frames (after, `EV/hitch-after-ftue/`).
  - run3-after was also on a quiet host: 58 664 frames, p99 7.1 ms, worst 41.8 ms, 0 over 50 ms.
  - So the long frames were environmental, and this review's changes add none.
- **Lost L5 in run1 (a harness artefact).** run1's first NEXT after L4 did nothing.
  - A 3 s screenshot (a ~0.3 s compositor stall at DPR 3) fell between touchStart and touchEnd, and the browser saw a long press.
  - The harness now holds screenshots off during taps and verifies each tap's state change. 0 retries were needed afterwards.
- **First boot.** On a fresh profile over the network the boot takes 7.5–14 s. The bar moves the whole time.
  - The logo shows a fallback font for its first seconds, until Lilita One arrives (`EV/run1/001-0006s-boot.jpg` vs `003-0012s-boot.jpg`). That is network-dependent.
- **Title, settings, levels.**
  - Title: clean, one obvious PLAY.
  - Settings: readable rows, RESET SAVE de-emphasised.
  - LEVELS: shows progress and stars, a locked ENDLESS bar after L10 as the long-term goal, and milestone skulls.
  - After L5, ENDLESS is correctly still hidden on the title: it unlocks after L10.
- **Hint placement.** Every hint sat in the bottom pill (y 748–791 of 844) and never covered a gate, a zombie or the boss.

## 5. Verification

**Static checks** (from the project root):

| Check | Result |
|---|---|
| `node --check` on `js/*.js`, `tools/*.js` and `sw.js` | all OK |
| `node tools/check-imports.js` | 0 errors, 0 warnings |
| `node tools/validate-levels.js` (`EV/static/validate-after.txt`) | 30 levels, 10 warnings, 0 errors. Identical to `r3/balance/validate-final.txt` apart from the "generated in N ms" timings, so no level, wave or gate changed |
| `node tools/build-artifact.js --out EV/static/artifact-check.html` | byte-identical to `artifact.html`; `index.html` is untouched, and css / js load by URL |
| `grep console.log / Math.random` in the edited modules | none |
| Per-frame allocation | the new per-frame paths (`gates.render` label yield, `fx.update` intro fade, `ui._placeShield` / `_updateTheatre`) use numeric locals only |

**FTUE sessions:**

| Run | Code | Result | Errors |
|---|---|---|---|
| `run2-before` (seed 11) | before | L1 3★, L2 3★, L3 3★, L4 2★, L5 2★ | 0 page / console errors, 0 failed requests |
| `run3-after` (seed 11) | after | L1 3★, L2 3★, L3 3★, L4 2★, L5 3★; the L5 star is bot variance, its first-gate pick differed | 0 errors; frames p99 7.1 ms |
| `pass-before` / `pass-after` (seed 7, L1–L2) | before / after | gate-pass frames for F1 | — |
| `run4-final` (seed 7, L1) | final | 3★, 279 survivors; "STEER CLEAR OF THE MARKS!" on screen at 53.97 s (0.76 s after the first slam), boss numbers in two clear columns (`026-0063s-L1a1-boss.jpg`) | 0 errors |

`run3-after` predates two final edits: the dodge hint's wording and `bossSide`.

**Screen checks (`EV/tools/shots.mjs`):**
- **390 × 844 @3 and 844 × 390 @2** (`EV/shots-*/info.json`):
  - badge off / on;
  - first-clear line, then "NEW BEST!";
  - pill at z 13;
  - game-over badge;
  - boss intro clean;
  - 0 errors.

**Project smoke harness** (`EV/tools/matrix.sh`, output `EV/smoke-final/`, final code, quiet host). Every run: 0 page errors, 0 console errors, 0 console warnings, 0 failed requests, 0 frames over 50 ms.

| Run | Command (beyond `--bootTimeout 120 --out …`) | Verdict | Result | Frames (p99 / worst) |
|---|---|---|---|---|
| all | `--scenario all` | CLEAN | UI walk, then L1 3★, 256 survivors ("256 survivors", SHOP badged) | 7.1 / 7.4 ms |
| all-artifact | `--scenario all --shell artifact` | CLEAN | L1 3★ | 7.1 / 20.8 ms |
| all-desktop | `--scenario all --desktop` | CLEAN | L1 3★ (`15-result.png`: badge, bright coin pill) | 7.1 / 20.8 ms |
| l5 | `--scenario play --level 5 --seconds 130` | CLEAN | L5 3★, 165 survivors | 7.1 / 20.9 ms |
| l2-boss-armor | `--scenario play --level 2 --boss --after "g.squad.setCount(80,'debug'); g.squad.setArmor(30)"` | CLEAN | boss intro with armor, L2 clear | 7.1 / 7.9 ms |
| endless | `--scenario play --endless --seconds 70` | CLEAN | alive at 70 s, 647 m, C 148 | 7.1 / 14.0 ms |

Earlier, after the first batch of fixes: `EV/smoke-a1` (`--scenario all`) CLEAN, worst frame 27.8 ms.

After the very last edit, which makes a hint yield only to a fresh queued hint: `EV/smoke-final/all-final` (`--scenario all`) CLEAN, 0 frames over 50 ms; and `EV/run5-final` (seed 7, L1) shows the same hint sequence as `run4-final`.

A copy of `tools/callsites.js` run on the final js (`EV/cs/docs/build/CALLSITES.md`, 612 lines) lists the new `render.dollying` member. The project's `docs/build/CALLSITES.md` is left for its owner to regenerate after the round-3 edits.

## 6. Balance concerns (reported, not changed: balance owner)

1. **L5 (seed 1005) punishes the shiny lane hard.**
   - The opener is +3 (cap 12) | item (shotgun). A first-time player at 7 soldiers takes the purple special lane: run2-before at 7.98 s.
   - That puts the squad 12 soldiers (≈ 66 %) under the design line, and the waves are sized on that line:

     | Wave | Contents | Design E |
     |---|---|---|
     | 1 | 5 walkers | 18 |
     | 2 | 6 walkers + 2 runners + 1 spitter | 29 |

   - The squad ground down 17 → 9. The −12 | ÷2 "lesser evil" pair at 28 s then offers 1 or 5, and 9 only for a squad that pumps ÷2 to ×1, which the hints never taught.
   - run2-before reached the +30 single with **1 soldier left**. It survived to 2★ only because the next three gates were rich.
   - Suggestions, the owner's call:
     - in the opener, size the item lane's alternative so that skipping it costs ≤ 30 % of E;
     - or keep lesser-evil pairs out of the stretch where a below-line squad is still under ~0.5·E;
     - or count the item lane's real worth (the shotgun's 10 s) in the design line.
2. **The ÷ ladder is never taught.** The red-gate hint ("SHOOT IT BLUE") is once ever and fires on L1's −15. The first ÷ (L3, a lesser-evil pair) gets no hint, so new players do not know ÷2 climbs to ×1 then ×2.
   - A `div` hint at the first ÷ lane spawn is a one-liner in `level._onGateSpawn`. It is not added here, to keep L3–L5 from growing more hint text; flagged for the lead / level owner.
3. **L4 stays 2★** for this human-like bot in both seeds (117–131 survivors against the 140 needed for 3★ = 0.8 × 175).
   - The bot loses 20–25 to slams and 28–29 to bites there, a little more than elsewhere.
   - That fits a "first wall" at L4, but the balance owner may want to confirm it is intended. Their own L4 numbers are in r3-balance §2 / §3.

## 7. Residuals and needsOtherGroup

1. **Lead / ui: no HOME on the results screen.** The only way back to the title from results is NEXT → pause → QUIT, which starts a level. GDD §14 specifies NEXT / REPLAY / SHOP. A small home icon would let a player stop on a high. Not changed: a layout decision.
2. **ui / art: the coin multiplier card icon reads "×2"** while its first rank is ×1.0 → ×1.1 (`EV/run1/096-0254s-shop-open.jpg`). Minor and misleading.
3. **ui / art: the weapon pill icon.** The shotgun pill icon (an orange ring around a dark shape) is hard to read at 36 px. The new pickup hint names the weapon, so this is minor.
4. **fx: boss damage numbers.** With `bossSide` 0.3 a row's two numbers no longer touch. The stack is still busy on bosses with fast fire; capping live numbers per row would be the next step (FX-12 owner).
5. **Boot font swap.** The boot logo renders in a fallback face until Lilita One loads on a first visit. `font-display: block` for the logo face alone would hide it; that belongs to the boot owner (round-3 boot polish).
6. **Data keys.** gates.js's two new constants carry DATA-MISSING markers (`GATE_RULES.glyph.labelYieldS` / `labelYieldMargin`), following the module's convention. The integrator may move them to data.js.
