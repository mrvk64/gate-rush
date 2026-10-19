// js/models.js — Gate Rush ModelLibrary, CharacterInstances, boss rigs (ARCHITECTURE §6.4).
//
// Every model in the game is procedural geometry built once in ModelLibrary.init():
//   • characters (soldier + troop variants, five zombie classes) are merged BufferGeometries whose
//     parts carry `aPart` (part id) and `aPivot` (joint position) attributes; the limb swing, bob,
//     recoil, hit flash, tint and death sink/darkening run entirely in the vertex/fragment chunks
//     injected by makeCharacterMaterial() so an InstancedMesh of 300 soldiers costs one draw call;
//   • props, gate frame/panel, crate, coin, rocket, glob, shard, tracer, muzzle and the unit quad are
//     plain merged geometries for the other modules' materials (props carry a `color` attribute);
//   • boss rigs are CPU-animated Groups (buildBossRig; boss.js animates them, animateRig is an
//     optional helper with the same conventions) with named children.
//
// Conventions (read by every consumer):
//   • Every character geometry faces −Z with its feet at y = 0 (the squad's forward). Zombies walk
//     toward +Z, so their owner passes yaw = π to CharacterInstances.writeMatrix. Troop meshes face −Z
//     at yaw 0. Boss rigs are the exception: they are built facing +Z (toward the squad) with the
//     group origin at the feet, because boss.js aims them with yaw = atan2(squadX − x, squadZ − z).
//   • Part ids: 0 torso/static, 1 legL, 2 legR, 3 armL, 4 armR, 5 head, 6 rifle (recoil), 7 jaw
//     (static when merged). The fraction of aPart is a piece tag (TAG): .5 emissive (eyes, sacs);
//     soldier classes only: .125 helmet dome, .25 helmet brim (magnet glow), .75 shoulder (armour glint).
//   • Positive angle about +X swings a hanging limb toward −Z (forward for a −Z-facing body).
//   • Per-instance data: iAnim = (phase, speed, hitTime, fireTime), iState = (death01, tintR, tintG, tintB).
//       phase    time offset (s) of the walk clock: walk = (uTime·speed + phase)·uFreq·2π. Any range
//                works (squad passes [0, 1), zombies [0, 2π)); a full cycle is 1/uFreq s.
//       speed    walk clock rate and amplitude (0 = frozen in the rest pose, 1 = class gait, amp ≤ 1.5).
//       hitTime  uTime of the last hit → white flash over ZOMBIES.common.hitFlash.
//       fireTime uTime of the last shot → recoil over FIRE.muzzleFlash.ms (soldier classes only).
//       death01  sinks + darkens the body. Soldier classes (squad.js) pass sinceDeath / (topple + sink)
//                and sink only past the topple fraction; zombie classes (zombies.js) pass the sink
//                progress itself (0 during the topple) — each class material carries its own
//                uToppleFrac so both callers' conventions render correctly.
//   • Colours: every hex comes from PALETTE (sRGB) and is converted to linear through Color.setHex
//     before it is written into the `color` vertex attribute (the material colour stays white).
//
// Dependencies: three, three/addons BufferGeometryUtils (mergeGeometries), ./util.js, ./data.js.
// No DOM, no WebGL access at import time; ctx.render is read only inside init()/factories.

import {
  BufferGeometry, BufferAttribute, InstancedBufferAttribute, Float32BufferAttribute,
  BoxGeometry, SphereGeometry, CylinderGeometry, PlaneGeometry, CircleGeometry, IcosahedronGeometry, TorusGeometry, RingGeometry,
  MeshStandardMaterial, MeshDepthMaterial, MeshBasicMaterial, RGBADepthPacking,
  InstancedMesh, Mesh, Group, Color, Vector3, Quaternion, Matrix4, DynamicDrawUsage, AdditiveBlending,
  SkinnedMesh, Skeleton, Bone, Uint16BufferAttribute,
  LinearSRGBColorSpace, Shape, ExtrudeGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng, hashString, clamp, lerp, warnOnce } from './util.js';
import {
  SQUAD, FIRE, GATE_RULES, ZOMBIES, BOSSES, TROOPS, PICKUPS, RENDER, PALETTE, DISTRICT_PROPS,
} from './data.js';

// ---------------------------------------------------------------------------------------------
// Part ids (ARCH §6.4) and the vertex-attribute budget (ARCH §6.4 "Vertex attribute budget")
// ---------------------------------------------------------------------------------------------

/** Part ids carried by `aPart`. Exported so owners can read them back (e.g. tests, debug). */
export const PART = Object.freeze({
  TORSO: 0, LEG_L: 1, LEG_R: 2, ARM_L: 3, ARM_R: 4, HEAD: 5, RIFLE: 6, JAW: 7,
});

/** Character attribute set (5 slots) + instanceMatrix (4) + iAnim/iState (2) = 11 (ARCH §6.4). */
const CHARACTER_ATTRIBUTES = ['position', 'normal', 'color', 'aPart', 'aPivot'];
const INSTANCE_MATRIX_SLOTS = 4;      // a mat4 attribute takes 4 vertex-attribute locations
const INSTANCE_DATA_SLOTS = 2;        // iAnim + iState
const VERTEX_ATTRIBUTE_BUDGET = CHARACTER_ATTRIBUTES.length + INSTANCE_MATRIX_SLOTS + INSTANCE_DATA_SLOTS;   // 11
const GUARANTEED_MAX_ATTRIBUTES = 16; // WebGL 2 minimum MAX_VERTEX_ATTRIBS (used when no renderer exists, e.g. node tools)

// Classes that use the soldier limb set and the recoil variant of the shader ('gr:char-recoil').
const SOLDIER_CLASSES = Object.freeze({ soldier: true, sniper: true, flamer: true, medic: true });
const ZOMBIE_CLASSES = Object.freeze({ walker: true, runner: true, crawler: true, brute: true, spitter: true });
const CHARACTER_CLASSES = ['soldier', 'sniper', 'flamer', 'medic', 'walker', 'runner', 'crawler', 'brute', 'spitter'];

// Death timing (SQUAD.death === ZOMBIES.common.death values). Soldier classes receive death01 over the
// whole (topple + sink) window, so their sink starts at the topple fraction; zombie classes receive the
// sink progress directly (fraction 0). See the header.
const SOLDIER_TOPPLE_FRAC = SQUAD.death.topple / (SQUAD.death.topple + SQUAD.death.sink);
const ZOMBIE_TOPPLE_FRAC = 0;
// Recoil settles over the muzzle flash duration (FIRE.muzzleFlash.ms → seconds).
const RECOIL_SECONDS = FIRE.muzzleFlash.ms / 1000;
// Death darkening target / mix (ARCH §6.4 fragment chunk: "mix toward 0.12 by iState.x·0.6").
const DEATH_DARK = 0.12;
const DEATH_DARK_MIX = 0.6;
// Extra burial depth below the body's own height so a toppled, sunk body is fully under the road.
const SINK_MARGIN = 0.15;
// Hit flash (GDD §6.1 "0.06 s white emissive blink" with the §15 colour identity still readable, CHR-7):
// the diffuse is mixed halfway toward white and a small emissive share keeps the shadowed side blinking.
const HIT_FLASH_DIFFUSE_MIX = 0.5;
const HIT_FLASH_EMISSIVE = 0.35;
// Piece tags carried in the fraction of aPart (see the header). Exact binary fractions (float32-safe).
const TAG = Object.freeze({ NONE: 0, HELM_DOME: 0.125, HELM_BRIM: 0.25, EMISSIVE: 0.5, SHOULDER: 0.75 });
// Soldier-class readability light (CHR-3, GDD §1/§3.1 "the squad must pop on every tier"): warm fresnel rim
// (colour × strength, exponent) plus an up-facing fill (fraction of the diffuse) — fragment-only, soldier classes.
const RIM_COLOR = [1.0 * 0.3, 0.82 * 0.3, 0.6 * 0.3];
const RIM_POWER = 2.5;
const TOP_FILL = 0.1;
// Gear glows on the soldier material (CHR-2, GDD §8.2): magnet → helmet rings purple (×0.8, 1.5 Hz pulse);
// armour → blue shoulder glint (×0.6, moving sweep). Linear multipliers of the sRGB palette colours.
const MAGNET_GLOW = 0.8;
const ARMOR_GLOW = 0.6;
// "No hit / no shot yet" sentinel for iAnim.z / iAnim.w (uTime − (−1000) → flash and recoil 0).
const IANIM_NEVER = -1e3;

// ---------------------------------------------------------------------------------------------
// GLSL — injected through onBeforeCompile (three r170 resolves #include after the hook, so the
// replacements below may themselves use #include). `attribute`/`varying` are #defined to in/out by
// three's WebGL 2 prefix, so the GLSL 1 spelling is correct here. iAnim / iState are declared here for
// both the InstancedMesh path (InstancedBufferAttribute) and single troop meshes (per-vertex copies).
// ---------------------------------------------------------------------------------------------

// Vertex prologue: per-character data, part attributes, limb uniforms, helpers.
const GLSL_VERT_PROLOGUE = /* glsl */`
attribute float aPart;
attribute vec3 aPivot;
attribute vec4 iAnim;
attribute vec4 iState;
uniform float uTime;
uniform float uFreq;
uniform float uLegAmp;
uniform float uArmAmp;
uniform float uArmRest;
uniform float uBobAmp;
uniform float uRecoil;
uniform float uRecoilTime;
uniform float uSinkDepth;
uniform float uToppleFrac;
const float GR_TAU = 6.28318530718;
float grWalkT() { return ( uTime * iAnim.y + iAnim.x ) * uFreq * GR_TAU; }
float grAmpK() { return clamp( iAnim.y, 0.0, 1.5 ); }
vec3 grRotX( vec3 v, float c, float s ) { return vec3( v.x, c * v.y - s * v.z, s * v.y + c * v.z ); }
// Rotation (rad) about +X at aPivot for part p given the walk phase sine sw. Positive = toward −Z,
// so a hanging limb (−Y) swings forward for a positive angle.
float grAngle( float p, float sw ) {
	float k = grAmpK();
	if ( p < 0.5 ) return 0.0;
	if ( p < 1.5 ) return uLegAmp * sw * k;
	if ( p < 2.5 ) return - uLegAmp * sw * k;
#ifdef GR_RECOIL
	// soldiers: both arms and the rifle sway together (they hold one weapon; the arms are baked in the
	// aiming pose pre-rotated by −uArmRest, so uArmRest brings them back onto the rifle)
	if ( p < 4.5 ) return uArmRest + uArmAmp * 0.5 * sw * k;
	if ( p < 5.5 ) return uLegAmp * 0.12 * sin( 2.0 * grWalkT() ) * k;
	if ( p < 6.5 ) return uArmAmp * 0.5 * sw * k;
#else
	// zombies: each arm swings opposite its own leg around the class "zombie reach" rest angle
	if ( p < 3.5 ) return uArmRest - uArmAmp * sw * k;
	if ( p < 4.5 ) return uArmRest + uArmAmp * sw * k;
	if ( p < 5.5 ) return uLegAmp * 0.12 * sin( 2.0 * grWalkT() ) * k;
#endif
	return 0.0;
}
float grSink() { return uSinkDepth * smoothstep( uToppleFrac, 1.0, iState.x ); }
`;

const GLSL_VERT_VARYINGS = /* glsl */`
varying vec4 vGrAnim;
varying vec4 vGrState;
varying float vGrEmis;
varying float vGrPart;
`;

// Replaces <beginnormal_vertex>: rotate the normal with its part.
const GLSL_BEGINNORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
{
	float grP = floor( aPart + 0.01 );
	float grA = grAngle( grP, sin( grWalkT() ) );
	if ( grA != 0.0 ) { float c = cos( grA ); float s = sin( grA ); objectNormal = grRotX( objectNormal, c, s ); }
}
#ifdef USE_TANGENT
	vec3 objectTangent = vec3( tangent.xyz );
#endif
`;

// Replaces <begin_vertex>: limb rotation about the pivot, bob, recoil.
const GLSL_BEGIN = /* glsl */`
vec3 transformed = vec3( position );
{
	float grP = floor( aPart + 0.01 );
	float grT = grWalkT();
	float grA = grAngle( grP, sin( grT ) );
	if ( grA != 0.0 ) { float c = cos( grA ); float s = sin( grA ); transformed = aPivot + grRotX( transformed - aPivot, c, s ); }
	if ( grP < 0.5 || grP > 2.5 ) transformed.y += uBobAmp * abs( sin( grT ) ) * grAmpK();
#ifdef GR_RECOIL
	if ( grP > 2.5 && grP < 6.5 && abs( grP - 5.0 ) > 0.5 ) {
		float grR = max( 0.0, 1.0 - ( uTime - iAnim.w ) / uRecoilTime );
		transformed.z += uRecoil * grR;
	}
#endif
#ifdef GR_VARYINGS
	vGrAnim = iAnim;
	vGrState = iState;
	vGrEmis = fract( aPart );          // piece tag (TAG), decoded in the fragment chunk
	vGrPart = grP;
#endif
}
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif
`;

// Replaces <project_vertex>: the death sink happens in world space (after instanceMatrix), so a
// toppled body sinks straight down whatever its pitch. Owners keep their meshes at the origin.
const GLSL_PROJECT = /* glsl */`
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition.y -= grSink();
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

// Replaces <worldpos_vertex> (shadow coordinates follow the sink).
const GLSL_WORLDPOS = /* glsl */`
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition.y -= grSink();
	worldPosition = modelMatrix * worldPosition;
#endif
`;

const GLSL_FRAG_PROLOGUE = /* glsl */`
varying vec4 vGrAnim;
varying vec4 vGrState;
varying float vGrEmis;
varying float vGrPart;
uniform float uTime;
uniform float uHitFlashInv;
uniform float uHitFlashEmissive;
uniform float uDeathDark;
uniform float uDeathDarkMix;
uniform float uEyeEmissive;
uniform float uHitFlashMix;
uniform vec3 uRifleGlow;
uniform vec3 uRimColor;
uniform float uRimPower;
uniform float uTopFill;
uniform float uMagnet;
uniform float uArmor;
uniform vec3 uMagnetGlow;
uniform vec3 uArmorGlow;
`;

// Replaces <color_fragment> (ARCH §6.4): vertex colour, tint, hit flash, death darkening.
const GLSL_COLOR_FRAG = /* glsl */`
#if defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#elif defined( USE_COLOR )
	diffuseColor.rgb *= vColor;
#endif
float grFlash = max( 0.0, 1.0 - ( uTime - vGrAnim.z ) * uHitFlashInv );
diffuseColor.rgb *= vGrState.yzw;
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), uHitFlashMix * grFlash );
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( uDeathDark ), vGrState.x * uDeathDarkMix );
`;

// Replaces <emissivemap_fragment> (keeps it, then adds): emissive eyes/sacs (fade with death), the
// hit flash on the shadowed side too, and for soldier classes the rifle recolour glow on part 6 (GDD J13),
// the readability rim + top fill (CHR-3) and the gear glows (CHR-2: magnet helmet rings, armour shoulders).
// `normal` (view space) is defined by <normal_fragment_begin>, which runs before this chunk.
const GLSL_EMISSIVE_FRAG = /* glsl */`
#include <emissivemap_fragment>
float grTag = vGrEmis;
float grAlive = 1.0 - vGrState.x;
totalEmissiveRadiance += diffuseColor.rgb * ( step( 0.4, grTag ) * step( grTag, 0.6 ) ) * uEyeEmissive * grAlive;
totalEmissiveRadiance += vec3( grFlash * uHitFlashEmissive );
#ifdef GR_RECOIL
	totalEmissiveRadiance += uRifleGlow * step( 5.5, vGrPart ) * ( 1.0 - step( 6.5, vGrPart ) );
	{
		vec3 grV = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : normalize( vViewPosition );
		float grRim = pow( 1.0 - saturate( dot( normal, grV ) ), uRimPower );
		float grTop = saturate( dot( normal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) ) );
		totalEmissiveRadiance += ( uRimColor * grRim + diffuseColor.rgb * ( uTopFill * grTop ) ) * grAlive;
		float grHelm = step( 0.2, grTag ) * step( grTag, 0.3 ) + 0.45 * step( 0.08, grTag ) * step( grTag, 0.18 );
		float grPulse = 0.72 + 0.28 * sin( uTime * 9.42478 );
		totalEmissiveRadiance += uMagnetGlow * ( uMagnet * grHelm * grPulse * grAlive );
		float grSh = step( 0.7, grTag ) * step( grTag, 0.8 );
		float grSweep = 0.35 + 0.65 * smoothstep( 0.55, 1.0, sin( uTime * 3.2 + vViewPosition.x * 0.9 - vViewPosition.y * 0.5 ) );
		totalEmissiveRadiance += uArmorGlow * ( uArmor * grSh * grSweep * grAlive );
	}
#endif
`;

/**
 * Replaces `#include <name>` once; throws at compile time when a required chunk is missing (a silent
 * miss would render undeformed, un-flashing characters — far harder to diagnose than an error).
 */
function replaceChunk(src, name, body, optional) {
  const tag = '#include <' + name + '>';
  if (src.indexOf(tag) < 0) {
    if (optional) return src;
    throw new Error('models: shader chunk <' + name + '> not found (three.js version mismatch?)');
  }
  return src.replace(tag, body);
}

/** Injects the character vertex chunks into a three vertex shader string. */
function injectVertex(src, recoil, withVaryings) {
  let head = '';
  if (recoil) head += '#define GR_RECOIL\n';
  if (withVaryings) head += '#define GR_VARYINGS\n' + GLSL_VERT_VARYINGS;
  let s = head + GLSL_VERT_PROLOGUE + src;
  // the depth shader includes <beginnormal_vertex> only with a displacement map and has no <worldpos_vertex>
  s = replaceChunk(s, 'beginnormal_vertex', GLSL_BEGINNORMAL, !withVaryings);
  s = replaceChunk(s, 'begin_vertex', GLSL_BEGIN, false);
  s = replaceChunk(s, 'project_vertex', GLSL_PROJECT, false);
  s = replaceChunk(s, 'worldpos_vertex', GLSL_WORLDPOS, !withVaryings);
  return s;
}

/** Injects the character fragment chunks into a three fragment shader string. */
function injectFragment(src, recoil) {
  let s = (recoil ? '#define GR_RECOIL\n' : '') + GLSL_FRAG_PROLOGUE + src;
  s = replaceChunk(s, 'color_fragment', GLSL_COLOR_FRAG, false);
  s = replaceChunk(s, 'emissivemap_fragment', GLSL_EMISSIVE_FRAG, false);
  return s;
}

// ---------------------------------------------------------------------------------------------
// Geometry dimensions. These are the art proportions of the procedural models (metres), not GDD
// tuning values; every number that IS data (panel/frame sizes, radii, heights, capacities, colours,
// limb params) is read from data.js where it is used. Characters face −Z, +X is the right hand.
// ---------------------------------------------------------------------------------------------

const DIMS = Object.freeze({
  // Compact soldier (≈ 1.36 m, ≈ 0.40 m across the elbows) so a 0.34 m hex lattice reads as a tight
  // squad rather than a blob of intersecting bodies. The rifle sits at the FIRE.muzzleOffset height.
  soldier: {
    hipY: 0.64, hipHalf: 0.068, legW: 0.11, legD: 0.13, bootH: 0.085, bootW: 0.125, bootD: 0.2,
    torsoW: 0.28, torsoH: 0.4, torsoD: 0.18, beltH: 0.05, rigH: 0.15,
    shoulderY: 1.0, shoulderHalf: 0.165, padW: 0.095, padH: 0.07, padD: 0.15,
    armW: 0.075, armD: 0.085, handS: 0.065,
    headS: 0.19, neckGap: 0.04, helmetR: 0.128, brimR: 0.142, brimH: 0.025,
    pack: { w: 0.22, h: 0.27, d: 0.11 },
    // aiming pose (final pose; the arms are stored pre-rotated by −SQUAD.limb.uArmRest)
    elbowR: [0.185, 0.82, 0.04], handR: [0.08, 0.895, -0.04],
    elbowL: [-0.1, 0.84, -0.14], handL: [0.07, 0.92, -0.26],
  },
  rifle: {
    x: 0.08, y: 0.955, recvL: 0.2, recvZ: -0.1, recvH: 0.075, recvW: 0.05,
    stockL: 0.1, stockH: 0.085, guardL: 0.11, guardH: 0.06, barrelL: 0.07, barrelS: 0.026, magH: 0.11,
    sniperExtra: 0.26, scopeL: 0.16, scopeS: 0.045,
    flamerR: 0.05, flamerL: 0.26, kit: { w: 0.2, h: 0.15, d: 0.1 },
  },
  walker:  { legLen: 0.72, legW: 0.15, legD: 0.17, hipHalf: 0.11, torsoW: 0.36, torsoH: 0.5, torsoD: 0.24, hunch: -0.32,
             shoulderHalf: 0.23, armLen: 0.58, armW: 0.11, armD: 0.12, headW: 0.22, headH: 0.24, headD: 0.24 },
  runner:  { legLen: 0.74, legW: 0.12, legD: 0.14, hipHalf: 0.1, torsoW: 0.3, torsoH: 0.44, torsoD: 0.2, hunch: -0.5,
             shoulderHalf: 0.19, armLen: 0.5, armW: 0.09, armD: 0.1, headW: 0.2, headH: 0.22, headD: 0.22 },
  crawler: { bodyW: 0.34, bodyH: 0.22, bodyD: 0.6, bodyY: 0.42, legLen: 0.42, legW: 0.12, hipHalf: 0.14, hipZ: 0.24,
             armLen: 0.42, armW: 0.1, shoulderHalf: 0.17, shoulderZ: -0.2, headW: 0.24, headH: 0.2, headD: 0.26 },
  brute:   { legLen: 1.1, legW: 0.34, legD: 0.36, hipHalf: 0.3, footH: 0.14, torsoW: 1.1, torsoH: 1.0, torsoD: 0.62,
             shoulderHalf: 0.7, armLen: 1.15, armW: 0.3, armD: 0.3, fist: 0.34, headW: 0.36, headH: 0.34, headD: 0.36 },
  spitter: { legLen: 0.7, legW: 0.13, legD: 0.14, hipHalf: 0.12, bellyR: 0.36, chestW: 0.4, chestH: 0.3, chestD: 0.3,
             shoulderHalf: 0.24, armLen: 0.5, armW: 0.09, armD: 0.1, headW: 0.22, headH: 0.22, headD: 0.24, sacR: 0.12 },
  colossus:{ legLen: 2.6, legW: 0.9, hipHalf: 0.8, torsoW: 3.2, torsoH: 2.6, torsoD: 1.8,
             shoulderHalf: 2.0, armLen: 3.0, armW: 0.8, headW: 0.9, headH: 0.8, cavityW: 1.4, cavityH: 1.3, coreR: 0.55 },
  rig: { coreR: 0.07, plateW: 0.15, plateH: 0.12, plateD: 0.025, chainLinks: 6, linkR: 0.04, linkTube: 0.012, shieldR: 0.3 },   // fractions of BOSSES.rigHeight
  props: {
    barricade: { w: 1.6, baseH: 0.3, baseD: 0.5, topH: 0.5, topD: 0.3 },
    sandbag: { w: 0.6, h: 0.22, d: 0.4 },
    car: { w: 1.8, h: 0.6, l: 4.2, cabinW: 1.6, cabinH: 0.5, cabinL: 2.0, wheelR: 0.33, wheelW: 0.25 },
    building: { w: 6, h: 9, d: 6, parapet: 0.3, doorW: 1.2, doorH: 2.4 },
    tree: { trunkH: 2.6, trunkR: 0.16, branchL: 1.3, branchR: 0.06 },
    rubble: { pieces: 7, min: 0.25, max: 0.8, spread: 1.1 },
    smoke: { w: 3, h: 8 },
    lamppost: { h: 4.5, r: 0.07, armL: 0.9, headW: 0.5, headH: 0.18, headD: 0.3 },
  },
  apc: { w: TROOPS.apc.width, l: TROOPS.apc.length, h: 1.0, turretW: 1.1, turretH: 0.45, gunL: 1.4, gunR: 0.07, wheelR: 0.45, wheelW: 0.3 },
  drone: { bodyW: 0.5, bodyH: 0.16, bodyD: 0.5, armL: 0.55, rotorR: 0.55, gunL: 0.35 },
  // CHR-6 troop readability extras: sniper pallet under the TROOPS.sniper.crateH crate, additive ground ring (inner / outer
  // radius, height, opacity; the sniper ring is wider around its crate), LED intensity, translucent rotor-disc opacity.
  // Round-2 CHR-9: a lower, narrower perch (pallet 0.2 → 0.1 m high, crate 0.9 → 0.62 m, pallet 0.98 → 0.7 m, ring ×1.4 → ×1.1)
  // so sniper + crate stays ≈ 1.3 soldier columns on screen instead of ≈ 2.
  troopExtras: { palletH: 0.1, crateW: 0.62, palletW: 0.7, ringIn: 0.42, ringOut: 0.6, ringY: 0.03, ringOpacity: 0.5, sniperRing: 1.1, ledEmissive: 2.0, discOpacity: 0.15, discR: 0.5 },
  rocket: { r: 0.09, bodyL: 0.5, noseL: 0.25, finL: 0.14 },
  crate: { seam: 0.06 },
  coin: { r: 0.22, h: 0.05, segments: 14, rim: 0.03 },
  gate: { footW: 0.34, footH: 0.08, capH: 0.1, braceH: 0.16, lampW: 0.3, lampH: 0.08, chevLen: 0.46, chevW: 0.09, chevD: 0.1, chevRows: [1.3, 1.95, 2.6], chevAngle: 0.6 },
  tracerThickness: 0.04,               // ARCH §6.11 tracer BoxGeometry(0.04, 0.04, 0.9)
  shard: { w: 0.5, h: 0.4, d: 0.05 },  // ARCH §6.12 shard BoxGeometry(0.5, 0.4, 0.05)
  marker: 0.02,
});

// Module-level scratch (init-time helpers only; never retained across calls)
const _color = new Color();
const _q = new Quaternion();
const _m4 = new Matrix4();
const _va = new Vector3();
const _up = new Vector3(0, 1, 0);
const _rubbleRng = new Rng(hashString('models.rubble'));

// ---------------------------------------------------------------------------------------------
// Geometry helpers (init-time only; allocation is expected here)
// ---------------------------------------------------------------------------------------------

/** BoxGeometry rotated about its own centre (X, then Y, then Z) then translated. */
function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new BoxGeometry(w, h, d);
  if (rx !== 0) g.rotateX(rx);
  if (ry !== 0) g.rotateY(ry);
  if (rz !== 0) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** Box of cross-section w × d spanning the segment a → b (limbs between two joints), plus `ext` length. */
