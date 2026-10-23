// js/boss.js — Gate Rush BossSystem (ARCHITECTURE §6.8, GDD §7).
//
// One system owns the end-of-level boss: archetype resolution (hulk / spitterQueen / juggernaut /
// colossus and the `base` variants hulkTwins / colossusPrime), the intro choreography (real-time
// deadlines on the theatre clock ctx.time.theatre, falling back to ctx.time.now), approach/hold movement, data-driven phases with every attack kind
// (slam, charge, lane, stomp, car, spit3, rain, cycle), the Colossus shield gauge, minion bursts,
// the safety valve, the death choreography and the CPU-animated rig(s) from models.buildBossRig.
//
// Rules honoured here (ARCH §14): every pool is allocated in init() (rigs for every root archetype,
// two for the twin root; glob SoA; one thrown-car mesh); step()/render() allocate nothing (module-level
// payloads and scratch, typed arrays, no closures); all randomness goes through ctx.rng / ctx.rngFx;
// every optional system is looked up through ctx at spawn (non-hot) and guarded.
//
// Round 5 (r4-release §7 item 3: the boss-arrival frame at 4× CPU paid every boss code path's first use — spawn, the intro step,
// the rig animation, the core light, the fight start, the first hit): a silent dress rehearsal per archetype (_warmArchetype) runs
// those paths on the hidden rigs with every event / side-effect sink detached and puts everything back in the same call. It runs as
// boot slices after the rig builds (initStep) and again, one archetype per frame, shortly after every level start (step), so the
// code is compiled and its inline caches are warm when the real boss arrives. Nothing is drawn, emitted or randomised.
//
// Cross-module calls (read ctx, call public methods, emit events): squad.removeSoldiers /
// setInvulnerable / intersectsCircle / count / x / centerZ / invulnerable, troops.apcAbsorb /
// apcIntersects, zombies.spawnWave, weapons.pauseTimers, engine.lockInput / freezeQuality,
// render.dollyTo / lights.bossCore / blobShadowSlot / uniforms.uTime, fx.decal / moveDecal /
// decalProgress / removeDecal / emit / burst / addTrauma / vignette / slowmo, models.buildBossRig.
import {
  Group, Mesh, InstancedMesh, BoxGeometry, SphereGeometry, CylinderGeometry, IcosahedronGeometry,
  MeshStandardMaterial, MeshBasicMaterial, Vector3, Quaternion, Matrix4, Color, DynamicDrawUsage,
} from 'three';
import { clamp, lerp, lerpExp, ease, warnOnce } from './util.js';
import { WORLD, ZOMBIES, BOSSES, ECONOMY, RENDER, PALETTE, JUICE, GATE_RULES } from './data.js';

// ---------------------------------------------------------------------------------------------
// Tuning (ARCH §1: tuning lives in data.js — BOSSES.*; module-level aliases only)
// ---------------------------------------------------------------------------------------------
const APPROACH_SPEED = BOSSES.approachSpeed;          // own walk speed (m/s, road-relative) while closing from approachZ to the hold
const HOLD_GAIN = BOSSES.holdGain;                    // 1/s proportional gain easing the boss onto its hold z
const ARRIVE_M = BOSSES.arriveM;                      // 'arrived' tolerance around the hold z (valve walk-in)
const ATTACK_RANGE_M = BOSSES.attackRangeM;           // basic attacks start once the boss is this close to the squad front (z = 0)
const FIRST_ATTACK_DELAY = BOSSES.firstAttackDelay;   // s after boss:fight before the first basic attack
const RECOVER_SECONDS = BOSSES.recoverSeconds;        // pose recovery after an attack resolves
const CHARGE_SPEED = BOSSES.chargeDefaults.speed, CHARGE_DURATION = BOSSES.chargeDefaults.duration;   // GDD §7 Hulk charge '1 s, 6 m/s'
const CHARGE_STOP_Z = BOSSES.chargeStopZ;             // a charging boss never crosses this z (squad frame)
const STOMP_RADIUS = BOSSES.stompRadius;
const SPIT3_SPREAD = BOSSES.spit3SpreadM;
const SPIT_JITTER = BOSSES.spitJitterM;
const RAIN_HALF_X = BOSSES.rainBox.halfX, RAIN_Z_BACK = BOSSES.rainBox.zBack, RAIN_Z_FWD = BOSSES.rainBox.zFwd;   // relative to TARGET_Z
const GLOB_POOL = BOSSES.glob.pool, GLOB_SCALE = BOSSES.glob.scale, GLOB_ARC = BOSSES.glob.arcHeight, GLOB_MOUTH_Y = BOSSES.glob.mouthY;
const MINION_BEHIND_M = BOSSES.minionSpawnBehindM;
const PLATE_FLY_S = BOSSES.plateFly.seconds, PLATE_SPEED = BOSSES.plateFly.speed, PLATE_UP = BOSSES.plateFly.up,
  PLATE_SPIN = BOSSES.plateFly.spin, PLATE_GRAVITY = BOSSES.plateFly.gravity, PLATE_SPARKS = BOSSES.plateFly.sparks;
const CAR_ARC = BOSSES.car.arcHeight, CAR_SPIN = BOSSES.car.spin, CAR_LAUNCH_Y = BOSSES.car.launchY, CAR_REST_Y = BOSSES.car.restY;
const ANIM = BOSSES.anim;
const FALL_ANGLE = BOSSES.death.fall.angle, FALL_FRACTION = BOSSES.death.fall.fraction, SINK_M = BOSSES.death.fall.sinkM, SINK_EXTRA_S = BOSSES.death.fall.sinkExtraS;
const HP_EMIT_HZ = JUICE.ui.hudHz;                    // boss:hp emit rate while the shield regenerates HP
const BLOB_SCALE = BOSSES.blobShadowScale;
const FLASH_RETRIGGER = ZOMBIES.common.hitFlashRetrigger;   // s between two hit flashes of one unit
const SHIELD_RATE = GATE_RULES.intakePerSec, SHIELD_BURST = GATE_RULES.intakePerSec * GATE_RULES.intakeWindowS;   // shield intake bucket (GDD §8.1)
// Round-1 literals moved to data.js (QA ENE-19, ARCH §1 / §14 rule 10):
const RETREAT_SPEED = BOSSES.retreatSpeed;            // max m/s walking back (−z) to the hold after a charge / onto a farther hold
const GAIT_REF_MS = BOSSES.gaitRefMs;                 // road-relative speed of a full walk cycle amplitude; stride rate saturates at 1.5×
const PHASE_ENTRY_COOL = BOSSES.phaseEntryCool;       // the basic attack fires ≤ 1 s after a phase change
const TARGET_Z = BOSSES.targetZ;                      // boss telegraphs / splashes land on this line (squad front z 0 − 1 m: above the letterbox)
const INTRO_SPARK_EVERY = BOSSES.introSparkEvery;     // s between the cosmetic sparks of bullets hitting the boss during the intro
// Cosmetic bullet impact point (QA ENE-13): y in [hitYRange[0], hitYRange[1]]·coreY (torso / core band), x jittered by up to
// ±HIT_X_SPREAD·radius inside the capsule — the hit tests themselves stay XZ.
const HIT_Y0 = BOSSES.coreY * BOSSES.hitYRange[0], HIT_Y1 = BOSSES.coreY * BOSSES.hitYRange[1];
const HIT_X_SPREAD = 0.3 * BOSSES.radius;             // QA ENE-13 "up to ±0.3·BOSSES.radius" (a fraction of the capsule, not a tuning value)
const BOSS_R = BOSSES.radius;
// Spitter Queen sac glow gain on top of the pulse (QA ENE-14): peak ≈ the authored #C7E84B, below the bloom threshold.
const SAC_GAIN = ANIM.sacGain;
const LIGHT_OFFSET_Z = ANIM.lightOffsetZ;             // QA ENE-18: core light offset along the facing (negative: just inside the torso)

// Attack kinds (string constants — also the boss:attack `kind` vocabulary of ARCH §5.1).
const K_SLAM = 'slam', K_CHARGE = 'charge', K_SPIT3 = 'spit3', K_RAIN = 'rain', K_STOMP = 'stomp',
  K_LANE = 'lane', K_CAR = 'car', K_CHEW = 'chew', K_CYCLE = 'cycle';
// squad:count reasons per attack kind (ARCH §5.1 squad:count.reason).
const REASON_OF = Object.freeze({ slam: 'slam', charge: 'charge', lane: 'charge', stomp: 'stomp', car: 'car', chew: 'chew', spit3: 'spit', rain: 'spit' });

// Attack state machine.
const A_IDLE = 0, A_TELEGRAPH = 1, A_EXECUTE = 2, A_RECOVER = 3;
// Unit (twin) lifecycle.
const U_FREE = 0, U_ALIVE = 1, U_DYING = 2, U_GONE = 3;
// Named rig parts (ARCH §6.4 buildBossRig children) — index into the rest-pose arrays.
const PART_NAMES = ['torso', 'head', 'jaw', 'armL', 'armR', 'legL', 'legR', 'core', 'shield'];
const P_TORSO = 0, P_HEAD = 1, P_JAW = 2, P_ARML = 3, P_ARMR = 4, P_LEGL = 5, P_LEGR = 6, P_CORE = 7, P_SHIELD = 8;
const PART_COUNT = PART_NAMES.length;
// Pose channels (targets written by step, eased by render).
const POSE_ARMS = 0, POSE_LEAN = 1, POSE_JAW = 2, POSE_CROUCH = 3, POSE_STOMP = 4, POSE_COUNT = 5;

// ---------------------------------------------------------------------------------------------
// Module-level reused payloads (listeners never retain them, ARCH §5) and scratch
// ---------------------------------------------------------------------------------------------
const P_SPAWN = { id: '', name: '', hp: -0, maxHp: -0, archetype: 'hulk', twins: false, mini: false };
const P_INTRO = { id: '', name: '', duration: -0 };
const P_FIGHT = { id: '' };
const P_HP = { hp: -0, maxHp: -0, fraction: 0.5 };   // fraction seeded as a Double (round-2 cross-group); written before every emit
const P_PHASE = { phase: 1, fraction: 0.5 };   // fraction seeded as a Double (round-2 cross-group); written before every emit
const P_ATTACK = { kind: K_SLAM, x: -0, z: -0, radius: -0, delay: -0, lane: -1 };
const P_HIT = { damage: -0, x: -0, y: -0, z: -0, crit: false };
const EV_SHIELD = { hits: 0, needed: 0, up: false, x: -0, z: -0 };
const P_DEAD = { id: '', x: -0, z: -0 };
const P_COIN = { amount: -0, x: -0, y: -0, z: -0, source: 'boss' };
const P_SPIT = { x: -0, z: -0, radius: -0, kills: -0 };
// Reusable minion wave spec for zombies.spawnWave (counts rewritten per burst; absent types stay 0).
const WAVE = { pattern: 'horde', units: { walker: 0, runner: 0, crawler: 0, brute: 0, spitter: 0 }, spread: 0.5, x: -0, z: -0.5 };
WAVE.spread = 0; WAVE.z = WORLD.spawnZ;   // spread / x / z seeded as Doubles first (round-2 cross-group, FX-14 item 2)
// Round 5 dress rehearsal (_warmArchetype): the reusable spawn spec (archetype rewritten per rehearsal; minion HP present so spawn
// takes its normal path), and how many fixed steps after a level start the per-frame re-warm begins (clear of the level-start frame).
const WARM_MINION_HP = { walker: 1, runner: 1, crawler: 1, brute: 1, spitter: 1 };
const WARM_SPEC = { id: 'boss.warm', archetype: 'hulk', hp: 1000, phases: null, minionHp: WARM_MINION_HP, mini: false };
const WARM_AFTER_RESET_STEPS = 45;
const WARM_POS = new Vector3();
const WARM_COLOR = new Color();
const TYPES = ZOMBIES.common.types;
// THREE scratch owned by this module (util.scratch is shared with other systems in the same frame).
const _v = new Vector3(), _v2 = new Vector3(), _q = new Quaternion(), _m = new Matrix4(), _s = new Vector3(1, 1, 1);
const _dollyPos = new Vector3(), _dollyLook = new Vector3();
const _rageColor = new Color(PALETTE.boss.rage), _shieldColor = new Color(PALETTE.boss.shield), _coreColor = new Color(PALETTE.boss.core);
const _flashTint = new Color(ANIM.flashTint);
// Acid-sac vertex colour (linear working space, as models.js bakes it): a glow piece made only of it is a sac
const _sacColor = new Color(PALETTE.zombie.spitter.sacs);
// Rig meshes that cast a shadow (GDD §16 shadow budget): the big silhouettes only. Since round-2 CHR-11 the joints
// (torso, legs, arms, head, jaw) are Bones of one SkinnedMesh 'skin' (models.js skinRig), so 'skin' is the caster; the
// joint names stay listed for a rig built without skinning (they are then Meshes). A twin casts one shadow draw for its
// whole body (the per-part arm/head drop of round 1 no longer applies: the fight shadow pass is 13 draws).
// r5b (docs/build/r5b-boss-draws.md): the plates + chains draw as one 'armour' SkinnedMesh and the eyes, sacs and core as one
// 'glow' SkinnedMesh; neither casts (as the separate plate / chain / glow / core meshes did not), so a rig is 3 main draws
// (+1 while the Colossus shield is up) and 1 shadow draw. Core, plates and chains are Bones: a plate hides by scale 0.
const SHADOW_PARTS = ['skin', 'torso', 'legL', 'legR', 'armL', 'armR', 'head'];
// Segment scratch for hitTestSegment → hitTestSeg (QA ENE-16: the coordinates never cross a call as doubles).
const SEG_B = new Float64Array(4);

/**
 * Installed as the glob instanceMatrix's clearUpdateRanges() (QA ENE-16, gates.js tagRange pattern): WebGLAttributes
 * calls it after every ranged upload; three's default empties the array, so the next push re-allocates its backing
 * store every frame. The one range record (`_grRange`) stays in updateRanges for the attribute's lifetime instead.
 */
function keepUpdateRanges() {}

/** ARCH §2.2 theatre clock in ms: ctx.time.theatre (QA CORE-7: real time that stops while paused), else time.now. */
function theatreNow(time) {
  if (!time) return 0;
  const th = time.theatre;
  return typeof th === 'number' ? th : time.now;
}

