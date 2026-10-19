// js/troops.js — GATE RUSH: `Troops` (ARCHITECTURE §6.6, §7; GDD §8.3).
//
// The five specials that join the squad for the rest of the level: hero sniper, medic, flamethrower
// trooper, drone turret and APC. One of each; `add()` returns false for a duplicate so the caller
// (pickups.grantItem) pays the duplicate coins. Every tuning number comes from data.js (TROOPS, FIRE,
// SQUAD, ZOMBIES, BOSSES, RENDER); the feel/animation numbers are TROOPS.anim (read as ANIM below).
//
// Cross-module access (read via ctx, write via ctx.events + the public methods of §6):
//   ctx.squad     x / centerZ / depth / count / slotWorld / addSoldiers
//   ctx.zombies   highestHp / nearest / nearestOfType / damage / damageInCone / damageInCircle /
//                 setBurning / typeOf / alive / forEachAlive (the only id-yielding iterator: used for
//                 the flamer burn tag and the APC crawler crush, both of which need per-zombie ids)
//   ctx.boss      aimPoint / damage          ctx.weapons  spawnBullet / squadDps / damageMult
//   ctx.level     level / expectedSquad / waveHz          ctx.profile.damage
//   ctx.world     roadSpeed / bossActive     ctx.fx.emit  ('flame', 'smoke', 'spark', 'muzzle')
//   ctx.render    scene / blobShadowSlot     ctx.models.buildTroopMesh
//
// Events emitted (module-level reused payload objects, listeners must not retain them):
//   troop:add { id }   troop:remove { id, reason }   troop:fire { id, x, y, z, tx, ty, tz } (sniper + drone shots; y = muzzle world y, ty = hit height)
//   weapon:fire { id, x, z }   explosion { x, z, radius, kind:'apc' }
//
// Hot paths (step / render) allocate nothing: per-troop state lives in objects created once in init(),
// THREE scratch vectors are module-level, the zombie scan callback is a module-level function reading
// a module-level state object.
import { Vector3, MathUtils } from 'three';
import { clamp, lerpExp, scratch } from './util.js';
import { TROOPS, FIRE, SQUAD, ZOMBIES, BOSSES, RENDER, PALETTE, WORLD } from './data.js';

// ---------------------------------------------------------------------------------------------
// Troop indices and ids
// ---------------------------------------------------------------------------------------------

const SNIPER = 0, MEDIC = 1, FLAMER = 2, DRONE = 3, APC = 4;
const COUNT = 5;
/** Short data keys (TROOPS[key]) in index order. */
const KEYS = ['sniper', 'medic', 'flamer', 'drone', 'apc'];
/** Full item ids (TROOPS[key].id) in index order. */
const IDS = [TROOPS.sniper.id, TROOPS.medic.id, TROOPS.flamer.id, TROOPS.drone.id, TROOPS.apc.id];

// ---------------------------------------------------------------------------------------------
// Module aliases of data keys (round-2 cross-group: the former DATA-MISSING literals now read data.js)
// ---------------------------------------------------------------------------------------------

const SNIPER_HIT_Y = TROOPS.sniper.hitY;           // ARCH §6.6/§7 `zombies.damage(out.id, dmg, out.x, 1.0, out.z, 'bullet')`
const SNIPER_SHIELD_WEIGHT = TROOPS.sniper.shieldWeight;     // GDD §7 shield gauge "sniper 1"; ARCH §6.6 `boss.damage(…, 1, …)`
                                    // (the drone's shield weight 0 is applied by weapons for bullet kind 'drone', never here)
// round-3 verify: a sniper boss shot is at most this fraction of the boss's max HP (GDD §8.3); 0 / missing = uncapped
const SNIPER_BOSS_CAP = TROOPS.sniper.bossCapFrac > 0 ? TROOPS.sniper.bossCapFrac : 0;
const CRUSH_DAMAGE = TROOPS.apc.crushDamage;          // ARCH §6.6/§7 `damageInCircle(..., 9999, 'crush')`
const APC_DESTROYED_REASON = TROOPS.apc.removeReason;   // troop:remove.reason when the pool hits 0

/** Feel / animation literals: TROOPS.anim (data.js; round-2 cross-group — the local mirror and its DATA-MISSING tag are gone). */
const ANIM = TROOPS.anim;

const TWO_PI = Math.PI * 2;
/** Flame cone half angle in radians (TROOPS.flamer.coneDeg / 2) and its cosine for the scan. */
const FLAME_HALF_RAD = TROOPS.flamer.coneDeg * 0.5 * MathUtils.DEG2RAD;
const FLAME_COS_HALF = Math.cos(FLAME_HALF_RAD);
/** Local spin axis of a CylinderGeometry wheel (its own Y). */
const Y_AXIS = new Vector3(0, 1, 0);

// ---------------------------------------------------------------------------------------------
// Reused event payloads (§5: emitters reuse module-level objects; listeners copy what they need)
// ---------------------------------------------------------------------------------------------

const P_ADD = { id: '' };
const P_REMOVE = { id: '', reason: '' };
// troop:fire — ty (round-2 FX-13 follow-up) is the hit height the shot lands at (fx ends the sniper's red beam there).
// Numeric fields are seeded with -0 so V8 gives them a Double representation from the start (fx.js F64 pattern, FX-14).
const P_FIRE = { id: '', x: -0, y: -0, z: -0, tx: -0, ty: -0, tz: -0 };
const P_WEAPON_FIRE = { id: '', x: -0, z: -0 };
const P_EXPLOSION = { x: -0, z: -0, radius: -0, kind: 'apc' };

// Reused query `out` objects for the zombies / boss queries (§7: one scratch per target type).
const Q_HIGHEST = { id: -1, x: -0, y: -0, z: -0, hp: -0 };
const Q_NEAREST = { id: -1, x: -0, y: -0, z: -0 };
const Q_RUNNER = { id: -1, x: -0, y: -0, z: -0 };
const Q_FLAME = { id: -1, x: -0, y: -0, z: -0 };

// Reused fx.emit option objects (fx copies the fields on receipt).
const O_FLAME = { vx: -0, vy: -0, vz: -0, spread: -0, size: -0, life: -0, gravity: -0 };
const O_SMOKE = { vx: -0, vy: -0, vz: -0, spread: -0, size: -0, life: -0, gravity: -0 };
const O_SPARK = { vx: -0, vy: -0, vz: -0, spread: -0, size: -0, life: -0, gravity: -0 };

// THREE scratch (module-level, never retained).
const V_A = new Vector3();
const V_B = new Vector3();
const V_AIM = new Vector3();

// ---------------------------------------------------------------------------------------------
// Zombie scan (flamer burn tag + APC crawler crush) — one allocation-free pass over the alive set
// ---------------------------------------------------------------------------------------------

