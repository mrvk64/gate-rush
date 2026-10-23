#!/usr/bin/env node
// tools/check-imports.js — zero-dependency static cross-checker for js/ (ARCHITECTURE §1, §14).
//
// For every js/*.js file it collects the export names and every import statement, then verifies:
//   (a) every relative import path exists;
//   (b) every named import exists in the target module's exports (star re-exports followed);
//   (c) every named import from 'three' exists in node_modules/three/build/three.module.js;
//   (d) every 'three/addons/<path>' import maps to node_modules/three/examples/jsm/<path> and the
//       named import exists there (re-exports followed, e.g. Addons.js);
//   (e) dependency rule §1: a module may import only three, three/addons/*, ./util.js, ./data.js,
//       ./render.js, ./models.js (level.js may also import ./levelgen.js; the render split adds
//       render.js → materials/environment/engine(detectTier), materials.js → fxmaterials/environment,
//       fx.js → fxmaterials; main.js may import anything)
//       → WARNINGS; plus util/data/levelgen purity warnings;
//   (f) Math.random outside util.js and console.log anywhere → ERRORS.
// Exit code 1 on any error. Regexes are robust to multi-line `import { … }` blocks and comments
// (comments are stripped before scanning; import statements must start a line, so prose inside
// string literals such as STRINGS.noImportMap never matches).
//
// Usage: node tools/check-imports.js [--js js] [--verbose] [--strict]   (--strict: warnings fail too)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREE_BUILD = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
const THREE_JSM = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm');

// Dependency rule (§1): what a gameplay module may import.
const ALLOWED_RELATIVE = new Set(['./util.js', './data.js', './render.js', './models.js']);
const EXTRA_ALLOWED = {
  'main.js': null,                          // null = anything goes
  'level.js': new Set(['./levelgen.js']),   // the runner needs the generator (§6.16)
  'levelgen.js': new Set([]),               // pure: util + data only (checked below)
  // Render split (lead decision): render.js re-exports MaterialLibrary (./materials.js) and Environment
  // (./environment.js); the shader factories live in ./fxmaterials.js (particles/decals) and
  // ./environment.js (sky). render.js also imports the PURE detectTier/maxAutoTierFor helpers from
  // ./engine.js (§4.1 step 5(d), §6.2 "called by render.init()"); engine.js imports only util/data,
  // so the graph stays acyclic.
  'render.js': new Set(['./materials.js', './environment.js', './engine.js']),
  'materials.js': new Set(['./fxmaterials.js', './environment.js']),
  'fx.js': new Set(['./fxmaterials.js']),
};
// Modules that must stay free of THREE / DOM (importable from node tools).
const PURE_MODULES = new Set(['data.js', 'levelgen.js']);
// Modules that nobody but main.js may import (event consumers, §1).
const CONSUMER_ONLY = new Set(['./ui.js', './audio.js', './fx.js', './engine.js', './save.js', './level.js']);
// Round 7 (r7 INT): direct console calls a file may make without a warning (method → count). engine.js: the diagnostics
// dump of window.__gateRushDiag() (engine.diagText, ARCH §13 / §14 rule 5). console.log stays banned everywhere.
const CONSOLE_SANCTIONED = { 'engine.js': { info: 1 } };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const opts = { js: path.join(ROOT, 'js'), verbose: false, strict: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--js') opts.js = path.resolve(ROOT, process.argv[++i] || 'js');
  else if (a === '--verbose' || a === '-v') opts.verbose = true;
  else if (a === '--strict') opts.strict = true;
  else if (a === '--help' || a === '-h') {
    process.stdout.write('check-imports: static import/export cross-check for js/\n  --js <dir>  --verbose  --strict\n');
    process.exit(0);
  } else {
    process.stderr.write(`check-imports: unknown argument ${a}\n`);
    process.exit(1);
  }
}

const errors = [];
const warnings = [];
function err(file, line, msg) { errors.push({ file, line, msg }); }
function warnAt(file, line, msg) { warnings.push({ file, line, msg }); }

// ---------------------------------------------------------------------------
// Source scanning helpers
// ---------------------------------------------------------------------------

/**
 * Replaces comments with spaces (newlines preserved so line numbers stay valid).
 * Tracks string / template literals so `//` or `/*` inside them is left alone,
 * and skips regex literals that follow an operator or `(`/`,`/`=`/`:`/`[`/`!`/`&`/`|`/`?`/`{`/`}`/`;`/`return`.
 */
