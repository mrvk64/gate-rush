// js/fxmaterials.js — GATE RUSH: the two fx ShaderMaterials (GPU particles, instanced ground decals).
//
// Owner: the fx engineer (render split, lead decision). js/materials.js (MaterialLibrary) delegates
// `particle(variant)` → makeParticleMaterial(ctx, variant) and `decal()` → makeDecalMaterial(ctx) and caches
// the results; js/fx.js is the only writer of the per-instance attributes documented below. Nothing in this
// file touches document / window / navigator, and nothing runs at import time except building the GLSL
// strings and the frozen colour table.
//
// Contract: docs/ARCHITECTURE.md §6.3 (MaterialLibrary.particle / decal), §6.12 (Fx ownership), §9.1 / §9.2
// (meshes, per-instance data), §9.4 (HDR / tone mapping: additive fx colours are linear HDR and bloom on
// High / Medium; on Low they are toneMapped:false so they clip to white like every other HDR material),
// §14 (rules). Colours come from data.js PALETTE (sRGB hex → linear through THREE.Color).
//
// ---------------------------------------------------------------------------------------------------
// PARTICLES — makeParticleMaterial(ctx, 'add' | 'norm')   (aliases: 'additive' / 'normal'; default 'add')
//   Geometry: PlaneGeometry(1, 1) (position.xy ∈ ±0.5, uv) on an InstancedMesh at the identity transform;
//   the instance matrices are ignored (all positions are world-space attributes).
//   Per-instance attributes (InstancedBufferAttribute, written ONCE per spawned particle by fx.emit):
//     p0    vec3  spawn position (m, world)
//     v0    vec3  initial velocity (m/s) — subject to the kind's linear drag
//     pLife vec4  (birth = uTime seconds at spawn, life s, size m, colorIdx into FX_COLORS)
//     pKind vec4  (kind 0..10, gravity m/s² along +y (negative = falls), seed 0..1, carry m/s along +z)
//                 `carry` is the road scroll the particle rides with (NOT damped by drag), so debris left on
//                 the road keeps moving with the road while its own velocity dies out.
//   Vertex shader: t = uTime − birth; u = t / life; t < 0 or u ≥ 1 → the quad is collapsed outside the clip
//   volume (no fragments). Position p = p0 + v0·(1 − e^(−k·t))/k + (0, ½·g·t², carry·t) (k = per-kind drag),
//   ground kinds clamp y ≥ 4 cm, confetti flutters. Camera-facing billboard in view space (modelViewMatrix
//   basis): sparks / gold are stretched along their projected velocity, shards / confetti / smoke / dust /
//   flame / muzzle rotate by seed, everything else is a round sprite. Size and alpha over life and the HDR
//   brightness curve are per kind (table in PARTICLE_VERT).
//   Fragment: soft disc from textures.particle (alpha), noisy puff from textures.smoke (smoke, dust, flame),
//   soft square (shard, confetti), four-point star (coinSparkle); colour = uColors[colorIdx] × brightness;
//   linear fog (additive: fades to black, normal: mixes to the fog colour).
//   Kinds (PARTICLE_KIND): 0 spark, 1 blood, 2 muzzle, 3 smoke, 4 gold, 5 shard, 6 confetti, 7 dust, 8 flame,
//   9 splash, 10 coinSparkle. The fx mesh split (ARCH §6.12): additive = spark / muzzle / gold /
//   flame / coinSparkle; normal = blood / smoke / splash / shard / dust / confetti (LDR paper, VIS-6).
//
// DECALS — makeDecalMaterial(ctx)   (additive, depthWrite false, polygon offset, fog)
//   Geometry: PlaneGeometry(1, 1) on an InstancedMesh; instance matrix = translation (x, 0, z) only.
//   Per-instance attributes:
//     iDecal  vec4  (kind 0 ring / 1 arc / 2 lane / 3 splat / 4 xband, progress 0..1, size m, colorIdx)
//                   size = DIAMETER for ring / arc / splat, stripe WIDTH for lane / xband
//     iDecalB vec4  (fade 0..1 (fade-in / fade-out envelope written by fx), age s, seed 0..1, unused)
//   Shapes (all procedural, one draw): ring = telegraph / gauge (pulsing outline, radial fill growing with
//   progress, clockwise angular gauge from the far point); arc = spit landing marker (rotating dashed circle,
//   disc filling with progress, crosshair); lane = lane highlight stripe from DECAL_LANE_Z[0] to
//   DECAL_LANE_Z[1] metres along +z from the origin (toward the squad) with bright rails and chevrons flowing
//   toward the squad; splat = irregular blob seeded by `seed`, fading as progress → 1; xband = hazard-striped
//   band (width = size) from DECAL_BAND_Z[0] to DECAL_BAND_Z[1] around the origin, pulsing.
// ---------------------------------------------------------------------------------------------------
import { ShaderMaterial, Color, AdditiveBlending, NormalBlending, DoubleSide } from 'three';
import { WORLD, PALETTE } from './data.js';

