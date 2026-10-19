#!/usr/bin/env node
// Builds docs/build/CALLSITES.md: for every ctx system (ctx.fx, ctx.render, ...), every distinct
// member accessed by OTHER files (directly or through aliases such as `this._fx = ctx.fx || null`
// and `const fx = this._fx`), with file:line examples; plus every event's emitters and listeners.
// Usage: node tools/callsites.js
//
// Alias resolution:
//   • `this.X = ctx.sys` / `this.X = this.Y` (Y an alias) → a class-wide alias (whole file).
//   • `const|let|var x = ctx.sys` (or = another alias) → a LEXICAL alias: a use on line n resolves to
//     the nearest declaration of `x` at or above line n (a later `const x = somethingElse` shadows it).
//     Two functions may therefore reuse one short name for different systems (fx.js: `const r =
//     this.ctx.render` and `const r = this.ctx.rngFx`) without the resolution oscillating.
//   • Discovery only ever ADDS (name, line, system) facts, so the fixed-point loop always terminates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'js');
const files = fs.readdirSync(JS).filter((f) => f.endsWith('.js'));
const SYSTEMS = ['fx', 'render', 'models', 'ui', 'audio', 'weapons', 'gates', 'pickups', 'save', 'squad', 'zombies', 'boss', 'troops', 'level', 'engine', 'events', 'state', 'input', 'world', 'time', 'quality', 'run', 'profile', 'config', 'debug', 'rng', 'rngFx'];
const OWNER = { fx: 'fx.js', render: 'render.js', models: 'models.js', ui: 'ui.js', audio: 'audio.js', weapons: 'weapons.js', gates: 'gates.js', pickups: 'pickups.js', save: 'save.js', squad: 'squad.js', zombies: 'zombies.js', boss: 'boss.js', troops: 'troops.js', level: 'level.js', engine: 'engine.js' };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const uses = {};
const emits = {};
const listens = {};
const add = (sys, member, site) => { ((uses[sys] ??= {})[member] ??= []).push(site); };

