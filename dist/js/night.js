// js/night.js — GATE RUSH night: the runtime-only NIGHT modifier (PLAN night TECH), owned and imported only by render.js. A night
// level plays the day script byte for byte: this changes what the player sees and hears, never the simulation (no random
// stream is drawn: the flicker and the groans are hashes of time).
// 1. Program variants: two NEW chunk keys and a per-material onBeforeCompile WRAPPER (applyVariant: cache key '<day key>|grN',
//    defines GR_NIGHT, + _LITE, + _MIN; v = 0 gives the day's source and key back), so the day programs keep their source and key.
//    Variants are defines, never uniform branches (software GL pays for gated-off code per pixel).
// 2. The light rig is one uniform array grNight = NIGHT_UNIFORM.value (20 vec4, view space, by reference):
//      0 on, decay, cookie, shadow mod | 1 band A.xyz, range | 2 band B.xyz, cos outer | 3 band dir, cos inner
//      4 band rgb, cookie spacing | 5 time, tan alpha, —, gate decay | 6 muzzle pos, range | 7 muzzle rgb, muzzle decay
//      8 row 0 centre, half length | 9 lane axis, gate range | 10–12 row 0 stops (rgb, x) | 13 row 1 centre, half length
//      14–16 row 1 stops | 17 —, wrap, spec, — | 18 flare pos, range | 19 flare rgb, decay
//    Reach comes from the squad COUNT, the band width from world.squadHalfWidth (the logical formation): identical on every tier.
// 3. EYE SPRITES (B6): one non-instanced draw (software GL charges per instance). Pair i is texel i of a 512 × 1 RGBA32F texture:
//    (x, y, z, class + 0.999·alpha) at the head front in the drawn pose. The vertex shader takes pair and corner from gl_VertexID,
//    expands two dots in clip space with the pixel floors and dims them with distance.
// 4. Flares: a crate opened at night ALSO launches one (the crate still pays). Readiness lives in render (preparePrograms).
// Emits night:on, night:click, night:flare, hud:pill, night:groan / screech / roar { x, z }, 'audio:loop' nightBed. Zero per-frame allocation.
import {
  ShaderChunk, Vector3, Vector4, Matrix4, Color, InstancedMesh, ShaderMaterial, CylinderGeometry, Mesh, BufferGeometry,
  BufferAttribute, InstancedBufferAttribute, DataTexture, RGBAFormat, FloatType, NearestFilter, AdditiveBlending, DoubleSide,
  DynamicDrawUsage,
} from 'three';
import { clamp, warnOnce } from './util.js';
import { NIGHT, ZOMBIES, GATE_RULES, WORLD, JUICE } from './data.js';

const NIGHT_VEC = 20;   // vec4 slots of grNight (layout in the header)
export const NIGHT_UNIFORM = { value: new Float32Array(NIGHT_VEC * 4) };   // grNight, shared by reference
const D = NIGHT_UNIFORM.value;
/** Program variant codes (material defines): 0 day, 1 FULL, 2 LITE, 3 MIN. */
export const VARIANT = Object.freeze({ day: 0, full: 1, lite: 2, min: 3 });

/** The night variant tier `tier` ('high' | 'med' | 'low') draws; software GL always MIN (NIGHT.variant, D15). */
export function variantFor(tier, software) {
  const V = NIGHT.variant;
  return software ? V.software : (V[tier] || V.low);
}

