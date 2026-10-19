// sw.js — Gate Rush service worker (ARCHITECTURE §15.4). Standalone PWA shell only: index.html registers
// it (guarded); the artifact shell never does.
//
// Round 5 (r4-release §7 item 4): ONE CONSISTENT BUILD PER LAUNCH. The worker that controls a page serves every
// precached same-origin file from ITS OWN versioned cache, so a launch never mixes two builds (round 4 served code
// network-first: a slow first launch after a release could take one file from the network and the next from the old
// cache). A release reaches players like this:
//
//   • install   the new worker (new VERSION) pre-caches the WHOLE PRECACHE list into its own cache with
//               cache: 'reload' (bypassing the HTTP cache). Every file is mandatory: one failed file fails the install,
//               the old worker keeps serving the old build intact and the browser retries at its next update check.
//               It does NOT skipWaiting: it waits while any page of the old build is open. The CDN cache (three.js
//               r170, the Google Fonts CSS and font files) copies the previous version's entries forward and fetches
//               only what is missing (best effort), so the new worker is offline-ready the moment it takes over.
//   • takeover  (a) the next launch after every old page closed — the browser activates the waiting worker before it
//               serves the new navigation; or (b) the title's "Update ready — tap to reload" pill (js/ui.js): the page
//               posts { type: 'SKIP_WAITING' }, this worker activates and claims the page, and the page reloads on
//               controllerchange into the new build. Nothing is swapped under a running session.
//               The pill only shows when the waiting worker's build differs from the build the page runs: the page asks
//               it { type: 'GET_BUILD' } over a MessageChannel and this worker answers { type: 'BUILD', version, app }
//               (r5b: the 1.1.0 → 1.2.0 transition launch ran 1.2.0 through v3 and still offered "Update ready").
//   • activate  deletes every older `gaterush-*` cache and claims the open clients.
//   • fetch     same-origin GET:
//                 – a PRECACHE file → the active cache (cache-first); a file missing from it (storage eviction) comes
//                   from the network and is not written back (it might belong to another build);
//                 – navigations → the cached shell (index.html; query ignored, so ?level=… / ?debug=1 launch offline);
//                   other navigations (artifact.html, docs) → network, the cached shell when offline;
//                 – any other same-origin file → network, the cache as the offline fallback.
//               cdn.jsdelivr.net, fonts.googleapis.com, fonts.gstatic.com → stale-while-revalidate into the versioned
//               CDN cache (three is pinned to 0.170.0, so its files never change under a build). Everything else (and
//               every non-GET) goes straight to the network.
//
// RELEASE RULE: every release MUST change this file (bump VERSION). The browser only installs a new worker when sw.js
// differs byte for byte; with code served cache-first, a release that leaves sw.js unchanged would never reach an
// installed player.
//   v2 → v3: release 1.1.0 (round 4: HOME on the results screens, ÷ ladder hint, item icons, audio mix).
//   v3 → v4: release 1.2.0 (round 5: districts; consistent-build caching: cache-first from the active version, update
//            on the next launch or via the title pill). A v3 page keeps its network-first worker until v4 takes over.
//   v4 → v5: the round-5b build of 1.2.0 (boss rigs in 3 draws; GET_BUILD so the pill shows only for another build).
//            v4 shipped in the 1.2.0 dist/, so this build needs its own cache name (tools/package.js enforces it).
//   v5 → v6: release 1.2.1 (round 5d: endless numbers not HP, the mini-boss hold, pool-safe waves).
'use strict';

const VERSION = 'v6';
const APP_CACHE = 'gaterush-' + VERSION;          // §15.4 cache names gaterush-<VERSION> / gaterush-cdn-<VERSION>
const CDN_CACHE = 'gaterush-cdn-' + VERSION;
const CACHE_PREFIX = 'gaterush-';

// Explicit list (paths relative to this worker = the site root). Every file in js/ must appear here.
const PRECACHE = [
  './',
  './index.html',
  './css/game.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './js/main.js',
  './js/engine.js',
  './js/util.js',
  './js/data.js',
  './js/levelgen.js',
  './js/level.js',
  './js/render.js',
  './js/materials.js',
  './js/environment.js',
  './js/fxmaterials.js',
  './js/models.js',
  './js/squad.js',
  './js/troops.js',
  './js/zombies.js',
  './js/boss.js',
  './js/gates.js',
  './js/pickups.js',
  './js/weapons.js',
  './js/fx.js',
  './js/audio.js',
  './js/ui.js',
  './js/save.js',
];

