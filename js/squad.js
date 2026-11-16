// js/squad.js — GATE RUSH: the Squad system (ARCHITECTURE §6.5; GDD §3, §4.3, §6.1 bite rules).
//
// Owns the logical soldier count C, the hex-lattice formation slot table, the soldier
// CharacterInstances (capacity SQUAD.slotCapacity = 300), steering smoothing + the gate commit clamp,
// the spawn / death / dissolve animations, invulnerability and armour plates.
// It does NOT own the count label (fx, §6.12 — squad only calls fx.label.setWorldPos) nor the lane
// highlight decal (gates, §6.9 / D4).
//
// Reads:  ctx.input.targetX (ONLY — engine integrates the drag, D2), ctx.quality.params.vmax / .shadows,
//         ctx.world.roadSpeed / .distance, ctx.profile.startSquad, ctx.rngFx (cosmetic rolls),
//         ctx.render.uniforms.uTime (hit / recoil time stamps), ctx.time.dt (coasting animations),
//         ctx.state (complete / gameover coasting), ctx.run.length (squad:dead fraction).
// Writes: ctx.world.squadX / squadHalfWidth / squadDepth / squadCount / invulnerable.
// Emits:  squad:count, squad:spawn, squad:loss, squad:dead, squad:invuln, armor:change (§5.1).
// Listens: gear:start / gear:end (gear.magnet), armor:change, level:start — ONLY to drive the soldier
//          material's gear glows through models.setGearGlow (GDD §8.2 "helmet rings glow purple" /
//          "blue shoulder glint"; CHR-2). vmax is read from ctx.quality.params every step, so a tier change
//          re-settles the formation within one step without a subscription.
//
// Data model (all pools allocated once in init(), §14 rule 3):
//   • slot table: `_slotX/_slotZ` (300 lattice points sorted by elliptical norm), `_frontOffset[n]`
//     (min z among the first n slots → the front row of an n-formation sits at z = 0),
//     `_halfWidthAt[n]`, `_depthAt[n]`, `_zOrder` (slots by z ascending → front-most shooters).
//   • soldier records 0..299 (one per rendered soldier, one CharacterInstances instance each):
//     state FREE / ALIVE (in a slot) / DYING (toppling in world space, drifting with the road) /
//     DISSOLVE (gate loss: queued rim-inward, then shrinks + sinks in place);
//     `_rx/_rz` formation-local position for ALIVE / DISSOLVE, world position for DYING.
//   • `_slotRec[slot]` → record or −1; `_instRec[inst]` → record (kept dense through onMove).
//
// 1.4.0 logical formation (D5): every tier plays on the first L = min(C, CAP) slots (width, depth, contact box, the 40
// shooters and muzzles); records only draw — slots [0, L) when V = min(C, vmax) ≥ L, else _syncWant's subset.
// Reconciliation (`_settle`): records occupy exactly the drawn set. Displaced records move to the nearest vacancy, or
// dissolve rim-first when there is none (gate losses, vmax drops); remaining vacancies are filled by reserve soldiers
// stepping up from the rear (hidden soldiers when C > vmax, vmax raises). Deaths settle after SQUAD.reflowDelay so a
// toppling soldier leaves a legible hole; everything else settles at once.
//
// 1.4.0 hook (ARCH §3): setFormation('wall') swaps in the SQUAD.formations.wall slot table for every query; its anchor
// (front-row z, firing step) lives in _s, 0 for 'run'. 1.5.0: setFormation('chase') = the run's, the back rows
// turned round as the REAR GUARD (cosmetic).
//
// Matrices: squad composes its own TRS (yaw, pitch = topple, roll = steering lean, scale) straight
// into `instances.mesh.instanceMatrix.array` (the standard InstancedMesh layout, 16 floats per
// instance; commit() uploads it) because CharacterInstances.writeMatrix has no roll parameter and
// GDD §3.1 asks for a 6° roll into lateral movement. Characters face −Z with feet at y = 0 (models.js).

import { SQUAD, WORLD, FIRE, GEAR, RENDER, QUALITY_TIERS, UPGRADES, CHASE } from './data.js';
import { clamp, lerpExp, ease, warnOnce } from './util.js';
import { CharacterInstances } from './models.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const STEP = WORLD.step;                        // fixed simulation step (render clock = _t + alpha·STEP)
const CAP = SQUAD.slotCapacity;                 // 300 slots = 300 records = 300 instances
const HALF_PI = Math.PI / 2;                    // topple end angle (flat on the ground)
const DEG2RAD = Math.PI / 180;
const DEATH_TOTAL = SQUAD.death.topple + SQUAD.death.sink;   // death01 window (models.js: sinceDeath / (topple + sink))
const DISSOLVE_WINDOW = 0.1;                    // the "100 ms" window named by SQUAD.dissolvePer100ms (s)

// DATA-MISSING constants (candidates for data.js; listed in the module report)
const DISSOLVE_SECONDS = SQUAD.dissolveAnim.time;                    // one soldier's shrink + sink for a gate loss (= SQUAD.death.sink) (data key; wired round-2 cross-group)
const SPAWN_RISE_FRACTION = SQUAD.spawnAnim.riseFraction;                 // share of spawnAnim.time spent growing 0 → overshoot (data key; wired round-2 cross-group)
const TINT_JITTER = SQUAD.tintJitter;                        // ± per-soldier uniform brightness jitter (fraction) (data key; wired round-2 cross-group)
const YAW_JITTER = SQUAD.yawJitter;                         // ± per-soldier facing jitter while marching (rad) (data key; wired round-2 cross-group)
const BURST_JITTER = SQUAD.slotSpacing;         // spawn-burst footprint jitter = one lattice spacing (m)
const EDGE_MAX = 10;                            // A13a: row ends drawn per side when V < L
const WALL = SQUAD.formations.wall;             // 1.4.0
const FORM_RUN = 0, FORM_WALL = 1;
const REAR_EASE_S = 0.4;                        // 1.5.0: the rear guard turns round over this (s)

// Record states
const REC_FREE = 0;
const REC_ALIVE = 1;
const REC_DYING = 2;
const REC_DISSOLVE = 3;

// ---------------------------------------------------------------------------------------------
// Module-level scratch (never retained across calls, §14 rule 2) and reused event payloads
// (listeners must not retain them, §5)
// ---------------------------------------------------------------------------------------------

const _tmpVacant = new Int32Array(CAP);
const _tmpDisplaced = new Int32Array(CAP);
const _edgeL = new Int32Array(CAP), _edgeR = new Int32Array(CAP);   // _syncWant row ends
// CHR-13: indices into Squad._s (the per-step scalars): simulation clock, squadX, lateral velocity, lean roll,
// invulnerability left, committed lane x, render coast clock, next reconciliation time; 1.4.0: front-row z, firing step
// (height now / from / to, back edge z), formation ease (start, seconds; 0 = none)
const S_T = 0, S_X = 1, S_VX = 2, S_ROLL = 3, S_INV = 4, S_LANE_X = 5, S_COAST = 6, S_SETTLE_AT = 7;
const S_AZ = 8, S_SY = 9, S_SY0 = 10, S_SY1 = 11, S_SZ = 12, S_FT0 = 13, S_FDUR = 14, S_COUNT = 15;
const _tmpFree = new Int32Array(CAP);             // records step() frees after stepCore (CHR-13)

const _evCount = { count: 0, prev: 0, delta: 0, reason: 'start' };
const _evSpawn = { count: 0, x: -0, z: -0 };   // x / z seeded as Doubles (round-2 cross-group: these maps are shared with other modules' { count, x, z, … } payloads)
const _evLoss = { count: 0, x: -0, z: -0, cause: 'bite' };
const _evDead = { distance: 0, fraction: 0 };
const _evInvuln = { on: false };
const _evArmor = { plates: 0, delta: 0 };
const _gateResult = { before: 0, after: 0 };   // returned by applyGate (reused; callers copy)

// ---------------------------------------------------------------------------------------------
// Hot per-soldier passes (CHR-13). Module functions over typed arrays and numbers only: no ctx / fx / THREE objects,
// so a deoptimisation of step() / render() triggered by a dependency elsewhere (a label or prototype change) never
// drops these 300-iteration loops back to unoptimised code, where every double temporary is a heap allocation.
// ---------------------------------------------------------------------------------------------

/** Spawn scale 0 -> overshoot (1.15) -> 1 over SQUAD.spawnAnim.time; u = seconds since the spawn started. */
function spawnScale(u) {
  const t = u / SQUAD.spawnAnim.time;
  const ov = SQUAD.spawnAnim.overshoot;
  if (t < SPAWN_RISE_FRACTION) return ov * ease.outQuad(t / SPAWN_RISE_FRACTION);
  const s = (t - SPAWN_RISE_FRACTION) / (1 - SPAWN_RISE_FRACTION);
  return 1 + (ov - 1) * (1 - s * s * (3 - 2 * s));
}

const STEP_FREE_MASK = 0xffff;                    // stepCore result: low 16 bits = records written to freeOut
const STEP_INVULN_ENDED = 0x10000;                 //   the invulnerability window ran out this step (emit squad:invuln off)
const STEP_SETTLE_DUE = 0x20000;                   //   a requested reconciliation is due (call _settle)

