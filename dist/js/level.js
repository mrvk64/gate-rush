// js/level.js — GATE RUSH: LevelRunner (ARCHITECTURE §6.16).
//
// Owns the run: script cursor (spawns), distance / road speed, run-up, boss hand-off (minion HP),
// E(z), run statistics, coin accounting (the ONLY income path, D1), hints (once ever), stars /
// coins / score at level end, endless chunk appending and the title idle scene.
//
// Dependency rule (§1): imports only ./util.js, ./data.js and ./levelgen.js (pure). Every other
// module is reached through ctx (read), ctx.events (emit) and the public methods listed in §6.
// Zero per-frame allocation in step()/idleStep(): module-level payload objects, index loops over
// ZOMBIES.common.types, typed-array slot tables. The only allocations happen at EVENT time (a wave
// or boss spawning every few seconds): solveWaveHp's result object (levelgen is pure and returns a
// fresh record), the boss spec, the endless chunk array — never per frame.
//
// Writes (per the §3 ctx table): ctx.world.roadSpeed / roadSpeedBase / distance (plus the full
// in-place overwrite of ctx.world that §6.16 assigns to start()), ctx.rng, ctx.rngFx, ctx.run.

import { Rng, clamp, lerpExp, warnOnce, roundDesign } from './util.js';
import {
  WORLD, SQUAD, ZOMBIES, LEAK_MODEL, LEAK_BANDS, BOSSES, LEVELS, ECONOMY, SCORE,
  QUALITY_TIERS, RENDER, JUICE, HINTS, GATE_RULES, PICKUPS, WAVE_PATTERNS, STRINGS, FIRE,
  DISTRICT_RULES, districtForLevel, districtForChunk,
  starNeed,                                               // round 7 (r7, explain:0): the star thresholds the results print
  CODEX,                                                  // round 7 (r7, teaching:5): FIELD GUIDE entries met in play (_codexSeen)
} from './data.js';
import { generateLevel, levelGenerator, generateChunk, solveWaveHp, gateDefaults, endlessGateGuard, eventWorstCase, leakCalib, endlessPressure, endlessParams, endlessDesignMult, endlessHpCap, endlessPoolReserve } from './levelgen.js';

// ---------------------------------------------------------------------------------------------
// Contract constants (ARCHITECTURE literals that are structure, not tuning) and DATA-MISSING keys
// ---------------------------------------------------------------------------------------------

/** ctx.rngFx = ctx.rng.fork(7): cosmetic stream seeded `seed + 7` (ARCH §3 / §6.1). */
const RNG_FX_OFFSET = 7;
/** Stable handles are `(generation << 12) | slot` (ARCH D6): the slot is the low 12 bits. */
const SLOT_MASK = 0xFFF;
/** Slot tables for the hint / hit bookkeeping: gates has 12 gate slots and 8 event slots (ARCH §6.9); 16 leaves headroom. */
const GATE_SLOTS = 16;
const EVENT_SLOTS = 16;
/** Endless default seed when neither startEndless(seed) nor ?seed= gives one: `Date.now() & 0xffff` (ARCH §6.1). */
const ENDLESS_SEED_MASK = 0xFFFF;

// DATA-MISSING: LEVELS.curve.runup.spread — the run-up bursts spawn with `spread: 8` (ARCH §6.16); equals WAVE_PATTERNS.horde.box[1].
const RUNUP_SPREAD = WAVE_PATTERNS.horde.box[1];
// DATA-MISSING: WORLD.fog.runupLerpSeconds — `render.env.setFog(WORLD.fog.runupNear, params.fogFar, 1)` (ARCH §6.16).
const RUNUP_FOG_LERP_S = 1;
// DATA-MISSING: JUICE.gameOverResultsMs — game over → finish(false) after 1200 ms real time (ARCH §6.16);
// equals RENDER.gameOver.seconds (the J18 camera drop / desaturate theatre, 1.2 s).
const GAMEOVER_RESULTS_MS = RENDER.gameOver.seconds * 1000;
// DATA-MISSING: WORLD.idleGate — the decorative title gate pair (ARCH §6.16): `+17 (cap 68) | x2 (cap 5, step 9999)`.
// 17 is the GDD §5 "+17" example value; its cap follows GATE_RULES.plus (max(capMin, capMult·17) = 68); the x2 lane
// uses GATE_RULES.mult.base / cap and a step that is never reached (decorative gates accept no hits anyway).
const IDLE_PLUS_VALUE = 17;
const IDLE_NEVER_STEP = 9999;
/** Staggered-wave parts waiting for their spawn distance (QA LVL-4b: a wave's faster types spawn `lag` m later). */
const PENDING_PARTS = 16;
/** QA LVL-17: endless gate events spawned but not yet passed (at most a handful are on the road at once). */
const PENDING_GATES = 8;
/** Breakdown buckets of the coin accumulator (QA LVL-6), in run.breakdown key order. */
const COIN_BUCKETS = ['kills', 'gates', 'piles', 'boss', 'bonus'];
/** QA LVL-20: coin sources that are not credited once the squad is dead (phase 'lost'); kill coins of bullets already
 *  in flight still land (GDD §7 / §10: no rewards after C = 0). */
const LOST_BLOCKED_SOURCES = ['gate', 'max', 'crate', 'pile', 'duplicate', 'refund'];
/** QA LVL-18: generated campaign scripts kept per `${curveL}|${seed}` (memo); bounded so a long session stays small.
 *  Round 5 integration: room for every campaign level at its default seed plus a few retry seeds (the levels screen
 *  prefetches every unlocked level; a script is 3–6 KB of JSON, the whole campaign ≈ 140 KB). */
const SCRIPT_CACHE_MAX = LEVELS.count + 10;
/** QA LVL-18: idle prefetch — requestIdleCallback timeout (ms), or the setTimeout fallback delay (ms). */
const PREFETCH_IDLE_TIMEOUT_MS = 1000;
const PREFETCH_FALLBACK_MS = 50;
// Round-2 cross-group (UI report item 3): the prefetch runs generation attempts while the idle deadline has at least
// PREFETCH_MIN_LEFT_MS left (always one attempt per slot, so it progresses even on a timed-out callback), then yields to
// the next idle slot; without requestIdleCallback a slot is PREFETCH_SLICE_MS of attempts.
const PREFETCH_MIN_LEFT_MS = 6;
const PREFETCH_SLICE_MS = 8;
// Round 5 integration (r5-env-art needsOtherGroup "level / levelgen"): a menu start whose script is not memoized generates
// in animation-frame slices of START_SLICE_MS of attempts (one at least) and starts the run when it is ready — L13 / L19 / L28
// take 29–32 attempts, 100–130 ms unthrottled (≈ 0.5 s at 4×), and ran in one click handler before (a 55–130 ms frame).
const START_SLICE_MS = 8;
// Round 5 integration (r5-perf-audio needsOtherGroup 1): _fireBoss's own helpers run once, silently, this many metres before
// the boss event, so the boss hand-off frame is not their first call (≈ 4–5 s ahead at 8–12 m/s: a quiet stretch, after
// the boss rehearsals of boss.js and before the run-up's last burst)
const BOSS_WARM_LEAD_M = 45;

/** Deep-freezes a generated campaign script before it is cached (QA LVL-18: cached scripts are read-only). */
function freezeScript(o) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  const keys = Object.keys(o);
  for (let i = 0; i < keys.length; i++) freezeScript(o[keys[i]]);
  return o;
}

/** A clock that is cheap to read for debug timings (performance.now when present). */
function perfNow() {
  return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') ? performance.now() : Date.now();
}

/** Chunk difficulty → equivalent campaign level for LEAK_BANDS, ZOMBIES[*].kills2FromLevel-style rules and
 *  `level.level` in endless: endless unlocks after L10 (LEVELS.endlessUnlock), so chunk D plays like level 10 + D. */
function endlessEquivalentLevel(difficulty) { return LEVELS.endlessUnlock + difficulty; }

// ---------------------------------------------------------------------------------------------
// Module-level reused payloads (listeners must not retain them — ARCH §5)
// ---------------------------------------------------------------------------------------------

const P_START = { level: 0, seed: 0, endless: false, script: null, district: '' };
/** DISTRICTS.md §8.5: district:change payload (reused); reason 'start' | 'rotate' | 'title'. */
const P_DISTRICT = { id: '', name: '', index: 0, label: '', accent: 0, seconds: -0, reason: '', banner: false, first: false, step: 0, steps: 0 };
const P_PROGRESS = { distance: -0, length: -0, fraction: -0 };
const P_RUNUP = { secondsToBoss: -0 };
const P_COMPLETE = { level: 0, stars: 0, survivors: 0, eBoss: 0, coins: 0, breakdown: null };
const P_FAILED = { level: 0, fraction: -0, coinsKept: -0 };
const P_CHUNK = { index: 0, difficulty: -0 };
const P_END = { distance: -0, score: 0, best: 0, coins: 0, chunks: 0, newBest: false };
// round 7 (r7, teaching:0 B / teaching:3): hint:show also carries how the hint is bound — hold (theatre s it cannot be cut
// by a waiting hint; 0 = the normal duration), until (release key: the gate event id or 'crate'; null = none), priority
// (a boss attack's lesson: it cuts a normal hint on screen) and event (the gate event whose gates pulse while it is up, −1)
const P_HINT = { id: '', text: '', hold: -0, until: null, priority: false, event: -1 };
const P_RELEASE = { key: null };                          // r7: hint:release { key } — the subject of a held hint is resolved
const P_CODEX = { id: '' };                               // r7 (teaching:5): codex:new { id } — a NEW card's first encounter
const HOLD = { hold: -0, until: null, priority: false, event: -1 };   // r7: reused showHint options (event time, never retained)
const P_COINS = { total: -0, runTotal: -0, delta: -0, source: '' };
const P_BONUS = { amount: -0, x: -0, y: -0, z: -0, source: 'bonus' };
const P_HISTO = { key: '', value: 0 };
/** opts for zombies.spawn() of a gate guard (ARCH §6.7 / §6.16). */
const GUARD_OPTS = { guardEventId: 0, guardLane: 0, lunge: false };

/** The decorative title gate pair (ARCH §6.16 idleStep). Reused every WORLD.idleGateEveryM metres. */
const IDLE_GATE_EVENT = {
  layout: 'pair',
  lanes: [
    { op: '+', value: IDLE_PLUS_VALUE, cap: Math.max(GATE_RULES.plus.capMin, GATE_RULES.plus.capMult * IDLE_PLUS_VALUE) },
    { op: 'x', value: GATE_RULES.mult.base, cap: GATE_RULES.mult.cap, step: IDLE_NEVER_STEP },
  ],
  decorative: true,
};

/** Order in which LevelRunner.start()/quitToTitle() reset the systems (ARCH §6 common shape; squad last). */
const RESET_ORDER = ['fx', 'weapons', 'zombies', 'boss', 'gates', 'pickups', 'troops', 'squad'];

const TYPES = ZOMBIES.common.types;   // ['walker', 'runner', 'crawler', 'brute', 'spitter']
/** Round 5d (GDD §10.1): the script events the endless mini-boss hold keeps back (the boss's own minions are boss.js's). */
const HOLD_TYPES = { gates: true, wave: true, crate: true, coins: true };

// Round 7 (r7) — tutorial and FIELD GUIDE bookkeeping (structure, not tuning; the timings live in JUICE.ui / JUICE.slowmo)
/** teaching:3: the lesson of each telegraphed boss attack (boss:attack.kind → HINTS id); the safety-valve chew has none. */
const LESSON_OF = Object.freeze({ slam: 'dodge.slam', charge: 'dodge.charge', lane: 'dodge.charge', car: 'dodge.car',
  spit3: 'dodge.acid', rain: 'dodge.acid', stomp: 'boss.stomp' });
/** teaching:3: the phase-change hints by base archetype (twins → hulk, prime → colossus) and phase number. */
const PHASE_HINT = Object.freeze({
  hulk: [null, null, 'boss.hulk.2', 'boss.hulk.3'], spitterQueen: [null, null, 'boss.spitterQueen.2', 'boss.spitterQueen.3'],
  juggernaut: [null, null, 'boss.juggernaut.2', 'boss.juggernaut.3'], colossus: [null, null, 'boss.colossus.2', 'boss.colossus.3'],
});
/** teaching:5: the save key ('seen:<id>') of every FIELD GUIDE entry, built once (no string per event). */
const SEEN_KEY = (() => {
  const o = {};
  for (let s = 0; s < CODEX.sections.length; s++) for (const id of CODEX.sections[s].ids) o[id] = 'seen:' + id;
  return Object.freeze(o);
})();
const CARD_OK = Object.freeze(CODEX.cards.reduce((o, id) => { o[id] = true; return o; }, {}));
/** gate op → its FIELD GUIDE entry. */
const GATE_CODEX = Object.freeze({ '+': 'gate.plus', '-': 'gate.minus', x: 'gate.mult', '/': 'gate.div', item: 'gate.item' });
const ZOMBIE_CODEX = TYPES.map((t) => 'zombie.' + t);
const RELEASE_CRATE = 'crate';                            // hint:release key of the held "GRAB THE CRATE" (L1)
/** teaching:0 B: the core gate lessons held while their gate event is on the road (and slowed the first time, ui). */
const GATE_LESSONS = Object.freeze({ red: true, single: true });

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** Leak-band midpoint for a (campaign-equivalent) level — GDD §6.3 / LEAK_BANDS. */
function bandMidFor(level) {
  for (let i = 0; i < LEAK_BANDS.length; i++) {
    const b = LEAK_BANDS[i];
    if (level >= b.L[0] && level <= b.L[1]) return (b.band[0] + b.band[1]) / 2;
  }
  const last = LEAK_BANDS[LEAK_BANDS.length - 1];
  return (last.band[0] + last.band[1]) / 2;
}

/** Population-weighted own speed s̄ = Σ units_t·speed_t / N (GDD §6.3). Allocation-free. */
function meanOwnSpeed(units) {
  let n = 0, sum = 0;
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    const c = units[t] | 0;
    if (c > 0) { n += c; sum += c * ZOMBIES[t].speed; }
  }
  return n > 0 ? sum / n : 0;
}

/** Number of zombies in a units record. */
function unitCount(units) {
  let n = 0;
  for (let i = 0; i < TYPES.length; i++) n += units[TYPES[i]] | 0;
  return n;
}

/** hz = hp_t / baseHp_t for any type present in `units` (every type shares one hz, ARCH §6.16); 1 when nothing is present. */
function hzOf(hpByType, units) {
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    if ((units[t] | 0) > 0 && hpByType[t] > 0) return hpByType[t] / ZOMBIES[t].baseHp;
  }
  return 1;
}

/** Authored `hpMult` override: scales every type's HP (min LEAK_MODEL.minHp). Returns `hp` itself for mult 1. */
function scaleHp(hp, mult) {
  if (mult === 1) return hp;
  const out = {};
  for (let i = 0; i < TYPES.length; i++) {
    const t = TYPES[i];
    if (hp[t] !== undefined) out[t] = Math.max(LEAK_MODEL.minHp, Math.round(hp[t] * mult));
  }
  return out;
}

/** Endless E(z) = min(cap, base·growth^D) — GDD §10.1 / LEVELS.endless.e. */
function endlessE(difficulty) {
  const e = LEVELS.endless.e;
  return Math.min(e.cap, e.base * Math.pow(e.growth, difficulty));
}

/**
 * QA LVL-17: the endless leak target rises with D — the campaign-equivalent band midpoint + bandPerD·D, capped at
 * LEVELS.endless.bandMax (GDD §10.1 amendment).
 */
function endlessBand(difficulty, bandMid) {
  const e = LEVELS.endless;
  const per = e.bandPerD > 0 ? e.bandPerD : 0;
  const cap = e.bandMax > 0 ? e.bandMax : bandMid;
  return Math.max(bandMid, Math.min(cap, bandMid + per * difficulty));
}

/** Endless road speed = min(cap, base + per·D) — GDD §10.1 / LEVELS.endless.speed. */
function endlessSpeed(difficulty) {
  const s = LEVELS.endless.speed;
  return Math.min(s.cap, s.base + s.per * difficulty);
}

/** Resolves a boss archetype through its `base` chain and returns the first `phases` found (ARCH §6.8 / D8). */
function archetypePhases(name) {
  let a = BOSSES.archetypes[name];
  let depth = 0;
  while (a && !a.phases && a.base && depth < 8) { a = BOSSES.archetypes[a.base]; depth++; }
  return a && a.phases ? a.phases : null;
}

/** Per-type sum of every `spawn` action in `phases` plus the phase-1 walker bursts (ARCH §6.16 / D8). Fresh object (per boss event). */
function unionMinionUnits(phases) {
  const union = {};
  if (phases) {
    for (let p = 0; p < phases.length; p++) {
      const acts = phases[p].onEnter;
      if (!acts) continue;
      for (let a = 0; a < acts.length; a++) {
        const spawn = acts[a].spawn;
        if (!spawn) continue;
        for (let i = 0; i < TYPES.length; i++) {
          const t = TYPES[i];
          const n = spawn[t] | 0;
          if (n > 0) union[t] = (union[t] | 0) + n;
        }
      }
    }
  }
  union.walker = (union.walker | 0) + BOSSES.minionBurst.count;
  return union;
}

/**
 * Round-3 QA LVL-17: a copy of boss `phases` whose attacks kill k× as many soldiers (kills / min rounded, killsPct
 * scaled) — the endless mini-boss under pressure. Fresh objects (one boss event), never per frame.
 */
function pressurePhases(phases, k) {
  if (!phases) return phases;
  const scale = (a) => {
    const o = {};
    for (const key in a) o[key] = a[key];
    if (a.kills > 0) o.kills = Math.max(1, Math.round(a.kills * k));
    if (a.killsPct > 0) o.killsPct = a.killsPct * k;
    if (a.min > 0) o.min = Math.max(1, Math.round(a.min * k));
    return o;
  };
  const out = [];
  for (let p = 0; p < phases.length; p++) {
    const ph = scale(phases[p]);
    if (phases[p].onEnter) {
      ph.onEnter = [];
      for (let a = 0; a < phases[p].onEnter.length; a++) ph.onEnter.push(phases[p].onEnter[a].attack ? scale(phases[p].onEnter[a]) : phases[p].onEnter[a]);
    }
    out.push(ph);
  }
  return out;
}

/** Rounds a boss HP total to BOSSES.hpRound (used only when a boss event lacks `hp`). */
function roundBossHp(hp) { return Math.round(hp / BOSSES.hpRound) * BOSSES.hpRound; }

/** RunStats — plain object re-created per run (ARCH §6.16). Extra fields are marked. */
function newRunStats(level, seed, endless, script, replay) {
  // Fraction-holding fields are created from 0.5 and reset below (round-2 cross-group, FX-14 item 2: a Double
  // representation from the start — the first fractional coin / wave-hz store used to deprecate the RunStats map
  // mid-play and deoptimise every reader).
  const r = {
    level, seed, endless, phase: 'run',
    distance: 0.5, length: script.length, roadSpeedBase: script.roadSpeed, elapsed: 0.5,
    coins: 0.5, breakdown: { kills: 0.5, gates: 0.5, piles: 0.5, boss: 0.5, bonus: 0.5 },
    kills: 0, killsByType: { walker: 0, runner: 0, crawler: 0, brute: 0, spitter: 0 },
    gatesPassed: 0, gatesMaxed: 0, gatesFlipped: 0, peakSquad: 0, soldiersLost: 0,
    lostToRed: 0, bossStartTime: -0.5, bossSeconds: 0.5, survivors: 0, stars: 0, score: 0.5, replay, waveHz: 0.5, chunks: 1,
    hitsPerGate: [], finalVsBase: [], lostPerWave: [], hintsShown: [],
    // extras (not in the §6.16 list; used by score / results / debug)
    killCoins: 0.5,      // Σ base kill coins (pre-multiplier) → SCORE.kill
    miniBossKills: 0,    // endless → SCORE.endless.miniBoss
    streakMult: 0.5,     // endless ×2 per SCORE.endless.streakSeconds without a death
    streakSeconds: 0.5,
    countAtBoss: 0,      // C when the boss event fired (debug histogram countAtBoss)
    bossHpScale: 0.5,    // QA LVL-14: count × shop scale applied to the boss table HP
    assist: 0,           // QA LVL-21: soldiers added by the fail-streak assist at level start
    rubberEvents: 0,     // QA LVL-17: endless gate events rewritten by the rubber band
    redCapped: 0,        // r7: campaign gate events whose red lanes _capRedLanes capped at spawn (debug)
    bossTtkBand: 0,      // r7: 1 when _bossTtkBand raised the campaign boss HP to the fight floor (r7 fix round 3: or the weak floor), else 0 (debug)
    eBoss: script.eBoss,
    newBest: false,      // endless: this run set a new best score
  };
  r.distance = 0; r.elapsed = 0; r.coins = 0;
  const b = r.breakdown; b.kills = 0; b.gates = 0; b.piles = 0; b.boss = 0; b.bonus = 0;
  r.bossStartTime = -1; r.bossSeconds = 0; r.score = 0; r.waveHz = 1;
  r.killCoins = 0; r.streakMult = 1; r.streakSeconds = 0; r.bossHpScale = 1;
  return r;
}

