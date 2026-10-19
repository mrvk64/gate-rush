# GATE RUSH — Final Game Design Document (authoritative)

Status: FINAL. This document supersedes `docs/design/gdd-feel.md`, `gdd-systems.md` and `gdd-artdir.md`. Where those three disagree, the resolution below is binding. `docs/BRIEF.md` remains the source of truth for constraints; nothing here contradicts it. Every number in this document is a tunable that lives in `js/data.js` (see `docs/ARCHITECTURE.md`); no module hard-codes a value from this document.

Units: metres (m), seconds (s), metres per second (m/s), hit points (HP), coins (c). `L` = level index (1-based). `C` = current soldier count. `E(z)` = designer's expected soldier count at road position z. Rounding is `Math.round` unless stated.

---

## 0. Resolutions of the three source documents

| Topic | Decision | Reason |
|---|---|---|
| Fire model | feel §3: 2.0 shots/s per soldier (4.0 at max rank), visible shooters = min(C, 40), bullet weight w = max(1, C/40), every visible bullet is a real hit on zombies and gates | Gate ticks per second is the heartbeat; systems' 6 bullets/s at C = 5 is not a slot machine |
| Multiplier gates | Integers only: x2 base (x3 base from L6), step cost scales with expected hits (§4.2), cap x5; ÷ ladder ÷3→÷2→x1→x2 | The ad sells "x2" and "x3"; the digit atlas has no decimal glyph |
| World frame | Forward = −Z, road 8.0 m, camera (0.4·sx, 9.5, 11) looking at (0.6·sx, 1, −14); horizontal FOV is held constant per preset (portrait 27.05° = 55° vertical on a 390×844 phone; landscape 68.6° = 42° vertical at 16:9) and the vertical FOV is derived from the aspect ratio (clamped 45–75° / 36–55°); portrait preset below aspect 0.9; spawn 70 m, fog 40→100 m | Two of three docs agree on −Z and 8 m; artdir camera shows prop bands; readability re-checked in §4.1 with a 1.7 m glyph; a constant horizontal FOV keeps the 8 m road and 36 m gates the same width on iPads and the desktop artifact pane |
| Level 1 | feel §10 verbatim as a fixed seeded script (§11) | "The ad, playable" |
| Level length / E_boss | Len = 400 + 50(L−1) cap 1400; E_boss(L) = min(600, round5(140·1.08^(L−1))) | Feel's lengths fit a phone session; E_boss re-derived from the actual L1 E-trace (systems' E-trace method) |
| Zombie HP | Base HP from feel (walker 3 / runner 2 / crawler 2 / brute 30 / spitter 6) scaled per wave by the leak model (§6.3) | A fixed h(L) cannot hit the leak bands once C ≥ 25; the leak model is the only scaling that stays fair at every squad size |
| Bites | Walker/runner/crawler 1 and die; brute 3 per swing; spitter splash 1 (2 from L10) | "One bite, one soldier" legibility; brief says brutes more |
| Boss | Boss every level (brief); road lerps to 35 % over 1 s; table HP = 20·E_boss (×1.25 on milestone levels), scaled at spawn by the arriving squad and the shop (§7: count scale × shop scale, never below the table) (round-2 QA LVL-14); safety valve chews 3 soldiers/s | Runner must keep running; a fight of ≈ 8–25 s whose phases and attacks are seen, and a bigger army or a better shop still wins faster |
| Stars | 1★ boss killed, 2★ survivors ≥ 50 % E_boss, 3★ ≥ 80 % E_boss (round-3 QA LVL-22; was 75 %), no timer | A timer double-counts DPS |
| Economy | systems §9 wholesale + feel's MAX bonus (5 c, +1 c per hit past MAX, cap 5) (round-2 QA LVL-23) | Only income-modelled economy |
| Formation | Hex lattice (0.34 m) sorted by elliptical norm, half-width hard cap 1.8 m, steer range ±2.1 m fixed | Reads as a blob when small, a pill when large, never straddles two lanes |
| Visible soldiers | High 200 / Medium 120 / Low 60; count keeps rising numerically | GPU budget on 2021 mid-range at 1024 shadows |
| Text rendering | Lilita One digit atlas (artdir §5) for every in-world number; Nunito for body UI; zero texture uploads during play | Per-gate canvas re-render is the worst mobile jank source |
| Gate commit | No straddling; snap to the nearer lane at 4 m; lane highlight decal from 10 m | Ad never shows a half-and-half pass |
| ÷ gate colour | Crimson-magenta #E0346E (frame #A1204B) | Orange was indistinguishable from fog/horizon at distance |
| Quality | Medium tier is the 60 fps contract for 2021 mid-range; High is A14+/Adreno 7xx/desktop only; 1.0 M-pixel render-target cap; one Standard shader everywhere | HalfFloat MSAA at DPR 2 is 65–70 MB on Mali-G57 |
| Simulation | Fixed 60 Hz, accumulator, ≤ 5 sub-steps, swept segment hit tests | 120 Hz doubles the hottest CPU work for nothing |

---

## 1. Pillars and the loop

1. **The number answers every bullet.** A gate's value changes on the frame a bullet touches it, with a pop and a pitch-climbing tick.
2. **The count ticks like a slot machine.** Gains roll up; losses snap down.
3. **The horde melts.** Hordes are sized so an on-curve squad kills ~88 % before contact.
4. **Losing is always fair.** One bite, one soldier; every kill is telegraphed; game over only at 0.
5. **Read the number first.** Squad count, gate values and boss HP are the three most legible things on screen.

Loop period: 12–13 s on L1; ≈ 8–11 s on generated levels (one gate event per ≈ 100 m of road at 8.2–12 m/s; tools/validate-levels.js reports it per level) (round-2 QA LVL-31). Rhythm per 100 m of road: **gate → swell → wave (contact 15–20 m past the gate) → shrink → gate**. Never two waves without a gate between them, except the 60 m horde run-up before the boss. Pairs and triples alternate which half holds the better option (singles do not count; the validator requires each half 40–60 % ±1 event per level) (round-2 QA LVL-16).

### 1.1 Level 1 is the ad (target timings at 8.0 m/s)

| t (s) | Beat |
|---|---|
| 0.0 | 5 soldiers marching and firing, "5" bounces once. Hint "DRAG TO STEER" |
| 0.0 | Pair spawns at 70 m: left **+5**, right **+2** |
| 4.3 | +5 armed (36 m); first hits; 6, 7, 8 … +20 MAX after 15 hits. Hint "SHOOT THE GATE!" on the first registered hit |
| 8.75 | Pass "+20" → count 25, soldiers burst out of the gate. Hint "MORE SOLDIERS!" only if count ≥ 15 |
| 11.3 | Wave A: 6 walkers in a line; ~5 shredded, 0–2 bite. Hint "ZOMBIES BITE!" only if a soldier died |
| 15.0 | Crate (shotgun, spawned at 11.3 s) is ≈ 40 m out on the right half; the crate passes at 20.0 |
| 16.6 | Hint "GRAB THE CRATE" (round-2 QA LVL-24; round-3 FTUE: no longer at 15.0 — it then read while the x2 \| +10 choice was still open and lured a hint-follower off the ×2 lane to the crate's side; now it fires inside the pair's 4 m commit, when the lane is locked; the crate is 27 m out, 3.4 s to steer) |
| 17.0 | Pair: left **x2** (shot to x3 after 80 hits), right **+10** → ~72 if x3. Hint "×3 MULTIPLIES YOUR SQUAD" (names the multiplier the pass applied) or "TRY THE ×2 NEXT TIME" (only if x2 would have won) (round-2 QA LVL-22, LVL-33); it follows "GRAB THE CRATE" after 1.5 s (a hint yields early when another waits, §14) |
| 18.0 | Shotgun picked up; "SHOTGUN! WIDE SPREAD, SHORT RANGE" follows the ×3 lesson at ≈ 19.6 s (round-3 FTUE: the first pickup of every special names it, §8); "RED TAKES SOLDIERS" then shows the moment the 30.0 pair spawns (≈ 21.3 s) |
| 21.5 | Wave B: 10 walkers + 2 runners |
| 30.0 | Pair: left **−15** (red), right **+6**. Hint "RED TAKES SOLDIERS — SHOOT IT BLUE OR AVOID IT" |
| 33.0 | Wave C: 8 walkers |
| 42.0 | Pair: **x2** vs **+25** |
| 44–50 | Run-up horde (18 walkers + 4 runners), drums only |
| 50.0 | Boss: Hulk, 2 800 HP (table; ×count / shop scale, §7). Hint "SHOOT THE BOSS" when the fight starts (≈ 52.4 s, the intro is immune) (round-2 QA LVL-25), then "STEER CLEAR OF THE MARKS!" from the first telegraphed attack (the slam ring ≈ 0.8 s into the fight; on screen before the second attack) (round-3 FTUE: the red ring / stripe under the squad was never explained) |
| ~65–75 | Boss dies in slow-mo, 60-coin fountain, LEVEL COMPLETE (the fight lasts ≈ 8–25 s, §7) |

Completion target on first attempt: L1 ≥ 85 %, L5 ≥ 60 %, L10 ≥ 45 %.

---

## 2. World constants

| Constant | Value |
|---|---|
| Axes | +X right, +Y up, squad faces −Z; the world scrolls toward +Z |
| Road | 8.0 m wide, x ∈ [−4, 4]; two 4.0 m halves; triple lanes centred at x = −2.7 / 0 / +2.7 |
| Squad anchor | Front row at (squadX, 0, 0); formation extends toward +Z |
| Steer range | squadX ∈ [−2.1, +2.1], independent of C |
| Road speed v(L) | min(12.0, 8.0 + 0.2·(L−1)); constant within a level except the boss slow-down |
| Spawn horizon | z = −70 (gates, zombies, crates, coins) |
| Despawn | z > +14 (behind the camera) |
| Gate armed window | 36 m ahead → 1.5 m ahead of the squad front |
| Gate commit distance | 4 m: squadX snaps to the nearer lane centre; lane highlight decal visible from 10 m |
| Camera (portrait, aspect < 0.9) | position (0.4·sx, 9.5, 11), look-at (0.6·sx, 1.0, −14), horizontal FOV 27.05° → vertical FOV = clamp(2·atan(tan(13.525°)/aspect), 45°, 75°) (= 55° at 390×844), near 0.5, far 160 |
| Camera (landscape/desktop, aspect ≥ 0.9) | position (0.4·sx, 10.5, 13), look-at (0.6·sx, 1.0, −16), horizontal FOV 68.6° → vertical FOV = clamp(2·atan(tan(34.3°)/aspect), 42°, 55°) (= 42° at 16:9; the 42° floor keeps the squad in frame on ultra-wide windows and landscape phones); preset switch tweened 300 ms (round-1 QA VIS-3) |
| Camera framing constraint | every frame, after the preset: the ground point at the squad's back (front + min(squad depth, 8 m)) must project at ndc y ≥ −0.80 (above the 8 % boss letterbox) while the spawn line (z = −70) stays at ndc y ≤ +0.62; the camera pitches down first and pulls back along its view line (≤ 8 m) only when pitch alone cannot satisfy both, eased over the preset tween, never snapped (round-1 QA VIS-3; back limit 4 → 8 m in round-2 QA VIS-19) |
| Camera count dolly | camera z += 0.53·s, y += 0.165·s with s = clamp(√V − √40, 0, 11) (V = visible soldiers), eased over 0.5 s, look-at unchanged: ≈ 1 m further back and 0.5 m higher at V = 200 than round 1, so a 200-soldier formation (≈ 6.5 m deep) stays fully on screen; the value glyph at the armed line stays within 10 % of 29 px (round-1 QA VIS-3, round-2 QA VIS-19) |
| Camera (title) | the title / idle scene blends (300 ms) to its own rig: portrait position (0, 5, 11), look-at (0, 0, −8), so the marching squad sits between the logo and PLAY; landscape / desktop position (4, 5, 11), look-at (4, 0, −8), so the squad stands left of the centred button column (round-1 QA VIS-3, round-2 QA VIS-20). Title light while that rig is on: hemisphere fill × 1.8 and the sun swung 175° about +Y toward the camera, so the squad's backs are lit; both restored with the rig at level start (round-2 QA VIS-15) |
| Camera follow | x lerp 1 − exp(−5·dt); look-at x lerp 1 − exp(−7·dt) |
| Fog | linear, #D8744A, near 40, far 100 (Low: far 90) — District 1, SUNSET BOULEVARD; from round 5 every visual district sets its own fog colour and near / far (near 38–40, far × 0.95–1.04; docs/DISTRICTS.md) |
| Road segments | 6 × 30 m ring; segment recycled when its far edge passes z = +20 |
| Simulation | fixed 1/60 s, accumulator, max 5 sub-steps per frame, render dt clamped to 0.05 s |
| Time scale | 1.0; 0.25 for 1.2 s on boss death; 0.25 for 0.6 s when the squad dies (game over); 0.85 for 0.1 s on near-miss (zombie dies within 1.5 m of the squad); floor 0.25; audio rate = 0.6 + 0.4·scale. Theatre timers (boss death → results, game over → results, hint display, boss intro, name card) run on real time, not the scaled clock — the theatre clock (`time.theatre`), which holds while paused, so a pause or app switch freezes them and resume continues where the player left off; the slow-mo countdown holds while paused too (round 2, CORE-7) |

---

## 3. Squad

### 3.1 Count, visible count, formation

`C` is the logical count (shown by the big number, used by all combat maths). `V = min(C, Vmax)` is the rendered count: Vmax 200 (High) / 120 (Medium) / 60 (Low). Count cap 9 999.

Formation slot table (built once at boot, 300 slots): hex lattice with 0.34 m spacing, row pitch 0.294 m, alternate rows offset 0.17 m, limited to |x| ≤ 1.80 m (10–11 columns); points sorted ascending by elliptical norm sqrt(x² + (z/1.6)²). The first n slots are the formation for n soldiers: a round blob below ~40, a pill that grows in depth above. Slot z is re-based so the front-most occupied slot sits at z = 0 (`frontOffset[n]` precomputed). Depth at 200 = 5.9 m (toward the camera).

