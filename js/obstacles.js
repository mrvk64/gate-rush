// js/obstacles.js — the CHASE road furniture (PLAN P2; chase-design §2, §4), owned and stepped by chase.js; drawn only (the hit
// test is chase.js's, on the logical formation): the wrecks (a car across one half, rubble on the centre, NARROWS), the DROP
// barricade and the safe-zone gatehouse with its blast doors. One InstancedMesh per prop (pooled) + the gatehouse and two doors,
// one vertex-coloured standard material, no casters, no allocation per frame.
import { Group, Mesh, InstancedMesh, MeshStandardMaterial, BufferGeometry, BufferAttribute, BoxGeometry, Matrix4, Color, DynamicDrawUsage } from 'three';
import { OBSTACLES, WORLD, PALETTE } from './data.js';

const POOL = OBSTACLES.pool;                            // live wrecks at once
const CARS = POOL, RUBBLE = POOL * 2, JERSEY = POOL * 4 + OBSTACLES.barricades * 5, BAGS = OBSTACLES.barricades * 4;
const K_CAR_L = 0, K_CAR_R = 1, K_RUBBLE = 2, K_NARROWS = 3;
const KIND_OF = { carL: K_CAR_L, carR: K_CAR_R, rubble: K_RUBBLE, narrows: K_NARROWS };
const KIND_NAMES = ['carL', 'carR', 'rubble', 'narrows'];
const DOOR_W = 4.1, DOOR_H = 4.6, DOOR_OPEN = 6.4, DOOR_SHUT = 2.05, DOOR_SLAM_S = 0.35;   // shape constants (m, s)
const HAZARD = 0xF2C230, DARK = 0x2A2C30, STEEL = 0x6B7480, CONCRETE = 0xA4A39C, LAMP = 0xFFF2C8;
const M4 = new Matrix4();
const COL = new Color();

/** [w, h, d, x, y, z, hex] rows → one vertex-coloured non-indexed geometry (init only). */
function boxes(rows) {
  const pos = [], nor = [], col = [];
  for (const r of rows) {
    const g = new BoxGeometry(r[0], r[1], r[2]).toNonIndexed();
    g.translate(r[3], r[4], r[5]);
    COL.setHex(r[6]);
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) { pos.push(p[i], p[i + 1], p[i + 2]); nor.push(n[i], n[i + 1], n[i + 2]); col.push(COL.r, COL.g, COL.b); }
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  return out;
}

/** A blast door: steel, hazard bands, a seam. */
function doorGeo() {
  const rows = [[DOOR_W, DOOR_H, 0.5, 0, DOOR_H / 2, 0, STEEL]];
  for (let i = 0; i < 4; i++) rows.push([DOOR_W * 0.98, 0.32, 0.52, 0, 0.5 + i * 1.1, 0, i % 2 ? HAZARD : DARK]);
  rows.push([0.08, DOOR_H * 0.96, 0.54, DOOR_W * 0.5 - 0.06, DOOR_H / 2, 0, DARK]);
  return boxes(rows);
}

/** The gatehouse: towers, an overpass beam, floodlights, sandbag wings. */
function gatehouseGeo() {
  const rows = [];
  for (const s of [-1, 1]) {
    rows.push([2.2, 7.2, 2.6, s * 5.6, 3.6, 0, CONCRETE], [2.4, 0.4, 2.8, s * 5.6, 7.3, 0, DARK]);
    for (let i = 0; i < 3; i++) rows.push([2.24, 0.3, 2.64, s * 5.6, 1 + i * 2.1, 0, i % 2 ? DARK : HAZARD]);
    rows.push([3.2, 1.0, 1.0, s * 8.2, 0.5, 0.6, PALETTE.props.sandbag[0]], [2.6, 0.8, 0.9, s * 8.0, 1.4, 0.6, PALETTE.props.sandbag[1]]);
  }
  rows.push([13.6, 1.2, 1.6, 0, 6.4, 0, CONCRETE], [13.6, 0.24, 1.64, 0, 5.9, 0, HAZARD], [9.0, 0.3, 0.5, 0, 7.2, 0.7, DARK]);
  for (let i = 0; i < 5; i++) rows.push([0.7, 0.35, 0.4, -3.6 + i * 1.8, 7.0, 1.0, LAMP]);
  return boxes(rows);
}