/** The endless pseudo-script (§8.7 shape; `expected` is unused — E comes from LEVELS.endless.e). Fresh per run. */
function newEndlessScript(seed) {
  return {
    id: 0, name: STRINGS.hud.endless, seed,
    length: LEVELS.endless.chunk,            // grows by one chunk per append (level:progress.length)
    roadSpeed: endlessSpeed(1), eBoss: endlessE(1),
    expected: [], events: [],
  };
}

// ---------------------------------------------------------------------------------------------
// LevelRunner
// ---------------------------------------------------------------------------------------------

export class LevelRunner {
  constructor(ctx) {
    this.ctx = ctx;

    // run identity
    this._level = 0;            // campaign level (endless: the equivalent level, see endlessEquivalentLevel)
    this._seed = 0;
    this._endless = false;
    this._script = null;
    this._phase = 'idle';
    this._finished = false;     // finish() has run for this run (the result is presented)
    this._finishing = false;    // re-entry guard while finish() runs
    // QA LVL-19: the result is COMMITTED (stars, payout, save) exactly once — at finish() or, when the player quits /
    // restarts during the death theatre, at that moment; presenting (state + level:complete / failed) is separate
    this._committed = false;
    this._committing = false;   // the commit's own bonus coin:pickup must still be accounted
    this._resultData = null;    // the state data the commit prepared for the presentation
    // Fields written `this.F = 0.5; this.F = <start>;` are seeded as Doubles (round-2 cross-group, FX-14 item 2: no V8
    // map deprecation when the first fraction is stored).
    // QA LVL-29: theatre deadlines run on ctx.time.theatre (CORE-7) when present, else on this runner's own clock,
    // which advances by real time per simulated step (dt / timeScale) and therefore stops while paused
    this._theatreMs = 0.5; this._theatreMs = 0;
    // QA LVL-18: generated campaign scripts (memo + idle prefetch)
    this._scriptCache = new Map();
    this._prefetchQueue = [];
    this._prefetchPending = false;
    this._lastGenMs = 0.5; this._lastGenMs = 0;
    this._genWarmPending = false;   // round-3 verify: the boot's levelgen JIT warm-up (initStep) is still due
    // round 5 integration: a menu start waiting for its script (requestStart): key, level, seed, the state it was asked
    // from (any state change drops it), the pending frame handle and the bound frame callback
    this._reqOn = false;
    this._reqKey = '';
    this._reqLevel = 0;
    this._reqSeed = 0;
    this._reqState = '';
    this._reqHandle = 0;
    this._reqRaf = false;           // the handle came from requestAnimationFrame (else setTimeout)
    this._reqTick = () => this._runRequest();
    // round 5 integration: the boss-path warm-up (BOSS_WARM_LEAD_M) — distance to run it at (−1 = none due) and its event
    this._bossWarmAt = -0.5; this._bossWarmAt = -1;
    this._bossWarmEv = null;
    // QA LVL-21: consecutive failures per campaign level in this session (fail-streak assist)
    this._failStreak = new Map();
    this._assistSoldiers = 0;

    // cursor / timing
    this._cursor = 0;
    this._roadTarget = 0.5; this._roadTarget = WORLD.idleRoadSpeed;   // Double field from the start (round-2 cross-group)
    this._progressAcc = 0.5; this._progressAcc = 0;
    this._finishAt = 0.5; this._finishAt = 0;
    this._bossAt = 0;           // `at` of the boss event (level:runup.secondsToBoss)
    this._bossReached = false;  // campaign: gates / pickups stop spawning after the boss row
    this._bandMid = bandMidFor(1);
    this._pendingEvent = null;  // the script event being spawned (bound to its gate event id in the listeners)

    // run-up bursts
    this._runupActive = false;
    this._runupBursts = 0;
    this._runupIndex = 0;
    this._runupTimer = 0;
    this._runupGap = 0;
    this._runupUnits = null;    // the event's full units record
    this._runupWave = null;     // { pattern, units, spread } passed to zombies.spawnWave (fresh per run-up)
    this._runupHp = null;

    // waves / hints
    this._waveHz = 0.5; this._waveHz = 1;   // Double field from the start (round-2 cross-group, FX-14 item 2)
    this._lossHint = null;      // armed hintOnLoss (r7: kept armed until a bite shows it — a later wave no longer disarms it)
    this._waveCount = 0;
    this._lossesThisWave = 0;
    // round 7 (r7, teaching:0 / :3 / :5): the script event whose gates.spawnEvent is running (gates forwards ev.hint to
    // showHint during it; _fireGates shows it itself right after, bound to the new event id), the gate event id of each gate
    // slot (hint:release at its pass / miss), the boss archetype of this run, the zombie types already marked seen this run
    // (zombie:spawn is frequent) and the NEW cards shown this run (an item its card explained skips its pickup hint)
    this._spawningEv = null;
    this._spawnTaught = false;       // r7 fix: a lesson was bound to the event being spawned (its gate:spawn taught 'div')
    // r7 fix round 2: the gate event the 'lesser' lesson is bound to (−1 none) — released as soon as one of its lanes stops
    // costing soldiers (a − flipped, a ÷ shot to ×1), so "BOTH LANES HURT" never stays up over a harmless lane
    this._lesserEv = -1;
    // r7 fix round 3 (teaching / walker): "GRAB THE CRATE" was emitted (on screen or waiting) and no crate resolved it yet —
    // step() releases it once no closed crate is left ahead (one the squad steered past unopened, L1 held left: the caption
    // stayed 2–2.6 s over an empty road, then counted as learnt, and held "×3 MULTIPLIES YOUR SQUAD" 5.6 s past its gate)
    this._crateHintUp = false;
    this._gateEv = new Float64Array(GATE_SLOTS).fill(-1);
    this._bossArch = '';
    this._zSeenRun = new Uint8Array(TYPES.length);
    this._runCards = [];

    // endless
    this._difficulty = 1;
    this._chunkEnd = 0;
    this._aheadGates = new Array(PENDING_GATES).fill(null);   // QA LVL-17: spawned, not yet arrived gate events
    this._aheadCount = 0;
    // round 5d (GDD §10.1): the mini-boss hold — while an endless mini-boss is alive the script cursor waits on gates / wave /
    // crate / coins events (_holdOn); at the kill every event still ahead slides by a shift that accumulates over the run
    // (_holdShiftM, metres: later chunks are generated in the shifted frame, _appendChunk); _hpCap = endlessHpCap scratch;
    // _poolReserve = the pool slots every endless wave / guard leaves free for the mini-boss's minions (_clampEndlessUnits)
    this._holdOn = false;
    this._holdShiftM = 0.5; this._holdShiftM = 0;
    this._hpCap = endlessHpCap(1, 1, {});
    this._poolReserve = endlessPoolReserve({});

    // visual districts (DISTRICTS.md §3 / §8.5): the district shown, the previous run's key for the banner rule (campaign
    // level, −1 for endless, 0 = no run yet this session) and the endless rotation's last fired gate event
    this._district = districtForLevel(1);
    this._lastRunKey = 0;
    this._lastGatesAt = -0.5; this._lastGatesAt = -1e9;

    // idle scene
    this._idleDist = 0.5; this._idleDist = 0;
    this._idleNextGate = 0;

    // staggered wave parts (QA LVL-4b): spawn distance, the part's wave record and HP table
    this._partAt = new Float64Array(PENDING_PARTS);
    this._partWave = new Array(PENDING_PARTS).fill(null);
    this._partHp = new Array(PENDING_PARTS).fill(null);
    this._partCount = 0;

    // coin accumulator (QA LVL-6): unrounded credit per breakdown bucket, whole coins credited so far
    this._coinRaw = new Float64Array(COIN_BUCKETS.length);
    this._coinPaid = new Float64Array(COIN_BUCKETS.length);

    // boss road slow-down tween (QA LVL-13: BOSSES.intro.roadLerp seconds, linear)
    this._roadTweenT = -0.5; this._roadTweenT = -1;
    this._roadTweenFrom = 0.5; this._roadTweenFrom = 0;
    this._roadTweenTo = 0.5; this._roadTweenTo = 0;

    // distance at squad:dead (QA LVL-10: results read it, not the death run-on); −1 while alive
    this._deathDistance = -1;
    // distance written by the previous step (QA LVL-11: a larger jump than staleEventSkipM is a debug jump); −1 = none
    this._lastDistance = -0.5; this._lastDistance = -1;

    // gate bookkeeping tables (slot = id & SLOT_MASK)
    this._evIds = new Int32Array(EVENT_SLOTS).fill(-1);
    this._evScript = new Array(EVENT_SLOTS).fill(null);
    this._gateIds = new Int32Array(GATE_SLOTS).fill(-1);
    this._gateLane = new Array(GATE_SLOTS).fill(null);
    this._gateHits = new Float64Array(GATE_SLOTS);

    this._offs = [];
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Subscribes to the §5 events this module consumes; phase 'idle'. Returns this. */
  init() {
    const ev = this.ctx.events;
    const offs = this._offs;
    offs.push(ev.on('coin:pickup', (p) => this._onCoinPickup(p)));
    offs.push(ev.on('zombie:die', (p) => this._onZombieDie(p)));
    offs.push(ev.on('gate:event', (p) => this._onGateEvent(p)));
    offs.push(ev.on('gate:spawn', (p) => this._onGateSpawn(p)));
    offs.push(ev.on('gate:hit', (p) => this._onGateHit(p)));
    offs.push(ev.on('gate:max', (p) => this._onGateMax(p)));
    offs.push(ev.on('gate:flip', (p) => this._onGateFlip(p)));
    offs.push(ev.on('gate:pass', (p) => this._onGatePass(p)));
    offs.push(ev.on('gate:miss', (p) => this._onGateMiss(p)));
    offs.push(ev.on('boss:fight', (p) => this._onBossFight(p)));
    offs.push(ev.on('boss:attack', (p) => this._onBossAttack(p)));      // round-3 FTUE: the dodge lesson (r7: one per attack kind)
    offs.push(ev.on('item:pickup', (p) => this._onItemPickup(p)));      // round-3 FTUE: first-pickup hints
    offs.push(ev.on('weapon:stored', () => this._onWeaponStored()));     // round 6: the FIRE lesson, HINTS.fire (once ever)
    // round 7 (r7): the weapon's name hint when it really fires (teaching:0 C), the crate hint's release (teaching:0 B), the
    // boss phase lessons (teaching:3), a spitter's first glob (teaching:7), the first grey ×1 (teaching:5) and the FIELD
    // GUIDE entries met in play (zombie types, armour, power-up timers)
    offs.push(ev.on('weapon:start', (p) => this._onWeaponStart(p)));
    offs.push(ev.on('crate:open', () => { this._crateHintUp = false; this._release(RELEASE_CRATE); }));
    // r7 fix round 3 (teaching / walker): a weapon's name lesson ("SHOTGUN! WIDE SPREAD, SHORT RANGE") is bound to the weapon
    // — weapon:end takes it down, or drops it from the queue unshown (it showed 0.5 s past the shotgun, mostly in its last
    // 2.5 s, when the FIRE lesson was read first); under HINT_MARK_S on screen it stays unmarked for the next firing
    offs.push(ev.on('weapon:end', (p) => { if (p && typeof p.id === 'string') this._release(p.id); }));
    offs.push(ev.on('boss:phase', (p) => this._onBossPhase(p)));
    offs.push(ev.on('zombie:telegraph', (p) => this._onZombieTelegraph(p)));
    offs.push(ev.on('zombie:spawn', (p) => this._onZombieSpawn(p)));
    offs.push(ev.on('gate:step', (p) => this._onGateStep(p)));
    offs.push(ev.on('armor:change', (p) => { if (p && p.plates > 0) this._codexSeen('hud.shield', false); }));
    offs.push(ev.on('gear:start', (p) => { if (p && Number.isFinite(p.duration)) this._codexSeen('hud.pills', false); }));
    offs.push(ev.on('boss:dead', (p) => this._onBossDead(p)));
    offs.push(ev.on('squad:loss', (p) => this._onSquadLoss(p)));
    offs.push(ev.on('squad:dead', (p) => this._onSquadDead(p)));
    offs.push(ev.on('squad:count', (p) => this._onSquadCount(p)));
    offs.push(ev.on('state:change', (p) => this._onStateChange(p)));
    // ctx.run must always be an object (listeners read it before the first run)
    if (!this.ctx.run) {
      this.ctx.run = newRunStats(0, 0, false, { length: 0, roadSpeed: WORLD.idleRoadSpeed, eBoss: 0 }, false);
      this.ctx.run.phase = 'idle';
    }
    this._phase = 'idle';
    this._genWarmPending = true;
    return this;
  }

  /** Boot slicing (ARCH §4.1 step 9, round-3 verify): 1 while the level generator's JIT warm-up is still due, else 0. */
  get initSteps() { return this._genWarmPending ? 1 : 0; }

  /**
   * Boot only: one throwaway generation attempt of the first generated level, so levelgen's code is JIT-warm before the
   * first idle prefetch. A page's first attempt runs cold — ≈ 75 ms at 4× CPU (11 ms unthrottled) against 8–14 ms warm —
   * and it landed in the first idle slot after the L1 results appeared: the 62–69 ms frame of the round-2 / round-3 4×
   * runs (r3-boot-polish needsOtherGroup 2). The attempt is discarded (generation is deterministic per L + seed). Returns
   * the slices still pending (0). Never throws.
   */
  initStep() {
    if (!this._genWarmPending) return 0;
    this._genWarmPending = false;
    let L = 2;
    while (LEVELS.authored[L] && L < LEVELS.curve.loopAfter) L++;
    try {
      levelGenerator(L, LEVELS.seedBase + L).step();
    } catch (err) {
      warnOnce('level.warmup', 'level generator warm-up failed: ' + (err && err.message ? err.message : err));
    }
    return 0;
  }

  /** Returns the runner to its idle bookkeeping state without touching other systems (idempotent, allocation-free). */
  reset() {
    this._setPhase('idle');
    this._finished = false;
    this._cursor = 0;
    this._progressAcc = 0;
    this._finishAt = 0;
    this._bossReached = false;
    this._pendingEvent = null;
    this._runupActive = false;
    this._runupIndex = 0;
    this._runupTimer = 0;
    this._lossHint = null;
    this._waveCount = 0;
    this._lossesThisWave = 0;
    this._idleDist = 0;
    this._idleNextGate = 0;
    this._clearGateTables();
    this._clearRunState();
  }

  /** Per-run transient state (staggered wave parts, coin accumulator, road tween, death distance). Allocation-free. */
  _clearRunState() {
    for (let i = 0; i < PENDING_GATES; i++) this._aheadGates[i] = null;
    this._aheadCount = 0;
    for (let i = 0; i < PENDING_PARTS; i++) { this._partWave[i] = null; this._partHp[i] = null; }
    this._partCount = 0;
    this._coinRaw.fill(0);
    this._coinPaid.fill(0);
    this._roadTweenT = -1;
    this._deathDistance = -1;
    this._lastDistance = -1;
    this._holdOn = false;          // round 5d: the mini-boss hold and its accumulated shift are per run
    this._holdShiftM = 0;
  }

  /**
   * A debug distance jump (smoke --boss writes world.distance) leaves the gates / zombies / pickups spawned before it
   * on the road: they are cleared once (public reset / killAll) so the boss fight is representative (QA LVL-11).
   */
  _onDistanceJump() {
    const ctx = this.ctx;
    if (ctx.zombies) ctx.zombies.killAll('cleanup');
    if (ctx.gates && typeof ctx.gates.reset === 'function') ctx.gates.reset();
    if (ctx.pickups && typeof ctx.pickups.reset === 'function') ctx.pickups.reset();
    this._clearGateTables();
    for (let i = 0; i < PENDING_PARTS; i++) { this._partWave[i] = null; this._partHp[i] = null; }
    this._partCount = 0;
  }

  /** Removes every listener this module added. */
  dispose() {
    this._cancelRequest();
    for (let i = 0; i < this._offs.length; i++) {
      const off = this._offs[i];
      if (typeof off === 'function') off();
    }
    this._offs.length = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Public getters
  // -------------------------------------------------------------------------------------------

  get level() { return this._level; }
  /** The visual district shown (a DISTRICTS entry; DISTRICTS.md §8.5). */
  get district() { return this._district; }
  get endless() { return this._endless; }
  get script() { return this._script; }
  get phase() { return this._phase; }
  get run() { return this.ctx.run; }

  /**
   * E at the squad front now (z = 0) or at road position z (negative = ahead): the object at z reaches the
   * squad when `distance` has grown by −z, so E = expectedAt(distance − z) (ARCH §6.16).
   */
  expectedSquad(z = 0) {
    return this._expectedAt(this.ctx.world.distance - z);
  }

  /**
   * hz of the most recently spawned wave (= hpByType[t] / ZOMBIES[t].baseHp for any type present); 1.0 before
   * the first wave. The run-up is the last wave before the boss, so during the boss fight this IS the run-up hz (D7).
   */
  waveHz() { return this._waveHz; }

  /**
   * Tutorial hint: nothing happens if the id is unknown, already done (save.hintDone) or already emitted in this run;
   * else hint:show { id, text }. QA LVL-24: level no longer marks the hint — ui queues it and calls save.markHint(id)
   * when the hint is actually displayed, so a hint overwritten in the same frame is shown later instead of lost.
   * QA LVL-33: a template hint (HINTS[id] is a function) is called with `arg` (x2: the pass's effective multiplier).
   */
  showHint(id, arg, opts) {
    if (!id) return false;
    const entry = HINTS[id];
    if (entry === undefined) { warnOnce('level.hint.' + id, 'unknown hint id ' + id); return false; }
    // round 7 (r7, teaching:0 B): gates.spawnEvent forwards ev.hint here without options while _fireGates is spawning that
    // event — _fireGates shows it itself right after, bound to the new gate event id (hold, release, gate pulse)
    if (!opts && this._spawningEv && this._spawningEv.hint === id) return false;
    const save = this.ctx.save;
    if (save && save.hintDone(id)) return false;
    const run = this.ctx.run;
    if (run && run.hintsShown) {
      if (run.hintsShown.indexOf(id) !== -1) return false;     // at most once per run
      run.hintsShown.push(id);
    }
    P_HINT.id = id;
    P_HINT.text = typeof entry === 'function' ? entry(arg) : entry;
    P_HINT.hold = opts && opts.hold > 0 ? opts.hold : 0;
    P_HINT.until = opts && opts.until !== undefined ? opts.until : null;
    P_HINT.priority = !!(opts && opts.priority);
    P_HINT.event = opts && opts.event >= 0 ? opts.event : -1;
    this.ctx.events.emit('hint:show', P_HINT);
    if (this._spawningEv) this._spawnTaught = true;
    return true;
  }

  /** Round 7 (r7, teaching:0 B): the subject of a held hint is resolved (its gate event passed, a crate opened) → ui
   *  takes that hint down (or drops it from the queue) via hint:release { key }. */
  _release(key) {
    if (key === null || key === undefined) return;
    P_RELEASE.key = key;
    this.ctx.events.emit('hint:release', P_RELEASE);
  }

  /** Round 7 (r7): the reused showHint options for a hint bound to gate event `eventId` until it passes (hold = the
   *  theatre seconds until it reaches the squad at the current road speed; ui pulses the event's gates meanwhile). */
  _gateHold(eventId) {
    const v = Math.max(1, this.ctx.world.roadSpeed);
    HOLD.hold = -WORLD.spawnZ / v;
    HOLD.until = eventId >= 0 ? eventId : null;
    HOLD.priority = false;
    HOLD.event = eventId >= 0 ? eventId : -1;
    return HOLD;
  }

  /**
   * Round 7 (r7, teaching:5): an entry of the FIELD GUIDE met in play — marked seen in the save ('seen:<id>', once ever;
   * save.hints takes any id). With `card` and a CODEX.cards entry it is announced by a NEW card (codex:new { id }) — a purple
   * item lane at its spawn, before the choice; a crate's item at its pickup; the first MAX; the first grey ×1. Returns true
   * when the card was announced. Event time only (the key strings are built once, SEEN_KEY).
   */
  _codexSeen(id, card) {
    const key = SEEN_KEY[id];
    const save = this.ctx.save;
    if (!key || !save || save.hintDone(key)) return false;
    save.markHint(key);
    if (!card || !CARD_OK[id] || this._phase === 'idle') return false;
    this._runCards.push(id);
    P_CODEX.id = id;
    this.ctx.events.emit('codex:new', P_CODEX);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Run entry points (ARCH §6.16)
  // -------------------------------------------------------------------------------------------

  /**
   * Campaign level. script = LEVELS.authored[level] ?? generateLevel(L, seed ?? LEVELS.seedBase + level);
   * beyond LEVELS.count the curve uses L = LEVELS.curve.loopAfter (30) with seed 1000 + level, so the campaign loops.
   */
  start(level, seed) {
    this._cancelRequest();                                // round 5: a direct start wins over a pending menu request
    this._commitPending();                                // QA LVL-19: a won / lost run left during its theatre
    level = Math.max(1, Math.floor(Number(level) || 1));
    const authored = LEVELS.authored[level];
    const runSeed = (seed !== undefined && seed !== null && Number.isFinite(seed)) ? (seed >>> 0) : this._defaultSeed(level);
    const script = authored || this._generatedScript(level, runSeed);
    this._level = level;
    this._endless = false;
    this._difficulty = 1;
    this._bandMid = bandMidFor(Math.min(level, LEVELS.curve.loopAfter));
    this._beginRun(script, runSeed);
    this._applyAssist();
  }

  /**
   * Round 5 integration — the menus' "play this level" (PLAY, NEXT, a level tile): start(level, seed) at once when the
   * script is authored or memoized (returns true); otherwise its generation moves to the front of the prefetch queue and
   * runs in animation-frame slices (START_SLICE_MS of attempts, one at least) while the menu stays up, and the run starts in
   * the frame the script is ready (returns false). A state change, a newer request or a direct start / startEndless /
   * quitToTitle drops it (the generation itself stays queued for idle time). start() keeps its synchronous contract (boot
   * with ?level=N, tools); generateLevel's result is unchanged — only when it runs.
   */
  requestStart(level, seed) {
    const L = Math.max(1, Math.floor(Number(level) || 1));
    const s = (seed !== undefined && seed !== null && Number.isFinite(seed)) ? (seed >>> 0) : this._defaultSeed(L);
    this._cancelRequest();
    const key = Math.min(L, LEVELS.curve.loopAfter) + '|' + s;
    if (LEVELS.authored[L] || this._scriptCache.has(key)) { this.start(L, s); return true; }
    let job = null;
    for (let i = 0; i < this._prefetchQueue.length; i++) {
      if (this._prefetchQueue[i].key === key) { job = this._prefetchQueue[i]; this._prefetchQueue.splice(i, 1); break; }
    }
    this._prefetchQueue.unshift(job || { key, level: L, seed: s, gen: null });   // keeps a partial idle generation's attempts
    this._reqOn = true;
    this._reqKey = key;
    this._reqLevel = L;
    this._reqSeed = s;
    this._reqState = this.ctx.state ? this.ctx.state.current : '';
    this._scheduleRequest();
    return false;
  }

  /** True while a requestStart waits for its script. */
  get starting() { return this._reqOn; }

  /** Round 5 integration: restart() for the menus (RETRY / REPLAY / RESTART) through requestStart — the same level and seed
   *  rule (a RETRY after a failure rerolls the seed, round-3 QA LVL-21), without a synchronous generation. */
  requestRestart() {
    if (this._endless) { this.startEndless(this._seed); return true; }
    return this.requestStart(this._level, (this._failStreak.get(this._level) | 0) > 0 ? undefined : this._seed);
  }

  /**
   * Next slice of a pending requestStart. Round 7 (r7, flow-coins:3): a 0 ms timer task, not an animation frame — on a
   * no-GPU box a frame takes 0.3–2 s, and one 8 ms slice per frame made NEXT wait 1.3 s (Low) to 5 s (High) for L2's 9
   * attempts while the results looked unchanged. Timer tasks interleave with input and frames, so no frame still waits on
   * more than one slice. `hidden` (a hidden tab, _runRequest): re-armed on an animation frame instead, which a hidden tab
   * does not run, so the run never starts unseen. requestAnimationFrame is the fallback without setTimeout.
   */
  _scheduleRequest(hidden) {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    const raf = !!(g && typeof g.requestAnimationFrame === 'function');
    const timer = !!(g && typeof g.setTimeout === 'function');
    if (raf && (hidden || !timer)) { this._reqRaf = true; this._reqHandle = g.requestAnimationFrame(this._reqTick); }
    else if (timer) { this._reqRaf = false; this._reqHandle = g.setTimeout(this._reqTick, 0); }
    else { this._reqOn = false; this.start(this._reqLevel, this._reqSeed); }   // no scheduler (node harness): synchronous
  }

  _cancelRequest() {
    if (!this._reqOn) return;
    this._reqOn = false;
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (this._reqHandle && g) {
      try {
        if (this._reqRaf && typeof g.cancelAnimationFrame === 'function') g.cancelAnimationFrame(this._reqHandle);
        else if (!this._reqRaf && typeof g.clearTimeout === 'function') g.clearTimeout(this._reqHandle);
      } catch (_) { /* the callback re-checks _reqOn */ }
    }
    this._reqHandle = 0;
  }

  /** One slice of a pending requestStart: generation attempts for START_SLICE_MS (one at least), then start or re-queue.
   *  Round 7 (r7, flow-coins:3): a hidden tab waits for the next animation frame (it gets one once visible again). */
  _runRequest() {
    this._reqHandle = 0;
    if (!this._reqOn) return;
    const st = this.ctx.state;
    if (st && st.current !== this._reqState) { this._reqOn = false; return; }   // the menu was left: dropped
    let hidden = false;
    try { hidden = typeof document !== 'undefined' && !!document && document.visibilityState === 'hidden'; } catch (_) { hidden = false; }
    if (hidden && typeof globalThis !== 'undefined' && typeof globalThis.requestAnimationFrame === 'function') { this._scheduleRequest(true); return; }
    const key = this._reqKey;
    const t0 = perfNow();
    let ready = this._scriptCache.has(key);
    while (!ready) {
      const job = this._prefetchQueue.length > 0 ? this._prefetchQueue[0] : null;
      if (!job || job.key !== key) { ready = true; break; }   // an idle slot finished (or dropped) it: start() resolves the rest
      try {
        if (!job.gen) job.gen = levelGenerator(Math.min(job.level, LEVELS.curve.loopAfter), job.seed);
        const raw = job.gen.step();
        if (raw !== null) { this._prefetchQueue.shift(); this._cacheScript(key, freezeScript(raw)); ready = true; }
      } catch (err) {
        this._prefetchQueue.shift();
        warnOnce('level.request', 'level generation failed: ' + (err && err.message ? err.message : err));
        ready = true;                                     // start() generates synchronously and surfaces the error
      }
      if (!ready && perfNow() - t0 >= START_SLICE_MS) break;
    }
    if (!ready) { this._scheduleRequest(); return; }
    this._reqOn = false;
    this.start(this._reqLevel, this._reqSeed);
  }

  // -------------------------------------------------------------------------------------------
  // Generated scripts: memo + idle prefetch (QA LVL-18)
  // -------------------------------------------------------------------------------------------

  /**
   * Seed a campaign level plays with when start() gets none: LEVELS.seedBase + L, and (round-3 QA LVL-21) after k
   * consecutive failures of a generated level in this session + k·LEVELS.curve.retrySeedStep — every retry is a fresh
   * layout (an authored level keeps its seed: GDD §11 replays L1 with seed 1001).
   */
  _defaultSeed(level) {
    const authored = LEVELS.authored[level];
    if (authored) return authored.seed;
    const step = LEVELS.curve.retrySeedStep | 0;
    return LEVELS.seedBase + level + step * (this._failStreak.get(level) | 0);
  }

  /**
   * The generated (deep-frozen, read-only) script for campaign level `level` and seed `seed`: from the memo when
   * present, else generateLevel synchronously (a cache miss; its time lands in ctx.debug.levelGenMs).
   */
  _generatedScript(level, seed) {
    const curveL = Math.min(level, LEVELS.curve.loopAfter);
    const key = curveL + '|' + seed;
    const hit = this._scriptCache.get(key);
    if (hit) { this._noteGen(0, true); return hit; }
    const t0 = perfNow();
    // a prefetch already under way for this key: finish its remaining attempts instead of starting over
    let gen = null;
    for (let i = 0; i < this._prefetchQueue.length; i++) {
      if (this._prefetchQueue[i].key === key && this._prefetchQueue[i].gen) { gen = this._prefetchQueue[i].gen; this._prefetchQueue.splice(i, 1); break; }
    }
    let raw = null;
    if (gen) { while (raw === null) raw = gen.step(); } else raw = generateLevel(curveL, seed);
    const script = freezeScript(raw);
    this._noteGen(perfNow() - t0, false);
    this._cacheScript(key, script);
    return script;
  }

  _cacheScript(key, script) {
    if (this._scriptCache.size >= SCRIPT_CACHE_MAX) {
      const first = this._scriptCache.keys().next().value;     // oldest entry (a Map keeps insertion order)
      this._scriptCache.delete(first);
    }
    this._scriptCache.set(key, script);
  }

  /** Debug: generate time of the last level start (0 on a memo hit) and the hit / miss counters. */
  _noteGen(ms, hit) {
    this._lastGenMs = ms;
    const dbg = this.ctx.debug;
    if (!dbg) return;
    dbg.levelGenMs = Math.round(ms * 10) / 10;
    dbg.levelGenHits = (dbg.levelGenHits | 0) + (hit ? 1 : 0);
    dbg.levelGenMisses = (dbg.levelGenMisses | 0) + (hit ? 0 : 1);
  }

  /**
   * Queues campaign level `level` (default seed unless given) for generation in idle time (requestIdleCallback with
   * a PREFETCH_IDLE_TIMEOUT_MS timeout, else a setTimeout). Authored levels and cached scripts are skipped.
   */
  prefetch(level, seed) {
    const L = Math.max(1, Math.floor(Number(level) || 0));
    if (!L || LEVELS.authored[L]) return;
    const s = (seed !== undefined && seed !== null && Number.isFinite(seed)) ? (seed >>> 0) : this._defaultSeed(L);
    const key = Math.min(L, LEVELS.curve.loopAfter) + '|' + s;
    if (this._scriptCache.has(key)) return;
    for (let i = 0; i < this._prefetchQueue.length; i++) if (this._prefetchQueue[i].key === key) return;
    this._prefetchQueue.push({ key, level: L, seed: s, gen: null });   // gen: levelGenerator once the first attempt ran
    this._schedulePrefetch();
  }

  _schedulePrefetch() {
    if (this._prefetchPending || this._prefetchQueue.length === 0) return;
    this._prefetchPending = true;
    const run = (deadline) => { this._prefetchPending = false; this._runPrefetch(deadline); };
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && typeof g.requestIdleCallback === 'function') g.requestIdleCallback(run, { timeout: PREFETCH_IDLE_TIMEOUT_MS });
    else if (g && typeof g.setTimeout === 'function') g.setTimeout(run, PREFETCH_FALLBACK_MS);
    else this._prefetchPending = false;
  }

  /** Generation attempts for the queued scripts while the idle slot lasts (one attempt at least; levelgen's
   *  levelGenerator keeps a partial generation across slots); never while a run is being played (menus / results). */
  _runPrefetch(deadline) {
    const st = this.ctx.state;
    if (st && (st.is('playing') || st.is('paused'))) { this._prefetchQueue.length = 0; return; }
    const t0 = perfNow();
    const hasDeadline = !!(deadline && typeof deadline.timeRemaining === 'function');
    let first = true;
    while (this._prefetchQueue.length > 0) {
      const job = this._prefetchQueue[0];
      if (this._scriptCache.has(job.key)) { this._prefetchQueue.shift(); continue; }
      if (!first && (hasDeadline ? deadline.timeRemaining() < PREFETCH_MIN_LEFT_MS : perfNow() - t0 >= PREFETCH_SLICE_MS)) break;
      first = false;
      try {
        if (!job.gen) job.gen = levelGenerator(Math.min(job.level, LEVELS.curve.loopAfter), job.seed);
        const raw = job.gen.step();
        if (raw !== null) { this._prefetchQueue.shift(); this._cacheScript(job.key, freezeScript(raw)); }
      } catch (err) {
        this._prefetchQueue.shift();
        warnOnce('level.prefetch', 'level prefetch failed: ' + (err && err.message ? err.message : err));
      }
    }
    this._schedulePrefetch();
  }

  /** state:change → idle prefetch of the script the next tap most likely starts (QA LVL-18). */
  _onStateChange(p) {
    if (!p) return;
    if (this._reqOn && p.to !== this._reqState) this._cancelRequest();   // round 5: a pending menu start leaves with its menu
    const save = this.ctx.save;
    const highest = save && save.data ? Math.max(1, save.data.highestUnlocked | 0) : 1;
    switch (p.to) {
      case 'complete':
        if (!this._endless && this._level > 0) this.prefetch(this._level + 1);
        break;
      case 'gameover':
        if (!this._endless && this._level > 0) this.prefetch(this._level, this._defaultSeed(this._level));   // RETRY (rerolled seed, round-3 QA LVL-21)
        break;
      case 'title':
      case 'levels':
        this.prefetch(highest);
        if (!this._endless && this._level > 0) this.prefetch(this._level);
        // round 5 integration: the levels screen also queues every other unlocked level, nearest the frontier first, so a
        // tile tap is a memo hit (requestStart generates a miss in frame slices anyway); skipped / deduplicated by prefetch()
        if (p.to === 'levels') for (let L = Math.min(highest, LEVELS.count) - 1; L >= 2; L--) this.prefetch(L);
        break;
      default:
        break;
    }
  }

  /** Endless run: the same list with the endless pseudo-script seeded from generateChunk(1, seed, 0). */
  startEndless(seed) {
    this._cancelRequest();                                // round 5: a pending menu start is dropped
    this._commitPending();                                // QA LVL-19
    const cfg = this.ctx.config;
    let runSeed;
    if (seed !== undefined && seed !== null && Number.isFinite(seed)) runSeed = seed >>> 0;
    else if (cfg && cfg.seed !== undefined && cfg.seed !== null && Number.isFinite(cfg.seed)) runSeed = cfg.seed >>> 0;
    else runSeed = Date.now() & ENDLESS_SEED_MASK;   // ARCH §6.1 endless default seed
    const script = newEndlessScript(runSeed);
    const first = generateChunk(1, runSeed, 0);
    for (let i = 0; i < first.length; i++) script.events.push(first[i]);
    this._level = endlessEquivalentLevel(1);
    this._endless = true;
    this._difficulty = 1;
    this._chunkEnd = LEVELS.endless.chunk;
    this._bandMid = bandMidFor(this._level);
    this._beginRun(script, runSeed);
  }

  /**
   * Same level, same seed (endless: same seed too — the whole chunk sequence replays) — except a campaign RETRY after a
   * failure (round-3 QA LVL-21): with a fail streak the default seed is rerolled (_defaultSeed), so the retry is a fresh layout.
   */
  restart() {
    if (this._endless) this.startEndless(this._seed);
    else this.start(this._level, (this._failStreak.get(this._level) | 0) > 0 ? undefined : this._seed);   // round-3 QA LVL-21: RETRY after a fail rerolls
  }

  /** The one entry into the title idle scene (also called by main at boot): undo list, cleanup, title state. */
  quitToTitle() {
    const ctx = this.ctx;
    this._cancelRequest();                                // round 5: a pending menu start is dropped
    this._commitPending();                                // QA LVL-19: a boss kill / game over left during its theatre
    // DISTRICTS.md §3.5: the title shows the district of the highest unlocked level (snap)
    const save = ctx.save;
    this._district = districtForLevel(save && save.data ? Math.max(1, save.data.highestUnlocked | 0) : 1);
    this._undoRuntimeState(WORLD.idleRoadSpeed);
    this._applyDistrict(0);
    if (ctx.zombies) ctx.zombies.killAll('cleanup');
    this._resetSystems();
    this._setPhase('idle');
    this._finished = false;
    this._committed = false;
    this._resultData = null;
    this._cursor = 0;
    this._finishAt = 0;
    this._runupActive = false;
    this._lossHint = null;
    this._pendingEvent = null;
    this._clearGateTables();
    this._clearRunState();
    this._idleDist = 0;
    this._idleNextGate = 0;                 // a decorative pair spawns on the first idle step
    this._roadTarget = WORLD.idleRoadSpeed;
    ctx.state.set('title');
    if (ctx.render) ctx.render.idleCamera(true);
    if (ctx.audio) ctx.audio.setMusic('menu');
    this._emitDistrict(0, 'title', false);
  }

  // -------------------------------------------------------------------------------------------
  // Visual districts (DISTRICTS.md §3, §8.5)
  // -------------------------------------------------------------------------------------------

  /** render.setDistrict(this._district, seconds) — 0 snaps before the next draw; render forwards to the environment. */
  _applyDistrict(seconds) {
    const render = this.ctx.render;
    if (render && typeof render.setDistrict === 'function') render.setDistrict(this._district, seconds);
  }

  /** district:change { id, name, index, label, accent, seconds, reason, banner, first, step, steps } for the district shown
   *  (reused payload). Round 7 (r7, explain:4): `first` — the big "NEW DISTRICT" card (a district's first level, an
   *  endless start or rotation); `step` / `steps` — the campaign level's place in its district (k / 5; 0 in endless). */
  _emitDistrict(seconds, reason, banner, first) {
    const d = this._district;
    if (!d) return;
    const per = DISTRICT_RULES.levelsPerDistrict > 0 ? DISTRICT_RULES.levelsPerDistrict : 5;
    P_DISTRICT.id = d.id;
    P_DISTRICT.name = d.name;
    P_DISTRICT.index = d.index;
    P_DISTRICT.label = d.label;
    P_DISTRICT.accent = d.accent;
    P_DISTRICT.seconds = seconds;
    P_DISTRICT.reason = reason;
    P_DISTRICT.banner = !!banner;
    P_DISTRICT.first = !!first;
    P_DISTRICT.step = this._endless || reason === 'title' ? 0 : ((Math.max(1, this._level) - 1) % per) + 1;
    P_DISTRICT.steps = per;
    this.ctx.events.emit('district:change', P_DISTRICT);
  }

  /** The district's fog near (run-up: its runupNear), falling back to WORLD.fog. */
  _districtFogNear(runup) {
    const f = this._district ? this._district.fog : null;
    if (runup) return f && f.runupNear > 0 ? f.runupNear : WORLD.fog.runupNear;
    return f && f.near > 0 ? f.near : WORLD.fog.near;
  }

  /** The tier's fog far × the district's farScale (DISTRICTS.md §6.2). */
  _districtFogFar() {
    const f = this._district ? this._district.fog : null;
    return this._fogFar() * (f && f.farScale > 0 ? f.farScale : 1);
  }

  /**
   * Endless rotation (DISTRICTS.md §3.2), checked every step while the district of the chunk the squad is in differs from
   * the one shown. Starts the 4 s cross-fade at the first step where (b) no fired gate event is still between the spawn
   * line and fadeGateClearZ, (c) the next gate event spawns ≥ fadeNextGateFrac·fadeSeconds·roadSpeed ahead and (d) no
   * (mini-)boss is alive — or anyway fadeDeferMaxM past the boundary. (a) holds by construction: the chunk index already
   * crossed the boundary. Allocation-free; the forward scan for the next gate event runs only while a rotation is due.
   */
  _stepDistrictRotation() {
    const target = districtForChunk(this._difficulty);
    if (!target || target === this._district) return;
    const w = this.ctx.world;
    const R = DISTRICT_RULES;
    const per = R.endlessChunksPerDistrict > 0 ? R.endlessChunksPerDistrict : 1;
    const boundaryM = Math.floor((this._difficulty - 1) / per) * per * LEVELS.endless.chunk;
    const forced = w.distance - boundaryM >= R.fadeDeferMaxM;
    if (!forced) {
      if (w.bossActive) return;                                                               // (d)
      if (w.distance - this._lastGatesAt < -WORLD.spawnZ + R.fadeGateClearZ) return;          // (b)
      const evs = this._script.events;
      for (let i = this._cursor; i < evs.length; i++) {                                       // (c)
        const ev = evs[i];
        if (ev.type !== 'gates') continue;
        if (ev.at - w.distance < R.fadeNextGateFrac * R.fadeSeconds * w.roadSpeed) return;
        break;
      }
    }
    this._district = target;
    this._applyDistrict(R.fadeSeconds);
    this._emitDistrict(R.fadeSeconds, 'rotate', true, true);   // r7 (explain:4): an endless rotation gets the big card
  }

  // -------------------------------------------------------------------------------------------
  // Shared run setup
  // -------------------------------------------------------------------------------------------

  /**
   * The §6.16 undo list, applied BEFORE systems are reset: leftover engine / render / ui / audio state from a
   * pause, slow-mo, boss intro, game over or the title scene is cleared, and ctx.world is overwritten in place.
   */
  _undoRuntimeState(roadSpeed) {
    const ctx = this.ctx;
    const engine = ctx.engine;
    if (engine) {
      if (ctx.state && ctx.state.is('paused')) engine.resume();
      engine.setTimeScale(1, 0);
      engine.lockInput(false);
      engine.resetLevelClock();
      engine.resetSteering();
    }
    const w = ctx.world;
    w.roadSpeedBase = roadSpeed;
    w.roadSpeed = roadSpeed;
    w.distance = 0;
    w.squadX = 0;
    w.squadHalfWidth = 0;
    w.squadDepth = 0;
    w.squadCount = 0;
    w.invulnerable = false;
    w.bossActive = false;
    w.bossZ = 0;
    w.bossX = 0;
    const render = ctx.render;
    if (render) {
      render.cancelDolly();
      render.setBloomStrength();                         // DISTRICTS.md §8.5: no argument = the district's bloom base
      render.setDesaturate(0);
      render.gameOverCamera(false);
      render.idleCamera(false);
      if (render.env) render.env.setFog(this._districtFogNear(false), this._districtFogFar(), 0);
    }
    if (ctx.audio) ctx.audio.duck(0, 0);
    if (ctx.weapons) ctx.weapons.pauseTimers(false);
  }

  /** reset() every system in the §6 order (squad last so its squad:count start event sees an empty world). */
  _resetSystems() {
    const ctx = this.ctx;
    for (let i = 0; i < RESET_ORDER.length; i++) {
      const sys = ctx[RESET_ORDER[i]];
      if (sys && typeof sys.reset === 'function') sys.reset();
    }
  }

  _fogFar() {
    const q = this.ctx.quality;
    return q && q.params ? q.params.fogFar : WORLD.fog.far;
  }

  _propDensity() {
    const q = this.ctx.quality;
    return q && q.params ? q.params.propDensity : QUALITY_TIERS.high.propDensity;
  }

  /** Common body of start()/startEndless(): undo list → RNGs → RunStats → environment → system resets → playing. */
  _beginRun(script, seed) {
    const ctx = this.ctx;
    this._script = script;
    this._seed = seed;
    // DISTRICTS.md §3.1 / §8.5: the run's district snaps (seconds 0) after the undo list and before env.setLevel. Round 7
    // (r7, explain:4): the banner shows at EVERY run start, retries included (a small "NAME · k/5" tag); the big "NEW
    // DISTRICT" card only on a district's first level (and an endless start) when the previous run this session was not the
    // same level — the old rule showed one identical pill at every new level's start and none on a retry
    this._district = this._endless ? districtForChunk(1) : districtForLevel(this._level);
    const runKey = this._endless ? -1 : this._level;
    const per = DISTRICT_RULES.levelsPerDistrict > 0 ? DISTRICT_RULES.levelsPerDistrict : 5;
    const firstOfDistrict = runKey !== this._lastRunKey && (this._endless || (this._level - 1) % per === 0);
    this._lastRunKey = runKey;
    this._spawningEv = null;
    this._gateEv.fill(-1);
    this._lesserEv = -1;
    this._crateHintUp = false;
    this._bossArch = '';
    this._zSeenRun.fill(0);
    this._runCards.length = 0;
    this._lastGatesAt = -1e9;
    this._undoRuntimeState(script.roadSpeed);
    this._applyDistrict(0);

    ctx.rng = new Rng(seed);
    ctx.rngFx = ctx.rng.fork(RNG_FX_OFFSET);

    const save = ctx.save;
    const rec = (!this._endless && save && save.data && save.data.levels) ? save.data.levels[this._level] : null;
    const replay = !!(rec && rec.clears > 0);
    ctx.run = newRunStats(this._level, seed, this._endless, script, replay);

    if (ctx.render && ctx.render.env) ctx.render.env.setLevel(seed, this._propDensity());
    this._resetSystems();

    // cursor + run state
    this._cursor = 0;
    this._finished = false;
    this._committed = false;
    this._resultData = null;
    this._progressAcc = 0;
    this._finishAt = 0;
    this._bossReached = false;
    this._pendingEvent = null;
    this._roadTarget = script.roadSpeed;
    this._runupActive = false;
    this._runupIndex = 0;
    this._runupTimer = 0;
    this._runupUnits = null;
    this._runupWave = null;
    this._runupHp = null;
    this._waveHz = 1;
    this._lossHint = null;
    this._waveCount = 0;
    this._lossesThisWave = 0;
    this._clearGateTables();
    this._clearRunState();
    this._bossAt = this._findBossAt(script);
    // round 5 integration: the boss-path warm-up runs BOSS_WARM_LEAD_M before the campaign boss (endless: each mini-boss
    // chunk arms it when appended, _appendChunk)
    this._bossWarmEv = null;
    this._bossWarmAt = -1;
    if (!this._endless) this._armBossWarm(script.events, 0);
    this._setPhase('run');

    if (ctx.engine) ctx.engine.freezeQuality(QUALITY_TIERS.scaler.freezeLevelStart);
    ctx.state.set('playing');

    P_START.level = this._level;
    P_START.seed = seed;
    P_START.endless = this._endless;
    P_START.script = script;
    P_START.district = this._district.id;
    ctx.events.emit('level:start', P_START);
    this._emitDistrict(0, 'start', true, firstOfDistrict);
    // r7 (teaching:5): the FIELD GUIDE's controls and the road bar are met at the first run
    this._codexSeen('ctl.steer', false); this._codexSeen('ctl.pause', false); this._codexSeen('ctl.mute', false);
    if (!this._endless) this._codexSeen('hud.progress', false);
  }

  _findBossAt(script) {
    const evs = script.events;
    for (let i = 0; i < evs.length; i++) if (evs[i].type === 'boss') return evs[i].at;
    return script.length;
  }

  _clearGateTables() {
    this._evIds.fill(-1);
    this._evScript.fill(null);
    this._gateIds.fill(-1);
    this._gateLane.fill(null);
    this._gateHits.fill(0);
    this._gateEv.fill(-1);
  }

  _setPhase(p) {
    this._phase = p;
    const run = this.ctx.run;
    if (run) run.phase = p;
  }

  // -------------------------------------------------------------------------------------------
  // E(z)
  // -------------------------------------------------------------------------------------------

  /** Linear interpolation of script.expected [{at, e}] by distance (clamped at both ends); endless: the chunk formula. */
  _expectedAt(d) {
    if (this._endless) {
      // round 5d audit (docs/build/r5d-audit.md): read in the script's frame — after a mini-boss hold every event `at` carries the
      // accumulated shift (_releaseHold), so the road at d was generated for chunk ⌊(d − _holdShiftM) / chunk⌋ + 1 (as
      // _guardEndlessGate reads it); without this the waves' HP cap and solve took E of the next chunk (+6 %, +12 % after a long fight)
      const difficulty = Math.max(1, Math.floor((d - this._holdShiftM) / LEVELS.endless.chunk) + 1);
      return endlessE(difficulty);
    }
    const script = this._script;
    if (!script) return 1;
    const pts = script.expected;
    const n = pts ? pts.length : 0;
    if (n === 0) return script.eBoss || 1;
    if (d <= pts[0].at) return pts[0].e;
    const last = pts[n - 1];
    if (d >= last.at) return last.e;
    for (let i = 1; i < n; i++) {
      const b = pts[i];
      if (d <= b.at) {
        const a = pts[i - 1];
        const span = b.at - a.at;
        if (span <= 0) return b.e;
        return a.e + (b.e - a.e) * ((d - a.at) / span);
      }
    }
    return last.e;
  }

  /** Base road speed used by the leak solves: script.roadSpeed (endless: the current chunk's speed). */
  _baseSpeed() { return this.ctx.world.roadSpeedBase; }

  // -------------------------------------------------------------------------------------------
  // Fixed step (ARCH §4.2 B, first system in the loop) — allocation-free
  // -------------------------------------------------------------------------------------------

  step(dt) {
    const ctx = this.ctx;
    const w = ctx.world;
    const run = ctx.run;
    const script = this._script;
    if (!script) return;

    // road speed + distance: the boss slow-down is a linear tween over BOSSES.intro.roadLerp s (GDD §7, QA LVL-13),
    // every other change eases exponentially
    if (this._roadTweenT >= 0) {
      this._roadTweenT += dt;
      const dur = BOSSES.intro.roadLerp > 0 ? BOSSES.intro.roadLerp : 1e-6;
      const u = this._roadTweenT >= dur ? 1 : this._roadTweenT / dur;
      w.roadSpeed = this._roadTweenFrom + (this._roadTweenTo - this._roadTweenFrom) * u;
      if (u >= 1) this._roadTweenT = -1;
    } else {
      w.roadSpeed = lerpExp(w.roadSpeed, this._roadTarget, LEVELS.curve.roadLerpRate, dt);
    }
    w.distance += w.roadSpeed * dt;
    run.distance = w.distance;
    run.elapsed += dt;
    // QA LVL-29: this runner's theatre clock — real time per simulated step (no steps while paused)
    const ts = ctx.time && ctx.time.scale > 0 ? ctx.time.scale : 1;
    this._theatreMs += (dt / ts) * 1000;

    const live = this._phase !== 'won' && this._phase !== 'lost';
    if (live && this._lastDistance >= 0 && w.distance - this._lastDistance > LEVELS.curve.staleEventSkipM) this._onDistanceJump();
    this._lastDistance = w.distance;

    if (live) {
      // endless: chunk boundary (speed / equivalent level) and buffered append
      if (this._endless) this._stepEndless(dt);

      // script cursor: every event with at ≤ distance, in order. An event more than staleEventSkipM behind the
      // distance can only come from a debug jump (normal play advances ≤ ~1 m per step): it is consumed without
      // spawning, except the run-up and the boss (QA LVL-11)
      const evs = script.events;
      const stale = LEVELS.curve.staleEventSkipM;
      while (this._cursor < evs.length && evs[this._cursor].at <= w.distance) {
        const ev = evs[this._cursor];
        // round 5d (GDD §10.1): while an endless mini-boss is alive the road's events wait — the cursor stops at the first
        // gates / wave / crate / coins event until _releaseHold slides it (and everything behind it) past the kill; chunk,
        // district and score bookkeeping go on above, the boss's own minions are boss.js's
        if (this._holdOn && HOLD_TYPES[ev.type] === true) break;
        this._cursor++;
        if (w.distance - ev.at > stale && ev.type !== 'runup' && ev.type !== 'boss') continue;
        this._fireEvent(ev);
      }

      // staggered wave parts whose spawn distance has come
      if (this._partCount > 0) this._stepParts(w.distance, stale);

      // run-up bursts
      if (this._runupActive) this._stepRunup(dt);

      // r7 fix round 3: the held "GRAB THE CRATE" comes down (or leaves the queue unshown) once no closed crate is left
      // ahead — its crate passed the squad unopened (pickups: ≤ 8 slots, only while the hint is up)
      if (this._crateHintUp) {
        const pk = ctx.pickups;
        if (!pk || !pk.hasClosedCrateAhead()) { this._crateHintUp = false; this._release(RELEASE_CRATE); }
      }

      // round 5 integration: the boss hand-off's helpers, once, BOSS_WARM_LEAD_M before the boss event
      if (this._bossWarmAt >= 0 && w.distance >= this._bossWarmAt) this._warmBossPath();
    }

    // level:progress at JUICE.ui.hudHz (10 Hz)
    this._progressAcc += dt;
    if (this._progressAcc >= 1 / JUICE.ui.hudHz) {
      this._progressAcc -= 1 / JUICE.ui.hudHz;
      this._emitProgress();
    }

    // theatre deadlines (real time, unaffected by slow-mo, frozen while paused — QA LVL-29)
    if (!this._finished && this._finishAt > 0 && this._theatreNow() >= this._finishAt) {
      this._finishAt = 0;
      this.finish(this._phase === 'won');
    }
  }

  /**
   * Theatre clock (ms) for the results / game-over deadlines (ARCH §2.2: theatre timers span slow-mo, not pauses):
   * ctx.time.theatre (CORE-7) when the engine provides it, else this runner's own step-driven clock.
   */
  _theatreNow() {
    const t = this.ctx.time;
    return (t && Number.isFinite(t.theatre)) ? t.theatre : this._theatreMs;
  }

  _emitProgress() {
    const w = this.ctx.world;
    const script = this._script;
    // QA LVL-32: after squad:dead the HUD shows the distance where the squad was lost (= the results distance), rounded as
    // the results round it (_commitEndless: Math.round; the HUD label floors, so 36.6 m read 36 m over a 'Distance 37 m' card)
    const d = (this._phase === 'lost' && this._deathDistance >= 0) ? Math.round(this._deathDistance) : w.distance;
    if (this._endless) {
      // progress within the chunk the squad is in (the next chunk is appended LEVELS.endless.bufferM early)
      const chunk = LEVELS.endless.chunk;
      const start = (this._difficulty - 1) * chunk;
      P_PROGRESS.distance = d;
      P_PROGRESS.length = this._difficulty * chunk;
      P_PROGRESS.fraction = clamp((d - start) / chunk, 0, 1);
    } else {
      P_PROGRESS.distance = d;
      P_PROGRESS.length = script.length;
      P_PROGRESS.fraction = script.length > 0 ? clamp(d / script.length, 0, 1) : 0;
    }
    this.ctx.events.emit('level:progress', P_PROGRESS);
  }

  /** Endless per-step: difficulty switch at chunk starts, chunk append LEVELS.endless.bufferM early, streak scoring. */
  _stepEndless(dt) {
    const ctx = this.ctx;
    const w = ctx.world;
    const run = ctx.run;
    const chunk = LEVELS.endless.chunk;

    // the chunk the squad is in right now
    const d = Math.floor(w.distance / chunk) + 1;
    if (d !== this._difficulty) {
      this._difficulty = d;
      this._level = endlessEquivalentLevel(d);
      run.level = this._level;
      this._bandMid = bandMidFor(this._level);
      w.roadSpeedBase = endlessSpeed(d);
      run.roadSpeedBase = w.roadSpeedBase;
      this._script.roadSpeed = w.roadSpeedBase;
      this._script.eBoss = endlessE(d);
      run.eBoss = this._script.eBoss;
      if (this._phase === 'run') this._roadTarget = w.roadSpeedBase;
    }

    // append the next chunk before the horizon reaches the current end
    if (w.distance >= this._chunkEnd - LEVELS.endless.bufferM) this._appendChunk();

    // DISTRICTS.md §3.2: district rotation every endlessChunksPerDistrict chunks (4 s cross-fade in a gate-clear window)
    this._stepDistrictRotation();

    // score: metres × streak multiplier; the streak doubles every streakSeconds without a death
    const sc = SCORE.endless;
    run.streakSeconds += dt;
    while (run.streakSeconds >= sc.streakSeconds) {
      run.streakSeconds -= sc.streakSeconds;
      run.streakMult *= sc.streakMult;
    }
    // round-3 QA LVL-17: the score rewards surviving pressure — every endless score term × the chunk's pressure factor
    run.score += w.roadSpeed * dt * sc.metre * run.streakMult * this._scorePressure();
  }

  /** Round-3 QA LVL-17: endless score multiplier = the pressure factor (SCORE.endless.pressure: true), else 1. */
  _scorePressure() {
    return SCORE.endless.pressure ? endlessPressure(this._difficulty) : 1;
  }

  /** generateChunk(D + 1, seed, chunkEnd) → appended to script.events; rubber band (GDD §10.1); endless:chunk. */
  _appendChunk() {
    const ctx = this.ctx;
    const run = ctx.run;
    const nextD = Math.floor(this._chunkEnd / LEVELS.endless.chunk) + 1;
    // round 5d: generated in the shifted frame — every metre a mini-boss hold has slid the script so far (_releaseHold)
    const events = generateChunk(nextD, this._seed, this._chunkEnd + this._holdShiftM);
    this._applyRubberBand(events, nextD);
    const list = this._script.events;
    for (let i = 0; i < events.length; i++) list.push(events[i]);
    if (this._bossWarmAt < 0) this._armBossWarm(events, 0);   // round 5: a mini-boss chunk arms the boss-path warm-up
    this._chunkEnd += LEVELS.endless.chunk;
    this._script.length = this._chunkEnd;
    run.length = this._chunkEnd;
    run.chunks++;
    P_CHUNK.index = nextD - 1;      // 0-based chunk index
    P_CHUNK.difficulty = nextD;     // D
    ctx.events.emit('endless:chunk', P_CHUNK);
  }

  /**
   * GDD §10.1 rubber band, low side only (round-3 QA LVL-17: the band only ever helps): when a chunk is appended with
   * C < rubber.low, its first gate event becomes a guaranteed + pair with base max(lowBase, lowFrac·E) and no red lane.
   * A squad above the curve is never pulled back by a gate — _guardEndlessGate only stops gates from carrying it past
   * keepMult·E, and the pressure ends the run. Lanes come from gateDefaults so every cap is filled (D19). Frozen chunk
   * events are left untouched.
   */
  _applyRubberBand(events, difficulty) {
    const squad = this.ctx.squad;
    if (!squad) return;
    const rb = LEVELS.endless.rubber;
    if (!(squad.count < rb.low)) return;
    let ev = null;
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === 'gates') { ev = events[i]; break; }
    }
    if (!ev || Object.isFrozen(ev)) return;
    const e = endlessE(difficulty);
    const v = endlessSpeed(difficulty);
    const value = Math.max(rb.lowBase, Math.round(rb.lowFrac * e));
    const d = gateDefaults('+', value, e, v);
    ev.layout = 'pair';
    ev.lanes = [{ op: '+', value, cap: d.cap }, { op: '+', value, cap: d.cap }];
    ev.guards = undefined;
  }

