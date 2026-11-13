// js/crowd.js — ctx.crowd, the Horde crowd engine (PLAN horde part 2; P4 on the P0 skeleton): simulation, rendering, hit
// tests (a weapons target provider) and batched kill events for thousands of zombies at a barricade. Inactive (step / render
// return at once, meshes hidden, nothing compiled) until a hold calls begin().
//
// SIMULATION (identical on every tier, ARCH §11): struct-of-arrays pool (CROWD.slots; the feed keeps ≤ feedCap alive, boss
// bursts may use the reserve), ids `(gen << 12) | slot`, a time-ordered spawn queue whose units WAIT while the cap is full
// (ctx.debug.dropped['crowd.wait'] counts each once). One cadence: a 30 Hz tick over two 60 Hz steps. Phase A frees finished
// deaths, feeds due units into the band, counting-sorts the 1 m grid and separates (half-shell); phase B steers, integrates,
// clamps (funnel, wall), runs the RULES, packs the drawn units nearest first and emits crowd:kills. Seeded streams per hold
// (gameplay: feed, speed jitter, spawnSurge; looks: variant, gait, phase); gore draws ctx.rngFx.
// RULES (setRules; called inside phase B with direct SoA access, every member optional): begin(dt) / end(dt); wallZ(x) the
//   barrier line; onWall(i) a WALK / WALL unit held there; onClimb(i) / onBreach(i) a CLIMB / PASS unit after it moved;
//   onReach(i) one at reachZ (no rule: it bites and dies); spitHold(i) a walking spitter past spitZ; onHold(i) a HOLD unit;
//   numbers reachZ / spitZ. Rules write mode / tx / tm / aw / z and call kill(i, cause) / remove(i) (i = slot).
// PROVIDER (weapons.addTarget at begin): alive, hitTestSeg (per-column front cache), applyHit (pierce down the 1 m column),
//   damageInCircle / Line / Cone, nearest, nearestOfType, highestHp, densestCell; crawlers stay under the bullets to hitZ.
// RENDERING (only what is drawn varies, CROWD.tiers): one RGBA32F data texture (2 texels per drawn unit, 64 KB a tick) read by
//   texelFetch and extrapolated; nearest first up to the governed cap, living units ≤ 1 − dyingReserve of it (A13(b)). LOD0
//   the run walker reshaped per type (High casts through a customDepthMaterial), LOD1 a 64-tri body, LOD2 an impostor; the
//   last xfade LOD0 slots share texels with LOD1 at complementary Bayer coverage. Lights every frame, view fill, scalar
//   palette uniforms with a select, HDR eyes only near the wall, body ≤ bodyMax, flash cool-down, crumple. Carpet (its front
//   meets the farthest drawn unit when the cap binds), gore ring, pierce streaks. 7 programs on High (6 elsewhere) compile in
//   prepare() via render.addWarmable, never at boot; a tier change never reallocates.
// GOVERNOR: reference = median frame interval of the last refS s before the hold, never below the engine's frame target (a
//   90 / 120 Hz panel holding 60 fps is on target, as for the auto-scaler); slow frames step the drawn cap down to the tier
//   floor, fast ones back up ('crowd:governor', also at a tier change); engine.scalerGuard gets the crowd's step ms and
//   dropOk at the floor. FLEE (flee(): the hold is won): no weapon target, no coin, no bite, no further spawn.
// Events (reused payloads): crowd:kills { n, coins, x, z }, crowd:governor { cap, living, floor, ref }. Hot paths allocate nothing.
import {
  InstancedBufferGeometry, InstancedBufferAttribute, BufferAttribute, Mesh, Group, ShaderMaterial, UniformsLib, UniformsUtils,
  Color, Vector2, Vector3, Vector4, DynamicDrawUsage, AdditiveBlending, PlaneGeometry, DataTexture, RGBAFormat, FloatType,
  NearestFilter, DoubleSide, PerspectiveCamera,
} from 'three';
import { Rng, warnOnce } from './util.js';
import { CROWD, ZOMBIES, FIRE } from './data.js';

const F = CROWD.field, G = CROWD.grid, ST = CROWD.steer, GOV = CROWD.governor, RD = CROWD.render;
const GCOLS = G.x1 - G.x0, GROWS = G.z1 - G.z0, NCELLS = GCOLS * GROWS, CAP = CROWD.slots, QCAP = CROWD.queueCap;
const R = CROWD.radius, D2MIN = 4 * R * R, SEP_ROW0 = Math.max(0, Math.floor(CROWD.sep.zMin - G.z0));
const S_FREE = 0, S_ALIVE = 1, S_DYING = 2;
const MODE = Object.freeze({ WALK: 0, WALL: 1, CLIMB: 2, PASS: 3, HOLD: 4, FLEE: 5 });
const M_WALK = 0, M_CLIMB = 2, M_PASS = 3, M_HOLD = 4, M_FLEE = 5;
const ID_BITS = 12, ID_MASK = (1 << ID_BITS) - 1, GEN_MASK = 0x7FFFF;
const PAD = 0.3;                                       // grid lists are a tick old: a unit moves ≤ 0.25 m per tick
const TEX_W = 1024, TEX_ROWS = Math.ceil(2 * CROWD.tiers.high.cap / TEX_W);
const TYPES = ZOMBIES.common.types, NT = TYPES.length, TYPE_INDEX = {};
const SPEED = new Float32Array(NT), HITR = new Float32Array(NT), HEIGHT = new Float32Array(NT);
let MAX_HITR = 0;
for (let t = 0; t < NT; t++) {
  const u = CROWD.units[TYPES[t]];
  TYPE_INDEX[TYPES[t]] = t; SPEED[t] = u.speed; HITR[t] = u.hitR; HEIGHT[t] = u.height;
  if (u.hitR > MAX_HITR) MAX_HITR = u.hitR;
}
const T_CRAWLER = TYPE_INDEX.crawler, T_SPITTER = TYPE_INDEX.spitter, CRAWL = CROWD.units.crawler;
const HIT_Z = CRAWL.hitZ, LUNGE_Z = F.wallZ - CRAWL.lunge[0] - 0.5, LUNGE_V = CRAWL.lunge[1], BULLET_Y = FIRE.bullet.y;

/** Funnel half-width at z (wall → throat → wing walls → street). */
function halfAt(z) {
  if (z >= F.throatZ) return F.wallHalf;
  if (z >= F.funnelZ) return F.wallHalf + (F.streetHalf - F.wallHalf) * (F.throatZ - z) / (F.throatZ - F.funnelZ);
  return F.streetHalf;
}
const colOf = (x) => { const c = Math.floor(x - G.x0); return c < 0 ? 0 : (c >= GCOLS ? GCOLS - 1 : c); };
const rowOf = (z) => { const r = Math.floor(z - G.z0); return r < 0 ? 0 : (r >= GROWS ? GROWS - 1 : r); };
const nowMs = () => performance.now();
const P_KILLS = { n: 0, coins: 0.5, x: 0.5, z: 0.5 };
const P_GOV = { cap: 0, living: 0, floor: 0, ref: 0.5 };
const _c = new Color(), _v = new Vector3();

// ------------------------------------------------------------------------------------------------ geometry (prepare only)
/** Box faces (bit f: axis f >> 1, + when f is even) into B, rotated about X by rot at rp; part / pivot / material. */
function pushBox(B, w, h, d, cx, cy, cz, faces, part, piv, mat, rot, rp) {
  const hs = [w / 2, h / 2, d / 2], c = Math.cos(rot || 0), s = Math.sin(rot || 0), p = [0, 0, 0], n = [0, 0, 0];
  for (let f = 0; f < 6; f++) {
    if (!(faces & (1 << f))) continue;
    const ax = f >> 1, sg = f & 1 ? -1 : 1, u = (ax + 1) % 3, v = (ax + 2) % 3, base = B.pos.length / 3;
    n[0] = n[1] = n[2] = 0; n[ax] = sg;
    for (let k = 0; k < 4; k++) {
      p[ax] = sg * hs[ax]; p[u] = (k === 1 || k === 2 ? sg : -sg) * hs[u]; p[v] = (k > 1 ? 1 : -1) * hs[v];
      let y = p[1] + cy, z = p[2] + cz;
      if (rot) { const dy = y - rp[1], dz = z - rp[2]; y = rp[1] + c * dy - s * dz; z = rp[2] + s * dy + c * dz; }
      B.pos.push(p[0] + cx, y, z); B.nrm.push(n[0], c * n[1] - s * n[2], s * n[1] + c * n[2]); B.piv.push(piv[0], piv[1], piv[2], part); B.mat.push(mat);
    }
    B.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
/** The ground disc (part 9, material 4: the contact shadow of every unit that casts no shadow) and the finished geometry. */
function finish(B) {
  const base = B.pos.length / 3;
  for (let i = 0; i <= 8; i++) {
    const a = ((i - 1) / 8) * Math.PI * 2;
    B.pos.push(i ? Math.cos(a) * 0.36 : 0, 0.012, i ? Math.sin(a) * 0.3 : 0); B.nrm.push(0, 1, 0); B.piv.push(0, 0, 0, 9); B.mat.push(4);
    if (i) B.idx.push(base, base + 1 + (i % 8), base + i);
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(B.pos), 3)); g.setAttribute('normal', new BufferAttribute(new Float32Array(B.nrm), 3));
  g.setAttribute('aPiv', new BufferAttribute(new Float32Array(B.piv), 4)); g.setAttribute('aMat', new BufferAttribute(new Float32Array(B.mat), 1));
  g.setIndex(new BufferAttribute(new Uint16Array(B.idx), 1));
  return g;
}
// Both LODs share one layout: aPiv = (limb pivot, part), aMat = 0 skin, 1 shirt, 2 pants / hair, 3 eye, 4 disc. No face points
// down: the hold camera never sees one (−16 % of LOD0's vertices).
/** LOD1: the 64-tri walker body facing −Z like the class models (legs 1/2, torso 0, arms 3/4, head 5 + eyes, disc 9). */
function buildBody() {
  const B = { pos: [], nrm: [], piv: [], mat: [], idx: [] }, leg = 0.72, tH = 0.52, hunch = -0.3, arm = 0.58;
  for (let s = -1; s <= 1; s += 2) pushBox(B, 0.15, leg, 0.17, s * 0.11, leg / 2, 0, 51, s < 0 ? 1 : 2, [s * 0.11, leg, 0], 2);
  pushBox(B, 0.36, tH, 0.24, 0, leg + tH / 2, 0, 55, 0, [0, leg, 0], 1, hunch, [0, leg, 0]);
  const ch = Math.cos(hunch), sh = Math.sin(hunch), shY = leg + (tH - 0.05) * ch, shZ = (tH - 0.05) * sh;
  for (let s = -1; s <= 1; s += 2) pushBox(B, 0.11, arm, 0.11, s * 0.235, shY - arm / 2, shZ, 51, s < 0 ? 3 : 4, [s * 0.235, shY, shZ], 0);
  const ny = leg + tH * ch, nz = tH * sh, hy = ny + 0.14, hz = nz - 0.03;
  pushBox(B, 0.22, 0.24, 0.24, 0, hy, hz, 55, 5, [0, ny, nz], 0);
  for (let s = -1; s <= 1; s += 2) pushBox(B, 0.055, 0.04, 0.001, s * 0.055, hy + 0.03, hz - 0.122, 32, 5, [0, ny, nz], 3);
  return finish(B);
}
/** LOD0's source: the run walker's class geometry in that layout (the material from its vertex colour and piece tag), its
 *  down-facing triangles dropped and the vertices compacted; userData.hip = the legs' pivot height. */
function lod0Source(src) {
  const A = src.attributes, P = A.position.array, N = A.normal.array, C = A.color.array, PT = A.aPart.array, PV = A.aPivot.array, si = src.index.array;
  const B = { pos: [], nrm: [], piv: [], mat: [], idx: [] }, map = new Int32Array(A.position.count).fill(-1);
  let hip = 0.79;
  for (let t = 0; t < si.length; t += 3) {
    if (N[si[t] * 3 + 1] < -0.9 && N[si[t + 1] * 3 + 1] < -0.9 && N[si[t + 2] * 3 + 1] < -0.9) continue;
    for (let k = 0; k < 3; k++) {
      const v = si[t + k];
      if (map[v] < 0) {
        const part = PT[v], q = Math.floor(part + 0.01);
        map[v] = B.pos.length / 3;
        if (q === 1) hip = PV[v * 3 + 1];
        B.pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); B.nrm.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
        B.piv.push(PV[v * 3], PV[v * 3 + 1], PV[v * 3 + 2], q);
        B.mat.push(part - q > 0.25 ? 3 : (C[v * 3 + 1] > 0.15 ? 0 : ((q > 0.5 && q < 2.5) || q > 4.5 ? 2 : 1)));
      }
      B.idx.push(map[v]);
    }
  }
  const g = finish(B);
  g.userData.hip = hip;
  return g;
}
/** K copies of a geometry in one buffer, aCopy = the copy index (one instance draws K units). */
function mergeK(src, K, names) {
  const nv = src.attributes.position.count, g = new InstancedBufferGeometry(), si = src.index.array, ni = si.length;
  for (const name of names) {
    const a = src.attributes[name], it = a.itemSize, out = new Float32Array(nv * it * K);
    for (let k = 0; k < K; k++) out.set(a.array.subarray(0, nv * it), k * nv * it);
    g.setAttribute(name, new BufferAttribute(out, it));
  }
  const cp = new Float32Array(nv * K), idx = nv * K > 65535 ? new Uint32Array(ni * K) : new Uint16Array(ni * K);
  for (let k = 0; k < K; k++) { cp.fill(k, k * nv, (k + 1) * nv); for (let i = 0; i < ni; i++) idx[k * ni + i] = si[i] + k * nv; }
  g.setAttribute('aCopy', new BufferAttribute(cp, 1)); g.setIndex(new BufferAttribute(idx, 1)); g.instanceCount = 0;
  return g;
}

