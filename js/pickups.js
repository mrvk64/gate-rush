// js/pickups.js — Gate Rush: crates and coin lines (ARCHITECTURE §6.10, GDD §8 / §9.1 / J12 / J19).
//
// Crates: pool of 8 drawn as ONE InstancedMesh (own merged box geometry with aPart / aSeam attributes and a
// MeshStandardMaterial whose onBeforeCompile chunk pops the lid open per instance from `iCrate.x`, glows the
// seams emissively and flashes the box in the seam tint on a rate-limited hit) — one draw for every crate on screen. A crate opens on
// PICKUPS.crate.hitsToOpen bullet hits or on contact within PICKUPS.collectRadius; the item is granted at that
// moment (grantItem) and fx answers item:pickup with the J12 icon flight. Coins: InstancedMesh 64, spinning and
// bobbing, pulled at PICKUPS.magnetPull inside the magnet radius (GEAR.magnet.baseRadius, or GEAR.magnet.radius
// after the magnet gear) and collected at PICKUPS.coinCollect → coin:pickup { source:'pile' }.
// grantItem routes 'weapon.*' → weapons.storeWeapon (round 6: stored in the FIFO weapon slot, started by the player's
// FIRE; a full slot pays PICKUPS.replaceRefund as coin:pickup { source:'refund' } — weapons emits it — and the pickup
// reports duplicate), 'gear.*' → weapons.startGear, 'troop.*' → troops.add
// (a duplicate troop pays PICKUPS.duplicateCoins as coin:pickup { source:'duplicate' }), 'coins' →
// coin:pickup { amount: PICKUPS.crateCoins, source:'crate' }; it always emits item:pickup { item, x, z, duplicate }.
// An opened crate pops its lid (J12), then shrinks away and frees its slot; the J12 icon flight is fx's.
// Ids are stable handles: (generation << 12) | slot (ARCH D6). step() is not called in the title idle scene.
//
// Per-instance attribute (own crate material, onBeforeCompile, customProgramCacheKey 'gr:crate'):
//   iCrate vec4 = (lidOpen 0..~1.15 (ease-out-back), last flash start (ctx.time.elapsed s, = uTime clock; restarts at
//                 most every PICKUPS.crate.hitFlashRetrigger), hits01, 0)
import {
  InstancedMesh, InstancedBufferAttribute, BoxGeometry, CylinderGeometry, MeshStandardMaterial, Color,
  DynamicDrawUsage, Float32BufferAttribute, MeshDepthMaterial, RGBADepthPacking,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, FIRE, GEAR, PICKUPS, PALETTE } from './data.js';
import { warnOnce } from './util.js';

// ---------------------------------------------------------------------------------------------
// Capacities and feel constants (all from data.js: PICKUPS.crate / PICKUPS.coin / PALETTE.crate)
// ---------------------------------------------------------------------------------------------
const CRATE_POOL = PICKUPS.crate.pool;          // 8
const COIN_POOL = PICKUPS.coinPool;             // 64
const CRATE_SIZE = PICKUPS.crate.size;          // 0.8 m box
const PC = PICKUPS.crate, PK = PICKUPS.coin;
const CRATE_BODY_FRAC = PC.bodyFrac;            // body height as a fraction of the box (lid = the rest)
const CRATE_LID_OVERHANG = PC.lidOverhang;      // lid is 4 % wider than the body
const CRATE_SEAM_W = PC.seamWidth;              // emissive seam strip width (m)
const CRATE_YAW_JITTER = PC.yawJitter;          // ± yaw (rad) per crate from ctx.rngFx (cosmetic)
const CRATE_LID_TIME = PC.lidPopSeconds;        // J12 "lid pops" (within the 0.6 s J12 window)
const CRATE_LID_ANGLE = PC.lidAngle;            // rad the lid flips back
const CRATE_LID_LIFT = PC.lidLift;              // m the lid jumps while flipping
const CRATE_HIT_FLASH = PC.hitFlash;            // s of tinted flash per (rate-limited) bullet hit
const CRATE_HIT_FLASH_GAIN = PC.hitFlashGain;   // flash = seam colour (HDR) × decay × gain (QA GAT-10: never a white cube)
const CRATE_HIT_RETRIGGER = PC.hitFlashRetrigger;   // s before a new hit may restart the flash / punch (a pulse under fire)
const CRATE_SEAM_EMISSIVE = PC.seamEmissive;    // HDR seam glow (= RENDER.gateFrameEmissive)
const CRATE_SEAM_PULSE_HZ = PC.seamPulseHz;
const CRATE_HIT_PUNCH = PC.hitPunch;            // scale punch per flash start (decays over CRATE_HIT_FLASH)
const CRATE_SEAM_HIT_GAIN = PC.seamHitGain;     // seams glow brighter with each hit (× (1 + gain·hits01))
const CRATE_VANISH_DELAY = PC.vanishDelay;      // s after opening before the box shrinks away
const CRATE_VANISH_TIME = PC.vanishTime;        // shrink duration; the slot is freed at the end
const CRATE_COLOR_BODY = PALETTE.crate.body;    // wood brown (= props.sandbag[1])
const CRATE_COLOR_LID = PALETTE.crate.lid;      // olive canvas (= soldier.backpack)
const CRATE_COLOR_SEAM = PALETTE.crate.seam;    // brand orange (= ui.primary)
const COIN_RADIUS = PK.radius;                  // m
const COIN_THICKNESS = PK.thickness;            // m
const COIN_Y = PK.y;                            // hover height (m)
const COIN_BOB_AMP = PK.bobAmp;                 // m
const COIN_BOB_HZ = PK.bobHz;
const COIN_SPIN_HZ = PK.spinHz;                 // revolutions per second
const COIN_TARGET_Y = PK.targetY;               // pulled coins fly to chest height
const COIN_SEGMENTS = PK.segments;              // cylinder radial segments
const EPS = 1e-6;