/** Module-level state read by `scanZombie` (set by Troops._scan before forEachAlive). */
const SCAN = {
  zombies: null,
  // flamer cone (world): origin, unit aim direction (dx, dz), cos of the half angle, range²
  flame: false, fx: 0, fz: 0, dx: 0, dz: -1, cosHalf: 1, range2: 0, near2: 0, burnSeconds: 0,
  dmg: 0, hz: 1,    // cone damage this step (dps·dt, 0 = none) and the wave hz for the HP floor (CHR-12)
  near: 0,          // zombies inside the cone within range + ANIM.flamerActiveMargin (visual "firing" state)
  // APC crush circle (world)
  crush: false, cx: 0, cz: 0, crushR2: 0, crushY: 0,
  crushed: 0,
};

/**
 * forEachAlive callback: tags every zombie inside the flame cone as burning and crushes every crawler
 * inside the APC crush circle. Module-level so step() never creates a closure.
 */
function scanZombie(id, type, x, z, hp) {
  if (SCAN.flame) {
    const dx = x - SCAN.fx;
    const dz = z - SCAN.fz;
    const d2 = dx * dx + dz * dz;
    // inside when the angle to the aim axis ≤ half angle
    if (d2 <= SCAN.near2 && d2 > 0 && (dx * SCAN.dx + dz * SCAN.dz) >= SCAN.cosHalf * Math.sqrt(d2)) {
      SCAN.near++;
      if (d2 <= SCAN.range2) {
        SCAN.zombies.setBurning(id, SCAN.burnSeconds);
        if (SCAN.dmg > 0) {
          // CHR-12: cone damage down to the HP floor only — the flame softens, bullets finish (cause 'burn')
          const def = ZOMBIES[type];
          let a = hp - (def ? def.baseHp * SCAN.hz * ANIM.flamerHpFloor : 0);
          if (a > SCAN.dmg) a = SCAN.dmg;
          if (a > 0) SCAN.zombies.damage(id, a, x, def ? def.height * 0.6 : 1, z, 'burn');
        }
      }
    }
  }
  if (SCAN.crush && type === 'crawler') {
    const dx = x - SCAN.cx;
    const dz = z - SCAN.cz;
    if (dx * dx + dz * dz <= SCAN.crushR2) {
      if (SCAN.zombies.damage(id, CRUSH_DAMAGE, x, SCAN.crushY, z, 'crush')) SCAN.crushed++;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------------------------

/** Wraps an angle difference into [−π, π]. */
function wrapAngle(a) {
  a = a % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a < -Math.PI) a += TWO_PI;
  return a;
}

/** Yaw (rotation about +Y) that turns a −Z-facing object toward direction (dx, dz). */
function yawToward(dx, dz) {
  return Math.atan2(-dx, -dz);
}

/** Lower-cased name test helper for buildTroopMesh children (init only). */
function nameHas(obj, re) {
  return typeof obj.name === 'string' && re.test(obj.name);
}

const RE_ROTOR = /rotor|blade|prop/i;
const RE_WHEEL = /wheel|tyre|tire/i;
const RE_CROSS = /cross/i;
const RE_LED = /led|lamp|headlight|light|lens/i;
const RE_MUZZLE = /muzzle|nozzle|barrel/i;
const RE_TANK = /tank/i;
const RE_DISC = /disc/i;

// ---------------------------------------------------------------------------------------------
// Troops
// ---------------------------------------------------------------------------------------------

export class Troops {
  /** @param {object} ctx the shared context (ARCH §3) */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Array<object>} per-troop state, created once in init() */
    this._t = null;
    /** Present-id list returned by `list` (rebuilt on add/remove, never per frame). */
    this._list = [];
    this._present = 0;          // number of troops present
    this._apcPool = 0;          // remaining bite pool of the APC (0 when absent)
    this._apcPoolMax = 1;       // pool at add time (for the smoke / damage fraction)
    this._medicHealed = 0;      // soldiers added by the medic this level (cap TROOPS.medic.capPerLevel)
    this._flameAcc = 0;         // flame particle accumulator (30/s)
    this._smokeAcc = 0;         // APC smoke accumulator
    this._droneAcc = 0;         // drone shot accumulator (TROOPS.drone.rate shots/s)
    this._flamerActive = false; // a zombie is inside the flame reach this step
    this._flameDmg = 0;         // cone damage for this step's scan (dps·dt; CHR-12) and the wave hz for its HP floor
    this._flameHz = 1;
    this._ownedMaterials = [];  // cloned glow materials (disposed in dispose())
    this._initialised = false;
    // sibling systems, cached on the first step() (they are attached to ctx after troops, §4.1)
    this._refsBound = false;
    this._squad = null; this._zombies = null; this._weapons = null; this._boss = null; this._level = null; this._fx = null;
    this._hasForEach = false; this._hasSlotWorld = false; this._hasAimPoint = false;
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Builds the five meshes (hidden), adds them to the scene. Returns this. */
  init() {
    if (this._initialised) return this;
    const ctx = this.ctx;
    const scene = ctx.render && ctx.render.scene ? ctx.render.scene : null;
    this._t = new Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const mesh = this._buildMesh(i);
      const st = {
        index: i,
        id: IDS[i],
        key: KEYS[i],
        mesh,
        present: false,
        // world position / orientation (simulation state, written in step)
        x: 0, y: 0, z: 0, yaw: 0,
        tx: 0, ty: 0, tz: 0, tyaw: 0,
        vx: 0, vz: 0,              // lateral / forward velocity estimate (for lean and tilt)
        recoil: 0,                 // kick (m) decaying at ANIM.recoilDecay
        flash: 0,                  // glow flash intensity decaying at ANIM.recoilDecay
        timer: 0,                  // cadence accumulator (sniper / medic)
        aimHold: 0,                // s left facing the last sniper target
        phase: (i * 1.37) % TWO_PI, // cosmetic phase offset so bobs are not synchronous
        rotorAngle: 0,
        wheelAngle: 0,
        // named children found once in _findParts (null / empty when the model has none)
        rotor: null,
        cross: null,
        muzzle: null,
        tank: null,
        discs: null,               // drone rotor-disc mesh (opacity flicker)
        discBase: 0,
        volley: 0,                 // flamer volley timer (s)
        wheels: [],
        wheelQ: [],                // each wheel's rest quaternion (spin is applied in local space on top of it)
        glows: [],                 // meshes with an emissive material this module animates (own clones)
        glowBase: [],              // their base emissiveIntensity
      };
      this._findParts(st);
      if (mesh) {
        const sc = TROOPS[KEYS[i]].scale;                 // CHR-6: troops read inside the blob (GDD §8.3)
        if (sc > 0 && sc !== 1) mesh.scale.setScalar(sc);
        mesh.visible = false;
        mesh.matrixAutoUpdate = true;
        if (scene) scene.add(mesh);
      }
      this._t[i] = st;
    }
    this._initialised = true;
    return this;
  }

  /**
   * Builds one troop mesh through models.buildTroopMesh. The contract names the argument `id`; the
   * §6.4 listing shows the short keys, so the short key is tried first and the full data id second.
   * Throws a descriptive error when neither form yields an Object3D (a silent invisible troop would be
   * far harder to diagnose at integration than a boot error).
   */
  _buildMesh(i) {
    const models = this.ctx.models;
    if (!models || typeof models.buildTroopMesh !== 'function') {
      throw new Error('troops: ctx.models.buildTroopMesh is required (boot order §4.1 step 6)');
    }
    let mesh = null;
    let err = null;
    try { mesh = models.buildTroopMesh(KEYS[i]); } catch (e) { err = e; }
    if (!mesh) {
      try { mesh = models.buildTroopMesh(IDS[i]); } catch (e) { err = e; }
    }
    if (!mesh || !mesh.isObject3D) {
      throw new Error('troops: models.buildTroopMesh failed for ' + IDS[i] + (err ? ': ' + (err.message || err) : ''));
    }
    mesh.name = 'troop.' + KEYS[i];
    // shadow casters (ARCH §9.1 "troops.* ≤ 5 Mesh/Group, castShadow"); the drone casts too (its blob
    // shadow on Low comes from render.blobShadowSlot).
    mesh.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = !(o.material && o.material.transparent);   // rings / rotor discs cast nothing
        o.receiveShadow = false;
        o.frustumCulled = true;
      }
    });
    return mesh;
  }

  /**
   * Finds the animated children by name (init only) and clones every emissive material this module
   * will animate so a cached MaterialLibrary material shared with other meshes is never mutated.
   */
  _findParts(st) {
    const mesh = st.mesh;
    if (!mesh) return;
    const i = st.index;
    mesh.traverse((o) => {
      if (!o.isMesh) return;
      if (i === DRONE && !st.rotor && nameHas(o, RE_ROTOR)) st.rotor = o;
      if (i === APC && nameHas(o, RE_WHEEL) && !o.userData.merged) { st.wheels.push(o); st.wheelQ.push(o.quaternion.clone()); }
      if (i === DRONE && !st.discs && nameHas(o, RE_DISC) && o.material && !Array.isArray(o.material)) { st.discs = o; st.discBase = o.material.opacity; }
      if (i === MEDIC && !st.cross && nameHas(o, RE_CROSS)) st.cross = o;
      if (i === FLAMER && !st.tank && nameHas(o, RE_TANK)) st.tank = o;
      if (!st.muzzle && nameHas(o, RE_MUZZLE)) st.muzzle = o;
      // glow parts: the medic cross, the drone LED(s), the APC headlights, the sniper lens
      const isGlow = (i === MEDIC && nameHas(o, RE_CROSS)) ||
                     ((i === DRONE || i === APC || i === SNIPER) && nameHas(o, RE_LED));
      if (isGlow && o.material && o.material.emissive !== undefined && !Array.isArray(o.material)) {
        const own = o.material.clone();
        o.material = own;
        this._ownedMaterials.push(own);
        st.glows.push(o);
        st.glowBase.push(typeof own.emissiveIntensity === 'number' ? own.emissiveIntensity : 1);
      }
    });
    // Rotor fallback: a group child that holds the blades (drone models often parent 2–4 blades).
    if (i === DRONE && !st.rotor) {
      mesh.traverse((o) => { if (!st.rotor && o !== mesh && nameHas(o, RE_ROTOR)) st.rotor = o; });
    }
  }

  /** Level-start state: no troops, timers zeroed, meshes hidden. Idempotent, allocation-free. */
  reset() {
    if (!this._initialised) return;
    for (let i = 0; i < COUNT; i++) {
      const st = this._t[i];
      st.present = false;
      st.recoil = 0; st.flash = 0; st.timer = 0; st.aimHold = 0;
      st.vx = 0; st.vz = 0;
      st.rotorAngle = 0; st.wheelAngle = 0; st.volley = 0;
      if (st.mesh) st.mesh.visible = false;
      this._restoreGlow(st);
    }
    this._present = 0;
    this._list.length = 0;
    this._apcPool = 0;
    this._apcPoolMax = 1;
    this._medicHealed = 0;
    this._flameAcc = 0;
    this._smokeAcc = 0;
    this._droneAcc = 0;
    this._flamerActive = false;
  }

  /** Removes meshes from the scene and disposes the materials this module cloned. */
  dispose() {
    if (!this._initialised) return;
    const scene = this.ctx.render && this.ctx.render.scene ? this.ctx.render.scene : null;
    for (let i = 0; i < COUNT; i++) {
      const st = this._t[i];
      if (st.mesh && scene) scene.remove(st.mesh);
      st.present = false;
    }
    for (let i = 0; i < this._ownedMaterials.length; i++) {
      try { this._ownedMaterials[i].dispose(); } catch (_) { /* already disposed by a rebuild */ }
    }
    this._ownedMaterials.length = 0;
    this._list.length = 0;
    this._present = 0;
    this._initialised = false;
    this._refsBound = false;
    // geometries belong to ModelLibrary (shared factories) and are not disposed here
  }

  // ---- public API (§6.6) ---------------------------------------------------------------------

  /**
   * Adds a troop. Returns false when it is already present (the caller pays PICKUPS.duplicateCoins) or
   * the id is unknown.
   * @param {'troop.sniper'|'troop.medic'|'troop.flamer'|'troop.drone'|'troop.apc'} id
   */
  add(id) {
    if (!this._initialised) return false;
    const i = indexOfId(id);
    if (i < 0) return false;
    const st = this._t[i];
    if (st.present) return false;
    st.present = true;
    st.recoil = 0; st.flash = 0; st.timer = 0; st.aimHold = 0;
    st.vx = 0; st.vz = 0;
    this._present++;
    this._list.push(id);
    if (i === APC) {
      // hit pool 20 + 2·L bites (GDD §8.3; TROOPS.apc.poolBase / poolPerLevel)
      const L = this._levelNumber();
      this._apcPoolMax = TROOPS.apc.poolBase + TROOPS.apc.poolPerLevel * L;
      this._apcPool = this._apcPoolMax;
      this._smokeAcc = 0;
    } else if (i === DRONE) {
      this._droneAcc = 0;
    } else if (i === FLAMER) {
      this._flameAcc = 0;
      this._flamerActive = false;
    }
    // snap to the slot immediately (no slide-in from the origin)
    this._computeTarget(st);
    st.x = st.tx; st.y = st.ty; st.z = st.tz; st.yaw = st.tyaw;
    if (st.mesh) {
      st.mesh.visible = true;
      st.mesh.position.set(st.x, st.y, st.z);
      st.mesh.rotation.set(0, st.yaw, 0);
    }
    P_ADD.id = id;
    this.ctx.events.emit('troop:add', P_ADD);
    return true;
  }

  /** True when the troop is present. */
  has(id) {
    const i = indexOfId(id);
    return i >= 0 && this._initialised && this._t[i].present;
  }

  /** Removes a troop (hides its mesh) and emits troop:remove { id, reason }. */
  remove(id, reason) {
    if (!this._initialised) return;
    const i = indexOfId(id);
    if (i < 0) return;
    const st = this._t[i];
    if (!st.present) return;
    st.present = false;
    this._present--;
    removeFromList(this._list, id);
    if (st.mesh) st.mesh.visible = false;
    this._restoreGlow(st);
    if (i === APC) this._apcPool = 0;
    P_REMOVE.id = id;
    P_REMOVE.reason = typeof reason === 'string' ? reason : '';
    this.ctx.events.emit('troop:remove', P_REMOVE);
  }

  /** Ids of the present troops (a live array owned by this module — do not mutate). */
  get list() { return this._list; }

  /** Remaining APC bite pool (0 when no APC). */
  get apcPool() { return this._present > 0 && this._t[APC].present ? this._apcPool : 0; }

  /**
   * True when the APC box (TROOPS.apc.width × length, `ahead` m in front of the squad) overlaps the
   * circle (x, z, r). Circle-vs-AABB in XZ (closest point).
   */
  apcIntersects(x, z, r) {
    if (!this._initialised) return false;
    const st = this._t[APC];
    if (!st.present) return false;
    const hw = TROOPS.apc.width * 0.5;
    const hl = TROOPS.apc.length * 0.5;
    const cx = clamp(x, st.x - hw, st.x + hw);
    const cz = clamp(z, st.z - hl, st.z + hl);
    const dx = x - cx;
    const dz = z - cz;
    return dx * dx + dz * dz <= r * r;
  }

  /**
   * Consumes `kills` from the APC pool; returns how many were absorbed (0 when no APC). At pool 0 the
   * APC explodes: zombies.damageInCircle(x, z, explodeRadius, squadDps·explodeDpsSeconds, 'explosion'),
   * `explosion { kind:'apc' }`, then troop:remove.
   */
  apcAbsorb(kills) {
    if (!this._initialised) return 0;
    const st = this._t[APC];
    if (!st.present || this._apcPool <= 0) return 0;
    const n = kills > this._apcPool ? this._apcPool : (kills > 0 ? kills : 0);
    if (n <= 0) return 0;
    this._apcPool -= n;
    st.recoil = ANIM.apcFlinch;          // push-back flinch (render)
    st.flash = ANIM.apcLightMax;         // headlight flare
    this._emitSparks(st.x, TROOPS.apc.length * 0.25, st.z - TROOPS.apc.length * 0.5, ANIM.apcSparksAtHit, -1);
    if (this._apcPool <= 0) this._explodeApc(st);
    return n;
  }

  // ---- internals: helpers used by the public API --------------------------------------------

  _explodeApc(st) {
    const ctx = this.ctx;
    const x = st.x;
    const z = st.z;
    const dps = ctx.weapons && typeof ctx.weapons.squadDps === 'function' ? ctx.weapons.squadDps() : 0;
    const amount = dps * TROOPS.apc.explodeDpsSeconds;   // "2 s of squad DPS" (GDD §8.3)
    if (ctx.zombies && amount > 0) {
      ctx.zombies.damageInCircle(x, z, TROOPS.apc.explodeRadius, amount, 'explosion');
    }
    P_EXPLOSION.x = x;
    P_EXPLOSION.z = z;
    P_EXPLOSION.radius = TROOPS.apc.explodeRadius;
    P_EXPLOSION.kind = 'apc';
    ctx.events.emit('explosion', P_EXPLOSION);
    this.remove(TROOPS.apc.id, APC_DESTROYED_REASON);
  }

  /** Campaign level number for the APC pool (≥ 1; endless runs use the level runner's value or 1). */
  _levelNumber() {
    const level = this.ctx.level;
    const L = level && typeof level.level === 'number' && level.level > 0 ? level.level : 1;
    return Math.floor(L);
  }

  _restoreGlow(st) {
    for (let g = 0; g < st.glows.length; g++) {
      const m = st.glows[g].material;
      if (m && typeof m.emissiveIntensity === 'number') m.emissiveIntensity = st.glowBase[g];
    }
  }

  // ---- simulation (ARCH §4.2 step B, after squad.step, before weapons.step) --------------------

  /**
   * Fixed step: slot targets + motion for every present troop, then the five behaviours, then one
   * zombie scan (flamer burn tag + APC crawler crush). Allocation-free.
   */
  step(dt) {
    if (!this._initialised || this._present === 0 || !(dt > 0)) return;
    this._bindRefs();
    const t = this._t;
    for (let i = 0; i < COUNT; i++) {
      const st = t[i];
      if (!st.present) continue;
      this._computeTarget(st);
      this._moveToward(st, dt);
      if (st.recoil !== 0) { st.recoil = lerpExp(st.recoil, 0, ANIM.recoilDecay, dt); if (Math.abs(st.recoil) < 1e-3) st.recoil = 0; }
      if (st.flash !== 0) { st.flash = lerpExp(st.flash, 0, ANIM.recoilDecay, dt); if (st.flash < 1e-3) st.flash = 0; }
    }
    if (t[SNIPER].present) this._stepSniper(t[SNIPER], dt);
    if (t[MEDIC].present) this._stepMedic(t[MEDIC], dt);
    if (t[FLAMER].present) this._stepFlamer(t[FLAMER], dt);
    if (t[DRONE].present) this._stepDrone(t[DRONE], dt);
    if (t[APC].present) this._stepApc(t[APC], dt);
    this._scan();
  }

  /**
   * Caches the sibling systems once (they are attached to ctx after troops in boot order §4.1 step 9,
   * so init() cannot read them; ctx fields are never re-created after boot, §3).
   */
  _bindRefs() {
    if (this._refsBound) return;
    const ctx = this.ctx;
    this._squad = ctx.squad || null;
    this._zombies = ctx.zombies || null;
    this._weapons = ctx.weapons || null;
    this._boss = ctx.boss || null;
    this._level = ctx.level || null;
    this._fx = ctx.fx || null;
    this._hasForEach = !!(this._zombies && typeof this._zombies.forEachAlive === 'function');
    this._hasSlotWorld = !!(this._squad && typeof this._squad.slotWorld === 'function');
    this._hasAimPoint = !!(this._boss && typeof this._boss.aimPoint === 'function');
    this._refsBound = !!(this._squad && this._zombies && this._weapons && this._level);
  }

  /** hz of the most recent wave (level.waveHz, §6.16); 1 before the first wave or without a level runner. */
  _waveHz() {
    const lv = this._level;
    if (lv === null) return 1;
    const hz = lv.waveHz();
    return hz > 0 ? hz : 1;
  }

  /** ctx.profile.damage (d), defensively 1 when the profile is missing. */
  _profileDamage() {
    const p = this.ctx.profile;
    return p && p.damage > 0 ? p.damage : FIRE.dmgBase;
  }

  /** Writes st.tx/ty/tz/tyaw from the squad's current formation (GDD §8.3 positions). */
  _computeTarget(st) {
    const squad = this._squad || this.ctx.squad;
    if (!squad) { st.tx = 0; st.ty = 0; st.tz = 0; st.tyaw = 0; return; }
    const sx = squad.x;
    switch (st.index) {
      case SNIPER:   // left flank of the blob at mid-depth, on its crate (which belongs to the model); round-2 CHR-9: off the centre
                     // line so the sniper never stacks over the soldiers / the count label (was: rear centre)
        st.tx = sx - (squad.halfWidth + ANIM.sniperSideMargin);
        if (st.tx < ANIM.sniperMinX) st.tx = ANIM.sniperMinX;
        st.ty = 0; st.tz = squad.centerZ;   // mid-depth: the rear of a large blob is below the screen edge
        if (st.aimHold <= 0) st.tyaw = 0;
        break;
      case MEDIC: {  // blob centre, half a slot off the centre column
        if (this._hasSlotWorld) {
          squad.slotWorld(0, V_A);
          st.tx = V_A.x + ANIM.medicXOffset; st.tz = V_A.z;
        } else {
          st.tx = sx + ANIM.medicXOffset; st.tz = squad.centerZ;
        }
        st.ty = 0; st.tyaw = 0;
        break;
      }
      case FLAMER:   // front edge, one row ahead of the front row (tyaw aimed by _stepFlamer)
        st.tx = sx; st.ty = 0; st.tz = ANIM.flamerFrontOffset;
        if (st.aimHold <= 0) st.tyaw = 0;
        break;
      case DRONE:    // hovers TROOPS.drone.hover m up, droneSideX m right of / droneAhead m ahead of the blob centre (tyaw set by _stepDrone)
        st.tx = sx + ANIM.droneSideX; st.ty = TROOPS.drone.hover; st.tz = squad.centerZ - ANIM.droneAhead;
        if (st.tx > ANIM.droneMaxX) st.tx = ANIM.droneMaxX;
        break;
      case APC:      // box centre: `ahead` m in front of the squad front + half its length
        st.tx = sx; st.ty = 0; st.tz = -(TROOPS.apc.ahead + TROOPS.apc.length * 0.5); st.tyaw = 0;
        break;
      default: break;
    }
  }

  /** Exponential follow toward the target (snaps on a large jump); tracks velocity for lean/tilt. */
  _moveToward(st, dt) {
    const rate = st.index === DRONE ? ANIM.droneLagRate : ANIM.followRate;
    const dx = st.tx - st.x;
    const dz = st.tz - st.z;
    let nx, nz;
    if (dx * dx + dz * dz > ANIM.snapDist * ANIM.snapDist) {
      nx = st.tx; nz = st.tz; st.y = st.ty;
    } else {
      nx = lerpExp(st.x, st.tx, rate, dt);
      nz = lerpExp(st.z, st.tz, rate, dt);
      st.y = lerpExp(st.y, st.ty, rate, dt);
    }
    st.vx = (nx - st.x) / dt;
    st.vz = (nz - st.z) / dt;
    st.x = nx; st.z = nz;
    st.yaw += wrapAngle(st.tyaw - st.yaw) * (1 - Math.exp(-ANIM.yawRate * dt));
  }

  /** Muzzle / nozzle world position: the model's named muzzle child, else FIRE.muzzleOffset rotated by yaw. */
  _muzzleWorld(st, out) {
    if (st.muzzle !== null && st.mesh.visible) {
      st.muzzle.getWorldPosition(out);
      return out;
    }
    const ox = FIRE.muzzleOffset[0];
    const oz = FIRE.muzzleOffset[2];
    const c = Math.cos(st.yaw);
    const s = Math.sin(st.yaw);
    out.set(st.x + ox * c + oz * s, st.y + FIRE.muzzleOffset[1], st.z - ox * s + oz * c);
    return out;
  }

  // ---- hero sniper (GDD §8.3, ARCH §6.6/§7) ------------------------------------------------------

  _stepSniper(st, dt) {
    st.timer += dt;
    if (st.aimHold > 0) st.aimHold -= dt;
    if (st.timer < TROOPS.sniper.every) return;
    const ctx = this.ctx;
    const zombies = this._zombies;
    const dmg = TROOPS.sniper.dmg * this._waveHz() * this._profileDamage();   // 40·hz·d
    let tx = 0, tz = 0, ty = SNIPER_HIT_Y, fired = false;
    if (zombies !== null && zombies.highestHp(Q_HIGHEST)) {
      tx = Q_HIGHEST.x; tz = Q_HIGHEST.z;
      zombies.damage(Q_HIGHEST.id, dmg, Q_HIGHEST.x, SNIPER_HIT_Y, Q_HIGHEST.z, 'bullet');
      fired = true;
    } else if (ctx.world.bossActive && this._boss !== null) {
      if (this._hasAimPoint) this._boss.aimPoint(V_AIM);
      else V_AIM.set(ctx.world.bossX, BOSSES.coreY, ctx.world.bossZ);
      tx = V_AIM.x; tz = V_AIM.z; ty = BOSSES.coreY;
      // boss ×0.5 (TROOPS.sniper.bossMult), at most TROOPS.sniper.bossCapFrac of the boss's max HP per shot (round-3 verify:
      // 40·hz·d follows the wave hz, which carries endless's design multiple and pressure while the mini-boss HP does not —
      // uncapped, one shot killed an endless Juggernaut 0.5 s after it spawned); shield-gauge weight 1; a crit number
      let bossDmg = dmg * TROOPS.sniper.bossMult;
      const cap = SNIPER_BOSS_CAP * this._boss.maxHp;
      if (cap > 0 && bossDmg > cap) bossDmg = cap;
      this._boss.damage(bossDmg, SNIPER_SHIELD_WEIGHT, V_AIM.x, BOSSES.coreY, V_AIM.z, true);
      fired = true;
    }
    if (!fired) { st.timer = TROOPS.sniper.every; return; }   // stay ready; fire the moment a target appears
    st.timer = 0;
    this._muzzleWorld(st, V_B);
    st.tyaw = yawToward(tx - st.x, tz - st.z);
    st.aimHold = ANIM.sniperAimHold;
    st.recoil = ANIM.sniperKick;
    st.flash = 1;
    if (this._fx !== null) this._fx.emit('muzzle', V_B.x, V_B.y, V_B.z, ANIM.muzzleParticles);
    P_FIRE.id = TROOPS.sniper.id; P_FIRE.x = V_B.x; P_FIRE.y = V_B.y; P_FIRE.z = V_B.z; P_FIRE.tx = tx; P_FIRE.ty = ty; P_FIRE.tz = tz;
    ctx.events.emit('troop:fire', P_FIRE);                   // fx: long red tracer from the muzzle (y) to the hit height (ty) + crit number
    P_WEAPON_FIRE.id = TROOPS.sniper.id; P_WEAPON_FIRE.x = V_B.x; P_WEAPON_FIRE.z = V_B.z;
    ctx.events.emit('weapon:fire', P_WEAPON_FIRE);           // audio: `crack`
  }

  // ---- medic ------------------------------------------------------------------------------------

  _stepMedic(st, dt) {
    st.timer += dt;
    if (st.timer < TROOPS.medic.every) return;
    st.timer -= TROOPS.medic.every;
    if (this._medicHealed >= TROOPS.medic.capPerLevel) return;      // cap +60 per level
    const squad = this._squad;
    const level = this._level;
    if (squad === null || level === null) return;
    const C = squad.count;
    if (C <= 0 || C >= level.expectedSquad()) return;               // only while C < E(z)
    let n = Math.max(TROOPS.medic.min, Math.ceil(TROOPS.medic.pct * C));   // max(1, ceil(0.02·C))
    const left = TROOPS.medic.capPerLevel - this._medicHealed;
    if (n > left) n = left;
    if (n <= 0) return;
    this._medicHealed += n;
    squad.addSoldiers(n, 'medic', st.x, st.z);                       // fx shows the green "+n" from squad:count
    st.flash = ANIM.medicHealFlash;
    this._emitSparks(st.x, SQUAD.label.y * 0.6, st.z, ANIM.medicHealSparks, 1);
  }

  // ---- flamethrower trooper ----------------------------------------------------------------------

  _stepFlamer(st, dt) {
    const zombies = this._zombies;
    if (st.aimHold > 0) st.aimHold -= dt;
    st.volley += dt;
    if (zombies !== null && zombies.alive > 0) {
      const hz = this._waveHz();
      const dps = TROOPS.flamer.dps * hz * this._profileDamage();   // 6·hz·d (TROOPS.flamer.dps)
      // aim: swing the cone toward the nearest zombie ahead (CHR-8); a volley target may override below
      let aimed = false;
      if (zombies.nearest(st.x, st.z, Q_FLAME) && this._flameAimable(st, Q_FLAME, ANIM.flamerAimRange)) {
        st.tyaw = clamp(yawToward(Q_FLAME.x - st.x, Q_FLAME.z - st.z), -ANIM.flamerAimMaxYaw, ANIM.flamerAimMaxYaw);
        st.aimHold = ANIM.flamerAimHold;
        aimed = true;
      }
      // cone along the current facing, half angle coneDeg/2, TROOPS.flamer.range, cause 'burn': the burn tag and the
      // non-lethal cone damage (down to ANIM.flamerHpFloor, CHR-12) are applied by the shared scan, see _scan()
      this._flameDmg = dps * dt; this._flameHz = hz;
      if (!this._hasForEach) zombies.damageInCone(st.x, st.z, -Math.sin(st.yaw), -Math.cos(st.yaw), FLAME_HALF_RAD, TROOPS.flamer.range, dps * dt, 'burn');
      // volley: a narrow jet lobbed at a brute / spitter holding at range (lethal), else at the aimed zombie (floored)
      if (st.volley >= ANIM.flamerVolleyEvery) {
        let have = false, ranged = false;
        if ((zombies.nearestOfType('spitter', st.x, st.z, Q_FLAME) && this._flameAimable(st, Q_FLAME, ANIM.flamerVolleyReach)) ||
            (zombies.nearestOfType('brute', st.x, st.z, Q_FLAME) && this._flameAimable(st, Q_FLAME, ANIM.flamerVolleyReach))) {
          have = true; ranged = true;
        } else if (aimed && zombies.nearest(st.x, st.z, Q_FLAME) && this._flameAimable(st, Q_FLAME, ANIM.flamerAimRange)) {
          have = true;
        }
        if (have) {
          st.volley = 0;
          const dx = Q_FLAME.x - st.x, dz = Q_FLAME.z - st.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          let amount = dps * ANIM.flamerVolleyEvery * ANIM.flamerVolleyShare;
          if (!ranged) {                                                   // CHR-12: floored like the cone
            const def = ZOMBIES[zombies.typeOf(Q_FLAME.id)];
            const room = zombies.hpOf(Q_FLAME.id) - (def ? def.baseHp * hz * ANIM.flamerHpFloor : 0);
            if (amount > room) amount = room;
          }
          if (amount > 0) zombies.damage(Q_FLAME.id, amount, Q_FLAME.x, 1, Q_FLAME.z, 'burn');
          zombies.setBurning(Q_FLAME.id, TROOPS.flamer.burnSeconds);
          st.tyaw = clamp(yawToward(dx, dz), -ANIM.flamerAimMaxYaw, ANIM.flamerAimMaxYaw);
          st.aimHold = ANIM.flamerAimHold;
          this._flameVolleyFx(st, dx / dist, dz / dist, dist);
        } else {
          st.volley = ANIM.flamerVolleyEvery;                              // stay ready
        }
      }
    } else {
      this._flamerActive = false;
    }
    // jet particles: emitPerSec while something is in reach, a pilot flame otherwise
    const perSec = this._flamerActive ? TROOPS.flamer.emitPerSec : ANIM.flamePilotPerSec;
    this._flameAcc += perSec * dt;
    if (this._flameAcc < 1) return;
    const fx = this._fx;
    if (fx === null) { this._flameAcc = 0; return; }
    const rng = this.ctx.rngFx;
    this._muzzleWorld(st, V_B);
    const active = this._flamerActive;
    const speed = active ? TROOPS.flamer.range / ANIM.flameLife : ANIM.flamePilotReach / ANIM.flameLife;
    const dirX = -Math.sin(st.yaw);
    const dirZ = -Math.cos(st.yaw);
    O_FLAME.life = ANIM.flameLife;
    O_FLAME.size = active ? ANIM.flameSize : ANIM.flameSize * 0.5;
    O_FLAME.spread = speed * ANIM.flameSpread;
    O_FLAME.gravity = 0;
    while (this._flameAcc >= 1) {
      this._flameAcc -= 1;
      const j = rng ? rng.range(-1, 1) : 0;
      O_FLAME.vx = dirX * speed + j * speed * ANIM.flameSpread;
      O_FLAME.vz = dirZ * speed;
      O_FLAME.vy = ANIM.flameRise * (active ? 1 : 0.6);
      fx.emit('flame', V_B.x, V_B.y, V_B.z, 1, O_FLAME);
    }
  }

  /** True when the zombie in `q` is ahead of the trooper, within `reach` and inside the aim arc. */
  _flameAimable(st, q, reach) {
    const dx = q.x - st.x, dz = q.z - st.z;
    if (dz > -0.5) return false;                                           // behind or beside: never turn around
    const d2 = dx * dx + dz * dz;
    if (d2 > reach * reach) return false;
    return Math.abs(Math.atan2(-dx, -dz)) <= ANIM.flamerAimMaxYaw + FLAME_HALF_RAD;
  }

  /** Volley visual: a burst of flame particles that travels to the target (unit direction ux, uz, distance m). */
  _flameVolleyFx(st, ux, uz, dist) {
    const fx = this._fx;
    if (fx === null) return;
    const rng = this.ctx.rngFx;
    this._muzzleWorld(st, V_B);
    const speed = dist / ANIM.flameLife;
    O_FLAME.life = ANIM.flameLife;
    O_FLAME.size = ANIM.flameSize * 1.2;
    O_FLAME.spread = speed * ANIM.flameSpread * 0.5;
    O_FLAME.gravity = 0;
    for (let k = 0; k < ANIM.flamerVolleyParticles; k++) {
      const j = rng ? rng.range(-1, 1) : 0;
      const sp = speed * (0.85 + 0.05 * k);
      O_FLAME.vx = ux * sp - uz * j * speed * ANIM.flameSpread * 0.4;
      O_FLAME.vz = uz * sp + ux * j * speed * ANIM.flameSpread * 0.4;
      O_FLAME.vy = ANIM.flameRise;
      fx.emit('flame', V_B.x, V_B.y, V_B.z, 1, O_FLAME);
    }
  }

  // ---- drone turret ---------------------------------------------------------------------------------

  _stepDrone(st, dt) {
    const ctx = this.ctx;
    const zombies = this._zombies;
    const weapons = this._weapons;
    let have = false, tx = 0, tz = 0;
    if (zombies !== null && zombies.alive > 0) {
      if (zombies.nearestOfType('runner', st.x, st.z, Q_RUNNER)) {        // runners prioritised
        tx = Q_RUNNER.x; tz = Q_RUNNER.z; have = true;
      } else if (zombies.nearest(st.x, st.z, Q_NEAREST)) {
        tx = Q_NEAREST.x; tz = Q_NEAREST.z; have = true;
      }
    }
    if (!have && ctx.world.bossActive && this._boss !== null) {
      if (this._hasAimPoint) this._boss.aimPoint(V_AIM);
      else V_AIM.set(ctx.world.bossX, BOSSES.coreY, ctx.world.bossZ);
      tx = V_AIM.x; tz = V_AIM.z; have = true;
    }
    st.tyaw = have ? yawToward(tx - st.x, tz - st.z) : 0;
    this._droneAcc += TROOPS.drone.rate * dt;                              // 4 shots/s
    if (!have || weapons === null) {
      if (this._droneAcc > 1) this._droneAcc = 1;                          // keep one shot ready
      return;
    }
    while (this._droneAcc >= 1) {
      this._droneAcc -= 1;
      // weight so one shot deals dpsFraction (5 %) of squad DPS: w·d·damageMult = f·DPS
      const denom = this._profileDamage() * weapons.damageMult;
      const dps = weapons.squadDps();
      if (!(denom > 0) || !(dps > 0)) break;
      const w = TROOPS.drone.dpsFraction * dps / denom;
      const dx = tx - st.x;
      const dz = tz - st.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-3) break;
      const my = st.y - ANIM.droneMuzzleDrop;
      if (!weapons.spawnBullet(st.x, my, st.z, dx / len, dz / len, FIRE.bullet.speed, FIRE.bullet.life, w, 'drone')) break;   // pool full: weapons counts the drop
      st.recoil = ANIM.droneRecoil;
      st.flash = 1;
      if (this._fx !== null) this._fx.emit('muzzle', st.x, my, st.z, ANIM.muzzleParticles);
      P_FIRE.id = TROOPS.drone.id; P_FIRE.x = st.x; P_FIRE.y = my; P_FIRE.z = st.z; P_FIRE.tx = tx; P_FIRE.ty = FIRE.bullet.y; P_FIRE.tz = tz;
      ctx.events.emit('troop:fire', P_FIRE);                 // CHR-14: muzzle origin (x, y, z) for fx; the bullet itself is weapons' 'drone' kind
    }
  }

  // ---- APC -----------------------------------------------------------------------------------------

  _stepApc(st, dt) {
    // damage smoke: from apcSmokeFrom of the pool down to 0 the smoke rate rises to apcSmokeMaxPerSec
    const frac = this._apcPoolMax > 0 ? this._apcPool / this._apcPoolMax : 0;
    if (frac >= ANIM.apcSmokeFrom || this._fx === null) return;
    const rate = ANIM.apcSmokeMaxPerSec * (1 - frac / ANIM.apcSmokeFrom);
    this._smokeAcc += rate * dt;
    if (this._smokeAcc < 1) return;
    const rng = this.ctx.rngFx;
    O_SMOKE.vx = 0; O_SMOKE.vy = ANIM.apcSmokeRise; O_SMOKE.vz = this.ctx.world.roadSpeed * 0.15;
    O_SMOKE.spread = 0.6; O_SMOKE.size = ANIM.apcSmokeSize; O_SMOKE.life = ANIM.apcSmokeLife; O_SMOKE.gravity = 0;
    const hw = TROOPS.apc.width * 0.35;
    while (this._smokeAcc >= 1) {
      this._smokeAcc -= 1;
      const jx = rng ? rng.range(-hw, hw) : 0;
      this._fx.emit('smoke', st.x + jx, TROOPS.apc.width * 0.6, st.z + TROOPS.apc.length * 0.2, 1, O_SMOKE);
    }
  }

  // ---- shared zombie scan ----------------------------------------------------------------------------

  /**
   * One forEachAlive pass: tags zombies in the flame cone as burning (TROOPS.flamer.burnSeconds), counts
   * the ones approaching the cone (visual "open up" state) and crushes crawlers inside the APC circle
   * (ARCH §7: damageInCircle(apcX, apcZ − 1.7, 1.4, 9999, 'crush') for crawler ids only).
   */
  _scan() {
    const zombies = this._zombies;
    const f = this._t[FLAMER];
    const a = this._t[APC];
    SCAN.flame = f.present;
    SCAN.crush = a.present;
    if (zombies === null || !this._hasForEach || zombies.alive === 0 || (!SCAN.flame && !SCAN.crush)) {
      if (SCAN.flame) this._flamerActive = false;
      return;
    }
    if (SCAN.flame) {
      SCAN.fx = f.x; SCAN.fz = f.z;
      SCAN.dx = -Math.sin(f.yaw); SCAN.dz = -Math.cos(f.yaw);
      SCAN.cosHalf = FLAME_COS_HALF;
      SCAN.range2 = TROOPS.flamer.range * TROOPS.flamer.range;
      const reach = TROOPS.flamer.range + ANIM.flamerActiveMargin;
      SCAN.near2 = reach * reach;
      SCAN.burnSeconds = TROOPS.flamer.burnSeconds;
      SCAN.near = 0;
      SCAN.dmg = this._flameDmg; SCAN.hz = this._flameHz;
      this._flameDmg = 0;
    }
    if (SCAN.crush) {
      SCAN.cx = a.x; SCAN.cz = a.z + TROOPS.apc.crushOffsetZ;
      SCAN.crushR2 = TROOPS.apc.crushRadius * TROOPS.apc.crushRadius;
      SCAN.crushY = ZOMBIES.crawler.height * 0.5;
      SCAN.crushed = 0;
    }
    SCAN.zombies = zombies;
    zombies.forEachAlive(scanZombie);
    SCAN.zombies = null;
    if (SCAN.flame) this._flamerActive = SCAN.near > 0;
    if (SCAN.crush && SCAN.crushed > 0) {
      a.recoil = ANIM.apcFlinch * 0.4;   // a crunch under the wheels
      this._emitSparks(a.x, 0.3, a.z + TROOPS.apc.crushOffsetZ, ANIM.apcSparksAtHit, -1);
    }
  }

  // ---- rendering (ARCH §4.2 step D: transform writes only) ------------------------------------------

  /**
   * Writes the five meshes' transforms and the procedural animation (drone bob / rotor / tilt, APC wheel
   * roll / suspension / headlights, medic cross glow, sniper and flamer lean, recoil kicks), then the
   * Low-tier blob shadows. Cosmetic clocks use ctx.time.elapsed (scaled) and ctx.time.dt. Allocation-free.
   */
  render(alpha) {
    if (!this._initialised) return;
    const ctx = this.ctx;
    const time = ctx.time;
    const now = time ? time.elapsed : 0;
    const fdt = time && time.dt > 0 ? time.dt : 0;
    const roadSpeed = ctx.world ? ctx.world.roadSpeed : 0;
    const render = ctx.render;
    const hasBlob = !!(render && typeof render.blobShadowSlot === 'function');
    const slotBase = RENDER.blobShadow.slots.troops;
    const t = this._t;
    for (let i = 0; i < COUNT; i++) {
      const st = t[i];
      const mesh = st.mesh;
      if (!st.present || !mesh) {
        if (hasBlob) render.blobShadowSlot(slotBase + i, 0, 0, 0);   // hide the slot of an absent troop
        continue;
      }
      // lean / bank into lateral motion (roll about Z; +vx banks the right side down → negative roll)
      const lean = clamp(-st.vx * ANIM.leanPerMs, -0.25, 0.25);
      // recoil kick: backward along the facing (forward is (−sin yaw, −cos yaw))
      const kx = st.recoil * Math.sin(st.yaw);
      const kz = st.recoil * Math.cos(st.yaw);
      let shadowScale = ANIM.shadowScaleGround;
      switch (i) {
        case SNIPER: {
          mesh.position.set(st.x + kx, st.y, st.z + kz);
          mesh.rotation.set(-st.recoil * 0.8, st.yaw, lean);       // muzzle rises with the kick
          this._writeGlowMult(st, 1, st.flash * 2);                    // lens flare on the shot
          break;
        }
        case MEDIC: {
          mesh.position.set(st.x, st.y, st.z);
          mesh.rotation.set(0, st.yaw, lean);
          // cross glow: slow pulse between medicCrossMin and medicCrossMax (× base), plus the heal flash
          const pulse = 0.5 * (1 + Math.sin(TWO_PI * ANIM.medicCrossHz * now + st.phase));
          const mult = ANIM.medicCrossMin + (ANIM.medicCrossMax - ANIM.medicCrossMin) * pulse;
          this._writeGlowMult(st, mult, st.flash);
          break;
        }
        case FLAMER: {
          const sway = this._flamerActive ? Math.sin(TWO_PI * ANIM.flamerSwayHz * now) * ANIM.flamerSwayAmp : 0;
          mesh.position.set(st.x + kx, st.y, st.z + kz);
          mesh.rotation.set(0, st.yaw + sway, lean);
          break;
        }
        case DRONE: {
          const bob = Math.sin(TWO_PI * ANIM.droneBobHz * now + st.phase) * ANIM.droneBobAmp;
          mesh.position.set(st.x, st.y + bob - st.recoil, st.z);
          // nose down when moving forward (−Z), bank into lateral velocity
          const pitch = clamp(st.vz * ANIM.droneTiltPerMs, -ANIM.droneTiltMax, ANIM.droneTiltMax);
          const roll = clamp(-st.vx * ANIM.droneTiltPerMs, -ANIM.droneTiltMax, ANIM.droneTiltMax);
          mesh.rotation.set(pitch, st.yaw, roll);
          st.rotorAngle += TWO_PI * ANIM.droneRotorRps * fdt;
          if (st.rotorAngle > TWO_PI) st.rotorAngle -= TWO_PI;
          if (st.rotor !== null) st.rotor.rotation.y = st.rotorAngle;
          if (st.discs !== null) st.discs.material.opacity = st.discBase * (1 + ANIM.droneDiscFlicker * Math.sin(st.rotorAngle * 3));
          // LED: hard blink at droneLedHz, bright flash on each shot
          const on = Math.sin(TWO_PI * ANIM.droneLedHz * now) > 0 ? 1 : 0.25;
          this._writeGlowMult(st, on, st.flash * 1.5);
          shadowScale = ANIM.shadowScaleDrone;
          break;
        }
        case APC: {
          const bob = Math.sin(TWO_PI * ANIM.apcBobHz * now + st.phase) * ANIM.apcBobAmp;
          mesh.position.set(st.x, st.y + bob, st.z + st.recoil);
          const roll = clamp(-st.vx * ANIM.apcRollPerMs, -0.12, 0.12);
          mesh.rotation.set(-st.recoil * 0.3, st.yaw, roll);          // nose lifts on a flinch
          // wheels roll at the road speed (the world scrolls +Z under a stationary APC → forward spin)
          if (st.wheels.length > 0) {
            st.wheelAngle -= (roadSpeed / ANIM.apcWheelRadius) * fdt;
            if (st.wheelAngle < -TWO_PI) st.wheelAngle += TWO_PI;
            scratch.q.setFromAxisAngle(Y_AXIS, st.wheelAngle);
            for (let w = 0; w < st.wheels.length; w++) {
              st.wheels[w].quaternion.copy(st.wheelQ[w]).multiply(scratch.q);
            }
          }
          // headlights: gentle flicker between apcLightMin and apcLightMax, flare on an absorbed bite
          const flick = 0.5 * (1 + Math.sin(TWO_PI * 7.3 * now) * 0.5 + Math.sin(TWO_PI * 11.1 * now + 1.3) * 0.5);
          const mult = ANIM.apcLightMin + (ANIM.apcLightMax - ANIM.apcLightMin) * flick;
          this._writeGlowMult(st, mult, st.flash);
          shadowScale = ANIM.shadowScaleApc;
          break;
        }
        default: break;
      }
      if (hasBlob) render.blobShadowSlot(slotBase + i, st.x, st.z, shadowScale);
    }
  }

  /** emissiveIntensity = base · mult + add for every glow part of the troop. */
  _writeGlowMult(st, mult, add) {
    for (let g = 0; g < st.glows.length; g++) {
      const m = st.glows[g].material;
      if (m) m.emissiveIntensity = st.glowBase[g] * mult + add;
    }
  }

  /** A few 'spark' particles (fx default tint) at (x, y, z); dir +1 = up, −1 = forward (−Z). */
  _emitSparks(x, y, z, count, dir) {
    const fx = this._fx || this.ctx.fx;
    if (!fx) return;
    O_SPARK.vx = 0;
    O_SPARK.vy = dir > 0 ? 2.5 : 1.2;
    O_SPARK.vz = dir > 0 ? 0 : -2.0;
    O_SPARK.spread = 1.8; O_SPARK.size = 0.12; O_SPARK.life = 0.4; O_SPARK.gravity = -9;
    fx.emit('spark', x, y, z, count, O_SPARK);
  }
}

/** Index of a full troop id ('troop.sniper' …) or −1. Also accepts the short key. */
function indexOfId(id) {
  for (let i = 0; i < COUNT; i++) {
    if (IDS[i] === id || KEYS[i] === id) return i;
  }
  return -1;
}

/** Removes one occurrence of `id` from `arr` in place (allocation-free). */
function removeFromList(arr, id) {
  const n = arr.length;
  for (let i = 0; i < n; i++) {
    if (arr[i] === id) {
      for (let j = i; j < n - 1; j++) arr[j] = arr[j + 1];
      arr.length = n - 1;
      return;
    }
  }
}
