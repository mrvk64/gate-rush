// js/materials.js — GATE RUSH: MaterialLibrary (ARCHITECTURE §6.3, §9; GDD §4.1, §12, §15, §16).
//
// Render split (lead decision): render.js keeps RenderSystem + TextureFactory + GradeOutputPass and
// re-exports `MaterialLibrary` from this file. RenderSystem.init() constructs it right after
// `TextureFactory.build()` resolves: `this.materials = new MaterialLibrary(ctx)`; the constructor reads
// ctx.render.textures / ctx.render.uniforms.uTime / ctx.quality / ctx.save.settings / ctx.events.
// particle(variant) / decal() delegate to './fxmaterials.js' (fx engineer) and sky() to './environment.js'
// (environment engineer); every factory result is cached here, so each is built once.
//
// Every material is cached: callers that need to MUTATE a material (boss rage glow, troop LEDs, gates'
// per-owner glyph copy) clone it first. Nothing in this file runs at import time (no DOM / window access).
//
// ---------------------------------------------------------------------------------------------------
// Per-instance attribute contracts implemented by the shaders below (the consumers write them):
//
//   gatePanel()  (gates.panels InstancedMesh; geometry = models.geo.gatePanel = PlaneGeometry(panel.w, panel.h),
//                centred; the instance matrix already carries the triple x-scale AND the step punch)
//     iPanel vec4 = (tintIdx + 8·maxed, stripeMix 0..1, flash 0..~1.5, ring01 0..1 + 2·reach)
//                   tintIdx: 0 plus, 1 mult, 2 minus, 3 div, 4 zero (x1 / 0, neutral grey), 5 item
//                            (= GATE_RULES.colors key order); +8 = gold MAX badge (pill centred
//                            GATE_RULES.glyph.badgeLift above the top edge, under the 3 "MAX" glyph quads gates
//                            places there) + gold rim. The type also picks the outline (rounded top: plus / mult /
//                            zero; square: minus / div; pentagon top: item) and the chevron mark under the frame
//                            bar (^ plus, ^^ mult, v minus, vv div); div stripes run the other diagonal (GDD §4.1).
//                   stripeMix: hazard stripes (top / bottom bands + faint body stripes), 0 = none;
//                   flash: 0..1 hit flash (brightens the type's own tint, also pulses the MAX pill);
//                          above 1 (to 1.5) adds the white flip flash on top;
//                   ring01: x / ÷ step progress → 360° gauge around the panel edge (clockwise from the
//                           top centre); a mult / div panel shows the empty track at 0; 1 = full ring. Round 7
//                           (r7 teaching:4): + progress to MAX, − progress to the flip (a red panel shows its empty
//                           track from spawn too); ÷ reads full on its final ×1 rung.
//                   reach (round 7): + 2 on w = the gate reaches its goal before the stop line at the rate it is
//                           shot → the band takes the colour it is heading for (red → the + blue, + → gold, x / ÷ →
//                           white) and the head pulses. Same program (no new variant).
//     iScale float = 1 | GATE_RULES.panel.wTriple / GATE_RULES.panel.w — NOT applied to the position
//                    (the matrix has it); used to keep stripes, ring, rim and badge in true metres.
//     The quad is grown in the vertex shader by a few cm on every side (soft outer halo) and further at the
//     top on MAX panels so the badge pill can extend above the panel edge.
//
//   gateFrame()  (gates.frames InstancedMesh; geometry = models.geo.gateFrame: posts, feet, chevrons, bar)
//     iFrame vec4 = (typeIdx 0..5 as above, tintT 0..1 flip-recolour progress (0 = none),
//                    maxed 0..1 (lerp to gold GATE_RULES.colors.max), emissiveBoost ≥ 0 (far 0.35, armed 1,
//                    + hit flash)). Negative types (minus / div) get hazard stripes on posts and bar and
//                    their chevron wedges are rotated 180° (down-chevrons, GDD §4.1 four-way encoding).
//
//   glyph(billboard = false)  (gates.glyphs, fx floaters / numbers / count label) — see glyph() below.
//     iGlyph vec4 (u0, v0, u1, v1) atlas rect from TextureFactory.glyphUV; iPopTime float (uTime seconds
//     of the last pop; ≤ 0 = inert); iColor vec3 linear HDR tint. glyph() → uBillboard 0 (quads keep the
//     instance orientation; gates face +Z); glyph(true) → uBillboard 1 (camera-facing, reads only the
//     matrix translation and the column lengths as size). Owners that change uniforms clone first.
//
//   hpBar()      (zombies.hpBars) iHp float 0..1 (< 0 hides); instance matrix = translation + scale
//                (x: width factor, y: height factor) applied to PlaneGeometry(ZOMBIES.common.hpBar.w, .h);
//                billboarded in the vertex shader.
//
//   tracer()     instanceColor = linear HDR triplets written straight into the Float32Array.
//   blobShadow() render.blobShadows (CircleGeometry, Low tier): soft disc from textures.glow alpha.
//
// uTime (=== ctx.render.uniforms.uTime) is ctx.time.elapsed: scaled seconds since boot.
// All ShaderMaterials compile under WebGL 2 / three r170 (three converts to GLSL 3 and prefixes the
// tone-mapping / colour-space functions); fog uses the standard fog_* chunks with `fog: true`.
// ---------------------------------------------------------------------------------------------------
import {
  Color, Vector2, Vector3, Vector4, MeshStandardMaterial, MeshBasicMaterial, ShaderMaterial, MeshDepthMaterial,
  UniformsUtils, UniformsLib, DoubleSide, FrontSide, NormalBlending, LinearSRGBColorSpace, RGBADepthPacking,
} from 'three';
import { GATE_RULES, ZOMBIES, RENDER, PALETTE } from './data.js';
import { warnOnce } from './util.js';
import { makeParticleMaterial, makeDecalMaterial } from './fxmaterials.js';
import { makeSkyMaterial } from './environment.js';

// ---------------------------------------------------------------------------------------------------
// Constants. Data-derived values come from data.js; the rest are shader SHAPE constants (sizes of rims,
// insets, stripe periods — pure look, no gameplay meaning) or values data.js lacks (DATA-MISSING).
// ---------------------------------------------------------------------------------------------------
const GATE_TYPE_KEYS = ['plus', 'mult', 'minus', 'div', 'zero', 'item'];   // = GATE_RULES.colors key order (gates.js TYPE_KEYS)

// Gate panel shape (metres, panel-local)
const PANEL_CORNER_M = 0.14;          // rounded-corner radius of the panel body
const PANEL_PAD_M = 0.12;             // quad growth on the sides / bottom / top (room for the outer halo)
const PANEL_RIM_M = 0.05;             // bright edge highlight width
const PANEL_INNER_GLOW_M = 0.3;       // falloff of the soft inner glow hugging the border
const PANEL_HALO_M = 0.07;            // falloff of the soft outer halo
const STRIPE_BAND_M = 0.24;           // hazard band height at the top and bottom edges
const STRIPE_PERIOD_M = 0.34;         // diagonal hazard stripe period
const RING_INSET_M = 0.14;            // ring gauge centre line, inset from the panel edge
const RING_HALF_W_M = 0.065;          // ring gauge half thickness
// Ring fill (round-5 art review, docs/build/r5-art.md): the progress band and the full ring are capped at this LINEAR
// luminance, under RENDER.bloom.threshold like the value glyph (GAT-7). The old fill (mix(tint·1.8, white, 0.5)·1.3, ±25 %
// pulse: luminance ≈ 1.0–1.7 on a × gate) bloomed in from all four sides of a FULL ring (× at its cap, ÷ flipped to ×2) and
// lifted the glyph plate it frames to Y ≈ 0.25–0.39: glyph : panel 1.9–2.9 : 1 at the armed line on High / Medium in five
// districts, the ad included. The full ring still pulses, by up to RING_PULSE below the cap.
const RING_LUM_CAP = RENDER.bloom.threshold - 0.05;
const RING_PULSE = 0.3;
// Round 7 (r7 teaching:4): a red gate's gauge is the "will it flip in time?" read, so its two states must differ by hue at a glance:
// the band is a saturated red (white mix RING_WHITE_RED instead of 0.5) while it will not make it, and a saturated + blue at
// REACH_BLUE_LUM luminance (normalised to RING_LUM_CAP the blue washed out to a pale cyan next to the pale pink) once it will
const RING_WHITE_RED = 0.15;
const RING_RED_LUM = 0.38;      // (at RING_LUM_CAP the ACES grade turned the red band pink-white)
const REACH_BLUE_LUM = 0.42;
// The frame top bar (GATE_RULES.frame.postH) hides the panel top above it: the ring and the top hazard band are
// pushed below it so they stay visible from the gameplay camera.
const FRAME_COVER_M = Math.max(0, GATE_RULES.panel.bottom + GATE_RULES.panel.h - GATE_RULES.frame.postH);
const BADGE_PAD_X_M = 0.22;           // MAX pill: horizontal padding around the three letters
const BADGE_PAD_Y_M = 0.08;           // MAX pill: vertical padding around the letters
const BADGE_HALO_M = 0.1;             // extra quad growth above the pill (its gold halo)
// MAX pill half size from the letters gates draws there: "M","A","X" at GATE_RULES.glyph.icon height
const BADGE_HALF_W = 0.5 * GATE_RULES.glyph.icon * (RENDER.atlas.advance.M + RENDER.atlas.advance.A + RENDER.atlas.advance.X) + BADGE_PAD_X_M;
const BADGE_HALF_H = 0.5 * GATE_RULES.glyph.icon + BADGE_PAD_Y_M;
// VIS-7: the pill's centre sits GATE_RULES.glyph.badgeLift above the panel top (gates puts the "MAX" letters at the same
// height, GAT-2), so the whole pill clears the frame's top bar and its sign lamps (the key always exists: VIS-23).
const BADGE_LIFT_M = GATE_RULES.glyph.badgeLift;