| Parameter | Value |
|---|---|
| Reflow | nearest-slot reassignment on every change of V; soldier lerps to its slot with 1 − exp(−8·dt); formation re-flows 0.2 s after a death (deaths stay legible) |
| New soldier | spawns at the gate footprint (or blob centre), scale 0 → 1.15 → 1.0 over 0.3 s, 0.04 s stagger, max 40 visible spawns per gate (rest appear instantly) |
| Death | topple backward 0.55 s (ease-out-back about the foot pivot), sink 0.3 s, 6 blood particles, slot freed at 1.4 s |
| Gate losses (−N/÷N) | soldiers dissolve rim-inward, 12 per 100 ms |
| Walk cycle | 2.2 Hz limb swing 0.55 rad, bob 0.03 m, recoil 0.06 m back on fire |
| Lean | 6° roll into lateral movement |
| Count label | world billboard at (squadX, 2.6 + 0.08·√V, 0.8), digit-atlas quads, screen-space 72 px, 3 px #0B0F1A outline, on a dark rounded backing plate (#0B0F1A at alpha 0.45, padded 0.15 em around the digit ink; beams / flashes behind it are capped under the plate and just under the bloom threshold around it, so nothing behind the count blooms over or merges with its digits — round-2 FX-10, `JUICE.label.plateAlpha` / `platePad`; on High / Medium the label and its plate are drawn after the bloom pass, so no bloom haze of a beam behind them lands on the digits — round-2 cross-group); drawn only while playing / paused, fading out over 0.25 s when the results or game-over panel opens, and while the boss-intro dolly runs (round-3 FTUE: the dolly drops the squad under the letterbox, which cut the label into a stray digit; it fades back in when the camera returns). The count wins every overlap with a gate: the value text of the lane being passed fades out (0.1 s) while it would overlap the label on screen (§4.1) |

### 3.2 Steering

Relative drag anywhere on the screen that is not a button (the UI layer lets touches through): `targetX += dx_px · k · sensitivity`, `k = 8.0 / (0.62 · W_eff)` with `W_eff` = viewport width in portrait (≈ 0.0331 m/px at 390 px) and `min(width, 0.7 · height)` in landscape (aspect ≥ 0.9, where the camera frames the road by the height; ≈ 0.047 m/px at 844×390), so the squad tracks a drag at ≈ 0.6–0.75 screen px per finger px in landscape as on an iPad portrait (phones portrait ≈ 1:1) (`SQUAD.steer.landscapeWidthFactor`, round 2 CORE-8), integrated once per rendered frame from the frame's accumulated pointer deltas (CSS px). Sensitivity ×0.75 / ×1.0 / ×1.3. Dead zone: first 2 px of each gesture. First `pointerId` only, with pointer capture, released on up/cancel/lost capture/blur of *that* pointer — a second thumb (or a tap on pause) never stops or redirects the steer. `squadX += (targetX − squadX) · (1 − exp(−14·dt))`, max lateral speed 12 m/s. Keyboard A/D/←/→ at 9 m/s with 0.08 s acceleration; gamepad left stick (dead zone 0.15). At the commit distance (gate z ≥ −4) the squad's steering target is clamped to the chosen lane's centre ±0.3 m until the pass resolves (the raw targetX is untouched, so the drag feels continuous after the gate).

### 3.3 Fire model

| Parameter | Base | Max | Notes |
|---|---|---|---|
| Fire rate f | 2.0 /s | 4.0 /s | f = 2.0·(1 + 0.10·rank), 10 ranks |
| Damage d | 1.0 | 2.5 | d = 1 + 0.15·rank |
| Visible shooters | min(C, 40) front-most soldiers | | each shooter has a random phase; back rows aim but do not flash |
| Bullet weight w | max(1, C/40) · (targetRate / spawnRate) | | each bullet deals w·d damage and adds w to gate counters |
| Spawn rate cap | 200 bullets/s | | targetRate = shooters·f·weaponRateMult; excess is folded into w |
| Bullet | 35 m/s, life 1.2 s (42 m), spread ±2°, radius 0.12 m | | pool 256 |
| Squad DPS | C·d·f·gearMult·accuracy(0.8) | | the number the leak model and boss HP are tuned against |
| Hit priority | the first thing along the bullet's swept path wins — zombie, boss, gate panel or closed crate (an exact tie goes to the zombie); panel and crate tests ignore height | | zombies in front of a gate soak bullets; a zombie behind a panel is shielded by it |
| Boss fight | every shooter aims at the boss capsule while it is within 40 m | | DPS fully applied; minions on the line still soak |

---

## 4. Gates

### 4.1 Geometry and readability

Panel 3.6 × 2.4 m (triple: 2.4 × 2.4 m), bottom edge at 1.0 m, centred at x = ±2.0 (pair), 0 (single), −2.7/0/+2.7 (triple). Frame: two 0.12 m posts 3.2 m tall, top bar 3.8 m, chevron wedges; panel opacity 0.38 (0.6 with High-contrast gates). Glyph height 1.7 m for ≤ 3 glyphs, 1.35 m for 4. Pixel check (px = 844·h / (2·d·tan 27.5°), d = distance from camera): spawn at z = −70 (d ≈ 82 m) → 17 px, hazy in fog; z = −36 armed (d ≈ 48 m) → 29 px; z = −26 (d ≈ 38 m) → 36 px, fully readable ≥ 1 s before the armed line; z = 0 → 95 px. Gates are readable ~2 s before they are shootable. In the last metres before the pass the value text of the lane the squad takes sits exactly where the count label is drawn ("69" over "+15" read "+695" at every pass): while the two overlap on screen that gate's op + digit glyphs fade out over 0.1 s (the MAX badge and the other lanes stay) — the count label is the number that matters at the pass, and the "+N" burst follows it (round-3 FTUE).

Four-way type encoding (no colour-blind setting needed): hue, luminance (positive L≈65, negative L≈50), glyph (+ − 0.95 m, × ÷ 1.05 m (round-1 QA GAT-3, round-2 QA GAT-7)), frame shape (rounded top + up-chevrons for positive; square top + hazard stripes + down-chevrons for negative; double chevrons for × and ÷; pentagon top for specials).

| Type | Panel tint | Frame | Shape |
|---|---|---|---|
| +N | #2E9BFF @ 38 % | #1A6FD6 | rounded top, up-chevrons |
| xN | #3BE57A @ 38 % | #1FA85A | rounded top, double up-chevrons |
| −N | #FF3B4E @ 38 % | #B81E2E | square top, hazard stripes, down-chevrons |
| ÷N | #E0346E @ 38 % | #A1204B | square top, hazard stripes, double down-chevrons |
| x1 / 0 | #B8B8B8 @ 30 % | #8A8A8A | neutral |
| Special (item) | #C77DFF @ 38 % | #8E3FD6 | pentagon top, icon glyph, not shootable |
| MAX | unchanged tint | #FFD166 | gold "MAX" badge |

### 4.2 Per-hit rules

Let `h` be the weighted hit accumulator since spawn, `base` the spawn value. Intake per gate is clamped to **40 weighted hits/s** (excess discarded) so weapons feel strong but cannot trivialise caps.

| Type | Per-hit rule | Terminal state | Pass effect |
|---|---|---|---|
| +N | value += 1 per weighted hit | cap = 4·base (min 12) → gold MAX badge, frame #FFD166; each further hit pays +1 c (max 10 c per gate) | C += N |
| −N | value += 1 toward 0 | at 0: 0.25 s white flash, red→grey→blue lerp 400 ms, glyph swaps to "+"; continues +1 per hit up to +base | C = max(1, C − N) when negative; C += N when flipped |
| xM | hidden counter; step K_M from the window's achievable intake (below; round-1 QA LVL-1), later steps × M/M0 | cap x5; 360° progress ring around the panel; scale punch 1.35× and "whomp" per step | C = C·M |
| ÷D | K_÷ from the window's achievable intake (below; round-1 QA LVL-2) hits per step along ÷3 → ÷2 → x1 (grey) → (2·K_÷ hits) x2; the first ÷ lane that can flip spawns with the once-ever hint "SHOOT ÷ TO CLIMB: ÷2 → ×1 → ×2" (round 4, `HINTS.div`; L3 on the canonical seed) | cap x2 | C = ceil(C/D), or C·M after flip |

