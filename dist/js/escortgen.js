// js/escortgen.js — the ESCORT generator (PLAN-1.5.0 P3; escort-design §10-11). Pure (util, data), imported only by levelgen.js.
// escortBuild(run, L, seed, aux) turns a generated run (boss caps off: PLAN C11) into an escort script: the truck's route (ALIGNED /
// SPLIT per gate event), a climber wave per wave (extra walkers at the truck's half; the run's waves and gate maths unchanged), the
// checkpoint, the gauntlet (the run-up rewritten + its climbers) and the safe zone, in one { type: 'escort', at: 1, spec } event
// (keepsRun, C1); then the idle rule (E1 / E4) with its repair. aux (levelgen's line model): picks = the design line's lane per gate,
// lines = the fixed lines' squad samples at the expected shop and rank 10. Deterministic in (run, L, seed): check and build agree.
import { mulberry32 } from './util.js';
import { ESCORT, ESCORT_GEN, WORLD, ZOMBIES, LEAK_MODEL, LEVEL_TYPES } from './data.js';

const ET = ESCORT.truck, EG = ESCORT_GEN, EC = EG.check;
const S = -WORLD.spawnZ;                               // m from the horizon to the squad's front row
const ZF = ET.rearZ - ET.length;                       // the truck's nose (z); a gate passes its rear at at + S + rearZ
const CONTACT_M = S + ZF;                              // m a zombie walks (squad frame) from the horizon to the truck's nose
const TYPES = ZOMBIES.common.types;
const CV = LEAK_MODEL.coverage;
const LINE_HALF = 1.5;                                 // zombies.js GUARD_LINE_HALF: a 'line' wave with x spreads ±this (WAVE_PATTERNS.line.guardHalfWidth)

