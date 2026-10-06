import * as THREE from 'three';
import { mulberry32 } from './util.js';

export const CELL = 3;
export const WALL_H = 2.8;
export const WALL_T = 0.16;
export const DOOR_W = 1.0;
export const DOOR_H = 2.1;

// Edge types (walls live on the edges between 3m cells).
export const E = { OPEN: 0, WALL: 1, DOOR: 2, WINDOW: 3, LOCKED: 5, STAIRDOOR: 6, ELEVATOR: 7 };
// Cell kinds.
export const K = { VOID: 0, HALL: 1, ROOM: 2, STAIR: 3, ELEVATOR: 4 };

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Stairwell geometry, in the stairwell's local frame: u runs from the door
// inwards (0..6m), w runs across (0..3m). Landing at the door end, a flight up
// on one side, a mid landing, and a flight back on the other side that arrives
// one full storey higher, directly above where you started.
export const STAIR = { LEN: 6, LANDING: 1.4, MID: 1.2, SPLIT: 1.5 };

export function passable(e) {
  return e === E.OPEN || e === E.DOOR || e === E.STAIRDOOR;
}

function gapWidth(e) {
  if (e === E.DOOR || e === E.STAIRDOOR) return DOOR_W;
  return 0;
}

// Does crossing edge e at offset `off` (metres along the edge) hit a wall?
function edgeBlocks(e, off) {
  if (e === E.OPEN) return false;
  const g = gapWidth(e);
  if (!g) return true;
  return Math.abs(off - CELL / 2) > g / 2 - 0.04;
}