const ST_FREE = 0, ST_CLOSED = 1, ST_OPEN = 2;  // crate states
const CST_IDLE = 1, CST_PULLED = 2;             // coin states

// Module-level reused payloads (listeners never retain them — ARCH §5)
const P_OPEN = { item: null, x: -0, z: -0 };
const P_ITEM = { item: null, x: -0, z: -0, duplicate: false };
const P_COIN = { amount: -0, x: -0, y: -0, z: -0, source: 'pile' };
const COLOR_A = new Color();
const SEG_IN = new Float64Array(4);   // hitTestSegment → hitTestSeg (x0, z0, x1, z1)
const CR = new Float64Array(2);       // render: crate (lid open, scale) — written in branches instead of double phis
const OUT_BACK_S = 1.70158;           // ease.outBack overshoot (util.js default), inlined in render
const DEPTH_KEY = { instanced: true, instanceColor: false, map: false };   // materials.depthFor key (the crate material has no map)

/**
 * Matrix arguments scratch: (px, py, pz, yaw, scale). render() writes MA then calls setMatYaw(arr, i) with integer
 * arguments only (doubles passed to a non-inlined call are boxed into HeapNumbers — garbage per instance per frame).
 */
const MA = new Float64Array(5);

/**
 * Installed as each tagged attribute's clearUpdateRanges(): WebGLAttributes calls it after every upload; three's
 * default (length = 0) makes V8 free and re-allocate the array's backing store on the next push, every frame.
 */
function keepUpdateRanges() {}

/** Gives an attribute one persistent [0, count) update range, kept permanently in attr.updateRanges. */
function tagRange(attr) {
  const r = { start: 0, count: 0 };
  attr._grRange = r;
  attr.updateRanges.length = 0;
  attr.updateRanges.push(r);
  attr.clearUpdateRanges = keepUpdateRanges;
  return attr;
}

/** needsUpdate + updateRange [0, count) without allocating (see gates.js markUpdate). */
function markUpdate(attr, count) {
  const r = attr._grRange;
  r.start = 0;
  r.count = count;
  attr.version++;          // = three's `needsUpdate = true` setter, without a prototype-chain (setter) lookup in the hot path
}

/** Uniform-scale + yaw (about Y) matrix write from MA (px, py, pz, yaw, scale) into a Float32Array at instance i. */
function setMatYaw(arr, i) {
  const s = MA[4];
  const c = Math.cos(MA[3]) * s, sn = Math.sin(MA[3]) * s;
  const o = i * 16;
  arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
  arr[o + 12] = MA[0]; arr[o + 13] = MA[1]; arr[o + 14] = MA[2]; arr[o + 15] = 1;
}

// GLSL injected into MeshStandardMaterial (customProgramCacheKey 'gr:crate'): lid hinge + seams + hit flash.
// The lid hinges on its back edge (−Z, away from the camera) and flips up and back: a NEGATIVE rotation about
// +X lifts the front edge (y' = y·cos θ − z·sin θ with z > 0 relative to the hinge needs sin θ < 0).
const CRATE_VERT_DECL = /* glsl */`
  attribute float aPart; attribute float aSeam; attribute vec4 iCrate;
  uniform float uTime;
  varying float vSeam; varying float vFlash; varying float vHits;
  float crateAng = 0.0;
`;
const CRATE_NORMAL_CHUNK = /* glsl */`
  vec3 objectNormal = vec3( normal );
  crateAng = (aPart > 0.5) ? -iCrate.x * ${CRATE_LID_ANGLE.toFixed(4)} : 0.0;
  if (crateAng < 0.0) {
    float cN = cos(crateAng), sN = sin(crateAng);
    objectNormal = vec3(objectNormal.x, objectNormal.y * cN - objectNormal.z * sN, objectNormal.y * sN + objectNormal.z * cN);
  }
  #ifdef USE_TANGENT
    vec3 objectTangent = vec3( tangent.xyz );
  #endif
`;
const CRATE_BEGIN_CHUNK = /* glsl */`
  vec3 transformed = vec3( position );
  if (crateAng < 0.0) {
    // hinge along the lid's back edge (−Z side, body top): rotate about X, lift while flipping
    vec3 hinge = vec3(0.0, ${(CRATE_SIZE * CRATE_BODY_FRAC).toFixed(4)}, ${(-CRATE_SIZE * 0.5).toFixed(4)});
    vec3 p = transformed - hinge;
    float cR = cos(crateAng), sR = sin(crateAng);
    p = vec3(p.x, p.y * cR - p.z * sR, p.y * sR + p.z * cR);
    transformed = p + hinge + vec3(0.0, iCrate.x * ${CRATE_LID_LIFT.toFixed(4)} * (1.0 - iCrate.x), 0.0);
  }
  vSeam = aSeam;
  float crateAge = uTime - iCrate.y;
  vFlash = crateAge >= 0.0 ? max(0.0, 1.0 - crateAge * ${(1 / CRATE_HIT_FLASH).toFixed(4)}) : 0.0;
  vHits = iCrate.z;
`;
const CRATE_FRAG_DECL = /* glsl */`
  uniform vec3 uSeamColor; uniform float uTime;
  varying float vSeam; varying float vFlash; varying float vHits;
`;
const CRATE_EMISSIVE_CHUNK = /* glsl */`
  #include <emissivemap_fragment>
  totalEmissiveRadiance += uSeamColor * vSeam * (0.8 + 0.2 * sin(uTime * ${(Math.PI * 2 * CRATE_SEAM_PULSE_HZ).toFixed(4)})) * (1.0 + ${CRATE_SEAM_HIT_GAIN.toFixed(4)} * vHits);
  // QA GAT-10: the hit flash is tinted by the seam colour and scaled down (never an additive white cube)
  totalEmissiveRadiance += uSeamColor * (vFlash * ${CRATE_HIT_FLASH_GAIN.toFixed(4)});
`;