function seg(a, b, w, d, ext = 0) {
  _va.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _va.length();
  const g = new BoxGeometry(w, len + ext, d);
  _va.multiplyScalar(1 / len);
  _q.setFromUnitVectors(_up, _va);
  g.applyMatrix4(_m4.makeRotationFromQuaternion(_q));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

/** Rotates a geometry about an arbitrary pivot (X, then Y, then Z) in place. */
function rotAbout(g, px, py, pz, rx = 0, ry = 0, rz = 0) {
  g.translate(-px, -py, -pz);
  if (rx !== 0) g.rotateX(rx);
  if (ry !== 0) g.rotateY(ry);
  if (rz !== 0) g.rotateZ(rz);
  g.translate(px, py, pz);
  return g;
}

/** CylinderGeometry (axis Y) rotated then translated. */
function cyl(rTop, rBot, h, seg_, x, y, z, rx = 0, ry = 0, rz = 0, open = false) {
  const g = new CylinderGeometry(rTop, rBot, h, seg_, 1, open);
  if (rx !== 0) g.rotateX(rx);
  if (ry !== 0) g.rotateY(ry);
  if (rz !== 0) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** SphereGeometry translated (optionally a dome via the theta range). */
function sphere(r, ws, hs, x, y, z, thetaLen = Math.PI) {
  const g = new SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, thetaLen);
  g.translate(x, y, z);
  return g;
}

/** Part descriptor: geometry + part id + pivot + sRGB hex (+ emissive flag, + soldier piece tag TAG.*). */
function P(geo, part, pivot, hex, emis = false, tag = TAG.NONE) {
  return { geo, part, pivot, hex, emis, tag };
}

/** Vector3 holding the linear rgb of an sRGB hex × k (init-time). */
function linearVec(hex, k) {
  _color.setHex(hex);
  return new Vector3(_color.r * k, _color.g * k, _color.b * k);
}

/** Writes the linear rgb of an sRGB hex into a Float32Array colour attribute range. */
function fillColor(arr, hex) {
  _color.setHex(hex);
  for (let i = 0; i < arr.length; i += 3) { arr[i] = _color.r; arr[i + 1] = _color.g; arr[i + 2] = _color.b; }
}

/**
 * Gives a primitive the character attribute set: `color` (linear rgb), `aPart` (part id, + 0.5 when
 * emissive), `aPivot` (joint position); deletes `uv`/`uv1` (ARCH §6.4). Returns the same geometry.
 */
function tagPart(geo, partId, pivot, hex, emissive = false, tag = TAG.NONE) {
  if (geo.hasAttribute('uv')) geo.deleteAttribute('uv');
  if (geo.hasAttribute('uv1')) geo.deleteAttribute('uv1');
  if (!geo.hasAttribute('normal')) geo.computeVertexNormals();
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  fillColor(col, hex);
  const part = new Float32Array(n);
  part.fill(partId + (emissive ? TAG.EMISSIVE : tag));
  const piv = new Float32Array(n * 3);
  const px = pivot ? pivot[0] : 0, py = pivot ? pivot[1] : 0, pz = pivot ? pivot[2] : 0;
  for (let i = 0; i < n; i++) { piv[i * 3] = px; piv[i * 3 + 1] = py; piv[i * 3 + 2] = pz; }
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.setAttribute('aPart', new Float32BufferAttribute(part, 1));
  geo.setAttribute('aPivot', new Float32BufferAttribute(piv, 3));
  return geo;
}

/** Adds a constant `color` attribute to a prop primitive (keeps uv). */
function colorize(geo, hex) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  fillColor(col, hex);
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  return geo;
}

/** Throws unless every geometry carries the same attribute names and index presence. */
function assertParity(geos, label) {
  const first = geos[0];
  const names = Object.keys(first.attributes).sort().join(',');
  const indexed = first.index !== null;
  for (let i = 1; i < geos.length; i++) {
    const g = geos[i];
    const n = Object.keys(g.attributes).sort().join(',');
    if (n !== names) throw new Error('models: attribute mismatch in "' + label + '" part ' + i + ' (' + n + ' vs ' + names + ')');
    if ((g.index !== null) !== indexed) throw new Error('models: index mismatch in "' + label + '" part ' + i);
  }
}

/** Merges already-attributed parts with mergeGeometries(parts, false); disposes the parts. */
function mergeAll(geos, label) {
  assertParity(geos, label);
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error('models: mergeGeometries failed for "' + label + '"');
  for (let i = 0; i < geos.length; i++) geos[i].dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.userData.tris = merged.index ? merged.index.count / 3 : merged.attributes.position.count / 3;
  merged.userData.height = merged.boundingBox.max.y - merged.boundingBox.min.y;
  merged.name = label;
  return merged;
}

/** Tags every part descriptor and merges them into one character geometry. */
function mergeParts(parts, label) {
  const geos = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    geos[i] = tagPart(p.geo, p.part, p.pivot, p.hex, p.emis, p.tag || TAG.NONE);
  }
  return mergeAll(geos, label);
}

/** Colourises prop primitives (uv kept) and merges them. */
function mergeProps(entries, label) {
  const geos = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) geos[i] = colorize(entries[i].geo, entries[i].hex);
  return mergeAll(geos, label);
}

/** Highest y over a part list (feet are at y = 0 by construction). */
function partsTop(parts) {
  let top = 0;
  for (let i = 0; i < parts.length; i++) {
    const g = parts[i].geo;
    g.computeBoundingBox();
    if (g.boundingBox.max.y > top) top = g.boundingBox.max.y;
  }
  return top;
}

/** Uniformly scales a part list in place (geometry and pivots). */
function scaleParts(parts, s) {
  if (s === 1) return parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    p.geo.scale(s, s, s);
    p.pivot = [p.pivot[0] * s, p.pivot[1] * s, p.pivot[2] * s];
  }
  return parts;
}

/** Turns a −Z-facing part list to face +Z (rotation π about Y: x → −x, z → −z) in place. */
function flipParts(parts) {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    p.geo.rotateY(Math.PI);
    p.pivot = [-p.pivot[0], p.pivot[1], -p.pivot[2]];
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Character builders — return part descriptor arrays (untagged) so both the merged instanced
// geometry and the per-part boss rigs can be built from the same proportions.
// ---------------------------------------------------------------------------------------------

/**
 * Weapon held in the soldier's aiming pose (part RIFLE, pivot = right shoulder): rifle, long scoped
 * rifle (sniper), flame gun (flamer) or a medkit (medic). Baked in its final pose (not pre-rotated).
 */
function weaponParts(variant) {
  const d = DIMS.soldier, r = DIMS.rifle;
  const t = PALETTE.troop;
  const hex = PALETTE.soldier.rifle;
  const pivot = [d.shoulderHalf, d.shoulderY, 0];
  const out = [];
  const x = r.x, y = r.y;
  if (variant === 'medic') {
    out.push(P(box(r.kit.w, r.kit.h, r.kit.d, x - 0.04, y - 0.02, -0.17), PART.RIFLE, pivot, t.medic));
    out.push(P(box(r.kit.w * 0.5, 0.05, 0.012, x - 0.04, y - 0.02, -0.17 - r.kit.d / 2 - 0.004), PART.RIFLE, pivot, t.medicCross));
    out.push(P(box(0.05, r.kit.h * 0.6, 0.012, x - 0.04, y - 0.02, -0.17 - r.kit.d / 2 - 0.004), PART.RIFLE, pivot, t.medicCross));
    return out;
  }
  const recvZ0 = r.recvZ + r.recvL / 2;                 // back of the receiver
  const recvZ1 = r.recvZ - r.recvL / 2;                 // front of the receiver
  out.push(P(box(r.recvW, r.recvH, r.recvL, x, y, r.recvZ), PART.RIFLE, pivot, hex));                                     // receiver
  out.push(P(box(r.recvW * 0.9, r.stockH, r.stockL, x, y - 0.012, recvZ0 + r.stockL / 2), PART.RIFLE, pivot, hex));        // stock
  if (variant === 'flamer') {
    out.push(P(cyl(r.flamerR, r.flamerR * 0.8, r.flamerL, 7, x, y + 0.005, recvZ1 - r.flamerL / 2, Math.PI / 2), PART.RIFLE, pivot, t.flamerTank));   // flame tube
    out.push(P(box(0.035, 0.035, 0.24, x + 0.05, y - 0.04, r.recvZ + 0.06), PART.RIFLE, pivot, hex));                          // hose stub
    return out;
  }
  out.push(P(box(0.04, r.magH, 0.055, x, y - r.recvH / 2 - r.magH / 2 + 0.01, r.recvZ - 0.03), PART.RIFLE, pivot, hex));   // magazine
  out.push(P(box(r.recvW + 0.008, r.guardH, r.guardL, x, y + 0.004, recvZ1 - r.guardL / 2), PART.RIFLE, pivot, PALETTE.soldier.webbing));   // handguard
  const barrelL = variant === 'sniper' ? r.barrelL + r.sniperExtra : r.barrelL;
  out.push(P(box(r.barrelS, r.barrelS, barrelL, x, y + 0.012, recvZ1 - r.guardL - barrelL / 2), PART.RIFLE, pivot, hex));  // barrel
  if (variant === 'sniper') {
    out.push(P(box(r.scopeS, r.scopeS, r.scopeL, x, y + r.recvH / 2 + r.scopeS / 2 + 0.01, r.recvZ - 0.02), PART.RIFLE, pivot, hex));   // scope
  }
  return out;
}

/** Muzzle tip of a variant's weapon in soldier body space (troop markers; same formulas as weaponParts). */
function weaponTip(variant, out) {
  const r = DIMS.rifle;
  const recvZ1 = r.recvZ - r.recvL / 2;
  out.x = r.x;
  if (variant === 'flamer') { out.y = r.y + 0.005; out.z = recvZ1 - r.flamerL; return out; }
  const barrelL = variant === 'sniper' ? r.barrelL + r.sniperExtra : r.barrelL;
  out.y = r.y + 0.012; out.z = recvZ1 - r.guardL - barrelL;
  return out;
}

/** One soldier arm in the aiming pose (shoulder → elbow → hand), pre-rotated by −uArmRest about the shoulder. */
function soldierArm(parts, side, elbow, hand, sleeveHex, skinHex) {
  const d = DIMS.soldier;
  const part = side < 0 ? PART.ARM_L : PART.ARM_R;
  const sh = [side * d.shoulderHalf, d.shoulderY, 0];
  const pre = -SQUAD.limb.uArmRest;
  const geos = [
    { g: seg(sh, elbow, d.armW, d.armD, d.armW * 0.5), hex: sleeveHex },
    { g: seg(elbow, hand, d.armW * 0.92, d.armD * 0.92, d.armW * 0.4), hex: sleeveHex },
    { g: box(d.handS, d.handS, d.handS, hand[0], hand[1], hand[2]), hex: skinHex },
  ];
  for (let i = 0; i < geos.length; i++) {
    rotAbout(geos[i].g, sh[0], sh[1], sh[2], pre);
    parts.push(P(geos[i].g, part, sh, geos[i].hex));
  }
}

/**
 * Soldier and troop bodies (variant 'soldier' | 'sniper' | 'flamer' | 'medic'), ≈ 1.36 m, ≈ 330 tris:
 * helmet with brim, chest rig, belt, shoulder pads, backpack, boots, weapon in a two-handed aim.
 */
function soldierParts(variant) {
  const d = DIMS.soldier;
  const c = PALETTE.soldier;
  const t = PALETTE.troop;
  let uniform = c.uniform, legs = c.uniform, helmet = c.helmet, pack = c.backpack, rig = c.webbing, hasPack = true;
  if (variant === 'sniper') { uniform = t.sniperCoat; legs = t.sniperCoat; helmet = t.sniperCoat; pack = c.webbing; }
  else if (variant === 'flamer') { uniform = t.flamerSuit; legs = t.flamerSuit; helmet = t.flamerSuit; hasPack = false; rig = c.boots; }
  else if (variant === 'medic') { uniform = t.medic; legs = c.uniform; helmet = t.medic; pack = t.medic; }
  const parts = [];
  const hipY = d.hipY;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.LEG_L : PART.LEG_R;
    const piv = [s * d.hipHalf, hipY, 0];
    parts.push(P(box(d.legW, hipY - d.bootH + 0.02, d.legD, s * d.hipHalf, d.bootH + (hipY - d.bootH) / 2 - 0.01, 0), part, piv, legs));
    parts.push(P(box(d.bootW, d.bootH, d.bootD, s * d.hipHalf, d.bootH / 2, -0.03), part, piv, c.boots));
  }
  const torsoPiv = [0, hipY, 0];
  const top = hipY + d.torsoH;
  parts.push(P(box(d.torsoW, d.torsoH, d.torsoD, 0, hipY + d.torsoH / 2, 0), PART.TORSO, torsoPiv, uniform));
  parts.push(P(box(d.torsoW + 0.02, d.rigH, d.torsoD + 0.03, 0, top - d.rigH / 2 - 0.06, -0.004), PART.TORSO, torsoPiv, rig));    // chest rig
  parts.push(P(box(d.torsoW + 0.02, d.beltH, d.torsoD + 0.02, 0, hipY + d.beltH / 2 + 0.01, 0), PART.TORSO, torsoPiv, rig));       // belt
  for (let s = -1; s <= 1; s += 2) {
    // shoulder pads + the webbing straps over them (TAG.SHOULDER: armour glint, CHR-2)
    parts.push(P(box(d.padW, d.padH, d.padD, s * (d.shoulderHalf - 0.03), top - d.padH / 2 + 0.02, 0), PART.TORSO, torsoPiv, uniform, false, TAG.SHOULDER));
    parts.push(P(box(0.05, 0.02, d.torsoD + 0.02, s * 0.07, top + 0.005, 0), PART.TORSO, torsoPiv, rig, false, TAG.SHOULDER));
  }
  const packY = top - d.pack.h / 2 - 0.04, packZ = d.torsoD / 2 + d.pack.d / 2 - 0.01;
  if (hasPack) parts.push(P(box(d.pack.w, d.pack.h, d.pack.d, 0, packY, packZ), PART.TORSO, torsoPiv, pack));
  if (variant === 'soldier' && c.accent !== undefined) {
    // team accent (CHR-3): a tan bedroll strapped on top of the pack — the brightest thing seen from the chase camera
    parts.push(P(cyl(0.048, 0.048, d.pack.w + 0.03, 6, 0, packY + d.pack.h / 2 + 0.04, packZ, 0, 0, Math.PI / 2), PART.TORSO, torsoPiv, c.accent));
  }
  if (variant === 'flamer') {
    // fuel tanks on the back (GDD §15 flamethrower tank #E07A2A), merged into the body (no extra mesh)
    for (let s = -1; s <= 1; s += 2) {
      parts.push(P(cyl(0.065, 0.065, 0.36, 8, s * 0.07, top - 0.2, d.torsoD / 2 + 0.07), PART.TORSO, torsoPiv, t.flamerTank));
      parts.push(P(sphere(0.065, 8, 3, s * 0.07, top - 0.02, d.torsoD / 2 + 0.07, Math.PI / 2), PART.TORSO, torsoPiv, t.flamerTank));
    }
    parts.push(P(box(0.24, 0.045, 0.05, 0, top - 0.33, d.torsoD / 2 + 0.07), PART.TORSO, torsoPiv, c.rifle));
  }
  const headPiv = [0, top, 0];
  const headY = top + d.neckGap + d.headS / 2;
  parts.push(P(box(d.headS, d.headS, d.headS, 0, headY, 0), PART.HEAD, headPiv, c.skin));
  parts.push(P(sphere(d.helmetR, 8, 3, 0, headY + 0.02, 0.005, Math.PI / 2), PART.HEAD, headPiv, helmet, false, TAG.HELM_DOME));   // helmet dome
  parts.push(P(cyl(d.brimR, d.brimR, d.brimH, 8, 0, headY + 0.02, 0.005), PART.HEAD, headPiv, helmet, false, TAG.HELM_BRIM));      // helmet brim (magnet ring)
  const sleeve = variant === 'medic' ? t.medic : uniform;
  soldierArm(parts, 1, d.elbowR, d.handR, sleeve, c.skin);
  soldierArm(parts, -1, d.elbowL, d.handL, sleeve, c.skin);
  const w = weaponParts(variant);
  for (let i = 0; i < w.length; i++) parts.push(w[i]);
  return parts;
}

/**
 * Upright zombie body (walker / runner): hunched torso baked in, arms hanging (the shader raises
 * them to the class uArmRest "zombie reach"), emissive eyes, a jaw piece, torn cloth flaps.
 */
function bipedZombieParts(d, col) {
  const parts = [];
  const legTop = d.legLen;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.LEG_L : PART.LEG_R;
    const piv = [s * d.hipHalf, legTop, 0];
    parts.push(P(box(d.legW, d.legLen, d.legD, s * d.hipHalf, d.legLen / 2, 0), part, piv, col.cloth));
    parts.push(P(box(d.legW + 0.02, 0.08, d.legD + 0.08, s * d.hipHalf, 0.04, -0.04), part, piv, col.skin));
  }
  const h = d.hunch;
  const torsoPiv = [0, legTop, 0];
  const torso = box(d.torsoW, d.torsoH, d.torsoD, 0, legTop + d.torsoH / 2, 0);
  rotAbout(torso, 0, legTop, 0, h);
  parts.push(P(torso, PART.TORSO, torsoPiv, col.cloth));
  const chest = box(d.torsoW * 0.7, d.torsoH * 0.35, 0.03, 0.03, legTop + d.torsoH * 0.62, -d.torsoD / 2 - 0.01);   // torn shirt → exposed skin
  rotAbout(chest, 0, legTop, 0, h);
  parts.push(P(chest, PART.TORSO, torsoPiv, col.skin));
  for (let s = -1; s <= 1; s += 2) {
    parts.push(P(box(0.12, 0.18, 0.04, s * 0.1, legTop - 0.08, -d.torsoD / 2), PART.TORSO, torsoPiv, col.cloth));   // rag flaps
  }
  const ch = Math.cos(h), sh = Math.sin(h);
  const dyS = d.torsoH - 0.05;
  const shoulderY = legTop + dyS * ch, shoulderZ = dyS * sh;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.ARM_L : PART.ARM_R;
    const px = s * d.shoulderHalf;
    const piv = [px, shoulderY, shoulderZ];
    parts.push(P(box(d.armW, d.armLen - 0.1, d.armD, px, shoulderY - (d.armLen - 0.1) / 2, shoulderZ), part, piv, col.skin));
    parts.push(P(box(0.1, 0.1, 0.1, px, shoulderY - d.armLen + 0.05, shoulderZ), part, piv, col.skin));
    parts.push(P(box(d.armW + 0.04, 0.14, d.armD + 0.04, px, shoulderY - 0.06, shoulderZ), part, piv, col.cloth));   // torn sleeve
  }
  const ny = legTop + d.torsoH * ch, nz = d.torsoH * sh;
  const headPiv = [0, ny, nz];
  const headY = ny + d.headH / 2 + 0.02, headZ = nz - 0.04;
  parts.push(P(box(d.headW, d.headH, d.headD, 0, headY, headZ), PART.HEAD, headPiv, col.skin));
  parts.push(P(box(d.headW + 0.02, 0.06, d.headD * 0.5, 0, headY + d.headH / 2 - 0.02, headZ + d.headD * 0.2), PART.HEAD, headPiv, col.cloth));   // scalp rag
  for (let s = -1; s <= 1; s += 2) {
    parts.push(P(box(0.05, 0.04, 0.02, s * 0.055, headY + 0.03, headZ - d.headD / 2), PART.HEAD, headPiv, col.eyes, true));
  }
  parts.push(P(box(d.headW * 0.75, 0.06, d.headD * 0.6, 0, ny + 0.02, headZ - 0.04), PART.JAW, [0, ny + 0.05, headZ + d.headD * 0.3], col.skin));
  return parts;
}

/** Crawler: horizontal body on all fours; forelegs pre-rotated against the class uArmRest. */
function crawlerParts() {
  const d = DIMS.crawler;
  const col = PALETTE.zombie.crawler;
  const parts = [];
  const bodyPiv = [0, d.bodyY, 0];
  parts.push(P(box(d.bodyW, d.bodyH, d.bodyD, 0, d.bodyY, 0), PART.TORSO, bodyPiv, col.cloth));
  parts.push(P(box(d.bodyW * 0.5, 0.06, d.bodyD * 0.8, 0, d.bodyY + d.bodyH / 2 + 0.02, 0.02), PART.TORSO, bodyPiv, col.skin));   // exposed spine
  for (let k = 0; k < 3; k++) {
    parts.push(P(box(0.07, 0.05, 0.07, 0, d.bodyY + d.bodyH / 2 + 0.06, -0.18 + k * 0.17), PART.TORSO, bodyPiv, col.skin));         // vertebrae
  }
  const headZ = -d.bodyD / 2 - d.headD / 2 + 0.04;
  const headPiv = [0, d.bodyY, -d.bodyD / 2];
  parts.push(P(box(d.headW, d.headH, d.headD, 0, d.bodyY + 0.02, headZ), PART.HEAD, headPiv, col.skin));
  for (let s = -1; s <= 1; s += 2) {
    parts.push(P(box(0.05, 0.04, 0.02, s * 0.06, d.bodyY + 0.06, headZ - d.headD / 2), PART.HEAD, headPiv, col.eyes, true));
  }
  parts.push(P(box(d.headW * 0.8, 0.05, d.headD * 0.6, 0, d.bodyY - 0.08, headZ - 0.03), PART.JAW, [0, d.bodyY - 0.05, headZ + d.headD * 0.3], col.skin));
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.LEG_L : PART.LEG_R;
    const px = s * d.hipHalf;
    const piv = [px, d.bodyY, d.hipZ];
    parts.push(P(box(d.legW, d.legLen, d.legW, px, d.bodyY - d.legLen / 2, d.hipZ), part, piv, col.cloth));
    parts.push(P(box(d.legW + 0.02, 0.06, 0.16, px, 0.03, d.hipZ - 0.02), part, piv, col.skin));
  }
  const preRot = -ZOMBIES.crawler.limb.uArmRest;    // the shader adds +uArmRest back → forelegs end vertical
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.ARM_L : PART.ARM_R;
    const px = s * d.shoulderHalf;
    const piv = [px, d.bodyY, d.shoulderZ];
    const arm = box(d.armW, d.armLen, d.armW, px, d.bodyY - d.armLen / 2, d.shoulderZ);
    const hand = box(d.armW + 0.02, 0.06, 0.14, px, 0.03, d.shoulderZ - 0.02);
    rotAbout(arm, px, d.bodyY, d.shoulderZ, preRot);
    rotAbout(hand, px, d.bodyY, d.shoulderZ, preRot);
    parts.push(P(arm, part, piv, col.skin));
    parts.push(P(hand, part, piv, col.skin));
  }
  return parts;
}

/** Brute: massive forearms and shoulders, muscle patches, orange eyes, jaw. */
function bruteParts() {
  const d = DIMS.brute;
  const col = PALETTE.zombie.brute;
  const parts = [];
  const legTop = d.legLen;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.LEG_L : PART.LEG_R;
    const px = s * d.hipHalf;
    const piv = [px, legTop, 0];
    parts.push(P(box(d.legW, d.legLen - d.footH, d.legD, px, d.footH + (d.legLen - d.footH) / 2, 0), part, piv, col.skin));
    parts.push(P(box(d.legW + 0.06, d.footH, d.legD + 0.14, px, d.footH / 2, -0.05), part, piv, col.cloth));
  }
  const torsoPiv = [0, legTop, 0];
  parts.push(P(box(d.torsoW, d.torsoH, d.torsoD, 0, legTop + d.torsoH / 2, 0), PART.TORSO, torsoPiv, col.skin));
  parts.push(P(box(d.torsoW * 0.9, 0.3, d.torsoD + 0.04, 0, legTop + 0.12, 0), PART.TORSO, torsoPiv, col.cloth));          // shorts
  for (let s = -1; s <= 1; s += 2) {
    parts.push(P(box(0.42, 0.34, 0.08, s * 0.26, legTop + d.torsoH * 0.72, -d.torsoD / 2 - 0.02), PART.TORSO, torsoPiv, col.muscle));   // pecs
  }
  parts.push(P(box(0.7, 0.4, 0.1, 0, legTop + 0.36, -d.torsoD / 2 - 0.03), PART.TORSO, torsoPiv, col.skin));              // belly
  parts.push(P(box(0.55, 0.2, 0.42, 0, legTop + d.torsoH + 0.08, 0.05), PART.TORSO, torsoPiv, col.muscle));               // traps
  const shoulderY = legTop + d.torsoH - 0.1;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.ARM_L : PART.ARM_R;
    const px = s * d.shoulderHalf;
    const piv = [px, shoulderY, 0];
    parts.push(P(box(0.4, 0.3, 0.4, px, shoulderY + 0.05, 0), part, piv, col.skin));                                      // shoulder
    parts.push(P(box(d.armW, d.armLen * 0.5, d.armD, px, shoulderY - d.armLen * 0.25, 0), part, piv, col.skin));          // upper arm
    parts.push(P(box(d.armW + 0.08, d.armLen * 0.45, d.armD + 0.08, px, shoulderY - d.armLen * 0.72, 0), part, piv, col.muscle));   // forearm
    parts.push(P(box(d.fist, d.fist, d.fist, px, shoulderY - d.armLen - 0.05, 0), part, piv, col.skin));                  // fist
  }
  const ny = legTop + d.torsoH + 0.1;
  const headPiv = [0, ny, 0];
  const headY = ny + d.headH / 2, headZ = -0.08;
  parts.push(P(box(d.headW, d.headH, d.headD, 0, headY, headZ), PART.HEAD, headPiv, col.skin));
  parts.push(P(box(d.headW + 0.04, 0.08, 0.1, 0, headY + 0.1, headZ - d.headD / 2 + 0.02), PART.HEAD, headPiv, col.skin));   // brow
  for (let s = -1; s <= 1; s += 2) {
    parts.push(P(box(0.08, 0.05, 0.02, s * 0.09, headY + 0.04, headZ - d.headD / 2), PART.HEAD, headPiv, col.eyes, true));
  }
  parts.push(P(box(0.3, 0.1, 0.26, 0, ny + 0.02, headZ - 0.06), PART.JAW, [0, ny + 0.06, headZ + d.headD * 0.3], col.skin));
  return parts;
}

