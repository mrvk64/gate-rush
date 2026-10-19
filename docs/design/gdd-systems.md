# Gate Rush — Systems, Numbers and Balance (GDD, systems angle)

Scope: every number the implementation needs. Units: metres (m), seconds (s), HP (abstract hit points), coins (c). "L" is the level index (1-based). All formulas are integer-rounded with `Math.round` unless stated. This document obeys `docs/BRIEF.md`; where the brief leaves a number open, this document decides it.

---

## 1. World frame (shared constants)

| Constant | Value | Notes |
|---|---|---|
| Road width | 9.0 m (x ∈ [-4.5, 4.5]) | Two gate halves of 4.5 m each; triple gates use three lanes of 3.0 m |
| Road segment length | 20 m, 6 segments pooled | Recycled when `z < camera.z - 20` |
| Road scroll speed `v(L)` | `8 + 0.15·(L-1)`, cap 11.0 m/s | L1 8.0, L5 8.6, L10 9.35, L20 10.85, L21+ 11.0 |
| Spawn horizon | z = 60 m ahead of squad | Fog: near 25 m, far 75 m (zombies fade in inside fog) |
| Gate visible window | 40 m (gate is shootable from 40 m to 0 m) | Window time `t_w = 40 / v(L)`: L1 5.0 s, L10 4.3 s, L20+ 3.6 s |
| Camera | offset (0, 9, -11) from squad centre, lookAt (0, 1, +12), FOV 55° portrait / 45° landscape | Steer lag: camera x lerps to squad x with τ = 0.25 s |
| Steering | Drag: 1 px = 0.012 m at 390 px viewport width (full width drag = one road width). Keyboard: 6 m/s. | Squad centre x clamped to ±(4.5 − r_V), see §2.2 |
| Soldier count cap | 9999 | Displayed as the raw integer; coins formatted "1.2K" above 999 |

---

## 2. Squad model

### 2.1 Count, visible count, and the "weight" trick

`S` = logical soldier count (what the big number shows). `V = min(S, Vmax)` = rendered soldiers. `Vmax` is a quality setting:

| Quality tier | Vmax | Max live bullets | Max particles | Shadow map |
|---|---|---|---|---|
| High | 60 | 120 | 600 | 2048 |
| Medium | 40 | 80 | 350 | 1024 |
| Low | 24 | 60 | 180 | off |

All combat maths uses `S`. Rendering only touches `V`. When `S > Vmax` the blob does not grow; the number grows.

### 2.2 Formation: Vogel spiral

Soldier slot `i` (0-based, 0 = squad centre) sits at polar coordinates:

```
r_i = s · sqrt(i)
θ_i = i · 137.508°            (golden angle)
local x = r_i · cos θ_i,  local z = r_i · sin θ_i
s = 0.42 m  (base spacing)
```

Blob radius `r_V = s·sqrt(V)`: V=10 → 1.33 m, V=24 → 2.06 m, V=40 → 2.66 m, V=60 → 3.25 m. If `r_V > 3.4` (not reachable with s = 0.42 and Vmax = 60, but reachable when a troop occupies space) spacing shrinks: `s' = 3.4 / sqrt(V)`.

Reflow: on any change of `S`, every soldier is re-assigned slot `i` by its current distance to centre (closest keeps slot 0), then lerps toward its slot at 8 m/s with critically damped smoothing (τ = 0.12 s). Growth: new soldiers appear at their slot with scale 0 → 1 over 200 ms (overshoot 1.15 at 120 ms). Losses from bites: soldier at the outermost occupied slot nearest the attacker topples (400 ms). Losses from `-N`/`÷N` gates: soldiers dissolve rim-inward, 12 per 100 ms, so the shrink reads as a wave.

Facing: all soldiers face +z. Recoil: 0.06 m backward kick, 80 ms, on the soldier that owns a fired bullet.

### 2.3 Fire: DPS is the truth, bullets are the presentation

Per-soldier stats (upgrade-scaled, §9):

| Stat | Base | Max (upgrade lvl 10) |
|---|---|---|
| Fire rate `f` | 1.5 shots/s | 3.0 shots/s |
| Damage `d` | 1.0 HP | 2.5 HP |

**Squad DPS** `= S · d · f · G_dmg · G_fr` (G = gear multipliers, §7).

Bullets per second actually spawned (the "volley rate"):

```
B = clamp( ceil(4 + 0.25·S) · (f / 1.5), 4, 36 )
bullet damage  D_b = SquadDPS / B
```

S=5: B=6, D_b=1.25. S=20: B=9, D_b=3.33. S=60: B=19, D_b=4.74. S=100+: B=29–36, D_b ≥ 5.2. Bullet count stays bounded (≤ 36/s × 1.6 s lifetime = 58 live bullets) regardless of squad size; damage per bullet carries the hidden soldiers. Floating damage numbers show `round(D_b)`.

Bullet: speed 35 m/s, lifetime 1.6 s (56 m), spawned from a random visible soldier weighted 2× for the front third of the blob (sorted by local z), muzzle flash on that soldier, tracer 1.2 m long. Fire phase per soldier: `(i · 0.618) mod 1` of the period so volleys never sync. Bullet x = owner's x (straight ahead); hit = first zombie/gate/crate whose capsule intersects the bullet segment this frame. Bullets are consumed on hit (laser/railgun pierce, §6).

### 2.4 Contact rules

A zombie touches the squad when `z_zombie ≤ z_squad + r_V + hit_radius` and `|x_zombie − x_squad| ≤ r_V + hit_radius`. Standard zombies bite once (kill `dmg` soldiers) and die. Brutes and bosses bite repeatedly on a cooldown. If `S` reaches 0: game over (0.6 s slow-mo at 0.25× then results). Armor plates (§7) absorb bites first.