function stripComments(src) {
  const out = new Array(src.length);
  const n = src.length;
  let i = 0;
  let lastSignificant = '';   // last non-space char emitted (for regex-literal detection)
  const push = (ch) => { out.push(ch); if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') lastSignificant = ch; };
  const blank = (ch) => out.push(ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {                       // line comment
      while (i < n && src[i] !== '\n') { blank(src[i]); i++; }
      continue;
    }
    if (c === '/' && d === '*') {                       // block comment
      blank(c); blank(d); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(src[i]); i++; }
      if (i < n) { blank(src[i]); blank(src[i + 1]); i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {          // string / template literal (copied verbatim)
      const q = c;
      push(c); i++;
      let depth = 0;                                      // ${ … } nesting inside templates (shallow)
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { push(ch); if (i + 1 < n) push(src[i + 1]); i += 2; continue; }
        if (q === '`' && ch === '$' && src[i + 1] === '{') { depth++; push(ch); push('{'); i += 2; continue; }
        if (q === '`' && depth > 0 && ch === '}') { depth--; push(ch); i++; continue; }
        if (ch === q && depth === 0) { push(ch); i++; break; }
        if (q !== '`' && ch === '\n') { push(ch); i++; break; }   // unterminated string: bail at EOL
        push(ch); i++;
      }
      continue;
    }
    if (c === '/') {                                     // regex literal?
      // A `/` is a regex literal when it cannot be a division: after nothing, after an
      // operator / opening bracket / separator, or after return|typeof|case|in|of.
      // After an identifier, number, `)` or `]` it is a division operator.
      const prev = lastSignificant;
      const afterKeyword = lastWordIs(out, 'return') || lastWordIs(out, 'typeof') ||
        lastWordIs(out, 'case') || lastWordIs(out, 'in') || lastWordIs(out, 'of');
      const regexAllowed = prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || afterKeyword;
      if (regexAllowed) {
        push(c); i++;
        let inClass = false;
        while (i < n) {
          const ch = src[i];
          if (ch === '\\') { push(ch); if (i + 1 < n) push(src[i + 1]); i += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { push(ch); i++; break; }
          else if (ch === '\n') break;                    // not a regex after all
          push(ch); i++;
        }
        continue;
      }
    }
    push(c); i++;
  }
  return out.join('');
}

function lastWordIs(out, word) {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j])) j--;
  const end = j + 1;
  while (j >= 0 && /[\w$]/.test(out[j])) j--;
  return out.slice(j + 1, end).join('') === word;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

const IDENT = '[A-Za-z_$][\\w$]*';

/** Parses `a, b as c, default as d` → [{ imported, local }] (also used for export lists). */
function parseNameList(list) {
  const out = [];
  for (const raw of list.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const m = new RegExp(`^(${IDENT}|default)(?:\\s+as\\s+(${IDENT}|default))?$`).exec(item);
    if (!m) { out.push({ imported: item, local: item, malformed: true }); continue; }
    out.push({ imported: m[1], local: m[2] || m[1] });
  }
  return out;
}

/**
 * Reads the declarator list that follows `export const|let|var` up to the statement end
 * (depth-0 `;` or newline-terminated when no `;` is used) and returns the declared names,
 * including simple `{ a, b: c }` / `[a, b]` destructuring patterns.
 */