/** Spitter: bloated belly, clutched thin arms, glowing acid sacs on the back and cheeks. */
function spitterParts() {
  const d = DIMS.spitter;
  const col = PALETTE.zombie.spitter;
  const parts = [];
  const legTop = d.legLen;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.LEG_L : PART.LEG_R;
    const px = s * d.hipHalf;
    const piv = [px, legTop, 0];
    parts.push(P(box(d.legW, d.legLen, d.legD, px, d.legLen / 2, 0), part, piv, col.cloth));
    parts.push(P(box(0.14, 0.07, 0.22, px, 0.035, -0.04), part, piv, col.skin));
  }
  const torsoPiv = [0, legTop, 0];
  parts.push(P(sphere(d.bellyR, 8, 6, 0, legTop + 0.3, -0.06), PART.TORSO, torsoPiv, col.skin));
  parts.push(P(box(d.chestW, d.chestH, d.chestD, 0, legTop + 0.62, 0), PART.TORSO, torsoPiv, col.cloth));
  parts.push(P(sphere(d.sacR, 6, 4, 0.12, legTop + 0.6, 0.3), PART.TORSO, torsoPiv, col.sacs, true));
  parts.push(P(sphere(d.sacR, 6, 4, -0.1, legTop + 0.45, 0.32), PART.TORSO, torsoPiv, col.sacs, true));
  parts.push(P(sphere(d.sacR * 0.8, 6, 4, 0.02, legTop + 0.3, 0.34), PART.TORSO, torsoPiv, col.sacs, true));
  const shoulderY = legTop + 0.74;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.ARM_L : PART.ARM_R;
    const px = s * d.shoulderHalf;
    const piv = [px, shoulderY, 0];
    parts.push(P(box(d.armW, d.armLen - 0.08, d.armD, px, shoulderY - (d.armLen - 0.08) / 2, 0), part, piv, col.skin));
    parts.push(P(box(0.08, 0.08, 0.08, px, shoulderY - d.armLen + 0.04, 0), part, piv, col.skin));
  }
  const ny = legTop + 0.78;
  const headPiv = [0, ny, 0];
  const headY = ny + d.headH / 2, headZ = -0.04;
  parts.push(P(box(d.headW, d.headH, d.headD, 0, headY, headZ), PART.HEAD, headPiv, col.skin));
  for (let s = -1; s <= 1; s += 2) {
    parts.push(P(box(0.06, 0.04, 0.02, s * 0.06, headY + 0.03, headZ - d.headD / 2), PART.HEAD, headPiv, col.eyes, true));
    parts.push(P(sphere(0.08, 6, 4, s * 0.14, ny + 0.06, headZ - 0.02), PART.HEAD, headPiv, col.sacs, true));   // cheek sacs
  }
  parts.push(P(box(0.18, 0.07, 0.16, 0, ny + 0.02, headZ - 0.04), PART.JAW, [0, ny + 0.05, headZ + d.headD * 0.3], col.skin));
  return parts;
}

/**
 * Part descriptors for any character class id. Zombie classes are scaled uniformly so their height
 * equals ZOMBIES[type].height (HP bars, hit capsules and blob shadows are tuned against it).
 */
function characterParts(classId) {
  if (SOLDIER_CLASSES[classId]) return soldierParts(classId);
  if (!ZOMBIE_CLASSES[classId]) throw new Error('models: unknown character class "' + classId + '"');
  const parts = rawZombieParts(classId);
  const top = partsTop(parts);
  return scaleParts(parts, top > 0 ? ZOMBIES[classId].height / top : 1);
}

// ---------------------------------------------------------------------------------------------
// Props, gate pieces, pickups and projectile geometries (plain BufferGeometries for the other
// modules' materials; props carry a `color` attribute and keep `uv`)
// ---------------------------------------------------------------------------------------------

/**
 * Gate frame (GATE_RULES.frame; GDD §4.1): two posts, top bar, feet, end caps, corner gussets, a pair
 * of sign lamps on the bar and "^" chevron wedges on both posts' camera-facing (+Z) faces.
 * position/normal/uv only (gates.js adds `iFrame`). Layout contract with materials.js gateFrame():
 * the chevrons are the ONLY vertices with z ≥ postW/2 − 0.005 inside y ∈ [rows[0] − 0.5, rows[2] + 0.3];
 * each wedge is centred sin(angle)·len·0.45 below its row on x = ±(barW/2 − postW/2), so the shader can
 * classify them and rotate them 180° into "v" down-chevrons on negative gate types.
 */
function buildGateFrame() {
  const f = GATE_RULES.frame;
  const g = DIMS.gate;
  const postX = f.barW / 2 - f.postW / 2;
  const barY = f.postH + f.postW / 2;
  const drop = Math.sin(g.chevAngle) * g.chevLen * 0.45;
  const dx = Math.cos(g.chevAngle) * g.chevLen * 0.45;
  const chevZ = f.postW / 2 + g.chevD / 2;
  const geos = [];
  for (let s = -1; s <= 1; s += 2) {
    geos.push(box(f.postW, f.postH, f.postW, s * postX, f.postH / 2, 0));                                  // post
    geos.push(box(g.footW, g.footH, g.footW, s * postX, g.footH / 2, 0));                                  // foot plate
    geos.push(box(f.postW * 1.5, g.capH, f.postW * 1.5, s * postX, barY + f.postW / 2 + g.capH / 2, 0));    // end cap
    const gx = s * (postX - f.postW / 2 - g.braceH * 0.35);
    geos.push(box(g.braceH * 1.2, f.postW * 0.5, f.postW * 0.7, gx, f.postH - g.braceH * 0.35, 0, 0, 0, s * Math.PI / 4));   // corner gusset
    for (let r = 0; r < g.chevRows.length; r++) {
      const y = g.chevRows[r] - drop;
      geos.push(box(g.chevLen, g.chevW, g.chevD, s * postX - dx, y, chevZ, 0, 0, g.chevAngle));            // "/"
      geos.push(box(g.chevLen, g.chevW, g.chevD, s * postX + dx, y, chevZ, 0, 0, -g.chevAngle));           // "\"
    }
  }
  geos.push(box(f.barW, f.postW + 0.02, f.postW + 0.02, 0, barY, 0));                                    // top bar
  for (let s = -1; s <= 1; s += 2) {
    geos.push(box(g.lampW, g.lampH, f.postW * 0.8, s * f.barW * 0.18, barY + f.postW / 2 + g.lampH / 2, 0));   // sign lamps
  }
  return mergeAll(geos, 'gateFrame');
}

/** Crate: PICKUPS.crate.size box (feet at y = 0) with bright seam rails and a lid emblem (vertex colours). */
function buildCrate() {
  const s = PICKUPS.crate.size;
  const t = DIMS.crate.seam;
  const h = s / 2;
  const body = PALETTE.props.sandbag[1];
  const seam = PALETTE.ui.primary;
  const entries = [{ geo: box(s - 0.02, s - 0.02, s - 0.02, 0, h, 0), hex: body }];
  for (let a = -1; a <= 1; a += 2) {
    for (let b = -1; b <= 1; b += 2) {
      entries.push({ geo: box(t, s, t, a * h, h, b * h), hex: seam });          // vertical edges
      entries.push({ geo: box(s, t, t, 0, h + a * h, b * h), hex: seam });      // x edges
      entries.push({ geo: box(t, t, s, a * h, h + b * h, 0), hex: seam });      // z edges
    }
  }
  entries.push({ geo: box(s * 0.5, 0.02, s * 0.5, 0, s + 0.005, 0), hex: seam });   // lid emblem
  return mergeProps(entries, 'crate');
}

/** Coin: disc with a raised centre (embossed look), facing ±Z (spin about Y flips it edge-on). */
function buildCoin() {
  const c = DIMS.coin;
  const geos = [
    new CylinderGeometry(c.r, c.r, c.h, c.segments),
    new CylinderGeometry(c.r - c.rim * 2, c.r - c.rim * 2, c.h + c.rim, c.segments),
  ];
  const g = mergeAll(geos, 'coin');
  g.rotateX(Math.PI / 2);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Rocket pointing −Z: body cylinder, nose cone, nozzle, three fins. */
function buildRocket() {
  const r = DIMS.rocket;
  const entries = [
    { geo: cyl(r.r, r.r, r.bodyL, 8, 0, 0, 0, Math.PI / 2), hex: PALETTE.props.barricade },
    { geo: cyl(0.001, r.r, r.noseL, 8, 0, 0, -r.bodyL / 2 - r.noseL / 2, -Math.PI / 2), hex: PALETTE.fx.rocket },
    { geo: cyl(r.r * 0.6, r.r * 0.8, 0.08, 8, 0, 0, r.bodyL / 2 + 0.04, Math.PI / 2), hex: PALETTE.soldier.rifle },
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const fin = box(0.02, r.finL, r.finL, 0, r.r + r.finL / 2 - 0.01, r.bodyL / 2 - r.finL / 2);
    fin.rotateZ(a);
    entries.push({ geo: fin, hex: PALETTE.soldier.rifle });
  }
  return mergeProps(entries, 'rocket');
}

/** Concrete jersey barrier with red/white chevron stripes on both faces. */
function buildBarricade() {
  const d = DIMS.props.barricade;
  const c = PALETTE.props;
  const entries = [
    { geo: box(d.w, d.baseH, d.baseD, 0, d.baseH / 2, 0), hex: c.barricade },
    { geo: box(d.w, d.topH, d.topD, 0, d.baseH + d.topH / 2, 0), hex: c.barricade },
    { geo: box(d.w * 1.02, 0.06, d.topD + 0.02, 0, d.baseH + d.topH - 0.03, 0), hex: c.barricade },
  ];
  const stripes = 5;
  for (let i = 0; i < stripes; i++) {
    const x = -d.w / 2 + (i + 0.5) * (d.w / stripes);
    const hex = (i % 2 === 0) ? c.barricadeRed : c.barricadeWhite;
    entries.push({ geo: box(d.w / stripes - 0.04, d.topH * 0.6, 0.02, x, d.baseH + d.topH * 0.45, -d.topD / 2 - 0.01, 0, 0, 0.35), hex });
    entries.push({ geo: box(d.w / stripes - 0.04, d.topH * 0.6, 0.02, x, d.baseH + d.topH * 0.45, d.topD / 2 + 0.01, 0, 0, -0.35), hex });
  }
  return mergeProps(entries, 'barricade');
}

/** Sandbag stack 3 + 2 + 1, alternating the two sandbag tones. */
function buildSandbags() {
  const d = DIMS.props.sandbag;
  const c = PALETTE.props.sandbag;
  const entries = [];
  const rows = [3, 2, 1];
  let k = 0;
  for (let r = 0; r < rows.length; r++) {
    const n = rows[r];
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * (d.w * 0.95);
      entries.push({ geo: box(d.w, d.h, d.d, x, d.h / 2 + r * d.h * 0.92, (r % 2) * 0.05, 0, (r % 2 ? -1 : 1) * 0.06 * (i - (n - 1) / 2), 0), hex: c[k++ % 2] });
    }
  }
  return mergeProps(entries, 'sandbags');
}

/** Wrecked car: body, cabin glass, roof, rusty bumpers, crumpled hood, four tyres (neutral grey; owners may tint). */
function buildCar() {
  const d = DIMS.props.car;
  const c = PALETTE.props;
  const bodyHex = c.car[2];
  const y0 = d.wheelR;
  const entries = [
    { geo: box(d.w, d.h, d.l, 0, y0 + d.h / 2, 0), hex: bodyHex },
    { geo: box(d.cabinW, d.cabinH, d.cabinL, 0, y0 + d.h + d.cabinH / 2 - 0.02, -0.2), hex: c.glass },
    { geo: box(d.cabinW + 0.04, 0.06, d.cabinL + 0.04, 0, y0 + d.h + d.cabinH, -0.2), hex: bodyHex },
    { geo: box(d.w + 0.06, 0.16, 0.14, 0, y0 + 0.14, -d.l / 2 - 0.05), hex: c.rust },
    { geo: box(d.w + 0.06, 0.16, 0.14, 0, y0 + 0.14, d.l / 2 + 0.05), hex: c.rust },
    { geo: box(d.w * 0.5, 0.08, 0.4, 0.25, y0 + d.h + 0.02, d.l / 2 - 0.5, 0, 0, 0.3), hex: c.rust },   // crumpled hood plate
  ];
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      entries.push({ geo: cyl(d.wheelR, d.wheelR, d.wheelW, 8, sx * (d.w / 2 - 0.02), d.wheelR, sz * (d.l / 2 - 0.8), 0, 0, Math.PI / 2), hex: c.tyre });
    }
  }
  return mergeProps(entries, 'car');
}

/** Ruined building block: box with uv for the windows map, parapet, dark doorway, broken corner. */
function buildBuilding() {
  const d = DIMS.props.building;
  const c = PALETTE.props;
  const entries = [
    { geo: box(d.w, d.h, d.d, 0, d.h / 2, 0), hex: c.building },
    { geo: box(d.w + 0.3, d.parapet, d.d + 0.3, 0, d.h + d.parapet / 2, 0), hex: c.building },
    { geo: box(d.doorW, d.doorH, 0.2, 0, d.doorH / 2, d.d / 2), hex: c.window },
    { geo: box(d.w * 0.4, 0.4, 0.3, -d.w * 0.2, d.h - 0.2, -d.d / 2), hex: c.rust },
  ];
  return mergeProps(entries, 'building');
}

/** Dead tree: tapered trunk and three bare branches. */
function buildTree() {
  const d = DIMS.props.tree;
  const hex = PALETTE.props.tree;
  const entries = [{ geo: cyl(d.trunkR * 0.6, d.trunkR, d.trunkH, 6, 0, d.trunkH / 2, 0), hex }];
  const angles = [0.5, 2.6, 4.4];
  for (let i = 0; i < 3; i++) {
    const tilt = 0.55 + i * 0.12;
    const y = d.trunkH * (0.55 + i * 0.15);
    const b = cyl(d.branchR * 0.4, d.branchR, d.branchL, 5, 0, d.branchL / 2, 0);
    b.rotateZ(tilt);
    b.rotateY(angles[i]);
    b.translate(0, y, 0);
    entries.push({ geo: b, hex });
  }
  return mergeProps(entries, 'tree');
}

/** Rubble: deterministic cluster of tumbled blocks (seeded locally, never ctx.rng). */
function buildRubble() {
  const d = DIMS.props.rubble;
  const c = PALETTE.props;
  const rng = _rubbleRng;
  const entries = [];
  for (let i = 0; i < d.pieces; i++) {
    const w = rng.range(d.min, d.max), h = rng.range(d.min * 0.6, d.max * 0.6), dp = rng.range(d.min, d.max);
    const x = rng.range(-d.spread, d.spread), z = rng.range(-d.spread, d.spread);
    entries.push({ geo: box(w, h, dp, x, h * 0.4, z, rng.range(-0.3, 0.3), rng.range(0, Math.PI), rng.range(-0.3, 0.3)), hex: (i % 3 === 0) ? PALETTE.road.asphalt : c.building });
  }
  return mergeProps(entries, 'rubble');
}

/** Lamppost: pole, base, arm, head and the lamp lens (lit-window tone for an emissive material). */
function buildLamppost() {
  const d = DIMS.props.lamppost;
  const c = PALETTE.props;
  const entries = [
    { geo: cyl(d.r * 0.8, d.r, d.h, 6, 0, d.h / 2, 0), hex: PALETTE.road.curb },
    { geo: cyl(d.r * 1.6, d.r * 1.8, 0.3, 6, 0, 0.15, 0), hex: PALETTE.road.curb },
    { geo: box(d.armL, 0.08, 0.08, -d.armL / 2 + 0.05, d.h - 0.04, 0), hex: PALETTE.road.curb },
    { geo: box(d.headW, d.headH, d.headD, -d.armL + 0.1, d.h - 0.13, 0), hex: PALETTE.road.curb },
    { geo: box(d.headW * 0.8, 0.03, d.headD * 0.8, -d.armL + 0.1, d.h - 0.23, 0), hex: c.windowLit },
  ];
  return mergeProps(entries, 'lamppost');
}

/**
 * APC hull (TROOPS.apc footprint, centred, front at −Z; CHR-6): hull with exposed wheels, sloped glacis
 * with a light housing, fenders, turret with a commander hatch and mantlet, rear doors with tail lights
 * and jerry cans (the chase camera sees the back), roof hatches, panel lines and an orange air
 * recognition panel on the roof (reads from above). Wheels and lights are separate meshes.
 */
function buildApcBody() {
  const d = DIMS.apc;
  const c = PALETTE.troop;
  const s = PALETTE.soldier;
  const y0 = d.wheelR - 0.1;
  const hullW = d.w * 0.76, hullL = d.l * 0.8, zc = 0.1;
  const rearZ = zc + hullL / 2, roofY = y0 + d.h;
  const wheelX = d.w / 2 - d.wheelW / 2;
  const line = s.boots;
  const entries = [
    { geo: box(hullW, d.h, hullL, 0, y0 + d.h / 2, zc), hex: c.apc },
    { geo: box(hullW, d.h * 0.7, d.l * 0.25, 0, y0 + d.h * 0.42, -d.l * 0.42, 0.5), hex: c.apc },                 // sloped glacis
    { geo: box(hullW + 0.02, 0.1, d.l * 0.2, 0, y0 + d.h * 0.62, -d.l * 0.44, 0.5), hex: line },                   // glacis lip
    { geo: box(d.turretW, d.turretH, d.turretW * 0.9, 0, roofY + d.turretH / 2, 0.2), hex: c.apc },
    { geo: box(d.turretW + 0.06, 0.05, d.turretW * 0.9 + 0.06, 0, roofY + d.turretH, 0.2), hex: line },          // turret roof rim
    { geo: cyl(0.2, 0.2, 0.08, 10, 0.18, roofY + d.turretH + 0.05, 0.32), hex: s.webbing },                       // commander hatch
    { geo: cyl(d.gunR, d.gunR, d.gunL, 8, 0, roofY + d.turretH * 0.6, 0.2 - d.turretW * 0.45 - d.gunL / 2, Math.PI / 2), hex: s.rifle },
    { geo: cyl(d.gunR * 1.8, d.gunR * 1.8, 0.25, 8, 0, roofY + d.turretH * 0.6, 0.2 - d.turretW * 0.45 - 0.1, Math.PI / 2), hex: s.rifle },   // mantlet
    { geo: box(0.06, 0.9, 0.06, -hullW * 0.4, roofY + 0.45, rearZ - 0.25), hex: s.rifle },                        // antenna
    { geo: box(0.9, 0.03, 0.62, 0, roofY + 0.015, rearZ - 0.62), hex: PALETTE.ui.primary },                       // air recognition panel
    { geo: box(0.42, 0.05, 0.42, -0.42, roofY + 0.025, -0.55), hex: s.webbing },                                  // driver hatch
    { geo: box(0.36, 0.05, 0.36, 0.45, roofY + 0.025, rearZ - 0.62), hex: s.webbing },                            // troop hatch
    // rear: doors, seam, handles, tail lights, jerry cans
    { geo: box(hullW * 0.62, d.h * 0.8, 0.05, 0, y0 + d.h * 0.45, rearZ + 0.02), hex: s.webbing },
    { geo: box(0.03, d.h * 0.8, 0.07, 0, y0 + d.h * 0.45, rearZ + 0.03), hex: line },
    { geo: box(0.12, 0.04, 0.06, -0.14, y0 + d.h * 0.45, rearZ + 0.06), hex: s.rifle },
    { geo: box(0.12, 0.04, 0.06, 0.14, y0 + d.h * 0.45, rearZ + 0.06), hex: s.rifle },
    { geo: box(0.12, 0.1, 0.04, -hullW * 0.42, y0 + d.h * 0.8, rearZ + 0.02), hex: PALETTE.props.barricadeRed },
    { geo: box(0.12, 0.1, 0.04, hullW * 0.42, y0 + d.h * 0.8, rearZ + 0.02), hex: PALETTE.props.barricadeRed },
    { geo: box(0.16, 0.36, 0.1, -hullW * 0.42, y0 + d.h * 0.3, rearZ + 0.06), hex: PALETTE.props.rust },
    { geo: box(0.16, 0.36, 0.1, hullW * 0.42, y0 + d.h * 0.3, rearZ + 0.06), hex: PALETTE.props.rust },
  ];
  // panel lines across the roof and along both flanks, fenders over the wheels, sills
  const lines = [-0.75, 0.0, 0.75];
  for (let i = 0; i < lines.length; i++) entries.push({ geo: box(hullW + 0.01, 0.012, 0.04, 0, roofY + 0.006, lines[i]), hex: line });
  for (let sx = -1; sx <= 1; sx += 2) {
    entries.push({ geo: box(0.012, 0.04, hullL, sx * (hullW / 2 + 0.006), y0 + d.h * 0.7, zc), hex: line });
    entries.push({ geo: box(d.wheelW + 0.1, 0.05, d.l * 0.9, sx * wheelX, d.wheelR * 2 + 0.05, -0.05), hex: c.apc });
    entries.push({ geo: box(0.08, 0.16, d.l * 0.9, sx * (hullW / 2 + 0.03), y0 + 0.05, -0.05), hex: line });
  }
  return mergeProps(entries, 'apc');
}

/** APC running gear: six tyres + hubs in one merged mesh (axles along X, origin at the hull centre). */
function buildApcWheels() {
  const d = DIMS.apc;
  const wheelX = d.w / 2 - d.wheelW / 2;
  const entries = [];
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let zi = -1; zi <= 1; zi++) {
      const z = zi * (d.l * 0.34);
      entries.push({ geo: cyl(d.wheelR, d.wheelR, d.wheelW, 12, sx * wheelX, d.wheelR, z, 0, 0, Math.PI / 2), hex: PALETTE.props.tyre });
      entries.push({ geo: cyl(d.wheelR * 0.5, d.wheelR * 0.5, d.wheelW + 0.04, 6, sx * wheelX, d.wheelR, z, 0, 0, Math.PI / 2), hex: PALETTE.troop.apc });
    }
  }
  return mergeProps(entries, 'apcWheels');
}

/** APC lights (one glow mesh, origin at the nose): two headlights and a turret spotlight the chase camera sees. */
function buildApcLights() {
  const d = DIMS.apc;
  return mergeAll([
    box(0.34, 0.16, 0.08, -d.w * 0.28, 0, 0),
    box(0.34, 0.16, 0.08, d.w * 0.28, 0, 0),
    box(0.3, 0.1, 0.1, 0, d.h * 0.45 + d.turretH * 0.85, d.l * 0.5 + 0.2 - d.turretW * 0.45 - 0.06),
  ], 'apcLight');
}

/** Drone body (CHR-6): hub, dark canopy, rear stripe, four arms with motor pods, under-slung gun. Discs and LED are separate meshes. */
function buildDroneBody() {
  const d = DIMS.drone;
  const c = PALETTE.troop;
  const entries = [
    { geo: box(d.bodyW, d.bodyH, d.bodyD, 0, 0, 0), hex: c.drone },
    { geo: box(d.bodyW * 0.62, d.bodyH * 0.7, d.bodyD * 0.62, 0, d.bodyH * 0.62, 0), hex: PALETTE.soldier.rifle },   // dark canopy
    { geo: box(d.bodyW * 1.04, 0.03, 0.08, 0, d.bodyH / 2 + 0.01, d.bodyD / 2 - 0.06), hex: PALETTE.ui.primary },     // rear stripe (chase camera)
    { geo: box(0.08, 0.06, d.gunL, 0, -d.bodyH / 2 - 0.04, -d.bodyD / 2 - d.gunL / 2 + 0.08), hex: PALETTE.soldier.rifle },
    { geo: box(0.16, 0.1, 0.16, 0, -d.bodyH / 2 - 0.04, -d.bodyD / 2 + 0.06), hex: PALETTE.soldier.rifle },          // gun mount
  ];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    entries.push({ geo: box(d.armL, 0.06, 0.09, Math.cos(a) * d.armL / 2, 0, Math.sin(a) * d.armL / 2, 0, -a, 0), hex: c.drone });
    entries.push({ geo: cyl(0.075, 0.075, 0.12, 8, Math.cos(a) * d.armL, 0.04, Math.sin(a) * d.armL), hex: PALETTE.soldier.rifle });   // motor pods
  }
  return mergeProps(entries, 'drone');
}

/** Drone rotor discs: four flat blurred-rotor discs over the motor pods (rotationally symmetric, so they read as spinning). */
function buildDroneDiscs() {
  const d = DIMS.drone;
  const geos = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    geos.push(new CylinderGeometry(d.rotorR * DIMS.troopExtras.discR, d.rotorR * DIMS.troopExtras.discR, 0.01, 18).translate(Math.cos(a) * d.armL, 0, Math.sin(a) * d.armL));
  }
  return mergeAll(geos, 'droneDiscs');
}

/** Hero sniper's perch: a wooden pallet under a TROOPS.sniper.crateH ammo crate with dark bands (feet at y = 0). */
function buildSniperCrate() {
  const h = TROOPS.sniper.crateH;
  const p = DIMS.troopExtras.palletH;
  const cw = DIMS.troopExtras.crateW, pw = DIMS.troopExtras.palletW;
  const body = PALETTE.props.sandbag[1];
  const band = PALETTE.props.rust;
  const entries = [
    { geo: box(pw, p * 0.35, pw, 0, p * 0.825, 0), hex: PALETTE.props.tree },                     // pallet deck
    { geo: box(cw, h, cw, 0, p + h / 2, 0), hex: body },
    { geo: box(cw + 0.02, 0.05, cw + 0.02, 0, p + h - 0.06, 0), hex: band },                       // lid band
    { geo: box(cw + 0.02, 0.05, cw + 0.02, 0, p + 0.08, 0), hex: band },                           // base band
    { geo: box(cw * 0.55, 0.02, cw * 0.33, 0, p + h + 0.005, cw * 0.25), hex: PALETTE.ui.primary }, // stencil plate (seen from above)
  ];
  for (let i = -1; i <= 1; i++) entries.push({ geo: box(0.1, p * 0.65, pw, i * pw * 0.41, p * 0.325, 0), hex: PALETTE.props.tree });   // pallet runners
  return mergeProps(entries, 'sniperCrate');
}

/** Sniper scope glints (one glow mesh in body space): objective, eyepiece and a strip along the scope top. */
function buildSniperLens() {
  const r = DIMS.rifle;
  const y = r.y + r.recvH / 2 + r.scopeS / 2 + 0.01, z = r.recvZ - 0.02;
  return mergeAll([
    box(r.scopeS * 1.15, r.scopeS * 1.15, 0.012, r.x, y, z - r.scopeL / 2 - 0.006),
    box(r.scopeS * 1.05, r.scopeS * 1.05, 0.012, r.x, y, z + r.scopeL / 2 + 0.006),
    box(r.scopeS * 0.4, 0.008, r.scopeL * 0.8, r.x, y + r.scopeS / 2 + 0.004, z),
  ], 'sniperLens');
}

