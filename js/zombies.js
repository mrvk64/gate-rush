// js/zombies.js — GATE RUSH: `Zombies` (ARCHITECTURE §6.7, §7, D6; GDD §6, §12 J2/J9/J11/J22).
//
// Five `CharacterInstances` pools (walker 120, runner 60, crawler 40, brute 16, spitter 24 = 260 live),
// structure-of-arrays state indexed by a global pool slot (per-type slot ranges, ZOMBIES[type].slotBase),
// stable generation-tagged ids (`(generation << 12) | slot`), explicit alive / dying / free states,
// z-bins rebuilt every step for the swept hit tests, per-type AI, contact / bite rules, spit globs with
// their arc preview, HP bars (one InstancedMesh, `iHp` attribute), telegraph decals through fx.decal
// and every zombie event of §5.1 with exactly the documented payloads.
//
// Cross-module access (read via ctx, write via ctx.events + public methods of §6 only):
//   ctx.world    roadSpeed                      ctx.squad   x / centerZ / invulnerable / intersectsCircle / removeSoldiers
//   ctx.troops   apcIntersects / apcAbsorb       ctx.level   level (spit kills from L10)
//   ctx.fx       decal / moveDecal / decalProgress / removeDecal / emit ('dust')
//   ctx.render   scene / uniforms.uTime / materials.hpBar / blobShadowSlot      ctx.models  geo.glob
//   ctx.rng      patterns, phases, spit timers (gameplay)      ctx.rngFx  tint jitter (cosmetic)
//   ctx.quality  params.shadows / params.hpBars (+ quality:change listener)
//
// Events emitted (module-level reused payload objects — listeners must copy, never retain):
//   zombie:spawn { id, type, x, z, hp }
//   zombie:hit { id, type, x, y, z, damage, hp, maxHp, killed }
//   zombie:die { id, type, x, z, cause }             cause ∈ bullet | bite | crush | burn | explosion | cleanup
//   zombie:bite { id, type, x, z, kills }
//   zombie:telegraph { id, kind, x, z, radius, duration }   kind ∈ ring | spit | screech | charge | lunge
//   zombie:stagger { id, x, z }
//   spit:impact { x, z, radius, kills }
//   coin:pickup { amount, x, y, z, source:'kill' }  (kills with cause ≠ bite | cleanup; THE only coin path of this module)
//
// Hot paths (step / render / every query) allocate nothing: typed arrays sized once in init() at the
// High-tier capacity (§14 rule 3), module-level scratch objects, no closures, no array literals.
import {
  InstancedMesh, InstancedBufferAttribute, DynamicDrawUsage, PlaneGeometry, IcosahedronGeometry,
  MeshStandardMaterial, Color,
} from 'three';
import { clamp } from './util.js';
import { WORLD, ZOMBIES, WAVE_PATTERNS, ECONOMY, TROOPS, FIRE, PALETTE, RENDER } from './data.js';
import { CharacterInstances } from './models.js';

// ---------------------------------------------------------------------------------------------
// Type tables (built once at module load from data.js — never a literal tuning number below)
// ---------------------------------------------------------------------------------------------

/** Canonical type order: walker, runner, crawler, brute, spitter (ZOMBIES.common.types). */
const TYPES = ZOMBIES.common.types;
const NTYPES = TYPES.length;
/** ZOMBIES[type] per type index. */
const DEF = new Array(NTYPES);
/** type name → type index. */
const TYPE_INDEX = {};
/** First / one-past-last global slot per type (ZOMBIES[type].slotBase / + pool). */
const SLOT_BASE = new Int32Array(NTYPES);
const SLOT_END = new Int32Array(NTYPES);
/** Largest hit radius of any type (bin padding for the swept queries). */
let MAX_RADIUS = 0;
for (let t = 0; t < NTYPES; t++) {
  const def = ZOMBIES[TYPES[t]];
  DEF[t] = def;
  TYPE_INDEX[TYPES[t]] = t;
  SLOT_BASE[t] = def.slotBase;
  SLOT_END[t] = def.slotBase + def.pool;
  if (def.radius > MAX_RADIUS) MAX_RADIUS = def.radius;
}
const T_WALKER = TYPE_INDEX.walker;
const T_RUNNER = TYPE_INDEX.runner;
const T_CRAWLER = TYPE_INDEX.crawler;
const T_BRUTE = TYPE_INDEX.brute;
const T_SPITTER = TYPE_INDEX.spitter;

/** Total slot capacity (ZOMBIES.common.maxLive = 260). */
const CAP = ZOMBIES.common.maxLive;

// Per-zombie lifecycle state (ARCH §6.7 "alive / dying / free").
const S_FREE = 0;
const S_ALIVE = 1;
const S_DYING = 2;

// Per-zombie flag bits (Uint16).
const F_HIT = 1;          // has taken damage at least once ('afterHit' HP-bar policy)
const F_SCREECH = 2;      // runner: screech telegraph emitted
const F_LUNGE = 4;        // crawler: lunging (hittable regardless of hittableZ)
const F_CHARGE = 8;       // brute: charging
const F_RING = 16;        // brute: ring telegraph started
const F_RING_DONE = 32;   // brute: ring filled (may swing)
const F_HOLD_DONE = 64;   // spitter: hold time elapsed, advancing
const F_HOLDING = 128;    // spitter: currently holding at hold.z
const F_BURN_VIS = 256;   // burn tint currently applied to the instance
const F_LUNGE_TOLD = 512; // crawler: lunge telegraph emitted
const F_CHARGE_TOLD = 1024;
const F_FRONT_WALK = 2048; // brute: touched the formation behind its front edge, walking to the front (QA ENE-12)
const F_BACKOFF = 4096;    // brute: swing backstop — staggering back BRUTE_BACKOFF_M before re-telegraphing (QA ENE-12)
const F_FROZEN = 8192;     // brute: in the stagger freeze this step (set by _aiBrute, read by _contact)

// Stable ids: id = (generation << ID_SLOT_BITS) | slot (ARCH D6). Generation wraps at 19 bits so ids stay
// positive 31-bit integers; 2^19 reuses of one slot never happen inside a run.
const ID_SLOT_BITS = 12;
const ID_SLOT_MASK = (1 << ID_SLOT_BITS) - 1;
const GEN_MASK = 0x7FFFF;

// z-bins (ZOMBIES.common.binSize / binRange: 2 m bins from −80 to +20 → 50 bins).
const BIN_SIZE = ZOMBIES.common.binSize;
const BIN_MIN = ZOMBIES.common.binRange[0];
const BIN_MAX = ZOMBIES.common.binRange[1];
const NBINS = Math.ceil((BIN_MAX - BIN_MIN) / BIN_SIZE);

/** Road half-width minus nothing: zombies are clamped to |x| ≤ roadWidth/2 − radius. */
const ROAD_HALF = WORLD.roadWidth / 2;

/** Blob-shadow slot base for zombies (RENDER.blobShadow.slots.zombies = 300). */
const BLOB_BASE = RENDER.blobShadow.slots.zombies;

/** Glob pool (ZOMBIES.common.globPool = 32) and radius (globRadius = 0.25). */
const GLOB_CAP = ZOMBIES.common.globPool;
const GLOB_RADIUS = ZOMBIES.common.globRadius;

/** The contact test only runs once a zombie can touch the formation (front row z = 0, AABB inflated by r). */
const CONTACT_Z = -MAX_RADIUS;
/** The APC sits TROOPS.apc.ahead m in front of the squad and is TROOPS.apc.length long. */
const APC_CHECK_Z = -(TROOPS.apc.ahead + TROOPS.apc.length) - MAX_RADIUS;

const TWO_PI = Math.PI * 2;
const DEG2RAD = Math.PI / 180;
/** A toppled body lies flat: quarter turn about the foot pivot (geometry, not tuning). */
const TOPPLE_ANGLE = Math.PI / 2;

// ---------------------------------------------------------------------------------------------
// Literals without a data.js key (ARCH §14 rule 10 — each names its intended path for the integrator)
// ---------------------------------------------------------------------------------------------

const SPIT_ARC_HEIGHT = ZOMBIES.spitter.spit.arcHeight;          // apex of the lobbed glob above the chord (m) (data key; wired round-2 cross-group)
const SPIT_MOUTH_FRAC = ZOMBIES.spitter.spit.mouthY;          // launch height as a fraction of ZOMBIES.spitter.height (data key; wired round-2 cross-group)
const SPIT_FIRST_DELAY = ZOMBIES.spitter.spit.firstDelay;  // [min, max] s before the first spit once in range (rng) (data key; wired round-2 cross-group)
const BRUTE_CHARGE_LATERAL = ZOMBIES.brute.charge.lateral;     // m/s homing toward squad x while charging (data key; wired round-2 cross-group)
const CRAWLER_LUNGE_LATERAL = ZOMBIES.crawler.lunge.lateral;    // m/s homing toward squad x while lunging (data key; wired round-2 cross-group)
const CRAWLER_DUST_EVERY = ZOMBIES.crawler.dustEvery;      // s between dust-trail puffs (≈ 8 per second) (data key; wired round-2 cross-group)
const RUNNER_LATERAL_RATE = ZOMBIES.runner.zigzag.lateralRate;      // 1/s lerpExp of the zig-zag centre toward the re-targeted x (data key; wired round-2 cross-group)
const RUNNER_SCREECH_LEAN = ZOMBIES.runner.screechLean;     // rad forward lean after the screech (GDD §6.1 "screech at 20 m, lean") (data key; wired round-2 cross-group)
const RUNNER_LEAN_RATE = ZOMBIES.runner.leanRate;         // 1/s lerpExp into the lean (data key; wired round-2 cross-group)
const GUARD_LINE_HALF = WAVE_PATTERNS.line.guardHalfWidth;          // half-width of a guard line centred on its lane (pair lane 4 m) (data key; wired round-2 cross-group)
const PINCER_CENTRE_HALF = WAVE_PATTERNS.pincer.centreHalfWidth;       // the centre group's x half-range (data key; wired round-2 cross-group)
const FLANK_JITTER = WAVE_PATTERNS.flank.jitter;            // x jitter inside a flank cluster (m) (data key; wired round-2 cross-group)
const COIN_Y_FRAC = ZOMBIES.common.coinYFraction;              // coin:pickup y = height · 0.6 (the coin pops from the torso) (data key; wired round-2 cross-group)
const STAGGER_PITCH = ZOMBIES.brute.stagger.pitch;           // rad backward recoil at the stagger peak (data key; wired round-2 cross-group)
const YAW_RATE = ZOMBIES.common.yawRate;                 // 1/s lerpExp of the facing toward the velocity direction (data key; wired round-2 cross-group)
const GLOB_SPIN = ZOMBIES.common.globSpin;                // rad/s cosmetic tumble of a glob (data key; wired round-2 cross-group)
const GLOB_EMISSIVE = ZOMBIES.common.globEmissive;            // emissiveIntensity of the acid glob material (data key; wired round-2 cross-group)
const GLOB_ROUGHNESS = ZOMBIES.common.globRoughness;          // (data key; wired round-2 cross-group)
const ANIM_SPEED_LUNGE = ZOMBIES.crawler.lunge.animSpeed;         // limb-swing multiplier (iAnim.y) while lunging (data key; wired round-2 cross-group)
const ANIM_SPEED_CHARGE = ZOMBIES.brute.charge.animSpeed;        // limb-swing multiplier while charging (data key; wired round-2 cross-group)
const HIT_Y_FRAC = ZOMBIES.common.hitYFraction;               // AOE / query impact height = height · 0.5 (data key; wired round-2 cross-group)
const SQUAD_VX_SMOOTH = ZOMBIES.spitter.spit.leadSmoothing;           // 1/s lerpExp of the squad lateral-velocity estimate used to lead the spit (data key; wired round-2 cross-group)
const GLOB_TUMBLE_RATIO = ZOMBIES.common.globTumbleRatio;        // second tumble axis rate as a fraction of GLOB_SPIN (data key; wired round-2 cross-group)
const CLEAR_HIT_TIME = -1000;        // iAnim.z sentinel far in the past so a fresh instance never flashes (not a tuning value)
const HIT_FLASH_RETRIGGER = ZOMBIES.common.hitFlashRetrigger;   // s between two shader hit flashes of one zombie
const BRUTE_CONTACT_HOMING = ZOMBIES.brute.contactHoming;       // m/s x-homing toward squad x while a brute is in contact
// GDD §6.1 / QA ENE-12: a brute contacts and swings only at the formation front; a flank contact walks to the front first
const BRUTE_MAX_CONTACT_Z = ZOMBIES.brute.maxContactZ;          // a brute holds / swings only at z ≤ this (front row z = 0)
const BRUTE_CONTACT_HOMING_Z = ZOMBIES.brute.contactHomingZ;    // m/s toward the front (−z, squad frame) while in contact behind it
const BRUTE_MAX_SWINGS = ZOMBIES.brute.maxSwings;               // backstop: swings before a brute staggers back instead of swinging
const BRUTE_BACKOFF_M = ZOMBIES.brute.backoffM;          // m the swing backstop staggers a brute back (QA ENE-12 "2 m") (data key; wired round-2 cross-group)
/** Per-type hit radius / height (typed copies for the hot queries — no object loads, no helper calls). */
/** Per-type own speed, bite and x clamp (ROAD_HALF − radius): typed copies so the hot step never loads the five differently-shaped DEF objects. */
const RADIUS = new Float32Array(NTYPES);
const HEIGHT = new Float32Array(NTYPES);
const SPEED = new Float32Array(NTYPES);
const BITE = new Uint8Array(NTYPES);
const XMAX = new Float32Array(NTYPES);
for (let t = 0; t < NTYPES; t++) {
  RADIUS[t] = DEF[t].radius; HEIGHT[t] = DEF[t].height; SPEED[t] = DEF[t].speed; BITE[t] = DEF[t].bite;
  XMAX[t] = WORLD.roadWidth / 2 - DEF[t].radius;
}
const CRAWLER_HITTABLE_Z = ZOMBIES.crawler.hittableZ;
const BULLET_Y = FIRE.bullet.y;
/** Segment scratch for hitTestSegment → hitTestSeg (doubles live in a typed array, never boxed across calls). */
const SEG_Q = new Float64Array(4);
/** ease.outBack overshoot (util.js default) — the topple curve is evaluated inline in render(). */
const OUT_BACK_S = 1.70158;

