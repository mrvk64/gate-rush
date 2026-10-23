// js/render.js — GATE RUSH rendering core: RenderSystem, TextureFactory, GradeOutputPass.
//
// Contract: docs/ARCHITECTURE.md §6.3 (class shapes), §9 (scene graph, instancing, shadows, post,
// resize, textures), §4.1 step 5 (boot order), §2.1 (camera), §14 (coding rules). Numbers come from
// data.js (WORLD, RENDER, PALETTE, QUALITY_TIERS, GATE_RULES, JUICE …); every literal that is not a data
// key is a drawing / shader shape constant and is commented as such, or a DATA-MISSING constant.
//
// Render split (lead decision, overrides §1's single-file render.js): this file keeps RenderSystem,
// TextureFactory and GradeOutputPass and RE-EXPORTS MaterialLibrary (./materials.js) and Environment
// (./environment.js). Construction order inside RenderSystem.init(): WebGL 2 probe → renderer →
// ctx.quality → camera + lights → TextureFactory.build → MaterialLibrary → applyQuality → Environment.build.
// Materials / Environment read ctx.render.textures / .materials / .scene / .uniforms.uTime / ctx.quality
// at construction or build time (ctx.render is assigned by main before init()).
//
// Per-instance attribute contracts of the shared materials (implemented in materials.js /
// fxmaterials.js; consumers — gates, fx, zombies, weapons — write them):
//   gatePanel()  iPanel vec4 = (tintIdx, stripeMix, flash, ring01), iScale float (1 | wTriple/w)
//                tintIdx: 0 plus, 1 mult, 2 minus, 3 div, 4 zero, 5 item, 6 max; fractional ramps
//                8 + t = minus → zero → plus (red-gate flip), 10 + t = div → zero → mult (÷ ladder);
//                add 16 to draw the gold MAX pill — the "MAX" text itself is glyph quads placed by gates.
//                uOpacity = GATE_RULES.panel.opacity | opacityHC (RenderSystem applies the hcGates setting).
//   gateFrame()  iFrame vec4 = (typeIdx 0..5, tintT 0..1, maxed 0..1, emissiveBoost 0..∞)
//   glyph(bb)    iGlyph vec4 = (u0, v0, u1, v1) from TextureFactory.glyphUV, iPopTime float (uTime
//                seconds of the last hit; ≤ 0 never), iColor vec3 (linear HDR, e.g. 2.5 white)
//   particle(v)  p0 vec3, v0 vec3, birth, life, size (m), colorIdx, kind (0 spark, 1 blood, 2 muzzle,
//                3 smoke, 4 gold, 5 shard, 6 confetti, 7 dust, 8 flame, 9 splash, 10 coinSparkle)
//   decal()      iDecal vec4 = (kind 0 ring / 1 arc / 2 lane / 3 splat / 4 xband, progress, size m, colorIdx);
//                instance matrix = translation only (x, 0, z)
//   hpBar()      iHp float 0..1; instance matrix = translation + scale (width, height) — billboarded.
//   tracer()     instanceColor (linear HDR triplets written straight into the Float32Array).
// uTime (ctx.render.uniforms.uTime) = ctx.time.elapsed: scaled seconds since boot, advanced by update().
//
// Members beyond §6.3 that other modules use (docs/build/CALLSITES.md): callStats {main, shadow, post,
// total} (engine debug overlay), add(obj)/remove(obj) (scene helpers), digitAtlas/glow/icons getters and
// glyphUV()/iconUV() shortcuts onto the TextureFactory, blobShadows (the Low-tier disc mesh).
import {
  WebGLRenderer, WebGLRenderTarget, Scene, PerspectiveCamera, Color, Fog, Vector2, Vector3, Vector4,
  Mesh, InstancedMesh, CircleGeometry, PlaneGeometry, MeshBasicMaterial, CanvasTexture, DynamicDrawUsage,
  ColorManagement, SRGBTransfer, MeshDepthMaterial, RGBADepthPacking, FrontSide, BackSide, DoubleSide,
  DirectionalLight, HemisphereLight, PointLight,
  SRGBColorSpace, NoColorSpace, ACESFilmicToneMapping, PCFSoftShadowMap, PCFShadowMap,
  RepeatWrapping, ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, HalfFloatType, UnsignedByteType,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OutputShader } from 'three/addons/shaders/OutputShader.js';
import { clamp, lerp, lerpExp, ease, mulberry32, isIOS, warnOnce } from './util.js';
import { WORLD, QUALITY_TIERS, RENDER, PALETTE, GATE_RULES, JUICE, STRINGS, WEAPONS, GEAR, DISTRICTS } from './data.js';
import { detectTier, maxAutoTierFor, isSoftwareGpu } from './engine.js';
import { MaterialLibrary } from './materials.js';
import { Environment } from './environment.js';

export { MaterialLibrary } from './materials.js';
export { Environment } from './environment.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------
const DEG = Math.PI / 180;
const TIER_LOW = QUALITY_TIERS.order[0];                 // 'low' — the only tier without a composer (bloom 'off')
const BLOB_CAP = RENDER.blobShadow.capacity;             // 567 discs (ARCH §6.3 slot ranges)
const SCROLL_RESET_M = WORLD.segmentLength;              // a frame never scrolls a whole road segment: larger jumps are resets
const FOV_EPS = 1e-4;                                    // shape constant: skip updateProjectionMatrix for sub-epsilon FOV changes
const PROBE_ATTRS = Object.freeze({ failIfMajorPerformanceCaveat: false });   // ARCH §9.4 probe attributes
// r7 (perf-render:2): the first probe asks for a context WITHOUT a major performance caveat; Chrome refuses it for its
// automatic SwiftShader fallback and for WARP (software rendering / a blocklisted driver), and the second probe then
// tells WebGL 2 is still there but slow — such a device is treated as software GL like a matching GPU string
const PROBE_CAVEAT_ATTRS = Object.freeze({ failIfMajorPerformanceCaveat: true });
// r7 (perf-render:1): render-scale floor (ARCH §9.5): the backing store never gets shorter than this many device px
const RS_MIN_BACKING_PX = QUALITY_TIERS.renderScale.minBackingPx;
/** GPU strings that carry no information (masked RENDERER): treated as "no string" (fallback tier). */
const GENERIC_GPU = /^(WebKit WebGL|Mozilla|WebGL( ?2)?|Generic Renderer)$/i;

// Visual constants data.js has no key for (each named after the intended data.js path).
const POINT_LIGHT_DISTANCE = RENDER.pointLights.distance;    // default range of the boss-core / laser point lights (m; boss overrides its own) (data key; wired round-2 cross-group)
const POINT_LIGHT_DECAY = RENDER.pointLights.decay;      // default decay exponent of the two point lights (data key; wired round-2 cross-group)
const BLOB_Y = RENDER.blobShadow.y;               // disc height above the road (m) to avoid z-fighting (data key; wired round-2 cross-group)
// VIS-3 framing constraint (DATA-MISSING: WORLD.camera.framing): squad back = front + min(depth, backMaxM) at ndc y ≥
// −bottomNdc (−0.80: above the 8 % boss letterbox), spawn line (WORLD.spawnZ, ground) at ndc y ≤ topNdc (gates keep their
// GDD screen band); pull-back ≤ maxPullM; easeRate = exponential rate × 1/tween (≈ 95 % after one tween)
const FRAMING = Object.freeze({ bottomNdc: 0.8, topNdc: 0.62, backMaxM: 8, maxPullM: 8, solveIters: 10, easeRate: 3 });
// VIS-1: a prepared tier change commits when its programs are linked, or after this long at the latest (ms)
const TIER_COMMIT_FALLBACK_MS = 3000;
// VIS-1 post-commit warm-up of hidden content: objects drawn per frame, and the layer only the warm camera sees
const WARM_CHUNK = 6;
const WARM_LAYER = 31;
// Round-2 FX-10 residual (cross-group): objects on this layer only (fx: count label, its plate + HDR clamp; floaters on
// both layers) are drawn by OverlayRenderPass AFTER the bloom pass and before the grade pass, so no bloom haze of an
// HDR beam behind the label lands on the digits. The main camera never enables it on composer tiers; on Low (no
// composer) draw() enables it for the single scene render. The lights carry it as well (_buildLights: the overlay
// render must leave the main pass's light setup in three's render state). Exposed as render.overlayLayer.
const OVERLAY_LAYER = 30;
// VIS-1 chunked pre-compile: new programs per frame, CPU budget per frame (ms), readiness poll interval (ms)
const TIER_COMPILE = Object.freeze({ newPerFrame: 1, budgetMs: 6, pollMs: 16, touchPerTick: 3 });
// Round-2 cross-group (GAT-9 / CHR-13 / FX-14 "dependent prototype chain changed" deopts): the pre-compile used to
// compile each scene object through Object.create(object), which turned every mesh into a PROTOTYPE object for V8
// (prototype maps; any later shape change on a mesh then invalidated optimized code across modules). It now compiles
// through this one plain stand-in carrying exactly the fields three r170's compile() / getParameters() read from an
// object (WebGLRenderer.compile + WebGLPrograms.getParameters: the is* flags, material, geometry, instanceColor,
// morphTexture, _colorsTexture), so no scene object ever becomes a prototype.
const COMPILE_STAND = {
  isMesh: false, isPoints: false, isLine: false, isSprite: false, isLight: false, isInstancedMesh: false,
  isBatchedMesh: false, isSkinnedMesh: false, visible: true,
  material: null, geometry: null, instanceColor: null, morphTexture: null, _colorsTexture: null,
  parent: null, children: [],
  traverse(cb) { cb(this); },
  traverseVisible(cb) { cb(this); },
};
/** Loads `o`'s program-relevant fields (material `over` when given) into COMPILE_STAND and returns it. */
function compileStandIn(o, over, parent) {
  const s = COMPILE_STAND;
  s.isMesh = o.isMesh === true; s.isPoints = o.isPoints === true; s.isLine = o.isLine === true; s.isSprite = o.isSprite === true;
  s.isInstancedMesh = o.isInstancedMesh === true; s.isBatchedMesh = o.isBatchedMesh === true; s.isSkinnedMesh = o.isSkinnedMesh === true;
  s.material = over || o.material || null;
  s.geometry = o.geometry || null;
  s.instanceColor = o.instanceColor !== undefined ? o.instanceColor : null;
  s.morphTexture = o.morphTexture !== undefined ? o.morphTexture : null;
  s._colorsTexture = o._colorsTexture !== undefined ? o._colorsTexture : null;
  s.parent = parent;
  return s;
}
// VIS-17 boot / context-restore warm-up (render.warmup): nothing is drawing yet, so the chunks are bigger, still well
// under one 300 ms task at 4x CPU throttling. WARMUP_COMPILE: limits as TIER_COMPILE; WARMUP_DRAW_MS: chunked warm draws
// per frame; WARMUP_SPLIT: share of the progress the compile phase covers (the warm draws take the rest)
const WARMUP_COMPILE = Object.freeze({ newPerFrame: 8, budgetMs: 16, pollMs: 8, touchPerTick: 8 });
const WARMUP_DRAW_MS = 16;
const WARMUP_SPLIT = 0.6;
const WARMUP_DRAW_END = 0.97;           // progress at the end of the warm draws (the first real frame takes the rest)
const COMPILE_ISSUE_SHARE = 0.8;        // _compileChunked progress: issuing the compiles, then (the rest) waiting for links
const PAINT_YIELD_FALLBACK_MS = 100;    // yieldPaint() resolves by this time when rAF is paused (hidden tab) — = main.js YIELD_FALLBACK_MS
const PAINT_SLICE_MS = 16;              // texture build: paint between steps once they ran this long since the last paint (one 60 Hz frame)
// WebGLShadowMap's side swap for depth materials (r170: shadowSide[material.side] unless material.shadowSide is set)
const SHADOW_SIDE = Object.freeze({ [FrontSide]: BackSide, [BackSide]: FrontSide, [DoubleSide]: DoubleSide });
// Bloom blur kernel (VIS-4): shape constants of the Gaussian the TierBloomPass rebuilds (see the class)
const BLOOM_KERNEL_GROW = 1;       // taps added to each of UnrealBloomPass's 3/5/7/9/11 kernel radii (keeps the reach)
const BLOOM_SIGMA_PER_RADIUS = 1 / 3;   // sigma = KERNEL_RADIUS / 3 → the edge weight is ≈ e^−4.5 (round falloff)
const MAT_SAMPLE_FRAMES = 30;           // callStats.materials is resampled every 30 draws (debug overlay, VIS-13)
const BLOOM_MIPS_DEFAULT = 5;           // UnrealBloomPass's mip count: tiers without QUALITY_TIERS[tier].bloomMips (High)
// Custom ÷ atlas cell (VIS-5): fractions of the atlas cell (width for the bar length, height for the rest). The
// font's ÷ dots blur into the bar's vertical axis at 17–36 px and read as '+'; this one keeps a dark gap.
const DIV_SHAPE = Object.freeze({ barW: 0.7, barH: 0.12, dot: 0.24, gap: 0.13 });

// ---------------------------------------------------------------------------------------------
// Visual districts (round 5, docs/DISTRICTS.md §6.1 / §8.2): every value render lerps for a district, packed into one
// Float64Array per district at construction (linear colours from Color.setHex, scalars, the light offset vector), so a
// fade frame is index arithmetic into the preallocated current-state mirror `_cur` (no allocation, no Color objects).
// ---------------------------------------------------------------------------------------------
const DS_SUN_COL = 0;        // vec3 sun / moon light colour (linear)
const DS_SUN_I = 3;          // sun intensity
const DS_SUN_OFF = 4;        // vec3 light offset from the squad (direction AND distance, nlerped)
const DS_SUN_TAZ = 7;        // title-rig sun swing (deg)
const DS_HEMI_SKY = 8;       // vec3 hemisphere sky colour
const DS_HEMI_GND = 11;      // vec3 hemisphere ground colour
const DS_HEMI_I = 14;        // hemisphere intensity (gameplay)
const DS_HEMI_TITLE = 15;    // hemisphere intensity on the title rig
const DS_FOG = 16;           // vec3 fog colour = clear colour
const DS_EXPOSURE = 19;      // ACES exposure
const DS_BLOOM_S = 20;       // bloom strength (= bloomBase)
const DS_BLOOM_R = 21;       // bloom radius (the threshold is fixed, docs/DISTRICTS.md §1)
const DS_SH_TINT = 22;       // vec3 grade shadow tint
const DS_SH_MIX = 25, DS_SH_LUMA = 26;
const DS_HI_TINT = 27;       // vec3 grade highlight tint
const DS_HI_MIX = 30, DS_HI_LUMA = 31;
const DS_SAT = 32, DS_VIG = 33, DS_VIG_A = 34, DS_VIG_B = 35;
const DS_ROAD = 36;          // vec3 asphalt colour → the gate panel's uRoadBg
const DS_EYES = 39;          // zombie eye / acid-sac emissive → models.setEyeGlow
const DS_N = 40;

function finiteOr(v, f) { return Number.isFinite(v) ? v : f; }
/** Uniform scalar write only when the value changes: a uniform's `value` slot holds numbers, colours and textures, so a
 *  double stored there is boxed; equal values (the constants of a fade) are skipped. */
function setScalar(u, v) { if (u.value !== v) u.value = v; }
function packColor(out, o, hex, c) { c.setHex(hex); out[o] = c.r; out[o + 1] = c.g; out[o + 2] = c.b; }

/** District → packed render state (init / non-table districts only; `c` is a scratch Color). */
function packDistrict(d, out, c) {
  const S = d.sun, H = d.hemi, G = d.grade, V = G.vignette, o = S.offset;
  packColor(out, DS_SUN_COL, S.color, c);
  out[DS_SUN_I] = S.intensity;
  out[DS_SUN_OFF] = o[0]; out[DS_SUN_OFF + 1] = o[1]; out[DS_SUN_OFF + 2] = o[2];
  out[DS_SUN_TAZ] = finiteOr(S.titleAzimuthDeg, 0);
  packColor(out, DS_HEMI_SKY, H.sky, c);
  packColor(out, DS_HEMI_GND, H.ground, c);
  out[DS_HEMI_I] = H.intensity;
  out[DS_HEMI_TITLE] = finiteOr(H.title, H.intensity);
  packColor(out, DS_FOG, d.fog.color, c);
  out[DS_EXPOSURE] = d.exposure;
  out[DS_BLOOM_S] = d.bloom.strength;
  out[DS_BLOOM_R] = d.bloom.radius;
  packColor(out, DS_SH_TINT, G.shadowTint, c);
  out[DS_SH_MIX] = G.shadowMix; out[DS_SH_LUMA] = G.shadowLuma;
  packColor(out, DS_HI_TINT, G.highlightTint, c);
  out[DS_HI_MIX] = G.highlightMix; out[DS_HI_LUMA] = G.highlightLuma;
  out[DS_SAT] = G.saturation; out[DS_VIG] = V.strength; out[DS_VIG_A] = V.a; out[DS_VIG_B] = V.b;
  packColor(out, DS_ROAD, d.road.asphalt, c);
  out[DS_EYES] = d.zombie.eyesEmissive;
  return out;
}

/** World-z component of the shadow camera's light-space y axis for a light at offset (ox, oy, oz) looking at the origin
 *  (up = +Y; the _setSunAzimuth basis): yz = (û × x̂)·ẑ. The ortho box's bottom bound reaches yz × bottom metres up the
 *  road, so render scales RENDER.sun.frustum.b by max(1, yz / yz₁) (docs/DISTRICTS.md §6.1). Same arithmetic as
 *  _setSunAzimuth, so District 1 (RENDER.sun.offset) gives exactly yz₁. */
function lightYz(ox, oy, oz) {
  const ol = Math.hypot(ox, oy, oz) || 1;
  const zx = ox / ol, zy = oy / ol, zz = oz / ol;
  let xx = zz, xz = -zx;
  const xl = Math.hypot(xx, 0, xz) || 1;
  xx /= xl; xz /= xl;
  return -zy * xx;                                          // zx·xy − zy·xx with xy = 0
}

// ---------------------------------------------------------------------------------------------
// Module-level scratch (never retained, never allocated per frame)
// ---------------------------------------------------------------------------------------------
const _v3 = new Vector3();
const _v2 = new Vector2();
const _look = new Vector3();
const _shake = { x: 0, y: 0, roll: 0 };

/** sRGB hex → CSS string for canvas drawing (init-time only). */
function hexCss(hex) { return '#' + (hex >>> 0).toString(16).padStart(6, '0'); }

/** Vertical FOV (deg) that keeps the preset's horizontal FOV at this aspect, clamped (ARCH §2.1 / D20). */
function verticalFov(hFovDeg, aspect, range) {
  const a = aspect > 0 ? aspect : 1;
  const v = 2 * Math.atan(Math.tan(hFovDeg * DEG * 0.5) / a) / DEG;
  return clamp(v, range[0], range[1]);
}

/** VIS-3 framing feasibility at pull-back e (camera moved e metres along the unit view-line (uy, uz)): the minimum
 *  pitch that keeps the ground at z = zBack within dB below the axis, minus the maximum pitch that keeps the ground at
 *  z = zFar within dT above it (radians, vertical plane; > 0 = infeasible). */
function framingGap(e, py, pz, uy, uz, zBack, zFar, dB, dT) {
  const cy = py + uy * e, cz = pz + uz * e;
  return (Math.atan2(cy, cz - zBack) - dB) - (Math.atan2(cy, cz - zFar) + dT);
}

/** The theatre clock (ms): ctx.time.theatre (round-2 QA CORE-7 — real time that does NOT advance while paused), falling
 *  back to ctx.time.now while it is undefined (VIS-18: the boss dolly / game-over camera must resume where they left off). */
function theatreNow(time) {
  if (!time) return 0;
  return Number.isFinite(time.theatre) ? time.theatre : time.now;
}

/** Moves `cur` toward `target` by at most `step` (linear tween helper; no allocation). */
function approach(cur, target, step) {
  if (cur < target) return Math.min(target, cur + step);
  if (cur > target) return Math.max(target, cur - step);
  return cur;
}

/** settings.reducedMotion: true/false wins; null/undefined follows prefers-reduced-motion (guarded). */
function resolveReducedMotion(value) {
  if (value === true || value === false) return value;
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      return !!(mq && mq.matches);
    }
  } catch (_) { /* sandboxed frames may deny matchMedia */ }
  return false;
}

/** Guarded navigator.deviceMemory (GB) or null. */
function deviceMemoryGB() {
  try {
    if (typeof navigator !== 'undefined' && navigator && typeof navigator.deviceMemory === 'number') return navigator.deviceMemory;
  } catch (_) { /* ignore */ }
  return null;
}

/** Guarded window.devicePixelRatio (≥ 1 fallback). */
function devicePixelRatio() {
  try {
    if (typeof window !== 'undefined' && window && window.devicePixelRatio > 0) return window.devicePixelRatio;
  } catch (_) { /* ignore */ }
  return 1;
}

/** UNMASKED_RENDERER_WEBGL (guarded), else a non-generic RENDERER string, else null (ARCH §4.1 (c)). */
function readGpuString(gl) {
  let s = null;
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) s = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch (_) { s = null; }
  if (typeof s !== 'string' || s.length === 0) {
    s = null;
    try {
      const r = gl.getParameter(gl.RENDERER);
      if (typeof r === 'string' && r.length > 0 && !GENERIC_GPU.test(r.trim())) s = r;
    } catch (_) { s = null; }
  }
  return s;
}

/**
 * WebGL 2 probe on a throwaway canvas: the GPU string decides the tier, and the tier decides the
 * real canvas's `antialias` context flag, which can only be chosen once (ARCH §9.4). The probe
 * context is released immediately. Returns { ok, gpu, caveat } (ok false: probe impossible or WebGL 2 absent).
 * Round 7 (perf-render:2): the first attempt sets failIfMajorPerformanceCaveat; when only the second one (on a fresh
 * canvas, without it) gets a context, `caveat` is true — the browser itself judges this WebGL slow (software).
 */
function probeWebGL2() {
  let gl = null;
  let caveat = false;
  for (let pass = 0; pass < 2 && !gl; pass++) {
    let canvas = null;
    try { canvas = document.createElement('canvas'); } catch (_) { return { ok: false, gpu: null, caveat: false }; }
    try { gl = canvas.getContext('webgl2', pass === 0 ? PROBE_CAVEAT_ATTRS : PROBE_ATTRS); } catch (_) { gl = null; }
    if (gl && pass === 1) caveat = true;
  }
  if (!gl) return { ok: false, gpu: null, caveat: false };
  const gpu = readGpuString(gl);
  try {
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  } catch (_) { /* ignore */ }
  return { ok: true, gpu, caveat };
}

/** Persistent {start, count} update range re-pushed into attr.updateRanges (three clears it after upload). */
function markRange(attr, range, start, count) {
  range.start = start;
  range.count = count;
  const ranges = attr.updateRanges;
  if (ranges.length === 0) ranges.push(range);
  else if (ranges[0] === range && ranges.length === 1) { /* already queued: fields updated in place */ }
  else { ranges.length = 0; ranges.push(range); }
  attr.needsUpdate = true;
}

// ---------------------------------------------------------------------------------------------
// Post-processing passes
// ---------------------------------------------------------------------------------------------

/** Builds the grade fragment from the REAL r170 OutputShader source: uniforms are declared after
 *  `uniform sampler2D tDiffuse;` and the grade runs after the tone-mapping chain, before `// color space`
 *  (ARCH §9.4), so the tonemapping → colorspace order is kept. Fails loudly if the upstream source changed. */
function buildGradeFrag() {
  const src = OutputShader.fragmentShader;
  const decl = 'uniform sampler2D tDiffuse;';
  const i0 = src.indexOf(decl);
  const i1 = src.indexOf('// color space');
  if (i0 < 0 || i1 < 0 || i1 < i0) throw new Error('render: OutputShader source changed; GRADE_FRAG cannot be built');
  const uniforms = /* glsl */`
    uniform vec3 uShadowTint; uniform float uShadowMix; uniform float uShadowLuma;
    uniform vec3 uHighTint; uniform float uHighMix; uniform float uHighLuma;
    uniform float uSat; uniform float uVignette; uniform float uVigA; uniform float uVigB; uniform float uDesat; uniform float uAspect;
  `;
  const body = /* glsl */`
      // colour grade (GDD §15): teal shadows, warm highlights, saturation, game-over desaturation, vignette
      {
        vec3 rgb = gl_FragColor.rgb;
        float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        rgb = mix(rgb, rgb * uShadowTint * 2.0, uShadowMix * (1.0 - smoothstep(0.0, uShadowLuma, luma)));
        rgb = mix(rgb, rgb * uHighTint, uHighMix * smoothstep(uHighLuma, 1.0, luma));
        rgb = mix(vec3(luma), rgb, uSat);
        rgb = mix(rgb, vec3(luma), uDesat);
        rgb *= 1.0 - uVignette * smoothstep(uVigA, uVigB, length((vUv - 0.5) * vec2(uAspect, 1.0)) * 2.0);
        gl_FragColor.rgb = rgb;
      }
  `;
  return src.slice(0, i0 + decl.length) + uniforms + src.slice(i0 + decl.length, i1) + body + '\n\t\t\t' + src.slice(i1);
}