/**
 * Squad.step body for the logical count L: GDD §3.2 steering (lerpExp toward targetX, lane lock, speed cap, lean roll),
 * the invulnerability countdown, record motion (ALIVE soldiers lerp to their slot, corpses drift with the road; finished
 * corpses / dissolves are written to freeOut) and the ctx.world mirrors (w). The scalars live in s (S_*).
 * Returns the number written to freeOut | STEP_INVULN_ENDED | STEP_SETTLE_DUE; the caller applies those.
 */
function stepCore(s, dt, targetX, laneLocked, roadSpeed, settlePending, L, count, frontOffset, halfWidthAt, depthAt, w,
  list, n, rState, rSlot, rx, rz, rSpawnT, rDeathT, slotX, slotZ, freeOut, rFx, rFz) {
  const t = s[S_T] + dt;
  s[S_T] = t;

  // --- steering (GDD §3.2): engine integrated the drag into input.targetX; squad only smooths it.
  let target = clamp(targetX, -WORLD.steerRange, WORLD.steerRange);
  if (laneLocked) {
    // committed to a lane: target clamped to the lane centre +- laneLockHalfWidth (raw targetX untouched),
    // then to the steer range (triple outer lanes at +-2.7 sit beyond +-2.1 -> the squad holds at the range edge)
    const lx = s[S_LANE_X];
    target = clamp(target, lx - SQUAD.steer.laneLockHalfWidth, lx + SQUAD.steer.laneLockHalfWidth);
    target = clamp(target, -WORLD.steerRange, WORLD.steerRange);
  }
  const x0 = s[S_X];
  const maxD = SQUAD.steer.maxSpeed * dt;
  let d = lerpExp(x0, target, SQUAD.steer.smoothRate, dt) - x0;
  if (d > maxD) d = maxD; else if (d < -maxD) d = -maxD;
  const x = x0 + d;
  s[S_X] = x;
  const vx = dt > 0 ? d / dt : 0;
  s[S_VX] = vx;
  // lean: roll into lateral movement, SQUAD.steer.leanDeg at full lateral speed (negative roll tips the head toward +X)
  const leanTarget = -clamp(vx / SQUAD.steer.maxSpeed, -1, 1) * SQUAD.steer.leanDeg * DEG2RAD;
  s[S_ROLL] = lerpExp(s[S_ROLL], leanTarget, SQUAD.steer.smoothRate, dt);

  // --- invulnerability countdown (Infinity stays until reset)
  let flags = 0;
  let inv = s[S_INV];
  if (inv > 0) {
    inv -= dt;
    if (inv <= 0) { inv = 0; flags |= STEP_INVULN_ENDED; }
    s[S_INV] = inv;
  }
  const due = t >= s[S_SETTLE_AT];                          // read unconditionally (no first-use deopt when a settle is pending)
  if (settlePending && due) flags |= STEP_SETTLE_DUE;

  // --- record motion (1.4.0: a formation ease moves each soldier from rFx / rFz to its slot by smoothstep ek, the step too)
  const fo = frontOffset[L];
  const az = s[S_AZ];
  const k = 1 - Math.exp(-SQUAD.slotLerpRate * dt);          // soldier -> slot lerp 1 - exp(-8*dt)
  const roadDz = roadSpeed * dt;                              // corpses are left behind at road speed
  const fd = s[S_FDUR];
  let ek = -1;
  if (fd > 0) {
    const u = (t - s[S_FT0]) / fd;
    if (u < 1) ek = u > 0 ? u * u * (3 - 2 * u) : 0;
    else s[S_FDUR] = 0;
  }
  s[S_SY] = ek < 0 ? s[S_SY1] : s[S_SY0] + (s[S_SY1] - s[S_SY0]) * ek;
  let nFree = 0;
  for (let i = 0; i < n; i++) {
    const rec = list[i];
    const st = rState[rec];
    if (st === REC_ALIVE) {
      if (t >= rSpawnT[rec]) {
        const sl = rSlot[rec];
        if (ek < 0) {
          rx[rec] += (slotX[sl] - rx[rec]) * k;
          rz[rec] += (slotZ[sl] - fo + az - rz[rec]) * k;
        } else {
          rx[rec] = rFx[rec] + (slotX[sl] - rFx[rec]) * ek;
          rz[rec] = rFz[rec] + (slotZ[sl] - fo + az - rFz[rec]) * ek;
        }
      }
    } else if (st === REC_DYING) {
      rz[rec] += roadDz;
      if (t - rDeathT[rec] >= SQUAD.death.free) freeOut[nFree++] = rec;
    } else if (st === REC_DISSOLVE) {
      if (t >= rDeathT[rec] + DISSOLVE_SECONDS) freeOut[nFree++] = rec;
    }
  }

  // --- shared state mirrors (the only ctx.world fields squad writes)
  w.squadX = x;
  w.squadHalfWidth = halfWidthAt[L];
  w.squadDepth = depthAt[L];
  w.squadCount = count;
  w.invulnerable = inv > 0;
  return nFree | flags;
}

/**
 * render() instance pass (render clock tR = t + alpha·STEP + coast, from s): spawn scale / topple / dissolve per record, the iState.x death progress (stateArr, 4 floats per
 * instance) and the instance TRS straight into the instanceMatrix array (ma): Ry(yaw)·Rx(pitch)·Rz(roll)·S, column-major,
 * = Matrix4.compose of an 'YXZ' Euler (verified by docs/build/qa2/fix-characters/matcheck.mjs). Characters face −Z with
 * feet at the origin: +pitch topples the head toward the body's back (+Z), +roll tips it toward −X.
 */
function writeInstances(s, alpha, list, n, rState, rInst, rx, rz, rs, rYaw, rSpawnT, rDeathT, ma, stateArr, rearZ, rearYaw) {
  const tR = s[S_T] + alpha * STEP + s[S_COAST];            // render clock (coasts in complete / gameover)
  const sx = s[S_X], roll = s[S_ROLL];
  const stepH = s[S_SY], stepZ = s[S_SZ];                    // 1.4.0: z ≤ stepZ stands on the firing step
  const spawnTime = SQUAD.spawnAnim.time;
  const topple = SQUAD.death.topple;
  for (let i = 0; i < n; i++) {
    const rec = list[i];
    const ii = rInst[rec];
    const state = rState[rec];
    let wx = 0, wz = 0, scale = 1, pitch = 0, r = roll;
    if (state === REC_ALIVE) {
      wx = sx + rx[rec]; wz = rz[rec];
      const u = tR - rSpawnT[rec];
      scale = u <= 0 ? 0 : (u >= spawnTime ? 1 : spawnScale(u));
    } else if (state === REC_DYING) {
      wx = rx[rec]; wz = rz[rec];                                // world coords, drifting with the road
      const u = tR - rDeathT[rec];
      const p = u >= topple ? 1 : (u <= 0 ? 0 : u / topple);
      pitch = ease.outBack(p) * HALF_PI;                         // ease-out-back topple about the foot pivot
      stateArr[ii * 4] = u <= 0 ? 0 : (u >= DEATH_TOTAL ? 1 : u / DEATH_TOTAL);   // shader sinks past the topple fraction + darkens
      r = 0;
    } else {                                                     // REC_DISSOLVE (gate loss, rim-inward queue)
      wx = sx + rx[rec]; wz = rz[rec];
      const u = tR - rDeathT[rec];
      if (u > 0) {
        const q = u >= DISSOLVE_SECONDS ? 1 : u / DISSOLVE_SECONDS;
        scale = 1 - ease.outQuad(q);
        stateArr[ii * 4] = q;
        r = 0;
      }
    }
    rs[rec] = scale;
    const yaw = rYaw[rec] + (state === REC_ALIVE && wz >= rearZ ? rearYaw : 0);   // 1.5.0: the rear guard faces the horde
    const ca = Math.cos(pitch), sa = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw), cr = Math.cos(r), sr = Math.sin(r);
    const cyr = cy * cr, cysr = cy * sr, sycr = sy * cr, sysr = sy * sr;
    const o = ii * 16;
    ma[o] = (cyr + sysr * sa) * scale; ma[o + 1] = ca * sr * scale; ma[o + 2] = (cysr * sa - sycr) * scale; ma[o + 3] = 0;
    ma[o + 4] = (sycr * sa - cysr) * scale; ma[o + 5] = ca * cr * scale; ma[o + 6] = (sysr + cyr * sa) * scale; ma[o + 7] = 0;
    ma[o + 8] = ca * sy * scale; ma[o + 9] = -sa * scale; ma[o + 10] = ca * cy * scale; ma[o + 11] = 0;
    ma[o + 12] = wx; ma[o + 13] = stepH > 0 && wz <= stepZ ? stepH : 0; ma[o + 14] = wz; ma[o + 15] = 1;
  }
}

