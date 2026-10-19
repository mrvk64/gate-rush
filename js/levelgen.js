// js/levelgen.js — GATE RUSH level generator + validator (ARCHITECTURE §6.17, GDD §4.2–4.4, §6.2–6.3, §10, §10.1).
//
// Pure module: no THREE, no DOM, node-importable (tools/validate-levels.js). Imports only ./util.js
// and ./data.js. Every tuning number comes from data.js (round 5: the former DATA-MISSING generator knobs included; the
// literals below the imports are mixed-build fallbacks only).
//
// Exports (contract §6.17): curve, generateLevel, generateChunk, validateLevel, solveWaveHp, gateDefaults,
// expectedHits. Extra exports for the level runner (documented in the PR report): endlessGateGuard / eventWorstCase
// (endless gate rules, need the live count), endlessParams (per-chunk speed / E / counts), endlessPressure /
// endlessDesignMult (round-3 QA LVL-17), laneOutcome
// (the single gate-outcome model shared by generator, validator and anyone who needs "what would this
// lane give at N hits"), endlessHpCap (round 5d: the per-zombie HP ceiling), endlessPoolReserve / endlessPoolPeaks (round 5d:
// the pool slots endless waves leave to the mini-boss's minions, and the validator's pool model over a chunk — docs/build/r5d-endless.md).
//
// Design model shared by generator and validator (QA LVL-1 resolution, superseding the cautious-line sizing below for
// GENERATED levels): generated scripts declare script.line = 'greedy' — the DESIGN line picks the lane that reads best at
// spawn and lands DESIGN_HITS·H on it; every gate is sized and every wave's HP solved on that line, x / ÷ step costs come
// from the armed window's achievable intake (gateDefaults), and two shadow lines steer the per-gate choice: the
// FULL-INTAKE line (best lane, min(40, C·f)·t_w + the intake bucket; validator limit 1.6·E_boss fresh / 2.2·E_boss rank 3)
// and the weak-shooter line (0.3·H, survivability report). Waves use per-type kill windows, the shield of the gate in
// front of them and a coverage factor (QA LVL-4). The authored L1 keeps the cautious line described next.
// Design model shared by generator and validator:
//   • the CAUTIOUS line (written to script.expected, GDD §11 "cautious line"): at every gate event the player
//     takes the best '+' lane (deterministic gain, guards on that lane bite first) and lands cautiousHits·H(z)
//     weighted hits on it (H = expectedHits, GDD §4.2); when an event offers no '+' lane they take the lane
//     with the best outcome at those hits ("lesser evil": a ÷2 shot up to x1, the trap's xM lane);
//   • the GREEDY line (GDD §4.4 Σ EV rule): the best lane with hitsAssumed·H (0.6·H) hits; it must end
//     ≥ evFraction·E_boss;
//   • every wave bites leak·Σ bite soldiers, leak from the leak model with the wave's HP (generated HP is
//     solved at the level's LEAK_BANDS midpoint, so leak = band mid);
//   • the generator sizes each gate against the running cautious E and an adaptive per-gate target gain
//     g = ((E_boss + expected later bites) / E)^(1 / gates left), choosing the pattern from the GDD bag and
//     the pattern's uniform draw inside its GDD range (re-rolling the pattern when its range cannot reach g),
//     so the cautious line lands on E_boss (±traceTolerance) with the bag's variety intact.
//   The declared line (script.expected) and the validator's independent re-simulation of the events must both
//   end within ±traceTolerance of E_boss (errors); sample-by-sample disagreement between the two is a warning
//   (LEVEL_1's GDD-transcribed line is hand-made; a generated script declares exactly its re-simulation).
//   Campaign E_start (curve().eStart) is where the cautious line starts; s0Assumed is reported for reference.
//
// Allocation note: everything here runs at level start / chunk append, not per frame. The functions the
// level runner may call from step() (solveWaveHp, expectedHits, gateDefaults, laneOutcome)
// allocate at most one small object per call (solveWaveHp accepts an `out` object to allocate nothing).

import { Rng, clamp, roundDesign } from './util.js';
import {
  WORLD, GATE_RULES, ZOMBIES, LEAK_MODEL, WAVE_WEIGHTS, WAVE_PATTERNS, WAVE_RULES, LEAK_BANDS,
  BOSSES, PICKUP_SCHEDULE, PICKUPS, LEVELS, HINTS, UPGRADES, FIRE,
} from './data.js';

// ---------------------------------------------------------------------------------------------
// Generator knobs (round 5: every former DATA-MISSING literal now lives in data.js). Each read falls back to the round-4
// value only so a mixed build (a new levelgen.js served next to an older data.js during a service-worker update,
// r4-release §4) keeps generating; the numbers below are those fallbacks, not tuning.
// ---------------------------------------------------------------------------------------------

/** Finite number `v`, else the round-4 fallback `d`. */
function num(v, d) { return Number.isFinite(v) ? v : d; }

const GEN_DATA = GATE_RULES.generation;
const CURVE_DATA = LEVELS.curve;
const GENERATOR_DATA = CURVE_DATA.generator || {};
// LEVELS.curve.traceTolerance — the cautious E-trace must end within ±this of E_boss (ARCH §6.17 "E-trace ±15 %").
const TRACE_TOLERANCE = num(CURVE_DATA.traceTolerance, 0.15);
// GATE_RULES.generation.cautiousHits — weighted hits (fraction of H) the cautious / weak line lands on its lane.
const CAUTIOUS_HITS = num(GEN_DATA.cautiousHits, 0.3);
// GATE_RULES.generation.designHits — weighted hits (fraction of H) the DESIGN line lands on the lane it picks by face value
// (QA LVL-1: later gates are sized and wave HP solved on this greedy line).
const DESIGN_HITS = num(GEN_DATA.designHits, 0.75);
// GATE_RULES.generation.lineGuards — what the generator steers the two shadow lines toward while it sizes the design line
// (full-intake line at most maxTarget·E_boss, weak line at least cautiousTarget·E_boss) and the weight of each excess (ln units).
const LG = GEN_DATA.lineGuards || {};
const LINE_GUARDS = {
  maxTarget: num(LG.maxTarget, 1.3), maxWeight: num(LG.maxWeight, 5),
  cautiousTarget: num(LG.cautiousTarget, 0.3), cautiousWeight: num(LG.cautiousWeight, 0.3),
};
// GATE_RULES.generation.patterns[itemPlus].aScale — the item | +A gate's A = E·aOfE·U(aScale) (tuned draw).
let ITEM_A_SCALE = [0.5, 1.3];
for (let i = 0; i < GEN_DATA.patterns.length; i++) {
  const p = GEN_DATA.patterns[i];
  if (p.id === 'itemPlus' && Array.isArray(p.aScale)) ITEM_A_SCALE = p.aScale;
}
// GATE_RULES.generation.faceItem — how the design / weak lines value a special lane when they pick by face value: E·mult + add.
const FI = GEN_DATA.faceItem || {};
const FACE_ITEM = { mult: num(FI.mult, 1.15), add: num(FI.add, 2) };
// WAVE_RULES.introHpFrac — a solo introduction's HP is at most this fraction of what the squad's whole fire clears in its window.
const INTRO_HP_FRAC = num(WAVE_RULES.introHpFrac, 0.8);
// LEVELS.curve.cautiousFloor — the weak / cautious line must reach the boss with at least this fraction of E_boss (warning).
const CAUTIOUS_FLOOR = num(CURVE_DATA.cautiousFloor, 0.2);
// LEVELS.curve.weakLineFail — QA LVL-27: below this fraction of E_boss the weak line is an error (the "0 %" case).
const WEAK_LINE_FAIL = num(CURVE_DATA.weakLineFail, 0.02);
// LEVELS.curve.generator.* — bounded re-roll attempts (weakAttempts: the budget while the best attempt still has its weak line
// under CAUTIOUS_FLOOR), pattern re-rolls per gate before the variant sweep, the accepted gain band [target / lo, target · hi]
// by gates left (5 or more, 3–4, 2, 1), the survival floor (E + surviveMult·b) / E, grid steps of a pattern's tuned draw.
const GEN_ATTEMPTS = num(GENERATOR_DATA.attempts, 24);
const GEN_ATTEMPTS_WEAK = Math.max(GEN_ATTEMPTS, num(GENERATOR_DATA.weakAttempts, GEN_ATTEMPTS));
const SPEC_TRIES = num(GENERATOR_DATA.specTries, 8);
const GB = GENERATOR_DATA.gainBand || {};
function gainTol(b, lo, hi) { return { lo: Math.log(num(b && b[0], lo)), hi: Math.log(num(b && b[1], hi)) }; }
const GAIN_TOL = {
  early: gainTol(GB.early, 1.2, 1.45),
  mid: gainTol(GB.mid, 1.15, 1.25),
  near: gainTol(GB.near, 1.1, 1.1),
  last: gainTol(GB.last, 1.05, 1.05),
};
const SURVIVE_MULT = num(GENERATOR_DATA.surviveMult, 2);
const U_STEPS = num(GENERATOR_DATA.uSteps, 20);
// WAVE_PATTERNS[*].weight — pick weights for generated wave patterns (WAVE_PATTERNS key order is the pick order).
const PATTERN_WEIGHTS = {};
for (const id in WAVE_PATTERNS) PATTERN_WEIGHTS[id] = num(WAVE_PATTERNS[id].weight, 0);
// GATE_RULES.generation.guards — guard squads in front of the richer lane (rule in data.js).
const GUARDS = GEN_DATA.guards || { popFraction: 1 / 3, min: 2, max: 6, costShare: 0.5, plusMultChance: 0.4, plusMultFromBand: 1 };
// LEVELS.curve.coinLineEveryGates — one coin line per this many gate events (GDD §9.1 "Coin line … on one half").
const COIN_LINE_EVERY_GATES = num(CURVE_DATA.coinLineEveryGates, 2);
// QA LVL-12 (data since QA LVL-35): the intro spawn is searched within ±introSearchM of its target (introAheadM before the
// mixed wave); failing that the mixed wave's contact moves later in steps of introShiftStepM (at most introShiftMaxM,
// never into the next gate's armed window).
const INTRO_SEARCH_M = LEVELS.curve.introSearchM;
const INTRO_SHIFT_STEP_M = LEVELS.curve.introShiftStepM;
const INTRO_SHIFT_MAX_M = LEVELS.curve.introShiftMaxM;
// LEVELS.curve.crateHintAfterM — QA LVL-24: the crate hint row trails the crate's spawn by this much (the L1 row: crate at 90, hint at 120).
const CRATE_HINT_AFTER_M = num(CURVE_DATA.crateHintAfterM, 30);
// LEVELS.curve.pickupClearM — crates keep this distance (arrival) from gate arrivals and wave contacts.
const PICKUP_CLEAR_M = num(CURVE_DATA.pickupClearM, 15);
// LEVELS.endless.crates / coinLines — specials and coin lines per endless chunk.
const ENDLESS_CRATES_PER_CHUNK = num(LEVELS.endless.crates, 1);
const ENDLESS_COIN_LINES_PER_CHUNK = num(LEVELS.endless.coinLines, 1);
// LEVELS.endless.wavePoolShare — QA LVL-17 / round 5d: an endless wave carries at most 1 / this of every type's pool (four waves share the road).
const WAVE_POOL_SHARE = Math.max(1, num(LEVELS.endless.wavePoolShare, 4));
// LEVELS.endless.waves.maxPerChunk / minSpacingM — round 5d (pool-safe ramp, docs/build/r5d-endless.md): once a wave of the chunk's
// population would overflow its per-type pool shares, the population the chunk owes (pop × its wave count) spreads over more, smaller
// waves — at most maxPerChunk per chunk, never closer than minSpacingM between contacts (absent keys: the counts stay, the excess is dropped).
const ENDLESS_WAVES_MAX = Math.max(0, num(LEVELS.endless.waves.maxPerChunk, 0) | 0);
const ENDLESS_WAVE_SPACING_M = Math.max(0, num(LEVELS.endless.waves.minSpacingM, 0));
// WAVE_RULES.burstEvery — runner packs (L11+) land on every 3rd wave (index % 3 == 1), crawler swarms (L16+) on index % 3 == 2.
const BURST_WAVE_PERIOD = num(WAVE_RULES.burstEvery, 3);

// QA LVL-1 (data since QA LVL-35): the full-intake greedy line (every lane shot at min(40, C·f)·t_w, best lane) must reach
// the boss with at most maxRatio·E_boss soldiers (L2–L30), for a fresh profile (shop rank 0) and a rank-3 profile.
const GREEDY_PROFILES = GATE_RULES.generation.greedyProfiles;

/** Start squad / fire rate / damage of a shop rank (UPGRADES effects, GDD §9.2). */
function profileAt(rank) {
  return { s0: UPGRADES.squad.effect(rank), fire: UPGRADES.fireRate.effect(rank), dmg: UPGRADES.damage.effect(rank) };
}

// Internal RNG stream separation (not tuning): the generator forks the run seed so its draw sequence never
// aliases ctx.rng (= new Rng(seed)) or ctx.rngFx (= seed + 7) — see util.Rng.fork.
const FORK_ATTEMPT_BASE = 101;
const FORK_ATTEMPT_STEP = 1013;
const FORK_CHUNK_BASE = 5003;
const FORK_CHUNK_STEP = 7919;
const FORK_OPENER = 30011;                                    // QA LVL-30: the opener's own stream
// GATE_RULES.generation.secondSlotMaxErr — QA LVL-30: the second gate keeps its best bag roll unless its selection error
// (ln units, shadow-line excess included) exceeds this; then the variant sweep decides.
const SECOND_SLOT_MAX_ERR = num(GEN_DATA.secondSlotMaxErr, 0.15);
// GATE_RULES.generation.noSteerPenalty — round-3 QA LVL-22: attempt-score cost of a no-steer line above noSteerMax (ln units).
const NO_STEER_PENALTY = num(GEN_DATA.noSteerPenalty, 2);

// ---------------------------------------------------------------------------------------------
// Shared constants and small helpers
// ---------------------------------------------------------------------------------------------

const TYPES = ZOMBIES.common.types;              // ['walker', 'runner', 'crawler', 'brute', 'spitter'] (= WAVE_WEIGHTS.w order)
const SPAWN_DIST = -WORLD.spawnZ;                // 70 m from the horizon to the squad front
/** Round 5d: the most zombies one endless wave may carry — Σ floor(pool / wavePoolShare) over the types (65 at the GDD §6.2 pools). */
const WAVE_POOL_CAPACITY = (() => { let n = 0; for (let i = 0; i < TYPES.length; i++) n += Math.floor(ZOMBIES[TYPES[i]].pool / WAVE_POOL_SHARE); return n; })();
const GEN = GATE_RULES.generation;
const PATTERNS = GEN.patterns;
const RED_OPS = { '-': true, '/': true };
const LANE_COUNT = { single: 1, pair: 2, triple: 3 };

function patternById(id) {
  for (let i = 0; i < PATTERNS.length; i++) if (PATTERNS[i].id === id) return PATTERNS[i];
  return null;
}
const P_PLUSPLUS = patternById('plusPlus');
const P_PLUSMULT = patternById('plusMult');
const P_MINUSDIV = patternById('minusDiv');
const P_MULTMINUS = patternById('multMinus');
const P_PLUSMINUS = patternById('plusMinus');
const P_ITEMPLUS = patternById('itemPlus');

/** Nearest multiple of BOSSES.hpRound (50). */
function roundBossHp(v) { return Math.round(v / BOSSES.hpRound) * BOSSES.hpRound; }

/** Nearest multiple of LEVELS.curve.eBoss.round (5). */
function roundE(v) { return Math.round(v / LEVELS.curve.eBoss.round) * LEVELS.curve.eBoss.round; }

/** Uniform value inside a [lo, hi] range at unit position u ∈ [0, 1]. */
function lerpRange(range, u) { return range[0] + (range[1] - range[0]) * u; }

/** GDD §4.4 value sanity: design rounding (1 / 5 / 10) then clamp to [minValue, maxValue]. */
function designValue(x) {
  return clamp(roundDesign(x), GEN.minValue, GEN.maxValue);
}

/** Leak band [lo, hi] for a level (LEAK_BANDS). */
function bandFor(L) {
  for (let i = 0; i < LEAK_BANDS.length; i++) {
    const b = LEAK_BANDS[i];
    if (L >= b.L[0] && L <= b.L[1]) return b.band;
  }
  return LEAK_BANDS[LEAK_BANDS.length - 1].band;
}

/** Index into GATE_RULES.generation.bands / pattern.w for a level. */
function bandIndexFor(L) {
  for (let i = 0; i < GEN.bands.length; i++) {
    if (L >= GEN.bands[i][0] && L <= GEN.bands[i][1]) return i;
  }
  return GEN.bands.length - 1;
}

/** The level's newest zombie type (highest unlock ≤ L). */
function newestType(L) {
  let best = TYPES[0];
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    if (ZOMBIES[t].unlock <= L && ZOMBIES[t].unlock >= ZOMBIES[best].unlock) best = t;
  }
  return best;
}

/** Resolves a boss archetype through its `base` chain (twins, hpSplit, shieldHits, hpMult merged). */
function resolveArchetype(id) {
  const own = BOSSES.archetypes[id];
  if (!own) return null;
  if (!own.base) return own;
  const base = resolveArchetype(own.base);
  const out = {};
  for (const k in base) out[k] = base[k];
  for (const k in own) if (k !== 'base') out[k] = own[k];
  return out;
}

/** Per-type sum of every `spawn` action in an archetype's phases plus the phase-1 walker burst (ARCH D8). */
function unionMinionUnits(archetypeId) {
  const arch = resolveArchetype(archetypeId);
  const units = { walker: BOSSES.minionBurst.count };
  if (!arch || !arch.phases) return units;
  for (let p = 0; p < arch.phases.length; p++) {
    const actions = arch.phases[p].onEnter;
    if (!actions) continue;
    for (let a = 0; a < actions.length; a++) {
      const sp = actions[a].spawn;
      if (!sp) continue;
      for (const t in sp) units[t] = (units[t] || 0) + sp[t];
    }
  }
  return units;
}

/**
 * r5c (GDD §10.1): the minion roster the endless mini-boss minions are solved over — the per-type maximum of every endless
 * rotation archetype's union (bursts, runners, brutes, crawlers) when LEVELS.endless.miniMinions.sharedSolve, else the
 * archetype's own union (as a campaign boss). Shared, a Juggernaut's walker-only bursts soak like a Hulk's (its own 6-walker
 * union put the whole solve into six walkers: 575 HP each at chunk 10, against 94 shared). Fresh object (chunk generation).
 */
function endlessMinionUnits(archetypeId) {
  const mm = LEVELS.endless.miniMinions;
  if (!mm || !mm.sharedSolve) return unionMinionUnits(archetypeId);
  const rot = BOSSES.endlessRotation;
  const units = {};
  for (let i = 0; i < rot.length; i++) {
    const u = unionMinionUnits(rot[i]);
    for (const t in u) if (!(units[t] >= u[t])) units[t] = u[t];
  }
  return units;
}

/**
 * Round 5d (GDD §10.1, docs/build/r5d-endless.md): the pool slots per type an endless wave or gate guard leaves free for the
 * mini-boss's own minions — LEVELS.endless.poolReserve (the rotation's minion union: BOSSES.minionBurst walkers, the Hulk's runners
 * and brutes, the Queen's crawlers); without the key, that union itself (the per-type maximum over BOSSES.endlessRotation). Every
 * type key is written into `out` (a fresh record without it); never a whole pool. The generator's pool fit (fitEndlessPools) and
 * the level runner's spawn clamp (level._clampEndlessUnits) both budget pool − reserve.
 */
export function endlessPoolReserve(out) {
  const res = out || {};
  const r = LEVELS.endless.poolReserve;
  let union = null;
  if (!r) {
    union = {};
    const rot = BOSSES.endlessRotation;
    for (let i = 0; i < rot.length; i++) {
      const u = unionMinionUnits(rot[i]);
      for (const t in u) if (!(union[t] >= u[t])) union[t] = u[t];
    }
  }
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    const v = r ? r[t] : union[t];
    res[t] = Math.max(0, Math.min(ZOMBIES[t].pool - 1, Number.isFinite(v) ? Math.floor(v) : 0));
  }
  return res;
}
const POOL_RESERVE = endlessPoolReserve({});

/** Population-weighted own speed of a unit record (m/s) and its count. */
function unitStats(units, out) {
  let n = 0, sumSpeed = 0, sumBite = 0, sumBase = 0;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    const c = units[t] | 0;
    if (c <= 0) continue;
    const z = ZOMBIES[t];
    n += c; sumSpeed += c * z.speed; sumBite += c * z.bite; sumBase += c * z.baseHp;
  }
  out.n = n;
  out.sBar = n > 0 ? sumSpeed / n : 0;
  out.bites = sumBite;
  out.sumBase = sumBase;
  return out;
}
const _stats = { n: 0, sBar: 0, bites: 0, sumBase: 0 };

/** Weighted pick of an index (weights ≤ 0 are skipped); −1 when every weight is 0. */
function weightedIndex(rng, weights) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) if (weights[i] > 0) total += weights[i];
  if (total <= 0) return -1;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    r -= weights[i];
    if (r < 0) return i;
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

/** Interpolates WAVE_WEIGHTS at level L into normalised shares, gated by each type's unlock level. */
function waveSharesAt(L) {
  const rows = WAVE_WEIGHTS;
  let a = rows[0], b = rows[0], t = 0;
  if (L >= rows[rows.length - 1].L) { a = b = rows[rows.length - 1]; }
  else {
    for (let i = 0; i < rows.length - 1; i++) {
      if (L >= rows[i].L && L < rows[i + 1].L) {
        a = rows[i]; b = rows[i + 1];
        t = (L - a.L) / (b.L - a.L);
        break;
      }
    }
  }
  const shares = new Array(TYPES.length);
  let sum = 0;
  for (let i = 0; i < TYPES.length; i++) {
    const w = a.w[i] + (b.w[i] - a.w[i]) * t;
    const ok = ZOMBIES[TYPES[i]].unlock <= L;
    shares[i] = ok ? Math.max(0, w) : 0;
    sum += shares[i];
  }
  if (sum <= 0) { shares[0] = 1; sum = 1; }
  for (let i = 0; i < TYPES.length; i++) shares[i] /= sum;
  return shares;
}

// ---------------------------------------------------------------------------------------------
// curve(L) — GDD §10 formulas
// ---------------------------------------------------------------------------------------------

/**
 * Difficulty curve for campaign level L (L > LEVELS.curve.loopAfter uses L = loopAfter).
 * @returns {{ L, len, v, gates, waves, pop, eStart, s0Assumed, eBoss, bossHp, bossId, milestone, band, bandMid, runup, newest, bandIdx }}
 */
export function curve(L) {
  const c = LEVELS.curve;
  const Lc = clamp(Math.floor(Number.isFinite(L) ? L : 1), 1, c.loopAfter);
  const len = Math.min(c.len.cap, c.len.base + c.len.per * (Lc - 1));
  const v = Math.min(WORLD.speed.cap, WORLD.speed.base + WORLD.speed.perLevel * (Lc - 1));
  const gates = Math.round(len / c.gatesPer);
  const waves = Lc >= c.wavesEqualGatesFrom ? gates : gates - 1;
  const pop = Math.min(c.pop.cap, c.pop.base + Lc);
  const eStart = Math.min(c.eStart.cap, c.eStart.base + c.eStart.per4 * Math.floor((Lc - 1) / 4));
  const s0Assumed = c.s0Assumed(Lc);
  const eBoss = Math.min(c.eBoss.cap, roundE(c.eBoss.base * Math.pow(c.eBoss.growth, Lc - 1)));
  const bossId = BOSSES.rotation[Math.min(Lc, BOSSES.rotation.length) - 1];
  const arch = resolveArchetype(bossId);
  const milestone = BOSSES.milestones.indexOf(Lc) !== -1;
  // D9: the milestone ×1.25 and an archetype hpMult (Colossus Prime) never stack
  const mult = Math.max(milestone ? BOSSES.milestoneMult : 1, (arch && arch.hpMult) ? arch.hpMult : 1);
  const bossHp = roundBossHp(BOSSES.hpPerE * eBoss * mult);
  const band = bandFor(Lc);
  return {
    L: Lc, len, v, gates, waves, pop, eStart, s0Assumed, eBoss, bossHp, bossId, milestone,
    band, bandMid: (band[0] + band[1]) / 2,
    runup: Math.min(c.runup.cap, c.runup.base + Lc),   // run-up horde size (GDD §6.2: 15 + L, cap 30)
    newest: newestType(Lc),
    bandIdx: bandIndexFor(Lc),
  };
}

// ---------------------------------------------------------------------------------------------
// expectedHits / gateDefaults / solveWaveHp — GDD §4.2 and §6.3
// ---------------------------------------------------------------------------------------------

/**
 * H(z): expected weighted hits an on-curve squad of E lands on one gate during the armed window
 * (GDD §4.2): min(shootersCap, E·fireRate·fraction) · windowM / v. Unrounded.
 */
export function expectedHits(E, v) {
  const h = GATE_RULES.hits;
  const perSec = Math.min(h.shootersCap, Math.max(0, E) * LEAK_MODEL.fireRate * h.fraction);
  return perSec * (h.windowM / Math.max(0.01, v));
}

/** Armed-window time t_w = hits.windowM / v (s). */
function windowTime(v) { return GATE_RULES.hits.windowM / Math.max(0.01, v); }

/**
 * Full-accuracy window intake (QA LVL-1): the weighted hits a squad of C aligned with its lane lands on one gate
 * during the armed window, min(intakePerSec, C·f·accuracy)·t_w. `f` defaults to hits.fireRef (base fire rate).
 */
