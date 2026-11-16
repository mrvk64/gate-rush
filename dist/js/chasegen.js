// js/chasegen.js — the CHASE generator and gap model (PLAN P2; chase-design §3, §4, §7). Pure (util, data): imported by
// levelgen.js and by chase.js, so the engine and the generator share one model.
//
// chaseSpec: the run options (the whole course is a RUN, the boss caps off: C11) and the spec. chaseCheck runs in levelgen's attempt
// loop: SPRINT / PLANK lanes, wrecks, surges by distance, then the idle rule — never-steer / held-left / held-right at the expected
// shop and rank 10, every charge DROPPED and every stored weapon FIRED at once, lose every soldier before idle.before of the course
// (the side repair, then a re-roll; chaseHarden is the last resort). gapStep is the gameplay model: a fixed step, values from the
// script, the logical squad and the shop only (every tier alike; no RNG at runtime: the surges are distances).
import { mulberry32, clamp, round5, shopComp } from './util.js';
import { CHASE_GEN, CHASE, OBSTACLES, LEVEL_TYPES, LEVELS, WORLD, SQUAD, UPGRADES, FIRE, LEAK_MODEL, WEAPONS, eBossOf, expectedRanksOf } from './data.js';

const G = CHASE_GEN;
const SPAWN_DIST = -WORLD.spawnZ;                       // a script event spawns this far ahead of the squad front
const SIM_DT = 1 / 20;                                  // the generator's line sims (the engine steps gapStep at 60 Hz)
const REST_X = { nosteer: 0, fixL: -WORLD.steerRange, fixR: WORLD.steerRange };
const MAX_RANKS = [10, 10, 10, 10, 10];

