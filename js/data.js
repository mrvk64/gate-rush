// js/data.js — GATE RUSH: every tunable number, colour, string and recipe.
//
// Contract: docs/ARCHITECTURE.md §8 (shapes) ← docs/GDD.md §2–§16 (values).
// Rules for this file (ARCHITECTURE §1, §14):
//   • dependency-free: imports nothing (util.js is NOT imported; the two tiny helpers it would
//     provide — round10 and a MIDI→Hz conversion — are local so levelgen/tools can import data.js
//     from node with zero side effects).
//   • every export is deep-frozen at module load (plain objects and arrays; RegExp and function
//     values are left as they are — functions are allowed as values: effect/fmt/bossCoins/
//     levelBonus/s0Assumed/upgradeCost and the STRINGS templates).
//   • every id string used in events, saves and scripts comes from these tables
//     (`category.key`: 'weapon.shotgun', 'gear.armor', 'troop.medic', 'boss.hulk', 'coins').
//   • keys named in ARCHITECTURE §8.1–§8.9 are final. Keys marked "extra" below were added by the
//     data owner for a consuming module (render / models / ui / audio) so that no module needs a
//     literal tuning number; they never change a contract key's meaning.
//
// Table of contents (search for "// ==== "):
//   WORLD SQUAD FIRE GATE_RULES | ZOMBIES LEAK_MODEL WAVE_WEIGHTS WAVE_PATTERNS WAVE_RULES LEAK_BANDS
//   BOSSES | WEAPONS GEAR TROOPS PICKUP_SCHEDULE PICKUPS | UPGRADES upgradeCost ECONOMY STARS SCORE |
//   LEVELS (LEVEL_1) | QUALITY_TIERS RENDER | PALETTE | DISTRICTS (DISTRICT_PROPS DISTRICT_RULES districtForLevel
//   districtForChunk) | MUSIC JUICE | AUDIO_CUES | HINTS STRINGS

// ---------------------------------------------------------------------------------------------
// Local helpers (no exports besides the data tables)
// ---------------------------------------------------------------------------------------------

/** Deep-freezes plain objects/arrays in place and returns the root. RegExp objects are not frozen
 *  (a frozen RegExp cannot update lastIndex) and functions are left alone. Children are frozen
 *  before their parent, so an already-frozen object (a shared reference, e.g. PALETTE.gate ===
 *  GATE_RULES.colors) can be skipped safely. */
