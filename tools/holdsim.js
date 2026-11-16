// tools/holdsim.js — GATE RUSH HORDE hold simulator (node only; never shipped, never reached from js/).
//
// The port of the horde-v2 2D crowd model (E:/Temp/claude/gate-rush-evidence/r8v2/horde-v2/sim/holdsim2.mjs, plan r2
// holdsim2-r2.mjs) onto the game's own data: the hold spec comes from js/holdgen.js (data.HORDE_GEN), the shop from
// data.expectedRanksOf / UPGRADES, the HP scale through util.holdHpScale (util.shopComp, D26) and the boss HP through
// util.holdBossHp. 1.4.0 rules on top of horde-v2:
//   - hold actions (D30): a counted action per window when, in the 3 s before a surge spawns or a boss wind-up starts, the
//     lane target travels ≥ 2 m, a repair is made or a supply crate is opened (every opened crate; drops land outside a lane
//     parked at the centre, holdgen's supply x, so a hands-off hold never opens one); one action per window, its source kept;
//   - first meeting (D29, A9): surge 1 eased when firstMeet and the run had ≥ 3 counted decisions; surge i ≥ 2 (and the
//     trickle after it) only with a counted hold action in its window. An eased unit spawns with HP × threat; the counts
//     never shrink. Below E_hold the live scaling lowers the unit HP, not the counts (A9);
//   - REINFORCEMENTS (D35): opts.kitsExtra = assist steps k → +k kits at the dig-in, kit cap 6 + k;
//   - the squad's boss damage carries its bossDamage bd (the hit rule); the boss HP carries the expected shop's bdExp^0.1·bd^0.9
//     (util.holdBossHp), so an expected shop meets horde-v2's boss TTK (horde-v2 had no boss-damage rank on either side) and
//     a surplus nets (bd / bdExp)^0.1, as the run's shop scale. A single boss walks in at x 0 (the Twins at ±2.2 m);
//   - the debut hold (L4) spawns no boss-phase brutes (its fodder minions stay).
//
// FIELD   wall face z −3.9 (4 sections × 2 m over x −4…+4); side closures flush with the wall ends (|x| 4.0) for z ≥ −7; the
//         funnel widens to |x| 11 at z −25; street |x| ≤ 11 back to the feed band z −70…−46.
// CROWD   per-unit x / z on a 1 m grid (counting sort), density-limited forward speed, lateral steer + diffusion, funnel clamp,
//         the production half-shell separation; one 30 Hz cadence.
// FIRE    the 40 front logical shooters (21 columns × 0.34 m over x ±3.4) fire straight −Z into their 1 m column; lane share
//         0.80 with FOCUS (50 % → 100 % over 0.8 s of dwell); rounds folded at the 90/s cap; nearest first with pierce
//         (leftover carries, ≤ 4 units); boss and holding-spitter priority shares over the crowd.
// WALL    claw slots, pile, climbers, breach bites, brute swings, repairs, kits, supply drops / airstrike, overrun clock.
// BOSS    per archetype: section attacks, wind-up → stagger, shield, plates, phase minions INTO the crowd, hold enrage.
//
// API
//   simulateHold(scriptOrHold, bot, seed, opts) → one hold's outcome (deterministic per arguments)
//   buildSpawns(hold, countMult, rand) → the hold's unit timetable (A9: counts scale only above E_hold)
//   holdOf(script) → the hold spec of a Horde script
//   runPhaseLines(L, script, ref) → the run phase's fixed-line arrivals at the expected shop and rank 10
//   runPartOf(script) → the run phase of a Horde script as generated (for levelgen.validateLevel)
//   validateHoldSection(script, opts) → the D37 report { errors, warnings, … }
//   BOTS, C_RATIO, RULES
import { holdHpScale, holdLiveScale, holdLiveHp, holdBossHp, holdFocusRate, mulberry32, shopComp } from '../js/util.js';
import { HORDE_GEN, FIRE, UPGRADES, BOSSES, LEAK_MODEL, expectedRanksOf } from '../js/data.js';
import * as levelgen from '../js/levelgen.js';

// ---------------------------------------------------------------------------------------------
// The runtime rule values the model assumes (PLAN horde TUNING 'Fixed values'; they must equal HORDE, P6)
// ---------------------------------------------------------------------------------------------

export const RULES = Object.freeze({
  // field (m)
  wallZ: -3.9, frontZ: -2.3, rangeZ: -44.3, wallHalf: 4.0, segW: 2.0, throatZ: -7, funnelZ: -25, streetHalf: 11.0,
  feedZ0: -70, feedZ1: -46, feedDensity: 3.0, r: 0.27,
  // fire (1.5.0: twinR, each Hulk Twin's column reach)
  laneHalf: 1.25, laneShare: 0.80, focusT: 0.8, focusFrom: 0.5, aimRange: 3.4, aimSpeed: 14, pierce: 4, rateCap: 90,
  beta: 0.5, betaWind: 0.75, betaOut: 0.2, bossR: 1.77, twinR: 1.25, spitBeta: 0.5, crawlerHitZ: -14,
  // crowd: walker, runner, crawler, brute, spitter speeds (m/s); steering, density, separation
  speed: [5.0, 7.0, 3.5, 3.0, 2.4], densCap: 3.4, steerK: 0.9, steerMax: 1.8, diffuse: 0.3, accel: 6,
  sepK: 0.65, sepMax: 10, sepZMin: -76, runnerRetargetZ: -23.9, crawlLunge: 3, crawlLungeSpeed: 6,
  // wall
  segHp: 100, slots: 5, clawDelay: 0.5, bruteClawDelay: 1.0, claw: [3, 3, 2.25, 12, 0], pile: 10, pileZone: 3.0,
  climbEvery: 0.8, climbMin: 0.8, climbSpeed: 3.0, breachRate: 2.0, breachWiden: 0.6, breachMax: 8, overrunS: 3.0,
  // kits, supply, airstrike, spitters, stored weapons (model value +100 % lane DPS for 8 s). A breached section rebuilds as
  // soon as no unit is in its gap (z > gapZ): the runtime's 0.5 s of clear gap first (horde 7) is NOT modelled, so in-engine
  // rebuilds come slightly later than here
  repairWp: 60, repairTime: 0.8, rebuildWp: 50, gapZ: -5.5, repairCool: 1.5, kitsStart: 2, kitsCap: 6,
  supplyLife: 6, supplyNeed: 1.0, airstrikeDpsS: 10, spitHoldZ: -18, spitEvery: 2.5, spitColX: 3.4, weaponDur: 8, weaponMult: 1.0,
  // crowd pool: the feed waits at `pool` alive (boss bursts may go past it)
  pool: 2048, reserve: 256,
  // boss
  bossWalk: 2.4, bossHoldZ: -12, enrageS: 20, stagger: 0.04, staggerJug: 0.06, staggerS: 1.0, minionScale: 10, bruteMinionScale: 3,
  enrageWalk: 6, enrageBreak: 150, chewPerE: 0.05, chewMin: 3,
  // hold actions (D30)
  actionWindowS: 3, actionLaneM: 2,
});

const TYPES = ['walker', 'runner', 'crawler', 'brute', 'spitter'];
const SOURCES = ['', 'lane', 'repair', 'crate'];    // a hold action's source (D30)
const W_ = 0, R_ = 1, C_ = 2, B_ = 3, S_ = 4;
const DT = 1 / 30;

// boss archetypes in a hold (attacks, intervals per phase, telegraphs, shields, plates, twins)
const ARCH = {
  hulk: { attacks: ['slam'], interval: [5, 5, 3] },
  spitterQueen: { attacks: ['acid'], interval: [3.0, 3.0, 2.0] },
  juggernaut: { attacks: ['charge'], interval: [4.5, 4.5, 3.0], plates: true },
  colossus: { attacks: ['slam', 'acid', 'charge'], interval: [4.5, 4.5, 3.0], shieldHits: 120 },
  colossusPrime: { attacks: ['slam', 'acid', 'charge'], interval: [4.5, 4.5, 3.0], shieldHits: 160 },
  hulkTwins: { attacks: ['slam'], interval: [5, 5, 3], twins: true },
};
const WINDUP = { charge: 1.6, acid: 1.0, slam: 1.2 };
// phase-entry minions (BOSSES onEnter; + lastHorde 10 walkers at phase 3, once per pair) spawned INTO the crowd ×10 (brutes ×3)
const MINIONS = { hulk: [null, { [R_]: 6 }, { [B_]: 2 }], hulkTwins: [null, { [R_]: 6 }, { [B_]: 2 }], spitterQueen: [null, null, { [C_]: 10 }],
  juggernaut: [null, null, null], colossus: [null, null, null], colossusPrime: [null, null, null] };

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

