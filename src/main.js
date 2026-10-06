import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { makeMaterials, flashlightCookie } from './textures.js';
import { Level, CELL, WALL_H, K } from './level.js';
import { buildWorld } from './world.js';
import { Entity, STATE } from './entity.js';
import { AudioEngine } from './audio.js';
import { loadAssets } from './assets.js';
import { clamp, lerp, smoothstep, angleDelta } from './util.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const $ = (id) => document.getElementById(id);

const FLARE_BURN = 30; // seconds the creature stays away
const FLARE_RECHARGE = 20; // seconds before the next flare can be lit
const MAX_KITS = 3;

// monster: is there a creature at all. speed: its speed multiplier. tick: how
// far the working clock's ticking carries. hints: stopped clocks tell you
// where the ticking is. wounds: hits you can survive (the next one kills).
const DIFFICULTY = {
  peaceful: {
    label: 'Peaceful', monster: false, speed: 0, flares: 0, glass: 0, tick: 1.8, hints: true, wounds: 0,
    desc: 'Nothing lives here. Just you, the dark, and the ticking.',
  },
  easy: {
    label: 'Easy', monster: true, speed: 0.5, flares: 3, glass: 0, tick: 1.8, hints: true, wounds: 2,
    desc: 'It moves slower than you walk. Loud ticking, stopped clocks point the way, 3 flares, no glass. It takes 3 hits to kill you.',
  },
  medium: {
    label: 'Medium', monster: true, speed: 1, flares: 3, glass: 5, tick: 1, hints: false, wounds: 1,
    desc: 'Normal ticking, no directions, 3 flares, 5 piles of glass. It takes 2 hits to kill you.',
  },
  hard: {
    label: 'Hard', monster: true, speed: 1.1, flares: 0, glass: 10, tick: 0.35, hints: false, wounds: 0,
    desc: 'Faint ticking, no directions, no flares, 10 piles of glass. It is 10% faster, and one hit kills you.',
  },
};
let difficulty = DIFFICULTY[localStorage.getItem('hush-difficulty')] ? localStorage.getItem('hush-difficulty') : 'medium';
let D = DIFFICULTY[difficulty];

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
// Graphics quality: 'high' adds ambient occlusion and a sharper image.
const QUALITY = localStorage.getItem('hush-quality') || 'high';
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY === 'high' ? 1.25 : 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.35;
const EXPOSURE = 1.35;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const FOG = new THREE.Color(0x020203);
scene.background = FOG.clone();
scene.fog = new THREE.FogExp2(FOG.clone(), 0.07);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 600);
camera.rotation.order = 'YXZ';
scene.add(camera);

const hemi = new THREE.HemisphereLight(0x1b1f26, 0x060505, 0.35);
scene.add(hemi);

// ---------- flashlight ----------
const FLASH_POWER = 105;
const flashRig = new THREE.Object3D();
scene.add(flashRig);
const flash = new THREE.SpotLight(0xfff0dc, FLASH_POWER, 30, 0.52, 0.5, 2);
flash.position.set(0.22, -0.24, 0.05);
flash.castShadow = true;
flash.shadow.mapSize.set(2048, 2048);
flash.shadow.camera.near = 0.1;
flash.shadow.camera.far = 30;
flash.shadow.bias = -0.0002;
flash.shadow.normalBias = 0.02;
flash.map = flashlightCookie();
flash.target.position.set(0.05, -0.9, -8);
flashRig.add(flash, flash.target);
const bounce = new THREE.PointLight(0xfff0dc, 0.5, 5, 2);
bounce.position.set(0, 0, -0.6);
flashRig.add(bounce);

// ---------- flare (held in the left hand) ----------
const flareModel = new THREE.Group();
{
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.26, 12), new THREE.MeshStandardMaterial({ color: 0x9a1a14, roughness: 0.6 }));
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.04, 12), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 }));
  cap.position.y = -0.13;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.017, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.2, 0.6) }));
  tip.position.y = 0.14;
  flareModel.add(stick, cap, tip);
  flareModel.userData.tip = tip;
}
flareModel.position.set(-0.26, -0.24, -0.45);
flareModel.rotation.set(-0.6, 0, 0.25);
flareModel.visible = false;
camera.add(flareModel);
const flareLight = new THREE.PointLight(0xff3a1c, 0, 16, 2);
scene.add(flareLight);
// The cold light that pours out of the creature as reality tears (ending).
const tearLight = new THREE.PointLight(0xd6e4ff, 0, 9, 2);
scene.add(tearLight);
// sparks
const SPARKS = 160;
const sparkPos = new Float32Array(SPARKS * 3);
const sparkVel = new Float32Array(SPARKS * 3);
const sparkLife = new Float32Array(SPARKS);
const sparkGeo = new THREE.BufferGeometry();
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
  color: new THREE.Color(4, 1.6, 0.6), size: 0.025, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}));
sparks.frustumCulled = false;
scene.add(sparks);

// Dust hanging in the air. Each mote only shows when it drifts inside the
// flashlight cone, which is what makes the beam look volumetric.
const DUST = 2200;
const DUST_R = 6;
const dustGeo = new THREE.BufferGeometry();
{
  const p = new Float32Array(DUST * 3);
  const seed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    p[i * 3] = (Math.random() - 0.5) * 2 * DUST_R;
    p[i * 3 + 1] = Math.random() * 2.8;
    p[i * 3 + 2] = (Math.random() - 0.5) * 2 * DUST_R;
    seed[i] = Math.random();
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  dustGeo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
}
const dustMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    time: { value: 0 },
    centre: { value: new THREE.Vector3() },
    lightPos: { value: new THREE.Vector3() },
    lightDir: { value: new THREE.Vector3(0, 0, -1) },
    power: { value: 1 },
    pixelRatio: { value: 1 },
  },
  vertexShader: /* glsl */ `
    uniform float time, power, pixelRatio;
    uniform vec3 centre, lightPos, lightDir;
    attribute float seed;
    varying float vA;
    void main() {
      vec3 p = position;
      p += vec3(sin(time * 0.13 + seed * 40.0), sin(time * 0.07 + seed * 17.0) * 0.6, cos(time * 0.11 + seed * 29.0)) * 0.35;
      // wrap the cloud around the camera so it is endless
      p = centre + mod(p - centre + ${DUST_R.toFixed(1)}, ${(DUST_R * 2).toFixed(1)}) - ${DUST_R.toFixed(1)};
      p.y = mod(position.y + sin(time * 0.05 + seed * 9.0) * 0.4, 2.8) + floor(centre.y / 2.8) * 2.8;
      vec3 toP = p - lightPos;
      float d = length(toP);
      float cone = smoothstep(0.86, 0.97, dot(toP / d, lightDir));
      vA = cone * power * (0.15 + seed * 0.85) * 0.35 / (1.0 + d * d * 0.35) * smoothstep(0.3, 0.9, d);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = (0.8 + seed * 1.2) * pixelRatio * (2.2 / -mv.z);
    }
  `,
  fragmentShader: /* glsl */ `
    varying float vA;
    void main() {
      float r = length(gl_PointCoord - 0.5);
      if (r > 0.5) discard;
      gl_FragColor = vec4(vec3(1.0, 0.95, 0.86) * vA * (1.0 - r * 2.0) * 0.9, 1.0);
    }
  `,
});
const dust = new THREE.Points(dustGeo, dustMat);
dust.frustumCulled = false;
scene.add(dust);

// Pool of shadow-casting lights, assigned each frame to the nearest fixtures.
const POOL = 3;
const pool = [];
for (let i = 0; i < POOL; i++) {
  const l = new THREE.PointLight(0xffffff, 0, 9, 2);
  l.castShadow = true;
  l.shadow.mapSize.set(QUALITY === 'high' ? 512 : 256, QUALITY === 'high' ? 512 : 256);
  l.shadow.camera.near = 0.1;
  l.shadow.camera.far = 10;
  l.shadow.bias = -0.002;
  // Re-rendering six shadow faces per light per frame is the costliest thing
  // in the game, so lamp shadows refresh round-robin (see updateLights).
  l.shadow.autoUpdate = false;
  scene.add(l);
  pool.push(l);
}