/** Medic crosses (one glow mesh in body space): flat on the helmet top and the pack top (read from above) and on the pack back. */
function buildMedicCrosses() {
  const d = DIMS.soldier;
  const top = d.hipY + d.torsoH;
  const headY = top + d.neckGap + d.headS / 2;
  const helmTop = headY + 0.02 + d.helmetR + 0.004;
  const packY = top - d.pack.h / 2 - 0.04, packZ = d.torsoD / 2 + d.pack.d / 2 - 0.01;
  const geos = [
    box(0.17, 0.014, 0.055, 0, helmTop, 0.005), box(0.055, 0.014, 0.17, 0, helmTop, 0.005),
    box(0.17, 0.014, 0.055, 0, packY + d.pack.h / 2 + 0.008, packZ), box(0.055, 0.014, 0.17, 0, packY + d.pack.h / 2 + 0.008, packZ),
    box(0.17, 0.055, 0.014, 0, packY, packZ + d.pack.d / 2 + 0.008), box(0.055, 0.17, 0.014, 0, packY, packZ + d.pack.d / 2 + 0.008),
  ];
  return mergeAll(geos, 'medicCross');
}

/** Builds every non-character geometry into `geo` (called once by ModelLibrary.init). */
function buildStaticGeometries(geo) {
  const panel = GATE_RULES.panel;
  geo.gateFrame = buildGateFrame();
  geo.gatePanel = new PlaneGeometry(panel.w, panel.h);                                 // centre origin; gates place it at bottom + h/2
  geo.crate = buildCrate();
  geo.coin = buildCoin();
  geo.rocket = buildRocket();
  geo.glob = new IcosahedronGeometry(ZOMBIES.common.globRadius, 0);                    // ARCH §6.7 IcosahedronGeometry(0.25, 0)
  geo.shard = new BoxGeometry(DIMS.shard.w, DIMS.shard.h, DIMS.shard.d);
  geo.tracer = new BoxGeometry(DIMS.tracerThickness, DIMS.tracerThickness, FIRE.tracerLength);   // long axis Z
  geo.muzzle = new PlaneGeometry(FIRE.muzzleFlash.size, FIRE.muzzleFlash.size);       // faces +Z
  geo.quad = new PlaneGeometry(1, 1);
  geo.barricade = buildBarricade();
  geo.sandbags = buildSandbags();
  geo.car = buildCar();
  geo.building = buildBuilding();
  geo.tree = buildTree();
  geo.rubble = buildRubble();
  geo.smoke = colorize(new PlaneGeometry(DIMS.props.smoke.w, DIMS.props.smoke.h).translate(0, DIMS.props.smoke.h / 2, 0), PALETTE.props.smoke[0]);
  geo.lamppost = buildLamppost();
  geo.blobDisc = new CircleGeometry(RENDER.blobShadow.radius, 12).rotateX(-Math.PI / 2);   // lies flat, facing up
  geo.apc = buildApcBody();
  geo.drone = buildDroneBody();
  // extras used by buildTroopMesh (CHR-6: merged so a troop costs 2–4 draw calls)
  geo.apcWheels = buildApcWheels();
  geo.apcLight = buildApcLights();
  geo.droneDiscs = buildDroneDiscs();
  geo.droneLed = new BoxGeometry(0.12, 0.05, 0.12);
  geo.sniperCrate = buildSniperCrate();
  geo.sniperLens = buildSniperLens();
  geo.medicCross = buildMedicCrosses();
  geo.troopRing = new RingGeometry(DIMS.troopExtras.ringIn, DIMS.troopExtras.ringOut, 28).rotateX(-Math.PI / 2);
  geo.marker = new BoxGeometry(DIMS.marker, DIMS.marker, DIMS.marker);
  for (const k in geo) {
    const g = geo[k];
    if (!g.name) g.name = k;
    if (g.userData.tris === undefined) g.userData.tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    if (!g.boundingSphere) g.computeBoundingSphere();
  }
}

// ---------------------------------------------------------------------------------------------
// District prop kinds (docs/DISTRICTS.md §7; round 5). Environment-prop convention, NOT the models prop
// convention above: merged, indexed primitives carrying position / normal / uv (kept, unused) / color (linear,
// itemSize 3) and nothing else; feet at y = 0, origin at the footprint centre; chain / scatter kinds run their long
// axis along local x, cars-placer kinds along local z (nose −z); "front" is +z. Kinds shown on the two emissive
// environment slots (barricade, lamppost) encode emissive radiance as colour excess over 1.0 (1 + lin(hex) × gain),
// gated per instance by the slot's iEmit (environment.js LAMP_* chunks). Every colour comes from
// DISTRICT_PROPS[kind].colors (or PALETTE for the frozen car's base car parts); shape constants are commented as such.
// environment.js adopts these lazily (view geometries sharing these BufferAttributes; never mutated).
// ---------------------------------------------------------------------------------------------

const DP = DISTRICT_PROPS;
const NEAR_WHITE = 0.95;               // body brightness of instance-painted kinds (the cars rule: instanceColor = paint)

/** [r, g, b] linear of an sRGB hex × k. */
function lin3(hex, k = 1) {
  _color.setHex(hex);
  return [_color.r * k, _color.g * k, _color.b * k];
}

/** [r, g, b] emissive encoding: 1 + linear(hex) × gain (excess over 1.0 = radiance; environment LAMP_VERT_MAIN). */
function emis3(hex, gain) {
  _color.setHex(hex);
  return [1 + _color.r * gain, 1 + _color.g * gain, 1 + _color.b * gain];
}

/** Linear mix of two [r, g, b] triples. */
function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/** Gives a non-indexed primitive (Polyhedron / Extrude) a sequential index so every part of a kind is indexed (merge parity). */
function indexed(geo) {
  if (geo.index) return geo;
  const n = geo.attributes.position.count;
  const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  geo.setIndex(new BufferAttribute(idx, 1));
  return geo;
}

/** Per-vertex colour from fn(x, y, z, nx, ny, nz) → [r, g, b] (linear). */
function colorBy(geo, fn) {
  const p = geo.attributes.position, nrm = geo.attributes.normal;
  const n = p.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = fn(p.getX(i), p.getY(i), p.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new Float32BufferAttribute(a, 3));
  return geo;
}

/** Deterministic position hash in [0, 1) (shape detail only; never Math.random, ARCH §14). */
function hash3(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Merges district-kind parts. Entry: { geo, rgb: [r, g, b] (linear, may exceed 1) } | { geo, hex, k? } | { geo, fn }. */
function mergeKind(entries, label) {
  const geos = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const g = indexed(e.geo);
    if (e.fn) colorBy(g, e.fn);
    else {
      const c = e.rgb || lin3(e.hex, e.k === undefined ? 1 : e.k);
      colorBy(g, () => c);
    }
    geos[i] = g;
  }
  return mergeAll(geos, label);
}

/** Flat irregular disc (radii rx × rz, `seg` segments, fixed-seed radius jitter ±jit) lying at height y, facing up. */
function blobDisc(rx, rz, seg, jit, y, rng) {
  const g = new CircleGeometry(1, seg);
  const p = g.attributes.position;
  for (let i = 1; i < p.count; i++) {                       // vertex 0 is the centre
    const k = 1 + (rng.next() * 2 - 1) * jit;
    p.setXY(i, p.getX(i) * rx * k, p.getY(i) * rz * k);
  }
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** Overcast: F-shape concrete highway barrier, 3.0 (x) × 1.07 × 0.6 m; worn white band, stains, 3 amber studs per face. */
function buildBarrier() {
  const K = DP.barrier, C = K.colors;
  const L = 3.0;                                            // shape: length along x
  // F-shape half profile (|z| at height y): footing, lower slope, steep upper slope, chamfered top
  const prof = [[0.30, 0], [0.30, 0.075], [0.205, 0.33], [0.125, 1.0], [0.09, 1.07]];
  const sh = new Shape();
  sh.moveTo(-prof[0][0], 0);
  for (let i = 0; i < prof.length; i++) sh.lineTo(prof[i][0], prof[i][1]);
  for (let i = prof.length - 1; i >= 1; i--) sh.lineTo(-prof[i][0], prof[i][1]);
  sh.closePath();
  const body = new ExtrudeGeometry(sh, { depth: L, bevelEnabled: false, steps: 1, curveSegments: 1 });
  body.translate(0, 0, -L / 2);
  body.rotateY(Math.PI / 2);                                // extrusion → local x; profile → local z
  const slope1 = Math.atan2(0.095, 0.255), slope2 = Math.atan2(0.08, 0.67);
  const zAt = (y) => (y < 0.33 ? 0.30 - 0.095 * (y - 0.075) / 0.255 : 0.205 - 0.08 * (y - 0.33) / 0.67);
  const entries = [
    { geo: body, hex: C.concrete },
    { geo: box(L + 0.004, 0.13, 2 * zAt(0.82) + 0.012, 0, 0.885, 0), hex: C.stripe, k: 0.92 },                    // worn white band
    { geo: box(0.7, 0.07, 0.612, -0.6, 0.035, 0), hex: C.stain },                                                  // footing grime
    { geo: box(0.55, 0.05, 0.612, 0.9, 0.03, 0), hex: C.stain, k: 0.9 },
  ];
  const stains = [[-1.05, 0.2, 1, 0.55], [0.35, 0.16, -1, 0.4], [1.15, 0.24, 1, 0.3]];   // shape: x, y, face, width
  for (let i = 0; i < stains.length; i++) {
    const s = stains[i];
    entries.push({ geo: box(s[3], 0.14, 0.012, s[0], s[1], s[2] * (zAt(s[1]) + 0.004), -s[2] * slope1), hex: C.stain });
  }
  const studY = 0.62;
  for (let f = -1; f <= 1; f += 2) {
    for (let j = -1; j <= 1; j++) {
      entries.push({ geo: box(0.1, 0.06, 0.03, j * 1.0, studY, f * (zAt(studY) + 0.006), -f * slope2), rgb: emis3(C.reflector, K.emissive) });
    }
  }
  return mergeKind(entries, 'barrier');
}

/** Overcast: 3 traffic cones (2 white bands, black square bases) and an orange drum (2 bands), within r 0.8 m. */
function buildCones() {
  const C = DP.cones.colors;
  const entries = [];
  const cones = [[-0.42, 0.28, 0], [0.28, 0.42, 0], [0.02, -0.36, 1]];   // shape: x, z, tipped
  for (let i = 0; i < cones.length; i++) {
    const [x, z, tipped] = cones[i];
    const parts = [
      { geo: cyl(0.03, 0.17, 0.7, 10, 0, 0.39, 0, 0, 0, 0, true), hex: C.cone },
      { geo: cyl(0.125, 0.14, 0.09, 10, 0, 0.3, 0, 0, 0, 0, true), hex: C.band },
      { geo: cyl(0.085, 0.1, 0.07, 10, 0, 0.5, 0, 0, 0, 0, true), hex: C.band },
      { geo: box(0.4, 0.04, 0.4, 0, 0.02, 0), hex: C.base },
    ];
    for (let p = 0; p < parts.length; p++) {
      const g = parts[p].geo;
      if (tipped) { g.translate(0, -0.2, 0); g.rotateZ(Math.PI / 2 - 0.12); g.translate(0, 0.2, 0); }   // knocked over, lying on its base edge
      g.rotateY(i * 1.3);
      g.translate(x, 0, z);
      entries.push(parts[p]);
    }
  }
  const dx = 0.46, dz = -0.12;                                            // drum
  entries.push({ geo: cyl(0.29, 0.29, 0.9, 10, dx, 0.45, dz), hex: C.drum });
  entries.push({ geo: cyl(0.295, 0.295, 0.1, 10, dx, 0.58, dz, 0, 0, 0, true), hex: C.band });
  entries.push({ geo: cyl(0.295, 0.295, 0.1, 10, dx, 0.78, dz, 0, 0, 0, true), hex: C.band });
  return mergeKind(entries, 'cones');
}

/** Overcast: roadside billboard 6.8 × 9.6 m, board facing +z, two I-beam posts, catwalk with railing, faded panels. */
function buildBillboard() {
  const C = DP.billboard.colors;
  const entries = [];
  for (let s = -1; s <= 1; s += 2) {                                      // I-beam posts at x ±2.2 up to 6.3 m
    entries.push({ geo: box(0.08, 6.3, 0.3, s * 2.2, 3.15, -0.2), hex: C.post });
    entries.push({ geo: box(0.32, 6.3, 0.06, s * 2.2, 3.15, -0.05), hex: C.post });
    entries.push({ geo: box(0.32, 6.3, 0.06, s * 2.2, 3.15, -0.35), hex: C.post, k: 0.85 });
    entries.push({ geo: box(0.08, 0.08, 1.2, s * 2.2, 5.2, -0.72, -0.75), hex: C.frame });   // back brace (depth ≤ 1.2 m)
  }
  entries.push({ geo: box(6.6, 0.08, 0.9, 0, 6.2, 0.55), hex: C.frame });                    // catwalk
  entries.push({ geo: box(6.6, 0.05, 0.05, 0, 6.95, 0.98), hex: C.frame });                  // railing
  for (let j = -1; j <= 1; j++) entries.push({ geo: box(0.05, 0.75, 0.05, j * 3.2, 6.58, 0.98), hex: C.frame });
  entries.push({ geo: box(6.8, 3.2, 0.25, 0, 8.0, 0), hex: C.frame });                       // board 6.4–9.6 m
  entries.push({ geo: box(6.6, 3.0, 0.02, 0, 8.0, 0.135), hex: C.faded });                   // pale margin
  const blocks = [[-3.2, -1.2, 0], [-1.05, 1.3, 1], [1.45, 3.2, 2]];                           // shape: x from, x to, panel colour
  for (let i = 0; i < blocks.length; i++) {
    const [a, b, c] = blocks[i];
    const h = i === 1 ? 2.2 : 2.6;
    entries.push({ geo: box(b - a, h, 0.02, (a + b) / 2, 8.0 + (i === 1 ? 0.25 : 0), 0.15), hex: C.panel[c] });
  }
  return mergeKind(entries, 'billboard');
}

/** Overcast: box truck 8.8 (z, nose −z) × 2.5 × 3.2 m; cab and box near-white (the cars placer paints them per instance). */
function buildTruck() {
  const C = DP.truck.colors;
  const W = [NEAR_WHITE, NEAR_WHITE, NEAR_WHITE];
  const wr = 0.5;                                                           // shape: wheel radius
  const entries = [
    { geo: box(2.4, 2.25, 2.0, 0, 0.55 + 1.125, -3.4), rgb: W },            // cab, front face at z −4.4
    { geo: box(2.5, 2.5, 6.4, 0, 0.7 + 1.25, 1.2), rgb: W },                // box body to y 3.2, z −2.0 … 4.4
    { geo: box(2.0, 0.2, 0.1, 0, 3.0, -2.4), rgb: W },                      // cab roof deflector lip
    { geo: box(2.1, 0.8, 0.04, 0, 2.25, -4.41), hex: C.glass },             // windscreen
    { geo: box(0.04, 0.6, 0.9, 1.21, 2.3, -3.6), hex: C.glass },            // side windows
    { geo: box(0.04, 0.6, 0.9, -1.21, 2.3, -3.6), hex: C.glass },
    { geo: box(1.7, 0.45, 0.04, 0, 1.05, -4.41), hex: C.chassis },          // grille
    { geo: box(2.3, 0.25, 0.22, 0, 0.62, -4.45), hex: C.chassis },          // bumper
    { geo: box(0.16, 0.22, 8.2, 0.55, 0.62, 0.1), hex: C.chassis },         // chassis rails
    { geo: box(0.16, 0.22, 8.2, -0.55, 0.62, 0.1), hex: C.chassis },
    { geo: box(0.03, 2.3, 0.02, 0, 1.95, 4.41), hex: C.chassis },           // rear door seam
    { geo: box(0.012, 1.1, 2.4, 1.256, 1.5, 2.0), hex: C.rust },            // rust streaks
    { geo: box(0.012, 0.7, 1.4, -1.256, 1.2, -0.6), hex: C.rust },
  ];
  const axles = [-3.0, 2.3, 3.45];                                          // front axle, rear tandem
  for (let a = 0; a < axles.length; a++) {
    for (let s = -1; s <= 1; s += 2) entries.push({ geo: cyl(wr, wr, 0.3, 10, s * 1.05, wr, axles[a], 0, 0, Math.PI / 2), hex: C.tyre });
  }
  return mergeKind(entries, 'truck');
}

/** Night City: neon blade sign 1.2 × 2.4 × 0.2 m (2.6–5.0 m up) on a pole; magenta border, cyan word strokes, amber arrow. */
function buildNeon() {
  const K = DP.neon, C = K.colors;
  const t = 0.08, d = 0.24, cy = 3.8;                                       // tube thickness; tubes span both faces (d > box depth)
  const [mag, cyan, amber] = C.tubes;
  const e = (hex) => emis3(hex, K.emissive);
  const entries = [
    { geo: cyl(0.05, 0.05, 5.3, 6, -0.72, 2.65, 0, 0, 0, 0, true), hex: C.pole },
    { geo: box(0.2, 0.2, 0.2, -0.72, 0.1, 0), hex: C.pole, k: 0.8 },        // pole foot
    { geo: box(0.2, 0.06, 0.06, -0.62, 4.75, 0), hex: C.pole },             // brackets
    { geo: box(0.2, 0.06, 0.06, -0.62, 2.85, 0), hex: C.pole },
    { geo: box(1.2, 2.4, 0.2, 0, cy, 0), hex: C.box },                      // sign box 2.6 … 5.0 m
    // magenta border
    { geo: box(1.04, t, d, 0, cy + 1.08, 0), rgb: e(mag) },
    { geo: box(1.04, t, d, 0, cy - 1.08, 0), rgb: e(mag) },
    { geo: box(t, 2.16, d, 0.49, cy, 0), rgb: e(mag) },
    { geo: box(t, 2.16, d, -0.49, cy, 0), rgb: e(mag) },
  ];
  const strokes = [[0.62, 0.72], [0.46, 0.42], [0.66, 0.12], [0.38, -0.18]];   // shape: width, y offset (word strokes)
  for (let i = 0; i < strokes.length; i++) entries.push({ geo: box(strokes[i][0], t, d, (i % 2 ? -0.08 : 0.04), cy + strokes[i][1], 0), rgb: e(cyan) });
  entries.push({ geo: box(0.34, t, d, -0.06, cy - 0.62, 0, 0, 0, 0.6), rgb: e(amber) });     // arrow chevron (points down)
  entries.push({ geo: box(0.34, t, d, 0.18, cy - 0.62, 0, 0, 0, -0.6), rgb: e(amber) });
  return mergeKind(entries, 'neon');
}

/** Toxic: chemical drums (3 upright + 1 tipped) over an irregular glowing ooze puddle, within r 0.9 m. */
function buildBarrel() {
  const K = DP.barrel, C = K.colors;
  const ooze = emis3(C.ooze, K.emissive);
  const rng = new Rng(hashString('models.barrel'));
  const entries = [{ geo: blobDisc(0.78, 0.72, 12, 0.11, 0.012, rng), rgb: ooze }];
  const drums = [[-0.34, -0.22], [0.26, -0.34], [-0.44, 0.38]];            // shape: upright drum centres (all inside r 0.9)
  const r = 0.29, h = 0.88;
  for (let i = 0; i < drums.length; i++) {
    const [x, z] = drums[i];
    entries.push({ geo: cyl(r, r, h, 10, x, h / 2, z), hex: C.drum[i % C.drum.length] });
    entries.push({ geo: cyl(r + 0.006, r + 0.006, 0.05, 10, x, h * 0.3, z, 0, 0, 0, true), hex: C.band });
    entries.push({ geo: cyl(r + 0.006, r + 0.006, 0.05, 10, x, h * 0.72, z, 0, 0, 0, true), hex: C.band });
    const a = i * 2.1 + 0.4;                                                // hazard label facing outward
    entries.push({ geo: box(0.2, 0.2, 0.02, x + Math.sin(a) * (r + 0.005), h * 0.5, z + Math.cos(a) * (r + 0.005), 0, a, 0), hex: C.hazard });
  }
  // tipped drum (axis along local x, lid at +x), leaning on the two front drums, turned 45° and leaking from its lid
  const tipped = [
    { geo: cyl(r, r, h, 10, 0, 0, 0, 0, 0, Math.PI / 2), hex: C.drum[1] },
    { geo: cyl(r + 0.006, r + 0.006, 0.05, 10, -0.12, 0, 0, 0, 0, Math.PI / 2, true), hex: C.band, k: 0.9 },
    { geo: box(0.03, 0.2, 0.16, h / 2 + 0.01, -0.02, 0), rgb: ooze },       // drip down the lid
  ];
  for (let i = 0; i < tipped.length; i++) {
    tipped[i].geo.rotateY(Math.PI / 4);
    tipped[i].geo.translate(0.3, r, 0.3);
    entries.push(tipped[i]);
  }
  return mergeKind(entries, 'barrel');
}

/** Toxic: ISO shipping container 6.06 (x) × 2.59 × 2.44 m; body near-white 0.9 (instance paint), ribs 0.75, doors at +x. */
function buildContainer() {
  const C = DP.container.colors;
  const L = 6.06, H = 2.59, D = 2.44;
  const body = 0.9, rib = 0.75;                                             // vertex brightness (× instance paint)
  const entries = [
    { geo: box(L - 0.04, H - 0.04, D, 0, H / 2, 0), rgb: [body, body, body] },
    { geo: box(0.03, H - 0.2, D * 0.46, L / 2 - 0.005, H / 2, D * 0.24), hex: C.door },     // door leaves
    { geo: box(0.03, H - 0.2, D * 0.46, L / 2 - 0.005, H / 2, -D * 0.24), hex: C.door, k: 0.9 },
    { geo: box(0.05, H - 0.3, 0.05, L / 2 + 0.01, H / 2, D * 0.1), hex: C.rib },            // locking bars
    { geo: box(0.05, H - 0.3, 0.05, L / 2 + 0.01, H / 2, -D * 0.1), hex: C.rib },
    { geo: box(L, 0.12, D + 0.02, 0, 0.06, 0), hex: C.rib },                                // bottom rails
    { geo: box(L, 0.08, D + 0.02, 0, H - 0.04, 0), hex: C.rib, k: 1.2 },                    // top rails
  ];
  for (let i = 0; i < 10; i++) {                                            // 10 ribs per long side (one box through both faces)
    const x = -L / 2 + 0.45 + i * ((L - 0.9) / 9);
    entries.push({ geo: box(0.12, H - 0.24, D + 0.03, x, H / 2, 0), rgb: [rib, rib, rib] });
  }
  return mergeKind(entries, 'container');
}

/** Toxic: tapered brick smokestack r 1.1 → 0.8, top y 20.5 m, white / red bands, dark cap ring, side ladder, plinth. */
function buildSmokestack() {
  const C = DP.smokestack.colors;
  const top = DP.smokestack.smokeY, base = 1.2;                             // the plume anchors at smokeY
  const r0 = 1.1, r1 = 0.8;
  const rAt = (y) => r0 + (r1 - r0) * (y - base) / (top - base);
  const entries = [
    { geo: box(2.8, base, 2.8, 0, base / 2, 0), hex: C.ladder, k: 0.9 },                    // plinth
    { geo: cyl(r1, r0, top - base, 10, 0, (top + base) / 2, 0), hex: C.brick },
    { geo: cyl(rAt(17.2) + 0.03, rAt(16.4) + 0.03, 0.8, 10, 0, 16.8, 0, 0, 0, 0, true), hex: C.band[0] },
    { geo: cyl(rAt(18.4) + 0.03, rAt(17.6) + 0.03, 0.8, 10, 0, 18.0, 0, 0, 0, 0, true), hex: C.band[1] },
    { geo: cyl(rAt(19.6) + 0.03, rAt(18.8) + 0.03, 0.8, 10, 0, 19.2, 0, 0, 0, 0, true), hex: C.band[0] },
    { geo: cyl(r1 + 0.12, r1 + 0.12, 0.5, 10, 0, top - 0.25, 0), hex: C.cap },             // cap ring (dark top)
  ];
  const lx0 = rAt(base) + 0.12, lx1 = rAt(top) + 0.12;                       // ladder on the +x side, following the taper
  const lean = Math.atan2(lx0 - lx1, top - base);
  for (let s = -1; s <= 1; s += 2) entries.push({ geo: box(0.05, top - base, 0.05, (lx0 + lx1) / 2, (top + base) / 2, s * 0.2, 0, 0, lean), hex: C.ladder });
  for (let j = 0; j < 6; j++) {
    const y = base + 1.5 + j * 3.0;
    entries.push({ geo: box(0.04, 0.04, 0.4, rAt(y) + 0.12, y, 0), hex: C.ladder });
  }
  return mergeKind(entries, 'smokestack');
}

/** Toxic: pipe rack section 6.0 (x) × 2.3 × 1.0 m: two pipes on two H-supports, a valve wheel, rust; chains end to end. */
function buildPipe() {
  const C = DP.pipe.colors;
  const L = 6.0;
  const entries = [
    { geo: cyl(0.22, 0.22, L, 10, 0, 1.2, 0.18, 0, 0, Math.PI / 2), hex: C.pipe[0] },
    { geo: cyl(0.32, 0.32, L, 10, 0, 1.9, -0.12, 0, 0, Math.PI / 2), hex: C.pipe[1] },
    { geo: cyl(0.235, 0.235, 0.5, 10, 1.1, 1.2, 0.18, 0, 0, Math.PI / 2, true), hex: C.rust },   // rust collars
    { geo: cyl(0.335, 0.335, 0.7, 10, -1.6, 1.9, -0.12, 0, 0, Math.PI / 2, true), hex: C.rust },
    { geo: box(0.06, 0.32, 0.06, 0.6, 2.36, -0.12), hex: C.support },                            // valve stem + wheel
    { geo: cyl(0.22, 0.22, 0.05, 8, 0.6, 2.52, -0.12), hex: C.valve },
  ];
  for (let s = -1; s <= 1; s += 2) {                                         // H-supports at x ±2.4
    const x = s * 2.4;
    entries.push({ geo: box(0.14, 2.3, 0.14, x, 1.15, 0.4), hex: C.support });
    entries.push({ geo: box(0.14, 2.3, 0.14, x, 1.15, -0.4), hex: C.support });
    entries.push({ geo: box(0.12, 0.1, 0.94, x, 0.95, 0), hex: C.support });
    entries.push({ geo: box(0.12, 0.1, 0.94, x, 1.55, 0), hex: C.support });
  }
  return mergeKind(entries, 'pipe');
}

/** Toxic: flat glowing ooze puddle 1.6 × 1.2 m at y 0.012: dark rim blob + inner ooze blob (14 segments, fixed seed). */
function buildPuddle() {
  const K = DP.puddle, C = K.colors;
  const rng = new Rng(hashString('models.puddle'));
  return mergeKind([
    { geo: blobDisc(0.8, 0.6, 14, 0.14, 0.01, rng), hex: C.rim },
    { geo: blobDisc(0.6, 0.44, 14, 0.18, 0.014, rng), rgb: emis3(C.ooze, K.emissive) },
  ], 'puddle');
}

/** Ash: burning wreck 4.2 (z) × 1.8 × 1.3 m: charred shell, crushed roof, no glass, ember patches (final colours). */
function buildBurningWreck() {
  const K = DP.burningWreck, C = K.colors;
  const em = emis3(C.ember, K.emissive);
  const y0 = 0.3;                                                           // chassis clearance (tyres burnt away)
  const entries = [
    { geo: box(1.8, 0.5, 4.2, 0, y0 + 0.25, 0), hex: C.char },
    { geo: box(1.72, 0.1, 1.2, 0, y0 + 0.56, -1.45, 0.12, 0, 0.05), hex: C.char, k: 1.1 },        // buckled hood
    { geo: box(1.72, 0.1, 0.85, 0, y0 + 0.54, 1.64, -0.08), hex: C.char, k: 1.1 },               // trunk lid
    { geo: box(1.5, 0.42, 1.8, 0, y0 + 0.76, 0.12), hex: C.glass },                              // gutted cabin (holes)
    { geo: box(1.6, 0.08, 1.7, 0.05, y0 + 0.88, 0.15, 0.05, 0, -0.05), hex: C.char },            // crushed roof (top ≈ 1.3 m)
    { geo: box(1.88, 0.16, 0.14, 0, y0 + 0.1, -2.12), hex: C.rust },
    { geo: box(1.88, 0.16, 0.14, 0, y0 + 0.1, 2.12), hex: C.rust },
    { geo: box(0.012, 0.3, 1.4, 0.905, y0 + 0.28, 0.5), hex: C.rust },
    { geo: box(0.9, 0.012, 0.7, -0.25, y0 + 0.62, 1.6), hex: C.rust },
    // ember patches: sills, wheel wells, engine bay
    { geo: box(0.02, 0.07, 0.6, 0.91, y0 + 0.06, -0.4), rgb: em },
    { geo: box(0.02, 0.07, 0.5, -0.91, y0 + 0.06, 0.7), rgb: em },
    { geo: box(0.02, 0.12, 0.4, 0.91, y0 + 0.12, 1.36), rgb: em },
    { geo: box(0.02, 0.12, 0.4, -0.91, y0 + 0.12, -1.36), rgb: em },
    { geo: box(1.0, 0.03, 0.6, 0, y0 + 0.61, -1.5), rgb: em },
    { geo: box(0.6, 0.03, 0.5, 0.1, y0 + 0.56, 0.3), rgb: em },
  ];
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) entries.push({ geo: cyl(0.26, 0.26, 0.18, 8, sx * 0.82, 0.26, sz * 1.36, 0, 0, Math.PI / 2), hex: C.rust, k: 0.7 });
    entries.push({ geo: box(0.08, 0.44, 0.08, sx * 0.74, y0 + 0.74, -0.8), hex: C.char });       // pillars
    entries.push({ geo: box(0.08, 0.44, 0.08, sx * 0.74, y0 + 0.72, 1.0), hex: C.char });
  }
  return mergeKind(entries, 'burningWreck');
}