  /**
   * Round 5d (GDD §10.1): the end of the mini-boss hold (boss:dead). Every script event still ahead of the cursor — the held
   * ones and every later one — and every chunk appended from now on (_appendChunk generates in the shifted frame) slide by one
   * shift so the first held event spawns LEVELS.endless.miniBossHold.releaseM after the kill: the road's rhythm (gate → wave
   * spacing, chunk after chunk) is kept whole, nothing is dropped, and nothing lands on the squad's cleanup of the boss's last
   * horde (the zombies already on the road stay). A fast kill whose next event already lies farther ahead shifts nothing.
   * Chunk, district and score bookkeeping never used the script frame. In-place `at` rewrites of this run's own (never frozen)
   * events; no allocation.
   */
  _releaseHold() {
    if (!this._holdOn) return;
    this._holdOn = false;
    const hold = LEVELS.endless.miniBossHold;
    const release = hold && hold.releaseM >= 0 ? hold.releaseM : 0;
    const evs = this._script ? this._script.events : null;
    const i0 = this._cursor;
    if (!evs || i0 >= evs.length || Object.isFrozen(evs[i0])) return;
    const shift = this.ctx.world.distance + release - evs[i0].at;
    if (!(shift > 0)) return;
    for (let i = i0; i < evs.length; i++) evs[i].at += shift;
    this._holdShiftM += shift;
    // the boss-path warm-up of a mini-boss chunk already appended follows its event
    if (this._bossWarmEv && this._bossWarmAt >= 0) this._bossWarmAt = Math.max(0, this._bossWarmEv.at - BOSS_WARM_LEAD_M);
    const dbg = this.ctx.debug;
    if (dbg) dbg.holdShiftM = Math.round(this._holdShiftM);
  }