function declaredNames(code, from) {
  let i = from, depth = 0;
  const n = code.length;
  let end = n;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {                 // skip string
      const q = c; i++;
      while (i < n && code[i] !== q) { if (code[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) { end = i; break; }
    else if (c === '\n' && depth === 0) {                         // ASI heuristic: statement ends unless the next
      const rest = code.slice(i + 1).match(/^\s*([^\s])/);          // significant char continues the expression
      if (!rest || !/[.,?:+\-*/%&|=<>)\]}]/.test(rest[1])) { end = i; break; }
    }
    i++;
  }
  const stmt = code.slice(from, end);
  // split at depth-0 commas
  const pieces = [];
  let start = 0; depth = 0;
  for (let k = 0; k < stmt.length; k++) {
    const c = stmt[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { pieces.push(stmt.slice(start, k)); start = k + 1; }
  }
  pieces.push(stmt.slice(start));
  const names = [];
  for (const piece of pieces) {
    const lhs = piece.split('=')[0].trim();
    if (!lhs) continue;
    if (lhs.startsWith('{') || lhs.startsWith('[')) {
      const inner = lhs.slice(1, lhs.lastIndexOf(lhs.startsWith('{') ? '}' : ']'));
      for (const part of inner.split(',')) {
        const p = part.trim();
        if (!p) continue;
        const m = new RegExp(`(?:^|:\\s*)(${IDENT})\\s*$`).exec(p.replace(/\.\.\./, ''));
        if (m) names.push(m[1]);
      }
    } else {
      const m = new RegExp(`^(${IDENT})`).exec(lhs);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Export / import collection
// ---------------------------------------------------------------------------

/**
 * @returns {{ names: Map<string, number>, stars: { spec: string, line: number }[],
 *             reexports: { spec: string, names: {imported:string, local:string}[], line: number }[] }}
 * `names` maps exported name → line. Star re-exports are resolved lazily by hasExport().
 */
function collectExports(code) {
  const names = new Map();
  const stars = [];
  const reexports = [];
  const add = (name, idx) => { if (!names.has(name)) names.set(name, lineOf(code, idx)); };
  let m;

  const reFn = new RegExp(`^[ \\t]*export\\s+(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`, 'gm');
  while ((m = reFn.exec(code)) !== null) add(m[1], m.index);

  const reClass = new RegExp(`^[ \\t]*export\\s+class\\s+(${IDENT})`, 'gm');
  while ((m = reClass.exec(code)) !== null) add(m[1], m.index);

  const reVar = /^[ \t]*export\s+(?:const|let|var)\s+/gm;
  while ((m = reVar.exec(code)) !== null) {
    for (const name of declaredNames(code, m.index + m[0].length)) add(name, m.index);
  }

  const reDefault = /^[ \t]*export\s+default\b/gm;
  while ((m = reDefault.exec(code)) !== null) add('default', m.index);

  const reList = /^[ \t]*export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/gm;
  while ((m = reList.exec(code)) !== null) {
    const list = parseNameList(m[1]);
    for (const e of list) add(e.local, m.index);        // `a as b` exports b
    if (m[2]) reexports.push({ spec: m[2], names: list, line: lineOf(code, m.index) });
  }

  const reStar = new RegExp(`^[ \\t]*export\\s*\\*\\s*(?:as\\s+(${IDENT})\\s+)?from\\s*['"]([^'"]+)['"]`, 'gm');
  while ((m = reStar.exec(code)) !== null) {
    if (m[1]) add(m[1], m.index);
    else stars.push({ spec: m[2], line: lineOf(code, m.index) });
  }
  return { names, stars, reexports };
}

/**
 * @returns {{ spec, line, names:{imported,local}[], defaultName:string|null, namespace:string|null,
 *             sideEffect:boolean, dynamic:boolean }[]}
 */
function collectImports(code) {
  const imports = [];
  let m;
  // import <clause> from '<spec>'  — clause may span lines; it never contains quotes or parens,
  // so prose like "no import maps" inside a string literal cannot match.
  const reFrom = /^[ \t]*import\s+([\w$\s,{}*]+?)\s*from\s*['"]([^'"]+)['"]/gm;
  while ((m = reFrom.exec(code)) !== null) {
    const entry = { spec: m[2], line: lineOf(code, m.index), names: [], defaultName: null, namespace: null, sideEffect: false, dynamic: false };
    let clause = m[1].trim();
    const braced = /\{([^}]*)\}/.exec(clause);
    if (braced) {
      entry.names = parseNameList(braced[1]);
      clause = (clause.slice(0, braced.index) + clause.slice(braced.index + braced[0].length)).replace(/,\s*$/, '').trim();
    }
    const ns = new RegExp(`\\*\\s*as\\s+(${IDENT})`).exec(clause);
    if (ns) { entry.namespace = ns[1]; clause = clause.replace(ns[0], '').trim(); }
    clause = clause.replace(/^,|,$/g, '').trim();
    if (clause) {
      if (new RegExp(`^${IDENT}$`).test(clause)) entry.defaultName = clause;
      else entry.malformed = clause;
    }
    imports.push(entry);
  }
  const reSide = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
  while ((m = reSide.exec(code)) !== null) {
    imports.push({ spec: m[1], line: lineOf(code, m.index), names: [], defaultName: null, namespace: null, sideEffect: true, dynamic: false });
  }
  const reDyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reDyn.exec(code)) !== null) {
    imports.push({ spec: m[1], line: lineOf(code, m.index), names: [], defaultName: null, namespace: null, sideEffect: false, dynamic: true });
  }
  return imports;
}