// ---- GLSL: the night term (two new chunks), spliced per material by the wrapper ----
const PARS = /* glsl */`
uniform vec4 grNight[ ${NIGHT_VEC} ];
float grNightAtt( float d, float range, float decay ) {
	float f = 1.0 / max( pow( max( d, 1e-3 ), decay ), 0.01 );
	float k = saturate( 1.0 - pow4( d / range ) );
	return f * k * k;
}
void grNightLight( vec3 toL, vec3 col, vec3 gn, vec3 gv, PhysicalMaterial m, inout ReflectedLight rl ) {
	float nl = dot( gn, toL );
	float wrapK = grNight[ 17 ].y;
	rl.directDiffuse += col * saturate( ( nl + wrapK ) / ( 1.0 + wrapK ) ) * BRDF_Lambert( m.diffuseColor );
#ifndef GR_NIGHT_LITE
	rl.directSpecular += col * ( saturate( nl ) * grNight[ 17 ].z ) * BRDF_GGX( toL, gv, gn, m );
#endif
}
#ifndef GR_NIGHT_MIN
void grNightPoint( int p, vec3 gp, vec3 gn, vec3 gv, PhysicalMaterial m, inout ReflectedLight rl ) {
	vec3 d = grNight[ p ].xyz - gp;
	float dl = max( length( d ), 1e-3 );
	if ( dl < grNight[ p ].w ) grNightLight( d / dl, grNight[ p + 1 ].rgb * grNightAtt( dl, grNight[ p ].w, grNight[ p + 1 ].w ), gn, gv, m, rl );
}
vec3 grRowColour( float t, int b ) {
	float x1 = grNight[ b + 1 ].w;
	return t < x1 ? mix( grNight[ b ].rgb, grNight[ b + 1 ].rgb, smoothstep( grNight[ b ].w, x1, t ) )
		: mix( grNight[ b + 1 ].rgb, grNight[ b + 2 ].rgb, smoothstep( x1, grNight[ b + 2 ].w, t ) );
}
void grNightRow( int c, int b, vec3 gp, vec3 gn, vec3 gv, PhysicalMaterial m, inout ReflectedLight rl ) {
	float hl = grNight[ c ].w;
	if ( hl <= 0.0 ) return;
	float t = clamp( dot( gp - grNight[ c ].xyz, grNight[ 9 ].xyz ), - hl, hl );
	vec3 d = grNight[ c ].xyz + grNight[ 9 ].xyz * t - gp;
	float dl = max( length( d ), 1e-3 );
	if ( dl < grNight[ 9 ].w ) grNightLight( d / dl, grRowColour( t, b ) * grNightAtt( dl, grNight[ 9 ].w, grNight[ 5 ].w ), gn, gv, m, rl );
}
#endif
void grNightApply( vec3 gp, vec3 gn, vec3 gv, PhysicalMaterial m, inout ReflectedLight rl, float sh ) {
	if ( grNight[ 0 ].x < 0.5 ) return;
	vec3 A = grNight[ 1 ].xyz, AB = grNight[ 2 ].xyz - A, Dir = grNight[ 3 ].xyz;
	float abl2 = max( dot( AB, AB ), 1e-4 );
	float u = dot( gp - A, AB ) / abl2;
	vec3 dQ = gp - ( A + AB * clamp( u, 0.0, 1.0 ) );
	float dist = max( length( dQ ), 1e-3 );
	vec3 Ld = dQ / dist;
	float spot = smoothstep( grNight[ 2 ].w, grNight[ 3 ].w, dot( Ld, Dir ) );
	if ( spot > 0.0 && dist < grNight[ 1 ].w ) {
		float att = spot * grNightAtt( dist, grNight[ 1 ].w, grNight[ 0 ].y );
#ifndef GR_NIGHT_LITE
		float f = max( dot( dQ, Dir ), 0.0 );
		float lat = u * sqrt( abl2 ) / max( 0.4, 1.0 + f * grNight[ 5 ].y );
		float tt = grNight[ 5 ].x;
		att *= ( 1.0 + grNight[ 0 ].z * ( 0.6 * sin( lat * grNight[ 4 ].w + tt * 0.9 + f * 0.15 ) + 0.4 * sin( lat * grNight[ 4 ].w * 1.73 - tt * 1.4 - f * 0.22 ) ) )
			* mix( 1.0, sh, grNight[ 0 ].w );
#endif
		grNightLight( - Ld, grNight[ 4 ].rgb * att, gn, gv, m, rl );
	}
#ifndef GR_NIGHT_MIN
	grNightPoint( 6, gp, gn, gv, m, rl );
	grNightPoint( 18, gp, gn, gv, m, rl );
	grNightRow( 8, 10, gp, gn, gv, m, rl );
#ifndef GR_NIGHT_LITE
	grNightRow( 13, 14, gp, gn, gv, m, rl );
#endif
#endif
}
`;
// FULL's shadow modulation: the sun's shadowed colour over its unshadowed one at this fragment
const CALL = /* glsl */`
#if defined( RE_Direct )
{
	float grSh = 1.0;
	#if ( NUM_DIR_LIGHTS > 0 ) && defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 ) && ! defined( GR_NIGHT_LITE )
		grSh = saturate( dot( directLight.color, vec3( 1.0 ) ) / max( dot( directionalLights[ 0 ].color, vec3( 1.0 ) ), 1e-6 ) );
	#endif
	grNightApply( geometryPosition, geometryNormal, geometryViewDir, material, reflectedLight, grSh );
}
#endif
`;
// models.js GLSL_EMISSIVE_FRAG's eye line; at night the head part's emissive pieces take the class tint, out to where the sprite has
// taken over (past it the true eyes would only fill the gap of the sprite's pair)
const EYE_LINE = 'totalEmissiveRadiance += diffuseColor.rgb * ( step( 0.4, grTag ) * step( grTag, 0.6 ) ) * uEyeEmissive * grAlive;';
const EYE_LINE_NIGHT = `totalEmissiveRadiance += mix( diffuseColor.rgb, grEyeTint.rgb * ( 1.0 - smoothstep( ${NIGHT.eyes.trueFade[0].toFixed(1)}, ${NIGHT.eyes.trueFade[1].toFixed(1)}, length( vViewPosition ) ) ),`
  + ' grEyeTint.a * step( 4.5, vGrPart ) * ( 1.0 - step( 5.5, vGrPart ) ) )'
  + ' * ( step( 0.4, grTag ) * step( grTag, 0.6 ) ) * uEyeEmissive * grAlive;';
const INC_PARS = '#include <lights_physical_pars_fragment>';
const INC_END = '#include <lights_fragment_end>';
const SKIP_KEY = 'gr:gateframe';
const CLASS_IDS = ZOMBIES.common.types;   // walker, runner, crawler, brute, spitter: the eye class index
const _tint = {};   // classId → { value: Vector4 (linear rgb, 1) } shared by its materials

/** Registers the two night chunks (no existing chunk changes). Idempotent. */
export function installNightChunks() {
  ShaderChunk.gr_night_pars = PARS;
  ShaderChunk.gr_night_call = CALL;
}

/** The wrapper's splice (after the material's own onBeforeCompile). */
function spliceNight(shader, m) {
  let fs = shader.fragmentShader;
  if (fs.indexOf(INC_END) < 0 || fs.indexOf(INC_PARS) < 0) { warnOnce('night.splice.' + m.name, 'night: no lights chunk in ' + m.name); return; }
  fs = fs.replace(INC_PARS, INC_PARS + '\n#include <gr_night_pars>').replace(INC_END, '#include <gr_night_call>\n' + INC_END);
  if (bindNight(shader, m) && fs.indexOf(EYE_LINE) >= 0) {
    fs = fs.replace(EYE_LINE, EYE_LINE_NIGHT).replace('uniform float uEyeEmissive;', 'uniform float uEyeEmissive;\nuniform vec4 grEyeTint;');
  }
  shader.fragmentShader = fs;
}

/**
 * The night uniforms into this program's uniform object; true when the material has an eye tint. three keeps ONE such object per material,
 * the newest program's (WebGLRenderer.getProgram), and every program of the material draws with it. A day program made after a night one (a
 * tier change compiles both, a lost context rebuilds them in any order) must carry them too, or the night program stops receiving grNight:
 * no light pool, nothing updating. Harmless by day: three uploads only what a program declares.
 */
function bindNight(shader, m) {
  const cid = m.userData.classId, hex = NIGHT.eyes.colors[cid];
  shader.uniforms.grNight = NIGHT_UNIFORM;
  if (hex === undefined) return false;
  let u = _tint[cid];
  if (!u) { const c = new Color(hex); u = _tint[cid] = { value: new Vector4(c.r, c.g, c.b, 1) }; }
  shader.uniforms.grEyeTint = u;
  return true;
}