  /** Spawns every queued wave part whose distance has come (swap-remove; stale parts after a debug jump are dropped). */
  _stepParts(distance, stale) {
    const zombies = this.ctx.zombies;
    let i = 0;
    while (i < this._partCount) {
      if (this._partAt[i] > distance) { i++; continue; }
      if (zombies && distance - this._partAt[i] <= stale) zombies.spawnWave(this._partWave[i], this._partHp[i]);
      const last = this._partCount - 1;
      this._partAt[i] = this._partAt[last];
      this._partWave[i] = this._partWave[last];
      this._partHp[i] = this._partHp[last];
      this._partWave[last] = null;
      this._partHp[last] = null;
      this._partCount = last;
    }
  }

  /** Spawns the next run-up burst every burstGap seconds until `bursts` bursts have gone out. */
  _stepRunup(dt) {
    this._runupTimer -= dt;
    while (this._runupActive && this._runupTimer <= 0) {
      this._spawnRunupBurst(this._runupIndex);
      this._runupIndex++;
      this._runupTimer += this._runupGap;
      if (this._runupIndex >= this._runupBursts) this._runupActive = false;
    }
  }

  /** Burst i gets floor(n·(i+1)/B) − floor(n·i/B) of each type so the bursts sum exactly to the event's units. */
  _spawnRunupBurst(i) {
    const zombies = this.ctx.zombies;
    const wave = this._runupWave;
    const units = this._runupUnits;
    const b = this._runupBursts;
    if (!zombies || !wave || !units) return;
    let total = 0;
    for (let k = 0; k < TYPES.length; k++) {
      const t = TYPES[k];
      const n = units[t] | 0;
      if (wave.units[t] === undefined) continue;
      const cnt = Math.floor((n * (i + 1)) / b) - Math.floor((n * i) / b);
      wave.units[t] = cnt;
      total += cnt;
    }
    if (total > 0) zombies.spawnWave(wave, this._runupHp);
  }

