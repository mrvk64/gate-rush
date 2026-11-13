// js/hold.js — ctx.hold, the Horde hold: a ModeSystem (PLAN ARCH §5; PLAN horde; P6 on the P0 skeleton).
//
// A Horde level runs the gates, then digs in at its script's 'hold' event (level.js _beginMode → begin): the road stops with the
// barricade face at z −3.9, the squad files onto the firing step (squad 'wall'), the camera takes the hold rig, the drag aims a
// FIRE LANE (engine 'aim'), and 3 surges of thousands of crowd units (ctx.crowd) press the wall until the boss (boss.js hold
// mode) dies — or the squad is lost, or all four sections stay down for HORDE.wall.overrunS (LINE OVERRUN).
//
// WHAT THIS MODULE OWNS (tools/holdsim.js models the same rules; HORDE = its RULES)
// - The spawn timetable: holdsim's buildSpawns, ported draw for draw (mulberry32 of the hold seed), fed to crowd.queue a little
//   ahead of time and never past an undecided surge: unit HP = max(1, baseHp·hzShop) × holdLiveHp(r) × (its surge eased ?
//   spec.firstMeet.threat : 1) × opts.threat (A9: the ease and the below-E_hold relief act on HP, never on what is on screen).
// - First meeting (D29): surge 1 eased when the run had ≥ surge1NeedsDecisions counted gate decisions; surge i ≥ 2 (and the
//   trickle after it) when a counted HOLD ACTION (D30: the lane target travelled ≥ HORDE.actions.laneM, a repair, or an opened
//   crate) fell in the LEVELS.curve.assist.windowS s before it spawned. Windows also open at every boss wind-up; one action per
//   window; holdActions / holdSurgeWindows feed the REINFORCEMENTS streak (level.js) through stat().
// - The wall (crowd RULES, called in the crowd's phase B at 30 Hz): claw slots (holders pinned in MODE.HOLD while they claw; on a
//   section the lane does not cover, the pile keeps them full and clawing), the pile and its climbers, breach tokens and PASS
//   units, bites (troops.apcAbsorb first), brutes at the line, spitters holding inside the fire columns and lobbing, runners
//   re-targeting the weakest section; repairs, rebuilds (after the gap stayed clear), the overrun clock.
// - The fire (weapons.setPolicy): laneShare of the folded rounds (HORDE.fire.rateCap per s, squad DPS = C·f·d·0.8) leave from the
//   in-lane shooters at weight FOCUS × FIRE.accuracy, walking across their 1 m column; the boss share β by per-shooter
//   accumulators (bossOnly rounds at the boss's chest), the spitter share applied straight to the holding spitter,
//   weaponFrame = the lane, pierce down the column.
// - Kits (start + run crates + assist k, cap + k: D35), REPAIR / bubbles / keys, supply drops (the lane on the crate for
//   HORDE.supply.openS), the airstrike, troop placement, lessons at first sight (D40), the HUD kit events, the score terms.
// - The barricade (one merged mesh per district look: 4 plank sections whose planks fall as HP drops, posts, sandbags, the side
//   closures, the wing walls, the firing step: 1 main + 1 shadow draw, the standard material) and the marks (section bars,
//   the lane band with its focus glow, crate rings: one instanced draw). They show on the road from HORDE.stop.appearZ.
//
// Contract (ARCH §5): init / reset / dispose / active / prepare() / programsReady / begin(script, opts) / fireEvent / step /
// render / metric (survivors at the boss kill) / fraction (the hold's part, 0–1) / stat(out) / debugSkip / end / botView.
// Events (reused payloads): horde:start / surge / segment / breach / repair / kits / supply / airstrike / stagger / focus (≤ 10 Hz) /
// left (10 Hz) / collapse (the countdown, each second) / overrun / end; hud:progress / counter / anchors / action / banner / pill;
// hint:release; audio:loop / music:mode; fx:burst / fx:decal. Listens: ui:anchorTap { id }, ui:action, boss:dead, squad:dead,
// level:start. Determinism: the hold seed is the run seed + HOLD_SEED (gameplay); cosmetics draw ctx.rngFx or hashes. Hot
// paths make no objects or arrays (the timetable is built once per hold, at its start); what V8 still boxes for double
// arguments (_mark, crowd.queue, segCx) is about 3 KB per step.
import {
  BufferGeometry, BufferAttribute, Mesh, Group, MeshStandardMaterial, InstancedBufferGeometry, InstancedBufferAttribute,
  PlaneGeometry, ShaderMaterial, Color, Vector3, DynamicDrawUsage, DoubleSide,
} from 'three';
import { Rng, mulberry32, clamp, warnOnce, holdHpScale, holdLiveScale, holdLiveHp, holdBossHp, holdFocusRate } from './util.js';
import { HORDE, HORDE_GEN, CROWD, FIRE, LEVELS, ZOMBIES, WEAPONS, TROOPS, JUICE, STRINGS, PALETTE, districtForLevel } from './data.js';

// ---------------------------------------------------------------------------------------------
// Constants (tuning lives in data.js HORDE; module aliases only)
// ---------------------------------------------------------------------------------------------
const HF = HORDE.field, HW = HORDE.wall, HK = HORDE.kits, HFI = HORDE.fire, HB = HORDE.boss, HS = HORDE.supply;
const HA = HORDE.airstrike, HSP = HORDE.spit, HBS = HORDE.bruteSwing, HL = HORDE.lessons, HH = HORDE.hud, HM = HORDE.marks;
const NSEC = HF.sections;
const TYPES = ZOMBIES.common.types;                    // crowd type indices (walker, runner, crawler, brute, spitter)
const T_RUNNER = TYPES.indexOf('runner'), T_BRUTE = TYPES.indexOf('brute'), T_SPITTER = TYPES.indexOf('spitter');
const W_ = 0, R_ = 1, C_ = 2, B_ = 3, S_ = 4;          // buildSpawns' type codes (holdsim's) = the crowd's indices
const BASE_HP = [HORDE_GEN.baseHp.walker, HORDE_GEN.baseHp.runner, HORDE_GEN.baseHp.crawler, HORDE_GEN.baseHp.brute, HORDE_GEN.baseHp.spitter];
const HOLD_SEED = 17;                                   // the hold's gameplay seed = run seed + 17 (fx 7, shots 13)
const CROWD_SEED = 0x51ED;                              // the crowd's streams: the hold seed ^ this
const PASS_HP = 1e6;                                    // a lunging breacher outside the lane is past the rifles
const GOLD = 0.6180339887;                              // the golden step: successive rounds spread evenly over a column
const FEED_LEAD = 0.5;                                  // s: timetable units queued this far ahead (never past an undecided surge)
const PILE_Z = HF.wallZ - HW.pileZone;
const CROWD_R = CROWD.radius;                           // the squad line a climber / breacher reaches = front − r
const RETARGET_Z = HORDE.runner.retargetZ;
const FACE_Z = HF.wallZ - CROWD_R, SLOT_Z = FACE_Z - HW.slotReach;   // a holder's line; a pile unit this near takes a free slot
const ST_IDLE = 0, ST_STOP = 1, ST_HOLD = 2, ST_WON = 3, ST_LOST = 4;
const VIEW_STATES = ['idle', 'stop', 'hold', 'won', 'lost'];
const MAX_SHOOTERS = FIRE.shooters;
const SOURCES = ['', 'lane', 'repair', 'crate'];
const SECTION_STATES = ['intact', 'damaged', 'critical', 'breached'];
const ANCHOR_STATES = ['', 'repair', 'gap', 'rebuild', 'nokits', 'busy'];
const A_NONE = 0, A_REPAIR = 1, A_GAP = 2, A_REBUILD = 3, A_NOKITS = 4, A_BUSY = 5;

/** Section of a world x (the 4 sections of HF.segW over ±HF.wallHalf). */
function segOf(x) { const s = Math.floor((x + HF.wallHalf) / HF.segW); return s < 0 ? 0 : (s >= NSEC ? NSEC - 1 : s); }
/** Centre x of section s. */
function segCx(s) { return -HF.wallHalf + HF.segW * (s + 0.5); }
/** The side a surge pattern starts on (−1 left, 1 right, 0 both). */
function sideOf(p) { return p === 'flankL' || p === 'sweepLR' ? -1 : (p === 'flankR' || p === 'sweepRL' ? 1 : 0); }
/** A stable [0, 1) hash of an integer (cosmetic choices that must not draw a stream). */
function hash01(n) { let h = Math.imul(n ^ 0x9E3779B9, 0x85EBCA6B); h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); h ^= h >>> 16; return (h >>> 0) / 4294967296; }

// ---------------------------------------------------------------------------------------------
// Module-level reused payloads (listeners never retain them, ARCH §5)
// ---------------------------------------------------------------------------------------------
const P_START = { level: 0, eHold: 0, kits: 0, cap: 0, assistK: 0, surges: 0, variant: '', boss: '', firstMeet: false, eased: false };
const P_SURGE = { i: 0, n: 0, pattern: '', side: 0, double: false, eased: false, source: '' };
const P_SEGMENT = { i: 0, hp: -0, state: '' };
const P_BREACH = { i: 0, x: -0, z: -0 };
const P_REPAIR = { i: 0, kits: 0, rebuild: false, x: -0, z: -0 };
const P_KITS = { kits: 0, cap: 0, delta: 0, source: '' };
const P_SUPPLY = { i: 0, x: -0, z: -0, kind: '', kits: 0 };
const P_AIR = { x: -0, z: -0 };
const P_STAG = { x: -0, z: -0, staggers: 0 };
const P_FOCUS = { level: 0 };
const P_LEFT = { left: 0, alive: 0, queued: 0 };
const P_COLLAPSE = { left: 0 };
const P_OVERRUN = { level: 0 };
const P_END = { won: false, cause: '', kills: 0, survivors: 0 };
const P_PROGRESS = { variant: 'segments', segments: 3, filled: -0, endIcon: 'skull', label: '', boss: false };
const P_COUNTER = { on: false, text: '', value: 0 };
const ANCHOR_ROWS = [0, 1, 2, 3].map((i) => ({ id: i, x: -0, y: -0, state: '', label: '' }));
const P_ANCHORS = { list: [], n: 0 };
const P_ACTION = { on: false, icon: 'kit', badge: 0, disabled: false, label: '' };
const P_BANNER = { text: '', kicker: '', color: 0, seconds: -0 };
const P_PILL = { id: '', icon: '', text: '', seconds: -0, x: -0, y: -0 };
const P_RELEASE = { key: '' };
const P_LOOP = { id: 'hold_roar', on: false, gain: -0 };
const P_MUSIC = { mode: 'hold', restart: false, swell: false };
const P_BURST = { kind: '', x: -0, y: -0, z: -0, n: 0 };
const P_DECAL = { kind: '', x: -0, z: -0, size: -0, seconds: -0, color: 0, top: false, id: -1 };
const HINT_OPTS = { hold: -0, until: null, priority: false, event: -1 };
const MINION_HP = { walker: 1, runner: 1, crawler: 1, brute: 1, spitter: 1 };
const BOSS_SPEC = { id: '', archetype: 'hulk', hp: 1, capHp: 1, minionHp: MINION_HP, x: 0, z: -0 };
const V3 = new Vector3();
const SCR = { x: -0, y: -0 };
const CELL_OUT = { x: -0, z: -0, n: 0 };

// ---------------------------------------------------------------------------------------------
// The marks: one instanced draw of flat / upright quads (section bars, the lane band, crate rings)
// ---------------------------------------------------------------------------------------------
const MARK_VERT = /* glsl */`
attribute vec4 aPos;     // x, y, z, kind (0 bar, 1 lane band, 2 ring, 3 cross)
attribute vec4 aSize;    // half width, half height (or depth), fill 0–1, glow
attribute vec4 aCol;     // linear rgb, alpha
uniform float uTime;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vSize;
varying float vKind;
void main() {
  vUv = position.xy * 2.0;   // −1 … 1
  vCol = aCol; vSize = aSize; vKind = aPos.w;
  vec3 p = aPos.xyz;
  if (aPos.w < 0.5) {
    // upright bar facing the camera's horizontal direction (a hold camera looks straight down −Z)
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    p += right * (position.x * 2.0 * aSize.x) + up * (position.y * 2.0 * aSize.y);
  } else {
    p += vec3(position.x * 2.0 * aSize.x, 0.0, -position.y * 2.0 * aSize.y);   // flat on the ground
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const MARK_FRAG = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vSize;
varying float vKind;
void main() {
  float a = vCol.a;
  vec3 c = vCol.rgb;
  if (vKind < 0.5) {
    // section bar: a dark frame, the fill from the left, a 2 Hz pulse when glow > 0
    float fx = vUv.x * 0.5 + 0.5;
    float edge = step(0.86, max(abs(vUv.x) * (1.0 + 0.02 / max(vSize.x, 0.01)), abs(vUv.y)));
    float fill = step(fx, vSize.z);
    float pulse = 1.0 + vSize.w * 0.6 * (0.5 + 0.5 * sin(uTime * 12.566));
    c = mix(vec3(0.04), c * pulse, fill * (1.0 - edge));
    a *= mix(0.78, 1.0, fill);
  } else if (vKind < 1.5) {
    // lane band: soft side edges, chevrons flowing toward the wall, brighter with focus (glow)
    float side = 1.0 - smoothstep(0.55, 1.0, abs(vUv.x));
    float along = vUv.y * vSize.y;
    float chev = step(0.5, fract(along * 0.6 - abs(vUv.x) * 0.5 - uTime * 0.8));
    float fade = smoothstep(-1.0, -0.6, vUv.y) * (1.0 - smoothstep(0.7, 1.0, vUv.y));
    a *= side * fade * (0.55 + 0.45 * chev) * (0.45 + 0.55 * vSize.w);
    c *= 1.0 + vSize.w * 0.8;
  } else if (vKind < 2.5) {
    // ring with a progress arc (fill): the crate's open timer
    float r = length(vUv);
    float ring = smoothstep(0.72, 0.8, r) * (1.0 - smoothstep(0.92, 1.0, r));
    float ang = atan(vUv.x, vUv.y) / 6.2831853 + 0.5;
    float arc = step(ang, vSize.z) * smoothstep(0.55, 0.62, r) * (1.0 - smoothstep(0.7, 0.76, r));
    a *= max(ring * (0.6 + 0.4 * sin(uTime * 6.0)), arc);
  } else {
    // cross (a breached section on its bar)
    float d = min(abs(vUv.x - vUv.y), abs(vUv.x + vUv.y));
    a *= (1.0 - smoothstep(0.12, 0.2, d)) * step(max(abs(vUv.x), abs(vUv.y)), 0.9);
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(c, a);
}`;
const MARK_CAP = 16;
const MK_BAR = 0, MK_LANE = 1, MK_RING = 2, MK_CROSS = 3;
const MK_HEX = [HM.ok, HM.warn, HM.bad, HM.lane, HM.crate], MC_BAD = 2, MC_LANE = 3, MC_CRATE = 4;   // the marks' colours, linear once at build

// ---------------------------------------------------------------------------------------------
// The barricade: one merged geometry of boxes, every piece tagged (section, break threshold, fallen twin, colour slot)
// ---------------------------------------------------------------------------------------------
const SLOT_PLANK = 0, SLOT_POST = 1, SLOT_SHEET = 2, SLOT_BAG = 3, SLOT_ACCENT = 4, SLOT_DEBRIS = 5, SLOT_STEP = 6, SLOT_CONCRETE = 7, SLOT_CRATE = 8, SLOT_CHUTE = 9, SLOT_GORE = 10;
const LOOK_KEYS = ['plank', 'post', 'sheet', 'bag', 'accent', 'debris'];
const CONCRETE = 0x8C8A84, CRATE_WOOD = 0x7A5A34, CHUTE = 0xE8E2D0, CHUTE_GORE = 0xF0762A;