export class Pickups {
  constructor(ctx) {
    this.ctx = ctx;
    this._inited = false;
  }

  // -------------------------------------------------------------------------------------------
  // init — pools at capacity, geometry, materials, meshes
  // -------------------------------------------------------------------------------------------
  init() {
    const ctx = this.ctx;
    const render = ctx.render || null;
    const N = CRATE_POOL, M = COIN_POOL;

    // ---- crate SoA ----
    this._cx = new Float64Array(N);          // doubles: payloads carry exact positions
    this._cz = new Float64Array(N);
    this._cyaw = new Float32Array(N);
    this._cstate = new Uint8Array(N);
    this._chits = new Int32Array(N);
    this._copenTime = new Float32Array(N);
    this._chitTime = new Float32Array(N);
    this._cspawnTime = new Float32Array(N);
    this._citem = new Array(N).fill(null);
    this._cgen = new Uint32Array(N).fill(1);
    this._cliveSlots = new Int32Array(N);
    this._clivePos = new Int32Array(N).fill(-1);
    this._cliveCount = 0;

    // ---- coin SoA ----
    this._kx = new Float32Array(M);
    this._kz = new Float32Array(M);
    this._ky = new Float32Array(M);
    this._kstate = new Uint8Array(M);
    this._kphase = new Float32Array(M);
    this._kliveSlots = new Int32Array(M);
    this._klivePos = new Int32Array(M).fill(-1);
    this._kliveCount = 0;

    this._magnetRadius = GEAR.magnet.baseRadius;
    this._uTime = render && render.uniforms && render.uniforms.uTime ? render.uniforms.uTime : { value: 0 };
    this._ownTime = this._uTime !== (render && render.uniforms ? render.uniforms.uTime : null);

    // ---- geometry + materials ----
    this._crateGeo = this._buildCrateGeometry();
    this._iCrate = tagRange(new InstancedBufferAttribute(new Float32Array(N * 4), 4).setUsage(DynamicDrawUsage));
    this._crateGeo.setAttribute('iCrate', this._iCrate);
    this._crateMat = this._buildCrateMaterial();
    this.crates = new InstancedMesh(this._crateGeo, this._crateMat, N);
    this._setupMesh(this.crates, 0);
    this.crates.castShadow = true;                       // a grounded prop-like object (1 shadow draw while visible)
    this.crates.receiveShadow = true;
    // QA GAT-8: own shadow-depth material so three's shared default depth material never re-resolves its program
    // between instanced / plain casters (VIS-14 MaterialLibrary.depthFor; an owned RGBA-packed one until it exists)
    this._ownDepthMat = null;
    this.crates.customDepthMaterial = this._depthMaterial(render);

    this._coinGeo = new CylinderGeometry(COIN_RADIUS, COIN_RADIUS, COIN_THICKNESS, COIN_SEGMENTS);
    this._coinGeo.rotateX(Math.PI / 2);                  // disc stands upright (axis along Z) and spins about Y
    this._coinMat = new MeshStandardMaterial({
      color: PALETTE.props.coin, roughness: PALETTE.material.coin.roughness, metalness: PALETTE.material.coin.metalness,
      emissive: PALETTE.props.coinEmissive, emissiveIntensity: PALETTE.props.coinEmissiveIntensity,
    });
    this.coins = new InstancedMesh(this._coinGeo, this._coinMat, M);
    this._setupMesh(this.coins, 0);

    const scene = render && render.scene ? render.scene : null;
    this._scene = scene;
    if (scene) { scene.add(this.crates); scene.add(this.coins); }
    this._inited = true;
    this._primeRender();
    return this;
  }