export class Obstacles {
  constructor(ctx) {
    this.ctx = ctx; this._built = false; this.group = null;
    this._kind = new Int8Array(POOL); this._z = new Float32Array(POOL); this._live = new Uint8Array(POOL); this._tested = new Uint8Array(POOL);   // wrecks
    this._bz = new Float32Array(OBSTACLES.barricades); this._blive = new Uint8Array(OBSTACLES.barricades);   // DROP barricades
    this._gz = 0.5; this._gz = 0; this._gOn = false; this._doorT = 0.5; this._doorT = -1;
    this._dirty = true;
  }

  /** The meshes, once, hidden (chase.prepare warms them). */
  build() {
    if (this._built) return this.group;
    const r = this.ctx.render, m = this.ctx.models;
    if (!r || !r.scene || !m || !m.geo) return null;
    const mat = this._mat = new MeshStandardMaterial({ name: 'chase.obstacles', vertexColors: true, roughness: 0.82, metalness: 0.05 });
    const inst = (geo, n, name) => {
      const o = new InstancedMesh(geo, mat, n);
      o.instanceMatrix.setUsage(DynamicDrawUsage); o.count = 0; o.frustumCulled = false; o.name = name;
      return o;
    };
    const g = this.group = new Group();
    g.name = 'chase.obstacles'; g.visible = false;
    this._cars = inst(m.geo.car, CARS, 'chase.cars');
    this._rubble = inst(m.geo.rubble, RUBBLE, 'chase.rubble');
    this._jersey = inst(m.geo.barricade, JERSEY, 'chase.jersey');
    this._bags = inst(m.geo.sandbags, BAGS, 'chase.bags');
    this._gate = new Mesh(gatehouseGeo(), mat); this._gate.name = 'chase.gatehouse'; this._gate.visible = false;
    const dg = doorGeo();
    this._doorL = new Mesh(dg, mat); this._doorR = new Mesh(dg, mat); this._doorR.rotation.y = Math.PI;
    this._doorL.visible = false; this._doorR.visible = false;
    g.add(this._cars, this._rubble, this._jersey, this._bags, this._gate, this._doorL, this._doorR);
    r.scene.add(g);
    this._built = true;
    return g;
  }

  /** Everything gone (the chase's reset). */
  reset() {
    this._live.fill(0); this._blive.fill(0); this._gOn = false; this._doorT = -1; this._dirty = true;
    if (!this._built) return;
    this.group.visible = false; this._gate.visible = false; this._doorL.visible = false; this._doorR.visible = false;
    this._cars.count = 0; this._rubble.count = 0; this._jersey.count = 0; this._bags.count = 0;
  }

  show(on) { if (this._built) this.group.visible = on; }

  /** A wreck of `kind` at world z (it rides the road): its slot, −1 when full. */
  spawn(kind, z) {
    const k = KIND_OF[kind];
    if (k === undefined) return -1;
    for (let i = 0; i < POOL; i++) {
      if (this._live[i]) continue;
      this._live[i] = 1; this._kind[i] = k; this._z[i] = z; this._tested[i] = 0; this._dirty = true;
      return i;
    }
    return -1;
  }

  /** A DROP barricade across the road at world z (it rides the road). */
  dropBarricade(z) {
    let b = 0;
    for (let i = 0; i < this._blive.length; i++) if (!this._blive[i]) { b = i; break; }
    this._blive[b] = 1; this._bz[b] = z; this._dirty = true;
    return b;
  }

  /** The hold ended: the barricade goes (chase.js bursts fx at the returned z). */
  splinter() {
    let b = -1, zb = -1e9;
    for (let i = 0; i < this._blive.length; i++) if (this._blive[i] && this._bz[i] > zb) { zb = this._bz[i]; b = i; }
    if (b >= 0) { this._blive[b] = 0; this._dirty = true; }
    return zb;
  }

  /** The gatehouse at world z, open; doorsShut() slams the doors. */
  showGatehouse(z) { this._gOn = true; this._gz = z; this._doorT = -1; this._dirty = true; }
  get gatehouseZ() { return this._gz; }
  get gatehouseOn() { return this._gOn; }
  doorsShut() { if (this._doorT < 0) this._doorT = 0; }

