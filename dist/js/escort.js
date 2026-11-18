// js/escort.js — ctx.escort, the ESCORT level type: a ModeSystem that keeps the run (PLAN-1.5.0 P3, C1; escort-design.txt).
//
// A rescue truck of survivors drives ahead of the squad in one half of the road on the script's route (escortgen.escortBuild, one
// { type: 'escort', at: 1, spec } event; keepsRun: the gates, waves and crates go on). A climber that reaches it takes one of 6 slots
// (zombies.setContactProvider) and after spec.grab s drags a survivor off; the squad guards it by standing in its half. PLATE knocks
// the climber nearest a grab off and armours its slot. CHECKPOINT halfway, the GAUNTLET, the SAFE ZONE (finish(true, 'delivered'));
// 0 survivors is TRUCK OVERRUN (finish(false, 'truck')). Contract: ARCH §5 + keepsRun. Determinism (C13): route, slots, grabs,
// plates and swings run on the fixed step; figures and sway are cosmetic (hashes). Hot paths allocate nothing.
import {
  BufferGeometry, BufferAttribute, Mesh, Group, MeshBasicMaterial, InstancedMesh, DynamicDrawUsage, Vector3,
} from 'three';
import { clamp, warnOnce } from './util.js';
import { ESCORT, LEVELS, STRINGS, TROOPS } from './data.js';
import { CharacterInstances } from './models.js';

// ---------------------------------------------------------------------------------------------
// Constants (tuning lives in data.js ESCORT; module aliases only)
// ---------------------------------------------------------------------------------------------
const ET = ESCORT.truck, EB = ESCORT.bed, EH = ESCORT.hud, EP = ESCORT.props, EL = ESCORT.look;
const ZR = ET.rearZ, ZF = ET.rearZ - ET.length, ZC = ET.rearZ - ET.length / 2;   // tailgate, nose, centre (z, squad frame)
const NS = ESCORT.slots.length;
const SLX = new Float32Array(NS), SLZ = new Float32Array(NS);
for (let i = 0; i < NS; i++) { SLX[i] = ESCORT.slots[i][0]; SLZ[i] = ESCORT.slots[i][1]; }
const C_ATTACH = 1, C_CRUSH = 2, C_HOLD = 3, C_BRUTE = 4, C_BUMPER = 5;   // zombies.js setContactProvider answers
const ST_IDLE = 0, ST_RUN = 1, ST_WON = 2, ST_LOST = 3;
const VIEW_STATES = ['idle', 'run', 'won', 'lost'];
const FIG_BED = EB.max, FIG_FX = 4, FIG_CAP = FIG_BED + FIG_FX;   // survivor instances: the bed + falling / delivered figures
const RIB = EH.ribbonRows;
const RIB_STEP = EH.ribbonM / (RIB - 1);
const PLATE_PAD = 0.06;                                 // m a plate stands off the rail
const CP_SIDE = 1.15;                                    // the checkpoint post stands this far past the road edge (m)