---

## 3. Zombies

### 3.1 Roster

`h(L) = 1 + 0.15·(L-1) + 0.01·(L-1)²` is the global HP multiplier (L1 1.00, L3 1.34, L5 1.76, L8 2.54, L10 3.16, L15 5.06, L20 7.46, L30 13.76). Actual HP = `round(baseHP · h(L))`.

| Type | Base HP | Own speed (m/s, added to v) | Bite (soldiers) | Coins | Scale / hit radius | HP bar | Behaviour |
|---|---|---|---|---|---|---|---|
| Walker | 6 | 1.2 | 1 | 1 | 1.0 / 0.45 m | Only after first hit, 1.0 s | Straight line; lane drift `x += 0.4·sin(t·1.1 + phase)`; hunched walk cycle 1.2 Hz |
| Runner | 4 | 4.0 | 1 | 2 | 0.95 / 0.40 m | After hit | Zig-zag amplitude 1.5 m, period 1.2 s; re-targets squad x every 0.5 s; arms-forward sprint 2.4 Hz |
| Crawler | 3 | 2.2 | 1 | 1 | 0.6 tall 0.6 / 0.35 m | Never | Spawns in packs of 6–10; lunges last 3 m at 6 m/s; low silhouette, bloom-free dull skin so packs read as a carpet |
| Brute | 60 | 0.8; charge 3.5 m/s inside 8 m | 5 per bite, 1.0 s cooldown, keeps biting until dead | 15 | 1.9 / 0.90 m | Always | Stagger (0.3 s freeze + flash) every 25% HP lost; knocks 2 soldiers aside (visual only) on charge start; screen shake 0.3 on bite |
| Spitter | 18 | 1.0; holds at 16 m for max 6 s | 0 on contact (dies), spit kills 2 (3 at L≥10) | 6 | 1.1 / 0.50 m | Always | Spits every 2.5 s: projectile 12 m/s lobbed arc, splash radius 1.2 m, hits ground at the squad's predicted x; spit is a green glowing sphere, blockable by APC |

Bite death for walker/runner/crawler/spitter is immediate (they explode in a blood puff after the bite). Zombie animation: limb swing amplitude 35°, torso lean 15° forward, random phase.

### 3.2 Spawn weights by level (percent of a wave's population)

| L | Walker | Runner | Crawler | Brute | Spitter |
|---|---|---|---|---|---|
| 1 | 85 | 0 | 15 | 0 | 0 |
| 2 | 70 | 15 | 15 | 0 | 0 |
| 3 | 60 | 20 | 15 | 5 | 0 |
| 5 | 50 | 22 | 13 | 8 | 7 |
| 8 | 42 | 25 | 12 | 11 | 10 |
| 12 | 36 | 26 | 12 | 14 | 12 |
| 20+ | 30 | 28 | 12 | 16 | 14 |

Interpolate linearly between rows. Hand-authored levels (1–30) may override per wave; the generator (L31+ and the authoring tool) draws from this table. Each type's first appearance is scripted as a solo "introduction" spawn (L2 runner, L3 brute, L5 spitter) 60 m before its first mixed wave.

### 3.3 Wave patterns

| Pattern | Layout | Spread (z) | Use |
|---|---|---|---|
| `line` | N evenly across x ∈ [-3.5, 3.5], same z | 0 | Teaching, early |
| `column` | single file, x = squad x at spawn, 2 m apart | 2·N | Rewards steering away |
| `horde` | uniform random in a 7×8 m box | 8 | Default |
| `flank` | two clusters at x = ±3.2 | 4 | Forces a side pick before a gate pair |
| `pincer` | runners from both edges + walkers centre | 6 | L≥4 |
| `wall` | brutes line + crawler carpet 6 m behind | 6 | L≥8 set-piece |

### 3.4 Population and pacing per level

| Quantity | Formula | L1 | L5 | L10 | L20 | L30 |
|---|---|---|---|---|---|---|
| Length `Len(L)` | `600 + 40·L`, cap 1400 m | 640 | 800 | 1000 | 1400 | 1400 |
| Level time (pre-boss) | `Len / v` | 80 s | 93 s | 107 s | 129 s | 127 s |
| Waves `W(L)` | `6 + floor(L/2)`, cap 16 | 6 | 8 | 11 | 16 | 16 |
| Wave population `P(L)` | `4 + L`, cap 24 | 5 | 9 | 14 | 24 | 24 |
| Total zombies `Z = W·P` | | 30 | 72 | 154 | 384 | 384 |
| Gate events `G(L)` | `8 + floor(L/3)`, cap 16 | 8 | 9 | 11 | 14 | 16 |
| Specials | `2 + floor(L/4)`, cap 5 | 2 | 3 | 4 | 5 | 5 |
| Coin piles | `6 + floor(L/2)` × 5 coins | 6 | 8 | 11 | 16 | 16 |
| Expected squad at boss `E_boss(L)` | `40 + 20·L` | 60 | 140 | 240 | 440 | 640 |
| Boss HP | `30 · E_boss(L)` | 1800 | 4200 | 7200 | 13200 | 19200 |

Event spacing: waves and gates alternate; minimum 35 m between any two events, 50 m between gate events. First event never before 40 m; last non-boss event ends ≥ 60 m before the boss trigger.

### 3.5 Leak model (how the generator keeps waves fair)