/** OutputPass with the GATE RUSH grade (ARCH §9.4): tone mapping once for every pixel (after bloom),
 *  then the grade, then the sRGB transfer. uDesat is driven by setDesaturate, uAspect by resize. */
export class GradeOutputPass extends OutputPass {
  constructor() {
    super();
    const G = RENDER.grade;
    this.material.fragmentShader = buildGradeFrag();
    Object.assign(this.material.uniforms, {
      uShadowTint: { value: new Color(G.shadowTint) }, uShadowMix: { value: G.shadowMix }, uShadowLuma: { value: G.shadowLuma },
      uHighTint: { value: new Color(G.highlightTint) }, uHighMix: { value: G.highlightMix }, uHighLuma: { value: G.highlightLuma },
      uSat: { value: G.saturation }, uVignette: { value: G.vignette.strength }, uVigA: { value: G.vignette.a }, uVigB: { value: G.vignette.b },
      uDesat: { value: 0 }, uAspect: { value: 1 },
    });
    this.material.needsUpdate = true;
  }

  /** Sets the output defines OutputPass.render would set on its first frame (sRGB transfer + ACES, the only
   *  combination the game uses), so the grade program can be pre-compiled before the composer first draws
   *  (VIS-1 / VIS-2). Any other renderer setup is left to OutputPass.render. */
  prime(renderer) {
    if (!renderer || (this._outputColorSpace === renderer.outputColorSpace && this._toneMapping === renderer.toneMapping)) return;
    if (renderer.toneMapping !== ACESFilmicToneMapping) return;
    this._outputColorSpace = renderer.outputColorSpace;
    this._toneMapping = renderer.toneMapping;
    const d = {};
    if (ColorManagement.getTransfer(this._outputColorSpace) === SRGBTransfer) d.SRGB_TRANSFER = '';
    d.ACES_FILMIC_TONE_MAPPING = '';
    this.material.defines = d;
    this.material.needsUpdate = true;
  }
}

/** UnrealBloomPass whose mip 0 sits at (composer size · scale) / 2: scale 1 = 'half', 0.5 = 'quarter'.
 *  EffectComposer.setSize feeds the full target size to every pass, so the scale is applied here.
 *  `mips` (QUALITY_TIERS[tier].bloomMips, default UnrealBloomPass's 5) blurs only the first `mips` levels (round-2 QA
 *  VIS-13: Medium uses 3 — 4 blur draws, 4 target binds and 4 clears fewer per frame). Every tier keeps the SAME
 *  programs: the 5 blur materials are all built (and pre-compiled; the unused ones are never drawn) and the 5-mip
 *  composite shader is kept, its missing mips bound to the last blurred level with a zero tint (the composite's alpha
 *  is unchanged), so a High ⇄ Medium switch still never links a program (VIS-1). */
class TierBloomPass extends UnrealBloomPass {
  constructor(resolution, strength, radius, threshold, scale, mips) {
    super(resolution, strength, radius, threshold);
    this._scale = scale;
    const n = Number.isFinite(mips) ? Math.max(1, Math.min(this.nMips, Math.floor(mips))) : this.nMips;
    if (n < this.nMips) {
      for (let i = n; i < this.nMips; i++) { this.renderTargetsHorizontal[i].dispose(); this.renderTargetsVertical[i].dispose(); }
      this.renderTargetsHorizontal.length = n;
      this.renderTargetsVertical.length = n;
      const u = this.compositeMaterial.uniforms, last = this.renderTargetsVertical[n - 1].texture;
      for (let i = n; i < this.nMips; i++) {
        u['blurTexture' + (i + 1)].value = last;
        this.bloomTintColors[i].set(0, 0, 0);
      }
      this.nMips = n;
    }
  }
  /** VIS-4: r170 builds each mip's separable blur with sigma = KERNEL_RADIUS, so the weights are still ≈ 0.6–0.8 at
   *  the kernel edge — a near-box kernel that draws soft-edged SQUARES around every tracer / glyph. Here every
   *  kernel is one tap wider (3/5/7/9/11 → 4/6/8/10/12, so the reach stays) and uses a true Gaussian with
   *  sigma = KERNEL_RADIUS / 3 (≈ 1 % weight at the edge): round, soft halos. The blur shader divides by its
   *  weight sum, so the coefficients need no normalisation. Called by the super constructor (method override). */
  getSeperableBlurMaterial(kernelRadius) {
    const k = kernelRadius + BLOOM_KERNEL_GROW;
    const m = super.getSeperableBlurMaterial(k);
    const sigma = k * BLOOM_SIGMA_PER_RADIUS;
    const c = m.uniforms.gaussianCoefficients.value;
    for (let i = 0; i < c.length; i++) c[i] = Math.exp(-0.5 * i * i / (sigma * sigma));
    return m;
  }
  setSize(width, height) {
    super.setSize(Math.max(2, Math.round(width * this._scale)), Math.max(2, Math.round(height * this._scale)));
  }
  /** UnrealBloomPass.dispose minus fsQuad.dispose(): every FullScreenQuad shares three's ONE module-level quad geometry
   *  (Pass.js), so disposing it from a retired bloom pass only forced a re-upload for the grade / copy passes — and after
   *  a context restore its dispose listeners belong to the lost context (VIS-21: deleteVertexArray warnings). */
  dispose() {
    for (let i = 0; i < this.renderTargetsHorizontal.length; i++) this.renderTargetsHorizontal[i].dispose();
    for (let i = 0; i < this.renderTargetsVertical.length; i++) this.renderTargetsVertical[i].dispose();
    this.renderTargetBright.dispose();
    for (let i = 0; i < this.separableBlurMaterials.length; i++) this.separableBlurMaterials[i].dispose();
    this.compositeMaterial.dispose();
    this.blendMaterial.dispose();
    this.basic.dispose();
  }
}

/** RenderPass that records renderer.info.render.calls right after the scene render (overlay split, ARCH §9.1). */
class CountingRenderPass extends RenderPass {
  constructor(scene, camera) {
    super(scene, camera);
    this.callsAfter = 0;
  }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    this.callsAfter = renderer.info.render.calls;
  }
}

/** Round-2 FX-10 residual: draws only OVERLAY_LAYER into the bloomed read buffer (no clear, no swap), between the
 *  bloom pass and the grade pass. The camera sees only that layer for this render; the lights carry the layer too
 *  (_buildLights), so this render leaves the same light setup in three's per-scene render state as the main pass and
 *  every program key (the overlay materials' and the next shadow pass's depth programs) matches the warm-up compile.
 *  The shadow map is not re-rendered here (autoUpdate off for this render: its camera sees no casters, a render would
 *  clear the map); the scene's world matrices were updated by the main pass this frame, so the automatic
 *  scene.updateMatrixWorld() is suppressed. Its draws are scene draws: callStats counts them as 'main' (`calls` =
 *  this frame's overlay draws, read by draw()). */