export function windowIntake(C, v, f) {
  const h = GATE_RULES.hits;
  const fire = Number.isFinite(f) && f > 0 ? f : h.fireRef;
  return Math.min(GATE_RULES.intakePerSec, Math.max(0, C) * fire * h.accuracy) * windowTime(v);
}

/**
 * The most weighted hits one gate can take in its armed window: the intake cap for t_w plus the full token bucket it
 * starts with (GATE_RULES.intakeWindowS of intake, gates.js) — "a full window at the 40/s cap".
 */
export function windowCapacity(v) {
  const burst = Number.isFinite(GATE_RULES.intakeWindowS) ? GATE_RULES.intakeWindowS : 0;
  return GATE_RULES.intakePerSec * (windowTime(v) + burst);
}

/** Σ_{j<n} (M0 + j) / M0: cumulative step-cost units from xM0 to x(M0 + n) (gates.js scales each step with the current M). */
function multStepUnits(M0, n) {
  let s = 0;
  for (let j = 0; j < n; j++) s += (M0 + j) / M0;
  return s;
}

/**
 * x-lane step cost K (hits for the first step; gates.js scales later steps by M / M0): clamp(intake·I(E),
 * capBlock·Icap / S(cap − M0), capReach·Icap / S(cap − M0 − 1)) — x(M0+1) is reachable by an on-curve squad, the
 * step below the cap needs ≈ capReach of a full window at the intake cap, the cap itself is out of reach in one window.
 */
function multStep(M0, E, v) {
  const r = GATE_RULES.mult;
  const sf = r.stepFraction;
  const icap = windowCapacity(v);
  const nTop = r.cap - M0;
  if (nTop <= 0) return r.stepMin * M0;
  const lo = sf.capBlock * icap / multStepUnits(M0, nTop);
  const hi = nTop >= 2 ? Math.max(lo, sf.capReach * icap / multStepUnits(M0, nTop - 1)) : lo;
  // a base-M lane steps once for an on-curve squad; a stronger spawn multiplier (x3 from L6) is already the bet: x(M0+1) needs
  // the whole window at the cap
  let K = M0 > r.base ? hi : clamp(sf.intake * windowIntake(E, v), lo, hi);
  // QA LVL-27: the first step stays within reach of the whole squad's window intake
  if (r.openReach > 0) K = Math.min(K, r.openReach * windowIntake(E, v));
  return Math.max(r.stepMin * M0, Math.ceil(K));
}

/**
 * ÷-lane step cost K per rung (QA LVL-2): max(stepMin, perD[D]·I(E), flipBlock·Icap / (rungs to x1 + flipStepMult)) —
 * an on-curve squad can pump ÷D up to x1, the x1 → x2 flip needs more than one full window at the intake cap.
 */
function divStep(D, E, v) {
  const r = GATE_RULES.div;
  const sf = r.stepFraction;
  const ladder = r.ladder;
  let idx = ladder.indexOf(D);
  if (idx < 0) idx = 0;
  const rungs = Math.max(0, ladder.length - 1 - idx);
  const frac = sf.perD[D] !== undefined ? sf.perD[D] : sf.perD[ladder[ladder.length - 2]];
  const icap = windowCapacity(v);
  const block = sf.flipBlock * icap / (rungs + r.flipStepMult);
  return Math.max(r.stepMin, Math.ceil(Math.max(frac * windowIntake(E, v), block)));
}

/**
 * Caps and step costs for a lane (GDD §4.2). ALWAYS applied by the generator so every Lane leaves
 * levelgen with its caps filled (ARCH D19). `value` is the base value (+A / −A / M / D). x / ÷ step costs come
 * from the armed window's achievable intake (multStep / divStep), not from H(z).
 * @returns {{ cap:number, flipCap:number, step:number }} unused fields are 0
 */
export function gateDefaults(op, value, E, v) {
  switch (op) {
    case '+':
      return { cap: Math.max(GATE_RULES.plus.capMin, GATE_RULES.plus.capMult * value), flipCap: 0, step: 0 };
    case '-':
      return { cap: value, flipCap: value, step: 0 };          // flipCap = base (post-flip positive cap)
    case 'x':
      return { cap: GATE_RULES.mult.cap, flipCap: 0, step: multStep(value, E, v) };
    case '/':
      return { cap: GATE_RULES.div.flipTo, flipCap: 0, step: divStep(value, E, v) };
    default:
      return { cap: 0, flipCap: 0, step: 0 };                 // 'item' lanes are not shootable
  }
}

/**
 * Formation half-width (m) of a squad of n (GDD §3.1): hex slots of LEAK_MODEL.coverage.slotArea m² filling an
 * ellipse x² + (z/aspect)² ≤ a², capped at the formation's hard half-width.
 */
function formationHalfWidth(n) {
  const cv = LEAK_MODEL.coverage;
  return Math.min(cv.halfWidthCap, Math.sqrt(Math.max(1, n) * cv.slotArea / (Math.PI * cv.aspect)));
}

/** Overlap length of [a0, a1] and [b0, b1] (≥ 0). */
function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

/**
 * Fraction of the wave's zombies the squad's shooter columns cover at contact (QA LVL-4c): bullets fly straight
 * (±2°, GDD §3.3), so a walker whose x lies outside the formation (half-width for E, plus its radius and the
 * bullet / spread slack) around the lane the squad holds gets no fire — and never reaches the squad either.
 * Homing types (LEAK_MODEL.coverage.homing: runners re-target, crawlers lunge; brutes charge only inside 8 m) always count.
 * Pattern x layouts mirror zombies.spawnWave. Returns max(coverage.min, fraction).
 */
function waveCoverage(units, pattern, waveX, laneX, E) {
  const cv = LEAK_MODEL.coverage;
  const a = formationHalfWidth(E);
  const half = WAVE_PATTERNS.line.xRange;
  let n = 0, hit = 0;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    const c = units[t] | 0;
    if (c <= 0) continue;
    n += c;
    if (cv.homing.indexOf(t) !== -1) { hit += c; continue; }
    const h = a + ZOMBIES[t].radius + cv.slack;
    const lo = laneX - h, hi = laneX + h;
    const cx = Number.isFinite(waveX) ? waveX : 0;
    let f;
    switch (pattern) {
      case 'column': f = Math.abs(cx - laneX) <= h ? 1 : 0; break;
      case 'flank': {
        const fx = WAVE_PATTERNS.flank.x;
        f = ((Math.abs(fx - laneX) <= h ? 1 : 0) + (Math.abs(-fx - laneX) <= h ? 1 : 0)) / 2;
        break;
      }
      case 'pincer': {
        const ph = WAVE_PATTERNS.pincer.centreHalfWidth;
        f = overlap(lo, hi, cx - ph, cx + ph) / (2 * ph);
        break;
      }
      case 'horde': {
        const hw = WAVE_PATTERNS.horde.box[0] / 2;
        f = overlap(lo, hi, cx - hw, cx + hw) / (2 * hw);
        break;
      }
      default: {                                             // line / wall: even across ±xRange (a guard line: ±guardHalfWidth)
        const lh = Number.isFinite(waveX) ? WAVE_PATTERNS.line.guardHalfWidth : half;
        f = overlap(lo, hi, cx - lh, cx + lh) / (2 * lh);
        break;
      }
    }
    hit += c * clamp(f, 0, 1);
  }
  return n > 0 ? Math.max(cv.min, hit / n) : 1;
}

/**
 * Kill window (s) of type t (QA LVL-4a): the reach model usable·reach/(v + s_t) for every type, limited by the
 * shield window when the wave makes contact `exposureM` road metres after the gate in front of it passed the squad
 * (GDD §3.3: a panel shields what is behind it), and for crawlers by their hittable stretch (below bullet height
 * until z > hittableZ, then the lunge).
 */
function typeWindow(t, v, exposureM) {
  const z = ZOMBIES[t];
  const vv = Math.max(0.01, v);
  let win = LEAK_MODEL.usable * LEAK_MODEL.reach / (vv + z.speed);
  if (Number.isFinite(exposureM) && exposureM >= 0) win = Math.min(win, LEAK_MODEL.usable * exposureM / vv);
  if (t === 'crawler' && z.lunge) {
    const pre = Math.max(0, -z.hittableZ - z.lunge.dist);
    win = Math.min(win, pre / (vv + z.speed) + z.lunge.dist / (vv + z.lunge.speed));
  }
  const ws = LEAK_MODEL.windowScale;
  if (ws && ws[t] > 0) win *= ws[t];                         // calibration against the QA probes (LVL-4)
  return Math.max(0.05, win);
}

/**
 * Wave context for the leak model: { exposureM, coverage } — exposureM = road metres between the shielding gate's
 * pass and the contact (Infinity when no gate shields the wave), coverage = waveCoverage(). `out` is filled and returned.
 */
export function waveContext(units, pattern, waveX, laneX, E, exposureM, out) {
  const o = out || {};
  o.exposureM = Number.isFinite(exposureM) ? exposureM : Infinity;
  o.laneX = Number.isFinite(laneX) ? laneX : 0;
  o.coverage = waveCoverage(units, pattern, waveX, o.laneX, E);
  return o;
}

/**
 * Squad DPS the leak model applies to a wave of `wc` coverage (GDD §6.3 E·f·d·accuracy × coverage), × the play-measured
 * calibration LEAK_MODEL.calib (QA LVL-15: the real squad kills ~calib× what the reach / coverage model credits it with,
 * so both the HP solve and the predicted leak carry it).
 */
function waveDps(E, wc, leak) {
  const dps = Math.max(1, E) * LEAK_MODEL.fireRate * LEAK_MODEL.damage * LEAK_MODEL.accuracy * leakCalib(leak);
  // round-3 QA LVL-15: × the campaign level's capacity factor (levelCalib) the wave context carries
  return dps * (wc && Number.isFinite(wc.coverage) ? wc.coverage : 1) * (wc && wc.calib > 0 ? wc.calib : 1);
}

/**
 * Round-3 QA LVL-15 (GDD §6.3): the band calibration (leakCalib, fitted on whole levels) credits the squad with the specials
 * and troops a level hands out from LEVELS.curve.pickupRange on; the waves before that meet the bare squad. A wave at
 * `progress` (contact / length) gets the factor that takes its calibration from the base LEAK_MODEL.calib at the start to
 * the full band × level calibration at LEAK_MODEL.earlyRamp of the level (1 without the key).
 */
function earlyCalib(progress, leak) {
  const r = LEAK_MODEL.earlyRamp;
  if (!(r > 0)) return 1;
  const full = leakCalib(leak);
  const base = LEAK_MODEL.calib > 0 ? LEAK_MODEL.calib : 1;
  const start = Math.min(1, base / Math.max(1e-6, full));
  return start + (1 - start) * clamp(progress / r, 0, 1);
}

/**
 * Round-3 QA LVL-15 (GDD §6.3): the squad's kill capacity at campaign level L relative to the band calibration —
 * piecewise-linear LEAK_MODEL.calibByLevel [[L, mult], …] (1 without it). Measured on-curve leak with the ranks a player who
 * spends every coin owns fell inside one band from 9 % (L6–L9: the medic, chip, flamethrower and rocket arrive) to 25 %
 * (L4), so one band factor cannot hold every level. Campaign waves and guards only (endless has its own design multiple).
 */
export function levelCalib(L) {
  const tab = LEAK_MODEL.calibByLevel;
  if (!tab || !tab.length || !Number.isFinite(L)) return 1;
  if (L <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (L <= tab[i][0]) {
      const a = tab[i - 1], b = tab[i];
      return a[1] + (b[1] - a[1]) * (L - a[0]) / Math.max(1e-9, b[0] - a[0]);
    }
  }
  return tab[tab.length - 1][1];
}

/**
 * QA LVL-15: the play calibration for a wave solved at leak target `leak` (the level's band midpoint):
 * LEAK_MODEL.calib × the piecewise-linear LEAK_MODEL.calibByLeak [[leak, mult], …] (clamped at both ends). In play the
 * squad's kill capacity grows with the level beyond the reach model (specials, troops and the gear the campaign hands out
 * accumulate), so the later bands need a larger factor than the L1–3 one the wave lab measured.
 */
export function leakCalib(leak) {
  const base = LEAK_MODEL.calib > 0 ? LEAK_MODEL.calib : 1;
  const tab = LEAK_MODEL.calibByLeak;
  if (!tab || !tab.length || !Number.isFinite(leak)) return base;
  if (leak <= tab[0][0]) return base * tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (leak <= tab[i][0]) {
      const a = tab[i - 1], b = tab[i];
      return base * (a[1] + (b[1] - a[1]) * (leak - a[0]) / Math.max(1e-9, b[0] - a[0]));
    }
  }
  return base * tab[tab.length - 1][1];
}

/**
 * QA LVL-15: (1 − leak)^LEAK_MODEL.leakExp — the fraction of a wave's HP the squad's capacity must cover for it to leak
 * `leak`. Measured leak rises much more slowly with HP than the linear GDD form (1 − leak) predicts (the wave lab: walker
 * leak 12 % → 27 % → 35 % at 4×, 5×, 8× the old solve), so the exponent makes higher bands cost disproportionately more HP.
 */
function survivorFactor(leak) {
  const q = LEAK_MODEL.leakExp > 0 ? LEAK_MODEL.leakExp : 1;
  return Math.pow(clamp(1 - leak, 0.05, 1), q);
}

/** Inverse of survivorFactor: the leak of a wave whose HP is covered `ratio` (capacity / HP) by the squad. */
function leakOfRatio(ratio) {
  const q = LEAK_MODEL.leakExp > 0 ? LEAK_MODEL.leakExp : 1;
  return clamp(1 - Math.pow(clamp(ratio, 0, 1), 1 / q), 0, 1);
}

/**
 * Leak-model HP solve (GDD §6.3, per-type windows QA LVL-4): every type t gets the share of the squad's fire its
 * base HP claims (φ_t = n_t·baseHp_t / Σ n·baseHp) during its own kill window win_t (typeWindow), so
 * hz_t = DPS·cov·win_t / ((1 − leak)·Σ n·baseHp) and each type leaks the band midpoint. Without `wc` (live solves of
 * authored waves, boss minions) the wave is unshielded with full coverage; a wave of one speed reduces to the GDD formula.
 * @param {number} E expected squad at the wave's contact point
 * @param {number} v road speed (m/s)
 * @param {Record<string, number>} units counts per type
 * @param {number} bandMid expected leak fraction (LEAK_BANDS midpoint)
 * @param {object} [out] optional record to fill (every type key is written; absent types get 0) — allocation-free path
 * @param {{exposureM:number, coverage:number}} [wc] wave context (waveContext)
 * @returns {Record<string, number>} HP per type present (max(minHp, round(baseHp·hz_t)))
 */
export function solveWaveHp(E, v, units, bandMid, out, wc) {
  const res = out || {};
  if (out) for (let i = 0; i < TYPES.length; i++) out[TYPES[i]] = 0;
  const st = unitStats(units, _stats);
  if (st.n === 0 || st.sumBase <= 0) return res;
  const leak = clamp(bandMid, 0, 0.95);
  const dps = waveDps(E, wc, leak);
  const exposure = wc ? wc.exposureM : Infinity;
  const sumBase = st.sumBase;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    if ((units[t] | 0) <= 0) continue;
    const hz = dps * typeWindow(t, v, exposure) / (survivorFactor(leak) * sumBase);
    res[t] = Math.max(LEAK_MODEL.minHp, Math.round(ZOMBIES[t].baseHp * hz));
  }
  return res;
}

/**
 * Expected leak fraction of a wave with the given HP table against a squad of E (inverse of the solve, per type):
 * leak_t = 1 − DPS·cov·win_t·baseHp_t / (HP_t·Σ n·baseHp), clamped to [0, 1], averaged over the biting units
 * (by count when nothing bites). `hpMult` scales the table (authored waves).
 */
function expectedLeak(E, v, units, hp, hpMult, wc, bandMid) {
  const st = unitStats(units, _stats);
  if (st.n === 0 || st.sumBase <= 0) return 0;
  const sumBase = st.sumBase;
  const mult = (hpMult && hpMult > 0) ? hpMult : 1;
  const dps = waveDps(E, wc, bandMid);
  const exposure = wc ? wc.exposureM : Infinity;
  let wBite = 0, sBite = 0, wN = 0, sN = 0;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    const c = units[t] | 0;
    if (c <= 0) continue;
    const h = (hp && Number.isFinite(hp[t]) ? hp[t] : ZOMBIES[t].baseHp) * mult;
    const lt = h > 0 ? leakOfRatio(dps * typeWindow(t, v, exposure) * ZOMBIES[t].baseHp / (h * sumBase)) : 0;
    const b = c * ZOMBIES[t].bite;
    wBite += b; sBite += b * lt;
    wN += c; sN += c * lt;
  }
  return wBite > 0 ? sBite / wBite : (wN > 0 ? sN / wN : 0);
}

/** How far the expected leak can move when every zombie's (rounded) HP moves by ±0.5 (rounding granularity). */
function waveLeakSlack(E, v, units, hp, hpMult, wc, bandMid) {
  if (!hp) return 0;
  const a = expectedLeak(E, v, units, hp, hpMult, wc, bandMid);
  if (a <= 0 || a >= 1) return 0;                            // clamped: the band test is not a rounding question
  const up = {}, down = {};
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    if (!Number.isFinite(hp[t])) continue;
    up[t] = hp[t] + 0.5;
    down[t] = Math.max(0.01, hp[t] - 0.5);
  }
  return Math.max(Math.abs(expectedLeak(E, v, units, up, hpMult, wc, bandMid) - a), Math.abs(a - expectedLeak(E, v, units, down, hpMult, wc, bandMid)));
}

// ---------------------------------------------------------------------------------------------
// laneOutcome — the one gate-outcome model (GDD §4.2 per-hit rules + §4.3 pass effects)
// ---------------------------------------------------------------------------------------------

/**
 * Soldier count after passing `lane` with squad `E` once `hits` weighted hits landed on it.
 * '+': E + min(cap, value + hits). '−': value − hits toward 0, then flips to + up to flipCap; negative
 * result applies max(1, E − rest). 'x': one +1 step per `step` hits up to `cap`. '÷': the ladder
 * ÷3 → ÷2 → x1 (one `step` each) then x`cap` after div.flipStepMult·step more hits. 'item': E.
 */
export function laneOutcome(lane, E, hits) {
  const h = hits > 0 ? hits : 0;
  switch (lane.op) {
    case '+':
      return E + Math.min(lane.cap, lane.value + h);
    case '-': {
      const rest = lane.value - h;
      if (rest <= 0) return E + Math.min(lane.flipCap, -rest);
      return Math.max(1, E - rest);
    }
    case 'x': {
      // mirrors gates.js _stepNeed: the step from M to M+1 costs round(step·M / M0)
      const M0 = lane.value;
      let M = M0, left = h;
      if (lane.step > 0) {
        while (M < lane.cap) {
          const need = Math.max(1, Math.round(lane.step * M / M0));
          if (left < need) break;
          left -= need;
          M++;
        }
      }
      return E * M;
    }
    case '/': {
      const ladder = GATE_RULES.div.ladder;
      let idx = ladder.indexOf(lane.value);
      if (idx < 0) idx = 0;
      let left = h;
      const K = lane.step > 0 ? lane.step : Infinity;
      while (idx < ladder.length - 1 && left >= K) { left -= K; idx++; }
      if (idx === ladder.length - 1) {                        // x1 (grey)
        if (left >= GATE_RULES.div.flipStepMult * K) return E * lane.cap;   // flipped to x2 (cap = div.flipTo)
        return E;
      }
      return Math.ceil(E / ladder[idx]);
    }
    default:
      return E;                                               // item lane: count unchanged
  }
}

/** True for a lane that reads red at spawn (−N or ÷D). */
function isRedLane(lane) { return RED_OPS[lane.op] === true; }

/**
 * Chooses the lane the modelled player takes. mode 'cautious': the best '+' lane (guards on that lane
 * bite first), else the best outcome overall; mode 'greedy': the best outcome overall. Returns the
 * index and writes { idx, after, guardLoss } into `out`.
 */
function chooseLane(ev, E, hits, bandMid, mode, out) {
  const lanes = ev.lanes;
  let bestIdx = -1, bestAfter = -Infinity, bestLoss = 0;
  let plusIdx = -1, plusAfter = -Infinity, plusLoss = 0;
  let faceIdx = -1, faceVal = -Infinity, faceAfter = 0, faceLoss = 0;
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    let loss = 0;
    if (ev.guards) {
      for (let g = 0; g < ev.guards.length; g++) {
        if (ev.guards[g].lane !== i) continue;
        const st = unitStats(ev.guards[g].units, _stats);
        loss += bandMid * st.bites;
      }
    }
    const Eg = Math.max(1, E - loss);
    const after = laneOutcome(lane, Eg, hits);
    if (after > bestAfter) { bestAfter = after; bestIdx = i; bestLoss = loss; }
    if (lane.op === '+' && after > plusAfter) { plusAfter = after; plusIdx = i; plusLoss = loss; }
    // 'face': the lane that reads best at spawn (a special counts as FACE_ITEM.mult·E + add), then shot with `hits`
    const fv = lane.op === 'item' ? E * FACE_ITEM.mult + FACE_ITEM.add : laneOutcome(lane, Eg, 0);
    if (fv > faceVal) { faceVal = fv; faceIdx = i; faceAfter = after; faceLoss = loss; }
  }
  if (mode === 'nosteer') {
    // round-3 QA LVL-22: a squad that never steers commits to the lane nearest the road centre (gates._nearestLane: ties
    // to the left) — lane 0 of a pair or single, the middle lane of a triple
    const i = lanes.length === 3 ? 1 : 0;
    let loss = 0;
    if (ev.guards) for (let g = 0; g < ev.guards.length; g++) if (ev.guards[g].lane === i) loss += bandMid * unitStats(ev.guards[g].units, _stats).bites;
    out.idx = i; out.after = laneOutcome(lanes[i], Math.max(1, E - loss), hits); out.guardLoss = loss;
  } else if (mode === 'cautious' && plusIdx !== -1) {
    out.idx = plusIdx; out.after = plusAfter; out.guardLoss = plusLoss;
  } else if (mode === 'face') {
    out.idx = faceIdx; out.after = faceAfter; out.guardLoss = faceLoss;
  } else {
    out.idx = bestIdx; out.after = bestAfter; out.guardLoss = bestLoss;
  }
  return out.idx;
}
const _choice = { idx: 0, after: 0, guardLoss: 0 };

// ---------------------------------------------------------------------------------------------
// E-trace simulation — shared by the generator (values are produced from the running trace) and the
// validator (independent re-simulation of a finished script)
// ---------------------------------------------------------------------------------------------

/** QA LVL-15: fraction of a run-up horde inside one walker kill window: win / ((bursts − 1)·burstGap + win), ≥ LEAK_MODEL.runupShareMin. */
function runupShare(ev, v) {
  const r = LEVELS.curve.runup;
  const bursts = Math.max(1, ev.bursts !== undefined ? ev.bursts | 0 : r.bursts);
  const gap = ev.burstGap !== undefined ? ev.burstGap : r.burstGap;
  const win = LEAK_MODEL.usable * LEAK_MODEL.reach / (Math.max(0.01, v) + ZOMBIES.walker.speed);
  return clamp(win / ((bursts - 1) * gap + win), LEAK_MODEL.runupShareMin > 0 ? LEAK_MODEL.runupShareMin : 1, 1);
}

/** Road distance at which a wave spawned at ev.at makes contact with the squad front. */
function waveContactAt(ev, v) {
  if (!ev.lag) {
    const st = unitStats(ev.units, _stats);
    return ev.at + SPAWN_DIST * v / (v + st.sBar);
  }
  // staggered wave (QA LVL-4b): the latest type's contact (they are designed to coincide)
  let c = -Infinity;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    if ((ev.units[t] | 0) <= 0 || t === 'spitter') continue;
    c = Math.max(c, ev.at + (ev.lag[t] || 0) + SPAWN_DIST * v / (v + ZOMBIES[t].speed));
  }
  return Number.isFinite(c) ? c : ev.at + SPAWN_DIST * v / (v + ZOMBIES.spitter.speed);
}

/**
 * Places wave `ev` so every (non-spitter) type reaches the squad at road distance `contact` (QA LVL-4b): `at` is the
 * slowest type's spawn, faster types spawn `lag[t]` road metres later (lags under WAVE_RULES.stagger.minLagM dropped;
 * spitters hold at range and spawn with the first group). `at` never precedes `minAt`.
 */
function placeWave(ev, contact, v, minAt) {
  const units = ev.units;
  let sMin = Infinity;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    if ((units[t] | 0) > 0 && t !== 'spitter') sMin = Math.min(sMin, ZOMBIES[t].speed);
  }
  if (!Number.isFinite(sMin)) sMin = ZOMBIES.spitter.speed;
  ev.at = Math.max(Number.isFinite(minAt) ? minAt : 0, Math.round(contact - SPAWN_DIST * v / (v + sMin)));
  let lag = null;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    if ((units[t] | 0) <= 0 || t === 'spitter') continue;
    const l = Math.round(contact - SPAWN_DIST * v / (v + ZOMBIES[t].speed) - ev.at);
    if (l >= WAVE_RULES.stagger.minLagM) { if (!lag) lag = {}; lag[t] = l; }
  }
  if (lag) ev.lag = lag;
  else delete ev.lag;
  return ev;
}

/** The type a mixed wave must keep: the one its solo introduction announced (else null). */
function introducedType(introOf, ev, newest) {
  for (const w of introOf.values()) if (w === ev) return newest;
  return null;
}

