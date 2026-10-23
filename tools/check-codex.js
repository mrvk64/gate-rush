#!/usr/bin/env node
// tools/check-codex.js — GATE RUSH FIELD GUIDE / lesson copy checker (round 7, r7 teaching:5; ARCHITECTURE §8.8).
//
// Usage (from the project root, node ≥ 18, zero dependencies):   node tools/check-codex.js [--verbose]
//
// The FIELD GUIDE (data.js CODEX + STRINGS.codex) and the lessons that quote numbers (HINTS, STRINGS.boss.tagline) are
// templated from the tables at module load, so a retune can never leave the copy behind. This checks that the template
// holds:
//   (a) every CODEX id is unique and has STRINGS.codex.entries[id] with a non-empty name and line (and a card line when
//       CODEX.cards lists it); every section has a title;
//   (b) every grantable item (PICKUPS.items), zombie type (ZOMBIES.common.types) and boss archetype (BOSSES.archetypes)
//       has its entry; every unlock level is an integer in 1…LEVELS.count; every legacy hint id exists in HINTS;
//   (c) the copy quotes the CURRENT numbers: each weapon's duration, the chip / booster duration and bonus, the medic's
//       period / share / cap, the hulk's slam radius and phase-3 interval, the Colossus's shield hits and intervals, the
//       brute's swing period, the spitter's spit period, the crawler lunge in HINTS.crawler, the medic hint, the phase
//       hints' intervals and the Juggernaut's damage multiplier;
//       r7 fix round 2: HINTS['boss.stomp'] names the stored-weapon lever only with a weapon stored;
//   (d) no text holds "undefined", "NaN", "[object" or a doubled space.
// Exit code 1 on any error.
import { CODEX, STRINGS, HINTS, PICKUPS, ZOMBIES, BOSSES, WEAPONS, GEAR, TROOPS, LEVELS } from '../js/data.js';

const verbose = process.argv.includes('--verbose');
const errors = [];
const err = (m) => errors.push(m);
const num = (v) => String(Math.round(v * 100) / 100);
const pct = (f) => String(Math.round(f * 100));
const C = STRINGS.codex;
const E = C && C.entries ? C.entries : {};

// (a) ids, entries, cards
const ids = [];
for (const sec of CODEX.sections) {
  if (!C.sections || typeof C.sections[sec.id] !== 'string' || !C.sections[sec.id]) err(`section ${sec.id}: no title in STRINGS.codex.sections`);
  for (const id of sec.ids) {
    if (ids.indexOf(id) !== -1) err(`duplicate CODEX id ${id}`);
    ids.push(id);
    const e = E[id];
    if (!e) { err(`${id}: no STRINGS.codex.entries entry`); continue; }
    if (typeof e.name !== 'string' || !e.name.trim()) err(`${id}: empty name`);
    if (typeof e.line !== 'string' || !e.line.trim()) err(`${id}: empty line`);
    // r7 fix: an entry's fullscreen variants (ui shows them where fullscreen exists), when present, are text too
    for (const k of ['nameFs', 'lineFs']) if (e[k] !== undefined && (typeof e[k] !== 'string' || !e[k].trim())) err(`${id}: empty ${k}`);
  }
}
for (const id of CODEX.cards) {
  if (ids.indexOf(id) === -1) err(`card ${id} is not a CODEX entry`);
  else if (typeof E[id].card !== 'string' || !E[id].card.trim()) err(`card ${id}: no card line`);
}
for (const id of Object.keys(E)) if (ids.indexOf(id) === -1) err(`STRINGS.codex.entries.${id} is in no CODEX section`);

// (b) coverage, unlock levels, legacy hint ids
for (const id of PICKUPS.items) if (ids.indexOf(id) === -1) err(`item ${id} has no CODEX entry`);
for (const t of ZOMBIES.common.types) if (ids.indexOf('zombie.' + t) === -1) err(`zombie ${t} has no CODEX entry`);
for (const a of Object.keys(BOSSES.archetypes)) if (ids.indexOf('boss.' + a) === -1) err(`boss ${a} has no CODEX entry`);
for (const [id, L] of Object.entries(CODEX.unlock)) {
  if (ids.indexOf(id) === -1) err(`unlock: ${id} is not a CODEX entry`);
  if (!(Number.isInteger(L) && L >= 1 && L <= LEVELS.count)) err(`unlock: ${id} level ${L} not in 1…${LEVELS.count}`);
}
for (const [id, list] of Object.entries(CODEX.legacy)) {
  if (ids.indexOf(id) === -1) err(`legacy: ${id} is not a CODEX entry`);
  for (const h of list) if (HINTS[h] === undefined) err(`legacy: ${id} names unknown hint ${h}`);
}