// ---------- post-processing ----------
// Multisampled HDR target: proper anti-aliasing under the post effects.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
  type: THREE.HalfFloatType, samples: QUALITY === 'high' ? 4 : 2,
}));
composer.addPass(new RenderPass(scene, camera));
// Ambient occlusion: contact shadows in corners, under furniture, behind doors.
let gtao = null;
if (QUALITY === 'high') {
  gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 1;
  gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.5, scale: 1.2, samples: 12 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  composer.addPass(gtao);
}
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.5, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const fx = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    fear: { value: 0 },
    hurt: { value: 0 },
    wound: { value: 0 },
    freeze: { value: 0 },
    grain: { value: 1 },
    aspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time, fear, hurt, wound, freeze, grain, aspect;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float d = length(c * vec2(aspect, 1.0)) / aspect * 1.4;
      float shake = fear * fear * 0.002;
      uv += vec2(hash(vec2(time, 1.0)) - 0.5, hash(vec2(time, 2.0)) - 0.5) * shake;
      float ab = 0.0004 + fear * 0.005 + hurt * 0.02 + wound * 0.002;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;
      float n = hash(uv * vec2(1920.0, 1080.0) + fract(time * 7.13) * 100.0);
      col += (n - 0.5) * (0.028 + fear * 0.04) * grain;
      float vig = smoothstep(0.95, 0.2 - fear * 0.15 - wound * 0.1, d);
      col *= mix(mix(0.4, 0.8, 1.0 - grain), 1.0, vig);
      // wounded: the world drains of colour
      float grey = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(grey), wound * 0.35);
      col = mix(col, col * vec3(1.35, 0.55, 0.5), clamp(fear * 0.35 * (1.0 - vig) + hurt * 0.7 + wound * 0.25 * (1.0 - vig), 0.0, 1.0));
      // time stopped: cold, colourless, the edges closing in
      float fg = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(fg) * vec3(0.82, 0.92, 1.12), freeze * 0.9);
      col *= mix(1.0, smoothstep(1.05, 0.35, d), freeze * 0.6);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
composer.addPass(fx);

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  fx.uniforms.aspect.value = w / h;
}
window.addEventListener('resize', onResize);
onResize();

// ---------- game state ----------
const audio = new AudioEngine();
let M = null;
let level, world, entity;
let state = 'loading'; // loading | menu | playing | paused | dying | dead | ending | won
let elapsed = 0;
let deathT = 0;
let messageTimer = 0;
let loops = 0;
let lightningT = 15;
let lightning = 0;
const keys = {};

const player = {
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  vy: 0,
  grounded: true,
  yaw: 0,
  pitch: 0,
  eye: 1.62,
  crouch: false,
  sprinting: false,
  exhausted: false,
  stamina: 1,
  bobT: 0,
  bobAmp: 0,
  roll: 0,
  noise: 0,
  mic: 0,
  flashlight: true,
  wounds: 0,
  kits: 0,
  flares: 0,
  flareBurn: 0,
  flareCooldown: 0,
  painT: 0,
  shake: 0,
};

function showMessage(text, seconds = 3) {
  const el = $('message');
  el.textContent = text;
  el.classList.add('show');
  messageTimer = seconds;
}

let A = null; // loaded assets
let env = null; // PMREM environments built from the photographed skies
let crushPivot = null;
let ending = null;

// The rainy city at night: visible through the windows, and the source of
// the faint reflections on glass, tile and water.
const NIGHT_BG = 0.3;
const NIGHT_ENV = 0.12;
function setNight() {
  scene.background = A.hdri.night;
  scene.backgroundIntensity = NIGHT_BG;
  scene.backgroundRotation.set(0, 0, 0);
  scene.environment = env.night;
  scene.environmentIntensity = NIGHT_ENV;
}

function newGame() {
  if (heldClock) { camera.remove(heldClock.group); heldClock = null; }
  clockGlow.intensity = 0;
  fx.uniforms.freeze.value = 0;
  if (world) {
    (world.group.parent || scene).remove(world.group);
    world.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
  if (crushPivot) { scene.remove(crushPivot); crushPivot = null; }
  ending = null;
  tearLight.intensity = 0;
  setNight();
  scene.fog.color.copy(FOG);
  scene.fog.density = 0.07;
  hemi.color.setHex(0x1b1f26);
  hemi.groundColor.setHex(0x060505);
  hemi.intensity = 0.35;
  renderer.toneMappingExposure = EXPOSURE;
  fx.uniforms.grain.value = 1;
  audio.resetAfterEnding();

  const seed = (params.get('seed') | 0) || Math.floor(Math.random() * 1e9);
  level = new Level(seed);
  world = buildWorld(level, M, A);
  scene.add(world.group);
  if (!entity) entity = new Entity(scene, audio, M);
  entity.reset(level, level.center(level.spawn.x, level.spawn.z));

  const s = level.center(level.start.x, level.start.z);
  Object.assign(player, {
    yaw: level.start.face, pitch: 0, vy: 0, grounded: true, stamina: 1, exhausted: false, noise: 0,
    flashlight: true, wounds: 0, kits: 0, flareBurn: 0, flareCooldown: 0, painT: 0, shake: 0,
  });
  player.pos.set(s.x, 0, s.z);
  player.vel.set(0, 0, 0);
  elapsed = 0;
  deathT = 0;
  loops = 0;
  lightningT = 12 + Math.random() * 10;
  flareModel.visible = false;
  flareLight.intensity = 0;
  $('flash').style.opacity = 0;
  $('flash').style.background = '#600';
  fx.uniforms.hurt.value = 0;
  camera.fov = 72;
  camera.updateProjectionMatrix();
  applyDifficulty();
}

// Set up the current run for the chosen difficulty. Cheap, so the menu can
// call it whenever the choice changes.
function applyDifficulty() {
  D = DIFFICULTY[difficulty];
  entity.speedMul = D.speed;
  if (!D.monster) {
    entity.root.visible = false;
    entity.root.position.set(1e4, 0, 1e4);
    entity.dist = 99;
    entity.state = STATE.WANDER;
  } else if (!entity.root.visible) {
    entity.reset(level, level.center(level.spawn.x, level.spawn.z));
  }
  world.setGlass(D.glass);
  // med kits only matter if you can survive a hit
  for (const m of world.medkits) {
    m.taken = D.wounds === 0;
    m.group.visible = !m.taken;
  }
  player.flares = D.flares;
  $('healthRow').classList.toggle('hidden', !D.monster);
  $('flareRow').classList.toggle('hidden', D.flares === 0);
  $('kitRow').classList.toggle('hidden', D.wounds === 0);
  for (const b of document.querySelectorAll('.difficulty button')) b.classList.toggle('on', b.dataset.d === difficulty);
  $('difficultyDesc').textContent = D.desc;
  updateHUDStatic();
}

// ---------- input ----------
const SENS = 0.0022;
document.addEventListener('mousemove', (e) => {
  const look = state === 'playing' || (state === 'ending' && ending && ending.phase === 'city');
  if (!look || document.pointerLockElement !== renderer.domElement) return;
  player.yaw -= e.movementX * SENS;
  player.pitch = clamp(player.pitch - e.movementY * SENS, -1.45, 1.45);
});

document.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (state !== 'playing' || e.repeat) return;
  if (e.code === 'KeyF') {
    player.flashlight = !player.flashlight;
    audio.click();
    spike(0.06);
  }
  if (e.code === 'KeyE') interact();
  if (e.code === 'KeyQ') lightFlare();
  if (e.code === 'KeyH') useKit();
  if (e.code === 'Space' && player.grounded && !player.crouch) {
    player.vy = 4.1;
    player.grounded = false;
  }
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

function lockPointer() {
  const p = renderer.domElement.requestPointerLock();
  if (p && p.catch) p.catch(() => {});
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (locked && (state === 'menu' || state === 'paused')) {
    state = 'playing';
    showScreen(null);
  } else if (!locked && state === 'playing') {
    state = 'paused';
    showScreen('pause');
  }
});

function backToMenu() {
  newGame();
  state = 'menu';
  showScreen('menu');
}

function showScreen(id) {
  for (const s of ['menu', 'pause', 'dead', 'win']) $(s).classList.toggle('hidden', s !== id);
  $('hud').classList.toggle('hidden', !(id === null || id === 'pause') || state === 'ending');
}