/**
 * Round-3 QA LVL-15 (GDD §6.2): a wave never outnumbers its squad — while the expected squad at contact E is small,
 * brutes and spitters (heavy bites from range / per swing) become walkers below WAVE_RULES.small.heavyMinE, homing runners
 * are capped at max(runnerMin, runnerPerE·E) (the rest walk), and the population is cut to max(min, perE·E) (every type in
 * proportion, ≥ 1 of `keep`). Below heavyMinE the brute / spitter an intro mix keeps (`keep`, the level's new type) is
 * one unit that fills WAVE_RULES.small.keepWeight places of that cap — its swings / spit cost a small squad several
 * soldiers (L5's mixed spitter wave cost an on-curve squad 37 % on 2 of 12 layouts) — and the other types share the
 * rest. The wave is re-placed for its contact (`contact`, road m). Mutates ev.units in place; generator time only.
 */
function shrinkForSquad(ev, E, v, keep, contact) {
  const sm = WAVE_RULES.small;
  if (!sm || !ev.units) return;
  const u = ev.units;
  let changed = false;
  if (E < sm.heavyMinE) {
    for (const t of ['brute', 'spitter']) {
      const n = u[t] | 0;
      if (n <= 0 || t === keep) continue;
      u.walker = (u.walker | 0) + n * (t === 'brute' ? sm.bruteAsWalkers : 1);
      delete u[t];
      changed = true;
    }
  }
  // homing runners bite a small squad hardest: at most max(runnerMin, runnerPerE·E) of them, the rest walk
  const rMax = Math.max(sm.runnerMin | 0, Math.round((sm.runnerPerE > 0 ? sm.runnerPerE : Infinity) * E));
  if ((u.runner | 0) > rMax && keep !== 'runner') {
    u.walker = (u.walker | 0) + (u.runner - rMax);
    if (rMax > 0) u.runner = rMax; else delete u.runner;
    changed = true;
  }
  let n = 0;
  for (let i = 0; i < TYPES.length; i++) n += u[TYPES[i]] | 0;
  const cap = Math.max(sm.min, Math.round(sm.perE * E));
  const kw = E < sm.heavyMinE && (keep === 'brute' || keep === 'spitter') && (u[keep] | 0) > 0 && sm.keepWeight > 1 ? sm.keepWeight : 0;
  if (kw > 0) {
    const others = n - u[keep];
    if (u[keep] > 1 || others + kw > cap) {
      const k = others > 0 ? Math.max(0, cap - kw) / others : 0;
      for (let i = 0; i < TYPES.length; i++) {
        const t = TYPES[i];
        const c = u[t] | 0;
        if (c <= 0) continue;
        const m = t === keep ? 1 : Math.floor(c * k + 0.5);
        if (m > 0) u[t] = m; else delete u[t];
      }
      changed = true;
    }
  } else if (n > cap) {
    const k = cap / n;
    for (let i = 0; i < TYPES.length; i++) {
      const t = TYPES[i];
      const c = u[t] | 0;
      if (c <= 0) continue;
      const m = Math.max(t === keep ? 1 : 0, Math.floor(c * k + 0.5));
      if (m > 0) u[t] = m; else delete u[t];
    }
    changed = true;
  }
  if (changed) placeWave(ev, contact, v, ev.at);
}

/** Road distance at which a gate's guards (guardOffset m in front of it) reach the squad front. */
function guardContactAt(gateAt, units, v) {
  const st = unitStats(units, _stats);
  return gateAt + (SPAWN_DIST - WORLD.guardOffset) * v / (v + st.sBar);
}

/**
 * Orders the events that change E by the distance at which they act on the squad (gate arrival, wave
 * contact, boss spawn). Moments keep a reference to their event; the generator attaches its gate spec.
 */
function buildMoments(events, v) {
  const list = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'gates') list.push({ d: ev.at + SPAWN_DIST, kind: 'gate', ev, idx: i, spec: null });
    else if (ev.type === 'wave') list.push({ d: waveContactAt(ev, v), kind: 'wave', ev, idx: i, spec: null });
    else if (ev.type === 'runup') list.push({ d: waveContactAt(ev, v), kind: 'runup', ev, idx: i, spec: null });
    else if (ev.type === 'boss') list.push({ d: ev.at, kind: 'boss', ev, idx: i, spec: null });
  }
  list.sort((a, b) => (a.d - b.d) || (a.idx - b.idx));
  return list;
}

/**
 * Appends an expected-squad sample so that linear interpolation (level.expectedSquad) reads the previous
 * value until 1 m before `at` and the new value from `at` on (step-like, never a long ramp).
 */
function pushSample(samples, at, e, force) {
  const value = Math.max(1, Math.round(e));
  const d = Math.round(at * 10) / 10;
  const last = samples[samples.length - 1];
  if (d <= last.at) { if (force || value !== last.e) last.e = value; return; }
  if (value === last.e && !force) return;
  if (value !== last.e && d - last.at > 1) samples.push({ at: Math.round((d - 1) * 10) / 10, e: last.e });
  samples.push({ at: d, e: value });
}

/**
 * Runs the design model over the moments.
 * @param {object[]} moments from buildMoments (the generator passes its spec-bearing list)
 * @param {{ v:number, bandMid:number, E0:number, len:number }} p
 * @param {'cautious'|'greedy'} mode
 * @param {{ gate?:function, wave?:function }|null} hooks generator callbacks (materialize / bake HP) run before a moment resolves
 * @returns {{ samples:{at:number,e:number}[], final:number, rows:object[] }}
 */
function simulate(moments, p, mode, hooks) {
  const samples = [{ at: 0, e: Math.max(1, Math.round(p.E0)) }];
  const rows = [];
  let E = p.E0;
  let final = E;
  let sawBoss = false;
  // the last gate this line passed: its panel shields the next wave until it passes, its lane is where the squad stands
  let lastGateD = -Infinity, laneX = 0;
  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    // QA LVL-34: an authored script's modelled line follows its declared samples (GDD §11 "the expected samples ARE the
    // cautious line"): every gate / wave is evaluated at the declared E just before it acts
    if (p.declared && (m.kind === 'gate' || m.kind === 'wave' || m.kind === 'runup')) E = Math.max(1, declaredBefore(p.declared, m.d));
    if (m.kind === 'gate') {
      if (hooks && hooks.gate) hooks.gate(m, E);
      const ev = m.ev;
      const H = expectedHits(E, p.v);
      // 'max': the full-intake greedy line (QA LVL-1) — every lane takes min(40, C·f)·t_w hits, best lane chosen
      const hits = lineHits(mode, E, p.v, p.fire);
      chooseLane(ev, E, hits, p.bandMid, choiceMode(mode), _choice);
      const eBefore = E;
      if (_choice.guardLoss > 0 && ev.guards) {
        // guards reach the squad before the gate does: sample the loss where they bite
        let gAt = m.d;
        for (let g = 0; g < ev.guards.length; g++) {
          if (ev.guards[g].lane === _choice.idx) { gAt = guardContactAt(ev.at, ev.guards[g].units, p.v); break; }
        }
        pushSample(samples, Math.min(gAt, m.d - 1), Math.max(1, E - _choice.guardLoss), false);
      }
      E = Math.max(1, _choice.after);
      pushSample(samples, m.d, E, false);
      rows.push({ kind: 'gate', at: ev.at, d: m.d, eBefore, eAfter: E, H, hits, lane: _choice.idx, guardLoss: _choice.guardLoss, ev, spec: m.spec });
      lastGateD = m.d;
      const centres = WORLD.laneCenters[ev.layout] || WORLD.laneCenters.pair;
      laneX = centres[clamp(_choice.idx, 0, centres.length - 1)];
    } else if (m.kind === 'wave' || m.kind === 'runup') {
      const ev = m.ev;
      // generated scripts are solved with the shield / coverage context (QA LVL-4); authored waves keep the plain reach model
      const wc = p.waveModel ? waveContext(ev.units, ev.pattern, ev.x, laneX, E, m.d >= lastGateD ? m.d - lastGateD : Infinity, {}) : null;
      if (wc && p.calibL > 0) wc.calib = p.calibL * earlyCalib(m.d / Math.max(1, p.len), p.bandMid);   // round-3 QA LVL-15
      // QA LVL-15: the run-up arrives in `bursts` bursts `burstGap` s apart, each meeting the squad's whole fire — only the
      // share of the horde inside one kill window competes for it (a walker window over the bursts' total spread)
      if (wc && m.kind === 'runup') wc.coverage /= runupShare(ev, p.v);
      if (hooks && hooks.wave) hooks.wave(m, E, wc);
      const st = unitStats(ev.units, _stats);
      let leak;
      // the full-intake profiles fire f·d times the base DPS (leak is linear in the squad DPS, so scale E)
      const Ed = (mode === 'max' || mode === 'nosteer') && p.dpsMult > 0 ? E * p.dpsMult : E;
      if (ev.hp) leak = expectedLeak(Ed, p.v, ev.units, ev.hp, ev.hpMult, wc, p.bandMid);
      else if (ev.hpMult && ev.hpMult > 0) leak = leakOfRatio(survivorFactor(p.bandMid) / ev.hpMult);
      else leak = p.bandMid;
      const bites = leak * st.bites;
      const eBefore = E;
      E = Math.max(1, E - bites);
      pushSample(samples, m.d + 1, E, false);
      rows.push({ kind: m.kind, at: ev.at, d: m.d, eBefore, eAfter: E, leak, bites, n: st.n, ev, wc });
    } else if (m.kind === 'boss') {
      if (!m.ev.mini) { final = E; sawBoss = true; }
      rows.push({ kind: 'boss', at: m.ev.at, d: m.d, eBefore: E, eAfter: E, ev: m.ev });
    }
  }
  if (!sawBoss) final = E;
  pushSample(samples, p.len, final, true);
  return { samples, final, rows };
}

// ---------------------------------------------------------------------------------------------
// Gate specs — a gate is rolled once as (layout, pattern, uniform draws); its values are a deterministic
// function of the running E, so the corrector can re-trace after changing one spec (GDD §4.4 "re-roll the
// weakest gate upward")
// ---------------------------------------------------------------------------------------------

const PAIR_PATS = ['plusPlus', 'plusMult', 'minusDiv', 'multMinus', 'plusMinus'];
const SINGLE_PATS = ['+', 'x', '-'];

/** Pair-pattern eligibility at level L with squad E for a gate arriving at `arrival` (GDD §4.4 sanity rules). */
function pairEligible(pat, L, E, arrival) {
  switch (pat) {
    case 'plusPlus':
    case 'plusMult':
      return true;
    case 'minusDiv':                                         // two red lanes: "lesser evil" from L3; no ÷ in the first 150 m of L1–3
      return L >= GEN.rules.lesserEvilFrom && E >= GEN.noRedBelowE
        && !(L <= GEN.rules.noDivLevels && arrival < GEN.rules.noDivBeforeM);
    case 'multMinus':
    case 'plusMinus':
      return E >= GEN.noRedBelowE;
    default:
      return false;                                          // itemPlus is placed by the pickup share, never rolled
  }
}

function singleEligible(sub, L, E) {
  if (sub === '+') return true;
  if (L <= GEN.single.plusOnlyThrough) return false;
  if (sub === '-') return E >= GEN.noRedBelowE;
  return true;                                               // 'x'
}

function tripleEligible(L, E) {
  return L >= GEN.layoutWeights.tripleFromLevel && E >= GEN.noRedBelowE;
}

/** Repairs a spec whose rolled pattern became ineligible because the running E moved (fallback: a +|+ pair / +A single). */
function ensureEligible(spec, L, E) {
  if (spec.pat === 'itemPlus') return spec;
  if (spec.kind === 'triple' && !tripleEligible(L, E)) { spec.kind = 'pair'; spec.pat = 'plusPlus'; }
  if (spec.kind === 'pair' && !pairEligible(spec.pat, L, E, spec.arrival)) spec.pat = 'plusPlus';
  if (spec.kind === 'single' && !singleEligible(spec.pat, L, E)) spec.pat = '+';
  if (spec.M === 3 && L < GEN.mult3.fromLevel) spec.M = GATE_RULES.mult.base;
  if (spec.D === 3 && L < P_MINUSDIV.divThreeFrom) spec.D = GATE_RULES.div.ladder[1];
  return spec;
}

/**
 * Rolls layout, pattern and uniform draws for gate `spec` (positions prefilled) from the bag for band
 * `bandIdx`. `item` forces the item | +A pair (pickup delivery by lane).
 */
function rollSpec(rng, spec, L, E, bandIdx, item) {
  spec.u1 = rng.next();
  spec.u2 = rng.next();
  spec.u3 = rng.next();
  spec.guardRoll = rng.next();
  spec.M = (L >= GEN.mult3.fromLevel && rng.chance(GEN.mult3.chance)) ? GATE_RULES.mult.base + 1 : GATE_RULES.mult.base;
  // D ∈ {2, 3 (from divThreeFrom)} — uniform among the allowed ladder entries above x1
  const divChoices = L >= P_MINUSDIV.divThreeFrom ? GATE_RULES.div.ladder.slice(0, -1) : GATE_RULES.div.ladder.slice(1, -1);
  spec.D = rng.pick(divChoices);
  spec.item = item || null;
  if (item) { spec.kind = 'pair'; spec.pat = 'itemPlus'; return spec; }
  if (spec.idx === 0) {
    // the opening gate is always a welcoming pair (+A | +B or +A | xM), like L1's +5 | +2 — never a red or a single
    spec.kind = 'pair';
    spec.pat = weightedIndex(rng, [P_PLUSPLUS.w[bandIdx], P_PLUSMULT.w[bandIdx]]) === 1 ? 'plusMult' : 'plusPlus';
    return spec;
  }

  const lw = bandIdx === 0 ? GEN.layoutWeights.early : GEN.layoutWeights.mid;
  let wPair = lw.pair, wSingle = lw.single, wTriple = lw.triple;
  if (!tripleEligible(L, E)) { wPair += wTriple; wTriple = 0; }      // L4–6: the triple weight folds into pair
  const li = weightedIndex(rng, [wPair, wSingle, wTriple]);
  if (li === 2) { spec.kind = 'triple'; spec.pat = 'triple'; return spec; }
  if (li === 1) {
    spec.kind = 'single';
    if (L <= GEN.single.plusOnlyThrough) { spec.pat = '+'; return spec; }
    const sw = GEN.single.w;
    const weights = [sw.plus, sw.mult, singleEligible('-', L, E) ? sw.minus : 0];
    spec.pat = SINGLE_PATS[Math.max(0, weightedIndex(rng, weights))];
    return spec;
  }
  spec.kind = 'pair';
  const weights = new Array(PAIR_PATS.length);
  for (let i = 0; i < PAIR_PATS.length; i++) {
    const p = patternById(PAIR_PATS[i]);
    weights[i] = pairEligible(PAIR_PATS[i], L, E, spec.arrival) ? p.w[bandIdx] : 0;
  }
  const pi = weightedIndex(rng, weights);
  spec.pat = pi >= 0 ? PAIR_PATS[pi] : 'plusPlus';
  return spec;
}

function laneOf(op, value) {
  switch (op) {
    case '+': return { op: '+', value, cap: 0 };
    case '-': return { op: '-', value, flipCap: 0 };
    case 'x': return { op: 'x', value, cap: 0, step: 0 };
    case '/': return { op: '/', value, cap: 0, step: 0 };
    default: return { op: 'item', item: value, cap: 0 };
  }
}

/** Fills caps / flipCap / step on every lane from gateDefaults (D19: caps never default at runtime). */
function fillCaps(lanes, E, v) {
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    const d = gateDefaults(lane.op, lane.op === 'item' ? 0 : lane.value, E, v);
    if (lane.op === '+') lane.cap = d.cap;
    else if (lane.op === '-') lane.flipCap = d.flipCap;
    else if (lane.op === 'x' || lane.op === '/') { lane.cap = d.cap; lane.step = d.step; }
    else lane.cap = 0;
  }
  return lanes;
}

/**
 * Guard squad in front of the richer lane (GDD §4.4 "the designed trade-off"): walkers, sized from the population
 * and capped so the expected bites (leak·n) stay ≤ costShare of the richer lane's advantage `delta`. null = no guards.
 */
function guardUnits(pop, delta, bandMid) {
  const byPop = Math.min(GUARDS.max, Math.max(GUARDS.min, Math.round(pop * GUARDS.popFraction)));
  const byWorth = Math.floor(GUARDS.costShare * Math.max(0, delta) / Math.max(0.05, bandMid));
  const n = Math.min(byPop, byWorth);
  return n >= GUARDS.min ? { walker: n } : null;
}

/**
 * Builds the gates event for `spec` at squad E (GDD §4.4 pattern tables). Lane order follows GDD §1:
 * the better option (the design line's face-value choice) sits on half `spec.side`, which the caller alternates over
 * the multi-lane events only (QA LVL-16: singles no longer consume a side); triples put the + lane on that edge.
 * Returns the event; `spec.best` receives the better lane's index.
 */
function materializeGate(spec, E, L, v, pop, bandIdx, bandMid) {
  if (spec.sizeE > 0) E = spec.sizeE;                       // QA LVL-30: the opener is sized from s0Assumed(L)
  ensureEligible(spec, L, E);
  const H = expectedHits(E, v);
  let lanes;
  let guardLane = -1;
  const M = spec.M, D = spec.D;
  if (spec.kind === 'single') {
    if (spec.pat === 'x') lanes = [laneOf('x', M)];
    else if (spec.pat === '-') {
      // A ≤ minusMaxH·H; the magnitude is drawn like the trap's −A (E·U(multMinus.a)) so a single never wipes the squad
      lanes = [laneOf('-', designValue(Math.min(GEN.single.minusMaxH * H, E * lerpRange(P_MULTMINUS.a, spec.u1))))];
    } else lanes = [laneOf('+', designValue(E * GEN.single.aOfE))];
  } else if (spec.kind === 'triple') {
    // GDD §4.4 fixes only B; the + lane is the safe option (plusPlus's A range), so xM is the bet and −B the trap
    const A = designValue(E * lerpRange(P_PLUSPLUS.a, spec.u1));
    const B = designValue(E * GEN.triple.bOfE);
    lanes = [laneOf('+', A), laneOf('x', M), laneOf('-', B)];
  } else {
    switch (spec.pat) {
      case 'plusMult': {
        const A = designValue(E * (M - 1) * lerpRange(P_PLUSMULT.aOfE, spec.u1));
        lanes = [laneOf('+', A), laneOf('x', M)];
        if (bandIdx >= GUARDS.plusMultFromBand && spec.guardRoll < GUARDS.plusMultChance) guardLane = 1;
        break;
      }
      case 'minusDiv': {
        const A = designValue(Math.min(E * (1 - 1 / D) * lerpRange(P_MINUSDIV.aOfE, spec.u1), P_MINUSDIV.aMaxH * H));
        lanes = [laneOf('-', A), laneOf('/', D)];
        break;
      }
      case 'multMinus': {
        const A = designValue(E * lerpRange(P_MULTMINUS.a, spec.u1));
        lanes = [laneOf('x', M), laneOf('-', A)];
        break;
      }
      case 'plusMinus': {
        const B = designValue(Math.min(P_PLUSMINUS.bMaxH * H, E * P_PLUSMINUS.bOfE));
        const A = Math.max(GEN.minValue, Math.floor(B / 2) + P_PLUSMINUS.aPlus);
        lanes = [laneOf('+', A), laneOf('-', B)];
        break;
      }
      case 'itemPlus': {
        // A = E·aOfE (GDD §4.4), scaled inside ITEM_A_SCALE by the tuned draw so the pickup gate also lands its target gain
        const A = designValue(E * P_ITEMPLUS.aOfE * lerpRange(ITEM_A_SCALE, spec.u1));
        lanes = [laneOf('item', spec.item), laneOf('+', A)];
        break;
      }
      default: {                                             // plusPlus
        let A = designValue(E * lerpRange(P_PLUSPLUS.a, spec.u1));
        let B = designValue(A * lerpRange(P_PLUSPLUS.bOfA, spec.u2));
        if (B >= A) { if (A > GEN.minValue) B = A - 1; else A = B + 1; }   // two distinct values even at tiny E
        lanes = [laneOf('+', A), laneOf('+', B)];
        guardLane = 0;                                       // the richer lane carries the zombies (GDD §4.4)
        break;
      }
    }
  }
  fillCaps(lanes, E, v);

  // the "better option" for the alternation rule = the design line's choice without guards
  const probe = { lanes, guards: null };
  chooseLane(probe, E, DESIGN_HITS * H, bandMid, 'face', _choice);
  const rich = _choice.idx;

  let ordered, bestIdx, guardIdx = -1;
  const side = (spec.side | 0) % 2;                           // GDD §1 / QA LVL-16: alternated by the caller over pairs and triples
  if (spec.kind === 'pair') {
    const other = 1 - rich;
    ordered = side === 0 ? [lanes[rich], lanes[other]] : [lanes[other], lanes[rich]];
    bestIdx = side === 0 ? 0 : 1;
    if (guardLane !== -1) guardIdx = guardLane === rich ? bestIdx : 1 - bestIdx;
  } else if (spec.kind === 'triple') {
    const plus = lanes[0], mult = lanes[1], minus = lanes[2];
    const mid = spec.u3 < 0.5 ? [mult, minus] : [minus, mult];
    ordered = side === 0 ? [plus, mid[0], mid[1]] : [mid[1], mid[0], plus];
    bestIdx = side === 0 ? 0 : 2;
  } else {
    ordered = lanes;
    bestIdx = 0;
  }

  const ev = { at: spec.at, type: 'gates', layout: spec.kind, lanes: ordered };
  if (guardIdx !== -1) {
    // the guarded lane's advantage over the other one for a player who shoots it (hitsAssumed·H)
    const hitsG = GEN.hitsAssumed * H;
    const gl = ordered[guardIdx], ol = ordered[1 - guardIdx];
    const units = guardUnits(pop, laneOutcome(gl, E, hitsG) - laneOutcome(ol, E, hitsG), bandMid);
    if (units) ev.guards = [{ lane: guardIdx, units }];
  }
  spec.best = bestIdx;
  return ev;
}