/** A growable box builder (prepare time only). */
class BoxBuilder {
  constructor() { this.pos = []; this.nor = []; this.idx = []; this.slot = []; this.shade = []; this.pieces = []; }
  /** An oriented box (yaw about Y, then pitch about X, roll about Z) at (cx, cy, cz) of size (sx, sy, sz); returns its piece. */
  box(cx, cy, cz, sx, sy, sz, yaw, pitch, roll, slot, shade, sec, thr, fallen) {
    const base = this.pos.length / 3;
    const cyw = Math.cos(yaw || 0), syw = Math.sin(yaw || 0), cp = Math.cos(pitch || 0), sp = Math.sin(pitch || 0);
    const cr = Math.cos(roll || 0), sr = Math.sin(roll || 0);
    const rot = (x, y, z, out) => {
      let x1 = x * cr - y * sr, y1 = x * sr + y * cr, z1 = z;           // roll (Z)
      const y2 = y1 * cp - z1 * sp, z2 = y1 * sp + z1 * cp; y1 = y2; z1 = z2;   // pitch (X)
      const x3 = x1 * cyw + z1 * syw, z3 = -x1 * syw + z1 * cyw; x1 = x3; z1 = z3;   // yaw (Y)
      out[0] = x1; out[1] = y1; out[2] = z1;
    };
    const hx = sx / 2, hy = sy / 2, hz = sz / 2, v = [0, 0, 0], n = [0, 0, 0];
    const FACES = [[[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
      [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
      [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
      [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
      [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
      [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]]];
    for (let f = 0; f < 6; f++) {
      const fn = FACES[f][0], vs = FACES[f][1], b = this.pos.length / 3;
      rot(fn[0], fn[1], fn[2], n);
      // top faces a touch lighter, bottoms darker: a cheap baked occlusion on top of the lighting
      const fshade = shade * (fn[1] > 0.5 ? 1.08 : (fn[1] < -0.5 ? 0.6 : 1));
      for (let k = 0; k < 4; k++) {
        rot(vs[k][0], vs[k][1], vs[k][2], v);
        this.pos.push(cx + v[0], cy + v[1], cz + v[2]); this.nor.push(n[0], n[1], n[2]);
        this.slot.push(slot); this.shade.push(fshade);
      }
      this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const p = { start: base, count: 24, cx, cy, cz, sec: sec === undefined ? -1 : sec, thr: thr || 0, fallen: !!fallen };
    this.pieces.push(p);
    return p;
  }
}

// ---------------------------------------------------------------------------------------------
// HoldSystem
// ---------------------------------------------------------------------------------------------
export class HoldSystem {
  constructor(ctx) {
    // `f = 0.5; f = 0` seeds a float field as a heap double (never a Smi), so its first fractional store keeps the map
    this.ctx = ctx; this.active = false; this.programsReady = false; this.botView = null;
    this._state = ST_IDLE; this._t = 0.5; this._t = 0; this._stopT = 0.5; this._stopT = 0;
    this._built = false; this._prep = null; this._prepRun = null; this._group = null; this._armed = false; this._anchorD = 0.5; this._anchorD = 0;
    this._dtTick = 0.5; this._dtTick = 1 / 30; this._laneAcc = 0.5; this._laneAcc = 0;
  }

  /** Allocates every per-hold table once (no GPU work; the meshes are prepare()'s). */
  init() {
    const ctx = this.ctx;
    this._rng = new Rng(1);
    // the wall: section HP, repair left, cool-down, climb timer, breach tokens / open time, claw holders (this tick / the last
    // tick's), the pile (this tick's count from last tick's positions), units in the gap, how long the gap stayed clear
    this._hp = new Float32Array(NSEC); this._repLeft = new Float32Array(NSEC); this._cool = new Float32Array(NSEC);
    this._climbT = new Float32Array(NSEC); this._tok = new Float32Array(NSEC); this._breachT = new Float32Array(NSEC);
    this._claw = new Int32Array(NSEC); this._clawPrev = new Int32Array(NSEC); this._clawNew = new Int32Array(NSEC);
    this._pile = new Int32Array(NSEC); this._gapN = new Int32Array(NSEC); this._gapClear = new Float32Array(NSEC);
    this._contact = new Float32Array(NSEC); this._clawBeg = new Int32Array(NSEC); this._press = new Uint8Array(NSEC);
    this._secState = new Int8Array(NSEC); this._secLevel = new Int8Array(NSEC);
    this._spitCol = new Int32Array(8);
    // the lane: focus per logical shooter, the boss / spitter accumulators, the 3 s ring of lane-target travel (fixed steps)
    this._focus = new Float32Array(MAX_SHOOTERS); this._accBoss = new Float32Array(MAX_SHOOTERS);
    this._shD = new Float64Array(MAX_SHOOTERS); this._shX = new Float32Array(MAX_SHOOTERS); this._shIn = new Uint8Array(MAX_SHOOTERS);
    this._colWalk = new Float32Array(MAX_SHOOTERS); this._shList = new Uint8Array(MAX_SHOOTERS);
    this._ringN = Math.max(1, Math.round((LEVELS.curve.assist.windowS || 3) / (1 / 60)));
    this._ring = new Float32Array(this._ringN);
    // the surges: eased, the window counted, which source eased it
    this._eased = new Uint8Array(4); this._easedBy = new Uint8Array(4); this._winCounted = new Uint8Array(4); this._surgeSeen = new Uint8Array(4);
    // the timetable (holdsim buildSpawns), grown at a hold's start when a bigger one comes
    this._cap = 0; this._n = 0; this._ptr = 0; this._minions = 0;
    this._sT = null; this._sType = null; this._sX = null; this._sTx = null; this._sS = null; this._ord = null;
    // supply drops (≤ 2)
    this._sup = [0, 1].map(() => ({ t: 0.5, x: 0.5, seen: 0.5, state: 0, idx: 0, landT: 0.5, mesh: null, chute: null }));
    for (const s of this._sup) { s.t = 0; s.x = 0; s.seen = 0; s.landT = 0; }
    this._air = { on: false, t: 0.5, x: 0.5, done: 0, dmg: 0.5 }; this._air.t = 0; this._air.x = 0; this._air.dmg = 0;
    this._reset();
    // the fire policy, the troop placement, the crowd rules and the boss hooks: objects made once (no per-call closures)
    const self = this;
    this._policy = {
      pierce: HFI.pierce, tracerY: HFI.tracerY, crowdOnly: true,   // the boss takes its share (β), never the crowd's rounds that fly on
      weaponAdd: HORDE.weapons.add,                                // a stored weapon rides on the full rifle fold
      rate(C) { return self._rate(C); },
      shot(k, o) { return self._shot(k, o); },
      weaponFrame(id, f) { return self._weaponFrame(id, f); },
    };
    this._placement = { flameRange: HORDE.troops.flameReach, reachZ: HF.rangeZ, lean: true, place(key, out) { return self._place(key, out); } };
    this._rules = {
      reachZ: HF.frontZ - CROWD_R, spitZ: HSP.holdZ - HSP.spread,
      begin(dt) { self._rBegin(dt); }, end(dt) { self._rEnd(dt); },
      onWall(i) { self._rWall(i); }, onHold(i) { self._rHold(i); }, onBreach(i) { self._rBreach(i); },
      onReach(i) { self._rReach(i); }, spitHold(i) { self._rSpit(i); },
    };
    this._bossOpts = {
      holdZ: HB.holdZ, enrageS: HB.enrageS, attacks: true, debut: false, chew: HB.chewMin,
      pickSection(kind, x) { return self._bossTarget(kind, x); },
      onWindup(kind, s, sec) { self._bossWindup(kind, s, sec); },
      segmentAttack(kind, s, x, z) { self._bossAttack(kind, s, x, z); },
      onStagger(x, z) { self._bossStagger(x, z); },
      breakSection(s, dt) { return self._bossBreak(s, dt); },
      spawnBurst(type, n, x, z) { self._bossBurst(type, n, x, z); },
      pushCrowd(x, z, r) { const c = self.ctx.crowd; if (c && c.active) c.pushCircle(x, z, r); },
    };
    this.botView = {
      t: 0.5, active: false, state: '', sections: new Float32Array(NSEC), gapClear: new Uint8Array(NSEC), cool: new Float32Array(NSEC),
      repairing: new Float32Array(NSEC), kits: 0, kitsCap: 0, laneX: 0.5, laneTarget: 0.5, focusLevel: 0, surgeIndex: 0, surges: 0,
      surgeAt: new Float32Array(4), nextSurgeAt: 0.5, alive: 0, waiting: 0, queued: 0, worstSection: 0,
      threat: new Float32Array(NSEC), near: 0.5, dps: 0.5, overrunT: 0.5,
      boss: { spawned: false, alive: false, x: 0.5, z: 0.5, hp: 0.5, maxHp: 0.5, windup: -0.5, twin: false, x2: 0.5, z2: 0.5, alive2: false, windup2: -0.5,
        enraged: false, inRange: false, shield: false, arrived: false, arrivedAt: -0.5, enrageS: 0.5 },
      supply: [{ live: false, x: 0.5, seen: 0.5 }, { live: false, x: 0.5, seen: 0.5 }],
      eased: new Uint8Array(4), holdActions: 0, holdSurgeWindows: 0, stored: 0, holdSeed: 0, C: 0, C0: 0, eHold: 0, staggers: 0,
    };
    // events (listeners live as long as the system)
    const ev = ctx.events;
    if (ev) {
      ev.on('ui:anchorTap', (p) => { if (p && p.id >= 0) this._tapQ |= 1 << (p.id & 3); });
      ev.on('ui:action', () => { this._actionQ++; });
      ev.on('boss:dead', () => this._onBossDead());
      ev.on('squad:dead', () => this._onSquadDead());
      ev.on('level:start', (p) => this._onLevelStart(p));
    }
    return this;
  }

  /** Per-hold state back to idle (init / reset). */
  _reset() {
    this._state = ST_IDLE; this._t = 0; this._stopT = 0; this._spec = null;
    this._hp.fill(HW.segHp); this._repLeft.fill(0); this._cool.fill(0); this._climbT.fill(0); this._tok.fill(0); this._breachT.fill(0);
    this._claw.fill(0); this._clawPrev.fill(0); this._clawNew.fill(0); this._pile.fill(0); this._gapN.fill(0); this._gapClear.fill(0);
    this._contact.fill(0); this._clawBeg.fill(0); this._press.fill(0);
    this._secState.fill(0); this._secLevel.fill(-1); this._spitCol.fill(-1);
    this._focus.fill(0); this._accBoss.fill(0); this._shIn.fill(0); this._colWalk.fill(0);
    this._nSh = 0; this._nIn = 0; this._laneAcc = 0; this._inNext = 0; this._outNext = 0;
    this._ring.fill(0); this._ringI = 0; this._ringSum = 0; this._lastTarget = 0;
    this._eased.fill(0); this._easedBy.fill(0); this._winCounted.fill(0); this._surgeSeen.fill(0); this._surgeAt = 1;
    this._n = 0; this._ptr = 0; this._minions = 0;
    this._kits = 0; this._kitsCap = HK.cap; this._everBreached = false; this._overrunT = 0; this._overrunSec = -1;
    this._lastRepairT = -1e9; this._lastSupplyT = -1e9; this._holdActions = 0; this._holdSurgeWindows = 0; this._apcSide = 0; this._scaleCut = false;
    this._staggers = 0; this._bossSpawned = false; this._bossHp = 0; this._survivors = 0; this._C0 = 0; this._hzShop = 1; this._hpLive = 1;
    this._countMult = 1; this._threat = 1; this._firstMeet = false; this._runDecisions = 0; this._assistK = 0; this._eHold = 1;
    this._holdSeed = 0; this._cause = ''; this._ended = false; this._kills0 = 0;
    this._tapQ = 0; this._actionQ = 0; this._actionSeq = -1;
    this._hudAcc = 0; this._focusLevel = 0; this._lastLeft = -1; this._lastKitsShown = -1; this._loopAcc = 0;
    this._lessonSlow = false; this._lessonSweep = false; this._sweepM = 0; this._focusSeen = false; this._flankSeen = false;
    this._repairSeen = false; this._windupSeen = false; this._bruteSeen = false; this._bruteNear = false; this._climbSeen = false;
    this._breachSeen = false; this._supplySeen = false;
    this._air.on = false; this._air.t = 0; this._air.done = 0; this._air.dmg = 0;
    for (const s of this._sup) { s.state = 0; s.seen = 0; }
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Builds the barricade, the marks and the crates once (hidden, under the scene) and compiles them behind the spinner. */
  prepare() {
    if (this._prep) return this._prep;
    const r = this.ctx.render;
    if (!r || !r.scene || !r.renderer) { this.programsReady = true; return (this._prep = Promise.resolve()); }
    this._build();
    const run = this._prepRun = { dead: false };
    return (this._prep = Promise.resolve(r.addWarmable(this._group, run)).then(() => { if (!run.dead) { this.programsReady = true; this._prepRun = null; } }));
  }

  /** r8 (P8): a run of another base started: a prepare under way stops between chunks, unready; the next prepare() finishes it. */
  cancelPrepare() {
    if (!this._prepRun) return;
    this._prepRun.dead = true;
    this._prepRun = null;
    this._prep = null;
  }

  /** Level reset (RESET_ORDER) / quit: idle, the scene hidden. weapons / troops / boss reset their hooks themselves. */
  reset() {
    if (this.active) this._hudOff();                     // a quit mid-hold: nothing of it outlives the run
    this.active = false;
    this._armed = false;
    this._cutScale(false);
    this._reset();
    if (this._group) { this._group.visible = false; this._group.position.z = 0; }
    this._hideCrates();
    if (this.botView) this.botView.active = false;
  }

  dispose() {
    this.reset();
    const r = this.ctx.render, g = this._group;
    if (!g) return;
    if (r) { r.removeWarmable(g); if (r.scene) r.scene.remove(g); }
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this._group = null; this._built = false; this._prep = null; this.programsReady = false;
  }

  /** level:start → a Horde run arms the barricade's approach (it rides the road in from appearZ). */
  _onLevelStart(p) {
    const lvl = this.ctx.level;
    this._armed = false;
    if (!p || p.endless || p.base !== 'horde' || !lvl || !lvl.script) return;
    const evs = lvl.script.events;
    for (let i = 0; i < evs.length; i++) {
      if (evs[i].type !== 'hold') continue;
      this._anchorD = evs[i].at + Math.max(1, lvl.script.roadSpeed) * HORDE.stop.stopS * 0.5;
      this._armed = true;
      if (!this._built && this.ctx.render && this.ctx.render.scene) this._build();
      this._applyLook(p.level);
      this._resetBarricade();
      break;
    }
  }

  // -------------------------------------------------------------------------------------------
  // begin: the dig-in (level.js, at the script's 'hold' event)
  // -------------------------------------------------------------------------------------------

  /** opts { threat, assistK, firstMeet, seed, runDecisions, event } — a reused object: copied here. */
  begin(script, opts) {
    const ctx = this.ctx;
    const o = opts || {};
    const ev = o.event || (script && script.events ? script.events.find((e) => e.type === 'hold') : null);
    if (!ev || !ev.spec) { warnOnce('hold.noSpec', 'hold.begin without a hold spec'); return; }
    this._reset();
    this._spec = ev.spec;
    const spec = ev.spec;
    this._threat = o.threat > 0 ? o.threat : 1;
    this._assistK = o.assistK > 0 ? o.assistK | 0 : 0;
    this._firstMeet = !!o.firstMeet;
    this._runDecisions = o.runDecisions > 0 ? o.runDecisions | 0 : 0;
    this._eHold = spec.eHold > 0 ? spec.eHold : 1;
    this._holdSeed = (((o.seed >>> 0) || 1) + HOLD_SEED) >>> 0;
    this._rng.reseed((this._holdSeed ^ 0xA511E9B3) >>> 0);
    this.active = true; this._state = ST_STOP; this._stopT = 0;
    // STOP: the road decelerates so the wall face stops at HF.wallZ (the barricade has ridden in since appearZ)
    const lvl = ctx.level;
    this._anchorD = ev.at + Math.max(1, script.roadSpeed) * HORDE.stop.stopS * 0.5;
    if (lvl && lvl.stopRoad) lvl.stopRoad(HORDE.stop.stopS, this._anchorD);
    if (!this._built && ctx.render && ctx.render.scene) this._build();
    if (!this._armed) { this._applyLook(spec.L); this._resetBarricade(); }
    this._armed = true;
    if (this._group) this._group.visible = true;
    if (ctx.zombies && ctx.zombies.killAll) ctx.zombies.killAll('cleanup');          // run stragglers, no coins
    if (ctx.squad && ctx.squad.setFormation) ctx.squad.setFormation('wall');
    if (ctx.render && ctx.render.setRig) ctx.render.setRig('hold', HORDE.stop.stopS * 0.6);
    if (ctx.engine && ctx.engine.setInputMode) ctx.engine.setInputMode('aim', null);
    if (ctx.weapons && ctx.weapons.setPolicy) ctx.weapons.setPolicy(this._policy);
    if (ctx.troops && ctx.troops.setPlacement) ctx.troops.setPlacement(this._placement);
    // kits: the start + the run's crates + the assist steps (D35), the cap + its steps
    const as = spec.assist || HORDE_GEN.assist, k = this._assistK;
    const runKits = ctx.run && ctx.run.kits > 0 ? ctx.run.kits | 0 : 0;
    this._kitsCap = HK.cap + k * (as.capPerStep | 0);
    this._kits = Math.min(this._kitsCap, HK.start + runKits + k * (as.kitsPerStep | 0));
    // the boss for the spawn later: hold mode now (no intro; its hooks are this system's)
    const bo = this._bossOpts;
    bo.holdZ = HB.holdZ; bo.enrageS = spec.boss.enrageS != null ? spec.boss.enrageS : HB.enrageS; bo.attacks = spec.boss.attacks !== false;
    bo.debut = !!spec.debut; bo.chew = Math.max(HB.chewMin, Math.round(HB.chewPerE * this._eHold));
    if (this.botView) { this.botView.boss.arrivedAt = -1; this.botView.boss.enrageS = bo.enrageS; this.botView.wantThreat = false; }
    if (ctx.boss && ctx.boss.setHoldMode) ctx.boss.setHoldMode(bo);
    this._banner(STRINGS.hold.start, STRINGS.hold.variants[spec.variant] || '', HH.banner, HORDE.stop.bannerS);
    this._emitAction(true);
  }

  /** The road has stopped: the crowd and the clock start (surge 1 at spec.surges[0].t). */
  _startHold() {
    const ctx = this.ctx, spec = this._spec, crowd = ctx.crowd;
    this._state = ST_HOLD; this._t = 0;
    const C0 = ctx.squad ? ctx.squad.count : 0;
    this._C0 = C0;
    const r = C0 / this._eHold;
    const prof = ctx.profile;
    const f = prof && prof.fireRate > 0 ? prof.fireRate : FIRE.rateBase, d = prof && prof.damage > 0 ? prof.damage : FIRE.dmgBase;
    const bd = prof && prof.bossDamage > 0 ? prof.bossDamage : 1;
    const p = (f / FIRE.rateBase) * d;
    // live scaling at the dig-in (util hold math): counts above E_hold, unit HP everywhere (A9), the live shop's HP scale (D26)
    this._countMult = holdLiveScale(r, HORDE_GEN.live);
    this._hpLive = holdLiveHp(r, HORDE_GEN.live);
    this._hzShop = holdHpScale(spec.hz, p, spec.pExp, spec.profileExp, spec.surplusExp);
    this._bossHp = holdBossHp(spec.eBoss, spec.boss.factor, r, p, bd, spec.boss.bdExp, HORDE_GEN.boss);
    for (let t = 0; t < TYPES.length; t++) MINION_HP[TYPES[t]] = Math.max(1, BASE_HP[t] * this._hzShop);
    // first meeting (D29): surge 1 from the run's counted decisions; the later ones when they spawn
    const fm = spec.firstMeet || HORDE_GEN.firstMeet;
    this._eased[0] = this._firstMeet && this._runDecisions >= fm.surge1NeedsDecisions ? 1 : 0;
    this._buildSpawns(spec, this._countMult, mulberry32(this._holdSeed));
    for (let i = 0; i < this._sup.length; i++) {
      const s = this._sup[i], src = spec.supply[i];
      s.state = src ? 1 : 0; s.t = src ? src.t : 0; s.x = src ? src.x : 0; s.seen = 0; s.idx = i;
    }
    if (crowd) {
      crowd.begin({ seed: (this._holdSeed ^ CROWD_SEED) >>> 0, coin: spec.coinPerKill > 0 ? spec.coinPerKill : 0, rules: this._rules });
      this._kills0 = crowd.kills;
    }
    if (ctx.engine && ctx.engine.freezeQuality) ctx.engine.freezeQuality(HORDE.stop.freezeS);
    this._cutScale(true);
    P_MUSIC.mode = 'hold'; P_MUSIC.restart = true; P_MUSIC.swell = false;
    this._emit('music:mode', P_MUSIC);
    P_LOOP.on = true; P_LOOP.gain = 0.4;
    this._emit('audio:loop', P_LOOP);
    // lessons at first sight (D40): the lane; the hold's FIELD GUIDE basics are met now
    this._seen('hold.barricade'); this._seen('hold.lane'); this._seen('hold.surges');
    this._lesson('hold.sweep', null, 30, 'hold.sweep');
    this._lessonSweep = true;
    if (ctx.weapons && (ctx.weapons.storedCount > 0 || ctx.weapons.weapon)) this._lesson('hold.weapons');
    if (this._assistK > 0) {
      const as = spec.assist || HORDE_GEN.assist, given = this._assistK * (as.kitsPerStep | 0);
      this._banner(STRINGS.hold.reinforcements(given), '', HH.good, 3);
      P_KITS.kits = this._kits; P_KITS.cap = this._kitsCap; P_KITS.delta = given; P_KITS.source = 'assist';
      this._emit('horde:kits', P_KITS);
    }
    P_START.level = spec.L; P_START.eHold = this._eHold; P_START.kits = this._kits; P_START.cap = this._kitsCap; P_START.assistK = this._assistK;
    P_START.surges = spec.surges.length; P_START.variant = spec.variant; P_START.boss = spec.boss.id; P_START.firstMeet = this._firstMeet;
    P_START.eased = !!this._eased[0];
    this._emit('horde:start', P_START);
    this._emitCounter(true);
  }

  // -------------------------------------------------------------------------------------------
  // The spawn timetable — tools/holdsim.js buildSpawns, ported draw for draw (same seed → the same horde as the model)
  // -------------------------------------------------------------------------------------------

  _buildSpawns(hold, countMult, R) {
    const surges = hold.surges, mix = hold.mix, nS = surges.length, flank = HORDE_GEN.patterns.flank;
    let cap = Math.round(hold.trickle * countMult) + 8;
    for (let i = 0; i < nS; i++) cap += Math.round(surges[i].n * countMult) + Math.round(hold.brutes * countMult) + Math.round(hold.spitters * countMult) + 4;
    if (cap > this._cap) {                              // grown once to the biggest hold met (event time)
      this._cap = cap;
      this._sT = new Float64Array(cap); this._sType = new Uint8Array(cap); this._sX = new Float32Array(cap); this._sTx = new Float32Array(cap);
      this._sS = new Int8Array(cap); this._ord = new Int32Array(cap);
    }
    const T = this._sT, TY = this._sType, X = this._sX, TX = this._sTx, S = this._sS;
    let n = 0;
    const pickFodder = () => { const u = R(); return u < mix[0] ? W_ : (u < mix[0] + mix[1] ? R_ : C_); };
    const tgtX = (s) => segCx(s) + (R() * 2 - 1) * 0.85;
    const bruteW = surges.map((s) => (s.pattern === 'brutePush' ? 4 : 1)), spitW = surges.map((s) => (s.pattern === 'spitterBattery' ? 5 : 1));
    const bw = bruteW.reduce((a, b) => a + b, 0), sw = spitW.reduce((a, b) => a + b, 0);
    const segPick = new Int32Array(nS).fill(-1);
    for (let i = 0; i < nS; i++) {
      const s = surges[i];
      const mI = countMult;
      const ns = Math.round(s.n * mI);
      const nb = Math.round(hold.brutes * mI * bruteW[i] / bw), nsp = Math.round(hold.spitters * mI * spitW[i] / sw);
      const n0 = s.double ? Math.round(ns * HORDE_GEN.surges.double.split) : ns;
      const parts = s.double ? [[s.t, n0, 0], [s.t + s.lag, ns - n0, 1]] : [[s.t, ns, 0]];
      const flip = R() < 0.5;
      const win = s.window;
      for (const [pt, pn, side] of parts) {
        for (let k = 0; k < pn + (side === 0 ? nb + nsp : 0); k++) {
          const v = R();
          const ts = pt + v * win;
          let type = k < pn ? pickFodder() : (k < pn + nb ? B_ : S_);
          let x, tx;
          let p = s.pattern;
          if (side === 1) p = (/L$/.test(p) ? p.replace(/L$/, 'R') : /R$/.test(p) ? p.replace(/R$/, 'L') : (flip ? 'flankL' : 'flankR'));
          switch (p) {
            case 'flankL': x = -10.7 + 14 * R(); tx = tgtX(R() < flank ? 0 : 1); break;
            case 'flankR': x = -3.3 + 14 * R(); tx = tgtX(R() < flank ? 3 : 2); break;
            case 'center': x = -9 + 18 * R(); tx = tgtX(R() < 0.5 ? 1 : 2); break;
            case 'pincer': if (R() < 0.5) { x = -10.7 + 10 * R(); tx = tgtX(0); } else { x = 0.7 + 10 * R(); tx = tgtX(3); } break;
            case 'sweepLR': { const sg = Math.min(3, Math.floor(v * 4)); x = -9 + 18 * v + (R() - 0.5) * 3; tx = tgtX(sg); break; }
            case 'sweepRL': { const sg = 3 - Math.min(3, Math.floor(v * 4)); x = 9 - 18 * v + (R() - 0.5) * 3; tx = tgtX(sg); break; }
            case 'split': { const left = Math.floor(v * 4) % 2 === 0; x = left ? -10.7 + 10 * R() : 0.7 + 10 * R(); tx = tgtX(left ? (R() < 0.6 ? 0 : 1) : (R() < 0.6 ? 3 : 2)); break; }
            case 'brutePush': { if (segPick[i] < 0) segPick[i] = Math.floor(R() * 4); const sg = segPick[i]; x = segCx(sg) * 2 + (R() - 0.5) * 12; tx = tgtX(sg); break; }
            case 'runnerRush': x = -10 + 20 * R(); tx = tgtX(Math.floor(R() * 4)); if (type === W_ && R() < 0.45) type = R_; break;
            case 'crawlerCarpet': { if (segPick[i] < 0) segPick[i] = Math.floor(R() * 4); const sg = segPick[i]; x = segCx(sg) * 2 + (R() - 0.5) * 12; tx = tgtX(R() < 0.7 ? sg : Math.floor(R() * 4)); if (type === W_ && R() < 0.4) type = C_; break; }
            case 'spitterBattery': { if (segPick[i] < 0) segPick[i] = R() < 0.5 ? 0 : 3; const sg = segPick[i]; x = segCx(sg) * 2 + (R() - 0.5) * 6; tx = tgtX(R() < 0.7 ? sg : Math.floor(R() * 4)); break; }
            default: x = -10 + 20 * R(); tx = tgtX(Math.floor(R() * 4));
          }
          if (type === S_) { x = -8 + 16 * R(); tx = -3.5 + 7 * R(); }   // spitters spread across the field
          T[n] = ts; TY[n] = type; X[n] = Math.max(-10.7, Math.min(10.7, x)); TX[n] = tx; S[n] = i; n++;
        }
      }
    }
    // base trickle, uniform over the spawn time; it follows the ease of the last surge started before it
    const nb = Math.round(hold.trickle * countMult);
    for (let k = 0; k < nb; k++) {
      const t = R() * hold.spawnEnd;
      let s = 0;
      while (s + 1 < nS && surges[s + 1].t <= t) s++;
      const type = pickFodder();
      T[n] = t; TY[n] = type; X[n] = -10 + 20 * R(); TX[n] = -3.6 + 7.2 * R(); S[n] = s; n++;
    }
    // stable by time (holdsim sorts its list with Array#sort: equal times keep their insertion order)
    const ord = this._ord;
    for (let k = 0; k < n; k++) ord[k] = k;
    ord.subarray(0, n).sort((a, b) => (T[a] - T[b]) || (a - b));
    this._n = n; this._ptr = 0;
  }

  /** Queues the timetable's units due by now + FEED_LEAD whose surge's ease is decided (A9: HP, never the count). */
  _feed(now) {
    const crowd = this.ctx.crowd;
    if (!crowd || this._state !== ST_HOLD) return;
    const T = this._sT, TY = this._sType, X = this._sX, TX = this._sTx, S = this._sS, ord = this._ord;
    const fmThreat = this._spec.firstMeet ? this._spec.firstMeet.threat : HORDE_GEN.firstMeet.threat;
    while (this._ptr < this._n) {
      const k = ord[this._ptr];
      if (T[k] > now + FEED_LEAD || S[k] >= this._surgeAt) break;
      const ty = TY[k];
      const hp = Math.max(1, BASE_HP[ty] * this._hzShop) * this._hpLive * (this._eased[S[k]] ? fmThreat : 1) * this._threat;
      if (!crowd.queue(T[k], ty, X[k], TX[k], hp)) break;
      this._ptr++;
    }
  }

  /** Units still to come: the timetable's rest + the crowd's queue. */
  _left() {
    const crowd = this.ctx.crowd;
    return (this._n - this._ptr) + (crowd ? crowd.queued + crowd.alive : 0);
  }

  // -------------------------------------------------------------------------------------------
  // step (60 Hz, after crowd and boss)
  // -------------------------------------------------------------------------------------------

  step(dt) {
    if (!this.active) return;
    const ctx = this.ctx;
    if (this._state === ST_STOP) {
      this._stopT += dt;
      this._sampleLane();
      const w = ctx.world;
      if ((w && w.roadSpeed <= 1e-3) || this._stopT >= HORDE.stop.stopS + 0.5) this._startHold();
      this._updateView();
      return;
    }
    if (this._state !== ST_HOLD) { this._updateView(); return; }
    const crowd = ctx.crowd;
    const now = crowd && crowd.active ? crowd.t : this._t + dt;
    this._t = now;
    const spec = this._spec;
    this._sampleLane();
    // ---- first-meeting decisions and hold-action windows at surge spawns (D29 / D30), the surge's arrival
    const surges = spec.surges, nS = surges.length, fm = spec.firstMeet || HORDE_GEN.firstMeet;
    while (this._surgeAt < nS && now >= surges[this._surgeAt].t) {
      const src = this._windowSource(now);
      if (this._firstMeet && fm.laterNeedsAction && src) { this._eased[this._surgeAt] = 1; this._easedBy[this._surgeAt] = src; }
      this._surgeAt++;
    }
    for (let i = 0; i < nS; i++) {
      if (this._winCounted[i] || now < surges[i].t) continue;
      this._winCounted[i] = 1;
      const src = this._windowSource(now);
      if (src) { this._holdActions++; this._holdSurgeWindows++; }
      this._onSurge(i, src);
    }
    // the surge arrows and dust 2 s ahead of each surge
    for (let i = 0; i < nS; i++) if (!this._surgeSeen[i] && now >= surges[i].t - 2) { this._surgeSeen[i] = 1; this._surgeArrow(i); }
    this._feed(now);
    // ---- the boss, spec.boss.at
    if (!this._bossSpawned && now >= spec.boss.at) this._spawnBoss();
    // ---- the lane: shooters, focus, the spitter share
    this._fire(dt);
    // ---- input: REPAIR / bubbles / keys / taps
    this._input();
    // ---- supply drops and the airstrike
    this._supply(dt, now);
    if (this._air.on) this._airStep(dt);
    // ---- lessons at first sight
    this._lessons();
    // ---- HUD kit and horde:* rate-limited events
    this._hudAcc += dt;
    if (this._hudAcc >= 1 / HH.hz) { this._hudAcc -= 1 / HH.hz; this._hud(now); }
    this._updateView();
  }

  /** The lane target's travel ring (D30), sampled every fixed step from the dig-in on. */
  _sampleLane() {
    const input = this.ctx.input;
    const target = input ? input.aimTargetX : 0;
    const d = Math.abs(target - this._lastTarget);
    this._lastTarget = target;
    this._ringSum += d - this._ring[this._ringI];
    this._ring[this._ringI] = d;
    this._ringI = this._ringI + 1 < this._ringN ? this._ringI + 1 : 0;
    if (this._ringSum < 0) this._ringSum = 0;
    if (this._lessonSweep && this._state === ST_HOLD) {
      this._sweepM += d;
      // the drag is the lesson done (ui._hintActed's rule): hint:release alone leaves a pill under HINT_MARK_S unmarked, and it came back on every Horde
      if (this._sweepM >= HL.sweepM) { this._lessonSweep = false; this._done('hold.sweep'); this._release('hold.sweep'); }
    }
  }

  /** The window's counted action (1 lane, 2 repair, 3 crate; 0 none) at hold time t. */
  _windowSource(t) {
    const w = LEVELS.curve.assist.windowS || 3;
    return this._ringSum >= HORDE.actions.laneM - 1e-6 ? 1 : (t - this._lastRepairT <= w ? 2 : (t - this._lastSupplyT <= w ? 3 : 0));
  }

  _onSurge(i, src) {
    const s = this._spec.surges[i], side = sideOf(s.pattern);
    P_SURGE.i = i; P_SURGE.n = this._spec.surges.length; P_SURGE.pattern = s.pattern; P_SURGE.side = side; P_SURGE.double = !!s.double;
    P_SURGE.eased = !!this._eased[i]; P_SURGE.source = SOURCES[this._easedBy[i]] || (i === 0 && this._eased[0] ? 'run' : '');
    this._emit('horde:surge', P_SURGE);
    if (s.double) this._banner(STRINGS.hold.double, '', HH.danger, 1.6);
    // the first flank surge (surge 2 is a flank or a pincer, so every first hold meets it): a pincer names the weaker side
    if (!this._flankSeen && /^flank|^pincer/.test(s.pattern)) { this._flankSeen = true; this._lesson('hold.flank', side || (segCx(this._weakest()) < 0 ? -1 : 1)); }
  }

  _surgeArrow(i) {
    const side = sideOf(this._spec.surges[i].pattern), x = side * 4.5;
    P_DECAL.kind = 'arrow'; P_DECAL.x = x; P_DECAL.z = -34; P_DECAL.size = side ? 4 : 7; P_DECAL.seconds = 3; P_DECAL.color = HH.danger;
    P_DECAL.top = false; P_DECAL.id = -1;
    this._emit('fx:decal', P_DECAL);
    P_BURST.kind = 'breach'; P_BURST.x = x; P_BURST.y = 0.4; P_BURST.z = -44; P_BURST.n = 18;
    this._emit('fx:burst', P_BURST);
  }

  _spawnBoss() {
    const ctx = this.ctx, spec = this._spec;
    this._bossSpawned = true;
    if (!ctx.boss || !ctx.boss.spawn) return;
    BOSS_SPEC.id = 'boss.' + spec.boss.id; BOSS_SPEC.archetype = spec.boss.id; BOSS_SPEC.hp = Math.max(1, this._bossHp);
    // the sniper's cap comes before the shop's bossDamage: this capHp lands a capped shot at HB.sniperShot of the boss's max HP
    const prof = ctx.profile, bd = prof && prof.bossDamage > 0 ? prof.bossDamage : 1;
    BOSS_SPEC.capHp = BOSS_SPEC.hp * HB.sniperShot / (TROOPS.sniper.bossCapFrac * bd);
    BOSS_SPEC.x = 0; BOSS_SPEC.z = HB.spawnZ;
    ctx.boss.spawn(BOSS_SPEC);
    P_MUSIC.mode = 'hold'; P_MUSIC.restart = false; P_MUSIC.swell = true;
    this._emit('music:mode', P_MUSIC);
  }

  // -------------------------------------------------------------------------------------------
  // Fire policy (weapons.setPolicy) — the lane, FOCUS, the boss and spitter shares (PLAN horde §4, §9.1)
  // -------------------------------------------------------------------------------------------

  /** Per step: the logical shooters' x, who is in the lane, focus, and the spitter share applied straight to its target. */
  _fire(dt) {
    const ctx = this.ctx, squad = ctx.squad, input = ctx.input;
    const laneX = input ? input.aimX : 0;
    const C = squad ? squad.count : 0;
    const nSh = C < MAX_SHOOTERS ? C : MAX_SHOOTERS;
    let nIn = 0, fsum = 0;
    squad.shootersX(nSh, this._shD);
    for (let k = 0; k < nSh; k++) {
      const x = this._shD[k];
      this._shX[k] = x;
      const inLane = x - laneX <= HFI.laneHalf && x - laneX >= -HFI.laneHalf;
      this._shIn[k] = inLane ? 1 : 0;
      if (inLane) { nIn++; const f = this._focus[k] + dt / HFI.focusT; this._focus[k] = f < 1 ? f : 1; fsum += this._focus[k]; }
      else this._focus[k] = 0;
    }
    // the lists _shot draws from: the in-lane shooters, then the others
    for (let k = 0, a = 0, b = nIn; k < nSh; k++) { if (this._shIn[k]) this._shList[a++] = k; else this._shList[b++] = k; }
    if (this._inNext >= nIn) this._inNext = 0;
    if (this._outNext >= nSh - nIn) this._outNext = 0;
    this._nSh = nSh; this._nIn = nIn;
    const fAvg = nIn > 0 ? fsum / nIn : 0;
    this._focusLevel = fAvg >= HFI.focusSteps[2] - 1e-6 ? 3 : (fAvg >= HFI.focusSteps[1] ? 2 : (fAvg >= HFI.focusSteps[0] ? 1 : 0));
    if (this._focusLevel === 3 && !this._focusSeen) { this._focusSeen = true; this._seen('hold.focus'); this._lesson('hold.focus'); }
    // the spitter share: in-lane shooters over a holding spitter send it spitBeta of their DPS over the crowd (holdsim: direct)
    const crowd = ctx.crowd, w = ctx.weapons;
    if (!crowd || !crowd.active || nIn === 0 || !w) return;
    const D = w.squadDps();
    const mIn = HFI.laneShare / nIn;
    for (let k = 0; k < nSh; k++) {
      if (!this._shIn[k]) continue;
      const c = Math.floor(this._shX[k] + HF.wallHalf);
      const id = c >= 0 && c < 8 ? this._spitCol[c] : -1;
      if (id < 0 || crowd.state[id] !== 1 || this._bossColumn(this._shX[k], true) >= 0) continue;
      const share = D * mIn * holdFocusRate(this._focus[k], HFI.focusFrom) * HFI.spitBeta * dt;
      crowd.applyHit(crowd.idOf(id), share, 1, crowd.x[id], 1, crowd.z[id], 'bullet');
    }
  }

  /** Living boss twin whose column the shooter at x passes within (bossR; each Twin twinR), only in rifle range; −1 none. */
  _bossColumn(x, inRangeOnly) {
    const boss = this.ctx.boss;
    if (!boss || !boss.active || !boss.holdMode) return -1;
    const R = HFI.bossR;
    let best = -1, bd = 1e9;
    for (let u = 0; u < 2; u++) {
      if (!boss.unitAlive(u)) continue;
      const bz = boss.unitZ(u);
      if (inRangeOnly && bz < HF.rangeZ) continue;
      const d = Math.abs(x - boss.unitX(u));
      if (d <= R && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  /** Rounds per second: min(rateCap, C·f) (folded; the RUN weighted output is kept). */
  _rate(C) {
    const prof = this.ctx.profile, w = this.ctx.weapons;
    const f = (prof && prof.fireRate > 0 ? prof.fireRate : FIRE.rateBase) * (w ? w.fireRateMult : 1);
    const r = C * f;
    return r < HFI.rateCap ? r : HFI.rateCap;
  }

  /** One round of the squad's fold (weapons walks its shooters, k only counts): laneShare of the rounds leave from the in-lane
   *  shooters, the rest from the others — a column's rounds follow its DPS share, so pierce counts them as holdsim does — at
   *  weight FOCUS × accuracy; β of a shooter's rounds go at the boss's chest. false: nobody stands on that side of the lane. */
  _shot(k, o) {
    if (this._state !== ST_HOLD && this._state !== ST_STOP) return true;
    const nSh = this._nSh, nIn = this._nIn, nOut = nSh - nIn;
    if (k >= nSh) return true;
    const acc = this._laneAcc + HFI.laneShare, inLane = o.lane || acc >= 1;      // a stored weapon's rounds are the lane's
    if (!o.lane) this._laneAcc = inLane ? acc - 1 : acc;
    if (inLane ? nIn === 0 : nOut === 0) return false;
    let j;
    if (inLane) { j = this._shList[this._inNext]; this._inNext = this._inNext + 1 < nIn ? this._inNext + 1 : 0; }
    else { j = this._shList[nIn + this._outNext]; this._outNext = this._outNext + 1 < nOut ? this._outNext + 1 : 0; }
    this.ctx.squad.shooterPosition(j, V3);
    o.ox = V3.x; o.oy = V3.y; o.oz = V3.z;
    o.weight = (inLane ? holdFocusRate(this._focus[j], HFI.focusFrom) : 1) * FIRE.accuracy;
    const x = this._shX[j];
    // the boss share over the crowd (per-shooter accumulator: deterministic, no draw)
    const u = this._bossColumn(x, true);
    if (u >= 0) {
      const boss = this.ctx.boss;
      const beta = inLane ? (boss.holdWindup(u) >= 0 ? HFI.betaWind : HFI.beta) : HFI.betaOut;
      this._accBoss[j] += beta;
      if (this._accBoss[j] >= 1) {
        this._accBoss[j] -= 1;
        const dx = boss.unitX(u) - o.ox, dz = boss.unitZ(u) - o.oz;
        o.dirX = dx; o.dirZ = dz; o.bossOnly = true; o.tracerY = HFI.bossY;
        return true;
      }
    }
    const col = Math.floor(x + HF.wallHalf);
    // a spitter holding in this column takes spitBeta of an in-lane shooter's DPS straight (_fire): the rest walks the column
    if (inLane && col >= 0 && col < 8 && this._spitCol[col] >= 0 && u < 0) o.weight *= 1 - HFI.spitBeta;
    // the round goes down the shooter's 1 m column (PLAN horde 4.4), not its own file: successive rounds walk across the column,
    // so the corners of the wall (|x| beyond the outer files) are under fire like the rest
    const cw = this._colWalk[j] + GOLD, w = cw < 1 ? cw : cw - 1;
    this._colWalk[j] = w;
    o.ox += col - HF.wallHalf + w - x;
    o.tracerY = this._colPile(x) ? HFI.pileY : HFI.tracerY;
    return true;
  }

  /** True when the pile at the wall fills this column (tracers aim at its height, clearing the planks). */
  _colPile(x) { return this._pile[segOf(x)] > HW.slots; }

  /** Stored weapons fire down the lane (horde §8). */
  _weaponFrame(id, f) {
    const laneX = this.ctx.input ? this.ctx.input.aimX : 0;
    if (id === WEAPONS.shotgun.id) { f.x = laneX; f.halfWidth = HORDE.weapons.shotgun; return true; }
    if (id === WEAPONS.minigun.id) { f.x = laneX; f.halfWidth = HORDE.weapons.minigun; f.z1 = HF.rangeZ; return true; }
    if (id === WEAPONS.laser.id) { f.x = laneX; f.halfWidth = HORDE.weapons.laser; f.z1 = HF.rangeZ; return true; }
    if (id === WEAPONS.railgun.id) { f.x = laneX; f.halfWidth = HORDE.weapons.railgun; f.z1 = HF.rangeZ; return true; }
    if (id === WEAPONS.rocket.id) {
      const crowd = this.ctx.crowd, squad = this.ctx.squad;
      const z0 = (squad ? squad.centerZ : 0) - HORDE.weapons.rocketReach;
      f.x = laneX; f.z1 = Math.max(z0, HF.rangeZ); f.radius = HORDE.weapons.rocketSplash;
      if (crowd && crowd.active && crowd.densestCell(laneX - HFI.laneHalf, laneX + HFI.laneHalf, z0 + 0.5, HORDE.weapons.rocketZ, CELL_OUT)) { f.tx = CELL_OUT.x; f.tz = CELL_OUT.z; }
      return true;
    }
    return false;
  }

  /** Troops in the hold (horde §8): every slot is the hold's (the RUN slots are anchored to the RUN front row). */
  _place(key, out) {
    const T = HORDE.troops, input = this.ctx.input;
    switch (key) {
      case 'sniper': out.x = T.sniper[0]; out.y = HF.stepY; out.z = T.sniper[1]; return true;
      case 'medic': out.x = T.medic[0]; out.y = HF.stepY; out.z = T.medic[1]; return true;
      case 'flamer': out.x = T.flamer[0]; out.y = 0; out.z = T.flamer[1]; out.yaw = 0; return true;
      case 'drone': out.x = input ? input.aimX : 0; out.y = T.droneY; out.z = T.droneZ; return true;
      case 'apc':                                      // beside the wall, on the flank of the weakest section at its arrival: it never crosses the squad
        if (this._apcSide === 0) this._apcSide = segCx(this._weakest()) < 0 ? -1 : 1;
        out.x = this._apcSide * (HF.wallHalf + 1.7); out.y = 0; out.z = T.apcZ - 2.2; out.yaw = 0;
        return true;
      default: return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Crowd rules (phase B, 30 Hz, direct SoA access)
  // -------------------------------------------------------------------------------------------

  /** Tick start: last tick's holders become the slot count, the pile / gap / spitter columns from the current positions,
   *  runners re-target the weakest section until 20 m out. */
  _rBegin(dt) {
    const c = this.ctx.crowd;
    this._dtTick = dt;
    for (let s = 0; s < NSEC; s++) {
      this._clawPrev[s] = this._claw[s] + this._clawNew[s];
      this._claw[s] = 0; this._clawNew[s] = 0; this._clawBeg[s] = 0; this._pile[s] = 0; this._gapN[s] = 0;
    }
    this._spitCol.fill(-1);
    // a section the lane does not cover: fire strips its holders (the front rank) while holdsim's thin out-of-lane fire reaches
    // them last, so there a pile keeps its slots clawing — free slots refill at once and take-overs skip the claw delay
    const laneX = this.ctx.input ? this.ctx.input.aimX : 0;
    for (let s = 0; s < NSEC; s++) {
      const a = segCx(s) - HF.segW * 0.5, b = a + HF.segW, l0 = laneX - HFI.laneHalf, l1 = laneX + HFI.laneHalf;
      this._press[s] = (l1 < b ? l1 : b) - (l0 > a ? l0 : a) < HF.segW * 0.5 ? 1 : 0;
    }
    let wk = 0;
    for (let s = 1; s < NSEC; s++) if (this._hp[s] < this._hp[wk]) wk = s;
    const retarget = this._hp[wk] < HW.segHp * HORDE.runner.weakBelow, wkx = segCx(wk);
    const X = c.x, Z = c.z, md = c.mode, ty = c.type, st = c.state, live = c.live, M = c.MODE;
    let bruteNear = false;
    for (let k = 0, n = c.nLive; k < n; k++) {
      const i = live[k];
      if (st[i] !== 1) continue;
      const z = Z[i], m = md[i], t = ty[i];
      if (z < RETARGET_Z) {                               // far out only a runner has anything to do here
        if (retarget && t === T_RUNNER && m === M.WALK) c.tx[i] = wkx + (c.tx[i] - segCx(segOf(c.tx[i])));
        continue;
      }
      if (m === M.FLEE) continue;
      const x = X[i];
      if (z > HF.gapZ && x < HF.wallHalf && x > -HF.wallHalf) this._gapN[segOf(x)]++;
      if (m === M.HOLD && t === T_SPITTER) {
        if (z >= HF.rangeZ && x < HF.wallHalf && x > -HF.wallHalf) {
          const col = Math.floor(x + HF.wallHalf), cur = this._spitCol[col];
          if (cur < 0 || z > Z[cur]) this._spitCol[col] = i;
        }
        continue;
      }
      if (m === M.CLIMB || m === M.PASS || (m === M.HOLD && z > HF.wallZ)) continue;
      if (z >= PILE_Z && z <= HF.wallZ) {
        const s = segOf(x);
        this._pile[s]++;
        // the next unit within slotReach of the face takes a free slot at once and lurches up to it (_rHold)
        if (this._press[s] && m !== M.HOLD && z >= SLOT_Z && t !== T_SPITTER && this._hp[s] > 0 && this._clawPrev[s] + this._clawBeg[s] + this._clawNew[s] < HW.slots) {
          this._clawBeg[s]++;
          md[i] = M.HOLD;
        }
      }
      if (t === T_BRUTE && z > HF.wallZ - HL.bruteNear) bruteNear = true;
    }
    this._bruteNear = bruteNear;
  }

  /** A WALK / WALL unit clamped at the face: take a free claw slot (pinned, HOLD), or pass a breached section on a token. */
  _rWall(i) {
    const c = this.ctx.crowd, s = segOf(c.x[i]);
    if (this._hp[s] > 0) {
      if (this._clawPrev[s] + this._clawNew[s] < HW.slots) {
        this._clawNew[s]++;
        c.mode[i] = c.MODE.HOLD;
        this._claws(i, s, this._dtTick);
      }
    } else if (this._tok[s] >= 1) {
      this._tok[s] -= 1;
      c.mode[i] = c.MODE.PASS; c.z[i] = HF.wallZ + HW.passZ;
      if (c.type[i] !== T_BRUTE) {                       // through the gap in a lunge; outside the lane the rifles have no time
        c.spd[i] = HW.passSpeed; c.vz[i] = HW.passSpeed;
        if (this._press[s]) c.hp[i] = PASS_HP;
      }
    }
  }

  /** A HOLD unit: a spitter lobs, a brute past the wall swings, a claw holder claws (or climbs, or lets go at a breach). */
  _rHold(i) {
    const c = this.ctx.crowd, t = c.type[i], dt = this._dtTick;
    if (t === T_SPITTER) { this._spitLob(i, dt); return; }
    if (c.z[i] > HF.wallZ) { this._bruteLine(i, dt); return; }
    const s = segOf(c.x[i]);
    if (this._hp[s] <= 0) { c.mode[i] = c.MODE.WALK; return; }        // its section broke: it joins the breach
    if (c.z[i] < FACE_Z) { const z = c.z[i] + HW.lurch * dt; c.z[i] = z < FACE_Z ? z : FACE_Z; }
    this._claw[s]++;
    this._claws(i, s, dt);
  }

  /** One claw holder for one tick: the claw delay, the claws, a breach, or a climb (holdsim's slot branch). */
  _claws(i, s, dt) {
    const c = this.ctx.crowd, t = c.type[i];
    c.aw[i] += dt;
    const takeOver = t !== T_BRUTE && this._press[s] && this._pile[s] >= HW.pile && this._contact[s] >= HW.clawDelay;
    if (takeOver || c.aw[i] >= (t === T_BRUTE ? HW.bruteClawDelay : HW.clawDelay)) {
      const hp = this._hp[s] - HW.claw[t] * dt;
      this._hp[s] = hp > 0 ? hp : 0;
    }
    if (this._hp[s] <= 0) { this._breach(s); c.mode[i] = c.MODE.WALK; return; }
    if (this._climbT[s] <= 0 && t !== T_BRUTE && t !== T_SPITTER && this._pile[s] - (this._claw[s] + this._clawNew[s]) > HW.pile) {
      const spec = this._spec;
      this._climbT[s] = spec.climbK * Math.max(HW.climbMin, HW.climbEvery * HW.pile / Math.max(1, this._pile[s] - HW.slots));
      c.mode[i] = c.MODE.CLIMB; c.z[i] = HF.wallZ + HW.climbLift;
      if (!this._climbSeen) { this._climbSeen = true; this._seen('hold.climb'); this._lesson('hold.climb'); }
      P_BURST.kind = 'climb'; P_BURST.x = c.x[i]; P_BURST.y = HF.height; P_BURST.z = HF.wallZ; P_BURST.n = 0;
      this._emit('fx:burst', P_BURST);
    }
  }

  /** A PASS unit after it moved: a brute stops short of the squad (it swings there). */
  _rBreach(i) {
    const c = this.ctx.crowd;
    if (c.type[i] === T_BRUTE && c.z[i] >= HF.frontZ - CROWD_R - HF.brute) {
      c.z[i] = HF.frontZ - CROWD_R - HF.brute; c.mode[i] = c.MODE.HOLD; c.tm[i] = HBS.first;
    }
  }

  /** A climber / breacher at the squad line: bites one soldier (the APC or a plate first) and dies; a brute holds. */
  _rReach(i) {
    const c = this.ctx.crowd;
    if (c.type[i] === T_BRUTE) { c.mode[i] = c.MODE.HOLD; c.tm[i] = HBS.first; return; }
    const x = c.x[i], z = c.z[i];
    c.kill(i, 'bite');
    this._bite(1, x, z);
  }

  /** A walking spitter past spitZ: it stops on its line and holds only inside the fire columns (side-stepping in). */
  _rSpit(i) {
    const c = this.ctx.crowd;
    const zh = HSP.holdZ + (i % 5) * HSP.step - HSP.spread;
    if (c.z[i] < zh) return;
    c.z[i] = zh; c.vz[i] = 0;
    const x = c.x[i];
    if (x <= HSP.colX && x >= -HSP.colX) { c.mode[i] = c.MODE.HOLD; c.tm[i] = HSP.first[0] + HSP.first[1] * hash01(i + this._holdSeed); c.aw[i] = 0; }
    else c.x[i] = x + (x > 0 ? -1 : 1) * HSP.side * this._dtTick;
  }

  /** A holding spitter: the arc telegraph, then a lob over the wall for spec.spitKills soldiers. */
  _spitLob(i, dt) {
    const c = this.ctx.crowd;
    c.tm[i] -= dt;
    if (c.aw[i] === 0 && c.tm[i] <= HSP.telegraph) {
      c.aw[i] = 1;
      P_DECAL.kind = 'arc'; P_DECAL.x = clamp(c.x[i], -3, 3); P_DECAL.z = -1.2; P_DECAL.size = 1.4; P_DECAL.seconds = HSP.telegraph;
      P_DECAL.color = PALETTE.fx.acid; P_DECAL.top = true; P_DECAL.id = -1;
      this._emit('fx:decal', P_DECAL);
    }
    if (c.tm[i] <= 0) {
      c.tm[i] = HSP.every; c.aw[i] = 0;
      const squad = this.ctx.squad;
      if (squad && squad.count > 0 && this._live()) squad.removeSoldiers(this._spec.spitKills | 0 || 1, 'spit', clamp(c.x[i], -3, 3), HF.frontZ);
    }
  }

  /** A brute past a breach at the squad line: a swing every bruteSwing.every s. */
  _bruteLine(i, dt) {
    const c = this.ctx.crowd;
    c.tm[i] -= dt;
    if (c.tm[i] > 0) return;
    c.tm[i] = HBS.every;
    const squad = this.ctx.squad;
    if (!squad || squad.count <= 0 || !this._live()) return;
    const k = Math.max(HBS.min, Math.min(HBS.max, Math.round(HBS.frac * squad.count)));
    squad.removeSoldiers(k, 'bite', c.x[i], c.z[i]);
  }

  /** n bites at (x, z): the APC soaks what it can, plates and the squad take the rest. */
  _bite(n, x, z) {
    if (!this._live()) return;
    const troops = this.ctx.troops, squad = this.ctx.squad;
    let left = n;
    if (troops && troops.apcAbsorb) left -= troops.apcAbsorb(n) | 0;
    if (left > 0 && squad && squad.count > 0) squad.removeSoldiers(left, 'bite', x, z);
  }

  /** Section s reached 0: a breach (once per break; the LINE HELD bonus is lost). */
  _breach(s) {
    if (this._secState[s] === 3) return;
    this._everBreached = true;
    this._breachT[s] = 0;
    this._setSecState(s, 3);
    P_BREACH.i = s; P_BREACH.x = segCx(s); P_BREACH.z = HF.wallZ;
    this._emit('horde:breach', P_BREACH);
    P_BURST.kind = 'breach'; P_BURST.x = segCx(s); P_BURST.y = 0.6; P_BURST.z = HF.wallZ; P_BURST.n = 0;
    this._emit('fx:burst', P_BURST);
    this._pill('breach', STRINGS.hold.breach, segCx(s), HF.height + 0.6, HF.wallZ, 1.4);
    if (!this._breachSeen) { this._breachSeen = true; this._seen('hold.breach'); this._lesson('hold.breach'); }
    const fx = this.ctx.fx;
    if (fx && fx.addTrauma) fx.addTrauma(JUICE.trauma.bossSlam * 0.4);
  }

  /** Tick end: climb timers, cool-downs, breach tokens, repairs in progress, the gap, the overrun clock, the section looks. */
  _rEnd(dt) {
    let down = 0;
    for (let s = 0; s < NSEC; s++) {
      this._climbT[s] -= dt;
      this._cool[s] = this._cool[s] > dt ? this._cool[s] - dt : 0;
      this._contact[s] = this._claw[s] + this._clawNew[s] > 0 ? this._contact[s] + dt : 0;
      if (this._hp[s] <= 0) {
        this._breachT[s] += dt;
        const rate = Math.min(HW.breachMax, HW.breachRate + HW.breachWiden * this._breachT[s]);
        this._tok[s] = Math.min(HW.breachBank, this._tok[s] + rate * dt);
        this._repLeft[s] = 0;                            // a repair dies with its section: only a rebuild (clear gap, a kit) brings it back
      } else { this._tok[s] = 0; this._breachT[s] = 0; }
      if (this._repLeft[s] > 0) {
        const k = Math.min(this._repLeft[s], HK.repairWp / HK.repairTime * dt);
        this._hp[s] = Math.min(HW.segHp, this._hp[s] + k);
        this._repLeft[s] -= k;
      }
      this._gapClear[s] = this._gapN[s] === 0 ? this._gapClear[s] + dt : 0;
      if (this._hp[s] <= 0) down++;
      const f = this._hp[s] / HW.segHp;
      this._setSecState(s, f <= 0 ? 3 : (f < HW.critical ? 2 : (f < HW.damaged ? 1 : 0)));
      this._updatePlanks(s, f);
    }
    if (!this._live()) return;
    if (down === NSEC) {
      this._overrunT += dt;
      const left = Math.ceil(HW.overrunS - this._overrunT - 1e-6);
      if (left !== this._overrunSec && left > 0) {
        this._overrunSec = left;
        P_COLLAPSE.left = left;
        this._emit('horde:collapse', P_COLLAPSE);
        this._banner(STRINGS.hold.collapsing(left), '', HH.danger, 1.05);
        this._seen('hold.overrun');
      }
      if (this._overrunT >= HW.overrunS) this._overrun();
    } else { this._overrunT = 0; this._overrunSec = -1; }
  }

  _setSecState(s, st) {
    if (this._secState[s] === st) return;
    this._secState[s] = st;
    P_SEGMENT.i = s; P_SEGMENT.hp = this._hp[s]; P_SEGMENT.state = SECTION_STATES[st];
    this._emit('horde:segment', P_SEGMENT);
  }

  /** LINE OVERRUN: the hold is lost (level runs the game-over theatre, cause 'overrun'). */
  _overrun() {
    this._state = ST_LOST; this._cause = 'overrun';
    P_OVERRUN.level = this._spec ? this._spec.L : 0;
    this._emit('horde:overrun', P_OVERRUN);
    this._endEvents(false, 'overrun');
    const lvl = this.ctx.level;
    if (lvl && lvl.finish) lvl.finish(false, 'overrun');
  }

  // -------------------------------------------------------------------------------------------
  // Kits: REPAIR, bubbles, keys; rebuilds after a clear gap
  // -------------------------------------------------------------------------------------------

  /** The hold still plays (not won, lost or ended). */
  _live() { return this._state === ST_HOLD && !this._ended; }

  /** The weakest section (lowest HP; ties to the left). */
  _weakest() {
    let wk = 0;
    for (let s = 1; s < NSEC; s++) if (this._hp[s] < this._hp[wk]) wk = s;
    return wk;
  }

  /** What tapping section s would do now (A_*). */
  _actionOf(s) {
    if (this._hp[s] <= 0) return this._gapClear[s] < HK.rebuildClearS ? A_GAP : (this._kits <= 0 ? A_NOKITS : (this._cool[s] > 0 ? A_BUSY : A_REBUILD));
    if (this._hp[s] + this._repLeft[s] >= HW.segHp - 0.5) return A_NONE;
    return this._kits <= 0 ? A_NOKITS : (this._cool[s] > 0 ? A_BUSY : A_REPAIR);
  }

  /** Repairs (or rebuilds) section s; true when a kit was used. */
  _repair(s) {
    if (!this._live()) return false;
    const a = this._actionOf(s);
    const x = segCx(s);
    if (a === A_REPAIR) {
      this._kits--; this._repLeft[s] += HK.repairWp; this._cool[s] = HK.cool;
    } else if (a === A_REBUILD) {
      this._kits--; this._hp[s] = 0.01; this._repLeft[s] += HK.rebuildWp; this._cool[s] = HK.cool;
      this._tok[s] = 0; this._breachT[s] = 0;
    } else {
      if (a === A_GAP) this._pill('gap', STRINGS.hold.clearGap, x, HF.height + 0.6, HF.wallZ, 1.1);
      else if (a === A_NOKITS) this._pill('nokits', STRINGS.hold.noKits, x, HF.height + 0.6, HF.wallZ, 1.1);
      return false;
    }
    this._lastRepairT = this._t;
    P_REPAIR.i = s; P_REPAIR.kits = this._kits; P_REPAIR.rebuild = a === A_REBUILD; P_REPAIR.x = x; P_REPAIR.z = HF.wallZ;
    this._emit('horde:repair', P_REPAIR);
    P_BURST.kind = 'repair'; P_BURST.x = x; P_BURST.y = HF.height; P_BURST.z = HF.wallZ; P_BURST.n = 0;
    this._emit('fx:burst', P_BURST);
    this._emitAction(false);
    return true;
  }

  /** REPAIR (the button, R, gamepad X): the weakest section that a kit can help now; feedback when none can. */
  _repairWeakest() {
    let best = -1, bv = 1e9, any = -1;
    for (let s = 0; s < NSEC; s++) {
      const a = this._actionOf(s), v = this._hp[s] + this._repLeft[s];
      if (a !== A_NONE && v < bv) { any = s; }
      if ((a === A_REPAIR || a === A_REBUILD) && v < bv) { bv = v; best = s; }
    }
    if (best >= 0) return this._repair(best);
    if (any >= 0) this._repair(this._weakest());                         // the weakest's feedback (CLEAR THE GAP / NO KITS)
    return false;
  }

  /** Queued input: ui:anchorTap / ui:action (the HUD kit, bots) and the action keys. */
  _input() {
    const input = this.ctx.input;
    if (this._tapQ) {
      for (let s = 0; s < NSEC; s++) if (this._tapQ & (1 << s)) this._repair(s);
      this._tapQ = 0;
    }
    while (this._actionQ > 0) { this._actionQ--; this._repairWeakest(); }
    if (!input) return;
    const a = input.action;
    if (a && a.seq !== this._actionSeq) {
      if (this._actionSeq >= 0) {
        if (a.name === 'repair') { if (a.arg >= 0 && a.arg < NSEC) this._repair(a.arg | 0); else this._repairWeakest(); }
        else if (a.name === 'snap' && a.arg >= 0 && a.arg < NSEC) input.aimTargetX = segCx(a.arg | 0);
      }
      this._actionSeq = a.seq;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Supply drops and the airstrike
  // -------------------------------------------------------------------------------------------

  _supply(dt, now) {
    const laneX = this.ctx.input ? this.ctx.input.aimX : 0;
    for (let i = 0; i < this._sup.length; i++) {
      const s = this._sup[i];
      if (s.state === 1 && now >= s.t) {
        s.state = 2; s.landT = now; s.seen = 0;
        this._showCrate(i);
        if (!this._supplySeen) { this._supplySeen = true; this._seen('hold.supply'); this._lesson('hold.supply'); }
      }
      if (s.state !== 2) continue;
      if (now >= s.t + HS.life) { s.state = 3; this._hideCrate(i); continue; }
      if (Math.abs(s.x - laneX) <= HFI.laneHalf) {
        s.seen += dt;
        if (s.seen >= HS.openS) this._openCrate(i);
      }
    }
  }

  /** A crate opened (a hold action, D30): +1 kit, or from airstrikeFrom drop 2 an airstrike when ≥ airstrikeKits kits are held. */
  _openCrate(i) {
    const s = this._sup[i], spec = this._spec;
    s.state = 3;
    this._hideCrate(i);
    if (!this._live()) return;
    this._lastSupplyT = this._t;
    const air = i === 1 && spec.airstrike && this._kits >= HORDE_GEN.supply.airstrikeKits;
    P_SUPPLY.i = i; P_SUPPLY.x = s.x; P_SUPPLY.z = HF.wallZ - 1; P_SUPPLY.kind = air ? 'airstrike' : 'kit';
    if (air) this._startAirstrike();
    else {
      const before = this._kits;
      this._kits = Math.min(this._kitsCap, this._kits + 1);
      P_KITS.kits = this._kits; P_KITS.cap = this._kitsCap; P_KITS.delta = this._kits - before; P_KITS.source = 'supply';
      this._emit('horde:kits', P_KITS);
      this._pill('kit', STRINGS.hold.kit(1), s.x, 1.2, HF.wallZ - 1, 1.2);
      this._emitAction(false);
    }
    P_SUPPLY.kits = this._kits;
    this._emit('horde:supply', P_SUPPLY);
  }

  /** AIRSTRIKE: bombs walk the lane from z0 to z1 over `seconds`, together airstrike.dpsS s of squad DPS (holdsim's total). */
  _startAirstrike() {
    const w = this.ctx.weapons, a = this._air;
    a.on = true; a.t = 0; a.done = 0; a.x = this.ctx.input ? this.ctx.input.aimX : 0;
    a.dmg = (w ? w.squadDps() : 0) * HA.dpsS;
    P_AIR.x = a.x; P_AIR.z = HA.z0;
    this._emit('horde:airstrike', P_AIR);
    this._seen('hold.supply'); this._lesson('hold.airstrike');
    this._banner(STRINGS.hold.airstrike, '', HH.banner, 1.4);
  }

  _airStep(dt) {
    const a = this._air, crowd = this.ctx.crowd;
    a.t += dt;
    while (a.done < HA.bombs && a.t >= HA.warnS + (a.done / Math.max(1, HA.bombs - 1)) * HA.seconds) {
      const z = HA.z0 + (HA.z1 - HA.z0) * (a.done / Math.max(1, HA.bombs - 1));
      if (crowd && crowd.active && this._live()) crowd.damageInCircle(a.x, z, HA.splash, a.dmg / HA.bombs, 'explosion');
      P_BURST.kind = 'blast'; P_BURST.x = a.x; P_BURST.y = 0.6; P_BURST.z = z; P_BURST.n = 0;
      this._emit('fx:burst', P_BURST);
      P_DECAL.kind = 'ring'; P_DECAL.x = a.x; P_DECAL.z = z; P_DECAL.size = HA.splash * 2; P_DECAL.seconds = 0.6; P_DECAL.color = 0xFFB040;
      P_DECAL.top = false; P_DECAL.id = -1;
      this._emit('fx:decal', P_DECAL);
      const fx = this.ctx.fx;
      if (fx && fx.addTrauma) fx.addTrauma(JUICE.trauma.bossSlam * 0.35);
      a.done++;
    }
    if (a.done >= HA.bombs) a.on = false;
  }

  // -------------------------------------------------------------------------------------------
  // Boss hooks (boss.js hold mode)
  // -------------------------------------------------------------------------------------------

  _bossTarget(kind, x) {
    if (kind === 'acid') return segOf(x + (this._rng.next() * 2 - 1) * HB.acidX);
    return this._weakest();
  }

  /** A wind-up starts: a hold-action window (D30); the stagger lesson at the first wind-up seen (the hold's one slow-mo). */
  _bossWindup(kind, s, sec) {
    if (!this._live()) return;
    const src = this._windowSource(this._t);
    if (src) this._holdActions++;
    if (!this._windupSeen) {
      this._windupSeen = true;
      const fx = this.ctx.fx, S = JUICE.slowmo.bossTutorial, save = this.ctx.save;
      const fresh = !!(save && !save.hintDone('hold.stagger'));
      const slow = fresh && !this._lessonSlow && S && S[0] > 0 && S[0] < 1 && fx && typeof fx.slowmo === 'function';
      const shown = this._lesson('hold.stagger', null, slow ? sec / S[0] + S[1] + 1 : sec + 1, null, true);
      if (shown && slow) { this._lessonSlow = true; fx.slowmo(S[0], sec / S[0] + S[1]); }
    }
  }

  /** The attack lands on section s (slam −45 and kills if it breaks it; acid −45 and 3 globs; charge −60 on s and a neighbour). */
  _bossAttack(kind, s, x, z) {
    if (!this._live()) return;
    const squad = this.ctx.squad, wp = HB.wp[kind];
    if (kind === 'slam') {
      if (this._hp[s] > wp) this._hp[s] -= wp;
      else {
        this._hp[s] = 0; this._breach(s);
        if (squad && squad.count > 0) squad.removeSoldiers(Math.max(HB.slamKills.min, Math.round(HB.slamKills.frac * squad.count)), 'slam', segCx(s), HF.frontZ);
      }
    } else if (kind === 'acid') {
      this._hp[s] = Math.max(0, this._hp[s] - wp);
      if (this._hp[s] <= 0) this._breach(s);
      const k = this._spec.spitKills | 0 || 1;
      for (let g = 0; g < HB.acidGlobs && squad && squad.count > 0; g++) squad.removeSoldiers(k, 'spit', segCx(s) + (g - 1) * 0.6, HF.frontZ);
    } else {
      const s2 = s < NSEC - 1 ? s + 1 : s - 1;
      for (let q = 0; q < 2; q++) {
        const sec = q === 0 ? s : s2;
        this._hp[sec] = Math.max(0, this._hp[sec] - wp);
        if (this._hp[sec] <= 0) this._breach(sec);
      }
    }
  }

  _bossStagger(x, z) {
    this._staggers++;
    P_STAG.x = x; P_STAG.z = z; P_STAG.staggers = this._staggers;
    this._emit('horde:stagger', P_STAG);
    this._pill('stagger', STRINGS.hold.stagger, x, 5.2, z, 1.2);
  }

  /** The enrage breaks section s at enrageBreak WP/s; true once it is down (the boss chews). */
  _bossBreak(s, dt) {
    if (this._hp[s] > 0) {
      this._hp[s] = Math.max(0, this._hp[s] - HB.enrageBreak * dt);
      if (this._hp[s] <= 0) this._breach(s);
      return false;
    }
    return true;
  }

  /** Phase minions into the crowd under the wall rules (the reserve above the feed cap; HP max(1, baseHp·hzShop)). */
  _bossBurst(type, n, x, z) {
    const crowd = this.ctx.crowd;
    if (!crowd || !crowd.active || !this._live()) return;
    const t = crowd.typeIndex(type);
    if (t < 0) return;
    crowd.spawnBurst(x, z, n | 0, t, Math.max(1, BASE_HP[t] * this._hzShop), HB.minionX);
    this._minions += n | 0;
  }

  // -------------------------------------------------------------------------------------------
  // The end
  // -------------------------------------------------------------------------------------------

  /** boss:dead in a hold: the rest flees (no coins, no bites); level samples the survivors and runs the results. */
  _onBossDead() {
    if (!this.active || (this._state !== ST_HOLD && this._state !== ST_STOP)) return;
    const ctx = this.ctx;
    this._state = ST_WON; this._cause = 'boss';
    this._survivors = ctx.squad ? ctx.squad.count : 0;
    if (ctx.crowd && ctx.crowd.active) ctx.crowd.flee();
    for (let i = 0; i < this._sup.length; i++) if (this._sup[i].state === 2) { this._sup[i].state = 3; this._hideCrate(i); }
    this._endEvents(true, 'boss');
  }

  /** squad:dead in a hold: SQUAD LOST (level's theatre). */
  _onSquadDead() {
    if (!this.active || this._state === ST_WON || this._state === ST_LOST) return;
    this._state = ST_LOST; this._cause = 'squad';
    this._endEvents(false, 'squad');
  }

  _endEvents(won, cause) {
    P_END.won = won; P_END.cause = cause; P_END.kills = this._kills(); P_END.survivors = won ? this._survivors : 0;
    this._emit('horde:end', P_END);
    this._hudOff();
  }

  /** The roar bed and the hold's HUD go (the end of the hold, or a quit). */
  _hudOff() {
    P_LOOP.on = false;
    this._emit('audio:loop', P_LOOP);
    this._emitAnchors(0);
    P_COUNTER.on = false;
    this._emit('hud:counter', P_COUNTER);
    P_ACTION.on = false;
    this._emit('hud:action', P_ACTION);
  }

  /** level commits the result: no more gameplay; the scene stays until reset(). */
  end() {
    if (!this.active) return;
    this._cutScale(false);
    if (this._state === ST_HOLD || this._state === ST_STOP) this._state = ST_LOST;
    if (!this._ended) {
      this._ended = true;
      P_LOOP.on = false;
      this._emit('audio:loop', P_LOOP);
    }
  }

  fireEvent(ev) { return false; }

  /** Survivors at the boss kill (the stars count them against E_hold). */
  metric() { return this._state === ST_WON ? this._survivors : (this.ctx.squad ? this.ctx.squad.count : 0); }

  /** The hold's part of a failed run, 0–1: surges survived (the third once the boss walked in), the boss's walk-in. */
  fraction() { return this._surgesCleared() / 3; }

  _surgesCleared() {
    const spec = this._spec;
    if (!spec || this._state === ST_STOP) return 0;
    if (this._state === ST_WON) return 3;
    let n = 0;
    for (let i = 1; i < spec.surges.length; i++) if (this._t >= spec.surges[i].t) n++;
    if (this._bossSpawned) n++;
    return n > 3 ? 3 : n;
  }

  _kills() { const c = this.ctx.crowd; return c ? c.kills - this._kills0 : 0; }

  /** The results' report (level resets the fields first): actions, eased surges, staggers, LINE HELD, kits left, kills, surges. */
  stat(out) {
    out.holdActions = this._holdActions;
    out.holdSurgeWindows = this._holdSurgeWindows;
    for (let i = 0; i < 3 && i < out.eased.length; i++) out.eased[i] = !!this._eased[i];
    out.staggers = this._staggers;
    out.lineHeld = this._state === ST_WON && !this._everBreached;
    out.kits = this._state === ST_WON ? this._kits : 0;
    out.kills = this._kills();
    out.total = this._n + this._minions;
    out.surgesCleared = this._surgesCleared();
    return out;
  }

  /** Debug (?debug=1): 'boss' spawns the boss now, 'win' kills it, 'overrun' drops every section. */
  debugSkip(kind) {
    if (!this.active || this._state !== ST_HOLD) return false;
    const boss = this.ctx.boss;
    if (kind === 'boss') { if (!this._bossSpawned) this._spawnBoss(); return true; }
    if (kind === 'win') { if (boss && boss.active) { boss.damage(1e12, 1e6, boss.x, 2, boss.z); return true; } return false; }
    if (kind === 'overrun') { for (let s = 0; s < NSEC; s++) { this._hp[s] = 0; this._breach(s); } return true; }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // Lessons (D40) and the FIELD GUIDE
  // -------------------------------------------------------------------------------------------

  _lessons() {
    if (!this._repairSeen) {
      for (let s = 0; s < NSEC; s++) {
        if (this._hp[s] < HW.segHp * HL.repairBelow && this._hp[s] > 0) { this._repairSeen = true; this._lesson('hold.repair', null, 6); break; }
      }
    }
    if (!this._bruteSeen && this._bruteNear) { this._bruteSeen = true; this._lesson('hold.brute'); }
  }

  /** level.showHint (once ever per save, ui marks it); `release` holds it until hint:release; priority cuts a toast. */
  _lesson(id, arg, hold, release, priority) {
    const lvl = this.ctx.level;
    if (!lvl || !lvl.showHint) return false;
    HINT_OPTS.hold = hold > 0 ? hold : 0; HINT_OPTS.until = release || null; HINT_OPTS.priority = !!priority; HINT_OPTS.event = -1;
    return lvl.showHint(id, arg, HINT_OPTS);
  }

  _release(key) { P_RELEASE.key = key; this._emit('hint:release', P_RELEASE); }

  /** Lesson `id` is done in the save: the player did what it asks. */
  _done(id) { const save = this.ctx.save; if (save && save.markHint) save.markHint(id); }

  /** The FIELD GUIDE entry `id` met in play (save.hints 'seen:<id>', as level's). */
  _seen(id) { this._done('seen:' + id); }

  // -------------------------------------------------------------------------------------------
  // HUD kit (P7 draws it) and the rate-limited horde:* events
  // -------------------------------------------------------------------------------------------

  _hud(now) {
    const spec = this._spec, crowd = this.ctx.crowd, surges = spec.surges, nS = surges.length;
    // progress: the surge bar with the boss skull ('SURGE 2/3' while one spawns, 'NEXT SURGE n' in a gap, 'BOSS' after)
    let started = 0;
    for (let i = 0; i < nS; i++) if (now >= surges[i].t) started = i + 1;
    let label;
    if (this._bossSpawned) label = STRINGS.hold.boss;
    else if (started > 0 && now < surges[started - 1].t + surges[started - 1].window + 2) label = STRINGS.hold.surge(started, nS);
    else if (started < nS) label = STRINGS.hold.next(Math.max(1, Math.ceil(surges[started].t - now)));
    else label = STRINGS.hold.next(Math.max(1, Math.ceil(spec.boss.at - now)));
    let filled = started;
    if (started < nS) { const a = started > 0 ? surges[started - 1].t : 0; filled += clamp((now - a) / Math.max(1, surges[started].t - a), 0, 1) - 1; if (filled < 0) filled = 0; }
    else filled = 3;
    if (label !== P_PROGRESS.label || Math.abs(filled - P_PROGRESS.filled) > 0.02 || P_PROGRESS.boss !== this._bossSpawned) {
      P_PROGRESS.label = label; P_PROGRESS.filled = filled; P_PROGRESS.segments = nS; P_PROGRESS.boss = this._bossSpawned;
      this._emit('hud:progress', P_PROGRESS);
    }
    // the LEFT counter and horde:left (10 Hz)
    const left = this._left();
    P_LEFT.left = left; P_LEFT.alive = crowd ? crowd.alive : 0; P_LEFT.queued = left - P_LEFT.alive;
    this._emit('horde:left', P_LEFT);
    if (left !== this._lastLeft) { this._lastLeft = left; this._emitCounter(false); }
    // focus glow level (≤ 10 Hz, on change)
    if (this._focusLevel !== P_FOCUS.level) { P_FOCUS.level = this._focusLevel; this._emit('horde:focus', P_FOCUS); }
    // the repair bubbles: projected section anchors under bubbleBelow (or breached)
    this._emitAnchors(-1);
    if (this._kits !== this._lastKitsShown) this._emitAction(false);
    // the horde's roar bed follows the crowd's size
    this._loopAcc += 1 / HH.hz;
    if (this._loopAcc >= 1) {
      this._loopAcc = 0;
      P_LOOP.on = true; P_LOOP.gain = clamp(0.25 + (crowd ? crowd.alive : 0) / 2400, 0.25, 1);
      this._emit('audio:loop', P_LOOP);
    }
  }

  _emitCounter(force) {
    const left = this._left();
    P_COUNTER.on = this._state === ST_HOLD; P_COUNTER.value = left;
    if (force || P_COUNTER.text === '' || left !== this._lastLeftText) { P_COUNTER.text = STRINGS.hold.left(left); this._lastLeftText = left; }
    this._emit('hud:counter', P_COUNTER);
  }

  _emitAction(force) {
    this._lastKitsShown = this._kits;
    P_ACTION.on = this._state === ST_HOLD || this._state === ST_STOP; P_ACTION.icon = 'kit'; P_ACTION.badge = this._kits;
    P_ACTION.disabled = this._kits <= 0; P_ACTION.label = STRINGS.hold.repair;
    this._emit('hud:action', P_ACTION);
  }

  /** hud:anchors: the shown repair bubbles (n = −1 recomputes, 0 hides them all). */
  _emitAnchors(n) {
    const r = this.ctx.render, list = P_ANCHORS.list;
    list.length = 0;
    if (n !== 0 && r && r.worldToScreen && this._live()) {
      for (let s = 0; s < NSEC; s++) {
        const show = this._hp[s] < HW.segHp * HK.bubbleBelow;
        const a = show ? this._actionOf(s) : A_NONE;
        if (a === A_NONE) continue;
        V3.set(segCx(s), HH.bubbleY, HF.wallZ);
        r.worldToScreen(V3, SCR);
        const row = ANCHOR_ROWS[s];
        row.x = SCR.x; row.y = SCR.y; row.state = ANCHOR_STATES[a];
        row.label = a === A_GAP ? STRINGS.hold.clearGap : (a === A_NOKITS ? STRINGS.hold.noKits : STRINGS.hold.repair);
        list.push(row);
      }
    }
    P_ANCHORS.n = list.length;
    this._emit('hud:anchors', P_ANCHORS);
  }

  _banner(text, kicker, color, seconds) {
    P_BANNER.text = text; P_BANNER.kicker = kicker || ''; P_BANNER.color = color; P_BANNER.seconds = seconds;
    this._emit('hud:banner', P_BANNER);
  }

  /** A short world label ('BREACH!', 'STAGGER!', '+1 KIT', 'CLEAR THE GAP') at a projected point. */
  _pill(id, text, x, y, z, seconds) {
    const r = this.ctx.render;
    P_PILL.id = id; P_PILL.icon = id; P_PILL.text = text; P_PILL.seconds = seconds; P_PILL.x = 0; P_PILL.y = 0;
    if (r && r.worldToScreen) { V3.set(x, y, z); r.worldToScreen(V3, SCR); P_PILL.x = SCR.x; P_PILL.y = SCR.y; }
    this._emit('hud:pill', P_PILL);
  }

  _emit(name, payload) { const ev = this.ctx.events; if (ev) ev.emit(name, payload); }

  // -------------------------------------------------------------------------------------------
  // botView (read-only; bots act through input.aimTargetX and ui:action / ui:anchorTap)
  // -------------------------------------------------------------------------------------------

  _updateView() {
    const v = this.botView, ctx = this.ctx, crowd = ctx.crowd, boss = ctx.boss, input = ctx.input, spec = this._spec;
    if (!ctx.debug || !ctx.debug.enabled) return;        // bots and probes run under ?debug=1
    v.active = this.active; v.state = VIEW_STATES[this._state];
    v.t = this._t;
    for (let s = 0; s < NSEC; s++) {
      v.sections[s] = this._hp[s]; v.gapClear[s] = this._gapClear[s] >= HK.rebuildClearS ? 1 : 0; v.cool[s] = this._cool[s]; v.repairing[s] = this._repLeft[s];
    }
    v.kits = this._kits; v.kitsCap = this._kitsCap; v.laneX = input ? input.aimX : 0; v.laneTarget = input ? input.aimTargetX : 0;
    v.focusLevel = this._focusLevel; v.worstSection = this._weakest(); v.overrunT = this._overrunT;
    v.alive = crowd ? crowd.alive : 0; v.waiting = crowd && crowd.active ? crowd.waiting : 0; v.queued = this._n - this._ptr + (crowd ? crowd.queued : 0);
    v.holdActions = this._holdActions; v.holdSurgeWindows = this._holdSurgeWindows; v.staggers = this._staggers;
    for (let i = 0; i < 4; i++) v.eased[i] = this._eased[i];
    v.C = ctx.squad ? ctx.squad.count : 0; v.C0 = this._C0; v.eHold = this._eHold; v.holdSeed = this._holdSeed;
    v.stored = ctx.weapons ? ctx.weapons.storedCount | 0 : 0;
    v.dps = ctx.weapons && this._state === ST_HOLD ? ctx.weapons.squadDps() : 0;
    if (spec) {
      v.surges = spec.surges.length;
      let si = 0;
      for (let i = 0; i < spec.surges.length; i++) { v.surgeAt[i] = spec.surges[i].t; if (this._t >= spec.surges[i].t) si = i + 1; }
      v.surgeIndex = si; v.nextSurgeAt = si < spec.surges.length ? spec.surges[si].t : spec.boss.at;
    }
    const b = v.boss;
    b.spawned = this._bossSpawned;
    b.alive = !!(boss && boss.active && boss.holdMode);
    if (b.alive) {
      b.twin = boss.unitAlive(1) || (spec && spec.boss.id === 'hulkTwins');
      const u0 = boss.unitAlive(0) ? 0 : 1;
      b.x = boss.unitX(u0); b.z = boss.unitZ(u0); b.hp = boss.hp; b.maxHp = boss.maxHp; b.windup = boss.holdWindup(u0);
      b.alive2 = boss.unitAlive(1) && u0 === 0; b.x2 = b.alive2 ? boss.unitX(1) : b.x; b.z2 = b.alive2 ? boss.unitZ(1) : b.z; b.windup2 = b.alive2 ? boss.holdWindup(1) : -1;
      b.enraged = boss.holdEnraged; b.inRange = b.z >= HF.rangeZ; b.arrived = b.z >= HB.holdZ - 0.05;
      if (b.arrived && b.arrivedAt < 0) b.arrivedAt = this._t;
      b.shield = boss.shieldUp;
    }
    for (let i = 0; i < 2; i++) { const s = this._sup[i], o = v.supply[i]; o.live = s.state === 2; o.x = s.x; o.seen = s.seen; }
    // per-section threat (the bots' aim: HP-weighted units near the wall), computed only when a bot asks (v.wantThreat)
    if (v.wantThreat && crowd && crowd.active) this._threatInto(v);
  }

  /** holdsim's bot threat per section: HP × distance weight × type weight, × the section's damage (bots read it). */
  _threatInto(v) {
    const c = this.ctx.crowd, th = v.threat, M = c.MODE;
    th.fill(0);
    let near = 0;
    for (let k = 0; k < c.nLive; k++) {
      const i = c.live[k];
      if (c.state[i] !== 1) continue;
      const z = c.z[i], x = c.x[i];
      const s = (z > HF.throatZ || Math.abs(x) < HF.wallHalf) ? segOf(x) : segOf(c.tx[i]);
      const wz = z > -8 ? 1.5 : (z > -16 ? 1 : (z > -30 ? 0.5 : 0.15));
      const tw = c.type[i] === T_BRUTE ? 2 : (c.mode[i] === M.HOLD && c.type[i] === T_SPITTER ? 4 : 1);
      th[s] += c.hp[i] * wz * tw;
      if (z > -16) near += c.hp[i];
    }
    for (let s = 0; s < NSEC; s++) th[s] *= 1 + 2 * (1 - this._hp[s] / HW.segHp) + (this._hp[s] <= 0 ? 2 : 0);
    v.near = near;
  }

  // -------------------------------------------------------------------------------------------
  // render (per frame): the barricade on the road, the marks, the crates
  // -------------------------------------------------------------------------------------------

  render(alpha) {
    if (!this._armed || !this._group) return;
    const w = this.ctx.world;
    // the barricade rides the road until the stop: its face reaches wallZ exactly when the road stops at the anchor
    const dz = w ? w.distance - this._anchorD : 0;
    const z = dz < 0 ? dz : 0;
    this._group.position.z = z;
    this._group.visible = this.active || z > HORDE.stop.appearZ;
    if (!this.active) return;
    // the worst frame's draw budget: under a laser's beams the crowd's streaks and the crates' chutes go
    const c = this.ctx.crowd, wp = this.ctx.weapons, laser = !!wp && wp.weapon === WEAPONS.laser.id;
    if (c) c.setStreaks(!laser);
    this._renderMarks();
    this._renderCrates(laser);
  }

  // -------------------------------------------------------------------------------------------
  // Meshes (prepare time)
  // -------------------------------------------------------------------------------------------

  _build() {
    if (this._built) return;
    const r = this.ctx.render;
    if (!r || !r.scene) return;
    this._built = true;
    const g = this._group = new Group();
    g.name = 'hold'; g.visible = false;
    // ---- the barricade
    const B = new BoxBuilder();
    this._buildBarricade(B);
    const nv = B.pos.length / 3;
    const geo = new BufferGeometry();
    const pos = new Float32Array(B.pos);
    geo.setAttribute('position', new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(B.nor), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(nv * 3), 3));
    geo.setIndex(new BufferAttribute(nv > 65535 ? new Uint32Array(B.idx) : new Uint16Array(B.idx), 1));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 40;                    // planks collapse and the group slides: never culled while near
    this._rest = pos.slice();
    this._slot = Uint8Array.from(B.slot); this._shade = Float32Array.from(B.shade);
    const P = B.pieces;
    this._pc = P.length;
    this._pStart = Int32Array.from(P.map((p) => p.start)); this._pSec = Int8Array.from(P.map((p) => p.sec));
    this._pThr = Float32Array.from(P.map((p) => p.thr)); this._pFall = Uint8Array.from(P.map((p) => (p.fallen ? 1 : 0)));
    this._pCx = Float32Array.from(P.map((p) => p.cx)); this._pCy = Float32Array.from(P.map((p) => p.cy)); this._pCz = Float32Array.from(P.map((p) => p.cz));
    this._pShown = new Uint8Array(P.length).fill(1);
    this._mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.04 });
    const mesh = this._barricade = new Mesh(geo, this._mat);
    mesh.name = 'hold.barricade'; mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh);
    // ---- supply crates (the barricade's material: no extra program) and their chutes
    const cb = new BoxBuilder();
    cb.box(0, 0.4, 0, 0.8, 0.8, 0.8, 0, 0, 0, SLOT_CRATE, 1);
    cb.box(0, 0.4, 0, 0.84, 0.12, 0.84, 0, 0, 0, SLOT_ACCENT, 1);
    cb.box(0, 0.4, 0, 0.12, 0.84, 0.84, 0, 0, 0, SLOT_ACCENT, 0.95);
    const chb = new BoxBuilder();
    // r8 V1F (LOOKS-3): a cross canopy — a crown, then four arms that droop in two folds, each split into an orange and a
    // white gore (eight by turns around it), a cord from each arm's hem to the crate (the 1.9 m slab with a cap read as a
    // grey table top from the hold camera)
    chb.box(0, 2.66, 0, 0.84, 0.07, 0.84, 0, 0, 0, SLOT_CHUTE, 1);
    chb.box(0, 2.72, 0, 0.34, 0.07, 0.34, 0, 0, 0, SLOT_GORE, 1);
    for (let a = 0; a < 4; a++) {
      const yaw = a * Math.PI / 2, sx = Math.sin(yaw), cz = Math.cos(yaw);
      for (let h = -1; h <= 1; h += 2) {
        const slot = h > 0 ? SLOT_GORE : SLOT_CHUTE, tx = cz * h * 0.21, tz = -sx * h * 0.21;
        chb.box(sx * 0.6 + tx, 2.55, cz * 0.6 + tz, 0.42, 0.07, 0.46, yaw, 0.52, 0, slot, 1);
        chb.box(sx * 0.88 + tx, 2.26, cz * 0.88 + tz, 0.42, 0.07, 0.44, yaw, 1.08, 0, slot, 0.92);
      }
      chb.box(sx * 0.66, 1.46, cz * 0.66, 0.03, 1.4, 0.03, yaw, 0.47, 0, SLOT_POST, 0.6);
    }
    const crateGeo = this._geoOf(cb), chuteGeo = this._geoOf(chb);
    for (let i = 0; i < this._sup.length; i++) {
      const m = new Mesh(crateGeo, this._mat); m.name = 'hold.crate'; m.castShadow = true; m.visible = false;
      const c = new Mesh(chuteGeo, this._mat); c.name = 'hold.chute'; c.visible = false;
      g.add(m); g.add(c);
      this._sup[i].mesh = m; this._sup[i].chute = c;
    }
    this._paintStatic(crateGeo); this._paintStatic(chuteGeo);
    // ---- the marks: one instanced draw (no fog, no depth write)
    const q = new PlaneGeometry(1, 1);
    const ig = new InstancedBufferGeometry();
    ig.setIndex(q.index); ig.setAttribute('position', q.attributes.position);
    this._mkPos = new InstancedBufferAttribute(new Float32Array(MARK_CAP * 4), 4).setUsage(DynamicDrawUsage);
    this._mkSize = new InstancedBufferAttribute(new Float32Array(MARK_CAP * 4), 4).setUsage(DynamicDrawUsage);
    this._mkCol = new InstancedBufferAttribute(new Float32Array(MARK_CAP * 4), 4).setUsage(DynamicDrawUsage);
    ig.setAttribute('aPos', this._mkPos); ig.setAttribute('aSize', this._mkSize); ig.setAttribute('aCol', this._mkCol);
    ig.instanceCount = 0;
    const uTime = r.uniforms && r.uniforms.uTime ? r.uniforms.uTime : { value: 0 };
    const mm = new ShaderMaterial({ uniforms: { uTime }, vertexShader: MARK_VERT, fragmentShader: MARK_FRAG, transparent: true, depthWrite: false,
      side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const marks = this._marks = new Mesh(ig, mm);
    marks.name = 'hold.marks'; marks.frustumCulled = false; marks.renderOrder = 2;
    g.add(marks);
    const c = new Color(), pal = this._mkPal = new Float32Array(MK_HEX.length * 3);
    MK_HEX.forEach((h, i) => { c.setHex(h); pal[i * 3] = c.r; pal[i * 3 + 1] = c.g; pal[i * 3 + 2] = c.b; });
    r.scene.add(g);
    this._lookId = '';
    this._applyLook(1);
  }

  /** A small static geometry from a builder (crates, chutes). */
  _geoOf(b) {
    const geo = new BufferGeometry(), nv = b.pos.length / 3;
    geo.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(b.nor), 3));
    const col = new Float32Array(nv * 3);
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.setIndex(new BufferAttribute(new Uint16Array(b.idx), 1));
    geo.userData.slot = Uint8Array.from(b.slot); geo.userData.shade = Float32Array.from(b.shade);
    geo.computeBoundingSphere();
    return geo;
  }

  _paintStatic(geo) {
    const col = geo.attributes.color.array, slot = geo.userData.slot, shade = geo.userData.shade, c = new Color();
    for (let v = 0; v < slot.length; v++) {
      const s = slot[v];
      c.setHex(s === SLOT_CRATE ? CRATE_WOOD : (s === SLOT_CHUTE ? CHUTE : (s === SLOT_GORE ? CHUTE_GORE : (s === SLOT_ACCENT ? 0xC8A040 : 0x3A3A3A))));
      col[v * 3] = c.r * shade[v]; col[v * 3 + 1] = c.g * shade[v]; col[v * 3 + 2] = c.b * shade[v];
    }
    geo.attributes.color.needsUpdate = true;
  }

  /** The barricade's pieces (face at HF.wallZ, the stopped frame): planks (each with a fallen twin), posts, braces, sandbags,
   *  a sheet patch and an accent board per section; the side closures, the wing walls and the firing step stay up. */
  _buildBarricade(B) {
    const z0 = HF.wallZ, d = HF.depth, H = HF.height, W = HF.segW;
    const PLANK_THR = [0.82, 0.64, 0.47, 0.3, 0.14];
    // posts at every section edge, a cap on each
    for (let k = 0; k <= NSEC; k++) {
      const x = -HF.wallHalf + k * W;
      B.box(x, (H + 0.25) / 2, z0 + 0.08, 0.2, H + 0.25, 0.2, 0, 0, (hash01(k * 7) - 0.5) * 0.06, SLOT_POST, 0.9);
      B.box(x, (H + 0.2) / 2, z0 + d - 0.12, 0.16, H + 0.2, 0.16, 0, 0, 0, SLOT_POST, 0.75);
    }
    for (let s = 0; s < NSEC; s++) {
      const cx = segCx(s);
      // the order the planks fall in differs per section (a stable shuffle)
      const thr = PLANK_THR.slice();
      for (let i = thr.length - 1; i > 0; i--) { const j = Math.floor(hash01(s * 31 + i) * (i + 1)); const t = thr[i]; thr[i] = thr[j]; thr[j] = t; }
      for (let p = 0; p < 5; p++) {
        const y = 0.16 + p * 0.215, h = 0.19 - hash01(s * 13 + p) * 0.03;
        const roll = (hash01(s * 17 + p * 3) - 0.5) * 0.09, len = W - 0.14 - hash01(s * 5 + p) * 0.12;
        const shade = 0.82 + hash01(s * 11 + p * 7) * 0.3;
        B.box(cx + (hash01(p + s * 3) - 0.5) * 0.1, y, z0 + 0.03, len, h, 0.07, 0, 0, roll, SLOT_PLANK, shade, s, thr[p], false);
        // its fallen twin: on the ground in front of the face, askew
        const fx = cx + (hash01(s * 19 + p) - 0.5) * 1.1, fz = z0 - 0.35 - hash01(s * 23 + p) * 0.9;
        B.box(fx, 0.04 + p * 0.012, fz, len * 0.9, 0.07, h, (hash01(s * 29 + p) - 0.5) * 1.4, 0, 0, SLOT_DEBRIS, shade * 0.9, s, thr[p], true);
      }
      // the back: two cross braces (fall when breached), a rail
      B.box(cx - 0.45, H * 0.5, z0 + d - 0.18, 0.1, H * 1.1, 0.08, 0, 0, 0.75, SLOT_POST, 0.7, s, 0.001, false);
      B.box(cx + 0.45, H * 0.5, z0 + d - 0.18, 0.1, H * 1.1, 0.08, 0, 0, -0.75, SLOT_POST, 0.7, s, 0.001, false);
      B.box(cx, H - 0.05, z0 + d * 0.5, W - 0.1, 0.08, d - 0.2, 0, 0, 0, SLOT_PLANK, 0.75, s, 0.2, false);
      // a sheet-metal patch and an accent board (paint, hazard tape)
      const sx = cx + (hash01(s * 41) - 0.5) * 0.7;
      B.box(sx, 0.55 + hash01(s * 43) * 0.25, z0 - 0.02, 0.75, 0.55, 0.03, 0, 0, (hash01(s * 47) - 0.5) * 0.25, SLOT_SHEET, 1, s, 0.38, false);
      B.box(cx - sx * 0.2, 0.95, z0 - 0.04, 0.9, 0.09, 0.03, 0, 0, (hash01(s * 53) - 0.5) * 0.3, SLOT_ACCENT, 1, s, 0.56, false);
      // sandbags along the base (half of them spill when it breaks)
      for (let b = 0; b < 6; b++) {
        const bx = cx - W / 2 + 0.2 + b * ((W - 0.4) / 5), br = (hash01(s * 59 + b) - 0.5) * 0.3;
        B.box(bx, 0.09, z0 - 0.2, 0.34, 0.18, 0.3, br, 0, 0, SLOT_BAG, 0.85 + hash01(s * 61 + b) * 0.25, s, b % 2 === 0 ? 0.001 : 0, false);
        if (b % 2 === 0) B.box(bx + 0.1, 0.07, z0 - 0.55 - hash01(s * 67 + b) * 0.4, 0.34, 0.14, 0.3, br + 0.8, 0, 0, SLOT_BAG, 0.8, s, 0.001, true);
      }
    }
    // side closures: plank fences with crates, flush with the wall ends, to the throat
    for (let side = -1; side <= 1; side += 2) {
      const x = side * (HF.wallHalf + 0.15), zc = (z0 + HF.throatZ) / 2, len = z0 - HF.throatZ + 0.6;
      for (let p = 0; p < 4; p++) B.box(x, 0.2 + p * 0.3, zc, 0.07, 0.24, len, 0, (hash01(p * 5 + side) - 0.5) * 0.04, 0, SLOT_PLANK, 0.78 + p * 0.05);
      B.box(x + side * 0.6, 0.5, z0 - 0.8, 1.0, 1.0, 1.0, 0.2 * side, 0, 0, SLOT_SHEET, 0.85);
      B.box(x + side * 0.5, 0.45, z0 - 2.4, 0.9, 0.9, 0.9, -0.3 * side, 0, 0, SLOT_ACCENT, 0.8);
      B.box(x, 0.65, HF.throatZ + 0.2, 0.22, 1.3, 0.22, 0, 0, 0, SLOT_POST, 0.85);
    }
    // wing walls: jersey barriers from the throat (|x| 4) to the funnel mouth (|x| 11 at z −25)
    const zt = HF.throatZ, zf = -25, ht = HF.wallHalf, hs = 11;
    const wl = Math.hypot(hs - ht, zt - zf), wa = Math.atan2(hs - ht, zt - zf), nb = Math.round(wl / 2.3);
    for (let side = -1; side <= 1; side += 2) {
      for (let b = 0; b < nb; b++) {
        const u = (b + 0.5) / nb, x = side * (ht + 0.4 + (hs - ht) * u), z = zt - (zt - zf) * u, yaw = -side * wa;
        const sh = 0.85 + hash01(b * 3 + side * 101) * 0.25;
        B.box(x, 0.16, z, 0.75, 0.32, 2.15, yaw, 0, 0, SLOT_CONCRETE, sh);
        B.box(x, 0.62, z, 0.36, 0.64, 2.1, yaw, 0, 0, SLOT_CONCRETE, sh * 1.04);
        B.box(x, 0.86, z, 0.38, 0.08, 2.12, yaw, 0, 0, SLOT_ACCENT, 0.9);
      }
    }
    // the firing step: a plank walkway the rear ranks stand on (0.45 m)
    const sz0 = HF.stepZ[0], sz1 = HF.stepZ[1], sw = HF.stepX;
    B.box(0, HF.stepY - 0.05, (sz0 + sz1) / 2, sw * 2, 0.1, sz1 - sz0, 0, 0, 0, SLOT_STEP, 1);
    for (let p = 0; p < 7; p++) B.box(0, HF.stepY + 0.005, sz0 + 0.18 + p * ((sz1 - sz0 - 0.36) / 6), sw * 2 - 0.04, 0.02, 0.2, 0, 0, 0, SLOT_STEP, 0.88 + (p % 2) * 0.12);
    B.box(0, HF.stepY * 0.5, sz0 - 0.02, sw * 2, HF.stepY, 0.06, 0, 0, 0, SLOT_POST, 0.7);
    for (let k = -3; k <= 3; k++) B.box(k * sw / 3, HF.stepY * 0.5, (sz0 + sz1) / 2, 0.12, HF.stepY - 0.1, sz1 - sz0 - 0.1, 0, 0, 0, SLOT_POST, 0.6);
  }

  /** The district's palette into the barricade's vertex colours (event time: a level start / dig-in). */
  _applyLook(L) {
    if (!this._built) return;
    const d = districtForLevel(L || 1);
    const id = d && d.id ? d.id : 'sunset';
    if (id === this._lookId) return;
    this._lookId = id;
    const look = HORDE.look[id] || HORDE.look.sunset;
    const pal = new Float32Array(10 * 3), c = new Color();
    const hexOf = [look.plank, look.post, look.sheet, look.bag, look.accent, look.debris, look.plank, CONCRETE, CRATE_WOOD, CHUTE];
    for (let s = 0; s < 10; s++) { c.setHex(hexOf[s]); pal[s * 3] = c.r; pal[s * 3 + 1] = c.g; pal[s * 3 + 2] = c.b; }
    const col = this._barricade.geometry.attributes.color, a = col.array, slot = this._slot, shade = this._shade;
    for (let v = 0; v < slot.length; v++) { const s = slot[v], k = shade[v]; a[v * 3] = pal[s * 3] * k; a[v * 3 + 1] = pal[s * 3 + 1] * k; a[v * 3 + 2] = pal[s * 3 + 2] * k; }
    col.needsUpdate = true;
  }

  /** A manual tier on software GL (Auto has its rungs) holds at HORDE.stop.softwareScale: the wall's view is all lit road and street, no sky. */
  _cutScale(on) {
    const q = this.ctx.quality, r = this.ctx.render;
    if (on === this._scaleCut || !q || !q.software || q.auto || !r || !r.setRenderScale) return;
    this._scaleCut = on;
    r.setRenderScale(on ? HORDE.stop.softwareScale : 1);
  }

  /** Every plank back up (a new hold / level start). */
  _resetBarricade() {
    if (!this._built) return;
    for (let s = 0; s < NSEC; s++) this._secLevel[s] = -1;
    for (let s = 0; s < NSEC; s++) this._updatePlanks(s, 1);
  }

  /** Section s at HP fraction f: planks above f stand, the others lie as debris (event time: only on a change). */
  _updatePlanks(s, f) {
    if (!this._built) return;
    const lvl = f <= 0 ? 0 : Math.min(20, 1 + Math.floor(f * 20));    // 5 % steps: the thresholds are coarser than this
    if (this._secLevel[s] === lvl) return;
    this._secLevel[s] = lvl;
    const pos = this._barricade.geometry.attributes.position, a = pos.array, rest = this._rest;
    let lo = 1e9, hi = -1;
    for (let p = 0; p < this._pc; p++) {
      if (this._pSec[p] !== s) continue;
      const up = f > this._pThr[p];
      const show = this._pFall[p] ? !up : up;
      if ((this._pShown[p] === 1) === show) continue;
      this._pShown[p] = show ? 1 : 0;
      const v0 = this._pStart[p] * 3, v1 = v0 + 24 * 3;
      if (show) for (let k = v0; k < v1; k++) a[k] = rest[k];
      else { const cx = this._pCx[p], cy = this._pCy[p], cz = this._pCz[p]; for (let k = v0; k < v1; k += 3) { a[k] = cx; a[k + 1] = cy; a[k + 2] = cz; } }
      if (v0 < lo) lo = v0;
      if (v1 > hi) hi = v1;
    }
    if (hi > lo) { pos.addUpdateRange(lo, hi - lo); pos.needsUpdate = true; }   // ranges add up until the next upload (three clears them)
  }

  // ---- marks -----------------------------------------------------------------------------------

  _mark(n, kind, x, y, z, hw, hh, fill, glow, col, alpha) {
    if (n >= MARK_CAP) return n;
    const P = this._mkPos.array, S = this._mkSize.array, C = this._mkCol.array, pal = this._mkPal, o = n * 4, q = col * 3;
    P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = kind;
    S[o] = hw; S[o + 1] = hh; S[o + 2] = fill; S[o + 3] = glow;
    C[o] = pal[q]; C[o + 1] = pal[q + 1]; C[o + 2] = pal[q + 2]; C[o + 3] = alpha;
    return n + 1;
  }

  _renderMarks() {
    const m = this._marks;
    if (!m) return;
    let n = 0;
    const live = this._state === ST_HOLD || this._state === ST_STOP;
    if (live) {
      // section bars over the planks
      for (let s = 0; s < NSEC; s++) {
        const f = this._hp[s] / HW.segHp, x = segCx(s), st = this._secState[s];
        n = this._mark(n, MK_BAR, x, HM.barY, HF.wallZ + 0.1, HM.barW * 0.5, HM.barH * 0.5, f, st === 2 ? 1 : 0, st < MC_BAD ? st : MC_BAD, 0.95);
        if (st === 3) n = this._mark(n, MK_CROSS, x, HM.barY + 0.01, HF.wallZ + 0.11, 0.22, 0.22, 1, 0, MC_BAD, 0.95);
      }
      if (this._state === ST_HOLD) {
        // the lane band on the ground, brighter with focus
        const lx = this.ctx.input ? this.ctx.input.aimX : 0;
        n = this._mark(n, MK_LANE, lx, HM.laneY, HF.wallZ - HM.laneLen * 0.5 - 0.6, HFI.laneHalf, HM.laneLen * 0.5, 1, this._focusLevel / 3, MC_LANE, 0.32);
        // crate rings with their open timer
        for (let i = 0; i < this._sup.length; i++) {
          const s = this._sup[i];
          if (s.state !== 2) continue;
          n = this._mark(n, MK_RING, s.x, HM.crateRingY, this._crateZ(i), 0.75, 0.75, clamp(s.seen / HS.openS, 0, 1), 0, MC_CRATE, 0.9);
        }
      }
    }
    this._mkPos.needsUpdate = true; this._mkSize.needsUpdate = true; this._mkCol.needsUpdate = true;
    m.geometry.instanceCount = n;
    m.visible = n > 0;
  }

  // ---- supply crates ------------------------------------------------------------------------------

  /** A crate lands just in front of the wall beside its section (outside a lane parked at the centre, holdgen). */
  _crateZ(i) { return HF.wallZ - 1.4 - i * 0.3; }

  _showCrate(i) {
    const s = this._sup[i];
    if (s.mesh) { s.mesh.visible = true; s.mesh.position.set(s.x, HS.dropY, this._crateZ(i)); }
    if (s.chute) { s.chute.visible = true; s.chute.position.set(s.x, HS.dropY, this._crateZ(i)); s.chute.scale.setScalar(1); }
  }

  _hideCrate(i) {
    const s = this._sup[i];
    if (s.mesh) s.mesh.visible = false;
    if (s.chute) s.chute.visible = false;
    if (i === 0 || i === 1) {
      P_BURST.kind = 'repair'; P_BURST.x = s.x; P_BURST.y = 0.5; P_BURST.z = this._crateZ(i); P_BURST.n = s.state === 3 && s.seen >= HS.openS ? 16 : 0;
      if (P_BURST.n > 0) this._emit('fx:burst', P_BURST);
    }
  }

  _hideCrates() { for (const s of this._sup) { if (s.mesh) s.mesh.visible = false; if (s.chute) s.chute.visible = false; } }

  _renderCrates(noChute) {
    for (let i = 0; i < this._sup.length; i++) {
      const s = this._sup[i];
      if (s.state !== 2 || !s.mesh) continue;
      const u = clamp((this._t - s.landT) / HS.fallS, 0, 1);
      const y = HS.dropY * (1 - u) * (1 - u);
      s.mesh.position.y = y;
      s.mesh.rotation.y = (1 - u) * 1.2;
      if (s.chute) {
        s.chute.position.y = y;
        const k = u < 1 ? 1 : Math.max(0, 1 - (this._t - s.landT - HS.fallS) * 3);
        s.chute.scale.set(k, k > 0 ? k * k : 0.001, k);   // it sinks first, then folds in
        s.chute.visible = k > 0.01 && !noChute;
      }
    }
  }
}
