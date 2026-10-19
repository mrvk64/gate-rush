# Gate Rush — GDD: Art Direction, Mobile UX & Technical Feasibility

Angle owner: technical art + mobile UX. Source of truth for constraints: `docs/BRIEF.md`. Everything below is procedural (Three.js r170 primitives, runtime canvas textures, WebAudio synthesis), runs in the claude.ai artifact iframe and as a local PWA, and targets 60 fps on a 2021 mid-range Android (Snapdragon 695 / Mali-G57 class).

## 0. Conventions

| Item | Value |
|---|---|
| Units | 1 unit = 1 m |
| Axes | +X right, +Y up, squad faces −Z; the world scrolls toward +Z |
| Squad anchor | (squadX, 0, 0); squadX ∈ [−3.2, +3.2] |
| Road | 8.0 m wide (two 4.0 m halves), segments 40 m long, 6 segments pooled, recycled when z > 20 (z −= 240) |
| Base road speed | 9 m/s (level scalar applies) |
| Spawn horizon | z = −110 (inside fog), despawn at z > 12 |
| Reference viewport | 390 × 844 CSS px portrait, DPR 3 (capped to 2) |
| Frame target | 16.67 ms; JS main thread ≤ 7.5 ms, GPU ≤ 9 ms |

## 1. Pillars

1. **Read the number first.** At any moment the squad count, the gate values and the boss HP are the three most legible things on screen. Everything else is subordinate in contrast.
2. **Sunset apocalypse, not grey apocalypse.** Warm horizon, teal shadows, saturated gate glow. The world is dim; the gameplay layer is bright.
3. **One draw call per thing-type.** Every repeated object is an `InstancedMesh`; animation is in the vertex shader; no texture uploads during play.

## 2. Visual identity

### 2.1 Palette (sRGB hex; assign with `material.color.setStyle()` so r170 ColorManagement converts to linear)

**Sky, fog, ground**

| Element | Hex | Use |
|---|---|---|
| Sky zenith | `#182544` | Dome gradient stop, y = 1.0 |
| Sky upper mid | `#5B3A6E` | stop y = 0.45 |
| Horizon band | `#FF7A2F` | stop y = 0.12 (the signature orange band) |
| Horizon glow | `#FFC46B` | stop y = 0.0; also sun bloom |
| Sun disc | `#FFF1C2` | 6° disc at azimuth +35°, elevation 9°, drawn in the dome shader |
| Fog | `#D8744A` | `THREE.Fog(0xD8744A, 45, 125)`; the dome's lower stops are mixed toward this colour so the horizon seam vanishes |
| Ground beyond road | `#5A4634` | 200 × 400 m plane, roughness 1.0 |
| Teal shadow tint | `#1E6C7A` | Grade pass, shadows lift 8% |

**Road**

| Element | Hex | Spec |
|---|---|---|
| Asphalt base | `#3B3B44` | ±6% luminance value noise (cell size 12 px) |
| Cracks | `#24242B` | 18 random polylines/segment, 2–3 px, branching 30% |
| Patches | `#45454E` | 4 rounded rects/segment |
| Centre dashes | `#E6CF72` | 0.15 m wide, 3 m dash / 3 m gap, 35% worn (alpha noise) |
| Edge lines | `#D6D6CC` | 0.12 m, continuous, 25% worn |
| Curb | `#7A7570` | 0.25 m box ribbon each side |
| Shoulder gravel | `#6B5A48` | 2 m strip, speckle noise |
| Tyre marks | `#2A2A30` @ 30% | 2 arcs per 3rd segment |

**Props**

| Prop | Colours |
|---|---|
| Barricade (concrete) | `#9A9A94` body, `#D43B2E` / `#F2F2EA` chevron stripes |
| Wrecked car | body one of `#7A2E2A`, `#2E5A7A`, `#6E6E6E`, `#A8893A`; rust `#6B3A1E`; glass `#1C2430`; tyres `#1E1E1E` |
| Sandbags | `#A08A5C`, shadowed seams `#7E6B45` |
| Ruined building | walls `#6B6058`, windows `#1C2430`, 15% lit windows `#FFB36B` emissive 1.6 |
| Dead tree | `#4A3A2E` |
| Smoke column | `#5A5A5A` → `#2A2A2A` over height, alpha 0.55 → 0 |
| Dust motes | `#FFD9A8` additive, alpha 0.18 |
| Coins | `#FFD23F`, metalness 0.9, roughness 0.25, emissive `#FFB02E` 0.4 |

**Soldiers and friendly troops**

| Part | Hex |
|---|---|
| Uniform | `#5E6B3A` |
| Webbing / belt | `#4A5230` |
| Helmet | `#556039` |
| Skin | `#E3B48E` |
| Rifle | `#262626`, muzzle `#6B6B6B` |
| Boots | `#3A2E22` |
| Backpack | `#4E5633` |
| Hero sniper | coat `#35475A`, scope lens `#7FE8FF` emissive 2 |
| Flamethrower trooper | suit `#7A4A2A`, tank `#E07A2A`, pilot flame `#FFB347` emissive 3 |
| Medic | uniform `#F0F0EA`, cross `#D83A3A` |
| Drone turret | `#8A94A0` body, rotors `#2A2A2A`, LED `#39E58C` emissive 2 |
| APC | hull `#4F5A3A`, wheels `#1E1E1E`, headlights `#FFF1C2` emissive 2 |

**Zombies**

| Type | Skin | Clothes | Eyes (emissive) | Height | Notes |
|---|---|---|---|---|---|
| Walker | `#7FA36B` | `#4A4A52` | `#FFE14D` × 1.5 | 1.6 m | hunched 0.35 rad |
| Runner | `#A9B46E` | `#6B3F3F` | `#FFE14D` × 1.5 | 1.5 m | lean forward 0.5 rad, arms back |
| Crawler | `#6E8F5F` | `#3A3A40` | `#FFE14D` × 1.5 | 0.7 m | no legs; drag animation |
| Brute | `#5F7A52` | none; exposed muscle `#9C3C3C` | `#FF7A1F` × 2 | 2.8 m | wide shoulders, slow |
| Spitter | `#8CA86B` | `#4A4A52` | `#C7E84B` × 2 | 1.7 m | throat sacs `#C7E84B` emissive 2.5, pulse 1.5 Hz |
| Boss | `#4F6B47` | armour plates `#2F2F33` | `#FF4A1F` × 3 | 7.0 m | exposed core `#FF4A1F` emissive 3 (bloom) |
| Blood puff | `#6E1A1A` | | | | particle colour |