class OverlayRenderPass extends RenderPass {
  constructor(scene, camera) {
    super(scene, camera);
    this.clear = false;
    this.needsSwap = false;
    this.calls = 0;
  }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const cam = this.camera, scene = this.scene;
    const mask = cam.layers.mask, autoWorld = scene.matrixWorldAutoUpdate;
    const c0 = renderer.info.render.calls;
    const sm = renderer.shadowMap, shadowAuto = sm.autoUpdate;
    cam.layers.set(OVERLAY_LAYER);
    scene.matrixWorldAutoUpdate = false;
    sm.autoUpdate = false;
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      sm.autoUpdate = shadowAuto;
      cam.layers.mask = mask;
      scene.matrixWorldAutoUpdate = autoWorld;
      this.calls = renderer.info.render.calls - c0;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// TextureFactory — every canvas is drawn at boot (§9.6) and re-drawn from the same code (fixed seeds) whenever its
// contents may be gone: webglcontextrestored (rebuild → restoreAll), a 2D 'contextrestored' on the canvas, and a
// resume (visibilitychange → visible, pageshow, the lifecycle 'resume') whose probe pixels read blank (round 6).
// ---------------------------------------------------------------------------------------------
// Round 6 (owner's phone, "the numbers were gone from the boards" after 2 h asleep): Chrome GPU-backs these 2D canvases
// by default, and when Android reclaims the GPU process every one of them loses its pixels ('contextlost' →
// 'contextrestored' with a blank bitmap) while the WebGL context is lost and restored — whose rebuild re-uploaded the
// blank canvases (digits, road paint, windows, icons all gone; reproduced with CDP Browser.crashGpuProcess). A
// CPU-backed canvas (willReadFrequently) that only ever receives pixels (paths, text, putImageData — never a drawImage of
// a GPU canvas, see _paintRec) has no GPU state to lose, so this is the first line of defence; it also makes the resume
// probe (getImageData of single pixels) a plain memory read (≈ 0.04 ms for all canvases). The re-draw paths above cover
// a browser that ignores the hint.
const CANVAS_CPU = Object.freeze({ willReadFrequently: true });
function makeCanvas(w, h) {
  if (typeof document === 'undefined') throw new Error('render: TextureFactory needs a DOM');
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function ctx2d(c) {
  const g = c.getContext('2d', CANVAS_CPU);
  if (!g) throw new Error('render: canvas 2d context unavailable');
  return g;
}
/** The 2D context of `c` back to its default state with a transparent bitmap (a re-draw must start exactly like the
 *  boot draw did on a fresh context: same transform, compositing, line and text state). */
function resetCtx(g, c) {
  if (typeof g.reset === 'function') { g.reset(); return; }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.lineWidth = 1; g.lineCap = 'butt'; g.lineJoin = 'miter';
  g.textAlign = 'start'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#000000'; g.strokeStyle = '#000000';
  g.clearRect(0, 0, c.width, c.height);
}
/** Alpha (0..255) of one pixel of `c`; -1 when it cannot be read (no context, a lost context, a throwing readback). */
function probeAlpha(c, x, y) {
  try {
    const g = c.getContext('2d', CANVAS_CPU);
    if (!g || (typeof g.isContextLost === 'function' && g.isContextLost())) return -1;
    return g.getImageData(x, y, 1, 1).data[3];
  } catch (_) { return -1; }
}
function rgbaCss(hex, a) { return 'rgba(' + ((hex >> 16) & 255) + ',' + ((hex >> 8) & 255) + ',' + (hex & 255) + ',' + a + ')'; }
function roundRectPath(g, x, y, w, h, r) {
  r = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
/** Runs fn on the next animation frame (setTimeout fallback where rAF is unavailable). */
function nextFrame(fn) {
  try {
    if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(() => fn()); return; }
  } catch (_) { /* fall through */ }
  setTimeout(fn, 16);
}
function yieldFrame() {
  return new Promise((resolve) => { if (typeof setTimeout === 'function') setTimeout(resolve, 0); else resolve(); });
}
/** Resolves after the browser had the chance to paint (rAF → macrotask; PAINT_YIELD_FALLBACK_MS fallback where rAF is
 *  paused or missing), so the init step after it never shares a frozen frame with the one before (round-3 boot
 *  polish: materials + passes, the environment build and the sizing used to run as one ≈ 0.2 s task at 4× CPU
 *  throttling). Init only (allocates a promise and two closures). */
function yieldPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { setTimeout(finish, 0); });
    } catch (_) { /* the fallback below resolves */ }
    if (typeof setTimeout === 'function') setTimeout(finish, PAINT_YIELD_FALLBACK_MS); else finish();
  });
}
/** Integer hash → [0, 1) for tileable noise lattices (deterministic, no state). */
function hash3(ix, iy, o) {
  let h = Math.imul(ix | 0, 0x27D4EB2D) ^ Math.imul(iy | 0, 0x165667B1) ^ Math.imul((o | 0) + 1, 0x9E3779B1);
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  h = Math.imul(h ^ (h >>> 12), 0x297A2D39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Tileable value noise (f cells per tile, coordinates in tile units [0, 1)) over a precomputed f × f lattice `lat`
 *  (row-major hash3(ix, iy, octave) values). */
function latticeNoise(lat, u, v, f) {
  const x = u * f, y = v * f;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % f) + f) % f, x1 = (x0 + 1) % f, y0 = ((yi % f) + f) % f, y1 = (y0 + 1) % f;
  const a = lat[y0 * f + x0], b = lat[y0 * f + x1], c = lat[y1 * f + x0], d = lat[y1 * f + x1];
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

// Op characters → atlas glyphs ('-' → '−', 'x'/'*' → '×', '/' → '÷'); built from RENDER.atlas.rows[1].
const OP_MAP = Object.freeze({
  '-': RENDER.atlas.rows[1][1], 'x': RENDER.atlas.rows[1][2], '*': RENDER.atlas.rows[1][2], '/': RENDER.atlas.rows[1][3],
});
// The last two row-1 glyphs (★ ⚡) are not in Lilita One. Round-3 verify: they are drawn as shapes (_paintSymbol) — the
// system-font fallback lookup for ★ alone took 70–250 ms at 4× CPU (first measureText through system-ui), the variable
// part of the atlas step's intermittent 285–510 ms boot stall; any other symbol cell still falls back to the system font.
const SYMBOL_FROM_COL = RENDER.atlas.rows[1].length - 2;
const DIV_GLYPH = RENDER.atlas.rows[1][3];   // '÷' — drawn by _paintDivide (VIS-5), never from the font
const STAR_GLYPH = '\u2605', BOLT_GLYPH = '\u26A1';   // drawn by _paintSymbol, never from a font
const STAR_INNER = 0.45;         // shape constant: inner / outer radius of the 5-point star
const STAR_FILL = 0.82;          // shape constant: star size / the largest star that fits the padded cell (≈ the old font star; advance 0.7 em)
// shape constant: the bolt outline in a unit box (x right, y down), scaled to BOLT_ASPECT × the padded cell height
const BOLT_PTS = Object.freeze([0.60, 0.00, 0.08, 0.58, 0.44, 0.58, 0.30, 1.00, 0.92, 0.36, 0.55, 0.36, 0.74, 0.00]);
const BOLT_ASPECT = 0.62;        // shape constant: bolt width / height
const BOLT_FILL_H = 0.8;         // shape constant: bolt height / padded cell height (≈ the old font bolt; advance 0.6 em)
const TEXT_PRESENTATION = '︎';   // variation selector 15: monochrome (text) glyph instead of a colour emoji
// Icon atlas layout: RENDER.icons.order cells of (textures.icons width / count) px, square, along the top
// row of the canvas (512 / 16 = 32 px; the 64 px canvas height leaves the second row transparent so mip
// levels never bleed vertically). Icons are drawn in a 32-unit design space centred on the cell.
const ICON_COUNT = RENDER.icons.order.length;
const ICON_CELL = Math.floor(RENDER.textures.icons[0] / ICON_COUNT);
const ICON_DESIGN = 32;          // shape constant: design-space size the pictograms below are drawn in
const ICON_INSET = 0.5;          // shape constant: half-texel UV inset against neighbour bleed
const GRAIN_TILE = 64;           // shape constant: side (px) of the tiled grain noise pattern on the road / facade canvases
const FACADE_GRAIN = 0.07;       // shape constant: ± facade grain amplitude
const ICON_STROKE = 4;           // shape constant: icon outline width in design units (stroked under the fill: 2 show, ≈ 1.1 px at 18 css px)
const ICON_SEAM = 1.5;           // shape constant: width of the dark seam lines drawn over a fill (design units)
const ICON_GUN_TILT = -0.6;      // shape constant: gun icons are side views rotated muzzle-up by this angle (rad)
const ICON_FIT = 0.86;           // shape constant: geometry is designed to ±15.5 units; × this plus the outline stays inside the ±16 cell
// shape constants: radial-disc gradient stops (offset, alpha pairs) of the glow / particle / dust canvases
const GLOW_STOPS = Object.freeze([0, 1, 0.22, 0.85, 0.55, 0.3, 1, 0]);
const PARTICLE_STOPS = Object.freeze([0, 1, 0.35, 0.75, 1, 0]);
const DUST_STOPS = Object.freeze([0, 1, 0.45, 0.4, 1, 0]);

export class TextureFactory {
  constructor(ctx) {
    this.ctx = ctx;
    this.road = null; this.digitAtlas = null; this.glow = null; this.smoke = null; this.windows = null;
    this.facade = null;   // extra: building colour map drawn with the same window layout as `windows`
    this.particle = null; this.muzzle = null; this.dust = null; this.icons = null;
    this._all = [];
    this._atlasCanvas = null;
    this._iconsCanvas = null;
    this._iconCache = new Map();
    this._atlasWithFont = false;
    // round 6: one record per paint recipe { name, canvases, texes, paint, px, py, expect, lostMask } (see _record)
    this._recs = [];
    this._roadRec = null; this._atlasRec = null;
    this._divProbeX = 0; this._divProbeY = 0;   // centre of the ÷ bar (always inked), set by _paintDivide
    this._fontWaiting = false;
    this.onRepaint = null;                       // RenderSystem: () => render.dirty = true (a re-draw needs a frame while paused)
    // debug / harness: re-draws since boot and the last one's cause and cost
    this.repaints = 0; this.lastRepaint = ''; this.lastRepaintMs = 0;
    this._listening = false;
    this._onResume = () => { this._resumeCheck(); };
    this._fontSet = null;                        // document.fonts while its 'loadingdone' listener is installed
    this._onFontsDone = () => {
      // the display font arrived after build()'s wait (slow network): the atlas leaves the fallback face once
      if (!this._atlasWithFont && this._atlasRec && this._atlasRec.lostMask === 0 && this._recs.length && this._fontLoaded()) this._repaint(this._atlasRec, 'font');
    };
  }

  /** Draws every canvas (progress 0..1), waits for the display font ≤ RENDER.textures.fontWaitMs and
   *  redraws the atlas once if the font arrives after the first paint (ARCH §6.3 note on fonts). The
   *  font request starts before any drawing so it downloads in parallel. Round 6: every canvas is kept with its paint
   *  recipe (fixed seeds, so a re-draw is pixel-identical), its probe pixel and its 2D context-loss listeners, and the
   *  resume listeners are installed (see restoreAll / verify). */
  async build(progressCb) {
    const report = (t) => { if (typeof progressCb === 'function') { try { progressCb(t); } catch (_) { /* ignore */ } } };
    const fontWait = this._waitFont();
    const T = RENDER.textures;
    const steps = [
      () => {
        this._roadRec = this._record('road', [makeCanvas(T.road[0], T.road[1])], (c) => this._paintRoad(c[0]),
          [{ repeat: true, mips: true, aniso: 1 }], 1, 1);
        this.road = this._roadRec.texes[0];
      },
      () => {
        this._atlasCanvas = makeCanvas(T.digitAtlas[0], T.digitAtlas[1]);
        // probe: the centre of the ÷ bar (a shape, inked whatever the font)
        this._atlasRec = this._record('digitAtlas', [this._atlasCanvas], (c) => this._paintAtlas(c[0]),
          [{ mips: true, premult: true, aniso: RENDER.atlas.anisotropy }], -1, -1);
        this._setProbe(this._atlasRec, this._divProbeX, this._divProbeY);
        this.digitAtlas = this._atlasRec.texes[0];
      },
      () => {
        this.glow = this._discRecord('glow', T.glow[0], GLOW_STOPS);
        this.particle = this._discRecord('particle', T.particle[0], PARTICLE_STOPS);
        this.dust = this._discRecord('dust', T.dust[0], DUST_STOPS);
      },
      () => {
        this.smoke = this._record('smoke', [makeCanvas(T.smoke[0], T.smoke[1])], (c) => this._paintSmoke(c[0]),
          [{ repeat: true, mips: true, linear: true }], T.smoke[0] >> 1, T.smoke[1] >> 1, true).texes[0];   // direct: CPU-made pixels
      },
      () => {
        const W = T.windows[0], H = T.windows[1];
        const r = this._record('windows', [makeCanvas(W, H), makeCanvas(W, H)], (c) => this._paintWindows(c[0], c[1]),
          [{ repeat: true, mips: true }, { repeat: true, mips: true }], 1, 1);
        this.windows = r.texes[0];
        this.facade = r.texes[1];
      },
      () => {
        this.muzzle = this._record('muzzle', [makeCanvas(T.muzzle[0], T.muzzle[1])], (c) => this._paintMuzzle(c[0]),
          [{ premult: true }], T.muzzle[1] >> 1, T.muzzle[1] >> 1).texes[0];
      },
      () => {
        this._iconsCanvas = makeCanvas(T.icons[0], T.icons[1]);
        const r = this._record('icons', [this._iconsCanvas], (c) => this._paintIcons(c[0]), [{ mips: true, premult: true }], -1, -1);
        this._findInk(r, ICON_CELL, ICON_CELL);   // probe: the first inked pixel of the first icon cell
        this.icons = r.texes[0];
      },
    ];
    let slice = performance.now();
    for (let i = 0; i < steps.length; i++) {
      steps[i]();
      report((i + 1) / (steps.length + 1));
      // round-3 boot polish: a real paint (not just a macrotask) once the steps since the last paint ran longer than
      // one frame — the road and the atlas (≈ 150 ms at 4× CPU throttling) used to share one frozen ≈ 0.25 s frame
      if (performance.now() - slice >= PAINT_SLICE_MS) { await yieldPaint(); slice = performance.now(); } else await yieldFrame();
    }
    const fontArrived = await fontWait;
    if ((fontArrived || this._fontLoaded()) && !this._atlasWithFont) this._repaint(this._atlasRec, 'font');
    this._installListeners();
    report(1);
  }

  /** Cell UVs (inset RENDER.atlas.insetPx) and em advance for one glyph; unknown glyph → empty rect, advance 0. */
  glyphUV(ch, out) {
    const A = RENDER.atlas;
    const c = OP_MAP[ch] !== undefined ? OP_MAP[ch] : ch;
    let row = 0, col = A.rows[0].indexOf(c);
    if (col < 0) { row = 1; col = A.rows[1].indexOf(c); }
    if (col < 0) { out.u0 = 0; out.v0 = 0; out.u1 = 0; out.v1 = 0; out.advance = 0; return; }
    const W = RENDER.textures.digitAtlas[0], H = RENDER.textures.digitAtlas[1];
    const cw = A.cell[0], chh = A.cell[1], inset = A.insetPx;
    out.u0 = (col * cw + inset) / W;
    out.u1 = ((col + 1) * cw - inset) / W;
    out.v1 = 1 - (row * chh + inset) / H;           // canvas row 0 is the top (flipY)
    out.v0 = 1 - ((row + 1) * chh - inset) / H;
    out.advance = row === 0 ? A.advance.digit : (A.advance[c] !== undefined ? A.advance[c] : A.advance.digit);
  }

  /** UVs of an item icon cell (square); `id` is an item id ('weapon.shotgun') or an icon key ('shotgun').
   *  Unknown id → empty rect. */
  iconUV(id, out) {
    const col = this._iconCol(id);
    if (col < 0) { out.u0 = 0; out.v0 = 0; out.u1 = 0; out.v1 = 0; return; }
    const W = RENDER.textures.icons[0], H = RENDER.textures.icons[1];
    out.u0 = (col * ICON_CELL + ICON_INSET) / W;
    out.u1 = ((col + 1) * ICON_CELL - ICON_INSET) / W;
    out.v1 = 1 - ICON_INSET / H;                      // top row of the canvas (flipY)
    out.v0 = 1 - (ICON_CELL - ICON_INSET) / H;
  }

  /** PNG data URL of one icon at px × px for DOM pills (cached per id + size); '' when unavailable. The
   *  pictogram is re-drawn from its vector recipe at the requested size, so pills stay crisp at any DPR. */
  iconDataURL(id, px) {
    const col = this._iconCol(id);
    if (col < 0) return '';
    const size = Math.max(1, Math.round(px > 0 ? px : ICON_CELL));
    const key = col + '|' + size;
    const hit = this._iconCache.get(key);
    if (hit !== undefined) return hit;
    let url = '';
    try {
      const c = makeCanvas(size, size), g = ctx2d(c);
      this._paintIcon(g, RENDER.icons.order[col], size / 2, size / 2, size / ICON_DESIGN);
      url = c.toDataURL('image/png');
    } catch (_) { url = ''; }
    this._iconCache.set(key, url);
    return url;
  }

  /** Road anisotropy by tier (§9.6); re-uploads the road canvas once when it changes (round 6: re-drawn first when its
   *  probe pixel reads blank, so a tier change can never upload a lost canvas). */
  setRoadAnisotropy(n) {
    if (this.road && this.road.anisotropy !== n) {
      this.road.anisotropy = n;
      if (this._roadRec && this._isBlank(this._roadRec)) this._repaint(this._roadRec, 'aniso');
      this.road.needsUpdate = true;
    }
  }

  /** Flags every canvas texture for re-upload as it is (no re-draw). Kept for callers that know the canvases are
   *  intact; a context restore uses restoreAll(). */
  markAllNeedsUpdate() { for (let i = 0; i < this._all.length; i++) this._all[i].needsUpdate = true; }

  /** Round 6, after webglcontextrestored (RenderSystem.rebuild, §9.5): re-draws EVERY procedural canvas from its recipe
   *  and flags its texture(s) for re-upload — a GPU-process loss takes GPU-backed 2D canvases with it, so "the
   *  canvases persist" is not something a restore may assume. The display font is re-checked first (the atlas uses
   *  Lilita One when loaded, else the system fallback and a re-draw once the font arrives). One longer frame, behind
   *  the 'Reloading graphics…' overlay; a canvas whose 2D context is still lost is re-drawn by its own 'contextrestored'. */
  restoreAll() { this._repaintAll('webgl'); }

  /** Round 6: cheap integrity check — one 1 × 1 getImageData per canvas at a pixel its recipe always inks (CPU-backed
   *  canvases: a memory read). Any blank canvas → every canvas is re-drawn and re-uploaded (a loss never takes just
   *  one). Also re-draws the atlas once the display font is available when it was drawn with the fallback. Returns
   *  true when something was re-drawn. Called on resume (visibilitychange → visible, pageshow, 'resume'). */
  verify() {
    for (let i = 0; i < this._recs.length; i++) {
      if (this._isBlank(this._recs[i])) { this._repaintAll('blank:' + this._recs[i].name); return true; }
    }
    if (!this._atlasWithFont && this._atlasRec && this._atlasRec.lostMask === 0) {
      if (this._fontLoaded()) { this._repaint(this._atlasRec, 'font'); return true; }
      this._ensureFont();
    }
    return false;
  }

  dispose() {
    this._removeListeners();
    for (let i = 0; i < this._all.length; i++) this._all[i].dispose();
    this._all.length = 0; this._recs.length = 0; this._iconCache.clear();
    this.onRepaint = null;
  }

  // ---- internals -----------------------------------------------------------------------------
  /** Creates the canvas textures of one paint recipe, paints it (_paintRec), records its probe pixel (px, py; < 0 =
   *  set later) and listens for its 2D context loss. `paint(canvases)` draws the given canvases completely from code,
   *  identically on every call (fixed seeds); `direct` paints straight into the kept canvases (smoke: putImageData of
   *  CPU-made pixels gains nothing from a GPU scratch). */
  _record(name, canvases, paint, texOpts, px, py, direct) {
    const rec = { name, canvases, texes: [], paint, direct: !!direct, px: 0, py: 0, expect: new Int16Array(canvases.length), lostMask: 0 };
    this._paintRec(rec);
    for (let i = 0; i < canvases.length; i++) rec.texes.push(this._tex(canvases[i], texOpts[i]));
    if (px >= 0) this._setProbe(rec, px, py);
    for (let i = 0; i < canvases.length; i++) this._listen2d(rec, i);
    this._recs.push(rec);
    return rec;
  }

  /** Round 6: paints `rec` fast and keeps it safe. The recipe runs on fresh scratch canvases with the browser's default
   *  (GPU-rasterised) 2D context, then each result is copied as PIXELS (getImageData → putImageData: one read-back)
   *  into the kept CPU-backed canvas and the scratch is released. Not drawImage: Chrome turns a willReadFrequently
   *  canvas that receives a GPU canvas through drawImage into a GPU-backed one (it was lost with the GPU process in the
   *  crash test, and every 1-px read became a 0.4 ms GPU round trip); a putImageData'd canvas survives. The un- /
   *  re-premultiply round trip is exact (|error| < 0.5 before rounding). Boot cost at 4× CPU throttling: GPU-only
   *  111 ms for all canvases, this way ≈ the same, rasterised on the CPU 206 ms. A scratch that is lost (the GPU is gone
   *  right now) or missing, or a read-back that throws, falls back to painting straight into the kept canvases. Boot
   *  and re-draws only (allocates). */
  _paintRec(rec) {
    const cs = rec.canvases;
    let scratch = null;
    if (!rec.direct) {
      try {
        scratch = [];
        for (let i = 0; i < cs.length; i++) {
          const sc = makeCanvas(cs[i].width, cs[i].height);
          const sg = sc.getContext('2d');                      // default context: GPU-rasterised where the browser can
          if (!sg) { scratch = null; break; }
          scratch.push(sc);
        }
      } catch (_) { scratch = null; }
    }
    if (scratch) {
      rec.paint(scratch);
      let ok = true;
      for (let i = 0; i < cs.length; i++) {
        const sg = scratch[i].getContext('2d');
        if (typeof sg.isContextLost === 'function' && sg.isContextLost()) { ok = false; break; }
      }
      if (ok) {
        try {
          for (let i = 0; i < cs.length; i++) {
            const img = scratch[i].getContext('2d').getImageData(0, 0, cs[i].width, cs[i].height);
            const g = ctx2d(cs[i]);
            resetCtx(g, cs[i]);
            g.putImageData(img, 0, 0);
          }
        } catch (_) { ok = false; }
      }
      for (let i = 0; i < scratch.length; i++) scratch[i].width = 0;   // free the scratch backing store now
      if (ok) return;
    }
    rec.paint(cs);
  }

  /** A radial-disc canvas record (glow / particle / dust); returns its texture. */
  _discRecord(name, size, stops) {
    return this._record(name, [makeCanvas(size, size)], (c) => this._paintDisc(c[0], stops), [{ premult: true }], size >> 1, size >> 1).texes[0];
  }

  /** Sets the probe pixel of `rec` and the alpha each canvas has there now (a read ≤ 0 keeps the previous
   *  expectation: a paint onto a still-lost context must not disable the probe). */
  _setProbe(rec, x, y) {
    rec.px = Math.max(0, Math.floor(x)); rec.py = Math.max(0, Math.floor(y));
    for (let i = 0; i < rec.canvases.length; i++) {
      const a = probeAlpha(rec.canvases[i], rec.px, rec.py);
      if (a > 0) rec.expect[i] = a;
    }
  }

  /** Probe = the first clearly inked pixel of the top-left w × h rect of rec's first canvas (boot only, one readback). */
  _findInk(rec, w, h) {
    try {
      const d = ctx2d(rec.canvases[0]).getImageData(0, 0, w, h).data;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] >= 200) { const p = (i - 3) >> 2; this._setProbe(rec, p % w, (p / w) | 0); return; }
      }
    } catch (_) { /* no probe: verify() cannot see this canvas blank; the 2D events and restoreAll still cover it */ }
  }

  /** True when a canvas of `rec` that is not inside a 2D context loss reads blank (alpha 0) at its probe pixel. */
  _isBlank(rec) {
    for (let i = 0; i < rec.canvases.length; i++) {
      if (rec.expect[i] > 0 && (rec.lostMask & (1 << i)) === 0 && probeAlpha(rec.canvases[i], rec.px, rec.py) === 0) return true;
    }
    return false;
  }

  /** Re-draws one recipe from code and flags its texture(s) for re-upload. */
  _repaint(rec, why) {
    if (!rec) return;
    const t0 = performance.now();
    try { this._paintRec(rec); } catch (err) { warnOnce('render.repaint.' + rec.name, 'texture re-draw failed (' + rec.name + '): ' + ((err && err.message) ? err.message : String(err))); }
    if (rec === this._atlasRec) this._setProbe(rec, this._divProbeX, this._divProbeY);   // the ÷ bar follows the font's metrics
    for (let i = 0; i < rec.texes.length; i++) rec.texes[i].needsUpdate = true;
    this.repaints++; this.lastRepaint = rec.name + ':' + why; this.lastRepaintMs = performance.now() - t0;
    if (typeof this.onRepaint === 'function') { try { this.onRepaint(); } catch (_) { /* ignore */ } }
  }

  /** Re-draws every recipe (font re-checked first). */
  _repaintAll(why) {
    this._ensureFont();
    const t0 = performance.now();
    for (let i = 0; i < this._recs.length; i++) this._repaint(this._recs[i], why);
    this.lastRepaint = 'all:' + why; this.lastRepaintMs = performance.now() - t0;
  }

  /** When the display font is not loaded: (re)request it, one request at a time; when it arrives, the atlas is re-drawn. */
  _ensureFont() {
    if (this._fontLoaded() || this._fontWaiting) return;
    this._fontWaiting = true;
    this._waitFont().then((ok) => {
      this._fontWaiting = false;
      if ((ok || this._fontLoaded()) && !this._atlasWithFont && this._atlasRec && this._atlasRec.lostMask === 0 && this._recs.length) {
        this._repaint(this._atlasRec, 'font');
      }
    }, () => { this._fontWaiting = false; });
  }

  /** 2D canvas context loss (Chrome fires these on GPU-backed canvases): 'contextlost' marks the canvas (NOT
   *  preventDefault — on a 2D context that forbids the restore), 'contextrestored' (a blank bitmap) re-draws the
   *  recipe once none of its canvases is lost any more. Init only (two closures per canvas). */
  _listen2d(rec, i) {
    const c = rec.canvases[i], bit = 1 << i;
    try {
      c.addEventListener('contextlost', () => { rec.lostMask |= bit; });
      c.addEventListener('contextrestored', () => {
        rec.lostMask &= ~bit;
        if (rec.lostMask === 0 && this._recs.length) this._repaint(rec, '2d');
      });
    } catch (_) { /* no events: restoreAll / verify still cover this canvas */ }
  }

  /** Resume listeners: visibilitychange (→ visible), pageshow (incl. a bfcache restore), the Page Lifecycle 'resume'
   *  after a freeze; plus document.fonts 'loadingdone' (a display font later than build()'s wait re-draws the atlas). */
  _installListeners() {
    if (this._listening) return;
    try {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this._onResume);
        document.addEventListener('resume', this._onResume);
      }
      if (typeof window !== 'undefined') window.addEventListener('pageshow', this._onResume);
      this._listening = true;
      const fset = typeof document !== 'undefined' ? document.fonts : null;
      if (fset && typeof fset.addEventListener === 'function') { fset.addEventListener('loadingdone', this._onFontsDone); this._fontSet = fset; }
    } catch (_) { /* no resume check; restoreAll and the 2D events remain */ }
  }

  _removeListeners() {
    if (!this._listening) return;
    this._listening = false;
    try {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this._onResume);
        document.removeEventListener('resume', this._onResume);
      }
      if (typeof window !== 'undefined') window.removeEventListener('pageshow', this._onResume);
      if (this._fontSet) { this._fontSet.removeEventListener('loadingdone', this._onFontsDone); this._fontSet = null; }
    } catch (_) { /* ignore */ }
  }

  _resumeCheck() {
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    } catch (_) { /* treat as visible */ }
    if (this._recs.length) this.verify();
  }

  _iconCol(id) {
    const key = RENDER.icons.ofItem[id] !== undefined ? RENDER.icons.ofItem[id] : id;
    return RENDER.icons.order.indexOf(key);
  }

  _tex(canvas, o) {
    const t = new CanvasTexture(canvas);
    t.wrapS = t.wrapT = o.repeat ? RepeatWrapping : ClampToEdgeWrapping;
    t.colorSpace = o.linear ? NoColorSpace : SRGBColorSpace;
    t.generateMipmaps = !!o.mips;
    t.minFilter = o.mips ? LinearMipmapLinearFilter : LinearFilter;
    t.magFilter = LinearFilter;
    t.premultiplyAlpha = !!o.premult;
    t.anisotropy = o.aniso || 1;
    t.needsUpdate = true;
    this._all.push(t);
    return t;
  }

  /** True when a FontFace of the display family has actually loaded (document.fonts.check would also
   *  answer true when no such face is declared at all, e.g. the stylesheet failed offline). */
  _fontLoaded() {
    try {
      if (typeof document === 'undefined' || !document.fonts || typeof document.fonts.forEach !== 'function') return false;
      const family = RENDER.textures.font;
      let ok = false;
      document.fonts.forEach((f) => {
        if (f && f.status === 'loaded' && String(f.family).replace(/["']/g, '').trim() === family) ok = true;
      });
      return ok;
    } catch (_) { return false; }
  }

  /** Resolves true when the display font loads within RENDER.textures.fontWaitMs, false otherwise. */
  _waitFont() {
    try {
      if (typeof document === 'undefined' || !document.fonts || typeof document.fonts.load !== 'function') return Promise.resolve(false);
      const spec = RENDER.atlas.glyphPx + 'px "' + RENDER.textures.font + '"';
      const loaded = document.fonts.load(spec).then((faces) => !!faces && faces.length > 0, () => false);
      const timeout = new Promise((resolve) => setTimeout(() => resolve(false), RENDER.textures.fontWaitMs));
      return Promise.race([loaded, timeout]).then((ok) => ok === true, () => false);
    } catch (_) { return Promise.resolve(false); }
  }

  /** Draws fn at y, y − H and y + H so shapes wrap across the vertical tile seam; [y0, y1] is the shape's vertical
   *  extent at offset 0, and a copy that lies wholly outside the canvas is skipped (round 6: it would draw nothing —
   *  same pixels — but on a CPU-backed canvas each skipped radial-gradient copy is real rasterisation time). */
  _wrapY(g, H, y0, y1, fn) {
    if (y1 >= 0 && y0 <= H) fn();
    if (y1 - H >= 0) { g.save(); g.translate(0, -H); fn(); g.restore(); }
    if (y0 + H <= H) { g.save(); g.translate(0, H); fn(); g.restore(); }
  }

  /** Lane paint stripe with `worn` fraction eroded by asphalt-coloured stamps. */
  _paintStripe(g, x, y, w, h, hex, worn, asphaltHex, rnd) {
    g.fillStyle = rgbaCss(hex, 0.92);
    g.fillRect(x, y, w, h);
    const stamps = Math.round(worn * (w * h) / 30);
    g.fillStyle = rgbaCss(asphaltHex, 0.9);
    for (let i = 0; i < stamps; i++) {
      const sw = 2 + rnd() * 5, sh = 2 + rnd() * 5;
      g.fillRect(x + rnd() * (w - sw), y + rnd() * (h - sh), sw, sh);
    }
  }

  // road 512×1024 = 8 m × 15 m (RENDER.road.textureM): asphalt, wear, patches, cracks, tyre marks, lane paint, grain
  _paintRoad(c) {
    const W = c.width, H = c.height;
    const g = ctx2d(c);
    resetCtx(g, c);
    const R = PALETTE.road;
    const pxX = W / RENDER.road.textureM[0], pxY = H / RENDER.road.textureM[1];
    const rnd = mulberry32(0x6F0B13);                               // fixed cosmetic seed: the road never changes
    g.fillStyle = hexCss(R.asphalt); g.fillRect(0, 0, W, H);
    // soft wear blotches
    for (let i = 0; i < 70; i++) {
      const x = rnd() * W, y = rnd() * H, r = (0.4 + rnd() * 1.8) * pxX, col = rnd() < 0.5 ? R.crack : R.patch;
      this._wrapY(g, H, y - r, y + r, () => {
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, rgbaCss(col, 0.2)); grd.addColorStop(1, rgbaCss(col, 0));
        g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
      });
    }
    // tar patches
    for (let i = 0; i < 12; i++) {
      const x = rnd() * W, y = rnd() * H, w = (0.6 + rnd() * 1.6) * pxX, h = (0.8 + rnd() * 2.2) * pxY, rot = (rnd() - 0.5) * 0.2;
      const ext = 0.5 * Math.sqrt(w * w + h * h);                    // bound of the rotated patch
      this._wrapY(g, H, y - ext, y + ext, () => {
        g.save(); g.translate(x, y); g.rotate(rot);
        g.fillStyle = rgbaCss(R.patch, 0.85); roundRectPath(g, -w / 2, -h / 2, w, h, 6); g.fill();
        g.restore();
      });
    }
    // tyre marks: wavy streaks that fade in and out inside the tile
    g.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const xBase = W / 2 + side * (1.0 + rnd() * 1.6) * pxX, amp = (0.1 + rnd() * 0.25) * pxX, freq = 1 + rnd() * 2, ph = rnd() * 6.28;
      const yA = rnd() * 0.3, yB = 0.6 + rnd() * 0.35;
      const grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, rgbaCss(R.tyre, 0)); grd.addColorStop(yA + 0.15, rgbaCss(R.tyre, R.tyreOpacity));
      grd.addColorStop(yB - 0.1, rgbaCss(R.tyre, R.tyreOpacity)); grd.addColorStop(1, rgbaCss(R.tyre, 0));
      g.strokeStyle = grd; g.lineWidth = 0.22 * pxX;
      g.beginPath();
      for (let y = 0; y <= H; y += 16) {
        const x = xBase + Math.sin((y / H) * 6.28 * freq + ph) * amp;
        if (y === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    // lane paint: centre dashes (dashM long; the period is stretched so an integer number fits the 15 m tile) and edge lines
    const dashW = 0.15 * pxX;                                       // 0.15 m paint width (shape constant)
    const periods = Math.max(1, Math.round(RENDER.road.textureM[1] / (R.dashM + R.dashGapM)));
    const periodPx = H / periods, dashPx = R.dashM * pxY;
    for (let k = 0; k < periods; k++) {
      this._paintStripe(g, W / 2 - dashW / 2, k * periodPx + (periodPx - dashPx) * 0.5, dashW, dashPx, R.dash, R.dashWorn, R.asphalt, rnd);
    }
    const edgeX = 0.35 * pxX, edgeW = 0.12 * pxX;                   // edge line 0.35 m in, 0.12 m wide (shape constants)
    this._paintStripe(g, edgeX, 0, edgeW, H, R.edge, 0.2, R.asphalt, rnd);
    this._paintStripe(g, W - edgeX - edgeW, 0, edgeW, H, R.edge, 0.2, R.asphalt, rnd);
    // cracks: random walks drawn wrapped (points precomputed so the three copies match)
    g.strokeStyle = hexCss(R.crack); g.lineJoin = 'round';
    const pts = new Float32Array(64);
    for (let i = 0; i < 16; i++) {
      let x = rnd() * W, y = rnd() * H, a = rnd() * 6.28;
      const n = 6 + Math.floor(rnd() * 10), lw = 1.5 + rnd() * 2.5;
      pts[0] = x; pts[1] = y;
      for (let s = 1; s <= n; s++) { a += (rnd() - 0.5) * 1.2; const len = 10 + rnd() * 24; x += Math.cos(a) * len; y += Math.sin(a) * len; pts[s * 2] = x; pts[s * 2 + 1] = y; }
      let y0 = pts[1], y1 = pts[1];
      for (let s = 1; s <= n; s++) { const py = pts[s * 2 + 1]; if (py < y0) y0 = py; else if (py > y1) y1 = py; }
      g.lineWidth = lw;
      this._wrapY(g, H, y0 - lw, y1 + lw, () => {
        g.beginPath(); g.moveTo(pts[0], pts[1]);
        for (let s = 1; s <= n; s++) g.lineTo(pts[s * 2], pts[s * 2 + 1]);
        g.stroke();
      });
    }
    // (no manhole here: a baked cover recurred in the same lane every 15 m — VIS-11; environment.js places
    // seeded manhole decals per road segment instead)
    // pebbles / debris specks
    g.fillStyle = rgbaCss(R.patch, 0.55);
    for (let i = 0; i < 70; i++) g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 1 + rnd() * 3);
    // ±asphaltNoise per-pixel grain over everything: a tiled GRAIN_TILE² noise pattern composited with 'overlay' (dark
    // asphalt × (1 ± amp), like the old per-pixel multiply) instead of a getImageData loop over the whole 512×1024 canvas
    // (≈ 140 ms at 4× CPU throttling — round-2 QA VIS-17)
    this._grain(g, W, H, R.asphaltNoise, rnd);
  }

  /** Overlays a GRAIN_TILE × GRAIN_TILE white-noise tile (grey 0.5 ± amp/2, so 'overlay' scales dark pixels by 1 ± amp)
   *  across the whole canvas. Allocates one small canvas (boot only). */
  _grain(g, W, H, amp, rnd) {
    const t = makeCanvas(GRAIN_TILE, GRAIN_TILE), tg = ctx2d(t);
    const img = tg.createImageData(GRAIN_TILE, GRAIN_TILE), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.round(255 * (0.5 + (rnd() - 0.5) * amp));
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    tg.putImageData(img, 0, 0);
    const pat = g.createPattern(t, 'repeat');
    if (!pat) return;
    g.save();
    g.globalCompositeOperation = 'overlay';
    g.fillStyle = pat;
    g.fillRect(0, 0, W, H);
    g.restore();
  }

  // digit atlas 1024×256: 2 rows × 10 cells of 102×128, glyph 100 px Lilita One, RENDER.atlas.strokePx outline (§6.3)

  /** Paints both atlas rows. Digits / ops / letters share one baseline (centred on the cap box of '0')
   *  so mixed strings line up; ÷, ★ and ⚡ are shapes (_paintDivide, _paintSymbol), ★ / ⚡ centred on their own box. A glyph wider
   *  or taller than the padded cell (cell − 2·padPx − strokePx) is scaled down to fit, and every glyph is
   *  clipped to its own cell so nothing bleeds into a neighbour. */
  _paintAtlas(c) {
    const g = ctx2d(c);
    const A = RENDER.atlas, cw = A.cell[0], chh = A.cell[1];
    resetCtx(g, c);
    const fontOk = this._fontLoaded();
    const family = '"' + RENDER.textures.font + '", ' + A.fallbackFont;
    const maxW = cw - 2 * A.padPx - A.strokePx, maxH = chh - 2 * A.padPx - A.strokePx;
    g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.lineJoin = 'round'; g.lineWidth = A.strokePx;
    g.strokeStyle = hexCss(PALETTE.glyph.outline); g.fillStyle = hexCss(PALETTE.glyph.fill);
    // shared baseline from the ink box of '0' in the display font
    g.font = A.glyphPx + 'px ' + family;
    const m0 = g.measureText(A.rows[0][0]);
    const hasBox = typeof m0.actualBoundingBoxAscent === 'number' && (m0.actualBoundingBoxAscent + m0.actualBoundingBoxDescent) > 0;
    const capAsc = hasBox ? m0.actualBoundingBoxAscent : A.glyphPx * 0.72;   // shape constant: typical cap height of a display face
    const capDesc = hasBox ? m0.actualBoundingBoxDescent : 0;
    for (let row = 0; row < A.rows.length; row++) {
      for (let col = 0; col < A.rows[row].length; col++) {
        if (row === 1 && A.rows[row][col] === DIV_GLYPH) {
          this._paintDivide(g, col * cw, row * chh, cw, chh, family, capAsc, capDesc);
          continue;
        }
        if (row === 1 && (A.rows[row][col] === STAR_GLYPH || A.rows[row][col] === BOLT_GLYPH)) {
          this._paintSymbol(g, A.rows[row][col] === STAR_GLYPH, col * cw, row * chh, cw, chh, maxW, maxH);
          continue;
        }
        const symbol = row === 1 && col >= SYMBOL_FROM_COL;
        // symbols ask for the monochrome text presentation (VS15) so they take the white fill + outline
        const chr = symbol ? A.rows[row][col] + TEXT_PRESENTATION : A.rows[row][col];
        const fam = symbol ? A.fallbackFont : family;
        let px = A.glyphPx;
        g.font = px + 'px ' + fam;
        let m = g.measureText(chr);
        const box = typeof m.actualBoundingBoxAscent === 'number';
        const gw = m.width;
        const gh = box ? m.actualBoundingBoxAscent + m.actualBoundingBoxDescent : px * 0.75;
        const k = Math.min(1, maxW / Math.max(1, gw), maxH / Math.max(1, gh));
        if (k < 1) {
          px = Math.max(8, Math.floor(px * k));
          g.font = px + 'px ' + fam;
          m = g.measureText(chr);
        }
        const x0 = col * cw, y0 = row * chh;
        const cx = x0 + cw / 2, cy = y0 + chh / 2;
        const y = (symbol && box)
          ? cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2
          : cy + (capAsc - capDesc) / 2 * (px / A.glyphPx);
        g.save();
        g.beginPath(); g.rect(x0, y0, cw, chh); g.clip();
        g.strokeText(chr, cx, y);
        g.fillText(chr, cx, y);
        g.restore();
      }
    }
    this._atlasWithFont = fontOk;
  }

  /** VIS-5: the ÷ cell drawn as shapes — a bar DIV_SHAPE.barW of the cell wide and barH tall, two round dots of
   *  diameter `dot` with a `gap` above / below the bar — stroked with the same outline as the digits, then filled
   *  white. Centred on the ink centre of the font's '+' so mixed op strings line up. */
  _paintDivide(g, x0, y0, cw, chh, family, capAsc, capDesc) {
    const A = RENDER.atlas, D = DIV_SHAPE;
    const barW = cw * D.barW, barH = chh * D.barH, r = chh * D.dot * 0.5, gap = chh * D.gap;
    const half = barH * 0.5 + gap + 2 * r;                             // ink half height (without the outline)
    const cx = x0 + cw * 0.5;
    // ink centre of '+' at the shared baseline (same baseline rule as the other glyphs)
    let cy = y0 + chh * 0.5;
    g.font = A.glyphPx + 'px ' + family;
    const m = g.measureText(A.rows[1][0]);
    if (typeof m.actualBoundingBoxAscent === 'number' && m.actualBoundingBoxAscent + m.actualBoundingBoxDescent > 0) {
      const base = y0 + chh * 0.5 + (capAsc - capDesc) * 0.5;
      cy = base - (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) * 0.5;
    }
    const lim = half + A.strokePx * 0.5;                              // keep the outline inside the cell
    cy = Math.min(y0 + chh - lim, Math.max(y0 + lim, cy));
    this._divProbeX = cx; this._divProbeY = cy;                       // round 6: the bar centre is the atlas probe pixel
    const dy = barH * 0.5 + gap + r;                                  // dot centre offset from the bar centre
    const bx = cx - barW * 0.5, by = cy - barH * 0.5, br = barH * 0.5;
    g.save();
    g.beginPath(); g.rect(x0, y0, cw, chh); g.clip();
    g.beginPath();
    g.moveTo(bx + br, by); g.lineTo(bx + barW - br, by); g.arc(bx + barW - br, cy, br, -Math.PI / 2, Math.PI / 2);
    g.lineTo(bx + br, by + barH); g.arc(bx + br, cy, br, Math.PI / 2, Math.PI * 1.5); g.closePath();
    g.moveTo(cx + r, cy - dy); g.arc(cx, cy - dy, r, 0, Math.PI * 2); g.closePath();
    g.moveTo(cx + r, cy + dy); g.arc(cx, cy + dy, r, 0, Math.PI * 2); g.closePath();
    g.lineWidth = A.strokePx; g.lineJoin = 'round';
    g.strokeStyle = hexCss(PALETTE.glyph.outline); g.stroke();
    g.fillStyle = hexCss(PALETTE.glyph.fill); g.fill();
    g.restore();
  }

  /** Round-3 verify: ★ (5-point star) or ⚡ (bolt) as a path in its cell — no font, so no system-font fallback lookup
   *  at boot — stroked with the digits' outline and filled white, its ink box centred in the cell (as the font symbols
   *  were) and inside the padded cell (maxW × maxH). */
  _paintSymbol(g, star, x0, y0, cw, chh, maxW, maxH) {
    const A = RENDER.atlas;
    const cx = x0 + cw * 0.5, cy = y0 + chh * 0.5;
    g.save();
    g.beginPath(); g.rect(x0, y0, cw, chh); g.clip();
    g.beginPath();
    if (star) {
      // ink: width 2R·sin 72°, height R·(1 + cos 36°); the centre sits below the ink centre by R·(1 − cos 36°) / 2
      const R = STAR_FILL * Math.min(maxW / (2 * Math.sin(Math.PI * 0.4)), maxH / (1 + Math.cos(Math.PI * 0.2)));
      const oy = cy + R * (1 - Math.cos(Math.PI * 0.2)) * 0.5;
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI * 0.5 + i * Math.PI * 0.2, r = (i & 1) ? R * STAR_INNER : R;
        if (i === 0) g.moveTo(cx + Math.cos(a) * r, oy + Math.sin(a) * r); else g.lineTo(cx + Math.cos(a) * r, oy + Math.sin(a) * r);
      }
    } else {
      const bh = Math.min(maxH * BOLT_FILL_H, maxW / BOLT_ASPECT), bw = bh * BOLT_ASPECT;
      const bx = cx - bw * 0.5, by = cy - bh * 0.5;
      for (let i = 0; i < BOLT_PTS.length; i += 2) {
        if (i === 0) g.moveTo(bx + BOLT_PTS[i] * bw, by + BOLT_PTS[i + 1] * bh); else g.lineTo(bx + BOLT_PTS[i] * bw, by + BOLT_PTS[i + 1] * bh);
      }
    }
    g.closePath();
    g.lineWidth = A.strokePx; g.lineJoin = 'round';
    g.strokeStyle = hexCss(PALETTE.glyph.outline); g.stroke();
    g.fillStyle = hexCss(PALETTE.glyph.fill); g.fill();
    g.restore();
  }

  _paintDisc(c, stops) {
    const size = c.width, g = ctx2d(c);
    resetCtx(g, c);
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (let i = 0; i < stops.length; i += 2) grd.addColorStop(stops[i], 'rgba(255,255,255,' + stops[i + 1] + ')');
    g.fillStyle = grd; g.fillRect(0, 0, size, size);
    return c;
  }


  // smoke 256×256: tileable fbm in rgb (column shader reads .r), soft blob × noise in alpha (particles)
  _paintSmoke(c) {
    const W = c.width, H = c.height;
    const g = ctx2d(c);
    resetCtx(g, c);
    const img = g.createImageData(W, H), d = img.data;
    // the 4 octaves' lattice values are hashed once (4² + 8² + 16² + 32² values) instead of 4 hashes per octave per
    // pixel (VIS-17: the same tileable value noise, a fraction of the boot cost)
    const lat = [];
    for (let o = 0, f = 4; o < 4; o++, f *= 2) {
      const a = new Float32Array(f * f);
      for (let iy = 0; iy < f; iy++) for (let ix = 0; ix < f; ix++) a[iy * f + ix] = hash3(ix, iy, o);
      lat.push(a);
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        let n = 0, amp = 1, sum = 0, f = 4;
        for (let o = 0; o < 4; o++) { n += latticeNoise(lat[o], u, v, f) * amp; sum += amp; amp *= 0.5; f *= 2; }
        n /= sum;
        const dx = u - 0.5, dy = v - 0.5;
        const blob = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.1);
        const a = blob * blob * (0.45 + 0.55 * n);
        const i = (y * W + x) * 4, v8 = Math.round(255 * n);
        d[i] = v8; d[i + 1] = v8; d[i + 2] = v8; d[i + 3] = Math.round(255 * Math.min(1, a));
      }
    }
    g.putImageData(img, 0, 0);
  }

  // windows 256×256 (emissive, lit windows only) + facade (colour map) with the same layout: tile = 6 m × 6 m, 2 storeys × 4 windows
  _paintWindows(ce, cf) {
    const W = ce.width, H = ce.height;
    const ge = ctx2d(ce), gf = ctx2d(cf);
    resetCtx(ge, ce); resetCtx(gf, cf);
    const P = PALETTE.props;
    const rnd = mulberry32(0x7E6B45);
    ge.fillStyle = '#000000'; ge.fillRect(0, 0, W, H);
    gf.fillStyle = hexCss(P.building); gf.fillRect(0, 0, W, H);
    const storeys = 2, perStorey = 4, sh = H / storeys, pitch = W / perStorey;
    const winW = Math.round(pitch * 0.6), winH = Math.round(sh * 0.47), winX = Math.round((pitch - winW) / 2), winY = Math.round(sh * 0.23);
    for (let s = 0; s < storeys; s++) {
      const top = s * sh;
      // floor band
      gf.fillStyle = 'rgba(0,0,0,0.18)'; gf.fillRect(0, top + sh - sh * 0.11, W, sh * 0.11);
      gf.fillStyle = 'rgba(255,255,255,0.06)'; gf.fillRect(0, top + sh - sh * 0.11, W, 2);
      for (let k = 0; k < perStorey; k++) {
        const x = k * pitch + winX, y = top + winY;
        const lit = rnd() < P.windowLitFraction, broken = !lit && rnd() < 0.22;
        // frame + glass on the facade
        gf.fillStyle = 'rgba(255,255,255,0.12)'; gf.fillRect(x - 2, y - 2, winW + 4, winH + 4);
        gf.fillStyle = hexCss(P.window); gf.fillRect(x, y, winW, winH);
        if (broken) {
          gf.fillStyle = 'rgba(0,0,0,0.55)';
          gf.beginPath(); gf.moveTo(x, y); gf.lineTo(x + winW * (0.4 + rnd() * 0.5), y); gf.lineTo(x + winW * (0.2 + rnd() * 0.4), y + winH * (0.5 + rnd() * 0.5)); gf.lineTo(x, y + winH); gf.closePath(); gf.fill();
        } else {
          gf.fillStyle = 'rgba(255,255,255,0.08)'; gf.fillRect(x + 2, y + 2, winW * 0.3, winH - 4);   // reflection
        }
        gf.fillStyle = 'rgba(0,0,0,0.5)'; gf.fillRect(x + winW / 2 - 1, y, 2, winH);                  // mullion
        if (lit) {
          const grd = ge.createLinearGradient(0, y, 0, y + winH);
          grd.addColorStop(0, hexCss(P.windowLit)); grd.addColorStop(1, rgbaCss(P.windowLit, 0.55));
          ge.fillStyle = grd; ge.fillRect(x + 1, y + 1, winW - 2, winH - 2);
          if (rnd() < 0.5) { ge.fillStyle = 'rgba(0,0,0,0.6)'; ge.fillRect(x + 1, y + 1, winW * (0.3 + rnd() * 0.4), winH - 2); }   // curtain
          gf.fillStyle = rgbaCss(P.windowLit, 0.45); gf.fillRect(x + 1, y + 1, winW - 2, winH - 2);
        }
      }
    }
    // facade grain (tiled pattern, VIS-17) + grime streaks
    this._grain(gf, W, H, FACADE_GRAIN, rnd);
    gf.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 0; i < 10; i++) { const x = rnd() * W, w = 2 + rnd() * 5, y = rnd() * H, h = 20 + rnd() * 90; gf.fillRect(x, y, w, h); }
  }

  // muzzle 128×64: two flash frames (4-point star, 6-point star), white premultiplied
  _paintMuzzle(c) {
    const W = c.width, H = c.height;
    const g = ctx2d(c);
    resetCtx(g, c);
    const star = (cx, cy, points, rOut, rIn, glowR) => {
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);
      g.fillStyle = 'rgba(255,255,255,1)'; g.beginPath();
      for (let i = 0; i < points * 2; i++) {
        const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2, r = (i % 2 === 0) ? rOut : rIn;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
    };
    star(H / 2, H / 2, 4, 28, 7, 22);
    star(W - H / 2, H / 2, 6, 18, 6, 16);
  }

  // icons 512×64: RENDER.icons.order pictograms in square ICON_CELL cells along the top row
  _paintIcons(c) {
    const g = ctx2d(c);
    resetCtx(g, c);
    const order = RENDER.icons.order;
    const s = ICON_CELL / ICON_DESIGN;
    for (let i = 0; i < order.length; i++) {
      g.save();
      g.beginPath(); g.rect(i * ICON_CELL, 0, ICON_CELL, ICON_CELL); g.clip();
      this._paintIcon(g, order[i], i * ICON_CELL + ICON_CELL / 2, ICON_CELL / 2, s);
      g.restore();
    }
  }

  /** Paints one pictogram centred at (cx, cy), scaled by `scale` from its 32-unit design space (±16).
   *  Round-4 redraw (r3-ftue residual 3: the shotgun pill, "an orange ring around a dark shape", was hard to read): every
   *  icon is ONE bold silhouette filling ≈ ±14 units, so it reads at the 18–36 css px it is shown at (HUD pills, shop,
   *  icon flights, item-gate quads). Guns are side views tilted muzzle-up (ICON_GUN_TILT): a stock / receiver / barrel
   *  profile is what makes a gun read at 20 px, and the tilt gives the barrel the cell's diagonal. Fills are mid-to-light
   *  (weapon / gear colour + a mid gunmetal, PALETTE.ui.bossBarShield): the old near-black parts (PALETTE.props.tyre) vanished
   *  on the dark pill, a light grey one would vanish on the pill's light disc (round 4); the dark outline (PALETTE.glyph.outline,
   *  ICON_STROKE) carries every part on light backgrounds.
   *  Coordinates below are design-space shape constants. Each part strokes its outline FIRST and fills over it, so only
   *  the outer half shows and a later part's outline draws the seam between parts (round-2 QA VIS-16). Boot-only
   *  (atlas + the cached DOM data URLs), never per frame. */
  _paintIcon(g, key, cx, cy, scale) {
    const outline = hexCss(PALETTE.glyph.outline);
    const METAL = PALETTE.ui.bossBarShield, METAL_DK = PALETTE.troop.sniperCoat, HI = PALETTE.ui.text;
    let unit = 1;   // current local scale (sub-frames below): outlines stay ICON_STROKE design units wide
    const fs = (hex) => { g.fillStyle = typeof hex === 'number' ? hexCss(hex) : hex; };
    const paint = (hex) => { g.strokeStyle = outline; g.lineWidth = ICON_STROKE / unit; g.lineJoin = 'round'; g.stroke(); fs(hex); g.fill(); };
    const rr = (x, y, w, h, r, hex) => { roundRectPath(g, x, y, w, h, r); paint(hex); };
    const circle = (x, y, r, hex) => { g.beginPath(); g.arc(x, y, r, 0, 6.2832); paint(hex); };
    const poly = (pts, hex) => { g.beginPath(); for (let i = 0; i < pts.length; i += 2) { if (i === 0) g.moveTo(pts[i], pts[i + 1]); else g.lineTo(pts[i], pts[i + 1]); } g.closePath(); paint(hex); };
    const seam = (x0, y0, x1, y1) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.strokeStyle = outline; g.lineWidth = ICON_SEAM / unit; g.stroke(); };
    // a sub-frame: offset, rotation, uniform scale k (outline widths compensate)
    const frame = (dx, dy, rot, k, fn) => { g.save(); g.translate(dx, dy); g.rotate(rot); g.scale(k, k); const u = unit; unit = u * k; fn(); unit = u; g.restore(); };
    const draw = {
      // pump shotgun: orange stock, receiver and pump grip; gunmetal barrel over a darker magazine tube
      shotgun() {
        frame(0.6, 0.75, ICON_GUN_TILT, 0.94, () => {
          poly([-9, -6, -16, -3, -16, 6.5, -11.5, 7, -9, 2.5], WEAPONS.shotgun.color);
          rr(-3, -1.5, 17, 3.5, 1.2, METAL_DK);
          rr(-3, -7, 22, 5.5, 2, METAL);
          rr(-10, -7.5, 9, 10, 2, WEAPONS.shotgun.color);
          rr(4, -2.5, 10, 7, 2.5, WEAPONS.shotgun.color);
          seam(7.3, -2.5, 7.3, 4.5); seam(10.7, -2.5, 10.7, 4.5);
        });
      },
      // minigun: three yellow barrels clamped by two gunmetal rings, gunmetal motor block behind
      minigun() {
        frame(0, 0, ICON_GUN_TILT, 0.82, () => {
          rr(-18, -7, 12, 14, 3.5, METAL);
          rr(-21, -3, 4, 6, 1.5, METAL_DK);
          for (let k = 0; k < 3; k++) rr(-7, -7 + k * 4.8, 25, 4.4, 2, WEAPONS.minigun.color);
          rr(-6, -9.5, 4, 19, 1.5, METAL);
          rr(10, -9, 4, 18, 1.5, METAL);
        });
      },
      // rocket: orange body, white nose, dark fins, yellow exhaust — flying up-right
      rocket() {
        frame(1.75, -1.75, -Math.PI / 4, 0.92, () => {
          poly([-12, -2.5, -20, 0, -12, 2.5], PALETTE.fx.gold);
          poly([-4, -4, -11, -4, -15, -10.5, -9, -10.5], METAL_DK);
          poly([-4, 4, -11, 4, -15, 10.5, -9, 10.5], METAL_DK);
          rr(-13, -5, 22, 10, 3.5, WEAPONS.rocket.color);
          g.beginPath(); g.moveTo(8, -5); g.quadraticCurveTo(16, -4, 19, 0); g.quadraticCurveTo(16, 4, 8, 5); g.closePath(); paint(HI);
          seam(1, -5, 1, 5);
        });
      },
      // railgun: a forked barrel (two blue rails, PALETTE.fx.blue — the pale WEAPONS.railgun.color vanished on the pill's light
      // disc — with the pale rail-colour charge between them) on a gunmetal stock
      rail() {
        frame(-1.85, 0.8, ICON_GUN_TILT, 0.8, () => {
          poly([-17, -3, -9, -4.5, -9, 4.5, -17, 7], METAL);
          poly([-7, 3, -2, 3, -4, 10.5, -9, 10.5], METAL_DK);
          rr(-3, -9, 23, 5, 2, PALETTE.fx.blue);
          rr(-3, 4, 23, 5, 2, PALETTE.fx.blue);
          rr(-10, -6.5, 10, 13, 2.5, METAL);
          rr(1, -2, 18, 4, 2, WEAPONS.railgun.color);
        });
      },
      // laser: retro ray-gun pistol (round cyan body, barrel with two white rings, white emitter tip)
      laser() {
        frame(-0.2, -2, ICON_GUN_TILT * 0.6, 0.95, () => {
          poly([-11, 1, -4, 1, -6.5, 13, -13.5, 13], METAL);
          rr(-4, -6, 17, 7, 2.5, WEAPONS.laser.color);
          circle(-7, -2.5, 7.5, WEAPONS.laser.color);
          rr(1, -8.5, 3, 12, 1.2, HI);
          rr(6.5, -8, 3, 11, 1.2, HI);
          circle(15, -2.5, 3.5, HI);
        });
      },
      // armour: a big blue shield with a light left half (the plate glint)
      armor() {
        g.beginPath(); g.moveTo(0, -15); g.lineTo(13, -10); g.lineTo(12, 2); g.quadraticCurveTo(9, 11, 0, 15.5); g.quadraticCurveTo(-9, 11, -12, 2); g.lineTo(-13, -10); g.closePath(); paint(GEAR.armor.color);
        g.beginPath(); g.moveTo(0, -11); g.lineTo(-9.5, -7.5); g.lineTo(-8.5, 2); g.quadraticCurveTo(-6.5, 8.5, 0, 12); g.closePath(); fs('rgba(255,255,255,0.4)'); g.fill();
      },
      // fire-rate chip: a cyan square with light pins on all four sides and a dark die in the middle
      chip() {
        for (let i = -1; i <= 1; i++) { rr(-15, i * 6 - 1.75, 30, 3.5, 1, METAL); rr(i * 6 - 1.75, -15, 3.5, 30, 1, METAL); }
        rr(-10.5, -10.5, 21, 21, 3, GEAR.chip.color);
        rr(-5, -5, 10, 10, 1.5, PALETTE.glyph.outline);
        rr(-2, -2, 4, 4, 1, HI);
      },
      // damage booster: one fat up arrow
      booster() { poly([-14, 1, 0, -15, 14, 1, 5.5, 1, 5.5, 14, -5.5, 14, -5.5, 1], GEAR.booster.color); },
      // magnet: a thick horseshoe with white pole tips
      magnet() {
        g.beginPath(); g.arc(0, -2, 13, Math.PI, 0); g.lineTo(13, 13); g.lineTo(5, 13); g.lineTo(5, -2); g.arc(0, -2, 5, 0, Math.PI, true); g.lineTo(-5, 13); g.lineTo(-13, 13); g.closePath(); paint(GEAR.magnet.color);
        rr(-13, 6, 8, 7, 0.5, HI); rr(5, 6, 8, 7, 0.5, HI);
      },
      // sniper: a bold scope reticle (thick ring + four ticks) with a red centre dot
      sniper() {
        const lens = hexCss(PALETTE.troop.sniperLens);
        g.beginPath(); g.arc(0, 0, 10, 0, 6.2832);
        g.moveTo(0, -13.5); g.lineTo(0, -5.5); g.moveTo(0, 5.5); g.lineTo(0, 13.5); g.moveTo(-13.5, 0); g.lineTo(-5.5, 0); g.moveTo(5.5, 0); g.lineTo(13.5, 0);
        g.lineCap = 'round'; g.strokeStyle = outline; g.lineWidth = (ICON_STROKE + 4 * unit) / unit; g.stroke(); g.strokeStyle = lens; g.lineWidth = 4; g.stroke();
        circle(0, 0, 3, PALETTE.ui.danger);
      },
      // medic: a white disc with a big red cross
      medic() { circle(0, 0, 14.5, PALETTE.troop.medic); fs(PALETTE.troop.medicCross); g.fillRect(-3.75, -10.5, 7.5, 21); g.fillRect(-10.5, -3.75, 21, 7.5); },
      // flamer: one big flame with a pale core
      flame() {
        g.beginPath(); g.moveTo(1, -15.5); g.bezierCurveTo(11, -5, 14, 3, 10, 10); g.bezierCurveTo(7, 15, -7, 15, -10, 10); g.bezierCurveTo(-14, 3, -10, -5, -5, -8); g.bezierCurveTo(-4, -3, -1, -3, 1, -15.5); g.closePath(); paint(PALETTE.troop.flamerTank);
        g.beginPath(); g.moveTo(0, -4); g.bezierCurveTo(7, 2, 7, 9, 0, 12); g.bezierCurveTo(-7, 9, -7, 2, 0, -4); fs(PALETTE.fx.spark); g.fill();
      },
      // drone: a dark X frame with four light rotor discs and a light hub with the green LED
      drone() {
        frame(0, 0, Math.PI / 4, 1, () => { rr(-15, -2.75, 30, 5.5, 2.5, METAL_DK); rr(-2.75, -15, 5.5, 30, 2.5, METAL_DK); });
        circle(-10.5, -10.5, 4.75, PALETTE.troop.drone); circle(10.5, -10.5, 4.75, PALETTE.troop.drone); circle(-10.5, 10.5, 4.75, PALETTE.troop.drone); circle(10.5, 10.5, 4.75, PALETTE.troop.drone);
        rr(-6.5, -6.5, 13, 13, 3.5, PALETTE.troop.drone); circle(0, 0, 3, PALETTE.troop.droneLed);
      },
      // APC: olive hull with a sloped nose, turret + gun, three grey wheels
      apc() {
        rr(-4, -12, 17, 3, 1, METAL);
        rr(-8, -13.5, 11, 7, 2.5, PALETTE.soldier.helmet);
        poly([-15, -6, 7, -6, 15, 0, 15, 6, -15, 6], PALETTE.soldier.helmet);
        circle(-9, 7.5, 4.5, METAL_DK); circle(0, 7.5, 4.5, METAL_DK); circle(9, 7.5, 4.5, METAL_DK);
        fs(PALETTE.troop.apcLight); g.fillRect(11.5, -1, 2.5, 3);
      },
      // coins: a gold coin with an inner rim and a glint
      coins() {
        circle(0, 0, 14.5, PALETTE.ui.coin);
        g.beginPath(); g.arc(0, 0, 9.5, 0, 6.2832); g.strokeStyle = rgbaCss(PALETTE.ui.primaryBorder, 0.95); g.lineWidth = 2.5; g.stroke();
        fs('rgba(255,255,255,0.55)'); g.beginPath(); g.arc(-4.5, -4.5, 4, 0, 6.2832); g.fill();
      },
      star() { const pts = []; for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 - Math.PI / 2, r = i % 2 === 0 ? 15.5 : 7; pts.push(Math.cos(a) * r, Math.sin(a) * r + 1); } poly(pts, PALETTE.ui.primary); },
    };
    g.save();
    g.translate(cx, cy);
    g.scale(scale * ICON_FIT, scale * ICON_FIT);
    unit = ICON_FIT;
    g.lineCap = 'round';
    const fn = draw[key];
    if (fn) fn(); else circle(0, 0, 10, PALETTE.ui.textMuted);
    g.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// RenderSystem