$('startBtn').addEventListener('click', () => {
  audio.init();
  lockPointer();
  showMessage('Find the clock that still works. Stay quiet.', 5);
});
$('pause').addEventListener('click', () => { audio.init(); lockPointer(); });
for (const b of document.querySelectorAll('.quality button')) {
  b.classList.toggle('on', b.dataset.q === QUALITY);
  b.addEventListener('click', () => {
    if (b.dataset.q === QUALITY) return;
    localStorage.setItem('hush-quality', b.dataset.q);
    location.reload();
  });
}
for (const b of document.querySelectorAll('.difficulty button')) {
  b.addEventListener('click', () => {
    if (state !== 'menu') return;
    difficulty = b.dataset.d;
    localStorage.setItem('hush-difficulty', difficulty);
    applyDifficulty();
  });
}
for (const id of ['deadMenuBtn', 'winMenuBtn']) {
  $(id).addEventListener('click', (e) => { e.stopPropagation(); backToMenu(); });
}
for (const id of ['retryBtn', 'againBtn']) {
  $(id).addEventListener('click', (e) => {
    e.stopPropagation();
    newGame();
    // If the browser refuses the lock (cooldown after Esc), the pause screen
    // lets the player click once more to enter.
    state = 'paused';
    showScreen('pause');
    lockPointer();
    showMessage('Find the clock that still works. Stay quiet.', 5);
  });
}
$('micBtn').addEventListener('click', async () => {
  try {
    await audio.enableMic();
    $('micBtn').textContent = 'Microphone on';
    $('micBtn').disabled = true;
    $('micStatus').innerHTML = 'Listening. Try whispering, then talking. <b>It will hear you.</b>';
    $('menuMicMeter').classList.remove('hidden');
    $('micRow').classList.remove('hidden');
  } catch (err) {
    $('micStatus').textContent = 'Microphone unavailable (' + err.message + '). The game still works without it.';
  }
});

// ---------- player ----------
function spike(v) { player.noise = Math.max(player.noise, v); }

function inGlass(x, z) {
  if (Math.abs(player.pos.y) > 0.3) return false;
  for (const g of world.glassSpots) if (Math.hypot(x - g.x, z - g.z) < g.r) return true;
  return false;
}

// Carpet muffles footsteps; tile, laminate and concrete stairs carry them.
function surfaceLoudness() {
  const [cx, cz] = level.cellOf(player.pos.x, player.pos.z);
  const k = level.kindAt(cx, cz);
  if (k === K.HALL) return 0.8;
  if (k === K.STAIR) return 1.2;
  const r = level.roomAt(cx, cz);
  if (r && r.type === 'bed') return 0.8;
  return 1.1;
}

function updatePlayer(dt) {
  const k = keys;
  const fwd = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
  const str = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
  const moving = fwd !== 0 || str !== 0;
  player.crouch = !!k.KeyC;
  const hurt = player.wounds > 0;

  const wantSprint = (k.ShiftLeft || k.ShiftRight) && fwd > 0 && !player.crouch;
  player.sprinting = wantSprint && !player.exhausted && player.grounded;
  if (player.sprinting) {
    player.stamina = Math.max(0, player.stamina - dt / 6);
    if (player.stamina <= 0) player.exhausted = true;
  } else {
    player.stamina = Math.min(1, player.stamina + dt / (moving ? 11 : 7));
    if (player.exhausted && player.stamina > 0.35) player.exhausted = false;
  }

  // Wounded: 10% slower.
  const speed = (player.crouch ? 1.35 : player.sprinting ? 5.3 : 2.7) * (hurt ? 0.9 : 1);
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  let mx = -sy * fwd + cy * str;
  let mz = -cy * fwd - sy * str;
  const ml = Math.hypot(mx, mz);
  if (ml > 0) { mx = (mx / ml) * speed; mz = (mz / ml) * speed; }
  // the limp: the bad leg can't push off as hard
  if (hurt && ml > 0) {
    const bad = Math.floor(player.bobT / Math.PI) % 2 === 1;
    const f = bad ? 0.78 : 1.2; // averages to 1 over a stride, so the net slow-down stays 10%
    mx *= f;
    mz *= f;
  }
  const accel = player.grounded ? 10 : 1.5;
  const a = 1 - Math.exp(-accel * dt);
  player.vel.x = lerp(player.vel.x, mx, a);
  player.vel.z = lerp(player.vel.z, mz, a);
  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  level.collide(player.pos, 0.3);

  // vertical: follow floors and stairs
  const ground = level.groundAt(player.pos.x, player.pos.z, player.pos.y);
  if (player.grounded) {
    if (ground < player.pos.y - 0.45) player.grounded = false;
    else player.pos.y = lerp(player.pos.y, ground, Math.min(1, dt * 18));
  }
  if (!player.grounded) {
    player.vy -= 12 * dt;
    player.pos.y += player.vy * dt;
    if (player.pos.y <= ground) {
      const impact = clamp(-player.vy / 5, 0.4, 1);
      player.pos.y = ground;
      player.vy = 0;
      player.grounded = true;
      audio.land(impact);
      spike(0.75 * impact * surfaceLoudness());
      if (inGlass(player.pos.x, player.pos.z)) { audio.glass(1); spike(1); }
      player.bobAmp = 0.06;
      if (hurt) { audio.pain(); player.shake = 0.4; }
    }
  }

  // The stairs loop: a full storey up or down puts you back on this floor.
  if (player.pos.y > WALL_H - 0.35 || player.pos.y < -(WALL_H - 0.35)) {
    const shift = player.pos.y > 0 ? -WALL_H : WALL_H;
    player.pos.y += shift;
    loops++;
    const lines = ['Floor 4.', 'Floor 4... again?', 'There is no other floor.', 'Floor 4.', 'It is always floor 4.'];
    showMessage(lines[Math.min(loops - 1, lines.length - 1)], 3);
  }

  player.eye = lerp(player.eye, player.crouch ? 1.0 : 1.62, Math.min(1, dt * 8));

  // head bob & footsteps
  const hs = Math.hypot(player.vel.x, player.vel.z);
  const stride = player.crouch ? 0.55 : player.sprinting ? 1.05 : 0.78;
  let cont = 0;
  if (player.grounded && hs > 0.3) {
    const prev = Math.floor(player.bobT / Math.PI);
    const bad = hurt && prev % 2 === 1;
    // uneven rhythm: a quick hop onto the bad leg, a long step off it
    const rhythm = hurt ? (bad ? 1.4 : 0.8) : 1;
    player.bobT += (hs / stride) * Math.PI * dt * rhythm;
    const now = Math.floor(player.bobT / Math.PI);
    if (now !== prev) footstep(hurt && now % 2 === 1);
    cont = (player.crouch ? 0.05 : player.sprinting ? 0.68 : 0.24) * surfaceLoudness();
  }
  const targetAmp = player.grounded ? clamp(hs / 2.7, 0, 1.6) * (player.crouch ? 0.02 : 0.035) : 0;
  player.bobAmp = lerp(player.bobAmp, targetAmp, Math.min(1, dt * 6));
  player.roll = lerp(player.roll, -str * 0.012 * (hs / 2.7), Math.min(1, dt * 5));

  // pained breathing / groans while hurt and exerting
  if (hurt) {
    player.painT -= dt;
    if (player.painT <= 0) {
      player.painT = player.sprinting ? 2 + Math.random() * 2 : 7 + Math.random() * 8;
      audio.pain();
      spike(0.2);
    }
  }

  player.noise = Math.max(player.noise - dt * 0.7, cont);
  player.mic = audio.readMic(dt);
  if (player.mic > 0.05) spike(player.mic);
}

function footstep(badLeg) {
  const glass = inGlass(player.pos.x, player.pos.z);
  const surf = surfaceLoudness();
  if (glass) {
    audio.glass(player.crouch ? 0.45 : 1);
    spike(player.crouch ? 0.5 : 1);
    if (!player.crouch && Math.random() < 0.5) showMessage('Broken glass...', 1.5);
  }
  const v = (player.crouch ? 0.25 : player.sprinting ? 1 : 0.55) * surf;
  audio.footstep(v);
  if (badLeg) audio.limpScuff();
  spike((player.crouch ? 0.1 : player.sprinting ? 0.85 : 0.36) * surf);
}