  // wreck slot i for chase.js's hit test
  get size() { return POOL; }
  isLive(i) { return this._live[i] === 1; }
  wreckZ(i) { return this._z[i]; }
  wreckKind(i) { return KIND_NAMES[this._kind[i]]; }
  tested(i) { return this._tested[i] === 1; }
  markTested(i) { this._tested[i] = 1; }

  /** The road moved dz (passed wrecks recycle past despawnZ); dt runs the door slam. */
  step(dz, dt, despawnZ) {
    for (let i = 0; i < POOL; i++) {
      if (!this._live[i]) continue;
      this._z[i] += dz;
      if (this._z[i] > despawnZ) this._live[i] = 0;
    }
    for (let i = 0; i < this._blive.length; i++) if (this._blive[i]) { this._bz[i] += dz; if (this._bz[i] > despawnZ + 20) this._blive[i] = 0; }
    if (this._gOn) this._gz += dz;
    if (this._doorT >= 0 && this._doorT < DOOR_SLAM_S) this._doorT += dt;
    this._dirty = true;
  }

  /** Instance matrices (render step D). */
  render() {
    if (!this._built || !this.group.visible || !this._dirty) return;
    this._dirty = false;
    let nc = 0, nr = 0, nj = 0, nb = 0;
    const cars = this._cars, rub = this._rubble, jer = this._jersey, bags = this._bags;
    for (let i = 0; i < POOL; i++) {
      if (!this._live[i]) continue;
      const z = this._z[i], k = this._kind[i];
      if (k === K_CAR_L || k === K_CAR_R) {
        const s = k === K_CAR_L ? -1 : 1;
        M4.makeRotationY(s * (Math.PI / 2 - 0.12)); M4.setPosition(s * 1.9, 0, z);
        cars.setMatrixAt(nc++, M4);
      } else if (k === K_RUBBLE) {
        M4.makeRotationY(0.7); M4.setPosition(-0.45, 0, z); rub.setMatrixAt(nr++, M4);
        M4.makeRotationY(2.1); M4.setPosition(0.45, 0, z + 0.6); rub.setMatrixAt(nr++, M4);
      } else {
        for (let j = 0; j < 4; j++) { M4.makeRotationY(j & 1 ? 0.08 : -0.08); M4.setPosition((j < 2 ? -1 : 1) * (2.35 + (j & 1) * 1.6), 0, z); jer.setMatrixAt(nj++, M4); }
      }
    }
    for (let b = 0; b < this._blive.length; b++) {
      if (!this._blive[b]) continue;
      const z = this._bz[b];
      for (let j = 0; j < 5; j++) { M4.makeRotationY((j - 2) * 0.05); M4.setPosition(-3.2 + j * 1.6, 0, z); jer.setMatrixAt(nj++, M4); }
      for (let j = 0; j < 4; j++) { M4.makeRotationY(0); M4.setPosition(-3.3 + j * 2.2, 0.8, z + 0.25); bags.setMatrixAt(nb++, M4); }
    }
    cars.count = nc; rub.count = nr; jer.count = nj; bags.count = nb;
    cars.instanceMatrix.needsUpdate = nc > 0; rub.instanceMatrix.needsUpdate = nr > 0; jer.instanceMatrix.needsUpdate = nj > 0; bags.instanceMatrix.needsUpdate = nb > 0;
    const on = this._gOn && this._gz > WORLD.spawnZ - 30;
    this._gate.visible = on; this._doorL.visible = on; this._doorR.visible = on;
    if (on) {
      const u = this._doorT < 0 ? 0 : Math.min(1, this._doorT / DOOR_SLAM_S), x = DOOR_OPEN + (DOOR_SHUT - DOOR_OPEN) * u * u;
      this._gate.position.z = this._gz; this._doorL.position.set(-x, 0, this._gz + 0.2); this._doorR.position.set(x, 0, this._gz + 0.2);
    }
  }

  dispose() {
    this.reset();
    if (!this._built) return;
    const r = this.ctx.render;
    if (r && r.scene) r.scene.remove(this.group);
    this._gate.geometry.dispose(); this._doorL.geometry.dispose(); this._mat.dispose();
    this._built = false; this.group = null;
  }
}