/** Ash: ash dune 8 (x) × 1.0 × 4.4 m: flattened half-ellipsoid + offset crest; sand → crest by height, ash patches low. */
function buildDune() {
  const C = DP.dune.colors;
  const sand = lin3(C.sand), crest = lin3(C.crest), ash = lin3(C.ash);
  const fn = (x, y, z) => {
    const t = clamp(y / 1.0, 0, 1);
    let c = mix3(sand, crest, t * t * (3 - 2 * t));
    const low = 1 - clamp(y / 0.3, 0, 1);
    const n = hash3(Math.floor(x * 1.3), 0, Math.floor(z * 1.3));
    if (n > 0.45) c = mix3(c, ash, low * 0.85);
    return c;
  };
  const main = new SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  main.scale(4.0, 1.0, 2.2);
  main.computeVertexNormals();                                              // faceted (flat normals): the low-poly prop look
  const ridge = new SphereGeometry(1, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  ridge.scale(2.6, 0.42, 0.75);
  ridge.translate(0.5, 0.56, -0.4);
  ridge.computeVertexNormals();
  return mergeKind([{ geo: main, fn }, { geo: ridge, fn }], 'dune');
}

/** Ash / Frozen: rock cluster within r 1.0 m: 3 faceted boulders + 2 stones (fixed-seed scale / rotation). */
function buildRock() {
  const C = DP.rock.colors;
  const rng = new Rng(hashString('models.rock'));
  const pieces = [[0.55, -0.3, 0.2], [0.45, 0.38, -0.15], [0.36, 0.0, -0.55], [0.15, 0.62, 0.48], [0.13, -0.7, -0.3]];   // shape: r, x, z
  const entries = [];
  for (let i = 0; i < pieces.length; i++) {
    const [r, x, z] = pieces[i];
    const g = new IcosahedronGeometry(r, 0);
    g.scale(rng.range(0.9, 1.3), rng.range(0.6, 0.85), rng.range(0.85, 1.15));
    g.rotateY(rng.range(0, Math.PI * 2));
    g.rotateX(rng.range(-0.25, 0.25));
    g.translate(x, r * 0.42, z);
    entries.push({ geo: g, hex: C.rock[i % C.rock.length], k: i < 3 ? 1 : 0.85 });
  }
  return mergeKind(entries, 'rock');
}

/** Frozen: snowbank 4.5 (x) × 0.9 × 1.6 m: 3 overlapping half-ellipsoids; white tops, blue-grey flanks, slush at the base. */
function buildSnowbank() {
  const C = DP.snowbank.colors;
  const snow = lin3(C.snow), shade = lin3(C.shade), dirt = lin3(C.dirt);
  const fn = (x, y, z, nx, ny) => {
    let c = mix3(shade, snow, clamp((ny - 0.35) / 0.4, 0, 1));
    return y < 0.12 ? mix3(c, dirt, 1 - y / 0.12) : c;
  };
  const humps = [[-1.25, 1.1, 0.9, 0.78], [0.15, 1.35, 0.8, 0.8], [1.4, 0.95, 0.62, 0.66]];   // shape: x, rx, h, rz
  const entries = [];
  for (let i = 0; i < humps.length; i++) {
    const [x, rx, h, rz] = humps[i];
    const g = new SphereGeometry(1, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(rx, h, rz);
    g.translate(x, 0, (i - 1) * 0.06);
    entries.push({ geo: g, fn });
  }
  return mergeKind(entries, 'snowbank');
}

/** Frozen: the environment car's proportions (4.2 m, body near-white 0.95) with snow caps on roof / hood / trunk / bumpers and icicles. */
function buildFrozenCar() {
  const K = DP.frozenCar, C = K.colors, P = PALETTE.props;
  const W = [NEAR_WHITE, NEAR_WHITE, NEAR_WHITE];
  const wr = 0.33, y0 = wr - 0.02;                                          // same as environment.js buildCar
  const frostedGlass = mix3(lin3(P.glass), lin3(C.ice), 0.35);
  const entries = [
    { geo: box(1.8, 0.52, 4.2, 0, y0 + 0.26, 0), rgb: W },
    { geo: box(1.74, 0.12, 1.25, 0, y0 + 0.57, -1.42, 0.07, 0, 0.03), rgb: W },
    { geo: box(1.74, 0.1, 0.85, 0, y0 + 0.56, 1.64, -0.05), rgb: W },
    { geo: box(1.56, 0.47, 1.95, 0, y0 + 0.76, 0.12), rgb: frostedGlass },
    { geo: box(1.62, 0.07, 1.8, 0, y0 + 1.02, 0.14, 0.02, 0, -0.03), rgb: W },
    { geo: box(0.08, 0.46, 0.08, 0.76, y0 + 0.76, -0.82), rgb: W },
    { geo: box(0.08, 0.46, 0.08, -0.76, y0 + 0.76, -0.82), rgb: W },
    { geo: box(1.88, 0.18, 0.16, 0, y0 + 0.14, -2.12), hex: P.rust },
    { geo: box(1.88, 0.18, 0.16, 0, y0 + 0.14, 2.12), hex: P.rust },
    { geo: box(0.3, 0.1, 0.04, 0.6, y0 + 0.4, -2.11), hex: P.glass, k: 1.6 },
    { geo: box(0.3, 0.1, 0.04, -0.6, y0 + 0.4, -2.11), hex: P.glass, k: 1.6 },
    { geo: box(1.82, 0.04, 0.03, 0, y0 + 0.36, 0.1), hex: P.tyre },
    // snow caps (roof cap top 1.50 m ≤ the 1.52 m roof pose)
    { geo: box(1.5, 0.13, 1.66, 0, y0 + 1.1, 0.14, 0.02, 0, -0.03), hex: C.snow },
    { geo: box(1.6, 0.1, 1.1, 0, y0 + 0.66, -1.4, 0.07, 0, 0.03), hex: C.snow },
    { geo: box(1.6, 0.09, 0.75, 0, y0 + 0.645, 1.64, -0.05), hex: C.snow },
    { geo: box(1.8, 0.06, 0.14, 0, y0 + 0.26, -2.12), hex: C.snow },
    { geo: box(1.8, 0.06, 0.14, 0, y0 + 0.26, 2.12), hex: C.snow },
  ];
  const icicles = [[0.8, -0.55, 0.2], [0.8, 0.35, 0.16], [-0.8, -0.2, 0.22], [-0.8, 0.7, 0.14], [0.3, 1.04, 0.18]];   // shape: x, z, length
  for (let i = 0; i < icicles.length; i++) {
    const [x, z, len] = icicles[i];
    const g = new CylinderGeometry(0.035, 0.004, len, 4, 1, true);
    g.translate(x, y0 + 1.0 - len / 2, z);
    entries.push({ geo: g, hex: C.ice });
  }
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      entries.push({ geo: cyl(wr, wr, 0.24, 10, sx * 0.84, wr, sz * 1.36, 0, 0, Math.PI / 2), hex: P.tyre });
      entries.push({ geo: cyl(wr * 0.5, wr * 0.5, 0.25, 8, sx * 0.85, wr, sz * 1.36, 0, 0, Math.PI / 2), hex: P.barricade, k: 0.6 });
    }
  }
  return mergeKind(entries, 'frozenCar');
}

/** Frozen: snowy pine ≈ 6.5 m: trunk + 4 stacked needle cones (alternating greens), each with a white snow cap. */
function buildPine() {
  const C = DP.pine.colors;
  const entries = [{ geo: cyl(0.12, 0.2, 1.2, 7, 0, 0.6, 0, 0, 0, 0, true), hex: C.trunk }];
  const tiers = 4, h = 1.6;
  for (let i = 0; i < tiers; i++) {
    const r = 1.6 - i * ((1.6 - 0.6) / (tiers - 1));
    const y = 1.0 + i * 1.2;
    entries.push({ geo: cyl(0, r, h, 9, 0, y + h / 2, 0, 0, i * 0.35, 0), hex: C.needles[i % C.needles.length] });
    entries.push({ geo: cyl(0, r * 0.62, h * 0.42, 9, 0, y + h - h * 0.21 + 0.02, 0, 0, i * 0.35 + 0.17, 0, true), hex: C.snow });
  }
  return mergeKind(entries, 'pine');
}

/** The 16 district kinds of docs/DISTRICTS.md §7 (geo.<kind>). */
function buildDistrictGeometries(geo) {
  geo.barrier = buildBarrier();
  geo.cones = buildCones();
  geo.billboard = buildBillboard();
  geo.truck = buildTruck();
  geo.neon = buildNeon();
  geo.barrel = buildBarrel();
  geo.container = buildContainer();
  geo.smokestack = buildSmokestack();
  geo.pipe = buildPipe();
  geo.puddle = buildPuddle();
  geo.burningWreck = buildBurningWreck();
  geo.dune = buildDune();
  geo.rock = buildRock();
  geo.snowbank = buildSnowbank();
  geo.frozenCar = buildFrozenCar();
  geo.pine = buildPine();
}

// ---------------------------------------------------------------------------------------------
// ModelLibrary (ARCH §6.4)
// ---------------------------------------------------------------------------------------------

/** Resolves 'troop.sniper' / 'sniper' → 'sniper'. */
function troopKey(id) {
  if (typeof id !== 'string') return '';
  return id.startsWith('troop.') ? id.slice(6) : id;
}

// Troop body walk settings (per-vertex iAnim on the single troop meshes): the sniper aims from his
// crate (speed 0 = rest pose), the medic and the flamer march with the squad, phase-shifted so they
// never step in lock with the soldiers around them.
const TROOP_GAIT = Object.freeze({ sniper: { speed: 0, phase: 0 }, medic: { speed: 1, phase: 0.37 }, flamer: { speed: 1, phase: 0.71 } });

const _tip = { x: 0, y: 0, z: 0 };   // weaponTip scratch (buildTroopMesh, init-time)

