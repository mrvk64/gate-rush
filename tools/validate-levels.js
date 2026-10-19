#!/usr/bin/env node
// tools/validate-levels.js — GATE RUSH level validator (ARCHITECTURE §13 / §15.3, GDD §4.4, §6.3, §10, §10.1).
//
// Usage (from the project root, node ≥ 18, zero dependencies):
//   node tools/validate-levels.js                 # L1 (authored) + L2–L30 (generated, seed 1000 + L) + endless D 1–30
//   node tools/validate-levels.js --chunks 40     # endless chunks D 1–40 (default 30)
//   node tools/validate-levels.js --level 7       # one campaign level, full trace
//   node tools/validate-levels.js --seed 4242     # campaign levels with seed 4242 + L, endless with seed 4242
//   node tools/validate-levels.js --verbose       # full E-trace notes for every level
//   node tools/validate-levels.js --json          # machine-readable report on stdout instead of the tables
//   node tools/validate-levels.js --no-endless    # skip the endless chunk checks
//
// For every level it prints: gate events (layout mix and lane labels), waves (count and expected leak per wave
// against the level's band), the DESIGN E-trace (what script.expected declares: the authored L1 declares its cautious
// line, generated levels the greedy line the generator sizes gates and solves wave HP on — QA LVL-1), Σ EV, the
// weak-shooter survivability line (0.3·H) and the FULL-INTAKE greedy lines (every lane shot at min(40, C·f)·t_w + the
// intake bucket, best lane, ÷ ladders included) for a fresh and a rank-3 profile, and every warning. Errors (from
// levelgen.validateLevel): design / declared line below E_boss − 15 %, full-intake line above 1.6·E_boss (base) or
// 2.2·E_boss (rank 3) on L2–L30, a ÷ lane the full-intake line gains on, an intro level without its gate feature
// (L6 x3, L7 triple, L8 ÷3). It also checks determinism (same L + seed → identical JSON), that generated scripts
// declare exactly the line their events re-simulate to, and endless chunks D = 1…30 (absolute `at` inside the chunk,
// mini-boss cadence, cross-chunk gate spacing, determinism, specials unlocked at the chunk's equivalent level, and — round 5d —
// the zombie pools: every chunk on its own and the whole run concatenated must keep each type's live count (alive from spawn to
// contact, waves and guards) within its pool; the endless table prints each chunk's wave count against the pre-5d count, its
// population per wave against the population it owes, the horde it delivers, and its peak pool use per type).
// Exit code 1 on any error.

import { generateLevel, generateChunk, validateLevel, curve, endlessParams, laneLabel, simulateEndless, endlessDesignMult, endlessPressure, endlessPoolPeaks, endlessPoolReserve } from '../js/levelgen.js';
import { LEVELS, GATE_RULES, LEAK_BANDS, BOSSES, WORLD, ZOMBIES } from '../js/data.js';

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}
const OPT = {
  level: argValue('--level') !== null ? Math.max(1, parseInt(argValue('--level'), 10) || 1) : null,
  seed: argValue('--seed') !== null ? (parseInt(argValue('--seed'), 10) >>> 0) : null,
  verbose: argv.includes('--verbose') || argv.includes('-v'),
  json: argv.includes('--json'),
  endless: !argv.includes('--no-endless'),
  chunks: argValue('--chunks') !== null ? Math.max(1, parseInt(argValue('--chunks'), 10) || 30) : 30,
};

const out = OPT.json ? () => {} : (s = '') => process.stdout.write(s + '\n');
let errorCount = 0;
let warningCount = 0;
const report = { levels: [], endless: null, errors: [] };

/** QA LVL-30: no opener (values) may open more than this share of the generated levels. */
const OPENER_SHARE_MAX = 0.3;