For a wave with expected squad `E` (§5.4), `TTK = Σ(HP_i) / SquadDPS(E)` and the kill window `win = 0.7 · 60 / (v(L) + s̄)` where `s̄` is the population-weighted own speed. Expected leak = `clamp(1 − win/TTK, 0, 1) · N`. Each leaked zombie costs its bite value in soldiers. The generator scales a wave's population until expected leak fraction is within the target band: L1–3: 10–15 %, L4–9: 15–22 %, L10–19: 22–28 %, L20+: 28–32 %. Authored levels are validated against the same check (warning if outside band).

---

## 4. Boss

Road stops scrolling (`v → 0` over 1.0 s) when the boss is 30 m ahead; the boss walks to 12 m and holds. Zombies spawned by the boss walk the remaining distance.

| Boss (levels) | Silhouette | HP | Phase thresholds | Attacks |
|---|---|---|---|---|
| Brute King (1–4, 13–16, 25–28) | 3.2× brute with a car door shield | `30·E_boss(L)` | 100–60 %, 60–30 %, <30 % | Slam every 3.0 s: kills `3 + floor(L/2)` soldiers within 2.5 m of impact x. At 60 %: charge (kills 8 % of S, min 3) + spawns 6 runners. At 30 %: 2 brutes spawn, enrage: slam every 2.0 s |
| Spitter Queen (5–8, 17–20, 29–30) | 2.6× spitter, bloated, 4 arms | same | same | Triple spit every 2.5 s (3 splashes, 2 soldiers each). 60 %: acid rain, 8 splashes over 3 s. 30 %: summons 10 crawlers + enrage (spit every 1.6 s) |
| Colossus (9–12, 21–24) | 4.5× walker, armoured plates | same | same | Stomp shockwave every 3.5 s: kills 5 % of S (min 4). 60 %: throws a wrecked car (kills 12 % of S unless the squad is outside a 3 m wide x band shown by a red ground marker 1.2 s before). 30 %: plates fall off (takes 1.5× damage), stomp every 2.2 s |

Boss hit radius 1.6 m; squad bullets converge on the boss (all bullets re-aim at boss centre within 40 m so DPS is fully applied). Boss damage upgrade (§9) multiplies `D_b` against bosses only. Expected fight time at base stats: `HP / (E_boss · 1.5)` = 20 s; with max upgrades ≈ 3.3 s (fine: by then the player is over-levelled for that level). Boss death: 0.5 s at 0.15× time, white flash 120 ms, 80 particles, shake 0.8, coins `30 + 10·L` fly to HUD.

---

## 5. Gates

### 5.1 Gate types and shooting