export class ModelLibrary {
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Record<string, BufferGeometry>} */
    this.geo = {};
    /** Triangle counts per geometry (debug overlay / PR note). */
    this.stats = {};
    this._uTime = null;
    this._rifleGlow = { value: new Vector3(0, 0, 0) };
    // soldier-class look uniforms shared by every class material (CHR-2 gear glows, CHR-3 rim light)
    this._look = {
      uHitFlashMix: { value: HIT_FLASH_DIFFUSE_MIX },
      uRimColor: { value: new Vector3(RIM_COLOR[0], RIM_COLOR[1], RIM_COLOR[2]) },
      uRimPower: { value: RIM_POWER },
      uTopFill: { value: TOP_FILL },
      uMagnet: { value: 0 },
      uArmor: { value: 0 },
      uMagnetGlow: { value: linearVec(PALETTE.soldier.magnetGlow !== undefined ? PALETTE.soldier.magnetGlow : 0xC77DFF, MAGNET_GLOW) },
      uArmorGlow: { value: linearVec(PALETTE.fx.armor, ARMOR_GLOW) },
    };
    this._uniforms = new Map();          // classId → uniform set shared by the standard + depth materials
    this._materials = new Map();         // classId → MeshStandardMaterial
    this._depthMaterials = new Map();    // classId → MeshDepthMaterial
    this._ownedMaterials = [];           // every material created here (troops, rigs) for dispose()
    this._ownedGeometries = [];          // per-mesh geometries created for troops / rigs
    this._rigFactory = null;
    this._eyeGlow = NaN;                 // setEyeGlow value (NaN = PALETTE.zombie.eyesEmissive)
    this._initialised = false;
  }

  /** Builds every geometry and asserts the vertex-attribute budget (ARCH §6.4). Returns this. */
  init() {
    if (this._initialised) return this;
    const render = this.ctx ? this.ctx.render : null;
    const renderer = render ? render.renderer : null;
    const caps = renderer && renderer.capabilities ? renderer.capabilities : null;
    const maxAttributes = caps && typeof caps.maxAttributes === 'number' ? caps.maxAttributes : GUARANTEED_MAX_ATTRIBUTES;
    if (VERTEX_ATTRIBUTE_BUDGET > maxAttributes) {
      throw new Error('models: this GPU exposes ' + maxAttributes + ' vertex attributes; the character material needs ' + VERTEX_ATTRIBUTE_BUDGET);
    }
    this._uTime = render && render.uniforms && render.uniforms.uTime ? render.uniforms.uTime : { value: 0 };
    const geo = this.geo;
    for (let i = 0; i < CHARACTER_CLASSES.length; i++) {
      const id = CHARACTER_CLASSES[i];
      const g = mergeParts(characterParts(id), id);
      this._assertCharacterAttributes(g, id, maxAttributes);
      geo[id] = g;
    }
    buildStaticGeometries(geo);
    buildDistrictGeometries(geo);                                  // round 5: the 16 district prop kinds (docs/DISTRICTS.md §7)
    for (const k in geo) this.stats[k] = geo[k].userData.tris | 0;
    this._initialised = true;
    // docs/DISTRICTS.md §3.6: the environment (built at boot step 5, before this step 6) adopts the district kinds now and
    // parks one hidden warm proxy per (slot, kind), so render.warmup's "draw every renderable once" pass (step 9b) uploads
    // every district geometry and creates its VAOs (main and shadow-depth) with the real instance buffers
    const env = render ? render.env : null;
    if (env && typeof env.warmDistricts === 'function') {
      try { env.warmDistricts(); } catch (err) { warnOnce('models.warmDistricts', 'env.warmDistricts failed: ' + (err && err.message)); }
    }
    return this;
  }

  /** docs/DISTRICTS.md §6.3: the five zombie classes' eye (and spitter acid-sac) emissive, i.e. every 0.5-tagged piece.
   *  Uniform writes only (no recompile); soldier classes and boss rigs (boss.js drives their glow) are untouched. */
  setEyeGlow(v) {
    if (!Number.isFinite(v)) return;
    this._eyeGlow = v;
    for (const id in ZOMBIE_CLASSES) {
      const u = this._uniforms.get(id);
      if (u) u.uEyeEmissive.value = v;
    }
  }

  /** Throws unless a character geometry carries exactly the §6.4 attribute set and fits the GPU. */
  _assertCharacterAttributes(g, id, maxAttributes) {
    const names = Object.keys(g.attributes);
    for (let i = 0; i < CHARACTER_ATTRIBUTES.length; i++) {
      if (!g.attributes[CHARACTER_ATTRIBUTES[i]]) throw new Error('models: "' + id + '" lacks attribute ' + CHARACTER_ATTRIBUTES[i]);
    }
    const used = names.length + INSTANCE_MATRIX_SLOTS + INSTANCE_DATA_SLOTS;
    if (names.length !== CHARACTER_ATTRIBUTES.length || used > maxAttributes) {
      throw new Error('models: "' + id + '" uses ' + used + ' vertex attributes (' + names.join(', ') + ' + instanceMatrix + iAnim + iState); budget ' +
        VERTEX_ATTRIBUTE_BUDGET + ', GPU max ' + maxAttributes);
    }
  }

  /** SQUAD.limb for soldier-type classes, ZOMBIES[classId].limb for zombies (no values live here). */
  limbParamsFor(classId) {
    if (SOLDIER_CLASSES[classId]) return SQUAD.limb;
    if (ZOMBIE_CLASSES[classId]) return ZOMBIES[classId].limb;
    throw new Error('models: no limb params for "' + classId + '"');
  }

  /** Contract helper: attributes a part (color/aPart/aPivot, uv deleted). */
  _tagPart(geo, partId, pivot, hex, emissive = false) {
    return tagPart(geo, partId, pivot, hex, emissive);
  }

  /** Shared uniform set per class (standard and depth materials reference the same objects). */
  _uniformsFor(classId) {
    let u = this._uniforms.get(classId);
    if (u) return u;
    const limb = this.limbParamsFor(classId);
    const g = this.geo[classId];
    if (!g) throw new Error('models: character geometry "' + classId + '" missing (ModelLibrary.init first)');
    u = {
      uTime: this._uTime,
      uFreq: { value: limb.uFreq }, uLegAmp: { value: limb.uLegAmp }, uArmAmp: { value: limb.uArmAmp },
      uArmRest: { value: limb.uArmRest }, uBobAmp: { value: limb.uBobAmp }, uRecoil: { value: limb.uRecoil || 0 },
      uRecoilTime: { value: RECOIL_SECONDS },
      uSinkDepth: { value: g.boundingBox.max.y + SINK_MARGIN },        // a toppled body is never longer than it is tall
      uToppleFrac: { value: SOLDIER_CLASSES[classId] ? SOLDIER_TOPPLE_FRAC : ZOMBIE_TOPPLE_FRAC },
      uHitFlashInv: { value: 1 / ZOMBIES.common.hitFlash },
      uHitFlashEmissive: { value: HIT_FLASH_EMISSIVE },
      uDeathDark: { value: DEATH_DARK }, uDeathDarkMix: { value: DEATH_DARK_MIX },
      uEyeEmissive: { value: (ZOMBIE_CLASSES[classId] && Number.isFinite(this._eyeGlow)) ? this._eyeGlow : PALETTE.zombie.eyesEmissive },
      uRifleGlow: this._rifleGlow,
    };
    for (const k in this._look) u[k] = this._look[k];
    this._uniforms.set(classId, u);
    return u;
  }

  /**
   * Lit character material: vertexColors, limb-swing vertex chunk, tint/hit-flash/death fragment chunk,
   * shared uTime. Cached per class; customProgramCacheKey 'gr:char' or 'gr:char-recoil' (soldier classes).
   */
  makeCharacterMaterial(classId) {
    let m = this._materials.get(classId);
    if (m) return m;
    const recoil = !!SOLDIER_CLASSES[classId];
    const uniforms = this._uniformsFor(classId);
    const surf = recoil ? PALETTE.material.cloth : PALETTE.material.skin;
    m = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: surf.roughness, metalness: surf.metalness });
    m.name = 'char.' + classId;
    m.onBeforeCompile = (shader) => {
      for (const k in uniforms) shader.uniforms[k] = uniforms[k];
      shader.vertexShader = injectVertex(shader.vertexShader, recoil, true);
      shader.fragmentShader = injectFragment(shader.fragmentShader, recoil);
    };
    m.customProgramCacheKey = () => (recoil ? 'gr:char-recoil' : 'gr:char');
    m.userData.uniforms = uniforms;
    m.userData.classId = classId;
    this._materials.set(classId, m);
    return m;
  }

  /** Shadow depth material with the same vertex deformation (RGBADepthPacking); cached per class. */
  makeCharacterDepthMaterial(classId) {
    let m = this._depthMaterials.get(classId);
    if (m) return m;
    const recoil = !!SOLDIER_CLASSES[classId];
    const uniforms = this._uniformsFor(classId);
    m = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    m.name = 'charDepth.' + classId;
    m.onBeforeCompile = (shader) => {
      for (const k in uniforms) shader.uniforms[k] = uniforms[k];
      shader.vertexShader = injectVertex(shader.vertexShader, recoil, false);
    };
    m.customProgramCacheKey = () => (recoil ? 'gr:chardepth-recoil' : 'gr:chardepth');
    m.userData.uniforms = uniforms;
    this._depthMaterials.set(classId, m);
    return m;
  }

  /**
   * Extra (GDD J13 "rifles recolour (emissive)"): sets the weapon glow of every soldier-class material
   * (one shared uniform). hex = sRGB colour (e.g. WEAPONS[k].color), intensity 0 clears. Allocation-free.
   */
  setRifleGlow(hex, intensity) {
    if (!intensity) { this._rifleGlow.value.set(0, 0, 0); return; }
    _color.setHex(hex);
    this._rifleGlow.value.set(_color.r * intensity, _color.g * intensity, _color.b * intensity);
  }

  /**
   * CHR-2 (GDD §8.2): gear feedback on every soldier-class body. magnet01 → helmet rings glow purple
   * (1.5 Hz pulse); armor01 → blue shoulder glint (moving sweep). Uniform writes only (no recompiles),
   * allocation-free; squad.js drives it from gear:start / gear:end / armor:change / level:start.
   */
  setGearGlow(magnet01, armor01) {
    this._look.uMagnet.value = magnet01 > 0 ? (magnet01 < 1 ? magnet01 : 1) : 0;
    this._look.uArmor.value = armor01 > 0 ? (armor01 < 1 ? armor01 : 1) : 0;
  }

  /** MaterialLibrary-backed standard material when render exists (shared cache), else an owned one. */
  _standard(hex, opts) {
    const ml = this.ctx && this.ctx.render ? this.ctx.render.materials : null;
    if (ml && typeof ml.standard === 'function') {
      try { const m = ml.standard(hex, opts); if (m) return m; } catch (_) { /* fall through to a local material */ }
    }
    const m = new MeshStandardMaterial({
      color: hex,
      roughness: opts && opts.roughness !== undefined ? opts.roughness : PALETTE.material.cloth.roughness,
      metalness: opts && opts.metalness !== undefined ? opts.metalness : 0,
      vertexColors: !!(opts && opts.vertexColors),
    });
    this._ownedMaterials.push(m);
    return m;
  }

  /** HDR unlit material (boss core): MaterialLibrary.hdrBasic when render exists, else an owned toneMapped:false basic. */
  _hdrBasic(hex, intensity) {
    _color.setHex(hex);
    const r = _color.r * intensity, g = _color.g * intensity, b = _color.b * intensity;
    const ml = this.ctx && this.ctx.render ? this.ctx.render.materials : null;
    if (ml && typeof ml.hdrBasic === 'function') {
      try { const m = ml.hdrBasic(r, g, b); if (m) return m; } catch (_) { /* fall through to a local material */ }
    }
    const m = new MeshBasicMaterial({ toneMapped: false });
    m.color.setRGB(r, g, b, LinearSRGBColorSpace);
    this._ownedMaterials.push(m);
    return m;
  }

  /** Owned emissive detail material (LED, lens, cross, headlights): one per call so owners may animate it. */
  _glow(hex, intensity) {
    const m = new MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: intensity > 0 ? intensity : PALETTE.props.windowLitEmissive, roughness: PALETTE.material.glass.roughness, metalness: 0 });
    this._ownedMaterials.push(m);
    return m;
  }

  /**
   * Geometry for a single (non-instanced) character Mesh: shares the class vertex buffers and adds
   * constant per-vertex iAnim/iState so the character shader renders it as one body with the given gait.
   */
  _singleCharacterGeometry(classId, speed, phase) {
    const base = this.geo[classId];
    const g = new BufferGeometry();
    g.setIndex(base.index);
    for (const name in base.attributes) g.setAttribute(name, base.attributes[name]);
    const n = base.attributes.position.count;
    const anim = new Float32Array(n * 4);
    const state = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      anim[i * 4] = phase; anim[i * 4 + 1] = speed; anim[i * 4 + 2] = IANIM_NEVER; anim[i * 4 + 3] = IANIM_NEVER;
      state[i * 4] = 0; state[i * 4 + 1] = 1; state[i * 4 + 2] = 1; state[i * 4 + 3] = 1;
    }
    g.setAttribute('iAnim', new BufferAttribute(anim, 4));
    g.setAttribute('iState', new BufferAttribute(state, 4));
    g.boundingBox = base.boundingBox.clone();
    g.boundingSphere = base.boundingSphere.clone();
    g.name = classId + '.single';
    this._ownedGeometries.push(g);
    return g;
  }

  /** Character body Mesh for a troop variant (character material + matching depth material). */
  _troopBody(classId) {
    const gait = TROOP_GAIT[classId];
    const body = new Mesh(this._singleCharacterGeometry(classId, gait.speed, gait.phase), this.makeCharacterMaterial(classId));
    body.name = 'body';
    body.customDepthMaterial = this.makeCharacterDepthMaterial(classId);
    return body;
  }

  /**
   * CHR-6: flat additive ground ring under a troop (troop colour identity inside the blob); 'ring' child,
   * no shadow, no depth write. One owned material per troop (troops.js may fade it).
   */
  _ring(hex, scale) {
    const x = DIMS.troopExtras;
    const m = new MeshBasicMaterial({ color: hex, transparent: true, opacity: x.ringOpacity, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    m.name = 'troop.ring';
    this._ownedMaterials.push(m);
    const ring = new Mesh(this.geo.troopRing, m);
    ring.name = 'ring';
    ring.position.y = x.ringY;
    if (scale !== 1) ring.scale.set(scale, 1, scale);
    ring.renderOrder = 1;
    return ring;
  }

  /** Invisible named marker Mesh (muzzle / nozzle / barrel tips that troops.js reads with getWorldPosition). */
  _marker(name, x, y, z) {
    const m = new Mesh(this.geo.marker, this._standard(PALETTE.soldier.rifle, PALETTE.material.metal));
    m.name = name;
    m.position.set(x, y, z);
    m.visible = false;
    return m;
  }

  /**
   * Troop meshes (ARCH §6.4 / §6.6; CHR-6 readability). Accepts 'sniper' | 'troop.sniper' etc. Returns a
   * Group facing −Z at yaw 0, feet at y = 0 (built at scale 1; troops.js applies TROOPS[k].scale), with the
   * named children troops.js animates: 'discs' (drone rotor blur), 'wheels' (APC running gear, merged),
   * 'cross' (medic), 'ring' (additive ground ring: sniper / medic / flamer), 'barrel'/'nozzle' muzzle
   * markers and the emissive 'led' / 'lens' / 'headlights' parts (each with its own material). The
   * flamer's tanks are merged into its body. Draw calls: sniper 4, medic 3, flamer 2, drone 3, APC 3.
   */
  buildTroopMesh(id) {
    const key = troopKey(id);
    const g = new Group();
    g.name = 'troop.' + key;
    switch (key) {
      case 'sniper': {
        const lift = TROOPS.sniper.crateH + DIMS.troopExtras.palletH;     // pallet + crate perch
        const body = this._troopBody('sniper');
        body.position.y = lift;
        const crate = new Mesh(this.geo.sniperCrate, this._standard(0xffffff, { vertexColors: true, roughness: PALETTE.material.cloth.roughness, metalness: 0 }));
        crate.name = 'crate';
        const lens = new Mesh(this.geo.sniperLens, this._glow(PALETTE.troop.sniperLens, DIMS.troopExtras.ledEmissive));
        lens.name = 'lens';
        lens.position.y = lift;
        weaponTip('sniper', _tip);
        g.add(body, crate, lens, this._ring(PALETTE.troop.sniperLens, DIMS.troopExtras.sniperRing), this._marker('barrel', _tip.x, _tip.y + lift, _tip.z));
        break;
      }
      case 'medic': {
        const body = this._troopBody('medic');
        const cross = new Mesh(this.geo.medicCross, this._glow(PALETTE.troop.medicCross));
        cross.name = 'cross';                                              // helmet top + pack top + pack back
        g.add(body, cross, this._ring(PALETTE.ui.success, 1));
        break;
      }
      case 'flamer': {
        const body = this._troopBody('flamer');                            // fuel tanks are part of the body
        weaponTip('flamer', _tip);
        g.add(body, this._ring(PALETTE.troop.flame, 1), this._marker('nozzle', _tip.x, _tip.y, _tip.z));
        break;
      }
      case 'drone': {
        const dd = DIMS.drone;
        const x = DIMS.troopExtras;
        const metal = { vertexColors: true, roughness: PALETTE.material.metal.roughness, metalness: PALETTE.material.metal.metalness };
        const body = new Mesh(this.geo.drone, this._standard(0xffffff, metal));
        body.name = 'body';
        const discMat = new MeshBasicMaterial({ color: PALETTE.fx.white, transparent: true, opacity: x.discOpacity, depthWrite: false });
        discMat.name = 'troop.droneDiscs';
        this._ownedMaterials.push(discMat);
        const discs = new Mesh(this.geo.droneDiscs, discMat);
        discs.name = 'discs';
        discs.position.y = 0.11;
        discs.renderOrder = 1;
        const led = new Mesh(this.geo.droneLed, this._glow(PALETTE.troop.droneLed, x.ledEmissive));
        led.name = 'led';
        led.position.set(0, dd.bodyH * 0.62 + dd.bodyH * 0.35 + 0.025, 0.04);   // on the canopy top (seen from the chase camera)
        g.add(body, discs, led, this._marker('barrel', 0, -dd.bodyH / 2 - 0.04, -dd.bodyD / 2 - dd.gunL + 0.08));
        break;
      }
      case 'apc': {
        const a = DIMS.apc;
        const hull = new Mesh(this.geo.apc, this._standard(0xffffff, { vertexColors: true, roughness: PALETTE.material.car.roughness, metalness: PALETTE.material.car.metalness }));
        hull.name = 'hull';
        const wheels = new Mesh(this.geo.apcWheels, this._standard(0xffffff, { vertexColors: true, roughness: PALETTE.material.rubber.roughness, metalness: PALETTE.material.rubber.metalness }));
        wheels.name = 'wheels';
        wheels.userData.merged = true;                                     // six wheels in one mesh: troops.js does not spin it
        const lights = new Mesh(this.geo.apcLight, this._glow(PALETTE.troop.apcLight, 1.5));
        lights.name = 'headlights';
        const y0 = a.wheelR - 0.1;
        lights.position.set(0, y0 + a.h * 0.55, -a.l * 0.5 - 0.02);
        g.add(hull, wheels, lights, this._marker('barrel', 0, y0 + a.h + a.turretH * 0.6, 0.2 - a.turretW * 0.45 - a.gunL));
        break;
      }
      default:
        throw new Error('models: unknown troop id "' + id + '"');
    }
    g.traverse((o) => { if (o.isMesh) { o.castShadow = o.visible && !(o.material && o.material.transparent); o.receiveShadow = false; } });
    return g;
  }

  /**
   * Boss rig (ARCH §6.4 / §6.8): Group (origin at the feet, facing +Z, BOSSES.rigHeight tall) with named
   * children torso, head, jaw, armL, armR, legL, legR (Bones of the one 'skin' SkinnedMesh, CHR-11), core, plate0–3,
   * shield + chain0–1 (Colossus). Limb/jaw joints have their origin at the joint; head/arms/core/plates/shield hang under the torso.
   * r5b: three draws per rig — 'skin' (body), 'armour' (plates + chains), 'glow' (eyes + sacs + core); core, plates and chains
   * are Bones (a plate is hidden by scale 0). Rigs of one archetype (the Hulk Twins) share the merged geometries.
   * hulkTwins / colossusPrime resolve to their base. Every call builds a new, independent rig.
   */
  buildBossRig(archetype) {
    if (!this._rigFactory) this._rigFactory = new BossRigFactory(this);
    return this._rigFactory.build(archetype);
  }

  /** Disposes every geometry and every material this library created (MaterialLibrary caches are render's). */
  dispose() {
    for (const k in this.geo) { if (this.geo[k] && this.geo[k].dispose) this.geo[k].dispose(); }
    this.geo = {};
    this.stats = {};
    for (const m of this._materials.values()) m.dispose();
    for (const m of this._depthMaterials.values()) m.dispose();
    this._materials.clear();
    this._depthMaterials.clear();
    this._uniforms.clear();
    for (let i = 0; i < this._ownedMaterials.length; i++) this._ownedMaterials[i].dispose();
    this._ownedMaterials.length = 0;
    for (let i = 0; i < this._ownedGeometries.length; i++) this._ownedGeometries[i].dispose();
    this._ownedGeometries.length = 0;
    this._rigFactory = null;
    this._initialised = false;
  }
}

// ---------------------------------------------------------------------------------------------
// CharacterInstances (ARCH §6.4): one InstancedMesh per character pool with iAnim / iState
// ---------------------------------------------------------------------------------------------

/**
 * Kept as the attribute's clearUpdateRanges(): WebGLAttributes calls it after every upload, and
 * emptying the array would make the next frame re-push (and V8 may re-allocate the backing store).
 * With a single persistent range record per attribute the array never changes after the first commit.
 */
function keepUpdateRanges() {}

/** Points `attr` at one persistent [0, count) update range (three's addUpdateRange allocates per call). */
function commitRange(attr, range, count) {
  const ranges = attr.updateRanges;
  if (ranges.length !== 1 || ranges[0] !== range) { ranges.length = 0; ranges.push(range); }
  range.start = 0;
  range.count = count;
  attr.needsUpdate = true;
}

export class CharacterInstances {
  /**
   * @param {object} ctx
   * @param {string} classId 'soldier' | 'walker' | 'runner' | 'crawler' | 'brute' | 'spitter' (troop classes allowed)
   * @param {number} capacity High-tier capacity (never grows)
   * @param {{castShadow?:boolean, receiveShadow?:boolean}} [opts]
   * The mesh is NOT added to the scene (owners add it); it ships with the class material and the
   * matching customDepthMaterial, count = 0, frustumCulled = false, DynamicDrawUsage everywhere.
   */
  constructor(ctx, classId, capacity, opts) {
    this.ctx = ctx;
    this.classId = classId;
    this.capacity = capacity | 0;
    this.count = 0;
    /** Swap-remove notification: onMove(from, to) — the instance that lived at `from` now lives at `to`. */
    this.onMove = null;
    const models = ctx ? ctx.models : null;
    if (!models || !models.geo || !models.geo[classId]) {
      throw new Error('models: CharacterInstances needs ctx.models.geo.' + classId + ' (ModelLibrary.init first)');
    }
    const base = models.geo[classId];
    // Per-pool geometry: shares the class vertex buffers, owns its instanced attributes.
    const g = new BufferGeometry();
    g.setIndex(base.index);
    for (const name in base.attributes) g.setAttribute(name, base.attributes[name]);
    g.boundingBox = base.boundingBox.clone();
    g.boundingSphere = base.boundingSphere.clone();
    g.name = classId + '.instances';
    const anim = new InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    const state = new InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    anim.setUsage(DynamicDrawUsage);
    state.setUsage(DynamicDrawUsage);
    const aa = anim.array, sa = state.array;
    for (let i = 0; i < this.capacity; i++) {
      aa[i * 4] = 0; aa[i * 4 + 1] = 1; aa[i * 4 + 2] = IANIM_NEVER; aa[i * 4 + 3] = IANIM_NEVER;
      sa[i * 4] = 0; sa[i * 4 + 1] = 1; sa[i * 4 + 2] = 1; sa[i * 4 + 3] = 1;
    }
    g.setAttribute('iAnim', anim);
    g.setAttribute('iState', state);
    this.geometry = g;
    this.attrs = { iAnim: anim, iState: state };
    this._anim = aa;
    this._state = sa;
    const mesh = new InstancedMesh(g, models.makeCharacterMaterial(classId), this.capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.customDepthMaterial = models.makeCharacterDepthMaterial(classId);
    mesh.castShadow = !!(opts && opts.castShadow);
    mesh.receiveShadow = !!(opts && opts.receiveShadow);
    mesh.name = 'characters.' + classId;
    this.mesh = mesh;
    this._matrix = mesh.instanceMatrix.array;
    // persistent update-range records (one per uploaded attribute) that three never clears (see keepUpdateRanges)
    this._rangeMatrix = { start: 0, count: 0 };
    this._rangeAnim = { start: 0, count: 0 };
    this._rangeState = { start: 0, count: 0 };
    mesh.instanceMatrix.clearUpdateRanges = keepUpdateRanges;
    anim.clearUpdateRanges = keepUpdateRanges;
    state.clearUpdateRanges = keepUpdateRanges;
  }

  /** Allocates the next dense index with default anim/state and a zero-scale matrix, or −1 when full. */
  alloc() {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    const a = this._anim, s = this._state, o = i * 4;
    a[o] = 0; a[o + 1] = 1; a[o + 2] = IANIM_NEVER; a[o + 3] = IANIM_NEVER;
    s[o] = 0; s[o + 1] = 1; s[o + 2] = 1; s[o + 3] = 1;
    // zero-scale matrix until the owner writes one (never flashes an identity body at the origin)
    const m = this._matrix, mo = i * 16;
    for (let k = 0; k < 15; k++) m[mo + k] = 0;
    m[mo + 15] = 1;
    this.mesh.count = this.count;
    return i;
  }

  /**
   * Frees index i by swap-remove (matrix + both attributes of the last instance move into i); calls
   * onMove(last, i) synchronously when another instance moved. Out-of-range indices are ignored.
   */
  free(i) {
    if (i < 0 || i >= this.count) return;
    const last = this.count - 1;
    if (i !== last) {
      const m = this._matrix, a = this._anim, s = this._state;
      const mo = i * 16, ml = last * 16, o = i * 4, ol = last * 4;
      for (let k = 0; k < 16; k++) m[mo + k] = m[ml + k];
      for (let k = 0; k < 4; k++) { a[o + k] = a[ol + k]; s[o + k] = s[ol + k]; }
    }
    this.count = last;
    this.mesh.count = last;
    if (i !== last && this.onMove) this.onMove(last, i);
  }

  /** Frees everything at once (no onMove calls); allocation-free. */
  clear() {
    this.count = 0;
    this.mesh.count = 0;
  }

  /**
   * Composes T(x,y,z) · Ry(yaw) · Rz(roll) · Rx(pitchTopple) · S(scale) straight into instanceMatrix.
   * Positive pitch tips the body toward its own +Z (backward for a −Z-facing character); `roll` is the
   * optional GDD §3.1 lean (6° into lateral movement). No allocation.
   */
  writeMatrix(i, x, y, z, yaw, pitchTopple, scale, roll = 0) {
    const m = this._matrix, o = i * 16;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitchTopple), sp = Math.sin(pitchTopple);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    // R = Ry · Rz · Rx (column-major)
    m[o] = cy * cr * scale;
    m[o + 1] = sr * scale;
    m[o + 2] = -sy * cr * scale;
    m[o + 3] = 0;
    m[o + 4] = (-cy * sr * cp + sy * sp) * scale;
    m[o + 5] = cr * cp * scale;
    m[o + 6] = (sy * sr * cp + cy * sp) * scale;
    m[o + 7] = 0;
    m[o + 8] = (cy * sr * sp + sy * cp) * scale;
    m[o + 9] = -cr * sp * scale;
    m[o + 10] = (-sy * sr * sp + cy * cp) * scale;
    m[o + 11] = 0;
    m[o + 12] = x;
    m[o + 13] = y;
    m[o + 14] = z;
    m[o + 15] = 1;
  }

  /** iAnim.z = hit time (seconds, same clock as render.uniforms.uTime). */
  setHit(i, nowSec) { this._anim[i * 4 + 2] = nowSec; }
  /** iAnim.w = fire time (recoil, soldier classes). */
  setFire(i, nowSec) { this._anim[i * 4 + 3] = nowSec; }
  /** iState.x = death progress 0..1 (see the header for the per-class convention). */
  setDeath(i, t01) { this._state[i * 4] = t01; }
  /** iAnim.y = walk speed factor (1 class gait; 0 freezes the limbs in the rest pose). */
  setSpeed(i, v) { this._anim[i * 4 + 1] = v; }
  /** iState.yzw = diffuse tint multiplier (1,1,1 neutral; > 1 brightens, e.g. burning orange). */
  setTint(i, r, g, b) { const o = i * 4; this._state[o + 1] = r; this._state[o + 2] = g; this._state[o + 3] = b; }
  /** iAnim.x = walk clock offset in seconds (per-instance variety). */
  setPhase(i, p) { this._anim[i * 4] = p; }

  /**
   * Once per frame: uploads [0, count) of the matrix and both attributes. Always uploads (owners may
   * write instanceMatrix.array directly, e.g. squad's roll-aware TRS); allocation-free (persistent
   * update ranges instead of addUpdateRange).
   */
  commit() {
    const n = this.count;
    if (n === 0) return;
    commitRange(this.mesh.instanceMatrix, this._rangeMatrix, n * 16);
    commitRange(this.attrs.iAnim, this._rangeAnim, n * 4);
    commitRange(this.attrs.iState, this._rangeState, n * 4);
  }

  /** Removes the mesh from its parent and disposes the per-pool geometry (class buffers belong to ModelLibrary). */
  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.geometry.dispose();
    this.mesh.dispose();
    this.onMove = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Boss rigs (ARCH §6.4 / §6.8, GDD §7): CPU-animated Groups with named children
// ---------------------------------------------------------------------------------------------
//
// buildBossRig(archetype) → Group 'boss.<archetype>' (origin at the feet, faces +Z, BOSSES.rigHeight tall;
// boss.js owns its position / rotation.y / collapse rotation.x)
//   └─ 'body' Group (identity at rest; animateRig uses it for lean/collapse, boss.js leaves it alone)
//        ├─ 'skin'                              SkinnedMesh: legs + torso + arms + head + jaw in ONE draw (CHR-11; the shadow caster)
//        ├─ 'armour'                            SkinnedMesh: plate0–3 + chain0–1 in ONE draw (r5b; metal material, no shadow)
//        ├─ 'glow'                              SkinnedMesh: eyes + sacs + core in ONE draw (r5b; HDR basic, uGlowCol per group)
//        ├─ 'legL' 'legR'                       Bone, origin at the hip joint
//        └─ 'torso'                             Bone, origin at the hip (lean pivot)
//             ├─ 'armL' 'armR'                  Bone, origin at the shoulder; rest rotation.x = −uArmRest (reach)
//             │    └─ 'chain0' / 'chain1'       Colossus: Bone, link stack hanging from the wrist
//             ├─ 'head' → 'jaw'                 Bone, origin at the neck / jaw hinge
//             ├─ 'core'                         Bone at the core centre, y = BOSSES.coreY (aim point; scale = pulse)
//             ├─ 'plate0'..'plate3'             Bone per armour plate (fly off at phase 2; scale 0 hides one)
//             └─ 'shield'                       Colossus only: Mesh, hidden until raised
// Signs (+Z-facing): rotation.x < 0 raises an arm / leg toward the squad; torso rotation.x > 0 leans
// toward the squad; jaw rotation.x > 0 opens it; group rotation.x > 0 falls toward the squad.
// Emissive pieces (eyes, acid sacs, core) are unlit HDR basic so boss.js's per-rig emissive (hit flash / rage on the cloned
// body and armour materials) never dims them. The named joints, the core, the plates and the chains are Bones (same names,
// origins and rest transforms as the former part meshes) and every vertex is bound rigidly (weight 1) to its node, so
// transforms boss.js writes to rig.parts[...] / plates / chains move exactly what they moved before (CHR-11 skincheck; r5b:
// docs/build/r5b-boss-draws.md). rig.skin / rig.armour / rig.glow / rig.skeleton reference the three draws and their skeleton.
// group.userData.rig = { archetype, baseModel, scale, height, body, torso, head, jaw, armL, armR, legL, legR,
//   core, plates[], chains[], shield, material, glowMaterial, armourMaterial, coreMaterial (= glowMaterial; the core is
//   glow group 2), shieldMaterial, skin, armour, glow, skeleton, limb, gaitFreq, rest:{ name → { px, py, pz, rx, ry, rz } }, plateDirs[] }.

const RIG_ARCH_FALLBACK = 'hulk';

/** Resolves `base` chains (hulkTwins → hulk, colossusPrime → colossus) into a merged archetype view. */
function resolveArchetype(name) {
  const arch = BOSSES.archetypes[name];
  if (!arch) throw new Error('models: unknown boss archetype "' + name + '"');
  if (!arch.base) return arch;
  const base = resolveArchetype(arch.base);
  const merged = {};
  for (const k in base) merged[k] = base[k];
  for (const k in arch) merged[k] = arch[k];
  return merged;
}

/** Colossus parts (−Z facing, raw metres): a stone-and-iron giant with an open chest cavity for the core. */
function colossusParts() {
  const d = DIMS.colossus;
  const c = PALETTE.boss;
  const parts = [];
  const legTop = d.legLen;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.LEG_L : PART.LEG_R;
    const px = s * d.hipHalf;
    const piv = [px, legTop, 0];
    parts.push(P(box(d.legW, d.legLen - 0.3, d.legW, px, 0.3 + (d.legLen - 0.3) / 2, 0), part, piv, c.skin));
    parts.push(P(box(d.legW + 0.3, 0.3, d.legW + 0.5, px, 0.15, -0.1), part, piv, c.plates));           // iron boots
    parts.push(P(box(d.legW + 0.1, 0.5, d.legW + 0.1, px, legTop - 0.8, 0), part, piv, c.plates));     // knee guard
  }
  const torsoPiv = [0, legTop, 0];
  const torsoY = legTop + d.torsoH / 2;
  parts.push(P(box(d.torsoW, 0.7, d.torsoD, 0, legTop + d.torsoH - 0.35, 0), PART.TORSO, torsoPiv, c.skin));                    // chest beam
  parts.push(P(box((d.torsoW - d.cavityW) / 2, d.cavityH, d.torsoD, -(d.torsoW + d.cavityW) / 4, torsoY, 0), PART.TORSO, torsoPiv, c.skin));
  parts.push(P(box((d.torsoW - d.cavityW) / 2, d.cavityH, d.torsoD, (d.torsoW + d.cavityW) / 4, torsoY, 0), PART.TORSO, torsoPiv, c.skin));
  parts.push(P(box(d.torsoW, d.cavityH, d.torsoD * 0.35, 0, torsoY, d.torsoD * 0.33), PART.TORSO, torsoPiv, c.plates));      // back plate
  parts.push(P(box(d.torsoW * 0.9, 0.6, d.torsoD + 0.2, 0, legTop + 0.3, 0), PART.TORSO, torsoPiv, c.plates));               // belt
  parts.push(P(box(d.torsoW * 1.15, 0.5, d.torsoD * 0.6, 0, legTop + d.torsoH + 0.1, 0.1), PART.TORSO, torsoPiv, c.plates));   // yoke
  const shoulderY = legTop + d.torsoH - 0.2;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.ARM_L : PART.ARM_R;
    const px = s * d.shoulderHalf;
    const piv = [px, shoulderY, 0];
    parts.push(P(box(d.armW + 0.4, 0.6, d.armW + 0.4, px, shoulderY + 0.1, 0), part, piv, c.plates));                        // pauldron
    parts.push(P(box(d.armW, d.armLen * 0.5, d.armW, px, shoulderY - d.armLen * 0.25, 0), part, piv, c.skin));
    parts.push(P(box(d.armW + 0.2, d.armLen * 0.45, d.armW + 0.2, px, shoulderY - d.armLen * 0.72, 0), part, piv, c.skin));
    parts.push(P(box(d.armW + 0.3, 0.7, d.armW + 0.3, px, shoulderY - d.armLen - 0.1, 0), part, piv, c.plates));             // gauntlet fist
  }
  const ny = legTop + d.torsoH + 0.3;
  const headPiv = [0, ny, 0];
  parts.push(P(box(d.headW, d.headH, d.headW, 0, ny + d.headH / 2, -0.1), PART.HEAD, headPiv, c.skin));
  parts.push(P(box(d.headW + 0.2, 0.25, d.headW * 0.6, 0, ny + d.headH - 0.05, -0.2), PART.HEAD, headPiv, c.plates));        // visor brow
  for (let s = -1; s <= 1; s += 2) {
    parts.push(P(box(0.22, 0.12, 0.06, s * 0.24, ny + d.headH * 0.55, -0.1 - d.headW / 2), PART.HEAD, headPiv, c.eyes, true));
  }
  parts.push(P(box(d.headW * 0.8, 0.22, d.headW * 0.7, 0, ny + 0.05, -0.18), PART.JAW, [0, ny + 0.15, -0.1 + d.headW * 0.3], c.skin));
  return parts;
}

/** Unscaled zombie parts (raw metres) for a zombie class or a boss base model. */
function rawZombieParts(base) {
  switch (base) {
    case 'walker': return bipedZombieParts(DIMS.walker, PALETTE.zombie.walker);
    case 'runner': return bipedZombieParts(DIMS.runner, PALETTE.zombie.runner);
    case 'crawler': return crawlerParts();
    case 'brute': return bruteParts();
    case 'spitter': return spitterParts();
    default: throw new Error('models: unknown boss base model "' + base + '"');
  }
}

// Boss silhouette art (CHR-1 / CHR-5; GDD §7 "Hulk: 3.2× brute, car-door shield, hinged jaw", "Spitter Queen:
// bloated, 4 arms, pulsing sacs", "Juggernaut: armour plates"). Raw-metre proportions applied BEFORE the uniform
// BOSSES.rigHeight normalisation (art proportions, not GDD tuning; colours come from PALETTE).
//   reshape: legK leg length factor, legThick leg x/z thickness, hipOut extra hip spread (m), torsoX / torsoZ torso
//   width / depth, armOut extra shoulder spread (m), armThick arm x/z thickness, headK head scale, headFwd (m, −Z).
const BOSS_ART = Object.freeze({
  hulk: {
    head: { w: 0.5, h: 0.42, d: 0.46, z: -0.14, sink: 0.08 },
    // x / z relative to the left forearm; lean = extra top-back tilt on top of cancelling the arm's rest reach
    door: { w: 0.95, h: 1.0, t: 0.065, x: -0.25, z: -0.26, yaw: 0.45, lean: 0.12 },
  },
  queen: { legK: 0.7, legThick: 1.5, hipOut: 0.06, torsoX: 1.6, torsoZ: 1.6, armOut: 0.05, armThick: 1.4, headK: 1.25, headFwd: 0.1 },
  juggernaut: { legK: 0.75, legThick: 1.5, hipOut: 0.04, torsoX: 1.4, torsoZ: 1.25, armOut: 0.07, armThick: 1.5, headK: 1.05, headFwd: 0.02 },
  core: { recess: 0.2, rimR: 1.08, rimTube: 0.3 },      // × core radius: sphere centre behind the chest surface, socket rim torus
});

const _mA = new Matrix4();
const _mB = new Matrix4();

/** _mA = T(c + t) · S(s) · T(−c): scale about c, then move by t (init-time). */
function scaleMove(sx, sy, sz, cx, cy, cz, tx, ty, tz) {
  _mA.makeTranslation(-cx, -cy, -cz);
  _mB.makeScale(sx, sy, sz);
  _mA.premultiply(_mB);
  _mB.makeTranslation(cx + tx, cy + ty, cz + tz);
  _mA.premultiply(_mB);
  return _mA;
}