// ---------------------------------------------------------------------------
// Module graph (project files + three + addons), with lazy export resolution
// ---------------------------------------------------------------------------

const moduleCache = new Map();   // absPath → { code, exports } | null (unreadable)

function loadModule(absPath) {
  if (moduleCache.has(absPath)) return moduleCache.get(absPath);
  let info = null;
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const code = stripComments(raw);
    info = { code, exports: collectExports(code) };
  } catch (_) {
    info = null;
  }
  moduleCache.set(absPath, info);
  return info;
}

/** Resolves an import specifier seen in `fromAbs` to an absolute file path, or null for unknown bare specifiers. */
function resolveSpec(spec, fromAbs) {
  if (spec === 'three') return THREE_BUILD;
  if (spec.startsWith('three/addons/')) return path.join(THREE_JSM, spec.slice('three/addons/'.length));
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) return path.resolve(path.dirname(fromAbs), spec);
  return null;
}

/** True when module `absPath` exports `name` (own export or via `export * from`). */
function hasExport(absPath, name, visited = new Set()) {
  if (visited.has(absPath)) return false;
  visited.add(absPath);
  const info = loadModule(absPath);
  if (!info) return false;
  if (info.exports.names.has(name)) return true;
  if (name === 'default') return false;                     // star re-exports never forward default
  for (const star of info.exports.stars) {
    const target = resolveSpec(star.spec, absPath);
    if (target && hasExport(target, name, visited)) return true;
  }
  return false;
}

function exportCount(absPath) {
  const info = loadModule(absPath);
  return info ? info.exports.names.size : 0;
}

// ---------------------------------------------------------------------------
// Per-file checks
// ---------------------------------------------------------------------------

function rel(abs) { return path.relative(ROOT, abs).replace(/\\/g, '/'); }

