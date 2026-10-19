// js/environment.js — GATE RUSH world dressing: Environment (sky dome, ground, road ring, curbs,
// roadside props, dust motes, smoke columns) and makeSkyMaterial(ctx).
//
// Contract: docs/ARCHITECTURE.md §6.3 (Environment class shape), §9.1 (scene graph), §9.2 (props are
// matrix-only instanced meshes rewritten on scroll), §9.3 (fog, casters/receivers), §14 (coding rules);
// docs/GDD.md §2 (ring, fog), §15 (palette: sky stops, sun disc, road, props, dust), §16 (prop density,
// dust, smoke per tier). Render split (lead decision): render.js re-exports `Environment` from this file
// and MaterialLibrary.sky() delegates to makeSkyMaterial(ctx).
//
// Construction (inside RenderSystem.init, after TextureFactory + MaterialLibrary + applyQuality):
//   this.env = new Environment(ctx); this.env.build();
// Reads at build time: ctx.render.scene / textures (road, facade, windows) / materials.sky() / uniforms.uTime,
// ctx.quality.params, ctx.events (quality:change). The smoke columns use procedural noise (see SMOKE_FRAG). ctx.models does NOT exist yet at that point (main.js
// boot step 6 runs after render step 5), so District 1's prop geometries are built here (feet at y = 0, linear `color`
// attribute, uv kept). The 16 district kinds (docs/DISTRICTS.md §7) are models.js geometries, adopted lazily as view
// geometries (shared BufferAttributes) by warmDistricts() (called from ModelLibrary.init), districtWarmList() or the
// first setDistrict().
//
// Districts (round 5, docs/DISTRICTS.md §3 / §6.2 / §7; ARCHITECTURE §6.3 / §8.10):
//   env.setDistrict(district, seconds)  0 = snap (uniforms, weather theme, skyline columns, slot geometry swaps, ring
//                                       re-laid); > 0 = fade on the theatre clock (uniform lerps, fog near / far, swap dip
//                                       for weather + skyline, lamps lit and blink rate at 0.5, slot drain → swap → refill)
//   env.districtWarmList(out)           every (slot mesh, alternative geometry) pair (render.warmup contract)
//   env.warmDistricts()                 hidden warm proxies so the existing warm-up draws upload every district geometry
//   env.district                        the target district
// Zero extra draw calls: 8 prop slots (+ manhole, curbs), one dust Points; a slot swaps its geometry, never its material;
// no new programs except 'gr:road' (compiled at boot); every district difference is a uniform, a geometry or instance data.
//
// Per-frame contract for RenderSystem.update(dt) (ARCH §4.2 E):
//   env.scroll(ctx.world.roadSpeed * dt);   // moves road ring, curbs, props, smoke; recycles segments
//   env.update(dt);                          // fog lerp (real time); safe to call in every state
// plus env.applyQuality(params) on a tier change (Environment also listens to quality:change itself; both
// paths are idempotent). Both per-frame calls are allocation-free; the once-per-frame work (fog lerp) is
// guarded by ctx.time.frame, so calling either one, or both, is correct. The sky dome and the dust box follow the camera from their own
// onBeforeRender hooks (exact for any camera: follow preset, dolly, game-over orbit).
//
// Scrolling scheme (zero per-frame buffer uploads): every ring InstancedMesh (8 props + curbs) shares one
// anchor `_anchor` = mesh.position.z; instance matrices hold z relative to it and are rewritten only when a
// segment is recycled (one 30 m segment every 30 m of road) or when the anchor is rebased (every
// REBASE_M metres). Road segments are 6 plain meshes moved every frame. The ground pattern and the dust
// motes scroll in-shader from the travelled distance (periodic, so the wrap is seamless).
//
// Per-instance attribute contracts of the materials in this file:
//   lamppost / barricade meshes: iEmit float (0 = unlit, 1 = lit); vertex colours above 1.0 encode
//   emissive radiance (excess over 1.0), e.g. lamp lenses and barricade beacons; barricade beacons blink.
//   building mesh: facade/windows UVs are box-mapped in the vertex shader from the instance-scaled object
//   position (RENDER facade tile = 6 m × 6 m, 2 storeys × 4 windows), so window size never stretches
//   with the instance scale; vertex colour r ≥ 0.95 marks wall surfaces (lit windows allowed).
//   smoke mesh: instance matrix = translation (base of the column) + scale (width, height, 1); the vertex
//   shader billboards it around Y.

import {
  Mesh, InstancedMesh, Points, BufferGeometry, Float32BufferAttribute, InstancedBufferAttribute,
  PlaneGeometry, SphereGeometry, BoxGeometry, CylinderGeometry, CircleGeometry, RingGeometry,
  MeshStandardMaterial, ShaderMaterial, UniformsLib, UniformsUtils,
  Color, Vector2, Vector3, Vector4, Matrix4, Quaternion, Euler, Fog,
  BackSide, AdditiveBlending, NormalBlending, DynamicDrawUsage,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, ease, smoothstep } from './util.js';
import { WORLD, RENDER, PALETTE, QUALITY_TIERS, DISTRICTS, DISTRICT_PROPS, DISTRICT_RULES } from './data.js';

// ---------------------------------------------------------------------------------------------
// Structure derived from data.js (no tuning literals)
// ---------------------------------------------------------------------------------------------
const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;
const ENV = RENDER.env;
const SEGMENTS = WORLD.roadSegments;                                  // 6
const SEG_LEN = WORLD.segmentLength;                                  // 30 m
const RING_LEN = SEGMENTS * SEG_LEN;                                  // 180 m
const RECYCLE_Z = WORLD.segmentRecycleZ;                              // +20: a segment's near edge passing it wraps
const RING_START = RECYCLE_Z - RING_LEN;                              // −160 (ARCH §2.1 "segment k covers z ∈ [−160 + 30k …]")
const ROAD_HALF = WORLD.roadWidth / 2;                                // 4 m
const ROAD_TEX_M = RENDER.road.textureM;                              // the road texture covers 8 × 15 m
const PROP_KINDS = ['barricade', 'sandbags', 'car', 'building', 'tree', 'rubble', 'lamppost', 'smoke'];

// ---------------------------------------------------------------------------------------------
// DATA-MISSING constants (environment dressing; every value is a look/placement tunable)
// ---------------------------------------------------------------------------------------------

// DATA-MISSING: RENDER.env.layout — roadside placement bands (|x| in metres from the road centre line),
// presence chances and scale ranges for the seeded prop placement. Counts per segment are
// floor(RENDER.env.props[kind] / WORLD.roadSegments) scaled by the prop density.
const LAYOUT = Object.freeze({
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
  densityFloor: 0.6,                                                  // count = per·density·U(floor, floor + spread)
  densitySpread: 0.7,
  tintJitter: 0.1,                                                    // ±10 % per-instance brightness
});
// DATA-MISSING: RENDER.env.ground — shader ground pattern (shoulder band, dry grass, drainage ditch, curb gutter shade)
const GROUND = Object.freeze({
  grass: 0x6B6440,                                                    // dry dead grass tufts (between ground #5A4634 and tree #4A3A2E hues)
  shoulder: [5.0, 7.2],                                               // shoulder gravel band |x| from → to (fades into ground)
  ditchX: 7.6,                                                        // shallow drainage ditch line
  gutterX: ROAD_HALF + LAYOUT.curb.w,                                 // curb outer edge; darkened gutter beyond it
  periodM: 512,                                                       // pattern period along z (seamless scroll wrap)
  y: -0.03,                                                           // below the road plane (no z-fight at 100 m)
  centerZ: RECYCLE_Z + 40 - ENV.groundSize[1] / 2,                    // covers z ∈ [−340, +60]
});
// DATA-MISSING: RENDER.env.sky — sky dome extras beyond the GDD §15 stops (sun halo, cirrus, distant skyline)
const SKY = Object.freeze({
  haloWide: 0.18, haloTight: 0.45, discBoost: 3.0,                    // sun halo lobes and disc HDR boost
  horizonWarm: 0.45, awayDarken: 0.86,                                // horizon warms toward the sun azimuth, cools away from it
  cirrus: 0.4, cirrusDrift: [0.006, 0.002],                           // high cirrus opacity and drift (dome units / s)
  skylineMix: 0.3, skylineDark: 0.9, skylineCols: 42, skylineLit: 0.7,   // distant ruined skyline silhouette
});
// DATA-MISSING: RENDER.env.smokeColumn — column shader look (rise speed, lean, ember glow at the base)
const SMOKE = Object.freeze({
  rise: 0.03, riseVar: 0.02, wind: [-0.04, 0.012], alpha: 0.9, ember: 2.6, emberFlicker: 7.0, glowBounce: 0.12,
});
// DATA-MISSING: RENDER.env.lights — emissive props (lamp lenses, barricade beacons)
const LIGHTS = Object.freeze({
  lampEmissive: 2.4,                                                  // lens radiance (× PALETTE.props.windowLit, linear)
  beaconEmissive: 2.2,                                                // barricade beacon radiance (× PALETTE.ui.primary amber)
  blinkRate: 4.2, blinkDuty: [-0.2, 0.4],                             // rad/s and smoothstep window of the blink square-ish wave
});
// DATA-MISSING: RENDER.env.facadeTileM — the TextureFactory facade/windows canvases cover 6 m × 6 m (render.js comment)
const FACADE_TILE_M = 6;
// DATA-MISSING: RENDER.env.darkBuildingFraction — share of buildings with no lit windows at all
const DARK_BUILDING_FRACTION = 0.25;
// DATA-MISSING: RENDER.env.buildingBounce — warm fog-coloured fill on building facades (× fog colour, linear)
const BUILDING_BOUNCE = 0.45;
// DATA-MISSING: RENDER.env.titleSeed — prop seed used before the first level (title idle scene)
const TITLE_SEED = 1;
// RENDER.env.manhole (round-2 QA VIS-23: lifted from a local literal): road manhole covers placed per segment from the
// segment rng (VIS-11: the baked road texture repeats every 15 m, so the covers are instanced decals instead of texture
// content): up to `max` per segment, |x| band inside the lanes (m), cover radius (m), lift above the road (m), chance per slot
const MANHOLE = ENV.manhole;
// Structural (not tuning): rebase the ring anchor before float32 instance z values lose precision.
const REBASE_M = 1024;
// Structural: fallback dt for fog lerps when ctx.time is absent (tests / stub harness).
const FALLBACK_DT = WORLD.step;

// ---------------------------------------------------------------------------------------------
// Module-level scratch (never retained, never allocated per frame)
// ---------------------------------------------------------------------------------------------
const _pos = new Vector3();
const _scl = new Vector3();
const _quat = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _mat = new Matrix4();
const _col = new Color();
const _col2 = new Color();
const _v2 = new Vector2();

// Placement RNG: mulberry32 (identical to util.mulberry32) as module state, so re-seeding a recycled
// segment allocates nothing (util.mulberry32 returns a fresh closure per seed).
let _rs = 0;
function rseed(seed) { _rs = seed >>> 0; }
function rnd() {
  _rs = (_rs + 0x6D2B79F5) | 0;
  let t = Math.imul(_rs ^ (_rs >>> 15), 1 | _rs);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rrange(a, b) { return a + (b - a) * rnd(); }
function rpick2(arr) { return arr[0] + (arr[1] - arr[0]) * rnd(); }
function rside() { return rnd() < 0.5 ? -1 : 1; }

/** The ONE shared time uniform (ARCH §6.3); a private stand-in only when render has none (tests). */
function sharedTime(ctx) {
  const r = ctx && ctx.render;
  return (r && r.uniforms && r.uniforms.uTime) ? r.uniforms.uTime : { value: 0 };
}

/** sRGB hex → linear Color (fresh; build time only). */
function lin(hex) { return new Color(hex); }

// ---------------------------------------------------------------------------------------------
// Geometry helpers (build time only). Every part carries position, normal, uv, color so parts merge.
// ---------------------------------------------------------------------------------------------

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new BoxGeometry(w, h, d);
  if (rx !== 0) g.rotateX(rx);
  if (ry !== 0) g.rotateY(ry);
  if (rz !== 0) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function cyl(rTop, rBot, h, seg, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new CylinderGeometry(rTop, rBot, h, seg, 1, false);
  if (rx !== 0) g.rotateX(rx);
  if (ry !== 0) g.rotateY(ry);
  if (rz !== 0) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** Tapered limb whose base sits at (ax, ay, az), tilted `tilt` from vertical toward azimuth `az0`. */
function limb(rTop, rBot, len, seg, ax, ay, az, tilt, azim) {
  const g = new CylinderGeometry(rTop, rBot, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  g.rotateZ(tilt);
  g.rotateY(azim);
  g.translate(ax, ay, az);
  return g;
}

/** Tip of a limb() with the same parameters (for attaching sub-branches). */
function limbTip(len, ax, ay, az, tilt, azim, out) {
  // up (0,1,0) → rotateZ(tilt) → (−sin t, cos t, 0) → rotateY(a) → (−sin t·cos a, cos t, sin t·sin a)
  out.set(ax - Math.sin(tilt) * Math.cos(azim) * len, ay + Math.cos(tilt) * len, az + Math.sin(tilt) * Math.sin(azim) * len);
  return out;
}

/** Constant linear colour (components may exceed 1: emissive encoding for the lamp/beacon materials). */
function paintRGB(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = g; a[i * 3 + 2] = b; }
  geo.setAttribute('color', new Float32BufferAttribute(a, 3));
  return geo;
}

/** sRGB hex × brightness multiplier, converted to linear. */
function paint(geo, hex, mul = 1) {
  _col.setHex(hex);
  return paintRGB(geo, _col.r * mul, _col.g * mul, _col.b * mul);
}

/** Wall/roof split for building parts: side faces get `wall` (white = facade shows), up faces `roof`. */
function paintWall(geo, wall, roof) {
  const n = geo.attributes.position.count;
  const nor = geo.attributes.normal.array;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(nor[i * 3 + 1]) > 0.5 ? roof : wall;
    a[i * 3] = v; a[i * 3 + 1] = v; a[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new Float32BufferAttribute(a, 3));
  return geo;
}

/** mergeGeometries(parts, false) after checking attribute parity; disposes the parts. */
function merge(parts, label) {
  const names = Object.keys(parts[0].attributes).sort().join(',');
  for (let i = 1; i < parts.length; i++) {
    const n = Object.keys(parts[i].attributes).sort().join(',');
    if (n !== names) throw new Error('environment: attribute mismatch in "' + label + '" part ' + i + ' (' + n + ' vs ' + names + ')');
  }
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('environment: mergeGeometries failed for "' + label + '"');
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------------------------
// Prop geometries (build time). Shape constants are commented as such; colours come from PALETTE.
// Local frames: feet at y = 0; barricade long axis = local x; car length = local z (nose −z);
// building front = +z, width = x, depth = z, 3 storeys (9 m) before instance scale; lamppost arm
// points along local −x; smoke = unit quad (billboarded in-shader).
// ---------------------------------------------------------------------------------------------

/** Concrete jersey barrier (1.9 m) with a white band carrying red chevrons and an amber beacon. */
function buildBarricade() {
  const P = PALETTE.props;
  const L = 1.9;                                                    // shape: barrier length
  const parts = [
    paint(box(L, 0.25, 0.62, 0, 0.125, 0), P.barricade, 0.92),       // footing
    paint(box(L, 0.33, 0.44, 0, 0.415, 0), P.barricade),             // sloped mid (stepped)
    paint(box(L, 0.28, 0.28, 0, 0.72, 0), P.barricade, 1.04),        // top
    paint(box(L + 0.01, 0.26, 0.3, 0, 0.72, 0), P.barricadeWhite),   // reflective band (both faces)
    paint(box(L + 0.02, 0.04, 0.3, 0, 0.88, 0), P.barricade, 0.85),  // cap
  ];
  const stripes = 7;                                                 // shape: chevron count per face
  for (let i = 0; i < stripes; i++) {
    const x = -L / 2 + (i + 0.5) * (L / stripes);
    const a = (i < stripes / 2 ? 1 : -1) * 0.55;                     // chevrons point at the centre
    parts.push(paint(box(0.13, 0.25, 0.012, x, 0.72, 0.156, 0, 0, a), P.barricadeRed));
    parts.push(paint(box(0.13, 0.25, 0.012, x, 0.72, -0.156, 0, 0, -a), P.barricadeRed));
  }
  // beacon: dark housing + lens whose colour exceeds 1.0 (emissive excess, lit per instance via iEmit)
  parts.push(paint(box(0.13, 0.09, 0.13, L * 0.38, 0.945, 0), P.tyre));
  _col2.setHex(PALETTE.ui.primary);
  const e = LIGHTS.beaconEmissive;
  parts.push(paintRGB(box(0.1, 0.1, 0.1, L * 0.38, 1.04, 0), 1 + _col2.r * e, 1 + _col2.g * e, 1 + _col2.b * e));
  return merge(parts, 'barricade');
}

/** Curved sandbag emplacement: three courses on an arc, alternating the two sandbag tones. */
function buildSandbags() {
  const S = PALETTE.props.sandbag;
  const parts = [];
  const rows = [6, 5, 4];                                            // shape: bags per course
  const R = 1.3, span = 1.75;                                        // shape: arc radius (m) and angle (rad)
  let k = 0;
  for (let r = 0; r < rows.length; r++) {
    const n = rows[r];
    const rr = R - r * 0.06;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i / (n - 1) - 0.5);
      const a = t * span * (n / rows[0]);
      const x = Math.sin(a) * rr, z = -Math.cos(a) * rr + R;
      const wob = ((k * 37) % 7 - 3) * 0.02;                          // deterministic slight tumble
      const g = box(0.52, 0.19, 0.32, 0, 0, 0, wob, 0, -wob * 0.7);
      g.rotateY(-a);
      g.translate(x, 0.095 + r * 0.175, z);
      parts.push(paint(g, S[k % 2], 0.94 + (k % 3) * 0.04));
      k++;
    }
  }
  return merge(parts, 'sandbags');
}

/** Wrecked sedan; body vertices are near-white so the per-instance colour is the paint colour. */
function buildCar() {
  const P = PALETTE.props;
  const body = 0.95;                                                 // body vertex brightness (instanceColor = paint)
  const wr = 0.33, y0 = wr - 0.02;                                   // shape: wheel radius / chassis clearance
  const parts = [
    paintRGB(box(1.8, 0.52, 4.2, 0, y0 + 0.26, 0), body, body, body),                     // chassis
    paintRGB(box(1.74, 0.12, 1.25, 0, y0 + 0.57, -1.42, 0.07, 0, 0.03), body, body, body),  // hood (crumpled)
    paintRGB(box(1.74, 0.1, 0.85, 0, y0 + 0.56, 1.64, -0.05), body, body, body),          // trunk lid
    paint(box(1.56, 0.47, 1.95, 0, y0 + 0.76, 0.12), P.glass),                            // cabin glass
    paintRGB(box(1.62, 0.07, 1.8, 0, y0 + 1.02, 0.14, 0.02, 0, -0.03), body, body, body),   // roof (dented)
    paintRGB(box(0.08, 0.46, 0.08, 0.76, y0 + 0.76, -0.82), body, body, body),            // A pillars
    paintRGB(box(0.08, 0.46, 0.08, -0.76, y0 + 0.76, -0.82), body, body, body),
    paint(box(1.88, 0.18, 0.16, 0, y0 + 0.14, -2.12), P.rust),                              // bumpers
    paint(box(1.88, 0.18, 0.16, 0, y0 + 0.14, 2.12), P.rust),
    paint(box(0.3, 0.1, 0.04, 0.6, y0 + 0.4, -2.11), P.glass, 1.6),                         // dead headlights
    paint(box(0.3, 0.1, 0.04, -0.6, y0 + 0.4, -2.11), P.glass, 1.6),
    paint(box(0.012, 0.3, 1.2, 0.905, y0 + 0.24, 0.6), P.rust),                            // rust streaks
    paint(box(0.012, 0.22, 0.8, -0.905, y0 + 0.3, -0.9), P.rust),
    paint(box(0.9, 0.012, 0.7, -0.3, y0 + 1.06, 0.4), P.rust, 0.9),
    paint(box(1.82, 0.04, 0.03, 0, y0 + 0.36, 0.1), P.tyre),                               // door seam
  ];
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      const sag = (sx > 0 && sz > 0) ? 0.07 : 0;                                            // one flat tyre
      parts.push(paint(cyl(wr, wr, 0.24, 10, sx * 0.84, wr - sag, sz * 1.36, 0, 0, HALF_PI), P.tyre));
      parts.push(paint(cyl(wr * 0.5, wr * 0.5, 0.25, 8, sx * 0.85, wr - sag, sz * 1.36, 0, 0, HALF_PI), P.barricade, 0.6));
    }
  }
  return merge(parts, 'car');
}

