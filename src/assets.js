import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Photoscanned CC0 assets from Poly Haven (see assets/CREDITS.md and
// tools/fetch_assets.py). Real-world sizes are in metres.

export const SURFACES = {
  wallpaperA: { id: 'beige_wall_001', size: 3.0 },
  wallpaperB: { id: 'painted_plaster_wall', size: 2.0 },
  wallpaperC: { id: 'painted_plaster_wall', size: 2.0 },
  kitchenWall: { id: 'plastered_wall_04', size: 3.2 },
  hallPaint: { id: 'beige_wall_002', size: 3.0 },
  concrete: { id: 'painted_concrete_02', size: 4.0 },
  wallTile: { id: 'long_white_tiles', size: 1.27 },
  carpetHall: { id: 'dirty_carpet', size: 0.6 },
  carpetBed: { id: 'herringbone_parquet', size: 3.4 },
  laminate: { id: 'laminate_floor_02', size: 1.7 },
  floorTile: { id: 'floor_tiles_06', size: 3.0 },
  ceiling: { id: 'plastered_wall_04', size: 3.2 },
  stairConcrete: { id: 'concrete_floor_worn_001', size: 3.0 },
};

export const MODELS = [
  'Sofa_01', 'sofa_02', 'sofa_03', 'ArmChair_01', 'modern_arm_chair_01',
  'CoffeeTable_01', 'coffee_table_round_01',
  'Television_01', 'television_02', 'ClassicConsole_01', 'wooden_bookshelf_worn',
  'WoodenTable_01', 'dining_chair_02',
  'ClassicNightstand_01', 'painted_wooden_nightstand', 'modern_wooden_cabinet', 'vintage_cabinet_01',
  'drawer_cabinet',
  'electric_stove', 'vintage_microwave',
  'cardboard_box_01', 'potted_plant_04',
  'hanging_picture_frame_01', 'hanging_picture_frame_02', 'hanging_picture_frame_03',
  'wall_clock', 'alarm_clock_01', 'medical_box',
  'mounted_fluorescent_lights', 'modern_ceiling_lamp_01', 'korean_fire_extinguisher_01',
  'plunger', 'bleach_bottle', 'throw_pillows_01',
];

export async function loadAssets(renderer, onProgress) {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => onProgress(loaded / total);
  const tl = new THREE.TextureLoader(manager);
  const gltf = new GLTFLoader(manager);
  const aniso = renderer.capabilities.getMaxAnisotropy();

  const tex = (url, srgb) => new Promise((resolve, reject) => {
    tl.load(url, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = aniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      resolve(t);
    }, undefined, reject);
  });

  const surfaces = {};
  const byId = {};
  const jobs = [];
  for (const [key, s] of Object.entries(SURFACES)) {
    if (!byId[s.id]) {
      byId[s.id] = {};
      const base = `assets/textures/${s.id}/`;
      jobs.push(tex(base + 'diff.jpg', true).then((t) => { byId[s.id].map = t; }));
      jobs.push(tex(base + 'nor.jpg', false).then((t) => { byId[s.id].normalMap = t; }));
      jobs.push(tex(base + 'rough.jpg', false).then((t) => { byId[s.id].roughnessMap = t; }));
    }
    surfaces[key] = { maps: byId[s.id], size: s.size };
  }

  const models = {};
  for (const name of MODELS) {
    jobs.push(gltf.loadAsync(`assets/models/${name}/${name}.glb`).then((g) => {
      const root = g.scene;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.vertexColors = false; // some scans carry baked masks in COLOR_0
          for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[k]) m[k].anisotropy = aniso;
          if (/glass/i.test(m.name)) { m.transparent = true; m.opacity = 0.25; m.roughness = 0.05; m.depthWrite = false; }
        }
      });
      models[name] = { root, box, size: box.getSize(new THREE.Vector3()) };
    }));
  }

  const hdri = {};
  for (const [key, file] of [['night', 'shanghai_bund'], ['street', 'urban_street_04']]) {
    jobs.push(tex(`assets/hdri/${file}.jpg`, true).then((t) => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      hdri[key] = t;
    }));
  }

  await Promise.all(jobs);
  return { surfaces, models, hdri };
}