/**
 * Switches ONE MeshStandardMaterial (every lit material of the game) to program variant v. From its first call the material keeps a day
 * wrapper (its own onBeforeCompile + bindNight, the key pinned to the original): the day source and key stay, only the uniform object
 * gains the night entries. Returns true when the variant changed.
 */
export function applyVariant(m, v) {
  if (!m || !m.isMeshStandardMaterial) return false;
  let s = m.userData.grNight;
  if (!s) {
    const key = m.customProgramCacheKey();
    if (key === SKIP_KEY) { m.userData.grNight = { skip: true }; return false; }
    s = m.userData.grNight = { skip: false, v: 0, obc: m.onBeforeCompile, wrap: null, day: null, dayKey: null, nightKey: null };
    s.wrap = function grNightCompile(shader, renderer) { s.obc.call(this, shader, renderer); spliceNight(shader, this); };
    s.day = function grDayCompile(shader, renderer) { s.obc.call(this, shader, renderer); bindNight(shader, this); };
    s.dayKey = function grDayKey() { return key; };
    s.nightKey = function grNightKey() { return key + '|grN'; };
    m.onBeforeCompile = s.day; m.customProgramCacheKey = s.dayKey;
  }
  if (s.skip || s.v === v) return false;
  const d = m.defines || (m.defines = {});
  delete d.GR_NIGHT; delete d.GR_NIGHT_LITE; delete d.GR_NIGHT_MIN;
  if (v === 0) {
    m.onBeforeCompile = s.day;
    m.customProgramCacheKey = s.dayKey;
  } else {
    m.onBeforeCompile = s.wrap;
    m.customProgramCacheKey = s.nightKey;
    d.GR_NIGHT = '';
    if (v >= 2) d.GR_NIGHT_LITE = '';
    if (v === 3) d.GR_NIGHT_MIN = '';
  }
  s.v = v;
  m.needsUpdate = true;
  return true;
}

