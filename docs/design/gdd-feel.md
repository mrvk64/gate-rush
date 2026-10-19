# GATE RUSH — Game Design Document: Ad-Faithful Game Feel

Angle: reconstruct the exact moment-to-moment experience of the "fake ad" gate runner and make it real. Every number below is a tuning default to be placed in a single `config.js`; nothing is decorative. Units: meters (m), seconds (s), meters per second (m/s). The road's forward axis is -Z (toward the horizon); the squad sits at z = 0 in squad-local space and the world scrolls past it.

---

## 1. The ad, reconstructed second by second

The ad that converts has one rhythm: **see a number → shoot it bigger → walk through it → watch your crowd swell → crowd gets eaten a little → repeat → giant thing at the end dies dramatically.** The loop period is 12–15 s. The whole 30 s ad is two loops and a boss. Our level 1 is literally that ad, playable.

| Time (s) | What the viewer sees | What we implement |
|---|---|---|
| 0.0 | 5 tiny soldiers, big "5" over their heads, road scrolling, rifles already popping | Auto-fire from frame 1, no "tap to start" after title |
| 1.5 | Two gates roll in from the fog: left **+5** (blue), right **+2** (blue) | Gate pair spawns at 70 m, speed 8 m/s |
| 4.0 | Bullets hit the +5; the number ticks 6, 7, 8 … each with a little pop | Per-bullet increment + 0.12 s pop tween |
| 7.5 | Squad walks through "+18"; soldiers burst out of the gate and the "5" rolls up to "23" | Formation re-flow with spawn-pop, count ticker |
| 9.0 | A clump of 6 zombies shambles down; three get shredded, two reach the squad and bite, "23" drops to "21" | Wave A; contact kill = 1 soldier each; -1 floaters |
| 13.0 | Next pair: **x2** vs **+10**. The "x2" gets shot to "x3". Squad walks through; "21" rockets to "63" | Multiplier gauge; big count tween with scale punch |
| 18.0 | Crate with a shotgun; whole squad switches to wide orange blasts for 10 s | Timed weapon power-up |
| 24.0 | Red **-15** gate on one side; the player shoots it, it flips to **+3** (turns blue) at the last second | Red → zero → blue recolor with flash |
| 28.0 | A huge zombie stomps in from the fog with a long HP bar; the horde dies in a fountain of coins | Boss intro, phases, slow-mo death |

The three sensations we must nail, in priority order: (1) the number on the gate **answering every bullet**, (2) the squad count **ticking up like a slot machine**, (3) the horde **melting** under fire.

---

## 2. World constants

| Constant | Value | Why |
|---|---|---|
| Road width | 8.0 m (two 4.0 m halves) | One gate per half; whole squad fits in one half |
| Steer range (formation center x) | -2.6 … +2.6 m | Formation never clips road edge |
| Steer gain (touch) | 1 screen-width drag = 8 m of x | Full lane change in ~1/3 of screen width |
| Steer smoothing | critically damped spring, ω = 18 rad/s | Snappy but never overshoots a gate |
| Road speed, level 1 | 8.0 m/s | Gate arrival in 8.75 s from spawn |
| Road speed, level 20 | 13.0 m/s | See §12 |
| Spawn distance (gates, zombies) | 70 m ahead | Fog fully opaque at 90 m, half at 55 m |
| Gate "armed" distance | 30 m | Bullets register from here; gate frame lights up |
| Gate "commit" distance | 6 m | Player can no longer change which half they pass (lateral lock) |
| Camera | 6.5 m behind, 5.5 m up, look-at 14 m ahead, vertical FOV 58° (portrait) | Shows 2 gates + 1 wave + squad count without the gate text ever leaving the frame |
| Camera FOV on desktop/landscape | 42° | Prevents squad looking tiny |
| Fixed timestep | 60 Hz simulation, render variable | Determinism for bullet/gate counting |

---

## 3. Bullets and fire

The gate-increment mechanic is **per bullet**, so bullet cadence is the master clock of game feel.

| Parameter | Base | Upgrade ceiling | Notes |
|---|---|---|---|
| Shots per soldier | 2.0 /s | 4.0 /s (fire-rate upgrade, +0.25 per rank, 8 ranks) | Soldiers fire with a per-soldier random phase so the stream is continuous, not a volley |
| Bullet speed | 30 m/s | fixed | 1.0 s to reach the armed line at 30 m |
| Bullet life | 1.2 s (36 m) | fixed | Past 36 m nothing is hittable anyway |
| Damage per bullet | 1 | 3 (damage upgrade, +0.25 per rank) | Gates count hits, not damage |
| Lateral spread | ±2.0° | fixed | 1.0 m spread at 30 m, so a 4 m gate panel catches ~96% |
| Visible tracers | min(N, 40) shooters | — | Above 40 soldiers, only 40 shoot visibly |
| Bullet weight | w = max(1, N / 40) | — | Each bullet carries w damage and adds w to gate hit counters (fractional accumulators). 400 soldiers = 40 tracers of weight 10 |
| Bullet pool | 256 | — | 40 shooters × 4 /s × 1.2 s = 192 worst case |