  // -------------------------------------------------------------------------------------------
  // Title idle scene (ARCH §4.2 / §6.16)
  // -------------------------------------------------------------------------------------------

  /** squad.step + gates.step only; decorative gate pair every WORLD.idleGateEveryM metres; no zombies, bullets or coins. */
  idleStep(dt) {
    const ctx = this.ctx;
    const w = ctx.world;
    w.roadSpeed = WORLD.idleRoadSpeed;
    w.roadSpeedBase = WORLD.idleRoadSpeed;
    this._idleDist += w.roadSpeed * dt;
    w.distance = this._idleDist;
    if (this._idleDist >= this._idleNextGate) {
      this._idleNextGate += WORLD.idleGateEveryM;
      if (ctx.gates) ctx.gates.spawnEvent(IDLE_GATE_EVENT);
    }
    if (ctx.squad) ctx.squad.step(dt);
    if (ctx.gates) ctx.gates.step(dt);
  }

  // -------------------------------------------------------------------------------------------
  // Script events
  // -------------------------------------------------------------------------------------------

  _fireEvent(ev) {
    switch (ev.type) {
      case 'gates': this._fireGates(ev); break;
      case 'wave': this._fireWave(ev); break;
      case 'crate': this._fireCrate(ev); break;
      case 'coins': this._fireCoins(ev); break;
      case 'hint': this._fireHint(ev); break;
      case 'runup': this._fireRunup(ev); break;
      case 'boss': this._fireBoss(ev); break;
      default: warnOnce('level.event.' + ev.type, 'unknown script event type ' + ev.type); break;
    }
  }

  /** A script 'hint' row. Round 7 (r7, teaching:0 B): "GRAB THE CRATE" (L1) stays until a crate opens or an item is picked
   *  up (hint:release 'crate'), at most JUICE.ui.crateHintHoldSeconds — it was a flat 2.5 s, often cut to 1.5 s. r7 fix
   *  round 2: the row trails its crate's spawn by LEVELS.curve.crateHintAfterM, and a squad in the crate's lane can shoot
   *  it open first — with no closed crate left ahead the row shows nothing (the release only came with a LATER crate, so
   *  the caption stayed its full 6 s over an opened crate: L6, fresh save). Unshown, it stays unmarked for a later crate.
   *  r7 fix round 3: it is also released once its crate passes the squad unopened (_crateHintUp, step). */
  _fireHint(ev) {
    if (ev.id !== 'crate') { this.showHint(ev.id); return; }
    const pk = this.ctx.pickups;
    if (pk && !pk.hasClosedCrateAhead()) return;
    HOLD.hold = JUICE.ui.crateHintHoldSeconds > 0 ? JUICE.ui.crateHintHoldSeconds : 0;
    HOLD.until = RELEASE_CRATE;
    HOLD.priority = false;
    HOLD.event = -1;
    if (this.showHint(ev.id, undefined, HOLD)) this._crateHintUp = true;
  }

  /**
   * Endless rubber band at every gate event (QA LVL-17, GDD §10.1): when the event spawns, the live count C and the
   * worst-case count after the gate events still ahead of it (C × the best lane of each unpassed event, chained) decide
   * via levelgen.endlessGateGuard: worst case > keepMult·E → no × lanes and + lanes capped at min(plusCapFrac·E,
   * highMult·E − the worst case before it) — gate values stop growing past the E cap (round-3 QA LVL-17: no ÷2 | ÷2
   * pull-back any more; the pressure ends the run). Mutates the endless script event in place.
   */
  _guardEndlessGate(ev) {
    const ctx = this.ctx;
    const squad = ctx.squad;
    if (!squad || Object.isFrozen(ev)) return;
    const w = ctx.world;
    // the chunk the event was generated for (round 5d: its `at` carries the mini-boss hold's shift, _releaseHold)
    const difficulty = Math.max(1, Math.floor((ev.at - this._holdShiftM) / LEVELS.endless.chunk) + 1);
    const E = endlessE(difficulty);
    const v = endlessSpeed(difficulty);
    // prune the events that already reached the squad, then chain the rest
    const arrive = -WORLD.spawnZ;
    let k = 0;
    for (let i = 0; i < this._aheadCount; i++) {
      const g = this._aheadGates[i];
      if (g && g.at + arrive >= w.distance) this._aheadGates[k++] = g;   // not passed yet (gates.step resolves passes after level.step)
    }
    for (let i = k; i < this._aheadCount; i++) this._aheadGates[i] = null;
    this._aheadCount = k;
    const c = squad.count;
    let worst = c;
    for (let i = 0; i < this._aheadCount; i++) worst = eventWorstCase(this._aheadGates[i], worst, v);
    const before = worst;
    worst = eventWorstCase(ev, worst, v);
    const fire = ctx.profile && ctx.profile.fireRate > 0 ? ctx.profile.fireRate : LEAK_MODEL.fireRate;
    const res = endlessGateGuard(ev, c, worst, E, v, fire, before, endlessParams(difficulty).gainCap);
    if (res) this.ctx.run.rubberEvents = (this.ctx.run.rubberEvents | 0) + 1;
    if (this._aheadCount < PENDING_GATES) this._aheadGates[this._aheadCount++] = ev;
  }

  /**
   * r7 (balance:1, GDD §4.4): generated red lanes are sized on the design line E(z), so a squad below it met a −A as large as
   * its whole count (L9 retry seed 1109: ÷2 | −130 at C 117). At spawn every '−' lane of a generated campaign level shows at
   * most LEVELS.curve.redCap.multi (pair / triple) or .single (single) of the live count, on the design grid (roundDesign),
   * never below GATE_RULES.generation.minValue. With redCap.keepFlipCap the lane keeps its authored flipCap (a capped −60 that
   * was −130 still flips up to +130: shooting a red gate blue keeps its payoff); without it flipCap ≤ the cap. Authored levels
   * (L1) and events with nothing to cap are returned as they are; the cached script stays frozen — a capped event is a shallow
   * copy with a new lanes array (one small allocation per capped gate event, event time, never per frame).
   */
  _capRedLanes(ev) {
    const cap = LEVELS.curve.redCap;
    const squad = this.ctx.squad;
    if (!cap || !squad || LEVELS.authored[this._level] || !ev.lanes) return ev;
    const frac = ev.layout === 'single' ? cap.single : cap.multi;
    if (!(frac > 0)) return ev;
    const lim = Math.max(GATE_RULES.generation.minValue, roundDesign(frac * squad.count));
    let lanes = null;
    for (let i = 0; i < ev.lanes.length; i++) {
      const l = ev.lanes[i];
      if (l.op !== '-' || !(l.value > lim)) continue;
      if (!lanes) lanes = ev.lanes.slice();
      const flip0 = l.flipCap > 0 ? l.flipCap : l.value;        // gates' own fallback: flipCap = the spawn value
      lanes[i] = Object.assign({}, l, { value: lim, flipCap: cap.keepFlipCap ? flip0 : Math.min(flip0, lim) });
    }
    if (!lanes) return ev;
    this.ctx.run.redCapped++;
    return Object.assign({}, ev, { lanes });
  }

  /** gates.spawnEvent(ev) + lane guards (12 m ahead of the lane, HP from the leak solve at their contact point). */
  _fireGates(ev) {
    const ctx = this.ctx;
    if (this._bossReached && !this._endless) return;     // gates stop spawning after the boss row (campaign)
    const gates = ctx.gates;
    if (!gates) return;
    this._lastGatesAt = ev.at;                            // DISTRICTS.md §3.2 (b): the last fired gate event
    if (this._endless) this._guardEndlessGate(ev);
    else ev = this._capRedLanes(ev);                      // r7: a campaign red lane never shows more than LEVELS.curve.redCap of C
    this._pendingEvent = ev;
    this._spawningEv = ev;                                // r7: showHint ignores gates' bare forward of ev.hint (below)
    this._spawnTaught = false;
    const eid = gates.spawnEvent(ev);
    this._spawningEv = null;
    this._pendingEvent = null;
    const hasId = eid !== undefined && eid !== null && eid >= 0;
    if (hasId) this._bindEvent(eid, ev);
    // round 7 (r7, teaching:0 B): the event's lesson ('red' / 'single') is held while its gates are on the road — released
    // at their pass, the gates pulsing meanwhile (C's gates.pulseEvent, via ui) — and slowed the first time (ui). The lead's
    // 'lesser' lesson takes the first lesser-evil pair (every lane − or ÷) when no other lesson is shown for it. r7 fix: that
    // includes the 'div' lesson its own ÷ gate taught during spawnEvent (gate:spawn) — on L3's first [÷2 | −13] 'lesser'
    // waited behind 'div' and flashed for 0.64 s after the red lane had flipped; it now waits for the next lesser pair
    const id = hasId ? eid : -1;
    let taught = this._spawnTaught;
    if (ev.hint) taught = this.showHint(ev.hint, undefined, GATE_LESSONS[ev.hint] ? this._gateHold(id) : undefined) || taught;
    if (!taught && this._lesserEvil(ev) && this.showHint('lesser', undefined, this._gateHold(id))) this._lesserEv = id;
    // r7: a special on the road for the first time on a generated level: the gold diamond it rides on the bar (the HUD
    // ticks are the campaign's; the authored L1 teaches its crate itself)
    if (this._hasItemLane(ev)) this._specialsHint();
    if (ev.layout === 'single') this._codexSeen('gate.single', false);
    if (ev.guards && ev.guards.length > 0) this._codexSeen('gate.guards', false);

    const guards = ev.guards;
    if (!guards || guards.length === 0 || !ctx.zombies) return;
    const w = ctx.world;
    const v = this._baseSpeed();
    const centres = WORLD.laneCenters[ev.layout] || WORLD.laneCenters.pair;
    const laneW = WORLD.laneWidth[ev.layout] || WORLD.laneWidth.pair;
    const guardZ = WORLD.spawnZ + WORLD.guardOffset;
    const low = this._lowSideMult(this._expectedAt(w.distance));   // r7: low-side band (C vs the design count now; 1 in endless)
    for (let g = 0; g < guards.length; g++) {
      const guard = guards[g];
      const units = guard.units;
      if (!units) continue;
      if (this._endless) this._clampEndlessUnits(units);    // round 5d: the live pool backstop (the generator fits the chunk statically)
      const laneIdx = clamp(guard.lane | 0, 0, centres.length - 1);
      const laneX = centres[laneIdx];
      const sBar = meanOwnSpeed(units);
      const contactAt = w.distance + ((-WORLD.spawnZ - WORLD.guardOffset) * v) / (v + sBar);
      // QA LVL-15: damped shop-rank scaling (LEAK_MODEL.profileExp); endless: solved at the live count (QA LVL-17); round 5d:
      // endless guards are clamped to the chunk's per-zombie HP cap like its waves (_capEndlessHp); r7: × the low-side band
      const eContact = this._expectedAt(contactAt);
      let hp = scaleHp(guard.hp || solveWaveHp(eContact, v, units, this._bandMid), this._liveHpMult(guard.hp ? eContact : 0) * low);
      if (this._endless) hp = this._capEndlessHp(hp, units, eContact);
      GUARD_OPTS.guardEventId = hasId ? eid : -1;
      GUARD_OPTS.guardLane = laneIdx;
      GUARD_OPTS.lunge = false;
      const n = unitCount(units);
      let placed = 0;
      for (let k = 0; k < TYPES.length; k++) {
        const t = TYPES[k];
        const cnt = units[t] | 0;
        for (let u = 0; u < cnt; u++) {
          // line across the lane, inset by the zombie radius; depth jitter ±10 % of WORLD.guardOffset
          const span = Math.max(0, laneW - 2 * ZOMBIES[t].radius);
          const x = n > 1 ? laneX - span / 2 + (span * (placed + 0.5)) / n : laneX;
          const z = guardZ + ctx.rng.range(-WORLD.guardOffset * 0.1, WORLD.guardOffset * 0.1);
          const unitHp = hp[t] !== undefined ? hp[t] : ZOMBIES[t].baseHp;   // an authored hp record may omit a type
          ctx.zombies.spawn(t, x, z, unitHp, GUARD_OPTS);
          placed++;
        }
      }
    }
  }

  /** Wave: leak solve at the contact point (GDD §6.3) unless authored hp; spawnWave; hz / hints / stats. */
  _fireWave(ev) {
    const ctx = this.ctx;
    const zombies = ctx.zombies;
    const units = ev.units;
    if (!zombies || !units) return;
    if (this._endless) this._crowdEndlessWave(units);
    if (this._endless) this._clampEndlessUnits(units);      // round 5d: the live pool backstop (the generator fits the chunk statically)
    const v = this._baseSpeed();
    const sBar = meanOwnSpeed(units);
    const contactAt = ctx.world.distance + (-WORLD.spawnZ * v) / (v + sBar);
    // authored / baked HP or the live leak solve; `hpMult` scales either (the validator applies it to ev.hp too);
    // QA LVL-15: × p^LEAK_MODEL.profileExp for the shop's fire-rate × damage ranks; QA LVL-17: endless at the live count;
    // round 5d: endless tables are then clamped to the chunk's per-zombie HP cap (_capEndlessHp — the horde grows in numbers);
    // r7: × the campaign low-side band, C against the design count at spawn (not at contact: that E already holds the gain of
    // the gate the squad has not passed yet)
    const eContact = this._expectedAt(contactAt);
    const base = ev.hp ? ev.hp : solveWaveHp(eContact, v, units, this._bandMid);
    let hp = scaleHp(base, (ev.hpMult || 1) * this._liveHpMult(ev.hp ? eContact : 0) * this._lowSideMult(this._expectedAt(ctx.world.distance)));
    if (this._endless) hp = this._capEndlessHp(hp, units, eContact);
    if (ev.lag) this._spawnStaggered(ev, hp);
    else zombies.spawnWave(ev, hp);
    this._noteWaveSpawned(hzOf(hp, units));
    if (ev.hint) this.showHint(ev.hint);
    // r7 (teaching:0 F): an armed loss hint stays armed until a bite shows it — the next wave's spawn used to disarm L1's
    // 'bite', so a player whose wave A took no bite was never told (levelgen also arms the first wave of L2 / L3)
    if (ev.hintOnLoss) this._lossHint = ev.hintOnLoss;
  }

  /**
   * QA LVL-17: an endless squad above E(D) meets a bigger crowd — every type's count × min(LEVELS.endless.crowdMax,
   * √(C / E)), each type within its share of the pool (several waves share the road). Mutates the endless event's
   * units in place before the spawn (endless events are fresh per run, never frozen). Round 5d: the pressure's population
   * part (p^popShare) is baked into the chunk's units by levelgen.endlessParams, so the validator counts the real pools —
   * only the crowd factor (off at crowdMax 1) lives here.
   */
  _crowdEndlessWave(units) {
    const squad = this.ctx.squad;
    const e = endlessE(this._difficulty);
    const c = squad ? squad.count : 0;
    const max = LEVELS.endless.crowdMax > 1 ? LEVELS.endless.crowdMax : 1;
    const k = c > e && max > 1 ? Math.min(max, Math.sqrt(c / e)) : 1;
    if (Object.isFrozen(units) || !(k > 1)) return;
    const share = LEVELS.endless.wavePoolShare > 0 ? LEVELS.endless.wavePoolShare : 4;   // levelgen's WAVE_POOL_SHARE fallback (QA LVL-17: four waves share the road)
    for (let i = 0; i < TYPES.length; i++) {
      const t = TYPES[i];
      const n = units[t] | 0;
      if (n <= 0) continue;
      units[t] = Math.max(n, Math.min(Math.floor(ZOMBIES[t].pool / share), Math.round(n * k)));
    }
  }

  /**
   * Round 5d (GDD §10.1, docs/build/r5d-endless.md): the live backstop of the generator's pool fit — at spawn every type of an endless
   * wave or guard squad is clamped to pool − zombies.aliveOfType − LEVELS.endless.poolReserve (the slots kept for the mini-boss's
   * minions, levelgen.endlessPoolReserve), so a script never asks zombies.spawn for more than the pool holds. The generator keeps
   * every chunk inside the same budget in its static model (fitEndlessPools: alive from spawn to contact); what this catches is the
   * road's live state — stragglers of earlier waves still in contact, a wave the mini-boss hold slid onto the boss's last minions.
   * Trimmed zombies are counted in ctx.debug.dropped['level.waveClamp']. Mutates the endless event's units in place (fresh per run,
   * never frozen); allocation-free (event time).
   */
  _clampEndlessUnits(units) {
    const zombies = this.ctx.zombies;
    if (!zombies || Object.isFrozen(units)) return;
    let trimmed = 0;
    for (let i = 0; i < TYPES.length; i++) {
      const t = TYPES[i];
      const n = units[t] | 0;
      if (n <= 0) continue;
      const room = ZOMBIES[t].pool - zombies.aliveOfType(t) - this._poolReserve[t];
      if (n > room) {
        const keep = room > 0 ? room : 0;
        trimmed += n - keep;
        units[t] = keep;
      }
    }
    if (trimmed > 0) {
      const dbg = this.ctx.debug;
      if (dbg && dbg.dropped) dbg.dropped['level.waveClamp'] = (dbg.dropped['level.waveClamp'] | 0) + trimmed;
    }
  }