// ------------------------------------------------------------------------------------------------ shaders
// look = variant (2 bits) | gait << 2 (4) | bright << 6 (4) | type << 10 (3) | fade << 13 (4: 15 = all LOD0, 0 = all LOD1).
// Model space faces −Z (class models): + swing = forward; per type uG (gait Hz × 2, leg, arm), uP (arm rest, bob, crawler
// pitch, lift), uS (scale xyz).
const uni = (type, names) => names.split(' ').map((n) => `uniform ${type} ${n};`).join(' ');
const DECODE = /* glsl */`
attribute float aCopy;
uniform highp sampler2D uData;
${uni('int', 'uBase uN uNoDisc')} ${uni('float', 'uTime uSince uDeathS uFlash uBodyMax uSac uHip')} ${uni('vec4', 'uEyeZ')} ${uni('vec2', 'uEyeK')}
${uni('vec3', 'uSunDir uSunCol uSky uGround uFill uEye uSk0 uSk1 uSk2 uSk3 uSh0 uSh1 uSh2 uSh3 uPa0 uPa1 uPa2 uPa3 uRunSk uRunSh uBruSk uBruCl uSpiSk uSpiSac')}
${uni('vec4', 'uG0 uG1 uG2 uG3 uG4 uP0 uP1 uP2 uP3 uP4 uS0 uS1 uS2 uS3 uS4')}
vec4 iPos; vec4 iDat; vec2 grXZ; float grDeath; float grBright; float grFade; float grW; float grFlash; float grK; float grBlock;
int grVar; int grType; vec4 grG; vec4 grP; vec4 grS;
bool grFetch() {
  int i = gl_InstanceID * GR_K + int(aCopy);
  if (i >= uN) return false;
  int t = (uBase + i) * 2;
  iPos = texelFetch(uData, ivec2(t & 1023, t >> 10), 0); iDat = texelFetch(uData, ivec2((t + 1) & 1023, (t + 1) >> 10), 0);
  return true;
}
vec3 grSel4(int v, vec3 a, vec3 b, vec3 c, vec3 d) { return v < 1 ? a : (v < 2 ? b : (v < 3 ? c : d)); }
vec4 grSel5(int v, vec4 a, vec4 b, vec4 c, vec4 d, vec4 e) { return v < 1 ? a : (v < 2 ? b : (v < 3 ? c : (v < 4 ? d : e))); }
void grDecode() {
  vec2 vel = iPos.zw;
  grXZ = iPos.xy + vel * uSince;
  grDeath = iDat.z >= 0.0 ? clamp((uTime - iDat.z) / uDeathS, 0.0, 1.0) : 0.0;
  int L = int(iDat.y + 0.5);
  grVar = L & 3; grType = (L >> 10) & 7; grBright = 0.82 + 0.024 * float((L >> 6) & 15); grFade = float((L >> 13) & 15) / 15.0;
  grG = grSel5(grType, uG0, uG1, uG2, uG3, uG4); grP = grSel5(grType, uP0, uP1, uP2, uP3, uP4); grS = grSel5(grType, uS0, uS1, uS2, uS3, uS4);
  grW = (uTime * mix(grG.x, grG.y, float((L >> 2) & 15) / 15.0) + iDat.x) * 6.2831853;
  float spd = length(vel);
  grK = 0.55 + 0.45 * clamp(spd / 3.0, 0.0, 1.0); grBlock = 1.0 - clamp(spd / 1.5, 0.0, 1.0);
  grFlash = iDat.z >= 0.0 ? 0.0 : clamp(1.0 - (uTime - iDat.w) * 16.0, 0.0, 1.0);
}
vec3 grRotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z); }
// limb swing, arms raised while blocked at the wall, bob, type scale, crawler pitch about the hip, crumple (upright normal)
void grPose(float p, vec3 piv, inout vec3 q, inout vec3 n) {
  float sw = sin(grW), a = 0.0;
  if (p > 0.5 && p < 2.5) a = (p < 1.5 ? 1.0 : -1.0) * grG.z * sw * grK;
  else if (p > 2.5 && p < 4.5) a = grP.x + 0.5 * grBlock + (p < 3.5 ? -1.0 : 1.0) * grG.w * sw * grK;
  else if (p > 4.5 && p < 7.5) a = 0.06 * sin(2.0 * grW) * grK;
  if (a != 0.0) { q = piv + grRotX(q - piv, a); n = grRotX(n, a); }
  if (p < 8.5) {
    if (p < 0.5 || p > 2.5) q.y += grP.y * abs(sw) * grK;
    q *= grS.xyz; n = normalize(n / grS.xyz);
    if (grP.z > 0.0) { vec3 h = vec3(0.0, uHip * grS.y, 0.0); q = h + grRotX(q - h, -grP.z); n = grRotX(n, -grP.z); q.y -= grP.w; }
  } else q.xz *= grS.xz;
  float d = grDeath;
  if (d > 0.0) {
    float tp = min(d * 1.7, 1.0);
    if (p < 8.5) { q = grRotX(q, 0.45 * tp); q.y *= 1.0 - 0.7 * tp; } else q.xz *= 1.0 - d;
    q.y -= max(d - 0.55, 0.0) * 0.9;
  }
}
// faces its velocity, biased toward the wall so a blocked unit never spins: yaw = atan(vx, vz + 0.6) + π (no trig)
void grPlace(vec3 q, vec3 n, out vec3 wp, out vec3 wn) {
  vec2 f = normalize(vec2(iPos.z, iPos.w + 0.6));
  float cy = -f.y, sy = -f.x;
  wp = vec3(cy * q.x + sy * q.z + grXZ.x, q.y, -sy * q.x + cy * q.z + grXZ.y); wn = vec3(cy * n.x + sy * n.z, n.y, -sy * n.x + cy * n.z);
}
float grEyeK(float z) { return mix(mix(uEyeK.y, uEyeK.x, smoothstep(uEyeZ.z, uEyeZ.y, z)), 1.0, smoothstep(uEyeZ.y, uEyeZ.x, z)); }
vec3 grIrr(vec3 n) { return uSunCol * max(dot(n, uSunDir), 0.0) + mix(uGround, uSky, n.y * 0.5 + 0.5); }
// m: 0 skin, 1 shirt, 2 pants / hair, 3 eye, 4 ground disc
vec3 grPal(int m) {
  if (grType == 3) return m == 0 ? uBruSk : uBruCl;
  if (grType == 4 && m < 2) return m == 0 ? uSpiSk : uSpiSac;
  if (grType == 1 && m < 2) return m == 0 ? uRunSk : uRunSh;
  return m == 0 ? grSel4(grVar, uSk0, uSk1, uSk2, uSk3) : (m == 1 ? grSel4(grVar, uSh0, uSh1, uSh2, uSh3) : grSel4(grVar, uPa0, uPa1, uPa2, uPa3));
}
vec3 grShade(int m, vec3 wn, vec3 wp) {
  if (m == 4) return vec3(0.008);
  if (m == 3) return uEye * grEyeK(grXZ.y) * (1.0 - grDeath);
  vec3 base = grPal(m), col = base * grBright * (grIrr(wn) + uFill * max(dot(wn, normalize(cameraPosition - wp)), 0.0));
  if (grType == 4 && m == 1) col += base * uSac * grEyeK(grXZ.y) * (1.0 - grDeath);
  return min(mix(col, vec3(1.0), grFlash * uFlash) * (1.0 - grDeath * 0.45), vec3(uBodyMax));
}
float grDither(float f) { return grDeath > 0.7 ? min(f, 1.0 - (grDeath - 0.7) / 0.3) : f; }
`;
const COLLAPSE = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;';
const VERT_HEAD = `varying vec3 vCol; varying float vFade;
#include <common>
#include <fog_pars_vertex>
${DECODE}`;
const VERT_TAIL = `vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const VERT = (lod1) => /* glsl */`attribute vec4 aPiv; attribute float aMat;
${VERT_HEAD}
void main() {
#ifdef GR_DEPTH
  if (aMat > 3.5 || !grFetch()) { ${COLLAPSE} }
#else
  if (aMat > 3.5 && gl_InstanceID * GR_K + int(aCopy) < uNoDisc || !grFetch()) { ${COLLAPSE} }   // casters: no disc
#endif
  grDecode();
  vec3 q = position, n = normal, wp, wn;
  grPose(aPiv.w, aPiv.xyz, q, n); grPlace(q, n, wp, wn);
#ifndef GR_DEPTH
  vCol = grShade(int(aMat + 0.5), wn, wp); vFade = grDither(${lod1 ? '1.0 - grFade' : 'grFade'});
#endif
  ${VERT_TAIL}`;
const FRAG_TAIL = `#include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
// LOD0 draws where bayer ≤ its coverage, LOD1 where bayer > 1 − its coverage: the two never cover one pixel. Software GL
// builds them without the dither (no cross-fade, no dither-out): a discard costs it the early depth test (≈ 6 ms a frame)
const FRAG = (lod1, soft) => /* glsl */`varying vec3 vCol; varying float vFade;
#include <common>
#include <fog_pars_fragment>
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy) & 3; int a = q.x & 1, b = q.y & 1, c = q.x >> 1, d = q.y >> 1;
  float bay = (float(4 * (2 * (a ^ b) + b) + 2 * (c ^ d) + d) + 0.5) / 16.0;
  ${soft ? '' : `if (vFade < 0.999 && ${lod1 ? 'bay <= 1.0 - vFade' : 'bay > vFade'}) discard;`}
  gl_FragColor = vec4(vCol, 1.0);
  ${FRAG_TAIL}`;
const DEPTH_FRAG = /* glsl */`#include <common>
#include <packing>
void main() { gl_FragColor = packDepthToRGBA(gl_FragCoord.z); }`;
const IMP_VARY = 'varying vec2 vP; varying float vSw; varying vec3 vSkin; varying vec3 vShirt; varying vec3 vPants; varying vec3 vEye; varying float vTop;';
const IMP_VERT = /* glsl */`${IMP_VARY}
#include <common>
#include <fog_pars_vertex>
${DECODE}
void main() {
  if (!grFetch()) { ${COLLAPSE} }
  grDecode();
  vec3 camR = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0])), camF = normalize(vec3(viewMatrix[0][2], 0.0, viewMatrix[2][2]));
  float d = grDeath, cr = grP.z > 0.0 ? 1.0 : 0.0, k = grBright * (1.0 - d * 0.6);
  vec3 wp = vec3(grXZ.x, 0.0, grXZ.y) + camR * position.x * 0.76 * grS.x * (1.0 + 0.4 * cr);
  wp.y = position.y * 1.8 * grS.y * (1.0 - 0.58 * cr) * (1.0 - 0.75 * min(d * 1.7, 1.0)) + abs(cos(grW)) * 0.05 - max(d - 0.5, 0.0);
  vP = vec2(position.x * 0.76, position.y * 1.8); vSw = sin(grW);
  vec3 irr = grIrr(camF), mx = vec3(uBodyMax);
  vSkin = min(grPal(0) * k * irr, mx); vShirt = min(grPal(1) * k * irr, mx); vPants = min(grPal(2) * k * irr, mx);
  vEye = uEye * grEyeK(grXZ.y) * (1.0 - d);
  vTop = dot(grIrr(vec3(0.0, 1.0, 0.0)), vec3(0.333)) / max(dot(irr, vec3(0.333)), 1e-3);
  ${VERT_TAIL}`;
const IMP_FRAG = /* glsl */`uniform float uBodyMax;
${IMP_VARY}
#include <common>
#include <fog_pars_fragment>
float grBox(vec2 p, vec2 c, vec2 h) { vec2 q = abs(p - c) - h; return max(q.x, q.y); }
void main() {
  vec2 p = vP; float lL = max(vSw, 0.0) * 0.11, lR = max(-vSw, 0.0) * 0.11;
  float legs = min(grBox(p, vec2(-0.11, 0.37 + lL * 0.5), vec2(0.075, 0.37 - lL * 0.5)), grBox(p, vec2(0.11, 0.37 + lR * 0.5), vec2(0.075, 0.37 - lR * 0.5)));
  float torso = grBox(p, vec2(0.0, 0.96), vec2(0.19, 0.25)), arms = grBox(vec2(abs(p.x), p.y), vec2(0.235, 1.07 + vSw * 0.02), vec2(0.062, 0.12));
  float head = grBox(p, vec2(0.0, 1.36), vec2(0.115, 0.125));
  if (min(min(legs, torso), min(arms, head)) > 0.0) discard;
  vec3 col = vPants;
  if (torso <= 0.0) col = vShirt * (p.y > 1.18 ? vTop : 1.0);
  if (arms <= 0.0) col = vSkin * (p.y > 1.15 ? vTop : 1.0);
  if (head <= 0.0) col = vSkin * (p.y > 1.45 ? vTop : 1.0);
  col = head <= 0.0 && grBox(vec2(abs(p.x), p.y), vec2(0.055, 1.39), vec2(0.03, 0.022)) <= 0.0 ? vEye : min(col, vec3(uBodyMax));
  gl_FragColor = vec4(col, 1.0);
  ${FRAG_TAIL}`;
const CARPET_VERT = /* glsl */`attribute float aRow;
uniform float uTime; uniform float uFront; uniform float uBack; uniform float uSpeed; uniform float uHalf; uniform float uRows;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSky; uniform vec3 uGround;
varying vec2 vP; varying float vSeed; varying float vFade; varying vec3 vBody;
#include <common>
#include <fog_pars_vertex>
void main() {
  float span = uFront - uBack, k = aRow + uTime * uSpeed / span * uRows, t = fract(k / uRows), jit = (fract(sin(aRow * 91.7) * 4375.5) - 0.5) * 0.35;
  vSeed = floor(k / uRows) * 7.13 + aRow * 1.37;
  vec3 wp = vec3(position.x * uHalf, position.y * 1.85, uBack + span * t + jit);
  vP = vec2(position.x * uHalf + mod(aRow, 2.0) * 0.28, position.y * 1.85);
  vFade = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.94, 1.0, t));
  vBody = (uSunCol * max(uSunDir.z, 0.0) + mix(uGround, uSky, 0.5)) * vec3(0.36, 0.43, 0.32);
  ${VERT_TAIL}`;
const CARPET_FRAG = /* glsl */`uniform float uTime; uniform float uDensity; uniform vec3 uEye; uniform float uEyeCarpet;
varying vec2 vP; varying float vSeed; varying float vFade; varying vec3 vBody;
#include <common>
#include <fog_pars_fragment>
float grH(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }   // sin-free hash
void main() {
  float cell = floor((vP.x + 64.0) / 0.56), h1 = grH(vec2(cell, vSeed)), h2 = grH(vec2(cell + 31.0, vSeed));
  if (grH(vec2(cell, vSeed + 9.0)) > uDensity * vFade) discard;
  float cx = (cell + 0.5) * 0.56 - 64.0 + (h1 - 0.5) * 0.22, sc = 0.86 + 0.28 * h2;
  vec2 q = vec2((vP.x - cx) / sc, (vP.y - abs(sin(uTime * 9.0 + h1 * 20.0)) * 0.05) / sc);
  bool head = abs(q.x) < 0.11 && q.y > 1.24 && q.y < 1.5;
  bool legs = abs(abs(q.x) - 0.1) < 0.07 && q.y < 0.74, arms = abs(abs(q.x) - 0.235) < 0.06 && q.y > 1.0 && q.y < 1.2;
  if (!(legs || (abs(q.x) < 0.19 && q.y > 0.7 && q.y < 1.22) || arms || head)) discard;
  vec3 col = head && abs(abs(q.x) - 0.055) < 0.03 && abs(q.y - 1.39) < 0.022 ? uEye * uEyeCarpet : vBody * (0.75 + 0.5 * h2);
  gl_FragColor = vec4(col, 1.0);
  ${FRAG_TAIL}`;
const TR_VERT = /* glsl */`attribute vec4 aA; attribute vec4 aB; uniform float uTime; uniform float uLen; varying float vA;
#include <common>
#include <fog_pars_vertex>
void main() {
  float t = (uTime - aA.w) / max(aB.w, 1e-3); vec3 dir = aB.xyz - aA.xyz; float L = length(dir); dir /= max(L, 1e-4);
  float head = clamp(t, 0.0, 1.0) * L;
  vec3 wp = aA.xyz + dir * mix(max(head - uLen, 0.0), head, position.y) + normalize(vec3(-dir.z, 0.0, dir.x)) * position.x * 0.07;
  if (t < 0.0 || t > 1.0) wp = vec3(0.0, -50.0, 0.0);
  vA = position.y;
  ${VERT_TAIL}`;
const TR_FRAG = /* glsl */`uniform vec3 uColor; varying float vA;
#include <common>
#include <fog_pars_fragment>
void main() { gl_FragColor = vec4(uColor * (0.25 + 0.75 * vA), 1.0);
  ${FRAG_TAIL}`;
const GORE_VERT = /* glsl */`attribute vec4 aG; attribute float aR; uniform float uTime; varying vec2 vUv;
#include <common>
#include <fog_pars_vertex>
void main() {
  float c = cos(aR), s = sin(aR), grow = clamp((uTime - aG.w) * 5.0, 0.0, 1.0);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aG.z;
  vec3 wp = vec3(aG.x + q.x * grow, 0.02, aG.y + q.y * grow * 0.8);
  vUv = position.xy * 2.0;
  ${VERT_TAIL}`;
const GORE_FRAG = /* glsl */`uniform vec3 uColor; varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
void main() { float a = smoothstep(1.0, 0.55, length(vUv)) * 0.78; if (a < 0.01) discard; gl_FragColor = vec4(uColor, a);
  ${FRAG_TAIL}`;

/** sRGB hex → linear (three's colour management converts setHex input). */
const lin = (hex) => { _c.setHex(hex); return new Vector3(_c.r, _c.g, _c.b); };

export class CrowdSystem {
  constructor(ctx) {
    // `f = 0.5; f = 0` seeds a float field as a heap double (never Smi), so its first fractional store never deprecates the map
    this.ctx = ctx; this.active = false; this.programsReady = false; this.MODE = MODE;
    this._built = false; this._prep = null; this._prepRun = null; this._rules = null; this._demo = 0; this._demoLane = 0.5; this._demoLane = 0;
    this.kills = 0; this.bites = 0; this.coin = 0.5; this.coin = 0; this.t = 0.5; this.t = 0;
  }

  /** Allocates the pool, grid, queue and the texture's CPU side once (≈ 0.6 MB; the GPU side is prepare()'s). */
  init() {
    const f32 = () => new Float32Array(CAP), i32 = (n) => new Int32Array(n);
    this.x = f32(); this.z = f32(); this.vx = f32(); this.vz = f32(); this.px = f32(); this.pz = f32(); this.spd = f32(); this.hp = f32();
    this.tx = f32(); this.tm = f32(); this.aw = f32(); this.phase = f32(); this.look = f32(); this.hitT = f32(); this.deathT = f32(); this.dieT = f32();
    this.type = new Uint8Array(CAP); this.state = new Uint8Array(CAP); this.mode = new Uint8Array(CAP); this.gen = new Uint32Array(CAP);
    this.cell = i32(CAP); this.free = i32(CAP); this.live = i32(CAP); this._livePos = i32(CAP); this.nFree = 0; this.nLive = 0;
    this._alive = 0; this._byType = i32(NT);
    this._cc = i32(NCELLS); this._cs = i32(NCELLS + 1); this._cf = i32(NCELLS); this._cl = i32(CAP); this._cv = new Float32Array(NCELLS);
    this._feed = i32(NCELLS);
    this._colFront = new Float32Array(GCOLS); this._order = i32(CAP); this._dying = i32(CAP); this._dying2 = i32(CAP); this._dRow = i32(GROWS);
    this._order2 = i32(CAP); this._cand = i32(CAP);
    // queue ring, kept in time order: due time (crowd s), HP, x / z / target x in cm, type, flags (1 burst: z given, may use the
    // reserve; 2 counted as waiting)
    this._qT = new Float32Array(QCAP); this._qHp = new Float32Array(QCAP); this._qX = new Int16Array(QCAP); this._qZ = new Int16Array(QCAP);
    this._qTx = new Int16Array(QCAP); this._qType = new Uint8Array(QCAP); this._qFlag = new Uint8Array(QCAP); this._qHead = 0; this._qN = 0;
    this._sT = new Float32Array(QCAP); this._sH = new Float32Array(QCAP); this._sX = new Int16Array(QCAP); this._sTx = new Int16Array(QCAP);
    this._sTy = new Uint8Array(QCAP);                  // spawnSurge's batch, merged into the queue in one pass
    this._rng = new Rng(1); this._rngLook = new Rng(2);
    this._texData = new Float32Array(TEX_W * TEX_ROWS * 4);
    this._nd = 0; this._n0 = 0; this._xf0 = 0; this._n1e = 0; this._drawn40 = 0; this._drawnDying = 0; this._culled = 0; this._undrawn = 0;
    this._carpetFront = 0.5; this._carpetFront = CROWD.carpet.front; this._carpetK = 0.5; this._carpetK = 0; this._density = 0.5; this._density = 0;
    this._tickEl = 0.5; this._tickEl = 0; this._phaseAB = 0; this._fled = false; this._killN = 0; this._dmgUsed = 0.5;
    this._killCoins = 0.5; this._killCoins = 0; this._killX = 0.5; this._killX = 0; this._killZ = 0.5; this._killZ = 0; this._killT = 0.5; this._killT = 0;
    // governor: frame intervals while a level plays and the crowd is idle (its reference), EMA, timers
    this._refIv = new Float32Array(1200); this._refSort = new Float32Array(1200); this._refN = 0; this._refHead = 0; this._refSum = 0.5; this._refSum = 0;
    this._lastNow = -1; this._ref = 0.5; this._ref = 1000 / 60; this._ivEma = 0.5; this._ivEma = 0;
    this._slowT = 0.5; this._slowT = 0; this._fastT = 0.5; this._fastT = 0; this._floorT = 0.5; this._floorT = 0; this._frameMs = 0.5; this._frameMs = 0;
    this.perf = { msA: 0.5, nA: 0, msB: 0.5, nB: 0, renderMs: 0.5, renderN: 0, steps: new Float32Array(4096), nSteps: 0, uploads: 0 };
    this.debugReset();
    this._cam = null; this._soft = false;
    this._vm0 = 0.5; this._vm2 = 0.5; this._vm8 = 0.5; this._vm10 = 0.5; this._vmx = 0.5; this._vmz = 0.5; this._tanH = 0.5;
    this._applyTier();
    this._onQuality = () => this._applyTier();
    if (this.ctx.events) this.ctx.events.on('quality:change', this._onQuality);
    const self = this;                                  // the debug demo's fire policy: lane sweep, out-of-lane rounds × 0.25
    this._demoPolicy = { pierce: 4, tracerY: 1.0, rate() { return 90; },  // horde §4.3: rounds folded at 90/s
      shot(k, o) { const d = o.ox - self._demoLane; o.weight = d < 1.25 && d > -1.25 ? 1 : 0.25; return true; } };
    this._clearPool();
    return this;
  }

  // ---------------------------------------------------------------------------------------------- lifecycle
  /** Builds the meshes (once) under the scene, hidden, and compiles their programs (render.addWarmable) behind the spinner. */
  prepare() {
    if (this._prep) return this._prep;
    const r = this.ctx.render;
    if (!r || !r.scene || !r.renderer) { this.programsReady = true; return (this._prep = Promise.resolve()); }
    this._build();
    const run = this._prepRun = { dead: false };
    return (this._prep = Promise.resolve(r.addWarmable(this._group, run)).then(() => { if (!run.dead) { this.programsReady = true; this._prepRun = null; } }));
  }

  /** r8 (P8): a run of another base started: a prepare under way stops between chunks, unready; the next prepare() finishes it. */
  cancelPrepare() {
    if (!this._prepRun) return;
    this._prepRun.dead = true;
    this._prepRun = null;
    this._prep = null;
  }

  /** Starts a hold: o { seed, coin (per paying kill), rules, priority }; registers the crowd as a weapons target. */
  begin(o) {
    o = o || {};
    this.reset();
    const seed = (o.seed >>> 0) || 1;
    this._rng.reseed(seed); this._rngLook.reseed((seed ^ 0x9E3779B9) >>> 0);
    this.coin = o.coin > 0 ? o.coin : 0; this._rules = o.rules || null; this.active = true; this._fled = false;
    this._ref = this._refMedian(); this._ivEma = 0; this._lastNow = -1; this._slowT = 0; this._fastT = 0; this._floorT = 0; this._govCap = this._T.cap;
    if (!this._built && this.ctx.render && this.ctx.render.scene) this._build();
    if (this._group) this._group.visible = true;
    const w = this.ctx.weapons;
    if (w && w.addTarget) w.addTarget(this, o.priority || 0);
  }

  /** The hold is won: every living unit turns and runs, the queue is dropped, the carpet fades. Until the next begin every
   *  provider query misses (no round, blast or troop is spent on the crowd), no kill pays or counts, nothing spawns. */
  flee() {
    if (!this.active) return;
    for (let k = 0; k < this.nLive; k++) { const i = this.live[k]; if (this.state[i] === S_ALIVE) this.mode[i] = M_FLEE; }
    this._qN = 0; this._demo = 0; this._fled = true;
  }

  setRules(r) { this._rules = r || null; }

  /** Level reset (RESET_ORDER) / quit: inactive, pool and queue cleared, meshes hidden, scalerGuard defaults, demo patch off. */
  reset() {
    const lvl = this.ctx.level;
    if (lvl && Object.prototype.hasOwnProperty.call(lvl, 'step')) delete lvl.step;
    this._demo = 0;
    if (!this.active && this.nLive === 0 && this._qN === 0) return;
    this.active = false; this._rules = null; this._qN = 0;
    this._clearPool();
    if (this._group) this._group.visible = false;
    const w = this.ctx.weapons, e = this.ctx.engine;
    if (w && w.removeTarget) w.removeTarget(this);
    if (e && e.scalerGuard) { e.scalerGuard.exemptMs = 0; e.scalerGuard.dropOk = true; }
  }

  end() { this.reset(); }

  dispose() {
    this.reset();
    if (this.ctx.events && this.ctx.events.off) this.ctx.events.off('quality:change', this._onQuality);
    const r = this.ctx.render, g = this._group;
    if (!g) return;
    if (r) { r.removeWarmable(g); if (r.scene) r.scene.remove(g); }
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this._depth.dispose(); this._tex.dispose();
    this._group = null; this._built = false; this._prep = null; this.programsReady = false;
  }

  _clearPool() {
    this.state.fill(0); this.nLive = 0; this._alive = 0; this._byType.fill(0); this.nFree = 0;
    for (let i = CAP - 1; i >= 0; i--) this.free[this.nFree++] = i;
    this.kills = 0; this.bites = 0; this.t = 0; this._phaseAB = 0; this._killN = 0; this._killCoins = 0; this._killX = 0; this._killZ = 0; this._killT = 0;
    this._nd = 0; this._n0 = 0; this._xf0 = 0; this._n1e = 0; this._drawn40 = 0; this._drawnDying = 0; this._carpetK = 0; this._density = 0; this._fled = false;
    this._colFront.fill(-1e9); this._cc.fill(0); this._cs.fill(0);
    if (!this._built) return;
    this._commit(this._m0, 0, 0); this._commit(this._m1, 0, 0); this._commit(this._m2, 0, 0);
    // the gore ring and the pierce streaks start empty: no blood or streak of the last attempt shows at the next dig-in
    const ga = this._goA.array, ta = this._trA.array;
    for (let k = 0; k < ga.length; k += 4) { ga[k + 1] = 500; ga[k + 2] = 0; }
    for (let k = 0; k < ta.length; k += 4) ta[k + 3] = -1e4;
    this._goNext = 0; this._trNext = 0; this._goDirty = true; this._trDirty = true;
  }

  /** Tier row (CROWD.tiers; software GL → 'sw'): caps, LOD bands, casters, carpet rows, gore ring; the governor restarts
   *  at the tier's cap (logged during a hold for the on-screen probe). */
  _applyTier() {
    const q = this.ctx.quality;
    this._tier = q && q.software ? 'sw' : (q && CROWD.tiers[q.tier] ? q.tier : 'high');
    const T = this._T = CROWD.tiers[this._tier];
    this._govCap = T.cap; this._floorT = 0;
    if (this.active) this._logGov();
    if (!this._built) return;
    this._m0.castShadow = T.shadows > 0;
    this._carpet.geometry.instanceCount = T.carpetRows; this._carpet.material.uniforms.uRows.value = T.carpetRows;
    this._gore.geometry.instanceCount = T.gore;
  }

  // ---------------------------------------------------------------------------------------------- spawning
  /** Index of a type name (or the index itself); −1 when unknown. */
  typeIndex(t) { return typeof t === 'number' ? (t >= 0 && t < NT ? t : -1) : (TYPE_INDEX[t] !== undefined ? TYPE_INDEX[t] : -1); }

  /** Queues a unit due at crowd time t (s since begin): type (index or name), spawn x, target x, hp; z given = a burst
   *  placed there (it may use the reserve), else the feed places it in the band. Insertion keeps time order (after the
   *  queued units due at the same time; O(1) in time order). False when the queue is full or the hold is won. */
  queue(t, type, x, tx, hp, z) {
    const ty = this.typeIndex(type);
    if (ty < 0 || this._fled) return false;
    if (this._qN >= QCAP) { warnOnce('crowd.queueFull', 'crowd: spawn queue full'); return false; }
    const T = this._qT, H = this._qHp, X = this._qX, Z = this._qZ, TX = this._qTx, TY = this._qType, FL = this._qFlag;
    const tf = Math.fround(t);                         // compared as stored, so a surge's merge orders ties identically
    let k = this._qHead + this._qN, n = this._qN;
    if (k >= QCAP) k -= QCAP;
    while (n > 0) {
      const p = k === 0 ? QCAP - 1 : k - 1;
      if (T[p] <= tf) break;
      T[k] = T[p]; H[k] = H[p]; X[k] = X[p]; Z[k] = Z[p]; TX[k] = TX[p]; TY[k] = TY[p]; FL[k] = FL[p];
      k = p; n--;
    }
    const burst = z !== undefined && z === z;
    T[k] = tf; H[k] = hp; X[k] = Math.round(x * 100); Z[k] = burst ? Math.round(z * 100) : 0; TX[k] = Math.round(tx * 100);
    TY[k] = ty; FL[k] = burst ? 1 : 0;
    this._qN++;
    return true;
  }

  /** Queues a surge part (gameplay stream): d { t0 (s from now), window, n, type (name / index) or mix (5 weights), hp (number
   *  or 5 per type), x0, x1 (spawn x at the window start) and x0e, x1e (at its end: sweeps), tx0, tx1 (target x), pA with
   *  ta0, ta1 (the chance of a second target range) }. Its units are due in time order, so they merge into the queue in
   *  one backward pass (O(queued + n), the same order as n single inserts). Returns the units queued. */
  spawnSurge(d) {
    const rng = this._rng, n = d.n | 0, w = d.window > 0 ? d.window : 0, t0 = this.t + (d.t0 > 0 ? d.t0 : 0);
    const one = d.type !== undefined ? this.typeIndex(d.type) : -1, xe0 = d.x0e !== undefined ? d.x0e : d.x0, xe1 = d.x1e !== undefined ? d.x1e : d.x1;
    if (this._fled || (d.type !== undefined && one < 0)) return 0;
    const sT = this._sT, sH = this._sH, sX = this._sX, sTx = this._sTx, sTy = this._sTy, room = QCAP - this._qN;
    let q = 0;
    for (let k = 0; k < n; k++) {
      const v = (k + rng.next()) / n, m = d.mix;
      let ty = one;
      if (ty < 0) { let u = rng.next() * (m[0] + m[1] + m[2] + m[3] + m[4]); ty = 0; while (ty < NT - 1 && u >= m[ty]) { u -= m[ty]; ty++; } }
      const xa = d.x0 + (xe0 - d.x0) * v, xb = d.x1 + (xe1 - d.x1) * v, x = xa + (xb - xa) * rng.next();
      const tx = d.pA > 0 && rng.next() < d.pA ? d.ta0 + (d.ta1 - d.ta0) * rng.next() : d.tx0 + (d.tx1 - d.tx0) * rng.next();
      if (q === room) continue;                        // full: the draws go on, so the stream never depends on the room
      sT[q] = t0 + w * v; sH[q] = typeof d.hp === 'number' ? d.hp : d.hp[ty]; sX[q] = Math.round(x * 100); sTx[q] = Math.round(tx * 100); sTy[q] = ty;
      q++;
    }
    if (q < n) warnOnce('crowd.queueFull', 'crowd: spawn queue full');
    // backward merge: from the new tail, the later of the last queued entry and the last scratch entry (ties: scratch last)
    const T = this._qT, H = this._qHp, X = this._qX, Z = this._qZ, TX = this._qTx, TY = this._qType, FL = this._qFlag, h = this._qHead;
    for (let i = this._qN - 1, j = q - 1, o = this._qN + q - 1; j >= 0; o--) {
      const pw = h + o < QCAP ? h + o : h + o - QCAP, pi = h + i < QCAP ? h + i : h + i - QCAP;
      if (i >= 0 && T[pi] > sT[j]) { T[pw] = T[pi]; H[pw] = H[pi]; X[pw] = X[pi]; Z[pw] = Z[pi]; TX[pw] = TX[pi]; TY[pw] = TY[pi]; FL[pw] = FL[pi]; i--; }
      else { T[pw] = sT[j]; H[pw] = sH[j]; X[pw] = sX[j]; Z[pw] = 0; TX[pw] = sTx[j]; TY[pw] = sTy[j]; FL[pw] = 0; j--; }
    }
    this._qN += q;
    return q;
  }

  /** Boss minions: n units of `type` around (x, z) within `spread` m (behind), placed now on the reserve; overflow waits. */
  spawnBurst(x, z, n, type, hp, spread) {
    const ty = this.typeIndex(type), rng = this._rng, sp = spread > 0 ? spread : 2.5;
    let placed = 0;
    for (let k = 0; ty >= 0 && !this._fled && k < n; k++) {
      const bx = x + (rng.next() * 2 - 1) * sp, bz = z - rng.next() * sp, tx = (rng.next() * 2 - 1) * (F.wallHalf - 0.5);
      if (this._alive < CROWD.feedCap + CROWD.reserve && this.nFree > 0) { this._spawn(ty, bx, bz, tx, hp); placed++; }
      else this.queue(this.t, ty, bx, tx, hp, bz);
    }
    return placed;
  }

  /** The boss's footprint: living units inside r (+ their radius) of (x, z) are pushed out radially. */
  pushCircle(x, z, r) {
    const rr = r + R, X = this.x, Z = this.z, cand = this._cand;
    for (let k = 0, n = this._collect(x - rr, x + rr, z - rr, z + rr); k < n; k++) {
      const i = cand[k], dx = X[i] - x, dz = Z[i] - z, d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      if (d2 < 1e-8) { X[i] = x + rr; continue; }
      const s = rr / Math.sqrt(d2); X[i] = x + dx * s; Z[i] = z + dz * s;
    }
  }

  _spawn(ty, x, z, tx, hp) {
    const i = this.free[--this.nFree], rl = this._rngLook;
    this.x[i] = x; this.z[i] = z; this.vx[i] = 0; this.px[i] = 0; this.pz[i] = 0;
    this.vz[i] = this.spd[i] = SPEED[ty] * (1 + CROWD.speedJitter * (this._rng.next() * 2 - 1));
    this.hp[i] = hp > 0 ? hp : 1; this.type[i] = ty; this.mode[i] = M_WALK; this.tx[i] = tx; this.tm[i] = 0; this.aw[i] = 0;
    this.look[i] = ((rl.next() * 4) | 0) + 4 * ((rl.next() * 16) | 0) + 64 * ((rl.next() * 16) | 0) + 1024 * ty;
    this.phase[i] = rl.next(); this.hitT[i] = -1e3; this.deathT[i] = -1;
    this.state[i] = S_ALIVE; this.cell[i] = -1; this._livePos[i] = this.nLive; this.live[this.nLive++] = i;
    this._alive++; this._byType[ty]++;
    return i;
  }

  _release(i) {
    if (this.state[i] === S_ALIVE) { this._alive--; this._byType[this.type[i]]--; }
    this.state[i] = S_FREE; this.gen[i] = (this.gen[i] + 1) & GEN_MASK;
    const p = this._livePos[i], last = this.live[--this.nLive];
    this.live[p] = last; this._livePos[last] = p; this.free[this.nFree++] = i;
  }

  /** Kills slot i (crumple). cause 'bite' | 'cleanup' | 'flee' and a fleeing unit pay nothing (a bite counts crowd.bites);
   *  every other kill counts crowd.kills and is batched into crowd:kills. */
  kill(i, cause) {
    if (this.state[i] !== S_ALIVE) return;
    const el = this._el(), fled = this.mode[i] === M_FLEE;
    this.state[i] = S_DYING; this.dieT[i] = this.t; this.deathT[i] = el; this.vx[i] = 0; this.vz[i] = 0; this._alive--; this._byType[this.type[i]]--;
    if (cause === 'bite') { if (!fled) this.bites++; }
    else if (cause !== 'cleanup' && cause !== 'flee' && !fled) {
      this.kills++; this._killN++; this._killCoins += this.coin; this._killX += this.x[i]; this._killZ += this.z[i];
    }
    if (cause !== 'cleanup' && this._built && this.z[i] > CROWD.gore.maxZ) this._goreAt(this.x[i], this.z[i], el);
  }

  /** Removes slot i at once (no body). */
  remove(i) { if (this.state[i] !== S_FREE) this._release(i); }
  idOf(i) { return (this.gen[i] << ID_BITS) | i; }
  /** Slot of a living unit's id; −1 when stale or dead. */
  slotOf(id) { const i = id & ID_MASK; return i < CAP && this.state[i] === S_ALIVE && this.gen[i] === id >>> ID_BITS ? i : -1; }
  get alive() { return this._alive; }
  aliveOfType(t) { const k = this.typeIndex(t); return k < 0 ? 0 : this._byType[k]; }
  /** Units queued (due or not). */
  get queued() { return this._qN; }
  /** Due units still waiting for room in the feed. */
  get waiting() { let n = 0, k = this._qHead; while (n < this._qN && this._qT[k] <= this.t) { n++; if (++k === QCAP) k = 0; } return n; }
  _el() { return this.ctx.time ? this.ctx.time.elapsed : this.t; }

  // ---------------------------------------------------------------------------------------------- step (60 Hz fixed)
  step(dt) {
    if (!this.active) return;
    const t0 = nowMs(), P = this.perf;
    this.t += dt;
    if (this._demo > 0) this._demoLane = 3 * Math.sin(this.t * 1.05);
    if (this._phaseAB === 0) { this._phaseA(); this._phaseAB = 1; P.msA += nowMs() - t0; P.nA++; }
    else { this._phaseB(2 * dt); this._phaseAB = 0; P.msB += nowMs() - t0; P.nB++; }
    const ms = nowMs() - t0;
    this._frameMs += ms; P.steps[P.nSteps & 4095] = ms; P.nSteps++;
  }

  _phaseA() {
    const X = this.x, Z = this.z, st = this.state, cellOf = this.cell, PX = this.px, PZ = this.pz, now = this.t;
    const cc = this._cc, cs = this._cs, cf = this._cf, cl = this._cl;
    for (let k = this.nLive - 1; k >= 0; k--) { const i = this.live[k]; if (st[i] === S_DYING && now - this.dieT[i] >= RD.deathS) this._release(i); }
    for (let n = this._demo > 0 ? this._demo - this._alive - this._qN : 0; n > 0; n--) {
      this.queue(now, 0, (this._rng.next() * 2 - 1) * F.feedX, (this._rng.next() * 2 - 1) * 3.6, 1);
    }
    this._feedTick(now);
    // counting sort of the living units into the 1 m grid
    cc.fill(0); this._cv.fill(0);
    const live = this.live, nLive = this.nLive;
    for (let k = 0; k < nLive; k++) {
      const i = live[k];
      if (st[i] !== S_ALIVE) { cellOf[i] = -1; continue; }
      let cx = (X[i] - G.x0) | 0; if (cx < 0) cx = 0; else if (cx >= GCOLS) cx = GCOLS - 1;
      let cz = (Z[i] - G.z0) | 0; if (cz < 0) cz = 0; else if (cz >= GROWS) cz = GROWS - 1;
      const c = cz * GCOLS + cx; cellOf[i] = c; cc[c]++; this._cv[c] += this.vz[i]; PX[i] = 0; PZ[i] = 0;
    }
    let acc = 0;
    for (let c = 0; c < NCELLS; c++) { cs[c] = acc; cf[c] = acc; acc += cc[c]; }
    cs[NCELLS] = acc;
    for (let k = 0; k < nLive; k++) { const i = live[k], c = cellOf[i]; if (c >= 0) cl[cf[c]++] = i; }
    // full half-shell separation: every unit against the next sep.max of its own cell, the first sep.max of its right
    // neighbour and 3 × sep.max of the next row's cells (linear in a crowded cell, so a stack always comes apart); a
    // neighbour cell is skipped when the unit sits farther than 2r from it (the lists are exact here: built just above)
    const SM = CROWD.sep.max, R2 = 2 * R;
    for (let cz = SEP_ROW0; cz < GROWS; cz++) {
      const zEdge = G.z0 + cz + 1 - R2, next = cz + 1 < GROWS;
      for (let cx = 0; cx < GCOLS; cx++) {
        const c = cz * GCOLS + cx, a0 = cs[c], a1 = cs[c + 1], xL = G.x0 + cx + R2, xR = G.x0 + cx + 1 - R2, right = cx + 1 < GCOLS;
        if (a0 === a1) continue;
        for (let a = a0; a < a1; a++) {
          const i = cl[a], xi = X[i], zi = Z[i];
          let pxi = 0, pzi = 0, r0 = 0, r1 = 0, n0 = 0, n1 = 0;
          if (right && xi > xR) { r0 = cs[c + 1]; r1 = cs[c + 2]; if (r1 - r0 > SM) r1 = r0 + SM; }
          if (next && zi > zEdge) {
            n0 = cs[cx > 0 && xi < xL ? c + GCOLS - 1 : c + GCOLS]; n1 = cs[(right && xi > xR ? c + GCOLS + 1 : c + GCOLS) + 1];
            if (n1 - n0 > 3 * SM) n1 = n0 + 3 * SM;
          }
          for (let pass = 0; pass < 3; pass++) {
            let b = pass === 0 ? a + 1 : (pass === 1 ? r0 : n0);
            const e = pass === 0 ? (a + 1 + SM < a1 ? a + 1 + SM : a1) : (pass === 1 ? r1 : n1);
            for (; b < e; b++) {
              const j = cl[b], dx = X[j] - xi, dz = Z[j] - zi, d2 = dx * dx + dz * dz;
              if (d2 >= D2MIN || d2 < 1e-8) continue;
              const d = Math.sqrt(d2), push = (2 * R - d) / d * 0.5, ox = dx * push, oz = dz * push;
              pxi -= ox; pzi -= oz; PX[j] += ox; PZ[j] += oz;
            }
          }
          PX[i] += pxi; PZ[i] += pzi;
        }
      }
    }
  }

  /** The queue's due units, FIFO (like holdsim): bursts where asked, the rest in the band at ≤ feedDens per cell (tries). */
  _feedTick(now) {
    const fd = this._feed, rng = this._rng, z0 = F.feedZ[0], zs = F.feedZ[1] - F.feedZ[0];
    fd.set(this._cc);                                  // the last tick's counts, as holdsim's feed
    for (let placed = 0; this._qN > 0 && placed < F.feedPerTick; placed++) {
      const k = this._qHead;
      if (this._qT[k] > now) break;
      const burst = (this._qFlag[k] & 1) !== 0;
      let ok = this.nFree > 0 && this._alive < CROWD.feedCap + (burst ? CROWD.reserve : 0);
      if (ok) {
        const ty = this._qType[k], qx = this._qX[k] * 0.01, tx = this._qTx[k] * 0.01, hp = this._qHp[k];
        if (burst) this._spawn(ty, qx, this._qZ[k] * 0.01, tx, hp);
        else {
          ok = false;
          for (let tr = 0; tr < F.feedTries && !ok; tr++) {
            const z = z0 + zs * rng.next();
            let x = qx + (tr ? (rng.next() * 2 - 1) * 3 : 0);
            x = x > F.feedX ? F.feedX : (x < -F.feedX ? -F.feedX : x);
            const c = ((z - G.z0) | 0) * GCOLS + ((x - G.x0) | 0);
            if (fd[c] < F.feedDens) { fd[c]++; this._spawn(ty, x, z, tx, hp); ok = true; }
          }
        }
      }
      if (!ok) {
        const dbg = this.ctx.debug;
        if ((this._qFlag[k] & 2) === 0 && dbg && dbg.dropped) { this._qFlag[k] |= 2; dbg.dropped['crowd.wait'] = (dbg.dropped['crowd.wait'] | 0) + 1; }
        break;
      }
      if (++this._qHead === QCAP) this._qHead = 0;
      this._qN--;
    }
  }

  _phaseB(dt) {
    const rules = this._rules, X = this.x, Z = this.z, VX = this.vx, VZ = this.vz, PX = this.px, PZ = this.pz, st = this.state, md = this.mode;
    const ty = this.type, SPD = this.spd, TXA = this.tx, cc = this._cc, cs = this._cs, cl = this._cl, cv = this._cv, order = this._order, colF = this._colFront;
    if (rules && rules.begin) rules.begin(dt);
    const kAcc = 1 - Math.exp(-ST.accel * dt), dCap = ST.densCap, sepK = CROWD.sep.k, wallFn = rules && rules.wallZ ? rules : null;
    const reachZ = rules && typeof rules.reachZ === 'number' ? rules.reachZ : F.reachZ;
    const spitZ = rules && typeof rules.spitZ === 'number' ? rules.spitZ : F.spitZ;
    const T = this._T, drawCap = this._govCap, livCap = Math.floor(drawCap * (1 - CROWD.dyingReserve));
    this._view();
    const vm0 = this._vm0, vm2 = this._vm2, vm8 = this._vm8, vm10 = this._vm10, vmx = this._vmx, vmz = this._vmz, tanH = this._tanH;
    let nl = 0, culled = 0, und = 0, d40 = 0;
    colF.fill(-1e9);
    // pass 1, rows from the wall backward (nearest first): steer, integrate, clamp, rules; the living drawn order
    for (let r = GROWS - 1; r >= 0; r--) {
      for (let a = cs[r * GCOLS], e = cs[(r + 1) * GCOLS]; a < e; a++) {
        const i = cl[a];
        if (st[i] !== S_ALIVE) continue;
        const m = md[i], t = ty[i];
        if (m === M_HOLD) { VX[i] = 0; VZ[i] = 0; if (rules && rules.onHold) rules.onHold(i); }
        else if (m === M_CLIMB) {
          Z[i] += F.climbSpeed * dt; VX[i] = 0; VZ[i] = F.climbSpeed;
          if (rules && rules.onClimb) rules.onClimb(i);
          if (st[i] === S_ALIVE && md[i] === M_CLIMB && Z[i] >= reachZ) this._reach(i, rules);
        } else {
          const x = X[i], z = Z[i], c = this.cell[i], cxi = c - r * GCOLS, flee = m === M_FLEE, pass = m === M_PASS;
          let dvx = (TXA[i] - x) * (z < F.funnelZ ? ST.street : (z < F.throatZ && !pass ? ST.funnel : ST.wall));
          dvx = dvx > ST.max ? ST.max : (dvx < -ST.max ? -ST.max : dvx);
          const ds = cc[c], dl = cxi > 0 ? cc[c - 1] : 99, dr = cxi + 1 < GCOLS ? cc[c + 1] : 99;
          if (dl < ds) dvx -= (ds - dl) * ST.diffuse;
          if (dr < ds) dvx += (ds - dr) * ST.diffuse;
          let dvz = flee ? -SPD[i] * F.fleeK : (t === T_CRAWLER && z > LUNGE_Z && z < F.wallZ ? LUNGE_V : SPD[i]);
          // the barrier line; within 1 m of it the unit's own cell is the one 'ahead', so the pile queues back instead of stacking
          const wz = (wallFn && z > F.wallZ - 3 ? wallFn.wallZ(x) : F.wallZ) - R, ca = !pass && z > wz - 1 ? c : c + GCOLS;
          if (!flee && ca < NCELLS) {                   // crowd pressure: the cell ahead at its density cap slows / stops
            const ah = cc[ca];
            if (ah > dCap) { if (ah > 2 * dCap) dvz = 0; else { const fl = cv[ca] / ah + 0.3; if (fl < dvz) dvz = fl > 0 ? fl : 0; } }
            if (!pass && cc[c] > 2 * dCap) {            // an overfull cell relaxes backward
              const back = -ST.relief * (cc[c] - 2 * dCap); dvz = back > -SPD[i] ? back : -SPD[i];
            }
          }
          const vx = VX[i] + (dvx - VX[i]) * kAcc, vz = VZ[i] + (dvz - VZ[i]) * kAcc;
          let nx = x + vx * dt + PX[i] * sepK, nz = z + vz * dt + PZ[i] * sepK;
          // halfAt and _inView written out: this function is past V8's inlining budget, and a call boxes its doubles (heap per step)
          const lim = (pass || nz >= F.throatZ ? F.wallHalf : (nz >= F.funnelZ ? F.wallHalf + (F.streetHalf - F.wallHalf) * (F.throatZ - nz) / (F.throatZ - F.funnelZ) : F.streetHalf)) - R;
          nx = nx > lim ? lim : (nx < -lim ? -lim : nx);
          VX[i] = vx; VZ[i] = vz; X[i] = nx; Z[i] = nz;
          if (flee) { if (nz < F.fleeZ) { this._release(i); continue; } }
          else if (pass) {
            if (rules && rules.onBreach) rules.onBreach(i);
            if (st[i] === S_ALIVE && md[i] === M_PASS && Z[i] >= reachZ) this._reach(i, rules);
          } else {
            if (t === T_SPITTER && m === M_WALK && nz >= spitZ && rules && rules.spitHold) rules.spitHold(i);
            if (st[i] === S_ALIVE && md[i] !== M_PASS && md[i] !== M_HOLD && Z[i] > wz) { Z[i] = wz; VZ[i] = 0; if (rules && rules.onWall) rules.onWall(i); }
          }
        }
        if (st[i] !== S_ALIVE) continue;
        const x = X[i], z = Z[i], cf = Math.floor(x - G.x0), col = cf < 0 ? 0 : (cf >= GCOLS ? GCOLS - 1 : cf);
        if (z > colF[col] && (t !== T_CRAWLER || z > HIT_Z)) colF[col] = z;
        const xv = vm0 * x + vm8 * z + vmx, zv = vm2 * x + vm10 * z + vmz;
        if (!(zv < 0 && (xv < 0 ? -xv : xv) <= -zv * tanH + 1)) { culled++; continue; }
        if (nl >= livCap) { und++; continue; }
        order[nl++] = i;
        if (z >= CROWD.near40) d40++;
      }
    }
    // dying bodies in view, nearest 1 m row first (counting sort, like the living), take what the living left of the cap,
    // merged into the order by depth
    const dy = this._dying, ds = this._dying2, rc = this._dRow, o2 = this._order2;
    let nV = 0, nd = 0, a = 0, b = 0;
    rc.fill(0);
    // _inView and rowOf written out, like pass 1 (a call boxes its doubles)
    for (let k = 0; k < this.nLive; k++) {
      const i = this.live[k];
      if (st[i] !== S_DYING) continue;
      const x = X[i], z = Z[i], xv = vm0 * x + vm8 * z + vmx, zv = vm2 * x + vm10 * z + vmz;
      if (!(zv < 0 && (xv < 0 ? -xv : xv) <= -zv * tanH + 1)) continue;
      const r = Math.floor(z - G.z0);
      dy[nV++] = i; rc[r < 0 ? 0 : (r >= GROWS ? GROWS - 1 : r)]++;
    }
    for (let r = GROWS - 1, acc = 0; r >= 0; r--) { const n = rc[r]; rc[r] = acc; acc += n; }
    for (let k = 0; k < nV; k++) { const i = dy[k], r = Math.floor(Z[i] - G.z0); ds[rc[r < 0 ? 0 : (r >= GROWS ? GROWS - 1 : r)]++] = i; }
    const nD = nV < drawCap - nl ? nV : drawCap - nl;
    while (a < nl || b < nD) o2[nd++] = b >= nD || (a < nl && Z[order[a]] >= Z[ds[b]]) ? order[a++] : ds[b++];
    this._pack(o2, nd, T);
    this._culled = culled; this._undrawn = und; this._drawn40 = d40; this._drawnDying = nD;
    // carpet: density from the undrawn + queued mass; its front meets the farthest drawn unit while the cap binds
    const C = CROWD.carpet, dn = C.density, kw = !this._fled && this._alive + this._qN > 0 ? 1 : 0;
    let want = C.front;
    if (und > 0 && nl > 0) { const zf = Z[order[nl - 1]] - 1; want = zf < C.front ? C.front : (zf > C.nearest ? C.nearest : zf); }
    this._carpetFront += (want - this._carpetFront) * Math.min(1, dt * C.ease);
    this._carpetK += Math.max(-dt / C.fade, Math.min(dt / C.fade, kw - this._carpetK));
    this._density = Math.max(dn[2], Math.min(1, (this._qN + und + dn[0]) / dn[1])) * this._carpetK;
    if (rules && rules.end) rules.end(dt);
    this._tickEl = this._el();
    if (this._killN > 0 && this.t - this._killT >= 1 / CROWD.killsHz - 1e-6) {
      P_KILLS.n = this._killN; P_KILLS.coins = this._killCoins; P_KILLS.x = this._killX / this._killN; P_KILLS.z = this._killZ / this._killN;
      this._killN = 0; this._killCoins = 0; this._killX = 0; this._killZ = 0; this._killT = this.t;
      if (this.ctx.events) this.ctx.events.emit('crowd:kills', P_KILLS);
    }
  }

  /** A climber / breacher at the squad line: the rule decides; without one it bites and dies. */
  _reach(i, rules) { if (rules && rules.onReach) rules.onReach(i); else this.kill(i, 'bite'); }

  /** The render camera's view terms for _inView (a hold-rig stand-in without a renderer: node, tests). */
  _view() {
    const r = this.ctx.render;
    let cam = r && r.camera;
    if (!cam) {
      if (!this._cam) {
        const c = this._cam = new PerspectiveCamera(55, 390 / 844, 0.1, 200);
        c.position.set(0, 10.8, 10.3); c.lookAt(0, 0, -11); c.updateMatrixWorld(); c.matrixWorldInverse.copy(c.matrixWorld).invert();
      }
      cam = this._cam;
    }
    const e = cam.matrixWorldInverse.elements;
    this._vm0 = e[0]; this._vm2 = e[2]; this._vm8 = e[8]; this._vm10 = e[10]; this._vmx = e[12] + e[4] * 0.9; this._vmz = e[14] + e[6] * 0.9;
    this._tanH = Math.tan(cam.fov * Math.PI / 360) * cam.aspect;
  }

  /** A unit's centre (y 0.9) is within the view's horizontal bounds (+ 1 m). */
  _inView(x, z) {
    const xv = this._vm0 * x + this._vm8 * z + this._vmx, zv = this._vm2 * x + this._vm10 * z + this._vmz;
    return zv < 0 && (xv < 0 ? -xv : xv) <= -zv * this._tanH + 1;
  }

  /** LOD split by rank and band, the texels (LOD1 reuses the cross-fade band's texels), the draw ranges. */
  _pack(order, nd, T) {
    const X = this.x, Z = this.z, VX = this.vx, VZ = this.vz, st = this.state, D = this._texData;
    let n0 = 0, n1e;
    while (n0 < nd && n0 < T.lod0 && Z[order[n0]] > T.lod0Z) n0++;
    const xfn = this._soft ? 0 : (CROWD.xfade < n0 >> 1 ? CROWD.xfade : n0 >> 1), xf0 = n0 - xfn;   // ≤ half the LOD0 slots
    for (n1e = n0; n1e < nd && Z[order[n1e]] > T.lod1Z;) n1e++;
    for (let k = 0, o = 0; k < nd; k++, o += 8) {
      const i = order[k], dying = st[i] === S_DYING, fq = k < xf0 ? 15 : (k < n0 ? Math.round(15 * (n0 - k) / (xfn + 1)) : 0);
      D[o] = X[i]; D[o + 1] = Z[i]; D[o + 2] = dying ? 0 : VX[i]; D[o + 3] = dying ? 0 : VZ[i];
      D[o + 4] = this.phase[i]; D[o + 5] = this.look[i] + 8192 * fq; D[o + 6] = dying ? this.deathT[i] : -1; D[o + 7] = this.hitT[i];
    }
    if (this._built) {
      this._commit(this._m0, n0, 0); this._commit(this._m1, n1e - xf0, xf0); this._commit(this._m2, nd - n1e, n1e);
      // the first cast units cast a shadow (High) and drop the disc, in LOD0 and in the LOD1 copies of the cross-fade band
      const sun = this.ctx.render.lights.sun, cast = this._m0.castShadow && sun && sun.castShadow ? Math.min(n0, T.shadows) : 0;
      this._depthU.uN.value = cast; this._m0.material.uniforms.uNoDisc.value = cast; this._m1.material.uniforms.uNoDisc.value = cast > xf0 ? cast - xf0 : 0;
      if (nd > 0 || this._nd > 0) { this._tex.needsUpdate = true; this.perf.uploads++; }
    }
    this._nd = nd; this._n0 = n0; this._xf0 = xf0; this._n1e = n1e;
  }

  _commit(mesh, n, base) {
    mesh.geometry.instanceCount = Math.ceil(n / mesh.userData.K); mesh.visible = n > 0;
    mesh.material.uniforms.uBase.value = base; mesh.material.uniforms.uN.value = n;
  }

  // ---------------------------------------------------------------------------------------------- weapons target provider
  /** Nearest hittable unit whose capsule meets the swept segment seg [x0, z0, x1, z1] inflated by radius. out { id, x, y, z, t }. */
  hitTestSeg(seg, radius, out) {
    if (this._alive === 0 || !this.active || this._fled) return false;
    const x0 = seg[0], z0 = seg[1], x1 = seg[2], z1 = seg[3], dx = x1 - x0, dz = z1 - z0, len2 = dx * dx + dz * dz, pad = radius + MAX_HITR + PAD;
    const zmin = (z0 < z1 ? z0 : z1) - pad, zmax = (z0 > z1 ? z0 : z1) + pad, c0 = colOf((x0 < x1 ? x0 : x1) - pad), c1 = colOf((x0 > x1 ? x0 : x1) + pad);
    let any = false;
    for (let c = c0; c <= c1; c++) if (this._colFront[c] >= zmin) { any = true; break; }   // nothing that far forward: a miss
    if (!any) return false;
    const X = this.x, Z = this.z, st = this.state, ty = this.type, cs = this._cs, cl = this._cl;
    let bestT = 2, best = -1;
    for (let r = rowOf(zmax), r0 = rowOf(zmin); r >= r0; r--) {
      for (let c = c0; c <= c1; c++) {
        for (let a = cs[r * GCOLS + c], e = cs[r * GCOLS + c + 1]; a < e; a++) {
          const i = cl[a], t = ty[i], zi = Z[i];
          if (st[i] !== S_ALIVE || (t === T_CRAWLER && zi <= HIT_Z)) continue;
          let u = 0;
          if (len2 > 0) { u = ((X[i] - x0) * dx + (zi - z0) * dz) / len2; u = u < 0 ? 0 : (u > 1 ? 1 : u); }
          const ex = x0 + dx * u - X[i], ez = z0 + dz * u - zi, rr = HITR[t] + radius;
          if (ex * ex + ez * ez <= rr * rr && u < bestT) { bestT = u; best = i; }
        }
      }
    }
    if (best < 0) return false;
    out.id = this.idOf(best); out.t = bestT; out.x = x0 + dx * bestT; out.z = z0 + dz * bestT; out.y = Math.min(BULLET_Y, HEIGHT[ty[best]]);
    return true;
  }

  /** A round on unit id, its leftover carried to the next unit behind in the same 1 m column (≤ pierceMax units, within the
   *  rifle reach). Returns the leftover. */
  applyHit(id, damage, pierceMax, x, y, z, cause) {
    let i = this.slotOf(id);
    if (i < 0 || this._fled) return damage;
    const col = colOf(this.x[i]), fx = this.x[i], fz = this.z[i], max = pierceMax >= 1 ? pierceMax : 1;
    let left = damage, hits = 0, lx = fx, lz = fz;
    for (;;) {
      hits++; lx = this.x[i]; lz = this.z[i];
      if (!this._damage(i, left, cause)) { left = 0; break; }
      left -= this._dmgUsed;
      if (left <= 0 || hits >= max || (i = this._behind(col, lz)) < 0) break;
    }
    if (hits > 1 && this._built) this._streak(fx, fz, lx, lz);
    return left > 0 ? left : 0;
  }

  /** Damage on slot i; true when it died (this._dmgUsed = the HP it took). Flash once per flashCool, never the killing hit. */
  _damage(i, amount, cause) {
    const hp = this.hp[i];
    if (amount >= hp) { this._dmgUsed = hp; this.hp[i] = 0; this.kill(i, cause); return true; }
    this.hp[i] = hp - amount; this._dmgUsed = amount;
    const el = this._el();
    if (el - this.hitT[i] >= RD.flashCool) this.hitT[i] = el;
    return false;
  }

  /** The nearest hittable living unit behind z in grid column col, within the rifle reach; −1 when none. */
  _behind(col, z) {
    const st = this.state, Z = this.z, ty = this.type, cs = this._cs, cl = this._cl;
    for (let r = rowOf(z), r0 = rowOf(F.rangeZ); r >= r0; r--) {
      let best = -1, bz = F.rangeZ;
      for (let a = cs[r * GCOLS + col], e = cs[r * GCOLS + col + 1]; a < e; a++) {
        const i = cl[a], zi = Z[i];
        if (st[i] === S_ALIVE && zi < z && zi > bz && (ty[i] !== T_CRAWLER || zi > HIT_Z)) { best = i; bz = zi; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Living units listed in the grid cells overlapping [xa, xb] × [za, zb] (+ the list age pad) into this._cand; → count
   *  (none once the hold is won). */
  _collect(xa, xb, za, zb) {
    const cs = this._cs, cl = this._cl, st = this.state, cand = this._cand, c0 = colOf(xa - PAD), c1 = colOf(xb + PAD);
    let n = 0;
    if (this._fled) return 0;
    for (let r = rowOf(zb + PAD), r0 = rowOf(za - PAD); r >= r0; r--) {
      for (let c = c0; c <= c1; c++) for (let a = cs[r * GCOLS + c], e = cs[r * GCOLS + c + 1]; a < e; a++) if (st[cl[a]] === S_ALIVE) cand[n++] = cl[a];
    }
    return n;
  }

  /** Area damage (rocket blast, airstrike): every living unit whose capsule touches the circle. → kills. */
  damageInCircle(x, z, r, amount, cause) {
    const p = r + MAX_HITR, cand = this._cand;
    let kills = 0;
    for (let k = 0, n = this._collect(x - p, x + p, z - p, z + p); k < n; k++) {
      const i = cand[k], dx = this.x[i] - x, dz = this.z[i] - z, rr = r + HITR[this.type[i]];
      if (this.state[i] === S_ALIVE && dx * dx + dz * dz <= rr * rr && this._damage(i, amount, cause)) kills++;
    }
    return kills;
  }

  /** Line damage (rail, laser): |ux − x| ≤ halfWidth + radius and zMin ≤ uz ≤ z0, under-bullet crawlers spared, the nearest
   *  first when maxTargets is finite. → kills. */
  damageInLine(x, z0, halfWidth, amount, cause, maxTargets, zMin) {
    const zm = zMin === zMin && zMin !== undefined ? zMin : G.z0, Z = this.z, cand = this._cand, p = halfWidth + MAX_HITR;
    if (zm > z0) return 0;
    let n = 0, kills = 0;
    for (let k = 0, m = this._collect(x - p, x + p, zm, z0); k < m; k++) {
      const i = cand[k], zi = Z[i], w = halfWidth + HITR[this.type[i]], d = this.x[i] - x;
      if (zi >= zm && zi <= z0 && d <= w && d >= -w && (this.type[i] !== T_CRAWLER || zi > HIT_Z)) cand[n++] = i;
    }
    const lim = maxTargets >= 0 && maxTargets < n ? maxTargets | 0 : n;
    for (let q = 0; q < lim; q++) {
      if (lim < n) { let bi = q; for (let s = q + 1; s < n; s++) if (Z[cand[s]] > Z[cand[bi]]) bi = s; const s = cand[q]; cand[q] = cand[bi]; cand[bi] = s; }
      if (this.state[cand[q]] === S_ALIVE && this._damage(cand[q], amount, cause)) kills++;
    }
    return kills;
  }

  /** Cone damage (flamer) from (x, z) along (dirX, dirZ), half angle in rad (degrees when > π), within range. → kills. */
  damageInCone(x, z, dirX, dirZ, halfAngle, range, amount, cause) {
    const cosH = Math.cos(halfAngle > Math.PI ? halfAngle * Math.PI / 180 : halfAngle), l = Math.sqrt(dirX * dirX + dirZ * dirZ);
    const ux = l > 0 ? dirX / l : 0, uz = l > 0 ? dirZ / l : -1, p = range + MAX_HITR, cand = this._cand;
    let kills = 0;
    for (let k = 0, n = this._collect(x - p, x + p, z - p, z + p); k < n; k++) {
      const i = cand[k], dx = this.x[i] - x, dz = this.z[i] - z, d = Math.sqrt(dx * dx + dz * dz), hr = HITR[this.type[i]];
      if (this.state[i] === S_ALIVE && d <= range + hr && (d <= hr || (dx * ux + dz * uz) / d >= cosH) && this._damage(i, amount, cause)) kills++;
    }
    return kills;
  }

  /** Nearest living unit to (x, z) (of type t when t ≥ 0). out { id, x, y, z }. */
  _nearest(t, x, z, out) {
    let best = -1, bd = Infinity;
    for (let k = 0; k < this.nLive; k++) {
      const i = this.live[k];
      if (this.state[i] !== S_ALIVE || (t >= 0 && this.type[i] !== t)) continue;
      const dx = this.x[i] - x, dz = this.z[i] - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best >= 0 && this._out(best, out);
  }

  _out(i, out) { out.id = this.idOf(i); out.x = this.x[i]; out.z = this.z[i]; out.y = HEIGHT[this.type[i]] * 0.6; return true; }
  nearest(x, z, out) { return this._alive > 0 && !this._fled && this._nearest(-1, x, z, out); }
  nearestOfType(type, x, z, out) { const t = this.typeIndex(type); return t >= 0 && this._byType[t] > 0 && !this._fled && this._nearest(t, x, z, out); }

  /** Highest-HP living unit in front of the squad (farZ ≤ z < 0), units through a breach aside. out { id, x, y, z, hp }. */
  highestHp(out, farZ = -Infinity) {
    let best = -1, bh = -1;
    if (this._fled) return false;
    for (let k = 0; k < this.nLive; k++) {
      const i = this.live[k], z = this.z[i];
      if (this.state[i] === S_ALIVE && this.mode[i] !== M_PASS && z < 0 && z >= farZ && this.hp[i] > bh) { bh = this.hp[i]; best = i; }
    }
    if (best < 0) return false;
    out.hp = bh;
    return this._out(best, out);
  }

  /** The densest 1 m cell (living units at the last sort) centred in [x0, x1] × [z0, z1], ties to the wall. out { x, z, n }. */
  densestCell(x0, x1, z0, z1, out) {
    const cc = this._cc, ca = colOf(x0), cb = colOf(x1);
    let best = 0, bc = -1;
    if (this._fled) return false;
    for (let r = rowOf(z1), r0 = rowOf(z0); r >= r0; r--) {
      for (let c = ca; c <= cb; c++) if (cc[r * GCOLS + c] > best) { best = cc[r * GCOLS + c]; bc = r * GCOLS + c; }
    }
    if (bc < 0) return false;
    out.x = G.x0 + (bc % GCOLS) + 0.5; out.z = G.z0 + Math.floor(bc / GCOLS) + 0.5; out.n = best;
    return true;
  }

  // ---------------------------------------------------------------------------------------------- render (per frame)
  render() {
    const t0 = nowMs();
    if (!this.active) { this._sampleRef(); return; }
    if (this._built) {
      const s = this._el() - this._tickEl, ku = this._carpet.material.uniforms;
      this._cu.uSince.value = s > 0.1 ? 0.1 : (s < 0 ? 0 : s);
      this._syncLights();
      ku.uFront.value = this._carpetFront; ku.uDensity.value = this._density; this._carpet.visible = this._density > 0;
      if (this._trDirty) { this._trDirty = false; this._trA.needsUpdate = true; this._trB.needsUpdate = true; }
      if (this._goDirty) { this._goDirty = false; this._goA.needsUpdate = true; this._goR.needsUpdate = true; }
    }
    this._governor();
    this.perf.renderMs += nowMs() - t0; this.perf.renderN++;
  }

  /** Frame intervals of a playing level while the crowd is idle (the last refS s): the governor's reference. */
  _sampleRef() {
    const ctx = this.ctx, tm = ctx.time;
    if (!tm || !ctx.state || !ctx.state.is('playing')) { this._lastNow = -1; return; }
    const iv = this._lastNow < 0 ? 0 : tm.now - this._lastNow, N = this._refIv.length;
    this._lastNow = tm.now;
    if (!(iv > 0) || iv > GOV.hitchMs) return;
    if (this._refN === N) { this._refSum -= this._refIv[this._refHead]; this._refN--; if (++this._refHead === N) this._refHead = 0; }
    let k = this._refHead + this._refN; if (k >= N) k -= N;
    this._refIv[k] = iv; this._refN++; this._refSum += iv;
    while (this._refSum > GOV.refS * 1000 && this._refN > 1) {
      this._refSum -= this._refIv[this._refHead]; this._refN--; if (++this._refHead === N) this._refHead = 0;
    }
  }

  /** The reference: the median sampled interval (the engine's sustained one before 10 samples), never below the engine's
   *  frame target max(refresh, 16.67 ms) — a 90 / 120 Hz panel holding 60 fps is on target, as for the auto-scaler. */
  _refMedian() {
    const n = this._refN, s = this._refSort, N = this._refIv.length, e = this.ctx.engine, tgt = e && e.frameTargetMs > 0 ? e.frameTargetMs : 1000 / 60;
    let m = e && e.sustainedFrameMs > 0 ? e.sustainedFrameMs : tgt;
    if (n >= 10) {
      for (let k = 0, h = this._refHead; k < n; k++) { s[k] = this._refIv[h]; if (++h === N) h = 0; }
      m = s.subarray(0, n).sort()[n >> 1];
    }
    return m > tgt ? m : tgt;
  }

  /** The drawn-cap governor (fixed on software GL) and the engine's scalerGuard. */
  _governor() {
    const ctx = this.ctx, tm = ctx.time, eng = ctx.engine, T = this._T, iv = this._lastNow < 0 || !tm ? 0 : tm.now - this._lastNow;
    if (tm) this._lastNow = tm.now;
    if ((!ctx.state || ctx.state.is('playing')) && iv > 0 && iv < GOV.hitchMs) {
      const ema = this._ivEma = this._ivEma > 0 ? this._ivEma + (iv - this._ivEma) * GOV.ema : iv;
      if (this._tier !== 'sw') {
        if (ema > GOV.up * this._ref) { this._slowT += iv; this._fastT = 0; }
        else { this._slowT = 0; this._fastT = ema <= GOV.raise * this._ref ? this._fastT + iv : 0; }
        if (this._slowT >= GOV.upS * 1000 && this._govCap > T.floor) { this.debugGovernor(-1); this._slowT = 0; }
        else if (this._fastT >= GOV.raiseS * 1000 && this._govCap < T.cap) { this.debugGovernor(1); this._fastT = 0; }
      }
      this._floorT = this._govCap <= T.floor ? this._floorT + iv : 0;
    }
    if (eng && eng.scalerGuard) { eng.scalerGuard.exemptMs = this._frameMs; eng.scalerGuard.dropOk = this._floorT >= GOV.dropOkS * 1000; }
    this._frameMs = 0;
  }

  /** 'crowd:governor' { cap, living (A13(b)), floor, ref } with the current drawn cap. */
  _logGov() {
    const cap = this._govCap;
    P_GOV.cap = cap; P_GOV.living = Math.floor(cap * (1 - CROWD.dyingReserve)); P_GOV.floor = this._T.floor; P_GOV.ref = this._ref;
    if (this.ctx.events) this.ctx.events.emit('crowd:governor', P_GOV);
  }

  _syncLights() {
    const L = this.ctx.render.lights, sun = L.sun, hemi = L.hemi, k = 1 / Math.PI, u = this._cu;
    if (sun) {
      u.uSunDir.value.copy(_v.copy(sun.position).sub(sun.target.position).normalize()); u.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity * k);
    }
    if (hemi) { u.uSky.value.copy(hemi.color).multiplyScalar(hemi.intensity * k); u.uGround.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity * k); }
    u.uFill.value.copy(u.uSunCol.value).multiplyScalar(RD.fill[0]).add(_c.copy(u.uSky.value).multiplyScalar(RD.fill[1]));
  }

  /** The pierce streaks' draw on / off (a hold's draw budget while a laser fires). */
  setStreaks(on) { if (this._built) this._tracers.visible = on; }

  _streak(x0, z0, x1, z1) {
    const k = this._trNext, A = this._trA.array, B = this._trB.array, TR = CROWD.tracers;
    this._trNext = k + 1 < TR.cap ? k + 1 : 0;
    A[k * 4] = x0; A[k * 4 + 1] = TR.y; A[k * 4 + 2] = z0; A[k * 4 + 3] = this._el();
    B[k * 4] = x1; B[k * 4 + 1] = TR.y; B[k * 4 + 2] = z1; B[k * 4 + 3] = Math.max(0.02, (z0 - z1) / TR.speed);
    this._trDirty = true;
  }

  _goreAt(x, z, el) {
    const k = this._goNext, a = this._goA.array, rf = this.ctx.rngFx, g = CROWD.gore;
    this._goNext = k + 1 < this._T.gore ? k + 1 : 0;
    a[k * 4] = x; a[k * 4 + 1] = z; a[k * 4 + 2] = g.size[0] + (g.size[1] - g.size[0]) * (rf ? rf.next() : 0.5); a[k * 4 + 3] = el;
    this._goR.array[k] = rf ? rf.next() * 6.283 : 0;
    this._goDirty = true;
  }

  // ---------------------------------------------------------------------------------------------- meshes (prepare)
  _build() {
    if (this._built) return;
    const ctx = this.ctx, render = ctx.render, uTime = render.uniforms.uTime, P = CROWD.palette, E = CROWD.eye, [K0, K1, K2] = RD.K;
    const soft = this._soft = !!(ctx.quality && ctx.quality.software);   // fixed for the session (render.init's detection)
    const tex = this._tex = new DataTexture(this._texData, TEX_W, TEX_ROWS, RGBAFormat, FloatType);
    tex.minFilter = NearestFilter; tex.magFilter = NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    const cu = this._cu = UniformsUtils.merge([UniformsLib.fog, {
      uSince: { value: 0 }, uDeathS: { value: RD.deathS }, uFlash: { value: RD.flash }, uBodyMax: { value: RD.bodyMax }, uSac: { value: RD.sac },
      uSunDir: { value: new Vector3(0, 1, 0) }, uSunCol: { value: new Color(1, 1, 1) }, uSky: { value: new Color() }, uGround: { value: new Color() },
      uFill: { value: new Color() }, uEye: { value: lin(E.color).multiplyScalar(E.hdr) }, uEyeZ: { value: new Vector4(E.nearZ, E.bandZ, E.farZ, 0) },
      uEyeK: { value: new Vector2(E.band, E.far) }, uHip: { value: 0.79 },
    }]);
    cu.uTime = uTime; cu.uData = { value: tex };
    for (let i = 0; i < 4; i++) {
      cu['uSk' + i] = { value: lin(P.skin[i]) }; cu['uSh' + i] = { value: lin(P.shirt[i]) }; cu['uPa' + i] = { value: lin(P.pants[i]) };
    }
    cu.uRunSk = { value: lin(P.runner[0]) }; cu.uRunSh = { value: lin(P.runner[1]) }; cu.uBruSk = { value: lin(P.brute[0]) };
    cu.uBruCl = { value: lin(P.brute[1]) }; cu.uSpiSk = { value: lin(P.spitter[0]) }; cu.uSpiSac = { value: lin(P.spitter[1]) };
    for (let t = 0; t < NT; t++) {
      const u = CROWD.units[TYPES[t]];
      cu['uG' + t] = { value: new Vector4(u.gait[0], u.gait[1], u.leg, u.arm) };
      cu['uP' + t] = { value: new Vector4(u.armRest, u.bob, u.pitch || 0, u.lift || 0) };
      cu['uS' + t] = { value: new Vector4(u.scale[0], u.scale[1], u.scale[2], 0) };
    }
    const own = (base, extra) => { const u = {}; for (const k in base) u[k] = base[k]; return Object.assign(u, extra); };
    const mat = (vs, fs, K, name, opts) => Object.assign(new ShaderMaterial(Object.assign({
      uniforms: own(cu, { uBase: { value: 0 }, uN: { value: 0 }, uNoDisc: { value: 0 } }), vertexShader: vs, fragmentShader: fs, fog: true, defines: { GR_K: K },
    }, opts)), { name });
    const mesh = (g, m, K) => { const o = new Mesh(g, m); o.frustumCulled = false; o.name = m.name; o.userData.K = K; o.visible = false; return o; };
    const group = this._group = new Group();
    group.name = 'crowd'; group.visible = this.active;
    // LOD0: the run walker (+ disc), every type reshaped in the shader; the High casters' depth material shares its code
    const wg = ctx.models && ctx.models.geo && ctx.models.geo.walker;
    if (!wg) throw new Error('crowd: models.geo.walker missing (ModelLibrary.init first)');
    const src = lod0Source(wg), names = ['position', 'normal', 'aPiv', 'aMat'];
    cu.uHip.value = src.userData.hip;
    this._m0 = mesh(mergeK(src, K0, names), mat(VERT(false), FRAG(false, soft), K0, 'crowd.lod0'), K0);
    this._m1 = mesh(mergeK(buildBody(), K1, names), mat(VERT(true), FRAG(true, soft), K1, 'crowd.lod1'), K1);
    const imp = new InstancedBufferGeometry();
    imp.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
    imp.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    this._m2 = mesh(mergeK(imp, K2, ['position']), mat(IMP_VERT, IMP_FRAG, K2, 'crowd.lod2', { side: DoubleSide }), K2);
    this._depthU = own(cu, { uBase: { value: 0 }, uN: { value: 0 } });
    this._depth = this._m0.customDepthMaterial = new ShaderMaterial({ uniforms: this._depthU, vertexShader: VERT(false), fragmentShader: DEPTH_FRAG,
      defines: { GR_K: K0, GR_DEPTH: 1 } });
    this._depth.name = 'crowd.lod0.depth';
    // carpet, pierce streaks, gore ring: instanced quads
    const quad = (y0, w, attrs, n) => {
      const q = new PlaneGeometry(w, 1), g = new InstancedBufferGeometry();
      q.translate(0, y0, 0); g.setIndex(q.index); g.setAttribute('position', q.attributes.position);
      for (const k in attrs) g.setAttribute(k, attrs[k]);
      g.instanceCount = n;
      return g;
    };
    const fx = (u, vs, fs, name, opts) => Object.assign(new ShaderMaterial(Object.assign({
      uniforms: Object.assign(UniformsUtils.merge([UniformsLib.fog, u]), { uTime }), vertexShader: vs, fragmentShader: fs, fog: true,
    }, opts)), { name });
    const C = CROWD.carpet, rows = CROWD.tiers.high.carpetRows, ar = new Float32Array(rows);
    for (let i = 0; i < rows; i++) ar[i] = i;
    const km = fx({ uFront: { value: C.front }, uBack: { value: C.back }, uSpeed: { value: C.speed }, uHalf: { value: C.half }, uRows: { value: rows },
      uDensity: { value: 0 }, uEyeCarpet: { value: E.carpet } }, CARPET_VERT, CARPET_FRAG, 'crowd.carpet', { side: DoubleSide });
    Object.assign(km.uniforms, { uSunDir: cu.uSunDir, uSunCol: cu.uSunCol, uSky: cu.uSky, uGround: cu.uGround, uEye: cu.uEye });
    this._carpet = mesh(quad(0.5, 2, { aRow: new InstancedBufferAttribute(ar, 1) }, rows), km, 1);
    const TR = CROWD.tracers, dyn = (n, s) => { const a = new InstancedBufferAttribute(new Float32Array(n * s), s); a.setUsage(DynamicDrawUsage); return a; };
    this._trA = dyn(TR.cap, 4); this._trB = dyn(TR.cap, 4); this._trNext = 0; this._trDirty = false;
    for (let i = 0; i < TR.cap; i++) { this._trA.array[i * 4 + 3] = -1e4; this._trB.array[i * 4 + 3] = 0.001; }
    this._tracers = mesh(quad(0.5, 1, { aA: this._trA, aB: this._trB }, TR.cap), fx({ uColor: { value: lin(TR.color).multiplyScalar(TR.hdr) },
      uLen: { value: TR.len } }, TR_VERT, TR_FRAG, 'crowd.tracers', { blending: AdditiveBlending, depthWrite: false, transparent: true, side: DoubleSide }), 1);
    const GC = CROWD.tiers.high.gore;
    this._goA = dyn(GC, 4); this._goR = dyn(GC, 1); this._goNext = 0; this._goDirty = false;
    for (let i = 0; i < GC; i++) this._goA.array[i * 4 + 1] = 500;
    this._gore = mesh(quad(0, 1, { aG: this._goA, aR: this._goR }, GC), fx({ uColor: { value: lin(CROWD.gore.color) } }, GORE_VERT, GORE_FRAG, 'crowd.gore',
      { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), 1);
    this._tracers.renderOrder = 5; this._gore.renderOrder = 1; this._tracers.visible = true; this._gore.visible = true;
    group.add(this._m0, this._m1, this._m2, this._carpet, this._tracers, this._gore);
    render.scene.add(group);
    this._built = true;
    this._applyTier();
  }

  // ---------------------------------------------------------------------------------------------- debug API (?debug=1)
  /** A synthetic hold on the running level for measurement: road stopped, run zombies / gates / crates cleared, the wall
   *  formation, the hold rig, a lane-sweeping fire policy at this crowd; o { alive (inside 40 m, denser at the pile), queued
   *  (in the feed band), seed }, topped up so the peak stays put. The level's step stays parked until the next reset. */
  debugDemo(o) {
    const ctx = this.ctx, w = ctx.world, lvl = ctx.level;
    if (!ctx.debug || !ctx.debug.enabled) return false;
    o = o || {};
    const nA = o.alive >= 0 ? o.alive | 0 : 1300, nQ = o.queued >= 0 ? o.queued | 0 : 500, rng = this._rng;
    this.begin({ seed: o.seed || 1 });
    if (lvl) lvl.step = () => { w.roadSpeed = 0; };
    w.roadSpeed = 0; w.invulnerable = true;
    if (ctx.zombies) ctx.zombies.killAll('cleanup');
    if (ctx.gates) ctx.gates.reset();
    if (ctx.pickups) ctx.pickups.reset();
    if (ctx.squad) ctx.squad.setFormation('wall', { easeS: 0 });
    if (ctx.render) ctx.render.setRig('hold', 0);
    if (ctx.weapons) ctx.weapons.setPolicy(this._demoPolicy);
    const fd = this._feed;
    fd.fill(0);
    for (let k = 0, tries = 0; k < nA + nQ && this.nFree > 0 && tries < 50 * (nA + nQ); tries++) {
      const z = k < nA ? F.wallZ - R - 39.7 * Math.pow(rng.next(), 1.6) : F.feedZ[0] + (F.feedZ[1] - F.feedZ[0]) * rng.next();
      const x = (rng.next() * 2 - 1) * (halfAt(z) - R), c = rowOf(z) * GCOLS + colOf(x);
      if (fd[c] >= (k < nA ? 4 : F.feedDens)) continue;
      fd[c]++; k++;
      this._spawn(k <= nA && rng.next() < 0.2 ? 1 : 0, x, z, (rng.next() * 2 - 1) * 3.6, 1);
    }
    this._demo = nA + nQ;
    return true;
  }

  /** One governor step (dir < 0 down by ×down to the floor, else up by +step to the tier cap; none on software GL) → the cap. */
  debugGovernor(dir) {
    const T = this._T;
    if (this._tier === 'sw') return this._govCap;
    const cap = this._govCap = dir < 0 ? Math.max(T.floor, Math.round(this._govCap * GOV.down)) : Math.min(T.cap, Math.round(this._govCap * (1 + GOV.step)));
    this._logGov();
    return cap;
  }

  get debugMeshes() {
    if (!this._built) return null;
    return { lod0: this._m0, lod1: this._m1, lod2: this._m2, carpet: this._carpet, depth: this._depth, tracers: this._tracers, gore: this._gore, tex: this._tex };
  }

  /** Counters for the overlay and the harness (allocates: debug only). */
  stats() {
    const P = this.perf, n = Math.min(P.nSteps, 4096), s = Array.from(P.steps.subarray(0, n)).sort((a, b) => a - b), cap = this._govCap;
    return { tier: this._tier, alive: this._alive, waiting: this.waiting, queued: this._qN, kills: this.kills, bites: this.bites,
      drawn: [this._n0, this._n1e - this._n0, this._nd - this._n1e], drawnTotal: this._nd, drawn40: this._drawn40, drawnDying: this._drawnDying,
      culled: this._culled,
      undrawn: this._undrawn, carpetFront: this._carpetFront, governorCap: cap, livingCap: Math.floor(cap * (1 - CROWD.dyingReserve)), floor: this._T.floor,
      reference: this._ref, dropOk: this._floorT >= GOV.dropOkS * 1000, shadowCasters: this._built && this._m0.castShadow ? this._depthU.uN.value : 0,
      tickA: P.nA ? P.msA / P.nA : 0, tickB: P.nB ? P.msB / P.nB : 0, stepMean: n ? s.reduce((a, b) => a + b, 0) / n : 0,
      stepP95: n ? s[Math.floor(0.95 * (n - 1))] : 0,
      stepMax: n ? s[n - 1] : 0, renderMs: P.renderN ? P.renderMs / P.renderN : 0, uploads: P.uploads, uploadBytes: this._built ? TEX_W * TEX_ROWS * 16 : 0 };
  }

  /** Zeroes the perf counters (the harness's measuring window). */
  debugReset() { const P = this.perf; P.msA = 0; P.nA = 0; P.msB = 0; P.nB = 0; P.renderMs = 0; P.renderN = 0; P.nSteps = 0; P.uploads = 0; }
}