for (const f of files) {
  const src = fs.readFileSync(path.join(JS, f), 'utf8');
  const lines = src.split('\n');
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo;
  };

  // Class-wide aliases (this.X): name → system ('' = ambiguous, never resolved).
  const thisAlias = {};
  // Lexical aliases: name → sorted [{ line, sys|null }] (null = a non-alias declaration that shadows).
  const localDecl = {};
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=/g)) {
    (localDecl[m[1]] ??= []).push({ line: lineOf(m.index), sys: null });
  }
  for (const k of Object.keys(localDecl)) localDecl[k].sort((a, b) => a.line - b.line);
  const resolveLocal = (name, line) => {
    const list = localDecl[name];
    if (!list) return null;
    let best = null;
    for (const d of list) { if (d.line <= line) best = d; else break; }
    return best ? best.sys : null;
  };
  const resolve = (name, line) => {
    if (name === 'ctx' || name === 'this.ctx') return 'ctx';
    if (name.startsWith('this.')) return thisAlias[name] || null;
    return resolveLocal(name, line);
  };
  const setLocal = (name, line, sys) => {
    const list = localDecl[name];
    if (!list) return false;
    for (const d of list) {
      if (d.line !== line) continue;
      if (d.sys === null) { d.sys = sys; return true; }
      return false;
    }
    return false;
  };
  const setThis = (name, sys) => {
    const cur = thisAlias[name];
    if (cur === undefined) { thisAlias[name] = sys; return true; }
    if (cur !== sys && cur !== '') { thisAlias[name] = ''; return true; }   // conflicting class-wide alias → ambiguous
    return false;
  };

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    // x = ctx.sys / x = this.ctx.sys (only ctx creates a system alias)
    for (const m of src.matchAll(/(?:\b(?:const|let|var)\s+(\w+)|\b(this\.\w+))\s*=\s*((?:this\.)?ctx|this\.\w+|\w+)(?:\?)?\.(\w+)\b(?!\s*\()(?![.\w])/g)) {
      const name = m[1] || m[2];
      const line = lineOf(m.index);
      if (resolve(m[3], line) !== 'ctx') continue;
      const member = m[4];
      if (!SYSTEMS.includes(member)) continue;
      if (m[1] ? setLocal(name, line, member) : setThis(name, member)) changed = true;
    }
    // x = alias (copy)
    for (const m of src.matchAll(/(?:\b(?:const|let|var)\s+(\w+)|\b(this\.\w+))\s*=\s*(this\.\w+|\w+)\s*(?:\|\||;|\n|,)/g)) {
      const name = m[1] || m[2];
      if (name === 'ctx') continue;
      const line = lineOf(m.index);
      const sys = resolve(m[3], line);
      if (!sys || sys === 'ctx') continue;
      if (m[1] ? setLocal(name, line, sys) : setThis(name, sys)) changed = true;
    }
    // const { fx, render: r } = ctx
    for (const m of src.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*(?:this\.)?ctx\b/g)) {
      const line = lineOf(m.index);
      for (const part of m[1].split(',')) {
        const [a, b] = part.split(':').map((x) => x.trim());
        if (!a || !SYSTEMS.includes(a)) continue;
        const name = b || a;
        localDecl[name] ??= [];
        if (!localDecl[name].some((d) => d.line === line)) {
          localDecl[name].push({ line, sys: null });
          localDecl[name].sort((x, y) => x.line - y.line);
        }
        if (setLocal(name, line, a)) changed = true;
      }
    }
  }

  // Every alias name that resolves to some foreign system somewhere in the file (resolved per line below).
  const aliasNames = new Set();
  for (const [n, s] of Object.entries(thisAlias)) if (s && SYSTEMS.includes(s) && OWNER[s] !== f) aliasNames.add(n);
  for (const [n, list] of Object.entries(localDecl)) if (list.some((d) => d.sys && SYSTEMS.includes(d.sys) && OWNER[d.sys] !== f)) aliasNames.add(n);
  const aliasRes = [...aliasNames].map((name) => [name, new RegExp('(?<![\\w.])' + esc(name) + '\\??\\.(\\w+(?:\\??\\.\\w+)?)\\s*(\\()?', 'g')]);

  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const site = `${f}:${i + 1}`;
    let m;
    const re = /\bctx\??\.(\w+)\??\.(\w+(?:\??\.\w+)?)\s*(\()?/g;
    while ((m = re.exec(line))) {
      const sys = m[1];
      if (!SYSTEMS.includes(sys) || OWNER[sys] === f) continue;
      add(sys, m[2].replace(/\?/g, '') + (m[3] ? '()' : ''), site);
    }
    for (const [name, ra] of aliasRes) {
      const sys = resolve(name, i);
      if (!sys || sys === 'ctx' || !SYSTEMS.includes(sys) || OWNER[sys] === f) continue;
      ra.lastIndex = 0;
      while ((m = ra.exec(line))) add(sys, m[1].replace(/\?/g, '') + (m[2] ? '()' : ''), site);
    }
    // Events are 'noun:verb' literals. Emits: `.emit('a:b'`, `this._emit('a:b'`, `emit('a:b'`;
    // listens: `.on('a:b'`, `.once('a:b'`, bare `on('a:b'` / `_on('a:b'` helpers. Particle kinds such
    // as fx.emit('spark', …) have no colon and are not events. Colon-less events: error, resize, pause, resume, shot, explosion.
    const em = /(?<![\w$])_?emit\w*\(\s*['"](\w+:\w+|error|resize|pause|resume|shot|explosion)['"]/g;
    while ((m = em.exec(line))) (emits[m[1]] ??= new Set()).add(f);
    const on = /(?<![\w$])_?(?:on|once|listen|subscribe)\(\s*['"](\w+:\w+|error|resize|pause|resume|shot|explosion)['"]/g;
    while ((m = on.exec(line))) (listens[m[1]] ??= new Set()).add(f);
  });
  // Listener tables: `const SOMETHING_EVENTS = [ 'a:b', … ]` iterated into bus.on(name, …).
  for (const m of src.matchAll(/\b[A-Z_]*EVENTS\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/g)) {
    if (!/\.(?:on|once)\(/.test(src)) continue;
    for (const n of m[1].matchAll(/['"](\w+:\w+)['"]/g)) (listens[n[1]] ??= new Set()).add(f);
  }
}

let out = '# Call-site index (generated by tools/callsites.js — regenerate, do not edit)\n\n';
out += 'For each ctx system: every member that OTHER files access (directly or via aliases), with up to 5 call sites. ';
out += 'The owner module must implement each of these with the semantics its callers assume: open the call sites and read them. ';
out += 'A member listed here that the owner does not implement is an integration bug.\n\n';
for (const sys of SYSTEMS) {
  if (!uses[sys]) continue;
  out += `## ctx.${sys}${OWNER[sys] ? ` (owner js/${OWNER[sys]})` : ''}\n\n`;
  for (const [mem, sites] of Object.entries(uses[sys]).sort()) {
    const uniq = [...new Set(sites)];
    out += `- \`${mem}\` — ${uniq.slice(0, 5).join(', ')}${uniq.length > 5 ? ` (+${uniq.length - 5})` : ''}\n`;
  }
  out += '\n';
}
out += '## Events (string-literal emits/listens, incl. _emit/on helpers and *EVENTS tables)\n\n| event | emitted by | listened by |\n|---|---|---|\n';
const names = new Set([...Object.keys(emits), ...Object.keys(listens)]);
for (const n of [...names].sort()) out += `| \`${n}\` | ${[...(emits[n] || [])].join(', ') || '**nobody**'} | ${[...(listens[n] || [])].join(', ') || '—'} |\n`;
fs.mkdirSync(path.join(ROOT, 'docs/build'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/build/CALLSITES.md'), out);
console.log(`wrote docs/build/CALLSITES.md (${out.split('\n').length} lines)`);