function checkFile(absPath, projectFiles) {
  const base = path.basename(absPath);
  const info = loadModule(absPath);
  if (!info) { err(rel(absPath), 0, 'cannot read file'); return null; }
  const code = info.code;
  const imports = collectImports(code);
  const summary = { file: base, exports: info.exports.names.size, imports: imports.length, specs: [] };

  // --- re-export lists must name real exports of their source
  for (const re of info.exports.reexports) {
    const target = resolveSpec(re.spec, absPath);
    if (!target) { err(rel(absPath), re.line, `re-export from unknown module specifier '${re.spec}'`); continue; }
    if (!fs.existsSync(target)) { err(rel(absPath), re.line, `re-export source '${re.spec}' does not exist`); continue; }
    for (const e of re.names) if (!hasExport(target, e.imported)) err(rel(absPath), re.line, `re-exported name '${e.imported}' is not exported by '${re.spec}'`);
  }
  for (const star of info.exports.stars) {
    const target = resolveSpec(star.spec, absPath);
    if (!target || !fs.existsSync(target)) err(rel(absPath), star.line, `export * from '${star.spec}': module not found`);
  }

  // --- imports
  const allowedExtra = Object.prototype.hasOwnProperty.call(EXTRA_ALLOWED, base) ? EXTRA_ALLOWED[base] : new Set();
  for (const imp of imports) {
    const spec = imp.spec;
    summary.specs.push(spec);
    const where = rel(absPath);
    if (imp.malformed) err(where, imp.line, `cannot parse import clause fragment '${imp.malformed}' (spec '${spec}')`);

    const target = resolveSpec(spec, absPath);
    if (target === null) {
      err(where, imp.line, `bare specifier '${spec}' is not in the import map (only 'three' and 'three/addons/*' resolve in the browser)`);
      continue;
    }
    const kind = spec === 'three' ? 'three' : spec.startsWith('three/addons/') ? 'addon' : 'relative';

    // (a) / (d): the target file must exist
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      if (kind === 'three') err(where, imp.line, `three.module.js not found at ${rel(THREE_BUILD)} (run npm install)`);
      else if (kind === 'addon') err(where, imp.line, `'${spec}' does not map to a file under node_modules/three/examples/jsm/`);
      else err(where, imp.line, `relative import '${spec}' does not exist (${rel(target)})`);
      continue;
    }
    if (kind === 'relative' && !spec.endsWith('.js')) err(where, imp.line, `relative import '${spec}' must carry the .js extension (no bundler resolves it)`);
    if (imp.dynamic) continue;                                  // existence is all we can check

    // (b) / (c) / (d): named imports must exist
    for (const e of imp.names) {
      if (e.malformed) { err(where, imp.line, `malformed import entry '${e.imported}' from '${spec}'`); continue; }
      if (!hasExport(target, e.imported)) {
        const label = kind === 'three' ? 'three (r170 three.module.js)' : `'${spec}'`;
        err(where, imp.line, `named import '${e.imported}' is not exported by ${label}`);
      }
    }
    if (imp.defaultName && !hasExport(target, 'default')) {
      err(where, imp.line, `default import '${imp.defaultName}' but '${spec}' has no default export`);
    }

    // (e) dependency rule §1 (warnings) — main.js may import anything
    if (allowedExtra !== null) {
      const ok = kind === 'three' || kind === 'addon' || ALLOWED_RELATIVE.has(spec) || allowedExtra.has(spec);
      if (!ok) {
        const why = CONSUMER_ONLY.has(spec)
          ? `'${spec}' is an event consumer / orchestrator; reach it through ctx, never import it`
          : `gameplay modules import only three, three/addons/*, ./util.js, ./data.js, ./render.js, ./models.js`;
        warnAt(where, imp.line, `imports '${spec}' — dependency rule §1: ${why}`);
      }
      if (base === 'util.js' && kind !== 'three') warnAt(where, imp.line, `util.js must import only 'three' (it is the root of the dependency chain)`);
      if (base === 'data.js' && spec !== './util.js') warnAt(where, imp.line, `data.js may import only ./util.js`);
      if (base === 'levelgen.js' && spec !== './util.js' && spec !== './data.js') warnAt(where, imp.line, `levelgen.js may import only ./util.js and ./data.js`);
      if (PURE_MODULES.has(base) && (kind === 'three' || kind === 'addon')) {
        err(where, imp.line, `${base} must stay free of THREE (pure, node-importable by tools/validate-levels.js)`);
      }
      if (spec === './util.js' || spec === './data.js' || spec === './render.js' || spec === './models.js' || spec === './levelgen.js') {
        if (spec === `./${base}`) err(where, imp.line, 'module imports itself');
      }
    }
  }

  // (f) banned calls — on comment-stripped code, so commented mentions are fine
  const reRandom = /\bMath\s*\.\s*random\s*\(/g;
  let m;
  if (base !== 'util.js') {
    while ((m = reRandom.exec(code)) !== null) err(rel(absPath), lineOf(code, m.index), 'Math.random — use ctx.rng / ctx.rngFx (§13); only util.js may call it');
  }
  const reLog = /\bconsole\s*\.\s*log\s*\(/g;
  while ((m = reLog.exec(code)) !== null) err(rel(absPath), lineOf(code, m.index), 'console.log is banned in js/ (§14 rule 5)');
  if (base !== 'util.js') {
    // round 7 (r7 INT): the one sanctioned direct console call outside util.js — engine.diagText's console.info, the dump
    // a tester asks for with window.__gateRushDiag() (ARCH §13, §14 rule 5). Exactly one per listed file; any other warns.
    const sanctioned = Object.assign({}, CONSOLE_SANCTIONED[base] || {});
    const reWarn = /\bconsole\s*\.\s*(warn|error|info|debug)\s*\(/g;
    while ((m = reWarn.exec(code)) !== null) {
      if (sanctioned[m[1]] > 0) { sanctioned[m[1]]--; continue; }
      warnAt(rel(absPath), lineOf(code, m.index), `console.${m[1]} — route through util.warnOnce / ctx.ui.showError (§14 rule 5)`);
    }
  }
  const reDebugger = /^[ \t]*debugger\b/gm;
  while ((m = reDebugger.exec(code)) !== null) warnAt(rel(absPath), lineOf(code, m.index), 'debugger statement left in code');

  // module-scope browser-global access at import time (heuristic: top-level `document.`/`window.` outside any block)
  checkTopLevelGlobals(code, rel(absPath));

  return { summary, imports };
}

/**
 * Warns when `document.` / `window.` / `navigator.` appear at brace depth 0, i.e. are evaluated
 * at import time (a module must never touch the DOM at import time — only inside init()/constructors).
 * util.js is exempt because its probes are the sanctioned guarded ones.
 */
function checkTopLevelGlobals(code, where) {
  if (where.endsWith('/util.js')) return;
  let depth = 0;
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n && code[i] !== q) { if (code[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && /[dwn]/.test(c) && /^(document|window|navigator)\s*\./.test(code.slice(i, i + 12))) {
      const before = code[i - 1] || ' ';
      const isTypeofGuard = /typeof\s+$/.test(code.slice(Math.max(0, i - 8), i));
      if (!/[\w$.]/.test(before) && !isTypeofGuard) {
        const word = /^(document|window|navigator)/.exec(code.slice(i, i + 12))[1];
        warnAt(where, lineOf(code, i), `top-level '${word}.' access runs at import time — move it into init()/constructor (modules must import cleanly in node)`);
      }
      i += 6; continue;
    }
    i++;
  }
}

// ---------------------------------------------------------------------------
// Cycle detection on the relative-import graph (§1: acyclic)
// ---------------------------------------------------------------------------

function findCycles(graph) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];
  const visit = (node) => {
    color.set(node, GREY); stack.push(node);
    for (const next of graph.get(node) || []) {
      if (!graph.has(next)) continue;
      const c = color.get(next) || WHITE;
      if (c === GREY) cycles.push(stack.slice(stack.indexOf(next)).concat(next));
      else if (c === WHITE) visit(next);
    }
    stack.pop(); color.set(node, BLACK);
  };
  for (const node of graph.keys()) if ((color.get(node) || WHITE) === WHITE) visit(node);
  return cycles;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(opts.js) || !fs.statSync(opts.js).isDirectory()) {
    process.stdout.write(`check-imports: ${rel(opts.js)}/ does not exist — nothing to check\n`);
    return 0;
  }
  const files = fs.readdirSync(opts.js).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(opts.js, f));
  if (files.length === 0) {
    process.stdout.write(`check-imports: no .js files in ${rel(opts.js)}/ — nothing to check\n`);
    return 0;
  }
  if (!fs.existsSync(THREE_BUILD)) {
    err('node_modules', 0, `three.module.js not found at ${rel(THREE_BUILD)} — run npm install (three@0.170.0)`);
  }

  const summaries = [];
  const graph = new Map();
  for (const abs of files) {
    const res = checkFile(abs, files);
    if (!res) continue;
    summaries.push(res.summary);
    const edges = [];
    for (const imp of res.imports) {
      if (imp.spec.startsWith('./') || imp.spec.startsWith('../')) edges.push(path.resolve(path.dirname(abs), imp.spec));
    }
    graph.set(abs, edges);
  }
  for (const cycle of findCycles(graph)) {
    warnAt(rel(cycle[0]), 0, `import cycle: ${cycle.map((p) => path.basename(p)).join(' → ')} (dependency rule §1 requires an acyclic graph)`);
  }

  // --- report
  const totalExports = summaries.reduce((s, x) => s + x.exports, 0);
  const totalImports = summaries.reduce((s, x) => s + x.imports, 0);
  const width = Math.max(8, ...summaries.map((s) => s.file.length));
  process.stdout.write(`check-imports: ${summaries.length} file(s) in ${rel(opts.js)}/, ${totalExports} exports, ${totalImports} imports, ` +
    `three exports known: ${exportCount(THREE_BUILD)}\n`);
  for (const s of summaries) {
    const uniq = [...new Set(s.specs)];
    const shown = opts.verbose || uniq.length <= 8 ? uniq.join(', ') : uniq.slice(0, 8).join(', ') + ` … (+${uniq.length - 8})`;
    process.stdout.write(`  ${s.file.padEnd(width)}  ${String(s.exports).padStart(3)} exports  ${String(s.imports).padStart(3)} imports  ${shown ? '← ' + shown : ''}\n`);
  }
  if (opts.verbose) {
    for (const abs of files) {
      const info = loadModule(abs);
      if (!info) continue;
      process.stdout.write(`  exports of ${path.basename(abs)}: ${[...info.exports.names.keys()].join(', ') || '(none)'}\n`);
    }
  }
  const fmt = (e) => `  ${e.file}${e.line ? ':' + e.line : ''}  ${e.msg}`;
  if (warnings.length) {
    process.stdout.write(`\nWARNINGS (${warnings.length}):\n${warnings.map(fmt).join('\n')}\n`);
  }
  if (errors.length) {
    process.stdout.write(`\nERRORS (${errors.length}):\n${errors.map(fmt).join('\n')}\n`);
  }
  const failed = errors.length > 0 || (opts.strict && warnings.length > 0);
  process.stdout.write(`\ncheck-imports: ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'OK'}\n`);
  return failed ? 1 : 0;
}

process.exit(main());