/** Resolves `base` chains of BOSSES.archetypes[key]: returns a plain merged object with `key`, `root`
 *  (the rig/model archetype) and `name` from the root (ARCH §6.8). Called once per key in init(). */
function resolveArchetype(key) {
  const table = BOSSES.archetypes;
  let node = table[key];
  if (!node) return null;
  const chain = [node];
  let rootKey = key;
  let guard = 0;
  while (node.base && table[node.base] && guard++ < 8) {
    rootKey = node.base;
    node = table[node.base];
    chain.push(node);
  }
  const out = { key, root: rootKey, name: node.name || key, twins: false, hpSplit: 1, hpMult: 1 };
  // base first, derived last, so derived keys win (twins / hpSplit / shieldHits / hpMult / name)
  for (let i = chain.length - 1; i >= 0; i--) {
    const src = chain[i];
    const ks = Object.keys(src);
    for (let k = 0; k < ks.length; k++) {
      if (ks[k] === 'base') continue;
      out[ks[k]] = src[ks[k]];
    }
  }
  if (!out.name) out.name = key;
  return out;
}

/** True when every vertex colour of a glow geometry is the acid-sac colour (init only). */
function isSacGlow(geo) {
  const c = geo && geo.getAttribute ? geo.getAttribute('color') : null;
  if (!c || c.count === 0) return false;
  for (let i = 0; i < c.count; i++) {
    if (Math.abs(c.getX(i) - _sacColor.r) > 0.02 || Math.abs(c.getY(i) - _sacColor.g) > 0.02 || Math.abs(c.getZ(i) - _sacColor.b) > 0.02) return false;
  }
  return true;
}

/** Phase index for an HP fraction: phases are ordered by descending `until`; phase k applies while
 *  fraction > phases[k].until (the last phase runs down to 0). */
function phaseIndexFor(phases, fraction) {
  let i = 0;
  const last = phases.length - 1;
  while (i < last && fraction <= phases[i].until) i++;
  return i;
}

export class BossSystem {
  constructor(ctx) {
    this.ctx = ctx;
    // late-bound systems (attached after boss in the boot order; resolved per spawn)
    this._fx = null; this._squad = null; this._zombies = null; this._troops = null; this._weapons = null;
    this._engine = null; this._render = null; this._events = null; this._level = null;
    // run / fight state
    this._spawned = false; this._dead = false; this._inIntro = false; this._mini = false;
    this._id = ''; this._name = ''; this._archKey = 'hulk'; this._arch = null; this._phases = null; this._twins = false;
    this._L = 1; this._t = 0.5; this._t = 0; this._fightTime = 0.5; this._fightTime = 0; this._fightAt = 0.5; this._fightAt = 0; this._introAt = 0.5; this._introAt = 0;
    this._maxHpTotal = 0.5; this._maxHpTotal = 0; this._reportedPhase = 0; this._hordeDone = false; this._burstTimer = 0.5; this._burstTimer = 0;
    this._valve = false; this._chewAcc = 0.5; this._chewAcc = 0; this._hpEmitAcc = 0; this._hpDirty = false;
    this._mirrorX = 0.5; this._mirrorX = 0; this._mirrorZ = 0.5; this._mirrorZ = 0; this._mirrorUnit = null;
    this._minionHp = { walker: 0, runner: 0, crawler: 0, brute: 0, spitter: 0 };
    this._shield = { up: false, hits: 0, needed: 0, pool: 0, regenPerSec: 0, unit: null, everUp: false, upAt: 0, tokens: 0 };
    this._introSparkT = -0.5; this._introSparkT = -10;
    this._platesOffGoverned = false;
    // rigs: root archetype → array of rig records; units: the (≤ 2) live boss bodies
    this._rigs = {}; this._archetypes = {};
    // round-3 verify (boot slicing, ARCH §4.1 step 9): the roots of the rigs init() queued, built one per initStep()
    this._rigQueue = []; this._rigQueueAt = 0;
    this._units = null; this._unitCount = 0;
    // globs (SoA) + car + own GPU resources
    this._glob = null; this._globMesh = null; this._globMat = null; this._globGeo = null; this._ownGlobGeo = false;
    this._car = null;
    this._ownMats = []; this._ownGeos = [];
    this._light = null; this._scene = null;
    this._disposed = false;
    // round 5 dress rehearsal: archetype keys to rehearse (init), the next one, and a countdown (fixed steps) before step() re-runs
    // the list after a reset (−1: idle); _warmingRig marks the silent pass (spawn keeps its detached sinks, reset queues nothing)
    this._warmKeys = null; this._warmAt = 0; this._warmBoot = 0; this._warmCountdown = -1; this._warmingRig = false;
  }

  // -------------------------------------------------------------------------------------------
  // init / reset / dispose
  // -------------------------------------------------------------------------------------------

  init() {
    const ctx = this.ctx;
    this._fx = ctx.fx || null; this._squad = ctx.squad || null; this._zombies = ctx.zombies || null;
    this._engine = ctx.engine || null; this._render = ctx.render || null; this._events = ctx.events || null;
    this._scene = (this._render && this._render.scene) || null;
    this._light = (this._render && this._render.lights && this._render.lights.bossCore) || null;
    if (this._light) { this._light.intensity = 0; this._light.distance = ANIM.lightDistance; this._light.decay = ANIM.lightDecay; }

    // Resolve every archetype once (non-hot); find which roots need two rigs (twins).
    const keys = Object.keys(BOSSES.archetypes);
    const rigCount = {};
    for (let i = 0; i < keys.length; i++) {
      const a = resolveArchetype(keys[i]);
      if (!a) continue;
      this._archetypes[keys[i]] = a;
      const need = a.twins ? 2 : 1;
      if (!rigCount[a.root] || rigCount[a.root] < need) rigCount[a.root] = need;
    }
    // Rigs are queued, not built: each models.buildBossRig + record costs ≈ 45–60 ms at 4× CPU, ≈ 230–300 ms for the
    // set — the boot's longest frozen frame (r3-boot-polish needsOtherGroup 1). main builds them one per frame through
    // initStep(); spawn() builds whatever is still queued (a host that never called initStep).
    const roots = Object.keys(rigCount);
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      this._rigs[root] = [];
      for (let k = 0; k < rigCount[root]; k++) this._rigQueue.push(root);
    }

    // round 5: every archetype is rehearsed once per warm pass (the twin keys cover the second rig of their root)
    this._warmKeys = Object.keys(this._archetypes);
    this._warmBoot = this._warmKeys.length;

    // Units (twin bodies): plain records created once.
    this._units = [this._newUnit(0), this._newUnit(1)];
    this._unitCount = 0;

