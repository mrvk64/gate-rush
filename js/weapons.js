// js/weapons.js — GATE RUSH: the squad's guns. Bullet SoA pool, shooters + phase timers, bullet weight
// folding, spread, boss re-aim, swept hit tests, tracers, muzzle flashes, the five timed weapon power-ups
// (shotgun / minigun / rocket / railgun / laser) and the gear timers (armor / magnet / chip / booster).
//
// Contract: docs/ARCHITECTURE.md §6.11 (class shape, ownership), §7 (hit-test table and priority),
// §5.1 (event payloads: shot, weapon:start/end, weapon:fire, gear:start/end, explosion, coin:pickup
// 'refund'/'duplicate'), §9.1/§9.2 (meshes, instancing), §14 (coding rules); docs/GDD.md §3.3 (fire
// model), §8.1 (weapons), §8.2 (gear), §12 J1/J13/J21 (juice). Numbers come from data.js (FIRE, WEAPONS,
// GEAR, PICKUPS, PALETTE, BOSSES, JUICE, QUALITY_TIERS, WORLD); the few visual constants data.js has no
// key for are declared below with a DATA-MISSING comment naming the intended path.
//
// Fire model (GDD §3.3): shooters S = min(C, FIRE.shooters); every shooter k has its own phase timer
// (random start from ctx.rngFx) advanced by f·fireRateMult·weaponRateMult per second; the squad's target
// rate targetRate = S·perShooter·pellets is capped at FIRE.spawnRateCap and the excess is folded into the
// bullet weight w = max(1, C/FIRE.weightDiv)·targetRate/spawnRate. A bullet deals w·d·damageMult·kindMult
// to a zombie / boss and adds w·gateHits to a gate (no damageMult on gates, GDD §8.2).
//
// Boss re-aim (GDD §3.3, WPN-7): while the boss is within FIRE.bossAimRange every shooter aims at its core —
// except in a step where zombies.nearest() finds a living zombie ≤ FIRE.bossAimYieldM ahead of the front row and
// inside the squad's width + 1 m: then bullets (and rockets / laser beams) fly straight and the contact threat soaks
// them. Boss-aimed tracers climb from FIRE.bullet.y to the BOSSES.hitYRange chest band (WPN-9, cosmetic: _bvy).
//
// Hit tests (ARCH §7): every bullet integrates px = x; x += dx·speed·dt; … then sweeps (px, pz) → (x, z)
// against zombies → boss → gate panels → closed crates; the smallest t wins, ties go to the zombie (then
// boss, gate, crate in that order). The sweep start is extended by roadSpeed·dt toward +Z so the test is
// done in the road frame (everything on the road scrolls +Z each step): a 0.4 m gate panel can never
// tunnel through a 0.58 m bullet step. Drone bullets ('drone') never test gates or crates and hit the
// boss with shield weight 0. zombies.damage() already applies the flamer burn bonus for cause 'bullet'
// (zombies report), so weapons never multiplies it a second time.
//
// Reads:  ctx.profile (fireRate, damage), ctx.squad (count, visible, x, centerZ, armor, shooterPosition,
//         setFireVisual, setArmor), ctx.zombies (hitTestSeg | hitTestSegment, nearest, damage, damageInCircle,
//         damageInLine), ctx.boss (hitTestSeg | hitTestSegment, damage, aimPoint), ctx.gates (hitTestSeg |
//         hitTestSegment, applyHit, activeEvent), ctx.pickups (hitTestSeg | hitTestSegment, hit, setMagnet),
//         ctx.world (roadSpeed, bossActive, squadHalfWidth), ctx.quality (params.tracers), ctx.rngFx, ctx.fx (emit,
//         addTrauma, fovKick, flash), ctx.render (scene, camera, materials, textures.muzzle, lights.laser),
//         ctx.models.geo (tracer, muzzle, rocket), ctx.state, ctx.debug.
// Writes: nothing on ctx except ctx.debug.dropped counters and ctx.debug.shotsPerSec / beamsPerSec (overlay, WPN-7);
//         emits the events listed above.
import {
  InstancedMesh, InstancedBufferAttribute, Mesh, BoxGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry,
  MeshBasicMaterial, MeshStandardMaterial, AdditiveBlending, DynamicDrawUsage, Color,
} from 'three';
import { clamp, warnOnce } from './util.js';
import { WORLD, FIRE, WEAPONS, GEAR, PICKUPS, PALETTE, BOSSES, JUICE, QUALITY_TIERS, GATE_RULES, TROOPS } from './data.js';

// ---------------------------------------------------------------------------------------------
// Capacities (allocated once in init() at the High-tier capacity, ARCH §14 rule 3)
// ---------------------------------------------------------------------------------------------
const STEP = WORLD.step;                               // fixed step (render extrapolation)
const POOL = FIRE.bullet.pool;                         // 256 bullets (shared with the drone)
const SHOOTERS = FIRE.shooters;                        // 40 per-shooter phase timers
const TRACER_CAP = QUALITY_TIERS.high.tracers;         // 256 tracer instances allocated; params.tracers drawn
const MUZZLE_POOL = FIRE.muzzleFlash.pool;             // 64 flash quads
const MUZZLE_LIFE = FIRE.muzzleFlash.ms / 1000;        // 33 ms = GDD J1 "2 frames"
const MUZZLE_FRAMES = FIRE.muzzleFlash.frames;         // 2 frames side by side in textures.muzzle
const ROCKET_POOL = WEAPONS.rocket.pool;               // 8 rockets
const LASER_MAX = WEAPONS.laser.maxBeams;              // ≤ 8 beams
const GATE_RULES_DEPTH = GATE_RULES.panel.depth;       // panel hit footprint depth (piercing-line walk)
const DEG = Math.PI / 180;
// Query radii as module constants: a double read from a (frozen) data object and passed to a non-inlined call is
// boxed into a fresh HeapNumber per call; a module const is passed as the same tagged value every time (WPN-8).
const BULLET_R = FIRE.bullet.radius;                   // 0.12 m swept bullet radius
const RAIL_HW = WEAPONS.railgun.halfWidth;             // 0.4 m
const LASER_HW = WEAPONS.laser.halfWidth;              // 0.25 m
const BOSS_AIM_RANGE = FIRE.bossAimRange;              // 40 m
const BOSS_AIM_YIELD_M = FIRE.bossAimYieldM > 0 ? FIRE.bossAimYieldM : 6;   // WPN-7: contact threats within 6 m take the fire
const BOSS_AIM_YIELD_PAD = 1;         // structural (WPN-7 spec): lateral band = world.squadHalfWidth + 1 m (a brute's 0.9 m radius + bullet)
const BOSS_AIM_YIELD_BEHIND = 0.5;    // structural: a zombie whose centre is > 0.5 m behind the front row cannot be hit by forward fire
const BOSS_AIM_YIELD_QZ = -BOSS_AIM_YIELD_M * 0.5;   // nearest() query point: the middle of the 6 m window ahead of the front row
const BOSS_AIM_YIELD_COL = FIRE.bossAimYieldCol > 0 ? FIRE.bossAimYieldCol : 0.9;  // only shooters within ±0.9 m (x) of the threat yield
// WPN-9: boss-aimed tracers climb from FIRE.bullet.y to the middle of the ENE-13 impact band (BOSSES.hitYRange × coreY,
// 0.45–0.95 → 0.7·coreY) at the capsule surface, never above coreY. Cosmetic only — hit tests stay XZ.
const BOSS_HIT_Y_RANGE = BOSSES.hitYRange;
const BOSS_TRACER_Y = Math.min(BOSSES.coreY,
  BOSSES.coreY * (BOSS_HIT_Y_RANGE && BOSS_HIT_Y_RANGE.length === 2 ? (BOSS_HIT_Y_RANGE[0] + BOSS_HIT_Y_RANGE[1]) * 0.5 : 0.7));
const BOSS_TRACER_Y_MAX = BOSSES.coreY;
const NO_SHOT_WARN_S = 1;             // structural (WPN-7 hardening): ?debug=1 warns once after 1 s without a shot while C > 0

// ---------------------------------------------------------------------------------------------
// Visual / feel constants data.js does not carry (DATA-MISSING → integrator, see the report)
// ---------------------------------------------------------------------------------------------
const MUZZLE_GAIN = FIRE.muzzleFlash.gain;               // HDR gain of the additive flash quad (blooms like J1's 2–4 values) (data key; wired round-2 cross-group)
const MUZZLE_SCALE_JITTER = FIRE.muzzleFlash.sizeJitter;      // ± fraction of size per flash (rngFx) (data key; wired round-2 cross-group)
const FLASH_SCALE_SHOTGUN = WEAPONS.shotgun.flashScale;       // GDD §8.1 "wide flash" (data key; wired round-2 cross-group)
const FLASH_SCALE_MINIGUN = WEAPONS.minigun.flashScale;       // thin rapid flashes (data key; wired round-2 cross-group)
const FLASH_SCALE_HEAVY = WEAPONS.rocket.flashScale;         // = WEAPONS.railgun.flashScale — launch / bolt flare (data key; wired round-2 cross-group)
const MINIGUN_SPIN_FROM = WEAPONS.minigun.spinFrom;           // rate multiplier at t = 0 of the 0.4 s spin-up (ramps to rateMult) (data key; wired round-2 cross-group)
const BOOSTER_TRACER_SCALE = GEAR.booster.tracerScale;      // GDD §8.2 "thicker tracers" (data key; wired round-2 cross-group)
const DRONE_DROP_M = TROOPS.drone.tracerDropM;                // drone tracers descend to bullet height over this distance (hit tests are XZ-only) (data key; wired round-2 cross-group)
const ROCKET_LAUNCH_Y = WEAPONS.rocket.launchY;           // rockets leave the blob centre above the helmets (data key; wired round-2 cross-group)
const ROCKET_RADIUS = WEAPONS.rocket.radius;             // swept-test radius of a rocket (data key; wired round-2 cross-group)
const ROCKET_GATE_REACH_X = WEAPONS.rocket.gateReach.x;       // ARCH §6.11/§7 "panel within 1.8 m (x)" (data key; wired round-2 cross-group)
const ROCKET_GATE_REACH_Z = WEAPONS.rocket.gateReach.z;       // ARCH §6.11/§7 "… and 1.0 m (z)" (data key; wired round-2 cross-group)
const ROCKET_SMOKE_EVERY = WEAPONS.rocket.smokeEvery;       // s between smoke-trail puffs (data key; wired round-2 cross-group)
const ROCKET_SMOKE_SIZE = WEAPONS.rocket.smoke.size;     // 0.8 m puffs (WPN-3: visible on the asphalt)
const ROCKET_SMOKE_LIFE = WEAPONS.rocket.smoke.life;     // 1.2 s
const ROCKET_SMOKE_SPREAD = WEAPONS.rocket.smoke.spread; // m/s
const ROCKET_SMOKE_RISE = WEAPONS.rocket.smoke.rise;     // m/s
// WEAPONS.rocket.smoke.colorIdx = FX_COLOR.dust (light tan) in fxmaterials.js FX_COLORS (WPN-10: a data key, not a hand
// mirror; ARCH §1 does not let gameplay modules import fxmaterials.js). #5A5A5A smoke vanished on #3B3B44 asphalt.
const ROCKET_SMOKE_COLOR_IDX = WEAPONS.rocket.smoke.colorIdx;
const ROCKET_MESH_SCALE = WEAPONS.rocket.meshScale;      // × models rocket (WPN-3: ≈15 px → ≈24 px)
const ROCKET_TAIL = WEAPONS.rocket.tailM * ROCKET_MESH_SCALE;   // exhaust origin behind the (scaled) rocket centre
const ROCKET_FLAME_LEN = WEAPONS.rocket.flame.len;       // 1.2 m exhaust cone
const ROCKET_FLAME_R = WEAPONS.rocket.flame.radius;      // m
const ROCKET_FLAME_RGB = WEAPONS.rocket.flame.hdr;       // linear HDR ≈ (3.0, 1.6, 0.5)
const ROCKET_SPIN = WEAPONS.rocket.spin;               // roll rate (rad/s) (data key; wired round-2 cross-group)
const RAIL_SHOW = WEAPONS.railgun.boltSeconds;                // bolt visual lifetime (s) (data key; wired round-2 cross-group)
const RAIL_SEGMENTS = WEAPONS.railgun.segments;              // lightning polyline segments (data key; wired round-2 cross-group)
const RAIL_JITTER = WEAPONS.railgun.jitterM;               // lightning lateral jitter (m) (data key; wired round-2 cross-group)
const RAIL_REJITTER = WEAPONS.railgun.rejitterS;           // crackle re-roll interval (s) (data key; wired round-2 cross-group)
const RAIL_CORE_R = WEAPONS.railgun.coreRadius;              // (m) (data key; wired round-2 cross-group)
const RAIL_ARC_THICK = WEAPONS.railgun.arcThickness;           // (m) (data key; wired round-2 cross-group)
const RAIL_ARC_GAIN = WEAPONS.railgun.arcGain;             // × WEAPONS.railgun.tracer for the lightning (data key; wired round-2 cross-group)
const RAIL_FLASH_ALPHA = WEAPONS.railgun.flashAlpha;         // J21 80 ms screen flash opacity (data key; wired round-2 cross-group)
const LASER_CORE_R = WEAPONS.laser.coreRadius;            // (m) (data key; wired round-2 cross-group)
const LASER_GLOW_R = WEAPONS.laser.glowRadius;           // 0.12 m additive halo (WPN-1: 0.17 m × 0.55 washed the frame)
const LASER_GLOW_GAIN_BLOOM = WEAPONS.laser.glowGain.bloom;   // 0.1 × WEAPONS.laser.tracer while bloom haloes the core
const LASER_GLOW_GAIN_LOW = WEAPONS.laser.glowGain.low;       // 0.25 on Low (the halo substitutes for bloom, GDD §16)
const LASER_FLICKER = WEAPONS.laser.flicker;            // ± radius flicker fraction (rngFx) (data key; wired round-2 cross-group)
const LASER_SLABS = WEAPONS.laser.aimSlabs;                 // vertical slabs approximating a boss-aimed beam for damageInLine (data key; wired round-2 cross-group)
const LASER_SPARK_EVERY = WEAPONS.laser.sparkEvery;        // s between impact sparks at the boss (data key; wired round-2 cross-group)
const LASER_LIGHT_INTENSITY = WEAPONS.laser.light.intensity;   // 2.5: render.lights.laser while a laser is active
const LASER_LIGHT_DISTANCE = WEAPONS.laser.light.distance;     // 10 m
const LASER_LIGHT_Y = WEAPONS.laser.light.y;                   // m
const LASER_LIGHT_Z = WEAPONS.laser.light.z;                   // m, ahead of the front row
const MINIGUN_TRACER_SCALE = WEAPONS.minigun.tracerScale;      // 0.6: "thin yellow tracers" (GDD §8.1)
const TRACER_GLOW_GAIN = 1.3;         // GDD §16 Low "bloom off → glow quads + emissive +30 %": glow quad colour = tracer HDR × 1.3 × LOW_GLOW_NORM
const LOW_GLOW_NORM = 0.3;            // structural: the tracer HDR triplets (≈ 3–4) are bloom inputs; × 0.3 brings a soft additive quad back to ≈ 1
const TRACER_GLOW_W = 0.22;           // DATA-MISSING: FIRE.tracerGlow.width — Low tracer glow quad width (m, the soft halo bloom would give)
const TRACER_GLOW_LEN = 1.25;         // DATA-MISSING: FIRE.tracerGlow.lengthMult — glow quad length × tracer length
const SPARKS_RAIL = WEAPONS.railgun.sparks;                 // fx.emit('spark') count at the rail muzzle (data key; wired round-2 cross-group)
const SPARKS_LASER = WEAPONS.laser.sparks;                // per laser impact puff at the boss (data key; wired round-2 cross-group)
const REFUND_Y = 1;                   // ARCH §6.11: refund coin:pickup origin y = 1
const GATE_ITER_MAX = 4;              // structural: max gate panels a piercing line can cross in one call
const EPS = 1e-6;

