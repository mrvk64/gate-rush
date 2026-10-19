# QA round 2 — fixer "characters" report

Files edited: `js/models.js`, `js/squad.js`, `js/troops.js`. Targeted edits: `js/data.js` (TROOPS.drone.hover, TROOPS.anim.droneSideX (new), TROOPS.sniper.scale, TROOPS.sniper.crateH, TROOPS.apc.ahead, TROOPS.flamer.dps), `docs/GDD.md` §8.3, `docs/ARCHITECTURE.md` §5.1 and §6.5.
Evidence is under `docs/build/qa2/fix-characters/`. All probe and experiment scripts are in that folder.

Gates (final code): `node --check` passes on every edited file. `node tools/check-imports.js` reports 0 errors and 0 warnings. `node tools/callsites.js` regenerated CALLSITES.md. `node tools/smoke.js --scenario all` is **CLEAN** (`all/report.json`: 0 page errors, 0 failed requests, no warnings).

| Issue | Status |
|---|---|
| CHR-9 troops crowd the squad and the label | **fixed** (the APC still sits behind the label; see note) |
| CHR-10 dead squad revived by a + gate | **fixed** |
| CHR-11 boss draw calls > 50 | **fixed** (twins fight max 57 → 44) |
| CHR-12 flamer overtuned | **fixed** (burn kill share 64–78 % → 6–11 %) |
| CHR-13 squad allocations | **fixed** (squad.js about 17.6 → 0.36 MB/min) |
| CHR-14 troop:fire y and stale ARCH | **fixed** |

---

## CHR-9 (major) — props hide the squad and the label: **fixed**

Changes:
- **Drone**
  - `js/data.js` `TROOPS.drone.hover` 3 → **5.2 m**.
  - New key `TROOPS.anim.droneSideX` = **1.2 m**. The troops.js literal now reads this key.
  - `js/troops.js` ANIM: new `droneAhead` 2.5 m and `droneMaxX` = steerRange + 0.7 (:69-70). The target is set in `_computeTarget` (:659-661): x = squadX + 1.2 (capped at +2.8), y = 5.2, z = centerZ − 2.5.
  - I tested the issue's suggestion (4.6 m up, 2.2 m to the side) first. It pushed the 150 px wide rotors off the right edge of the 390 px view at every count (sweep row "OFFSCREEN").
- **Sniper**
  - The perch is now the **left flank at mid-depth** (`troops.js:638-642`): x = squadX − (halfWidth + 0.8), floored at −3.1 m (`sniperMinX`), z = centerZ.
  - The rear-left corner the issue suggested sits below the screen edge once the blob is large (rect bottom 1019–1027 px at V = 200).
  - `TROOPS.sniper.scale` 1.4 → **1.05** and `TROOPS.sniper.crateH` 0.5 → **0.25**.
  - `models.js`: lower, narrower perch (`DIMS.troopExtras`, :383; `buildSniperCrate` :1198): pallet 0.2 → 0.1 m, crate 0.9 → 0.62 m, pallet 0.98 → 0.7 m, ring ×1.4 → ×1.1.
  - Even with the issue's scale 1.15 and crate 0.3, the perch measured 1.43× in world height and 1.75× on screen.
  - The unused `sniperRearMargin` literal was removed from troops.js. `TROOPS.anim.sniperRearMargin` is now unused in data.
- **APC**
  - `TROOPS.apc.ahead` 2.5 → **3.5 m**. The hit box is unchanged: `apcIntersects` still uses width × length, and the mesh scale is 1.
- **Docs**
  - GDD §8.3 Position column amended (sniper, drone, APC).

Verification (`troopsweep.mjs`, built from the visual-2 probe and `m_troops.js`, extended in `m_troops2.js`):
- **How it measures.** L13 with all five troops. C = 5 / 60 / 200 / 1500. Steer at 0, −2.1 and +2.1.
- **Rectangles.** Rectangles are vertex-accurate projections. Bounding boxes overstate thin, deep parts such as the sniper rifle and the flat ground ring. The bbox numbers are also in `sweep-final-*/sweep.json`.
- **Results** (`sweep-final.txt`):
  - **Drone.** Never intersects the label rect and is fully on screen in all 12 cases. Example at C = 60: drone [211,332]–[325,374] vs label [158,473]–[232,535]. Before: [200,548]–[333,625], over the label.
  - **Sniper.** Never intersects the label and is fully inside 844 px in all 12 cases (bottom ≤ 777). Sniper plus crate is **1.23–1.31×** the probe's soldier column (`sniperVtxVsColumn`). Before: 253 px, about 2.8×, bottom at 849.
  - **APC.** It no longer covers the front rows: its bottom edge is at 605 / 522 / 471 px, above the flamer's head and the front-row heads at 627 / 537 / 475 px. Before, the APC bottom was at 641, over the front rows.