  /**
   * Round 5d (GDD §10.1 / §6.3, lead decision): the per-zombie HP ceiling of an endless wave / guard table — every type present
   * is clamped to levelgen.endlessHpCap(E, p) = LEVELS.endless.hpCapSeconds[type] × the on-curve squad's design DPS at E
   * (E · FIRE.rateBase · FIRE.dmgBase · FIRE.accuracy) × p^LEVELS.endless.profileExp, p = (fireRate / FIRE.rateBase)·damage.
   * Endless death comes from growing numbers, never from a single zombie the squad cannot kill: a brute in contact dies within
   * ~3 s of focused on-curve fire (it carried the design multiple × the pressure before — 7.7k HP at chunk 5, 15k at chunk 10 —
   * and one of them at the formation front took the whole squad's fire for a whole mini-boss fight). Returns `hp` itself when
   * nothing binds, else a fresh capped table (event time, never per frame).
   */
  _capEndlessHp(hp, units, E) {
    const prof = this.ctx.profile;
    const p = prof && prof.fireRate > 0 ? (prof.fireRate / FIRE.rateBase) * prof.damage : 1;
    const cap = endlessHpCap(E, p, this._hpCap);
    let binds = false;
    for (let i = 0; i < TYPES.length; i++) {
      const t = TYPES[i];
      if ((units[t] | 0) > 0 && hp[t] > cap[t]) { binds = true; break; }
    }
    if (!binds) return hp;
    const out = {};
    for (let i = 0; i < TYPES.length; i++) {
      const t = TYPES[i];
      if (hp[t] !== undefined) out[t] = Math.min(hp[t], cap[t]);
    }
    return out;
  }

  /**
   * A staggered wave (QA LVL-4b, levelgen.placeWave): the types without a lag spawn now, every other type is queued as
   * its own part (same pattern / x / spread) at ev.at + lag[type], so all of them reach the squad at the planned contact.
   * The part records are allocated here (event time), never per frame.
   */
  _spawnStaggered(ev, hp) {
    const zombies = this.ctx.zombies;
    const units = ev.units;
    const lag = ev.lag;
    let now = null;
    for (let i = 0; i < TYPES.length; i++) {
      const t = TYPES[i];
      const n = units[t] | 0;
      if (n <= 0) continue;
      const l = lag[t] > 0 ? lag[t] : 0;
      if (l <= 0 || this._partCount >= PENDING_PARTS) {
        if (!now) now = {};
        now[t] = n;
        continue;
      }
      const part = { pattern: ev.pattern, units: {}, spread: ev.spread, x: ev.x };
      part.units[t] = n;
      const k = this._partCount++;
      this._partAt[k] = ev.at + l;
      this._partWave[k] = part;
      this._partHp[k] = hp;
    }
    if (now) zombies.spawnWave({ pattern: ev.pattern, units: now, spread: ev.spread, x: ev.x }, hp);
  }

  /** Stats bookkeeping shared by waves and the run-up: hz, lostPerWave flush, hintOnLoss re-arm. */
  _noteWaveSpawned(hz) {
    const run = this.ctx.run;
    this._waveHz = hz;
    run.waveHz = hz;
    if (this._waveCount > 0) {
      run.lostPerWave.push(this._lossesThisWave);
      this._histogram('lostPerWave', this._lossesThisWave);
    }
    this._lossesThisWave = 0;
    this._waveCount++;
  }

  _fireCrate(ev) {
    if (this._bossReached && !this._endless) return;     // pickups stop spawning after the boss row (campaign)
    const pickups = this.ctx.pickups;
    if (pickups) pickups.spawnCrate(ev.item, ev.x);
    this._codexSeen('pickup.crate', false);              // r7 (teaching:5)
    this._specialsHint();                                // r7: the gold diamond on the bar
  }

  _fireCoins(ev) {
    if (this._bossReached && !this._endless) return;
    const pickups = this.ctx.pickups;
    if (pickups) pickups.spawnCoinLine(ev.x, ev.count !== undefined ? ev.count : PICKUPS.coinLine.count);
    this._codexSeen('pickup.coins', false);              // r7 (teaching:5)
  }

  /** Round 7 (r7, lead decision): every lane of a pair / triple costs soldiers (− or ÷: "lesser evil", GDD §4.4). */
  _lesserEvil(ev) {
    const lanes = ev.lanes;
    if (!lanes || lanes.length < 2) return false;
    for (let i = 0; i < lanes.length; i++) { const op = lanes[i] ? lanes[i].op : ''; if (op !== '-' && op !== '/') return false; }
    return true;
  }

  _hasItemLane(ev) {
    const lanes = ev.lanes;
    if (!lanes) return false;
    for (let i = 0; i < lanes.length; i++) if (lanes[i] && lanes[i].op === 'item') return true;
    return false;
  }

  /** Round 7 (r7, lead decision; the tester read the bar's gold diamonds as checkpoints): the first special that reaches
   *  the road on a generated campaign level — the squad marker is on its diamond at that moment — names the diamonds,
   *  once ever. Not on an authored level (L1 teaches its crate with its own hint) and not in endless (no diamonds). */
  _specialsHint() {
    if (this._endless || LEVELS.authored[this._level]) return;
    this.showHint('specials');
  }

  /** Run-up: phase 'runup', fog closes in, level:runup, then `bursts` horde bursts every burstGap seconds. */
  _fireRunup(ev) {
    const ctx = this.ctx;
    const units = ev.units;
    if (this._phase === 'run') this._setPhase('runup');
    if (ctx.render && ctx.render.env) ctx.render.env.setFog(this._districtFogNear(true), this._districtFogFar(), RUNUP_FOG_LERP_S);   // DISTRICTS.md §8.5
    const v = this._baseSpeed();
    P_RUNUP.secondsToBoss = Math.max(0, (this._bossAt - ctx.world.distance) / Math.max(v, 1e-6));
    ctx.events.emit('level:runup', P_RUNUP);
    if (!units || !ctx.zombies) return;

    const defaults = LEVELS.curve.runup;
    const sBar = meanOwnSpeed(units);
    const contactAt = ctx.world.distance + (-WORLD.spawnZ * v) / (v + sBar);
    const hp = scaleHp(ev.hp || solveWaveHp(this._expectedAt(contactAt), v, units, this._bandMid),
      (ev.hpMult || 1) * this._liveHpMult(ev.hp ? this._expectedAt(contactAt) : 0) * this._lowSideMult(this._expectedAt(ctx.world.distance)));   // QA LVL-15; r7 low side
    // one small record per run-up (event time): only the types present, counts rewritten per burst
    const burstUnits = {};
    for (let k = 0; k < TYPES.length; k++) {
      const t = TYPES[k];
      if ((units[t] | 0) > 0) burstUnits[t] = 0;
    }
    this._runupUnits = units;
    this._runupHp = hp;
    this._runupWave = { pattern: ev.pattern || defaults.pattern, units: burstUnits, spread: RUNUP_SPREAD };
    this._runupBursts = Math.max(1, ev.bursts !== undefined ? ev.bursts | 0 : defaults.bursts);
    this._runupGap = ev.burstGap !== undefined ? ev.burstGap : defaults.burstGap;
    this._runupIndex = 0;
    this._runupTimer = 0;            // first burst goes out in this step
    this._runupActive = true;
    this._noteWaveSpawned(hzOf(hp, units));
    this._lossHint = ev.hintOnLoss || this._lossHint;
  }

  /** Boss hand-off: road slow-down (campaign), minion HP from the resolved archetype union (D8), boss.spawn(spec). */
  _fireBoss(ev) {
    const ctx = this.ctx;
    if (this._bossWarmEv === ev) { this._bossWarmAt = -1; this._bossWarmEv = null; }   // round 5: too late to warm (a debug jump)
    const boss = ctx.boss;
    const w = ctx.world;
    const run = ctx.run;
    const mini = this._endless || !!ev.mini;
    if (!mini) {
      this._setPhase('bossIntro');
      this._roadTarget = w.roadSpeedBase * WORLD.bossRoadFactor;
      this._roadTweenFrom = w.roadSpeed;                 // linear 1 s slow-down (GDD §7 "lerps to 35 % over 1 s")
      this._roadTweenTo = this._roadTarget;
      this._roadTweenT = 0;
      this._bossReached = true;
    } else if (this._phase === 'run' || this._phase === 'runup') {
      this._setPhase('boss');          // no intro for a mini-boss (boss:fight may never fire)
    }
    if (!boss) return;
    const archetype = ev.archetype || BOSSES.rotation[Math.min(this._level, LEVELS.curve.loopAfter) - 1];
    const phases = ev.phases || archetypePhases(archetype);
    const eBoss = this._endless ? endlessE(this._difficulty) : this._script.eBoss;
    const union = unionMinionUnits(phases);
    // QA LVL-15: boss minions share the damped shop-rank scaling of the wave solve. r5c: an endless mini-boss's minions are soak
    // like a campaign boss's (_miniMinionMult), never the waves' design multiple × pressure (they were walls: docs/build/r5c-endless.md)
    // r7: a campaign boss's minions also carry the low-side band against E_boss (a small squad no longer soaks a 0.15 × E_boss solve)
    const minionHp = scaleHp(ev.minionHp || solveWaveHp(eBoss, w.roadSpeedBase, union, this._bandMid),
      (this._endless ? this._miniMinionMult() : this._liveHpMult(eBoss) * this._lowSideMult(eBoss)) * (ev.minionHp ? 1 : (LEAK_MODEL.minionScale > 0 ? LEAK_MODEL.minionScale : 1)));
    let hp = ev.hp;
    if (!(hp > 0)) hp = roundBossHp((this._endless ? LEVELS.endless.miniBossHpPerE : BOSSES.hpPerE) * eBoss);
    // QA LVL-14 (GDD §7): table HP × count scale × shop scale — every fight lasts long enough for its phases and attacks to be
    // seen, and a bigger army or a better shop still wins faster. Never below the table in endless (and with an older data.js);
    // r7: in the campaign BOSSES.squadScale.minMult < 1 takes a squad under E_boss below it (its fight no longer runs 25–43 s),
    // and the fight floor (_bossTtkBand) keeps a squad at / above the curve from erasing the boss in a few seconds
    const hpScale = this._bossHpScale(eBoss);
    const sq = BOSSES.squadScale;
    hp = (sq && sq.minMult > 0 && sq.minMult < 1 && !this._endless) ? roundBossHp(hp * hpScale) : Math.max(hp, roundBossHp(hp * hpScale));
    const floored = this._bossTtkBand(hp, mini, eBoss);
    run.bossTtkBand = floored > hp ? 1 : 0;
    hp = floored;
    run.bossHpScale = hpScale;
    this._histogram('bossHpScale', hpScale);
    // round-3 QA LVL-17: an endless mini-boss carries the chunk's pressure — HP and every attack's kills. r5c: each through its
    // own share of the pressure exponent (LEVELS.endless.miniBossHpShare / miniBossKillsShare; absent = 1, the round-3 rule)
    let bossPhases = ev.phases;
    if (this._endless) {
      const en = LEVELS.endless;
      const k = endlessPressure(this._difficulty);
      const kHp = Math.pow(k, en.miniBossHpShare >= 0 ? en.miniBossHpShare : 1);
      const kKills = Math.pow(k, en.miniBossKillsShare >= 0 ? en.miniBossKillsShare : 1);
      if (kHp > 1) hp = roundBossHp(hp * kHp);
      if (kKills > 1) bossPhases = pressurePhases(ev.phases || phases, kKills);
    }
    // r7 (teaching:3 / :5): the archetype picks the phase lessons; the boss and its bar are FIELD GUIDE entries met now
    this._bossArch = archetype;
    this._codexSeen('boss.' + archetype, false);
    this._codexSeen('hud.bossbar', false);
    // fresh spec per boss event: the boss keeps minionHp for its bursts during the whole fight
    const spec = { id: ev.id || ('boss.' + archetype), archetype, hp, phases: bossPhases, minionHp, mini };
    if (ev.x !== undefined) spec.x = ev.x;
    if (ev.z !== undefined) spec.z = ev.z;
    boss.spawn(spec);
    // round 5d (GDD §10.1): the road's events hold until the mini-boss is dead (_releaseHold); LEVELS.endless.miniBossHold
    if (mini && this._endless && LEVELS.endless.miniBossHold && LEVELS.endless.miniBossHold.releaseM >= 0) this._holdOn = true;
    const squad = ctx.squad;
    run.countAtBoss = squad ? squad.count : 0;
    this._histogram('countAtBoss', run.countAtBoss);
  }

  /** Round 5 integration: the first 'boss' event of `events` (from index `from`) arms the boss-path warm-up. */
  _armBossWarm(events, from) {
    for (let i = from; i < events.length; i++) {
      const ev = events[i];
      if (ev.type !== 'boss') continue;
      this._bossWarmEv = ev;
      this._bossWarmAt = Math.max(0, ev.at - BOSS_WARM_LEAD_M);
      return;
    }
  }

  /**
   * Round 5 integration (r5-perf-audio needsOtherGroup 1): a silent dry run of _fireBoss's own helpers for the armed boss
   * event — archetype resolution, the minion union, the minion HP solve (levelgen solveWaveHp / unitStats), the live HP
   * multiplier, the boss HP scale and (endless) the pressure copy — so the boss hand-off frame is not their first call
   * (≈ 2.6 ms of the 4× arrival frame). Results are discarded; nothing is written (no spawn, no histogram, no run field,
   * no event). Once per boss event. The few objects it builds are the ones _fireBoss builds, once per boss, never per frame.
   */
  _warmBossPath() {
    const ev = this._bossWarmEv;
    this._bossWarmAt = -1;
    this._bossWarmEv = null;
    if (!ev || !this.ctx.boss) return;
    try {
      const w = this.ctx.world;
      const archetype = ev.archetype || BOSSES.rotation[Math.min(this._level, LEVELS.curve.loopAfter) - 1];
      const phases = ev.phases || archetypePhases(archetype);
      const eBoss = this._endless ? endlessE(this._difficulty) : this._script.eBoss;
      const union = unionMinionUnits(phases);
      scaleHp(ev.minionHp || solveWaveHp(eBoss, w.roadSpeedBase, union, this._bandMid), this._endless ? this._miniMinionMult() : this._liveHpMult(eBoss) * this._lowSideMult(eBoss));
      const hp = ev.hp > 0 ? ev.hp : roundBossHp(BOSSES.hpPerE * eBoss);
      this._bossTtkBand(roundBossHp(hp * this._bossHpScale(eBoss)), this._endless || !!ev.mini, eBoss);   // r7: pure, the result is discarded
      if (this._endless) pressurePhases(phases, 2);
    } catch (err) {
      warnOnce('level.bossWarm', 'boss warm-up failed: ' + (err && err.message ? err.message : err));
    }
  }

  /**
   * QA LVL-14: boss HP multiplier = countScale · shopScale.
   * countScale = clamp((C / E)^BOSSES.squadScale.exp, lo, maxMult) with C = the live count, E = E_boss (endless: E(D)); lo = 1,
   * r7: BOSSES.squadScale.minMult (0.6) in the campaign — a squad below E_boss meets less than the table (_fireBoss);
   * shopScale = clamp(m^(BOSSES.shopScale.exp·min(1, C/E)), 1, maxMult) with m = (fireRate / FIRE.rateBase)·damage·bossDamage (1 at
   * base ranks). TTK ∝ HP / (C·m) falls strictly with m, and with C from E up (exponents < 1). Below E the faded exponent makes
   * HP / C rise with C once C > E / (exp·ln m) (≈ 0.44·E at m = 12.5): measured flat, and on L28 at ranks 9·8·8·10·9 11.5 s at
   * 0.45·E against 15.1 s at E (docs/build/r5-balance-audit.md §4). r7 answers that pending decision: below E_boss the count
   * scale now falls to minMult, which outweighs the faded shop exponent (never-steering bot: TTK max 41 → 20 s).
   */
  _bossHpScale(E) {
    const ctx = this.ctx;
    const sq = BOSSES.squadScale, sh = BOSSES.shopScale;
    let scale = 1;
    const ratio = Math.max(0, ctx.squad ? ctx.squad.count : 0) / Math.max(1, E);
    if (sq) scale *= clamp(Math.pow(ratio, sq.exp), (sq.minMult > 0 && !this._endless) ? sq.minMult : 1, sq.maxMult);
    if (sh) {
      const pr = ctx.profile;
      const m = pr ? (pr.fireRate / FIRE.rateBase) * pr.damage * pr.bossDamage : 1;
      // a squad below the curve keeps most of its upgrades' edge: the exponent fades with C / E (the bad bot, 0.3·E_boss with
      // rank-2 upgrades, met 1.7× the table HP and was chewed by the safety valve on all five L7 attempts)
      scale *= clamp(Math.pow(m > 0 ? m : 1, sh.exp * Math.min(1, ratio)), 1, sh.maxMult);
    }
    return scale;
  }

  /**
   * r7 (balance:4, GDD §7 "fight floor"): the shortest fight a campaign boss allows a squad at or above the curve. With
   * BOSSES.ttkBand = { acc, min, milestoneMin, shopExp, fromRatio }: when C ≥ fromRatio·E_boss, HP ≥ round50(DPS · tMin) with
   * DPS = C · fireRate · damage · bossDamage · acc (GDD §3.3 squad DPS) and tMin = (milestone ? milestoneMin : min) · m^−shopExp,
   * m = (fireRate / FIRE.rateBase)·damage·bossDamage — a better shop still wins faster, at the r5 rate. Milestone = the curve level
   * (min(L, loopAfter)) is in BOSSES.milestones. A regular boss at C = E_boss already lasts ≈ 12.5·m^−0.1 s, so the floor binds
   * for big squads (C > ≈ 1.3·E_boss) and on milestones (the 393-soldier L15 Colossus died in 12 s). Mini-bosses, endless, a
   * missing key: HP unchanged (r7 fix round 3: a squad below fromRatio·E_boss meets the weak floor only). Pure (no write), so
   * the boss warm-up can run it.
   * r7 fix (balance verifier): the floor fades in — its weight rises from 0 at fromRatio·E_boss to 1 at (fromRatio +
   * fadeWidth)·E_boss, HP = hp + w·(floor − hp) — so the boss HP no longer steps where the band switches on (L15: 365
   * soldiers met 28,550 HP, 369 met 32,300: +13 % HP, ≈ +3 s of fight, for +1 % soldiers). At and above (fromRatio +
   * fadeWidth)·E_boss, the band's own numbers.
   * r7 fix round 3: under the band, at any C, the weak floor HP ≥ round50(DPS · weakMin · m^−shopExp) (see below).
   */
  _bossTtkBand(hp, mini, eBoss) {
    const band = BOSSES.ttkBand;
    if (!band || mini || this._endless) return hp;
    const ctx = this.ctx;
    const pr = ctx.profile;
    const c = ctx.squad ? ctx.squad.count : 0;
    if (!pr || !(c > 0)) return hp;
    const m = (pr.fireRate / FIRE.rateBase) * pr.damage * pr.bossDamage;
    const shop = Math.pow(m > 0 ? m : 1, -band.shopExp);
    const dps = c * pr.fireRate * pr.damage * pr.bossDamage * band.acc;
    // r7 fix round 3 (balance / walker verifiers): every campaign boss lives at least weakMin · m^−shopExp s against the
    // squad's DPS, whatever its size — below fromRatio·E_boss the count scale's minMult and the faded shop exponent of
    // _bossHpScale let a late, upgraded, under-curve squad erase it in 4–8 s (never-steering, worst-lane and tester-like bots
    // on L16–L29, the phases flashing past; 1.2.2 had 0–1 such fights of 30). weakMin 11 (BOSSES.ttkBand) binds from L13
    // below the curve (model 8.7–9.8 s); up to L12, and at the curve, the fight is already longer. The band below (min /
    // milestoneMin) fades in from this floor, not from the table HP
    let base = hp;
    if (band.weakMin > 0) {
      const weak = roundBossHp(dps * band.weakMin * shop);
      if (weak > base) base = weak;
    }
    if (c < band.fromRatio * eBoss) return base;
    const curveL = Math.min(this._level, LEVELS.curve.loopAfter);
    const tMin = (BOSSES.milestones.indexOf(curveL) !== -1 ? band.milestoneMin : band.min) * shop;
    const floor = roundBossHp(dps * tMin);
    if (!(floor > base)) return base;
    const fade = band.fadeWidth > 0 ? (c / eBoss - band.fromRatio) / band.fadeWidth : 1;
    return fade >= 1 ? floor : roundBossHp(base + (floor - base) * fade);
  }

