# QA round 2 — fixer report, group "enemies" (js/zombies.js, js/boss.js + listed data.js / GDD keys)

| Issue | Status | One line |
|---|---|---|
| ENE-12 (major) brute latches inside the formation | **fixed** | Contact/swing only at the front edge; a flank contact walks to the front first and its ring refills there; 6-swing backstop. L10 brute losses went from 30 to 21 over 14 brutes (max 1 swing each), and endless max swings went from 365 to 6. |
| ENE-13 boss impacts at shin height | **fixed** | `boss:hit` y now spreads over 2.03 to 4.27 m (0.45 to 0.95 × coreY), and x is jittered ±0.48 m inside the capsule. No hits land below 1 m. |
| ENE-14 Queen sacs bloom cream-white / pale blink | **fixed** | Sacs have their own gain (0.5). The Queen's head-sac glow mesh (models names it `eyes`) is now detected as sac by its vertex colour. `flashTint` follows the body hue. |
| ENE-15 glob shadow-depth churn | **fixed** | `zombies.globs` never casts a shadow (the boss globs already did not). The VIS-14 shadowchurn2 run counts 0 re-resolutions in its 15–45 s window. |
| ENE-16 allocations | **partial** | Added `hitTestSeg` (zombies + boss). The per-zombie step is split into small integer-arg stages, the math helpers are inlined into render and step, and the boss globs and zombie bars/globs use permanent update ranges. Steady state is 0 B per call. The 45 s perfprobe run went from 8.65 to 2.78 MB/min, which is still above 1 MB/min: the rest is JIT warm-up and deopts (see below). |
| ENE-17 pause burns theatre timers | **fixed** | Intro, fight start and collapse run on `ctx.time.theatre` (CORE-7). Fight starts 1.66 s after RESUME. The collapse takes its full time after RESUME. t2-boss A/B/F pass. |
| ENE-18 core light over-lights the torso | **partial (deviates from the suggested +1.5 m)** | Intensity is 40 → 20 and the light is offset along the facing by `lightOffsetZ`. The measured +1.5 m painted the Queen's belly orange (#FF8614), so I set it to −1.0 m (just inside the torso, where the forward faces are back-facing to the light). The Colossus belt plate under the core still picks up some warmth. No road brightening can be measured at I = 20 (none could at the old I = 40 either). |
| ENE-19 data hygiene | **fixed** | The 5 boss literals are now `BOSSES.retreatSpeed / gaitRefMs / phaseEntryCool / targetZ / introSparkEvery`. `ZOMBIES.common.introAheadM` is deleted. `grep DATA-MISSING js/boss.js` → none. |

Static checks:
- `node --check` passes for js/zombies.js, js/boss.js and js/data.js.
- `node tools/check-imports.js` → 0 errors, 0 warnings.
- `node tools/callsites.js` was re-run; CALLSITES.md now lists weapons' `hitTestSeg` callers.

Smoke `--scenario all --quality high` is **CLEAN** (report: `docs/build/qa2/fix-enemies/smoke-all/report.json`; the PNGs are kept at `E:/Temp/claude/ene-smoke-all/` because of the disk problem below). Smoke `play --level 15 --boss` is CLEAN too (`impacts15/report.json`).

> **Environment note.** During this session drive C: (the project drive) ran out of space (0–60 MB free, `ENOSPC` killed my first endless run).
> - For that reason I deleted the PNGs of my own perf runs and kept their JSON.
> - Some experiment screenshots live under `E:/Temp/claude/` (ene-final, ene-light, ene-smoke-all).
> - Every pass/fail number below is in a JSON file inside `docs/build/qa2/fix-enemies/`.

---

## ENE-12 — brute contact only at the formation front (fixed)

**Root cause.** The contact test fires anywhere along the formation (`z > CONTACT_Z && intersectsCircle`). A brute touching the flank then kept its z (vz = 0) behind every muzzle while x-homing into the formation. Shooters fire along −Z from the front rows, so it was never on a bullet path.

