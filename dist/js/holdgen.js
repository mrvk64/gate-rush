// js/holdgen.js — the HORDE generator (PLAN horde TECH). Pure (util, data), imported only by levelgen.js.
// holdSpec(L, seed, opts) decides what does not depend on play: the run-phase options for levelgen.generateRunSteps (D39) and
// the hold (E_hold, surges, patterns, variant, counts, the HP scale at C = E_hold and the expected shop, boss, supply, coins,
// first-meeting and assist rules); generateHoldScript appends the { type: 'hold', at, spec } event hold.js begins from. The
// live squad and shop are applied at run time with the util hold math. One mulberry32 stream per (L, seed): deterministic.
import { mulberry32, round5, holdClimbK } from './util.js';
import { HORDE_GEN, FIRE, UPGRADES, LEAK_MODEL, BOSSES, eBossOf, expectedRanksOf, bossIdOf } from './data.js';

/** [[L, v], …] lerp table: linear between rows, the end rows held flat. */
function lerpTable(t, L) {
  if (L <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (L <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (L - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
  }
  return t[t.length - 1][1];
}

/** [[L, v], …] step table: the value of the last row at or below the level (the first row's below the table). */
function stepTable(t, L) {
  let v = t[0][1];
  for (let i = 1; i < t.length && t[i][0] <= L; i++) v = t[i][1];
  return v;
}

/** The pattern bag of level L: every pattern introduced at or before it (HORDE_GEN.patterns.bag; the first row's below it). */
function patternBag(L) {
  const bag = [], rows = HORDE_GEN.patterns.bag, at = Math.max(L, rows[0][0]);
  for (const row of rows) if (row[0] <= at) bag.push(...row[1]);
  return bag;
}

/** Kill coin of a hold with n units at C = E_hold (HORDE_GEN.coins: the v1 total spread over the v2 crowd). */
function coinPerKill(L, n) {
  const c = HORDE_GEN.coins, k = c.n1;
  const n1 = (l) => Math.round(k.mult * (k.base + k.per * Math.min(l, k.to) + k.perLate * Math.max(0, Math.min(l, k.toLate) - k.to)) / k.round) * k.round;
  const last = c.scale[c.scale.length - 1];
  const scaleV1 = L <= last[0] ? lerpTable(c.scale, L) : last[1] * n1(c.lateRef) / n1(L);
  return scaleV1 * n1(L) / Math.max(1, n);
}

/**
 * The Horde level spec of campaign level L and seed. opts (all optional): debut (bool; default L === HORDE_GEN.debut.level —
 * level.js passes LEVEL_TYPES.horde.debut's verdict), boss (force an archetype), variant (force a variant).
 * Returns { run, hold, eTarget }:
 *   run   = generateRunSteps options { gates, eEnd, ref, noDiv, noTwoRed, noLesser, crate, kitsLane, kitsLaneFrom, fixed };
 *   hold  = the hold spec (the object built at the end), stored in the script's 'hold' event;
 *   eTarget = E_hold (the stars count survivors at the boss kill against it).
 */
export function holdSpec(L, seed, opts) {
  const G = HORDE_GEN, S = G.surges;
  const o = opts || {};
  const eBoss = eBossOf(L), eHold = round5(G.eHoldShare * eBoss);
  const debut = o.debut != null ? !!o.debut : L === G.debut.level;
  const R = mulberry32((seed * 7919 + L) >>> 0);

  // ---- run phase (levelgen.generateRunSteps; the fixed lines are judged against E_hold)
  const rf = G.run.fixed;
  const run = {
    gates: stepTable(G.run.gates, L), eEnd: eHold, ref: eHold,
    noDiv: debut && G.run.debut.noDiv, noTwoRed: debut && G.run.debut.noTwoRed, noLesser: debut && G.run.debut.noLesser,
    crate: G.run.crate, kitsLane: G.run.kitsLane, kitsLaneFrom: G.run.kitsLaneFrom,
    fixed: { lim: rf.lim, win: rf.win, shops: rf.shops.slice(), from: rf.from, repairFrom: rf.repairFrom },
  };

  // ---- the expected shop and the design DPS at C = E_hold
  const rk = expectedRanksOf(L);
  const fire = UPGRADES.fireRate.effect(rk[1]) / FIRE.rateBase, dmg = UPGRADES.damage.effect(rk[2]), bdExp = UPGRADES.bossDamage.effect(rk[4]);
  const pExp = fire * dmg;
  const profileExp = LEAK_MODEL.profileExpByLevel ? lerpTable(LEAK_MODEL.profileExpByLevel, L) : LEAK_MODEL.profileExp;
  const design = eHold * FIRE.rateBase * fire * dmg * FIRE.accuracy;

  // ---- variant and fodder mix
  const variant = o.variant || (L < G.variants.from ? 'standard' : G.variants.list[(L * 7 + (seed >>> 3)) % G.variants.list.length]);
  const mix = stepTable(G.mix, L).slice();
  if (variant === 'stampede') { mix[1] += G.variants.stampedeRunners; mix[0] -= G.variants.stampedeRunners; }
  const swarm = variant === 'swarm' ? G.variants.swarm : 1;

  // ---- surge timetable: the first at firstAt, then gap ± jitter with no two consecutive gaps within antiRhythm s
  const n = S.count;
  const starts = [S.firstAt];
  let lastGap = 0;
  for (let i = 1; i < n; i++) {
    let g;
    do { g = S.gap + (R() * 2 - 1) * S.jitter; } while (Math.abs(g - lastGap) < S.antiRhythm);
    lastGap = g;
    starts.push(starts[i - 1] + g);
  }
  const spawnEnd = starts[n - 1] + S.window[1];

  // ---- patterns, never one twice in a row: surge 1 an opener, surge 2 a flank or pincer (debut: centre, then a flank), then
  // the bag; a stampede / siege ends on its runner rush / brute push
  const bag = patternBag(L);
  const ns = lerpTable(S.ns, L);
  const opener = debut ? ['center'] : G.patterns.opener.filter((q) => bag.includes(q));
  const second = debut ? ['flankL', 'flankR'] : G.patterns.second.filter((q) => bag.includes(q));
  const sig = variant === 'stampede' ? 'runnerRush' : (variant === 'siege' ? 'brutePush' : '');
  const dbl = S.double;
  const surges = [];
  let prev = '';
  for (let i = 0; i < n; i++) {
    const from = i === 0 ? opener : (i === 1 ? second : bag);
    let p, k = 0;
    do { p = from[Math.floor(R() * from.length)]; k++; } while ((p === prev || (i > 1 && variant === 'pincer' && k < 3 && !/pincer|split|sweep/.test(p))) && k < 20);
    if (i === n - 1 && sig !== prev && bag.includes(sig)) p = sig;
    prev = p;
    const double = L >= dbl.from && i >= 1 && R() < (L >= dbl.lateFrom ? dbl.lateChance : dbl.chance) && p !== 'pincer';
    surges.push({
      t: starts[i], pattern: p, n: Math.round(ns * swarm * S.shares[i]),
      window: S.window[0] + R() * (S.window[1] - S.window[0]), double, lag: dbl.lag[0] + R() * (dbl.lag[1] - dbl.lag[0]),
    });
  }

  // ---- counts and the HP scale: rho·D over the spawn time, spread over Σ N·baseHp
  let fodder = 0;
  for (let i = 0; i < n; i++) fodder += surges[i].n;
  const trickle = Math.round(fodder * S.trickle / (1 - S.trickle));
  const siege = variant === 'siege' ? G.variants.siege : 1;
  const cb = G.counts.brutes, cs = G.counts.spitters;
  const brutes = debut || L < cb.from ? 0 : Math.round(Math.round(Math.min(cb.cap, cb.per * L)) * siege);
  const spitters = debut || L < cs.from ? 0 : Math.round((L < cs.lateFrom ? cs.early : Math.round(Math.min(cs.cap, cs.at13 + cs.per * (L - cs.lateFrom)))) * siege);
  const N = fodder + trickle;
  const bh = G.baseHp;
  let hpSum = N * mix[0] * bh.walker;
  hpSum += N * mix[1] * bh.runner;
  hpSum += N * mix[2] * bh.crawler;
  hpSum += brutes * bh.brute + spitters * bh.spitter;
  const hz = lerpTable(G.rho, L) * design * spawnEnd / hpSum;

  // ---- boss, supply drops, coins
  const bossId = o.boss || bossIdOf(L);
  const arch = BOSSES.archetypes[bossId] || {};
  const factor = (G.boss.factor[bossId] || 1) * (arch.hpMult > 0 ? arch.hpMult : 1);
  const supplyN = debut ? 0 : stepTable(G.supply.count, L), sx = G.supply.x;
  const supply = [];                                 // the last draws: every field above keeps its stream
  for (let i = 0; i < supplyN; i++) supply.push({ t: G.supply.at[i] * spawnEnd, x: (R() < 0.5 ? -1 : 1) * (sx[0] + R() * (sx[1] - sx[0])) });

  const hold = {
    L, seed, eBoss, eHold, debut, variant,
    pExp, profileExp, surplusExp: G.surplusExp, design, hz,
    surges, trickle, spawnEnd, mix, brutes, spitters,
    spitKills: stepTable(G.counts.spitKills, L), climbK: holdClimbK(eHold, G.climb),
    boss: {
      id: bossId, factor, bdExp, split: arch.twins ? arch.hpSplit : 1, at: starts[n - 1] + G.boss.spawnAfter,
      enrageS: debut ? G.debut.enrageS : null, attacks: !debut,   // enrageS null: the runtime's (HORDE, 20 s)
    },
    supply, airstrike: L >= G.supply.airstrikeFrom,
    coinPerKill: coinPerKill(L, N + brutes + spitters),
    firstMeet: { threat: G.firstMeet.threat, surge1NeedsDecisions: G.firstMeet.surge1NeedsDecisions, laterNeedsAction: G.firstMeet.laterNeedsAction },
    assist: { kitsPerStep: G.assist.kitsPerStep, capPerStep: G.assist.capPerStep },
  };
  return { run, hold, eTarget: eHold };
}

/**
 * Appends the hold to a generated run phase: a new script with the run's events (a 'boss' event, if the run carries one, is
 * dropped — the hold's boss replaces it) and { type: 'hold', at, spec: spec.hold } at the stop (the dropped boss's `at`, else
 * the run's length). The run script is not modified.
 */
export function generateHoldScript(runScript, spec) {
  const events = [];
  let at = runScript.length;
  for (const ev of runScript.events) {
    if (ev.type === 'boss') { at = ev.at; continue; }
    events.push(ev);
  }
  events.push({ type: 'hold', at, spec: spec.hold });
  return Object.assign({}, runScript, { events });
}
