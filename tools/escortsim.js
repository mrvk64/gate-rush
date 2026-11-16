#!/usr/bin/env node
// tools/escortsim.js — the ESCORT generator's model in node (PLAN-1.5.0 P3; not shipped). For every escort level and seed it builds
// the script as the game does (levelgen.generateLevel(L, seed, 'escort')) and prints the idle rule (escort-design §10, E1 / E4): the
// survivors each fixed line (never steers, held left, held right; expected shop and rank 10) loses with every plate used perfectly,
// against margin × T, the truck mass on its least-covered side, the SPLIT share, lane changes, checkpoint and generation time.
//   node tools/escortsim.js                      # the escort levels of L1–120 (the 1.5.0 map), seeds 0, 100, 200
//   node tools/escortsim.js --levels 18,28 --seeds 0,100 --json
// Exit 1 when a script fails the rule (validate-levels --type escort reports the same as errors).
import { generateLevel, runCurve, curve, escortAux } from '../js/levelgen.js';
import { escortBuild, escortRunPart } from '../js/escortgen.js';
import { LEVELS, ESCORT_GEN, levelTypeOf } from '../js/data.js';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const ON = { horde: true, night: true, chase: true, escort: true };
const levels = val('levels', null) ? val('levels').split(',').map(Number)
  : Array.from({ length: 120 }, (_, i) => i + 1).filter((L) => levelTypeOf(L, null, ON).base === 'escort');
const seeds = val('seeds', '0,100,200').split(',').map(Number);
const rows = [];
let bad = 0;
for (const L of levels) {
  for (const k of seeds) {
    const seed = LEVELS.seedBase + L + k;
    const t0 = Date.now();
    const full = generateLevel(L, seed, 'escort');
    const ms = Date.now() - t0;
    const run = escortRunPart(full);
    const b = escortBuild(run, L, seed, escortAux(run, L, runCurve(L, { gates: curve(L).gates, fixed: ESCORT_GEN.run.fixed })));
    const s = b.stats;
    if (!b.ok) bad++;
    rows.push({ L, seed, ok: b.ok, T: full.eTarget, losses: s.losses, need: s.need, minSide: s.minSide, split: s.split, changes: s.changes, cp: s.cp, len: s.sz, ms });
  }
}
if (argv.includes('--json')) process.stdout.write(JSON.stringify(rows, null, 1) + '\n');
else {
  console.log('ESCORT idle rule (E1: every fixed line loses >= margin x T with every plate used perfectly; E4: each side >= ' + ESCORT_GEN.check.uncoveredMin + ' of the truck mass)');
  console.log('  L  seed   ok    T  need  losses nosteer/fixL/fixR (expected shop | rank 10)   side  split  chg   cp   len   ms');
  for (const r of rows) {
    const l = r.losses.map((x) => String(Math.round(x)).padStart(3));
    console.log(`${String(r.L).padStart(3)} ${String(r.seed).padStart(5)} ${r.ok ? ' ok ' : 'FAIL'} ${String(r.T).padStart(4)} ${String(r.need).padStart(5)}  ${l.slice(0, 3).join(' ')} | ${l.slice(3).join(' ')}                       ${r.minSide.toFixed(2)}  ${r.split.toFixed(2)}  ${String(r.changes).padStart(3)}  ${r.cp.toFixed(2)}  ${r.len}  ${String(r.ms).padStart(3)}`);
  }
  console.log(`${rows.length - bad}/${rows.length} scripts pass; worst margin ${Math.min(...rows.map((r) => Math.min(...r.losses) / r.need)).toFixed(2)} x need; max generation ${Math.max(...rows.map((r) => r.ms))} ms`);
}
process.exit(bad > 0 ? 1 : 0);