function halfAt(z) {
  const T = RULES;
  if (z >= T.throatZ) return T.wallHalf;
  if (z >= T.funnelZ) return T.wallHalf + (T.streetHalf - T.wallHalf) * (T.throatZ - z) / (T.throatZ - T.funnelZ);
  return T.streetHalf;
}
// portrait hold rig (0, 11, 10.5) → (0, 0, −11), 390×844, hFov 27.05°: a unit's centre (y 0.9) is on screen iff |x| ≤ limit(z)
const TANH = Math.tan(27.05 / 2 * Math.PI / 180);
function frustumHalf(z) { return (4.600 + 0.89024 * (10.5 - z)) * TANH + 0.3; }
const segOf = (x) => { const s = Math.floor((x + RULES.wallHalf) / RULES.segW); return s < 0 ? 0 : (s > 3 ? 3 : s); };
const segCx = (s) => -RULES.wallHalf + RULES.segW * (s + 0.5);

// 1 m grid
const GX0 = -12, GCOLS = 24, GZ0 = -80, GROWS = 82, NCELL = GCOLS * GROWS;
const ROW_RANGE = Math.floor(RULES.rangeZ - GZ0);
const MZ = -43.9;                                  // 'within 40 m of the wall' (the on-screen probe, D44)
const SEP_ROW_MIN = Math.floor(RULES.sepZMin - GZ0);
const CAPU = 4096;

// ---------------------------------------------------------------------------------------------
// Bots (PLAN horde TUNING 'Bots'; rev 2 + A4)
// ---------------------------------------------------------------------------------------------

/** Arrival C / E_hold per bot in the matrix (horde-v2); the run-line bots take theirs from the run phase. */
export const C_RATIO = Object.freeze({ passive: 0.7, oscillator: 0.85, aimer: 0.9, aimerR: 0.9, human: 1.0, strong: 1.15,
  swipeOnce: 0.8, swipePerSurge: 0.8, steerRunIdleHold: 1.0 });
/** Bots whose hold never acts (except the swipe bots' scripted drags): no arrival jitter, one run crate, no stored weapon. */
const PASSIVE_FAMILY = new Set(['passive', 'swipeOnce', 'swipePerSurge', 'steerRunIdleHold']);
export const BOTS = Object.freeze(['passive', 'oscillator', 'aimer', 'aimerR', 'human', 'strong', 'swipeOnce', 'swipePerSurge', 'steerRunIdleHold']);

// ---------------------------------------------------------------------------------------------
// Spawn timetable (the hold's units at the live squad; A9: counts × countMult ≥ 1 only)
// ---------------------------------------------------------------------------------------------

/**
 * The unit timetable of a hold: [{ t, type, x, tx, s }] sorted by t — surge units over each surge's window (a double surge's
 * second part on the opposite flank after its lag), brutes and spitters spread over the surges (brute push / spitter battery
 * take the bigger share), then the base trickle uniform over the spawn time. s = the surge whose first-meeting ease the unit
 * follows (a trickle unit: the last surge started before it). countMult scales every count (the live scaling above E_hold;
 * 1 at or below it); surgeMult (optional, per surge) is horde-v2's count ease, kept for model comparisons only; winMult (optional,
 * per surge) stretches a surge's spawn window (the A9 spacing relief). Each unit carries p0 = the start of its surge part and
 * tr = 1 for a trickle unit, so a window can be stretched again when its surge's ease is decided.
 */
export function buildSpawns(hold, countMult, rand, surgeMult, winMult) {
  const R = rand;
  const list = [];
  const { surges, mix } = hold;
  const flank = HORDE_GEN.patterns.flank;
  const pickFodder = () => { const u = R(); return u < mix[0] ? W_ : (u < mix[0] + mix[1] ? R_ : C_); };
  const tgtX = (s) => segCx(s) + (R() * 2 - 1) * 0.85;
  const nS = surges.length;
  const bruteW = surges.map((s) => (s.pattern === 'brutePush' ? 4 : 1)), spitW = surges.map((s) => (s.pattern === 'spitterBattery' ? 5 : 1));
  const bw = bruteW.reduce((a, b) => a + b, 0), sw = spitW.reduce((a, b) => a + b, 0);
  const segPick = new Int32Array(nS).fill(-1);       // brute push / crawler carpet / spitter battery: one section per surge
  for (let i = 0; i < nS; i++) {
    const s = surges[i];
    const mI = countMult * (surgeMult ? surgeMult[i] : 1);
    const n = Math.round(s.n * mI);
    const nb = Math.round(hold.brutes * mI * bruteW[i] / bw), nsp = Math.round(hold.spitters * mI * spitW[i] / sw);
    const n0 = s.double ? Math.round(n * HORDE_GEN.surges.double.split) : n;
    const parts = s.double ? [[s.t, n0, 0], [s.t + s.lag, n - n0, 1]] : [[s.t, n, 0]];
    const flip = R() < 0.5;
    const win = s.window * (winMult ? winMult[i] : 1);
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
        list.push({ t: ts, type, x: Math.max(-10.7, Math.min(10.7, x)), tx, s: i, p0: pt, tr: 0 });
      }
    }
  }
  // base trickle, uniform over the spawn time; it follows the ease of the last surge started before it
  const nb = Math.round(hold.trickle * countMult * (surgeMult ? surgeMult[nS] : 1));
  for (let k = 0; k < nb; k++) {
    const t = R() * hold.spawnEnd;
    let s = 0;
    while (s + 1 < nS && surges[s + 1].t <= t) s++;
    list.push({ t, type: pickFodder(), x: -10 + 20 * R(), tx: -3.6 + 7.2 * R(), s, p0: 0, tr: 1 });
  }
  list.sort((a, b) => a.t - b.t);
  return list;
}

/** The hold spec of a Horde script (its 'hold' event), or the argument itself when it already is one. */
export function holdOf(script) {
  if (script && script.surges) return script;
  const ev = script && script.events ? script.events.find((e) => e.type === 'hold') : null;
  if (!ev) throw new Error('holdsim: the script has no hold event');
  return ev.spec;
}

/** A shop as model numbers: ranks [squad, fireRate, damage, coinMult, bossDamage] → { f, d, bd, p }. */
function shopOf(rk) {
  const f = UPGRADES.fireRate.effect(rk[1]), d = UPGRADES.damage.effect(rk[2]), bd = UPGRADES.bossDamage.effect(rk[4]);
  const p = (f / FIRE.rateBase) * d;
  return { f, d, bd, p };
}

// ---------------------------------------------------------------------------------------------
// One hold
// ---------------------------------------------------------------------------------------------

/**
 * Simulates one hold. scriptOrHold: a Horde script (or its hold spec). bot: one of BOTS. seed: the hold's RNG seed.
 * opts (all optional):
 *   cRatio      arrival C / E_hold (default C_RATIO[bot]); C sets the arrival count directly
 *   cVar        arrival jitter ± (default 0.08; 0 for the passive family)
 *   ranks       the live shop [squad, fireRate, damage, coinMult, bossDamage] (default data.expectedRanksOf(L))
 *   firstMeet   the first-meeting ease is in play (D29); runDecisions = the run's counted gate decisions (default 0); easeAll =
 *               every surge eased (the threat-0.85-on-every-surge bound)
 *   kitsExtra   REINFORCEMENTS steps k (D35): +k·kitsPerStep kits at the dig-in, cap + k·capPerStep
 *   runKits     kits from the run's crates (default 1 for the passive family, else 2); stored = stored weapons (default 1 for
 *               human / strong, else 0)
 *   sep         the half-shell separation (default true); boss = force an archetype; bossHpMult = a boss HP multiplier
 *   live, threat, bossRules   override HORDE_GEN.live / HORDE_GEN.firstMeet.threat / HORDE_GEN.boss (experiments)
 *   relief, ease   experiments: { hp, win } exponents of the below-E_hold factor max(floor, r) (default { live.exp, 0 }) and of
 *               the first-meeting threat (default { 1, 0 }): unit HP × factor^hp, surge spawn windows × factor^−win
 *   countEase   horde-v2 comparisons only: the below-E_hold scaling and surge 1's ease on the counts instead of the HP (pre-A9)
 *   crateMoved  experiments: a crate is a hold action only when the lane moved to it (D30 counts every opened crate)
 *   supplyX     experiments: horde-v2's crate landing x (−3…+3 from the hold RNG) instead of the spec's (outside the centre lane)
 *   bossX       a single boss's x (experiments; default 0, the Twins ±2.2)
 *   runS        the run phase's seconds for levelS (default from the run gates and road speed)
 *   trace       an array: one row per second is pushed
 */
