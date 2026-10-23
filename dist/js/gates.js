// js/gates.js — Gate Rush: the Gates system (ARCHITECTURE §6.9, GDD §4).
//
// Pool of 12 gates (SoA typed arrays, stable generation-tagged ids) grouped into ≤ 8 events, drawn with
// four InstancedMeshes — frames (iFrame), panels (iPanel + iScale), glows (instanceColor) and digit-atlas
// glyph quads (iGlyph / iPopTime / iColor) — plus one count-gated icon quad draw for item lanes (0 draws
// while no item lane is live). Gameplay: arming / commit / lock-lane / pass / miss state machine with the
// exact z thresholds of WORLD, the GDD §4.2 per-hit rules for + / − / x / ÷ under the 40 weighted hits/s
// intake budget, flip / max / step events and coins, the lane highlight decal (single owner, through
// fx.decal('lane')), decorative title gates, and per-instance hit flash / pop / punch / ring / tint
// written in render(). Value text is rebuilt into glyph quads only when it changes. Round 7: the lane choice (decal, commit,
// pass fallback) follows the steering target (input.targetX); + / − gates carry the ring gauge too, with a "reaches it in time"
// flag; pulseEvent(eventId, seconds) pulses an event's frames while a held lesson hint points at it.
//
// ============================================================================================
// PER-INSTANCE ATTRIBUTE PROTOCOL (written here; read by the MaterialLibrary shaders in js/materials.js,
// re-exported by render.js — this block and the contract at the top of materials.js describe the same layout)
// ============================================================================================
// Type index space (shared by every attribute below; = GATE_RULES.colors key order):
//   0 plus · 1 mult · 2 minus · 3 div · 4 zero (x1 / 0 neutral grey) · 5 item
//
// frames  (materials.gateFrame(), MeshStandardMaterial + onBeforeCompile, InstancedMesh of models.geo.gateFrame)
//   iFrame   vec4 = (typeIdx, tintT, maxed, emissiveBoost)
//     typeIdx       CURRENT colour type of the lane (a flipped red lane is 0 plus, a ÷ lane on the x1 rung is 4
//                   zero, a flipped ÷ is 1 mult; a flipped red lane still showing 0 is 4 zero).
//     tintT         recolour progress after a type change, 0 → 1 over GATE_RULES.minus.recolor (0.4 s):
//                   shaders show grey (zero) for tintT < 0.5, then lerp grey → typeIdx's colour; 0 = no recolour
//                   running (plain typeIdx colour). Written > 0 only while a recolour runs.
//     maxed         0 / 1 → frame colour lerps to gold (GATE_RULES.colors.max).
//     emissiveBoost FAR_EMISSIVE (0.35) before the armed line, 1.0 armed / locked, + the hit flash (see iPanel.flash,
//                   ≤ HIT_FLASH_CAP 0.45), + the flip flash (FLIP_FLASH_PEAK 1.5 → 1) during the 0.25 s flip, + (round 7,
//                   pulseEvent) GATE_RULES.fx.attnGain·(0.5 + 0.5·sin(attnRadPerS·t)) while a held lesson hint points at the event.
//   instance matrix: translation (x, 0, z), scale (sx, 1, 1) with sx = 1 | wTriple / w (triple lanes).
//
// panels  (materials.gatePanel(), ONE ShaderMaterial, InstancedMesh of models.geo.gatePanel 3.6 × 2.4, centred)
//   iPanel   vec4 = (tintIdx + 8·maxed, stripeMix, flash, ring01 + 2·reach)
//     tintIdx       0..5 current colour type as above, except 4 (grey) during the first half of a recolour
//                   (red → grey → blue on a flip; ÷2 → grey x1 → green x2 on the ladder);
//                   + 8 when maxed → gold MAX pill + gold rim; the "MAX" letters are 3 glyph quads gates places
//                   GATE_RULES.glyph.icon tall, centred at bottom + h + GATE_RULES.glyph.badgeLift (above the
//                   frame's top bar), Z_BADGE in front of the panel; the pill is centred at the same height.
//     stripeMix     1 = hazard stripes (current type minus / div); during a recolour away from a negative type
//                   it fades 1 → 0 over the first half; 0 otherwise.
//     flash         hit flash: GATE_RULES.fx.emissiveFlash·(1 − age / GATE_RULES.panel.hitFlash) / (1 + recent / 4),
//                   capped at HIT_FLASH_CAP (0.45); age counts from the last flash START, which restarts only
//                   GATE_RULES.fx.flashRetrigger after the previous one (a pulse, never a held white under fire);
//                   recent = hits taken in the last ≈ INTAKE_WINDOW_S (exponentially decayed counter). During the
//                   GATE_RULES.minus.flipFlash flip: FLIP_FLASH_PEAK (1.5, white) decaying to 1.0; 0 otherwise.
//     ring01        x lanes: weighted hits toward the next step / that step's cost (1 at the cap);
//                   ÷ lanes: progress toward the next rung (1 once flipped, and 1 on the ×1 rung when it is final: round 7,
//                   DIV_TOP_FINAL — one armed window can never pay the ×1 → ×2 flip); round 7 (r7 teaching:4): + lanes:
//                   (value − spawn value) / (cap − spawn value), 0 once maxed (the MAX badge takes over); − lanes: 1 + value /
//                   spawn magnitude (0 at spawn → 1 at the flip, 1 once flipped); 0 for item lanes.
//     reach         round 7 (r7 teaching:4): + 2 (REACH_FLAG) while the gate is being shot (weighted-hits/s EMA > GATE_RULES.reach
//                   .minRate) fast enough to reach its goal before WORLD.gateStopZ — red: the flip, +: MAX, x: the next step, ÷: the
//                   ×1 rung; the panel shader recolours the ring band to the colour it is heading for and pulses its head.
//   iScale   float = 1 | GATE_RULES.panel.wTriple / GATE_RULES.panel.w — NOT applied to the position by the shader
//                   (the instance matrix already carries it); used in-shader to keep stripes / ring / rim / badge
//                   in true metres.
//   instance matrix: translation (x, bottom + h/2, z), scale (sx·punch, punch, 1) with punch = the multiplier
//                   step punch (1 → GATE_RULES.mult.punch decaying over GATE_RULES.fx.stepPunchTime).
//
// glyphs  (copy of materials.glyph() with uBillboard = 0; InstancedMesh of a unit quad, capacity 60)
//   iGlyph   vec4  = (u0, v0, u1, v1) atlas rect from TextureFactory.glyphUV (cached once at init).
//   iPopTime float = INERT_POP_TIME (−1e4, never pops in-shader): gates applies the J3 hit pop (1 + 0.28·decay
//                   over 0.12 s), the J6 step pop (1.5×) and the J4 MAX badge pop (2 → 1 over 0.2 s) in the
//                   instance matrix so the sizes are exact; the attribute is static (uploaded once).
//   iColor   vec3  = linear colour: PALETTE.glyph.fill × PALETTE.glyph.emissive (0.82, under the bloom threshold —
//                   QA GAT-7) for the whole value text, op glyph included (the digits' fill colour),
//                   GATE_RULES.colors.max × emissive for the MAX letters.
//   instance matrix: translation + (width, height) scale; quads face +Z (towards the camera), no billboard.
//
// glows   (own MeshBasicMaterial, map = TextureFactory.glow, AdditiveBlending, fog off)
//   instanceColor = current panel tint (gold when maxed) × gain (GLOW_GAIN_LOW on Low where the glow quad
//                   substitutes for bloom, GLOW_GAIN_BLOOM otherwise) × fog fade × slow breathing.
//
// icons   (own ShaderMaterial on TextureFactory.icons; item lanes only)
//   iUv vec4 = icon cell rect from TextureFactory.iconUV, iColor vec3 = white.
// ============================================================================================
import {
  InstancedMesh, InstancedBufferAttribute, PlaneGeometry, BoxGeometry, MeshBasicMaterial, MeshStandardMaterial,
  ShaderMaterial, Color, AdditiveBlending, DoubleSide, DynamicDrawUsage,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, SQUAD, FIRE, GATE_RULES, PALETTE, RENDER } from './data.js';

// ---------------------------------------------------------------------------------------------
// Capacities and the few feel constants data.js does not carry (DATA-MISSING → integrator)
// ---------------------------------------------------------------------------------------------
const GATE_POOL = GATE_RULES.pool;            // ARCH §6.9 / §9.1 "pool of 12 gates"
const EVENT_POOL = GATE_RULES.eventPool;      // ARCH §6.9 "slot 0–7 (events)"
const GLYPH_POOL = GATE_RULES.glyphPool;      // ARCH §6.9 / GDD §16 "60 gate" quads
const GLYPHS_PER_GATE_MAX = 8;        // op glyph 1 + ≤ 4 digits (values ≤ SQUAD.countCap) + "MAX" 3 (quads are pooled)
const HIT_INSET_M = GATE_RULES.panel.hitInset;   // ARCH §6.9 "lane width − 0.2"
const INTAKE_WINDOW_S = GATE_RULES.intakeWindowS;   // burst capacity of the 40 hits/s bucket (a rail bolt's 10 weighted hits fit)
const FAR_EMISSIVE = GATE_RULES.frame.farEmissive;       // frame glow before the armed line
const ARMED_EMISSIVE = GATE_RULES.frame.armedEmissive;   // "frame lights up" at WORLD.gateArmZ
const GLOW_GAIN_BLOOM = GATE_RULES.glow.gainBloom;   // glow quad gain when bloom is on (High/Med)
const GLOW_GAIN_LOW = GATE_RULES.glow.gainLow;       // glow quad gain on Low (substitutes for bloom, GDD §16)
const GLOW_FAR_FRAC = GATE_RULES.glow.farFrac;       // glow gain fraction before the armed line
const GLOW_SCALE = GATE_RULES.glow.scale;            // glow quad size relative to the panel
const GLOW_PULSE_HZ = GATE_RULES.glow.pulseHz;       // slow breathing of the glow quad
const GLOW_PULSE_AMP = GATE_RULES.glow.pulseAmp;
const TEXT_FIT = GATE_RULES.glyph.fit;               // value text never wider than 90 % of the panel (triples)
const ICON_H = GATE_RULES.glyph.h4;   // item lane icon quad size (m): the 4-glyph text height
const INERT_POP_TIME = -1e4;          // iPopTime value that never pops in-shader (pop is done in the matrix)
const Z_GLOW = -0.05;                 // glow quad sits just behind the panel (−Z = away from the camera)
const Z_GLYPH = 0.03;                 // glyph / icon quads sit just in front of the panel
const Z_BADGE = 0.14;                 // MAX letters: in front of every frame part (top bar / lamps reach z + 0.07)
// Round-3 FTUE review: in the last metres before a pass the value text of the lane the squad takes sits exactly where
// fx draws the squad's count label (a billboard above the squad), so the two numbers merged on screen at every pass
// ("69" over "+15" read "+695", "83" over "×3" read "8×33"). While a gate's text block overlaps the label's plate on
// screen (view-space tan extents of both, from fx.label's world anchor and size), its op + digit glyphs fade out over
// LABEL_YIELD_S and fade back once the overlap ends (a lane the squad steered away from). The MAX badge (higher up)
// and every other lane are untouched; the label itself is the number that matters at the pass (the "+N" burst follows).
const LABEL_YIELD_S = GATE_RULES.glyph.labelYieldS > 0 ? GATE_RULES.glyph.labelYieldS : 0.1;                 // fade time (s, ctx.time.elapsed)
const LABEL_YIELD_MARGIN = GATE_RULES.glyph.labelYieldMargin > 0 ? GATE_RULES.glyph.labelYieldMargin : 1.1;   // both extents × this (clearance)
const HIT_FLASH_CAP = GATE_RULES.fx.hitFlashCap;     // max hit-flash value written to iPanel.z / iFrame.w / glow (QA GAT-1)
const FLASH_ATTEN_HITS = GATE_RULES.fx.flashAttenHits;   // flash × 1 / (1 + hits in the last ≈ 250 ms / 4)
const FLIP_FLASH_PEAK = GATE_RULES.fx.flipFlashPeak;     // J5 white flip flash: > 1 adds white in the panel shader, decays to 1
const NO_FOG = 1e6;                   // fog near/far defaults for own shaders until the renderer refreshes them
const FAR_PAST = -1e3;                // "long ago" timestamp for flashes / pops
const EPS = 1e-6;

const INTAKE_CAP = GATE_RULES.intakePerSec * INTAKE_WINDOW_S;   // weighted hits the bucket can hold
// Round 7 (r7 teaching:4 parts 1–2): the ring gauge also runs on + gates (toward MAX) and − gates (toward the flip), and every gate
// projects whether it reaches that goal before WORLD.gateStopZ at the rate it is being shot (GATE_RULES.reach): iPanel.w carries
// ring01 + REACH_FLAG when it will (materials.js decodes it; the same program, no new variant)
const REACH_FLAG = 2;
const REACH_TAU_S = GATE_RULES.reach.rateTauS;        // weighted-hits/s EMA time constant
const REACH_MIN_RATE = GATE_RULES.reach.minRate;      // below this a gate is not "being shot" (no projection)
const INTAKE_PER_SEC = GATE_RULES.intakePerSec;
// Round 7 (r7 explain:5 part 2): ×1 is the top a shot ÷ gate can reach in one armed window (levelgen sizes the ×1 → ×2 flip above it,
// GATE_RULES.div.stepFraction.flipBlock ≥ 1), so the gauge reads FULL on the ×1 rung — "done, no loss" — instead of creeping toward
// an unreachable ×2. A lane whose flip target is ×1 anyway (endless caps ÷ lanes at ×1) is final there as well.
const DIV_LAST = GATE_RULES.div.ladder.length - 1;
const DIV_TOP_FINAL = GATE_RULES.div.stepFraction.flipBlock >= 1;
// Round 7 (r7 teaching:0 E): pulseEvent() — the frames (and glows) of an event a held lesson hint points at pulse
const ATTN_GAIN = GATE_RULES.fx.attnGain;
const ATTN_W = GATE_RULES.fx.attnRadPerS;
const CAMERA_Z = WORLD.camera.portrait.pos[2];                  // camera z (follow preset) for the glow fog fade
// Round 5 (r4-release issue 5, r5-render-core needsOtherGroup 1): a decorative title gate sinks into the road once the title
// squad has marched through it — y −= SINK_RATE per metre of z beyond world.squadDepth + SINK_PAD (WORLD.idleGateSink) —
// and its event is freed once its tallest part (the MAX pill's top: panel top + badgeLift + icon / 2) is under the road.
// The road is opaque and every gate part depth-tested, so the road hides what has sunk; no program or draw changes.
const SINK = WORLD.idleGateSink || null;
const SINK_PAD = SINK && SINK.z0Pad >= 0 ? SINK.z0Pad : 0.5;   // fallbacks = the data values (mixed-build guard)
const SINK_RATE = SINK && SINK.rate > 0 ? SINK.rate : 2;
const SINK_FREE_Y = GATE_RULES.panel.bottom + GATE_RULES.panel.h + GATE_RULES.glyph.badgeLift + GATE_RULES.glyph.icon * 0.5;