// Four-way type encoding on the panel (VIS-10, GDD §4.1; frame geometry is shared, so the panel carries the shape cues)
const PANEL_TOP_ROUND_M = 0.6;        // rounded-top corner radius (+, ×, x1/0)
const PANEL_SQUARE_M = 0.04;          // near-square corners (−, ÷; also the pentagon's base corners)
const PANEL_PEAK_M = 0.75;            // item lanes: pentagon top — the side edges turn inward this far below the top
const CHEV_DROP_M = 0.56;             // chevron mark centre below the panel top (between the value text and the ring)
const CHEV_HALF_W_M = 0.32;           // chevron half width
const CHEV_H_M = 0.24;                // chevron height
const CHEV_STROKE_M = 0.09;           // chevron stroke width (a dark outline of ~0.45 stroke frames it)

// Gate fog (VIS-9): gates fog at most this far toward a DESATURATED fog colour, so the hue (a primary type cue) survives
// over the orange sky / fog; translucent panels also gain opacity with distance and compensate the fog behind them.
const GATE_FOG_CAP = 0.5;             // max fog factor applied to panels, frames and gate glyphs
const GATE_FOG_SAT = 0.35;            // saturation kept in the fog colour the gates fade toward
const PANEL_FAR_ALPHA = 0.85;         // panel opacity against a fully fogged background (0.38 against the near road)
const PANEL_FAR_COMP = 1.0;           // strength of the far-panel background (fog colour) compensation
const PANEL_FOG_CAP = 0.25;           // panels fog less than frames / glyphs: the haze comes from their translucency
const PANEL_HIT_MIX = 0.6;            // hit flash: mix toward the type's own brightened tint (never white)
// Value-glyph contrast (round-2 QA VIS-12, GDD §1 pillar 5 / §4.1): the white value glyph must read ≥ 3:1 against the panel
// area behind it on every tier, so the panel body is luminance-capped, the far-background compensation is clamped, and a
// rounded dark backing plate sits under the glyph block (no sheen inside it). Shape constants (panel-local, metres /
// fractions of the panel half size); the MAX badge, ring gauge, hazard stripes and the hit / flip flash are unchanged.
const PANEL_LUM_CAP = 0.45;           // max linear luminance of the panel body before compositing
const PANEL_COMP_CAP = 0.5;           // clamp of the far-background compensated colour (brightest channel; hue kept)
const PLATE_DROP = 0.0;               // plate centre below the panel centre (× panel height); glyph quads are centred on it
const PLATE_HALF_W = 0.84;            // plate half width (× panel half width; the ring gauge runs outside it)
const PLATE_HALF_H = 0.52;            // plate half height (× panel half height; ≈ the 1.7 m glyph block's ink + outline)
const PLATE_RADIUS_M = 0.25;          // plate corner radius
const PLATE_DARKEN = 0.45;            // mix toward PALETTE.glyph.outline inside the plate
// minimum plate opacity (0 = panel opacity unchanged). Round-5 art review: 0 → 0.6. Near the armed line the panel is only
// ≈ 0.38–0.5 opaque, so the road and the additive glow quad behind it showed through the plate: at the 36 px point
// (z −26) the white glyph read 2.2–2.8 : 1 against the panel behind it on Low (×2, ×1, full rings, the ad included) and
// 2.9–3.0 : 1 in Toxic on High; at 0.6 it is ≥ 3.5 : 1 (docs/build/r5-art.md §3)
const PLATE_ALPHA = 0.6;
const PLATE_LUM_CAP = 0.06;           // max linear luminance inside the plate after the hit flash (bright × green, sustained fire)
// Item lanes (pentagon top) back their pictogram with a near-opaque, near-black plate (round-5 art review): the item icon is
// a mid-tone colour pictogram (the shotgun's orange stock is Y ≈ 0.36 on Low, 0.49 on Medium / High), not the white glyph, and
// on the translucent violet plate (Y ≈ 0.10–0.13 with the violet glow quad behind it) it read 2.3–2.6 : 1 on Low and
// 3.0–3.1 : 1 on Medium / High at the armed line. Every other type keeps PLATE_DARKEN / PLATE_ALPHA / PLATE_LUM_CAP.
const ITEM_PLATE_DARKEN = 0.85;
const ITEM_PLATE_ALPHA = 0.9;
const ITEM_PLATE_LUM_CAP = 0.02;

// Gate frame chevrons (models.js DIMS.gateChevron; used to rotate the wedges 180° on negative gates)
const CHEVRON_ROWS = GATE_RULES.frame.chevron.rows;    // (models.js DIMS.gateChevron.rows) (data key; wired round-2 cross-group)
const CHEVRON_LEN = GATE_RULES.frame.chevron.len;                 // (data key; wired round-2 cross-group)
const CHEVRON_ANGLE = GATE_RULES.frame.chevron.angle;                // (rad) (data key; wired round-2 cross-group)
const CHEVRON_CENTRE_DROP = Math.sin(CHEVRON_ANGLE) * CHEVRON_LEN * 0.45;   // wedge centre below its row (models.js buildGateFrame)
const FRAME_STRIPE_PERIOD_M = 0.32;     // hazard stripe period on negative frames
const FRAME_BODY_EMISSIVE = 0.4;        // posts / bar glow at this fraction of the gain (saturated paint); chevrons glow at full gain

// Glyphs
const GLYPH_FADE_KNEE = 0.2;   // iColor peak below this also fades coverage (so dimming iColor to 0 fades a quad out)

// HP bars
const HP_BORDER_M = 0.018;     // outline thickness of the pill-shaped bar
const HP_LOW_PULSE = ZOMBIES.common.hpBar.lowPulse;      // below this HP fraction the fill pulses (data key; wired round-2 cross-group)
const HP_FILL_GAIN = 1.25;     // fill brightness (UI colours survive the ACES grade)

// Material defaults (GDD §15: cloth/skin roughness 0.75–0.9)
const DEFAULT_ROUGHNESS = PALETTE.material.cloth.roughness;
const DEFAULT_METALNESS = PALETTE.material.cloth.metalness;

// ---------------------------------------------------------------------------------------------------
// Small helpers (construction time only — never called per frame)
// ---------------------------------------------------------------------------------------------------
/** sRGB hex (data.js) → linear working-space Color (fresh object). */
function lin(hex) { return new Color().setHex(hex); }

/** Fog uniforms (UniformsLib.fog, deep-cloned) merged with `own`. Shared objects (uTime, textures) are
 *  assigned AFTER this call so UniformsUtils' deep clone never breaks the sharing. */
function withFog(own) { return Object.assign(UniformsUtils.merge([UniformsLib.fog]), own); }

/** Stable cache-key fragment for an options object (known keys only, insertion order independent). */
const OPT_KEYS = ['emissive', 'emissiveIntensity', 'flatShading', 'transparent', 'opacity', 'side', 'depthWrite',
  'depthTest', 'fog', 'blending', 'toneMapped', 'alphaTest', 'map', 'emissiveMap', 'polygonOffset', 'wireframe'];
function optKey(opts) {
  if (!opts) return '';
  let s = '';
  for (let i = 0; i < OPT_KEYS.length; i++) {
    const k = OPT_KEYS[i];
    const v = opts[k];
    if (v === undefined) continue;
    s += '|' + k + '=' + (v !== null && typeof v === 'object' ? (v.uuid || 'obj') : String(v));
  }
  return s;
}

/** Copies the generic material options a caller may pass (never colour / roughness / metalness). */
function applyCommonOpts(m, opts) {
  if (!opts) return;
  if (opts.transparent !== undefined) m.transparent = !!opts.transparent;
  if (opts.opacity !== undefined) m.opacity = opts.opacity;
  if (opts.side !== undefined) m.side = opts.side;
  if (opts.depthWrite !== undefined) m.depthWrite = !!opts.depthWrite;
  if (opts.depthTest !== undefined) m.depthTest = !!opts.depthTest;
  if (opts.fog !== undefined) m.fog = !!opts.fog;
  if (opts.blending !== undefined) m.blending = opts.blending;
  if (opts.alphaTest !== undefined) m.alphaTest = opts.alphaTest;
  if (opts.wireframe !== undefined) m.wireframe = !!opts.wireframe;
  if (opts.toneMapped !== undefined) m.toneMapped = !!opts.toneMapped;
  if (opts.polygonOffset) { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -1; }
}