// ---------------------------------------------------------------------------------------------
// Ids / kinds
// ---------------------------------------------------------------------------------------------
const K_RIFLE = 0, K_SHOTGUN = 1, K_MINIGUN = 2, K_DRONE = 3;
const KIND_DMG = new Float32Array([1, WEAPONS.shotgun.dmgMult, WEAPONS.minigun.dmgMult, 1]);    // pellet 0.5·d·w, minigun 0.6·d·w (GDD §8.1)
const KIND_GATE = new Float32Array([1, WEAPONS.shotgun.gateHits, WEAPONS.minigun.gateHits, 0]); // rifle adds w (GDD §3.3); drone never hits gates (and weighs 0 on the boss shield)

const W_NONE = -1, W_SHOTGUN = 0, W_MINIGUN = 1, W_ROCKET = 2, W_RAIL = 3, W_LASER = 4;
const WEAPON_KEYS = ['shotgun', 'minigun', 'rocket', 'railgun', 'laser'];
const WEAPON_IDS = [WEAPONS.shotgun.id, WEAPONS.minigun.id, WEAPONS.rocket.id, WEAPONS.railgun.id, WEAPONS.laser.id];
const SHOT_LABEL = ['rifle', WEAPONS.shotgun.id, WEAPONS.minigun.id];   // shot.weapon: the pattern that fired the coalesced shots

const ID_ARMOR = GEAR.armor.id, ID_MAGNET = GEAR.magnet.id, ID_CHIP = GEAR.chip.id, ID_BOOSTER = GEAR.booster.id;

const H_NONE = 0, H_ZOMBIE = 1, H_BOSS = 2, H_GATE = 3, H_CRATE = 4;

// A double zero for the constructor (WPN-8). V8 gives a field initialised with a small integer the Smi representation;
// the first fractional store (e.g. _wLeft −= dt at the first weapon pickup) then generalises the field to Double,
// deprecates the Weapons map and deoptimises every optimised method that reads `this` (seen: the minigun / rocket
// pickups dropped _renderTracers, _stepBullets and _renderMuzzles back to the interpreter, which boxes every double
// for 1–3 s at 240 bullets). −0 is never a Smi, so fields initialised with D0 are Double from the start; storing a
// small integer into them later keeps them Double.
const D0 = -0;

// ---------------------------------------------------------------------------------------------
// Module-level scratch (never retained; zero per-frame allocation)
// ---------------------------------------------------------------------------------------------
const OUT_Z = { id: -1, x: -0, y: -0, z: -0, t: -0 };            // zombie candidate
const OUT_B = { x: -0, y: -0, z: -0, t: -0 };                    // boss candidate
const OUT_G = { gate: null, x: -0, y: -0, z: -0, t: -0 };        // gate candidate
const OUT_C = { id: -1, x: -0, y: -0, z: -0, t: -0 };            // crate candidate
const OUT_L = { gate: null, x: -0, y: -0, z: -0, t: -0 };        // piercing-line gate walk
const OUT_LB = { x: -0, y: -0, z: -0, t: -0 };                   // piercing-line boss test
const OUT_N = { id: -1, x: D0, y: D0, z: D0 };               // zombies.nearest() for the boss re-aim yield (WPN-7; D0: Double fields)
const V_POS = { x: -0, y: -0, z: -0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };   // Vector3-compatible out for squad.shooterPosition
const V_AIM = { x: -0, y: -0, z: -0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };   // … and boss.aimPoint
const COL = new Color();
const RGB = new Float32Array(3);
// _sweep() input segment [x0, z0, x1, z1]: written by the caller instead of passed as double arguments, which V8
// boxes into fresh HeapNumbers at every non-inlined call (WPN-5). WPN-8: the targets' typed-segment queries
// (zombies / boss.hitTestSeg(SEG, radius, out), gates / pickups.hitTestSeg(SEG, out), ARCH §7) read this array
// directly — nothing is boxed. A target without hitTestSeg falls back to hitTestSegment(x0, z0, x1, z1, …): the
// four values are then boxed ONCE per sweep into SEGT (a tagged array) and the same boxes go to every fallback query.
const SEG = new Float64Array(4);
const SEGL = new Float64Array(4);          // the same for the piercing-line queries (rail, laser, rocket blast, gate walk)
const SEGT = [0.5, 0.5, 0.5, 0.5, null];   // PACKED_ELEMENTS (tagged) on purpose — never let it become a double array
// _spawn() inputs (x, y, z, dirX, dirZ, speed, life, weight, vy) — same reason: the per-bullet insert stays allocation-free.
const SP = new Float64Array(9);
const SP_VY = 8;                           // vertical tracer velocity (m/s; cosmetic: drone descent, boss-aim climb)
const SEGW = new Float64Array(4);          // _gatesAlongLine's walking sub-segment
const GW = new Float64Array(1);            // _gatesAlongLine's weight (written by the caller, not passed as a double)
const ROCKET_SPLASH = WEAPONS.rocket.splash;   // 2.5 m blast radius (module const: passed tagged, WPN-8)
// render() → helpers: [alpha, tNow] (the doubles are not passed as arguments, which would box them per frame, WPN-8)
const RT = new Float64Array(2);
const RT_ALPHA = 0, RT_TNOW = 1;
// _renderTracers per-kind colour (3 per kind) and cross-section scale, refreshed per frame: indexed by kind, so the loop
// has no kind branches whose first execution (first shotgun / minigun / drone bullet) would deoptimise it (WPN-8).
const TR_COL = new Float32Array(4 * 3);
const TR_SCALE = new Float32Array(4);

/** Fallback path of _sweep: box SEG once into the tagged SEGT (one HeapNumber per value) for hitTestSegment. */
function boxSeg() {
  SEGT[0] = SEG[0]; SEGT[1] = SEG[1]; SEGT[2] = SEG[2]; SEGT[3] = SEG[3];
}

// event payloads (reused; listeners must not retain them, ARCH §5)
const P_SHOT = { count: 0, x: -0, z: -0, weapon: 'rifle' };
const P_WSTART = { id: '', duration: -0 };
const P_WEND = { id: '' };
const P_GSTART = { id: '', duration: -0 };
const P_GEND = { id: '' };
const P_FIRE = { id: '', x: -0, z: -0 };
const P_EXPLOSION = { x: -0, z: -0, radius: -0, kind: 'rocket' };
const P_COIN = { amount: -0, x: -0, y: -0, z: -0, source: 'refund' };

// fx.emit option objects (reused)
const O_SMOKE = { vx: -0, vy: -0, vz: -0, spread: ROCKET_SMOKE_SPREAD, size: ROCKET_SMOKE_SIZE, life: ROCKET_SMOKE_LIFE, gravity: -0, colorIdx: ROCKET_SMOKE_COLOR_IDX };
const O_SPARK = { vx: -0, vy: -0, vz: -0, spread: 3, size: 0.12, life: 0.25, gravity: -6 };

// HDR colours (linear triplets from data.js; sRGB hexes converted once)
const C_RIFLE = PALETTE.tracer.rifle, C_SHOTGUN = WEAPONS.shotgun.tracer, C_MINIGUN = WEAPONS.minigun.tracer;
const C_DRONE = PALETTE.tracer.drone, C_CHIP = GEAR.chip.tracerTint;
const C_LASER = WEAPONS.laser.tracer, C_RAIL = WEAPONS.railgun.tracer;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** sRGB hex → linear RGB × gain into RGB[0..2] (Color.setHex converts sRGB → linear under ColorManagement). */
function hexLinear(hex, gain) {
  COL.setHex(hex);
  RGB[0] = COL.r * gain; RGB[1] = COL.g * gain; RGB[2] = COL.b * gain;
  return RGB;
}

/**
 * Inputs of writeDirMatrix (module scratch). Doubles passed as arguments to a non-inlined call are boxed into
 * fresh HeapNumbers by V8 (≈ 1 MB/s with 12 args per tracer, WPN-5); stores into a Float64Array are not, so
 * callers write the 10 inputs here and pass only the array and a small-integer offset.
 */
const MI = new Float64Array(10);
const MI_FX = 0, MI_FY = 1, MI_FZ = 2, MI_ROLL = 3, MI_SX = 4, MI_SY = 5, MI_SZ = 6, MI_PX = 7, MI_PY = 8, MI_PZ = 9;

/**
 * Writes a TRS matrix (column-major, Float32Array at offset o) whose local −Z axis points along the unit
 * vector MI(fx, fy, fz), rolled by MI.roll about it, scaled MI(sx, sy, sz), translated to MI(px, py, pz).
 */
function writeDirMatrix(a, o) {
  const fx = MI[MI_FX], fy = MI[MI_FY], fz = MI[MI_FZ], roll = MI[MI_ROLL];
  const sx = MI[MI_SX], sy = MI[MI_SY], sz = MI[MI_SZ], px = MI[MI_PX], py = MI[MI_PY], pz = MI[MI_PZ];
  const zx = -fx, zy = -fy, zz = -fz;                 // local +Z = −forward
  let xx = zz, xz = -zx;                              // x = normalize(up × z) = (zz, 0, −zx)
  let xl = Math.sqrt(xx * xx + xz * xz);
  if (xl < EPS) { xx = 1; xz = 0; xl = 1; }
  xx /= xl; xz /= xl;
  const xy = 0;
  let yx = zy * xz - zz * xy;                         // y = z × x
  let yy = zz * xx - zx * xz;
  let yz = zx * xy - zy * xx;
  let rx = xx, ry = xy, rz = xz;
  if (roll !== 0) {
    const c = Math.cos(roll), s = Math.sin(roll);
    rx = c * xx + s * yx; ry = c * xy + s * yy; rz = c * xz + s * yz;
    const ux = c * yx - s * xx, uy = c * yy - s * xy, uz = c * yz - s * xz;
    yx = ux; yy = uy; yz = uz;
  }
  a[o] = rx * sx; a[o + 1] = ry * sx; a[o + 2] = rz * sx; a[o + 3] = 0;
  a[o + 4] = yx * sy; a[o + 5] = yy * sy; a[o + 6] = yz * sy; a[o + 7] = 0;
  a[o + 8] = zx * sz; a[o + 9] = zy * sz; a[o + 10] = zz * sz; a[o + 11] = 0;
  a[o + 12] = px; a[o + 13] = py; a[o + 14] = pz; a[o + 15] = 1;
}

/**
 * Installed as each tagged attribute's clearUpdateRanges(): WebGLAttributes calls it after every upload, and
 * emptying the array (three's default, length = 0) makes V8 free and re-allocate its backing store on the next
 * push — every frame (WPN-5, same fix as gates GAT-4). The one range record stays in updateRanges for good.
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

/**
 * needsUpdate + update range [0, count) without allocating. Each tagged attribute is rewritten from index 0
 * and marked at most once per frame, so the latest count always covers what the draw reads.
 */
function markUpdate(attr, count) {
  const r = attr._grRange;
  r.start = 0;
  r.count = count;
  attr.needsUpdate = true;
}

/** Finalises an InstancedMesh for this frame: count, visibility, matrix (+ optional colour) uploads. */
function commitMesh(mesh, count, withColor) {
  mesh.count = count;
  mesh.visible = count > 0;
  if (count <= 0) return;
  markUpdate(mesh.instanceMatrix, count * 16);
  if (withColor && mesh.instanceColor) markUpdate(mesh.instanceColor, count * 3);
}

/** Builds a pooled InstancedMesh (DynamicDrawUsage, frustumCulled false, count 0, hidden). */
function makeInstanced(geometry, material, capacity, withColor, name) {
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  tagRange(mesh.instanceMatrix);
  if (withColor) {
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    tagRange(mesh.instanceColor);
  }
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.count = 0;
  mesh.visible = false;
  mesh.name = name;
  return mesh;
}

/**
 * Cosmetic flicker in [0, 1) for render() (exhaust / beam shimmer): a module-local Park–Miller LCG, so
 * frame-rate dependent visual noise never consumes ctx.rngFx and never allocates.
 */
// The seed lives in a Float64Array, not a module `let`: the state exceeds the Smi range, and a double stored into a
// (tagged) context slot allocates a fresh HeapNumber on every call even in optimised code (WPN-8).
const FLICK = new Float64Array([2463534]);
function flick() {
  const s = (FLICK[0] * 16807) % 2147483647;
  FLICK[0] = s;
  return (s - 1) / 2147483646;
}

/** Unit beam geometry: open cylinder of radius 1, length 1, from local z = 0 to z = −1 (scale z by the length). */
function beamGeometry(radialSegments) {
  const g = new CylinderGeometry(1, 1, 1, radialSegments, 1, true);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, -0.5);
  return g;
}