/** True when the event shows at least one red lane. */
function eventHasRed(ev) {
  for (let i = 0; i < ev.lanes.length; i++) if (isRedLane(ev.lanes[i])) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Waves — composition and patterns (GDD §6.2, WAVE_WEIGHTS / WAVE_RULES / WAVE_PATTERNS)
// ---------------------------------------------------------------------------------------------

/**
 * Units of wave j (0-based) of W. The first wave is walkers only; crawlers arrive in packs (6–10) and
 * brutes in pairs (L9+) through debt accumulators that carry their share across waves; runner packs (L11+)
 * and crawler swarms (L16+) land on every 3rd wave; the last wave carries the level's newest type.
 * `w` = { L, P, W, shares, newest, crawlerDebt, bruteDebt }; `flags` receives { pack, swarm }.
 */
function composeWaveUnits(w, j, flags) {
  const L = w.L, P = w.P, shares = w.shares;
  flags.pack = false; flags.swarm = false;
  const units = {};
  if (j === 0) { units.walker = P; return units; }                       // ZOMBIES.common.firstWavePattern: walkers only

  const isPack = L >= WAVE_RULES.runnerPackFrom && (j % BURST_WAVE_PERIOD === 1) && shares[1] > 0;
  const isSwarm = L >= WAVE_RULES.crawlerSwarmFrom && (j % BURST_WAVE_PERIOD === 2) && shares[2] > 0;
  let crawler = 0, brute = 0;
  if (shares[2] > 0) {
    if (isSwarm) { crawler = Math.min(WAVE_RULES.crawlerSwarm, ZOMBIES.crawler.pool); w.crawlerDebt = 0; }
    else {
      w.crawlerDebt += P * shares[2];
      if (w.crawlerDebt >= ZOMBIES.crawler.pack[0]) {
        crawler = Math.min(ZOMBIES.crawler.pack[1], Math.floor(w.crawlerDebt));
        w.crawlerDebt -= crawler;
      }
    }
  }
  if (shares[3] > 0) {
    w.bruteDebt += P * shares[3];
    if (L >= WAVE_RULES.brutePairFrom) {
      if (w.bruteDebt >= 2) { brute = 2 * Math.floor(w.bruteDebt / 2); w.bruteDebt -= brute; }
    } else if (w.bruteDebt >= 1) { brute = Math.floor(w.bruteDebt); w.bruteDebt -= brute; }
    brute = Math.min(brute, ZOMBIES.brute.pool);
  }
  const remaining = Math.max(0, P - crawler - brute);

  // walker / runner / spitter by shares, largest remainder
  const sum = shares[0] + shares[1] + shares[4];
  let walker = 0, runner = 0, spitter = 0;
  if (sum > 0 && remaining > 0) {
    const rawW = remaining * shares[0] / sum, rawR = remaining * shares[1] / sum, rawS = remaining * shares[4] / sum;
    walker = Math.floor(rawW); runner = Math.floor(rawR); spitter = Math.floor(rawS);
    let left = remaining - walker - runner - spitter;
    const fracs = [rawW - walker, rawR - runner, rawS - spitter];
    while (left > 0) {
      let bi = 0;
      for (let i = 1; i < 3; i++) if (fracs[i] > fracs[bi]) bi = i;
      if (bi === 0) walker++; else if (bi === 1) runner++; else spitter++;
      fracs[bi] = -1;
      left--;
    }
  } else walker = remaining;

  if (isPack) {
    const extra = WAVE_RULES.runnerPack - runner;
    if (extra > 0) { runner = WAVE_RULES.runnerPack; walker = Math.max(0, walker - extra); }
    flags.pack = true;
  }
  if (isSwarm) flags.swarm = true;

  if (j === w.W - 1) {                                                   // WAVE_RULES.newestTypeInLastWave
    const t = w.newest;
    const have = t === 'walker' ? walker : t === 'runner' ? runner : t === 'crawler' ? crawler : t === 'brute' ? brute : spitter;
    if (have === 0 && WAVE_RULES.newestTypeInLastWave) {
      let add = 1;
      if (t === 'crawler') add = Math.min(ZOMBIES.crawler.pack[0], Math.max(1, Math.floor(P / 2)));
      else if (t === 'brute' && L >= WAVE_RULES.brutePairFrom) add = 2;
      if (t === 'runner') runner += add; else if (t === 'crawler') crawler += add; else if (t === 'brute') brute += add; else if (t === 'spitter') spitter += add;
      walker = Math.max(0, walker - add);
    }
  }
  if (walker > 0) units.walker = Math.min(walker, ZOMBIES.walker.pool);
  if (runner > 0) units.runner = Math.min(runner, ZOMBIES.runner.pool);
  if (crawler > 0) units.crawler = Math.min(crawler, ZOMBIES.crawler.pool);
  if (brute > 0) units.brute = Math.min(brute, ZOMBIES.brute.pool);
  if (spitter > 0) units.spitter = Math.min(spitter, ZOMBIES.spitter.pool);
  if (units.walker === undefined && units.runner === undefined && units.crawler === undefined && units.brute === undefined && units.spitter === undefined) units.walker = 1;
  return units;
}

const WAVE_PATTERN_NAMES = ['line', 'column', 'horde', 'flank', 'pincer', 'wall'];

/** Pattern for wave j: first wave 'line'; runner packs → pincer (L4+) / flank; swarms → wall (with brutes, L8+) / horde; else weighted. */
function chooseWavePattern(rng, L, units, j, isPack, isSwarm) {
  if (j === 0) return ZOMBIES.common.firstWavePattern;
  if (isPack) return L >= WAVE_PATTERNS.pincer.minLevel ? 'pincer' : 'flank';
  if (isSwarm) return ((units.brute | 0) > 0 && L >= WAVE_PATTERNS.wall.minLevel) ? 'wall' : 'horde';
  const weights = [
    PATTERN_WEIGHTS.line, PATTERN_WEIGHTS.column, PATTERN_WEIGHTS.horde, PATTERN_WEIGHTS.flank,
    (L >= WAVE_PATTERNS.pincer.minLevel && (units.runner | 0) >= 2) ? PATTERN_WEIGHTS.pincer : 0,
    (L >= WAVE_PATTERNS.wall.minLevel && (units.brute | 0) >= 1 && (units.crawler | 0) >= 1) ? PATTERN_WEIGHTS.wall : 0,
  ];
  return WAVE_PATTERN_NAMES[Math.max(0, weightedIndex(rng, weights))];
}

/** Pattern-specific fields: horde/flank/pincer spread, column lane x. */
function decorateWave(ev, rng) {
  switch (ev.pattern) {
    case 'horde': ev.spread = WAVE_PATTERNS.horde.box[1]; break;
    case 'flank': ev.spread = WAVE_PATTERNS.flank.spread; break;
    case 'pincer': ev.spread = WAVE_PATTERNS.pincer.spread; break;
    case 'column': ev.x = rng.pick(WORLD.laneCenters.pair); break;
    default: break;
  }
  return ev;
}

/** Run-up horde: walkers and runners only, split by the level's interpolated weights. */
function runupUnits(L, n) {
  const shares = waveSharesAt(L);
  const w = shares[0], r = shares[1];
  const runner = (r > 0 && w + r > 0) ? Math.round(n * r / (w + r)) : 0;
  const units = { walker: Math.max(0, n - runner) };
  if (runner > 0) units.runner = runner;
  if (units.walker === 0) delete units.walker;
  return units;
}

// ---------------------------------------------------------------------------------------------
// Pickups (GDD §8): specials per level, newest guaranteed, lane / crate split
// ---------------------------------------------------------------------------------------------

/** Sorted lane descriptor of a gates event's values ("+3|x2", "+5|item") — two openers are identical when equal. */
function openerKey(lanes) {
  const parts = [];
  for (let i = 0; i < lanes.length; i++) parts.push(lanes[i].op === 'item' ? 'item' : lanes[i].op + lanes[i].value);
  return parts.sort().join('|');
}

const _openerMemo = new Map();

/**
 * QA LVL-30: the opening gate of generated level L with seed `seed` — a draw from GATE_RULES.generation.opener with its
 * own rng stream (independent of the attempt loop), sized from LEVELS.curve.s0Assumed(L), re-drawn while its values equal
 * the previous level's opener (L − 1 with seed − 1; L1's authored opener for L2). Returns { pat, u1, u2, M, sizeE, key }.
 */
function openerDraw(L, seed) {
  const cfg = GEN.opener;
  if (!cfg || L < 2) return null;
  const memoKey = L + '|' + seed;
  const hit = _openerMemo.get(memoKey);
  if (hit) return { pat: hit.pat, u1: hit.u1, u2: hit.u2, M: hit.M, sizeE: hit.sizeE, key: hit.key };
  let prevKey = null;
  if (L === 2) {
    const l1 = LEVELS.authored[1];
    const first = l1 && l1.events ? l1.events.find((e) => e.type === 'gates') : null;
    if (first) prevKey = openerKey(first.lanes);
  } else {
    const prev = openerDraw(L - 1, ((seed >>> 0) - 1) >>> 0);
    if (prev) prevKey = prev.key;
  }
  const c = curve(L);
  const sizeE = c.eStart;                                    // s0Assumed sizing overshot the full-intake line (L2, L6, L13–L20)
  const pats = ['plusMult', 'plusPlus', 'itemPlus'];
  const weights = [cfg.w.plusMult || 0, cfg.w.plusPlus || 0, cfg.w.itemPlus || 0];
  const base = new Rng((seed >>> 0) || 1).fork(FORK_OPENER);
  let out = null;
  for (let k = 0; k <= (cfg.redraws | 0); k++) {
    const r = base.fork(k + 1);
    const pat = pats[Math.max(0, weightedIndex(r, weights))];
    const o = { pat, u1: r.next(), u2: r.next(), M: GATE_RULES.mult.base, sizeE, key: '' };   // a welcoming x2, never an x3 opener
    const spec = newSpec(0, 0);
    spec.kind = 'pair'; spec.pat = pat; spec.u1 = o.u1; spec.u2 = o.u2; spec.M = o.M; spec.sizeE = sizeE;
    if (pat === 'itemPlus') spec.item = 'coins';
    o.key = openerKey(materializeGate(spec, sizeE, L, c.v, c.pop, c.bandIdx, c.bandMid).lanes);
    out = o;
    if (o.key !== prevKey) break;
  }
  _openerMemo.set(memoKey, out);
  return { pat: out.pat, u1: out.u1, u2: out.u2, M: out.M, sizeE: out.sizeE, key: out.key };
}

/** The level's specials: the newly unlocked one first, then distinct draws from the unlocked bag (repeats only when the bag is exhausted). */
function rollPickupItems(rng, L) {
  const n = Math.min(PICKUPS.perLevel.cap, PICKUPS.perLevel.base + Math.floor(L / PICKUPS.perLevel.perLevels));
  const unlocked = PICKUP_SCHEDULE.slice(0, Math.min(L, PICKUP_SCHEDULE.length));
  const guaranteed = L <= PICKUP_SCHEDULE.length ? PICKUP_SCHEDULE[L - 1] : null;
  const items = [];
  if (guaranteed) items.push(guaranteed);
  const bag = [];
  for (let i = 0; i < unlocked.length; i++) if (unlocked[i] !== guaranteed) bag.push(unlocked[i]);
  rng.shuffle(bag);
  let k = 0;
  while (items.length < n) {
    if (bag.length === 0) items.push(rng.pick(unlocked));
    else { items.push(bag[k % bag.length]); k++; }
  }
  return items;
}

/** Nudges a crate arrival away from gate arrivals and wave contacts (≥ PICKUP_CLEAR_M). */
function clearOfObstacles(a, obstacles, lo, hi) {
  let x = a;
  for (let tries = 0; tries < 12; tries++) {
    let hit = false;
    for (let i = 0; i < obstacles.length; i++) {
      if (Math.abs(obstacles[i] - x) < PICKUP_CLEAR_M) { hit = true; break; }
    }
    if (!hit) break;
    x += PICKUP_CLEAR_M;
    if (x > hi) { x = lo + (x - hi); }
  }
  return clamp(x, lo, hi);
}

// ---------------------------------------------------------------------------------------------
// generateLevel — GDD §4.4 / §6.2 / §10; ARCH §6.17
// ---------------------------------------------------------------------------------------------

function cloneSpec(s) {
  return { idx: s.idx, at: s.at, arrival: s.arrival, kind: s.kind, pat: s.pat, u1: s.u1, u2: s.u2, u3: s.u3,
    guardRoll: s.guardRoll, M: s.M, D: s.D, item: s.item, best: s.best, rolled: s.rolled };
}

function assignSpec(dst, src) {
  dst.kind = src.kind; dst.pat = src.pat; dst.u1 = src.u1; dst.u2 = src.u2; dst.u3 = src.u3;
  dst.guardRoll = src.guardRoll; dst.M = src.M; dst.D = src.D; dst.item = src.item; dst.best = src.best; dst.rolled = src.rolled;
}

/** A fresh gate spec at road position `at` (spawn distance); layout/pattern/draws are rolled later. */
function newSpec(idx, at) {
  return { idx, at, arrival: at + SPAWN_DIST, kind: 'pair', pat: 'plusPlus', u1: 0.5, u2: 0.5, u3: 0.5, guardRoll: 1,
    M: GATE_RULES.mult.base, D: GATE_RULES.div.ladder[1], item: null, best: 0, rolled: false, side: 0 };
}

/**
 * QA LVL-16 (GDD §1 "gate events alternate which half holds the better option"): the side of a finished spec. Only
 * multi-lane events (pairs, triples) take a side and advance the counter `gx.multi`; a single holds side 0.
 */
function assignSide(spec, gx) {
  if (spec.kind === 'pair' || spec.kind === 'triple') spec.side = (gx.multi++) % 2;
  else spec.side = 0;
  return spec.side;
}

/**
 * How a modelled line picks its lane: 'cautious' (authored L1) the best '+' lane; the design ('greedy') and weak lines
 * the lane that reads best at spawn ('face' — the naive player the smoke bot models, who also takes a special over a
 * small +A); the full-intake line ('max') the best outcome.
 */
function choiceMode(mode) {
  if (mode === 'cautious') return 'cautious';
  if (mode === 'nosteer') return 'nosteer';
  return mode === 'max' ? 'greedy' : 'face';
}

/** Weighted hits a modelled line lands on its lane: cautious 0.3·H, design/greedy hitsAssumed·H, max = full intake. */
function lineHits(mode, E, v, fire) {
  if (mode === 'max' || mode === 'nosteer') {                // the full intake plus the bucket the gate starts with
    const burst = GATE_RULES.intakePerSec * (Number.isFinite(GATE_RULES.intakeWindowS) ? GATE_RULES.intakeWindowS : 0);
    return Math.min(windowCapacity(v), windowIntake(E, v, fire) + burst);
  }
  return (mode === 'cautious' || mode === 'weak' ? CAUTIOUS_HITS : DESIGN_HITS) * expectedHits(E, v);
}

/** Count after gate `ev` for a squad of E on line `mode` (guards on the chosen lane included). */
function lineAfter(ev, E, v, bandMid, mode) {
  chooseLane(ev, E, lineHits(mode, E, v), bandMid, choiceMode(mode), _choice);
  return Math.max(1, _choice.after);
}

/**
 * Shadow lines the generator watches while it sizes the design line (QA LVL-1). `active` false → design gain only.
 * Emax / Ecaut = the full-intake and cautious lines' counts before this gate; lnMaxAllow / lnCautReq = the per-gate
 * gain those lines may take / need so they end at LINE_GUARDS.maxTarget / cautiousTarget of E_boss.
 */
const _shadow = { active: false, Emax: 1, Ecaut: 1, lnMaxAllow: 0, lnCautReq: 0 };

/**
 * Design gain (E after / E before) of a spec materialised at squad Eb (guards on the chosen lane included);
 * fills `_gains` with the shadow lines' gains. `g` = { L, v, pop, bandIdx, bandMid }.
 */
const _gains = { design: 1, max: 1, caut: 1 };
function gainOf(spec, Eb, g) {
  const ev = materializeGate(spec, Eb, g.L, g.v, g.pop, g.bandIdx, g.bandMid);
  _gains.design = lineAfter(ev, Eb, g.v, g.bandMid, 'greedy') / Math.max(1, Eb);
  if (_shadow.active) {
    _gains.max = lineAfter(ev, _shadow.Emax, g.v, g.bandMid, 'max') / Math.max(1, _shadow.Emax);
    _gains.caut = lineAfter(ev, _shadow.Ecaut, g.v, g.bandMid, 'weak') / Math.max(1, _shadow.Ecaut);
  }
  return _gains.design;
}

/**
 * Distance (ln units) of `spec`'s design gain outside the accepted band [lnTarget − tol.lo, lnTarget + tol.hi]
 * (0 inside), plus the weighted excess of the full-intake line over its allowance and the cautious line's shortfall.
 */
function gainError(spec, Eb, lnTarget, tol, g) {
  const d = Math.log(gainOf(spec, Eb, g)) - lnTarget;
  let err = 0;
  if (d > tol.hi) err = d - tol.hi;
  else if (d < -tol.lo) err = -tol.lo - d;
  if (_shadow.active) {
    const over = Math.log(_gains.max) - _shadow.lnMaxAllow;
    if (over > 0) err += LINE_GUARDS.maxWeight * over;
    const under = _shadow.lnCautReq - Math.log(_gains.caut);
    if (under > 0) err += LINE_GUARDS.cautiousWeight * under;
  }
  return err;
}

/**
 * Tunes the pattern's first uniform draw inside its GDD range: keeps the rolled draw when it already lands
 * within `tol` of the target gain, else the in-tolerance grid draw closest to the rolled one (variety), else
 * the grid draw with the smallest error. Returns the error of the chosen draw.
 */
function tuneDraw(spec, Eb, lnTarget, tol, g) {
  const u0 = spec.u1;
  const e0 = gainError(spec, Eb, lnTarget, tol, g);
  if (e0 <= 0) return 0;
  let bestU = u0, bestErr = e0, pickU = -1, pickErr = Infinity, pickDist = Infinity;
  for (let k = 0; k <= U_STEPS; k++) {
    const u = k / U_STEPS;
    spec.u1 = u;
    const err = gainError(spec, Eb, lnTarget, tol, g);
    if (err < bestErr - 1e-12) { bestErr = err; bestU = u; }
    const dist = Math.abs(u - u0);
    if (err <= 0 && dist < pickDist) { pickDist = dist; pickU = u; pickErr = err; }
  }
  if (pickU >= 0) { spec.u1 = pickU; return pickErr; }
  spec.u1 = bestU;
  return bestErr;
}

/** Every eligible (kind, pat, M, D) a gate could take at squad Eb (GDD §4.4 bag entries, sanity rules applied). */
function enumerateVariants(spec, Eb, g) {
  const L = g.L;
  const Ms = L >= GEN.mult3.fromLevel ? [GATE_RULES.mult.base, GATE_RULES.mult.base + 1] : [GATE_RULES.mult.base];
  const Ds = L >= P_MINUSDIV.divThreeFrom ? GATE_RULES.div.ladder.slice(0, -1) : GATE_RULES.div.ladder.slice(1, -1);
  const list = [];
  for (let i = 0; i < PAIR_PATS.length; i++) {
    const pat = PAIR_PATS[i];
    if (!pairEligible(pat, L, Eb, spec.arrival)) continue;
    if (pat === 'plusMult' || pat === 'multMinus') { for (let m = 0; m < Ms.length; m++) list.push({ kind: 'pair', pat, M: Ms[m], D: spec.D }); }
    else if (pat === 'minusDiv') { for (let d = 0; d < Ds.length; d++) list.push({ kind: 'pair', pat, M: spec.M, D: Ds[d] }); }
    else list.push({ kind: 'pair', pat, M: spec.M, D: spec.D });
  }
  if (spec.idx > 0) {
    for (let i = 0; i < SINGLE_PATS.length; i++) {
      const sub = SINGLE_PATS[i];
      if (!singleEligible(sub, L, Eb)) continue;
      if (sub === 'x') { for (let m = 0; m < Ms.length; m++) list.push({ kind: 'single', pat: sub, M: Ms[m], D: spec.D }); }
      else list.push({ kind: 'single', pat: sub, M: spec.M, D: spec.D });
    }
    if (tripleEligible(L, Eb)) for (let m = 0; m < Ms.length; m++) list.push({ kind: 'triple', pat: 'triple', M: Ms[m], D: spec.D });
  }
  return list;
}

/**
 * Pacing rules the bag alone does not guarantee (GDD §1 rhythm, readability): the opening gate is a welcoming
 * pair (+|+ or +|x), never two singles or two triples back to back, never the same pair pattern three times running,
 * and the last gate before the run-up is never a no-way-around red single (the squad walks into the boss on a choice).
 */
function isRedOnly(kind, pat) {
  return (kind === 'single' && pat === '-') || (kind === 'pair' && pat === 'minusDiv');
}

function violatesPacing(spec, gx) {
  if (spec.idx === 0) return !(spec.kind === 'pair' && (spec.pat === 'plusPlus' || spec.pat === 'plusMult'));
  if (gx.last && spec.kind === 'single' && spec.pat === '-') return true;
  const p1 = gx.prev, p2 = gx.prev2;
  // never two all-red events (−A | ÷D, a −A single) back to back: a gain gate always sits between two lesser evils
  if (p1 && isRedOnly(spec.kind, spec.pat) && isRedOnly(p1.kind, p1.pat)) return true;
  if (p1 && spec.kind === 'single' && p1.kind === 'single') return true;
  if (p1 && spec.kind === 'triple' && p1.kind === 'triple') return true;
  if (p1 && p2 && spec.kind === 'pair' && p1.pat === spec.pat && p2.pat === spec.pat) return true;
  return false;
}

/**
 * Chooses layout, pattern and draws for gate `spec` at squad Eb so its cautious gain lands near `target`
 * (GDD §4.4 "re-roll the weakest gate"): up to SPEC_TRIES rolls from the bag (each with its draw tuned inside
 * the pattern's range), then a deterministic sweep over every eligible variant; the best one wins.
 * Item-lane gates (item | +A) are fixed by the pickup delivery and only rolled.
 */
function selectSpec(rng, spec, Eb, target, gx) {
  const g = gx.g;
  // item-lane gates are fixed by the pickup delivery; the opener is a straight bag roll between the two welcoming
  // pairs (at E ≈ 5 no draw can tune it, and the following gates absorb its swell)
  const lnTarget = Math.log(Math.max(1e-6, target));
  const tol = gx.tol;
  if (spec.item) {                                           // only the +A draw of an item | +A gate is tuned
    rollSpec(rng, spec, g.L, Eb, g.bandIdx, spec.item);
    spec.rolled = true;
    tuneDraw(spec, Eb, lnTarget, tol, g);
    return;
  }
  if (spec.idx === 0 && spec.opener) {                       // QA LVL-30: the pre-drawn opener (openerDraw), never tuned
    const o = spec.opener;
    spec.kind = 'pair'; spec.pat = o.pat; spec.u1 = o.u1; spec.u2 = o.u2; spec.M = o.M; spec.sizeE = o.sizeE;
    if (o.pat === 'itemPlus') spec.item = o.item;
    spec.rolled = true;
    return;
  }
  if (spec.idx === 0) { rollSpec(rng, spec, g.L, Eb, g.bandIdx, null); spec.rolled = true; return; }
  if (spec.feature) {                                        // QA LVL-5: the level's new gate feature, exempt from re-rolls
    rollSpec(rng, spec, g.L, Eb, g.bandIdx, null);
    if (spec.feature === 'triple') { spec.kind = 'triple'; spec.pat = 'triple'; }
    // round-3 QA LVL-22: the x3 is shown as the bet of a +A | x3 pair (it was a single: everyone shot it to x5, steering or not)
    else if (spec.feature === 'mult3') { spec.kind = 'pair'; spec.pat = 'plusMult'; spec.M = GATE_RULES.mult.base + 1; }
    else { spec.kind = 'pair'; spec.pat = 'minusDiv'; spec.D = GATE_RULES.div.ladder[0]; }
    spec.rolled = true;
    tuneDraw(spec, Eb, lnTarget, tol, g);
    return;
  }
  let best = null, bestErr = Infinity;
  for (let t = 0; t < SPEC_TRIES; t++) {
    rollSpec(rng, spec, g.L, Eb, g.bandIdx, null);
    spec.rolled = true;
    ensureEligible(spec, g.L, Eb);
    if (violatesPacing(spec, gx)) continue;
    const err = tuneDraw(spec, Eb, lnTarget, tol, g);
    if (err <= 0) return;
    if (err < bestErr) { bestErr = err; best = cloneSpec(spec); }
  }
  // QA LVL-30: the second gate keeps its best bag roll (the deterministic sweep below made it a '÷3 | −N' on most levels);
  // the adaptive target of the later gates absorbs the difference
  if (spec.idx === 1 && best !== null && bestErr < SECOND_SLOT_MAX_ERR) { assignSpec(spec, best); return; }
  // deterministic sweep (the last roll's draws are kept for u2/u3/guardRoll)
  const variants = enumerateVariants(spec, Eb, g);
  const keepU = spec.u1;
  for (let i = 0; i < variants.length; i++) {
    const vr = variants[i];
    spec.kind = vr.kind; spec.pat = vr.pat; spec.M = vr.M; spec.D = vr.D; spec.u1 = keepU;
    if (violatesPacing(spec, gx)) continue;
    const err = tuneDraw(spec, Eb, lnTarget, tol, g);
    if (err < bestErr - 1e-9) { bestErr = err; best = cloneSpec(spec); }
  }
  if (best !== null) assignSpec(spec, best);
  else { spec.kind = 'pair'; spec.pat = 'plusPlus'; }       // nothing passed the pacing rules (cannot happen for idx 0)
}

/** Remembers the last two gate kinds/patterns for the pacing rules. */
function notePacing(gx, spec) {
  gx.prev2 = gx.prev;
  gx.prev = { kind: spec.kind, pat: spec.pat };
}

/** Per-gate tolerance: loose while later gates can still correct, tight for the last two. */
function gainTolerance(gatesLeft) {
  if (gatesLeft <= 1) return GAIN_TOL.last;
  if (gatesLeft === 2) return GAIN_TOL.near;
  if (gatesLeft <= 4) return GAIN_TOL.mid;
  return GAIN_TOL.early;
}

/**
 * Adaptive per-gate target gain: the remaining gates share ln((goal + later bites) / E) evenly, never less than
 * the survival floor (this gate must more than repay the bites before the next gate while gates remain).
 */
function gateTarget(m, E, goal) {
  const Eb = Math.max(1, E);
  let t = Math.pow(Math.max(1, goal + m.lossAfter) / Eb, 1 / Math.max(1, m.gatesLeft));
  if (m.gatesLeft > 2) t = Math.max(t, (Eb + SURVIVE_MULT * m.nextBites) / Eb);
  return t;
}

/**
 * Annotates sorted moments with what the adaptive target needs: `gatesLeft` (gate moments from here on,
 * this one included) and `lossAfter` (expected bites of every wave / run-up after this moment).
 */
function annotateMoments(moments, bandMid) {
  let loss = 0, gates = 0, cycle = 0;
  for (let i = moments.length - 1; i >= 0; i--) {
    const m = moments[i];
    if (m.kind === 'gate') { gates++; m.nextBites = cycle; cycle = 0; }
    m.gatesLeft = gates;
    m.lossAfter = loss;
    if ((m.kind === 'wave' || m.kind === 'runup') && m.ev && m.ev.units) {
      const b = bandMid * unitStats(m.ev.units, _stats).bites;
      loss += b;
      cycle += b;
    }
  }
}

/** The gate feature (mult3 / triple / div3) still owed by the attempt being built (QA LVL-5); null when none. */
let featurePending = null;

/** Builds one candidate script for level L from a forked rng (the attempt loop lives in generateLevel). */
function buildAttempt(L, seed, c, rng) {
  const len = c.len, v = c.v, G = c.gates, W = c.waves, pop = c.pop, bandMid = c.bandMid, bandIdx = c.bandIdx;
  const cc = LEVELS.curve;
  const g = { L: c.L, v, pop, bandIdx, bandMid };

  // --- gate positions: gateStartM is the first gate's ARRIVAL; the last gate arrives before the run-up with room for its wave
  const firstArrival = cc.gateStartM;
  const lastArrival = len - cc.runup.metres - cc.waveAfterGateM;
  const spacing = G > 1 ? (lastArrival - firstArrival) / (G - 1) : 0;
  const specs = [];
  for (let i = 0; i < G; i++) specs.push(newSpec(i, Math.max(0, Math.round(firstArrival + i * spacing - SPAWN_DIST))));

  // --- waves: every type makes contact waveAfterGateM past its gate's arrival (W = G − 1 below L10 leaves the last gate
  // to the run-up); faster types spawn later through ev.lag so runners / crawlers arrive with the walkers (QA LVL-4b)
  const wctx = { L: c.L, P: pop, W, shares: waveSharesAt(c.L), newest: c.newest, crawlerDebt: 0, bruteDebt: 0 };
  // QA LVL-8: the crawler unlock level shows one full pack (pack[0]) in its first mixed wave
  if (WAVE_RULES.unlockPack && c.L === ZOMBIES.crawler.unlock && wctx.shares[2] > 0) {
    wctx.crawlerDebt = Math.max(0, ZOMBIES.crawler.pack[0] - pop * wctx.shares[2]) + 1e-6;
  }
  const flags = { pack: false, swarm: false };
  const waves = [];
  const contacts = [];
  for (let j = 0; j < W && j < G; j++) {
    const gs = specs[j];
    const units = composeWaveUnits(wctx, j, flags);
    const ev = decorateWave({ at: 0, type: 'wave', pattern: chooseWavePattern(rng, c.L, units, j, flags.pack, flags.swarm), units }, rng);
    const contact = gs.arrival + cc.waveAfterGateM;
    placeWave(ev, contact, v, gs.at + 1);
    waves.push(ev);
    contacts.push(contact);
  }

  // --- solo introduction of the level's new type 60 m (LEVELS.curve.introAheadM) before its first mixed wave
  // (GDD §6.2, QA LVL-12): the intro's contact must stay out of every gate's armed window, at least waveAfterGateM past
  // the gate before it (so the panel no longer shields it) and pickupClearM away from every other wave's contact; when
  // no spawn within ±introSearchM of the target fits, the first mixed wave moves later (up to the next gate's armed line)
  // instead of the intro; a mixed wave that still cannot be introduced loses the new type (walkers instead) and the
  // next one is tried — the last wave always carries it (WAVE_RULES.newestTypeInLastWave)
  const intros = [];
  const introOf = new Map();                                // intro event → the mixed wave it introduces
  if (c.newest !== 'walker' && ZOMBIES[c.newest].unlock === c.L && waves.length > 1) {
    const t = c.newest;
    const sT = ZOMBIES[t].speed;
    const armW = -WORLD.gateArmZ;
    const introFits = (contactI, skip) => {
      for (let i = 0; i < G; i++) {
        const a = specs[i].arrival;
        if (contactI > a - armW - PICKUP_CLEAR_M / 3 && contactI < a + cc.waveAfterGateM) return false;   // armed window / shielded stretch
      }
      for (let k = 0; k < waves.length; k++) if (k !== skip && Math.abs(waveContactAt(waves[k], v) - contactI) < PICKUP_CLEAR_M) return false;
      return contactI > 0;
    };
    let placed = false;
    for (let j = 1; j < waves.length && !placed; j++) {
      const wv = waves[j];
      if (j === waves.length - 1 && (wv.units[t] | 0) === 0) {
        wv.units[t] = 1;
        if ((wv.units.walker | 0) > 1) wv.units.walker -= 1;
        placeWave(wv, contacts[j], v, specs[j].at + 1);
      }
      if ((wv.units[t] | 0) === 0) continue;
      const nextArm = j + 1 < G ? specs[j + 1].arrival - armW - PICKUP_CLEAR_M : Infinity;
      for (let shift = 0; shift <= INTRO_SHIFT_MAX_M && !placed; shift += INTRO_SHIFT_STEP_M) {
        if (shift > 0) {
          if (contacts[j] + shift > nextArm) break;
          placeWave(wv, contacts[j] + shift, v, specs[j].at + 1);
        }
        const target = wv.at - LEVELS.curve.introAheadM;
        let bestAt = -1, bestD = Infinity;
        for (let d = -INTRO_SEARCH_M; d <= INTRO_SEARCH_M; d++) {
          const introAt = Math.round(target + d);
          if (introAt < 0) continue;
          if (!introFits(introAt + SPAWN_DIST * v / (v + sT), j)) continue;
          if (Math.abs(d) < bestD) { bestD = Math.abs(d); bestAt = introAt; }
        }
        if (bestAt >= 0) {
          const units = {};
          units[t] = 1;
          const ev = { at: bestAt, type: 'wave', pattern: ZOMBIES.common.firstWavePattern, units };
          if (HINTS[t]) ev.hint = t;
          intros.push(ev);
          introOf.set(ev, wv);
          placed = true;
          contacts[j] += shift;
        }
      }
      if (!placed) {
        placeWave(wv, contacts[j], v, specs[j].at + 1);       // undo any shift
        if (j < waves.length - 1) {
          wv.units.walker = (wv.units.walker | 0) + (wv.units[t] | 0);   // cannot be introduced here: walkers instead
          delete wv.units[t];
          placeWave(wv, contacts[j], v, specs[j].at + 1);
        }
      }
    }
  }

  // --- run-up and boss
  const runupAt = len - cc.runup.metres;
  const runupEv = { at: runupAt, type: 'runup', units: runupUnits(c.L, c.runup), bursts: cc.runup.bursts, burstGap: cc.runup.burstGap, pattern: cc.runup.pattern };
  const bossEv = { at: len, type: 'boss', id: 'boss.' + c.bossId, archetype: c.bossId, hp: c.bossHp };

  // --- pickups: PICKUPS.gateShare by item lane (only where the item|+A pattern exists, i.e. band ≥ 1), the rest by crate
  const items = rollPickupItems(rng, c.L);
  // QA LVL-30: the opener (pattern bag GATE_RULES.generation.opener, sized from s0Assumed, never the previous level's);
  // an item | +A opener carries the last non-guaranteed special of the level (one delivery fewer below)
  const opener = openerDraw(c.L, seed);
  if (opener) {
    if (opener.pat === 'itemPlus' && items.length >= 2) { opener.item = items.pop(); }
    else if (opener.pat === 'itemPlus') opener.pat = 'plusMult';
    specs[0].opener = opener;
  }
  const rangeLo = cc.pickupRange[0] * len, rangeHi = Math.min(cc.pickupRange[1] * len, runupAt - PICKUP_CLEAR_M);
  const inRange = [];
  for (let i = 1; i < G; i++) if (specs[i].arrival >= rangeLo && specs[i].arrival <= rangeHi) inRange.push(i);
  let nLane = P_ITEMPLUS.w[bandIdx] > 0 ? Math.round(items.length * PICKUPS.gateShare) : 0;
  nLane = Math.min(nLane, inRange.length);
  const laneSlots = rng.shuffle(inRange.slice()).slice(0, nLane).sort((a, b) => a - b);
  const nCrates = items.length - nLane;
  const obstacles = [];
  for (let i = 0; i < G; i++) obstacles.push(specs[i].arrival);
  for (let j = 0; j < waves.length; j++) obstacles.push(waveContactAt(waves[j], v));
  const deliveries = [];
  for (let i = 0; i < laneSlots.length; i++) deliveries.push({ kind: 'lane', at: specs[laneSlots[i]].arrival, slot: laneSlots[i] });
  for (let k = 0; k < nCrates; k++) {
    const a = clearOfObstacles(rangeLo + (k + 1) * (rangeHi - rangeLo) / (nCrates + 1), obstacles, rangeLo, rangeHi);
    obstacles.push(a);
    deliveries.push({ kind: 'crate', at: a, slot: -1 });
  }
  deliveries.sort((a, b) => a.at - b.at);
  // QA LVL-26 (GDD §8, round-1 LVL-7): the guaranteed (newly unlocked) special always rides the earliest CRATE, which is
  // placed on the design half below — an item lane paired with a richer +A is skipped by a player following the gates.
  // The other items fill the remaining deliveries in order.
  const guaranteed = c.L <= PICKUP_SCHEDULE.length ? PICKUP_SCHEDULE[c.L - 1] : null;
  if (guaranteed && items[0] === guaranteed) {
    let ci = -1;
    for (let i = 0; i < deliveries.length; i++) if (deliveries[i].kind === 'crate') { ci = i; break; }
    if (ci > 0) { const d = deliveries.splice(ci, 1)[0]; deliveries.unshift(d); }
  }
  const crates = [];
  let guaranteedCrate = null;                               // QA LVL-7: placed on the design lane after the sizing pass
  let crateHinted = false;
  for (let i = 0; i < deliveries.length; i++) {
    const d = deliveries[i];
    const item = items[i];
    if (d.kind === 'lane') specs[d.slot].item = item;
    else {
      crates.push({ at: Math.max(0, Math.round(d.at - SPAWN_DIST)), type: 'crate', item, x: rng.pick(WORLD.laneCenters.pair) });
      if (i === 0 && item === guaranteed) guaranteedCrate = crates[crates.length - 1];
      // QA LVL-24: the hint shows once the crate is ~40 m out (30 m after its spawn), not at the horizon
      if (!crateHinted) { crates.push({ at: crates[crates.length - 1].at + CRATE_HINT_AFTER_M, type: 'hint', id: 'crate' }); crateHinted = true; }
    }
  }

  // --- coin lines: one per COIN_LINE_EVERY_GATES gate events, after that gate's wave has made contact
  const coins = [];
  for (let i = 1; i < G; i += COIN_LINE_EVERY_GATES) {
    const arrival = specs[i].arrival + cc.waveAfterGateM + 2 * PICKUP_CLEAR_M;
    if (arrival >= runupAt) break;
    const at = Math.round(arrival - SPAWN_DIST);
    if (at <= 0) continue;
    coins.push({ at, type: 'coins', x: rng.pick(WORLD.laneCenters.pair), count: PICKUPS.coinLine.count });
  }

  // --- the running cautious trace sizes every gate (adaptive target) and bakes every wave's HP
  const moments = [];
  let order = 0;
  for (let i = 0; i < G; i++) moments.push({ d: specs[i].arrival, kind: 'gate', ev: null, idx: order++, spec: specs[i] });
  for (let j = 0; j < waves.length; j++) moments.push({ d: waveContactAt(waves[j], v), kind: 'wave', ev: waves[j], idx: order++, spec: null });
  for (let j = 0; j < intros.length; j++) moments.push({ d: waveContactAt(intros[j], v), kind: 'wave', ev: intros[j], idx: order++, spec: null });
  moments.push({ d: waveContactAt(runupEv, v), kind: 'runup', ev: runupEv, idx: order++, spec: null });
  moments.push({ d: len, kind: 'boss', ev: bossEv, idx: order++, spec: null });
  moments.sort((a, b) => (a.d - b.d) || (a.idx - b.idx));
  annotateMoments(moments, bandMid);

  const p = { v, bandMid, E0: c.eStart, len, waveModel: true, calibL: levelCalib(c.L) };
  const guardWc = { exposureM: Infinity, coverage: 1, laneX: 0, calib: p.calibL };   // round-3 QA LVL-15: guards carry the level factor
  // QA LVL-16: the first pair's better half follows the seed's parity (seed + 1), so levels open on either side
  const gx = { g, tol: GAIN_TOL.early, last: false, prev: null, prev2: null, multi: ((seed >>> 0) + 1) & 1 };
  // shadow lines (QA LVL-1): the full-intake line of a fresh profile and the cautious line, re-traced alongside the design
  // line so selectSpec can keep the first under LINE_GUARDS.maxTarget·E_boss and the second above cautiousTarget·E_boss
  const sh = { Emax: Math.max(c.eStart, profileAt(0).s0), Ecaut: c.eStart };
  const hooks = {
    gate(m, E) {
      const s = m.spec;
      const target = gateTarget(m, E, c.eBoss);
      gx.tol = gainTolerance(m.gatesLeft);
      gx.last = m.gatesLeft === 1;
      if (featurePending && s.idx >= 1 && !s.item) {
        const eligible = featurePending === 'mult3' || E >= GEN.noRedBelowE;
        const paced = (!(featurePending === 'div3' && gx.prev && isRedOnly(gx.prev.kind, gx.prev.pat))
          && !(featurePending === 'mult3' && gx.prev && gx.prev.kind === 'single')) || m.gatesLeft <= 2;
        if (eligible && paced) { s.feature = featurePending; featurePending = null; }
      }
      const n = Math.max(1, m.gatesLeft);
      _shadow.active = true;
      _shadow.Emax = sh.Emax;
      _shadow.Ecaut = sh.Ecaut;
      _shadow.lnMaxAllow = Math.log(Math.max(1, LINE_GUARDS.maxTarget * c.eBoss) / Math.max(1, sh.Emax)) / n;
      _shadow.lnCautReq = Math.log(Math.max(1, LINE_GUARDS.cautiousTarget * c.eBoss + m.lossAfter) / Math.max(1, sh.Ecaut)) / n;
      selectSpec(rng, s, E, target, gx);
      _shadow.active = false;
      assignSide(s, gx);
      m.ev = materializeGate(s, E, c.L, v, pop, bandIdx, bandMid);
      guardWc.calib = p.calibL * earlyCalib(m.d / Math.max(1, len), bandMid);
      if (m.ev.guards) for (let i = 0; i < m.ev.guards.length; i++) m.ev.guards[i].hp = solveWaveHp(E, v, m.ev.guards[i].units, bandMid, null, guardWc);
      sh.Emax = lineAfter(m.ev, sh.Emax, v, bandMid, 'max');
      sh.Ecaut = lineAfter(m.ev, sh.Ecaut, v, bandMid, 'weak');
      notePacing(gx, s);
    },
    wave(m, E, wc) {
      const ev = m.ev;
      // round-3 QA LVL-15: a small squad meets a small wave (no early wave may cost an on-curve squad more than ~35 %)
      if (ev.type === 'wave' && !introOf.has(ev)) shrinkForSquad(ev, E, v, introducedType(introOf, ev, c.newest), m.d);
      // QA LVL-4c / LVL-8: a crawler line rides the lane the squad holds (a ±guardHalfWidth carpet on that lane) instead of
      // a road-wide line whose edge crawlers slip past the shooter columns
      const mixed = introOf.get(ev);
      // … and a solo introduction walks out in front of the squad's lane (a showcase the squad meets head-on)
      if (ev.type === 'wave' && ev.pattern === 'line' && ev.x === undefined && wc && (mixed || (ev.units.crawler | 0) > 1)) {
        ev.x = wc.laneX;
        wc.coverage = waveCoverage(ev.units, ev.pattern, ev.x, wc.laneX, E);
      }
      if (mixed) {
        // a solo introduction is a showcase, not a sponge: its type's HP in the wave it introduces, capped so the
        // squad's whole fire kills it inside its window (INTRO_HP_FRAC of the no-leak solve)
        const ref = solveWaveHp(E, v, mixed.units, bandMid, null, wc);
        const solo = solveWaveHp(E, v, ev.units, 0, null, wc);
        const hp = {};
        for (const t in ev.units) {
          const r = ref[t] !== undefined ? ref[t] : ZOMBIES[t].baseHp;
          hp[t] = Math.max(LEAK_MODEL.minHp, Math.min(r, Math.round(INTRO_HP_FRAC * (solo[t] || r))));
        }
        ev.hp = hp;
      } else ev.hp = solveWaveHp(E, v, ev.units, bandMid, null, wc);
      const bites = unitStats(m.ev.units, _stats).bites;
      sh.Emax = Math.max(1, sh.Emax - expectedLeak(sh.Emax, v, m.ev.units, m.ev.hp, m.ev.hpMult, wc, bandMid) * bites);
      sh.Ecaut = Math.max(1, sh.Ecaut - expectedLeak(sh.Ecaut, v, m.ev.units, m.ev.hp, m.ev.hpMult, wc, bandMid) * bites);
    },
  };
  // QA LVL-5: the level that introduces a gate feature (GATE_RULES.generation.newFeature) shows it on one gate
  const nf = GEN.newFeature;
  featurePending = nf.mult3 === c.L ? 'mult3' : nf.triple === c.L ? 'triple' : nf.div3 === c.L ? 'div3' : null;
  simulate(moments, p, 'greedy', hooks);
  _shadow.active = false;
  featurePending = null;

  // QA LVL-7: the guaranteed (newly unlocked) special's crate sits on the half of the lane the design line takes at the
  // gate the player is lining up for when the crate arrives (the next gate whose armed window it precedes or overlaps,
  // else the gate it follows), so a first-time player following the gates meets it
  if (guaranteedCrate) {
    const arrive = guaranteedCrate.at + SPAWN_DIST;
    let ref = null;
    for (let i = 0; i < G; i++) if (specs[i].arrival >= arrive) { ref = specs[i]; break; }
    if (ref && ref.arrival - arrive > -WORLD.gateArmZ + PICKUP_CLEAR_M) {
      let prev = null;
      for (let i = 0; i < G; i++) if (specs[i].arrival < arrive) prev = specs[i];
      if (prev) ref = prev;
    }
    if (!ref) ref = specs[G - 1];
    const centres = WORLD.laneCenters[ref.kind] || WORLD.laneCenters.pair;
    const lx = centres[clamp(ref.best | 0, 0, centres.length - 1)];
    guaranteedCrate.x = lx > 0.5 ? WORLD.laneCenters.pair[1] : lx < -0.5 ? WORLD.laneCenters.pair[0] : 0;
  }

  // --- assemble
  const events = [];
  let redHinted = false, singleHinted = false;
  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    if (m.kind !== 'gate') continue;
    const ev = m.ev;
    if (eventHasRed(ev)) {
      if (ev.layout === 'single' && !singleHinted) { ev.hint = 'single'; singleHinted = true; }
      else if (!redHinted) { ev.hint = 'red'; redHinted = true; }
    }
    events.push(ev);
  }
  for (let j = 0; j < waves.length; j++) events.push(waves[j]);
  for (let j = 0; j < intros.length; j++) events.push(intros[j]);
  for (let j = 0; j < crates.length; j++) events.push(crates[j]);
  for (let j = 0; j < coins.length; j++) events.push(coins[j]);
  events.push(runupEv);
  events.push(bossEv);
  events.sort((a, b) => a.at - b.at);                      // stable (QA LVL-25: the boss hint fires from boss:fight, no row)

  // the declared line IS the re-simulated design line of the finished events (validator parity)
  const trace = simulate(buildMoments(events, v), p, 'greedy', null);
  return {
    id: c.L, name: 'Level ' + L, seed, length: len, roadSpeed: v, eBoss: c.eBoss, line: 'greedy',
    expected: trace.samples, events,
  };
}