/** prefers-reduced-motion media query (guarded, §14 rule 4). */
function mediaReducedMotion() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------------------------------
// GLSL — common SDF helper
// ---------------------------------------------------------------------------------------------------
const SDF_GLSL = /* glsl */`
  // signed distance to a rounded box (half size b, corner radius r); < 0 inside
  float grRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
`;

/** GLSL float literal (always with a decimal point). */
function glf(v) { return Number(v).toFixed(4); }

// Gate fog helpers: declared after <fog_pars_fragment> (they read vFogDepth / fogColor / fogNear / fogFar).
const GATE_FOG_PARS = /* glsl */`
  float grGateFog() {
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        return 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        return smoothstep(fogNear, fogFar, vFogDepth);
      #endif
    #else
      return 0.0;
    #endif
  }
  vec3 grGateFogColor() {
    #ifdef USE_FOG
      return mix(vec3(dot(fogColor, vec3(0.2126, 0.7152, 0.0722))), fogColor, ${glf(GATE_FOG_SAT)});
    #else
      return vec3(0.0);
    #endif
  }
`;
// Replaces <fog_fragment> in the gate shaders: capped fog toward the desaturated fog colour.
const GATE_FOG_APPLY = /* glsl */`
  #ifdef USE_FOG
    gl_FragColor.rgb = mix(gl_FragColor.rgb, grGateFogColor(), min(grGateFog(), ${glf(GATE_FOG_CAP)}));
  #endif
`;