**Gates** (see §5 for colour-blind safety)

| Type | Panel tint | Frame | Glyph / number | Frame shape |
|---|---|---|---|---|
| `+N` | `#2E9BFF` @ 38% | `#1A6FD6` | white `#FFFFFF`, outline `#0B0F1A`, emissive 2.5 | rounded top, up-chevrons |
| `×N` | `#3BE57A` @ 38% | `#1FA85A` | same | rounded top, double up-chevrons |
| `−N` | `#FF3B4E` @ 38% | `#B81E2E` | same | square top, hazard stripes `#1A1200`/`#FF3B4E`, down-chevrons |
| `÷N` | `#FF7A1F` @ 38% | `#C45A0E` | same | square top, hazard stripes, double down-chevrons |
| value 0 | `#B8B8B8` @ 30% | `#8A8A8A` | grey `#DDDDDD` | neutral |
| Special (weapon/gear/troop) | `#C77DFF` @ 38% | `#8E3FD6` | icon glyph from atlas | pentagon top |

**UI**

| Token | Hex | Use |
|---|---|---|
| `--bg-panel` | `#0F1626` @ 88% | panels, pause dim at 72% |
| `--primary` | `#FFB02E` (text `#1A1200`, bottom border `#B5741A`) | PLAY, NEXT, RETRY |
| `--secondary` | `#2E9BFF` (text `#06111F`) | SHOP, LEVELS |
| `--danger` | `#FF3B4E` | game over title, reset save |
| `--success` | `#3BE57A` | progress bar, gain flash |
| `--text` | `#F4F1EA` | body |
| `--text-muted` | `#9AA3B5` | captions |
| `--coin` | `#FFD23F` | coin numbers, stars |
| `--boss-bar` | `#FF3B4E` on `#2A0F14` | boss HP |
| `--focus` | `#2E9BFF` 3 px ring | keyboard focus |

Contrast: every text/background pair ≥ 4.5:1 (`#F4F1EA` on `#0F1626` = 15.6:1; `#1A1200` on `#FFB02E` = 10.9:1).

### 2.2 Materials

| Material | Params |
|---|---|
| Cloth / skin / concrete | `MeshStandardMaterial` roughness 0.75–0.9, metalness 0 |
| Car bodies | roughness 0.55, metalness 0.4 |
| Asphalt | roughness 0.92, metalness 0, `map` = road canvas |
| Gate panel | `MeshBasicMaterial` transparent, opacity 0.38, `depthWrite false`, `side: DoubleSide` |
| Gate glyphs / tracers / lasers | `MeshBasicMaterial`, `color.setRGB(r,g,b)` with values 2–4 (HDR, crosses bloom threshold), `toneMapped: false` |
| Particles | `MeshBasicMaterial` + custom vertex shader, `blending: AdditiveBlending` for sparks/flash, normal blending for blood/smoke |
| Low tier replacement | `MeshLambertMaterial` via a `makeMat(opts)` factory keyed by quality tier |

## 3. World construction

**Sky dome.** `SphereGeometry(150, 24, 12)`, `BackSide`, `ShaderMaterial` with 4-stop gradient on world-space `normalize(position).y`, sun disc (`smoothstep(0.994, 0.998, dot(dir, sunDir))`), and the bottom 15% mixed into fog colour. Follows the camera. One draw call, no texture.

**Road segments.** 6 × `PlaneGeometry(8, 40, 1, 8)` rotated −90° X. One shared `CanvasTexture` 512 × 1024 (`RepeatWrapping`, repeat 1 × 4, anisotropy by tier), drawn once at boot in ~20 ms. Segment k gets a per-mesh `uvOffset` uniform (`k * 0.37`, shared material via `onBeforeCompile`) so cracks don't repeat in lockstep. Curbs: 2 `InstancedMesh` boxes (6 instances each).

**Prop bands.** Props live at x ∈ ±[5.5, 14], placed per segment from a seeded PRNG (mulberry32, seed = levelId × 1000 + segmentIndex) so the same level always looks the same. Each prop type is one `InstancedMesh`:

| Prop | Primitives | Tris | Capacity | Density/segment (High) |
|---|---|---|---|---|
| Barricade | 1 box 1.6×0.9×0.5 + 2 feet boxes | 36 | 48 | 3 |
| Sandbag wall | 12 boxes 0.5×0.25×0.3 jittered, merged | 144 | 32 | 2 |
| Wrecked car | body box 1.8×0.7×4.0, cabin box 1.6×0.6×1.8, 4 cylinder wheels (8 seg), merged; random yaw ±25°, flipped 20% | 180 | 24 | 1.2 |
| Ruined building | 2–4 stacked boxes with random top cut (scale.y 0.6–1.0), window canvas 256×256 emissive map | ~60 | 32 | 1.5 |
| Dead tree | trunk cylinder 6 seg + 4 branch cylinders 4 seg, merged | 110 | 40 | 2 |
| Rubble | 5 × `TetrahedronGeometry(0.4)` merged | 20 | 48 | 3 |
| Smoke column | 3 stacked billboard quads, shared 256×256 noise canvas, UV scroll `uTime*0.05`, per-instance `iPhase` | 6 | 12 | 0.4 |
| Lamp post | cylinder + bent box arm | 40 | 24 | 1 |

Low tier density multiplier 0.4, Medium 0.7. Prop instance matrices are rewritten (position z += scroll) in one tight loop per frame: 260 matrices ≈ 0.15 ms; when a segment recycles, its props are re-placed from the PRNG.

**Dust motes.** `Points`, 300 vertices in a 12 × 8 × 30 m box in front of the camera, size 0.06 m, 32×32 radial canvas sprite, drift `(0.2, −0.1, 1.0) m/s`, wrapped in the vertex shader (no CPU update).

## 4. Characters: procedural modelling and bone-less animation

### 4.1 The shared character pipeline

Every character class is built once as a single merged `BufferGeometry` (`BufferGeometryUtils.mergeGeometries`) with two extra vertex attributes:

- `aPart` (float): 0 torso, 1 head, 2 left leg, 3 right leg, 4 left arm, 5 right arm, 6 weapon, 7 accessory
- `aPivot` (vec3): the joint the part rotates around (hip for legs, shoulder for arms, neck for head)

Per-instance attributes (`InstancedBufferAttribute`, `DynamicDrawUsage`):

| Attribute | Type | Meaning |
|---|---|---|
| `iPhase` | float | walk cycle offset 0–2π (random per zombie; squad members get `i * 0.37`) |
| `iSpeed` | float | 0 idle, 1 walking, 1.6 running (scales amplitude and frequency) |
| `iHitTime` | float | seconds; hit flash decays in shader |
| `iFireTime` | float | seconds; rifle recoil decays in shader |
| `iDeath` | float | 0 alive → 1 fully dead (darkens, sinks) |
| `iTint` | vec3 | ±8% hue/value variation per zombie |

Vertex shader (injected through `material.onBeforeCompile`, replacing `begin_vertex` and `beginnormal_vertex`; the identical chunk goes into `customDepthMaterial` so shadows swing too):

```glsl
float w   = uTime * uFreq * max(iSpeed, 0.0001) + iPhase;
float sw  = iSpeed * sin(w);
float ang = 0.0;
if (aPart == 2.0) ang =  uLegAmp * sw;
if (aPart == 3.0) ang = -uLegAmp * sw;
if (aPart == 4.0) ang = uArmRest - uArmAmp * sw;
if (aPart == 5.0) ang = uArmRest + uArmAmp * sw;
if (aPart == 1.0) ang = uHeadBob * sin(2.0 * w);
vec3 p = position - aPivot;
float c = cos(ang), s = sin(ang);
p = vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);   // rotate about X through the pivot
transformed = p + aPivot;
transformed.y += uBobAmp * abs(sin(w));
if (aPart == 6.0) transformed.z += uRecoil * exp(-(uTime - iFireTime) * 18.0);
transformed.y -= 0.6 * smoothstep(0.7, 1.0, iDeath);   // sink after topple
```

Fragment additions: `diffuseColor.rgb *= iTint; diffuseColor.rgb += vec3(1.0) * max(0.0, 1.0 - (uTime - iHitTime) * 8.0); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12), iDeath * 0.6);`

Per-class uniforms:

| Class | `uFreq` (Hz, ×2π in shader) | `uLegAmp` | `uArmAmp` | `uArmRest` | `uBobAmp` | Torso pitch (baked) |
|---|---|---|---|---|---|---|
| Soldier | 2.2 | 0.55 | 0.0 (arms hold rifle) | 1.2 rad forward | 0.03 | 0 |
| Walker | 1.1 | 0.45 | 0.25 | 1.1 (arms out) | 0.04 | 0.35 |
| Runner | 2.8 | 0.9 | 0.7 | 0.3 (arms back) | 0.05 | 0.5 |
| Crawler | 1.6 | 0.0 | 0.8 (arms drag) | 1.4 | 0.0 | 1.2 (prone) |
| Brute | 0.9 | 0.4 | 0.3 | 0.6 | 0.08 | 0.25 |
| Spitter | 1.0 | 0.4 | 0.2 | 0.9 | 0.03 | 0.4 |

CPU per frame per instance: compose one `Matrix4` from position, yaw (`atan2` toward the squad for zombies, 0 for soldiers), topple rotation (death) and uniform scale (spawn pop), write into `instanceMatrix.array` at `i*16`. 560 instances ≈ 0.5 ms. `mesh.count = active` so dead slots cost nothing on the GPU.

**Death topple (CPU):** `t = clamp((now − deathTime) / 0.55, 0, 1)`; rotate about the foot pivot by `1.5708 * easeOutBack(t)` around ±X (sign from hit direction), `iDeath = t`; instance freed at `now − deathTime > 1.4 s`. Blood puff: 6 particles at hit point; death burst: 14 particles.

**Spawn pop (soldiers added by a gate):** instance scale `easeOutBack(t / 0.25)` from 0 to 1 at the squad centre, then formation slot lerp.

### 4.2 Recipes (dimensions in m, segment counts chosen for a low-poly silhouette)

**Soldier (1.5 m, ~340 tris, 9 primitives)**

| Part | Geometry | Position (x, y, z) | `aPart` | Pivot |
|---|---|---|---|---|
| Torso | `BoxGeometry(0.44, 0.50, 0.26)` | (0, 0.78, 0) | 0 | – |
| Head | `SphereGeometry(0.17, 8, 6)` | (0, 1.20, 0) | 1 | (0, 1.03, 0) |
| Helmet | `SphereGeometry(0.20, 8, 4, 0, 2π, 0, π/2)` | (0, 1.22, 0) | 1 | same |
| Legs ×2 | `CylinderGeometry(0.07, 0.08, 0.50, 6)` | (±0.11, 0.27, 0) | 2 / 3 | (±0.11, 0.52, 0) |
| Boots ×2 | `BoxGeometry(0.14, 0.09, 0.22)` | (±0.11, 0.045, 0.03) | 2 / 3 | same as leg |
| Arms ×2 | `CylinderGeometry(0.06, 0.07, 0.42, 6)` | (±0.27, 0.80, 0) | 4 / 5 | (±0.27, 1.00, 0) |
| Rifle | `BoxGeometry(0.07, 0.08, 0.62)` + `CylinderGeometry(0.02, 0.02, 0.28, 6)` barrel | (0.16, 0.95, −0.35) | 6 | – |
| Backpack | `BoxGeometry(0.30, 0.30, 0.14)` | (0, 0.84, 0.20) | 0 | – |

Colours are baked per vertex (`color` attribute, `vertexColors: true`) so the whole class is one material and one draw call. Capacity 300 instances (108 k tris). Beyond 300 soldiers the count keeps rising numerically; visual density caps at 300 and damage scales with the true count.

**Walker (1.6 m, ~300 tris):** soldier topology without helmet/rifle/backpack; torso pitched 0.35 rad (baked); arms forward; one shoulder lowered 0.06 (asymmetric silhouette); torn shirt faked as 3 darker vertex-colour wedges on the torso. Capacity 120.

**Runner (1.5 m, ~280 tris):** thinner limbs (r 0.05), torso box 0.36 wide, leaned 0.5 rad. Capacity 60.