Shooters are the front-most soldiers in the formation; the back rows "reload" visually (rifle raised, no muzzle flash). This keeps muzzle flashes dense at the front where the camera looks.

Hit priority along a bullet's path: zombies first (nearest), then gate panel, then nothing. **Zombies in front of a gate soak bullets**; this is the game's only "cost" of a free number and is what makes wave placement a design tool (§8).

---

## 4. Gates: the number must answer every bullet

### 4.1 Geometry and readability

- Panel: 3.6 m wide × 2.4 m tall, bottom edge at 1.0 m, centered in its half (x = ±2.0). Frame 0.15 m thick, emissive (bloom picks it up).
- Text: canvas texture 512×256 per gate, font `900 180px "Rubik"` (Google Fonts, loaded once, fallback `Arial Black`), white fill, 14 px dark outline, re-rendered only when the value changes (≤ 1 re-render per frame per gate, dirty-flagged).
- Phone readability check: at spawn (70 m) the glyph height is ≈ 24 px on a 390×844 viewport; at the armed line (30 m) it is ≈ 60 px. The sign is readable 2 s before it is shootable.
- Colors: positive = `#2EC4FF` frame / `#1B8CFF` panel; negative = `#FF3B3B` frame / `#B3121A` panel; neutral (x1) = `#9AA0A6`; MAX = `#FFD166`.

### 4.2 Increment rules per bullet

Let `h` be the (weighted) hit counter of a gate since spawn, `base` its spawn value.

| Type | Per-hit rule | Cap / terminal state | Feedback on each hit |
|---|---|---|---|
| **+N** | value += 1 per hit | cap = 4 × base (min 12). At cap: gold "MAX" badge, frame turns `#FFD166`, further hits give +1 coin each | number pop, tick sound pitch rises with value |
| **-N** | value += 1 per hit (toward 0) | At 0: 0.25 s white flash, panel recolors to blue, text becomes "+0". Then continues +1 per hit up to cap = base (so -8 can become at most +8) | red tick sound (lower, duller) until 0, then normal tick |
| **xN** | hidden counter; each **12 × current multiplier** hits adds +1 to multiplier (x2→x3: 24 hits, x3→x4: 36, x4→x5: 48) | cap x5 | thin progress ring (0→360°) around the panel; on each multiplier step: panel scale punch 1.35×, deep "whomp" |
| **÷N** | each **8** hits reduce divisor by 1 (÷3→÷2→÷1) | at ÷1: panel shows "x1", recolors to neutral grey; **16** further hits turn it into x2 (blue); cap x2 | ring as above; the ÷1→x2 flip gets the same white flash as -N→0 |

Why these numbers: at level 1 with 5 soldiers all in one half, the squad lands 5 × 2 × 3.75 s ≈ 37 hits in the armed window minus zombie soak. A +5 gate caps at +20 after 15 hits, so a first-time player **sees a MAX** on their first gate and learns the loop in one screen. x2 → x3 needs 24 hits: achievable alone at level 1, achievable only by committing early and having no zombies in the way at level 8+.

### 4.3 Which gate is better? (the decision the ad sells)

Pass-through applies the final value to the count `C`:

- `+N`: C ← C + N  | `-N`: C ← max(0, C - N) | `xN`: C ← C × N | `÷N`: C ← ceil(C / N)
- Break-even between +N and xM: xM is better when C > N / (M - 1). With C = 21, "+10" vs "x2": x2 wins (42 vs 31). Pairs are generated so that the break-even sits near the expected count (§4.4), so the choice is real roughly 50% of the time and the shooting changes the answer the other 50%.
- Passing through two gates at once (formation straddling the center): **forbidden** — at the commit distance (6 m) the formation center is snapped to the nearer half with the steer spring. A triple gate (three 2.67 m panels) uses the same rule with three snap points.
- Gate pass-through anim: the panel shatters into 24 shards that fly toward the camera (0.4 s), soldiers spawn out of the gate footprint, and the count tweens over 0.6 s (§6).

### 4.4 Gate value generation

Let `E(z)` be the designer's expected squad size at road position z (linear interpolation of the per-level `E_start → E_boss` in §12). For each gate event:

| Slot | Draw |
|---|---|
| Pair type roll (weights) | +/+ 30%, +/x 30%, +/- 20%, x/- 10%, +/÷ 7%, x/÷ 3% (levels 1–2 force the §10 script) |
| +N base | round(E(z) × U(0.15, 0.45)), min 2 |
| -N base | round(E(z) × U(0.3, 0.7)), min 3 |
| xN base | 2 (90%), 3 (10%, levels ≥ 6 only) |
| ÷N base | 2 (80%), 3 (20%, levels ≥ 8 only) |
| Guard rails | If C < 8 when the pair spawns: no red gate, and at least one `+` with base ≥ 6. Never two red gates in one event. A triple always contains exactly one red. |