// ---------------------------------------------------------------------------------------------------
// Shared FX colour table (index = colorIdx attribute of particles AND decals). Order is part of the
// contract with fx.js (and mirrors the table render.js used before the split).
// ---------------------------------------------------------------------------------------------------
export const FX_COLORS = Object.freeze([
  PALETTE.fx.spark, PALETTE.fx.muzzle, PALETTE.fx.gold, PALETTE.fx.blue, PALETTE.fx.acid, PALETTE.fx.armor,       // 0–5
  PALETTE.fx.flame, PALETTE.fx.smoke, PALETTE.fx.dust, PALETTE.fx.white, PALETTE.fx.laser, PALETTE.fx.rail,       // 6–11
  PALETTE.fx.rocket, PALETTE.fx.splash, PALETTE.blood,                                                            // 12–14
  PALETTE.fx.confetti[0], PALETTE.fx.confetti[1], PALETTE.fx.confetti[2], PALETTE.fx.confetti[3], PALETTE.fx.confetti[4], PALETTE.fx.confetti[5],   // 15–20
  PALETTE.flash.red, PALETTE.gate.plus.tint, PALETTE.gate.mult.tint, PALETTE.gate.minus.tint, PALETTE.gate.div.tint,   // 21–25
  PALETTE.gate.zero.tint, PALETTE.gate.item.tint, PALETTE.gate.max, PALETTE.boss.shield, PALETTE.ui.success, PALETTE.ui.danger,   // 26–31
]);
const NFX = FX_COLORS.length;   // 32

/** Named indices into FX_COLORS (fx.js uses these instead of literals). */
export const FX_COLOR = Object.freeze({
  spark: 0, muzzle: 1, gold: 2, blue: 3, acid: 4, armor: 5, flame: 6, smoke: 7, dust: 8, white: 9, laser: 10, rail: 11,
  rocket: 12, splash: 13, blood: 14, confetti0: 15, confettiCount: PALETTE.fx.confetti.length,
  red: 21, plus: 22, mult: 23, minus: 24, div: 25, zero: 26, item: 27, max: 28, shield: 29, success: 30, danger: 31,
});

/**
 * Index of a hex colour in FX_COLORS: exact match first, else the nearest entry by RGB distance.
 * Not for hot loops (called once per burst / decal request).
 */
