import * as THREE from 'three';
import { angleDelta, lerp, smoothstep } from './util.js';

export const STATE = {
  WANDER: 'wander',
  INVESTIGATE: 'investigate',
  CHASE: 'chase',
  SEARCH: 'search',
  FLEE: 'flee',
  KILL: 'kill',
};

const HEAR_RANGE = 30; // metres of corridor a noise of 1.0 carries
const CHASE_MEMORY = 2.2; // seconds it keeps tracking you after losing contact
const HIP_Y = 1.32;
const SPINE_TILT = 0.42;

// A gaunt, too-tall humanoid with near-black skin. It is nearly blind in the
// dark but has extraordinary hearing: every noise the player makes is a beacon.
export class Entity {
  constructor(scene, audio, M) {
    this.audio = audio;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.build(M.skin);
    this.path = [];
    this.lastKnown = new THREE.Vector3();
    this.investigateTarget = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.headTarget = new THREE.Euler();
    this.speedMul = 1; // set by the difficulty
  }

  build(mat) {
    const limb = (len, r0, r1, up = false) => {
      const geo = new THREE.CylinderGeometry(r1, r0, len, 16, 6);
      // a slight bulge in the middle of each bone reads as wasted muscle
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const t = p.getY(i) / len + 0.5;
        const bulge = 1 + Math.sin(t * Math.PI) * 0.12;
        p.setX(i, p.getX(i) * bulge);
        p.setZ(i, p.getZ(i) * bulge);
      }
      geo.computeVertexNormals();
      geo.translate(0, up ? len / 2 : -len / 2, 0);
      return new THREE.Mesh(geo, mat);
    };
    const blob = (r, sx, sy, sz) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), mat);
      m.scale.set(sx, sy, sz);
      return m;
    };

    this.hips = new THREE.Group();
    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);
    this.hips.add(blob(0.13, 1.3, 0.7, 0.85));

    this.legs = [-1, 1].map((side) => {
      const hip = new THREE.Group();
      hip.position.set(0.11 * side, 0, 0);
      this.hips.add(hip);
      hip.add(limb(0.68, 0.075, 0.048));
      const knee = new THREE.Group();
      knee.position.y = -0.68;
      hip.add(knee);
      knee.add(blob(0.052, 1, 1.1, 1));
      knee.add(limb(0.64, 0.05, 0.03));
      const ankle = new THREE.Group();
      ankle.position.y = -0.64;
      knee.add(ankle);
      ankle.add(blob(0.034, 1, 1, 1));
      const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.032, 0.2, 6, 12), mat);
      foot.rotation.x = Math.PI / 2;
      foot.scale.set(1.15, 1, 0.65);
      foot.position.set(0, -0.012, 0.08);
      ankle.add(foot);
      for (let t = 0; t < 4; t++) {
        const toe = limb(0.06, 0.011, 0.006);
        toe.rotation.x = -Math.PI / 2 - 0.25;
        toe.position.set(-0.024 + t * 0.016, -0.02, 0.2);
        ankle.add(toe);
      }
      return { hip, knee, ankle, side };
    });

    this.spine = new THREE.Group();
    this.spine.rotation.x = SPINE_TILT;
    this.hips.add(this.spine);
    // Lathed torso: pinched waist, sunken belly, broad bony chest.
    const profile = [
      [0.0, -0.02], [0.11, 0.0], [0.1, 0.12], [0.085, 0.26], [0.1, 0.4],
      [0.15, 0.55], [0.165, 0.66], [0.15, 0.76], [0.09, 0.82], [0.0, 0.84],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const torso = new THREE.Mesh(new THREE.LatheGeometry(profile, 32), mat);
    torso.scale.set(1.15, 1, 0.62);
    this.spine.add(torso);
    // Ribs pressing through the skin, spine ridge down the back.
    for (let i = 0; i < 5; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.15 - i * 0.006, 0.007, 6, 24, Math.PI * 1.1), mat);
      rib.rotation.set(Math.PI / 2 + 0.25, 0, Math.PI * 0.95);
      rib.scale.set(1.12, 0.66, 1);
      rib.position.set(0, 0.44 + i * 0.06, 0.004);
      this.spine.add(rib);
    }
    for (let i = 0; i < 10; i++) {
      const v = blob(0.02, 1.1, 0.75, 1);
      v.position.set(0, 0.06 + i * 0.075, -0.098 + Math.sin(i / 9 * Math.PI) * -0.012);
      this.spine.add(v);
    }

    this.chest = new THREE.Group();
    this.chest.position.y = 0.74;
    this.spine.add(this.chest);
    const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.36, 8, 16), mat);
    shoulders.rotation.z = Math.PI / 2;
    shoulders.scale.set(1, 1, 0.85);
    this.chest.add(shoulders);
    for (const sx of [-1, 1]) {
      const clav = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.16, 4, 8), mat);
      clav.rotation.z = Math.PI / 2 + sx * 0.18;
      clav.position.set(0.1 * sx, 0.02, 0.055);
      this.chest.add(clav);
    }

    this.neck = new THREE.Group();
    this.neck.position.set(0, 0.05, 0.02);
    this.neck.rotation.x = 0.2;
    this.chest.add(this.neck);
    this.neck.add(limb(0.24, 0.045, 0.032, true));

    this.head = new THREE.Group();
    this.head.position.y = 0.24;
    this.neck.add(this.head);
    const skull = blob(0.12, 0.82, 1.3, 0.95);
    skull.position.y = 0.1;
    this.head.add(skull);
    // brow ridge and hollow cheeks
    const brow = blob(0.06, 1.6, 0.35, 0.6);
    brow.position.set(0, 0.15, 0.075);
    this.head.add(brow);
    this.jaw = new THREE.Group();
    this.jaw.position.set(0, 0.03, 0.01);
    this.head.add(this.jaw);
    const jaw = blob(0.075, 0.85, 1.15, 0.9);
    jaw.position.set(0, -0.04, 0.03);
    this.jaw.add(jaw);
    const dark = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.4, 3.4) });
    for (const sx of [-1, 1]) {
      const socket = new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 10), dark);
      socket.scale.set(1.1, 0.75, 0.45);
      socket.position.set(0.042 * sx, 0.13, 0.093);
      this.head.add(socket);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), eyeMat);
      eye.position.set(0.042 * sx, 0.13, 0.1);
      this.head.add(eye);
    }
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.03, 14, 12), dark);
    mouth.scale.set(0.75, 2.0, 0.4);
    mouth.position.set(0, -0.005, 0.1);
    this.head.add(mouth);

    this.arms = [-1, 1].map((side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.24 * side, 0, 0);
      this.chest.add(shoulder);
      shoulder.add(blob(0.045, 1, 1, 1));
      shoulder.add(limb(0.64, 0.05, 0.034));
      const elbow = new THREE.Group();
      elbow.position.y = -0.64;
      shoulder.add(elbow);
      elbow.add(blob(0.038, 1, 1.1, 1));
      elbow.add(limb(0.62, 0.038, 0.024));
      const wrist = new THREE.Group();
      wrist.position.y = -0.62;
      elbow.add(wrist);
      const palm = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.05, 4, 10), mat);
      palm.scale.set(1.4, 1, 0.55);
      palm.position.y = -0.04;
      wrist.add(palm);
      // Long, two-jointed fingers and a thumb.
      const fingers = [];
      for (let f = 0; f < 5; f++) {
        const thumb = f === 4;
        const base = new THREE.Group();
        if (thumb) {
          base.position.set(-0.03 * side, -0.03, 0.012);
          base.rotation.z = 0.6 * side;
        } else {
          base.position.set(-0.025 + f * 0.017, -0.075, 0);
          base.rotation.z = (f - 1.5) * 0.08;
        }
        wrist.add(base);
        const l1 = thumb ? 0.06 : 0.12 + (f === 1 || f === 2 ? 0.025 : 0);
        const l2 = thumb ? 0.05 : 0.1 + (f === 1 || f === 2 ? 0.02 : 0);
        base.add(limb(l1, 0.0105, 0.009));
        const mid = new THREE.Group();
        mid.position.y = -l1;
        base.add(mid);
        mid.add(blob(0.0095, 1, 1, 1));
        mid.add(limb(l2, 0.009, 0.0035));
        fingers.push({ base, mid, thumb });
      }
      return { shoulder, elbow, wrist, fingers, side };
    });

    this.root.traverse((o) => { if (o.isMesh && o.material === mat) o.castShadow = true; });
  }

  reset(level, spawn) {
    this.level = level;
    this.root.position.copy(spawn);
    this.root.scale.set(1, 1, 1);
    this.root.visible = true;
    this.state = STATE.WANDER;
    this.path = [];
    this.yaw = Math.random() * Math.PI * 2;
    this.curSpeed = 0;
    this.phase = 0;
    this.lastStep = 0;
    this.lastContact = 99;
    this.repath = 0;
    this.searchT = 0;
    this.idleT = 2;
    this.voiceT = 6;
    this.twitchT = 1;
    this.stuckT = 0;
    this.fleeT = 0;
    this.fleeSpeed = 4.6;
    this.fleeRepick = 0;
    this.hitCooldown = 0;
    this.grace = 8; // seconds before it starts listening
    this.goingToLast = false;
    this.dist = 99;
    this.walls = 0;
    this.aggression = 0;
    this.duck = 0;
    this.frozen = false;
    this.headTarget.set(0, 0, 0);
  }

  get pos() { return this.root.position; }
  get muffle() { return Math.min(1, this.walls * 0.3); }
  get chaseSpeed() { return (4.3 + this.aggression * 0.15) * this.speedMul; }

  // P: { pos (eye Vector3), feetY, noise, flashlight, crouch, look, inStair, flare }
  update(dt, P, time) {
    if (this.state === STATE.KILL || this.frozen) { this.animate(dt, time); return null; }
    const L = this.level;
    const pos = this.root.position;
    this.grace -= dt;
    this.hitCooldown -= dt;
    const dx = P.pos.x - pos.x;
    const dz = P.pos.z - pos.z;
    const dist = Math.hypot(dx, dz);
    this.dist = dist;
    this.walls = L.wallsBetween(pos.x, pos.z, P.pos.x, P.pos.z);
    const los = this.walls === 0;
    const alert = this.grace <= 0 && this.state !== STATE.FLEE;

    // ----- sight -----
    let sees = false;
    if (los && alert && Math.abs(P.feetY) < 1.5) {
      const facing = (dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw)) / Math.max(dist, 0.01);
      let range = P.flashlight ? 15 : 6;
      if (P.crouch) range *= 0.6;
      if (this.state === STATE.CHASE) range *= 1.5;
      const inFov = facing > 0.25 || dist < 2.5;
      // A flashlight shone straight into its face gives you away from afar.
      const beamOnIt = P.flashlight && dist < 22 && (-(P.look.x * dx + P.look.z * dz)) / Math.max(dist, 0.01) > 0.95;
      sees = (inFov && dist < range) || beamOnIt;
    }

    // ----- hearing -----
    let hears = false;
    let eff = Infinity;
    const hearRange = P.noise * (HEAR_RANGE + this.aggression * 2);
    if (alert && P.noise > 0.02 && dist < hearRange) {
      eff = Math.min(L.soundDistance(P.pos, pos), dist + this.walls * 5);
      hears = eff < hearRange;
    }
    this.heard = hears;
    this.saw = sees;

    if (sees) this.engage(P.pos);
    else if (hears) {
      if (this.state === STATE.CHASE || hearRange - eff > 11) this.engage(P.pos);
      else this.investigate(P.pos, eff / hearRange);
    }

    this.lastContact += dt;
    this.repath -= dt;

    switch (this.state) {
      case STATE.CHASE: {
        if (this.lastContact < CHASE_MEMORY) {
          this.lastKnown.set(P.pos.x, 0, P.pos.z);
          if (los && dist < 9 && !P.inStair && L.clearPath(pos, P.pos, 0.3)) {
            this.path = [this.lastKnown.clone()];
          } else if (this.repath <= 0) {
            this.setPath(this.lastKnown);
            this.repath = 0.35;
          }
        } else if (!this.goingToLast) {
          this.setPath(this.lastKnown);
          this.goingToLast = true;
        }
        const done = this.follow(dt, this.chaseSpeed);
        if (done && this.lastContact >= CHASE_MEMORY) this.startSearch();
        break;
      }
      case STATE.INVESTIGATE:
        if (this.follow(dt, (2.4 + this.aggression * 0.1) * this.speedMul)) this.startSearch();
        break;
      case STATE.SEARCH:
        this.follow(dt, 0);
        this.yaw += Math.sin(time * 1.1) * dt * 1.6;
        this.searchT -= dt;
        if (this.searchT <= 0) { this.state = STATE.WANDER; this.idleT = 0.5; }
        break;
      case STATE.FLEE:
        this.fleeT -= dt;
        this.fleeRepick -= dt;
        if (P.flare && dist < 9 && los && this.fleeRepick <= 0) this.pickFleeTarget(P.pos);
        this.follow(dt, this.fleeSpeed);
        if (this.fleeT <= 0) {
          this.state = STATE.SEARCH;
          this.searchT = 2;
          this.grace = 1.5;
        }
        break;
      default: // WANDER
        if (this.follow(dt, 1.3 * Math.min(1, this.speedMul))) {
          this.idleT -= dt;
          if (this.idleT <= 0) { this.pickWander(P); this.idleT = 1 + Math.random() * 3; }
        }
    }

    this.unstick(dt);
    L.collide(pos, 0.3);
    L.collideBarriers(pos, 0.3);

    // ----- voice -----
    this.voiceT -= dt;
    if (this.voiceT <= 0) {
      const chase = this.state === STATE.CHASE;
      const kind = chase ? (Math.random() < 0.4 ? 'shriek' : 'click') : Math.random() < 0.55 ? 'click' : 'moan';
      this.audio.entityVoice(this.headPos(), this.muffle, kind);
      this.voiceT = chase ? 2.5 + Math.random() * 3 : 7 + Math.random() * 10;
    }

    this.animate(dt, time);

    if (dist < 0.95 && los && Math.abs(P.feetY) < 0.8 && this.hitCooldown <= 0 && this.state !== STATE.FLEE) return 'hit';
    return null;
  }

  engage(target) {
    if (this.state !== STATE.CHASE) {
      this.audio.stinger();
      this.audio.entityVoice(this.headPos(), this.muffle, 'shriek');
      this.voiceT = 3;
      this.repath = 0;
    }
    this.state = STATE.CHASE;
    this.lastContact = 0;
    this.goingToLast = false;
    this.lastKnown.set(target.x, 0, target.z);
  }

  investigate(target, uncertainty) {
    // Faint sounds give a rough direction, loud ones a precise location.
    const err = uncertainty * 4.5;
    const tx = target.x + (Math.random() - 0.5) * 2 * err;
    const tz = target.z + (Math.random() - 0.5) * 2 * err;
    const same = this.state === STATE.INVESTIGATE && Math.hypot(tx - this.investigateTarget.x, tz - this.investigateTarget.z) < 3;
    if (same && this.repath > 0) return;
    if (this.state !== STATE.INVESTIGATE && Math.random() < 0.5) {
      this.audio.entityVoice(this.headPos(), this.muffle, 'click');
      this.voiceT = 4 + Math.random() * 4;
    }
    this.state = STATE.INVESTIGATE;
    this.investigateTarget.set(tx, 0, tz);
    this.setPath(this.investigateTarget);
    this.repath = 0.8;
  }

  startSearch() {
    this.state = STATE.SEARCH;
    this.searchT = 4 + Math.random() * 3;
    this.path = [];
  }

  // The flare: it shrieks, scrambles away, and keeps its distance.
  scare(playerPos, seconds) {
    if (this.state === STATE.KILL) return;
    this.audio.entityVoice(this.headPos(), this.muffle, 'shriek');
    this.state = STATE.FLEE;
    this.fleeT = seconds;
    this.fleeSpeed = 4.6;
    this.pickFleeTarget(playerPos);
  }

  // After wounding you it backs off for a moment.
  retreat(playerPos) {
    this.state = STATE.FLEE;
    this.fleeT = 4.5;
    this.fleeSpeed = 3.2;
    this.hitCooldown = 6;
    this.pickFleeTarget(playerPos);
  }

  pickFleeTarget(from) {
    const L = this.level;
    this.fleeRepick = 2;
    const [px, pz] = L.nearestWalkable(...L.cellOf(from.x, from.z));
    const [ex, ez] = L.nearestWalkable(...L.cellOf(this.pos.x, this.pos.z));
    const dp = L.bfs(px, pz);
    const de = L.bfs(ex, ez);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < dp.length; i++) {
      if (de[i] === Infinity || dp[i] === Infinity) continue;
      const score = Math.min(dp[i], 14) * 2 - de[i] * 0.6 + Math.random();
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best === null) return;
    this.setPath(L.center(best % L.W, Math.floor(best / L.W)));
  }

  pickWander(P) {
    const L = this.level;
    // Loosely drift toward the player's region so it never wanders off for long.
    const [pcx, pcz] = L.cellOf(P.pos.x, P.pos.z);
    const [ecx, ecz] = L.cellOf(this.pos.x, this.pos.z);
    const c = Math.random() < 0.55 ? L.randomWalkableNear(pcx, pcz, 5) : L.randomWalkableNear(ecx, ecz, 8);
    this.setPath(L.center(c[0], c[1]));
  }

  setPath(target) {
    const raw = this.level.findPath(this.pos, target);
    // String-pull: skip waypoints that are directly reachable.
    const out = [];
    let anchor = this.pos.clone();
    let i = 0;
    while (i < raw.length) {
      let j = raw.length - 1;
      while (j > i && !this.level.clearPath(anchor, raw[j], 0.32)) j--;
      out.push(raw[j]);
      anchor = raw[j];
      i = j + 1;
    }
    this.path = out;
  }

  // Walk along the path. Returns true when there is nowhere left to go.
  follow(dt, speed) {
    const pos = this.root.position;
    if (!this.path.length || speed <= 0) {
      this.curSpeed = lerp(this.curSpeed, 0, Math.min(1, dt * 6));
      return true;
    }
    const wp = this.path[0];
    const dx = wp.x - pos.x;
    const dz = wp.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) {
      this.path.shift();
      return this.path.length === 0;
    }
    this.curSpeed = lerp(this.curSpeed, speed, Math.min(1, dt * 3));
    const step = Math.min(d, this.curSpeed * dt);
    pos.x += (dx / d) * step;
    pos.z += (dz / d) * step;
    this.yaw += angleDelta(this.yaw, Math.atan2(dx, dz)) * Math.min(1, dt * 7);
    return false;
  }

  unstick(dt) {
    if (!this.lastPos) this.lastPos = this.pos.clone();
    const moved = this.pos.distanceTo(this.lastPos);
    this.lastPos.copy(this.pos);
    if (this.path.length && moved < 0.2 * dt) {
      this.stuckT += dt;
      if (this.stuckT > 1.2) {
        const target = this.path[this.path.length - 1];
        this.path = this.level.findPath(this.pos, target);
        this.stuckT = 0;
      }
    } else this.stuckT = 0;
  }

  headPos() {
    return this.head.getWorldPosition(this.tmp);
  }

  // It comes from the direction it approached, which is known to be open.
  lunge(playerPos) {
    this.state = STATE.KILL;
    this.path = [];
    let dirX = this.pos.x - playerPos.x;
    let dirZ = this.pos.z - playerPos.z;
    const len = Math.hypot(dirX, dirZ) || 1;
    dirX /= len;
    dirZ /= len;
    this.root.position.set(playerPos.x + dirX * 1.35, 0, playerPos.z + dirZ * 1.35);
    this.yaw = Math.atan2(-dirX, -dirZ);
    this.curSpeed = 0;
    this.duck = 0; // rear up to full height
  }

  // Pinned in place for the ending, upright and screaming.
  freezeAt(p, yaw) {
    this.frozen = true;
    this.state = STATE.SEARCH;
    this.path = [];
    this.curSpeed = 0;
    this.root.position.copy(p);
    this.yaw = yaw;
    this.duck = 0;
  }

  // It is taller than the door frames, so it stoops through them.
  updateDuck(dt) {
    let near = Infinity;
    for (const d of this.level.doorways) {
      const dd = (d.x - this.pos.x) ** 2 + (d.z - this.pos.z) ** 2;
      if (dd < near) near = dd;
    }
    const target = smoothstep(1.5, 0.5, Math.sqrt(near));
    this.duck = lerp(this.duck, target, Math.min(1, dt * 6));
  }

  animate(dt, time) {
    const chase = this.state === STATE.CHASE;
    const kill = this.state === STATE.KILL;
    const frozen = this.frozen;
    if (this.level && !kill && !frozen) this.updateDuck(dt);
    const sp = this.curSpeed;
    const stride = chase ? 1.25 : 0.85;
    this.phase += (sp / stride) * Math.PI * dt;
    const a = Math.min(1, sp / 1.3);
    const ph = this.phase;
    const k = Math.min(1, dt * 10);
    const duck = this.duck;

    for (const leg of this.legs) {
      const p = ph + (leg.side > 0 ? Math.PI : 0);
      leg.hip.rotation.x = lerp(leg.hip.rotation.x, -Math.sin(p) * (chase ? 0.75 : 0.5) * a - duck * 0.25, k);
      leg.knee.rotation.x = lerp(leg.knee.rotation.x, (Math.max(0, Math.sin(p + 1.3)) * (chase ? 1.3 : 0.9) + 0.1) * a + 0.05 + duck * 0.45, k);
      leg.ankle.rotation.x = lerp(leg.ankle.rotation.x, -duck * 0.2, k);
    }
    const spineX = (kill ? 0.6 : chase ? 0.62 : SPINE_TILT) + duck * 0.55;
    this.spine.rotation.x = lerp(this.spine.rotation.x, frozen ? 0.15 : spineX, Math.min(1, dt * 4));
    this.spine.rotation.z = Math.sin(ph) * 0.05 * a;

    for (const arm of this.arms) {
      const p = ph + (arm.side > 0 ? 0 : Math.PI);
      let sx, ex, sz, curl;
      if (kill) {
        sx = -1.9 + Math.sin(time * 40 + arm.side) * 0.05;
        ex = -0.5;
        sz = arm.side * 0.35;
        curl = -0.2;
      } else if (frozen) {
        sx = -0.55 + Math.sin(time * 31 + arm.side) * 0.08;
        ex = -0.6;
        sz = arm.side * 0.55;
        curl = 0.9;
      } else if (chase) {
        sx = -1.15 + Math.sin(p) * 0.35 * a;
        ex = -0.35;
        sz = arm.side * 0.12;
        curl = 0.25;
      } else {
        // counter the hunch so the arms dangle under gravity
        sx = -this.spine.rotation.x + 0.12 - Math.sin(p) * 0.35 * a;
        ex = -0.18 - Math.max(0, Math.sin(p)) * 0.2 * a;
        sz = arm.side * 0.07;
        curl = 0.45 + Math.sin(time * 0.7 + arm.side) * 0.1;
      }
      arm.shoulder.rotation.x = lerp(arm.shoulder.rotation.x, sx, k);
      arm.shoulder.rotation.z = lerp(arm.shoulder.rotation.z, sz, k);
      arm.elbow.rotation.x = lerp(arm.elbow.rotation.x, ex, k);
      for (const f of arm.fingers) {
        f.base.rotation.x = lerp(f.base.rotation.x, curl * (f.thumb ? 0.4 : 0.8), k);
        f.mid.rotation.x = lerp(f.mid.rotation.x, curl * 1.2, k);
      }
    }

    this.hips.position.y = HIP_Y - Math.abs(Math.cos(ph)) * 0.06 * a - (kill ? 0.12 : 0) - duck * 0.2;
    this.jaw.rotation.x = kill || frozen ? 0.5 + Math.sin(time * 30) * 0.05 : 0.12 + Math.sin(time * 1.3) * 0.04;

    // Head: twitchy, bird-like snaps between poses.
    this.twitchT -= dt;
    if (this.twitchT <= 0) {
      const search = this.state === STATE.SEARCH;
      this.twitchT = (search ? 0.3 : 0.6) + Math.random() * (chase ? 0.8 : 2.5);
      this.headTarget.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * (search ? 1.6 : 0.8), (Math.random() - 0.5) * 1.0);
    }
    if (kill) this.headTarget.set(-0.6 + Math.sin(time * 37) * 0.08, Math.sin(time * 29) * 0.15, Math.sin(time * 23) * 0.4);
    if (frozen) this.headTarget.set(-0.2 + Math.sin(time * 41) * 0.2, Math.sin(time * 33) * 0.4, Math.sin(time * 27) * 0.6);
    const hk = Math.min(1, dt * 22);
    this.head.rotation.x = lerp(this.head.rotation.x, this.headTarget.x, hk);
    this.head.rotation.y = lerp(this.head.rotation.y, this.headTarget.y, hk);
    this.head.rotation.z = lerp(this.head.rotation.z, this.headTarget.z, hk);
    this.headTarget.x *= 1 - dt * 0.6;
    this.headTarget.z *= 1 - dt * 0.6;

    this.root.rotation.y = this.yaw;

    // Footfalls.
    const stepIdx = Math.floor(ph / Math.PI);
    if (stepIdx !== this.lastStep) {
      this.lastStep = stepIdx;
      if (sp > 0.3) this.audio.entityStep(this.tmp.set(this.pos.x, 0.1, this.pos.z), this.muffle, chase ? 1 : 0.55);
    }
  }
}