  /**
   * r5c (GDD §10.1): HP multiplier of an endless mini-boss's minion table over the baked one (generateChunk: LEAK_MODEL.minionScale
   * × the calibrated solve at E(D), as a campaign boss's minions at E_boss) — LEVELS.endless.miniMinions: hpMult ×
   * pressure^pressureShare × p^profileExp (p = (fireRate / FIRE.rateBase)·damage, the campaign minions' shop compensation).
   * Never _liveHpMult's design multiple and pressure: with them every phase-1 burst was a wall (6 × 587 HP at chunk 5,
   * 6 × 7 766 at chunk 10) that kept the boss unhurt and in phase 1, spawning more. Older data.js (no key): the old multiplier.
   */
  _miniMinionMult() {
    const mm = LEVELS.endless.miniMinions;
    if (!mm) return this._liveHpMult(endlessE(this._difficulty));
    let mult = mm.hpMult > 0 ? mm.hpMult : 1;
    if (mm.pressureShare > 0) mult *= Math.pow(endlessPressure(this._difficulty), mm.pressureShare);
    const prof = this.ctx.profile;
    if (prof && mm.profileExp > 0) {
      const p = (prof.fireRate / FIRE.rateBase) * prof.damage;
      if (p > 0) mult *= Math.pow(p, mm.profileExp);
    }
    return mult;
  }

  /**
   * HP multiplier of every live wave / guard / run-up / minion table (event time):
   *  - QA LVL-15: p^LEAK_MODEL.profileExp, p = (profile.fireRate / FIRE.rateBase)·profile.damage — upgrades keep
   *    shortening waves but never down to zero bites (the generator and the validator keep p = 1);
   *  - QA LVL-17, endless only: the table was solved at E(D) (`eSolved`); it is re-scaled to E_eff = max(E(D), live C)
   *    and to the endless band raised per D (LEVELS.endless.bandPerD, capped at bandMax): HP ∝ E / (1 − leak)^leakExp.
   */
  _liveHpMult(eSolved) {
    const ctx = this.ctx;
    const en = LEVELS.endless;
    let mult = 1;
    // round-3 QA LVL-17: endless has its own shop compensation (LEVELS.endless.profileExp) — the shop's fire rate × damage
    // is what carries a strong player deeper
    const exp = this._endless && en.profileExp >= 0 ? en.profileExp : LEAK_MODEL.profileExp;
    const prof = ctx.profile;
    if (prof && exp > 0) {
      const p = (prof.fireRate / FIRE.rateBase) * prof.damage;
      if (p > 0) mult *= Math.pow(p, exp);
    }
    if (this._endless) {
      const eD = eSolved > 0 ? eSolved : endlessE(this._difficulty);
      const c = ctx.squad ? ctx.squad.count : 0;
      // QA LVL-17: solved toward the live count above E — (C / E)^liveExp (round 3: a squad that stays big is rewarded)
      const live = en.liveExp >= 0 ? en.liveExp : 1;
      if (c > eD && live > 0) mult *= Math.pow(c / eD, live);
      mult *= endlessDesignMult(this._difficulty);
      const leak = endlessBand(this._difficulty, this._bandMid);
      // the solve's TTK = win / (1 − leak)^LEAK_MODEL.leakExp (levelgen.survivorFactor)
      const q = LEAK_MODEL.leakExp > 0 ? LEAK_MODEL.leakExp : 1;
      mult *= Math.pow((1 - this._bandMid) / Math.max(0.05, 1 - leak), q) * leakCalib(leak) / leakCalib(this._bandMid);
      // round-3 QA LVL-17: × the endless pressure (HP part, LEVELS.endless.pressure.hpShare of its exponent)
      const pz = en.pressure;
      mult *= Math.pow(endlessPressure(this._difficulty), pz && pz.hpShare >= 0 ? pz.hpShare : 1);
    }
    return mult;
  }

  /**
   * r7 (balance:2, GDD §6.3 "Low side"): the campaign's low-side rubber band. Waves, guards and the run-up are solved for the
   * design line and boss minions for E_boss; a squad below it leaked ≈ 55–60 % at 0.5·E and spiralled (each leak lowers C, DPS
   * and gate intake). Below E the live tables are × max(LEAK_MODEL.lowSide.floor, C / E)^exp. `E` = the design count at the
   * SAME moment as C (the spawn: _expectedAt(distance); boss minions: E_boss), never the contact point, whose E already holds the
   * gain of a gate the squad has not passed. 1 at / above E, in endless, on the authored L1, for E ≤ 0 and without the key.
   */
  _lowSideMult(E) {
    const ls = LEAK_MODEL.lowSide;
    if (!ls || this._endless || LEVELS.authored[this._level] || !(E > 0)) return 1;
    const c = this.ctx.squad ? this.ctx.squad.count : 0;
    if (!(c < E)) return 1;
    return Math.pow(Math.max(ls.floor, c / E), ls.exp);
  }

  // -------------------------------------------------------------------------------------------
  // Gate bookkeeping: script event ↔ gate event id ↔ lane (for Lane.hint* and hitsPerGate)
  // -------------------------------------------------------------------------------------------

  _bindEvent(eid, ev) {
    const slot = eid & SLOT_MASK;
    if (slot >= EVENT_SLOTS) return;
    this._evIds[slot] = eid;
    this._evScript[slot] = ev;
  }

  /** The script event a gate event id was spawned from (falls back to the event being spawned right now). */
  _scriptEventFor(eid) {
    const slot = eid & SLOT_MASK;
    if (slot < EVENT_SLOTS && this._evIds[slot] === eid) return this._evScript[slot];
    return this._pendingEvent;
  }

  /** Gate table slot for a gate view, or −1 when the view is stale / unknown. */
  _gateSlot(gate) {
    if (!gate) return -1;
    const slot = gate.id & SLOT_MASK;
    if (slot >= GATE_SLOTS || this._gateIds[slot] !== gate.id) return -1;
    return slot;
  }

  /** Flushes a finished gate's weighted hit count into run.hitsPerGate and frees its slot. */
  _closeGate(slot) {
    const hits = this._gateHits[slot];
    const run = this.ctx.run;
    run.hitsPerGate.push(hits);
    this._histogram('hitsPerGate', hits);
    this._gateIds[slot] = -1;
    this._gateLane[slot] = null;
    this._gateHits[slot] = 0;
    this._gateEv[slot] = -1;
  }

  // -------------------------------------------------------------------------------------------
  // Listeners (§5: level subscribes to zombie:die, gate:*, coin:pickup, boss:fight, boss:dead, squad:loss,
  // squad:dead, squad:count — stats, coins, hints). Decorative title gates emit nothing, so 'idle' is only a guard.
  // -------------------------------------------------------------------------------------------

  _onGateEvent(p) {
    if (this._phase === 'idle') return;
    const ev = this._pendingEvent;
    if (ev) this._bindEvent(p.eventId, ev);
  }

  _onGateSpawn(p) {
    if (this._phase === 'idle') return;
    const gate = p.gate;
    if (!gate) return;
    const slot = gate.id & SLOT_MASK;
    if (slot >= GATE_SLOTS) return;
    const ev = this._scriptEventFor(p.eventId);
    const lanes = ev ? ev.lanes : null;
    this._gateIds[slot] = gate.id;
    this._gateLane[slot] = (lanes && p.laneIndex >= 0 && p.laneIndex < lanes.length) ? lanes[p.laneIndex] : null;
    this._gateHits[slot] = 0;
    this._gateEv[slot] = p.eventId >= 0 ? p.eventId : -1;   // r7: hint:release at this gate's pass / miss
    // round-4 (r3 FTUE §6.2): the ÷ ladder is taught once ever (HINTS.div, showHint's save / per-run gates) when the first
    // ÷ lane spawns. Round 7 (r7, explain:5): "SHOOT ÷ TO CANCEL IT: ÷2 → ×1 (NO LOSS)" — from this gate's divisor, held
    // while its gate is on the road (teaching:0 B) and slowed the first time (ui); an endless lane the gate guard capped at
    // ×1 (cap 1) is already harmless, so it teaches nothing
    if (gate.op === '/') {
      const lane = this._gateLane[slot];
      if (!lane || !(lane.cap <= 1)) this.showHint('div', gate.base, this._gateHold(p.eventId));
    }
    // r7 (teaching:5): the FIELD GUIDE — a purple item lane gets its NEW card now, before the choice (the pickup hint only
    // came after it: a skipped special was never explained); the other gate kinds are taught by their hints
    const cid = GATE_CODEX[gate.op];
    if (cid) this._codexSeen(cid, false);
    if (gate.op === 'item' && gate.item) this._codexSeen(gate.item, true);
  }

  /** r7 (teaching:5): a shot ÷ gate reached the grey ×1 (gate:step mult 1) — the NEW card "×1 · NO CHANGE, NOTHING LOST". */
  _onGateStep(p) {
    if (this._phase === 'idle' || !p || !p.gate) return;
    if (p.gate.op === '/' && p.mult === 1) {
      this._codexSeen('gate.zero', true);
      this._lesserResolved(p.gate);                      // r7 fix round 2: a ÷ at ×1 costs nothing — "BOTH LANES HURT" is over
    }
  }

  /** r7 fix round 2: a lane of the event the held 'lesser' lesson is about stopped costing soldiers (a − flipped, a ÷ shot to
   *  ×1) — its premise is gone, so it comes down now (hint:release by the event id; teaching verifier: it stayed 2.5 s over
   *  "×1 | −12" on L5 and 1.7 s over a flipped −100 on L6). Under HINT_MARK_S on screen it stays unmarked and teaches at
   *  the next lesser pair. */
  _lesserResolved(gate) {
    if (this._lesserEv < 0) return;
    const slot = this._gateSlot(gate);
    if (slot < 0 || this._gateEv[slot] !== this._lesserEv) return;
    this._release(this._lesserEv);
    this._lesserEv = -1;
  }

  /** gate:hit → hitsPerGate accumulator; the first registered hit on a lane with hintOnHit shows it (once ever). */
  _onGateHit(p) {
    const slot = this._gateSlot(p.gate);
    if (slot < 0) return;
    this._gateHits[slot] += p.weight > 0 ? p.weight : 1;
    const lane = this._gateLane[slot];
    if (lane && lane.hintOnHit) this.showHint(lane.hintOnHit);
  }

  _onGateMax() {
    if (this._phase === 'idle') return;
    this.ctx.run.gatesMaxed++;
    this._codexSeen('gate.max', true);                   // r7 (teaching:5): the first MAX gets its NEW card
  }

  _onGateFlip(p) {
    if (this._phase === 'idle') return;
    this.ctx.run.gatesFlipped++;
    if (p && p.gate && p.gate.op === '-') this._lesserResolved(p.gate);   // r7 fix round 2: the red lane turned blue
  }

  /** gate:pass → gatesPassed, finalVsBase, lostToRed, lane hints (hintOnPass / hintIfOtherBetter), endless score. */
  _onGatePass(p) {
    if (this._phase === 'idle') return;
    if (this._phase === 'lost' || this._phase === 'won') return;     // QA LVL-20: nothing counts after C = 0 / the kill
    const run = this.ctx.run;
    run.gatesPassed++;
    if ((p.op === '-' || p.op === '/') && p.after < p.before) run.lostToRed += p.before - p.after;
    const gate = p.gate;
    if (gate) {
      // final value vs spawn value: multiplier ratio for x / ÷, |value| / |base| otherwise
      const base = Math.abs(gate.base);
      let ratio = 1;
      if (base > 0) ratio = (gate.op === 'x' || gate.op === '/') ? Math.abs(gate.mult) / base : Math.abs(gate.value) / base;
      run.finalVsBase.push(ratio);
      this._histogram('finalVsBase', ratio);
    }
    const slot = this._gateSlot(gate);
    if (slot >= 0) {
      this._release(this._gateEv[slot] >= 0 ? this._gateEv[slot] : null);   // r7: its event's held lesson comes down
      if (this._gateEv[slot] === this._lesserEv) this._lesserEv = -1;
      const lane = this._gateLane[slot];
      if (lane) {
        const onPass = lane.hintOnPass;
        // QA LVL-33: a template hint names the pass's effective multiplier (x2 shot to x4 → "×4 MULTIPLIES YOUR SQUAD")
        if (onPass && onPass.id && p.after >= (onPass.ifCountAtLeast !== undefined ? onPass.ifCountAtLeast : 0)) this.showHint(onPass.id, gate ? gate.mult : undefined);
        if (lane.hintIfOtherBetter && p.other && p.other.wouldBe > p.after) this.showHint(lane.hintIfOtherBetter);
      }
      this._closeGate(slot);
    }
    if (this._endless) run.score += SCORE.endless.gate * run.streakMult * this._scorePressure();
  }

  _onGateMiss(p) {
    const slot = this._gateSlot(p.gate);
    if (slot < 0) return;
    if (this._phase !== 'idle') this._release(this._gateEv[slot] >= 0 ? this._gateEv[slot] : null);   // r7
    if (this._gateEv[slot] === this._lesserEv) this._lesserEv = -1;
    this._closeGate(slot);
  }

  /** zombie:die → kills / killsByType (a zombie that dies by biting or by cleanup is not a kill). */
  _onZombieDie(p) {
    if (this._phase === 'idle') return;
    if (p.cause === 'cleanup' || p.cause === 'bite') return;
    const run = this.ctx.run;
    run.kills++;
    if (run.killsByType[p.type] !== undefined) run.killsByType[p.type]++;
    if (this._endless) run.score += SCORE.endless.kill * run.streakMult * this._scorePressure();
  }

  /** coin:pickup → the ONLY coin-accounting input (D1). Ignored once the run is committed (QA LVL-19). */
  _onCoinPickup(p) {
    if (this._phase === 'idle' || this._finished) return;
    if (this._committed && !this._committing) return;
    // QA LVL-20: a dead squad earns nothing from gates, crates, piles or refunds (in-flight kill coins still land)
    if (this._phase === 'lost' && LOST_BLOCKED_SOURCES.indexOf(p.source) !== -1) return;
    if (p.source === 'kill') this.ctx.run.killCoins += p.amount;
    this._addCoins(p.amount, p.source);
  }

  /**
   * Unrounded credit n · (coinMult for 'kill' / 'boss') · (×0.6 on a replay or in endless) accumulates per breakdown
   * bucket; the bucket is credited floor(accumulated) − already credited whole coins (QA LVL-6: a 1-coin pickup worth
   * 0.6 or 1.4 no longer rounds to 1). run.coins = Σ credited buckets; coins:change { total = saved + run, runTotal,
   * delta, source } is emitted only when whole coins were credited. _settleCoins() pays the rounding residual at the
   * end. Private: called solely from the coin:pickup listener.
   */
  _addCoins(n, source) {
    const ctx = this.ctx;
    const run = ctx.run;
    let mult = 1;
    const cms = ECONOMY.coinMultSources;
    for (let i = 0; i < cms.length; i++) {
      if (cms[i] === source) { mult *= ctx.profile ? ctx.profile.coinMult : 1; break; }
    }
    if (this._endless) mult *= ECONOMY.endlessPayout;
    else if (run.replay) mult *= ECONOMY.replayPayout;
    // round-3 QA LVL-23: boss-fight minions are a soak — a longer fight (a weaker squad) must not pay more than a quick one
    if (!this._endless && source === 'kill' && (this._phase === 'boss' || this._phase === 'bossIntro') && ECONOMY.bossFightKillMult >= 0) mult *= ECONOMY.bossFightKillMult;
    const raw = n * mult;
    if (!(raw > 0)) return;
    const key = ECONOMY.breakdownOf[source];
    let b = COIN_BUCKETS.indexOf(key !== undefined && run.breakdown[key] !== undefined ? key : 'bonus');
    if (b < 0) b = COIN_BUCKETS.length - 1;
    this._coinRaw[b] += raw;
    const whole = Math.floor(this._coinRaw[b] + 1e-9);
    const delta = whole - this._coinPaid[b];
    if (delta <= 0) return;
    this._coinPaid[b] = whole;
    this._creditCoins(b, delta, source);
  }

  /** Credits `delta` whole coins to bucket b: run.coins, run.breakdown, coins:change. */
  _creditCoins(b, delta, source) {
    const ctx = this.ctx;
    const run = ctx.run;
    run.coins += delta;
    run.breakdown[COIN_BUCKETS[b]] += delta;
    const save = ctx.save;
    P_COINS.total = (save && save.data ? save.data.coins : 0) + run.coins;
    P_COINS.runTotal = run.coins;
    P_COINS.delta = delta;
    P_COINS.source = source;
    ctx.events.emit('coins:change', P_COINS);
  }

  /** End of run: the residual round(Σ unrounded) − Σ credited goes to the buckets with the largest remainders. */
  _settleCoins() {
    let raw = 0, paid = 0;
    for (let i = 0; i < COIN_BUCKETS.length; i++) { raw += this._coinRaw[i]; paid += this._coinPaid[i]; }
    let residual = Math.round(raw) - paid;
    while (residual > 0) {
      let bi = -1, best = 0;
      for (let i = 0; i < COIN_BUCKETS.length; i++) {
        const rem = this._coinRaw[i] - this._coinPaid[i];
        if (rem > best + 1e-9) { best = rem; bi = i; }
      }
      if (bi < 0) break;
      this._coinPaid[bi] += 1;
      this._creditCoins(bi, 1, COIN_BUCKETS[bi] === 'bonus' ? 'bonus' : 'settle');
      residual--;
    }
  }

  _onBossFight() {
    if (this._phase === 'idle' || this._finished) return;
    const run = this.ctx.run;
    if (this._phase === 'bossIntro' || this._phase === 'run' || this._phase === 'runup') this._setPhase('boss');
    run.bossStartTime = run.elapsed;
    // QA LVL-25 (GDD §1.1 / §7): the boss lesson when shooting starts to count (the intro is immune), campaign only. Round 7
    // (r7, teaching:3): "YOUR SQUAD SHOOTS THE BOSS — DODGE ITS ATTACKS", then — with a weapon waiting in the FIRE button —
    // "FIRE YOUR STORED WEAPON AT THE BOSS!"
    if (this._endless) return;
    this.showHint('boss');
    if (this._storedCount() > 0) this.showHint('bossFire');
  }

  /** Weapons waiting in the FIRE button (weapons.storedCount; 0 without weapons). */
  _storedCount() {
    const w = this.ctx.weapons;
    let stored = 0;
    try { stored = w ? w.storedCount | 0 : 0; } catch (_) { stored = 0; }
    return stored;
  }

  /**
   * Round 7 (r7, teaching:3; replaces round-3's one generic "STEER CLEAR OF THE MARKS!", which went on screen as the first
   * slam landed): each telegraphed attack teaches itself the moment its telegraph starts — "RED RING = SLAM! STEER OUT OF IT",
   * "RED STRIPE = CHARGE! …", "RED BAND = FLYING CAR! …", "GREEN CIRCLES = ACID! …", "STOMPS HIT EVERYONE — FIRE A STORED
   * WEAPON AT HIM" (r7 fix round 2: "… — THEY CANNOT BE DODGED" with nothing stored; HINTS['boss.stomp'] is a template) —
   * once ever, as a PRIORITY hint (it cuts a normal hint on screen, which comes back afterwards) held for the telegraph +
   * JUICE.ui.hintHoldPadSeconds; the first time ever the telegraph also plays in slow motion (JUICE.slowmo.bossTutorial:
   * the 0.8 s slam ring reads for ≈ 2.5 s). The safety-valve chew is a FIELD GUIDE entry, not a lesson.
   */
  _onBossAttack(p) {
    if (this._phase === 'idle' || this._finished || !p) return;
    if (p.kind === 'chew') { this._codexSeen('boss.valve', false); return; }
    this._attackLesson(LESSON_OF[p.kind], p.delay);
  }