/** [[L, v], …]: linear between rows, end rows held. */
function lerpRows(t, L) {
  if (L <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (L <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (L - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
  return t[t.length - 1][1];
}
/** [[L, v], …]: the last row at or below L. */
function stepRows(t, L) {
  let v = t[0][1];
  for (let i = 1; i < t.length && t[i][0] <= L; i++) v = t[i][1];
  return v;
}

let HW_AT = null;
/** The logical formation's half width with n soldiers (squad.js's slot table, rebuilt once). */
export function halfWidthOf(n) {
  if (!HW_AT) {
    const sp = SQUAD.slotSpacing, rp = SQUAD.rowPitch, off = SQUAD.rowOffset, hw = SQUAD.halfWidthCap, ez = SQUAD.ellipseZ, CAP = SQUAD.slotCapacity;
    const colsHalf = Math.ceil(hw / sp) + 1, rowsHalf = Math.ceil(CAP / (2 * colsHalf) / 2) + 6, pts = [];
    for (let r = -rowsHalf; r <= rowsHalf; r++) {
      const z = r * rp, odd = (Math.abs(r) % 2) === 1;
      for (let c = -colsHalf; c <= colsHalf; c++) {
        const x = c * sp + (odd ? off : 0);
        if (Math.abs(x) <= hw + 1e-6) pts.push([x, z, Math.round(Math.sqrt(x * x + (z / ez) * (z / ez)) * 1e6) / 1e6]);
      }
    }
    pts.sort((a, b) => (a[2] - b[2]) || (a[1] - b[1]) || (Math.abs(a[0]) - Math.abs(b[0])) || (a[0] - b[0]));
    HW_AT = new Float32Array(CAP + 1);
    for (let k = 1; k <= CAP; k++) HW_AT[k] = Math.max(HW_AT[k - 1], Math.abs(pts[k - 1][0]));
  }
  return HW_AT[n < 0 ? 0 : (n > SQUAD.slotCapacity ? SQUAD.slotCapacity : n | 0)];
}

/** Share (0 … 1) of a formation at x, half width hw, inside a wreck kind's spans: the hit test. */
export function wreckOverlap(kind, x, hw) {
  const k = OBSTACLES.kinds[kind];
  if (!k) return 0;
  const a = x - hw, b = x + hw;
  let o = 0;
  for (let i = 0; i < k.spans.length; i++) {
    const s = k.spans[i], lo = a > s[0] ? a : s[0], hi = b < s[1] ? b : s[1];
    if (hi > lo) o += hi - lo;
  }
  return b - a > 1e-6 ? clamp(o / (b - a), 0, 1) : (o > 0 ? 1 : 0);
}

/** The live shop's push factor (p = fire × damage): a shop above the expected one is compensated (shopComp, D26), and so is the
 *  bigger squad its extra hits bought (× (pExp / p)^countComp). */
export function shopFactor(p, pExp, exp, surplusExp) {
  if (!(p > 0) || !(pExp > 0)) return 1;
  const f = (p / pExp) * shopComp(pExp, pExp, exp, surplusExp) / shopComp(p, pExp, exp, surplusExp);
  return p > pExp ? f * Math.pow(pExp / p, G.countComp) : f;
}

function pOf(rk) { return (UPGRADES.fireRate.effect(rk[1]) / FIRE.rateBase) * UPGRADES.damage.effect(rk[2]); }

/**
 * Campaign level L's chase: { run (generateRunSteps options: gates for lenFrac of the RUN length, the E-trace to eEndK × eRun
 * (round5(runFrac × E_boss)), the fixed lines as a score term), chase (the spec; surges / doors / ref are chaseCheck's), eTarget
 * (round5(eFrac × E_boss), what the stars count against: the run's fit and the stars are set apart) }.
 */
export function chaseSpec(L, seed, opts) {
  const o = opts || {};
  const eTarget = round5(G.eFrac * eBossOf(L)), eRun = round5(G.runFrac * eBossOf(L));
  const lc = LEVELS.curve.len, rp = LEVELS.curve.runPhase;
  const gates = Math.max(4, Math.round((G.lenFrac * Math.min(lc.cap, lc.base + lc.per * (L - 1)) - rp.lenBase) / rp.lenPerGate) + 1);
  const run = { gates, eEnd: round5(G.eEndK * eRun), ref: eRun, fixed: { lim: G.fixed.lim, win: G.fixed.win, shops: ['expected', 'max'], from: 1, repairFrom: 999 } };
  const ln = stepRows(G.lanes, L);
  const chase = {
    L, seed: seed >>> 0, debut: o.debut != null ? !!o.debut : L === LEVEL_TYPES.chase.debut, eTarget, eRun,
    pExp: pOf(expectedRanksOf(L)), profileExp: LEAK_MODEL.profileExpByLevel ? lerpRows(LEAK_MODEL.profileExpByLevel, L) : LEAK_MODEL.profileExp,
    surplusExp: LEAK_MODEL.surplusExp, c0: lerpRows(G.c0, L), amp: lerpRows(G.amp, L), pd: lerpRows(G.pd, L),
    holdM: lerpRows(G.dropM, L), holdS: 0, biteK: Math.min(G.biteCap, 1 + Math.max(0, L - LEVEL_TYPES.chase.debut) / G.biteL),
    sprints: ln[0], planks: ln[1], wrecksPer: stepRows(G.wrecks, L), rubble: L >= G.rubbleFrom,
    sprintBase: L >= G.sprint.lateFrom ? G.sprint.baseLate : G.sprint.base,
    breachM: G.breachM, startM: 0, doorsM: 0, v: 0, surges: [], ref: null, wrecks: 0, design: null, idle: null,
  };
  return { run, chase, eTarget };
}

// ---------------------------------------------------------------------------------------------
// The gap model
// ---------------------------------------------------------------------------------------------

/** A gap state (one per run / line; gapReset re-arms it). */
export function gapState() {
  return { g: 0.5, push: 0.5, si: 0, surgeT: 0.5, surgeAmp: 0.5, sprintLeft: 0.5, sprintRate: 0.5, stumbleT: 0.5, stumbleRate: 0.5, barT: 0.5,
    charges: 0, cool: 0.5, lossAcc: 0.5, caughtS: 0.5, everCaught: false, splintered: false, surged: false };
}

/** Re-arms st for spec sp: gap g0, `charges` DROP charges; surges behind the start never fire. */
export function gapReset(st, sp, charges) {
  st.g = G.g0; st.push = 0; st.si = 0; st.surgeT = 0; st.surgeAmp = 0; st.sprintLeft = 0; st.sprintRate = 0; st.stumbleT = 0; st.stumbleRate = 0;
  st.barT = 0; st.charges = charges > 0 ? Math.min(G.maxCharges, charges | 0) : 0; st.cool = 0; st.lossAcc = 0; st.caughtS = 0;
  st.everCaught = false; st.splintered = false; st.surged = false;
  while (st.si < sp.surges.length && sp.surges[st.si].d < sp.startM) st.si++;
  return st;
}

/** A SPRINT gate passed: m metres over sprint.deliverS. */
export function gapSprint(st, m) {
  st.sprintLeft += m > 0 ? m : 0;
  st.sprintRate = st.sprintLeft / G.sprint.deliverS;
}

/** A wreck hit, overlap share o at road speed v: the stumble (k·v·o for s seconds); returns the soldiers it crushes of C. */
export function gapTrip(st, o, v, C) {
  if (!(o > 0)) return 0;
  st.stumbleT = G.stumble.s; st.stumbleRate = G.stumble.k * v * o;
  return C > 0 ? Math.max(1, Math.round(G.stumble.crush * o * C)) : 0;
}

/** A DROP press: a charge (not while one holds or cools down) holds the horde at the road for holdS (a caught squad is freed). */
export function gapDrop(st, sp) {
  if (st.charges <= 0 || st.cool > 0 || st.barT > 0) return false;
  st.charges--; st.cool = G.dropCooldownS; st.barT = sp.holdS;
  return true;
}

/**
 * One fixed step. inp { C (logical count), ed (the reference count here), sf (shopFactor), w (stored weapon × rear push), v (road
 * speed), d (course distance) }: dg/dt = push − close + sprint − stumble, push = pd·c0·(C / ed)^pushExp·sf·w, close = c0 + surge
 * + kRb·(g − gRest)+ (a DROP: +v instead). Claws under danger, bites at 0; returns the soldiers lost (fractions accumulate).
 */
export function gapStep(st, sp, inp, dt) {
  st.splintered = false; st.surged = false;
  while (st.si < sp.surges.length && inp.d >= sp.surges[st.si].d) { st.surgeT = G.ampS; st.surgeAmp = sp.surges[st.si].amp; st.si++; st.surged = true; }
  const amp = st.surgeT > 0 ? st.surgeAmp : 0;
  if (st.surgeT > 0) st.surgeT -= dt;
  if (st.cool > 0) st.cool -= dt;
  let g = st.g;
  if (st.barT > 0) {
    st.push = 0;
    g += inp.v * dt;
    st.barT -= dt;
    if (st.barT <= 0) { st.barT = 0; st.splintered = true; }
  } else {
    const r = inp.C / (inp.ed > 1 ? inp.ed : 1);
    const push = st.push = sp.pd * sp.c0 * Math.pow(r, r < 1 ? G.pushExp[0] : G.pushExp[1]) * inp.sf * inp.w;
    g += (push - sp.c0 - amp - (g > G.gRest ? G.kRb * (g - G.gRest) : 0)) * dt;
  }
  if (st.sprintLeft > 0) {
    const s = st.sprintRate * dt < st.sprintLeft ? st.sprintRate * dt : st.sprintLeft;
    g += s; st.sprintLeft -= s;
  }
  if (st.stumbleT > 0) { g -= st.stumbleRate * dt; st.stumbleT -= dt; }
  g = g < 0 ? 0 : (g > G.gMax ? G.gMax : g);
  st.g = g;
  let rate = 0;
  if (g <= 0) { rate = (G.bite[0] + G.bite[1] * inp.C) * sp.biteK; st.caughtS += dt; st.everCaught = true; }
  else if (g < G.danger) rate = G.claw[0] + G.claw[1] * inp.C;
  if (rate <= 0 || inp.C <= 0) return 0;
  st.lossAcc += rate * dt;
  const n = Math.floor(st.lossAcc);
  st.lossAcc -= n;
  return n;
}

/** A count trace's value at course distance d ({ at, e } samples, linear between them, as level.expectedSquad). */
export function designAt(samples, d) {
  if (!samples || samples.length === 0) return 1;
  if (d <= samples[0].at) return samples[0].e;
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i];
    if (d <= b.at) { const a = samples[i - 1]; return b.at > a.at ? a.e + (b.e - a.e) * (d - a.at) / (b.at - a.at) : b.e; }
  }
  return samples[samples.length - 1].e;
}

// ---------------------------------------------------------------------------------------------
// The generator: conversions, wrecks, surges, the idle rule
// ---------------------------------------------------------------------------------------------

/** A lane → a SPRINT (»m) or PLANK lane in place, keeping the original's shooting effort to its payoff (and the original). */
function convertLane(lanes, i, kind, sp) {
  const l = lanes[i];
  const ref = Math.max(4, l.op === '+' ? (l.cap | 0) - (l.value | 0) : (l.op === '-' ? (l.value | 0) + (l.flipCap | 0) : l.step | 0));
  if (kind === 'sprint') { const b = sp.sprintBase; lanes[i] = { op: 'sprint', value: b, cap: b * G.sprint.maxMult, step: Math.max(2, Math.round(ref / (b * (G.sprint.maxMult - 1)))), was: l }; }
  else lanes[i] = { op: 'wall', value: G.wall.value, cap: G.wall.max, step: Math.max(4, Math.round(ref)), was: l };   // was: the run's own lane (validation)
}

/** Surges by distance: the first surgeFirstS after the gap starts, then gap ± jitter s, doubles, the LAST SURGE at doors − lastSurgeM. */
function scheduleSurges(sp, R) {
  const v = sp.v, start = sp.startM, lastD = sp.doorsM - G.lastSurgeM, out = [];
  const gap = stepRows(G.surgeGap, sp.L), jit = stepRows(G.surgeJitter, sp.L), dbl = G.double;
  const dc = sp.L >= dbl.lateFrom ? dbl.lateChance : dbl.chance;
  for (let t = G.surgeFirstS, i = 0; start + v * (t + gap * 0.5) < lastD; t += gap + (R() * 2 - 1) * jit, i++) {
    out.push({ d: start + v * t, amp: sp.amp });
    if (!sp.debut && i >= 1 && sp.L >= dbl.from && R() < dc) out.push({ d: start + v * (t + dbl.lagS), amp: sp.amp * dbl.amp });
  }
  out.push({ d: lastD, amp: sp.amp });
  out.sort((a, b) => a.d - b.d);
  return out;
}

/** Lanes neither the design line (rows) nor the full-intake line (rows2) takes → sprint / plank lanes, spread over the chase up
 *  to the last surge; the first one is a sprint. */
function convertLanes(sp, rows, rows2, R) {
  const good = [], red = [], pick2 = new Map();
  for (const row of rows2) if (row.kind === 'gate') pick2.set(row.ev, row.lane);
  for (const row of rows) {
    if (row.kind !== 'gate') continue;
    const ev = row.ev, arr = ev.at + SPAWN_DIST;
    if (arr < sp.breachM + 25 || arr > sp.doorsM - G.lastSurgeM + 30 || ev.lanes.length < 2) continue;
    const opts = [];
    for (let l = 0; l < ev.lanes.length; l++) { const op = ev.lanes[l].op; if (l !== row.lane && l !== pick2.get(ev) && op !== 'item' && op !== 'sprint' && op !== 'wall') opts.push(l); }
    // beside a red pick a neutral lane reads better at spawn (a player takes it): those only when the others run short
    const pk = ev.lanes[row.lane].op;
    if (opts.length) (pk === '-' || pk === '/' ? red : good).push({ ev, opts });
  }
  const total = sp.sprints + sp.planks, cand = good.slice();
  for (let k = 0, need = Math.min(red.length, total - good.length); k < need; k++) cand.push(red[Math.floor((k + 0.5) * red.length / need)]);
  cand.sort((x, y) => x.ev.at - y.ev.at);
  const want = Math.min(cand.length, total);
  if (want <= 0) return;
  const kinds = [];
  for (let k = 0; k < total; k++) kinds.push(k < sp.sprints ? 'sprint' : 'wall');
  for (let k = kinds.length - 1; k > 1; k--) { const j = 1 + Math.floor(R() * k); const t = kinds[k]; kinds[k] = kinds[j]; kinds[j] = t; }
  const step = cand.length / want, off = R() * step;
  for (let k = 0; k < want; k++) {
    const c = cand[Math.min(cand.length - 1, Math.floor(off + k * step))];
    convertLane(c.ev.lanes, c.ev.lanes.length === 3 && c.opts.indexOf(1) >= 0 ? 1 : c.opts[Math.floor(R() * c.opts.length)], kinds[k], sp);
  }
}

/** The stretches wrecks may use (arrival m): ≥ 30 m from every gate, after the breach's quiet stretch, clear of the doors. */
function wreckWindows(script, sp) {
  const arr = [];
  for (const ev of script.events) if (ev.type === 'gates') arr.push(ev.at + SPAWN_DIST);
  arr.sort((a, b) => a - b);
  const lo = sp.breachM + G.quietM, hi = sp.doorsM - G.doorsClearM, wins = [];
  for (let i = 0; i < arr.length; i++) {
    const a = Math.max(arr[i] + 30, lo), b = Math.min(i + 1 < arr.length ? arr[i + 1] - 30 : hi, hi);
    if (b - a >= 4) wins.push([a, b]);
  }
  return wins;
}

/** wrecksPer × windows wrecks (pairs in some windows: a weave), kinds from a bag (cars and narrows; + rubble from narrowsFrom)
 *  that puts the centre line into most and each held line into about half of them; kept off the crates. */
function placeWrecks(script, sp, R) {
  const crates = [];
  for (const ev of script.events) if (ev.type === 'crate') crates.push(ev.at + SPAWN_DIST);
  const wins = wreckWindows(script, sp), n = Math.round(sp.wrecksPer * wins.length);
  const bag = sp.rubble ? ['carL', 'carR', 'narrows', 'carL', 'carR', 'rubble'] : ['carL', 'carR', 'narrows'];
  for (let k = bag.length - 1; k > 0; k--) { const j = Math.floor(R() * (k + 1)); const t = bag[k]; bag[k] = bag[j]; bag[j] = t; }
  const per = new Int32Array(wins.length), base = Math.min(n, wins.length), off = Math.floor(R() * wins.length);
  for (let k = 0; k < base; k++) per[Math.floor(off + k * wins.length / Math.max(1, base)) % wins.length]++;
  for (let k = base; k < n; k++) per[(off + 2 * k) % wins.length]++;
  const out = [];
  for (let w = 0, bi = 0; w < wins.length; w++) {
    const [a, b] = wins[w], m = Math.min(per[w], 2);
    for (let j = 0; j < m; j++) {
      let d = m === 1 ? a + (b - a) * (0.3 + 0.4 * R()) : (j === 0 ? a + 2 : b - 2);
      for (let c = 0; c < crates.length; c++) if (Math.abs(crates[c] - d) < 8) d = crates[c] + (d < crates[c] ? -8 : 8);
      let kind = bag[bi++ % bag.length];
      const prev = j === 1 ? out[out.length - 1].kind : '';
      if (prev === 'carL' || prev === 'carR') kind = prev === 'carL' ? 'carR' : 'carL';
      out.push({ type: 'wreck', at: Math.round(clamp(d, a, b) - SPAWN_DIST), kind });
    }
  }
  return out;
}

/**
 * One line through the chase (SIM_DT steps from the gap's start to the doors). line { mode ('nosteer' | 'fixL' | 'fixR' |
 * 'design'), samples (its count trace), rows (its gate rows), charges (DROP charges at the start), dropAt (drops below this gap;
 * 0 never), fire (stored weapons fired at once), shopP }. Its count = trace − losses (an upper bound: a later × gate never
 * multiplies a loss); taken sprint / plank lanes pay their maximum; a fixed line sits at its rest x between gates (wrecks are
 * ≥ 30 m from any gate), the design line dodges. Returns { dead, deadD, caughtD, final, minG, caughtS, hits, amb (the share
 * of its steps at 3-8 m) }.
 */
export function simulateLine(sp, script, line) {
  const st = gapReset(gapState(), sp, line.charges), evs = [];   // [d, kind (0 sprint, 1 plank, 2 wreck, 3 weapon), value]
  const wpn = (id) => (id && id.indexOf('weapon.') === 0 && WEAPONS[id.slice(7)] ? CHASE.rear[id] || 1 : 0);
  if (line.rows) {
    for (const row of line.rows) {
      if (row.kind !== 'gate') continue;
      const lane = row.ev.lanes[row.lane], d = row.ev.at + SPAWN_DIST;
      if (lane.op === 'sprint' || lane.op === 'wall') evs.push([d, lane.op === 'sprint' ? 0 : 1, lane.cap]);
      else if (line.fire && lane.op === 'item' && wpn(lane.item)) evs.push([d, 3, wpn(lane.item)]);
    }
  }
  for (const ev of script.events) {
    if (ev.type === 'wreck' && line.mode !== 'design') evs.push([ev.at + SPAWN_DIST, 2, ev.kind]);
    else if (line.fire && ev.type === 'crate' && wpn(ev.item)) evs.push([ev.at + SPAWN_DIST, 3, wpn(ev.item)]);
  }
  evs.sort((a, b) => a[0] - b[0]);
  const v = sp.v, x = REST_X[line.mode] || 0, samples = line.samples;
  const inp = { C: 0, ed: 1, sf: shopFactor(line.shopP, sp.pExp, sp.profileExp, sp.surplusExp), w: 1, v, d: 0 };
  let lost = 0, ei = 0, wT = 0, wMul = 1, minG = st.g, caughtD = -1, hits = 0, n = 0, amb = 0;
  for (let d = sp.startM; d < sp.doorsM; d += v * SIM_DT) {
    while (ei < evs.length && evs[ei][0] <= d) {
      const e = evs[ei++];
      if (e[1] === 0) gapSprint(st, e[2]);
      else if (e[1] === 1) st.charges = Math.min(G.maxCharges, st.charges + e[2]);
      else if (e[1] === 3) { wMul = e[2]; wT = G.idle.weaponS; }
      else {
        const C = Math.max(0, Math.round(designAt(samples, d)) - lost), o = wreckOverlap(e[2], x, halfWidthOf(C));
        if (o > 0) { lost += gapTrip(st, o, v, C); hits++; }
      }
    }
    const C = Math.max(0, Math.round(designAt(samples, d)) - lost);
    if (C <= 0) return { dead: true, deadD: d, caughtD, final: 0, minG, caughtS: st.caughtS, hits, amb: amb / (n || 1) };
    if (line.dropAt > 0 && st.g < line.dropAt) gapDrop(st, sp);
    inp.C = C; inp.ed = designAt(sp.ref, d); inp.w = wT > 0 ? wMul : 1; inp.d = d;
    if (wT > 0) wT -= SIM_DT;
    lost += gapStep(st, sp, inp, SIM_DT);
    if (st.g < minG) minG = st.g;
    n++; if (st.g >= 3 && st.g <= 8) amb++;
    if (st.g <= 0 && caughtD < 0) caughtD = d;
  }
  const fin = Math.max(0, Math.round(designAt(samples, sp.doorsM)) - lost);
  return { dead: fin <= 0, deadD: fin <= 0 ? sp.doorsM : -1, caughtD, final: fin, minG, caughtS: st.caughtS, hits, amb: amb / (n || 1) };
}

/** The cheapest side repair: a wreck that misses every surviving line (done: their modes) turns onto them (narrows for both held
 *  lines, a car for one side / the centre), else (or with addOnly) one more in the emptiest window (at most cap a window). */
function wreckStep(script, sp, wr, done, pass, cap, addOnly) {
  const sL = done.has('fixL'), sR = done.has('fixR'), alt = pass & 1 ? 'carL' : 'carR';
  const kind = sL && sR ? (done.has('nosteer') ? alt : 'narrows') : (sL ? 'carL' : (sR ? 'carR' : alt));
  if (!addOnly) {
    for (const w of wr) {
      let hit = false;
      for (const m of done) if (wreckOverlap(w.kind, REST_X[m], 1.2) >= 0.5) hit = true;
      if (!hit) { w.kind = kind; return true; }
    }
  }
  let best = null, bn = cap + 1;
  for (const win of wreckWindows(script, sp)) {
    let n = 0;
    for (const w of wr) { const d = w.at + SPAWN_DIST; if (d >= win[0] - 1 && d <= win[1] + 1) n++; }
    if (n < bn) { bn = n; best = win; }
  }
  if (!best || bn >= cap) return false;
  const w = { type: 'wreck', at: Math.round(best[0] + (best[1] - best[0]) * [0.5, 1, 0][bn % 3] - SPAWN_DIST), kind };
  wr.push(w); script.events.push(w); script.events.sort((a, b) => a.at - b.at); sp.wrecks = wr.length;
  return true;
}

/** The idle rule at shop rk into out: each fixed line, with every hands-off help, must lose before idle.before of the course. */
function* idleLines(script, sp, lines, rk, out) {
  const set = lines(script, rk), p = pOf(rk);
  for (const mode of ['nosteer', 'fixL', 'fixR']) {
    yield;
    const r = simulateLine(sp, script, { mode, samples: set[mode].samples, rows: set[mode].rows, charges: 3 * G.assistCharges, dropAt: G.idle.dropAt, fire: true, shopP: p });
    r.mode = mode; r.ok = r.dead && r.deadD < G.idle.before * sp.doorsM; r.rank = rk === MAX_RANKS ? 10 : 0;
    out.push(r);
  }
}
const idleRows = (res) => res.map((r) => ({ mode: r.mode, rank: r.rank, ok: r.ok, deadAt: r.deadD > 0 ? Math.round(r.deadD) : -1, caughtAt: Math.round(r.caughtD), hits: r.hits }));
const shopsOf = (exp) => (exp[0] + exp[1] + exp[2] + exp[4] < 40 ? [exp, MAX_RANKS] : [exp]);

/**
 * The chase's attempt check (C11; a generator for levelgen's loop; it changes the script in place): conversions, the push reference,
 * wrecks, the idle rule with up to idle.repairs side repairs (a wreck turned onto a surviving line, or added; no lane
 * moves). lines = levelgen.modeLines. True when every idle line loses in time (the run's own rules were validated before it).
 */
export function* chaseCheck(script, sp, lines) {
  const R = mulberry32((sp.seed * 2654435761 + sp.L * 97 + script.events.length) >>> 0);
  script.events = script.events.filter((e) => e.type !== 'runup');   // no run-up in a chase (the declared line must not count it)
  sp.doorsM = script.length; sp.v = script.roadSpeed; sp.holdS = sp.holdM / Math.max(1, sp.v); sp.startM = sp.breachM + sp.v * 1.2;   // when the rig arrives
  sp.surges = scheduleSurges(sp, mulberry32((sp.seed * 7919 + sp.L) >>> 0));
  const exp = expectedRanksOf(sp.L), shops = shopsOf(exp);
  // script.expected: the run's design line as generated (without the run-up), what the validator re-simulates on the run's own lanes;
  // sp.ref, the push reference: the design line on the converted lanes (beside a red pick it takes the sprint, as a player would)
  const g0 = lines(script, exp);
  script.expected = g0.greedy.samples;
  convertLanes(sp, g0.greedy.rows, g0.max.rows, R);
  yield;
  sp.ref = lines(script, exp).greedy.samples.map((s) => ({ at: s.at, e: Math.max(1, Math.round(s.e)) }));
  yield;
  const wr = placeWrecks(script, sp, R);
  for (const w of wr) script.events.push(w);
  script.events.sort((a, b) => a.at - b.at);
  sp.wrecks = wr.length;
  let res = [];
  for (let pass = 0; ; pass++) {
    res = [];
    for (const rk of shops) { yield; yield* idleLines(script, sp, lines, rk, res); }
    const done = new Set();
    for (const r of res) if (!r.ok) done.add(r.mode);
    if (!done.size || pass >= G.idle.repairs) break;
    if (!wreckStep(script, sp, wr, done, pass, 2)) break;
  }
  sp.idle = idleRows(res);
  yield;
  const d = simulateLine(sp, script, { mode: 'design', samples: sp.ref, rows: null, charges: 0, dropAt: 0, fire: false, shopP: sp.pExp });
  sp.design = { final: d.final, ratio: Math.round(d.final / sp.eRun * 100) / 100, minG: Math.round(d.minG * 10) / 10, caughtS: Math.round(d.caughtS * 10) / 10 };
  script.chase = Object.assign({}, sp);                  // this attempt's spec (the loop keeps the best attempt's script)
  return res.every((r) => r.ok);
}

/** The last resort when no attempt passed (levelgen, after the loop): wrecks aimed at the surviving lines are added (up to three a
 *  window; none turned, so no other line gains) until every idle line loses in time. The design line never moves here. */
export function* chaseHarden(script, sp, lines) {
  const shops = shopsOf(expectedRanksOf(sp.L)), wr = script.events.filter((e) => e.type === 'wreck');
  for (let pass = 0; pass < 24; pass++) {
    const res = [];
    for (const rk of shops) { yield; yield* idleLines(script, sp, lines, rk, res); }
    sp.idle = idleRows(res);
    const done = new Set();
    for (const r of res) if (!r.ok) done.add(r.mode);
    if (!done.size || !wreckStep(script, sp, wr, done, pass, 3, true)) break;
  }
  script.chase = Object.assign({}, sp);
}

/** The chase script from a checked run: the boss out, the 'chase' event (the breach: the finale) and 'safezone' (the doors) in. */
export function generateChaseScript(runScript, spec) {
  const sp = Object.assign({}, runScript.chase || spec.chase), events = runScript.events.filter((ev) => ev.type !== 'boss');
  events.push({ type: 'chase', at: sp.breachM, spec: sp }, { type: 'safezone', at: runScript.length });
  events.sort((a, b) => a.at - b.at);
  return Object.assign({}, runScript, { events, chase: sp });
}