/** Draws ≤ e of the n row ends in list (front to back): the outer column (sign·x ≥ lim) first, then the rest, by stride. */
function pickEnds(list, n, x, lim, sign, e, want) {
  let k = 0;
  for (let i = 0; i < n; i++) if (sign * x[list[i]] >= lim) k++;
  const a = k < e ? k : e, b = e - a < n - k ? e - a : n - k;
  for (let i = 0, c = 0, d = 0, ja = 0, jb = 0; i < n; i++) {
    const s = list[i];
    if (sign * x[s] >= lim) { if (ja < a && c++ === Math.floor((ja + 0.5) * k / a)) { want[s] = 1; ja++; } }
    else if (jb < b && d++ === Math.floor((jb + 0.5) * (n - k) / b)) { want[s] = 1; jb++; }
  }
  return a + b;
}

/** Slot draw priority: zo (slots by z) in bit-reversed index order, so any prefix spreads over the rows. Init only. */
function bitReversed(zo) {
  const bits = Math.ceil(Math.log2(CAP)), pr = new Int16Array(CAP);
  for (let i = 0, n = 0; i < 1 << bits; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    if (r < CAP) pr[n++] = zo[r];
  }
  return pr;
}

/**
 * Boot-time JIT feedback warm-up (CHR-13): runs stepCore / writeInstances over a small synthetic formation that visits
 * every branch (alive / spawning / dying / dissolving records, lane lock, invulnerability expiry, pending settle), so the
 * optimised code that V8 later builds already covers them. Without it each branch first taken in play (the first death,
 * the first gate lock …) deoptimised the pass, and the hot loop ran unoptimised — boxing every double — until it
 * re-optimised. The world mirrors written into w are restored afterwards. Init only (allocates).
 */
function warmHotPaths(w) {
  const N = 12;
  const s = new Float64Array(S_COUNT);
  const list = new Int32Array(N), rSlot = new Int32Array(N), rInst = new Int32Array(N), freeOut = new Int32Array(N);
  const rState = new Uint8Array(N);
  const rx = new Float32Array(N), rz = new Float32Array(N), rs = new Float32Array(N), rYaw = new Float32Array(N);
  const rSpawnT = new Float32Array(N), rDeathT = new Float32Array(N), slotX = new Float32Array(N), slotZ = new Float32Array(N);
  const fo = new Float32Array(N + 1), hw = new Float32Array(N + 1), dp = new Float32Array(N + 1);
  const rFx = new Float32Array(N), rFz = new Float32Array(N);
  const ma = new Float32Array(N * 16), stateArr = new Float32Array(N * 4);
  const saved = w ? [w.squadX, w.squadHalfWidth, w.squadDepth, w.squadCount, w.invulnerable] : null;
  const ww = w || { squadX: 0, squadHalfWidth: 0, squadDepth: 0, squadCount: 0, invulnerable: false };
  for (let it = 0; it < 240; it++) {
    for (let i = 0; i < N; i++) {
      list[i] = i; rInst[i] = i; rSlot[i] = i;
      rState[i] = i % 4 === 0 ? REC_DYING : (i % 4 === 1 ? REC_DISSOLVE : REC_ALIVE);
      rx[i] = (i - 6) * 0.3 + it * 1e-3; rz[i] = i * 0.29; rYaw[i] = 0.05 * (i - 6);
      slotX[i] = (i - 6) * 0.34; slotZ[i] = (i % 3) * 0.294;
      rSpawnT[i] = s[S_T] + ((i + it) % 3 - 1) * SQUAD.spawnAnim.time * 0.5;          // before / during / after the pop
      rDeathT[i] = s[S_T] - ((i + it) % 5) * 0.4 + 0.1;                              // future, fresh and finished deaths
    }
    s[S_INV] = it % 7 === 0 ? 0.01 : (it % 7 === 1 ? 0 : 1);
    s[S_LANE_X] = (it % 3 - 1) * 1.8;
    s[S_SETTLE_AT] = s[S_T] + (it % 2 === 0 ? -0.01 : 0.5);
    s[S_COAST] = (it % 4) * 0.01;
    // 1.4.0: formation eases and the wall anchor / step get feedback too
    s[S_FDUR] = it % 3 === 0 ? 0 : WALL.easeS; s[S_FT0] = s[S_T] - (it % 5) * 0.4;
    s[S_AZ] = it % 2 === 0 ? 0 : WALL.frontZ; s[S_SY0] = 0; s[S_SY1] = it % 2 === 0 ? 0 : WALL.stepY; s[S_SZ] = WALL.stepBackZ;
    stepCore(s, WORLD.step, (it % 5 - 2) * 1.3, it % 2 === 0, 9.5 + it * 0.01, it % 3 !== 0, N - (it % 3), N - 1,
      fo, hw, dp, ww, list, N, rState, rSlot, rx, rz, rSpawnT, rDeathT, slotX, slotZ, freeOut, rFx, rFz);
    writeInstances(s, (it % 10) * 0.1, list, N, rState, rInst, rx, rz, rs, rYaw, rSpawnT, rDeathT, ma, stateArr, it % 2 === 0 ? 1e9 : 1.2, Math.PI * (it % 3) / 2);
  }
  if (saved) {
    w.squadX = saved[0]; w.squadHalfWidth = saved[1]; w.squadDepth = saved[2]; w.squadCount = saved[3]; w.invulnerable = saved[4];
  }
}

// ---------------------------------------------------------------------------------------------
// Squad
// ---------------------------------------------------------------------------------------------