/**
 * Generated campaign level (L ≥ 2; L1 is authored in LEVELS.authored; L > LEVELS.curve.loopAfter uses the
 * loopAfter curve). Deterministic for (L, seed): the generator forks `seed` per attempt, re-rolls until
 * validateLevel().ok and otherwise returns the best-scoring attempt (fewest errors, then fewest warnings,
 * then closest cautious landing to E_boss).
 */
export function generateLevel(L, seed) {
  const gen = levelGenerator(L, seed);
  let script = null;
  while (script === null) script = gen.step();
  return script;
}

/**
 * Round-2 cross-group (UI-19 / LVL-18 follow-up): generateLevel as resumable steps, one generation attempt
 * (buildAttempt + validateLevel) per step(), so level.js's idle prefetch can spread a generation over several idle
 * callbacks instead of one 100+ ms task. step() returns null while more attempts are due and the chosen script once
 * finished (and on every later call). The attempt order, forks and stop rules are exactly generateLevel's, so the
 * result is identical (validate-levels' determinism check covers both).
 */
export function levelGenerator(L, seed) {
  const Ln = Math.max(1, Math.floor(Number.isFinite(L) ? L : 1));
  const c = curve(Ln);
  const seedU = (Number.isFinite(seed) ? seed : LEVELS.seedBase + Ln) >>> 0;
  const base = new Rng(seedU);
  let best = null;
  let k = 0;
  let done = false;
  return {
    get done() { return done; },
    step() {
      if (done) return best.script;
      const rng = base.fork(FORK_ATTEMPT_BASE + k * FORK_ATTEMPT_STEP);
      const script = buildAttempt(Ln, seedU, c, rng);
      const res = validateLevel(script);
      const ratio = res.designFinal > 0 ? res.designFinal / c.eBoss : 1e-6;
      // QA LVL-27: a weak-shooter line under CAUTIOUS_FLOOR costs an attempt more than a plain warning
      const score = res.errors.length * 10 + res.warnings.length * 0.05 + (res.weakLow ? 1 : 0) + (res.noSteerHigh ? NO_STEER_PENALTY : 0) + Math.abs(Math.log(ratio));
      if (best === null || score < best.score) best = { script, score, ok: res.ok, noSteerHigh: !!res.noSteerHigh, weakLow: !!res.weakLow };
      if (res.ok && res.warnings.length === 0) done = true;
      else if (res.ok && !(best.noSteerHigh) && !(best.weakLow) && k >= GEN_ATTEMPTS / 4 - 1) done = true;   // a valid script with warnings: a few more tries for a clean one (round-3: more while the no-steer line is too high; round 5: or the weak line is under CAUTIOUS_FLOOR)
      k++;
      if (k >= (best.weakLow ? GEN_ATTEMPTS_WEAK : GEN_ATTEMPTS)) done = true;   // round 5: a weak-line shortfall gets the longer budget
      return done ? best.script : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Endless mode (GDD §10.1; ARCH §6.16 "Endless", §6.17 generateChunk)
// ---------------------------------------------------------------------------------------------

/** Gate events in endless chunk D (GDD §10.1: 3 while D ≤ gatesSwitch, then 2). */
function endlessGates(D) {
  const e = LEVELS.endless;
  return D <= e.gatesSwitch ? e.gates[0] : e.gates[1];
}

/**
 * Per-chunk parameters for difficulty index D (1-based): speed, E(z) (unrounded, the same formula the level
 * runner uses for expectedSquad()), gate/wave counts, population, mini-boss data and the campaign-equivalent
 * level (endlessUnlock + D, capped at LEVELS.count for type weights; leak bands beyond L30 equal L30's).
 */
export function endlessParams(D) {
  const e = LEVELS.endless;
  const Dn = Math.max(1, Math.floor(Number.isFinite(D) ? D : 1));
  const v = Math.min(e.speed.cap, e.speed.base + e.speed.per * Dn);
  const E = Math.min(e.e.cap, e.e.base * Math.pow(e.e.growth, Dn));
  // round-3 QA LVL-17 (GDD §10.1): gate values stop growing once the pressure starts — gates are sized from E(min(D, gateEMaxD))
  // while waves keep E(D) × the pressure, so no squad out-gains the horde for ever
  const gD = e.gateEMaxD > 0 ? Math.min(Dn, e.gateEMaxD) : Dn;
  const eGate = Math.min(e.e.cap, e.e.base * Math.pow(e.e.growth, gD));
  const gates = endlessGates(Dn);
  // round 5d (GDD §10.1): past the cap a second, slower ramp — from waves.extraFromD one more wave per extraEveryD chunks
  // (≤ extraCap more): the horde keeps growing in numbers once a wave has saturated its pool share (absent keys: no extra)
  const wx = e.waves;
  const extra = (wx.extraFromD > 0 && Dn >= wx.extraFromD) ? Math.min(wx.extraCap > 0 ? wx.extraCap : Infinity, 1 + Math.floor((Dn - wx.extraFromD) / Math.max(1, wx.extraEveryD | 0))) : 0;
  const waves0 = Math.min(wx.cap > 0 ? wx.cap : Infinity, wx.base + wx.per4 * Math.floor(Dn / 4)) + extra;   // 2 + floor(D/4), ≤ cap (round-3 QA LVL-17), + extra
  // QA LVL-17: the population keeps growing past the campaign's 24 (count-independent ramp, LEVELS.endless.pop.cap)
  const popBase = Math.min(e.pop.cap, e.pop.base + e.pop.per * Dn);
  // round 5d (GDD §10.1): the pressure's population part (p^popShare) is baked here — the chunk's waves carry the real counts,
  // so the validator's pool overlap check sees them and the level runner multiplies nothing at spawn (each type still ≤ a
  // quarter of its pool, generateChunk); with the per-zombie HP cap (endlessHpCap) the numbers ARE the ramp
  const popShare = e.pressure && e.pressure.popShare >= 0 ? e.pressure.popShare : 1;
  const pop = Math.max(1, Math.round(popBase * Math.pow(endlessPressure(Dn), popShare)));
  const miniBoss = Dn % e.miniBossEvery === 0;
  // r5c: the mini-boss's chunk gives up miniBossWaveCut of its waves (the horde gives way to the set piece)
  const wavesBase = miniBoss ? Math.max(0, waves0 - num(e.miniBossWaveCut, 0)) : waves0;
  const afterMiniBoss = Dn > 1 && (Dn - 1) % e.miniBossEvery === 0;     // r5c: the chunk the mini-boss fight runs into
  // round 5d (pool-safe ramp, GDD §10.1 / docs/build/r5d-endless.md): the chunk owes pop × wavesBase zombies, and a wave carries at
  // most a pool share of every type (WAVE_POOL_SHARE; Σ = WAVE_POOL_CAPACITY, 65) — so once pop exceeds that, the owed population
  // spreads over more, smaller waves: up to waves.maxPerChunk and never closer than waves.minSpacingM between contacts inside the
  // chunk's wave window (endlessWaveWindow; the mini-boss chunk's 40-m window and the chunk after it keep their counts). Without
  // the keys the counts stay and the excess is dropped (the pre-5d rule). Either way generateChunk's pool fit (fitEndlessPools)
  // keeps every moment of the chunk inside pool − poolReserve, so the validator's pool check passes by construction.
  const need = pop * wavesBase;
  let waves = wavesBase;
  if (ENDLESS_WAVES_MAX > 0 && wavesBase > 0 && need > WAVE_POOL_CAPACITY * wavesBase) {
    const win = endlessWaveWindow(miniBoss, afterMiniBoss, _win);
    const bySpacing = ENDLESS_WAVE_SPACING_M > 0 ? Math.floor((win.hi - win.lo) / ENDLESS_WAVE_SPACING_M) : Infinity;
    waves = clamp(Math.ceil(need / WAVE_POOL_CAPACITY), wavesBase, Math.max(wavesBase, Math.min(ENDLESS_WAVES_MAX, bySpacing)));
  }
  const popWave = waves > 0 ? Math.max(1, Math.ceil(need / waves)) : pop;
  const Leq = Math.min(LEVELS.count, LEVELS.endlessUnlock + Dn);
  const band = bandFor(LEVELS.endlessUnlock + Dn);
  const rot = BOSSES.endlessRotation;
  return {
    D: Dn, v, e: E, eGate, gates, waves, pop, popBase, miniBoss, afterMiniBoss, Leq, band, bandMid: (band[0] + band[1]) / 2, bandIdx: bandIndexFor(Leq), chunk: e.chunk,
    // round 5d: the pre-5d wave count, the population the chunk owes (pop × wavesBase) and the population per wave it spreads it over
    wavesBase, need, popWave,
    hpCap: endlessHpCap(E, 1, {}),   // round 5d: the per-zombie HP ceiling of the chunk at base ranks (validator table)
    // round-3 QA LVL-17: the most one gate may add (+ lane cap, − lane flip, × lane gain at spawn): gainCapFrac·eGate, shrinking
    // with the pressure (^gainShare) — gains stay bounded while the horde grows, so every run ends
    gainCap: e.gainCapFrac > 0 ? Math.max(GEN.minValue, Math.round(e.gainCapFrac * eGate / Math.pow(endlessPressure(Dn), e.pressure && e.pressure.gainShare > 0 ? e.pressure.gainShare : 0))) : Infinity,
    miniBossArchetype: miniBoss ? rot[(Dn / e.miniBossEvery - 1) % rot.length] : null,
    miniBossHp: miniBoss ? roundBossHp(e.miniBossHpPerE * E) : 0,
    newest: newestType(Leq),
  };
}

/**
 * Round 5d: the wave-contact window of an endless chunk in road metres from its start — contacts land waveAfterGateM past `lo`,
 * evenly up to `hi`, never past `limit` (the mini-boss lead): the r5c spans of generateChunk (the mini-boss chunk keeps its last
 * SPAWN_DIST + waveAfterGateM for the fight and miniBossLeadM clear before it; the chunk after it holds its waves miniBossTailM),
 * shared with endlessParams' wave-frequency rule. `spanLo` / `spanHi` = the gate-arrival span. Writes `out`.
 */
function endlessWaveWindow(miniBoss, afterMiniBoss, out) {
  const e = LEVELS.endless, cc = LEVELS.curve;
  const spanLo = SPAWN_DIST;
  const spanHi = miniBoss ? e.chunk - SPAWN_DIST - cc.waveAfterGateM : e.chunk - cc.waveAfterGateM;
  const lead = miniBoss ? num(e.miniBossLeadM, 0) : 0;
  out.spanLo = spanLo;
  out.spanHi = spanHi;
  out.lo = spanLo + (afterMiniBoss ? num(e.miniBossTailM, 0) : 0);
  out.hi = Math.max(out.lo + 1, spanHi - lead);
  out.limit = lead > 0 ? e.chunk - SPAWN_DIST - lead : Infinity;
  return out;
}
const _win = { spanLo: 0, spanHi: 0, lo: 0, hi: 0, limit: 0 };

/**
 * Round-3 QA LVL-17 (GDD §10.1): the endless pressure factor (1 + perD)^max(0, D − fromD) of chunk D — multiplies wave
 * HP (^hpShare), wave population (^popShare) and mini-boss HP / attack kills (level.js); 1 without LEVELS.endless.pressure.
 */
export function endlessPressure(D) {
  const p = LEVELS.endless.pressure;
  if (!p || !(p.perD > 0)) return 1;
  return Math.pow(1 + p.perD, Math.max(0, (Number.isFinite(D) ? D : 1) - (p.fromD | 0)));
}

/**
 * Round-3 QA LVL-17: endless waves are designed for a squad of designMult·E(D) (the strong line sits above the curve, so a
 * squad that merely tracks E bleeds), ramped in linearly from ×1 at D1 to ×designMult at D = designRampD.
 */
export function endlessDesignMult(D) {
  const e = LEVELS.endless;
  const m = e.designMult > 0 ? e.designMult : 1;
  const ramp = e.designRampD > 1 ? e.designRampD : 1;
  const Dn = Number.isFinite(D) ? D : 1;
  return 1 + (m - 1) * clamp((Dn - 1) / Math.max(1e-6, ramp - 1), 0, 1);
}

/**
 * Round 5d (GDD §10.1 / §6.3, lead decision): the per-zombie HP ceiling of an endless wave / guard against the on-curve squad E —
 * LEVELS.endless.hpCapSeconds[type] × the design DPS E · FIRE.rateBase · FIRE.dmgBase · FIRE.accuracy · p^LEVELS.endless.profileExp
 * (p = the shop's fire rate × damage relative to base; 1 for the generator and the validator), never below LEAK_MODEL.minHp.
 * Endless death comes from growing numbers, never from a single zombie the squad cannot kill: a zombie in contact dies within
 * its cap seconds of focused on-curve fire. Every type key is written into `out`; a type without a cap (or an older data.js
 * without the key) gets Infinity, i.e. the round-3 solve. Allocation-free with `out`.
 */
export function endlessHpCap(E, p, out) {
  const res = out || {};
  const caps = LEVELS.endless.hpCapSeconds;
  const exp = LEVELS.endless.profileExp >= 0 ? LEVELS.endless.profileExp : 0;
  const pm = (Number.isFinite(p) && p > 0 && exp > 0) ? Math.pow(p, exp) : 1;
  const dps = Math.max(1, Number.isFinite(E) ? E : 1) * FIRE.rateBase * FIRE.dmgBase * FIRE.accuracy * pm;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    const s = caps ? caps[t] : undefined;
    res[t] = (Number.isFinite(s) && s > 0) ? Math.max(LEAK_MODEL.minHp, Math.round(s * dps)) : Infinity;
  }
  return res;
}
const _simCap = { walker: Infinity, runner: Infinity, crawler: Infinity, brute: Infinity, spitter: Infinity };

/** QA LVL-14 / LVL-15: boss minion HP = LEAK_MODEL.minionScale × the calibrated solve (in place; returns the record). */
function scaleMinions(hp) {
  const k = LEAK_MODEL.minionScale > 0 ? LEAK_MODEL.minionScale : 1;
  for (const t in hp) hp[t] = Math.max(LEAK_MODEL.minHp, Math.round(hp[t] * k));
  return hp;
}

/** Index of chunk D's first gate in the whole endless run (pacing alternation and the welcoming opener). */
function endlessGateBase(D) {
  let n = 0;
  for (let d = 1; d < D; d++) n += endlessGates(d);
  return n;
}

/**
 * Events for endless chunk D covering [startAt, startAt + LEVELS.endless.chunk), with ABSOLUTE `at` values.
 * Deterministic for (D, seed); the events are plain mutable objects (the level runner applies the rubber band
 * to the first gate event from the live count). Gates are sized to the chunk's E (chunk 1 is a warm-up: its
 * gates follow the cautious line from the campaign E_start up toward E(1), so a fresh squad is not met by
 * waves tuned for 159 soldiers); wave / guard HP is baked (`hp`) from the same E so the runner needs no
 * E-trace; every miniBossEvery-th chunk ends with a mini-boss (`mini: true`, HP = miniBossHpPerE·E, minionHp baked).
 */
export function generateChunk(D, seed, startAt) {
  const p = endlessParams(D);
  const seedU = (Number.isFinite(seed) ? seed : 1) >>> 0;
  const rng = new Rng(seedU).fork(FORK_CHUNK_BASE + p.D * FORK_CHUNK_STEP);
  const start = Number.isFinite(startAt) ? startAt : 0;
  const end = start + p.chunk;
  const cc = LEVELS.curve;
  const L = p.Leq, v = p.v;
  const warmup = p.D === 1;
  const g = { L, v, pop: p.pop, bandIdx: p.bandIdx, bandMid: p.bandMid };
  const events = [];

  // arrival span inside the chunk (a mini-boss keeps the last SPAWN_DIST + waveAfterGateM for its fight) and the wave window
  // (round 5d: endlessWaveWindow, shared with endlessParams' wave-frequency rule)
  const win = endlessWaveWindow(p.miniBoss, p.afterMiniBoss, _win);
  const spanLo = start + win.spanLo;
  const spanHi = start + win.spanHi;
  const span = Math.max(1, spanHi - spanLo);

  // gate specs
  const G = p.gates;
  const base = endlessGateBase(p.D);
  const specs = [];
  const arrivals = [];
  for (let i = 0; i < G; i++) {
    const at = Math.max(start, Math.round(spanLo + (i + 0.5) * span / G - SPAWN_DIST));
    specs.push(newSpec(base + i, at));
    arrivals.push(at + SPAWN_DIST);
  }

  // r5c (GDD §10.1): the mini-boss is a set piece, not the boss behind a wall of the horde's brutes — its chunk's waves make
  // contact at least LEVELS.endless.miniBossLeadM before the boss spawns (their span ends that much earlier) and the chunk after
  // it holds its waves miniBossTailM later, so the fight is the boss and its soak minions (0 / absent = the round-3 spans)
  const waveLo = start + win.lo;
  const waveHi = start + win.hi;
  const waveSpan = waveHi - waveLo;
  const waveLimit = start + win.limit;

  // waves: contacts evenly through the span, nudged to waveAfterGateM past a gate they would collide with
  const W = p.waves;
  // QA LVL-17: the brute / spitter share grows with D (× (1 + heavyPerD·D), renormalised) — a ramp independent of C
  const shares = waveSharesAt(L);
  const heavy = 1 + (LEVELS.endless.heavyPerD > 0 ? LEVELS.endless.heavyPerD : 0) * p.D;
  if (heavy !== 1) {
    shares[3] *= heavy; shares[4] *= heavy;
    let sum = 0;
    for (let i = 0; i < shares.length; i++) sum += shares[i];
    for (let i = 0; i < shares.length; i++) shares[i] /= sum;
  }
  // round 5d: each wave carries the chunk's per-wave population (endlessParams.popWave = the owed pop × wavesBase over the waves)
  const wctx = { L, P: p.popWave, W: W + 2, shares, newest: p.newest, crawlerDebt: 0, bruteDebt: 0 };
  const flags = { pack: false, swarm: false };
  const waves = [];
  for (let j = 0; j < W; j++) {
    const wj = warmup ? j : j + 1;                           // chunk 1 opens with a walkers-only line (GDD §6.2)
    const units = composeWaveUnits(wctx, wj, flags);
    // QA LVL-17: up to wavePoolShare (four) endless waves share the road — every type stays within that share of its pool;
    // round 5d: the pressured population (endlessParams.popWave) makes this bind from the mid chunks; a type's excess moves into
    // the other types' headroom (it used to become walkers only, and the walkers' own excess was dropped) and the pool fit below
    // (fitEndlessPools) keeps every moment of the chunk inside pool − poolReserve whatever the waves' overlap
    capWaveToPoolShare(units);
    const ev = decorateWave({ at: 0, type: 'wave', pattern: chooseWavePattern(rng, L, units, wj, flags.pack, flags.swarm), units }, rng);
    let contact = waveLo + cc.waveAfterGateM + (j + 0.5) * waveSpan / W;
    for (let i = 0; i < arrivals.length; i++) {
      if (Math.abs(contact - arrivals[i]) < cc.waveAfterGateM) { contact = arrivals[i] + cc.waveAfterGateM; break; }
    }
    if (contact > waveLimit) contact = waveLimit;              // r5c: the nudge never eats the mini-boss lead
    placeWave(ev, contact, v, start);                        // faster types spawn later (QA LVL-4b)
    waves.push(ev);
  }

  // specials (QA LVL-9): drawn from the bag unlocked at the chunk's equivalent level; about PICKUPS.gateShare of the
  // deliveries ride an item | +A gate (never the chunk's first gate — the rubber band may rewrite it), the rest a crate
  const bag = [];
  for (let i = 0; i < PICKUP_SCHEDULE.length && i < L; i++) bag.push(PICKUP_SCHEDULE[i]);
  const crateItems = [];
  for (let k = 0; k < ENDLESS_CRATES_PER_CHUNK; k++) {
    const item = rng.pick(bag);
    if (G > 1 && P_ITEMPLUS.w[p.bandIdx] > 0 && rng.chance(PICKUPS.gateShare)) {
      let slot = -1;
      for (let i = 1 + rng.int(0, G - 2); i < G && slot < 0; i++) if (!specs[i].item) slot = i;
      for (let i = 1; i < G && slot < 0; i++) if (!specs[i].item) slot = i;
      if (slot > 0) { specs[slot].item = item; continue; }
    }
    crateItems.push(item);
  }

  // sizing pass in arrival / contact order: chunk 1 runs the design line from E_start toward E(1); later chunks hold E(D)
  const moments = [];
  let order = 0;
  for (let i = 0; i < G; i++) moments.push({ d: arrivals[i], kind: 'gate', ev: null, idx: order++, spec: specs[i], E: 0, laneX: 0, gap: 0, n0: 0 });
  for (let j = 0; j < W; j++) moments.push({ d: waveContactAt(waves[j], v), kind: 'wave', ev: waves[j], idx: order++, spec: null, E: 0, laneX: 0, gap: 0, n0: unitStats(waves[j].units, _stats).n });
  moments.sort((a, b) => (a.d - b.d) || (a.idx - b.idx));
  annotateMoments(moments, p.bandMid);
  const gx = { g, tol: GAIN_TOL.early, last: false, prev: null, prev2: null, multi: base };
  let E = warmup ? curve(L).eStart : p.e;
  const Eg = warmup ? E : p.eGate;                           // round-3 QA LVL-17: gate sizing E (frozen from gateEMaxD on)
  let lastGateD = -Infinity, laneX = 0;                      // shield / lane of the gate before each wave (QA LVL-4)
  for (let k = 0; k < moments.length; k++) {
    const m = moments[k];
    if (m.kind === 'gate') {
      const s = m.spec;
      if (warmup) {
        const target = gateTarget(m, E, p.e);
        gx.tol = gainTolerance(m.gatesLeft);
        selectSpec(rng, s, E, target, gx);
      } else {
        for (let t = 0; t < SPEC_TRIES; t++) {                // plain bag roll at the gate E, re-rolled only for the pacing rules
          rollSpec(rng, s, L, Eg, p.bandIdx, s.item);
          s.rolled = true;
          ensureEligible(s, L, Eg);
          if (s.item || !violatesPacing(s, gx)) break;
        }
      }
      assignSide(s, gx);
      const ev = materializeGate(s, warmup ? E : Eg, L, v, p.pop, p.bandIdx, p.bandMid);
      if (ev.guards) for (let q = 0; q < ev.guards.length; q++) ev.guards[q].hp = solveWaveHp(E, v, ev.guards[q].units, p.bandMid);
      m.ev = ev;
      notePacing(gx, s);
      events.push(ev);
      const after = lineAfter(ev, E, v, p.bandMid, 'greedy');
      const centres = WORLD.laneCenters[ev.layout] || WORLD.laneCenters.pair;
      laneX = centres[clamp(_choice.idx, 0, centres.length - 1)];
      lastGateD = m.d;
      if (warmup) E = after;                                 // chunk 1 follows the design line (QA LVL-1)
    } else {
      const gap = m.d >= lastGateD ? m.d - lastGateD : Infinity;
      const wc = waveContext(m.ev.units, m.ev.pattern, m.ev.x, laneX, E, gap, {});
      m.ev.hp = solveWaveHp(E, v, m.ev.units, p.bandMid, null, wc);
      m.E = E; m.laneX = laneX; m.gap = gap;                 // round 5d: the pool fit below may re-solve this wave
      events.push(m.ev);
      if (warmup) E = Math.max(1, E - p.bandMid * unitStats(m.ev.units, _stats).bites);
    }
  }

  // round 5d (GDD §10.1): the chunk's waves fit the zombie pools by construction — at every moment of the validator's model each type
  // stays within pool − poolReserve counting the waves and the gate guards (fitEndlessPools); a trimmed wave's HP is re-solved on
  // the same line (same E, shield and lane) for its new units
  if (fitEndlessPools(waves, events, v) > 0) {
    for (let k = 0; k < moments.length; k++) {
      const m = moments[k];
      if (m.kind !== 'wave' || unitStats(m.ev.units, _stats).n === m.n0) continue;
      const wc = waveContext(m.ev.units, m.ev.pattern, m.ev.x, m.laneX, m.E, m.gap, {});
      m.ev.hp = solveWaveHp(m.E, v, m.ev.units, p.bandMid, null, wc);
    }
  }

  // specials and coin lines, evenly through the chunk and clear of gate arrivals / wave contacts (the whole schedule is unlocked)
  const obstacles = arrivals.slice();
  for (let j = 0; j < W; j++) obstacles.push(waveContactAt(waves[j], v));
  const lo = start + SPAWN_DIST, hi = spanHi;
  for (let k = 0; k < crateItems.length; k++) {
    const a = clearOfObstacles(start + (k + 1) * p.chunk / (crateItems.length + 1), obstacles, lo, hi);
    obstacles.push(a);
    events.push({ at: Math.max(start, Math.round(a - SPAWN_DIST)), type: 'crate', item: crateItems[k], x: rng.pick(WORLD.laneCenters.pair) });
  }
  for (let k = 0; k < ENDLESS_COIN_LINES_PER_CHUNK; k++) {
    const a = clearOfObstacles(start + (k + 1) * p.chunk / (ENDLESS_COIN_LINES_PER_CHUNK + 1) + cc.waveAfterGateM + PICKUP_CLEAR_M, obstacles, lo, hi);
    obstacles.push(a);
    events.push({ at: Math.max(start, Math.round(a - SPAWN_DIST)), type: 'coins', x: rng.pick(WORLD.laneCenters.pair), count: PICKUPS.coinLine.count });
  }

  // mini-boss at the chunk's end (no road slow-down, no letterbox — boss.spawn handles `mini`)
  if (p.miniBoss) {
    const arch = p.miniBossArchetype;
    events.push({
      at: Math.max(start, end - SPAWN_DIST), type: 'boss', id: 'boss.' + arch, archetype: arch, hp: p.miniBossHp, mini: true,
      minionHp: scaleMinions(solveWaveHp(p.e, v, endlessMinionUnits(arch), p.bandMid)),
    });
  }

  events.sort((a, b) => a.at - b.at);
  return events;
}

/**
 * Round 5d: clamps every type of an endless wave to its pool share (floor(pool / WAVE_POOL_SHARE)) and moves the excess into the
 * other types' headroom under the same shares — largest headroom first, ties in TYPES order (before round 5d a type's excess became
 * walkers and the walkers' own excess was dropped); what no type can take is dropped. Mutates `units`; returns the dropped count.
 */
function capWaveToPoolShare(units) {
  let excess = 0;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    const lim = Math.floor(ZOMBIES[t].pool / WAVE_POOL_SHARE);
    const n = units[t] | 0;
    if (n > lim) { units[t] = lim; excess += n - lim; }
  }
  while (excess > 0) {
    let best = -1, room = 0;
    for (let i = 0; i < TYPES.length; i++) {
      const r = Math.floor(ZOMBIES[TYPES[i]].pool / WAVE_POOL_SHARE) - (units[TYPES[i]] | 0);
      if (r > room) { room = r; best = i; }
    }
    if (best < 0) break;
    const add = Math.min(room, excess);
    units[TYPES[best]] = (units[TYPES[best]] | 0) + add;
    excess -= add;
  }
  return excess;
}

/**
 * Round 5d (GDD §10.1, docs/build/r5d-endless.md — "pool-safe by construction"): fits an endless chunk's waves to the zombie pools in
 * the validator's model (checkPoolOverlap: a zombie lives from its spawn distance to its contact, the live count peaks at spawn
 * moments) — at every moment each type stays within pool − poolReserve (endlessPoolReserve) counting the chunk's own waves and
 * its gate guards. Chunks never overlap in that model by construction (a wave's contact lies ≥ SPAWN_DIST + waveAfterGateM into
 * its chunk and every window is shorter than SPAWN_DIST, while the previous chunk's spans end by its end), which the validator's
 * whole-run check proves per seed. Two passes per type: the pile at the peak moment is thinned evenly (every wave alive there
 * scaled by one factor, floored; repeated while a peak remains), then an exact pass in spawn order clamps what rounding left
 * (the earlier waves alive at the spawn plus every guard squad the wave's life overlaps). Guards (≤ GUARDS.max walkers per gate)
 * are never trimmed; a wave is never emptied. `waves` = the chunk's wave events, `events` = every event so far (the gate events
 * carry the guards). Mutates the units in place; returns the number of zombies removed. Chunk generation only (event time).
 */
function fitEndlessPools(waves, events, v) {
  const W = waves.length;
  if (W === 0) return 0;
  const a = [], b = [], u = [];
  for (let j = 0; j < W; j++) { a.push(waves[j].at); b.push(waveContactAt(waves[j], v)); u.push(waves[j].units); }
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'gates' || !ev.guards) continue;
    for (let q = 0; q < ev.guards.length; q++) { a.push(ev.at); b.push(guardContactAt(ev.at, ev.guards[q].units, v)); u.push(ev.guards[q].units); }
  }
  const n = a.length;
  const order = [];
  for (let j = 0; j < W; j++) order.push(j);
  order.sort((x, y) => (a[x] - a[y]) || (x - y));
  let removed = 0;
  for (let ti = 0; ti < TYPES.length; ti++) {
    const t = TYPES[ti];
    const budget = ZOMBIES[t].pool - POOL_RESERVE[t];
    // pass 1: even thinning of the pile at the peak moment, while a peak exceeds the budget (the floors converge in a few rounds)
    for (let round = 0; round < 8; round++) {
      let peak = 0, at = 0;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < n; k++) if (a[k] <= a[i] && b[k] >= a[i]) sum += u[k][t] | 0;
        if (sum > peak) { peak = sum; at = a[i]; }
      }
      if (peak <= budget) break;
      let waveSum = 0, guardSum = 0;
      for (let k = 0; k < n; k++) {
        if (a[k] > at || b[k] < at) continue;
        if (k < W) waveSum += u[k][t] | 0; else guardSum += u[k][t] | 0;
      }
      if (waveSum <= 0) break;
      const f = Math.max(0, budget - guardSum) / waveSum;
      for (let k = 0; k < W; k++) {
        if (a[k] > at || b[k] < at) continue;
        const was = u[k][t] | 0;
        if (was <= 0) continue;
        const now = Math.floor(was * f);
        removed += was - now;
        if (now > 0) u[k][t] = now; else delete u[k][t];
      }
    }
    // pass 2 (exact, the validator's peaks): in spawn order, room = budget − the most that is alive beside this wave at its own
    // spawn or at a guard spawn during its life, counting the earlier waves and the guards alive at that moment (a later wave
    // subtracts this one itself when its turn comes)
    for (let oi = 0; oi < W; oi++) {
      const j = order[oi];
      const nj = u[j][t] | 0;
      if (nj <= 0) continue;
      let alive = 0;
      for (let i = W - 1; i < n; i++) {                        // i = W − 1 stands for the wave's own spawn moment
        const m = i === W - 1 ? a[j] : a[i];
        if (m < a[j] || m > b[j]) continue;
        let sum = 0;
        for (let ok = 0; ok < oi; ok++) { const k = order[ok]; if (a[k] <= m && b[k] >= m) sum += u[k][t] | 0; }
        for (let k = W; k < n; k++) if (a[k] <= m && b[k] >= m) sum += u[k][t] | 0;
        if (sum > alive) alive = sum;
      }
      const room = budget - alive;
      if (nj > room) {
        const now = Math.max(0, room);
        removed += nj - now;
        if (now > 0) u[j][t] = now; else delete u[j][t];
      }
    }
  }
  // a wave is never emptied (validateUnits: 'units are empty'); the walker it keeps is covered by the reserve
  for (let j = 0; j < W; j++) if (unitStats(u[j], _stats).n === 0) { u[j].walker = 1; removed--; }
  return removed;
}