function fail(where, msg) {
  errorCount++;
  report.errors.push(`${where}: ${msg}`);
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function lpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function pct(x) { return `${Math.round(x * 100)}%`; }
function round1(x) { return Math.round(x * 10) / 10; }

function bandFor(L) {
  for (let i = 0; i < LEAK_BANDS.length; i++) if (L >= LEAK_BANDS[i].L[0] && L <= LEAK_BANDS[i].L[1]) return LEAK_BANDS[i].band;
  return LEAK_BANDS[LEAK_BANDS.length - 1].band;
}

/** "5→20→19→38→…" from the validator's trace rows (one value per gate / wave / boss moment). */
function traceLine(res, E0) {
  const parts = [String(Math.round(E0))];
  for (let i = 0; i < res.trace.length; i++) parts.push(String(res.trace[i].e));
  return parts.join('→');
}

function layoutMix(script) {
  const mix = { pair: 0, single: 0, triple: 0, item: 0, red: 0, guarded: 0 };
  for (let i = 0; i < script.events.length; i++) {
    const ev = script.events[i];
    if (ev.type !== 'gates') continue;
    mix[ev.layout]++;
    let red = false, item = false;
    for (let k = 0; k < ev.lanes.length; k++) {
      if (ev.lanes[k].op === '-' || ev.lanes[k].op === '/') red = true;
      if (ev.lanes[k].op === 'item') item = true;
    }
    if (red) mix.red++;
    if (item) mix.item++;
    if (ev.guards && ev.guards.length) mix.guarded++;
  }
  return mix;
}

function countType(script, type) {
  let n = 0;
  for (let i = 0; i < script.events.length; i++) if (script.events[i].type === type) n++;
  return n;
}

/** Re-simulation parity for generated scripts: script.expected must be exactly the cautious line of its events. */
function parityCheck(where, script, res) {
  const exp = script.expected;
  const last = exp[exp.length - 1];
  if (Math.abs(last.e - Math.max(1, Math.round(res.designFinal))) > 1) {
    fail(where, `script.expected ends at ${last.e} but its events re-simulate to ${Math.round(res.designFinal)} (generator / validator disagree)`);
  }
  for (let i = 0; i < res.warnings.length; i++) {
    if (res.warnings[i].indexOf('deviates from the re-simulated') !== -1) fail(where, `generated script: ${res.warnings[i]}`);
  }
}

/** Contract checks of the generated script shape that level.js relies on (ARCH §6.16 / §8.7). */
function shapeCheck(where, script, L) {
  const c = curve(L);
  if (script.length !== c.len) fail(where, `length ${script.length} ≠ curve ${c.len}`);
  if (script.roadSpeed !== c.v) fail(where, `roadSpeed ${script.roadSpeed} ≠ curve ${c.v}`);
  if (script.eBoss !== c.eBoss) fail(where, `eBoss ${script.eBoss} ≠ curve ${c.eBoss}`);
  if (!Array.isArray(script.expected) || script.expected.length < 2) fail(where, 'expected[] not filled');
  else if (script.expected[0].at !== 0) fail(where, `expected[] must start at 0 (starts at ${script.expected[0].at})`);
  const gates = countType(script, 'gates');
  if (gates !== c.gates) fail(where, `${gates} gate events, curve says ${c.gates}`);
  const boss = script.events.filter((e) => e.type === 'boss');
  if (boss.length !== 1 || boss[0].at !== c.len || boss[0].archetype !== c.bossId || boss[0].hp !== c.bossHp) {
    fail(where, `boss event mismatch (want ${c.bossId} hp ${c.bossHp} @${c.len})`);
  }
  for (let i = 0; i < script.events.length; i++) {
    const ev = script.events[i];
    if (ev.type !== 'gates') continue;
    for (let k = 0; k < ev.lanes.length; k++) {
      const lane = ev.lanes[k];
      if ((lane.op === '+' || lane.op === 'x' || lane.op === '/') && !Number.isFinite(lane.cap)) fail(where, `gate @${ev.at} lane ${k}: cap missing`);
      if (lane.op === '-' && !Number.isFinite(lane.flipCap)) fail(where, `gate @${ev.at} lane ${k}: flipCap missing`);
      if ((lane.op === 'x' || lane.op === '/') && !Number.isFinite(lane.step)) fail(where, `gate @${ev.at} lane ${k}: step missing`);
    }
    if (ev.guards) for (let g = 0; g < ev.guards.length; g++) if (!ev.guards[g].hp) fail(where, `gate @${ev.at}: guard ${g} has no baked hp`);
  }
}

// ---------------------------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------------------------

function levelSeed(L) { return OPT.seed !== null ? (OPT.seed + L) >>> 0 : LEVELS.seedBase + L; }

function runLevel(L) {
  const authored = LEVELS.authored[L];
  const seed = authored ? authored.seed : levelSeed(L);
  const where = authored ? `L${L} (authored)` : `L${L}`;
  const t0 = Date.now();
  const script = authored || generateLevel(L, seed);
  const ms = Date.now() - t0;
  const res = validateLevel(script);
  const c = curve(L);
  for (let i = 0; i < res.errors.length; i++) fail(where, res.errors[i]);
  warningCount += res.warnings.length;

  if (!authored) {
    shapeCheck(where, script, L);
    parityCheck(where, script, res);
    // determinism: same (L, seed) → identical JSON; the run seed actually matters
    const again = JSON.stringify(generateLevel(L, seed));
    if (again !== JSON.stringify(script)) fail(where, 'generateLevel is not deterministic for the same (L, seed)');
    const other = JSON.stringify(generateLevel(L, seed + 7919));
    if (other === JSON.stringify(script)) fail(where, 'a different seed produced the identical script');
  }

  const band = bandFor(c.L);
  const entry = {
    level: L, authored: !!authored, seed, ms, ok: res.ok,
    len: script.length, v: script.roadSpeed, gates: countType(script, 'gates'), waves: countType(script, 'wave'),
    eStart: script.expected[0] ? script.expected[0].e : 0, eBoss: script.eBoss, boss: c.bossId, bossHp: c.bossHp,
    cautious: Math.round(res.cautiousFinal), declared: Math.round(res.declaredFinal), greedy: Math.round(res.greedyFinal),
    design: Math.round(res.designFinal), designMode: res.designMode,
    maxBase: res.maxLines && res.maxLines[0] ? Math.round(res.maxLines[0].final) : 0,
    maxR3: res.maxLines && res.maxLines[1] ? Math.round(res.maxLines[1].final) : 0,
    // QA LVL-31: median seconds between gate arrivals; QA LVL-16: halves holding the better option; QA LVL-30: the opener
    gatePeriod: gatePeriod(script), sides: res.sides || { left: 0, right: 0 }, opener: openerOf(script),
    noSteer: Math.round(res.noSteerFinal || 0),   // round-3 QA LVL-22: the never-steering squad's line (centre lane, full intake)
    evNeed: Math.round(GATE_RULES.generation.evFraction * script.eBoss), band,
    mix: layoutMix(script), trace: res.trace, gateRows: res.gates, waveRows: res.waves,
    errors: res.errors.slice(), warnings: res.warnings.slice(),
  };
  report.levels.push(entry);
  return { entry, script, res };
}

/** QA LVL-31: median time between consecutive gate arrivals (s) at the level's road speed. */
function gatePeriod(script) {
  const at = script.events.filter((e) => e.type === 'gates').map((e) => e.at).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < at.length; i++) gaps.push((at[i] - at[i - 1]) / script.roadSpeed);
  gaps.sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
}