**Crawler (0.7 m, ~180 tris):** torso box 0.4×0.26×0.7 lying flat, head sphere, 2 arms (`aPart` 4/5 with `uArmAmp` 0.8 alternating), stub pelvis cone. Capacity 40.

**Brute (2.8 m, ~420 tris):** torso `BoxGeometry(1.1, 1.2, 0.7)`, shoulder spheres r 0.32, arms cylinders r 0.16 h 1.1, fists spheres r 0.2, legs r 0.18 h 0.9, head sphere r 0.26 sunk into torso, 3 spine cones r 0.08 h 0.25 (`#9C3C3C`). Capacity 16. Takes 3 soldiers per contact; trauma 0.35.

**Spitter (1.7 m, ~330 tris):** walker body + throat sac sphere r 0.16 (emissive, pulsing via `uTime`). Projectile: `IcosahedronGeometry(0.25, 0)` glob (`#C7E84B`, emissive 2) from a 32-instance pool, arc `y = 1.4 + 3.5·t − 4.9·t²`.

**Boss (7 m, ~1,900 tris, unique `Group`, CPU-animated):** torso box 2.6×3.0×1.6 plus a 1.15×-scaled shoulder box, head sphere r 0.9 + jaw box 1.0×0.4×0.8 (hinged, opens 0.6 rad on roar), shoulder spheres r 0.9, arms cylinders r 0.45 h 2.4 + fist spheres r 0.55, legs cylinders r 0.55 h 2.6, 5 spine cones r 0.2 h 0.6, 6 chain torus links r 0.15 tube 0.04 (sway `sin(uTime*3)`), exposed core sphere r 0.5 emissive `#FF4A1F` × 3, 4 armour plate boxes `#2F2F33`. Phases: 100–60% advance 2 m/s + fist slam every 3 s (trauma 0.35, AoE ring decal); 60–30% spawns 4 runners every 4 s, charge 6 m/s for 1 s; <30% core pulses 2 Hz, spit volleys ×3. Death: slow-mo 0.25× for 1.2 s, 120 ms white flash (reduced motion: 150 ms dim instead), 1.1 s topple, 400-particle burst, 60-coin fountain.

**Friendly troops:** hero sniper = soldier recipe with long rifle (0.9 m) and coat box; flamethrower = soldier + tank cylinder r 0.14 h 0.4 on back + continuous flame emitter (30 particles/s, `#FFB347` → `#FF3B1F`); medic = white recolour; drone turret = `OctahedronGeometry(0.22)` body + 4 rotor discs `CircleGeometry(0.12, 8)` spinning 20 rad/s, hovers at y 2.2 with 0.1 m sine bob; APC = box 2.2×1.1×3.4 + 6 wheels + turret cylinder, drives at the squad's front edge. Friendly troops are ordinary `Mesh`es (≤ 5 on screen) sharing the soldier material.

### 4.3 Formation

Slot `i` (0-based, golden-angle sunflower): `r = s(n)·√i`, `θ = i · 2.39996`, `x = 0.75·r·cos θ`, `z = 1.35·r·sin θ`. Spacing `s(n) = 0.42` for n ≤ 50, linear to `0.26` at n ≥ 300. Half-width at 300 = 0.26 × 17.3 × 0.75 = 3.4 m (fits a 4 m half-road). Slot table precomputed once for n ≤ 300. Soldier position lerps to its slot with `1 − exp(−8·dt)`; squad x clamps to ±(4.0 − halfWidth − 0.3). Count label floats at world (squadX, 2.6 + 0.08·√n, 0).

## 5. Gates

**Geometry (instanced frames, pooled panels).** Frame = 2 posts `CylinderGeometry(0.12, 0.12, 3.2, 8)` + top bar `BoxGeometry(3.6, 0.22, 0.22)` + 2 chevron wedges, merged → `InstancedMesh` (capacity 12, `iType` attribute selects frame colour and chevron direction in-shader; hazard stripes are a procedural `mod(uv.x*8 + uv.y*8, 2) < 1` in the fragment for negative types). Panel = `PlaneGeometry(3.4, 2.2)` from a pool of 12 `Mesh`es (unlit, transparent). Glow = additive quad 4.2 × 2.8 behind the panel with a shared 128 × 128 radial canvas.

**Numbers with zero texture uploads.** A single **digit atlas** canvas 1024 × 128 holds `0–9 + − × ÷ ★ ⚡ ✚` drawn once at boot in Lilita One 110 px, white fill, 14 px `#0B0F1A` stroke. Gate text is an `InstancedMesh` of quads (capacity 12 gates × 5 glyphs = 60) with per-instance `iGlyph` (atlas column), `iPopTime`, `iColor`. The same atlas drives floating damage numbers (capacity 128, billboarded in the vertex shader) and the "+17" burst above the squad on gate pass. No `CanvasTexture.needsUpdate` fires during play.

**Pop on hit:** `scale = 1 + 0.28·max(0, 1 − (uTime − iPopTime)·5.5)`; panel emissive +1.0 decaying over 120 ms; 4 spark particles at the bullet hit point.

**Sizes:** number height 0.95 m (≈ 92 CSS px tall when the gate is 15 m away on the reference phone), glyph 0.7 m. Gates become visible at z = −110 and readable (≥ 24 px) from z = −60, i.e. 6.7 s before reaching the squad at base speed.

**Recolour across zero:** when a `−N` gate is shot to 0 and beyond, panel tint and frame lerp red → grey (200 ms) → blue (200 ms); the `−` glyph swaps to `+`; hazard stripes fade via `uStripeMix`.

**Colour-blind safety (always on, no setting needed):** type is encoded four ways: **hue** (blue/green vs red/orange), **luminance** (positive panels L ≈ 65, negative L ≈ 50), **glyph** (+ × − ÷ at 0.7 m), and **shape** (rounded top + up-chevrons vs square top + hazard stripes + down-chevrons). The "High-contrast gates" setting raises panel opacity to 0.6 and doubles stripe contrast.

## 6. Weapons, projectiles, particles, juice