function deepFreeze(root) {
  if (root === null || typeof root !== 'object') return root;
  if (root instanceof RegExp) return root;
  if (Object.isFrozen(root)) return root;
  const keys = Object.getOwnPropertyNames(root);
  for (let i = 0; i < keys.length; i++) {
    const v = root[keys[i]];
    if (v !== null && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(root);
}

/** round10 (same semantics as util.round10): nearest multiple of 10. GDD §9.2 shop prices. */
function round10(v) { return Math.round(v / 10) * 10; }

/** MIDI note number → Hz (A4 = 69 = 440 Hz). Used to write musical recipes by note name. */
function hz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

// MIDI note constants used by AUDIO_CUES / MUSIC (GDD §13). Octave 4 = middle C (C4 = 60).
const N = {
  C3: 48, E3: 52, G3: 55, A2: 45, F2: 41, C2: 36, G2: 43, A1: 33,
  F3: 53, A3: 57, B3: 59, C4: 60, CS4: 61, D4: 62, E4: 64, F4: 65, G4: 67, A4: 69, B4: 71,
  C5: 72, CS5: 73, D5: 74, E5: 76, F5: 77, G5: 79, A5: 81, B5: 83, C6: 84, D6: 86, E6: 88, G6: 91,
};

// ==== WORLD ==================================================================================
// GDD §2 world constants; ARCHITECTURE §2.1 / §8.1. Units: metres, seconds. Forward = −Z.
export const WORLD = deepFreeze({
  step: 1 / 60,                 // fixed simulation step (GDD §2 "fixed 1/60 s")
  maxSubSteps: 5,               // accumulator cap per frame; drop time beyond (ARCH §2.2)
  dtClamp: 0.05,                // render dt clamp (s)
  timeScaleMin: 0.25,           // slow-mo floor
  roadWidth: 8,                 // x ∈ [−4, 4]
  laneCenters: { single: [0], pair: [-2, 2], triple: [-2.7, 0, 2.7] },
  laneWidth: { single: 8, pair: 4, triple: 2.6 },
  spawnZ: -70,                  // horizon: gates, zombies, crates, coins spawn here
  despawnZ: 14,                 // recycled behind the camera
  guardOffset: 12,              // guards stand 12 m in front of their lane's gate (GDD §4.4)
  gateArmZ: -36,                // gate accepts hits from here …
  gateStopZ: -1.5,              // … until 1.5 m before the squad front
  gateCommitZ: -4,              // squad snaps to the nearer lane centre
  laneDecalZ: -10,              // lane highlight decal visible from here
  steerRange: 2.1,              // squadX ∈ ±2.1 regardless of C
  idleRoadSpeed: 6,             // title idle scene scroll speed (ARCH §4.2)
  idleGateEveryM: 60,           // decorative gate pair cadence in the title scene (ARCH §6.16)
  speed: { base: 8.0, perLevel: 0.2, cap: 12.0 },   // v(L) = min(12, 8 + 0.2·(L−1))
  bossRoadFactor: 0.35,         // road speed target during the boss (GDD §7 "lerps to 35 %")
  fog: { near: 40, far: 100, farLow: 90, runupNear: 32,
         runupLerpSeconds: 1 },  // extra: render.env.setFog(runupNear, params.fogFar, 1) at the run-up (ARCH §6.16)
  idleGate: { plusValue: 17, neverStep: 9999 },   // extra: title decorative pair "+17 | x2" (ARCH §6.16); 17 = the GDD §5 "+17" example, step never reached
  // extra (round 5, r4-release issue 5): a decorative title gate sinks into the road `rate` m per metre of z once it is
  // z0Pad behind the marching title squad (z > world.squadDepth + z0Pad) and is freed once fully under it — the title rig
  // sits 1.7 m above the gate's top bar, so a gate sliding on to despawnZ crossed the camera's near field (ARCH §6.9)
  idleGateSink: { z0Pad: 0.5, rate: 2 },
  gravity: -9.8,                // extra: m/s² along +y for CPU-integrated cosmetics (fx shards)
  camera: {
    portrait: { pos: [0.4, 9.5, 11], look: [0.6, 1, -14] },     // × squadX for the x components
    landscape: { pos: [0.4, 10.5, 13], look: [0.6, 1, -16] },
    hFovDeg: { portrait: 27.05, landscape: 68.6 },             // constant horizontal FOV per preset
    fovClamp: { portrait: [45, 75], landscape: [42, 55] },     // derived vertical FOV clamp (deg); landscape floor 42 (= 16:9) so ultra-wide windows keep the squad in frame (VIS-3)
    portraitBelow: 0.9,                                        // aspect < 0.9 → portrait preset
    near: 0.5, far: 160,
    followRate: 5,                                             // x lerp 1 − exp(−5·dt)
    lookRate: 7,                                               // look-at x lerp 1 − exp(−7·dt)
    presetTween: 0.3,                                          // s, preset switch tween
    // extra (VIS-3): count-driven dolly — camera z / y += z / y · clamp(√V − √ref, 0, maxS) (V = visible soldiers), eased
    // over `seconds`; look-at unchanged. Round-2 QA VIS-19: z 0.4 → 0.53, y 0.1 → 0.165, maxS 8 → 11 (the 300-slot
    // capacity), i.e. ≈ 1 m further back and 0.5 m higher at V = 200 (squad depth ≈ 6.5 m), so the whole formation stays on screen
    countDolly: { ref: 40, z: 0.53, y: 0.165, maxS: 11, seconds: 0.5 },
    // extra (VIS-3): title idle rig (replaces the plain RENDER.idleCameraDrop): the marching squad sits between the logo
    // and the PLAY button (× squadX for the x components, like the presets)
    title: { pos: [0, 5.0, 11], look: [0, 0, -8] },
    // extra (round-2 QA VIS-20): landscape / desktop title rig (aspect ≥ portraitBelow, blended with the preset tween). x
    // components are ABSOLUTE (the title squad marches at x = 0): the camera sits 4 m right of the squad and looks
    // straight down the road, so the squad stands left of the centred PLAY / SHOP / LEVELS column (844×390: sx ≈ 220 < 303)
    titleLandscape: { pos: [4, 5.0, 11], look: [4, 0, -8] },
  },
  roadSegments: 6, segmentLength: 30,
  segmentRecycleZ: 20,          // extra: a segment is recycled when its far edge passes z = +20 (GDD §2)
});

// ==== SQUAD ==================================================================================
// GDD §3.1 formation, §3.2 steering, §3.1 walk cycle; ARCHITECTURE §6.5 / §8.1.
export const SQUAD = deepFreeze({
  slotSpacing: 0.34,            // hex lattice spacing (m)
  rowPitch: 0.294,              // row pitch (m)
  rowOffset: 0.17,              // extra: alternate rows offset (m) — GDD §3.1
  halfWidthCap: 1.8,            // |x| ≤ 1.8 m (10–11 columns)
  ellipseZ: 1.6,                // sort key sqrt(x² + (z/1.6)²)
  slotCapacity: 300,            // slot table size (= soldier instance capacity)
  slotLerpRate: 8,              // soldier → slot lerp 1 − exp(−8·dt)
  reflowDelay: 0.2,             // s after a death before the formation re-flows
  spawnAnim: { time: 0.3, overshoot: 1.15, stagger: 0.04, maxVisible: 40,   // scale 0 → 1.15 → 1
               riseFraction: 0.6 },   // extra: share of spawnAnim.time spent growing 0 → overshoot
  death: { topple: 0.55, sink: 0.3, free: 1.4 },   // s; ease-out-back topple about the foot pivot
  dissolvePer100ms: 12,         // gate losses dissolve rim-inward, 12 soldiers per 100 ms
  dissolveAnim: { time: 0.3 },  // extra: one soldier's shrink + sink for a gate-loss dissolve (= death.sink)
  tintJitter: 0.06,             // extra: ± per-soldier brightness jitter (fraction, ctx.rngFx)
  yawJitter: 0.06,              // extra: ± per-soldier facing jitter while marching (rad, ctx.rngFx)
  steer: {
    k: 8.0, kFraction: 0.62,    // k = 8.0 / (0.62 · viewportWidthPx) m per CSS px
    deadZonePx: 2,              // first 2 px of each gesture discarded
    smoothRate: 14,             // squadX lerp 1 − exp(−14·dt)
    maxSpeed: 12,               // m/s lateral cap
    keyboardSpeed: 9,           // m/s
    keyboardAccel: 0.08,        // s ramp
    gamepadDeadZone: 0.15,
    leanDeg: 6,                 // roll into lateral movement
    iosEdgePx: 12,              // ignore pointerdown with clientX < 12 on iOS (edge swipe)
    laneLockHalfWidth: 0.3,     // target clamped to lane centre ± 0.3 while committed
    sensitivities: [0.75, 1, 1.3],   // extra: settings choices (GDD §3.2)
    // CORE-8: landscape (aspect ≥ WORLD.camera.portraitBelow) uses W_eff = min(W, landscapeWidthFactor · H) in k = 8 / (0.62 · W_eff):
    // the landscape camera shows the road at the squad ≈ H-proportional, not W-proportional (GDD §3.2)
    landscapeWidthFactor: 0.7,
  },
  // Walk cycle uniforms for models.makeCharacterMaterial('soldier') — GDD §3.1 / ARCH D18.
  limb: { uFreq: 2.2, uLegAmp: 0.55, uArmAmp: 0.3, uArmRest: 1.2, uBobAmp: 0.03, uRecoil: 0.06 },
  invulnOnPass: 0.6,            // s of invulnerability after any gate pass
  countCap: 9999,
  label: { y: 2.6, yPerSqrt: 0.08, z: 0.8, px: 72, outlinePx: 3 },   // billboard at (x, 2.6 + 0.08·√V, 0.8); 72 px; 3 px outline (extra key)
});

// ==== FIRE ===================================================================================
// GDD §3.3 fire model; ARCHITECTURE §6.11 / §8.1.
export const FIRE = deepFreeze({
  rateBase: 2.0, ratePerRank: 0.10,      // f = 2.0·(1 + 0.10·rank)
  dmgBase: 1.0, dmgPerRank: 0.15,        // d = 1 + 0.15·rank
  shooters: 40,                          // visible shooters = min(C, 40)
  weightDiv: 40,                         // w = max(1, C/40) · targetRate/spawnRate
  spawnRateCap: 200,                     // bullets/s; excess folded into w
  bullet: { speed: 35, life: 1.2, spreadDeg: 2, radius: 0.12, y: 0.95, pool: 256 },
  accuracy: 0.8,                         // squad DPS = C·d·f·gearMult·0.8
  bossAimRange: 40,                      // every shooter aims at the boss within 40 m
  bossAimYieldM: 6,                      // extra (WPN-7): the re-aim yields for a step while a living zombie is ≤ 6 m ahead of the front row
                                         // and within squadHalfWidth + 1 m of the squad's x — bullets fly straight into it (GDD §3.3 "minions still soak")
  bossAimYieldCol: 0.9,                  // extra (lead, round 3): only shooters within ±0.9 m (x) of that threat yield; the rest keep firing at the boss
  muzzleOffset: [0.16, 0.95, -0.35],     // from the soldier's slot position
  muzzleFlash: { size: 0.35, ms: 33, frames: 2, pool: 64,     // extra: GDD J1 0.35 m quad, 2 frames = 33 ms (GDD authoritative; ARCH §6.11's 60 ms amended); pool 64
                 gain: 2.4,          // extra: HDR gain of the additive flash quad (× PALETTE.fx.muzzle linear; blooms like J1's 2–4 values)
                 sizeJitter: 0.18 }, // extra: ± fraction of size per flash (ctx.rngFx)
  tracerLength: 0.9,                     // extra: GDD J1 tracer 0.9 m
});

// ==== GATE_RULES =============================================================================
// GDD §4.1 geometry & colours, §4.2 per-hit rules, §4.3 comparison, §4.4 generation; ARCH §6.9 / §8.2.
export const GATE_RULES = deepFreeze({
  panel: {
    w: 3.6, wTriple: 2.4, h: 2.4,        // panel size (m); triple lanes use 2.4 × 2.4
    bottom: 1.0,                         // bottom edge height (m)
    depth: 0.4,                          // hit-test footprint depth (m)
    opacity: 0.38, opacityHC: 0.6,       // normal / High-contrast gates
    opacityZero: 0.30,                   // extra: x1 / 0 neutral panel tint opacity (GDD §4.1)
    hitIgnoresY: true,                   // XZ-only hit tests (bullets fly below the panel)
    hitFlash: 0.12,                      // s, emissive +1.0 decaying
    hitInset: 0.2,                       // extra: hit footprint width = lane width − 0.2 (ARCH §6.9)
  },
  frame: { postW: 0.12, postH: 3.2, barW: 3.8,     // extra: two 0.12 m posts 3.2 m tall, 3.8 m top bar (GDD §4.1)
           // extra: the "^" chevron wedges on the posts (models.js builds them, materials.js flips them to "v" on −/÷);
           // one source for both so the 180° wedge rotation always lands on the baked wedges
           chevron: { rows: [1.3, 1.95, 2.6], len: 0.46, angle: 0.6 },   // row heights (m), wedge length (m), wedge angle (rad)
           farEmissive: 0.35,            // extra: frame glow before the armed line (× emissiveBoost)
           armedEmissive: 1.0 },         // extra: "frame lights up" at WORLD.gateArmZ
  glyph: {
    h3: 1.7, h4: 1.35,                   // glyph height for ≤ 3 glyphs / 4 glyphs (m)
    icon: 0.95,                          // op glyph (+ −) height (m; round-2 QA GAT-7: 0.7 read as a small grey mark); also the MAX letters / pill size
    opMultDiv: 1.05,                     // extra: × and ÷ op glyph height (m) — the ÷ dots must survive at decision distance
    badgeLift: 0.5,                      // extra: MAX letters / gold pill centred this far above the panel top (m), clear of the frame bar
    pop: 0.28, popTime: 0.12,            // scale 1 + 0.28·decay over 120 ms per hit
    fit: 0.9,                            // extra: value text never wider than 90 % of the panel (triples shrink the text)
    // round-3 FTUE (moved from gates.js DATA-MISSING by the round-3 verifier): while a gate's text block overlaps the count
    // label's plate on screen, its op + digit glyphs fade out over labelYieldS (s, ctx.time.elapsed); both extents × labelYieldMargin
    labelYieldS: 0.1, labelYieldMargin: 1.1,
  },
  // extra: gate glow quads (additive halo behind each panel; substitutes for bloom on Low, GDD §16)
  glow: { gainBloom: 0.35, gainLow: 0.9, farFrac: 0.5, scale: 1.6, pulseHz: 0.9, pulseAmp: 0.15 },
  pool: 12,                              // extra: gate pool (ARCH §6.9 / §9.1)
  eventPool: 8,                          // extra: event slots 0–7 (ARCH §6.9)
  glyphPool: 60,                         // extra: gate glyph quads (ARCH §6.9 / GDD §16)
  intakeWindowS: 0.25,                   // extra: burst capacity of the intakePerSec token bucket (40 hits/s × 0.25 s = 10; a rail bolt fits)
  // extra: per-gate feel numbers used by gates.render (GDD J3–J6)
  // emissiveFlash: J3 panel/frame flash peak (gates caps the per-hit value at 0.45 and attenuates it under
  // sustained fire); flashRetrigger: s before a new hit may restart the panel/frame flash (> panel.hitFlash → a pulse)
  // hitFlashCap: max per-hit flash written to iPanel.z / iFrame.w / glow (QA GAT-1); flashAttenHits: flash × 1 / (1 + hits in
  // the last ≈ intakeWindowS / flashAttenHits) under sustained fire; flipFlashPeak: J5 white flip flash value (> 1 adds white
  // in the panel shader, decaying to 1 over minus.flipFlash — GDD §12 J5 '0.25 s white flash')
  fx: { sparksPerHit: 3, emissiveFlash: 1.0, flashRetrigger: 0.15, hitFlashCap: 0.45, flashAttenHits: 4, flipFlashPeak: 1.5,
        maxBadge: { scaleFrom: 2, time: 0.2 }, stepPunchTime: 0.25, stepGlyphPop: 1.5 },
  intakePerSec: 40,                      // weighted hits/s accepted per gate (excess discarded)
  plus: { capMult: 4, capMin: 12, maxCoins: 5, coinPerHit: 1 },    // cap = max(12, 4·base); +1 c per hit past MAX, ≤ 5 c (QA LVL-23: was 10)
  minus: { flipFlash: 0.25, recolor: 0.4 },                        // s: white flash, red→grey→blue lerp
  // Step costs are sized from the armed window's achievable intake (levelgen.gateDefaults; QA LVL-1/LVL-2):
  // I = min(intakePerSec, E·hits.fireRef·hits.accuracy)·t_w, Icap = intakePerSec·(t_w + intakeWindowS) (the bucket a gate starts with included), t_w = hits.windowM / v.
  // x lanes (gates.js scales each step with the current M, so x2 → x5 costs K·(1 + 1.5 + 2)):
  //   K_M = clamp(stepFraction.intake·I, capBlock·Icap / S(cap−M), capReach·Icap / S(cap−M−1)), ≥ stepMin·M,
  //   S(n) = Σ_{j<n} (M+j)/M — x(M+1) reachable by an on-curve squad, x(cap−1) needs ≈ capReach of a full window at
  //   the 40/s cap, x(cap) is never reachable in one window (> capBlock·Icap).
  mult: { base: 2, base3FromLevel: 6, stepMin: 12, stepFraction: { intake: 0.9, capReach: 1.02, capBlock: 1.1 }, cap: 5, punch: 1.35,
          // (new) QA LVL-27 (GDD §4.2 / §4.4): the first step never costs more than openReach of what the whole squad lands in the
          // armed window (0.9·min(40, E·f)·t_w) — a generated x step is always reachable (it was 167 vs 78 hits on L6)
          openReach: 0.9 },
  // ÷ lanes: K_÷ = max(stepMin, stepFraction.perD[D]·I, flipBlock·Icap / (rungs to x1 + flipStepMult)): an on-curve
  // squad pumps ÷D up to x1 (no loss); the x1 → x2 flip needs more than one full window at the 40/s cap.
  div: { stepMin: 8, stepFraction: { perD: { 2: 0.45, 3: 0.3 }, flipBlock: 1.1 }, ladder: [3, 2, 1], flipTo: 2, flipStepMult: 2 },
  // H(z) = min(shootersCap, E·f·fraction)·(windowM / v) is the GDD §4.2 "expected hits" the cautious (0.3·H) and greedy
  // (levelgen design, 0.75·H) lines land; fireRef / accuracy feed the full-intake model I above (an aligned squad lands ~100 %).
  hits: { fraction: 0.5, shootersCap: 40, windowM: 34.5, fireRef: 2.0, accuracy: 1.0 },
  coins: { pass: 3, max: 5 },                                      // = ECONOMY.gatePass / gateMax
  colors: {
    plus:  { tint: 0x2E9BFF, frame: 0x1A6FD6 },
    mult:  { tint: 0x3BE57A, frame: 0x1FA85A },
    minus: { tint: 0xFF3B4E, frame: 0xB81E2E },
    div:   { tint: 0xE0346E, frame: 0xA1204B },
    zero:  { tint: 0xB8B8B8, frame: 0x8A8A8A },
    item:  { tint: 0xC77DFF, frame: 0x8E3FD6 },
    max: 0xFFD166,
  },
  generation: {
    layoutWeights: { early: { pair: 75, single: 25, triple: 0 }, mid: { pair: 70, single: 15, triple: 15 }, tripleFromLevel: 7 },  // L4–6: triple weight folded into pair
    patterns: [
      { id: 'plusPlus',  w: [30, 20, 15], a: [0.25, 0.6], bOfA: [0.5, 0.8] },              // +A | +B: A = round(E·U(a)), B = round(A·U(bOfA)); smaller value on the lane with fewer zombies ahead
      { id: 'plusMult',  w: [30, 25, 25], aOfE: [0.7, 1.3] },                              // +A | xM: A = round(E·(M−1)·U(aOfE))
      { id: 'minusDiv',  w: [15, 20, 20], aOfE: [0.7, 1.3], aMaxH: 1.3, divThreeFrom: 8 },  // −A | ÷D: A = round(E·(1 − 1/D)·U(aOfE)), A ≤ 1.3·H; D = 3 from L8
      { id: 'multMinus', w: [15, 15, 15], a: [0.3, 0.5], flipMaxH: 0.8 },                  // xM | −A: A = round(E·U(a)); flippable iff A ≤ 0.8·H
      { id: 'plusMinus', w: [10, 10, 10], bMaxH: 0.8, bOfE: 0.3, aPlus: 4 },               // +A | −B: B = round(min(0.8·H, 0.3·E)), A = floor(B/2) + 4
      { id: 'itemPlus',  w: [0, 10, 15], aOfE: 0.35, aScale: [0.5, 1.3] },                 // item | +A: A = round(0.35·E·U(aScale)) (aScale: the generator's tuned draw, round 5 from levelgen)
    ],
    single: { plusOnlyThrough: 2, aOfE: 0.2, w: { plus: 50, mult: 30, minus: 20 }, minusMaxH: 0.9 },
    triple: { bOfE: 0.4 },                                   // [+A, xM, −B], B = round(0.4·E), exactly one red lane
    mult3: { fromLevel: 6, chance: 0.25 },                   // x3 base 25 % from L6
    // QA LVL-5 (GDD §10 "New" column): the level that introduces a gate feature shows it on one gate (exempt from the
    // gain re-roll / variant sweep): L6 an x3 lane, L7 a triple event, L8 a ÷3 lane; the validator fails an intro level without it
    newFeature: { mult3: 6, triple: 7, div3: 8 },
    rules: { noDivBeforeM: 150, noDivLevels: 3, twoRedsFrom: 4, lesserEvilFrom: 3, guardAheadM: 12, maxedHitsFrac: 0.6, breakevenBand: 0.3 },
    bands: [[1, 3], [4, 9], [10, 99]],                       // level bands indexing pattern.w
    rounding: [[30, 1], [100, 5], [Infinity, 10]],           // extra: round to 1 below 30, 5 below 100, 10 above (= util.roundDesign)
    minValue: 3, maxValue: 999,
    noRedBelowE: 8,                                          // no red gate while E(z) < 8
    evFraction: 0.9,                                         // Σ gate EV ≥ 0.9·E_boss
    hitsAssumed: 0.6,                                        // EV assumes 0.6·H hits on the best lane
    cautiousHits: 0.3,                                       // extra: weighted hits (fraction of H) the CAUTIOUS line lands on its lane (levelgen)
    // extra: guard squads in front of the richer lane (levelgen): size = min(round(P·popFraction), max, floor(costShare·Δ/leak)),
    // none below `min`; plusPlus always guards its richer lane, plusMult guards xM with plusMultChance from band plusMultFromBand
    guards: { popFraction: 1 / 3, min: 2, max: 6, costShare: 0.5, plusMultChance: 0.4, plusMultFromBand: 1 },
    // (new) QA LVL-35 / round-1 LVL-1 (GDD §4.4): the full-intake greedy line (every lane shot at min(40, C·f)·t_w, best
    // lane) must reach the boss with at most maxRatio·E_boss soldiers (L2–L30) for a fresh profile (shop rank 0) and a
    // rank-3 profile (squad / fire rate / damage rank 3); levelgen.validateLevel fails it above
    greedyProfiles: [{ id: 'base', rank: 0, maxRatio: 1.6 }, { id: 'rank3', rank: 3, maxRatio: 2.2 }],
    // (new) QA LVL-30 (GDD §4.4 / §1): the opening gate's pattern bag (weights) — +A | xM 50 %, +A | +B 30 %, item | +A 20 %
    // (the item lane carries one of the level's non-guaranteed specials) — sized from LEVELS.curve.s0Assumed(L) instead
    // of E_start, and never identical to the previous level's opener (levelgen re-draws up to `redraws` times)
    opener: { w: { plusMult: 50, plusPlus: 30, itemPlus: 20 }, redraws: 12 },
    // (new) round-3 QA LVL-22 (GDD §1 / §4.4): steering must matter — a squad that never steers (the lane nearest the road
    // centre, full intake, fresh profile) reaches the boss with at most noSteerMax·E_boss (the generator prefers such attempts;
    // the validator warns above it)
    noSteerMax: 0.85,
    // (round 5, from levelgen's former DATA-MISSING literals) the DESIGN line lands designHits·H on the lane it picks by face value
    // (QA LVL-1: later gates are sized and wave HP solved on it; GDD §4.4's 0.6·H left the full-intake line above 1.6·E_boss on L20+)
    designHits: 0.75,
    // the generator steers its shadow lines while it sizes the design line: the full-intake line toward ≤ maxTarget·E_boss and the
    // weak (0.3·H) line toward ≥ cautiousTarget·E_boss; weights of each excess in the per-gate selection error (ln units)
    lineGuards: { maxTarget: 1.3, maxWeight: 5, cautiousTarget: 0.3, cautiousWeight: 0.3 },
    faceItem: { mult: 1.15, add: 2 },     // the design / weak lines value a special lane at E·mult + add (≈ 15 % of the squad; the smoke bot agrees)
    secondSlotMaxErr: 0.15,               // QA LVL-30: the second gate keeps its best bag roll unless its selection error (ln units) exceeds this
    noSteerPenalty: 2,                    // round-3 QA LVL-22: attempt-score cost (ln units) of a no-steer line above noSteerMax
  },
});

// ==== ZOMBIES ================================================================================
// GDD §6.1 roster, §6.2 pools, §6.3 leak model; ARCHITECTURE §6.7 / §8.3.
// HP = baseHp × hz (hz solved per wave by levelgen.solveWaveHp); `speed` is OWN speed added to the
// road speed; `coins` mirrors ECONOMY.kill; `slotBase` = first pool slot of the type for stable ids
// (id = (generation << 12) | slot, ARCH D6). `limb` = uniforms for models.makeCharacterMaterial(type):
// uFreq (Hz), uLegAmp / uArmAmp (rad), uArmRest (rad; 0 = arms hanging, ~1.2 = raised to the chest),
// uBobAmp (m), uRecoil (m, soldiers only, so 0 here). Values derived from the §6.1 gaits: a walker
// shuffles, a runner sprints with pumping arms, a crawler drives with its arms, a brute lumbers
// heavily, a spitter waddles with its arms clutched to its chest.
export const ZOMBIES = deepFreeze({
  walker:  { baseHp: 3,  speed: 1.0, bite: 1, coins: 1,  height: 1.6, radius: 0.45, hpBar: 'afterHit', unlock: 1, pool: 120, slotBase: 0,
             drift: { amp: 0.4, freq: 1.1 },                                   // x += 0.4·sin(1.1t + φ)
             limb: { uFreq: 1.1, uLegAmp: 0.45, uArmAmp: 0.25, uArmRest: 1.1, uBobAmp: 0.04, uRecoil: 0 }, shadow: true },
  runner:  { baseHp: 2,  speed: 4.5, bite: 1, coins: 2,  height: 1.5, radius: 0.40, hpBar: 'afterHit', unlock: 2, pool: 60,  slotBase: 120,
             zigzag: { amp: 1.5, period: 1.2, retarget: 0.5,                   // zig-zag ±1.5 m / 1.2 s; re-targets squad x every 0.5 s
                       lateralRate: 4.0 },                                    // extra: 1/s lerpExp of the zig-zag centre toward the re-targeted x
             screechLean: 0.22, leanRate: 6.0,                                 // extra: rad forward lean after the screech, 1/s lerpExp into it
             screechZ: -20,                                                   // screech + lean telegraph at 20 m
             limb: { uFreq: 3.2, uLegAmp: 0.85, uArmAmp: 0.7, uArmRest: 0.45, uBobAmp: 0.06, uRecoil: 0 }, shadow: true },
  crawler: { baseHp: 2,  speed: 2.0, bite: 1, coins: 1,  height: 0.7, radius: 0.35, hpBar: 'never',    unlock: 3, pool: 40,  slotBase: 180,
             lunge: { dist: 3, speed: 6,                                       // lunges the last 3 m at 6 m/s
                      lateral: 2.0, animSpeed: 1.6 },                         // extra: m/s homing toward squad x while lunging; limb-swing multiplier
             dustEvery: 0.12,                                                  // extra: s between dust-trail puffs (fx.emit('dust'))
             hittableZ: -8,                                                   // below bullet height (0.95) until z > -8 or lunging
             pack: [6, 10],                                                   // packs of 6-10
             limb: { uFreq: 2.6, uLegAmp: 0.6, uArmAmp: 0.6, uArmRest: 1.45, uBobAmp: 0.05, uRecoil: 0 }, shadow: false },
  brute:   { baseHp: 30, speed: 0.8, bite: 3, coins: 15, height: 2.8, radius: 0.90, hpBar: 'always',   unlock: 4, pool: 16,  slotBase: 220,
             charge: { dist: 8, speed: 3.5,                                    // charge 3.5 m/s inside 8 m
                       lateral: 1.5, animSpeed: 1.5 },                        // extra: m/s homing toward squad x while charging; limb-swing multiplier
             swing: { cooldown: 1.0, telegraph: 0.8, ringR: 3, ringZ: -12 },   // red ring r 3 m from 12 m, 0.8 s fill, swing every 1.0 s kills 3
             staggerEvery: 0.25, stagger: { freeze: 0.3, pitch: 0.18 },        // stagger (0.3 s freeze + flash) every 25 % HP; extra: rad backward recoil at the peak
             contactHoming: 3.5,       // extra: m/s x-homing toward squad x while in contact with the formation (stands in front of the centre shooters)
             maxContactZ: -0.3,        // extra (QA ENE-12): a brute holds / swings only at the formation front (z ≤ this, front row z = 0)
             contactHomingZ: 4.0,      // extra (QA ENE-12): m/s a flank-contact brute walks toward the front (squad frame) before it may swing
             maxSwings: 6,             // extra (QA ENE-12): backstop — after this many swings a brute staggers back backoffM and re-telegraphs instead of swinging
             backoffM: 2.0,            // extra (QA ENE-12; key added round-2 cross-group): m the swing backstop staggers a brute back
             limb: { uFreq: 0.8, uLegAmp: 0.35, uArmAmp: 0.35, uArmRest: 0.6, uBobAmp: 0.08, uRecoil: 0 }, shadow: true },
  spitter: { baseHp: 6,  speed: 0.6, bite: 0, coins: 6,  height: 1.7, radius: 0.50, hpBar: 'always',   unlock: 5, pool: 24,  slotBase: 236,
             hold: { z: -18, max: 6 },                                         // holds at 18 m for <= 6 s then advances
             spit: { every: 2.5, speed: 12, splash: 1.2, kills: 1, kills2FromLevel: 10, preview: 0.6,     // glob 12 m/s arc; splash r 1.2 (also the formation-centre miss distance); arc preview 0.6 s
                     kills2: 2,                // extra: kills per splash from kills2FromLevel (GDD §6.1 "2 from L10")
                     arcHeight: 3.0,           // extra: apex of the lobbed glob above the chord (m)
                     mouthY: 0.8,              // extra: launch height as a fraction of spitter.height
                     firstDelay: [0.6, 1.4],   // extra: [min, max] s before the first spit once in range (ctx.rng)
                     leadSmoothing: 10 },      // extra: 1/s lerpExp of the squad lateral-velocity estimate used to lead the spit
             limb: { uFreq: 0.9, uLegAmp: 0.35, uArmAmp: 0.15, uArmRest: 1.3, uBobAmp: 0.03, uRecoil: 0 }, shadow: true },
  common: {
    types: ['walker', 'runner', 'crawler', 'brute', 'spitter'],   // extra: canonical type order (= WAVE_WEIGHTS.w order)
    death: { topple: 0.55, sink: 0.3, free: 1.4 },                // s
    hitFlash: 0.06,                                               // s white emissive flash per hit
    hitFlashRetrigger: 0.2,                                       // extra: s min between two flashes of one zombie / boss (sustained fire blinks, never a white silhouette)
    maxLive: 260,                                                 // sum of the pools
    firstWavePattern: 'line',
    binSize: 2, binRange: [-80, 20],                              // z-bins (m)
    globPool: 32, globRadius: 0.25,                               // extra: spit glob instances (IcosahedronGeometry(0.25, 0))
    hpBarPool: 260,                                               // extra: HP-bar InstancedMesh capacity
    hpBar: { w: 0.9, h: 0.1, above: 0.25, lowPulse: 0.25 },       // extra: HP bar size (m), height above the head; the fill pulses below lowPulse HP
    coinYFraction: 0.6,                                           // extra: coin:pickup y = height · 0.6 (the coin pops from the torso)
    hitYFraction: 0.5,                                            // extra: AOE / query impact height = height · 0.5
    yawRate: 8.0,                                                 // extra: 1/s lerpExp of the facing toward the velocity direction
    globSpin: 6.0, globTumbleRatio: 0.7,                          // extra: rad/s cosmetic tumble of a glob, second axis as a fraction of it
    globEmissive: 0.8, globRoughness: 0.35,                       // extra: acid glob material
    tintJitter: 0.08,                                             // extra: per-instance rngFx colour jitter (fraction)
    bloodParticles: 8,                                            // GDD J9 (= JUICE.bursts.blood)
  },
});

// GDD §6.3 leak model: win = usable·reach/(v + s̄); DPS = E·fireRate·damage·accuracy; TTK = win/(1 − leak);
// hz = DPS·TTK / Σ baseHp; HP_i = max(minHp, round(baseHp_i·hz)).
// Per-type windows and coverage (QA LVL-4, levelgen.solveWaveHp / expectedLeak): each type's kill window is the reach
// model usable·reach/(v + s_t), limited to usable·exposure/v when a gate panel shields the wave until it passes the squad
// (exposure = road metres from that pass to contact) and, for crawlers, to their hittable stretch (ZOMBIES.crawler.hittableZ
// then the lunge). `coverage`: the fraction of a wave's non-homing zombies whose x lies inside the shooter columns
// (formation half-width of E — slotArea m² per soldier in an ellipse of `aspect`, capped at halfWidthCap — plus the zombie
// radius and `slack` for the bullet radius / ±2° spread) around the lane the design line holds scales the squad DPS
// (never below `min`); `homing` types re-target the squad and always count.
export const LEAK_MODEL = deepFreeze({
  usable: 0.8, reach: 40, fireRate: 2.0, damage: 1.0, accuracy: 0.8, minHp: 1,
  coverage: { slotArea: 0.1, aspect: 1.6, halfWidthCap: 1.8, slack: 0.5, min: 0.75, homing: ['runner', 'crawler', 'spitter'] },
  // per-type window calibration (QA LVL-4, re-fitted in QA LVL-15 against the wave lab, docs/build/qa2/fix-level/lab: the HP
  // multiple of the old solve at which a type leaks its band was walker ≈ 4.5, runner ≈ 1.7, crawler ≈ 2.1 (of the old
  // 0.6-scaled solve), brute ≈ 1; spitters lose soldiers to spit, not bites) — the effective factor is calib × windowScale
  windowScale: { walker: 1.5, runner: 0.6, crawler: 0.33, brute: 0.35, spitter: 1.0 },
  // (new) QA LVL-15 (GDD §6.3): play-measured calibration — the squad's real kill capacity is `calib` × the model's
  // DPS·window (levelgen.waveDps), so solved HP and predicted leak both carry it
  calib: 2.0,
  // (new) QA LVL-15: the solve uses TTK = win / (1 − leak)^leakExp (and the predicted leak inverts it): play leak rises far
  // more slowly with HP than the linear form, so the L4–9 / L10–19 / L20+ bands need disproportionately more HP than L1–3
  leakExp: 3,
  // (new) QA LVL-15: calib × this piecewise-linear factor of the wave's leak target [[leak, mult], …] — measured play leak
  // (docs/build/qa2/fix-level/runs) sat at the band on L1–3 but far under it from L4 on, where specials / troops add fire
  calibByLeak: [[0.125, 1.0], [0.185, 1.25], [0.25, 1.8], [0.30, 2.2]],
  // (new) QA LVL-15: a run-up horde (4 bursts 2 s apart) is solved as the share of it inside one walker kill window, never
  // below this share (each burst meets the squad's whole fire; the full 0.35 share made run-ups leak 45–70 %)
  runupShareMin: 0.6,
  // (new) QA LVL-14 / LVL-15: boss minions (bursts, phase spawns) take this fraction of the calibrated solve at E_boss — at
  // full calibration they soaked the squad's fire for the whole fight (a 0.5·E_boss squad was chewed by the safety valve)
  minionScale: 0.15,
  // (new) QA LVL-15: live solves (level.js) multiply wave / guard / run-up / minion HP by p^profileExp, p = (profile.fireRate
  // / FIRE.rateBase)·profile.damage — shop upgrades still shorten waves, never down to zero bites (generator / validator: p = 1)
  profileExp: 0.5,
  // (new) round-3 QA LVL-15 (GDD §6.3): the campaign squad's kill capacity per level relative to the band calibration
  // [[L, mult], …] (piecewise-linear, levelgen.levelCalib) — fitted so an on-curve squad with the ranks a player who spends
  // every coin owns leaks inside its band (docs/build/r3-balance.md); generated campaign waves and guards only
  // round 5: L13–L30 fitted the same way (docs/build/r5-level-balance.md; on-curve lab, ranks of a greedy-shop smart campaign)
  calibByLevel: [[2, 0.33], [3, 0.5], [4, 0.7], [5, 1.1], [6, 0.95], [7, 1.1], [8, 1.45], [9, 1.8], [10, 0.8], [11, 0.9], [12, 1.0],
    [13, 1.2], [14, 1.16], [15, 1.25], [16, 1.25], [17, 1.28], [18, 1.44], [19, 1.57], [20, 1.29], [21, 1.28], [22, 1.32], [23, 1.43],
    [24, 1.31], [25, 1.32], [26, 1.27], [27, 1.42], [28, 1.47], [29, 1.43], [30, 1.53]],
  // (new) round-3 QA LVL-15: the waves and guards in the first earlyRamp of a campaign level meet the bare squad (no special or
  // troop yet): their calibration ramps from the base calib to the full band × level factor over that stretch
  earlyRamp: 0.4,
});

// GDD §6.2 type weights (percent of a wave), interpolated between rows; order = ZOMBIES.common.types.
export const WAVE_WEIGHTS = deepFreeze([
  { L: 1,  w: [100, 0, 0, 0, 0] },
  { L: 2,  w: [80, 20, 0, 0, 0] },
  { L: 3,  w: [65, 20, 15, 0, 0] },
  { L: 5,  w: [50, 22, 13, 8, 7] },
  { L: 8,  w: [42, 25, 12, 11, 10] },
  { L: 12, w: [36, 26, 12, 14, 12] },
  { L: 20, w: [30, 28, 12, 16, 14] },
]);

// GDD §6.2 patterns. line: even across x in ±3.5, same z; column: single file at a lane x, 2 m apart;
// horde: uniform in a 7 × 8 m box; flank: clusters at x = ±3.2; pincer: runners from both edges,
// walkers centre (L4+); wall: brute line + crawler carpet 6 m behind (L8+).
// Extra keys: `weight` = generator pick weight per pattern (levelgen; key order is the pick order — keep it);
// line.guardHalfWidth = half-width of a guard line centred on its lane; pincer.centreHalfWidth = the centre
// group's x half-range; flank.jitter = x jitter inside a flank cluster (zombies.spawnWave).
export const WAVE_PATTERNS = deepFreeze({
  line: { xRange: 3.5, spread: 0, weight: 20, guardHalfWidth: 1.5 },
  column: { gap: 2, weight: 15 },
  horde: { box: [7, 8], weight: 30 },
  flank: { x: 3.2, spread: 4, weight: 15, jitter: 0.35 },
  pincer: { minLevel: 4, spread: 6, weight: 10, centreHalfWidth: 1.5 },
  wall: { minLevel: 8, carpetGap: 6, weight: 10 },
});

// GDD §6.2 composition rules.
export const WAVE_RULES = deepFreeze({
  brutePairFrom: 9,             // brute pairs side by side from L9
  runnerPackFrom: 11, runnerPack: 8,
  crawlerSwarmFrom: 16, crawlerSwarm: 12,
  newestTypeInLastWave: true,   // the last wave before the run-up contains the level's newest type
  burstEvery: 3,                // extra: runner packs (L11+) land on wave index % 3 == 1, crawler swarms (L16+) on % 3 == 2 (levelgen)
  // QA LVL-4b: a mixed wave spawns its faster types later (event `lag` = { type: road metres after `at` }) so every type
  // reaches the squad at the planned contact; lags shorter than minLagM are dropped
  stagger: { minLagM: 3 },
  // QA LVL-8: the level that unlocks crawlers shows one full pack (ZOMBIES.crawler.pack[0]) in its first mixed wave
  unlockPack: true,
  // (new) round-3 QA LVL-15 (GDD §6.2): a wave never outnumbers its squad — with the expected squad E at contact, generated
  // waves carry at most max(min, perE·E) zombies (types in proportion) and brutes / spitters only from E ≥ heavyMinE
  // (each brute = bruteAsWalkers walkers, each spitter one walker) and at most max(runnerMin, runnerPerE·E) homing runners:
  // no early wave costs an on-curve squad more than ~35 %; below heavyMinE the one new brute / spitter a level's intro mix
  // keeps fills keepWeight places of the cap (its swings / spit cost a small squad several soldiers)
  small: { perE: 0.3, min: 4, heavyMinE: 25, bruteAsWalkers: 2, runnerPerE: 0.25, runnerMin: 2, keepWeight: 4 },
  // (round 5, from levelgen) a solo introduction's HP ≤ this fraction of what the squad's whole fire clears in its window (QA LVL-4)
  introHpFrac: 0.8,
});

// GDD §6.3 leak bands (expected fraction of a wave that bites), by level range.
export const LEAK_BANDS = deepFreeze([
  { L: [1, 3],    band: [0.10, 0.15] },
  { L: [4, 9],    band: [0.15, 0.22] },
  { L: [10, 19],  band: [0.22, 0.28] },
  { L: [20, 999], band: [0.28, 0.32] },
]);

// ==== BOSSES =================================================================================
// GDD §7 (beats, archetypes), §10 (rotation, HP); ARCHITECTURE §6.8 / §8.3 / D8 / D9.
// bossHp = round50(hpPerE · eBoss · max(milestone ? milestoneMult : 1, archetype.hpMult ?? 1)) — never stacked.
// Phase = { until (HP fraction the phase lasts down to), attack, interval (s), kills | killsPct + min,
//           killsPerLevel, radius, width, band, telegraph, preview, splashes, duration, onEnter:[Action] }
// kills per attack = (killsPct ? max(min, round(killsPct·C)) : kills) + floor(L · (killsPerLevel ?? 0)).
// Action = { spawn:{type:n} } | { attack, ...params } | { shield: fractionOfMaxHp } | { platesOff:true, damageMult }.
// `base` archetypes are resolved recursively by level/boss (twins, hpSplit, shieldHits, hpMult merged).
// Extra keys: baseModel/scale (models.buildBossRig), charge speed/duration, stomp telegraph, rigHeight,
// phaseThresholds, hpChunk, plates, hpRound, intro.roadLerp, death.resultsAfterMs.
export const BOSSES = deepFreeze({
  hpPerE: 20,
  // (new) QA LVL-14 (GDD §7, §0 Boss): the table HP is scaled at spawn by the arriving squad and the shop, never below the
  // table: countScale = clamp((C / E_boss)^exp, 1, maxMult); shopScale = clamp(m^exp, 1, maxMult) with
  // m = (fireRate / FIRE.rateBase)·damage·bossDamage (1.0 at base ranks). TTK falls strictly with m, and with C from E_boss up; below
  // E_boss the faded shop exponent (level.js) leaves it flat or slightly rising with C at high ranks (docs/build/r5-balance-audit.md §4).
  // Round 5 (docs/build/r5-level-balance.md): shopScale exp 0.75 → 0.9 and maxMult 4 → 10 — the ×4 cap bound from ≈ L18 (m reaches
  // 12.5 at rank 10), so L21–L30 bosses died in 5–10 s at E_boss with realistic ranks; at C = E_boss TTK ∝ m^(exp − 1)
  squadScale: { exp: 0.6, maxMult: 2.0 },
  shopScale: { exp: 0.9, maxMult: 10.0 },
  milestoneMult: 1.25,
  milestones: [5, 10, 15, 20, 25, 30],
  hpRound: 50,
  rotation: ['hulk', 'hulk', 'hulk', 'hulk', 'spitterQueen', 'hulk', 'hulk', 'spitterQueen', 'hulk', 'juggernaut',
             'spitterQueen', 'hulk', 'juggernaut', 'spitterQueen', 'colossus', 'juggernaut', 'hulkTwins', 'spitterQueen', 'juggernaut', 'colossusPrime',
             'hulk', 'spitterQueen', 'juggernaut', 'colossus', 'hulkTwins', 'spitterQueen', 'juggernaut', 'colossus', 'hulkTwins', 'colossusPrime'],   // index = L − 1
  approachZ: -45,                                 // walks out of the fog at 45 m
  holdZ: [-12, -10, -8],                          // hold distance per phase (own speed = −roadSpeed)
  twinOffsetX: 3.0,                               // twins stand at x ±3.0 (clamped to the road)
  twinStaggerZ: 1.5,                              // extra: the second twin holds 1.5 m further back (two readable silhouettes)
  coreY: 4.5,                                     // aim point / core height (m)
  radius: 1.6,                                    // hit capsule radius (m)
  hitYRange: [0.45, 0.95],                        // extra (QA ENE-13): cosmetic bullet impact height band as a fraction of coreY (hit tests stay XZ)
  rigHeight: 7,                                   // every rig is ~7 m tall (GDD §7 "7 m rig")
  phaseThresholds: [0.6, 0.25],                   // HP bar ticks / phase 2 and 3 entry (fraction)
  hpChunk: 0.05,                                  // HP bar falls in 5 % chunks (GDD §7)
  plates: 4,                                      // armour plates that fly off at phase 2
  // extra (boss.js movement / attack feel): own walk speed added to roadSpeed while closing from approachZ to the hold,
  // proportional gain easing onto the hold z, 'arrived' tolerance, first attack after boss:fight, pose recovery after
  // an attack, charge/lane defaults when a phase omits speed/duration (GDD §7 Hulk charge "1 s, 6 m/s"), the z a
  // charging boss never crosses, the stomp telegraph ring radius, triple-spit flank offset, ±splash jitter (ctx.rng),
  // acid-rain target box relative to squad.centerZ, minion bursts spawn this far behind the boss.
  // approachSpeed closes −45 → ≈ −17 m during the 2.4 s intro; attacks are allowed within attackRangeM of the squad
  // front; firstAttackDelay counts from boss:fight; charges lunge at their speed in the squad frame up to chargeStopZ;
  // rainBox z is relative to the boss target line (squad front − 1 m).
  approachSpeed: 8.0, holdGain: 2.5, arriveM: 3.0, firstAttackDelay: 0.8, recoverSeconds: 0.6, attackRangeM: 30,
  retreatSpeed: 3.0,                              // extra: max m/s walking back (−z) to the hold after a charge / onto a farther hold
  gaitRefMs: 3.0,                                 // extra: road-relative speed of a full walk-cycle amplitude; stride rate saturates at 1.5×
  phaseEntryCool: 1.0,                            // extra: the phase's basic attack fires ≤ 1 s after a phase change
  targetZ: -1.0,                                  // extra: boss telegraphs / splashes land on this line (squad front z 0 − 1 m: above the letterbox)
  introSparkEvery: 0.1,                           // extra: s between the cosmetic sparks of bullets hitting the boss during the intro
  chargeDefaults: { speed: 6, duration: 1.0 }, chargeStopZ: -5.0, stompRadius: 4.5,
  spit3SpreadM: 1.8, spitJitterM: 0.3, rainBox: { halfX: 3.5, zBack: -1.5, zFwd: 0.5 }, minionSpawnBehindM: 6,
  glob: { pool: 12, scale: 1.1, arcHeight: 3.5, mouthY: 5.0 },                    // extra: boss glob InstancedMesh (geometry = models.geo.glob); mouthY = fallback launch height
  plateFly: { seconds: 1.3, speed: 5.5, up: 4.0, spin: 6.0, gravity: 9.8, sparks: 10 },   // extra: plate detach flight (m/s, rad/s, m/s²)
  car: { arcHeight: 6.0, spin: 4.0, launchY: 5.5, restY: 0.45 },                 // extra: thrown wrecked car (m, rad/s)
  blobShadowScale: 4.0,                                                          // extra: Low-tier blob disc scale under a 7 m rig
  // extra: rig animation — walk Hz per m/s of road-relative speed, leg/arm amplitudes and arm raise (rad), bob (m), jaw
  // open, lean (rad), crouch (m), core pulse Hz / scale, chain sway, pose ease rate (1/s), rage / hit-flash emissive,
  // core point light, idle sway, lerpExp rates (1/s) for x during a charge, x home, gait blend and yaw, head tilt,
  // stomp lift, chew jaw period, Colossus shield bubble pulse.
  anim: {
    walkHzPerMs: 0.45, legAmp: 0.45, armAmp: 0.3, armRaise: 2.2, bobAmp: 0.12, jawOpen: 0.7, lean: 0.35, crouch: 0.6,
    corePulseHz: 1.4, coreScale: 0.12, chainAmp: 0.18, chainHz: 1.3, poseRate: 9, rageEmissive: 0.02, flashEmissive: 0.25,
    flashTint: 0x9ED68E,                          // hit-flash emissive tint = PALETTE.boss.skin ×2 (QA ENE-14: was warm 0xFFD9B0, which paled the green body on a blink); eyes / core carry the rage
    lightIntensity: 20, lightDistance: 22, lightDecay: 2, idleSway: 0.03,   // QA ENE-18: 40 → 20 (lights the road / squad, not the torso)
    lightOffsetZ: -1.0,                           // extra (QA ENE-18): core light offset along the boss's facing (m); −1 = just inside the torso behind the core: the
                                                  // forward-facing torso is back-facing to it (no shadows) so it lights the road / squad / minions, not its own chest (+1.5 painted the Queen's belly orange)
    chargeXRate: 10, homeXRate: 3, gaitRate: 6, yawRate: 4,
    headBack: 0.25, stompLift: 1.0, chewJawSeconds: 0.5, shieldPulseHz: 0.9, shieldOpacity: 0.26, shieldOpacityPulse: 0.08,
    sacPulseHz: 1.1, sacPulseMin: 0.55, sacPulseMax: 1.1,   // extra: GDD §7 Spitter Queen 'pulsing sacs' — body glow × 0.55…1.1 at 1.1 Hz
    sacGain: 0.5,                                 // extra (QA ENE-14): sac glow gain on top of the pulse (eyes stay 1.5): peak ≈ #C7E84B, below the bloom threshold
  },
  valve: { after: 45, z: -3, perSec: 3 },         // safety valve: advance to 3 m after 45 s, chew 3 soldiers/s
  intro: { dollyOut: 1.0, hold: 0.6, back: 0.8, roar: 0.8, nameCard: 1.5, invuln: 2.6, fightAfter: 2.4, roadLerp: 1.0 },   // s
  minionBurst: { every: 4, count: 6 },            // phase-1 walker bursts
  lastHorde: 10,                                  // phase-3 horde size
  death: { slowmo: 0.25, slowmoTime: 1.2, flash: 0.15, collapse: 1.8, coinsVisual: 60, confetti: 200, resultsAfterMs: 3000,
           // extra: collapse shape — fall angle (rad, toward the squad), fall fraction of `collapse`, sink depth (m),
           // extra real seconds the rig keeps sinking after `collapse` before it is hidden
           fall: { angle: 1.35, fraction: 0.65, sinkM: 3.0, sinkExtraS: 0.6 } },
  endlessRotation: ['hulk', 'juggernaut', 'spitterQueen'],
  archetypes: {
    hulk: {
      name: 'HULK', baseModel: 'brute', scale: 3.2,   // "Brute King": 3.2× brute, car-door shield, hinged jaw
      phases: [
        { until: 0.6,  attack: 'slam', interval: 5, kills: 3, killsPerLevel: 0.5, radius: 3, telegraph: 0.8 },
        { until: 0.25, onEnter: [{ attack: 'charge', killsPct: 0.08, min: 3, width: 2.5, telegraph: 1.2, speed: 6, duration: 1.0 }, { spawn: { runner: 6 } }],
          attack: 'slam', interval: 5, kills: 3, killsPerLevel: 0.5, radius: 3, telegraph: 0.8 },
        { until: 0,    onEnter: [{ spawn: { brute: 2 } }], attack: 'slam', interval: 3, kills: 3, killsPerLevel: 0.5, radius: 3, telegraph: 0.8 },
      ],
    },
    spitterQueen: {
      name: 'SPITTER QUEEN', baseModel: 'spitter', scale: 2.6,   // bloated, 4 arms, pulsing sacs
      phases: [
        { until: 0.6,  attack: 'spit3', interval: 2.5, kills: 1, kills2FromLevel: 10, preview: 1.0 },
        { until: 0.25, onEnter: [{ attack: 'rain', splashes: 8, duration: 3 }], attack: 'spit3', interval: 2.5, kills: 1, kills2FromLevel: 10, preview: 1.0 },
        { until: 0,    onEnter: [{ spawn: { crawler: 10 } }], attack: 'spit3', interval: 1.6, kills: 1, kills2FromLevel: 10, preview: 1.0 },
      ],
    },
    juggernaut: {
      name: 'JUGGERNAUT', baseModel: 'walker', scale: 4.5,   // armour plates
      phases: [
        { until: 0.6,  attack: 'stomp', interval: 3.5, killsPct: 0.04, min: 3, telegraph: 0.6 },
        { until: 0.25, onEnter: [{ attack: 'car', killsPct: 0.12, min: 4, band: 3, telegraph: 1.2 }],
          attack: 'lane', interval: 4, width: 2.5, telegraph: 1.2, killsPct: 0.08, min: 3 },
        { until: 0,    onEnter: [{ platesOff: true, damageMult: 1.5 }], attack: 'stomp', interval: 2.2, killsPct: 0.04, min: 3, telegraph: 0.6 },
      ],
    },
    colossus: {
      name: 'COLOSSUS', baseModel: 'colossus', scale: 1.0,   // 7 m, exposed core, chain links
      shieldHits: 40, shieldPct: 0.15, shieldRegenPerSec: 0.02,
      cycle: ['slam', 'spit3', 'charge'],                     // 'cycle' = the next entry of `cycle`, one per interval
      slam:   { radius: 3, kills: 3, killsPerLevel: 0.5, telegraph: 0.8 },
      spit3:  { kills: 1, kills2FromLevel: 10, preview: 1.0 },
      charge: { killsPct: 0.08, min: 3, width: 2.5, telegraph: 1.2, speed: 6, duration: 1.0 },
      phases: [
        { until: 0.6,  attack: 'cycle', interval: 6 },
        { until: 0.25, onEnter: [{ shield: 0.15 }], attack: 'cycle', interval: 6 },
        { until: 0,    attack: 'cycle', interval: 4 },
      ],
    },
    hulkTwins:     { base: 'hulk', name: 'HULK TWINS', twins: true, hpSplit: 0.55 },          // each twin 0.55× (pair = 1.1×); one bar shows the sum
    colossusPrime: { base: 'colossus', name: 'COLOSSUS PRIME', hpMult: 1.25, shieldHits: 60 },    // hpMult never stacks with the milestone ×1.25
  },
});

// ==== WEAPONS ================================================================================
// GDD §8.1; ARCHITECTURE §6.11 / §8.4. Keys are the weapon ids minus the 'weapon.' prefix (every entry
// also carries its full `id`). A weapon replaces the squad's fire for `duration` s (rocket/rail keep
// rifle fire at `rifleKeep`); gate hits are weighted (×w) and subject to GATE_RULES.intakePerSec.
// `tracer` = HDR linear RGB (PALETTE.tracer); `color` (extra) = sRGB hex for the J13 screen-edge glow,
// the HUD pill ring and the rifle emissive recolour.
export const WEAPONS = deepFreeze({
  shotgun: { id: 'weapon.shotgun', unlock: 1,  duration: 10, rateMult: 0.6, pellets: 5, fanDeg: 10, range: 14, dmgMult: 0.5, gateHits: 1,
             tracer: [3.0, 2.0, 1.0], color: 0xFF9A3C, sting: 'sting_shotgun',                        // 1.2/s × 5 pellets, ±10° fan, 14 m
             flashScale: 1.7 },                                                                       // extra: GDD §8.1 "wide flash" (× FIRE.muzzleFlash.size)
  minigun: { id: 'weapon.minigun', unlock: 3,  duration: 10, rateMult: 3,   spreadDeg: 5, dmgMult: 0.6, gateHits: 1, spinUp: 0.4,
             tracer: [3.4, 2.6, 0.35], shake: 0.03, color: 0xFFE84A, sting: 'sting_minigun',          // rate ×3 → 3× gate hits/s; "thin yellow tracers" (blue ≈ 0 so ACES keeps it yellow)
             tracerScale: 0.6,                                                                        // extra: tracer cross-section × 0.6 (thinner than the rifle's, GDD §8.1)
             flashScale: 0.8, spinFrom: 1 },                                                        // extra: thin rapid flashes; rate multiplier at t = 0 of the spin-up (ramps to rateMult)
  rocket:  { id: 'weapon.rocket',  unlock: 9,  duration: 8,  every: 0.6, speed: 22, splash: 2.5, dpsSeconds: 1.0, rifleKeep: 0.5, gateHits: 8,
             trauma: 0.3, fovKick: 4, maxRange: 30, pool: 8, color: 0xFF6A2A, sting: 'sting_rocket',    // 1 rocket / 0.6 s from the blob centre
             // extra (weapons.js visuals / tests): launch flare scale, launch height above the helmets (m), swept-test radius (m),
             // ARCH §6.11/§7 splash reach onto an armed panel ("within 1.8 m (x) and 1.0 m (z)"), smoke-trail cadence (s) and
             // puff look, exhaust origin behind the rocket centre (m), exhaust cone (m, HDR gain), roll rate (rad/s)
             flashScale: 2.4, launchY: 1.7, radius: 0.2, gateReach: { x: 1.8, z: 1.0 },
             // smoke trail puffs use the light-tan dust tint (FX_COLOR.dust) so they read on the dark asphalt; meshScale × the
             // models rocket (tailM and the swept radius stay in unscaled metres; the exhaust origin scales with the mesh);
             // flame.hdr = linear HDR colour of the additive exhaust cone (GDD §8.1 "smoke trail, orange burst")
             // smoke.colorIdx = FX_COLOR.dust (index 8 of fxmaterials.js FX_COLORS = PALETTE.fx.dust; WPN-10: data key instead of a weapons.js mirror)
             smokeEvery: 0.03, smoke: { size: 0.8, life: 1.2, spread: 0.35, rise: 0.6, colorIdx: 8 },
             tailM: 0.33, flame: { len: 1.2, radius: 0.16, hdr: [3.0, 1.4, 0.35] }, meshScale: 1.6, spin: 9 },
  railgun: { id: 'weapon.railgun', unlock: 13, duration: 6,  every: 1.2, halfWidth: 0.4, dpsSeconds: 3.0, rifleKeep: 0.5, gateHits: 10, flash: 0.08,
             tracer: [2.0, 3.6, 4.0], color: 0x9FDCFF, sting: 'sting_rail',                           // bolt through the whole road, 0.8 m wide
             // extra (weapons.js visuals): bolt flare scale, bolt visual life (s), lightning polyline segments / lateral jitter (m) /
             // re-roll interval (s), core radius and arc thickness (m), arc HDR gain (× tracer), J21 80 ms screen-flash opacity,
             // muzzle sparks per bolt
             flashScale: 2.4, boltSeconds: 0.22, segments: 24, jitterM: 0.3, rejitterS: 0.035, coreRadius: 0.09, arcThickness: 0.05,
             arcGain: 1.0, flashAlpha: 0.55, sparks: 8 },
  laser:   { id: 'weapon.laser',   unlock: 14, duration: 8,  perBeam: 5, minBeams: 2, maxBeams: 8, halfWidth: 0.25, dpsMult: 2.0, gateHitsPerSec: 10,
             tracer: [0.5, 2.6, 3.2], color: 0x4AF0FF, sting: 'sting_laser',                          // one cyan beam per 5 visible shooters, 0.5 m line (GDD §8.1; §15's magenta amended to cyan)
             // extra (weapons.js visuals / tests): beam core / glow radius (m), glow gain (× tracer), ± radius flicker, vertical
             // slabs approximating a boss-aimed beam for damageInLine, impact spark cadence (s) and count, render.lights.laser
             // while a laser is active (intensity, distance m, y m, z m ahead of the front row)
             // glowGain: halo gain while bloom is on (bloom already haloes the HDR core; 8 overlapping halos washed gates and
             // the count label) / on Low where the halo stands in for bloom (GDD §16)
             coreRadius: 0.045, glowRadius: 0.12, glowGain: { bloom: 0.1, low: 0.25 }, flicker: 0.22, aimSlabs: 3, sparkEvery: 0.07, sparks: 2,
             light: { intensity: 2.5, distance: 10, y: 1.4, z: -1.5 } },
});

// ==== GEAR ===================================================================================
// GDD §8.2; ARCHITECTURE §6.11 / §8.4. duration Infinity = until consumed / rest of level (no HUD pill).
export const GEAR = deepFreeze({
  armor:   { id: 'gear.armor',   unlock: 2,  platesCap: 50, costBrute: 3, costSpit: 1, absorbs: ['bite', 'spit'], duration: Infinity, color: 0x2E9BFF },   // plates = min(C, 50)
  magnet:  { id: 'gear.magnet',  unlock: 4,  radius: 5.0, baseRadius: 1.2, duration: Infinity, color: 0xC77DFF },                                          // second magnet pays PICKUPS.duplicateCoins
  chip:    { id: 'gear.chip',    unlock: 7,  duration: 20, rateBonus: 0.4, tracerTint: [1.5, 3.6, 4.0], color: 0x4AF0FF },                                 // fire rate +40 %, tracers tint cyan
  booster: { id: 'gear.booster', unlock: 11, duration: 20, dmgBonus: 0.5, numberColor: 0xFFB02E, color: 0xFFB02E,                                         // damage +50 % (not gate hits), orange numbers
             tracerScale: 1.7 },                                                                                                                         // extra: GDD §8.2 "thicker tracers"
});

// ==== TROOPS =================================================================================
// GDD §8.3; ARCHITECTURE §6.6 / §7 / §8.4. Rest of level, one of each (duplicates pay PICKUPS.duplicateCoins).
// Every key is a troop entry EXCEPT `anim` (extra: troops.js feel / animation literals): iterate troop ids through
// PICKUPS.items or explicit lists, never Object.keys(TROOPS).
export const TROOPS = deepFreeze({
  sniper: { id: 'troop.sniper', unlock: 5,  every: 1.5, dmg: 40, bossMult: 0.5, slot: 'rear', crateH: 0.25,                        // 40·hz·d to the highest-HP zombie; boss ×0.5; stands on a 0.25 m crate (extra; 0.5 → 0.25 round-2 CHR-9)
            hitY: 1.0, shieldWeight: 1, scale: 1.05,                                                                                // extra: ARCH §6.6/§7 zombies.damage(…, 1.0, …); GDD §7 shield gauge "sniper 1"; scale = troop mesh scale (extra, readability; 1.4 → 1.05 round-2 CHR-9: sniper + crate ≤ 1.3 soldier columns)
            bossCapFrac: 0.05 },                                                                                                    // (new) round-3 verify (r3-balance-audit §5): a boss shot is at most 5 % of the boss's max HP (before profile.bossDamage) — the wave hz carries endless's design multiple and pressure, the mini-boss HP does not, and one uncapped shot took 95–110 % of an endless mini-boss (and up to ≈ 80 % of the L5 table HP)
  medic:  { id: 'troop.medic',  unlock: 6,  every: 4, pct: 0.02, min: 1, capPerLevel: 60, slot: 'centre', scale: 1.4 },            // +max(1, ceil(0.02·C)) while C < E(z), ≤ 60 per level
  flamer: { id: 'troop.flamer', unlock: 8,  coneDeg: 25, range: 13, dps: 6, burnBonus: 0.2, burnSeconds: 2, slot: 'front', emitPerSec: 30, scale: 1.4 },    // 6·hz·d DPS in a 25° cone, never below 25 % of a zombie's base HP (round-2 CHR-12: 15 → 6 + the HP floor in troops.js — the trooper took ≈ 70 % of kills; the cone burns and softens, bullets kill; the trooper took ≈ 70 % of kills; GDD §8.3 support role); range 7 → 13 m (GDD §8.3 amendment: the 7 m cone never engaged, CHR-8); flame particles 30/s (extra)
  drone:  { id: 'troop.drone',  unlock: 10, rate: 4, dpsFraction: 0.05, hover: 5.2, slot: 'above', scale: 1.4,                     // 4 shots/s, 5 % of squad DPS each, runners first; hover 3 → 5.2 m (round-2 CHR-9: above the count label)
            tracerDropM: 8 },                                                                                                       // extra: drone tracers descend to FIRE.bullet.y over 8 m (cosmetic; hit tests are XZ)
  apc:    { id: 'troop.apc',    unlock: 12, poolBase: 20, poolPerLevel: 2, width: 2.4, length: 3.4, ahead: 3.5, explodeRadius: 3, explodeDpsSeconds: 2, slot: 'ahead',
            crushRadius: 1.4, crushOffsetZ: -1.7,                                                                                   // pool 20 + 2·L bites; crush circle per ARCH §7 (extra keys)
            crushDamage: 9999, removeReason: 'destroyed', scale: 1.0 },                                                             // extra: ARCH §6.6/§7 damageInCircle(…, 9999, 'crush'); troop:remove.reason at pool 0; scale 1 keeps the mesh = the width × length hit box; ahead 2.5 → 3.5 m (round-2 CHR-9: clears the label and the front rows)
  // extra: troops.js feel / animation literals (troops.js reads this object as its ANIM; round-2 cross-group: the old
  // local mirror is gone) — follow / yaw lerpExp rates (1/s), snap distance (m), lean (rad per m/s), recoil decay (1/s),
  // sniper kick (m) and aim hold (s), drone bob / rotor / tilt / LED / lag / muzzle drop / perch, medic offset and cross
  // glow pulse, flamer offset / activation margin / aim / volley / HP floor / pilot flame / jet look / sway, sniper flank
  // perch, APC wheel radius, bob, roll, flinch, smoke and headlight flicker, rotor-disc flicker, particles per muzzle
  // flash, Low-tier blob-shadow scales.
  anim: {
    followRate: 10, yawRate: 9, snapDist: 6, leanPerMs: 0.035, recoilDecay: 9,
    sniperKick: 0.18, sniperAimHold: 0.9,
    droneBobAmp: 0.18, droneBobHz: 0.55, droneRotorRps: 7, droneTiltPerMs: 0.06, droneTiltMax: 0.35, droneRecoil: 0.08, droneLedHz: 2.0,
    droneLagRate: 5, droneMuzzleDrop: 0.3,
    droneAhead: 2.5,                         // m ahead of the blob centre (round-2 CHR-9: with hover 5.2 m it reads above the count label)
    droneMaxX: WORLD.steerRange + 0.7,       // m world x ceiling: steered hard right, droneSideX would put the rotors off the portrait view
    droneSideX: 1.2,   // m right of the blob centre line (round-2 CHR-9: with hover 5.2 m, 2 m ahead of the blob centre, the drone clears a 4-digit
                       // count label and stays inside a 390 px portrait view; 2.2 m put its rotors off the right edge)
    medicXOffset: SQUAD.slotSpacing * 0.5, medicCrossHz: 1.0, medicCrossMin: 0.6, medicCrossMax: 1.6, medicHealFlash: 3.0, medicHealSparks: 6,
    flamerFrontOffset: -SQUAD.rowPitch, flamerActiveMargin: 3, flamePilotPerSec: 4, flameLife: 0.45, flameSize: 0.55, flameSpread: 0.22,
    flameRise: 1.5, flamerSwayAmp: 0.06, flamerSwayHz: 2.4,
    // CHR-8 engagement: the trooper swings the cone toward the nearest zombie ahead within flamerAimRange m (±flamerAimMaxYaw
    // rad, held flamerAimHold s); every flamerVolleyEvery s he lobs a narrow jet (half angle flamerVolleyHalfDeg°, visual
    // only) at a brute / spitter holding within flamerVolleyReach m (else the nearest within flamerAimRange) carrying
    // flamerVolleyShare × dps × every (round-2 CHR-12: every 0.5 → 1.0, share 0.6 → 0.5).
    flamerAimRange: 15, flamerAimMaxYaw: 0.6, flamerAimHold: 0.6,
    flamerVolleyEvery: 1.0, flamerVolleyReach: 19, flamerVolleyHalfDeg: 5, flamerVolleyShare: 0.5, flamerVolleyParticles: 6,
    flamerHpFloor: 0.25,                     // round-2 CHR-12: the cone (and a jet at a non-ranged zombie) never takes a zombie below this fraction of ZOMBIES[type].baseHp · hz
    flamePilotReach: 1.0,                    // m the idle pilot flame reaches
    sniperSideMargin: 0.8,                   // m beyond the blob half-width: the sniper's crate stands on the blob's LEFT flank (round-2 CHR-9; replaces sniperRearMargin)
    sniperMinX: -(WORLD.steerRange + 1.0),   // m world x floor: a wide blob steered hard left would push the flank perch off the portrait view
    droneDiscFlicker: 0.25,                  // ± fraction of the rotor-disc opacity (blur flicker at droneRotorRps)
    apcWheelRadius: 0.45, apcBobAmp: 0.02, apcBobHz: 1.7, apcRollPerMs: 0.02, apcFlinch: 0.25, apcSmokeFrom: 0.6, apcSmokeMaxPerSec: 10,
    apcSparksAtHit: 3, apcSmokeRise: 1.6, apcSmokeLife: 1.1, apcSmokeSize: 0.7, apcLightMin: 1.2, apcLightMax: 2.2,
    muzzleParticles: 2, shadowScaleGround: 1.3, shadowScaleApc: 3.2, shadowScaleDrone: 0.9,
  },
});

// GDD §8.3 pickup schedule: index = L − 1; the level's newly unlocked special is guaranteed, after which it joins the bag.
export const PICKUP_SCHEDULE = deepFreeze(['weapon.shotgun', 'gear.armor', 'weapon.minigun', 'gear.magnet', 'troop.sniper', 'troop.medic', 'gear.chip',
  'troop.flamer', 'weapon.rocket', 'troop.drone', 'gear.booster', 'troop.apc', 'weapon.railgun', 'weapon.laser']);

// ==== PICKUPS ================================================================================
// GDD §8 delivery, §9.1 coin lines/crates; ARCHITECTURE §6.10 / §8.4.
export const PICKUPS = deepFreeze({
  crate: { hitsToOpen: 5, size: 0.8, openOnContact: true, pool: 8,     // 0.8 m box, emissive seams; opens after 5 hits or on contact
           // extra (pickups.js look / feel; colours in PALETTE.crate): body height fraction (lid = the rest), lid overhang, emissive
           // seam width (m), ± yaw (rad, ctx.rngFx), J12 lid pop time (s) / flip angle (rad) / jump (m), per-hit white flash (s)
           // and scale punch, seam HDR glow (= RENDER.gateFrameEmissive) / pulse Hz / brightening with hits, open → shrink delay / time (s)
           bodyFrac: 0.7, lidOverhang: 1.04, seamWidth: 0.045, yawJitter: 0.15, lidPopSeconds: 0.35, lidAngle: 1.9, lidLift: 0.25,
           hitFlash: 0.08, hitPunch: 0.08, seamEmissive: 1.6, seamPulseHz: 1.2, seamHitGain: 1.5, vanishDelay: 0.45, vanishTime: 0.25,
           // extra (round-2 QA GAT-10): the per-hit flash is TINTED, not white — emissive += seam colour (HDR, × seamEmissive) ×
           // decay × hitFlashGain; it restarts at most every hitFlashRetrigger s, so sustained fire pulses instead of holding
           hitFlashGain: 0.35, hitFlashRetrigger: 0.15 },
  coinLine: { count: 8, gap: 1.2, value: 1,                            // 8 × 1 c, 1.2 m apart, on one half
              everyGates: 2 },                                         // extra: one generated coin line per this many gate events (levelgen)
  // extra (pickups.js coin look): radius / thickness / hover height / bob (m), bob Hz, spin rev/s, pulled coins fly to chest
  // height (m), cylinder radial segments
  coin: { radius: 0.22, thickness: 0.06, y: 0.55, bobAmp: 0.06, bobHz: 1.4, spinHz: 0.8, targetY: 0.9, segments: 14 },
  coinPool: 64,                                                        // extra: coin InstancedMesh capacity
  crateCoins: 10,                                                      // 'coins' crate payout
  collectRadius: 1.5,                                                  // crate opens on contact within 1.5 m
  coinCollect: 0.8,                                                    // a pulled coin is collected at ≤ 0.8 m
  magnetPull: 12,                                                      // m/s pull inside the magnet radius
  iconRise: 1.5,                                                       // item icon rises 1.5 m before flying to the HUD (J12)
  gateShare: 0.5,                                                      // 50 % of specials arrive by item lane, 50 % by crate
  perLevel: { base: 2, perLevels: 4, cap: 5 },                         // specials per level = min(5, 2 + floor(L/4))
  duplicateCoins: 25, replaceRefund: 25,
  items: ['weapon.shotgun', 'weapon.minigun', 'weapon.rocket', 'weapon.railgun', 'weapon.laser',
          'gear.armor', 'gear.magnet', 'gear.chip', 'gear.booster',
          'troop.sniper', 'troop.medic', 'troop.flamer', 'troop.drone', 'troop.apc', 'coins'],   // extra: every grantable item id
});

// ==== UPGRADES / ECONOMY / STARS / SCORE =====================================================
// GDD §9.2 shop (5 upgrades × 10 ranks); ARCHITECTURE §6.15 / §8.5. Keys = save.upgrades ids; NO other
// keys may be added here (save.profile() and the shop iterate this object). `effect(n)` = value at rank n,
// `fmt(v)` = display string; `desc` (extra) = card caption.
export const UPGRADES = deepFreeze({
  squad:      { name: 'Start squad',     desc: 'More soldiers at the start',       base: 150, ranks: 10, effect: n => 5 + 2 * n,           fmt: v => `${v} soldiers`, fmtDelta: (a, b) => `${a} → ${b} soldiers` },   // fmtDelta: one-line shop caption, unit printed once
  fireRate:   { name: 'Fire rate',       desc: 'Soldiers shoot faster',            base: 200, ranks: 10, effect: n => 2.0 * (1 + 0.1 * n),  fmt: v => `${v.toFixed(1)}/s` },
  damage:     { name: 'Damage',          desc: 'Every bullet hits harder',         base: 200, ranks: 10, effect: n => 1 + 0.15 * n,         fmt: v => `×${v.toFixed(2)}` },
  coinMult:   { name: 'Coin multiplier', desc: 'More coins from kills and bosses', base: 120, ranks: 10, effect: n => 1 + 0.10 * n,         fmt: v => `×${v.toFixed(1)}` },
  bossDamage: { name: 'Boss damage',     desc: 'Extra damage to bosses',           base: 180, ranks: 10, effect: n => 1 + 0.15 * n,         fmt: v => `×${v.toFixed(2)}` },
});

/** Cost of rank n (1..10) of an upgrade: round10(base · 1.4^(n−1)) — GDD §9.2. */
export const upgradeCost = (id, n) => round10(UPGRADES[id].base * Math.pow(1.4, n - 1));

// GDD §9.1 income; ARCHITECTURE §6.16 / D1. coinMult applies to sources 'kill' and 'boss' only;
// replay/endless ×0.6 applies to every source; the level/star bonus is credited as source 'bonus'.
export const ECONOMY = deepFreeze({
  kill: { walker: 1, runner: 2, crawler: 1, brute: 15, spitter: 6 },
  bossCoins: L => 15 + 5 * L,                   // round-3 QA LVL-23: was 30 + 10·L (skill-independent income halved; survivors and stars pay instead)
  gatePass: 3, gateMax: 5,                       // = GATE_RULES.coins
  levelBonus: L => 20 + 10 * L,                  // round-3 QA LVL-23: was 40 + 20·L; × (1 + starBonus[stars]): 3★ pays the old 40 + 20·L
  starBonus: [0, -0.5, 0, 1.0],                  // index = stars: level bonus × (1 + this) — 1★ ×0.5, 2★ ×1, 3★ ×2 (round-3 QA LVL-23; was 0 / +50 % / +100 %)
  failBonusFrac: 1.0,                            // (new) QA LVL-21 (GDD §9.1): game over also pays levelBonus(L)·failBonusFrac·fraction reached ('bonus'); round 3: 1.0 (the level bonus halved)
  survivorCoins: 1.4, survivorFrom: 0.6,         // (new) round-3 QA LVL-23 (GDD §9.1): + this per survivor beyond survivorFrom·E_boss, with the level bonus ('bonus')
  bossFightKillMult: 0.25,                       // (new) round-3 QA LVL-23 (GDD §9.1): kill coins during a campaign boss fight × this (a longer fight must not pay more)
  replayPayout: 0.6, endlessPayout: 0.6,
  gameOverKeep: 0.5,
  duplicate: 25,                                 // = PICKUPS.duplicateCoins / replaceRefund
  coinMultSources: ['kill', 'boss'],             // extra: ARCH D1
  breakdownOf: { kill: 'kills', gate: 'gates', max: 'gates', pile: 'piles', crate: 'piles', boss: 'boss', duplicate: 'bonus', refund: 'bonus', bonus: 'bonus' },   // extra: coin:pickup.source → run.breakdown key (ARCH §6.16)
});

// GDD §9.3 stars: 1★ boss killed, 2★ survivors ≥ 0.5·E_boss, 3★ ≥ 0.75·E_boss.
export const STARS = deepFreeze({ two: 0.5, three: 0.8 });   // round-3 QA LVL-22 (GDD §9.3): 3★ at 0.8·E_boss (was 0.75)

// GDD §9.3 score = kill·Σ kill coins + peak·peakSquad + survivor·R + flipped·gatesFlipped + noRedLoss (if none lost to red);
// GDD §10.1 endless score = metres + 10·kills + 25·gate passes + 500·mini-boss kills, ×2 per 60 s with zero deaths.
export const SCORE = deepFreeze({
  kill: 10, peak: 15, survivor: 20, flipped: 200, noRedLoss: 500,
  endless: { metre: 1, kill: 10, gate: 25, miniBoss: 500, streakSeconds: 60, streakMult: 2,
             pressure: true },   // (new) round-3 QA LVL-17 (GDD §10.1): every endless score term × the chunk's pressure factor (surviving pressure pays)
});

// ==== LEVELS =================================================================================
// GDD §10 curve, §10.1 endless, §11 Level 1; ARCHITECTURE §6.16 / §6.17 / §8.6 / §8.7.
//
// LevelScript = { id, name, seed, length, roadSpeed, eBoss, expected:[{ at, e }], events:[Event] }
// Event = { at, type:'gates', layout, lanes:[Lane], guards?, hint? } | { at, type:'wave', pattern, units, spread?, x?, hp?, hpMult?, hint?, hintOnLoss? }
//       | { at, type:'crate', item, x } | { at, type:'coins', x, count? } | { at, type:'hint', id }
//       | { at, type:'runup', units, bursts, burstGap, pattern, hp? } | { at, type:'boss', id, archetype, hp, phases?, minionHp?, mini? }
// Lane  = { op:'+'|'-'|'x'|'/'|'item', value?, cap (REQUIRED for + x /), flipCap? (REQUIRED for −), step? (REQUIRED for x /), item?,
//           hintOnHit?, hintOnPass?:{ ifCountAtLeast?, id }, hintIfOtherBetter? }
// `at` = road distance (m) at which the object spawns at the horizon (z = WORLD.spawnZ).
//
// LEVEL_1 = GDD §11 transcribed verbatim ("the ad"). Caps: + cap = max(12, 4·base); − flipCap = base; x step = K_M.
// The crate hint has no field in the crate event shape, so it is carried by a `type:'hint'` row (QA LVL-24: 30 m after
// the crate spawns, so it is read before the crate passes); the boss hint fires from boss:fight (QA LVL-25).
const LEVEL_1 = {
  id: 1, name: 'The Ad', seed: 1001, length: 400, roadSpeed: 8, eBoss: 140,
  // The cautious E-trace (GDD §11): 5 → 25 → 44 → 42 → 66 → 64 → 139 → 133 → 133 (QA LVL-22: the last +25 caps at 75)
  expected: [{ at: 0, e: 5 }, { at: 70, e: 25 }, { at: 136, e: 44 }, { at: 160, e: 42 }, { at: 240, e: 66 }, { at: 262, e: 64 }, { at: 336, e: 139 }, { at: 362, e: 133 }, { at: 400, e: 133 }],
  events: [
    { at: 0, type: 'hint', id: 'steer' },                                                   // "DRAG TO STEER" (hidden once the player has steered)
    { at: 0, type: 'gates', layout: 'pair', lanes: [
        { op: '+', value: 5, cap: 20, hintOnHit: 'shoot', hintOnPass: { ifCountAtLeast: 15, id: 'more' } },   // L +5 → MAX +20 after 15 hits
        { op: '+', value: 2, cap: 6, hintOnHit: 'shoot', hintOnPass: { ifCountAtLeast: 15, id: 'more' } },    // R +2 (cap 6: QA LVL-22, the decoy no longer catches up)
      ] },
    { at: 28, type: 'wave', pattern: 'line', units: { walker: 6 }, hp: { walker: 27 }, hintOnLoss: 'bite' },   // wave A; contact ≈ 90 m = 11.3 s
    { at: 66, type: 'gates', layout: 'pair', lanes: [
        { op: 'x', value: 2, cap: 5, step: 80, hintOnPass: { id: 'x2' } },                 // L x2 (→ x3 after 80 hits; QA LVL-22: was 52 — a 20-soldier squad no longer reaches x4)
        { op: '+', value: 10, cap: 40, hintIfOtherBetter: 'tryx2' },                        // R +10
      ] },
    { at: 90, type: 'crate', item: 'weapon.shotgun', x: 2.0 },                               // shotgun crate on the right half
    { at: 110, type: 'wave', pattern: 'horde', units: { walker: 10, runner: 2 }, hp: { walker: 34, runner: 23 }, hpMult: 1.5, spread: 8 },   // wave B (hpMult: QA LVL-15, play leak was ≈ 0 %)
    { at: 133, type: 'hint', id: 'crate' },                                                 // "GRAB THE CRATE" — round-3 FTUE: inside the x2 pair's commit window (gate z −3 m, 16.6 s), so it can no longer lure a player off the ×2 lane; the crate is 27 m out, 3.4 s to steer (QA LVL-24: was at its spawn, then at 120 m while the x2 | +10 choice was still open)
    { at: 170, type: 'gates', layout: 'pair', hint: 'red', lanes: [
        { op: '-', value: 15, flipCap: 15 },                                                // L −15 (red; flips to +15 at 30 hits)
        { op: '+', value: 6, cap: 24 },                                                     // R +6
      ] },
    { at: 200, type: 'wave', pattern: 'line', units: { walker: 8 }, hp: { walker: 40 }, hpMult: 2 },   // wave C (hpMult: QA LVL-15)
    { at: 266, type: 'gates', layout: 'pair', lanes: [
        { op: 'x', value: 2, cap: 5, step: 86 },                                            // L x2 (→ x3 after 86 hits)
        { op: '+', value: 25, cap: 75 },                                                    // R +25 (cap 75: QA LVL-22 — the worst-lane route earned 3★ through +25 → +100)
      ] },
    { at: 300, type: 'runup', units: { walker: 18, runner: 4 }, hp: { walker: 45, runner: 30 }, hpMult: 1.5, bursts: 4, burstGap: 2, pattern: 'horde' },   // hpMult: QA LVL-15
    { at: 400, type: 'boss', id: 'boss.hulk', archetype: 'hulk', hp: 2800 },                // phases per BOSSES.archetypes.hulk; "SHOOT THE BOSS" fires at boss:fight (QA LVL-25)
  ],
};

export const LEVELS = deepFreeze({
  count: 30,
  endlessUnlock: 10,                      // ENDLESS once highestUnlocked > 10 (i.e. L10 cleared)
  authored: { 1: LEVEL_1 },
  seedBase: 1000,                         // generated level seed = 1000 + L
  curve: {
    len: { base: 400, per: 50, cap: 1400 },            // Len(L) = min(1400, 400 + 50·(L−1))
    gatesPer: 100,                                     // G(L) = round(Len/100)
    wavesEqualGatesFrom: 10,                           // W = G − 1 below L10, G from L10
    pop: { base: 4, cap: 24 },                         // P(L) = min(24, 4 + L)
    eStart: { base: 5, per4: 1, cap: 10 },             // E_start(L) = min(10, 5 + floor((L−1)/4))
    s0Assumed: L => 5 + 2 * Math.floor(Math.min(L, 20) / 2),   // generator's assumed shop start squad
    eBoss: { base: 140, growth: 1.08, cap: 600, round: 5 },    // E_boss(L) = min(600, round5(140·1.08^(L−1)))
    bossHpRound: 50,                                   // extra: = BOSSES.hpRound
    runup: { base: 15, cap: 30, metres: 60, bursts: 4, burstGap: 2, pattern: 'horde',     // 15 + L zombies (cap 30), walkers + runners only
             spread: WAVE_PATTERNS.horde.box[1] },                                         // extra: run-up bursts spawn with `spread: 8` (ARCH §6.16)
    gateStartM: 60,                                    // first gate event at 60 m
    waveAfterGateM: 20,                                // wave 20 m past each gate's arrival
    pickupRange: [0.35, 0.85],                         // specials placed at 35–85 % of the length
    roadLerpRate: 3,                                   // roadSpeed = lerpExp(roadSpeed, target, 3, dt)
    loopAfter: 30,                                     // beyond L30 the curve uses L = 30 with seed 1000 + L
    introAheadM: 60,                                   // QA LVL-12: a new type's solo introduction spawns 60 m before its first mixed wave (GDD §6.2)
    staleEventSkipM: 40,                               // QA LVL-11: script events more than 40 m behind the distance (a debug jump) are consumed unspawned, except runup / boss
    // (new) QA LVL-35 / round-1 LVL-12 (GDD §6.2): a solo introduction is searched within ±introSearchM of its target spawn;
    // failing that the mixed wave's contact moves later in steps of introShiftStepM (at most introShiftMaxM, never into
    // the next gate's armed window)
    introSearchM: 20, introShiftStepM: 5, introShiftMaxM: 25,
    // (new) QA LVL-21 (GDD §10): after assistAfterFails consecutive failures of the same level in a session, the next
    // attempt starts with + ceil(assistStartFrac·E_boss) soldiers (reset on a clear)
    assistAfterFails: 2, assistStartFrac: 0.08,   // round-3 QA LVL-21: 0.25 → 0.08 (the old assist handed a failing player 3★)
    // (new) round-3 QA LVL-21 (GDD §10): the assist escalates for at most assistMaxSteps further failures and is announced with
    // assistHint(n) (hint:show id 'assist', every assisted attempt); RETRY after a failure plays a fresh layout: seed
    // seedBase + L + retrySeedStep·(consecutive failures)
    assistMaxSteps: 4, assistHint: n => `REINFORCEMENTS: +${n} SOLDIERS`, retrySeedStep: 100,
    traceTolerance: 0.15,                              // extra: the cautious E-trace must end within ±15 % of E_boss (ARCH §6.17)
    // (round 5, from levelgen's former DATA-MISSING literals) the weak (0.3·H) line must reach the boss with ≥ cautiousFloor·E_boss
    // (validator warning) and with ≥ weakLineFail·E_boss (error, QA LVL-27); the crate hint row trails its crate's spawn by
    // crateHintAfterM (QA LVL-24); one coin line per coinLineEveryGates gate events (GDD §9.1)
    cautiousFloor: 0.2, weakLineFail: 0.02, crateHintAfterM: 30, coinLineEveryGates: 2,
    introMinAfterGateM: 25,                            // extra: a solo type introduction spawns at least this far after the preceding gate's spawn
    pickupClearM: 15,                                  // extra: crates keep this distance (arrival) from gate arrivals and wave contacts
    // extra (levelgen generator knobs): bounded re-roll attempts, pattern re-rolls per gate before the variant sweep,
    // accepted gain band [target / lo, target · hi] by gates left (≥ 5 early, 3–4 mid, 2 near, 1 last), survival floor
    // (E + surviveMult · bites before the next gate) / E, grid steps of a pattern's uniform draw when tuned
    generator: {
      attempts: 24, specTries: 8,
      gainBand: { early: [1.2, 1.45], mid: [1.15, 1.25], near: [1.1, 1.1], last: [1.05, 1.05] },
      surviveMult: 2, uSteps: 20,
      weakAttempts: 32,                // round 5: attempt budget while the best attempt's weak line is still under cautiousFloor
    },
  },
  endless: {
    chunk: 300,                                        // m per chunk, difficulty index D = 1, 2, 3 …
    speed: { base: 9, per: 0.15, cap: 12 },            // min(12, 9 + 0.15·D)
    e: { base: 150, growth: 1.06, cap: 600 },          // E(z) = min(600, 150·1.06^D)
    gates: [3, 2], gatesSwitch: 4,                     // 3 gate events per chunk while D ≤ 4, then 2
    waves: { base: 2, per4: 1, cap: 3, extraFromD: 12, extraEveryD: 8, extraCap: 2,                 // min(3, 2 + floor(D/4)) (round-3 QA LVL-17: cap 3 — the pressure grows the horde) + one more wave per extraEveryD chunks from extraFromD (≤ extraCap more)   // (round 5d, lead: config T3 — the ramp lives in numbers, see hpCapSeconds)
             maxPerChunk: 6, minSpacingM: 30 },       // (new) round 5d (pool-safe ramp, docs/build/r5d-endless.md): a wave carries at most a pool share of every type (wavePoolShare below: 65 zombies), so once pop exceeds that, the population a chunk owes (pop × its wave count) spreads over more, smaller waves — at most maxPerChunk per chunk, never closer than minSpacingM between contacts inside the chunk's wave window (the mini-boss chunk's 40-m window and the chunk after it keep their counts); without the keys the counts stay and the excess is dropped
    pop: { base: 8, per: 4, cap: 32 },                // min(32, 8 + 4·D) before the pressure (round-3 QA LVL-17: the ramp past D3 is the pressure)   // (round 5d, lead: config T3 — the ramp lives in numbers, see hpCapSeconds)
    heavyPerD: 0,                                      // QA LVL-17: brute / spitter wave share × (1 + heavyPerD·D) (round 3: 0 — the pressure is the ramp)
    miniBossEvery: 5, miniBossHpPerE: 30,              // every 5th chunk; HP = 30·E × count / shop scale × pressure (QA LVL-17); no slow-down / letterbox
    // C < low at a chunk boundary → its first gate event is a guaranteed + pair with base max(lowBase, lowFrac·E), no red
    // (round-3 QA LVL-17: the rubber band only helps on the low side — the ÷2 | ÷2 pull-back above 2·E is gone);
    // highMult·E = the ceiling the + lanes never carry the squad past (keep rule below)
    rubber: { low: 10, lowBase: 8, lowFrac: 0.3, highMult: 2 },
    crates: 1, coinLines: 1,                           // extra: specials (crates) and coin lines per endless chunk (levelgen)
    wavePoolShare: 4,                                  // extra (QA LVL-17 / round 5d): a wave carries ≤ 1/4 of every type's pool — four waves share the road; round 5d: a type's excess moves into the other types' headroom under the same shares (levelgen.capWaveToPoolShare)
    // (new) round 5d (pool-safe by construction, docs/build/r5d-endless.md): the pool slots per type every endless wave and gate guard
    // leaves free — the rotation's minion union (BOSSES.minionBurst.count walkers, the Hulk's 6 runners / 2 brutes, the Queen's 10
    // crawlers), so the mini-boss's own spawns always fit. levelgen.generateChunk fits every chunk's waves so that, in the validator's
    // pool model (a zombie lives from its spawn to its contact; the chunk's waves and guards), each type stays within pool − poolReserve
    // at every moment (the walker pool overflowed at chunk 20: four waves piled on the mini-boss chunk + 6 guards = 126 of 120);
    // level._clampEndlessUnits is the live backstop (units ≤ pool − alive − reserve at spawn, trims counted in ctx.debug.dropped['level.waveClamp'])
    poolReserve: { walker: 6, runner: 6, crawler: 10, brute: 2, spitter: 2 },   // spitter: no minion of the rotation — 2 slots for bodies still toppling (ZOMBIES.common.death.free holds a slot 1.4 s after the kill; measured: 17 refused spitter spawns in 12 rank-10 runs at 0)
    bufferM: 70,                                       // extra: append the next chunk when distance ≥ chunkEnd − 70 (ARCH §6.16)
    // QA LVL-17: the leak target rises bandPerD per chunk above the equivalent level's band midpoint, ≤ bandMax (round 3: 0 —
    // the pressure is the ramp)
    bandPerD: 0, bandMax: 0.45,
    // QA LVL-17: a squad above E meets min(crowdMax, √(C / E))× the wave population (round 3: 1 = off — waves follow the
    // pressure, not the squad: a squad that stays big is rewarded)
    crowdMax: 1,
    // QA LVL-17: while the worst-case count ahead exceeds keepMult·E, gate events lose their × lanes and every + lane is
    // capped at min(plusCapFrac·E, highMult·E − the worst case before it)
    keepMult: 2, plusCapFrac: 0.5,
    // (new) round-3 QA LVL-17 (GDD §10.1): endless MUST end. From chunk fromD a compounding pressure p = (1 + perD)^(D − fromD)
    // multiplies wave HP (p^hpShare — moot above the round-5d HP cap below), the mini-boss's attack kills, and divides the most a
    // gate may add (p^gainShare); the score is × p (SCORE.endless.pressure). Round 5d: the population part (p^popShare, each
    // type ≤ a quarter of its pool) is baked into the chunk by levelgen.endlessParams(D).pop — the validator counts the real
    // pools and the level no longer multiplies the units at spawn — and it is the ramp that ends a run (hpCapSeconds below)
    pressure: { fromD: 4, perD: 0.07, hpShare: 1, popShare: 1, gainShare: 1 },
    // (new) round-3 QA LVL-17: waves are designed for a squad of designMult·E(D) (the leak model's capacity × the troops and
    // specials an endless run piles up; ramped in from ×1 at D1 to ×designMult at designRampD), solved at E(D) only
    // ((C / E)^liveExp above E: 0 = a big squad is not chased) and without the campaign's shop compensation (profileExp: the
    // shop's fire rate × damage is what carries a strong player deeper)
    designMult: 9, designRampD: 3, liveExp: 0, profileExp: 0,
    // (new) round-3 QA LVL-17: gate values stop growing past the E cap — gates are sized from E(min(D, gateEMaxD)) and no lane
    // may add more than gainCapFrac·E(gateEMaxD) / p^gainShare (every lane of an event scaled by the same factor, × lanes
    // as the + lane worth their scaled gain, so the better lane stays the better one)
    gateEMaxD: 4, gainCapFrac: 0.35,
    miniMinions: { hpMult: 1, pressureShare: 0, profileExp: 0.5 }, miniBossLeadM: 100, miniBossTailM: 100, miniBossWaveCut: 1, miniBossHpShare: 0, miniBossKillsShare: 1,
    // (new) round-5c (lead): endless mini-boss fights are set pieces, not walls — their minions are soak (the calibrated
    // solve at E(D) without the chunk pressure, profileExp 0.5 vs the shop), the boss's chunk gives up one wave and its waves
    // stay 100 m clear of the fight (lead/tail), the boss HP ignores the pressure (hpShare 0) while its attack kills keep it
    // (killsShare 1). Measured (E:/.../r5c/endless/runs/D-*): strong rank 3 median death chunk 9–10.5, first mini-boss
    // killed 36/36, mini-boss deaths 1/12 per set (was 7/12), passive rank 0 chunk 3.5–5, nobody past chunk 25.
    // (new) round-5d (lead decision, GDD §10.1 / §6.3; docs/build/r5d-endless.md): endless death comes from GROWING NUMBERS,
    // never from a single unkillable zombie. After the wave solve × every multiplier each type's HP is clamped to
    // hpCapSeconds[type] × the on-curve squad's design DPS (E(D) · FIRE.rateBase · FIRE.dmgBase · FIRE.accuracy · p^profileExp,
    // p = the shop's fire rate × damage, levelgen.endlessHpCap) — waves and gate guards (level._capEndlessHp); the mini-boss's
    // own minions (miniMinions) sit far below it. A zombie in contact dies within a few seconds of focused fire, a brute in
    // ≤ 3 s (it was 7.7k HP at chunk 5 and a 143-squad fed it the whole fight). The chunk pressure rides on the population
    // (pressure.popShare, pop, waves above) instead.
    hpCapSeconds: { walker: 0.5, runner: 0.4, crawler: 0.35, brute: 3.0, spitter: 1.2 },
    // (new) round-5d: the road's events hold during a mini-boss fight — from boss:spawn to boss:dead the runner fires no gates /
    // wave / crate / coins event (the script cursor waits; chunk, district and score bookkeeping go on, the boss's own minions
    // spawn); at the kill every event still ahead, and every chunk generated after it, slides by one shift so the first held
    // event spawns releaseM after the kill (level._releaseHold); zombies already on the road stay. A 35-s fight used to let the
    // next chunk's ÷3 | −140 gate and 25–48-zombie waves arrive mid-fight (the lead's r3 probe, 169–184 s).
    miniBossHold: { releaseM: 60 },
  },
});

// ==== QUALITY_TIERS ==========================================================================
// GDD §16; ARCHITECTURE §6.2 (detectTier, auto-scaler) / §8.8 / §9.3–§9.5.
// Every pool is allocated at the High capacity; the live tier only sets the active caps (ARCH §14 rule 3).
export const QUALITY_TIERS = deepFreeze({
  order: ['low', 'med', 'high'],
  pixelCap: 1.0e6,                        // render-target pixel cap (lowers DPR first, never below 1.0)
  high: { dpr: 2.0, shadowMap: 2048, shadows: true,  shadowType: 'pcf',     bloom: 'half',    msaa: 4, msaaIOS: 2, vmax: 200, particles: 1024, tracers: 256, propDensity: 1.0, dust: 300, smoke: true,  fogFar: 100, hpBars: 'all',     blur: true,  shadowCasters: 400, anisotropy: 8 },
  med:  { dpr: 1.5, shadowMap: 1024, shadows: true,  shadowType: 'pcf',     bloom: 'quarter', msaa: 0, msaaIOS: 0, vmax: 120, particles: 512,  tracers: 128, propDensity: 0.7, dust: 150, smoke: true,  fogFar: 100, hpBars: 'all',     blur: false, shadowCasters: 150, anisotropy: 4,
          bloomMips: 3 },   // extra (round-2 QA VIS-13): Medium blurs 3 bloom mips (High / absent = UnrealBloomPass's 5; same programs)
  low:  { dpr: 1.0, shadowMap: 0,    shadows: false, shadowType: 'none',    bloom: 'off',     msaa: 0, msaaIOS: 0, vmax: 60,  particles: 256,  tracers: 64,  propDensity: 0.4, dust: 0,   smoke: false, fogFar: 90,  hpBars: 'damaged', blur: false, shadowCasters: 0,   anisotropy: 1 },
  // bloom: 'half' = UnrealBloomPass at rt (mip 0 = rt/2), 'quarter' = at rt/2 (mip 0 = rt/4); mips: 5, or tier.bloomMips (Medium 3, VIS-13)
  // shadowType: PCF on High too (VIS-1; render scales the PCF radius with shadowMap), so High ⇄ Medium never changes a shader program
  heuristics: [
    { re: /Apple (A1[4-9]|A2|M[1-9])/i, tier: 'high' },
    { re: /Apple GPU/i, tier: 'med', maxAuto: 'high' },                       // iOS ≥ 17 reports 'Apple GPU' for every device (A12 included)
    { re: /Adreno \(TM\) 7|Mali-G7|Mali-G8|Immortalis/i, tier: 'high' },
    { re: /NVIDIA|Radeon|GeForce|Arc\(TM\)|Apple M/i, tier: 'high' },
    { re: /Intel.*(Iris|UHD|HD Graphics)/i, tier: 'med', maxAuto: 'high' },
    { re: /Adreno \(TM\) 6|Mali-G5/i, tier: 'med' },
  ],
  fallbackTier: 'med',                    // no GPU string at all
  unknownGpuTier: 'low',                  // a string that matches nothing
  unknownMaxAuto: 'med',                  // … may auto-raise up to Medium
  lowMemoryGB: 3,                         // deviceMemory ≤ 3 GB caps the start at Low
  scaler: { window: 60, dropFactor: 1.4, dropAfter: 3, raiseFactor: 1.05, raiseJsMs: 7.5, raiseAfter: 10, hysteresis: 15, freezeLevelStart: 2, refreshSamples: 90, refreshSnap: [8.33, 11.1, 16.67],
            hitchIgnoreMs: 250,     // extra: rAF gaps above this (tab switch, GC, debugger) are excluded from the scaler means and the refresh measurement
            // CORE-6: the scaler's frame target is max(measured refresh, targetMinMs) — Medium is the 60 fps contract, so a
            // 90/120 Hz panel never demotes a tier that holds 60 fps (drop > dropFactor·target, raise ≤ raiseFactor·target)
            targetMinMs: 16.67,
            // CORE-6: refresh = median of draw-free rAF intervals (boot screen, pause, after visibility/resize), never title frames;
            // adopted only with ≥ refreshMinSamples samples (else the previous value stays); a probe gives up after refreshProbeMs
            refreshMinSamples: 60, refreshProbeMs: 5000,
            // CORE-6: an auto raise back to a tier the scaler already dropped from n times needs raiseAfter · raiseBackoff^n s
            // (no 15 s low ⇄ med flapping when Low holds 60 fps but Medium does not)
            raiseBackoff: 2 },
  pauseFps: 30,                           // paused redraw rate on High (33 ms gate)
  budget: { jsMs: 7.5, mainCalls: 50, shadowCalls: 20, postCalls: 14 },   // extra: debug overlay red flags (ARCH §6.2 / D22)
});

// ==== RENDER =================================================================================
// GDD §15 lighting/grade/bloom, §7 camera theatre, §14 letterbox; ARCHITECTURE §6.3 / §8.9 / §9.
// Every literal render.js would otherwise hold. `env`, `textures`, `atlas`, `icons` are extras lifted
// from ARCH §6.3 / §9.1 / §9.6 so render/models/fx/ui share one source.
export const RENDER = deepFreeze({
  sun: { color: 0xFFD2A0, intensity: 3.0, offset: [8, 12, -14], frustum: { l: -14, r: 14, t: 40, b: -12, near: 1, far: 60 }, bias: -0.0005, normalBias: 0.02, shadowRadiusPcf: 1 },
  hemi: { sky: 0x7FB0E0, ground: 0x5A4634, intensity: 0.9 },
  exposure: 1.05,                         // ACESFilmic exposure
  bloom: { strength: 0.6, radius: 0.4, threshold: 0.85, deathPeak: 1.6, deathTime: 1.5,     // boss death: 0.6 → 1.6 → 0.6 over 1.5 s
           deathRise: 0.3 },                                                                  // extra: fraction of deathTime spent rising to the peak
  pointLights: { distance: 16, decay: 1.5 },   // extra: default range (m) / decay of the boss-core and laser PointLights (boss / weapons override theirs)
  grade: { shadowTint: 0x1E6C7A, shadowMix: 0.08, shadowLuma: 0.3, highlightTint: 0xFFB070, highlightMix: 0.10, highlightLuma: 0.7, saturation: 1.12, vignette: { strength: 0.35, a: 0.5, b: 1.4 } },
  fogColor: 0xD8744A, skyFogMix: 0.15,    // sky dome bottom 15 % mixed to the fog colour
  idleCameraDrop: 0.15,                   // title camera 15 % lower
  // extra (round-2 QA VIS-15): title-screen light while the idle camera is on (eased with it, restored at level:start):
  // hemisphere fill intensity, and the sun swung this far about +Y (deg) from RENDER.sun.offset toward the camera side,
  // so the marching squad's backs (the title camera looks over them) are lit instead of black silhouettes
  title: { hemi: 1.8, sunAzimuthDeg: 175 },
  gateFrameEmissive: 1.6, lowTierEmissiveBoost: 0.3,
  letterboxPct: 8,                        // boss intro bars
  dollyPos: [0, 7, 7],                    // boss intro dolly position (look at the boss core)
  gameOver: { dropM: 1.0, orbitDeg: 10, seconds: 1.2 },   // J18
  blobShadow: { radius: 0.35, opacity: 0.35, capacity: 567, slots: { squad: 0, zombies: 300, troops: 560, boss: 565 },     // Low tier only
                y: 0.012 },   // extra: disc height above the road (m) against z-fighting
  road: { textureM: [8, 15], repeat: [1, 2] },             // the road texture covers 8 × 15 m; segment = 30 m → repeat.y 2
  env: {
    skyRadius: 150, skySegments: [24, 12], groundSize: [200, 400], roadSegmentDivisions: 6,
    curbs: 12,
    props: { barricade: 48, sandbags: 32, car: 24, building: 32, tree: 40, rubble: 48, lamppost: 24, smoke: 12 },   // InstancedMesh capacities (ARCH §9.1)
    propSeedMult: 1000,                   // prop placement rng = mulberry32(levelSeed·1000 + segmentIndex)
    dust: { count: 300, box: [12, 6, 40], speed: 0.4, size: 0.06 },   // dust motes (High 300 / Med 150 / Low 0 via params.dust)
    // extra (environment.js dressing): roadside placement bands (|x| m from the road centre line), presence chances and
    // scale ranges for the seeded props; count per segment = floor(props[kind] / WORLD.roadSegments) · density · U(densityFloor,
    // densityFloor + densitySpread)
    layout: {
      curb: { w: 0.3, h: 0.19, block: 2.0, gap: 0.05, shade: 0.8 },     // curb blocks 2 m long, alternating shade
      lamp: { x: 4.75, pitch: 15, offset: 1.0, present: 0.55, broken: 0.16, dark: 0.12, tilt: [0.1, 0.28], scale: [0.95, 1.08] },
      barricade: { x: [4.95, 6.3], chain: 1.95, maxChain: 3, diagonal: 0.25, toppled: 0.12, beaconOn: 0.55, jitter: 0.35 },
      sandbags: { x: [5.4, 7.6], scale: [0.85, 1.2] },
      car: { x: [6.7, 9.8], cross: 0.2, flipped: 0.12, onSide: 0.08, burnt: 0.22, yawJitter: 0.9, dark: [0.72, 1.0] },
      building: { front: [10.5, 13.5], storeys: [2, 5], width: [0.85, 1.3], depth: [0.8, 1.2], present: 0.45, slotJitter: 3,
                  farX: [24, 36], farStoreys: [5, 9], farWidth: [1.2, 1.8], farPresent: 0.2, tint: 0.08 },
      tree: { x: [8.5, 15], scale: [0.8, 1.45], lean: 0.18 },
      rubble: { x: [5.0, 13.5], scale: [0.6, 1.5], squash: [0.6, 1.15] },
      smoke: { x: [9, 24], w: [5.5, 9.5], h: [16, 28], chance: 0.4 },
      densityFloor: 0.6, densitySpread: 0.7,
      tintJitter: 0.1,                                                   // ±10 % per-instance brightness
    },
    // extra: shader ground beyond the road — dry grass tufts, shoulder gravel band |x| from → to, drainage ditch line,
    // pattern period along z (seamless scroll wrap, m), plane height (below the road: no z-fight at 100 m), how far the
    // plane reaches past WORLD.segmentRecycleZ toward the camera (m)
    ground: { grass: 0x6B6440, shoulder: [5.0, 7.2], ditchX: 7.6, periodM: 512, y: -0.03, pastRecycleM: 40 },
    // extra: sky dome look beyond the GDD §15 stops — sun halo lobes and HDR disc boost, horizon warmth toward the sun and
    // darkening away from it, cirrus opacity and drift (dome units/s), distant skyline haze mix / darkening / columns per
    // radian / lit-window factor
    sky: { haloWide: 0.18, haloTight: 0.45, discBoost: 3.0, horizonWarm: 0.45, awayDarken: 0.86, cirrus: 0.4, cirrusDrift: [0.006, 0.002],
           skylineMix: 0.3, skylineDark: 0.9, skylineCols: 42, skylineLit: 0.7 },
    // extra: smoke-column shader — rise speed (+ variation), wind lean, alpha, ember glow (× PALETTE.fx.flame) and flicker rate,
    // sunset light bounce on the high plume
    smokeColumn: { rise: 0.03, riseVar: 0.02, wind: [-0.04, 0.012], alpha: 0.9, ember: 2.6, emberFlicker: 7.0, glowBounce: 0.12 },
    // extra: emissive props — lamp lens radiance (× PALETTE.props.windowLit), barricade beacon radiance (× PALETTE.ui.primary),
    // blink rate (rad/s) and smoothstep window of the blink
    lights: { lampEmissive: 2.4, beaconEmissive: 2.2, blinkRate: 4.2, blinkDuty: [-0.2, 0.4] },
    facadeTileM: 6,                  // extra: the TextureFactory facade / windows canvases cover 6 m × 6 m
    darkBuildingFraction: 0.25,      // extra: share of buildings with no lit windows
    buildingBounce: 0.45,            // extra: warm fog-coloured fill on facades (× fog colour, linear) so backlit facades never go black
    titleSeed: 1,                    // extra: prop seed used before the first setLevel (title idle scene)
    // extra (round-2 QA VIS-23, was a literal in environment.js; VIS-11): road manhole cover decals placed per segment from
    // the segment rng — up to `max` per segment, |x| band inside the lanes (m), cover radius (m), lift above the road (m;
    // depth-safe without polygon offset at 160 m), chance per slot
    manhole: { max: 2, chance: 0.42, x: [1.0, 2.6], r: 0.4, lift: 0.012 },
  },
  textures: {
    road: [512, 1024], digitAtlas: [1024, 256], glow: [128, 128], smoke: [256, 256], windows: [256, 256], particle: [64, 64], muzzle: [128, 64], dust: [32, 32], icons: [512, 64],
    font: 'Lilita One', fontWaitMs: 1500,
  },
  atlas: {
    cell: [102, 128], glyphPx: 100, strokePx: 18, padPx: 8, insetPx: 2, anisotropy: 4,   // strokePx 12 → 18 (round-2 QA VIS-12: the outline must survive at ≈ 29 px)
    rows: [['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], ['+', '−', '×', '÷', 'M', 'A', 'X', '.', '★', '⚡']],   // row 1 glyphs; ops map '-' → '−', 'x' → '×', '/' → '÷'
    advance: { digit: 0.62, '+': 0.55, '−': 0.5, '×': 0.6, '÷': 0.6, M: 0.7, A: 0.62, X: 0.62, '.': 0.3, '★': 0.7, '⚡': 0.6 },   // em
    fallbackFont: 'system-ui, sans-serif',   // a row-1 symbol cell without a shape painter falls back to the system font (round-3 verify: ★ / ⚡ are drawn as shapes)
  },
  icons: {
    order: ['shotgun', 'minigun', 'rocket', 'rail', 'laser', 'armor', 'chip', 'booster', 'magnet', 'sniper', 'medic', 'flame', 'drone', 'apc', 'coins', 'star'],   // 16 cells of 32 px
    ofItem: { 'weapon.shotgun': 'shotgun', 'weapon.minigun': 'minigun', 'weapon.rocket': 'rocket', 'weapon.railgun': 'rail', 'weapon.laser': 'laser',
              'gear.armor': 'armor', 'gear.chip': 'chip', 'gear.booster': 'booster', 'gear.magnet': 'magnet',
              'troop.sniper': 'sniper', 'troop.medic': 'medic', 'troop.flamer': 'flame', 'troop.drone': 'drone', 'troop.apc': 'apc', coins: 'coins' },
  },
});

// ==== PALETTE ================================================================================
// GDD §15 (plus the colours named in §4.1 / §5 / §12 / §14); ARCHITECTURE §8.8.
// Hex numbers are sRGB 0xRRGGBB (MaterialLibrary.standard → Color.setHex). HDR triplets are LINEAR
// [r, g, b] with values 2–4 (hdrBasic → setRGB(r, g, b, LinearSRGBColorSpace), never double-converted).
// Alphas, intensities and fractions sit next to the colour they belong to.
//
// Key tree (every colour in the game lives here):
//   sky.{zenith, upper, horizon, glow, sun}   + sky.stops.{zenith, upper, horizon, glow} (dome y 1 → 0),
//                                               sky.sunAzimuthDeg, sky.sunElevationDeg, sky.fogMix (= RENDER.skyFogMix)
//   fog   ground   shadowTint
//   road.{asphalt, crack, patch, dash, edge, curb, shoulder, tyre}
//        + road.asphaltNoise, road.dashM, road.dashGapM, road.dashWorn, road.tyreOpacity
//   props.{barricade, barricadeRed, barricadeWhite, car[4], rust, glass, tyre, sandbag[2], building, window, windowLit, tree, smoke[2], dust, coin, coinEmissive}
//        + props.windowLitFraction, props.windowLitEmissive, props.dustOpacity, props.coinEmissiveIntensity
//   soldier.{uniform, webbing, helmet, skin, rifle, boots, backpack}
//   troop.{sniperCoat, sniperLens, flamerSuit, flamerTank, flame, medic, medicCross, drone, droneLed, apc, apcLight}
//   zombie.{walker, runner, crawler, brute, spitter}.{skin, cloth, eyes}  + zombie.brute.muscle, zombie.spitter.sacs, zombie.eyesEmissive, zombie.burning
//   boss.{skin, plates, core, eyes}  + boss.coreEmissive, boss.eyesEmissive, boss.rage, boss.shield
//   blood
//   crate.{body, lid, seam}                  (pickups.js crate look: wood brown, olive canvas lid, brand-orange seams)
//   gate.{plus, mult, minus, div, zero, item}.{tint, frame} + gate.max      (the SAME object as GATE_RULES.colors)
//   glyph.{fill, outline} + glyph.emissive
//   tracer.{rifle, shotgun, minigun, laser, railgun, sniper, drone} (HDR) + tracer.chipTint (HDR)
//   fx.{spark, muzzle, gold, blue, acid, armor, flame, smoke, dust, white, laser, rail, rocket, splash, confetti[6]}
//   ui.{bgPanel, primary, primaryText, primaryBorder, secondary, secondaryText, danger, success, text, textMuted, coin, bossBar, bossTrack, focus,
//       logoGradient[2], levelLocked, levelCurrent, pauseDim, progressFill, bossBarPhase2, bossBarPhase3, bossBarShield, themeColor, hintText}
//      + ui.bgPanelAlpha, ui.pauseDimAlpha
//   flash.{gain, loss}  + flash.white, flash.red, flash.weaponEdge (screen / label flashes)
//   material.{cloth, skin, car, asphalt, coin, metal, glass, rubber}.{roughness, metalness}
export const PALETTE = deepFreeze({
  sky: {
    zenith: 0x182544, upper: 0x5B3A6E, horizon: 0xFF7A2F, glow: 0xFFC46B, sun: 0xFFF1C2,
    stops: { zenith: 1.0, upper: 0.45, horizon: 0.12, glow: 0.0 },      // dome gradient stops (y)
    sunAzimuthDeg: 35, sunElevationDeg: 9,                              // sun disc position
    fogMix: 0.15,                                                        // bottom 15 % mixed to the fog colour
  },
  fog: 0xD8744A,
  ground: 0x5A4634,
  shadowTint: 0x1E6C7A,                                                  // teal shadow tint (grade)
  road: {
    asphalt: 0x3B3B44, asphaltNoise: 0.06,                               // ±6 % noise
    crack: 0x24242B, patch: 0x45454E,
    dash: 0xE6CF72, dashM: 3, dashGapM: 3, dashWorn: 0.35,               // centre dashes 3 m / 3 m, 35 % worn
    edge: 0xD6D6CC, curb: 0x7A7570, shoulder: 0x6B5A48,
    tyre: 0x2A2A30, tyreOpacity: 0.3,
  },
  props: {
    barricade: 0x9A9A94, barricadeRed: 0xD43B2E, barricadeWhite: 0xF2F2EA,
    car: [0x7A2E2A, 0x2E5A7A, 0x6E6E6E, 0xA8893A], rust: 0x6B3A1E, glass: 0x1C2430, tyre: 0x1E1E1E,
    sandbag: [0xA08A5C, 0x7E6B45],
    building: 0x6B6058, window: 0x1C2430, windowLit: 0xFFB36B, windowLitFraction: 0.15, windowLitEmissive: 1.6,
    tree: 0x4A3A2E,
    smoke: [0x5A5A5A, 0x2A2A2A],
    dust: 0xFFD9A8, dustOpacity: 0.18,                                   // additive motes
    coin: 0xFFD23F, coinEmissive: 0xFFB02E, coinEmissiveIntensity: 0.4,  // metalness 0.9 / roughness 0.25 → material.coin
  },
  soldier: { uniform: 0x718046, webbing: 0x4A5230, helmet: 0x7C8C4A, skin: 0xE3B48E, rifle: 0x262626, boots: 0x3A2E22, backpack: 0x4E5633,
             accent: 0xD9B25A,                                           // extra (CHR-3): tan bedroll on the backpack — the squad must pop against the asphalt (GDD §1/§3.1)
             magnetGlow: 0xC77DFF },                                     // extra (CHR-2): magnet "helmet rings glow purple" (= GEAR.magnet.color; GDD §8.2)
  troop: {
    sniperCoat: 0x35475A, sniperLens: 0x7FE8FF,
    flamerSuit: 0x7A4A2A, flamerTank: 0xE07A2A, flame: 0xFFB347,
    medic: 0xF0F0EA, medicCross: 0xD83A3A,
    drone: 0x8A94A0, droneLed: 0x39E58C,
    apc: 0x4F5A3A, apcLight: 0xFFF1C2,
  },
  zombie: {
    walker:  { skin: 0x7FA36B, cloth: 0x4A4A52, eyes: 0xFFE14D },
    runner:  { skin: 0xA9B46E, cloth: 0x6B3F3F, eyes: 0xFFE14D },
    crawler: { skin: 0x6E8F5F, cloth: 0x3A3A40, eyes: 0xFFE14D },
    brute:   { skin: 0x5F7A52, cloth: 0x3A3A40, muscle: 0x9C3C3C, eyes: 0xFF7A1F },
    spitter: { skin: 0x8CA86B, cloth: 0x4A4A52, sacs: 0xC7E84B, eyes: 0xC7E84B },
    eyesEmissive: 1.5,
    burning: 0xFF8A2A,                                                   // flamer burn emissive tint (GDD §8.3 "orange emissive")
  },
  boss: {
    skin: 0x4F6B47, plates: 0x2F2F33, core: 0xFF4A1F, coreEmissive: 3, eyes: 0xFFE14D, eyesEmissive: 1.5,
    muscle: 0x6B3A2E,                                                    // extra (CHR-1): the Hulk's muscle tone (zombie.brute.muscle darkened for the boss)
    rage: 0xFF3B4E,                                                     // phase-3 rage glow
    shield: 0x7FE8FF,                                                    // Colossus shield / ring gauge
  },
  blood: 0x6E1A1A,
  crate: { body: 0x7E6B45, lid: 0x4E5633, seam: 0xFFB02E },             // = props.sandbag[1], soldier.backpack, ui.primary (pickups crate)
  gate: GATE_RULES.colors,                                               // mirror (same frozen object): plus/mult/minus/div/zero/item.{tint,frame}, max
  glyph: { fill: 0xFFFFFF, outline: 0x0B0F1A, emissive: 0.82 },         // round-2 QA GAT-7: linear white just under RENDER.bloom.threshold 0.85 — no bloom halo bleeds into the panel (≥ 3:1 glyph contrast); ACES still maps it near-white
  tracer: {                                                              // HDR linear triplets
    rifle: [2.6, 1.7, 0.6], shotgun: [3.0, 2.0, 1.0], minigun: [3.4, 2.6, 0.35], laser: [0.5, 2.6, 3.2], railgun: [2.0, 3.6, 4.0], sniper: [3.6, 1.2, 1.2],
    // rifle stays golden through ACES (J1 warm tracer), minigun yellow (= WEAPONS.minigun.tracer), laser cyan (= WEAPONS.laser.tracer, GDD §8.1)
    drone: [2.0, 3.6, 2.4],                                              // green-white, matches troop.droneLed
    chipTint: [1.5, 3.6, 4.0],                                           // fire-rate chip tints tracers cyan (= GEAR.chip.tracerTint)
  },
  fx: {
    spark: 0xFFF1B0,                                                     // J2 / J3 hit sparks
    muzzle: 0xFFE38A,                                                    // J1 muzzle flash
    gold: 0xFFD166,                                                      // J4 MAX sparks
    blue: 0x2E9BFF,                                                      // J5 flip sparks, armour plate shatter
    acid: 0x9BE84B,                                                      // J22 spit splash / green particles, spitter telegraph arc
    armor: 0x2E9BFF,                                                     // shoulder glint
    flame: 0xFFB347,
    smoke: 0x5A5A5A,
    dust: 0xC9B79A,                                                      // near-miss / crawler dust puffs
    white: 0xFFFFFF,
    laser: 0x4AF0FF, rail: 0x9FDCFF, rocket: 0xFF9A3C,                   // beam / bolt / explosion burst tints
    splash: 0x9BE84B,
    confetti: [0xFFB02E, 0x2E9BFF, 0x3BE57A, 0xFF3B4E, 0xC77DFF, 0xFFD23F],
  },
  ui: {
    bgPanel: 0x0F1626, bgPanelAlpha: 0.88,
    primary: 0xFFB02E, primaryText: 0x1A1200, primaryBorder: 0xB5741A,
    secondary: 0x2E9BFF, secondaryText: 0x06111F,
    danger: 0xFF3B4E, success: 0x3BE57A,
    text: 0xF4F1EA, textMuted: 0x9AA3B5,
    coin: 0xFFD23F,
    bossBar: 0xFF3B4E, bossTrack: 0x2A0F14, bossBarPhase2: 0xFFB02E, bossBarPhase3: 0xFF3B4E, bossBarShield: 0x6E7A8A,
    focus: 0x2E9BFF,
    logoGradient: [0xFFB02E, 0xFF7A2F],
    levelLocked: 0x2A3142, levelCurrent: 0xFFB02E,
    pauseDim: 0x080C16, pauseDimAlpha: 0.72,
    progressFill: 0x3BE57A,
    hintText: 0xF4F1EA,
    themeColor: 0x0F1626,
  },
  flash: {
    gain: 0x5CFF8A, loss: 0xFF4040,                                      // count label flashes (GDD §5)
    white: 0xFFFFFF,                                                     // boss phase / death, red-gate flip, rail
    red: 0xFF3B4E,                                                       // negative pass vignette, chew pulse
    weaponEdge: 0xFFB02E,                                                // default screen-edge glow (weapons override with WEAPONS[k].color)
  },
  material: {                                                            // GDD §15 "Materials"
    cloth: { roughness: 0.85, metalness: 0.0 },
    skin: { roughness: 0.8, metalness: 0.0 },
    car: { roughness: 0.55, metalness: 0.4 },
    asphalt: { roughness: 0.92, metalness: 0.0 },
    coin: { roughness: 0.25, metalness: 0.9 },
    metal: { roughness: 0.5, metalness: 0.6 },
    glass: { roughness: 0.2, metalness: 0.1 },
    rubber: { roughness: 0.95, metalness: 0.0 },
  },
});

// ==== DISTRICTS ==============================================================================
// Round 5 (art direction, then the round-5 tech-art / UX review): six visual districts, five campaign levels each
// (cycling past L30), rotating every three chunks in endless. Spec, readability maths and module contracts:
// docs/DISTRICTS.md (ARCHITECTURE §8.10).
//   • DISTRICTS[0] (SUNSET BOULEVARD, L1–5) IS the shipped look: every value is read from WORLD / RENDER / PALETTE
//     (the sky-shader literals that become uniforms — disc edge 0.9995 / 0.9998, skyline threshold 0.965 — and the
//     roof-snow colour, unused at amount 0, carry literal values), so L1–5 cannot drift.
//   • Every district has the same key tree as DISTRICTS[0] (render.setDistrict lerps them key by key).
//   • Colours are sRGB hex (Color.setHex); `gain` / `*Emissive` / `intensity` values are linear multipliers.
//   • Fixed across districts on purpose (docs/DISTRICTS.md §1, §4): bloom.threshold (= RENDER.bloom.threshold: the glyph
//     emissive 0.82 sits just under it, GAT-7), grade.saturation ≥ 1.12 (gate hues are a type cue), fog.near ≥ 38
//     (the 36 px gate at z = −26 stays unfogged), fog.farScale 0.95–1.05, the gate colours themselves (GATE_RULES.colors).
//   • sun.offset is a direction AND a distance (docs/DISTRICTS.md §6.1 shadow box): its azimuth stays within ±31° of −z
//     and its length keeps the shadow camera's near plane behind z = −23 m, so shadows reach as far ahead as in District 1.
//   • weather never outshines the value glyph (docs/DISTRICTS.md §2 weather rule): luma(lin(color))·gain ≤ 0.5 on 'normal'
//     blending, luma·gain·opacity ≤ 0.26 on 'add'; embers are the one HDR weather on purpose.
//   • props: the 8 environment prop slots (one InstancedMesh each, material fixed per slot) → the kind each slot shows in
//     this district (a DISTRICT_PROPS key whose `slot` matches) + weight (count / presence multiplier, 0–1; the building
//     slot's weight is its near-row presence multiplier, ≤ 1.25, presence clamped to 1) + optional `tint` (linear × on the
//     per-instance colour) and `layout` overrides (merged over the kind's layout; building `far` = far-row presence
//     multiplier, default 1).
//   • lamps: `layout` ('mixed' = RENDER.env.layout.lamp presence / broken; 'all' = every lamp present and upright at every
//     density) and `lit` ('mixed' = the seeded lit share; 'all' = every upright lamp lit; 'none' = none lit) apply to the
//     `lamppost` kind only; road light pools need layout 'all' here AND in every district that rotates into this one
//     with the lamppost kind unchanged (docs/DISTRICTS.md §3.3).
const DISTRICT_SLOTS = ['barricade', 'sandbags', 'car', 'building', 'tree', 'rubble', 'lamppost', 'smoke'];

/** Prop kinds the districts map onto the 8 slots. `builtin` kinds are environment.js's own geometries and
 *  RENDER.env.layout placements (unchanged); the others are models.js geometries (`geo.<kind>`, docs/DISTRICTS.md §7:
 *  feet at y = 0, position / normal / uv / color (linear, itemSize 3), no uv1 / tangent / morph; colour components > 1
 *  encode emissive radiance on the emissive slots — barricade and lamppost — gated per instance by iEmit). `per` =
 *  instances per 30 m segment (the slot's capacity = 6 × the largest `per` of its kinds); `placer` names the
 *  environment placement routine; `layout` its parameters (x = |x| band of the instance centre from the road centre
 *  line, m; a key the kind leaves out takes the placer default of docs/DISTRICTS.md §7.2, NEVER the RENDER.env.layout
 *  value of the built-in kind). Non-builtin kinds also carry:
 *    half       [hx, hz] half extents in local x / z (m, before scale); the placer keeps |x| ≥ DISTRICT_RULES.edgeClearX +
 *               the instance's half extent across the road (random-yaw kinds: max(hx, hz) × scale), so no new prop or
 *               glow ever reaches the curb or the lanes;
 *    poseY      cars placer only: [y on its roof, y on its side] (m) for the flipped / onSide poses (the built-in car's 1.37 / 0.9);
 *    smokeY     base height (m, × instance y scale) of a smoke column anchored to this kind (DISTRICTS[i].smoke.anchor);
 *    castShadow false = the slot mesh casts no shadow while this kind is shown (default true). */
export const DISTRICT_PROPS = deepFreeze({
  // ---- built-in (Sunset Boulevard) ----
  barricade:  { slot: 'barricade', builtin: true, per: 8, placer: 'chain' },
  sandbags:   { slot: 'sandbags',  builtin: true, per: 5, placer: 'scatter' },
  car:        { slot: 'car',       builtin: true, per: 4, placer: 'cars' },
  building:   { slot: 'building',  builtin: true, per: 5, placer: 'buildings' },
  tree:       { slot: 'tree',      builtin: true, per: 6, placer: 'scatter' },
  rubble:     { slot: 'rubble',    builtin: true, per: 8, placer: 'scatter' },
  lamppost:   { slot: 'lamppost',  builtin: true, per: 4, placer: 'lamps' },
  smoke:      { slot: 'smoke',     builtin: true, per: 2, placer: 'smoke' },
  // ---- Overcast Highway ----
  barrier:    { slot: 'barricade', per: 6, tris: 220, placer: 'chain', half: [1.5, 0.3],
                layout: { x: [4.9, 5.5], chain: 3.05, maxChain: 4, yaw: 'along', jitter: 0.1, diagonal: 0, toppled: 0.05, emitOn: 0 },
                colors: { concrete: 0xA4A39C, stripe: 0xE8E4D8, stain: 0x6E6A62, reflector: 0xFFB02E }, emissive: 1.4 },
  cones:      { slot: 'sandbags', per: 5, tris: 300, placer: 'scatter', half: [0.8, 0.8],
                layout: { x: [5.4, 6.8], yaw: 'random', scale: [0.9, 1.15] },
                colors: { cone: 0xF06A2A, band: 0xF2F2EA, base: 0x2A2A30, drum: 0xE8662A } },
  billboard:  { slot: 'tree', per: 1, tris: 190, placer: 'scatter', half: [3.4, 0.6],
                layout: { x: [10, 14], yaw: 'face', jitter: 0.35, scale: [0.9, 1.1], chance: 0.6 },
                colors: { post: 0x5A5A5E, frame: 0x3A3A3E, panel: [0xC8B48A, 0x8AA4B4, 0xB4786A], faded: 0xD8D2C4 } },
  truck:      { slot: 'rubble', per: 1, tris: 420, placer: 'cars', half: [1.25, 4.4], poseY: [3.2, 1.25],
                layout: { x: [8.2, 11.0], cross: 0.15, flipped: 0.05, onSide: 0.35, yawJitter: 0.5, burnt: 0, dark: [0.75, 1.0], chance: 0.7 },
                colors: { paint: [0xD8D4CC, 0x9AA6B0, 0xB04A3A, 0xC8C2B4], chassis: 0x2A2A2E, glass: 0x1C2430, tyre: 0x1E1E1E, rust: 0x6B3A1E } },   // paint: one per instance (cab + box, the cars rule)
  // ---- Night City ----
  neon:       { slot: 'barricade', per: 3, tris: 160, placer: 'chain', half: [0.6, 0.1],
                layout: { x: [8.8, 10.2], chain: 1.0, maxChain: 1, yaw: 'face', jitter: 0.4, diagonal: 0, toppled: 0, emitOn: 0.92 },
                colors: { box: 0x26262E, pole: 0x3A3A40, tubes: [0xFF4FD8, 0x46F2FF, 0xFFB347] }, emissive: 2.6 },
  // ---- Toxic Industrial ----
  barrel:     { slot: 'barricade', per: 6, tris: 380, placer: 'chain', half: [0.9, 0.9],
                layout: { x: [5.4, 7.4], chain: 1.4, maxChain: 2, yaw: 'random', jitter: 0, diagonal: 0, toppled: 0, emitOn: 0.7 },
                colors: { drum: [0xC8A020, 0x2E5A8A, 0x8A3A2A], band: 0x2A2A2A, hazard: 0xE8C020, ooze: 0xA8FF3A }, emissive: 2.2 },
  container:  { slot: 'sandbags', per: 2, tris: 140, placer: 'scatter', half: [3.03, 1.22],
                layout: { x: [8.0, 12.5], yaw: 'along', jitter: 0.25, scale: [1, 1] },
                colors: { paint: [0x8A4A2A, 0x2E6A6A, 0x707070, 0xA88A3A], rib: 0x2A2A2E, door: 0x4A4A4E } },   // paint: one per instance
  smokestack: { slot: 'tree', per: 1, tris: 260, placer: 'scatter', half: [1.4, 1.4], smokeY: 20.5, castShadow: false,
                layout: { x: [15, 26], yaw: 'random', scale: [0.85, 1.25], chance: 0.75 },
                colors: { brick: 0x6A3A2A, band: [0xE8E4D8, 0xB83A2E], cap: 0x2A2624, ladder: 0x4A4A4E } },
  pipe:       { slot: 'rubble', per: 3, tris: 300, placer: 'chain', half: [3.0, 0.5],
                layout: { x: [6.4, 7.6], chain: 6.0, maxChain: 3, yaw: 'along', jitter: 0.04, diagonal: 0, toppled: 0, emitOn: 0 },
                colors: { pipe: [0x8A8A70, 0xB0A040], support: 0x4A4A4E, rust: 0x6B3A1E, valve: 0xB83A2E } },
  puddle:     { slot: 'lamppost', per: 4, tris: 60, placer: 'scatter', half: [0.8, 0.6], castShadow: false,
                layout: { x: [5.6, 8.0], yaw: 'random', scale: [0.8, 1.3], emitOn: 1 },
                colors: { rim: 0x3A3C24, ooze: 0xA8FF3A }, emissive: 1.8 },
  // ---- Ash Wasteland ----
  burningWreck: { slot: 'barricade', per: 2, tris: 420, placer: 'cars', half: [0.9, 2.1], poseY: [1.3, 0.9], smokeY: 0.4,
                layout: { x: [6.6, 9.6], cross: 0.2, flipped: 0.15, onSide: 0.1, yawJitter: 0.9, burnt: 0, dark: [1, 1], emitOn: 1 },
                colors: { char: 0x2A2422, rust: 0x5A2E1A, glass: 0x141414, ember: 0xFF6A1A }, emissive: 2.8 },
  dune:       { slot: 'sandbags', per: 3, tris: 120, placer: 'scatter', half: [4.0, 2.2],
                layout: { x: [8.5, 15], yaw: 'along', jitter: 0.6, scale: [0.8, 1.6], squash: [0.7, 1.2] },
                colors: { sand: 0x8A6A44, crest: 0xA88458, ash: 0x4A403A } },
  rock:       { slot: 'rubble', per: 6, tris: 140, placer: 'scatter', half: [1.0, 1.0],
                layout: { x: [6.0, 14], bias: 'shoulder', yaw: 'random', scale: [0.6, 1.6], squash: [0.6, 1.1] },
                colors: { rock: [0x6A5E54, 0x7A6E62, 0x54504C] } },
  // ---- Frozen Outskirts ----
  snowbank:   { slot: 'sandbags', per: 4, tris: 100, placer: 'scatter', half: [2.25, 0.8],
                layout: { x: [5.9, 7.4], yaw: 'along', jitter: 0.15, scale: [0.9, 1.4] },
                colors: { snow: 0xE4ECF4, shade: 0xB8C6D4, dirt: 0x6E7884 } },
  frozenCar:  { slot: 'car', per: 4, tris: 560, placer: 'cars', half: [0.9, 2.1], poseY: [1.52, 0.9],
                layout: { x: [6.7, 9.8], cross: 0.15, flipped: 0.05, onSide: 0.04, yawJitter: 0.9, burnt: 0, dark: [0.72, 1.0], frost: 0.6 },
                colors: { snow: 0xF0F4F8, ice: 0xB8D0E0, frost: 0xE4ECF4 } },
  pine:       { slot: 'tree', per: 10, tris: 200, placer: 'scatter', half: [1.6, 1.6],
                layout: { x: [7.8, 16], yaw: 'random', lean: 0.05, scale: [0.8, 1.5] },
                colors: { trunk: 0x4A3A2E, needles: [0x2E4A3A, 0x3A5444], snow: 0xEEF4F8 } },
});

/** Rotation, fade, swap and banner rules (docs/DISTRICTS.md §3, §5, §7.2). */
export const DISTRICT_RULES = deepFreeze({
  slots: DISTRICT_SLOTS,
  levelsPerDistrict: 5,            // L1–5 → 1, L6–10 → 2 … L26–30 → 6; L31+ cycles (L31 → 1)
  endlessChunksPerDistrict: 3,     // endless chunks 1–3 → 1, 4–6 → 2 … 16–18 → 6, 19 → 1 …
  fadeSeconds: 4,                  // endless cross-fade (lights, fog, sky, materials); 0 = snap (level start, title)
  fadeGateClearZ: -26,             // an endless rotation waits until no live gate event is at z < this (spawn → 36 px point) …
  fadeDeferMaxM: 150,              // … (and for the next gate and a live mini-boss, §3.2) but never more than this many metres past the boundary
  fadeNextGateFrac: 0.8,           // … and until the next gate event is ≥ this × fadeSeconds × roadSpeed ahead (spawns at eased fade ≥ 0.968)
  swapDip: [0.45, 0.55],           // fade fraction where the weather AND the skyline silhouette are at zero and swap theme / columns
  hiddenBeyondZ: -100,             // segments whose near edge is beyond this are fully fogged (prop refill re-places them)
  edgeClearX: 4.5,                 // m: no non-builtin prop footprint (or its glow) comes nearer the road centre line (curb outer edge 4.3)
  // wet-road puddles reflect the sky horizon colour × this × Schlick fresnel × the puddle mask (0 = the spec's sun sheen
  // only; inert where road.puddles is 0). Round-5 integration: 0.5 → 0.3 — at 0.5 the grazing-angle reflection behind the
  // 36 px gates lifted the road beside them (bluish-grey) until Overcast's item panel and Toxic's × panel fell under the
  // §4.3 floor of 15 ΔE00 (DISTRICTS.md §13); 0.3 keeps the puddles reading as wet patches, not black potholes
  puddleReflect: 0.3,
  // round-5 art review (docs/build/r5-art.md): near the camera the steep-view fresnel (≈ 0.02–0.05) left the smooth puddles
  // as black holes ringed by a bright crescent; the reflection factor is at least puddleReflectFloor up to
  // puddleFloorFadeM[0] m of view distance, fading out by [1] (the road beside the 36 px gate is 37 m away and keeps the
  // integration's readability numbers). A puddle inside a light pool (Night City) adds pool radiance × poolPuddleGlint on top
  // of the lit asphalt: the wet road mirrors the streetlight. All inert where road.puddles is 0
  puddleReflectFloor: 0.3,
  puddleFloorFadeM: [18, 35],
  poolPuddleGlint: 0.12,
  banner: { seconds: 1.6, inSeconds: 0.22, outSeconds: 0.3, risePx: 6 },
});

const SKY_ENV = RENDER.env.sky;
const DIST_SUNSET = {
  id: 'sunset', index: 1, name: 'SUNSET BOULEVARD', label: 'DISTRICT 1 · SUNSET BOULEVARD', levels: [1, 5], accent: PALETTE.ui.primary,
  sky: {
    zenith: PALETTE.sky.zenith, upper: PALETTE.sky.upper, horizon: PALETTE.sky.horizon, glow: PALETTE.sky.glow,
    stops: [PALETTE.sky.stops.zenith, PALETTE.sky.stops.upper, PALETTE.sky.stops.horizon, PALETTE.sky.stops.glow], fogMix: PALETTE.sky.fogMix,
    disc: { color: PALETTE.sky.sun, azimuthDeg: PALETTE.sky.sunAzimuthDeg, elevationDeg: PALETTE.sky.sunElevationDeg,
            edge: [0.9995, 0.9998],                              // the SKY_FRAG smoothstep literals (disc outer / inner cos)
            boost: SKY_ENV.discBoost, haloWide: SKY_ENV.haloWide, haloTight: SKY_ENV.haloTight, mottle: 0 },
    horizonWarm: SKY_ENV.horizonWarm, awayDarken: SKY_ENV.awayDarken,
    cloud: { opacity: SKY_ENV.cirrus, cover: 0, drift: SKY_ENV.cirrusDrift },
    stars: { density: 0, gain: 0 },
    skyline: { mix: SKY_ENV.skylineMix, dark: SKY_ENV.skylineDark, cols: SKY_ENV.skylineCols, lit: SKY_ENV.skylineLit,
               litDensity: 0.035, litColor: PALETTE.props.windowLit },  // 0.035 = the SKY_FRAG step(0.965, …) literal
  },
  fog: { color: RENDER.fogColor, near: WORLD.fog.near, farScale: 1, runupNear: WORLD.fog.runupNear },
  sun: { color: RENDER.sun.color, intensity: RENDER.sun.intensity, offset: RENDER.sun.offset, titleAzimuthDeg: RENDER.title.sunAzimuthDeg },
  hemi: { sky: RENDER.hemi.sky, ground: RENDER.hemi.ground, intensity: RENDER.hemi.intensity, title: RENDER.title.hemi },
  exposure: RENDER.exposure,
  bloom: { strength: RENDER.bloom.strength, radius: RENDER.bloom.radius, threshold: RENDER.bloom.threshold },
  grade: RENDER.grade,
  road: { asphalt: PALETTE.road.asphalt, dash: PALETTE.road.dash, edge: PALETTE.road.edge, curb: PALETTE.road.curb,
          roughness: PALETTE.material.asphalt.roughness, puddles: 0, puddleRoughness: 0.18, pools: null },
  ground: { ground: PALETTE.ground, shoulder: PALETTE.road.shoulder, grass: RENDER.env.ground.grass },
  building: { color: PALETTE.props.building, roofSnow: 0, snowColor: 0xEEF4F8, litFraction: PALETTE.props.windowLitFraction,
              windowColor: PALETTE.props.windowLit, windowEmissive: PALETTE.props.windowLitEmissive, darkFraction: RENDER.env.darkBuildingFraction,
              bounce: RENDER.env.buildingBounce },
  props: {
    barricade: { kind: 'barricade', weight: 1 }, sandbags: { kind: 'sandbags', weight: 1 }, car: { kind: 'car', weight: 1 },
    building: { kind: 'building', weight: 1 }, tree: { kind: 'tree', weight: 1 }, rubble: { kind: 'rubble', weight: 1 },
    lamppost: { kind: 'lamppost', weight: 1 }, smoke: { kind: 'smoke', weight: 1 },
  },
  lamps: { layout: 'mixed', lit: 'mixed', gain: 1 },              // mixed / mixed = RENDER.env.layout.lamp present / broken / dark
  beacon: { gain: 1, blinkRate: RENDER.env.lights.blinkRate, blinkDuty: RENDER.env.lights.blinkDuty },
  smoke: { bottom: PALETTE.props.smoke[0], top: PALETTE.props.smoke[1], emberColor: PALETTE.fx.flame, ember: RENDER.env.smokeColumn.ember,
           alpha: RENDER.env.smokeColumn.alpha, glowBounce: RENDER.env.smokeColumn.glowBounce, chance: RENDER.env.layout.smoke.chance,
           anchor: null, w: RENDER.env.layout.smoke.w, h: RENDER.env.layout.smoke.h },
  weather: { kind: 'dust', color: PALETTE.props.dust, gain: 1, opacity: PALETTE.props.dustOpacity, blend: 'add', density: 1,
             size: RENDER.env.dust.size, drift: RENDER.env.dust.speed, fall: 0, sway: 1, streak: 0, slant: 0, flicker: 1, box: RENDER.env.dust.box },
  zombie: { eyesEmissive: PALETTE.zombie.eyesEmissive },
};

export const DISTRICTS = deepFreeze([
  DIST_SUNSET,
  {
    id: 'overcast', index: 2, name: 'OVERCAST HIGHWAY', label: 'DISTRICT 2 · OVERCAST HIGHWAY', levels: [6, 10], accent: 0x9FB8CC,
    sky: {
      zenith: 0x3C4A58, upper: 0x6A7A8A, horizon: 0x93A2AE, glow: 0x8C9A9E, stops: [1.0, 0.5, 0.14, 0.0], fogMix: 0.17,
      disc: { color: 0xF2F5F8, azimuthDeg: 20, elevationDeg: 26, edge: [0.9985, 0.9995], boost: 0.35, haloWide: 0.3, haloTight: 0.12, mottle: 0 },
      horizonWarm: 0.08, awayDarken: 0.94, cloud: { opacity: 0.85, cover: 0.3, drift: [0.012, 0.004] }, stars: { density: 0, gain: 0 },
      skyline: { mix: 0.5, dark: 0.85, cols: 30, lit: 0, litDensity: 0, litColor: 0xFFE0B0 },
    },
    fog: { color: 0x56625E, near: 38, farScale: 0.95, runupNear: 31 },
    sun: { color: 0xE6ECF2, intensity: 1.5, offset: [4, 16, -10], titleAzimuthDeg: 175 },   // 56° high: render rescales the shadow box bottom (§6.1)
    hemi: { sky: 0xA9B8C6, ground: 0x3E4246, intensity: 1.5, title: 2.6 },
    exposure: 1.1,
    bloom: { strength: 0.5, radius: 0.4, threshold: RENDER.bloom.threshold },
    grade: { shadowTint: 0x24485A, shadowMix: 0.06, shadowLuma: 0.3, highlightTint: 0xE4ECF4, highlightMix: 0.05, highlightLuma: 0.7, saturation: 1.12, vignette: { strength: 0.32, a: 0.5, b: 1.4 } },
    // puddles 0.35 → 0.2: DISTRICTS.md §4.4 fallback step 1 for Overcast (round-5 integration full-dressing pass, §13)
    road: { asphalt: 0x32322F, dash: 0xD9C66C, edge: 0xC8CCCC, curb: 0x6C6E70, roughness: 0.55, puddles: 0.2, puddleRoughness: 0.32, pools: null },
    ground: { ground: 0x43483F, shoulder: 0x50544E, grass: 0x4E5A3E },
    building: { color: 0x6A6C6E, roofSnow: 0, snowColor: 0xEEF4F8, litFraction: 0.04, windowColor: 0xFFE0B0, windowEmissive: 1.2, darkFraction: 0.4, bounce: 0.35 },
    props: {
      barricade: { kind: 'barrier', weight: 1 }, sandbags: { kind: 'cones', weight: 0.8 },
      car: { kind: 'car', weight: 1, layout: { burnt: 0.15 } },
      building: { kind: 'building', weight: 0.15, layout: { far: 0.58 } },                 // highway: few near blocks (High 15 %), far row 0.35
      tree: { kind: 'billboard', weight: 1 }, rubble: { kind: 'truck', weight: 1 },
      lamppost: { kind: 'lamppost', weight: 1 }, smoke: { kind: 'smoke', weight: 1 },
    },
    lamps: { layout: 'all', lit: 'none', gain: 1 },                 // intact highway lamps, unlit at midday (2 → 3 lights them, §3.3)
    beacon: { gain: 1, blinkRate: 0, blinkDuty: [-3, -2] },
    smoke: { bottom: 0x6A6E72, top: 0x3A3E42, emberColor: PALETTE.fx.flame, ember: 1.2, alpha: 0.75, glowBounce: 0.05, chance: 0.2, anchor: null, w: [5.5, 9.5], h: [16, 28] },
    // streaks 0.22 m (fill ≈ 18 % of a Medium frame, 0.35 m was 45 %), slanted 0.2 rad and dim so none reads as a "1" beside a value glyph
    weather: { kind: 'rain', color: 0xC8D4E0, gain: 1, opacity: 0.22, blend: 'add', density: 1, size: 0.22, drift: 0.6, fall: -9, sway: 0.05, streak: 0.06, slant: 0.2, flicker: 0.2, box: [12, 6, 28] },
    zombie: { eyesEmissive: 1.5 },
  },
  {
    id: 'night', index: 3, name: 'NIGHT CITY', label: 'DISTRICT 3 · NIGHT CITY', levels: [11, 15], accent: 0xFF4FD8,
    sky: {
      zenith: 0x03050E, upper: 0x0A1230, horizon: 0x1A2450, glow: 0x2E3460, stops: [1.0, 0.4, 0.1, 0.0], fogMix: 0.15,
      // moon above the portrait gameplay view (top edge +8.7°; it peeked out behind the pause button at −12° / 8°), title centre-right
      disc: { color: 0xDCE6FF, azimuthDeg: 3, elevationDeg: 11, edge: [0.9993, 0.99965], boost: 1.4, haloWide: 0.1, haloTight: 0.22, mottle: 0.35 },
      horizonWarm: 0.15, awayDarken: 0.8, cloud: { opacity: 0.15, cover: 0, drift: [0.004, 0.001] }, stars: { density: 0.012, gain: 0.7 },
      skyline: { mix: 0.12, dark: 0.55, cols: 52, lit: 1.6, litDensity: 0.12, litColor: 0xFFC27A },
    },
    fog: { color: 0x1F2237, near: 40, farScale: 1.04, runupNear: 32 },
    sun: { color: 0xB4C2E8, intensity: 2.4, offset: [-7, 14, -12], titleAzimuthDeg: 175 },   // azimuth −30° (−42° lost the road from the shadow box at z −21)
    hemi: { sky: 0x6A6A78, ground: 0x24242A, intensity: 1.9, title: 3.0 },
    exposure: 1.2,
    bloom: { strength: 0.7, radius: 0.45, threshold: RENDER.bloom.threshold },
    grade: { shadowTint: 0x14286A, shadowMix: 0.1, shadowLuma: 0.3, highlightTint: 0xFFB070, highlightMix: 0.12, highlightLuma: 0.7, saturation: 1.15, vignette: { strength: 0.42, a: 0.5, b: 1.4 } },
    road: { asphalt: 0x363432, dash: 0xD9C46A, edge: 0xC8C8C0, curb: 0x5E5C5A, roughness: 0.6, puddles: 0.25, puddleRoughness: 0.32,
            pools: { color: PALETTE.props.windowLit, intensity: 2.4, radius: [2.6, 3.8] } },
    ground: { ground: 0x24221E, shoulder: 0x302C26, grass: 0x2A2C22 },
    building: { color: 0x4E5060, roofSnow: 0, snowColor: 0xEEF4F8, litFraction: 0.5, windowColor: PALETTE.props.windowLit, windowEmissive: 2.0, darkFraction: 0.1, bounce: 0.35 },
    props: {
      barricade: { kind: 'neon', weight: 1 }, sandbags: { kind: 'sandbags', weight: 0.6 }, car: { kind: 'car', weight: 1 },
      building: { kind: 'building', weight: 1.15, layout: { far: 1.17 } },                  // dense: Medium near 0.96, High far 0.7
      tree: { kind: 'tree', weight: 0.4 }, rubble: { kind: 'rubble', weight: 0.8 },
      lamppost: { kind: 'lamppost', weight: 1 }, smoke: { kind: 'smoke', weight: 1 },
    },
    lamps: { layout: 'all', lit: 'all', gain: 1.35 },
    beacon: { gain: 1, blinkRate: 1.9, blinkDuty: [-0.98, -0.9] },
    smoke: { bottom: 0x2A2C34, top: 0x15161C, emberColor: PALETTE.fx.flame, ember: 3.0, alpha: 0.85, glowBounce: 0.04, chance: 0.25, anchor: null, w: [5.5, 9.5], h: [16, 28] },
    // ash is unlit: gain 0.35 (linear 0.16) — at gain 1 it was 35 × the lit road, glowing grey specks over the glyph plates
    weather: { kind: 'ash', color: 0xB8B4B0, gain: 0.35, opacity: 0.45, blend: 'normal', density: 0.6, size: 0.055, drift: 0.25, fall: -0.45, sway: 0.7, streak: 0, slant: 0, flicker: 0.3, box: [12, 6, 40] },
    zombie: { eyesEmissive: 2.6 },
  },
  {
    id: 'toxic', index: 4, name: 'TOXIC INDUSTRIAL', label: 'DISTRICT 4 · TOXIC INDUSTRIAL', levels: [16, 20], accent: 0xB8E83A,
    sky: {
      zenith: 0x1E2614, upper: 0x4A5428, horizon: 0xA8AC48, glow: 0xC8C878, stops: [1.0, 0.45, 0.12, 0.0], fogMix: 0.18,
      disc: { color: 0xF4F0B0, azimuthDeg: 30, elevationDeg: 10, edge: [0.9992, 0.9997], boost: 1.0, haloWide: 0.3, haloTight: 0.25, mottle: 0 },
      horizonWarm: 0.35, awayDarken: 0.78, cloud: { opacity: 0.3, cover: 0.1, drift: [0.008, 0.003] }, stars: { density: 0, gain: 0 },
      skyline: { mix: 0.55, dark: 0.75, cols: 36, lit: 0.4, litDensity: 0.02, litColor: 0xC8F0A0 },
    },
    fog: { color: 0x6E6A2E, near: 38, farScale: 0.95, runupNear: 31 },
    sun: { color: 0xF4E8A0, intensity: 2.4, offset: [7, 12, -14], titleAzimuthDeg: 175 },
    hemi: { sky: 0xA8A490, ground: 0x3C3A2C, intensity: 1.35, title: 2.7 },
    exposure: 1.1,
    bloom: { strength: 0.7, radius: 0.45, threshold: RENDER.bloom.threshold },
    grade: { shadowTint: 0x1C4628, shadowMix: 0.1, shadowLuma: 0.3, highlightTint: 0xE6F07C, highlightMix: 0.08, highlightLuma: 0.7, saturation: 1.12, vignette: { strength: 0.4, a: 0.5, b: 1.4 } },
    road: { asphalt: 0x2E3036, dash: 0xD8C860, edge: 0xC8CCB0, curb: 0x6A6A5E, roughness: 0.85, puddles: 0.12, puddleRoughness: 0.32, pools: null },
    ground: { ground: 0x45422C, shoulder: 0x524E34, grass: 0x6A6834 },
    building: { color: 0x5C5E52, roofSnow: 0, snowColor: 0xEEF4F8, litFraction: 0.08, windowColor: 0xD4F0B8, windowEmissive: 1.4, darkFraction: 0.35, bounce: 0.4 },
    props: {
      barricade: { kind: 'barrel', weight: 1 }, sandbags: { kind: 'container', weight: 1 },
      car: { kind: 'car', weight: 0.6, layout: { burnt: 0.4 } },
      building: { kind: 'building', weight: 0.6, layout: { storeys: [2, 4], farStoreys: [4, 7] } },
      tree: { kind: 'smokestack', weight: 1 }, rubble: { kind: 'pipe', weight: 1 },
      lamppost: { kind: 'puddle', weight: 1 }, smoke: { kind: 'smoke', weight: 1 },
    },
    lamps: { layout: 'mixed', lit: 'none', gain: 1 },               // inert here (the lamppost slot shows puddles); a 3 → 4 fade switches Night's lamps off
    beacon: { gain: 1, blinkRate: 1.4, blinkDuty: [-1.6, 1.0] },
    smoke: { bottom: 0x6E7058, top: 0x3A3C2C, emberColor: 0xC8FF5A, ember: 1.5, alpha: 0.8, glowBounce: 0.1, chance: 1, anchor: 'tree', w: [4, 6], h: [12, 20] },
    // pale khaki spores: chartreuse motes drifting over the road read as the spitter's acid (PALETTE.fx.acid #9BE84B: globs, arc telegraph)
    weather: { kind: 'spores', color: 0xCFCBA0, gain: 1, opacity: 0.32, blend: 'add', density: 0.7, size: 0.05, drift: 0.2, fall: -0.12, sway: 0.9, streak: 0, slant: 0, flicker: 0.6, box: [12, 6, 40] },
    zombie: { eyesEmissive: 1.8 },
  },
  {
    id: 'ash', index: 5, name: 'ASH WASTELAND', label: 'DISTRICT 5 · ASH WASTELAND', levels: [21, 25], accent: 0xFF5A2A,
    sky: {
      zenith: 0x140606, upper: 0x3A0E0C, horizon: 0xA8281E, glow: 0xD85A2A, stops: [1.0, 0.45, 0.12, 0.0], fogMix: 0.16,
      disc: { color: 0xFF9A70, azimuthDeg: 6, elevationDeg: 3, edge: [0.9993, 0.99975], boost: 1.2, haloWide: 0.22, haloTight: 0.3, mottle: 0 },
      horizonWarm: 0.55, awayDarken: 0.7, cloud: { opacity: 0.35, cover: 0.05, drift: [0.01, 0.003] }, stars: { density: 0, gain: 0 },
      skyline: { mix: 0.25, dark: 0.8, cols: 34, lit: 0.6, litDensity: 0.02, litColor: 0xFF6A2A },
    },
    fog: { color: 0x4A403C, near: 38, farScale: 0.95, runupNear: 31 },
    sun: { color: 0xFFC0A0, intensity: 2.4, offset: [6.5, 10.5, -21], titleAzimuthDeg: 175 },   // the [5, 8, −16] direction, 24.4 m away: the near plane cut the road at z −20
    hemi: { sky: 0x8A8E90, ground: 0x2E2420, intensity: 1.6, title: 3.0 },
    exposure: 1.1,
    bloom: { strength: 0.65, radius: 0.5, threshold: RENDER.bloom.threshold },
    grade: { shadowTint: 0x3A1410, shadowMix: 0.12, shadowLuma: 0.3, highlightTint: 0xFF9050, highlightMix: 0.12, highlightLuma: 0.7, saturation: 1.12, vignette: { strength: 0.45, a: 0.5, b: 1.4 } },
    road: { asphalt: 0x2E3032, dash: 0xCDAE62, edge: 0xBFB3A0, curb: 0x6E6660, roughness: 0.95, puddles: 0, puddleRoughness: 0.18, pools: null },
    ground: { ground: 0x5A524C, shoulder: 0x6A5A48, grass: 0x2A2624 },
    building: { color: 0x3C3430, roofSnow: 0, snowColor: 0xEEF4F8, litFraction: 0.05, windowColor: 0xFF7A2A, windowEmissive: 2.2, darkFraction: 0.5, bounce: 0.4 },
    props: {
      barricade: { kind: 'burningWreck', weight: 1 }, sandbags: { kind: 'dune', weight: 1 },
      car: { kind: 'car', weight: 0.7, layout: { burnt: 1 } },
      building: { kind: 'building', weight: 0.35, layout: { storeys: [1, 3], far: 0.25 } },
      tree: { kind: 'tree', weight: 0.7, tint: [0.22, 0.2, 0.19] }, rubble: { kind: 'rock', weight: 1 },
      lamppost: { kind: 'lamppost', weight: 1, layout: { broken: 0.5 } }, smoke: { kind: 'smoke', weight: 1 },
    },
    lamps: { layout: 'mixed', lit: 'none', gain: 1 },
    beacon: { gain: 1, blinkRate: 9, blinkDuty: [-1.4, 0.8] },
    smoke: { bottom: 0x2E2622, top: 0x121010, emberColor: 0xFF8A2A, ember: 3.4, alpha: 0.95, glowBounce: 0.15, chance: 0.85, anchor: 'barricade', w: [3.5, 5.5], h: [10, 18] },
    weather: { kind: 'embers', color: 0xFF8A3A, gain: 2.8, opacity: 0.9, blend: 'add', density: 0.75, size: 0.045, drift: 0.35, fall: 0.7, sway: 0.5, streak: 0, slant: 0, flicker: 1, box: [12, 6, 40] },
    zombie: { eyesEmissive: 2.0 },
  },
  {
    id: 'frozen', index: 6, name: 'FROZEN OUTSKIRTS', label: 'DISTRICT 6 · FROZEN OUTSKIRTS', levels: [26, 30], accent: 0xBFE6FF,
    sky: {
      zenith: 0x5C7EA4, upper: 0x9CB6D0, horizon: 0xD4E2EE, glow: 0xE8F0F6, stops: [1.0, 0.45, 0.12, 0.0], fogMix: 0.16,
      disc: { color: 0xFFFFFF, azimuthDeg: 30, elevationDeg: 8, edge: [0.9993, 0.9997], boost: 1.6, haloWide: 0.25, haloTight: 0.45, mottle: 0 },
      horizonWarm: 0.08, awayDarken: 0.92, cloud: { opacity: 0.35, cover: 0.1, drift: [0.006, 0.002] }, stars: { density: 0, gain: 0 },
      skyline: { mix: 0.6, dark: 0.7, cols: 28, lit: 0.25, litDensity: 0.015, litColor: 0xFFD8A0 },
    },
    fog: { color: 0x909A98, near: 38, farScale: 0.95, runupNear: 31 },
    sun: { color: 0xEEF4FF, intensity: 2.0, offset: [8, 10, -14], titleAzimuthDeg: 175 },
    hemi: { sky: 0xC4D6EA, ground: 0x8A949E, intensity: 1.1, title: 2.2 },
    exposure: 0.95,
    bloom: { strength: 0.55, radius: 0.4, threshold: RENDER.bloom.threshold },
    grade: { shadowTint: 0x24486E, shadowMix: 0.08, shadowLuma: 0.3, highlightTint: 0xEEF6FF, highlightMix: 0.06, highlightLuma: 0.7, saturation: 1.18, vignette: { strength: 0.3, a: 0.5, b: 1.4 } },
    // edge #E4E8EC → #D6D6CC (District 1's paint), round-5 integration (DISTRICTS.md §13): the 29 / 36 px backdrop beside a gate
    // takes in the far road's edge line, and the near-white paint pulled Frozen's panels and frames under the §4.3 floors
    road: { asphalt: 0x3E3C40, dash: 0xE0D07A, edge: 0xD6D6CC, curb: 0x8A9098, roughness: 0.8, puddles: 0.15, puddleRoughness: 0.32, pools: null },
    ground: { ground: 0xC0CCD8, shoulder: 0x6E7884, grass: 0xE4ECF4 },
    building: { color: 0x6E727A, roofSnow: 1, snowColor: 0xEEF4F8, litFraction: 0.1, windowColor: 0xFFD08A, windowEmissive: 1.6, darkFraction: 0.3, bounce: 0.3 },
    props: {
      barricade: { kind: 'barricade', weight: 0.6 }, sandbags: { kind: 'snowbank', weight: 1 }, car: { kind: 'frozenCar', weight: 1 },
      building: { kind: 'building', weight: 0.3, layout: { storeys: [1, 3], far: 0.25 } },
      tree: { kind: 'pine', weight: 1 }, rubble: { kind: 'rock', weight: 0.8, tint: [1.25, 1.3, 1.4] },
      lamppost: { kind: 'lamppost', weight: 1 }, smoke: { kind: 'smoke', weight: 1 },
    },
    lamps: { layout: 'mixed', lit: 'none', gain: 1 },
    beacon: { gain: 1, blinkRate: RENDER.env.lights.blinkRate, blinkDuty: RENDER.env.lights.blinkDuty },
    smoke: { bottom: 0x8A9098, top: 0x5A6068, emberColor: PALETTE.fx.flame, ember: 0.6, alpha: 0.7, glowBounce: 0.05, chance: 0.15, anchor: null, w: [5.5, 9.5], h: [16, 28] },
    // snow is unlit: gain 0.5 keeps a flake (linear 0.47) under the 0.82 value glyph and the 0.85 bloom threshold, ≈ 1.5 × the sunlit snowfield
    weather: { kind: 'snow', color: 0xF4F8FF, gain: 0.5, opacity: 0.85, blend: 'normal', density: 1, size: 0.075, drift: 0.15, fall: -1.1, sway: 0.8, streak: 0, slant: 0, flicker: 0.15, box: [12, 6, 34] },
    zombie: { eyesEmissive: 1.6 },
  },
]);

/** The district of campaign level L (1-based): DISTRICT_RULES.levelsPerDistrict levels each, cycling past L30
 *  (L31 → SUNSET BOULEVARD again). Non-finite / < 1 → the first district. Returns the frozen DISTRICTS entry. */
export function districtForLevel(L) {
  const n = Number.isFinite(L) && L >= 1 ? Math.floor(L) : 1;
  return DISTRICTS[Math.floor((n - 1) / DISTRICT_RULES.levelsPerDistrict) % DISTRICTS.length];
}

/** The district of endless chunk D (1-based difficulty index): DISTRICT_RULES.endlessChunksPerDistrict chunks each,
 *  rotating 1 → 6 → 1. Non-finite / < 1 → the first district. Returns the frozen DISTRICTS entry. */
export function districtForChunk(D) {
  const n = Number.isFinite(D) && D >= 1 ? Math.floor(D) : 1;
  return DISTRICTS[Math.floor((n - 1) / DISTRICT_RULES.endlessChunksPerDistrict) % DISTRICTS.length];
}

// ==== MUSIC ==================================================================================
// GDD §13 music + audio graph; ARCHITECTURE §6.13 / §8.8 / §11.
// The music is DATA for audio.js's live scheduler (never a pre-rendered buffer):
//   • 120 BPM, 8 bars of 16 steps (16th notes) = 128 steps per loop, 125 ms per step at rate 1.
//   • `chords[bar]` = pad voicing (MIDI); `bassRoots[bar]` = bass root (MIDI).
//   • drum patterns: 16 velocities (0 = rest, 0..1 = hit) per bar; `barMap[bar]` picks the variant.
//   • `patterns.bass.steps`: degree per step — 0 rest, 1 root, 5 fifth (+7 semitones), 8 octave (+12).
//   • `patterns.lead.steps`: 2-bar phrases (32 entries, MIDI note or 0 = rest); `groupMap[g]` picks
//     the phrase for 2-bar group g (bars 2g, 2g+1); every note is held `gateSteps` steps.
//   • `modes[mode]`: which instruments play. drums: 'full' | 'half' (pattern set); bass/lead/drone: on/off;
//     bassOctave: semitone offset for the bass; pad: gain multiplier (absent = off).
//   • `instruments`: one synth recipe per voice, same Layer vocabulary as AUDIO_CUES (src, f, ms, filter, gain,
//     attackMs/releaseMs envelopes; kick: fStart → f over pitchMs; pad: `voices` detuned copies; drone: slow lfo).
export const MUSIC = deepFreeze({
  bpm: 120, bars: 8, stepsPerBar: 16,
  lookaheadMs: 100, schedulerMs: 25,                           // scheduler from setInterval(25) with 100 ms lookahead
  // dB. Round 2 (AUD-5): −6 dB from the round-1 −6 / −10 / −8 to offset the bus compressor's automatic makeup gain,
  // which grows by ≈ +7 dB once the knee is 6 dB instead of Chrome's 30 dB default (the gameplay bed stays ≈ −22 dBFS).
  // reward (round 3, AUD-10; GDD §13): the post-compressor reward bus (cue bus 'reward': pass_up, hup) — it skips the bus compressor
  // and meets the compressed bed at the limiter, so the gate-pass reward keeps its level over the gunfire (≥ 6 dB over the 1 s bed).
  // Round 4: the reward bus also carries the J5 flip and the J13 weapon stings (lead decision 1a). The faders are linear in amplitude
  // (lead decision 2: sound / music 50 = −6 dB, was −12 with the squared law), so music −14 → −15.94 dB (= −14 + 20·log10(0.64 / 0.8)):
  // at the default music fader 80 the music bus sits exactly where the squared law had it, and the default mix is unchanged.
  buses: { sfx: -12, gun: -16, music: -15.94, reward: -7 },
  // rewardLift (round 5, lead decision on r4-audio needsOtherGroup 1b; GDD §13): the reward bus follows the sound fader, but while the music
  // fader is higher it is lifted toward the music fader by at most maxDb. At sound 50 / music 80 the bed is mostly music and the gate-pass
  // reward rose only 3.9 dB over it (median; 4.5 at 50 / 70); with the lift the reward sits where sound 80 would put it. Sound 0 stays
  // silent, and sound ≥ music (the defaults, 100 / 70 since round 5) is unchanged.
  rewardLift: { maxDb: 6 },
  gunVoices: 12,                                               // gun bus voice limiter (per second)
  compressor: { threshold: -18, knee: 6, ratio: 6, attack: 0.003, release: 0.12 },   // knee: dB (round 2; Chrome's default 30 dB made it ≈ 1.1:1)
  // Safety limiter after the compressor (round 2, AUD-5): a second DynamicsCompressor (threshold −1 dB, knee 0, 20:1, 1 ms / 50 ms)
  // then a WaveShaper soft clip — identity up to |x| = clip.linear, then a tanh shoulder approaching clip.ceiling, so the
  // destination never receives a sample ≥ 0 dBFS (inputs beyond ±1 sit at the curve's end value, < clip.ceiling).
  limiter: { threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.05, clip: { linear: 0.8, ceiling: 0.985 } },
  // [dB, seconds]; pause ducks immediately and holds. bossDead (round 2, AUD-13): the music sits −10 dB under the
  // roar + fanfare for 2 s, then the loop fades out ('none' over fadeMs) instead of returning at full level.
  // gunOnReward (round 2, AUD-10): the GUN bus dips −9 dB for 0.45 s on gate:pass / weapon:start / gate:flip.
  // bedOnReward (round 3, AUD-10, new): the whole compressed bed (after the compressor: sfx + gun + music) dips under a positive
  // gate pass's reward bus, so the arpeggio and the hup chorus are not masked by the gunfire. Round 4: the J5 flip and the J13 stings
  // dip the bed too. rewardStack (round 4, new): a reward-bus moment (positive gate pass, flip, sting) starting less than 0.45 s after
  // another plays −5 dB (a crate's sting on a ×-gate chorus summed to −0.8 dBFS, into the soft clip).
  duck: { gate: [-6, 0.8], bossDead: [-10, 2.0], gunOnReward: [-9, 0.45], bedOnReward: [-4, 0.35], rewardStack: [-5, 0.45], pause: -12,
          attackS: 0.03, releaseS: 0.18 },                     // extra: setTargetAtTime constants of a timed duck
  rate: { base: 0.6, perScale: 0.4 },                          // playback rate = 0.6 + 0.4·timeScale
  pan: { perX: 0.15, maxPan: 0.6, attenDbAt40m: -6,            // pan = clamp(x·0.15, ±0.6); −6 dB at |z| = 40 m
         attenRefM: 40, attenMaxRatio: 2 },                    // extra: the reference distance of attenDbAt40m; attenuation stops at 2× it (−12 dB)
  // extra (audio.js engine caps; floods beyond them are dropped and counted in ctx.debug.dropped.audio): cue queue capacity,
  // cues started per update, tracked live voices, identical cues started from one frame (a 10-soldier spit plays 4 `ugh`s)
  // Round 2 (AUD-6): maxPerFrame 4 → 2, and the extra same-frame copy is decorrelated (started dupOffsetMs later, pitch
  // ± dupJitter from ctx.rngFx) so two identical cues never sum phase-coherently (+6 dB). Cues that coalesce never get here.
  // Round 4 (first-use frames, r3-verify §5): a cue played with delayMs ≥ deferMinMs (the fanfare 0.9 s after the boss-death roar,
  // boss stomp landings) waits in a deferCapacity-entry table and is built deferLeadMs before its start time (exact on the audio
  // clock) instead of in the triggering frame; released WaveShapers are pooled, at most shaperPool per drive.
  queue: { capacity: 64, startsPerUpdate: 24, liveCapacity: 192, maxPerFrame: 2, dupOffsetMs: [5, 15], dupJitter: 0.05,
           deferMinMs: 200, deferLeadMs: 150, deferCapacity: 8, shaperPool: 8 },
  // extra (round 4): first-use warm-up right after the graph (boot, behind the bar): requestIdleCallback slices (at least one item each,
  // more while > idleMinMs of the idle period is left; timeoutMs = the idle-callback deadline; timerMs = the fallback timer without
  // requestIdleCallback) build each oscillator type once and dry-build every AUDIO_CUES recipe into an unconnected sink.
  warm: { idleMinMs: 2, timeoutMs: 200, timerMs: 16 },
  // extra (round 5): pre-rendered instances (AUDIO_CUES[*].prerender, instruments.pad.prerender) are rendered as warm-up items after the dry
  // builds; a play uses a buffer rendered at a pitch within ±pitchTol of its own (playbackRate = the ratio); renders run tailMs past the
  // last layer's end.
  prerender: { pitchTol: 0.1, tailMs: 30 },
  visibilityResumeMs: 500,                                     // extra: ARCH §6.13 "if the state is not running within 500 ms" → needsGesture
  scheduler: { catchUpS: 0.25, maxStepsPerTick: 32 },          // extra: a scheduler further behind than catchUpS skips ahead; loop guard per pass
  startDelayS: 0.06,                                           // extra: the first step of a freshly started loop is placed this far ahead
  // Mode switches (round 2, AUD-12): between two playing modes the switch lands on the next beat (beatSteps 16ths);
  // level:start / boss:fight / the title restart the loop at bar 0 behind a crossfadeMs dip of the music fade gain.
  modeSwitch: { beatSteps: 4, crossfadeMs: 120 },
  paramSmoothS: 0.02,                                          // extra: setTargetAtTime constant for volume / mute / rate changes (ARCH §6.13 rate 0.02)
  coinLadderMs: 500,                                           // coin cue: +1 semitone per coin within 500 ms
  noise: { seconds: 1, band: { f: 1200, q: 0.7 } },            // the three pre-rendered 1 s buffers: white, brown, band-passed (1.2 kHz, Q 0.7)
  fadeMs: 400,                                                 // mode crossfade
  key: 'A minor',
  chords: [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62], [57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]],   // Am F C G | Am F C G (close voicings)
  bassRoots: [45, 41, 48, 43, 45, 41, 48, 43],                 // A2 F2 C3 G2 (boss mode: bassOctave −12)
  patterns: {
    kick: {
      full: [[1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0], [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0]],
      half: [[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]],
    },
    snare: {
      full: [[0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0.4]],
      half: [[0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]],
    },
    hat: {
      full: [[0.9, 0.3, 0.6, 0.3, 0.9, 0.3, 0.6, 0.3, 0.9, 0.3, 0.6, 0.3, 0.9, 0.3, 0.6, 0.5]],
      half: [[0.8, 0, 0.4, 0, 0.8, 0, 0.4, 0, 0.8, 0, 0.4, 0, 0.8, 0, 0.4, 0]],
    },
    barMap: { full: [0, 0, 0, 1, 0, 0, 0, 1], half: [0, 0, 0, 0, 0, 0, 0, 0] },   // variant index per bar (clamped to the set's length)
    bass: {
      steps: [[1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 8, 0, 0, 5, 0], [1, 0, 1, 0, 1, 0, 1, 0, 8, 0, 5, 0, 1, 0, 8, 5]],
      barMap: [0, 0, 0, 1, 0, 0, 0, 1],
    },
    lead: {
      steps: [
        [76, 0, 0, 72, 0, 0, 74, 0, 0, 0, 69, 0, 0, 0, 0, 0,  74, 0, 0, 72, 0, 0, 69, 0, 0, 0, 67, 0, 0, 0, 0, 0],   // E5 C5 D5 A4 | D5 C5 A4 G4
        [79, 0, 0, 76, 0, 0, 74, 0, 0, 0, 72, 0, 0, 0, 0, 0,  76, 0, 0, 74, 0, 0, 72, 0, 0, 0, 69, 0, 0, 0, 0, 0],   // G5 E5 D5 C5 | E5 D5 C5 A4
      ],
      groupMap: [0, 0, 1, 1],
      gateSteps: 3,
    },
  },
  instruments: {
    kick:  { src: 'sine', f: 50, fStart: 150, pitchMs: 30, ms: 120, gain: 0.9,                                           // "kick sine 50 Hz 120 ms"
             click: { src: 'noise', ms: 2, filter: { type: 'highpass', f: 2000 }, gain: 0.2 } },                         // + 2 ms click: audible on phone speakers (round 2, AUD-11)
    snare: { src: 'noise', ms: 100, filter: { type: 'bandpass', f: 1800, q: 0.8 }, gain: 0.5, tone: { src: 'triangle', f: 190, ms: 60, gain: 0.3 } },   // "snare noise 100 ms"
    hat:   { src: 'noise', ms: 30, filter: { type: 'highpass', f: 6500 }, gain: 0.25 },                                   // "hats noise 30 ms 16ths"
    bass:  { src: 'square', filter: { type: 'lowpass', f: 480, q: 1 }, gain: 0.3, attackMs: 3, releaseMs: 40, gateSteps: 1 },   // "bass square 16th pattern"
    lead:  { src: 'triangle', filter: { type: 'lowpass', f: 2400 }, gain: 0.28, attackMs: 8, releaseMs: 120 },           // "lead triangle 4-note motif"
    // pad.prerender (round 5, r4-audio needsOtherGroup 1a): each distinct chord (3 notes × 2 voices × oscillator → low-pass → envelope, a bar's
    // hold + release at rate 1) is rendered once; a downbeat then plays one buffer source + envelope gain (2 nodes instead of 18) at the
    // music rate. Same notes, filter and envelope, so the same sound; until the render is done the notes are built live.
    pad:   { src: 'triangle', voices: 2, detuneCents: 6, filter: { type: 'lowpass', f: 1200 }, gain: 0.22, attackMs: 350, releaseMs: 500, prerender: true },
    drone: { src: 'sawtooth', note: 33, filter: { type: 'lowpass', f: 220 }, gain: 0.25, lfo: { f: 0.25, depth: 0.1 } },   // A1 low drone (boss)
  },
  modes: {
    none:  {},
    menu:  { pad: 1.0 },                                                   // no drums, pad only
    level: { drums: 'full', bass: true, lead: true, pad: 0.6 },            // full
    runup: { drums: 'full' },                                              // drums only
    boss:  { drums: 'half', bass: true, bassOctave: -12, lead: true, drone: true },   // half-time, bass −1 octave, low drone
  },
});

// ==== JUICE ==================================================================================
// GDD §5 (count ticker), §12 (J-table), §3.1, §14 (UI timings); ARCHITECTURE §6.12 / §8.8. Seconds unless
// the key says Ms/Px. `ui` (extra) collects every UI timing from GDD §14 / ARCH §10.3 so ui.js holds no literals.
export const JUICE = deepFreeze({
  trauma: { gatePass: 0.15, brute: 0.35, rocket: 0.3, bossSlam: 0.35, bossPhase: 0.25, bossDeath: 0.8, bossIntro: 0.3 },
  shake: { x: 0.35, y: 0.25, rollDeg: 2, decay: 1.2, clamp: 0.3 },       // shake = T², decay 1.2/s, offset (0.35·n, 0.25·n), roll 2°, clamp 0.3 m
  slowmo: { bossDeath: [0.25, 1.2], nearMiss: [0.85, 0.1], squadDead: [0.25, 0.6] },   // [scale, seconds]
  nearMissRadius: 1.5,                                                    // J20: zombie dies within 1.5 m of the squad
  caps: { floaters: 24, floaterQuads: 96, damageNumbers: 32, numberQuads: 128, labelQuads: 6, badgeQuads: 3, shards: 96,
          decals: 24,   // (round 5c, lead) was 12: an endless mini-boss fight (slam rings, spit arcs, lane highlight, boss shield ring) overflowed it
                        // 16× in one run ("dropped: fx.decals 16"), which can hide an attack telegraph; still ONE instanced draw
          coinFlights: 48, iconFlights: 4,
          voicedShotsPerSec: 12, tickCoalesceMs: 40, particlesPerMesh: 512,     // particlesPerMesh = QUALITY_TIERS.high.particles / 2 (extra)
          bossNumbers: 6 },   // extra (round-2 FX-12): live damage numbers per tracked target (boss / brute) = 2 columns × damageNumber.bossSlots rows; a new one retires its slot's occupant
  bursts: { hitSpark: 4, gateSpark: 3, blood: 8, bloodSmall: 6, max: 12, flip: 16, rocket: 30, splat: 10, bossDeath: 200, coinFountain: 60 },
  shatter: { shards: 24, seconds: 0.4 },                                  // J7 panel shatter
  floater: { rise: 1.2, life: 0.7, size: 0.6, mergeMs: 100 },             // "−1" floaters; deaths within 100 ms merge
  damageNumber: { mergeSeconds: 0.12,                                     // extra: brute / boss hits within 0.12 s add up (GDD §6.1)
                  // extra (round-2 FX-12): boss numbers read at 10–12 m (×1.2 glyph size); tracked-target numbers fill a slot grid of
                  // 2 columns (inner edges ±bossSide m from the target) × bossSlots rows, rise bossRise m (less than the row gap).
                  // Round-3 FTUE: bossSide 0.12 → 0.3 — a 0.24 m gap is a third of the 0.72 m boss glyph, narrower than one digit, so
                  // a row's two numbers read as one ("110" + "48" = "11048"); 0.6 m ≈ 0.8 em keeps them apart
                  // Round 4 (r3-ftue residual 4): on the BOSS itself only bossRows rows per side (≤ 2 × bossRows live) and one merged number per
                  // floater.life / (2 × bossRows) s at least, so a slot's number has faded before the slot comes round again; brutes keep bossSlots rows
                  bossScale: 1.2, bossSide: 0.3, bossRise: 0.25, bossSlots: 3, bossRows: 2 },
  gateBurst: { risePx: 40, life: 0.7 },                                   // GDD §5 "+17" burst at the label
  coinFlight: { seconds: 0.4, punch: 1.2 },                               // J19
  gameOverDesat: 0.8,                                                     // J18 desaturate time
  label: { tweenMax: 0.6, tweenPer: 0.08, tickMs: 20, punchUp: 1.4, punchDown: 0.8, flashUp: 0.2, flashDown: 0.3, multShow: 0.3, spring: 0.25,
           gain: 0.82,     // GDD §5; gain (extra) = linear white of the count label, just under RENDER.bloom.threshold 0.85 so the bloom never swallows its 3 px outline
           plateAlpha: 0.45, platePad: 0.15 },   // extra (round-2 FX-10): dark rounded plate (PALETTE.glyph.outline) behind the digits at this alpha, padded platePad em
  haptics: { max: 20, flip: 30, step: 25, passUp: 40, passDown: [30, 30, 30], loss: 15, brute: 50, crate: 20, powerup: 30, bossIntro: 80, bossPhase: 60,
             bossDeath: [60, 40, 120], star: 20, gameover: 100, rocket: 30, rail: 60, spit: 15, complete: 20 },   // ms patterns (navigator.vibrate)
  flashes: { bossPhase: 0.1, bossDeath: 0.15, rail: 0.08, redFlip: 0.25, reducedDimMs: 150, negVignette: 0.2, chewVignette: 0.25 },   // extra: J15/J16/J21/J5/J8 screen flashes
  powerup: { edgeGlow: 0.3, pillBlinkHz: 2, pillBlinkLast: 2 },           // extra: J13 / J14
  fovKick: { rocket: 4, seconds: 0.25 },                                  // extra: J21 FOV kick +4°
  ui: {                                                                   // extra: GDD §14 / ARCH §10.3 timings
    screenFadeMs: 160, hudHz: 10, debugHz: 4,
    resizeDebounceMs: 120,   // CORE-10: resize / orientation burst → render.resize at once (leading edge) and again this long after the last event (GDD §14)
    coinTweenMs: 300, countUpPerSec: 30, purchaseFlashMs: 300,
    bossBarInMs: 400, bossBarOutMs: 1500,
    hintSeconds: 2.5, hintHandPx: 64, hintTextPx: 22,
    // round-2 UI-18: the hint is a compact pill bottom-anchored at safe-bottom + hintBottomPx (design px × --ui) under the
    // squad, max-width hintMaxWidthPct % of the safe box, panel alpha hintAlpha (hintY, the band over the horizon, is retired)
    hintBottomPx: 28, hintMaxWidthPct: 86, hintAlpha: 0.72,
    hintQueueMax: 2,                                                       // UI-25: hints queued behind the one on screen (de-duplicated by id)
    hintMinSeconds: 1.5,                                                   // round-3 FTUE: a hint with another one waiting yields after this (s), so L1's back-to-back lessons stay on their beat
    confirmMinS: 0.6,                                                      // UI-20: RESET SAVE ignores confirming taps this long after arming (no double-tap wipe)
    starStagger: 0.25, starScaleFrom: 3,
    confirmResetSeconds: 3, errorAutoHideSeconds: 6,
    logoBobSeconds: 2, logoOutlinePx: 4,
    pauseBlurPx: 6,
    thumbZonePx: 180, refBox: [390, 844], uiScaleClamp: [0.85, 1.25], largeTextScale: 1.15,
    progressTickPx: 6,
    skullPulseHz: 1,
  },
});

// ==== AUDIO_CUES =============================================================================
// GDD §13 cue recipes; ARCHITECTURE §6.13 / §8.8 / §11. audio.js interprets EXACTLY this vocabulary:
//
// Cue = {
//   bus:        'sfx' | 'gun' | 'reward'     default 'sfx'; the cue's layers are summed into that bus ('reward', round 3 AUD-10: the
//                                            post-compressor reward bus, MUSIC.buses.reward — the compressed bed dips under it;
//                                            round 4: pass_up, hup, flip and the five weapon stings)
//   noAtten:    true                         positional cue panned by x but never distance-attenuated by z (round 4: flip)
//   layers:     Layer[]                       every layer starts at t0 + delayMs and runs independently
//   coalesceMs: ms                            at most one instance per coalesceMs per key (audio keys `tick` per gate, `crunch` globally)
//   stackDb:    { per, cap }                  coalesced extra instances add `per` dB each, capped (crunch: +3 dB per extra kill, cap +9)
//   maxPerSec:  n                             voice limiter for this cue name (extra plays are dropped)
//   rateJitter: fraction                      ± random pitch multiplier per play, from ctx.rngFx (shot: ±8 %)
//   countDb:    { per, db, cap }              +db dB per `per` units of opts.count, capped (shot: +1 dB per 8 shooters, cap +12)
//   voices:     { max, perN, detune }         chorus: n = min(max, ceil(opts.count / perN)) copies, each detuned ± detune (fraction)
//               (+ gainExp, spread)           per-voice gain 1/n^gainExp (default 0.35); spread (round 3, AUD-10): each voice gets its own
//                                            StereoPanner across ±spread (slots alternate sides; √2 pan-law compensation), one voice stays centred
//   ladder:     { semitones, windowMs }       a play within windowMs of the previous one is pitched +semitones higher (resets after the window)
//   pitchRule:  { base, perUnit, min, max }   f = clamp(base + perUnit · opts.value, min, max) replaces the layers' f (tick: value − base)
//   repeatMs:   ms                            informational: the emitter re-triggers the cue at this interval (ticktock)
//   noTimeScale: true                         reward / UI sting: built at rate 1 and never re-pitched by slow-mo (round 2, AUD-4)
//   prerender:  { variants, at }              round 5: rendered once by audio.js's own interpreter into an OfflineAudioContext (warm-up,
//                                            behind the boot bar); a play then costs one AudioBufferSource instead of its layer chains.
//                                            One buffer per at-entry [pitch, stretch] (default [[1, 1]]) × chorus size (1 … voices.max)
//                                            × variants (random onsets / detune / noise offsets; a deterministic instance renders one).
//                                            Used when the play's stretch matches and its pitch is within MUSIC.prerender.pitchTol, at
//                                            rate 1 (or noTimeScale); anything else is synthesised live as before
//   (cue-specific extras read by audio.js: roar.bossIntroPitch / bossDeathPitch / bossDeathStretch / bossVolume, fanfare.afterRoarMs,
//    thud.bossStompPitch, thip.bossPitch)
// }
// Layer = {
//   src:     'sine' | 'square' | 'triangle' | 'sawtooth'   OscillatorNode
//            'noise' | 'brown' | 'band'                      AudioBufferSourceNode from the pre-rendered 1 s buffers (MUSIC.noise):
//                                                            white, brown, and white → band-pass (1.2 kHz, Q 0.7)
//   f:       Hz (oscillators; ignored for buffers)
//   fEnd:    Hz — exponential ramp from f to fEnd across fMs (default: across the whole `ms`)
//   fMs:     ms the pitch ramp takes
//   ms:      total length; gain envelope = linear attack (attack ms) → exponential decay to −60 dB finishing at ms
//   attack:  ms (default 2)
//   decay:   ms at which the decay starts (default = attack, i.e. decay right after the attack)
//   gain:    0..1 linear (default 1); opts.volume multiplies
//   delayMs: start offset inside the cue (default 0)
//   filter:  { type: 'lowpass' | 'highpass' | 'bandpass', f, q (default 1), fEnd (exponential ramp across the layer) }   at most one per layer
//   shaper:  0..1 WaveShaper drive (roar)
//   detune:  cents (constant offset)
// }
// opts passed to audio.play(name, { volume, pitch, pos, detune, count, value }) — `pitch` multiplies every f and buffer rate (boss-death roar: 0.4).
export const AUDIO_CUES = deepFreeze({
  // ---- gunfire / hits ----
  shot: { bus: 'gun', maxPerSec: JUICE.caps.voicedShotsPerSec, rateJitter: 0.08, countDb: { per: 8, db: 1, cap: 12 },
          layers: [{ src: 'band', ms: 40, attack: 1, gain: 0.8 },                                      // white noise 40 ms → band-pass 1.2 kHz Q 0.7 (pre-rendered)
                   { src: 'sine', f: 180, fEnd: 60, ms: 60, gain: 0.6 }] },                           // + sine 180 → 60 Hz over 60 ms
  thip: { maxPerSec: 20, bossPitch: 0.7, layers: [{ src: 'noise', ms: 20, filter: { type: 'bandpass', f: 2000, q: 1.2 }, gain: 0.5 }] },   // bossPitch: hits on the boss
  crunch: { coalesceMs: 50, stackDb: { per: 3, cap: 9 },
            layers: [{ src: 'brown', ms: 80, attack: 1, filter: { type: 'lowpass', f: 800 }, gain: 1.0 }] },   // brown noise 80 ms → low-pass 800, gain spike
  // Round 2 (AUD-6): ugh / thud / roar / pop / screech / hup merge duplicates within 40 ms into one instance, +2 dB per extra (cap +6)
  ugh: { coalesceMs: 40, stackDb: { per: 2, cap: 6 }, layers: [{ src: 'sawtooth', f: 180, fEnd: 120, ms: 90, gain: 0.5 }] },
  splat: { layers: [{ src: 'noise', ms: 100, filter: { type: 'lowpass', f: 2000, fEnd: 300 }, gain: 0.7 }] },
  screech: { coalesceMs: 40, stackDb: { per: 2, cap: 6 },
             layers: [{ src: 'sawtooth', f: 1400, fEnd: 900, ms: 250, filter: { type: 'bandpass', f: 1200, q: 1.5 }, gain: 0.5 }] },
  // roar (round 2, AUD-7): layer gains 0.9 / 0.4 → 0.4 / 0.2 (an accent inside the mix, not +20 dB over it); the boss intro /
  // death roars (no pos, so no distance attenuation) also play at bossVolume. boss:intro pitch bossIntroPitch; boss:dead (J16
  // "roar at rate 0.4") pitch bossDeathPitch, lengthened ×bossDeathStretch (600 ms → 1.5 s, filling the 1.2 s slow-mo).
  // Round 3 (GDD §13 phone-band rule; the brute telegraph J11 lost 13.5 dB through a 400 Hz high-pass): sub sawtooth 0.4 → 0.3, the noise is
  // band-passed at 900 Hz (q 0.6) instead of low-passed and raised 0.2 → 0.36, + a saturated 140 Hz sawtooth band-passed at 800 Hz (0.42):
  // phone loss −7 dB (boss intro / death −7 / −6), full-band RMS −3 dB (brute) / −1 dB (boss roars), +3 to +7 dB through a phone speaker.
  // Round 5 (r4-release §7 item 3, the boss-arrival frame at 4× CPU): pre-rendered at the brute pitch 1 and the boss-intro pitch 0.6 (2 variants,
  // the noise offset): the intro roar is 2 nodes instead of 9 + 3 pooled WaveShapers. The boss-death roar plays under the slow-mo rate: live.
  roar: { coalesceMs: 40, stackDb: { per: 2, cap: 6 }, bossIntroPitch: 0.6, bossDeathPitch: 0.4, bossDeathStretch: 2.5, bossVolume: 0.4,
          prerender: { variants: 2, at: [[1, 1], [0.6, 1]] },
          layers: [{ src: 'sawtooth', f: 70, ms: 600, attack: 20, decay: 300, shaper: 0.6, gain: 0.3 },
                   { src: 'noise', ms: 600, attack: 20, decay: 300, filter: { type: 'bandpass', f: 900, q: 0.6 }, shaper: 0.6, gain: 0.36 },
                   { src: 'sawtooth', f: 140, ms: 600, attack: 20, decay: 300, filter: { type: 'bandpass', f: 800, q: 0.7 }, shaper: 0.6, gain: 0.42 }] },
  // thud (round 2, AUD-11): the 60 Hz sine is saturated (shaper 0.3: odd harmonics from 180 Hz up) and trimmed to 0.5; the knock is
  // 90 ms of the 1.2 kHz band noise (low-pass 1.8 kHz) so the brute bite (J11) keeps its identity on a phone speaker (−4 dB, was −17).
  // bossStompPitch: the boss slam / stomp landing.
  thud: { coalesceMs: 40, stackDb: { per: 2, cap: 6 }, bossStompPitch: 0.6,
          layers: [{ src: 'sine', f: 60, ms: 150, shaper: 0.3, gain: 0.5 }, { src: 'band', ms: 90, attack: 1, decay: 25, filter: { type: 'lowpass', f: 1800 }, gain: 1.0 }] },
  // ---- gates ----
  tick: { coalesceMs: JUICE.caps.tickCoalesceMs, pitchRule: { base: 620, perUnit: 6, min: 620, max: 2200 },   // f = clamp(620 + 6·(value − base), 620, 2200)
          layers: [{ src: 'sine', f: 620, ms: 40, attack: 2, decay: 5, gain: 0.5 }] },                        // 40 ms, attack 2 ms, exp decay ≈ 35 ms
  max: { layers: [{ src: 'triangle', f: 880, ms: 80, gain: 0.6 }, { src: 'triangle', f: 1320, ms: 120, delayMs: 80, gain: 0.6 }] },
  // flip (round 2, AUD-9): held over the whole 150 ms sweep (attack 10, decay from 110 ms), wider band (q 0.8), gain 1.0.
  // Round 4 (lead decision 1a: J5 reads ≥ 6 dB over the gunfire bed like the gate pass): reward bus, noAtten (a flip 35 m ahead lost
  // 5 dB to distance), noise 1.0 → 0.57 + a triangle 330 → 1 320 Hz sweep (1.0) under it — tonal energy holds the crest at 6.5 dB, so
  // the loudest 50 ms is −11.1 dBFS unpanned (≈ −13.5 behind its centred StereoPanner) with peaks ≤ −4.6 dBFS (noise alone would
  // need peaks at the limiter for that loudness).
  flip: { bus: 'reward', noAtten: true,
          layers: [{ src: 'noise', ms: 150, attack: 10, decay: 110, filter: { type: 'bandpass', f: 300, fEnd: 3000, q: 0.8 }, gain: 0.57 },
                   { src: 'triangle', f: 330, fEnd: 1320, ms: 150, attack: 10, decay: 110, gain: 1.0 }] },
  // whomp (round 2, AUD-11): sub sines 0.9 → 0.35 / 0.25 + a sawtooth 180 → 153 Hz band-passed at 600 Hz (its 360–1 000 Hz harmonics)
  // and a 60 ms band-noise thump, so the gate step (J4) survives a phone speaker (−7 dB, was −33)
  whomp: { layers: [{ src: 'sine', f: 90, fEnd: 90 * 0.85, ms: 250, gain: 0.35 }, { src: 'sine', f: 45, fEnd: 45 * 0.85, ms: 300, gain: 0.25 },   // pitch drop 15 %
                    { src: 'sawtooth', f: 180, fEnd: 180 * 0.85, ms: 250, filter: { type: 'bandpass', f: 600, q: 0.7 }, gain: 0.8 },
                    { src: 'band', ms: 60, attack: 1, decay: 10, gain: 0.5 }] },
  // pass_up (round 2, AUD-10: 0.45 → 0.8). Round 3 (AUD-10): on the reward bus (it skips the bus compressor, which held the pass 3–5 dB over
  // the gunfire whatever its gain); each note held 30 ms (attack 6), ≈ 8 dB more energy at the same peak; the arpeggio
  // starts 15 ms after the pass so its first onset does not stack on the gate coin's; noTimeScale like the other reward stings.
  // Round 5: pre-rendered (deterministic: one buffer): 2 nodes per positive pass instead of 13.
  pass_up: { bus: 'reward', noTimeScale: true, prerender: { variants: 1 },
             layers: [{ src: 'square', f: hz(N.C5), ms: 60, delayMs: 15, attack: 6, decay: 30, filter: { type: 'lowpass', f: 1800 }, gain: 0.8 },
                      { src: 'square', f: hz(N.E5), ms: 60, delayMs: 75, attack: 6, decay: 30, filter: { type: 'lowpass', f: 1800 }, gain: 0.8 },
                      { src: 'square', f: hz(N.G5), ms: 60, delayMs: 135, attack: 6, decay: 30, filter: { type: 'lowpass', f: 1800 }, gain: 0.8 },
                      { src: 'square', f: hz(N.C6), ms: 60, delayMs: 195, attack: 6, decay: 30, filter: { type: 'lowpass', f: 1800 }, gain: 0.8 }] },   // C5 E5 G5 C6
  pass_down: { layers: [{ src: 'square', f: hz(N.G4), ms: 120, filter: { type: 'lowpass', f: 1500 }, gain: 0.45 },
                        { src: 'square', f: hz(N.CS4), ms: 120, delayMs: 120, filter: { type: 'lowpass', f: 1500 }, gain: 0.45 }] },   // G4 → C#4
  // hup (round 2, AUD-10: gain 0.9, held 40 ms). Round 3 (AUD-10): reward bus, the crowd's answer right after the arpeggio (delayMs 255:
  // its peaky chorus never stacks on a note); per-voice gain 1/n^0.2 (8 voices ≈ +5 dB over one); voices spread across ±0.7
  // pan (one voice centred, a big gain reads wide).
  // Round 5 (r4-audio needsOtherGroup 1a, lead decision): pre-rendered per chorus size 1 … 8, 2 variants each (stereo; the voices' random
  // detune and onsets): a big pass's chorus is 2 nodes instead of 33 (≈ 10 ms at 4× CPU per big pass before), same graph, same timbre.
  hup: { bus: 'reward', coalesceMs: 40, stackDb: { per: 2, cap: 6 }, voices: { max: 8, perN: 4, detune: 0.04, gainExp: 0.2, spread: 0.7 },
         prerender: { variants: 2 },
         layers: [{ src: 'sawtooth', f: 220, ms: 70, attack: 10, decay: 40, delayMs: 255, filter: { type: 'bandpass', f: 700, q: 1.0 }, gain: 0.7 }] },   // N voices = min(8, N/4), ±4 %
  // ---- pickups / specials ----
  pop: { coalesceMs: 40, stackDb: { per: 2, cap: 6 }, layers: [{ src: 'sine', f: 600, fEnd: 900, ms: 60, gain: 0.6 }] },
  jingle: { layers: [{ src: 'triangle', f: hz(N.E5), ms: 90, gain: 0.5 }, { src: 'triangle', f: hz(N.G5), ms: 90, delayMs: 90, gain: 0.5 },
                     { src: 'triangle', f: hz(N.B5), ms: 90, delayMs: 180, gain: 0.5 }] },                                             // E5 G5 B5
  // Round 4, all five stings (lead decision 1a: J13 reads ≥ 6 dB over the gunfire bed like the gate pass): reward bus (no bus
  // compression; the bed dips MUSIC.duck.bedOnReward under them), holds lengthened and a tonal layer carrying the level, so each sting's
  // loudest 50 ms is −12.4 to −12.7 dBFS isolated with peaks ≤ −4.6 dBFS (crest ≤ 8 dB: the noise-led round-2 recipes had 10–15 dB and
  // would have needed peaks at the limiter for the same loudness). Offline: the game's interpreter + chain, 12 seeds.
  // sting_shotgun (round 2, AUD-9): 1.2 kHz band noise → low-pass 2.5 kHz + a sine 140 → 60 Hz body (was a 600 Hz low-passed white
  // noise that lost ≈ 97 % of its power, 11–15 dB under the other stings; brown noise measured −9 dB on a phone speaker).
  // Round 4: noise and body held 60 ms (was 30 / 2), + a square 320 → 140 Hz "chk" low-passed 1.5 kHz.
  sting_shotgun: { bus: 'reward',
                   layers: [{ src: 'band', ms: 120, attack: 2, decay: 60, filter: { type: 'lowpass', f: 2500 }, gain: 0.43 },
                            { src: 'sine', f: 140, fEnd: 60, ms: 120, decay: 60, gain: 0.39 },
                            { src: 'square', f: 320, fEnd: 140, ms: 90, attack: 2, decay: 40, filter: { type: 'lowpass', f: 1500 }, gain: 0.39 }] },
  // sting_minigun: 4 shots at 50 ms (band noise held 25 ms, attack 3 — round 4) + a square 220 → 660 Hz spin-up whine low-passed 1.4 kHz
  // across the burst (round 4: the 40 ms shots alone read 15 dB crest, and a 50 ms window held one shot)
  sting_minigun: { bus: 'reward',
                   layers: [{ src: 'band', ms: 40, attack: 3, decay: 25, gain: 0.47 }, { src: 'sine', f: 180, fEnd: 60, ms: 60, decay: 30, gain: 0.26 },
                            { src: 'band', ms: 40, delayMs: 50, attack: 3, decay: 25, gain: 0.47 }, { src: 'sine', f: 180, fEnd: 60, ms: 60, delayMs: 50, decay: 30, gain: 0.26 },
                            { src: 'band', ms: 40, delayMs: 100, attack: 3, decay: 25, gain: 0.47 }, { src: 'sine', f: 180, fEnd: 60, ms: 60, delayMs: 100, decay: 30, gain: 0.26 },
                            { src: 'band', ms: 40, delayMs: 150, attack: 3, decay: 25, gain: 0.47 }, { src: 'sine', f: 180, fEnd: 60, ms: 60, delayMs: 150, decay: 30, gain: 0.26 },
                            { src: 'square', f: 220, fEnd: 660, ms: 210, attack: 15, decay: 180, filter: { type: 'lowpass', f: 1400 }, gain: 0.52 }] },
  // sting_rocket: sine 300 → 60 Hz + mid-band noise + sawtooth (round 2, AUD-11); round 4: held 150 / 100 / 120 ms, tonal layers up, noise down
  sting_rocket: { bus: 'reward',
                  layers: [{ src: 'sine', f: 300, fEnd: 60, ms: 400, decay: 150, gain: 0.53 },
                           { src: 'band', ms: 400, decay: 100, filter: { type: 'lowpass', f: 1500, fEnd: 300 }, gain: 0.38 },
                           { src: 'sawtooth', f: 600, fEnd: 240, ms: 300, decay: 120, filter: { type: 'lowpass', f: 1500 }, gain: 0.44 }] },
  // sting_rail (round 3): held 60 ms, q 2 → 1.2 (it sat 4 dB under the other stings); round 4: noise 1.0 → 0.52 + a triangle
  // 1 760 → 220 Hz fall (0.83) under the sweep
  sting_rail: { bus: 'reward',
                layers: [{ src: 'noise', ms: 300, attack: 2, decay: 60, filter: { type: 'bandpass', f: 8000, fEnd: 200, q: 1.2 }, gain: 0.52 },
                         { src: 'triangle', f: 1760, fEnd: 220, ms: 300, attack: 2, decay: 80, gain: 0.83 }] },
  // sting_laser: 1 200 + 1 207 Hz, a 7 Hz beat (round 4: reward bus, 0.4 → 0.37)
  sting_laser: { bus: 'reward',
                 layers: [{ src: 'sine', f: 1200, ms: 400, attack: 10, decay: 250, gain: 0.37 }, { src: 'sine', f: 1207, ms: 400, attack: 10, decay: 250, gain: 0.37 }] },
  ticktock: { repeatMs: 500, layers: [{ src: 'sine', f: 1000, ms: 30, gain: 0.4 }] },
  rocket: { layers: [{ src: 'noise', ms: 350, attack: 5, filter: { type: 'lowpass', f: 2500, fEnd: 150 }, gain: 0.9 },                   // J21 launch + burst
                     { src: 'sine', f: 140, fEnd: 40, ms: 350, gain: 0.8 }] },
  rail: { layers: [{ src: 'noise', ms: 80, attack: 1, filter: { type: 'bandpass', f: 4000, fEnd: 400, q: 1.5 }, gain: 1.0 },              // J21 deep crack
                   { src: 'sine', f: 160, fEnd: 40, ms: 260, gain: 0.45 },
                   { src: 'sawtooth', f: 480, fEnd: 200, ms: 200, filter: { type: 'lowpass', f: 1500 }, gain: 0.4 }] },                  // + mid-band body (round 2, AUD-11)
  crack: { layers: [{ src: 'noise', ms: 30, filter: { type: 'bandpass', f: 3000, q: 2 }, gain: 0.9 }, { src: 'sine', f: 900, fEnd: 300, ms: 80, gain: 0.6 }] },   // hero sniper
  explosion: { layers: [{ src: 'brown', ms: 500, attack: 5, filter: { type: 'lowpass', f: 1200, fEnd: 120 }, gain: 0.6 }, { src: 'sine', f: 90, fEnd: 30, ms: 450, gain: 0.4 },   // APC blast
                        { src: 'band', ms: 350, attack: 3, decay: 40, filter: { type: 'lowpass', f: 1800, fEnd: 400 }, gain: 1.0 }] },          // + mid-band burst (round 2, AUD-11)
  // ---- boss ----
  crash: { layers: [{ src: 'noise', ms: 300, filter: { type: 'highpass', f: 1500 }, gain: 0.7 },
                    { src: 'sine', f: 523, ms: 400, attack: 1, gain: 0.5 }, { src: 'sine', f: 711, ms: 400, attack: 1, gain: 0.5 }, { src: 'sine', f: 947, ms: 400, attack: 1, gain: 0.5 }] },   // metallic
  // fanfare (round 2, AUD-4): noTimeScale — it starts afterRoarMs after the boss-death roar, inside the 1.2 s slow-mo, and must stay in C major
  // Round 5: pre-rendered (deterministic, noTimeScale): its deferred build is 2 nodes instead of 37.
  fanfare: { noTimeScale: true, afterRoarMs: 900, prerender: { variants: 1 },
             layers: [{ src: 'triangle', f: hz(N.C5), ms: 110, gain: 0.5 }, { src: 'triangle', f: hz(N.E5), ms: 110, delayMs: 110, gain: 0.5 },
                      { src: 'triangle', f: hz(N.G5), ms: 110, delayMs: 220, gain: 0.5 }, { src: 'triangle', f: hz(N.C6), ms: 110, delayMs: 330, gain: 0.5 },
                      { src: 'triangle', f: hz(N.E6), ms: 110, delayMs: 440, gain: 0.5 }, { src: 'triangle', f: hz(N.G6), ms: 220, delayMs: 550, gain: 0.5 },
                      { src: 'sawtooth', f: hz(N.C3), ms: 110, filter: { type: 'lowpass', f: 800 }, gain: 0.35 },                     // sawtooth bass, two octaves down
                      { src: 'sawtooth', f: hz(N.E3), ms: 110, delayMs: 110, filter: { type: 'lowpass', f: 800 }, gain: 0.35 },
                      { src: 'sawtooth', f: hz(N.G3), ms: 110, delayMs: 220, filter: { type: 'lowpass', f: 800 }, gain: 0.35 },
                      { src: 'sawtooth', f: hz(N.C4), ms: 110, delayMs: 330, filter: { type: 'lowpass', f: 800 }, gain: 0.35 },
                      { src: 'sawtooth', f: hz(N.E4), ms: 110, delayMs: 440, filter: { type: 'lowpass', f: 800 }, gain: 0.35 },
                      { src: 'sawtooth', f: hz(N.G4), ms: 220, delayMs: 550, filter: { type: 'lowpass', f: 800 }, gain: 0.35 }] },
  // ---- results / meta ----
  chime3: { noTimeScale: true, layers: [{ src: 'triangle', f: 880, ms: 150, gain: 0.5 }, { src: 'triangle', f: 1109, ms: 150, delayMs: 150, gain: 0.5 }, { src: 'triangle', f: 1319, ms: 150, delayMs: 300, gain: 0.5 }] },
  // drone_down (round 2, AUD-11): low-pass 400 → 1 200 Hz, gain 0.7 → 0.45, + a square an octave up band-passed at 800 Hz so the game-over
  // drop (J18) reads on a phone speaker (−5 dB, was −15)
  drone_down: { layers: [{ src: 'sawtooth', f: 110, fEnd: 55, ms: 1200, attack: 10, decay: 600, filter: { type: 'lowpass', f: 1200 }, gain: 0.45 },
                         { src: 'square', f: 220, fEnd: 110, ms: 1200, attack: 10, decay: 600, filter: { type: 'bandpass', f: 800, q: 0.7 }, gain: 0.5 }] },
  coin: { ladder: { semitones: 1, windowMs: MUSIC.coinLadderMs }, layers: [{ src: 'sine', f: 1760, ms: 80, gain: 0.45 }, { src: 'sine', f: 2637, ms: 50, gain: 0.3 }] },
  ui_tap: { noTimeScale: true, layers: [{ src: 'sine', f: 880, ms: 40, gain: 0.4 }] },
  ui_buy: { noTimeScale: true, layers: [{ src: 'triangle', f: hz(N.C5), ms: 100, gain: 0.5 }, { src: 'triangle', f: hz(N.E5), ms: 100, delayMs: 100, gain: 0.5 }] },
  ui_star: { noTimeScale: true, layers: [{ src: 'triangle', f: 1319, ms: 120, gain: 0.5 }] },
});

// ==== HINTS ==================================================================================
// GDD §11 / §1.1 tutorial hints; ARCHITECTURE §8.8 / §6.16 (once ever, persisted by save.markHint).
export const HINTS = deepFreeze({
  steer: 'DRAG TO STEER',
  steerDesktop: 'DRAG OR ← → TO STEER',                 // shown instead of `steer` with a fine pointer / no touch (ui)
  shoot: 'SHOOT THE GATE!',
  more: 'MORE SOLDIERS!',
  bite: 'ZOMBIES BITE!',
  x2: n => `×${n > 1 ? n : 2} MULTIPLIES YOUR SQUAD`,   // QA LVL-33: template (level passes the pass's effective multiplier), gate glyph ×
  tryx2: 'TRY THE ×2 NEXT TIME',                        // QA LVL-33: U+00D7, the gates' operator glyph
  crate: 'GRAB THE CRATE',
  // round-3 FTUE: a no-break space before each em dash, so a two-line hint breaks after the dash ("… ACID —" / "SHOOT …"),
  // never with a line that starts with it
  red: 'RED TAKES SOLDIERS\u00A0— SHOOT IT BLUE OR AVOID IT',
  // round-4 (r3 FTUE §6.2, the ÷ ladder was never taught): level shows this when the first ÷ lane that can still flip to
  // ×2 spawns (GATE_RULES.div: ÷3 → ÷2 → ×1 → flipTo ×2). Two lines at 390 px ("SHOOT ÷ TO CLIMB:" / the ladder; the
  // lead's longer "… — KEEP SHOOTING" took three lines of the pill); no-break spaces leave one break opportunity, after
  // the colon, since #hint-text's text-wrap: balance otherwise splits "SHOOT ÷ TO / CLIMB: …".
  div: 'SHOOT\u00A0÷\u00A0TO\u00A0CLIMB: ÷2\u00A0→\u00A0×1\u00A0→\u00A0×2',
  boss: 'SHOOT THE BOSS',
  dodge: 'STEER CLEAR OF THE MARKS!',                     // round-3 FTUE: the first telegraphed boss attack (red ring / stripe / band, the Queen's green acid marks)
  spitter: 'SPITTERS LOB ACID\u00A0— SHOOT THEM FIRST',
  single: 'NO WAY AROUND\u00A0— SHOOT IT DOWN',
  brute: 'BRUTES KEEP BITING\u00A0— FOCUS FIRE',
  // round-3 FTUE: the first pickup of each special names it (hint id = item id, once ever; a duplicate never shows it) —
  // a new HUD pill, a shield counter or a new trooper appeared with no word on what it does
  'weapon.shotgun': 'SHOTGUN! WIDE SPREAD, SHORT RANGE',
  'weapon.minigun': 'MINIGUN! TRIPLE FIRE RATE',
  'weapon.rocket': 'ROCKETS! THEY BLAST WHOLE GROUPS',
  'weapon.railgun': 'RAILGUN! EACH BOLT PIERCES THE ROAD',
  'weapon.laser': 'LASERS! BEAMS PIERCE EVERY ZOMBIE',
  'gear.armor': 'ARMOR! EACH PLATE STOPS A BITE',
  'gear.magnet': 'MAGNET! COINS FLY TO YOU',
  'gear.chip': 'FIRE-RATE CHIP! SHOOT FASTER',
  'gear.booster': 'DAMAGE BOOST! BULLETS HIT HARDER',
  'troop.sniper': 'A SNIPER JOINS YOUR SQUAD!',
  'troop.medic': 'A MEDIC JOINS\u00A0— HE BRINGS BACK SOLDIERS',
  'troop.flamer': 'A FLAMETHROWER JOINS YOUR SQUAD!',
  'troop.drone': 'A DRONE TURRET JOINS YOUR SQUAD!',
  'troop.apc': 'AN APC JOINS\u00A0— IT SOAKS UP BITES',
});

// ==== STRINGS ================================================================================
// GDD §14 UI copy; ARCHITECTURE §4.1 (noWebGL2), §9.5 (reloadingGfx), §12 (volatileSave), §15 (noImportMap), §10.
// Plain strings are used as-is; parameterised copy is a template FUNCTION (args in the comment).
// Hints live in HINTS, boss names in BOSSES.archetypes[*].name, upgrade names/formats in UPGRADES.
// Round-3 polish (GDD §14 UI-33 "one spelling"): every visible level label — HUD, title caption, results title, game
// over — is built from this one template ("LEVEL 7"); screen-reader labels (aria.level) stay in sentence case.
const LEVEL_NAME = n => `LEVEL ${n}`;
export const STRINGS = deepFreeze({
  // contract keys (flat)
  noWebGL2: 'This browser cannot run 3D graphics (WebGL 2). Try Chrome or Safari.',
  noImportMap: 'This browser cannot load the game (no import maps).',
  volatileSave: "Progress won't be saved in this browser",
  reloadingGfx: 'Reloading graphics…',
  // screens
  game: 'GATE RUSH',
  boot: { logo: 'GATE RUSH', text: 'Building the apocalypse…',
          // UI-29: one caption per real boot step (ui.setBootCaption(i), called by main): page, textures, models, audio, systems,
          // shaders, and (round 3) the UI first-raster prewarm
          steps: ['Building the apocalypse…', 'Painting the road…', 'Raising the dead…', 'Tuning the sirens…', 'Rallying the squad…', 'Warming up the guns…', 'Polishing the medals…'] },
  title: { play: 'PLAY', shop: 'SHOP', levels: 'LEVELS', endless: 'ENDLESS',
           caption: (level, stars) => (stars > 0 ? `${LEVEL_NAME(level)} · Best ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}` : LEVEL_NAME(level)),   // "LEVEL 7 · Best ★★★"
           version: v => `v${v}` },
  hud: { level: LEVEL_NAME, endless: 'ENDLESS', shield: n => `${n}`, infinity: '∞', seconds: s => `${s}s` },
  pause: { title: 'PAUSED', resume: 'RESUME', restart: 'RESTART', settings: 'SETTINGS', quit: 'QUIT' },
  settings: { title: 'SETTINGS', sound: 'Sound', music: 'Music', haptics: 'Haptics', quality: 'Quality',
              qualityOptions: { auto: 'Auto', low: 'Low', med: 'Med', high: 'High' },
              reducedMotion: 'Reduced motion', hcGates: 'High-contrast gates', largeText: 'Large text',
              sensitivity: 'Drag sensitivity', sensitivityOptions: { '0.75': '0.75', '1': '1', '1.3': '1.3' },
              resetSave: 'RESET SAVE', confirmReset: 'TAP AGAIN TO CONFIRM', back: 'BACK' },
  shop: { title: 'SHOP', buy: 'BUY', max: 'MAX', back: 'BACK',
          available: 'upgrade available',                                          // round-3 FTUE: aria-label suffix of a badged SHOP button
          delta: (name, from, to) => `${name} ${from} → ${to}`,                      // "Fire rate 2.0/s → 2.2/s"
          estimate: runs => (runs === 1 ? '+1 run' : `+${runs} runs`),               // ceil((cost − coins) / lastRunIncome)
          rank: (n, max) => `${n}/${max}` },
  levels: { title: 'LEVELS', endless: 'ENDLESS', locked: 'Locked', boss: 'Boss level', back: 'BACK', tile: n => `${n}` },
  complete: { title: n => `${LEVEL_NAME(n)} CLEAR`, coins: n => `Coins +${n}`,
              breakdown: { kills: 'Kills', gates: 'Gates', piles: 'Piles', boss: 'Boss', bonus: 'Bonus' },
              breakdownLine: (label, n) => `${label} +${n}`,
              best: n => `Best survivors at boss: ${n}`, survivors: n => `${n} survivors`,
              newBest: 'NEW BEST!',                                                    // round-3 FTUE: a run that beats the level's earlier best
              next: 'NEXT', replay: 'REPLAY', shop: 'SHOP' },
  gameover: { title: 'SQUAD LOST', level: LEVEL_NAME, info: (pct, kept) => `Reached ${pct} % · Coins kept +${kept}`, retry: 'RETRY', shop: 'SHOP', home: 'HOME' },   // level: the kicker above the title (round 3)
  endless: { title: 'RUN OVER', distance: m => `Distance ${m} m`, score: s => `Score ${s}`, best: b => `Best ${b}`, coins: c => `Coins +${c}`,
             newBest: 'NEW BEST!', retry: 'RETRY', home: 'HOME' },
  boss: { label: 'BOSS', phase: n => `Phase ${n}` },
  errors: { loadError: 'Load error', fatal: 'Something broke. Reload to continue.', generic: 'Something went wrong',
            listener: name => `Listener error in ${name}`, reload: 'RELOAD', contextLost: 'Reloading graphics…' },
  update: { ready: 'Update ready — tap to reload', aria: 'Update ready. Reload to update the game' },   // round 5 (ui): the title pill when sw.js has a new build waiting
  aria: { pause: 'Pause', settings: 'Settings', fullscreen: 'Fullscreen', back: 'Back', close: 'Close', star: 'Star', coins: 'Coins', home: 'Home', level: n => `Level ${n}` },   // home: the results screens' HOME icon (round 4)
  common: { back: 'BACK', ok: 'OK', coins: 'coins', star: '★', starEmpty: '☆', separator: ' · ', plus: n => `+${n}`, minus: n => `−${n}`, times: n => `x${n}` },
});