// Op / layout / state vocabularies (indices into the typed arrays ↔ contract strings)
const OP_PLUS = 0, OP_MINUS = 1, OP_MULT = 2, OP_DIV = 3, OP_ITEM = 4;
const OP_STR = ['+', '-', 'x', '/', 'item'];
const LAYOUT_STR = ['single', 'pair', 'triple'];
const ST_FAR = 0, ST_ARMED = 1, ST_LOCKED = 2, ST_PASSED = 3, ST_MISSED = 4;
const STATE_STR = ['far', 'armed', 'locked', 'passed', 'missed'];
// Type (colour) indices — GATE_RULES.colors key order; shared with the materials.js gateFrame / gatePanel shaders
const T_PLUS = 0, T_MULT = 1, T_MINUS = 2, T_DIV = 3, T_ZERO = 4, T_ITEM = 5;
const TYPE_KEYS = ['plus', 'mult', 'minus', 'div', 'zero', 'item'];
const MAX_FLAG = 8;                   // iPanel.x += 8 when maxed (gold MAX pill, materials.js)

// Glyph indices into the per-glyph UV cache (RENDER.atlas rows: digits 0–9, then the op/badge row)
const G_PLUS = 10, G_MINUS = 11, G_TIMES = 12, G_DIV = 13, G_M = 14, G_A = 15, G_X = 16;
const GLYPH_CHARS = RENDER.atlas.rows[0].concat(RENDER.atlas.rows[1]);   // index → atlas character ('−' '×' '÷' are Unicode)
const GLYPH_COUNT = GLYPH_CHARS.length;

// ---------------------------------------------------------------------------------------------
// Module-level reused payload / scratch objects (listeners must not retain them — ARCH §5)
// ---------------------------------------------------------------------------------------------
const P_EVENT = { eventId: 0, layout: 'pair', z: -0, hint: null };
const P_SPAWN = { gate: null, eventId: 0, laneIndex: 0, laneCount: 0 };
const P_HIT = { gate: null, value: 0, prev: -0, weight: -0, x: -0, y: -0, z: -0 };
const P_GATE = { gate: null };
const P_STEP = { gate: null, mult: 0 };
const P_COMMIT = { gate: null, lane: 0 };
const P_OTHER = { op: '+', value: 0, wouldBe: -0 };
const P_PASS = { gate: null, op: '+', value: 0, before: 0, after: 0, x: -0, z: -0, other: null };
const P_COIN = { amount: -0, x: -0, y: -0, z: -0, source: 'gate' };
const LANES_BY_COUNT = [[], [null], [null, null], [null, null, null]];   // activeEvent.lanes arrays (no per-call allocation)
const ACTIVE_EVENT = { id: 0, layout: 'pair', z: -0, lanes: LANES_BY_COUNT[0] };
const UV_OUT = { u0: -0, v0: -0, u1: -0, v1: -0, advance: -0 };
const RGB_OUT = new Float32Array(3);
const COLOR_A = new Color();

/** Creates one read-only gate view object (ARCH §5.1 gate:spawn shape + the lane hints). */
function makeView() {
  return { id: 0, op: '+', value: 0, base: 0, mult: 1, x: 0, z: 0, lane: 0, layout: 'pair', state: 'far',
           maxed: false, flipped: false, item: null, hintOnHit: null, hintOnPass: null, hintIfOtherBetter: null };
}

/**
 * Matrix arguments scratch: (px, py, pz, sx, sy, sz). Hot loops write MA then call setMat(arr, i) with integer
 * arguments only — passing doubles to a call V8 does not inline boxes each one into a HeapNumber (garbage per
 * quad per frame); typed-array stores never allocate.
 */
const MA = new Float64Array(6);

/** Writes an axis-aligned (no rotation) TRS matrix from MA into a Float32Array at instance i. */
function setMat(arr, i) {
  const o = i * 16;
  arr[o] = MA[3]; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = MA[4]; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = MA[5]; arr[o + 11] = 0;
  arr[o + 12] = MA[0]; arr[o + 13] = MA[1]; arr[o + 14] = MA[2]; arr[o + 15] = 1;
}

/**
 * Installed as each tagged attribute's clearUpdateRanges(): WebGLAttributes calls it after every upload, and
 * emptying the array (three's default, length = 0) makes V8 free and re-allocate its backing store on the next
 * push — every frame. The one persistent range record stays in updateRanges for the attribute's lifetime.
 */
function keepUpdateRanges() {}

/**
 * Gives an attribute one persistent [0, count) update range, kept permanently in attr.updateRanges (the
 * attribute is never uploaded whole after creation; uploads still happen only on a version bump).
 */
function tagRange(attr) {
  const r = { start: 0, count: 0 };
  attr._grRange = r;
  attr.updateRanges.length = 0;
  attr.updateRanges.push(r);
  attr.clearUpdateRanges = keepUpdateRanges;
  return attr;
}

/** needsUpdate + updateRange [0, count) without allocating (the range record is permanent, see tagRange). */
function markUpdate(attr, count) {
  const r = attr._grRange;
  r.start = 0;
  r.count = count;
  attr.version++;          // = three's `needsUpdate = true` setter, without a prototype-chain (setter) lookup in the hot path
}

/**
 * Integer value a + / − gate shows AND applies at the pass (fractional weighted hits never round in the
 * player's favour: +5.5 shows and gives +5, −14.5 shows and takes −15), so the applied value always equals
 * the value on the panel.
 */
function intValueAt(arr, i) {
  const v = arr[i];
  return v >= 0 ? Math.floor(v + EPS) : -Math.ceil(-v - EPS);
}

const TU = new Float64Array(1);       // recolour progress scratch for _currentRGB (integer-only call)
const SQX = new Float64Array(1);      // lane-choice x for _nearestLane (integer-only call): input.targetX from round 7 (step)
const SEG_IN = new Float64Array(4);   // hitTestSegment → hitTestSeg (x0, z0, x1, z1)
const NEED = new Float64Array(1);     // _stepNeedTo result (integer-only call)
const PEN = new Float64Array(1);      // glyph pen x in render (a loop-carried double kept out of phis)