// ---- Beams (air glow of the flashlights) and eye sprites ----
const BEAM_CAP = 16;
const BEAM_VERT = /* glsl */`
attribute float iBeam;
varying float vT; varying vec3 vNv; varying vec3 vVv; varying float vWy; varying float vI; varying float vFogD;
uniform float uLen;
void main() {
	vT = clamp( - position.z / uLen, 0.0, 1.0 );
	vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
	vWy = wp.y;
	vec4 mv = viewMatrix * wp;
	vNv = normalize( ( viewMatrix * modelMatrix * instanceMatrix * vec4( normal, 0.0 ) ).xyz );
	vVv = - mv.xyz; vI = iBeam; vFogD = - mv.z;
	gl_Position = projectionMatrix * mv;
}
`;
const BEAM_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uGain; uniform vec2 uFog;
varying float vT; varying vec3 vNv; varying vec3 vVv; varying float vWy; varying float vI; varying float vFogD;
void main() {
	float edge = pow( max( abs( dot( normalize( vNv ), normalize( vVv ) ) ), 1e-4 ), 0.8 );
	float a = uGain * vI * edge * pow( max( 1.0 - vT, 0.0 ), 1.6 ) * smoothstep( 0.0, 0.04, vT ) * smoothstep( 0.0, 0.6, vWy );
	a = a * ( 1.0 - smoothstep( uFog.x, uFog.y, vFogD ) ) + uGain * vI * 12.0 * ( 1.0 - smoothstep( 0.0, 0.012, vT ) );
	gl_FragColor = vec4( uColor * a, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
// one pair per texel; gl_VertexID = 4·pair + corner, so the geometry carries no attribute
const EYE_VERT = /* glsl */`
uniform highp sampler2D uEyeData;
uniform vec4 uShape[ 5 ];   // half spacing, eye height, eye width (m), luminance
uniform vec3 uCol[ 5 ];
uniform vec4 uGain;         // near gain, far cap, attenuation from, to (m)
uniform vec4 uFloor;        // dot floor, gap floor (px), fade from, to (× the floor)
uniform vec4 uView;         // buffer w, h (px), pull (m), far luminance floor
uniform float uKMin;
varying vec2 vPx; varying vec4 vDot; varying vec3 vCol;
void main() {
	int c = gl_VertexID & 3;
	vec2 corner = vec2( c == 1 || c == 2 ? 1.0 : - 1.0, c > 1 ? 1.0 : - 1.0 );
	vec4 P = texelFetch( uEyeData, ivec2( gl_VertexID >> 2, 0 ), 0 );
	int cls = int( P.w );
	vec4 sh = uShape[ cls ];
	vec4 mv = viewMatrix * vec4( P.xyz, 1.0 );
	float dist = max( - mv.z, 0.5 );
	mv.xyz += normalize( - mv.xyz ) * uView.z;
	vec4 clip = projectionMatrix * mv;
	float pxPerM = projectionMatrix[ 1 ][ 1 ] * 0.5 * uView.y / dist;
	float realH = sh.y * pxPerM;
	float hH = 0.5 * max( realH, uFloor.x );
	float hW = 0.5 * max( sh.z * pxPerM, uFloor.x * ${NIGHT.eyes.widthK.toFixed(3)} );
	float hS = max( sh.x * pxPerM, hW + 0.5 * uFloor.y );
	float a = fract( P.w ) * 1.001 * ( 1.0 - smoothstep( uFloor.x * uFloor.z, uFloor.x * uFloor.w, realH ) );
	float g = mix( uGain.x, min( uGain.x, uGain.y ) * max( uKMin, uView.w / max( sh.w, 1e-3 ) ), smoothstep( uGain.z, uGain.w, dist ) );
	vec2 hq = vec2( hS + hW + 1.0, hH + 1.0 );
	vPx = corner * hq;
	vDot = vec4( hW, hH, hS, a );
	vCol = uCol[ cls ] * g;
	clip.xy += corner * hq * 2.0 / uView.xy * clip.w;
	gl_Position = a > 0.002 ? clip : vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;
/** Two rounded-rectangle dots (SDF); the coverage multiplies AFTER the colour-space step, so the gap stays dark on the canvas tiers.
 *  Varyings vPx (px from the pair centre), vDot (half width, half height, half spacing, alpha), vCol (linear colour × gain). */
export const EYE_FRAG = /* glsl */`
varying vec2 vPx; varying vec4 vDot; varying vec3 vCol;
void main() {
	vec2 p = vec2( abs( vPx.x ) - vDot.z, vPx.y );
	float r = 0.5 * min( vDot.x, vDot.y );
	float a = clamp( 0.5 - ( length( max( abs( p ) - ( vDot.xy - r ), 0.0 ) ) - r ), 0.0, 1.0 ) * vDot.w;
	if ( a < 0.004 ) discard;
	gl_FragColor = vec4( vCol, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	gl_FragColor.rgb *= a;
}
`;

/** Integer hash → [0, 1). */
function hash01(i) {
  let x = (i | 0) ^ 0x9E3779B9;
  x = Math.imul(x ^ (x >>> 16), 0x85EBCA6B); x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
const _v = new Vector3(), _a = new Vector3(), _b = new Vector3(), _m = new Matrix4(), _rx = new Matrix4(), _c = new Color();
const TINT = {};
for (const k of ['plus', 'mult', 'minus', 'div', 'zero', 'item']) { const c = new Color(GATE_RULES.colors[k].tint); TINT[k] = [c.r, c.g, c.b]; }
const OP_KEY = { '+': 'plus', '-': 'minus', x: 'mult', '/': 'div', item: 'item' };
const _rows = [null, null], _cols = [null, null, null], _xs = [0, 0, 0], _mid = [0, 0, 0];
const ANN = 64;   // announced zombie ids (screech / roar), a ring
const P_ON = { on: false, variant: 0, blackout: false };
const P_FLARE = { x: -0, z: -0, seconds: -0 };
const P_PILL = { id: 'flare', icon: 'flare', seconds: -0, color: NIGHT.flare.color };
const P_POS = { x: -0, z: -0 };
const P_LOOP = { id: 'nightBed', on: false, gain: -0 };
const P_SPARK = { kind: 'spark', x: -0, y: -0, z: -0, n: 0, color: NIGHT.flare.color };

export class NightSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.variant = 0;   // the variant every lit material is in now
    this.blackout = false;
    this.forced = 0;   // bench: a variant forced over the tier's
    this.flags = { eyes: true };   // bench: eye sprites drawn
    this.debugPairs = 0;   // bench: extra pairs on a hashed field (cost test; never in play)
    this.eyeCount = 0;
    this.lastReach = 0;   // the band's reach (m)
    this.beams = null; this.eyes = null;
    this.shapes = null;   // per class [half spacing, height, width, eye y, eye z, luminance]
    this._attached = false;
    this._muzzle = 0.5;
    this._flareEnd = -1; this._flareD0 = 0.5; this._flareX = 0.5; this._sparkT = 0.5;
    this._cap = 30; this._flareS = 8; this._gainNear = 1;   // per level (enable)
    this._lessonEyes = false; this._bedPending = false; this._castWas = true;
    this._groanTick = -1; this._gTick = 0; this._gPick = -1; this._gH = 0.5; this._gX = 0.5; this._gZ = 0.5;
    this._near = 1e9;   // nearest pair (m ahead of the squad)
    this._ann = new Int32Array(ANN).fill(-1); this._annAt = 0; this._idle = 0;
    this._adt = 0.5; this._n = 0;
    this._eyeData = null; this._eyeU = null; this._beamU = null; this._iBeam = null;
    this._pack = (id, type, x, z, hp, yaw, vx, vz, pitch) => this._packEye(id, type, x, z, yaw, vx, vz, pitch);
    this._unsubs = [];
    const ev = ctx.events;
    if (ev) {
      this._unsubs.push(ev.on('shot', (p) => {
        const M = NIGHT.muzzle;
        if (this.on) this._muzzle = Math.min(M.envCap, this._muzzle + M.kick + M.perShot * Math.min(p && p.count > 0 ? p.count : 1, M.shotCap));
      }));
      this._unsubs.push(ev.on('crate:open', (p) => { if (this.on) this.flare(p.x); }));
      this._unsubs.push(ev.on('level:start', () => { this._bedPending = this.on; this._lessonEyes = false; this._flareEnd = -1; }));
      this._unsubs.push(ev.on('state:change', (p) => this._menu(p.to)));
    }
  }

  /** Builds the beam and eye meshes (out of the scene until the first prepare). */
  build() {
    const B = NIGHT.beams, E = NIGHT.eyes;
    const geo = new CylinderGeometry(B.radius, 0.035, B.len, 14, 1, true);
    geo.rotateX(Math.PI / 2);
    const pos = geo.attributes.position, nrm = geo.attributes.normal;
    for (let i = 0; i < pos.count; i++) { pos.setZ(i, -B.len / 2 - pos.getZ(i)); nrm.setZ(i, -nrm.getZ(i)); }   // apex at the lens, −Z
    this._iBeam = new InstancedBufferAttribute(new Float32Array(BEAM_CAP), 1).setUsage(DynamicDrawUsage);
    geo.setAttribute('iBeam', this._iBeam);
    _c.set(B.color);
    this._beamU = { uLen: { value: B.len }, uColor: { value: new Vector3(_c.r, _c.g, _c.b) }, uGain: { value: B.gain }, uFog: { value: { x: 38, y: 100, isVector2: true } } };
    const bm = new ShaderMaterial({ uniforms: this._beamU, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false });
    bm.name = 'night.beams';
    const beams = this.beams = new InstancedMesh(geo, bm, BEAM_CAP);
    beams.name = 'night.beams';
    beams.instanceMatrix.setUsage(DynamicDrawUsage);
    beams.frustumCulled = false; beams.matrixAutoUpdate = false; beams.renderOrder = 5; beams.count = 0; beams.visible = false;

    const cap = E.cap;
    const g = new BufferGeometry();
    const ind = new Uint32Array(cap * 6);
    for (let i = 0, v = 0; i < cap * 6; i += 6, v += 4) { ind[i] = v; ind[i + 1] = v + 1; ind[i + 2] = v + 2; ind[i + 3] = v; ind[i + 4] = v + 2; ind[i + 5] = v + 3; }
    g.setIndex(new BufferAttribute(ind, 1));
    g.setDrawRange(0, 0);
    const tex = this._eyeData = new DataTexture(new Float32Array(cap * 4), cap, 1, RGBAFormat, FloatType);
    tex.minFilter = tex.magFilter = NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    const shapeU = [], colU = [];
    for (let k = 0; k < CLASS_IDS.length; k++) { shapeU.push(new Vector4()); colU.push(new Vector3()); }
    this._eyeU = { uEyeData: { value: tex }, uShape: { value: shapeU }, uCol: { value: colU }, uGain: { value: new Vector4() },
      uFloor: { value: new Vector4() }, uView: { value: new Vector4() }, uKMin: { value: E.kMin } };
    const em = new ShaderMaterial({ uniforms: this._eyeU, vertexShader: EYE_VERT, fragmentShader: EYE_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: AdditiveBlending, toneMapped: false, fog: false });
    em.name = 'night.eyes';
    const eyes = this.eyes = new Mesh(g, em);
    eyes.name = 'night.eyes';
    eyes.frustumCulled = false; eyes.matrixAutoUpdate = false; eyes.renderOrder = 6; eyes.visible = false;
  }

  /** Puts the night meshes into the scene. Idempotent. */
  attach(scene) {
    if (this._attached || !scene) return;
    if (!this.eyes) this.build();
    scene.add(this.beams); scene.add(this.eyes);
    this._attached = true;
  }

  /** Warm-draw support: the eye draw holds ONE real pair (40 m ahead), as an empty draw builds no pixel routine on software GL. */
  prime() {
    if (!this.eyes) return;
    this._eyeUniforms();
    const T = this._eyeData.image.data, S = this._shapes();
    T[0] = 0; T[1] = S[0][3]; T[2] = -40; T[3] = 0.999;
    this._eyeData.needsUpdate = true;
    this.eyes.geometry.setDrawRange(0, 6);   // only the warm-up draws it
  }

  endWarm() {
    if (!this.eyes) return;
    this.eyes.geometry.setDrawRange(0, this.on ? this.eyeCount * 6 : 0);
    this.eyes.visible = this.on && this.flags.eyes && this.eyeCount > 0;
  }

  /** Every lit material of the scene to variant v. Traverses the scene, so never per frame. */
  setVariant(v) {
    this.variant = v;
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    const R = this.ctx.render;
    R.scene.traverse((o) => {
      const ms = o.material;
      if (!ms) return;
      if (Array.isArray(ms)) { for (let i = 0; i < ms.length; i++) if (ms[i] && !seen.has(ms[i])) { seen.add(ms[i]); applyVariant(ms[i], v); } }
      else if (!seen.has(ms)) { seen.add(ms); applyVariant(ms, v); }
    });
    R.dirty = true;
  }

  /** render.setNight: on → variant v (prepared by then), the per-level constants (reach cap, flare seconds, eye gain), night:on and
   *  the click at every night start; off → day programs, hidden meshes, the bed loop off, night:on. Idempotent. */
  enable(on, v, blackout) {
    const ctx = this.ctx, sq = ctx.squad, mesh = sq && sq.instances ? sq.instances.mesh : null;
    if (on) {
      const L = ctx.level ? Math.max(1, ctx.level.level | 0) : 1, V = NIGHT.vision, E = NIGHT.eyes;
      this._cap = L > V.capFrom ? Math.max(V.capFloor, V.max - V.capPerLevel * (L - V.capFrom)) : V.max;
      this._flareS = L >= NIGHT.flare.late[0] ? NIGHT.flare.late[1] : NIGHT.flare.seconds;
      this._gainNear = E.intensity * (E.gainBloom + (E.gainBloomLate - E.gainBloom) * clamp((L - E.late[0]) / (E.late[1] - E.late[0]), 0, 1));
      this.attach(ctx.render.scene);
      if (this.variant !== v) this.setVariant(v);
      if (!this.on && mesh) { this._castWas = mesh.castShadow; mesh.castShadow = false; }   // no moon shadows
      this._flareEnd = -1; this._muzzle = 0; this._ann.fill(-1); this._lessonEyes = false; this._bedPending = true;
    } else {
      if (!this.on && this.variant === 0) return;
      if (this.on && mesh) mesh.castShadow = this._castWas;
      if (this.variant !== 0) this.setVariant(0);
      if (this.beams) { this.beams.visible = false; this.beams.count = 0; this.eyes.visible = false; this.eyes.geometry.setDrawRange(0, 0); }
      this._loop(false);
    }
    const was = this.on;
    this.on = !!on;
    this.blackout = !!(on && blackout);
    D[0] = this.on ? 1 : 0;
    this.eyeCount = 0;
    if ((was || this.on) && ctx.events) {
      P_ON.on = this.on; P_ON.variant = this.variant; P_ON.blackout = this.blackout;
      ctx.events.emit('night:on', P_ON);
      if (this.on) ctx.events.emit('night:click', P_ON);
    }
  }

  /** FLARE at crate x (runtime only); a second one refreshes it. */
  flare(x) {
    const ctx = this.ctx, F = NIGHT.flare;
    this._flareEnd = this._levelT() + this._flareS;
    this._flareD0 = ctx.world ? ctx.world.distance : 0;
    this._flareX = clamp(x, 0.5 - WORLD.roadWidth / 2, WORLD.roadWidth / 2 - 0.5);
    this._sparkT = 0;
    P_FLARE.x = this._flareX; P_FLARE.z = -F.ahead; P_FLARE.seconds = this._flareS;
    P_PILL.seconds = this._flareS;
    if (ctx.events) { ctx.events.emit('night:flare', P_FLARE); ctx.events.emit('hud:pill', P_PILL); }
    this._lesson(this._flareS === F.seconds ? 'night.flare' : 'night.flareLate');
  }

  /** Per rendered frame while on (render.draw, after the camera). */
  update(dt) {
    const ctx = this.ctx, R = ctx.render, V = NIGHT.vision, Lt = NIGHT.light, M = NIGHT.muzzle, F = NIGHT.flare;
    const cam = R.camera;
    cam.updateMatrixWorld();
    const Vm = cam.matrixWorldInverse;
    const w = ctx.world, sq = ctx.squad, lv = ctx.level, set = ctx.save ? ctx.save.settings : null;
    const sx = w ? w.squadX : 0;
    const C = sq ? Math.max(1, sq.count | 0) : 1;                   // the COUNT, never the visible soldiers
    const hw = Math.max(Lt.minHalfWidth, (w ? w.squadHalfWidth : 0) * Lt.widthK);
    const t = ctx.time ? ctx.time.elapsed : 0, lt = this._levelT();
    const bright = !!(set && set.nightBright);
    const full = this.variant === VARIANT.full, lite = this.variant === VARIANT.lite;
    // reach and cone (the first meeting eases the reach, D34)
    let range = clamp(V.base + V.perSqrt * Math.sqrt(C), V.min, this._cap);
    if (lv && lv.firstMeet) range /= V.firstMeet;
    if (lt < this._flareEnd) range += F.bonus;
    this.lastReach = range;
    const outer = V.outerBase + V.outerGain * Math.min(1, Math.sqrt(C) / 10);
    const inner = Math.max(V.innerMin, outer - V.innerGap) + (bright ? NIGHT.bright.inner : 0);
    const sway = 0.06 * Math.sin(t * 1.3) + 0.03 * Math.sin(t * 3.1), pr = Lt.pitchDeg * Math.PI / 180;
    _a.set(sx - hw, Lt.y, Lt.z).applyMatrix4(Vm);
    _b.set(sx + hw, Lt.y, Lt.z).applyMatrix4(Vm);
    _v.set(Math.sin(sway) * Math.cos(pr), -Math.sin(pr), -Math.cos(sway) * Math.cos(pr)).transformDirection(Vm);
    D[0] = 1; D[1] = Lt.decay; D[2] = Lt.cookie; D[3] = Lt.shadow;
    D[4] = _a.x; D[5] = _a.y; D[6] = _a.z; D[7] = range;
    D[8] = _b.x; D[9] = _b.y; D[10] = _b.z; D[11] = Math.cos(outer * Math.PI / 180);
    D[12] = _v.x; D[13] = _v.y; D[14] = _v.z; D[15] = Math.cos(inner * Math.PI / 180);
    const bi = Lt.intensity * (0.75 + 0.25 * Math.min(1, Math.sqrt(C / Lt.countRef))) * (bright ? NIGHT.bright.band : 1);
    _c.set(Lt.color);
    D[16] = _c.r * bi; D[17] = _c.g * bi; D[18] = _c.b * bi; D[19] = Lt.spacing;
    D[20] = t % 1000; D[21] = Lt.tanAlpha; D[23] = NIGHT.gates.decay;
    D[69] = Lt.wrap; D[70] = Lt.spec;
    D[27] = 0.001; D[32 + 3] = 0; D[52 + 3] = 0; D[75] = 0.001;
    if (full || lite) {
      // muzzle: the 'shot' envelope × a time-hash flicker
      this._muzzle *= Math.exp(-Math.min(0.1, dt) * M.fade);
      const mi = M.intensity * Math.min(1, this._muzzle) * (1 - M.flicker + M.flicker * hash01(Math.floor(t * M.flickerHz)))
        * Math.min(1.6, 0.6 + Math.sqrt(C) / 10);
      if (mi > 0.001) {
        _v.set(sx, M.y, M.z).applyMatrix4(Vm);
        _c.set(M.color);
        D[24] = _v.x; D[25] = _v.y; D[26] = _v.z; D[27] = M.range;
        D[28] = _c.r * mi; D[29] = _c.g * mi; D[30] = _c.b * mi;
      }
      D[31] = M.decay;
      _v.set(1, 0, 0).transformDirection(Vm);
      D[36] = _v.x; D[37] = _v.y; D[38] = _v.z; D[39] = NIGHT.gates.range;
      if (ctx.gates) this._packRows(Vm);
    }
    this._flareFrame(Vm, lt, full || lite, t);
    this._beams(sx, t, pr);
    const fog = R.scene.fog;
    if (fog) { this._beamU.uFog.value.x = fog.near * 0.5; this._beamU.uFog.value.y = fog.far * 0.6; }
    this._packEyes(lt);
    if (this._bedPending && ctx.state && ctx.state.is('playing')) { this._bedPending = false; this._loop(true); }
  }

  /** Gate rows (FULL 2, LITE 1): the nearest unpassed events' lane colours as a light strip ahead of each row. */
  _packRows(Vm) {
    const G = NIGHT.gates, n = this.ctx.gates.liveEvents(_rows, 2), rows = Math.min(G.rows[this.variant], n);
    for (let r = 0; r < rows; r++) {
      const ev = _rows[r], z = ev.z;
      if (z < G.maxZ || z > 0) continue;
      const k = G.intensity * Math.min(1, (z - G.maxZ) / 10) * Math.min(1, -z / 2 + 0.25);
      const c = r === 0 ? 8 : 13, b = r === 0 ? 10 : 14;
      _v.set(0, G.y, z + G.ahead).applyMatrix4(Vm);
      D[c * 4] = _v.x; D[c * 4 + 1] = _v.y; D[c * 4 + 2] = _v.z; D[c * 4 + 3] = G.half;
      const nl = ev.lanes.length;
      for (let l = 0; l < nl; l++) {
        const g = ev.lanes[l];
        const key = (g.op === '/' && g.flipped) ? 'mult' : ((g.op === '-' && g.flipped) ? 'plus' : (OP_KEY[g.op] || 'zero'));
        _cols[l] = TINT[key]; _xs[l] = g.x;
      }
      let c0 = _cols[0], c1 = _cols[0], c2 = _cols[0], x0 = -3, x1 = 0, x2 = 3;
      if (nl === 2) { c2 = _cols[1]; for (let i = 0; i < 3; i++) _mid[i] = (c0[i] + c2[i]) / 2; c1 = _mid; x0 = _xs[0] - 0.6; x2 = _xs[1] + 0.6; }
      else if (nl === 3) { c1 = _cols[1]; c2 = _cols[2]; x0 = _xs[0]; x1 = _xs[1]; x2 = _xs[2]; }
      const o = b * 4;
      D[o] = c0[0] * k; D[o + 1] = c0[1] * k; D[o + 2] = c0[2] * k; D[o + 3] = x0;
      D[o + 4] = c1[0] * k; D[o + 5] = c1[1] * k; D[o + 6] = c1[2] * k; D[o + 7] = x1;
      D[o + 8] = c2[0] * k; D[o + 9] = c2[1] * k; D[o + 10] = c2[2] * k; D[o + 11] = x2;
    }
  }

  /** The burning flare: road-fixed, a flickering red light on FULL / LITE, sparks (fx:burst) on every tier. */
  _flareFrame(Vm, lt, light, t) {
    if (!(lt < this._flareEnd)) return;
    const F = NIGHT.flare, ctx = this.ctx, w = ctx.world;
    const z = -F.ahead + (w ? w.distance + w.roadSpeed * (ctx.time ? ctx.time.alpha : 0) * WORLD.step - this._flareD0 : 0);
    const fade = Math.min(1, (this._flareEnd - lt) / 1.5);
    if (light) {
      const k = F.intensity * fade * (0.8 + 0.2 * hash01(Math.floor(t * 18) + 7));
      _v.set(this._flareX, 0.35, z).applyMatrix4(Vm);
      _c.set(F.color);
      D[72] = _v.x; D[73] = _v.y; D[74] = _v.z; D[75] = F.glow;
      D[76] = _c.r * k; D[77] = _c.g * k; D[78] = _c.b * k; D[79] = F.decay;
    }
    if (z < 4 && lt >= this._sparkT && ctx.events) {
      this._sparkT = lt + F.sparkS;
      P_SPARK.x = this._flareX; P_SPARK.y = 0.25; P_SPARK.z = z; P_SPARK.n = F.sparks;
      ctx.events.emit('fx:burst', P_SPARK);
    }
  }

  /** Air beams from evenly picked shooters of the LOGICAL formation. */
  _beams(sx, t, pr) {
    const mesh = this.beams, q = this.ctx.quality, sq = this.ctx.squad;
    const shooters = sq ? Math.min(40, Math.max(1, sq.count | 0)) : 1;
    const nb = Math.min(NIGHT.beams[q && q.software ? 'software' : (q && q.tier) || 'high'] | 0, shooters, BEAM_CAP);
    mesh.count = nb;
    mesh.visible = nb > 0;
    if (!nb) return;
    const arr = mesh.instanceMatrix.array, ib = this._iBeam.array, Lt = NIGHT.light;
    for (let i = 0; i < nb; i++) {
      let x = sx, y = Lt.y, z = Lt.z + 0.1;
      if (sq) {
        sq.shooterPosition(Math.min(Math.floor((i + 0.5) * shooters / nb), shooters - 1), _v);
        x = _v.x; z = _v.z - 0.15; y = Math.max(0.9, _v.y + 0.25);
      }
      _m.makeRotationY(-(0.09 * Math.sin(t * (0.9 + 0.23 * i) + i * 1.7) + (x - sx) * 0.05));
      _rx.makeRotationX(-(pr + 0.03 * Math.sin(t * (1.3 + 0.17 * i) + i)));
      _m.multiply(_rx).setPosition(x, y, z).toArray(arr, i * 16);
      ib[i] = 0.75 + 0.25 * Math.sin(t * 7.3 + i * 2.1) * Math.sin(t * 3.1 + i);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this._iBeam.needsUpdate = true;
  }

  /** Per class: the eye centre (model space) from the tagged emissive vertices of the head part, the shape, the colour's luminance.
   *  Lazy (models arrives after render at boot); the walker numbers stand in until then. */
  _shapes() {
    if (this.shapes) return this.shapes;
    const G = this.ctx.models && this.ctx.models.geo, E = NIGHT.eyes, out = [];
    for (let k = 0; k < CLASS_IDS.length; k++) {
      const id = CLASS_IDS[k], g = G ? G[id] : null, ap = g && g.getAttribute('aPart'), ps = g && g.getAttribute('position');
      let y = 1.45, z = -0.12, n = 0;
      if (ap && ps) {
        let sy = 0, sz = 0;
        for (let i = 0; i < ap.count; i++) {
          const a = ap.getX(i), part = Math.floor(a + 0.01), tag = a - part;
          if (part === 5 && tag > 0.4 && tag < 0.6) { n++; sy += ps.getY(i); sz += ps.getZ(i); }
        }
        if (n > 0) { y = sy / n; z = sz / n; }
      }
      const sh = E.shapes[id];
      _c.set(E.colors[id]);
      out.push([sh[0], sh[1], sh[2], y, z, 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b]);
    }
    if (G) this.shapes = out;
    return out;
  }

  /** Per-class uniforms, the tier gains and the pixel floors of the eye material. */
  _eyeUniforms() {
    const S = this._shapes(), E = NIGHT.eyes, U = this._eyeU, R = this.ctx.render;
    for (let k = 0; k < S.length; k++) {
      const s = S[k];
      U.uShape.value[k].set(s[0], s[1], s[2], s[5]);
      _c.set(E.colors[CLASS_IDS[k]]);
      U.uCol.value[k].set(_c.r, _c.g, _c.b);
    }
    const bloom = !!(R.composer && R._composerOn);
    U.uGain.value.set(bloom ? this._gainNear : E.intensity * E.gainCanvas, bloom ? E.farBloom : 1, E.att[0], E.att[1]);
    const gl = R.renderer.getContext(), bh = gl.drawingBufferHeight, pxCss = bh / (R.size && R.size.h > 0 ? R.size.h : bh);
    U.uFloor.value.set(Math.max(E.minDotCss * pxCss, E.minDotPx), Math.max(E.minGapCss * pxCss, E.minGapPx), E.fade[0], E.fade[1]);
    U.uView.value.set(gl.drawingBufferWidth, bh, E.pull, E.lumFloor);
  }

  /** Every living zombie's pair, the lesson and the positional sounds. */
  _packEyes(lt) {
    const ctx = this.ctx, Z = ctx.zombies, mesh = this.eyes, cap = NIGHT.eyes.cap, S = NIGHT.sounds;
    this._shapes();
    this._n = 0; this._near = 1e9; this._gPick = -1; this._gH = -1;
    this._adt = (ctx.time ? ctx.time.alpha : 0) * WORLD.step;
    const tick = this._gTick = Math.floor(lt / S.groanS);
    if (this.flags.eyes && Z) Z.forEachAlive(this._pack);
    const T = this._eyeData.image.data;
    for (let i = 0; i < this.debugPairs && this._n < cap; i++) {     // bench: a hashed field 30–70 m ahead
      const o = this._n * 4, k = i % CLASS_IDS.length;
      T[o] = -4 + 8 * hash01(i * 3 + 1); T[o + 1] = this.shapes ? this.shapes[k][3] : 1.45; T[o + 2] = -30 - 40 * hash01(i * 3 + 2); T[o + 3] = k + 0.999;
      this._n++;
    }
    const n = this.eyeCount = this._n;
    mesh.geometry.setDrawRange(0, n * 6);
    mesh.visible = n > 0;
    if (n > 0) { this._eyeData.needsUpdate = true; this._eyeUniforms(); }
    if (!this._lessonEyes && this._near < NIGHT.eyesLessonM) this._lessonEyes = this._lesson('night.eyes');
    if (tick !== this._groanTick) {                                  // one groan per tick
      this._groanTick = tick;
      if (this._gPick >= 0) this._emitAt('night:groan', this._gX, this._gZ);
    }
  }

  /** forEachAlive callback: zombies.render's drawn pose (T · Ry · Rx) applied to the eye centre, so the pair sits on the head; the
   *  far calls of runners and brutes. */
  _packEye(id, type, x, z, yaw, vx, vz, pitch) {
    if (this._n >= NIGHT.eyes.cap) return;
    const k = CLASS_IDS.indexOf(type), S = NIGHT.sounds;
    if (k < 0) return;
    const sh = this.shapes ? this.shapes[k] : this._shapes()[k];
    const adt = this._adt;
    const px = x + (vx || 0) * adt, pz = z + (vz || 0) * adt, p = pitch || 0;
    const cp = Math.cos(p), sp = Math.sin(p), zl = sp * sh[3] + cp * sh[4];
    const T = this._eyeData.image.data, o = this._n * 4;
    T[o] = px + Math.sin(yaw) * zl; T[o + 1] = cp * sh[3] - sp * sh[4]; T[o + 2] = pz + Math.cos(yaw) * zl;
    T[o + 3] = k + 0.999 * clamp((pz - WORLD.spawnZ) / NIGHT.eyes.spawnFadeM, 0, 1);
    this._n++;
    const ahead = -pz;
    if (ahead > 0 && ahead < this._near) this._near = ahead;
    if (ahead > 0 && ahead < S.groanM) {                             // the groan pick: the highest hash
      const h = hash01(id ^ Math.imul(this._gTick, 7919));
      if (h > this._gH) { this._gH = h; this._gPick = id; this._gX = px; this._gZ = pz; }
    }
    if ((type === 'runner' && ahead < S.screechM && pz < ZOMBIES.runner.screechZ) || (type === 'brute' && ahead < S.roarM && pz < ZOMBIES.brute.swing.ringZ)) {
      for (let i = 0; i < ANN; i++) if (this._ann[i] === id) return;
      this._ann[this._annAt] = id; this._annAt = (this._annAt + 1) % ANN;
      this._emitAt(type === 'runner' ? 'night:screech' : 'night:roar', px, pz);
    }
  }

  /** A menu's idle prefetch (PLAN night TECH 3): NEXT on the results, else the frontier or the last level, when that plays at night. */
  _menu(to) {
    clearTimeout(this._idle);
    const ctx = this.ctx, lv = ctx.level, R = ctx.render, last = lv ? lv.level | 0 : 0;
    if (!lv || !ctx.save || !(to === 'complete' || to === 'title' || to === 'levels')) return;
    const a = to === 'complete' ? last + 1 : Math.max(1, ctx.save.data.highestUnlocked | 0), b = to === 'complete' ? 0 : last;
    if (!lv._typeOf(a).night && !(b > 0 && lv._typeOf(b).night)) return;
    this._idle = setTimeout(() => { if (ctx.state.is(to)) R.preparePrograms(R.variantForLevel(true), null, true); }, NIGHT.prefetchMs);
  }

  _emitAt(name, x, z) {
    const ev = this.ctx.events;
    if (!ev) return;
    P_POS.x = x; P_POS.z = z;
    ev.emit(name, P_POS);
  }

  /** A night lesson, only while someone is playing: an idle run shows (and records) no night-only hint. True when offered. */
  _lesson(id) {
    const ctx = this.ctx, e = ctx.engine;
    if (!ctx.level || !ctx.state || !ctx.state.is('playing') || !e || e.inputIdleS() > JUICE.ui.hintIdleS) return false;
    ctx.level.showHint(id);
    return true;
  }

  _loop(on) {
    const ev = this.ctx.events;
    if (!ev) return;
    P_LOOP.on = on; P_LOOP.gain = NIGHT.sounds.bed;
    ev.emit('audio:loop', P_LOOP);
  }

  _levelT() { return this.ctx.time ? this.ctx.time.levelTime : 0; }

  dispose() {
    clearTimeout(this._idle);
    for (let i = 0; i < this._unsubs.length; i++) if (typeof this._unsubs[i] === 'function') this._unsubs[i]();
    this._unsubs.length = 0;
    for (const o of [this.beams, this.eyes]) {
      if (!o) continue;
      if (o.parent) o.parent.remove(o);
      o.geometry.dispose(); o.material.dispose();
    }
    if (this._eyeData) this._eyeData.dispose();
    this.beams = this.eyes = null; this._attached = false;
  }
}