`H(z)` = expected weighted hits an on-curve squad lands on one gate (2.0 shots/s per soldier, half of them on the gate) = min(40, E(z))·t_w, with t_w = 34.5 / v(L) (armed window time); generated levels size gates on the design line's 0.75·H and their step costs on the intake model I below (round-1 QA LVL-1). L1 gate 2 (E = 24, t_w = 4.3): H = 103; the authored x2 steps to x3 at 80 hits (round-2 QA LVL-22). Generated steps follow the window's achievable intake, not H (round-1 QA LVL-1 / LVL-2): with I = min(40, E·2.0·1.0)·t_w (full accuracy, the 40 hits/s intake cap) and Icap = 40·(t_w + 0.25) (a full window plus the gate's 0.25 s token bucket), K_M = clamp(0.9·I, 1.1·Icap / S(5 − M), 1.02·Icap / S(4 − M)) ≥ 12·M with S(n) = Σ_{j<n} (M + j)/M (an x3 spawn lane uses the upper bound), and the first step never costs more than 0.9·I (round-2 QA LVL-27); K_÷ = max(8, perD·I, 1.1·Icap / (rungs to x1 + 2)) with perD ÷2 0.45 / ÷3 0.3 — an on-curve squad pumps ÷D up to x1, the x1 → x2 flip needs more than one full window at the intake cap (round-1 QA LVL-2).

Why a first-time player sees MAX on gate one: 5 soldiers × 2.0/s = 10 hits/s, window 4.3 s minus 0.9 s bullet flight ≈ 37 hits; +5 caps at +20 after 15 hits.

Gates accept hits from the armed line (36 m) through the commit (4 m) until 1.5 m before the squad front, so the applied value equals the value the player saw. Panel hit tests are 2-D (road plane only): bullets fly at 0.95 m, below the 1.0 m panel bottom edge, and the panel counts as a full-height wall across its lane for bullets, rockets, rail bolts and laser beams.

### 4.3 Which gate is better

+N: C+N. −N: max(1, C−N). xM: C·M. ÷D: ceil(C/D). xM beats +A iff C > A/(M−1). Pairs are generated so the breakeven sits inside ±30 % of E(z): the choice is real about half the time and shooting changes the answer the other half.

### 4.4 Generation (L2+; L1 is authored)

Event layout weights: pair 70 % / single 15 % / triple 15 % (L1–3: pair 75 / single 25 / triple 0; triples from L7). Pair pattern bag (percent by band L1–3 / L4–9 / L10+), E = E(z), U = uniform:

| Pattern | Weights | Values |
|---|---|---|
| +A \| +B | 30 / 20 / 15 | A = round(E·U(0.25, 0.6)), B = round(A·U(0.5, 0.8)); smaller value on the lane with fewer zombies ahead |
| +A \| xM | 30 / 25 / 25 | A = round(E·(M−1)·U(0.7, 1.3)); M = 2 (x3 base 25 % from L6) |
| −A \| ÷D ("lesser evil") | 15 / 20 / 20 | D ∈ {2, 3 (L8+)}; A = round(E·(1 − 1/D)·U(0.7, 1.3)), A ≤ 1.3·H |
| xM \| −A ("trap") | 15 / 15 / 15 | A = round(E·U(0.3, 0.5)); flippable if A ≤ 0.8·H |
| +A \| −B (small) | 10 / 10 / 10 | B = round(min(0.8·H, E·0.3)), A = floor(B/2) + 4 |
| item \| +A | 0 / 10 / 15 | A = round(E·0.35); the item lane delivers a special |

Single: L1–2 always +A, A = round(E·0.2); L3+ 50 % +A, 30 % xM, 20 % −A with A ≤ 0.9·H. Triple: [+A, xM, −B] with B = round(E·0.4), exactly one red lane.

Design line (round-1 QA LVL-1): generated levels are sized on the greedy DESIGN line — the lane that reads best at spawn, landing 0.75·H — with two shadow lines: the full-intake line (best lane, min(40, C·f)·t_w + the 0.25 s bucket; ≤ 1.6·E_boss fresh / ≤ 2.2·E_boss at shop rank 3, with full-intake ceilings on every gate) and the weak-shooter line (0.3·H; ≥ 20 % of E_boss, < 2 % is an error) (round-2 QA LVL-27; round 5: while the best attempt's weak line is under 20 % the generator keeps trying up to 32 attempts instead of 24, `LEVELS.curve.generator.weakAttempts`). The opener is drawn from its own bag — +A | xM 50 %, +A | +B 30 %, item | +A 20 % (the item lane carries one of the level's non-guaranteed specials) — never identical to the previous level's opener, ≤ 30 % of levels share one; the second gate keeps its bag roll (round-2 QA LVL-30). The level's newly unlocked special always rides a crate on the half the design line holds (round-2 QA LVL-26). Steering must matter (round-3 QA LVL-22): the no-steer line — a squad that never steers commits to the lane nearest the road centre (ties to the left; a triple's middle lane) and lands the full intake on it with a fresh profile — reaches the boss with at most 85 % of E_boss (`GATE_RULES.generation.noSteerMax`): the generator prefers attempts that hold it (and keeps trying while it is above), the validator warns above it and prints it per level. The level that introduces x3 gates (L6) shows the x3 as the bet of a +A | x3 pair (it was a single, which every squad shot to x5 whether it steered or not).

Sanity rules: all A, B ≥ 3 and ≤ 999; round to 1 below 30, 5 between 30 and 100, 10 above; no red gate when E(z) < 8; never two red lanes before L4 except "lesser evil" from L3; no ÷ in the first 150 m of L1–3; Σ gate EV (best lane with 0.6·H hits) ≥ 0.9·E_boss after leak losses, else re-roll the weakest gate upward; a gate never takes C below 1. `guards` (zombies 12 m in front of a lane) are the designed trade-off for the richer lane.

---

## 5. The count ticker (display D chases the true count C)

| Case | Behaviour |
|---|---|
| Increase | D tweens to C over min(0.6, 0.08·|C − D|) s, ease-out-cubic, one tick sound every 20 ms during the tween; label scale punches 1.4× then settles with a 0.25 s spring; colour flashes #5CFF8A for 0.2 s |
| Decrease | D snaps instantly; scale punch 0.8× → 1.0; colour flashes #FF4040 for 0.3 s; a "−1" floater (merged into "−k" for deaths within 100 ms) rises 1.2 m over 0.7 s |
| Multiplier pass | "x3" badge appears beside the label 0.3 s before the roll-up |
| Gate burst | "+17" digit-atlas burst at the label, rises 40 px over 0.7 s |

Losses are honest and instant; gains are theatre.

---

## 6. Zombies

### 6.1 Roster

Own speed is added to the road speed. HP is `base × hz` where `hz` is solved per wave by the leak model (§6.3); the base column only sets the ratio between types.

| Type | Base HP | Own speed | Contact | Telegraph | Coins | Height / hit radius | HP bar | Unlock |
|---|---|---|---|---|---|---|---|---|
| Walker | 3 | 1.0 m/s; lane drift x += 0.4·sin(1.1t + φ) | kills 1, dies | none needed | 1 | 1.6 m / 0.45 m | after first hit | L1 |
| Runner | 2 | 4.5 m/s; zig-zag amplitude 1.5 m period 1.2 s; re-targets squad x every 0.5 s | kills 1, dies | screech at 20 m, lean | 2 | 1.5 m / 0.40 m | after first hit | L2 |
| Crawler | 2 | 2.0 m/s; lunges last 3 m at 6 m/s; packs of 6–10 | kills 1, dies | ground dust trail | 1 | 0.7 m / 0.35 m | never | L3 |
| Brute | 30 | 0.8 m/s; charge 3.5 m/s inside 8 m | swing every 1.0 s kills 3, does not die on contact; contacts and swings only at the formation front (z ≤ −0.3 m); a flank contact walks to the front first (4 m/s) and re-fills the ring there; after 6 swings it staggers back 2 m and re-telegraphs instead of swinging (round-2 QA ENE-12); stagger (0.3 s freeze + flash) every 25 % HP | red ground ring r 3 m from 12 m + roar, 0.8 s fill before the first swing | 15 | 2.8 m / 0.90 m | always | L4 |
| Spitter | 6 | 0.6 m/s; holds at 18 m for ≤ 6 s then advances | contact 0 (dies); spit every 2.5 s: glob 12 m/s lobbed arc, splash r 1.2 m at the squad's predicted x, kills 1 (2 from L10) unless the formation centre is ≥ 1.2 m away | green ground arc 0.6 s before impact | 6 | 1.7 m / 0.50 m | always | L5 |

Bite rules (the contract): one bite, one soldier; a regular zombie dies on contact (blood puff, −1 floater). Brutes keep swinging until dead. Armor plates absorb bites first (brute swing consumes 3 plates, spit 1). During a gate pass the squad is invulnerable for 0.6 s. Game over only at C = 0; a squad of 1 still fires and can still walk through a +N.

Hit feedback: 0.06 s white emissive flash on every hit; HP bar on anything with HP bar policy above; floating damage numbers only on brutes and bosses (value = round(w·d); hits on one target within 0.12 s add up — `JUICE.damageNumber.mergeSeconds`; each target's live numbers fill a slot grid of 2 columns (inner edges ±0.3 m from the target — round-3 FTUE: at ±0.12 m the gap was narrower than a digit, so a row's two numbers read as one, "110" + "48" = "11048") × 3 rows riding along with it, a new number retiring its slot's previous one, so they never overlap; boss numbers ×1.2 size, rise 0.25 m, ≤ 6 live per target — `JUICE.damageNumber.bossScale` / `bossSide` / `bossRise` / `bossSlots`, `JUICE.caps.bossNumbers`, round-2 FX-12; round 4 (r3 FTUE residual 4): on the boss itself only 2 rows per side, ≤ 4 live, and its hits merge for at least life / 4 = 0.175 s, so each number runs its whole 0.7 s life before its slot comes round again — at high fire rates the boss stack used to sit at 5–6 numbers retired the moment they faded in; brutes keep 3 rows and 0.12 s — `JUICE.damageNumber.bossRows`); death = topple 0.55 s + sink 0.3 s + 8 blood particles + 1 coin arcing to the HUD. Kills within 50 ms share one "crunch" instance, +3 dB per extra kill, cap +9 dB.

### 6.2 Waves

Population per generated wave P(L) = min(24, 4 + L), bounded by the squad (round 3, `WAVE_RULES.small`, §6.3 (c)): at most max(4, 0.3·E) zombies at the wave's contact point E, brutes and spitters only from E ≥ 25, at most max(2, 0.25·E) runners. Waves per level W(L) = G(L) − 1 for L ≤ 9, G(L) for L ≥ 10 (G = gate events, §10). Run-up horde before the boss: 15 + L zombies (cap 30) spawned in 4 bursts over the last 60 m, walkers and runners only. Pools: walker 120, runner 60, crawler 40, brute 16, spitter 24 (max 260 live).

Type weights (percent of a wave, interpolated between rows, types gated by unlock level):

| L | Walker | Runner | Crawler | Brute | Spitter |
|---|---|---|---|---|---|
| 1 | 100 | 0 | 0 | 0 | 0 |
| 2 | 80 | 20 | 0 | 0 | 0 |
| 3 | 65 | 20 | 15 | 0 | 0 |
| 5 | 50 | 22 | 13 | 8 | 7 |
| 8 | 42 | 25 | 12 | 11 | 10 |
| 12 | 36 | 26 | 12 | 14 | 12 |
| 20+ | 30 | 28 | 12 | 16 | 14 |

Patterns: `line` (even across x ∈ [−3.5, 3.5], same z), `column` (single file at a lane x, 2 m apart), `horde` (uniform in a 7 × 8 m box), `flank` (clusters at x = ±3.2), `pincer` (runners from both edges, walkers centre; L4+), `wall` (brute line + crawler carpet 6 m behind; L8+). The first wave of a level is walkers only in a `line`; the last wave before the run-up contains the level's newest type; each new type's first appearance is a solo introduction spawn 60 m before its first mixed wave. Brute pairs side by side from L9; runner packs of 8 from L11; crawler swarms of 12 from L16.

### 6.3 Leak model (per-wave HP solve; also the authored-level validator)

For a wave with N zombies, expected squad E at its contact point, population-weighted own speed s̄, and the level's leak band midpoint `leak`:

```
win    = 0.8 · 40 / (v + s̄)                 kill window (s): bullets reach 40 m, 80 % of it is usable
DPS    = E · 2.0 · 1.0 · 0.8                 base fire rate, base damage, 80 % accuracy
TTK    = win / (1 − leak)
HPtot  = DPS · TTK
hz     = HPtot / Σ baseHP_i
HP_i   = max(1, round(baseHP_i · hz))
```

Leak bands (expected fraction of the wave that bites): L1–3 10–15 % (mid 12.5), L4–9 15–22 % (18.5), L10–19 22–28 % (25), L20+ 28–32 % (30). Expected bites = leak·N·bite_i. A squad at half of E leaks ≈ 55–60 %; a squad at 2·E leaks 0.

Per-type windows and coverage (round-1 QA LVL-4): every type gets the share of the fire its base HP claims during its own window usable·reach/(v + s_t), cut to usable·exposure/v while the panel of the gate in front of the wave still shields it and, for crawlers, to their hittable stretch (z > −8 m, then the lunge); non-homing types count only where their x lies inside the shooter columns (formation half-width + radius + 0.5 m slack, coverage ≥ 0.75). Play calibration (round-2 QA LVL-15, measured in docs/build/qa2/fix-level): the solve is `HPtot = DPS·calib(leak)·win_t·windowScale_t / (1 − leak)^3` with calib = 2.0 × [1.0 at 12.5 %, 1.25 at 18.5 %, 1.8 at 25 %, 2.2 at 30 %] (interpolated; the squad's real kill capacity grows with the specials and troops a campaign hands out) and windowScale walker 1.5, runner 0.6, crawler 0.33, brute 0.35, spitter 1.0; the exponent 3 reflects that play leak rises far more slowly with HP than the linear form. A run-up horde is solved per burst share (one walker window over its 4 bursts, ≥ 0.6). Boss minions take 0.15 × the calibrated solve at E_boss (at full calibration they soaked the fight). Live waves, guards, run-ups and boss minions are multiplied by p^0.5 with p = (fire rate / 2.0)·damage, so shop upgrades shorten waves but never to zero bites (the generator and the validator keep p = 1).

Round-3 calibration (QA LVL-15, measured in docs/build/r3-balance.md): (a) per level, the capacity factor `LEAK_MODEL.calibByLevel` — L2 0.33, L3 0.5, L4 0.7, L5 1.1, L6 0.95, L7 1.1, L8 1.45, L9 1.8, L10 0.8, L11 0.9, L12+ 1.0 (interpolated) — multiplies the calibrated DPS of generated campaign waves and guards (endless keeps its own design multiple, §10.1); it is fitted so an on-curve squad (C reset to the design line after every gate) with the ranks a player who spends every coin owns (L4 1·1·1·2·1, L8 3·2·2·4·3, L12 4·4·4·5·4 for squad / fire / damage / coin / boss) leaks inside its band on the canonical levels (seed 1000 + L); (b) the waves and guards in the first 40 % of a level meet the bare squad (no special or troop yet): their calibration ramps from the base 2.0 to the full factor over that stretch (`LEAK_MODEL.earlyRamp`); (c) a wave never outnumbers its squad (`WAVE_RULES.small`, the population rule of §6.2 bounded by the squad): with E the expected squad at contact, a generated wave carries at most max(4, 0.3·E) zombies (types in proportion), brutes and spitters only from E ≥ 25 (a brute becomes two walkers, a spitter one; the one new brute / spitter that the unlocking level's intro mix keeps stays, but fills 4 places of the cap, `WAVE_RULES.small.keepWeight`) and at most max(2, 0.25·E) runners — no early wave costs an on-curve squad more than ≈ 35 % (measured: ≤ 25 % on the canonical levels; over 12 layouts per level, 1 of 288 early waves at 37 %).

Round-5 calibration (L13–L30, docs/build/r5-level-balance.md): the same per-level factor, fitted the same way — `calibByLevel` L13 1.2, L14 1.16, L15 1.25, L16 1.25, L17 1.28, L18 1.44, L19 1.57, L20 1.29, L21 1.28, L22 1.32, L23 1.43, L24 1.31, L25 1.32, L26 1.27, L27 1.42, L28 1.47, L29 1.43, L30 1.53 — with the ranks a greedy-shop campaign owns at each level (squad / fire / damage / coin / boss: L13 5·4·4·6·5, L16 6·6·5·7·6, L20 8·7·7·8·7, L25 9·8·8·10·9, L30 10·10·9·10·10). Before it, L13–L30 sat at 1.0 and an on-curve squad with those ranks leaked 11–21 %, below every band (the shop's fire × damage outgrows the p^0.5 compensation). The factor scales wave and guard HP only: the weak-shooter and no-steer lines meet the same waves with the same factor on both sides of the solve, so the validator's lines barely move.

Round 5d (endless only, docs/build/r5d-endless.md): endless death comes from growing numbers, never from a single zombie the squad cannot kill. After the solve and every live multiplier (§10.1's design multiple, the pressure's HP part, the band) each type's HP is clamped to `LEVELS.endless.hpCapSeconds[type]` × the on-curve squad's design DPS (E(D) · 2.0 · 1.0 · 0.8 × p^`LEVELS.endless.profileExp`, p = the shop's fire rate × damage; 1 for the generator and the validator) — walker 0.5 s, runner 0.4, crawler 0.35, brute 3.0, spitter 1.2 — so a zombie in contact dies within its cap seconds of focused on-curve fire (a brute carried 7.7k HP at chunk 5 and 15k at chunk 10 before, and one of them at the formation front took a whole squad's fire for a whole mini-boss fight). Waves and gate guards (`levelgen.endlessHpCap`, `level._capEndlessHp`); the mini-boss's own minions sit far below it. The endless ramp lives in numbers and in wave frequency, within the zombie pools (§10.1).

Worked L1 wave A (E = 25, 6 walkers, v = 8, s̄ = 1): win = 3.56 s, DPS = 40, TTK = 4.07 s, HPtot = 163 → walker 27 HP; expected 0.75 bites (the ad's "two reach the squad" on a slightly weak run). Wave B (E ≈ 64, 10 walkers + 2 runners): HPtot ≈ 390 → walker 34, runner 23.

The generator computes `hz` from the running E-trace; authored waves may set `hpMult` to override. The validator prints each wave's expected leak and warns outside the band.

---

## 7. Boss

Every level ends with a boss. Table HP = 20·E_boss(L), ×1.25 on milestone levels (5, 10, 15, 20, 25, 30), rounded to 50. At spawn the HP is table HP × count scale × shop scale, never below the table (round-2 QA LVL-14): count scale = clamp((C / E_boss)^0.6, 1, 2.0) for the arriving count C; shop scale = clamp(m^(0.9·min(1, C / E_boss)), 1, 10.0) with m = (fire rate / 2.0)·damage·boss damage (1.0 at base ranks; a squad below the curve keeps most of its upgrades' edge). Round 5 (docs/build/r5-level-balance.md): the exponent was 0.75 and the cap 4.0; m reaches 12.5 at rank 10 and the ×4 cap bound from ≈ L18, so L21–L30 bosses died in 5–10 s at E_boss with the ranks a player owns there. At C = E_boss the fight now lasts ∝ m^−0.1 (a better shop still wins faster) and measures 12–20 s (median per level) on L13–L30; L2–L12 fights lengthen by 3–20 % (m^0.15). The HP bar shows the scaled maximum, twins split it and the phase thresholds and the Colossus shield follow it. TTK falls strictly with m, and with C from E_boss up; below E_boss the faded exponent leaves it flat or slightly rising with C at high ranks (round-5 audit, docs/build/r5-balance-audit.md §4: L28 at ranks 9·8·8·10·9, 11.5 s at 0.45·E_boss against 15.1 s at E_boss; lead decision pending). The target is ≈ 8–25 s per fight (§17 12–22 s), so its phases and attacks are seen. Hit radius 1.6 m (capsule), core at 4.5 m height. At base stats an on-curve squad kills it in HP / (1.6·E_boss) = 12.5 s of shooting; with theatre ≈ 16–18 s. The boss-damage shop upgrade multiplies damage to bosses only.

Intro and attacks (round-1 QA ENE-1 / ENE-2 / ENE-5): the boss is immune during the intro (2.6 s, the fight starts at 2.4 s); attacks start once the boss is within 30 m of the squad front rather than on arrival, the first attack ≈ 0.8 s after `boss:fight`; a phase special fires within 1 s of the phase entry; an attack interval is measured start-to-start; a charge stops ≈ 5 m short of the squad; telegraphs are drawn at the squad front and their hit tests use x only.

| Beat | Time | What happens | Juice |
|---|---|---|---|
| Run-up | T−8 s | Horde of 15 + L walkers/runners; fog near 40 → 32 m; music drops to drums only; HUD boss marker pulses at 1 Hz | — |
| Intro | T | Road speed lerps to 35 % over 1 s; boss walks out of the fog at 45 m; roar 0.8 s; letterbox 8 % bars; camera dolly to (0, 7, 7) looking at the boss, 1.0 s out / 0.6 s hold / 0.8 s back (skipped under reduced motion); input locked, squad invulnerable and still firing (bullets already aim at the boss); weapon and gear timers paused; quality auto-scaler frozen for the whole choreography; boss HP bar slides in under the bars; name card 1.5 s | shake trauma 0.3, haptic 80 ms |
| Phase 1 (100→60 %) | 0–8 s | Boss advances to a hold at 12 m (own speed = road speed, so it walks in place while minions arrive); every 4 s a minion burst of 6 walkers that soaks bullets; archetype basic attack | HP chunks fall in 5 % segments |
| Phase 2 (60→25 %) | | 4 armor plates fly off (bloom sparks), white flash 0.1 s, HP bar orange; archetype special; boss hold 10 m | shake 0.25, haptic 60 ms |
| Phase 3 (25→0 %) | | Rage glow red, HP bar pulsing, one last horde of 10, cadence shortened | — |
| Death | | timeScale 0.25 for 1.2 s; white flash 0.15 s (reduced motion: 150 ms dim); collapse 1.8 s real time; 60-coin fountain; 200 confetti; bloom strength 0.6 → 1.6 → 0.6 over 1.5 s; letterbox out; LEVEL COMPLETE | haptic [60, 40, 120], trauma 0.8 |
| Safety valve | fight > 45 s | Boss advances to 3 m and chews 3 soldiers/s while being shot point blank; each chew: −3 floater, red vignette pulse. The run is lost only when C = 0 | — |

Archetypes (rotation in §10):

| Archetype | Silhouette (7 m rig) | Basic | Phase 2 special | Phase 3 |
|---|---|---|---|---|
| Hulk / Brute King | 3.2× brute, car-door shield, hinged jaw | Ground slam every 5 s: 3 m ring telegraph 0.8 s, kills 3 + floor(L/2) if the formation centre is inside | Charge (1 s, 6 m/s): kills 8 % of C (min 3) unless the squad is outside the red lane stripe shown 1.2 s before; spawns 6 runners | Slam every 3 s; 2 brutes spawn |
| Spitter Queen | 2.6× spitter, bloated, 4 arms, pulsing sacs | Triple spit every 2.5 s (3 splashes, 1 soldier each; 2 from L10), 1 s arc preview | Acid rain: 8 splashes over 3 s | Spit every 1.6 s; 10 crawlers |
| Juggernaut | 4.5× walker, armour plates | Stomp every 3.5 s: kills 4 % of C (min 3) | Lane charge every 4 s: a 2.5 m-wide charge down one half, red lane stripe 1.2 s before; kills 8 % of C (min 3) if the formation centre is inside the stripe, nothing otherwise; throws a wrecked car once at 60 % (red x-band marker 3 m wide, 1.2 s): kills 12 % of C (min 4) if the formation centre is inside the band | Plates off, takes 1.5× damage, stomp every 2.2 s |
| Colossus | 7 m, exposed core, chain links | cycle = slam (r 3 m, kills 3 + floor(L/2), telegraph 0.8 s) → triple spit (1 each, 2 from L10, 1 s preview) → charge (2.5 m stripe, kills 8 % min 3, 1.2 s telegraph), one attack per 6 s cadence | Shield = 15 % of max HP, raised at 60 %; regenerates 2 % of max HP per second while up; drops after 40 weighted hits (gate-style ring gauge at the core; damage is ignored while up) | All attacks at 4 s cadence |
| Hulk Twins (L17, L25, L29) | 2 Hulks at 0.55 × table HP each (the pair holds 1.1× the table HP; the HP bar shows the sum) | as Hulk, phases per twin; one boss bar; the fight ends when both are dead | — | — |
| Colossus Prime (L20, L30) | Colossus with the ×1.25 milestone HP (the Prime multiplier and the milestone multiplier are the same ×1.25 and never stack) | as Colossus, shield 60 hits | — | — |

Boss phases are data (`phases[]` with `until`, `attack`, `interval`, `kills`/`killsPct` + `min`, `killsPerLevel`, `onEnter` actions) so a level can override the template. Kills per attack = (killsPct ? max(min, round(killsPct·C)) : kills) + floor(L·killsPerLevel). Armor plates never absorb boss attacks (slam, charge, stomp, car, chew); they absorb bites and spit only. Boss minion HP (bursts, runners, brutes, crawlers) is solved once per fight with the leak model at E = E_boss, so every minion type has a defined HP. The weighted hits that drive the Colossus shield gauge follow the gate equivalences of §8.1 (rifle bullet w, rocket 8, rail 10, laser 10/s, sniper 1, drone 0).

---

## 8. Specials

Delivery: special gate (purple, single lane paired against +A, not shootable) 50 %, crate on the road 50 % (0.8 m box with emissive seams, opens after 5 bullet hits or on contact, item icon rises 1.5 m and flies to the HUD). Specials per level = 2 + floor(L/4), cap 5; the level's newly unlocked special is guaranteed; the rest are pre-rolled from the unlocked bag by the level seed. Only one weapon active at a time: a new weapon pickup replaces and refreshes (old remaining time refunded as 25 c). One of each troop; duplicates pay 25 c. Weapon and gear timers pause during the boss intro and resume for the fight. The first pickup of each special names it with a one-line hint (round-3 FTUE: "SHOTGUN! WIDE SPREAD, SHORT RANGE", "ARMOR! EACH PLATE STOPS A BITE", "MAGNET! COINS FLY TO YOU", "A SNIPER JOINS YOUR SQUAD!" …; once ever, never for a duplicate) — a new HUD pill, a shield counter or a new trooper used to appear with no word on what it does.

### 8.1 Weapons (timed, replace the squad's fire)

Gate hit equivalences are weighted hits (×w) and are subject to the 40 hits/s intake cap.

| Weapon | Unlock | Duration | Fire pattern | DPS vs squad base | Gate hits | Visual / audio |
|---|---|---|---|---|---|---|
| Shotgun | L1 | 10 s | each shooter fires 1.2/s × 5 pellets in a ±10° fan, 14 m range, pellet damage 0.5·d·w | 1.0× close, ≈ 2.5× vs groups, 0 beyond 14 m | 1 per pellet (great gate feeder) | flat orange tracers, wide flash, bassy thump |
| Minigun | L3 | 10 s | rate ×3, spread ±5°, damage 0.6·d·w; spin-up 0.4 s | 1.8× | 3× | thin yellow tracers, continuous roar, shake 0.03 m |
| Rocket launcher | L9 | 8 s | one rocket every 0.6 s from the blob centre, 22 m/s, splash r 2.5 m, damage = 1.0 s of squad DPS to all in splash; squad keeps rifle fire at 50 % | 1.2× single, 2–4× groups | 8 per rocket | smoke trail, orange burst, trauma 0.3, FOV kick +4°, haptic 30 ms |
| Railgun | L13 | 6 s | bolt every 1.2 s through the whole road, 0.8 m wide, damage = 3.0 s of squad DPS to everything in line; squad keeps 50 % fire | 2.5× on the line | 10 per bolt | white-blue lightning, 80 ms screen flash, deep crack, haptic 60 ms |
| Laser | L14 | 8 s | one cyan beam per 5 visible shooters (min 2, max 8); each pierces every zombie in a 0.5 m line; total DPS = 2.0× squad DPS split across beams | 2.0× | 10/s per beam touching | bloom-heavy beams, hiss, zombies glow white before dying |

### 8.2 Gear

| Gear | Unlock | Effect | Duration | Visual |
|---|---|---|---|---|
| Armor plates | L2 | plates = min(C, 50); each bite consumes a plate instead of a soldier (brute swing 3, spit 1); re-pickup refills | until consumed | blue shoulder glint, plate shatters with a blue spark; shield counter beside the squad count |
| Magnet | L4 | coin pickup radius 1.2 → 5.0 m; a second magnet pays 25 c | rest of level | helmet rings glow purple |
| Fire-rate chip | L7 | fire rate +40 % (second pickup refreshes, no refund) | 20 s | tracers tint cyan |
| Damage booster | L11 | damage +50 % (not gate hits) | 20 s | thicker tracers, orange damage numbers |

### 8.3 Troops (rest of level, one of each)

| Troop | Unlock | Position | Stats |
|---|---|---|---|
| Hero sniper | L5 | left flank of the blob at mid-depth (half-width + 0.8 m to the left, never beyond x = −3.1 m), on a low crate; ×1.05 troop scale, so sniper + crate ≈ 1.3 soldier heights (round-2 QA CHR-9: the rear-centre perch hid the squad and ran off the bottom of the screen) | every 1.5 s: 40·hz·d damage to the highest-HP zombie in view (boss ×0.5, at most 5 % of the boss's max HP per shot before the boss-damage upgrade — round-3 verify: hz follows the waves, and in endless they carry the design multiple and the pressure, so an uncapped shot one-shot the mini-bosses); long red tracer, crack, crit number |
| Medic | L6 | blob centre, white cross | every 4 s: +max(1, ceil(0.02·C)) soldiers while C < E(z), cap +60 per level; green "+n" tick |
| Flamethrower trooper | L8 | front edge | cone 25°, 13 m (round-1 QA CHR-8: 7 m never engaged; the cone swings ±0.6 rad toward the nearest zombie within 15 m and a narrow jet lobs at spitters / brutes within 19 m every 1 s, else at the aimed zombie); 6·hz·d DPS to every zombie in the cone, but the cone (and a jet at anything but a spitter / brute) never takes a zombie below 25 % of its base HP — the flame burns and softens, the squad's bullets make the kills (round-2 QA CHR-12: at 15·hz·d with lethal ticks the trooper took ≈ 70 % of all kills); the jet hits for 0.5 × DPS × 1 s and can kill spitters / brutes; burning zombies take +20 % bullet damage |
| Drone turret | L10 | hovers 5.2 m up, 1.2 m right of and 2.5 m ahead of the blob centre (never beyond x = +2.8 m), clear of the count label (round-2 QA CHR-9) | 4 shots/s, each 5 % of squad DPS, nearest zombie first (runners prioritised), never hits gates |
| APC | L12 | 3.5 m in front of the blob (round-2 QA CHR-9: clear of the front rows; the count label draws over it) | hit pool 20 + 2·L bites; absorbs any bite/spit it intersects (2.4 m wide); crushes crawlers; explodes at 0 (splash 3 m, 2 s of squad DPS) |

Pickup schedule: shotgun L1, armor L2, minigun L3, magnet L4, sniper L5, medic L6, chip L7, flamethrower L8, rocket L9, drone L10, booster L11, APC L12, railgun L13, laser L14. After its unlock level a special joins the random bag.

---

## 9. Economy, shop, stars

### 9.1 Income

| Source | Coins |
|---|---|
| Zombie kill | walker 1, runner 2, crawler 1, brute 15, spitter 6, × coin multiplier; kills during a campaign boss fight × 0.25 (the minions are a soak — a longer fight, i.e. a weaker squad, must not pay more; round-3 QA LVL-23) |
| Boss kill | 15 + 5·L, × coin multiplier; 60-coin fountain is the visual (round-3 QA LVL-23: was 30 + 10·L — skill-independent income halved) |
| Any gate passed | 3; MAX gate 5; +1 per weighted hit past MAX (cap 5 per gate) (round-2 QA LVL-23) |
| Coin line | 8 coins × 1 c, 1.2 m apart, on one half |
| Crate (coins variant) | 10 |
| Level complete | (20 + 10·L) × 0.5 / 1 / 2 for 1★ / 2★ / 3★ (a 3★ clear pays the old 40 + 20·L), plus 1.4 c per survivor beyond 0.6·E_boss (round-3 QA LVL-23: the squad a better run brings home pays) |
| Replay of a cleared level | everything × 0.6 |
| Game over | keeps 50 % of run coins, plus a consolation of (20 + 10·L)·1.0·(fraction of the level reached) (round-2 QA LVL-21; round 3: the same coins with the halved level bonus) — two failures plus one win afford a new shop rank on every level L1–L12 |
| Duplicate gear/troop, replaced weapon | 25 |
| Endless | everything × 0.6 |

Expected first-clear income (round-3 measurement: a strong 3★ run with the ranks a player who spends every coin owns, docs/build/r3-balance.md): L1 ≈ 410 (the ad's squad comes home at ≈ 2·E_boss), L3 ≈ 350, L5 ≈ 480, L10 ≈ 880, L12 ≈ 1 340, L15 ≈ 1 900, L20 ≈ 3 100, L30 ≈ 4 000; a passive (never-steering) run of the same level earns ≤ 1/1.3 of it on L2–L12 (it brings fewer soldiers home and takes fewer stars). A player who clears every level once maxes the shop around L28–30.

### 9.2 Shop (permanent, 5 upgrades × 10 ranks)

Cost of rank n: round10(base · 1.4^(n−1)).

| Upgrade | Base cost | Effect | Rank 10 | Ranks 1…10 |
|---|---|---|---|---|
| Start squad | 150 | S0 = 5 + 2n | 25 | 150, 210, 290, 410, 580, 810, 1130, 1580, 2210, 3100 |
| Fire rate | 200 | f = 2.0·(1 + 0.10n) | 4.0/s | 200, 280, 390, 550, 770, 1080, 1510, 2110, 2950, 4130 |
| Damage | 200 | d = 1 + 0.15n | 2.5 | same as fire rate |
| Coin multiplier | 120 | 1 + 0.10n | ×2.0 | 120, 170, 240, 330, 460, 650, 900, 1260, 1770, 2480 |
| Boss damage | 180 | 1 + 0.15n vs bosses | ×2.5 | 180, 250, 350, 490, 690, 970, 1350, 1900, 2660, 3720 |

Grand total 59 360 c (boss damage rank 7 = 1 360; round-1 QA R8); a player who clears every level once maxes the shop around L30–34. Shop UI shows the next rank's effect delta and a "+1 run / +2 runs" estimate = ceil((cost − coins) / lastRunIncome).

### 9.3 Stars, score, results

1★ boss killed. 2★ survivors R ≥ 0.5·E_boss(L). 3★ R ≥ 0.8·E_boss(L) (round-3 QA LVL-22; was 0.75 — measured: a strong player 3★ on 12 of L1–L12, a never-steering one 1.83★ on average). R = the soldier count at the instant the boss HP reaches 0 (the squad is invulnerable and remaining minions are cleared from that instant, so the 3 s death theatre cannot cost a star). No timer. A locked level needs 1★ on the previous one. Results: stars slam in one by one (0.25 s each), coins count up at 30/s with breakdown lines, best survivors at boss, buttons NEXT / REPLAY / SHOP. Game over: "SQUAD LOST", distance %, coins kept, RETRY / SHOP / HOME.

Score (endless and best-score display): 10·Σ kill coins + 15·peakSquad + 20·R + 200·gatesFlipped + 500 if no soldier was lost to a red gate.

---

## 10. Difficulty curve (campaign levels 1–30)

Formulas: Len(L) = min(1400, 400 + 50(L−1)); v(L) = min(12.0, 8.0 + 0.2(L−1)); gate events G(L) = round(Len/100); waves W(L) = G − 1 (L ≤ 9) or G (L ≥ 10); wave population P(L) = min(24, 4 + L), bounded by the squad (§6.2); E_start(L) = min(10, 5 + floor((L−1)/4)) with the generator assuming S0 = 5 + 2·floor(min(L, 20)/2); E_boss(L) = min(600, round5(140·1.08^(L−1))); boss HP = 20·E_boss (×1.25 milestone), round 50 — the table value, scaled at spawn by §7's count and shop scales. Milestone (big) bosses at L5, 10, 15, 20, 25, 30. Fail-streak assist (round-2 QA LVL-21): after 2 consecutive failures of the same level in a session, the next attempt starts with + ceil(0.08·E_boss·k) soldiers, k = 1, 2, 3, 4 for each further consecutive failure (shown by the normal count roll-up and announced by the hint "REINFORCEMENTS: +N SOLDIERS"; reset on a clear) (round-3 QA LVL-21: 0.25·E_boss compounded through the gates into a 3★ run for a player who had just failed twice). A RETRY after a failure plays a fresh layout: a generated level's seed is 1000 + L + 100·(consecutive failures) (round-3 QA LVL-21); a replay after a clear and a restart from the pause menu keep the seed, and the authored L1 always plays seed 1001 (§11).

| L | Len | v | Run (s) | Gates | Waves | Pop | E_boss | Boss | Boss HP | New |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 400 | 8.0 | 50 | 4 | 3 | authored | 140 | Hulk | 2 800 | walker, shotgun |
| 2 | 450 | 8.2 | 55 | 5 | 4 | 6 | 150 | Hulk | 3 000 | runner, armor |
| 3 | 500 | 8.4 | 60 | 5 | 4 | 7 | 165 | Hulk | 3 300 | crawler, minigun |
| 4 | 550 | 8.6 | 64 | 6 | 5 | 8 | 175 | Hulk | 3 500 | brute, magnet |
| 5 | 600 | 8.8 | 68 | 6 | 5 | 9 | 190 | **Spitter Queen** | 4 750 | spitter, sniper |
| 6 | 650 | 9.0 | 72 | 7 | 6 | 10 | 205 | Hulk | 4 100 | x3 gates, medic |
| 7 | 700 | 9.2 | 76 | 7 | 6 | 11 | 220 | Hulk | 4 400 | triple gates, chip |
| 8 | 750 | 9.4 | 80 | 8 | 7 | 12 | 240 | Spitter Queen | 4 800 | ÷3 gates, flamethrower |
| 9 | 800 | 9.6 | 83 | 8 | 7 | 13 | 260 | Hulk | 5 200 | brute pairs, rocket |
| 10 | 850 | 9.8 | 87 | 9 | 9 | 14 | 280 | **Juggernaut** | 7 000 | drone; endless unlocks |
| 11 | 900 | 10.0 | 90 | 9 | 9 | 15 | 300 | Spitter Queen | 6 000 | runner packs, booster |
| 12 | 950 | 10.2 | 93 | 10 | 10 | 16 | 325 | Hulk | 6 500 | APC |
| 13 | 1000 | 10.4 | 96 | 10 | 10 | 17 | 350 | Juggernaut | 7 000 | spitter+brute waves, railgun |
| 14 | 1050 | 10.6 | 99 | 11 | 11 | 18 | 380 | Spitter Queen | 7 600 | laser |
| 15 | 1100 | 10.8 | 102 | 11 | 11 | 19 | 410 | **Colossus** | 10 250 | — |
| 16 | 1150 | 11.0 | 105 | 12 | 12 | 20 | 445 | Juggernaut | 8 900 | crawler swarms |
| 17 | 1200 | 11.2 | 107 | 12 | 12 | 21 | 480 | Hulk Twins | 9 600 | — |
| 18 | 1250 | 11.4 | 110 | 13 | 13 | 22 | 520 | Spitter Queen | 10 400 | — |
| 19 | 1300 | 11.6 | 112 | 13 | 13 | 23 | 560 | Juggernaut | 11 200 | — |
| 20 | 1350 | 11.8 | 114 | 14 | 14 | 24 | 600 | **Colossus Prime** | 15 000 | — |
| 21–30 | 1400 | 12.0 | 117 | 14 | 14 | 24 | 600 | rotation: Hulk, Spitter Queen, Juggernaut, Colossus, **Hulk Twins** (L25), Spitter Queen, Juggernaut, Colossus, Hulk Twins, **Colossus Prime** (L30) | 12 000; 15 000 at L25 and L30 | — |

Beyond L21 difficulty rises only through the leak band (28–32 %), speed 12 m/s (gate window 2.9 s) and type mix; E_boss stays 600 so gate values stay readable.

Validator status (round 5): `node tools/validate-levels.js` reports 0 errors and 7 warnings, each accepted here. (1–4) L1's four authored waves: the leak model predicts 0–5 % because the authored script carries no level calibration (its waves carry play-measured `hpMult`, round-2 QA LVL-15); the on-curve lab measures 12.9–14.3 % (r3-balance, r3-balance-audit), inside the 10–15 % band, and L1 stays the GDD §11 transcription. (5) L6, no-steer line 88 % of E_boss (limit 85 %): none of the generator's 24 attempts on the canonical seed holds the limit; the x3 introduction pair puts its bet on the left lane the never-steering squad holds (a round-3 residual, re-checked unchanged). (6–7) L13 and L19, weak-shooter line 16 % and 5 % of E_boss (floor 20 %): on the canonical seeds every one of the 32 attempts either breaks the full-intake cap (an error) or leaves the weak line under the floor — the late single −A gates (A ≤ 0.9·H) cost a 0.3·H shooter ≈ 0.6·H each. Measured on those levels: the never-steering bot clears L13 at once (1★) and L19 at the second attempt; the always-worst-lane bot clears both by its fourth (docs/build/r5-level-balance.md). After L30 the campaign loops at L30 parameters with a new seed (seed = 1000 + L).

### 10.1 Endless mode (unlocked after L10)

Endless MUST end (round-3 QA LVL-17): every run is a sprint into a rising horde and how far it gets is the skill test — a strong player (lane picking, shop ranks 3) dies at chunk ≈ 9–14 (≈ 4–7 min), a player who never steers on a fresh save at chunk ≈ 3–5, and nobody gets past chunk 25 at shop ranks ≤ 3 (measured over 12 seeds, docs/build/r3-balance.md; the independent audit, docs/build/r3-balance-audit.md, on 12 other seeds: a near-maxed shop, ranks 6–10, reached chunk 26–27, ≈ 12 min, on 1 seed in 12; round 4, 36 seeds: rank 10 passes chunk 25 on 3 of 36, rank 6 on 0 of 24; `LEVELS.endless.pressure.perD` is the lever if that tail must go).

Road generated in 300 m chunks with difficulty index D (1, 2, 3 …): speed min(12, 9 + 0.15·D); E(z) = min(600, 150·1.06^D); gate events per chunk 3 (D ≤ 4) then 2; waves per chunk min(3, 2 + floor(D/4)) plus, from chunk 12, one more wave every 8 chunks (at most 2 more: 4 from D12, 5 from D20 — `LEVELS.endless.waves.extraFromD / extraEveryD / extraCap`), population per wave min(32, 8 + 4·D) before the pressure (round 5d, the lead's config T3: round 3's min(16, 10 + 2·D) and the cap at 3 waves are gone, the ramp lives in numbers — docs/build/r5d-endless.md); mini-boss every 5th chunk (Hulk / Juggernaut / Spitter Queen rotating, HP = 30·E × §7's count and shop scales — round 5c: without the pressure, which its attack kills keep (`miniBossHpShare` 0 / `miniBossKillsShare` 1) — no road slow-down, no letterbox; its chunk gives up one wave (`miniBossWaveCut`), its waves make contact at least 100 m before the boss spawns and the chunk after it holds its waves 100 m (`miniBossLeadM` / `miniBossTailM`); its minions are soak, solved like a campaign boss's at E(D) without the pressure (`miniMinions`)).
- **Pressure** (round 3): from chunk 4 on, p = 1.07^(D − 4) multiplies wave HP and wave population (each type within a quarter of its pool), the mini-boss's HP and every one of its attacks' kills, and divides the most a gate may add (below). Death comes as a horde the squad can no longer thin out — for a steering player, bites and spit, not a single unfair blow (measured: bites + spit are 87–96 % of the losses and the count falls over a median of 3.5–5.5 chunks); a never-steering squad usually ends on a red gate (gates take ≈ 20 % of its soldiers, docs/build/r3-balance-audit.md §1.3).
- **Waves**: designed for a squad of 9·E(D) (the leak model's capacity × the troops and specials an endless run piles up), ramped in from ×1 in chunk 1 to ×9 from chunk 3; solved at E(D), never at the live count (a squad that stays big is rewarded, not chased), with no shop compensation (the shop is what carries a strong player deeper: round 4 measured the anticipating bot over 36 seeds, docs/build/r4-level.md, at a median death chunk of 8 / 10 / 13 at shop ranks 0 / 3 / 10 — a paired per-seed gain of + 4 chunks from rank 0 to rank 10, + 1 to rank 3; round 3's "≈ 1 chunk" predates the sniper's boss-shot cap. `LEVELS.endless.profileExp` (0) only damps the shop: p^profileExp with p = fire rate × damage multiplies the wave HP, so a positive value shortens a high-rank run) and the band midpoint of the equivalent level (L10 + D).
- **Gate values stop growing past the E cap**: gates are sized from E(min(D, 4)) and no lane may add more than 0.35·E(4) / p soldiers — every lane of an event is scaled by the same factor (a × lane on a big squad becomes the + lane worth its scaled gain), so the better lane stays the better one; while the worst case of the gate events still ahead exceeds 2·E their × lanes become small + lanes and + / − lanes are capped at min(0.5·E, 2·E − that worst case) (round-2 QA LVL-17).
- **Rubber band, low side only**: if C < 10 at a chunk boundary the next gate event is a guaranteed + pair with base max(8, 0.3·E) and no red lane. A squad above the curve is never pulled back by a ÷2 | ÷2 gate any more (round 2's high band is gone).
- **Numbers, never HP (round 5d, lead decision)**: the pressure's HP part is moot above the per-zombie HP cap of §6.3 (`LEVELS.endless.hpCapSeconds`: walker 0.5 s, runner 0.4, crawler 0.35, brute 3.0, spitter 1.2 of the on-curve squad's design DPS); the pressure rides on the population (`pressure.popShare` 1, baked into each chunk's wave units by the generator, so the validator counts the real pools). Root cause (docs/build/r5d-endless.md): endless wave zombies carried the chunk pressure as HP, so one brute at the formation front soaked all fire for 10–100 s while swinging 3 soldiers a second — a wall, with the mini-boss fight stacked on it.
- **Mini-boss hold (round 5d)**: from the mini-boss's spawn to its death the road's gates, waves, crates and coin lines wait (the script cursor stops; chunk, district and score bookkeeping go on; the boss's own minions are its own); at the kill every event still ahead, and every chunk generated after it, slides by one shift so the first held event spawns `LEVELS.endless.miniBossHold.releaseM` (60) m after the kill — nothing is dropped and nothing lands on the squad's cleanup of the boss's last horde. Before it, a 35-s fight let the next chunk's ÷3 | −140 gate and 25–48-zombie waves arrive mid-fight.
- **Pool-safe by construction (round 5d)**: the pools are walker 120 / runner 60 / crawler 40 / brute 16 / spitter 24 (§6.2). A wave carries at most a quarter of every pool (`wavePoolShare` 4: 30/15/10/4/6, 65 zombies), a type's excess moving into the other types' headroom under the same shares; once a wave of the chunk's population would exceed that (from chunk 15, where pop passes 65), the population the chunk owes (pop × its wave count above) spreads over more, smaller waves — at most 6 per chunk with contacts ≥ 30 m apart inside the chunk's wave window (`waves.maxPerChunk / minSpacingM`; the mini-boss chunk's 40-m window and the chunk after it keep their counts) — so the ramp continues as wave frequency instead of silently dropped spawns until the window is full (6 waves of 65 from chunk 22). The generator then fits every chunk's waves so that, counting the waves and gate guards alive at once (a zombie lives from its spawn to its contact), each type stays within pool − reserve, the reserve (`poolReserve` 6/6/10/2/2) being the rotation's minion union so the mini-boss's own spawns always fit (spitters, never a minion, keep 2 slots for bodies still toppling); `tools/validate-levels.js` checks every chunk and the whole run (D1–30) against the pools and prints each chunk's waves, population per wave, horde delivered / owed and peak pool use; the level runner clamps each wave and guard spawn to pool − alive − reserve as a live backstop (trims counted in `ctx.debug.dropped['level.waveClamp']`). Before it, a mini-boss chunk's four waves all landed on one metre (the one-wave-per-gate nudge) and the walker pool overflowed at chunk 20 (126 of 120) and at 25–26.
- **Measured (round 5d, docs/build/r5d-endless.md)**: the fast runner on 12 new seeds (12007 + 47·i), the same seeds through the T3 code and the pool-safe code — every paired median is unchanged: smart r0 / r3 / r6 / r10 die at chunk 7 / 9 / 12 / 15 (ranges 7–12, 8–17, 10–19, 13–23), strong r0 / r3 at 7 / 9, passive r0 / r3 at 4 / 7; nobody past chunk 25 at any rank; 93 of 96 deaths are horde deaths (the three "mini-boss" ones are squads that reached the boss already dying to waves); the first mini-boss is killed 12/12 in every steering config, every mini-boss 128 of 130, TTK medians 8–15 s, no fight over 40 s; the T3 code's refused spawns (walker 6, brute 6, spitter 15 over 96 runs) are down to 2, the live clamp trims 0–36 zombies per 12 runs. Real time (`tools/smoke.js --endless --seconds 330`, seed 777): at rank 3 the first mini-boss dies in 13 s with its HP falling at every sample, no gate, wave or crate during the fight and no zombie-pool drop; at rank 0 the smoke bot (face-value lanes, no dodging) reaches it with 130 soldiers at E 201 and loses at 887 / 6000 after 40 s under the same conditions — a weak entry, not a wall.
- **Score** = (metres + 10·kills + 25·gate passes + 500·mini-boss kills) × p, ×2 for every 60 s with zero deaths (resets on death): surviving under pressure pays.

Ends at C = 0; results show distance, score, best, coins (×0.6).

---

## 11. Level 1 script (fixed, seeded; replay after a fail reuses seed 1001)

`at` is the road distance at which the object spawns at the horizon (z = −70). Gates arrive 70 m later; walkers (9 m/s closing) arrive ≈ 62 m later. HP values are authored (the leak solve for the on-curve E-trace). Hints fire once ever and are persisted.

| at (m) | Event | Detail |
|---|---|---|
| 0 | hint | `steer` (hidden as soon as the player has steered) |
| 0 | gates pair | L +5 (cap 20), R +2 (cap 6, round-2 QA LVL-22); hint `shoot` on the first registered hit; hint `more` on pass if C ≥ 15 |
| 28 | wave `line` | 6 walkers HP 27 (wave A; contact at ≈ 90 m = 11.3 s); hint `bite` fires on the first soldier bitten after this wave spawns |
| 66 | gates pair | L x2 (step 80, cap 5; round-2 QA LVL-22), R +10 (cap 40); hint `x2` ("×N MULTIPLIES YOUR SQUAD", N = the applied multiplier, round-2 QA LVL-33) on pass through the x2, `tryx2` on pass through the +10 only if the x2 would have given more |
| 90 | crate | shotgun at x = +2.0 |
| 133 | hint | `crate` (round-3 FTUE: inside the 66 m pair's commit window — gate at z −3 m, the lane already locked — so it cannot pull the player off the ×2; the crate is 27 m out, 3.4 s to steer; round-2 QA LVL-24 had it at 120, while the choice was still open) |
| 110 | wave `horde` | 10 walkers HP 34, 2 runners HP 23, spread 8, hpMult 1.5 (play leak was ≈ 0 %; round-2 QA LVL-15) |
| 170 | gates pair | L −15 (flip cap +15), R +6 (cap 24); hint `red` at spawn |
| 200 | wave `line` | 8 walkers HP 40, hpMult 2 (round-2 QA LVL-15) |
| 266 | gates pair | L x2 (step 86, cap 5), R +25 (cap 75: the worst-lane route no longer earns 3★; round-2 QA LVL-22) |
| 300 | runup | 18 walkers HP 45 + 4 runners HP 30 in 4 bursts, 2 s apart, hpMult 1.5 (round-2 QA LVL-15) |
| 400 | boss | Hulk, HP 2 800 (table, scaled per §7), phases per §7; hint `boss` fires at `boss:fight`, not at the spawn (round-2 QA LVL-25); hint `dodge` ("STEER CLEAR OF THE MARKS!") on the first telegraphed `boss:attack` — every level's boss, once ever (round-3 FTUE) |

E-trace (cautious line, round-2 QA LVL-22): 5 → 25 → 24 → 44 (+10 maxed) or 72 (x3) → 42/70 → +6 MAX → 66/94 → 64/92 → +25 MAX (cap 75) → 139 (or x2→x3 → 192/276) → run-up −6 → ≈ 133 cautious / 270 greedy. Target 140 ± 15 % on the cautious line; 3★ (112 survivors = 0.8 × 140, round 3) is the on-curve result; 2★ (70) is reachable with one misread; the worst lane at every pair (+2 → +10 → −15 flipped → +25) no longer reaches 3★. The script's `expected` samples ARE the cautious line — `[{0, 5}, {70, 25}, {136, 44}, {160, 42}, {240, 66}, {262, 64}, {336, 139}, {362, 133}, {400, 133}]` as (at, e) — and every default cap and the medic cap are computed from it.

---

## 12. Juice: every trigger → effect

Timings are real time. "Trauma" feeds the screen shake: shake = T², decay 1.2/s, camera offset (0.35·noise, 0.25·noise, 0) m, roll 2°; summed shake clamped at 0.3 m; ×0 under reduced motion. Global caps: ≤ 1024/512/256 live particles by tier, ≤ 24 floaters, ≤ 12 voiced gunshots/s, gate ticks coalesced to ≤ 1 per 40 ms per gate. The gate tick, the count ticker and the number pop are always on at every tier.

| # | Trigger | Visual | Duration | Sound | Haptic |
|---|---|---|---|---|---|
| J1 | Soldier fires | muzzle flash quad 0.35 m additive #FFE38A 2 frames; tracer 0.9 m HDR (3.0, 2.6, 1.6); recoil 0.06 m | 33 ms | `shot` (≤ 12 voiced/s, +1 dB per 8 shooters, cap +12 dB) | — |
| J2 | Bullet hits zombie | 4 sparks #FFF1B0, hit-flash 60 ms, HP bar chunk | 60 ms | `thip` | — |
| J3 | Bullet hits gate | glyph pop scale 1 + 0.28·decay (120 ms), panel emissive flash tinted, rate-limited, capped at 0.45 under sustained fire (round-1 QA GAT-1), 3 sparks at impact | 120 ms | `tick` pitch 620 + 6·(value − base) Hz, clipped at 2.2 kHz | — |
| J4 | Gate reaches MAX | frame → #FFD166, "MAX" badge scale 2 → 1 in 0.2 s, 12 gold sparks | 0.3 s | `max` chime 880 → 1320 Hz | 20 ms |
| J5 | Red gate hits 0 | 0.25 s white flash, red → grey → blue 400 ms, glyph swap, 16 blue sparks | 0.4 s | `flip` noise sweep 300 → 3 kHz | 30 ms |
| J6 | Multiplier step | panel scale punch 1.35×, ring 360° wipe, glyph pop 1.5× | 0.25 s | `whomp` 90 Hz + 45 Hz | 25 ms |
| J7 | Gate pass (positive) | panel shatters into 24 shards toward the camera 0.4 s; soldiers spawn staggered; count tween; "+N" burst; trauma 0.15; 0.6 s invulnerability | 0.6 s | `pass_up` C-E-G-C arpeggio + `hup` chorus (voices = min(8, N/4), ±4 % detune) | 40 ms |
| J8 | Gate pass (negative) | shards fly away, red vignette 0.2 s, rear soldiers dissolve rim-inward | 0.5 s | `pass_down` G → C# | [30, 30, 30] |
| J9 | Zombie dies | 8 blood particles #6E1A1A, topple, sink, coin pop to HUD | 0.75 s | `crunch` shared per 50 ms, +3 dB per extra kill, cap +9 dB | — |
| J10 | Soldier dies | topple, 6 blood particles, "−1" floater, count snap + red flash | 0.7 s | `ugh` | 15 ms |
| J11 | Brute swing | red ring fills 0.8 s, then trauma 0.35 | 1.1 s | `roar` then `thud` | 50 ms |
| J12 | Crate opened | lid pops, item icon rises 1.5 m and flies to the HUD pill, pill flashes | 0.6 s | `pop` + `jingle` | 20 ms |
| J13 | Power-up starts | rifles recolour (emissive), HUD pill with conic ring, screen-edge glow in the weapon colour 0.3 s | 0.3 s | weapon `sting_*` | 30 ms |
| J14 | Power-up last 2 s | pill ring blinks at 2 Hz | 2 s | `ticktock` | — |
| J15 | Boss phase change | white flash 0.1 s, trauma 0.25, armor plates fly off with bloom sparks | 0.5 s | `crash` metallic | 60 ms |
| J16 | Boss death | timeScale 0.25 for 1.2 s, white flash 0.15 s, 60-coin fountain, 200 confetti, bloom 0.6 → 1.6 → 0.6 over 1.5 s, trauma 0.8 | 3.0 s | `roar` at rate 0.4 then `fanfare` | [60, 40, 120] |
| J17 | Level complete | stars slam in (scale 3 → 1, 0.25 s each), coin count-up 30/s | 1.5 s | `chime3` | 20 ms × stars |
| J18 | Game over | desaturate 0.8 s, camera drops 1 m, slow 10° orbit (static under reduced motion), "SQUAD LOST" | 1.2 s | `drone_down` | 100 ms |
| J19 | Coin pickup | coin flies to the HUD icon over 0.4 s (bezier), icon punch 1.2× | 0.4 s | `coin` +1 semitone per coin within 0.5 s | — |
| J20 | Near-miss (zombie dies within 1.5 m of the squad) | time dip 0.85× for 0.1 s, dust puff | 0.1 s | — | — |
| J21 | Rocket / railgun | rocket: trauma 0.3, FOV kick +4°; railgun: 80 ms white screen flash | — | `rocket` / `rail` | 30 / 60 ms |
| J22 | Spit impact | green splash decal 1.2 m, 10 green particles | 0.5 s | `splat` | 15 ms |

---

## 13. Audio

All sounds are synthesised in WebAudio at runtime (no files). Graph (amended round 2): buses → `DynamicsCompressor` (threshold −18 dB, **knee 6 dB**, ratio 6, 3 ms / 120 ms) → safety limiter (a second `DynamicsCompressor`: −1 dB, knee 0, 20:1, 1 ms / 50 ms, then a WaveShaper soft clip whose ceiling is below 0 dBFS) → master (mute) → destination; the destination never receives a sample ≥ 0 dBFS. Buses: sfx (−12 dB), gunfire (−16 dB, 12 voices), music (−14 dB) — 6 dB lower than round 1 to offset the compressor's automatic makeup gain once the knee is 6 dB; the gameplay bed stays ≈ −20 to −22 dBFS RMS. A fourth bus, **reward** (−7 dB; `pass_up`, `hup`, and since round 4 the J5 `flip` and the five J13 weapon stings), skips the compressor and meets the compressed bed at the limiter (round-3 QA AUD-10: compressed together with the gunfire, the 6:1 ratio held the gate-pass reward only 3–5 dB over it whatever its gain). The Sound and Music sliders are linear in amplitude (round 4): 50 is −6 dB, 80 is −1.9 dB, 10 is −20 dB, 0 is silent (the squared law made Sound 50 −12 dB and sank every sfx under the music at its default 80); the music bus is −15.94 dB so the default mix (Sound 100, Music 80) is where the squared law had it, and at Sound 50 / Music 80 the gate-pass reward still rises above the music bed. Round 5 (lead decision): the Music slider defaults to **70**, and while Music is above Sound the reward bus (gate pass, flip, stings) is lifted toward the Music fader by at most 6 dB (`MUSIC.rewardLift`): Sound 0 is still silent and Sound ≥ Music (the defaults) is unchanged, and at Sound 50 / Music 80 or 70 the gate-pass reward rises ≥ 6 dB over the bed (measured 6.7 / 7.3 dB min / median at Music 80, 6.3 / 7.1 at Music 70, 6.6 / 7.2 at C = 300; before: 3.0 / 3.9 and 3.7 / 4.5). The AudioContext and graph are built at boot (behind the boot bar; 'suspended' until a gesture, retried inside a gesture if construction failed) and resumed on every gesture (`pointerdown`, `pointerup`, `touchend`, `click`, `keydown`) until it reports `running`, so the first tap never pays the context construction; iOS interruptions re-arm the gesture wait. Music ducks −6 dB during gate passes; at the boss death it dips −10 dB under the roar and fanfare for 2 s and then fades out (it does not return before the results); −12 dB while paused (music keeps playing while paused). The gunfire bus ducks −9 dB for 0.45 s on gate passes, weapon pickups and gate flips; on a positive gate pass, a gate flip and a weapon sting (round 4) the whole compressed bed (gunfire, sfx and music, after the compressor) also dips −4 dB for 0.35 s under the reward bus; a reward moment that starts less than 0.45 s after another plays −5 dB, so two rewards never sum into the limiter. The pass reward's loudest 50 ms reads ≥ 6 dB over the surrounding 1 s of gunfire (music included) at every squad size (round-3 QA AUD-10; measured ≥ 7.4 dB, median 8–9 dB, at C = 5, 25, 100 and 300); so do the J5 flip and the J13 stings since round 4 (measured ≥ 6.2 dB, medians 7.0–8.4 dB, at C = 25 and 300, with no sample above the soft-clip knee in their windows; before: 1.7–5.6 dB, laser aside). The first use of a cue costs no more than its later uses: the oscillator types and every recipe are built once, silently, behind the boot bar, the 2× WaveShapers of `roar` / `thud` are reused, and a cue scheduled ≥ 0.2 s ahead (the fanfare, boss stomp landings) is built just before it sounds. Round 5: the 8-voice `hup` chorus, `pass_up`, the boss-intro and brute `roar`, the `fanfare` and the music pad's chords are rendered once behind the boot bar, by the same synthesis code into an OfflineAudioContext, and then play as one buffer source (a big gate pass: 4 nodes instead of 46, ≈ 1.5 ms instead of ≈ 15 ms at 4× CPU; a pad downbeat: 2 nodes instead of 18); the sound is the same (deterministic instances match sample for sample up to the oscillator start phase; chorus and noise instances keep 2 random variants). A play the buffers do not cover (another pitch, slow-mo on a cue that follows it) is synthesised live as before. Identical cues started in the same frame never sum phase-coherently: `ugh` / `thud` / `roar` / `pop` / `screech` / `hup` merge within 40 ms into one instance, +2 dB per extra (cap +6); other cues play at most 2 same-frame copies, the second offset 5–15 ms with ±5 % pitch. Music mode changes land on the next beat (≤ 0.5 s); `level:start`, `boss:fight` and the title restart the loop at bar 0 (the old mode's notes fade out over 120 ms). `timeScale` maps to a rate of 0.6 + 0.4·scale (buffer sources via playbackRate, oscillators via detune, the music scheduler via its beat interval), applied to sounding sources and to sources already scheduled to start later; reward / UI stings (`fanfare`, `chime3`, `pass_up`, `ui_*`) ignore it. Gameplay-critical low cues carry a mid-band layer so they keep their identity on a phone speaker (≤ 8 dB loss through a 400 Hz high-pass; the brute / boss `roar` too since round 3).

| Cue | Recipe |
|---|---|
| shot | white noise 40 ms → band-pass 1.2 kHz Q 0.7, + sine 180 → 60 Hz over 60 ms; ±8 % random rate |
| thip | noise 20 ms → band-pass 2 kHz |
| tick | sine f = clamp(620 + 6·(value − base), 620, 2200) Hz, 40 ms, attack 2 ms, exp decay 35 ms |
| max | triangle 880 Hz 80 ms then 1320 Hz 120 ms |
| flip | noise, band-pass (Q 0.8) sweep 300 → 3 000 Hz over 150 ms, held to 110 ms (attack 10 ms), + triangle 330 → 1 320 Hz under it (round 4); reward bus, panned but not distance-attenuated |
| whomp | sine 90 Hz 250 ms + sine 45 Hz 300 ms, pitch drop 15 %, + sawtooth 180 → 153 Hz band-passed 600 Hz + 60 ms band-noise thump |
| pass_up | square → low-pass 1.8 kHz, C5 E5 G5 C6, 60 ms each (gain 0.8, attack 6 ms, held 30 ms), starting 15 ms after the pass (clear of the gate coin's onset); reward bus, always at rate 1 (round-3 QA AUD-10) |
| pass_down | square G4 → C#4, 120 ms each |
| hup | sawtooth 220 Hz 70 ms (attack 10 ms, held 40 ms) → band-pass 700 Hz, the crowd's answer right after the arpeggio (255 ms); N voices detuned ±4 %, max 8, spread across ±0.7 pan (one voice centred); per-voice gain 1/n^0.2 (8 voices ≈ +5 dB over one, and wide); reward bus (round-3 QA AUD-10) |
| crunch | brown noise 80 ms → low-pass 800 Hz, gain spike |
| ugh | sawtooth 180 → 120 Hz, 90 ms |
| roar | sawtooth 70 Hz + noise band-passed 900 Hz + sawtooth 140 Hz band-passed 800 Hz, 0.6 s, waveshaper curve 0.6, layer gains 0.3 / 0.36 / 0.42 (round 3: ≈ 7 dB phone loss, was 13.5); boss intro (pitch 0.6) and boss death (pitch 0.4, ×2.5 length) at volume 0.4 |
| thud | sine 60 Hz 150 ms (waveshaper 0.3) + 1.2 kHz band noise 90 ms → low-pass 1.8 kHz |
| pop | sine 600 → 900 Hz 60 ms |
| jingle | triangle E5 G5 B5, 90 ms each |
| sting_shotgun / minigun / rocket / rail / laser | reward bus, each ≈ −12.5 dBFS loudest 50 ms with peaks ≤ −4.6 dBFS (round 4). shotgun: 1.2 kHz band noise 120 ms → low-pass 2.5 kHz + sine 140 → 60 Hz, both held 60 ms, + square 320 → 140 Hz "chk" → low-pass 1.5 kHz; minigun: 4 shots at 50 ms + square 220 → 660 Hz spin-up whine → low-pass 1.4 kHz; rocket: sine 300 → 60 Hz 400 ms + band noise + sawtooth 600 → 240 Hz, held 100–150 ms; rail: noise sweep 8 kHz → 200 Hz 300 ms (Q 1.2, held 60 ms) + triangle 1 760 → 220 Hz; laser: sine 1200 Hz + 1207 Hz beat 400 ms |
| ticktock | sine 1000 Hz 30 ms every 0.5 s |
| crack (hero sniper) | noise 30 ms → band-pass 3 kHz Q 2 + sine 900 → 300 Hz 80 ms |
| crash | noise 300 ms + sines 523 / 711 / 947 Hz decaying 400 ms |
| fanfare | triangle C5 E5 G5 C6 E6 G6, 110 ms each, + sawtooth bass octave; 0.9 s after the boss-death roar, always at rate 1 (C major even inside the slow-mo) |
| chime3 | triangle 880 / 1109 / 1319 Hz, 150 ms each |
| drone_down | sawtooth 110 → 55 Hz over 1.2 s, low-pass 1.2 kHz, + square 220 → 110 Hz band-passed 800 Hz |
| coin | sine 1760 Hz 80 ms + sine 2637 Hz 50 ms, +1 semitone per coin within 0.5 s (resets) |
| splat | noise 100 ms low-pass sweep 2 kHz → 300 Hz |
| screech | sawtooth 1400 → 900 Hz 250 ms, band-pass 1.2 kHz |
| ui_tap / ui_buy / ui_star | sine 880 Hz 40 ms / triangle C5 E5 100 ms / triangle 1319 Hz 120 ms |

Music: a live scheduler (100 ms lookahead on `AudioContext.currentTime`), 120 BPM, 8-bar loop in A minor: kick sine 50 Hz 120 ms (+ a 2 ms high-passed noise click), snare noise 100 ms, hats noise 30 ms 16ths, bass square 16th pattern, lead triangle 4-note motif. Variants: `menu` (no drums, pad only), `level` (full), `runup` (drums only), `boss` (half-time drums, bass one octave down, low drone). Never a prerendered buffer. `?nomusic=1` and the Music slider silence it.

---

## 14. UI screens

All UI is DOM over a fixed canvas; the UI layer is transparent to touches except on buttons, cards, sliders and modal panels, so a drag anywhere else steers. Root scale `--ui` is a unitless number recomputed on every resize from the app box: `clamp(0.85, min(width/390, height/844), 1.25)`; safe-area paddings on all four edges; type scale 56/40/28/22/17/14/12 px × `--ui`, with a 12 css px floor for body and readout text (the 14 / 13 / 12 px steps never drop below 12.5 / 12 / 12 px on small phones or in landscape, round-2 QA UI-27); buttons primary 280 × 64, secondary 132 × 52 / 280 × 52, icon 48 × 48; hit areas ≥ 48 × 48; fonts Lilita One (display, numbers) + Nunito 600/800 (body); bottom 180 px of the viewport is a thumb zone kept free of interactive chrome in-game (non-interactive elements that let drags pass through, such as the tutorial hint pill, are exempt — round-2 QA UI-18).

| Screen | Content |
|---|---|
| Boot | logo (round 4: hidden until Lilita One has loaded or 1.2 s have passed, then a 0.2 s fade — a first visit no longer shows it in the fallback face and swaps it), progress bar (texture build ≈ 120 ms + font wait ≤ 1.5 s), error box if boot fails; the bar moves with the measured work of each step and never freezes: no painted gap > 300 ms on a mid-range phone (4× CPU throttling lens), the shader warm-up and the menu / HUD first-raster prewarm run a little per frame (round-3 boot polish, VIS-17 / CORE-9) |
| Title | 3D scene idles behind (squad marching, gates sliding, no zombies; round 5: once a decorative gate pair has passed the squad it sinks into the road, 2 m per metre, so it never sweeps through the camera's near field on landscape / desktop; round-5 art review: that camera also sits 0.75 m inside the right-hand row of streetlights, so while the title rig is on the lamp row beside the camera — and its light pools — is cleared, and it is back for the run); logo gradient #FFB02E → #FF7A2F with 4 px outline, 2 s bob; settings gear top-left; coin pill top-right; PLAY (continues at the highest unlocked level); caption "LEVEL 7 · Best ★★★" (round 3: the level label is spelled "LEVEL 7" everywhere — HUD, title, results, game over, UI-33); SHOP and LEVELS; ENDLESS button once unlocked; round 5: a small second caption line names the district the title scene shows ("DISTRICT 3 · NIGHT CITY" with its accent dot); a small "Update ready — tap to reload" pill at the bottom when a new build has installed in the background (standalone PWA only; a launch always runs one build, the pill or the next launch switches); version micro text; every SHOP button (title, results, game over) wears a pulsing red "!" badge while the coins buy at least one more rank (round-3 FTUE: a first clear pays 300–400 coins, enough for every rank-1 upgrade, and nothing pointed a new player at the shop) |
| HUD | pause 48 × 48 top-left; level progress bar 220 × 14 centred (fill #3BE57A, squad triangle marker, skull at 100 % pulsing during the run-up, special-gate ticks) with "LEVEL 7" label (round-2 QA UI-33: one spelling across HUD, title and results); round 5: the district banner — a hint-style pill "DISTRICT 2 · OVERCAST HIGHWAY" with a 3 px rule in the district's accent, centred in the power-up row (one row lower while a power-up pill is up; top-left on landscape phones), 1.6 s (fade and 6 px rise in, hold, fade out; opacity only under reduced motion; held while paused), at a run start in a new district (not on RETRY / REPLAY / RESTART) and at every endless rotation, never under the boss bar or on the title (docs/DISTRICTS.md §5); coin pill 96 × 36 top-right; up to 3 power-up pills 88 × 36 centred at safe-top + 70 with 32 px conic-gradient rings around a light 22 px disc under a 20 px pictogram (round 4: the dark-outlined pictograms — shotgun, minigun, rocket — read as dark blobs at 18 px straight on the dark pill, r3 FTUE); boss bar 330 × 18 at safe-top + 110 with name and phase ticks at 60 % / 25 %; letterbox bars; shield counter beside the squad count (hidden while the count is off screen, e.g. during the boss-intro dolly — round 3); tutorial hint: a compact bottom-anchored pill at safe-bottom + 28 under the squad (round-2 QA UI-18; hand icon 32 px inside it for the steer / shoot hints — both sway like a drag: the shoot hint's tap bounce taught tapping, which does nothing, round-3 FTUE — 20–22 px text, max-width 86 %, 72 % panel alpha, never over gates, zombies, the boss or the count label; on wide screens it slides sideways off the count label), 2.5 s each, queued and shown once in turn (UI-25) — 1.5 s when another one is waiting (round-3 FTUE: L1 fires four lessons within 5 s around its second gate); a no-break space before every em dash, so a two-line hint never starts a line with "—"; damage vignette |
| Pause | dim rgba(8,12,22,0.72) (+ 6 px backdrop blur on High); panel 330 × 380 (landscape phones: RESUME over one row of RESTART / SETTINGS / QUIT, so the panel clears the HUD top row — round 3); RESUME, RESTART, SETTINGS, QUIT; audio ducks −12 dB and music keeps playing; the frame loop keeps running (screen effects and UI animate), the 3D scene is redrawn at 30 fps on High and only when something changed (resize, settings) on Medium/Low |
| Settings | rows 56 px: Sound slider, Music slider (a new profile starts at 70, round 5 lead decision; a saved value is never changed), Haptics toggle, Quality segmented Auto/Low/Med/High, Reduced motion toggle (defaults from `prefers-reduced-motion`), High-contrast gates, Large text, Drag sensitivity 0.75/1/1.3, Reset save (a text-style danger button below BACK; turns into "Tap again to confirm" for 3 s and ignores a second tap within 0.6 s, so a double-tap never wipes the save — round-2 QA UI-20); persist on change; opened from the title, the title's own buttons and caption hide behind the overlay (round 3) |
| Shop | coin balance header; 5 cards 358 × 96 with icon, name, 10 pips, effect delta caption ("Fire rate 2.0 → 2.2/s"), BUY 104 × 44 with price or "MAX"; "+1 run" estimate caption when unaffordable; purchase flash + coin count-down 300 ms |
| Levels | round 5: the screen prefetches every unlocked level's script in idle time, and a tile whose script is not ready yet starts its level a few frames later instead of freezing the tap (the tile pulses meanwhile; PLAY and NEXT behave the same); 4-column grid of 76 × 76 tiles, number + 3 stars, skull badge on milestone levels, locked = #2A3142, current = #FFB02E border; ENDLESS tile after L10; round 5: each tile wears its district band, subtly — a short rule in the district's accent along its top (longer on the district's first level) and a faint accent wash at its foot; the tile's accessible name ends with the district |
| Level complete | "LEVEL 7 CLEAR"; 3 stars 72 px animating in; "Coins +340" count-up with breakdown (kills / gates / piles / boss / bonus); survivors line — "N survivors" on a first clear, "N survivors · NEW BEST!" when the run beats the level's best, else "N survivors · Best survivors at boss: B" (round-3 FTUE: the first clear printed its own count twice); NEXT, REPLAY, SHOP; HOME (round 4, lead decision) — a 48 × 48 house icon top-left inside the safe area, on every results screen (level complete, game over, endless), so a player can stop on a high without NEXT → pause → QUIT; it replaces the text HOME buttons of game over / endless, and the NEXT / REPLAY / SHOP / RETRY stacks are unchanged; behind every results screen the HUD keeps only its coin pill (round 3), drawn above the results scrim so the settled total does not read as a greyed-out control (round-3 FTUE) |
| Game over | "LEVEL 7" above "SQUAD LOST" in #FF3B4E (round 3, UI-33); "Reached 64 % · Coins kept +120"; RETRY, SHOP; HOME icon top-left (round 4; confirmed round 5: the icon replaces the text HOME, there is no second HOME) |
| Endless results | distance, score, best, coins; RETRY; HOME icon top-left (round 4; confirmed round 5: it replaces the text HOME) |
| Overlays | "Reloading graphics…" on context loss; error box with message and a RELOAD button; fullscreen button hidden when unavailable. 1.2.0 release: when the installed app fails to load while an update is pending (the first launch after an update on a slow network), the boot screen says "Finishing the update…" and the app reloads into the new version instead of showing the error box (ARCHITECTURE §15.1) |

Lifecycle: `visibilitychange` → auto-pause; resize/orientation debounce 120 ms → camera preset tween 300 ms and `--ui` refit; first-run hints persisted as done-once flags.

---

## 15. Palette and materials

| Group | Tokens |
|---|---|
| Sky dome stops | zenith #182544 (y 1.0), upper #5B3A6E (0.45), horizon band #FF7A2F (0.12), glow #FFC46B (0.0); sun disc #FFF1C2 at azimuth +35°, elevation 9°; bottom 15 % mixed to fog |
| Fog / ground | fog #D8744A; ground beyond road #5A4634; teal shadow tint #1E6C7A |
| Road | asphalt #3B3B44 ±6 % noise; cracks #24242B; patches #45454E; centre dashes #E6CF72 (3 m / 3 m, 35 % worn); edge lines #D6D6CC; curb #7A7570; shoulder #6B5A48; tyre marks #2A2A30 @ 30 % |
| Props | barricade #9A9A94 with #D43B2E/#F2F2EA chevrons; cars #7A2E2A / #2E5A7A / #6E6E6E / #A8893A, rust #6B3A1E, glass #1C2430, tyres #1E1E1E; sandbags #A08A5C/#7E6B45; buildings #6B6058, windows #1C2430, 15 % lit #FFB36B emissive 1.6; dead tree #4A3A2E; smoke #5A5A5A → #2A2A2A; dust #FFD9A8 additive 0.18; coins #FFD23F metalness 0.9 roughness 0.25 emissive #FFB02E 0.4 |
| Soldiers | uniform #5E6B3A, webbing #4A5230, helmet #556039, skin #E3B48E, rifle #262626, boots #3A2E22, backpack #4E5633; sniper coat #35475A lens #7FE8FF; flamethrower suit #7A4A2A tank #E07A2A flame #FFB347; medic #F0F0EA cross #D83A3A; drone #8A94A0 LED #39E58C; APC #4F5A3A headlights #FFF1C2 |
| Zombies | walker skin #7FA36B clothes #4A4A52; runner #A9B46E / #6B3F3F; crawler #6E8F5F / #3A3A40; brute #5F7A52 muscle #9C3C3C eyes #FF7A1F; spitter #8CA86B sacs #C7E84B; boss #4F6B47 plates #2F2F33 core #FF4A1F emissive 3; eyes #FFE14D emissive 1.5; blood #6E1A1A |
| Gates | see §4.1; glyph white #FFFFFF with #0B0F1A outline, emissive 0.82 (under the 0.85 bloom threshold: no halo into the panel; round-2 QA GAT-7); MAX #FFD166 |
| Tracers (HDR) | rifle (2.6, 1.7, 0.6) warm gold; shotgun (3.0, 2.0, 1.0); minigun (3.4, 2.6, 0.35) yellow, 0.6× cross-section; laser (0.5, 2.6, 3.2) cyan (= §8.1 and the HUD icon); railgun (2.0, 3.6, 4.0); sniper (3.6, 1.2, 1.2); drone (2.0, 3.6, 2.4); fire-rate chip tint (1.5, 3.6, 4.0). Values = data.js `PALETTE.tracer` / `WEAPONS.<w>.tracer` (round-1 QA WPN-1, WPN-2: the earlier rifle/minigun triplets tone-mapped to white and the pink laser contradicted §8.1). Boss-aimed tracers climb from 0.95 m to the chest band (≈ 0.7 × core height) where they reach the boss (round-2 QA WPN-9; cosmetic, hit tests stay XZ) |
| UI | --bg-panel #0F1626 @ 88 %; --primary #FFB02E (text #1A1200, border #B5741A); --secondary #2E9BFF; --danger #FF3B4E; --success #3BE57A; --text #F4F1EA; --text-muted #9AA3B5; --coin #FFD23F; --boss-bar #FF3B4E on #2A0F14; --focus #2E9BFF |
| Count flashes | gain #5CFF8A, loss #FF4040 |

Materials: MeshStandardMaterial everywhere (cloth/skin roughness 0.75–0.9, cars 0.55/0.4 metalness, asphalt 0.92); gate panels: one instanced unlit shader material for all 12 panels (transparent 0.38, depthWrite off, double-sided) carrying per-gate tint, hit flash, hazard stripes, ring gauge and MAX badge; the panel body is luminance-capped (linear 0.45, far-background compensation ≤ 0.5) and a rounded dark backing plate (0.84 × panel half width, 0.52 × panel half height, centred on the value text, 45 % toward the glyph outline colour, luminance ≤ 0.06 even under fire, at least 60 % opaque since the round-5 art review — at the 36 px point the road and the glow quad behind a 38 % panel lifted it to 2.2 : 1 on Low — no sheen) sits under the value glyphs so they read ≥ 3:1 at the armed line on every tier (round-5 art review, docs/build/r5-art.md: item lanes back their icon with a near-black plate — 85 % toward the outline colour, opacity ≥ 0.9, luminance ≤ 0.02, and the icon is tone-mapped on every tier, Low included since the 1.2.0 release, so it shows the same colours everywhere — and the × / ÷ ring-gauge fill stays under the bloom threshold, linear luminance ≤ 0.80 with a full ring pulsing up to 30 % below it: a blooming full ring at a × cap or after the ÷ flip washed the plate it frames to 1.9–2.9 : 1); digit-atlas outline 18 px on the 100 px glyph (round-2 QA VIS-12); glyphs/tracers/lasers MeshBasicMaterial with HDR colour values 2–4 (`toneMapped: false`; on High/Medium the whole frame is tone-mapped once in the output pass after bloom, which is what makes 2–4 bloom); particles additive (sparks, flashes) or normal (blood, smoke). Lighting: DirectionalLight #FFD2A0 × 3.0 at squad + (8, 12, −14), HemisphereLight #7FB0E0 / #5A4634 × 0.9, max 2 point lights (boss core, laser). ACESFilmic, exposure 1.05; grade in the output pass (shadows 8 % → #1E6C7A, highlights 10 % → #FFB070, saturation 1.12, vignette 1 − 0.35·smoothstep(0.5, 1.4, d)); bloom strength 0.6, radius 0.4, threshold 0.85.

### 15.1 Visual districts (round 5)

The palette, lighting and grade above are **DISTRICT 1, SUNSET BOULEVARD** (L1–5) and stay exactly as they are: it is the ad. Five more districts re-light, re-fog and re-dress the road: **OVERCAST HIGHWAY** (L6–10), **NIGHT CITY** (L11–15), **TOXIC INDUSTRIAL** (L16–20), **ASH WASTELAND** (L21–25) and **FROZEN OUTSKIRTS** (L26–30). The campaign cycles past L30 (L31 is District 1 again). Endless starts in District 1 and rotates every 3 chunks with a 4 s cross-fade, started only when no gate is between the spawn line and z = −26, the next gate is far enough ahead to spawn after the fade has all but finished, and no mini-boss is alive (at most 150 m late).

Wet roads (Overcast, Night, Toxic, Frozen) carry puddles that mirror the sky band near the camera and, in Night City, the streetlights' warm pools (round-5 art review). Every district uses the same 8 roadside prop slots (geometry swapped per district), the same weather particles (dust, rain, ash, spores, embers or snow) and zero extra draw calls. Props and their glow stay off the lanes and the curb (|x| ≥ 4.5 m), weather never outshines the white value glyph, the spitter's acid yellow-green is never used near the road, and shadows reach as far up the road as in District 1. The gate colours never change. Each district is held to the ad's gate readability at 17, 29 and 36 px on every tier, measured in the engine: where a fog fought a gate tint, the fog moved. The title scene shows the district of the highest unlocked level, and a 1.6 s "DISTRICT n · NAME" banner under the progress bar marks each new district.

Values: `js/data.js` `DISTRICTS`, `DISTRICT_PROPS`, `DISTRICT_RULES`. Spec, readability tables and module contracts: `docs/DISTRICTS.md`.

---

## 16. Quality tiers and performance contract

| Setting | High | Medium (60 fps contract) | Low |
|---|---|---|---|
| DPR cap | 2.0 | 1.5 | 1.0 |
| Render-target pixel cap | 1.0 M px (lowers DPR first, never below 1.0) | same | same |
| Shadows | 2048 PCFSoft | 1024 PCF (4 taps), casters = nearest 150 characters | off → instanced blob discs |
| Bloom | half-res mip 0, 5 mips | quarter-res mip 0, 3 mips (round-2 QA VIS-13: CPU headroom; same programs as High) | off → glow quads + emissive +30 % |
| MSAA | 4 (2 on iOS) on the composer target | 0 | 0; canvas antialias only when the device booted on Low (a context-creation flag, fixed for the session) |
| Visible soldiers Vmax | 200 | 120 | 60 |
| Particles | 1024 | 512 | 256 |
| Tracers drawn | 256 | 128 | 64 |
| Prop density | 1.0 | 0.7 | 0.4 |
| Dust motes / smoke | 300 / yes | 150 / yes | 0 / no |
| Fog far | 100 | 100 | 90 |
| HP bars | all | all | only damaged |
| UI backdrop blur | yes | no | no |

Initial tier from the GPU string: Apple A14+/M-series, Adreno 7xx, Mali-G7x/G8x/Immortalis, desktop discrete (NVIDIA/Radeon/GeForce/Arc) → High; the generic "Apple GPU" string (every iPhone/iPad since iOS 17, A12 included) and Intel integrated → Medium with auto-raise allowed up to High; Adreno 6xx, Mali-G5x → Medium; a GPU string that matches nothing → Low (auto-raise up to Medium); no string at all → Medium; deviceMemory ≤ 3 GB caps the start at Low. Auto-scaler, relative to the frame target max(refresh, 16.67 ms) — Medium is the 60 fps contract, so a device holding 60 fps is never demoted on a 90/120 Hz panel (round 2, CORE-6). The refresh is the panel's: the median of ≥ 60 draw-free rAF intervals (boot screen before the shader warm-up, paused frames; never title or gameplay frames), snapped to 60/90/120 Hz, re-measured after the tab becomes visible, after a resize and on pause (default 16.67 ms until measured). 60-frame rolling means of the frame interval and of the JS time; drop a tier when the mean interval exceeds 1.4× the target for 3 s; raise when the mean interval is ≤ 1.05× the target AND JS < 7.5 ms for 10 s (10 s · 2ⁿ when the scaler already dropped from that tier n times this session) and the tier is below the device's auto ceiling (the matched rule's ceiling, else the initial tier); at most one change per 15 s; frozen during the boss intro and the first 2 s of a level; a manual tier disables auto. Frame budget: JS ≤ 7.5 ms, ≤ 50 draw calls in the main pass (+ ≈ 20 shadow, ≤ 14 post), zero per-frame allocations, pools allocated once at the High capacity and never grown (bullets 256, particles 1024 with the tier setting the live cap, floaters 24, damage numbers 32, zombies 260, shards 96, coins 64, globs 32, muzzle flashes 64, glyph quads 60 gate + 96 floater + 128 damage).

---

## 17. Tuning targets (debug overlay histograms)

Hits per gate, final value vs base, soldiers lost per wave, boss time-to-kill, count at boss vs E_boss. Targets after playtest: 60–75 % of gates reach ≥ 2× base at L1 and 25–40 % at L10; median soldiers lost per wave 8–12 % of the count; boss TTK 12–22 s; L1 first-try completion ≥ 85 %, L5 ≥ 60 %, L10 ≥ 45 %; median session (one level + results) ≤ 2.5 min.