export function simulateHold(scriptOrHold, bot, seed, opts = {}) {
  const T = RULES;
  const hold = holdOf(scriptOrHold);
  const L = hold.L;
  const R = mulberry32(seed);
  const debut = !!hold.debut;
  const E = hold.eHold;
  const ranks = opts.ranks || expectedRanksOf(L);
  const sh = shopOf(ranks);
  const f = sh.f, d = sh.d;
  const passiveFamily = PASSIVE_FAMILY.has(bot);
  const cVar = opts.cVar ?? (passiveFamily ? 0 : 0.08);
  const cRatio = opts.cRatio ?? C_RATIO[bot];
  const C0 = opts.C != null ? Math.round(opts.C) : Math.round(cRatio * (cVar > 0 ? 1 + cVar * (2 * mulberry32(seed * 31 + 7)() - 1) : 1) * E);
  let C = C0;
  const ratio = C0 / E;
  const live = opts.live || HORDE_GEN.live;
  const countEase = !!opts.countEase;
  const relief = opts.relief || { hp: live.exp, win: 0 }, ease = opts.ease || { hp: 1, win: 0 };
  const below = Math.max(live.floor, ratio);          // the below-E_hold factor's base (A9)
  const countMult = holdLiveScale(ratio, live) * (ratio < 1 && countEase ? holdLiveHp(ratio, live) : 1);
  const hpBelow = ratio < 1 ? (countEase ? 1 : Math.pow(below, relief.hp)) : holdLiveHp(ratio, live);   // above E_hold r^hpExpAbove
  const winBelow = ratio < 1 && !countEase ? Math.pow(below, -relief.win) : 1;
  const threat = opts.threat ?? hold.firstMeet.threat;
  const easeHp = Math.pow(threat, ease.hp), easeWin = Math.pow(threat, -ease.win);
  const firstMeet = !!opts.firstMeet;
  const nS = hold.surges.length;
  const eased = new Uint8Array(nS);   // first-meeting ease per surge (D29): surge 1 from the run's decisions, later ones in the loop
  eased[0] = firstMeet && (opts.easeAll || (opts.runDecisions || 0) >= hold.firstMeet.surge1NeedsDecisions) ? 1 : 0;
  // countEase: horde-v2's count ease of surge 1 instead of its HP (comparisons only; later surges keep the HP ease)
  const surgeMult = countEase && eased[0] ? hold.surges.map((s, i) => (i === 0 ? threat : 1)).concat(1) : null;
  const winMult = hold.surges.map((s, i) => winBelow * (i === 0 && eased[0] && !surgeMult ? easeWin : 1));
  const spawns = buildSpawns(hold, countMult, R, surgeMult, winMult);
  const hz = holdHpScale(hold.hz, sh.p, hold.pExp, hold.profileExp, hold.surplusExp);   // the live shop's HP scale
  const baseHp = HORDE_GEN.baseHp;
  const BASE = [baseHp.walker, baseHp.runner, baseHp.crawler, baseHp.brute, baseHp.spitter];
  // unit HP: the shop-scaled HP, floored at 1, × the below-E_hold scaling × the first-meeting ease of its surge (A9: both act on
  // the HP that horde-v2's count scaling took off, so a floored unit still gets them); boss minions take the floored HP only
  const hpOf = (type, s) => Math.max(1, BASE[type] * hz) * hpBelow * (eased[s] && !(s === 0 && surgeMult) ? easeHp : 1);
  const climbK = hold.climbK;
  const spitKills = hold.spitKills;
  const bossId = opts.boss || hold.boss.id;
  const arch = ARCH[bossId];
  const forced = opts.boss ? BOSSES.archetypes[bossId] || {} : null;   // a forced archetype: its factor and split as holdgen sets them
  const bossFactor = forced ? (HORDE_GEN.boss.factor[bossId] || 1) * (forced.hpMult > 0 ? forced.hpMult : 1) : hold.boss.factor;
  // bossHpRun (experiments): the plan formula's m read as the run's boss shop scale p·bd, no bdExp term (the wiper fails)
  const bossRules = opts.bossRules || HORDE_GEN.boss;
  const bossHpTotal = Math.round((opts.bossHpRun ? holdBossHp(hold.eBoss, bossFactor, ratio, sh.p * sh.bd, 1, 1, bossRules)
    : holdBossHp(hold.eBoss, bossFactor, ratio, sh.p, sh.bd, hold.boss.bdExp, bossRules)) * (opts.bossHpMult ?? 1));
  const bossSplit = arch.twins ? (forced ? forced.hpSplit : hold.boss.split) : 1;
  const bossR = arch.twins ? T.twinR : T.bossR;      // 1.5.0: the column reach, as hold.js _bossR (the Twins keep twinR after one dies)
  const enrageS = hold.boss.enrageS != null ? hold.boss.enrageS : T.enrageS;

  let surgeAt = 1;                                    // the next surge whose ease is still undecided

  // ---- SoA units
  const X = new Float32Array(CAPU), Z = new Float32Array(CAPU), VX = new Float32Array(CAPU), VZ = new Float32Array(CAPU), HP = new Float32Array(CAPU);
  const AW = new Float32Array(CAPU), TX = new Float32Array(CAPU), TM = new Float32Array(CAPU), PX = new Float32Array(CAPU), PZ = new Float32Array(CAPU);
  const TY = new Uint8Array(CAPU), ST = new Uint8Array(CAPU);   // ST: 1 walking, 2 at the wall, 3 climbing, 4 breaching, 5 spitter holding, 6 brute at the line
  const CELL = new Int32Array(CAPU);
  const liveIds = new Int32Array(CAPU); let nLive = 0;
  const free = new Int32Array(CAPU); let nFree = 0; for (let i = CAPU - 1; i >= 0; i--) free[nFree++] = i;
  const cvz = new Float32Array(NCELL), feed = new Float32Array(NCELL);
  const cc = new Int32Array(NCELL), cs = new Int32Array(NCELL + 1), cf = new Int32Array(NCELL), cl = new Int32Array(CAPU);
  const sep = opts.sep ?? true;

  const segHp = new Float32Array(4).fill(T.segHp), segRepLeft = new Float32Array(4), segCool = new Float32Array(4), climbT = new Float32Array(4);
  const breachTok = new Float32Array(4), breachT = new Float32Array(4);
  const clawN = new Int32Array(4), pileN = new Int32Array(4), pilePrev = new Int32Array(4);
  const k0 = opts.kitsExtra || 0;
  const kitsCap = T.kitsCap + k0 * HORDE_GEN.assist.capPerStep;
  let kits = Math.min(kitsCap, T.kitsStart + (opts.runKits ?? (passiveFamily ? 1 : 2)) + k0 * HORDE_GEN.assist.kitsPerStep);
  let weapons = opts.stored ?? (bot === 'human' || bot === 'strong' ? 1 : 0), weaponLeft = 0;
  let overrunT = 0, everBreached = false;
  const log = { bites: 0, climbBites: 0, spit: 0, brute: 0, bossKills: 0, chew: 0, breaches: 0, repairs: 0, rebuilds: 0, kitsUsed: 0, supplyGot: 0,
    airstrikes: 0, weaponsFired: 0, kills: 0, climbs: 0, poolWait: 0, maxAlive: 0, laneKills: 0, laneBullets: 0, feedWait: 0 };
  let aimX = 0, aimTarget = 0, decideT = 0;
  const isAim = bot === 'aimer' || bot === 'aimerR';
  const react = bot === 'strong' ? 0.3 : isAim ? 1.2 : 0.8;
  const supply = hold.supply.map((s, i) => ({ t: s.t, x: opts.supplyX ? -3 + 6 * R() : s.x, seen: 0, live: false, got: false, idx: i, landedIn: -1 }));
  const crateMoved = !!opts.crateMoved;

  // ---- hold actions (D30): a 3 s ring of per-tick lane-target travel, the last repair / supply times, one action per window
  const ringN = Math.round(T.actionWindowS / DT);
  const ring = new Float32Array(ringN); let ringI = 0, ringSum = 0, lastTarget = 0;
  let lastRepairT = -1e9, lastSupplyT = -1e9;
  let holdActions = 0, holdSurgeWindows = 0, windupWindows = 0;
  // a window's action and its source (the first that applies): 1 lane travel, 2 a repair, 3 an opened crate; 0 none
  const windowSource = (t) => (ringSum >= T.actionLaneM - 1e-6 ? 1 : (t - lastRepairT <= T.actionWindowS ? 2 : (t - lastSupplyT <= T.actionWindowS ? 3 : 0)));
  const actBy = new Int32Array(4), surgeWinBy = new Int32Array(4), easedBy = new Uint8Array(nS);
  const surgeWinCounted = new Uint8Array(nS);
  // scripted drags of the swipe bots: [start s, travel m] out to the right and back to the lane centre
  const drags = bot === 'swipeOnce' ? [[0, 6.8]] : (bot === 'swipePerSurge' ? hold.surges.map((s) => [s.t - 2, 2.5]) : []);

  // ---- boss
  const bossT = hold.boss.at;
  const bosses = [];
  let bossSpawned = false, bossDead = false, bossInRangeAt = -1, bossDeadAt = -1, bossArriveAt = -1, enraged = false;
  const bstat = { windups: 0, staggers: 0, attacks: 0, shieldUpS: 0, minionSpawned: 0 };
  // metrics: the on-screen count within 40 m per surge peak (D44 proxy; living units only)
  const surgeWin = hold.surges.map((s, i) => [s.t + 5, (i + 1 < nS ? hold.surges[i + 1].t + 5 : s.t + 25)]);
  const surgePeak = new Int32Array(nS), surgePeakFr = new Int32Array(nS);
  let peak40 = 0, peak40fr = 0, tEnd = 0, reason = '';
  let si = 0, t = 0;

  function spawn(type, x, z, tx, hp) {
    if (nFree === 0) return -1;
    const id = free[--nFree];
    X[id] = x; Z[id] = z; VX[id] = 0; VZ[id] = T.speed[type]; HP[id] = hp; TY[id] = type; ST[id] = 1; TX[id] = tx;
    TM[id] = type === S_ ? 0.6 + 0.8 * R() : 0; AW[id] = 0; PX[id] = 0; PZ[id] = 0; CELL[id] = -1;
    liveIds[nLive++] = id;
    return id;
  }
  function kill(k) { const id = liveIds[k]; liveIds[k] = liveIds[--nLive]; free[nFree++] = id; }
  const shooterX = new Float32Array(40), focus = new Float32Array(40); let nSh = 0;
  function formShooters() {                          // the 40 front logical slots of the wall formation
    nSh = Math.min(40, C);
    const row0 = Math.min(21, nSh);
    let k = 0;
    const off = Math.floor((21 - row0) / 2);
    for (let i = 0; i < row0; i++) shooterX[k++] = -3.4 + 0.34 * (i + off);
    for (let i = 0; k < nSh; i++) shooterX[k++] = -3.4 + 0.34 * (i + 1);
  }
  const colDps = new Float64Array(8), colLaneDps = new Float64Array(8), colBank = new Float64Array(8), colCredit = new Float64Array(8);
  const spitCol = new Int32Array(8);
  const thr = new Float64Array(4);

  function newBoss() {
    const n = arch.twins ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const max = bossHpTotal * bossSplit;
      bosses.push({ x: arch.twins ? (k ? 2.2 : -2.2) : (opts.bossX ?? 0), z: -62 - (k ? 1.5 : 0), holdZ: T.bossHoldZ - (k ? 1.5 : 0), hp: max, max, phase: 0,
        cool: 2.0 + (arch.twins ? k * 2.5 : 0), wind: -1, windDmg: 0, attack: '', target: 0, stag: 0, cyc: 0, dmgMult: 1, dead: false,
        shield: { up: false, hits: 0, need: arch.shieldHits || 0, upAt: 0, pool: 0, tick: 0 }, chewAcc: 0, chewStart: -1 });
    }
    bossSpawned = true;
  }
  function bossDamage(b, amount, hits) {
    if (b.dead) return;
    if (b.shield.up) {                               // the gauge counts boss-share rounds, at most 40 per second
      const room = 40 * DT - b.shield.tick; const h = Math.min(hits, room);
      if (h > 0) { b.shield.tick += h; b.shield.hits += h; }
      if (b.shield.hits >= b.shield.need && t - b.shield.upAt >= b.shield.need / 40 - 1e-6) b.shield.up = false;
      return;
    }
    const dmg = amount * b.dmgMult;
    if (b.wind >= 0) b.windDmg += dmg;
    b.hp -= dmg;
    if (b.hp <= 0) { b.hp = 0; b.dead = true; return; }
    const fr = b.hp / b.max;
    const want = fr <= 0.25 ? 2 : (fr <= 0.6 ? 1 : 0);
    while (b.phase < want) {
      b.phase++;
      const counts = Object.assign({}, MINIONS[bossId][b.phase] || {});
      if (debut) delete counts[B_];                  // the debut hold has no boss-phase brutes (fodder kept)
      if (b.phase === 2 && !bosses.some((q) => q !== b && q.phase >= 2)) counts[W_] = (counts[W_] || 0) + 10;   // lastHorde, once per pair
      for (const k in counts) {
        const type = +k;
        for (let m = 0; m < counts[k] * (type === B_ ? T.bruteMinionScale : T.minionScale); m++) {
          if (spawn(type, b.x + (R() * 2 - 1) * 2.5, b.z - 6 - R() * 3, -3.5 + 7 * R(), Math.max(1, BASE[type] * hz)) >= 0) bstat.minionSpawned++;
        }
      }
      if (b.phase === 1 && b.shield.need > 0) { b.shield.up = true; b.shield.hits = 0; b.shield.upAt = t; b.shield.pool = 0.15 * b.max; }
      if (b.phase === 2 && arch.plates) b.dmgMult = 1.5;
    }
  }
  function repair(s) { kits--; log.kitsUsed++; log.repairs++; segRepLeft[s] += T.repairWp; segCool[s] = T.repairCool; lastRepairT = t; }
  function rebuild(s) { kits--; log.kitsUsed++; log.rebuilds++; segHp[s] = 0.01; segRepLeft[s] += T.rebuildWp; segCool[s] = T.repairCool; lastRepairT = t; }
  function gapBlocked(s) {
    for (let k = 0; k < nLive; k++) { const id = liveIds[k]; if (segOf(X[id]) === s && Z[id] > T.gapZ && Math.abs(X[id]) < 4) return true; }
    return false;
  }

  while (t < 420) {
    // ---- first-meeting decision for the next surge, made when it spawns (a counted hold action in the window before it)
    while (surgeAt < nS && t >= hold.surges[surgeAt].t) {
      const src = windowSource(t);
      if (firstMeet && hold.firstMeet.laterNeedsAction && (src || opts.easeAll)) {
        eased[surgeAt] = 1; easedBy[surgeAt] = src;
        if (easeWin !== 1) {                         // the spacing ease: this surge's units (none spawned yet) over a longer window
          for (let k = si; k < spawns.length; k++) { const sp = spawns[k]; if (sp.s === surgeAt && !sp.tr) sp.t = sp.p0 + (sp.t - sp.p0) * easeWin; }
          const rest = spawns.slice(si).sort((a, b) => a.t - b.t);
          for (let k = 0; k < rest.length; k++) spawns[si + k] = rest[k];
        }
      }
      surgeAt++;
    }
    // ---- hold-action windows at surge spawns (D30): at most one action per window
    for (let i = 0; i < nS; i++) {
      if (!surgeWinCounted[i] && t >= hold.surges[i].t) {
        surgeWinCounted[i] = 1;
        const src = windowSource(t);
        if (src) { holdActions++; holdSurgeWindows++; actBy[src]++; surgeWinBy[src]++; }
      }
    }
    // ---- spawns (the pool cap waits; nothing is dropped)
    let waited = false;
    feed.set(cc);
    while (si < spawns.length && spawns[si].t <= t) {
      if (nLive >= T.pool) { waited = true; break; }
      const sp = spawns[si];
      let placed = false;
      for (let tries = 0; tries < 6 && !placed; tries++) {
        const z = T.feedZ0 + (T.feedZ1 - T.feedZ0) * R(), x = Math.max(-10.7, Math.min(10.7, sp.x + (tries ? (R() * 2 - 1) * 3 : 0)));
        const c = (((z - GZ0) | 0) * GCOLS) + ((x - GX0) | 0);
        if (feed[c] < T.feedDensity) { feed[c]++; spawn(sp.type, x, z, sp.tx, hpOf(sp.type, sp.s)); placed = true; }
      }
      if (!placed) { waited = true; log.feedWait++; break; }
      si++;
    }
    if (waited) log.poolWait += DT;
    if (!bossSpawned && t >= bossT) newBoss();
    if (nLive > log.maxAlive) log.maxAlive = nLive;
    formShooters();
    const D = C * f * d * FIRE.accuracy;
    const rate = Math.min(T.rateCap, C * f);
    // ---- grid (counting sort)
    cc.fill(0); cvz.fill(0);
    for (let k = 0; k < nLive; k++) {
      const id = liveIds[k];
      let gx = ((X[id] - GX0)) | 0; if (gx < 0) gx = 0; else if (gx >= GCOLS) gx = GCOLS - 1;
      let gz = ((Z[id] - GZ0)) | 0; if (gz < 0) gz = 0; else if (gz >= GROWS) gz = GROWS - 1;
      const c = gz * GCOLS + gx; CELL[id] = c; cc[c]++; cvz[c] += VZ[id];
      if (sep) { PX[id] = 0; PZ[id] = 0; }
    }
    { let acc = 0; for (let c = 0; c < NCELL; c++) { cs[c] = acc; cf[c] = acc; acc += cc[c]; } cs[NCELL] = acc; }
    for (let k = 0; k < nLive; k++) { const id = liveIds[k]; cl[cf[CELL[id]]++] = id; }
    // ---- separation (the production half-shell: this cell, the right neighbour, the row behind)
    if (sep) {
      const SM = T.sepMax, D2 = (2 * T.r) * (2 * T.r);
      for (let gz = SEP_ROW_MIN; gz < GROWS; gz++) {
        const rowNext = gz + 1 < GROWS;
        for (let gx = 0; gx < GCOLS; gx++) {
          const c = gz * GCOLS + gx; const a0 = cs[c]; let a1 = cs[c + 1]; if (a1 - a0 > SM) a1 = a0 + SM; if (a0 === a1) continue;
          let r0 = 0, r1 = 0, n0 = 0, n1 = 0;
          if (gx + 1 < GCOLS) { r0 = cs[c + 1]; r1 = cs[c + 2]; if (r1 - r0 > SM) r1 = r0 + SM; }
          if (rowNext) { const lo = gx > 0 ? c + GCOLS - 1 : c + GCOLS, hi = gx + 1 < GCOLS ? c + GCOLS + 1 : c + GCOLS; n0 = cs[lo]; n1 = cs[hi + 1]; if (n1 - n0 > 3 * SM) n1 = n0 + 3 * SM; }
          for (let a = a0; a < a1; a++) {
            const i = cl[a]; const xi = X[i], zi = Z[i]; let pxi = 0, pzi = 0;
            for (let pass = 0; pass < 3; pass++) {
              let b = pass === 0 ? a + 1 : (pass === 1 ? r0 : n0); const e = pass === 0 ? a1 : (pass === 1 ? r1 : n1);
              for (; b < e; b++) {
                const j = cl[b]; const dx = X[j] - xi, dz = Z[j] - zi; const d2 = dx * dx + dz * dz;
                if (d2 >= D2 || d2 < 1e-8) continue;
                const dd = Math.sqrt(d2); const push = (2 * T.r - dd) / dd * 0.5; const ox = dx * push, oz = dz * push;
                pxi -= ox; pzi -= oz; PX[j] += ox; PZ[j] += oz;
              }
            }
            PX[i] += pxi; PZ[i] += pzi;
          }
        }
      }
    }
    // ---- fire: shooter DPS per 1 m wall column, priority shares, nearest first with pierce
    colDps.fill(0); colLaneDps.fill(0);
    let nIn = 0; for (let k = 0; k < nSh; k++) if (Math.abs(shooterX[k] - aimX) <= T.laneHalf) nIn++;
    const mIn = nIn > 0 ? T.laneShare / nIn : 0, mOut = nSh - nIn > 0 ? (1 - T.laneShare) / (nSh - nIn) : 0;
    const extra = weaponLeft > 0 ? T.weaponMult * D : 0;   // a stored weapon: +100 % of squad DPS into the lane
    spitCol.fill(-1);                                // the nearest holding spitter per column
    for (let k = 0; k < nLive; k++) {
      const id = liveIds[k];
      if (ST[id] === 5 && Z[id] >= T.rangeZ && Math.abs(X[id]) < 4) { const c = Math.max(0, Math.min(7, Math.floor(X[id] + 4))); if (spitCol[c] < 0 || Z[id] > Z[spitCol[c]]) spitCol[c] = id; }
    }
    for (let k = 0; k < nSh; k++) {
      const sx = shooterX[k];
      const inLane = Math.abs(sx - aimX) <= T.laneHalf;
      focus[k] = inLane ? Math.min(1, focus[k] + DT / T.focusT) : 0;
      const fk = inLane ? holdFocusRate(focus[k], T.focusFrom) : 1;
      let dps = D * (inLane ? mIn * fk : mOut) + (inLane && nIn > 0 ? extra / nIn : 0);
      const c = Math.max(0, Math.min(7, Math.floor(sx + 4)));
      let took = false;
      for (const b of bosses) {                      // the boss share over the crowd (the nearer twin takes it)
        if (b.dead || b.z < T.rangeZ || Math.abs(sx - b.x) > bossR) continue;
        const beta = inLane ? (b.wind >= 0 ? T.betaWind : T.beta) : T.betaOut;
        const share = dps * beta;
        bossDamage(b, share * DT * sh.bd, share * DT / (d * FIRE.accuracy));
        dps -= share; took = true; break;
      }
      if (!took && inLane && spitCol[c] >= 0) { const id = spitCol[c]; const share = dps * T.spitBeta; HP[id] -= share * DT; dps -= share; }
      colDps[c] += dps; if (inLane) colLaneDps[c] += dps;
    }
    for (let c = 0; c < 8; c++) {                    // the crowd: each column front to back
      if (colDps[c] <= 0) continue;
      colBank[c] += colDps[c] * DT;
      const bullets = (colDps[c] / Math.max(D + extra, 1e-6)) * (rate + (extra > 0 ? rate * T.weaponMult : 0)) * DT;
      colCredit[c] = Math.min(colCredit[c] + T.pierce * bullets, T.pierce * (bullets + 1));
      log.laneBullets += bullets * colLaneDps[c] / colDps[c];
      const gx = c + 8; let any = false;
      for (let gz = GROWS - 1; gz >= ROW_RANGE && colBank[c] > 0 && colCredit[c] >= 1; gz--) {
        const cell = gz * GCOLS + gx;
        for (let a = cs[cell]; a < cs[cell + 1]; a++) {
          const id = cl[a]; if (HP[id] <= 0) continue;
          if (TY[id] === C_ && Z[id] < T.crawlerHitZ && ST[id] === 1) continue;   // under the bullet line
          any = true;
          const k = Math.min(colBank[c], HP[id]); HP[id] -= k; colBank[c] -= k; colCredit[c] -= 1;
          if (HP[id] <= 0 && colLaneDps[c] > 0) log.laneKills += colLaneDps[c] / colDps[c];
          if (colBank[c] <= 0 || colCredit[c] < 1) break;
        }
      }
      if (!any) colBank[c] = 0;                      // nothing in the column: the rounds fly on
      if (colBank[c] > colDps[c] * 0.2) colBank[c] = colDps[c] * 0.2;
    }
    weaponLeft -= DT;
    // ---- deaths
    for (let k = nLive - 1; k >= 0; k--) { const id = liveIds[k]; if (HP[id] <= 0) { kill(k); log.kills++; } }
    // ---- movement, the wall, bites
    clawN.fill(0); pilePrev.set(pileN); pileN.fill(0);
    const kAcc = 1 - Math.exp(-T.accel * DT);
    let n40 = 0, n40fr = 0;
    for (let k = nLive - 1; k >= 0; k--) {
      const id = liveIds[k]; const ty = TY[id]; const x = X[id]; let z = Z[id]; const st = ST[id];
      if (st === 3) {                                // climbing over: lunges at the line
        z += T.climbSpeed * DT;
        if (z >= T.frontZ - T.r) { C = Math.max(0, C - 1); log.climbBites++; kill(k); continue; }
        Z[id] = z; if (z >= MZ) { n40++; if (Math.abs(x) <= frustumHalf(z)) n40fr++; } continue;
      }
      if (st === 6) {                                // a brute at the line swings every 1 s
        TM[id] -= DT; if (TM[id] <= 0) { TM[id] = 1; const kk = Math.max(1, Math.min(3, Math.round(0.06 * C))); C = Math.max(0, C - kk); log.brute += kk; }
        n40++; n40fr++; continue;
      }
      if (st === 5) {                                // a spitter holding: lobs
        TM[id] -= DT; if (TM[id] <= 0) { TM[id] = T.spitEvery; C = Math.max(0, C - spitKills); log.spit += spitKills; }
        n40++; if (Math.abs(x) <= frustumHalf(z)) n40fr++; continue;
      }
      const c = CELL[id]; const gx = c % GCOLS;
      let tx = TX[id];
      if (ty === R_ && z < T.runnerRetargetZ) {     // runners re-target the weakest section until 20 m out
        let wk = 0; for (let s = 1; s < 4; s++) if (segHp[s] < segHp[wk]) wk = s;
        if (segHp[wk] < T.segHp * 0.66) tx = TX[id] = segCx(wk) + (TX[id] - segCx(segOf(TX[id])));
      }
      let dvx = (tx - x) * (z < T.funnelZ ? 0.06 : (z < T.throatZ ? 0.45 : T.steerK)); if (dvx > T.steerMax) dvx = T.steerMax; else if (dvx < -T.steerMax) dvx = -T.steerMax;
      const dself = cc[c]; const dl = gx > 0 ? cc[c - 1] : 99, dr = gx + 1 < GCOLS ? cc[c + 1] : 99;
      if (dl < dself) dvx -= (dself - dl) * T.diffuse; if (dr < dself) dvx += (dself - dr) * T.diffuse;
      let dvz = T.speed[ty];
      if (ty === C_ && z > T.wallZ - T.crawlLunge - 0.5 && z < T.wallZ) dvz = T.crawlLungeSpeed;
      if (c + GCOLS < NCELL) { const ca = c + GCOLS, ahead = cc[ca]; if (ahead > T.densCap) { if (ahead > 2 * T.densCap) dvz = 0; else { const fl = cvz[ca] / ahead + 0.3; if (fl < dvz) dvz = fl > 0 ? fl : 0; } } }
      const vx = VX[id] + (dvx - VX[id]) * kAcc, vz = VZ[id] + (dvz - VZ[id]) * kAcc;
      let nx = x + vx * DT + (sep ? PX[id] * T.sepK : 0), nz = z + vz * DT + (sep ? PZ[id] * T.sepK : 0);
      if (st === 4 || nz > T.wallZ) { const lim = T.wallHalf - T.r; if (nx > lim) nx = lim; else if (nx < -lim) nx = -lim; }
      else { const lim = halfAt(nz) - T.r; if (nx > lim) nx = lim; else if (nx < -lim) nx = -lim; }
      VX[id] = vx; VZ[id] = vz;
      if (ty === S_ && nz >= T.spitHoldZ + (id % 5) * 0.8 - 1.6) {   // spitters hold at z −18 ± 1.6, only inside the fire columns
        nz = Math.min(nz, T.spitHoldZ + (id % 5) * 0.8 - 1.6); VZ[id] = 0;
        if (Math.abs(nx) <= T.spitColX) { ST[id] = 5; VX[id] = 0; } else nx += Math.sign(-nx) * 1.2 * DT;
      }
      const s = segOf(nx);
      if (st !== 4) {
        if (nz > T.wallZ - T.r) {
          if (segHp[s] > 0) {
            nz = T.wallZ - T.r; VZ[id] = 0;
            if (clawN[s] < T.slots) {
              clawN[s]++; AW[id] += DT;
              if (AW[id] >= (ty === B_ ? T.bruteClawDelay : T.clawDelay)) segHp[s] = Math.max(0, segHp[s] - T.claw[ty] * DT);
              ST[id] = 2;
              if (segHp[s] <= 0) { log.breaches++; everBreached = true; }
              else if (climbT[s] <= 0 && pilePrev[s] - clawN[s] > T.pile && ty !== B_ && ty !== S_) {
                climbT[s] = climbK * Math.max(T.climbMin, T.climbEvery * T.pile / (pilePrev[s] - T.slots)); ST[id] = 3; nz = T.wallZ + 0.4; log.climbs++;
              }
            }
          } else { nz = T.wallZ - T.r; VZ[id] = 0; if (breachTok[s] >= 1) { breachTok[s] -= 1; ST[id] = 4; nz = T.wallZ + 0.05; } }
        }
        if (nz >= T.wallZ - T.pileZone && nz <= T.wallZ) pileN[s]++;
      } else if (nz >= T.frontZ - T.r - (ty === B_ ? 0.4 : 0)) {
        if (ty === B_) { nz = T.frontZ - T.r - 0.4; ST[id] = 6; TM[id] = 0.6; }
        else { C = Math.max(0, C - 1); log.bites++; kill(k); continue; }
      }
      X[id] = nx; Z[id] = nz;
      if (nz >= MZ) { n40++; if (Math.abs(nx) <= frustumHalf(nz)) n40fr++; }
    }
    // pile counts are from the previous pass (one tick lag, like the production rules hook)
    // ---- wall bookkeeping: repairs, breach tokens, overrun
    let down = 0;
    for (let s = 0; s < 4; s++) {
      climbT[s] -= DT; segCool[s] = Math.max(0, segCool[s] - DT);
      if (segHp[s] <= 0) { breachT[s] += DT; breachTok[s] = Math.min(2, breachTok[s] + Math.min(T.breachMax, T.breachRate + T.breachWiden * breachT[s]) * DT); } else { breachTok[s] = 0; breachT[s] = 0; }
      if (segHp[s] <= 0) segRepLeft[s] = 0;              // a repair dies with its section (hold.js _rEnd)
      if (segRepLeft[s] > 0) { const kk = Math.min(segRepLeft[s], T.repairWp / T.repairTime * DT); segHp[s] = Math.min(T.segHp, segHp[s] + kk); segRepLeft[s] -= kk; }
      if (segHp[s] <= 0) down++;
    }
    if (down === 4) { overrunT += DT; if (overrunT >= T.overrunS) { reason = 'overrun'; tEnd = t; break; } } else overrunT = 0;
    // ---- boss
    if (bossSpawned && !bossDead) {
      let allDead = true;
      for (const b of bosses) {
        if (b.dead) continue; allDead = false;
        if (bossInRangeAt < 0 && b.z >= T.rangeZ) bossInRangeAt = t;
        b.shield.tick = 0;
        if (b.shield.up) { bstat.shieldUpS += DT; if (b.shield.pool > 0) { const g = Math.min(b.shield.pool, 0.02 * b.max * DT); b.hp = Math.min(b.max, b.hp + g); b.shield.pool -= g; } }
        if (enraged) {                               // HOLD ENRAGE: charge, break the section, then chew
          if (b.z < T.wallZ - 0.6) b.z += T.enrageWalk * DT;
          else {
            const s = segOf(b.x);
            if (segHp[s] > 0) { segHp[s] = Math.max(0, segHp[s] - T.enrageBreak * DT); if (segHp[s] <= 0) { log.breaches++; everBreached = true; } }
            else {
              if (b.chewStart < 0) b.chewStart = t;
              b.chewAcc += DT * Math.max(T.chewMin, Math.round(T.chewPerE * E)) * (1 + Math.floor(t - b.chewStart));
              if (b.chewAcc >= 1) { const kk = Math.floor(b.chewAcc); b.chewAcc -= kk; C = Math.max(0, C - kk); log.chew += kk; }
            }
          }
          continue;
        }
        if (b.z < b.holdZ) { b.z += T.bossWalk * DT; continue; }
        if (bossArriveAt < 0) bossArriveAt = t;
        if (b.stag > 0) { b.stag -= DT; continue; }
        if (b.wind < 0) {
          b.cool -= DT;
          if (b.cool <= 0 && hold.boss.attacks) {
            b.attack = arch.attacks[b.cyc++ % arch.attacks.length];
            b.wind = WINDUP[b.attack]; b.windDmg = 0; bstat.windups++;
            const src = windowSource(t);                 // a wind-up start opens a hold-action window (D30)
            if (src) { holdActions++; windupWindows++; actBy[src]++; }
            let wk = 0; for (let s = 1; s < 4; s++) if (segHp[s] < segHp[wk]) wk = s;
            b.target = b.attack === 'acid' ? segOf(b.x + (R() * 2 - 1) * 3) : wk;
          }
        } else {
          b.wind -= DT;
          const need = (bossId === 'juggernaut' ? T.staggerJug : T.stagger) * b.max;
          if (b.windDmg >= need) { b.wind = -1; b.stag = T.staggerS; b.cool = arch.interval[b.phase]; bstat.staggers++; }
          else if (b.wind < 0) {
            bstat.attacks++; b.cool = arch.interval[b.phase];
            const s = b.target;
            if (b.attack === 'slam') {
              if (segHp[s] > 45) segHp[s] -= 45;
              else { if (segHp[s] > 0) { log.breaches++; everBreached = true; } segHp[s] = 0; const kk = Math.max(3, Math.round(0.05 * C)); C = Math.max(0, C - kk); log.bossKills += kk; }
            } else if (b.attack === 'acid') { segHp[s] = Math.max(0, segHp[s] - 45); const kk = 3 * spitKills; C = Math.max(0, C - kk); log.bossKills += kk; }
            else if (b.attack === 'charge') {
              const s2 = s < 3 ? s + 1 : s - 1;
              for (const q of [s, s2]) { if (segHp[q] > 0 && segHp[q] <= 60) { log.breaches++; everBreached = true; } segHp[q] = Math.max(0, segHp[q] - 60); }
            }
          }
        }
      }
      if (bossArriveAt >= 0 && !enraged && t - bossArriveAt >= enrageS) enraged = true;
      if (allDead || bosses.every((b) => b.dead)) { bossDead = true; bossDeadAt = t; }
    }
    // ---- supply drops (the lane on the crate for 1 s): a kit, or from L32 the airstrike when ≥ 3 kits are held
    for (const sp of supply) {
      sp.live = !sp.got && t >= sp.t && t < sp.t + T.supplyLife;
      if (sp.live && sp.landedIn < 0) sp.landedIn = Math.abs(sp.x - aimX) <= T.laneHalf ? 1 : 0;
      if (sp.live && Math.abs(sp.x - aimX) <= T.laneHalf) {
        sp.seen += DT;
        if (sp.seen >= T.supplyNeed) {
          sp.got = true; log.supplyGot++;
          if (!crateMoved || !sp.landedIn) lastSupplyT = t;   // an opened crate is a hold action (D30), also one in a parked lane
          if (sp.idx === 1 && hold.airstrike && kits >= HORDE_GEN.supply.airstrikeKits) {
            log.airstrikes++;
            let dmg = T.airstrikeDpsS * D;
            for (let k = 0; k < nLive && dmg > 0; k++) { const id = liveIds[k]; if (Math.abs(X[id] - aimX) < 3 && Z[id] > -40 && Z[id] < -6) { const h = Math.min(dmg, HP[id]); HP[id] -= h; dmg -= h; } }
          } else kits = Math.min(kitsCap, kits + 1);
        }
      }
    }
    // ---- bot
    decideT -= DT;
    if (bot === 'passive' || bot === 'steerRunIdleHold') aimTarget = 0;
    else if (bot === 'swipeOnce' || bot === 'swipePerSurge') {
      aimTarget = 0;                                 // a scripted drag out to the right and back, then the lane rests at centre
      for (const [d0, m] of drags) { const u = (t - d0) * T.aimSpeed; if (u >= 0 && u < m) aimTarget = u < m / 2 ? Math.min(T.aimRange, u) : Math.max(0, m - u); }
    } else if (bot === 'oscillator') aimTarget = 3.0 * Math.sin(2 * Math.PI * t / 6);
    else if (decideT <= 0) {
      decideT = react;
      thr.fill(0); let near = 0;
      for (let k = 0; k < nLive; k++) {
        const id = liveIds[k]; const z = Z[id]; const x = X[id];
        const s = (z > T.throatZ || Math.abs(x) < 4) ? segOf(x) : segOf(TX[id]);
        const wz = z > -8 ? 1.5 : (z > -16 ? 1 : (z > -30 ? 0.5 : 0.15));
        const tw = TY[id] === B_ ? 2 : (ST[id] === 5 ? 4 : 1);
        thr[s] += HP[id] * wz * tw; if (z > -16) near += HP[id];
      }
      for (let s = 0; s < 4; s++) thr[s] *= 1 + 2 * (1 - segHp[s] / T.segHp) + (segHp[s] <= 0 ? 2 : 0);
      const order = [0, 1, 2, 3].sort((a, b) => thr[b] - thr[a]);
      let best = order[0]; if (bot === 'human' && R() < 0.25) best = order[1];
      aimTarget = segCx(best);
      const calm = near < 2.5 * D;
      const lb = bosses.find((b) => !b.dead && b.z >= T.rangeZ && !b.shield.up) || bosses.find((b) => !b.dead && b.z >= T.rangeZ);
      if (lb) {
        const winding = bosses.find((b) => !b.dead && b.wind >= 0 && b.z >= T.rangeZ);
        let crit = -1; for (let s = 0; s < 4; s++) if (segHp[s] < 35 && thr[s] > 0.5 * D && (crit < 0 || segHp[s] < segHp[crit])) crit = s;
        const urg = enraged ? 1 : (bossArriveAt >= 0 ? Math.min(1, (t - bossArriveAt) / enrageS) : 0);
        if (winding && (bot === 'strong' || (bot === 'human' && R() < 0.6))) aimTarget = winding.x;
        else if (crit >= 0 && !enraged) aimTarget = segCx(crit);
        else if (R() < (isAim ? 0.15 + 0.85 * urg : 0.35 + 0.65 * urg) || calm) aimTarget = lb.x;
      }
      for (const sp of supply) if (sp.live && calm && bot !== 'aimer') aimTarget = sp.x;   // the decent bot also opens crates when calm
      if (bot === 'aimerR') {                        // the REPAIR button only: the weakest section when breached or under 25 %
        let wk = 0; for (let s = 1; s < 4; s++) if (segHp[s] < segHp[wk]) wk = s;
        if (kits > 0 && segCool[wk] <= 0 && segHp[wk] > 0 && segHp[wk] + segRepLeft[wk] < 0.25 * T.segHp) repair(wk);
        else if (kits > 0 && segCool[wk] <= 0 && segHp[wk] <= 0 && !gapBlocked(wk)) rebuild(wk);
      }
      if (!isAim) {                                  // human / strong: taps on any section under 40 % (50 %), weapons at big threats
        for (let s = 0; s < 4; s++) {
          if (kits <= 0 || segCool[s] > 0) continue;
          const lim = bot === 'strong' ? 0.5 : 0.4;
          if (segHp[s] > 0 && segHp[s] + segRepLeft[s] < lim * T.segHp) repair(s);
          else if (segHp[s] <= 0) { if (!gapBlocked(s)) rebuild(s); else aimTarget = segCx(s); }
        }
        if (weapons > 0 && weaponLeft <= 0 && Math.max(thr[0], thr[1], thr[2], thr[3]) > 1.6 * D) { weapons--; weaponLeft = T.weaponDur; log.weaponsFired++; }
      }
      aimTarget = Math.max(-T.aimRange, Math.min(T.aimRange, aimTarget));
    }
    // the lane target's travel ring (D30), then the lane follows the target at ≤ 14 m/s
    { const step = Math.abs(aimTarget - lastTarget); lastTarget = aimTarget; ringSum += step - ring[ringI]; ring[ringI] = step; ringI = (ringI + 1) % ringN; if (ringSum < 0) ringSum = 0; }
    { const dx = aimTarget - aimX, st = T.aimSpeed * DT; aimX += Math.abs(dx) <= st ? dx : Math.sign(dx) * st; }
    // ---- metrics
    if (opts.trace && Math.abs(t - Math.round(t)) < DT / 2) {
      opts.trace.push({ t: Math.round(t), alive: nLive, q: spawns.length - si, n40, n40fr, C, seg: Array.from(segHp).map(Math.round), aim: +aimX.toFixed(1),
        kills: log.kills, clb: log.climbBites, bites: log.bites, boss: bosses.map((b) => Math.round(b.hp) + '@' + b.z.toFixed(0)).join(' ') });
    }
    if (n40 > peak40) peak40 = n40; if (n40fr > peak40fr) peak40fr = n40fr;
    for (let i = 0; i < nS; i++) if (t >= surgeWin[i][0] && t < surgeWin[i][1]) { if (n40 > surgePeak[i]) surgePeak[i] = n40; if (n40fr > surgePeakFr[i]) surgePeakFr[i] = n40fr; }
    t += DT;
    if (C <= 0) { reason = 'squadLost'; tEnd = t; break; }
    if (bossDead) { tEnd = t; break; }
  }
  if (!tEnd) { tEnd = t; reason = reason || 'timeout'; }
  const won = C > 0 && bossDead;
  const E2 = Math.ceil(0.5 * E - 1e-9), E3 = Math.ceil(0.9 * E - 1e-9);
  const stars = !won ? 0 : (C >= E3 ? 3 : C >= E2 ? 2 : 1);
  const runS = opts.runS ?? runSeconds(L);
  return {
    L, bot, seed, won, stars, reason, E, C0, C, ratio: +ratio.toFixed(3), lossFrac: +((C0 - C) / E).toFixed(3), hold: +tEnd.toFixed(1),
    levelS: Math.round(runS + 6 + tEnd + 4), runS: Math.round(runS),
    N: spawns.length, variant: hold.variant, hpW: +(Math.max(1, BASE[W_] * hz) * hpBelow).toFixed(2), hz: +hz.toFixed(4), hpBelow: +hpBelow.toFixed(3), countMult: +countMult.toFixed(3), D: Math.round(C0 * f * d * FIRE.accuracy),
    surgePeak: Array.from(surgePeak), surgePeakFr: Array.from(surgePeakFr), peak40, peak40fr, ...log,
    boss: bossId, bossHp: bossHpTotal,
    bossTtk: bossDeadAt > 0 && bossInRangeAt > 0 ? +(bossDeadAt - bossInRangeAt).toFixed(1) : -1,
    bossAtHold: bossDeadAt > 0 && bossArriveAt > 0 ? +(bossDeadAt - bossArriveAt).toFixed(1) : (bossDeadAt > 0 ? 0 : -1),
    enraged, ...bstat, pierce: log.laneBullets > 0 ? +(log.laneKills / log.laneBullets).toFixed(2) : 0, everBreached, kitsLeft: kits,
    holdActions, holdSurgeWindows, windupWindows, eased: Array.from(eased, (v) => !!v),
    easedBy: Array.from(easedBy, (v) => SOURCES[v]), actionsBy: { lane: actBy[1], repair: actBy[2], crate: actBy[3] },
    assistEligible: holdActions >= 3 && holdSurgeWindows >= 2,
    eligibleWithoutCrates: holdActions - actBy[3] >= 3 && holdSurgeWindows - surgeWinBy[3] >= 2,
  };
}