- **Note on the APC and the label.** The label (renderOrder 42, depthTest off) still draws over the APC's rear deck at every count. Clearing it entirely would need `ahead` of 4.8 m at V = 5 and 9.3 m at V = 200 (`zClear` in the sweep), because the label sits about 3 m up at z = 0.8. I kept 3.5 m. The label stays readable over the dark hull (`troops14/*.png`).
- **Note on medic and flamer.** They still touch the label rect by 2–20 px at C = 5. With a 1-digit label over a 5-soldier blob, the blob itself is under the label.
- **Specified smoke run.** `node tools/smoke.js --scenario play --level 14 --seconds 20 --shots 2 --after "...add all five..." --out .../troops14` → **CLEAN**. In every shot the squad and its count are visible. The sniper stands beside the blob, the drone sits ahead-right above the road, and the APC is ahead of the front rows (e.g. `troops14/07-play-13s.png`).

## CHR-10 (major) — dead squad revived by a + gate: **fixed**

Changes in `js/squad.js`:
- A `_dead` flag (constructor :291).
- It is set in `_emitDead` (:804) and cleared in `reset()` (:426).
- `setCount(n > 0)` clears it (:596), so `setCount(n,'debug')` still works for QA hooks.
- `addSoldiers` returns early while dead (:609). This covers the medic, the level 'assist' and gate additions.
- `applyGate` returns `{ before: 0, after: 0 }` while dead, with no events and no invulnerability (:674).

Verification:
- **t5 edge test.** Copy at `fix-characters/t5-squad.mjs` (output in `t5-squad/`).
  - Squad killed 0.6 s and 0.15 s before a +20 pass: count stays **0**, `squad:dead` → gameover, and there is no `squad:count` after the death.
  - C = 1 through ÷ and −: still 1. C = 9999 through x5: still 9999.
- **Direct check** (`chr10-direct.json`). After death, `applyGate('+',22)` returned `{0,0}`. `addSoldiers(5,'medic')` left the count at 0, and invulnerable stayed false.
- `--scenario all` is CLEAN.

## CHR-11 (minor) — boss draw calls over 50: **fixed**

Root cause detail: the rig was already merged per part, one mesh per joint. A Hulk was 13 draws (7 joint meshes, eyes, core and 4 plates), so twins were 26.

Change (`js/models.js`, `skinRig` :2387, called from `BossRigFactory.build` :2629):
- **Joints become Bones.** The seven animated joints (legL, legR, torso, armL, armR, head, jaw) become **Bones** with the same names, origins, rest transforms and children.
- **One skinned body.** Their geometry is baked at the rest pose into **one SkinnedMesh `skin`**, rigidly weighted (weight 1 to the part's bone). The glow children become SkinnedMesh **`eyes`** (head glow) and **`glow`** (every other glow, the Queen's sacs). All three share one Skeleton.
- **Unchanged pieces.** Core, plate0–3, chains and shield stay separate meshes under their bones. `getObjectByName` and the rig contract (named children, joint origins, `userData.rig`) are unchanged; `rig.skin` and `rig.skeleton` are added.
- **Shadows.** The merged body always casts: `castShadow` is locked to true on `skin`, because boss.js picks shadow casters by part name.
- **Draws per rig.** Hulk / Juggernaut 13 → **7**, Queen 14 → **8**, Colossus 16 → **10** (`rigcount.mjs`).

Verification:
- **Pose equivalence** (`skincheck.mjs`). The old per-part rig (round-1 models.js, copied as `models.preskin.mjs`) and the skinned rig were posed the same way: every joint rotated, head scaled, group moved and rotated. For all 6 archetypes, all body and glow vertices match to 1 mm (0 unmatched) and the bounding boxes are identical.
- **Specified probe run** (`calls-l17`, CLEAN). The last `QA|calls` line:
  - `bossIntro:boss` main max **41** (was 54), 0 frames over 50.
  - `boss:boss` main max **44** (was 57), **0 of 2709 frames over 50** (was 586 of 1149).
  - Shadow 13 (was 17).