/**
 * Worst-case count after a squad of `count` passes `ev` (QA LVL-17): the best lane shot with a full armed window at the
 * intake cap (bucket included). Allocation-free.
 */
export function eventWorstCase(ev, count, v) {
  if (!ev || !ev.lanes) return count;
  const hits = windowCapacity(v);
  let best = count;
  for (let i = 0; i < ev.lanes.length; i++) {
    const out = laneOutcome(ev.lanes[i], count, hits);
    if (out > best) best = out;
  }
  return best;
}

/**
 * Endless rubber band at EVERY gate event (QA LVL-17, GDD §10.1 amendment), applied by the level runner when the event
 * spawns and by the validator's endless line. `count` = the live count, `worst` = the worst-case count once the events
 * still ahead of this one have been passed (eventWorstCase chained), `E` = E(D), `v` = the chunk's road speed, `fire` =
 * the squad's fire rate (profile; base when omitted), `gainCap` = endlessParams(D).gainCap.
 *  - every lane is scaled by one factor so the best adds at most gainCap at the live count with a full window ('cap');
 *  - worst > keepMult·E → the × lanes become small + lanes and every + lane is capped at min(plusCapFrac·E, highMult·E −
 *    the worst case before this event) — 'keep': gate values stop growing past the E cap;
 *  - else nothing (null). Round-3 QA LVL-17: the 'high' ÷2 | ÷2 pull-back is gone (the rubber band only helps on the low
 *    side; the endless pressure ends the run). Mutates `ev` in place.
 */
