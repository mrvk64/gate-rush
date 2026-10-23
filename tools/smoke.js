#!/usr/bin/env node
// Gate Rush real-browser smoke test (headless Chrome via puppeteer-core, real GPU).
//
// Usage (from the project root):
//   node tools/smoke.js                         # boot + title + level 1 played by a bot (default)
//   node tools/smoke.js --scenario boot         # boot to the title screen only
//   node tools/smoke.js --scenario play --level 3 --seconds 120
//   node tools/smoke.js --scenario ui           # click through every menu screen
//   node tools/smoke.js --scenario all          # boot, ui, play (L1), then a real tap on the results screen's HOME → title
//   node tools/smoke.js --shell artifact        # artifact.html inside a host skeleton (like claude.ai)
//   node tools/smoke.js --shell sandbox         # artifact.html inside a sandboxed iframe (storage throws, opaque origin)
//   node tools/smoke.js --quality low|med|high  # forces ?quality=
//   node tools/smoke.js --desktop               # 1280x800 instead of a 390x844 phone
//   node tools/smoke.js --viewport 1024x594     # round 7: any CSS viewport (DPR 1 with --desktop, else a DPR 2 touch phone)
//   node tools/smoke.js --gpu sw                # round 7: no-GPU emulation — WebGL on SwiftShader with software compositing
//                                              #   (--disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader), like a
//                                              #   GPU-less Linux box; --gpu swauto = Chrome's automatic fallback (--disable-gpu
//                                              #   --enable-unsafe-swiftshader); default --gpu hw (D3D11, the real GPU)
//   node tools/smoke.js --shots 5               # screenshot every 5 s of play (default 8)
//   node tools/smoke.js --nobot                 # play without steering (squad stays centred)
//   node tools/smoke.js --out docs/build/smoke  # where PNGs + report.json go
//   node tools/smoke.js --headful               # show the browser window
//   node tools/smoke.js --endless               # play endless mode instead of a campaign level
//   node tools/smoke.js --pre "<js>"            # JS run in the page after boot, before the scenario, with g = window.__game
//                                              #   e.g. --pre "g.save.addCoins(9000); g.save.setUpgrade('damage', 5)"
//   node tools/smoke.js --after "<js>"          # JS run right after the level starts (g = window.__game), e.g. --after "g.squad.setCount(150,'debug')"
//   node tools/smoke.js --boss                  # jump the level to just before the boss (distance = length - 20)
//   node tools/smoke.js --bootTimeout 60        # seconds to wait for the boot (default 30; raise it on a loaded host)
//   node tools/smoke.js --root <dir>            # round 7: serve another tree with this harness (a before / after A/B)
//
// Output: a JSON report on stdout (and <out>/report.json) with boot status, every page error,
// console error/warning (deduped with counts), failed request, a 2 s timeline of game state,
// frame-time stats and the screenshot paths. Read the PNGs with an image viewer to judge visuals.
// Every timeline sample carries `gear` (active gear ids) and `troops`; `report.pickups` lists every item:pickup
// ({ t, item, duplicate }) of the played level (round-2 cross-group: LVL-26 needed the pickup trail).
// `frames` excludes the frame intervals that overlap the harness's own page.screenshot() calls (each stalls the
// compositor ≈ 250 ms); `framesRaw` keeps every interval and `shotStallsExcluded` counts the dropped ones.
// Round 5 (districts): every timeline sample also carries `district`, `callsMain` / `callsShadow` / `callsPost` (the debug
// overlay's render.callStats split, ARCH §9.1 budget main ≤ 50 / shadow ≤ 20 / post ≤ 14; `calls` stays the frame total)
// and `programs` (renderer.info.programs.length). `report.callsMax` is the per-frame maximum of that split per district id
// (sampled every rAF while playing; `report.callsPeak` names the objects of each district's peak main-pass frame),
// `report.programs` the min / max program count while playing, `report.districts` every
// district:change ({ atS since play start, id, reason, seconds, banner, dist, maxFrameMs over the fade + 1 s }), and
// `report.startFrames` the frame intervals from the level.start() call through its first 2 s — the start frame itself
// included (`frames` begins after the drag, ≈ 1 s later). `--level N` starts the level the way the menus do
// (level.requestStart: a memo miss generates in frame slices first) and waits for the run.
// Exit code 1 when boot fails, any uncaught page error occurs, or any console.error is logged; also when a harness check
// fails (verdict "CHECK FAILED", `report.checkFailures`): round 4, `--scenario all` taps the HOME icon of the results
// screen it reached (touch on the phone viewport, mouse with --desktop) and expects the title (`report.home`).
// Round 6 (stored weapons): weapon pickups wait in the HUD FIRE button (#btn-fire). While the bot plays, the harness
// presses it for real — a touch tap on the phone viewport (a mouse click with --desktop) at the button's centre — when
// weapons.canFire (a weapon stored, none running) and a living zombie or the boss is within 25 m of the squad
// (FIRE_RANGE_M). `report.fire` lists every press ({ t, weapon, near, started }: started = weapons.weapon became that
// weapon within 0.5 s, i.e. the real input path fired it) and every weapon:stored ({ t, id, slots }); a press that did
// not start its weapon is a harness check failure. --nobot disables the presses too.
// Round 7 (perf): `report.perf` = { gpu, tier, software, auto, clockRatio (Σ engine time.unscaledDt / Σ real frame
// interval over the frames spent playing: 1 = the game clock is real time), gameRatio (level time / wall time while
// playing, includes slow-mo), fps (frames while playing / wall), sustainedFrameMs, renderScale { first, last, min, max },
// scaleChanges (every quality:scale), canvas }. Screenshots stall the compositor, so measure ratios with a large --shots.
// `report.boot` also carries software / renderScale / maxAutoTier / antialias; `report.diag` is the engine's diagnostics log
// (engine.diagText(), the window.__gateRushDiag() report without the console print) at the end of the run. A FIRE press
// waits max(500 ms, 10 frames) for its weapon (a slow software-GL frame rate needs more than 500 ms).

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
// round 7: --root <dir> serves another tree (e.g. an exported baseline) with this harness; the default is this repo
const SERVE_ROOT = (() => { const r = opt('root', null); return typeof r === 'string' ? path.resolve(r) : ROOT; })();
const SCENARIO = String(opt('scenario', 'play'));
const SHELL = String(opt('shell', 'index'));
const QUALITY = opt('quality', null);
const LEVEL = Number(opt('level', 1));
const SECONDS = Number(opt('seconds', 110));
const SHOT_EVERY = Number(opt('shots', 8));
const DESKTOP = !!opt('desktop', false);
const NOBOT = !!opt('nobot', false);
const HEADFUL = !!opt('headful', false);
const ENDLESS = !!opt('endless', false);
const PRE = opt('pre', null);
const BOSS = !!opt('boss', false);
const AFTER = opt('after', null);
const BOOT_TIMEOUT_MS = Math.max(5, Number(opt('bootTimeout', 30)) || 30) * 1000;
// round 7: --gpu hw | sw | swauto (see the header) and --viewport WxH
const GPU = String(opt('gpu', 'hw'));
const GPU_ARGS = {
  hw: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
  sw: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  swauto: ['--disable-gpu', '--enable-unsafe-swiftshader'],
}[GPU];
if (!GPU_ARGS) { console.error(`--gpu must be hw, sw or swauto (got ${GPU})`); process.exit(2); }
const VIEWPORT = (() => {
  const v = opt('viewport', null);
  if (v === null) return null;
  const m = /^(\d+)x(\d+)$/.exec(String(v));
  if (!m) { console.error(`--viewport must be WxH, e.g. 1024x594 (got ${v})`); process.exit(2); }
  return { w: Number(m[1]), h: Number(m[2]) };
})();
const OUT = path.resolve(ROOT, String(opt('out', 'docs/build/smoke')));
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => { try { return fs.existsSync(p); } catch { return false; } });

fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- static server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function hostSkeleton(inner, title) {
  // Mirrors the claude.ai artifact skeleton: doctype, charset, viewport-fit=cover, small reset.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link rel="icon" href="data:,">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px system-ui,sans-serif;background:#fafafa}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>${inner}</body></html>`;
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    // virtual pages
    if (p === '/__artifact.html' || p === '/__sandbox-inner.html') {
      const art = fs.readFileSync(path.join(SERVE_ROOT, 'artifact.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(hostSkeleton(art, 'Gate Rush (artifact)'));
    }
    if (p === '/__sandbox.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="data:,">
<style>html,body{margin:0;height:100%;background:#222}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="f" sandbox="allow-scripts allow-pointer-lock" allow="autoplay" src="/__sandbox-inner.html${url.search}"></iframe></body></html>`);
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(SERVE_ROOT, p));
    if (!file.startsWith(SERVE_ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); return res.end('404 ' + p); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// ---------------------------------------------------------------- report
const VP = VIEWPORT
  ? (DESKTOP ? { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1 } : { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  : (DESKTOP ? { width: 1280, height: 800, deviceScaleFactor: 1 } : { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const report = {
  scenario: SCENARIO, shell: SHELL, quality: QUALITY, level: ENDLESS ? 'endless' : LEVEL, pre: PRE, boss: BOSS,
  viewport: `${VP.width}x${VP.height}@${VP.deviceScaleFactor}${VP.hasTouch ? ' mobile+touch' : ''}`, gpu: GPU,
  boot: { ok: false, ms: 0, state: null, errorBox: null },
  pageErrors: [], consoleErrors: {}, consoleWarnings: {}, failedRequests: [], dialogs: [],
  input: null, timeline: [], frames: null, result: null, ui: [], screenshots: [], home: null, checkFailures: [], verdict: 'unknown',
  fire: { presses: [], stored: [] },   // round 6: stored weapons and the bot's FIRE presses
};
const bump = (bag, text) => { const k = text.slice(0, 400); bag[k] = (bag[k] || 0) + 1; };

if (!CHROME) { console.error('No Chrome/Edge executable found'); process.exit(2); }
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADFUL ? false : true,
  args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    ...GPU_ARGS, '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = await browser.newPage();
await page.setViewport(VP);
page.on('pageerror', (e) => report.pageErrors.push(String(e && (e.stack || e.message) || e).slice(0, 1500)));
page.on('console', (m) => {
  const t = m.type();
  const loc = m.location && m.location();
  const where = loc && loc.url ? ` @ ${loc.url.replace(/^https?:\/\/[^/]+\//, '')}:${loc.lineNumber ?? ''}` : '';
  if (t === 'error') bump(report.consoleErrors, m.text() + where);
  else if (t === 'warning' || t === 'warn') bump(report.consoleWarnings, m.text() + where);
});
page.on('requestfailed', (r) => report.failedRequests.push(`${r.failure()?.errorText} ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) report.failedRequests.push(`${r.status()} ${r.url()}`); });
page.on('dialog', async (d) => { report.dialogs.push(`${d.type()}: ${d.message()}`); try { await d.dismiss(); } catch {} });

const params = new URLSearchParams();
params.set('debug', '1');
params.set('nomusic', '1');
if (QUALITY) params.set('quality', String(QUALITY));
const url = SHELL === 'artifact' ? `/__artifact.html?${params}` : SHELL === 'sandbox' ? `/__sandbox.html?${params}` : `/index.html?${params}`;

// The game lives in the top frame except for the sandbox shell (child iframe).
let gameFrame = page.mainFrame();
const shotWindows = [];   // [pageTimeStart, pageTimeEnd] of every screenshot (game-frame clock), excluded from `frames`
const shot = async (name) => {
  const a = await gameFrame.evaluate(() => performance.now()).catch(() => null);
  const file = path.join(OUT, `${String(report.screenshots.length).padStart(2, '0')}-${name}.png`);
  try { await page.screenshot({ path: file }); report.screenshots.push(path.relative(ROOT, file).replace(/\\/g, '/')); } catch (e) { report.screenshots.push(`FAILED ${name}: ${e.message}`); }
  const b = await gameFrame.evaluate(() => performance.now()).catch(() => null);
  if (a !== null && b !== null) shotWindows.push([a, b]);
};
const ev = (fn, ...args) => gameFrame.evaluate(fn, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function finish(code) {
  // round 7: the engine's diagnostics log (window.__gateRushDiag without the console print) — states, screens, pointer
  // targets, blur / focus, pauses, frame gaps — so an unexpected pause or stall in a run is visible in the report
  report.diag = await ev(() => { const e = window.__game && window.__game.engine; return e && typeof e.diagText === 'function' ? e.diagText(false).split('\n') : null; }).catch(() => null);
  const errCount = report.pageErrors.length + Object.keys(report.consoleErrors).length;
  const checkCount = report.checkFailures.length;
  report.verdict = !report.boot.ok ? 'BOOT FAILED' : errCount ? `ERRORS (${errCount})` : checkCount ? `CHECK FAILED (${checkCount})` : 'CLEAN';
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return browser.close().catch(() => {}).then(() => { server.close(); process.exit(code ?? (report.verdict === 'CLEAN' ? 0 : 1)); });
}

// ---------------------------------------------------------------- boot
const t0 = Date.now();
try {
  // domcontentloaded: a stalled font / CDN request must not hold the harness (the game's own boot wait follows)
  await page.goto(`http://127.0.0.1:${PORT}${url}`, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
  if (SHELL === 'sandbox') {
    await sleep(300);
    gameFrame = page.frames().find((f) => f !== page.mainFrame()) || page.mainFrame();
  }
  await gameFrame.waitForFunction(() => {
    const box = document.getElementById('error-box');
    if (box && !box.hidden) return true;
    const g = window.__game;
    return !!(g && g.state && g.state.current && g.state.current !== 'boot');
  }, { timeout: BOOT_TIMEOUT_MS, polling: 100 });
} catch (e) {
  report.boot.timeoutOrNav = String(e.message || e).slice(0, 300);
}
report.boot.ms = Date.now() - t0;
const bootInfo = await ev(() => {
  const box = document.getElementById('error-box');
  const g = window.__game;
  return {
    state: g?.state?.current ?? null,
    errorBox: box && !box.hidden ? (document.getElementById('error-text')?.textContent || box.textContent) : null,
    hasGame: !!g,
    tier: g?.quality?.tier ?? null,
    dpr: g?.render?.size?.dpr ?? null,
    // round 7: software-GL detection, render scale, auto ceiling, canvas AA (a context-creation flag)
    software: g?.quality?.software ?? null, renderScale: g?.quality?.renderScale ?? null, maxAutoTier: g?.quality?.maxAutoTier ?? null, auto: g?.quality?.auto ?? null,
    antialias: (() => { try { return g?.render?.renderer?.getContext()?.getContextAttributes()?.antialias ?? null; } catch { return null; } })(),
    gpu: (() => { try { const c = g?.render?.renderer?.getContext(); const d = c?.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null; } catch { return null; } })(),
    storageVolatile: g?.save?.volatile ?? null,
    isArtifact: g?.config?.isArtifact ?? null,
    canvas: (() => { const c = document.getElementById('gl-canvas'); return c ? `${c.width}x${c.height} css ${c.clientWidth}x${c.clientHeight}` : null; })(),
  };
}).catch((e) => ({ evalError: String(e.message || e) }));
Object.assign(report.boot, bootInfo);
report.boot.ok = !!(bootInfo.hasGame && bootInfo.state && bootInfo.state !== 'boot' && !bootInfo.errorBox);
await sleep(1500);
await shot('title');
if (!report.boot.ok || SCENARIO === 'boot') await finish();

// ---------------------------------------------------------------- helpers in page
async function installProbes() {
  await ev(() => {
    const g = window.__game;
    // frame-interval sampler (independent of the engine)
    window.__smoke = { intervals: [], stamps: [], last: performance.now(), pickups: [], stored: [], callsMax: {}, programs: { min: 1e9, max: 0 }, districts: [], drawList: [], peaks: {},
      // round 7: game clock vs real time over the frames spent playing, and the render scale (report.perf)
      perf: { wall: 0, clock: 0, frames: 0, lt0: null, lt1: 0, wall0: null, wall1: 0, rsFirst: null, rsLast: null, rsMin: 9, rsMax: 0, scale: [] } };
    if (g && g.events && typeof g.events.on === 'function' && !window.__smokeScaleHook) {
      window.__smokeScaleHook = true;
      g.events.on('quality:scale', (p) => { const s = window.__smoke; if (p && s.perf.scale.length < 100) s.perf.scale.push({ t: Math.round((g.time?.levelTime ?? 0) * 10) / 10, scale: p.scale, reason: String(p.reason), meanMs: Math.round((p.meanInt || 0) * 10) / 10 }); });
    }
    // round 5: the objects drawn in each frame (renderer.renderBufferDirect, counted only when it really drew), so the
    // frame with the most main-pass draws per district keeps its list (report.callsPeak): what a budget overrun is made of
    try {
      const rr = g && g.render ? g.render.renderer : null;
      if (rr && typeof rr.renderBufferDirect === 'function' && typeof g.render.draw === 'function' && !window.__smokeDrawHook) {
        window.__smokeDrawHook = true;   // installProbes runs once per scenario (ui + play in --scenario all): hook once
        const orig = rr.renderBufferDirect;
        rr.renderBufferDirect = function (cam, scene, geo, mat, obj, grp) {
          const c0 = rr.info.render.calls;
          const res = orig.call(this, cam, scene, geo, mat, obj, grp);
          if (rr.info.render.calls > c0) window.__smoke.drawList.push((scene === null ? 'S ' : (scene === g.render.scene ? 'M ' : 'P ')) + (obj.name || obj.type));
          return res;
        };
        const draw = g.render.draw.bind(g.render);
        g.render.draw = function () {
          const s = window.__smoke;
          s.drawList.length = 0;
          draw();
          const cs = g.render.callStats;
          if (!cs || !g.state || !g.state.is('playing')) return;
          const id = (g.level && g.level.district && g.level.district.id) || '?';
          const pk = s.peaks[id];
          if (!pk || cs.main > pk.main) s.peaks[id] = { main: cs.main, shadow: cs.shadow, post: cs.post, t: Math.round((g.time?.levelTime ?? 0) * 10) / 10, zombies: g.zombies?.alive, boss: !!g.boss?.active, list: s.drawList.slice() };
        };
      }
    } catch (e) { /* diagnostics only */ }
    // round 5: district:change trail (payloads are reused by the emitter: copy the fields)
    if (g && g.events && typeof g.events.on === 'function' && !window.__smokeDistrictHook) {
      window.__smokeDistrictHook = true;   // installProbes runs once per scenario (--scenario all): one listener, not two
      g.events.on('district:change', (p) => {
        const s = window.__smoke;
        if (p && s.districts.length < 200) s.districts.push({ t: performance.now(), id: String(p.id), reason: String(p.reason), seconds: +p.seconds || 0, banner: !!p.banner, dist: Math.round(g.world?.distance ?? 0) });
      });
    }
    // pickup trail (item:pickup payloads are reused by the emitter: copy the fields). r6 verify: hooked once — installProbes
    // runs once per scenario (ui + play in --scenario all), and a second set of listeners listed every pickup and every
    // stored weapon twice; the listeners read window.__smoke at call time, so they feed the current scenario's arrays
    if (g && g.events && typeof g.events.on === 'function' && !window.__smokePickupHook) {
      window.__smokePickupHook = true;
      g.events.on('item:pickup', (p) => { const s = window.__smoke; if (p && s.pickups.length < 200) s.pickups.push({ t: Math.round((g.time?.levelTime ?? 0) * 10) / 10, item: String(p.item), duplicate: !!p.duplicate }); });
      g.events.on('level:start', () => { window.__smoke.pickups.length = 0; window.__smoke.stored.length = 0; });
      // round 6: stored-weapon trail
      g.events.on('weapon:stored', (p) => { const s = window.__smoke; if (p && s.stored.length < 200) s.stored.push({ t: Math.round((g.time?.levelTime ?? 0) * 10) / 10, id: String(p.id), slots: p.slots | 0 }); });
    }
    // r3 verify: the cap was 20 000 — at 144 Hz a run over 139 s (e.g. --endless --seconds 150) cleared every earlier interval and
    // reported frame stats for its last few seconds only; 200 000 intervals is 23 min at 144 Hz
    const tick = (now) => {
      const s = window.__smoke; const iv = now - s.last; s.intervals.push(iv); s.stamps.push(now); s.last = now; if (s.intervals.length > 200000) { s.intervals.length = 0; s.stamps.length = 0; }
      // round 7: report.perf — the engine's clamped frame clock (time.unscaledDt) against the real interval while playing
      // (iv > 0: with --scenario all installProbes runs twice and a second tick chain sees the same frame with iv 0)
      if (iv > 0 && g && g.state && typeof g.state.is === 'function' && g.state.is('playing') && g.time) {
        const P = s.perf;
        if (P.lt0 === null) { P.lt0 = g.time.levelTime; P.wall0 = now; } else { P.wall += iv; P.clock += (g.time.unscaledDt || 0) * 1000; P.frames++; }
        P.lt1 = g.time.levelTime; P.wall1 = now;
        const rs = g.quality ? g.quality.renderScale : null;
        if (typeof rs === 'number') { if (P.rsFirst === null) P.rsFirst = rs; P.rsLast = rs; if (rs < P.rsMin) P.rsMin = rs; if (rs > P.rsMax) P.rsMax = rs; }
      }
      // round 5: per-district maximum of the overlay's call split, and the program count, while a run is played
      const cs = g && g.render ? g.render.callStats : null;
      if (cs && g.state && typeof g.state.is === 'function' && g.state.is('playing')) {
        const id = (g.level && g.level.district && g.level.district.id) || '?';
        let m = s.callsMax[id];
        if (!m) m = s.callsMax[id] = { main: 0, shadow: 0, post: 0, total: 0, frames: 0 };
        if (cs.main > m.main) m.main = cs.main;
        if (cs.shadow > m.shadow) m.shadow = cs.shadow;
        if (cs.post > m.post) m.post = cs.post;
        if (cs.total > m.total) m.total = cs.total;
        m.frames++;
        const pr = g.render.renderer && g.render.renderer.info && g.render.renderer.info.programs ? g.render.renderer.info.programs.length : -1;
        if (pr >= 0) { if (pr < s.programs.min) s.programs.min = pr; if (pr > s.programs.max) s.programs.max = pr; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Bot: chooses the best gate lane for the current count and steers toward it via ctx.input.steerDx
    window.__bot = { on: false, choices: [] };
    const value = (l, c) => { const v = l.value ?? 0; if (l.op === '+' || l.op === '-') return Math.max(1, c + v); if (l.op === 'x') return c * v; if (l.op === '/') return l.flipped ? c * v : Math.ceil(c / Math.max(1, v)); return c * 1.15 + 2; };
    setInterval(() => {
      const b = window.__bot; if (!b.on || !g?.state?.is?.('playing')) return;
      try {
        const ev = g.gates?.activeEvent; const c = g.squad?.count ?? 1; let tx = 0;
        if (ev && ev.lanes && ev.lanes.length) {
          let best = null, bestV = -1;
          for (const l of ev.lanes) { if (!l) continue; const v = value(l, c); if (v > bestV) { bestV = v; best = l; } }
          if (best) { tx = best.x; if (b.lastEv !== ev.id) { b.lastEv = ev.id; b.choices.push(`${ev.lanes.map((l) => (l.op || '?') + (l.value ?? '')).join(' | ')} -> ${best.op}${best.value ?? ''} @x=${best.x} (C=${c})`); } }
        }
        const k = g.engine?.getSteerK?.() || 0.03;
        const cur = g.input?.targetX ?? 0;
        if (g.input) g.input.steerDx = (Math.max(-2.1, Math.min(2.1, tx)) - cur) / k;
      } catch (e) { b.err = String(e); }
    }, 100);
  });
}

async function snapshot() {
  return ev(() => {
    const g = window.__game; if (!g) return null;
    const r = g.render?.renderer?.info;
    return {
      t: Math.round((g.time?.levelTime ?? 0) * 10) / 10,
      state: g.state?.current, phase: g.level?.phase,
      dist: Math.round(g.world?.distance ?? 0), len: g.level?.script?.length ?? null,
      count: g.squad?.count, visible: g.squad?.visible, armor: g.squad?.armor,
      zombies: g.zombies?.alive, bullets: g.weapons?.liveBullets, weapon: g.weapons?.weapon, stored: g.weapons?.storedCount ?? null,
      gate: (() => { const e = g.gates?.activeEvent; return e ? e.lanes.map((l) => `${l.op}${l.value}${l.maxed ? '(MAX)' : ''}${l.state ? ':' + l.state : ''}`).join('|') : null; })(),
      boss: g.boss?.active ? `${Math.round(g.boss.hp)}/${Math.round(g.boss.maxHp)} p${g.boss.phase}` : null,
      coins: g.run?.coins, kills: g.run?.kills, troops: g.troops?.list?.join?.(',') || '',
      gear: g.weapons?.gear ? Object.keys(g.weapons.gear).join(',') : '',
      calls: r?.render?.calls, tris: r?.render?.triangles, tier: g.quality?.tier, scale: g.time?.scale,
      district: g.level?.district?.id ?? null,
      callsMain: g.render?.callStats?.main, callsShadow: g.render?.callStats?.shadow, callsPost: g.render?.callStats?.post,
      programs: r?.programs?.length,
      // round 7: render scale, backing store and the engine's sustained frame time
      rscale: g.quality?.renderScale ?? null, canvas: (() => { const c = document.getElementById('gl-canvas'); return c ? `${c.width}x${c.height}` : null; })(),
      sustainedMs: typeof g.engine?.sustainedFrameMs === 'number' ? Math.round(g.engine.sustainedFrameMs * 10) / 10 : null,
    };
  }).catch((e) => ({ snapshotError: String(e.message || e).slice(0, 300) }));
}

function frameStats(arr) {
  const a = arr.filter((x) => x > 0 && x < 1000).sort((x, y) => x - y);
  if (!a.length) return null;
  const pct = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  return { frames: a.length, meanMs: +mean.toFixed(2), p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2), worst: +a[a.length - 1].toFixed(1), fpsMean: +(1000 / mean).toFixed(1) };
}

// ---------------------------------------------------------------- UI scenario
async function clickId(id) {
  const ok = await ev((id) => { const el = document.getElementById(id); if (!el || el.hidden || el.disabled) return false; el.click(); return true; }, id);
  report.ui.push(`click #${id}: ${ok ? 'ok' : 'MISSING/HIDDEN'}`);
  await sleep(500);
  return ok;
}
async function visibleScreens() {
  return ev(() => [...document.querySelectorAll('.screen')].filter((s) => !s.hidden).map((s) => s.id));
}
async function runUi() {
  await installProbes();
  report.ui.push(`start screens: ${(await visibleScreens()).join(',')}`);
  await ev(() => { try { window.__game.save.addCoins(5000); } catch {} });
  await clickId('btn-shop'); report.ui.push(`shop -> ${(await visibleScreens()).join(',')}`); await shot('shop');
  const bought = await ev(() => { const b = document.querySelector('#shop-list .buy'); if (!b) return 'no buy button'; b.click(); return 'clicked buy'; });
  report.ui.push(`buy: ${bought}`); await sleep(500); await shot('shop-bought');
  await ev(() => document.querySelector('#scr-shop [data-back]')?.click()); await sleep(500);
  report.ui.push(`back -> ${(await visibleScreens()).join(',')}`);
  await clickId('btn-levels'); report.ui.push(`levels -> ${(await visibleScreens()).join(',')}`); await shot('levels');
  await ev(() => document.querySelector('#scr-levels [data-back]')?.click()); await sleep(500);
  await clickId('btn-settings'); report.ui.push(`settings -> ${(await visibleScreens()).join(',')}`); await shot('settings');
  await ev(() => document.querySelector('#scr-settings [data-back]')?.click()); await sleep(500);
  report.ui.push(`after settings back -> ${(await visibleScreens()).join(',')}`);
  await clickId('btn-play'); await sleep(1500);
  report.ui.push(`play -> state ${await ev(() => window.__game?.state?.current)} screens ${(await visibleScreens()).join(',')}`);
  await shot('play-start');
  await clickId('btn-pause'); report.ui.push(`pause -> state ${await ev(() => window.__game?.state?.current)}`); await shot('paused');
  await clickId('btn-resume'); report.ui.push(`resume -> state ${await ev(() => window.__game?.state?.current)}`);
  await sleep(800);
  await clickId('btn-pause'); await clickId('btn-quit');
  report.ui.push(`quit -> state ${await ev(() => window.__game?.state?.current)} screens ${(await visibleScreens()).join(',')}`);
  await shot('back-to-title');
}

// ---------------------------------------------------------------- play scenario
// round 6: the bot's FIRE press (see the header). Returns the press record, or null when nothing was pressed.
const FIRE_RANGE_M = 25;
async function botFire() {
  const st = await ev((R) => {
    const g = window.__game, w = g?.weapons, b = document.getElementById('btn-fire');
    if (!g || !w || !b || b.hidden || !window.__bot?.on || !g.state?.is?.('playing') || !w.canFire) return null;
    const sx = g.squad?.x ?? 0;
    let near = null;
    const out = { id: -1, x: 0, y: 0, z: 0 };
    if ((g.zombies?.alive ?? 0) > 0 && g.zombies.nearest(sx, 0, out) && Math.hypot(out.x - sx, out.z) <= R) near = 'zombie ' + Math.round(Math.hypot(out.x - sx, out.z)) + ' m';
    if (!near && g.boss?.active && Math.abs(g.boss.z ?? -1e9) <= R) near = 'boss ' + Math.round(Math.abs(g.boss.z)) + ' m';
    if (!near) return null;
    const r = b.getBoundingClientRect();
    // round 7: the frame time decides how long the press may take to start the weapon (it lands in ui.update, a frame later)
    const iv = window.__smoke ? window.__smoke.intervals : [];
    let sum = 0, n = 0; for (let i = Math.max(0, iv.length - 20); i < iv.length; i++) { if (iv[i] > 0 && iv[i] < 1000) { sum += iv[i]; n++; } }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), next: w.storedId(0), near, t: Math.round((g.time?.levelTime ?? 0) * 10) / 10, frameMs: n ? sum / n : 16.7 };
  }, FIRE_RANGE_M).catch(() => null);
  if (!st) return null;
  // (the sandbox shell's iframe fills the page at 0, 0, so frame coordinates are page coordinates in every shell)
  try {
    if (!DESKTOP) await page.touchscreen.tap(st.x, st.y);
    else await page.mouse.click(st.x, st.y);
  } catch (e) { return { t: st.t, weapon: st.next, near: st.near, started: false, error: String(e.message || e) }; }
  // round 7: 500 ms, or 10 frames on a slow (software-GL) frame rate, for the press to start the weapon
  const waitMs = Math.max(500, Math.round(10 * st.frameMs));
  const started = await gameFrame.waitForFunction((id) => window.__game?.weapons?.weapon === id, { timeout: waitMs, polling: 16 }, st.next).then(() => true, () => false);
  return { t: st.t, weapon: st.next, near: st.near, at: [Math.round(st.x), Math.round(st.y)], size: st.w, started, waitMs };
}

async function realDrag() {
  // exercises the real input path: touch on #app, drag right 120 px, release
  const before = await ev(() => window.__game?.input?.targetX ?? null);
  const vp = page.viewport();
  const x = vp.width / 2, y = vp.height * 0.6;
  try {
    if (!DESKTOP) {
      await page.touchscreen.touchStart(x, y);
      for (let i = 1; i <= 8; i++) { await page.touchscreen.touchMove(x + i * 15, y); await sleep(16); }
      await page.touchscreen.touchEnd();
    } else {
      await page.mouse.move(x, y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(x + i * 15, y); await sleep(16); }
      await page.mouse.up();
    }
  } catch (e) { report.input = { error: String(e.message || e) }; return; }
  await sleep(250);
  const after = await ev(() => window.__game?.input?.targetX ?? null);
  const audio = await ev(() => ({ unlocked: window.__game?.audio?.unlocked ?? null }));
  report.input = { targetXBefore: before, targetXAfter: after, steered: after !== before, audioUnlocked: audio.unlocked };
}

async function runPre() {
  if (!PRE) return;
  const r = await ev((code) => { try { const g = window.__game; const v = new Function('g', code)(g); return 'ok ' + String(v ?? ''); } catch (e) { return 'PRE ERROR ' + (e.stack || e); } }, String(PRE));
  report.preResult = r;
}
async function runPlay(level) {
  await installProbes();
  await runPre();
  const startMark = await ev(() => performance.now());
  if (ENDLESS) await ev(() => window.__game.level.startEndless());
  else {
    // round 5: levels start the way the menus start them — level.requestStart (a memo miss generates in frame slices
    // first, so the run may begin a few frames later; older builds: start()); the harness waits for the run
    await ev((L) => { const lv = window.__game.level; if (typeof lv.requestStart === 'function') lv.requestStart(L); else lv.start(L); }, level);
    await gameFrame.waitForFunction(() => { const g = window.__game; return !!(g && g.state && g.state.current === 'playing'); }, { timeout: 20000, polling: 50 }).catch(() => {});
  }
  if (AFTER) {
    await sleep(200);
    report.afterResult = await ev((code) => { try { const g = window.__game; const v = new Function('g', code)(g); return 'ok ' + String(v ?? ''); } catch (e) { return 'AFTER ERROR ' + (e.stack || e); } }, String(AFTER));
  }
  if (BOSS) {
    await sleep(300);
    report.bossJump = await ev(() => {
      const g = window.__game; const len = g.level?.script?.length ?? 0;
      if (!len || !g.world) return 'no script length';
      // fire every scripted event up to the run-up quickly by moving the distance cursor; level.step spawns them
      g.world.distance = Math.max(g.world.distance, len - 20);
      return 'distance -> ' + g.world.distance;
    });
  }
  await sleep(600);
  await realDrag();
  if (!NOBOT) await ev(() => { window.__bot.on = true; });
  // round 5: the intervals are kept from the start call on (report.startFrames); `frames` still begins here
  const playT0 = await ev(() => performance.now());
  const start = Date.now();
  let nextShot = 1000, nextSnap = 0;
  let ended = null;
  // round 5: an endless district rotation (district:change 'rotate') gets screenshots 0.6 / 1.8 / 2.8 / 4.6 s after it is
  // seen — the 4 s cross-fade (swap dip at 45–55 %) and its end — whatever the --shots cadence
  let seenRot = 0, nextRotCheck = 0;
  const fadeShots = [];
  while (Date.now() - start < SECONDS * 1000) {
    const el = Date.now() - start;
    if (el >= nextSnap) { const s = await snapshot(); if (s) report.timeline.push(s); nextSnap += 2000; if (s && (s.state === 'complete' || s.state === 'gameover')) { ended = s.state; break; } }
    if (el >= nextRotCheck) {
      nextRotCheck = el + 250;
      const n = await ev(() => window.__smoke.districts.filter((d) => d.reason === 'rotate').length).catch(() => seenRot);
      if (n > seenRot) { seenRot = n; for (const dt of [600, 1800, 2800, 4600]) fadeShots.push({ at: el + dt, tag: `fade${n}-${(dt / 1000).toFixed(1)}s` }); }
    }
    while (fadeShots.length && el >= fadeShots[0].at) { const f = fadeShots.shift(); await shot(f.tag); }
    if (el >= nextShot) { await shot(`play-${Math.round(el / 1000)}s`); nextShot += SHOT_EVERY * 1000; }
    // round 6: the bot fires a stored weapon when zombies / the boss are within 25 m (a real tap on #btn-fire)
    if (!NOBOT) { const f = await botFire(); if (f) { report.fire.presses.push(f); if (!f.started) report.checkFailures.push(`FIRE press at t=${f.t} did not start ${f.weapon}`); } }
    // capture the boss as soon as it appears
    await sleep(200);
  }
  const sampledAll = await ev(() => ({ iv: window.__smoke.intervals.slice(), st: window.__smoke.stamps.slice() }));
  // round 5: the level.start() frame and the first 2 s after the call (the start frame included; screenshot stalls excluded)
  {
    const sv = [];
    for (let i = 0; i < sampledAll.iv.length; i++) {
      const end = sampledAll.st[i], start = end - sampledAll.iv[i];
      if (end <= startMark || start >= startMark + 2000) continue;
      if (shotWindows.some(([a, b]) => start < b + 20 && end > a)) continue;
      sv.push({ atS: +((end - startMark) / 1000).toFixed(3), ms: +sampledAll.iv[i].toFixed(1) });
    }
    report.startFrames = { frames: sv.length, worst: sv.reduce((m, x) => Math.max(m, x.ms), 0), over50: sv.filter((x) => x.ms > 50), first: sv.slice(0, 3) };
  }
  const sampled = { iv: [], st: [] };
  for (let i = 0; i < sampledAll.iv.length; i++) if (sampledAll.st[i] >= playT0) { sampled.iv.push(sampledAll.iv[i]); sampled.st.push(sampledAll.st[i]); }
  const intervals = sampled.iv;
  // drop the intervals that overlap a screenshot (the harness's own ≈ 250 ms compositor stall, not the game's)
  const kept = [];
  for (let i = 0; i < intervals.length; i++) {
    const end = sampled.st[i], start = end - intervals[i];
    if (!shotWindows.some(([a, b]) => start < b + 20 && end > a)) kept.push(intervals[i]);
  }
  report.frames = frameStats(kept);
  report.framesRaw = frameStats(intervals);
  report.shotStallsExcluded = intervals.length - kept.length;
  // round 7: game clock vs real time while playing, render scale (see the header)
  {
    const p = await ev(() => {
      const g = window.__game, P = window.__smoke.perf, c = document.getElementById('gl-canvas');
      return { P, tier: g.quality?.tier ?? null, software: g.quality?.software ?? null, auto: g.quality?.auto ?? null,
        sustainedMs: typeof g.engine?.sustainedFrameMs === 'number' ? g.engine.sustainedFrameMs : null, canvas: c ? `${c.width}x${c.height} css ${c.clientWidth}x${c.clientHeight}` : null };
    }).catch(() => null);
    if (p && p.P) {
      const P = p.P, wallS = (P.wall1 - (P.wall0 ?? P.wall1)) / 1000;
      report.perf = {
        gpu: GPU, tier: p.tier, software: p.software, auto: p.auto,
        clockRatio: P.wall > 0 ? +(P.clock / P.wall).toFixed(3) : null,
        gameRatio: wallS > 0 ? +((P.lt1 - (P.lt0 ?? P.lt1)) / wallS).toFixed(3) : null,
        fps: wallS > 0 ? +(P.frames / wallS).toFixed(1) : null, playingFrames: P.frames, playingWallS: +wallS.toFixed(1),
        sustainedFrameMs: p.sustainedMs !== null ? +p.sustainedMs.toFixed(1) : null,
        renderScale: { first: P.rsFirst, last: P.rsLast, min: P.rsMin === 9 ? null : P.rsMin, max: P.rsMax || null },
        scaleChanges: P.scale, canvas: p.canvas,
      };
    }
  }
  // diagnostics: every kept interval > 50 ms with its end time (s since play start) and the screenshot windows
  report.longFrames = [];
  for (let i = 0; i < intervals.length; i++) {
    const end = sampled.st[i], start = end - intervals[i];
    if (intervals[i] > 50 && intervals[i] < 1000 && !shotWindows.some(([a, b]) => start < b + 20 && end > a)) report.longFrames.push({ atS: +((end - playT0) / 1000).toFixed(2), ms: +intervals[i].toFixed(1) });
  }
  report.shotWindowsS = shotWindows.filter(([a]) => a >= playT0).map(([a, b]) => [+((a - playT0) / 1000).toFixed(2), +((b - playT0) / 1000).toFixed(2)]);
  // round 5: district changes (with the worst kept frame over each fade + 1 s), per-district call maxima, programs
  {
    const extra = await ev(() => ({ d: window.__smoke.districts.slice(), c: window.__smoke.callsMax, p: window.__smoke.programs, k: window.__smoke.peaks }));
    report.callsPeak = {};
    for (const [id, pk] of Object.entries(extra.k || {})) {
      const by = {};
      for (const x of pk.list) if (x.startsWith('M ')) by[x.slice(2)] = (by[x.slice(2)] || 0) + 1;
      report.callsPeak[id] = { main: pk.main, shadow: pk.shadow, post: pk.post, t: pk.t, zombies: pk.zombies, boss: pk.boss, mainObjects: by };
    }
    report.districts = extra.d.map((x) => {
      const t1 = x.t + (x.seconds + 1) * 1000;
      let worst = 0;
      for (let i = 0; i < sampledAll.iv.length; i++) {
        const end = sampledAll.st[i], start = end - sampledAll.iv[i];
        if (end <= x.t || start >= t1) continue;
        if (shotWindows.some(([a, b]) => start < b + 20 && end > a)) continue;
        if (sampledAll.iv[i] < 1000 && sampledAll.iv[i] > worst) worst = sampledAll.iv[i];
      }
      return { atS: +((x.t - playT0) / 1000).toFixed(2), id: x.id, reason: x.reason, seconds: x.seconds, banner: x.banner, dist: x.dist, maxFrameMs: +worst.toFixed(1) };
    });
    report.callsMax = extra.c;
    report.programs = extra.p.max > 0 ? extra.p : null;
  }
  report.bot = await ev(() => ({ choices: window.__bot.choices, err: window.__bot.err || null }));
  report.pickups = await ev(() => window.__smoke.pickups.slice());
  report.fire.stored = await ev(() => window.__smoke.stored.slice());
  await sleep(ended ? 3500 : 0);
  const fin = await snapshot();
  report.result = {
    ended: ended || 'timeout', final: fin,
    screens: await visibleScreens(),
    completeText: await ev(() => document.getElementById('scr-complete')?.hidden === false ? document.getElementById('scr-complete').innerText.replace(/\s+/g, ' ').slice(0, 300) : null),
    gameoverText: await ev(() => document.getElementById('scr-gameover')?.hidden === false ? document.getElementById('scr-gameover').innerText.replace(/\s+/g, ' ').slice(0, 300) : null),
    save: await ev(() => { const d = window.__game?.save?.data; return d ? { coins: d.coins, highestUnlocked: d.highestUnlocked, levels: d.levels } : null; }),
  };
  await shot('result');
}

// ---------------------------------------------------------------- results → HOME (round 4)
// r4-ui needsOtherGroup 2: the results screens carry a HOME icon (#btn-complete-home / #btn-home / #btn-endless-home,
// top-left). After the played level, `--scenario all` taps the visible one for real — touch on the phone viewport, mouse
// with --desktop, at its centre (offset by the iframe in the sandbox shell) — and expects the button to win the hit test,
// ui:button to carry its id, and the title within 3 s. A run that never reached a results screen skips the step; a
// results screen without a visible HOME fails it.
async function runHome() {
  const target = await ev(() => {
    const pairs = [['scr-complete', 'btn-complete-home'], ['scr-gameover', 'btn-home'], ['scr-endless', 'btn-endless-home']];
    for (const [scrId, id] of pairs) {
      const scr = document.getElementById(scrId);
      if (!scr || scr.hidden) continue;
      const el = document.getElementById(id);
      const r = el && scr.contains(el) ? el.getBoundingClientRect() : null;
      if (!r || !(r.width > 0 && r.height > 0)) return { screen: scrId, id, missing: true };
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hitEl = document.elementFromPoint(cx, cy);
      const hitBtn = hitEl ? hitEl.closest('button') : null;
      return { screen: scrId, id, x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), hit: hitBtn ? hitBtn.id : (hitEl ? hitEl.id || hitEl.tagName : null) };
    }
    return null;
  }).catch((e) => ({ evalError: String(e.message || e) }));
  if (!target || target.evalError) { report.ui.push(`home: skipped (${target ? target.evalError : 'no results screen visible'})`); return; }
  if (target.missing) { report.checkFailures.push(`home: #${target.screen} is shown without a visible #${target.id}`); return; }
  const off = SHELL === 'sandbox'
    ? await page.evaluate(() => { const f = document.getElementById('f'); const r = f ? f.getBoundingClientRect() : null; return r ? { x: r.left, y: r.top } : { x: 0, y: 0 }; }).catch(() => ({ x: 0, y: 0 }))
    : { x: 0, y: 0 };
  const x = off.x + target.x, y = off.y + target.y;
  await ev(() => {
    const s = window.__smoke; const g = window.__game;
    s.buttons = [];
    if (!s.buttonProbe && g && g.events && typeof g.events.on === 'function') { s.buttonProbe = true; g.events.on('ui:button', (p) => { if (s.buttons.length < 16) s.buttons.push(String(p && p.id)); }); }
  });
  try {
    if (DESKTOP) await page.mouse.click(x, y);
    else await page.touchscreen.tap(x, y);
  } catch (e) { report.checkFailures.push(`home: the tap on #${target.id} threw: ${String(e.message || e).slice(0, 200)}`); return; }
  let state = null;
  for (let i = 0; i < 30 && state !== 'title'; i++) { await sleep(100); state = await ev(() => window.__game?.state?.current ?? null).catch(() => null); }
  const screens = await visibleScreens();
  const buttons = await ev(() => (window.__smoke.buttons || []).slice()).catch(() => []);
  report.home = { id: target.id, rect: [target.w, target.h], at: [Math.round(x), Math.round(y)], hit: target.hit, state, screens, buttons, input: DESKTOP ? 'mouse' : 'touch' };
  report.ui.push(`home: tap #${target.id} (hit ${target.hit}) -> state ${state} screens ${screens.join(',')} ui:button ${buttons.join(',') || 'none'}`);
  if (target.hit !== target.id || state !== 'title' || screens.indexOf('scr-title') === -1 || buttons.indexOf(target.id) === -1) {
    report.checkFailures.push(`home: tap on #${target.id} (hit test ${target.hit}) -> state ${state}, screens ${screens.join(',')}, ui:button ${buttons.join(',') || 'none'}`);
  }
  await sleep(1200);
  await shot('home');
}

try {
  if (SCENARIO === 'ui' || SCENARIO === 'all') { await runPre(); await runUi(); }
  if (SCENARIO === 'play' || SCENARIO === 'all') await runPlay(LEVEL);
  if (SCENARIO === 'all') await runHome();
} catch (e) {
  report.pageErrors.push('SMOKE HARNESS: ' + String(e.stack || e).slice(0, 800));
}
await finish();