  /**
   * QA GAT-9 — JIT feedback priming (init only), as in gates.js: render() is optimized long before the first crate
   * flash / lid pop / shrink or pulled coin, and each first-time branch otherwise deoptimizes it into the boxing
   * baseline tier for seconds. Two throwaway crates (one flashing, one opening then shrinking) and a short coin line
   * (one coin pulled) are rendered a few times with fractional values, then reset() frees them and hides the meshes.
   */
  _primeRender() {
    const time = this.ctx.time;
    const t = time && time.elapsed > 0 ? time.elapsed : 0;
    this.spawnCrate('coins', -1.37, -20.71);
    this.spawnCrate('coins', 1.73, -15.29);
    this.spawnCoinLine(0.71, 3, -25.33);
    if (this._cliveCount === 2 && this._kliveCount === 3) {
      const c0 = this._cliveSlots[0], c1 = this._cliveSlots[1], k0 = this._kliveSlots[0];
      this._chits[c0] = 2;
      this._kstate[k0] = CST_PULLED; this._ky[k0] = 0.73;
      for (let pass = 0; pass < 3; pass++) {
        this._chitTime[c0] = pass < 2 ? t - 0.031 : -1e3;
        this._cstate[c1] = ST_OPEN;
        this._copenTime[c1] = pass === 0 ? t - 0.17 : (pass === 1 ? t - 0.61 : t - 0.53);   // lid pop; shrinking
        for (let n = 0; n < 4; n++) { this.render(0.37); this.render(0.81); }   // ≥ 8 calls: lazy feedback vectors
      }
      // the bullet query (a hit on crate 0, a near miss) and the per-step scroll (dt 0: nothing moves or opens — the
      // crates and coins are far from the squad)
      const seg = SEG_IN, out = { id: 0, t: 0.5, x: 0.5, y: 0.5, z: 0.5 };
      for (let n = 0; n < 12; n++) {
        seg[0] = -1.31; seg[1] = -0.5; seg[2] = -1.43; seg[3] = -40.5; this.hitTestSeg(seg, out);
        seg[0] = 3.31; seg[1] = -0.5; seg[2] = 3.43; seg[3] = -40.5; this.hitTestSeg(seg, out);
      }
      this._cstate[c1] = ST_CLOSED;
      for (let n = 0; n < 12; n++) this.step(0);
    }
    this.reset();
  }

  _setupMesh(mesh, renderOrder) {
    tagRange(mesh.instanceMatrix.setUsage(DynamicDrawUsage));
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = renderOrder;
    mesh.name = 'pickups';
  }

  /** Tags a box part with vertex colour, aPart (0 body / 1 lid) and aSeam (0 / 1) so every part merges cleanly. */
  _tagPart(geo, hex, part, seam) {
    const n = geo.attributes.position.count;
    COLOR_A.setHex(hex);
    const col = new Float32Array(n * 3), parts = new Float32Array(n), seams = new Float32Array(n);
    for (let i = 0; i < n; i++) { col[i * 3] = COLOR_A.r; col[i * 3 + 1] = COLOR_A.g; col[i * 3 + 2] = COLOR_A.b; parts[i] = part; seams[i] = seam; }
    geo.setAttribute('color', new Float32BufferAttribute(col, 3));
    geo.setAttribute('aPart', new Float32BufferAttribute(parts, 1));
    geo.setAttribute('aSeam', new Float32BufferAttribute(seams, 1));
    return geo;
  }

  /** Body + lid + emissive seam strips merged into one geometry (origin at the box's bottom centre). */
  _buildCrateGeometry() {
    const s = CRATE_SIZE, bodyH = s * CRATE_BODY_FRAC, lidH = s - bodyH, w = CRATE_SEAM_W;
    const parts = [];
    parts.push(this._tagPart(new BoxGeometry(s, bodyH, s).translate(0, bodyH / 2, 0), CRATE_COLOR_BODY, 0, 0));
    const lw = s * CRATE_LID_OVERHANG;
    parts.push(this._tagPart(new BoxGeometry(lw, lidH, lw).translate(0, bodyH + lidH / 2, 0), CRATE_COLOR_LID, 1, 0));
    // seam ring just under the lid (body part) — 4 strips
    const ringY = bodyH - w * 0.5;
    parts.push(this._tagPart(new BoxGeometry(s + w, w, w).translate(0, ringY, s / 2), CRATE_COLOR_SEAM, 0, 1));
    parts.push(this._tagPart(new BoxGeometry(s + w, w, w).translate(0, ringY, -s / 2), CRATE_COLOR_SEAM, 0, 1));
    parts.push(this._tagPart(new BoxGeometry(w, w, s + w).translate(s / 2, ringY, 0), CRATE_COLOR_SEAM, 0, 1));
    parts.push(this._tagPart(new BoxGeometry(w, w, s + w).translate(-s / 2, ringY, 0), CRATE_COLOR_SEAM, 0, 1));
    // vertical corner seams (body part)
    const vh = bodyH - w;
    parts.push(this._tagPart(new BoxGeometry(w, vh, w).translate(s / 2, vh / 2, s / 2), CRATE_COLOR_SEAM, 0, 1));
    parts.push(this._tagPart(new BoxGeometry(w, vh, w).translate(-s / 2, vh / 2, s / 2), CRATE_COLOR_SEAM, 0, 1));
    parts.push(this._tagPart(new BoxGeometry(w, vh, w).translate(s / 2, vh / 2, -s / 2), CRATE_COLOR_SEAM, 0, 1));
    parts.push(this._tagPart(new BoxGeometry(w, vh, w).translate(-s / 2, vh / 2, -s / 2), CRATE_COLOR_SEAM, 0, 1));
    // lid cross strap (lid part) — reads as a latch
    parts.push(this._tagPart(new BoxGeometry(w, w, lw + w).translate(0, bodyH + lidH, 0), CRATE_COLOR_SEAM, 1, 1));
    const merged = mergeGeometries(parts, false);
    for (let i = 0; i < parts.length; i++) parts[i].dispose();
    return merged || parts[0];
  }