/** Ruined two-block building (left block 3 storeys, right block 2) with broken remnants and roof clutter. */
function buildBuilding() {
  const P = PALETTE.props;
  const roof = 0.62, slab = 0.82;                                     // roof / concrete brightness (no windows: < 0.95)
  const parts = [
    paintWall(box(3.75, 9, 6, -1.125, 4.5, 0), 1, roof),             // tall block x ∈ [−3, 0.75]
    paintWall(box(2.25, 6, 6, 1.875, 3, 0), 1, roof),                // collapsed block x ∈ [0.75, 3]
    paintWall(box(0.5, 1.9, 0.5, 2.75, 6.95, 2.75), 1, roof),        // broken column stubs
    paintWall(box(0.42, 1.1, 0.42, 2.75, 6.55, -1.1), 1, roof),
    paintWall(box(1.3, 1.25, 0.26, 1.45, 6.62, 2.87), 1, roof),      // wall shard
    paint(box(2.5, 0.2, 0.7, 1.95, 6.0, 3.2, 0.06, 0, -0.05), P.building, slab),   // floor slab jutting out
    paint(box(2.2, 0.16, 0.5, 1.7, 3.0, 3.1, 0, 0, 0.04), P.building, slab),       // lower balcony slab
    // parapet rim on the tall block
    paint(box(3.85, 0.32, 0.22, -1.125, 9.16, 2.92), P.building, slab),
    paint(box(3.85, 0.32, 0.22, -1.125, 9.16, -2.92), P.building, slab),
    paint(box(0.22, 0.32, 5.6, -2.92, 9.16, 0), P.building, slab),
    // roof clutter: AC box, water tank, antenna
    paint(box(1.0, 0.6, 0.8, -2.0, 9.3, -1.5), P.barricade, 0.55),
    paint(cyl(0.5, 0.5, 1.0, 8, -0.6, 9.6, 1.2), P.rust),
    paint(box(0.06, 2.2, 0.06, -2.4, 10.1, 1.8, 0, 0, 0.1), P.tyre),
    // street-level awning stub (darker band)
    paint(box(3.6, 0.12, 0.9, -1.125, 3.0, 3.4, -0.12), P.rust, 0.85),
  ];
  return merge(parts, 'building');
}

/** Dead tree: tapered trunk, five main branches, a few twigs. */
function buildTree() {
  const hex = PALETTE.props.tree;
  const parts = [paint(cyl(0.11, 0.21, 3.2, 7, 0, 1.6, 0), hex), paint(cyl(0.22, 0.3, 0.3, 7, 0, 0.15, 0), hex, 0.85)];
  const tip = new Vector3();
  const mains = 5;                                                   // shape: main branch count
  for (let i = 0; i < mains; i++) {
    const az = i * (TAU / mains) + (i % 2) * 0.4;
    const tilt = 0.45 + (i % 3) * 0.16;
    const y = 1.9 + i * 0.27;
    const len = 1.5 - i * 0.12;
    parts.push(paint(limb(0.035, 0.085, len, 5, 0, y, 0, tilt, az), hex, 0.95 - i * 0.03));
    limbTip(len * 0.6, 0, y, 0, tilt, az, tip);
    parts.push(paint(limb(0.015, 0.04, len * 0.55, 4, tip.x, tip.y, tip.z, tilt + 0.5, az + 0.7), hex, 0.82));
    parts.push(paint(limb(0.012, 0.03, len * 0.45, 4, tip.x, tip.y, tip.z, tilt - 0.35, az - 0.6), hex, 0.82));
  }
  parts.push(paint(limb(0.03, 0.08, 1.1, 5, 0, 3.15, 0, 0.12, 1.0), hex, 0.9));             // leader
  return merge(parts, 'tree');
}

/** Rubble heap: tumbled concrete and asphalt chunks with rusty rebar (fixed local seed: shape only). */
function buildRubble() {
  const P = PALETTE.props;
  const parts = [];
  rseed(0x52554242);                                                 // shape seed; placement re-seeds per segment
  const chunks = 9;                                                  // shape: chunk count
  for (let i = 0; i < chunks; i++) {
    const w = rrange(0.3, 0.95), h = rrange(0.18, 0.55), d = rrange(0.3, 0.9);
    const r = rrange(0, 1.15), a = rnd() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const hex = (i % 4 === 0) ? PALETTE.road.asphalt : ((i % 4 === 1) ? P.barricade : P.building);
    parts.push(paint(box(w, h, d, x, h * 0.38 + (r < 0.5 ? 0.2 : 0), z, rrange(-0.35, 0.35), rnd() * Math.PI, rrange(-0.35, 0.35)), hex, rrange(0.85, 1.05)));
  }
  for (let i = 0; i < 3; i++) {                                      // rebar
    parts.push(paint(box(0.035, 0.035, rrange(0.9, 1.5), rrange(-0.5, 0.5), 0.35, rrange(-0.5, 0.5), rrange(-0.6, 0.6), rnd() * Math.PI, rrange(-0.5, 0.5)), P.rust));
  }
  return merge(parts, 'rubble');
}

/** Street lamp: pole, base, arm toward local −x, head and an emissive lens (colour excess over 1.0). */
function buildLamppost() {
  const pole = PALETTE.road.curb;
  const parts = [
    paint(cyl(0.055, 0.085, 5.0, 7, 0, 2.5, 0), pole, 0.9),
    paint(cyl(0.15, 0.19, 0.42, 7, 0, 0.21, 0), pole, 0.75),
    paint(box(1.2, 0.07, 0.07, -0.55, 4.96, 0, 0, 0, -0.06), pole, 0.9),
    paint(box(0.56, 0.15, 0.3, -1.12, 4.9, 0, 0, 0, -0.06), PALETTE.props.tyre),
    paint(box(0.3, 0.42, 0.03, 0.0, 3.4, 0.07), PALETTE.props.barricadeWhite, 0.7),   // faded sign plate
  ];
  _col2.setHex(PALETTE.props.windowLit);
  const e = LIGHTS.lampEmissive;
  parts.push(paintRGB(box(0.46, 0.035, 0.24, -1.12, 4.81, 0, 0, 0, -0.06), 1 + _col2.r * e, 1 + _col2.g * e, 1 + _col2.b * e));
  return merge(parts, 'lamppost');
}

/** Curb run for one 30 m segment side: 2 m blocks with alternating shade (speed cue), 0.3 × 0.19 m. */
function buildCurb() {
  const C = LAYOUT.curb;
  const parts = [];
  const n = Math.round(SEG_LEN / C.block);
  for (let i = 0; i < n; i++) {
    const z = -SEG_LEN / 2 + (i + 0.5) * C.block;
    parts.push(paint(box(C.w, C.h, C.block - C.gap, 0, C.h / 2 + GROUND.y, z), PALETTE.road.curb, (i % 2) ? C.shade : 1));
    parts.push(paint(box(C.w + 0.04, 0.03, C.block - C.gap, 0, C.h + GROUND.y + 0.01, z), PALETTE.road.curb, (i % 2) ? C.shade * 1.08 : 1.1));
  }
  return merge(parts, 'curb');
}

/** Manhole cover decal lying flat on the road (feet at y = 0): dark lid, worn rim, inner ring and grip bars. */
function buildManhole() {
  const R = PALETTE.road;
  const r = MANHOLE.r, y = MANHOLE.lift;
  const flat = (g, lift) => { g.rotateX(-HALF_PI); g.translate(0, y + lift, 0); return g; };
  const parts = [
    paint(flat(new CircleGeometry(r * 1.12, 20), 0), R.patch, 0.9),          // tar collar around the frame
    paint(flat(new CircleGeometry(r, 20), 0.002), R.crack, 1.0),               // iron lid
    paint(flat(new RingGeometry(r * 0.88, r, 20, 1), 0.003), R.patch, 1.25),   // worn rim
    paint(flat(new RingGeometry(r * 0.5, r * 0.58, 20, 1), 0.003), R.patch, 1.1),   // inner ring
  ];
  for (let i = -1; i <= 1; i++) {                                    // grip bars across the lid
    const g = new PlaneGeometry(r * 1.3, r * 0.07);
    g.translate(0, i * r * 0.26, 0);
    parts.push(paint(flat(g, 0.004), R.patch, 1.05));
  }
  return merge(parts, 'manhole');
}

/** Smoke column quad: x ∈ [−0.5, 0.5], y ∈ [0, 1] (scaled per instance to width × height). */
function buildSmokeQuad() {
  const g = new PlaneGeometry(1, 1, 1, 4);
  g.translate(0, 0.5, 0);
  return g;
}

/** Road segment k: PlaneGeometry(8, 30, 1, 6) lying flat; v offset k·2 baked (in texture repeats) so seams tile. */
function buildRoadSegment(k, tex) {
  const g = new PlaneGeometry(WORLD.roadWidth, SEG_LEN, 1, ENV.roadSegmentDivisions);
  g.rotateX(-HALF_PI);
  const uv = g.attributes.uv;
  const repV = SEG_LEN / ROAD_TEX_M[1];                              // 2 texture repeats per segment
  const repU = WORLD.roadWidth / ROAD_TEX_M[0];                      // 1 across
  // Compensate any repeat/offset already set on the shared texture (three: texcoord = uv·repeat + offset).
  const tr = tex ? tex.repeat : null, to = tex ? tex.offset : null;
  const ru = tr && tr.x !== 0 ? tr.x : 1, rv = tr && tr.y !== 0 ? tr.y : 1;
  const ou = to ? to.x : 0, ov = to ? to.y : 0;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i) * repU, v = uv.getY(i) * repV + k * repV;
    uv.setXY(i, (u - ou) / ru, (v - ov) / rv);
  }
  uv.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}
// ---------------------------------------------------------------------------------------------
// GLSL. ShaderMaterials end with the standard tonemapping/colorspace chunks, so the Low tier (direct
// render to the canvas) gets ACES + sRGB while the composer path (linear HalfFloat target) compiles
// both to no-ops and GradeOutputPass does them once (ARCH §9.4).
// Round 5 (docs/DISTRICTS.md §6.2): every district difference below is a uniform; at the District 1 values each edit
// reduces to the shipped arithmetic (x + (y − x)·0, × 1, + 0, or a branch that is never taken), so L1–5 stay identical.
// ---------------------------------------------------------------------------------------------

/** hash12 (Dave Hoskins) — stable on mobile highp, no sin(). */
const GLSL_HASH = /* glsl */`
float grHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float grNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( grHash( i ), grHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( grHash( i + vec2( 0.0, 1.0 ) ), grHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
`;

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

// GDD §15: zenith (y 1.0) → upper (0.45) → horizon band (0.12) → glow (0.0); sun disc + halo at azimuth
// +35° / elevation 9°; subtle high cirrus; the bottom RENDER.skyFogMix of the visible dome blends to the
// fog colour so the fogged ground meets the sky without a seam; a hazy ruined skyline sits on the horizon.
// Districts (DISTRICTS.md §6.2): disc edge / moon mottle (uDisc), cloud cover, stars, skyline lit threshold and the
// swap-dip coverage (uSkyDip) are uniforms; uCloudOff keeps the cirrus continuous while a fade changes its drift.
const SKY_FRAG = /* glsl */`
uniform vec3 uZenith; uniform vec3 uUpper; uniform vec3 uHorizon; uniform vec3 uGlow; uniform vec3 uSun; uniform vec3 uFog;
uniform vec3 uLit;
uniform vec4 uStops;          // dome y of the zenith / upper / horizon / glow stops
uniform float uFogMix;        // dome height (y) over which the sky blends into the fog colour
uniform vec3 uSunDir;
uniform vec4 uSunK;           // halo wide, halo tight, disc boost, horizon warm
uniform vec4 uCloud;          // opacity, drift x, drift z, away-from-sun darkening
uniform float uCols;          // skyline columns per radian of azimuth
uniform float uTime;
uniform vec2 uSkyK;           // skyline haze mix toward the upper stop, skyline darkening
uniform vec3 uDisc;           // disc edge cos outer, inner, moon mottle (D1 0.9995, 0.9998, 0)
uniform float uCloudCover;    // cirrus cover shift (D1 0)
uniform vec2 uCloudOff;       // cirrus offset (dome units) carried across a drift change (D1 0)
uniform vec2 uStars;          // star density, gain (D1 0, 0: the term is skipped)
uniform float uSkyLitTh;      // skyline lit-window threshold = 1 − lit density (D1 0.965)
uniform float uSkyDip;        // skyline coverage factor: 1, eased to 0 across a district fade's swap dip
varying vec3 vDir;
${GLSL_HASH}
// Output transform of this pass: ACES + sRGB when rendering straight to the canvas (Low tier), identity into
// the composer's linear target (GradeOutputPass does it once). Fog is composited AFTER it with the fog colour in
// the output colour space, exactly like three's fog_fragment + refreshFogUniforms do for every scene material,
// so the horizon matches the fogged ground on every tier.
vec3 grOut( vec3 c ) {
  #ifdef TONE_MAPPING
    c = toneMapping( c );
  #endif
  return linearToOutputTexel( vec4( c, 1.0 ) ).rgb;
}
void main() {
  vec3 d = normalize( vDir );
  float y = d.y;
  vec3 col;
  if ( y >= uStops.y )      col = mix( uUpper, uZenith, smoothstep( uStops.y, uStops.x, y ) );
  else if ( y >= uStops.z ) col = mix( uHorizon, uUpper, smoothstep( uStops.z, uStops.y, y ) );
  else                      col = mix( uGlow, uHorizon, smoothstep( uStops.w, uStops.z, y ) );

  // azimuthal warmth: the horizon glows toward the sun and cools away from it
  vec2 hd = d.xz / max( length( d.xz ), 1e-4 );
  float azc = dot( hd, normalize( uSunDir.xz ) ) * 0.5 + 0.5;
  float low = 1.0 - smoothstep( 0.0, 0.3, y );
  col = mix( col, uGlow, pow( clamp( azc, 0.0, 1.0 ), 4.0 ) * low * uSunK.w );
  col *= mix( uCloud.w, 1.0, azc );

  // sun / moon: wide halo, tight halo, HDR disc (blooms on High/Medium); the moon's disc is mottled (craters)
  float s = max( dot( d, uSunDir ), 0.0 );
  float disc = smoothstep( uDisc.x, uDisc.y, s ) * uSunK.z;
  if ( uDisc.z > 0.0 ) disc *= 1.0 - uDisc.z * grNoise( ( d - uSunDir ).xy * 600.0 );
  col += uSun * ( pow( s, 8.0 ) * uSunK.x + pow( s, 64.0 ) * uSunK.y + disc );

  // high cirrus streaks, lit warm from below
  float c = 0.0;
  float band = smoothstep( 0.03, 0.12, y ) * ( 1.0 - smoothstep( 0.5, 0.85, y ) );
  if ( band > 0.0 ) {
    vec2 cp = d.xz / ( y + 0.05 ) * 0.9 + uCloud.yz * uTime + uCloudOff;
    float n = grNoise( cp * vec2( 1.3, 4.0 ) ) * 0.55 + grNoise( cp * vec2( 2.7, 9.0 ) + 3.1 ) * 0.3 + grNoise( cp * vec2( 6.0, 17.0 ) + 7.7 ) * 0.15;
    c = smoothstep( 0.52 - uCloudCover, 0.8 - uCloudCover, n ) * band;
    vec3 cc = mix( uHorizon, uSun, 0.35 + 0.5 * azc ) * mix( 1.0, 0.65, smoothstep( 0.1, 0.6, y ) );
    col = mix( col, cc, c * uCloud.x );
  }

  // stars (Night City; title-rig dressing): sparse twinkling points above the haze, hidden behind cirrus
  if ( uStars.y > 0.0 ) {
    vec3 sp = d * 160.0;
    vec3 sc = floor( sp );
    float h = grHash( sc.xy + sc.z * 17.3 );
    float h2 = fract( h * 91.7 );
    float star = step( 1.0 - uStars.x, h ) * ( 1.0 - smoothstep( 0.06, 0.38, length( fract( sp ) - 0.5 ) ) );
    star *= 0.6 + 0.4 * sin( uTime * ( 1.5 + 3.0 * h2 ) + 40.0 * h2 );
    col += uStars.y * star * smoothstep( 0.03, 0.15, y ) * ( 1.0 - c * uCloud.x );
  }

  // fog blend toward the horizon (output space, like fog_fragment)
  float f = 1.0 - smoothstep( 0.0, uFogMix, y );
  vec3 fogO = linearToOutputTexel( vec4( uFog, 1.0 ) ).rgb;
  vec3 outc = mix( grOut( col ), fogO, f * f * 0.92 );

  // distant ruined skyline (hazy silhouette with a few lit windows)
  float a = atan( d.x, -d.z );
  float cx = a * uCols;
  float ci = floor( cx );
  float hv = grHash( vec2( ci, 3.7 ) );
  float h = hv < 0.32 ? 0.0 : 0.010 + pow( grHash( vec2( ci, 9.1 ) ), 2.0 ) * 0.045 + step( 0.94, hv ) * 0.03;
  h -= step( 0.5, fract( cx ) ) * step( 0.7, grHash( vec2( ci, 5.3 ) ) ) * 0.008;      // stepped roofs
  float aa = max( fwidth( y ) * 1.5, 1e-5 );   // never a zero-width smoothstep (undefined in GLSL)
  float sk = ( 1.0 - smoothstep( h - aa, h + aa, y ) ) * step( 0.0005, h );
  vec2 wc = vec2( floor( cx * 5.0 ), floor( y * 260.0 ) );
  vec2 wf = vec2( fract( cx * 5.0 ), fract( y * 260.0 ) );
  float lit = step( uSkyLitTh, grHash( wc + 0.37 ) ) * step( 0.004, y ) * step( y, h - 0.004 )
            * step( 0.25, wf.x ) * step( wf.x, 0.75 ) * step( 0.3, wf.y ) * step( wf.y, 0.8 );
  vec3 skc = mix( fogO, grOut( uUpper ) * uSkyK.y, uSkyK.x ) + grOut( uLit ) * lit;   // hazy silhouette
  outc = mix( outc, skc, sk * ( 0.65 + 0.35 * smoothstep( 0.0, 0.03, y ) ) * uSkyDip );

  outc = mix( outc, fogO, 1.0 - smoothstep( -0.03, 0.0, y ) );       // below the horizon: pure fog
  gl_FragColor = vec4( outc, 1.0 );
}
`;