/** QA LVL-30: the opener's values, lane order ignored ("+3|+4", "+5|x2", "+3|item"). */
function openerOf(script) {
  const g = script.events.find((e) => e.type === 'gates');
  if (!g) return '';
  return g.lanes.map((l) => (l.op === 'item' ? 'item' : l.op + l.value)).sort().join('|');
}

function printSummaryHeader() {
  out('');
  out(`${pad('L', 4)}${pad('len', 6)}${pad('v', 6)}${pad('gates p/s/t·red·item·grd', 26)}${pad('waves', 7)}${pad('E0', 5)}${pad('E_boss', 8)}${pad('design', 13)}${pad('weak/caut', 11)}${pad('full base / r3', 20)}${pad('no-steer', 10)}${pad('boss', 15)}${pad('hp', 7)}${pad('period', 8)}${pad('L/R', 6)}${pad('opener', 14)}${pad('warn', 6)}status`);
  out('-'.repeat(150));
}

function printSummaryRow(e) {
  const m = e.mix;
  const gates = `${e.gates} ${m.pair}/${m.single}/${m.triple}·${m.red}·${m.item}·${m.guarded}`;
  const design = `${e.design} (${pct(e.design / e.eBoss)})`;
  const caut = e.designMode === 'cautious' ? `${e.greedy} gr` : `${pct(e.cautious / e.eBoss)}`;
  const full = `${pct(e.maxBase / e.eBoss)} / ${pct(e.maxR3 / e.eBoss)}`;
  const status = e.errors.length ? `FAIL (${e.errors.length})` : 'ok';
  out(`${pad(e.level + (e.authored ? '*' : ''), 4)}${pad(e.len, 6)}${pad(e.v.toFixed(1), 6)}${pad(gates, 26)}${pad(e.waves, 7)}${pad(e.eStart, 5)}${pad(e.eBoss, 8)}${pad(design, 13)}${pad(caut, 11)}${pad(full, 20)}${pad(e.noSteer > 0 ? pct(e.noSteer / e.eBoss) : '-', 10)}${pad(e.boss, 15)}${pad(e.bossHp, 7)}${pad(e.gatePeriod.toFixed(1) + ' s', 8)}${pad(e.sides.left + '/' + e.sides.right, 6)}${pad(e.opener, 14)}${pad(e.warnings.length, 6)}${status}`);
}