/** HP-bar width scale per type (bar width scales with the hit radius relative to the walker's). */
const BAR_SCALE = new Float32Array(NTYPES);
/** Blob-shadow disc scale per type (RENDER.blobShadow.radius disc scaled to the hit radius). */
const BLOB_SCALE = new Float32Array(NTYPES);
for (let t = 0; t < NTYPES; t++) {
  BAR_SCALE[t] = DEF[t].radius / ZOMBIES.walker.radius;
  BLOB_SCALE[t] = DEF[t].radius / RENDER.blobShadow.radius;
}

/** Telegraph decal colours (GDD J11 red ring, GDD §6.1 green arc). */
const RING_COLOR = PALETTE.flash.red;
const ARC_COLOR = PALETTE.fx.acid;

// Burn tint (PALETTE.zombie.burning → linear rgb) applied as a multiplier on the base tint: the red
// channel is pushed above 1 (brighter, "orange emissive"), green/blue pulled down.
const BURN_COLOR = new Color(PALETTE.zombie.burning);
const BURN_MUL_R = 0.5 + BURN_COLOR.r;
const BURN_MUL_G = 0.5 + BURN_COLOR.g;
const BURN_MUL_B = 0.5 + BURN_COLOR.b;

// ---------------------------------------------------------------------------------------------
// Reused event payloads (§5: emitters reuse module-level objects; listeners copy on receipt)
// ---------------------------------------------------------------------------------------------

const P_SPAWN = { id: -1, type: '', x: -0, z: -0, hp: -0 };
const P_HIT = { id: -1, type: '', x: -0, y: -0, z: -0, damage: -0, hp: -0, maxHp: -0, killed: false };
const P_DIE = { id: -1, type: '', x: -0, z: -0, cause: '' };
const P_BITE = { id: -1, type: '', x: -0, z: -0, kills: 0 };
const P_TELE = { id: -1, kind: '', x: -0, z: -0, radius: -0, duration: -0 };
const P_STAGGER = { id: -1, x: -0, z: -0 };
const P_IMPACT = { x: -0, z: -0, radius: -0, kills: -0 };
const P_COIN = { amount: -0, x: -0, y: -0, z: -0, source: 'kill' };

/** Reused wave descriptor for boss minion bursts and internal re-dispatch (never retained by callers). */
const UNIT_ORDER = new Uint8Array(CAP);   // type index per unit of the wave being laid out (spawnWave scratch)

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Bin index of a z coordinate, clamped into [0, NBINS). */
function binOf(z) {
  const b = Math.floor((z - BIN_MIN) / BIN_SIZE);
  return b < 0 ? 0 : (b >= NBINS ? NBINS - 1 : b);
}

/** Composes a stable id from a slot and its generation. */
function makeId(slot, gen) {
  return ((gen & GEN_MASK) << ID_SLOT_BITS) | slot;
}

