import * as THREE from 'three';
import { mulberry32, clamp, lerp, smoothstep } from './util.js';
import { WALL_H } from './level.js';

// All surface textures are generated procedurally at startup: a tileable
// fractal noise field is shaped into albedo, roughness and a height field,
// and the height field is turned into a normal map.

const SIZE = 512;

// Tileable fractal value noise. px/py = lattice cells across the texture for
// the first octave; anisotropic values produce streaks and wood grain.
function fbm(size, { px = 4, py = 4, octaves = 6, persistence = 0.5, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const gx = Math.min(px << o, size);
    const gy = Math.min(py << o, size);
    const g = new Float32Array(gx * gy);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * gy;
      const iy = Math.floor(fy);
      const ty = fy - iy;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (iy % gy) * gx;
      const r1 = ((iy + 1) % gy) * gx;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * gx;
        const ix = Math.floor(fx);
        const tx = fx - ix;
        const sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % gx;
        const x1 = (ix + 1) % gx;
        const a = g[r0 + x0], b = g[r0 + x1], c = g[r1 + x0], d = g[r1 + x1];
        const top = a + (b - a) * sx;
        const bot = c + (d - c) * sx;
        out[y * size + x] += amp * (top + (bot - top) * sy);
      }
    }
    total += amp;
    amp *= persistence;
  }
  // Normalise and stretch contrast (summed value noise clusters around 0.5).
  for (let i = 0; i < out.length; i++) out[i] = clamp((out[i] / total - 0.5) * 1.8 + 0.5, 0, 1);
  return out;
}

function blur(src, size, passes = 1) {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = -1; k <= 1; k++) s += a[y * size + ((x + k + size) % size)];
        b[y * size + x] = s / 3;
      }
    }
    a = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = -1; k <= 1; k++) s += b[((y + k + size) % size) * size + x];
        a[y * size + x] = s / 3;
      }
    }
  }
  return a;
}

// Random-walk crack lines with occasional branches.
function cracks(size, count, seed, length = 200) {
  const rand = mulberry32(seed);
  const m = new Float32Array(size * size);
  const walk = (x, y, a, len, w) => {
    for (let i = 0; i < len; i++) {
      a += (rand() - 0.5) * 0.55;
      x += Math.cos(a);
      y += Math.sin(a);
      const ix = ((Math.floor(x) % size) + size) % size;
      const iy = ((Math.floor(y) % size) + size) % size;
      m[iy * size + ix] = 1;
      if (w > 1.2) m[iy * size + ((ix + 1) % size)] = 1;
      w *= 0.996;
      if (rand() < 0.008 && len > 40) walk(x, y, a + (rand() - 0.5) * 2, len * 0.4, w * 0.7);
    }
  };
  for (let c = 0; c < count; c++) {
    walk(rand() * size, rand() * size, rand() * Math.PI * 2, length * (0.5 + rand()), 1 + rand());
  }
  const b = blur(m, size, 1);
  for (let i = 0; i < b.length; i++) b[i] = Math.min(1, b[i] * 1.8);
  return b;
}

function normalFromHeight(h, size, strength) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      const nx = (l - r) * strength;
      const ny = (u - d) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * size + x) * 4;
      data[i] = (nx * inv * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      data[i + 2] = (inv * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return data;
}

function toTexture(data, size, srgb) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// fn(i, x, y, out) fills out = [r, g, b, roughness, height]
function buildMaps(size, fn, normalStrength) {
  const col = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const o = [0, 0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      fn(i, x, y, o);
      const j = i * 4;
      col[j] = clamp(o[0], 0, 1) * 255;
      col[j + 1] = clamp(o[1], 0, 1) * 255;
      col[j + 2] = clamp(o[2], 0, 1) * 255;
      col[j + 3] = 255;
      const r = clamp(o[3], 0.02, 1) * 255;
      rough[j] = r;
      rough[j + 1] = r;
      rough[j + 2] = r;
      rough[j + 3] = 255;
      h[i] = o[4];
    }
  }
  return {
    map: toTexture(col, size, true),
    roughnessMap: toTexture(rough, size, false),
    normalMap: toTexture(normalFromHeight(h, size, normalStrength), size, false),
  };
}

// Large-scale wear: gentle variation in tone and a faint layer of dust, as a
// colour multiplier. It's sampled in world space over the photo textures so
// their tiling never lines up and no two walls look identical.
function wearTexture(seed) {
  const N = SIZE;
  const tone = fbm(N, { px: 3, py: 3, octaves: 6, seed });
  const dust = fbm(N, { px: 8, py: 8, octaves: 5, seed: seed + 1 });
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const t = 0.95 + (tone[i] - 0.5) * 0.1;
    const d = 1 - smoothstep(0.55, 0.85, dust[i]) * 0.08;
    data[i * 4] = clamp(t * d, 0, 1) * 255;
    data[i * 4 + 1] = clamp(t * d * 0.995, 0, 1) * 255;
    data[i * 4 + 2] = clamp(t * d * 0.985, 0, 1) * 255;
    data[i * 4 + 3] = 255;
  }
  return toTexture(data, N, true);
}