/** [[L, v], …] lerp table, the end rows held flat. */
function lerpTable(t, L) {
  if (L <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (L <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (L - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
  return t[t.length - 1][1];
}
/** [[L, …], …] step table: the last row at or below L (the first row below the table). */
function stepRow(t, L) { let r = t[0]; for (let i = 1; i < t.length && t[i][0] <= L; i++) r = t[i]; return r; }

/** The level's escort numbers (the runtime reads the same tables through the spec). */
export function escortParams(L) {
  const sv = stepRow(ESCORT.survivors, L), g = stepRow(EG.gauntlet, L);
  const debut = L === LEVEL_TYPES.escort.debut;
  return {
    grab: lerpTable(ESCORT.grab, L), share: lerpTable(EG.climberShare, L), split: lerpTable(EG.splitShare, L),
    changes: Math.round(lerpTable(EG.laneChanges, L)), plateHp: stepRow(ESCORT.plates.hp, L)[1],
    start: sv[1], board: sv[2], T: sv[1] + sv[2], plates: debut ? ESCORT.plates.debutStart : ESCORT.plates.start,
    gLen: g[1], gBursts: g[2], brutes: L >= ESCORT.brute.from, zig: L >= EG.zigFrom, debut,
  };
}

/** The squad's logical half-width at count n (levelgen's formation model, LEAK_MODEL.coverage). */
function halfWidth(n) { return Math.min(CV.halfWidthCap, Math.sqrt(Math.max(1, n) * CV.slotArea / (Math.PI * CV.aspect))); }

/** E of a sample list [{ at, e }] at distance d (linear, held at both ends). */
function eAt(samples, d) {
  const n = samples.length;
  if (d <= samples[0].at) return samples[0].e;
  for (let i = 1; i < n; i++) {
    const b = samples[i];
    if (d <= b.at) { const a = samples[i - 1], span = b.at - a.at; return span > 0 ? a.e + (b.e - a.e) * (d - a.at) / span : b.e; }
  }
  return samples[n - 1].e;
}

/** The per-type HP of a climber group reaching the truck where the design count is E: a walker climberHpE · E, the others by baseHp. */
function climberHp(E, units) {
  const w = EG.climberHpE * Math.max(1, E) / ZOMBIES.walker.baseHp;
  const out = {};
  for (const t in units) out[t] = Math.max(1, Math.round(w * ZOMBIES[t].baseHp));
  return out;
}

/** The generated run an escort script was built on (tools: validate-levels checks it as a run, then rebuilds the escort from it). */
export function escortRunPart(script) {
  const ev = script.events.find((e) => e.type === 'escort');
  const r = ev.spec.run;
  const events = script.events.filter((e) => e !== ev && e.truck !== true && e.type !== 'runup');
  if (r.runup) events.push(r.runup);
  if (r.boss) events.push(r.boss);
  events.sort((a, b) => a.at - b.at);
  const out = Object.assign({}, script, { length: r.length, events, expected: script.expected.filter((p) => p.at <= r.length) });
  for (const k of ['base', 'eTarget', 'finale', 'starMetric']) delete out[k];
  return out;
}

/**
 * The escort script on a generated run (the run is not modified). Returns { script, ok, stats }: ok = the idle rule holds (E1 for
 * every fixed line at both shops with every plate used perfectly, E4 for both sides) after the repair passes.
 */
export function escortBuild(run, L, seed, aux) {
  const P = escortParams(L);
  const v = run.roadSpeed;
  const R = mulberry32(((seed >>> 0) * 2654435761 + L * 40503 + 0xE5C0) >>> 0);
  const vw = v + ZOMBIES.walker.speed;
  const contactOf = (at) => at + CONTACT_M * v / vw;     // where (road distance) a walker spawned at `at` reaches the truck's nose
  const gates = [], waves = [], keep = [];
  let runup = null, bossAt = run.length, boss = null;
  for (const ev of run.events) {
    if (ev.type === 'boss') { bossAt = ev.at; boss = ev; continue; }
    if (ev.type === 'runup') { runup = ev; continue; }
    if (ev.type === 'gates') gates.push(ev);
    else if (ev.type === 'wave') waves.push(ev);
    keep.push(ev);
  }
  const picks = aux && aux.picks ? aux.picks : [];
  const pickSide = gates.map((g) => {
    const p = picks.find((q) => q.at === g.at);
    if (!p || g.layout === 'single') return 0;
    const cx = WORLD.laneCenters[g.layout] || WORLD.laneCenters.pair;
    const x = cx[Math.max(0, Math.min(cx.length - 1, p.lane))];
    return x < -0.5 ? -1 : (x > 0.5 ? 1 : 0);
  });
  const passD = gates.map((g) => g.at + S + ET.rearZ);  // the truck's tailgate passes the gate
  const armedD = gates.map((g) => g.at + S - 36);       // the gate reaches the armed line (z −36, the glyphs readable)

  // ---- the gauntlet and the safe zone: the run-up's horde (bigger, HP solved at run time) and its climbers spawn over
  // [gs, gs + span]; the truck reaches the safe zone tailS after the last of them reaches it
  const lastWaveAt = waves.length ? waves[waves.length - 1].at : 0;
  const lastGateAt = gates.length ? gates[gates.length - 1].at : 0;
  const gs = Math.max(lastWaveAt + 20, lastGateAt + 30, runup ? Math.min(runup.at, bossAt - 60) : bossAt - 60);
  const span = Math.max(20, P.gLen - EG.tailS * v);
  const sz = Math.round(contactOf(gs + span) + EG.tailS * v);
  const K = Math.max(1, P.gBursts);
  const gTotal = Math.min(EG.gauntletCap, Math.round((15 + L) * EG.gauntletMult));
  const ruUnits = runup && runup.units ? runup.units : { walker: 1, runner: 1 };
  let ruSum = 0;
  for (const t in ruUnits) ruSum += ruUnits[t] | 0;
  const gUnits = {};
  let gLeft = gTotal;
  const ruKeys = Object.keys(ruUnits).filter((t) => (ruUnits[t] | 0) > 0);
  for (let i = 0; i < ruKeys.length; i++) {
    const t = ruKeys[i];
    const n = i === ruKeys.length - 1 ? gLeft : Math.round(gTotal * (ruUnits[t] | 0) / Math.max(1, ruSum));
    gUnits[t] = Math.max(0, n); gLeft -= gUnits[t];
  }
  const gauntletRunup = { at: gs, type: 'runup', units: gUnits, bursts: K, burstGap: +(span / Math.max(1, K - 1) / v).toFixed(2), pattern: 'horde' };

  // ---- climber groups: one per wave (its share of the wave's population), K in the gauntlet
  const groups = [];
  let bruteN = 0;
  for (const w of waves) {
    let pop = 0;
    for (const t in w.units) pop += w.units[t] | 0;
    const brute = P.brutes && (w.units.brute | 0) > 0 && bruteN++ % EG.bruteEvery === EG.bruteEvery - 1;   // every bruteEvery-th wave with brutes
    groups.push({ at: w.at, pop, share: P.share, gauntlet: false, brute });
  }
  for (let k = 0; k < K; k++) groups.push({ at: Math.round(gs + span * (K > 1 ? k / (K - 1) : 0)), pop: gTotal / K, share: EG.gauntletShare, gauntlet: true, brute: false });
  for (const gr of groups) gr.contact = contactOf(gr.at);
  const countOf = (gr) => Math.max(EG.climberMin, Math.round(gr.pop * gr.share));

  // ---- the route: lane-change gaps between gate k and k + 1 (and after the last gate), each starting gapM after the tailgate
  // passed gate k and waveM after the climbers of a wave in the gap reached the truck, ending armedM before gate k + 1 is armed
  const RT = EG.route;
  const changeM = ET.changeS * v;
  const gaps = [];
  for (let k = 0; k < gates.length; k++) {
    const nextArmed = k + 1 < gates.length ? armedD[k + 1] : groups.length ? contactOf(gs) - 4 : sz - 60;
    let st = passD[k] + RT.gapM;
    for (const gr of groups) if (gr.contact > passD[k] - 4 && gr.contact < nextArmed) st = Math.max(st, gr.contact + RT.waveM);
    if (k + 1 >= gates.length) st = Math.max(st, contactOf(lastWaveAt) + RT.waveM);
    const end = st + changeM;
    let clear = end <= nextArmed - RT.armedM;
    for (const gr of groups) if (gr.contact > st - 3 && gr.contact < end + 3) clear = false;
    if (clear) gaps.push({ k, at: Math.round(st), end, room: nextArmed - RT.armedM - end });
  }
  const nFlip = Math.min(P.changes, gaps.length);
  const firstPick = pickSide.findIndex((p) => p !== 0);
  const side0 = firstPick >= 0 ? pickSide[firstPick] : (R() < 0.5 ? -1 : 1);
  const sidesOf = (flips) => {                           // the truck's side as it passes each gate, and at a distance
    const at = (d) => { let s = side0; for (const f of flips) if (gaps[f].at < d) s = -s; return s; };
    return at;
  };
  const evalRoute = (flips) => {
    const at = sidesOf(flips);
    let mL = 0, mR = 0, splits = 0, nonNeutral = 0, opener = 0, seen = 0;
    for (let k = 0; k < gates.length; k++) {
      const p = pickSide[k];
      if (p === 0) continue;
      const s = at(passD[k] - 1);                        // the side as it passes the gate (no change between armed and passed)
      if (seen < RT.aligned) { if (s !== p) opener++; seen++; continue; }
      nonNeutral++;
      if (s !== p) splits++;
    }
    for (const gr of groups) { if (at(gr.contact) < 0) mL += countOf(gr); else mR += countOf(gr); }
    const M = mL + mR;
    const minSide = M > 0 ? Math.min(mL, mR) / M : 0;
    const split = nonNeutral > 0 ? splits / nonNeutral : 0;
    return { cost: (opener > 0 ? 10 : 0) + 2 * Math.abs(mL - mR) / Math.max(1, M) + Math.abs(split - P.split) + (minSide < EC.uncoveredMin ? 5 : 0), minSide, split, splits };
  };
  let best = null;
  for (let c = 0; c < RT.candidates; c++) {
    const pool = gaps.map((_, i) => i);
    const flips = [];
    for (let i = 0; i < nFlip; i++) flips.push(pool.splice(Math.floor(R() * pool.length), 1)[0]);
    flips.sort((a, b) => a - b);
    const e = evalRoute(flips);
    if (best === null || e.cost < best.e.cost) best = { flips, e };
  }
  const flips = best ? best.flips : [];
  const sideAt = sidesOf(flips);
  const changes = [];
  let s = side0;
  for (const f of flips) { s = -s; changes.push({ at: gaps[f].at, to: s, s: ET.changeS }); }
  // a feint (from zigFrom): out and back in one unused gap with room for two quick changes
  if (P.zig) {
    const zigM = ET.zigS * v, pause = 0.4 * v;
    const free = gaps.filter((g, i) => flips.indexOf(i) < 0 && g.room + changeM >= 2 * zigM + pause);
    if (free.length) {
      const g = free[Math.floor(R() * free.length)];
      const sd = sideAt(g.at + 1);
      changes.push({ at: g.at, to: -sd, s: ET.zigS }, { at: Math.round(g.at + zigM + pause), to: sd, s: ET.zigS });
      changes.sort((a, b) => a.at - b.at);
    }
  }

  // ---- the checkpoint: the gate-free stretch nearest half the road (between the tailgate passing gate k and gate k + 1 armed)
  let cp = null;
  for (let k = 0; k + 1 < gates.length; k++) {
    const mid = (passD[k] + armedD[k + 1]) / 2;
    if (mid < EG.checkpoint.lo * sz || mid > EG.checkpoint.hi * sz) continue;
    if (cp === null || Math.abs(mid - sz / 2) < Math.abs(cp - sz / 2)) cp = mid;
  }
  if (cp === null) cp = sz / 2;
  cp = Math.round(cp);

  // ---- the idle rule (E1 / E4) with its repair
  const lines = aux && aux.lines ? aux.lines : [];
  const lineX = (mode) => (mode === 'fixL' ? EC.lines[1] : (mode === 'fixR' ? EC.lines[2] : EC.lines[0]));
  const plateSave = (P.plates + ESCORT.plates.checkpoint + 3 * ESCORT.plates.perStep) * (P.plateHp + 1);
  const grabM = (P.grab + ESCORT.slideS) * v;           // m of road one grab takes on a slot
  const lossOf = (ln) => {
    // the climbers this line leaves uncovered queue on their rail (3 slots a side); each grab takes grabM of road; the safe zone
    // clears what has not grabbed by then
    const xl = lineX(ln.mode);
    const free = [[0, 0, 0], [0, 0, 0]];
    let lost = 0;
    for (const gr of groups) {
      const n = countOf(gr);
      const tx = sideAt(gr.contact) * ET.x;
      const W = halfWidth(eAt(ln.samples, gr.contact)) + EC.slack;
      for (let i = 0; i < n; i++) {
        const x = tx - LINE_HALF + 2 * LINE_HALF * (i + 0.5) / n;
        const out = (x - tx) * tx > 0;                   // the rail away from the road centre
        const rail = tx + (out ? 1 : -1) * Math.sign(tx) * 1.25;
        if (Math.abs(x - xl) <= W || Math.abs(rail - xl) <= W) continue;
        const q = free[out ? 1 : 0];
        let j = 0;
        for (let m = 1; m < 3; m++) if (q[m] < q[j]) j = m;
        const done = Math.max(q[j], gr.contact) + grabM;
        if (done > sz) continue;
        q[j] = done;
        lost++;
      }
    }
    return lost - plateSave;
  };
  const sides = () => {
    let mL = 0, mR = 0;
    for (const gr of groups) { if (sideAt(gr.contact) < 0) mL += countOf(gr); else mR += countOf(gr); }
    return { mL, mR, min: Math.min(mL, mR) / Math.max(1, mL + mR) };
  };
  let losses = lines.map(lossOf);
  let worst = losses.length ? Math.min(...losses) : Infinity;
  const need = EC.margin * P.T;
  for (let pass = 0; pass < EC.passes && worst < need; pass++) {
    const i = losses.indexOf(worst), ln = lines[i], xl = lineX(ln.mode);
    let raised = false;
    for (const gr of groups) {
      const tx = sideAt(gr.contact) * ET.x;
      const outerRail = tx + Math.sign(tx) * 1.25;
      const W = halfWidth(eAt(ln.samples, gr.contact)) + EC.slack;
      if (Math.abs(outerRail - xl) <= W || gr.share >= EG.check.shareMax) continue;   // this line covers the group's outer rail
      gr.share = Math.min(EG.check.shareMax, gr.share + EC.shareStep);
      raised = true;
    }
    if (!raised) break;
    losses = lines.map(lossOf);
    worst = Math.min(...losses);
  }
  const sd = sides();
  const ok = worst >= need && sd.min >= EC.uncoveredMin;

  // ---- the script
  const expected0 = run.expected && run.expected.length ? run.expected : [{ at: 0, e: run.eBoss || 1 }];
  const events = keep.slice();
  for (const gr of groups) {
    const n = countOf(gr);
    const units = { walker: n };
    if (gr.brute) units.brute = 1;
    const ev = { at: gr.at, type: 'wave', pattern: 'line', x: sideAt(gr.contact) * ET.x, spread: 4, units, hp: climberHp(eAt(expected0, gr.contact), units), truck: true };
    events.push(ev);
  }
  events.push(gauntletRunup);
  const spec = {
    L, T: P.T, start: P.start, board: P.board, plates: P.plates, plateHp: P.plateHp, grab: +P.grab.toFixed(3),
    side0, changes, checkpoint: cp, gauntlet: Math.round(contactOf(gs)), safeZone: sz, brutes: P.brutes, debut: P.debut,
    run: { length: run.length, runup, boss },            // what the escort replaced (escortRunPart rebuilds the run from it; tools)
  };
  events.push({ at: 1, type: 'escort', spec });
  events.sort((a, b) => a.at - b.at);
  const expected = (run.expected || []).filter((p) => p.at <= sz);
  if (expected.length) expected.push({ at: sz, e: expected[expected.length - 1].e });
  const script = Object.assign({}, run, { length: sz, events, expected, eTarget: P.T });
  return {
    script, ok,
    stats: { losses, need: +need.toFixed(1), minSide: +sd.min.toFixed(3), mL: sd.mL, mR: sd.mR, split: +best.e.split.toFixed(2), splits: best.e.splits,
      changes: changes.length, gaps: gaps.length, cp: +(cp / sz).toFixed(2), plateSave, sz },
  };
}