// ---------------------------------------------------------------------------------------------------
// Gate panel (one ShaderMaterial for all 12 instanced panels)
// ---------------------------------------------------------------------------------------------------
const PANEL_VERT = /* glsl */`
  attribute vec4 iPanel;
  attribute float iScale;
  uniform vec2 uHalf;        // geometry half size (m) = (panel.w / 2, panel.h / 2)
  uniform vec4 uPad;         // quad growth (m): side, bottom, top, top when maxed
  varying vec2 vP;           // panel-local position in true metres (x already × iScale)
  varying vec4 vPanel;
  varying float vHalfW;      // true half width (m)
  varying float vSeed;       // per-gate phase (gate x)
  varying vec3 vWorld;       // world position (far-panel background estimate, VIS-9)
  #include <fog_pars_vertex>
  void main() {
    vPanel = iPanel;
    float sx = max(iScale, 0.001);
    float maxed = step(7.5, iPanel.x);
    vec3 p = position;
    // grow only the boundary vertices outward (a PlaneGeometry of any segment count stays valid)
    float ex = step(uHalf.x - 0.001, abs(p.x));
    float ey = step(uHalf.y - 0.001, abs(p.y));
    float top = step(0.0, p.y);
    p.x += sign(p.x) * ex * uPad.x / sx;
    p.y += sign(p.y) * ey * mix(uPad.y, mix(uPad.z, uPad.w, maxed), top);
    vP = vec2(p.x * sx, p.y);
    vHalfW = uHalf.x * sx;
    #ifdef USE_INSTANCING
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
      vWorld = (modelMatrix * instanceMatrix * vec4(p, 1.0)).xyz;
      vSeed = instanceMatrix[3].x * 0.37;
    #else
      vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
      vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
      vSeed = 0.0;
    #endif
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const PANEL_FRAG = /* glsl */`
  uniform vec3 uTints[6];      // plus, mult, minus, div, zero, item (linear)
  uniform vec3 uGold;          // GATE_RULES.colors.max
  uniform vec3 uDark;          // PALETTE.glyph.outline
  uniform float uOpacity;      // GATE_RULES.panel.opacity | opacityHC
  uniform float uOpacityZero;  // GATE_RULES.panel.opacityZero (× HC ratio)
  uniform vec2 uHalf;
  uniform vec3 uCorner;        // (bottom corner radius, rounded-top radius, square corner radius)
  uniform float uPeak;         // item lanes: pentagon shoulder drop below the top (m)
  uniform vec4 uChev;          // chevron mark (centre drop below the top, half width, height, stroke)
  uniform vec3 uRim;           // (rim width, inner glow falloff, outer halo falloff)
  uniform vec3 uStripe;        // (band height, period, extra top band height under the frame bar)
  uniform vec3 uRing;          // (inset, half thickness, top drop under the frame bar)
  uniform vec3 uBadge;         // MAX pill (half width, half height, centre lift above the panel top)
  uniform vec4 uFogK;          // (hit-flash mix, far alpha, far background compensation, fog cap)
  uniform vec3 uRoadBg;        // road colour (linear): the near background behind a panel
  uniform vec4 uPlate;         // glyph backing plate (VIS-12): (centre drop × panel h, half w × half w, half h × half h, corner m)
  uniform vec4 uPlateK;        // (darken, min opacity, body luminance cap, far compensation clamp)
  uniform float uPlateCap;     // luminance cap inside the plate after the hit flash (the J5 flip flash is exempt)
  varying vec3 vWorld;
  uniform float uMotion;       // 0 under reduced motion (sheen / pulses static)
  uniform float uTime;
  varying vec2 vP;
  varying vec4 vPanel;
  varying float vHalfW;
  varying float vSeed;
  #include <fog_pars_fragment>
  ${GATE_FOG_PARS}
  ${SDF_GLSL}
  // rounded box with separate top / bottom corner radii
  float grRoundBox2(vec2 p, vec2 b, float rTop, float rBot) {
    float r = p.y > 0.0 ? rTop : rBot;
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  // panel outline by type (GDD 4.1 shape cue): rounded top (plus, mult, zero), square (minus, div), pentagon top (item)
  float grPanelSd(vec2 p, vec2 b, int ti) {
    if (ti == 2 || ti == 3) return grRoundBox(p, b, uCorner.z);
    if (ti == 5) {
      vec2 n = normalize(vec2(uPeak, b.x));
      return max(grRoundBox(p, b, uCorner.z), dot(vec2(abs(p.x), p.y - b.y), n));
    }
    return grRoundBox2(p, b, min(uCorner.y, min(b.x, b.y)), uCorner.x);
  }
  float grSeg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }
  // chevron centred on p = 0 (apex up), half width w, height h; distance to its centre line
  float grChevron(vec2 p, float w, float h) {
    p.x = abs(p.x);
    return grSeg(p, vec2(0.0, 0.5 * h), vec2(w, -0.5 * h));
  }
  void main() {
    float code = vPanel.x;
    float maxed = step(7.5, code);
    int ti = int(clamp(floor(code - 8.0 * maxed + 0.5), 0.0, 5.0));
    vec3 tint = uTints[ti];
    float stripeMix = clamp(vPanel.y, 0.0, 1.0);
    float flash = clamp(vPanel.z, 0.0, 1.5);
    // round 7 (r7 teaching:4): w = ring01 + 2·reach (gates' REACH_FLAG: the gate reaches its goal before the stop line at the rate
    // it is being shot)
    float reach = step(1.5, vPanel.w);
    float ring = clamp(vPanel.w - 2.0 * reach, 0.0, 1.0);
    float isZero = ti == 4 ? 1.0 : 0.0;
    float isItem = ti == 5 ? 1.0 : 0.0;
    // the empty track shows from spawn on x, ÷ and (round 7) red gates — each has something to fill; + gates show it once shot
    float gauge = (ti == 1 || ti == 2 || ti == 3 || ring > 0.0005) ? 1.0 : 0.0;
    float ff = grGateFog();                                      // raw fog factor (distance cue for alpha / saturation)

    vec2 hb = vec2(vHalfW, uHalf.y);
    float d = grPanelSd(vP, hb, ti);                             // < 0 inside the panel body
    float aa = max(fwidth(d), 0.0005);
    float inside = 1.0 - smoothstep(-aa, aa, d);
    float edge = max(-d, 0.0);                                  // distance to the border, inside
    float y01 = clamp(vP.y / uHalf.y * 0.5 + 0.5, 0.0, 1.0);

    // ---- body: vertical gradient + soft inner glow along the border ----
    vec3 col = tint * (0.85 + 0.4 * y01);                     // vivid at 38 % opacity without washing out under ACES
    float inner = exp(-edge / uRim.y);
    col += tint * inner * 0.4;
    // luminance cap (VIS-12): lit or far panels never reach 0.7–0.9 right behind the white glyph; hue is kept
    float bodyLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= min(1.0, uPlateK.z / max(bodyLum, 1e-3));
    float alpha = mix(uOpacity, uOpacityZero, isZero) * (0.82 + 0.4 * inner);
    // far panels (VIS-9): a 38 % panel seen against the fogged road / horizon turns lavender-grey. The background is
    // estimated where the view ray through this fragment meets the ground (road colour fogged by that distance);
    // the more of it is fog, the more the panel grows toward uFogK.y opacity, and its colour pre-compensates the
    // estimate — colour' = (colour − (1 − a)·bg) / a — so the blend a·colour' + (1 − a)·bg keeps the type's hue
    float bgFog = 0.0;
    vec3 grBg = uRoadBg;
    #ifdef USE_FOG
      float gH = cameraPosition.y - vWorld.y;
      float dG = length(vWorld - cameraPosition) * (gH > 0.05 ? cameraPosition.y / gH : 40.0);
      #ifdef FOG_EXP2
        bgFog = 1.0 - exp(-fogDensity * fogDensity * dG * dG);
      #else
        bgFog = smoothstep(fogNear, fogFar, dG);
      #endif
      grBg = mix(uRoadBg, fogColor, bgFog);
    #endif
    float farA = mix(alpha, max(alpha, uFogK.y), smoothstep(0.0, 0.6, bgFog));
    vec3 comp = max((col - (1.0 - farA) * grBg) / max(farA, 0.05), vec3(0.0));
    // clamp the compensation (VIS-12) by its brightest channel, so the type hue survives the clamp
    comp *= min(1.0, uPlateK.w / max(max(comp.r, max(comp.g, comp.b)), 1e-3));
    col = mix(col, comp, uFogK.z);
    alpha = farA;

    // ---- dark rounded backing plate under the glyph block (VIS-12); drawn before the ring / chevrons / rim ----
    float plateD = grRoundBox(vP - vec2(0.0, -uPlate.x * 2.0 * uHalf.y), vec2(uPlate.y * vHalfW, uPlate.z * uHalf.y), uPlate.w);
    float plate = (1.0 - smoothstep(0.0, aa, plateD)) * inside;

    // ---- hazard stripes (negative types): bands at the top / bottom edge + faint body stripes;
    //      div runs the opposite diagonal so it differs from minus without colour (VIS-10) ----
    if (stripeMix > 0.001) {
      float sdir = ti == 3 ? -1.0 : 1.0;
      float sv = sin((vP.x * sdir + vP.y) * (6.2831853 / uStripe.y));
      float sw = fwidth(sv) + 0.0001;
      float sp = smoothstep(-sw, sw, sv);
      float bandDist = uHalf.y - abs(vP.y);
      float bandH = uStripe.x + uStripe.z * step(0.0, vP.y);
      float band = 1.0 - smoothstep(bandH - aa, bandH + aa, bandDist);
      vec3 bandCol = mix(uDark, tint * 1.35 + vec3(0.06), sp);
      col = mix(col, col * 0.72, (1.0 - sp) * stripeMix * 0.35 * (1.0 - band));
      col = mix(col, bandCol, band * stripeMix);
      alpha = mix(alpha, 0.85, band * stripeMix);
    }

    // ---- item lanes: slow twinkling glints (special, not shootable) ----
    if (isItem > 0.5) {
      float tw = sin(vP.x * 7.0 + uTime * 1.9 * uMotion) * sin(vP.y * 7.0 - uTime * 1.4 * uMotion + vSeed);
      col += tint * 0.45 * pow(max(tw, 0.0), 6.0);
    }

    col = mix(col, uDark, mix(uPlateK.x, ${glf(ITEM_PLATE_DARKEN)}, isItem) * plate);
    alpha = mix(alpha, max(alpha, mix(uPlateK.y, ${glf(ITEM_PLATE_ALPHA)}, isItem)), plate);

    // ---- 360 degree ring gauge around the panel edge (x / div step progress), following the type's outline ----
    if (gauge > 0.5) {
      vec2 rb = vec2(vHalfW - uRing.x, uHalf.y - uRing.x - 0.5 * uRing.z);
      float dR = grPanelSd(vP + vec2(0.0, 0.5 * uRing.z), rb, ti);
      float rd = abs(dR) - uRing.y;                               // distance to the gauge band
      float trackMask = (1.0 - smoothstep(-aa, aa, rd - 0.012)) * inside;
      float bandMask = (1.0 - smoothstep(-aa, aa, rd)) * inside;
      float a01 = fract(atan(vP.x, vP.y + 0.5 * uRing.z) / 6.2831853);   // 0 at the top centre, clockwise
      float af = min(fwidth(a01), 0.01) + 0.0005;
      float filled = ring >= 0.999 ? 1.0 : (1.0 - smoothstep(ring - af, ring + af, a01)) * step(0.0005, ring);
      float full = step(0.999, ring);
      // the fill never blooms (luminance capped under the threshold: a blooming full ring washed the plate it frames); a full
      // ring pulses below the cap
      vec3 fillCol = mix(tint * 1.8, vec3(1.0), ti == 2 ? ${glf(RING_WHITE_RED)} : 0.5);
      fillCol *= (ti == 2 ? ${glf(RING_RED_LUM)} : ${glf(RING_LUM_CAP)}) / max(dot(fillCol, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
      // round 7 (reach): the band takes the colour the gate is heading for — a red gate that will flip reads + blue, a + gate
      // that will MAX gold, x / ÷ white — under the capped luminance (no bloom), so "it will make it" reads before it does
      vec3 reachCol = ti == 2 ? uTints[0] : (ti == 0 ? uGold : vec3(1.0));
      reachCol *= (ti == 2 ? ${glf(REACH_BLUE_LUM)} : ${glf(RING_LUM_CAP)}) / max(dot(reachCol, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
      fillCol = mix(fillCol, reachCol, reach * (1.0 - full));
      fillCol *= 1.0 - ${glf(RING_PULSE)} * full * (0.5 + 0.5 * sin(uTime * 6.0 * uMotion));
      col = mix(col, uDark, trackMask * 0.92);
      alpha = max(alpha, 0.82 * trackMask);
      col = mix(col, fillCol, bandMask * filled);
      alpha = mix(alpha, 1.0, bandMask * filled);
      // bright head at the progress end
      float dh = abs(a01 - ring);
      float head = exp(-dh * 70.0) * (1.0 - full) * step(0.0005, ring) * (1.0 - smoothstep(-aa, aa, rd - 0.03)) * inside;
      head *= 1.0 + reach * (0.6 + 0.4 * sin(uTime * 10.0 * uMotion));   // round 7: a reaching gauge's head pulses
      col += vec3(1.0) * head * 1.2;
      alpha = max(alpha, head);
    }

    // ---- chevron mark under the frame bar: one up (plus), two up (mult), one down (minus), two down (div) (VIS-10) ----
    float nCh = (ti == 0 || ti == 2) ? 1.0 : ((ti == 1 || ti == 3) ? 2.0 : 0.0);
    if (nCh > 0.5) {
      vec2 cp = vP - vec2(0.0, uHalf.y - uChev.x);
      if (ti >= 2) cp.y = -cp.y;                                // negative types point down
      float spc = uChev.y * 1.3;
      float dc = nCh > 1.5
        ? min(grChevron(cp - vec2(spc, 0.0), uChev.y, uChev.z), grChevron(cp + vec2(spc, 0.0), uChev.y, uChev.z))
        : grChevron(cp, uChev.y, uChev.z);
      dc -= 0.5 * uChev.w;
      float caa = max(fwidth(dc), 0.0005);
      float chev = (1.0 - smoothstep(-caa, caa, dc)) * inside;
      float chevO = (1.0 - smoothstep(-caa, caa, dc - 0.45 * uChev.w)) * inside;
      col = mix(col, uDark, chevO * 0.9);
      col = mix(col, tint * 1.5 + vec3(0.32), chev);
      alpha = max(alpha, max(0.85 * chevO, chev));
    }

    // ---- edge highlight (gold on MAX) ----
    float rim = (1.0 - smoothstep(0.0, uRim.x, edge)) * inside * (0.7 + 0.5 * y01);
    vec3 rimCol = mix(tint * 1.5 + vec3(0.28), uGold * 1.9, maxed);
    col = mix(col, rimCol, rim);
    alpha = max(alpha, 0.92 * rim);

    // ---- slow diagonal sheen sweeping across the body ----
    float u = (vP.x * 0.55 + vP.y) / (vHalfW * 0.55 + uHalf.y);
    float c = fract(uTime * 0.21 * uMotion + vSeed) * 3.4 - 1.7;
    float sq = (u - c) / 0.16;                                   // x*x, not pow(x, 2.0): pow of a negative base is NaN on some GPUs
    float sheen = exp(-sq * sq) * 0.16 * inside * uMotion * (1.0 - plate);   // no sheen inside the glyph plate
    col += vec3(sheen);

    // ---- hit flash brightens the type's OWN colour (hue kept under fire, VIS-9); only the flip flash (flash > 1)
    //      adds white ----
    float hitF = clamp(flash, 0.0, 1.0);
    float flipF = clamp(flash - 1.0, 0.0, 0.5) * 2.0;
    col = mix(col, tint * 1.6 + vec3(0.12), hitF * uFogK.x * inside);
    col += vec3(1.0) * flipF * 0.9 * inside;
    alpha = min(1.0, alpha + 0.35 * hitF * inside);
    // the plate stays dark under sustained fire and on bright tints (VIS-12); the white flip flash still shows on it
    float plateLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(1.0, min(1.0, mix(uPlateCap, ${glf(ITEM_PLATE_LUM_CAP)}, isItem) / max(plateLum, 1e-3)), plate * (1.0 - flipF));

    alpha *= inside;

    // ---- soft outer halo (in the grown border) ----
    float halo = exp(-max(d, 0.0) / uRim.z) * (1.0 - inside);
    vec3 haloCol = mix(tint * 1.3, uGold * 1.6, maxed);
    float haloA = halo * (0.32 + 0.25 * hitF + 0.15 * maxed);
    col = mix(haloCol, col, inside);
    alpha = max(alpha, haloA);

    // ---- MAX badge: dark pill with a gold rim and halo, centred uBadge.z above the top edge (clear of the frame
    //      bar and its lamps, VIS-7) ----
    if (maxed > 0.5) {
      vec2 bp = (vP - vec2(0.0, uHalf.y + uBadge.z)) / (1.0 + 0.12 * hitF);
      float pd = grRoundBox(bp, uBadge.xy, uBadge.y);
      float paa = max(fwidth(pd), 0.0005);
      float pill = 1.0 - smoothstep(-paa, paa, pd);
      float prim = (1.0 - smoothstep(0.0, 0.07, max(-pd, 0.0))) * pill;
      float pgrad = clamp(bp.y / uBadge.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 pillCol = mix(uDark + uGold * (0.08 + 0.1 * pgrad), uGold * 1.9, prim);
      float shine = (0.75 + 0.25 * sin(uTime * 4.0 * uMotion)) * prim;
      pillCol += uGold * 0.4 * shine;
      col = mix(col, pillCol, pill);
      alpha = mix(alpha, 0.94, pill);
      float phalo = exp(-max(pd, 0.0) / 0.08) * (1.0 - pill);
      col = mix(col, uGold * 1.6, phalo * (1.0 - inside) * 0.8);
      alpha = max(alpha, phalo * 0.5);
    }

    if (alpha < 0.003) discard;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #ifdef USE_FOG
      gl_FragColor.rgb = mix(gl_FragColor.rgb, grGateFogColor(), min(ff, uFogK.w));   // light haze only (VIS-9)
    #endif
  }
`;

// ---------------------------------------------------------------------------------------------------
// Digit-atlas glyph quads (gates value text; fx floaters, damage numbers, count label)
// ---------------------------------------------------------------------------------------------------
const GLYPH_VERT = /* glsl */`
  attribute vec4 iGlyph;       // atlas rect (u0, v0, u1, v1)
  attribute float iPopTime;    // uTime of the last pop; <= 0 never pops
  attribute vec3 iColor;       // linear HDR tint
  uniform float uTime;
  uniform float uBillboard;    // 1 = camera-facing (translation + column scales of the matrix)
  uniform float uPop;          // GATE_RULES.glyph.pop
  uniform float uPopTime;      // GATE_RULES.glyph.popTime
  varying vec2 vUv;
  varying vec3 vColor;
  #include <fog_pars_vertex>
  void main() {
    vUv = vec2(mix(iGlyph.x, iGlyph.z, uv.x), mix(iGlyph.y, iGlyph.w, uv.y));
    vColor = iColor;
    float age = uTime - iPopTime;
    float pop = 1.0;
    if (iPopTime > 0.0 && age >= 0.0 && age < uPopTime) pop = 1.0 + uPop * (1.0 - age / uPopTime);
    vec3 p = position * pop;
    #ifdef USE_INSTANCING
      mat4 im = instanceMatrix;
    #else
      mat4 im = mat4(1.0);
    #endif
    vec4 mvPosition;
    if (uBillboard > 0.5) {
      vec2 s = vec2(length(im[0].xyz), length(im[1].xyz));
      mvPosition = modelViewMatrix * vec4(im[3].xyz, 1.0);
      mvPosition.xy += p.xy * s;
    } else {
      mvPosition = modelViewMatrix * im * vec4(p, 1.0);
    }
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const GLYPH_FRAG = /* glsl */`
  uniform sampler2D uAtlas;    // premultiplied digit atlas (white fill, dark outline)
  uniform float uHasAtlas;
  uniform float uFadeKnee;
  varying vec2 vUv;
  varying vec3 vColor;
  #include <fog_pars_fragment>
  ${GATE_FOG_PARS}
  void main() {
    vec4 t = uHasAtlas > 0.5 ? texture2D(uAtlas, vUv) : vec4(1.0);
    float peak = max(vColor.r, max(vColor.g, vColor.b));
    float a = t.a * clamp(peak / uFadeKnee, 0.0, 1.0);
    if (a < 0.004) discard;
    vec3 straight = t.rgb / max(t.a, 0.0001);                   // un-premultiply; re-premultiplied below
    gl_FragColor = vec4(straight * vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    ${GATE_FOG_APPLY}
    #include <premultiplied_alpha_fragment>
  }
`;

// ---------------------------------------------------------------------------------------------------
// Zombie HP bars (billboarded pill bars)
// ---------------------------------------------------------------------------------------------------
const HPBAR_VERT = /* glsl */`
  attribute float iHp;
  uniform vec2 uSize;          // geometry size (m) = ZOMBIES.common.hpBar.w / .h
  varying vec2 vUv;
  varying float vHp;
  varying vec2 vSize;          // true bar size (m) after the instance scale
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vHp = iHp;
    #ifdef USE_INSTANCING
      mat4 im = instanceMatrix;
    #else
      mat4 im = mat4(1.0);
    #endif
    vec2 s = vec2(length(im[0].xyz), length(im[1].xyz));
    vSize = uSize * s;
    vec4 mvPosition = modelViewMatrix * vec4(im[3].xyz, 1.0);
    mvPosition.xy += position.xy * s;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const HPBAR_FRAG = /* glsl */`
  uniform vec3 uFull;          // PALETTE.ui.success
  uniform vec3 uMid;           // PALETTE.ui.primary
  uniform vec3 uLow;           // PALETTE.ui.danger
  uniform vec3 uTrack;         // PALETTE.ui.bossTrack
  uniform vec3 uBorder;        // PALETTE.glyph.outline
  uniform vec4 uBar;           // (border m, tick spacing, low-pulse threshold, fill gain)
  uniform float uMotion;
  uniform float uTime;
  varying vec2 vUv;
  varying float vHp;
  varying vec2 vSize;
  #include <fog_pars_fragment>
  ${SDF_GLSL}
  void main() {
    if (vHp < 0.0) discard;
    float hp = clamp(vHp, 0.0, 1.0);
    vec2 hs = vSize * 0.5;
    vec2 p = (vUv - 0.5) * vSize;
    float d = grRoundBox(p, hs, hs.y);
    float aa = max(fwidth(d), 0.0005);
    float outer = 1.0 - smoothstep(-aa, aa, d);
    float innerD = d + uBar.x;
    float inner = 1.0 - smoothstep(-aa, aa, innerD);
    float iw = max(vSize.x - 2.0 * uBar.x, 0.001);
    float x01 = clamp((p.x + hs.x - uBar.x) / iw, 0.0, 1.0);
    float fx = max(fwidth(x01), 0.0005);
    float filled = (1.0 - smoothstep(hp - fx, hp + fx, x01)) * step(0.0001, hp);
    vec3 fill = hp > 0.5 ? mix(uMid, uFull, (hp - 0.5) * 2.0) : mix(uLow, uMid, hp * 2.0);
    fill *= uBar.w * (0.82 + 0.36 * vUv.y);
    fill += vec3(0.18) * smoothstep(0.62, 0.8, vUv.y) * (1.0 - smoothstep(0.8, 0.95, vUv.y));   // gloss line
    float lowPulse = (1.0 - step(uBar.z, hp)) * (0.5 + 0.5 * sin(uTime * 10.0 * uMotion));
    fill = mix(fill, fill * 1.5 + vec3(0.12), lowPulse * 0.6);
    // quarter ticks (brute stagger thresholds)
    float tk = abs(fract(x01 / uBar.y + 0.5) - 0.5) * uBar.y * iw;
    float tick = (1.0 - smoothstep(0.006, 0.006 + fwidth(tk) + 0.0005, tk)) * step(0.02, x01) * step(x01, 0.98);
    vec3 track = uTrack * (0.9 + 0.3 * vUv.y);
    vec3 col = mix(track, fill, filled);
    col = mix(col, col * 0.55, tick * 0.7);
    col = mix(uBorder, col, inner);
    float alpha = outer * 0.95;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// ---------------------------------------------------------------------------------------------------
// Gate frame — MeshStandardMaterial + onBeforeCompile chunks (customProgramCacheKey 'gr:gateframe')
// ---------------------------------------------------------------------------------------------------
const FRAME_VERT_PARS = /* glsl */`
  attribute vec4 iFrame;
  uniform vec3 uGrChevRows;    // chevron row heights (object space)
  uniform vec4 uGrChev;        // (wedge centre drop below its row, min z of a wedge vertex, min y, max y)
  uniform float uGrPostX;      // |x| of the post centres
  varying vec4 vGrFrame;
  varying vec3 vGrObj;
  varying float vGrChev;
`;
// Runs right after <beginnormal_vertex>: classifies the vertex and rotates chevron normals on negative gates.
const FRAME_VERT_NORMAL = /* glsl */`
  vGrFrame = iFrame;
  float grTi = floor(iFrame.x + 0.5);
  float grNeg = (abs(grTi - 2.0) < 0.5 || abs(grTi - 3.0) < 0.5) ? 1.0 : 0.0;
  float grChev = step(uGrChev.y, position.z) * step(uGrChev.z, position.y) * step(position.y, uGrChev.w);
  float grFlip = grNeg * grChev;
  if (grFlip > 0.5) objectNormal.xy = -objectNormal.xy;      // 180° about z keeps the winding (no mirror)
`;
// Runs right after <begin_vertex>: rotates each chevron wedge 180° about its own centre (^ → v).
const FRAME_VERT_POSITION = /* glsl */`
  vGrObj = position;
  vGrChev = grChev;
  if (grFlip > 0.5) {
    float grRow = uGrChevRows.x;
    float grDd = abs(position.y - uGrChevRows.x);
    if (abs(position.y - uGrChevRows.y) < grDd) { grRow = uGrChevRows.y; grDd = abs(position.y - uGrChevRows.y); }
    if (abs(position.y - uGrChevRows.z) < grDd) { grRow = uGrChevRows.z; }
    float grCy = grRow - uGrChev.x;
    float grCx = sign(position.x) * uGrPostX;
    transformed.x = 2.0 * grCx - position.x;
    transformed.y = 2.0 * grCy - position.y;
  }
`;
const FRAME_FRAG_PARS = /* glsl */`
  uniform vec3 uGrCols[6];     // frame colours per type (GATE_RULES.colors[*].frame, linear)
  uniform vec3 uGrGold;        // GATE_RULES.colors.max
  uniform vec3 uGrDark;        // hazard stripe dark
  uniform float uGrEmissive;   // RENDER.gateFrameEmissive (× (1 + lowTierEmissiveBoost) on Low)
  uniform float uGrStripe;     // stripe period (m)
  uniform float uGrBodyGain;   // emissive fraction on posts / bar (chevrons: 1)
  uniform float uGrMotion;
  uniform float uTime;
  varying vec4 vGrFrame;
  varying vec3 vGrObj;
  varying float vGrChev;
`;
// Runs right after <color_fragment>: type colour, flip recolour, hazard stripes, gold MAX.
const FRAME_FRAG_COLOR = /* glsl */`
  int grI = int(clamp(floor(vGrFrame.x + 0.5), 0.0, 5.0));
  vec3 grCol = uGrCols[grI];
  float grT = vGrFrame.y;
  if (grT > 0.0 && grT < 1.0) grCol = grT < 0.5 ? uGrCols[4] : mix(uGrCols[4], grCol, grT * 2.0 - 1.0);
  float grNegF = (grI == 2 || grI == 3) ? 1.0 : 0.0;
  float grSv = sin((vGrObj.y + vGrObj.x) * (6.2831853 / uGrStripe));
  float grSw = fwidth(grSv) + 0.0001;
  float grStripe = smoothstep(-grSw, grSw, grSv) * grNegF * (1.0 - vGrChev);
  grCol = mix(grCol, uGrDark, grStripe * 0.85);
  grCol = mix(grCol, uGrGold, clamp(vGrFrame.z, 0.0, 1.0));
  diffuseColor.rgb = grCol;
`;
// Replaces <emissivemap_fragment> (no emissive map is ever used on this material).
const FRAME_FRAG_EMISSIVE = /* glsl */`
  float grPulse = 1.0 + 0.15 * vGrChev * sin(uTime * 3.2 * uGrMotion - vGrObj.y * 2.2);
  totalEmissiveRadiance = grCol * uGrEmissive * max(vGrFrame.w, 0.0) * mix(uGrBodyGain, 1.0, vGrChev) * grPulse;
`;

// ---------------------------------------------------------------------------------------------------
// MaterialLibrary
// ---------------------------------------------------------------------------------------------------
export class MaterialLibrary {
  /**
   * Created by RenderSystem.init() after TextureFactory.build() (ARCH §4.1 step 5e). Reads
   * ctx.render.textures, ctx.render.uniforms.uTime, ctx.quality, ctx.save.settings and subscribes to
   * quality:change / settings:change (removed in dispose()).
   */
  constructor(ctx) {
    this.ctx = ctx;
    const render = ctx && ctx.render ? ctx.render : null;
    /** The ONE shared time uniform (=== ctx.render.uniforms.uTime). */
    this.uTime = render && render.uniforms && render.uniforms.uTime ? render.uniforms.uTime : { value: 0 };

    // caches
    this._standard = new Map();     // key → MeshStandardMaterial
    this._hdr = new Map();          // key → MeshBasicMaterial (HDR, toneMapped false)
    this._particles = new Map();    // variant key → ShaderMaterial (fxmaterials.js)
    this._glyphs = [null, null];    // [facing (uBillboard 0), billboard (uBillboard 1)]
    this._gatePanel = null;
    this._gateFrame = null;
    this._hpBar = null;
    this._tracer = null;
    this._blobShadow = null;
    this._decal = null;
    this._sky = null;
    this._frameUniforms = null;
    this._depth = [null, null, null, null, null, null, null, null];   // depthFor() by (instanced | instanceColor << 1 | map << 2)

    // state mirrored into uniforms
    this._hc = false;
    this._low = false;
    this._reducedMotion = false;
    this._uMotion = { value: 1 };   // shared by every material that animates (0 under reduced motion)

    // initial state from the live quality object and the saved settings
    const q = ctx ? ctx.quality : null;
    if (q && q.params) this._low = MaterialLibrary._isLow(q.params, q.tier);
    let settings = null;
    try { settings = ctx && ctx.save ? ctx.save.settings : null; } catch (_) { settings = null; }
    if (settings) {
      this._hc = settings.hcGates === true;
      const rm = settings.reducedMotion;
      this._reducedMotion = rm === null || rm === undefined ? mediaReducedMotion() : rm === true;
    } else {
      this._reducedMotion = mediaReducedMotion();
    }
    this._uMotion.value = this._reducedMotion ? 0 : 1;

    // listeners (unsubscribe functions kept for dispose)
    this._offs = [];
    const events = ctx ? ctx.events : null;
    if (events && typeof events.on === 'function') {
      this._offs.push(events.on('quality:change', (p) => { if (p && p.params) this.applyQuality(p.params, p.tier); }));
      this._offs.push(events.on('settings:change', (p) => {
        if (!p) return;
        if (p.key === 'hcGates') this.setHighContrast(p.value === true);
        else if (p.key === 'reducedMotion') this.setReducedMotion(p.value === null || p.value === undefined ? mediaReducedMotion() : p.value === true);
      }));
    }
  }

  /** Low = the tier without bloom (glow quads + emissive boost substitute, GDD §16). */
  static _isLow(params, tier) { return tier === 'low' || (!!params && params.bloom === 'off'); }

  /** ctx.render.textures (TextureFactory) or null. */
  _textures() {
    const r = this.ctx ? this.ctx.render : null;
    return r && r.textures ? r.textures : null;
  }

  // -------------------------------------------------------------------------------------------
  // Generic materials
  // -------------------------------------------------------------------------------------------
  /**
   * Cached MeshStandardMaterial. `hex` is an sRGB data.js colour (Color.setHex → linear).
   * opts: roughness, metalness, vertexColors, emissive (hex), emissiveIntensity, flatShading, map, emissiveMap,
   * transparent, opacity, side, depthWrite, depthTest, fog, blending, alphaTest, polygonOffset, wireframe.
   * Key `${hex}|${roughness}|${metalness}|${vertexColors}` + the other given options. Shared: clone before mutating.
   */
  standard(hex, opts) {
    const o = opts || null;
    const roughness = o && o.roughness !== undefined ? o.roughness : DEFAULT_ROUGHNESS;
    const metalness = o && o.metalness !== undefined ? o.metalness : DEFAULT_METALNESS;
    const vertexColors = !!(o && o.vertexColors);
    const color = hex === undefined || hex === null ? 0xFFFFFF : hex;
    const key = color + '|' + roughness + '|' + metalness + '|' + vertexColors + optKey(o);
    let m = this._standard.get(key);
    if (m) return m;
    m = new MeshStandardMaterial({ roughness, metalness, vertexColors });
    m.color.setHex(color);
    if (o) {
      if (o.emissive !== undefined && o.emissive !== null) m.emissive.setHex(o.emissive);
      if (o.emissiveIntensity !== undefined) m.emissiveIntensity = o.emissiveIntensity;
      if (o.flatShading !== undefined) m.flatShading = !!o.flatShading;
      if (o.map) m.map = o.map;
      if (o.emissiveMap) m.emissiveMap = o.emissiveMap;
      applyCommonOpts(m, o);
    }
    m.name = 'gr.standard';
    this._standard.set(key, m);
    return m;
  }

  /**
   * Cached unlit HDR MeshBasicMaterial: toneMapped false, colour set with setRGB(r, g, b, LinearSRGBColorSpace)
   * (HDR triplets are already linear — never double-converted). opts: transparent, opacity, side, blending,
   * depthWrite, depthTest, fog, map, alphaTest, polygonOffset, wireframe, vertexColors.
   */
  hdrBasic(r, g, b, opts) {
    const o = opts || null;
    const vc = !!(o && o.vertexColors);
    const key = r + '|' + g + '|' + b + '|' + vc + optKey(o);
    let m = this._hdr.get(key);
    if (m) return m;
    m = new MeshBasicMaterial({ toneMapped: false, vertexColors: vc });
    m.color.setRGB(r, g, b, LinearSRGBColorSpace);
    if (o) {
      if (o.map) m.map = o.map;
      applyCommonOpts(m, o);
    }
    m.toneMapped = false;                       // HDR contract: never tone-mapped per material (ARCH §9.4)
    m.name = 'gr.hdr';
    this._hdr.set(key, m);
    return m;
  }

  /** Bullet tracers: white base × instanceColor (linear HDR per kind, written straight into the Float32Array). */
  tracer() {
    if (this._tracer) return this._tracer;
    const m = new MeshBasicMaterial({ color: 0xFFFFFF, toneMapped: false });
    m.name = 'gr.tracer';
    this._tracer = m;
    return m;
  }

  /** Low-tier blob shadow discs: black at RENDER.blobShadow.opacity, soft edge from textures.glow alpha. */
  blobShadow() {
    if (this._blobShadow) return this._blobShadow;
    const tex = this._textures();
    const m = new MeshBasicMaterial({
      transparent: true, opacity: RENDER.blobShadow.opacity, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    m.color.setRGB(0, 0, 0);                    // pure black disc (#000, ARCH §9.3)
    if (tex && tex.glow) m.map = tex.glow;
    m.name = 'gr.blobShadow';
    this._blobShadow = m;
    return m;
  }

  /**
   * Shadow-depth material for a caster (round-2 QA VIS-14): a cached MeshDepthMaterial({ depthPacking: RGBADepthPacking })
   * per combination of the program-relevant caster traits — `instanced` (InstancedMesh), `instanceColor` (it has an
   * instanceColor attribute) and `map` (its material has a colour map) — allocated once. Assign it as the caster's
   * `customDepthMaterial`. Why: three's WebGLShadowMap draws every caster WITHOUT a customDepthMaterial with ONE shared
   * internal depth material and copies map / alphaTest onto it, so instanced, instanced-with-colour, mapped and plain
   * casters alternating in one shadow pass flip its 'instancing' / 'instancingColor' / 'map' program parameters and
   * re-resolve its program (getParameters + cache-key garbage) one or more times per frame. Each material returned here
   * only ever sees one combination; plain (non-instanced, unmapped) casters can stay on three's default. The shadow pass
   * still copies side / map / alphaTest from the caster's material each draw (uniform state only).
   */
  depthFor(o) {
    const key = (o && o.instanced ? 1 : 0) | (o && o.instanceColor ? 2 : 0) | (o && o.map ? 4 : 0);
    let m = this._depth[key];
    if (m) return m;
    m = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    m.name = 'gr.depth' + (key & 1 ? '.inst' : '') + (key & 2 ? '.color' : '') + (key & 4 ? '.map' : '');
    this._depth[key] = m;
    return m;
  }

  // -------------------------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------------------------
  /**
   * The ONE ShaderMaterial for the 12 instanced gate panels (ARCH D5): transparent, DoubleSide (single
   * pass), depthWrite false, fog-aware, unlit. Per-instance iPanel / iScale (contract at the top of this file);
   * uOpacity = GATE_RULES.panel.opacity, or opacityHC with the High-contrast gates setting.
   */
  gatePanel() {
    if (this._gatePanel) return this._gatePanel;
    const P = GATE_RULES.panel;
    const tints = new Array(GATE_TYPE_KEYS.length);
    for (let i = 0; i < GATE_TYPE_KEYS.length; i++) tints[i] = lin(GATE_RULES.colors[GATE_TYPE_KEYS[i]].tint);
    const uniforms = withFog({
      uTints: { value: tints },
      uGold: { value: lin(GATE_RULES.colors.max) },
      uDark: { value: lin(PALETTE.glyph.outline) },
      uOpacity: { value: P.opacity },
      uOpacityZero: { value: P.opacityZero },
      uHalf: { value: new Vector2(P.w * 0.5, P.h * 0.5) },
      // maxed panels grow at the top to cover the lifted pill + its halo (VIS-7)
      uPad: { value: new Vector4(PANEL_PAD_M, PANEL_PAD_M, PANEL_PAD_M, BADGE_LIFT_M + BADGE_HALF_H + BADGE_HALO_M) },
      uCorner: { value: new Vector3(PANEL_CORNER_M, PANEL_TOP_ROUND_M, PANEL_SQUARE_M) },
      uPeak: { value: PANEL_PEAK_M },
      uChev: { value: new Vector4(CHEV_DROP_M, CHEV_HALF_W_M, CHEV_H_M, CHEV_STROKE_M) },
      uRim: { value: new Vector3(PANEL_RIM_M, PANEL_INNER_GLOW_M, PANEL_HALO_M) },
      uStripe: { value: new Vector3(STRIPE_BAND_M, STRIPE_PERIOD_M, FRAME_COVER_M) },
      uRing: { value: new Vector3(RING_INSET_M, RING_HALF_W_M, FRAME_COVER_M) },
      uBadge: { value: new Vector3(BADGE_HALF_W, BADGE_HALF_H, BADGE_LIFT_M) },
      uFogK: { value: new Vector4(PANEL_HIT_MIX, PANEL_FAR_ALPHA, PANEL_FAR_COMP, PANEL_FOG_CAP) },
      uRoadBg: { value: lin(PALETTE.road.asphalt) },
      uPlate: { value: new Vector4(PLATE_DROP, PLATE_HALF_W, PLATE_HALF_H, PLATE_RADIUS_M) },
      uPlateK: { value: new Vector4(PLATE_DARKEN, PLATE_ALPHA, PANEL_LUM_CAP, PANEL_COMP_CAP) },
      uPlateCap: { value: PLATE_LUM_CAP },
    });
    uniforms.uTime = this.uTime;
    uniforms.uMotion = this._uMotion;
    const m = new ShaderMaterial({
      name: 'gr.gatePanel', uniforms, vertexShader: PANEL_VERT, fragmentShader: PANEL_FRAG,
      transparent: true, side: DoubleSide, depthWrite: false, fog: true, blending: NormalBlending,
    });
    m.forceSinglePass = true;            // DoubleSide + transparent would otherwise draw twice (back, then front)
    this._gatePanel = m;
    this._applyPanelOpacity();
    return m;
  }

  /**
   * Gate frame: MeshStandardMaterial whose onBeforeCompile reads iFrame (type colour + flip recolour,
   * gold MAX lerp, emissive boost, hazard stripes and down-chevrons on negative types). Emissive gain
   * RENDER.gateFrameEmissive, × (1 + RENDER.lowTierEmissiveBoost) on Low (GDD §16). Program cache key 'gr:gateframe'.
   */
  gateFrame() {
    if (this._gateFrame) return this._gateFrame;
    const F = GATE_RULES.frame;
    const cols = new Array(GATE_TYPE_KEYS.length);
    for (let i = 0; i < GATE_TYPE_KEYS.length; i++) cols[i] = lin(GATE_RULES.colors[GATE_TYPE_KEYS[i]].frame);
    const u = {
      uGrCols: { value: cols },
      uGrGold: { value: lin(GATE_RULES.colors.max) },
      uGrDark: { value: lin(PALETTE.glyph.outline) },
      uGrEmissive: { value: this._frameEmissive() },
      uGrStripe: { value: FRAME_STRIPE_PERIOD_M },
      uGrBodyGain: { value: FRAME_BODY_EMISSIVE },
      uGrChevRows: { value: new Vector3(CHEVRON_ROWS[0], CHEVRON_ROWS[1], CHEVRON_ROWS[2]) },
      uGrChev: { value: new Vector4(CHEVRON_CENTRE_DROP, F.postW * 0.5 - 0.005, CHEVRON_ROWS[0] - 0.5, CHEVRON_ROWS[2] + 0.3) },
      uGrPostX: { value: F.barW * 0.5 - F.postW * 0.5 },
      uGrMotion: this._uMotion,
      uTime: this.uTime,
    };
    this._frameUniforms = u;
    const m = new MeshStandardMaterial({
      color: 0xFFFFFF, roughness: PALETTE.material.metal.roughness, metalness: PALETTE.material.metal.metalness,
    });
    m.name = 'gr.gateFrame';
    m.onBeforeCompile = (shader) => {
      const keys = Object.keys(u);
      for (let i = 0; i < keys.length; i++) shader.uniforms[keys[i]] = u[keys[i]];
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + FRAME_VERT_PARS)
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + FRAME_VERT_NORMAL)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + FRAME_VERT_POSITION);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAME_FRAG_PARS)
        .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\n' + GATE_FOG_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAME_FRAG_COLOR)
        .replace('#include <emissivemap_fragment>', FRAME_FRAG_EMISSIVE)
        .replace('#include <fog_fragment>', GATE_FOG_APPLY);                 // capped, desaturated fog (VIS-9)
    };
    m.customProgramCacheKey = () => 'gr:gateframe';
    this._gateFrame = m;
    return m;
  }

  /**
   * Digit-atlas glyph quads. Shared by gates (value text, corner type glyph, MAX letters) and fx (floaters,
   * damage numbers, the squad count label).
   *
   * Attribute layout (InstancedMesh of PlaneGeometry(1, 1) — the quad's size comes from the instance matrix):
   *   iGlyph   vec4  (u0, v0, u1, v1)  atlas cell rect from TextureFactory.glyphUV (v up, canvas row 0 on top)
   *   iPopTime float uTime (ctx.render.uniforms.uTime = ctx.time.elapsed) of the last pop; ≤ 0 = never pops.
   *                  Pop = scale 1 + GATE_RULES.glyph.pop·(1 − age/GATE_RULES.glyph.popTime) for age < popTime.
   *   iColor   vec3  linear HDR tint (e.g. PALETTE.glyph.emissive·white = 2.5 so the text blooms). The atlas is
   *                  white fill + dark outline, so the outline stays dark. A peak component below
   *                  GLYPH_FADE_KNEE (0.2) also scales coverage: dimming iColor to 0 fades the quad out.
   * Variants (both cached; clone before changing uniforms):
   *   glyph()     uBillboard 0 — quads keep the instance orientation (gates face +Z).
   *   glyph(true) uBillboard 1 — camera-facing: only the matrix translation and its column lengths
   *               (x = width, y = height) are used (fx floaters / numbers / label).
   * Premultiplied alpha (atlas is premultiplied), depthWrite false, DoubleSide single pass, toneMapped false
   * (HDR clips to white on Low; bloom on High/Medium), fog-aware.
   */
  glyph(billboard = false) {
    const i = billboard ? 1 : 0;
    if (this._glyphs[i]) return this._glyphs[i];
    const tex = this._textures();
    const atlas = tex && tex.digitAtlas ? tex.digitAtlas : null;
    if (!atlas) warnOnce('materials.atlas', 'MaterialLibrary.glyph(): digit atlas missing — glyphs render as solid quads');
    const uniforms = withFog({
      uBillboard: { value: i },
      uPop: { value: GATE_RULES.glyph.pop },
      uPopTime: { value: GATE_RULES.glyph.popTime },
      uHasAtlas: { value: atlas ? 1 : 0 },
      uFadeKnee: { value: GLYPH_FADE_KNEE },
    });
    uniforms.uTime = this.uTime;
    uniforms.uAtlas = { value: atlas };
    const m = new ShaderMaterial({
      name: billboard ? 'gr.glyphBillboard' : 'gr.glyph', uniforms, vertexShader: GLYPH_VERT, fragmentShader: GLYPH_FRAG,
      transparent: true, depthWrite: false, side: DoubleSide, fog: true, premultipliedAlpha: true, toneMapped: false,
      blending: NormalBlending,
    });
    m.forceSinglePass = true;
    this._glyphs[i] = m;
    return m;
  }

  /**
   * Zombie HP bars: billboarded pill bars (dark outline, track, green → amber → red fill with a gloss line,
   * quarter ticks at ZOMBIES.brute.staggerEvery, pulsing below 25 %). iHp float 0..1 (< 0 hidden); instance
   * matrix = translation + scale over PlaneGeometry(ZOMBIES.common.hpBar.w, .h). Fog-aware, depthWrite false.
   */
  hpBar() {
    if (this._hpBar) return this._hpBar;
    const bar = ZOMBIES.common.hpBar;
    const uniforms = withFog({
      uSize: { value: new Vector2(bar.w, bar.h) },
      uFull: { value: lin(PALETTE.ui.success) },
      uMid: { value: lin(PALETTE.ui.primary) },
      uLow: { value: lin(PALETTE.ui.danger) },
      uTrack: { value: lin(PALETTE.ui.bossTrack) },
      uBorder: { value: lin(PALETTE.glyph.outline) },
      uBar: { value: new Vector4(HP_BORDER_M, ZOMBIES.brute.staggerEvery, HP_LOW_PULSE, HP_FILL_GAIN) },
    });
    uniforms.uTime = this.uTime;
    uniforms.uMotion = this._uMotion;
    const m = new ShaderMaterial({
      name: 'gr.hpBar', uniforms, vertexShader: HPBAR_VERT, fragmentShader: HPBAR_FRAG,
      transparent: true, depthWrite: false, side: FrontSide, fog: true, blending: NormalBlending,
    });
    this._hpBar = m;
    return m;
  }

  // -------------------------------------------------------------------------------------------
  // Delegated factories (owned by fx / environment engineers; cached here)
  // -------------------------------------------------------------------------------------------
  /** GPU particle material, one cached instance per variant ('additive' | 'normal'); built by fxmaterials.js. */
  particle(variant) {
    const key = variant === undefined || variant === null ? '' : String(variant);
    let m = this._particles.get(key);
    if (m) return m;
    m = makeParticleMaterial(this.ctx, variant);
    if (m) this._particles.set(key, m);
    return m;
  }

  /** Instanced decal material (iDecal), cached; built by fxmaterials.js. */
  decal() {
    if (!this._decal) this._decal = makeDecalMaterial(this.ctx) || null;
    return this._decal;
  }

  /** Sky dome material, cached; built by environment.js. */
  sky() {
    if (!this._sky) this._sky = makeSkyMaterial(this.ctx) || null;
    return this._sky;
  }

  // -------------------------------------------------------------------------------------------
  // Live settings (also driven by this library's own quality:change / settings:change listeners)
  // -------------------------------------------------------------------------------------------
  /** Tier change (ARCH §9.3/§9.4): Low gets the gate-frame emissive boost that substitutes for bloom. */
  applyQuality(params, tier) {
    const t = tier !== undefined ? tier : (this.ctx && this.ctx.quality ? this.ctx.quality.tier : undefined);
    this._low = MaterialLibrary._isLow(params, t);
    if (this._frameUniforms) this._frameUniforms.uGrEmissive.value = this._frameEmissive();
  }

  /** High-contrast gates: panel opacity GATE_RULES.panel.opacityHC (neutral panels scaled by the same ratio). */
  setHighContrast(on) {
    this._hc = !!on;
    this._applyPanelOpacity();
  }

  /** Reduced motion: freezes the cosmetic sheen / pulses / twinkles (uMotion = 0). */
  setReducedMotion(on) {
    this._reducedMotion = !!on;
    this._uMotion.value = this._reducedMotion ? 0 : 1;
  }

  _frameEmissive() {
    return RENDER.gateFrameEmissive * (this._low ? 1 + RENDER.lowTierEmissiveBoost : 1);
  }

  _applyPanelOpacity() {
    if (!this._gatePanel) return;
    const P = GATE_RULES.panel;
    const u = this._gatePanel.uniforms;
    u.uOpacity.value = this._hc ? P.opacityHC : P.opacity;
    u.uOpacityZero.value = this._hc ? P.opacityZero * (P.opacityHC / P.opacity) : P.opacityZero;
  }

  // -------------------------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------------------------
  /** Calls fn(material) for every material this library has created or cached. */
  _each(fn) {
    for (const m of this._standard.values()) fn(m);
    for (const m of this._hdr.values()) fn(m);
    for (const m of this._particles.values()) fn(m);
    const singles = [this._glyphs[0], this._glyphs[1], this._gatePanel, this._gateFrame, this._hpBar, this._tracer,
      this._blobShadow, this._decal, this._sky];
    for (let i = 0; i < singles.length; i++) if (singles[i]) fn(singles[i]);
    for (let i = 0; i < this._depth.length; i++) if (this._depth[i]) fn(this._depth[i]);
  }

  /** Flags every cached material for a program rebuild (shadow-map type change, ARCH §9.3). */
  markAllNeedsUpdate() {
    this._each((m) => { m.needsUpdate = true; });
  }

  /** Removes the listeners and disposes every material this library created (textures belong to TextureFactory). */
  dispose() {
    for (let i = 0; i < this._offs.length; i++) {
      const off = this._offs[i];
      if (typeof off === 'function') { try { off(); } catch (_) { /* already removed */ } }
    }
    this._offs.length = 0;
    this._each((m) => { try { m.dispose(); } catch (_) { /* context already gone */ } });
    this._standard.clear();
    this._hdr.clear();
    this._particles.clear();
    this._glyphs[0] = null; this._glyphs[1] = null;
    this._gatePanel = null; this._gateFrame = null; this._hpBar = null; this._tracer = null;
    this._blobShadow = null; this._decal = null; this._sky = null; this._frameUniforms = null;
    this._depth.fill(null);
  }
}