function printLevelDetail(e) {
  out('');
  out(`── L${e.level}${e.authored ? ' (authored)' : ''} · seed ${e.seed} · ${e.len} m @ ${e.v.toFixed(1)} m/s · boss ${e.boss} ${e.bossHp} HP · leak band ${pct(e.band[0])}–${pct(e.band[1])}${e.authored ? '' : ` · generated in ${e.ms} ms`}`);
  out(`   E-trace (${e.designMode} design line): ${traceLine({ trace: e.trace }, e.eStart)}  (design ${e.design} = ${pct(e.design / e.eBoss)} of E_boss ${e.eBoss}; declared ${e.declared})`);
  out(`   ${e.designMode === 'cautious' ? 'Σ EV (greedy line)' : 'weak-shooter line (0.3·H)'}: ${e.designMode === 'cautious' ? e.greedy : e.cautious}; full-intake line: fresh ${e.maxBase} (${pct(e.maxBase / e.eBoss)}, limit 160 %), rank 3 ${e.maxR3} (${pct(e.maxR3 / e.eBoss)}, limit 220 %)`);
  for (let i = 0; i < e.gateRows.length; i++) {
    const g = e.gateRows[i];
    const guards = g.guards ? `  guards ${g.guards.map((gd) => `L${gd.lane}:${gd.units.walker | 0}w`).join(',')}` : '';
    out(`   gate  @${lpad(g.at, 4)} → ${lpad(Math.round(g.arrival), 4)} m  ${pad(g.layout, 7)}${pad(g.lanes.map(laneLabel).join(' | '), 62)} ${e.designMode} lane ${g.lane}: ${lpad(Math.round(g.eBefore), 4)} → ${lpad(Math.round(g.eAfter), 4)}${guards}${g.hint ? `  hint ${g.hint}` : ''}`);
  }
  for (let i = 0; i < e.waveRows.length; i++) {
    const w = e.waveRows[i];
    const units = Object.keys(w.units).filter((k) => (w.units[k] | 0) > 0).map((k) => `${w.units[k]} ${k}`).join(' + ');
    const hp = w.hp ? Object.keys(w.units).filter((k) => (w.units[k] | 0) > 0).map((k) => `${k[0]}${w.hp[k]}`).join(' ') : 'live';
    // '!' = the validator warned about this wave's leak (it allows the rounding slack of integer HP)
    const flagged = e.warnings.some((msg) => msg.indexOf(`${w.kind} @${w.at} (`) === 0 && msg.indexOf('expected leak') !== -1);
    out(`   ${pad(w.kind, 6)}@${lpad(w.at, 4)} → ${lpad(Math.round(w.contact), 4)} m  ${pad(w.pattern, 7)}${pad(units, 46)} hp ${pad(hp, 26)} leak ${lpad(round1(w.leak * 100), 5)} %${flagged ? ' !' : '  '} bites ${lpad(round1(w.bites), 4)}  E ${lpad(Math.round(w.eBefore), 4)} → ${lpad(Math.round(w.eAfter), 4)}`);
  }
  if (OPT.verbose) for (let i = 0; i < e.trace.length; i++) out(`   · ${lpad(Math.round(e.trace[i].at), 5)} m  E ${lpad(e.trace[i].e, 4)}  ${e.trace[i].note}`);
  for (let i = 0; i < e.warnings.length; i++) out(`   warning: ${e.warnings[i]}`);
  for (let i = 0; i < e.errors.length; i++) out(`   ERROR: ${e.errors[i]}`);
}