/** A stable [0, 1) hash of an integer (cosmetic choices that must not draw a stream). */
function hash01(n) { let h = Math.imul(n ^ 0x9E3779B9, 0x85EBCA6B); h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
/** Screen x of a world point. */
function sx(r, x, y, z) { V3.set(x, y, z); r.worldToScreen(V3, SCR); return SCR.x; }
/** Smoothstep of u in [0, 1]. */
function smooth(u) { return u <= 0 ? 0 : (u >= 1 ? 1 : u * u * (3 - 2 * u)); }

// ---------------------------------------------------------------------------------------------
// Module-level reused payloads (listeners never retain them)
// ---------------------------------------------------------------------------------------------
const P_PROGRESS = { variant: 'segments', segments: 2, filled: -0, endIcon: 'flag', label: '' };
const P_ACTION = { on: false, icon: 'plate', badge: 0, disabled: false, label: '' };
const P_BANNER = { text: '', kicker: '', color: 0, seconds: -0 };
const P_PILL = { id: '', icon: '', text: '', seconds: -0, x: -0, y: -0, merge: false };
const P_COUNTER = { on: false, text: '', red: true };
const P_CUE = { x: -0, z: -0, survivors: 0 };
const P_BURST = { kind: '', x: -0, y: -0, z: -0, n: 0 };
const HINT_OPTS = { hold: -0, until: null, priority: false, event: -1 };
const V3 = new Vector3();
const SCR = { x: -0, y: -0 };
const SEEN = ['escort.truck', 'escort.climb', 'escort.plate', 'escort.checkpoint'];

export class EscortSystem {
  constructor(ctx) {
    // `f = 0.5; f = 0` seeds a float field as a heap double (never a Smi), so its first fractional store keeps the map
    this.ctx = ctx; this.active = false; this.programsReady = false; this.botView = null; this.keepsRun = true;
    this._state = ST_IDLE; this._spec = null; this._group = null; this._built = false; this._prep = null; this._prepRun = null;
    this._tx = 0.5; this._tx = 0; this._t = 0.5; this._t = 0; this._hudAcc = 0.5; this._hudAcc = 0; this._v = 0.5; this._v = 1;
    // the follow window (_stepFollow): truck x, end (m, < 0 closed), travel, last target x, decided?, next change
    this._fwX = 0.5; this._fwEnd = 0.5; this._fwTravel = 0.5; this._fwPrevX = 0.5; this._fwOk = false; this._fwNext = 0;
    this._lossAt = 0.5; this._slide = 0.5; this._slide = 0;
  }

  /** Per-run tables, the providers (objects made once: no per-call closures), listeners. No GPU work (prepare() builds the meshes). */
  init() {
    const ctx = this.ctx, self = this;
    this._occ = new Int32Array(NS).fill(-1);             // the climber on each slot (zombie id), −1 free
    this._grabT = new Float32Array(NS);                  // its time on the slot
    this._ring = new Int32Array(NS).fill(-1);            // its grab-gauge decal
    this._plateHp = new Int8Array(NS);                   // plate HP on each slot (0 none)
    this._figT = new Float32Array(FIG_CAP);              // fx figures: age (s), < 0 unused; start x / z, kind (1 fall, 2 deliver)
    this._figX = new Float32Array(FIG_CAP); this._figZ = new Float32Array(FIG_CAP); this._figK = new Uint8Array(FIG_CAP);
    this._ribPos = null; this._ribCol = null;
    this._contact = {
      zMin: ZF - 1.2, zMax: ZR + 1.2, cx: 0.5, cz: ZC, slideS: ESCORT.slideS, climbY: ESCORT.climbY, climbPitch: ESCORT.climbPitch, lastX: 0.5,
      touches(x, z, r) { if (x - self._tx > ET.halfW + r || self._tx - x > ET.halfW + r || z < ZF - r || z > ZR + r) return false; this.lastX = x; return true; },
      onContact(id, type, climber) { return self._onContact(id, type, climber, this.lastX); },
      slotPos(slot, out) { out.x = self._tx + SLX[slot]; out.z = ZC + SLZ[slot]; },
      onSwing(id) { self._onSwing(id); },
    };
    this._contact.cx = 0; this._contact.lastX = 0;
    this._placement = { place(key, out) { if (key !== 'apc') return false; out.z = -(ESCORT.apcAhead + TROOPS.apc.length * 0.5); return true; } };
    this.botView = {
      active: false, state: '', survivors: 0, delivered: 0, lost: 0, plates: 0, grab: 0.5,
      occ: new Int32Array(NS), grabT: new Float32Array(NS), plateHp: new Int8Array(NS), routeAt: (d) => self._routeX(d),
    };
    this._reset();
    const ev = ctx.events;
    if (ev) {
      ev.on('ui:action', () => { this._actionQ++; });
      ev.on('zombie:die', (p) => { if (this._state === ST_RUN && p) this._onZombieDie(p.id); });
      ev.on('squad:dead', () => { if (this._state === ST_RUN) this._end(ST_LOST); });
    }
    return this;
  }

  /** Per-run state back to idle (init / reset / begin). */
  _reset() {
    this._state = ST_IDLE; this._spec = null; this._t = 0; this._tx = 0; this._hudAcc = 0;
    this._survivors = 0; this._delivered = 0; this._lost = 0; this._plates = 0; this._presses = 0; this._actionQ = 0;
    this._cpDone = false; this._gauntletOn = false; this._changeI = 0; this._hornI = -1; this._blink = 0;
    this._climbSeen = false; this._laneSeen = false; this._plateSeen = false; this._bruteSeen = false;
    this._deliverT = -1; this._deliverN = 0; this._popT = 0; this._lastBadge = -1; this._lastDisabled = false;
    this._fwEnd = -1; this._fwNext = 0; this._tally = 0; this._lossN = 0; this._lossAt = -9; this._slide = 0;
    this._occ.fill(-1); this._grabT.fill(0); this._plateHp.fill(0); this._figT.fill(-1);
    this._removeRings();
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Builds the truck, plates, figures, ribbon and props once (hidden, under the scene) and compiles them behind the spinner. */
  prepare() {
    if (this._prep) return this._prep;
    const r = this.ctx.render;
    if (!r || !r.scene || !r.renderer) { this.programsReady = true; return (this._prep = Promise.resolve()); }
    this._build();
    const run = this._prepRun = { dead: false };
    return (this._prep = Promise.resolve(r.addWarmable(this._group, run)).then(() => { if (!run.dead) { this.programsReady = true; this._prepRun = null; } }));
  }

  /** A run of another base started: a prepare under way stops, unready; the next prepare() finishes it. */
  cancelPrepare() {
    if (!this._prepRun) return;
    this._prepRun.dead = true;
    this._prepRun = null;
    this._prep = null;
  }

  /** Level reset (RESET_ORDER) / quit: idle, the scene hidden. zombies / troops reset their hooks themselves. */
  reset() {
    if (this.active) this._hudOff();
    this.active = false;
    this._reset();
    if (this._group) this._group.visible = false;
    const fx = this.ctx.fx;
    if (fx && fx.label2) fx.label2.hide(EH.slot);
    if (this.botView) this.botView.active = false;
  }

  dispose() {
    this.reset();
    const r = this.ctx.render, g = this._group;
    if (!g) return;
    if (r) { r.removeWarmable(g); if (r.scene) r.scene.remove(g); }
    if (this._figs) this._figs.dispose();
    g.traverse((o) => { if (o.geometry && o.geometry.userData && o.geometry.userData.escortOwned) o.geometry.dispose(); if (o.material && o.material.userData && o.material.userData.escortOwned) o.material.dispose(); });
    this._group = null; this._built = false; this._prep = null; this.programsReady = false;
  }

  /** opts { threat, assistK, firstMeet, seed, runDecisions, event } (level's reused P_BEGIN): copied here. */
  begin(script, opts) {
    const ctx = this.ctx;
    const o = opts || {};
    const ev = o.event;
    if (!ev || !ev.spec) { warnOnce('escort.noSpec', 'escort.begin without an escort spec'); return; }
    this._reset();
    const sp = this._spec = ev.spec;
    this._v = Math.max(1, script.roadSpeed);
    this._survivors = sp.start;
    // plates: the start stock + REINFORCEMENTS (PLAN C10: one per assist step, given only through PLATE presses)
    this._plates = sp.plates + (o.assistK > 0 ? (o.assistK | 0) * ESCORT.plates.perStep : 0);
    this._tx = this._routeX(ctx.world.distance);
    this._contact.cx = this._tx;
    this._followOpen(sp.side0 * ET.x, ctx.world.distance + ESCORT.follow.firstS * this._v, ctx.input ? ctx.input.targetX || 0 : 0);
    this.active = true; this._state = ST_RUN;
    if (!this._built && ctx.render && ctx.render.scene) this._build();
    if (this._group) this._group.visible = true;
    if (ctx.zombies && ctx.zombies.setContactProvider) ctx.zombies.setContactProvider(this._contact);
    if (ctx.troops && ctx.troops.setPlacement) ctx.troops.setPlacement(this._placement);
    this._seen(SEEN[0]);
    this._banner(STRINGS.escort.start, '', EH.banner, EH.bannerS);
    this._emitAction(true);
    this._hud();
  }

  /** The escort's events are all in its spec; nothing else is forwarded to it. */
  fireEvent() { return false; }

  // -------------------------------------------------------------------------------------------
  // The fixed step
  // -------------------------------------------------------------------------------------------

  step(dt) {
    if (this._state === ST_IDLE) return;
    const ctx = this.ctx, sp = this._spec, d = ctx.world.distance;
    this._t += dt;
    if (this._deliverT >= 0) this._stepDeliver(dt);
    this._stepFigs(dt);
    if (this._state !== ST_RUN) return;
    // the truck: route, blinkers and horn ahead of each change
    this._tx = this._routeX(d);
    this._contact.cx = this._tx;
    const zb = ctx.zombies;
    const wp = ctx.weapons;
    if (wp && wp.setTracerClip) wp.setTracerClip(this._tx - ET.halfW, this._tx + ET.halfW, ZF);   // rounds seem to leave from the nose
    this._stepChanges(d);
    this._stepFollow(d);
    // the slots: grab gauges (the ring fills and rides with the truck)
    const fx = ctx.fx, rk = ctx.hard ? ctx.hard.ring : 1;   // HARD GLASS
    for (let s = 0; s < NS; s++) {
      if (this._occ[s] < 0) continue;
      const t = this._grabT[s] + dt * rk;
      this._grabT[s] = t;
      if (this._ring[s] >= 0 && fx) { fx.moveDecal(this._ring[s], this._tx + SLX[s], ZC + SLZ[s]); fx.decalProgress(this._ring[s], t / sp.grab); }
      if (!this._plateSeen && this._plates > 0 && t >= sp.grab * ESCORT.lessons.plateAt) {
        this._plateSeen = true;
        this._lesson('escort.plate', null, 4, null, true);
      }
      if (t >= sp.grab) { this._grab(s); if (this._state !== ST_RUN) return; }
    }
    // PLATE presses (one press = one plate)
    while (this._actionQ > 0) { this._actionQ--; this._pressPlate(); }
    // the checkpoint, the gauntlet, the safe zone
    if (!this._cpDone && d >= sp.checkpoint) this._checkpoint();
    if (!this._gauntletOn && d >= sp.gauntlet) {
      this._gauntletOn = true;
      this._banner(STRINGS.escort.gauntlet, STRINGS.escort.safeAhead, EH.banner, EH.bannerS);
    }
    if (d >= sp.safeZone) { this._safeZone(); return; }
    this._hudAcc += dt;
    if (this._hudAcc >= 1 / EH.hz) { this._hudAcc -= 1 / EH.hz; this._hud(); }
    this._updateView();
  }

  /** The truck's centre x when the squad has run d metres (the spec's route: side0, then each change's smoothstep over s · v). */
  _routeX(d) {
    const sp = this._spec;
    if (!sp) return 0;
    let x = sp.side0 * ET.x;
    const ch = sp.changes;
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (d <= c.at) break;
      const u = (d - c.at) / (c.s * this._v);
      const to = c.to * ET.x;
      x = u >= 1 ? to : x + (to - x) * smooth(u);
    }
    return x;
  }

  /** Following the truck is the escort's gate decision (ESCORT.follow): a guard steers only between gates, which _trackActivity
   *  never sees. A decided window adds one decision and no event (the share is of gates); a held line never travels. */
  _stepFollow(d) {
    const inp = this.ctx.input, tx = inp ? inp.targetX || 0 : 0, ch = this._spec.changes;
    if (this._fwEnd >= 0) {
      this._fwTravel += Math.abs(tx - this._fwPrevX);
      if (this._fwTravel >= LEVELS.curve.assist.minTravelM && Math.abs(tx - this._fwX) <= ESCORT.follow.tolM) this._fwOk = true;
      if (d >= this._fwEnd) this._followClose();
    }
    this._fwPrevX = tx;
    const c = this._fwNext < ch.length ? ch[this._fwNext] : null;
    if (c && d >= c.at - ET.blinkS * this._v) { this._fwNext++; this._followClose(); this._followOpen(c.to * ET.x, c.at + (c.s + ESCORT.follow.graceS) * this._v, tx); }
  }

  _followOpen(x, end, tx) { this._fwX = x; this._fwEnd = end; this._fwTravel = 0; this._fwOk = false; this._fwPrevX = tx; }

  _followClose() {
    if (this._fwEnd >= 0 && this._fwOk && this.ctx.level) this.ctx.level.addActivity(1, 0);
    this._fwEnd = -1;
  }

  /** Blinkers blinkS before a change until it ends (the side it turns to), the horn once as they start; the lane lesson. */
  _stepChanges(d) {
    const ch = this._spec.changes, lead = ET.blinkS * this._v;
    while (this._changeI < ch.length && d > ch[this._changeI].at + ch[this._changeI].s * this._v) this._changeI++;
    this._blink = 0;
    if (this._changeI >= ch.length) return;
    const c = ch[this._changeI];
    if (d < c.at - lead) return;
    this._blink = c.to;
    if (this._hornI !== this._changeI) {
      this._hornI = this._changeI;
      P_CUE.x = this._tx; P_CUE.z = ZC; P_CUE.survivors = this._survivors;
      this._emit('escort:horn', P_CUE);
      if (!this._laneSeen) { this._laneSeen = true; this._lesson('escort.lane', null, 4); }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Contact, slots, grabs, plates (zombies.js calls the provider in its step; all rare, event-time)
  // -------------------------------------------------------------------------------------------

  /** A zombie touches the truck: only the script's climbers (a climber wave's units) fight it — a brute holds the nose and swings, a
   *  walker or runner takes the slot nearest its contact on its side (a plate there knocks it off and loses a hit) or waits while that
   *  side is full; any other zombie goes under the bumper (no coins), so the truck shields a squad behind it. */
  _onContact(id, type, climber, x) {
    if (this._state !== ST_RUN) return C_HOLD;
    if (!climber) return C_BUMPER;
    if (type === 'brute') return C_BRUTE;
    const zb = this.ctx.zombies;
    const side = x < this._tx ? 0 : 1;
    // the slots of that side from the nose back (contacts land at the nose): the first one not taken is reached — a plate there
    // knocks the climber off (a hit), a free one takes it; all taken, it waits
    for (let k = 2; k >= 0; k--) {
      const s = k * 2 + side;
      if (this._occ[s] >= 0) continue;
      if (this._plateHp[s] > 0) { this._plateHit(s, 1); return C_CRUSH; }
      if (!zb || !zb.attach(id, s)) return C_HOLD;
      this._occ[s] = id; this._grabT[s] = 0;
      this._startRing(s);
      if (!this._climbSeen) { this._climbSeen = true; this._seen(SEEN[1]); this._lesson('escort.climber', null, 4); }
      return C_ATTACH;
    }
    return C_HOLD;
  }

  /** A brute's swing at the nose: a front plate loses bruteCost hits; from brute.from with no front plate it takes a survivor. */
  _onSwing() {
    if (this._state !== ST_RUN) return;
    const f = this._plateHp[4] > 0 ? 4 : (this._plateHp[5] > 0 ? 5 : -1);
    if (f >= 0) { this._plateHit(f, ESCORT.plates.bruteCost); return; }
    if (!this._spec.brutes) return;
    if (!this._bruteSeen) { this._bruteSeen = true; this._lesson('escort.brute'); }
    this._loseSurvivor(this._tx, ZF);
  }

  /** zombie:die — a climber shot (or knocked) off frees its slot. */
  _onZombieDie(id) {
    for (let s = 0; s < NS; s++) if (this._occ[s] === id) { this._occ[s] = -1; this._grabT[s] = 0; this._removeRing(s); return; }
  }

  /** The grab gauge filled: the climber leaps off with a survivor. */
  _grab(s) {
    const id = this._occ[s];
    this._occ[s] = -1; this._grabT[s] = 0; this._removeRing(s);
    const zb = this.ctx.zombies;
    if (zb) zb.detach(id, 'grab');
    this._loseSurvivor(this._tx + SLX[s], ZC + SLZ[s]);
  }

  /** One survivor off the truck at (x, z): the cue, the GRABBED! label, a falling figure; 0 left is TRUCK OVERRUN. */
  _loseSurvivor(x, z) {
    if (this._survivors <= 0) return;
    this._survivors--;
    this._lost++;
    P_CUE.x = x; P_CUE.z = z; P_CUE.survivors = this._survivors;
    this._emit('escort:grab', P_CUE);
    this._lossN = this._t - this._lossAt < 1.5 ? this._lossN + 1 : 1;   // 1.6.0: −n, merged over 1.5 s
    this._lossAt = this._t;
    P_PILL.merge = true; this._pill('escort.grab', STRINGS.escort.minus(this._lossN), x, ET.bedY + 1.4, z, 1.2); P_PILL.merge = false;
    this._tally++; this._counter();
    if (this.ctx.fx) this.ctx.fx.haptic(20);
    this._figStart(1, x, z);
    this._hud();
    if (this._survivors <= 0) {
      const lvl = this.ctx.level;
      this._end(ST_LOST);
      if (lvl && lvl.finish) lvl.finish(false, 'truck');
    }
  }

  /** PLATE: the occupied slot with the fullest gauge loses its climber ('crush', coins) and is plated; else the free unplated slot
   *  facing the most zombies ahead in the truck's band (front first, then the lower index). Refused at 0 plates / all plated. */
  _pressPlate() {
    if (this._state !== ST_RUN || this._plates <= 0) return;
    let s = -1, best = -1;
    for (let i = 0; i < NS; i++) if (this._occ[i] >= 0 && this._plateHp[i] <= 0 && this._grabT[i] > best) { best = this._grabT[i]; s = i; }
    if (s >= 0) {
      const id = this._occ[s];
      this._occ[s] = -1; this._grabT[s] = 0; this._removeRing(s);
      const zb = this.ctx.zombies;
      if (zb) zb.detach(id, 'crush');
    } else {
      const side = this._massSide();
      for (let k = 2; k >= 0 && s < 0; k--) {
        if (this._plateHp[k * 2 + side] <= 0) s = k * 2 + side;
        else if (this._plateHp[k * 2 + 1 - side] <= 0) s = k * 2 + 1 - side;
      }
      if (s < 0) return;                                 // every slot plated (the button is disabled then)
    }
    this._plates--;
    this._presses++;
    this._plateHp[s] = this._spec.plateHp;
    this._seen(SEEN[2]);
    P_CUE.x = this._tx + SLX[s]; P_CUE.z = ZC + SLZ[s]; P_CUE.survivors = this._survivors;
    this._emit('escort:plate', P_CUE);
    this._done('escort.plate');
    this._emitAction(true);
  }

  /** The side (0 left, 1 right) with more live zombies ahead of the truck inside its band (ties: left). Event time. */
  _massSide() {
    const zb = this.ctx.zombies;
    if (!zb || !zb.forEachAlive) return 0;
    const tx = this._tx, lim = ET.halfW + 1.0;
    let l = 0, r = 0;
    zb.forEachAlive((id, type, x, z) => { if (z < ZF && z > ZF - 40 && x > tx - lim && x < tx + lim) { if (x < tx) l++; else r++; } });
    return r > l ? 1 : 0;
  }

  /** Plate s loses n hits; at 0 it breaks off with sparks. */
  _plateHit(s, n) {
    const hp = this._plateHp[s] - n;
    this._plateHp[s] = hp > 0 ? hp : 0;
    if (hp > 0) return;
    const x = this._tx + SLX[s] + (SLX[s] < 0 ? -0.2 : 0.2), z = ZC + SLZ[s];
    P_CUE.x = x; P_CUE.z = z; P_CUE.survivors = this._survivors;
    this._emit('escort:break', P_CUE);
    P_BURST.kind = 'spark'; P_BURST.x = x; P_BURST.y = ET.bedY + 0.3; P_BURST.z = z; P_BURST.n = 10;
    this._emit('fx:burst', P_BURST);
    this._emitAction(true);
  }

  _startRing(s) {
    const fx = this.ctx.fx;
    if (!fx || !fx.decal || this._ring[s] >= 0) return;
    const id = fx.decal('ring', this._tx + SLX[s], ZC + SLZ[s], 1.3, Infinity, EL.ring, true);
    this._ring[s] = typeof id === 'number' && id >= 0 ? id : -1;
  }

  _removeRing(s) { const fx = this.ctx.fx; if (this._ring[s] >= 0 && fx) fx.removeDecal(this._ring[s]); this._ring[s] = -1; }

  _removeRings() { if (this._ring) for (let s = 0; s < NS; s++) this._removeRing(s); }

  // -------------------------------------------------------------------------------------------
  // Checkpoint, safe zone, the end
  // -------------------------------------------------------------------------------------------

  _checkpoint() {
    const sp = this._spec;
    this._cpDone = true;
    const was = this._survivors;
    this._survivors += sp.board;
    this._tally = 0; this._counter();
    this._plates += ESCORT.plates.checkpoint;
    this._popT = 0.45;
    P_CUE.x = this._tx; P_CUE.z = ZC; P_CUE.survivors = this._survivors;
    this._emit('escort:checkpoint', P_CUE);
    this._banner(STRINGS.escort.checkpoint, STRINGS.escort.roll(was, this._survivors, sp.board), EH.banner, EH.bannerS);
    this._pill('escort.plates', STRINGS.escort.plus(ESCORT.plates.checkpoint), this._tx, ET.bedY + 2.0, ZC, 1.4);
    this._seen(SEEN[3]);
    this._lesson('escort.checkpoint', null, 3);
    this._emitAction(true);
    this._hud();
  }

  /** The truck reaches the safe zone with ≥ 1 survivor: delivered; level's win theatre (zombies cleared), the figures hop off. */
  _safeZone() {
    this._delivered = this._survivors;
    this._end(ST_WON);
    this._deliverT = 0; this._deliverN = 0;
    const lvl = this.ctx.level;
    if (lvl && lvl.finish) lvl.finish(true, 'delivered');
  }

  _end(st) {
    if (this._state !== ST_RUN) return;
    this._state = st;
    const wp = this.ctx.weapons;
    if (wp && wp.setTracerClip) wp.setTracerClip(NaN, NaN, NaN);
    this._removeRings();
    for (let s = 0; s < NS; s++) this._occ[s] = -1;
    this._blink = 0;
    this._hudOff();
    if (this.botView) { this.botView.state = VIEW_STATES[st]; this.botView.delivered = this._delivered; this.botView.survivors = this._survivors; }
  }

  /** Delivered figures hop off one per tickS (the rising tick), then the count label goes. */
  _stepDeliver(dt) {
    this._deliverT += dt;
    const n = Math.min(this._delivered, Math.floor(this._deliverT / EB.tickS));
    while (this._deliverN < n) {
      this._deliverN++;
      P_CUE.x = this._tx; P_CUE.z = ZC; P_CUE.survivors = this._deliverN;
      this._emit('escort:delivered', P_CUE);
      if (this._deliverN <= FIG_BED) this._figStart(2, this._tx, ZC);
    }
    if (this._deliverN >= this._delivered && this._deliverT > (this._delivered + 4) * EB.tickS) this._deliverT = -1;
  }

  /** level commits the result: the scene stays until reset(). */
  end() {
    if (this._state === ST_RUN) this._end(ST_LOST);
  }

  /** Delivered at the safe zone (the stars count them against spec.T); before it, on the truck. */
  metric() { return this._state === ST_WON ? this._delivered : this._survivors; }

  /** A keepsRun mode's lost fraction is the run's (level.js, PLAN C2); this is only the escort's share for the debug overlay. */
  fraction() { const sp = this._spec; return sp ? clamp(this.ctx.world.distance / sp.safeZone, 0, 1) : 0; }

  /** The results' report (level resets the fields first). kills = delivered (no kills line: SURVIVORS DELIVERED reads the metric). */
  stat(out) {
    const won = this._state === ST_WON, L = this._spec ? this._spec.L : 0;
    out.presses = this._presses;                         // C14: a PLATE press is input (never a counted decision)
    out.total = this._spec ? this._spec.T : 0;
    out.kills = 0;
    out.kits = 0;
    out.score = won ? ESCORT.score.delivered * this._delivered + (this._lost === 0 ? ESCORT.score.noLoss : 0) : 0;
    out.bonus = won ? ESCORT.coins.perSurvivorL * L * this._delivered : 0;
    return out;
  }

  /** Debug (?debug=1): 'run' jumps to just before the gauntlet (once begun), 'win' to the safe zone. */
  debugSkip(kind) {
    if (this._state !== ST_RUN) return false;
    const w = this.ctx.world, sp = this._spec;
    if (kind === 'run') { if (w.distance >= sp.gauntlet - 30) return false; w.distance = sp.gauntlet - 30; return true; }
    if (kind === 'win') { w.distance = sp.safeZone; return true; }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // HUD kit, lessons, the FIELD GUIDE
  // -------------------------------------------------------------------------------------------

  /** 10 Hz: the progress cells (to the CHECKPOINT, then the SAFE ZONE; the flag at the end) and the PLATE button on change. */
  _hud() {
    const sp = this._spec;
    if (!sp || this._state !== ST_RUN) return;
    const d = this.ctx.world.distance;
    const cp = sp.checkpoint;
    P_PROGRESS.filled = d < cp ? clamp(d / cp, 0, 1) : 1 + clamp((d - cp) / Math.max(1, sp.safeZone - cp), 0, 1);
    P_PROGRESS.label = this._cpDone ? STRINGS.escort.safeZone : STRINGS.escort.checkpoint;
    this._emit('hud:progress', P_PROGRESS);
    this._emitAction(false);
  }

  _emitAction(force) {
    let open = false;
    for (let s = 0; s < NS; s++) if (this._plateHp[s] <= 0) { open = true; break; }
    const disabled = this._plates <= 0 || !open;
    if (!force && this._lastBadge === this._plates && this._lastDisabled === disabled) return;
    this._lastBadge = this._plates; this._lastDisabled = disabled;
    P_ACTION.on = this._state === ST_RUN; P_ACTION.icon = 'plate'; P_ACTION.badge = this._plates; P_ACTION.disabled = disabled;
    P_ACTION.label = STRINGS.escort.plate;
    this._emit('hud:action', P_ACTION);
  }

  /** The HUD the escort put up goes (the end of the run, or a quit). */
  _hudOff() {
    P_ACTION.on = false;
    this._emit('hud:action', P_ACTION);
    this._tally = 0; this._counter();
    this._lastBadge = -1;
  }

  _counter() { P_COUNTER.on = this._tally > 0; P_COUNTER.text = STRINGS.escort.lost(this._tally); this._emit('hud:counter', P_COUNTER); }

  _banner(text, kicker, color, seconds) {
    P_BANNER.text = text; P_BANNER.kicker = kicker || ''; P_BANNER.color = color; P_BANNER.seconds = seconds;
    this._emit('hud:banner', P_BANNER);
  }

  /** A short world label ('GRABBED!', '+1 PLATE') at a projected point. */
  _pill(id, text, x, y, z, seconds) {
    const r = this.ctx.render;
    P_PILL.id = id; P_PILL.icon = 'plate'; P_PILL.text = text; P_PILL.seconds = seconds; P_PILL.x = 0; P_PILL.y = 0;
    if (r && r.worldToScreen) { V3.set(x, y, z); r.worldToScreen(V3, SCR); P_PILL.x = SCR.x; P_PILL.y = SCR.y; }
    this._emit('hud:pill', P_PILL);
  }

  /** level.showHint (once ever per save; ui marks it); priority cuts a toast. */
  _lesson(id, arg, hold, release, priority) {
    const lvl = this.ctx.level;
    if (!lvl || !lvl.showHint) return false;
    HINT_OPTS.hold = hold > 0 ? hold : 0; HINT_OPTS.until = release || null; HINT_OPTS.priority = !!priority; HINT_OPTS.event = -1;
    return lvl.showHint(id, arg, HINT_OPTS);
  }

  _done(id) { const save = this.ctx.save; if (save && save.markHint) save.markHint(id); }

  /** The FIELD GUIDE entry `id` met in play (save.hints 'seen:<id>', as level's and hold's). */
  _seen(id) { this._done('seen:' + id); }

  _emit(name, payload) { const ev = this.ctx.events; if (ev) ev.emit(name, payload); }

  /** botView (?debug=1 only): what the harness bots read; they act through steering and ui:action like a player. */
  _updateView() {
    const v = this.botView, ctx = this.ctx, sp = this._spec;
    if (!ctx.debug || !ctx.debug.enabled) return;
    v.active = this.active; v.state = VIEW_STATES[this._state];
    v.survivors = this._survivors; v.delivered = this._delivered; v.lost = this._lost; v.plates = this._plates; v.grab = sp.grab;
    for (let s = 0; s < NS; s++) { v.occ[s] = this._occ[s]; v.grabT[s] = this._grabT[s]; v.plateHp[s] = this._plateHp[s]; }
  }

  // -------------------------------------------------------------------------------------------
  // Survivor figures (cosmetic): the bed, the falling ones, the delivered ones
  // -------------------------------------------------------------------------------------------

  /** An fx figure: kind 1 falls off the side at (x, z), kind 2 hops off forward. Overwrites the oldest when all are busy. */
  _figStart(kind, x, z) {
    let f = FIG_BED, oldest = -1;
    for (let i = FIG_BED; i < FIG_CAP; i++) { if (this._figT[i] < 0) { f = i; oldest = -1; break; } if (this._figT[i] > oldest) { oldest = this._figT[i]; f = i; } }
    this._figT[f] = 0; this._figX[f] = x; this._figZ[f] = z; this._figK[f] = kind;
  }

  _stepFigs(dt) {
    if (this._popT > 0) this._popT = Math.max(0, this._popT - dt);
    for (let i = FIG_BED; i < FIG_CAP; i++) {
      if (this._figT[i] < 0) continue;
      this._figT[i] += dt;
      if (this._figT[i] > EB.hopS * 1.6) this._figT[i] = -1;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Render (instance matrices, the ribbon, props, the count label; after the systems' fixed steps)
  // -------------------------------------------------------------------------------------------

  render(alpha) {
    if (!this.active || !this._group) return;
    const ctx = this.ctx, sp = this._spec, w = ctx.world;
    const v = w.roadSpeed;
    const d = w.distance + v * alpha * (1 / 60);
    const tx = this._state === ST_RUN ? this._routeX(d) : this._tx;
    const t = this._t;
    // the truck (a little bounce), its blinkers (3 Hz)
    const truck = this._truck;
    truck.position.set(tx, 0.02 * Math.sin(t * 9.1), ZC);
    truck.rotation.z = 0.012 * Math.sin(t * 5.3);
    const on = this._blink !== 0 && (t * 3) % 1 < 0.55;
    this._blinkL.visible = on && this._blink < 0;
    this._blinkR.visible = on && this._blink > 0;
    this._renderFigs(tx, t);
    this._renderPlates(tx);
    this._renderRibbon(d);
    // the checkpoint post and the safe zone ride in on the road
    const cpz = ZC + (d - sp.checkpoint), szz = ZF + (d - sp.safeZone);
    this._cpMesh.visible = cpz > EP.appearZ && cpz < 20;
    if (this._cpMesh.visible) this._cpMesh.position.set((this._routeX(sp.checkpoint) < 0 ? 1 : -1) * (EP.cpX + CP_SIDE), 0, cpz);
    this._szMesh.visible = szz > EP.appearZ && szz < 20;
    if (this._szMesh.visible) this._szMesh.position.set(0, 0, szz);
    // the survivors' count over the cab (fx.label2; red for the last few or under 40 %; 1.6.0: a loss punches it)
    const fx = ctx.fx, run = this._state === ST_RUN;
    if (fx && fx.label2) {
      if (run || this._deliverT >= 0) {
        const n = run ? this._survivors : Math.max(0, this._delivered - this._deliverN), a = run ? t - this._lossAt : 9, low = run && n < 0.4 * sp.T;
        fx.label2.set(EH.slot, n, '', n <= EH.lowAt || low || a < 0.3 ? EH.low : EH.color, a < 0.35 ? EH.px * (1.4 - a * 8 / 7) : EH.px, tx, EH.y, ZC - 1.6, 0);
      } else fx.label2.hide(EH.slot);
    }
    // 1.6.0: the squad's label slides clear of the tailgate (6 px), outward
    const lb = fx && fx.label, r = ctx.render;
    if (!run || !lb || !lb.hasPos || !r || !r.worldToScreen) return;
    const lx = sx(r, lb.x, lb.y, lb.z), hw = lb.width * 0.5 / lb.mPerPx + 6;
    const l = sx(r, tx - ET.halfW - 0.3, 1, ZR) - hw, rr = sx(r, tx + ET.halfW + 0.3, 1, ZR) + hw;
    let s = this._slide;
    const want = lx > l && lx < rr ? ((s * s > 0.25 ? s > 0 : lb.x > tx || (lb.x === tx && tx < 0)) ? rr : l) - lx : 0;
    this._slide = s += (want - s) * Math.min(1, (ctx.time ? ctx.time.dt : 0.017) / 0.15);
    if (s * s > 0.25) lb.setWorldPos(lb.x + s * lb.mPerPx, lb.y, lb.z);
  }

  /** The bed's figures (2 rows of 6, facing the squad, swaying) and the fx figures; a boarding pop scales the newest in. */
  _renderFigs(tx, t) {
    const inst = this._figs;
    const shown = this._state === ST_WON ? Math.max(0, Math.min(FIG_BED, this._delivered - this._deliverN)) : Math.min(FIG_BED, this._survivors);
    let n = 0;
    const by = ET.bedY;
    for (let i = 0; i < shown; i++) {
      const row = i < 6 ? 0 : 1, col = i % 6;
      const x = tx + (col - 2.5) * EB.dx + (row ? 0.15 : 0);
      const z = ZC + EB.rows[row];
      const sway = 0.08 * Math.sin(t * (2.1 + hash01(i) * 1.3) + i);
      const sc = this._popT > 0 && i >= shown - this._spec.board ? 1 - this._popT / 0.45 : 1;
      inst.writeMatrix(n, x, by, z, Math.PI + sway, 0, sc > 0.01 ? sc : 0.01);
      n++;
    }
    for (let i = FIG_BED; i < FIG_CAP; i++) {
      const a = this._figT[i];
      if (a < 0) continue;
      const u = a / EB.hopS;
      let x = this._figX[i], y = by, z = this._figZ[i], pitch = 0;
      if (this._figK[i] === 1) {                         // dragged off the side: out, down, left behind by the road
        const sd = x < tx ? -1 : 1;
        x += sd * 1.4 * Math.min(1, u);
        y = by + 0.8 * Math.sin(Math.PI * Math.min(1, u)) - by * Math.min(1, u);
        z += this.ctx.world.roadSpeed * a * 0.8;
        pitch = 1.2 * Math.min(1, u);
      } else {                                          // delivered: hops down and runs ahead into the safe zone
        z -= 5 * a;
        y = Math.max(0, by * (1 - u));
      }
      const sc = u < 1.2 ? 1 : Math.max(0.01, 1 - (u - 1.2) * 2.5);
      inst.writeMatrix(n, x, y, z, this._figK[i] === 1 ? Math.PI : 0, pitch, sc);
      n++;
    }
    inst.mesh.count = n;
    inst.count = n;
    inst.mesh.visible = n > 0;
    inst.commit();
  }

  /** One plate per plated slot, on its rail. */
  _renderPlates(tx) {
    const m = this._plateMesh, a = m.instanceMatrix.array;
    let n = 0;
    for (let s = 0; s < NS; s++) {
      if (this._plateHp[s] <= 0) continue;
      const o = n * 16;
      a[o] = 1; a[o + 1] = 0; a[o + 2] = 0; a[o + 3] = 0;
      a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0;
      a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = 1; a[o + 11] = 0;
      a[o + 12] = tx + (SLX[s] < 0 ? -1 : 1) * (ET.halfW + PLATE_PAD); a[o + 13] = ET.bedY + 0.3; a[o + 14] = ZC + SLZ[s]; a[o + 15] = 1;
      n++;
    }
    m.count = n;
    m.visible = n > 0;
    if (n > 0) m.instanceMatrix.needsUpdate = true;
  }

  /** The route ahead: RIB rows every RIB_STEP m from the nose, at the truck's x when it will be there; dashes scroll with the road
   *  and fade at the far end. Positions and colours are rewritten in place. */
  _renderRibbon(d) {
    const pos = this._ribPos, col = this._ribCol, hw = EH.ribbonW * 0.5;
    const live = this._state === ST_RUN;
    for (let i = 0; i < RIB; i++) {
      const ahead = i * RIB_STEP;
      const x = this._routeX(d + ahead), z = ZF - ahead;
      const o = i * 6;
      pos[o] = x - hw; pos[o + 1] = 0.035; pos[o + 2] = z;
      pos[o + 3] = x + hw; pos[o + 4] = 0.035; pos[o + 5] = z;
      const dash = 0.55 + 0.45 * Math.cos((d + ahead) * 1.4);
      const fade = live ? (1 - i / RIB) * (i === 0 ? 0 : 1) : 0;
      const al = 0.55 * dash * fade;
      const c = i * 8;
      col[c + 3] = al; col[c + 7] = al;
    }
    this._ribGeo.attributes.position.needsUpdate = true;
    this._ribGeo.attributes.color.needsUpdate = true;
  }

  // -------------------------------------------------------------------------------------------
  // Build (once, at the first prepare / begin)
  // -------------------------------------------------------------------------------------------

  _build() {
    if (this._built) return;
    const ctx = this.ctx, models = ctx.models, r = ctx.render;
    const g = new Group();
    g.name = 'escort';
    g.visible = false;
    // the truck (5 draws)
    this._truck = models.buildRescueTruck();
    this._blinkL = this._truck.getObjectByName('blinkL');
    this._blinkR = this._truck.getObjectByName('blinkR');
    this._truck.traverse((o) => { if (o.isMesh) { o.castShadow = o.name === 'body'; o.receiveShadow = false; } });
    g.add(this._truck);
    // survivors: the character class (one draw), plates (one instanced draw)
    this._figs = new CharacterInstances(ctx, 'survivor', FIG_CAP, { castShadow: false, receiveShadow: false });
    for (let i = 0; i < FIG_CAP; i++) {
      const k = this._figs.alloc();
      const hex = EB.palette[i % EB.palette.length];
      this._figs.setTint(k, ((hex >> 16) & 255) / 255 * 1.1, ((hex >> 8) & 255) / 255 * 1.1, (hex & 255) / 255 * 1.1);
      this._figs.setPhase(k, i * 1.7);
      this._figs.setSpeed(k, 0.6 + 0.08 * (i % 5));
    }
    this._figs.mesh.count = 0;
    g.add(this._figs.mesh);
    const plateMat = r && r.materials && r.materials.standard ? r.materials.standard(0xffffff, { vertexColors: true, roughness: 0.45, metalness: 0.7 }) : null;
    this._plateMesh = new InstancedMesh(models.geo.escortPlate, plateMat, NS);
    this._plateMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this._plateMesh.frustumCulled = false;
    this._plateMesh.count = 0;
    this._plateMesh.name = 'escort.plates';
    g.add(this._plateMesh);
    // the ribbon: RIB × 2 vertices, rgba vertex colours (additive-looking, no depth write)
    const geo = new BufferGeometry();
    this._ribPos = new Float32Array(RIB * 6);
    this._ribCol = new Float32Array(RIB * 8);
    const rc = EL.ribbon;
    for (let i = 0; i < RIB * 2; i++) { this._ribCol[i * 4] = ((rc >> 16) & 255) / 255; this._ribCol[i * 4 + 1] = ((rc >> 8) & 255) / 255; this._ribCol[i * 4 + 2] = (rc & 255) / 255; }
    const idx = new Uint16Array((RIB - 1) * 6);
    for (let i = 0; i < RIB - 1; i++) { const a = i * 2, o = i * 6; idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2; idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2; }   // faces up
    geo.setAttribute('position', new BufferAttribute(this._ribPos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('color', new BufferAttribute(this._ribCol, 4).setUsage(DynamicDrawUsage));
    geo.setIndex(new BufferAttribute(idx, 1));
    geo.userData.escortOwned = true;
    this._ribGeo = geo;
    const ribMat = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false });
    ribMat.userData.escortOwned = true;
    const rib = new Mesh(geo, ribMat);
    rib.name = 'escort.ribbon';
    rib.frustumCulled = false;
    rib.renderOrder = 1;
    g.add(rib);
    // the checkpoint post and the safe zone (one draw each, while on the road)
    const propMat = r && r.materials && r.materials.standard ? r.materials.standard(0xffffff, { vertexColors: true, roughness: 0.85, metalness: 0 }) : null;
    this._cpMesh = new Mesh(models.geo.escortCheckpoint, propMat);
    this._cpMesh.name = 'escort.checkpoint';
    this._szMesh = new Mesh(models.geo.escortSafe, propMat);
    this._szMesh.name = 'escort.safe';
    this._cpMesh.castShadow = true; this._szMesh.castShadow = true;
    g.add(this._cpMesh, this._szMesh);
    if (r && r.scene) r.scene.add(g);
    this._group = g;
    this._built = true;
  }
}
