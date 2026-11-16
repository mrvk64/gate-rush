#!/usr/bin/env node
// tools/chasesim.js — the CHASE section's checks and its fit table (r9 P2). Node only, never shipped. It re-runs js/chasegen.js's
// model on finished scripts, independently of the generator's own verdict:
//   chasePartOf(script)            the run part of a chase script for levelgen.validateLevel (the breach / doors / wreck events
//                                  out, sprint / plank lanes back to the run's own lanes (lane.was), the run's boss back at the course end)
//   validateChaseSection(script, o) the idle rule (never-steer / held-left / held-right at the expected shop and rank 10, each with
//                                  every charge it collects plus the 3 assist charges dropped below idle.dropAt and its stored
//                                  weapons fired at once: count 0 before 0.9 of the course) as ERRORS; the wreck spacing
//                                  (≥ 25 m from every gate arrival, none in the doors' clear stretch), the lane conversions (a
//                                  sprint first), the surge table; the design line's escape (≥ 0.9 eRun, min gap ≥ 2 m) as a
//                                  WARNING; with o.slices the longest generator slice (levelSteps, ms) against SLICE_MS.
// CLI (the fit table): node tools/chasesim.js --levels 12,22,27,33,37,44,49,57 --seeds 0,100,200 [--slices]
import { generateLevel, levelSteps, modeLines, runCurve } from '../js/levelgen.js';
import { simulateLine, wreckOverlap } from '../js/chasegen.js';
import { CHASE_GEN, WORLD, expectedRanksOf, UPGRADES, FIRE } from '../js/data.js';

const SPAWN_DIST = -WORLD.spawnZ;
const SLICE_MS = 8;                                     // level.js START_SLICE_MS / PREFETCH_SLICE_MS
const MAX = [10, 10, 10, 10, 10];
const IDLE_BEFORE = 0.9;                               // the PLAN's idle rule (the generator aims at CHASE_GEN.idle.before, with margin)

/** The run part of a chase script (see the header). */
export function chasePartOf(script) {
  const c = runCurve(script.id, script.run);
  const events = [];
  for (const e of script.events) {
    if (e.type === 'chase' || e.type === 'safezone' || e.type === 'wreck') continue;
    events.push(e.type === 'gates' && e.lanes.some((l) => l.was) ? Object.assign({}, e, { lanes: e.lanes.map((l) => l.was || l) }) : e);
  }
  events.push({ at: script.length, type: 'boss', id: 'boss.' + c.bossId, archetype: c.bossId, hp: c.bossHp });
  return Object.assign({}, script, { events });
}

const pOf = (rk) => (UPGRADES.fireRate.effect(rk[1]) / FIRE.rateBase) * UPGRADES.damage.effect(rk[2]);