// ---------------------------------------------------------------------------------------------
// Endless
// ---------------------------------------------------------------------------------------------

function runEndless() {
  const seed = OPT.seed !== null ? OPT.seed : 4242;
  const chunk = LEVELS.endless.chunk;
  const rows = [];
  const all = [];
  for (let D = 1; D <= OPT.chunks; D++) {
    const where = `endless D${D}`;
    const start = (D - 1) * chunk;
    let events;
    try { events = generateChunk(D, seed, start); } catch (err) { fail(where, `generateChunk threw: ${err && err.stack ? err.stack : err}`); continue; }
    if (!Array.isArray(events) || events.length === 0) { fail(where, 'generateChunk returned no events'); continue; }
    const p = endlessParams(D);
    // determinism and absolute positions
    if (JSON.stringify(generateChunk(D, seed, start)) !== JSON.stringify(events)) fail(where, 'generateChunk is not deterministic for the same (D, seed, startAt)');
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!(ev.at >= start && ev.at < start + chunk)) fail(where, `${ev.type} at ${ev.at} outside the chunk [${start}, ${start + chunk})`);
      if (Object.isFrozen(ev)) fail(where, `${ev.type} @${ev.at} is frozen (the runner's rubber band mutates the first gate event)`);
    }
    const gates = events.filter((e) => e.type === 'gates').length;
    const waves = events.filter((e) => e.type === 'wave').length;
    const bosses = events.filter((e) => e.type === 'boss');
    if (gates !== p.gates) fail(where, `${gates} gate events, GDD §10.1 says ${p.gates}`);
    if (waves !== p.waves) fail(where, `${waves} waves, GDD §10.1 says ${p.waves}`);
    if (p.miniBoss) {
      if (bosses.length !== 1 || !bosses[0].mini || !bosses[0].minionHp || !(bosses[0].hp > 0)) fail(where, 'mini-boss event missing or malformed (needs mini:true, hp, minionHp)');
      else if (BOSSES.endlessRotation.indexOf(bosses[0].archetype) === -1) fail(where, `mini-boss archetype ${bosses[0].archetype} not in the endless rotation`);
    } else if (bosses.length) fail(where, 'unexpected boss event');
    for (let i = 0; i < events.length; i++) if (events[i].type === 'wave' && !events[i].hp) fail(where, `wave @${events[i].at} has no baked hp`);
    // the chunk on its own through the validator (endless wrapper: no campaign structure / E-trace)
    const res = validateLevel({ endless: true, id: p.Leq, name: `Endless D${D}`, seed, length: chunk, roadSpeed: p.v, eBoss: Math.round(p.e), expected: [{ at: 0, e: Math.round(p.e) }], events });
    for (let i = 0; i < res.errors.length; i++) fail(where, res.errors[i]);
    warningCount += res.warnings.length;
    for (let i = 0; i < events.length; i++) all.push(events[i]);
    const labels = events.filter((e) => e.type === 'gates').map((e) => e.lanes.map(laneLabel).join(' | '));
    // round 5d (GDD §10.1): the chunk's per-zombie HP ceiling (endlessHpCap at E(D), base ranks) and the largest HP a single
    // wave / guard zombie carries once the level runner's live multiplier (design multiple × pressure, p = 1) is clamped to it —
    // the horde grows in numbers (pop = popBase × pressure^popShare), never into single unkillable zombies
    const liveMult = endlessDesignMult(D) * Math.pow(endlessPressure(D), LEVELS.endless.pressure && LEVELS.endless.pressure.hpShare >= 0 ? LEVELS.endless.pressure.hpShare : 1);
    // round 5d (pool-safe by construction): the chunk's peak live count per type in the validator's pool model and the horde it delivers
    // against the population it owes (endlessParams.need = pop × the pre-5d wave count; the per-wave share caps and the pool fit trim it)
    const peaks = endlessPoolPeaks(events, p.v, { per: [0, 0, 0, 0, 0], total: 0 });
    let delivered = 0;
    for (let i = 0; i < events.length; i++) if (events[i].type === 'wave') for (const t in events[i].units) delivered += events[i].units[t] | 0;
    let maxHp = 0, maxUncapped = 0, wavePeak = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const tabs = ev.type === 'wave' ? [[ev.units, ev.hp]] : (ev.type === 'gates' && ev.guards ? ev.guards.map((gd) => [gd.units, gd.hp]) : []);
      for (let k = 0; k < tabs.length; k++) {
        const units = tabs[k][0], hp = tabs[k][1];
        let n = 0;
        for (const t in units) {
          if (!(units[t] > 0) || !hp || !Number.isFinite(hp[t])) continue;
          n += units[t];
          const live = Math.round(hp[t] * liveMult);
          if (live > maxUncapped) maxUncapped = live;
          const capped = Math.min(live, p.hpCap && Number.isFinite(p.hpCap[t]) ? p.hpCap[t] : Infinity);
          if (capped > maxHp) maxHp = capped;
          if (capped > (p.hpCap ? p.hpCap[t] : Infinity)) fail(where, `${ev.type} @${ev.at}: ${t} HP ${capped} above the chunk's cap ${p.hpCap[t]}`);
        }
        if (ev.type === 'wave' && n > wavePeak) wavePeak = n;
      }
    }
    rows.push({ D, v: p.v, e: Math.round(p.e), gates, waves, wavesBase: p.wavesBase, pop: p.pop, popBase: p.popBase, popWave: p.popWave, need: p.need, delivered, peaks: peaks.per.slice(), peakTotal: peaks.total, wavePeak, hpCap: p.hpCap, maxHp, maxUncapped, mini: p.miniBoss ? `${bosses[0] ? bosses[0].archetype : '?'} ${bosses[0] ? bosses[0].hp : ''}` : '', events: events.length, warnings: res.warnings, errors: res.errors, labels });
  }
  // the whole run as one script: sort order and cross-chunk spacing (two gates never armed together)
  const run = validateLevel({ endless: true, id: LEVELS.endlessUnlock + 1, name: 'Endless run', seed, length: OPT.chunks * chunk, roadSpeed: LEVELS.endless.speed.base, eBoss: 1, expected: [{ at: 0, e: 1 }], events: all });
  for (let i = 0; i < run.errors.length; i++) fail('endless run', run.errors[i]);
  // QA LVL-17: the endless line of a full-intake greedy player with a rank-3 shop (and a fresh one) under the live rubber
  // band: C / E(D) must stay ≤ ENDLESS_MAX_RATIO at every chunk boundary after D2
  const lines = [];
  for (const rank of [3, 0]) {
    const sim = simulateEndless(seed, OPT.chunks, rank);
    lines.push({ rank, ...sim });
    for (const b of sim.boundaries) {
      if (b.D > 2 && b.ratio > ENDLESS_MAX_RATIO) fail(`endless line (rank ${rank})`, `C/E = ${b.ratio.toFixed(2)} at the D${b.D} boundary (C ${b.C}, E ${b.E}; limit ${ENDLESS_MAX_RATIO})`);
    }
  }
  report.endless = { seed, rows, runErrors: run.errors, lines, poolReserve: endlessPoolReserve({}) };
  return rows;
}