export function endlessGateGuard(ev, count, worst, E, v, fire, before, gainCap) {
  if (!ev || ev.type !== 'gates' || !Array.isArray(ev.lanes) || Object.isFrozen(ev)) return null;
  const e = LEVELS.endless;
  const r = e.rubber;
  // round-3 QA LVL-17 (GDD §10.1): gate values stop growing past the E cap — no lane adds more than `gainCap`
  // (endlessParams(D).gainCap = gainCapFrac·E(gateEMaxD) / pressure^gainShare; gainCapFrac·E without it), whatever the squad;
  // the pressure (not a ÷ gate) is what ends a run
  let capped = null;
  const gcap = gainCap > 0 ? gainCap : (e.gainCapFrac > 0 ? Math.max(GEN.minValue, Math.round(e.gainCapFrac * E)) : Infinity);
  if (Number.isFinite(gcap) && count > 0) {
    // the most each lane can add at the live count with a full armed window; when the best exceeds the cap every lane is
    // scaled by the same factor, so the better lane stays the better one (lane choice keeps its weight under the cap)
    const speed = Number.isFinite(v) && v > 0 ? v : e.speed.base;
    const hits = windowCapacity(speed);
    let best = 0;
    const gains = _laneGains;
    for (let i = 0; i < ev.lanes.length; i++) {
      const ln = ev.lanes[i];
      gains[i] = ln.op === 'item' ? 0 : Math.max(0, laneOutcome(ln, count, hits) - count);
      if (gains[i] > best) best = gains[i];
    }
    if (best > gcap) {
      const k = gcap / best;
      capped = [];
      for (let i = 0; i < ev.lanes.length; i++) {
        const ln = ev.lanes[i];
        if (ln.op === '+') {
          const value = Math.max(GEN.minValue, Math.round(ln.value * k));
          capped.push({ op: '+', value, cap: Math.max(value, Math.round(Math.min(ln.cap, gains[i]) * k)) });
        } else if (ln.op === '-') {
          capped.push({ op: '-', value: ln.value, flipCap: Math.max(1, Math.round(Math.min(ln.flipCap, gains[i]) * k)) });
        } else if (ln.op === 'x' && gains[i] > 0) {
          // a × lane on a big squad becomes the + lane worth its scaled gain
          const capX = Math.max(GEN.minValue, Math.round(gains[i] * k));
          const value = designValue(Math.max(GEN.minValue, capX / GATE_RULES.plus.capMult));
          capped.push({ op: '+', value: Math.min(value, capX), cap: capX });
        } else if (ln.op === '/' && ln.cap > 1) {
          capped.push({ op: '/', value: ln.value, cap: 1, step: ln.step });   // the x2 flip is a doubling too
        } else capped.push(ln);
      }
      ev.lanes = capped;
    }
  }
  if (worst > e.keepMult * E) {
    // the + lanes never carry the squad past the high threshold: room = highMult·E − the worst case before this event
    const room = Number.isFinite(before) ? r.highMult * E - before : e.plusCapFrac * E;
    const capMax = Math.max(GEN.minValue, Math.round(Math.min(e.plusCapFrac * E, room, gcap)));
    const lanes = [];
    let changed = false;
    for (let i = 0; i < ev.lanes.length; i++) {
      const ln = ev.lanes[i];
      if (ln.op === 'x') {
        // a × lane becomes a small + lane (capped at plusCapFrac·E) — still the "bet" side, never a runaway
        const value = designValue(Math.max(GEN.minValue, capMax / GATE_RULES.plus.capMult));
        lanes.push({ op: '+', value, cap: Math.min(capMax, Math.max(GATE_RULES.plus.capMin, GATE_RULES.plus.capMult * value)) });
        changed = true;
      } else if (ln.op === '+' && ln.cap > capMax) {
        const value = Math.min(ln.value, capMax);
        lanes.push({ op: '+', value, cap: Math.max(value, capMax) });
        changed = true;
      } else if (ln.op === '/' && ln.cap > 1) {
        // a ÷ lane's x2 flip is a doubling as well: keep the lesser evil, drop the flip
        lanes.push({ op: '/', value: ln.value, cap: 1, step: ln.step });
        changed = true;
      } else if (ln.op === '-' && ln.flipCap > capMax) {
        // round-3 QA LVL-17: a − lane shot blue gains at most the same capped amount
        lanes.push({ op: '-', value: ln.value, flipCap: capMax });
        changed = true;
      } else lanes.push(ln);
    }
    if (!changed) return capped ? 'cap' : null;
    ev.lanes = lanes;
    return 'keep';
  }
  return capped ? 'cap' : null;
}

/**
 * QA LVL-17 (validator, tools/validate-levels.js): the endless run of a full-intake greedy player with shop rank `rank`
 * (squad / fire rate / damage), replayed with the level runner's live rules — every gate event passes the rubber band
 * (endlessGateGuard against the live count and the worst case of the events still ahead) when it spawns, the best lane
 * is shot with the full window intake when it arrives, and every wave's baked HP is re-scaled at spawn like
 * level._liveHpMult (p^profileExp, E_eff = max(E(D), C), the endless band per D) and bites leak·Σbite at contact.
 * Mini-boss fights are not modelled. Returns { boundaries: [{ D, C, E, ratio }], diedAt, gateLabels, guards }.
 */
export function simulateEndless(seed, chunks, rank) {
  const e = LEVELS.endless;
  const pr = profileAt(rank | 0);
  const base = profileAt(0);
  const dpsMult = (pr.fire * pr.dmg) / (base.fire * base.dmg);
  const pexp = e.profileExp >= 0 ? e.profileExp : LEAK_MODEL.profileExp;
  const profMult = pexp > 0 ? Math.pow(dpsMult, pexp) : 1;
  const live = e.liveExp >= 0 ? e.liveExp : 1;
  const acts = [];
  for (let D = 1; D <= chunks; D++) {
    const evs = generateChunk(D, seed, (D - 1) * e.chunk);
    const p = endlessParams(D);
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (ev.type === 'gates') {
        acts.push({ d: ev.at, k: 0, kind: 'gspawn', ev, p });
        acts.push({ d: ev.at + SPAWN_DIST, k: 1, kind: 'gpass', ev, p });
      } else if (ev.type === 'wave') {
        acts.push({ d: ev.at, k: 0, kind: 'wspawn', ev, p });
        acts.push({ d: waveContactAt(ev, p.v), k: 1, kind: 'wcontact', ev, p });
      }
    }
  }
  for (let D = 2; D <= chunks + 1; D++) acts.push({ d: (D - 1) * e.chunk, k: -1, kind: 'boundary', D });
  acts.sort((a, b) => (a.d - b.d) || (a.k - b.k));
  let C = Math.max(pr.s0, 1);
  const pending = [];
  const boundaries = [];
  const gateLabels = [];
  const guards = { high: 0, keep: 0, cap: 0 };
  let diedAt = -1;
  const hp = new Map();
  for (let i = 0; i < acts.length && diedAt < 0; i++) {
    const a = acts[i];
    if (a.kind === 'boundary') {
      const E = endlessParams(a.D).e;
      boundaries.push({ D: a.D, C: Math.round(C), E: Math.round(E), ratio: C / E });
      continue;
    }
    const p = a.p;
    if (a.kind === 'gspawn') {
      for (let k = pending.length - 1; k >= 0; k--) if (pending[k].at + SPAWN_DIST <= a.d) pending.splice(k, 1);
      let worst = C;
      for (let k = 0; k < pending.length; k++) worst = eventWorstCase(pending[k], worst, p.v);
      const before = worst;
      worst = eventWorstCase(a.ev, worst, p.v);
      const res = endlessGateGuard(a.ev, C, worst, p.e, p.v, pr.fire, before, p.gainCap);
      if (res) guards[res]++;
      pending.push(a.ev);
    } else if (a.kind === 'gpass') {
      const hits = lineHits('max', C, p.v, pr.fire);
      let best = -Infinity, label = '';
      for (let k = 0; k < a.ev.lanes.length; k++) {
        const out = laneOutcome(a.ev.lanes[k], C, hits);
        if (out > best) { best = out; label = laneLabel(a.ev.lanes[k]); }
      }
      gateLabels.push(a.ev.lanes.map(laneLabel).join(' | ') + ' → ' + label);
      C = Math.max(1, Math.min(GATE_RULES.generation.maxValue * 100, best));
    } else if (a.kind === 'wspawn') {
      const leak = Math.max(p.bandMid, Math.min(e.bandMax > 0 ? e.bandMax : p.bandMid, p.bandMid + (e.bandPerD > 0 ? e.bandPerD : 0) * p.D));
      const pz = e.pressure;
      const kp = endlessPressure(p.D);
      const mult = profMult * (C > p.e && live > 0 ? Math.pow(C / p.e, live) : 1) * endlessDesignMult(p.D)
        * (survivorFactor(p.bandMid) / survivorFactor(leak)) * (leakCalib(leak) / leakCalib(p.bandMid))
        * Math.pow(kp, pz && pz.hpShare >= 0 ? pz.hpShare : 1);
      const t = {};
      // round 5d: the chunk's per-zombie HP cap at E(D) with the profile's fire × damage (as level._capEndlessHp)
      const cap = endlessHpCap(p.e, dpsMult, _simCap);
      for (const k in a.ev.hp) t[k] = Math.min(cap[k] !== undefined ? cap[k] : Infinity, Math.max(LEAK_MODEL.minHp, Math.round(a.ev.hp[k] * mult)));
      // round-3 QA LVL-17: the live crowd (min(crowdMax, √(C/E)) above E); round 5d: the pressure's population part is baked
      // into the units by endlessParams, so it no longer multiplies here
      const crowd = (C > p.e && e.crowdMax > 1 ? Math.min(e.crowdMax, Math.sqrt(C / p.e)) : 1);
      hp.set(a.ev, { hp: t, leak, crowd });
    } else if (a.kind === 'wcontact') {
      const st = unitStats(a.ev.units, _stats);
      const bites = st.bites;
      const rec = hp.get(a.ev);
      const leak = expectedLeak(C * dpsMult, p.v, a.ev.units, rec ? rec.hp : a.ev.hp, 1, null, rec ? rec.leak : p.bandMid);
      C -= leak * bites * (rec && rec.crowd > 0 ? rec.crowd : 1);
      if (C < 1) diedAt = a.d;
    }
  }
  return { boundaries, diedAt, gateLabels, guards };
}

// ---------------------------------------------------------------------------------------------
// validateLevel — shape, caps, pools, spacing, E-trace window, Σ EV, leak bands (ARCH §6.17)
// ---------------------------------------------------------------------------------------------

const _laneGains = [0, 0, 0];

/** Short human label for a lane ("+12 (cap 48)", "x2 (step 36)", "−40 (flip 40)", "÷2 (step 17)", "item weapon.shotgun"). */
export function laneLabel(lane) {
  if (!lane || typeof lane !== 'object') return '?';
  switch (lane.op) {
    case '+': return `+${lane.value} (cap ${lane.cap})`;
    case '-': return `−${lane.value} (flip ${lane.flipCap})`;
    case 'x': return `x${lane.value} (step ${lane.step}, cap x${lane.cap})`;
    case '/': return `÷${lane.value} (step ${lane.step})`;
    case 'item': return `item ${lane.item}`;
    default: return `?${lane.op}`;
  }
}

/** Compact unit record: "6 walker + 2 runner". */
function unitsLabel(units) {
  const parts = [];
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    if ((units[t] | 0) > 0) parts.push(`${units[t]} ${t}`);
  }
  return parts.join(' + ');
}

/** QA LVL-34: the declared value in force just before distance `d` (the last sample strictly before it, step reading). */
function declaredBefore(expected, d) {
  let e = expected.length ? expected[0].e : 1;
  for (let i = 0; i < expected.length; i++) { if (expected[i].at < d - 0.5) e = expected[i].e; else break; }
  return e;
}

/** Linear interpolation of an expected[] table at distance `at` (clamped at both ends). */
function interpExpected(expected, at) {
  if (expected.length === 0) return 1;
  if (at <= expected[0].at) return expected[0].e;
  for (let i = 1; i < expected.length; i++) {
    const a = expected[i - 1], b = expected[i];
    if (at <= b.at) {
      if (b.at === a.at) return b.e;
      return a.e + (b.e - a.e) * (at - a.at) / (b.at - a.at);
    }
  }
  return expected[expected.length - 1].e;
}

function validateUnits(units, tag, errors, warnings) {
  if (!units || typeof units !== 'object') { errors.push(`${tag}: units missing`); return 0; }
  let total = 0;
  for (const k in units) {
    if (TYPES.indexOf(k) === -1) { errors.push(`${tag}: unknown zombie type '${k}'`); continue; }
    const n = units[k];
    if (!Number.isInteger(n) || n < 0) { errors.push(`${tag}: units.${k} must be a non-negative integer`); continue; }
    if (n > ZOMBIES[k].pool) errors.push(`${tag}: units.${k} = ${n} exceeds the ${k} pool (${ZOMBIES[k].pool})`);
    total += n;
  }
  if (total < 1) errors.push(`${tag}: units are empty`);
  if (total > ZOMBIES.common.maxLive) errors.push(`${tag}: ${total} zombies exceed maxLive ${ZOMBIES.common.maxLive}`);
  return total;
}

function validateHp(hp, units, tag, errors, warnings) {
  if (hp === undefined) return;
  if (!hp || typeof hp !== 'object') { errors.push(`${tag}: hp must be a record`); return; }
  for (const k in units) {
    if ((units[k] | 0) > 0 && !(Number.isFinite(hp[k]) && hp[k] >= LEAK_MODEL.minHp)) warnings.push(`${tag}: hp.${k} missing or < ${LEAK_MODEL.minHp}`);
  }
}

function validateLane(lane, tag, errors, warnings, authored) {
  if (!lane || typeof lane !== 'object') { errors.push(`${tag}: lane is not an object`); return; }
  const op = lane.op;
  if (op === 'item') {
    if (typeof lane.item !== 'string' || PICKUPS.items.indexOf(lane.item) === -1) errors.push(`${tag}: item lane has an unknown item '${lane.item}'`);
    return;
  }
  if (op !== '+' && op !== '-' && op !== 'x' && op !== '/') { errors.push(`${tag}: unknown op '${op}'`); return; }
  if (!Number.isFinite(lane.value)) { errors.push(`${tag}: ${op} lane has no value`); return; }
  if (op === '+' || op === '-') {
    if (lane.value < 1) errors.push(`${tag}: ${op}${lane.value} value must be ≥ 1`);
    else if (lane.value < GEN.minValue && !authored) warnings.push(`${tag}: ${op}${lane.value} below minValue ${GEN.minValue}`);
    if (lane.value > GEN.maxValue) errors.push(`${tag}: ${op}${lane.value} above maxValue ${GEN.maxValue}`);
  }
  if (op === '+') {
    if (!Number.isFinite(lane.cap)) errors.push(`${tag}: +${lane.value} lane has no cap (mandatory, D19)`);
    else if (lane.cap < lane.value) errors.push(`${tag}: +${lane.value} cap ${lane.cap} below its value`);
  } else if (op === '-') {
    if (!Number.isFinite(lane.flipCap)) errors.push(`${tag}: −${lane.value} lane has no flipCap (mandatory, D19)`);
    else if (lane.flipCap < 1) errors.push(`${tag}: −${lane.value} flipCap must be ≥ 1`);
  } else if (op === 'x') {
    if (lane.value < GATE_RULES.mult.base) errors.push(`${tag}: x${lane.value} multiplier below ${GATE_RULES.mult.base}`);
    if (!Number.isFinite(lane.cap)) errors.push(`${tag}: x${lane.value} lane has no cap (mandatory, D19)`);
    else if (lane.cap < lane.value) errors.push(`${tag}: x${lane.value} cap x${lane.cap} below its base`);
    if (!(Number.isFinite(lane.step) && lane.step >= 1)) errors.push(`${tag}: x${lane.value} lane needs step ≥ 1 (mandatory, D19)`);
  } else {
    const ladder = GATE_RULES.div.ladder;
    if (ladder.indexOf(lane.value) === -1 || lane.value === ladder[ladder.length - 1]) errors.push(`${tag}: ÷${lane.value} is not on the ladder ${ladder.join('→')}`);
    if (!(Number.isFinite(lane.cap) && lane.cap >= 1)) errors.push(`${tag}: ÷${lane.value} lane has no cap (mandatory, D19)`);
    if (!(Number.isFinite(lane.step) && lane.step >= 1)) errors.push(`${tag}: ÷${lane.value} lane needs step ≥ 1 (mandatory, D19)`);
  }
}

function validateGatesEvent(ev, tag, errors, warnings, authored) {
  const n = LANE_COUNT[ev.layout];
  if (n === undefined) { errors.push(`${tag}: unknown layout '${ev.layout}'`); return; }
  if (!Array.isArray(ev.lanes)) { errors.push(`${tag}: lanes missing`); return; }
  if (ev.lanes.length !== n) errors.push(`${tag}: layout '${ev.layout}' needs ${n} lanes, found ${ev.lanes.length}`);
  for (let i = 0; i < ev.lanes.length; i++) {
    validateLane(ev.lanes[i], `${tag} lane ${i}`, errors, warnings, authored);   // QA LVL-34: authored values are the GDD's
    const lane = ev.lanes[i];
    if (lane && lane.hintOnHit !== undefined && !HINTS[lane.hintOnHit]) errors.push(`${tag} lane ${i}: unknown hintOnHit '${lane.hintOnHit}'`);
    if (lane && lane.hintOnPass !== undefined && !(lane.hintOnPass && HINTS[lane.hintOnPass.id])) errors.push(`${tag} lane ${i}: unknown hintOnPass`);
    if (lane && lane.hintIfOtherBetter !== undefined && !HINTS[lane.hintIfOtherBetter]) errors.push(`${tag} lane ${i}: unknown hintIfOtherBetter '${lane.hintIfOtherBetter}'`);
  }
  if (ev.hint !== undefined && !HINTS[ev.hint]) errors.push(`${tag}: unknown hint '${ev.hint}'`);
  if (ev.guards !== undefined) {
    if (!Array.isArray(ev.guards)) { errors.push(`${tag}: guards must be an array`); return; }
    for (let g = 0; g < ev.guards.length; g++) {
      const gd = ev.guards[g];
      const gtag = `${tag} guard ${g}`;
      if (!gd || !Number.isInteger(gd.lane) || gd.lane < 0 || gd.lane >= ev.lanes.length) { errors.push(`${gtag}: lane index out of range`); continue; }
      validateUnits(gd.units, gtag, errors, warnings);
      validateHp(gd.hp, gd.units || {}, gtag, errors, warnings);
    }
  }
}

function validateWaveEvent(ev, tag, L, endless, errors, warnings, authored) {
  if (!WAVE_PATTERNS[ev.pattern]) errors.push(`${tag}: unknown pattern '${ev.pattern}'`);
  else if (!endless && L > 0 && WAVE_PATTERNS[ev.pattern].minLevel !== undefined && L < WAVE_PATTERNS[ev.pattern].minLevel) {
    warnings.push(`${tag}: pattern '${ev.pattern}' unlocks at L${WAVE_PATTERNS[ev.pattern].minLevel}`);
  }
  const total = validateUnits(ev.units, tag, errors, warnings);
  validateHp(ev.hp, ev.units || {}, tag, errors, warnings);
  if (ev.hpMult !== undefined && !(ev.hpMult > 0)) errors.push(`${tag}: hpMult must be > 0`);
  if (ev.hint !== undefined && !HINTS[ev.hint]) errors.push(`${tag}: unknown hint '${ev.hint}'`);
  if (ev.hintOnLoss !== undefined && !HINTS[ev.hintOnLoss]) errors.push(`${tag}: unknown hintOnLoss '${ev.hintOnLoss}'`);
  if (ev.x !== undefined && !(Math.abs(ev.x) <= WORLD.roadWidth / 2)) errors.push(`${tag}: x off the road`);
  if (!endless && !authored && L > 0 && ev.units) {   // QA LVL-34: unlock levels bind the generator, not the authored GDD §11 script
    for (const k in ev.units) if ((ev.units[k] | 0) > 0 && ZOMBIES[k] && ZOMBIES[k].unlock > L) warnings.push(`${tag}: ${k} unlocks at L${ZOMBIES[k].unlock}`);
  }
  return total;
}

/**
 * Concurrent zombies per type: every wave / run-up / guard squad lives from its spawn distance (`at`) until its
 * contact distance; the peak of the overlapping sums must fit the pools (error) and stay under maxLive.
 */
/** The validator's pool model: every wave / run-up / guard squad as a span [spawn, contact] with its units (round 5d: shared). */
function poolSpans(events, v) {
  const spans = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || !Number.isFinite(ev.at)) continue;
    if ((ev.type === 'wave' || ev.type === 'runup') && ev.units && typeof ev.units === 'object') {
      spans.push({ a: ev.at, b: waveContactAt(ev, v), units: ev.units, tag: `${ev.type} @${ev.at}` });
    } else if (ev.type === 'gates' && Array.isArray(ev.guards)) {
      for (let g = 0; g < ev.guards.length; g++) {
        const gd = ev.guards[g];
        if (gd && gd.units && typeof gd.units === 'object') spans.push({ a: ev.at, b: guardContactAt(ev.at, gd.units, v), units: gd.units, tag: `guards @${ev.at}` });
      }
    }
  }
  return spans;
}

/**
 * Round 5d (tools/validate-levels.js): the validator's pool model over `events` at road speed `v` — the peak live count per type
 * (`out.per`, TYPES order) and the peak total (`out.total`), peaks taken at spawn moments like checkPoolOverlap. Writes `out`.
 */
export function endlessPoolPeaks(events, v, out) {
  const spans = poolSpans(events, v);
  const per = out.per || (out.per = [0, 0, 0, 0, 0]);
  for (let k = 0; k < TYPES.length; k++) per[k] = 0;
  out.total = 0;
  for (let i = 0; i < spans.length; i++) {
    let total = 0;
    const t = spans[i].a;
    for (let k = 0; k < TYPES.length; k++) {
      let n = 0;
      for (let j = 0; j < spans.length; j++) { const sp = spans[j]; if (sp.a <= t && sp.b >= t) n += sp.units[TYPES[k]] | 0; }
      if (n > per[k]) per[k] = n;
      total += n;
    }
    if (total > out.total) out.total = total;
  }
  return out;
}

function checkPoolOverlap(events, v, errors, warnings) {
  const spans = poolSpans(events, v);
  for (let i = 0; i < spans.length; i++) {
    let total = 0;
    const per = [0, 0, 0, 0, 0];
    const t = spans[i].a;                                     // peaks happen at a spawn
    for (let j = 0; j < spans.length; j++) {
      const sp = spans[j];
      if (sp.a > t || sp.b < t) continue;
      for (let k = 0; k < TYPES.length; k++) { const n = sp.units[TYPES[k]] | 0; per[k] += n; total += n; }
    }
    for (let k = 0; k < TYPES.length; k++) {
      if (per[k] > ZOMBIES[TYPES[k]].pool) { errors.push(`${spans[i].tag}: ${per[k]} ${TYPES[k]}s alive at once exceed the pool (${ZOMBIES[TYPES[k]].pool})`); return; }
    }
    if (total > ZOMBIES.common.maxLive) { errors.push(`${spans[i].tag}: ${total} zombies alive at once exceed maxLive ${ZOMBIES.common.maxLive}`); return; }
  }
}

/**
 * Validates a LevelScript (authored or generated). A wrapper with `endless: true` (tools) skips the
 * campaign-only rules (single boss, run-up, E-trace, wave rhythm). Errors: shape, mandatory lane caps (D19),
 * pools (per event and concurrent), gate spacing (never two gate events armed together), E-trace (declared and
 * re-simulated cautious line within ±15 % of E_boss), Σ EV (greedy line ≥ evFraction·E_boss). Warnings: leak
 * bands per wave, breakeven band, sanity rules (no red below E 8, two reds before L4, early ÷, unreachable steps),
 * GDD wave rhythm, unlock levels, declared-vs-re-simulated drift.
 * Result: { ok, errors, warnings, trace:[{at, e, note}], cautiousFinal, greedyFinal, declaredFinal, gates:[…], waves:[…] }.
 */