---

## 5. Squad and formation

| Parameter | Value |
|---|---|
| Start squad (no upgrades) | 5 |
| Formation | hex-packed rows, 0.45 m spacing, width grows as `ceil(sqrt(N × 1.6))` columns, max 9 columns (4.0 m) then depth grows |
| Formation change | each soldier tweens to its new slot over 0.35 s (ease-out-back 1.2) |
| New soldier spawn | scale 0 → 1.15 → 1.0 over 0.3 s, from the gate footprint, with a 0.04 s stagger per soldier, max 40 visible spawns per gate (the rest appear instantly) |
| Soldier death | topple backward 0.5 s, 6 blood-puff particles, fades, slot removed; formation re-flows 0.2 s later (not instantly, so deaths are legible) |
| Max rendered soldiers | 200 instanced meshes (InstancedMesh, 1 draw call per body part). N > 200 is shown by count only; the formation is "full" |
| Walk cycle | 1.8 Hz limb swing, amplitude 35°, slight bob 3 cm; recoil pitch 6° on each shot |

The big count above the squad is a sprite (canvas 256×128, same Rubik font) at 2.2 m above the formation's front row, always facing camera, with a drop shadow. It never scales with distance (it is screen-space sized at 72 px).

---

## 6. The count ticker

The count display `D` chases the true count `C`:

- Increase: D tweens to C over `min(0.6, 0.08 × |C − D|)` s with ease-out-cubic, playing a tick every 20 ms during the tween; the sprite scale punches to 1.4× at the start and settles with a 0.25 s spring. Color flashes `#5CFF8A` for 0.2 s.
- Decrease: D snaps immediately (losses must be honest and instant), sprite scale punches 0.8× → 1.0, color flashes `#FF4040` for 0.3 s, a "-1" floater (or "-k" when several die within 100 ms, merged) rises 1.2 m over 0.7 s.
- Multiplier pass: before the tween, the count sprite shows "x3" next to it for 0.3 s, then rolls up.

---

## 7. Zombies and why losing soldiers feels fair

| Type | HP | Speed (toward squad, added to road speed) | Contact | Telegraph | Unlock level |
|---|---|---|---|---|---|
| Walker | 3 | 1.0 m/s | kills 1 soldier, dies | none needed | 1 |
| Runner | 2 | 4.5 m/s | kills 1, dies | screech at 20 m, slight lean | 2 |
| Crawler | 2 | 2.0 m/s, low profile (bullets from the front 40% miss unless within 8 m) | kills 1, dies | ground dust trail | 3 |
| Brute | 30 (L4) scaling +4/level | 0.8 m/s | swings every 0.8 s, kills 2 per swing, **does not die on contact** | red ground ring 3 m radius from 12 m; roar | 4 |
| Spitter | 6 | 0.6 m/s, stops at 18 m | every 2.5 s spits a 1 m blob that kills 1 soldier at the impact point unless the formation moves 1 m away | green arc preview on ground (0.6 s before impact) | 5 |

Fairness rules (these are the contract with the player):