// Apply world-space wear to a material, and fake the soft ambient occlusion
// that gathers where walls meet the floor and the ceiling.
function addWear(mat, wear, strength, wallAO = true) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.grimeMap = { value: wear };
    sh.uniforms.grimeStrength = { value: strength };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGW;\nvarying vec3 vGN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvGN = normalize(mat3(modelMatrix) * normal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D grimeMap;\nuniform float grimeStrength;\nvarying vec3 vGW;\nvarying vec3 vGN;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 gAn = abs(vGN);
        vec2 gUv = gAn.y > 0.5 ? vGW.xz : (gAn.x > gAn.z ? vGW.zy : vGW.xy);
        vec3 gCol = texture2D(grimeMap, gUv / 7.0).rgb * texture2D(grimeMap, gUv / 2.3 + 0.37).rgb;
        diffuseColor.rgb *= mix(vec3(1.0), gCol, grimeStrength);
        ${wallAO ? `if (gAn.y < 0.5) {
          float gY = mod(vGW.y, ${WALL_H.toFixed(2)});
          diffuseColor.rgb *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.5, gY)) - 0.2 * smoothstep(2.25, ${WALL_H.toFixed(2)}, gY);
        }` : ''}`);
  };
  mat.customProgramCacheKey = () => `wear${strength}${wallAO}`;
  return mat;
}

// Woven upholstery. Neutral so the material colour tints it.
function fabricMaps(seed, staining = 0.55) {
  const N = 256;
  const stain = fbm(N, { px: 3, py: 3, octaves: 5, seed });
  const fibre = fbm(N, { px: 64, py: 64, octaves: 2, seed: seed + 1 });
  return buildMaps(N, (i, x, y, o) => {
    const weave = ((x >> 1) + (y >> 1)) % 2 ? 0.92 : 1.0;
    const s = smoothstep(0.55, 0.8, stain[i]) * staining;
    const c = (0.8 + (fibre[i] - 0.5) * 0.2) * weave * (1 - s);
    o[0] = c; o[1] = c * (1 - s * 0.2); o[2] = c * (1 - s * 0.45);
    o[3] = 0.98;
    o[4] = weave * 0.3 + fibre[i] * 0.2;
  }, 3);
}

function woodGrainMaps(seed) {
  const N = 256;
  const grain = fbm(N, { px: 2, py: 32, octaves: 5, seed });
  const dirt = fbm(N, { px: 3, py: 3, octaves: 4, seed: seed + 1 });
  return buildMaps(N, (i, x, y, o) => {
    const d = smoothstep(0.5, 0.9, dirt[i]) * 0.4;
    const c = (0.4 + (grain[i] - 0.5) * 0.28) * (1 - d);
    o[0] = c; o[1] = c * 0.72; o[2] = c * 0.48;
    o[3] = 0.6 + d * 0.3;
    o[4] = grain[i] * 0.3;
  }, 3);
}

// Chipped white gloss paint over wood (trim, cabinets).
// chipAt > 1 means no chips at all; dirt scales the faint grubbiness.
function paintedWoodMaps(seed, chipAt = 0.82, dirt = 0.35) {
  const N = 256;
  const chip = fbm(N, { px: 16, py: 16, octaves: 4, seed });
  const dirtMap = fbm(N, { px: 2, py: 2, octaves: 5, seed: seed + 1 });
  return buildMaps(N, (i, x, y, o) => {
    const ch = smoothstep(chipAt, chipAt + 0.02, chip[i]);
    const d = smoothstep(0.4, 0.9, dirtMap[i]) * dirt;
    let c = ch ? [0.42, 0.3, 0.2] : [0.78, 0.76, 0.7];
    c = c.map((cv) => cv * (1 - d));
    o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
    o[3] = ch ? 0.85 : 0.35 + d * 0.4;
    o[4] = ch ? 0 : 0.3;
  }, 3);
}

function metalMaps(seed) {
  const N = 256;
  const rust = fbm(N, { px: 4, py: 4, octaves: 6, seed });
  const scratch = fbm(N, { px: 128, py: 4, octaves: 2, seed: seed + 1 });
  return buildMaps(N, (i, x, y, o) => {
    const r = smoothstep(0.55, 0.78, rust[i]);
    const base = 0.5 + (scratch[i] - 0.5) * 0.08;
    o[0] = lerp(base, 0.3, r);
    o[1] = lerp(base, 0.15, r);
    o[2] = lerp(base * 1.02, 0.07, r);
    o[3] = lerp(0.4, 0.95, r) + (scratch[i] - 0.5) * 0.15;
    o[4] = r * 0.3 + rust[i] * 0.1;
  }, 4);
}

// The creature's skin: near-black, faintly veined, a little wet.
function skinMaps(seed) {
  const N = 512;
  const a = fbm(N, { px: 8, py: 8, octaves: 7, seed });
  const pores = fbm(N, { px: 128, py: 128, octaves: 2, seed: seed + 2 });
  const veins = cracks(N, 22, seed + 1, 160);
  return buildMaps(N, (i, x, y, o) => {
    const c = 0.075 + (a[i] - 0.5) * 0.05 - veins[i] * 0.028;
    o[0] = c * 1.08; o[1] = c * 0.94; o[2] = c * 0.9;
    o[3] = 0.55 + (a[i] - 0.5) * 0.3 + (pores[i] - 0.5) * 0.2;
    o[4] = a[i] * 0.45 + veins[i] * 0.35 + pores[i] * 0.12;
  }, 7);
}

function fromMaps(maps, extra = {}) {
  return new THREE.MeshStandardMaterial({ ...maps, roughness: 1, metalness: 0, ...extra });
}

// World-space size (metres) one texture repeat covers, per material. The
// world builder uses this to generate UVs.
export const TEX_SCALE = {};

// A: loaded photoscanned assets (see assets.js).
export function makeMaterials(A) {
  const wear = wearTexture(1234);
  const metal = metalMaps(501);
  const fabric = fabricMaps(701, 0.15);
  const linen = fabricMaps(707, 0.05);
  const wood = woodGrainMaps(401);
  const paint = paintedWoodMaps(803, 2, 0.1);
  const photo = (key, wearStrength, extra = {}, wallAO = true) => {
    const s = A.surfaces[key];
    TEX_SCALE[key] = s.size;
    const m = new THREE.MeshStandardMaterial({ ...s.maps, roughness: 1, metalness: 0, ...extra });
    return addWear(m, wear, wearStrength, wallAO);
  };
  return {
    // painted walls, one colour scheme per apartment
    wallpaperA: photo('wallpaperA', 0.6),
    wallpaperB: photo('wallpaperB', 0.6, { color: 0xc6d0c0 }),
    wallpaperC: photo('wallpaperC', 0.6, { color: 0xbfcad4 }),
    kitchenWall: photo('kitchenWall', 0.6, { color: 0xe8e2d6 }),
    hallPaint: photo('hallPaint', 0.6),
    concrete: photo('concrete', 0.6),
    wallTile: photo('wallTile', 0.5),
    carpetHall: photo('carpetHall', 0.4, { color: 0xa47a70 }),
    carpetBed: photo('carpetBed', 0.4),
    laminate: photo('laminate', 0.4),
    floorTile: photo('floorTile', 0.4),
    ceiling: photo('ceiling', 0.4, { color: 0xf2eee6 }, false),
    stairConcrete: photo('stairConcrete', 0.5, {}, false),
    door: fromMaps(paint, { color: 0xe4dfd4 }),
    trim: fromMaps(paint, { color: 0xdedad0 }),
    wood: fromMaps(wood),
    darkWood: fromMaps(wood, { color: 0x6a5040 }),
    fabricA: fromMaps(fabric, { color: 0x5d6b56 }),
    fabricB: fromMaps(fabric, { color: 0x8a6a42 }),
    fabricC: fromMaps(fabric, { color: 0x6e5a62 }),
    mattress: fromMaps(linen, { color: 0xd8d0bc }),
    // dust sheets left over the furniture
    sheet: fromMaps(linen, { color: 0xd6d1c6, side: THREE.DoubleSide }),
    metal: fromMaps(metal, { metalness: 0.8 }),
    darkMetal: fromMaps(metal, { metalness: 0.6, color: 0x55524d }),
    appliance: fromMaps(paint, { color: 0xd8d4ca }),
    ceramic: new THREE.MeshPhysicalMaterial({ color: 0xb4b0a6, roughness: 0.18, clearcoat: 0.5, clearcoatRoughness: 0.2 }),
    black: new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.3 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1418, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.22, envMapIntensity: 3 }),
    plastic: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.55 }),
    skirting: fromMaps(paint, { color: 0xe0dcd2 }),
    hallSkirting: new THREE.MeshStandardMaterial({ color: 0x4a3c30, roughness: 0.6 }),
    // Low specular so the flashlight (coaxial with the eye) doesn't wash it
    // grey; a faint sheen gives it a damp look.
    skin: new THREE.MeshPhysicalMaterial({
      ...skinMaps(601), roughness: 1, metalness: 0, specularIntensity: 0.18, envMapIntensity: 0.15,
      sheen: 0.25, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x3a3634), normalScale: new THREE.Vector2(1.2, 1.2),
    }),
  };
}

// Light cookie for the flashlight: bright hotspot, reflector ring, soft spill.
export function flashlightCookie() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0.0, '#ffffff');
  grd.addColorStop(0.16, '#fbf6ec');
  grd.addColorStop(0.22, '#cfc7b6');
  grd.addColorStop(0.28, '#e8e0d0');
  grd.addColorStop(0.5, '#a49e90');
  grd.addColorStop(0.8, '#4a4640');
  grd.addColorStop(1.0, '#000000');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  // Dust and scratches on the lens.
  const rand = mulberry32(7);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(0,0,0,${0.05 + rand() * 0.08})`;
    g.beginPath();
    g.arc(40 + rand() * 176, 40 + rand() * 176, 2 + rand() * 10, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function textTexture(text, fg, bg, w = 256, h = 96) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = `bold ${Math.floor(h * 0.62)}px Helvetica, Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