**Bullets.** Struct-of-arrays typed buffers (capacity 256): `x, z, vz, life, dmg, type`. Speed 45 m/s, life 2.8 s. Rendered as one `InstancedMesh` of `BoxGeometry(0.04, 0.04, 0.9)` tracers with HDR colour per weapon. Collision: zombies are bucketed by z into 2 m bins each frame (260 inserts); each bullet checks its bin and the next (≤ 6 candidates), circle test in XZ. Gate hits: bullet z crosses gate z and |x − gateX| < 1.7.

| Weapon | Tracer colour (HDR) | Rate | Pattern |
|---|---|---|---|
| Rifle | (3.0, 2.6, 1.6) | 6 /s per soldier; max 40 tracers/s drawn, the rest are merged into the nearest tracer's damage | straight |
| Shotgun | (3.0, 2.0, 1.0) | 2 /s | 5 pellets ±12° |
| Minigun | (3.5, 3.5, 2.5), thin 0.02 | 18 /s | ±3° jitter |
| Laser | (4.0, 1.0, 3.6), continuous `CylinderGeometry` r 0.08, pulse 8 Hz | continuous | pierces |
| Rocket | box + cone body, smoke trail 20 particles/s | 1.2 /s | AoE r 2.5, trauma 0.3, FOV kick +4° |
| Railgun | (2.0, 3.6, 4.0) beam r 0.12, 2 s charge glow | 0.5 /s | pierces all, 60 ms screen flash |

**Particles (GPU-simulated).** One `InstancedMesh` of a unit quad, capacity 1024 (High) / 512 / 256. Per-instance attributes: `p0 (vec3), v0 (vec3), birth, life, size, colorIdx, kind`. The vertex shader computes `p = p0 + v0·t + 0.5·g·t²`, billboard, size over life, alpha over life; **the CPU writes only on spawn** (ring buffer, oldest overwritten). Kinds: spark (additive, g = −9.8, 0.4 s), blood (normal, 0.5 s, `#6E1A1A`), muzzle flash (0.07 s, scale 0.5 → 0, random roll), smoke (1.6 s, grows 3×), coin sparkle, gate shards. Per-frame CPU cost is zero.

**Muzzle flash:** additionally a 0.35 m plane at each firing soldier's barrel from a 64-instance pool, 2-frame canvas (star / blob), lifetime 60 ms, random roll.

**Hit flash:** `iHitTime` write only. **HP bars:** one `InstancedMesh` of two quads (bg 0.9 × 0.1 and fill) with `iHp` scaling the fill in-shader, billboarded, hidden when `iHp == 1`. One draw call for all zombies; the boss bar is DOM.

**Screen shake:** trauma `T ∈ [0,1]`, shake `= T²`, camera offset `= shake·(0.35·noise(t·25), 0.25·noise(t·25+7), 0)` m, roll `= shake·2°`, decay 1.2/s. Sources: gate pass 0.15, brute hit 0.35, rocket 0.3, boss slam 0.35, boss death 0.8.

**Slow-mo:** `timeScale` 0.25 for 1.2 s on boss kill; 0.6 for 0.3 s on big combo; audio playback rate follows at 0.85 (not fully, keeps the hit crunchy).

**Haptics:** `navigator.vibrate?.(ms)` guarded; gate pass 20, soldier lost 10, boss hit 30, boss death [60, 40, 120]. Off automatically on iOS (API absent).

## 7. Lighting, post-processing, quality tiers

**Lights.** `DirectionalLight` `#FFD2A0` intensity 3.0 at squad + (8, 12, −14), target squad + (0, 0, −15), moved with the squad every frame (keeps the shadow frustum tight). `HemisphereLight` sky `#7FB0E0`, ground `#5A4634`, intensity 0.9. Point lights: boss core (`#FF4A1F`, intensity 20, distance 14) and laser (12 while active) only. Max 2 dynamic point lights.

**Shadows.** `PCFSoftShadowMap`; ortho frustum left −14, right 14, top 40, bottom −12, near 1, far 60; `bias −0.0005`, `normalBias 0.02`. Casters: soldiers, zombies, boss, props, APC. Receivers: road, ground. Particles, tracers, gates: neither.

**Tone mapping / colour.** `ACESFilmicToneMapping`, exposure 1.05, `outputColorSpace = SRGBColorSpace`. Grade (folded into the final output pass): shadows (luma < 0.3) mixed 8% toward `#1E6C7A`, highlights (luma > 0.7) 10% toward `#FFB070`, saturation 1.12, vignette `1 − 0.35·smoothstep(0.5, 1.4, dist)`.

**Bloom.** `UnrealBloomPass` at half resolution: strength 0.55, radius 0.4, threshold 0.85. Only HDR materials (gate glyphs, tracers, lasers, boss core, lit windows, zombie eyes marginally) cross the threshold; the scene stays crisp.

**Composer chain:** `RenderPass` (HalfFloat target, `samples: 4` MSAA on WebGL2) → `UnrealBloomPass` → `OutputPass` extended with grade/vignette uniforms. Three fullscreen passes total on High; on Low no composer (`renderer.render` with `antialias: true`).

### 7.1 Quality tiers

| Setting | High | Medium | Low |
|---|---|---|---|
| DPR cap | 2.0 | 1.5 | 1.0 |
| Shadow map | 2048 PCFSoft | 1024 PCFSoft | off → instanced blob discs (`CircleGeometry(0.35, 12)`, `#000` @ 0.35) under characters |
| Bloom | half-res, 5 mips | quarter-res, 3 mips | off → additive glow quads only |
| MSAA samples | 4 | 2 | 0 (renderer `antialias: true`) |
| Materials | Standard | Standard | Lambert |
| Particles cap | 1024 | 512 | 256 |
| Tracers drawn | 256 | 128 | 64 |
| Prop density | 100% | 70% | 40% |
| Fog far | 125 m | 110 m | 90 m (spawn horizon pulled to −95) |
| Anisotropy | 8 | 4 | 1 |
| Dust motes | 300 | 150 | 0 |
| Smoke columns | yes | yes | no |
| `backdrop-filter` blur in UI | yes | no | no |
| HP bars | all | all | only when damaged |
| Boss point light | yes | yes | emissive only |

**Initial tier** from a zero-cost heuristic: GPU string (`WEBGL_debug_renderer_info`): Apple A14+/M-series → High; Adreno 7xx / Mali-G7x+ → High; Adreno 6xx / Mali-G5x → Medium; anything else or `navigator.deviceMemory ≤ 3` → Low. Desktop with discrete GPU → High.

