#!/usr/bin/env node
// tools/check-save.js — GATE RUSH save schema v2 checker (r8, P1T; the port of the plan's savemig prototype,
// gate-rush-evidence/r8/integration/savemig.mjs).
//
// Usage (from the project root, node ≥ 18, git in PATH):   node tools/check-save.js [--verbose]
//
// On an owner-like 1.3.0 save (L1–42 cleared, every shop rank 10, 18,450 coins, highestUnlocked 43; built with the 1.3.0
// defaultSave) it checks that:
//   (a) migrating to v2 (migrate() and SaveStore.load()) changes no star, best, clear, coin, rank or highestUnlocked, stamps every
//       record t 'standard' with metric = bestSurvivors, and adds the 8 modes keys (standard met at L1 with the clears) and the
//       two settings;
//   (b) a first L4 Horde clear is not a replay (pays full) and a second one is (×ECONOMY.replayPayout);
//   (c) with LEVEL_TYPES.retypeRewardSkip [] every re-typed cleared level's first clear in its 1.4.0 type pays full (the plan's
//       12: 4H 7N 9H 13H 14N 17N 19H 23H 29H 32H 38N 39H), and with a test list [7] L7 pays ×replayPayout;
//   (d) the first night run sets modes.night.metAtFrontier to 43, and later runs keep it;
//   (e) rec.prev keeps the old type's bests, bestScore included, and a second new-type clear leaves it alone;
//   (f) the 1.3.0 migrate() (git show 441104b) keeps every v2 field: the v2 blob comes back deep-equal; the v2 migrate is
//       idempotent on it;
//   (g) sanitation: a junk record type, prev, metric (a negative one → 0), modes counter and setting are repaired, and the
//       fields of a newer build (an unknown type string, a modes key, a record field) kept.
//   (h) 1.5.0: a 1.4.0 owner save at L45 — the chase / escort levels behind it wear the ring, pay full once and keep their stars;
//       every other level of L1–60 keeps its 1.4.0 type.
//   1.6.0 (P3) HARD, on a 1.5.0-style owner save (L1–44 cleared, frontier L45, every rank 10):
//   (H-a) it loads with no h; HARD opens on every cleared level L10–44 and on L45 (the frontier), not on L9 or L46, and not before
//         L30 is cleared; a HARD clear of L45 writes h; (H-b) a 1.6 save round-trips h and settings.hardMods; (H-c) a corrupted h
//         (s 7, m 'x', b -5) sanitises to s 3, m 0, b 0, a non-object h is dropped; (H-d) m 0xFF keeps its bits and marks 4;
//         (H-e) 59a8352's (1.5.0) migrate and SaveStore load / record / save keep h and hardMods; (H-f) a re-type moves h into
//         rec.prev; (H-g) a HARD clear of the frontier writes the normal record (stars, the next level unlocked) and h, and only a
//         strictly higher mark is a NEW MARK.
// Exit code 1 on any failure.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SaveStore, migrate, defaultSave } from '../js/save.js';
import { storage } from '../js/util.js';
import { LEVEL_TYPES, ECONOMY, levelTypeOf } from '../js/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_130 = '441104b';                        // Gate Rush 1.3.0 (the build an owner's phone may still run beside 1.4.0)
const BASE_150 = '59a8352';                        // Gate Rush 1.5.0 (1.6.0's HARD record must survive it)
const SAVE_KEY = 'gaterush.v1';
const STAGE_140 = { horde: true, night: true, chase: false, escort: false };   // the 1.4.0 map (1.5.0's build turns chase / escort on)
const verbose = process.argv.includes('--verbose');
const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && (verbose || !ok) ? ' — ' + detail : ''}`);
};
const now = 1761600000000;
const clone = (o) => JSON.parse(JSON.stringify(o));

/** The 1.3.0 save.js (with its data.js and util.js) from git, in a scratch folder under os.tmpdir(); util's 'three' points at node_modules. */
async function load130(at = BASE_130) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-save' + at + '-'));
  const three = import.meta.resolve('three');
  for (const f of ['save.js', 'data.js', 'util.js']) {
    let src = execFileSync('git', ['-C', ROOT, 'show', `${at}:js/${f}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (f === 'util.js') src = src.split("from 'three'").join(`from '${three}'`);
    fs.writeFileSync(path.join(dir, f), src);
  }
  const mod = await import(pathToFileURL(path.join(dir, 'save.js')).href);
  return { mod, dir };
}