function updateCamera(dt, time) {
  const hurt = player.wounds > 0;
  const bad = hurt && Math.floor(player.bobT / Math.PI) % 2 === 1;
  const dip = Math.abs(Math.sin(player.bobT));
  const bobY = -dip * player.bobAmp * (bad ? 2.4 : 1);
  const bobX = Math.cos(player.bobT) * player.bobAmp * 0.6;
  const limpRoll = bad ? dip * player.bobAmp * 1.6 : 0;
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  const breath = Math.sin(time * (1.3 + (1 - player.stamina) * 2)) * (0.004 + (1 - player.stamina) * 0.01);
  player.shake = Math.max(0, player.shake - dt * 1.5);
  const sh = player.shake * player.shake;
  camera.position.set(
    player.pos.x + cy * bobX + (Math.random() - 0.5) * sh * 0.08,
    player.pos.y + player.eye + bobY + breath + (Math.random() - 0.5) * sh * 0.08,
    player.pos.z - sy * bobX,
  );
  camera.rotation.set(player.pitch + breath * 0.3, player.yaw, player.roll + bobX * 0.15 + limpRoll);
}

// ---------- flare ----------
function lightFlare() {
  if (player.flareBurn > 0) return;
  if (player.flares <= 0) { showMessage(D.flares ? 'No flares left.' : 'You don\'t have any flares.', 2); return; }
  if (player.flareCooldown > 0) { showMessage(`Next flare ready in ${Math.ceil(player.flareCooldown)}s`, 2); return; }
  player.flares--;
  player.flareBurn = FLARE_BURN;
  flareModel.visible = true;
  audio.flareIgnite();
  entity.scare(player.pos, FLARE_BURN);
  showMessage('It hates the light. Move.', 3);
  updateHUDStatic();
}

const _tipPos = new THREE.Vector3();
function updateFlare(dt, time) {
  if (player.flareBurn > 0) {
    player.flareBurn -= dt;
    if (Math.random() < dt * 12) audio.flareCrackle();
    flareModel.userData.tip.getWorldPosition(_tipPos);
    flareLight.position.copy(_tipPos);
    flareLight.intensity = 6.5 * clamp(adapt * 1.4, 0.35, 1) * (0.75 + Math.random() * 0.25 + Math.sin(time * 37) * 0.08);
    emitSparks(_tipPos, 6, 1.6);
    if (player.flareBurn <= 0) {
      player.flareBurn = 0;
      player.flareCooldown = player.flares > 0 ? FLARE_RECHARGE : 0;
      flareModel.visible = false;
      flareLight.intensity = 0;
      audio.flareOut();
      showMessage(player.flares > 0 ? 'The flare burned out.' : 'The last flare burned out.', 2.5);
    }
  } else if (player.flareCooldown > 0) {
    player.flareCooldown = Math.max(0, player.flareCooldown - dt);
    if (player.flareCooldown === 0 && player.flares > 0) showMessage('Flare ready [Q]', 2);
  }
}

function emitSparks(p, n, speed) {
  for (let k = 0; k < n; k++) {
    const i = Math.floor(Math.random() * SPARKS);
    if (sparkLife[i] > 0) continue;
    sparkLife[i] = 0.4 + Math.random() * 0.7;
    sparkPos[i * 3] = p.x; sparkPos[i * 3 + 1] = p.y; sparkPos[i * 3 + 2] = p.z;
    sparkVel[i * 3] = (Math.random() - 0.5) * speed;
    sparkVel[i * 3 + 1] = Math.random() * speed;
    sparkVel[i * 3 + 2] = (Math.random() - 0.5) * speed;
  }
}

function updateSparks(dt) {
  for (let i = 0; i < SPARKS; i++) {
    if (sparkLife[i] <= 0) { sparkPos[i * 3 + 1] = -100; continue; }
    sparkLife[i] -= dt;
    sparkVel[i * 3 + 1] -= 6 * dt;
    sparkPos[i * 3] += sparkVel[i * 3] * dt;
    sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt;
    sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
    if (sparkPos[i * 3 + 1] < player.pos.y) { sparkPos[i * 3 + 1] = player.pos.y; sparkVel[i * 3 + 1] *= -0.3; }
  }
  sparkGeo.attributes.position.needsUpdate = true;
}

// ---------- wounds & med kits ----------
function takeHit() {
  if (player.wounds >= D.wounds) { die(); return; }
  player.wounds++;
  audio.hurt();
  player.shake = 1;
  fx.uniforms.hurt.value = 1;
  $('flash').style.transition = 'none';
  $('flash').style.opacity = 0.7;
  requestAnimationFrame(() => { $('flash').style.transition = 'opacity 1.2s'; $('flash').style.opacity = 0; });
  entity.retreat(player.pos);
  showMessage(player.wounds >= D.wounds ? 'Badly hurt. One more and it is over.' : 'You are hurt. Find a med kit.', 3.5);
  updateHUDStatic();
}

function heal() {
  player.wounds = Math.max(0, player.wounds - 1);
  audio.heal();
  showMessage(player.wounds ? 'Wound dressed. Still bleeding.' : 'Wounds dressed.', 2.5);
  updateHUDStatic();
}

function useKit() {
  if (player.kits <= 0) { showMessage('No med kits.', 1.5); return; }
  if (player.wounds <= 0) { showMessage('You are not hurt.', 1.5); return; }
  player.kits--;
  heal();
}

// ---------- interaction ----------
let promptTarget = null;
const _look = new THREE.Vector3();

function updateInteract() {
  promptTarget = null;
  camera.getWorldDirection(_look);
  let text = '';
  let best = Infinity;
  const consider = (obj, pos, range, label) => {
    const dx = pos.x - camera.position.x, dz = pos.z - camera.position.z;
    const d = Math.hypot(dx, dz);
    if (d > range || Math.abs(pos.y - camera.position.y) > 1.8) return;
    const toward = (dx * _look.x + dz * _look.z) / (d || 1);
    if (toward < 0.35 && d > 0.7) return;
    const score = d - toward;
    if (score < best) { best = score; promptTarget = obj; text = label; }
  };
  for (const c of world.clocks) if (!c.taken) consider(c, c.group.getWorldPosition(new THREE.Vector3()), 1.9, '[E] Check the clock');
  for (const m of world.medkits) if (!m.taken) consider(m, m.group.position, 1.7, '[E] Take med kit');
  $('prompt').textContent = text;
}

// Where is the ticking coming from, relative to where you're facing?
function tickingHint() {
  const w = world.clocks.find((c) => c.working && !c.taken);
  if (!w) return '';
  const p = w.group.getWorldPosition(new THREE.Vector3());
  const d = level.soundDistance(camera.position, p);
  const far = d < 12 ? 'close' : d < 30 ? 'not far' : 'far off';
  const dx = p.x - player.pos.x, dz = p.z - player.pos.z;
  // angle of the clock relative to the view: 0 ahead, positive to the right
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const ang = Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz);
  const side = Math.abs(ang) < Math.PI / 4 ? 'ahead of you' : Math.abs(ang) > (3 * Math.PI) / 4 ? 'behind you' : ang > 0 ? 'off to your right' : 'off to your left';
  return `Ticking, somewhere ${far} — ${side}.`;
}

function interact() {
  const t = promptTarget;
  if (!t) return;
  if (world.clocks.includes(t)) {
    if (t.working) { startEnding(t); return; }
    audio.clockClunk();
    spike(0.25);
    const lines = ['Stopped.', 'This one is dead.', 'Not ticking.', 'The hands don\'t move.'];
    const line = lines[Math.floor(Math.random() * lines.length)];
    showMessage(D.hints ? `${line} ${tickingHint()}` : line, D.hints ? 3.5 : 2);
    return;
  }
  if (world.medkits.includes(t)) {
    t.taken = true;
    t.group.visible = false;
    audio.pickup();
    spike(0.12);
    if (player.wounds > 0) heal();
    else if (player.kits < MAX_KITS) {
      player.kits++;
      showMessage('Med kit. [H] to use when hurt.', 2.5);
    } else showMessage('You can\'t carry more.', 2);
    updateHUDStatic();
  }
}