export function fxColorIndex(hex) {
  const h = hex >>> 0;
  for (let i = 0; i < NFX; i++) if (FX_COLORS[i] === h) return i;
  const r = (h >> 16) & 255, g = (h >> 8) & 255, b = h & 255;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < NFX; i++) {
    const c = FX_COLORS[i];
    const dr = ((c >> 16) & 255) - r, dg = ((c >> 8) & 255) - g, db = (c & 255) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Particle kinds (pKind.x). */
export const PARTICLE_KIND = Object.freeze({
  spark: 0, blood: 1, muzzle: 2, smoke: 3, gold: 4, shard: 5, confetti: 6, dust: 7, flame: 8, splash: 9, coinSparkle: 10,
});
/** Additive (true) vs normal (false) mesh per kind index (ARCH §6.12 split; dust rides the normal mesh). */
// Confetti (6) rides the NORMAL mesh (VIS-6): 200 additive HDR flakes under the boss-death bloom pulse whited out
// the screen; as tone-mapped paper (bright ≤ 0.8 below) it reads as confetti and leaves the collapsing rig visible.
export const PARTICLE_ADDITIVE = Object.freeze([true, false, true, false, true, false, false, false, true, false, true]);
/** Decal kinds (iDecal.x). */
export const DECAL_KIND = Object.freeze({ ring: 0, arc: 1, lane: 2, splat: 3, xband: 4 });
/** Attribute names and item sizes (fx.js builds the InstancedBufferAttributes from these). */
export const PARTICLE_ATTRS = Object.freeze({ p0: 3, v0: 3, pLife: 4, pKind: 4 });
export const DECAL_ATTRS = Object.freeze({ iDecal: 4, iDecalB: 4 });

// Stripe extents along +z relative to the decal origin (m). Lane: from 2 m behind the gate to the squad
// region (|WORLD.laneDecalZ| + 4 m), so the stripe always reaches under the squad while the gate approaches
// from z = laneDecalZ; x-band (Juggernaut car): centred on the formation centre, longer toward the boss.
const DECAL_LANE_Z = [-2, -WORLD.laneDecalZ + 4];   // DATA-MISSING: JUICE.decals.laneZ (stripe extent behind / ahead of the origin, m)
const DECAL_BAND_Z = [-10, 6];                      // DATA-MISSING: JUICE.decals.bandZ (x-band extent around the origin, m)
const DECAL_Y = 0.03;                               // DATA-MISSING: JUICE.decals.y (lift above the road plane, m)
const DECAL_GAIN = 1.5;                             // DATA-MISSING: JUICE.decals.hdrGain (additive HDR gain so telegraphs bloom)

// ---------------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------------
const FOG_DECL = /* glsl */`
  uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float fogDensity;
  float grFogFactor(float depth) {
    #ifdef FOG_EXP2
      return 1.0 - exp(-fogDensity * fogDensity * depth * depth);
    #else
      return smoothstep(fogNear, fogFar, depth);
    #endif
  }
`;

const PARTICLE_VERT = /* glsl */`
  attribute vec3 p0;
  attribute vec3 v0;
  attribute vec4 pLife;      // birth, life, size, colorIdx
  attribute vec4 pKind;      // kind, gravity, seed, carry
  uniform float uTime;
  uniform vec3 uColors[${NFX}];
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vKind;
  varying float vFogDepth;
  void main() {
    vUv = uv;
    vKind = pKind.x;
    float life = pLife.y;
    float t = uTime - pLife.x;
    float u = life > 0.0 ? t / life : 2.0;
    if (t < 0.0 || u >= 1.0) {
      vColor = vec3(0.0); vAlpha = 0.0; vFogDepth = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);             // outside the clip volume: zero fragments
      return;
    }
    int k = int(pKind.x + 0.5);
    float seed = pKind.z;
    vec3 col = uColors[int(pLife.w + 0.5)];
    float drag = 0.0, sizeK = 1.0, alpha = 1.0, bright = 1.0, spinRate = 0.0;
    bool streak = false, spin = false, ground = false;
    if (k == 0) {                // spark: hot streak, shrinks, HDR
      drag = 2.2; streak = true; sizeK = 1.0 - 0.6 * u; alpha = 1.0 - smoothstep(0.55, 1.0, u); bright = 2.6 - 1.4 * u;
    } else if (k == 1) {         // blood: heavy droplets that land
      drag = 1.2; ground = true; sizeK = 1.0 - 0.35 * u; alpha = 1.0 - smoothstep(0.6, 1.0, u); bright = 1.0 - 0.3 * u;
    } else if (k == 2) {         // muzzle / blast flash: grows and fades fast
      spin = true; sizeK = 0.7 + 0.6 * u; alpha = (1.0 - u) * (1.0 - u); bright = 3.0;
    } else if (k == 3) {         // smoke: grows, slow turn, soft in / out
      drag = 1.6; spin = true; spinRate = 0.6; sizeK = 1.0 + 1.8 * u; alpha = smoothstep(0.0, 0.12, u) * (1.0 - u) * 0.6;
    } else if (k == 4) {         // gold: sparkling streaks that land
      // HDR capped at 1.2 (VIS-6): the 60-coin boss fountain must sparkle, not glare under the death bloom pulse
      drag = 0.7; streak = true; ground = true; sizeK = 1.0 - 0.3 * u; alpha = 1.0 - smoothstep(0.7, 1.0, u);
      bright = (1.2 - 0.4 * u) * (0.7 + 0.3 * sin(uTime * 22.0 + seed * 40.0));
    } else if (k == 5) {         // shard: tumbling flake
      drag = 0.4; spin = true; spinRate = 9.0; ground = true; alpha = 1.0 - smoothstep(0.7, 1.0, u); bright = 1.2;
    } else if (k == 6) {         // confetti: fluttering paper
      drag = 1.4; spin = true; spinRate = 7.0; alpha = 1.0 - smoothstep(0.82, 1.0, u); bright = 0.8;   // LDR paper (VIS-6)
    } else if (k == 7) {         // dust: ground puff
      drag = 2.6; spin = true; spinRate = 0.4; sizeK = 1.0 + 1.5 * u; alpha = smoothstep(0.0, 0.1, u) * (1.0 - u) * 0.55;
    } else if (k == 8) {         // flame: white-hot core → flame colour → dark ember
      drag = 0.9; spin = true; spinRate = 2.0; sizeK = (0.6 + 1.2 * u) * (1.0 - 0.4 * u * u); alpha = pow(max(1.0 - u, 0.0), 1.4);
      col = mix(vec3(1.0, 0.92, 0.65), col, smoothstep(0.0, 0.45, u));
      col = mix(col, vec3(0.25, 0.08, 0.02), smoothstep(0.6, 1.0, u));
      bright = 2.8 - 2.0 * u;
    } else if (k == 9) {         // splash: acid droplets that land
      drag = 1.0; ground = true; sizeK = 1.0 - 0.25 * u; alpha = 1.0 - smoothstep(0.5, 1.0, u); bright = 1.3;
    } else {                     // coinSparkle: twinkling star
      drag = 2.0; spin = true; spinRate = 3.0; sizeK = 0.6 + 0.6 * abs(sin(uTime * 16.0 + seed * 30.0));
      alpha = 1.0 - smoothstep(0.6, 1.0, u); bright = 1.2;                                              // capped (VIS-6)
    }
    float tt = drag > 0.0 ? (1.0 - exp(-drag * t)) / drag : t;
    vec3 p = p0 + v0 * tt;
    p.y += 0.5 * pKind.y * t * t;
    p.z += pKind.w * t;
    if (k == 6) {
      p.x += sin(uTime * 6.0 + seed * 31.0) * 0.35 * u;
      p.z += cos(uTime * 4.7 + seed * 17.0) * 0.3 * u;
    }
    if (ground) p.y = max(p.y, 0.04);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec2 q = position.xy;
    if (streak) {
      vec3 vel = v0 * exp(-drag * t) + vec3(0.0, pKind.y * t, 0.0);
      vec2 sv = (modelViewMatrix * vec4(vel, 0.0)).xy;
      float sl = length(sv);
      vec2 dir = sl > 0.0001 ? sv / sl : vec2(0.0, 1.0);
      float st = 1.0 + min(sl * 0.07, 3.0);
      q = dir * (q.y * st) + vec2(-dir.y, dir.x) * q.x;
    } else if (spin) {
      float a = seed * 6.2831853 + t * spinRate * (seed > 0.5 ? 1.0 : -1.0);
      float c = cos(a), s = sin(a);
      if (k == 6) q.x *= 0.55;
      if (k == 5) q.y *= 0.7;
      q = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
    }
    mv.xy += q * pLife.z * sizeK;
    vColor = col * bright;
    vAlpha = alpha;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */`
  uniform sampler2D uMap;      // textures.particle (soft disc in alpha)
  uniform sampler2D uSmoke;    // textures.smoke (soft blob × noise in alpha)
  uniform vec2 uHasMaps;       // (particle map present, smoke map present)
  ${FOG_DECL}
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vKind;
  varying float vFogDepth;
  float grDisc(vec2 uv) { float d = length(uv - 0.5) * 2.0; return 1.0 - smoothstep(0.3, 1.0, d); }
  void main() {
    if (vAlpha <= 0.002) discard;
    int k = int(vKind + 0.5);
    float texA;
    if (k == 3 || k == 7) {
      texA = uHasMaps.y > 0.5 ? texture2D(uSmoke, vUv).a : grDisc(vUv) * grDisc(vUv);
    } else if (k == 5 || k == 6) {
      vec2 e = abs(vUv - 0.5) * 2.0;
      texA = 1.0 - smoothstep(0.78, 1.0, max(e.x, e.y));
    } else if (k == 10) {
      vec2 c = (vUv - 0.5) * 2.0;
      float star = (1.0 - smoothstep(0.0, 0.14, abs(c.x))) * (1.0 - smoothstep(0.2, 1.0, abs(c.y)))
                 + (1.0 - smoothstep(0.0, 0.14, abs(c.y))) * (1.0 - smoothstep(0.2, 1.0, abs(c.x)));
      texA = clamp(max(grDisc(vUv) * 0.7, star), 0.0, 1.0);
    } else {
      texA = uHasMaps.x > 0.5 ? texture2D(uMap, vUv).a : grDisc(vUv);
    }
    float a = texA * vAlpha;
    if (a < 0.003) discard;
    vec3 col = vColor;
    #ifdef USE_FOG
      float ff = grFogFactor(vFogDepth);
      #ifdef GR_ADDITIVE
        col *= 1.0 - ff;
      #else
        col = mix(col, fogColor, ff);
      #endif
    #endif
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const DECAL_VERT = /* glsl */`
  attribute vec4 iDecal;       // kind, progress, size, colorIdx
  attribute vec4 iDecalB;      // fade, age, seed, -
  uniform vec3 uColors[${NFX}];
  uniform vec2 uLaneZ;         // lane stripe extent along +z (m)
  uniform vec2 uBandZ;         // x-band extent along +z (m)
  uniform float uLift;         // height above the road (m)
  varying vec2 vUv;
  varying vec4 vDecal;
  varying vec3 vColor;
  varying float vFade;
  varying float vSeed;
  varying float vZ;            // local z along the stripe (m) for lane / xband patterns
  varying float vW;            // stripe width (m)
  varying float vFogDepth;
  void main() {
    vUv = uv;
    vDecal = iDecal;
    vColor = uColors[int(iDecal.w + 0.5)];
    vFade = iDecalB.x;
    vSeed = iDecalB.z;
    int k = int(iDecal.x + 0.5);
    float size = iDecal.z;
    vW = size;
    vec3 local;
    if (k == 2) {
      vZ = mix(uLaneZ.x, uLaneZ.y, uv.y);
      local = vec3(position.x * size, 0.0, vZ);
    } else if (k == 4) {
      vZ = mix(uBandZ.x, uBandZ.y, uv.y);
      local = vec3(position.x * size, 0.0, vZ);
    } else {
      vZ = -position.y * size;
      local = vec3(position.x * size, 0.0, -position.y * size);   // uv.y = 1 at the far (−z) edge
    }
    #ifdef USE_INSTANCING
      vec4 wp = instanceMatrix * vec4(local, 1.0);
    #else
      vec4 wp = vec4(local, 1.0);
    #endif
    wp.y += uLift;
    vec4 mv = modelViewMatrix * wp;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const DECAL_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uGain;
  ${FOG_DECL}
  varying vec2 vUv;
  varying vec4 vDecal;
  varying vec3 vColor;
  varying float vFade;
  varying float vSeed;
  varying float vZ;
  varying float vW;
  varying float vFogDepth;
  void main() {
    int k = int(vDecal.x + 0.5);
    float prog = clamp(vDecal.y, 0.0, 1.0);
    vec2 c = (vUv - 0.5) * 2.0;                 // unit disc coordinates; c.y > 0 = far (−z) side
    float r = length(c);
    float aa = fwidth(r) * 1.5 + 0.002;
    float pulse = 0.85 + 0.15 * sin(uTime * 7.0);
    float alpha = 0.0;
    vec3 col = vColor;
    if (k == 0) {
      // ring: telegraph (radial fill growing with progress) + clockwise gauge band from the far point
      float outline = 1.0 - smoothstep(0.055 - aa, 0.055 + aa, abs(r - 0.93));
      float a01 = fract(atan(c.x, c.y) / 6.2831853);
      float af = fwidth(a01) + 0.001;
      float gauge = (1.0 - smoothstep(0.045 - aa, 0.045 + aa, abs(r - 0.8))) * (1.0 - smoothstep(prog - af, prog + af, a01)) * step(0.001, prog);
      float fillR = prog * 0.93;
      float fill = (1.0 - smoothstep(fillR - aa, fillR + aa, r)) * (0.16 + 0.34 * prog * prog);
      float front = (1.0 - smoothstep(0.03 - aa, 0.03 + aa, abs(r - fillR))) * step(0.02, prog) * step(r, 0.95);
      float full = step(0.999, prog);
      float strobe = full * (1.0 - smoothstep(0.88, 0.95, r)) * (0.2 + 0.2 * sin(uTime * 30.0));
      alpha = outline * (0.7 * pulse + 0.3 * full) + gauge * 0.9 + fill + front * 0.7 + strobe;
      col *= 1.0 + gauge * 0.6 + front * 0.5;
    } else if (k == 1) {
      // arc: spit landing marker — rotating dashed circle, disc filling with progress, crosshair
      float a01 = fract(atan(c.x, c.y) / 6.2831853 + uTime * 0.35);
      float dash = step(0.45, fract(a01 * 12.0));
      float ringA = (1.0 - smoothstep(0.05 - aa, 0.05 + aa, abs(r - 0.9))) * dash;
      float disc = (1.0 - smoothstep(prog * 0.9 - aa, prog * 0.9 + aa, r)) * (0.18 + 0.45 * prog);
      float crossH = (1.0 - smoothstep(0.03, 0.03 + aa, min(abs(c.x), abs(c.y)))) * (1.0 - smoothstep(0.32, 0.42, r)) * 0.6;
      alpha = ringA * 0.95 + disc + crossH;
      col *= 1.0 + 0.5 * prog;
    } else if (k == 2) {
      // lane highlight: soft fill, bright rails, chevrons flowing toward the squad (+z), faded ends
      float ax = abs(c.x);
      float edge = 1.0 - smoothstep(0.86, 1.0, ax);
      float rail = smoothstep(0.7, 0.86, ax) * edge;
      float chev = smoothstep(0.55, 0.7, fract(vZ * 0.45 + ax * vW * 0.18 - uTime * 1.6));
      float ends = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.78, 1.0, vUv.y));
      alpha = (0.12 + 0.14 * chev + 0.55 * rail) * edge * ends * (0.85 + 0.15 * pulse);
      col *= 1.0 + 0.6 * rail;
    } else if (k == 3) {
      // splat: irregular blob + satellite droplets, fading with progress
      float ang = atan(c.x, c.y);
      float s = vSeed * 6.2831853;
      float rr = 0.7 + 0.12 * sin(ang * 5.0 + s) + 0.07 * sin(ang * 9.0 + s * 1.7) + 0.05 * sin(ang * 13.0 + s * 2.3);
      float blob = 1.0 - smoothstep(rr - 0.1, rr, r);
      vec2 d1 = c - 0.86 * vec2(sin(s * 3.1), cos(s * 3.1));
      vec2 d2 = c - 0.8 * vec2(sin(s * 5.3 + 2.0), cos(s * 5.3 + 2.0));
      float drops = (1.0 - smoothstep(0.07, 0.11, length(d1))) + (1.0 - smoothstep(0.05, 0.08, length(d2)));
      alpha = (blob * (0.5 + 0.3 * (1.0 - r)) + drops * 0.6) * (1.0 - prog);
    } else {
      // x-band: hazard-striped band with bright borders, pulsing
      float ax = abs(c.x);
      float edge = 1.0 - smoothstep(0.86, 1.0, ax);
      float border = smoothstep(0.72, 0.86, ax) * edge;
      float hz = step(0.5, fract((vZ + c.x * vW * 0.5) * 0.8 - uTime * 1.5));
      float ends = smoothstep(0.0, 0.1, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y));
      alpha = (0.14 + 0.26 * hz + 0.6 * border) * edge * ends * pulse;
      col *= 1.0 + 0.4 * border;
    }
    alpha *= vFade;
    #ifdef USE_FOG
      col *= 1.0 - grFogFactor(vFogDepth);
    #endif
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(col * uGain, clamp(alpha, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------------------------------
// Construction helpers (construction time only)
// ---------------------------------------------------------------------------------------------------
const _c = new Color();

/** FX_COLORS → linear Float32Array(NFX·3) for the `vec3 uColors[NFX]` uniform. */
function linearColorTable() {
  const out = new Float32Array(NFX * 3);
  for (let i = 0; i < NFX; i++) {
    _c.setHex(FX_COLORS[i]);
    out[i * 3] = _c.r; out[i * 3 + 1] = _c.g; out[i * 3 + 2] = _c.b;
  }
  return out;
}

/** The shared uTime uniform object (=== ctx.render.uniforms.uTime), or a private one in a stub harness. */
function sharedTime(ctx) {
  const r = ctx && ctx.render;
  if (r && r.uniforms && r.uniforms.uTime) return r.uniforms.uTime;
  return { value: 0 };
}

/** Linear fog uniforms (refreshed by three when material.fog is true and the scene has fog). */
function fogUniforms() {
  return {
    fogColor: { value: new Color(PALETTE.fog) },
    fogNear: { value: WORLD.fog.near },
    fogFar: { value: WORLD.fog.far },
    fogDensity: { value: 0.00025 },   // only read under FOG_EXP2 (the game uses linear Fog)
  };
}

// ---------------------------------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------------------------------

/**
 * GPU particle material (see the header for the attribute contract).
 * @param {object} ctx   game context (reads ctx.render.uniforms.uTime, ctx.render.textures.particle / smoke)
 * @param {'add'|'additive'|'norm'|'normal'} [variant='add']
 * @returns {ShaderMaterial}
 */
export function makeParticleMaterial(ctx, variant) {
  const additive = !(variant === 'norm' || variant === 'normal');
  const tex = ctx && ctx.render && ctx.render.textures ? ctx.render.textures : null;
  const map = tex && tex.particle ? tex.particle : null;
  const smoke = tex && tex.smoke ? tex.smoke : null;
  const uniforms = Object.assign(fogUniforms(), {
    uColors: { value: linearColorTable() },
    uHasMaps: { value: [map ? 1 : 0, smoke ? 1 : 0] },
  });
  // shared objects assigned after construction of the plain values so nothing is deep-cloned
  uniforms.uTime = sharedTime(ctx);
  uniforms.uMap = { value: map };
  uniforms.uSmoke = { value: smoke };
  const m = new ShaderMaterial({
    name: additive ? 'gr.fx.particles.add' : 'gr.fx.particles.norm',
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    uniforms,
    defines: additive ? { GR_ADDITIVE: 1 } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: additive ? AdditiveBlending : NormalBlending,
    side: DoubleSide,
    // camera-facing quads: one pass (three's DoubleSide + transparent two-pass path re-resolves the program twice a frame, QA FX-2)
    forceSinglePass: true,
    fog: true,
    // additive colours are linear HDR (bloom on High/Medium, clip on Low like every HDR material, ARCH §9.4);
    // the normal variant (blood, smoke, dust …) goes through the scene's ACES like lit surfaces
    toneMapped: !additive,
  });
  return m;
}

/**
 * Instanced ground-decal material (see the header for the attribute contract).
 * @param {object} ctx game context (reads ctx.render.uniforms.uTime)
 * @returns {ShaderMaterial}
 */
export function makeDecalMaterial(ctx) {
  const uniforms = Object.assign(fogUniforms(), {
    uColors: { value: linearColorTable() },
    uLaneZ: { value: [DECAL_LANE_Z[0], DECAL_LANE_Z[1]] },
    uBandZ: { value: [DECAL_BAND_Z[0], DECAL_BAND_Z[1]] },
    uLift: { value: DECAL_Y },
    uGain: { value: DECAL_GAIN },
  });
  uniforms.uTime = sharedTime(ctx);
  const m = new ShaderMaterial({
    name: 'gr.fx.decals',
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    forceSinglePass: true,   // flat ground quads: one pass, no back/front double draw (QA FX-2)
    fog: true,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return m;
}
