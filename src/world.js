import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CELL, WALL_H, WALL_T, DOOR_W, DOOR_H, E, K, STAIR } from './level.js';
import { TEX_SCALE, textTexture } from './textures.js';
import { mulberry32 } from './util.js';

const T2 = WALL_T / 2;
const CHUNK = 6; // small batches cull well, especially for shadow-map passes
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const WINDOW_W = 1.6, SILL = 0.9, HEAD = 2.2;
const NO_SHADOW = new Set(['carpetHall', 'carpetBed', 'laminate', 'floorTile', 'ceiling', 'glass', 'rug']);
const STAIR_COPIES = [-2, -1, 1, 2]; // storeys rendered above/below the real one

// ---------------------------------------------------------------------------
// Geometry batching: everything static is merged per material per 12m chunk,
// so the whole floor renders in a few dozen draw calls.
class Builder {
  constructor(M) {
    this.M = M;
    this.buckets = new Map();
    this._v = new THREE.Vector3();
  }

  bucket(mat, x, z) {
    const key = `${mat}|${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { mat, geos: [], pos: [], nor: [], uv: [], idx: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  // Planar quad; winding is fixed up to face along n. uvFn(point) -> [u, v].
  quad(mat, p0, p1, p2, p3, n, uvFn) {
    const b = this.bucket(mat, (p0.x + p2.x) / 2, (p0.z + p2.z) / 2);
    const base = b.pos.length / 3;
    for (const p of [p0, p1, p2, p3]) {
      b.pos.push(p.x, p.y, p.z);
      b.nor.push(n.x, n.y, n.z);
      const [u, v] = uvFn(p);
      b.uv.push(u, v);
    }
    const e1 = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
    const e2 = [p2.x - p0.x, p2.y - p0.y, p2.z - p0.z];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (c[0] * n.x + c[1] * n.y + c[2] * n.z >= 0) b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  geo(mat, geometry, matrix) {
    const g = geometry.clone();
    g.applyMatrix4(matrix);
    this._v.setFromMatrixPosition(matrix);
    this.bucket(mat, this._v.x, this._v.z).geos.push(g);
  }

  // Bake a loaded glTF model into the batches (one bucket per material).
  model(name, matrix, noShadow = false) {
    const m = MODEL_LIB[name];
    if (!m) return;
    this._v.setFromMatrixPosition(matrix);
    m.root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(matrix, o.matrixWorld));
      const key = 'model:' + o.material.uuid + (noShadow ? ':ns' : '');
      const b = this.bucket(key, this._v.x, this._v.z);
      b.material = o.material;
      b.noShadow = noShadow;
      b.geos.push(g);
    });
  }

  build(group) {
    for (const b of this.buckets.values()) {
      const list = b.geos.map(clean);
      if (b.pos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
        g.setIndex(b.idx);
        list.push(g);
      }
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.material || this.M[b.mat]);
      mesh.castShadow = !b.noShadow && !NO_SHADOW.has(b.mat);
      mesh.receiveShadow = true;
      group.add(mesh);
      for (const g of list) g.dispose();
    }
  }
}

function clean(g) {
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(idx);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Furniture parts are described in item-local space (origin on the floor at
// the centre of the footprint, back of the item at -z, front at +z).
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const cylCache = new Map();
function cylGeo(rt, rb, h, seg = 12) {
  const k = `${rt},${rb},${h},${seg}`;
  if (!cylCache.has(k)) cylCache.set(k, new THREE.CylinderGeometry(rt, rb, h, seg));
  return cylCache.get(k);
}
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
function mtx(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.clone(), new THREE.Vector3(sx, sy, sz));
}
const box = (mat, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) => ({ mat, geo: UNIT_BOX, m: mtx(x, y, z, rx, ry, rz, sx, sy, sz) });
const cyl = (mat, rt, rb, h, x, y, z, rx = 0, ry = 0, rz = 0, seg = 12) => ({ mat, geo: cylGeo(rt, rb, h, seg), m: mtx(x, y, z, rx, ry, rz) });

function legs(mat, w, d, h, inset = 0.05, r = 0.025) {
  const out = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(cyl(mat, r, r * 0.8, h, sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset), 0, 0, 0, 6));
  return out;
}

// Loaded glTF models (set by buildWorld). Each is real-world scale, front +z.
let MODEL_LIB = {};
const pick = (r, list) => list[Math.floor(r() * list.length)];
function dims(name, s = 1) {
  const m = MODEL_LIB[name];
  return { w: m.size.x * s, d: m.size.z * s, h: m.size.y * s };
}
// A model part: centred on x/z, resting on y=0, then placed in item space.
function mp(name, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, s = 1) {
  const m = MODEL_LIB[name];
  const c = m.box.getCenter(new THREE.Vector3());
  const centre = new THREE.Matrix4().makeTranslation(-c.x, -m.box.min.y, -c.z);
  const place = mtx(x, y, z, rx, ry, rz, s, s, s);
  return { model: name, m: place.multiply(centre) };
}

const ITEMS = {
  sofa: (r) => {
    const n = pick(r, ['Sofa_01', 'sofa_02', 'sofa_02', 'sofa_03']);
    const { w, d, h } = dims(n);
    const parts = [mp(n)];
    if (r() < 0.4) parts.push(mp('throw_pillows_01', (r() - 0.5) * 0.3, 0.38, 0.02, (r() - 0.5) * 0.4, 0, 0, 0.8));
    return { w, d, h, parts };
  },
  armchair: (r) => {
    const n = pick(r, ['ArmChair_01', 'modern_arm_chair_01']);
    const { w, d, h } = dims(n);
    return { w, d, h, parts: [mp(n, 0, 0, 0, (r() - 0.5) * 0.3)] };
  },
  tvUnit: (r) => {
    const base = pick(r, ['ClassicConsole_01', 'modern_wooden_cabinet']);
    const tv = pick(r, ['Television_01', 'television_02']);
    const b = dims(base), t = dims(tv);
    const parts = [mp(base), mp(tv, (r() - 0.5) * 0.3, b.h, -0.02, (r() - 0.5) * 0.15)];
    return { w: b.w, d: b.d, h: b.h + t.h, parts };
  },
  bookshelf: () => {
    const { w, d, h } = dims('wooden_bookshelf_worn');
    return { w, d, h, parts: [mp('wooden_bookshelf_worn')] };
  },
  coffeeTable: (r) => {
    const n = pick(r, ['CoffeeTable_01', 'coffee_table_round_01']);
    const { w, d, h } = dims(n);
    return { w, d, h, parts: [mp(n)] };
  },
  rug: (r) => ({ w: 2.2, d: 1.5, h: 0.01, solid: false, parts: [box('rug', 2.2, 0.012, 1.5, 0, 0.006, 0, 0, (r() - 0.5) * 0.3)] }),
  diningTable: (r) => {
    const parts = [box('wood', 1.4, 0.04, 0.85, 0, 0.74, 0), ...legs('wood', 1.4, 0.85, 0.72)];
    parts.push(mp('dining_chair_02', -0.35, 0, -0.62, (r() - 0.5) * 0.2));
    parts.push(mp('dining_chair_02', 0.35, 0, 0.62, Math.PI + (r() - 0.5) * 0.2));
    return { w: 1.4, d: 0.85, h: 0.76, parts };
  },
  kitchenRun: (r) => {
    const w = 2.4;
    const st = dims('electric_stove');
    const cw = w - st.w;
    const cx = -w / 2 + cw / 2;
    const parts = [
      box('appliance', cw, 0.86, 0.58, cx, 0.43, 0.01),
      box('stairConcrete', cw + 0.02, 0.04, 0.62, cx, 0.88, 0.01),
      box('metal', 0.55, 0.02, 0.42, cx - 0.2, 0.905, 0.03), // sink
      box('appliance', w, 0.7, 0.34, 0, 1.85, -0.12), // wall cabinets
      box('wallTileFurniture', w, 0.55, 0.01, 0, 1.18, -0.285), // splashback
      cyl('metal', 0.012, 0.012, 0.3, cx - 0.2, 1.05, -0.2, 0.3, 0, 0, 6), // tap
      mp('electric_stove', w / 2 - st.w / 2, 0, 0.31 - st.d / 2),
    ];
    for (let i = 0; i < 3; i++) parts.push(box('metal', 0.12, 0.015, 0.02, -w / 2 + 0.3 + i * 0.6, 0.75, 0.31));
    if (r() < 0.6) parts.push(mp('vintage_microwave', cx + 0.45, 0.9, -0.08, (r() - 0.5) * 0.2, 0, 0, 0.5));
    return { w, d: 0.62, h: 2.2, parts };
  },
  fridge: () => ({ w: 0.72, d: 0.68, h: 1.85, parts: [
    box('appliance', 0.72, 1.85, 0.68, 0, 0.925, 0),
    box('black', 0.7, 0.008, 0.01, 0, 1.22, 0.343),
    box('metal', 0.03, 0.4, 0.03, 0.3, 1.45, 0.36),
    box('metal', 0.03, 0.25, 0.03, 0.3, 0.95, 0.36),
  ] }),
  bed: (r) => {
    // still made, as if someone meant to come back
    const double = r() < 0.5;
    const w = double ? 1.55 : 0.95, d = 2.05;
    const duvet = pick(r, ['fabricA', 'fabricC', 'fabricB', 'mattress']);
    const parts = [
      box('darkWood', w, 0.3, d, 0, 0.15, 0),
      box('darkWood', w, 1.0, 0.06, 0, 0.5, -d / 2 + 0.03),
      box('mattress', w - 0.06, 0.2, d - 0.1, 0, 0.4, 0.03),
      box(duvet, w + 0.02, 0.07, d * 0.72, 0, 0.53, d * 0.13),
      box(duvet, w + 0.03, 0.32, 0.02, 0, 0.38, d / 2 - 0.0), // hanging over the foot
    ];
    const pillows = double ? [-w * 0.24, w * 0.24] : [0];
    for (const px of pillows) parts.push(box('mattress', w * (double ? 0.4 : 0.7), 0.11, 0.36, px, 0.56, -d / 2 + 0.3));
    return { w, d, h: 1.0, parts };
  },
  nightstand: (r) => {
    const n = pick(r, ['ClassicNightstand_01', 'painted_wooden_nightstand']);
    const { w, d, h } = dims(n);
    const parts = [mp(n)];
    if (r() < 0.5) parts.push(mp('alarm_clock_01', (r() - 0.5) * 0.2, h, 0, (r() - 0.5) * 1.2));
    return { w, d, h, parts };
  },
  wardrobe: (r) => {
    const k = r();
    if (k < 0.25) { const { w, d, h } = dims('vintage_cabinet_01'); return { w, d, h, parts: [mp('vintage_cabinet_01')] }; }
    if (k < 0.6) { const { w, d, h } = dims('drawer_cabinet'); return { w, d, h, parts: [mp('drawer_cabinet')] }; }
    return { w: 1.2, d: 0.6, h: 2.0, parts: [
      box('darkWood', 1.2, 2.0, 0.6, 0, 1.0, 0),
      box('black', 0.01, 1.9, 0.01, 0, 1.0, 0.305),
    ] };
  },
  dresser: () => ({ w: 1.0, d: 0.5, h: 0.85, parts: [
    box('wood', 1.0, 0.85, 0.5, 0, 0.425, 0),
    box('black', 0.95, 0.008, 0.01, 0, 0.3, 0.255), box('black', 0.95, 0.008, 0.01, 0, 0.58, 0.255),
  ] }),
  bathtub: () => ({ w: 1.7, d: 0.75, h: 0.55, parts: [
    box('ceramic', 1.7, 0.08, 0.75, 0, 0.04, 0),
    box('ceramic', 1.7, 0.5, 0.07, 0, 0.3, -0.34), box('ceramic', 1.7, 0.5, 0.07, 0, 0.3, 0.34),
    box('ceramic', 0.07, 0.5, 0.75, -0.815, 0.3, 0), box('ceramic', 0.07, 0.5, 0.75, 0.815, 0.3, 0),
    cyl('metal', 0.015, 0.015, 0.2, 0.75, 0.68, -0.3, 0.5, 0, 0, 6),
  ] }),
  toilet: (r) => ({ w: 0.42, d: 0.68, h: 0.8, parts: [
    cyl('ceramic', 0.17, 0.13, 0.4, 0, 0.2, 0.08),
    cyl('ceramic', 0.2, 0.18, 0.05, 0, 0.42, 0.1),
    box('ceramic', 0.4, 0.38, 0.18, 0, 0.6, -0.24),
    mp('plunger', 0.36, 0, -0.1, r() * 3, 0.15, 0),
    ...(r() < 0.6 ? [mp('bleach_bottle', -0.32, 0, -0.2, r() * 3)] : []),
  ] }),
  vanity: () => ({ w: 0.8, d: 0.5, h: 0.9, parts: [
    box('appliance', 0.8, 0.82, 0.48, 0, 0.41, 0),
    box('ceramic', 0.82, 0.06, 0.5, 0, 0.85, 0),
    box('black', 0.4, 0.02, 0.3, 0, 0.885, 0.02),
    box('mirror', 0.6, 0.8, 0.02, 0, 1.55, -0.24),
  ] }),
  // left in the corridors
  boxes: (r) => {
    const b = dims('cardboard_box_01');
    return { w: 0.6, d: 0.55, h: 0.8, parts: [
      mp('cardboard_box_01', 0, 0, 0, (r() - 0.5) * 0.4),
      ...(r() < 0.5 ? [mp('cardboard_box_01', 0.03, b.h, 0, (r() - 0.5) * 0.8)] : []),
    ] };
  },
  plant: (r) => ({ w: 0.45, d: 0.45, h: 0.7, parts: [mp('potted_plant_04', 0, 0, 0, r() * 6, 0, 0, 2.4)] }),
  chair: (r) => ({ w: 0.6, d: 0.6, h: 1.0, parts: [mp('dining_chair_02', 0, 0, 0, Math.PI + (r() - 0.5) * 0.3)] }),
  extinguisher: () => ({ w: 0.35, d: 0.35, h: 0.66, parts: [mp('korean_fire_extinguisher_01')] }),
};

// A white dust sheet draped over a w x h x d block: folds down the sides,
// flaring out where it meets the floor, rounded over the top edges.
function sheetGeo(w, h, d, seed) {
  const r = mulberry32(seed);
  const W2 = w + 0.06, D2 = d + 0.06, H = h + 0.02;
  const geo = new THREE.BoxGeometry(W2, H, D2, Math.max(4, Math.round(W2 * 16)), Math.max(3, Math.round(H * 14)), Math.max(4, Math.round(D2 * 16)));
  geo.translate(0, H / 2, 0);
  const p = geo.attributes.position;
  const hw = W2 / 2, hd = D2 / 2;
  const ph1 = r() * 6, ph2 = r() * 6, f1 = 8 + r() * 5, f2 = 8 + r() * 5;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = y / H;
    const fold = Math.sin(x * f1 + ph1) * 0.5 + Math.sin(z * f2 + ph2) * 0.5;
    if (y > H - 0.001) {
      y += fold * 0.008;
    } else {
      const out = (1 - t) * (1 - t) * 0.07 + fold * 0.02 * (1 - t);
      if (Math.abs(x) / hw >= Math.abs(z) / hd) x += Math.sign(x) * out;
      else z += Math.sign(z) * out;
    }
    const e = Math.max(Math.abs(x) - (hw - 0.07), Math.abs(z) - (hd - 0.07), 0);
    if (y > H - 0.08) y -= e * 0.7;
    p.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

const IDENT = new THREE.Matrix4();
const COVERABLE = new Set(['sofa', 'armchair', 'tvUnit', 'bookshelf', 'coffeeTable', 'diningTable', 'bed', 'nightstand', 'dresser', 'wardrobe']);
// Swap an item's parts for dust sheets of the same footprint.
function sheeted(name, item, r) {
  const seed = Math.floor(r() * 1e9);
  const { w, d, h } = item;
  if (name === 'sofa' || name === 'armchair') {
    const back = { mat: 'sheet', geo: sheetGeo(w, h, 0.3, seed), m: new THREE.Matrix4().makeTranslation(0, 0, -d / 2 + 0.15) };
    return { ...item, parts: [{ mat: 'sheet', geo: sheetGeo(w, Math.min(0.48, h), d, seed + 1), m: IDENT }, back] };
  }
  return { ...item, parts: [{ mat: 'sheet', geo: sheetGeo(w, h, d, seed), m: IDENT }] };
}

// Printed notices and handwritten notes pinned up in the corridors.
function notice(lines, rand) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 700;
  const g = c.getContext('2d');
  g.fillStyle = `rgb(${232 + rand() * 12},${228 + rand() * 12},${214 + rand() * 12})`;
  g.fillRect(0, 0, 512, 700);
  g.fillStyle = '#1c1c1c';
  g.textAlign = 'center';
  if (lines.hand) {
    g.font = '44px "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive';
    lines.text.forEach((l, i) => g.fillText(l, 256 + (rand() - 0.5) * 10, 230 + i * 70));
  } else {
    g.font = 'bold 54px Helvetica, Arial, sans-serif';
    g.fillText(lines.title, 256, 110);
    g.fillRect(60, 140, 392, 4);
    g.font = '30px Helvetica, Arial, sans-serif';
    lines.text.forEach((l, i) => g.fillText(l, 256, 220 + i * 46));
  }
  // tape
  g.fillStyle = 'rgba(220,210,170,0.7)';
  g.fillRect(200, 0, 112, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
export function buildWorld(level, M, assets) {
  MODEL_LIB = assets.models;
  const group = new THREE.Group();
  const B = new Builder(M);
  const rand = level.rand;
  const { W, H } = level;

  M.glass.side = THREE.DoubleSide;
  M.rug = M.rug || new THREE.MeshStandardMaterial({ map: M.carpetBed.map, normalMap: M.carpetBed.normalMap, color: 0x8a4a3a, roughness: 1 });
  M.cardboard = M.cardboard || new THREE.MeshStandardMaterial({ color: 0x8a6e4a, roughness: 0.95 });
  M.mirror = M.mirror || new THREE.MeshStandardMaterial({ color: 0x3a3e40, roughness: 0.12, metalness: 0.9 });
  M.wallTileFurniture = M.wallTileFurniture || new THREE.MeshStandardMaterial({ map: M.wallTile.map, roughness: 0.3, color: 0xdddddd });

  const unitStyle = level.units.map(() => Math.floor(rand() * 3));
  const wallMat = (x, z) => {
    const k = level.kindAt(x, z);
    if (k === K.HALL) return 'hallPaint';
    if (k === K.STAIR || k === K.ELEVATOR) return 'concrete';
    if (k === K.VOID) return null;
    const r = level.roomAt(x, z);
    if (r.type === 'bath') return 'wallTile';
    const s = unitStyle[r.unit];
    if (r.type === 'bed') return ['wallpaperB', 'wallpaperC', 'wallpaperA'][s];
    if (r.type === 'kitchen') return 'kitchenWall';
    return ['wallpaperA', 'wallpaperB', 'wallpaperC'][s];
  };
  const floorMat = (x, z) => {
    const k = level.kindAt(x, z);
    if (k === K.HALL) return 'carpetHall';
    if (k !== K.ROOM) return null;
    const t = level.roomAt(x, z).type;
    return t === 'bath' || t === 'kitchen' ? 'floorTile' : t === 'bed' ? 'carpetBed' : 'laminate';
  };

  const fixtures = [];
  const glassSpots = [];
  const furnitureBoxes = [];
  const wallSlots = new Map(); // room id -> slots
  const clearZones = new Map(); // room id -> boxes that must stay empty (doorways)
  const addSlot = (rid, s) => { if (!wallSlots.has(rid)) wallSlots.set(rid, []); wallSlots.get(rid).push(s); };
  const addClear = (rid, b) => { if (!clearZones.has(rid)) clearZones.set(rid, []); clearZones.get(rid).push(b); };

  // ---------- walls ----------
  // Axis 'v': wall plane x = line, running along z. Axis 'h': plane z = line, along x.
  const P = (axis, line, s, y, off) => (axis === 'v' ? new THREE.Vector3(line + off, y, s) : new THREE.Vector3(s, y, line + off));
  const N = (axis, sg) => (axis === 'v' ? new THREE.Vector3(sg, 0, 0) : new THREE.Vector3(0, 0, sg));
  const A = (axis) => (axis === 'v' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0));
  // Each wall segment gets its own texture offset so the photo textures
  // never visibly repeat from one segment to the next.
  let uOffset = 0;
  const uvSide = (axis, sc) => { const o = uOffset; return (p) => [(axis === 'v' ? p.z : p.x) / sc + o, p.y / sc]; };
  const uvAcross = (axis, sc) => (p) => [(axis === 'v' ? p.x : p.z) / sc, p.y / sc];

  // A vertical rectangle on one face of the wall.
  const face = (axis, line, mat, sg, s0, s1, y0, y1, off = sg * T2) => {
    if (!mat || s1 <= s0 || y1 <= y0) return;
    const sc = TEX_SCALE[mat] || 1;
    B.quad(mat, P(axis, line, s0, y0, off), P(axis, line, s1, y0, off), P(axis, line, s1, y1, off), P(axis, line, s0, y1, off), N(axis, sg), uvSide(axis, sc));
  };
  // Surfaces inside an opening (jambs, header underside, sill).
  const jamb = (axis, line, mat, s, dirSign, y0, y1) => {
    const n = A(axis).multiplyScalar(dirSign);
    B.quad(mat, P(axis, line, s, y0, -T2), P(axis, line, s, y0, T2), P(axis, line, s, y1, T2), P(axis, line, s, y1, -T2), n, uvAcross(axis, 1));
  };
  const lintel = (axis, line, mat, s0, s1, y, up) => {
    const n = new THREE.Vector3(0, up ? 1 : -1, 0);
    B.quad(mat, P(axis, line, s0, y, -T2), P(axis, line, s1, y, -T2), P(axis, line, s1, y, T2), P(axis, line, s0, y, T2), n, (p) => [(axis === 'v' ? p.z : p.x), (axis === 'v' ? p.x : p.z)]);
  };
  const skirting = (axis, line, mat, sg, s0, s1) => {
    if (!mat) return;
    const o = sg * (T2 + 0.014);
    B.quad(mat, P(axis, line, s0, 0, o), P(axis, line, s1, 0, o), P(axis, line, s1, 0.09, o), P(axis, line, s0, 0.09, o), N(axis, sg), uvSide(axis, 1));
    B.quad(mat, P(axis, line, s0, 0.09, sg * T2), P(axis, line, s1, 0.09, sg * T2), P(axis, line, s1, 0.09, o), P(axis, line, s0, 0.09, o), new THREE.Vector3(0, 1, 0), uvSide(axis, 1));
  };
  const skirtMat = (x, z) => {
    const k = level.kindAt(x, z);
    if (k === K.HALL) return 'hallSkirting';
    if (k === K.ROOM && level.roomAt(x, z).type !== 'bath') return 'skirting';
    return null;
  };

  // Place an item (part list) at world position with rotation (front faces +z rotated).
  const placeParts = (parts, x, y, z, rotY, noShadow = false) => {
    const base = mtx(x, y, z, 0, rotY, 0);
    for (const p of parts) {
      const m = base.clone().multiply(p.m);
      if (p.model) B.model(p.model, m, noShadow);
      else B.geo(p.mat, p.geo, m);
    }
  };

  const doorParts = (mat, handle = true) => {
    const parts = [box(mat, DOOR_W - 0.03, DOOR_H - 0.02, 0.045, (DOOR_W - 0.03) / 2, (DOOR_H - 0.02) / 2 + 0.01, 0)];
    if (handle) {
      parts.push(box('metal', 0.12, 0.02, 0.02, DOOR_W - 0.13, 1.0, 0.045));
      parts.push(box('metal', 0.12, 0.02, 0.02, DOOR_W - 0.13, 1.0, -0.045));
    }
    return parts;
  };
  // Hinged door: hinge at world point, closed direction cd (unit along the
  // edge), swings by `angle` toward side normal sn.
  const doorAt = (hinge, cd, sn, angle, mat, yOff = 0) => {
    const dir = cd.clone().multiplyScalar(Math.cos(angle)).addScaledVector(sn, Math.sin(angle));
    placeParts(doorParts(mat), hinge.x, yOff, hinge.z, Math.atan2(-dir.z, dir.x));
  };
  const casing = (axis, line, sg, cg0, cg1, top) => {
    const o = sg * (T2 + 0.012);
    const rotY = axis === 'v' ? Math.PI / 2 : 0;
    for (const [s, y, sx, sy] of [
      [cg0 - 0.035, top / 2, 0.07, top + 0.07],
      [cg1 + 0.035, top / 2, 0.07, top + 0.07],
      [(cg0 + cg1) / 2, top + 0.035, cg1 - cg0 + 0.14, 0.07],
    ]) {
      const p = P(axis, line, s, y, o);
      B.geo('trim', UNIT_BOX, mtx(p.x, p.y, p.z, 0, rotY, 0, sx, sy, 0.025));
    }
  };

  const plateLabels = [];
  const buildEdge = (axis, line, s0, e, cellNeg, cellPos) => {
    const matNeg = wallMat(...cellNeg), matPos = wallMat(...cellPos);
    // (stairwell walls must match their copies on other storeys exactly)
    const stair = level.kindAt(...cellNeg) === K.STAIR || level.kindAt(...cellPos) === K.STAIR;
    uOffset = stair ? 0 : rand() * 7.3;
    const sides = [[-1, matNeg, cellNeg], [1, matPos, cellPos]];
    const s1 = s0 + CELL;
    const mid = s0 + CELL / 2;
    const full = (a, b, y0, y1, withSkirt) => {
      for (const [sg, mat, cell] of sides) {
        face(axis, line, mat, sg, a, b, y0, y1);
        if (withSkirt) skirting(axis, line, skirtMat(...cell), sg, a, b);
      }
    };
    let gap = 0, top = WALL_H;
    if (e === E.DOOR || e === E.STAIRDOOR || e === E.LOCKED) { gap = DOOR_W; top = DOOR_H; }
    else if (e === E.ELEVATOR) { gap = 1.2; top = DOOR_H; }
    else if (e === E.WINDOW) { gap = WINDOW_W; }
    if (!gap) {
      full(s0 - T2, s1 + T2, 0, WALL_H, true);
      return;
    }
    const g0 = mid - gap / 2, g1 = mid + gap / 2;
    full(s0 - T2, g0, 0, WALL_H, true);
    full(g1, s1 + T2, 0, WALL_H, true);
    if (e === E.WINDOW) {
      full(g0, g1, 0, SILL, true);
      full(g0, g1, HEAD, WALL_H, false);
      jamb(axis, line, 'trim', g0, 1, SILL, HEAD);
      jamb(axis, line, 'trim', g1, -1, SILL, HEAD);
      lintel(axis, line, 'trim', g0, g1, SILL, true);
      lintel(axis, line, 'trim', g0, g1, HEAD, false);
      const rotY = axis === 'v' ? Math.PI / 2 : 0;
      const c = P(axis, line, mid, (SILL + HEAD) / 2, 0);
      B.geo('glass', UNIT_BOX, mtx(c.x, c.y, c.z, 0, rotY, 0, gap, HEAD - SILL, 0.01));
      // frame + mullion
      for (const [s, sx] of [[g0 + 0.03, 0.06], [g1 - 0.03, 0.06], [mid, 0.05]]) {
        const p = P(axis, line, s, (SILL + HEAD) / 2, 0);
        B.geo('metal', UNIT_BOX, mtx(p.x, p.y, p.z, 0, rotY, 0, sx, HEAD - SILL, 0.06));
      }
      for (const y of [SILL + 0.03, HEAD - 0.03]) {
        const p = P(axis, line, mid, y, 0);
        B.geo('metal', UNIT_BOX, mtx(p.x, p.y, p.z, 0, rotY, 0, gap, 0.06, 0.06));
      }
      // room side: curtains, and glass on the floor under broken panes
      for (const [sg, mat, cell] of sides) {
        if (!mat || level.kindAt(...cell) !== K.ROOM) continue;
        if (rand() < 0.5) {
          const f = ['fabricA', 'fabricB', 'fabricC'][Math.floor(rand() * 3)];
          for (const s of [g0 - 0.15, g1 + 0.15]) {
            const p = P(axis, line, s, 1.2, sg * (T2 + 0.1));
            B.geo(f, UNIT_BOX, mtx(p.x, p.y, p.z, 0, rotY, (rand() - 0.5) * 0.05, 0.55, 2.3, 0.03));
          }
        }
      }
      return;
    }
    full(g0, g1, top, WALL_H, false);
    jamb(axis, line, 'trim', g0, 1, 0, top);
    jamb(axis, line, 'trim', g1, -1, 0, top);
    lintel(axis, line, 'trim', g0, g1, top, false);
    const along = A(axis);
    if (e === E.ELEVATOR) {
      const rotY = axis === 'v' ? Math.PI / 2 : 0;
      for (const [s, w] of [[mid - 0.3, 0.58], [mid + 0.31, 0.58]]) {
        const p = P(axis, line, s, top / 2, 0);
        B.geo('metal', UNIT_BOX, mtx(p.x, p.y, p.z, 0, rotY, 0, w, top, 0.05));
      }
      for (const [sg, , cell] of sides) {
        if (level.kindAt(...cell) !== K.HALL) continue;
        const p = P(axis, line, g1 + 0.3, 1.2, sg * (T2 + 0.01));
        B.geo('darkMetal', UNIT_BOX, mtx(p.x, p.y, p.z, 0, rotY, 0, 0.12, 0.25, 0.02));
        elevatorSigns.push({ p: P(axis, line, mid, 1.45, sg * (T2 + 0.06)), rotY: axis === 'v' ? (sg > 0 ? Math.PI / 2 : -Math.PI / 2) : (sg > 0 ? 0 : Math.PI) });
      }
      return;
    }
    for (const [sg, , cell] of sides) {
      if (level.kindAt(...cell) !== K.VOID) casing(axis, line, sg, g0, g1, top);
    }
    // Which side does the door swing into?
    const kNeg = level.kindAt(...cellNeg), kPos = level.kindAt(...cellPos);
    let swing = rand() < 0.5 ? -1 : 1;
    if (e === E.STAIRDOOR) swing = kNeg === K.STAIR ? -1 : 1;
    else if (kNeg === K.HALL) swing = 1;
    else if (kPos === K.HALL) swing = -1;
    const sn = N(axis, swing);
    // stair doors always hinge the same way so every storey's copy matches
    const hingeAtStart = e === E.STAIRDOOR || rand() < 0.5;
    const hingeS = hingeAtStart ? g0 + 0.01 : g1 - 0.01;
    const hinge = P(axis, line, hingeS, 0, 0);
    const cd = along.clone().multiplyScalar(hingeAtStart ? 1 : -1);
    const front = kNeg === K.HALL || kPos === K.HALL;
    if (e === E.STAIRDOOR) {
      stairDoorSpecs.push({ hinge, cd, sn, axis, line, mid, sgHall: kNeg === K.HALL ? -1 : 1 });
      return;
    }
    if (e === E.LOCKED) {
      doorAt(hinge, cd, sn, 0, 'door');
    } else {
      doorAt(hinge, cd, sn, (front ? 1.0 : 1.2) + rand() * 0.5, front ? 'darkWood' : 'door');
    }
    if (front) {
      const sgHall = kNeg === K.HALL ? -1 : 1;
      const cell = sgHall < 0 ? cellPos : cellNeg;
      const unit = level.roomAt(...cell)?.unit ?? 0;
      plateLabels.push({ p: P(axis, line, g1 + 0.25, 1.55, sgHall * (T2 + 0.012)), n: N(axis, sgHall), text: `4${String(unit + 1).padStart(2, '0')}` });
    }
  };

  const stairDoorSpecs = [];
  const elevatorSigns = [];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x <= W; x++) {
      const e = level.vE[z * (W + 1) + x];
      if (e === E.OPEN) continue;
      const a = [x - 1, z], b = [x, z];
      if (level.kindAt(...a) === K.VOID && level.kindAt(...b) === K.VOID) continue;
      buildEdge('v', x * CELL, z * CELL, e, a, b);
    }
  }
  for (let z = 0; z <= H; z++) {
    for (let x = 0; x < W; x++) {
      const e = level.hE[z * W + x];
      if (e === E.OPEN) continue;
      const a = [x, z - 1], b = [x, z];
      if (level.kindAt(...a) === K.VOID && level.kindAt(...b) === K.VOID) continue;
      buildEdge('h', z * CELL, x * CELL, e, a, b);
    }
  }

  // ---------- floors & ceilings ----------
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const fm = floorMat(x, z);
      if (!fm) continue;
      const x0 = x * CELL, x1 = x0 + CELL, z0 = z * CELL, z1 = z0 + CELL;
      const sc = TEX_SCALE[fm];
      B.quad(fm, new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x0, 0, z1), new THREE.Vector3(0, 1, 0), (p) => [p.x / sc, p.z / sc]);
      const cs = TEX_SCALE.ceiling;
      B.quad('ceiling', new THREE.Vector3(x0, WALL_H, z0), new THREE.Vector3(x1, WALL_H, z0), new THREE.Vector3(x1, WALL_H, z1), new THREE.Vector3(x0, WALL_H, z1), new THREE.Vector3(0, -1, 0), (p) => [p.x / cs, p.z / cs]);
    }
  }

  // ---------- room analysis: wall slots and doorway clearances ----------
  for (const room of level.rooms) {
    if (room.type === 'stair' || room.type === 'elevator') continue;
    for (const [x, z] of room.cells) {
      for (const [dx, dz] of DIRS4) {
        const nb = level.roomAt(x + dx, z + dz);
        if (nb && nb.id === room.id) continue;
        const e = level.edge(x, z, dx, dz);
        const axis = dx !== 0 ? 'v' : 'h';
        const line = dx !== 0 ? (dx > 0 ? x + 1 : x) * CELL : (dz > 0 ? z + 1 : z) * CELL;
        const s0 = dx !== 0 ? z * CELL : x * CELL;
        const n = new THREE.Vector3(-dx, 0, -dz);
        const slot = (a, b, low) => addSlot(room.id, { axis, line, a, b, n, low, cell: [x, z] });
        const gap = e === E.DOOR || e === E.STAIRDOOR || e === E.LOCKED ? DOOR_W : e === E.ELEVATOR ? 1.2 : 0;
        if (gap) {
          const g0 = s0 + CELL / 2 - gap / 2 - 0.15, g1 = s0 + CELL / 2 + gap / 2 + 0.15;
          slot(s0, g0, false);
          slot(g1, s0 + CELL, false);
          // keep 1.3m in front of the opening clear
          const pA = P(axis, line, g0, 0, 0), pB = P(axis, line, g1, 0, 0).addScaledVector(n, 1.3);
          addClear(room.id, { minX: Math.min(pA.x, pB.x), maxX: Math.max(pA.x, pB.x), minZ: Math.min(pA.z, pB.z), maxZ: Math.max(pA.z, pB.z) });
        } else {
          slot(s0, s0 + CELL, e === E.WINDOW);
        }
      }
    }
  }

  const overlaps = (a, b, m = 0) => a.minX < b.maxX + m && a.maxX > b.minX - m && a.minZ < b.maxZ + m && a.maxZ > b.minZ - m;
  const roomRect = (room) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of room.cells) {
      minX = Math.min(minX, x * CELL); maxX = Math.max(maxX, (x + 1) * CELL);
      minZ = Math.min(minZ, z * CELL); maxZ = Math.max(maxZ, (z + 1) * CELL);
    }
    return { minX: minX + T2, maxX: maxX - T2, minZ: minZ + T2, maxZ: maxZ - T2 };
  };
  const centreClear = (room, b) => {
    for (const [x, z] of room.cells) {
      const cx = (x + 0.5) * CELL, cz = (z + 0.5) * CELL;
      const qx = Math.max(b.minX, Math.min(cx, b.maxX)), qz = Math.max(b.minZ, Math.min(cz, b.maxZ));
      if (Math.hypot(cx - qx, cz - qz) < 0.6) return false;
    }
    return true;
  };
  const fits = (room, b) => {
    const rr = roomRect(room);
    if (b.minX < rr.minX - 0.01 || b.maxX > rr.maxX + 0.01 || b.minZ < rr.minZ - 0.01 || b.maxZ > rr.maxZ + 0.01) return false;
    for (const f of furnitureBoxes) if (overlaps(b, f, 0.04)) return false;
    for (const c of clearZones.get(room.id) || []) if (overlaps(b, c)) return false;
    return centreClear(room, b);
  };

  // Put an item against a wall of the room. Returns placement or null.
  const placeAgainstWall = (room, item, opts = {}) => {
    const slots = (wallSlots.get(room.id) || []).slice().sort(() => rand() - 0.5);
    for (const s of slots) {
      if (s.low && item.h > 0.95) continue;
      const len = s.b - s.a;
      if (len < item.w + 0.02) continue;
      for (let t = 0; t < 3; t++) {
        const along = s.a + item.w / 2 + 0.01 + rand() * (len - item.w - 0.02);
        const p = P(s.axis, s.line, along, 0, 0).addScaledVector(s.n, T2 + item.d / 2 + 0.01 + (opts.gap || 0));
        const halfA = item.w / 2, halfN = item.d / 2;
        const b = s.axis === 'v'
          ? { minX: p.x - halfN, maxX: p.x + halfN, minZ: p.z - halfA, maxZ: p.z + halfA }
          : { minX: p.x - halfA, maxX: p.x + halfA, minZ: p.z - halfN, maxZ: p.z + halfN };
        if (!fits(room, b)) continue;
        const rotY = Math.atan2(s.n.x, s.n.z);
        if (item.parts) placeParts(item.parts, p.x, 0, p.z, rotY);
        b.h = item.h;
        b.furniture = true;
        if (item.solid !== false) {
          furnitureBoxes.push(b);
          level.addBox(b);
        }
        return { p, rotY, slot: s, along };
      }
    }
    return null;
  };

  // Free-standing pieces go on interior grid vertices, which no path crosses.
  const interiorPoints = (room) => {
    const set = new Set(room.cells.map(([x, z]) => `${x},${z}`));
    const pts = [];
    for (const [x, z] of room.cells) {
      if (set.has(`${x + 1},${z}`) && set.has(`${x},${z + 1}`) && set.has(`${x + 1},${z + 1}`)) pts.push(new THREE.Vector3((x + 1) * CELL, 0, (z + 1) * CELL));
    }
    return pts.sort(() => rand() - 0.5);
  };
  const placeFree = (room, item, p, rotY) => {
    const b = { minX: p.x - item.w / 2 - 0.1, maxX: p.x + item.w / 2 + 0.1, minZ: p.z - item.w / 2 - 0.1, maxZ: p.z + item.w / 2 + 0.1 };
    for (const f of furnitureBoxes) if (overlaps(b, f)) return false;
    placeParts(item.parts, p.x, 0, p.z, rotY);
    if (item.solid !== false) {
      const sb = { minX: p.x - Math.max(item.w, item.d) / 2, maxX: p.x + Math.max(item.w, item.d) / 2, minZ: p.z - Math.max(item.w, item.d) / 2, maxZ: p.z + Math.max(item.w, item.d) / 2, furniture: true, h: item.h };
      sb.minX += 0.15; sb.maxX -= 0.15; sb.minZ += 0.15; sb.maxZ -= 0.15;
      furnitureBoxes.push(sb);
      level.addBox(sb);
    }
    return true;
  };

  // ---------- furnish ----------
  const unitHasKitchen = new Set(level.rooms.filter((r) => r.type === 'kitchen').map((r) => r.unit));
  // In some apartments the furniture was covered before everyone left.
  const covered = new Set(level.units.filter(() => rand() < 0.45).map((u) => u.id));
  for (const room of level.rooms) {
    const make = (name) => {
      const it = ITEMS[name](rand);
      return covered.has(room.unit) && COVERABLE.has(name) ? sheeted(name, it, rand) : it;
    };
    const put = (name, opts) => placeAgainstWall(room, make(name), opts);
    if (room.type === 'living') {
      put('sofa');
      put('tvUnit');
      if (!unitHasKitchen.has(room.unit)) { put('kitchenRun'); put('fridge'); }
      if (rand() < 0.6) put('bookshelf');
      if (rand() < 0.5) put('armchair');
      if (rand() < 0.4) put('plant');
      const pts = interiorPoints(room);
      if (pts[0]) { placeFree(room, ITEMS.rug(rand), pts[0], 0); placeFree(room, make('coffeeTable'), pts[0], (rand() - 0.5) * 0.2); }
      if (pts[1]) placeFree(room, make('diningTable'), pts[1], Math.floor(rand() * 2) * Math.PI / 2);
    } else if (room.type === 'kitchen') {
      put('kitchenRun');
      put('fridge');
      if (rand() < 0.5) put('chair');
    } else if (room.type === 'bed') {
      put('bed');
      put('nightstand');
      put('wardrobe');
      if (rand() < 0.5) put('dresser');
      if (rand() < 0.3) put('boxes');
    } else if (room.type === 'bath') {
      put('bathtub');
      put('toilet');
      put('vanity');
    } else if (room.type === 'hall') {
      const n = Math.floor(room.cells.length * 0.35);
      for (let i = 0; i < n; i++) put(pick(rand, ['boxes', 'boxes', 'plant', 'chair', 'extinguisher']));
    }
  }

  // Crooked picture frames.
  for (const room of level.rooms) {
    if (room.type !== 'living' && room.type !== 'bed' && room.type !== 'hall') continue;
    const count = room.type === 'hall' ? 6 : 1 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i++) {
      const slots = wallSlots.get(room.id) || [];
      const s = slots[Math.floor(rand() * slots.length)];
      if (!s || s.b - s.a < 1) continue;
      const along = s.a + 0.5 + rand() * (s.b - s.a - 1);
      const p = P(s.axis, s.line, along, 1.55, 0).addScaledVector(s.n, T2 + 0.02);
      if (tallAt(p, s.n)) continue;
      const rotY = Math.atan2(s.n.x, s.n.z);
      const tilt = (rand() - 0.5) * 0.04;
      const name = pick(rand, ['hanging_picture_frame_01', 'hanging_picture_frame_02', 'hanging_picture_frame_02', 'hanging_picture_frame_03']);
      const fd = dims(name);
      placeParts([mp(name, 0, -fd.h / 2, fd.d / 2 - 0.01, 0, 0, tilt)], p.x, p.y, p.z, rotY);
    }
  }
  function tallAt(p, n) {
    const q = p.clone().addScaledVector(n, 0.3);
    return furnitureBoxes.some((b) => b.h > 1.3 && q.x > b.minX && q.x < b.maxX && q.z > b.minZ && q.z < b.maxZ);
  }

  // ---------- lights ----------
  // Fixture bodies are real models baked into the batches; the glowing part
  // of every fixture is one instance of a shared mesh, so flickering a light
  // is just a colour change.
  // Corridors still mostly have power; the apartments mostly don't.
  const pickMode = (hall = false) => {
    const r = rand();
    if (hall) return r < 0.45 ? 'steady' : r < 0.75 ? 'flicker' : r < 0.9 ? 'dying' : 'broken';
    return r < 0.3 ? 'steady' : r < 0.55 ? 'flicker' : r < 0.75 ? 'dying' : 'broken';
  };
  const glowSpecs = { tube: [], globe: [] };
  const addFixture = (pos, mode, power, color, glowKind, glowMatrix, glowColor) => {
    const f = {
      pos, color: new THREE.Color(color), power, mode, level: mode === 'broken' ? 0 : 1, timer: rand() * 2, on: mode !== 'broken',
      glow: { kind: glowKind, index: glowSpecs[glowKind].length, color: glowColor },
    };
    glowSpecs[glowKind].push(glowMatrix);
    fixtures.push(f);
  };
  const tube = dims('mounted_fluorescent_lights');
  for (const [x, z] of level.hall.cells) {
    if ((x + z) % 2 !== 0) continue;
    const c = level.center(x, z);
    const along = level.kindAt(x + 1, z) === K.HALL || level.kindAt(x - 1, z) === K.HALL ? Math.PI / 2 : 0;
    placeParts([mp('mounted_fluorescent_lights', 0, 0, 0, along)], c.x, WALL_H - tube.h, c.z, 0, true);
    const cool = rand() < 0.5;
    addFixture(new THREE.Vector3(c.x, WALL_H - 0.25, c.z), pickMode(true), 7 + rand() * 3, cool ? 0xdde8ff : 0xffe2b8,
      'tube', mtx(c.x, WALL_H - tube.h - 0.004, c.z, Math.PI / 2, 0, 0, (along ? tube.d : tube.w) * 0.9, (along ? tube.w : tube.d) * 0.88, 1),
      cool ? new THREE.Color(2.6, 2.9, 3.2) : new THREE.Color(3.2, 2.9, 2.5));
  }
  // the glass globe of the pendant lamp, in model space
  const lampLib = MODEL_LIB.modern_ceiling_lamp_01;
  const globeBox = new THREE.Box3();
  lampLib.root.traverse((o) => { if (o.isMesh && /globe/i.test(o.material.name)) globeBox.expandByObject(o); });
  const lampC = lampLib.box.getCenter(new THREE.Vector3());
  const globeC = globeBox.getCenter(new THREE.Vector3()).sub(new THREE.Vector3(lampC.x, lampLib.box.min.y, lampC.z));
  const globeR = globeBox.getSize(new THREE.Vector3()).x / 2;
  const lampDrop = 0.45; // part of the cord disappears into the ceiling
  for (const room of level.rooms) {
    if (room.type === 'hall' || room.type === 'stair' || room.type === 'elevator' || rand() < 0.35) continue;
    const rr = roomRect(room);
    const cx = (rr.minX + rr.maxX) / 2, cz = (rr.minZ + rr.maxZ) / 2;
    const y0 = WALL_H - lampLib.size.y + lampDrop;
    placeParts([mp('modern_ceiling_lamp_01')], cx, y0, cz, 0, true);
    addFixture(new THREE.Vector3(cx, y0 + globeC.y - 0.15, cz), pickMode(), 3.5 + rand() * 2, 0xffd9a8,
      'globe', mtx(cx + globeC.x, y0 + globeC.y, cz + globeC.z, 0, 0, 0, globeR * 1.03, globeR * 1.03, globeR * 1.03),
      new THREE.Color(3.4, 2.9, 2.2));
  }
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
  const glowGeo = { tube: new THREE.PlaneGeometry(1, 1), globe: new THREE.SphereGeometry(1, 20, 14) };
  const glows = {};
  for (const kind of ['tube', 'globe']) {
    const list = glowSpecs[kind];
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(glowGeo[kind], glowMat, list.length);
    list.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, new THREE.Color(0, 0, 0)); });
    im.frustumCulled = false;
    group.add(im);
    glows[kind] = im;
  }
  for (const f of fixtures) if (f.glow) f.glow.mesh = glows[f.glow.kind];

  // ---------- stairwells ----------
  const stairDoors = [];
  const signTex = textTexture('4', '#c9c2b0', '#2a2a28', 128, 128);
  const signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.8 });
  const stairBulb = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff2dd, emissiveIntensity: 2 });
  for (const s of level.stairs) {
    const sp = (u, w, y = 0) => level.stairToWorld(s, u, w, y);
    const rotU = Math.atan2(-s.U.z, s.U.x);
    // A box in stair-local space: centre (u, y, w), size along u / y / w.
    const sbox = (mat, u, y, w, su, sy, sw, pitch = 0) => {
      const c = sp(u, w, y);
      const m = new THREE.Matrix4().makeRotationY(rotU).multiply(new THREE.Matrix4().makeRotationZ(pitch)).scale(new THREE.Vector3(su, sy, sw));
      m.setPosition(c);
      B.geo(mat, UNIT_BOX, m);
    };
    const L = STAIR.LANDING, MIDU = STAIR.LEN - STAIR.MID, flen = MIDU - L, half = WALL_H / 2;
    const steps = 8, tread = flen / steps, rise = half / steps;
    const slope = Math.atan2(half, flen);
    const sl = Math.hypot(half, flen);
    for (const k of [-2, -1, 0, 1, 2]) {
      const y0 = k * WALL_H;
      sbox('stairConcrete', L / 2, y0 - 0.1, 1.5, L, 0.2, 3);
      sbox('stairConcrete', MIDU + STAIR.MID / 2, y0 + half - 0.1, 1.5, STAIR.MID, 0.2, 3);
      for (let i = 0; i < steps; i++) {
        // up flight on the w < SPLIT side, back flight on the other
        sbox('stairConcrete', L + (i + 0.5) * tread, y0 + (i + 1) * rise - 0.12, 0.71, tread, 0.24, 1.42);
        sbox('stairConcrete', MIDU - (i + 0.5) * tread, y0 + half + (i + 1) * rise - 0.12, 2.29, tread, 0.24, 1.42);
      }
      // smooth soffits under the flights
      sbox('stairConcrete', L + flen / 2, y0 + half / 2 - 0.22, 0.71, sl, 0.12, 1.42, slope);
      sbox('stairConcrete', L + flen / 2, y0 + half + half / 2 - 0.22, 2.29, sl, 0.12, 1.42, -slope);
      // handrails
      for (const [w, yA, yB] of [[0.12, y0, y0 + half], [2.88, y0 + WALL_H, y0 + half], [1.42, y0, y0 + half], [1.58, y0 + WALL_H, y0 + half]]) {
        const pitch = yA < yB ? slope : -slope;
        sbox('metal', L + flen / 2, (yA + yB) / 2 + 0.9, w, sl, 0.04, 0.04, pitch);
      }
      // floor number, and the light on the landing
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), signMat);
      sign.position.copy(sp(0.8, 3 - T2 - 0.01, y0 + 1.6));
      sign.rotation.y = Math.atan2(-s.Wd.x, -s.Wd.z);
      group.add(sign);
      const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.12, 0.25), stairBulb);
      bulb.position.copy(sp(0.15, 2.2, y0 + 2.45));
      group.add(bulb);
      fixtures.push({ pos: sp(0.4, 2.2, y0 + 2.3), color: new THREE.Color(0xfff0dc), power: 3, mode: 'steady', mat: null, level: 1, timer: 0, on: true, stair: true });
      fixtures.push({ pos: sp(5.7, 1.5, y0 + half + 2.2), color: new THREE.Color(0xfff0dc), power: 2.5, mode: k === 0 ? 'flicker' : 'steady', mat: null, level: 1, timer: 0, on: true, stair: true });
      const mb = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.12, 0.25), stairBulb);
      mb.position.copy(sp(STAIR.LEN - 0.15, 1.5, y0 + half + 2.4));
      group.add(mb);
    }
    // The wall between flights runs through every storey. World-space UVs
    // keep it identical from one storey to the next.
    {
      const sc = TEX_SCALE.concrete;
      const y0 = -2.5 * WALL_H, y1 = 3.5 * WALL_H;
      for (const [w, n] of [[1.5 - 0.08, s.Wd.clone().negate()], [1.5 + 0.08, s.Wd.clone()]]) {
        const a = sp(L, w), b = sp(MIDU, w);
        const uvf = (p) => [((p.x - s.O.x) * s.U.x + (p.z - s.O.z) * s.U.z) / sc, p.y / sc];
        B.quad('concrete', new THREE.Vector3(a.x, y0, a.z), new THREE.Vector3(b.x, y0, b.z), new THREE.Vector3(b.x, y1, b.z), new THREE.Vector3(a.x, y1, a.z), n, uvf);
      }
      for (const [u, n] of [[L, s.U.clone().negate()], [MIDU, s.U.clone()]]) {
        const a = sp(u, 1.42), b = sp(u, 1.58);
        B.quad('concrete', new THREE.Vector3(a.x, y0, a.z), new THREE.Vector3(b.x, y0, b.z), new THREE.Vector3(b.x, y1, b.z), new THREE.Vector3(a.x, y1, a.z), n, (p) => [0, p.y / sc]);
      }
    }
    // Walls of the copied storeys (the real storey's walls come from the grid).
    for (const k of STAIR_COPIES) {
      const y0 = k * WALL_H;
      const yTop = y0 + WALL_H;
      const inner = (pA, pB, n, y0_, y1_) => {
        const sc = TEX_SCALE.concrete;
        const uvf = (p) => [(Math.abs(n.x) > 0.5 ? p.z : p.x) / sc, (p.y - y0) / sc];
        B.quad('concrete', new THREE.Vector3(pA.x, y0_, pA.z), new THREE.Vector3(pB.x, y0_, pB.z), new THREE.Vector3(pB.x, y1_, pB.z), new THREE.Vector3(pA.x, y1_, pA.z), n, uvf);
      };
      const nU = s.U.clone(), nW = s.Wd.clone();
      // back wall (u = LEN), facing -U
      inner(sp(STAIR.LEN - T2, -0.1), sp(STAIR.LEN - T2, 3.1), nU.clone().negate(), y0, yTop);
      // side walls
      inner(sp(-0.1, T2), sp(STAIR.LEN + 0.1, T2), nW.clone(), y0, yTop);
      inner(sp(-0.1, 3 - T2), sp(STAIR.LEN + 0.1, 3 - T2), nW.clone().negate(), y0, yTop);
      // door wall with an identical (closed) door
      const g0 = 1.5 - DOOR_W / 2, g1 = 1.5 + DOOR_W / 2;
      inner(sp(T2, -0.1), sp(T2, g0), nU.clone(), y0, yTop);
      inner(sp(T2, g1), sp(T2, 3.1), nU.clone(), y0, yTop);
      inner(sp(T2, g0), sp(T2, g1), nU.clone(), y0 + DOOR_H, yTop);
      const hinge = sp(0, g0 + 0.01);
      placeParts(doorParts('door'), hinge.x, y0, hinge.z, Math.atan2(-s.Wd.z, s.Wd.x));
      for (const [w, y, sy, sw] of [[g0 - 0.035, DOOR_H / 2, DOOR_H + 0.07, 0.07], [g1 + 0.035, DOOR_H / 2, DOOR_H + 0.07, 0.07], [1.5, DOOR_H + 0.035, 0.07, DOOR_W + 0.14]]) {
        const p = sp(T2 + 0.012, w, y0 + y);
        B.geo('trim', UNIT_BOX, mtx(p.x, p.y, p.z, 0, rotU, 0, 0.025, sy, sw));
      }
    }
    // cap the shaft far above and below
    sbox('concrete', STAIR.LEN / 2, 3 * WALL_H, 1.5, STAIR.LEN, 0.2, 3);
    sbox('concrete', STAIR.LEN / 2, -2 * WALL_H - 0.4, 1.5, STAIR.LEN, 0.2, 3);
  }
  // The real stairwell doors swing open when someone is near.
  for (const d of stairDoorSpecs) {
    const pivot = new THREE.Group();
    pivot.position.copy(d.hinge);
    const base = Math.atan2(-d.cd.z, d.cd.x);
    pivot.rotation.y = base;
    for (const p of doorParts('door')) {
      const m = new THREE.Mesh(p.geo, M[p.mat]);
      m.applyMatrix4(p.m);
      m.castShadow = m.receiveShadow = true;
      pivot.add(m);
    }
    group.add(pivot);
    // swing direction sign: rotate toward sn
    const test = d.cd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    const sign = test.dot(d.sn) > 0 ? 1 : -1;
    stairDoors.push({ pivot, base, sign, open: 0, target: 0, centre: P(d.axis, d.line, d.mid, 0, 0) });
  }

  // ---------- apartment number plates ----------
  if (plateLabels.length) {
    const cols = 8;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const g = canvas.getContext('2d');
    g.fillStyle = '#a08850';
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = '#1a1408';
    g.font = 'bold 34px Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    plateLabels.forEach((l, i) => g.fillText(l.text, (i % cols) * 64 + 32, Math.floor(i / cols) * 64 + 32));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.6 });
    const geos = plateLabels.map((l, i) => {
      const geo = new THREE.PlaneGeometry(0.16, 0.16);
      const u0 = (i % cols) / cols, v0 = 1 - (Math.floor(i / cols) + 1) / cols;
      const uv = geo.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) / cols, v0 + uv.getY(k) / cols);
      geo.applyMatrix4(mtx(l.p.x, l.p.y, l.p.z, 0, Math.atan2(l.n.x, l.n.z), 0));
      return geo;
    });
    group.add(new THREE.Mesh(mergeGeometries(geos), mat));
  }
  for (const s of elevatorSigns) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3), new THREE.MeshStandardMaterial({ map: textTexture('OUT OF ORDER', '#222', '#d8d2bc', 256, 96), roughness: 0.9 }));
    m.position.copy(s.p);
    m.rotation.set(0, s.rotY, (rand() - 0.5) * 0.15);
    group.add(m);
  }

  // ---------- notices pinned up in the corridors ----------
  const notes = [
    { title: 'NOTICE', text: ['This building is closed.', 'All residents must vacate', 'their units immediately.', '', 'DO NOT RE-ENTER.', '', '— Building Management'] },
    { title: 'EVACUATION', text: ['Floor 4 — all units.', 'Leave your keys at the', 'front desk on your way out.', '', 'Take only what', 'you can carry.'] },
    { title: 'NOTICE', text: ['Power to this floor', 'will be shut off.', '', 'The stairs are the', 'only way down.'] },
    { hand: true, text: ['It can\'t see.', 'It only listens.'] },
    { hand: true, text: ['Find the clock', 'that still works.'] },
    { hand: true, text: ['The stairs only', 'lead back here.'] },
  ];
  const hallSlots = (wallSlots.get(level.hall.id) || []).filter((s) => s.b - s.a > 1).sort(() => rand() - 0.5);
  notes.forEach((n, i) => {
    const s = hallSlots[i];
    if (!s) return;
    const p = P(s.axis, s.line, s.a + 0.4 + rand() * (s.b - s.a - 0.8), 1.45 + rand() * 0.15, 0).addScaledVector(s.n, T2 + 0.004);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.41), new THREE.MeshStandardMaterial({
      map: notice(n, rand), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    m.position.copy(p);
    m.rotation.set(0, Math.atan2(s.n.x, s.n.z), (rand() - 0.5) * 0.06);
    m.receiveShadow = true;
    group.add(m);
  });

  // ---------- clocks: only one of them still works ----------
  const clocks = [];
  const candidateRooms = level.rooms.filter((r) => ['living', 'bed', 'kitchen', 'hall'].includes(r.type) && r.cells.some(([x, z]) => level.reachable(x, z)));
  const dist = (room) => Math.min(...room.cells.map(([x, z]) => level.distFromStart[level.idx(x, z)]));
  const hangClock = (room, working) => {
    const slots = (wallSlots.get(room.id) || []).filter((s) => s.b - s.a > 0.6 && level.reachable(...s.cell)).sort(() => rand() - 0.5);
    for (const s of slots) {
      const along = s.a + 0.3 + rand() * (s.b - s.a - 0.6);
      const p = P(s.axis, s.line, along, 1.95, 0).addScaledVector(s.n, T2 + 0.005);
      if (tallAt(p, s.n)) continue;
      const clock = makeClock();
      clock.group.position.copy(p);
      clock.group.rotation.set(0, Math.atan2(s.n.x, s.n.z), 0);
      group.add(clock.group);
      clock.working = working;
      if (!working) clock.setTime(rand() * 12, rand() * 60, rand() * 60);
      clocks.push(clock);
      return true;
    }
    return false;
  };
  // The working clock goes somewhere well away from the start, but not
  // always in the remotest corner. If a room has no free wall, try the next.
  const byDist = candidateRooms.filter((r) => r.type !== 'hall').sort((a, b) => dist(a) - dist(b));
  const band = byDist.slice(Math.floor(byDist.length * 0.5), Math.ceil(byDist.length * 0.85)).sort(() => rand() - 0.5);
  const order = [...band, ...byDist.slice().reverse()];
  let workingRoom = null;
  for (const room of order) if (hangClock(room, true)) { workingRoom = room; break; }
  for (const room of candidateRooms.filter((r) => r !== workingRoom).sort(() => rand() - 0.5)) {
    if (clocks.length >= 10) break;
    hangClock(room, false);
  }

  // ---------- med kits ----------
  const medkits = [];
  const kitRooms = level.rooms.filter((r) => ['bath', 'kitchen', 'bed', 'living'].includes(r.type) && r.cells.some(([x, z]) => level.reachable(x, z) && level.distFromStart[level.idx(x, z)] > 3))
    .sort((a, b) => (a.type === 'bath' ? -0.4 : 0) - (b.type === 'bath' ? -0.4 : 0) + rand() - 0.5);
  for (const room of kitRooms) {
    if (medkits.length >= 6) break;
    const rc = room.cells[0];
    if (medkits.some((k) => Math.hypot(k.group.position.x - (rc[0] + 0.5) * CELL, k.group.position.z - (rc[1] + 0.5) * CELL) < 15)) continue;
    const kd = dims('medical_box');
    const spot = placeAgainstWall(room, { w: kd.w + 0.05, d: kd.d + 0.05, h: kd.h, solid: false });
    if (!spot) continue;
    const g = new THREE.Group();
    const kit = MODEL_LIB.medical_box.root.clone();
    const kc = MODEL_LIB.medical_box.box.getCenter(new THREE.Vector3());
    kit.position.set(-kc.x, -MODEL_LIB.medical_box.box.min.y, -kc.z);
    g.add(kit);
    g.position.copy(spot.p);
    g.rotation.y = spot.rotY + (rand() - 0.5) * 0.6;
    group.add(g);
    medkits.push({ group: g, taken: false });
  }

  // ---------- broken glass ----------
  // Ten piles are laid out; the difficulty decides how many are really there.
  const hallCells = level.hall.cells.filter(([x, z]) => level.distFromStart[level.idx(x, z)] > 3);
  for (let i = 0; i < 10 && hallCells.length; i++) {
    const [x, z] = hallCells.splice(Math.floor(rand() * hallCells.length), 1)[0];
    const c = level.center(x, z);
    glassSpots.push({ x: c.x + (rand() - 0.5), z: c.z + (rand() - 0.5), r: 1.0 });
  }
  const shardGeo = new THREE.BufferGeometry();
  shardGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0.3, 0.35, 0, 1], 3));
  shardGeo.computeVertexNormals();
  const shardMat = new THREE.MeshStandardMaterial({ color: 0xa8c4b4, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
  const perSpot = 60;
  const shards = new THREE.InstancedMesh(shardGeo, shardMat, Math.max(1, glassSpots.length * perSpot));
  let si = 0;
  const pp = new THREE.Vector3(), ss = new THREE.Vector3(), ee = new THREE.Euler(), qq = new THREE.Quaternion(), mm = new THREE.Matrix4();
  for (const gs of glassSpots) {
    for (let k = 0; k < perSpot; k++) {
      const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * gs.r;
      pp.set(gs.x + Math.cos(a) * d, 0.004 + rand() * 0.006, gs.z + Math.sin(a) * d);
      ee.set((rand() - 0.5) * 0.3, rand() * 6.3, (rand() - 0.5) * 0.3);
      qq.setFromEuler(ee);
      ss.setScalar(0.025 + rand() * rand() * 0.11);
      mm.compose(pp, qq, ss);
      shards.setMatrixAt(si++, mm);
    }
  }
  shards.receiveShadow = true;
  group.add(shards);
  const allGlass = glassSpots.slice();
  const setGlass = (n) => {
    n = Math.min(n, allGlass.length);
    glassSpots.length = 0;
    glassSpots.push(...allGlass.slice(0, n));
    shards.count = n * perSpot;
    shards.visible = n > 0;
  };

  B.build(group);

  return { group, fixtures, clocks, medkits, glassSpots, stairDoors, setGlass };
}

// ---------------------------------------------------------------------------
// A real wall clock (Poly Haven model). Its hands pivot about the centre of
// the face; each is modelled pointing somewhere around 10:10, so measure the
// angle of each hand's tip once and rotate relative to that.
let handRest = null;
function handAngles() {
  if (handRest) return handRest;
  handRest = {};
  MODEL_LIB.wall_clock.root.traverse((o) => {
    if (!o.isMesh || !/hand/.test(o.name)) return;
    const p = o.geometry.attributes.position;
    let best = 0, ang = 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), l = x * x + y * y;
      if (l > best) { best = l; ang = Math.atan2(y, x); }
    }
    handRest[o.name] = ang;
  });
  return handRest;
}

function makeClock() {
  const rest = handAngles();
  const group = new THREE.Group();
  const model = MODEL_LIB.wall_clock.root.clone();
  group.add(model);
  const hands = {};
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    if (/hours_hand/.test(o.name)) hands.hour = o;
    else if (/minute_hand/.test(o.name)) hands.minute = o;
    else if (/second_hand/.test(o.name)) hands.second = o;
  });
  // clockwise angle from 12 o'clock -> rotation about +z
  const aim = (mesh, frac) => { mesh.rotation.z = (Math.PI / 2 - frac * Math.PI * 2) - rest[mesh.name]; };
  return {
    group,
    working: false,
    taken: false,
    setTime(h, m, s) {
      aim(hands.hour, ((h % 12) + m / 60) / 12);
      aim(hands.minute, (m + s / 60) / 60);
      aim(hands.second, Math.floor(s) / 60);
    },
  };
}