// ---------------------------------------------------------------------------------------------

/**
 * Owns the WebGL 2 renderer, the scene, the camera (presets, follow, shake, FOV kick, boss dolly, title
 * and game-over moves), the lights and shadows, the fog, the post chain (EffectComposer → RenderPass →
 * UnrealBloomPass → GradeOutputPass) and the Low-tier blob shadows; builds the TextureFactory, the
 * MaterialLibrary and the Environment in the §4.1 order. ctx.render is assigned by main before init().
 */
export class RenderSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.composer = null;
    this.overlayLayer = OVERLAY_LAYER;                         // FX-10 residual: layer of the post-bloom overlay (fx count label)
    this.overlayPass = null;
    this.textures = null;
    this.materials = null;
    this.env = null;
    this.uniforms = { uTime: { value: 0 } };                 // the ONE shared time uniform (ARCH §6.3)
    this.size = { w: 0, h: 0, dpr: 0.5, portrait: true };     // dpr holds a fraction (render scale): seeded as a Double
    this.size.dpr = 1;
    this.dirty = true;
    // r7 (perf-render:1 / :6): a render scale set by engine applies at the start of the next draw (re-allocation and
    // redraw in one task); _sizeDirty = the drawing buffer was re-allocated (cleared) and not drawn since
    this._scalePending = false;
    this._sizeDirty = false;
    this.lights = { sun: null, hemi: null, bossCore: null, laser: null };
    this.callStats = { main: 0, shadow: 0, post: 0, total: 0, materials: 0 };   // sampled by draw() (engine debug overlay);
    // materials = distinct materials of the visible drawables (VIS-13), resampled every MAT_SAMPLE_FRAMES draws
    this._matTick = 0; this._matStamp = 0; this._matCount = 0;
    // per-material stamp indexed by Material.id (round-2 cross-group: writing a `_grMatStamp` property onto three's
    // materials added a property to every drawn material on the first sample, transitioning their maps and
    // deoptimising three's render loop; the ids are small sequential integers, the array grows rarely)
    this._matStamps = new Int32Array(256);
    this._countMat = (o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || (o.isInstancedMesh && !(o.count > 0))) return;
      const m = o.material;
      if (Array.isArray(m)) { for (let i = 0; i < m.length; i++) this._stampMat(m[i]); } else this._stampMat(m);
    };
    this.blobShadows = null;                                  // Low-tier disc InstancedMesh (BLOB_CAP)
    this._onTexRepaint = () => { this.dirty = true; };
    this.renderPass = null;
    this.bloomPass = null;
    this.gradePass = null;
    this.gpu = null;                                          // GPU string the tier was detected from (debug)

    // capabilities
    this._halfFloatOk = false;
    this._maxSamples = 0;
    this._maxAniso = 1;
    // composer state (ARCH §9.4: targets / passes are created only in applyQuality)
    this._composerOn = false;                                 // draw() uses the composer only once committed (VIS-1)
    this._composerSamples = -1;
    // deferred tier switch (VIS-1) and shader warm-up (VIS-2)
    this._committedKey = '';
    this._committedParams = null;                             // params of the committed program state (context restore)
    this._pendingTier = null;
    this._tierToken = 0;
    this._tierTimer = 0;
    this._warmTarget = null;
    this._passGeo = null;
    this._warming = null;
    this._depthProbes = new Map();                            // VIS-1 shadow-depth compile twins (_depthProbe)
    this._staleBloom = null;                                  // replaced bloom pass, disposed after the next draw
    this._warmChunkToken = 0;                                 // VIS-1 post-commit hidden-content warm-up
    this._warmCam = null;
    this._warmVp = new Vector4(); this._warmSc = new Vector4();
    this._bloomMode = null;
    this._bloomStrength = RENDER.bloom.strength;
    this._desat = 0;
    // shadows
    this._shadowType = -1;
    // Fields written `this.F = 0.5; this.F = <start>;` are seeded as Doubles (round-2 cross-group, FX-14 item 2: no V8
    // map deprecation when the first fraction is stored).
    this._texelU = 0.5; this._texelU = 0; this._texelV = 0.5; this._texelV = 0;
    this._lxX = 0.5; this._lxX = 0; this._lxY = 0.5; this._lxY = 0; this._lxZ = 0.5; this._lxZ = 0;             // light-space x axis (world), for texel snapping
    this._lyX = 0.5; this._lyX = 0; this._lyY = 0.5; this._lyY = 0; this._lyZ = 0.5; this._lyZ = 0;             // light-space y axis (world)
    this._sunAz = 0.5; this._sunAz = 0;                                          // current swing of the district light offset about +Y (rad, VIS-15)
    this._sunOffX = 0.5; this._sunOffX = 0; this._sunOffY = 0.5; this._sunOffY = 0; this._sunOffZ = 0.5; this._sunOffZ = 0;  // current sun offset from its anchor
    // visual districts (round 5, docs/DISTRICTS.md §6.1): packed per-district state (built once), the current-state mirror
    // every consumer reads (`_cur`), the fade's "from" snapshot and target, and the theatre-clock fade window
    const dc = new Color();
    this._dColor = dc;                                        // scratch for packing a district that is not in DISTRICTS
    this._dPacks = DISTRICTS.map((d) => packDistrict(d, new Float64Array(DS_N), dc));
    this._dCustom = new Float64Array(DS_N);
    this._cur = new Float64Array(DS_N);
    this._cur.set(this._dPacks[0]);
    this._dFrom = new Float64Array(DS_N);
    this._dTo = this._dPacks[0];
    this._dTarget = DISTRICTS[0];
    this._fadeOn = false;
    this._fadeT0 = 0.5; this._fadeT0 = 0; this._fadeDur = 0.5; this._fadeDur = 0;
    this._bloomHold = -1;                                     // ctx.time.frame of the last finite setBloomStrength (fx's pulse wins that frame)
    this._eyeApplied = NaN;                                   // last value handed to models.setEyeGlow (models exists from boot step 6)
    this._roadBgU = null;                                     // materials.gatePanel().uniforms.uRoadBg (cached on first use)
    this._districtWarmCount = 0;                              // (mesh, geometry) pairs drawn by the last warmup (debug / tests)
    const o1 = RENDER.sun.offset;
    this._yz1 = lightYz(o1[0], o1[1], o1[2]);                 // District 1 reach factor (0.518): shadow box bottom × 1 exactly
    this._baseOffX = 0.5; this._baseOffX = o1[0]; this._baseOffY = 0.5; this._baseOffY = o1[1]; this._baseOffZ = 0.5; this._baseOffZ = o1[2];  // un-swung district offset
    // camera state
    this._presetBlend = 0.5; this._presetBlend = 1;      // 0 portrait … 1 landscape (eased on output)
    this._presetSnap = true;
    this._fovP = 0.5; this._fovP = 55; this._fovL = 0.5; this._fovL = 42;
    this._camX = 0.5; this._camX = 0; this._lookX = 0.5; this._lookX = 0;
    this._idleOn = false; this._idleBlend = 0.5; this._idleBlend = 0;
    this._countDolly = 0.5; this._countDolly = 0;                                     // VIS-3 eased √V − √ref
    this._frameBack = 0.5; this._frameBack = 0; this._framePitch = 0.5; this._framePitch = 0;                // VIS-3 eased framing correction (m, rad)
    this._frameBackT = 0.5; this._frameBackT = 0; this._framePitchT = 0.5; this._framePitchT = 0;
    this._goOn = false; this._goStart = 0.5; this._goStart = 0;
    this._dollyActive = false; this._dollyStart = 0.5; this._dollyStart = 0;
    this._dollyOut = 0.5; this._dollyOut = 0; this._dollyHold = 0.5; this._dollyHold = 0; this._dollyBack = 0.5; this._dollyBack = 0;
    this._dollyPos = new Vector3(); this._dollyLook = new Vector3();
    this._reducedMotion = false;
    this._hc = false;
    this._lastDist = 0.5; this._lastDist = 0;
    this._envUpdate = false;
    // call sampling
    this._mainStart = -1;
    // blob shadows
    this._blobActive = false;
    this._blobArr = null;
    this._blobMin = BLOB_CAP; this._blobMax = -1;
    this._blobRange = { start: 0, count: 0 };
    this._blobOwnMat = null;
    // listeners
    this._unsubs = [];
    this._onQuality = (p) => this._handleQuality(p);
    this._onSettings = (p) => this._handleSettings(p);
    this._inited = false;
  }

  // -------------------------------------------------------------------------------------------
  // init — §4.1 step 5: probe → renderer → GPU string → ctx.quality → camera + lights → textures →
  // materials → applyQuality → environment
  // -------------------------------------------------------------------------------------------
  async init() {
    if (this._inited) return this;
    const ctx = this.ctx;
    const canvas = ctx.canvas;
    if (!canvas) throw new Error(STRINGS.noWebGL2);

    // (a) WebGL 2 probe + (c) GPU string. The throwaway probe lets the tier choose `antialias` before the
    // real context exists; when the probe itself is impossible, the real canvas is probed directly.
    let gpu = null;
    let gl = null;
    const probe = probeWebGL2();
    if (probe.ok) {
      gpu = probe.gpu;
    } else {
      try { gl = canvas.getContext('webgl2', PROBE_ATTRS); } catch (_) { gl = null; }
      if (!gl) throw new Error(STRINGS.noWebGL2);
      gpu = readGpuString(gl);
    }

    // (d) quality (detectTier / maxAutoTierFor / isSoftwareGpu are engine's pure exports)
    const cfgQuality = ctx.config && ctx.config.quality != null ? ctx.config.quality : null;
    let tier = detectTier(gpu, deviceMemoryGB(), cfgQuality);
    // r7 (perf-render:2): software GL — the GPU string names a software rasteriser, or the browser refused a context
    // without a major performance caveat — starts on Low with a Low auto ceiling (unless ?quality= forces a tier), no
    // canvas AA, and the render scale at QUALITY_TIERS.renderScale.softwareStart (Auto only: engine sets 1 for a manual tier)
    const software = isSoftwareGpu(gpu) || probe.caveat === true;
    if (software && cfgQuality == null) tier = TIER_LOW;
    // dpr / renderScale hold fractions: created from 0.5 (ARCH §14 rule 11), then set
    ctx.quality = {
      tier, initialTier: tier, maxAutoTier: software && cfgQuality == null ? TIER_LOW : maxAutoTierFor(gpu, tier), auto: cfgQuality == null,
      params: QUALITY_TIERS[tier], dpr: 0.5, frozenUntil: 0,
      renderScale: 0.5, software,
    };
    ctx.quality.dpr = 1;
    ctx.quality.renderScale = software && cfgQuality == null ? QUALITY_TIERS.renderScale.softwareStart : 1;
    this.gpu = gpu;
    const params = ctx.quality.params;

    // (b) renderer — antialias is a context-creation flag decided once from the initial tier (§9.4); r7: never on software
    // GL, where 4x MSAA on the default framebuffer was the largest single cost after resolution
    const opts = {
      canvas, antialias: tier === TIER_LOW && !software, alpha: false, stencil: false, depth: true,
      powerPreference: 'high-performance', preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false,
    };
    if (gl) opts.context = gl;
    let renderer;
    try { renderer = new WebGLRenderer(opts); } catch (err) {
      warnOnce('render.context', 'WebGLRenderer creation failed: ' + (err && err.message ? err.message : String(err)));
      throw new Error(STRINGS.noWebGL2);
    }
    this.renderer = renderer;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = RENDER.exposure;
    renderer.info.autoReset = false;                          // engine.beginFrame resets (shadow + main + post per frame)
    // VIS-2: synchronous getProgramInfoLog / getShaderInfoLog checks only in debug builds
    try { renderer.debug.checkShaderErrors = !!(ctx.config && ctx.config.debug); } catch (_) { /* ignore */ }
    renderer.shadowMap.enabled = true;                        // set ONCE, never toggled (§9.3)
    renderer.shadowMap.type = RenderSystem._shadowTypeOf(params);
    this._shadowType = renderer.shadowMap.type;
    renderer.setClearColor(RENDER.fogColor, 1);
    try { this._halfFloatOk = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'); } catch (_) { this._halfFloatOk = false; }
    if (!this._halfFloatOk) warnOnce('render.halfFloat', 'No float colour buffers: composer uses 8-bit targets and bloom is off for this session');
    try { this._maxSamples = renderer.capabilities.maxSamples | 0; } catch (_) { this._maxSamples = 0; }
    try { this._maxAniso = Math.max(1, renderer.capabilities.getMaxAnisotropy()); } catch (_) { this._maxAniso = 1; }
    this._progress(0.1);

    // (e) scene, fog, camera, lights, blob shadows
    this.scene = new Scene();
    this.scene.fog = new Fog(RENDER.fogColor, WORLD.fog.near, params.fogFar);
    const C = WORLD.camera;
    this.camera = new PerspectiveCamera(this._fovP, 1, C.near, C.far);
    this.camera.position.set(C.portrait.pos[0], C.portrait.pos[1], C.portrait.pos[2]);
    this._buildLights(params);
    this._buildBlobShadows();
    this._readSettings();
    await yieldPaint();            // round-3 boot polish: the context creation and the first texture never share a frame

    // textures (awaits the display font ≤ RENDER.textures.fontWaitMs, 0.5 s since r7; a later font re-draws the atlas)
    this.textures = new TextureFactory(ctx);
    await this.textures.build((t) => this._progress(0.1 + 0.6 * t));
    this.textures.onRepaint = this._onTexRepaint;   // round 6: a re-drawn canvas needs a frame, also while paused
    await yieldPaint();            // round-3 boot polish: each step below gets a frame of its own (CORE-9 / VIS-17)

    // materials, then the quality-dependent pipeline, then the environment
    this.materials = new MaterialLibrary(ctx);
    this._progress(0.75);
    this.renderPass = new CountingRenderPass(this.scene, this.camera);
    this.overlayPass = new OverlayRenderPass(this.scene, this.camera);
    this.gradePass = new GradeOutputPass();
    this._attachBlobMaterial();
    this._applyHighContrast(this._hc);
    this.applyQuality(params);
    this._progress(0.8);
    await yieldPaint();
    this.env = new Environment(ctx);
    this.env.build();
    this._envUpdate = typeof this.env.update === 'function';
    this._installCallProbe();
    this._progress(0.95);
    await yieldPaint();

    // first size + camera pose (engine also resizes at the end of its init and emits `resize`)
    this.resize();
    this._lastDist = ctx.world ? ctx.world.distance : 0;
    this._updateCamera(0, 0, 0, true);
    this._applyDistrictState(true);                           // District 1 (= RENDER / PALETTE values) into every consumer
    this._updateSun(0);

    const ev = ctx.events;
    if (ev) {
      this._unsubs.push(ev.on('quality:change', this._onQuality));
      this._unsubs.push(ev.on('settings:change', this._onSettings));
    }
    this._inited = true;
    this.dirty = true;
    this._progress(1);
    return this;
  }

  // -------------------------------------------------------------------------------------------
  // Per-frame: update (step E) and draw (step H)
  // -------------------------------------------------------------------------------------------

  /** Camera follow + shake + dolly + FOV kick, environment scroll, sun follow, uTime (ARCH §4.2 E). */
  update(dt) {
    if (!this.renderer) return;
    const ctx = this.ctx;
    const time = ctx.time;
    const world = ctx.world;
    this.uniforms.uTime.value = time ? time.elapsed : this.uniforms.uTime.value + dt;

    // environment scroll by the distance the world actually advanced (alpha-extrapolated like the
    // scrolling objects, ARCH §2.2), so the road stays locked to gates / zombies in every state
    const env = this.env;
    if (world && env) {
      const alpha = time ? time.alpha : 0;
      const d = world.distance + world.roadSpeed * alpha * WORLD.step;
      const dz = d - this._lastDist;
      this._lastDist = d;
      if (dz > 0 && dz < SCROLL_RESET_M) env.scroll(dz);
    }
    if (env && this._envUpdate) env.update(dt);            // fog lerp etc. (optional Environment hook)

    const udt = time ? time.unscaledDt : dt;
    const now = theatreNow(time);                          // theatre clock: the dolly / game-over tweens hold while paused
    this._updateCamera(dt, udt, now, false);
    if (this._fadeOn) this._stepDistrictFade(now);
    else if (this._bloomStrength !== this._cur[DS_BLOOM_S] && this._bloomHold !== (time ? time.frame : -2)) {
      // a finite setBloomStrength holds for its frame only (docs/DISTRICTS.md §8.2): once nobody holds it (fx's boss-death
      // pulse ends on RENDER.bloom.strength, the District 1 value), the district's base comes back
      this._bloomStrength = this._cur[DS_BLOOM_S];
      if (this.bloomPass) this.bloomPass.strength = this._bloomStrength;
    }
    if (this._eyeApplied !== this._cur[DS_EYES]) this._applyEyeGlow();   // models arrives at boot step 6 (after render)
    this._updateTitleLight();
    this._updateSun(world ? world.squadX : 0);
  }

  // -------------------------------------------------------------------------------------------
  // Visual districts (round 5, docs/DISTRICTS.md §3.3, §3.4, §6.1, §8.2)
  // -------------------------------------------------------------------------------------------

  /**
   * Applies `district` (a DISTRICTS entry, or any object with the same key tree): lights (sun colour / intensity / offset
   * vector, hemisphere colours / intensity / title values), the shadow box bottom, fog colour + clear colour, exposure,
   * bloom strength / radius, the grade, the gate panel's uRoadBg and the zombie eye glow. seconds > 0 cross-fades on the
   * theatre clock (eased inOutCubic, from the current mid-fade values when a fade is running); 0 (default) snaps before
   * the next draw. Forwards to env.setDistrict(district, seconds) in the same call (same clock origin). Idempotent;
   * allocation-free (a non-table district is packed into a preallocated array). Uniform / matrix writes only: no light is
   * added, removed or re-flagged and no material is touched, so no program is ever (re)compiled.
   */
  setDistrict(district, seconds) {
    let d = district;
    if (typeof d === 'number' || typeof d === 'string') {        // an index (0-based) or an id, like env.setDistrict accepts
      const key = d;
      d = null;
      for (let k = 0; k < DISTRICTS.length; k++) { if (k === key || DISTRICTS[k].id === key) { d = DISTRICTS[k]; break; } }
    }
    if (!d || !d.sun || !d.fog || !d.hemi || !d.grade || !d.bloom || !d.road || !d.zombie) {
      warnOnce('render.district', 'setDistrict: not a district object');
      return;
    }
    const i = DISTRICTS.indexOf(d);
    let to = i >= 0 ? this._dPacks[i] : null;
    if (!to) {
      try { to = packDistrict(d, this._dCustom, this._dColor); } catch (err) {
        warnOnce('render.districtPack', 'setDistrict: district values incomplete: ' + (err && err.message));
        return;
      }
    }
    const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    this._dTarget = d;
    this._dTo = to;
    if (s > 0) {
      this._dFrom.set(this._cur);                            // a newer call during a fade starts from the mid-fade values
      this._fadeT0 = theatreNow(this.ctx.time);
      this._fadeDur = s * 1000;
      this._fadeOn = true;
    } else {
      this._fadeOn = false;
      this._cur.set(to);
      this._applyDistrictState(true);
    }
    // world parts (sky, ground, road, buildings, props, smoke, weather, fog near / far) belong to the environment
    const env = this.env;
    if (env && typeof env.setDistrict === 'function') {
      try { env.setDistrict(d, s); } catch (err) { warnOnce('render.envDistrict', 'env.setDistrict failed: ' + (err && err.message ? err.message : String(err))); }
    } else if (env && typeof env.setFog === 'function') {
      // environment without district support: at least its fog band follows the district (docs/DISTRICTS.md §6.2)
      const q = this.ctx.quality;
      const far = (q && q.params ? q.params.fogFar : WORLD.fog.far) * finiteOr(d.fog.farScale, 1);
      try { env.setFog(d.fog.near, far, s); } catch (_) { /* best effort */ }
    }
    this.dirty = true;
  }

  /** The target district (DISTRICTS[0] until the first setDistrict). */
  get district() { return this._dTarget; }
  /** Eased title idle-rig weight (0 in gameplay, 1 on the title rig; tweened with the camera). Environment's title-rig
   *  lamp clearance reads it (round-5 art review). */
  get titleBlend() { return ease.inOutCubic(this._idleBlend); }

  /** The district's bloom strength right now (mid-fade value during a cross-fade); setBloomStrength() restores it. */
  get bloomBase() { return this._cur[DS_BLOOM_S]; }

  /** One cross-fade frame: _cur = lerp(from, to, inOutCubic(k)), the light offset as a normalized lerp (direction nlerped,
   *  length lerped), then every consumer. Snaps exactly to the target at k = 1. Allocation-free. */
  _stepDistrictFade(now) {
    const cur = this._cur, from = this._dFrom, to = this._dTo;
    const t = this._fadeDur > 0 ? (now - this._fadeT0) / this._fadeDur : 1;
    if (t >= 1) {
      this._fadeOn = false;
      cur.set(to);
    } else {
      const k = ease.inOutCubic(t > 0 ? t : 0);
      for (let i = 0; i < DS_N; i++) cur[i] = from[i] + (to[i] - from[i]) * k;
      const o = DS_SUN_OFF;
      const ax = from[o], ay = from[o + 1], az = from[o + 2], bx = to[o], by = to[o + 1], bz = to[o + 2];
      const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
      const dx = ax / la + (bx / lb - ax / la) * k, dy = ay / la + (by / lb - ay / la) * k, dz = az / la + (bz / lb - az / la) * k;
      const s = (la + (lb - la) * k) / (Math.hypot(dx, dy, dz) || 1);
      cur[o] = dx * s; cur[o + 1] = dy * s; cur[o + 2] = dz * s;
    }
    this._applyDistrictState(false);
  }

  /** Writes _cur into every consumer (snap: the bloom strength is reset to the base even when held this frame — a snap is
   *  a level start / title reset; on a fade frame a finite setBloomStrength of this frame wins, docs/DISTRICTS.md §6.1). */
  _applyDistrictState(snap) {
    const c = this._cur;
    const L = this.lights;
    if (L.sun) {
      L.sun.color.setRGB(c[DS_SUN_COL], c[DS_SUN_COL + 1], c[DS_SUN_COL + 2]);
      if (L.sun.intensity !== c[DS_SUN_I]) L.sun.intensity = c[DS_SUN_I];
    }
    this._baseOffX = c[DS_SUN_OFF]; this._baseOffY = c[DS_SUN_OFF + 1]; this._baseOffZ = c[DS_SUN_OFF + 2];
    this._updateShadowBox();
    this._setSunAzimuth(this._sunAz);                         // new base offset under the current title swing
    if (L.hemi) {
      L.hemi.color.setRGB(c[DS_HEMI_SKY], c[DS_HEMI_SKY + 1], c[DS_HEMI_SKY + 2]);
      L.hemi.groundColor.setRGB(c[DS_HEMI_GND], c[DS_HEMI_GND + 1], c[DS_HEMI_GND + 2]);
    }
    this._updateTitleLight();                                 // hemisphere intensity + swing from _cur (same frame)
    const fog = this.scene ? this.scene.fog : null;
    const r = this.renderer;
    if (fog) {
      fog.color.setRGB(c[DS_FOG], c[DS_FOG + 1], c[DS_FOG + 2]);
      if (r) r.setClearColor(fog.color, 1);
    }
    if (r && r.toneMappingExposure !== c[DS_EXPOSURE]) r.toneMappingExposure = c[DS_EXPOSURE];
    const frame = this.ctx.time ? this.ctx.time.frame : -2;
    if (snap || this._bloomHold !== frame) {
      this._bloomStrength = c[DS_BLOOM_S];
      if (this.bloomPass) this.bloomPass.strength = c[DS_BLOOM_S];
      if (snap) this._bloomHold = -1;
    }
    if (this.bloomPass && this.bloomPass.radius !== c[DS_BLOOM_R]) this.bloomPass.radius = c[DS_BLOOM_R];
    const gp = this.gradePass;
    if (gp) {
      const u = gp.uniforms;
      u.uShadowTint.value.setRGB(c[DS_SH_TINT], c[DS_SH_TINT + 1], c[DS_SH_TINT + 2]);
      setScalar(u.uShadowMix, c[DS_SH_MIX]); setScalar(u.uShadowLuma, c[DS_SH_LUMA]);
      u.uHighTint.value.setRGB(c[DS_HI_TINT], c[DS_HI_TINT + 1], c[DS_HI_TINT + 2]);
      setScalar(u.uHighMix, c[DS_HI_MIX]); setScalar(u.uHighLuma, c[DS_HI_LUMA]);
      setScalar(u.uSat, c[DS_SAT]); setScalar(u.uVignette, c[DS_VIG]); setScalar(u.uVigA, c[DS_VIG_A]); setScalar(u.uVigB, c[DS_VIG_B]);
    }
    const rb = this._roadBgUniform();
    if (rb) rb.value.setRGB(c[DS_ROAD], c[DS_ROAD + 1], c[DS_ROAD + 2]);
    this._applyEyeGlow();
    if (snap) this._updateSun(this.ctx.world ? this.ctx.world.squadX : 0);   // light placed before the next draw
    this.dirty = true;
  }

  /** materials.gatePanel().uniforms.uRoadBg (the panel's near-background estimate), cached once found. */
  _roadBgUniform() {
    if (this._roadBgU) return this._roadBgU;
    const m = this.materials;
    if (!m || typeof m.gatePanel !== 'function') return null;
    try {
      const mat = m.gatePanel();
      const u = mat && mat.uniforms ? mat.uniforms.uRoadBg : null;
      if (u && u.value && u.value.isColor) this._roadBgU = u;
    } catch (_) { /* gate panel not available: nothing to tint */ }
    return this._roadBgU;
  }

  /** models.setEyeGlow(_cur eye emissive) once models exists (guarded; written only when the value changes). */
  _applyEyeGlow() {
    const v = this._cur[DS_EYES];
    if (v === this._eyeApplied) return;
    const m = this.ctx.models;
    if (!m || typeof m.setEyeGlow !== 'function') return;
    this._eyeApplied = v;
    try { m.setEyeGlow(v); } catch (err) { warnOnce('render.eyeGlow', 'models.setEyeGlow failed: ' + (err && err.message)); }
  }

  /** Shadow box bottom = RENDER.sun.frustum.b × max(1, yz / yz₁) from the UN-swung district offset (the title swing leaves
   *  it unchanged), so shadows reach z ≈ −23 on the road in every district (docs/DISTRICTS.md §6.1); then the texel size. */
  _updateShadowBox() {
    const sun = this.lights.sun;
    if (!sun) return;
    const yz = lightYz(this._baseOffX, this._baseOffY, this._baseOffZ);
    const b = RENDER.sun.frustum.b * Math.max(1, yz / this._yz1);
    const sc = sun.shadow.camera;
    if (sc.bottom !== b) { sc.bottom = b; sc.updateProjectionMatrix(); }
    this._updateTexelSize();
  }

  /** VIS-15: on the title rig (eased with the camera, so it is fully restored when level:start turns the idle camera off)
   *  the hemisphere fill rises to the district's hemi.title and the sun swings its sun.titleAzimuthDeg about +Y toward the
   *  camera side, so the squad's backs are lit; uniforms only (no light is created / removed, no program changes). Round 5:
   *  reads the district mirror `_cur` (District 1 = RENDER.hemi.intensity / RENDER.title). */
  _updateTitleLight() {
    const hemi = this.lights.hemi;
    if (!hemi) return;
    const c = this._cur;
    const it = ease.inOutCubic(this._idleBlend);
    hemi.intensity = lerp(c[DS_HEMI_I], c[DS_HEMI_TITLE], it);
    const az = c[DS_SUN_TAZ] * DEG * it;
    if (az !== this._sunAz) this._setSunAzimuth(az);
  }

  /** Rotates the district light offset (_baseOff, = RENDER.sun.offset in District 1) by `az` (rad) about +Y into _sunOff
   *  and rebuilds the light-space basis used for texel snapping (same construction as Object3D.lookAt for a camera at the
   *  offset looking at the origin, up = +Y). */
  _setSunAzimuth(az) {
    this._sunAz = az;
    const c = Math.cos(az), s = Math.sin(az);
    const bx = this._baseOffX, bz = this._baseOffZ;
    const ox = bx * c + bz * s, oy = this._baseOffY, oz = -bx * s + bz * c;
    this._sunOffX = ox; this._sunOffY = oy; this._sunOffZ = oz;
    const ol = Math.hypot(ox, oy, oz) || 1;
    const zx = ox / ol, zy = oy / ol, zz = oz / ol;           // camera z axis (toward the light)
    let xx = zz, xy = 0, xz = -zx;                            // up × z
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    this._lxX = xx; this._lxY = xy; this._lxZ = xz;
    this._lyX = zy * xz - zz * xy; this._lyY = zz * xx - zx * xz; this._lyZ = zx * xy - zy * xx;   // z × x
  }

  /** composer.render() or renderer.render(); samples renderer.info.render.calls into callStats
   *  (shadow = before the first main draw, main = until the end of the RenderPass, post = the rest). */
  draw() {
    const r = this.renderer;
    if (!r) return;
    // r7 (perf-render:1): a new render scale re-allocates the canvas HERE, so the cleared buffer is filled by this same
    // draw (no blank frame between the re-allocation and the next rAF)
    if (this._scalePending) {
      this._scalePending = false;
      if (this.size.w > 0 && this.size.h > 0) this._applySize(this.size.w, this.size.h, false);
    }
    this._sizeDirty = false;
    this._flushBlobs();
    const info = r.info.render;
    const c0 = info.calls;
    this._mainStart = -1;
    let afterMain;
    let overlay = 0;
    if (this.composer && this._composerOn) {
      this.renderPass.callsAfter = c0;
      if (this.overlayPass) this.overlayPass.calls = 0;
      this.composer.render(this.ctx.time ? this.ctx.time.unscaledDt : 0);
      afterMain = this.renderPass.callsAfter;
      overlay = this.overlayPass ? this.overlayPass.calls : 0;   // post-bloom scene draws count as main (§9.1 budget)
    } else {
      // Low (no composer): the overlay layer draws in the one scene render (renderOrder keeps it last)
      const cam = this.camera;
      cam.layers.enable(OVERLAY_LAYER);
      r.render(this.scene, cam);
      cam.layers.disable(OVERLAY_LAYER);
      afterMain = info.calls;
    }
    if (this._staleBloom && (!this.composer || this._composerOn)) { this._staleBloom.dispose(); this._staleBloom = null; }
    const total = info.calls;
    const shadow = this._mainStart >= 0 ? this._mainStart - c0 : 0;
    const s = this.callStats;
    s.shadow = shadow;
    s.main = afterMain - c0 - shadow + overlay;
    s.post = total - afterMain - overlay;
    s.total = total - c0;
    if (++this._matTick >= MAT_SAMPLE_FRAMES) {
      this._matTick = 0;
      this._matStamp++;
      this._matCount = 0;
      this.scene.traverseVisible(this._countMat);
      s.materials = this._matCount;
    }
    this.dirty = false;
  }

  /** Counts a material once per sample (a stamp in _matStamps at Material.id; no allocation, materials untouched). */
  _stampMat(m) {
    if (!m) return;
    const id = m.id | 0;
    let st = this._matStamps;
    if (id >= st.length) {                     // rare: grow to the next power of two above the id
      let n = st.length;
      while (n <= id) n *= 2;
      const grown = new Int32Array(n);
      grown.set(st);
      this._matStamps = st = grown;
    }
    if (st[id] === this._matStamp) return;
    st[id] = this._matStamp;
    this._matCount++;
  }

  // -------------------------------------------------------------------------------------------
  // Size (§9.5)
  // -------------------------------------------------------------------------------------------

  /** Size from #app, DPR cap + pixel cap, renderer + composer sizes in place, camera aspect / preset,
   *  uAspect, ui.refit(). The `resize` EVENT is emitted by engine right after this call (§5.1, engine
   *  report): render never emits it, so it fires exactly once. */
  resize() {
    if (!this.renderer) return;
    const ctx = this.ctx;
    let w = 0, h = 0;
    const app = ctx.app;
    if (app) { w = app.clientWidth | 0; h = app.clientHeight | 0; }
    if (!(w > 0) || !(h > 0)) {
      try { if (typeof window !== 'undefined') { w = window.innerWidth | 0; h = window.innerHeight | 0; } } catch (_) { w = 0; h = 0; }
    }
    if (!(w > 0) || !(h > 0)) { w = JUICE.ui.refBox[0]; h = JUICE.ui.refBox[1]; }
    // r7 (perf-render:6): no forced re-allocation — the trailing resize of every burst (and a zoom step whose CSS box did
    // not change) used to re-allocate, i.e. clear, an unchanged canvas; only a real size / DPR change does now
    this._applySize(w, h, false);
    const ui = ctx.ui;
    if (ui && typeof ui.refit === 'function') {
      try { ui.refit(); } catch (_) { /* ignore */ }
    }
    if (this._sizeDirty) this.dirty = true;
  }

  /**
   * r7 (perf-render:1): sets the render scale (ctx.quality.renderScale, the QUALITY_TIERS.renderScale.ladder rung engine's
   * auto-scaler chose; 1 = off) — applied at the start of the next draw(), which re-allocates the canvas and fills it in
   * the same task, so no blank frame shows.
   */
  setRenderScale(s) {
    const q = this.ctx.quality;
    if (q && s > 0) q.renderScale = s;
    this._scalePending = true;
    this.dirty = true;
  }

  /** DPR = max(1, min(devicePixelRatio, params.dpr, √(pixelCap / (w·h)))) (§9.5) × the render scale (r7 perf-render:1:
   *  ctx.quality.renderScale, floored so the backing store stays ≥ QUALITY_TIERS.renderScale.minBackingPx tall);
   *  renderer.setSize only when something changed (it clears the drawing buffer: _sizeDirty until the next draw);
   *  composer.setPixelRatio BEFORE setSize. */
  _applySize(w, h, force) {
    const r = this.renderer;
    const q = this.ctx.quality;
    const params = q && q.params ? q.params : QUALITY_TIERS.med;
    const cap = Math.sqrt(QUALITY_TIERS.pixelCap / Math.max(1, w * h));
    const base = Math.max(1, Math.min(devicePixelRatio(), params.dpr, cap));
    const rs = q && q.renderScale > 0 && q.renderScale < 1 ? q.renderScale : 1;
    let dpr = base;
    if (rs < 1) {
      const floor = RS_MIN_BACKING_PX / (h * base);                // the scale that keeps the backing RS_MIN_BACKING_PX tall
      dpr = base * Math.max(rs, Math.min(1, floor));
    }
    const size = this.size;
    const changed = force || dpr !== size.dpr || w !== size.w || h !== size.h;
    if (changed) {
      r.setPixelRatio(dpr);
      r.setSize(w, h, false);                                  // CSS size stays 100 % (game.css)
      this._sizeDirty = true;                                  // r7: the drawing buffer is cleared until the next draw
    }
    if (this.composer) {
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);                             // resizes targets + bloom mips in place
    }
    size.w = w; size.h = h; size.dpr = dpr;
    const aspect = w / h;
    size.portrait = aspect < WORLD.camera.portraitBelow;
    if (q) q.dpr = dpr;
    const C = WORLD.camera;
    this._fovP = verticalFov(C.hFovDeg.portrait, aspect, C.fovClamp.portrait);
    this._fovL = verticalFov(C.hFovDeg.landscape, aspect, C.fovClamp.landscape);
    if (this._presetSnap) { this._presetBlend = size.portrait ? 0 : 1; this._presetSnap = false; }
    const cam = this.camera;
    if (cam) {
      cam.aspect = aspect;
      cam.fov = lerp(this._fovP, this._fovL, ease.inOutCubic(this._presetBlend));
      cam.updateProjectionMatrix();
    }
    if (this.gradePass) this.gradePass.uniforms.uAspect.value = aspect;
  }

  // -------------------------------------------------------------------------------------------
  // Quality (§9.3 / §9.4): the ONLY place render targets and passes are (re)created
  // -------------------------------------------------------------------------------------------

  /** Shadows (castShadow, type, map size), bloom pass, MSAA samples, fog far, anisotropy, blob shadows,
   *  DPR; then lets the material library / environment apply their tier-dependent parts. Idempotent:
   *  only what changed is rebuilt, and old targets / passes are disposed before new ones are built.
   *
   *  VIS-1: after init, a change that would switch shader programs (sun.castShadow, shadowMap.type, composer
   *  on/off — every material's program key) is NOT applied in this frame: cheap state (DPR, fog far,
   *  anisotropy, collaborators' uniforms) applies at once, the program-affecting switch is prepared off the
   *  frame (_requestTier: the scene + pass materials compile for the target state through compileAsync /
   *  KHR_parallel_shader_compile while the old tier keeps drawing) and committed when the programs are linked
   *  (fallback TIER_COMMIT_FALLBACK_MS), followed by warmup() for the shadow-depth variants. */
  applyQuality(params) {
    const r = this.renderer;
    if (!r) return;
    const q = this.ctx.quality;
    const p = params || (q ? q.params : QUALITY_TIERS.med);

    // program-affecting state: immediate at init (boot draws nothing yet), deferred afterwards
    if (!this._inited) this._applyTierState(p);
    else this._requestTier(p);

    // fog far: the environment owns near / far (its applyQuality, below, writes params.fogFar × the district's farScale,
    // into a running lerp's target — round 5: the old env.setFog(near, far, 0) here cancelled a run-up / district fog lerp
    // mid-way and dropped farScale); render writes it only while no environment exists (init)
    const fog = this.scene.fog;
    if (!(this.env && typeof this.env.applyQuality === 'function')) fog.far = p.fogFar * finiteOr(this._dTarget.fog.farScale, 1);

    // anisotropy (road by tier; the digit atlas keeps its fixed 4)
    if (this.textures) this.textures.setRoadAnisotropy(Math.max(1, Math.min(p.anisotropy, this._maxAniso)));

    // DPR cap depends on the tier
    if (this.size.w > 0 && this.size.h > 0) this._applySize(this.size.w, this.size.h, false);

    // collaborators' tier-dependent parts (gate-frame Low emissive boost, prop density, dust, smoke)
    const m = this.materials;
    if (m && typeof m.applyQuality === 'function') {
      try { m.applyQuality(p); } catch (err) { warnOnce('render.matQuality', 'materials.applyQuality failed: ' + (err && err.message)); }
    }
    const env = this.env;
    if (env && typeof env.applyQuality === 'function') {
      try { env.applyQuality(p); } catch (err) { warnOnce('render.envQuality', 'env.applyQuality failed: ' + (err && err.message)); }
    }
    this.dirty = true;
  }

  /** Shadow-map type constant of a tier (PCF on High and Medium since VIS-1: QUALITY_TIERS.high.shadowType). */
  static _shadowTypeOf(p) { return p.shadowType === 'pcfsoft' ? PCFSoftShadowMap : PCFShadowMap; }

  /** Everything of a tier that is part of a shader program key: shadows on/off, shadow type, composer on/off. */
  static _programKey(p) {
    return (p.shadows ? 's' + RenderSystem._shadowTypeOf(p) : 'n') + (p.bloom === 'off' ? '|c0' : '|c1');
  }

  /** Applies the program-affecting tier state NOW: shadows (castShadow, type, map size, radius), blob shadows,
   *  composer / bloom / MSAA. Used at init, for changes that keep every program key (High ⇄ Medium), and to
   *  commit a prepared change. */
  _applyTierState(p) {
    const r = this.renderer;
    const sun = this.lights.sun;
    sun.castShadow = !!p.shadows;              // shadowMap.enabled never changes (§9.3)
    if (p.shadows) {
      const type = RenderSystem._shadowTypeOf(p);
      if (r.shadowMap.type !== type) {
        r.shadowMap.type = type;
        r.shadowMap.needsUpdate = true;
        const m = this.materials;
        if (m && typeof m.markAllNeedsUpdate === 'function') {
          try { m.markAllNeedsUpdate(); } catch (err) { warnOnce('render.markAll', 'materials.markAllNeedsUpdate failed: ' + (err && err.message)); }
        }
      }
      this._shadowType = type;
      // PCF everywhere; the filter radius scales with the map size so High (2048) keeps Medium's world-space softness
      sun.shadow.radius = type === PCFShadowMap ? RENDER.sun.shadowRadiusPcf * Math.max(1, p.shadowMap / QUALITY_TIERS.med.shadowMap) : 1;
      const n = p.shadowMap;
      if (n > 0 && sun.shadow.mapSize.x !== n) {
        sun.shadow.mapSize.set(n, n);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }   // a live map ignores a size change
      }
    }
    this._updateTexelSize();
    this._setBlobActive(!p.shadows);           // blob shadows replace shadow maps on Low (switched with castShadow)
    this._configureComposer(p, true);
    if (this.size.w > 0 && this.size.h > 0) this._applySize(this.size.w, this.size.h, false);
    this._committedKey = RenderSystem._programKey(p);
    this._committedParams = p;
    this.dirty = true;
  }

  /** VIS-1: a tier change after init. Same program key → applied at once (no program changes). Otherwise the
   *  target state is compiled off the frame and committed when ready; a newer request supersedes an older one. */
  _requestTier(p) {
    const key = RenderSystem._programKey(p);
    if (key === this._committedKey) {
      this._cancelPendingTier();
      this._applyTierState(p);
      return;
    }
    const pend = this._pendingTier;
    if (pend && pend.key === key) { pend.params = p; return; }    // already preparing this program state
    this._cancelPendingTier();
    const token = ++this._tierToken;
    this._pendingTier = { key, params: p, token };
    let prep;
    try { prep = this._prepareTier(p); } catch (err) {
      warnOnce('render.tierPrep', 'tier pre-compile failed: ' + (err && err.message ? err.message : String(err)));
      prep = null;
    }
    const commit = () => { if (this._pendingTier && this._pendingTier.token === token) this._commitPendingTier(); };
    if (prep && typeof prep.then === 'function') {
      prep.then(commit, (err) => {
        warnOnce('render.tierPrep', 'tier pre-compile failed: ' + (err && err.message ? err.message : String(err)));
        commit();
      });
    } else {
      commit();
    }
    if (this._pendingTier && this._pendingTier.token === token && typeof setTimeout === 'function') {
      this._tierTimer = setTimeout(commit, TIER_COMMIT_FALLBACK_MS);
    }
  }

  _cancelPendingTier() {
    if (this._tierTimer) { try { clearTimeout(this._tierTimer); } catch (_) { /* ignore */ } this._tierTimer = 0; }
    this._pendingTier = null;
    this._tierToken++;
  }

  _commitPendingTier() {
    const pend = this._pendingTier;
    if (!pend || !this.renderer) return;
    this._cancelPendingTier();
    this._applyTierState(pend.params);
    // three renders the shadow maps BEFORE it sets up the frame's lights, so the first shadow pass after a switch
    // would still see the old light state (no shadow) and link stale-keyed depth programs; an object-less compile()
    // against the scene refreshes that light state now
    try { if (!this._emptyScene) this._emptyScene = new Scene(); this.renderer.compile(this._emptyScene, this.camera, this.scene); } catch (_) { /* best effort */ }
    // every program of the new state (main pass, shadow-depth twins, pass materials) was compiled and linked by
    // _compileChunked; the driver's first-draw work for content hidden right now (pickups, troops, boss) is
    // absorbed a few objects per frame, out of sight (VIS-2), instead of in one heavy warm-up frame
    this._warmHiddenChunked();
  }

  /** Draws every currently hidden renderable once in the committed tier state, WARM_CHUNK objects per frame, through a
   *  camera that sees only WARM_LAYER (lights carry that layer too, so program keys match): into the 1×1 warm target
   *  on composer tiers, into a 1×1 scissored corner of the canvas on Low (overdrawn by the next frame). Every touched
   *  visible / frustumCulled / count / layer value is restored right after each chunk. */
  _warmHiddenChunked() {
    if (!this.renderer || !this.scene) return;
    const shown = new Set();
    this.scene.traverseVisible((o) => { shown.add(o); });
    const list = [];
    this.scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || !o.material) return;
      if (!shown.has(o) || (o.isInstancedMesh && !(o.count > 0))) list.push(o);
    });
    if (list.length > 0) this._warmDrawChunked(list, 0, null);
  }

  /** Draws every object of `list` once in the committed tier state, out of sight, a WARM_CHUNK of objects at a time
   *  (one chunk per frame when budgetMs is 0, else chunks until budgetMs of the frame is spent): through a camera that
   *  sees only WARM_LAYER (lights carry that layer too, so program keys match; the shadow pass draws the chunk's
   *  casters), into the 1×1 warm target on composer tiers, into a 1×1 scissored corner of the canvas on Low (overdrawn
   *  by the next frame). Every touched visible / frustumCulled / count / layer value is restored right after each chunk.
   *  Resolves when the list is done or a newer run supersedes this one; onProgress(0..1) after each frame. Allocates
   *  (boot / tier change / context restore only). */
  _warmDrawChunked(list, budgetMs, onProgress) {
    const token = ++this._warmChunkToken;
    let idx = 0;
    return new Promise((resolve) => {
      const step = () => {
        if (token !== this._warmChunkToken || !this.renderer) { resolve(); return; }
        const r = this.renderer;
        if (!this._warmCam) this._warmCam = new PerspectiveCamera();
        const cam = this._warmCam;
        cam.copy(this.camera, false);
        cam.layers.set(WARM_LAYER);
        const t0 = performance.now();
        do {
          const saved = [];
          const end = Math.min(list.length, idx + WARM_CHUNK);
          for (; idx < end; idx++) {
            // an entry is a renderable, or (round 5) a { mesh, geometry } pair: the mesh drawn once with that geometry
            // temporarily assigned (env.districtWarmList: every prop slot × every alternative district kind)
            const it = list[idx];
            const pair = !!(it && !it.isObject3D && it.mesh && it.geometry && it.geometry.isBufferGeometry);
            const o = pair ? it.mesh : it;
            if (!o || !o.isObject3D) continue;
            saved.push(o, o.visible, o.frustumCulled, o.isInstancedMesh ? o.count : -1, o.layers.mask, pair ? o.geometry : null);
            if (pair) o.geometry = it.geometry;
            o.visible = true; o.frustumCulled = false; o.layers.enable(WARM_LAYER);
            if (o.isInstancedMesh && !(o.count > 0)) o.count = 1;
            for (let p = o.parent; p; p = p.parent) { if (!p.visible) { saved.push(p, false, p.frustumCulled, -1, p.layers.mask, null); p.visible = true; } }
          }
          const prevRT = r.getRenderTarget();
          const toCanvas = !(this.composer && this._composerOn);
          const vp = this._warmVp, sc = this._warmSc;
          const scTest = r.getScissorTest();
          r.getViewport(vp); r.getScissor(sc);
          try {
            r.setRenderTarget(toCanvas ? null : this._getWarmTarget());
            if (toCanvas) { r.setViewport(0, 0, 1, 1); r.setScissor(0, 0, 1, 1); r.setScissorTest(true); }
            r.render(this.scene, cam);
          } catch (err) {
            warnOnce('render.warmChunk', 'warm-up draw failed: ' + (err && err.message ? err.message : String(err)));
          } finally {
            if (toCanvas) { r.setScissorTest(scTest); r.setScissor(sc); r.setViewport(vp); }
            r.setRenderTarget(prevRT);
            for (let i = saved.length - 6; i >= 0; i -= 6) {
              const o = saved[i];
              o.visible = saved[i + 1]; o.frustumCulled = saved[i + 2];
              if (saved[i + 3] >= 0) o.count = saved[i + 3];
              o.layers.mask = saved[i + 4];
              if (saved[i + 5]) o.geometry = saved[i + 5];
            }
          }
        } while (idx < list.length && budgetMs > 0 && performance.now() - t0 < budgetMs);
        this.dirty = true;
        if (typeof onProgress === 'function') { try { onProgress(list.length > 0 ? idx / list.length : 1); } catch (_) { /* cosmetic */ } }
        if (idx < list.length) nextFrame(step); else resolve();
      };
      nextFrame(step);
    });
  }

  /** Compiles the scene (and the composer's pass materials) for tier `p` WITHOUT switching to it: the renderer /
   *  light state is swapped to the target for the synchronous part of compileAsync and restored in the same
   *  call, so the old tier keeps drawing until the returned promise resolves. A composer the target needs is
   *  built now but stays inactive (draw() ignores it) until the commit. */
  _prepareTier(p) {
    const toComposer = p.bloom !== 'off';
    if (toComposer) this._configureComposer(p, false);
    return this._compileChunked(p, toComposer);
  }

  /**
   * VIS-1: compiles every program tier `p` needs, a few per frame. Each work item is one scene object (its
   * material, or the shadow-depth material the shadow pass would pick for it) or one composer pass material; it is
   * compiled through a plain stand-in (COMPILE_STAND, carrying every per-object program flag — instancing,
   * instanceColor, skinning, geometry — of the object; never a prototype-linked proxy) with the renderer / sun state swapped to the target for the
   * synchronous compile() call and restored right after, so the old tier keeps drawing. A frame stops after
   * TIER_COMPILE.newPerFrame new programs or TIER_COMPILE.budgetMs of work (shader translation runs on the GPU
   * process and stalls its next frame, so it is spread). Without KHR_parallel_shader_compile each new program is
   * linked inside its own chunk (the stall is spread too). Resolves when every new program reports ready.
   */
  _compileChunked(p, toComposer, limits, onProgress) {
    const L = limits || TIER_COMPILE;
    const report = (f) => { if (typeof onProgress === 'function') { try { onProgress(f); } catch (_) { /* cosmetic */ } } };
    const r = this.renderer;
    const items = [];                        // [object, materialOverride|null, kind] triples (kind: 0 main, 1 depth, 2 pass, 3 screen)
    this.scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || !o.material) return;
      items.push(o, null, 0);
      // a mesh with a customDepthMaterial (character pools) casts on every shadow tier, but zombies / troops flip
      // castShadow in their own quality:change listeners, which run after this gather (render subscribes first):
      // coming from Low their charDepth.* programs would otherwise link on the first shadow frame
      if (p.shadows && (o.castShadow || o.customDepthMaterial !== undefined) && (o.isMesh || o.isPoints || o.isLine)) {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        let dm = null;
        if (o.customDepthMaterial !== undefined) {
          // the shadow pass copies these onto a custom depth material before drawing (WebGLShadowMap.getDepthMaterial)
          dm = o.customDepthMaterial;
          if (dm && m) {
            dm.side = m.shadowSide !== null && m.shadowSide !== undefined ? m.shadowSide : SHADOW_SIDE[m.side];
            dm.alphaMap = m.alphaMap || null; dm.alphaTest = m.alphaTest || 0; dm.map = m.map || null;
            dm.wireframe = !!m.wireframe; dm.displacementMap = m.displacementMap || null;
          }
        } else {
          dm = this._depthProbe(m);
        }
        if (dm) items.push(o, dm, 1);
      }
    });
    if (toComposer && this.composer) {
      const ps = this._passScenes();
      for (let i = 0; i < ps.off.children.length; i++) items.push(ps.off.children[i], null, 2);
      for (let i = 0; i < ps.screen.children.length; i++) items.push(ps.screen.children[i], null, 3);
    }
    const khr = !!r.extensions.get('KHR_parallel_shader_compile');
    const known = new Set(r.info.programs);
    const fresh = [];
    const tmp = new Scene();
    let idx = 0;
    const self = this;
    const step = (resolve) => {
      if (!self.renderer) { resolve(); return; }
      const t0 = performance.now();
      let made = 0;
      const sun = self.lights.sun;
      const prevCast = sun.castShadow, prevType = r.shadowMap.type, prevRT = r.getRenderTarget();
      try {
        sun.castShadow = !!p.shadows;
        if (p.shadows) r.shadowMap.type = RenderSystem._shadowTypeOf(p);
        while (idx < items.length && made < L.newPerFrame && performance.now() - t0 < L.budgetMs) {
          const o = items[idx], over = items[idx + 1], kind = items[idx + 2];
          idx += 3;
          r.setRenderTarget(kind === 3 || (kind === 0 && !toComposer) ? null : self._getWarmTarget());
          const px = compileStandIn(o, over, tmp);
          tmp.children.length = 0; tmp.children.push(px);
          // pass quads render outside the scene (FullScreenQuad: no lights, no fog) → compile them light-less; the shadow
          // pass draws with a fog-less scene (scene fog is part of every program key) → fog is hidden for depth items
          const fog = self.scene.fog;
          if (kind === 1) self.scene.fog = null;
          try { r.compile(tmp, self.camera, kind >= 2 ? tmp : self.scene); } catch (err) {
            warnOnce('render.tierCompile', 'tier pre-compile item failed: ' + (err && err.message ? err.message : String(err)));
          } finally { self.scene.fog = fog; }
          const progs = r.info.programs;
          for (let i = progs.length - 1; i >= 0 && !known.has(progs[i]); i--) {
            known.add(progs[i]); fresh.push(progs[i]); made++;
            if (!khr) { try { progs[i].getUniforms(); } catch (_) { /* link errors surface on first use */ } }
          }
        }
      } finally {
        tmp.children.length = 0;
        COMPILE_STAND.material = null; COMPILE_STAND.geometry = null; COMPILE_STAND.parent = null;   // hold no scene refs
        sun.castShadow = prevCast;
        r.shadowMap.type = prevType;
        r.setRenderTarget(prevRT);
      }
      report(items.length > 0 ? COMPILE_ISSUE_SHARE * idx / items.length : COMPILE_ISSUE_SHARE);
      if (idx < items.length) { nextFrame(() => step(resolve)); return; }
      // every item issued: wait for the parallel compiles / links to finish (poll without blocking), and resolve each
      // linked program's uniform / attribute tables a few per tick (synchronous GL queries three would otherwise run
      // for all of them in the first frame after the commit)
      let touched = 0;
      const poll = () => {
        if (!self.renderer) { resolve(); return; }
        let n = 0;
        const tp = performance.now();
        // round-3 boot polish: also bounded by L.budgetMs (at least one program per tick) — each first getUniforms()
        // is a synchronous GPU round trip (+ the info-log reads under ?debug=1), and 8 of them in one tick froze the
        // boot bar for ≈ 0.3 s at 4× CPU throttling
        while (touched < fresh.length && n < L.touchPerTick && (n === 0 || performance.now() - tp < L.budgetMs)) {
          const prog = fresh[touched];
          let ready = true;
          try { ready = prog.isReady(); } catch (_) { ready = true; }
          if (!ready) break;
          try { prog.getUniforms(); prog.getAttributes(); } catch (_) { /* errors surface on first use */ }
          touched++; n++;
        }
        report(COMPILE_ISSUE_SHARE + (1 - COMPILE_ISSUE_SHARE) * (fresh.length > 0 ? touched / fresh.length : 1));
        if (touched >= fresh.length) resolve(); else setTimeout(poll, L.pollMs);
      };
      poll();
    };
    return new Promise((resolve) => step(resolve));
  }

  /** A MeshDepthMaterial with the program-relevant state WebGLShadowMap.getDepthMaterial copies from `m` (side via
   *  the shadow-side swap, map / alphaMap / alphaTest, wireframe), cached per combination; it only serves as a
   *  compile key twin of the shadow pass's internal depth material (the program is shared through the cache key). */
  _depthProbe(m) {
    if (!m) return null;
    const side = m.shadowSide !== null && m.shadowSide !== undefined ? m.shadowSide : SHADOW_SIDE[m.side];
    const key = side + '|' + (m.map ? 1 : 0) + (m.alphaMap ? 1 : 0) + (m.alphaTest > 0 ? 1 : 0) + (m.wireframe ? 1 : 0)
      + (m.displacementMap ? 1 : 0);
    let d = this._depthProbes.get(key);
    if (!d) {
      d = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
      d.side = side;
      d.map = m.map || null; d.alphaMap = m.alphaMap || null; d.alphaTest = m.alphaTest || 0;
      d.wireframe = !!m.wireframe; d.displacementMap = m.displacementMap || null;
      this._depthProbes.set(key, d);
    }
    return d;
  }

  /** 1×1 offscreen target used only to give compile() / the warm-up the composer path's program keys. */
  _getWarmTarget() {
    if (!this._warmTarget) {
      this._warmTarget = new WebGLRenderTarget(1, 1, { type: this._halfFloatOk ? HalfFloatType : UnsignedByteType, depthBuffer: true, stencilBuffer: false });
      this._warmTarget.texture.name = 'GateRush.warm';
    }
    return this._warmTarget;
  }

  /** Two throwaway scenes of quads carrying the composer's pass materials (offscreen passes / the grade pass,
   *  which renders to the canvas) so compileAsync can compile them before the composer is first used. */
  _passScenes() {
    const off = new Scene(), screen = new Scene();
    if (!this._passGeo) this._passGeo = new PlaneGeometry(2, 2);
    const add = (sc, mat) => { if (mat) { const q = new Mesh(this._passGeo, mat); q.frustumCulled = false; sc.add(q); } };
    const b = this.bloomPass;
    if (b) {
      add(off, b.materialHighPassFilter);
      for (let i = 0; i < b.separableBlurMaterials.length; i++) add(off, b.separableBlurMaterials[i]);
      add(off, b.compositeMaterial);
      add(off, b.blendMaterial);
    }
    if (this.composer && this.composer.copyPass) add(off, this.composer.copyPass.material);
    if (this.gradePass) {
      this.gradePass.prime(this.renderer);
      add(screen, this.gradePass.material);
    }
    return { off, screen };
  }

  /** Composer for High / Medium (bloom 'half' / 'quarter'), none on Low (direct render, §9.4). Targets are
   *  recreated only when the MSAA sample count changes; the bloom pass only when the bloom mode changes.
   *  activate = false builds / updates the composer without letting draw() use it (VIS-1 prepare). */
  _configureComposer(p, activate) {
    if (p.bloom === 'off') {                    // Low tier
      if (activate) this._disposeComposer();
      return;
    }
    const r = this.renderer;
    const samples = this._samplesFor(p);
    let relink = false;
    if (!this.composer || this._composerSamples !== samples) {
      this._disposeComposer(true);
      const w = Math.max(1, Math.round(Math.max(1, this.size.w) * this.size.dpr));
      const h = Math.max(1, Math.round(Math.max(1, this.size.h) * this.size.dpr));
      const rt = new WebGLRenderTarget(w, h, {
        type: this._halfFloatOk ? HalfFloatType : UnsignedByteType,
        samples, depthBuffer: true, stencilBuffer: false,
      });
      rt.texture.name = 'GateRush.composer';
      this.composer = new EffectComposer(r, rt);
      this._composerSamples = samples;
      relink = true;
    }
    const bloom = this._halfFloatOk ? p.bloom : 'off';     // no float buffers → no bloom for the session
    const mips = Number.isFinite(p.bloomMips) ? p.bloomMips : BLOOM_MIPS_DEFAULT;
    const mode = bloom === 'off' ? 'off' : bloom + ':' + mips;
    if (this._bloomMode !== mode) {
      // the replaced pass is disposed only after the new one has drawn once: its programs stay referenced, so the
      // new pass (same shaders) reuses them instead of recompiling (High ⇄ Medium switches 'half' ⇄ 'quarter')
      if (this.bloomPass) {
        if (this._staleBloom) this._staleBloom.dispose();
        this._staleBloom = this.bloomPass;
        this.bloomPass = null;
      }
      if (bloom !== 'off') {
        const scale = bloom === 'half' ? 1 : 0.5;           // 'half': mip 0 = rt/2; 'quarter': mip 0 = rt/4
        const B = RENDER.bloom;
        const rw = Math.max(2, Math.round(Math.max(1, this.size.w) * this.size.dpr * scale));
        const rh = Math.max(2, Math.round(Math.max(1, this.size.h) * this.size.dpr * scale));
        this.bloomPass = new TierBloomPass(new Vector2(rw, rh), this._bloomStrength, this._cur[DS_BLOOM_R], B.threshold, scale, mips);   // district radius (round 5)
      }
      this._bloomMode = mode;
      relink = true;
    }
    if (relink) {
      const c = this.composer;
      c.passes.length = 0;
      c.addPass(this.renderPass);
      if (this.bloomPass) c.addPass(this.bloomPass);
      if (this.overlayPass) c.addPass(this.overlayPass);    // FX-10 residual: count label after bloom, before the grade
      c.addPass(this.gradePass);
      this.gradePass.uniforms.uDesat.value = this._desat;
    }
    if (activate) this._composerOn = true;
  }

  _samplesFor(p) {
    const want = isIOS ? p.msaaIOS : p.msaa;
    return Math.max(0, Math.min(want | 0, this._maxSamples));
  }

  /** Disposes the composer's targets and the bloom pass (the RenderPass / grade pass are reused). keepPrograms: the
   *  bloom pass is only retired (disposed after the next draw) so a rebuilt pass reuses its programs. */
  _disposeComposer(keepPrograms) {
    if (this.bloomPass) {
      if (keepPrograms) {
        if (this._staleBloom) this._staleBloom.dispose();
        this._staleBloom = this.bloomPass;
      } else {
        this.bloomPass.dispose();
      }
      this.bloomPass = null;
    }
    this._bloomMode = null;
    if (this.composer) {
      const c = this.composer;
      c.passes.length = 0;
      // EffectComposer.dispose() minus the copy pass's fsQuad.dispose() (the shared Pass.js quad geometry, see TierBloomPass)
      c.renderTarget1.dispose();
      c.renderTarget2.dispose();
      if (c.copyPass && c.copyPass.material) c.copyPass.material.dispose();
      this.composer = null;
    }
    this._composerSamples = -1;
    this._composerOn = false;
  }

  /** VIS-21: after a context restore, forgets (never disposes) every GL-backed object render.js owns that was set up in
   *  the lost context — composer + bloom targets, the retired bloom pass, the warm-up target and the sun's shadow map.
   *  dispose() on them would run three's dispose listeners of the LOST context's modules, which delete objects that do
   *  not belong to the new context ("INVALID_OPERATION: delete / deleteVertexArray: object does not belong to this
   *  context"). The RenderPass / grade pass / materials hold no such objects and are reused. */
  _dropLostContextObjects() {
    this.bloomPass = null;
    this._staleBloom = null;
    this._bloomMode = null;
    if (this.composer) this.composer.passes.length = 0;
    this.composer = null;
    this._composerSamples = -1;
    this._composerOn = false;
    this._warmTarget = null;
    const sun = this.lights.sun;
    if (sun && sun.shadow) sun.shadow.map = null;                  // three re-creates it on the next shadow render
  }

  // -------------------------------------------------------------------------------------------
  // Shader warm-up (VIS-2, chunked since round-2 QA VIS-17): compile and draw everything before it is first needed
  // -------------------------------------------------------------------------------------------

  /**
   * Compiles every program the current tier can need (including hidden content: boss rigs, troops, crates, weapon
   * meshes, pickups, and the shadow-depth variants) and draws every renderable once, so nothing links or uploads
   * mid-play, WITHOUT one giant frozen task (VIS-17: the old single compileAsync + all-visible draw froze the boot bar
   * for 0.5 to 1.2 s under CPU throttling):
   *   (1) _compileChunked for the committed state with WARMUP_COMPILE limits (a few programs / ≈ 24 ms per frame,
   *       parallel compile where KHR_parallel_shader_compile exists), progress 0 → WARMUP_SPLIT;
   *   (2) _warmDrawChunked over every renderable (env first, then characters, bosses, gates, pickups, weapons / fx, in
   *       scene order), ≈ WARMUP_DRAW_MS of out-of-sight warm draws per frame (buffers, textures, shadow-depth draws),
   *       progress → 0.97;
   *   (3) one real frame in its own task (composer targets / bloom mips allocate here), progress 1.
   * onProgress(t) (optional, 0..1, monotonic) is what boot maps onto the bar (CORE-9). Never throws (warnOnce); safe
   * to call repeatedly (a call during a run chains one more run). Allocates (boot / context restore only). Awaited by
   * boot (CORE-1 / CORE-9) and after webglcontextrestored (CORE-3).
   */
  warmup(onProgress) {
    if (this._warming) return this._warming.then(() => this.warmup(onProgress));
    const run = this._warmupRun(onProgress).catch((err) => {
      warnOnce('render.warmup', 'shader warm-up failed: ' + (err && err.message ? err.message : String(err)));
    }).then(() => {
      this._warming = null;
      if (typeof onProgress === 'function') { try { onProgress(1); } catch (_) { /* cosmetic */ } }
    });
    this._warming = run;
    return run;
  }

  async _warmupRun(onProgress) {
    let shown = 0;
    const report = (t) => {
      if (typeof onProgress !== 'function' || !(t > shown)) return;
      shown = t;
      try { onProgress(t); } catch (_) { /* cosmetic */ }
    };
    const r = this.renderer;
    if (!r || !this.scene || !this.camera) return;
    const q = this.ctx.quality;
    const p = this._committedParams || (q && q.params) || QUALITY_TIERS.med;
    const toComposer = !!(this.composer && this._composerOn);
    // (1) every program of the committed state, a few per frame
    try {
      await this._compileChunked(p, toComposer, WARMUP_COMPILE, (f) => report(WARMUP_SPLIT * f));
    } catch (err) {
      warnOnce('render.warmupCompile', 'warm-up compile failed: ' + (err && err.message ? err.message : String(err)));
    }
    if (!this.renderer) return;                                // disposed meanwhile
    report(WARMUP_SPLIT);
    // (2) every renderable drawn once, out of sight, in chunks
    const list = [];
    this.scene.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.material) list.push(o); });
    this._appendDistrictWarm(list);                            // round 5: every district prop geometry on its slot mesh
    await this._warmDrawChunked(list, WARMUP_DRAW_MS, (f) => report(WARMUP_SPLIT + (WARMUP_DRAW_END - WARMUP_SPLIT) * f));
    if (!this.renderer) return;
    // (3) the composer's own first use (its full-size targets and bloom mips allocate, the pass programs run once) in a
    // frame of its own, with the scene pass skipped (the boot / restore overlay covers the canvas) ...
    await new Promise((resolve) => nextFrame(resolve));
    if (!this.renderer) return;
    if (this.composer && this._composerOn && this.renderPass) {
      const rp = this.renderPass;
      rp.enabled = false;
      try { this.composer.render(0); } catch (err) {
        warnOnce('render.warmupPost', 'warm-up post pass failed: ' + (err && err.message ? err.message : String(err)));
      } finally { rp.enabled = true; }
      report(WARMUP_DRAW_END + (1 - WARMUP_DRAW_END) * 0.5);
      await new Promise((resolve) => nextFrame(resolve));
      if (!this.renderer) return;
    }
    // ... then the first real frame, in its own task
    try { this.draw(); } catch (err) {
      warnOnce('render.warmupDraw', 'warm-up frame failed: ' + (err && err.message ? err.message : String(err)));
    }
    this.dirty = true;
    report(1);
  }

  /** Round 5 (docs/DISTRICTS.md §3.6): appends the environment's (slot mesh, alternative geometry) pairs —
   *  env.districtWarmList(out) per the spec (env.warmDistricts(out) is accepted as an alias) — so every district geometry
   *  is uploaded and gets its VAOs (main and shadow-depth pass) at boot and a later swap is a pointer change. District
   *  differences are uniforms only (no program keys), so the compile step needs nothing more. Never throws. */
  _appendDistrictWarm(list) {
    const env = this.env;
    if (!env) return 0;
    const fn = typeof env.districtWarmList === 'function' ? 'districtWarmList' : (typeof env.warmDistricts === 'function' ? 'warmDistricts' : null);
    if (!fn) return 0;
    const pairs = [];
    let ret = null;
    try { ret = env[fn](pairs); } catch (err) {
      warnOnce('render.districtWarm', 'env.' + fn + ' failed: ' + (err && err.message ? err.message : String(err)));
      return 0;
    }
    const src = Array.isArray(ret) ? ret : pairs;
    let n = 0;
    for (let i = 0; i < src.length; i++) {
      const e = src[i];
      if (e && e.mesh && e.mesh.isObject3D && e.geometry && e.geometry.isBufferGeometry) { list.push(e); n++; }
    }
    this._districtWarmCount = n;
    return n;
  }

  // -------------------------------------------------------------------------------------------
  // Camera theatre (§6.3, GDD §7 / J18)
  // -------------------------------------------------------------------------------------------

  /** Boss intro dolly: out (ease) → hold → back (ease) on the theatre clock (real time that holds while paused, VIS-18);
   *  no-op under reduced motion. */
  dollyTo(pos, look, outSec, holdSec, backSec) {
    if (this._reducedMotion || !pos || !look) return;
    this._dollyPos.copy(pos);
    this._dollyLook.copy(look);
    this._dollyOut = Math.max(0, outSec || 0);
    this._dollyHold = Math.max(0, holdSec || 0);
    this._dollyBack = Math.max(0, backSec || 0);
    this._dollyStart = theatreNow(this.ctx.time);
    this._dollyActive = this._dollyOut + this._dollyHold + this._dollyBack > 0;
  }

  /** Ends any dolly immediately: the camera is back on the follow preset next frame (LevelRunner.start). */
  cancelDolly() { this._dollyActive = false; }

  /** True while the boss-intro dolly owns the camera (round-3 FTUE: fx fades the count label and ui hides the shield
   *  pill meanwhile — the dolly drops the squad under the letterbox, which clipped the label into a stray digit). */
  get dollying() { return this._dollyActive; }

  /** Bloom strength for the composer's bloom pass (fx drives the boss-death pulse through this each frame). Round 5
   *  (docs/DISTRICTS.md §6.1): a non-finite v restores bloomBase (the district's strength, mid-fade value included); a
   *  finite v holds for this frame (ctx.time.frame stamp), so a running district fade does not overwrite fx's pulse. */
  setBloomStrength(v) {
    let s;
    if (Number.isFinite(v)) {
      s = Math.max(0, v);
      this._bloomHold = this.ctx.time ? this.ctx.time.frame : -1;
    } else {
      s = this._cur[DS_BLOOM_S];
      this._bloomHold = -1;
    }
    this._bloomStrength = s;
    if (this.bloomPass) this.bloomPass.strength = s;
  }

  /** Game-over grade (GradeOutputPass uDesat); a no-op on Low (no grade pass) — the value is kept so a
   *  later tier rise shows the same grade. */
  setDesaturate(t01) {
    const v = Number.isFinite(t01) ? clamp(t01, 0, 1) : 0;
    this._desat = v;
    if (this.gradePass) this.gradePass.uniforms.uDesat.value = v;
    if (this.composer) this.dirty = true;
  }

  /** GDD J18: drop RENDER.gameOver.dropM + slow orbitDeg orbit over `seconds` (theatre clock: real time that holds while
   *  paused, VIS-18); static under reduced motion; off = instant return to the follow preset. */
  gameOverCamera(on) {
    if (on) {
      if (!this._goOn) { this._goOn = true; this._goStart = theatreNow(this.ctx.time); }
    } else {
      this._goOn = false;
    }
  }

  /** Title idle scene: the camera blends to the WORLD.camera.title rig (VIS-3: the marching squad between the logo and
   *  PLAY; RENDER.idleCameraDrop is the fallback when that key is absent), tweened over WORLD.camera.presetTween. */
  idleCamera(on) { this._idleOn = !!on; }

  /** VIS-3: target pull-back (m, along the view line) and extra pitch (rad) for the framing constraint; writes
   *  _frameBackT / _framePitchT (no allocation, a few trig calls + a short bisection when pitch is not enough). */
  _solveFraming(py, pz, ly, lz, fovDeg, squadDepth) {
    const F = FRAMING;
    const tanH = Math.tan(fovDeg * DEG * 0.5);
    const dB = Math.atan(F.bottomNdc * tanH);                 // allowed depression below the axis
    const dT = Math.atan(F.topNdc * tanH);                    // allowed elevation of the spawn line above it
    const zBack = Math.min(Math.max(0, squadDepth || 0), F.backMaxM);
    const zFar = WORLD.spawnZ;
    const vy = py - ly, vz = pz - lz;
    const vl = Math.hypot(vy, vz) || 1;
    const uy = vy / vl, uz = vz / vl;
    // pitch alone cannot satisfy both ends → smallest pull-back that can (bisection; capped at maxPullM)
    let back = 0;
    if (framingGap(0, py, pz, uy, uz, zBack, zFar, dB, dT) > 0) {
      let lo = 0, hi = F.maxPullM;
      if (framingGap(hi, py, pz, uy, uz, zBack, zFar, dB, dT) <= 0) {
        for (let i = 0; i < F.solveIters; i++) {
          const mid = 0.5 * (lo + hi);
          if (framingGap(mid, py, pz, uy, uz, zBack, zFar, dB, dT) > 0) lo = mid; else hi = mid;
        }
      }
      back = hi;
    }
    const cy = py + uy * back, cz = pz + uz * back;
    const need = Math.atan2(cy, cz - zBack) - dB;
    const pitch0 = Math.atan2(cy - ly, cz - lz);
    const maxPitch = Math.atan2(cy, cz - zFar) + dT;
    this._frameBackT = back;
    this._framePitchT = Math.max(0, Math.min(need, Math.max(maxPitch, pitch0)) - pitch0);
  }

  /** World → CSS px in the canvas box (uses the camera matrices of the last update). */
  worldToScreen(v3, out) {
    _v3.copy(v3).project(this.camera);
    out.x = (_v3.x * 0.5 + 0.5) * this.size.w;
    out.y = (0.5 - _v3.y * 0.5) * this.size.h;
    return out;
  }

  /** snap: place the camera directly on its targets (boot), no tweens. */
  _updateCamera(dt, udt, now, snap) {
    const cam = this.camera;
    if (!cam) return;
    const ctx = this.ctx;
    const C = WORLD.camera;
    const world = ctx.world;
    const sx = world ? world.squadX : 0;
    const tween = C.presetTween > 0 ? udt / C.presetTween : 1;

    // preset (portrait ⇄ landscape) and title rig, both tweened on unscaled time
    this._presetBlend = approach(this._presetBlend, this.size.portrait ? 0 : 1, snap ? 1 : tween);
    this._idleBlend = approach(this._idleBlend, this._idleOn ? 1 : 0, snap ? 1 : tween);
    const pt = ease.inOutCubic(this._presetBlend);
    const it = ease.inOutCubic(this._idleBlend);

    // follow (GDD §2: x lerp 1 − exp(−5·dt), look-at x 1 − exp(−7·dt))
    if (snap) {
      this._camX = sx; this._lookX = sx;
    } else if (dt > 0) {
      this._camX = lerpExp(this._camX, sx, C.followRate, dt);
      this._lookX = lerpExp(this._lookX, sx, C.lookRate, dt);
    }

    const P = C.portrait, L = C.landscape;
    let px = lerp(P.pos[0], L.pos[0], pt) * this._camX;
    let py = lerp(P.pos[1], L.pos[1], pt);
    let pz = lerp(P.pos[2], L.pos[2], pt);
    let lx = lerp(P.look[0], L.look[0], pt) * this._lookX;
    let ly = lerp(P.look[1], L.look[1], pt);
    let lz = lerp(P.look[2], L.look[2], pt);
    let fov = lerp(this._fovP, this._fovL, pt);

    // VIS-3 (1) count-driven dolly: the camera backs off as the visible squad grows (look-at unchanged)
    const D = C.countDolly;
    const sq = ctx.squad;
    const vis = sq && Number.isFinite(sq.visible) ? sq.visible : (world ? world.squadCount : 0);
    let dTarget = 0;
    if (D && vis > D.ref) dTarget = Math.min(D.maxS, Math.sqrt(vis) - Math.sqrt(D.ref));
    if (snap || !(D && D.seconds > 0)) this._countDolly = dTarget;
    else this._countDolly = lerpExp(this._countDolly, dTarget, FRAMING.easeRate / D.seconds, udt);
    if (D) { py += D.y * this._countDolly; pz += D.z * this._countDolly; }

    // VIS-3 (2) framing constraint: the squad's back (front z = 0, + min(depth, FRAMING.backMaxM)) must project at
    // ndc y ≥ FRAMING.bottomNdc (above the boss letterbox) while the spawn line stays at ndc y ≤ FRAMING.topNdc:
    // pitch down (look-at lowered) first, pull the camera back along its view line when pitch alone cannot do it
    this._solveFraming(py, pz, ly, lz, fov, world ? world.squadDepth : 0);
    const fw = 1 - it;                                         // the title rig frames its own squad
    if (snap) { this._frameBack = this._frameBackT; this._framePitch = this._framePitchT; }
    else {
      const k = FRAMING.easeRate / Math.max(0.05, C.presetTween);
      this._frameBack = lerpExp(this._frameBack, this._frameBackT, k, udt);
      this._framePitch = lerpExp(this._framePitch, this._framePitchT, k, udt);
    }
    if (fw > 0) {
      const vy = py - ly, vz = pz - lz;
      const vl = Math.hypot(vy, vz) || 1;
      const back = this._frameBack * fw;
      py += vy / vl * back; pz += vz / vl * back;
      const pitch = Math.atan2(py - ly, pz - lz) + this._framePitch * fw;
      ly = py - (pz - lz) * Math.tan(pitch);
    }

    // title idle rig (VIS-3 (3)): blend to WORLD.camera.title so the marching squad sits between logo and PLAY; the
    // landscape preset blends toward WORLD.camera.titleLandscape (VIS-20: the squad beside the centred button column;
    // its x components are absolute offsets — the title squad marches at x = 0 — the portrait rig's are × squadX)
    if (it > 0) {
      const T = C.title;
      if (T) {
        const TL = C.titleLandscape;
        const lp = TL ? pt : 0;
        const tpx = lerp(T.pos[0] * this._camX, TL ? TL.pos[0] : 0, lp), tlx = lerp(T.look[0] * this._lookX, TL ? TL.look[0] : 0, lp);
        const tpy = TL ? lerp(T.pos[1], TL.pos[1], lp) : T.pos[1], tpz = TL ? lerp(T.pos[2], TL.pos[2], lp) : T.pos[2];
        const tly = TL ? lerp(T.look[1], TL.look[1], lp) : T.look[1], tlz = TL ? lerp(T.look[2], TL.look[2], lp) : T.look[2];
        px = lerp(px, tpx, it); py = lerp(py, tpy, it); pz = lerp(pz, tpz, it);
        lx = lerp(lx, tlx, it); ly = lerp(ly, tly, it); lz = lerp(lz, tlz, it);
      } else {
        py *= 1 - RENDER.idleCameraDrop * it;
      }
    }

    // game over (J18): drop + slow orbit of the whole rig about a vertical axis through the squad front
    // (x = followed squad x, z = 0), so the fallen squad stays framed; real time; static under reduced motion
    if (this._goOn && !this._reducedMotion) {
      const G = RENDER.gameOver;
      const e = ease.outCubic(clamp((now - this._goStart) / (G.seconds * 1000), 0, 1));
      py -= G.dropM * e;
      const a = G.orbitDeg * DEG * e;
      const cs = Math.cos(a), sn = Math.sin(a);
      const cx = this._lookX;
      let ox = px - cx, oz = pz;
      px = cx + ox * cs + oz * sn;
      pz = -ox * sn + oz * cs;
      ox = lx - cx; oz = lz;
      lx = cx + ox * cs + oz * sn;
      lz = -ox * sn + oz * cs;
    }

    // boss intro dolly (real time): out → hold → back
    if (this._dollyActive) {
      const t = (now - this._dollyStart) / 1000;
      const out = this._dollyOut, hold = this._dollyHold, back = this._dollyBack;
      let w;
      if (t < out) w = ease.inOutCubic(out > 0 ? t / out : 1);
      else if (t < out + hold) w = 1;
      else if (t < out + hold + back) w = 1 - ease.inOutCubic(back > 0 ? (t - out - hold) / back : 1);
      else { w = 0; this._dollyActive = false; }
      if (t < 0) w = 0;
      const dp = this._dollyPos, dl = this._dollyLook;
      px = lerp(px, dp.x, w); py = lerp(py, dp.y, w); pz = lerp(pz, dp.z, w);
      lx = lerp(lx, dl.x, w); ly = lerp(ly, dl.y, w); lz = lerp(lz, dl.z, w);
    }

    // shake (fx: trauma², ×0 under reduced motion) translates the whole rig; roll in radians
    let roll = 0;
    const fx = ctx.fx;
    if (fx) {
      if (typeof fx.getShake === 'function') {
        _shake.x = 0; _shake.y = 0; _shake.roll = 0;
        fx.getShake(_shake);
        if (Number.isFinite(_shake.x)) { px += _shake.x; lx += _shake.x; }
        if (Number.isFinite(_shake.y)) { py += _shake.y; ly += _shake.y; }
        if (Number.isFinite(_shake.roll)) roll = _shake.roll;
      }
      if (!this._reducedMotion && typeof fx.getFovKick === 'function') {
        const k = fx.getFovKick();
        if (Number.isFinite(k)) fov += k;
      }
    }

    cam.position.set(px, py, pz);
    _look.set(lx, ly, lz);
    cam.lookAt(_look);
    if (roll !== 0) cam.rotateZ(roll);
    if (Math.abs(cam.fov - fov) > FOV_EPS) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }

  // -------------------------------------------------------------------------------------------
  // Lights (§9.3)
  // -------------------------------------------------------------------------------------------

  _buildLights(params) {
    const S = RENDER.sun, H = RENDER.hemi, f = S.frustum;
    const scene = this.scene;
    const sun = new DirectionalLight(S.color, S.intensity);
    sun.name = 'render.sun';
    sun.castShadow = !!params.shadows;
    const sc = sun.shadow.camera;
    sc.left = f.l; sc.right = f.r; sc.top = f.t; sc.bottom = f.b; sc.near = f.near; sc.far = f.far;
    sc.updateProjectionMatrix();
    sun.shadow.bias = S.bias;
    sun.shadow.normalBias = S.normalBias;
    sun.shadow.radius = S.shadowRadiusPcf;
    const n = params.shadowMap > 0 ? params.shadowMap : QUALITY_TIERS.med.shadowMap;
    sun.shadow.mapSize.set(n, n);
    scene.add(sun);
    scene.add(sun.target);

    const hemi = new HemisphereLight(H.sky, H.ground, H.intensity);
    hemi.name = 'render.hemi';
    hemi.matrixAutoUpdate = false;                            // static (VIS-13): one updateMatrix, never recomposed per frame
    hemi.updateMatrix();
    scene.add(hemi);
    // the sun and its target are placed by _updateSun only (VIS-13: no per-frame recompose in scene.updateMatrixWorld)
    sun.matrixAutoUpdate = false;
    sun.target.matrixAutoUpdate = false;

    // two point lights, always in the scene at intensity 0 (toggling visibility would change the light
    // count and recompile every program mid-fight); boss drives bossCore, weapons drives laser
    // built at 0.5 then set to 0: `intensity` gets a Double field (round-2 cross-group, FX-14 item 2 — the first
    // fractional intensity at the boss intro used to deprecate the PointLight map mid-fight)
    const bossCore = new PointLight(PALETTE.boss.core, 0.5, POINT_LIGHT_DISTANCE, POINT_LIGHT_DECAY);
    bossCore.intensity = 0;
    bossCore.name = 'render.bossCore';
    bossCore.castShadow = false;
    scene.add(bossCore);
    const laser = new PointLight(WEAPONS.laser.color, 0.5, POINT_LIGHT_DISTANCE, POINT_LIGHT_DECAY);
    laser.intensity = 0;
    laser.name = 'render.laser';
    laser.castShadow = false;
    scene.add(laser);

    this.lights.sun = sun; this.lights.hemi = hemi; this.lights.bossCore = bossCore; this.lights.laser = laser;
    // the post-commit warm camera (WARM_LAYER only) must see the same lights, or its program keys would differ
    sun.layers.enable(WARM_LAYER); hemi.layers.enable(WARM_LAYER); bossCore.layers.enable(WARM_LAYER); laser.layers.enable(WARM_LAYER);
    // ... and so must the post-bloom overlay pass: it renders the same scene object, so three's render state for this
    // scene keeps the light setup of whichever render ran last, and r170 renders the shadow map BEFORE setupLights().
    // An overlay render that saw no lights left 0 lights in that state, the next frame's shadow pass then keyed the
    // depth programs it resolved with no lights and linked them mid-play (round-2 release verification: the skinned
    // boss body's shadow-depth program linked at every first boss spawn). OverlayRenderPass skips the shadow map.
    sun.layers.enable(OVERLAY_LAYER); hemi.layers.enable(OVERLAY_LAYER); bossCore.layers.enable(OVERLAY_LAYER); laser.layers.enable(OVERLAY_LAYER);

    // sun offset (RENDER.sun.offset, swung on the title rig — VIS-15) and its light-space basis for texel snapping
    this._setSunAzimuth(0);
    this._updateTexelSize();
  }

  /** Shadow-map texel size in light space (m), from the shadow camera's live bounds (round 5: the bottom bound follows
   *  the district light elevation, _updateShadowBox). */
  _updateTexelSize() {
    const sun = this.lights.sun;
    const f = RENDER.sun.frustum;
    const sc = sun ? sun.shadow.camera : null;
    const n = Math.max(1, sun ? sun.shadow.mapSize.x : 1);
    this._texelU = (sc ? sc.right - sc.left : f.r - f.l) / n;
    this._texelV = (sc ? sc.top - sc.bottom : f.t - f.b) / n;
  }

  /** Sun + target follow squadX (offset RENDER.sun.offset); the anchor is snapped to whole shadow-map
   *  texels in light space so steering never makes shadow edges crawl. */
  _updateSun(squadX) {
    const sun = this.lights.sun;
    if (!sun) return;
    let ax = Number.isFinite(squadX) ? squadX : 0, ay = 0, az = 0;
    if (sun.castShadow && this._texelU > 0 && this._texelV > 0) {
      const u = ax * this._lxX, v = ax * this._lyX;           // anchor (ax, 0, 0) in light x / y
      const du = Math.round(u / this._texelU) * this._texelU - u;
      const dv = Math.round(v / this._texelV) * this._texelV - v;
      ax += du * this._lxX + dv * this._lyX;
      ay += du * this._lxY + dv * this._lyY;
      az += du * this._lxZ + dv * this._lyZ;
    }
    sun.target.position.set(ax, ay, az);
    sun.position.set(ax + this._sunOffX, ay + this._sunOffY, az + this._sunOffZ);
    sun.updateMatrix();
    sun.target.updateMatrix();
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
  }

  // -------------------------------------------------------------------------------------------
  // Blob shadows (Low tier, §9.3): 567 flat discs, one draw, slots per ARCH §6.3
  // -------------------------------------------------------------------------------------------

  _buildBlobShadows() {
    const geo = new CircleGeometry(RENDER.blobShadow.radius, 12);   // 12 segments (ARCH §9.3)
    geo.rotateX(-Math.PI / 2);
    // placeholder material until the library exists (replaced in _attachBlobMaterial)
    this._blobOwnMat = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: RENDER.blobShadow.opacity, depthWrite: false });
    const mesh = new InstancedMesh(geo, this._blobOwnMat, BLOB_CAP);
    mesh.name = 'render.blobShadows';
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;                                     // after the opaque road, before other transparents
    mesh.count = BLOB_CAP;
    mesh.visible = false;
    this._blobArr = mesh.instanceMatrix.array;
    this._zeroBlobs();
    this.scene.add(mesh);
    this.blobShadows = mesh;
  }

  _attachBlobMaterial() {
    const m = this.materials;
    if (!m || typeof m.blobShadow !== 'function') return;
    try {
      const mat = m.blobShadow();
      if (mat) {
        this.blobShadows.material = mat;
        if (this._blobOwnMat) { this._blobOwnMat.dispose(); this._blobOwnMat = null; }
      }
    } catch (err) { warnOnce('render.blobMat', 'materials.blobShadow failed: ' + (err && err.message)); }
  }

  /** Every disc degenerate (zero scale) with the identity's w = 1; full upload next draw. */
  _zeroBlobs() {
    const a = this._blobArr;
    a.fill(0);
    for (let i = 0; i < BLOB_CAP; i++) { a[i * 16 + 5] = 1; a[i * 16 + 15] = 1; }
    this._blobMin = 0; this._blobMax = BLOB_CAP - 1;
  }

  _setBlobActive(on) {
    if (!this.blobShadows || on === this._blobActive) return;
    this._blobActive = on;
    this.blobShadows.visible = on;
    if (on) this._zeroBlobs();                                // owners rewrite their live slots next render
  }

  /** Low tier only: positions disc i under a character (scale 0 hides it); no-op on other tiers. */
  blobShadowSlot(i, x, z, scale) {
    if (!this._blobActive) return;
    const k = i | 0;
    if (k < 0 || k >= BLOB_CAP) return;
    const s = scale > 0 && Number.isFinite(scale) ? scale : 0;
    const a = this._blobArr, o = k * 16;
    a[o] = s; a[o + 10] = s;
    a[o + 12] = s > 0 ? x : 0; a[o + 13] = BLOB_Y; a[o + 14] = s > 0 ? z : 0;
    if (k < this._blobMin) this._blobMin = k;
    if (k > this._blobMax) this._blobMax = k;
  }

  _flushBlobs() {
    if (!this._blobActive || this._blobMax < this._blobMin) return;
    markRange(this.blobShadows.instanceMatrix, this._blobRange, this._blobMin * 16, (this._blobMax - this._blobMin + 1) * 16);
    this._blobMin = BLOB_CAP; this._blobMax = -1;
  }

  // -------------------------------------------------------------------------------------------
  // Settings, quality events, helpers
  // -------------------------------------------------------------------------------------------

  _readSettings() {
    let s = null;
    try { s = this.ctx.save ? this.ctx.save.settings : null; } catch (_) { s = null; }
    let hc = !!(s && s.hcGates);
    if (!s) {
      try { hc = typeof document !== 'undefined' && document.documentElement.classList.contains('hc-gates'); } catch (_) { hc = false; }
    }
    this._hc = hc;
    this._reducedMotion = resolveReducedMotion(s ? s.reducedMotion : null);
  }

  /** hcGates → the gate panel opacity uniform (GATE_RULES.panel.opacity | opacityHC). */
  _applyHighContrast(on) {
    this._hc = !!on;
    const m = this.materials;
    if (!m) return;
    try {
      if (typeof m.setHighContrast === 'function') {
        m.setHighContrast(this._hc);
      } else if (typeof m.gatePanel === 'function') {
        const mat = m.gatePanel();
        if (mat && mat.uniforms && mat.uniforms.uOpacity) mat.uniforms.uOpacity.value = this._hc ? GATE_RULES.panel.opacityHC : GATE_RULES.panel.opacity;
      }
    } catch (err) { warnOnce('render.hc', 'high-contrast gates could not be applied: ' + (err && err.message)); }
    this.dirty = true;
  }

  _handleSettings(p) {
    if (!p) return;
    if (p.key === 'hcGates') {
      this._applyHighContrast(p.value === true || p.value === 'true' || p.value === 1);
    } else if (p.key === 'reducedMotion') {
      const v = p.value === 'true' ? true : (p.value === 'false' ? false : p.value);
      this._reducedMotion = resolveReducedMotion(v);
      if (this._reducedMotion) this._dollyActive = false;
      this.dirty = true;
    }
  }

  /** quality:change (init / auto / manual): engine has already swapped ctx.quality.tier/params. */
  _handleQuality(p) {
    const q = this.ctx.quality;
    const params = p && p.params ? p.params : (q ? q.params : null);
    if (!params) return;
    this.applyQuality(params);
  }

  _installCallProbe() {
    const sky = this.env ? this.env.sky : null;
    if (!sky || typeof sky.onBeforeRender !== 'function') return;
    const self = this;
    const prev = sky.onBeforeRender;
    // the sky dome (renderOrder −10, opaque) is the first draw of the main pass: everything counted
    // before it this frame belongs to the shadow pass
    sky.onBeforeRender = function onSkyBeforeRender(renderer, scene, camera, geometry, material, group) {
      if (self._mainStart < 0) self._mainStart = renderer.info.render.calls;
      prev.call(this, renderer, scene, camera, geometry, material, group);
    };
  }

  _progress(t) {
    const ui = this.ctx.ui;
    if (ui && typeof ui.setBootProgress === 'function') {
      try { ui.setBootProgress(t); } catch (_) { /* ignore */ }
    }
  }

  // ---- members other modules use (CALLSITES) ----

  /** scene.add shortcut. */
  add(obj) { if (this.scene && obj) this.scene.add(obj); return obj; }
  /** scene.remove shortcut. */
  remove(obj) { if (this.scene && obj) this.scene.remove(obj); return obj; }
  /** TextureFactory shortcuts. */
  get digitAtlas() { return this.textures ? this.textures.digitAtlas : null; }
  get glow() { return this.textures ? this.textures.glow : null; }
  get icons() { return this.textures ? this.textures.icons : null; }
  glyphUV(ch, out) { if (this.textures) this.textures.glyphUV(ch, out); }
  iconUV(id, out) { if (this.textures) this.textures.iconUV(id, out); }
  iconDataURL(id, px) { return this.textures ? this.textures.iconDataURL(id, px) : ''; }
  /** Current bloom strength / reduced-motion flag (read-only views). */
  get bloomStrength() { return this._bloomStrength; }
  get reducedMotion() { return this._reducedMotion; }

  // -------------------------------------------------------------------------------------------
  // Context restore and teardown (§9.5)
  // -------------------------------------------------------------------------------------------

  /** After webglcontextrestored: re-applies renderer state; three re-creates programs / buffers / textures lazily. The
   *  GL-backed objects render.js owns (composer / bloom targets, warm target, shadow map) are dropped WITHOUT dispose()
   *  and the composer is rebuilt for the committed tier (VIS-21: disposing lost-context objects floods the console with
   *  INVALID_OPERATION warnings); the canvas is resized only when the size or DPR actually changed. */
  rebuild() {
    const r = this.renderer;
    if (!r) return;
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = this._cur[DS_EXPOSURE];               // round 5: the current district state, not RENDER
    r.info.autoReset = false;
    r.shadowMap.enabled = true;
    if (this._shadowType >= 0) r.shadowMap.type = this._shadowType;
    if (this.scene && this.scene.fog) r.setClearColor(this.scene.fog.color, 1); else r.setClearColor(RENDER.fogColor, 1);
    const pend = this._pendingTier;
    this._cancelPendingTier();                                     // its prepared composer / programs belonged to the lost context
    this._dropLostContextObjects();
    const s = this.size;
    if (s.w > 0 && s.h > 0) {
      r.getSize(_v2);
      if (r.getPixelRatio() !== s.dpr || _v2.x !== s.w || _v2.y !== s.h) {
        r.setPixelRatio(s.dpr);
        r.setSize(s.w, s.h, false);
      }
    }
    const q = this.ctx.quality;
    const p = pend ? pend.params : (this._committedParams || (q && q.params) || null);
    if (p) this._applyTierState(p);                                // new composer + bloom targets at the current size
    // round 5 (docs/DISTRICTS.md §3.4): re-apply the current district state (lights, shadow box, fog / clear colour,
    // exposure, bloom, grade, uRoadBg, eye glow) from _cur — never setDistrict, never an environment re-layout
    this._applyDistrictState(true);
    r.shadowMap.needsUpdate = true;
    if (this.textures) this.textures.restoreAll();                 // round 6: re-draw every canvas from code + re-upload
    if (this.blobShadows) { this._blobMin = 0; this._blobMax = BLOB_CAP - 1; this.blobShadows.instanceMatrix.needsUpdate = true; }
    this.dirty = true;
  }

  dispose() {
    this._cancelPendingTier();
    if (this._warmTarget) { this._warmTarget.dispose(); this._warmTarget = null; }
    if (this._passGeo) { this._passGeo.dispose(); this._passGeo = null; }
    this._depthProbes.forEach((m) => m.dispose());
    this._depthProbes.clear();
    if (this._staleBloom) { this._staleBloom.dispose(); this._staleBloom = null; }
    for (let i = 0; i < this._unsubs.length; i++) {
      const u = this._unsubs[i];
      if (typeof u === 'function') { try { u(); } catch (_) { /* ignore */ } }
    }
    this._unsubs.length = 0;
    const ev = this.ctx.events;
    if (ev && typeof ev.off === 'function') {
      try { ev.off('quality:change', this._onQuality); ev.off('settings:change', this._onSettings); } catch (_) { /* ignore */ }
    }
    this._disposeComposer();
    if (this.gradePass) { this.gradePass.dispose(); this.gradePass = null; }
    if (this.renderPass) { this.renderPass.dispose(); this.renderPass = null; }
    if (this.blobShadows) {
      if (this.scene) this.scene.remove(this.blobShadows);
      this.blobShadows.geometry.dispose();
      this.blobShadows.dispose();
      if (this._blobOwnMat) { this._blobOwnMat.dispose(); this._blobOwnMat = null; }
      this.blobShadows = null;
    }
    if (this.env && typeof this.env.dispose === 'function') { try { this.env.dispose(); } catch (_) { /* ignore */ } }
    if (this.materials && typeof this.materials.dispose === 'function') { try { this.materials.dispose(); } catch (_) { /* ignore */ } }
    if (this.textures) this.textures.dispose();
    const L = this.lights;
    if (L.sun && L.sun.shadow && L.sun.shadow.map) { L.sun.shadow.map.dispose(); L.sun.shadow.map = null; }
    if (this.renderer) { this.renderer.dispose(); this.renderer = null; }   // update/draw/resize become no-ops
    this.composer = null;
    this._inited = false;
  }
}
