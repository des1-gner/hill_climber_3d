// Animals — one wandering critter per biome.
//
// Snow has penguins, grassland has sheep, forest has boars, rocky has goats.
// Each animal wanders its own biome (so penguins only appear on snow, etc.),
// animated with a waddle/bob. They are "enemies": driving into one shoves the
// car (an impulse on the chassis) and launches the animal in a ballistic arc;
// it then lands and re-spawns in a patch of its biome near the player, so each
// biome you enter is populated with its animal.
//
// Owns its own meshes (added to the renderer scene) and pushes the car via the
// physics engine. Implements the game loop's WorldEntity shape.

import * as THREE from 'three';

import type { Vec3 } from '../types';
import type { RapierPhysicsEngine } from './physics-engine';
import { biomeAt, terrainElevation, type Biome } from './terrain';

type AnimalType = 'penguin' | 'sheep' | 'boar' | 'goat' | 'scorpion';

interface AnimalConfig {
  biome: Biome;
  speed: number;
  /** Impulse magnitude (N·s) imparted to the car on contact. */
  knockStrength: number;
  build: () => THREE.Group;
}

interface Animal {
  type: AnimalType;
  biome: Biome;
  group: THREE.Group;
  speed: number;
  knockStrength: number;
  x: number;
  z: number;
  heading: number;
  wanderTimer: number;
  waddlePhase: number;
  active: boolean;
  knocked: { vx: number; vy: number; vz: number; y: number; spin: number } | null;
}

export interface AnimalManagerOptions {
  /** Animals per biome. Defaults to 4 (16 total across the four biomes). */
  perBiome?: number;
  spawnRadius?: number;
  despawnRadius?: number;
  knockRadius?: number;
  seed?: number;
}

const GRAVITY = 18;
const KNOCK_UP = 6;

// ---------------------------------------------------------------------------
// Low-poly animal builders (all face +Z, feet at y = 0)
// ---------------------------------------------------------------------------

function mat(color: number, rough = 0.7): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough });
}

function addLegs(g: THREE.Group, color: number, y: number, spreadX: number, spreadZ: number, h: number): void {
  const legGeo = new THREE.CylinderGeometry(0.07, 0.07, h, 6);
  const m = mat(color, 0.8);
  for (const sx of [-spreadX, spreadX]) {
    for (const sz of [-spreadZ, spreadZ]) {
      const leg = new THREE.Mesh(legGeo, m);
      leg.position.set(sx, y, sz);
      g.add(leg);
    }
  }
}

function buildPenguin(): THREE.Group {
  const g = new THREE.Group();
  const black = mat(0x191a1f);
  const white = mat(0xf2f3f5, 0.6);
  const orange = mat(0xff9a1f, 0.5);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), black);
  body.scale.set(0.95, 1.25, 0.9);
  body.position.y = 0.62;
  g.add(body);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), white);
  belly.scale.set(0.8, 1.15, 0.7);
  belly.position.set(0, 0.58, 0.18);
  g.add(belly);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), black);
  head.position.set(0, 1.2, 0.04);
  g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 8), orange);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 1.18, 0.32);
  g.add(beak);
  return g;
}

function buildSheep(): THREE.Group {
  const g = new THREE.Group();
  const wool = mat(0xeceae4, 0.95);
  const dark = mat(0x2c2c30, 0.7);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10), wool);
  body.scale.set(1.0, 0.9, 1.3);
  body.position.y = 0.85;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), dark);
  head.position.set(0, 0.95, 0.78);
  g.add(head);
  addLegs(g, 0x2c2c30, 0.3, 0.32, 0.5, 0.6);
  return g;
}