**Changes**
- **New SoA, constants and flags.**
  - `js/zombies.js:88-90`: new flags `F_FRONT_WALK` (2048), `F_BACKOFF` (4096) and `F_FROZEN` (8192; stagger freeze, set by `_aiBrute` and read by `_contact`).
  - `js/zombies.js:155-158`: `BRUTE_MAX_CONTACT_Z` / `BRUTE_CONTACT_HOMING_Z` / `BRUTE_MAX_SWINGS` from data, plus `BRUTE_BACKOFF_M = 2.0`. That one is a DATA-MISSING literal: "2 m" has no key in my list.
  - New SoA `_swings` (Uint8) and `_backZ` (Float32), allocated in `init()` and reset in `spawn()`.
- **`_contact(s, t)`** (`js/zombies.js:1346`).
  - A brute touching the formation always homes x toward squad x (`contactHoming` 3.5 m/s; 0 while staggered).
  - While `z > maxContactZ` (`:1386`) it walks to the front: vz = −`contactHomingZ` (4 m/s in the squad frame). It sets `F_FRONT_WALK` and never swings. A stagger does not stop the walk, so a holding brute is never behind the front edge.
  - At `z ≤ maxContactZ` it holds (vz = 0).
    - If it arrived by a flank walk, `F_RING_DONE` is cleared and `_aux` reset, so the **0.8 s ring fill restarts at the front** before its first swing there.
    - The swing cooldown is unchanged.
  - **Backstop.** When `_swings ≥ maxSwings` (6), the swing is replaced by `_beginBackoff()` (`:1493`). That gives a flash, a `zombie:stagger`, and a ring reset, and sets `_backZ = z − 2 m`.
    - `_aiBrute` (`:1252`) then walks it back at 4 m/s until it reaches `_backZ`.
    - It re-approaches, the ring re-telegraphs, and it never swings again.
    - It is never removed without being killed.
  - The APC branch uses the same swing counter and backstop.
- **Ring decal.** Decal creation is in `_startRing`, progress and follow in `_ringSync` (`:1477`). Progress is derived from the state (fill, or the cooldown gauge between swings), so it is identical to before.
- **Data** (`js/data.js:308-310`): `ZOMBIES.brute.maxContactZ: -0.3`, `contactHomingZ: 4.0`, `maxSwings: 6`. `contactHoming` stays at 3.5.
- **GDD §6.1 brute row** (`docs/GDD.md:214`): "contacts and swings only at the formation front (z ≤ −0.3 m); a flank contact walks to the front first (4 m/s) and re-fills the ring there; after 6 swings it staggers back 2 m and re-telegraphs instead of swinging".

**Verification**

Command: `camp3.mjs --player passive --only 10|11 --shop none --ranks '{"squad":4,"fireRate":3,"damage":3,"coinMult":5,"bossDamage":3}'`.
- The brute sampler is my own: `docs/build/qa2/fix-enemies/brutesampler.js`. The original bruteprobe sampler was not saved.
  - It records every brute bite (x/z/kills) and every brute death (cause; whether it was touching the formation).
  - It also records the max z while holding (in contact with squad-frame vz 0) and while walking to the front.
- Summaries come from `node docs/build/qa2/fix-enemies/brutesum.cjs <json>`.

| run | brutes | death causes | median lost / brute | max swings | removed by cleanup while latched | max bite z | max latched z | max flank-walk z |
|---|---|---|---|---|---|---|---|---|
| **before** `feel-balance/camp-passive/L10-a1` | 14 | bullet 13, cleanup 1 | 0 (the one swinging brute: 30) | 10 | (the 10-swing brute: cleanup) | – | +2.66 (issue) | – |
| **after** `bruteprobe-10/L10-a1` (complete) | 14 | bullet 12, burn 1, cleanup 1¹ | **0** (7 swinging brutes: 3 each) | **1** | **0** | **−0.36** | **−0.32** | +2.63 (walked to the front) |
| after `bruteprobe-11/L11-a1` | 6 | bullet 3, alive at game over 3 | **3** | 3 | 0 | −0.70 | −0.70 | – |
| after `bruteprobe-11/L11-a2` | 6 | bullet 4, alive 2 | **3** | 3 | 0 | −0.70 | −0.70 | – |
| after `bruteprobe-11/L11-a3` | 14 | bullet 12, explosion 2 | **0** | 4 | 0 | −0.30 | −0.30 | +2.83 (walked to the front) |

¹ The one L10 `cleanup` is brute 223. It died at z = +14.1, not touching the formation, with 0 swings: it passed beside the squad and was recycled behind the camera.