// ---------- the working clock ----------
let lastSecond = -1;
function updateClocks() {
  const now = new Date();
  const s = now.getSeconds();
  for (const c of world.clocks) {
    if (!c.working || c.taken) continue;
    c.setTime(now.getHours(), now.getMinutes(), s);
    if (s !== lastSecond && state === 'playing') {
      const p = c.group.getWorldPosition(new THREE.Vector3());
      const walls = level.wallsBetween(camera.position.x, camera.position.z, p.x, p.z);
      audio.tick(p, s % 2 === 1, Math.min(1, walls * 0.25), D.tick);
      // the first time it's within earshot, say so
      if (!c.heard && level.soundDistance(camera.position, p) < 16 * Math.min(1, D.tick)) {
        c.heard = true;
        showMessage('You can hear a clock ticking nearby…', 3.5);
      }
    }
  }
  lastSecond = s;
}

// ---------- stair doors ----------
function updateStairDoors(dt) {
  for (const d of world.stairDoors) {
    const nearPlayer = Math.hypot(player.pos.x - d.centre.x, player.pos.z - d.centre.z) < 1.9 && Math.abs(player.pos.y) < 1;
    const nearEntity = Math.hypot(entity.pos.x - d.centre.x, entity.pos.z - d.centre.z) < 2.2;
    const target = nearPlayer || nearEntity ? 1 : 0;
    if (target !== d.target) {
      d.target = target;
      audio.doorCreak(d.centre);
      if (target && nearPlayer) spike(0.3);
    }
    d.open = lerp(d.open, target, Math.min(1, dt * (target ? 5 : 2.5)));
    d.pivot.rotation.y = d.base + d.sign * d.open * 1.5;
  }
}

// ---------- lights ----------
const _sorted = [];
const _glow = new THREE.Color();
let shadowTurn = 0;
function updateLights(dt) {
  const fixtures = world.fixtures;
  const ePos = entity.pos;
  // grab: the lights surge. stop: they hold. fold: they strobe, then die.
  const ph = ending ? ending.phase : null;
  const surge = ph === 'grab' ? smoothstep(0.2, 1.0, ending.pt) : ph === 'charge' ? 1 : 0;
  const strobe = ph === 'fold';
  const held = ph === 'stop';
  for (const f of fixtures) {
    if (held) continue;
    f.timer -= dt;
    if (f.mode === 'flicker' && f.timer <= 0) {
      f.on = !f.on;
      f.timer = f.on ? 0.3 + Math.random() * 4 : 0.03 + Math.random() * 0.15;
    } else if (f.mode === 'dying' && f.timer <= 0) {
      f.on = !f.on;
      f.timer = f.on ? 0.04 + Math.random() * 0.4 : 0.8 + Math.random() * 4;
    }
    let lvl = f.mode === 'broken' ? 0 : f.on ? 1 : 0.02;
    // Lights go haywire when it is close.
    const ed = Math.hypot(f.pos.x - ePos.x, f.pos.z - ePos.z, (f.pos.y - 1.5) * 1.5);
    if (ed < 6.5 && lvl > 0) {
      if (Math.random() < (1 - ed / 6.5) * 0.6) lvl *= Math.random() * 0.3;
    }
    if (surge > 0 && f.mode !== 'broken') lvl = (1 + surge * 0.8) * (Math.random() < surge * 0.06 ? 0.15 : 1);
    if (strobe && f.mode !== 'broken') lvl = Math.random() < 0.5 ? 1.6 : 0;
    f.level = lerp(f.level, lvl, Math.min(1, dt * 40));
    if (f.glow && f.glow.mesh) {
      _glow.copy(f.glow.color).multiplyScalar(f.level);
      f.glow.mesh.setColorAt(f.glow.index, _glow);
      f.glow.mesh.instanceColor.needsUpdate = true;
    }
  }
  _sorted.length = 0;
  for (const f of fixtures) {
    if (f.mode === 'broken') continue;
    f.d = f.pos.distanceTo(camera.position);
    _sorted.push(f);
  }
  _sorted.sort((a, b) => a.d - b.d);
  const fadeAll = ph === 'fold' ? 1 - smoothstep(0.2, 1.4, ending.pt) : ph === 'city' ? 0 : 1;
  shadowTurn = (shadowTurn + 1) % POOL;
  for (let i = 0; i < POOL; i++) {
    const l = pool[i];
    const f = _sorted[i];
    if (!f) { l.intensity = 0; continue; }
    // refresh this light's shadows if it moved to another fixture, or on its turn
    if (!l.position.equals(f.pos) || i === shadowTurn) l.shadow.needsUpdate = true;
    l.position.copy(f.pos);
    l.color.copy(f.color);
    l.intensity = f.power * f.level * (1 - smoothstep(12, 18, f.d)) * fadeAll;
  }
}

// How far away is whatever the player is looking at? Used as a cheap stand-in
// for eye adaptation: a flashlight inches from a white tile wall shouldn't
// blind you the way it would with real, unadapted exposure.
const _dir = new THREE.Vector3();
let adapt = 1;
function viewDistance() {
  camera.getWorldDirection(_dir);
  const eye = camera.position;
  let d = 8;
  const floorY = level.groundAt(eye.x, eye.z, player.pos.y);
  if (_dir.y < -0.01) d = Math.min(d, (eye.y - floorY) / -_dir.y);
  if (_dir.y > 0.01 && !level.stairAt(eye.x, eye.z)) d = Math.min(d, (WALL_H - eye.y) / _dir.y);
  const h = Math.hypot(_dir.x, _dir.z);
  if (h > 0.05) {
    const ux = _dir.x / h, uz = _dir.z / h;
    let lo = 0, hi = d * h;
    if (!level.lineOfSight(eye.x, eye.z, eye.x + ux * hi, eye.z + uz * hi)) {
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        if (level.lineOfSight(eye.x, eye.z, eye.x + ux * mid, eye.z + uz * mid)) lo = mid;
        else hi = mid;
      }
      d = Math.min(d, lo / h);
    }
  }
  return d;
}

function updateFlashlight(dt) {
  flashRig.position.copy(camera.position);
  flashRig.quaternion.slerp(camera.quaternion, 1 - Math.exp(-dt * 16));
  if (state === 'playing') {
    const d = viewDistance();
    adapt = lerp(adapt, clamp((d / 3) ** 2, 0.2, 1), Math.min(1, dt * 4));
  }
  let i = player.flashlight ? FLASH_POWER * adapt : 0;
  if (ending) i *= ending.phase === 'fold' ? 1 - smoothstep(1.2, 2.4, ending.pt) : ending.phase === 'city' ? 0 : 1;
  const frozen = ending && ending.phase === 'stop';
  if (player.flashlight && !frozen && entity.dist < 9 && entity.state !== STATE.WANDER && entity.state !== STATE.FLEE) {
    if (Math.random() < (1 - entity.dist / 9) * 0.35) i *= Math.random() * 0.4;
  }
  flash.intensity = lerp(flash.intensity, i, Math.min(1, dt * 30));
  bounce.intensity = (flash.intensity / FLASH_POWER) * 1.2;
}

// Lightning through the windows, thunder a moment later.
function updateWeather(dt) {
  lightningT -= dt;
  if (lightningT <= 0) {
    lightningT = 18 + Math.random() * 30;
    lightning = 1;
    const closeness = 0.3 + Math.random() * 0.7;
    setTimeout(() => audio.thunder(closeness), (1 - closeness) * 2500 + 300);
  }
  lightning = Math.max(0, lightning - dt * 3);
  const flick = lightning > 0 ? (Math.sin(lightning * 40) > 0 ? lightning : lightning * 0.3) : 0;
  hemi.intensity = 0.35 + flick * 0.9;
  hemi.color.setRGB(0.106 + flick * 0.4, 0.12 + flick * 0.45, 0.15 + flick * 0.6);
  scene.backgroundIntensity = NIGHT_BG + flick * 2.5;
  scene.environmentIntensity = NIGHT_ENV + flick * 1.2;
}