**Auto-scaling:** 60-frame rolling mean of `performance.now()` deltas. Drop one tier if the mean > 18.5 ms for 3 s; raise if the mean < 12 ms for 10 s and tier < initial. Hysteresis: at most one change per 15 s; never during the boss intro or the first 2 s of a level. A manual tier in Settings disables auto.

## 8. Camera

| Param | Portrait (aspect < 0.75) | Landscape / desktop |
|---|---|---|
| `fov` (vertical) | 55° | 42° |
| Position | (0.4·squadX, 9.5, 11) | (0.4·squadX, 10.5, 13) |
| Look-at | (0.6·squadX, 1.0, −14) | (0.6·squadX, 1.0, −16) |
| near / far | 0.5 / 160 | 0.5 / 160 |

Portrait check: horizontal FOV = 2·atan(tan 27.5° × 0.4615) ≈ 27°; the 8 m road at the gate-pass point (z = −14, distance ≈ 26 m) spans 8 / (2 × 26 × tan 13.5°) ≈ 64% of the width, leaving prop bands visible on both sides. Follow: `camera.x` lerps with `1 − exp(−5·dt)`; look-at x with `1 − exp(−7·dt)` (the look leads the body slightly for a steering feel). Resize/orientation: tween between presets over 300 ms. Boss intro: dolly to (0, 7, 7) looking at the boss over 1.2 s (`easeInOutCubic`), hold 0.8 s, return; input locked, squad keeps firing. Shake and FOV kick as in §6; both multiplied by 0 under reduced motion.

## 9. UI / UX

All UI is DOM (HTML + CSS) over the canvas; the canvas is `position: fixed; inset: 0; touch-action: none`. Root scale: `--ui: clamp(0.85, min(100vw / 390, 100vh / 844), 1.25)`; every px value below multiplies by `--ui`. Safe areas: `padding-top: max(12px, env(safe-area-inset-top))`, bottom `max(16px, env(safe-area-inset-bottom))`. Fonts (Google Fonts, `display=swap`, `preconnect`): **Lilita One** for display, numbers, titles and the canvas digit atlas; **Nunito** 600/800 for body and buttons. Fallback stack `"Lilita One", "Arial Black", Impact, sans-serif`; the digit atlas waits on `document.fonts.load('110px "Lilita One"')` (max 1.5 s) and redraws once if the font arrives late; an offline PWA with no cached font falls back cleanly.

**Type scale (390 px base):** Display 56 / H1 40 / H2 28 / H3 22 / Body 17 / Caption 14 / Micro 12. Line-height 1.15 display, 1.4 body. "Large text" setting ×1.15. Minimum rendered size 12 px.

**Buttons:** primary 280 × 64, secondary 132 × 52 or 280 × 52, icon 48 × 48; hit area never < 48 × 48; radius 16; 3 px darker bottom border; press = `translateY(2px) scale(0.97)` over 80 ms + 10 ms haptic; gaps 12–16 px; `:focus-visible` 3 px `--focus` ring; `aria-label` on every icon button. No hover-only affordances (`@media (hover: hover)` only adds brightness).

### 9.1 Screens (y values are top edges in the 844 px reference)

**Title.** The 3D scene idles behind (squad marching, gates sliding, no zombies, camera 15% lower). Logo "GATE RUSH" Lilita 56 px, gradient `#FFB02E → #FF7A2F`, 4 px `#1A1200` outline, −4° skew, y 150, 2 s bob (off in reduced motion). Settings gear 48 × 48 at (16, safe-top). Coin pill top-right. PLAY (primary 280 × 64) at y 560; caption "Level 7 · Best ★★★" 14 px muted at y 632; SHOP and LEVELS (132 × 52) at y 660 with a 16 px gap. Version micro text at y 800.

**HUD (in-game).**

| Element | Position / size | Notes |
|---|---|---|
| Pause | 48 × 48 at (16, safe-top) | icon ‖ |
| Level progress | bar 220 × 14 at (85, safe-top + 17); label "LVL 7" 14 px above | fill `--success`; squad marker 18 px triangle; skull marker 22 px at 100%; special-gate ticks 6 px |
| Coins | pill 96 × 36 at (278, safe-top + 6) | icon 20 px + Lilita 18 px; count-up tween 300 ms |
| Power-up timers | up to 3 pills 88 × 36 centred at y safe-top + 70 | 28 px radial countdown ring (conic-gradient), icon, seconds |
| Boss bar | 330 × 18 at (30, safe-top + 110), name 16 px above | appears on boss spawn with a 400 ms slide; phase ticks at 60% / 30% |
| Squad count | world-projected label, Lilita 44 px, white, 3 px `#0B0F1A` text-stroke | `translate3d` updated per frame, text node updated only on change; pop 1 → 1.25 → 1 in 160 ms; flash `--success` on gain / `--danger` on loss for 300 ms |
| Floating gate feedback | "+17" at the squad label, rises 40 px in 700 ms | digit-atlas world quads, not DOM |
| Tutorial hint | hand icon 64 px + "Drag to steer" 22 px at y 620 | first run only; fades after 2 s of cumulative drag; second hint "Shoot the gates to raise their number" at the first gate |
| Bottom 180 px | empty | thumb zone kept clear |

**Pause.** Dim `rgba(8,12,22,0.72)` (+6 px backdrop blur on High). Panel 330 × 380 centred, radius 24. "PAUSED" H1. RESUME primary 280 × 64; RESTART, SETTINGS, QUIT 280 × 52 each, 12 px gaps. Audio ducks −12 dB; rendering continues at 30 fps for the blur (High) or rAF stops (others).

**Settings.** Rows 56 px: Sound (slider 0–100, 28 px thumb), Music (slider), Haptics (toggle 56 × 32), Quality (segmented Auto / Low / Med / High, 48 px tall), Reduced motion (toggle, defaults from `prefers-reduced-motion`), High-contrast gates (toggle), Large text (toggle), Drag sensitivity (segmented 0.75 / 1 / 1.3), Reset save (danger; since `confirm()` is a no-op in the iframe, the button turns into "Tap again to confirm" for 3 s). Persist on change (guarded `localStorage`).