/** The chase section's rules on a finished chase script (see the header). Returns { errors, warnings, idle, design, wrecks, sprints, planks, sliceMs }. */
export function validateChaseSection(script, o = {}) {
  const errors = [], warnings = [];
  const sp = script.chase || (script.events.find((e) => e.type === 'chase') || {}).spec;
  if (!sp) return { errors: ['no chase spec'], warnings, idle: [], design: null };
  if (script.finale !== 'chase' || script.base !== 'chase') errors.push(`finale / base ${script.finale} / ${script.base}, not chase`);
  const L = sp.L, exp = expectedRanksOf(L), shops = exp[0] + exp[1] + exp[2] + exp[4] < 40 ? [exp, MAX] : [exp];
  // the idle rule, re-simulated
  const idle = [];
  for (const rk of shops) {
    const set = modeLines(script, rk);
    for (const mode of ['nosteer', 'fixL', 'fixR']) {
      const r = simulateLine(sp, script, { mode, samples: set[mode].samples, rows: set[mode].rows, charges: 3 * CHASE_GEN.assistCharges, dropAt: CHASE_GEN.idle.dropAt, fire: true, shopP: pOf(rk) });
      const ok = r.dead && r.deadD < IDLE_BEFORE * sp.doorsM;
      idle.push({ mode, rank: rk === MAX ? 10 : 0, ok, deadAt: r.dead ? Math.round(r.deadD) : -1, caughtAt: Math.round(r.caughtD), hits: r.hits });
      if (!ok) errors.push(`idle rule: ${mode} at ${rk === MAX ? 'rank 10' : 'the expected shop'} ${r.dead ? `dies at ${Math.round(r.deadD)} m` : `escapes with ${r.final}`} (≥ ${Math.round(IDLE_BEFORE * sp.doorsM)} m)`);
    }
  }
  // the design line's escape (dodging, no DROP, no sprint)
  const d = simulateLine(sp, script, { mode: 'design', samples: sp.ref, rows: null, charges: 0, dropAt: 0, fire: false, shopP: sp.pExp });
  const design = { final: d.final, ratio: Math.round(d.final / sp.eRun * 100) / 100, minG: Math.round(d.minG * 10) / 10, caughtS: Math.round(d.caughtS * 10) / 10, amb: Math.round(d.amb * 100) / 100 };
  if (d.final < 0.9 * sp.eRun || d.minG < 2) warnings.push(`design line: ${d.final} at the doors (${design.ratio} × eRun), min gap ${design.minG} m`);
  // wrecks, conversions, surges
  const arr = script.events.filter((e) => e.type === 'gates').map((e) => e.at + SPAWN_DIST);
  const wrecks = script.events.filter((e) => e.type === 'wreck');
  for (const w of wrecks) {
    const a = w.at + SPAWN_DIST, near = arr.reduce((m, g) => Math.min(m, Math.abs(g - a)), 1e9);
    if (near < 25) errors.push(`wreck ${w.kind} @${a} is ${Math.round(near)} m from a gate (< 25)`);
    if (a > sp.doorsM - CHASE_GEN.doorsClearM + 1) errors.push(`wreck ${w.kind} @${a} inside the doors' clear stretch`);
    if (wreckOverlap(w.kind, 0, 0.5) === 0 && wreckOverlap(w.kind, -2.1, 0.5) === 0) errors.push(`wreck kind ${w.kind} blocks nothing`);
  }
  let sprints = 0, planks = 0, first = '';
  for (const e of script.events) {
    if (e.type !== 'gates') continue;
    for (const l of e.lanes) {
      if (l.op !== 'sprint' && l.op !== 'wall') continue;
      if (!first) first = l.op;
      if (l.op === 'sprint') { sprints++; if (!(l.cap >= l.value && l.step > 0)) errors.push(`sprint lane @${e.at}: cap ${l.cap} / step ${l.step}`); }
      else { planks++; if (!(l.cap > l.value && l.step > 0)) errors.push(`plank lane @${e.at}: cap ${l.cap} / step ${l.step}`); }
    }
  }
  if (sprints === 0) errors.push('no sprint lane');
  if (first === 'wall') errors.push('a plank lane before the first sprint lane');
  for (let i = 1; i < sp.surges.length; i++) if (sp.surges[i].d < sp.surges[i - 1].d) errors.push('surges out of order');
  if (!sp.surges.length || Math.abs(sp.surges[sp.surges.length - 1].d - (sp.doorsM - CHASE_GEN.lastSurgeM)) > 1) errors.push('the LAST SURGE is not at doors − lastSurgeM');
  let sliceMs = 0;
  if (o.slices) {
    // the longest step of the sliced generator, the better of two passes (a collector pause is not the generator's slice)
    sliceMs = Infinity;
    for (let pass = 0; pass < 2; pass++) {
      let worst = 0;
      const it = levelSteps(L, sp.seed, 'chase');
      for (;;) { const t0 = performance.now(); const r = it.next(); worst = Math.max(worst, performance.now() - t0); if (r.done) break; }
      sliceMs = Math.min(sliceMs, worst);
    }
    if (sliceMs > SLICE_MS) warnings.push(`a generator slice took ${sliceMs.toFixed(1)} ms (> ${SLICE_MS})`);
  }
  return { errors, warnings, idle, design, wrecks: wrecks.length, sprints, planks, sliceMs };
}

// ---- CLI
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('chasesim.js')) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
  const levels = String(arg('levels', '12,22,27,33,37,44,49,57')).split(',').map(Number);
  const seeds = String(arg('seeds', '0,100,200')).split(',').map(Number);
  const slices = process.argv.includes('--slices');
  let bad = 0, n = 0;
  console.log('L     seed  len   v     eT   surges wrecks » plank  design (×eRun / min gap / caught s / 3-8 m)  idle deaths (m: nosteer fixL fixR | rank 10)  gen ms  slice');
  for (const L of levels) for (const so of seeds) {
    const seed = 1000 + L + so, t0 = performance.now();
    const s = generateLevel(L, seed, 'chase'), ms = performance.now() - t0;
    const v = validateChaseSection(s, { slices }), sp = s.chase;
    n++; if (v.errors.length) bad++;
    const dd = v.idle.map((r) => (r.ok ? r.deadAt : 'X' + (r.deadAt > 0 ? r.deadAt : '')));
    console.log(`${String(L).padEnd(6)}${String(seed).padEnd(6)}${String(s.length).padEnd(6)}${String(s.roadSpeed).padEnd(6)}${String(sp.eTarget).padEnd(5)}${String(sp.surges.length).padEnd(7)}${String(v.wrecks).padEnd(7)}${String(v.sprints).padEnd(2)}${String(v.planks).padEnd(7)}${`${v.design.ratio} / ${v.design.minG} / ${v.design.caughtS} / ${v.design.amb}`.padEnd(42)}${`${dd.slice(0, 3).join(' ')} | ${dd.slice(3).join(' ')}`.padEnd(47)}${String(Math.round(ms)).padEnd(8)}${slices ? v.sliceMs.toFixed(1) : '-'}${v.errors.length ? '  ERR ' + v.errors.join('; ') : ''}${v.warnings.length ? '  WARN ' + v.warnings.join('; ') : ''}`);
  }
  console.log(`chasesim: ${n} scripts, ${bad} with errors`);
  process.exit(bad ? 1 : 0);
}