// An abandoned apartment floor: a corridor ring with a cross through the
// middle, apartments on the outside (with windows) and in the inner blocks.
export class Level {
  constructor(seed) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.W = 21;
    this.H = 15;
    this.generate();
  }

  idx(x, z) { return z * this.W + x; }
  inBounds(x, z) { return x >= 0 && z >= 0 && x < this.W && z < this.H; }
  kindAt(x, z) { return this.inBounds(x, z) ? this.kind[this.idx(x, z)] : K.VOID; }
  roomAt(x, z) { return this.inBounds(x, z) ? this.rooms[this.roomOf[this.idx(x, z)]] : null; }

  // Edge between cell (x,z) and its neighbour in direction (dx,dz).
  edge(x, z, dx, dz) {
    if (dx === 1) return this.vE[z * (this.W + 1) + x + 1];
    if (dx === -1) return this.vE[z * (this.W + 1) + x];
    if (dz === 1) return this.hE[(z + 1) * this.W + x];
    return this.hE[z * this.W + x];
  }

  setEdge(x, z, dx, dz, v) {
    if (dx === 1) this.vE[z * (this.W + 1) + x + 1] = v;
    else if (dx === -1) this.vE[z * (this.W + 1) + x] = v;
    else if (dz === 1) this.hE[(z + 1) * this.W + x] = v;
    else this.hE[z * this.W + x] = v;
  }

  generate() {
    const { W, H, rand } = this;
    this.kind = new Uint8Array(W * H);
    this.roomOf = new Int32Array(W * H).fill(-1);
    this.rooms = [];
    this.units = [];
    this.stairs = [];
    this.elevators = [];
    const newRoom = (type, unit) => {
      const r = { id: this.rooms.length, type, unit, cells: [] };
      this.rooms.push(r);
      return r;
    };
    const setCell = (x, z, k, room) => {
      this.kind[this.idx(x, z)] = k;
      this.roomOf[this.idx(x, z)] = room.id;
      room.cells.push([x, z]);
    };

    // ---------- corridors ----------
    const hall = (this.hall = newRoom('hall', -1));
    const isHallSpot = (x, z) =>
      ((z === 2 || z === H - 3) && x >= 2 && x <= W - 3) ||
      ((x === 2 || x === W - 3) && z >= 2 && z <= H - 3) ||
      (z === 7 && x >= 3 && x <= W - 4) ||
      (x === 10 && z >= 3 && z <= H - 4);
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) if (isHallSpot(x, z)) setCell(x, z, K.HALL, hall);

    // ---------- apartment bands ----------
    // Each band is two cells deep; b=0 is the row against the corridor.
    const bands = [
      { x: 0, z: 1, ad: [1, 0], bd: [0, -1], len: 21, outer: true },
      { x: 0, z: 13, ad: [1, 0], bd: [0, 1], len: 21, outer: true },
      { x: 1, z: 2, ad: [0, 1], bd: [-1, 0], len: 11, outer: true },
      { x: 19, z: 2, ad: [0, 1], bd: [1, 0], len: 11, outer: true },
      { x: 3, z: 3, ad: [1, 0], bd: [0, 1], len: 7 },
      { x: 3, z: 6, ad: [1, 0], bd: [0, -1], len: 7 },
      { x: 11, z: 3, ad: [1, 0], bd: [0, 1], len: 7 },
      { x: 11, z: 6, ad: [1, 0], bd: [0, -1], len: 7 },
      { x: 3, z: 8, ad: [1, 0], bd: [0, 1], len: 7 },
      { x: 3, z: 11, ad: [1, 0], bd: [0, -1], len: 7 },
      { x: 11, z: 8, ad: [1, 0], bd: [0, 1], len: 7 },
      { x: 11, z: 11, ad: [1, 0], bd: [0, -1], len: 7 },
    ];
    // Two stairwells and a dead elevator go into distinct inner bands.
    const inner = [4, 5, 6, 7, 8, 9, 10, 11].sort(() => rand() - 0.5);
    bands[inner[0]].special = 'stair';
    bands[inner[1]].special = 'stair';
    bands[inner[2]].special = 'elevator';

    for (const band of bands) {
      const widths = [];
      let rem = band.len;
      if (band.special) { widths.push('S'); rem -= 1; }
      while (rem > 0) {
        let w = rem <= 4 ? rem : rand() < 0.55 ? 3 : 4;
        if (rem - w === 1) w = w === 4 ? 3 : 4; // never leave a single cell
        widths.push(w);
        rem -= w;
      }
      // outer bands: the end units must reach the corridor
      if (band.outer && widths[0] < 3 && widths.length > 1) { widths[1] += widths[0]; widths.shift(); }
      if (band.outer && widths[widths.length - 1] < 3 && widths.length > 1) { widths[widths.length - 2] += widths.pop(); }
      // put the special segment somewhere random
      if (band.special) {
        widths.shift();
        widths.splice(Math.floor(rand() * (widths.length + 1)), 0, 'S');
      }
      let a = 0;
      for (const w of widths) {
        const cellAt = (aa, b) => [band.x + band.ad[0] * aa + band.bd[0] * b, band.z + band.ad[1] * aa + band.bd[1] * b];
        if (w === 'S') {
          const front = cellAt(a, 0), back = cellAt(a, 1);
          if (band.special === 'stair') {
            const r = newRoom('stair', -1);
            setCell(...front, K.STAIR, r);
            setCell(...back, K.STAIR, r);
            const fc = this.center(...front);
            const O = new THREE.Vector3(fc.x - band.bd[0] * 1.5 - band.ad[0] * 1.5, 0, fc.z - band.bd[1] * 1.5 - band.ad[1] * 1.5);
            this.stairs.push({ room: r, front, back, O, U: new THREE.Vector3(band.bd[0], 0, band.bd[1]), Wd: new THREE.Vector3(band.ad[0], 0, band.ad[1]), out: [-band.bd[0], -band.bd[1]] });
          } else {
            const r = newRoom('elevator', -1);
            setCell(...front, K.ELEVATOR, r);
            setCell(...back, K.ELEVATOR, r);
            this.elevators.push({ front, out: [-band.bd[0], -band.bd[1]], ad: band.ad });
          }
          a += 1;
          continue;
        }
        this.buildUnit(band, a, w, cellAt, newRoom, setCell);
        a += w;
      }
    }

    // ---------- edges ----------
    this.vE = new Uint8Array(H * (W + 1)).fill(E.WALL);
    this.hE = new Uint8Array((H + 1) * W).fill(E.WALL);
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const r = this.roomOf[this.idx(x, z)];
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          const nx = x + dx, nz = z + dz;
          if (!this.inBounds(nx, nz)) continue;
          if (r >= 0 && r === this.roomOf[this.idx(nx, nz)]) this.setEdge(x, z, dx, dz, E.OPEN);
        }
        // exterior windows
        for (const [dx, dz] of DIRS4) {
          if (this.inBounds(x + dx, z + dz)) continue;
          const room = this.rooms[r];
          if (room && room.type !== 'bath' && rand() < 0.85) this.setEdge(x, z, dx, dz, E.WINDOW);
        }
      }
    }

    // Front doors, internal doors, stair doors, elevator doors.
    for (const u of this.units) {
      const [fx, fz] = u.frontDoor;
      this.setEdge(fx, fz, u.out[0], u.out[1], u.locked ? E.LOCKED : E.DOOR);
      this.connectUnit(u);
    }
    for (const s of this.stairs) this.setEdge(...s.front, s.out[0], s.out[1], E.STAIRDOOR);
    for (const el of this.elevators) this.setEdge(...el.front, el.out[0], el.out[1], E.ELEVATOR);

    // ---------- start, reachability ----------
    const startUnits = this.units.filter((u) => !u.locked && u.outer);
    const su = startUnits[Math.floor(rand() * startUnits.length)] || this.units.find((u) => !u.locked);
    const livingCells = this.rooms[su.living].cells;
    const sc = livingCells[Math.floor(rand() * livingCells.length)];
    // face the way out
    const tx = su.frontDoor[0] + su.out[0] - sc[0], tz = su.frontDoor[1] + su.out[1] - sc[1];
    this.start = { x: sc[0], z: sc[1], face: Math.atan2(-tx, -tz) };
    this.distFromStart = this.bfs(sc[0], sc[1], -1, true);
    this.reachable = (x, z) => this.distFromStart[this.idx(x, z)] < Infinity;

    // Entity spawn: far away in the corridors.
    const halls = hall.cells.filter(([x, z]) => this.reachable(x, z));
    halls.sort((p, q) => this.distFromStart[this.idx(...q)] - this.distFromStart[this.idx(...p)]);
    const sp = halls[Math.floor(rand() * Math.max(1, halls.length * 0.25))];
    this.spawn = { x: sp[0], z: sp[1] };

    // Centres of every opening something tall has to stoop through.
    this.doorways = [];
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          if (!this.inBounds(x + dx, z + dz)) continue;
          const e = this.edge(x, z, dx, dz);
          if (e === E.DOOR || e === E.STAIRDOOR) {
            this.doorways.push(new THREE.Vector3((x + 0.5 + dx * 0.5) * CELL, 0, (z + 0.5 + dz * 0.5) * CELL));
          }
        }
      }
    }

    this.boxIndex = new Map();
    this.buildWallBoxes();
  }

  buildUnit(band, a0, w, cellAt, newRoom, setCell) {
    const rand = this.rand;
    const unitId = this.units.length;
    const out = [-band.bd[0], -band.bd[1]];
    const corridorAdjacent = (aa) => {
      const [x, z] = cellAt(aa, 0);
      return this.kindAt(x + out[0], z + out[1]) === K.HALL;
    };
    // Choose which end gets the bedroom/bath so the living room reaches the corridor.
    let side = rand() < 0.5 ? 0 : w - 1;
    const livingCols = (s) => {
      const cols = [];
      for (let aa = 0; aa < w; aa++) {
        if (aa === s) continue;
        if (w >= 4 && aa === (s === 0 ? 1 : w - 2)) continue;
        cols.push(aa);
      }
      return cols;
    };
    if (w > 1 && !livingCols(side).some((aa) => corridorAdjacent(a0 + aa))) side = side === 0 ? w - 1 : 0;
    const cols = livingCols(side);
    const living = newRoom('living', unitId);
    const bath = newRoom('bath', unitId);
    const bed = newRoom('bed', unitId);
    const kitchen = w >= 4 ? newRoom('kitchen', unitId) : null;
    const s2 = side === 0 ? 1 : w - 2;
    for (let aa = 0; aa < w; aa++) {
      for (let b = 0; b < 2; b++) {
        const [x, z] = cellAt(a0 + aa, b);
        let r;
        if (cols.includes(aa)) r = living;
        else if (aa === side) r = b === 0 ? bath : bed;
        else r = b === 0 ? kitchen : bed; // the column next to the side column (w >= 4)
        setCell(x, z, K.ROOM, r);
      }
    }
    // Front door: the most central living-room front cell that faces the corridor.
    let cand = cols.filter((aa) => corridorAdjacent(a0 + aa));
    if (!cand.length) cand = [...Array(w).keys()].filter((aa) => corridorAdjacent(a0 + aa));
    cand.sort((p, q) => Math.abs(p - (w - 1) / 2) - Math.abs(q - (w - 1) / 2));
    const fa = cand[0] ?? 0;
    const unit = {
      id: unitId,
      outer: !!band.outer,
      locked: rand() < 0.14,
      frontDoor: cellAt(a0 + fa, 0),
      out,
      living: living.id,
      rooms: [living.id, bath.id, bed.id, ...(kitchen ? [kitchen.id] : [])],
    };
    this.units.push(unit);
  }

  // Add doors inside an apartment until every room is reachable from the living room.
  connectUnit(u) {
    const reached = new Set([u.living]);
    for (let guard = 0; guard < 8 && reached.size < u.rooms.length; guard++) {
      const options = [];
      for (const rid of reached) {
        for (const [x, z] of this.rooms[rid].cells) {
          for (const [dx, dz] of DIRS4) {
            const nr = this.roomAt(x + dx, z + dz);
            if (!nr || nr.unit !== u.id || reached.has(nr.id)) continue;
            options.push([x, z, dx, dz, nr.id]);
          }
        }
      }
      if (!options.length) break;
      const o = options[Math.floor(this.rand() * options.length)];
      this.setEdge(o[0], o[1], o[2], o[3], E.DOOR);
      reached.add(o[4]);
    }
  }

  // ---------- geometry queries ----------
  cellOf(x, z) { return [Math.floor(x / CELL), Math.floor(z / CELL)]; }
  center(cx, cz, y = 0) { return new THREE.Vector3((cx + 0.5) * CELL, y, (cz + 0.5) * CELL); }

  // Cells the creature can walk in.
  walkable(cx, cz) {
    const k = this.kindAt(cx, cz);
    return k === K.HALL || k === K.ROOM;
  }

  stairAt(x, z) {
    const [cx, cz] = this.cellOf(x, z);
    if (this.kindAt(cx, cz) !== K.STAIR) return null;
    const room = this.roomOf[this.idx(cx, cz)];
    return this.stairs.find((s) => s.room.id === room) || null;
  }

  stairLocal(s, x, z) {
    const dx = x - s.O.x, dz = z - s.O.z;
    return [dx * s.U.x + dz * s.U.z, dx * s.Wd.x + dz * s.Wd.z];
  }

  // Height of the walkable surface under (x,z), picking the storey nearest
  // below y. Stairwells are periodic with period WALL_H.
  groundAt(x, z, y) {
    const s = this.stairAt(x, z);
    if (!s) return 0;
    const [u, w] = this.stairLocal(s, x, z);
    const half = WALL_H / 2;
    const flen = STAIR.LEN - STAIR.LANDING - STAIR.MID;
    let h0;
    if (u < STAIR.LANDING) h0 = 0;
    else if (u > STAIR.LEN - STAIR.MID) h0 = half;
    else {
      const t = (u - STAIR.LANDING) / flen;
      h0 = w < STAIR.SPLIT ? half * t : WALL_H - half * t;
    }
    const k = Math.floor((y + 0.5 - h0) / WALL_H);
    return h0 + k * WALL_H;
  }

  lineOfSight(ax, az, bx, bz) { return this.wallsBetween(ax, az, bx, bz, true) === 0; }

  // Count wall crossings along a straight line (stops at the first if `any`).
  wallsBetween(ax, az, bx, bz, any = false) {
    const dx = bx - ax, dz = bz - az;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.15));
    let [cx, cz] = this.cellOf(ax, az);
    let px = ax, pz = az;
    let count = 0;
    for (let i = 1; i <= n; i++) {
      const qx = ax + (dx * i) / n, qz = az + (dz * i) / n;
      const [nx, nz] = this.cellOf(qx, qz);
      if (nx !== cx || nz !== cz) {
        if (this.crossBlocked(px, pz, qx, qz, cx, cz, nx, nz)) {
          count++;
          if (any) return count;
        }
        cx = nx; cz = nz;
      }
      px = qx; pz = qz;
    }
    return count;
  }

  crossBlocked(px, pz, qx, qz, cx, cz, nx, nz) {
    if (!this.inBounds(nx, nz) || this.kindAt(nx, nz) === K.VOID) return true;
    const sx = nx - cx, sz = nz - cz;
    const crossV = (fromX, row) => {
      const X = Math.max(fromX, fromX + sx) * CELL;
      const t = (X - px) / ((qx - px) || 1e-9);
      const zc = pz + (qz - pz) * t;
      return edgeBlocks(this.vE[row * (this.W + 1) + Math.max(fromX, fromX + sx)], zc - row * CELL);
    };
    const crossH = (col, fromZ) => {
      const Z = Math.max(fromZ, fromZ + sz) * CELL;
      const t = (Z - pz) / ((qz - pz) || 1e-9);
      const xc = px + (qx - px) * t;
      return edgeBlocks(this.hE[Math.max(fromZ, fromZ + sz) * this.W + col], xc - col * CELL);
    };
    if (sx !== 0 && sz === 0) return crossV(cx, cz);
    if (sz !== 0 && sx === 0) return crossH(cx, cz);
    // diagonal: clear if either L-shaped route is clear
    const r1 = crossV(cx, cz) || this.kindAt(nx, cz) === K.VOID || crossH(nx, cz);
    const r2 = crossH(cx, cz) || this.kindAt(cx, nz) === K.VOID || crossV(cx, nz);
    return r1 && r2;
  }

  // Line of sight for a body of radius r.
  clearPath(a, b, r = 0.35) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = (-dz / len) * r, pz = (dx / len) * r;
    return (
      this.lineOfSight(a.x, a.z, b.x, b.z) &&
      this.lineOfSight(a.x + px, a.z + pz, b.x + px, b.z + pz) &&
      this.lineOfSight(a.x - px, a.z - pz, b.x - px, b.z - pz) &&
      !this.boxOnSegment(a, b, r)
    );
  }

  boxOnSegment(a, b, r) {
    const n = Math.ceil(a.distanceTo(b) / 0.4);
    for (let i = 1; i < n; i++) {
      const x = a.x + ((b.x - a.x) * i) / n, z = a.z + ((b.z - a.z) * i) / n;
      for (const bx of this.boxesNear(x, z)) {
        if (bx.furniture && x > bx.minX - r && x < bx.maxX + r && z > bx.minZ - r && z < bx.maxZ + r) return true;
      }
    }
    return false;
  }

  // BFS over cells. `player` rules include stairwells.
  bfs(sx, sz, stopIdx = -1, player = false) {
    const { W, H } = this;
    const dist = new Float32Array(W * H).fill(Infinity);
    const q = new Int32Array(W * H);
    let head = 0, tail = 0;
    dist[sz * W + sx] = 0;
    q[tail++] = sz * W + sx;
    while (head < tail) {
      const i = q[head++];
      if (i === stopIdx) break;
      const x = i % W, z = (i / W) | 0;
      for (const [dx, dz] of DIRS4) {
        const nx = x + dx, nz = z + dz;
        if (!this.inBounds(nx, nz)) continue;
        const k = this.kindAt(nx, nz);
        if (k === K.VOID || k === K.ELEVATOR || (!player && k === K.STAIR)) continue;
        if (!passable(this.edge(x, z, dx, dz))) continue;
        const j = nz * W + nx;
        if (dist[j] !== Infinity) continue;
        dist[j] = dist[i] + 1;
        q[tail++] = j;
      }
    }
    return dist;
  }

  // How far sound travels through doorways and corridors between two points.
  soundDistance(a, b) {
    const [ax, az] = this.cellOf(a.x, a.z);
    const [bx, bz] = this.cellOf(b.x, b.z);
    if (!this.inBounds(ax, az) || !this.inBounds(bx, bz)) return Infinity;
    const idx = bz * this.W + bx;
    const d = this.bfs(ax, az, idx, true)[idx];
    return Math.max(d * CELL, Math.hypot(a.x - b.x, a.z - b.z));
  }

  nearestWalkable(cx, cz) {
    cx = Math.max(0, Math.min(this.W - 1, cx));
    cz = Math.max(0, Math.min(this.H - 1, cz));
    if (this.walkable(cx, cz)) return [cx, cz];
    if (this.kindAt(cx, cz) === K.STAIR) {
      const st = this.stairs.find((q) => q.room.id === this.roomOf[this.idx(cx, cz)]);
      if (st) return [st.front[0] + st.out[0], st.front[1] + st.out[1]];
    }
    for (let r = 1; r < this.W; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (this.walkable(cx + dx, cz + dz)) return [cx + dx, cz + dz];
        }
      }
    }
    return [this.spawn.x, this.spawn.z];
  }

  randomWalkableNear(cx, cz, radius) {
    for (let t = 0; t < 60; t++) {
      const x = cx + Math.round((Math.random() * 2 - 1) * radius);
      const z = cz + Math.round((Math.random() * 2 - 1) * radius);
      if (this.walkable(x, z) && this.reachable(x, z)) return [x, z];
    }
    return this.nearestWalkable(cx, cz);
  }

  // A* for the creature. Returns world-space waypoints (excluding the start).
  findPath(from, to) {
    const { W, H } = this;
    const [sx, sz] = this.nearestWalkable(...this.cellOf(from.x, from.z));
    const [tx, tz] = this.nearestWalkable(...this.cellOf(to.x, to.z));
    const start = sz * W + sx, goal = tz * W + tx;
    const gScore = new Float32Array(W * H).fill(Infinity);
    const came = new Int32Array(W * H).fill(-1);
    const closed = new Uint8Array(W * H);
    const open = [start];
    gScore[start] = 0;
    const h = (i) => Math.abs((i % W) - tx) + Math.abs(((i / W) | 0) - tz);
    while (open.length) {
      let bi = 0, bf = Infinity;
      for (let k = 0; k < open.length; k++) {
        const f = gScore[open[k]] + h(open[k]);
        if (f < bf) { bf = f; bi = k; }
      }
      const cur = open[bi];
      open.splice(bi, 1);
      if (cur === goal) break;
      closed[cur] = 1;
      const x = cur % W, z = (cur / W) | 0;
      for (const [dx, dz] of DIRS4) {
        const nx = x + dx, nz = z + dz;
        if (!this.walkable(nx, nz) || !passable(this.edge(x, z, dx, dz))) continue;
        const j = nz * W + nx;
        if (closed[j]) continue;
        const gs = gScore[cur] + 1;
        if (gs < gScore[j]) {
          if (gScore[j] === Infinity) open.push(j);
          gScore[j] = gs;
          came[j] = cur;
        }
      }
    }
    if (start !== goal && came[goal] === -1) return [];
    const cells = [];
    for (let c = goal; c !== start && c !== -1; c = came[c]) cells.push(c);
    cells.reverse();
    const pts = cells.map((c) => this.center(c % W, (c / W) | 0));
    const [ex, ez] = this.cellOf(to.x, to.z);
    if (ex === tx && ez === tz && !this.insideFurniture(to.x, to.z, 0.35)) {
      if (pts.length) pts[pts.length - 1] = new THREE.Vector3(to.x, 0, to.z);
      else pts.push(new THREE.Vector3(to.x, 0, to.z));
    }
    return pts;
  }

  // ---------- collision ----------
  addBox(b) {
    const [c0x, c0z] = this.cellOf(b.minX - 0.5, b.minZ - 0.5);
    const [c1x, c1z] = this.cellOf(b.maxX + 0.5, b.maxZ + 0.5);
    for (let z = c0z; z <= c1z; z++) {
      for (let x = c0x; x <= c1x; x++) {
        const key = z * 1000 + x;
        if (!this.boxIndex.has(key)) this.boxIndex.set(key, []);
        this.boxIndex.get(key).push(b);
      }
    }
  }

  boxesNear(x, z) {
    const [cx, cz] = this.cellOf(x, z);
    return this.boxIndex.get(cz * 1000 + cx) || [];
  }

  insideFurniture(x, z, r = 0) {
    for (const b of this.boxesNear(x, z)) {
      if (b.furniture && x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r) return true;
    }
    return false;
  }

  // Walls as thin boxes; doorways leave a gap.
  buildWallBoxes() {
    const { W, H } = this;
    const T = WALL_T / 2 + 0.02;
    const addSeg = (e, horizontal, line, start) => {
      const end = start + CELL;
      const g = gapWidth(e);
      const pieces = g ? [[start - T, start + CELL / 2 - g / 2], [start + CELL / 2 + g / 2, end + T]] : [[start - T, end + T]];
      for (const [a, b] of pieces) {
        if (horizontal) this.addBox({ minX: a, maxX: b, minZ: line - T, maxZ: line + T, wall: true });
        else this.addBox({ minX: line - T, maxX: line + T, minZ: a, maxZ: b, wall: true });
      }
    };
    for (let z = 0; z < H; z++) {
      for (let x = 0; x <= W; x++) {
        const e = this.vE[z * (W + 1) + x];
        if (e === E.OPEN) continue;
        const kl = this.kindAt(x - 1, z), kr = this.kindAt(x, z);
        if (kl === K.VOID && kr === K.VOID) continue;
        addSeg(e, false, x * CELL, z * CELL);
      }
    }
    for (let z = 0; z <= H; z++) {
      for (let x = 0; x < W; x++) {
        const e = this.hE[z * W + x];
        if (e === E.OPEN) continue;
        const ka = this.kindAt(x, z - 1), kb = this.kindAt(x, z);
        if (ka === K.VOID && kb === K.VOID) continue;
        addSeg(e, true, z * CELL, x * CELL);
      }
    }
    // The creature can't follow you onto the stairs: it waits at the door.
    this.entityBarriers = this.stairs.map((s) => {
      const a = this.stairToWorld(s, -0.1, 0), b = this.stairToWorld(s, 0.25, 3);
      return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
    });
    // the wall between the two flights of every stairwell
    for (const s of this.stairs) {
      const a = this.stairToWorld(s, STAIR.LANDING, STAIR.SPLIT - 0.09);
      const b = this.stairToWorld(s, STAIR.LEN - STAIR.MID, STAIR.SPLIT + 0.09);
      this.addBox({ minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z), wall: true });
    }
  }

  stairToWorld(s, u, w, y = 0) {
    return new THREE.Vector3(s.O.x + s.U.x * u + s.Wd.x * w, y, s.O.z + s.U.z * u + s.Wd.z * w);
  }

  collideBarriers(pos, r) {
    for (const b of this.entityBarriers) resolveCircleBox(pos, r, b.minX, b.minZ, b.maxX, b.maxZ);
  }

  // Push a circle out of walls and furniture.
  collide(pos, r) {
    const [cx, cz] = this.cellOf(pos.x, pos.z);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.boxIndex.get((cz + dz) * 1000 + cx + dx);
        if (!list) continue;
        for (const b of list) resolveCircleBox(pos, r, b.minX, b.minZ, b.maxX, b.maxZ);
      }
    }
  }
}

function resolveCircleBox(pos, r, minX, minZ, maxX, maxZ) {
  const qx = Math.max(minX, Math.min(pos.x, maxX));
  const qz = Math.max(minZ, Math.min(pos.z, maxZ));
  const dx = pos.x - qx, dz = pos.z - qz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    pos.x += (dx / d) * (r - d);
    pos.z += (dz / d) * (r - d);
  } else {
    const l = pos.x - minX, rr = maxX - pos.x, t = pos.z - minZ, b = maxZ - pos.z;
    const m = Math.min(l, rr, t, b);
    if (m === l) pos.x = minX - r;
    else if (m === rr) pos.x = maxX + r;
    else if (m === t) pos.z = minZ - r;
    else pos.z = maxZ + r;
  }
}