// Ground (MeshStandardMaterial + onBeforeCompile 'gr:ground'): world-space dirt / shoulder gravel / dry grass /
// ditch / curb-gutter shading scrolled by the travelled distance (periodic in z → seamless wrap). Night City's
// streetlight pools spill past the curb onto the shoulder (same term as the road, in world z; D1 uGrPool = 0).
const GROUND_VERT_PARS = /* glsl */`
varying vec3 vGrWorld;
`;
const GROUND_VERT_MAIN = /* glsl */`
vGrWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;
const GROUND_FRAG_PARS = /* glsl */`
varying vec3 vGrWorld;
uniform float uGrScroll;
uniform vec3 uGrGround; uniform vec3 uGrShoulder; uniform vec3 uGrGrass;
uniform vec4 uGrBands;   // shoulder from, shoulder to, ditch |x|, gutter |x|
uniform vec3 uGrPool;    // light-pool radiance (colour × intensity; 0 = none)
uniform vec4 uGrPoolK;   // pool radius x, radius z, lamp-head |x|, lamp pitch (m)
uniform float uGrLampPhase;   // world z of the left lamp row, mod pitch (the right row is half a pitch further)
uniform vec2 uGrLampRow;      // title-rig lamp clearance: left / right lamp row shown (1) … cleared (0); their pools follow
${GLSL_HASH}
float grNoiseP( vec2 p, float per ) {
  vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  float y0 = mod( i.y, per ), y1 = mod( i.y + 1.0, per );
  return mix( mix( grHash( vec2( i.x, y0 ) ), grHash( vec2( i.x + 1.0, y0 ) ), f.x ),
              mix( grHash( vec2( i.x, y1 ) ), grHash( vec2( i.x + 1.0, y1 ) ), f.x ), f.y );
}
`;
const GROUND_FRAG_MAIN = /* glsl */`
{
  vec2 gp = vec2( vGrWorld.x, vGrWorld.z - uGrScroll );
  float ax = abs( gp.x );
  float n1 = grNoiseP( gp * 0.125, ${(GROUND.periodM / 8).toFixed(1)} );
  float n2 = grNoiseP( gp * 0.5 + vec2( 31.0, 0.0 ), ${(GROUND.periodM / 2).toFixed(1)} );
  vec2 sc = floor( gp * 4.0 ); sc.y = mod( sc.y, ${(GROUND.periodM * 4).toFixed(1)} );
  float n3 = grHash( sc );
  vec3 c = uGrGround * mix( 0.78, 1.14, n1 );
  float sh = 1.0 - smoothstep( uGrBands.x, uGrBands.y, ax + ( n2 - 0.5 ) * 1.2 );
  c = mix( c, uGrShoulder * mix( 0.9, 1.08, n2 ), sh );
  float gr = smoothstep( 0.58, 0.78, n1 * 0.55 + n2 * 0.45 ) * smoothstep( uGrBands.y, uGrBands.y + 2.5, ax );
  c = mix( c, uGrGrass * mix( 0.8, 1.15, n2 ), gr * 0.75 );
  c *= 1.0 - 0.22 * ( 1.0 - smoothstep( 0.15, 0.7, abs( ax - uGrBands.z ) ) );
  c *= mix( 0.62, 1.0, smoothstep( uGrBands.w, uGrBands.w + 0.7, ax ) );
  c *= 0.93 + 0.07 * n3 + 0.1 * n3 * sh;
  diffuseColor.rgb = c;
}
`;
const GROUND_FRAG_EMIT = /* glsl */`
if ( uGrPool.r + uGrPool.g + uGrPool.b > 0.0 ) {
  float grHp = 0.5 * uGrPoolK.w;
  float grZl = ( mod( vGrWorld.z - uGrLampPhase + grHp, uGrPoolK.w ) - grHp ) / uGrPoolK.y;
  float grZr = ( mod( vGrWorld.z - uGrLampPhase, uGrPoolK.w ) - grHp ) / uGrPoolK.y;
  float grXl = ( vGrWorld.x + uGrPoolK.z ) / uGrPoolK.x;
  float grXr = ( vGrWorld.x - uGrPoolK.z ) / uGrPoolK.x;
  float grMl = max( 0.0, 1.0 - grXl * grXl - grZl * grZl );
  float grMr = max( 0.0, 1.0 - grXr * grXr - grZr * grZr );
  totalEmissiveRadiance += uGrPool * diffuseColor.rgb * ( grMl * grMl * grMl * uGrLampRow.x + grMr * grMr * grMr * uGrLampRow.y ) * step( uGrBands.w, abs( vGrWorld.x ) );
}
`;

// Road (MeshStandardMaterial + onBeforeCompile 'gr:road', DISTRICTS.md §6.2; amends ARCH §9.1): per-district asphalt /
// dash / edge-paint multipliers (paint told apart by luminance, the centre dash by u), wet puddles (roughness + darkening;
// the sun's specular lobe, plus a fresnel reflection of the sky's horizon band — env-art addition: without it, away from the sun's
// mirror point the smooth darkened puddles read as black potholes), Night City's segment-local streetlight pools.
// D1: multipliers 1, cover 0 (no puddle, no reflection), pool 0.
// Round-5 integration (draw-call budget, ARCH §9.1): the six ring segments are ONE mesh — their planes merged, each vertex
// tagged with its segment (aGrSeg) and moved along z in the vertex shader by uGrSegZ[segment] (the segment centre that
// _sync used to write into six mesh matrices). Five main-pass draws fewer in every frame; vGrLocal stays segment-local.
const ROAD_VERT_PARS = /* glsl */`
varying vec2 vGrLocal;
attribute float aGrSeg;
uniform float uGrSegZ[ ${SEGMENTS} ];
`;
const ROAD_VERT_MAIN = /* glsl */`
vGrLocal = position.xz;
transformed.z += uGrSegZ[ int( aGrSeg + 0.5 ) ];
`;
const ROAD_FRAG_PARS = /* glsl */`
varying vec2 vGrLocal;
uniform vec3 uGrAsphaltMul; uniform vec3 uGrDashMul; uniform vec3 uGrEdgeMul;
uniform vec2 uGrPuddles;     // cover, puddle roughness
uniform vec3 uGrPool;        // light-pool radiance (colour × intensity; 0 = none)
uniform vec4 uGrPoolK;       // pool radius x, radius z, lamp-head |x|, lamp pitch (m)
uniform vec2 uGrPoolZ;       // segment-local z phase of the left / right lamp rows (mod pitch)
uniform vec2 uGrLampRow;     // title-rig lamp clearance: left / right lamp row shown (1) … cleared (0); their pools follow
uniform vec3 uGrWet;         // puddle reflection of the sky band (horizon colour × WET_REFLECT; × Schlick fresnel × puddle mask)
float grPud = 0.0;
${GLSL_HASH}
`;
const ROAD_FRAG_MAP = /* glsl */`
#ifdef USE_MAP
{
  float grL = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  float grPaint = smoothstep( 0.08, 0.30, grL );
  float grDash = 1.0 - step( 0.1, abs( vMapUv.x - 0.5 ) );
  vec3 grPaintMul = uGrEdgeMul + ( uGrDashMul - uGrEdgeMul ) * grDash;
  diffuseColor.rgb *= uGrAsphaltMul + ( grPaintMul - uGrAsphaltMul ) * grPaint;
  grPud = smoothstep( 1.0 - uGrPuddles.x, 1.08 - uGrPuddles.x, grNoise( vMapUv * vec2( 6.0, 12.0 ) ) );
  diffuseColor.rgb *= 1.0 - 0.25 * grPud;
}
#endif
`;
// Round-5 art review (docs/build/r5-art.md): near the camera the puddles read as black holes ringed by a bright crescent —
// the smooth puddle loses the rough asphalt's broad key-light sheen while the fresnel reflection is only ≈ 0.02–0.05 at the
// steep near view, and the rough → smooth rim catches the key light. The reflection gets a floor near the camera
// (DISTRICT_RULES.puddleReflectFloor, faded out over puddleFloorFadeM of view distance, so the road beside the 36 px / armed
// gates keeps the integration's readability numbers), the rim gets no direct specular (ROAD_FRAG_SPEC), the roughness
// switches inside the puddle only, and under Night City's light pools a puddle mirrors the lamp (poolPuddleGlint).
// All read guarded; inert where road.puddles is 0 (District 1, Ash).
const WET_FLOOR = Number.isFinite(DISTRICT_RULES.puddleReflectFloor) ? clamp(DISTRICT_RULES.puddleReflectFloor, 0, 1) : 0.3;
const WET_FLOOR_FADE = Array.isArray(DISTRICT_RULES.puddleFloorFadeM) && DISTRICT_RULES.puddleFloorFadeM[1] > DISTRICT_RULES.puddleFloorFadeM[0]
  ? DISTRICT_RULES.puddleFloorFadeM : [18, 35];
const POOL_GLINT = Number.isFinite(DISTRICT_RULES.poolPuddleGlint) && DISTRICT_RULES.poolPuddleGlint >= 0 ? DISTRICT_RULES.poolPuddleGlint : 0.12;
// roughness switches inside the puddle only (pud 0.7 → 1; it followed pud³, and before that pud): the partial-coverage rim
// stays rough, so a low sun in front does not ring every puddle with a broad mid-roughness glint (pud = 0 in District 1:
// unchanged)
const ROAD_FRAG_ROUGH = /* glsl */`
roughnessFactor = roughnessFactor + ( uGrPuddles.y - roughnessFactor ) * smoothstep( 0.7, 1.0, grPud );
`;
// round-5 art review: the reflection of the horizon band has a floor near the camera (faded out before the gates), and a
// puddle inside a Night City light pool mirrors the lamp (the pool radiance × POOL_GLINT on top of the lit asphalt)
const ROAD_FRAG_EMIT = /* glsl */`
float grWetF = 0.02 + 0.98 * pow( 1.0 - clamp( dot( normalize( vViewPosition ), normal ), 0.0, 1.0 ), 5.0 );
grWetF = max( grWetF, ${WET_FLOOR.toFixed(3)} * ( 1.0 - smoothstep( ${WET_FLOOR_FADE[0].toFixed(1)}, ${WET_FLOOR_FADE[1].toFixed(1)}, length( vViewPosition ) ) ) );
totalEmissiveRadiance += uGrWet * ( grPud * grWetF );
if ( uGrPool.r + uGrPool.g + uGrPool.b > 0.0 ) {
  float grHp = 0.5 * uGrPoolK.w;
  float grZl = ( mod( vGrLocal.y - uGrPoolZ.x + grHp, uGrPoolK.w ) - grHp ) / uGrPoolK.y;
  float grZr = ( mod( vGrLocal.y - uGrPoolZ.y + grHp, uGrPoolK.w ) - grHp ) / uGrPoolK.y;
  float grXl = ( vGrLocal.x + uGrPoolK.z ) / uGrPoolK.x;
  float grXr = ( vGrLocal.x - uGrPoolK.z ) / uGrPoolK.x;
  float grMl = max( 0.0, 1.0 - grXl * grXl - grZl * grZl );
  float grMr = max( 0.0, 1.0 - grXr * grXr - grZr * grZr );
  totalEmissiveRadiance += uGrPool * ( diffuseColor.rgb + ${POOL_GLINT.toFixed(3)} * grPud ) * ( grMl * grMl * grMl * uGrLampRow.x + grMr * grMr * grMr * uGrLampRow.y );
}
`;
// round-5 art review: the rim between rough asphalt and a smooth puddle caught the key light as a bright crescent (the
// intermediate roughness peaks toward the camera near the light's mirror point): no direct specular across the rim; the
// puddle core keeps its glint, the dry road its sheen (pud = 0 in District 1: unchanged)
const ROAD_FRAG_SPEC = /* glsl */`
reflectedLight.directSpecular *= 1.0 - 0.9 * smoothstep( 0.45, 0.7, grPud ) * ( 1.0 - smoothstep( 0.92, 1.0, grPud ) );
`;

// Buildings (MeshStandardMaterial + 'gr:building'): box-mapped facade/windows UVs from the instance-scaled
// object position; per-instance window-pattern shift and dark (abandoned) buildings; roofs never glow.
// Districts: uGrWin (add, drop) moves the lit-window share off the baked 0.15 per window cell; uGrSnow whitens roofs.
const BUILDING_VERT_PARS = /* glsl */`
varying float vGrWall;
varying float vGrSeed;
varying float vGrRoof;
uniform vec2 uGrRoofUv;
uniform float uGrTileInv;
uniform float uGrDark;
float grH1( float x ) { return fract( sin( x * 91.3458 ) * 47453.5453 ); }
`;
const BUILDING_VERT_MAIN = /* glsl */`
{
  #ifdef USE_INSTANCING
    vec3 grS = vec3( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ), length( instanceMatrix[ 2 ].xyz ) );
    float grSeed = fract( instanceMatrix[ 3 ].x * 0.731 ) * 17.0 + grS.x * 3.17 + grS.y * 1.37;
  #else
    vec3 grS = vec3( 1.0 ); float grSeed = 0.0;
  #endif
  vec3 grP = position * grS;
  vec2 grUv = abs( normal.x ) > 0.5 ? vec2( grP.z, grP.y ) : vec2( grP.x, grP.y );
  grUv = grUv * uGrTileInv + vec2( floor( grH1( grSeed ) * 4.0 ) * 0.25, floor( grH1( grSeed + 7.1 ) * 2.0 ) * 0.5 );
  if ( abs( normal.y ) > 0.5 ) grUv = uGrRoofUv;
  #ifdef USE_MAP
    vMapUv = grUv;
  #endif
  #ifdef USE_EMISSIVEMAP
    vEmissiveMapUv = grUv;
  #endif
  #ifdef USE_COLOR
    vGrWall = step( 0.95, color.r ) * step( uGrDark, grH1( grSeed + 3.3 ) );
  #else
    vGrWall = step( uGrDark, grH1( grSeed + 3.3 ) );
  #endif
  vGrSeed = grSeed;
  vGrRoof = step( 0.5, abs( normal.y ) );
}
`;
const BUILDING_FRAG_PARS = /* glsl */`
varying float vGrWall;
varying float vGrSeed;
varying float vGrRoof;
uniform vec3 uGrBounce;
uniform vec2 uGrWin;      // lit-window share vs the baked one: add, drop (D1 0, 0)
uniform vec3 uGrWinTex;   // linear texel colour of a baked lit window (the added windows match it)
uniform vec4 uGrSnow;     // roof snow colour (linear), amount (D1 0)
${GLSL_HASH}
`;
const BUILDING_FRAG_COLOR = /* glsl */`
diffuseColor.rgb = diffuseColor.rgb + ( uGrSnow.rgb - diffuseColor.rgb ) * ( uGrSnow.a * vGrRoof );
`;
const BUILDING_FRAG_MAIN = /* glsl */`
totalEmissiveRadiance *= vGrWall;
#ifdef USE_EMISSIVEMAP
if ( uGrWin.x > 0.0 || uGrWin.y > 0.0 ) {
  vec2 grCell = floor( vEmissiveMapUv * vec2( 4.0, 2.0 ) );
  if ( grHash( grCell + vec2( vGrSeed * 7.31, 1.7 ) ) < uGrWin.y ) totalEmissiveRadiance = vec3( 0.0 );
  if ( grHash( grCell * 1.37 + vec2( 11.0, vGrSeed * 3.17 ) ) < uGrWin.x ) {
    vec2 grF = fract( vEmissiveMapUv * vec2( 4.0, 2.0 ) );
    float grM = step( 0.2, grF.x ) * step( grF.x, 0.8 ) * step( 0.30, grF.y ) * step( grF.y, 0.77 );
    float grG = mix( 0.55, 1.0, clamp( ( grF.y - 0.30 ) / 0.47, 0.0, 1.0 ) );
    totalEmissiveRadiance += emissive * uGrWinTex * ( grM * grG * vGrWall );
  }
}
#endif
totalEmissiveRadiance += diffuseColor.rgb * uGrBounce;   // warm haze fill: backlit facades never go black
`;

// Lamps / barricade-slot props (MeshStandardMaterial + 'gr:envlamp' | 'gr:envblink'): vertex colour excess
// over 1.0 is emissive radiance, gated per instance by iEmit and scaled by uGrEmitGain; GR_BLINK adds a
// phase-shifted blink. Districts: uGrUnlit (D1 0) gives an unlit emissive part its own dim hue instead of white.
const LAMP_VERT_PARS = /* glsl */`
attribute float iEmit;
varying vec3 vGrEmit;
varying vec4 vGrEx;      // emissive excess (rgb, unscaled) and "unlit instance" (a)
uniform float uTime;
uniform vec3 uGrBlink;   // rate (rad/s), smoothstep lo, hi
uniform float uGrEmitGain;
`;
const LAMP_VERT_MAIN = /* glsl */`
#ifdef USE_COLOR
  vGrEmit = max( color.rgb - 1.0, vec3( 0.0 ) ) * iEmit * uGrEmitGain;
  vGrEx = vec4( max( color.rgb - 1.0, vec3( 0.0 ) ), 1.0 - iEmit );
#else
  vGrEmit = vec3( 0.0 );
  vGrEx = vec4( 0.0 );
#endif
#if defined( GR_BLINK ) && defined( USE_INSTANCING )
  vGrEmit *= smoothstep( uGrBlink.y, uGrBlink.z, sin( uTime * uGrBlink.x + instanceMatrix[ 3 ].x * 2.31 ) );
#endif
`;
// Round-5 art review (r5-integrate §5 issue 2): the landscape / desktop title rig (WORLD.camera.titleLandscape: x 4, y 5)
// sits 0.75 m inside the right lamp row, so every right-shoulder lamp swept its pole, arm and head through the frame every
// 15 m. While the title rig is on, the lamp row within LAMP_CLEAR_M of the camera's x is scaled to its foot (lamp material
// only, uGrLampRow; 1, 1 everywhere else: gameplay and the portrait title are untouched), its light pools fade with it and
// the lamp slot casts no shadow (_titleClear). Level start re-lays the ring under the 0.3 s camera tween.
const LAMP_VERT_ROW = /* glsl */`
#ifdef USE_INSTANCING
  transformed *= instanceMatrix[ 3 ].x < 0.0 ? uGrLampRow.x : uGrLampRow.y;