// The three.js r170 files the game imports through the import map (three + the addons and their own
// relative imports). Warmed into the CDN cache at install so a second launch works fully offline even
// if the first one was interrupted; failures are ignored (the runtime stale-while-revalidate covers them).
const THREE_ROOT = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';
const CDN_PRECACHE = [
  THREE_ROOT + 'build/three.module.js',
  THREE_ROOT + 'examples/jsm/postprocessing/EffectComposer.js',
  THREE_ROOT + 'examples/jsm/postprocessing/RenderPass.js',
  THREE_ROOT + 'examples/jsm/postprocessing/UnrealBloomPass.js',
  THREE_ROOT + 'examples/jsm/postprocessing/OutputPass.js',
  THREE_ROOT + 'examples/jsm/postprocessing/ShaderPass.js',
  THREE_ROOT + 'examples/jsm/postprocessing/MaskPass.js',
  THREE_ROOT + 'examples/jsm/postprocessing/Pass.js',
  THREE_ROOT + 'examples/jsm/shaders/CopyShader.js',
  THREE_ROOT + 'examples/jsm/shaders/LuminosityHighPassShader.js',
  THREE_ROOT + 'examples/jsm/shaders/OutputShader.js',
  THREE_ROOT + 'examples/jsm/utils/BufferGeometryUtils.js',
  'https://fonts.googleapis.com/css2?family=Lilita+One&family=Nunito:wght@600;800&display=swap',
];

// Hosts served stale-while-revalidate (§15.4).
const SWR_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// Absolute URLs of the precached files (origin + pathname), resolved against this worker's location (= the scope).
const PRECACHE_URLS = new Set();
for (let i = 0; i < PRECACHE.length; i++) {
  try { PRECACHE_URLS.add(new URL(PRECACHE[i], self.location.href).href); } catch (_) { /* never */ }
}
// The shell that answers navigations (index.html, else the directory URL; both are in PRECACHE).
const SHELL = ['./index.html', './'];
const MATCH_OPTS = { ignoreVary: true };
const NAV_MATCH_OPTS = { ignoreSearch: true, ignoreVary: true };

// ---------------------------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------------------------

/**
 * Adds one URL to a cache, bypassing the HTTP cache so a release never pre-caches a stale file.
 * Resolves to true on success; never rejects.
 */
function addOne(cache, url, init) {
  let request;
  try { request = new Request(url, init); } catch (_) { return Promise.resolve(false); }
  return fetch(request)
    .then((response) => {
      // opaque responses (status 0) are acceptable for cross-origin warm-up only
      if (!response || (!response.ok && response.type !== 'opaque')) return false;
      return cache.put(url, response).then(() => true);
    })
    .catch(() => false);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    const results = await Promise.all(PRECACHE.map((url) => addOne(app, url, { cache: 'reload' })));
    // the build is one set: a worker that could not store every file must not take over (the old one keeps serving its
    // complete build; the browser retries the install at its next update check)
    const failed = [];
    for (let i = 0; i < results.length; i++) if (!results[i]) failed.push(PRECACHE[i]);
    if (failed.length) {
      try { await caches.delete(APP_CACHE); } catch (_) { /* ignore */ }
      throw new Error('gate-rush sw: precache incomplete (' + failed.join(', ') + ')');
    }
    try {
      const cdn = await caches.open(CDN_CACHE);
      // carry the previous version's CDN entries forward (three is pinned to one release and the fonts are immutable
      // URLs): the new worker is offline-ready the moment it takes over (activate deletes the old CDN cache), and the
      // install does not wait on jsdelivr for files the player already has
      const have = new Set();
      const keys = await caches.keys();
      for (let k = 0; k < keys.length; k++) {
        if (keys[k] === CDN_CACHE || keys[k].indexOf(CACHE_PREFIX + 'cdn-') !== 0) continue;
        const old = await caches.open(keys[k]);
        const reqs = await old.keys();
        for (let i = 0; i < reqs.length; i++) {
          if (have.has(reqs[i].url)) continue;
          const hit = await old.match(reqs[i]);
          if (hit) { await cdn.put(reqs[i], hit); have.add(reqs[i].url); }
        }
      }
      const missing = CDN_PRECACHE.filter((url) => !have.has(url));
      await Promise.all(missing.map((url) => addOne(cdn, url, { mode: 'cors', credentials: 'omit' })));
    } catch (_) { /* warm-up is best effort */ }
    // no skipWaiting(): a waiting worker takes over at the next launch, or when the page asks (SKIP_WAITING)
  })());
});