// =============================================================================================
// Weapons
// =============================================================================================
export class Weapons {
  constructor(ctx) {
    this.ctx = ctx;
    this._inited = false;

    // bullet SoA (ARCH §6.11): x, y, z, px, pz, dx, dz, speed, life, weight + kind; vy (drone descent), age (tracer length)
    this._n = 0;
    this._bx = null; this._by = null; this._bz = null; this._bpx = null; this._bpz = null;
    this._bdx = null; this._bdz = null; this._bvy = null; this._bspd = null; this._blife = null;
    this._bw = null; this._bage = null; this._bkind = null;

    this._phase = null;            // per-shooter phase timers (fraction of a shot interval left)

    // fire configuration of the current step (written by _fireConfig)
    // (double-valued fields start at D0 so their representation never changes mid-run; see D0)
    this._cfgS = 0; this._cfgPer = D0; this._cfgPellets = 1; this._cfgKind = K_RIFLE;
    this._cfgSpread = D0; this._cfgLife = D0; this._cfgWeight = D0; this._cfgScale = D0;
    this._aimOn = false;           // boss re-aim active this step (V_AIM holds the target)
    this._hx = D0; this._hz = D0;  // winning hit point of the last _sweep()
    this._gateReachZ = -Infinity;  // per-step broadphase: no shootable panel has z − depth/2 above this (see _updateBroadphase)
    this._zombiesAlive = true;     // per-step broadphase: false when zombies.alive === 0
    this._aimBad = false;          // boss.aimPoint() gave a non-finite point this step (hardening, WPN-7)
    this._aimYield = false;        // a contact threat holds part of the line this step (WPN-7): shooters in its column fire straight
    this._yieldX = D0;             // x of that threat (valid while _aimYield)
    this._cfgWarned = false;       // the invalid-fire-config warning was built once (warnOnce keeps it to one line)
    this._stallWarned = false;
    // typed-segment queries available on each target this step (WPN-8, see _detectQueries)
    this._zSeg = false; this._bSeg = false; this._gSeg = false; this._pSeg = false;
    // diagnostics (WPN-7): 1 s windows -> ctx.debug.shotsPerSec; seconds without a shot while C > 0 (?debug=1 warning)
    this._winT = D0; this._winShots = 0; this._noShotT = D0;

    // weapon power-up
    this._w = W_NONE;
    this._wLeft = D0;
    this._paused = false;
    this._spin = D0;               // minigun spin-up time (s)
    this._rocketTimer = D0;
    this._railTimer = D0;
    this._shakeEst = D0;           // estimate of the minigun's share of fx trauma (holds the 0.03 m shake)
    this._shotCount = 0;
    this._t = D0;                  // scaled simulation clock (s), drives visual lifetimes

    // gear
    this._gear = {};               // id → seconds left (Infinity for armor / magnet); a key exists only while active
    this._armorOn = false;
    this._magnetOn = false;
    this._chipLeft = D0;
    this._boosterLeft = D0;

    // rockets SoA
    this._rn = 0;
    this._rx = null; this._ry = null; this._rz = null; this._rpx = null; this._rpz = null;
    this._rdx = null; this._rdz = null; this._rdist = null; this._rsmoke = null; this._rroll = null;

    // muzzle flashes (ring)
    this._mx = null; this._my = null; this._mz = null; this._mBirth = null; this._mScale = null; this._mRoll = null;
    this._mHead = 0;

    // rail bolt visual
    this._railT = Infinity;        // time since the last bolt (≥ RAIL_SHOW: hidden)
    this._railOn = false;          // a bolt is (or was last frame) visible — a boolean test, so the per-frame early-out
                                   // of the cold rail paths never loads the double _railT (boxed in baseline code, WPN-8)
    this._railX = D0; this._railY = D0; this._railZ0 = D0; this._railZ1 = D0;
    this._railJitT = D0;
    this._railPts = null;          // (RAIL_SEGMENTS + 1) × (x, y) lateral offsets of the lightning polyline

    // laser beams (per step: origin, direction, length)
    this._beams = 0;
    this._lox = null; this._loy = null; this._loz = null;
    this._ldx = null; this._ldy = null; this._ldz = null; this._llen = null;
    this._laserSparkT = D0;
    this._laserLightOn = false;

    // HDR colours of the additive meshes (filled in init)
    this._muzzleRGB = null; this._flameRGB = null; this._laserGlowRGB = null; this._railArcRGB = null;

    // GPU objects
    this.tracers = null; this.tracerGlow = null; this.muzzles = null; this.rockets = null; this.flames = null;
    this.beams = null; this.beamGlow = null; this.railCore = null; this.railArcs = null;
    this._muzzleFrame = null;
    this._tracerLen = FIRE.tracerLength;
    this._ownedGeometries = [];
    this._ownedMaterials = [];
    this._meshes = [];
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------
  init() {
    if (this._inited) return this;

    // --- bullet pool -------------------------------------------------------------------------
    this._bx = new Float32Array(POOL); this._by = new Float32Array(POOL); this._bz = new Float32Array(POOL);
    this._bpx = new Float32Array(POOL); this._bpz = new Float32Array(POOL);
    this._bdx = new Float32Array(POOL); this._bdz = new Float32Array(POOL); this._bvy = new Float32Array(POOL);
    this._bspd = new Float32Array(POOL); this._blife = new Float32Array(POOL);
    this._bw = new Float32Array(POOL); this._bage = new Float32Array(POOL);
    this._bkind = new Uint8Array(POOL);
    this._phase = new Float32Array(SHOOTERS);

    // --- rockets / muzzles / rail / laser state ------------------------------------------------
    this._rx = new Float32Array(ROCKET_POOL); this._ry = new Float32Array(ROCKET_POOL); this._rz = new Float32Array(ROCKET_POOL);
    this._rpx = new Float32Array(ROCKET_POOL); this._rpz = new Float32Array(ROCKET_POOL);
    this._rdx = new Float32Array(ROCKET_POOL); this._rdz = new Float32Array(ROCKET_POOL);
    this._rdist = new Float32Array(ROCKET_POOL); this._rsmoke = new Float32Array(ROCKET_POOL); this._rroll = new Float32Array(ROCKET_POOL);
    this._mx = new Float32Array(MUZZLE_POOL); this._my = new Float32Array(MUZZLE_POOL); this._mz = new Float32Array(MUZZLE_POOL);
    this._mBirth = new Float32Array(MUZZLE_POOL).fill(-1e9);
    this._mScale = new Float32Array(MUZZLE_POOL); this._mRoll = new Float32Array(MUZZLE_POOL);
    this._railPts = new Float32Array((RAIL_SEGMENTS + 1) * 2);
    this._lox = new Float32Array(LASER_MAX); this._loy = new Float32Array(LASER_MAX); this._loz = new Float32Array(LASER_MAX);
    this._ldx = new Float32Array(LASER_MAX); this._ldy = new Float32Array(LASER_MAX); this._ldz = new Float32Array(LASER_MAX);
    this._llen = new Float32Array(LASER_MAX);

    // --- HDR colours (linear) --------------------------------------------------------------------
    this._muzzleRGB = new Float32Array(hexLinear(PALETTE.fx.muzzle, MUZZLE_GAIN));        // J1 #FFE38A additive
    this._flameRGB = new Float32Array(ROCKET_FLAME_RGB);                                   // exhaust (linear HDR)
    this._laserGlowRGB = new Float32Array([C_LASER[0], C_LASER[1], C_LASER[2]]);          // × LASER_GLOW_GAIN_* per frame
    this._railArcRGB = new Float32Array([C_RAIL[0] * RAIL_ARC_GAIN, C_RAIL[1] * RAIL_ARC_GAIN, C_RAIL[2] * RAIL_ARC_GAIN]);

    this._buildMeshes();
    this._inited = true;
    this.reset();
    return this;
  }

  _buildMeshes() {
    const ctx = this.ctx;
    const render = ctx.render || null;
    const mats = render && render.materials ? render.materials : null;
    const geo = ctx.models && ctx.models.geo ? ctx.models.geo : null;
    const scene = render && render.scene ? render.scene : null;

    // tracers: BoxGeometry(0.04, 0.04, 0.9), instanceColor HDR (ARCH §6.11 / §9.2)
    let tracerGeo = geo && geo.tracer ? geo.tracer : null;
    if (!tracerGeo) { tracerGeo = new BoxGeometry(0.04, 0.04, FIRE.tracerLength); this._ownedGeometries.push(tracerGeo); }   // ARCH §6.11 tracer box
    let tracerMat = mats && typeof mats.tracer === 'function' ? mats.tracer() : null;
    if (!tracerMat) tracerMat = this._own(new MeshBasicMaterial({ color: 0xFFFFFF, toneMapped: false }));
    this.tracers = makeInstanced(tracerGeo, tracerMat, TRACER_CAP, true, 'weapons.tracers');
    this._tracerLen = tracerGeo.parameters && tracerGeo.parameters.depth > 0 ? tracerGeo.parameters.depth : FIRE.tracerLength;

    // Low-tier tracer glow (GDD §16 "bloom off → glow quads"): one additive textures.glow quad per tracer, drawn
    // only while quality.params.bloom === 'off' (created once at the High capacity; hidden on High / Medium)
    this.tracerGlow = null;
    const glowTex = render && render.textures && render.textures.glow ? render.textures.glow : null;
    if (glowTex) {
      const tgGeo = new PlaneGeometry(1, 1);
      this._ownedGeometries.push(tgGeo);
      const tgMat = this._own(new MeshBasicMaterial({
        color: 0xFFFFFF, map: glowTex, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, fog: false,
      }));
      this.tracerGlow = makeInstanced(tgGeo, tgMat, TRACER_CAP, true, 'weapons.tracerGlow');
      this.tracerGlow.renderOrder = 2;
    }

    // muzzle flashes: textured additive quads, the frame picked per instance through iFrame (UV offset)
    const muzzleGeo = geo && geo.muzzle ? geo.muzzle.clone() : new PlaneGeometry(FIRE.muzzleFlash.size, FIRE.muzzleFlash.size);
    this._ownedGeometries.push(muzzleGeo);
    this._muzzleFrame = new InstancedBufferAttribute(new Float32Array(MUZZLE_POOL), 1);
    this._muzzleFrame.setUsage(DynamicDrawUsage);
    tagRange(this._muzzleFrame);
    muzzleGeo.setAttribute('iFrame', this._muzzleFrame);
    const muzzleTex = render && render.textures && render.textures.muzzle ? render.textures.muzzle : null;
    const muzzleMat = this._own(new MeshBasicMaterial({
      color: 0xFFFFFF, map: muzzleTex, transparent: true, depthWrite: false, blending: AdditiveBlending,
      toneMapped: false, fog: false,
    }));
    if (muzzleTex) {
      const frames = MUZZLE_FRAMES > 0 ? MUZZLE_FRAMES : 1;
      const inv = (1 / frames).toFixed(6);
      muzzleMat.onBeforeCompile = function onBeforeCompile(shader) {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float iFrame;')
          .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv.x = vMapUv.x * ' + inv + ' + iFrame * ' + inv + ';\n#endif');
      };
      muzzleMat.customProgramCacheKey = function key() { return 'gr:muzzle'; };
    }
    this.muzzles = makeInstanced(muzzleGeo, muzzleMat, MUZZLE_POOL, true, 'weapons.muzzles');
    this.muzzles.renderOrder = 2;

    // shared additive glow material (exhaust cones, laser halo, rail lightning): white × HDR instanceColor
    const glowMat = this._own(new MeshBasicMaterial({
      color: 0xFFFFFF, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, fog: false,
    }));

    // rockets (models.geo.rocket points −Z, vertex coloured) + exhaust cones
    let rocketGeo = geo && geo.rocket ? geo.rocket : null;
    if (!rocketGeo) {
      rocketGeo = new CylinderGeometry(0.09, 0.09, 0.75, 8);       // fallback: models DIMS.rocket radius, body + nose length
      rocketGeo.rotateX(Math.PI / 2);
      this._ownedGeometries.push(rocketGeo);
    }
    const vc = !!(rocketGeo.attributes && rocketGeo.attributes.color);
    let rocketMat = null;
    if (mats && typeof mats.standard === 'function') {
      rocketMat = mats.standard(vc ? 0xFFFFFF : PALETTE.props.barricade, {
        vertexColors: vc, roughness: PALETTE.material.metal.roughness, metalness: PALETTE.material.metal.metalness,
      });
    }
    if (!rocketMat) {
      rocketMat = this._own(new MeshStandardMaterial({
        color: vc ? 0xFFFFFF : PALETTE.props.barricade, vertexColors: vc,
        roughness: PALETTE.material.metal.roughness, metalness: PALETTE.material.metal.metalness,
      }));
    }
    this.rockets = makeInstanced(rocketGeo, rocketMat, ROCKET_POOL, false, 'weapons.rockets');
    const flameGeo = new ConeGeometry(1, 1, 8, 1, true);
    flameGeo.rotateX(Math.PI / 2);                                  // tip → +Z (behind the rocket)
    flameGeo.translate(0, 0, 0.5);                                  // spans local z ∈ [0, 1]
    this._ownedGeometries.push(flameGeo);
    this.flames = makeInstanced(flameGeo, glowMat, ROCKET_POOL, true, 'weapons.rocketFlames');
    this.flames.renderOrder = 2;

    // laser beams: HDR core cylinders (materials.hdrBasic) + additive halo
    const beamGeo = beamGeometry(10);
    this._ownedGeometries.push(beamGeo);
    let laserMat = mats && typeof mats.hdrBasic === 'function' ? mats.hdrBasic(C_LASER[0], C_LASER[1], C_LASER[2]) : null;
    if (!laserMat) laserMat = this._own(this._hdrMaterial(C_LASER));
    this.beams = makeInstanced(beamGeo, laserMat, LASER_MAX, false, 'weapons.lasers');
    this.beamGlow = makeInstanced(beamGeo, glowMat, LASER_MAX, true, 'weapons.laserGlow');
    this.beamGlow.renderOrder = 2;

    // rail bolt: straight HDR core + jagged lightning polyline (thin boxes)
    let railMat = mats && typeof mats.hdrBasic === 'function' ? mats.hdrBasic(C_RAIL[0], C_RAIL[1], C_RAIL[2]) : null;
    if (!railMat) railMat = this._own(this._hdrMaterial(C_RAIL));
    this.railCore = new Mesh(beamGeo, railMat);
    this.railCore.name = 'weapons.rail';
    this.railCore.frustumCulled = false;
    this.railCore.matrixAutoUpdate = false;
    this.railCore.castShadow = false;
    this.railCore.receiveShadow = false;
    this.railCore.visible = false;
    const arcGeo = new BoxGeometry(1, 1, 1);
    arcGeo.translate(0, 0, -0.5);                                   // unit segment from z = 0 to z = −1
    this._ownedGeometries.push(arcGeo);
    this.railArcs = makeInstanced(arcGeo, glowMat, RAIL_SEGMENTS, true, 'weapons.railArcs');
    this.railArcs.renderOrder = 2;

    this._meshes.push(this.tracers, this.muzzles, this.rockets, this.flames, this.beams, this.beamGlow, this.railCore, this.railArcs);
    if (this.tracerGlow !== null) this._meshes.push(this.tracerGlow);
    if (scene) for (let i = 0; i < this._meshes.length; i++) scene.add(this._meshes[i]);
  }

  /** Fallback HDR material when render.materials.hdrBasic is unavailable (stub harness). */
  _hdrMaterial(rgb) {
    const m = new MeshBasicMaterial({ toneMapped: false });
    m.color.setRGB(rgb[0], rgb[1], rgb[2]);
    return m;
  }

  _own(material) { this._ownedMaterials.push(material); return material; }

  /** Level-start state: no bullets, no power-up, no gear, every mesh hidden. Idempotent, allocation-free. */
  reset() {
    if (!this._inited) return;
    // end whatever is active so HUD pills / audio loops are released (emits nothing on a second call)
    if (this._w !== W_NONE) {
      P_WEND.id = WEAPON_IDS[this._w];
      this._w = W_NONE;
      this._emit('weapon:end', P_WEND);
    }
    this._wLeft = 0;
    if (this._armorOn) this._endGear(ID_ARMOR);
    if (this._magnetOn) this._endGear(ID_MAGNET);
    if (this._chipLeft > 0) this._endGear(ID_CHIP);
    if (this._boosterLeft > 0) this._endGear(ID_BOOSTER);
    this._armorOn = false; this._magnetOn = false; this._chipLeft = 0; this._boosterLeft = 0;

    this._n = 0;
    this._rn = 0;
    this._paused = false;
    this._spin = 0;
    this._rocketTimer = 0;
    this._railTimer = 0;
    this._shakeEst = 0;
    this._shotCount = 0;
    this._aimOn = false;
    this._aimBad = false;
    this._aimYield = false;
    this._yieldX = 0;
    this._winT = 0; this._winShots = 0; this._noShotT = 0;
    this._t = 0;
    this._mHead = 0;
    this._mBirth.fill(-1e9);
    this._railT = Infinity;
    this._railOn = false;
    this._beams = 0;
    this._laserSparkT = 0;
    this._setLaserLight(false);

    // random per-shooter phases (GDD §3.3 "each shooter has a random phase")
    const rng = this.ctx.rngFx;
    for (let k = 0; k < SHOOTERS; k++) this._phase[k] = rng ? rng.next() : (k + 0.5) / SHOOTERS;

    for (let i = 0; i < this._meshes.length; i++) {
      const m = this._meshes[i];
      if (m.isInstancedMesh) m.count = 0;
      m.visible = false;
    }
  }

  dispose() {
    if (!this._inited) return;
    this.reset();
    const render = this.ctx.render;
    const scene = render && render.scene ? render.scene : null;
    for (let i = 0; i < this._meshes.length; i++) {
      const m = this._meshes[i];
      if (scene) scene.remove(m); else if (m.parent) m.parent.remove(m);
      if (m.isInstancedMesh) m.dispose();
    }
    for (let i = 0; i < this._ownedGeometries.length; i++) this._ownedGeometries[i].dispose();
    for (let i = 0; i < this._ownedMaterials.length; i++) this._ownedMaterials[i].dispose();
    this._meshes.length = 0;
    this._ownedGeometries.length = 0;
    this._ownedMaterials.length = 0;
    this._inited = false;
    // no event listeners are registered by this module (quality is read live from ctx.quality.params)
  }

  // -------------------------------------------------------------------------------------------
  // Public getters (ARCH §6.11)
  // -------------------------------------------------------------------------------------------
  /** Active weapon id ('weapon.shotgun' …) or null. */
  get weapon() { return this._w === W_NONE ? null : WEAPON_IDS[this._w]; }
  /** Seconds left on the active weapon (0 when none). */
  get weaponTimeLeft() { return this._w === W_NONE ? 0 : (this._wLeft > 0 ? this._wLeft : 0); }
  /** Active gear: id → seconds left (Infinity for gear.armor / gear.magnet). Only active ids are present. */
  get gear() { return this._gear; }
  /** Fire-rate multiplier from gear (fire-rate chip +40 %). */
  get fireRateMult() { return this._chipLeft > 0 ? 1 + GEAR.chip.rateBonus : 1; }
  /** Damage multiplier from gear (damage booster +50 %); never applied to gate hits. */
  get damageMult() { return this._boosterLeft > 0 ? 1 + GEAR.booster.dmgBonus : 1; }
  /** Live bullets in the shared 256 pool (squad + drone). */
  get liveBullets() { return this._n; }

  /** Squad DPS = C · d · f · fireRateMult · damageMult · FIRE.accuracy (GDD §3.3; the leak model's number). */
  squadDps() {
    const squad = this.ctx.squad;
    const C = squad ? squad.count : 0;
    if (!(C > 0)) return 0;
    return C * this._profileDamage() * this._profileRate() * this.fireRateMult * this.damageMult * FIRE.accuracy;
  }

  /** max(1, C/FIRE.weightDiv) · targetRate/spawnRate for the current weapon pattern. */
  bulletWeight() {
    const squad = this.ctx.squad;
    const C = squad ? squad.count : 0;
    const base = this._baseWeight();
    if (!(C > 0) || this._w === W_LASER) return base;
    this._fireConfig(C);
    return this._cfgWeight;
  }

  /**
   * Base bullet weight w = max(1, C/FIRE.weightDiv) (no spawn-cap fold). GDD §8.1: the rocket / rail / laser
   * gate-hit equivalences are weighted hits (×w) — on gates and the boss shield alike — bounded by the gates'
   * GATE_RULES.intakePerSec bucket and the boss's own shield intake cap.
   */
  _baseWeight() {
    const squad = this.ctx.squad;
    const C = squad ? squad.count : 0;
    return C / FIRE.weightDiv > 1 ? C / FIRE.weightDiv : 1;
  }

  /**
   * Spawns one bullet into the shared pool (ARCH §6.11). kind 'rifle' | 'shotgun' | 'minigun' | 'drone';
   * an unknown kind fires as 'rifle'. Returns false (and counts a drop) when the 256 pool is full.
   * The sniper is NOT a bullet (instant, troops §6.6). y may be any height (hit tests are XZ-only):
   * drone bullets start at the drone and descend visually to bullet height. Drone bullets are excluded
   * from the FIRE.spawnRateCap fold (their weight arrives pre-computed from troops).
   */
  spawnBullet(x, y, z, dirX, dirZ, speed, life, weight, kind) {
    if (!this._inited) return false;
    let k = K_RIFLE;
    if (kind === 'drone') k = K_DRONE;
    else if (kind === 'shotgun') k = K_SHOTGUN;
    else if (kind === 'minigun') k = K_MINIGUN;
    const l = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (!(l > EPS)) { dirX = 0; dirZ = -1; } else { dirX /= l; dirZ /= l; }
    SP[0] = x; SP[1] = y; SP[2] = z; SP[3] = dirX; SP[4] = dirZ;
    SP[5] = speed > 0 ? speed : FIRE.bullet.speed; SP[6] = life > 0 ? life : FIRE.bullet.life; SP[7] = weight > 0 ? weight : 1;
    SP[SP_VY] = 0;
    return this._spawn(k);
  }

  // -------------------------------------------------------------------------------------------
  // Power-ups and gear (ARCH §6.11, GDD §8.1 / §8.2)
  // -------------------------------------------------------------------------------------------
  /** Starts (or replaces + refreshes) a timed weapon. Replacing an active weapon refunds PICKUPS.replaceRefund. */
  startWeapon(id) {
    const idx = WEAPON_IDS.indexOf(id);
    if (idx < 0) { warnOnce('weapons.unknown.' + id, 'weapons.startWeapon: unknown weapon id ' + id); return; }
    const squad = this.ctx.squad;
    if (this._w !== W_NONE) {
      // GDD §8: "a new weapon pickup replaces and refreshes (old remaining time refunded as 25 c)"
      P_COIN.amount = PICKUPS.replaceRefund; P_COIN.source = 'refund';
      P_COIN.x = squad ? squad.x : 0; P_COIN.y = REFUND_Y; P_COIN.z = 0;
      this._emit('coin:pickup', P_COIN);
      P_WEND.id = WEAPON_IDS[this._w];
      const wasLaser = this._w === W_LASER;
      this._w = W_NONE;
      this._emit('weapon:end', P_WEND);
      if (wasLaser && idx !== W_LASER) { this._beams = 0; this._setLaserLight(false); }
    }
    const def = WEAPONS[WEAPON_KEYS[idx]];
    this._w = idx;
    this._wLeft = def.duration;
    this._spin = 0;
    this._rocketTimer = 0;          // the first rocket / bolt leaves at once (the pickup moment)
    this._railTimer = 0;
    this._laserSparkT = 0;
    if (idx === W_LASER) this._setLaserLight(true);
    P_WSTART.id = id; P_WSTART.duration = def.duration;
    this._emit('weapon:start', P_WSTART);
  }

  /**
   * Gear pickup (ARCH §6.11): armor → squad.setArmor(min(C, platesCap)) (re-pickup refills, no refund);
   * magnet → pickups.setMagnet(radius) (re-pickup pays PICKUPS.duplicateCoins as 'duplicate', no gear:start);
   * chip / booster → timers (re-pickup refreshes, no refund). Emits gear:start { id, duration }.
   */
  startGear(id) {
    const ctx = this.ctx;
    const squad = ctx.squad;
    if (id === ID_ARMOR) {
      const C = squad ? squad.count : 0;
      if (squad && typeof squad.setArmor === 'function') squad.setArmor(C < GEAR.armor.platesCap ? C : GEAR.armor.platesCap);
      this._armorOn = true;
      this._gear[ID_ARMOR] = GEAR.armor.duration;
      this._emitGearStart(ID_ARMOR, GEAR.armor.duration);
    } else if (id === ID_MAGNET) {
      if (this._magnetOn) {
        P_COIN.amount = PICKUPS.duplicateCoins; P_COIN.source = 'duplicate';
        P_COIN.x = squad ? squad.x : 0; P_COIN.y = REFUND_Y; P_COIN.z = 0;
        this._emit('coin:pickup', P_COIN);
        return;
      }
      const pickups = ctx.pickups;
      if (pickups && typeof pickups.setMagnet === 'function') pickups.setMagnet(GEAR.magnet.radius);
      this._magnetOn = true;
      this._gear[ID_MAGNET] = GEAR.magnet.duration;
      this._emitGearStart(ID_MAGNET, GEAR.magnet.duration);
    } else if (id === ID_CHIP) {
      this._chipLeft = GEAR.chip.duration;
      this._gear[ID_CHIP] = this._chipLeft;
      this._emitGearStart(ID_CHIP, GEAR.chip.duration);
    } else if (id === ID_BOOSTER) {
      this._boosterLeft = GEAR.booster.duration;
      this._gear[ID_BOOSTER] = this._boosterLeft;
      this._emitGearStart(ID_BOOSTER, GEAR.booster.duration);
    } else {
      warnOnce('weapons.unknownGear.' + id, 'weapons.startGear: unknown gear id ' + id);
    }
  }

  /** Pauses / resumes the weapon timer AND the chip / booster timers (boss intro). Firing continues. */
  pauseTimers(on) { this._paused = !!on; }

  _emitGearStart(id, duration) {
    P_GSTART.id = id; P_GSTART.duration = duration;
    this._emit('gear:start', P_GSTART);
  }

  /** Ends one gear effect: removes its key and emits gear:end. Magnet also restores the base pickup radius. */
  _endGear(id) {
    if (id === ID_ARMOR) this._armorOn = false;
    else if (id === ID_MAGNET) {
      this._magnetOn = false;
      const pickups = this.ctx.pickups;
      if (pickups && typeof pickups.setMagnet === 'function') pickups.setMagnet(GEAR.magnet.baseRadius);
    } else if (id === ID_CHIP) this._chipLeft = 0;
    else if (id === ID_BOOSTER) this._boosterLeft = 0;
    delete this._gear[id];
    P_GEND.id = id;
    this._emit('gear:end', P_GEND);
  }

  _endWeapon() {
    const was = this._w;
    if (was === W_NONE) return;
    this._w = W_NONE;
    this._wLeft = 0;
    this._spin = 0;
    if (was === W_LASER) { this._beams = 0; this._setLaserLight(false); }
    P_WEND.id = WEAPON_IDS[was];
    this._emit('weapon:end', P_WEND);
  }

  _emit(name, payload) {
    const ev = this.ctx.events;
    if (ev) ev.emit(name, payload);
  }

  _drop(name) {
    const d = this.ctx.debug;
    if (d && d.dropped) d.dropped[name] = (d.dropped[name] | 0) + 1;
  }

  /** d = ctx.profile.damage (FIRE.dmgBase when the profile is missing). */
  _profileDamage() {
    const p = this.ctx.profile;
    return p && p.damage > 0 ? p.damage : FIRE.dmgBase;
  }

  /** f = ctx.profile.fireRate (FIRE.rateBase when the profile is missing). */
  _profileRate() {
    const p = this.ctx.profile;
    return p && p.fireRate > 0 ? p.fireRate : FIRE.rateBase;
  }

  /** render.lights.laser on/off. Kept visible once enabled (toggling light visibility recompiles every lit program). */
  _setLaserLight(on) {
    const render = this.ctx.render;
    const light = render && render.lights ? render.lights.laser : null;
    this._laserLightOn = on;
    if (!light) return;
    if (on) {
      if (light.color && typeof light.color.setHex === 'function') light.color.setHex(WEAPONS.laser.color);
      light.distance = LASER_LIGHT_DISTANCE;
      light.intensity = LASER_LIGHT_INTENSITY;
      if (light.visible === false) light.visible = true;
    } else {
      light.intensity = 0;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Simulation (ARCH §4.2 step B: after troops.step, before zombies.step)
  // -------------------------------------------------------------------------------------------
  step(dt) {
    if (!this._inited) return;
    const ctx = this.ctx;
    this._t += dt;
    this._stepTimers(dt);
    this._detectQueries();

    const squad = ctx.squad || null;
    const C = squad !== null ? squad.count : 0;
    this._shotCount = 0;
    this._aimOn = this._computeAim(squad);

    if (C > 0 && squad !== null) {
      if (this._w === W_LASER) this._stepLaser(dt, C, squad);
      else {
        this._beams = 0;
        this._fireRifles(dt, C, squad);
        if (this._w === W_ROCKET) this._stepRocketLauncher(dt, squad);
        else if (this._w === W_RAIL) this._stepRailgun(dt, squad);
      }
    } else {
      this._beams = 0;
    }

    this._updateBroadphase();
    this._stepBullets(dt);
    this._stepRockets(dt);
    this._stepRailVisual(dt);
    this._stepShake(dt);
    this._stepDiagnostics(dt, C);

    if (this._shotCount > 0) {
      // one coalesced event per step (ARCH §5.1); weapon = the pattern that fired: 'rifle' | 'weapon.shotgun' | 'weapon.minigun'
      P_SHOT.count = this._shotCount;
      P_SHOT.x = squad !== null ? squad.x : 0;
      P_SHOT.z = 0;
      P_SHOT.weapon = SHOT_LABEL[this._cfgKind] || 'rifle';
      this._emit('shot', P_SHOT);
    }
  }

  /**
   * Diagnostics (WPN-7): ctx.debug.shotsPerSec (trigger pulls per second over 1 s windows; rockets / rail bolts
   * excluded) and ctx.debug.laserBeams for the overlay; under ?debug=1 a one-time warning when the squad has
   * C > 0 in 'playing' and fired nothing (no shot, no laser beam) for NO_SHOT_WARN_S while ≥ 2 shots were due.
   */
  _stepDiagnostics(dt, C) {
    const dbg = this.ctx.debug;
    if (!dbg) return;
    const beams = this._w === W_LASER ? this._beams : 0;
    this._winT += dt;
    this._winShots += this._shotCount;
    if (this._winT >= 1) {
      dbg.shotsPerSec = Math.round(this._winShots / this._winT);
      this._winT = 0;
      this._winShots = 0;
    }
    dbg.laserBeams = beams;
    if (!dbg.enabled) return;
    const st = this.ctx.state;
    const playing = !!st && typeof st.is === 'function' && st.is('playing');
    if (!(C > 0) || !playing || this._shotCount > 0 || beams > 0) { this._noShotT = 0; return; }
    this._noShotT += dt;
    if (this._stallWarned || this._noShotT < NO_SHOT_WARN_S) return;
    // a single slow shooter legitimately waits one interval: only warn when at least 2 shots were due
    if (this._cfgS * this._cfgPer * this._cfgScale * this._noShotT < 2) return;
    this._stallWarned = true;
    warnOnce('weapons.noShots', 'weapons: no shot for ' + this._noShotT.toFixed(2) + ' s with C = ' + C
      + ' (shooters ' + this._cfgS + ', per ' + this._cfgPer + ', scale ' + this._cfgScale + ', weight ' + this._cfgWeight
      + ', weapon ' + (this.weapon || 'rifle') + ', aim ' + this._aimOn + ', bullets ' + this._n + ')');
  }

  /** Weapon + chip/booster timers (paused during the boss intro), minigun spin-up, armor consumption. */
  _stepTimers(dt) {
    if (!this._paused) {
      if (this._w !== W_NONE) {
        this._wLeft -= dt;
        if (this._wLeft <= 0) this._endWeapon();
      }
      if (this._chipLeft > 0) {
        this._chipLeft -= dt;
        if (this._chipLeft <= 0) this._endGear(ID_CHIP);
        else this._gear[ID_CHIP] = this._chipLeft;
      }
      if (this._boosterLeft > 0) {
        this._boosterLeft -= dt;
        if (this._boosterLeft <= 0) this._endGear(ID_BOOSTER);
        else this._gear[ID_BOOSTER] = this._boosterLeft;
      }
    }
    if (this._w === W_MINIGUN) this._spin += dt;
    if (this._armorOn) {
      // GDD §8.2 armor lasts "until consumed": end the gear entry when the last plate is gone
      const squad = this.ctx.squad;
      if (squad && squad.armor <= 0) this._endGear(ID_ARMOR);
    }
  }

  /** Which targets offer the typed-segment queries (ARCH §7 hitTestSeg, WPN-8); 4 typeof checks per step. */
  _detectQueries() {
    const ctx = this.ctx;
    const z = ctx.zombies, b = ctx.boss, g = ctx.gates, p = ctx.pickups;
    this._zSeg = !!z && typeof z.hitTestSeg === 'function';
    this._bSeg = !!b && typeof b.hitTestSeg === 'function';
    this._gSeg = !!g && typeof g.hitTestSeg === 'function';
    this._pSeg = !!p && typeof p.hitTestSeg === 'function';
  }

  /**
   * Boss re-aim (GDD §3.3): true while ctx.world.bossActive (intro included) and the core is within
   * FIRE.bossAimRange — unless a contact threat holds the line this step (WPN-7, GDD §3.3 "minions on the line
   * still soak", §6.1 brutes are focus-fired): the living zombie nearest to (squad.x, −yield/2) lies ≤ FIRE.bossAimYieldM
   * ahead of the front row (−yield ≤ z ≤ +0.5; one already behind the front row cannot be shot) and within
   * world.squadHalfWidth + 1 m of the squad's x. Only the shooters (and laser beams) within ±FIRE.bossAimYieldCol of that
   * threat's x then fly straight (−Z) into it; every other shooter keeps firing at the boss; rockets fly straight. A non-finite aim point disables the re-aim and flags the step
   * for the base rifle config (hardening, warnOnce 'weapons.fireConfig').
   */
  _computeAim(squad) {
    const ctx = this.ctx;
    const world = ctx.world;
    const boss = ctx.boss;
    this._aimBad = false;
    this._aimYield = false;
    if (!world || !world.bossActive || !boss || typeof boss.aimPoint !== 'function') return false;
    boss.aimPoint(V_AIM);
    const ax = V_AIM.x, ay = V_AIM.y, az = V_AIM.z;
    if (!(ax - ax === 0 && ay - ay === 0 && az - az === 0)) { this._aimBad = true; return false; }   // NaN / ±Infinity
    if (!(az < 0)) return false;
    const sx = squad !== null ? squad.x : 0;
    const dx = ax - sx;
    if (dx * dx + az * az > BOSS_AIM_RANGE * BOSS_AIM_RANGE) return false;
    const zombies = ctx.zombies;
    if (zombies && typeof zombies.nearest === 'function' && zombies.nearest(sx, BOSS_AIM_YIELD_QZ, OUT_N)
      && OUT_N.z >= -BOSS_AIM_YIELD_M && OUT_N.z <= BOSS_AIM_YIELD_BEHIND) {
      const hw = world.squadHalfWidth > 0 ? world.squadHalfWidth : 0;
      const lx = OUT_N.x - sx;
      const band = hw + BOSS_AIM_YIELD_PAD;
      if (lx <= band && lx >= -band) { this._aimYield = true; this._yieldX = OUT_N.x; }
    }
    return true;
  }

  /** True when a contact threat holds the line this step and a shooter at x stands in its column (fires straight). */
  _inYieldColumn(x) {
    if (!this._aimYield) return false;
    const d = x - this._yieldX;
    return d <= BOSS_AIM_YIELD_COL && d >= -BOSS_AIM_YIELD_COL;
  }

  /**
   * Fire configuration for C soldiers and the active weapon (GDD §3.3 / §8.1): shooters, per-shooter rate,
   * pellets, kind, spread, life, folded weight and the spawn scale (spawnRate / targetRate ≤ 1).
   */
  _fireConfig(C) {
    const w = this._w;
    let rateMult = 1, pellets = 1, kind = K_RIFLE, spread = FIRE.bullet.spreadDeg, life = FIRE.bullet.life;
    if (w === W_SHOTGUN) {
      rateMult = WEAPONS.shotgun.rateMult;
      pellets = WEAPONS.shotgun.pellets;
      kind = K_SHOTGUN;
      life = WEAPONS.shotgun.range / FIRE.bullet.speed;          // 14 m range → 0.4 s
    } else if (w === W_MINIGUN) {
      const spinUp = WEAPONS.minigun.spinUp;
      const u = spinUp > 0 ? clamp(this._spin / spinUp, 0, 1) : 1;
      rateMult = MINIGUN_SPIN_FROM + (WEAPONS.minigun.rateMult - MINIGUN_SPIN_FROM) * u;
      kind = K_MINIGUN;
      spread = WEAPONS.minigun.spreadDeg;
    } else if (w === W_ROCKET) {
      rateMult = WEAPONS.rocket.rifleKeep;                          // squad keeps rifle fire at 50 %
    } else if (w === W_RAIL) {
      rateMult = WEAPONS.railgun.rifleKeep;
    }
    const S = C < SHOOTERS ? C : SHOOTERS;
    const per = this._profileRate() * this.fireRateMult * rateMult;     // shots/s per shooter
    const target = S * per * pellets;                                   // bullets/s the design asks for
    const spawn = target < FIRE.spawnRateCap ? target : FIRE.spawnRateCap;
    const base = C / FIRE.weightDiv > 1 ? C / FIRE.weightDiv : 1;
    this._cfgS = S;
    this._cfgPer = per;
    this._cfgPellets = pellets;
    this._cfgKind = kind;
    this._cfgSpread = spread * DEG;
    this._cfgLife = life;
    this._cfgScale = target > 0 ? spawn / target : 0;
    this._cfgWeight = target > 0 ? base * (target / spawn) : base;      // excess folded into w
  }

  /** True when the per-shooter rate, spawn scale and weight are all finite and > 0 (NaN fails every comparison). */
  _cfgValid() {
    const p = this._cfgPer, s = this._cfgScale, w = this._cfgWeight;
    return p > 0 && p < Infinity && s > 0 && s < Infinity && w > 0 && w < Infinity;
  }

  /**
   * Hardening (WPN-7): the base rifle configuration for C soldiers (FIRE.rateBase, no weapon / gear multipliers),
   * used for a step whose _fireConfig() or boss aim point is not finite, so the squad can never silently stop
   * firing while C > 0. Warns once ('weapons.fireConfig').
   */
  _baseRifleConfig(C) {
    if (!this._cfgWarned) {
      this._cfgWarned = true;
      warnOnce('weapons.fireConfig', 'weapons: invalid fire config (per ' + this._cfgPer + ', scale ' + this._cfgScale
        + ', weight ' + this._cfgWeight + ', aim ' + (this._aimBad ? 'non-finite' : 'ok') + ') - firing the base rifle config');
    }
    const S = C < SHOOTERS ? C : SHOOTERS;
    const per = FIRE.rateBase;
    const target = S * per;
    const spawn = target < FIRE.spawnRateCap ? target : FIRE.spawnRateCap;
    const base = C / FIRE.weightDiv > 1 ? C / FIRE.weightDiv : 1;
    this._cfgS = S;
    this._cfgPer = per;
    this._cfgPellets = 1;
    this._cfgKind = K_RIFLE;
    this._cfgSpread = FIRE.bullet.spreadDeg * DEG;
    this._cfgLife = FIRE.bullet.life;
    this._cfgScale = target > 0 ? spawn / target : 0;
    this._cfgWeight = target > 0 ? base * (target / spawn) : base;
  }

  /** Advances every shooter's phase timer; each expiry fires one shot (shotgun: one pellet fan). */
  _fireRifles(dt, C, squad) {
    this._fireConfig(C);
    if (this._aimBad || !this._cfgValid()) this._baseRifleConfig(C);
    const S = this._cfgS;
    const adv = this._cfgPer * this._cfgScale * dt;      // fraction of a shot interval consumed this step
    if (!(adv > 0)) return;
    const phase = this._phase;
    for (let k = 0; k < S; k++) {
      let ph = phase[k] - adv;
      let guard = 0;
      while (ph <= 0 && guard < 4) {                     // ≤ 0.3 shots per step per shooter in practice
        ph += 1;
        guard++;
        this._shoot(k, squad);
      }
      phase[k] = ph > 0 ? ph : 1;
    }
  }

  /** One shot from shooter k: bullet(s) along −Z (or at the boss) with spread, recoil, muzzle flash. */
  _shoot(k, squad) {
    const rng = this.ctx.rngFx;
    squad.shooterPosition(k, V_POS);
    const ox = V_POS.x, oy = V_POS.y, oz = V_POS.z;
    const kind = this._cfgKind, w = this._cfgWeight, life = this._cfgLife, speed = FIRE.bullet.speed;
    let ax = 0, az = -1, vy = 0;
    if (this._aimOn && !this._inYieldColumn(ox)) {
      const dx = V_AIM.x - ox, dz = V_AIM.z - oz;
      const l = Math.sqrt(dx * dx + dz * dz);
      if (l > BOSSES.radius) {
        ax = dx / l; az = dz / l;
        // WPN-9: the tracer climbs to BOSS_TRACER_Y where the bullet enters the capsule (cosmetic; tests stay XZ)
        const reach = l - BOSSES.radius;
        if (BOSS_TRACER_Y > oy) vy = (BOSS_TRACER_Y - oy) * speed / (reach > 1 ? reach : 1);
      }
    }
    SP[SP_VY] = vy;
    const spread = this._cfgSpread;
    const pellets = this._cfgPellets;
    if (pellets > 1) {
      const fan = WEAPONS.shotgun.fanDeg * DEG;                      // ±10° fan, pellets evenly spaced + ±spread jitter
      const gap = (2 * fan) / (pellets - 1);
      for (let p = 0; p < pellets; p++) {
        const a = -fan + p * gap + (rng ? rng.range(-spread, spread) : 0);
        const c = Math.cos(a), s = Math.sin(a);
        SP[0] = ox; SP[1] = oy; SP[2] = oz; SP[3] = ax * c - az * s; SP[4] = ax * s + az * c; SP[5] = speed; SP[6] = life; SP[7] = w;
        this._spawn(kind);
      }
    } else {
      const a = rng ? rng.range(-spread, spread) : 0;
      const c = Math.cos(a), s = Math.sin(a);
      SP[0] = ox; SP[1] = oy; SP[2] = oz; SP[3] = ax * c - az * s; SP[4] = ax * s + az * c; SP[5] = speed; SP[6] = life; SP[7] = w;
      this._spawn(kind);
    }
    squad.setFireVisual(k);
    SP[0] = ox; SP[1] = oy; SP[2] = oz;
    this._flash(kind === K_SHOTGUN ? FLASH_SCALE_SHOTGUN : (kind === K_MINIGUN ? FLASH_SCALE_MINIGUN : 1));
    this._shotCount++;
  }

  /** Pool insert of SP (x, y, z, unit dirX, dirZ, speed, life, weight) as `kind`. Counts a drop when full. */
  _spawn(kind) {
    if (this._n >= POOL) { this._drop('weapons.bullets'); return false; }
    const x = SP[0], y = SP[1], z = SP[2], dx = SP[3], dz = SP[4], speed = SP[5], life = SP[6], weight = SP[7];
    const i = this._n++;
    this._bx[i] = x; this._by[i] = y; this._bz[i] = z;
    this._bpx[i] = x; this._bpz[i] = z;
    this._bdx[i] = dx; this._bdz[i] = dz;
    this._bspd[i] = speed; this._blife[i] = life;
    this._bw[i] = weight; this._bage[i] = 0;
    this._bkind[i] = kind;
    // drone tracers start ≈ 2.7 m up and descend to bullet height over DRONE_DROP_M; boss-aimed tracers climb
    // (SP[SP_VY] > 0, WPN-9). Cosmetic only: hit tests are XZ.
    this._bvy[i] = kind === K_DRONE && y > FIRE.bullet.y ? -(y - FIRE.bullet.y) * speed / DRONE_DROP_M : SP[SP_VY];
    return true;
  }

  /** Swap-remove of bullet i. */
  _free(i) {
    const last = --this._n;
    if (i === last) return;
    this._bx[i] = this._bx[last]; this._by[i] = this._by[last]; this._bz[i] = this._bz[last];
    this._bpx[i] = this._bpx[last]; this._bpz[i] = this._bpz[last];
    this._bdx[i] = this._bdx[last]; this._bdz[i] = this._bdz[last]; this._bvy[i] = this._bvy[last];
    this._bspd[i] = this._bspd[last]; this._blife[i] = this._blife[last];
    this._bw[i] = this._bw[last]; this._bage[i] = this._bage[last];
    this._bkind[i] = this._bkind[last];
  }

  /** Bullet integration + swept hit tests (ARCH §7 priority: zombie, boss, gate, crate; smallest t; ties → zombie). */
  _stepBullets(dt) {
    if (this._n === 0) return;
    const ctx = this.ctx;
    const world = ctx.world;
    const road = world ? world.roadSpeed * dt : 0;
    const zombies = ctx.zombies || null;
    const boss = world && world.bossActive && ctx.boss ? ctx.boss : null;
    const gates = ctx.gates || null;
    const pickups = ctx.pickups || null;
    const yMin = FIRE.bullet.y;
    const yMax = BOSS_TRACER_Y_MAX;
    const bx = this._bx, by = this._by, bz = this._bz, bdx = this._bdx, bdz = this._bdz, bvy = this._bvy;
    const bspd = this._bspd, blife = this._blife, bage = this._bage, bkind = this._bkind;
    let i = 0;
    while (i < this._n) {
      const spd = bspd[i];
      const px = bx[i], pz = bz[i];
      const nx = px + bdx[i] * spd * dt;
      const nz = pz + bdz[i] * spd * dt;
      this._bpx[i] = px; this._bpz[i] = pz;
      bx[i] = nx; bz[i] = nz;
      // cosmetic height (drone descent / boss-aim climb), clamped to [yMin, yMax] where vy stops. Branch-free on
      // purpose: both compares run for every bullet, so the first drone / boss bullet finds type feedback (WPN-8).
      let y = by[i] + bvy[i] * dt;
      const lo = y < yMin, hi = y > yMax;
      if (lo) y = yMin;
      if (hi) y = yMax;
      if (lo || hi) bvy[i] = 0;
      by[i] = y;
      blife[i] -= dt;
      bage[i] += dt;
      const drone = bkind[i] === K_DRONE;
      // road-frame sweep: the start is pushed back by this step's scroll so thin targets cannot tunnel
      SEG[0] = px; SEG[1] = pz + road; SEG[2] = nx; SEG[3] = nz;
      const hit = this._sweep(zombies, boss, drone ? null : gates, drone ? null : pickups, BULLET_R);
      if (hit !== H_NONE) {
        this._applyBulletHit(hit, i, zombies, boss, gates, pickups);
        this._free(i);
        continue;
      }
      if (blife[i] <= 0) { this._free(i); continue; }
      i++;
    }
  }

  /**
   * Swept segment test of SEG [x0, z0, x1, z1] inflated by `radius` against every target system; fills OUT_* and
   * this._hx/_hz with the winner. Returns H_NONE | H_ZOMBIE | H_BOSS | H_GATE | H_CRATE. Ties go to the
   * earlier system in that order. WPN-8: each target is asked through its typed query hitTestSeg(SEG, …) (ARCH §7,
   * nothing boxed); a target without one gets hitTestSegment(x0, z0, x1, z1, …) with SEG boxed once per sweep.
   * `radius` is always a module constant (BULLET_R / ROCKET_RADIUS), so it is passed as the same tagged value.
   */
  _sweep(zombies, boss, gates, pickups, radius) {
    // broadphase (exact): skip the queries that cannot hit
    const za = SEG[1], zb = SEG[3];
    if (gates !== null && (za < zb ? za : zb) > this._gateReachZ) gates = null;
    if (!this._zombiesAlive) zombies = null;
    if (zombies === null && boss === null && gates === null && pickups === null) return H_NONE;
    let boxed = false;
    let best = H_NONE, bestT = 2;
    if (zombies !== null) {
      let h;
      if (this._zSeg) h = zombies.hitTestSeg(SEG, radius, OUT_Z);
      else { boxSeg(); boxed = true; h = zombies.hitTestSegment(SEGT[0], SEGT[1], SEGT[2], SEGT[3], radius, OUT_Z); }
      if (h) { best = H_ZOMBIE; bestT = OUT_Z.t; this._hx = OUT_Z.x; this._hz = OUT_Z.z; }
    }
    if (boss !== null) {
      let h;
      if (this._bSeg) h = boss.hitTestSeg(SEG, radius, OUT_B);
      else { if (!boxed) { boxSeg(); boxed = true; } h = boss.hitTestSegment(SEGT[0], SEGT[1], SEGT[2], SEGT[3], radius, OUT_B); }
      if (h && OUT_B.t < bestT) { best = H_BOSS; bestT = OUT_B.t; this._hx = OUT_B.x; this._hz = OUT_B.z; }
    }
    if (gates !== null) {
      let h;
      if (this._gSeg) h = gates.hitTestSeg(SEG, OUT_G);
      else { if (!boxed) { boxSeg(); boxed = true; } h = gates.hitTestSegment(SEGT[0], SEGT[1], SEGT[2], SEGT[3], OUT_G); }
      if (h && OUT_G.t < bestT) { best = H_GATE; bestT = OUT_G.t; this._hx = OUT_G.x; this._hz = OUT_G.z; }
    }
    if (pickups !== null) {
      let h;
      if (this._pSeg) h = pickups.hitTestSeg(SEG, OUT_C);
      else { if (!boxed) { boxSeg(); boxed = true; } h = pickups.hitTestSegment(SEGT[0], SEGT[1], SEGT[2], SEGT[3], OUT_C); }
      if (h && OUT_C.t < bestT) { best = H_CRATE; bestT = OUT_C.t; this._hx = OUT_C.x; this._hz = OUT_C.z; }
    }
    return best;
  }

  /** Boss capsule test of the line in SEGL inflated by `radius` (a module constant), typed when available (WPN-8). */
  _bossLine(boss, radius, out) {
    if (this._bSeg) return boss.hitTestSeg(SEGL, radius, out);
    return boss.hitTestSegment(SEGL[0], SEGL[1], SEGL[2], SEGL[3], radius, out);
  }

  /**
   * Per-step broadphase for _sweep (exact, from public queries only): gates.activeEvent is the nearest unpassed
   * event (largest z); every shootable panel belongs to an unpassed event, so no panel lies above its z + half the
   * panel depth (gates do not move during weapons.step). zombies.alive === 0 skips the zombie query.
   */
  _updateBroadphase() {
    const ctx = this.ctx;
    const gates = ctx.gates;
    let reach = -Infinity;
    if (gates) {
      const ev = gates.activeEvent;
      if (ev) reach = ev.z + GATE_RULES_DEPTH * 0.5 + 0.05;
    }
    this._gateReachZ = reach;
    const zombies = ctx.zombies;
    this._zombiesAlive = !zombies || typeof zombies.alive !== 'number' || zombies.alive > 0;
  }

  /** ARCH §7 resolution for a consumed bullet. Gate hits carry no damageMult; the drone weighs 0 on the boss shield. */
  _applyBulletHit(hit, i, zombies, boss, gates, pickups) {
    const w = this._bw[i];
    const kind = this._bkind[i];
    if (hit === H_ZOMBIE) {
      zombies.damage(OUT_Z.id, w * this._profileDamage() * this.damageMult * KIND_DMG[kind], OUT_Z.x, OUT_Z.y, OUT_Z.z, 'bullet');
    } else if (hit === H_BOSS) {
      boss.damage(w * this._profileDamage() * this.damageMult * KIND_DMG[kind], w * KIND_GATE[kind], OUT_B.x, OUT_B.y, OUT_B.z);
    } else if (hit === H_GATE) {
      const g = OUT_G.gate;
      if (g) gates.applyHit(g.id, w * KIND_GATE[kind], OUT_G.x, OUT_G.y, OUT_G.z);
    } else if (hit === H_CRATE) {
      pickups.hit(OUT_C.id);
    }
  }

  /** Spawns a muzzle-flash quad at SP (x, y, z) (ring buffer of FIRE.muzzleFlash.pool; the oldest is reused). */
  _flash(scale) {
    const x = SP[0], y = SP[1], z = SP[2];
    const m = this._mHead;
    this._mHead = m + 1 < MUZZLE_POOL ? m + 1 : 0;
    const rng = this.ctx.rngFx;
    this._mx[m] = x; this._my[m] = y; this._mz[m] = z;
    this._mBirth[m] = this._t;
    this._mScale[m] = scale * (1 + (rng ? rng.range(-MUZZLE_SCALE_JITTER, MUZZLE_SCALE_JITTER) : 0));
    this._mRoll[m] = rng ? rng.range(0, Math.PI * 2) : 0;
  }

  // ---- rocket launcher (GDD §8.1) -------------------------------------------------------------

  _stepRocketLauncher(dt, squad) {
    this._rocketTimer -= dt;
    if (this._rocketTimer > 0) return;
    this._rocketTimer += WEAPONS.rocket.every;                     // one rocket every 0.6 s
    if (this._rocketTimer < 0) this._rocketTimer = 0;
    this._launchRocket(squad);
  }

  _launchRocket(squad) {
    if (this._rn >= ROCKET_POOL) { this._drop('weapons.rockets'); return; }
    const x = squad.x;
    const z = squad.centerZ;                                         // "from the blob centre"
    let dx = 0, dz = -1;
    if (this._aimOn && !this._aimYield) {
      const ax = V_AIM.x - x, az = V_AIM.z - z;
      const l = Math.sqrt(ax * ax + az * az);
      if (l > BOSSES.radius) { dx = ax / l; dz = az / l; }
    }
    const r = this._rn++;
    this._rx[r] = x; this._ry[r] = ROCKET_LAUNCH_Y; this._rz[r] = z;
    this._rpx[r] = x; this._rpz[r] = z;
    this._rdx[r] = dx; this._rdz[r] = dz;
    this._rdist[r] = 0;
    this._rsmoke[r] = 0;
    const rng = this.ctx.rngFx;
    this._rroll[r] = rng ? rng.range(0, Math.PI * 2) : 0;
    SP[0] = x; SP[1] = ROCKET_LAUNCH_Y; SP[2] = z;
    this._flash(FLASH_SCALE_HEAVY);
  }

  _freeRocket(r) {
    const last = --this._rn;
    if (r === last) return;
    this._rx[r] = this._rx[last]; this._ry[r] = this._ry[last]; this._rz[r] = this._rz[last];
    this._rpx[r] = this._rpx[last]; this._rpz[r] = this._rpz[last];
    this._rdx[r] = this._rdx[last]; this._rdz[r] = this._rdz[last];
    this._rdist[r] = this._rdist[last]; this._rsmoke[r] = this._rsmoke[last]; this._rroll[r] = this._rroll[last];
  }

  /** Rocket flight: smoke trail, swept test (all four target kinds), detonation on contact or at maxRange. */
  _stepRockets(dt) {
    if (this._rn === 0) return;
    const ctx = this.ctx;
    const world = ctx.world;
    const roadSpeed = world ? world.roadSpeed : 0;
    const road = roadSpeed * dt;
    const zombies = ctx.zombies || null;
    const boss = world && world.bossActive && ctx.boss ? ctx.boss : null;
    const gates = ctx.gates || null;
    const pickups = ctx.pickups || null;
    const fx = ctx.fx || null;
    const canEmit = fx !== null && typeof fx.emit === 'function';
    const speed = WEAPONS.rocket.speed;
    let r = 0;
    while (r < this._rn) {
      const px = this._rx[r], pz = this._rz[r];
      const nx = px + this._rdx[r] * speed * dt;
      const nz = pz + this._rdz[r] * speed * dt;
      this._rpx[r] = px; this._rpz[r] = pz;
      this._rx[r] = nx; this._rz[r] = nz;
      this._rdist[r] += speed * dt;
      this._rroll[r] += ROCKET_SPIN * dt;
      // smoke trail (particles drift with the road: the air is still, the ground moves toward the camera)
      this._rsmoke[r] -= dt;
      if (this._rsmoke[r] <= 0) {
        this._rsmoke[r] += ROCKET_SMOKE_EVERY;
        if (canEmit) {
          O_SMOKE.vx = 0; O_SMOKE.vy = ROCKET_SMOKE_RISE; O_SMOKE.vz = roadSpeed;
          fx.emit('smoke', nx - this._rdx[r] * ROCKET_TAIL, this._ry[r], nz - this._rdz[r] * ROCKET_TAIL, 1, O_SMOKE);
        }
      }
      SEG[0] = px; SEG[1] = pz + road; SEG[2] = nx; SEG[3] = nz;
      const hit = this._sweep(zombies, boss, gates, pickups, ROCKET_RADIUS);
      if (hit !== H_NONE) {
        const gateId = hit === H_GATE && OUT_G.gate ? OUT_G.gate.id : -1;
        const crateId = hit === H_CRATE ? OUT_C.id : -1;
        this._detonate(this._hx, this._hz, gateId, crateId);
        this._freeRocket(r);
        continue;
      }
      if (this._rdist[r] >= WEAPONS.rocket.maxRange) {
        this._detonate(nx, nz, -1, -1);
        this._freeRocket(r);
        continue;
      }
      r++;
    }
  }

  /**
   * Rocket blast (ARCH §7): zombies.damageInCircle(splash, squadDps·dpsSeconds, 'explosion'); the boss within
   * splash + BOSSES.radius (capsule test of the nearest twin) takes the same damage and WEAPONS.rocket.gateHits·w
   * shield weight; an armed/locked panel within ROCKET_GATE_REACH_X/Z (or the panel hit directly) takes
   * gateHits·w (GDD §8.1 weighted hits); a crate hit directly opens. Emits explosion { kind:'rocket' } +
   * weapon:fire; fx trauma + FOV kick (J21).
   */
  _detonate(x, z, directGateId, directCrateId) {
    const ctx = this.ctx;
    const def = WEAPONS.rocket;
    const dmg = this.squadDps() * def.dpsSeconds;
    const gateW = def.gateHits * this._baseWeight();
    const splash = def.splash;
    const zombies = ctx.zombies;
    if (zombies && dmg > 0) zombies.damageInCircle(x, z, splash, dmg, 'explosion');
    const world = ctx.world;
    const boss = ctx.boss;
    if (boss && world && world.bossActive) {
      SEGL[0] = x; SEGL[1] = z; SEGL[2] = x; SEGL[3] = z;
      if (this._bossLine(boss, ROCKET_SPLASH, OUT_LB)) boss.damage(dmg, gateW, x, BOSSES.coreY, z);
    }
    const gates = ctx.gates;
    if (gates) {
      if (directGateId >= 0) gates.applyHit(directGateId, gateW, x, FIRE.bullet.y, z);
      const ev = gates.activeEvent;
      if (ev && ev.lanes) {
        const lanes = ev.lanes;
        for (let l = 0; l < lanes.length; l++) {
          const g = lanes[l];
          if (!g || g.id === directGateId || g.op === 'item') continue;
          if (g.state !== 'armed' && g.state !== 'locked') continue;
          if (!(g.z < WORLD.gateStopZ)) continue;
          const ddx = g.x - x, ddz = g.z - z;
          if (ddx > ROCKET_GATE_REACH_X || ddx < -ROCKET_GATE_REACH_X || ddz > ROCKET_GATE_REACH_Z || ddz < -ROCKET_GATE_REACH_Z) continue;
          gates.applyHit(g.id, gateW, x, FIRE.bullet.y, z);
        }
      }
    }
    if (directCrateId >= 0) {
      const pickups = ctx.pickups;
      if (pickups) for (let h = 0; h < PICKUPS.crate.hitsToOpen; h++) pickups.hit(directCrateId);   // a direct rocket hit opens the crate
    }
    P_EXPLOSION.x = x; P_EXPLOSION.z = z; P_EXPLOSION.radius = splash; P_EXPLOSION.kind = 'rocket';
    this._emit('explosion', P_EXPLOSION);
    P_FIRE.id = def.id; P_FIRE.x = x; P_FIRE.z = z;
    this._emit('weapon:fire', P_FIRE);
    const fx = ctx.fx;
    if (fx) {
      if (typeof fx.addTrauma === 'function') fx.addTrauma(def.trauma);
      if (typeof fx.fovKick === 'function') fx.fovKick(def.fovKick, JUICE.fovKick.seconds);
    }
  }

  // ---- railgun (GDD §8.1) ---------------------------------------------------------------------

  _stepRailgun(dt, squad) {
    this._railTimer -= dt;
    if (this._railTimer > 0) return;
    this._railTimer += WEAPONS.railgun.every;                      // one bolt every 1.2 s
    if (this._railTimer < 0) this._railTimer = 0;
    this._fireRail(squad);
  }

  /**
   * Bolt through the whole road along the squad's x (ARCH §7): zombies.damageInLine(x, 0, halfWidth,
   * squadDps·dpsSeconds), the boss when |bossX − x| ≤ BOSSES.radius + halfWidth (= 2.0; capsule test of the
   * nearest twin along the line), every armed/locked gate whose lane contains x (gateHits·w each, GDD §8.1
   * weighted hits; the boss shield takes the same weight). J21 flash.
   */
  _fireRail(squad) {
    const ctx = this.ctx;
    const def = WEAPONS.railgun;
    const x = squad.x;
    const y = FIRE.bullet.y;
    const z0 = FIRE.muzzleOffset[2];
    const z1 = WORLD.spawnZ;
    const dmg = this.squadDps() * def.dpsSeconds;
    const gateW = def.gateHits * this._baseWeight();
    const zombies = ctx.zombies;
    if (zombies && dmg > 0) zombies.damageInLine(x, 0, def.halfWidth, dmg, 'bullet');
    const world = ctx.world;
    const boss = ctx.boss;
    SEGL[0] = x; SEGL[1] = 0; SEGL[2] = x; SEGL[3] = z1;
    if (boss && world && world.bossActive && this._bossLine(boss, RAIL_HW, OUT_LB)) {
      boss.damage(dmg, gateW, OUT_LB.x, BOSSES.coreY, OUT_LB.z);
    }
    GW[0] = gateW;
    this._gatesAlongLine();

    // visuals: bolt + lightning, muzzle flare, recoil of the centre shooter, screen flash, sparks
    this._railT = 0;
    this._railOn = true;
    this._railX = x; this._railY = y; this._railZ0 = z0; this._railZ1 = z1;
    this._railJitT = 0;
    this._jitterRail();
    SP[0] = x; SP[1] = y; SP[2] = z0;
    this._flash(FLASH_SCALE_HEAVY);
    squad.setFireVisual(0);
    const fx = ctx.fx;
    if (fx) {
      if (typeof fx.flash === 'function') fx.flash(PALETTE.flash.white, def.flash, RAIL_FLASH_ALPHA);
      if (typeof fx.emit === 'function') {
        O_SPARK.vx = 0; O_SPARK.vy = 1; O_SPARK.vz = -6;
        fx.emit('spark', x, y, z0, SPARKS_RAIL, O_SPARK);
      }
    }
    P_FIRE.id = def.id; P_FIRE.x = x; P_FIRE.z = z0;
    this._emit('weapon:fire', P_FIRE);
  }

  /** Re-rolls the lightning polyline offsets (tapered to 0 at both ends). */
  _jitterRail() {
    const rng = this.ctx.rngFx;
    const pts = this._railPts;
    for (let i = 0; i <= RAIL_SEGMENTS; i++) {
      const edge = i < RAIL_SEGMENTS - i ? i : RAIL_SEGMENTS - i;
      const taper = edge < 3 ? edge / 3 : 1;                         // 3 segments of taper at each end
      pts[i * 2] = rng ? rng.range(-RAIL_JITTER, RAIL_JITTER) * taper : 0;
      pts[i * 2 + 1] = rng ? rng.range(-RAIL_JITTER, RAIL_JITTER) * 0.6 * taper : 0;
    }
  }

  _stepRailVisual(dt) {
    if (!this._railOn || this._railT >= RAIL_SHOW) return;
    this._railT += dt;
    this._railJitT += dt;
    if (this._railJitT >= RAIL_REJITTER) { this._railJitT = 0; this._jitterRail(); }
  }

  /**
   * Applies GW[0] weighted gate hits to every armed/locked panel the XZ line SEGL (x0, z0) → (x1, z1) crosses
   * (gates.hitTestSeg / hitTestSegment returns the nearest; the walk restarts just past each panel). Inputs come
   * through the scratch arrays so the per-beam, per-step call boxes nothing (WPN-8).
   */
  _gatesAlongLine() {
    const gates = this.ctx.gates;
    const weight = GW[0];
    if (!gates || !(weight > 0)) return;
    const x0 = SEGL[0], z0 = SEGL[1], x1 = SEGL[2], z1 = SEGL[3];
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (!(len > EPS)) return;
    const ux = dx / len, uz = dz / len;
    const auz = uz < 0 ? -uz : uz;
    const hop = (GATE_RULES_DEPTH + 0.02) / (auz > 0.1 ? auz : 0.1);  // enough travel to leave the panel box
    let sx = x0, sz = z0;
    const typed = this._gSeg;
    for (let it = 0; it < GATE_ITER_MAX; it++) {
      SEGW[0] = sx; SEGW[1] = sz; SEGW[2] = x1; SEGW[3] = z1;
      if (!(typed ? gates.hitTestSeg(SEGW, OUT_L) : gates.hitTestSegment(SEGW[0], SEGW[1], SEGW[2], SEGW[3], OUT_L))) break;
      const g = OUT_L.gate;
      if (g) gates.applyHit(g.id, weight, OUT_L.x, OUT_L.y, OUT_L.z);
      sx = OUT_L.x + ux * hop;
      sz = OUT_L.z + uz * hop;
      if ((sx - x0) * ux + (sz - z0) * uz >= len) break;
    }
  }

  // ---- laser (GDD §8.1) ----------------------------------------------------------------------

  /**
   * One beam per WEAPONS.laser.perBeam visible shooters (min 2, max 8); total DPS = dpsMult · squadDps split
   * across the beams. Per step and beam: damageInLine (straight beams: the whole road ahead; boss-aimed beams:
   * LASER_SLABS vertical slabs up to the boss), boss damage + shield weight gateHitsPerSec·w·dt when the beam
   * crosses the capsule, gate hits gateHitsPerSec·w·dt on every panel it crosses (GDD §8.1 weighted hits).
   */
  _stepLaser(dt, C, squad) {
    const ctx = this.ctx;
    const def = WEAPONS.laser;
    const S = C < SHOOTERS ? C : SHOOTERS;
    let beams = Math.floor(S / def.perBeam);
    if (beams < def.minBeams) beams = def.minBeams;
    if (beams > def.maxBeams) beams = def.maxBeams;
    if (beams > LASER_MAX) beams = LASER_MAX;
    this._beams = beams;
    const dmg = (def.dpsMult * this.squadDps() / beams) * dt;
    const gateW = def.gateHitsPerSec * this._baseWeight() * dt;
    const hw = def.halfWidth;
    const aim = this._aimOn;
    const zombies = ctx.zombies || null;
    const world = ctx.world;
    const boss = world && world.bossActive && ctx.boss ? ctx.boss : null;
    for (let b = 0; b < beams; b++) {
      const k = S >= beams ? Math.floor((b + 0.5) * S / beams) : b % S;
      squad.shooterPosition(k, V_POS);
      const ox = V_POS.x, oy = V_POS.y, oz = V_POS.z;
      let ex = ox, ez = WORLD.spawnZ, dx = 0, dy = 0, dz = -1, len = oz - WORLD.spawnZ;
      let aimed = false;
      if (aim && !this._inYieldColumn(ox)) {
        const ax = V_AIM.x - ox, ay = BOSSES.coreY - oy, az = V_AIM.z - oz;
        const l = Math.sqrt(ax * ax + ay * ay + az * az);
        if (l > BOSSES.radius) {                                    // beam ends at the boss core
          ex = V_AIM.x; ez = V_AIM.z;
          dx = ax / l; dy = ay / l; dz = az / l; len = l;
          aimed = true;
        }
      }
      this._lox[b] = ox; this._loy[b] = oy; this._loz[b] = oz;
      this._ldx[b] = dx; this._ldy[b] = dy; this._ldz[b] = dz; this._llen[b] = len;

      if (zombies !== null && dmg > 0) {
        const lateral = ex - ox;
        if (!aimed || (lateral < hw && lateral > -hw)) {
          zombies.damageInLine(ox, oz, hw, dmg, 'bullet', Infinity, aimed ? ez : WORLD.spawnZ);
        } else {
          for (let s = 0; s < LASER_SLABS; s++) {
            const za = oz + (ez - oz) * (s / LASER_SLABS);
            const zb = oz + (ez - oz) * ((s + 1) / LASER_SLABS);
            const xa = ox + lateral * (s / LASER_SLABS);
            const xb = ox + lateral * ((s + 1) / LASER_SLABS);
            const half = (xb > xa ? xb - xa : xa - xb) * 0.5;
            zombies.damageInLine((xa + xb) * 0.5, za, hw + half, dmg, 'bullet', Infinity, zb);
          }
        }
      }
      SEGL[0] = ox; SEGL[1] = oz; SEGL[2] = ex; SEGL[3] = ez;
      if (boss !== null && this._bossLine(boss, LASER_HW, OUT_LB)) {
        boss.damage(dmg, gateW, OUT_LB.x, BOSSES.coreY, OUT_LB.z);
      }
      GW[0] = gateW;
      this._gatesAlongLine();
    }

    // impact sparks at the boss core; the laser light follows the squad
    const fx = ctx.fx;
    this._laserSparkT -= dt;
    if (aim && this._laserSparkT <= 0) {
      this._laserSparkT = LASER_SPARK_EVERY;
      if (fx && typeof fx.emit === 'function') {
        O_SPARK.vx = 0; O_SPARK.vy = 2; O_SPARK.vz = 3;
        fx.emit('spark', V_AIM.x, BOSSES.coreY, V_AIM.z, SPARKS_LASER * beams, O_SPARK);
      }
    }
    const render = ctx.render;
    const light = render && render.lights ? render.lights.laser : null;
    if (light && light.position) light.position.set(squad.x, LASER_LIGHT_Y, LASER_LIGHT_Z);
  }

  /** Holds the minigun's continuous camera shake (WEAPONS.minigun.shake m = JUICE.shake.x · T²) while it fires. */
  _stepShake(dt) {
    this._shakeEst -= JUICE.shake.decay * dt;
    if (this._shakeEst < 0) this._shakeEst = 0;
    if (this._w !== W_MINIGUN || this._shotCount === 0) return;
    const fx = this.ctx.fx;
    if (!fx || typeof fx.addTrauma !== 'function') return;
    const spinUp = WEAPONS.minigun.spinUp;
    const u = spinUp > 0 ? clamp(this._spin / spinUp, 0, 1) : 1;
    const target = Math.sqrt(WEAPONS.minigun.shake / JUICE.shake.x) * u;
    if (this._shakeEst < target) {
      fx.addTrauma(target - this._shakeEst);
      this._shakeEst = target;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Rendering (ARCH §4.2 step D: instance writes only; positions extrapolated by alpha·STEP)
  // -------------------------------------------------------------------------------------------
  render(alpha) {
    if (!this._inited) return;
    const st = this.ctx.state;
    if (st && typeof st.is === 'function' && !(st.is('playing') || st.is('paused'))) {
      // results / title: nothing steps there, so no frozen weapon visual lingers behind the screens
      this._hideAll();
      return;
    }
    const a = alpha > 0 ? (alpha < 1 ? alpha : 1) : 0;
    RT[RT_ALPHA] = a;
    RT[RT_TNOW] = this._t + a * STEP;
    this._renderTracers();
    this._renderMuzzles();
    this._renderRockets();
    this._renderLaser();
    this._renderRail();
  }

  _hideAll() {
    for (let i = 0; i < this._meshes.length; i++) {
      const m = this._meshes[i];
      if (!m.visible) continue;
      if (m.isInstancedMesh) m.count = 0;
      m.visible = false;
    }
  }

  /**
   * Tracers: one 0.9 m HDR box per live bullet (≤ quality.params.tracers), head extrapolated, tail clipped at
   * the muzzle; minigun tracers are thinner (WEAPONS.minigun.tracerScale). On Low (bloom 'off') the HDR core is
   * hue-normalised (no clip to white) and an additive glow quad from textures.glow, stretched along the tracer
   * and turned to face the camera, stands in for bloom (GDD §16). The matrix maths is inlined: a 12-argument
   * helper call boxes every double argument per tracer (WPN-5).
   */
  _renderTracers() {
    const alpha = RT[RT_ALPHA];
    const mesh = this.tracers;
    const glow = this.tracerGlow;
    const q = this.ctx.quality;
    const params = q && q.params ? q.params : null;
    let cap = params && params.tracers >= 0 ? params.tracers : TRACER_CAP;
    if (cap > TRACER_CAP) cap = TRACER_CAP;
    const n = this._n < cap ? this._n : cap;
    const low = glow !== null && params !== null && params.bloom === 'off';
    if (n === 0) {
      if (mesh.visible) commitMesh(mesh, 0, true);
      if (glow !== null && glow.visible) commitMesh(glow, 0, true);
      return;
    }
    const m = mesh.instanceMatrix.array;
    const col = mesh.instanceColor.array;
    const gm = low ? glow.instanceMatrix.array : null;
    const gc = low ? glow.instanceColor.array : null;
    // camera backward axis (+Z of camera.matrixWorld; one frame of lag is invisible) for the Low glow quads
    let cbx = 0, cby = 0, cbz = 1, crx = 1, cry = 0, crz = 0;
    if (low) {
      const render = this.ctx.render;
      const cam = render && render.camera ? render.camera : null;
      if (cam !== null && cam.matrixWorld) {
        const e = cam.matrixWorld.elements;
        crx = e[0]; cry = e[1]; crz = e[2];
        cbx = e[8]; cby = e[9]; cbz = e[10];
      }
    }
    const ext = alpha * STEP;
    const thick = this._boosterLeft > 0 ? BOOSTER_TRACER_SCALE : 1;
    const rifle = this._chipLeft > 0 ? C_CHIP : C_RIFLE;          // GDD §8.2: the chip tints tracers cyan
    TR_COL[0] = rifle[0]; TR_COL[1] = rifle[1]; TR_COL[2] = rifle[2];
    TR_COL[3] = C_SHOTGUN[0]; TR_COL[4] = C_SHOTGUN[1]; TR_COL[5] = C_SHOTGUN[2];
    TR_COL[6] = C_MINIGUN[0]; TR_COL[7] = C_MINIGUN[1]; TR_COL[8] = C_MINIGUN[2];
    TR_COL[9] = C_DRONE[0]; TR_COL[10] = C_DRONE[1]; TR_COL[11] = C_DRONE[2];
    TR_SCALE[K_RIFLE] = thick; TR_SCALE[K_SHOTGUN] = thick; TR_SCALE[K_MINIGUN] = thick * MINIGUN_TRACER_SCALE; TR_SCALE[K_DRONE] = thick;
    const invBase = 1 / this._tracerLen;
    const yMin = FIRE.bullet.y;
    const yMax = BOSS_TRACER_Y_MAX;
    const tracerLen = FIRE.tracerLength;
    const glowK = TRACER_GLOW_GAIN * LOW_GLOW_NORM;
    const bx = this._bx, by = this._by, bz = this._bz, bdx = this._bdx, bdz = this._bdz, bvy = this._bvy;
    const bspd = this._bspd, bage = this._bage, bkind = this._bkind;
    for (let i = 0; i < n; i++) {
      const spd = bspd[i];
      const dx = bdx[i], dz = bdz[i], vy = bvy[i];
      const hx = bx[i] + dx * spd * ext;
      const hz = bz[i] + dz * spd * ext;
      let hy = by[i] + vy * ext;
      if (hy < yMin) hy = yMin;                                      // both compares run for every tracer (no
      else if (hy > yMax) hy = yMax;                                 // feedback-less branch; see TR_COL)
      let L = tracerLen;
      const travelled = (bage[i] + ext) * spd;
      if (travelled < L) L = travelled > 0.05 ? travelled : 0.05;      // never poke out behind the muzzle
      const fy = spd > 0 ? vy / spd : 0;
      let fl = Math.sqrt(dx * dx + fy * fy + dz * dz);
      if (!(fl > EPS)) fl = 1;
      const ux = dx / fl, uy = fy / fl, uz = dz / fl;
      const h = L * 0.5;
      const cx = hx - ux * h, cy = hy - uy * h, cz = hz - uz * h;    // tracer centre
      const k = bkind[i];
      const s = TR_SCALE[k];
      // TRS with local −Z along u, no roll (same basis as writeDirMatrix): z = −u, x = normalize(up × z), y = z × x
      const zx = -ux, zy = -uy, zz = -uz;
      let xx = zz, xz = -zx;
      let xl = Math.sqrt(xx * xx + xz * xz);
      if (xl < EPS) { xx = 1; xz = 0; xl = 1; }
      xx /= xl; xz /= xl;
      const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;
      const sz = L * invBase;
      const o = i * 16;
      m[o] = xx * s; m[o + 1] = 0; m[o + 2] = xz * s; m[o + 3] = 0;
      m[o + 4] = yx * s; m[o + 5] = yy * s; m[o + 6] = yz * s; m[o + 7] = 0;
      m[o + 8] = zx * sz; m[o + 9] = zy * sz; m[o + 10] = zz * sz; m[o + 11] = 0;
      m[o + 12] = cx; m[o + 13] = cy; m[o + 14] = cz; m[o + 15] = 1;
      const kc = k * 3;
      const r = TR_COL[kc], g = TR_COL[kc + 1], b = TR_COL[kc + 2];
      const o3 = i * 3;
      if (!low) {
        col[o3] = r; col[o3 + 1] = g; col[o3 + 2] = b;
        continue;
      }
      // Low: no tone mapping on toneMapped:false materials, so an HDR triplet clips to white — keep its hue
      let mx = r > g ? r : g;
      if (b > mx) mx = b;
      const inv = mx > 1 ? 1 / mx : 1;
      col[o3] = r * inv; col[o3 + 1] = g * inv; col[o3 + 2] = b * inv;
      // glow quad (PlaneGeometry in XY): Y along u (length), X = normalize(u × camBack) (width), Z = X × Y
      let wx = uy * cbz - uz * cby, wy = uz * cbx - ux * cbz, wz = ux * cby - uy * cbx;
      let wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (wl < EPS) { wx = crx; wy = cry; wz = crz; wl = 1; }
      wx /= wl; wy /= wl; wz /= wl;
      const nx = wy * uz - wz * uy, ny = wz * ux - wx * uz, nz = wx * uy - wy * ux;
      const gw = TRACER_GLOW_W * s, gl = L * TRACER_GLOW_LEN;
      gm[o] = wx * gw; gm[o + 1] = wy * gw; gm[o + 2] = wz * gw; gm[o + 3] = 0;
      gm[o + 4] = ux * gl; gm[o + 5] = uy * gl; gm[o + 6] = uz * gl; gm[o + 7] = 0;
      gm[o + 8] = nx; gm[o + 9] = ny; gm[o + 10] = nz; gm[o + 11] = 0;
      gm[o + 12] = cx; gm[o + 13] = cy; gm[o + 14] = cz; gm[o + 15] = 1;
      gc[o3] = r * glowK; gc[o3 + 1] = g * glowK; gc[o3 + 2] = b * glowK;
    }
    commitMesh(mesh, n, true);
    if (low) commitMesh(glow, n, true);
    else if (glow !== null && glow.visible) commitMesh(glow, 0, true);
  }

  /** Muzzle flashes: camera-facing additive quads, frame 0 → 1 over FIRE.muzzleFlash.ms, fading out. */
  _renderMuzzles() {
    const tNow = RT[RT_TNOW];
    const mesh = this.muzzles;
    const render = this.ctx.render;
    const cam = render && render.camera ? render.camera : null;
    let rx = 1, ry = 0, rz = 0, ux = 0, uy = 1, uz = 0, fx = 0, fy = 0, fz = 1;
    if (cam !== null && cam.matrixWorld) {
      const e = cam.matrixWorld.elements;                               // camera basis (last frame's, one frame of lag is invisible)
      rx = e[0]; ry = e[1]; rz = e[2];
      ux = e[4]; uy = e[5]; uz = e[6];
      fx = e[8]; fy = e[9]; fz = e[10];
    }
    const m = mesh.instanceMatrix.array;
    const col = mesh.instanceColor.array;
    const frame = this._muzzleFrame.array;
    const rgb = this._muzzleRGB;
    const frames = MUZZLE_FRAMES > 0 ? MUZZLE_FRAMES : 1;
    let c = 0;
    for (let i = 0; i < MUZZLE_POOL; i++) {
      const age = tNow - this._mBirth[i];
      if (age < 0 || age >= MUZZLE_LIFE) continue;
      const u = age / MUZZLE_LIFE;
      const s = this._mScale[i] * (1 + 0.25 * u);                  // slight bloom-out while fading
      const fade = 1 - u;
      const roll = this._mRoll[i];
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const o = c * 16;
      m[o] = (cr * rx + sr * ux) * s; m[o + 1] = (cr * ry + sr * uy) * s; m[o + 2] = (cr * rz + sr * uz) * s; m[o + 3] = 0;
      m[o + 4] = (cr * ux - sr * rx) * s; m[o + 5] = (cr * uy - sr * ry) * s; m[o + 6] = (cr * uz - sr * rz) * s; m[o + 7] = 0;
      m[o + 8] = fx * s; m[o + 9] = fy * s; m[o + 10] = fz * s; m[o + 11] = 0;
      m[o + 12] = this._mx[i]; m[o + 13] = this._my[i]; m[o + 14] = this._mz[i]; m[o + 15] = 1;
      let f = Math.floor(u * frames);
      if (f >= frames) f = frames - 1;
      frame[c] = f;
      const o3 = c * 3;
      col[o3] = rgb[0] * fade; col[o3 + 1] = rgb[1] * fade; col[o3 + 2] = rgb[2] * fade;
      c++;
    }
    if (c === 0 && !mesh.visible) return;
    commitMesh(mesh, c, true);
    if (c > 0) markUpdate(this._muzzleFrame, c);
  }

  /** Rockets (rolling about their flight axis) + flickering exhaust cones. */
  _renderRockets() {
    const alpha = RT[RT_ALPHA];
    const n = this._rn;
    if (n === 0) {
      if (this.rockets.visible) commitMesh(this.rockets, 0, false);
      if (this.flames.visible) commitMesh(this.flames, 0, true);
      return;
    }
    const rm = this.rockets.instanceMatrix.array;
    const fm = this.flames.instanceMatrix.array;
    const fc = this.flames.instanceColor.array;
    const rgb = this._flameRGB;
    const ext = alpha * STEP * WEAPONS.rocket.speed;
    for (let r = 0; r < n; r++) {
      const dx = this._rdx[r], dz = this._rdz[r];
      const px = this._rx[r] + dx * ext, py = this._ry[r], pz = this._rz[r] + dz * ext;
      const roll = this._rroll[r] + ROCKET_SPIN * alpha * STEP;
      MI[MI_FX] = dx; MI[MI_FY] = 0; MI[MI_FZ] = dz; MI[MI_ROLL] = roll;
      MI[MI_SX] = ROCKET_MESH_SCALE; MI[MI_SY] = ROCKET_MESH_SCALE; MI[MI_SZ] = ROCKET_MESH_SCALE;
      MI[MI_PX] = px; MI[MI_PY] = py; MI[MI_PZ] = pz;
      writeDirMatrix(rm, r * 16);
      const fl = 0.75 + 0.5 * flick();
      MI[MI_ROLL] = 0;
      MI[MI_SX] = ROCKET_FLAME_R * fl; MI[MI_SY] = ROCKET_FLAME_R * fl; MI[MI_SZ] = ROCKET_FLAME_LEN * fl;
      MI[MI_PX] = px - dx * ROCKET_TAIL; MI[MI_PZ] = pz - dz * ROCKET_TAIL;
      writeDirMatrix(fm, r * 16);
      const o = r * 3;
      fc[o] = rgb[0] * fl; fc[o + 1] = rgb[1] * fl; fc[o + 2] = rgb[2] * fl;
    }
    commitMesh(this.rockets, n, false);
    commitMesh(this.flames, n, true);
  }

  /** Laser beams: HDR core + flickering additive halo, from the muzzles to the fog (or the boss core). */
  _renderLaser() {
    const n = this._w === W_LASER ? this._beams : 0;
    if (n === 0) {
      if (this.beams.visible) commitMesh(this.beams, 0, false);
      if (this.beamGlow.visible) commitMesh(this.beamGlow, 0, true);
      return;
    }
    const cm = this.beams.instanceMatrix.array;
    const gm = this.beamGlow.instanceMatrix.array;
    const gc = this.beamGlow.instanceColor.array;
    const rgb = this._laserGlowRGB;
    const q = this.ctx.quality;
    const gain = q && q.params && q.params.bloom === 'off' ? LASER_GLOW_GAIN_LOW : LASER_GLOW_GAIN_BLOOM;
    for (let b = 0; b < n; b++) {
      const f1 = 1 + (flick() * 2 - 1) * LASER_FLICKER;
      const f2 = 1 + (flick() * 2 - 1) * LASER_FLICKER;
      const ox = this._lox[b], oy = this._loy[b], oz = this._loz[b];
      const dx = this._ldx[b], dy = this._ldy[b], dz = this._ldz[b], len = this._llen[b];
      MI[MI_FX] = dx; MI[MI_FY] = dy; MI[MI_FZ] = dz; MI[MI_ROLL] = 0;
      MI[MI_SX] = LASER_CORE_R * f1; MI[MI_SY] = LASER_CORE_R * f1; MI[MI_SZ] = len;
      MI[MI_PX] = ox; MI[MI_PY] = oy; MI[MI_PZ] = oz;
      writeDirMatrix(cm, b * 16);
      MI[MI_SX] = LASER_GLOW_R * f2; MI[MI_SY] = LASER_GLOW_R * f2;
      writeDirMatrix(gm, b * 16);
      const o = b * 3;
      const g = (0.75 + 0.25 * f2) * gain;
      gc[o] = rgb[0] * g; gc[o + 1] = rgb[1] * g; gc[o + 2] = rgb[2] * g;
    }
    commitMesh(this.beams, n, false);
    commitMesh(this.beamGlow, n, true);
  }

  /** Rail bolt: a thinning HDR core along the lane + a crackling lightning polyline, fading over RAIL_SHOW. */
  _renderRail() {
    const core = this.railCore;
    const arcs = this.railArcs;
    if (!this._railOn) return;                                       // hidden since the last expiry (or reset / _hideAll)
    if (this._railT >= RAIL_SHOW) {
      if (core.visible) core.visible = false;
      if (arcs.visible) commitMesh(arcs, 0, true);
      this._railOn = false;
      return;
    }
    const fade = 1 - this._railT / RAIL_SHOW;
    const x = this._railX, y = this._railY, z0 = this._railZ0, z1 = this._railZ1;
    const len = z0 - z1;
    MI[MI_FX] = 0; MI[MI_FY] = 0; MI[MI_FZ] = -1; MI[MI_ROLL] = 0;
    MI[MI_SX] = RAIL_CORE_R * fade; MI[MI_SY] = RAIL_CORE_R * fade; MI[MI_SZ] = len;
    MI[MI_PX] = x; MI[MI_PY] = y; MI[MI_PZ] = z0;
    writeDirMatrix(core.matrix.elements, 0);
    core.matrixWorldNeedsUpdate = true;
    core.visible = true;
    const am = arcs.instanceMatrix.array;
    const ac = arcs.instanceColor.array;
    const rgb = this._railArcRGB;
    const pts = this._railPts;
    const g = fade * fade;
    const thick = RAIL_ARC_THICK * (0.5 + 0.5 * fade);
    for (let i = 0; i < RAIL_SEGMENTS; i++) {
      const ax = x + pts[i * 2], ay = y + pts[i * 2 + 1], az = z0 - len * (i / RAIL_SEGMENTS);
      const bx2 = x + pts[i * 2 + 2], by2 = y + pts[i * 2 + 3], bz2 = z0 - len * ((i + 1) / RAIL_SEGMENTS);
      const dx = bx2 - ax, dy = by2 - ay, dz = bz2 - az;
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      MI[MI_FX] = dx / l; MI[MI_FY] = dy / l; MI[MI_FZ] = dz / l; MI[MI_ROLL] = 0;
      MI[MI_SX] = thick; MI[MI_SY] = thick; MI[MI_SZ] = l;
      MI[MI_PX] = ax; MI[MI_PY] = ay; MI[MI_PZ] = az;
      writeDirMatrix(am, i * 16);
      const o = i * 3;
      ac[o] = rgb[0] * g; ac[o + 1] = rgb[1] * g; ac[o + 2] = rgb[2] * g;
    }
    commitMesh(arcs, RAIL_SEGMENTS, true);
  }
}