function buildBoar(): THREE.Group {
  const g = new THREE.Group();
  const hide = mat(0x4a3b2c, 0.85);
  const tusk = mat(0xe8e3d0, 0.5);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10), hide);
  body.scale.set(0.95, 0.85, 1.5);
  body.position.y = 0.7;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), hide);
  head.position.set(0, 0.68, 0.9);
  g.add(head);
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 8), hide);
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, 0.6, 1.2);
  g.add(snout);
  for (const sx of [-0.12, 0.12]) {
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 6), tusk);
    t.position.set(sx, 0.56, 1.22);
    t.rotation.x = -0.5;
    g.add(t);
  }
  addLegs(g, 0x3a2e22, 0.25, 0.3, 0.6, 0.5);
  return g;
}

function buildGoat(): THREE.Group {
  const g = new THREE.Group();
  const fur = mat(0xb9a07a, 0.85);
  const dark = mat(0x4b3f2c, 0.7);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), fur);
  body.scale.set(0.85, 0.85, 1.3);
  body.position.y = 0.8;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), fur);
  head.position.set(0, 0.95, 0.72);
  g.add(head);
  for (const sx of [-0.1, 0.1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.34, 6), dark);
    horn.position.set(sx, 1.16, 0.66);
    horn.rotation.x = 0.7;
    g.add(horn);
  }
  addLegs(g, 0x4b3f2c, 0.28, 0.28, 0.5, 0.56);
  return g;
}

function buildScorpion(): THREE.Group {
  const g = new THREE.Group();
  const shell = mat(0x5a3a1a, 0.8);
  const claw = mat(0x6b4422, 0.7);
  // Body: flat ellipsoid.
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), shell);
  body.scale.set(1.0, 0.5, 1.6);
  body.position.y = 0.22;
  g.add(body);
  // Tail (curved up: a chain of small spheres).
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), shell);
    seg.position.set(0, 0.2 + i * 0.16, -0.4 - i * 0.2);
    g.add(seg);
  }
  const stinger = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 6), claw);
  stinger.position.set(0, 0.84, -1.0);
  stinger.rotation.x = -0.8;
  g.add(stinger);
  // Claws.
  for (const sx of [-0.35, 0.35]) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), claw);
    c.scale.set(1.2, 0.6, 1.4);
    c.position.set(sx, 0.18, 0.5);
    g.add(c);
  }
  return g;
}

const ANIMAL_CONFIG: Record<AnimalType, AnimalConfig> = {
  penguin: { biome: 'snow', speed: 1.4, knockStrength: 1300, build: buildPenguin },
  sheep: { biome: 'grassland', speed: 1.1, knockStrength: 1700, build: buildSheep },
  boar: { biome: 'forest', speed: 1.8, knockStrength: 2600, build: buildBoar },
  goat: { biome: 'rocky', speed: 1.6, knockStrength: 1900, build: buildGoat },
  scorpion: { biome: 'desert', speed: 0.9, knockStrength: 900, build: buildScorpion },
};

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spawns and updates one wandering animal type per biome, each restricted to
 * its own biome, that shoves the car on contact.
 */
export class AnimalManager {
  private readonly physics: RapierPhysicsEngine;
  private readonly rng: () => number;
  private readonly spawnRadius: number;
  private readonly despawnRadius: number;
  private readonly knockRadius: number;
  private readonly animals: Animal[] = [];

  constructor(scene: THREE.Object3D, physics: RapierPhysicsEngine, options: AnimalManagerOptions = {}) {
    this.physics = physics;
    this.rng = makeRng(options.seed ?? 2024);
    this.spawnRadius = options.spawnRadius ?? 70;
    this.despawnRadius = options.despawnRadius ?? 130;
    this.knockRadius = options.knockRadius ?? 3.0;

    const perBiome = options.perBiome ?? 4;
    const types = Object.keys(ANIMAL_CONFIG) as AnimalType[];
    for (const type of types) {
      const cfg = ANIMAL_CONFIG[type];
      for (let i = 0; i < perBiome; i++) {
        const group = cfg.build();
        group.visible = false;
        scene.add(group);
        this.animals.push({
          type,
          biome: cfg.biome,
          group,
          speed: cfg.speed,
          knockStrength: cfg.knockStrength,
          x: 0,
          z: 0,
          heading: this.rng() * Math.PI * 2,
          wanderTimer: this.rng() * 2,
          waddlePhase: this.rng() * Math.PI * 2,
          active: false,
          knocked: null,
        });
      }
    }
  }