// Build identity (r5b). The page asks a waiting worker (and its own controller at boot) which build it holds:
// { type: 'GET_BUILD' } with a MessagePort; the answer on that port is { type: 'BUILD', version: VERSION, app } where
// `app` is the ctx.version of the build in THIS worker's cache, read from its cached js/main.js (`const VERSION = '…'`,
// ARCHITECTURE §3), so the release keeps one version string; null when the cache cannot be read. js/ui.js shows the
// "Update ready" pill only when that build differs from the page's own. The v3 worker (1.1.0) never answers.
const APP_VERSION_RE = /\bconst\s+VERSION\s*=\s*['"]([^'"]+)['"]/;
let appVersion = null;   // memo: the build in this worker's cache never changes after install

async function buildInfo() {
  if (appVersion === null) {
    try {
      const hit = await (await caches.open(APP_CACHE)).match(new URL('./js/main.js', self.location.href).href, MATCH_OPTS);
      const m = hit ? APP_VERSION_RE.exec(await hit.text()) : null;
      if (m) appVersion = m[1];
    } catch (_) { /* cache storage unavailable: app stays unknown */ }
  }
  return { type: 'BUILD', version: VERSION, app: appVersion };
}

// The title's "Update ready" pill (js/ui.js) asks the waiting worker to take over now; the page then reloads. index.html's
// update heal (1.2.0 release, ARCHITECTURE §15.1) sends the same message when a launch fails to load while an update is
// pending, so every future sw.js must keep answering it — and GET_BUILD, which ui.js uses to decide on the pill.
self.addEventListener('message', (event) => {
  const data = event && event.data;
  if (!data) return;
  if (data.type === 'SKIP_WAITING') {
    try { event.waitUntil(self.skipWaiting()); } catch (_) { /* older engines */ }
    return;
  }
  if (data.type === 'GET_BUILD') {
    const port = event.ports && event.ports[0];
    if (!port) return;
    const reply = buildInfo().then((info) => { try { port.postMessage(info); } catch (_) { /* page gone */ } });
    try { event.waitUntil(reply); } catch (_) { /* older engines: the promise still runs */ }
  }
});

// ---------------------------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => {
        if (key.indexOf(CACHE_PREFIX) === 0 && key !== APP_CACHE && key !== CDN_CACHE) return caches.delete(key);
        return Promise.resolve(false);
      }));
    } catch (_) { /* cache storage unavailable: nothing to clean */ }
    try { if (self.registration && self.registration.navigationPreload) await self.registration.navigationPreload.disable(); } catch (_) { /* ignore */ }
    try { await self.clients.claim(); } catch (_) { /* ignore */ }
  })());
});

// ---------------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------------

async function cachedShell(cache) {
  for (let i = 0; i < SHELL.length; i++) {
    const hit = await cache.match(SHELL[i], MATCH_OPTS);
    if (hit) return hit;
  }
  return undefined;
}

/** A precached file: this version's copy; the network only when the cache lost it (not written back). */
async function fromBuild(request) {
  let cached;
  try { cached = await (await caches.open(APP_CACHE)).match(request, MATCH_OPTS); } catch (_) { cached = undefined; }
  return cached || fetch(request);
}

/** A navigation to the shell: the cached index.html (query ignored); the network if the cache has no shell. */
async function shellNavigation(request) {
  let cached;
  try {
    const cache = await caches.open(APP_CACHE);
    cached = (await cache.match(request, NAV_MATCH_OPTS)) || (await cachedShell(cache));
  } catch (_) { cached = undefined; }
  return cached || fetch(request);
}

/** Anything else same-origin: network, the cache as the offline fallback (navigations: the cached shell). */
async function networkWithFallback(event, request) {
  const isNavigation = request.mode === 'navigate';
  try {
    const response = await fetch(request);
    if (!isNavigation && response && response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined));
    }
    return response;
  } catch (err) {
    let cached;
    try {
      const cache = await caches.open(APP_CACHE);
      cached = await cache.match(request, isNavigation ? NAV_MATCH_OPTS : MATCH_OPTS);
      if (!cached && isNavigation) cached = await cachedShell(cache);
    } catch (_) { cached = undefined; }
    if (cached) return cached;
    throw err;
  }
}

/** CDN modules and fonts: answer from the cache at once, refresh it from the network in the background. */
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        const copy = response.clone();
        return cache.put(request, copy).catch(() => undefined).then(() => response);
      }
      return response;
    });
  if (cached) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  return network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!request || request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    const precached = PRECACHE_URLS.has(url.origin + url.pathname);   // precache identity: the path, never the query
    if (request.mode === 'navigate') {
      event.respondWith(precached ? shellNavigation(request) : networkWithFallback(event, request));
    } else if (precached && !url.search) {
      event.respondWith(fromBuild(request));
    } else {
      event.respondWith(networkWithFallback(event, request));
    }
    return;
  }
  if (SWR_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
  // any other origin: default network handling
});