  /** r7 (teaching:3 / :7): a spitter's glob telegraph teaches the acid circles like the Queen's (the same lesson id). */
  _onZombieTelegraph(p) {
    if (this._phase === 'idle' || this._finished || !p || p.kind !== 'spit') return;
    this._attackLesson('dodge.acid', p.duration);
  }

  /** The attack lesson `id` (priority, held for `delay` + the pad; slowed the first time ever — see _onBossAttack). */
  _attackLesson(id, delay) {
    if (!id) return;
    const ctx = this.ctx;
    const save = ctx.save, run = ctx.run, fx = ctx.fx;
    const d = delay > 0 ? delay : 0;
    const S = JUICE.slowmo.bossTutorial;
    const fresh = !!(save && !save.hintDone(id) && run && run.hintsShown && run.hintsShown.indexOf(id) === -1);
    const slow = fresh && !!S && S[0] > 0 && S[0] < 1 && d > 0 && !!fx && typeof fx.slowmo === 'function';
    const theatre = slow ? d / S[0] + S[1] : d;        // the telegraph in theatre seconds (the slow-mo stretches it)
    HOLD.hold = theatre + (JUICE.ui.hintHoldPadSeconds > 0 ? JUICE.ui.hintHoldPadSeconds : 0);
    HOLD.until = null;
    HOLD.priority = true;
    HOLD.event = -1;
    // r7 fix round 2: the stored-weapon count is the template argument ('boss.stomp' names the FIRE lever only with one)
    if (this.showHint(id, this._storedCount(), HOLD) && slow) fx.slowmo(S[0], d / S[0] + S[1]);
  }

  /** r7 (teaching:3): boss:phase → that phase's lesson for the base archetype (twins → hulk, prime → colossus), once ever. */
  _onBossPhase(p) {
    if (this._phase === 'idle' || this._finished || !p) return;
    let a = this._bossArch;
    const arch = BOSSES.archetypes[a];
    if (arch && arch.base) a = arch.base;
    const table = PHASE_HINT[a];
    const id = table ? table[p.phase | 0] : null;
    if (id && HINTS[id] !== undefined) this.showHint(id);
  }

  /** r7 (teaching:5): every zombie type is a FIELD GUIDE entry, met at its first spawn (a per-run flag keeps this cheap). */
  _onZombieSpawn(p) {
    if (this._phase === 'idle' || !p) return;
    const k = TYPES.indexOf(p.type);
    if (k < 0 || this._zSeenRun[k]) return;
    this._zSeenRun[k] = 1;
    this._codexSeen(ZOMBIE_CODEX[k], false);
  }

  /**
   * Round-3 FTUE (GDD §8): the first pickup of each special names it — HINTS[item id] ("ARMOR! EACH PLATE STOPS A BITE"),
   * once ever; a duplicate (coins instead) never does. Round 7 (r7): a weapon's name hint waits for the weapon to fire
   * (weapon:start — at its pickup it is only stored, teaching:0 C); a special's first pickup ever shows its NEW card
   * (FIELD GUIDE) — a crate's item now, a purple lane's item already did at the lane's spawn — and a special its card
   * explained this run skips the hint (marked done: the card taught it). A crate's pickup also releases "GRAB THE CRATE".
   */
  _onItemPickup(p) {
    if (this._phase === 'idle' || !p) return;
    this._crateHintUp = false;
    this._release(RELEASE_CRATE);
    if (p.duplicate) { this._codexSeen('pickup.duplicate', false); return; }
    const id = p.item;
    if (typeof id !== 'string') return;
    this._codexSeen(id, true);
    if (id.indexOf('weapon.') === 0 || HINTS[id] === undefined) return;
    if (this._runCards.indexOf(id) !== -1) {
      const save = this.ctx.save, eng = this.ctx.engine;
      // r7 final fix (lead decision 5): the NEW card stood in for this lesson — done only if someone was there to read it
      if (save && typeof save.markHint === 'function' && !(eng && typeof eng.inputIdleS === 'function' && eng.inputIdleS() > JUICE.ui.hintIdleS)) save.markHint(id);
      return;
    }
    this.showHint(id);
  }

  /**
   * Round 6 (stored weapons): the first weapon ever stored teaches the HUD FIRE button — HINTS.fire, once ever (showHint's
   * save gate). weapon:stored is emitted inside grantItem before item:pickup, so this hint queues ahead of the weapon's
   * NEW card: the action first (a stored weapon that is never fired is the one thing this hint must prevent).
   */
  _onWeaponStored() {
    if (this._phase === 'idle') return;
    this.showHint('fire');
    this._codexSeen('ctl.fire', false);                  // r7 (teaching:5)
    this._codexSeen('hud.fire', false);
  }

  /** r7 (teaching:0 C): the weapon's name hint ("SHOTGUN! WIDE SPREAD, SHORT RANGE") when it actually fires, once ever. */
  _onWeaponStart(p) {
    if (this._phase === 'idle' || !p || typeof p.id !== 'string') return;
    this._codexSeen('hud.pills', false);
    if (HINTS[p.id] === undefined) return;
    // r7 fix round 3: bound to the weapon (release key = its id, no hold) — weapon:end releases it (init)
    HOLD.hold = 0;
    HOLD.until = p.id;
    HOLD.priority = false;
    HOLD.event = -1;
    this.showHint(p.id, undefined, HOLD);
  }

  /**
   * boss:dead → campaign: phase 'won', survivors sampled NOW (GDD §9.3: the count when the boss HP reaches 0),
   * squad invulnerable, remaining minions cleared without coins, finish(true) after BOSSES.death.resultsAfterMs
   * real time. Endless mini-boss: score, back to 'run'.
   */
  _onBossDead() {
    if (this._phase === 'idle' || this._finished) return;
    const ctx = this.ctx;
    const run = ctx.run;
    if (run.bossStartTime >= 0) {
      run.bossSeconds = run.elapsed - run.bossStartTime;
      this._histogram('bossTtk', run.bossSeconds);
    }
    if (this._endless) {
      run.miniBossKills++;
      run.score += SCORE.endless.miniBoss * run.streakMult * this._scorePressure();
      if (this._phase === 'boss') this._setPhase('run');
      this._roadTarget = ctx.world.roadSpeedBase;
      this._releaseHold();                                 // round 5d: the road's events resume releaseM after the kill
      return;
    }
    if (this._phase === 'won' || this._phase === 'lost') return;
    this._setPhase('won');
    const squad = ctx.squad;
    run.survivors = squad ? squad.count : 0;
    if (squad) squad.setInvulnerable(Infinity);
    if (ctx.zombies) ctx.zombies.killAll('cleanup');
    this._finishAt = this._theatreNow() + BOSSES.death.resultsAfterMs;   // QA LVL-29: theatre clock
  }

  /** squad:loss → soldiersLost, lostPerWave, endless streak reset, the armed hintOnLoss on a bite. */
  _onSquadLoss(p) {
    if (this._phase === 'idle') return;
    const run = this.ctx.run;
    run.soldiersLost++;
    this._lossesThisWave++;
    if (this._endless) { run.streakMult = 1; run.streakSeconds = 0; }
    if (p.cause === 'bite' && this._lossHint) {
      const id = this._lossHint;
      this._lossHint = null;
      this.showHint(id);
    }
  }

  /** squad:dead → phase 'lost', JUICE.slowmo.squadDead, finish(false) after GAMEOVER_RESULTS_MS real time. */
  _onSquadDead() {
    if (this._phase === 'idle' || this._finished) return;
    if (this._phase === 'won' || this._phase === 'lost') return;
    const ctx = this.ctx;
    this._setPhase('lost');
    this._deathDistance = ctx.world.distance;            // results read this, not the 1.2 s run-on (QA LVL-10)
    if (ctx.fx) ctx.fx.slowmo(JUICE.slowmo.squadDead[0], JUICE.slowmo.squadDead[1]);
    this._finishAt = this._theatreNow() + GAMEOVER_RESULTS_MS;   // QA LVL-29: theatre clock
  }

  _onSquadCount(p) {
    if (this._phase === 'idle') return;
    const run = this.ctx.run;
    if (p.count > run.peakSquad) run.peakSquad = p.count;
  }

  /** debug:histogram { key, value } when ctx.debug.enabled (keys: hitsPerGate, finalVsBase, lostPerWave, bossTtk, countAtBoss). */
  _histogram(key, value) {
    const dbg = this.ctx.debug;
    if (!dbg || !dbg.enabled) return;
    P_HISTO.key = key;
    P_HISTO.value = value;
    this.ctx.events.emit('debug:histogram', P_HISTO);
  }

  // -------------------------------------------------------------------------------------------
  // Level end (GDD §9; ARCH §6.16 finish)
  // -------------------------------------------------------------------------------------------

  /**
   * Level end: COMMIT (stars / coins / score, save.*) then PRESENT (state complete | gameover, level:complete |
   * level:failed | endless:end). QA LVL-19: the commit runs exactly once per run — here, or earlier when the player
   * quits / restarts during the death theatre (_commitPending); the 3 s collapse is presentation only (GDD §7 / §9.3).
   */
  finish(won) {
    if (this._finished || this._finishing) return;
    this._finishing = true;
    this._finishAt = 0;
    this._runupActive = false;
    this._lossHint = null;
    this._partCount = 0;
    this._commit(won);
    if (this._endless) this._presentEndless();
    else if (won) this._presentWon();
    else this._presentLost();
    this._finished = true;
    this._finishing = false;
  }

  /** QA LVL-19: a run that ended (phase 'won' / 'lost') but was not finished yet is committed now (no presentation). */
  _commitPending() {
    if (this._committed || this._finished) return;
    if (this._phase !== 'won' && this._phase !== 'lost') return;
    this._commit(this._phase === 'won');
  }

  /** The commit half of finish(): exactly once per run (`_committed`, reset by _beginRun / quitToTitle). */
  _commit(won) {
    if (this._committed) return;
    const run = this.ctx.run;
    // the last wave's losses
    if (this._waveCount > 0) {
      run.lostPerWave.push(this._lossesThisWave);
      this._histogram('lostPerWave', this._lossesThisWave);
      this._lossesThisWave = 0;
      this._waveCount = 0;
    }
    this._committing = true;
    try {
      if (this._endless) this._commitEndless();
      else if (won) this._commitWon();
      else this._commitLost();
    } finally {
      this._committing = false;
      this._committed = true;
    }
  }

  _statsPartial(payout) {
    const run = this.ctx.run;
    return { runs: 1, kills: run.kills, gatesPassed: run.gatesPassed, coinsEarned: payout, playSeconds: run.elapsed };
  }

  /** Emits the level's own coin:pickup { source:'bonus' } (the only income path, D1) at the squad. */
  _emitBonus(amount) {
    const squad = this.ctx.squad;
    P_BONUS.amount = amount;
    P_BONUS.x = squad ? squad.x : 0;
    P_BONUS.y = SQUAD.label.y;
    P_BONUS.z = 0;
    this.ctx.events.emit('coin:pickup', P_BONUS);
  }

  _commitWon() {
    const ctx = this.ctx;
    const run = ctx.run;
    const save = ctx.save;
    const level = this._level;
    const eBoss = this._script.eBoss;
    const survivors = run.survivors;
    // GDD §9.3: 1★ boss killed, 2★ R ≥ STARS.two·E_boss, 3★ R ≥ STARS.three·E_boss — round 7 (r7, explain:0): through
    // data.starNeed, the same helper the results line prints its thresholds with (identical stars for every reachable pair)
    let stars = 1;
    if (survivors >= starNeed(eBoss, 2)) stars = 2;
    if (survivors >= starNeed(eBoss, 3)) stars = 3;
    run.stars = stars;
    // level bonus (ECONOMY.starBonus by stars) plus the survivor bonus (round-3 QA LVL-23: ECONOMY.survivorCoins per soldier
    // alive at the kill beyond ECONOMY.survivorFrom·E_boss — the squad a better run brings home pays), credited through the
    // only income path: no coinMult, replay ×0.6 applies
    const surplus = Math.max(0, survivors - (ECONOMY.survivorFrom > 0 ? ECONOMY.survivorFrom : 0) * eBoss);
    const starRaw = ECONOMY.levelBonus(level) * (1 + ECONOMY.starBonus[stars]);
    const survRaw = surplus * (ECONOMY.survivorCoins > 0 ? ECONOMY.survivorCoins : 0);
    this._emitBonus(Math.round(starRaw + survRaw));
    this._settleCoins();
    // score (GDD §9.3): 10·Σ kill coins + 15·peak + 20·R + 200·flipped + 500 if nothing was lost to a red gate
    run.score = SCORE.kill * run.killCoins + SCORE.peak * run.peakSquad + SCORE.survivor * survivors
      + SCORE.flipped * run.gatesFlipped + (run.lostToRed === 0 ? SCORE.noRedLoss : 0);
    const payout = run.coins;
    if (save) {
      save.addCoins(payout);
      save.recordLevel(level, { stars, survivors, score: run.score, coins: payout });
      save.setLastIncome(payout);
      save.addStats(this._statsPartial(payout));
    }
    this._failStreak.delete(level);                       // QA LVL-21: a clear resets the fail-streak assist
    const b = run.breakdown;
    // round 7 (r7, explain:7): the results show the level bonus as its two parts — the star reward and the survivor reward.
    // Since duplicates / refunds count as pickups (ECONOMY.breakdownOf), b.bonus is exactly this bonus as credited (×0.6 on a
    // replay, whole coins after the settle); the star part is its own rounding, the survivor part the rest, so the two
    // always add up to b.bonus and the chips to the payout
    const pay = run.replay ? ECONOMY.replayPayout : 1;
    const bonusStars = clamp(Math.round(starRaw * pay), 0, b.bonus);
    // fresh data object (once per run) — ui may keep it
    this._resultData = {
      level, stars, coins: payout, survivors, eBoss, score: run.score, endless: false,
      breakdown: { kills: b.kills, gates: b.gates, piles: b.piles, boss: b.boss, bonus: b.bonus, bonusStars, bonusSurvivors: b.bonus - bonusStars },
    };
  }

  _presentWon() {
    const d = this._resultData;
    if (!d) return;
    this._codexSeen('hud.stars', false);                 // r7 (teaching:5): the stars are met on the first results
    this.ctx.state.set('complete', d);
    P_COMPLETE.level = d.level;
    P_COMPLETE.stars = d.stars;
    P_COMPLETE.survivors = d.survivors;
    P_COMPLETE.eBoss = d.eBoss;
    P_COMPLETE.coins = d.coins;
    P_COMPLETE.breakdown = d.breakdown;
    this.ctx.events.emit('level:complete', P_COMPLETE);
  }

  /**
   * Game over (GDD §9.1): keeps ECONOMY.gameOverKeep of the run's coins, plus (QA LVL-21) a consolation of
   * levelBonus(L)·failBonusFrac·(fraction of the level reached), paid in full through the coin path (breakdown
   * 'bonus'). Counts the failure for the fail-streak assist.
   */
  _commitLost() {
    const ctx = this.ctx;
    const run = ctx.run;
    const save = ctx.save;
    const script = this._script;
    const level = this._level;
    this._settleCoins();
    const dist = this._deathDistance >= 0 ? this._deathDistance : ctx.world.distance;   // where the squad was lost
    const fraction = script.length > 0 ? clamp(dist / script.length, 0, 1) : 0;
    const kept = Math.round(run.coins * ECONOMY.gameOverKeep);
    const before = run.coins;
    const consolation = Math.round(ECONOMY.levelBonus(level) * ECONOMY.failBonusFrac * fraction);
    if (consolation > 0) {
      this._emitBonus(consolation);
      this._settleCoins();
    }
    const payout = kept + (run.coins - before);
    run.score = SCORE.kill * run.killCoins + SCORE.peak * run.peakSquad + SCORE.flipped * run.gatesFlipped
      + (run.lostToRed === 0 ? SCORE.noRedLoss : 0);
    if (save) {
      save.addCoins(payout);
      save.addStats(this._statsPartial(payout));
    }
    this._failStreak.set(level, (this._failStreak.get(level) | 0) + 1);
    this._resultData = { level, fraction, coinsKept: payout, endless: false };
  }

  _presentLost() {
    const d = this._resultData;
    if (!d) return;
    this.ctx.state.set('gameover', d);
    P_FAILED.level = d.level;
    P_FAILED.fraction = d.fraction;
    P_FAILED.coinsKept = d.coinsKept;
    this.ctx.events.emit('level:failed', P_FAILED);
  }

  _commitEndless() {
    const ctx = this.ctx;
    const run = ctx.run;
    const save = ctx.save;
    this._settleCoins();
    // metres are scored only while running: the results distance is where the squad died (QA LVL-10)
    const distance = Math.round(this._deathDistance >= 0 ? this._deathDistance : ctx.world.distance);
    const score = Math.round(run.score);
    run.score = score;
    const payout = run.coins;                       // already ×ECONOMY.endlessPayout per coin
    const prevBest = (save && save.data && save.data.endless) ? save.data.endless.bestScore | 0 : 0;
    const newBest = score > prevBest;
    const best = Math.max(prevBest, score);
    run.newBest = newBest;
    if (save) {
      save.addCoins(payout);
      save.recordEndless({ distance, score });
      save.addStats(this._statsPartial(payout));
    }
    this._resultData = { endless: true, distance, score, best, coins: payout, chunks: run.chunks, newBest };
  }

  _presentEndless() {
    const d = this._resultData;
    if (!d) return;
    this.ctx.state.set('complete', d);
    P_END.distance = d.distance;
    P_END.score = d.score;
    P_END.best = d.best;
    P_END.coins = d.coins;
    P_END.chunks = d.chunks;
    P_END.newBest = d.newBest;
    this.ctx.events.emit('endless:end', P_END);
  }

  /**
   * QA LVL-21 fail-streak assist: after LEVELS.curve.assistAfterFails consecutive failures of this campaign level in
   * the session, the attempt starts with + ceil(assistStartFrac·E_boss·k) soldiers, k = 1, 2, 3, 4 for each further
   * consecutive failure (the normal count roll-up shows it).
   */
  _applyAssist() {
    this._assistSoldiers = 0;
    if (this._endless) return;
    const fails = this._failStreak.get(this._level) | 0;
    const c = LEVELS.curve;
    if (!(c.assistAfterFails > 0) || fails < c.assistAfterFails) return;
    // escalates with every further failure: the 1st assisted attempt gets frac·E_boss, the next 2·frac·E_boss, … (capped at
    // LEVELS.curve.assistMaxSteps steps), so each retry starts stronger than the last
    const steps = Math.min(c.assistMaxSteps > 0 ? c.assistMaxSteps : 1, fails - c.assistAfterFails + 1);
    const n = Math.ceil(c.assistStartFrac * this._script.eBoss * steps);
    const squad = this.ctx.squad;
    if (!squad || !(n > 0)) return;
    squad.addSoldiers(n, 'assist');
    this._assistSoldiers = n;
    this.ctx.run.assist = n;
    // round-3 QA LVL-21: the player is told ("REINFORCEMENTS: +N SOLDIERS"); not a once-ever tutorial hint, so it bypasses
    // showHint's save.hintDone gate and shows on every assisted attempt
    if (typeof c.assistHint === 'function') {
      P_HINT.id = 'assist';
      P_HINT.text = c.assistHint(n);
      P_HINT.hold = 0; P_HINT.until = null; P_HINT.priority = false; P_HINT.event = -1;   // r7: an unbound hint
      this.ctx.events.emit('hint:show', P_HINT);
    }
  }
}