1. **One bite, one soldier.** A regular zombie removes exactly one soldier on contact and dies doing it. The player always sees the body hit the squad; nothing is lost off-screen.
2. **Loss is proportional to the fire you didn't have.** A wave is sized so that a squad at `E(z)` kills 90% of it before contact (wave count ≈ E(z) × 2 shots × 1 dmg × approach time × 0.9 / zombie HP). A squad half the expected size loses ~5 soldiers, never the squad.
3. **Telegraph before damage.** Brutes and spitters show a ground mark ≥ 0.6 s before any kill. Runners screech. Nothing fast is silent.
4. **Hit-flash on every hit** (0.06 s white emissive) and an HP bar above anything with HP ≥ 6 so the player can see the bullets working.
5. **Floating damage numbers** only on brutes and bosses (otherwise they'd be noise at 80 bullets/s).
6. **No deaths during a gate pass animation** (0.6 s invulnerability so the reward moment is never muddied).
7. **Game over only at 0.** A squad of 1 still fires and can still walk through a +N gate. Hope is always on screen.

Death: 0.06 s hit-flash, 8-particle blood puff (dark red `#6B0F1A`, 0.4 s), body topples (0.35 s) and sinks into the road (0.3 s), 1 coin pops out and arcs toward the HUD coin icon (0.5 s). Kills within 50 ms of each other share one sound instance with a +3 dB boost (a "crunch" that gets fatter with the horde).

---

## 8. Pacing: what happens in 60 seconds

Mid-game reference (level 8, 9.5 m/s, 570 m per minute):

| Event | Per 60 s | Spacing rule | Duration on screen |
|---|---|---|---|
| Gate events (pairs/singles/triples) | 4.5 | every 110–140 m; never within 25 m of a wave's contact point | 8.8 s from fog to pass |
| Waves | 3.6 | every 140–170 m; a wave's **contact point is 15–20 m past the previous gate** (so you meet them with your fresh number) | 6–9 s |
| Pickups (weapon/gear/troop gates) | 1.2 | one in every 3rd–4th gate event replaces a `+` with a special | — |
| Crates (coins, shotgun, armor) | 1.0 | mid-way between gates, off-center so steering matters | — |
| Coin lines | 2.0 | 8 coins, 1.2 m apart, on one half | — |
| Boss | once, at the end | — | 18–30 s |

The deliberate rhythm is **gate → swell → wave → shrink → gate**. Never two waves without a gate between them (except the final 60 m before the boss, which is a horde run-up). Gate events alternate halves for their "better" option so the player keeps steering.

Wave composition per level is a weighted bag over the unlocked types; the first wave of any level is walkers only; the last wave before the boss always contains the level's newest type.

---

## 9. Boss encounter beats

Bosses are DPS checks with a safety valve, not puzzles. Four archetypes, scaled by level (§12).

| Beat | Time | What happens | Juice |
|---|---|---|---|
| Run-up | T-8 s | Road speed stays; horde of 15–25 walkers/runners; fog thickens 20% (fog near 40 → 32 m); music drops to drums only | HUD progress bar's boss marker pulses at 1 Hz |
| Intro | T-0 | Road speed lerps to 35% over 1 s; boss walks out of the fog at 45 m; 0.8 s roar; letterbox bars (8% top/bottom) slide in; HP bar (full width, 14 px) slides down from the HUD, name card for 1.5 s | Camera shake amplitude 0.25 m, 0.6 s; haptic 80 ms |
| Phase 1 (100→60%) | 0–8 s | Boss advances at 1.5 m/s from 40 m. Every 4 s emits a minion burst (6 walkers) that soaks bullets | HP bar chunks fall away in 5% segments |
| Phase 2 (60→25%) | 8–16 s | Armor plates fly off (4 pieces, bloom spark); boss speed 2.2 m/s; archetype special (below) | Screen flash white 0.1 s at phase change; HP bar turns orange |
| Phase 3 (25→0%) | 16–24 s | Boss staggers (speed 1.0 m/s), rage glow red, summons one last horde of 10 | HP bar red, pulsing |
| Death | — | Time scale 0.25× for 1.2 s; white flash 0.15 s; boss collapses in 1.8 s (real time), 60 coin fountain in an arc, confetti 200 particles; letterbox out; "LEVEL COMPLETE" | Haptic pattern [60, 40, 120] |
| Safety valve | any | If the boss reaches the squad (z = 0) it chews 3 soldiers/s while being shot at point blank. The fight is lost only when C hits 0 | Each chew: -3 floater, red vignette pulse |

Archetype specials: **Hulk** — ground slam every 5 s, 3 m radius ring, kills 3 if the formation center is inside after a 0.8 s telegraph. **Spitter Queen** — three simultaneous spit arcs, 1 s preview. **Juggernaut** — a 2.5 m-wide charge down one half of the road, telegraphed by a red lane stripe 1.2 s before; dodging to the other half avoids it entirely. **Colossus** — all three, slower cadence, plus a regenerating 15% HP shield that must be shot off (gate-style ring gauge, 40 hits).

Boss HP = E_boss × 2 shots/s × 15 s × 0.8 (80% expected accuracy), so an on-curve squad with base upgrades kills it in ~15 s of real shooting plus phase theatre ≈ 22 s. Upgraded fire rate/damage shorten this; the "boss damage" shop upgrade multiplies damage to bosses only.

---

## 10. First 30 seconds (level 1 script, fixed, not random)

| t (s) | z (m) | Beat | Hint (first run only, 1 line, bottom third of the screen, 2.5 s) |
|---|---|---|---|
| 0.0 | 0 | Squad of 5 already walking and firing; count sprite "5" bounces once | "DRAG TO STEER" with a drifting finger glyph that mirrors the player's first touch |
| 1.5 | 12 | Gate pair spawns: left **+5**, right **+2** | — |
| 4.5 | 36 | +5 becomes armed; first hits; number pops 6, 7, 8… | "SHOOT THE GATE!" (appears on the first registered hit, so it is always true) |
| 7.5 | 60 | Squad passes "+20 MAX" (or whatever they reached) → count 25 | "MORE SOLDIERS!" only if the count ≥ 15; otherwise no hint (don't lecture a weak result) |
| 9.0 | 72 | Wave A: 6 walkers in a loose line across both halves | — |
| 12.0 | 96 | Contact with 0–2 survivors; first "-1" floaters | "ZOMBIES BITE!" only if a soldier died |
| 13.5 | 108 | Pair: left **x2**, right **+10** | — |
| 18.0 | 144 | Pass; count ~50–70 | "x2 DOUBLES YOUR SQUAD" if they took x2; "TRY THE x2 NEXT TIME" if they took +10 and x2 would have been better |
| 19.5 | 156 | Crate (shotgun) on the right half | "GRAB THE CRATE" |
| 22.0 | 176 | Wave B: 10 walkers + 2 runners | — |
| 25.0 | 200 | Pair: left **-15** (red), right **+6** | "RED TAKES SOLDIERS — SHOOT IT BLUE OR AVOID IT" |
| 30.0 | 240 | Pass; wave C (8 walkers) | — |
| 42.0 | 336 | Pair: **x2** vs **+25**; then run-up horde | — |
| 50.0 | 400 | Boss: Hulk, HP 1000 | "SHOOT THE BOSS" + HP bar intro |

Hints are suppressed forever after the player performs the action once (persisted in save data). A fail on level 1 restarts with the same script (seeded), so the second attempt is a rehearsal, not a new test.

---

## 11. Juice: every trigger → effect

Timings are real time. Scale means uniform scale of the affected object. Sounds are WebAudio recipes (§11.1). "Shake" = camera position noise with the given amplitude, decaying linearly over the duration.

| # | Trigger | Visual effect | Duration | Sound | Haptic |
|---|---|---|---|---|---|
| J1 | Soldier fires | Muzzle flash: 2 crossed quads, additive, `#FFE38A`, scale 0.3 m, 2 frames; tracer: 0.6 m stretched quad, `#FFC266` → bloom; recoil 6° | 33 ms flash | Gunshot (one instance per frame max, volume +1 dB per 8 simultaneous shooters, cap +12 dB) | none |
| J2 | Bullet hits zombie | 4 spark particles `#FFF1B0`, hit-flash white emissive on body 60 ms, HP bar chunk | 60 ms | "thip" (noise 20 ms band-pass 2 kHz) | none |
| J3 | Bullet hits gate | Number pop: text sprite scale 1.0 → 1.25 → 1.0 (ease-out-back) ; panel emissive +40% for 80 ms; 3 spark particles at impact | 120 ms | Tick: sine 620 Hz + 6 Hz × (value − base), 40 ms, clipped at 2.2 kHz. The pitch climb is the "slot machine" of this game | none |
| J4 | Gate reaches MAX | Panel frame → gold, "MAX" badge slams in (scale 2 → 1, 0.2 s), 12 gold sparks | 0.3 s | Two-note chime (880 → 1320 Hz, triangle) | 20 ms |
| J5 | Red gate hits 0 | 0.25 s white panel flash, color lerp red → blue over 0.3 s, 16 blue sparks | 0.3 s | "flip" (noise sweep 300 → 3 kHz, 150 ms) | 30 ms |
| J6 | Multiplier step (x2→x3) | Panel scale punch 1.35×, ring resets with a 360° wipe, text pop 1.5× | 0.25 s | "whomp" (sine 90 Hz, decay 250 ms + sub thump) | 25 ms |
| J7 | Gate pass (positive) | Panel shatters into 24 shards flying at camera, soldiers spawn with stagger, count ticker tween (§6), 0.6 s invulnerability | 0.6 s | Rising arpeggio 4 notes (C E G C, 60 ms each, square wave through low-pass) + soldier "hup" chorus (pitch spread by N) | 40 ms |
| J8 | Gate pass (negative) | Shards fly away from camera, red flash vignette 0.2 s, soldiers at the back topple | 0.5 s | Descending 2 notes (G → C#, 120 ms) | [30, 30, 30] |
| J9 | Zombie dies | Blood puff 8 particles, topple, sink, coin pop | 0.75 s | "crunch" (noise burst 80 ms, low-pass 800 Hz); shared instance per 50 ms window, +3 dB per extra kill, cap +9 dB | none |
| J10 | Soldier dies | Topple, 6 blood particles, "-1" floater, count snap, count red flash | 0.7 s | Short "ugh" (sawtooth 180 Hz, 90 ms, pitch down) | 15 ms |
| J11 | Brute swing | Red ring telegraph fills 0.8 s, then shake 0.12 m 0.3 s | 1.1 s | Roar (sawtooth 70 Hz + noise, 0.6 s) then "thud" | 50 ms |
| J12 | Crate opened | Lid pops, 10 coins or the item icon rises 1.5 m and flies to HUD, HUD slot flashes | 0.6 s | "pop" + item jingle (3 notes) | 20 ms |
| J13 | Power-up starts | Whole squad's rifles recolor (emissive), HUD timer ring appears, screen-edge glow in the weapon color 0.3 s | 0.3 s | Weapon-specific sting | 30 ms |
| J14 | Power-up last 2 s | HUD ring blinks at 4 Hz | 2 s | Tick-tock | none |
| J15 | Boss phase change | White flash 0.1 s, shake 0.2 m 0.4 s, armor plates fly off with bloom sparks | 0.5 s | Metallic crash (noise + 3 inharmonic sines) | 60 ms |
| J16 | Boss death | Time scale 0.25× for 1.2 s, white flash 0.15 s, 60 coin fountain, 200 confetti, bloom strength 1.0 → 2.0 → 1.0 over 1.5 s | 3.0 s total | Slowed roar (playbackRate 0.4) then victory fanfare (6 notes) | [60, 40, 120] |
| J17 | Level complete | Stars slam in one by one (0.25 s each, scale 3 → 1), coin count-up ticker at 30 coins/s | 1.5 s | Three ascending chimes | 20 ms × stars |
| J18 | Game over | Desaturate scene over 0.8 s, camera drops 1 m, "SQUAD LOST" | 1.2 s | Low drone fade | 100 ms |
| J19 | Coin pickup | Coin flies to HUD icon (0.4 s bezier), icon scale punch 1.2× | 0.4 s | "ding" pitch rises by 1 semitone per coin within 0.5 s, resets after | none |
| J20 | Near-miss (zombie dies within 1.5 m of the squad) | Tiny time dip 0.85× for 0.1 s, dust puff | 0.1 s | — | none |

Global juice caps (performance contract): ≤ 300 live particles (pooled sprites, 1 InstancedMesh), ≤ 24 floaters, ≤ 3 concurrent shakes (sum clamped at 0.3 m), bloom strength 0.9 default, threshold 0.75, radius 0.4; bloom off entirely on the "Low" quality tier and emissive values are raised by 30% to compensate.

### 11.1 Synthesized sound palette (WebAudio)

| Sound | Recipe |
|---|---|
| Gunshot | White noise 40 ms through band-pass 1.2 kHz Q 0.7, plus sine 180 → 60 Hz over 60 ms; master compressor (threshold -18 dB, ratio 6) keeps 80 shots/s from clipping |
| Gate tick | Sine, frequency 620 + 6 × (value − base) Hz, 40 ms, gain envelope 0 → 1 in 2 ms, exp decay 35 ms |
| Multiplier whomp | Sine 90 Hz, 250 ms, plus sine 45 Hz 300 ms, slight pitch drop |
| Zombie crunch | Brown noise 80 ms, low-pass 800 Hz, gain spike |
| Soldier "hup" | Sawtooth 220 Hz, 70 ms, formant band-pass 700 Hz; N voices detuned ±4% up to 8 voices |
| Coin | Sine 1760 Hz 80 ms + sine 2637 Hz 50 ms |
| Music loop | 120 BPM, 8-bar loop: kick (sine 50 Hz, 120 ms), snare (noise 100 ms), bass (square, 16th notes, pattern in A minor), lead (triangle, 4-note motif) rendered live by a scheduler using `AudioContext.currentTime`, never a prerendered buffer. Boss variant: half-time drums, bass one octave down |

Audio resumes on first touch (`AudioContext.resume()` in the pointerdown handler); music gain ducks -6 dB during gate passes and boss death.

---

## 12. Level 1–20 pacing table

`E_boss` is the expected squad size at the boss for an on-curve player with no shop upgrades; it drives gate value generation (§4.4) and boss HP (§9). Run time excludes the boss. "Gate events" counts pairs + singles + triples.

| Level | Length (m) | Road speed (m/s) | Run time (s) | Gate events | Waves | Zombies (total) | New type | E_start → E_boss | Boss | Boss HP | 3-star (soldiers alive at boss kill) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 400 | 8.0 | 50 | 4 | 3 | 24 | walker | 5 → 40 | Hulk | 1,000 | 30 |
| 2 | 450 | 8.0 | 56 | 5 | 4 | 32 | runner | 5 → 50 | Hulk | 1,200 | 38 |
| 3 | 500 | 8.5 | 59 | 5 | 4 | 40 | crawler | 5 → 60 | Hulk | 1,450 | 45 |
| 4 | 550 | 8.5 | 65 | 6 | 5 | 50 | brute | 5 → 70 | Hulk | 1,700 | 52 |
| 5 | 600 | 9.0 | 67 | 6 | 5 | 62 | spitter | 5 → 85 | **Spitter Queen** (big) | 2,400 | 60 |
| 6 | 650 | 9.0 | 72 | 6 | 6 | 72 | x3 gates | 6 → 95 | Hulk | 2,300 | 70 |
| 7 | 700 | 9.5 | 74 | 7 | 6 | 85 | triple gates | 6 → 110 | Hulk | 2,650 | 80 |
| 8 | 750 | 9.5 | 79 | 7 | 7 | 98 | ÷3 gates | 6 → 125 | Spitter Queen | 3,000 | 92 |
| 9 | 800 | 10.0 | 80 | 8 | 7 | 112 | brute pairs | 6 → 145 | Hulk | 3,500 | 105 |
| 10 | 900 | 10.0 | 90 | 8 | 8 | 130 | — | 7 → 170 | **Juggernaut** (big) | 4,800 | 125 |
| 11 | 900 | 10.5 | 86 | 8 | 8 | 140 | runner packs (8) | 7 → 185 | Spitter Queen | 4,450 | 135 |
| 12 | 950 | 10.5 | 90 | 9 | 9 | 155 | — | 7 → 205 | Hulk | 4,900 | 150 |
| 13 | 1000 | 11.0 | 91 | 9 | 9 | 170 | spitter + brute waves | 8 → 225 | Juggernaut | 5,400 | 165 |
| 14 | 1050 | 11.0 | 95 | 10 | 10 | 190 | — | 8 → 250 | Spitter Queen | 6,000 | 185 |
| 15 | 1100 | 11.5 | 96 | 10 | 10 | 210 | — | 8 → 280 | **Colossus** (big) | 8,000 | 205 |
| 16 | 1200 | 11.5 | 104 | 11 | 11 | 230 | crawler swarms (12) | 9 → 310 | Juggernaut | 7,450 | 230 |
| 17 | 1250 | 12.0 | 104 | 11 | 11 | 250 | — | 9 → 340 | Hulk Twins (2 × 4,100) | 8,200 | 250 |
| 18 | 1350 | 12.5 | 108 | 12 | 12 | 275 | — | 10 → 375 | Spitter Queen | 9,000 | 275 |
| 19 | 1400 | 12.5 | 112 | 12 | 13 | 300 | — | 10 → 410 | Juggernaut | 9,850 | 300 |
| 20 | 1500 | 13.0 | 115 | 13 | 14 | 330 | — | 10 → 450 | **Colossus Prime** (big) | 13,000 | 330 |

Rules that generated the table:

- Length: 400 + 50 × (L − 1), with +50 bumps at levels 10, 16, 18 (the "big" milestones feel longer).
- Speed: 8.0 + 0.25 × floor((L − 1) / 2) … capped at 13.0; speed never changes mid-level except the boss slow-down.
- Gate events: round(length / 115). Waves: round(length / 100) − 1 (+1 from level 10). Zombies total: waves × (6 + 1.5 × L) rounded.
- E_boss: 40 × 1.13^(L−1), rounded to 5, cap 450. Boss HP = E_boss × 2 × 15 × 0.8, ×1.25 on "big" bosses, rounded to 50.
- Stars: 1 star = boss killed; 2 stars = ≥ 50% of E_boss alive at kill; 3 stars = ≥ 75% of E_boss alive at kill.
- Unlocks: "Low HP brute" wave variants from level 9 use two brutes side by side so the road has no safe half for 3 s.

Pickup schedule by level: shotgun L1, armor plates L2, minigun L3, magnet L4, hero sniper L5, laser L6, fire-rate chip L7, flamethrower trooper L8, rocket launcher L9, drone turret L10, damage booster L11, APC L12, railgun L13, medic L14. After a special's unlock level it joins the random pickup bag for that level and all later ones.

---

## 13. Endless mode rule

Unlocked after level 10. The road is generated in 300 m "chunks" with difficulty index `D` starting at 1 and incrementing by 1 per chunk.

| Parameter | Formula |
|---|---|
| Road speed | min(14.0, 9.0 + 0.15 × D) |
| Expected squad E(z) | 80 × 1.08^D, cap 600 |
| Gate events per chunk | 3 (chunk 1–4), 2 (chunk 5+): fewer gates, the squad is fed by surviving, not by numbers |
| Waves per chunk | 2 + floor(D / 4), zombie count per wave = 6 + 2D |
| Mini-boss | every 5th chunk, a Hulk/Juggernaut/Spitter Queen with HP = E × 2 × 10 × 0.8, no road slow-down |
| Rubber band | if C < 10 at a chunk boundary, the next gate event is a guaranteed `+` with base = max(8, 0.3 × E) and no red gate; if C > 2 × E, the next event contains a ÷2 on both halves (one shootable to x2) |
| Score | meters × 1 + kills × 10 + gate passes × 25 + mini-boss kills × 500; a 2× score multiplier for every 60 s with zero soldier deaths (resets on first death) |
| End | squad reaches 0; results screen shows distance, score, best, coins (coins at 60% of campaign rate) |

---

## 14. Specials (pickups) — brief coverage

| Special | Kind | Duration / rule | What changes in feel |
|---|---|---|---|
| Shotgun | weapon | 10 s | 5 pellets per shot in a 20° fan, 1 dmg each, fire rate 1.2/s; gate hits count per pellet (great gate feeder) ; orange tracers |
| Minigun | weapon | 10 s | fire rate × 3, spread ±5°; yellow tracers, continuous roar, shake 0.03 m |
| Laser | weapon | 8 s | a beam per shooter, 8 dmg/s each, hits the nearest target instantly; gates take 2 "hits" per 0.1 s per beam; cyan, bloom heavy |
| Rocket launcher | weapon | 8 s | 1 rocket/s per 10 soldiers, 3 m blast, 12 dmg; a rocket on a gate counts as 10 hits; shake 0.1 m per blast |
| Railgun | weapon | 6 s | 1 piercing shot/s per shooter, 10 dmg, passes through every zombie in line; gate hit weight 5; white-blue flash |
| Armor plates | gear | until consumed | each soldier survives one bite (grey chestplate visual, drops off on use) |
| Fire-rate chip | gear | 20 s | +50% fire rate |
| Damage booster | gear | 20 s | +100% damage (not gate hits) |
| Magnet | gear | 20 s | coin attract radius 6 m |
| Hero sniper | troop | rest of level | one tall soldier at the back, 1 shot/s, 25 dmg, always targets the highest-HP zombie; distinct crack sound |
| Flamethrower trooper | troop | rest of level | 6 m cone, 4 dmg/s to all inside, ignites crawlers |
| Drone turret | troop | 30 s | hovers 3 m up, 6 shots/s, 1 dmg, targets runners first |
| APC | troop | until destroyed (40 HP) | drives at the front, absorbs contact kills |
| Medic | troop | rest of level | +1 soldier every 4 s while C < E(z) |

Specials come from a special gate (single, green frame, icon instead of number, cannot be shot) or a crate. Only one weapon is active at a time; a new weapon pickup replaces and refreshes the timer.

---

## 15. Economy and meta (brief)

| Source | Coins |
|---|---|
| Zombie kill | 1 (brute 5, boss 100 + 10 × level) |
| Gate pass (positive) | 2; MAX gate 5 |
| Coin line / crate | 8 / 10 |
| Level complete | 25 × level × stars |

| Upgrade | Ranks | Effect per rank | Cost of rank n |
|---|---|---|---|
| Start squad | 10 | +2 soldiers | 80 × 1.45^n |
| Fire rate | 8 | +0.25 shots/s | 120 × 1.5^n |
| Damage | 8 | +0.25 dmg | 120 × 1.5^n |
| Coin multiplier | 5 | +20% | 200 × 1.6^n |
| Boss damage | 5 | +25% vs bosses | 150 × 1.6^n |

Level select is a vertical road map with 20 nodes; a locked node needs 1 star on the previous. Results screen: stars slam in (J17), coins counted up, "best soldiers at boss" shown, buttons: Replay / Shop / Next.

---

## 16. UI (brief)

HUD (portrait): top-left coin icon + count; top-center level progress bar (8 px, with a skull marker at the boss position and the squad marker moving along it); top-right pause. Power-up timers as 44 px rings with the item icon, stacked under the coin count. Bottom 20% is free for the thumb; no HUD there except first-run hints. Settings: sound, music, haptics (on/off), quality (Auto/Low/Mid/High). All text in Rubik, minimum 16 px, 4.5:1 contrast.

---

## 17. Performance contract for the feel

| Budget | Value |
|---|---|
| Draw calls | ≤ 60 (soldiers 4 instanced parts, zombies 5 instanced per type, bullets 1, particles 1, gates ≤ 8, road 6 segments, props instanced) |
| Pools (pre-allocated, never grown mid-level) | bullets 256, particles 300, floaters 24, zombies 120, shards 96, coins 64 |
| Per-frame allocations in update loops | 0 (reused Vector3/Quaternion scratch objects, no closures, no array spreads) |
| Quality tiers | High: DPR ≤ 2, shadow map 2048, bloom on, particles 300. Mid: DPR ≤ 1.5, shadows 1024, bloom on, particles 200. Low: DPR 1, shadows off (blob shadows), bloom off, particles 100 |
| Auto-scaling | if the 2 s moving average frame time > 18 ms, drop one tier; if < 12 ms for 10 s, raise one tier (max once per 30 s) |
| Road segments | 6 segments × 30 m ring buffer, props placed by seeded RNG per segment index |

The feel must survive the Low tier: the gate tick sound, the count ticker and the number pop are CPU-trivial and always on. Bloom is the first thing to go; juice that depends on it (gate glow) is replaced by brighter emissive and a sprite halo.

---

## 18. Tuning knobs and what to watch

Expose in `config.js` and log in a debug overlay: hits per gate (histogram), average gate final value vs base, soldiers lost per wave, time-to-kill per boss, count at boss vs E_boss. Targets after playtest: 60–75% of gates reach ≥ 2× base at level 1; 25–40% at level 10; median soldiers lost per wave = 8–12% of the count; boss time-to-kill 18–28 s; level 1 completion rate on first attempt ≥ 85%, level 5 ≥ 60%, level 10 ≥ 45%.