// ---------- fear & audio ----------
function computeFear() {
  if (!entity || !D.monster) return 0;
  const d = entity.dist;
  let f = smoothstep(22, 3, d);
  if (entity.state === STATE.CHASE) f = Math.max(f, 0.55 + smoothstep(25, 4, d) * 0.45);
  else if (entity.state === STATE.INVESTIGATE) f = Math.max(f * 0.8, 0.25 * smoothstep(30, 8, d));
  else if (entity.state === STATE.FLEE) f *= 0.4;
  else f *= entity.walls === 0 ? 1 : 0.6;
  return clamp(f, 0, 1);
}

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
let breathPhase = 0;
function updateAudio(dt, fear) {
  if (!audio.ctx) return;
  camera.getWorldDirection(_fwd);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  audio.setListener(camera.position, _fwd, _up);
  const playing = state === 'playing' || state === 'dying' || (state === 'ending' && ending.phase !== 'city');
  const chase = entity.state === STATE.CHASE;
  breathPhase += dt * (chase ? 5.5 : 2.2);
  const breathe = Math.pow(Math.max(0, Math.sin(breathPhase)), 2);
  const lvl = playing && entity.root.visible ? (chase ? 0.55 : 0.18) * (0.25 + 0.75 * breathe) : 0;
  audio.updateEntityLoop(entity.headPos(), entity.muffle, lvl);
  if (state === 'playing' || state === 'dying') audio.update(dt, fear, Math.max(1 - player.stamina, player.wounds * 0.25), camera.position);
  if (state === 'ending' || state === 'won') audio.updateCity(dt);
}

// ---------- HUD ----------
function woundLevel() { return player.wounds / Math.max(1, D.wounds); }

function updateHUDStatic() {
  $('flareCount').textContent = '▮'.repeat(player.flares) + '▯'.repeat(Math.max(0, D.flares - player.flares));
  $('kitCount').textContent = String(player.kits);
  // CRITICAL: the next hit kills
  const w = player.wounds === 0 ? 0 : player.wounds >= D.wounds ? 2 : 1;
  $('woundState').textContent = ['OK', 'WOUNDED', 'CRITICAL'][w];
  $('woundState').className = 'state w' + w;
  $('blood').style.opacity = String(woundLevel() * 0.8);
}

function updateHUD(dt) {
  const n = player.noise;
  const fill = $('noiseFill');
  fill.style.width = `${Math.round(n * 100)}%`;
  fill.style.background = n < 0.3 ? '#6c9' : n < 0.65 ? '#d8b44a' : '#d2452f';
  $('staminaFill').style.width = `${Math.round(player.stamina * 100)}%`;
  $('staminaFill').style.background = player.exhausted ? '#844' : '#bbb39c';
  if (audio.micEnabled) $('micFill').style.width = `${Math.round(player.mic * 100)}%`;
  $('flareStatus').textContent = player.flareBurn > 0 ? `BURNING ${Math.ceil(player.flareBurn)}s`
    : player.flareCooldown > 0 ? `RECHARGING ${Math.ceil(player.flareCooldown)}s`
      : player.flares > 0 ? 'READY [Q]' : 'EMPTY';
  if (state !== 'playing' && state !== 'paused') $('blood').style.opacity = '0';
  else if (player.wounds > 0) $('blood').style.opacity = String(woundLevel() * 0.7 + Math.sin(performance.now() / 400) * 0.08);
  if (messageTimer > 0) {
    messageTimer -= dt;
    if (messageTimer <= 0) $('message').classList.remove('show');
  }
  if (DEBUG && entity) {
    $('debug').textContent =
      `state ${entity.state}  duck ${entity.duck.toFixed(2)}\ndist ${entity.dist.toFixed(1)}  walls ${entity.walls}\n` +
      `noise ${player.noise.toFixed(2)}  heard ${entity.heard}  saw ${entity.saw}\n` +
      `y ${player.pos.y.toFixed(2)}  loops ${loops}\nfps ${(1 / Math.max(dt, 1e-3)).toFixed(0)}`;
  }
}

// ---------- death ----------
function die() {
  state = 'dying';
  deathT = 0;
  entity.lunge(player.pos);
  audio.scream();
  player.flashlight = true;
  if (document.pointerLockElement) document.exitPointerLock();
  $('prompt').textContent = '';
}

function updateDying(dt, time) {
  deathT += dt;
  entity.update(dt, null, time);
  const head = entity.head.getWorldPosition(new THREE.Vector3());
  const m = new THREE.Matrix4().lookAt(camera.position, head, new THREE.Vector3(0, 1, 0));
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  camera.quaternion.slerp(q, Math.min(1, dt * 14));
  camera.position.x += (Math.random() - 0.5) * 0.03;
  camera.position.y += (Math.random() - 0.5) * 0.03;
  camera.fov = lerp(camera.fov, 55, dt * 3);
  camera.updateProjectionMatrix();
  fx.uniforms.hurt.value = smoothstep(0.7, 1.5, deathT);
  if (deathT > 1.25) { $('flash').style.transition = 'none'; $('flash').style.opacity = Math.min(1, (deathT - 1.25) * 3); }
  if (deathT > 1.8) {
    state = 'dead';
    entity.root.visible = false;
    $('deadStats').textContent = `Survived ${formatTime(elapsed)}.`;
    showScreen('dead');
  }
}

// ---------- the ending ----------
// You lift the working clock off the wall and every stopped clock in the
// building starts up at once. The noise wakes the creature and it comes
// straight for you. A step short of you, time stops. Then the building folds
// in on itself around it, crushes it, and leaves you on an ordinary street.
//
// Phases: grab -> charge (skipped on Peaceful) -> stop -> fold -> city.
let heldClock = null;
const clockGlow = new THREE.PointLight(0xdfe8ff, 0, 3, 2);
clockGlow.position.set(-0.12, -0.1, -0.35);
camera.add(clockGlow);
// low in the left hand, out of the flashlight beam
const HOLD_POS = new THREE.Vector3(-0.2, -0.3, -0.62);
const HOLD_QUAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0.35, 0.12));
const HOLD_SCALE = 0.7;
const _head = new THREE.Vector3();

function startEnding(clock) {
  state = 'ending';
  clock.taken = true;
  $('prompt').textContent = '';
  $('message').classList.remove('show');
  messageTimer = 0;
  $('hud').classList.add('hidden');
  player.flareBurn = 0;
  flareModel.visible = false;
  flareLight.intensity = 0;
  audio.flareOut();

  // Lift it off the wall into your hands.
  heldClock = clock;
  camera.updateMatrixWorld();
  camera.attach(clock.group);
  audio.chime(0.55);
  spike(1);

  // The other clocks, which are about to start up.
  const chorus = world.clocks.filter((c) => c !== clock).map((c) => {
    const p = c.group.getWorldPosition(new THREE.Vector3());
    return {
      c, p,
      muffle: Math.min(1, level.wallsBetween(player.pos.x, player.pos.z, p.x, p.z) * 0.25),
      wait: 0.2 + Math.random() * 0.9,
      clock: Math.random() * 43200,
      tock: false,
    };
  });

  ending = {
    t: 0,
    phase: 'grab',
    pt: 0, // time in the current phase
    fromPos: clock.group.position.clone(),
    fromQuat: clock.group.quaternion.clone(),
    fromScale: clock.group.scale.x,
    stuckT: 0,
    handT: 0, // how far the held clock's hands have been wound
    handRate: 0,
    chorus,
    chorusRate: 0,
    P: D.monster ? new THREE.Vector3() : foldCentre(),
    hbT: 0,
    crushed: false,
    cityT: 0,
  };
}

function setPhase(phase) {
  ending.phase = phase;
  ending.pt = 0;
}

// Where the building folds to on Peaceful: a visible spot in front of you.
// Cell centres are always clear of furniture, so use the farthest visible one
// in this room (beyond a doorway the header would hide it), else any nearby.
function foldCentre() {
  const myRoom = level.roomAt(...level.cellOf(player.pos.x, player.pos.z));
  let best = null, bestScore = -Infinity;
  for (let z = 0; z < level.H; z++) {
    for (let x = 0; x < level.W; x++) {
      if (!level.walkable(x, z)) continue;
      const c = level.center(x, z);
      const d = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
      if (d > 7 || !level.lineOfSight(player.pos.x, player.pos.z, c.x, c.z)) continue;
      const score = (level.roomAt(x, z) === myRoom ? 10 : 0) + Math.min(d, 4.5) - (d < 1.6 ? 8 : 0);
      if (score > bestScore) { bestScore = score; best = c; }
    }
  }
  const P = best || level.center(...level.cellOf(player.pos.x, player.pos.z));
  if (Math.hypot(P.x - player.pos.x, P.z - player.pos.z) < 0.8) P.x += 1.2;
  return P;
}