const old = await load130();
try {
  // ---- the owner-like 1.3.0 save
  const v1 = old.mod.defaultSave(now);
  v1.coins = 18450;
  for (const k in v1.upgrades) v1.upgrades[k] = 10;
  v1.highestUnlocked = 43;
  for (let L = 1; L <= 42; L++) v1.levels[L] = { stars: L % 7 === 0 ? 2 : 3, bestSurvivors: 300 + L, bestScore: 9000 + 100 * L, bestCoins: 500 + 10 * L, clears: 1 + (L % 3) };
  v1.hints = { steer: true, 'codex:v1': true, 'seen:boss.hulk': true };
  v1.settings.music = 80;
  const v1json = JSON.stringify(v1);
  check('the fixture is a 1.3.0 save', v1.v === 1 && !v1.modes && Object.keys(v1.levels).length === 42);

  // (a) migration
  const same = (a, b) => {
    const bad = [];
    for (let L = 1; L <= 42; L++) {
      const o = a.levels[L], n = b.levels[L];
      for (const k of ['stars', 'bestSurvivors', 'bestScore', 'bestCoins', 'clears']) if (!n || n[k] !== o[k]) bad.push(`L${L}.${k}`);
    }
    if (b.coins !== a.coins) bad.push('coins');
    if (b.highestUnlocked !== a.highestUnlocked) bad.push('highestUnlocked');
    for (const k in a.upgrades) if (b.upgrades[k] !== a.upgrades[k]) bad.push('rank ' + k);
    if (JSON.stringify(b.hints) !== JSON.stringify(a.hints) || b.settings.music !== a.settings.music) bad.push('hints / settings');
    return bad;
  };
  const m = migrate(JSON.parse(v1json), now);
  const lost = same(v1, m);
  check('(a) v1 → v2 changes 0 stars, bests, clears, coins, ranks or highestUnlocked', lost.length === 0, lost.join(', '));
  const keys = Object.keys(LEVEL_TYPES).filter((k) => LEVEL_TYPES[k] && typeof LEVEL_TYPES[k].base === 'string');
  let stamp = 0;
  for (let L = 1; L <= 42; L++) if (m.levels[L].t === 'standard' && m.levels[L].metric === m.levels[L].bestSurvivors) stamp++;
  check('(a) every record t "standard", metric = bestSurvivors', stamp === 42, `${stamp}/42`);
  const clears = Object.values(v1.levels).reduce((a, r) => a + r.clears, 0);
  check('(a) modes: the 8 type keys; standard met at L1 with every clear; the others unmet', m.v === 2 && keys.length === 8 && keys.every((k) => m.modes[k] && m.modes[k].metAtFrontier === (k === 'standard' ? 1 : 0))
    && m.modes.standard.clears === clears && m.modes.horde.clears === 0, JSON.stringify(m.modes));
  check('(a) settings nightBright / leftHanded false', m.settings.nightBright === false && m.settings.leftHanded === false);
  storage.set(SAVE_KEY, v1json);
  const store = new SaveStore({ events: null });
  store.load();
  check('(a) SaveStore.load() migrates the stored 1.3.0 blob the same way', same(v1, store.data).length === 0 && store.data.v === 2 && store.data.levels[4].t === 'standard');

  // (b) + (e) the first L4 Horde clear
  check('(b) L4 played as horde before its first horde clear: not a replay (pays full)', store.isReplay(4, 'horde') === false);
  check('(b) L4 played as standard (cleared in 1.3.0): a replay', store.isReplay(4, 'standard') === true);
  const before4 = clone(store.data.levels[4]);
  store.recordLevel(4, { stars: 2, survivors: 120, score: 5000, coins: 300, typeKey: 'horde', metric: 120 });
  const r4 = store.data.levels[4];
  check('(e) the first horde clear moves the standard bests (score included) to rec.prev', r4.prev && r4.prev.t === 'standard' && r4.prev.bestScore === before4.bestScore
    && r4.prev.bestSurvivors === before4.bestSurvivors && r4.prev.bestCoins === before4.bestCoins && r4.prev.metric === before4.metric, JSON.stringify(r4.prev));
  check('(e) …keeps the stars (max), starts the horde bests, counts the clear', r4.t === 'horde' && r4.stars === before4.stars && r4.bestScore === 5000 && r4.metric === 120
    && r4.clears === before4.clears + 1 && store.data.modes.horde.clears === 1, JSON.stringify(r4));
  check(`(b) a second L4 horde run is a replay (×${ECONOMY.replayPayout})`, store.isReplay(4, 'horde') === true);
  store.recordLevel(4, { stars: 3, survivors: 140, score: 4000, coins: 280, typeKey: 'horde', metric: 140 });
  check('(e) a second horde clear leaves rec.prev alone and keeps the best score', JSON.stringify(store.data.levels[4].prev) === JSON.stringify(r4.prev) && store.data.levels[4].bestScore === 5000 && store.data.levels[4].stars === 3);

  // (c) every re-typed level of L1–42 on the 1.4.0 map
  const retyped = [];
  for (let L = 1; L <= 42; L++) { const t = levelTypeOf(L, null, STAGE_140); if (t.key !== 'standard') retyped.push(L + (t.key === 'horde' ? 'H' : 'N')); }
  check('(c) the 1.4.0 map re-types the plan\'s 12 owner levels', retyped.join(' ') === '4H 7N 9H 13H 14N 17N 19H 23H 29H 32H 38N 39H', retyped.join(' '));
  const fresh = new SaveStore({ events: null });
  storage.set(SAVE_KEY, v1json);
  fresh.load();
  const full = retyped.filter((c) => fresh.isReplay(parseInt(c, 10), levelTypeOf(parseInt(c, 10), null, STAGE_140).key) === false);
  check(`(c) retypeRewardSkip ${JSON.stringify(LEVEL_TYPES.retypeRewardSkip)}: every re-typed level's first new-type clear pays full`, LEVEL_TYPES.retypeRewardSkip.length === 0 && full.length === retyped.length, `${full.length}/${retyped.length}`);
  const skip7 = retyped.filter((c) => fresh.isReplay(parseInt(c, 10), levelTypeOf(parseInt(c, 10), null, STAGE_140).key, [7])).map((c) => parseInt(c, 10));
  check(`(c) with a test list [7]: only L7 pays ×${ECONOMY.replayPayout}`, skip7.join(',') === '7', skip7.join(','));
  check('(c) an unchanged standard level stays a replay', fresh.isReplay(5, 'standard') === true && fresh.isReplay(43, 'horde') === false);

  // (d) the first night run's frontier
  const met = store.meetType('night');
  store.recordLevel(43, { stars: 3, survivors: 500, score: 20000, coins: 1100, typeKey: 'horde', metric: 500 });
  const met2 = store.meetType('night');
  check('(d) the first night run sets modes.night.metAtFrontier to 43; later runs keep it', met && met.metAtFrontier === 43 && met2.metAtFrontier === 43 && store.data.highestUnlocked === 44, `met ${met && met.metAtFrontier}, highestUnlocked ${store.data.highestUnlocked}`);
  store.recordModeRun('night', 37);
  check('(d) recordModeRun counts runs, kills, bestKills', store.data.modes.night.runs === 1 && store.data.modes.night.kills === 37 && store.data.modes.night.bestKills === 37);

  // (f) a 1.3.0 build reading the v2 blob
  const v2json = JSON.stringify(store.data);
  const back = old.mod.migrate(JSON.parse(v2json), now);
  check('(f) the 1.3.0 migrate keeps every v2 field (the blob comes back deep-equal)', JSON.stringify(back) === v2json, diffKeys(JSON.parse(v2json), back).slice(0, 8).join(', '));
  check('(f) the v2 migrate is idempotent on its own blob', JSON.stringify(migrate(JSON.parse(v2json), now)) === v2json);
  check('(f) a fresh v2 profile survives the 1.3.0 migrate too', JSON.stringify(old.mod.migrate(clone(defaultSave(now)), now)) === JSON.stringify(defaultSave(now)));

  // (g) sanitation
  const junk = JSON.parse(v2json);
  junk.levels[4].t = 5; junk.levels[5].prev = 'x'; junk.levels[6].metric = -4; junk.modes.horde.runs = -3; junk.settings.leftHanded = 'yes';
  junk.levels[7].t = 'later'; junk.modes.futureKey = { runs: 2 }; junk.levels[8].extra = 1;
  const fixed = migrate(junk, now);
  check('(g) junk repaired (t, prev, metric, counter, setting); a newer build\'s fields kept', fixed.levels[4].t === 'standard' && fixed.levels[5].prev === undefined && fixed.levels[6].metric === 0
    && fixed.modes.horde.runs === 0 && fixed.settings.leftHanded === true && fixed.levels[7].t === 'later' && fixed.modes.futureKey.runs === 2 && fixed.levels[8].extra === 1);
  // (h) 1.5.0 (P4): the owner path. A 1.4.0 save at L45 (L1–44 cleared, rec.t the 1.4.0 map's key): the build's map re-types
  // exactly the chase / escort levels behind him, each wears the ring (ui _setTile: cleared, rec.t ≠ the key, not skipped) and
  // its first new-type clear pays full and keeps the stars; every other level L1–60 plays its 1.4.0 type (L47 horde, L53 / L58 night)
  const v140 = clone(defaultSave(now));
  v140.highestUnlocked = 45;
  for (let L = 1; L <= 44; L++) v140.levels[L] = { stars: L % 7 === 0 ? 2 : 3, bestSurvivors: 300 + L, bestScore: 9000 + 100 * L, bestCoins: 500 + 10 * L, clears: 1 + (L % 3), t: levelTypeOf(L, null, STAGE_140).key, metric: 300 + L };
  storage.set(SAVE_KEY, JSON.stringify(v140));
  const own = new SaveStore({ events: null });
  own.load();
  const ringed = [], kept = [];
  for (let L = 1; L <= 60; L++) {
    const k = levelTypeOf(L).key, rec = own.data.levels[L];
    if (k !== levelTypeOf(L, null, STAGE_140).key) { if (L <= 44) ringed.push(L + (k === 'chase' ? 'C' : k === 'escort' ? 'E' : '?')); } else kept.push(L);
    const ring = !!rec && rec.clears > 0 && rec.t !== k && LEVEL_TYPES.retypeRewardSkip.indexOf(L) === -1;
    if (ring !== (L <= 44 && k !== levelTypeOf(L, null, STAGE_140).key)) failures.push('(h) ring L' + L);
  }
  check('(h) the 1.5.0 map re-types the 11 chase / escort levels behind an owner at L45, each with the ring', ringed.join(' ') === '12C 18E 22C 24E 27C 28E 33C 34E 37C 42E 44C' && failures.indexOf('(h) ring') === -1, ringed.join(' '));
  check('(h) the other 45 of L1–60 keep their 1.4.0 type (L47 horde, L53 / L58 night)', kept.length === 45 && levelTypeOf(47).key === 'horde' && levelTypeOf(53).key === 'night' && levelTypeOf(58).key === 'night', kept.length + '');
  const payFull = ringed.filter((c) => own.isReplay(parseInt(c, 10), levelTypeOf(parseInt(c, 10)).key) === false).length;
  own.recordLevel(12, { stars: 1, survivors: 200, score: 3000, coins: 900, typeKey: 'chase', metric: 200 });
  own.recordLevel(18, { stars: 2, survivors: 9, score: 2000, coins: 800, typeKey: 'escort', metric: 9 });
  const r12 = own.data.levels[12], r18 = own.data.levels[18];
  check('(h) the first chase / escort clear pays full, keeps the 3 stars and moves the old bests to rec.prev; the next run is a replay', payFull === ringed.length
    && r12.t === 'chase' && r12.stars === 3 && r12.prev.t === 'standard' && r18.t === 'escort' && r18.stars === 3 && r18.prev.t === 'standard'
    && own.isReplay(12, 'chase') === true && own.isReplay(18, 'escort') === true, `${payFull}/${ringed.length} ${JSON.stringify(r12)}`);
  // ---- 1.6.0 (P3) HARD
  const v150 = clone(defaultSave(now));
  delete v150.settings.hardMods;                   // a 1.5.0 save has no hardMods
  v150.highestUnlocked = 45;
  for (const k in v150.upgrades) v150.upgrades[k] = 10;
  for (let L = 1; L <= 44; L++) v150.levels[L] = { stars: L % 7 === 0 ? 2 : 3, bestSurvivors: 300 + L, bestScore: 9000 + 100 * L, bestCoins: 500 + 10 * L, clears: 1, t: levelTypeOf(L).key, metric: 300 + L };
  storage.set(SAVE_KEY, JSON.stringify(v150));
  const hs = new SaveStore({ events: null });
  hs.load();
  const openL = []; for (let L = 1; L <= 60; L++) if (hs.hardOpen(L)) openL.push(L);
  check('(H-a) the 1.5.0 owner save loads with no h and hardMods 15; HARD opens on L10–44 and the frontier L45 only',
    Object.values(hs.data.levels).every((r) => r.h === undefined) && hs.data.settings.hardMods === 15 && openL.join(',') === Array.from({ length: 36 }, (_, i) => i + 10).join(','), openL.join(','));
  const pre30 = clone(v150); pre30.highestUnlocked = 30; for (let L = 30; L <= 44; L++) delete pre30.levels[L];
  storage.set(SAVE_KEY, JSON.stringify(pre30));
  const p30 = new SaveStore({ events: null }); p30.load();
  check('(H-a) before L30 is cleared no level opens HARD', [10, 20, 29, 30].every((L) => !p30.hardOpen(L)));
  hs.recordLevel(45, { stars: 2, survivors: 520, score: 30000, coins: 2400, typeKey: levelTypeOf(45).key, metric: 520 });
  const nm1 = hs.recordHard(45, 2, 0b1011, 520);
  check('(H-g) a HARD clear of the frontier L45 writes the normal record (2 stars, L46 unlocked) and h, a NEW MARK', hs.data.levels[45].stars === 2 && hs.data.levels[45].clears === 1
    && hs.data.highestUnlocked === 46 && nm1 === true && JSON.stringify(hs.data.levels[45].h) === '{"s":2,"m":11,"b":520}' && hs.hardOpen(46), JSON.stringify(hs.data.levels[45]));
  const nm2 = hs.recordHard(45, 3, 0b0111, 600), nm3 = hs.recordHard(45, 1, 0b1111, 100);
  check('(H-g) the same mark with more stars replaces h but is no NEW MARK; a strictly higher mark is', nm2 === false && nm3 === true && hs.data.levels[45].h.m === 15 && hs.data.levels[45].h.s === 1,
    JSON.stringify(hs.data.levels[45].h));
  hs.setSetting('hardMods', 5);
  const j16 = JSON.stringify(hs.data), b16 = migrate(JSON.parse(j16), now);
  check('(H-b) a 1.6 save round-trips h and hardMods', JSON.stringify(b16) === j16 && b16.levels[45].h.m === 15 && b16.settings.hardMods === 5);
  const bad = JSON.parse(j16); bad.levels[44].h = { s: 7, m: 'x', b: -5 }; bad.levels[43].h = 'junk'; bad.levels[42].h = { s: 3, m: 0xFF, b: 9 }; bad.settings.hardMods = 'x';
  const fb = migrate(bad, now);
  check('(H-c) a corrupted h sanitises to s 3, m 0, b 0; a non-object h is dropped; a junk hardMods falls back to 15', JSON.stringify(fb.levels[44].h) === '{"s":3,"m":0,"b":0}' && fb.levels[43].h === undefined
    && fb.settings.hardMods === 15, JSON.stringify(fb.levels[44].h));
  check('(H-d) m 0xFF keeps its bits and marks popcount(m & 15) = 4', fb.levels[42].h.m === 255 && hs.markOf(fb.levels[42].h.m) === 4);
  const o150 = await load130(BASE_150);
  try {
    const ob = o150.mod.migrate(JSON.parse(j16), now);
    check('(H-e) the 1.5.0 migrate keeps every 1.6 field (h, hardMods): the blob comes back deep-equal', JSON.stringify(ob) === j16, diffKeys(JSON.parse(j16), ob).slice(0, 8).join(', '));
    const ost = (await import(pathToFileURL(path.join(o150.dir, 'util.js')).href)).storage;   // 1.5.0's own storage
    ost.set(SAVE_KEY, j16);
    const os150 = new o150.mod.SaveStore({ events: null });
    os150.load();
    os150.recordLevel(46, { stars: 3, survivors: 700, score: 40000, coins: 2600, typeKey: levelTypeOf(46).key, metric: 700 });
    os150.recordLevel(45, { stars: 3, survivors: 700, score: 40000, coins: 2600, typeKey: levelTypeOf(45).key, metric: 700 });
    os150.flushNow();
    const back150 = JSON.parse(ost.get(SAVE_KEY));
    check('(H-e) a 1.6 save loaded, played and re-saved by the 1.5.0 SaveStore keeps h and hardMods', JSON.stringify(back150.levels[45].h) === JSON.stringify(hs.data.levels[45].h)
      && back150.settings.hardMods === 5 && back150.levels[46].stars === 3, JSON.stringify(back150.levels[45]));
  } finally {
    try { fs.rmSync(o150.dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  const rt = clone(hs.data.levels[45]);
  hs.recordLevel(45, { stars: 1, survivors: 50, score: 100, coins: 10, typeKey: rt.t === 'horde' ? 'standard' : 'horde', metric: 50 });
  check('(H-f) a re-type moves h with the old bests into rec.prev', hs.data.levels[45].h === undefined && JSON.stringify(hs.data.levels[45].prev.h) === JSON.stringify(rt.h)
    && hs.data.levels[45].prev.t === rt.t, JSON.stringify(hs.data.levels[45]));
  console.log(`sizes: 1.3.0 owner save ${v1json.length} B, after migration + this test's runs ${v2json.length} B`);
} finally {
  try { fs.rmSync(old.dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

/** Paths whose values differ between two plain JSON objects (for the report). */
function diffKeys(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return [at || '(root)'];
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diffKeys(a[k], b[k], at ? at + '.' + k : k));
  return out;
}

console.log(`check-save: ${failures.length === 0 ? 'every check passed' : failures.length + ' failure(s)'}`);
process.exit(failures.length ? 1 : 0);