// Own quad shader (fallback glyph material for stub harnesses; item icon quads always). Fog uniforms are
// refreshed by the renderer for any material with fog: true; the two standard chunks give Low tier (direct
// render) the sRGB transfer while the composer path (linear target) compiles them to no-ops.
// Tone mapping is per caller: the item icon is an LDR pictogram (iColor 1) and is toneMapped: true, so Low (direct
// render) gives it the same ACES curve every other LDR surface gets there; on High / Medium three compiles tone
// mapping out for render targets (the output pass tone-maps every pixel), so their program is unchanged. The glyph
// fallback stays toneMapped: false (HDR glyph colours clip on Low, ARCH §9.4). 1.2.0 release (r5-art request 1): the
// icon was toneMapped: false and skipped ACES on Low only, rendering darker there (main colour Y 0.36 against 0.49).
const QUAD_VERT = /* glsl */`
  attribute vec4 iUv; attribute vec3 iColor;
  varying vec2 vUv; varying vec3 vColor; varying float vFogDepth;
  void main() {
    vUv = vec2(mix(iUv.x, iUv.z, uv.x), mix(iUv.y, iUv.w, uv.y));
    vColor = iColor;
    #ifdef USE_INSTANCING
      vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    #else
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
    #endif
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const QUAD_FRAG = /* glsl */`
  uniform sampler2D uMap; uniform float uHasMap;
  uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
  varying vec2 vUv; varying vec3 vColor; varying float vFogDepth;
  void main() {
    vec4 t = uHasMap > 0.5 ? texture2D(uMap, vUv) : vec4(1.0, 1.0, 1.0, 0.85);
    // round 7: coverage × min(1, colour peak) — the item icon (iColor white × its label-yield fade) fades out as a whole
    // (premultiplied: rgb and alpha scale together); an LDR colour ≥ 1 is unchanged
    float k = clamp(max(vColor.r, max(vColor.g, vColor.b)), 0.0, 1.0);
    float a = t.a * k;
    if (a < 0.02) discard;
    vec3 rgb = t.rgb * vColor;
    rgb = mix(rgb, fogColor * a, smoothstep(fogNear, fogFar, vFogDepth));
    gl_FragColor = vec4(rgb, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/**
 * A quad ShaderMaterial (per-instance uv rect attribute `uvAttr` + iColor) sampling `map`; transparent, unlit,
 * fogged; `toneMapped` as the caller asks (see above). Init-time only (the attribute rename is a string op on the
 * shader source).
 */
function makeQuadMaterial(map, uvAttr, toneMapped = false) {
  const m = new ShaderMaterial({
    vertexShader: uvAttr === 'iUv' ? QUAD_VERT : QUAD_VERT.split('iUv').join(uvAttr), fragmentShader: QUAD_FRAG,
    uniforms: {
      uMap: { value: map || null }, uHasMap: { value: map ? 1 : 0 },
      fogColor: { value: new Color() }, fogNear: { value: NO_FOG }, fogFar: { value: NO_FOG + 1 },
    },
    // TextureFactory's atlas / icon canvases are premultiplied (ARCH §6.3): the shader outputs premultiplied
    // colour, so blend with (ONE, ONE_MINUS_SRC_ALPHA)
    transparent: true, premultipliedAlpha: true, depthWrite: false, side: DoubleSide, toneMapped: !!toneMapped, fog: true,
  });
  m.forceSinglePass = true;   // flat camera-facing quads: no back/front two-pass draw (no per-frame version bumps)
  return m;
}

export class Gates {
  constructor(ctx) {
    this.ctx = ctx;
    this._inited = false;
  }

  // -------------------------------------------------------------------------------------------
  // init — pools (High capacity, allocated once), GPU objects, glyph UV cache
  // -------------------------------------------------------------------------------------------
  init() {
    const ctx = this.ctx;
    const N = GATE_POOL, E = EVENT_POOL;

    // ---- gate SoA ----
    this._op = new Uint8Array(N);
    this._valueF = new Float32Array(N);      // '+': value; '−': signed (negative until flipped); 'x' / '/': unused
    this._base = new Int32Array(N);
    this._cap = new Float32Array(N);         // '+': value cap; 'x': multiplier cap; '/': post-flip multiplier
    this._flipCap = new Float32Array(N);     // '−': post-flip positive cap (= base)
    this._stepCost = new Float32Array(N);    // 'x': weighted hits per step at the BASE multiplier; '/': per rung
    this._baseMult = new Int32Array(N);      // 'x': spawn multiplier (step cost scales with the current one)
    this._mult = new Int32Array(N);          // 'x': current multiplier; '/': flipTo after the flip
    this._hits = new Float32Array(N);        // hidden step accumulator (x / ÷)
    this._intake = new Float32Array(N);      // intake bucket (weighted hits available)
    this._state = new Uint8Array(N);
    this._x = new Float64Array(N);           // doubles: event payloads carry exact lane centres
    this._z = new Float64Array(N);
    this._lane = new Uint8Array(N);
    this._layout = new Uint8Array(N);
    this._eventSlot = new Int32Array(N);
    this._item = new Array(N).fill(null);
    this._maxed = new Uint8Array(N);
    this._flipped = new Uint8Array(N);
    this._popTime = new Float32Array(N);     // last hit (J3 glyph pop, restarts on every hit)
    this._flashTime = new Float32Array(N);   // last panel / frame hit-flash start (restarts ≥ GATE_RULES.fx.flashRetrigger apart)
    this._recentHits = new Float32Array(N);  // hits (calls) in the last ≈ INTAKE_WINDOW_S: +1 per hit, decays e^(−dt / window)
    this._stepTime = new Float32Array(N);
    this._flipTime = new Float32Array(N);
    this._maxTime = new Float32Array(N);
    this._armTime = new Float32Array(N);
    this._divStage = new Int8Array(N);
    this._decorative = new Uint8Array(N);
    this._generation = new Uint32Array(N).fill(1);
    this._live = new Uint8Array(N);
    this._maxCoinAcc = new Float32Array(N);  // fractional coins accumulated past MAX
    this._maxCoinPaid = new Int32Array(N);
    this._glowPhase = new Float32Array(N);   // rngFx cosmetic phase
    this._curType = new Int8Array(N);        // current colour type (T_*); a change starts a recolour
    this._rampFromType = new Int8Array(N);   // type before the running recolour
    this._rampStart = new Float32Array(N);   // recolour start (ctx.time.elapsed); runs GATE_RULES.minus.recolor
    this._hintOnHit = new Array(N).fill(null);
    this._hintOnPass = new Array(N).fill(null);
    this._hintIfOtherBetter = new Array(N).fill(null);
    // round 7 (r7 teaching:4): weighted hits taken since the last step, and their EMA (hits/s) for the reach projection
    this._wAcc = new Float32Array(N);
    this._rate = new Float32Array(N);
    // live gate list (dense, swap-remove) + inverse index
    this._liveSlots = new Int32Array(N);
    this._livePos = new Int32Array(N).fill(-1);
    this._liveCount = 0;
    // text cache (rebuilt only when the displayed text changes)
    this._glyphIdx = new Uint8Array(N * GLYPHS_PER_GATE_MAX);
    this._hasOp = new Uint8Array(N);         // first glyph is the small op glyph (GATE_RULES.glyph.icon)
    this._textCount = new Uint8Array(N);     // op + digit glyphs
    this._glyphCountOf = new Uint8Array(N);  // total glyph quads (text + badge)
    this._digitH = new Float32Array(N);      // digit quad height (m), after the fit-to-panel shrink
    this._opH = new Float32Array(N);         // op glyph quad height (m)
    this._textW = new Float32Array(N);       // total text advance (m)
    this._hasBadge = new Uint8Array(N);
    this._textDirty = new Uint8Array(N);
    this._textFade = new Float32Array(N).fill(1);   // round-3 FTUE: 1 = value text drawn, → 0 while under the count label
    this._fadeT = 0.5; this._fadeT = 0;             // ctx.time.elapsed of the last render() (fade step; Double from the start)
    this._cam = null;                                // render.camera, cached on first use (label-yield test)
    this._iconUV = new Float32Array(N * 4);
    this._hasIcon = new Uint8Array(N);
    this._views = new Array(N);
    for (let i = 0; i < N; i++) this._views[i] = makeView();

    // ---- event SoA ----
    this._evLayout = new Uint8Array(E);
    this._evLaneCount = new Uint8Array(E);
    this._evGates = new Int32Array(E * 3).fill(-1);
    this._evResolved = new Uint8Array(E);
    this._evDecal = new Int32Array(E).fill(-1);
    this._evDecalLane = new Int8Array(E).fill(-1);
    this._evDecalType = new Int8Array(E).fill(-1);
    this._evLockedLane = new Int8Array(E).fill(-1);
    this._evDecorative = new Uint8Array(E);
    this._evAttnUntil = new Float64Array(E);   // round 7 (pulseEvent): ctx.time.theatre (ms) until which the event's frames pulse
    this._evGen = new Uint32Array(E).fill(1);
    this._evLive = new Uint8Array(E);
    this._evLiveSlots = new Int32Array(E);
    this._evLivePos = new Int32Array(E).fill(-1);
    this._evLiveCount = 0;

    // ---- lane centre tables (contract: laneCenters(layout) returns a Float32Array) ----
    this._laneCenters = {
      single: Float32Array.from(WORLD.laneCenters.single),
      pair: Float32Array.from(WORLD.laneCenters.pair),
      triple: Float32Array.from(WORLD.laneCenters.triple),
    };
    // internal tables stay double precision (the frozen data arrays) so views / payloads carry exact centres
    this._laneTables = [WORLD.laneCenters.single, WORLD.laneCenters.pair, WORLD.laneCenters.triple];
    this._laneWidths = [WORLD.laneWidth.single, WORLD.laneWidth.pair, WORLD.laneWidth.triple];

    // ---- colour tables (linear RGB floats per type index, for glows / glyph tints) ----
    this._tintRGB = new Float32Array(TYPE_KEYS.length * 3);
    this._tintHex = new Int32Array(TYPE_KEYS.length);
    for (let t = 0; t < TYPE_KEYS.length; t++) {
      const hex = GATE_RULES.colors[TYPE_KEYS[t]].tint;
      this._tintHex[t] = hex;
      COLOR_A.setHex(hex);
      this._tintRGB[t * 3] = COLOR_A.r; this._tintRGB[t * 3 + 1] = COLOR_A.g; this._tintRGB[t * 3 + 2] = COLOR_A.b;
    }
    COLOR_A.setHex(GATE_RULES.colors.max);
    this._maxRGB = new Float32Array([COLOR_A.r, COLOR_A.g, COLOR_A.b]);
    COLOR_A.setHex(PALETTE.glyph.fill);
    this._glyphRGB = new Float32Array([COLOR_A.r, COLOR_A.g, COLOR_A.b]);

    // ---- glyph UV cache (one lookup per atlas glyph at init; never at runtime) ----
    this._glyphUV = new Float32Array(GLYPH_COUNT * 4);
    this._glyphAdv = new Float32Array(GLYPH_COUNT);
    this._glyphAspect = new Float32Array(GLYPH_COUNT);   // quad width / height for an unstretched glyph
    this._buildGlyphCache();

    // ---- GPU objects ----
    this._buildMeshes();

    this._fx = ctx.fx || null;
    this._inited = true;
    this._primeRender();
    return this;
  }

  /**
   * QA GAT-9 — JIT feedback priming (init only). render() runs every frame from boot, but for long stretches with no
   * gate, no flash, no flip and no MAX on screen, so V8 optimizes it before those branches ever ran; the first gate /
   * hit / flip / MAX then deoptimizes it ("insufficient type feedback", "not int32") and it runs in the baseline tier —
   * one HeapNumber per double operation, ≈ 4 MB/min at L9 — for seconds until it re-optimizes. Rendering throwaway
   * decorative gates that take every branch with fractional values a few times here gives every site its final
   * feedback up front (bullet query included). Decorative events emit nothing and own no decal; reset() frees them and hides the meshes.
   */
  _primeRender() {
    const time = this.ctx.time;
    const t = time && time.elapsed > 0 ? time.elapsed : 0;
    const ids = [
      this.spawnEvent({ layout: 'pair', z: -30.37, decorative: true, lanes: [{ op: '+', value: 12, cap: 48 }, { op: 'x', value: 2, step: 13.5 }] }),
      this.spawnEvent({ layout: 'triple', z: -20.61, decorative: true, lanes: [{ op: '-', value: 7 }, { op: '/', value: 3, step: 8.5 }, { op: 'item', item: 'weapon.shotgun' }] }),
      this.spawnEvent({ layout: 'single', z: -11.13, decorative: true, lanes: [{ op: '/', value: 2, step: 9.5 }] }),
    ];
    if (ids[0] < 0 || ids[1] < 0 || ids[2] < 0) { this.reset(); return; }
    const last = GATE_RULES.div.ladder.length - 1;
    const th = time && typeof time.theatre === 'number' ? time.theatre : 0;
    for (let pass = 0; pass < 3; pass++) {
      // round 7: the pulseEvent attention and the reach projection branches get their feedback too (pulsing / reaching on the
      // first two passes, idle on the third)
      for (let k = 0; k < ids.length; k++) this._evAttnUntil[ids[k] & 0xFFF] = pass < 2 ? th + 6e4 : 0;
      for (let i = 0; i < this._liveCount; i++) {
        const g = this._liveSlots[i];
        const op = this._op[g];
        this._rate[g] = pass < 2 ? 37.5 : 0.25;
        this._state[g] = pass === 0 ? ST_ARMED : (pass === 1 ? ST_LOCKED : (i % 2 === 0 ? ST_PASSED : ST_FAR));
        const live = pass < 2 ? 1 : 0;
        this._flashTime[g] = live ? t - 0.031 : FAR_PAST;
        this._popTime[g] = live ? t - 0.023 : FAR_PAST;
        this._flipTime[g] = live ? t - 0.057 : FAR_PAST;
        this._stepTime[g] = live ? t - 0.071 : FAR_PAST;
        this._maxTime[g] = live ? t - 0.049 : FAR_PAST;
        this._rampStart[g] = pass === 0 ? t - 0.13 : (pass === 1 ? t - 0.31 : FAR_PAST);   // recolour: 1st half, 2nd half, none
        this._rampFromType[g] = pass === 0 ? T_MINUS : T_DIV;
        this._recentHits[g] = 2.37;
        this._hits[g] = 3.71;
        if (op === OP_PLUS && pass > 0) { this._maxed[g] = 1; this._valueF[g] = this._cap[g]; this._textDirty[g] = 1; }
        if (op === OP_MULT && pass === 1) { this._mult[g] = this._cap[g] > 0 ? this._cap[g] : this._mult[g]; this._textDirty[g] = 1; }
        if (op === OP_DIV) { this._divStage[g] = pass === 0 ? 0 : last; if (pass === 2) { this._flipped[g] = 1; this._mult[g] = 2; } this._textDirty[g] = 1; }
        if (op === OP_MINUS && pass > 0) { this._flipped[g] = 1; this._valueF[g] = 3.5; this._textDirty[g] = 1; }
        this._updateTint(g);
      }
      // ≥ 8 calls per state: V8 allocates a function's feedback vector lazily (after a few invocations), and
      // feedback is only recorded once it exists
      for (let n = 0; n < 4; n++) { this.render(0.37); this.render(0.81); }
    }
    // the bullet query (weapons' sweep): shootable lanes need decorative 0 + armed — only for these calls
    const seg = SEG_IN, out = { gate: null, t: 0.5, x: 0.5, y: 0.5, z: 0.5 };
    for (let i = 0; i < this._liveCount; i++) { const g = this._liveSlots[i]; this._decorative[g] = 0; this._state[g] = ST_ARMED; }
    for (let n = 0; n < 12; n++) {
      seg[0] = -2.03; seg[1] = -0.5; seg[2] = -1.91; seg[3] = -45.5; this.hitTestSeg(seg, out);   // hits the pair's + lane
      seg[0] = 0.07; seg[1] = -0.5; seg[2] = 0.07; seg[3] = -45.5; this.hitTestSeg(seg, out);     // vertical: the dx ≈ 0 slab
      seg[0] = 7.5; seg[1] = -0.5; seg[2] = 7.9; seg[3] = -45.5; this.hitTestSeg(seg, out);       // misses everything
    }
    out.gate = null;
    this.reset();
  }

  /** Fills the glyph UV / advance cache from TextureFactory.glyphUV, or from RENDER.atlas when absent. */
  _buildGlyphCache() {
    const tex = this.ctx.render && this.ctx.render.textures;
    const atlasW = RENDER.textures.digitAtlas[0], atlasH = RENDER.textures.digitAtlas[1];
    const cellW = RENDER.atlas.cell[0], cellH = RENDER.atlas.cell[1], inset = RENDER.atlas.insetPx;
    for (let g = 0; g < GLYPH_COUNT; g++) {
      const ch = GLYPH_CHARS[g];
      let ok = false;
      if (tex && typeof tex.glyphUV === 'function') {
        try {
          tex.glyphUV(ch, UV_OUT);
          ok = Number.isFinite(UV_OUT.u0) && Number.isFinite(UV_OUT.advance) && UV_OUT.advance > 0 && UV_OUT.u1 > UV_OUT.u0;
        } catch (_) { ok = false; }
      }
      if (!ok) {
        // Same layout as ARCH §6.3: 2 rows × 10 cells, cell 102×128, inset 2 px, canvas row 0 at the top (flipY)
        const row = g < 10 ? 0 : 1, col = g < 10 ? g : g - 10;
        UV_OUT.u0 = (col * cellW + inset) / atlasW;
        UV_OUT.u1 = ((col + 1) * cellW - inset) / atlasW;
        UV_OUT.v1 = 1 - (row * cellH + inset) / atlasH;
        UV_OUT.v0 = 1 - ((row + 1) * cellH - inset) / atlasH;
        const adv = RENDER.atlas.advance;
        UV_OUT.advance = g < 10 ? adv.digit : (adv[ch] !== undefined ? adv[ch] : adv.digit);
      }
      this._glyphUV[g * 4] = UV_OUT.u0; this._glyphUV[g * 4 + 1] = UV_OUT.v0;
      this._glyphUV[g * 4 + 2] = UV_OUT.u1; this._glyphUV[g * 4 + 3] = UV_OUT.v1;
      this._glyphAdv[g] = UV_OUT.advance;
      const du = Math.abs(UV_OUT.u1 - UV_OUT.u0) * atlasW, dv = Math.abs(UV_OUT.v1 - UV_OUT.v0) * atlasH;
      this._glyphAspect[g] = dv > 0 ? du / dv : (cellW - 2 * inset) / (cellH - 2 * inset);
    }
  }

  /** Builds the four instanced draws (+ the count-gated icon draw) and adds them to the scene. */
  _buildMeshes() {
    const ctx = this.ctx;
    const render = ctx.render || null;
    const models = ctx.models || null;
    const mats = render && render.materials ? render.materials : null;
    const tex = render && render.textures ? render.textures : null;
    const geo = models && models.geo ? models.geo : null;
    const N = GATE_POOL;
    this._ownGeos = [];
    this._ownMats = [];

    // --- frames (geometry cloned so the per-instance attribute never touches the shared library geometry) ---
    const frameGeo = geo && geo.gateFrame ? geo.gateFrame.clone() : this._fallbackFrameGeo();
    this._ownGeos.push(frameGeo);
    this._iFrame = tagRange(new InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(DynamicDrawUsage));
    frameGeo.setAttribute('iFrame', this._iFrame);
    let frameMat = null;
    if (mats && typeof mats.gateFrame === 'function') { try { frameMat = mats.gateFrame(); } catch (_) { frameMat = null; } }
    if (!frameMat) {
      frameMat = new MeshStandardMaterial({
        color: GATE_RULES.colors.plus.frame, emissive: GATE_RULES.colors.plus.frame, emissiveIntensity: RENDER.gateFrameEmissive * FAR_EMISSIVE,
        roughness: PALETTE.material.metal.roughness, metalness: PALETTE.material.metal.metalness,
      });
      this._ownMats.push(frameMat);
    }
    this.frames = this._makeInstanced(frameGeo, frameMat, N, 0);

    // --- panels ---
    const panelGeo = geo && geo.gatePanel ? geo.gatePanel.clone() : new PlaneGeometry(GATE_RULES.panel.w, GATE_RULES.panel.h);
    this._ownGeos.push(panelGeo);
    this._iPanel = tagRange(new InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(DynamicDrawUsage));
    this._iScale = tagRange(new InstancedBufferAttribute(new Float32Array(N).fill(1), 1).setUsage(DynamicDrawUsage));
    panelGeo.setAttribute('iPanel', this._iPanel);
    panelGeo.setAttribute('iScale', this._iScale);
    let panelMat = null;
    if (mats && typeof mats.gatePanel === 'function') { try { panelMat = mats.gatePanel(); } catch (_) { panelMat = null; } }
    // fallback (no library): a plain tinted quad coloured per instance from the same type colours
    if (!panelMat) {
      panelMat = new MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: GATE_RULES.panel.opacity, side: DoubleSide, depthWrite: false });
      this._ownMats.push(panelMat);
      this._panelFallbackColor = tagRange(new InstancedBufferAttribute(new Float32Array(N * 3), 3).setUsage(DynamicDrawUsage));
    } else {
      this._panelFallbackColor = null;
    }
    this.panels = this._makeInstanced(panelGeo, panelMat, N, 2);
    if (this._panelFallbackColor) this.panels.instanceColor = this._panelFallbackColor;

    // --- glows (additive quad behind each panel; brighter on Low where it replaces bloom) ---
    const glowGeo = new PlaneGeometry(1, 1);
    this._ownGeos.push(glowGeo);
    const glowMat = new MeshBasicMaterial({
      color: 0xFFFFFF, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide, fog: false,
    });
    // an additive glow needs no back/front ordering: one pass, not three's transparent-DoubleSide two-pass path
    // (which bumps material.version twice per frame → WebGLPrograms.getParameters twice + 2 draws)
    glowMat.forceSinglePass = true;
    if (tex && tex.glow) glowMat.map = tex.glow;
    this._ownMats.push(glowMat);
    this.glows = this._makeInstanced(glowGeo, glowMat, N, 1);
    this.glows.instanceColor = tagRange(new InstancedBufferAttribute(new Float32Array(N * 3), 3).setUsage(DynamicDrawUsage));

    // --- glyph quads (digit atlas) ---
    const glyphGeo = new PlaneGeometry(1, 1);
    this._ownGeos.push(glyphGeo);
    this._iGlyph = tagRange(new InstancedBufferAttribute(new Float32Array(GLYPH_POOL * 4), 4).setUsage(DynamicDrawUsage));
    this._iPopTime = new InstancedBufferAttribute(new Float32Array(GLYPH_POOL).fill(INERT_POP_TIME), 1);   // static: never updated
    this._iColor = tagRange(new InstancedBufferAttribute(new Float32Array(GLYPH_POOL * 3), 3).setUsage(DynamicDrawUsage));
    glyphGeo.setAttribute('iGlyph', this._iGlyph);
    glyphGeo.setAttribute('iPopTime', this._iPopTime);
    glyphGeo.setAttribute('iColor', this._iColor);
    let glyphMat = null;
    if (mats && typeof mats.glyph === 'function') {
      try {
        const shared = mats.glyph(false);
        if (shared && shared.isShaderMaterial && shared.uniforms) {
          // Own copy so the uBillboard flag (fx billboards its quads with the same shader) never leaks between
          // owners. Every other uniform object is re-linked to the library's (atlas texture, uTime, pop
          // constants, fog), so the copy shares textures and the one clock instead of cloning them.
          glyphMat = shared.clone();
          const keys = Object.keys(shared.uniforms);
          for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            glyphMat.uniforms[key] = key === 'uBillboard' ? { value: 0 } : shared.uniforms[key];
          }
          this._ownMats.push(glyphMat);
        } else if (shared) {
          glyphMat = shared;                       // a non-shader material: use as is (not owned)
        }
      } catch (_) { glyphMat = null; }
    }
    if (!glyphMat) {
      glyphMat = makeQuadMaterial(tex && tex.digitAtlas ? tex.digitAtlas : null, 'iGlyph');
      this._ownMats.push(glyphMat);
    }
    this.glyphs = this._makeInstanced(glyphGeo, glyphMat, GLYPH_POOL, 3);

    // --- item icon quads (own shader on TextureFactory.icons; 0 draws while no item lane is live) ---
    const iconGeo = new PlaneGeometry(1, 1);
    this._ownGeos.push(iconGeo);
    this._iIconUV = tagRange(new InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(DynamicDrawUsage));
    this._iIconColor = tagRange(new InstancedBufferAttribute(new Float32Array(N * 3), 3).setUsage(DynamicDrawUsage));
    iconGeo.setAttribute('iUv', this._iIconUV);
    iconGeo.setAttribute('iColor', this._iIconColor);
    const iconMat = makeQuadMaterial(tex && tex.icons ? tex.icons : null, 'iUv', true);   // LDR pictogram: tone-mapped on Low too
    this._ownMats.push(iconMat);
    this.icons = this._makeInstanced(iconGeo, iconMat, N, 3);
    this._iconUVOk = !!(tex && typeof tex.iconUV === 'function');

    const scene = render && render.scene ? render.scene : null;
    this._scene = scene;
    if (scene) { scene.add(this.frames); scene.add(this.glows); scene.add(this.panels); scene.add(this.glyphs); scene.add(this.icons); }
  }

  _makeInstanced(geometry, material, capacity, renderOrder) {
    const mesh = new InstancedMesh(geometry, material, capacity);
    tagRange(mesh.instanceMatrix.setUsage(DynamicDrawUsage));
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = renderOrder;
    mesh.name = 'gates';
    return mesh;
  }

  /** Two posts + top bar (GATE_RULES.frame) merged into one geometry — used only when models.geo.gateFrame is absent. */
  _fallbackFrameGeo() {
    const f = GATE_RULES.frame;
    const left = new BoxGeometry(f.postW, f.postH, f.postW).translate(-(f.barW / 2 - f.postW / 2), f.postH / 2, 0);
    const right = new BoxGeometry(f.postW, f.postH, f.postW).translate(f.barW / 2 - f.postW / 2, f.postH / 2, 0);
    const bar = new BoxGeometry(f.barW, f.postW, f.postW).translate(0, f.postH + f.postW / 2, 0);
    const merged = mergeGeometries([left, right, bar], false);
    if (merged) { left.dispose(); right.dispose(); bar.dispose(); return merged; }
    right.dispose(); bar.dispose();
    return left;
  }

  // -------------------------------------------------------------------------------------------
  // Ids, views and per-gate derived state
  // -------------------------------------------------------------------------------------------
  _gateId(slot) { return ((this._generation[slot] << 12) | slot) >>> 0; }
  _eventId(slot) { return ((this._evGen[slot] << 12) | slot) >>> 0; }

  /** Resolves a gate id (or a gate view carrying one) to its slot, or −1 for a stale / foreign id. */
  _gateSlot(id) {
    if (id !== null && typeof id === 'object') id = id.id;
    if (typeof id !== 'number' || id < 0) return -1;
    const slot = id & 0xFFF;
    if (slot >= GATE_POOL || !this._live[slot]) return -1;
    if ((id >>> 12) !== this._generation[slot]) return -1;
    return slot;
  }

  /** Step cost (weighted hits) of the NEXT step of a gate: x → K_M scales with the current multiplier
   *  (GDD §4.2: L1 x2→x3 52 hits, x3→x4 77 more); ÷ → K_÷ per rung, 2·K_÷ for the x1 → x2 flip. */
  _stepNeed(g) {
    if (this._op[g] === OP_MULT) {
      const bm = this._baseMult[g] > 0 ? this._baseMult[g] : 1;
      return Math.max(1, Math.round(this._stepCost[g] * this._mult[g] / bm));
    }
    const last = GATE_RULES.div.ladder.length - 1;
    const k = this._stepCost[g] > 0 ? this._stepCost[g] : 1;
    return this._divStage[g] >= last ? k * GATE_RULES.div.flipStepMult : k;
  }

  /** _stepNeed(g) into NEED[0] (render: no double return value to box). */
  _stepNeedTo(g) {
    if (this._op[g] === OP_MULT) {
      const bm = this._baseMult[g] > 0 ? this._baseMult[g] : 1;
      NEED[0] = Math.max(1, Math.round(this._stepCost[g] * this._mult[g] / bm));
      return;
    }
    const k = this._stepCost[g] > 0 ? this._stepCost[g] : 1;
    NEED[0] = this._divStage[g] >= GATE_RULES.div.ladder.length - 1 ? k * GATE_RULES.div.flipStepMult : k;
  }

  /** The current display value of a gate: '+' / '−' → signed integer value; 'x' → multiplier; '/' → divisor (or flipTo). */
  _displayValue(g) {
    const op = this._op[g];
    if (op === OP_PLUS || op === OP_MINUS) return intValueAt(this._valueF, g);
    if (op === OP_MULT) return this._mult[g];
    if (op === OP_DIV) return this._flipped[g] ? this._mult[g] : GATE_RULES.div.ladder[this._divStage[g]];
    return 0;
  }

  /** Current static colour type of a gate (GDD §4.1 table incl. the x1 / 0 neutral state). */
  _typeIdx(g) {
    const op = this._op[g];
    if (op === OP_ITEM) return T_ITEM;
    if (op === OP_PLUS) return T_PLUS;
    if (op === OP_MULT) return T_MULT;
    if (op === OP_MINUS) {
      if (!this._flipped[g]) return T_MINUS;
      return intValueAt(this._valueF, g) <= 0 ? T_ZERO : T_PLUS;
    }
    if (this._flipped[g]) return T_MULT;
    return GATE_RULES.div.ladder[this._divStage[g]] <= 1 ? T_ZERO : T_DIV;
  }

  /** Starts a recolour (GATE_RULES.minus.recolor: old colour → grey → new colour) when the colour type changed. */
  _updateTint(g) {
    const ty = this._typeIdx(g);
    if (ty === this._curType[g]) return;
    this._rampFromType[g] = this._curType[g];
    this._curType[g] = ty;
    this._rampStart[g] = this.ctx.time ? this.ctx.time.elapsed : 0;
  }

  /**
   * Linear RGB of a gate's displayed colour (from → grey → current while recolouring) into RGB_OUT; the recolour
   * progress u is read from TU[0] (integer-only call, see MA).
   */
  _currentRGB(g) {
    const u = TU[0];
    const tint = this._tintRGB;
    const cur = this._curType[g] * 3;
    const zero = T_ZERO * 3;
    // integer lane selection, one double blend (no double phis — see render): not running → cur; first half
    // from → grey (k = 2u); second half grey → cur (k = 2u − 1)
    const second = u > 0.5 ? 1 : 0;
    const a = u <= 0 ? cur : (second === 1 ? zero : this._rampFromType[g] * 3);
    const b = u <= 0 ? cur : (second === 1 ? cur : zero);
    const k = u * 2 - second;
    RGB_OUT[0] = tint[a] + (tint[b] - tint[a]) * k;
    RGB_OUT[1] = tint[a + 1] + (tint[b + 1] - tint[a + 1]) * k;
    RGB_OUT[2] = tint[a + 2] + (tint[b + 2] - tint[a + 2]) * k;
    return RGB_OUT;
  }

  /** Refreshes the read-only view of gate slot g (the only object listeners ever see). */
  _syncView(g) {
    const v = this._views[g];
    v.id = this._gateId(g);
    v.op = OP_STR[this._op[g]];
    v.value = this._displayValue(g);
    v.base = this._base[g];
    v.mult = this._op[g] === OP_MULT || (this._op[g] === OP_DIV && this._flipped[g]) ? this._mult[g] : 1;
    v.x = this._x[g];
    v.z = this._z[g];
    v.lane = this._lane[g];
    v.layout = LAYOUT_STR[this._layout[g]];
    v.state = STATE_STR[this._state[g]];
    v.maxed = this._maxed[g] === 1;
    v.flipped = this._flipped[g] === 1;
    v.item = this._item[g];
    v.hintOnHit = this._hintOnHit[g];
    v.hintOnPass = this._hintOnPass[g];
    v.hintIfOtherBetter = this._hintIfOtherBetter[g];
    return v;
  }

  // -------------------------------------------------------------------------------------------
  // Public queries
  // -------------------------------------------------------------------------------------------
  /** Lane centre x values for a layout (shared Float32Array, do not mutate). */
  laneCenters(layout) {
    const t = this._laneCenters[layout];
    return t || this._laneCenters.pair;
  }

  /**
   * Round 7 (r7 teaching:0 part E; contract C → D, DECISIONS §6): points at an event while a held lesson hint talks about it — its
   * gate frames (and glow quads) pulse, emissive + GATE_RULES.fx.attnGain·(0.5 + 0.5·sin(attnRadPerS·t)), for `seconds` of theatre
   * time (ctx.time.theatre: real time, paused time excluded, so it matches the hint's own hold); `seconds` ≤ 0 stops it. The pulse
   * ends by itself when the event resolves (pass / miss) or is freed. `eventId` is the stable handle spawnEvent returned (or an
   * object carrying it as `eventId`). Returns true when the event is live and unresolved. Event-time only (never per frame).
   */
  pulseEvent(eventId, seconds) {
    if (!this._inited) return false;
    const id = eventId !== null && typeof eventId === 'object' ? eventId.eventId : eventId;
    if (typeof id !== 'number' || !(id >= 0)) return false;
    const e = id & 0xFFF;
    if (e >= EVENT_POOL || !this._evLive[e] || (id >>> 12) !== this._evGen[e] || this._evResolved[e] || this._evDecorative[e]) return false;
    const time = this.ctx.time;
    const now = time && typeof time.theatre === 'number' ? time.theatre : 0;
    this._evAttnUntil[e] = Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : 0;
    return true;
  }

  /**
   * Nearest unpassed (non-decorative) event, or null. Returns a reused object whose `lanes` are the live gate
   * views in lane order (state, x, z, layout, op, value … per ARCH §5.1) — weapons can use it for the rocket /
   * rail / laser panel tests. Do not retain.
   */
  get activeEvent() {
    let best = -1, bestZ = -Infinity;
    for (let i = 0; i < this._evLiveCount; i++) {
      const e = this._evLiveSlots[i];
      if (this._evResolved[e] || this._evDecorative[e]) continue;
      const g0 = this._evGates[e * 3];
      if (g0 < 0) continue;
      const z = this._z[g0];
      if (z > bestZ) { bestZ = z; best = e; }
    }
    if (best < 0) return null;
    const n = this._evLaneCount[best];
    const lanes = LANES_BY_COUNT[n];
    ACTIVE_EVENT.id = this._eventId(best);
    ACTIVE_EVENT.layout = LAYOUT_STR[this._evLayout[best]];
    ACTIVE_EVENT.z = bestZ;
    for (let l = 0; l < n; l++) lanes[l] = this._syncView(this._evGates[best * 3 + l]);
    ACTIVE_EVENT.lanes = lanes;
    return ACTIVE_EVENT;
  }

  /**
   * Swept XZ test of a bullet segment against every shootable panel footprint
   * ((lane width − 0.2) × GATE_RULES.panel.depth, centred on the gate; height ignored — ARCH §7,
   * GATE_RULES.panel.hitIgnoresY). Only gates with state ∈ {armed, locked} and z < WORLD.gateStopZ; item lanes
   * ("not shootable", GDD §8) and decorative gates are neither targets nor walls.
   * out = { gate: GateView, x, y: FIRE.bullet.y, z, t } with t ∈ [0, 1] = entry point along the segment.
   * Kept for callers with loose numbers; the hot path is hitTestSeg (no double arguments to box).
   */
  hitTestSegment(x0, z0, x1, z1, out) {
    SEG_IN[0] = x0; SEG_IN[1] = z0; SEG_IN[2] = x1; SEG_IN[3] = z1;
    return this.hitTestSeg(SEG_IN, out);
  }

  /**
   * hitTestSegment with the segment read from a shared Float64Array(4) `seg` = (x0, z0, x1, z1) — same semantics
   * and `out` shape (QA GAT-9 / WPN-8: passing four doubles to a non-inlined call boxes each one per bullet).
   */
  hitTestSeg(seg, out) {
    if (this._liveCount === 0) return false;               // no gate on the road (no double math at all)
    const x0 = seg[0], z0 = seg[1], x1 = seg[2], z1 = seg[3];
    let bestT = Infinity, bestG = -1;
    const dx = x1 - x0, dz = z1 - z0;
    const hd = GATE_RULES.panel.depth * 0.5;
    for (let i = 0; i < this._liveCount; i++) {
      const g = this._liveSlots[i];
      const st = this._state[g];
      if (st !== ST_ARMED && st !== ST_LOCKED) continue;
      if (this._decorative[g] || this._op[g] === OP_ITEM) continue;
      const gz = this._z[g];
      if (gz >= WORLD.gateStopZ) continue;
      const hw = (this._laneWidths[this._layout[g]] - HIT_INSET_M) * 0.5;
      const minX = this._x[g] - hw, maxX = this._x[g] + hw;
      const minZ = gz - hd, maxZ = gz + hd;
      // slab test (Liang–Barsky) over t ∈ [0, 1]
      let t0 = 0, t1 = 1;
      if (dx > -EPS && dx < EPS) {
        if (x0 < minX || x0 > maxX) continue;
      } else {
        const inv = 1 / dx;
        let ta = (minX - x0) * inv, tb = (maxX - x0) * inv;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (dz > -EPS && dz < EPS) {
        if (z0 < minZ || z0 > maxZ) continue;
      } else {
        const inv = 1 / dz;
        let ta = (minZ - z0) * inv, tb = (maxZ - z0) * inv;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (t0 < bestT) { bestT = t0; bestG = g; }
    }
    if (bestG < 0) return false;
    out.gate = this._syncView(bestG);
    out.t = bestT;
    out.x = x0 + dx * bestT;
    out.y = FIRE.bullet.y;
    out.z = z0 + dz * bestT;
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------------------------
  /**
   * Spawns one gate event (all lanes at the same z). Lanes carry their caps from the script (ARCH D19); the
   * lane objects are read, never retained (level reuses its idle event object). Returns the stable event id,
   * or −1 when a pool is full (the request is dropped and counted in ctx.debug.dropped.gates).
   */
  spawnEvent(ev) {
    const lanes = ev && ev.lanes;
    const laneCount = lanes ? lanes.length : 0;
    const layoutIdx = ev && ev.layout === 'single' ? 0 : (ev && ev.layout === 'triple' ? 2 : 1);
    if (laneCount < 1 || laneCount > 3 || this._evLiveCount >= EVENT_POOL || this._liveCount + laneCount > GATE_POOL) {
      this._drop('gates');
      return -1;
    }
    let e = -1;
    for (let i = 0; i < EVENT_POOL; i++) if (!this._evLive[i]) { e = i; break; }
    if (e < 0) { this._drop('gates'); return -1; }
    const z = ev.z !== undefined && ev.z !== null ? ev.z : WORLD.spawnZ;
    const decorative = ev.decorative === true;
    const centers = this._laneTables[layoutIdx];
    const rngFx = this.ctx.rngFx;

    this._evLive[e] = 1;
    this._evLayout[e] = layoutIdx;
    this._evLaneCount[e] = laneCount;
    this._evResolved[e] = 0;
    this._evDecal[e] = -1;
    this._evDecalLane[e] = -1;
    this._evDecalType[e] = -1;
    this._evLockedLane[e] = -1;
    this._evDecorative[e] = decorative ? 1 : 0;
    this._evAttnUntil[e] = 0;
    this._evLivePos[e] = this._evLiveCount;
    this._evLiveSlots[this._evLiveCount++] = e;

    for (let l = 0; l < laneCount; l++) {
      const lane = lanes[l];
      let g = -1;
      for (let i = 0; i < GATE_POOL; i++) if (!this._live[i]) { g = i; break; }
      // (capacity was checked above, so g is always valid here)
      this._live[g] = 1;
      this._livePos[g] = this._liveCount;
      this._liveSlots[this._liveCount++] = g;
      this._evGates[e * 3 + l] = g;

      const opStr = lane.op;
      const op = opStr === '+' ? OP_PLUS : opStr === '-' ? OP_MINUS : opStr === 'x' ? OP_MULT : opStr === '/' ? OP_DIV : OP_ITEM;
      const raw = lane.value !== undefined && lane.value !== null ? +lane.value : 0;
      const value = Math.abs(Math.round(raw));        // magnitudes; the op carries the sign
      this._op[g] = op;
      this._base[g] = value;
      this._state[g] = ST_FAR;
      this._x[g] = centers[l < centers.length ? l : centers.length - 1];
      this._z[g] = z;
      this._lane[g] = l;
      this._layout[g] = layoutIdx;
      this._eventSlot[g] = e;
      this._item[g] = op === OP_ITEM ? (lane.item || null) : null;
      this._maxed[g] = 0;
      this._flipped[g] = 0;
      this._hits[g] = 0;
      this._intake[g] = INTAKE_CAP;
      this._popTime[g] = FAR_PAST;
      this._flashTime[g] = FAR_PAST;
      this._recentHits[g] = 0;
      this._wAcc[g] = 0;
      this._rate[g] = 0;
      this._stepTime[g] = FAR_PAST;
      this._flipTime[g] = FAR_PAST;
      this._maxTime[g] = FAR_PAST;
      this._armTime[g] = FAR_PAST;
      this._rampStart[g] = FAR_PAST;
      this._decorative[g] = decorative ? 1 : 0;
      this._maxCoinAcc[g] = 0;
      this._maxCoinPaid[g] = 0;
      this._glowPhase[g] = rngFx ? rngFx.range(0, Math.PI * 2) : 0;   // cosmetic only (ARCH §6.9 "ctx.rngFx")
      this._hintOnHit[g] = lane.hintOnHit || null;
      this._hintOnPass[g] = lane.hintOnPass || null;
      this._hintIfOtherBetter[g] = lane.hintIfOtherBetter || null;
      this._textDirty[g] = 1;
      this._textFade[g] = 1;
      this._hasIcon[g] = 0;

      // op-specific state; caps always come from the script (gateDefaults ran in levelgen — ARCH D19); the
      // fallbacks below only keep a malformed authored lane playable and mirror gateDefaults' floors.
      if (op === OP_PLUS) {
        this._valueF[g] = value;
        this._cap[g] = lane.cap > 0 ? lane.cap : Math.max(GATE_RULES.plus.capMin, GATE_RULES.plus.capMult * value);
        this._flipCap[g] = 0; this._stepCost[g] = 0; this._mult[g] = 1; this._baseMult[g] = 1; this._divStage[g] = 0;
      } else if (op === OP_MINUS) {
        this._valueF[g] = -value;
        this._flipCap[g] = lane.flipCap > 0 ? lane.flipCap : value;
        this._cap[g] = this._flipCap[g]; this._stepCost[g] = 0; this._mult[g] = 1; this._baseMult[g] = 1; this._divStage[g] = 0;
      } else if (op === OP_MULT) {
        const m = value >= 1 ? value : GATE_RULES.mult.base;
        this._mult[g] = m; this._baseMult[g] = m; this._base[g] = m;
        this._cap[g] = lane.cap > 0 ? lane.cap : GATE_RULES.mult.cap;
        this._stepCost[g] = lane.step > 0 ? lane.step : GATE_RULES.mult.stepMin * m;
        this._valueF[g] = m; this._flipCap[g] = 0; this._divStage[g] = 0;
      } else if (op === OP_DIV) {
        const ladder = GATE_RULES.div.ladder;
        let stage = 0;
        for (let s = 0; s < ladder.length; s++) if (ladder[s] === value) { stage = s; break; }
        this._divStage[g] = stage;
        this._base[g] = ladder[stage];
        this._mult[g] = 1; this._baseMult[g] = 1;
        this._cap[g] = lane.cap > 0 ? lane.cap : GATE_RULES.div.flipTo;
        this._stepCost[g] = lane.step > 0 ? lane.step : GATE_RULES.div.stepMin;
        this._valueF[g] = ladder[stage]; this._flipCap[g] = 0;
      } else {
        this._valueF[g] = 0; this._cap[g] = 0; this._flipCap[g] = 0; this._stepCost[g] = 0; this._mult[g] = 1; this._baseMult[g] = 1; this._divStage[g] = 0;
      }
      // colour type at spawn (an authored ÷1 starts grey) — no recolour
      this._curType[g] = this._typeIdx(g);
      this._rampFromType[g] = this._curType[g];
    }

    const eventId = this._eventId(e);
    if (!decorative) {
      const ctx = this.ctx;
      const events = ctx.events;
      // ARCH §6.9: ev.hint is forwarded to level.showHint at spawn (once-ever, so level showing it too is harmless)
      if (ev.hint && ctx.level && typeof ctx.level.showHint === 'function') ctx.level.showHint(ev.hint);
      if (events) {
        P_EVENT.eventId = eventId; P_EVENT.layout = LAYOUT_STR[layoutIdx]; P_EVENT.z = z; P_EVENT.hint = ev.hint || null;
        events.emit('gate:event', P_EVENT);
        for (let l = 0; l < laneCount; l++) {
          P_SPAWN.gate = this._syncView(this._evGates[e * 3 + l]); P_SPAWN.eventId = eventId; P_SPAWN.laneIndex = l; P_SPAWN.laneCount = laneCount;
          events.emit('gate:spawn', P_SPAWN);
        }
      }
    }
    return eventId;
  }

  _drop(name) {
    const d = this.ctx.debug;
    if (d && d.dropped) d.dropped[name] = (d.dropped[name] | 0) + 1;
  }

  // -------------------------------------------------------------------------------------------
  // Per-hit rules (GDD §4.2) — called by weapons for bullets / pellets / rockets / rail bolts / laser beams
  // -------------------------------------------------------------------------------------------
  /**
   * Applies `weight` weighted hits to a gate (id or view). Ignored when the gate is stale, not armed/locked,
   * at or past WORLD.gateStopZ, decorative or an item lane. The intake bucket (GATE_RULES.intakePerSec,
   * INTAKE_WINDOW_S burst) discards the excess; a fully discarded hit still pops the panel (feedback) but
   * changes nothing and emits nothing. Emits gate:hit, then gate:step / gate:flip / gate:max as they happen,
   * and coin:pickup { source:'max' } for whole coins earned past MAX (≤ GATE_RULES.plus.maxCoins per gate).
   */
  applyHit(gateId, weight, x, y, z) {
    const g = this._gateSlot(gateId);
    if (g < 0) return;
    const st = this._state[g];
    if (st !== ST_ARMED && st !== ST_LOCKED) return;
    if (this._z[g] >= WORLD.gateStopZ) return;
    if (this._decorative[g] || this._op[g] === OP_ITEM) return;
    if (!(weight > 0)) return;
    const now = this.ctx.time ? this.ctx.time.elapsed : 0;

    // intake budget: GATE_RULES.intakePerSec weighted hits/s, excess discarded
    const w = Math.min(weight, this._intake[g]);            // (Math.min: no double phi to box — GAT-9)
    if (w <= EPS) {
      // a fully discarded hit still pops the glyphs; the panel / frame flash restarts at most every flashRetrigger
      this._popTime[g] = now;
      this._recentHits[g] += 1;
      if (now - this._flashTime[g] >= GATE_RULES.fx.flashRetrigger) this._flashTime[g] = now;
      return;
    }
    this._intake[g] -= w;
    this._wAcc[g] += w;                                        // round 7: the accepted weighted hits feed the reach-rate EMA (step)

    const prev = this._displayValue(g);
    const op = this._op[g];
    const coinPerHit = GATE_RULES.plus.coinPerHit;
    let maxedNow = false, flippedNow = false, steps = 0;

    if (op === OP_PLUS) {
      if (this._maxed[g]) {
        this._maxCoinAcc[g] += w * coinPerHit;                 // every weighted hit past MAX pays
      } else {
        this._valueF[g] += w;                                  // +1 per weighted hit
        const cap = this._cap[g];
        if (this._valueF[g] >= cap - EPS) {
          this._maxCoinAcc[g] += (this._valueF[g] - cap) * coinPerHit;   // the part of this hit beyond the cap
          this._valueF[g] = cap;
          maxedNow = true;
        }
      }
    } else if (op === OP_MINUS) {
      // GDD §4.2: +1 toward 0 per hit, then +1 per hit up to +base — a terminal clamp, NOT a MAX state:
      // no gold badge, no gate:max, no MAX coins (§9.1 MAX coins belong to +N gates); pays coins.pass on pass
      this._valueF[g] += w;
      if (!this._flipped[g] && this._valueF[g] >= -EPS) {
        if (this._valueF[g] < 0) this._valueF[g] = 0;
        flippedNow = true;                                     // crossed 0 (GDD §4.2 / J5)
      }
      const cap = this._flipCap[g];
      if ((this._flipped[g] || flippedNow) && this._valueF[g] > cap) this._valueF[g] = cap;
    } else if (op === OP_MULT) {
      if (this._mult[g] < this._cap[g]) {
        this._hits[g] += w;
        let need = this._stepNeed(g);
        while (this._hits[g] >= need - EPS && this._mult[g] < this._cap[g]) {
          this._hits[g] -= need;
          this._mult[g] += 1;
          steps++;
          need = this._stepNeed(g);
        }
        if (this._mult[g] >= this._cap[g]) this._hits[g] = 0;
      }
    } else if (op === OP_DIV) {
      if (!this._flipped[g]) {
        const last = GATE_RULES.div.ladder.length - 1;
        this._hits[g] += w;
        for (;;) {
          const need = this._stepNeed(g);
          if (this._hits[g] < need - EPS) break;
          this._hits[g] -= need;
          if (this._divStage[g] < last) {
            this._divStage[g] += 1;                            // ÷3 → ÷2 → x1
            steps++;
          } else {
            this._mult[g] = this._cap[g] > 0 ? this._cap[g] : GATE_RULES.div.flipTo;   // x1 → x2
            this._hits[g] = 0;
            flippedNow = true;
            break;
          }
        }
      }
    }

    if (flippedNow) { this._flipped[g] = 1; this._flipTime[g] = now; }
    if (maxedNow) { this._maxed[g] = 1; this._maxTime[g] = now; }
    if (steps > 0) this._stepTime[g] = now;
    this._popTime[g] = now;                                    // J3 glyph pop: every hit
    this._recentHits[g] += 1;                                  // sustained-fire flash attenuation (render)
    // J3 panel / frame flash: restarts only flashRetrigger (> panel.hitFlash) after the last start, so sustained
    // fire reads as a pulse instead of a held white (render() also attenuates it by the recent intake)
    if (now - this._flashTime[g] >= GATE_RULES.fx.flashRetrigger) this._flashTime[g] = now;
    this._updateTint(g);

    const value = this._displayValue(g);
    if (value !== prev || flippedNow || maxedNow || steps > 0) this._textDirty[g] = 1;

    const events = this.ctx.events;
    if (!events) return;
    const view = this._syncView(g);
    P_HIT.gate = view; P_HIT.value = value; P_HIT.prev = prev; P_HIT.weight = w; P_HIT.x = x; P_HIT.y = y; P_HIT.z = z;
    events.emit('gate:hit', P_HIT);
    if (steps > 0) {
      // one emit per hit even when a heavy hit (rocket / rail) crossed several steps; mult = the new
      // multiplier ('x') or the new rung's divisor ('/': 2, then 1 for the grey x1)
      P_STEP.gate = view;
      P_STEP.mult = op === OP_MULT ? this._mult[g] : GATE_RULES.div.ladder[this._divStage[g]];
      events.emit('gate:step', P_STEP);
    }
    if (flippedNow) { P_GATE.gate = view; events.emit('gate:flip', P_GATE); }
    if (maxedNow) { P_GATE.gate = view; events.emit('gate:max', P_GATE); }
    // coins past MAX (whole coins only; the remainder waits for the next hit)
    if (this._maxCoinAcc[g] >= 1 - EPS && this._maxCoinPaid[g] < GATE_RULES.plus.maxCoins) {
      let pay = Math.floor(this._maxCoinAcc[g] + EPS);
      const room = GATE_RULES.plus.maxCoins - this._maxCoinPaid[g];
      if (pay > room) pay = room;
      this._maxCoinAcc[g] -= pay;
      this._maxCoinPaid[g] += pay;
      if (pay > 0) {
        P_COIN.amount = pay; P_COIN.x = x; P_COIN.y = y; P_COIN.z = z; P_COIN.source = 'max';
        events.emit('coin:pickup', P_COIN);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // step — scroll, intake refill, arm, lane decal, commit, pass / miss, recycle
  // -------------------------------------------------------------------------------------------
  step(dt) {
    const ctx = this.ctx;
    const world = ctx.world;
    const roadSpeed = world ? world.roadSpeed : 0;
    const dz = roadSpeed * dt;
    const squad = ctx.squad || null;
    // Round 7 (r7 controls:1, the tester's "-104 nearly taken on L9"): the lane the player is STEERING TO (input.targetX — intent),
    // not where the squad centre happens to be on its way there, picks the lane highlight decal (from WORLD.laneDecalZ), the commit
    // at WORLD.gateCommitZ and the unlocked pass fallback. The squad then slides into the committed lane (squad.lockLane) in the
    // commit window. Physical tests (zombie contact, boss attacks, crate pickup, acid) stay on squad.x.
    const input = ctx.input || null;
    SQX[0] = input ? input.targetX : (squad ? squad.x : (world ? world.squadX : 0));
    const fx = this._fx || (this._fx = ctx.fx || null);
    const events = ctx.events;
    const now = ctx.time ? ctx.time.elapsed : 0;
    const refill = GATE_RULES.intakePerSec * dt;
    const hitDecay = Math.exp(-dt / INTAKE_WINDOW_S);           // _recentHits ≈ hits in the last INTAKE_WINDOW_S
    // round 7 (r7 teaching:4): weighted hits/s EMA over REACH_TAU_S for the reach projection (render)
    const rateK = dt > 0 ? 1 - Math.exp(-dt / REACH_TAU_S) : 0;
    const invDt = dt > 0 ? 1 / dt : 0;

    // scroll + intake refill
    for (let i = 0; i < this._liveCount; i++) {
      const g = this._liveSlots[i];
      this._z[g] += dz;
      const b = this._intake[g] + refill;
      this._intake[g] = b > INTAKE_CAP ? INTAKE_CAP : b;
      this._recentHits[g] *= hitDecay;
      this._rate[g] += (this._wAcc[g] * invDt - this._rate[g]) * rateK;
      this._wAcc[g] = 0;
    }

    // per-event state machine (iterate backwards so freeing an event is safe)
    for (let i = this._evLiveCount - 1; i >= 0; i--) {
      const e = this._evLiveSlots[i];
      const n = this._evLaneCount[e];
      const g0 = this._evGates[e * 3];
      const z = this._z[g0];
      const centers = this._laneTables[this._evLayout[e]];

      if (z > WORLD.despawnZ) { this._freeEvent(e); continue; }

      if (this._evDecorative[e]) {
        // title idle scene: never arms, never commits, never passes; far → missed at z ≥ 0; no events, no decal; freed
        // once render has sunk it fully under the road (round 5, SINK_*)
        if (z >= 0 && this._state[g0] === ST_FAR) for (let l = 0; l < n; l++) this._state[this._evGates[e * 3 + l]] = ST_MISSED;
        if (z >= (world ? world.squadDepth : 0) + SINK_PAD + SINK_FREE_Y / SINK_RATE) this._freeEvent(e);
        continue;
      }
      if (this._evResolved[e]) continue;

      // far → armed (the frame lights up)
      if (this._state[g0] === ST_FAR && z >= WORLD.gateArmZ) {
        for (let l = 0; l < n; l++) { const g = this._evGates[e * 3 + l]; this._state[g] = ST_ARMED; this._armTime[g] = now; }
      }
      // lane highlight decal from WORLD.laneDecalZ — follows the lane nearest the steering target (round 7: intent, SQX) until
      // the commit, then stays on the committed lane; re-created when the lane (or that lane's colour, e.g. a flip) changes
      if (z >= WORLD.laneDecalZ && fx) {
        const lane = this._evLockedLane[e] >= 0 ? this._evLockedLane[e] : this._nearestLane(centers, n);
        const type = this._typeIdx(this._evGates[e * 3 + lane]);
        if (this._evDecal[e] < 0 || lane !== this._evDecalLane[e] || type !== this._evDecalType[e]) {
          this._removeEventDecal(e);
          this._createEventDecal(e, lane, centers[lane], z);
        } else if (typeof fx.moveDecal === 'function') {
          fx.moveDecal(this._evDecal[e], centers[lane], z);
        }
      }
      // armed → locked at the commit distance: the lane nearest the steering target (round 7: intent) commits and the squad
      // slides into it; hits are still accepted until WORLD.gateStopZ so the applied value equals the value the player saw
      if (this._state[g0] === ST_ARMED && z >= WORLD.gateCommitZ) {
        const lane = this._nearestLane(centers, n);
        this._evLockedLane[e] = lane;
        for (let l = 0; l < n; l++) this._state[this._evGates[e * 3 + l]] = ST_LOCKED;
        if (squad && typeof squad.lockLane === 'function') squad.lockLane(centers[lane]);
        if (events) {
          P_COMMIT.gate = this._syncView(this._evGates[e * 3 + lane]); P_COMMIT.lane = lane;
          events.emit('gate:commit', P_COMMIT);
        }
      }
      // pass at z ≥ 0: the committed lane (the squad is held within ±SQUAD.steer.laneLockHalfWidth of its centre); an event
      // that somehow never locked passes the lane nearest the steering target; never geometry. A dead squad (C = 0, or the level
      // already lost — the game-over run-on) passes nothing: every lane is missed (QA GAT-6, GDD §7 / §10)
      if (z >= 0) {
        if (this._squadGone()) this._resolveMissAll(e);
        else this._resolvePass(e, this._evLockedLane[e] >= 0 ? this._evLockedLane[e] : this._nearestLane(centers, n));
      }
    }
  }

  /** True once the run is lost: squad count 0 (squad:dead) or level phase 'lost'. No squad (stub harness) → false. */
  _squadGone() {
    const ctx = this.ctx;
    const squad = ctx.squad;
    if (squad && squad.count === 0) return true;
    const level = ctx.level;
    return !!(level && level.phase === 'lost');
  }

  /**
   * Resolves an event without a pass (dead squad): every lane → missed, gate:miss per lane, no squad change,
   * no coins, no item; the lane lock and the lane decal are released like after a pass.
   */
  _resolveMissAll(e) {
    const n = this._evLaneCount[e];
    const events = this.ctx.events;
    for (let l = 0; l < n; l++) this._state[this._evGates[e * 3 + l]] = ST_MISSED;
    if (events) {
      for (let l = 0; l < n; l++) {
        P_GATE.gate = this._syncView(this._evGates[e * 3 + l]);
        events.emit('gate:miss', P_GATE);
      }
    }
    const squad = this.ctx.squad;
    if (squad && typeof squad.lockLane === 'function') squad.lockLane(null);
    this._removeEventDecal(e);
    this._evResolved[e] = 1;
    this._evLockedLane[e] = -1;
    this._evAttnUntil[e] = 0;
  }

  /** Lane index whose centre is nearest the x held in SQX[0] (round 7: the steering target, input.targetX — see step()). */
  _nearestLane(centers, n) {
    const x = SQX[0];
    let best = 0, bestD = Infinity;
    for (let l = 0; l < n; l++) {
      const d = Math.abs(centers[l] - x);
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  }

  _createEventDecal(e, lane, laneX, z) {
    const fx = this._fx;
    if (!fx || typeof fx.decal !== 'function') return;
    const g = this._evGates[e * 3 + lane];
    const type = this._typeIdx(g);
    // size = lane width (4 m on a pair, 2.6 m triple, 8 m single); Infinity = until removed
    const id = fx.decal('lane', laneX, z, this._laneWidths[this._evLayout[e]], Infinity, this._tintHex[type]);
    this._evDecal[e] = typeof id === 'number' && id >= 0 ? id : -1;
    this._evDecalLane[e] = lane;
    this._evDecalType[e] = type;
  }

  _removeEventDecal(e) {
    if (this._evDecal[e] >= 0) {
      const fx = this._fx;
      if (fx && typeof fx.removeDecal === 'function') fx.removeDecal(this._evDecal[e]);
    }
    this._evDecal[e] = -1;
    this._evDecalLane[e] = -1;
    this._evDecalType[e] = -1;
  }

  /** Effective op a gate applies at pass time, after flips / ladder (GDD §4.2 "Pass effect"). */
  _effectiveOp(g) {
    const op = this._op[g];
    if (op === OP_MINUS) return this._flipped[g] ? OP_PLUS : OP_MINUS;
    if (op === OP_DIV) return this._flipped[g] ? OP_MULT : OP_DIV;
    return op;
  }

  /** Magnitude passed to squad.applyGate with _effectiveOp (a flipped ÷ is 'x' flipTo, never '/' 2). */
  _effectiveValue(g) {
    const op = this._op[g];
    if (op === OP_PLUS || op === OP_MINUS) return Math.abs(intValueAt(this._valueF, g));
    if (op === OP_MULT) return this._mult[g];
    if (op === OP_DIV) return this._flipped[g] ? this._mult[g] : GATE_RULES.div.ladder[this._divStage[g]];
    return 0;
  }

  /** GDD §4.3: the count a lane would produce from C (gate:pass.other.wouldBe); "never below 1", count cap. */
  _wouldBe(g, C) {
    const op = this._effectiveOp(g), v = this._effectiveValue(g);
    let r = C;
    if (op === OP_PLUS) r = C + v;
    else if (op === OP_MINUS) r = C - v;
    else if (op === OP_MULT) r = C * v;
    else if (op === OP_DIV) r = v > 0 ? Math.ceil(C / v) : C;
    if (r < 1) r = 1;
    if (r > SQUAD.countCap) r = SQUAD.countCap;
    return r;
  }

  /** Pass op string reported on gate:pass / other: item; flipped '−' → '+'; '/' keeps '/' (flipped ⇒ "x2", ARCH §6.12). */
  _passOpStr(g) {
    const op = this._op[g];
    if (op === OP_ITEM) return 'item';
    if (op === OP_DIV) return '/';
    return OP_STR[this._effectiveOp(g)];
  }

  _resolvePass(e, lane) {
    const ctx = this.ctx;
    const events = ctx.events;
    const squad = ctx.squad || null;
    const n = this._evLaneCount[e];
    const g = this._evGates[e * 3 + lane];
    const x = this._x[g], z = this._z[g];
    const panelY = GATE_RULES.panel.bottom + GATE_RULES.panel.h * 0.5;   // coin origin = panel centre (ARCH §6.9 y 2.2)
    let before = squad ? squad.count : 0, after = before;
    const op = this._op[g];

    if (op === OP_ITEM) {
      if (ctx.pickups && typeof ctx.pickups.grantItem === 'function' && this._item[g]) ctx.pickups.grantItem(this._item[g], x, 0);
      if (squad && typeof squad.setInvulnerable === 'function') squad.setInvulnerable(SQUAD.invulnOnPass);
    } else if (squad && typeof squad.applyGate === 'function') {
      const r = squad.applyGate(OP_STR[this._effectiveOp(g)], this._effectiveValue(g), x, z);
      if (r) { before = r.before; after = r.after; }                 // reused object: copied immediately
    }
    this._state[g] = ST_PASSED;

    // other = the best lane NOT taken (null for singles)
    let other = null;
    if (n > 1) {
      let bestG = -1, bestWould = -Infinity;
      for (let l = 0; l < n; l++) {
        if (l === lane) continue;
        const og = this._evGates[e * 3 + l];
        const wb = this._wouldBe(og, before);
        if (wb > bestWould) { bestWould = wb; bestG = og; }
      }
      if (bestG >= 0) {
        P_OTHER.op = this._passOpStr(bestG);
        P_OTHER.value = this._op[bestG] === OP_ITEM ? 0 : this._effectiveValue(bestG);
        P_OTHER.wouldBe = bestWould;
        other = P_OTHER;
      }
    }
    for (let l = 0; l < n; l++) if (l !== lane) this._state[this._evGates[e * 3 + l]] = ST_MISSED;

    if (events) {
      P_PASS.gate = this._syncView(g);
      P_PASS.op = this._passOpStr(g);
      P_PASS.value = op === OP_ITEM ? 0 : this._effectiveValue(g);
      P_PASS.before = before; P_PASS.after = after; P_PASS.x = x; P_PASS.z = z; P_PASS.other = other;
      events.emit('gate:pass', P_PASS);
      P_COIN.amount = this._maxed[g] ? GATE_RULES.coins.max : GATE_RULES.coins.pass;
      P_COIN.x = x; P_COIN.y = panelY; P_COIN.z = z; P_COIN.source = 'gate';
      events.emit('coin:pickup', P_COIN);
      for (let l = 0; l < n; l++) {
        if (l === lane) continue;
        P_GATE.gate = this._syncView(this._evGates[e * 3 + l]);
        events.emit('gate:miss', P_GATE);
      }
    }

    if (squad && typeof squad.lockLane === 'function') squad.lockLane(null);
    this._removeEventDecal(e);
    this._evResolved[e] = 1;
    this._evLockedLane[e] = -1;
    this._evAttnUntil[e] = 0;                                  // round 7: a pulse (pulseEvent) ends with the pass
  }

  _freeGate(g) {
    this._live[g] = 0;
    this._generation[g] = (this._generation[g] + 1) & 0xFFFFF;     // 20 bits: (gen << 12) | slot stays a safe positive int
    if (this._generation[g] === 0) this._generation[g] = 1;
    this._item[g] = null;
    this._hintOnHit[g] = null; this._hintOnPass[g] = null; this._hintIfOtherBetter[g] = null;
    const pos = this._livePos[g];
    const last = this._liveCount - 1;
    if (pos >= 0) {
      if (pos !== last) {
        const moved = this._liveSlots[last];
        this._liveSlots[pos] = moved;
        this._livePos[moved] = pos;
      }
      this._liveCount = last;
    }
    this._livePos[g] = -1;
  }

  _freeEvent(e) {
    const n = this._evLaneCount[e];
    if (!this._evResolved[e] && !this._evDecorative[e] && this._evLockedLane[e] >= 0) {
      // an unresolved locked event leaving the world (cannot happen in play: the pass resolves at z ≥ 0)
      const squad = this.ctx.squad;
      if (squad && typeof squad.lockLane === 'function') squad.lockLane(null);
    }
    this._removeEventDecal(e);
    for (let l = 0; l < n; l++) {
      const g = this._evGates[e * 3 + l];
      if (g >= 0 && this._live[g]) this._freeGate(g);
      this._evGates[e * 3 + l] = -1;
    }
    this._evLive[e] = 0;
    this._evLockedLane[e] = -1;
    this._evAttnUntil[e] = 0;
    this._evGen[e] = (this._evGen[e] + 1) & 0xFFFFF;
    if (this._evGen[e] === 0) this._evGen[e] = 1;
    const pos = this._evLivePos[e];
    const last = this._evLiveCount - 1;
    if (pos >= 0) {
      if (pos !== last) {
        const moved = this._evLiveSlots[last];
        this._evLiveSlots[pos] = moved;
        this._evLivePos[moved] = pos;
      }
      this._evLiveCount = last;
    }
    this._evLivePos[e] = -1;
  }

  // -------------------------------------------------------------------------------------------
  // Value text → glyph list (rebuilt only when the displayed text changes; never per frame)
  // -------------------------------------------------------------------------------------------
  /**
   * Text layout (GDD §4.1): an op glyph (+ − at GATE_RULES.glyph.icon = 0.95 m, × ÷ at glyph.opMultDiv 1.05 m) followed by the
   * digits at GATE_RULES.glyph.h3 (≤ 3 digits) or h4 (4 digits), centred on the panel and shrunk uniformly
   * when wider than TEXT_FIT of the panel (triple lanes); then the 3 "MAX" letters on the gold pill.
   */
  _rebuildText(g) {
    const base = g * GLYPHS_PER_GATE_MAX;
    const idx = this._glyphIdx;
    const op = this._op[g];
    let n = 0;
    this._hasIcon[g] = 0; this._hasBadge[g] = 0; this._hasOp[g] = 0;

    if (op === OP_ITEM) {
      // item lane: icon quad (TextureFactory.icons) instead of text
      const item = this._item[g];
      if (this._iconUVOk && item) {
        try {
          this.ctx.render.textures.iconUV(item, UV_OUT);      // accepts an item id or an icon key (RENDER.icons.ofItem)
          if (UV_OUT.u1 > UV_OUT.u0) {
            this._iconUV[g * 4] = UV_OUT.u0; this._iconUV[g * 4 + 1] = UV_OUT.v0;
            this._iconUV[g * 4 + 2] = UV_OUT.u1; this._iconUV[g * 4 + 3] = UV_OUT.v1;
            this._hasIcon[g] = 1;
          }
        } catch (_) { this._hasIcon[g] = 0; }
      }
      this._textCount[g] = 0;
      this._digitH[g] = 0; this._opH[g] = 0; this._textW[g] = 0;
    } else {
      const v = this._displayValue(g);
      // leading op glyph: + / − / × / ÷ ; a flipped red gate swaps to "+" (none while it shows 0);
      // the ÷ ladder reads ÷3 → ÷2 → ×1 → ×2
      let opG = -1;
      if (op === OP_PLUS) opG = G_PLUS;
      else if (op === OP_MINUS) opG = !this._flipped[g] ? G_MINUS : (v > 0 ? G_PLUS : -1);
      else if (op === OP_MULT) opG = G_TIMES;
      else opG = this._flipped[g] || v <= 1 ? G_TIMES : G_DIV;
      if (opG >= 0) { idx[base + n++] = opG; this._hasOp[g] = 1; }
      // digits, most significant first (≤ SQUAD.countCap, i.e. ≤ 4 digits)
      let d = v < 0 ? -v : v;
      if (d > SQUAD.countCap) d = SQUAD.countCap;
      const nd = d >= 1000 ? 4 : d >= 100 ? 3 : d >= 10 ? 2 : 1;
      for (let k = nd - 1; k >= 0; k--) { idx[base + n + k] = d % 10; d = (d / 10) | 0; }
      n += nd;
      this._textCount[g] = n;
      let digitH = nd <= 3 ? GATE_RULES.glyph.h3 : GATE_RULES.glyph.h4;
      // × / ÷ at GATE_RULES.glyph.opMultDiv (the ÷ dots must survive at decision distance), + / − at glyph.icon;
      // every quad is centred on the panel's mid-line, so the op glyph stays vertically centred on the digits
      let opH = opG === G_TIMES || opG === G_DIV ? GATE_RULES.glyph.opMultDiv : GATE_RULES.glyph.icon;
      let w = 0;
      for (let k = 0; k < n; k++) w += this._glyphAdv[idx[base + k]] * (k === 0 && this._hasOp[g] ? opH : digitH);
      const maxW = GATE_RULES.panel.w * (this._layout[g] === 2 ? GATE_RULES.panel.wTriple / GATE_RULES.panel.w : 1) * TEXT_FIT;
      if (w > maxW && w > 0) { const s = maxW / w; digitH *= s; opH *= s; w = maxW; }
      this._digitH[g] = digitH; this._opH[g] = opH; this._textW[g] = w;
      if (this._maxed[g]) { idx[base + n++] = G_M; idx[base + n++] = G_A; idx[base + n++] = G_X; this._hasBadge[g] = 1; }
    }
    this._glyphCountOf[g] = n;
    this._textDirty[g] = 0;
  }

  // -------------------------------------------------------------------------------------------
  // render — instance matrices + per-instance attributes only (ARCH §4.2 step D)
  // -------------------------------------------------------------------------------------------
  /**
   * QA GAT-9 (zero per-frame allocation in every JIT tier): the per-instance math never merges two DIFFERENT double
   * values in a branch (a ternary / if-reassigned `let` of doubles is a phi that Maglev may keep tagged, boxing one
   * HeapNumber per gate per frame). Conditions become 0 / 1 integers that scale the double terms, clamps use
   * Math.min / Math.max, loop-carried doubles (the glyph pen) live in a Float64Array slot, and helpers take integer
   * slots only (MA / TU / NEED / PEN carry their double arguments and results).
   */
  render(alpha) {
    const ctx = this.ctx;
    const t = ctx.time ? ctx.time.elapsed : 0;
    const roadSpeed = ctx.world ? ctx.world.roadSpeed : 0;
    const exDz = roadSpeed * alpha * WORLD.step;                      // extrapolation (ARCH §2.2)
    const sinkZ0 = (ctx.world ? ctx.world.squadDepth : 0) + SINK_PAD;  // round 5: decorative gates sink beyond this z
    const params = ctx.quality ? ctx.quality.params : null;
    const glowGain = params && params.bloom === 'off' ? GLOW_GAIN_LOW : GLOW_GAIN_BLOOM;
    const fogNear = WORLD.fog.near, fogFar = params && params.fogFar > fogNear ? params.fogFar : WORLD.fog.far;
    const invFogSpan = 1 / (fogFar - fogNear);
    const panelW = GATE_RULES.panel.w, panelH = GATE_RULES.panel.h;
    const panelY = GATE_RULES.panel.bottom + panelH * 0.5;
    const recolor = GATE_RULES.minus.recolor;
    // MAX letters centred GATE_RULES.glyph.badgeLift above the panel top — clear of the frame's top bar and sign
    // lamps (≤ 3.40 m); materials.js centres the gold pill at the same height (VIS-7)
    const badgeY = GATE_RULES.panel.bottom + panelH + GATE_RULES.glyph.badgeLift;
    const sxTripleM1 = GATE_RULES.panel.wTriple / panelW - 1;
    const hitFlashDur = GATE_RULES.panel.hitFlash, emissiveFlash = GATE_RULES.fx.emissiveFlash;
    const flipDur = GATE_RULES.minus.flipFlash, flipPeakM1 = FLIP_FLASH_PEAK - 1;
    const punchTime = GATE_RULES.fx.stepPunchTime, punchM1 = GATE_RULES.mult.punch - 1;
    const popTime = GATE_RULES.glyph.popTime, popAmp = GATE_RULES.glyph.pop, stepPopM1 = GATE_RULES.fx.stepGlyphPop - 1;
    const badgeTime = GATE_RULES.fx.maxBadge.time, badgeFromM1 = GATE_RULES.fx.maxBadge.scaleFrom - 1;
    const armedM = ARMED_EMISSIVE - FAR_EMISSIVE, glowLitM = 1 - GLOW_FAR_FRAC;
    const glyphEm = PALETTE.glyph.emissive;
    const maxRGB = this._maxRGB, glyphRGB = this._glyphRGB;
    const gr = glyphRGB[0] * glyphEm, gg = glyphRGB[1] * glyphEm, gb = glyphRGB[2] * glyphEm;
    const mr = maxRGB[0] * glyphEm, mg = maxRGB[1] * glyphEm, mb = maxRGB[2] * glyphEm;
    const idx = this._glyphIdx, uvs = this._glyphUV, advs = this._glyphAdv, aspects = this._glyphAspect;
    const pulseW = Math.PI * 2 * GLOW_PULSE_HZ;
    // round 7 (pulseEvent): theatre clock (ms) for the attention deadlines, and the shared pulse value of this frame
    const theatreNow = ctx.time && typeof ctx.time.theatre === 'number' ? ctx.time.theatre : 0;
    const attnWave = ATTN_GAIN * (0.5 + 0.5 * Math.sin(t * ATTN_W));
    // round 7 (reach): seconds of road left to WORLD.gateStopZ per metre (the projection's time base)
    const invRoad = 1 / Math.max(roadSpeed, 0.1);

    const fm = this.frames.instanceMatrix.array, pm = this.panels.instanceMatrix.array, gm = this.glows.instanceMatrix.array;
    const qm = this.glyphs.instanceMatrix.array, im = this.icons.instanceMatrix.array;
    const iFrame = this._iFrame.array, iPanel = this._iPanel.array, iScale = this._iScale.array;
    const glowCol = this.glows.instanceColor.array;
    const panelCol = this._panelFallbackColor ? this._panelFallbackColor.array : null;
    const iGlyph = this._iGlyph.array, iColor = this._iColor.array;
    const iIconUV = this._iIconUV.array, iIconCol = this._iIconColor.array;
    let nF = 0, nP = 0, nQ = 0, nI = 0;

    // round-3 FTUE label yield (LABEL_YIELD_S): the count label's plate as view-space tan extents, from fx.label's world
    // anchor and size (written by fx each frame while the label is drawn) and the camera's world matrix
    let fadeStep = t - this._fadeT;
    this._fadeT = t;
    fadeStep = fadeStep > 0 && fadeStep < 0.1 ? fadeStep / LABEL_YIELD_S : 0;
    let labOk = false, lsx = 0, lsy = 0, lhw = 0, lhh = 0;
    let crx = 0, cry = 0, crz = 0, cux = 0, cuy = 0, cuz = 0, cfx = 0, cfy = 0, cfz = 0, cpx = 0, cpy = 0, cpz = 0;
    const lab = ctx.fx ? ctx.fx.label : null;
    const st = ctx.state ? ctx.state.current : '';
    if (fadeStep > 0 && lab && lab.hasPos && lab.width > 0 && (st === 'playing' || st === 'paused')) {
      const cam = this._camera();
      if (cam) {
        const e = cam.matrixWorld.elements;
        crx = e[0]; cry = e[1]; crz = e[2]; cux = e[4]; cuy = e[5]; cuz = e[6]; cfx = -e[8]; cfy = -e[9]; cfz = -e[10];
        cpx = e[12]; cpy = e[13]; cpz = e[14];
        const dx = lab.x - cpx, dy = lab.y - cpy, dz = lab.z - cpz;
        const d = dx * cfx + dy * cfy + dz * cfz;
        if (d > EPS) {
          lsx = (dx * crx + dy * cry + dz * crz) / d;
          lsy = (dx * cux + dy * cuy + dz * cuz) / d;
          lhw = lab.width * 0.5 / d;
          lhh = lab.plateH * 0.5 / d;
          labOk = true;
        }
      }
    }

    for (let i = 0; i < this._liveCount; i++) {
      const g = this._liveSlots[i];
      const x = this._x[g];
      const zr = this._z[g] + exDz;
      const sx = 1 + sxTripleM1 * (this._layout[g] === 2 ? 1 : 0);
      const state = this._state[g];
      const op = this._op[g];
      // decorative title gates never arm, but their frames light up at the armed line like real ones
      const litI = state === ST_ARMED || state === ST_LOCKED || (this._decorative[g] === 1 && zr >= WORLD.gateArmZ) ? 1 : 0;
      // round 5: a decorative gate behind the title squad sinks into the road (every part below is offset by sy ≤ 0)
      const sy = this._decorative[g] === 1 && zr > sinkZ0 ? (sinkZ0 - zr) * SINK_RATE : 0;
      const passed = state === ST_PASSED;
      const maxed = this._maxed[g] === 1;
      if (this._textDirty[g]) this._rebuildText(g);

      // recolour after a type change (red flip, ÷ ladder): u ∈ (0, 1) while running, else 0
      const ru = (t - this._rampStart[g]) / recolor;
      const u = ru * (ru > 0 && ru < 1 ? 1 : 0);
      const cur = this._curType[g];

      // hit flash (GATE_RULES.panel.hitFlash, restarted ≥ GATE_RULES.fx.flashRetrigger apart) attenuated under
      // sustained fire by the hits taken in the last ≈ INTAKE_WINDOW_S (_recentHits) and capped at HIT_FLASH_CAP so
      // the panel keeps its type hue while shot; the J5 flip flash (FLIP_FLASH_PEAK → 1) is not capped
      const hitU = (t - this._flashTime[g]) / hitFlashDur;
      const hitIn = hitU >= 0 && hitU < 1 ? 1 : 0;
      const hitFlash = Math.min(HIT_FLASH_CAP, emissiveFlash * hitIn * (1 - hitU) / (1 + this._recentHits[g] / FLASH_ATTEN_HITS));
      // J5 (GDD §12): 0.25 s WHITE flash on the flip — the panel shader adds white only above 1, so start at
      // FLIP_FLASH_PEAK and decay to 1 (type tint brightened) over GATE_RULES.minus.flipFlash
      const flipAge = t - this._flipTime[g];
      const flipFlash = (flipAge >= 0 && flipAge < flipDur ? 1 : 0) * (1 + flipPeakM1 * (1 - flipAge / flipDur));
      const flash = Math.max(flipFlash, hitFlash);
      // round 7 (r7 teaching:0 E, pulseEvent): a held lesson hint points at this gate's event — its frame and glow pulse
      const attn = attnWave * (this._evAttnUntil[this._eventSlot[g]] > theatreNow ? 1 : 0);

      // ---- frame ----
      MA[0] = x; MA[1] = sy; MA[2] = zr; MA[3] = sx; MA[4] = 1; MA[5] = 1;
      setMat(fm, nF);
      const fo = nF * 4;
      iFrame[fo] = cur;
      iFrame[fo + 1] = u;
      iFrame[fo + 2] = maxed ? 1 : 0;
      iFrame[fo + 3] = FAR_EMISSIVE + armedM * litI + hitFlash + flipFlash + attn;

      // ---- glow quad (behind the panel): current tint, faded by the fog like the panel it backs ----
      TU[0] = u;
      const rgb = maxed ? maxRGB : this._currentRGB(g);
      const fogFade = Math.min(1, Math.max(0, (fogFar - (CAMERA_Z - zr)) * invFogSpan));
      const gain = (passed ? 0 : 1) * glowGain * (GLOW_FAR_FRAC + glowLitM * litI) * fogFade
        * (1 + GLOW_PULSE_AMP * Math.sin(t * pulseW + this._glowPhase[g]) + flash * 0.5 + attn * 0.5);
      MA[0] = x; MA[1] = panelY + sy; MA[2] = zr + Z_GLOW; MA[3] = panelW * sx * GLOW_SCALE; MA[4] = panelH * GLOW_SCALE; MA[5] = 1;
      setMat(gm, nF);
      const go = nF * 3;
      glowCol[go] = rgb[0] * gain; glowCol[go + 1] = rgb[1] * gain; glowCol[go + 2] = rgb[2] * gain;
      nF++;

      if (passed) continue;   // fx shatters the panel on gate:pass (J7 / J8); frame + glow keep sliding past

      // ---- panel (uniform punch on a multiplier / ÷ step: GATE_RULES.mult.punch over GATE_RULES.fx.stepPunchTime) ----
      const su = (t - this._stepTime[g]) / punchTime;
      const sq = 1 - su;
      const stepK = sq * sq * (su >= 0 && su < 1 ? 1 : 0);          // 1 − ease.outQuad(su), inlined
      const punch = 1 + punchM1 * stepK;
      MA[0] = x; MA[1] = panelY + sy; MA[2] = zr; MA[3] = sx * punch; MA[4] = punch; MA[5] = 1;
      setMat(pm, nP);    // the matrix carries the triple x-scale (materials.js)
      const po = nP * 4;
      const tintIdx = u > 0 && u < 0.5 ? T_ZERO : cur;            // old colour → grey → new colour
      // hazard stripes: 1 on a negative type; fading 1 → 0 over the first half of a recolour away from one
      const from = this._rampFromType[g];
      const curNeg = cur === T_MINUS || cur === T_DIV ? 1 : 0;
      const fromNeg = u > 0 && (from === T_MINUS || from === T_DIV) ? 1 : 0;
      const stripe = Math.max(curNeg, fromNeg * Math.max(0, 1 - u * 2));
      // ring gauge: x → weighted hits toward the next step (1 at the cap); ÷ → progress to the next rung (1 flipped, and 1 on the
      // ×1 rung when that rung is final — round 7, DIV_TOP_FINAL); round 7 (r7 teaching:4) + → progress from the spawn value to MAX
      // (0 once maxed: the gold MAX badge takes over); − → progress from the spawn value to 0, the flip (1 once flipped)
      const isMD = op === OP_MULT || op === OP_DIV ? 1 : 0;
      const isPlus = op === OP_PLUS && !maxed ? 1 : 0;
      const isMinus = op === OP_MINUS ? 1 : 0;
      const divTop = op === OP_DIV && this._divStage[g] >= DIV_LAST && (DIV_TOP_FINAL || this._cap[g] <= 1) ? 1 : 0;
      const full = (op === OP_MULT && this._mult[g] >= this._cap[g]) || (op === OP_DIV && this._flipped[g] === 1) || divTop === 1 ? 1 : 0;
      if (isMD === 1) this._stepNeedTo(g); else NEED[0] = 1;
      const vF = this._valueF[g], hits = this._hits[g];
      const baseV = this._base[g];
      const mdRing = Math.min(1, Math.max(full, hits / NEED[0]));
      const plusRing = Math.min(1, Math.max(0, (vF - baseV) / Math.max(1, this._cap[g] - baseV)));
      const minusRing = Math.min(1, Math.max(0, 1 + vF / Math.max(1, baseV)));
      const ring = isMD * mdRing + isPlus * plusRing + isMinus * minusRing;
      // reach (round 7, r7 teaching:4 part 2): at the rate this gate is being shot (the accepted weighted hits/s EMA, at most the
      // intake budget) does it reach its goal before WORLD.gateStopZ? a red gate → the flip, + → MAX, × → its next step, ÷ → the
      // ×1 rung (never the ×2 flip, unreachable by design). Integer flags scale the double terms (QA GAT-9: no double phis)
      const shot = (state === ST_ARMED || state === ST_LOCKED) && this._rate[g] > REACH_MIN_RATE && full === 0 ? 1 : 0;
      const add = shot * Math.min(this._rate[g], INTAKE_PER_SEC) * Math.max(0, (WORLD.gateStopZ - zr) * invRoad);
      const divBelow = op === OP_DIV && this._divStage[g] < DIV_LAST ? 1 : 0;
      const divGoal = divBelow * (DIV_LAST - this._divStage[g]) * Math.max(1, this._stepCost[g]) + (1 - divBelow) * NEED[0];
      const reachI = shot * (
        isMinus * (this._flipped[g] === 0 && vF + add >= -EPS ? 1 : 0)
        + isPlus * (vF + add >= this._cap[g] - EPS ? 1 : 0)
        + (op === OP_MULT ? 1 : 0) * (hits + add >= NEED[0] - EPS ? 1 : 0)
        + (op === OP_DIV && this._flipped[g] === 0 ? 1 : 0) * (hits + add >= divGoal - EPS ? 1 : 0));
      iPanel[po] = tintIdx + (maxed ? MAX_FLAG : 0);
      iPanel[po + 1] = stripe;
      iPanel[po + 2] = flash;
      iPanel[po + 3] = ring + (reachI > 0 ? REACH_FLAG : 0);
      iScale[nP] = sx;
      if (panelCol) {
        const co = nP * 3;
        const k = 1 + flash;
        panelCol[co] = rgb[0] * k; panelCol[co + 1] = rgb[1] * k; panelCol[co + 2] = rgb[2] * k;
      }
      nP++;

      // ---- glyph quads: op glyph + digits, then the MAX letters (pooled: the badge is dropped first) ----
      let n = this._glyphCountOf[g];
      const textCount = this._textCount[g];
      if (nQ + n > GLYPH_POOL) {
        if (nQ + textCount <= GLYPH_POOL) n = textCount;
        else { n = 0; this._drop('gateGlyphs'); }
      }
      if (n > 0) {
        const base = g * GLYPHS_PER_GATE_MAX;
        const digitH = this._digitH[g], opDH = this._opH[g] - digitH;
        const hasOp = this._hasOp[g];                              // 0 / 1
        const popU = (t - this._popTime[g]) / popTime;
        // J3: 1 + 0.28·decay over 120 ms; J6: 1.5× on a step — the larger of the two
        const pop = Math.max(1 + popAmp * (1 - popU) * (popU >= 0 && popU < 1 ? 1 : 0), 1 + stepPopM1 * stepK);
        PEN[0] = x - this._textW[g] * 0.5;
        const zq = zr + Z_GLYPH;
        // round-3 FTUE label yield: the op + digit block fades while it overlaps the count label on screen (the glyph
        // shader fades a quad out once its colour peak drops under its knee) and comes back when the overlap ends.
        // Round 7 (r7 controls:2): before the commit only the lane the squad will pass (the lane nearest the steering target, as
        // step() decides it) may yield — a wide landscape count label used to hide BOTH lanes' values from 7–9 m, exactly while the
        // other lane's value (still changing under fire) decides a last dodge; from the commit on any overlapping text yields
        let tf = this._textFade[g];
        if (fadeStep > 0) {
          let under = false;
          if (labOk && this._decorative[g] === 0) {
            const ev = this._eventSlot[g];
            const locked = this._evLockedLane[ev];
            const passLane = locked >= 0 ? locked : this._nearestLane(this._laneTables[this._evLayout[ev]], this._evLaneCount[ev]);
            if (this._lane[g] === passLane || this._z[g] >= WORLD.gateCommitZ) {
              const dx = x - cpx, dy = panelY - cpy, dz = zq - cpz;
              const d = dx * cfx + dy * cfy + dz * cfz;
              if (d > EPS) {
                const gx = (dx * crx + dy * cry + dz * crz) / d, gy = (dx * cux + dy * cuy + dz * cuz) / d;
                const hh = (opDH > 0 ? digitH + opDH : digitH) * 0.5 / d, hw = this._textW[g] * 0.5 / d;
                under = Math.abs(gx - lsx) < (hw + lhw) * LABEL_YIELD_MARGIN && Math.abs(gy - lsy) < (hh + lhh) * LABEL_YIELD_MARGIN;
              }
            }
          }
          tf += under ? -fadeStep : fadeStep;
          tf = tf < 0 ? 0 : (tf > 1 ? 1 : tf);
          this._textFade[g] = tf;
        }
        // colour × tf³: the glyph shader keeps full coverage until the colour peak drops under its knee (0.2 of 0.82), so a
        // linear ramp would show a dark "ghost" of the digits for most of the fade — the cube spends ~40 % of it dimming
        const tk = tf * tf * tf;
        const tr = gr * tk, tg = gg * tk, tb = gb * tk;
        for (let k = 0; k < textCount; k++) {
          const gi = idx[base + k];
          const h = digitH + opDH * (k === 0 ? hasOp : 0);           // the op glyph (GATE_RULES.glyph.icon / opMultDiv) first
          const adv = advs[gi] * h;
          const pen = PEN[0];
          MA[0] = pen + adv * 0.5; MA[1] = panelY + sy; MA[2] = zq; MA[3] = aspects[gi] * h * pop; MA[4] = h * pop; MA[5] = 1;
          setMat(qm, nQ);
          PEN[0] = pen + adv;
          const uo = gi * 4, qo = nQ * 4, co = nQ * 3;
          iGlyph[qo] = uvs[uo]; iGlyph[qo + 1] = uvs[uo + 1]; iGlyph[qo + 2] = uvs[uo + 2]; iGlyph[qo + 3] = uvs[uo + 3];
          iColor[co] = tr; iColor[co + 1] = tg; iColor[co + 2] = tb;   // op glyph and digits share the fill colour (GAT-7)
          nQ++;
        }
        if (this._hasBadge[g] && textCount + 3 <= n) {
          // J4: gold "MAX" letters (GATE_RULES.glyph.icon tall) on the dark gold-rimmed pill materials.js draws
          // badgeLift above the panel's top edge; scale GATE_RULES.fx.maxBadge.scaleFrom → 1 over GATE_RULES.fx.maxBadge.time
          // (scaleFrom + (1 − scaleFrom)·ease.outCubic(bu) = 1 + (scaleFrom − 1)·(1 − bu)³, inlined)
          const bu = (t - this._maxTime[g]) / badgeTime;
          const bq = 1 - bu;
          const bh = GATE_RULES.glyph.icon * (1 + badgeFromM1 * bq * bq * bq * (bu >= 0 && bu < 1 ? 1 : 0));
          const b0 = base + textCount;
          PEN[0] = x - (advs[idx[b0]] + advs[idx[b0 + 1]] + advs[idx[b0 + 2]]) * bh * 0.5;
          const zb = zr + Z_BADGE;                                 // in front of the frame bar / lamps: never occluded
          for (let m = 0; m < 3; m++) {
            const gi = idx[b0 + m];
            const adv = advs[gi] * bh;
            const pen = PEN[0];
            MA[0] = pen + adv * 0.5; MA[1] = badgeY + sy; MA[2] = zb; MA[3] = aspects[gi] * bh; MA[4] = bh; MA[5] = 1;
            setMat(qm, nQ);
            PEN[0] = pen + adv;
            const uo = gi * 4, qo = nQ * 4, co = nQ * 3;
            iGlyph[qo] = uvs[uo]; iGlyph[qo + 1] = uvs[uo + 1]; iGlyph[qo + 2] = uvs[uo + 2]; iGlyph[qo + 3] = uvs[uo + 3];
            iColor[co] = mr; iColor[co + 1] = mg; iColor[co + 2] = mb;
            nQ++;
          }
        }
      }

      // ---- item icon quad (pentagon-top "special" lane, GDD §4.1): slow breathing so it reads as a pickup ----
      if (this._hasIcon[g]) {
        const s = ICON_H * (1 + GLOW_PULSE_AMP * 0.5 * Math.sin(t * pulseW * 2 + this._glowPhase[g]));
        const zi = zr + Z_GLYPH;
        // round 7 (r7 S5 "flame gate: burn icon on the count"): the pictogram of the lane being passed yields to the count label
        // like value text does — in the last metres the flamer's flame sat right behind the count and read as a burn status on
        // the squad. Same rule as the text: the pass lane before the commit, any overlapping icon after it
        let tfI = this._textFade[g];
        if (fadeStep > 0) {
          let underI = false;
          if (labOk && this._decorative[g] === 0) {
            const evI = this._eventSlot[g];
            const lockedI = this._evLockedLane[evI];
            const passI = lockedI >= 0 ? lockedI : this._nearestLane(this._laneTables[this._evLayout[evI]], this._evLaneCount[evI]);
            if (this._lane[g] === passI || this._z[g] >= WORLD.gateCommitZ) {
              const dx = x - cpx, dy = panelY - cpy, dz = zi - cpz;
              const d = dx * cfx + dy * cfy + dz * cfz;
              if (d > EPS) {
                const gx = (dx * crx + dy * cry + dz * crz) / d, gy = (dx * cux + dy * cuy + dz * cuz) / d;
                const hi = s * 0.5 / d;
                underI = Math.abs(gx - lsx) < (hi + lhw) * LABEL_YIELD_MARGIN && Math.abs(gy - lsy) < (hi + lhh) * LABEL_YIELD_MARGIN;
              }
            }
          }
          tfI += underI ? -fadeStep : fadeStep;
          tfI = tfI < 0 ? 0 : (tfI > 1 ? 1 : tfI);
          this._textFade[g] = tfI;
        }
        MA[0] = x; MA[1] = panelY + sy; MA[2] = zi; MA[3] = s; MA[4] = s; MA[5] = 1;
        setMat(im, nI);
        const uo = g * 4, qo = nI * 4, co = nI * 3;
        iIconUV[qo] = this._iconUV[uo]; iIconUV[qo + 1] = this._iconUV[uo + 1]; iIconUV[qo + 2] = this._iconUV[uo + 2]; iIconUV[qo + 3] = this._iconUV[uo + 3];
        iIconCol[co] = tfI; iIconCol[co + 1] = tfI; iIconCol[co + 2] = tfI;   // the icon shader fades coverage with it (QUAD_FRAG)
        nI++;
      }
    }

    // ---- commit (one needsUpdate per attribute per frame, with update ranges) ----
    this._commit(this.frames, nF);
    this._commit(this.glows, nF);
    if (nF > 0) {
      markUpdate(this._iFrame, nF * 4);
      markUpdate(this.glows.instanceColor, nF * 3);
    }
    this._commit(this.panels, nP);
    if (nP > 0) {
      markUpdate(this._iPanel, nP * 4);
      markUpdate(this._iScale, nP);
      if (panelCol) markUpdate(this._panelFallbackColor, nP * 3);
    }
    this._commit(this.glyphs, nQ);
    if (nQ > 0) {
      markUpdate(this._iGlyph, nQ * 4);
      markUpdate(this._iColor, nQ * 3);
    }
    this._commit(this.icons, nI);
    if (nI > 0) {
      markUpdate(this._iIconUV, nI * 4);
      markUpdate(this._iIconColor, nI * 3);
    }
  }

  _commit(mesh, count) {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count > 0) markUpdate(mesh.instanceMatrix, count * 16);
  }

  /** render.camera, cached on first use (render builds it once in init) — the round-3 label-yield test reads it. */
  _camera() {
    let cam = this._cam;
    if (cam === null) {
      const r = this.ctx.render;
      cam = r && r.camera ? r.camera : null;
      this._cam = cam;
    }
    return cam;
  }

  // -------------------------------------------------------------------------------------------
  // reset / dispose
  // -------------------------------------------------------------------------------------------
  /** Level-start state: every event freed, decals released, lane lock released, meshes hidden. Idempotent, allocation-free. */
  reset() {
    if (!this._inited) return;
    this._fx = this.ctx.fx || null;
    for (let i = this._evLiveCount - 1; i >= 0; i--) this._freeEvent(this._evLiveSlots[i]);
    this._evLiveCount = 0;
    for (let g = 0; g < GATE_POOL; g++) {
      if (this._live[g]) this._freeGate(g);                  // (never happens: every gate belongs to an event)
      this._livePos[g] = -1; this._state[g] = ST_FAR; this._item[g] = null;
    }
    this._liveCount = 0;
    for (let e = 0; e < EVENT_POOL; e++) {
      this._evLive[e] = 0; this._evLivePos[e] = -1; this._evDecal[e] = -1; this._evDecalLane[e] = -1;
      this._evDecalType[e] = -1; this._evLockedLane[e] = -1; this._evResolved[e] = 0; this._evAttnUntil[e] = 0;
      this._evGates[e * 3] = -1; this._evGates[e * 3 + 1] = -1; this._evGates[e * 3 + 2] = -1;
    }
    const squad = this.ctx.squad;
    if (squad && typeof squad.lockLane === 'function') squad.lockLane(null);
    this.frames.count = 0; this.frames.visible = false;
    this.panels.count = 0; this.panels.visible = false;
    this.glows.count = 0; this.glows.visible = false;
    this.glyphs.count = 0; this.glyphs.visible = false;
    this.icons.count = 0; this.icons.visible = false;
  }

  /** Removes the meshes from the scene and disposes everything this module created (shared library materials are kept). */
  dispose() {
    if (!this._inited) return;
    this.reset();
    const scene = this._scene;
    const meshes = [this.frames, this.glows, this.panels, this.glyphs, this.icons];
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (!m) continue;
      if (scene) scene.remove(m);
      m.dispose();
    }
    for (let i = 0; i < this._ownGeos.length; i++) this._ownGeos[i].dispose();
    for (let i = 0; i < this._ownMats.length; i++) this._ownMats[i].dispose();
    this._ownGeos.length = 0;
    this._ownMats.length = 0;
    this._scene = null;
    this._fx = null;
    this._inited = false;
  }
}