/** QA LVL-17: an endless squad stays within this multiple of E(D) at every chunk boundary after D2 (the rubber band). */
const ENDLESS_MAX_RATIO = 3;

function printEndless(rows) {
  out('');
  const hc = LEVELS.endless.hpCapSeconds || {};
  out(`Endless (seed ${report.endless.seed}): chunks of ${LEVELS.endless.chunk} m, absolute \`at\`, rubber band applied by the level runner; round 5d: pop = population per wave after the pressure (base before it), hp cap = the chunk's per-zombie HP ceiling w/r/c/b/s (hpCapSeconds ${['walker', 'runner', 'crawler', 'brute', 'spitter'].map((t) => hc[t]).join('/')} s × the on-curve design DPS), max HP = the largest single wave / guard zombie once the live multiplier is clamped (uncapped in brackets), mini-boss hold ${LEVELS.endless.miniBossHold ? `release ${LEVELS.endless.miniBossHold.releaseM} m` : 'off'}`);
  const reserve = report.endless.poolReserve || {};
  const TYPES = ZOMBIES.common.types;
  out(`round 5d pool-safe by construction: waves = the chunk's wave count (the pre-5d count in brackets when the pool-safe ramp added waves, LEVELS.endless.waves.maxPerChunk / minSpacingM), pop/wave = the population per wave (the population the chunk owes per pre-5d wave in brackets), horde = the zombies the chunk's waves deliver / the population it owes (pop × pre-5d waves; the per-wave pool shares and the pool fit trim it), pool peak = the most of each type alive at once in the validator's model (spawn → contact, waves + guards) against the pools ${TYPES.map((t) => ZOMBIES[t].pool).join('/')} with ${TYPES.map((t) => reserve[t]).join('/')} kept for the mini-boss's minions (poolReserve)`);
  out(`${pad('D', 4)}${pad('v', 7)}${pad('E', 6)}${pad('gates', 7)}${pad('waves', 9)}${pad('pop/wave', 11)}${pad('horde', 10)}${pad('pool peak w/r/c/b/s', 22)}${pad('hp cap w/r/c/b/s', 26)}${pad('max HP (uncapped)', 20)}${pad('mini-boss', 22)}${pad('events', 8)}${pad('warn', 6)}gate events`);
  out('-'.repeat(200));
  let owedSum = 0, deliveredSum = 0, trimmedChunks = 0;
  const peakMax = [0, 0, 0, 0, 0];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cap = r.hpCap ? ['walker', 'runner', 'crawler', 'brute', 'spitter'].map((t) => (Number.isFinite(r.hpCap[t]) ? r.hpCap[t] : '-')).join('/') : '-';
    const wavesStr = r.wavesBase !== undefined && r.wavesBase !== r.waves ? `${r.waves} (${r.wavesBase})` : String(r.waves);
    const popStr = r.popWave !== undefined && r.popWave !== r.pop ? `${r.popWave} (${r.pop})` : String(r.pop);
    const hordeStr = r.need !== undefined ? `${r.delivered}/${r.need}` : String(r.delivered);
    const peakStr = r.peaks ? r.peaks.join('/') : '-';
    if (r.need !== undefined) { owedSum += r.need; deliveredSum += r.delivered; if (r.delivered < r.need) trimmedChunks++; }
    if (r.peaks) for (let k = 0; k < 5; k++) if (r.peaks[k] > peakMax[k]) peakMax[k] = r.peaks[k];
    out(`${pad(r.D, 4)}${pad(r.v.toFixed(2), 7)}${pad(r.e, 6)}${pad(r.gates, 7)}${pad(wavesStr, 9)}${pad(popStr, 11)}${pad(hordeStr, 10)}${pad(peakStr, 22)}${pad(cap, 26)}${pad(`${r.maxHp} (${r.maxUncapped})`, 20)}${pad(r.mini, 22)}${pad(r.events, 8)}${pad(r.warnings.length, 6)}${r.labels.join('  ·  ')}`);
    if (OPT.verbose) for (let k = 0; k < r.warnings.length; k++) out(`      warning: ${r.warnings[k]}`);
    for (let k = 0; k < r.errors.length; k++) out(`      ERROR: ${r.errors[k]}`);
  }
  out(`pools over D1–${rows.length}: peak alive w/r/c/b/s ${peakMax.join('/')} of ${TYPES.map((t) => ZOMBIES[t].pool).join('/')} (budget ${TYPES.map((t) => ZOMBIES[t].pool - (reserve[t] | 0)).join('/')}); horde delivered ${deliveredSum} of ${owedSum} owed (${owedSum > 0 ? Math.round(100 * deliveredSum / owedSum) : 100} %), ${trimmedChunks} chunk(s) below the owed population (per-wave pool shares / the pool fit on piled waves)`);
  for (const ln of report.endless.lines || []) {
    const max = ln.boundaries.reduce((m, b) => (b.D > 2 ? Math.max(m, b.ratio) : m), 0);
    out(`endless line, shop rank ${ln.rank} (full-intake greedy, live rubber band; mini-bosses not modelled): C/E at boundaries ${ln.boundaries.map((b) => `D${b.D} ${b.ratio.toFixed(2)}`).join(' ')} — max after D2 ${max.toFixed(2)} (limit ${ENDLESS_MAX_RATIO}); gain cap ${ln.guards.cap}, keep ${ln.guards.keep} (round-3 QA LVL-17: no ÷2 | ÷2; pressure, gate E and gain cap per LEVELS.endless)${ln.diedAt >= 0 ? `; squad lost at ${Math.round(ln.diedAt)} m` : ''}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function main() {
  const levels = [];
  if (OPT.level !== null) levels.push(OPT.level);
  else { levels.push(1); for (let L = 2; L <= LEVELS.count; L++) levels.push(L); }

  out(`GATE RUSH level validation — ${OPT.level !== null ? `L${OPT.level}` : `L1 (authored) + L2–L${LEVELS.count} (generated)`}; seeds ${OPT.seed !== null ? `${OPT.seed} + L` : `${LEVELS.seedBase} + L`}`);
  out(`Design line within −15 % of E_boss (L1: cautious line, best '+' lane at 0.3·H; generated: greedy line, face-value lane at 0.75·H); weak = 0.3·H survivability report; full-intake greedy line ≤ 160 % (fresh) / 220 % (rank 3) of E_boss on L2–L30; gate window ${-WORLD.gateArmZ} m`);

  const t0 = Date.now();
  const entries = [];
  for (let i = 0; i < levels.length; i++) {
    try { entries.push(runLevel(levels[i]).entry); } catch (err) { fail(`L${levels[i]}`, `threw: ${err && err.stack ? err.stack : err}`); }
  }
  printSummaryHeader();
  for (let i = 0; i < entries.length; i++) printSummaryRow(entries[i]);
  out('(gates p/s/t = pair/single/triple layouts; red = events with a − or ÷ lane; item = special lanes; grd = guarded events; weak/caut = the survivability line in % of E_boss, L1: Σ EV greedy; no-steer = the squad that never steers — centre lane, full intake, fresh profile — in % of E_boss, warned above GATE_RULES.generation.noSteerMax, round-3 QA LVL-22)');
  // QA LVL-30: openers vary — never the same values on consecutive levels, no opener on more than 30 % of the levels
  const gen = entries.filter((e) => !e.authored);
  const counts = {};
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    counts[e.opener] = (counts[e.opener] || 0) + (e.authored ? 0 : 1);
    if (i > 0 && entries[i - 1].level === e.level - 1 && entries[i - 1].opener === e.opener) fail(`L${e.level}`, `opener ${e.opener} repeats L${e.level - 1}'s`);
  }
  let worstOpener = '', worstN = 0;
  for (const k in counts) if (counts[k] > worstN) { worstN = counts[k]; worstOpener = k; }
  if (gen.length >= 5 && worstN > OPENER_SHARE_MAX * gen.length) fail('openers', `${worstOpener} opens ${worstN} of ${gen.length} generated levels (> ${Math.round(OPENER_SHARE_MAX * 100)} %)`);
  if (gen.length) out(`openers: most common ${worstOpener} on ${worstN} of ${gen.length} generated levels; gate period (median s between gate arrivals) L2–L${LEVELS.count}: ${Math.min(...gen.map((e) => e.gatePeriod)).toFixed(1)}–${Math.max(...gen.map((e) => e.gatePeriod)).toFixed(1)} s`);
  for (let i = 0; i < entries.length; i++) printLevelDetail(entries[i]);

  if (OPT.endless && OPT.level === null) {
    try { printEndless(runEndless()); } catch (err) { fail('endless', `threw: ${err && err.stack ? err.stack : err}`); }
  }

  out('');
  out(`${entries.length} level(s) in ${Date.now() - t0} ms · ${warningCount} warning(s) · ${errorCount} error(s)`);
  if (errorCount > 0) {
    out('ERRORS:');
    for (let i = 0; i < report.errors.length; i++) out(`  ${report.errors[i]}`);
  }
  if (OPT.json) process.stdout.write(JSON.stringify({ ok: errorCount === 0, errorCount, warningCount, ...report }, null, 1) + '\n');
  process.exitCode = errorCount > 0 ? 1 : 0;
}

main();