  _buildCrateMaterial() {
    COLOR_A.setHex(CRATE_COLOR_SEAM);
    const seam = { value: new Color(COLOR_A.r * CRATE_SEAM_EMISSIVE, COLOR_A.g * CRATE_SEAM_EMISSIVE, COLOR_A.b * CRATE_SEAM_EMISSIVE) };
    const uTime = this._uTime;
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: PALETTE.material.metal.roughness, metalness: PALETTE.material.metal.metalness });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.uniforms.uSeamColor = seam;
      shader.vertexShader = CRATE_VERT_DECL + shader.vertexShader
        .replace('#include <beginnormal_vertex>', CRATE_NORMAL_CHUNK)
        .replace('#include <begin_vertex>', CRATE_BEGIN_CHUNK);
      shader.fragmentShader = CRATE_FRAG_DECL + shader.fragmentShader
        .replace('#include <emissivemap_fragment>', CRATE_EMISSIVE_CHUNK);
    };
    mat.customProgramCacheKey = () => 'gr:crate';
    return mat;
  }

  /**
   * The crates' shadow-depth material: MaterialLibrary.depthFor (VIS-14, cached per combination) when present, else an
   * owned MeshDepthMaterial(RGBADepthPacking) — the same program three's internal depth material uses for instanced
   * casters, but a material of its own so it is never re-resolved for another caster kind. The lid hinge is not
   * mirrored in the shadow (a 0.8 m box; the lid pop lasts 0.35 s).
   */
  _depthMaterial(render) {
    const mats = render && render.materials ? render.materials : null;
    if (mats && typeof mats.depthFor === 'function') {
      try {
        const m = mats.depthFor(DEPTH_KEY);
        if (m) return m;
      } catch (_) { /* fall through to an owned one */ }
    }
    this._ownDepthMat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    return this._ownDepthMat;
  }

  /** True once the run is lost (QA GAT-6): squad count 0 (squad:dead) or level phase 'lost'. No squad → false. */
  _squadGone() {
    const ctx = this.ctx;
    const squad = ctx.squad;
    if (squad && squad.count === 0) return true;
    const level = ctx.level;
    return !!(level && level.phase === 'lost');
  }

  // -------------------------------------------------------------------------------------------
  // Ids
  // -------------------------------------------------------------------------------------------
  _crateId(slot) { return ((this._cgen[slot] << 12) | slot) >>> 0; }

  _crateSlot(id) {
    const slot = id & 0xFFF;
    if (slot >= CRATE_POOL || this._cstate[slot] === ST_FREE) return -1;
    if ((id >>> 12) !== this._cgen[slot]) return -1;
    return slot;
  }

  _drop(name) {
    const d = this.ctx.debug;
    if (d && d.dropped) d.dropped[name] = (d.dropped[name] | 0) + 1;
  }

  // -------------------------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------------------------
  /** Spawns a closed crate carrying `item` ('weapon.*' | 'gear.*' | 'troop.*' | 'coins') at x on the horizon. */
  spawnCrate(item, x, z = WORLD.spawnZ) {
    let c = -1;
    for (let i = 0; i < CRATE_POOL; i++) if (this._cstate[i] === ST_FREE) { c = i; break; }
    if (c < 0) { this._drop('crates'); return; }
    const rngFx = this.ctx.rngFx;
    this._cstate[c] = ST_CLOSED;
    this._cx[c] = x;
    this._cz[c] = z;
    this._cyaw[c] = rngFx ? rngFx.range(-CRATE_YAW_JITTER, CRATE_YAW_JITTER) : 0;   // cosmetic only
    this._chits[c] = 0;
    this._copenTime[c] = -1e3;
    this._chitTime[c] = -1e3;
    this._cspawnTime[c] = this.ctx.time ? this.ctx.time.elapsed : 0;
    this._citem[c] = item || 'coins';
    this._clivePos[c] = this._cliveCount;
    this._cliveSlots[this._cliveCount++] = c;
  }

  /** r7 fix round 2: a closed crate is still on the road ahead of the squad (z < 0) — level's "GRAB THE CRATE" row shows
   *  nothing without one (the squad may shoot its crate open before the row, 30 m after the spawn). Event time, ≤ 8 slots.
   *  r7 fix round 3: level also polls it each step while that hint is out, and releases the hint once it turns false. */
  hasClosedCrateAhead() {
    for (let i = 0; i < this._cliveCount; i++) {
      const c = this._cliveSlots[i];
      if (this._cstate[c] === ST_CLOSED && this._cz[c] < 0) return true;
    }
    return false;
  }

  /** Spawns `count` coins of PICKUPS.coinLine.value, PICKUPS.coinLine.gap apart along the road at x. */
  spawnCoinLine(x, count = PICKUPS.coinLine.count, z = WORLD.spawnZ) {
    const gap = PICKUPS.coinLine.gap;
    for (let n = 0; n < count; n++) {
      let k = -1;
      for (let i = 0; i < COIN_POOL; i++) if (this._kstate[i] === 0) { k = i; break; }
      if (k < 0) { this._drop('coins'); return; }
      this._kstate[k] = CST_IDLE;
      this._kx[k] = x;
      this._kz[k] = z - n * gap;          // the line trails toward the horizon so the first coin arrives first
      this._ky[k] = COIN_Y;
      this._kphase[k] = n * 0.7;          // staggered spin/bob phase along the line (cosmetic)
      this._klivePos[k] = this._kliveCount;
      this._kliveSlots[this._kliveCount++] = k;
    }
  }

  /** Current magnet radius: GEAR.magnet.baseRadius by default, GEAR.magnet.radius with the magnet gear. */
  setMagnet(radius) {
    this._magnetRadius = radius > 0 ? radius : GEAR.magnet.baseRadius;
  }

  // -------------------------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------------------------
  /**
   * Grants an item immediately (crate open or item gate pass): routes to weapons / troops, pays duplicates,
   * always emits item:pickup { item, x, z, duplicate }. `duplicate` = a coin payout happened instead of a new effect
   * (duplicate troop; second magnet; round 6: a weapon while the weapon slot is full — weapons pays those itself, ARCH §6.11).
   */
  grantItem(item, x, z) {
    const ctx = this.ctx;
    const events = ctx.events;
    let duplicate = false;
    const y = CRATE_SIZE;   // coin / icon origin: the crate's top edge
    if (typeof item !== 'string' || item.length === 0) return;
    if (this._squadGone()) return;                       // QA GAT-6: no reward after squad:dead
    if (item === 'coins') {
      if (events) {
        P_COIN.amount = PICKUPS.crateCoins; P_COIN.x = x; P_COIN.y = y; P_COIN.z = z; P_COIN.source = 'crate';
        events.emit('coin:pickup', P_COIN);
      }
    } else if (item.startsWith('weapon.')) {
      // round 6: stored, not started (the HUD FIRE button starts it); a full slot pays the refund (weapons emits it)
      const weapons = ctx.weapons;
      if (weapons && typeof weapons.storeWeapon === 'function') duplicate = weapons.storeWeapon(item) !== true;
      else if (weapons && typeof weapons.startWeapon === 'function') weapons.startWeapon(item);   // pre-round-6 weapons
    } else if (item.startsWith('gear.')) {
      const weapons = ctx.weapons;
      if (weapons) {
        if (item === GEAR.magnet.id) {
          // a second magnet pays PICKUPS.duplicateCoins — weapons.startGear emits that coin:pickup itself (ARCH §6.11);
          // gear values are seconds left (Infinity while the magnet is on), so > 0 means "already active"
          const gear = weapons.gear;
          duplicate = !!(gear && gear[item] > 0);
        }
        if (typeof weapons.startGear === 'function') weapons.startGear(item);
      }
    } else if (item.startsWith('troop.')) {
      const troops = ctx.troops;
      let added = false;
      if (troops && typeof troops.add === 'function') added = troops.add(item) === true;
      if (!added) {
        duplicate = true;
        if (events) {
          P_COIN.amount = PICKUPS.duplicateCoins; P_COIN.x = x; P_COIN.y = y; P_COIN.z = z; P_COIN.source = 'duplicate';
          events.emit('coin:pickup', P_COIN);
        }
      }
    } else {
      warnOnce('pickups.item.' + item, 'pickups: unknown item id "' + item + '" (granted nothing)');
    }
    if (events) {
      P_ITEM.item = item; P_ITEM.x = x; P_ITEM.z = z; P_ITEM.duplicate = duplicate;
      events.emit('item:pickup', P_ITEM);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Crate hits (bullets) — XZ box PICKUPS.crate.size, height ignored (ARCH §7)
  // -------------------------------------------------------------------------------------------
  hitTestSegment(x0, z0, x1, z1, out) {
    SEG_IN[0] = x0; SEG_IN[1] = z0; SEG_IN[2] = x1; SEG_IN[3] = z1;
    return this.hitTestSeg(SEG_IN, out);
  }

  /**
   * hitTestSegment with the segment read from a shared Float64Array(4) `seg` = (x0, z0, x1, z1); same semantics and
   * `out` shape { id, t, x, y, z } (QA GAT-9 / WPN-8: four doubles passed to a non-inlined call are boxed per bullet).
   */
  hitTestSeg(seg, out) {
    if (this._cliveCount === 0) return false;              // the common case: no crate on the road (no double math at all)
    const x0 = seg[0], z0 = seg[1], x1 = seg[2], z1 = seg[3];
    let bestT = Infinity, bestC = -1;
    const dx = x1 - x0, dz = z1 - z0;
    const h = CRATE_SIZE * 0.5;
    for (let i = 0; i < this._cliveCount; i++) {
      const c = this._cliveSlots[i];
      if (this._cstate[c] !== ST_CLOSED) continue;
      const minX = this._cx[c] - h, maxX = this._cx[c] + h, minZ = this._cz[c] - h, maxZ = this._cz[c] + h;
      let t0 = 0, t1 = 1;
      if (dx > -EPS && dx < EPS) {
        if (x0 < minX || x0 > maxX) continue;
      } else {
        const inv = 1 / dx;
        let ta = (minX - x0) * inv, tb = (maxX - x0) * inv;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (dz > -EPS && dz < EPS) {
        if (z0 < minZ || z0 > maxZ) continue;
      } else {
        const inv = 1 / dz;
        let ta = (minZ - z0) * inv, tb = (maxZ - z0) * inv;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (t0 < bestT) { bestT = t0; bestC = c; }
    }
    if (bestC < 0) return false;
    out.id = this._crateId(bestC);
    out.t = bestT;
    out.x = x0 + dx * bestT;
    out.y = FIRE.bullet.y < CRATE_SIZE ? FIRE.bullet.y : CRATE_SIZE;   // spark height clamped to the crate's top
    out.z = z0 + dz * bestT;
    return true;
  }

  /** One bullet hit on a closed crate: PICKUPS.crate.hitsToOpen hits open it (stale ids are ignored). */
  hit(id) {
    const c = this._crateSlot(id);
    if (c < 0 || this._cstate[c] !== ST_CLOSED) return;
    if (this._squadGone()) return;                       // QA GAT-6: a dead squad's stray bullets open nothing
    this._chits[c] += 1;
    // QA GAT-10: the tinted flash / punch restarts at most every CRATE_HIT_RETRIGGER (a pulse, never a held flash)
    const now = this.ctx.time ? this.ctx.time.elapsed : 0;
    if (now - this._chitTime[c] >= CRATE_HIT_RETRIGGER) this._chitTime[c] = now;
    if (this._chits[c] >= PICKUPS.crate.hitsToOpen) this._open(c);
  }

  _open(c) {
    const events = this.ctx.events;
    const x = this._cx[c], z = this._cz[c];
    const item = this._citem[c];
    this._cstate[c] = ST_OPEN;
    this._copenTime[c] = this.ctx.time ? this.ctx.time.elapsed : 0;
    if (events) {
      P_OPEN.item = item; P_OPEN.x = x; P_OPEN.z = z;
      events.emit('crate:open', P_OPEN);
    }
    this.grantItem(item, x, z);
  }

  // -------------------------------------------------------------------------------------------
  // step — scroll, contact-open, magnet pull, collection, recycle
  // -------------------------------------------------------------------------------------------
  step(dt) {
    const ctx = this.ctx;
    const world = ctx.world;
    const roadSpeed = world ? world.roadSpeed : 0;
    const dz = roadSpeed * dt;
    const squad = ctx.squad || null;
    const events = ctx.events;
    // QA GAT-6: once the squad is dead (C = 0 / level lost) nothing is collected — crates and coins keep scrolling
    // and despawn; coins already flying to the squad vanish without paying
    const dead = this._squadGone();
    const canTest = !dead && squad !== null && typeof squad.intersectsCircle === 'function';
    const sqx = squad ? squad.x : (world ? world.squadX : 0);
    const sqz = squad && typeof squad.centerZ === 'number' ? squad.centerZ : 0;
    const magnetR = this._magnetRadius;
    const pull = PICKUPS.magnetPull * dt;
    const collectR = PICKUPS.coinCollect;

    const now = ctx.time ? ctx.time.elapsed : 0;
    const vanishEnd = CRATE_VANISH_DELAY + CRATE_VANISH_TIME;

    // ---- crates (backwards: freeing swaps the tail in) ----
    for (let i = this._cliveCount - 1; i >= 0; i--) {
      const c = this._cliveSlots[i];
      this._cz[c] += dz;
      if (this._cz[c] > WORLD.despawnZ) { this._freeCrate(c); continue; }
      if (this._cstate[c] === ST_OPEN && now - this._copenTime[c] >= vanishEnd) { this._freeCrate(c); continue; }   // shrunk away
      // (z ≥ −r prefilter = intersectsCircle's own near bound: no call — and no boxed double arguments — while far)
      if (this._cstate[c] === ST_CLOSED && PICKUPS.crate.openOnContact && canTest && this._cz[c] >= -PICKUPS.collectRadius
          && squad.intersectsCircle(this._cx[c], this._cz[c], PICKUPS.collectRadius)) {
        this._open(c);
      }
    }

    // ---- coins ----
    for (let i = this._kliveCount - 1; i >= 0; i--) {
      const k = this._kliveSlots[i];
      if (this._kstate[k] === CST_PULLED) {
        // fly straight at the formation centre (chest height); collected within PICKUPS.coinCollect
        const ddx = sqx - this._kx[k], ddy = COIN_TARGET_Y - this._ky[k], ddz = sqz - this._kz[k];
        const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (dist <= collectR || dist <= pull) {
          if (events && !dead) {
            P_COIN.amount = PICKUPS.coinLine.value; P_COIN.x = this._kx[k]; P_COIN.y = this._ky[k]; P_COIN.z = this._kz[k]; P_COIN.source = 'pile';
            events.emit('coin:pickup', P_COIN);
          }
          this._freeCoin(k);
          continue;
        }
        const f = pull / dist;
        this._kx[k] += ddx * f; this._ky[k] += ddy * f; this._kz[k] += ddz * f;
      } else {
        this._kz[k] += dz;
        if (this._kz[k] > WORLD.despawnZ) { this._freeCoin(k); continue; }
        if (canTest && this._kz[k] >= -magnetR && squad.intersectsCircle(this._kx[k], this._kz[k], magnetR)) this._kstate[k] = CST_PULLED;
      }
    }
  }

  _freeCrate(c) {
    this._cstate[c] = ST_FREE;
    this._citem[c] = null;
    this._cgen[c] = (this._cgen[c] + 1) >>> 0;
    if (this._cgen[c] === 0) this._cgen[c] = 1;
    const pos = this._clivePos[c], last = this._cliveCount - 1;
    if (pos !== last) { const moved = this._cliveSlots[last]; this._cliveSlots[pos] = moved; this._clivePos[moved] = pos; }
    this._clivePos[c] = -1;
    this._cliveCount = last;
  }

  _freeCoin(k) {
    this._kstate[k] = 0;
    const pos = this._klivePos[k], last = this._kliveCount - 1;
    if (pos !== last) { const moved = this._kliveSlots[last]; this._kliveSlots[pos] = moved; this._klivePos[moved] = pos; }
    this._klivePos[k] = -1;
    this._kliveCount = last;
  }

  // -------------------------------------------------------------------------------------------
  // render — instance matrices + iCrate only
  // -------------------------------------------------------------------------------------------
  render(alpha) {
    const ctx = this.ctx;
    const t = ctx.time ? ctx.time.elapsed : 0;
    if (this._ownTime) this._uTime.value = t;        // no shared render clock (stub harness): drive the shader clock ourselves
    const roadSpeed = ctx.world ? ctx.world.roadSpeed : 0;
    const exDz = roadSpeed * alpha * WORLD.step;
    const cm = this.crates.instanceMatrix.array, km = this.coins.instanceMatrix.array;
    const iCrate = this._iCrate.array;

    let nC = 0;
    for (let i = 0; i < this._cliveCount; i++) {
      const c = this._cliveSlots[i];
      // (lid / scale go through CR — doubles assigned in branches are phis Maglev may box per crate per frame, GAT-9)
      if (this._cstate[c] === ST_OPEN) {
        const age = t - this._copenTime[c];
        const v = (age - CRATE_VANISH_DELAY) / CRATE_VANISH_TIME;  // then the empty box shrinks away
        if (v >= 1) continue;                                      // fully gone (step frees the slot)
        // J12 lid pop with a little overshoot: ease.outBack(u) on u = clamp(age / lid time) (inlined; ≤ 1.15)
        const ub = Math.min(1, Math.max(0, age / CRATE_LID_TIME)) - 1;
        CR[0] = Math.min(1.15, 1 + ub * ub * ((OUT_BACK_S + 1) * ub + OUT_BACK_S));
        // scale = 1 − ease.inOutCubic(v) once v > 0 (inlined, branch-free)
        const vc = Math.min(1, Math.max(0, v));
        const lo = vc < 0.5 ? 1 : 0;
        const w = 2 - 2 * vc;
        CR[1] = 1 - (lo * 4 * vc * vc * vc + (1 - lo) * (1 - w * w * w * 0.5));
      } else {
        // closed: a small squash-punch per (rate-limited) flash start on top of the tinted flash
        const hu = (t - this._chitTime[c]) / CRATE_HIT_FLASH;
        CR[0] = 0;
        CR[1] = 1 + CRATE_HIT_PUNCH * (1 - hu) * (hu >= 0 && hu < 1 ? 1 : 0);
      }
      MA[0] = this._cx[c]; MA[1] = 0; MA[2] = this._cz[c] + exDz; MA[3] = this._cyaw[c]; MA[4] = CR[1];
      setMatYaw(cm, nC);
      const o = nC * 4;
      iCrate[o] = CR[0];
      iCrate[o + 1] = this._chitTime[c];
      iCrate[o + 2] = this._chits[c] / PICKUPS.crate.hitsToOpen;
      iCrate[o + 3] = 0;
      nC++;
    }
    this.crates.count = nC;
    this.crates.visible = nC > 0;
    if (nC > 0) {
      markUpdate(this.crates.instanceMatrix, nC * 16);
      markUpdate(this._iCrate, nC * 4);
    }

    let nK = 0;
    const spin = t * Math.PI * 2 * COIN_SPIN_HZ;
    const bobW = t * Math.PI * 2 * COIN_BOB_HZ;
    for (let i = 0; i < this._kliveCount; i++) {
      const k = this._kliveSlots[i];
      const idle = this._kstate[k] === CST_PULLED ? 0 : 1;      // pulled coins: no bob, no extrapolation (0 / 1, no double phi)
      MA[0] = this._kx[k]; MA[1] = this._ky[k] + idle * COIN_BOB_AMP * Math.sin(bobW + this._kphase[k]); MA[2] = this._kz[k] + idle * exDz; MA[3] = spin + this._kphase[k]; MA[4] = 1;
      setMatYaw(km, nK);
      nK++;
    }
    this.coins.count = nK;
    this.coins.visible = nK > 0;
    if (nK > 0) markUpdate(this.coins.instanceMatrix, nK * 16);
  }

  // -------------------------------------------------------------------------------------------
  // reset / dispose
  // -------------------------------------------------------------------------------------------
  /** Level-start state: every crate and coin freed, magnet back to the base radius, meshes hidden. Idempotent. */
  reset() {
    for (let i = this._cliveCount - 1; i >= 0; i--) this._freeCrate(this._cliveSlots[i]);
    for (let i = this._kliveCount - 1; i >= 0; i--) this._freeCoin(this._kliveSlots[i]);
    this._cliveCount = 0;
    this._kliveCount = 0;
    for (let c = 0; c < CRATE_POOL; c++) { this._cstate[c] = ST_FREE; this._clivePos[c] = -1; this._citem[c] = null; }
    for (let k = 0; k < COIN_POOL; k++) { this._kstate[k] = 0; this._klivePos[k] = -1; }
    this._magnetRadius = GEAR.magnet.baseRadius;
    this.crates.count = 0; this.crates.visible = false;
    this.coins.count = 0; this.coins.visible = false;
  }

  dispose() {
    if (!this._inited) return;
    this.reset();
    const scene = this._scene;
    if (scene) { scene.remove(this.crates); scene.remove(this.coins); }
    this.crates.dispose();
    this.coins.dispose();
    this._crateGeo.dispose();
    this._coinGeo.dispose();
    this._crateMat.dispose();
    this._coinMat.dispose();
    if (this._ownDepthMat) { this._ownDepthMat.dispose(); this._ownDepthMat = null; }
    this.crates.customDepthMaterial = undefined;
    this._scene = null;
    this._inited = false;
  }
}