**Shop.** Header with coin balance. 5 upgrade cards 358 × 96 (icon 56, name H3, 10 level pips, effect caption, BUY 104 × 44 with price; disabled state 40% opacity + "MAX"). Scrollable list with `overscroll-behavior: contain`. Purchase: card flash `--success`, coin count-down 300 ms, haptic 20 ms.

**Level select.** 4-column grid of 76 × 76 tiles, 12 px gaps; number Lilita 28; three 14 px stars below; every 5th tile has a skull badge (boss level); locked = `#2A3142` with lock icon; current = `--primary` 3 px border. Scrollable.

**Level complete.** "LEVEL 7 CLEAR" H1 at y 180; 3 stars 72 px at y 260 animating in (scale 0 → 1.2 → 1, 150 ms stagger, haptic per star); "Coins +340" count-up 1.2 s; "Best 3★ · 1,200 coins"; NEXT primary at y 560; REPLAY / SHOP 132 × 52 at y 640.

**Game over.** "SQUAD LOST" H1 in `--danger`; "Reached 64% · Coins kept +120"; RETRY primary; SHOP / HOME. Camera lingers on the fallen squad with a slow 10° orbit (static under reduced motion).

**Lifecycle:** `visibilitychange` → auto-pause; `resize` / `orientationchange` → debounce 120 ms, re-fit camera and `--ui`; WebGL `webglcontextlost` → "Reloading graphics…" overlay and rebuild on `webglcontextrestored`. The fullscreen button is hidden when `document.fullscreenEnabled` is false or the request rejects (iframe).

## 10. Touch and desktop controls

- **Drag anywhere** (`pointerdown` on the canvas; `touch-action: none`; `{ passive: false }` + `preventDefault` to kill scroll/zoom; `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">`).
- Relative steering: `targetX += dx_px × k`, `k = 8.0 m / (0.62 × viewportWidth_px)` → a swipe of 62% of the screen width moves the squad across the whole road (k ≈ 0.0331 m/px at 390 px). Sensitivity setting ×0.75 / ×1 / ×1.3.
- Dead zone: ignore the first 2 px of movement per gesture (filters tap jitter); no tap actions exist in-game, so a tap never does anything accidental.
- Smoothing: `squadX += (targetX − squadX) × (1 − exp(−14·dt))`; max lateral speed 12 m/s; soldiers lean 6° into the move (formation group roll).
- Only the first `pointerId` steers; a second finger is ignored; `pointercancel` releases cleanly. `getCoalescedEvents()` is used when available; input is accumulated in `pointermove` and consumed once per rAF.
- **Desktop:** mouse drag identical; keyboard `A`/`D`/`←`/`→` drive `targetX` at 9 m/s with 0.08 s acceleration; `P`/`Esc` pause; `M` mute. Optional "hover steer" (mouse x maps absolutely to road x), desktop only, in Settings.
- Gamepad: left stick x (dead zone 0.15), `Start` pauses. Polled, two lines of code.

## 11. Accessibility

| Concern | Measure |
|---|---|
| Reduced motion | `prefers-reduced-motion` auto-enables: shake ×0, FOV kick off, slow-mo kept (not motion) but the flash becomes a 150 ms dim, logo bob off, particle cap ×0.5, star stagger shortened to 60 ms, game-over orbit static |
| Colour vision | Gates encoded by hue + luminance + glyph + shape (§5); HP bars always red-on-dark with a width cue; power-up pills carry icons, never colour alone; "High-contrast gates" setting |
| Flashing | No element flashes > 3 Hz; the boss-death flash is a single 120 ms event |
| Touch targets | ≥ 48 × 48 CSS px; 12 px minimum spacing |
| Text | ≥ 4.5:1 contrast; Large text ×1.15; number labels have outlines so they read over any background |
| Screen readers | Buttons have `aria-label`; screens are `role="dialog"` with `aria-modal`; focus moves to the first button on open; canvas is `aria-hidden` |
| Keyboard | Full menu navigation with Tab/Enter/Esc; visible focus ring |
| Audio | Every audio cue has a visual twin (gate pop, hit flash, count ticker) so muted play is complete |
| Haptics | Toggle; guarded API |
| Motion sickness | FOV fixed per orientation; camera y/z never animate except the boss intro |

## 12. Performance

### 12.1 Frame budget (ms, High tier, 60 fps, mid-range 2021 Android)

| Subsystem | Budget | Technique |
|---|---|---|
| Input sampling | 0.1 | consume the accumulated pointer delta |
| Squad formation + lerps | 0.4 | typed arrays, precomputed slot table for n ≤ 300 |
| Bullets update + collision | 0.8 | SoA typed arrays, z-bins, swap-remove |
| Zombies AI + movement | 0.6 | 260 max, no pathfinding: move toward squad x with 1 Hz re-target |
| Gates + spawner + waves | 0.2 | precomputed level script, cursor index |
| Particles spawn | 0.2 | attribute writes only on spawn |
| Instance matrix writes | 0.8 | 560 characters + 260 props + 256 tracers + 60 glyphs + 128 numbers; `addUpdateRange(0, count·16)` |
| Audio scheduling | 0.2 | 100 ms lookahead, max 12 voiced shots/s |
| DOM updates | 0.3 | HUD text only on change; progress/coins at 10 Hz |
| three.js traversal + submit | 2.5 | ≤ 45 main draw calls, flat scene (no deep Groups), `matrixAutoUpdate = false` on statics, frustum culling kept on |
| **JS total** | **6.1** (1.4 headroom to the 7.5 cap) | |
| GPU: shadow pass | 2.0 | 2048 map, casters only |
| GPU: opaque + transparent | 4.0 | ≤ 350 k tris; one overdraw-heavy layer (gate panels, particles) |
| GPU: bloom | 2.0 | half-res |
| GPU: output/grade | 0.8 | merged pass |
| **GPU total** | **8.8** | |

### 12.2 Draw-call budget (High tier)

| Group | Calls |
|---|---|
| Sky, ground, 6 road segments, 2 curb instanced | 10 |
| Props 8 types (+ blob shadows on Low) | 8 |
| Characters: soldier + 5 zombie types | 6 |
| Boss (unique group, 1 material) | ~4 |
| Friendly troops | ≤ 5 |
| Gate frames, 12 panels, glow quads, glyph quads | 1 + 12 + 1 + 1 |
| Tracers, laser, rockets, spit globs | 4 |
| Particles, muzzle flashes, HP bars, damage numbers, coins, dust | 6 |
| **Main pass total** | **≈ 45** |
| Shadow pass (casters re-rendered) | ≈ 20 |
| Post passes | 3–7 |

