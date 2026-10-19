# Round 4: item icons and boss damage numbers (visual / fx)

**Scope.** I own `js/render.js` (the TextureFactory icons only) and `js/fx.js`. This pass covers two tasks:

1. **Icons.** Every item icon is redrawn so that it reads at the size it is shown. Inputs: r3-ftue residual 3, and the lead's request that each item have one clear shape.
2. **Boss damage numbers.** Live boss numbers are capped per row and side. Input: r3-ftue residual 4.

**Evidence.** The evidence root is `E:/Temp/claude/gate-rush-evidence/r4/visual-fx/`, written `EV/` below.

**A/B method.** Other agents were editing the shared tree during this pass. At one point it did not boot: `audio.js:122` reads `…idleMinMs` of undefined, mid-edit.

So I froze a bootable copy of the tree in two versions:
- `EV/snap/`: the round-4 code, with the final `render.js` and `fx.js` (byte-identical to the project's files).
- `EV/snap-before/`: the same copy, with the handed-over `fx.js` and `render.js` from `EV/src-before/`.

Every before/after pair below ran on these two copies, so the only difference between them is my two files.

> **Warning:** `snap*/node_modules` are NTFS junctions to the project's `node_modules`. Before you delete a snapshot, remove each junction with `cmd /c rmdir`. A recursive `rm -rf` could follow the junction and delete the project's `node_modules`.

## 1. Item icons (`js/render.js`, TextureFactory)

### Problem

- **Too small.** Weapon icons filled about half of their cell.
  - The shotgun was two thin orange bars against a black block.
  - The minigun was a black disc with yellow bars.
  - The laser looked like a key.
  - The railgun was a lightning bolt, which clashed with the chip's bolt.
- **Dark parts disappeared.** Large near-black parts (`PALETTE.props.tyre`) vanished on the dark pill: the shotgun stock, the minigun drum, the drone rotors and the APC.
- **Low contrast.** The thin 1.5-unit outline and the small shapes left almost nothing at 18–20 px.
- **Before evidence:**
  - `EV/iconsheet-before.png`: every icon at 18 / 20 / 28 / 36 px on the pill's light disc, the dark HUD, the sky, the road and a blue gate, plus the raw atlas.
  - `EV/crop-before-pills-*.png`: the in-game HUD pills.

### Change

`_paintIcon` was rewritten. It runs at boot only (the atlas and the cached data URLs) and never per frame. The layout and the public API (`iconUV`, `iconDataURL`, `RENDER.icons.order`) are unchanged.

**Silhouettes.** Each item is one bold silhouette:

| Item | Shape |
|---|---|
| Shotgun | Pump shotgun: orange stock, receiver and pump with seams, gunmetal barrel |
| Minigun | Three yellow barrels clamped by two rings, motor block behind |
| Rocket | Missile flying up and right: white nose, fins, exhaust |
| Railgun | Forked barrel: two blue rails with a pale charge between them |
| Laser | Retro ray-gun: round cyan body, two white rings, emitter tip |
| Armor | Large shield with a glint |
| Chip | Cyan CPU with pins on four sides and a dark die |
| Booster | One fat up arrow |
| Magnet | Thick horseshoe with white pole tips |
| Sniper | Bold reticle with a red dot |
| Medic | Red cross on a white disc |
| Flamer | Flame with a pale core |
| Drone | Dark X frame, four light rotors, hub with a green LED |
| APC | Olive hull with a sloped nose, turret and gun, three wheels |
| Coins | Coin with a rim and a glint |
| Star | Five-point star |

**Guns.** The guns are side views rotated muzzle-up by `ICON_GUN_TILT`, so the barrel runs along the cell's diagonal.

**Colours.**
- Fills are the weapon or gear colour plus a mid gunmetal (`PALETTE.ui.bossBarShield`). The darker `PALETTE.troop.sniperCoat` is used only for small accents.
- Nothing is near-black any more.
- The railgun rails use `PALETTE.fx.blue`: the pale `WEAPONS.railgun.color` vanished on the pill's light disc, so it now colours the charge between the rails.

**Outline and fit.**
- The outline is 4 design units wide, of which 2 show: about 1.1 px at 18 css px.
- The geometry is scaled by `ICON_FIT`, so the outline stays inside the cell.
- **Nothing is clipped.** Measured in a 64 px render, every icon's alpha bounding box is 48–62 px with no edge pixels. Before, several icons touched the cell edge.

**File:line references.**
- `js/render.js:513-516`: `ICON_STROKE` 3 → 4, plus the new `ICON_SEAM`, `ICON_GUN_TILT` and `ICON_FIT` shape constants.
- `js/render.js:1039-1182`: the `_paintIcon` doc and body.
  - New helpers: `seam()`, and `frame()`, a sub-frame whose outline width compensates for its scale.
  - The global `ICON_FIT` scale is applied at `:1176-1177`.
- Colours come only from `PALETTE`, `WEAPONS` and `GEAR`. There are no new data keys.

### After evidence

**Icon sheet:** `EV/iconsheet-after.png`. It uses the same layout as `iconsheet-before.png`.

**HUD pills in game.** The tool `EV/tools/pills.sh` runs L12. Each run grants three items through `pickups.grantItem`, which drives the real pill, the icon flight and the hint, and screenshots every 1 s.

| Run | Items | Verdict |
|---|---|---|
| a | shotgun, chip, booster | CLEAN |
| b | minigun, armor, magnet | CLEAN |
| c | rocket, sniper, medic | CLEAN |
| d | railgun, flamer, drone | CLEAN |
| e | laser, APC, coins | CLEAN |

- **Before/after montage:** `EV/pills-before-vs-after.png`, with rows before-a, after-a, …, before-e, after-e.
- **Raw shots:** `EV/{before,after}-pills-{a..e}/`.
- **Result.** In the after rows each pill reads as its item at the 20 px the pill now uses:
  - an orange shotgun;
  - yellow-barrelled minigun;
  - rocket;
  - blue forked railgun;
  - cyan ray-gun.

  Before, the pills showed an orange block, a black disc, a pencil, a bolt and a key.
- **Shop:** `EV/after-ui/01-shop.png` and `02-shop-bought.png` (the `--scenario ui` run, CLEAN). The shop shows my coin icon in the header and on every BUY button, and it reads cleanly. The upgrade card pictograms are ui's `CARD_ICON_DRAW`, not mine.

## 2. Boss damage-number cap (`js/fx.js`)

### Problem

**Root cause.** Boss hits merge for `mergeSeconds` (0.12 s ± 35 %), so at any real fire rate one number spawns every ≈ 0.12 s.

- Each number lives `floater.life` 0.7 s. All 2 × 3 = 6 slots of the boss grid stayed full.
- Each new number retired its slot's previous one just as that number finished fading in.
- The result was a six-number stack that churned about 8 times a second.
- **Example.** `EV/crop-before-l5-08-play-8s.png`: "122 / 131 131" stacked on the Spitter Queen, with no story in the totals.

### Change

The cap applies to the boss only. Brutes keep exactly the old behaviour: 3 rows, 0.12 s, and the same code path for `target ≥ 0`.

- **Two rows per side.** `JUICE.damageNumber.bossRows` = 2, so at most 4 live numbers sit on the boss itself.
- **Longer merge window.** The boss accumulator merges for at least `NUMBER_BOSS_WIN` = max(`mergeSeconds`, `floater.life` / 4) = 0.175 s.
- **Jitter only lengthens the window.** So 4 consecutive windows always cover one life (0.7 s), and a slot's number has run its full pop, rise and fade before the slot is reused. It is never retired early.
- **Same total damage.** The totals are simply larger, for example 430 / 349 / 385 instead of 131 / 131 / 122.

**File:line references.**
- `js/fx.js:161-168`: `NUMBER_BOSS_ROWS`, `NUMBER_BOSS_SLOTS` and `NUMBER_BOSS_WIN`, with the rationale comment.
- `js/fx.js:1817`: slot cycling per target kind.
- `js/fx.js:1859-1860`: the row lift uses the target's row count.
- `js/fx.js:1898-1900`: the boss merge window.
- `js/data.js:1287-1289`: `JUICE.damageNumber.bossRows: 2`. One targeted edit to my own key, with a comment.

**ARCH §14.**
- No allocation: three module constants and two ternaries.
- The data read is guarded: `bossRows > 0`, falling back to `bossSlots`.
- No `console.log` and no `Math.random`. The jitter uses `this._rnd`, as before.

### Verification

`EV/tools/bossab.sh` runs `smoke --boss` for 40 s with screenshots every 1 s. The `--after` string does three things:
- forces the minigun and the chip (the highest fire rate);
- sets the squad to C = 165 on L5 and C = 280 on L10;
- adds a 50 ms in-page probe that counts the boss's live numbers. The probe's result is in `report.bot.choices[0]`.

In the table, "mean live (firing)" excludes the samples with 0 live numbers, which are the boss intro.

| Run | Verdict | End | Live boss numbers: max | Mean live (firing) | Numbers / s | Histogram 0…6 |
|---|---|---|---|---|---|---|
| L5 before | CLEAN | won, 157 | **6** | 4.9 | 3.96 | 67,4,2,3,17,75,36 |
| L5 after | CLEAN | won, 157 | **4** | 2.95 | 2.58 | 67,4,11,100,13,0,0 |
| L10 before (rep 1) | CLEAN | won, 228 | **6** | 4.7 | 3.74 | 66,2,2,3,18,78,8 |
| L10 after (rep 1) | CLEAN | won, 228 | **4** | 3.0 | 2.56 | 61,5,9,77,21,0,0 |
| L10 before (rep 2) | CLEAN | won, 228 | **6** | 5.0 | 4.32 | 60,2,3,7,11,47,47 |
| L10 after (rep 2) | CLEAN | won, 228 | **4** | 3.2 | 2.68 | 60,5,3,73,32,0,0 |

- **Outcomes unchanged.** End states and survivors are identical, so the change is cosmetic only.
- **Frames.** The after runs show p99 7.1 ms and worst 7.2–13.8 ms.
  - The before L5 run had a 194.6 ms worst frame. It is not from the old fx code: before and after ran on the same host minutes apart, and no other before run had one.
- **Screenshots.**

  | Before | After |
  |---|---|
  | `EV/before-l5-boss-1/`, crop `EV/crop-before-l5-08-play-8s.png` | `EV/after-l5-boss-1/`, crop `EV/crop-after-l5-08-play-8s.png` |
  | `EV/before-l10-boss-1/`, crops `EV/crop-before-l10-0{6,9}-*.png` | `EV/after-l10-boss-1/`, crops `EV/crop-after-l10-0{6,9}-*.png` |

  After, the numbers sit in two rows on each side of the boss, every one varied and readable ("163 / 212 192", "430 349 / 385").
  - **The top row is lower.** With 2 rows centred on the anchor instead of 3, the top row sits half a row lower, further from the power-up pills it used to touch.

## 3. Docs and static checks

**Docs updated.**
- **GDD §6.1** (hit feedback): the boss's 2-rows-per-side cap and its merge window.
- **ARCH §6.12** (fx paragraph): the boss grid and the merge-window rule.
- **ARCH:** the round-4 data-key line for `JUICE.damageNumber.bossRows`.
- **ARCH §6.3** (TextureFactory `icons` comment): the round-4 pictogram style.

**Static checks.**
- `node --check` passes on `js/fx.js`, `js/render.js` and `js/data.js`.
- `node tools/check-imports.js`: 0 errors, 0 warnings.
- No new `console.log` or `Math.random`.
- No public API change, so `CALLSITES.md` needs no regeneration for my files.

**Smoke runs.** All 18 runs in this pass are CLEAN (10 pill runs, 2 ui runs, 6 boss runs).

**Tools** (in `EV/tools/`):
- `iconsheet.mjs`: the icon sheet and the bounding-box check. Set `GR_ROOT` to the tree to serve.
- `pills.sh`, `bossab.sh`, `crop.ps1`, `montage.ps1`.
- `newpaint.js` and `splice.cjs`: the painter source and its anchor-checked splice into `render.js`.

The `iconsheet.mjs` label "pill box as shipped (28×18 css)" is stale: ui changed the pill to a 20 px icon on a light disc this round.

## needsOtherGroup

1. **ui / css (FYI, no action needed).** The round-4 pill (32 px ring, 22 px light disc, 20 px icon, `css/game.css` `.pu`) is what the new icons were tuned against.
   - The guns now carry mid-tone gunmetal and their weapon colour instead of black, so they keep their contrast on the light disc.
   - If the icon ever goes back onto the bare dark pill, the dark-outline-on-dark case gets weaker. It stays readable (`iconsheet-after.png`, the "hud pill" rows).
2. **ui (optional).** Further legibility would come from a larger icon box (for example a 26 px icon in a 34–36 px ring) rather than more detail. Every icon is drawn as a vector at the requested size (`iconDataURL(id, px)`), so any size stays crisp.
3. **Lead (FYI).** The railgun's in-icon rails use `PALETTE.fx.blue`, not `WEAPONS.railgun.color`, which only colours the charge. The pale weapon colour vanished on the light disc.
   - The pill's ring still uses the weapon colour, so the colour coding holds.
   - The armor shield shares that blue but has a completely different shape.