- **Screenshots.**
  - `calls-l17/02-play-9s.png`: the twins with car-door shield, jaw, eyes and core.
  - `boss-l5`: Spitter Queen with pulsing sacs. `boss-l10`: Juggernaut. `boss-l15`: Colossus. `boss-l20`: Colossus Prime with its chains.
  - All look as before.
  - `boss-l10` and `boss-l15` show a "NUMBER_BOSS_LIVE is not defined" overlay. That was js/fx.js caught mid-edit by the fx fixer; it was gone minutes later, and `--scenario all` is CLEAN.

## CHR-12 (minor) — flamer overtuned: **fixed**

Root cause detail:
- **Lowering DPS alone fixed nothing.** Baseline with the flamer forced on L8–12 (`flamer-before-forced`): burn share of combat kills **78 / 76 / 69 / 67 / 64 %**. At dps 5 (`flamer-forced-dps5`) it was still 66–76 %. At dps 1.5 (`flamer-forced-dps1.5`) it was still 44–58 %.
- **Why.** The cone ticks lethal damage every step on every zombie in front. It lands most last hits, including on zombies that bullets cannot reach because the columns fire straight ahead.

Change:
- **Non-lethal cone.** The cone damage moved into the shared zombie scan (`troops.js` `scanZombie` :179; `_stepFlamer` :779). It never takes a zombie below `ANIM.flamerHpFloor` = **25 %** of its base HP (`ZOMBIES[type].baseHp · hz`). It still sets everything in reach burning (+20 % bullet damage).
- **Jet.**
  - It now damages only its one target.
  - It stays lethal against spitters and brutes holding at range.
  - It is floored for any other target.
  - Cadence 0.5 → **1.0 s**, share 0.6 → **0.5**.
- **Data.** `TROOPS.flamer.dps` 15 → **6**.
- **Attribution.** Kills keep cause `'burn'`. Bullets that finish a burning zombie count as `'bullet'`.
- **Docs.** GDD §8.3 flamer row amended.

Verification:
- **Specified run.** `node docs/build/qa2/feel-balance/camp.mjs --player strong --from 8 --to 12 --out docs/build/qa2/fix-characters/flamer`: all 5 levels complete (3/2/2/3/3 stars). The flamer only appears on L8 and L12 by pickup. Burn share: L8 **5.5 %**, L12 **5.0 %**.
- **Forced run** (`flamer-forced`, using the `--after` hook `flamer-after.js`, which also logs per-wave burns). Burn share of combat kills **8.1 / 10.6 / 10.3 / 7.0 / 6.1 %**, ≤ 30 % everywhere.
- **Engagement per wave.** The flamer set zombies burning in **12/18, 14/18, 12/15, 20/23, 21/23** waves. The waves it misses are the same early 1–4-zombie bursts that bullets kill beyond 13 m in every run. The dps-5 run (`flamer-forced-dps5`) shows the same misses, so they are out of its reach.
- **Balance side effect (for feel-balance).** Squad bite losses rose: the forced run had 4–24 bite deaths per level against 0–3 at dps 15, and forced L10 failed once at 67 % (bite 47, from a 45-soldier squad). The as-specified run clears L8–L12.

## CHR-13 (minor) — squad.render / squad.step allocations: **fixed**

Root cause detail:
- **Inline matrix write.** The per-soldier `_writeMatrix` call boxed its doubles. Inlining it alone cut render from 10.2 MB to 2.2 MB per 46 s.
- **The rest came from deoptimisation.** V8 deopt logs (`allocexp.mjs` with V8LOG) showed step and render repeatedly deoptimised. One cause was `dependent prototype chain changed`, which hits fx, zombies and squad together about every 2–10 s. Another was first-use type feedback. While deoptimised, the 300-soldier loops run unoptimised, where every double is a heap allocation.

Change (`js/squad.js`):
- The per-step scalars (clock, squadX, vx, roll, invulnerability, lane x, coast, settle time) moved into one `Float64Array` `_s` (:78).
- The whole numeric step (steering, invulnerability, record motion, world mirrors) runs in the module function `stepCore` (:114). The per-soldier render pass (spawn, topple, dissolve, inline TRS) runs in `writeInstances` (:188). Both take typed arrays and numbers only, with no getters and no prototype lookups.
- `warmHotPaths` (:238) runs them over a synthetic formation in `init()`, so V8's optimised code already covers every branch.
- `_writeMatrix`, the THREE scratch objects and the THREE import were removed. `matcheck.mjs` shows the inline TRS equals `Matrix4.compose` ('YXZ') to 1e-15.
- Behaviour change: a pending reconciliation now runs at the end of `step` (after the record motion) instead of before it, a 16 ms shift.