#endif
`;
const LAMP_CLEAR_M = [1.8, 2.8];      // |lamp row x − camera x| (m): row fully cleared … fully shown on the title rig
const LAMP_FRAG_PARS = /* glsl */`
varying vec3 vGrEmit;
varying vec4 vGrEx;
uniform float uGrUnlit;
`;
const LAMP_FRAG_COLOR = /* glsl */`
diffuseColor.rgb = min( diffuseColor.rgb, vec3( 1.0 ) );
if ( uGrUnlit > 0.0 ) {
  float grM = max( max( vGrEx.r, vGrEx.g ), vGrEx.b );
  if ( grM > 0.0 ) diffuseColor.rgb = mix( diffuseColor.rgb, vGrEx.rgb * ( 0.5 / grM ), uGrUnlit * vGrEx.a );
}
`;
const LAMP_FRAG_EMIT = /* glsl */`
totalEmissiveRadiance += vGrEmit;
`;

// Smoke columns: cylindrical billboards (rotate about Y to face the camera), two scrolling noise layers,
// a widening plume that leans with the wind, and a flickering ember glow at the base.
const SMOKE_VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
uniform vec2 uWind;
varying vec2 vUv;
varying float vSeed;
void main() {
  #ifdef USE_INSTANCING
    vec3 base = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
    float w = length( instanceMatrix[ 0 ].xyz );
    float h = length( instanceMatrix[ 1 ].xyz );
    vSeed = fract( instanceMatrix[ 3 ].x * 0.137 + w * 0.71 + h * 0.031 );
  #else
    vec3 base = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
    float w = 1.0; float h = 1.0; vSeed = 0.0;
  #endif
  vec3 right = vec3( viewMatrix[ 0 ][ 0 ], 0.0, viewMatrix[ 2 ][ 0 ] );
  right /= max( length( right ), 1e-4 );
  float yy = position.y;
  vec3 wp = base + right * position.x * w * mix( 0.55, 1.5, yy ) + vec3( 0.0, yy * h, 0.0 );
  wp.xz += uWind * yy * yy * h;
  vUv = vec2( position.x + 0.5, yy );
  vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
const SMOKE_FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColBottom; uniform vec3 uColTop; uniform vec3 uEmber; uniform vec3 uGlow;
uniform vec4 uSmokeK;    // rise, rise variation, alpha, ember flicker rate
uniform float uGlowBounce;
uniform float uTime;
varying vec2 vUv;
varying float vSeed;
${GLSL_HASH}
// procedural billows (value noise, mean 0.5): TextureFactory.smoke stores its fbm in rgb under a radial alpha
// blob, and canvas storage is premultiplied, so its rgb is zero outside the disc — unusable as tiling noise.
float grSmokeN( vec2 p ) { return grNoise( p * 6.0 ) * 0.62 + grNoise( p * 13.0 + 5.3 ) * 0.38; }
void main() {
  // clamp: with MSAA, edge pixels evaluate the varying outside the quad (y < 0) and pow(negative) is NaN,
  // which the bloom mips then smear over most of the screen (integration fix)
  float y = clamp( vUv.y, 0.0, 1.0 );
  float t = uTime * ( uSmokeK.x + uSmokeK.y * vSeed );
  // the plume's centre line wanders more as it rises; the plume widens with height
  float wob = ( grSmokeN( vec2( vSeed * 5.0, y * 0.6 - t * 0.5 ) ) - 0.5 ) * 0.3 * ( 0.15 + y );
  float halfW = mix( 0.14, 0.48, pow( y, 0.6 ) );
  float dx = ( vUv.x - 0.5 - wob ) / halfW;
  // billows (round puffs) scrolling upward, two layers at different rates
  float n1 = grSmokeN( vec2( vUv.x * 0.8 + vSeed * 3.1, y * 1.4 - t * 2.0 ) );
  float n2 = grSmokeN( vec2( vUv.x * 1.7 + vSeed * 7.3, y * 3.0 - t * 3.3 ) );
  float n = n1 * 0.6 + n2 * 0.4;
  float prof = 1.0 - smoothstep( 0.45, 1.0, abs( dx ) );                     // soft plume envelope
  float dens = prof * mix( 0.5, 1.0, smoothstep( 0.2, 0.75, n ) );
  dens *= smoothstep( 0.0, 0.35, prof * ( 0.55 + 0.8 * n ) );                // puffy silhouette
  dens *= smoothstep( 0.0, 0.04, y ) * ( 1.0 - smoothstep( 0.55, 1.0, y + ( 0.5 - n ) * 0.25 ) );
  vec3 col = mix( uColBottom, uColTop, smoothstep( 0.0, 0.7, y ) ) * ( 0.75 + 0.5 * n );
  col += uGlow * uGlowBounce * smoothstep( 0.2, 1.0, y ) * ( 0.5 + 0.5 * dx );     // sunset light catches the high plume
  float ember = ( 1.0 - smoothstep( 0.0, 0.05, y ) ) * ( 1.0 - smoothstep( 0.1, 0.7, abs( dx ) ) )
              * ( 0.55 + 0.45 * sin( uTime * uSmokeK.w + vSeed * 20.0 + n * 6.0 ) );
  col = mix( col, uEmber, clamp( ember, 0.0, 1.0 ) );
  gl_FragColor = vec4( col, clamp( dens * uSmokeK.z + ember * 0.6, 0.0, 1.0 ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// Weather (env.dust, DISTRICTS.md §6.2): world-anchored points wrapped into a box that follows the camera (no CPU
// writes ever). One program for every kind: fall / sway / flicker are uniforms; uStreak > 0 draws a slanted thin
// streak (rain) instead of the round mote. D1 (dust): fall 0, sway 1, flicker 1, streak 0 → the shipped motes.
const DUST_VERT = /* glsl */`
attribute float aPhase;
uniform vec3 uBox; uniform vec3 uCenter; uniform float uScroll; uniform float uTime; uniform float uSpeed;
uniform float uSize; uniform float uPx;
uniform float uFall; uniform float uSway; uniform float uFlicker;
varying float vA;
void main() {
  vec3 drift = vec3( uTime * uSpeed + sin( uTime * 0.37 + aPhase * 6.283 ) * 0.6 * uSway,
                     uFall * uTime + sin( uTime * 0.53 + aPhase * 12.566 ) * 0.35 * uSway,
                     uScroll + cos( uTime * 0.29 + aPhase * 6.283 ) * 0.6 * uSway );
  vec3 lo = uCenter - 0.5 * uBox;
  vec3 p = lo + mod( position * uBox + drift - lo, uBox );
  vec4 mv = viewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  float dist = max( -mv.z, 0.1 );
  gl_PointSize = max( 1.0, uSize * uPx * ( 0.6 + 0.8 * fract( aPhase * 7.13 ) ) / dist );
  vec3 q = abs( p - uCenter ) / ( 0.5 * uBox );
  float edge = 1.0 - smoothstep( 0.7, 1.0, max( q.x, max( q.y, q.z ) ) );
  vA = edge * mix( 1.0, 0.55 + 0.45 * sin( uTime * ( 1.5 + aPhase ) + aPhase * 40.0 ), uFlicker ) * smoothstep( 1.5, 4.0, dist );
}
`;
const DUST_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uOpacity;
uniform float uStreak; uniform float uSlant;
varying float vA;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float a;
  if ( uStreak > 0.0 ) {
    float cs = cos( uSlant ), sn = sin( uSlant );
    vec2 q = vec2( cs * p.x - sn * p.y, sn * p.x + cs * p.y );
    a = ( 1.0 - smoothstep( 0.0, uStreak, abs( q.x ) ) ) * ( 1.0 - smoothstep( 0.3, 0.5, abs( q.y ) ) );
  } else {
    a = 1.0 - smoothstep( 0.1, 0.5, length( p ) );
  }
  gl_FragColor = vec4( uColor, a * vA * uOpacity );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------
// Districts (docs/DISTRICTS.md; round 5). Everything a fade lerps is precomputed per district into one flat
// Float64Array (linear colours, multipliers, scalars, the disc direction) at module load; a fade frame lerps the
// "from" snapshot toward the target into the preallocated current-state mirror and writes uniforms from it.
// ---------------------------------------------------------------------------------------------

const SLOTS = DISTRICT_RULES.slots;                                   // the 8 prop slots (= PROP_KINDS order)
const SLOT_N = SLOTS.length;
const S_BARRICADE = SLOTS.indexOf('barricade'), S_SANDBAGS = SLOTS.indexOf('sandbags'), S_CAR = SLOTS.indexOf('car');
const S_BUILDING = SLOTS.indexOf('building'), S_TREE = SLOTS.indexOf('tree'), S_RUBBLE = SLOTS.indexOf('rubble');
const S_LAMP = SLOTS.indexOf('lamppost'), S_SMOKE = SLOTS.indexOf('smoke');
/** Placement order of the slots inside a segment (today's routine order; D1 keeps its RNG stream byte for byte). */
const PLACE_ORDER = [S_LAMP, S_BARRICADE, S_SANDBAGS, S_CAR, S_BUILDING, S_TREE, S_RUBBLE];
/** The built-in kinds' layouts (RENDER.env.layout, unchanged) by kind name. */
const BUILTIN_LAYOUT = Object.freeze({
  barricade: LAYOUT.barricade, sandbags: LAYOUT.sandbags, car: LAYOUT.car, building: LAYOUT.building,
  tree: LAYOUT.tree, rubble: LAYOUT.rubble, lamppost: LAYOUT.lamp, smoke: LAYOUT.smoke,
});
/** Slot capacity = max(RENDER.env.props[slot], 6 × the largest `per` of the slot's kinds) (§6.2: only the tree slot grows, 40 → 60). */
const SLOT_CAP = SLOTS.map((slot) => {
  let per = 0;
  for (const k in DISTRICT_PROPS) if (DISTRICT_PROPS[k].slot === slot) per = Math.max(per, DISTRICT_PROPS[k].per);
  return Math.max(ENV.props[slot] | 0, SEGMENTS * per);
});
const EDGE_X = DISTRICT_RULES.edgeClearX;                            // no non-builtin footprint nearer the road centre line
const DIP = DISTRICT_RULES.swapDip;                                   // [0.45, 0.55] weather + skyline swap trough
const HIDDEN_Z = DISTRICT_RULES.hiddenBeyondZ;                        // segments whose near edge is beyond this are fully fogged
const DRAIN_RECYCLES = SEGMENTS;                                      // the last segment placed before a call recycles after 6
// Shape constant of buildLamppost(): the lamp head (and lens) hangs 1.12 m from the pole along the arm (local −x)
const LAMP_HEAD_X = 1.12;
const LAMP_PITCH = LAYOUT.lamp.pitch;
const POOL_HEAD_X = LAYOUT.lamp.x - LAMP_HEAD_X;                      // |x| of the lamp heads above the road (3.63 m)
// Segment-local z phase of the left / right lamp rows (lamps at far edge + offset (+ pitch/2) + pitch·j; mesh-local z of
// the centred segment is 15 m = one pitch off, so the phases hold in either frame)
const POOL_PHASE_L = posMod(LAYOUT.lamp.offset - SEG_LEN / 2, LAMP_PITCH);
const POOL_PHASE_R = posMod(LAYOUT.lamp.offset + LAMP_PITCH / 2 - SEG_LEN / 2, LAMP_PITCH);
const ANCHOR_REC = 16;                                                // anchor records per slot and segment (per ≤ 10)
const BAKED_LIT = PALETTE.props.windowLitFraction;                    // the windows texture's baked lit share (0.15)
// DISTRICT_RULES.puddleReflect: puddle reflection of the sky horizon band (× horizon colour × fresnel); 0 = spec-only sheen.
// Read guarded (fallback = the data value, 0.3 since the round-5 integration's full-dressing readability pass)
const WET_REFLECT = Number.isFinite(DISTRICT_RULES.puddleReflect) && DISTRICT_RULES.puddleReflect >= 0 ? DISTRICT_RULES.puddleReflect : 0.3;

function posMod(a, m) { const r = a % m; return r < 0 ? r + m : r; }
const _rgbTmp = [1, 1, 1];
/** Color → a reused [r, g, b] (allocation-free tint argument). */
function _rgb3(c) { _rgbTmp[0] = c.r; _rgbTmp[1] = c.g; _rgbTmp[2] = c.b; return _rgbTmp; }

// Flat lerp-vector layout (offsets into Float64Array)
const V = {};
let VN = 0;
for (const [k, n] of [
  ['zenith', 3], ['upper', 3], ['horizon', 3], ['glow', 3], ['disc', 3], ['fog', 3], ['lit', 3],
  ['stops', 4], ['fogMix', 1], ['sunDir', 3], ['sunK', 4], ['cloud', 4], ['skyK', 2], ['discK', 3], ['cover', 1], ['stars', 2], ['litTh', 1],
  ['gGround', 3], ['gShoulder', 3], ['gGrass', 3], ['pool', 3], ['poolR', 2],
  ['asphalt', 3], ['dash', 3], ['edge', 3], ['curb', 3], ['puddles', 2], ['rough', 1],
  ['bColor', 3], ['bWin', 3], ['bWinE', 1], ['bDark', 1], ['bBounce', 1], ['bWinAD', 2], ['snow', 4],
  ['lampGain', 1], ['beaconGain', 1], ['blinkDuty', 2], ['unlit', 1],
  ['smBottom', 3], ['smTop', 3], ['smEmber', 3], ['smGlowBounce', 1], ['smAlpha', 1],
  ['fogNear', 1], ['farScale', 1],
]) { V[k] = VN; VN += n; }

const _rc = new Color();
function putHex(v, o, hex, k = 1) { _rc.setHex(hex); v[o] = _rc.r * k; v[o + 1] = _rc.g * k; v[o + 2] = _rc.b * k; }
function putRatio(v, o, hex, baseHex) {
  _rc.setHex(hex); const r = _rc.r, g = _rc.g, b = _rc.b;
  _rc.setHex(baseHex); v[o] = r / _rc.r; v[o + 1] = g / _rc.g; v[o + 2] = b / _rc.b;
}
function linArr(hex, k = 1) { _rc.setHex(hex); return [_rc.r * k, _rc.g * k, _rc.b * k]; }
const POOL_R_DEFAULT = (() => {
  for (let i = 0; i < DISTRICTS.length; i++) if (DISTRICTS[i].road.pools) return DISTRICTS[i].road.pools.radius;
  return [1, 1];
})();

/** Everything environment needs of one district, resolved once (module load; never per frame). */
function resolveDistrict(d) {
  const v = new Float64Array(VN);
  const S = d.sky;
  putHex(v, V.zenith, S.zenith); putHex(v, V.upper, S.upper); putHex(v, V.horizon, S.horizon); putHex(v, V.glow, S.glow);
  putHex(v, V.disc, S.disc.color); putHex(v, V.fog, d.fog.color); putHex(v, V.lit, S.skyline.litColor, S.skyline.lit);
  for (let i = 0; i < 4; i++) v[V.stops + i] = S.stops[i];
  v[V.fogMix] = S.fogMix;
  const az = S.disc.azimuthDeg * DEG, el = S.disc.elevationDeg * DEG;
  const dir = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();   // makeSkyMaterial's formula
  v[V.sunDir] = dir.x; v[V.sunDir + 1] = dir.y; v[V.sunDir + 2] = dir.z;
  v[V.sunK] = S.disc.haloWide; v[V.sunK + 1] = S.disc.haloTight; v[V.sunK + 2] = S.disc.boost; v[V.sunK + 3] = S.horizonWarm;
  v[V.cloud] = S.cloud.opacity; v[V.cloud + 1] = S.cloud.drift[0]; v[V.cloud + 2] = S.cloud.drift[1]; v[V.cloud + 3] = S.awayDarken;
  v[V.skyK] = S.skyline.mix; v[V.skyK + 1] = S.skyline.dark;
  v[V.discK] = S.disc.edge[0]; v[V.discK + 1] = S.disc.edge[1]; v[V.discK + 2] = S.disc.mottle;
  v[V.cover] = S.cloud.cover;
  v[V.stars] = S.stars.density; v[V.stars + 1] = S.stars.gain;
  v[V.litTh] = 1 - S.skyline.litDensity;
  putHex(v, V.gGround, d.ground.ground); putHex(v, V.gShoulder, d.ground.shoulder); putHex(v, V.gGrass, d.ground.grass);
  const pools = d.road.pools;
  if (pools) putHex(v, V.pool, pools.color, pools.intensity);
  const pr = pools ? pools.radius : POOL_R_DEFAULT;
  v[V.poolR] = pr[0]; v[V.poolR + 1] = pr[1];
  const R = PALETTE.road;
  putRatio(v, V.asphalt, d.road.asphalt, R.asphalt); putRatio(v, V.dash, d.road.dash, R.dash);
  putRatio(v, V.edge, d.road.edge, R.edge); putRatio(v, V.curb, d.road.curb, R.curb);
  v[V.puddles] = d.road.puddles; v[V.puddles + 1] = d.road.puddleRoughness; v[V.rough] = d.road.roughness;
  const B = d.building;
  putRatio(v, V.bColor, B.color, PALETTE.props.building);
  putHex(v, V.bWin, B.windowColor); v[V.bWinE] = B.windowEmissive; v[V.bDark] = B.darkFraction; v[V.bBounce] = B.bounce;
  v[V.bWinAD] = Math.max(0, (B.litFraction - BAKED_LIT) / (1 - BAKED_LIT));
  v[V.bWinAD + 1] = Math.max(0, (BAKED_LIT - B.litFraction) / BAKED_LIT);
  putHex(v, V.snow, B.snowColor); v[V.snow + 3] = B.roofSnow;
  v[V.lampGain] = d.lamps.gain; v[V.beaconGain] = d.beacon.gain;
  v[V.blinkDuty] = d.beacon.blinkDuty[0]; v[V.blinkDuty + 1] = d.beacon.blinkDuty[1];
  v[V.unlit] = d === DISTRICTS[0] ? 0 : 1;                           // District 1 keeps today's white unlit lenses (identity)
  const M = d.smoke;
  putHex(v, V.smBottom, M.bottom); putHex(v, V.smTop, M.top); putHex(v, V.smEmber, M.emberColor, M.ember);
  v[V.smGlowBounce] = M.glowBounce; v[V.smAlpha] = M.alpha;
  v[V.fogNear] = d.fog.near; v[V.farScale] = d.fog.farScale;

  const slots = [], fallback = [];
  for (let s = 0; s < SLOT_N; s++) {
    const slot = SLOTS[s];
    const p = d.props[slot];
    const def = DISTRICT_PROPS[p.kind];
    const builtin = !!def.builtin;
    const base = builtin ? BUILTIN_LAYOUT[p.kind] : def.layout;
    const layout = p.layout ? Object.freeze(Object.assign({}, base, p.layout)) : base;
    const frost = (!builtin && layout.frost !== undefined && def.colors && def.colors.frost !== undefined) ? linArr(def.colors.frost) : null;
    slots.push(Object.freeze({ kind: p.kind, def, builtin, weight: p.weight, layout, tint: p.tint || null,
      far: (p.layout && p.layout.far !== undefined) ? p.layout.far : 1, frost }));
    // used when the kind's geometry is missing (models absent): the slot's built-in kind at the same weight
    fallback.push(Object.freeze({ kind: slot, def: DISTRICT_PROPS[slot], builtin: true, weight: p.weight, layout: BUILTIN_LAYOUT[slot], tint: null, far: 1, frost: null }));
  }
  const W = d.weather;
  const weather = Object.freeze({
    kind: W.kind, color: linArr(W.color, W.gain), opacity: W.opacity, blending: W.blend === 'add' ? AdditiveBlending : NormalBlending,
    density: W.density, size: W.size, drift: W.drift, fall: W.fall, sway: W.sway, streak: W.streak, slant: W.slant, flicker: W.flicker, box: W.box,
  });
  const anchor = M.anchor ? SLOTS.indexOf(M.anchor) : -1;
  return Object.freeze({
    d, v, slots: Object.freeze(slots), fallback: Object.freeze(fallback), weather, cols: S.skyline.cols,
    lamps: d.lamps, blinkRate: d.beacon.blinkRate,
    smoke: Object.freeze({ chance: M.chance, w: M.w, h: M.h, anchor }),
  });
}
const RESOLVED = DISTRICTS.map(resolveDistrict);

/** District entry, DISTRICTS array index (0-based, as render.setDistrict accepts) or id → its resolved record (null when unknown). */
function resolvedOf(d) {
  if (d && typeof d === 'object') {
    for (let i = 0; i < RESOLVED.length; i++) if (RESOLVED[i].d === d || RESOLVED[i].d.id === d.id) return RESOLVED[i];
    return null;
  }
  for (let i = 0; i < RESOLVED.length; i++) if (i === d || RESOLVED[i].d.id === d) return RESOLVED[i];
  return null;
}

// ---------------------------------------------------------------------------------------------
// Material factories
// ---------------------------------------------------------------------------------------------

/**
 * The sky dome material (MaterialLibrary.sky() delegates here and caches the result). BackSide,
 * depthWrite off, no scene fog (it carries its own fog blend), shares ctx.render.uniforms.uTime.
 * The new district uniforms start at their District 1 values (DISTRICTS.md §6.2), so the output is unchanged.
 */
export function makeSkyMaterial(ctx) {
  const S = PALETTE.sky;
  const az = S.sunAzimuthDeg * DEG, el = S.sunElevationDeg * DEG;
  const sunDir = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  const fogHex = RENDER.fogColor;
  const litWin = lin(PALETTE.props.windowLit).multiplyScalar(SKY.skylineLit);
  const D1 = DISTRICTS[0].sky;
  const mat = new ShaderMaterial({
    name: 'env.sky',
    uniforms: {
      uZenith: { value: lin(S.zenith) }, uUpper: { value: lin(S.upper) }, uHorizon: { value: lin(S.horizon) },
      uGlow: { value: lin(S.glow) }, uSun: { value: lin(S.sun) }, uFog: { value: lin(fogHex) },
      uSkyK: { value: new Vector2(SKY.skylineMix, SKY.skylineDark) }, uLit: { value: litWin },
      uStops: { value: new Vector4(S.stops.zenith, S.stops.upper, S.stops.horizon, S.stops.glow) },
      uFogMix: { value: S.fogMix !== undefined ? S.fogMix : RENDER.skyFogMix },
      uSunDir: { value: sunDir },
      uSunK: { value: new Vector4(SKY.haloWide, SKY.haloTight, SKY.discBoost, SKY.horizonWarm) },
      uCloud: { value: new Vector4(SKY.cirrus, SKY.cirrusDrift[0], SKY.cirrusDrift[1], SKY.awayDarken) },
      uCols: { value: SKY.skylineCols },
      uTime: sharedTime(ctx),
      uDisc: { value: new Vector3(D1.disc.edge[0], D1.disc.edge[1], D1.disc.mottle) },
      uCloudCover: { value: D1.cloud.cover },
      uCloudOff: { value: new Vector2(0, 0) },
      uStars: { value: new Vector2(D1.stars.density, D1.stars.gain) },
      uSkyLitTh: { value: 1 - D1.skyline.litDensity },
      uSkyDip: { value: 1 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
  return mat;
}

/** Shared onBeforeCompile wiring: adds uniforms and splices chunks after the named includes. */
function inject(shader, uniforms, vertPars, vertAfter, vertMain, fragPars, fragEdits) {
  for (const k in uniforms) shader.uniforms[k] = uniforms[k];
  if (vertPars) shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + vertPars);
  if (vertMain) shader.vertexShader = shader.vertexShader.replace(vertAfter, vertAfter + '\n' + vertMain);
  if (fragPars) shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + fragPars);
  for (let i = 0; i < fragEdits.length; i += 2) {
    shader.fragmentShader = shader.fragmentShader.replace(fragEdits[i], fragEdits[i] + '\n' + fragEdits[i + 1]);
  }
}

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

const _camPos = new Vector3();

export class Environment {
  constructor(ctx) {
    this.ctx = ctx;
    // public scene objects (ARCH §6.3)
    this.sky = null;
    this.ground = null;
    this.segments = [];
    this.curbs = null;
    this.props = new Map();
    this.dust = null;
    this.smoke = null;
    // ring state: far-edge world z and global segment index per segment (index seeds prop placement)
    this._segZ = new Float64Array(SEGMENTS);
    this._segG = new Float64Array(SEGMENTS);
    // _anchor / _dist are seeded as Doubles (round-2 cross-group, FX-14 item 2).
    this._anchor = 0.5; this._anchor = 0;            // shared position.z of every ring InstancedMesh (instance z is relative to it)
    this._dist = 0.5; this._dist = 0;              // travelled distance since the last layout (ground / dust pattern scroll)
    this._seed = TITLE_SEED;
    this._density = QUALITY_TIERS.high.propDensity;
    this._per = Object.create(null);
    this._ring = [];             // InstancedMeshes that scroll with the anchor (props + curbs)
    this._mats = [];             // lit materials owned here (needsUpdate on shadow-type change, dispose)
    this._ownSky = false;
    this._skyMat = null;
    this._dustMat = null;
    this._dustCap = 0;
    this._groundU = null;
    this._shadowType = null;
    this._built = false;
    this._params = null;
    // fog lerp (real time)
    this._fogActive = false;
    this._fogT = 0; this._fogDur = 0;
    this._fogFromN = 0; this._fogFromF = 0; this._fogToN = 0; this._fogToF = 0;
    this._lastTick = -1;
    this._offQuality = null;

    // ---- districts (docs/DISTRICTS.md §3, §6.2) ----
    this._T = RESOLVED[0];                        // target district (resolved)
    this._vCur = new Float64Array(RESOLVED[0].v); // current-state mirror (what the uniforms show)
    this._vFrom = new Float64Array(VN);           // fade start snapshot
    this._fadeOn = false; this._fadeT0 = 0; this._fadeDur = 1; this._fadeK = 1;
    this._dipSwapped = true; this._halfDone = true;
    this._wTheme = RESOLVED[0].weather;           // weather theme the dust shows
    this._wBox = RESOLVED[0].weather.box;
    this._wOp0 = RESOLVED[0].weather.opacity;     // weather opacity / skyline coverage at the fade start
    this._dip0 = 1;
    this._litMode = RESOLVED[0].lamps.lit;        // lamps lit mode in effect (switches at a fade's 0.5 point)
    this._blinkRate = RESOLVED[0].blinkRate;
    this._fogFade = false;                        // the district fade writes fog near / far (until a setFog takes over)
    this._dfFromN = 0; this._dfFromF = 0; this._dfToN = 0; this._dfToF = 0;
    this._cloudP = new Float64Array(2); this._cloudDrift = new Float64Array(2); this._cloudT = 0;
    this._fallbackMs = 0;
    // slots
    this._slotMesh = new Array(SLOT_N).fill(null);
    this._slotCast = new Array(SLOT_N).fill(false);
    this._geoKind = SLOTS.slice();               // kind whose geometry each slot shows
    this._tSlot = RESOLVED[0].slots.slice();      // effective target slot entries (fallback when a kind has no geometry)
    this._drain = new Int32Array(SLOT_N);         // recycles left until the slot swaps (0 = not draining)
    this._views = SLOTS.map(() => new Map());     // kind → geometry per slot (built-in included)
    this._kindH = Object.create(null);            // kind → geometry height (toppled-pose clearance)
    this._adopted = false;
    this._proxies = [];
    this._dry = false;                            // placers compute (same RNG draws) but write nothing
    this._recN = new Int32Array(SLOT_N);          // anchor records of the segment being placed, per slot
    this._recX = new Float64Array(SLOT_N * ANCHOR_REC);
    this._recZ = new Float64Array(SLOT_N * ANCHOR_REC);
    this._recSY = new Float64Array(SLOT_N * ANCHOR_REC);
    this._lampBits = null;                        // per lamppost instance: 1 upright, 2 seeded-lit
    this._roadU = null; this._roadMat = null; this._bU = null; this._buildingMat = null; this._bBase = new Color(1, 1, 1);
    this._hasWindows = false;
    this._lampU = null; this._beaconU = null;

    // render hooks, created once (no per-frame closures)
    this._onSkyRender = (renderer, scene, camera) => {
      const s = this.sky;
      _camPos.setFromMatrixPosition(camera.matrixWorld);
      s.position.copy(_camPos);
      s.updateMatrix();
      s.matrixWorld.copy(s.matrix);
    };
    this._onDustRender = (renderer, scene, camera) => {
      const u = this._dustMat.uniforms;
      const box = this._wBox;
      _camPos.setFromMatrixPosition(camera.matrixWorld);
      u.uCenter.value.set(_camPos.x, box[1] * 0.5, _camPos.z - box[2] * 0.5 - 1);   // box starts 1 m ahead of the camera
      renderer.getDrawingBufferSize(_v2);
      u.uPx.value = 0.5 * _v2.y * camera.projectionMatrix.elements[5];               // px per metre at 1 m
    };
  }

  /** Builds every environment object into ctx.render.scene and lays out the ring. Returns this. */
  build() {
    if (this._built) return this;
    const ctx = this.ctx;
    const r = ctx.render;
    const scene = r.scene;
    const tex = r.textures || null;
    const params = (ctx.quality && ctx.quality.params) ? ctx.quality.params : QUALITY_TIERS.high;
    this._params = params;
    this._density = params.propDensity;
    this._shadowType = params.shadowType;
    const uTime = sharedTime(ctx);

    if (!scene.fog) scene.fog = new Fog(RENDER.fogColor, WORLD.fog.near, params.fogFar);

    // ---- sky dome (follows the camera from onBeforeRender) ----
    const lib = r.materials;
    this._skyMat = (lib && typeof lib.sky === 'function') ? lib.sky() : null;
    if (!this._skyMat) { this._skyMat = makeSkyMaterial(ctx); this._ownSky = true; }
    this.sky = new Mesh(new SphereGeometry(ENV.skyRadius, ENV.skySegments[0], ENV.skySegments[1]), this._skyMat);
    this.sky.name = 'env.sky';
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.sky.matrixAutoUpdate = false;
    this.sky.onBeforeRender = this._onSkyRender;
    scene.add(this.sky);

    // ---- ground (static plane; pattern scrolls in-shader) ----
    const M = PALETTE.material;
    const v0 = RESOLVED[0].v;
    this._lampRowU = { value: new Vector2(1, 1) };                     // title-rig lamp clearance (shared: lamps, road, ground)
    this._lampCastHold = false;
    this._groundU = {
      uGrLampRow: this._lampRowU,
      uGrScroll: { value: 0 },
      uGrGround: { value: lin(PALETTE.ground) },
      uGrShoulder: { value: lin(PALETTE.road.shoulder) },
      uGrGrass: { value: lin(GROUND.grass) },
      uGrBands: { value: new Vector4(GROUND.shoulder[0], GROUND.shoulder[1], GROUND.ditchX, GROUND.gutterX) },
      uGrPool: { value: new Vector3(v0[V.pool], v0[V.pool + 1], v0[V.pool + 2]) },
      uGrPoolK: { value: new Vector4(v0[V.poolR], v0[V.poolR + 1], POOL_HEAD_X, LAMP_PITCH) },
      uGrLampPhase: { value: 0 },
    };
    const groundMat = new MeshStandardMaterial({ name: 'env.ground', color: 0xFFFFFF, roughness: M.asphalt.roughness, metalness: 0 });
    const gU = this._groundU;
    groundMat.onBeforeCompile = (shader) => {
      inject(shader, gU, GROUND_VERT_PARS, '#include <worldpos_vertex>', GROUND_VERT_MAIN, GROUND_FRAG_PARS,
        ['#include <color_fragment>', GROUND_FRAG_MAIN, '#include <emissivemap_fragment>', GROUND_FRAG_EMIT]);
    };
    groundMat.customProgramCacheKey = () => 'gr:ground';
    this._mats.push(groundMat);
    const gGeo = new PlaneGeometry(ENV.groundSize[0], ENV.groundSize[1], 1, 1);
    gGeo.rotateX(-HALF_PI);
    this.ground = new Mesh(gGeo, groundMat);
    this.ground.name = 'env.ground';
    this.ground.position.set(0, GROUND.y, GROUND.centerZ);
    this.ground.receiveShadow = true;
    this.ground.matrixAutoUpdate = false;
    this.ground.updateMatrix();
    scene.add(this.ground);

    // ---- road ring: 6 segments, ONE shared material ('gr:road', DISTRICTS.md §6.2) ----
    const roadTex = tex && tex.road ? tex.road : null;
    const roadMat = new MeshStandardMaterial({
      name: 'env.road', map: roadTex, color: roadTex ? 0xFFFFFF : PALETTE.road.asphalt,
      roughness: M.asphalt.roughness, metalness: M.asphalt.metalness,
    });
    const rU = this._roadU = {
      uGrAsphaltMul: { value: new Vector3(1, 1, 1) }, uGrDashMul: { value: new Vector3(1, 1, 1) }, uGrEdgeMul: { value: new Vector3(1, 1, 1) },
      uGrPuddles: { value: new Vector2(v0[V.puddles], v0[V.puddles + 1]) },
      uGrPool: gU.uGrPool, uGrPoolK: gU.uGrPoolK,                       // shared objects with the ground
      uGrPoolZ: { value: new Vector2(POOL_PHASE_L, POOL_PHASE_R) },
      uGrWet: { value: lin(PALETTE.sky.horizon).multiplyScalar(WET_REFLECT) },
      uGrSegZ: { value: new Float32Array(SEGMENTS) },                  // segment centres (z), written by _sync
      uGrLampRow: this._lampRowU,
    };
    roadMat.onBeforeCompile = (shader) => {
      inject(shader, rU, ROAD_VERT_PARS, '#include <begin_vertex>', ROAD_VERT_MAIN, ROAD_FRAG_PARS,
        ['#include <map_fragment>', ROAD_FRAG_MAP, '#include <roughnessmap_fragment>', ROAD_FRAG_ROUGH, '#include <emissivemap_fragment>', ROAD_FRAG_EMIT,
          '#include <lights_fragment_end>', ROAD_FRAG_SPEC]);
    };
    roadMat.customProgramCacheKey = () => 'gr:road';
    this._roadMat = roadMat;
    this._mats.push(roadMat);
    // round-5 integration: the six segment planes (each with its own baked v offset) merged into one mesh, one draw; the
    // vertex shader places segment k at uGrSegZ[k] (_sync), so the mesh itself never moves (frustum culling off: its
    // bounding volume is the un-shifted planes)
    const segGeos = [];
    for (let k = 0; k < SEGMENTS; k++) {
      const sg = buildRoadSegment(k, roadTex);
      sg.setAttribute('aGrSeg', new Float32BufferAttribute(new Float32Array(sg.attributes.position.count).fill(k), 1));
      segGeos.push(sg);
    }
    const road = new Mesh(merge(segGeos, 'road'), roadMat);
    road.name = 'env.road';
    road.receiveShadow = true;
    road.matrixAutoUpdate = false;
    road.frustumCulled = false;
    road.updateMatrix();
    this.segments.push(road);
    scene.add(road);

    // ---- materials for the instanced props ----
    const propMat = new MeshStandardMaterial({ name: 'env.prop', vertexColors: true, roughness: M.asphalt.roughness, metalness: 0 });
    const carMat = new MeshStandardMaterial({ name: 'env.car', vertexColors: true, roughness: M.car.roughness, metalness: M.car.metalness });
    // two closures / uniform sets (DISTRICTS.md §6.2): each material owns its emit gain, the beacon material its blink
    const lampU = this._lampU = { uTime, uGrBlink: { value: new Vector3(LIGHTS.blinkRate, LIGHTS.blinkDuty[0], LIGHTS.blinkDuty[1]) },
      uGrEmitGain: { value: v0[V.lampGain] }, uGrUnlit: { value: v0[V.unlit] }, uGrLampRow: this._lampRowU };
    const beaconU = this._beaconU = { uTime, uGrBlink: { value: new Vector3(LIGHTS.blinkRate, LIGHTS.blinkDuty[0], LIGHTS.blinkDuty[1]) },
      uGrEmitGain: { value: v0[V.beaconGain] }, uGrUnlit: { value: v0[V.unlit] } };
    const lampMat = new MeshStandardMaterial({ name: 'env.lamp', vertexColors: true, roughness: M.metal.roughness, metalness: M.metal.metalness });
    lampMat.onBeforeCompile = (shader) => {
      inject(shader, lampU, LAMP_VERT_PARS, '#include <color_vertex>', LAMP_VERT_MAIN, LAMP_FRAG_PARS,
        ['#include <color_fragment>', LAMP_FRAG_COLOR, '#include <emissivemap_fragment>', LAMP_FRAG_EMIT]);
      // lamp material only (the beacon material shares LAMP_VERT_PARS and never clears)
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform vec2 uGrLampRow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + LAMP_VERT_ROW);
    };
    lampMat.customProgramCacheKey = () => 'gr:envlamp';
    const beaconMat = new MeshStandardMaterial({ name: 'env.barricade', vertexColors: true, roughness: M.asphalt.roughness, metalness: 0 });
    beaconMat.defines = { GR_BLINK: '' };
    beaconMat.onBeforeCompile = (shader) => {
      inject(shader, beaconU, LAMP_VERT_PARS, '#include <color_vertex>', LAMP_VERT_MAIN, LAMP_FRAG_PARS,
        ['#include <color_fragment>', LAMP_FRAG_COLOR, '#include <emissivemap_fragment>', LAMP_FRAG_EMIT]);
    };
    beaconMat.customProgramCacheKey = () => 'gr:envblink';
    const facade = tex && tex.facade ? tex.facade : null;
    const windows = tex && tex.windows ? tex.windows : null;
    this._hasWindows = !!windows;
    const buildingMat = new MeshStandardMaterial({
      name: 'env.building', vertexColors: true, map: facade, color: facade ? 0xFFFFFF : PALETTE.props.building,
      emissiveMap: windows, emissive: windows ? PALETTE.props.windowLit : 0x000000,
      emissiveIntensity: windows ? PALETTE.props.windowLitEmissive : 0,
      roughness: M.cloth.roughness, metalness: 0,
    });
    this._bBase.copy(buildingMat.color);
    this._buildingMat = buildingMat;
    const bU = this._bU = {
      uGrRoofUv: { value: new Vector2(0.02, 0.98) },                 // a plain-wall texel of the facade tile (no window)
      uGrTileInv: { value: 1 / FACADE_TILE_M },
      uGrDark: { value: DARK_BUILDING_FRACTION },
      uGrBounce: { value: lin(RENDER.fogColor).multiplyScalar(BUILDING_BOUNCE) },
      uGrWin: { value: new Vector2(v0[V.bWinAD], v0[V.bWinAD + 1]) },
      uGrWinTex: { value: lin(PALETTE.props.windowLit) },
      uGrSnow: { value: new Vector4(v0[V.snow], v0[V.snow + 1], v0[V.snow + 2], v0[V.snow + 3]) },
    };
    buildingMat.onBeforeCompile = (shader) => {
      inject(shader, bU, BUILDING_VERT_PARS, '#include <uv_vertex>', BUILDING_VERT_MAIN, BUILDING_FRAG_PARS,
        ['#include <color_fragment>', BUILDING_FRAG_COLOR, '#include <emissivemap_fragment>', BUILDING_FRAG_MAIN]);
    };
    buildingMat.customProgramCacheKey = () => 'gr:building';
    this._mats.push(propMat, carMat, lampMat, beaconMat, buildingMat);

    // ---- prop slots: District 1's built-in geometries; capacity = max over the districts' kinds (DISTRICTS.md §6.2) ----
    const mats = { barricade: beaconMat, sandbags: propMat, car: carMat, building: buildingMat, tree: propMat, rubble: propMat, lamppost: lampMat };
    const geos = { barricade: buildBarricade, sandbags: buildSandbags, car: buildCar, building: buildBuilding, tree: buildTree, rubble: buildRubble, lamppost: buildLamppost };
    for (let s = 0; s < SLOT_N; s++) {
      const slot = SLOTS[s];
      if (s === S_SMOKE) continue;
      const emit = slot === 'barricade' || slot === 'lamppost';
      const m = this._ringMesh(slot, geos[slot](), mats[slot], SLOT_CAP[s], true, true, emit);
      this._slotMesh[s] = m;
      this._slotCast[s] = m.castShadow;
      this._views[s].set(slot, m.geometry);
      this._per[slot] = DISTRICT_PROPS[slot].per;
      m.count = SEGMENTS * this._per[slot];                          // stride rule: 6 × per (today's extra capacity was always hidden)
      m.geometry.computeBoundingBox();
      this._kindH[slot] = m.geometry.boundingBox.max.y;
    }
    this._lampBits = new Uint8Array(SLOT_CAP[S_LAMP]);
    // manhole covers (VIS-11): flat decals in the lanes, seeded per segment (shares the prop material: no new program)
    this._ringMesh('manhole', buildManhole(), propMat, MANHOLE.max * SEGMENTS, false, true, false);
    this._per.manhole = MANHOLE.max;

    // smoke columns (billboards; hidden on Low)
    const smokeMat = new ShaderMaterial({
      name: 'env.smoke',
      uniforms: UniformsUtils.merge([UniformsLib.fog, {
        uColBottom: { value: lin(PALETTE.props.smoke[0]) },
        uColTop: { value: lin(PALETTE.props.smoke[1]) },
        uEmber: { value: lin(PALETTE.fx.flame).multiplyScalar(SMOKE.ember) },
        uGlow: { value: lin(PALETTE.sky.glow) },
        uSmokeK: { value: new Vector4(SMOKE.rise, SMOKE.riseVar, SMOKE.alpha, SMOKE.emberFlicker) },
        uGlowBounce: { value: SMOKE.glowBounce },
        uWind: { value: new Vector2(SMOKE.wind[0], SMOKE.wind[1]) },
      }]),
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      fog: true,
    });
    smokeMat.uniforms.uTime = uTime;                                  // shared object (merge() clones values)
    this._smokeMat = smokeMat;
    this.smoke = this._ringMesh('smoke', buildSmokeQuad(), smokeMat, SLOT_CAP[S_SMOKE], false, false, false, true);
    this.smoke.renderOrder = 1;
    this._slotMesh[S_SMOKE] = this.smoke;
    this._per.smoke = DISTRICT_PROPS.smoke.per;
    this.smoke.count = SEGMENTS * this._per.smoke;

    // curbs: one InstancedMesh, two instances per segment
    this.curbs = new InstancedMesh(buildCurb(), propMat, ENV.curbs);
    // instanceColor (all 1) like every other env.prop user, so the shared material keeps ONE program key (VIS-8:
    // a mesh without instanceColor flipped the key and re-ran getParameters twice per frame)
    this._initInstanced(this.curbs, 'env.curbs', ENV.curbs, false, true, true);
    this._ring.push(this.curbs);
    scene.add(this.curbs);

    // ---- dust motes / weather (world-anchored, wrapped in-shader into a box ahead of the camera) ----
    this._buildDust(scene, uTime);

    // ---- layout + quality ----
    this._built = true;
    this._layoutAll();
    this.applyQuality(params);
    if (this._T !== RESOLVED[0]) { const d = this._T.d; this._T = RESOLVED[0]; this.setDistrict(d, 0); }   // a call before build
    if (ctx.events && typeof ctx.events.on === 'function') {
      this._offQuality = ctx.events.on('quality:change', (p) => { if (p && p.params) this.applyQuality(p.params); });
    }
    return this;
  }

  // -------------------------------------------------------------------------------------------
  // Public API (ARCH §6.3)
  // -------------------------------------------------------------------------------------------

  /** The target district (DISTRICTS[0] until the first setDistrict). */
  get district() { return this._T.d; }

  /** Moves the road ring, curbs, props and smoke by +dz; recycles segments past WORLD.segmentRecycleZ. */
  scroll(dz) {
    if (!this._built) return;
    if (dz > 0) {
      this._dist += dz;
      this._anchor += dz;
      for (let k = 0; k < SEGMENTS; k++) {
        this._segZ[k] += dz;
        let guard = SEGMENTS;                                         // a frame never moves a full ring; bounded anyway
        while (this._segZ[k] >= RECYCLE_Z && guard-- > 0) {
          this._segZ[k] -= RING_LEN;
          this._segG[k] += SEGMENTS;
          this._placeSegment(k);
          this._onRecycle();
        }
      }
      if (this._anchor > REBASE_M) this._rebase();
      this._sync();
    }
    this._tick(-1);
  }

  /** Re-seeds every prop at level start (uses the given seed, never ctx.rng) and resets the ring. */
  setLevel(seed, propDensity) {
    this._seed = Number.isFinite(seed) ? Math.floor(seed) : TITLE_SEED;
    if (Number.isFinite(propDensity)) this._density = clamp(propDensity, 0, 1);
    if (this._built) this._layoutAll();
  }

  /** Lerps scene.fog near/far to the targets over `lerpSeconds` of real time (0 = immediate). A call during a district
   *  fade takes near / far over (the fade stops writing them, DISTRICTS.md §3.3). */
  setFog(near, far, lerpSeconds) {
    const fog = this.ctx.render && this.ctx.render.scene ? this.ctx.render.scene.fog : null;
    if (!fog) return;
    this._fogFade = false;
    if (!(lerpSeconds > 0)) {
      fog.near = near; fog.far = far;
      this._fogActive = false;
      return;
    }
    this._fogFromN = fog.near; this._fogFromF = fog.far;
    this._fogToN = near; this._fogToF = far;
    this._fogT = 0; this._fogDur = lerpSeconds;
    this._fogActive = true;
  }

  /**
   * DISTRICTS.md §3.3 / §3.4 / §6.2. `district`: a DISTRICTS entry (or its index / id). seconds 0 = snap before the next
   * draw: every uniform, the weather theme and the skyline columns, every slot whose kind differs swaps geometry and the
   * ring is re-laid. seconds > 0 = fade on the theatre clock (uniforms, fog near / far, swap dip, lamps lit at 0.5, slot
   * drain → swap → refill). Allocation-free; idempotent.
   */
  setDistrict(district, seconds = 0) {
    const R = resolvedOf(district);
    if (!R) return;
    if (!this._built) { this._T = R; this._vCur.set(R.v); return; }
    this._adopt();
    const wasFading = this._fadeOn;
    const changed = R !== this._T;
    this._T = R;
    this._resolveTargets();
    this._fogActive = false;                                          // setDistrict cancels a running setFog lerp
    if (!(seconds > 0)) {
      this._fadeOn = false; this._fadeK = 1;
      this._dipSwapped = true; this._halfDone = true;
      this._vCur.set(R.v);
      this._applyVec(false);
      this._skyMat.uniforms.uCloudOff.value.set(0, 0);
      this._skyMat.uniforms.uCols.value = R.cols;
      this._skyMat.uniforms.uSkyDip.value = 1;
      this._applyWeather(R.weather, 1);
      this._litMode = R.lamps.lit;
      this._blinkRate = R.blinkRate;
      this._beaconU.uGrBlink.value.x = this._blinkRate;
      this._snapFog();
      let swapped = false;
      for (let s = 0; s < SLOT_N; s++) {
        this._drain[s] = 0;
        if (s !== S_SMOKE && this._geoKind[s] !== this._tSlot[s].kind) { this._swapSlot(s); swapped = true; }
      }
      if (changed || wasFading || swapped) this._layoutAll();
      return;
    }
    // ---- fade ----
    this._vFrom.set(this._vCur);
    this._fadeT0 = this._now();
    this._fadeDur = seconds * 1000;
    this._fadeOn = true; this._fadeK = 0;
    this._dipSwapped = false; this._halfDone = false;
    this._wOp0 = this._dustMat.uniforms.uOpacity.value;
    this._dip0 = this._skyMat.uniforms.uSkyDip.value;
    // fog near / far ride the district clock (a later setFog takes them over)
    const fog = this.ctx.render.scene.fog;
    this._fogFade = !!fog;
    if (fog) { this._dfFromN = fog.near; this._dfFromF = fog.far; this._dfToN = R.v[V.fogNear]; this._dfToF = this._fogFar(); }
    // cirrus continuity across the drift change
    const uT = this._skyMat.uniforms.uTime.value;
    const off = this._skyMat.uniforms.uCloudOff.value;
    this._cloudDrift[0] = this._vCur[V.cloud + 1]; this._cloudDrift[1] = this._vCur[V.cloud + 2];
    this._cloudP[0] = this._cloudDrift[0] * uT + off.x; this._cloudP[1] = this._cloudDrift[1] * uT + off.y;
    this._cloudT = uT;
    // slots: drain toward the target kind (a new target equal to the shown kind cancels the drain)
    for (let s = 0; s < SLOT_N; s++) {
      if (s === S_SMOKE) continue;
      this._drain[s] = this._geoKind[s] === this._tSlot[s].kind ? 0 : DRAIN_RECYCLES;
    }
  }

  /** Every (slot mesh, alternative kind geometry) pair, for warm-up draws with the geometry temporarily assigned
   *  (DISTRICTS.md §3.6). Adopts ctx.models.geo lazily. */
  districtWarmList(out = []) {
    this._adopt();
    for (let s = 0; s < SLOT_N; s++) {
      const m = this._slotMesh[s];
      if (!m) continue;
      this._views[s].forEach((geo) => { if (geo !== m.geometry) out.push({ mesh: m, geometry: geo }); });
    }
    return out;
  }

  /**
   * Adopts ctx.models.geo and parks one hidden warm proxy per (slot, alternative kind) in the scene: an InstancedMesh
   * with the kind's view geometry and the slot's material, depth material and SHARED instance attributes. Hidden objects
   * draw nothing; render.warmup's "every renderable once" pass and _warmHiddenChunked after a tier change draw them out
   * of sight, which uploads every district geometry and creates its VAOs (main and shadow-depth, keyed by geometry and
   * program, bound to the slot's own instance buffers), so a later swap is a pointer change. Called by
   * ModelLibrary.init (boot step 6, before warm-up step 9b); idempotent.
   */
  warmDistricts() {
    if (!this._built) return;
    this._adopt();
    if (this._proxies.length > 0) return;
    const scene = this.ctx.render.scene;
    for (let s = 0; s < SLOT_N; s++) {
      const m = this._slotMesh[s];
      if (!m || s === S_SMOKE) continue;
      this._views[s].forEach((geo, kind) => {
        if (geo === m.geometry) return;
        const p = new InstancedMesh(geo, m.material, 1);
        p.instanceMatrix = m.instanceMatrix;
        p.instanceColor = m.instanceColor;
        p.count = 1;
        p.name = 'env.warm.' + SLOTS[s] + '.' + kind;
        p.castShadow = DISTRICT_PROPS[kind].castShadow === false ? false : this._slotCast[s];
        p.receiveShadow = m.receiveShadow;
        p.customDepthMaterial = m.customDepthMaterial;
        p.frustumCulled = false;
        p.matrixAutoUpdate = false;
        p.visible = false;
        scene.add(p);
        this._proxies.push(p);
      });
    }
  }

  /** Per-frame hook (RenderSystem.update calls it after scroll): fog lerp on real time, district fade on the theatre
   *  clock. Allocation-free. */
  update(dt) {
    if (!this._built) return;
    this._tick(dt);
  }

  /** Tier change (also wired to quality:change): live dust count × weather density, smoke on/off, density for new
   *  segments, fog far × district farScale, shadow type. */
  applyQuality(params) {
    if (!params || !this._built) return;
    this._params = params;
    if (Number.isFinite(params.propDensity)) this._density = params.propDensity;   // applies as segments recycle (no pop)
    this._applyDustCount();
    this.smoke.visible = !!params.smoke;
    const fog = this.ctx.render && this.ctx.render.scene ? this.ctx.render.scene.fog : null;
    if (fog && Number.isFinite(params.fogFar)) {
      const far = this._fogFar();
      if (this._fogFade) this._dfToF = far;
      else if (this._fogActive) this._fogToF = far;
      else fog.far = far;
    }
    if (params.shadowType !== this._shadowType) {
      this._shadowType = params.shadowType;
      this.markAllNeedsUpdate();
    }
  }

  /** Recompiles the lit materials owned here (shadow-map type change, ARCH §9.3). */
  markAllNeedsUpdate() {
    for (let i = 0; i < this._mats.length; i++) this._mats[i].needsUpdate = true;
  }

  /** Same layout again (current seed and density). Allocation-free and idempotent. */
  reset() {
    if (this._built) this._layoutAll();
    this._fogActive = false;
  }

  /** Removes every object from the scene, disposes geometries/materials created here, drops listeners. */
  dispose() {
    if (this._offQuality) { this._offQuality(); this._offQuality = null; }
    const scene = this.ctx.render ? this.ctx.render.scene : null;
    const drop = (o) => { if (!o) return; if (scene) scene.remove(o); if (o.geometry) o.geometry.dispose(); };
    // adopted view geometries share models' BufferAttributes: they are dropped, never disposed (models owns the buffers)
    for (let s = 0; s < SLOT_N; s++) {
      const m = this._slotMesh[s];
      if (m && s !== S_SMOKE) { const own = this._views[s].get(SLOTS[s]); if (own && m.geometry !== own) m.geometry = own; }
    }
    for (let i = 0; i < this._proxies.length; i++) if (scene) scene.remove(this._proxies[i]);
    this._proxies.length = 0;
    drop(this.sky); drop(this.ground); drop(this.curbs); drop(this.dust);
    for (let i = 0; i < this.segments.length; i++) drop(this.segments[i]);
    this.props.forEach((m) => drop(m));
    for (let i = 0; i < this._mats.length; i++) this._mats[i].dispose();
    if (this._smokeMat) this._smokeMat.dispose();
    if (this._dustMat) this._dustMat.dispose();
    if (this._ownSky && this._skyMat) this._skyMat.dispose();
    this.sky = null; this.ground = null; this.curbs = null; this.dust = null; this.smoke = null;
    this.segments.length = 0; this.props.clear(); this._ring.length = 0; this._mats.length = 0;
    this._skyMat = null; this._smokeMat = null; this._dustMat = null;
    for (let s = 0; s < SLOT_N; s++) { this._slotMesh[s] = null; this._views[s].clear(); }
    this._adopted = false;
    this._built = false;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  _initInstanced(m, name, cap, cast, receive, colors) {
    m.name = name;
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.instanceMatrix.array.fill(0);                                   // every slot hidden until placed
    if (colors) {
      m.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      m.instanceColor.setUsage(DynamicDrawUsage);
    }
    m.count = cap;
    m.frustumCulled = false;                                          // instance bounds are stale by design
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false;
    // VIS-14: every env caster gets its own depth material per (instanced, instanceColor, map) combination, so three's
    // single shared shadow-depth material never flips program parameters between env and other casters
    const lib = this.ctx.render ? this.ctx.render.materials : null;
    if (cast && lib && typeof lib.depthFor === 'function') {
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      m.customDepthMaterial = lib.depthFor({ instanced: true, instanceColor: !!m.instanceColor, map: !!(mat && mat.map) });
    }
  }

  _ringMesh(kind, geo, mat, cap, cast, colors, emit, noTint) {
    if (emit) {
      const a = new InstancedBufferAttribute(new Float32Array(cap), 1);
      a.setUsage(DynamicDrawUsage);
      geo.setAttribute('iEmit', a);
    }
    const m = new InstancedMesh(geo, mat, cap);
    this._initInstanced(m, 'env.' + kind, cap, cast, kind !== 'smoke', !noTint && (colors || emit));
    this.props.set(kind, m);
    this._ring.push(m);
    this.ctx.render.scene.add(m);
    return m;
  }

  _buildDust(scene, uTime) {
    const D = ENV.dust;
    const cap = Math.max(D.count, QUALITY_TIERS.high.dust);
    this._dustCap = cap;
    const pos = new Float32Array(cap * 3);
    const ph = new Float32Array(cap);
    rseed(0x44555354);                                                // fixed cosmetic seed ('DUST')
    for (let i = 0; i < cap; i++) {
      pos[i * 3] = rnd(); pos[i * 3 + 1] = rnd(); pos[i * 3 + 2] = rnd();
      ph[i] = rnd();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new Float32BufferAttribute(ph, 1));
    const W = RESOLVED[0].weather;
    this._dustMat = new ShaderMaterial({
      name: 'env.dust',
      uniforms: {
        uBox: { value: new Vector3(D.box[0], D.box[1], D.box[2]) },
        uCenter: { value: new Vector3() },
        uScroll: { value: 0 },
        uTime,
        uSpeed: { value: D.speed },
        uSize: { value: D.size },
        uPx: { value: 1 },
        uColor: { value: lin(PALETTE.props.dust) },
        uOpacity: { value: PALETTE.props.dustOpacity },
        uFall: { value: W.fall }, uSway: { value: W.sway }, uFlicker: { value: W.flicker },
        uStreak: { value: W.streak }, uSlant: { value: W.slant },
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    this.dust = new Points(geo, this._dustMat);
    this.dust.name = 'env.dust';
    this.dust.frustumCulled = false;
    this.dust.matrixAutoUpdate = false;
    this.dust.renderOrder = 2;
    this.dust.onBeforeRender = this._onDustRender;
    scene.add(this.dust);
  }

  /** Live weather particle count: round(params.dust × weather density) (DISTRICTS.md §6.2). */
  _applyDustCount() {
    if (!this.dust || !this._params) return;
    const n = Math.max(0, Math.min(this._dustCap, Math.round((this._params.dust | 0) * this._wTheme.density)));
    this.dust.geometry.setDrawRange(0, n);
    this.dust.visible = n > 0;
  }

  /** Re-themes the one env.dust Points object (uniforms, blending, box, drawRange); opacity × f. No program change. */
  _applyWeather(W, f) {
    const u = this._dustMat.uniforms;
    u.uColor.value.setRGB(W.color[0], W.color[1], W.color[2]);
    u.uOpacity.value = W.opacity * f;
    u.uSpeed.value = W.drift; u.uSize.value = W.size;
    u.uFall.value = W.fall; u.uSway.value = W.sway; u.uFlicker.value = W.flicker;
    u.uStreak.value = W.streak; u.uSlant.value = W.slant;
    u.uBox.value.set(W.box[0], W.box[1], W.box[2]);
    this._dustMat.blending = W.blending;
    this._wTheme = W;
    this._wBox = W.box;
    this._applyDustCount();
  }

  /** params.fogFar × the target district's farScale. */
  _fogFar() {
    const p = this._params || QUALITY_TIERS.high;
    return p.fogFar * this._T.v[V.farScale];
  }

  _snapFog() {
    const fog = this.ctx.render.scene.fog;
    this._fogFade = false;
    this._fogActive = false;
    if (!fog) return;
    fog.near = this._T.v[V.fogNear];
    fog.far = this._fogFar();
  }

  /** Theatre clock (ms; holds while paused, DISTRICTS.md §3.3); a private clock when ctx.time is absent (tests). */
  _now() {
    const t = this.ctx.time;
    if (t && Number.isFinite(t.theatre)) return t.theatre;
    return this._fallbackMs;
  }

  /** Once-per-frame work (guarded by ctx.time.frame): fog lerp on real (unscaled) time, district fade. */
  _tick(dtFallback) {
    const t = this.ctx.time;
    if (t) {
      if (t.frame === this._lastTick) return;
      this._lastTick = t.frame;
      this._stepFog(t.unscaledDt);
    } else if (dtFallback >= 0) {
      const dt = dtFallback > 0 ? dtFallback : FALLBACK_DT;
      this._fallbackMs += dt * 1000;
      this._stepFog(dt);
    }
    if (this._fadeOn) this._stepDistrict();
    this._titleClear();
  }

  /** Title-rig lamp clearance (round-5 art review, LAMP_VERT_ROW): the lamp row within LAMP_CLEAR_M of the camera's x is
   *  scaled away while render's title rig is on (render.titleBlend), its pools with it; the lamp slot casts no shadow
   *  meanwhile. Uniform writes only when a value changes; allocation-free. */
  _titleClear() {
    if (!this._lampRowU) return;
    const R = this.ctx.render;
    const b = R && Number.isFinite(R.titleBlend) ? R.titleBlend : 0;
    let l = 1, r = 1;
    if (b > 0 && R.camera) {
      const cx = R.camera.position.x, lx = LAYOUT.lamp.x;
      l = 1 - b * (1 - smoothstep(LAMP_CLEAR_M[0], LAMP_CLEAR_M[1], Math.abs(-lx - cx)));
      r = 1 - b * (1 - smoothstep(LAMP_CLEAR_M[0], LAMP_CLEAR_M[1], Math.abs(lx - cx)));
    }
    const v = this._lampRowU.value;
    if (v.x !== l || v.y !== r) v.set(l, r);
    const hold = l < 0.999 || r < 0.999;
    if (hold !== this._lampCastHold) {
      this._lampCastHold = hold;
      const m = this._slotMesh[S_LAMP];
      if (m) {
        const def = DISTRICT_PROPS[this._geoKind[S_LAMP]];
        m.castShadow = hold ? false : (def && def.castShadow === false ? false : this._slotCast[S_LAMP]);
      }
    }
  }

  _stepFog(dt) {
    if (!this._fogActive) return;
    const fog = this.ctx.render.scene.fog;
    if (!fog) { this._fogActive = false; return; }
    this._fogT += dt / this._fogDur;
    const k = this._fogT >= 1 ? 1 : ease.inOutCubic(this._fogT);
    fog.near = lerp(this._fogFromN, this._fogToN, k);
    fog.far = lerp(this._fogFromF, this._fogToF, k);
    if (this._fogT >= 1) this._fogActive = false;
  }

  /** One district-fade frame (DISTRICTS.md §3.3): lerp the mirror, write uniforms, swap dip, lamps lit at 0.5. */
  _stepDistrict() {
    const t = clamp((this._now() - this._fadeT0) / this._fadeDur, 0, 1);
    const k = ease.inOutCubic(t);
    this._fadeK = k;
    const T = this._T, to = T.v, from = this._vFrom, cur = this._vCur;
    const done = t >= 1;
    if (done) cur.set(to);
    else for (let j = 0; j < VN; j++) cur[j] = from[j] + (to[j] - from[j]) * k;
    this._applyVec(!done);
    const su = this._skyMat.uniforms;
    // cirrus: integrate the position under the changing drift (uCloudOff keeps it continuous)
    const uT = su.uTime.value;
    const dT = uT - this._cloudT;
    this._cloudP[0] += this._cloudDrift[0] * dT; this._cloudP[1] += this._cloudDrift[1] * dT;
    this._cloudDrift[0] = cur[V.cloud + 1]; this._cloudDrift[1] = cur[V.cloud + 2];
    this._cloudT = uT;
    su.uCloudOff.value.set(this._cloudP[0] - this._cloudDrift[0] * uT, this._cloudP[1] - this._cloudDrift[1] * uT);
    // swap dip: weather opacity and skyline coverage ease to 0 by DIP[0], swap at the trough, ease back from DIP[1]
    if (!this._dipSwapped && k >= DIP[0]) {
      this._dipSwapped = true;
      this._applyWeather(T.weather, 0);
      su.uCols.value = T.cols;
    }
    let dip;
    if (k < DIP[0]) dip = 1 - k / DIP[0];
    else if (k <= DIP[1]) dip = 0;
    else dip = (k - DIP[1]) / (1 - DIP[1]);
    if (done) dip = 1;
    if (this._dipSwapped) {
      this._dustMat.uniforms.uOpacity.value = T.weather.opacity * dip;
      su.uSkyDip.value = dip;
    } else {
      this._dustMat.uniforms.uOpacity.value = this._wOp0 * dip;
      su.uSkyDip.value = this._dip0 * dip;
    }
    // 0.5: lamps lit mode re-applied to the placed lamps (lamppost kind unchanged), blink rate switch
    if (!this._halfDone && k >= 0.5) {
      this._halfDone = true;
      this._litMode = T.lamps.lit;
      this._blinkRate = T.blinkRate;
      this._beaconU.uGrBlink.value.x = this._blinkRate;
      this._relightLamps();
    }
    // fog near / far on the district clock
    if (this._fogFade) {
      const fog = this.ctx.render.scene.fog;
      if (fog) { fog.near = lerp(this._dfFromN, this._dfToN, k); fog.far = lerp(this._dfFromF, this._dfToF, k); }
      if (done) this._fogFade = false;
    }
    if (done) this._fadeOn = false;
  }

  /** Writes every lerped uniform from the current-state mirror (≈ 60 writes; allocation-free). */
  _applyVec(midFade) {
    const v = this._vCur;
    const su = this._skyMat.uniforms;
    su.uZenith.value.setRGB(v[V.zenith], v[V.zenith + 1], v[V.zenith + 2]);
    su.uUpper.value.setRGB(v[V.upper], v[V.upper + 1], v[V.upper + 2]);
    su.uHorizon.value.setRGB(v[V.horizon], v[V.horizon + 1], v[V.horizon + 2]);
    su.uGlow.value.setRGB(v[V.glow], v[V.glow + 1], v[V.glow + 2]);
    su.uSun.value.setRGB(v[V.disc], v[V.disc + 1], v[V.disc + 2]);
    su.uFog.value.setRGB(v[V.fog], v[V.fog + 1], v[V.fog + 2]);
    su.uLit.value.setRGB(v[V.lit], v[V.lit + 1], v[V.lit + 2]);
    su.uStops.value.set(v[V.stops], v[V.stops + 1], v[V.stops + 2], v[V.stops + 3]);
    su.uFogMix.value = v[V.fogMix];
    su.uSunDir.value.set(v[V.sunDir], v[V.sunDir + 1], v[V.sunDir + 2]);
    if (midFade) su.uSunDir.value.normalize();                         // normalized lerp (exact values at a snap / the end)
    su.uSunK.value.set(v[V.sunK], v[V.sunK + 1], v[V.sunK + 2], v[V.sunK + 3]);
    su.uCloud.value.set(v[V.cloud], v[V.cloud + 1], v[V.cloud + 2], v[V.cloud + 3]);
    su.uSkyK.value.set(v[V.skyK], v[V.skyK + 1]);
    su.uDisc.value.set(v[V.discK], v[V.discK + 1], v[V.discK + 2]);
    su.uCloudCover.value = v[V.cover];
    su.uStars.value.set(v[V.stars], v[V.stars + 1]);
    su.uSkyLitTh.value = v[V.litTh];
    const gu = this._groundU;
    gu.uGrGround.value.setRGB(v[V.gGround], v[V.gGround + 1], v[V.gGround + 2]);
    gu.uGrShoulder.value.setRGB(v[V.gShoulder], v[V.gShoulder + 1], v[V.gShoulder + 2]);
    gu.uGrGrass.value.setRGB(v[V.gGrass], v[V.gGrass + 1], v[V.gGrass + 2]);
    gu.uGrPool.value.set(v[V.pool], v[V.pool + 1], v[V.pool + 2]);
    gu.uGrPoolK.value.x = v[V.poolR]; gu.uGrPoolK.value.y = v[V.poolR + 1];
    const ru = this._roadU;
    ru.uGrAsphaltMul.value.set(v[V.asphalt], v[V.asphalt + 1], v[V.asphalt + 2]);
    ru.uGrDashMul.value.set(v[V.dash], v[V.dash + 1], v[V.dash + 2]);
    ru.uGrEdgeMul.value.set(v[V.edge], v[V.edge + 1], v[V.edge + 2]);
    ru.uGrPuddles.value.set(v[V.puddles], v[V.puddles + 1]);
    ru.uGrWet.value.setRGB(v[V.horizon] * WET_REFLECT, v[V.horizon + 1] * WET_REFLECT, v[V.horizon + 2] * WET_REFLECT);
    this._roadMat.roughness = v[V.rough];
    const cc = this.curbs.instanceColor;
    if (cc) {
      const a = cc.array;
      for (let i = 0; i < a.length; i += 3) { a[i] = v[V.curb]; a[i + 1] = v[V.curb + 1]; a[i + 2] = v[V.curb + 2]; }
      cc.needsUpdate = true;
    }
    const bm = this._buildingMat, bu = this._bU, b0 = this._bBase;
    bm.color.setRGB(b0.r * v[V.bColor], b0.g * v[V.bColor + 1], b0.b * v[V.bColor + 2]);
    if (this._hasWindows) {
      bm.emissive.setRGB(v[V.bWin], v[V.bWin + 1], v[V.bWin + 2]);
      bm.emissiveIntensity = v[V.bWinE];
    }
    bu.uGrDark.value = v[V.bDark];
    const bb = v[V.bBounce];
    bu.uGrBounce.value.setRGB(v[V.fog] * bb, v[V.fog + 1] * bb, v[V.fog + 2] * bb);
    bu.uGrWin.value.set(v[V.bWinAD], v[V.bWinAD + 1]);
    bu.uGrSnow.value.set(v[V.snow], v[V.snow + 1], v[V.snow + 2], v[V.snow + 3]);
    this._lampU.uGrEmitGain.value = v[V.lampGain];
    this._lampU.uGrUnlit.value = v[V.unlit];
    this._beaconU.uGrEmitGain.value = v[V.beaconGain];
    this._beaconU.uGrUnlit.value = v[V.unlit];
    this._beaconU.uGrBlink.value.y = v[V.blinkDuty]; this._beaconU.uGrBlink.value.z = v[V.blinkDuty + 1];
    const mu = this._smokeMat.uniforms;
    mu.uColBottom.value.setRGB(v[V.smBottom], v[V.smBottom + 1], v[V.smBottom + 2]);
    mu.uColTop.value.setRGB(v[V.smTop], v[V.smTop + 1], v[V.smTop + 2]);
    mu.uEmber.value.setRGB(v[V.smEmber], v[V.smEmber + 1], v[V.smEmber + 2]);
    mu.uGlow.value.setRGB(v[V.glow], v[V.glow + 1], v[V.glow + 2]);
    mu.uGlowBounce.value = v[V.smGlowBounce];
    mu.uSmokeK.value.z = v[V.smAlpha];
  }

  /** Builds per-slot view geometries over ctx.models.geo (shared BufferAttributes + index, plus the slot's iEmit on the
   *  emissive slots; models' geometries are never mutated). Lazy: needs ModelLibrary.init. */
  _adopt() {
    if (this._adopted || !this._built) return;
    const mg = this.ctx.models && this.ctx.models.geo ? this.ctx.models.geo : null;
    if (!mg) return;
    for (const kind in DISTRICT_PROPS) {
      const def = DISTRICT_PROPS[kind];
      if (def.builtin) continue;
      const s = SLOTS.indexOf(def.slot);
      const m = this._slotMesh[s];
      const src = mg[kind];
      if (!m || !src || !src.attributes || !src.index) continue;
      const a = src.attributes;
      if (!(a.position && a.normal && a.uv && a.color) || a.color.itemSize !== 3 || a.uv1 || a.tangent) continue;   // keep the slot's program key
      const g = new BufferGeometry();
      g.setIndex(src.index);
      g.setAttribute('position', a.position);
      g.setAttribute('normal', a.normal);
      g.setAttribute('uv', a.uv);
      g.setAttribute('color', a.color);
      const own = this._views[s].get(SLOTS[s]);
      if (own && own.attributes.iEmit) g.setAttribute('iEmit', own.attributes.iEmit);   // the slot's shared per-instance gate
      if (!src.boundingBox) src.computeBoundingBox();
      g.boundingBox = src.boundingBox;
      if (!src.boundingSphere) src.computeBoundingSphere();
      g.boundingSphere = src.boundingSphere;
      g.name = 'env.view.' + kind;
      this._views[s].set(kind, g);
      this._kindH[kind] = src.boundingBox.max.y;
    }
    this._adopted = true;
    this._resolveTargets();
  }

  /** The effective target slot entries: the district's kind when its geometry is available, else the slot's built-in. */
  _resolveTargets() {
    const T = this._T;
    for (let s = 0; s < SLOT_N; s++) {
      const st = T.slots[s];
      this._tSlot[s] = (st.builtin || this._views[s].has(st.kind)) ? st : T.fallback[s];
    }
  }

  /** Assigns the target kind's geometry to slot s: stride / count 6 × per, castShadow, whole buffer hidden. */
  _swapSlot(s) {
    const m = this._slotMesh[s];
    const st = this._tSlot[s];
    const geo = this._views[s].get(st.kind);
    if (!m || !geo) return;
    m.geometry = geo;
    this._geoKind[s] = st.kind;
    const per = st.def.per;
    this._per[SLOTS[s]] = per;
    m.count = Math.min(SLOT_CAP[s], SEGMENTS * per);
    m.castShadow = st.def.castShadow === false ? false : this._slotCast[s];
    m.instanceMatrix.array.fill(0);
    m.instanceMatrix.needsUpdate = true;
    const e = geo.attributes.iEmit;
    if (e) { e.array.fill(0); e.needsUpdate = true; }
    if (s === S_LAMP) { this._lampBits.fill(0); if (this._lampCastHold) m.castShadow = false; }
  }

  /** Called after every segment recycle: drain countdown, then swap + refill beyond hiddenBeyondZ (DISTRICTS.md §3.3). */
  _onRecycle() {
    let swapped = false;
    for (let s = 0; s < SLOT_N; s++) {
      if (this._drain[s] > 0 && --this._drain[s] === 0) { this._swapSlot(s); swapped = true; }
    }
    if (!swapped) return;
    for (let k = 0; k < SEGMENTS; k++) if (this._segZ[k] + SEG_LEN < HIDDEN_Z) this._placeSegment(k);   // other slots rewrite identical data
  }

  /** The fade's 0.5 point: re-applies the target's lit mode to the lamps still placed (the slot's geometry shows lamps):
   *  Overcast → Night lights the intact highway lamps as the pools fade in; Night → Toxic switches them off while they
   *  drain (DISTRICTS.md §3.3; Toxic's lamps.lit 'none' exists for exactly this). One upload. */
  _relightLamps() {
    if (this._geoKind[S_LAMP] !== 'lamppost') return;
    const m = this._slotMesh[S_LAMP];
    const e = m.geometry.attributes.iEmit;
    if (!e) return;
    const bits = this._lampBits, mode = this._litMode;
    for (let i = 0; i < m.count; i++) {
      const b = bits[i];
      e.array[i] = (b & 1) && (mode === 'all' || (mode === 'mixed' && (b & 2))) ? 1 : 0;
    }
    e.needsUpdate = true;
  }

  /** Fresh ring: segments back to [RING_START + 30k], anchor 0, every segment re-placed from the seed. */
  _layoutAll() {
    this._anchor = 0;
    this._dist = 0;
    for (let k = 0; k < SEGMENTS; k++) {
      this._segZ[k] = RING_START + k * SEG_LEN;
      this._segG[k] = SEGMENTS - 1 - k;                               // nearest segment = index 0; indices grow with distance
    }
    for (let k = 0; k < SEGMENTS; k++) this._placeSegment(k);
    this._sync();
  }

  /** Writes positions that move every frame: road segment centres (uGrSegZ), ring anchor, shader scroll uniforms. */
  _sync() {
    const segZ = this._roadU.uGrSegZ.value;
    for (let k = 0; k < SEGMENTS; k++) segZ[k] = this._segZ[k] + SEG_LEN / 2;
    for (let i = 0; i < this._ring.length; i++) {
      const m = this._ring[i];
      m.position.z = this._anchor;
      m.updateMatrix();
    }
    this._groundU.uGrScroll.value = this._dist % GROUND.periodM;
    this._groundU.uGrLampPhase.value = posMod(RING_START + LAYOUT.lamp.offset + this._dist, LAMP_PITCH);
    this._dustMat.uniforms.uScroll.value = this._dist % this._wBox[2];   // the ACTIVE box (a stale period jumps every wrap)
  }

  /** Folds the anchor back into the instance matrices (float32 precision); rare. */
  _rebase() {
    const a = this._anchor;
    for (let i = 0; i < this._ring.length; i++) {
      const m = this._ring[i];
      const arr = m.instanceMatrix.array;
      const n = arr.length / 16;                                      // every instance: a hidden slot may be shown again later
      for (let j = 0; j < n; j++) {
        const o = j * 16;
        if (arr[o + 15] !== 0) arr[o + 14] += a;                      // hidden slots stay all-zero
      }
      m.instanceMatrix.needsUpdate = true;
    }
    this._anchor = 0;
  }

  _put(m, i, x, y, z, yaw, pitch, roll, sx, sy, sz) {
    if (this._dry) return;
    _euler.set(pitch, yaw, roll, 'YXZ');
    _quat.setFromEuler(_euler);
    _pos.set(x, y, z - this._anchor);
    _scl.set(sx, sy, sz);
    _mat.compose(_pos, _quat, _scl);
    _mat.toArray(m.instanceMatrix.array, i * 16);
  }

  _hide(m, i) {
    if (this._dry) return;
    m.instanceMatrix.array.fill(0, i * 16, i * 16 + 16);
    const e = m.geometry.attributes.iEmit;
    if (e) e.array[i] = 0;
  }

  _tint(m, i, r, g, b) {
    if (this._dry) return;
    const c = m.instanceColor;
    if (!c) return;
    c.array[i * 3] = r; c.array[i * 3 + 1] = g; c.array[i * 3 + 2] = b;
  }

  /** Multiplies instance i's colour by a slot tint (linear multiplier; null = none). */
  _mulTint(m, i, t) {
    if (!t || this._dry) return;
    const c = m.instanceColor;
    if (!c) return;
    c.array[i * 3] *= t[0]; c.array[i * 3 + 1] *= t[1]; c.array[i * 3 + 2] *= t[2];
  }

  /** Neutral per-instance brightness jitter with a faint warm/cool cast (× the slot tint when given). */
  _tintJitter(m, i, amount, tint) {
    const v = 1 + (rnd() * 2 - 1) * amount;
    const w = (rnd() - 0.5) * amount * 0.5;
    this._tint(m, i, v * (1 + w), v, v * (1 - w));
    if (tint) this._mulTint(m, i, tint);
  }

  _emit(m, i, on) {
    if (this._dry) return;
    const e = m.geometry.attributes.iEmit;
    if (e) e.array[i] = on;
  }

  /** Count for a segment: per · weight · density · U(floor, floor + spread), clamped to [0, per] (D1 weight 1: today's). */
  _count(per, weight) {
    const n = Math.round(per * weight * this._density * rrange(LAYOUT.densityFloor, LAYOUT.densityFloor + LAYOUT.densitySpread));
    return n < 0 ? 0 : (n > per ? per : n);
  }

  /** Presence chance of a chance-gated kind (DISTRICTS.md §7.2): chance × weight × min(1, density × (floor + spread / 2)). */
  _gateChance(L, weight) {
    return L.chance * weight * Math.min(1, this._density * (LAYOUT.densityFloor + LAYOUT.densitySpread / 2));
  }

  /** Anchor record for the smoke placer (written in dry runs too, so pending segments keep the same RNG stream). */
  _record(s, x, z, sy) {
    const n = this._recN[s];
    if (n >= ANCHOR_REC) return;
    const o = s * ANCHOR_REC + n;
    this._recX[o] = x; this._recZ[o] = z; this._recSY[o] = sy;
    this._recN[s] = n + 1;
  }

  /** Seeded placement of every prop belonging to segment k (mulberry32(levelSeed·propSeedMult + index)). */
  _placeSegment(k) {
    rseed(this._seed * ENV.propSeedMult + this._segG[k]);
    const z0 = this._segZ[k];
    this._placeCurbs(k, z0);
    for (let j = 0; j < PLACE_ORDER.length; j++) this._placeSlot(PLACE_ORDER[j], k, z0);
    this._placeSmoke(k, z0);
    this._placeManholes(k, z0);                                       // last: earlier props keep their rng sequence
    for (let i = 0; i < this._ring.length; i++) {
      const m = this._ring[i];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      const e = m.geometry.attributes.iEmit;
      if (e) e.needsUpdate = true;
    }
  }

  /** Places slot s in segment k with the target district's kind. A slot whose geometry still shows another kind is
   *  pending (draining): its placer runs for the target kind with writes suppressed (same RNG draws), and its own
   *  instances in the segment stay hidden (DISTRICTS.md §3.3). */
  _placeSlot(s, k, z0) {
    const st = this._tSlot[s];
    const m = this._slotMesh[s];
    const pending = this._geoKind[s] !== st.kind;
    const per = st.def.per;
    this._recN[s] = 0;
    this._dry = pending;
    if (st.builtin) {
      switch (st.kind) {
        case 'lamppost': this._placeLamps(m, k, z0, per, st); break;
        case 'barricade': this._placeBarricades(m, k, z0, per, st); break;
        case 'sandbags': this._placeSandbags(m, k, z0, per, st); break;
        case 'car': this._placeCars(m, k, z0, per, st); break;
        case 'building': this._placeBuildings(m, k, z0, per, st); break;
        case 'tree': this._placeTrees(m, k, z0, per, st); break;
        case 'rubble': this._placeRubble(m, k, z0, per, st); break;
        default: break;
      }
    } else {
      switch (st.def.placer) {
        case 'chain': this._genChain(m, k, z0, per, st, s); break;
        case 'scatter': this._genScatter(m, k, z0, per, st, s); break;
        case 'cars': this._genCars(m, k, z0, per, st, s); break;
        default: break;
      }
    }
    this._dry = false;
    if (pending) {
      const p = this._per[SLOTS[s]];
      for (let i = k * p; i < (k + 1) * p; i++) this._hide(m, i);
      if (s === S_LAMP && this._geoKind[s] === 'lamppost') for (let i = k * p; i < (k + 1) * p; i++) this._lampBits[i] = 0;
    }
  }

  _placeCurbs(k, z0) {
    const m = this.curbs;
    const x = ROAD_HALF + LAYOUT.curb.w / 2;
    const i = k * 2;
    if (i + 1 >= m.count) return;
    this._put(m, i, -x, 0, z0 + SEG_LEN / 2, 0, 0, 0, 1, 1, 1);
    this._put(m, i + 1, x, 0, z0 + SEG_LEN / 2, 0, 0, 0, 1, 1, 1);
  }

  /** Lamps (built-in): DISTRICTS.md §2 lamp rules — layout 'mixed' (today's presence × weight, broken / dark draws) or
   *  'all' (every lamp present and upright; the same draws are taken); lit 'mixed' | 'all' | 'none'. Stores the
   *  upright / seeded-lit bits for the fade's 0.5 relight. */
  _placeLamps(m, k, z0, per, st) {
    const L = st.layout;
    const all = this._T.lamps.layout === 'all';
    const mode = this._litMode;
    const bits = this._lampBits;
    const end = (k + 1) * per;
    let i = k * per;
    const perSide = Math.max(1, Math.floor(per / 2));
    const present = (L.present + (1 - L.present) * this._density) * st.weight;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      for (let j = 0; j < perSide && i < end; j++) {
        const z = z0 + L.offset + j * L.pitch + (side > 0 ? L.pitch / 2 : 0);   // staggered rows, 15 m pitch per side
        if (rnd() >= present && !all) { this._hide(m, i); if (!this._dry) bits[i] = 0; i++; continue; }
        const broken = rnd() < L.broken && !all;
        const seeded = !broken && rnd() >= L.dark;
        const lit = mode === 'all' ? !broken : (mode === 'mixed' ? seeded : false);
        const sc = rpick2(L.scale);
        const roll = broken ? -rpick2(L.tilt) : (rnd() - 0.5) * 0.03;    // broken posts lean away from the road
        this._put(m, i, side * L.x, 0, z, side > 0 ? 0 : Math.PI, (rnd() - 0.5) * 0.03, roll, sc, sc, sc);
        this._emit(m, i, lit ? 1 : 0);
        if (!this._dry) bits[i] = (broken ? 0 : 1) | (seeded ? 2 : 0);
        this._tintJitter(m, i, LAYOUT.tintJitter, st.tint);
        i++;
      }
    }
    while (i < end) { this._hide(m, i); if (!this._dry) bits[i] = 0; i++; }
  }

  _placeBarricades(m, k, z0, per, st) {
    const B = st.layout;
    const end = (k + 1) * per;
    let i = k * per;
    const n = this._count(per, st.weight);
    let placed = 0;
    while (placed < n && i < end) {
      const side = rside();
      const chain = Math.min(1 + Math.floor(rnd() * B.maxChain), n - placed);
      const zc = z0 + rnd() * SEG_LEN;
      const xc = side * rpick2(B.x);
      const yaw = HALF_PI + (rnd() - 0.5) * B.jitter + (rnd() < B.diagonal ? side * 0.7 : 0);   // long axis along the road
      const ax = Math.cos(yaw), az = -Math.sin(yaw);                  // local +x in world space
      for (let c = 0; c < chain && i < end; c++) {
        const off = (c - (chain - 1) / 2) * B.chain;
        let x = xc + ax * off + (rnd() - 0.5) * 0.15;
        const minX = B.x[0];
        if (x * side < minX) x = side * minX;                         // never onto the road / curb
        const toppled = rnd() < B.toppled;
        this._put(m, i, x, toppled ? 0.31 : 0, zc + az * off, yaw + (rnd() - 0.5) * 0.12,
          toppled ? (rnd() < 0.5 ? -HALF_PI : HALF_PI) : 0, toppled ? 0 : (rnd() - 0.5) * 0.04, 1, 1, 1);
        this._emit(m, i, (!toppled && rnd() < B.beaconOn) ? 1 : 0);
        this._tintJitter(m, i, LAYOUT.tintJitter, st.tint);
        i++; placed++;
      }
    }
    while (i < end) this._hide(m, i++);
  }

  _placeSandbags(m, k, z0, per, st) {
    const S = st.layout;
    const end = (k + 1) * per;
    let i = k * per;
    const n = this._count(per, st.weight);
    for (let c = 0; c < n && i < end; c++) {
      const side = rside();
      const sc = rpick2(S.scale);
      // the arc's convex face (local −z) faces the road
      this._put(m, i, side * rpick2(S.x), 0, z0 + rnd() * SEG_LEN, side * HALF_PI + (rnd() - 0.5) * 1.2, 0, 0, sc, sc * rrange(0.85, 1.1), sc);
      this._tintJitter(m, i, LAYOUT.tintJitter, st.tint);
      i++;
    }
    while (i < end) this._hide(m, i++);
  }

  _placeCars(m, k, z0, per, st) {
    const C = st.layout;
    const end = (k + 1) * per;
    let i = k * per;
    const n = this._count(per, st.weight);
    for (let c = 0; c < n && i < end; c++) {
      const side = rside();
      const z = z0 + (c + 0.15 + 0.7 * rnd()) * (SEG_LEN / n);       // stratified along the segment
      const x = side * rpick2(C.x);
      const yaw = rnd() < C.cross
        ? HALF_PI + (rnd() - 0.5) * 0.6
        : (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * C.yawJitter;
      const pose = rnd();
      let y = 0, pitch = (rnd() - 0.5) * 0.05, roll = (rnd() - 0.5) * 0.06;
      if (pose < C.flipped) { roll = Math.PI; y = 1.37; pitch = 0; }                    // on its roof (roof height 1.37 m)
      else if (pose < C.flipped + C.onSide) { roll = (rnd() < 0.5 ? -1 : 1) * HALF_PI; y = 0.9; pitch = 0; }   // on its side (half width)
      this._put(m, i, x, y, z, yaw, pitch, roll, 1, 1, 1);
      if (rnd() < C.burnt) {
        _col.setHex(PALETTE.props.rust);
        const b = rrange(0.35, 0.55);
        this._tint(m, i, _col.r * b, _col.g * b, _col.b * b);
      } else {
        const cars = PALETTE.props.car;
        _col.setHex(cars[Math.floor(rnd() * cars.length) % cars.length]);
        const d = rpick2(C.dark);
        this._tint(m, i, _col.r * d, _col.g * d, _col.b * d);
      }
      this._mulTint(m, i, st.tint);
      i++;
    }
    while (i < end) this._hide(m, i++);
  }

  /** Buildings (built-in): near-row presence = min(1, weight × today's), far-row = min(1, layout.far × today's);
   *  storeys / farStoreys overrides come through the merged layout (DISTRICTS.md §7.2). */
  _placeBuildings(m, k, z0, per, st) {
    const B = st.layout;
    const end = (k + 1) * per;
    let i = k * per;
    const dens = this._density;
    const nearPresent = Math.min(1, st.weight * (B.present + (1 - B.present) * dens));
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      for (let j = 0; j < 2 && i < end; j++) {
        if (rnd() >= nearPresent) { this._hide(m, i++); continue; }
        const storeys = Math.floor(rrange(B.storeys[0], B.storeys[1] + 1));
        const sx = rpick2(B.width), sz = rpick2(B.depth);
        const zc = z0 + (j + 0.5) * (SEG_LEN / 2) + (side > 0 ? SEG_LEN / 8 : 0) + (rnd() - 0.5) * B.slotJitter;
        const x = side * (rpick2(B.front) + 3 * sz);                  // front face at |x| = front (model depth 6 m)
        const yaw = (side > 0 ? -HALF_PI : HALF_PI) + (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * 0.08;
        this._put(m, i, x, 0, zc, yaw, 0, 0, sx, storeys / 3, sz);
        this._buildingTint(m, i, B.tint);
        i++;
      }
    }
    if (i < end) {
      // skyline row: one tall far block per segment (alternating sides by seed)
      if (rnd() < Math.min(1, st.far * (B.farPresent + (1 - B.farPresent) * dens * 0.5))) {
        const side = rside();
        const storeys = Math.floor(rrange(B.farStoreys[0], B.farStoreys[1] + 1));
        const sx = rpick2(B.farWidth), sz = rpick2(B.farWidth);
        this._put(m, i, side * rpick2(B.farX), 0, z0 + rnd() * SEG_LEN, rnd() * TAU, 0, 0, sx, storeys / 3, sz);
        this._buildingTint(m, i, B.tint);
      } else this._hide(m, i);
      i++;
    }
    while (i < end) this._hide(m, i++);
  }

  _buildingTint(m, i, amount) {
    const v = 1 + (rnd() * 2 - 1) * amount;
    const w = (rnd() - 0.5) * amount;
    this._tint(m, i, v * (1 + w), v * (1 + w * 0.3), v * (1 - w));
  }

  _placeTrees(m, k, z0, per, st) {
    const T = st.layout;
    const end = (k + 1) * per;
    let i = k * per;
    const n = this._count(per, st.weight);
    for (let c = 0; c < n && i < end; c++) {
      const side = rside();
      const sc = rpick2(T.scale);
      this._put(m, i, side * rpick2(T.x), 0, z0 + rnd() * SEG_LEN, rnd() * TAU, (rnd() - 0.5) * T.lean, (rnd() - 0.5) * T.lean, sc, sc * rrange(0.9, 1.15), sc);
      this._tintJitter(m, i, LAYOUT.tintJitter, st.tint);
      i++;
    }
    while (i < end) this._hide(m, i++);
  }

  _placeRubble(m, k, z0, per, st) {
    const R = st.layout;
    const end = (k + 1) * per;
    let i = k * per;
    const n = this._count(per, st.weight);
    for (let c = 0; c < n && i < end; c++) {
      const side = rside();
      const x = side * (R.x[0] + (R.x[1] - R.x[0]) * rnd() * rnd());   // biased toward the shoulder
      const sc = rpick2(R.scale);
      this._put(m, i, x, 0, z0 + rnd() * SEG_LEN, rnd() * TAU, 0, 0, sc, sc * rpick2(R.squash), sc);
      this._tintJitter(m, i, LAYOUT.tintJitter, st.tint);
      i++;
    }
    while (i < end) this._hide(m, i++);
  }

  // ---- generic placers for the non-builtin kinds (DISTRICTS.md §7.2; defaults in brackets there) ----

  /** Base yaw of a yaw mode: 'along' π/2 (long axis along the road), 'face' 0 (front +z toward the camera), 'random'. */
  _yawBase(mode) {
    if (mode === 'face') return 0;
    if (mode === 'random') return rnd() * TAU;
    return HALF_PI;
  }

  /** |x| clearance: keeps the footprint (across × scale) outside DISTRICT_RULES.edgeClearX. */
  _clearX(x, side, across) {
    const min = EDGE_X + across;
    return x * side < min ? side * min : x;
  }

  /** Half extent of a kind across the road for a yaw (local x → world (cos, 0, −sin), local z → (sin, 0, cos)). */
  _across(def, yaw, sc, random) {
    const hx = def.half[0], hz = def.half[1];
    if (random) return Math.max(hx, hz) * sc;
    return (Math.abs(Math.cos(yaw)) * hx + Math.abs(Math.sin(yaw)) * hz) * sc;
  }

  /** chain: chains of `chain`-spaced members along the chain's local x (barrier, neon, barrel, pipe). */
  _genChain(m, k, z0, per, st, s) {
    const L = st.layout, def = st.def;
    const end = (k + 1) * per;
    let i = k * per;
    const gated = L.chance !== undefined;
    let n;
    if (gated) {
      const p = this._gateChance(L, st.weight);
      n = 0;
      for (let c = 0; c < per; c++) if (rnd() < p) n++;
    } else n = this._count(per, st.weight);
    const mode = L.yaw || 'along';
    const spacing = L.chain !== undefined ? L.chain : 2, maxChain = L.maxChain || 1;
    const jit = L.jitter || 0, diag = L.diagonal || 0, topp = L.toppled || 0, emitOn = L.emitOn || 0;
    const height = this._kindH[st.kind] || Math.max(def.half[0], def.half[1]);
    let placed = 0;
    while (placed < n && i < end) {
      const side = rside();
      const chain = Math.min(1 + Math.floor(rnd() * maxChain), n - placed);
      const zc = z0 + rnd() * SEG_LEN;
      const xc = side * rpick2(L.x);
      let yaw = this._yawBase(mode) + (rnd() - 0.5) * jit;
      if (rnd() < diag && mode === 'along') yaw += side * 0.7;
      const ax = Math.cos(yaw), az = -Math.sin(yaw);
      for (let c = 0; c < chain && i < end; c++) {
        const off = (c - (chain - 1) / 2) * spacing;
        const z = zc + az * off;
        let x = xc + ax * off + (rnd() - 0.5) * 0.15;
        const toppled = rnd() < topp;
        const pitch = toppled ? (rnd() < 0.5 ? -HALF_PI : HALF_PI) : 0;
        let across = this._across(def, yaw, 1, mode === 'random');
        if (toppled) across = Math.max(across, height);                // lying on its side: its height may point at the road
        x = this._clearX(x, side, across);
        this._put(m, i, x, toppled ? def.half[1] : 0, z, yaw, pitch, 0, 1, 1, 1);
        const on = rnd() < emitOn;
        this._emit(m, i, on && !toppled ? 1 : 0);
        this._tintJitter(m, i, LAYOUT.tintJitter, st.tint);
        this._record(s, x, z, 1);
        i++; placed++;
      }
    }
    while (i < end) this._hide(m, i++);
  }

  /** scatter: independent instances in an |x| band (cones, billboard, container, smokestack, puddle, dune, rock, snowbank, pine). */
  _genScatter(m, k, z0, per, st, s) {
    const L = st.layout, def = st.def;
    const end = (k + 1) * per;
    let i = k * per;
    const gated = L.chance !== undefined;
    const p = gated ? this._gateChance(L, st.weight) : 0;
    const n = gated ? per : this._count(per, st.weight);
    const mode = L.yaw || 'random';
    const jit = L.jitter || 0, lean = L.lean || 0, emitOn = L.emitOn || 0;
    const paint = def.colors && def.colors.paint ? def.colors.paint : null;
    for (let c = 0; c < n && i < end; c++) {
      if (gated && rnd() >= p) { this._hide(m, i++); continue; }
      const side = rside();
      const xa = L.bias === 'shoulder' ? L.x[0] + (L.x[1] - L.x[0]) * rnd() * rnd() : rpick2(L.x);
      const z = z0 + rnd() * SEG_LEN;
      const yaw = this._yawBase(mode) + (rnd() - 0.5) * jit;
      const sc = L.scale ? rpick2(L.scale) : 1;
      const sy = sc * (L.squash ? rpick2(L.squash) : 1);
      const pitch = lean ? (rnd() - 0.5) * lean : 0;
      const roll = lean ? (rnd() - 0.5) * lean : 0;
      const x = this._clearX(side * xa, side, this._across(def, yaw, sc, mode === 'random'));
      this._put(m, i, x, 0, z, yaw, pitch, roll, sc, sy, sc);
      this._emit(m, i, rnd() < emitOn ? 1 : 0);
      this._tintJitter(m, i, LAYOUT.tintJitter, st.tint);
      if (paint) {                                                    // container: one paint per instance (data: "paint: one per instance")
        _col.setHex(paint[Math.floor(rnd() * paint.length) % paint.length]);
        this._mulTint(m, i, _rgb3(_col));
      }
      this._record(s, x, z, sy);
      i++;
    }
    while (i < end) this._hide(m, i++);
  }

  /** cars: car-frame kinds (truck, burning wreck, frozen car): poses, per-instance paint / frost / neutral colour. */
  _genCars(m, k, z0, per, st, s) {
    const L = st.layout, def = st.def, C = def.colors || {};
    const end = (k + 1) * per;
    let i = k * per;
    const gated = L.chance !== undefined;
    const p = gated ? this._gateChance(L, st.weight) : 0;
    const n = gated ? per : this._count(per, st.weight);
    const cross = L.cross || 0, fl = L.flipped || 0, os = L.onSide || 0, yj = L.yawJitter || 0;
    const burntP = L.burnt || 0, dark = L.dark || null, emitOn = L.emitOn || 0;
    const poseY = def.poseY || [0, 0];
    for (let c = 0; c < n && i < end; c++) {
      if (gated && rnd() >= p) { this._hide(m, i++); continue; }
      const side = rside();
      const z = z0 + (c + 0.15 + 0.7 * rnd()) * (SEG_LEN / n);       // stratified along the segment
      const xa = side * rpick2(L.x);
      const crossed = rnd() < cross;
      const yaw = crossed ? HALF_PI + (rnd() - 0.5) * 0.6 : (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * yj;
      const pose = rnd();
      let y = 0, pitch = (rnd() - 0.5) * 0.05, roll = (rnd() - 0.5) * 0.06, upright = true, onSide = false;
      if (pose < fl) { roll = Math.PI; y = poseY[0]; pitch = 0; upright = false; }
      else if (pose < fl + os) { roll = (rnd() < 0.5 ? -1 : 1) * HALF_PI; y = poseY[1]; pitch = 0; upright = false; onSide = true; }
      let across = this._across(def, yaw, 1, false);
      if (onSide) across = Math.max(across, poseY[1]);
      const x = this._clearX(xa, side, across);
      this._put(m, i, x, y, z, yaw, pitch, roll, 1, 1, 1);
      const burnt = rnd() < burntP;
      if (burnt) {
        _col.setHex(PALETTE.props.rust);
        const b = rrange(0.35, 0.55);
        this._tint(m, i, _col.r * b, _col.g * b, _col.b * b);
      } else if (C.paint) {                                           // truck: one paint per instance × U(dark)
        _col.setHex(C.paint[Math.floor(rnd() * C.paint.length) % C.paint.length]);
        const d = dark ? rpick2(dark) : 1;
        this._tint(m, i, _col.r * d, _col.g * d, _col.b * d);
      } else if (st.frost) {                                          // frozen car: frost(paint) = mix(paint, frost, layout.frost)
        const cars = PALETTE.props.car;
        _col.setHex(cars[Math.floor(rnd() * cars.length) % cars.length]);
        const d = dark ? rpick2(dark) : 1;
        const f = L.frost, F = st.frost;
        this._tint(m, i, _col.r * d + (F[0] - _col.r * d) * f, _col.g * d + (F[1] - _col.g * d) * f, _col.b * d + (F[2] - _col.b * d) * f);
      } else {                                                        // burning wreck: geometry colours are final
        this._tintJitter(m, i, LAYOUT.tintJitter, null);
      }
      this._mulTint(m, i, st.tint);
      const on = rnd() < emitOn;
      this._emit(m, i, on && upright ? 1 : 0);
      this._record(s, x, z, 1);
      i++;
    }
    while (i < end) this._hide(m, i++);
  }

  /** 0–MANHOLE.max covers per segment at seeded lane positions (no fixed period, unlike texture content). */
  _placeManholes(k, z0) {
    const m = this.props.get('manhole');
    if (!m) return;
    const per = this._per.manhole;
    const end = (k + 1) * per;
    for (let i = k * per; i < end; i++) {
      if (rnd() >= MANHOLE.chance) { this._hide(m, i); continue; }
      const x = rside() * rpick2(MANHOLE.x);
      const z = z0 + ((i - k * per) + 0.1 + 0.8 * rnd()) * (SEG_LEN / per);   // stratified: two covers never overlap
      this._put(m, i, x, 0, z, rnd() * TAU, 0, 0, 1, 1, 1);
      this._tintJitter(m, i, LAYOUT.tintJitter);
    }
  }

  /** Smoke columns: free-standing (today's routine with the district's chance / w / h) or anchored to a slot's visible
   *  instances of this segment (smokestack tops, burning wrecks), each with probability `chance`, up to `per`; hidden
   *  while the anchor slot is pending (DISTRICTS.md §6.2). */
  _placeSmoke(k, z0) {
    const m = this.smoke;
    const per = this._per.smoke;
    const S = this._T.smoke;
    const end = (k + 1) * per;
    let i = k * per;
    if (S.anchor < 0 || this._tSlot[S.anchor].builtin) {
      const X = LAYOUT.smoke.x;
      for (; i < end; i++) {
        if (rnd() >= S.chance) { this._hide(m, i); continue; }
        const side = rside();
        this._put(m, i, side * rpick2(X), 0, z0 + rnd() * SEG_LEN, 0, 0, 0, rpick2(S.w), rpick2(S.h), 1);
      }
      return;
    }
    const a = S.anchor;
    const ast = this._tSlot[a];
    const pend = this._geoKind[a] !== ast.kind;
    const y0 = ast.def.smokeY || 0;
    const n = this._recN[a];
    for (let j = 0; j < n && i < end; j++) {
      if (rnd() >= S.chance) continue;
      const w = rpick2(S.w), h = rpick2(S.h);
      const o = a * ANCHOR_REC + j;
      if (pend) this._hide(m, i);
      else this._put(m, i, this._recX[o], y0 * this._recSY[o], this._recZ[o], 0, 0, 0, w, h, 1);
      i++;
    }
    while (i < end) this._hide(m, i++);
  }
}