    this._initGlobs();
    this._initCar();
    return this;
  }

  /** Boot slicing (ARCH §4.1 step 9, round-3 verify): deferred init slices left — the queued boss rigs, then (round 5) one dress
   *  rehearsal per archetype. */
  get initSteps() { return this._rigQueue.length - this._rigQueueAt + this._warmBoot; }

  /** Builds the next queued rig (one models.buildBossRig + record), or once every rig exists rehearses the next archetype
   *  (_warmArchetype); returns the slices still pending. Boot only. */
  initStep() {
    if (this._rigQueueAt < this._rigQueue.length) {
      const root = this._rigQueue[this._rigQueueAt++];
      const rec = this._buildRigRecord(root);
      if (rec) this._rigs[root].push(rec);
    } else if (this._warmBoot > 0) {
      const key = this._warmKeys[this._warmKeys.length - this._warmBoot];
      this._warmBoot--;
      this._warmArchetype(key);
    }
    return this.initSteps;
  }

  /**
   * Round 5 (r4-release §7 item 3): a silent dress rehearsal of archetype `key` on its hidden rig(s) — spawn (intro choreography
   * included), two intro steps, a render, the fight start, a fight step, one hit, aimPoint — then reset(), all inside this call.
   * Every sink is detached for the pass (events, engine, squad, weapons, render, fx, zombies, troops, level: no emit, no dolly, no
   * input lock, no blob shadow, no minion); ctx.world's boss mirror and the core light are put back exactly; nothing here draws
   * randoms (ctx.rng / rngFx are only read by attacks, globs and hit jitter, which the rehearsal does not reach). The rig is visible
   * only inside this synchronous call, so nothing of it is ever drawn. Never while a boss is live. Allocation-free.
   */
  _warmArchetype(key) {
    if (this._spawned || this._disposed || !this._archetypes[key]) return;
    const ctx = this.ctx, world = ctx.world, light = this._light;
    const sEvents = this._events, sEngine = this._engine, sSquad = this._squad, sWeapons = this._weapons, sRender = this._render;
    const sFx = this._fx, sZombies = this._zombies, sTroops = this._troops, sLevel = this._level;
    const wActive = world ? world.bossActive : false, wX = world ? world.bossX : 0, wZ = world ? world.bossZ : 0;
    let lI = 0;
    if (light) { lI = light.intensity; WARM_POS.copy(light.position); WARM_COLOR.copy(light.color); }
    this._events = null; this._engine = null; this._squad = null; this._weapons = null; this._render = null;
    this._fx = null; this._zombies = null; this._troops = null; this._level = null;
    this._warmingRig = true;
    try {
      WARM_SPEC.archetype = key;
      this.spawn(WARM_SPEC);
      const dt = WORLD.step;
      this.step(dt);
      this.step(dt);
      this.render(0.5);
      this._beginFight();
      this.step(dt);
      this.render(0.5);
      const u = this._units[0];
      this.damage(1, 1, u.x, BOSSES.coreY, u.z, false);
      this.aimPoint(_dollyLook);                                         // spawn's own scratch (WARM_POS holds the light)
      this.intersectsSquad();
    } catch (e) {
      warnOnce('boss.warm', 'boss warm-up failed: ' + (e && e.message));
    } finally {
      this.reset();
      this._warmingRig = false;
      this._events = sEvents; this._engine = sEngine; this._squad = sSquad; this._weapons = sWeapons; this._render = sRender;
      this._fx = sFx; this._zombies = sZombies; this._troops = sTroops; this._level = sLevel;
      if (world) { world.bossActive = wActive; world.bossX = wX; world.bossZ = wZ; }
      if (light) { light.intensity = lI; light.position.copy(WARM_POS); light.color.copy(WARM_COLOR); }
    }
  }

  /** Returns the system to the level-start state: rigs hidden and re-posed, plates re-attached,
   *  globs/car/decals cleared, world mirror cleared, light off. Idempotent, allocation-free. */
  reset() {
    const ctx = this.ctx;
    if (this._inIntro) {
      // a restart during the intro must not leave input locked / timers paused (level also undoes these)
      if (this._engine && this._engine.lockInput) this._engine.lockInput(false);
      if (this._weapons && this._weapons.pauseTimers) this._weapons.pauseTimers(false);
    }
    for (let i = 0; i < 2; i++) this._releaseUnit(this._units[i]);
    this._unitCount = 0;
    this._clearGlobs();
    this._hideCar();
    if (this._shield.up) this._shield.up = false;
    this._shield.hits = 0; this._shield.needed = 0; this._shield.pool = 0; this._shield.regenPerSec = 0; this._shield.unit = null; this._shield.everUp = false;
    this._shield.upAt = 0; this._shield.tokens = 0; this._introSparkT = -10;
    this._spawned = false; this._dead = false; this._inIntro = false; this._mini = false;
    this._t = 0; this._fightTime = 0; this._fightAt = 0; this._introAt = 0;
    this._maxHpTotal = 0; this._reportedPhase = 0; this._hordeDone = false; this._burstTimer = 0;
    this._valve = false; this._chewAcc = 0; this._hpEmitAcc = 0; this._hpDirty = false;
    this._mirrorX = 0; this._mirrorZ = 0; this._mirrorUnit = null;
    this._platesOffGoverned = false;
    if (this._light) this._light.intensity = 0;
    if (ctx.world) { ctx.world.bossActive = false; ctx.world.bossX = 0; ctx.world.bossZ = 0; }
    // round 5: re-rehearse every archetype shortly after a level start (one per step), so the boss code is still compiled and its
    // caches warm ≈ 50 s later however long the session sat on the title (V8 may flush bytecode that has not run for a while)
    if (!this._warmingRig && this._warmKeys !== null) { this._warmCountdown = WARM_AFTER_RESET_STEPS; this._warmAt = 0; }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.reset();
    const roots = Object.keys(this._rigs);
    for (let i = 0; i < roots.length; i++) {
      const list = this._rigs[roots[i]];
      for (let k = 0; k < list.length; k++) {
        const g = list[k].group;
        if (g.parent) g.parent.remove(g);
      }
    }
    if (this._globMesh && this._globMesh.parent) this._globMesh.parent.remove(this._globMesh);
    if (this._car && this._car.mesh && this._car.mesh.parent) this._car.mesh.parent.remove(this._car.mesh);
    for (let i = 0; i < this._ownMats.length; i++) this._ownMats[i].dispose();
    for (let i = 0; i < this._ownGeos.length; i++) this._ownGeos[i].dispose();
    this._ownMats.length = 0; this._ownGeos.length = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Rig preparation (init only)
  // -------------------------------------------------------------------------------------------

  _newUnit(idx) {
    // Fraction-holding fields are created from 0.5 and set to their start values below (round-2 cross-group, FX-14
    // item 2): a Double representation from the start, so e.g. the first theatre-time deathAt store at boss:dead no
    // longer deprecates the unit map and deoptimises every boss.js function mid-fight.
    const u = {
      idx, state: U_FREE, hp: 0.5, maxHp: 0.5, phaseIdx: 0, x: 0.5, z: 0.5, vz: 0.5, homeX: 0.5, zOff: 0.5,
      targetZ: 0.5, arrived: false, yaw: 0.5, rig: null, cool: 0.5, pendingAttack: null, cycleIdx: 0,
      dmgMult: 0.5, hitT: 0.5, deathAt: 0.5, walkPhase: 0.5, gait: 0.5, chewT: 0.5,
      atk: { state: A_IDLE, kind: K_SLAM, params: null, timer: 0.5, dur: 0.5, exec: 0.5, ax: 0.5, az: 0.5, radius: 0.5, laneX: 0.5, lane: -1, decal: -1, speed: 0.5, launched: 0, total: 0 },
      pose: new Float32Array(POSE_COUNT), cur: new Float32Array(POSE_COUNT),
    };
    u.hp = 0; u.maxHp = 0; u.x = 0; u.z = BOSSES.approachZ; u.vz = 0; u.homeX = 0; u.zOff = 0;
    u.targetZ = BOSSES.holdZ[0]; u.yaw = 0; u.cool = 0; u.dmgMult = 1; u.hitT = -10; u.deathAt = 0;
    u.walkPhase = 0; u.gait = 0; u.chewT = -10;
    const a = u.atk; a.timer = 0; a.dur = 0; a.exec = 0; a.ax = 0; a.az = 0; a.radius = 0; a.laneX = 0; a.speed = 0;
    return u;
  }

  /** Builds (via models.buildBossRig, or the fallback) and prepares one rig: named parts, rest pose,
   *  per-rig body material clone (rage/flash emissive without touching the shared cache), plate records. */
  _buildRigRecord(root) {
    const models = this.ctx.models;
    let group = null;
    if (models && typeof models.buildBossRig === 'function') {
      try { group = models.buildBossRig(root); } catch (e) { group = null; warnOnce('boss.rig.' + root, 'buildBossRig(' + root + ') failed: ' + (e && e.message)); }
    }
    if (!group) group = this._buildFallbackRig(root);
    group.visible = false;
    group.name = 'boss.' + root;
    if (this._scene) this._scene.add(group);

    const parts = new Array(PART_COUNT);
    for (let i = 0; i < PART_COUNT; i++) parts[i] = group.getObjectByName(PART_NAMES[i]) || null;
    const plates = [], chains = [];
    const bodyMats = [];
    const srcMats = [];
    // glow pieces (eyes, sacs, seams: unlit HDR basic meshes) + the core: per-rig clones carry the phase-3 rage glow
    const glowMats = [], glowSrc = [], glowSac = [];   // glowSac[i] 1 = body glow pieces (the Spitter Queen's sacs), 0 = eyes
    let coreMat = null;
    // r5b: the models rig draws in three skinned meshes ('skin', 'armour', 'glow'); core, plates and chains are Bones
    let glowCols = null, glowColBase = null;
    group.traverse((obj) => {
      const nm = obj.name || '';
      if (obj !== group && /^plates?\d*$/i.test(nm) && (obj.isMesh || obj.isBone)) plates.push(obj);
      else if (obj !== group && /^chains?\d*$/i.test(nm)) chains.push(obj);
      if (obj.isMesh) {
        obj.castShadow = SHADOW_PARTS.indexOf(nm) >= 0;                  // big parts only (jaw, glow, armour, plates, chains, core, shield: no)
        obj.receiveShadow = false;
        const mat = obj.material;
        if (!mat || Array.isArray(mat)) return;
        if (mat.userData && mat.userData.glowCols && mat.userData.glowBase) {
          // r5b merged glow (eyes / sacs / core groups): the material is already per rig and carries the onBeforeCompile
          // hook (a clone would drop it): render() writes its three group colours (uGlowCol) directly
          glowCols = mat.userData.glowCols;
          glowColBase = Float32Array.from(mat.userData.glowBase);
          return;
        }
        if (nm !== 'core' && nm !== 'shield' && mat.isMeshStandardMaterial) {
          // one clone per distinct source material per rig
          let idx = srcMats.indexOf(mat);
          if (idx < 0) {
            const clone = mat.clone();
            srcMats.push(mat); bodyMats.push(clone); this._ownMats.push(clone);
            idx = srcMats.length - 1;
          }
          obj.material = bodyMats[idx];
        } else if (nm === 'core' && mat.color) {
          if (!coreMat) { coreMat = mat.clone(); this._ownMats.push(coreMat); }
          obj.material = coreMat;
        } else if (nm !== 'shield' && mat.isMeshBasicMaterial && mat.color) {
          // models names the head's glow child 'eyes' and every other part's 'glow<part>' (sacs): one clone per
          // (source material, eyes|body) pair so the body glow can pulse on its own (GDD §7 'pulsing sacs')
          // QA ENE-14: the Spitter Queen's head glow child ('eyes') holds her head sacs, not eyes — any glow piece whose
          // vertices are all the acid-sac colour is a sac (own gain + pulse); real eyes (#FFE14D) stay at 1.5
          const sac = (nm !== 'eyes' || isSacGlow(obj.geometry)) ? 1 : 0;
          let idx = -1;
          for (let k = 0; k < glowSrc.length; k++) if (glowSrc[k] === mat && glowSac[k] === sac) { idx = k; break; }
          if (idx < 0) {
            const clone = mat.clone();
            glowSrc.push(mat); glowMats.push(clone); glowSac.push(sac); this._ownMats.push(clone);
            idx = glowSrc.length - 1;
          }
          obj.material = glowMats[idx];
        }
      }
    });
    const glowBase = new Float32Array(glowMats.length * 3);
    for (let i = 0; i < glowMats.length; i++) { const c = glowMats[i].color; glowBase[i * 3] = c.r; glowBase[i * 3 + 1] = c.g; glowBase[i * 3 + 2] = c.b; }
    const coreBase = coreMat ? coreMat.color.clone() : null;
    // a 'plates' group holding unnamed meshes: take its mesh children
    if (plates.length === 0) {
      const pg = group.getObjectByName('plates');
      if (pg) for (let i = 0; i < pg.children.length; i++) if (pg.children[i].isMesh) plates.push(pg.children[i]);
    }
    if (plates.length > BOSSES.plates) plates.length = BOSSES.plates;

    const rest = new Float32Array(PART_COUNT * 6);
    for (let i = 0; i < PART_COUNT; i++) {
      const p = parts[i];
      if (!p) continue;
      rest[i * 6] = p.position.x; rest[i * 6 + 1] = p.position.y; rest[i * 6 + 2] = p.position.z;
      rest[i * 6 + 3] = p.rotation.x; rest[i * 6 + 4] = p.rotation.y; rest[i * 6 + 5] = p.rotation.z;
    }
    const chainRest = new Float32Array(chains.length * 3);
    for (let i = 0; i < chains.length; i++) { chainRest[i * 3] = chains[i].rotation.x; chainRest[i * 3 + 1] = chains[i].rotation.y; chainRest[i * 3 + 2] = chains[i].rotation.z; }

    const n = plates.length;
    const plateParent = new Array(n);
    const platePos = new Array(n), plateQuat = new Array(n), plateScale = new Array(n);
    for (let i = 0; i < n; i++) {
      plateParent[i] = plates[i].parent;
      platePos[i] = plates[i].position.clone(); plateQuat[i] = plates[i].quaternion.clone(); plateScale[i] = plates[i].scale.clone();
    }
    let shieldMat = null;
    const shield = parts[P_SHIELD];
    if (shield && shield.isMesh && shield.material && !Array.isArray(shield.material)) {
      shieldMat = shield.material.clone(); shield.material = shieldMat; this._ownMats.push(shieldMat);
      shieldMat.transparent = true;
      shield.visible = false;
    }
    let coreScale = 1;
    if (parts[P_CORE]) coreScale = parts[P_CORE].scale.x || 1;
    // nested = head/arms hang under the torso (their rest is torso-relative): bob/crouch then move them for free
    const nested = !!(parts[P_HEAD] && parts[P_TORSO] && parts[P_HEAD].parent !== group);
    return {
      root, group, parts, plates, chains, rest, chainRest, plateParent, platePos, plateQuat, plateScale,
      plateFly: new Float32Array(n * 7), plateDetached: new Uint8Array(n), platesGone: false,
      bodyMats, shieldMat, coreScale, nested, inUse: false,
      glowMats, glowBase, glowSac: Uint8Array.from(glowSac), coreMat, coreBase, glowCols, glowColBase,
    };
  }

  /** Minimal procedural rig with the ARCH §6.4 named children, used only when models.buildBossRig is
   *  unavailable (stub harness / rebuild). Sizes from BOSSES.rigHeight (7 m), colours from PALETTE.boss. */
  _buildFallbackRig(root) {
    const H = BOSSES.rigHeight / 7;                       // every size below is authored for a 7 m rig
    const g = new Group();
    const bodyMat = new MeshStandardMaterial({ color: PALETTE.boss.skin, roughness: PALETTE.material.skin.roughness, metalness: 0 });
    const plateMat = new MeshStandardMaterial({ color: PALETTE.boss.plates, roughness: PALETTE.material.metal.roughness, metalness: PALETTE.material.metal.metalness });
    const coreMat = new MeshBasicMaterial({ color: PALETTE.boss.core, toneMapped: false });
    coreMat.color.multiplyScalar(PALETTE.boss.coreEmissive);
    const shieldMat = new MeshBasicMaterial({ color: PALETTE.boss.shield, transparent: true, opacity: 0.28, depthWrite: false });
    this._ownMats.push(bodyMat, plateMat, coreMat, shieldMat);
    const geo = (gm) => { this._ownGeos.push(gm); return gm; };
    const add = (name, gm, mat, x, y, z) => { const m = new Mesh(gm, mat); m.name = name; m.position.set(x * H, y * H, z * H); g.add(m); return m; };
    add('torso', geo(new BoxGeometry(2.6 * H, 2.8 * H, 1.6 * H)), bodyMat, 0, 3.6, 0);
    add('head', geo(new SphereGeometry(0.8 * H, 14, 10)), bodyMat, 0, 5.6, 0.2);
    add('jaw', geo(new BoxGeometry(1.0 * H, 0.4 * H, 0.9 * H).translate(0, -0.2 * H, 0.45 * H)), bodyMat, 0, 5.2, 0.5);
    add('armL', geo(new BoxGeometry(0.7 * H, 2.6 * H, 0.7 * H).translate(0, -1.3 * H, 0)), bodyMat, -1.9, 4.7, 0);
    add('armR', geo(new BoxGeometry(0.7 * H, 2.6 * H, 0.7 * H).translate(0, -1.3 * H, 0)), bodyMat, 1.9, 4.7, 0);
    add('legL', geo(new BoxGeometry(0.8 * H, 2.3 * H, 0.8 * H).translate(0, -1.15 * H, 0)), bodyMat, -0.7, 2.3, 0);
    add('legR', geo(new BoxGeometry(0.8 * H, 2.3 * H, 0.8 * H).translate(0, -1.15 * H, 0)), bodyMat, 0.7, 2.3, 0);
    add('core', geo(new SphereGeometry(0.45 * H, 12, 10)), coreMat, 0, BOSSES.coreY / H, 0.85);
    const plateGeo = geo(new BoxGeometry(1.2 * H, 1.0 * H, 0.15 * H));
    for (let i = 0; i < BOSSES.plates; i++) {
      const side = i < 2 ? -1 : 1, up = i % 2;
      const p = add('plate' + i, plateGeo, plateMat, side * (up ? 0.7 : 1.4), up ? 4.6 : 3.9, up ? 0.85 : 0.3);
      p.rotation.y = side * (up ? 0.15 : 0.5);
    }
    if (root === 'colossus') {
      const chainGeo = geo(new CylinderGeometry(0.08 * H, 0.08 * H, 1.6 * H, 6).translate(0, -0.8 * H, 0));
      for (let i = 0; i < 3; i++) add('chain' + i, chainGeo, plateMat, (i - 1) * 1.0, 2.4, 0.7);
      const sh = add('shield', geo(new SphereGeometry(2.7 * H, 18, 12)), shieldMat, 0, 3.8, 0);
      sh.visible = false;
    }
    return g;
  }

  _initGlobs() {
    const n = GLOB_POOL;
    this._glob = {
      count: 0, x0: new Float32Array(n), y0: new Float32Array(n), z0: new Float32Array(n), tx: new Float32Array(n), tz: new Float32Array(n),
      t0: new Float32Array(n), T: new Float32Array(n), kills: new Float32Array(n), decal: new Int32Array(n), spin: new Float32Array(n),
    };
    const models = this.ctx.models;
    let geo = models && models.geo && models.geo.glob ? models.geo.glob : null;
    if (!geo) { geo = new IcosahedronGeometry(ZOMBIES.common.globRadius, 0); this._ownGeos.push(geo); }
    this._globGeo = geo;
    const mat = new MeshStandardMaterial({ color: PALETTE.zombie.spitter.sacs, emissive: PALETTE.fx.acid, emissiveIntensity: 0.6, roughness: 0.35, metalness: 0 });
    this._globMat = mat; this._ownMats.push(mat);
    const mesh = new InstancedMesh(geo, mat, n);
    mesh.count = 0; mesh.visible = false; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // one permanent update range (QA ENE-16): nothing is pushed per frame
    const attr = mesh.instanceMatrix;
    attr._grRange = { start: 0, count: 0 };
    attr.updateRanges.length = 0;
    attr.updateRanges.push(attr._grRange);
    attr.clearUpdateRanges = keepUpdateRanges;
    mesh.name = 'boss.globs';
    this._globMesh = mesh;
    if (this._scene) this._scene.add(mesh);
  }

  _initCar() {
    const models = this.ctx.models;
    const render = this._render;
    let geo = models && models.geo && models.geo.car ? models.geo.car : null;
    if (!geo) { geo = new BoxGeometry(1.8, 1.2, 4.0); this._ownGeos.push(geo); }
    let mat = null;
    if (render && render.materials && typeof render.materials.standard === 'function') {
      try { mat = render.materials.standard(PALETTE.props.car[0]); } catch (e) { mat = null; }
    }
    if (!mat) { mat = new MeshStandardMaterial({ color: PALETTE.props.car[0], roughness: PALETTE.material.car.roughness, metalness: PALETTE.material.car.metalness }); this._ownMats.push(mat); }
    const mesh = new Mesh(geo, mat);
    mesh.name = 'boss.car'; mesh.visible = false; mesh.castShadow = true; mesh.frustumCulled = false;
    if (this._scene) this._scene.add(mesh);
    this._car = { mesh, state: 0, x0: 0, y0: 0, z0: 0, tx: 0, tz: 0, t0: 0, T: 1, bandHalf: 0, params: null, unit: null, spin: 0, rx: 0, rz: 0 };
  }

  // -------------------------------------------------------------------------------------------
  // spawn + intro choreography
  // -------------------------------------------------------------------------------------------

  /**
   * spec = { id, archetype, hp (total), phases?, mini?, minionHp, x?, z? } — ARCH §6.8.
   * Twins: each twin receives hp·hpSplit (the pair holds 1.1× the table HP); one boss:spawn for the pair.
   * hpMult is informational here: level/levelgen already folded it into `hp` (ARCH D9).
   */
  spawn(spec) {
    const ctx = this.ctx;
    if (this._spawned) this.reset();
    // late-bound systems (created after boss in the boot order); the round-5 rehearsal keeps them detached
    if (!this._warmingRig) {
      this._fx = ctx.fx || null; this._squad = ctx.squad || null; this._zombies = ctx.zombies || null;
      this._troops = ctx.troops || null; this._weapons = ctx.weapons || null; this._engine = ctx.engine || null;
      this._render = ctx.render || null; this._events = ctx.events || null; this._level = ctx.level || null;
    }

    const arch = this._archetypes[spec.archetype] || this._archetypes.hulk;
    if (!this._archetypes[spec.archetype]) warnOnce('boss.arch.' + spec.archetype, 'unknown boss archetype ' + spec.archetype + ', using hulk');
    this._arch = arch; this._archKey = spec.archetype in this._archetypes ? spec.archetype : 'hulk';
    this._phases = (spec.phases && spec.phases.length) ? spec.phases : arch.phases;
    this._twins = !!arch.twins;
    this._mini = !!spec.mini;
    this._id = spec.id || ('boss.' + this._archKey);
    this._name = arch.name;
    this._L = Math.max(1, ((this._level && this._level.level) | 0));
    this._platesOffGoverned = this._hasPlatesOffAction(this._phases);

    // minion HP: copied (never retain the caller's object); fallback = baseHp (hz 1) with a warning
    for (let i = 0; i < TYPES.length; i++) {
      const t = TYPES[i];
      const v = spec.minionHp ? spec.minionHp[t] : undefined;
      this._minionHp[t] = (typeof v === 'number' && v > 0) ? v : ZOMBIES[t].baseHp;
    }
    if (!spec.minionHp) warnOnce('boss.minionHp', 'boss.spawn without minionHp — minions use base HP');

    const total = Math.max(1, +spec.hp || 1);
    const unitHp = this._twins ? total * (arch.hpSplit || 0.5) : total;
    const n = this._twins ? 2 : 1;
    while (this.initSteps > 0) this.initStep();     // rigs still queued (boot slicing never ran): build them now
    const rigs = this._rigs[arch.root] || this._rigs.hulk;
    const z0 = (typeof spec.z === 'number') ? spec.z : BOSSES.approachZ;
    const x0 = (typeof spec.x === 'number') ? spec.x : 0;
    this._maxHpTotal = 0;
    const twinMaxX = WORLD.roadWidth / 2 - BOSSES.radius * 0.5;          // twins stay on the road
    for (let u = 0; u < n; u++) {
      const unit = this._units[u];
      const rig = rigs[Math.min(u, rigs.length - 1)];
      unit.state = U_ALIVE; unit.hp = unitHp; unit.maxHp = unitHp; unit.phaseIdx = 0;
      unit.homeX = this._twins ? clamp(x0 + (u === 0 ? -BOSSES.twinOffsetX : BOSSES.twinOffsetX), -twinMaxX, twinMaxX) : x0;
      unit.zOff = (this._twins && u === 1) ? -BOSSES.twinStaggerZ : 0;   // the second twin holds a little farther back
      unit.x = unit.homeX; unit.z = z0 + unit.zOff; unit.vz = 0; unit.targetZ = BOSSES.holdZ[0] + unit.zOff; unit.arrived = false; unit.yaw = 0;
      unit.cool = FIRST_ATTACK_DELAY; unit.pendingAttack = null; unit.cycleIdx = 0; unit.dmgMult = 1; unit.hitT = -10; unit.deathAt = 0;
      unit.walkPhase = 0; unit.gait = 0;
      unit.pose.fill(0); unit.cur.fill(0);
      this._resetAttack(unit);
      unit.rig = rig; rig.inUse = true;
      this._restoreRig(rig);
      // shadow budget (GDD §16): a twin pair casts from torso + legs only — only meaningful on an unskinned rig, where the
      // joints are Meshes; on the CHR-11 skinned rig they are Bones and 'skin' casts the whole body in one draw.
      if (rig.parts[P_ARML] && rig.parts[P_ARML].isMesh) rig.parts[P_ARML].castShadow = !this._twins;
      if (rig.parts[P_ARMR] && rig.parts[P_ARMR].isMesh) rig.parts[P_ARMR].castShadow = !this._twins;
      if (rig.parts[P_HEAD] && rig.parts[P_HEAD].isMesh) rig.parts[P_HEAD].castShadow = !this._twins;
      rig.group.visible = true;
      rig.group.position.set(unit.x, 0, unit.z);
      rig.group.rotation.set(0, 0, 0);
      this._maxHpTotal += unitHp;
    }
    this._unitCount = n;
    this._spawned = true; this._dead = false; this._t = 0; this._fightTime = 0;
    this._reportedPhase = 1; this._hordeDone = false; this._burstTimer = 0; this._valve = false; this._chewAcc = 0;
    this._hpEmitAcc = 0; this._hpDirty = false;
    this._shield.up = false; this._shield.hits = 0; this._shield.needed = arch.shieldHits || 0; this._shield.pool = 0;
    this._shield.regenPerSec = arch.shieldRegenPerSec || 0; this._shield.unit = null; this._shield.everUp = false;
    this._shield.upAt = 0; this._shield.tokens = 0; this._introSparkT = -10;
    this._mirrorUnit = this._units[0]; this._mirrorX = this._units[0].x; this._mirrorZ = this._units[0].z;
    if (ctx.world) { ctx.world.bossActive = true; ctx.world.bossX = this._mirrorX; ctx.world.bossZ = this._mirrorZ; }
    if (this._light) { this._light.color.copy(_coreColor); this._light.intensity = ANIM.lightIntensity; }

    // boss:spawn (one emit for the pair; hp/maxHp are sums)
    P_SPAWN.id = this._id; P_SPAWN.name = this._name; P_SPAWN.hp = this._maxHpTotal; P_SPAWN.maxHp = this._maxHpTotal;
    P_SPAWN.archetype = this._archKey; P_SPAWN.twins = this._twins; P_SPAWN.mini = this._mini;
    this._emit('boss:spawn', P_SPAWN);

    // theatre deadlines (ARCH §2.2): real time that spans slow-mo but not pauses (QA ENE-17, CORE-7 clock)
    const now = theatreNow(ctx.time);
    this._introAt = now;
    if (!this._mini) {
      const intro = BOSSES.intro;
      this._inIntro = true;
      this._fightAt = now + intro.fightAfter * 1000;                         // theatre-clock deadline (ARCH §2.2)
      if (this._engine) {
        if (this._engine.lockInput) this._engine.lockInput(true);
        if (this._engine.freezeQuality) this._engine.freezeQuality(intro.dollyOut + intro.hold + intro.back);
      }
      if (this._squad && this._squad.setInvulnerable) this._squad.setInvulnerable(intro.invuln);
      if (this._weapons && this._weapons.pauseTimers) this._weapons.pauseTimers(true);
      if (this._render && this._render.dollyTo) {
        _dollyPos.set(RENDER.dollyPos[0], RENDER.dollyPos[1], RENDER.dollyPos[2]);
        this.aimPoint(_dollyLook);
        this._render.dollyTo(_dollyPos, _dollyLook, intro.dollyOut, intro.hold, intro.back);
      }
      // roar pose during the intro
      for (let u = 0; u < n; u++) { this._units[u].pose[POSE_JAW] = 1; this._units[u].pose[POSE_ARMS] = 0.6; }
      P_INTRO.id = this._id; P_INTRO.name = this._name; P_INTRO.duration = intro.fightAfter;
      this._emit('boss:intro', P_INTRO);
    } else {
      // mini-boss (endless): no slow-down, letterbox, dolly, input lock or invulnerability — straight to the fight.
      // boss:intro still fires (duration 0) so audio can roar; ui skips the letterbox for `mini` (ARCH §10.3).
      P_INTRO.id = this._id; P_INTRO.name = this._name; P_INTRO.duration = 0;
      this._emit('boss:intro', P_INTRO);
      this._inIntro = true;
      this._fightAt = now;
      this._beginFight();
    }
  }

  _beginFight() {
    if (!this._inIntro) return;
    this._inIntro = false;
    this._fightTime = 0;
    if (!this._mini) {
      if (this._engine && this._engine.lockInput) this._engine.lockInput(false);
      if (this._weapons && this._weapons.pauseTimers) this._weapons.pauseTimers(false);
    }
    for (let u = 0; u < this._unitCount; u++) { this._units[u].pose[POSE_JAW] = 0; this._units[u].pose[POSE_ARMS] = 0; }
    P_FIGHT.id = this._id;
    this._emit('boss:fight', P_FIGHT);
  }

  /** Debug (ARCH §13): ends the intro choreography now. */
  skipIntro() {
    if (!this._spawned || !this._inIntro) return;
    this._fightAt = theatreNow(this.ctx.time);
    if (this._render && this._render.cancelDolly) this._render.cancelDolly();
    this._beginFight();
  }

  _hasPlatesOffAction(phases) {
    for (let i = 0; i < phases.length; i++) {
      const acts = phases[i].onEnter;
      if (!acts) continue;
      for (let k = 0; k < acts.length; k++) if (acts[k].platesOff) return true;
    }
    return false;
  }

  _emit(name, payload) {
    if (this._events) this._events.emit(name, payload);
  }

  // -------------------------------------------------------------------------------------------
  // Public state
  // -------------------------------------------------------------------------------------------

  /** true from boss:spawn until boss:dead (intro included) — mirrors ctx.world.bossActive. */
  get active() { return this._spawned && !this._dead; }
  get hp() {
    let s = 0;
    for (let u = 0; u < this._unitCount; u++) if (this._units[u].state === U_ALIVE) s += this._units[u].hp;
    return s;
  }
  get maxHp() { return this._maxHpTotal; }
  /** 1-based phase of the furthest-advanced twin (0 before a spawn). */
  get phase() { return this._spawned ? this._reportedPhase : 0; }
  get x() { return this._mirrorX; }
  get z() { return this._mirrorZ; }
  get inIntro() { return this._inIntro; }

  /** Capsule test (r = BOSSES.radius) against the nearest living twin along the swept segment; t ∈ [0,1]. */
  hitTestSegment(x0, z0, x1, z1, radius, out) {
    SEG_B[0] = x0; SEG_B[1] = z0; SEG_B[2] = x1; SEG_B[3] = z1;
    return this.hitTestSeg(SEG_B, radius, out);
  }

  /**
   * hitTestSegment() reading the segment from a Float64Array(4) [x0, z0, x1, z1] (QA ENE-16 / WPN-8): same semantics
   * and `out` shape, nothing boxed. The hit test is XZ only; the reported impact point is cosmetic (QA ENE-13): the
   * capsule-entry z, x jittered by up to ±0.3·radius inside the capsule and y spread over the torso / core band
   * (BOSSES.hitYRange · coreY), so sparks and damage numbers land on the body instead of one point at its feet.
   */
  hitTestSeg(seg, radius, out) {
    if (!this._spawned || this._dead) return false;
    const x0 = seg[0], z0 = seg[1], x1 = seg[2], z1 = seg[3];
    const R = BOSS_R + radius;
    const dx = x1 - x0, dz = z1 - z0;
    const len2 = dx * dx + dz * dz;
    let bestT = 2, bestX = 0;
    for (let u = 0; u < this._unitCount; u++) {
      const unit = this._units[u];
      if (unit.state !== U_ALIVE) continue;
      const ux = unit.x, uz = unit.z;
      let t = 0;
      if (len2 > 1e-12) {
        t = ((ux - x0) * dx + (uz - z0) * dz) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
      }
      const px = x0 + dx * t - ux, pz = z0 + dz * t - uz;
      if (px * px + pz * pz <= R * R && t < bestT) { bestT = t; bestX = ux; }
    }
    if (bestT > 1) return false;
    const rf = this.ctx.rngFx;
    const ry = rf ? rf.next() : 0.5, rx = rf ? rf.next() : 0.5;
    let hx = x0 + dx * bestT + (rx * 2 - 1) * HIT_X_SPREAD;
    if (hx < bestX - BOSS_R) hx = bestX - BOSS_R; else if (hx > bestX + BOSS_R) hx = bestX + BOSS_R;
    out.x = hx; out.z = z0 + dz * bestT; out.y = HIT_Y0 + (HIT_Y1 - HIT_Y0) * ry; out.t = bestT;
    return true;
  }

  /** Core position of the living twin nearest the squad (weapons / troops re-aim target). */
  aimPoint(out) {
    const unit = this._nearestAlive(this.ctx.world ? this.ctx.world.squadX : 0, 0) || this._mirrorUnit || this._units[0];
    out.set(unit.x, BOSSES.coreY, unit.z);
    return out;
  }

  intersectsSquad() {
    if (!this._spawned || this._dead || !this._squad || !this._squad.intersectsCircle) return false;
    for (let u = 0; u < this._unitCount; u++) {
      const unit = this._units[u];
      if (unit.state === U_ALIVE && this._squad.intersectsCircle(unit.x, unit.z, BOSSES.radius)) return true;
    }
    return false;
  }

  _nearestAlive(x, z) {
    let best = null, bestD = Infinity;
    for (let u = 0; u < this._unitCount; u++) {
      const unit = this._units[u];
      if (unit.state !== U_ALIVE) continue;
      const dx = unit.x - x, dz = unit.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = unit; }
    }
    return best;
  }

  // -------------------------------------------------------------------------------------------
  // Damage / shield / phases / death
  // -------------------------------------------------------------------------------------------

  /**
   * weight = weighted hits for the Colossus shield gauge (bullet w, rocket 8, rail 10, laser 10·dt, sniper 1, drone 0).
   * While the shield is up `amount` is ignored and `weight` accumulates; otherwise profile.bossDamage and the
   * juggernaut platesOff damageMult apply to the twin nearest (x, z). Returns true when the boss (pair) dies.
   */
  damage(amount, weight, x, y, z, crit = false) {
    if (!this._spawned || this._dead) return false;
    if (this._inIntro) {
      // GDD §7: the intro is theatre — the fight starts at full HP. Bullets already aim at the boss, so they only
      // throw a throttled spark (no HP, shield, phase, boss:hit, damage numbers or flash).
      if (this._t - this._introSparkT >= INTRO_SPARK_EVERY) {
        this._introSparkT = this._t;
        if (this._fx && this._fx.emit) this._fx.emit('spark', x, y, z, 1);
      }
      return false;
    }
    const sh = this._shield;
    if (sh.up) {
      if (weight > 0) {
        // GDD §8.1: shield weights are subject to the 40 hits/s intake cap (token bucket refilled in step(); excess discarded)
        const w = weight < sh.tokens ? weight : sh.tokens;
        if (w > 0) {
          sh.tokens -= w;
          sh.hits += w;
          if (sh.hits > sh.needed) sh.hits = sh.needed;
          if (!this._tryDropShield()) this._emitShield();
        }
      }
      return false;
    }
    const unit = this._nearestAlive(x, z);
    if (!unit) return false;
    const prof = this.ctx.profile;
    const mult = (prof && prof.bossDamage) || 1;
    let dmg = amount * mult * unit.dmgMult;
    if (!(dmg > 0)) return false;
    if (dmg > unit.hp) dmg = unit.hp;
    unit.hp -= dmg;
    if (this._t - unit.hitT >= FLASH_RETRIGGER) unit.hitT = this._t;   // a blink per ≈0.2 s under sustained fire, never a white rig
    P_HIT.damage = dmg; P_HIT.x = x; P_HIT.y = y; P_HIT.z = z; P_HIT.crit = !!crit;
    this._emit('boss:hit', P_HIT);
    this._emitHp();
    if (unit.hp <= 0) {
      unit.hp = 0;
      this._killUnit(unit);
      return this._dead;
    }
    this._checkPhase(unit);
    return false;
  }

  _emitHp() {
    const hp = this.hp, max = this._maxHpTotal || 1;
    const raw = clamp(hp / max, 0, 1);
    // the bar falls in BOSSES.hpChunk (5 %) segments: report the chunk ceiling; hp/maxHp carry the truth
    const chunk = BOSSES.hpChunk;
    let frac = Math.ceil(raw / chunk - 1e-6) * chunk;
    if (hp <= 0) frac = 0;
    P_HP.hp = hp; P_HP.maxHp = max; P_HP.fraction = clamp(frac, 0, 1);
    this._emit('boss:hp', P_HP);
    this._hpDirty = false;
  }

  _emitShield() {
    const sh = this._shield;
    const unit = sh.unit || this._mirrorUnit || this._units[0];
    EV_SHIELD.hits = sh.hits; EV_SHIELD.needed = sh.needed; EV_SHIELD.up = sh.up; EV_SHIELD.x = unit.x; EV_SHIELD.z = unit.z;
    this._emit('boss:shield', EV_SHIELD);
  }

  /** Colossus phase-2 action { shield: fractionOfMaxHp }: raises the gauge (ARCH §6.8, GDD §7). */
  _raiseShield(unit, fraction) {
    const sh = this._shield;
    if (!(sh.needed > 0)) sh.needed = BOSSES.archetypes.colossus.shieldHits;   // a shield action on an archetype without shieldHits
    sh.up = true; sh.everUp = true; sh.hits = 0; sh.unit = unit;
    sh.upAt = this._t; sh.tokens = 0;                                      // the intake bucket starts empty: ≥ needed / 40 s up
    sh.pool = (fraction || this._arch.shieldPct || 0) * this._maxHpTotal;        // total HP the shield may regenerate while up
    sh.regenPerSec = (this._arch.shieldRegenPerSec || 0) * this._maxHpTotal;
    if (unit.rig && unit.rig.parts[P_SHIELD]) unit.rig.parts[P_SHIELD].visible = true;
    if (this._light) this._light.color.copy(_shieldColor);
    this._emitShield();
  }

  /** Drops the shield once the gauge is full and it has been up ≥ needed / intakePerSec (the intake-cap time). */
  _tryDropShield() {
    const sh = this._shield;
    if (!sh.up || sh.hits < sh.needed) return false;
    if (this._t - sh.upAt < sh.needed / SHIELD_RATE - 1e-6) return false;
    this._dropShield();
    return true;
  }

  _dropShield() {
    const sh = this._shield;
    if (!sh.up) return;
    sh.up = false; sh.hits = sh.needed;
    const unit = sh.unit;
    if (unit && unit.rig && unit.rig.parts[P_SHIELD]) unit.rig.parts[P_SHIELD].visible = false;
    if (this._light) this._light.color.copy(this._reportedPhase >= 3 ? _rageColor : _coreColor);
    if (this._fx && this._fx.emit && unit) this._fx.emit('spark', unit.x, BOSSES.coreY, unit.z, JUICE.bursts.flip);
    this._emitShield();
    sh.unit = null;
  }

  /** Phase transitions only move forward (shield regen never re-enters an earlier phase). */
  _checkPhase(unit) {
    const idx = phaseIndexFor(this._phases, unit.maxHp > 0 ? unit.hp / unit.maxHp : 0);
    while (unit.phaseIdx < idx) this._enterPhase(unit, unit.phaseIdx + 1);
  }

  _enterPhase(unit, idx) {
    unit.phaseIdx = idx;
    const phase = this._phases[idx];
    unit.targetZ = BOSSES.holdZ[Math.min(idx, BOSSES.holdZ.length - 1)] + unit.zOff;   // only the hold moves
    unit.cool = Math.min(unit.cool, PHASE_ENTRY_COOL);                    // the phase's basic attack follows within 1 s
    unit.pose[POSE_JAW] = 1;                                              // roar on every phase change
    // generic phase-2 beat: 4 armour plates fly off (unless a platesOff action governs them)
    if (idx === 1 && !this._platesOffGoverned) this._detachPlates(unit);
    // generic phase-3 beat: rage glow (render), one last horde (once per pair)
    if (idx >= 2 && !this._hordeDone) {
      this._hordeDone = true;
      this._spawnMinions(unit, 'walker', BOSSES.lastHorde);
      if (this._light && !this._shield.up) this._light.color.copy(_rageColor);
    }
    const acts = phase.onEnter;
    if (acts) {
      for (let k = 0; k < acts.length; k++) {
        const a = acts[k];
        if (a.spawn) this._spawnUnits(unit, a.spawn);
        else if (a.attack) unit.pendingAttack = a;                      // runs as soon as the unit is idle
        else if (typeof a.shield === 'number') this._raiseShield(unit, a.shield);
        else if (a.platesOff) { unit.dmgMult = a.damageMult || 1; this._detachPlates(unit); }
      }
    }
    const phaseNo = idx + 1;
    if (phaseNo > this._reportedPhase) {
      this._reportedPhase = phaseNo;
      P_PHASE.phase = phaseNo; P_PHASE.fraction = clamp(unit.hp / (unit.maxHp || 1), 0, 1);
      this._emit('boss:phase', P_PHASE);
    }
  }

  /** zombies.spawnWave({ pattern:'horde', units }, spec.minionHp) — the boss never computes HP (ARCH D8). */
  _spawnUnits(unit, counts) {
    if (!this._zombies || !this._zombies.spawnWave) return;
    for (let i = 0; i < TYPES.length; i++) WAVE.units[TYPES[i]] = counts[TYPES[i]] | 0;
    WAVE.x = unit.x;
    WAVE.z = Math.max(WORLD.spawnZ, unit.z - MINION_BEHIND_M);
    WAVE.spread = 0;
    this._zombies.spawnWave(WAVE, this._minionHp);
  }

  _spawnMinions(unit, type, count) {
    if (!this._zombies || !this._zombies.spawnWave) return;
    for (let i = 0; i < TYPES.length; i++) WAVE.units[TYPES[i]] = 0;
    WAVE.units[type] = count | 0;
    WAVE.x = unit.x;
    WAVE.z = Math.max(WORLD.spawnZ, unit.z - MINION_BEHIND_M);
    WAVE.spread = 0;
    this._zombies.spawnWave(WAVE, this._minionHp);
  }

  /** One twin reaches 0 HP: it collapses on its own (real time); the pair dies with the last twin. */
  _killUnit(unit) {
    if (unit.state !== U_ALIVE) return;
    unit.state = U_DYING;
    unit.deathAt = theatreNow(this.ctx.time);                          // collapse on the theatre clock (QA ENE-17)
    unit.vz = 0;
    this._cancelAttack(unit);
    unit.pose[POSE_JAW] = 1; unit.pose[POSE_ARMS] = 0.3;
    if (this._shield.up && this._shield.unit === unit) this._dropShield();
    let anyAlive = false;
    for (let u = 0; u < this._unitCount; u++) if (this._units[u].state === U_ALIVE) anyAlive = true;
    if (!anyAlive) this._die(unit);
    else if (this._mirrorUnit === unit) this._mirrorUnit = this._nearestAlive(unit.x, unit.z);
  }

  /** Death choreography (GDD §7 / J16): slow-mo, boss:dead, the single boss coin credit; fx answers with the
   *  fountain/confetti/flash/bloom from boss:dead; collapse runs 1.8 s real time in render(). */
  _die(unit) {
    this._dead = true;
    this._inIntro = false;
    if (this._shield.up) this._dropShield();
    this._clearGlobs();
    if (this.ctx.world) this.ctx.world.bossActive = false;
    if (this._fx && this._fx.slowmo) this._fx.slowmo(BOSSES.death.slowmo, BOSSES.death.slowmoTime);
    if (this._fx && this._fx.addTrauma) this._fx.addTrauma(JUICE.trauma.bossDeath);
    P_DEAD.id = this._id; P_DEAD.x = unit.x; P_DEAD.z = unit.z;
    this._emit('boss:dead', P_DEAD);
    P_COIN.amount = ECONOMY.bossCoins(this._L); P_COIN.x = unit.x; P_COIN.y = BOSSES.coreY; P_COIN.z = unit.z; P_COIN.source = 'boss';
    this._emit('coin:pickup', P_COIN);
    this._emitHp();
  }

  // -------------------------------------------------------------------------------------------
  // Rig pose restore / plates (spawn, reset, phase)
  // -------------------------------------------------------------------------------------------

  _restoreRig(rig) {
    const parts = rig.parts, rest = rig.rest;
    for (let i = 0; i < PART_COUNT; i++) {
      const p = parts[i];
      if (!p) continue;
      p.position.set(rest[i * 6], rest[i * 6 + 1], rest[i * 6 + 2]);
      p.rotation.set(rest[i * 6 + 3], rest[i * 6 + 4], rest[i * 6 + 5]);
    }
    for (let i = 0; i < rig.chains.length; i++) rig.chains[i].rotation.set(rig.chainRest[i * 3], rig.chainRest[i * 3 + 1], rig.chainRest[i * 3 + 2]);
    if (parts[P_CORE]) parts[P_CORE].scale.setScalar(rig.coreScale);
    if (parts[P_SHIELD]) { parts[P_SHIELD].visible = false; parts[P_SHIELD].scale.setScalar(1); }
    for (let i = 0; i < rig.plates.length; i++) {
      const plate = rig.plates[i];
      if (rig.plateDetached[i]) {
        rig.plateParent[i].attach(plate);                                  // back under the rig, then snap to the rest pose
        rig.plateDetached[i] = 0;
      }
      plate.position.copy(rig.platePos[i]); plate.quaternion.copy(rig.plateQuat[i]); plate.scale.copy(rig.plateScale[i]);
      plate.visible = true;
    }
    rig.platesGone = false;
    for (let i = 0; i < rig.bodyMats.length; i++) { rig.bodyMats[i].emissive.setRGB(0, 0, 0); rig.bodyMats[i].emissiveIntensity = 1; }
    for (let i = 0; i < rig.glowMats.length; i++) rig.glowMats[i].color.setRGB(rig.glowBase[i * 3], rig.glowBase[i * 3 + 1], rig.glowBase[i * 3 + 2]);
    if (rig.coreMat && rig.coreBase) rig.coreMat.color.copy(rig.coreBase);
    if (rig.glowCols !== null) {
      const gc = rig.glowCols, cb = rig.glowColBase;
      for (let i = 0; i < gc.length; i++) gc[i].set(cb[i * 3], cb[i * 3 + 1], cb[i * 3 + 2]);
    }
    rig.group.position.y = 0;
    rig.group.rotation.set(0, 0, 0);
  }

  _releaseUnit(unit) {
    if (unit.state === U_FREE) return;
    this._cancelAttack(unit);
    const rig = unit.rig;
    if (rig) { this._restoreRig(rig); rig.group.visible = false; rig.inUse = false; }
    unit.rig = null; unit.state = U_FREE; unit.hp = 0; unit.maxHp = 0; unit.pendingAttack = null;
  }

  /** GDD §7 phase 2: the 4 plates detach with bloom sparks and fly off (world-space, gravity). */
  _detachPlates(unit) {
    const rig = unit.rig;
    if (!rig || rig.platesGone || !this._scene) return;
    rig.platesGone = true;
    const n = rig.plates.length;
    const rngFx = this.ctx.rngFx;
    for (let i = 0; i < n; i++) {
      const plate = rig.plates[i];
      if (rig.plateDetached[i] || !plate.visible) continue;
      plate.getWorldPosition(_v);
      this._scene.attach(plate);
      rig.plateDetached[i] = 1;
      let dx = _v.x - unit.x, dz = _v.z - unit.z;
      const d = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= d; dz /= d;
      const j = rngFx ? rngFx.range(0.8, 1.2) : 1;
      const f = rig.plateFly, o = i * 7;
      f[o] = 0;                                                            // elapsed
      f[o + 1] = dx * PLATE_SPEED * j; f[o + 2] = PLATE_UP * j; f[o + 3] = dz * PLATE_SPEED * j + (this.ctx.world ? this.ctx.world.roadSpeed : 0);
      f[o + 4] = (rngFx ? rngFx.range(-1, 1) : 1) * PLATE_SPIN; f[o + 5] = (rngFx ? rngFx.range(-1, 1) : 0.5) * PLATE_SPIN; f[o + 6] = 0;
      if (this._fx && this._fx.emit) this._fx.emit('spark', _v.x, _v.y, _v.z, PLATE_SPARKS);
    }
  }

  // -------------------------------------------------------------------------------------------
  // step — movement, attacks, globs, car, valve, minions, shield regen, world mirror (allocation-free)
  // -------------------------------------------------------------------------------------------

  step(dt) {
    const ctx = this.ctx;
    const world = ctx.world;
    if (!this._spawned) {
      if (world) world.bossActive = false;
      // round 5: the post-reset re-warm, one archetype per step once the countdown has run out
      if (this._warmCountdown >= 0) {
        if (this._warmCountdown > 0) this._warmCountdown--;
        else if (this._warmAt < this._warmKeys.length) this._warmArchetype(this._warmKeys[this._warmAt++]);
        else this._warmCountdown = -1;
      }
      return;
    }
    this._t += dt;
    if (this._inIntro && theatreNow(ctx.time) >= this._fightAt) this._beginFight();
    const fighting = !this._inIntro && !this._dead;
    const roadSpeed = world ? world.roadSpeed : 0;

    if (fighting) {
      this._fightTime += dt;
      if (!this._valve && this._fightTime >= BOSSES.valve.after) this._valve = true;
      // phase-1 minion bursts: BOSSES.minionBurst.count walkers every BOSSES.minionBurst.every s
      if (this._reportedPhase <= 1) {
        this._burstTimer += dt;
        if (this._burstTimer >= BOSSES.minionBurst.every) {
          this._burstTimer -= BOSSES.minionBurst.every;
          this._spawnMinions(this._mirrorUnit || this._units[0], 'walker', BOSSES.minionBurst.count);
        }
      }
      // Colossus shield: regenerates shieldRegenPerSec·maxHp per second while up, clamped to the shield size
      const sh = this._shield;
      if (sh.up) {
        sh.tokens += SHIELD_RATE * dt;
        if (sh.tokens > SHIELD_BURST) sh.tokens = SHIELD_BURST;
        this._tryDropShield();
      }
      if (sh.up && sh.pool > 0 && sh.unit && sh.unit.state === U_ALIVE) {
        let heal = sh.regenPerSec * dt;
        if (heal > sh.pool) heal = sh.pool;
        const room = sh.unit.maxHp - sh.unit.hp;
        if (heal > room) heal = room;
        if (heal > 0) { sh.unit.hp += heal; sh.pool -= heal; this._hpDirty = true; }
      }
    }

    for (let u = 0; u < this._unitCount; u++) {
      const unit = this._units[u];
      if (unit.state === U_ALIVE) {
        this._moveUnit(unit, dt, roadSpeed);
        if (fighting) this._attackStep(unit, dt);
      } else if (unit.state === U_DYING) {
        unit.z += roadSpeed * dt;                                            // the corpse rides the road
      }
    }
    if (fighting && this._valve) this._valveStep(dt);
    this._globStep(dt);
    this._carStep(dt, roadSpeed);

    if (this._hpDirty) {
      this._hpEmitAcc += dt;
      if (this._hpEmitAcc >= 1 / HP_EMIT_HZ) { this._hpEmitAcc = 0; this._emitHp(); }
    }

    // mirror ctx.world (nearest living twin to the squad)
    const near = this._nearestAlive(world ? world.squadX : 0, 0);
    if (near) { this._mirrorUnit = near; this._mirrorX = near.x; this._mirrorZ = near.z; }
    if (world) { world.bossActive = this._spawned && !this._dead; world.bossX = this._mirrorX; world.bossZ = this._mirrorZ; }
  }

  /** Approach from approachZ to the phase hold (own speed +APPROACH_SPEED), hold with ownSpeed = −roadSpeed,
   *  lunge during a charge (atk.speed in the squad frame — the hold is already squad-stationary — never past
   *  CHARGE_STOP_Z); x returns to the home x (twins ±twinOffsetX) between charges. */
  _moveUnit(unit, dt, roadSpeed) {
    const atk = unit.atk;
    const target = this._valve ? BOSSES.valve.z : unit.targetZ;
    let vz;
    if (atk.state === A_EXECUTE && (atk.kind === K_CHARGE || atk.kind === K_LANE)) {
      vz = atk.speed;
      if (unit.z + vz * dt > CHARGE_STOP_Z) vz = Math.max(0, (CHARGE_STOP_Z - unit.z) / dt);
      unit.x = lerpExp(unit.x, atk.laneX, ANIM.chargeXRate, dt);
    } else {
      vz = clamp((target - unit.z) * HOLD_GAIN, -RETREAT_SPEED, roadSpeed + APPROACH_SPEED);
      unit.x = lerpExp(unit.x, unit.homeX, ANIM.homeXRate, dt);
    }
    unit.z += vz * dt;
    unit.vz = vz;
    unit.arrived = Math.abs(target - unit.z) <= ARRIVE_M;
    // gait from the road-relative speed (holding = walking in place at roadSpeed); a giant lengthens its stride
    // rather than its cadence above 1.5x the reference speed
    const rel = Math.abs(vz - roadSpeed);
    unit.gait = lerpExp(unit.gait, clamp(rel / GAIT_REF_MS, 0, 1.5), ANIM.gaitRate, dt);
    unit.walkPhase += Math.min(rel, GAIT_REF_MS * 1.5) * ANIM.walkHzPerMs * Math.PI * 2 * dt;
    // face the squad (the rig faces +Z at rest)
    const squad = this._squad;
    const sx = squad ? squad.x : (this.ctx.world ? this.ctx.world.squadX : 0);
    const sz = squad ? squad.centerZ : 0;
    const yawT = Math.atan2(sx - unit.x, sz - unit.z);
    unit.yaw = lerpExp(unit.yaw, yawT, ANIM.yawRate, dt);
  }

  /** Attack cadence is start-to-start: `cool` runs in every attack state (GDD §7 phases[].interval is the attack
   *  period); a new attack never starts before the previous one's recovery ends. Phase specials (onEnter) run as
   *  soon as the unit is idle; basic attacks need the boss within ATTACK_RANGE_M of the squad front. */
  _attackStep(unit, dt) {
    const atk = unit.atk;
    if (!this._valve) unit.cool -= dt;
    switch (atk.state) {
      case A_IDLE: {
        if (this._valve) return;                                            // the valve chews instead
        if (unit.pendingAttack) {
          const a = unit.pendingAttack;
          unit.pendingAttack = null;
          this._startAttack(unit, a.attack, a);
          return;
        }
        if (unit.cool <= 0 && unit.z >= -ATTACK_RANGE_M) {
          const phase = this._phases[unit.phaseIdx];
          let kind = phase.attack, params = phase;
          if (kind === K_CYCLE) {
            const cyc = this._arch.cycle;
            if (cyc && cyc.length) {
              kind = cyc[unit.cycleIdx % cyc.length];
              unit.cycleIdx++;
              params = this._arch[kind] || phase;
            } else kind = K_SLAM;
          }
          unit.cool = phase.interval || BOSSES.archetypes.hulk.phases[0].interval;   // default cadence: the hulk slam's 5 s
          this._startAttack(unit, kind, params);
        }
        break;
      }
      case A_TELEGRAPH: {
        atk.timer += dt;
        if (atk.decal >= 0 && this._fx && this._fx.decalProgress) this._fx.decalProgress(atk.decal, clamp(atk.timer / atk.dur, 0, 1));
        if (atk.timer >= atk.dur) this._telegraphDone(unit);
        break;
      }
      case A_EXECUTE: {
        atk.timer += dt;
        if (atk.kind === K_CHARGE || atk.kind === K_LANE) {
          if (atk.timer >= atk.exec) this._resolveCharge(unit);
        } else if (atk.kind === K_RAIN) {
          // `total` splashes spread evenly over `exec` seconds
          while (atk.launched < atk.total && atk.timer >= atk.launched * atk.exec / atk.total) {
            this._launchRainGlob(unit, atk.params);
            atk.launched++;
          }
          if (atk.launched >= atk.total) { atk.state = A_RECOVER; atk.timer = 0; unit.pose[POSE_JAW] = 0; }
        }
        break;
      }
      case A_RECOVER: {
        atk.timer += dt;
        if (atk.timer >= RECOVER_SECONDS) {
          atk.state = A_IDLE; atk.timer = 0;
          unit.pose[POSE_ARMS] = 0; unit.pose[POSE_LEAN] = 0; unit.pose[POSE_CROUCH] = 0; unit.pose[POSE_STOMP] = 0; unit.pose[POSE_JAW] = 0;
        }
        break;
      }
      default: break;
    }
  }

  /** Begins an attack: telegraph decal + boss:attack { kind, x, z, radius, delay, lane } + wind-up pose. */
  _startAttack(unit, kind, params) {
    const atk = unit.atk;
    const squad = this._squad, world = this.ctx.world;
    const cx = squad ? squad.x : (world ? world.squadX : 0);
    // every telegraph / landing sits on the target line just ahead of the squad front (visible above the bottom
    // letterbox); hit tests are x-only, the player steers in x only (GDD §7, pillar 5)
    const cz = TARGET_Z;
    atk.kind = kind; atk.params = params; atk.timer = 0; atk.launched = 0; atk.lane = -1; atk.decal = -1; atk.exec = 0; atk.total = 0;
    const hulkSlam = BOSSES.archetypes.hulk.phases[0];                     // fallbacks for omitted slam params
    switch (kind) {
      case K_SLAM: {
        atk.ax = cx; atk.az = cz;
        atk.radius = params.radius || hulkSlam.radius;
        atk.dur = params.telegraph || hulkSlam.telegraph;
        atk.decal = this._decal('ring', atk.ax, atk.az, atk.radius * 2, atk.dur, PALETTE.boss.rage, true);
        unit.pose[POSE_ARMS] = 1; unit.pose[POSE_CROUCH] = 0;
        atk.state = A_TELEGRAPH;
        this._emitAttack(kind, atk.ax, atk.az, atk.radius, atk.dur, -1);
        break;
      }
      case K_STOMP: {
        atk.ax = unit.x; atk.az = unit.z; atk.radius = STOMP_RADIUS;
        atk.dur = params.telegraph || BOSSES.archetypes.juggernaut.phases[0].telegraph;
        atk.decal = this._decal('ring', atk.ax, atk.az, atk.radius * 2, atk.dur, PALETTE.boss.rage);
        unit.pose[POSE_STOMP] = 1;
        atk.state = A_TELEGRAPH;
        this._emitAttack(kind, atk.ax, atk.az, atk.radius, atk.dur, -1);
        break;
      }
      case K_CHARGE:
      case K_LANE: {
        const width = params.width || BOSSES.archetypes.hulk.phases[1].onEnter[0].width;
        const half = width / 2;
        if (kind === K_LANE) {
          const pair = WORLD.laneCenters.pair;                             // "a charge down one half"
          atk.laneX = cx < 0 ? pair[0] : pair[1];
        } else {
          atk.laneX = clamp(cx, -(WORLD.roadWidth / 2 - half), WORLD.roadWidth / 2 - half);
        }
        atk.lane = atk.laneX < 0 ? 0 : 1;
        atk.radius = half;
        atk.speed = params.speed || CHARGE_SPEED;
        atk.exec = params.duration || CHARGE_DURATION;
        atk.dur = params.telegraph || BOSSES.archetypes.hulk.phases[1].onEnter[0].telegraph;
        atk.ax = atk.laneX; atk.az = (unit.z + cz) / 2;
        atk.decal = this._decal('lane', atk.laneX, atk.az, width, atk.dur + atk.exec, PALETTE.boss.rage, true);
        unit.pose[POSE_LEAN] = 1; unit.pose[POSE_CROUCH] = 1;
        atk.state = A_TELEGRAPH;
        this._emitAttack(kind, atk.laneX, unit.z, half, atk.dur, atk.lane);
        break;
      }
      case K_CAR: {
        const band = params.band || BOSSES.archetypes.juggernaut.phases[1].onEnter[0].band;
        atk.ax = cx; atk.az = cz; atk.radius = band / 2;
        atk.dur = params.telegraph || BOSSES.archetypes.juggernaut.phases[1].onEnter[0].telegraph;
        atk.decal = this._decal('xband', atk.ax, atk.az, band, atk.dur, PALETTE.boss.rage, true);
        this._throwCar(unit, atk.ax, atk.az, atk.dur);
        unit.pose[POSE_ARMS] = 1;
        atk.state = A_TELEGRAPH;
        this._emitAttack(kind, atk.ax, atk.az, atk.radius, atk.dur, -1);
        break;
      }
      case K_SPIT3: {
        const kills = this._spitKills(params);
        const preview = params.preview || ZOMBIES.spitter.spit.preview;
        const rng = this.ctx.rng;
        const dz = cz - unit.z, dx = cx - unit.x;
        const T = Math.max(preview, Math.sqrt(dx * dx + dz * dz) / ZOMBIES.spitter.spit.speed);
        for (let i = -1; i <= 1; i++) {
          const jx = rng ? rng.range(-SPIT_JITTER, SPIT_JITTER) : 0, jz = rng ? rng.range(-SPIT_JITTER, SPIT_JITTER) : 0;
          this._launchGlob(unit, clamp(cx + i * SPIT3_SPREAD + jx, -WORLD.roadWidth / 2, WORLD.roadWidth / 2), cz + jz, kills, T);
        }
        atk.ax = cx; atk.az = cz; atk.radius = ZOMBIES.spitter.spit.splash; atk.dur = T;
        unit.pose[POSE_JAW] = 1;
        atk.state = A_RECOVER;
        this._emitAttack(kind, cx, cz, atk.radius, T, -1);
        break;
      }
      case K_RAIN: {
        atk.total = params.splashes || BOSSES.archetypes.spitterQueen.phases[1].onEnter[0].splashes;
        atk.exec = params.duration || BOSSES.archetypes.spitterQueen.phases[1].onEnter[0].duration;
        atk.ax = cx; atk.az = cz; atk.radius = RAIN_HALF_X; atk.dur = atk.exec;
        unit.pose[POSE_JAW] = 1; unit.pose[POSE_ARMS] = 0.7;
        atk.state = A_EXECUTE;
        this._emitAttack(kind, cx, cz, RAIN_HALF_X, atk.exec, -1);
        break;
      }
      default: {
        warnOnce('boss.attack.' + kind, 'unknown boss attack kind ' + kind);
        atk.state = A_IDLE;
        break;
      }
    }
  }

  _emitAttack(kind, x, z, radius, delay, lane) {
    P_ATTACK.kind = kind; P_ATTACK.x = x; P_ATTACK.z = z; P_ATTACK.radius = radius; P_ATTACK.delay = delay; P_ATTACK.lane = lane;
    this._emit('boss:attack', P_ATTACK);
  }

  /** Telegraph elapsed: resolve (slam / stomp / car) or start the lunge (charge / lane). */
  _telegraphDone(unit) {
    const atk = unit.atk;
    const squad = this._squad;
    const cx = squad ? squad.x : (this.ctx.world ? this.ctx.world.squadX : 0);
    switch (atk.kind) {
      case K_SLAM: {
        this._removeDecal(atk);
        if (Math.abs(cx - atk.ax) <= atk.radius) {                         // x-only: the formation centre inside the ring's x span
          this._applyKills(unit, this._killsFor(atk.params), K_SLAM, atk.ax, atk.az, atk.radius);
        }
        this._impactJuice(atk.ax, atk.az, JUICE.bursts.splat);
        unit.pose[POSE_ARMS] = 0; unit.pose[POSE_CROUCH] = 1;
        atk.state = A_RECOVER; atk.timer = 0;
        break;
      }
      case K_STOMP: {
        this._removeDecal(atk);
        // a stomp shockwave is unavoidable (GDD §7: "kills 4 % of C (min 3)"); the ring is the warning
        this._applyKills(unit, this._killsFor(atk.params), K_STOMP, unit.x, unit.z, atk.radius);
        this._impactJuice(unit.x, unit.z, JUICE.bursts.rocket);
        unit.pose[POSE_STOMP] = 0; unit.pose[POSE_CROUCH] = 1;
        atk.state = A_RECOVER; atk.timer = 0;
        break;
      }
      case K_CHARGE:
      case K_LANE: {
        atk.state = A_EXECUTE; atk.timer = 0;
        unit.pose[POSE_LEAN] = 1; unit.pose[POSE_CROUCH] = 0; unit.pose[POSE_JAW] = 1;
        break;
      }
      case K_CAR: {
        this._removeDecal(atk);
        this._landCar();
        if (Math.abs(cx - atk.ax) <= atk.radius) {
          this._applyKills(unit, this._killsFor(atk.params), K_CAR, atk.ax, atk.az, atk.radius);
        }
        this._impactJuice(atk.ax, atk.az, JUICE.bursts.rocket);
        unit.pose[POSE_ARMS] = 0;
        atk.state = A_RECOVER; atk.timer = 0;
        break;
      }
      default: { atk.state = A_RECOVER; atk.timer = 0; break; }
    }
  }

  _resolveCharge(unit) {
    const atk = unit.atk;
    const squad = this._squad;
    const cx = squad ? squad.x : (this.ctx.world ? this.ctx.world.squadX : 0);
    this._removeDecal(atk);
    if (Math.abs(cx - atk.laneX) <= atk.radius) {
      this._applyKills(unit, this._killsFor(atk.params), atk.kind, atk.laneX, unit.z, atk.radius);
    }
    this._impactJuice(unit.x, unit.z, JUICE.bursts.splat);
    unit.pose[POSE_LEAN] = 0; unit.pose[POSE_JAW] = 0; unit.pose[POSE_CROUCH] = 0;
    unit.arrived = false;                                                  // walks back to the hold (attacks only need ATTACK_RANGE_M)
    atk.state = A_RECOVER; atk.timer = 0;
  }

  /** kills_total = (killsPct ? max(min, round(killsPct·C)) : kills) + floor(L · killsPerLevel) — ARCH §8.7. */
  _killsFor(params) {
    const C = this._squad ? this._squad.count : (this.ctx.world ? this.ctx.world.squadCount : 0);
    let k = params.killsPct ? Math.max(params.min | 0, Math.round(params.killsPct * C)) : (params.kills | 0);
    k += Math.floor(this._L * (params.killsPerLevel || 0));
    return k;
  }

  /** Spit kills: `kills` (1), one more from `kills2FromLevel` (L10) — GDD §7. */
  _spitKills(params) {
    const base = (params.kills != null) ? params.kills : ZOMBIES.spitter.spit.kills;
    const from = (params.kills2FromLevel != null) ? params.kills2FromLevel : ZOMBIES.spitter.spit.kills2FromLevel;
    return this._L >= from ? base + 1 : base;
  }

  /** Kill resolution: the APC absorbs what it intersects first; plates never absorb boss attacks (squad decides
   *  by reason); squad invulnerability (gate pass / intro / level end) blocks the rest. Returns soldiers removed. */
  _applyKills(unit, n, kind, x, z, radius) {
    if (!(n > 0)) return 0;
    let remaining = n;
    const troops = this._troops;
    if (troops && troops.apcAbsorb) {
      const hits = (!troops.apcIntersects || troops.apcIntersects(x, z, radius)) ? troops.apcAbsorb(n) | 0 : 0;
      remaining -= hits;
    }
    const squad = this._squad;
    if (remaining > 0 && squad && squad.removeSoldiers && !squad.invulnerable) {
      squad.removeSoldiers(remaining, REASON_OF[kind] || 'slam', x, z);
      return remaining;
    }
    return 0;
  }

  _impactJuice(x, z, dust) {
    const fx = this._fx;
    if (!fx) return;
    if (fx.addTrauma) fx.addTrauma(JUICE.trauma.bossSlam);
    if (fx.emit) fx.emit('dust', x, 0.1, z, dust);
  }

  /**
   * fx ground decal. Round 7 (r7 boss telegraph visibility): `onTop` = a telegraph that sits on the formation (the slam ring at the
   * squad front, the charge stripe, the car band, the acid marks) — fx draws it without the depth test, so a big squad's bodies never
   * hide its rim or its fill; the stomp ring at the boss stays depth-tested (the boss rig occludes it as before).
   */
  _decal(kind, x, z, size, seconds, color, onTop) {
    const fx = this._fx;
    if (!fx || !fx.decal) return -1;
    const id = fx.decal(kind, x, z, size, seconds, color, onTop === true);
    return (typeof id === 'number') ? id : -1;
  }

  _removeDecal(atk) {
    if (atk.decal >= 0 && this._fx && this._fx.removeDecal) this._fx.removeDecal(atk.decal);
    atk.decal = -1;
  }

  _resetAttack(unit) {
    const atk = unit.atk;
    atk.state = A_IDLE; atk.timer = 0; atk.dur = 0; atk.exec = 0; atk.decal = -1; atk.launched = 0; atk.total = 0; atk.params = null; atk.lane = -1;
  }

  _cancelAttack(unit) {
    const atk = unit.atk;
    this._removeDecal(atk);
    if (this._car && this._car.state === 1 && this._car.unit === unit) this._hideCar();
    this._resetAttack(unit);
    unit.pose[POSE_ARMS] = 0; unit.pose[POSE_LEAN] = 0; unit.pose[POSE_STOMP] = 0; unit.pose[POSE_CROUCH] = 0;
  }

  // ---- safety valve (GDD §7) -----------------------------------------------------------------

  _valveStep(dt) {
    const unit = this._mirrorUnit && this._mirrorUnit.state === U_ALIVE ? this._mirrorUnit : this._nearestAlive(0, 0);
    if (!unit) return;
    if (unit.z < BOSSES.valve.z - ARRIVE_M * 0.5) return;                  // still walking in
    this._chewAcc += dt;
    if (this._chewAcc >= 1) {
      this._chewAcc -= 1;
      this._chew(unit);
    }
  }

  _chew(unit) {
    unit.chewT = this._t;
    this._emitAttack(K_CHEW, unit.x, unit.z, 0, 0, -1);
    this._applyKills(unit, BOSSES.valve.perSec, K_CHEW, unit.x, unit.z, BOSSES.radius);
    if (this._fx && this._fx.vignette) this._fx.vignette(PALETTE.flash.red, JUICE.flashes.chewVignette);
  }

  // ---- globs (boss spit) --------------------------------------------------------------------

  _launchGlob(unit, tx, tz, kills, T) {
    const g = this._glob;
    if (g.count >= GLOB_POOL) {
      const dbg = this.ctx.debug;
      if (dbg && dbg.enabled && dbg.dropped) dbg.dropped['boss.globs'] = (dbg.dropped['boss.globs'] | 0) + 1;
      return;
    }
    const i = g.count++;
    // launch from the rig's mouth (jaw, else head) so the globs leave the head instead of hovering at the chest
    const rig = unit.rig;
    const mouth = rig ? (rig.parts[P_JAW] || rig.parts[P_HEAD]) : null;
    if (mouth) {
      mouth.getWorldPosition(_v);
      g.x0[i] = _v.x; g.y0[i] = _v.y; g.z0[i] = _v.z;
    } else {
      g.x0[i] = unit.x; g.y0[i] = GLOB_MOUTH_Y; g.z0[i] = unit.z;
    }
    g.tx[i] = tx; g.tz[i] = tz; g.t0[i] = this._t; g.T[i] = T; g.kills[i] = kills;
    g.spin[i] = this.ctx.rngFx ? this.ctx.rngFx.range(-6, 6) : 3;           // cosmetic tumble (rad/s)
    g.decal[i] = this._decal('arc', tx, tz, ZOMBIES.spitter.spit.splash * 2, T, PALETTE.fx.acid, true);
  }

  _launchRainGlob(unit, params) {
    const rng = this.ctx.rng;
    const tx = rng ? rng.range(-RAIN_HALF_X, RAIN_HALF_X) : 0;
    const tz = TARGET_Z + (rng ? rng.range(RAIN_Z_BACK, RAIN_Z_FWD) : 0);
    const dx = tx - unit.x, dz = tz - unit.z;
    const preview = ZOMBIES.spitter.spit.preview;
    const T = Math.max(preview, Math.sqrt(dx * dx + dz * dz) / ZOMBIES.spitter.spit.speed);
    this._launchGlob(unit, tx, tz, this._spitKills(params), T);
  }

  _globStep(dt) {
    const g = this._glob;
    const fx = this._fx;
    for (let i = 0; i < g.count; i++) {
      const s = (this._t - g.t0[i]) / g.T[i];
      if (s >= 1) {
        this._globImpact(i);
        this._globFree(i);
        i--;
      } else if (g.decal[i] >= 0 && fx && fx.decalProgress) {
        fx.decalProgress(g.decal[i], s);
      }
    }
  }

  /** Splash at the target line: hits when it overlaps the formation footprint in x
   *  (|squad.x − x| ≤ halfWidth + splash/2 — flank splashes that land on the formation count), APC absorb,
   *  squad.removeSoldiers(k, 'spit'). */
  _globImpact(i) {
    const g = this._glob;
    const x = g.tx[i], z = g.tz[i];
    const splash = ZOMBIES.spitter.spit.splash;
    const squad = this._squad;
    let applied = 0;
    if (squad) {
      const world = this.ctx.world;
      const hw = (typeof squad.halfWidth === 'number') ? squad.halfWidth : (world ? world.squadHalfWidth : 0);
      if (Math.abs(squad.x - x) <= hw + splash * 0.5) {
        applied = this._applyKills(this._mirrorUnit || this._units[0], g.kills[i], K_SPIT3, x, z, splash);
      }
    }
    P_SPIT.x = x; P_SPIT.z = z; P_SPIT.radius = splash; P_SPIT.kills = applied;
    this._emit('spit:impact', P_SPIT);
  }

  _globFree(i) {
    const g = this._glob;
    if (g.decal[i] >= 0 && this._fx && this._fx.removeDecal) this._fx.removeDecal(g.decal[i]);
    const last = g.count - 1;
    if (i !== last) {
      g.x0[i] = g.x0[last]; g.y0[i] = g.y0[last]; g.z0[i] = g.z0[last]; g.tx[i] = g.tx[last]; g.tz[i] = g.tz[last];
      g.t0[i] = g.t0[last]; g.T[i] = g.T[last]; g.kills[i] = g.kills[last]; g.decal[i] = g.decal[last]; g.spin[i] = g.spin[last];
    }
    g.count = last;
    if (this._globMesh) this._globMesh.count = last;
  }

  _clearGlobs() {
    const g = this._glob;
    if (!g) return;
    for (let i = 0; i < g.count; i++) if (g.decal[i] >= 0 && this._fx && this._fx.removeDecal) this._fx.removeDecal(g.decal[i]);
    g.count = 0;
    if (this._globMesh) { this._globMesh.count = 0; this._globMesh.visible = false; }
  }

  // ---- thrown car (juggernaut) --------------------------------------------------------------

  _throwCar(unit, tx, tz, T) {
    const car = this._car;
    if (!car) return;
    car.state = 1; car.unit = unit;
    car.x0 = unit.x; car.y0 = CAR_LAUNCH_Y; car.z0 = unit.z; car.tx = tx; car.tz = tz; car.t0 = this._t; car.T = T;
    car.spin = this.ctx.rngFx ? this.ctx.rngFx.range(0.6, 1.0) * CAR_SPIN : CAR_SPIN;
    car.rx = 0; car.rz = 0;
    car.mesh.visible = true;
    car.mesh.position.set(car.x0, car.y0, car.z0);
  }

  _landCar() {
    const car = this._car;
    if (!car || car.state !== 1) return;
    car.state = 2;
    car.mesh.position.set(car.tx, CAR_REST_Y, car.tz);
    car.rx = 0; car.rz = (this.ctx.rngFx ? this.ctx.rngFx.range(-0.3, 0.3) : 0.2);
  }

  _carStep(dt, roadSpeed) {
    const car = this._car;
    if (!car || car.state === 0) return;
    if (car.state === 1) {
      car.rx += car.spin * dt;
    } else {
      car.mesh.position.z += roadSpeed * dt;
      if (car.mesh.position.z > WORLD.despawnZ) this._hideCar();
    }
  }

  _hideCar() {
    const car = this._car;
    if (!car) return;
    car.state = 0; car.unit = null;
    car.mesh.visible = false;
  }

  // -------------------------------------------------------------------------------------------
  // render — CPU rig animation, plates, chains, core pulse + light, collapse, globs, car (allocation-free)
  // -------------------------------------------------------------------------------------------

  render(alpha) {
    if (!this._spawned) return;
    const ctx = this.ctx;
    const time = ctx.time;
    const now = theatreNow(time);                                         // collapse clock (QA ENE-17: stops while paused)
    const dt = time ? time.dt : 0;
    const render = this._render;
    const uT = (render && render.uniforms && render.uniforms.uTime) ? render.uniforms.uTime.value : this._t;

    let anyVisible = false;
    let lightUnit = null, lightFade = 0;
    for (let u = 0; u < this._unitCount; u++) {
      const unit = this._units[u];
      if (unit.state === U_FREE || unit.state === U_GONE) continue;
      const fade = this._renderUnit(unit, alpha, now, dt, uT);
      if (unit.state !== U_GONE) anyVisible = true;
      // the core light follows the living twin nearest the squad, else the freshest corpse
      if (unit.state === U_ALIVE) {
        if (!lightUnit || lightUnit.state !== U_ALIVE || unit === this._mirrorUnit) { lightUnit = unit; lightFade = 1; }
      } else if (!lightUnit || (lightUnit.state !== U_ALIVE && fade > lightFade)) { lightUnit = unit; lightFade = fade; }
    }
    this._renderLight(lightUnit, lightFade, uT);
    this._renderGlobs(alpha);
    this._renderCar();

    if (this._dead && !anyVisible) {
      // every rig has finished collapsing: hide and release (level finishes on its own real-time deadline)
      for (let u = 0; u < this._unitCount; u++) this._releaseUnit(this._units[u]);
      this._unitCount = 0;
      this._spawned = false;
      if (this._light) this._light.intensity = 0;
    }
  }

  /** Animates one rig; returns the remaining "presence" (1 alive … 0 fully collapsed). */
  _renderUnit(unit, alpha, now, dt, uT) {
    const rig = unit.rig;
    if (!rig) return 0;
    const g = rig.group, parts = rig.parts, rest = rig.rest;
    let zr = unit.z;
    if (unit.state === U_ALIVE) zr += unit.vz * alpha * WORLD.step;
    g.position.x = unit.x; g.position.z = zr; g.rotation.y = unit.yaw;

    // death collapse — theatre clock (ARCH §2.2: spans slow-mo, not pauses), falls toward the squad then sinks
    let collapse = 0;
    if (unit.state === U_DYING) {
      const total = BOSSES.death.collapse * 1000;
      const p = (now - unit.deathAt) / total;
      const fallP = clamp(p / FALL_FRACTION, 0, 1);
      g.rotation.x = ease.outCubic(fallP) * FALL_ANGLE;
      const sinkSpan = (1 - FALL_FRACTION) + SINK_EXTRA_S / BOSSES.death.collapse;
      const sinkP = clamp((p - FALL_FRACTION) / sinkSpan, 0, 1);
      g.position.y = -SINK_M * ease.inOutCubic(sinkP);
      if (sinkP >= 1) { unit.state = U_GONE; g.visible = false; return 0; }
      collapse = clamp(p, 0, 1);
    }

    // pose easing (targets written by step; the chew snaps the jaw)
    const cur = unit.cur, pose = unit.pose;
    const k = 1 - Math.exp(-ANIM.poseRate * dt);
    const chewJaw = clamp(1 - (this._t - unit.chewT) / ANIM.chewJawSeconds, 0, 1);
    for (let c = 0; c < POSE_COUNT; c++) {
      const target = (c === POSE_JAW) ? Math.max(pose[c], chewJaw) : pose[c];
      cur[c] += (target - cur[c]) * k;
    }
    const presence = 1 - collapse;
    const gait = unit.gait * presence;
    const swing = Math.sin(unit.walkPhase) * gait;
    const bob = Math.abs(Math.sin(unit.walkPhase)) * ANIM.bobAmp * gait;
    const crouch = cur[POSE_CROUCH] * ANIM.crouch;

    let p;
    if ((p = parts[P_LEGL])) p.rotation.x = rest[P_LEGL * 6 + 3] + swing * ANIM.legAmp;
    if ((p = parts[P_LEGR])) p.rotation.x = rest[P_LEGR * 6 + 3] - swing * ANIM.legAmp - cur[POSE_STOMP] * ANIM.stompLift;
    const raise = cur[POSE_ARMS] * ANIM.armRaise;
    if ((p = parts[P_ARML])) {
      p.rotation.x = rest[P_ARML * 6 + 3] - swing * ANIM.armAmp - raise;
      if (!rig.nested) p.position.y = rest[P_ARML * 6 + 1] + bob - crouch;
    }
    if ((p = parts[P_ARMR])) {
      p.rotation.x = rest[P_ARMR * 6 + 3] + swing * ANIM.armAmp - raise;
      if (!rig.nested) p.position.y = rest[P_ARMR * 6 + 1] + bob - crouch;
    }
    if ((p = parts[P_TORSO])) {
      p.position.y = rest[P_TORSO * 6 + 1] + bob - crouch;
      p.rotation.x = rest[P_TORSO * 6 + 3] + cur[POSE_LEAN] * ANIM.lean;
      p.rotation.z = rest[P_TORSO * 6 + 5] + Math.sin(uT * 0.7) * ANIM.idleSway * presence;
    }
    if ((p = parts[P_HEAD])) {
      p.rotation.x = rest[P_HEAD * 6 + 3] - cur[POSE_JAW] * ANIM.headBack;
      if (!rig.nested) p.position.y = rest[P_HEAD * 6 + 1] + bob - crouch;
    }
    if ((p = parts[P_JAW])) {
      p.rotation.x = rest[P_JAW * 6 + 3] + cur[POSE_JAW] * ANIM.jawOpen;
      if (!rig.nested && (!parts[P_HEAD] || p.parent !== parts[P_HEAD])) p.position.y = rest[P_JAW * 6 + 1] + bob - crouch;
    }
    const rage = unit.phaseIdx >= 2 ? 1 : 0;
    const pulseHz = ANIM.corePulseHz * (1 + rage);
    const pulse = 0.5 + 0.5 * Math.sin(uT * Math.PI * 2 * pulseHz);
    if ((p = parts[P_CORE])) {
      p.scale.setScalar(rig.coreScale * (1 + ANIM.coreScale * (pulse * 2 - 1)) * (0.4 + 0.6 * presence));
      if (!rig.nested) p.position.y = rest[P_CORE * 6 + 1] + bob - crouch;
    }
    for (let i = 0; i < rig.chains.length; i++) {
      const c = rig.chains[i];
      const ph = uT * ANIM.chainHz * Math.PI * 2 + i * 1.7;
      c.rotation.z = rig.chainRest[i * 3 + 2] + Math.sin(ph) * ANIM.chainAmp * (0.6 + gait);
      c.rotation.x = rig.chainRest[i * 3] + Math.cos(ph * 0.8) * ANIM.chainAmp * 0.5;
    }
    const sh = this._shield;
    if ((p = parts[P_SHIELD]) && p.visible) {
      const sp = Math.sin(uT * Math.PI * 2 * ANIM.shieldPulseHz);
      p.scale.setScalar(1 + 0.04 * sp);
      if (rig.shieldMat) {
        const gaugeT = sh.needed > 0 ? clamp(sh.hits / sh.needed, 0, 1) : 0;
        rig.shieldMat.opacity = ANIM.shieldOpacity + ANIM.shieldOpacityPulse * sp + 0.25 * gaugeT * Math.max(0, 1 - (this._t - unit.hitT) / ZOMBIES.common.hitFlash);
      }
    }

    // detached plates fly in world space (gameplay time, so slow-mo slows them)
    for (let i = 0; i < rig.plates.length; i++) {
      if (!rig.plateDetached[i]) continue;
      const plate = rig.plates[i];
      if (!plate.visible) continue;
      const f = rig.plateFly, o = i * 7;
      f[o] += dt;
      if (f[o] >= PLATE_FLY_S) { plate.visible = false; plate.scale.setScalar(0); continue; }   // r5b: a Bone hides by scale 0
      f[o + 2] -= PLATE_GRAVITY * dt;
      plate.position.x += f[o + 1] * dt; plate.position.y += f[o + 2] * dt; plate.position.z += f[o + 3] * dt;
      plate.rotation.x += f[o + 4] * dt; plate.rotation.z += f[o + 5] * dt;
      if (plate.position.y < 0.05) { plate.position.y = 0.05; f[o + 2] = 0; f[o + 1] *= 0.6; f[o + 3] *= 0.6; f[o + 4] *= 0.3; f[o + 5] *= 0.3; }
    }

    // body emissive: a warm hit blink (flashTint × flashEmissive over ZOMBIES.common.hitFlash, retriggered at most every
    // hitFlashRetrigger s) added on top of a faint phase-3 rage tint — skin / plate colours stay readable all fight
    const flash = clamp(1 - (this._t - unit.hitT) / ZOMBIES.common.hitFlash, 0, 1) * ANIM.flashEmissive;
    const rageI = rage * ANIM.rageEmissive * (0.7 + 0.3 * pulse);
    const er = _rageColor.r * rageI + _flashTint.r * flash, eg = _rageColor.g * rageI + _flashTint.g * flash, eb = _rageColor.b * rageI + _flashTint.b * flash;
    for (let i = 0; i < rig.bodyMats.length; i++) {
      const m = rig.bodyMats[i];
      m.emissive.setRGB(er, eg, eb);
      m.emissiveIntensity = presence;
    }
    // phase-3 rage glow lives on the eyes / glow pieces and the core (pulsing toward PALETTE.boss.rage)
    const rageMix = rage * (0.75 + 0.25 * pulse);
    const gb = rig.glowBase;
    // body glow pieces (the Spitter Queen's sacs, GDD §7 'pulsing sacs') breathe at BOSSES.anim.sacPulseHz; eyes stay steady
    const sacK = ANIM.sacPulseMin + (ANIM.sacPulseMax - ANIM.sacPulseMin) * (0.5 + 0.5 * Math.sin(uT * Math.PI * 2 * ANIM.sacPulseHz + unit.idx * 1.3));
    for (let i = 0; i < rig.glowMats.length; i++) {
      const o = i * 3;
      const gk = Math.max(gb[o], gb[o + 1], gb[o + 2]) * (1 + 0.5 * pulse);
      const k = rig.glowSac && rig.glowSac[i] ? sacK * SAC_GAIN : 1;   // sacs: own gain (QA ENE-14); eyes stay at 1.5
      rig.glowMats[i].color.setRGB(lerp(gb[o], _rageColor.r * gk, rageMix) * k, lerp(gb[o + 1], _rageColor.g * gk, rageMix) * k, lerp(gb[o + 2], _rageColor.b * gk, rageMix) * k);
    }
    if (rig.coreMat && rig.coreBase) {
      const cb = rig.coreBase;
      const ck = PALETTE.boss.coreEmissive * (0.8 + 0.4 * pulse);
      rig.coreMat.color.setRGB(lerp(cb.r, _rageColor.r * ck, rageMix), lerp(cb.g, _rageColor.g * ck, rageMix), lerp(cb.b, _rageColor.b * ck, rageMix));
    }
    // r5b merged glow: the same three formulas (eyes steady, sacs breathing, core pulse), as uGlowCol[0..2] of one draw
    const gc = rig.glowCols;
    if (gc !== null) {
      const cb = rig.glowColBase;
      for (let gi = 0; gi < 2; gi++) {
        const o = gi * 3;
        const gk = Math.max(cb[o], cb[o + 1], cb[o + 2]) * (1 + 0.5 * pulse);
        const k = gi === 1 ? sacK * SAC_GAIN : 1;                      // group 1 = sacs: own gain + pulse (QA ENE-14); eyes stay at 1.5
        gc[gi].set(lerp(cb[o], _rageColor.r * gk, rageMix) * k, lerp(cb[o + 1], _rageColor.g * gk, rageMix) * k, lerp(cb[o + 2], _rageColor.b * gk, rageMix) * k);
      }
      const ck = PALETTE.boss.coreEmissive * (0.8 + 0.4 * pulse);
      gc[2].set(lerp(cb[6], _rageColor.r * ck, rageMix), lerp(cb[7], _rageColor.g * ck, rageMix), lerp(cb[8], _rageColor.b * ck, rageMix));
    }
    if (this._render && this._render.blobShadowSlot) {
      this._render.blobShadowSlot(RENDER.blobShadow.slots.boss + unit.idx, unit.x, zr, BLOB_SCALE * presence);
    }
    return presence;
  }

  _renderLight(unit, fade, uT) {
    const light = this._light;
    if (!light) return;
    if (!unit || !unit.rig) { light.intensity = 0; return; }
    const core = unit.rig.parts[P_CORE];
    if (core) core.getWorldPosition(_v); else _v.set(unit.x, BOSSES.coreY, unit.z);
    // QA ENE-18: offset BOSSES.anim.lightOffsetZ along the rig's facing (+Z rotated by its yaw). The core sits on the torso's
    // front surface, so a light at (or in front of) it paints the forward-facing chest / belly; just inside the torso
    // (negative offset) those faces are back-facing to it (the light casts no shadow) and it lights the road, the squad
    // and the minions around the boss instead
    _v.x += Math.sin(unit.yaw) * LIGHT_OFFSET_Z;
    _v.z += Math.cos(unit.yaw) * LIGHT_OFFSET_Z;
    light.position.copy(_v);
    const rage = unit.phaseIdx >= 2 ? 1 : 0;
    const pulse = 0.5 + 0.5 * Math.sin(uT * Math.PI * 2 * ANIM.corePulseHz * (1 + rage));
    light.intensity = ANIM.lightIntensity * (0.8 + 0.2 * pulse) * (this._shield.up ? 1.3 : 1) * fade;
  }

  _renderGlobs(alpha) {
    const mesh = this._globMesh, g = this._glob;
    if (!mesh) return;
    const n = g.count;
    const dtA = (this.ctx.time ? this.ctx.time.step : WORLD.step) * alpha;
    _s.setScalar(GLOB_SCALE);
    for (let i = 0; i < n; i++) {
      const s = clamp((this._t + dtA - g.t0[i]) / g.T[i], 0, 1);
      const x = lerp(g.x0[i], g.tx[i], s), z = lerp(g.z0[i], g.tz[i], s);
      const y = lerp(g.y0[i], 0.2, s) + GLOB_ARC * 4 * s * (1 - s);
      const a = g.spin[i] * (this._t - g.t0[i]);
      _v2.set(0.3, 1, 0.2).normalize();
      _q.setFromAxisAngle(_v2, a);
      _v.set(x, y, z);
      _m.compose(_v, _q, _s);
      mesh.setMatrixAt(i, _m);
    }
    mesh.count = n;
    mesh.visible = n > 0;   // no zero-instance draw while no glob flies
    if (n > 0) {
      const attr = mesh.instanceMatrix;
      const r = attr._grRange;                                          // permanent range record (init)
      r.start = 0; r.count = n * 16;
      attr.needsUpdate = true;
    }
  }

  _renderCar() {
    const car = this._car;
    if (!car || car.state === 0) return;
    const m = car.mesh;
    if (car.state === 1) {
      const s = clamp((this._t - car.t0) / car.T, 0, 1);
      m.position.x = lerp(car.x0, car.tx, s);
      m.position.z = lerp(car.z0, car.tz, s);
      m.position.y = lerp(car.y0, CAR_REST_Y, s) + CAR_ARC * 4 * s * (1 - s);
      m.rotation.x = car.rx; m.rotation.z = car.rx * 0.3;
    } else {
      m.rotation.x = 0; m.rotation.z = car.rz;
    }
  }
}