/** The run phase's seconds at level L when no script is at hand: 140 + 100·(gates − 1) m at the curve's road speed. */
function runSeconds(L) {
  const gates = HORDE_GEN.run.gates.reduce((g, row) => (row[0] <= L ? row[1] : g), HORDE_GEN.run.gates[0][1]);
  const v = (levelgen.curve && levelgen.curve(L).v) || 10;
  return (140 + 100 * (gates - 1)) / v;
}

// ---------------------------------------------------------------------------------------------
// The run phase's fixed lines (levelgen's F12 model at the expected shop and rank 10, with the D26 wave compensation)
// ---------------------------------------------------------------------------------------------

/**
 * Fixed-position line arrivals of a generated run phase (never steers, held left, held right, full intake), as fractions of
 * ref (E_hold): { exp: { max, C, L, R }, r10: {…} } — r10 with the waves answering the shop surplus (util.shopComp, D26),
 * as levelgen's fixedCheck judges it. Also { design } = the generator's greedy line at the stop / ref.
 */
export function runPhaseLines(L, script, ref) {
  const lg = levelgen;
  const c = lg.curve(L);
  const pe = lg.profileExpOf(L);
  const rkExp = expectedRanksOf(L);
  const pExp = lg.shopOf(rkExp).p;
  const E0 = script.expected[0].e;
  const out = { design: +(script.expected[script.expected.length - 1].e / ref).toFixed(3) };
  for (const [tag, rk] of [['exp', rkExp], ['r10', [10, 10, 10, 10, 10]]]) {
    const sp = lg.shopOf(rk);
    const pf = { v: script.roadSpeed, bandMid: c.bandMid, E0: Math.max(E0, sp.s0), len: script.length, waveModel: true, calibL: lg.levelCalib(L), fire: sp.fire,
      dpsMult: sp.p / shopComp(sp.p, pExp, pe, LEAK_MODEL.surplusExp) };   // the run's surplus exponent, as levelgen's fixedCheck
    const fl = lg.fixedLines(script.events, script.roadSpeed, pf);
    out[tag] = { max: +(fl.max / ref).toFixed(3), C: +(fl.C / ref).toFixed(3), L: +(fl.L / ref).toFixed(3), R: +(fl.R / ref).toFixed(3) };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Section validation (D37)
// ---------------------------------------------------------------------------------------------

/** The run phase of a Horde script as levelgen generated it (validateLevel): its events, the run's boss back at the stop. */
export function runPartOf(script) {
  const ev = script.events.find((e) => e.type === 'hold');
  const c = levelgen.runCurve(ev.spec.L, script.run);
  const events = script.events.filter((e) => e !== ev);
  events.push({ at: ev.at, type: 'boss', id: 'boss.' + c.bossId, archetype: c.bossId, hp: c.bossHp });   // the generator's own shape
  return Object.assign({}, script, { events });
}

/**
 * D37 rules for a Horde script (a levelgen run phase + holdgen.generateHoldScript). opts: runs (aimerR and human seeds each,
 * default 3: a count, so the report never depends on machine speed), runErrors (the run phase's levelgen.validateLevel errors
 * when the caller has them; otherwise its run part is validated here). Returns { L, seed, eHold, N, rho, hp, peakAlive, lines,
 * runErrors, passive, aimerR, human, errors[], warnings[], ms }.
 * ERROR: expected-shop line > 0.90·E_hold; passive (threat 1.0, the script's seed) clears at max(0.7, that line); the run
 * phase invalid (any validator error, among them its E-trace outside the generator's ±traceTolerance band); the rank-10 line
 * > 1.25·E_hold; peak alive > 2,048 + 256; the spec's debut flag ≠ (L === HORDE_GEN.debut.level) — the generator's default,
 * which must agree with LEVEL_TYPES.horde.debut (P1T). WARNING: expected-shop line > 0.82, rank-10 line > 0.95, aimerR or human
 * fails.
 */
export function validateHoldSection(script, opts = {}) {
  const t0 = Date.now();
  if (!script || !script.events) throw new Error('validateHoldSection: a Horde script (run phase + hold event) is required');
  const hold = holdOf(script);
  const L = hold.L, E = hold.eHold;
  const runs = opts.runs ?? 3;
  const errors = [], warnings = [];
  const runErrors = opts.runErrors || levelgen.validateLevel(runPartOf(script)).errors;
  for (const e of runErrors) errors.push('run phase invalid: ' + e);
  if (!!hold.debut !== (L === HORDE_GEN.debut.level)) errors.push(`debut ${!!hold.debut} on L${L}: HORDE_GEN.debut.level ${HORDE_GEN.debut.level} and LEVEL_TYPES.horde.debut disagree`);
  const lines = runPhaseLines(L, script, E);
  if (lines.exp.max > 0.90) errors.push(`expected-shop fixed line ${lines.exp.max}·E_hold > 0.90`);
  else if (lines.exp.max > 0.82) warnings.push(`expected-shop fixed line ${lines.exp.max}·E_hold > 0.82`);
  if (lines.r10.max > 1.25) errors.push(`rank-10 fixed line ${lines.r10.max}·E_hold > 1.25`);
  else if (lines.r10.max > 0.95) warnings.push(`rank-10 fixed line ${lines.r10.max}·E_hold > 0.95`);
  let peakAlive = 0;
  const passive = simulateHold(hold, 'passive', hold.seed, { cRatio: Math.max(0.7, lines.exp.max) });
  peakAlive = passive.maxAlive;
  if (passive.won) errors.push(`passive clears at ${Math.max(0.7, lines.exp.max)}·E_hold (${passive.C} left)`);
  const res = { aimerR: [], human: [] };
  for (const bot of ['aimerR', 'human']) {
    for (let k = 0; k < runs; k++) {
      const r = simulateHold(hold, bot, hold.seed + 97 * k);
      res[bot].push(r);
      if (r.maxAlive > peakAlive) peakAlive = r.maxAlive;
      if (!r.won) warnings.push(`${bot} fails (seed ${hold.seed + 97 * k}: ${r.reason} at ${r.hold} s)`);
    }
  }
  if (peakAlive > RULES.pool + RULES.reserve) errors.push(`peak alive ${peakAlive} > ${RULES.pool + RULES.reserve}`);
  const bh = HORDE_GEN.baseHp;
  const fodder = hold.trickle + hold.surges.reduce((a, s) => a + s.n, 0);
  const hpSum = fodder * (hold.mix[0] * bh.walker + hold.mix[1] * bh.runner + hold.mix[2] * bh.crawler) + hold.brutes * bh.brute + hold.spitters * bh.spitter;
  const sum = (rs) => ({ clears: rs.filter((r) => r.won).length, runs: rs.length, stars: rs.length ? +(rs.reduce((a, r) => a + r.stars, 0) / rs.length).toFixed(2) : 0 });
  return {
    L, seed: hold.seed, eHold: E, N: fodder + hold.brutes + hold.spitters,
    rho: +(hold.hz * hpSum / (hold.design * hold.spawnEnd)).toFixed(4),   // the HP arrival / design DPS over the spawn time
    hp: { walker: +(bh.walker * hold.hz).toFixed(2), runner: +(bh.runner * hold.hz).toFixed(2), crawler: +(bh.crawler * hold.hz).toFixed(2), brute: +(bh.brute * hold.hz).toFixed(1), spitter: +(bh.spitter * hold.hz).toFixed(1) },
    peakAlive, lines, runErrors, passive: { won: passive.won, C: passive.C, ratio: passive.ratio, hold: passive.hold, reason: passive.reason },
    aimerR: sum(res.aimerR), human: sum(res.human), errors, warnings, ms: Date.now() - t0,
  };
}

export { TYPES };