/** Applies an affine matrix to a part's geometry and maps its pivot through it (the pivot array is replaced, never mutated). */
function xformPart(p, m) {
  p.geo.applyMatrix4(m);
  _va.set(p.pivot[0], p.pivot[1], p.pivot[2]).applyMatrix4(m);
  p.pivot = [_va.x, _va.y, _va.z];
}

/** Pivot of the first part with this id (null when absent). */
function pivotOf(parts, id) {
  for (let i = 0; i < parts.length; i++) if (parts[i].part === id) return parts[i].pivot;
  return null;
}

/**
 * Non-uniform archetype proportions (CHR-5) on a raw biped part list: shorter, thicker legs, a wider /
 * deeper torso that drops onto the new hips, arms moved out to the wider shoulders and thickened, the
 * head scaled about the neck. Every piece of one part id gets the same transform, so pivots stay coherent.
 */
function reshapeBiped(parts, k, legLen, shoulderHalf) {
  const drop = legLen * (1 - k.legK);
  const neck = pivotOf(parts, PART.HEAD);
  const nx = neck ? neck[0] : 0, ny = neck ? neck[1] : legLen, nz = neck ? neck[2] : 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const side = p.pivot[0] < 0 ? -1 : 1;
    switch (p.part) {
      case PART.LEG_L: case PART.LEG_R:
        xformPart(p, scaleMove(k.legThick, k.legK, k.legThick, p.pivot[0], 0, 0, side * k.hipOut, 0, 0));
        break;
      case PART.TORSO:
        xformPart(p, scaleMove(k.torsoX, 1, k.torsoZ, 0, legLen, 0, 0, -drop, 0));
        break;
      case PART.ARM_L: case PART.ARM_R:
        xformPart(p, scaleMove(k.armThick, 1, k.armThick, p.pivot[0], 0, p.pivot[2], side * (shoulderHalf * (k.torsoX - 1) + k.armOut), -drop, 0));
        break;
      case PART.HEAD: case PART.JAW:
        xformPart(p, scaleMove(k.headK, k.headK, k.headK, nx, ny, nz, 0, -drop, -k.headFwd));
        break;
      default: break;
    }
  }
  return parts;
}

/**
 * Car door (CHR-1, GDD §7 "car-door shield"): panel, window with frame and pillars, belt-line trim, handle,
 * rust patches, bullet holes and the strap that ties it to the forearm. Built facing −Z, centred, then
 * pitched / yawed and moved to (cx, cy, cz); every piece joins `part` (merged into the arm mesh).
 */
function carDoorParts(parts, part, pivot, cx, cy, cz, yaw, pitch) {
  const a = BOSS_ART.hulk.door;
  const W = a.w, Hd = a.h, T = a.t;
  const pr = PALETTE.props;
  const paint = pr.car[3];
  const fz = -T / 2;                                   // front face
  const pieces = [
    [box(W, Hd * 0.56, T, 0, -Hd * 0.22, 0), paint],                                 // lower panel
    [box(W * 0.72, Hd * 0.34, T * 0.5, -W * 0.06, Hd * 0.25, 0), pr.glass],          // window
    [box(W * 0.84, 0.07, T, -W * 0.05, Hd * 0.45, 0), paint],                        // window top rail
    [box(0.09, Hd * 0.42, T, W / 2 - 0.045, Hd * 0.24, 0), paint],                   // rear pillar
    [box(0.09, Hd * 0.5, T, -W / 2 + 0.13, Hd * 0.24, 0, 0, 0, 0.32), paint],        // slanted front pillar
    [box(W * 1.01, 0.045, T * 1.4, 0, Hd * 0.07, 0), PALETTE.soldier.rifle],         // belt-line trim
    [box(W * 0.9, 0.025, 0.012, 0, -Hd * 0.12, fz - 0.006), pr.rust],                // crease
    [box(0.17, 0.05, 0.05, W * 0.3, -Hd * 0.02, fz - 0.025), PALETTE.soldier.rifle], // handle
    [box(0.3, 0.22, 0.012, -W * 0.2, -Hd * 0.34, fz - 0.006), pr.rust],              // rust patches
    [box(0.18, 0.13, 0.012, W * 0.28, -Hd * 0.4, fz - 0.006), pr.rust],
    [box(0.14, 0.09, 0.012, -W * 0.36, -Hd * 0.06, fz - 0.006), pr.rust],
    [box(0.035, 0.035, 0.012, W * 0.05, -Hd * 0.27, fz - 0.007), pr.glass],          // bullet holes
    [box(0.035, 0.035, 0.012, W * 0.14, -Hd * 0.2, fz - 0.007), pr.glass],
    [box(0.035, 0.035, 0.012, -W * 0.04, -Hd * 0.35, fz - 0.007), pr.glass],
    [box(0.12, 0.08, 0.06, -W / 2 + 0.06, Hd * 0.12, fz - 0.03), pr.tyre],           // mirror stub
    [box(0.22, 0.55, 0.12, 0.05, -Hd * 0.05, T / 2 + 0.06), pr.rust],                // forearm strap
  ];
  for (let i = 0; i < pieces.length; i++) {
    const g = pieces[i][0];
    if (yaw !== 0) g.rotateY(yaw);                     // yaw first, then pitch: the arm's X rotation then cancels the pitch exactly
    if (pitch !== 0) g.rotateX(pitch);
    g.translate(cx, cy, cz);
    parts.push(P(g, part, pivot, pieces[i][1]));
  }
}

/** Hulk (brute base, CHR-1): boss head with heavy brow and a hinged, toothed jaw; pads, knuckles, belt; car-door shield. */
function hulkParts(parts) {
  const d = DIMS.brute;
  const c = PALETTE.boss;
  const teeth = PALETTE.road.edge;
  const legTop = d.legLen;
  const shoulderY = legTop + d.torsoH - 0.1;
  // the brute head and jaw are replaced by the boss head below
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].part === PART.HEAD || parts[i].part === PART.JAW) parts.splice(i, 1);
  const h = BOSS_ART.hulk.head;
  const ny = legTop + d.torsoH + 0.1;
  const hb = ny - h.sink;                               // head sunk into the traps (hunched, menacing)
  const headPiv = [0, ny, 0];
  const hz = h.z, front = hz - h.d / 2;
  parts.push(P(box(h.w, h.h, h.d, 0, hb + h.h / 2, hz), PART.HEAD, headPiv, c.skin));
  parts.push(P(box(h.w + 0.1, 0.13, 0.12, 0, hb + h.h * 0.74, front - 0.02), PART.HEAD, headPiv, c.skin));            // heavy brow
  parts.push(P(box(h.w * 0.5, 0.07, 0.1, 0, hb + h.h * 0.93, front + 0.06), PART.HEAD, headPiv, c.muscle !== undefined ? c.muscle : c.skin));   // scarred crown ridge
  for (let s = -1; s <= 1; s += 2) {
    parts.push(P(box(0.11, 0.05, 0.03, s * 0.12, hb + h.h * 0.52, front - 0.01), PART.HEAD, headPiv, c.eyes, true));   // eyes under the brow
    parts.push(P(box(0.06, 0.12, 0.08, s * (h.w / 2 + 0.02), hb + h.h * 0.55, hz + 0.02), PART.HEAD, headPiv, c.skin));   // ears
  }
  parts.push(P(box(0.36, 0.1, 0.05, 0, hb + 0.05, front + 0.04), PART.HEAD, headPiv, PALETTE.blood));                 // mouth (seen when the jaw opens)
  for (let k = -2; k <= 2; k++) parts.push(P(box(0.045, 0.06, 0.03, k * 0.065, hb + 0.07, front + 0.02), PART.HEAD, headPiv, teeth));   // upper teeth
  // hinged jaw (PART.JAW, hinge at the back of the mouth): an underbite block with lower teeth and tusks
  const jawPiv = [0, hb + 0.1, hz + 0.12];
  const jz = hz - 0.05, jd = h.d * 0.87, jFront = jz - jd / 2;
  parts.push(P(box(h.w * 0.84, 0.16, jd, 0, hb + 0.02, jz), PART.JAW, jawPiv, c.skin));
  parts.push(P(box(h.w * 0.6, 0.06, jd * 0.8, 0, hb - 0.08, jz + 0.03), PART.JAW, jawPiv, c.skin));                 // chin underside
  for (let k = -1; k <= 1; k++) parts.push(P(box(0.045, 0.06, 0.03, k * 0.07, hb + 0.13, jFront + 0.02), PART.JAW, jawPiv, teeth));
  for (let s = -1; s <= 1; s += 2) parts.push(P(box(0.065, 0.14, 0.055, s * 0.16, hb + 0.15, jFront + 0.025), PART.JAW, jawPiv, teeth));   // tusks
  // shoulder pads with spikes, forearm bands, knuckle plates
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.ARM_L : PART.ARM_R;
    const px = s * d.shoulderHalf;
    const piv = [px, shoulderY, 0];
    parts.push(P(box(0.52, 0.18, 0.5, px + s * 0.04, shoulderY + 0.25, 0), part, piv, c.plates));
    parts.push(P(box(0.4, 0.1, 0.38, px + s * 0.1, shoulderY + 0.12, 0), part, piv, c.plates));
    parts.push(P(cyl(0.004, 0.07, 0.2, 4, px + s * 0.02, shoulderY + 0.44, -0.1), part, piv, c.plates));
    parts.push(P(cyl(0.004, 0.07, 0.2, 4, px + s * 0.14, shoulderY + 0.42, 0.1), part, piv, c.plates));
    parts.push(P(box(d.armW + 0.14, 0.1, d.armD + 0.14, px, shoulderY - d.armLen * 0.52, 0), part, piv, c.plates));
    const fy = shoulderY - d.armLen - 0.05;
    parts.push(P(box(d.fist + 0.05, 0.1, 0.12, px, fy - d.fist / 2 + 0.04, -d.fist / 2 + 0.03), part, piv, c.plates));   // knuckles
    for (let k = -1; k <= 1; k++) parts.push(P(box(0.05, 0.06, 0.05, px + k * 0.11, fy - d.fist / 2 - 0.02, -d.fist / 2 + 0.03), part, piv, PALETTE.props.rust));
  }
  // belt with a buckle over the shorts
  const torsoPiv = [0, legTop, 0];
  parts.push(P(box(d.torsoW + 0.06, 0.14, d.torsoD + 0.08, 0, legTop + 0.3, 0), PART.TORSO, torsoPiv, c.plates));
  parts.push(P(box(0.24, 0.18, 0.05, 0, legTop + 0.3, -(d.torsoD + 0.08) / 2 - 0.02), PART.TORSO, torsoPiv, PALETTE.props.rust));
  // car-door shield strapped to the left forearm, angled out toward the squad
  const a = BOSS_ART.hulk.door;
  const px = -d.shoulderHalf;
  // pre-pitched by −uArmRest (raw space; the rig flip negates it) so the door stands upright, facing the squad, in the reach pose
  carDoorParts(parts, PART.ARM_L, [px, shoulderY, 0], px + a.x, shoulderY - d.armLen * 0.68, a.z, a.yaw, -ZOMBIES.brute.limb.uArmRest + a.lean);
}

/** Spitter Queen extras (CHR-5) on the reshaped spitter: egg-sac abdomen, sac crown, a readable lower arm pair with claws. */
function queenParts(parts) {
  const d = DIMS.spitter;
  const k = BOSS_ART.queen;
  const c = PALETTE.boss;
  const sacs = PALETTE.zombie.spitter.sacs;
  const legTop = d.legLen * k.legK;
  const torsoPiv = pivotOf(parts, PART.TORSO) || [0, legTop, 0];
  // abdomen behind the body (+Z is the back in raw space)
  parts.push(P(new SphereGeometry(0.42, 10, 8).scale(1, 0.85, 1.15).translate(0, legTop + 0.42, 0.42), PART.TORSO, torsoPiv, c.skin));
  parts.push(P(new SphereGeometry(0.3, 8, 6).scale(1.1, 0.8, 1).translate(0, legTop + 0.25, 0.78), PART.TORSO, torsoPiv, c.skin));
  // glowing sacs (glow material: pulse-able): crown behind the head, belly flanks, abdomen
  const sacList = [
    [-0.2, 1.38, 0.2, 0.12], [0, 1.47, 0.24, 0.15], [0.2, 1.38, 0.2, 0.12],
    [-0.5, 0.8, -0.28, 0.11], [0.5, 0.8, -0.28, 0.11],
    [-0.36, 0.98, 0.5, 0.14], [0.36, 0.98, 0.5, 0.14], [0, 0.74, 0.88, 0.16], [-0.3, 0.6, 0.7, 0.12], [0.3, 0.6, 0.7, 0.12],
  ];
  const yOff = legTop - 0.49;                           // authored for legTop = 0.49
  for (let i = 0; i < sacList.length; i++) {
    const s = sacList[i];
    parts.push(P(sphere(s[3], 8, 6, s[0], s[1] + yOff, s[2]), PART.TORSO, torsoPiv, sacs, true));
  }
  // lower arm pair (torso-fixed so it never detaches from the belly): shoulder → elbow → raised claws
  for (let s = -1; s <= 1; s += 2) {
    const a = [s * 0.5, legTop + 0.48, -0.12], e = [s * 0.86, legTop + 0.3, -0.42], h = [s * 0.82, legTop + 0.42, -0.82];
    parts.push(P(seg(a, e, 0.12, 0.12, 0.08), PART.TORSO, torsoPiv, c.skin));
    parts.push(P(seg(e, h, 0.1, 0.1, 0.06), PART.TORSO, torsoPiv, c.skin));
    parts.push(P(box(0.14, 0.12, 0.12, h[0], h[1], h[2]), PART.TORSO, torsoPiv, c.skin));
    for (let f = -1; f <= 1; f++) {
      parts.push(P(box(0.03, 0.03, 0.16, h[0] + f * 0.045, h[1] + 0.02 - Math.abs(f) * 0.02, h[2] - 0.12), PART.TORSO, torsoPiv, PALETTE.road.edge));
    }
    parts.push(P(sphere(0.06, 6, 4, e[0], e[1] + 0.06, e[2]), PART.TORSO, torsoPiv, sacs, true));   // elbow sac
  }
  // spiked crest along the skull
  const headPiv = pivotOf(parts, PART.HEAD);
  if (headPiv) {
    for (let i = 0; i < 3; i++) {
      parts.push(P(cyl(0.004, 0.05, 0.16, 4, (i - 1) * 0.08, headPiv[1] + 0.33 + (i === 1 ? 0.04 : 0), headPiv[2] + 0.04), PART.HEAD, headPiv, c.plates));
    }
  }
}

/** Juggernaut extras (CHR-5) on the raw walker, before the reshape: belt, knee guards, boots, gauntlets, face plate. */
function juggernautParts(parts) {
  const d = DIMS.walker;
  const c = PALETTE.boss;
  const h = d.hunch, ch = Math.cos(h), sh = Math.sin(h);
  const legTop = d.legLen;
  const torsoPiv = [0, legTop, 0];
  const belt = box(d.torsoW + 0.08, 0.09, d.torsoD + 0.08, 0, legTop + 0.06, 0);
  rotAbout(belt, 0, legTop, 0, h);
  parts.push(P(belt, PART.TORSO, torsoPiv, c.plates));
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.LEG_L : PART.LEG_R;
    const px = s * d.hipHalf;
    const piv = [px, legTop, 0];
    parts.push(P(box(d.legW + 0.06, 0.13, 0.08, px, d.legLen * 0.45, -d.legD / 2 - 0.03), part, piv, c.plates));    // knee guard
    parts.push(P(box(d.legW + 0.08, 0.11, d.legD + 0.16, px, 0.055, -0.05), part, piv, c.plates));                   // boot
  }
  const dyS = d.torsoH - 0.05;
  const shoulderY = legTop + dyS * ch, shoulderZ = dyS * sh;
  for (let s = -1; s <= 1; s += 2) {
    const part = s < 0 ? PART.ARM_L : PART.ARM_R;
    const px = s * d.shoulderHalf;
    parts.push(P(box(d.armW + 0.07, 0.17, d.armD + 0.07, px, shoulderY - d.armLen + 0.08, shoulderZ), part, [px, shoulderY, shoulderZ], c.plates));   // gauntlet
  }
  const ny = legTop + d.torsoH * ch, nz = d.torsoH * sh;
  const headY = ny + d.headH / 2 + 0.02, headZ = nz - 0.04;
  parts.push(P(box(d.headW + 0.04, d.headH * 0.28, 0.05, 0, headY - d.headH * 0.24, headZ - d.headD / 2 - 0.02), PART.HEAD, [0, ny, nz], c.plates));   // face plate
}

/**
 * Boss body from a zombie base model (raw metres, −Z facing): boss palette (skin → boss.skin, cloth →
 * boss.plates, the brute's muscle → boss.muscle, eyes → boss.eyes; the queen's sacs stay acid) plus the
 * archetype silhouette (CHR-1 / CHR-5): the Hulk's boss head, hinged toothed jaw, pads, knuckles, belt and
 * car-door shield; the Spitter Queen's bloated, sac-laden body on short legs with a second arm pair; the
 * Juggernaut's squat armoured frame. Pieces join the existing part ids, so the rig's mesh count is unchanged.
 */
function bossBodyParts(base) {
  const c = PALETTE.boss;
  const zc = PALETTE.zombie[base];
  const parts = rawZombieParts(base);
  const muscle = c.muscle !== undefined ? c.muscle : c.skin;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.emis) { if (base !== 'spitter') p.hex = c.eyes; }
    else if (p.hex === zc.skin) p.hex = c.skin;
    else if (p.hex === zc.cloth) p.hex = c.plates;
    else if (zc.muscle !== undefined && p.hex === zc.muscle) p.hex = muscle;
  }
  if (base === 'brute') {
    hulkParts(parts);
  } else if (base === 'spitter') {
    reshapeBiped(parts, BOSS_ART.queen, DIMS.spitter.legLen, DIMS.spitter.shoulderHalf);
    queenParts(parts);
  } else if (base === 'walker') {
    // Juggernaut: pauldrons, helmet and a chest cuirass in the plates colour (the 4 detachable plates are added by the factory)
    const d = DIMS.walker;
    const h = d.hunch, ch = Math.cos(h), sh = Math.sin(h);
    const dyS = d.torsoH - 0.05;
    const shoulderY = d.legLen + dyS * ch, shoulderZ = dyS * sh;
    for (let s = -1; s <= 1; s += 2) {
      const part = s < 0 ? PART.ARM_L : PART.ARM_R;
      const px = s * d.shoulderHalf;
      parts.push(P(box(d.armW + 0.08, 0.1, d.armD + 0.08, px + s * 0.02, shoulderY - 0.08, shoulderZ), part, [px, shoulderY, shoulderZ], c.plates));
    }
    const ny = d.legLen + d.torsoH * ch, nz = d.torsoH * sh;
    parts.push(P(box(d.headW + 0.05, d.headH * 0.42, d.headD + 0.05, 0, ny + d.headH, nz - 0.04), PART.HEAD, [0, ny, nz], c.plates));   // helmet, bottom edge above the eyes (visor slit)
    const plate = box(d.torsoW + 0.04, d.torsoH * 0.5, 0.05, 0, d.legLen + d.torsoH * 0.55, -d.torsoD / 2 - 0.03);
    rotAbout(plate, 0, d.legLen, 0, h);
    parts.push(P(plate, PART.TORSO, [0, d.legLen, 0], c.plates));
    juggernautParts(parts);
    reshapeBiped(parts, BOSS_ART.juggernaut, d.legLen, d.shoulderHalf);
  }
  return parts;
}

/** Max z (front, after flipParts) where the plane y = Y cuts the solid pieces of one part id; `fallback` when none does. */
function frontZAtParts(parts, id, Y, fallback) {
  let best = -Infinity;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.part !== id || p.emis) continue;
    const z = frontZAt(p.geo, Y, -Infinity);
    if (z > best) best = z;
  }
  return best === -Infinity ? fallback : best;
}

/** Plate geometry (CHR-1 / CHR-5): slab + raised centre + four rivets ('front'), or slab + crest ridge ('pauldron'). */
function plateGeometry(w, h, d, kind) {
  const geos = [new BoxGeometry(w, h, d)];
  if (kind === 'pauldron') {
    geos.push(new BoxGeometry(w * 0.86, h * 0.6, d * 0.24).translate(0, h * 0.75, 0));
    geos.push(new BoxGeometry(w * 0.96, h * 0.4, d * 0.9).translate(0, -h * 0.55, 0.02));
  } else {
    geos.push(new BoxGeometry(w * 0.78, h * 0.72, d * 0.6).translate(0, 0, d * 0.7));
    const r = Math.min(w, h) * 0.07;
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) geos.push(new BoxGeometry(r, r, d * 0.5).translate(sx * w * 0.43, sy * h * 0.4, d * 0.55));
    }
  }
  return mergeAll(geos, 'rig.plate.' + kind);
}

/**
 * Detachable armour plates (plate0–3, rig space, before the core socket is merged into the torso):
 * Juggernaut → two pauldrons on the shoulders and two tassets over the thighs (CHR-5); others → two
 * plates flanking the core socket and two below it, flush with the chest. Returns [{ x, y, z, w, h, d,
 * kind, rx, ry, rz, dir:[x, y, z] }].
 */
function plateLayout(baseModel, parts, coreR, H) {
  const R = DIMS.rig;
  const out = [];
  if (baseModel === 'walker') {
    for (let s = -1; s <= 1; s += 2) {
      const piv = pivotOf(parts, s < 0 ? PART.ARM_R : PART.ARM_L);   // after the flip ARM_L sits on +x
      const sx = piv ? (piv[0] < 0 ? -1 : 1) : s;
      const w = 0.19 * H, h = 0.075 * H, d = 0.17 * H;
      out.push({ x: (piv ? piv[0] : sx * 0.3 * H) + sx * 0.02 * H, y: (piv ? piv[1] : 0.7 * H) + 0.035 * H, z: piv ? piv[2] : 0, w, h, d,
        kind: 'pauldron', rx: 0, ry: 0, rz: -sx * 0.32, dir: [sx, 1.5, 0.6] });
    }
    for (let s = -1; s <= 1; s += 2) {
      const id = s < 0 ? PART.LEG_R : PART.LEG_L;
      const piv = pivotOf(parts, id);
      const sx = piv ? (piv[0] < 0 ? -1 : 1) : s;
      const w = 0.14 * H, h = 0.13 * H, d = 0.03 * H;
      const y = (piv ? piv[1] : 0.35 * H) - h * 0.5;
      const z = frontZAtParts(parts, id, y, 0.05 * H) + d * 0.6;
      out.push({ x: (piv ? piv[0] : sx * 0.1 * H) * 1.12, y, z, w, h, d, kind: 'front', rx: -0.14, ry: sx * 0.12, rz: 0, dir: [sx, 0.6, 1.2] });
    }
    return out;
  }
  const pw = R.plateW * H, ph = R.plateH * H, pd = R.plateD * H;
  const cy = BOSSES.coreY;
  const colossus = baseModel === 'colossus';             // the Colossus core sits in its cavity (no socket rim)
  const rimOut = colossus ? coreR : coreR * (BOSS_ART.core.rimR + BOSS_ART.core.rimTube);
  for (let i = 0; i < BOSSES.plates; i++) {
    const upper = i < 2;
    const s = (i % 2 === 0) ? -1 : 1;
    const x = upper ? s * (colossus ? coreR + pw * 0.55 : rimOut + pw * 0.5 + 0.01 * H) : s * pw * 0.56;
    const y = upper ? cy + ph * 0.25 : cy - rimOut - ph * (colossus ? 0.6 : 0.55);
    const z = frontZAtParts(parts, PART.TORSO, y, 0) + pd * 0.45;
    out.push({ x, y, z, w: pw, h: ph, d: pd, kind: 'front', rx: -0.08, ry: s * 0.18, rz: 0, dir: [s, 1.2, 1.0] });
  }
  return out;
}

/**
 * Builds one Mesh per part id (geometry re-based on the part's pivot, mesh.position = pivot) and one
 * HDR "glow" child per part that has emissive pieces. Returns Map partId → Mesh.
 */
function partMeshes(parts, material, glowMaterial, owned) {
  const byPart = new Map();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    let e = byPart.get(p.part);
    if (!e) { e = { pivot: p.pivot, solid: [], glow: [] }; byPart.set(p.part, e); }
    (p.emis ? e.glow : e.solid).push(p);
  }
  const out = new Map();
  for (const [part, e] of byPart) {
    const pv = e.pivot;
    const build = (list, label) => {
      const geos = new Array(list.length);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        geos[i] = tagPart(p.geo, p.part, p.pivot, p.hex, false);
        geos[i].translate(-pv[0], -pv[1], -pv[2]);
      }
      const g = mergeAll(geos, label);
      owned.push(g);
      return g;
    };
    const mesh = new Mesh(e.solid.length ? build(e.solid, 'rig.part' + part) : new BufferGeometry(), material);
    if (!e.solid.length) owned.push(mesh.geometry);
    mesh.position.set(pv[0], pv[1], pv[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    if (e.glow.length) {
      const glow = new Mesh(build(e.glow, 'rig.glow' + part), glowMaterial);
      glow.name = part === PART.HEAD ? 'eyes' : 'glow' + part;
      glow.castShadow = false;
      glow.frustumCulled = false;
      mesh.add(glow);
    }
    out.set(part, mesh);
  }
  return out;
}

/** Max z where the mesh-local plane y = Y cuts the geometry's triangles (front surface at that height). */
function frontZAt(geo, Y, fallback) {
  const pos = geo.attributes.position;
  const idx = geo.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  let best = -Infinity;
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const ia = idx ? idx.getX(t * 3 + e) : t * 3 + e;
      const ib = idx ? idx.getX(t * 3 + ((e + 1) % 3)) : t * 3 + ((e + 1) % 3);
      const ya = pos.getY(ia), yb = pos.getY(ib);
      if ((ya - Y) * (yb - Y) > 0 || ya === yb) continue;
      const k = (Y - ya) / (yb - ya);
      const z = pos.getZ(ia) + (pos.getZ(ib) - pos.getZ(ia)) * k;
      if (z > best) best = z;
    }
  }
  return best === -Infinity ? fallback : best;
}

/** Rig part names that become Bones of the skinned body (ARCH §6.4 joints boss.js animates), in skeleton order. */
const RIG_BONES = ['legL', 'legR', 'torso', 'armL', 'armR', 'head', 'jaw'];

// r5b (boss draws): glow group ids of the merged 'glow' SkinnedMesh (aGlow per vertex → uGlowCol[id] in the fragment)
const GLOW_EYES = 0, GLOW_SACS = 1, GLOW_CORE = 2, GLOW_GROUPS = 3;
const SAC_TOL = 0.02;                 // linear-rgb tolerance of the acid-sac test (boss.js isSacGlow used the same)