- In L10 the flank case from the issue recurs (walk max z +2.63). The brute walks to the front, refills its ring, swings once and is shot.
- Brute bite losses in L10 went from 30 (one brute) to 21 (7 brutes × 1 swing).

Endless (`camp.mjs --player strong --from 1 --to 0 --endless 1 --maxsec 900 --ranks '{"squad":3,"fireRate":2,"damage":2,"coinMult":4,"bossDamage":2}'` → `fix-enemies/endless/endless-1.json`):
- 151 brutes. **Max swings 6** (before: 365).
- Swing histogram: 0:48, 1:36, 2:15, 3:14, 4:6, 5:6, 6:26.
- Total brute kills 954 in 393 s (before: 2 817). The worst single brute caused 18.
- The 11 `cleanup` brutes all had 0 swings (pass-bys). The 10 `alive` brutes were still alive when the run ended at C = 0.

> **Balance note (not this group's file).** The passive player fails L11 in all three attempts at C ≈ 34.
> - L11 brute HP is now 155–166 (LVL-14 baseline) against C ≈ 34, so each brute gets 1–3 swings before dying; the losses also include spit 30–100 and gate 102.
> - Front brutes behaved as designed: median 3 lost per brute.
> - In endless, 26 of 151 brutes (HP ≈ 1 000–3 100 at C 100–500) reached the 6-swing cap. See needsOtherGroup.

## ENE-13 — boss impact point on the body (fixed)
- `js/boss.js:654-692`. `hitTestSegment` now forwards to the new `hitTestSeg(seg, radius, out)`.
  - The XZ capsule test is unchanged.
  - The cosmetic point is set as follows:
    - `out.y = coreY · lerp(hitYRange[0], hitYRange[1], rngFx)` (`HIT_Y0 / HIT_Y1`, `:60`).
    - `out.x` = the capsule-entry x + (rngFx·2−1)·0.3·radius, clamped to `unit.x ± radius`.
    - `out.z` is the capsule-entry z.
  - The intro sparks use the same y.
- Data: `BOSSES.hitYRange: [0.45, 0.95]` (`js/data.js:455`). `FIRE` is no longer imported in boss.js.
- **Verify, smoke.** `node tools/smoke.js --scenario play --level 15 --boss --seconds 30 --shots 1 --after "g.squad.setCount(400,'debug')" --quality high --out docs/build/qa2/fix-enemies/impacts15` is CLEAN. In `impacts15/07-play-7s.png` the spark bursts spread over the torso band around and below the core (device y ≈ 540–660); none sit at the feet.
- **Verify, numbers.** From `fix-enemies/bossshot.mjs`, which records every `boss:hit` during a fight:

| level | hits | y min | p10 | p50 | p90 | y max | below 1 m | x − boss.x |
|---|---|---|---|---|---|---|---|---|
| L5 | 554 | 2.03 | 2.26 | 3.12 | 4.03 | 4.27 | 0 | −1.54 to 1.60 |
| L15 | 363 | 2.03 | 2.28 | 3.23 | 4.05 | 4.26 | 0 | −1.60 to 1.45 |

  Data files: `light/L5-bossshot.json` and `light/L15-bossshot.json`.

## ENE-14 — Queen sacs keep the acid green (fixed)
- **Sac gain** (`js/boss.js:1671`): `k = glowSac[i] ? sacK · SAC_GAIN : 1`, with `BOSSES.anim.sacGain: 0.5` (`js/data.js:494`). The eyes stay at 1.5. `sacPulseMin` / `sacPulseMax` are unchanged (0.55 / 1.1), so the peak is 0.5 × 1.1 × 1.5 = 0.83 × #C7E84B in linear, below the 0.85 bloom threshold.
- **Second root cause, found while verifying.** models.js names the head glow child `eyes`, and on the Queen that mesh holds only the head sacs. `fix-enemies/rigglow.mjs` shows that every vertex of the Queen's `eyes` mesh is (0.57, 0.81, 0.07), the sac colour. The other bosses' eyes are (1, 0.75, 0.07). So with name-only classification the two big head sacs stayed at 1.5 and kept blooming cream.
  - The fix is `isSacGlow()` (`js/boss.js:156`, used at `:350`, init only): a glow piece is a sac if it is not `eyes`, **or** if all its vertex colours are `PALETTE.zombie.spitter.sacs`.
  - After the fix the Queen's glowSac is `[1]`; hulk, juggernaut and colossus stay `[0]`.
- **Hit blink.** Holding the flash at its peak (`unit.hitT` pinned) turned the Queen's torso a pale khaki #B3A06E with the old warm tint 0xFFD9B0. The cause is a peach emissive added on top of a dark green albedo.
  - `BOSSES.anim.flashTint` → **0x9ED68E** (= `PALETTE.boss.skin` × 2, `js/data.js:487`).
  - The blink is now a brighter green, with no whitish frame.
- **Verify** (`fix-enemies/bossshot.mjs --level 5 --count 190 --noblink`; the shots are copied into `light/`).

  | sample (`light/L5-fight-*`) | colour | G − B | luma (709) |
  |---|---|---|---|
  | arm sacs, on two frames | #B5C634 / #C1D048 | 146 / 136 | 184 / 195 |
  | head sacs (formerly cream #EEEEB0 / #F3F1BD, luma 234–238) | #A7BA2C / #ACBE2F | 142 / 143 | 172 / 176 |
  | belly-flank sacs | #A1CF46 | 137 | 187 |

  All sac samples pass G − B > 80 and luma < 200. In `light/L5-fight-1.png`, every sac on the head, belly and arms reads acid green.

  Blink frames hold the body hue:

  | blink frame | samples |
  |---|---|
  | L5 (`light/L5-blink-0.png`) | torso #5E894C, #709255, #518247, #52844A |
  | L15 (`light/L15-blink-0.png`) | #5F7F42, #627F42, #5C8447 |

  The L15 belt plate below the core is #AD9357. It is lit warm by the core light; see ENE-18.

## ENE-15 — glob shadows (fixed)
- `js/zombies.js:420` (init) and `:540` (`_applyQuality`): `zombies.globs` sets `castShadow = false` permanently. The arc-preview decal already shows the landing.
- `boss.globs` was already `castShadow = false` (`js/boss.js` `_initGlobs`).
- **Verify.** I re-ran the VIS-14 command with `--out docs/build/qa2/fix-enemies/shadowchurn2` (`throttle.mjs --rate 1 --level 9 --quality med --seconds 50 --after shadowchurn2.js`). The console line is `SHADOWCHURN {"frames":4238,"counts":{}}`: zero re-resolutions of any caster in the 15–45 s window (log: `fix-enemies/shadowchurn2.log`). Before, zombies.globs was part of the 1 865.

## ENE-16 — allocations (partial)

**Changes**

1. **New queries `hitTestSeg(seg, radius, out)`.**
   - `js/zombies.js:789` and `js/boss.js:665`. They read `seg = Float64Array(4) [x0, z0, x1, z1]` and have the same semantics and `out` shape.
   - `hitTestSegment` stays and forwards through a module `Float64Array` (`SEG_Q` / `SEG_B`).
   - The zombie query is fully inlined: bin math, the crawler `hittableZ` rule, and typed `RADIUS` / `HEIGHT` tables (`:161`).
   - weapons.js already calls them (CALLSITES.md: weapons.js:984/987/1247/1259/1265/1564).
2. **Zombies hot loops.**
   - `step()` no longer passes `dt` per zombie (`this._dt`).
   - `_stepAlive(s, t)` (`:1176`) is a dispatcher over small integer-argument stages: `_aiWalker / _aiRunner / _aiCrawler / _aiBrute / _aiSpitter → _contact → _integrate` (`:1187-1470`).
     - The AI writes the desired velocity into the `_vx` / `_vz` typed arrays.
     - clamp, lerpExp, yawToward, wrapAngle and binOf are written inline.
     - The facing uses `atan(vx/fwd) ± π` and wrap loops instead of `Math.atan2` and float `%`.
     - The five differently-shaped `DEF` objects are replaced in the hot path by typed `SPEED / BITE / XMAX`.
     - The contact and decal queries read the slot themselves (`_touchesSquad`, `_touchesApc` (pre-filtered by `troops.apcPool > 0`), `_ringSync`).
   - `render()` (`:1653`) writes the instance matrices inline, equivalent to `CharacterInstances.writeMatrix` with roll 0 and scale 1 (its own doc allows owners to write `instanceMatrix` directly). The HP-bar TRS, the glob tumble, `ease.outBack` and `setDeath` (`attrs.iState`) are inlined too.
   - The now-unused helpers (`wrapAngle`, `yawToward`, `writeTRS`, `writeTumble`) and imports (`lerpExp`, `ease`) are removed.
3. **Permanent update ranges.**
   - Boss globs: the instanceMatrix gets one `_grRange` record and `clearUpdateRanges = keepUpdateRanges` (`js/boss.js:118, 464, 1724`); nothing is pushed per frame.
   - The zombie HP bars and globs use the same pattern (`tagRange`, `js/zombies.js:249-262`).

**Verification**

The probe command: `node docs/build/qa/perf/perfprobe.mjs --level 9 --quality high --seconds 45 --after "g.squad.setCount(600,'debug')" --heapprof --out docs/build/qa2/fix-enemies/heap-l9`. Summaries come from `node docs/build/qa2/fix-enemies/allocsum.cjs <perf.json>`.

| run | zombies.js | boss.js | top sites |
|---|---|---|---|
| before, `heap-l9-before` (same command, start of session) | 6 763 KB / 45.8 s = **8.65 MB/min** | – | render 3 746, `_stepAlive` 2 560, `hitTestSegment` 457 |
| after, `heap-l9` | 2 195 KB / 46.3 s = **2.78 MB/min** | 0 (no boss in 45 s) | render 957, `_integrate` 589, `hitTestSeg` 272, `_aiRunner` 200, `_aiBrute` 176 |
| after, late window (`optstat.mjs --warm 50 --seconds 80`: heap sampling 50–80 s of the same L9 / 600 setup) | 326 KB / 30 s = **0.64 MB/min** | – | render 246 |
| after, boss fight (`heap-l15boss`: perfprobe L15 `--boss`, 400 soldiers, 37 s) | 2.63 MB/min | 9.14 MB/min | `_renderUnit` 3 281, `hitTestSeg` 1 346 |

**Steady state is allocation-free.** `fix-enemies/microalloc.mjs` pauses the game with live zombies or a boss, warms each function up, then samples the heap over 20 000 calls:

| function | B/call, default tiers | B/call, `--no-turbofan` (Maglev only) |
|---|---|---|
| `zombies.render` | 0 | 0 |
| `zombies.hitTestSeg` | 0.03 | 0.24 |
| `_integrate` | – | 0.03 |
| `_aiWalker`, `_aiRunner`, `_aiCrawler`, `_aiBrute`, `_aiSpitter`, `_contact`, `_stepAlive` | – | 0 |
| `boss.render` | 0 | – |
| `boss.hitTestSeg` | 0 | – |

**Why the 45 s number is still above 1 MB/min.**
- `fix-enemies/tierline.mjs` samples the V8 tier every 0.5 s with `%GetOptimizationStatus`. The enum was decoded empirically: 41 = TurboFan, 25 = Maglev.
- The per-zombie functions spend the first 10–30 s of a level in Sparkplug (baseline) or Maglev, with deopt blips back to baseline whenever a new branch is first taken (a new type, a first death, a first bite).
- Baseline code boxes every double.
- The boss code only runs for about 30 s per level, so its in-run number is almost all warm-up.
- I don't think the remaining warm-up allocation can be removed from these two files. The steady-state requirement (GDD §16) is met.
- The 45 s perfprobe gate fails (2.78 MB/min, threshold 1); the steady-state rate after warm-up passes (0.64 MB/min in the 50–80 s window).

## ENE-17 — theatre clock (fixed)
- `theatreNow(time)` (`js/boss.js:121`) returns `ctx.time.theatre` (CORE-7, which has landed in engine.js), falling back to `time.now`.
- It is used for:
  - `_introAt` / `_fightAt` in `spawn()` (`:569`);
  - `skipIntro` (`:617`);
  - the fight-start check in `step()` (`:993`);
  - `unit.deathAt` (`:891`);
  - the collapse clock in `render()` (`:1524`).
- The header comment is updated.
- **Verify with visboss.** I copied `mobile/{lib.mjs,visboss.mjs}` to `fix-enemies/` and added timing of the fight start and collapse after RESUME (`fix-enemies/visboss/iphone14/visboss.json`):

  | check | result |
  |---|---|
  | `introHidden` / `introVisible` | state paused, theatre clock frozen (17 845 → 17 845) |
  | `introResumed` | **intro:true**, locked, namecard up |
  | `fightStartMsAfterResume` | **1 655 ms** (expected about 1.7 s) |
  | death hide | unit state 2 (dying) held through the pause |
  | `collapseDoneMsAfterResume` | **2 344 ms**: the full 1.8 s collapse + 0.6 s sink ran after RESUME |
  | final | state complete |
- **Verify with t2-boss.** I copied `edge-cases/t2-boss.mjs` (+ its lib as `edgelib.mjs`) → `fix-enemies/t2-boss/report.json` + PNGs.
  - **A pass.** After a 4 s pause in the intro, `inIntro` stays true through the next 1.05 s of samples. The boss walks in from z −39.7 → −26.7 (it no longer starts the fight at −39.5).
  - **B pass.** Paused in the death slow-mo, the state stays paused/won for 3 s. The slow-mo resumes from 0.92 after RESUME.
  - **F pass.** With the tab hidden during the death, it stays paused and resumes with the slow-mo remaining.
  - The letterbox/namecard left on the title in case E belong to ui (UI-28).

## ENE-18 — boss core light (partial, deliberate deviation)
- **Changes.**
  - `js/boss.js:1695-1696`: the light is offset by `BOSSES.anim.lightOffsetZ` along the rig facing (`sin(yaw)`, `cos(yaw)`).
  - Data (`js/data.js:488-489`): `lightIntensity` 40 → **20**, and new `lightOffsetZ` **−1.0**.
- **Why −1.0, not +1.5.** The core sits on the torso's front surface, so a light in front of it lights every forward-facing torso face nearby. The light casts no shadow (render.js `bossCore.castShadow = false`), so 1 m inside the torso those faces are back-facing to it. I measured with `bossshot.mjs --noblink` (6 shots, median), monkey-patching the light (screenshots in `E:/Temp/claude/ene-light/`):

| config | L5 Queen belly below the core | L5 chest above the core | L15 panels beside the core | L15 above the core | L15 belt below the core |
|---|---|---|---|---|---|
| no light | #121B0E (body) | #081209 | #010100 | #121709 | #1E160F |
| old: at the core, I = 20 (40 is worse) | #0E180E | #2C1E0B | **#791C02 / #7A0200** (the complaint) | #241407 | **#822914** |
| +1.5 m, I = 20 (the issue's suggestion) | **#FF8614** | **#751A00** | #1D0200 | **#942600** | #4F1D11 |
| **−1.0 m, I = 20 (chosen)** | #10190E | #1D1A09 | #200000 | #201909 | **#7D2F16** |

- **Final run** (`light/L5-bossshot.json`, `light/L15-bossshot.json`; `light/L5-fight-1.png`, `light/L15-fight-1.png`):
  - The Queen's torso keeps its greens: #1A2010, #4A4A25, #0D170D.
  - The Colossus panels beside the core are dark, #150100, instead of the old orange-red. The chest above is #14180A.
  - The **Colossus belt plate under the core still turns warm (#712A14)**, because it protrudes in front of the light.
  - **The road in front of the boss shows no measurable warm pickup** at I = 20. The road samples at x ± 2.2 m, z + 5 m read #120D0E–#29241B, the same as with no light. That was also true of the old I = 40 light.
- If visual/lead prefers the literal "+1.5 m in front", set `lightOffsetZ: 1.5` in data.js; no code change is needed. Expect the Queen's belly and both chests to turn orange.

## ENE-19 — data hygiene (fixed)
- `js/boss.js:52-57`: the module aliases now read `BOSSES.retreatSpeed / gaitRefMs / phaseEntryCool / targetZ / introSparkEvery`, added at `js/data.js:469-473` with the same values (3.0 / 3.0 / 1.0 / −1.0 / 0.1).
  - `gaitRefMs` sits directly on `BOSSES`, per the key list (the old comment said `BOSSES.anim.gaitRefMs`).
- `ZOMBIES.common.introAheadM` is deleted from data.js. A grep shows no reader anywhere in js/ or tools/; levelgen reads `LEVELS.curve.introAheadM`.
- **Verify.**
  - `grep -n DATA-MISSING js/boss.js` → no matches.
  - check-imports passes.
  - Smoke `--scenario all` is CLEAN.
  - The boss runs (visboss, t2-boss, impacts15, bossshot L5/L15) behave as before apart from the intended changes.

---

## Public API / interface changes (for docs/ARCHITECTURE.md — not my file)
- `Zombies.hitTestSeg(seg: Float64Array(4), radius, out): boolean` and `BossSystem.hitTestSeg(seg, radius, out): boolean`. These are new and additive; `hitTestSegment` is unchanged.
- **`boss.hitTestSegment` / `hitTestSeg` `out.x` / `out.y` are now cosmetic impact points.** y is in [0.45, 0.95]·coreY and x is jittered within ±0.3·radius inside the capsule. `out.z` and `out.t` are unchanged.
- **Zombie contact rule (ARCH §6.7 / §7 table).** Brutes contact and swing only at the formation front (z ≤ `ZOMBIES.brute.maxContactZ`). A flank contact walks to the front first. After `maxSwings` swings the brute backs off 2 m instead of swinging.
- **Boss theatre timers (ARCH §6.8)** now run on `ctx.time.theatre` (fallback `ctx.time.now`). ARCH still says "All intro timers are real-time deadlines on `ctx.time.now`".

## needsOtherGroup
1. **docs/ARCHITECTURE.md (lead / docs owner):**
   - **§6.7 Zombies.** Add `hitTestSeg(seg, radius, out)` next to `hitTestSegment`. Amend the contact sentence: "brutes … `swing.cooldown` at the formation front only (z ≤ `ZOMBIES.brute.maxContactZ`); a flank contact walks to the front at `contactHomingZ` and re-telegraphs; after `maxSwings` swings the brute staggers back 2 m instead of swinging".
   - **§6.8 Boss.**
     - Add `hitTestSeg(seg, radius, out)` and note that the out x/y are cosmetic (`BOSSES.hitYRange`).
     - Replace "All intro timers are real-time deadlines on `ctx.time.now`" with "theatre deadlines on `ctx.time.theatre` (CORE-7)".
     - Replace "collapse `death.collapse` 1.8 s real time" with "theatre time".
     - Note that the core light sits `BOSSES.anim.lightOffsetZ` along the facing.
2. **data.js key for the backstop distance.** `js/zombies.js:158` keeps `BRUTE_BACKOFF_M = 2.0` as `DATA-MISSING: ZOMBIES.brute.backoffM`, because the key was not in my list. Whoever owns the remaining zombies DATA-MISSING literals should add `ZOMBIES.brute.backoffM: 2.0` and replace the literal.
3. **LVL (balance) — L11 brute HP.**
   - With the LVL-14 baseline, L11 brutes arrive with HP 155–166 at C ≈ 34. The passive player fails L11 in all 3 attempts: C → 0 at about 40 s, losing bite 40–60 (brutes 24–27) plus spit 30–100 and gate 102.
   - In the round-2 feel-balance run before LVL-14, the same player cleared L11.
   - Endless brutes (HP 1 000–3 100 at C 100–500) hit the new 6-swing cap 26 times out of 151.
   - These are HP-curve issues, not the contact rule: front brutes cost a median of 3 soldiers each.
   - Evidence: `fix-enemies/bruteprobe-11/L11-a*.json`, `fix-enemies/endless/endless-1.json`.
4. **weapons (WPN-9).** `boss.hitTestSeg` now returns `out.y` ∈ [2.0, 4.3] m. Boss-aimed tracers should end at `OUT_B.y` rather than `FIRE.bullet.y`; please check against `impacts15/*.png`, where the sparks now sit on the torso band. The laser and rail calls pass `BOSSES.coreY` themselves and are unaffected.
5. **visual (optional, ENE-18 follow-up).** If a visible warm pool on the road in front of the boss is wanted, intensity 20 at the core height is not enough at any offset I tried (−1…+4.5 m).
   - The likely lever is lowering the light toward the road; I did not measure this reliably, because tracers polluted the road samples.
   - That needs a height key or a render-side light-distance change, neither of which is mine.