export function validateLevel(script) {
  const errors = [], warnings = [], trace = [];
  const out = { ok: false, errors, warnings, trace, cautiousFinal: 0, greedyFinal: 0, designFinal: 0, designMode: 'cautious', declaredFinal: 0, maxLines: [], gates: [], waves: [] };
  if (!script || typeof script !== 'object') { errors.push('script is not an object'); return out; }
  const endless = script.endless === true;
  const L = Number.isFinite(script.id) ? Math.floor(script.id) : 0;
  const len = script.length, v = script.roadSpeed, eBoss = script.eBoss;
  if (!(len > 0)) errors.push('length must be > 0');
  if (!(v > 0)) errors.push('roadSpeed must be > 0');
  if (!(eBoss > 0)) errors.push('eBoss must be > 0');
  if (!Number.isFinite(script.seed)) warnings.push('seed is missing');
  if (typeof script.name !== 'string') warnings.push('name is missing');
  const c = curve(Math.max(1, L || 1));
  // QA LVL-34: the authored L1 (GDD §11) is checked against its own declared line and values, not the generator rules
  const authored = !endless && script.line !== 'greedy' && !!LEVELS.authored[L];

  // expected[]
  if (!Array.isArray(script.expected) || script.expected.length === 0) errors.push('expected[] is empty');
  else {
    for (let i = 0; i < script.expected.length; i++) {
      const s = script.expected[i];
      if (!s || !Number.isFinite(s.at) || !Number.isFinite(s.e)) { errors.push(`expected[${i}] is malformed`); continue; }
      if (s.e < 1) errors.push(`expected[${i}].e must be ≥ 1`);
      if (i > 0 && script.expected[i - 1] && s.at < script.expected[i - 1].at) errors.push(`expected[${i}] is out of order`);
      if (i > 0 && script.expected[i - 1] && s.at === script.expected[i - 1].at) warnings.push(`expected[${i}] duplicates the previous distance`);
    }
  }
  if (!Array.isArray(script.events)) { errors.push('events[] is missing'); return out; }
  const events = script.events;

  // per-event shape
  let bossCount = 0, bossAt = -1, runupAt = -1, runupIdx = -1;
  const gateArrivals = [];
  const waveEvents = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const tag = `event ${i}` + (ev && typeof ev === 'object' ? ` (${ev.type} @${ev.at})` : '');
    if (!ev || typeof ev !== 'object') { errors.push(`${tag}: not an object`); continue; }
    if (!Number.isFinite(ev.at) || ev.at < 0) errors.push(`${tag}: invalid at`);
    if (i > 0 && events[i - 1] && Number.isFinite(events[i - 1].at) && ev.at < events[i - 1].at) errors.push(`${tag}: events are not sorted by at`);
    if (!endless && Number.isFinite(ev.at) && len > 0 && ev.at > len) errors.push(`${tag}: at beyond the level length ${len}`);
    switch (ev.type) {
      case 'gates':
        validateGatesEvent(ev, tag, errors, warnings, authored);
        gateArrivals.push({ ev, arrival: ev.at + SPAWN_DIST, idx: i });
        break;
      case 'wave':
        validateWaveEvent(ev, tag, L, endless, errors, warnings, authored);
        waveEvents.push(ev);
        break;
      case 'crate':
        if (PICKUPS.items.indexOf(ev.item) === -1) errors.push(`${tag}: unknown item '${ev.item}'`);
        if (!(Math.abs(ev.x) <= WORLD.roadWidth / 2)) errors.push(`${tag}: x off the road`);
        break;
      case 'coins':
        if (!(Math.abs(ev.x) <= WORLD.roadWidth / 2)) errors.push(`${tag}: x off the road`);
        if (ev.count !== undefined && !(Number.isInteger(ev.count) && ev.count >= 1 && ev.count <= PICKUPS.coinPool)) errors.push(`${tag}: count must be 1..${PICKUPS.coinPool}`);
        break;
      case 'hint':
        if (!HINTS[ev.id]) errors.push(`${tag}: unknown hint '${ev.id}'`);
        break;
      case 'runup': {
        const total = validateUnits(ev.units, tag, errors, warnings);
        if (ev.units) for (const k in ev.units) if ((ev.units[k] | 0) > 0 && k !== 'walker' && k !== 'runner') warnings.push(`${tag}: run-up hordes are walkers and runners only (${k})`);
        if (total > LEVELS.curve.runup.cap) warnings.push(`${tag}: run-up has ${total} zombies (cap ${LEVELS.curve.runup.cap})`);
        if (ev.bursts !== undefined && !(Number.isInteger(ev.bursts) && ev.bursts >= 1)) errors.push(`${tag}: bursts must be ≥ 1`);
        if (ev.burstGap !== undefined && !(ev.burstGap > 0)) errors.push(`${tag}: burstGap must be > 0`);
        if (ev.pattern !== undefined && !WAVE_PATTERNS[ev.pattern]) errors.push(`${tag}: unknown pattern '${ev.pattern}'`);
        validateHp(ev.hp, ev.units || {}, tag, errors, warnings);
        runupAt = ev.at; runupIdx = i;
        break;
      }
      case 'boss':
        if (!BOSSES.archetypes[ev.archetype]) errors.push(`${tag}: unknown archetype '${ev.archetype}'`);
        if (!(ev.hp > 0)) errors.push(`${tag}: boss hp must be > 0`);
        if (typeof ev.id !== 'string') errors.push(`${tag}: boss id must be a string`);
        if (ev.minionHp !== undefined && (!ev.minionHp || typeof ev.minionHp !== 'object')) errors.push(`${tag}: minionHp must be a record`);
        if (!ev.mini) { bossCount++; bossAt = ev.at; }
        break;
      default:
        errors.push(`${tag}: unknown event type '${ev.type}'`);
    }
  }

  // QA LVL-5: an intro level shows its gate feature (GATE_RULES.generation.newFeature)
  if (!endless && L > 0 && GEN.newFeature) {
    const nf = GEN.newFeature;
    let mult3 = false, triple = false, div3 = false;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.type !== 'gates' || !Array.isArray(ev.lanes)) continue;
      if (ev.layout === 'triple') triple = true;
      for (let k = 0; k < ev.lanes.length; k++) {
        const lane = ev.lanes[k];
        if (lane && lane.op === 'x' && lane.value === GATE_RULES.mult.base + 1) mult3 = true;
        if (lane && lane.op === '/' && lane.value === GATE_RULES.div.ladder[0]) div3 = true;
      }
    }
    if (L === nf.mult3 && !mult3) errors.push(`L${L} introduces x${GATE_RULES.mult.base + 1} gates but has no x${GATE_RULES.mult.base + 1} lane`);
    if (L === nf.triple && !triple) errors.push(`L${L} introduces triple gates but has no triple event`);
    if (L === nf.div3 && !div3) errors.push(`L${L} introduces ÷${GATE_RULES.div.ladder[0]} gates but has no ÷${GATE_RULES.div.ladder[0]} lane`);
  }

  // campaign structure
  if (!endless) {
    if (bossCount !== 1) errors.push(`expected exactly one boss event, found ${bossCount}`);
    else {
      if (bossAt !== len) warnings.push(`boss spawns at ${bossAt}, level length is ${len}`);
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev || !Number.isFinite(ev.at)) continue;
        if ((ev.type === 'gates' || ev.type === 'wave' || ev.type === 'crate' || ev.type === 'coins') && ev.at >= bossAt) errors.push(`event ${i} (${ev.type} @${ev.at}) spawns at/after the boss`);
        if (ev.type === 'runup' && ev.at >= bossAt) errors.push(`run-up @${ev.at} is not before the boss @${bossAt}`);
      }
      const bossEv = events.find(e => e && e.type === 'boss' && !e.mini);
      if (bossEv && bossEv.archetype !== c.bossId) warnings.push(`boss archetype '${bossEv.archetype}' differs from the rotation ('${c.bossId}')`);
      if (bossEv && bossEv.hp !== c.bossHp) warnings.push(`boss hp ${bossEv.hp} differs from the curve (${c.bossHp})`);
    }
    if (runupIdx === -1) warnings.push('no runup event');
    if (eBoss > 0 && c.eBoss !== eBoss) warnings.push(`eBoss ${eBoss} differs from the curve (${c.eBoss})`);
  }

  // pool capacities: zombies are alive from their spawn distance until contact; overlapping waves, guards and
  // the run-up share the per-type pools (GDD §6.2: walker 120, runner 60, crawler 40, brute 16, spitter 24; 260 live)
  if (v > 0) checkPoolOverlap(events, v, errors, warnings);

  // spacing: two gate events must never be armed together
  gateArrivals.sort((a, b) => a.arrival - b.arrival);
  const armWindow = -WORLD.gateArmZ;
  for (let i = 1; i < gateArrivals.length; i++) {
    const gap = gateArrivals[i].arrival - gateArrivals[i - 1].arrival;
    if (gap < armWindow) errors.push(`gate events ${gateArrivals[i - 1].idx} and ${gateArrivals[i].idx} arrive ${Math.round(gap)} m apart (< armed window ${armWindow} m)`);
  }
  if (!endless && v > 0) {
    // never two waves without a gate between them (solo introductions excepted)
    for (let i = 0; i + 1 < gateArrivals.length; i++) {
      const a = gateArrivals[i].arrival, b = gateArrivals[i + 1].arrival;
      let n = 0;
      for (let w = 0; w < waveEvents.length; w++) {
        const ev = waveEvents[w];
        if (!ev.units) continue;
        const st = unitStats(ev.units, _stats);
        if (st.n <= 1) continue;
        const d = waveContactAt(ev, v);
        if (d > a && d <= b) n++;
      }
      if (n > 1) warnings.push(`${n} waves make contact between gate events ${gateArrivals[i].idx} and ${gateArrivals[i + 1].idx} (GDD §1: one wave per gate)`);
    }
    if (waveEvents.length > 0) {
      const first = waveEvents[0];
      let walkersOnly = true;
      if (first.units) for (const k in first.units) if (k !== 'walker' && (first.units[k] | 0) > 0) walkersOnly = false;
      if (!walkersOnly || first.pattern !== ZOMBIES.common.firstWavePattern) warnings.push(`first wave should be walkers only in a '${ZOMBIES.common.firstWavePattern}'`);
      if (WAVE_RULES.newestTypeInLastWave && L >= 2) {
        let last = null;
        for (let w = waveEvents.length - 1; w >= 0; w--) {
          const st = unitStats(waveEvents[w].units || {}, _stats);
          if (st.n > 1 && (runupAt < 0 || waveEvents[w].at < runupAt)) { last = waveEvents[w]; break; }
        }
        if (last && (last.units[c.newest] | 0) === 0) warnings.push(`last wave lacks the level's newest type (${c.newest})`);
      }
    }
  }

  // E-trace (campaign only)
  if (!endless && errors.length === 0) {
    const moments = buildMoments(events, v);
    const E0 = script.expected[0].e;
    const p = { v, bandMid: c.bandMid, E0, len, waveModel: script.line === 'greedy', calibL: script.line === 'greedy' ? levelCalib(L) : 0 };
    // the DESIGN line: generated scripts are sized on the greedy line (script.line = 'greedy', QA LVL-1) and keep a
    // weak-shooter line (best lane at 0.3·H) as the survivability check; the authored L1 declares its cautious line (GDD §11)
    const designMode = script.line === 'greedy' ? 'greedy' : 'cautious';
    const caut = simulate(moments, authored ? { v, bandMid: c.bandMid, E0, len, waveModel: false, declared: script.expected } : p, designMode === 'greedy' ? 'weak' : 'cautious', null);
    const greedy = simulate(moments, p, 'greedy', null);
    const design = designMode === 'greedy' ? greedy : caut;
    out.designMode = designMode;
    out.cautiousFinal = caut.final;
    out.cautiousRows = caut.rows;
    // the declared line (what level.expectedSquad(), the medic cap and every live HP solve read) must land too
    const declaredFinal = interpExpected(script.expected, bossAt >= 0 ? bossAt : len);
    out.declaredFinal = declaredFinal;
    const dRatio = declaredFinal / eBoss;
    if (dRatio < 1 - TRACE_TOLERANCE || (dRatio > 1 + TRACE_TOLERANCE && designMode === 'cautious')) {
      errors.push(`declared E-trace (script.expected) ends at ${Math.round(declaredFinal)} = ${Math.round(dRatio * 100)} % of E_boss ${eBoss} (window ±${Math.round(TRACE_TOLERANCE * 100)} %)`);
    }
    out.greedyFinal = greedy.final;
    // QA LVL-34: the authored L1's design line IS its declared samples (GDD §11)
    const designFinal = authored ? declaredFinal : design.final;
    out.designFinal = designFinal;
    const ratio = designFinal / eBoss;
    // a generated level whose + gates cap above the window (L2: every +A maxes at 4·A) may overshoot: the full-intake
    // line below is the hard ceiling there, so an overshoot of the design line is a warning, an undershoot an error
    if (ratio < 1 - TRACE_TOLERANCE || (ratio > 1 + TRACE_TOLERANCE && designMode === 'cautious')) {
      errors.push(`${designMode} (design) E-trace ends at ${Math.round(designFinal)} = ${Math.round(ratio * 100)} % of E_boss ${eBoss} (window ±${Math.round(TRACE_TOLERANCE * 100)} %)`);
    } else if (ratio > 1 + TRACE_TOLERANCE) {
      warnings.push(`${designMode} (design) E-trace ends at ${Math.round(design.final)} = ${Math.round(ratio * 100)} % of E_boss ${eBoss} (above the ±${Math.round(TRACE_TOLERANCE * 100)} % window; the full-intake line is the ceiling)`);
    }
    // the weak-shooter line (best lane at 0.3·H against waves solved for the design line) is a survivability report,
    // not a target: it lands far below E_boss by construction (QA LVL-1 resolution, see the validator header)
    if (designMode !== 'cautious' && caut.final < CAUTIOUS_FLOOR * eBoss) {
      // QA LVL-27: a weak line that collapses (≈ 0 % of E_boss: the squad is wiped before the boss) is an error
      const msg = `weak-shooter line (0.3·H) ends at ${Math.round(caut.final)} = ${Math.round(caut.final / eBoss * 100)} % of E_boss ${eBoss} (below ${Math.round(CAUTIOUS_FLOOR * 100)} %)`;
      if (caut.final < WEAK_LINE_FAIL * eBoss) errors.push(msg);
      else warnings.push(msg);
      out.weakLow = true;
    }
    if (greedy.final < GEN.evFraction * eBoss) {
      errors.push(`Σ EV: the greedy line ends at ${Math.round(greedy.final)} < ${GEN.evFraction}·E_boss (${Math.round(GEN.evFraction * eBoss)})`);
    }
    // full-intake greedy lines (QA LVL-1): a perfect player who fills every gate's intake must not snowball
    out.maxLines = [];
    for (let k = 0; k < GREEDY_PROFILES.length; k++) {
      const prof = GREEDY_PROFILES[k];
      const pr = profileAt(prof.rank);
      const base = profileAt(0);
      const pm = { v, bandMid: c.bandMid, E0: Math.max(E0, pr.s0), len, waveModel: p.waveModel, calibL: p.calibL, fire: pr.fire, dpsMult: (pr.fire * pr.dmg) / (base.fire * base.dmg) };
      const mx = simulate(moments, pm, 'max', null);
      out.maxLines.push({ id: prof.id, final: mx.final, ratio: mx.final / eBoss, limit: prof.maxRatio, rows: mx.rows });
      if (L >= 2 && mx.final > prof.maxRatio * eBoss) {
        errors.push(`full-intake greedy line (${prof.id}) reaches the boss with ${Math.round(mx.final)} = ${Math.round(mx.final / eBoss * 100)} % of E_boss ${eBoss} (limit ${Math.round(prof.maxRatio * 100)} %)`);
      }
      // QA LVL-2: a ÷ lane is a "lesser evil" — even a full window at the intake cap never turns it into a doubling
      for (let r = 0; r < mx.rows.length; r++) {
        const row = mx.rows[r];
        if (row.kind !== 'gate') continue;
        const lane = row.ev.lanes[row.lane];
        if (lane && lane.op === '/' && row.eAfter > row.eBefore + 0.5) {
          errors.push(`gate @${row.ev.at}: the full-intake line (${prof.id}) gains on ÷${lane.value} (step ${lane.step}): ${Math.round(row.eBefore)} → ${Math.round(row.eAfter)}`);
        }
      }
    }
    // round-3 QA LVL-22 (GDD §1, §4.4): steering must matter — a squad that never steers (the lane nearest the centre,
    // full intake, fresh profile) must reach the boss below GATE_RULES.generation.noSteerMax·E_boss
    if (!authored && L >= 2 && GEN.noSteerMax > 0) {
      const b0 = profileAt(0);
      const ns = simulate(moments, { v, bandMid: c.bandMid, E0: Math.max(E0, b0.s0), len, waveModel: p.waveModel, calibL: p.calibL, fire: b0.fire, dpsMult: 1 }, 'nosteer', null);
      out.noSteerFinal = ns.final;
      if (ns.final > GEN.noSteerMax * eBoss) {
        out.noSteerHigh = true;
        warnings.push(`no-steer line (centre lane, full intake) reaches the boss with ${Math.round(ns.final)} = ${Math.round(ns.final / eBoss * 100)} % of E_boss ${eBoss} (limit ${Math.round(GEN.noSteerMax * 100)} %: steering must matter)`);
      }
    }
    let drift = 0, worst = 0;
    for (let i = 0; i < design.samples.length; i++) {
      const s = design.samples[i];
      const ex = interpExpected(script.expected, s.at);
      const dev = Math.abs(ex / Math.max(1, s.e) - 1);
      if (dev > TRACE_TOLERANCE) { drift++; if (dev > worst) worst = dev; }
    }
    if (drift > 0 && !authored) warnings.push(`script.expected deviates from the re-simulated ${designMode} line at ${drift} sample(s) (worst ${Math.round(worst * 100)} %)`);

    // QA LVL-16 (GDD §1): the better option of pairs and triples (the design line's face-value pick, guards ignored)
    // lies on each half 40–60 % of the time, ±1 event — a player who never steers must not play the optimal route
    let left = 0, right = 0;
    for (let r = 0; r < design.rows.length; r++) {
      const row = design.rows[r];
      if (row.kind !== 'gate' || !row.ev.lanes || row.ev.lanes.length < 2) continue;
      chooseLane({ lanes: row.ev.lanes, guards: null }, row.eBefore, DESIGN_HITS * row.H, c.bandMid, 'face', _choice);
      // a tie at face value (x2 | +5 at E = 5) has no better half
      let second = -Infinity, bestFace = -Infinity;
      for (let i = 0; i < row.ev.lanes.length; i++) {
        const ln = row.ev.lanes[i];
        const fv = ln.op === 'item' ? row.eBefore * FACE_ITEM.mult + FACE_ITEM.add : laneOutcome(ln, row.eBefore, 0);
        if (i === _choice.idx) bestFace = fv;
        else if (fv > second) second = fv;
      }
      if (bestFace - second < 0.5) continue;
      const centres = WORLD.laneCenters[row.ev.layout] || WORLD.laneCenters.pair;
      const x = centres[clamp(_choice.idx, 0, centres.length - 1)];
      if (x < -0.01) left++;
      else if (x > 0.01) right++;
    }
    out.sides = { left, right };

    // QA LVL-26 (GDD §8): the design line collects the level's guaranteed (newly unlocked) special — its crate lies on the
    // half of the lane the design line holds when the crate arrives (the gate it lines up for, as levelgen places it), or
    // its item lane is the lane the design line takes
    const guaranteed = !authored && L >= 2 && L <= PICKUP_SCHEDULE.length ? PICKUP_SCHEDULE[L - 1] : null;
    if (guaranteed) {
      const gateRows = design.rows.filter((r) => r.kind === 'gate');
      let collected = false, where = 'not delivered';
      for (let i = 0; i < gateRows.length && !collected; i++) {
        const ln = gateRows[i].ev.lanes[gateRows[i].lane];
        if (ln && ln.op === 'item' && ln.item === guaranteed) collected = true;
        else if (gateRows[i].ev.lanes.some((l) => l.op === 'item' && l.item === guaranteed)) where = `item lane @${gateRows[i].ev.at} not taken`;
      }
      for (let i = 0; i < events.length && !collected; i++) {
        const ev = events[i];
        if (ev.type !== 'crate' || ev.item !== guaranteed) continue;
        const arrive = ev.at + SPAWN_DIST;
        let ref = null, prev = null;
        for (let k = 0; k < gateRows.length; k++) { if (gateRows[k].d >= arrive) { ref = gateRows[k]; break; } prev = gateRows[k]; }
        if (ref && ref.d - arrive > -WORLD.gateArmZ + PICKUP_CLEAR_M && prev) ref = prev;
        if (!ref) ref = gateRows[gateRows.length - 1];
        if (!ref) break;
        const centres = WORLD.laneCenters[ref.ev.layout] || WORLD.laneCenters.pair;
        const lx = centres[clamp(ref.lane, 0, centres.length - 1)];
        const sameHalf = (lx > 0.5 && ev.x > 0.5) || (lx < -0.5 && ev.x < -0.5) || (Math.abs(lx) <= 0.5 && Math.abs(ev.x) <= 0.5);
        if (sameHalf) collected = true;
        else where = `crate @${ev.at} at x ${ev.x} vs the design lane x ${lx}`;
      }
      if (!collected) errors.push(`guaranteed special ${guaranteed} is not collected by the design line (${where})`);
    }
    const nSides = left + right;
    if (nSides >= 2 && (left < 0.4 * nSides - 1 || left > 0.6 * nSides + 1)) {
      errors.push(`better option of pairs / triples on the left ${left} of ${nSides} times (GDD §1 alternation: 40–60 % ±1 event)`);
    }

    let redSeen = false;
    for (let r = 0; r < design.rows.length; r++) {
      const row = design.rows[r];
      const ev = row.ev;
      if (row.kind === 'gate') {
        const labels = [];
        let reds = 0, hasDiv = false, plusLane = null, multLane = null;
        for (let i = 0; i < ev.lanes.length; i++) {
          const lane = ev.lanes[i];
          labels.push(laneLabel(lane));
          if (isRedLane(lane)) reds++;
          if (lane.op === '/') hasDiv = true;
          if (lane.op === '+' && plusLane === null) plusLane = lane;
          if (lane.op === 'x' && multLane === null) multLane = lane;
          if (isRedLane(lane) && row.eBefore < GEN.noRedBelowE) warnings.push(`gate @${ev.at}: red lane while E = ${Math.round(row.eBefore)} < ${GEN.noRedBelowE}`);
          if (lane.op === '-' && lane.value >= row.eBefore && ev.lanes.length > 1) warnings.push(`gate @${ev.at}: −${lane.value} ≥ E ${Math.round(row.eBefore)} would reduce the squad to 1`);
          // QA LVL-27: an unreachable step is an error (it was a warning)
          if ((lane.op === 'x' || lane.op === '/') && lane.step > row.H / GATE_RULES.hits.fraction) errors.push(`gate @${ev.at}: ${lane.op}${lane.value} step ${lane.step} exceeds the ${Math.round(row.H / GATE_RULES.hits.fraction)} hits a full squad can land (no step reachable in the window)`);
        }
        const tag = `gate @${ev.at} (${ev.layout} ${labels.join(' | ')})`;
        if (reds >= 2 && L < GEN.rules.twoRedsFrom && !(L >= GEN.rules.lesserEvilFrom && hasDiv)) warnings.push(`${tag}: two red lanes before L${GEN.rules.twoRedsFrom}`);
        if (hasDiv && L <= GEN.rules.noDivLevels && row.d < GEN.rules.noDivBeforeM) warnings.push(`${tag}: ÷ gate in the first ${GEN.rules.noDivBeforeM} m of L1–${GEN.rules.noDivLevels}`);
        if (plusLane && multLane && ev.layout === 'pair' && !authored) {   // QA LVL-34: GDD §11 authors L1's pairs
          // breakeven C = A/(M−1) (GDD §4.3); A is design-rounded (1 / 5 / 10), so half a rounding step is slack
          const A = plusLane.value;
          const half = (Math.abs(A) < 30 ? 1 : Math.abs(A) < 100 ? 5 : 10) / 2;
          const Eb = Math.max(1, row.eBefore);
          const breakeven = A / (multLane.value - 1);
          const near = clamp(Eb * (multLane.value - 1), A - half, A + half) / (multLane.value - 1);
          const dev = Math.abs(near / Eb - 1);
          if (dev > GEN.rules.breakevenBand) warnings.push(`${tag}: breakeven ${Math.round(breakeven)} is ${Math.round(dev * 100)} % off E ${Math.round(row.eBefore)} (band ±${Math.round(GEN.rules.breakevenBand * 100)} %)`);
        }
        if (reds > 0 && !redSeen) redSeen = true;
        const guardStr = ev.guards ? ` guards[${ev.guards.map(gd => `lane ${gd.lane}: ${unitsLabel(gd.units)}`).join('; ')}]` : '';
        trace.push({ at: row.d, e: Math.round(row.eAfter), note: `gate ${ev.layout} ${labels.join(' | ')} → lane ${row.lane} (hits ${Math.round(row.hits)}): ${Math.round(row.eBefore)} → ${Math.round(row.eAfter)}${guardStr}` });
        out.gates.push({ at: ev.at, arrival: row.d, layout: ev.layout, lanes: ev.lanes, labels, eBefore: row.eBefore, eAfter: row.eAfter, lane: row.lane, H: row.H, guards: ev.guards || null, hint: ev.hint || null });
      } else if (row.kind === 'wave' || row.kind === 'runup') {
        const band = c.band;
        // integer HP: a wave whose HP is ±0.5 per zombie away from the band is as close as rounding allows
        const slack = waveLeakSlack(row.eBefore, v, ev.units, ev.hp, ev.hpMult, row.wc, c.bandMid);
        const inBand = row.leak + slack >= band[0] - 0.005 && row.leak - slack <= band[1] + 0.005;
        if (!inBand && row.n > 1) warnings.push(`${row.kind} @${ev.at} (${unitsLabel(ev.units)}): expected leak ${Math.round(row.leak * 1000) / 10} % outside the band ${Math.round(band[0] * 100)}–${Math.round(band[1] * 100)} % at E ${Math.round(row.eBefore)}`);
        const hpStr = ev.hp ? ` hp ${TYPES.filter(t => (ev.units[t] | 0) > 0).map(t => `${t} ${ev.hp[t]}`).join(', ')}` : ' hp solved live';
        trace.push({ at: row.d, e: Math.round(row.eAfter), note: `${row.kind} ${ev.pattern} ${unitsLabel(ev.units)}${hpStr} leak ${Math.round(row.leak * 1000) / 10} % bites ${Math.round(row.bites * 10) / 10}: ${Math.round(row.eBefore)} → ${Math.round(row.eAfter)}` });
        out.waves.push({ kind: row.kind, at: ev.at, contact: row.d, pattern: ev.pattern, units: ev.units, hp: ev.hp || null, eBefore: row.eBefore, eAfter: row.eAfter, leak: row.leak, bites: row.bites, n: row.n, hint: ev.hint || null });
      } else if (row.kind === 'boss') {
        trace.push({ at: row.d, e: Math.round(row.eAfter), note: `boss ${ev.archetype} hp ${ev.hp}${ev.mini ? ' (mini)' : ''}: E ${Math.round(row.eAfter)} vs E_boss ${eBoss} (${Math.round(row.eAfter / eBoss * 100)} %)` });
      }
    }
  }

  out.ok = errors.length === 0;
  return out;
}
