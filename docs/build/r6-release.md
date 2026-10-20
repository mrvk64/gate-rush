# Round 6: release 1.2.2

Release 1.2.2 answers the owner's phone playtest (installed PWA, Android Chrome). It ships the three round-6 changes, verified in `r6-verify.md`:

1. **Stored weapons and the FIRE button** (`r6-weapons.md`). A weapon pickup is stored, not started. Up to 2 wait first in, first out. A tap on the round FIRE button (bottom right), Space or gamepad A starts the next one with its full duration. A third pickup while the slot is full, and each weapon left unused when a level is won, pays 25 c. Owner: "a lot of the time the 10 seconds gets wasted".
2. **The Android Back guard** (`r6-backguard.md`, with the `history.forward()` re-arm fix from `r6-verify.md` §2.2). The Android back gesture during a run pauses the game, every time; it does not close the app. On the title, Back still leaves. Owner: a swipe "closed the game".
3. **Textures that survive a GPU-process loss** (`r6-textures.md`). Pause, lock the phone for hours, come back: the gate digits, the MAX letters, the count plate, the lane paint and the windows are re-drawn. Owner: "the numbers were gone from the boards".

Evidence root: `E:/Temp/claude/gate-rush-evidence/r6/release/`.

**Verdict: PASS.**

## 1. Version bump

| File | Before | After |
|---|---|---|
| `js/main.js` `VERSION` (`ctx.version`, the title's "v…") | `'1.2.1'` | `'1.2.2'` (title shows "v1.2.2", `boot/00-title.png`) |
| `package.json` `version` | `1.2.1` | `1.2.2` |
| `package-lock.json` (root and `packages[""]`) | `1.2.1` | `1.2.2` |
| `sw.js` `VERSION` | `'v6'` (shipped in the 1.2.1 `dist/`) | `'v7'`. It was already bumped in `r6-verify.md`; its header line now names release 1.2.2 |

Docs follow: the ARCHITECTURE §3 `ctx.version` row and §15.4 name 1.2.2 / v7.

## 2. Packaging

- v7 never shipped. The round-6 `dist/` in the tree was an unshipped v7 build of 1.2.1, so the version bump would have been refused under the same `VERSION`.
  - `dist/` was therefore restored to the committed, shipped 1.2.1 build (v6, stamp `f7f1faf4…`) first.
  - The packager then checked the new build against what actually shipped.
- `node tools/package.js --check`: **pass**.
  - "sw.js precache OK (31 files, all present in dist/; every js/ file listed; cache version v7; build 393b19c282ab)".
  - "dist/ ready: 33 files, 2623 KB".
- Every `dist/` file except `sw.js` is byte-identical to its source (`cmp`). `dist/sw.js` = `sw.js` plus the build stamp `393b19c2…`.
- Exactly 12 `dist/` files differ from the 1.2.1 `dist/`: `artifact.html`, `css/game.css`, `index.html`, `sw.js`, and `js/` data, engine, level, main, pickups, render, ui and weapons.
- `artifact.html` was rebuilt by the packager: 190 lines, 15 979 bytes; PRECACHE covers all 22 `js/` files.
- `gate-rush-dist.zip` was rebuilt from `dist/` with the r5/r6 writer (`r6/verify/tools/mkzip.cjs`).
  - 33 files, 1 000 561 bytes, md5 `549b3c68…`; `unzip -t` OK.
  - The zip is git-ignored, so it is not committed.
- Static checks: `node --check` on every `js/*.js`, `tools/*.js` and `sw.js`, 0 failures. `node tools/check-imports.js`: 0 errors, 0 warnings.

## 3. Smoke on the final tree

Each run: `node tools/smoke.js … --bootTimeout 90 --out E:/Temp/claude/gate-rush-evidence/r6/release/<run>`. Headless Chrome, real GPU (RX 6800, ANGLE D3D11), 390 × 844, auto quality → High.

| Run | Command | Verdict | Page err / console err / warn / failed req | Boot (s) | End | Frames: n, p99 / worst (ms) | > 50 ms | Start (ms) | Calls max main / shadow / post | Programs | FIRE |
|---|---|---|---|---|---|---|---|---|---|---|---|
| boot | `--scenario boot` | **CLEAN** | 0 / 0 / 0 / 0 | 7.3 | title, high, "v1.2.2" | – | – | – | – | – | – |
| all | `--scenario all` | **CLEAN** | 0 / 0 / 0 / 0 | 7.3 | ★★★ LEVEL 1 CLEAR; HOME → title | 8 743, 7.1 / 20.9 | 0 | 7.1 | sunset 34 / 12 / 14 | 58 | 1 press, 1 started |
| all-artifact | `--scenario all --shell artifact` | **CLEAN** | 0 / 0 / 0 / 0 | 5.9 | ★★★ LEVEL 1 CLEAR; HOME → title | 8 743, 7.1 / 20.9 | 0 | 7.1 | sunset 34 / 12 / 14 | 58 | 1 press, 1 started |

These match the `r6-verify.md` m2 matrix. The bump changes one string in `js/main.js`, so its full matrix, its targeted repros (textures, Back, weapons) and its v6 → v7 update-path check still stand for this build.

## 4. README

- "This is version 1.2.2."
- New "What's in the game" bullet: **Weapons you fire when you choose**. It covers the stored slot, the FIRE button, the 25-coin refunds, and saving a rocket for the boss.
- New Controls line: tap the FIRE button at the bottom right (steering can continue with another finger), or press Space on a computer.

## 5. Commit

- One commit on `main`. It holds every round-6 change, `dist/`, and the `r6-*.md` reports including this one.
- The git config is unchanged, and nothing is pushed. The owner pushes from GitHub Desktop, and GitHub Pages deploys `dist/` about a minute later.

## 6. After the push: owner phone checks

- **Update.** Open the installed app. The "Update ready" pill shows, or the next launch updates. The title then reads **v1.2.2**.
- **Weapons.** Pick up a weapon crate: it waits on the FIRE button and runs its full 10 s when tapped. With 2 stored, a "×2" badge shows. A tap while a weapon runs is refused with a head-shake.
- **Back.**
  - An edge swipe during a run pauses the game; a second swipe keeps it paused.
  - RESUME, then Back, pauses again.
  - QUIT, then Back on the title, closes the app.
- **Textures.** Pause, lock the phone for a long while, come back: the gate numbers, the MAX letters and the squad count are all there.