// Where it comes from: somewhere 6-12 m away by the shortest route, in plain
// sight if possible. If it's already close and visible, it just comes.
function chargeStart() {
  const ex = entity.pos.x - player.pos.x, ez = entity.pos.z - player.pos.z;
  const ed = Math.hypot(ex, ez);
  if (ed > 6 && ed < 14 && level.lineOfSight(player.pos.x, player.pos.z, entity.pos.x, entity.pos.z)) return entity.pos.clone();
  const [px, pz] = level.nearestWalkable(...level.cellOf(player.pos.x, player.pos.z));
  const steps = level.bfs(px, pz);
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < steps.length; i++) {
    const x = i % level.W, z = Math.floor(i / level.W);
    if (steps[i] < 2 || steps[i] > 4 || level.kindAt(x, z) === K.STAIR) continue;
    const c = level.center(x, z);
    const d = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
    const score = (level.lineOfSight(player.pos.x, player.pos.z, c.x, c.z) ? 20 : 0) + Math.min(d, 11) - (d < 5 ? 25 : 0) + Math.random();
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

function startCharge() {
  setPhase('charge');
  const from = chargeStart();
  if (!from) { startStop(); return; }
  entity.frozen = false;
  entity.root.visible = true;
  entity.root.scale.set(1, 1, 1);
  entity.root.position.set(from.x, 0, from.z);
  entity.yaw = Math.atan2(player.pos.x - from.x, player.pos.z - from.z);
  entity.state = STATE.CHASE;
  entity.curSpeed = 3;
  entity.setPath(new THREE.Vector3(player.pos.x, 0, player.pos.z));
  audio.stinger();
  audio.entityVoice(entity.headPos(), 0, 'shriek');
}

function startStop() {
  setPhase('stop');
  audio.timeStop();
}

function startFold() {
  setPhase('fold');
  audio.timeResume();
  audio.endingRumble(3.4);
  audio.chime(0.8, 147);
  const P = ending.P;
  if (D.monster) {
    P.copy(entity.pos);
    entity.freezeAt(P, Math.atan2(player.pos.x - P.x, player.pos.z - P.z));
    audio.entityVoice(entity.headPos(), 0, 'shriek');
  }
  const toPlayer = new THREE.Vector3(player.pos.x - P.x, 0, player.pos.z - P.z).normalize();
  tearLight.position.set(P.x + toPlayer.x * 0.9, 2.1, P.z + toPlayer.z * 0.9);
  // A real photographed street, waiting behind the walls.
  scene.background = A.hdri.street;
  scene.backgroundIntensity = 0;
  scene.backgroundRotation.set(0, streetRotation(player.yaw), 0);
  scene.environment = env.street;
  scene.environmentRotation.copy(scene.backgroundRotation);
  crushPivot = new THREE.Group();
  crushPivot.position.set(P.x, 1.3, P.z);
  scene.add(crushPivot);
  crushPivot.add(world.group);
  world.group.position.set(-P.x, -1.3, -P.z);
}

// Turn the view toward a point.
function lookToward(p, dt, rate) {
  const dx = p.x - camera.position.x, dy = p.y - camera.position.y, dz = p.z - camera.position.z;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.6, 0.7);
  const k = Math.min(1, dt * rate);
  player.yaw += angleDelta(player.yaw, yaw) * k;
  player.pitch = lerp(player.pitch, pitch, k);
}

// The stopped clocks start up, their hands racing, ticking faster and faster.
function updateChorus(dt) {
  const e = ending;
  e.chorusRate = Math.min(9, e.chorusRate + dt * 3);
  for (const k of e.chorus) {
    k.clock += dt * 60 * e.chorusRate * e.chorusRate;
    k.c.setTime(k.clock / 3600, (k.clock / 60) % 60, k.clock % 60);
    k.wait -= dt;
    if (k.wait <= 0) {
      k.wait = Math.max(0.13, 1 / (1 + e.chorusRate)) * (0.8 + Math.random() * 0.4);
      k.tock = !k.tock;
      audio.tick(k.p, k.tock, k.muffle, 0.8);
    }
  }
}

// The clock in your hands: lifted into view, its hands driven by handRate.
function updateHeldClock(dt) {
  const e = ending;
  const g = heldClock.group;
  if (e.phase === 'grab') {
    const k = smoothstep(0, 0.8, e.pt);
    g.position.lerpVectors(e.fromPos, HOLD_POS, k);
    g.quaternion.slerpQuaternions(e.fromQuat, HOLD_QUAT, k);
    g.scale.setScalar(lerp(e.fromScale, HOLD_SCALE, k));
  } else if (e.phase === 'city') {
    // lowered once you're home
    const k = smoothstep(2.5, 4, e.cityT);
    g.position.set(HOLD_POS.x, HOLD_POS.y - k * 0.5, HOLD_POS.z);
  }
  e.handT += e.handRate * dt;
  const now = new Date();
  const secs = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000 + e.handT;
  const w = ((secs % 43200) + 43200) % 43200;
  heldClock.setTime(w / 3600, (w / 60) % 60, w % 60);
}