### 12.3 Memory

| Asset | Size |
|---|---|
| Geometry (all classes + props) | < 6 MB |
| Canvas textures: road 512×1024, digit atlas 1024×128, glow 128×128, smoke 256×256, windows 256×256, concrete noise 256×256, particle 64×64, muzzle 128×64, dust 32×32 | ≈ 3.5 MB plus mips |
| Render targets (DPR 2, 390×844 → 780×1688, HalfFloat MSAA + bloom mips) | ≈ 28 MB |
| JS heap steady state | < 40 MB, zero growth between GC cycles during play |

### 12.4 Hot-loop rules (enforced in code review)

1. No `new` in `update()`: module-level scratch `_v3a, _v3b, _q, _m4`; pools for bullets, particles, globs, flashes, DOM number labels.
2. No `Array.prototype.map/filter/forEach` in hot paths; indexed `for` loops; swap-remove for pools.
3. `InstancedMesh.count` tracks active instances; `instanceMatrix.needsUpdate = true` once per mesh per frame; `setUsage(DynamicDrawUsage)`.
4. Strings only on change (`if (n !== lastN) label.textContent = n`), never per frame.
5. No per-frame material or uniform object creation; `uTime` is one shared uniform object referenced by every custom material.
6. `renderer.info.render.calls` and the rolling frame time are shown in a debug overlay (`?debug=1`) with a red flag when calls > 50 or JS > 7.5 ms.
7. Textures are built in a boot stage with a progress bar (total ≈ 120 ms), never during play.
8. `requestAnimationFrame` loop with `dt = min(0.05, raw)`; fixed-step simulation at 120 Hz for bullets/collisions so 45 m/s tracers never tunnel through a gate plane.

## 13. Must-have coverage (brief; other angles own the tuning)

- **Road & camera:** §3, §8. Fog to the horizon; endless recycled segments.
- **Squad:** §4.3; count label; auto-fire 6 /s baseline scaled by upgrades; grow/shrink animations.
- **Gates:** §5; pairs by default (x = ±2.0), singles centred, triples at x = −2.7 / 0 / +2.7 with 2.4 m panels; spacing 28 m; each bullet raises `+N`/`−N` by 1 (×N and ÷N by 0.1 per 5 hits, shown with one decimal); `−N` → 0 → `+N` recolour.
- **Zombies:** §4.2; contact kills 1 soldier (brute 3); waves scripted per segment as `[z, type, count, lane]` arrays; boss every 5th level.
- **Specials:** purple special gates (§2.1) and crates (`BoxGeometry(0.8)` with emissive seams); weapon power-ups last 10 s with HUD pill timers; gear and troops as listed in the brief.
- **Economy & meta:** coins per kill (1), gate (5), level (100 × level); shop upgrades (start squad, fire rate, damage, coin ×, boss damage); level select; results with stars (1 = finish, 2 = ≥ 50% squad alive, 3 = boss down under 45 s).
- **Juice:** §6 in full.
- **UI:** §9 in full.
- **Audio (synth sketch):** master → `DynamicsCompressor`; rifle = 30 ms noise burst (bandpass 1.8 kHz, Q 1.2) + 160 → 60 Hz sine pitch drop, voiced ≤ 12/s with ±8% random rate; gate tick = sine 880 → 1320 Hz, 40 ms; gate pass = C5-E5-G5 chord, 120 ms; zombie death = 120 ms noise with low-pass sweep 3 kHz → 300 Hz; coin = two 1760 Hz blips; boss roar = 55 Hz saw + waveshaper; music = 4-bar loop at 120 BPM, saw bass + detuned pad + noise hats, scheduled 100 ms ahead. The audio context resumes on the first pointer event.
- **Persistence:** one `save` JSON object in `localStorage` under `gaterush.v1`, every access wrapped in `try/catch` with an in-memory fallback; `version` field for migration.
- **Two shells:** `index.html` (iframe-safe, no service worker) and `pwa/index.html` (manifest, SW caching the CDN modules and fonts, 192/512 px icons drawn to canvas once and stored as data URLs in the manifest).

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| HalfFloat render targets unsupported (rare old GPUs) | detect `EXT_color_buffer_half_float`; fall back to UnsignedByte and disable bloom (Low) |
| iOS Safari DPR 3 + MSAA memory | DPR capped at 2; samples 2 on iOS; `webglcontextlost` handler |
| Google Fonts blocked / offline | fallback stack; atlas redraw on font load |
| `backdrop-filter` jank | High tier only; `will-change` avoided elsewhere |
| Shadow acne on instanced deformed meshes | `normalBias 0.02`; depth material shares the deformation chunk |
| 300 soldiers + 260 zombies + shadows exceeding GPU on Medium | shadow map 1024; casters limited to the nearest 150 zombies (crawlers never cast) |
| Overdraw from gate panels + glow + particles | panels `depthWrite false`, one glow quad per gate, particle size capped at 0.6 m near the camera |
| Drag conflicts with browser gestures (back-swipe, pull-to-refresh) | `overscroll-behavior: none`, `touch-action: none`, `preventDefault` on `pointerdown`; steering ignores the leftmost 12 px on iOS |

## 15. Standout decisions (for the integrator)

1. One merged geometry per character class with `aPart/aPivot` attributes and a shared vertex-shader limb-swing chunk: 560 animated characters in 6 draw calls, shadows included.
2. A single boot-time digit atlas drives gate numbers, floating damage numbers and squad-gain bursts as instanced quads: zero texture uploads during play, text always crisp.
3. GPU-simulated particles (position computed from `p0, v0, birth` in the shader): the CPU touches a particle exactly once.
4. Gate type is encoded in hue, luminance, glyph and frame shape simultaneously, so the core mechanic is readable by every player without a setting.
5. Grade + vignette folded into the `OutputPass` with half-resolution bloom: a three-pass post chain inside a 2.8 ms GPU budget, with a deterministic tier ladder and a 15 s-hysteresis auto-scaler.