  /** Try to (re)place an animal in a patch of its biome near the player. */
  private respawn(a: Animal, carPos: Vec3): void {
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = this.rng() * Math.PI * 2;
      const dist = this.spawnRadius * (0.5 + this.rng() * 0.5);
      const x = carPos.x + Math.cos(angle) * dist;
      const z = carPos.z + Math.sin(angle) * dist;
      if (biomeAt(x, z) === a.biome) {
        a.x = x;
        a.z = z;
        a.heading = this.rng() * Math.PI * 2;
        a.knocked = null;
        a.active = true;
        a.group.visible = true;
        a.group.position.set(x, terrainElevation(x, z), z);
        a.group.rotation.set(0, a.heading, 0);
        return;
      }
    }
    // No patch of this biome nearby — stay hidden until the player gets closer.
    a.active = false;
    a.group.visible = false;
  }

  /** Advance all animals by `dt`, reacting to the car at `carPos`. */
  update(dt: number, carPos: Vec3): void {
    const step = Math.min(dt, 0.05);
    for (const a of this.animals) {
      if (!a.active) {
        this.respawn(a, carPos);
        continue;
      }
      if (a.knocked) {
        this.updateKnocked(a, step, carPos);
        continue;
      }

      const dx = a.x - carPos.x;
      const dz = a.z - carPos.z;
      const dist = Math.hypot(dx, dz);

      if (dist > this.despawnRadius) {
        this.respawn(a, carPos);
        continue;
      }

      // Hit by the car -> shove the car and launch the animal.
      if (dist < this.knockRadius) {
        const inv = dist > 1e-3 ? 1 / dist : 1;
        // Push the car away from the animal.
        this.physics.applyChassisImpulse({
          x: -dx * inv * a.knockStrength,
          y: a.knockStrength * 0.15,
          z: -dz * inv * a.knockStrength,
        });
        a.knocked = {
          vx: dx * inv * 9 + (this.rng() - 0.5) * 2,
          vz: dz * inv * 9 + (this.rng() - 0.5) * 2,
          vy: KNOCK_UP,
          y: a.group.position.y,
          spin: (this.rng() - 0.5) * 12,
        };
        continue;
      }

      // Wander; steer back if leaving its biome.
      a.wanderTimer -= step;
      if (a.wanderTimer <= 0) {
        a.heading += (this.rng() - 0.5) * 1.6;
        a.wanderTimer = 1.2 + this.rng() * 2.5;
      }
      const nx = a.x + Math.sin(a.heading) * a.speed * step;
      const nz = a.z + Math.cos(a.heading) * a.speed * step;
      if (biomeAt(nx, nz) !== a.biome) {
        a.heading += Math.PI; // turn back into its biome
      } else {
        a.x = nx;
        a.z = nz;
      }

      a.waddlePhase += step * (4 + a.speed);
      a.group.position.set(a.x, terrainElevation(a.x, a.z) + Math.abs(Math.sin(a.waddlePhase)) * 0.04, a.z);
      a.group.rotation.set(0, a.heading, Math.sin(a.waddlePhase) * 0.2);
    }
  }

  private updateKnocked(a: Animal, step: number, carPos: Vec3): void {
    const k = a.knocked;
    if (!k) return;
    a.x += k.vx * step;
    a.z += k.vz * step;
    k.vy -= GRAVITY * step;
    k.y += k.vy * step;
    const ground = terrainElevation(a.x, a.z);
    a.group.position.set(a.x, Math.max(k.y, ground), a.z);
    a.group.rotation.x += k.spin * step;
    a.group.rotation.z += k.spin * 0.5 * step;
    if (k.y <= ground && k.vy < 0) {
      this.respawn(a, carPos);
    }
  }
}