export class Squad {
  constructor(ctx) {
    this._ctx = ctx;
    /** CHR-13: per-step scalars (S_T … S_SETTLE_AT), a Float64Array so the hot passes read / write them unboxed */
    this._s = new Float64Array(S_COUNT);

    /** @type {CharacterInstances|null} soldiers; shadows on (built in init) */
    this.instances = null;

    // logical / steering state
    this._count = 0;
    this._vmax = QUALITY_TIERS.high.vmax;
    this._laneLocked = false;                  // squadX, lateral velocity, roll, lane x and invulnerability live in _s
    this._plates = 0;
    // CHR-10: true from squad:dead until reset() (GDD §7 / §10: the count is final once the squad died — a gate or a
    // medic / assist addition never revives it; setCount (debug / QA hooks) still works and clears it when n > 0)
    this._dead = false;

    // clocks (scaled seconds, in _s): S_T advances in step(); S_COAST advances in render() while no steps run

    // reconciliation
    this._settlePending = false;               // due time: _s[S_SETTLE_AT]
    this._shooterCount = 0;
    this._blobCount = 0;

    // cached references (init)
    this._label = null;
    this._uTime = null;
    this._matArr = null;
    this._absorbs = null;
    this._blobFn = false;

    // gear feedback on the soldier material (CHR-2): magnet active / armour plates left
    this._magnetOn = false;
    this._gearGlowFn = false;
    this._unsub = null;

    // typed-array pools are allocated in init()
    this._slotX = null; this._slotZ = null; this._frontOffset = null; this._halfWidthAt = null; this._depthAt = null;
    this._zOrder = null; this._shooterSlots = null; this._slotRec = null;
    this._slotRow = null; this._prio = null; this._want = null; this._wantL = -1; this._wantV = -1; this._shooterL = -1;
    this._rx = null; this._rz = null; this._rs = null; this._rSpawnT = null; this._rDeathT = null;
    this._rYaw = null; this._rPhase = null; this._rTint = null; this._rRear = null;
    this._rearOn = false; this._rearN = 0; this._rearT0 = 0.5; this._rearT0 = 0;   // 1.5.0: the rear guard (setFormation('chase'))
    this._rState = null; this._rSlot = null; this._rInst = null; this._instRec = null;
    // 1.4.0: formation, the two slot tables (the active one's arrays are the _slot* fields), positions when an ease began
    this._form = FORM_RUN;
    this._run = null; this._wall = null;
    this._rFx = null; this._rFz = null;
    this._recList = null; this._recPos = null; this._recCount = 0;
    this._freeRec = null; this._freeCount = 0;
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------------

  init() {
    const ctx = this._ctx;

    this._buildSlotTable();
    this._run = this._tables();
    this._buildWallTable();
    this._useTables(this._run);
    this._s[S_SZ] = WALL.stepBackZ;

    // per-slot / per-record state (ARCH §6.5 "per-slot soldier state")
    this._slotRec = new Int32Array(CAP).fill(-1);
    this._want = new Uint8Array(CAP);
    this._shooterSlots = new Int32Array(FIRE.shooters);
    this._rx = new Float32Array(CAP);
    this._rz = new Float32Array(CAP);
    this._rs = new Float32Array(CAP);
    this._rSpawnT = new Float32Array(CAP);
    this._rDeathT = new Float32Array(CAP);
    this._rYaw = new Float32Array(CAP);
    this._rRear = new Uint8Array(CAP);   // 1.5.0: the record walks backward as the rear guard
    this._rPhase = new Float32Array(CAP);
    this._rTint = new Float32Array(CAP);
    this._rState = new Uint8Array(CAP);
    this._rSlot = new Int32Array(CAP).fill(-1);
    this._rInst = new Int32Array(CAP).fill(-1);
    this._instRec = new Int32Array(CAP).fill(-1);
    this._rFx = new Float32Array(CAP);
    this._rFz = new Float32Array(CAP);
    this._recList = new Int32Array(CAP);
    this._recPos = new Int32Array(CAP);
    this._freeRec = new Int32Array(CAP);
    this._resetRecordPool();

    // GPU objects: one InstancedMesh of 300 soldiers, shadows on (§9.1 / §9.3)
    this.instances = new CharacterInstances(ctx, 'soldier', CAP, { castShadow: true, receiveShadow: false });
    const mesh = this.instances.mesh;
    if (!mesh.material && ctx.models && typeof ctx.models.makeCharacterMaterial === 'function') {
      mesh.material = ctx.models.makeCharacterMaterial('soldier');
    }
    const scene = ctx.render ? ctx.render.scene : null;
    if (scene && mesh.parent !== scene) scene.add(mesh);
    this._matArr = mesh.instanceMatrix.array;
    const self = this;
    this.instances.onMove = function onMove(from, to) { self._onMove(from, to); };   // one closure, created at init

    this._uTime = ctx.render && ctx.render.uniforms ? ctx.render.uniforms.uTime : { value: 0 };
    this._label = ctx.fx && ctx.fx.label ? ctx.fx.label : null;
    this._blobFn = !!(ctx.render && typeof ctx.render.blobShadowSlot === 'function');
    this._vmax = ctx.quality && ctx.quality.params ? ctx.quality.params.vmax : QUALITY_TIERS.high.vmax;

    // reasons whose losses armour plates absorb 1:1 (GEAR.armor.absorbs = ['bite', 'spit'])
    const absorbs = {};
    for (let i = 0; i < GEAR.armor.absorbs.length; i++) absorbs[GEAR.armor.absorbs[i]] = true;
    this._absorbs = absorbs;

    // gear glows (CHR-2): listeners only store state and push two uniforms (allocation-free)
    this._gearGlowFn = !!(ctx.models && typeof ctx.models.setGearGlow === 'function');
    const ev = ctx.events;
    if (ev && typeof ev.on === 'function') {
      this._unsub = [
        ev.on('gear:start', (p) => { if (p && p.id === GEAR.magnet.id) { this._magnetOn = true; this._applyGearGlow(); } }),
        ev.on('gear:end', (p) => { if (p && p.id === GEAR.magnet.id) { this._magnetOn = false; this._applyGearGlow(); } }),
        ev.on('armor:change', () => { this._applyGearGlow(); }),
        ev.on('level:start', () => { this._magnetOn = false; this._applyGearGlow(); }),
      ];
    }
    this._applyGearGlow();

    warmHotPaths(ctx.world || null);   // CHR-13: JIT feedback for every hot-pass branch before play
    return this;
  }

  /** Pushes the magnet / armour glow state into the shared soldier material uniforms (CHR-2). */
  _applyGearGlow() {
    if (!this._gearGlowFn) return;
    this._ctx.models.setGearGlow(this._magnetOn ? 1 : 0, this._plates > 0 ? 1 : 0);
  }

  /** Level-start state: everything freed, count = profile.startSquad (emits squad:count 'start'). Idempotent. */
  reset() {
    const ctx = this._ctx;
    for (let i = this._recCount - 1; i >= 0; i--) this._freeRecord(this._recList[i]);
    this._slotRec.fill(-1);
    this._s[S_T] = 0;
    this._s[S_COAST] = 0;
    this._s[S_X] = 0;
    this._s[S_VX] = 0;
    this._s[S_ROLL] = 0;
    this._laneLocked = false;
    this._s[S_LANE_X] = 0;
    this._settlePending = false;
    this._s[S_SETTLE_AT] = 0;
    this._shooterCount = 0;
    this._shooterL = -1; this._wantL = -1;
    if (this._form !== FORM_RUN) { this._form = FORM_RUN; this._useTables(this._run); }   // 1.4.0
    this._setRear(false);                                         // 1.5.0
    this._s[S_AZ] = 0; this._s[S_SY] = 0; this._s[S_SY0] = 0; this._s[S_SY1] = 0; this._s[S_FDUR] = 0;
    if (this._s[S_INV] > 0) {
      this._s[S_INV] = 0;
      _evInvuln.on = false;
      ctx.events.emit('squad:invuln', _evInvuln);
    }
    if (this._plates > 0) {
      _evArmor.delta = -this._plates;
      this._plates = 0;
      _evArmor.plates = 0;
      ctx.events.emit('armor:change', _evArmor);
    }
    const w = ctx.world;
    if (w) { w.squadX = 0; w.squadHalfWidth = 0; w.squadDepth = 0; w.squadCount = 0; w.invulnerable = false; }
    if (ctx.quality && ctx.quality.params) this._vmax = ctx.quality.params.vmax;
    this._count = 0;
    this._dead = false;
    const start = ctx.profile ? ctx.profile.startSquad : UPGRADES.squad.effect(0);
    this.setCount(start, 'start');
  }

  /** Removes the mesh from the scene; geometry and material belong to ModelLibrary (shared, not disposed). */
  dispose() {
    const inst = this.instances;
    if (inst && inst.mesh) {
      const mesh = inst.mesh;
      if (mesh.parent) mesh.parent.remove(mesh);
      if (typeof inst.dispose === 'function') inst.dispose();
      else if (typeof mesh.dispose === 'function') mesh.dispose();
    }
    this._label = null;
    if (this._unsub !== null) { for (let i = 0; i < this._unsub.length; i++) this._unsub[i](); this._unsub = null; }
    this._magnetOn = false;
    this._applyGearGlow();
  }

  // ------------------------------------------------------------------------------------------
  // Slot table (GDD §3.1): hex lattice, |x| <= halfWidthCap, sorted by elliptical norm
  // ------------------------------------------------------------------------------------------

  _buildSlotTable() {
    const sp = SQUAD.slotSpacing, rp = SQUAD.rowPitch, off = SQUAD.rowOffset;
    const hw = SQUAD.halfWidthCap, ez = SQUAD.ellipseZ;
    const colsHalf = Math.ceil(hw / sp) + 1;                      // candidate columns per side
    const rowsHalf = Math.ceil(CAP / (2 * colsHalf) / 2) + 6;      // enough rows for > 2x CAP candidates
    const cx = [], cz = [], key = [];
    for (let r = -rowsHalf; r <= rowsHalf; r++) {
      const z = r * rp;
      const odd = (Math.abs(r) % 2) === 1;
      for (let c = -colsHalf; c <= colsHalf; c++) {
        const x = c * sp + (odd ? off : 0);
        if (Math.abs(x) > hw + 1e-6) continue;
        cx.push(x); cz.push(z);
        key.push(Math.round(Math.sqrt(x * x + (z / ez) * (z / ez)) * 1e6) / 1e6);
      }
    }
    const order = [];
    for (let i = 0; i < cx.length; i++) order.push(i);
    // ascending norm; ties -> front first (smaller z), then nearer the centre line (|x|), then left first
    order.sort((a, b) => (key[a] - key[b]) || (cz[a] - cz[b]) || (Math.abs(cx[a]) - Math.abs(cx[b])) || (cx[a] - cx[b]));

    const slotX = new Float32Array(CAP), slotZ = new Float32Array(CAP), row = new Int16Array(CAP);
    for (let i = 0; i < CAP; i++) { slotX[i] = cx[order[i]]; slotZ[i] = cz[order[i]]; row[i] = Math.round(cz[order[i]] / rp); }
    this._slotX = slotX; this._slotZ = slotZ; this._slotRow = row;

    // running stats for the first n slots (n = 0..CAP)
    const fo = new Float32Array(CAP + 1), hwAt = new Float32Array(CAP + 1), dAt = new Float32Array(CAP + 1);
    let minZ = Infinity, maxZ = -Infinity, maxAbsX = 0;
    for (let n = 1; n <= CAP; n++) {
      const x = slotX[n - 1], z = slotZ[n - 1];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (Math.abs(x) > maxAbsX) maxAbsX = Math.abs(x);
      fo[n] = minZ; hwAt[n] = maxAbsX; dAt[n] = maxZ - minZ;
    }
    fo[0] = 0; hwAt[0] = 0; dAt[0] = 0;
    this._frontOffset = fo; this._halfWidthAt = hwAt; this._depthAt = dAt;

    // slots by z ascending (front-most first), ties by |x| -> shooter order
    const zo = [];
    for (let i = 0; i < CAP; i++) zo.push(i);
    zo.sort((a, b) => (slotZ[a] - slotZ[b]) || (Math.abs(slotX[a]) - Math.abs(slotX[b])) || (a - b));
    this._zOrder = Int32Array.from(zo);
    // interior draw priority: the z order by bit-reversed index (any prefix spreads over the rows; ±1 slot moves ≈ 1.5)
    this._prio = bitReversed(this._zOrder);
  }

  /** 1.4.0: the active slot table as one record. */
  _tables() {
    return { slotX: this._slotX, slotZ: this._slotZ, frontOffset: this._frontOffset, halfWidthAt: this._halfWidthAt, depthAt: this._depthAt,
      zOrder: this._zOrder, slotRow: this._slotRow, prio: this._prio };
  }

  /** 1.4.0: makes table t the active one. */
  _useTables(t) {
    this._slotX = t.slotX; this._slotZ = t.slotZ; this._frontOffset = t.frontOffset; this._halfWidthAt = t.halfWidthAt;
    this._depthAt = t.depthAt; this._zOrder = t.zOrder; this._slotRow = t.slotRow; this._prio = t.prio;
    this._shooterL = -1; this._wantL = -1;
  }

  /** 1.4.0 (horde DESIGN 4.1): WALL.cols columns about x 0, rows behind the front row (z 0), filled row by row, centre out. */
  _buildWallTable() {
    const cols = WALL.cols, sp = WALL.spacing, rp = WALL.rowPitch;
    const col = [];
    for (let c = 0; c < cols; c++) col.push((c - (cols - 1) / 2) * sp);
    col.sort((a, b) => (Math.abs(a) - Math.abs(b)) || (a - b));
    const slotX = new Float32Array(CAP), slotZ = new Float32Array(CAP), row = new Int16Array(CAP);
    const fo = new Float32Array(CAP + 1), hwAt = new Float32Array(CAP + 1), dAt = new Float32Array(CAP + 1), zo = new Int32Array(CAP);
    let maxAbsX = 0;
    for (let i = 0; i < CAP; i++) {
      const r = (i / cols) | 0;
      slotX[i] = col[i % cols]; slotZ[i] = r * rp; row[i] = r; zo[i] = i;
      if (Math.abs(slotX[i]) > maxAbsX) maxAbsX = Math.abs(slotX[i]);
      hwAt[i + 1] = maxAbsX; dAt[i + 1] = slotZ[i];
    }
    this._wall = { slotX, slotZ, frontOffset: fo, halfWidthAt: hwAt, depthAt: dAt, zOrder: zo, slotRow: row, prio: bitReversed(zo) };
  }

  // ------------------------------------------------------------------------------------------
  // Getters (ARCH §6.5)
  // ------------------------------------------------------------------------------------------

  /** C: the logical count (all combat maths). */
  get count() { return this._count; }
  /** V = min(C, Vmax): the rendered count. */
  get visible() { return this._count < this._vmax ? this._count : this._vmax; }
  /** squadX (mirrored to ctx.world.squadX every step). */
  get x() { return this._s[S_X]; }
  /** L = min(C, CAP): the logical formation (D5). */
  get logicalCount() { return this._count < CAP ? this._count : CAP; }
  get halfWidth() { return this._halfWidthAt[this.logicalCount]; }
  get depth() { return this._depthAt[this.logicalCount]; }
  /** Formation centre z (= front-row z (1.4.0; 0 for 'run') + depth / 2); the formation centre is (x, centerZ). */
  get centerZ() { return this._s[S_AZ] + this._depthAt[this.logicalCount] * 0.5; }
  /** 1.5.0: the logical formation's back row z (front-row z + depth): the chase gap is measured from it. */
  get backZ() { return this._s[S_AZ] + this._depthAt[this.logicalCount]; }
  /** 1.4.0: 'run' | 'wall'; 1.5.0: 'chase'. */
  get formation() { return this._form === FORM_WALL ? 'wall' : (this._rearOn ? 'chase' : 'run'); }
  get invulnerable() { return this._s[S_INV] > 0; }
  get armor() { return this._plates; }

  // ------------------------------------------------------------------------------------------
  // step(dt): steering, lane lock, invulnerability, reconciliation, record motion (§4.2 B)
  // ------------------------------------------------------------------------------------------

  step(dt) {
    const ctx = this._ctx;
    // --- visible cap from the live tier (read every step; a change re-settles the formation)
    const params = ctx.quality ? ctx.quality.params : null;
    if (params && params.vmax !== this._vmax) { this._vmax = params.vmax; this._requestSettle(0); }
    const L = this._count < CAP ? this._count : CAP;
    // CHR-13: steering, invulnerability countdown, record motion and the ctx.world mirrors run in stepCore, a module
    // function over typed arrays (it stays optimised, so it allocates nothing); the rare side effects it reports
    // (records to free, invulnerability ended, reconciliation due) are applied here.
    const wall = this._form === FORM_WALL;                      // 1.4.0: the wall never steers
    const r = stepCore(this._s, dt, wall ? 0 : ctx.input.targetX, this._laneLocked && !wall, ctx.world.roadSpeed, this._settlePending, L, this._count,
      this._frontOffset, this._halfWidthAt, this._depthAt, ctx.world, this._recList, this._recCount, this._rState, this._rSlot,
      this._rx, this._rz, this._rSpawnT, this._rDeathT, this._slotX, this._slotZ, _tmpFree, this._rFx, this._rFz);
    const nFree = r & STEP_FREE_MASK;
    for (let j = 0; j < nFree; j++) this._freeRecord(_tmpFree[j]);
    if ((r & STEP_INVULN_ENDED) !== 0) {
      _evInvuln.on = false;
      ctx.events.emit('squad:invuln', _evInvuln);
    }
    // --- reconciliation (deaths wait SQUAD.reflowDelay; everything else is immediate). It runs after the record motion,
    // so displaced / reserve soldiers start walking on the next step (16 ms later).
    if ((r & STEP_SETTLE_DUE) !== 0) this._settle();
  }

  // ------------------------------------------------------------------------------------------
  // render(alpha): instance matrix / attribute writes only (§4.2 D)
  // ------------------------------------------------------------------------------------------

  render(alpha) {
    const ctx = this._ctx;
    const inst = this.instances;
    // death / dissolve animations keep playing in complete / gameover, where no step runs (§4.2)
    const st = ctx.state;
    if (st && (st.is('complete') || st.is('gameover'))) this._s[S_COAST] += ctx.time.dt;

    const V = this.visible;
    const blob = this._blobFn && !!ctx.quality && !!ctx.quality.params && ctx.quality.params.shadows === false;
    const blobBase = RENDER.blobShadow.slots.squad;
    const render = ctx.render;
    const rx = this._rx, rz = this._rz, rs = this._rs, rState = this._rState, rSpawnT = this._rSpawnT, rDeathT = this._rDeathT;
    const rYaw = this._rYaw, rInst = this._rInst;
    const ma = this._matArr;
    const n = this._recCount;
    // CHR-13: the per-soldier pass is a module function over typed arrays only (see writeInstances)
    // 1.5.0: the rear guard: the back rows, ≤ CHASE.rearRows[tier] soldiers, turned round over REAR_EASE_S
    let rearZ = 1e9, rearYaw = 0;
    if (this._rearOn && this._form === FORM_RUN) {
      const L = this.logicalCount, tier = ctx.quality ? ctx.quality.tier : 'high', rows = CHASE.rearRows[tier] || CHASE.rearRows.low;
      const perRow = Math.max(1, Math.floor(2 * this._halfWidthAt[L] / SQUAD.slotSpacing) + 1);
      rearZ = this.backZ - Math.max(1, Math.min(Math.ceil(rows / perRow), Math.round(CHASE.rearDepth / SQUAD.rowPitch))) * SQUAD.rowPitch + 0.05;
      const u = (this._s[S_T] - this._rearT0) / REAR_EASE_S;
      rearYaw = Math.PI * (u >= 1 ? 1 : (u <= 0 ? 0 : u * u * (3 - 2 * u)));
    }
    writeInstances(this._s, alpha, this._recList, n, rState, rInst, rx, rz, rs, rYaw, rSpawnT, rDeathT, ma, inst.attrs.iState.array, rearZ, rearYaw);
    if (this._rearOn || this._rearN > 0) this._rearGait(rearZ);
    if (blob) {
      for (let i = 0; i < n; i++) {
        const rec = this._recList[i];
        const ii = rInst[rec];
        render.blobShadowSlot(blobBase + ii, ma[ii * 16 + 12], ma[ii * 16 + 14], rs[rec]);
      }
    }
    inst.commit();

    // Low tier blob shadows: hide the discs of instances freed since the last frame
    if (blob) {
      for (let ii = this._recCount; ii < this._blobCount; ii++) render.blobShadowSlot(blobBase + ii, 0, 0, 0);
      this._blobCount = this._recCount;
    } else if (this._blobCount > 0) {
      if (this._blobFn) for (let ii = 0; ii < this._blobCount; ii++) render.blobShadowSlot(blobBase + ii, 0, 0, 0);
      this._blobCount = 0;
    }

    // the ONLY label call squad makes (D3): world anchor at (x, label.y + label.yPerSqrt * sqrt(V), label.z)
    if (this._label !== null) {
      if (this._form === FORM_WALL) this._label.setWorldPos(WALL.label[0], WALL.label[1], WALL.label[2]);   // 1.4.0
      else this._label.setWorldPos(this._s[S_X], SQUAD.label.y + SQUAD.label.yPerSqrt * Math.sqrt(V), SQUAD.label.z);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Public API: count changes (ARCH §6.5)
  // ------------------------------------------------------------------------------------------

  /**
   * Absolute count. Visual growth bursts from the blob centre ('start' pops soldiers in place),
   * shrinkage dissolves rim-inward (no squad:loss). Emits squad:count { reason } and squad:dead at 0.
   */
  setCount(n, reason) {
    n = clamp(Math.round(n), 0, SQUAD.countCap);
    const prev = this._count;
    this._count = n;
    if (n > 0) this._dead = false;                                // debug / QA revive (gates and additions stay blocked while dead)
    if (n > prev) this._spawnVisible(this._s[S_X], this.centerZ, reason !== 'start');
    else if (n < prev) this._requestSettle(0);
    this._emitCount(prev, reason);
    if (n === 0 && prev > 0) this._emitDead();
  }

  /**
   * n > 0 soldiers burst from (originX, originZ) (world coords; the default is 2 m ahead of the front
   * row per the §6.5 signature). Emits squad:spawn then squad:count.
   */
  addSoldiers(n, reason, originX = this._s[S_X], originZ = -2) {
    n = Math.round(n);
    if (!(n > 0) || this._dead) return;                          // CHR-10: a dead squad stays dead (medic, assist, gate)
    const prev = this._count;
    this._count = clamp(prev + n, 0, SQUAD.countCap);
    if (this._count === prev) return;
    this._spawnVisible(originX, originZ, true);
    _evSpawn.count = this._count - prev; _evSpawn.x = originX; _evSpawn.z = originZ;
    this._ctx.events.emit('squad:spawn', _evSpawn);
    this._emitCount(prev, reason);
  }

  /**
   * n > 0 losses from an attack at (x, z). Armour plates absorb GEAR.armor.absorbs reasons ('bite',
   * 'spit'): a bite call consumes min(n, plates) plates (a brute swing is one call with n = zombies._bruteKills(C) ≤ 3 =
   * GEAR.armor.costBrute — round 7: fewer against a small squad); a spit splash consumes min(GEAR.armor.costSpit, plates) plates and absorbs the
   * whole splash (GDD §6.1/§8.2 "spit 1"). Boss attacks ('slam', 'charge', 'stomp', 'car', 'chew') ignore plates. The
   * soldier nearest the attacker topples away from it. Emits squad:loss per soldier, one squad:count,
   * squad:dead at 0. No losses while invulnerable (GDD §6.1). Never called with 'gate' (see applyGate). z defaults to the
   * front row (1.4.0: the wall's at WALL.frontZ).
   */
  removeSoldiers(n, reason, x = this._s[S_X], z = this._s[S_AZ]) {
    n = Math.round(n);
    if (!(n > 0) || this._count <= 0) return;
    if (this._s[S_INV] > 0) return;
    const events = this._ctx.events;
    if (this._plates > 0 && this._absorbs[reason] === true) {
      let a;
      if (reason === 'spit') {
        // one splash (n soldiers, 2 from L10) costs GEAR.armor.costSpit plates and is absorbed whole
        a = GEAR.armor.costSpit < this._plates ? GEAR.armor.costSpit : this._plates;
        n = 0;
      } else {
        a = n < this._plates ? n : this._plates;              // a brute swing is one call with n = 1–3 -> that many plates (r7)
        n -= a;
      }
      this._plates -= a;
      _evArmor.plates = this._plates; _evArmor.delta = -a;
      events.emit('armor:change', _evArmor);
      if (n <= 0) return;
    }
    if (n > this._count) n = this._count;
    const prev = this._count;
    for (let k = 0; k < n; k++) {
      this._count--;
      const slot = this.nearestSoldierIndex(x, z);
      if (slot >= 0) this._killRecord(this._slotRec[slot], x, z);   // writes the victim's world position into _evLoss
      else { _evLoss.x = x; _evLoss.z = z; }                        // C > Vmax with no visible soldier left: no body
      _evLoss.count = this._count; _evLoss.cause = reason;
      events.emit('squad:loss', _evLoss);
    }
    this._requestSettle(SQUAD.reflowDelay);                        // the hole stays legible for reflowDelay
    this._emitCount(prev, reason);
    if (this._count === 0) this._emitDead();
  }

  /**
   * GDD §4.3: '+' C + N; '-' max(1, C - N); 'x' C * M; '/' ceil(C / D); never below 1 while alive (CHR-10: after squad:dead it returns { 0, 0 } and does nothing). A positive result
   * bursts soldiers from the gate footprint (addSoldiers 'gate'); a negative / divide result dissolves
   * rim-inward with NO squad:loss (setCount 'gate'). Exactly one squad:count with reason 'gate' is
   * emitted. Grants SQUAD.invulnOnPass seconds of invulnerability. Returns a reused { before, after }.
   *
   * Value conventions (gates.js keeps the '-' value signed: -15 ... 0 ... +15 once flipped):
   *   '-' takes |value| as the loss, so a signed -15 and a magnitude 15 both lose 15; a flipped minus
   *   lane is expected to arrive as '+' (its glyph swaps to "+"). A flipped divide ladder (x2) is
   *   expected as 'x' 2 (or '/' 0.5, which ceil(C / 0.5) = 2C handles); '/' 1 is the neutral x1.
   */
  applyGate(op, value, originX, originZ) {
    if (this._dead) {                                            // CHR-10: "never below 1" is for a living squad only;
      _gateResult.before = 0; _gateResult.after = 0;             // a pass at C = 0 changes nothing (no invulnerability, no events)
      return _gateResult;
    }
    const before = this._count;
    let after = before;
    if (op === '+') after = before + value;
    else if (op === '-') after = before - Math.abs(value);
    else if (op === 'x') after = before * value;
    else if (op === '/') { if (value > 0) after = Math.ceil(before / value); }
    after = clamp(Math.round(after), 1, SQUAD.countCap);           // "a gate never takes C below 1"
    if (after > before) this.addSoldiers(after - before, 'gate', originX, originZ);
    else this.setCount(after, 'gate');
    this.setInvulnerable(SQUAD.invulnOnPass);
    _gateResult.before = before; _gateResult.after = after;
    return _gateResult;
  }

  /** Armour plates (0..GEAR.armor.platesCap); always emits armor:change { plates, delta }. */
  setArmor(plates) {
    const next = clamp(Math.round(plates), 0, GEAR.armor.platesCap);
    const delta = next - this._plates;
    this._plates = next;
    _evArmor.plates = next; _evArmor.delta = delta;
    this._ctx.events.emit('armor:change', _evArmor);
  }

  /** Commit lock (called by gates at WORLD.gateCommitZ): steering target clamped to laneX +- 0.3; null releases. */
  lockLane(laneX) {
    if (laneX === null || laneX === undefined || laneX !== laneX) { this._laneLocked = false; this._s[S_LANE_X] = 0; }
    else { this._laneLocked = true; this._s[S_LANE_X] = laneX; }
  }

  /**
   * 1.4.0 (ARCH §3): 'wall' — the WALL table at world x 0, rows at z ≤ WALL.stepBackZ on the firing step (opts.stepY); 'run' —
   * the blob. Gameplay reads the new table at once; the soldiers walk there over opts.easeS (smoothstep), re-anchored so nobody
   * jumps; the wall ignores targetX and the lane lock. reset() returns to 'run'. No allocation.
   */
  setFormation(name, opts) {
    const wall = name === 'wall';
    if (!wall && name !== 'run' && name !== 'chase') { warnOnce('squad.formation.' + name, 'squad.setFormation: unknown formation "' + name + '"'); return; }
    this._setRear(name === 'chase');                              // 1.5.0: 'chase' = the run formation + the rear guard
    if ((this._form === FORM_WALL) === wall) return;
    const o = opts || WALL;
    const s = this._s;
    const sx = wall ? s[S_X] : 0;
    for (let i = 0; i < this._recCount; i++) {
      const rec = this._recList[i];
      if (this._rState[rec] !== REC_DYING) this._rx[rec] += sx;   // about x 0 (DYING records are in world space)
      this._rFx[rec] = this._rx[rec]; this._rFz[rec] = this._rz[rec];
    }
    if (wall) { s[S_X] = 0; s[S_VX] = 0; }
    this._laneLocked = false; s[S_LANE_X] = 0;
    s[S_FT0] = s[S_T];
    s[S_FDUR] = o.easeS >= 0 ? o.easeS : WALL.easeS;
    s[S_SY0] = s[S_SY];
    s[S_SY1] = wall ? (o.stepY >= 0 ? o.stepY : WALL.stepY) : 0;
    s[S_AZ] = wall ? WALL.frontZ : 0;
    if (!(s[S_FDUR] > 0)) { s[S_FDUR] = 0; s[S_SY] = s[S_SY1]; }
    this._form = wall ? FORM_WALL : FORM_RUN;
    this._useTables(wall ? this._wall : this._run);
    this._syncShooters();
    this._requestSettle(0);
  }

  /** 1.5.0: the rear guard on / off (off: every turned soldier walks forward again). */
  _setRear(on) {
    if (on === this._rearOn) return;
    this._rearOn = on;
    this._rearT0 = this._s[S_T];
    if (!on) this._rearGait(1e9);
  }

  /** 1.5.0: the walk cycle backward behind rearZ (a backpedal), forward elsewhere (written on change). */
  _rearGait(rearZ) {
    const list = this._recList, rState = this._rState, rz = this._rz, flag = this._rRear, inst = this.instances;
    let n = 0;
    for (let i = 0; i < this._recCount; i++) {
      const rec = list[i];
      const want = rState[rec] === REC_ALIVE && rz[rec] >= rearZ ? 1 : 0;
      if (want !== flag[rec] && rState[rec] === REC_ALIVE) { flag[rec] = want; inst.setSpeed(this._rInst[rec], want ? -1 : 1); }
      n += flag[rec];
    }
    this._rearN = n;
  }

  /**
   * Invulnerability for `seconds` (Infinity allowed: level end / boss intro). Never shortens an active
   * window; 0 or a negative value cancels. Emits squad:invuln on transitions; mirrors ctx.world.invulnerable.
   */
  setInvulnerable(seconds) {
    const was = this._s[S_INV] > 0;
    if (!(seconds > 0)) this._s[S_INV] = 0;
    else if (seconds > this._s[S_INV]) this._s[S_INV] = seconds;
    const on = this._s[S_INV] > 0;
    const w = this._ctx.world;
    if (w) w.invulnerable = on;
    if (on !== was) { _evInvuln.on = on; this._ctx.events.emit('squad:invuln', _evInvuln); }
  }

  // ------------------------------------------------------------------------------------------
  // Public API: queries (ARCH §6.5 / §7)
  // ------------------------------------------------------------------------------------------

  /** Muzzle of the k-th front-most logical slot (k < min(L, FIRE.shooters)), world coords — tier-free (D5); else front centre. */
  shooterPosition(k, out) {
    const mo = FIRE.muzzleOffset;
    if (k >= 0 && k < this._shooterCount) {
      const s = this._shooterSlots[k];
      const z = this._slotZ[s] - this._frontOffset[this.logicalCount] + this._s[S_AZ];
      out.set(this._s[S_X] + this._slotX[s] + mo[0], z <= this._s[S_SZ] ? mo[1] + this._s[S_SY] : mo[1], z + mo[2]);
      return out;
    }
    out.set(this._s[S_X] + mo[0], mo[1], mo[2]);
    return out;
  }

  /** 1.4.0: the x of the first n shooterPosition muzzles, less the muzzle offset, into out (a hold's lane test, every step: no Vector3 call). */
  shootersX(n, out) {
    const m = FIRE.muzzleOffset[0], sx = this._s[S_X], slots = this._shooterSlots, X = this._slotX, sc = this._shooterCount;
    for (let k = 0; k < n; k++) out[k] = (k < sc ? sx + X[slots[k]] + m : sx + m) - m;
  }

  /** World position of slot i for the current formation (slot 0 = centre). */
  slotWorld(i, out) {
    const s = i < 0 ? 0 : (i >= CAP ? CAP - 1 : i | 0);
    out.set(this._s[S_X] + this._slotX[s], 0, this._slotZ[s] - this._frontOffset[this.logicalCount] + this._s[S_AZ]);
    return out;
  }

  /** Occupied slot whose soldier is nearest the attacker at world (x, z); ties go to the outer slot. -1 when none. */
  nearestSoldierIndex(x, z) {
    const lx = x - this._s[S_X];
    const rState = this._rState, rx = this._rx, rz = this._rz, rSlot = this._rSlot, list = this._recList;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this._recCount; i++) {
      const rec = list[i];
      if (rState[rec] !== REC_ALIVE) continue;
      const dx = rx[rec] - lx, dz = rz[rec] - z;
      const d = dx * dx + dz * dz;
      const s = rSlot[rec];
      if (d < bestD - 1e-6 || (d < bestD + 1e-6 && s > best)) { bestD = d; best = s; }
    }
    return best;
  }

  /** Contact test: the formation AABB (slot centres, front row at z = 0) inflated by r. */
  intersectsCircle(x, z, r) {
    const L = this.logicalCount;
    if (L <= 0) return false;
    const hw = this._halfWidthAt[L] + r;
    const az = this._s[S_AZ];
    return x >= this._s[S_X] - hw && x <= this._s[S_X] + hw && z >= az - r && z <= az + this._depthAt[L] + r;
  }

  /** Formation AABB in world XZ. */
  bounds(out) {
    const L = this.logicalCount;
    const hw = this._halfWidthAt[L];
    out.minX = this._s[S_X] - hw; out.maxX = this._s[S_X] + hw; out.minZ = this._s[S_AZ]; out.maxZ = this._s[S_AZ] + this._depthAt[L];
    return out;
  }

  /** Recoil (iAnim.w) for shooter k. */
  setFireVisual(k) {
    if (k < 0 || k >= this._shooterCount) return;
    const rec = this._slotRec[this._shooterSlots[k]];
    if (rec >= 0 && this._rState[rec] === REC_ALIVE) this.instances.setFire(this._rInst[rec], this._uTime.value);
  }

  // ------------------------------------------------------------------------------------------
  // Private: events
  // ------------------------------------------------------------------------------------------

  _emitCount(prev, reason) {
    this._syncShooters();
    _evCount.count = this._count; _evCount.prev = prev; _evCount.delta = this._count - prev; _evCount.reason = reason;
    this._ctx.events.emit('squad:count', _evCount);
  }

  _emitDead() {
    const ctx = this._ctx;
    this._dead = true;
    const dist = ctx.world ? ctx.world.distance : 0;
    const len = ctx.run && ctx.run.length > 0 ? ctx.run.length : 0;
    _evDead.distance = dist;
    _evDead.fraction = len > 0 ? clamp(dist / len, 0, 1) : 0;
    ctx.events.emit('squad:dead', _evDead);
  }

  _dropped() {
    const dbg = this._ctx.debug;
    if (dbg && dbg.dropped) dbg.dropped.squad = (dbg.dropped.squad | 0) + 1;
  }

  // ------------------------------------------------------------------------------------------
  // Private: reconciliation (occupied slots == the drawn set)
  // ------------------------------------------------------------------------------------------

  _requestSettle(delay) {
    const at = this._s[S_T] + delay;
    if (!this._settlePending || at < this._s[S_SETTLE_AT]) this._s[S_SETTLE_AT] = at;
    this._settlePending = true;
  }

  _settle() {
    this._settlePending = false;
    const L = this.logicalCount;
    const nv = this._relocate(this._frontOffset[L], true);

    // remaining vacancies: reserve soldiers step up from behind the rear row (hidden count, Vmax raise)
    if (nv > 0) {
      const rearZ = this._s[S_AZ] + this._depthAt[L] + SQUAD.rowPitch;
      for (let j = 0; j < nv; j++) {
        const v = _tmpVacant[j];
        const spawnT = this._s[S_T] + (j < SQUAD.spawnAnim.maxVisible ? j * SQUAD.spawnAnim.stagger : 0);
        if (this._spawnRecord(v, this._slotX[v], rearZ, spawnT, true) < 0) { this._requestSettle(STEP); break; }   // pool full: retry next step
      }
    }
  }

  /**
   * Displaced records (rim first) walk to the nearest vacant drawn slot; with none left they dissolve rim-inward,
   * SQUAD.dissolvePer100ms per DISSOLVE_WINDOW (or stay, without `dissolve`). Returns the vacancies left (_tmpVacant).
   */
  _relocate(fo, dissolve) {
    this._syncWant();
    const want = this._want, slotRec = this._slotRec, slotX = this._slotX, slotZ = this._slotZ, rx = this._rx, rz = this._rz, rSlot = this._rSlot;
    fo -= this._s[S_AZ];                                          // 1.4.0: slot z − fo = local z
    let nv = 0;
    for (let s = 0; s < CAP; s++) if (want[s] === 1 && slotRec[s] < 0) _tmpVacant[nv++] = s;
    let nd = 0;
    for (let s = CAP - 1; s >= 0; s--) if (want[s] === 0 && slotRec[s] >= 0) _tmpDisplaced[nd++] = s;
    let dissolveK = 0;
    for (let i = 0; i < nd; i++) {
      const s = _tmpDisplaced[i];
      const rec = slotRec[s];
      if (nv > 0) {
        const px = rx[rec], pz = rz[rec];
        let best = 0, bestD = Infinity;
        for (let j = 0; j < nv; j++) {
          const v = _tmpVacant[j];
          const dx = slotX[v] - px, dz = slotZ[v] - fo - pz;
          const dd = dx * dx + dz * dz;
          if (dd < bestD) { bestD = dd; best = j; }
        }
        const v = _tmpVacant[best];
        _tmpVacant[best] = _tmpVacant[--nv];
        slotRec[s] = -1; slotRec[v] = rec; rSlot[rec] = v;
      } else if (dissolve) {
        this._dissolveRecord(rec, this._s[S_T] + Math.floor(dissolveK / SQUAD.dissolvePer100ms) * DISSOLVE_WINDOW);
        dissolveK++;
      }
    }
    return nv;
  }

  /**
   * Fills every vacant drawn slot with a new soldier. fromOrigin: the first spawnAnim.maxVisible
   * burst from the world origin (ox, oz) with the stagger; the rest appear instantly in place.
   * Without an origin ('start') they pop in place with the stagger.
   */
  _spawnVisible(ox, oz, fromOrigin) {
    const fo = this._frontOffset[this.logicalCount] - this._s[S_AZ];   // 1.4.0: slot z − fo = local z
    this._relocate(this._frontOffset[this.logicalCount], false);
    const want = this._want, slotRec = this._slotRec, slotX = this._slotX, slotZ = this._slotZ;
    const rng = this._ctx.rngFx;
    const maxVis = SQUAD.spawnAnim.maxVisible, stagger = SQUAD.spawnAnim.stagger;
    const lox = ox - this._s[S_X];
    let k = 0;
    for (let s = 0; s < CAP; s++) {
      if (want[s] === 0 || slotRec[s] >= 0) continue;
      const animated = k < maxVis;
      let lx, lz, spawnT;
      if (animated) {
        spawnT = this._s[S_T] + k * stagger;
        if (fromOrigin) {
          lx = lox + (rng.next() * 2 - 1) * BURST_JITTER;
          lz = oz + (rng.next() * 2 - 1) * BURST_JITTER;
        } else {
          lx = slotX[s]; lz = slotZ[s] - fo;
        }
      } else {
        spawnT = this._s[S_T] - SQUAD.spawnAnim.time;                 // already past the animation: appears instantly
        lx = slotX[s]; lz = slotZ[s] - fo;
      }
      if (this._spawnRecord(s, lx, lz, spawnT, animated) < 0) { this._requestSettle(STEP); break; }
      k++;
    }
  }

  /** The min(L, FIRE.shooters) front-most logical slots, by z ascending then |x|. */
  _syncShooters() {
    const L = this.logicalCount;
    if (L === this._shooterL) return;
    this._shooterL = L;
    const n = L < FIRE.shooters ? L : FIRE.shooters;
    const zo = this._zOrder, out = this._shooterSlots;
    let c = 0;
    for (let i = 0; i < CAP && c < n; i++) { const s = zo[i]; if (s < L) out[c++] = s; }
    this._shooterCount = c;
  }

  /**
   * Drawn set for (L, V < L), A13a: the shooters, ≤ min(EDGE_MAX, 1/6 of the rest) row ends per side, the rest by the
   * interior priority — sparser but filled, never a hollow U. Event time, no allocation.
   */
  _syncWant() {
    const L = this.logicalCount, V = this.visible;
    if (L === this._wantL && V === this._wantV) return;
    this._wantL = L; this._wantV = V;
    this._syncShooters();
    const want = this._want, zo = this._zOrder, x = this._slotX, row = this._slotRow, pr = this._prio;
    want.fill(0);
    if (V >= L) { want.fill(1, 0, L); return; }
    let n = this._shooterCount;
    for (let k = 0; k < n; k++) want[this._shooterSlots[k]] = 1;
    let nl = 0, nr = 0, r = -1e9, lo = -1, hi = -1, xl = 0, xr = 0;
    for (let i = 0; i <= CAP; i++) {                              // zOrder: row by row, front to back
      const s = i < CAP ? zo[i] : -1;
      if (s >= L) continue;
      if (s < 0 || row[s] !== r) {
        if (lo >= 0) {
          if (want[lo] === 0) _edgeL[nl++] = lo;
          if (want[hi] === 0 && hi !== lo) _edgeR[nr++] = hi;
          if (x[lo] < xl) xl = x[lo];
          if (x[hi] > xr) xr = x[hi];
        }
        if (s < 0) break;
        r = row[s]; lo = hi = s;
      } else { if (x[s] < x[lo]) lo = s; if (x[s] > x[hi]) hi = s; }
    }
    let e = Math.floor((V - n) / 6);
    if (e > EDGE_MAX) e = EDGE_MAX;
    n += pickEnds(_edgeL, nl, x, -xl - 1e-3, -1, e, want) + pickEnds(_edgeR, nr, x, xr - 1e-3, 1, e, want);
    for (let i = 0; i < CAP && n < V; i++) { const s = pr[i]; if (s < L && want[s] === 0) { want[s] = 1; n++; } }
  }

  // ------------------------------------------------------------------------------------------
  // Private: soldier records (one CharacterInstances instance each)
  // ------------------------------------------------------------------------------------------

  _resetRecordPool() {
    this._recCount = 0;
    this._freeCount = CAP;
    for (let i = 0; i < CAP; i++) {
      this._freeRec[i] = CAP - 1 - i;                             // pop order: record 0 first
      this._rState[i] = REC_FREE; this._rSlot[i] = -1; this._rInst[i] = -1; this._instRec[i] = -1;
    }
  }

  _allocRecord() {
    if (this._freeCount === 0) { this._dropped(); return -1; }
    const ii = this.instances.alloc();
    if (ii < 0) { this._dropped(); return -1; }
    const rec = this._freeRec[--this._freeCount];
    this._rInst[rec] = ii; this._instRec[ii] = rec;
    this._recPos[rec] = this._recCount; this._recList[this._recCount++] = rec;
    return rec;
  }

  _freeRecord(rec) {
    const slot = this._rSlot[rec];
    if (slot >= 0) { if (this._slotRec[slot] === rec) this._slotRec[slot] = -1; this._rSlot[rec] = -1; }
    const p = this._recPos[rec], last = --this._recCount;
    const moved = this._recList[last];
    this._recList[p] = moved; this._recPos[moved] = p;
    this._rState[rec] = REC_FREE;
    this._freeRec[this._freeCount++] = rec;
    const ii = this._rInst[rec];
    this._rInst[rec] = -1;
    if (ii >= 0) { this._instRec[ii] = -1; this.instances.free(ii); }   // swap-remove -> _onMove(last, ii)
  }

  /** New ALIVE soldier in `slot` at formation-local (lx, lz); animated = scale-in from spawnT. */
  _spawnRecord(slot, lx, lz, spawnT, animated) {
    const rec = this._allocRecord();
    if (rec < 0) return -1;
    const rng = this._ctx.rngFx;
    this._rState[rec] = REC_ALIVE;
    this._rSlot[rec] = slot; this._slotRec[slot] = rec;
    this._rx[rec] = lx; this._rz[rec] = lz;
    this._rFx[rec] = lx; this._rFz[rec] = lz;                      // 1.4.0: a formation ease starts here
    this._rs[rec] = animated ? 0 : 1;
    this._rSpawnT[rec] = spawnT;
    this._rDeathT[rec] = 0;
    this._rPhase[rec] = rng.next();                              // de-synchronised walk cycles
    this._rYaw[rec] = (rng.next() * 2 - 1) * YAW_JITTER;
    this._rTint[rec] = 1 + (rng.next() * 2 - 1) * TINT_JITTER;
    this._rRear[rec] = 0;
    this._applyStatics(rec, this._rInst[rec]);
    return rec;
  }

  /** Per-instance attributes that do not change every frame (also re-applied after an onMove). */
  _applyStatics(rec, ii) {
    const inst = this.instances;
    const st = this._rState[rec];
    const marching = st === REC_ALIVE || (st === REC_DISSOLVE && this._rs[rec] >= 1);
    inst.setPhase(ii, this._rPhase[rec]);
    inst.setSpeed(ii, marching ? (this._rRear[rec] ? -1 : 1) : 0);   // 1.5.0: a rear guard backpedals
    const t = this._rTint[rec];
    inst.setTint(ii, t, t, t);
    inst.setDeath(ii, 0);                                         // dying / dissolving records rewrite death01 every render
  }

  /** ALIVE -> DYING: leaves its slot, freezes in world space, faces the attacker and topples away from it. */
  _killRecord(rec, ax, az) {
    const slot = this._rSlot[rec];
    if (slot >= 0) { this._slotRec[slot] = -1; this._rSlot[rec] = -1; }
    const wx = this._s[S_X] + this._rx[rec], wz = this._rz[rec];
    this._rx[rec] = wx; this._rz[rec] = wz;
    const dx = ax - wx, dz = az - wz;
    this._rYaw[rec] = (dx * dx + dz * dz) > 1e-6 ? Math.atan2(-dx, -dz) : 0;   // facing (-sin yaw, -cos yaw) points at the attacker
    this._rState[rec] = REC_DYING;
    this._rDeathT[rec] = this._s[S_T];
    const ii = this._rInst[rec];
    this.instances.setSpeed(ii, 0);                               // limbs freeze (iAnim.y scales the walk clock)
    this.instances.setHit(ii, this._uTime.value);                 // white flash on the bite
    _evLoss.x = wx; _evLoss.z = wz;
  }

  /** ALIVE -> DISSOLVE (gate loss): leaves its slot now, keeps marching in place until startT, then shrinks + sinks. */
  _dissolveRecord(rec, startT) {
    const slot = this._rSlot[rec];
    if (slot >= 0) { this._slotRec[slot] = -1; this._rSlot[rec] = -1; }
    this._rState[rec] = REC_DISSOLVE;
    this._rDeathT[rec] = startT;
  }

  /** CharacterInstances swap-remove callback: the record at instance `from` now lives at `to`. */
  _onMove(from, to) {
    const rec = this._instRec[from];
    if (rec < 0) return;
    this._instRec[to] = rec;
    this._instRec[from] = -1;
    this._rInst[rec] = to;
    this._applyStatics(rec, to);
  }

}