/** True when every vertex colour of a glow geometry is the acid-sac colour (the Spitter Queen's head glow holds sacs). */
function isSacGeometry(geo) {
  const c = geo.getAttribute('color');
  if (!c || c.count === 0) return false;
  _color.setHex(PALETTE.zombie.spitter.sacs);
  for (let i = 0; i < c.count; i++) {
    if (Math.abs(c.getX(i) - _color.r) > SAC_TOL || Math.abs(c.getY(i) - _color.g) > SAC_TOL || Math.abs(c.getZ(i) - _color.b) > SAC_TOL) return false;
  }
  return true;
}

/**
 * r5b: the rig's ONE glow material — unlit HDR basic (vertexColors, toneMapped false, white colour) whose fragment multiplies
 * each vertex by uGlowCol[aGlow]: 0 eyes, 1 sacs (the Spitter Queen's; they pulse on their own), 2 core. The per-rig uniform
 * values live in material.userData.glowCols (Vector3 ×3, linear HDR; boss.js writes them per frame: rage / sac pulse / core
 * pulse) and their rest values in userData.glowBase (Float32Array 9). Program key 'gr:bossglow' (one program for every rig;
 * it replaces the former skinned basic eyes / glow program, so the program count is unchanged).
 */
function makeBossGlowMaterial(eyesK, coreHex, coreK) {
  const m = new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false });
  m.name = 'boss.glow';
  const cols = [new Vector3(eyesK, eyesK, eyesK), new Vector3(eyesK, eyesK, eyesK), new Vector3()];
  _color.setHex(coreHex);
  cols[GLOW_CORE].set(_color.r * coreK, _color.g * coreK, _color.b * coreK);
  const base = new Float32Array(GLOW_GROUPS * 3);
  for (let i = 0; i < GLOW_GROUPS; i++) { base[i * 3] = cols[i].x; base[i * 3 + 1] = cols[i].y; base[i * 3 + 2] = cols[i].z; }
  const uniforms = { uGlowCol: { value: cols } };
  m.userData.glowCols = cols;
  m.userData.glowBase = base;
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowCol = uniforms.uGlowCol;
    shader.vertexShader = replaceChunk(shader.vertexShader, 'common', '#include <common>\nattribute float aGlow;\nvarying float vGlow;');
    shader.vertexShader = replaceChunk(shader.vertexShader, 'begin_vertex', '#include <begin_vertex>\n\tvGlow = aGlow;');
    shader.fragmentShader = replaceChunk(shader.fragmentShader, 'common', '#include <common>\nuniform vec3 uGlowCol[ 3 ];\nvarying float vGlow;');
    shader.fragmentShader = replaceChunk(shader.fragmentShader, 'color_fragment',
      '#include <color_fragment>\n\tdiffuseColor.rgb *= vGlow < 0.5 ? uGlowCol[ 0 ] : ( vGlow < 1.5 ? uGlowCol[ 1 ] : uGlowCol[ 2 ] );');
  };
  m.customProgramCacheKey = () => 'gr:bossglow';
  return m;
}

/** Replaces a part Mesh by a Bone of the same name, transform and children (in place in its parent). Returns the Bone. */
function boneFor(m) {
  const bone = new Bone();
  bone.name = m.name;
  bone.position.copy(m.position); bone.quaternion.copy(m.quaternion); bone.scale.copy(m.scale);
  const parent = m.parent;
  const at = parent.children.indexOf(m);
  parent.children[at] = bone; bone.parent = parent; m.parent = null;
  return bone;
}

/**
 * CHR-11 (GDD §16 ≤ 50 main-pass draws) + r5b (boss draws): the whole rig is THREE skinned draws bound to one Skeleton:
 *   'skin'   body material   — legs, torso, arms, head, jaw (casts the rig's one shadow draw)
 *   'armour' armour material — plate0–3 and the Colossus chain0–1 (metal; no shadow, as before)
 *   'glow'   glow material   — eyes, sacs and the core (unlit HDR, uGlowCol per group; no shadow)
 * The joints (legL … jaw) and the core, plate0–3 and chain0–1 become Bones of the same name, transform and children, and
 * every vertex is bound rigidly (weight 1) to its node's bone, so what boss.js writes to rig.parts[...] / plates / chains
 * (position, rotation, scale; Object3D.attach for a detached plate) moves exactly what the separate meshes moved before.
 * A plate or chain is hidden by scale 0 (a Bone has no visibility of its own). The shield stays a Mesh under the torso bone.
 * Hulk 7 → 3 draws per rig (twins 14 → 6), Spitter Queen 8 → 3, Juggernaut 7 → 3, Colossus 9 → 3 (+1 while the shield is up).
 * `cache` (per archetype) shares the three merged geometries between rigs of one archetype (the Hulk Twins): bone order and
 * rest pose are identical per archetype. Builds at init only (allocates).
 */
function skinRig(group, body, rig, mats, owned, cache) {
  const material = mats.body, glowMaterial = mats.glow, armourMaterial = mats.armour;
  group.updateMatrixWorld(true);
  const bones = [];
  const solid = [], armour = [], glow = [];
  for (let b = 0; b < RIG_BONES.length; b++) {
    const name = RIG_BONES[b];
    const m = rig[name];
    if (!m || !m.isMesh) continue;
    const bi = bones.length;
    const kids = m.children.slice();
    const bone = boneFor(m);
    bones.push(bone);
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k];
      if (c.isMesh && c.material === glowMaterial) {
        // the head's glow child ('eyes') is the eyes group unless all of it is acid-sac colour (the Queen's head sacs)
        const gid = (c.name === 'eyes' && !isSacGeometry(c.geometry)) ? GLOW_EYES : GLOW_SACS;
        glow.push({ geo: c.geometry, mat: c.matrixWorld, bi, gid, hex: -1 });
        m.remove(c);
      } else {
        bone.add(c);                                  // jaw, core, plates, chains, shield, nested parts (same local transform)
      }
    }
    if (m.geometry && m.geometry.attributes.position && m.geometry.attributes.position.count > 0) solid.push({ geo: m.geometry, mat: m.matrixWorld, bi, gid: -1, hex: -1 });
    rig[name] = bone;
  }
  // r5b: the core, the plates and the chains become bones too (their meshes' rest world matrices bake the geometry)
  const plates = PALETTE.boss.plates;
  const extra = (m, list, gid, hex) => {
    if (!m || !m.isMesh) return m;
    const bi = bones.length;
    const kids = m.children.slice();
    const bone = boneFor(m);
    bones.push(bone);
    for (let k = 0; k < kids.length; k++) bone.add(kids[k]);
    list.push({ geo: m.geometry, mat: m.matrixWorld, bi, gid, hex });
    return bone;
  };
  rig.core = extra(rig.core, glow, GLOW_CORE, 0xffffff);
  for (let i = 0; i < rig.plates.length; i++) rig.plates[i] = extra(rig.plates[i], armour, -1, plates);
  for (let i = 0; i < rig.chains.length; i++) rig.chains[i] = extra(rig.chains[i], armour, -1, plates);
  // rest pose = bind pose: geometry baked into rig space (group at the origin), bones' inverses from their rest matrices
  group.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  const build = (list, mat, name, withGlow) => {
    if (!list.length) return null;
    let merged = cache ? cache[name] : null;
    if (!merged) {
      const geos = new Array(list.length);
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const g = it.geo.clone();
        g.applyMatrix4(it.mat);
        if (g.hasAttribute('aPart')) g.deleteAttribute('aPart');
        if (g.hasAttribute('aPivot')) g.deleteAttribute('aPivot');
        if (g.hasAttribute('uv')) g.deleteAttribute('uv');
        if (g.hasAttribute('uv1')) g.deleteAttribute('uv1');
        if (!g.hasAttribute('normal')) g.computeVertexNormals();
        const n = g.attributes.position.count;
        if (!g.hasAttribute('color')) {                 // plates / chains (metal colour) and the core (white × uGlowCol[2])
          const col = new Float32Array(n * 3);
          fillColor(col, it.hex >= 0 ? it.hex : 0xffffff);
          g.setAttribute('color', new Float32BufferAttribute(col, 3));
        }
        const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
        for (let v = 0; v < n; v++) { si[v * 4] = it.bi; sw[v * 4] = 1; }
        g.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4));
        g.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4));
        if (withGlow) g.setAttribute('aGlow', new Float32BufferAttribute(new Float32Array(n).fill(it.gid), 1));
        geos[i] = g;
      }
      merged = mergeAll(geos, 'rig.' + name);
      owned.push(merged);
      if (cache) cache[name] = merged;
    }
    const sm = new SkinnedMesh(merged, mat);
    sm.name = name;
    sm.frustumCulled = false;                         // bounds move with the bones
    sm.castShadow = false;
    sm.receiveShadow = false;
    body.add(sm);
    sm.updateMatrixWorld(true);
    sm.bind(skeleton, sm.matrixWorld);
    return sm;
  };
  // 'armour' is added first: boss.js clones the rig's standard materials in traversal order, so the armour clone gets the
  // lower material id and three's opaque sort (material id before depth) still draws the plates BEFORE the body, as the
  // separate plate meshes were (a different program, sorted first) — where a plate edge meets the chest at equal depth the
  // body keeps winning the LessEqual test, exactly as before (r5b A/B: the Hulk Twins' roar frame showed the swap)
  const arm = build(armour, armourMaterial, 'armour', false);
  const skin = build(solid, material, 'skin', false);
  if (skin) skin.castShadow = true;                   // boss.js SHADOW_PARTS lists 'skin' (round-2 cross-group; the accessor lock is gone)
  const gl = build(glow, glowMaterial, 'glow', true);
  // the per-part geometries are no longer drawn
  const dead = solid.concat(armour, glow);
  for (let i = 0; i < dead.length; i++) {
    const at = owned.indexOf(dead[i].geo);
    if (at >= 0) owned.splice(at, 1);
    dead[i].geo.dispose();
  }
  rig.skin = skin;
  rig.armour = arm;
  rig.glow = gl;
  rig.skeleton = skeleton;
}

/** Records a node's rest transform (position + Euler) under its name. */
function recordRest(rest, node) {
  rest[node.name] = { px: node.position.x, py: node.position.y, pz: node.position.z, rx: node.rotation.x, ry: node.rotation.y, rz: node.rotation.z };
}

export class BossRigFactory {
  /** Internal helper owned by ModelLibrary (exposed for tests); allocates only inside build(). */
  constructor(models) { this.models = models; this._geo = {}; }   // _geo: archetype → merged rig geometries (twins share them)

  build(archetypeName) {
    const models = this.models;
    const archName = BOSSES.archetypes[archetypeName] ? archetypeName : RIG_ARCH_FALLBACK;
    const arch = resolveArchetype(archName);
    const baseModel = arch.baseModel || 'colossus';
    const isColossus = baseModel === 'colossus';
    const c = PALETTE.boss;
    const R = DIMS.rig;
    const H = BOSSES.rigHeight;

    // parts: raw body → uniform scale to the 7 m rig height (GDD §7; keeps BOSSES.coreY at chest height and
    // the dolly framing identical for every archetype) → turned to face +Z
    const parts = isColossus ? colossusParts() : bossBodyParts(baseModel);
    const scale = H / partsTop(parts);
    scaleParts(parts, scale);
    flipParts(parts);

    // plates and the core socket are laid out on the bare chest (rig space, before the rim joins the torso)
    const coreR = R.coreR * H;
    const plateSpecs = plateLayout(baseModel, parts, coreR, H);
    let chestZ = 0;
    if (!isColossus) {
      // CHR-1: the core sits recessed in a dark socket rim merged into the torso (no extra draw call)
      chestZ = frontZAtParts(parts, PART.TORSO, BOSSES.coreY, coreR);
      const ck = BOSS_ART.core;
      const rim = new TorusGeometry(coreR * ck.rimR, coreR * ck.rimTube, 6, 18);
      rim.translate(0, BOSSES.coreY, chestZ + coreR * 0.05);
      parts.push(P(rim, PART.TORSO, pivotOf(parts, PART.TORSO), c.plates));
    }

    const material = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: PALETTE.material.skin.roughness, metalness: PALETTE.material.skin.metalness });
    material.name = 'boss.body';
    // r5b: one glow material for eyes, sacs and core (uGlowCol per group), one armour material for plates + chains (the metal
    // look of the former shared plate material, as vertex colours on the skinned program the body already uses)
    const glowMaterial = makeBossGlowMaterial(c.eyesEmissive, c.core, c.coreEmissive);
    const armourMaterial = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: PALETTE.material.metal.roughness, metalness: PALETTE.material.metal.metalness });
    armourMaterial.name = 'boss.armour';
    models._ownedMaterials.push(material, glowMaterial, armourMaterial);
    const owned = models._ownedGeometries;
    const meshes = partMeshes(parts, material, glowMaterial, owned);

    const group = new Group();
    group.name = 'boss.' + archName;
    const body = new Group();
    body.name = 'body';
    group.add(body);

    const named = { torso: PART.TORSO, legL: PART.LEG_L, legR: PART.LEG_R, armL: PART.ARM_L, armR: PART.ARM_R, head: PART.HEAD, jaw: PART.JAW };
    const limb = isColossus ? ZOMBIES.brute.limb : models.limbParamsFor(baseModel);
    const rig = {
      archetype: archName, baseModel, scale, height: H, body, material, glowMaterial, armourMaterial, skin: null, armour: null, glow: null,
      torso: null, head: null, jaw: null, armL: null, armR: null, legL: null, legR: null,
      core: null, coreMaterial: null, plates: [], plateDirs: [], chains: [], shield: null, shieldMaterial: null,
      limb, gaitFreq: limb.uFreq / Math.sqrt(scale), rest: {},
    };
    for (const name in named) {
      const m = meshes.get(named[name]);
      if (!m) continue;
      m.name = name;
      rig[name] = m;
    }
    if (!rig.torso || !rig.head) throw new Error('models: rig "' + archName + '" lacks a torso or head part');

    // hierarchy: body → { legL, legR, torso → { armL, armR, head → jaw, core, plates, shield } }
    const torso = rig.torso;
    const tp = torso.position;
    body.add(torso);
    if (rig.legL) body.add(rig.legL);
    if (rig.legR) body.add(rig.legR);
    const torsoChildren = ['armL', 'armR', 'head'];
    for (let i = 0; i < torsoChildren.length; i++) {
      const m = rig[torsoChildren[i]];
      if (!m) continue;
      m.position.sub(tp);
      torso.add(m);
    }
    if (rig.jaw) {
      rig.jaw.position.set(rig.jaw.position.x - rig.head.position.x - tp.x, rig.jaw.position.y - rig.head.position.y - tp.y, rig.jaw.position.z - rig.head.position.z - tp.z);
      rig.head.add(rig.jaw);
    }
    // rest pose: arms forward at the class reach (negative = toward the squad for a +Z-facing rig)
    if (rig.armL) rig.armL.rotation.x = -limb.uArmRest;
    if (rig.armR) rig.armR.rotation.x = -limb.uArmRest;

    // core — glowing weak point at BOSSES.coreY, seated in its chest socket (inside the Colossus cavity)
    const coreGeo = new SphereGeometry(coreR, 14, 10);
    owned.push(coreGeo);
    const coreMat = glowMaterial;                         // r5b: the core is glow group 2 (glowMaterial.userData.glowCols[2])
    const core = new Mesh(coreGeo, armourMaterial);       // build-time placeholder: skinRig bakes it into 'glow' and makes it a Bone
    core.name = 'core';
    const coreLocalY = BOSSES.coreY - tp.y;
    core.position.set(0, coreLocalY, isColossus ? coreR * 0.3 : chestZ - tp.z - coreR * BOSS_ART.core.recess);
    core.castShadow = false;
    core.frustumCulled = false;
    torso.add(core);
    rig.core = core;
    rig.coreMaterial = coreMat;

    // armour plates (BOSSES.plates, plateLayout): chest plates around the core socket, or the Juggernaut's
    // pauldrons + tassets; torso children so boss.js can detach them
    const plateMat = armourMaterial;                      // r5b: baked into the one 'armour' draw by skinRig
    for (let i = 0; i < plateSpecs.length && i < BOSSES.plates; i++) {
      const sp = plateSpecs[i];
      const pg = plateGeometry(sp.w, sp.h, sp.d, sp.kind);
      owned.push(pg);
      const pm = new Mesh(pg, plateMat);
      pm.name = 'plate' + i;
      pm.position.set(sp.x - tp.x, sp.y - tp.y, sp.z - tp.z);
      pm.rotation.set(sp.rx, sp.ry, sp.rz);
      pm.castShadow = true;
      pm.frustumCulled = false;
      torso.add(pm);
      rig.plates.push(pm);
      rig.plateDirs.push(new Vector3(sp.dir[0], sp.dir[1], sp.dir[2]).normalize());
    }

    if (isColossus) {
      // chains hanging from both wrists (arm-local; counter-rotated so they hang straight at rest)
      const linkR = R.linkR * H, tube = R.linkTube * H;
      const chainMat = armourMaterial;                    // r5b: baked into the one 'armour' draw by skinRig
      const armSides = ['armL', 'armR'];
      for (let k = 0; k < armSides.length; k++) {
        const arm = rig[armSides[k]];
        if (!arm) continue;
        const geos = [];
        for (let l = 0; l < R.chainLinks; l++) {
          const link = new TorusGeometry(linkR, tube, 4, 10);
          if (l % 2 === 1) link.rotateY(Math.PI / 2);
          link.translate(0, -linkR - l * linkR * 1.45, 0);
          geos.push(link);
        }
        const cg = mergeAll(geos, 'rig.chain');
        owned.push(cg);
        const chain = new Mesh(cg, chainMat);
        chain.name = 'chain' + k;
        arm.geometry.computeBoundingBox();
        chain.position.set(0, arm.geometry.boundingBox.min.y + linkR * 0.5, 0);
        chain.rotation.x = limb.uArmRest;
        chain.castShadow = false;
        chain.frustumCulled = false;
        arm.add(chain);
        rig.chains.push(chain);
      }
      // shield bubble around the core (hidden until raised)
      const shieldGeo = new SphereGeometry(R.shieldR * H, 18, 12);
      owned.push(shieldGeo);
      const shieldMat = new MeshBasicMaterial({ color: c.shield, transparent: true, opacity: 0.28, depthWrite: false, blending: AdditiveBlending, toneMapped: false });
      shieldMat.name = 'boss.shield';
      models._ownedMaterials.push(shieldMat);
      const shield = new Mesh(shieldGeo, shieldMat);
      shield.name = 'shield';
      shield.position.copy(core.position);
      shield.visible = false;
      shield.castShadow = false;
      shield.frustumCulled = false;
      torso.add(shield);
      rig.shield = shield;
      rig.shieldMaterial = shieldMat;
    }

    // CHR-11 + r5b: three skinned draws for the whole rig (body, armour, glow); rigs of one archetype share the geometry
    let geoCache = this._geo[archName];
    if (!geoCache) geoCache = this._geo[archName] = {};
    skinRig(group, body, rig, { body: material, glow: glowMaterial, armour: armourMaterial }, owned, geoCache);
    group.traverse((o) => { if (o !== group && o.name) recordRest(rig.rest, o); });
    group.userData.rig = rig;
    return group;
  }
}

// ---------------------------------------------------------------------------------------------
// animateRig — optional helper with the same conventions as boss.js (which animates its rigs itself).
// ---------------------------------------------------------------------------------------------
//
// animateRig(group, t, state) — t in seconds; state fields (all optional):
//   speed      walk factor (1 = class gait, 0 = standing)      phase      walk clock offset (s)
//   jaw        0..1 jaw open                                    rage       0..1 phase-3 red glow
//   hitTime    t of the last hit (white flash over ZOMBIES.common.hitFlash)
//   platesOff  0..1 plate fly-off progress                      shield     0..1 shield strength (0 hides)
//   death      0..1 collapse progress (falls toward the squad, then sinks)
//   attack     0..1 telegraph → strike progress, attackKind 'slam'|'charge'|'spit3'|'rain'|'stomp'|'lane'|'car'|'chew'|''
//   lean       extra forward lean (rad)

const EMPTY_STATE = Object.freeze({});
const _rigEmissive = new Color();

/** Restores a node's recorded rest transform (allocation-free). */
function restNode(rig, node) {
  const r = rig.rest[node.name];
  if (!r) return;
  node.position.set(r.px, r.py, r.pz);
  node.rotation.set(r.rx, r.ry, r.rz);
}

/** Animates a rig built by buildBossRig. Allocation-free; boss.js does NOT call it (it owns its rigs' animation). */
export function animateRig(group, t, state) {
  const rig = group.userData.rig;
  if (!rig) return;
  const st = state || EMPTY_STATE;
  const speed = st.speed === undefined ? 1 : st.speed;
  const k = clamp(speed, 0, 1.5);
  const w = (t * Math.max(speed, 0) + (st.phase || 0)) * rig.gaitFreq * Math.PI * 2;
  const sw = Math.sin(w);
  const limb = rig.limb;
  const kind = st.attackKind || '';
  const attack = st.attack || 0;
  const rest = rig.rest;

  let legL = limb.uLegAmp * sw * k, legR = -limb.uLegAmp * sw * k;
  let armL = -limb.uArmRest + limb.uArmAmp * sw * k;
  let armR = -limb.uArmRest - limb.uArmAmp * sw * k;
  let lean = st.lean || 0;
  let headPitch = -limb.uLegAmp * 0.12 * Math.sin(2 * w) * k;
  let jaw = clamp(st.jaw || 0, 0, 1);

  if (attack > 0 && kind) {
    const windup = clamp(attack / 0.7, 0, 1);             // 70 % of the window winds up
    const strike = clamp((attack - 0.7) / 0.3, 0, 1);     // the last 30 % strikes
    if (kind === 'slam') {
      armL = lerp(-limb.uArmRest, -2.9, windup) + 2.6 * strike; armR = armL;
      lean += -0.2 * windup + 0.6 * strike;
      jaw = Math.max(jaw, 0.6 * strike);
    } else if (kind === 'stomp') {
      legR = -0.9 * windup + 0.9 * strike;
      lean += 0.12 * windup - 0.1 * strike;
    } else if (kind === 'charge' || kind === 'lane') {
      lean += 0.35 * windup;
      armL = -limb.uArmRest - 0.6 * windup; armR = armL;
    } else if (kind === 'spit3' || kind === 'rain') {
      headPitch += -0.45 * windup + 0.8 * strike;
      jaw = Math.max(jaw, 0.3 * windup + 0.7 * strike);
      lean += -0.1 * windup + 0.2 * strike;
    } else if (kind === 'car') {
      armR = lerp(-limb.uArmRest, -3.0, windup) + 2.8 * strike;
      lean += -0.2 * windup + 0.4 * strike;
    } else if (kind === 'chew') {
      jaw = Math.max(jaw, 0.5 + 0.5 * Math.abs(Math.sin(t * 8)));
      lean += 0.3;
    }
  }

  const dd = clamp(st.death || 0, 0, 1);
  const fall = dd * dd * (3 - 2 * dd);
  if (rig.legL) rig.legL.rotation.x = rest.legL.rx + legL * (1 - dd) - 0.9 * fall;
  if (rig.legR) rig.legR.rotation.x = rest.legR.rx + legR * (1 - dd) - 0.9 * fall;
  if (rig.armL) rig.armL.rotation.x = armL;
  if (rig.armR) rig.armR.rotation.x = armR;
  if (rig.head) rig.head.rotation.x = rest.head.rx + headPitch;
  if (rig.jaw) rig.jaw.rotation.x = rest.jaw.rx + 0.7 * jaw;
  rig.torso.position.y = rest.torso.py + limb.uBobAmp * rig.scale * Math.abs(sw) * k * (1 - dd);
  rig.torso.rotation.x = rest.torso.rx + lean * (1 - dd);
  rig.body.rotation.x = 1.35 * fall;                       // collapse toward the squad
  rig.body.position.y = -rig.height * 0.35 * fall * fall;

  // core pulse (faster with rage), shield bubble
  const rage = clamp(st.rage || 0, 0, 1);
  rig.core.scale.setScalar(1 + 0.08 * Math.sin(t * (4 + 4 * rage)) * (1 - dd));
  if (rig.shield) {
    const sh = clamp(st.shield || 0, 0, 1);
    rig.shield.visible = sh > 0.001;
    if (rig.shield.visible) {
      rig.shieldMaterial.opacity = 0.12 + 0.22 * sh + 0.06 * Math.sin(t * 6);
      rig.shield.scale.setScalar(1 + 0.03 * Math.sin(t * 3));
    }
  }

  // plates: attached, or flying off in an arc (torso-local)
  const po = clamp(st.platesOff || 0, 0, 1);
  for (let i = 0; i < rig.plates.length; i++) {
    const pm = rig.plates[i];
    // r5b: plates are Bones of the 'armour' draw — scale 0 hides one (visible stays the logical flag)
    if (po <= 0) { pm.visible = true; pm.scale.setScalar(1); restNode(rig, pm); continue; }
    if (po >= 1) { pm.visible = false; pm.scale.setScalar(0); continue; }
    const r = rest[pm.name];
    const dir = rig.plateDirs[i];
    const fly = po * (3 + i * 0.5) * rig.scale;
    pm.visible = true;
    pm.scale.setScalar(1);
    pm.position.set(r.px + dir.x * fly, r.py + dir.y * fly * (1 - po) - po * po * 4 * rig.scale, r.pz + dir.z * fly);
    pm.rotation.set(r.rx + po * 6 * (i % 2 ? 1 : -1), r.ry + po * 4, r.rz + po * 3);
  }

  // chains sway
  for (let i = 0; i < rig.chains.length; i++) {
    const ch = rig.chains[i];
    const r = rest[ch.name];
    ch.rotation.z = r.rz + Math.sin(t * 1.3 + i * 2.1) * 0.15 + sw * 0.1 * k;
    ch.rotation.x = r.rx + Math.cos(t * 0.9 + i) * 0.1 - lean * 0.5;
  }

  // emissive: white hit flash + red rage on the body material
  const hitTime = st.hitTime === undefined ? IANIM_NEVER : st.hitTime;
  const flash = Math.max(0, 1 - (t - hitTime) / ZOMBIES.common.hitFlash);
  _rigEmissive.setHex(PALETTE.boss.rage);
  const rr = rage * (0.35 + 0.15 * Math.sin(t * 5));
  rig.material.emissive.setRGB(_rigEmissive.r * rr + flash, _rigEmissive.g * rr + flash, _rigEmissive.b * rr + flash);
  if (rig.armourMaterial) rig.armourMaterial.emissive.copy(rig.material.emissive);
}