// (c) the numbers quoted are today's
const has = (where, text, want, what) => { if (typeof text !== 'string' || text.indexOf(want) === -1) err(`${where}: does not quote ${what} (${want}) — "${text}"`); };
for (const k of Object.keys(WEAPONS)) has('weapon.' + k, E[WEAPONS[k].id] && E[WEAPONS[k].id].line, String(WEAPONS[k].duration) + ' s', 'its duration');
has('gear.chip', E['gear.chip'].line, String(GEAR.chip.duration) + ' s', 'its duration');
has('gear.chip', E['gear.chip'].line, pct(GEAR.chip.rateBonus) + ' %', 'its bonus');
has('gear.booster', E['gear.booster'].line, String(GEAR.booster.duration) + ' s', 'its duration');
has('gear.booster', E['gear.booster'].line, pct(GEAR.booster.dmgBonus) + ' %', 'its bonus');
has('gear.armor', E['gear.armor'].line, String(GEAR.armor.platesCap), 'its plate cap');
has('troop.medic', E['troop.medic'].line, num(TROOPS.medic.every) + ' s', 'its period');
has('troop.medic', E['troop.medic'].line, pct(TROOPS.medic.pct) + ' %', 'its share');
has('troop.medic', E['troop.medic'].line, '+' + TROOPS.medic.capPerLevel, 'its cap');
has('troop.sniper', E['troop.sniper'].line, num(TROOPS.sniper.every) + ' s', 'its period');
const hulk = BOSSES.archetypes.hulk.phases;
has('boss.hulk', E['boss.hulk'].line, num(hulk[0].radius) + ' m', 'the slam radius');
has('boss.hulk', E['boss.hulk'].line, num(hulk[0].telegraph) + ' s', 'the slam telegraph');
has('boss.hulk', E['boss.hulk'].line, num(hulk[2].interval) + ' s', 'the phase-3 slam interval');
const col = BOSSES.archetypes.colossus;
has('boss.colossus', E['boss.colossus'].line, String(col.shieldHits) + ' hits', 'the shield hits');
has('boss.colossus', E['boss.colossus'].line, num(col.phases[0].interval) + ' s', 'the cycle interval');
has('boss.colossus', E['boss.colossus'].line, num(col.phases[2].interval) + ' s', 'the phase-3 interval');
has('boss.colossusPrime', E['boss.colossusPrime'].line, String(BOSSES.archetypes.colossusPrime.shieldHits), 'the shield hits');
has('boss.valve', E['boss.valve'].line, String(BOSSES.valve.after) + ' s', 'the valve time');
has('zombie.brute', E['zombie.brute'].line, num(ZOMBIES.brute.swing.cooldown) + ' s', 'the swing period');
has('zombie.spitter', E['zombie.spitter'].line, num(ZOMBIES.spitter.spit.every) + ' s', 'the spit period');
has('zombie.crawler', E['zombie.crawler'].line, num(ZOMBIES.crawler.lunge.dist) + ' m', 'the lunge distance');
has('HINTS.crawler', HINTS.crawler, num(ZOMBIES.crawler.lunge.dist), 'the lunge distance');
has("HINTS['troop.medic']", HINTS['troop.medic'], num(TROOPS.medic.every), 'the medic period');
has("HINTS['boss.hulk.3']", HINTS['boss.hulk.3'], num(hulk[2].interval) + ' SECONDS', 'the phase-3 interval');
has("HINTS['boss.colossus.3']", HINTS['boss.colossus.3'], num(col.phases[2].interval) + ' SECONDS', 'the phase-3 interval');
const plates = BOSSES.archetypes.juggernaut.phases[2].onEnter.find((a) => a.platesOff);
if (plates) has("HINTS['boss.juggernaut.3']", HINTS['boss.juggernaut.3'], num(plates.damageMult) + '×', 'the damage multiplier');
for (const a of Object.keys(BOSSES.archetypes)) {
  const t = STRINGS.boss.tagline ? STRINGS.boss.tagline[a] : undefined;
  if (typeof t !== 'string' || !t) err(`STRINGS.boss.tagline.${a}: missing`);
}
if (typeof HINTS.div !== 'function' || HINTS.div(2).indexOf('×1') === -1 || HINTS.div(2).indexOf('×2') !== -1) err('HINTS.div: must end the ladder at ×1 (explain:5)');
// r7 fix round 2: the stomp lesson names the stored-weapon lever only when one is stored (level passes weapons.storedCount)
const stomp = HINTS['boss.stomp'];
if (typeof stomp !== 'function' || /STORED WEAPON/.test(stomp(0)) || !/STORED WEAPON/.test(stomp(1))) err("HINTS['boss.stomp']: a template naming FIRE only with a weapon stored");

// (d) broken templates
const bad = /undefined|NaN|\[object| {2}/;
const scan = (where, t) => { if (typeof t === 'string' && bad.test(t)) err(`${where}: broken text "${t}"`); };
for (const id of ids) { const e = E[id]; if (e) { scan(id + '.name', e.name); scan(id + '.line', e.line); scan(id + '.card', e.card); scan(id + '.nameFs', e.nameFs); scan(id + '.lineFs', e.lineFs); } }
for (const [k, v] of Object.entries(HINTS)) { scan('HINTS.' + k, typeof v === 'function' ? v(2) : v); if (typeof v === 'function') scan('HINTS.' + k + '(0)', v(0)); }
for (const [k, v] of Object.entries(STRINGS.boss.tagline || {})) scan('tagline.' + k, v);

if (verbose) for (const id of ids) console.log(id.padEnd(20), '|', E[id].name, '|', E[id].line, E[id].card ? '| card: ' + E[id].card : '');
console.log(`check-codex: ${ids.length} entries in ${CODEX.sections.length} sections, ${CODEX.cards.length} cards — ${errors.length} error(s)`);
for (const e of errors) console.log('  ERROR ' + e);
process.exit(errors.length > 0 ? 1 : 0);