| Type | Colour | Start value | Per-bullet rule | Cap | Pass-through effect |
|---|---|---|---|---|---|
| `+N` | Blue (#3B82F6) glow | N0 from §5.3 | +1 per bullet | `min(N0 + 8 + floor(E/5), 999)` | `S += N` |
| `-N` | Red (#EF4444) glow | −N0 | +1 per bullet; at 0 turns grey "0"; above 0 recolours blue | After flip: `+(floor(N0/2) + 3)` | `S += N` (N may be negative) |
| `xM` | Blue | 1.5 (L1–3) or 2 (L4+) | +0.5 every K = 10 bullets | x3 (L<15), x4 (L≥15) | `S = floor(S·M)` |
| `÷D` | Red | 2 or 3 | −1 step every K = 10 bullets along the ladder `÷3 → ÷2 → x1 (grey) → x1.5 → x2 (cap)` | x2 | `S = ceil(S / D)` or `floor(S·M)` after flip |
| Item gate | Gold (#F59E0B) | icon + name | Not shootable | — | Grants the item (§6–8) |

Bullet accounting is per gate: each bullet that touches the gate's panel (4.5 × 3.0 m box, 0.4 m deep) is consumed and counts once. Shotgun pellets count individually; rocket = 5 hits; railgun bolt = 10 hits; laser = 10 hits/s per beam while touching. Zombies in front of a gate absorb bullets, which is the intended tension. Number pop on every hit: scale 1.0 → 1.25 → 1.0 over 150 ms, text flashes white for 60 ms; crossing 0 on a red gate triggers a 300 ms colour tween red → grey → blue and a chime. Gates stop accepting hits at 1.5 m before the squad front so the applied value matches what the player saw.

Expected hits available on one gate: `H = B(E) · t_w · 0.5` (half the bullets go to the other lane/zombies). L1 (E≈10): 6·5·0.5 = 15. L10 (E≈120): 34·4.3·0.5 ≈ 73. The caps above are tuned so a fully focused player reaches cap on roughly 60 % of gates.

### 5.2 Pair patterns and weights

Each gate event is one of: pair (2 lanes, 4.5 m each), single (full width, unavoidable), triple (3 lanes, 3 m each). Event type weights: pair 70 %, single 15 %, triple 15 % (L1–3: pair 75, single 25, triple 0).

Pair patterns (weights are per level band, in percent):

| Pattern | L1–3 | L4–9 | L10+ | Value rule (E = expected squad at this gate, U = uniform random) |
|---|---|---|---|---|
| `+A | +B` | 30 | 20 | 15 | `A = round(E·U(0.25,0.6))`, `B = round(A·U(0.5,0.8))`; the smaller one sits on the lane with fewer zombies ahead |
| `+A | xM` | 30 | 25 | 25 | `A = round(E·(M−1)·U(0.7,1.3))`. Breakeven: xM is better iff `S > A/(M−1)` |
| `−A | ÷D` ("lesser evil") | 15 | 20 | 20 | D ∈ {2,3}; `A = round(E·(1−1/D)·U(0.7,1.3))`; `A ≤ 1.3·H` so flipping is feasible |
| `xM | −A` ("trap") | 15 | 15 | 15 | `A = round(E·U(0.3,0.5))`; if `A ≤ 0.8·H` the −A can be flipped and pays `+floor(A/2)+3` on top of being safe |
| `+A | −B` (small B) | 10 | 10 | 10 | `B = round(min(0.8·H, E·0.3))`, `A = floor(B/2) + 4`; flipping −B beats +A only if the player shoots it to cap |
| `item | +A` | — | 10 | 15 | `A = round(E·0.35)`; the item lane is the special delivery (§6) |

Single gate: L1–2 always `+A` with `A = round(E·0.2)` (teaching); L3+ 50 % `+A`, 30 % `xM`, 20 % `−A` with `A = round(E·U(0.15,0.3))` clamped to `≤ 0.9·H` (must shoot it down, always possible when focused). Triple: lanes `[+A, xM, −B]` with the `+A | xM` rule for A and `B = round(E·0.4)`; the middle lane is 3 m wide so the squad takes mostly the middle unless steered hard.

Why this is interesting: the breakeven of `+A` vs `xM` sits inside ±30 % of `E`, and the player's actual `S` differs from `E` by their play, so the right lane is not fixed — the player who reads the number wins. Shooting shifts breakevens further: 15 hits on `+A` vs 15 hits on `xM` (+0.5 step at 10) are compared at the player's real `S`.

### 5.3 Value sanity rules

- All `+A`, `−A` ≥ 3 and ≤ 999; `A` is rounded to the nearest 1 below 30, nearest 5 between 30 and 100, nearest 10 above.
- No `÷` gate within the first 150 m of L1–3. No two red lanes in a pair before L4 except the "lesser evil" pattern from L3.
- A level never applies net negative expectation: `Σ gate EV ≥ 0.9·E_boss(L)` after leak losses, else the generator re-rolls the weakest gate upward.
- `S` after a gate is clamped to [0, 9999]; a gate that would take `S` to 0 leaves `S = 1` unless the gate is a scripted "fail" (never generated).

### 5.4 Expected squad tracking `E`

The script keeps a running `E` for design validation: start `E = S0_assumed(L) = 5 + 2·floor(min(L,20)/2)` (assumes one start-squad upgrade every two levels), then per event: gate → `E = EV(best lane with 0.6·H hits applied)`, wave → `E −= expectedLeakBites`, medic/APC → their expected contribution. The `E_boss(L)` target in §3.4 is the number the script must land within ±15 % of; the authoring tool prints the trace.

---

## 6. Weapon power-ups (timed, replace squad fire)

Delivery: 50 % via item gate (paired against `+A`), 50 % via crate on the road (box 1.2 m, 5 bullet hits to open, drops a floating icon collected when any soldier passes within 1.5 m lateral). Only one weapon active at a time; a new pickup replaces the old (remaining time discarded, 25 c refund). Timer shows in HUD as a shrinking ring.

| Weapon | Unlock L | Duration | Fire pattern | DPS vs single | DPS vs group | Gate hits/s (focused) | Visual / audio |
|---|---|---|---|---|---|---|---|
| Shotgun | 1 | 8 s | Each volley bullet becomes 5 pellets in a 30° cone, 14 m range, each pellet `0.5·D_b` | 1.0× (close), 0 beyond 14 m | ≈2.5× | `2.5·B` | Flat orange tracers, wide flash, bassy thump |
| Minigun | 3 | 7 s | `B` ×3 (cap raised to 72), each `0.5·D_b`, cone 4° | 1.5× | 1.5× | `3·B` | Thin yellow tracers, spin-up 0.4 s, continuous roar, casings |
| Rocket launcher | 5 | 8 s | One rocket every 0.6 s from blob centre, 22 m/s, splash 2.5 m, damage = `1.0 s · SquadDPS` to all in splash; squad keeps firing at 50 % | 1.2× | 2–4× | `B·0.5 + 5/0.6 ≈ B·0.5 + 8` | Smoke trail, orange burst, shake 0.4, haptic 30 ms |
| Laser | 7 | 6 s | One cyan beam per 5 visible soldiers (min 2, max 12), each beam pierces every zombie in a 0.5 m wide line, total DPS = `2.0·SquadDPS` split across beams | 2.0× | 2–6× | 10 per beam touching | Bloom-heavy beams, hiss, zombies glow white before dying |
| Railgun | 10 | 6 s | Every 1.2 s one bolt from blob centre through the full road, 0.8 m wide, damage `3.0 s · SquadDPS` to everything in line; squad keeps firing at 50 % | 2.5× on the bolt line | 3–8× | `B·0.5 + 10/1.2` | White-blue lightning, 80 ms screen flash, deep crack, haptic 60 ms |

Boss rule: weapon timers pause when the boss fight starts and resume for the fight, so a pickup 5 s before the boss is not wasted.

---

## 7. Gear (persists to level end)

| Gear | Unlock L | Effect | Stacking | Visual |
|---|---|---|---|---|
| Armor plates | 2 | Grants plates `= min(S, 50)`; each bite consumes one plate instead of a soldier (brute bite consumes 5, spit 2) | Picking again refills to the cap | Blue shoulder glint on all soldiers; a plate shatters with a blue spark on absorb; HUD shield counter |
| Fire-rate chip | 4 | `G_fr` = +40 % | 2nd: +70 %, 3rd: +90 % total | Tracers tint cyan, rate audibly climbs |
| Damage booster | 6 | `G_dmg` = +50 % | 2nd: +85 %, 3rd: +110 % total | Tracers thicken, hit sparks ×2, damage numbers bigger and orange |
| Magnet | 8 | Coin pickup radius 1.2 m → 5.0 m; kill-coins already fly to HUD so magnet mainly affects road piles | No stack (+25 c) | Soldiers' helmets ring glows purple; coins arc visibly |

Gear is lost at level end (not permanent) so the meta shop remains the progression driver.

---

## 8. Troops (persist to level end; one of each; duplicate = +25 c)

| Troop | Unlock L | Position | Stats | Behaviour |
|---|---|---|---|---|
| Medic | 3 | Blob centre, white cross | Every 4 s: `+max(1, ceil(0.02·S))` soldiers; cap +60 per level | Pulses green ring; number ticks "+n" in green |
| Hero sniper | 5 | Rear of blob, rides a crate | Every 1.5 s: `40·h(L)·d·G_dmg` damage to the highest-HP zombie in view (bosses: ×0.5) | Long red tracer with bloom, loud crack; shows crit number |
| APC | 7 | 2.5 m in front of blob | Hit pool `20 + 2·L` bites; absorbs any bite/spit it intersects (x-width 2.4 m); crushes crawlers (kills on contact, no pool cost) | Exploded at 0 hits: splash 3 m, `2 s · SquadDPS`; HUD shows its pool |
| Flamethrower trooper | 9 | Front edge | Cone 25°, 7 m; `15·h(L)·d·G_dmg` DPS to every zombie in cone | Zombies burn (orange emissive) and take 20 % more bullet damage while burning |
| Drone turret | 11 | Hovers 3 m above blob | 4 shots/s, each `0.05·SquadDPS` (= 20 % of squad DPS), auto-aims nearest zombie, never gates | Blue dot tracers, whirr |

Specials schedule per level: count from §3.4; first special at 35–45 % of `Len`, last at ≤ 85 %. The weapon pool only includes unlocked weapons; each level pre-rolls its specials in the script so a level feels the same on replay.

---

## 9. Economy

### 9.1 Income

| Source | Coins |
|---|---|
| Zombie kill | Type value (§3.1), × coin multiplier |
| Boss kill | `30 + 10·L`, × coin multiplier |
| Any gate passed | 3 |
| Road coin pile | 5 (pickup radius 1.2 m) |
| Level complete bonus | `40 + 20·L` |
| Star bonus | 2★: +25 % of complete bonus; 3★: +50 % |
| Replay of a cleared level | All of the above × 0.6 |
| Duplicate gear/troop | 25 |

Expected first-clear income at base coin multiplier (70 % of piles collected, 90 % of zombies killed):

| L | Kills | Gates | Piles | Boss | Complete (2★) | Total |
|---|---|---|---|---|---|---|
| 1 | 33 | 27 | 21 | 40 | 75 | ≈196 |
| 3 | 70 | 27 | 25 | 60 | 125 | ≈307 |
| 5 | 158 | 30 | 28 | 80 | 175 | ≈471 |
| 10 | 431 | 36 | 39 | 130 | 300 | ≈936 |
| 15 | 790 | 39 | 46 | 180 | 425 | ≈1480 |
| 20 | 1267 | 45 | 56 | 230 | 550 | ≈2148 |
| 30 | 1580 | 51 | 56 | 330 | 800 | ≈2817 |

### 9.2 Shop (permanent, 5 items × 10 levels)

Cost of level `n` (1–10): `round10(base · 1.4^(n−1))`.

| Upgrade | Base | Effect per level | Level 10 | Costs n=1…10 | Total |
|---|---|---|---|---|---|
| Start squad | 150 | `S0 = 5 + 2n` | 25 soldiers | 150, 210, 290, 410, 580, 810, 1130, 1580, 2210, 3100 | 10 470 |
| Fire rate | 200 | `f = 1.5·(1 + 0.10n)` | 3.0/s | 200, 280, 390, 550, 770, 1080, 1510, 2110, 2950, 4130 | 13 970 |
| Damage | 200 | `d = 1 + 0.15n` | 2.5 | same as fire rate | 13 970 |
| Coin multiplier | 120 | `1 + 0.10n` | ×2.0 | 120, 170, 240, 330, 460, 650, 900, 1260, 1770, 2480 | 8 380 |
| Boss damage | 180 | `1 + 0.15n` vs bosses | ×2.5 | 180, 250, 350, 490, 690, 970, 1350, 1900, 2660, 3720 | 12 560 |

Grand total 59 350 c. Cumulative first-clear income (table above, interpolated) reaches ≈ 4 200 c by L8, ≈ 11 000 c by L15, ≈ 24 000 c by L20, ≈ 50 000 c by L30; the coin multiplier (bought early because it is cheapest) lifts the later part by 1.5–2×, so a player who clears every level once maxes the shop around L30–34, and replays close the gap for anyone who gets stuck.

Progression cadence (what the player experiences):

| Runs (first clears) | Income so far | Affordable milestones |
|---|---|---|
| 1 | ≈200 | Coin mult 1 (120) or start squad 1 (150) |
| 2 | ≈440 | Second upgrade, usually start squad or fire rate |
| 3–4 | ≈1 000 | 4–5 upgrades bought; squad starts at 9–11 |
| 5–6 | ≈1 900 | Damage 2, boss 1 — first boss that dies in <12 s |
| 8–10 | ≈4 900 | Everything at 3–4; a tier-4 item every 2 runs |
| 15 | ≈11 000 | One upgrade per 2–3 runs from here on (costs 770–1500 vs income 1 200–1 500) |
| 20 | ≈24 000 | Items at 6–7 |
| 30 | ≈50 000+ | All 10 |

The 1.4 ratio against income that grows ≈ +100 c per level keeps the ratio cost/income between 0.6 and 2.5 from L1 to L25, which is the "one upgrade every 1–3 runs" feel. Shop UI shows the next level's effect delta and a "+1 run" / "+2 runs" estimate from the last run's income.

### 9.3 Sinks and safety

No other sinks. Save: coins, upgrade levels, best score/stars per level, highest level unlocked, settings; all localStorage writes wrapped in try/catch, in-memory fallback.

---

## 10. Stars, score, results

Stars (evaluated at boss death; `R` = survivors):

- ★ Boss killed.
- ★★ `R ≥ 0.5·E_boss(L)`.
- ★★★ `R ≥ 1.0·E_boss(L)` and boss killed within 30 s of the fight starting.

Score:

```
Score = 10·Σ coinValue(kills)        (boss counts as its coin value)
      + 15·PeakSquad
      + 20·R
      + 200·GatesFlipped              (red lanes shot past 0 before passing)
      + 25·max(0, 60 − BossSeconds)
      + 500 if no soldier was lost to a red gate
```

Results screen shows: stars (animated one by one, 250 ms apart), coins earned with breakdown lines, score, best score, and "Next level" / "Replay" / "Shop" buttons. Game over shows the same minus stars, keeps 50 % of coins earned so far in the run (so dying still progresses).

---

## 11. Difficulty curve summary

| L | v | Len | Waves × Pop | h(L) | Gate events | Specials | E_boss | Boss HP | Boss | Leak target |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 8.0 | 640 | 6×5 | 1.00 | 8 | 2 | 60 | 1800 | Brute King | 10–15 % |
| 3 | 8.3 | 720 | 7×7 | 1.34 | 9 | 2 | 100 | 3000 | Brute King | 10–15 % |
| 5 | 8.6 | 800 | 8×9 | 1.76 | 9 | 3 | 140 | 4200 | Spitter Queen | 15–22 % |
| 8 | 9.05 | 920 | 10×12 | 2.54 | 10 | 4 | 200 | 6000 | Spitter Queen | 15–22 % |
| 10 | 9.35 | 1000 | 11×14 | 3.16 | 11 | 4 | 240 | 7200 | Colossus | 22–28 % |
| 15 | 10.1 | 1200 | 13×19 | 5.06 | 13 | 5 | 340 | 10200 | Brute King | 22–28 % |
| 20 | 10.85 | 1400 | 16×24 | 7.46 | 14 | 5 | 440 | 13200 | Spitter Queen | 28–32 % |
| 30 | 11.0 | 1400 | 16×24 | 13.76 | 16 | 5 | 640 | 19200 | Spitter Queen | 28–32 % |

Why it holds together: total zombie HP per level ≈ `Z · 9 · h(L)` (9 = weighted mean base HP). L20: 384·9·7.46 ≈ 25 800 HP in 129 s needs 200 DPS sustained; a mid-level squad of 250 at base stats gives 375 DPS, at mid upgrades (f 2.25, d 1.75) 985 DPS. L30 needs ≈ 370 DPS sustained from 47 600 HP; base stats at E≈400 give 600 DPS but the leak band and boss (19 200 HP) demand ≥ half-upgraded stats. Beyond L30 the generator continues with the same formulas (caps reached; only `h(L)` and `E_boss(L)` keep climbing), which is the endless tail.

---

## 12. Level script format

One JSON file per level, loaded as a module. Distances are metres from the level start; the runtime fires each event when `distanceTravelled ≥ at − 60` (so objects spawn at the horizon and arrive at `at`).

```json
{
  "id": 1,
  "name": "Outskirts",
  "seed": 1001,
  "theme": "sunset",
  "length": 640,
  "roadSpeed": 8.0,
  "hpMult": 1.0,
  "expectedBossSquad": 60,
  "events": [
    { "at": 40,  "type": "gates", "layout": "single",
      "lanes": [ { "op": "+", "value": 5, "cap": 14 } ],
      "hint": "Shoot the gate to raise its number" },
    { "at": 90,  "type": "wave", "pattern": "line", "units": { "walker": 4 } },
    { "at": 140, "type": "gates", "layout": "pair",
      "lanes": [ { "op": "+", "value": 6, "cap": 20 },
                 { "op": "x", "value": 1.5, "step": 10, "cap": 3 } ] },
    { "at": 190, "type": "wave", "pattern": "horde", "units": { "walker": 5, "crawler": 3 }, "spread": 8 },
    { "at": 240, "type": "gates", "layout": "pair",
      "lanes": [ { "op": "-", "value": 8, "flipCap": 7 },
                 { "op": "+", "value": 4, "cap": 20 } ],
      "hint": "Red gates go positive if you shoot them enough" },
    { "at": 290, "type": "crate", "item": "weapon.shotgun", "x": 1.5 },
    { "at": 330, "type": "wave", "pattern": "line", "units": { "walker": 6, "runner": 2 } },
    { "at": 380, "type": "gates", "layout": "pair",
      "lanes": [ { "op": "+", "value": 10, "cap": 30 },
                 { "op": "x", "value": 1.5, "step": 10, "cap": 3 } ] },
    { "at": 430, "type": "wave", "pattern": "horde", "units": { "walker": 8, "crawler": 4 }, "spread": 8 },
    { "at": 460, "type": "coins", "x": -2.0, "count": 5 },
    { "at": 480, "type": "gates", "layout": "pair",
      "lanes": [ { "op": "÷", "value": 2, "step": 10, "cap": 2 },
                 { "op": "-", "value": 12, "flipCap": 9 } ] },
    { "at": 530, "type": "gates", "layout": "pair",
      "lanes": [ { "op": "+", "value": 15, "cap": 35 },
                 { "op": "+", "value": 8, "cap": 28 } ],
      "guards": [ { "lane": 0, "units": { "walker": 4 } } ] },
    { "at": 570, "type": "wave", "pattern": "flank", "units": { "walker": 6, "runner": 3 } },
    { "at": 600, "type": "crate", "item": "troop.medic", "x": -1.5 },
    { "at": 640, "type": "boss", "id": "bruteKing", "hp": 1800,
      "phases": [
        { "until": 0.6, "attack": "slam", "interval": 3.0, "kills": 3 },
        { "until": 0.3, "onEnter": [ { "spawn": { "runner": 6 } }, { "attack": "charge", "killsPct": 0.08 } ],
          "attack": "slam", "interval": 3.0, "kills": 3 },
        { "until": 0.0, "onEnter": [ { "spawn": { "brute": 2 } } ], "attack": "slam", "interval": 2.0, "kills": 3 }
      ] }
  ]
}
```

Field reference:

| Field | Meaning |
|---|---|
| `seed` | Seeds prop placement, zombie x jitter and lane drift phases so a level looks the same on replay |
| `hpMult` | Overrides `h(L)` (defaults to the formula) |
| `expectedBossSquad` | Validation target; the authoring tool asserts the E-trace lands within ±15 % |
| `gates.layout` | `single`, `pair`, `triple`; `lanes` ordered left → right; `cap`/`flipCap`/`step` as §5.1; `op` `item` with `item` id for gold gates |
| `guards` | Zombies spawned 12 m in front of a lane (the "+A with zombies in front" trade-off) |
| `wave.units` | Counts per type; `spread` = z depth; pattern as §3.3; optional `x` centre for `column` |
| `crate` | `item` id in `weapon.*`, `gear.*`, `troop.*`; `x` lateral position |
| `coins` | A pile of `count` coins at `x` |
| `boss.phases` | `until` = HP fraction at which the phase ends; `onEnter` actions; `kills` absolute or `killsPct` of S |
| `hint` | Tutorial text shown once (first run only), 2.5 s |

E-trace for Level 1 (S0 = 5, 0.6·H hits per gate, leak model): 5 → single +5 (+9 hits) = 14 → wave −1 = 13 → `+6` lane with 9 hits = 28 vs `x1.5` with 9 hits = 19, take 28 → wave −2 = 26 → shoot `−8` to +7 = 33 (vs +4 lane with hits = 39; the +4 lane is better if the player cannot flip in time, so both are live) → shotgun → wave −2 = 31 (37) → `x1.5` → 46 (55) vs `+10` with hits → 50 (56) → wave −3 = 47 → `−12` flipped = 56 (÷2 shot to x1 = 47) → `+15` with hits but 4 walkers in front ≈ +22 → 78 (or `+8` + 12 hits = 67) → wave −3 ≈ 64–75 → boss. Target 60 ± 15 %: within band on the cautious line (64), 25 % over on the greedy line, which is the intended 3★ reward.

### 12.1 Level 5 script ("Overpass", first Spitter Queen)

`S0_assumed = 9`, `v = 8.6`, `Len = 800`, `h = 1.76`, `E_boss = 140`, boss HP 4200, specials 3, waves 8 × 9, gate events 9.

```json
{
  "id": 5, "name": "Overpass", "seed": 1005, "theme": "sunset-smoke",
  "length": 800, "roadSpeed": 8.6, "hpMult": 1.76, "expectedBossSquad": 140,
  "events": [
    { "at": 45,  "type": "gates", "layout": "pair",
      "lanes": [ { "op": "+", "value": 5, "cap": 16 }, { "op": "x", "value": 2, "step": 10, "cap": 3 } ] },
    { "at": 95,  "type": "wave", "pattern": "horde", "units": { "walker": 5, "runner": 2, "crawler": 2 }, "spread": 8 },
    { "at": 140, "type": "wave", "pattern": "column", "units": { "spitter": 1 }, "hint": "Spitters stop and lob acid. Shoot them first." },
    { "at": 185, "type": "gates", "layout": "pair",
      "lanes": [ { "op": "-", "value": 12, "flipCap": 9 }, { "op": "÷", "value": 2, "step": 10, "cap": 2 } ] },
    { "at": 235, "type": "wave", "pattern": "pincer", "units": { "walker": 4, "runner": 4, "crawler": 1 } },
    { "at": 285, "type": "gates", "layout": "pair",
      "lanes": [ { "op": "item", "item": "weapon.rocket" }, { "op": "+", "value": 14, "cap": 34 } ] },
    { "at": 320, "type": "coins", "x": 2.5, "count": 5 },
    { "at": 335, "type": "wave", "pattern": "horde", "units": { "walker": 5, "brute": 1, "crawler": 3 }, "spread": 8 },
    { "at": 385, "type": "gates", "layout": "triple",
      "lanes": [ { "op": "+", "value": 20, "cap": 44 }, { "op": "x", "value": 2, "step": 10, "cap": 3 }, { "op": "-", "value": 18, "flipCap": 12 } ] },
    { "at": 435, "type": "wave", "pattern": "flank", "units": { "runner": 6, "spitter": 1, "walker": 2 } },
    { "at": 480, "type": "crate", "item": "gear.armor", "x": -1.5 },
    { "at": 495, "type": "gates", "layout": "pair",
      "lanes": [ { "op": "+", "value": 30, "cap": 55 }, { "op": "+", "value": 18, "cap": 42 } ],
      "guards": [ { "lane": 0, "units": { "walker": 5, "runner": 2 } } ] },
    { "at": 545, "type": "wave", "pattern": "wall", "units": { "brute": 2, "crawler": 7 } },
    { "at": 595, "type": "gates", "layout": "single",
      "lanes": [ { "op": "-", "value": 25, "flipCap": 15 } ], "hint": "No way around. Shoot it down." },
    { "at": 640, "type": "wave", "pattern": "horde", "units": { "walker": 6, "runner": 2, "spitter": 1 }, "spread": 8 },
    { "at": 680, "type": "crate", "item": "troop.sniper", "x": 1.5 },
    { "at": 700, "type": "gates", "layout": "pair",
      "lanes": [ { "op": "x", "value": 2, "step": 10, "cap": 3 }, { "op": "-", "value": 40, "flipCap": 23 } ] },
    { "at": 740, "type": "wave", "pattern": "pincer", "units": { "runner": 5, "walker": 4 } },
    { "at": 800, "type": "boss", "id": "spitterQueen", "hp": 4200,
      "phases": [
        { "until": 0.6, "attack": "tripleSpit", "interval": 2.5, "kills": 2 },
        { "until": 0.3, "onEnter": [ { "attack": "acidRain", "splashes": 8, "duration": 3.0 } ], "attack": "tripleSpit", "interval": 2.5, "kills": 2 },
        { "until": 0.0, "onEnter": [ { "spawn": { "crawler": 10 } } ], "attack": "tripleSpit", "interval": 1.6, "kills": 2 }
      ] }
  ]
}
```

E-trace (S0 = 9, H ≈ 0.6 × 7 × 4.65 × 0.5 ≈ 10 hits early rising to ≈ 30 by mid-level): 9 → `x2` with 10 hits = x2.5 → 22 (vs +5+10 = 24: coin flip, intended) → 23 → wave −2 = 21 → spitter kills 2 if slow = 19 → `−12` flipped with 12+ hits = +9 → 28 (÷2 → 10; the trap is loud) → pincer −3 = 25 → rocket vs +14+hits ≈ 40: rocket's 8 s cover the next horde+brute, designer expects the item → 25 → horde with rockets −1 = 24 → triple: middle `x2` shot to x2.5 = 60 → flank −4 = 56 → armor → `+30` with guards ≈ +44 but −3 to guards = 97, or `+18` + 25 hits = 99: both ≈ 98 → wall −5 (brutes) = 93 → single `−25` with 30 hits available: flips to +5 → 98 (if under-shot: 68–78) → horde −4 = 94 → sniper → `x2` with 30 hits = x3 → 282, or `−40` flipped +23 = 117: greedy line 282 is 2× target, but the trap lane costs 40 if misread → pincer −5 → 112 (cautious) / 277 (greedy). Boss at 4200 HP: cautious squad 112 · 1.5 = 168 DPS → 25 s (2★ unless R ≥ 140); greedy squad 277 → 10 s and 3★. Within the design intent: 3★ requires reading the x2 at the end.

---

## 13. Must-haves not covered above (brief §Core gameplay), in numbers

- **Road & camera**: cracked asphalt canvas texture 512² tiled 2× per segment, lane paint every 4 m (2 m dash); props pooled: 24 barricades, 8 wrecked cars, 16 sandbag piles, 12 ruined building façades, 20 dead trees, 4 smoke columns, 200 dust motes. Fog colour #E8A26B near horizon, sky band orange → teal.
- **Juice budget**: muzzle flash sprite 90 ms; hit spark 6 particles 200 ms; blood puff 10 particles 350 ms; damage numbers rise 1.2 m over 600 ms; squad counter ticks at 30 digits/s with a 1.3× scale pop on each change; shake 0.15 on brute bite, 0.4 on rocket, 0.8 on boss death; haptics 15 ms per gate flip, 30 ms rocket, 60 ms railgun, 200 ms boss death; bloom threshold 0.85 strength 0.6 (High/Medium only).
- **HUD**: soldier count above the blob (world-space sprite, 1.6 m font height, always faces camera); level progress bar with wave ticks and a skull marker at the boss position; coins top-right; power-up rings top-left; shield counter next to the soldier count when armor is active.
- **Tutorial hints** (first run only, from `hint` fields): drag to steer (L1 at 10 m), shoot gates (L1 at 40 m), red gates flip (L1 at 240 m), spitters (L5), single red gate (L5). Dismiss on first steer or after 2.5 s.
- **Settings**: sound, music, haptics on/off; quality Auto/High/Medium/Low (Auto starts Medium, promotes to High after 5 s at ≥ 58 fps, demotes after 3 s under 45 fps). All persisted.
- **Audio levels**: master −6 dB, gunfire bus −10 dB with 12-voice polyphony cap, gate hit tick pitch rises 2 semitones per 10 hits (resets per gate), music loop 110 BPM in A minor, boss layer adds a low drone.

---

## 14. Tuning knobs (one place to change)

```
BALANCE = {
  fireRateBase: 1.5, damageBase: 1.0, bulletSpeed: 35, bulletLife: 1.6,
  volley: { a: 4, b: 0.25, min: 4, max: 36 },
  gate: { window: 40, kStep: 10, capBonus: 8, capPerE: 1/5, flipCapHalf: 0.5, flipCapBonus: 3 },
  level: { v0: 8, vSlope: 0.15, vCap: 11, len0: 600, lenSlope: 40, lenCap: 1400,
           h: [1, 0.15, 0.01], waves: [6, 0.5, 16], pop: [4, 1, 24], gates: [8, 1/3, 16],
           eBoss: [40, 20], bossHpPerE: 30 },
  leakBand: { "1-3": [0.10, 0.15], "4-9": [0.15, 0.22], "10-19": [0.22, 0.28], "20+": [0.28, 0.32] },
  shop: { ratio: 1.4, bases: { squad: 150, fireRate: 200, damage: 200, coin: 120, boss: 180 } },
  stars: { two: 0.5, three: 1.0, threeBossSeconds: 30 },
  replayPayout: 0.6, gameOverKeep: 0.5
}
```

Every formula in this document reads from this object; nothing is hard-coded elsewhere.