/** In-place Fisher–Yates over the first n entries of a Uint8Array using the gameplay rng. */
function shuffleUnits(rng, arr, n) {
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

/** Increments ctx.debug.dropped[key] when the debug overlay is on (never hot). */
function noteDropped(ctx, key) {
  const dbg = ctx.debug;
  if (!dbg || !dbg.dropped) return;
  dbg.dropped[key] = (dbg.dropped[key] | 0) + 1;
}

/**
 * Installed as a committed attribute's clearUpdateRanges(): WebGLAttributes calls it after every ranged upload,
 * and emptying the array (three's default, length = 0) makes V8 drop and re-allocate its backing store on the
 * next push — every frame. The one persistent range record stays in updateRanges instead (gates.js / fx.js /
 * models.js pattern, QA GAT-4 / ENE-16).
 */
function keepUpdateRanges() {}

/** Gives an attribute its one permanent update-range record (init only). */
function tagRange(attr, range) {
  attr.updateRanges.length = 0;
  attr.updateRanges.push(range);
  attr.clearUpdateRanges = keepUpdateRanges;
}

/**
 * Marks an instanced attribute for a one-range upload of the first `count` items (§14 rule 7).
 * `range` is the persistent { start, count } installed by tagRange(): nothing is pushed per frame.
 */
function commitAttr(attr, count, range) {
  if (count <= 0) return;
  range.start = 0;
  range.count = count * attr.itemSize;
  const ranges = attr.updateRanges;
  if (ranges.length !== 1 || ranges[0] !== range) { ranges.length = 0; ranges.push(range); }   // first use / foreign reset only
  attr.needsUpdate = true;
}

/** Reused spawn-options object for spawnWave (spawn copies the fields it needs). */
const SPAWN_OPTS = { guardEventId: -1, guardLane: -1, lunge: false };

// ---------------------------------------------------------------------------------------------
// Zombies
// ---------------------------------------------------------------------------------------------

export class Zombies {
  constructor(ctx) {
    this.ctx = ctx;
    // Everything below is allocated in init() (ARCH §6 common shape: the constructor stores ctx only).
    this._inst = null; this._instCount = null; this._instToSlot = null; this._slotToInst = null;
    this._freeStack = null; this._freeTop = null;
    this._x = null; this._z = null; this._vx = null; this._vz = null; this._hp = null; this._maxHp = null;
    this._phase = null; this._timer = null; this._timer2 = null; this._aux = null; this._hitTime = null; this._flashT = null;
    this._deathTime = null; this._burnUntil = null; this._homeX = null; this._targetX = null;
    this._yaw = null; this._pitch = null; this._lean = null; this._staggerNext = null; this._dust = null;
    this._tintR = null; this._tintG = null; this._tintB = null;
    this._swings = null; this._backZ = null;
    this._state = null; this._type = null; this._flags = null; this._gen = null; this._guardEvent = null; this._guardLane = null; this._ringDecal = null;
    this._binHead = null; this._binNext = null; this._cand = null;
    this._alive = 0; this._aliveByType = null;
    this._hpGeo = null; this._hpAttr = null; this._hpMesh = null; this._hpMatDisposable = false;
    this._hpMatRange = null; this._hpAttrRange = null; this._globMatRange = null;   // persistent updateRanges entries
    this._globGeo = null; this._globGeoOwned = false; this._globMat = null; this._globMesh = null;
    this._gActive = null; this._gX0 = null; this._gY0 = null; this._gZ0 = null; this._gTx = null; this._gTz = null;
    this._gT = null; this._gDur = null; this._gKills = null; this._gDecal = null; this._gPreview = null; this._gOwner = null; this._gCount = 0;
    this._t = 0; this._prevSquadX = 0; this._squadVx = 0; this._dt = WORLD.step; this._road = 0; this._sx = 0; this._scz = 0;
    this._offQuality = null;
    this._onMoveFns = null;
    this._hasBlob = false;   // render.blobShadowSlot available (Low-tier blob discs)
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Builds every pool at the High-tier capacity, the HP-bar and glob meshes, the z-bins; subscribes. */
  init() {
    const ctx = this.ctx;
    const params = ctx.quality ? ctx.quality.params : null;
    const shadowsOn = !!(params && params.shadows);
    const scene = ctx.render ? ctx.render.scene : null;
    this._hasBlob = !!(ctx.render && typeof ctx.render.blobShadowSlot === 'function');

    // --- character pools -----------------------------------------------------------------
    this._inst = new Array(NTYPES);
    this._instCount = new Int32Array(NTYPES);
    this._instToSlot = new Array(NTYPES);
    this._slotToInst = new Int32Array(CAP).fill(-1);
    this._onMoveFns = new Array(NTYPES);
    for (let t = 0; t < NTYPES; t++) {
      const def = DEF[t];
      const inst = new CharacterInstances(ctx, TYPES[t], def.pool, { castShadow: shadowsOn && def.shadow, receiveShadow: false });
      this._inst[t] = inst;
      this._instToSlot[t] = new Int32Array(def.pool).fill(-1);
      this._onMoveFns[t] = this._makeOnMove(t);
      inst.onMove = this._onMoveFns[t];
      if (scene && inst.mesh && inst.mesh.parent === null) scene.add(inst.mesh);
    }

    // --- per-slot SoA state ----------------------------------------------------------------
    this._x = new Float32Array(CAP); this._z = new Float32Array(CAP);
    this._vx = new Float32Array(CAP); this._vz = new Float32Array(CAP);
    this._hp = new Float32Array(CAP); this._maxHp = new Float32Array(CAP);
    this._phase = new Float32Array(CAP);
    this._timer = new Float32Array(CAP);      // runner: re-target; brute: swing cooldown; spitter: spit cooldown
    this._timer2 = new Float32Array(CAP);     // brute: stagger freeze left
    this._aux = new Float32Array(CAP);        // brute: ring fill time; spitter: hold time
    this._hitTime = new Float32Array(CAP);
    this._flashT = new Float32Array(CAP);     // last shader hit flash (gameplay time), retrigger-limited
    this._deathTime = new Float32Array(CAP);
    this._burnUntil = new Float32Array(CAP);
    this._homeX = new Float32Array(CAP);
    this._targetX = new Float32Array(CAP);
    this._yaw = new Float32Array(CAP);
    this._pitch = new Float32Array(CAP);
    this._lean = new Float32Array(CAP);
    this._staggerNext = new Float32Array(CAP);
    this._dust = new Float32Array(CAP);
    this._tintR = new Float32Array(CAP); this._tintG = new Float32Array(CAP); this._tintB = new Float32Array(CAP);
    this._swings = new Uint8Array(CAP);       // brute: swings landed (QA ENE-12 backstop)
    this._backZ = new Float32Array(CAP);      // brute: z the backstop stagger walks back to
    this._state = new Uint8Array(CAP);
    this._type = new Uint8Array(CAP);
    this._flags = new Uint16Array(CAP);
    this._gen = new Int32Array(CAP);
    this._guardEvent = new Int32Array(CAP).fill(-1);
    this._guardLane = new Int8Array(CAP).fill(-1);
    this._ringDecal = new Int32Array(CAP).fill(-1);
    this._aliveByType = new Int32Array(NTYPES);

    // free-slot stacks per type (LIFO; filled in reset())
    this._freeStack = new Array(NTYPES);
    this._freeTop = new Int32Array(NTYPES);
    for (let t = 0; t < NTYPES; t++) this._freeStack[t] = new Int16Array(DEF[t].pool);

    // --- z-bins + query scratch --------------------------------------------------------------
    this._binHead = new Int16Array(NBINS).fill(-1);
    this._binNext = new Int16Array(CAP).fill(-1);
    this._cand = new Int16Array(CAP);

    // --- HP bars: one InstancedMesh, `iHp` float = HP fraction 0..1 (render.materials.hpBar() billboards the
    //     PlaneGeometry(w, h) quad and reads the width/height scale from the instance matrix columns) ---
    const bar = ZOMBIES.common.hpBar;
    this._hpGeo = new PlaneGeometry(bar.w, bar.h);
    this._hpAttr = new InstancedBufferAttribute(new Float32Array(ZOMBIES.common.hpBarPool), 1);
    this._hpAttr.setUsage(DynamicDrawUsage);
    this._hpGeo.setAttribute('iHp', this._hpAttr);
    let hpMat = null;
    if (ctx.render && ctx.render.materials && typeof ctx.render.materials.hpBar === 'function') {
      hpMat = ctx.render.materials.hpBar();
    }
    if (!hpMat) {
      // Fallback only when the render library lacks hpBar() (stub harness); the real material is render's.
      hpMat = new MeshStandardMaterial({ color: PALETTE.ui.success, emissive: PALETTE.ui.success, emissiveIntensity: GLOB_EMISSIVE });
      this._hpMatDisposable = true;
    }
    this._hpMesh = new InstancedMesh(this._hpGeo, hpMat, ZOMBIES.common.hpBarPool);
    this._hpMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this._hpMesh.frustumCulled = false;
    this._hpMesh.castShadow = false;
    this._hpMesh.receiveShadow = false;
    this._hpMesh.count = 0;
    this._hpMesh.name = 'zombies.hpBars';
    if (scene) scene.add(this._hpMesh);
    this._hpMatRange = { start: 0, count: 0 };
    this._hpAttrRange = { start: 0, count: 0 };
    this._globMatRange = { start: 0, count: 0 };
    tagRange(this._hpMesh.instanceMatrix, this._hpMatRange);
    tagRange(this._hpAttr, this._hpAttrRange);

    // --- spit globs -------------------------------------------------------------------------
    const geoGlob = ctx.models && ctx.models.geo ? ctx.models.geo.glob : null;
    if (geoGlob) {
      this._globGeo = geoGlob;
    } else {
      this._globGeo = new IcosahedronGeometry(GLOB_RADIUS, 0);   // ARCH §6.7 "IcosahedronGeometry(0.25, 0)"
      this._globGeoOwned = true;
    }
    this._globMat = new MeshStandardMaterial({
      color: PALETTE.fx.acid, emissive: PALETTE.fx.acid, emissiveIntensity: GLOB_EMISSIVE,
      roughness: GLOB_ROUGHNESS, metalness: PALETTE.material.skin.metalness,
    });
    this._globMesh = new InstancedMesh(this._globGeo, this._globMat, GLOB_CAP);
    this._globMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this._globMesh.frustumCulled = false;
    // QA ENE-15: tiny in-flight globs cast no shadow (the arc-preview decal shows the landing); casting through three's
    // default depth material re-resolved its program against the instanced env casters every frame (GDD §16)
    this._globMesh.castShadow = false;
    this._globMesh.receiveShadow = false;
    tagRange(this._globMesh.instanceMatrix, this._globMatRange);
    this._globMesh.count = 0;
    this._globMesh.name = 'zombies.globs';
    if (scene) scene.add(this._globMesh);
    this._gActive = new Uint8Array(GLOB_CAP);
    this._gX0 = new Float32Array(GLOB_CAP); this._gY0 = new Float32Array(GLOB_CAP); this._gZ0 = new Float32Array(GLOB_CAP);
    this._gTx = new Float32Array(GLOB_CAP); this._gTz = new Float32Array(GLOB_CAP);
    this._gT = new Float32Array(GLOB_CAP); this._gDur = new Float32Array(GLOB_CAP);
    this._gKills = new Uint8Array(GLOB_CAP);
    this._gDecal = new Int32Array(GLOB_CAP).fill(-1);
    this._gPreview = new Uint8Array(GLOB_CAP);
    this._gOwner = new Int32Array(GLOB_CAP).fill(-1);

    // --- listeners ------------------------------------------------------------------------------
    if (ctx.events) {
      const self = this;
      this._offQuality = ctx.events.on('quality:change', function onQuality(p) { self._applyQuality(p.params); });
    }

    this.reset();
    return this;
  }

  /** Returns the system to the level-start state without allocating: every zombie and glob gone. */
  reset() {
    const fx = this.ctx.fx;
    // free every character instance from the top down (never triggers a swap) and clear the SoA
    for (let t = 0; t < NTYPES; t++) {
      const inst = this._inst[t];
      for (let i = this._instCount[t] - 1; i >= 0; i--) inst.free(i);
      this._instCount[t] = 0;
      const map = this._instToSlot[t];
      for (let i = 0; i < map.length; i++) map[i] = -1;
      // free stack: highest slot on the bottom so the first spawn takes the type's base slot
      const stack = this._freeStack[t];
      const base = SLOT_BASE[t], n = DEF[t].pool;
      for (let k = 0; k < n; k++) stack[k] = base + (n - 1 - k);
      this._freeTop[t] = n;
      this._aliveByType[t] = 0;
      if (inst.mesh) { inst.mesh.count = 0; inst.mesh.visible = false; }
      inst.commit();
    }
    const render = this.ctx.render;
    for (let s = 0; s < CAP; s++) {
      if (this._state[s] !== S_FREE && this._ringDecal[s] >= 0 && fx) fx.removeDecal(this._ringDecal[s]);
      this._ringDecal[s] = -1;
      this._state[s] = S_FREE;
      this._flags[s] = 0;
      this._slotToInst[s] = -1;
      this._guardEvent[s] = -1;
      this._guardLane[s] = -1;
      this._burnUntil[s] = 0;
      this._binNext[s] = -1;
      if (this._hasBlob) render.blobShadowSlot(BLOB_BASE + s, 0, 0, 0);
    }
    for (let b = 0; b < NBINS; b++) this._binHead[b] = -1;
    this._alive = 0;
    // globs
    for (let g = 0; g < GLOB_CAP; g++) {
      if (this._gActive[g] && this._gDecal[g] >= 0 && fx) fx.removeDecal(this._gDecal[g]);
      this._gActive[g] = 0;
      this._gDecal[g] = -1;
      this._gPreview[g] = 0;
    }
    this._gCount = 0;
    this._globMesh.count = 0; this._globMesh.visible = false;
    this._hpMesh.count = 0; this._hpMesh.visible = false;
    this._t = 0;
    this._prevSquadX = this.ctx.squad ? this.ctx.squad.x : 0;
    this._squadVx = 0;
  }

  /** Removes the listener and disposes the GPU objects this module created. */
  dispose() {
    if (this._offQuality) { this._offQuality(); this._offQuality = null; }
    const scene = this.ctx.render ? this.ctx.render.scene : null;
    for (let t = 0; t < NTYPES; t++) {
      const inst = this._inst[t];
      if (!inst) continue;
      if (inst.mesh) { if (scene) scene.remove(inst.mesh); else if (inst.mesh.parent) inst.mesh.parent.remove(inst.mesh); }
      if (typeof inst.dispose === 'function') inst.dispose();
      inst.onMove = null;
    }
    if (this._hpMesh) {
      if (scene) scene.remove(this._hpMesh);
      this._hpMesh.dispose();
      if (this._hpMatDisposable && this._hpMesh.material) this._hpMesh.material.dispose();
    }
    if (this._hpGeo) this._hpGeo.dispose();
    if (this._globMesh) {
      if (scene) scene.remove(this._globMesh);
      this._globMesh.dispose();
    }
    if (this._globMat) this._globMat.dispose();
    if (this._globGeoOwned && this._globGeo) this._globGeo.dispose();
  }

  /** Builds the onMove(from, to) callback of one pool (created once in init, allocation-free at call). */
  _makeOnMove(t) {
    const self = this;
    return function onMove(from, to) {
      if (from === to) return;
      const map = self._instToSlot[t];
      const slot = map[from];
      map[to] = slot;
      map[from] = -1;
      if (slot >= 0) self._slotToInst[slot] = to;
    };
  }

  /** quality:change → shadow casting per class (the HP-bar policy is read live from ctx.quality.params). */
  _applyQuality(params) {
    const on = !!(params && params.shadows);
    this._hasBlob = !!(this.ctx.render && typeof this.ctx.render.blobShadowSlot === 'function');
    for (let t = 0; t < NTYPES; t++) {
      const mesh = this._inst[t].mesh;
      if (mesh) mesh.castShadow = on && DEF[t].shadow;
    }
    if (this._globMesh) this._globMesh.castShadow = false;   // QA ENE-15: globs never cast (see init)
  }

  // -------------------------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------------------------

  /**
   * Spawns one zombie. Returns its stable id, or −1 when the type's pool is full (the request is
   * dropped and ctx.debug.dropped['zombies.<type>'] incremented).
   * opts: { guardEventId, guardLane, lunge } — lunge makes a crawler lunge from the start.
   */
  spawn(type, x, z, hp, opts) {
    const t = TYPE_INDEX[type];
    if (t === undefined) return -1;
    if (this._freeTop[t] <= 0) { noteDropped(this.ctx, 'zombies.' + type); return -1; }
    const inst = this._inst[t];
    const i = inst.alloc();
    if (i < 0) { noteDropped(this.ctx, 'zombies.' + type); return -1; }
    const slot = this._freeStack[t][--this._freeTop[t]];
    const def = DEF[t];
    const ctx = this.ctx;
    const rng = ctx.rng;
    const rngFx = ctx.rngFx;

    this._instToSlot[t][i] = slot;
    this._slotToInst[slot] = i;
    this._instCount[t]++;

    const xMax = ROAD_HALF - def.radius;
    x = clamp(x, -xMax, xMax);
    this._x[slot] = x; this._z[slot] = z;
    this._vx[slot] = 0; this._vz[slot] = ctx.world.roadSpeed + def.speed;
    hp = hp > 1 ? hp : 1;                                   // LEAK_MODEL.minHp: never below 1 HP
    this._hp[slot] = hp; this._maxHp[slot] = hp;
    this._phase[slot] = rng.range(0, TWO_PI);
    this._timer[slot] = 0; this._timer2[slot] = 0; this._aux[slot] = 0;
    this._hitTime[slot] = CLEAR_HIT_TIME; this._flashT[slot] = CLEAR_HIT_TIME; this._deathTime[slot] = 0; this._burnUntil[slot] = 0;
    this._homeX[slot] = x; this._targetX[slot] = x;
    this._yaw[slot] = Math.PI;                              // facing +Z (toward the squad)
    this._pitch[slot] = 0; this._lean[slot] = 0;
    this._staggerNext[slot] = hp * (1 - ZOMBIES.brute.staggerEvery);
    this._dust[slot] = 0;
    this._swings[slot] = 0; this._backZ[slot] = 0;
    this._state[slot] = S_ALIVE;
    this._type[slot] = t;
    this._flags[slot] = 0;
    this._guardEvent[slot] = opts && opts.guardEventId !== undefined ? opts.guardEventId : -1;
    this._guardLane[slot] = opts && opts.guardLane !== undefined ? opts.guardLane : -1;
    this._ringDecal[slot] = -1;

    // per-type timers
    if (t === T_RUNNER) this._timer[slot] = rng.range(0, ZOMBIES.runner.zigzag.retarget);
    else if (t === T_SPITTER) this._timer[slot] = rng.range(SPIT_FIRST_DELAY[0], SPIT_FIRST_DELAY[1]);
    if (t === T_CRAWLER && opts && opts.lunge) this._flags[slot] |= F_LUNGE | F_LUNGE_TOLD;

    // cosmetic tint jitter (ZOMBIES.common.tintJitter) from the fx rng — never perturbs gameplay
    const j = ZOMBIES.common.tintJitter;
    const r = 1 + (rngFx.next() * 2 - 1) * j;
    const g = 1 + (rngFx.next() * 2 - 1) * j;
    const b = 1 + (rngFx.next() * 2 - 1) * j;
    this._tintR[slot] = r; this._tintG[slot] = g; this._tintB[slot] = b;

    inst.setPhase(i, this._phase[slot]);
    inst.setSpeed(i, (this._flags[slot] & F_LUNGE) ? ANIM_SPEED_LUNGE : 1);
    inst.setHit(i, CLEAR_HIT_TIME);
    inst.setFire(i, CLEAR_HIT_TIME);
    inst.setDeath(i, 0);
    inst.setTint(i, r, g, b);
    inst.writeMatrix(i, x, 0, z, Math.PI, 0, 1);

    this._alive++;
    this._aliveByType[t]++;

    const id = makeId(slot, this._gen[slot]);
    P_SPAWN.id = id; P_SPAWN.type = type; P_SPAWN.x = x; P_SPAWN.z = z; P_SPAWN.hp = hp;
    ctx.events.emit('zombie:spawn', P_SPAWN);
    return id;
  }

  /**
   * Lays out and spawns a wave (GDD §6.2 patterns). `wave` = { pattern, units:{type:n}, spread?, x?, z?,
   * guardEventId?, guardLane? }, `hpByType` = { type: hp }. Returns the number spawned.
   *   line    — even across x ∈ ±WAVE_PATTERNS.line.xRange (a guard line centres on wave.x, ±GUARD_LINE_HALF), same z (+ spread jitter)
   *   column  — single file at wave.x, WAVE_PATTERNS.column.gap apart
   *   horde   — uniform in a box of WAVE_PATTERNS.horde.box (depth = spread when given)
   *   flank   — alternating clusters at x = ±WAVE_PATTERNS.flank.x, z spread WAVE_PATTERNS.flank.spread
   *   pincer  — runners from both road edges, every other type in the centre, z spread WAVE_PATTERNS.pincer.spread
   *   wall    — brute line in front, crawler carpet WAVE_PATTERNS.wall.carpetGap behind, other types between
   */
  spawnWave(wave, hpByType) {
    const rng = this.ctx.rng;
    const units = wave.units;
    if (!units) return 0;
    // flatten the unit list into UNIT_ORDER (type index per unit), grouped by type
    let n = 0;
    for (let t = 0; t < NTYPES && n < CAP; t++) {
      const k = units[TYPES[t]] | 0;
      for (let u = 0; u < k && n < CAP; u++) UNIT_ORDER[n++] = t;
    }
    if (n === 0) return 0;
    const pattern = wave.pattern || ZOMBIES.common.firstWavePattern;
    const baseZ = wave.z !== undefined ? wave.z : WORLD.spawnZ;
    const cx = wave.x !== undefined ? wave.x : 0;
    const hasX = wave.x !== undefined;
    const opts = SPAWN_OPTS;
    opts.guardEventId = wave.guardEventId !== undefined ? wave.guardEventId : -1;
    opts.guardLane = wave.guardLane !== undefined ? wave.guardLane : -1;
    opts.lunge = false;
    let spawned = 0;

    if (pattern === 'column') {
      const gap = WAVE_PATTERNS.column.gap;
      shuffleUnits(rng, UNIT_ORDER, n);
      for (let k = 0; k < n; k++) {
        if (this._spawnUnit(UNIT_ORDER[k], cx, baseZ - k * gap, hpByType, opts)) spawned++;
      }
    } else if (pattern === 'horde') {
      const box = WAVE_PATTERNS.horde.box;
      const depth = wave.spread !== undefined ? wave.spread : box[1];
      const halfW = box[0] / 2;
      shuffleUnits(rng, UNIT_ORDER, n);
      for (let k = 0; k < n; k++) {
        const x = cx + rng.range(-halfW, halfW);
        const z = baseZ - rng.range(0, depth);
        if (this._spawnUnit(UNIT_ORDER[k], x, z, hpByType, opts)) spawned++;
      }
    } else if (pattern === 'flank') {
      const fx = WAVE_PATTERNS.flank.x;
      const depth = wave.spread !== undefined ? wave.spread : WAVE_PATTERNS.flank.spread;
      shuffleUnits(rng, UNIT_ORDER, n);
      for (let k = 0; k < n; k++) {
        const side = (k & 1) === 0 ? -1 : 1;
        const x = side * fx + rng.range(-FLANK_JITTER, FLANK_JITTER);
        const z = baseZ - rng.range(0, depth);
        if (this._spawnUnit(UNIT_ORDER[k], x, z, hpByType, opts)) spawned++;
      }
    } else if (pattern === 'pincer') {
      const edge = WAVE_PATTERNS.line.xRange;
      const depth = wave.spread !== undefined ? wave.spread : WAVE_PATTERNS.pincer.spread;
      let side = -1;
      for (let k = 0; k < n; k++) {
        const t = UNIT_ORDER[k];
        let x;
        if (t === T_RUNNER) { x = side * edge; side = -side; }
        else x = cx + rng.range(-PINCER_CENTRE_HALF, PINCER_CENTRE_HALF);
        const z = baseZ - rng.range(0, depth);
        if (this._spawnUnit(t, x, z, hpByType, opts)) spawned++;
      }
    } else if (pattern === 'wall') {
      const range = WAVE_PATTERNS.line.xRange;
      const gap = WAVE_PATTERNS.wall.carpetGap;
      const depth = wave.spread !== undefined ? wave.spread : WAVE_PATTERNS.flank.spread;
      const brutes = units.brute | 0, crawlers = units.crawler | 0;
      const others = n - brutes - crawlers;
      let bi = 0, oi = 0;
      for (let k = 0; k < n; k++) {
        const t = UNIT_ORDER[k];
        let x, z;
        if (t === T_BRUTE) {                                   // brute line in front, evenly spaced
          x = brutes === 1 ? cx : cx - range + (2 * range) * ((bi + 0.5) / brutes);
          z = baseZ;
          bi++;
        } else if (t === T_CRAWLER) {                          // carpet behind the wall
          x = cx + rng.range(-range, range);
          z = baseZ - gap - rng.range(0, depth);
        } else {                                               // everything else: a line between
          x = others === 1 ? cx : cx - range + (2 * range) * ((oi + 0.5) / others);
          z = baseZ - gap / 2;
          oi++;
        }
        if (this._spawnUnit(t, x, z, hpByType, opts)) spawned++;
      }
    } else {                                                   // 'line' (default)
      const half = hasX ? GUARD_LINE_HALF : WAVE_PATTERNS.line.xRange;
      const spread = wave.spread !== undefined ? wave.spread : WAVE_PATTERNS.line.spread;
      shuffleUnits(rng, UNIT_ORDER, n);
      for (let k = 0; k < n; k++) {
        const x = n === 1 ? cx : cx - half + (2 * half) * ((k + 0.5) / n);
        const z = spread > 0 ? baseZ - rng.range(0, spread) : baseZ;
        if (this._spawnUnit(UNIT_ORDER[k], x, z, hpByType, opts)) spawned++;
      }
    }
    return spawned;
  }

  /** spawnWave helper: one unit of type index t with the wave's HP for that type. */
  _spawnUnit(t, x, z, hpByType, opts) {
    const type = TYPES[t];
    const hp = hpByType && hpByType[type] !== undefined ? hpByType[type] : DEF[t].baseHp;
    return this.spawn(type, x, z, hp, opts) >= 0;
  }

  // -------------------------------------------------------------------------------------------
  // Id handling and counters
  // -------------------------------------------------------------------------------------------

  /** Slot of a live (alive) id, or −1 when the handle is stale / dying / free. */
  _aliveSlot(id) {
    if (id < 0) return -1;
    const slot = id & ID_SLOT_MASK;
    if (slot >= CAP) return -1;
    if (this._state[slot] !== S_ALIVE) return -1;
    if (((id >>> ID_SLOT_BITS) & GEN_MASK) !== (this._gen[slot] & GEN_MASK)) return -1;
    return slot;
  }

  /** Slot of an alive-or-dying id (position / typeOf still answer for a toppling body), else −1. */
  _knownSlot(id) {
    if (id < 0) return -1;
    const slot = id & ID_SLOT_MASK;
    if (slot >= CAP) return -1;
    if (this._state[slot] === S_FREE) return -1;
    if (((id >>> ID_SLOT_BITS) & GEN_MASK) !== (this._gen[slot] & GEN_MASK)) return -1;
    return slot;
  }

  /** Number of alive zombies (dying bodies excluded). */
  get alive() { return this._alive; }

  /** Alive count of one type. (The contract spells this `get aliveOfType(type)`; a getter cannot take an argument.) */
  aliveOfType(type) {
    const t = TYPE_INDEX[type];
    return t === undefined ? 0 : this._aliveByType[t];
  }

  // -------------------------------------------------------------------------------------------
  // Queries (ARCH §7) — every one reads only alive entries through the z-bins
  // -------------------------------------------------------------------------------------------

  /** True when slot is a crawler that bullets cannot reach yet (GDD §6.1 / ARCH §7 hittableZ rule). */
  _belowBullets(slot) {
    return this._type[slot] === T_CRAWLER && this._z[slot] <= ZOMBIES.crawler.hittableZ && (this._flags[slot] & F_LUNGE) === 0;
  }

  /**
   * Nearest alive zombie whose vertical capsule (radius ZOMBIES[type].radius) intersects the swept
   * segment (x0,z0)→(x1,z1) inflated by `radius`. out = { id, x, y, z, t }; t ∈ [0,1].
   */
  hitTestSegment(x0, z0, x1, z1, radius, out) {
    SEG_Q[0] = x0; SEG_Q[1] = z0; SEG_Q[2] = x1; SEG_Q[3] = z1;
    return this.hitTestSeg(SEG_Q, radius, out);
  }

  /**
   * hitTestSegment() reading the segment from a Float64Array(4) [x0, z0, x1, z1] (QA ENE-16 / WPN-8): same
   * semantics and `out` shape; the coordinates never cross a call boundary as doubles (no HeapNumber boxing).
   * Fully inlined (bins, crawler rule, radii) so the per-bullet query allocates nothing.
   */
  hitTestSeg(seg, radius, out) {
    const x0 = seg[0], z0 = seg[1], x1 = seg[2], z1 = seg[3];
    const dx = x1 - x0, dz = z1 - z0;
    const len2 = dx * dx + dz * dz;
    const pad = radius + MAX_RADIUS;
    let b0 = Math.floor(((z0 < z1 ? z0 : z1) - pad - BIN_MIN) / BIN_SIZE);
    let b1 = Math.floor(((z0 > z1 ? z0 : z1) + pad - BIN_MIN) / BIN_SIZE);
    if (b0 < 0) b0 = 0; else if (b0 >= NBINS) b0 = NBINS - 1;
    if (b1 < 0) b1 = 0; else if (b1 >= NBINS) b1 = NBINS - 1;
    const heads = this._binHead, next = this._binNext;
    const X = this._x, Z = this._z, state = this._state, type = this._type, flags = this._flags;
    let bestT = 2, bestSlot = -1;
    for (let b = b0; b <= b1; b++) {
      for (let s = heads[b]; s >= 0; s = next[s]) {
        if (state[s] !== S_ALIVE) continue;
        const ty = type[s];
        const zs = Z[s];
        if (ty === T_CRAWLER && zs <= CRAWLER_HITTABLE_Z && (flags[s] & F_LUNGE) === 0) continue;   // below the bullets
        const px = X[s] - x0, pz = zs - z0;
        let t = 0;
        if (len2 > 0) {
          t = (px * dx + pz * dz) / len2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
        }
        const cx = x0 + dx * t - X[s], cz = z0 + dz * t - zs;
        const r = RADIUS[ty] + radius;
        if (cx * cx + cz * cz <= r * r && t < bestT) { bestT = t; bestSlot = s; }
      }
    }
    if (bestSlot < 0) return false;
    const h = HEIGHT[type[bestSlot]];
    out.id = ((this._gen[bestSlot] & GEN_MASK) << ID_SLOT_BITS) | bestSlot;
    out.t = bestT;
    out.x = x0 + dx * bestT;
    out.z = z0 + dz * bestT;
    out.y = BULLET_Y < h ? BULLET_Y : h;
    return true;
  }

  /**
   * Applies `amount` damage to one zombie. Returns true when it died; false (and emits nothing) for a
   * stale / dying / free id. Emits zombie:hit, then zombie:die and (cause ∉ bite|cleanup) coin:pickup.
   * Burning zombies take +TROOPS.flamer.burnBonus from cause 'bullet' (ARCH §6.7 setBurning).
   */
  damage(id, amount, x, y, z, cause) {
    const slot = this._aliveSlot(id);
    if (slot < 0) return false;
    return this._damageSlot(slot, amount, x, y, z, cause);
  }

  /** damage() on a validated alive slot. */
  _damageSlot(slot, amount, x, y, z, cause) {
    const ctx = this.ctx;
    const t = this._type[slot];
    if (cause === 'bullet' && this._burnUntil[slot] > this._t) amount *= 1 + TROOPS.flamer.burnBonus;
    let hp = this._hp[slot] - amount;
    const killed = hp <= 0;
    if (hp < 0) hp = 0;
    this._hp[slot] = hp;
    this._flags[slot] |= F_HIT;
    this._hitTime[slot] = this._t;
    const inst = this._inst[t];
    const i = this._slotToInst[slot];
    // 60 ms white flash (ZOMBIES.common.hitFlash) in the shader, at most once per hitFlashRetrigger s: under sustained
    // fire a zombie blinks and keeps its colours instead of rendering as a white silhouette
    if (this._t - this._flashT[slot] >= HIT_FLASH_RETRIGGER) {
      this._flashT[slot] = this._t;
      inst.setHit(i, ctx.render.uniforms.uTime.value);
    }

    // brute stagger every ZOMBIES.brute.staggerEvery of max HP (GDD §6.1: 0.3 s freeze + flash)
    if (!killed && t === T_BRUTE && hp <= this._staggerNext[slot]) {
      const step = ZOMBIES.brute.staggerEvery * this._maxHp[slot];
      while (this._staggerNext[slot] >= hp && this._staggerNext[slot] > 0) this._staggerNext[slot] -= step;
      this._timer2[slot] = ZOMBIES.brute.stagger.freeze;
      inst.setSpeed(i, 0);
      if (this._flashT[slot] !== this._t) { this._flashT[slot] = this._t; inst.setHit(i, ctx.render.uniforms.uTime.value); }   // the stagger always flashes
      P_STAGGER.id = makeId(slot, this._gen[slot]); P_STAGGER.x = this._x[slot]; P_STAGGER.z = this._z[slot];
      ctx.events.emit('zombie:stagger', P_STAGGER);
    }

    P_HIT.id = makeId(slot, this._gen[slot]); P_HIT.type = TYPES[t];
    P_HIT.x = x; P_HIT.y = y; P_HIT.z = z; P_HIT.damage = amount; P_HIT.hp = hp; P_HIT.maxHp = this._maxHp[slot]; P_HIT.killed = killed;
    ctx.events.emit('zombie:hit', P_HIT);

    if (killed) this._die(slot, cause);
    return killed;
  }

  /** Area damage: every alive zombie whose capsule touches the circle (x, z, r). Returns kills. */
  damageInCircle(x, z, r, amount, cause) {
    const pad = r + MAX_RADIUS;
    const b0 = binOf(z - pad), b1 = binOf(z + pad);
    const heads = this._binHead, next = this._binNext;
    const X = this._x, Z = this._z, state = this._state, type = this._type;
    let kills = 0;
    for (let b = b0; b <= b1; b++) {
      for (let s = heads[b]; s >= 0; s = next[s]) {
        if (state[s] !== S_ALIVE) continue;
        const def = DEF[type[s]];
        const dx = X[s] - x, dz = Z[s] - z;
        const rr = r + def.radius;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (this._damageSlot(s, amount, X[s], def.height * HIT_Y_FRAC, Z[s], cause)) kills++;
      }
    }
    return kills;
  }

  /**
   * Cone damage from (x, z) along (dirX, dirZ) with half angle `halfAngle` (degrees per ARCH §6.6
   * `coneDeg/2`; a value ≤ π is accepted as radians) within `range`. Returns kills.
   */
  damageInCone(x, z, dirX, dirZ, halfAngle, range, amount, cause) {
    const half = halfAngle > Math.PI ? halfAngle * DEG2RAD : halfAngle;
    let dl = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (dl === 0) { dirX = 0; dirZ = -1; dl = 1; }
    dirX /= dl; dirZ /= dl;
    const pad = range + MAX_RADIUS;
    const b0 = binOf(z - pad), b1 = binOf(z + pad);
    const heads = this._binHead, next = this._binNext;
    const X = this._x, Z = this._z, state = this._state, type = this._type;
    let kills = 0;
    for (let b = b0; b <= b1; b++) {
      for (let s = heads[b]; s >= 0; s = next[s]) {
        if (state[s] !== S_ALIVE) continue;
        const def = DEF[type[s]];
        const dx = X[s] - x, dz = Z[s] - z;
        const d2 = dx * dx + dz * dz;
        const reach = range + def.radius;
        if (d2 > reach * reach) continue;
        const d = Math.sqrt(d2);
        let inside;
        if (d <= def.radius) inside = true;                       // standing on the nozzle
        else {
          const cosAng = (dx * dirX + dz * dirZ) / d;
          const allowed = half + Math.asin(def.radius / d < 1 ? def.radius / d : 1);
          inside = cosAng >= Math.cos(allowed < Math.PI ? allowed : Math.PI);
        }
        if (!inside) continue;
        if (this._damageSlot(s, amount, X[s], def.height * HIT_Y_FRAC, Z[s], cause)) kills++;
      }
    }
    return kills;
  }

  /**
   * Line damage (railgun bolt / laser beam): zombies with |zx − x| ≤ halfWidth + radius and
   * zMin ≤ zz ≤ z0, nearest (largest z) first when maxTargets is finite; the crawler hittableZ rule
   * applies (the beam flies at bullet height). Returns kills.
   */
  damageInLine(x, z0, halfWidth, amount, cause, maxTargets = Infinity, zMin = WORLD.spawnZ) {
    if (zMin > z0) return 0;
    const b0 = binOf(zMin - MAX_RADIUS), b1 = binOf(z0 + MAX_RADIUS);
    const heads = this._binHead, next = this._binNext;
    const X = this._x, Z = this._z, state = this._state, type = this._type;
    const cand = this._cand;
    let n = 0;
    for (let b = b0; b <= b1; b++) {
      for (let s = heads[b]; s >= 0; s = next[s]) {
        if (state[s] !== S_ALIVE) continue;
        const zz = Z[s];
        if (zz < zMin || zz > z0) continue;
        if (this._belowBullets(s)) continue;
        const w = halfWidth + DEF[type[s]].radius;
        const dx = X[s] - x;
        if (dx > w || dx < -w) continue;
        cand[n++] = s;
      }
    }
    if (n === 0) return 0;
    if (maxTargets < n) {
      // partial selection: bring the k largest-z candidates to the front (k ≤ 8 for the drone / tests)
      const k = maxTargets | 0;
      for (let a = 0; a < k; a++) {
        let best = a;
        for (let c = a + 1; c < n; c++) if (Z[cand[c]] > Z[cand[best]]) best = c;
        if (best !== a) { const tmp = cand[a]; cand[a] = cand[best]; cand[best] = tmp; }
      }
      n = k;
    }
    let kills = 0;
    for (let c = 0; c < n; c++) {
      const s = cand[c];
      if (state[s] !== S_ALIVE) continue;               // a listener could not have killed it, but stay safe
      const def = DEF[type[s]];
      if (this._damageSlot(s, amount, X[s], FIRE.bullet.y < def.height ? FIRE.bullet.y : def.height, Z[s], cause)) kills++;
    }
    return kills;
  }

  /** Marks a zombie as burning for `seconds` (orange tint; +burnBonus bullet damage while it lasts). */
  setBurning(id, seconds) {
    const slot = this._aliveSlot(id);
    if (slot < 0) return;
    const until = this._t + seconds;
    if (until > this._burnUntil[slot]) this._burnUntil[slot] = until;
  }

  /** True while the zombie is burning (so a bullet tester can show the bonus; the bonus itself is applied here). */
  isBurning(id) {
    const slot = this._aliveSlot(id);
    return slot >= 0 && this._burnUntil[slot] > this._t;
  }

  /** Highest-HP alive zombie in front of the squad (z < 0): the sniper's target. out = { id, x, y, z, hp }. */
  highestHp(out) {
    const X = this._x, Z = this._z, H = this._hp, state = this._state;
    let best = -1, bestHp = -1;
    for (let s = 0; s < CAP; s++) {
      if (state[s] !== S_ALIVE || Z[s] >= 0) continue;
      if (H[s] > bestHp) { bestHp = H[s]; best = s; }
    }
    if (best < 0) return false;
    out.id = makeId(best, this._gen[best]);
    out.x = X[best]; out.z = Z[best]; out.y = DEF[this._type[best]].height * HIT_Y_FRAC; out.hp = bestHp;
    return true;
  }

  /** Nearest alive zombie to (x, z) over the given slot range. */
  _nearestIn(from, to, x, z, out) {
    const X = this._x, Z = this._z, state = this._state;
    let best = -1, bestD = Infinity;
    for (let s = from; s < to; s++) {
      if (state[s] !== S_ALIVE) continue;
      const dx = X[s] - x, dz = Z[s] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best < 0) return false;
    out.id = makeId(best, this._gen[best]);
    out.x = X[best]; out.z = Z[best]; out.y = DEF[this._type[best]].height * HIT_Y_FRAC;
    return true;
  }

  /** Nearest alive zombie to (x, z). out = { id, x, y, z }. */
  nearest(x, z, out) { return this._nearestIn(0, CAP, x, z, out); }

  /** Nearest alive zombie of one type. */
  nearestOfType(type, x, z, out) {
    const t = TYPE_INDEX[type];
    if (t === undefined) return false;
    return this._nearestIn(SLOT_BASE[t], SLOT_END[t], x, z, out);
  }

  /** Foot position of an alive or dying zombie into out (unchanged for a stale id). Returns out. */
  position(id, out) {
    const slot = this._knownSlot(id);
    if (slot >= 0) out.set(this._x[slot], 0, this._z[slot]);
    return out;
  }

  /** Type name of an alive or dying zombie; '' for a stale id. */
  typeOf(id) {
    const slot = this._knownSlot(id);
    return slot < 0 ? '' : TYPES[this._type[slot]];
  }

  /** Current HP of an alive zombie; 0 otherwise. */
  hpOf(id) {
    const slot = this._aliveSlot(id);
    return slot < 0 ? 0 : this._hp[slot];
  }

  /** Kills every alive zombie (level end: 'cleanup' pays no coins). Bodies still topple. */
  killAll(cause = 'cleanup') {
    for (let s = 0; s < CAP; s++) {
      if (this._state[s] === S_ALIVE) this._die(s, cause);
    }
  }

  /** Debug / tools iteration over the alive set: fn(id, type, x, z, hp). Killing the current zombie inside fn is safe. */
  forEachAlive(fn) {
    const X = this._x, Z = this._z, H = this._hp, state = this._state, type = this._type;
    for (let s = 0; s < CAP; s++) {
      if (state[s] !== S_ALIVE) continue;
      fn(makeId(s, this._gen[s]), TYPES[type[s]], X[s], Z[s], H[s]);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Death and recycling
  // -------------------------------------------------------------------------------------------

  /** alive → dying: topple + sink animation, slot freed after ZOMBIES.common.death.free; emits zombie:die (+ coin:pickup). */
  _die(slot, cause) {
    const ctx = this.ctx;
    const t = this._type[slot];
    const type = TYPES[t];
    const x = this._x[slot], z = this._z[slot];
    this._state[slot] = S_DYING;
    this._deathTime[slot] = this._t;
    this._alive--;
    this._aliveByType[t]--;
    if (this._ringDecal[slot] >= 0) { ctx.fx.removeDecal(this._ringDecal[slot]); this._ringDecal[slot] = -1; }
    const inst = this._inst[t];
    const i = this._slotToInst[slot];
    inst.setSpeed(i, 0);
    // a body topples away from the squad along its facing; freeze the lateral motion, keep the road scroll
    this._vx[slot] = 0;
    this._vz[slot] = ctx.world.roadSpeed;
    this._pitch[slot] = 0;

    P_DIE.id = makeId(slot, this._gen[slot]); P_DIE.type = type; P_DIE.x = x; P_DIE.z = z; P_DIE.cause = cause;
    ctx.events.emit('zombie:die', P_DIE);
    if (cause !== 'bite' && cause !== 'cleanup') {
      P_COIN.amount = ECONOMY.kill[type]; P_COIN.x = x; P_COIN.y = DEF[t].height * COIN_Y_FRAC; P_COIN.z = z; P_COIN.source = 'kill';
      ctx.events.emit('coin:pickup', P_COIN);
    }
  }

  /** Behind-the-camera recycle (z > WORLD.despawnZ): zombie:die {cause:'cleanup'} and the slot is freed at once. */
  _recycle(slot) {
    this._die(slot, 'cleanup');
    this._free(slot);
  }

  /** dying → free: releases the instance (swap-remove via onMove) and bumps the generation. */
  _free(slot) {
    const t = this._type[slot];
    const i = this._slotToInst[slot];
    this._slotToInst[slot] = -1;
    if (i >= 0) {
      // clear our entry first: inst.free(i) swap-removes and calls onMove(last, i) synchronously, which
      // then writes the moved slot into map[i]; when i IS the last instance nothing moves and map[i] stays −1
      this._instToSlot[t][i] = -1;
      this._inst[t].free(i);
      this._instCount[t]--;
    }
    this._state[slot] = S_FREE;
    this._flags[slot] = 0;
    this._gen[slot] = (this._gen[slot] + 1) & GEN_MASK;
    this._burnUntil[slot] = 0;
    this._guardEvent[slot] = -1;
    this._guardLane[slot] = -1;
    if (this._ringDecal[slot] >= 0) { this.ctx.fx.removeDecal(this._ringDecal[slot]); this._ringDecal[slot] = -1; }
    this._freeStack[t][this._freeTop[t]++] = slot;
    if (this._hasBlob) this.ctx.render.blobShadowSlot(BLOB_BASE + slot, 0, 0, 0);   // hide the disc of a freed slot
  }

  // -------------------------------------------------------------------------------------------
  // Simulation (ARCH §4.2 step order: weapons already ran this step, boss/gates/pickups follow)
  // -------------------------------------------------------------------------------------------

  /** Scroll + AI, contact / bites, globs, deaths, z-bins rebuild. dt = the scaled fixed step. */
  step(dt) {
    const ctx = this.ctx;
    const squad = ctx.squad;
    this._t += dt;
    this._dt = dt;
    this._road = ctx.world.roadSpeed;
    const sx = squad.x;
    // squad lateral velocity estimate (smoothed) for the spit lead (lerpExp written inline: no boxed helper call)
    this._squadVx += ((sx - this._prevSquadX) / dt - this._squadVx) * (1 - Math.exp(-SQUAD_VX_SMOOTH * dt));
    this._prevSquadX = sx;
    this._sx = sx;
    this._scz = squad.centerZ;

    const state = this._state, Z = this._z;
    const freeAfter = ZOMBIES.common.death.free;
    const road = this._road, now = this._t;
    for (let t = 0; t < NTYPES; t++) {
      const from = SLOT_BASE[t], to = SLOT_END[t];
      for (let s = from; s < to; s++) {
        const st = state[s];
        if (st === S_DYING) {
          // the body is carried by the road; freed after death.free or once behind the camera
          Z[s] += road * dt;
          if (now - this._deathTime[s] >= freeAfter || Z[s] > WORLD.despawnZ) this._free(s);
          continue;
        }
        if (st !== S_ALIVE) continue;
        this._stepAlive(s, t);
      }
    }
    this._stepGlobs();
    this._rebuildBins();
  }

  /**
   * One alive zombie: type AI → contact → integrate → facing / burn / ring decal. dt = this._dt.
   * QA ENE-16: only integers (slot, type) cross a call boundary — each stage reads and writes the slot's typed arrays
   * (the AI writes the desired velocity into _vx / _vz, the brute's stagger freeze is the F_FROZEN bit), the math
   * helpers (clamp, lerpExp, yaw wrap) are written inline, and every stage is small enough for the optimizing tier
   * to keep its doubles unboxed, so the per-zombie step allocates nothing. Rare events (telegraphs, bites) still
   * pass x/z to their emitters.
   */
  _stepAlive(s, t) {
    if (t === T_WALKER) this._aiWalker(s);
    else if (t === T_RUNNER) this._aiRunner(s);
    else if (t === T_CRAWLER) this._aiCrawler(s);
    else if (t === T_BRUTE) this._aiBrute(s);
    else this._aiSpitter(s);
    if (this._contact(s, t)) return;                       // bit and died
    this._integrate(s, t);
  }

  /** Walker (GDD §6.1): lane drift x += 0.4·sin(1.1t + φ) around the spawn x. */
  _aiWalker(s) {
    const d = ZOMBIES.walker.drift;
    const xd = this._homeX[s] + d.amp * Math.sin(d.freq * this._t + this._phase[s]);
    this._vx[s] = (xd - this._x[s]) / this._dt;
    this._vz[s] = this._road + SPEED[T_WALKER];
  }

  /** Runner (GDD §6.1): zig-zag around a centre that re-targets squad x every 0.5 s; screech at 20 m, lean. */
  _aiRunner(s) {
    const dt = this._dt;
    const z = this._z[s];
    let flags = this._flags[s];
    const zz = ZOMBIES.runner.zigzag;
    let timer = this._timer[s] - dt;
    if (timer <= 0) { this._targetX[s] = this._sx; timer += zz.retarget; }
    this._timer[s] = timer;
    const hx = this._homeX[s];
    const nhx = hx + (this._targetX[s] - hx) * (1 - Math.exp(-RUNNER_LATERAL_RATE * dt));
    this._homeX[s] = nhx;
    const xd = nhx + zz.amp * Math.sin(TWO_PI * this._t / zz.period + this._phase[s]);
    this._vx[s] = (xd - this._x[s]) / dt;
    this._vz[s] = this._road + SPEED[T_RUNNER];
    if ((flags & F_SCREECH) === 0 && z >= ZOMBIES.runner.screechZ) {
      flags |= F_SCREECH;
      this._flags[s] = flags;
      this._emitTelegraphAt(s, 'screech', 0, 0);
    }
    // lean into the sprint after the screech
    const lean = this._lean[s];
    const nl = lean + (((flags & F_SCREECH) ? RUNNER_SCREECH_LEAN : 0) - lean) * (1 - Math.exp(-RUNNER_LEAN_RATE * dt));
    this._lean[s] = nl;
    this._pitch[s] = -nl;
  }

  /** Crawler (GDD §6.1): lunges 6 m/s (homing x) inside lunge.dist, dust trail. */
  _aiCrawler(s) {
    const dt = this._dt, road = this._road;
    const z = this._z[s];
    let flags = this._flags[s];
    const lg = ZOMBIES.crawler.lunge;
    if ((flags & F_LUNGE) === 0 && z >= -lg.dist) {
      flags |= F_LUNGE;
      this._inst[T_CRAWLER].setSpeed(this._slotToInst[s], ANIM_SPEED_LUNGE);
    }
    if ((flags & F_LUNGE) !== 0 && (flags & F_LUNGE_TOLD) === 0) {
      flags |= F_LUNGE_TOLD;
      this._flags[s] = flags;
      this._emitTelegraphAt(s, 'lunge', lg.dist, lg.dist / (lg.speed + road));
    }
    this._flags[s] = flags;
    let vx = 0, vz = road + SPEED[T_CRAWLER];
    if (flags & F_LUNGE) {
      vz = road + lg.speed;
      vx = (this._sx - this._x[s]) / dt;
      if (vx < -CRAWLER_LUNGE_LATERAL) vx = -CRAWLER_LUNGE_LATERAL; else if (vx > CRAWLER_LUNGE_LATERAL) vx = CRAWLER_LUNGE_LATERAL;
    }
    this._vx[s] = vx;
    this._vz[s] = vz;
    // ground dust trail (GDD §6.1 telegraph)
    let dust = this._dust[s] - dt;
    if (dust <= 0) { this._emitDust(s); dust += CRAWLER_DUST_EVERY; }
    this._dust[s] = dust;
  }

  /** Brute (GDD §6.1 / J11): stagger freeze, ring telegraph + fill, charge inside 8 m, swing backstop walk-back. */
  _aiBrute(s) {
    const dt = this._dt, road = this._road;
    const z = this._z[s];
    let flags = this._flags[s] & ~F_FROZEN;
    const br = ZOMBIES.brute;
    let vx = 0, vz = road + SPEED[T_BRUTE];
    if (this._timer2[s] > 0) {
      // stagger: 0.3 s freeze (carried by the road) with a backward recoil
      let left = this._timer2[s] - dt;
      flags |= F_FROZEN;
      vz = road;
      let u = left / br.stagger.freeze;
      if (u < 0) u = 0; else if (u > 1) u = 1;
      this._pitch[s] = STAGGER_PITCH * Math.sin(Math.PI * (1 - u));
      if (left <= 0) {
        left = 0;
        this._pitch[s] = (flags & F_BACKOFF) ? STAGGER_PITCH : 0;
        this._inst[T_BRUTE].setSpeed(this._slotToInst[s], (flags & F_CHARGE) ? ANIM_SPEED_CHARGE : 1);
      }
      this._timer2[s] = left;
    } else {
      // red ground ring from 12 m + roar, 0.8 s fill before the first swing (the decal follows in _ringSync)
      if ((flags & F_RING) === 0 && z >= br.swing.ringZ) {
        flags |= F_RING;
        this._aux[s] = 0;
        this._startRing(s);
      }
      if ((flags & F_RING) !== 0 && (flags & F_RING_DONE) === 0) {
        const a = this._aux[s] + dt;
        this._aux[s] = a;
        if (a >= br.swing.telegraph) flags |= F_RING_DONE;
      }
      // charge 3.5 m/s inside 8 m, homing on the squad
      if ((flags & F_CHARGE) === 0 && z >= -br.charge.dist) {
        flags |= F_CHARGE;
        this._inst[T_BRUTE].setSpeed(this._slotToInst[s], ANIM_SPEED_CHARGE);
      }
      if ((flags & F_CHARGE) !== 0 && (flags & F_CHARGE_TOLD) === 0) {
        flags |= F_CHARGE_TOLD;
        this._flags[s] = flags;
        this._emitTelegraphAt(s, 'charge', br.charge.dist, br.charge.dist / (br.charge.speed + road));
      }
      if (flags & F_CHARGE) {
        vz = road + br.charge.speed;
        vx = (this._sx - this._x[s]) / dt;
        if (vx < -BRUTE_CHARGE_LATERAL) vx = -BRUTE_CHARGE_LATERAL; else if (vx > BRUTE_CHARGE_LATERAL) vx = BRUTE_CHARGE_LATERAL;
      }
      if (flags & F_BACKOFF) {
        // swing backstop (QA ENE-12): staggers back (−z, squad frame) BRUTE_BACKOFF_M, then re-approaches; the ring
        // was reset, so it re-telegraphs (0.8 s fill) before it may swing again
        vz = -BRUTE_CONTACT_HOMING_Z;
        vx = 0;
        this._pitch[s] = STAGGER_PITCH;
        if (z <= this._backZ[s]) { flags &= ~F_BACKOFF; this._pitch[s] = 0; }
      }
      if (this._timer[s] > 0) this._timer[s] -= dt;        // swing cooldown
    }
    this._flags[s] = flags;
    this._vx[s] = vx;
    this._vz[s] = vz;
  }

  /** Spitter (GDD §6.1 / J22): holds at hold.z for ≤ hold.max s (walking in place), spits every spit.every s in range. */
  _aiSpitter(s) {
    const dt = this._dt;
    const z = this._z[s];
    let flags = this._flags[s];
    const spd = ZOMBIES.spitter;
    let vz = this._road + SPEED[T_SPITTER];
    if ((flags & F_HOLD_DONE) === 0 && z >= spd.hold.z) {
      flags |= F_HOLDING;
      const a = this._aux[s] + dt;
      this._aux[s] = a;
      if (a >= spd.hold.max) flags = (flags | F_HOLD_DONE) & ~F_HOLDING;
      vz = 0;
    }
    this._flags[s] = flags;
    this._vx[s] = 0;
    this._vz[s] = vz;
    if (z >= spd.hold.z) {
      let timer = this._timer[s] - dt;
      if (timer <= 0) { this._spit(s); timer += spd.spit.every; }
      this._timer[s] = timer;
    }
  }

  /**
   * Contact: APC first, then the formation (ARCH §7 / GDD §6.1 bite rules). Overrides the AI's velocity for a brute
   * that holds; returns true when the zombie bit and died. A frozen (staggered) brute still holds its ground against
   * the squad / APC; it only cannot swing.
   * GDD §6.1 (QA ENE-12): a brute contacts and swings only at the formation's FRONT edge (z ≤ maxContactZ, on the
   * straight bullet path of the front-row muzzles); a flank / rear contact walks to the front first and re-fills the
   * ring there; past maxSwings swings the backstop staggers it back instead of swinging (_beginBackoff).
   */
  _contact(s, t) {
    const z = this._z[s];
    if (z > APC_CHECK_Z && this._touchesApc(s)) {
      const troops = this.ctx.troops;
      if (t === T_BRUTE) {
        let flags = this._flags[s];
        if ((flags & F_BACKOFF) === 0) {
          this._vx[s] = 0; this._vz[s] = 0;                // holds against the APC and keeps swinging
          if ((flags & F_FROZEN) === 0 && this._timer[s] <= 0 && (flags & F_RING_DONE) !== 0) {
            if (this._swings[s] >= BRUTE_MAX_SWINGS) flags = this._beginBackoff(s, flags);
            else {
              troops.apcAbsorb(BITE[T_BRUTE]);
              this._swings[s]++;
              this._timer[s] = ZOMBIES.brute.swing.cooldown;
              this._emitBite(s, BITE[T_BRUTE]);
            }
          }
          this._flags[s] = flags;
        }
        return false;
      }
      const bite = BITE[t];
      if (bite > 0) { troops.apcAbsorb(bite); this._emitBite(s, bite); }
      this._die(s, 'bite');
      return true;
    }
    if (!(z > CONTACT_Z) || !this._touchesSquad(s)) return false;
    const squad = this.ctx.squad;
    if (t === T_BRUTE) {
      let flags = this._flags[s];
      if ((flags & F_BACKOFF) !== 0) return false;
      const frozen = (flags & F_FROZEN) !== 0;
      // "does not die on contact": homes x toward the squad centre so it stands in front of the centre shooters
      let vx = 0;
      if (!frozen) {
        vx = (this._sx - this._x[s]) / this._dt;
        if (vx < -BRUTE_CONTACT_HOMING) vx = -BRUTE_CONTACT_HOMING; else if (vx > BRUTE_CONTACT_HOMING) vx = BRUTE_CONTACT_HOMING;
      }
      this._vx[s] = vx;
      if ((flags & F_RING) === 0) { flags |= F_RING; this._aux[s] = 0; this._startRing(s); }   // an early arrival still telegraphs
      if (z > BRUTE_MAX_CONTACT_Z) {
        // touching the flank behind the front edge: no swing — walk to the front (squad frame −z) while homing x; a
        // stagger freezes the swing and the lateral homing, never this walk (a latched brute stays at the front edge)
        this._vz[s] = -BRUTE_CONTACT_HOMING_Z;
        flags |= F_FRONT_WALK;
      } else {
        this._vz[s] = 0;                                    // holds z at the front edge
        if (flags & F_FRONT_WALK) {
          // reached the front after a flank contact: the 0.8 s ring fill restarts before the first swing here
          flags &= ~(F_FRONT_WALK | F_RING_DONE);
          this._aux[s] = 0;
        }
        if (!frozen && !squad.invulnerable && this._timer[s] <= 0 && (flags & F_RING_DONE) !== 0) {
          if (this._swings[s] >= BRUTE_MAX_SWINGS) flags = this._beginBackoff(s, flags);
          else {
            this._removeSoldiersAt(s, BITE[T_BRUTE]);       // one call with n = 3 → 3 armour plates (ARCH §6.5)
            this._swings[s]++;
            this._timer[s] = ZOMBIES.brute.swing.cooldown;
            this._emitBite(s, BITE[T_BRUTE]);
          }
        }
      }
      this._flags[s] = flags;
      return false;
    }
    if (squad.invulnerable) return false;                   // gate pass / boss intro: the zombie walks through
    const bite = BITE[t];
    if (bite > 0) { this._removeSoldiersAt(s, bite); this._emitBite(s, bite); }
    this._die(s, 'bite');                                   // one bite, one soldier; the biter dies (no coins)
    return true;
  }

  /** Integrates the slot's velocity (x clamped to the road), recycles it behind the camera, eases the facing, burn tint, ring. */
  _integrate(s, t) {
    const dt = this._dt, road = this._road;
    const x = this._x[s], z = this._z[s];
    const vz = this._vz[s];
    const xMax = XMAX[t];
    let nx = x + this._vx[s] * dt;
    if (nx < -xMax) nx = -xMax; else if (nx > xMax) nx = xMax;
    const nz = z + vz * dt;
    const vxs = (nx - x) / dt;
    this._vx[s] = vxs;
    this._x[s] = nx; this._z[s] = nz;
    if (nz > WORLD.despawnZ) { this._recycle(s); return; }

    // facing: toward the squad, swung by the lateral velocity (own forward speed, never the road scroll);
    // yawToward + wrapAngle + lerp written inline
    const sp = SPEED[t];
    const fwd = vz - road > sp ? vz - road : sp;
    const yaw = this._yaw[s];
    // atan2(−vx, −fwd) with fwd > 0 = atan(vx / fwd) ± π (unary Math.atan, no float modulo: both stay unboxed in every
    // JIT tier); the stored yaw stays wrapped into [−π, π]
    const target = Math.atan(vxs / fwd) + (vxs > 0 ? -Math.PI : Math.PI);
    let dyaw = target - yaw;
    while (dyaw > Math.PI) dyaw -= TWO_PI;
    while (dyaw < -Math.PI) dyaw += TWO_PI;
    let ny = yaw + dyaw * (1 - Math.exp(-YAW_RATE * dt));
    if (ny > Math.PI) ny -= TWO_PI; else if (ny < -Math.PI) ny += TWO_PI;
    this._yaw[s] = ny;

    // burn tint (flamer): orange while burnUntil is ahead of the clock
    const burning = this._burnUntil[s] > this._t;
    if (burning !== ((this._flags[s] & F_BURN_VIS) !== 0)) this._applyBurnTint(s, burning);

    // telegraph ring follows the brute and shows the fill / swing gauge
    if (t === T_BRUTE && this._ringDecal[s] >= 0) this._ringSync(s);
  }

  /** squad.removeSoldiers(n, 'bite', x, z) at the slot's position (rare: bites only). */
  _removeSoldiersAt(s, n) {
    this.ctx.squad.removeSoldiers(n, 'bite', this._x[s], this._z[s]);
  }

  /** zombie:telegraph at the slot's position (rare: once per zombie per kind). */
  _emitTelegraphAt(s, kind, radius, duration) {
    this._emitTelegraph(s, kind, this._x[s], this._z[s], radius, duration);
  }

  /** Brute ring telegraph: red ground decal (r ringR, infinite, follows the brute) + zombie:telegraph 'ring'. */
  _startRing(s) {
    const sw = ZOMBIES.brute.swing;
    const x = this._x[s], z = this._z[s];
    if (this._ringDecal[s] < 0) {
      const id = this.ctx.fx.decal('ring', x, z, sw.ringR * 2, Infinity, RING_COLOR);
      this._ringDecal[s] = (typeof id === 'number' && id >= 0) ? id : -1;
    }
    this._emitTelegraph(s, 'ring', x, z, sw.ringR, sw.telegraph);
  }

  /** Moves a brute's ring decal onto it and shows the fill (0.8 s telegraph) or, between swings, the cooldown gauge. */
  _ringSync(s) {
    const fx = this.ctx.fx;
    const id = this._ringDecal[s];
    const sw = ZOMBIES.brute.swing;
    let p = 1;
    if ((this._flags[s] & F_RING_DONE) === 0) { p = this._aux[s] / sw.telegraph; if (p > 1) p = 1; }
    else if (this._timer[s] > 0) p = 1 - this._timer[s] / sw.cooldown;
    fx.decalProgress(id, p);
    fx.moveDecal(id, this._x[s], this._z[s]);
  }

  /**
   * Swing backstop (QA ENE-12): instead of a swing past ZOMBIES.brute.maxSwings the brute staggers back
   * BRUTE_BACKOFF_M (flash + zombie:stagger) and its ring re-telegraphs; it never leaves without being killed.
   * Returns the updated flags (the caller owns the local copy).
   */
  _beginBackoff(s, flags) {
    this._backZ[s] = this._z[s] - BRUTE_BACKOFF_M;
    this._aux[s] = 0;
    const i = this._slotToInst[s];
    if (this._flashT[s] !== this._t) { this._flashT[s] = this._t; this._inst[T_BRUTE].setHit(i, this.ctx.render.uniforms.uTime.value); }
    P_STAGGER.id = makeId(s, this._gen[s]); P_STAGGER.x = this._x[s]; P_STAGGER.z = this._z[s];
    this.ctx.events.emit('zombie:stagger', P_STAGGER);
    return (flags | F_BACKOFF) & ~(F_RING_DONE | F_FRONT_WALK);
  }

  /** Contact query against the formation for slot s (squad.intersectsCircle; the coordinates are read here, not passed). */
  _touchesSquad(s) {
    return this.ctx.squad.intersectsCircle(this._x[s], this._z[s], RADIUS[this._type[s]]);
  }

  /** Contact query against the APC for slot s (troops.apcIntersects; false without troops or without an APC — an
   *  empty apcPool means no APC: troops explodes it at 0 — so the common no-APC case passes no doubles across a call). */
  _touchesApc(s) {
    const troops = this.ctx.troops;
    return troops !== null && troops !== undefined && troops.apcPool > 0 && troops.apcIntersects(this._x[s], this._z[s], RADIUS[this._type[s]]);
  }

  /** Crawler dust puff at the slot's feet. */
  _emitDust(s) {
    this.ctx.fx.emit('dust', this._x[s], 0, this._z[s], 1);
  }

  /** Burn tint toggle (flamer): orange multiplier on the base tint while burning. */
  _applyBurnTint(s, burning) {
    const inst = this._inst[this._type[s]];
    const i = this._slotToInst[s];
    if (burning) { this._flags[s] |= F_BURN_VIS; inst.setTint(i, this._tintR[s] * BURN_MUL_R, this._tintG[s] * BURN_MUL_G, this._tintB[s] * BURN_MUL_B); }
    else { this._flags[s] &= ~F_BURN_VIS; inst.setTint(i, this._tintR[s], this._tintG[s], this._tintB[s]); }
  }

  /** zombie:telegraph with the reused payload. */
  _emitTelegraph(slot, kind, x, z, radius, duration) {
    P_TELE.id = makeId(slot, this._gen[slot]); P_TELE.kind = kind; P_TELE.x = x; P_TELE.z = z; P_TELE.radius = radius; P_TELE.duration = duration;
    this.ctx.events.emit('zombie:telegraph', P_TELE);
  }

  /** zombie:bite with the reused payload. */
  _emitBite(slot, kills) {
    P_BITE.id = makeId(slot, this._gen[slot]); P_BITE.type = TYPES[this._type[slot]]; P_BITE.x = this._x[slot]; P_BITE.z = this._z[slot]; P_BITE.kills = kills;
    this.ctx.events.emit('zombie:bite', P_BITE);
  }

  /** Rebuilds the z-bin linked lists from the alive set (called at the end of every step; binOf inlined). */
  _rebuildBins() {
    const heads = this._binHead, next = this._binNext, state = this._state, Z = this._z;
    for (let b = 0; b < NBINS; b++) heads[b] = -1;
    for (let s = 0; s < CAP; s++) {
      if (state[s] !== S_ALIVE) continue;
      let b = Math.floor((Z[s] - BIN_MIN) / BIN_SIZE);
      if (b < 0) b = 0; else if (b >= NBINS) b = NBINS - 1;
      next[s] = heads[b];
      heads[b] = s;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Spit globs (GDD §6.1 spitter, J22)
  // -------------------------------------------------------------------------------------------

  /** Launches a glob from spitter `slot` at the squad's predicted position. */
  _spit(slot) {
    let g = -1;
    for (let k = 0; k < GLOB_CAP; k++) if (!this._gActive[k]) { g = k; break; }
    if (g < 0) { noteDropped(this.ctx, 'zombies.globs'); return; }
    const sp = ZOMBIES.spitter.spit;
    const x = this._x[slot], z = this._z[slot];
    const y0 = ZOMBIES.spitter.height * SPIT_MOUTH_FRAC;
    const tz = this._scz;
    // lead the squad by its lateral velocity over the flight time (two passes: the time depends on the target)
    let dx = this._sx - x, dz = tz - z;
    let T = Math.sqrt(dx * dx + dz * dz) / sp.speed;
    const tx = clamp(this._sx + this._squadVx * T, -WORLD.steerRange, WORLD.steerRange);
    dx = tx - x;
    T = Math.sqrt(dx * dx + dz * dz) / sp.speed;
    if (T < this._dt) T = this._dt;
    const lvl = this.ctx.level ? this.ctx.level.level : 1;
    this._gActive[g] = 1;
    this._gX0[g] = x; this._gY0[g] = y0; this._gZ0[g] = z;
    this._gTx[g] = tx; this._gTz[g] = tz;
    this._gT[g] = 0; this._gDur[g] = T;
    this._gKills[g] = lvl >= sp.kills2FromLevel ? sp.kills + 1 : sp.kills;   // GDD §6.1: kills 1, 2 from L10 (= kills + 1; DATA-MISSING: ZOMBIES.spitter.spit.kills2)
    this._gDecal[g] = -1;
    this._gPreview[g] = 0;
    this._gOwner[g] = makeId(slot, this._gen[slot]);
    this._gCount++;
    // the spitter flinches with the shot (hit-flash channel doubles as a spit flash)
    this._inst[T_SPITTER].setFire(this._slotToInst[slot], this.ctx.render.uniforms.uTime.value);
  }

  /** Advances every glob; shows the arc preview 0.6 s before impact; resolves impacts. dt = this._dt. */
  _stepGlobs() {
    if (this._gCount === 0) return;
    const ctx = this.ctx;
    const dt = this._dt;
    const sp = ZOMBIES.spitter.spit;
    for (let g = 0; g < GLOB_CAP; g++) {
      if (!this._gActive[g]) continue;
      const tcur = this._gT[g] + dt;
      this._gT[g] = tcur;
      const left = this._gDur[g] - tcur;
      if (!this._gPreview[g] && left <= sp.preview) {
        this._gPreview[g] = 1;
        const id = ctx.fx.decal('arc', this._gTx[g], this._gTz[g], sp.splash * 2, sp.preview, ARC_COLOR);
        this._gDecal[g] = (typeof id === 'number' && id >= 0) ? id : -1;
        P_TELE.id = this._gOwner[g]; P_TELE.kind = 'spit'; P_TELE.x = this._gTx[g]; P_TELE.z = this._gTz[g];
        P_TELE.radius = sp.splash; P_TELE.duration = left > 0 ? (left < sp.preview ? left : sp.preview) : 0;
        ctx.events.emit('zombie:telegraph', P_TELE);
      }
      if (this._gPreview[g] && this._gDecal[g] >= 0) {
        let p = 1 - left / sp.preview;
        if (p < 0) p = 0; else if (p > 1) p = 1;
        ctx.fx.decalProgress(this._gDecal[g], p);
      }
      if (tcur >= this._gDur[g]) this._impact(g);
    }
  }

  /** Glob impact: APC absorbs, else the formation-centre test (ARCH §7) → squad.removeSoldiers(k, 'spit'). */
  _impact(g) {
    const ctx = this.ctx;
    const sp = ZOMBIES.spitter.spit;
    const tx = this._gTx[g], tz = this._gTz[g];
    const k = this._gKills[g];
    const troops = ctx.troops;
    const squad = ctx.squad;
    let kills = 0;
    if (troops !== null && troops !== undefined && troops.apcIntersects(tx, tz, sp.splash)) {
      troops.apcAbsorb(k);
    } else if (!squad.invulnerable) {
      // GDD §6.1: splash radius 1.2 m from the formation centre (Euclidean, not a box)
      const dx = squad.x - tx, dz = squad.centerZ - tz;
      if (dx * dx + dz * dz < sp.splash * sp.splash) {
        squad.removeSoldiers(k, 'spit', tx, tz);
        kills = k;
      }
    }
    P_IMPACT.x = tx; P_IMPACT.z = tz; P_IMPACT.radius = sp.splash; P_IMPACT.kills = kills;
    ctx.events.emit('spit:impact', P_IMPACT);
    if (this._gDecal[g] >= 0) { ctx.fx.removeDecal(this._gDecal[g]); this._gDecal[g] = -1; }
    this._gActive[g] = 0;
    this._gPreview[g] = 0;
    this._gCount--;
  }

  // -------------------------------------------------------------------------------------------
  // Rendering (instance matrix writes only; one commit per mesh per frame)
  // -------------------------------------------------------------------------------------------

  /**
   * Writes every instance matrix (extrapolated by alpha), HP bars, globs and Low-tier blob shadows.
   * QA ENE-16: the matrices, HP-bar TRS, glob tumble and death state are written straight into the typed arrays here
   * (CharacterInstances.writeMatrix with roll 0 / scale 1, writeTRS, writeTumble, ease.outBack and setDeath inlined;
   * CharacterInstances.commit documents that owners may write instanceMatrix directly) — no double crosses a call,
   * so the per-frame render boxes nothing. Only the Low-tier blob discs still pass doubles to render.blobShadowSlot.
   */
  render(alpha) {
    const ctx = this.ctx;
    const render = ctx.render;
    const params = ctx.quality.params;
    const low = !params.shadows && this._hasBlob;         // Low tier: no shadow maps → blob discs (ARCH §9.3)
    const barsAll = params.hpBars === 'all';              // Low tier shows only damaged bars
    const adt = alpha * WORLD.step;
    const death = ZOMBIES.common.death;
    const topple = death.topple, sinkS = death.sink;
    const bar = ZOMBIES.common.hpBar;
    const barCap = ZOMBIES.common.hpBarPool;
    const hpM = this._hpMesh.instanceMatrix.array;
    const hpA = this._hpAttr.array;
    const X = this._x, Z = this._z, VX = this._vx, VZ = this._vz, state = this._state, flags = this._flags;
    const H = this._hp, MH = this._maxHp, yaw = this._yaw, pitch = this._pitch, deathTime = this._deathTime;
    const now = this._t, road = this._road;
    let nBars = 0;

    for (let t = 0; t < NTYPES; t++) {
      const inst = this._inst[t];
      const def = DEF[t];
      const map = this._instToSlot[t];
      const count = this._instCount[t];
      const m = inst.mesh.instanceMatrix.array;
      const iState = inst.attrs.iState.array;
      const barScale = BAR_SCALE[t];
      const blobScale = BLOB_SCALE[t];
      const blob = low && def.shadow;
      const barY = def.height + bar.above;
      const barNever = def.hpBar === 'never', barAlways = def.hpBar === 'always';
      for (let i = 0; i < count; i++) {
        const s = map[i];
        if (s < 0) continue;
        const st = state[s];
        let x, z, p;
        if (st === S_ALIVE) {
          x = X[s] + VX[s] * adt;
          z = Z[s] + VZ[s] * adt;
          p = pitch[s];
        } else if (st === S_DYING) {
          // topple 0.55 s (ease-out-back about the foot pivot) then sink 0.3 s (shader, iState.x)
          const age = now - deathTime[s];
          const u = (age < topple ? age / topple : 1) - 1;
          p = TOPPLE_ANGLE * (1 + u * u * ((OUT_BACK_S + 1) * u + OUT_BACK_S));
          let sink = (age - topple) / sinkS;
          if (sink < 0) sink = 0; else if (sink > 1) sink = 1;
          iState[i * 4] = sink;                           // = inst.setDeath(i, sink)
          x = X[s];
          z = Z[s] + road * adt;
          if (blob) render.blobShadowSlot(BLOB_BASE + s, x, z, blobScale * (1 - sink));
        } else continue;
        // = inst.writeMatrix(i, x, 0, z, yaw, p, 1): T · Ry(yaw) · Rx(p), column-major
        const yw = yaw[s];
        const cy = Math.cos(yw), sy = Math.sin(yw), cp = Math.cos(p), sp = Math.sin(p);
        const o = i * 16;
        m[o] = cy;           m[o + 1] = 0;   m[o + 2] = -sy;       m[o + 3] = 0;
        m[o + 4] = sy * sp;  m[o + 5] = cp;  m[o + 6] = cy * sp;   m[o + 7] = 0;
        m[o + 8] = sy * cp;  m[o + 9] = -sp; m[o + 10] = cy * cp;  m[o + 11] = 0;
        m[o + 12] = x;       m[o + 13] = 0;  m[o + 14] = z;        m[o + 15] = 1;
        if (st !== S_ALIVE) continue;
        if (blob) render.blobShadowSlot(BLOB_BASE + s, x, z, blobScale);
        if (!barNever && nBars < barCap) {
          const show = barsAll ? (barAlways || (flags[s] & F_HIT) !== 0) : H[s] < MH[s];
          if (show) {
            // = writeTRS(hpM, nBars·16, x, barY, z, barScale, 1, 1)
            const ob = nBars * 16;
            hpM[ob] = barScale; hpM[ob + 1] = 0; hpM[ob + 2] = 0;  hpM[ob + 3] = 0;
            hpM[ob + 4] = 0;    hpM[ob + 5] = 1; hpM[ob + 6] = 0;  hpM[ob + 7] = 0;
            hpM[ob + 8] = 0;    hpM[ob + 9] = 0; hpM[ob + 10] = 1; hpM[ob + 11] = 0;
            hpM[ob + 12] = x;   hpM[ob + 13] = barY; hpM[ob + 14] = z; hpM[ob + 15] = 1;
            hpA[nBars] = H[s] / MH[s];
            nBars++;
          }
        }
      }
      inst.commit();
      inst.mesh.visible = inst.mesh.count > 0;   // an empty pool costs no draw call (main + shadow pass)
    }

    this._hpMesh.count = nBars;
    this._hpMesh.visible = nBars > 0;
    commitAttr(this._hpMesh.instanceMatrix, nBars, this._hpMatRange);
    commitAttr(this._hpAttr, nBars, this._hpAttrRange);

    // globs: lobbed arc from the mouth to the target, tumbling (= writeTumble: T · Ry(ay) · Rx(ax), inlined)
    let n = 0;
    if (this._gCount > 0) {
      const gm = this._globMesh.instanceMatrix.array;
      for (let g = 0; g < GLOB_CAP; g++) {
        if (!this._gActive[g]) continue;
        const tcur = this._gT[g] + adt;
        let u = tcur / this._gDur[g];
        if (u < 0) u = 0; else if (u > 1) u = 1;
        const x = this._gX0[g] + (this._gTx[g] - this._gX0[g]) * u;
        const z = this._gZ0[g] + (this._gTz[g] - this._gZ0[g]) * u;
        const y = this._gY0[g] * (1 - u) + 4 * SPIT_ARC_HEIGHT * u * (1 - u);
        const ay = GLOB_SPIN * tcur, ax = GLOB_SPIN * GLOB_TUMBLE_RATIO * tcur;
        const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
        const o = n * 16;
        gm[o] = cy;           gm[o + 1] = 0;   gm[o + 2] = -sy;       gm[o + 3] = 0;
        gm[o + 4] = sy * sx;  gm[o + 5] = cx;  gm[o + 6] = cy * sx;   gm[o + 7] = 0;
        gm[o + 8] = sy * cx;  gm[o + 9] = -sx; gm[o + 10] = cy * cx;  gm[o + 11] = 0;
        gm[o + 12] = x;       gm[o + 13] = y;  gm[o + 14] = z;        gm[o + 15] = 1;
        n++;
      }
    }
    this._globMesh.count = n;
    this._globMesh.visible = n > 0;
    commitAttr(this._globMesh.instanceMatrix, n, this._globMatRange);
  }
}