Verification:
- **Specified run.** perfprobe `--level 9 --quality high --seconds 45 --after "g.squad.setCount(600,'debug')" --heapprof --out .../heap-l9`.
  - squad.js total: **288 KB / 46 s = 0.36 MB/min**. Before: render 10 199 KB + step 3 369 KB + shooterPosition 168 KB ≈ 17.6 MB/min.
  - Only `shooterPosition` (148 KB) and `nearestSoldierIndex` (140 KB) remain. These are public queries called by weapons and zombies.
  - Whole-game churn: 3.43 → 1.85 MB/s.
- **Micro test** (`microalloc.mjs`, game paused, 3000 calls): step plus stepCore about 11 B per call, render 0–8 B per call (the 8 B is `CharacterInstances.commit`).

## CHR-14 (polish) — troop:fire y; stale ARCH: **fixed**

Changes:
- **Payload.** `P_FIRE` gains `y` (`troops.js`). The sniper sets `y = V_B.y`, its muzzle world y (:733).
- **New drone event.** The drone now also emits `troop:fire { id:'troop.drone', x, y, z, tx, tz }` per shot, with `y` = the gun under its body (:909). fx ignores non-sniper ids today; this is the origin FX-13 can use.
- **ARCH §5.1.** The `troop:fire` row documents both emitters and `y`. The "Who listens" paragraph now lists squad's gear:start, gear:end, armor:change and level:start listeners.
- **ARCH §6.5.** Documents the CHR-10 dead rules (applyGate and addSoldiers), the hot-pass structure and the end-of-step reconciliation. The listener list and the troop child names ('wheels', 'discs', §6.4) were already current.

Verification: `node tools/callsites.js` ran; `--scenario all` is CLEAN.

---

## needsOtherGroup

1. **fx (js/fx.js), FX-13.** Draw the sniper beam from `p.y` (`troop:fire`) instead of `TROOPS.sniper.crateH + FIRE.muzzleOffset[1]` (`_onTroopFire`, about fx.js:2599). Once `TROOPS.sniper.crateH` was lowered to 0.25 and the pallet and scale changed, that formula sits about 0.3 m low. `troop:fire` now also fires for `'troop.drone'`; keep `_onTroopFire` filtering by id.
2. **boss (js/boss.js).** Add `'skin'` to `SHADOW_PARTS` (boss.js:99). Then models.js can drop its `lockCastShadow` on the merged body. The twins' per-part castShadow toggles (boss.js:530-532) now act on Bones and have no effect: a twin casts one shadow draw for its whole body (fight shadow 17 → 13).
3. **ARCHITECTURE §6.4 (not mine).** buildBossRig's named joints torso, head, jaw, armL, armR, legL and legR are now `THREE.Bone`s of one SkinnedMesh `'skin'`. There are also SkinnedMeshes `'eyes'` and `'glow'`, plus `rig.skin` and `rig.skeleton`. Core, plate0–3, chain0–1 and shield are unchanged Meshes.
4. **ARCHITECTURE §6.6 (not mine).** Make these updates:
   - `apcIntersects` comment "2.4 × 3.4 m box 2.5 m ahead" → 3.5 m.
   - Sniper perch: left flank at mid-depth.
   - Drone: 5.2 m up, 1.2 m right, 2.5 m ahead.
   - Flamer: non-lethal cone with HP floor 25 %; the jet damages one target and is lethal only vs spitters / brutes.
   - Sniper `troop:fire` payload: add `y` (§6.6 still says `{ id, x, z, tx, tz }`).
5. **perf / fx / zombies.** About every 2–10 s during play, V8 logs `dependent prototype chain changed` deopts across fx.js (_writeRow, _writeLabel, …), zombies.js:1134 and squad getters at the same instant. Something mutates a prototype or a prototype-chain object at runtime. `protohunt.mjs` found no Object.create, setPrototypeOf or defineProperty calls during play, so look at three.js objects or lazily added class or static properties. Each such deopt makes every hot loop run unoptimised (allocating) until it re-optimises. squad.js is now immune; other modules are not. Reproduce: `V8LOG=<abs path> node docs/build/qa2/fix-characters/allocexp.mjs 9 600 20 high trace`.
6. **feel-balance (data / level).** With the flamer support-only (CHR-12), bite losses are higher than in the round-1 numbers whenever the flamer is present. Re-check L10 and L11 margins for weak players.
7. **data.js cleanup (owner of TROOPS.anim).** `TROOPS.anim.sniperRearMargin` is unused now. Apart from the new `droneSideX`, troops.js still keeps its local ANIM literals rather than reading TROOPS.anim.