function updateEnding(dt, time) {
  const e = ending;
  e.t += dt;
  e.pt += dt;
  const pt = e.pt;

  if (e.phase === 'grab') {
    // the hands begin to turn backwards
    e.handRate = -smoothstep(0.6, 1.6, pt) * 400;
    if (pt > 0.5) updateChorus(dt);
    player.shake = smoothstep(0.5, 1.6, pt) * 0.35;
    if (D.monster) lookToward(_head.set(camera.position.x - Math.sin(player.yaw), camera.position.y - 0.25, camera.position.z - Math.cos(player.yaw)), dt, 3);
    else lookToward(_head.set(e.P.x, 1.2, e.P.z), dt, 1.5);
    if (pt > (D.monster ? 1.6 : 2.6)) D.monster ? startCharge() : startStop();
  } else if (e.phase === 'charge') {
    e.handRate = -1500;
    updateChorus(dt);
    // Straight at you once it can see you; nothing in the room slows it down.
    const target = new THREE.Vector3(player.pos.x, 0, player.pos.z);
    const sees = level.lineOfSight(entity.pos.x, entity.pos.z, player.pos.x, player.pos.z);
    if (sees) entity.path = [target];
    else entity.setPath(target);
    const before = entity.dist;
    entity.follow(dt, 6.8);
    entity.animate(dt, time);
    entity.dist = Math.hypot(entity.pos.x - player.pos.x, entity.pos.z - player.pos.z);
    e.stuckT = before - entity.dist < dt * 0.5 ? e.stuckT + dt : 0;
    lookToward(entity.head.getWorldPosition(_head), dt, 6);
    player.shake = 0.35 + smoothstep(12, 2, entity.dist) * 0.5;
    // the bulbs it passes burst
    for (const f of world.fixtures) {
      if (f.mode === 'broken' || Math.hypot(f.pos.x - entity.pos.x, f.pos.z - entity.pos.z) > 2.6) continue;
      f.mode = 'broken';
      audio.bulbPop(f.pos);
      emitSparks(f.pos, 40, 2.5);
    }
    // your heart, pounding faster as it closes
    e.hbT -= dt;
    if (e.hbT <= 0) {
      audio.heartbeat(1);
      e.hbT = lerp(0.35, 0.75, smoothstep(2, 10, entity.dist));
    }
    if ((sees && (entity.dist < 2.4 || e.stuckT > 0.5)) || pt > 6) startStop();
  } else if (e.phase === 'stop') {
    // Nothing moves: not it, not the dust, not the clocks. Then one tick.
    e.handRate = 0;
    player.shake = 0;
    clockGlow.intensity = smoothstep(0.9, 1.5, pt) * 0.5;
    if (D.monster) lookToward(entity.head.getWorldPosition(_head).setY(_head.y - 0.5), dt, 4);
    else lookToward(_head.set(e.P.x, 1.2, e.P.z), dt, 1.5);
    if (pt > 1.5) startFold();
  } else if (e.phase === 'fold') {
    if (D.monster) {
      entity.update(dt, null, time);
      lookToward(entity.head.getWorldPosition(_head).setY(Math.max(1.4, _head.y - 0.5)), dt, 5);
    } else {
      lookToward(_head.set(e.P.x, 1.2, e.P.z), dt, 3);
    }
    e.handRate = 2500;
    player.shake = Math.min(1, pt / 2) * 0.8;
    clockGlow.intensity = e.crushed ? 0 : (0.5 + smoothstep(0, 3, pt) * 2) * (0.8 + Math.random() * 0.2);
    tearLight.intensity = e.crushed || !D.monster ? 0 : smoothstep(0, 0.6, pt) * 9 * (0.75 + Math.random() * 0.25);

    // the apartment collapses into the creature
    const f = smoothstep(0, 3.2, pt);
    const sc = Math.max(0.0001, 1 - Math.pow(f, 1.6));
    crushPivot.scale.setScalar(sc);
    crushPivot.rotation.y = f * f * 1.4;
    crushPivot.rotation.z = Math.sin(f * 9) * 0.05 * f;
    // reality bleeds in: daylight rises, the fog lifts
    const day = smoothstep(0.2, 3.4, pt);
    scene.backgroundIntensity = day;
    scene.environmentIntensity = lerp(NIGHT_ENV, 1, day);
    scene.fog.density = lerp(0.07, 0, Math.pow(day, 0.5));
    hemi.intensity = lerp(0.35, 0.6, day);
    renderer.toneMappingExposure = lerp(EXPOSURE, 1.0, day);
    fx.uniforms.grain.value = 1 - day * 0.75;
    if (D.monster) {
      // the creature is squeezed
      const sq = smoothstep(0.35, 0.9, f);
      entity.root.scale.set(1 + sq * 0.6, Math.max(0.02, 1 - sq), 1 + sq * 0.6);
      entity.root.position.x = e.P.x + (Math.random() - 0.5) * sq * 0.15;
    }
    if (f > 0.93 && !e.crushed) {
      e.crushed = true;
      entity.root.visible = false;
      world.group.visible = false;
      audio.crush();
      const fl = $('flash');
      fl.style.transition = 'none';
      fl.style.background = '#fff';
      fl.style.opacity = 1;
      requestAnimationFrame(() => { fl.style.transition = 'opacity 2.2s'; fl.style.opacity = 0; });
    }
    updateCamera(dt, time);
    if (pt > 3.4) {
      setPhase('city');
      audio.startCity();
      player.shake = 0;
      e.handRate = 0;
      e.handT = 0;
      camera.fov = 72;
      camera.updateProjectionMatrix();
    }
    updateHeldClock(dt);
    return;
  } else {
    e.cityT += dt;
    // the clock in your hand keeps ordinary time
    if (Math.floor(e.cityT) !== Math.floor(e.cityT - dt) && e.cityT < 3) audio.tick(camera.position, Math.floor(e.cityT) % 2 === 1, 0, 0.3);
    if (e.cityT > 7 && state === 'ending') {
      state = 'won';
      if (document.pointerLockElement) document.exitPointerLock();
      $('winStats').textContent = `You found the clock in ${formatTime(elapsed)} on ${D.label}. Everything is normal.`;
      showScreen('win');
    }
  }
  updateCamera(dt, time);
  updateHeldClock(dt);
}

// Rotate the street photo so its view down the road is where you're looking.
function streetRotation(yaw) {
  return yaw + Math.PI / 2 + STREET_HEADING;
}
const STREET_HEADING = 0;

function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ---------- main loop ----------
const clock = new THREE.Clock();
const _tmpV = new THREE.Vector3();
let time = 0;
let dustTime = 0;

function endingFear() {
  if (state !== 'ending') return 0;
  if (ending.phase === 'grab') return smoothstep(0.5, 1.6, ending.pt) * 0.4;
  if (ending.phase === 'charge') return 0.5 + smoothstep(12, 2.5, entity.dist) * 0.5;
  return 0;
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;
  if (state === 'loading') return;

  if (state === 'playing') {
    elapsed += dt;
    updatePlayer(dt);
    updateCamera(dt, time);
    camera.getWorldDirection(_look);
    entity.aggression = Math.min(4, elapsed / 100);
    const result = D.monster && entity.update(dt, {
      pos: camera.position,
      feetY: player.pos.y,
      noise: player.noise,
      flashlight: player.flashlight,
      crouch: player.crouch,
      look: _look,
      inStair: !!level.stairAt(player.pos.x, player.pos.z),
      flare: player.flareBurn > 0,
    }, time);
    updateInteract();
    updateFlare(dt, time);
    updateStairDoors(dt);
    updateWeather(dt);
    if (result === 'hit') takeHit();
  } else if (state === 'dying') {
    updateDying(dt, time);
  } else if (state === 'ending' || state === 'won') {
    if (state === 'ending') updateEnding(dt, time);
    else updateCamera(dt, time);
  } else if (state === 'menu' || state === 'dead') {
    player.yaw += dt * 0.05;
    updateCamera(dt, time);
    if (audio.micEnabled) {
      player.mic = audio.readMic(dt);
      $('menuMicFill').style.width = `${Math.round(player.mic * 100)}%`;
    }
  }

  const frozen = state === 'ending' && ending.phase === 'stop';
  const fear = state === 'playing' || state === 'dying' ? computeFear() : endingFear();
  if (world) {
    updateClocks();
    updateLights(dt);
  }
  updateFlashlight(dt);
  if (!frozen) {
    dustTime += dt;
    updateSparks(dt);
  }
  dustMat.uniforms.time.value = dustTime;
  dustMat.uniforms.centre.value.copy(camera.position);
  flash.getWorldPosition(dustMat.uniforms.lightPos.value);
  dustMat.uniforms.lightDir.value.subVectors(flash.target.getWorldPosition(_tmpV), dustMat.uniforms.lightPos.value).normalize();
  dustMat.uniforms.power.value = (flash.intensity / FLASH_POWER) * (!ending ? 1 : ending.phase === 'fold' ? 1 - smoothstep(0.3, 1.8, ending.pt) : ending.phase === 'city' ? 0 : 1);
  dustMat.uniforms.pixelRatio.value = renderer.getPixelRatio() * window.innerHeight / 720;
  updateAudio(dt, fear);
  updateHUD(dt);
  fx.uniforms.time.value = time;
  fx.uniforms.fear.value = lerp(fx.uniforms.fear.value, fear, Math.min(1, dt * 3));
  fx.uniforms.freeze.value = lerp(fx.uniforms.freeze.value, frozen ? 1 : 0, Math.min(1, dt * (frozen ? 14 : 3)));
  fx.uniforms.hurt.value = Math.max(0, fx.uniforms.hurt.value - (state === 'dying' ? 0 : dt * 1.2));
  fx.uniforms.wound.value = lerp(fx.uniforms.wound.value, state === 'playing' ? woundLevel() : 0, Math.min(1, dt * 2));
  composer.render(dt);
}

// Load the photoscanned assets, then build everything.
async function init() {
  const btn = $('startBtn');
  A = await loadAssets(renderer, (f) => { btn.textContent = `Loading ${Math.round(f * 100)}%`; });
  btn.textContent = 'Building the apartment…';
  await new Promise((r) => setTimeout(r, 30));
  const pmrem = new THREE.PMREMGenerator(renderer);
  env = { night: pmrem.fromEquirectangular(A.hdri.night).texture, street: pmrem.fromEquirectangular(A.hdri.street).texture };
  pmrem.dispose();
  M = makeMaterials(A);
  newGame();
  state = 'menu';
  $('startBtn').disabled = false;
  $('startBtn').textContent = 'Enter';
  if (DEBUG) {
    window.__game = {
      player, scene, flash, pool, composer, renderer, dust, get gtao() { return gtao; }, get M() { return M; }, get entity() { return entity; }, get level() { return level; },
      get world() { return world; }, get ending() { return ending; }, get state() { return state; },
      setState: (s) => { state = s; showScreen(null); },
      startEnding: () => startEnding(world.clocks.find((c) => c.working)),
      get difficulty() { return difficulty; },
      setDifficulty: (d) => { difficulty = d; applyDifficulty(); },
      takeHit, lightFlare,
    };
  }
}
init().catch((err) => {
  console.error(err);
  $('startBtn').textContent = 'Failed to load assets — see README';
});
frame();
