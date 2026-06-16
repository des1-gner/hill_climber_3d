// ChunkManager — streams the infinite world around the player.
//
// As the car moves, terrain chunks within a view radius are generated (mesh +
// trimesh collider + biome decorations + collidable stones) and distant chunks
// are torn down. Each chunk's content is chosen by its biome: grassland gets
// dense grass + the odd tree, forest gets thick trees, rocky gets boulders the
// car can bump, and snow gets sparse snowy pines + ice rocks.
//
// Implements the game loop's `WorldEntity` shape (update(dt, carPos)).

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { Vec3 } from '../types';
import type { RapierPhysicsEngine } from './physics-engine';
import type { FuelPickupManager } from './fuel-pickup';
import type { HazardPoolManager } from './hazard-pools';
import {
  CHUNK_SIZE,
  BIOME_FRICTION,
  biomeAt,
  buildChunkGeometry,
  terrainElevation,
  terrainSlopeDegrees,
  type Biome,
} from './terrain';

// Texture loader (shared) — textures loaded once on first use.
const textureLoader = new THREE.TextureLoader();
const leafTex = textureLoader.load('/textures/leaf.png');
leafTex.wrapS = leafTex.wrapT = THREE.ClampToEdgeWrapping;
const cactusTex = textureLoader.load('/textures/cactus.png');
cactusTex.wrapS = cactusTex.wrapT = THREE.RepeatWrapping;
cactusTex.repeat.set(2, 3);

// No per-biome ground texture — vertex colors handle all biome coloring and
// blend smoothly at transitions, eliminating hard chunk-boundary lines.

interface Chunk {
  group: THREE.Group;
  terrainBodyId: number;
  stoneIds: number[];
  /** Tree collider body ids + their visual meshes (for uprooting). */
  trees: Array<{ bodyId: number; mesh: THREE.Object3D; x: number; z: number; radius: number }>;
  instanced: THREE.InstancedMesh[];
  terrainGeo: THREE.BufferGeometry;
  terrainMat: THREE.Material;
}

export interface ChunkManagerOptions {
  viewRadius?: number;
  fuelPickups?: FuelPickupManager;
  hazardPools?: HazardPoolManager;
}

// --- Shared decoration assets (created once; never disposed) ---------------

const TERRAIN_MAT = () =>
  new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
  });

// Grass: multiple blade variants — tapered triangles instead of rectangles.
const GRASS_VARIANTS: THREE.BufferGeometry[] = [];
for (let v = 0; v < 4; v++) {
  const h = 0.35 + v * 0.18;
  const w = 0.05 + v * 0.015;
  // Use a tapered shape (triangle-ish) by creating a thin plane and tapering the top.
  const blade = new THREE.BufferGeometry();
  const verts = new Float32Array([
    -w, 0, 0,
    w, 0, 0,
    w * 0.2, h, 0,  // tapered top
    -w * 0.2, h, 0,
  ]);
  const indices = [0, 1, 2, 0, 2, 3];
  blade.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  blade.setIndex(indices);
  blade.computeVertexNormals();
  // Make a tuft of 3 crossed blades.
  const tuft: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const b = blade.clone();
    b.rotateY((i / 3) * Math.PI + v * 0.25);
    tuft.push(b);
  }
  GRASS_VARIANTS.push(BufferGeometryUtils.mergeGeometries(tuft, false));
}
// Multiple grass colors.
const GRASS_MATS = [
  new THREE.MeshStandardMaterial({ color: 0x4d9930, roughness: 1, side: THREE.DoubleSide }),
  new THREE.MeshStandardMaterial({ color: 0x5baa38, roughness: 1, side: THREE.DoubleSide }),
  new THREE.MeshStandardMaterial({ color: 0x6bbb40, roughness: 1, side: THREE.DoubleSide }),
  new THREE.MeshStandardMaterial({ color: 0x7bcc55, roughness: 1, side: THREE.DoubleSide }),
];

// --- Textured materials for vegetation ---
const LEAF_MAT = new THREE.MeshStandardMaterial({
  color: 0x3d8a2e,
  roughness: 0.75,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.88,
});
const SNOW_LEAF_MAT = new THREE.MeshStandardMaterial({
  color: 0xc8dce8,
  roughness: 0.75,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.88,
});
const CACTUS_MAT_TEX = new THREE.MeshStandardMaterial({ map: cactusTex, roughness: 0.8 });

// Trunk-only geometries — taller, so the canopy connects naturally.
const PINE_TRUNK_GEO = (() => {
  const g = new THREE.CylinderGeometry(0.15, 0.32, 5.0, 10);
  g.translate(0, 2.5, 0); // base at 0, top at 5
  return g;
})();
const OAK_TRUNK_GEO = (() => {
  const g = new THREE.CylinderGeometry(0.2, 0.38, 4.0, 10);
  g.translate(0, 2.0, 0); // base at 0, top at 4
  return g;
})();
const TRUNK_MAT = new THREE.MeshStandardMaterial({ color: 0x5c3e20, roughness: 0.9, metalness: 0 });

// Pine canopy: dense conical volume of randomly oriented circular leaf discs.
const PINE_CANOPY_GEO = (() => {
  const leaves: THREE.BufferGeometry[] = [];
  const baseY = 2.0;
  const height = 5.5;
  for (let i = 0; i < 320; i++) {
    const t = Math.random();
    const y = baseY + t * height;
    const maxR = (1 - t) * 2.8 + 0.3;
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * maxR;
    const lx = Math.cos(angle) * r;
    const lz = Math.sin(angle) * r;
    const size = 0.5 + Math.random() * 0.4;
    const leaf = new THREE.CircleGeometry(size, 6); // hexagonal disc — not square
    leaf.rotateX(Math.random() * Math.PI - Math.PI / 2);
    leaf.rotateY(Math.random() * Math.PI * 2);
    leaf.rotateZ(Math.random() * 0.5 - 0.25);
    leaf.translate(lx, y, lz);
    leaves.push(leaf);
  }
  return BufferGeometryUtils.mergeGeometries(leaves, false);
})();

// Oak canopy: dense spherical ball of circular leaf discs.
const OAK_CANOPY_GEO = (() => {
  const leaves: THREE.BufferGeometry[] = [];
  const centreY = 4.8;
  for (let i = 0; i < 600; i++) {
    let lx: number, ly: number, lz: number;
    do {
      lx = (Math.random() * 2 - 1) * 2.6;
      ly = (Math.random() * 2 - 1) * 1.8;
      lz = (Math.random() * 2 - 1) * 2.6;
    } while (lx * lx / 6.76 + ly * ly / 3.24 + lz * lz / 6.76 > 1);
    const size = 0.4 + Math.random() * 0.35;
    const leaf = new THREE.CircleGeometry(size, 6); // hexagonal disc
    leaf.rotateX(Math.random() * Math.PI);
    leaf.rotateY(Math.random() * Math.PI * 2);
    leaf.rotateZ(Math.random() * Math.PI * 0.5);
    leaf.translate(lx, centreY + ly, lz);
    leaves.push(leaf);
  }
  return BufferGeometryUtils.mergeGeometries(leaves, false);
})();

// Cactus: body + arms + spikes + a small flower on top.
const CACTUS_GEO = (() => {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry(0.38, 0.42, 4.2, 16, 8);
  body.translate(0, 2.1, 0);
  parts.push(body);
  const jointL = new THREE.SphereGeometry(0.26, 12, 8);
  jointL.translate(-0.42, 2.8, 0);
  parts.push(jointL);
  const armL = new THREE.CylinderGeometry(0.22, 0.24, 2.0, 12, 4);
  armL.rotateZ(0.7);
  armL.translate(-0.9, 3.5, 0);
  parts.push(armL);
  const jointR = new THREE.SphereGeometry(0.26, 12, 8);
  jointR.translate(0.42, 3.4, 0);
  parts.push(jointR);
  const armR = new THREE.CylinderGeometry(0.22, 0.24, 1.7, 12, 4);
  armR.rotateZ(-0.6);
  armR.translate(0.85, 4.0, 0);
  parts.push(armR);
  // Spikes: small cones sticking out radially from the main body.
  for (let i = 0; i < 24; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const y = 0.8 + (i % 6) * 0.6;
    const spike = new THREE.ConeGeometry(0.03, 0.25, 4);
    spike.rotateZ(-Math.PI / 2);
    spike.rotateY(angle);
    spike.translate(Math.cos(angle) * 0.44, y, Math.sin(angle) * 0.44);
    parts.push(spike);
  }
  // Small flower on top.
  const flower = new THREE.SphereGeometry(0.15, 8, 6);
  flower.translate(0, 4.4, 0);
  parts.push(flower);
  return BufferGeometryUtils.mergeGeometries(parts, false);
})();

// Flower geometry: a small stem + petals for biome decoration.
const FLOWER_GEO = (() => {
  const parts: THREE.BufferGeometry[] = [];
  const stem = new THREE.CylinderGeometry(0.02, 0.03, 0.4, 4);
  stem.translate(0, 0.2, 0);
  parts.push(stem);
  // 5 petals around a centre.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const petal = new THREE.SphereGeometry(0.08, 6, 4);
    petal.scale(1, 0.4, 1);
    petal.translate(Math.cos(a) * 0.12, 0.42, Math.sin(a) * 0.12);
    parts.push(petal);
  }
  // Centre.
  const centre = new THREE.SphereGeometry(0.06, 6, 4);
  centre.translate(0, 0.44, 0);
  parts.push(centre);
  return BufferGeometryUtils.mergeGeometries(parts, false);
})();
const FLOWER_COLORS = [0xff6688, 0xffdd44, 0xaa55ff, 0xff8833, 0x66ccff, 0xff4466, 0xffaa00, 0xcc77ff, 0xff5566, 0x88ddaa];
const FLOWER_MATS = FLOWER_COLORS.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }));

// Loose decorative rock + collidable stone share an icosahedron.
const ROCK_GEO = new THREE.IcosahedronGeometry(0.5, 1);
const ROCK_MAT = new THREE.MeshStandardMaterial({ color: 0x6d6f73, roughness: 0.9, metalness: 0.05, flatShading: true });
const STONE_GEO = new THREE.IcosahedronGeometry(1, 1);
const STONE_MAT = new THREE.MeshStandardMaterial({ color: 0x76787c, roughness: 0.85, metalness: 0.08, flatShading: true });

/** Seeded mulberry32 PRNG. */
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

/** Per-biome decoration densities (counts per chunk). */
const DENSITY: Record<Biome, { grass: number; trees: number; rocks: number; stones: number; flowers: number }> = {
  grassland: { grass: 8000, trees: 5, rocks: 8, stones: 1, flowers: 50 },
  forest: { grass: 6000, trees: 26, rocks: 10, stones: 2, flowers: 30 },
  desert: { grass: 50, trees: 3, rocks: 6, stones: 2, flowers: 12 },
  rocky: { grass: 800, trees: 2, rocks: 44, stones: 5, flowers: 8 },
  snow: { grass: 400, trees: 7, rocks: 16, stones: 2, flowers: 4 },
};

export class ChunkManager {
  private readonly scene: THREE.Object3D;
  private readonly physics: RapierPhysicsEngine;
  private readonly fuelPickups: FuelPickupManager | null;
  private readonly hazardPools: HazardPoolManager | null;
  private readonly viewRadius: number;
  private readonly chunks = new Map<string, Chunk>();

  constructor(scene: THREE.Object3D, physics: RapierPhysicsEngine, options: ChunkManagerOptions = {}) {
    this.scene = scene;
    this.physics = physics;
    this.fuelPickups = options.fuelPickups ?? null;
    this.hazardPools = options.hazardPools ?? null;
    this.viewRadius = options.viewRadius ?? 3;
  }

  /** WorldEntity hook: keep the world generated around the car. */
  update(_dt: number, carPos: Vec3): void {
    this.ensureAround(carPos);
  }

  /** Generate missing chunks within the view radius and remove distant ones. */
  ensureAround(pos: Vec3): void {
    const pcx = Math.round(pos.x / CHUNK_SIZE);
    const pcz = Math.round(pos.z / CHUNK_SIZE);
    const r = this.viewRadius;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const key = `${pcx + dx},${pcz + dz}`;
        if (!this.chunks.has(key)) {
          this.createChunk(pcx + dx, pcz + dz, key);
        }
      }
    }

    // Remove chunks beyond the radius (+1 hysteresis).
    for (const [key, chunk] of this.chunks) {
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      if (Math.abs(cx - pcx) > r + 1 || Math.abs(cz - pcz) > r + 1) {
        this.removeChunk(key, chunk);
      }
    }
  }

  private createChunk(cx: number, cz: number, key: string): void {
    const { geometry, colliderVertices, colliderIndices, centerX, centerZ } = buildChunkGeometry(cx, cz);
    const biome = biomeAt(centerX, centerZ);

    const group = new THREE.Group();
    group.name = `chunk_${key}`;

    const terrainMat = TERRAIN_MAT();
    const mesh = new THREE.Mesh(geometry, terrainMat);
    mesh.position.set(centerX, 0, centerZ);
    mesh.receiveShadow = true;
    group.add(mesh);

    const terrainBodyId = this.physics.addTerrainChunk(
      colliderVertices,
      colliderIndices,
      BIOME_FRICTION[biome],
    );

    const instanced: THREE.InstancedMesh[] = [];
    const stoneIds: number[] = [];
    const trees: Chunk['trees'] = [];
    this.decorate(group, cx, cz, centerX, centerZ, biome, instanced, stoneIds, trees);

    this.scene.add(group);
    this.chunks.set(key, { group, terrainBodyId, stoneIds, trees, instanced, terrainGeo: geometry, terrainMat });
  }

  private removeChunk(key: string, chunk: Chunk): void {
    this.scene.remove(chunk.group);
    this.physics.removeStaticBody(chunk.terrainBodyId);
    for (const id of chunk.stoneIds) this.physics.removeStaticBody(id);
    for (const t of chunk.trees) this.physics.removeStaticBody(t.bodyId);
    for (const im of chunk.instanced) im.dispose();
    chunk.terrainGeo.dispose();
    chunk.terrainMat.dispose();
    this.chunks.delete(key);
  }

  /** Populate a chunk with biome-appropriate decorations + collidable stones. */
  private decorate(
    group: THREE.Group,
    cx: number,
    cz: number,
    centerX: number,
    centerZ: number,
    biome: Biome,
    instanced: THREE.InstancedMesh[],
    stoneIds: number[],
    trees: Chunk['trees'],
  ): void {
    const rng = makeRng((cx * 73856093) ^ (cz * 19349663));
    const d = DENSITY[biome];
    const half = CHUNK_SIZE / 2;
    const rand = () => (rng() * 2 - 1) * half;

    // Grass: scatter multiple variants with different geo/material combos.
    const grassPerVariant = Math.ceil(d.grass / GRASS_VARIANTS.length);
    for (let v = 0; v < GRASS_VARIANTS.length; v++) {
      const geoV = GRASS_VARIANTS[v];
      const matV = GRASS_MATS[v % GRASS_MATS.length];
      if (!geoV || !matV) continue;
      this.scatter(group, instanced, geoV, matV, grassPerVariant, centerX, centerZ, rand, rng, {
        yawOnly: true,
        minScale: 0.5 + v * 0.15,
        maxScale: 1.2 + v * 0.2,
        maxSlope: 28,
      });
    }

    // Trees are placed individually (not instanced) so each can have its own
    // physics collider and be uprooted independently.
    if (biome === 'forest') {
      this.placeTrees(group, trees, PINE_TRUNK_GEO, PINE_CANOPY_GEO, LEAF_MAT, d.trees, centerX, centerZ, rand, rng);
    } else if (biome === 'snow') {
      this.placeTrees(group, trees, PINE_TRUNK_GEO, PINE_CANOPY_GEO, SNOW_LEAF_MAT, d.trees, centerX, centerZ, rand, rng);
    } else {
      this.placeTrees(group, trees, OAK_TRUNK_GEO, OAK_CANOPY_GEO, LEAF_MAT, d.trees, centerX, centerZ, rand, rng);
    }

    // Desert cacti (single-mesh, cactus texture — no separate canopy).
    if (biome === 'desert') {
      this.placeCacti(group, trees, 6, centerX, centerZ, rand, rng);
    }

    this.scatter(group, instanced, ROCK_GEO, ROCK_MAT, d.rocks, centerX, centerZ, rand, rng, {
      yawOnly: false,
      minScale: 0.4,
      maxScale: 1.4,
      maxSlope: 90,
      castShadow: true,
    });

    // Collidable stones: visual + static collider the car can bump.
    for (let i = 0; i < d.stones; i++) {
      const wx = centerX + rand();
      const wz = centerZ + rand();
      if (terrainSlopeDegrees(wx, wz) > 30) continue;
      const r = 1.1 + rng() * 1.6;
      const wy = terrainElevation(wx, wz) + r * 0.55;
      const stone = new THREE.Mesh(STONE_GEO, STONE_MAT);
      stone.position.set(wx, wy, wz);
      stone.scale.setScalar(r);
      stone.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
      stone.castShadow = true;
      group.add(stone);
      stoneIds.push(this.physics.addStaticBoulder({ x: wx, y: wy, z: wz }, r * 0.85));
    }

    // Flowers: spawn in patches (clustered around random centres).
    const flowerCount = d.flowers;
    if (flowerCount > 0) {
      const patchCentres = Math.ceil(flowerCount / 8);
      for (let p = 0; p < patchCentres; p++) {
        const pcx = centerX + rand();
        const pcz = centerZ + rand();
        if (terrainSlopeDegrees(pcx, pcz) > 20) continue;
        const flowersInPatch = 5 + Math.floor(rng() * 8);
        for (let f = 0; f < flowersInPatch; f++) {
          const fx = pcx + (rng() - 0.5) * 5;
          const fz = pcz + (rng() - 0.5) * 5;
          const mat = FLOWER_MATS[Math.floor(rng() * FLOWER_MATS.length)] ?? FLOWER_MATS[0]!;
          this.scatter(group, instanced, FLOWER_GEO, mat, 1, fx, fz, () => 0, rng, {
            yawOnly: true,
            minScale: 0.6,
            maxScale: 1.8,
            maxSlope: 90,
          });
        }
      }
    }

    // Fuel pickup: one per chunk (50% chance), placed on gentle ground.
    if (this.fuelPickups && rng() > 0.5) {
      const fx = centerX + rand();
      const fz = centerZ + rand();
      if (terrainSlopeDegrees(fx, fz) < 18) {
        const fy = terrainElevation(fx, fz);
        const canister = this.fuelPickups.createCanisterMesh();
        canister.position.set(fx, fy + 0.3, fz);
        group.add(canister);
        this.fuelPickups.addPickup(canister, fx, fz, fy);
      }
    }

    // Hazard pools: water in grassland/forest low areas, lava in rocky biome.
    if (this.hazardPools && rng() > 0.6) {
      const px = centerX + rand();
      const pz = centerZ + rand();
      if (terrainSlopeDegrees(px, pz) < 10) {
        const poolType = biome === 'rocky' ? 'lava' : (biome === 'grassland' || biome === 'forest') ? 'water' : null;
        if (poolType) {
          const radius = 4 + rng() * 8;
          this.hazardPools.createPool(poolType, px, pz, radius, group);
        }
      }
    }

    // Ramp: angled platform (30% chance per chunk on gentle ground).
    if (rng() > 0.7) {
      const rx = centerX + rand();
      const rz = centerZ + rand();
      if (terrainSlopeDegrees(rx, rz) < 15) {
        const ry = terrainElevation(rx, rz);
        const rampGeo = new THREE.BoxGeometry(3.5, 0.15, 5, 6, 2, 8);
        const rampMat = new THREE.MeshStandardMaterial({ color: 0xff8800, roughness: 0.7, metalness: 0.3 });
        const ramp = new THREE.Mesh(rampGeo, rampMat);
        ramp.position.set(rx, ry + 0.6, rz);
        ramp.rotation.x = -0.3; // angled upward
        ramp.rotation.y = rng() * Math.PI * 2;
        ramp.castShadow = true;
        ramp.receiveShadow = true;
        group.add(ramp);
        // Physics collider for the ramp.
        stoneIds.push(this.physics.addStaticBoulder({ x: rx, y: ry + 0.6, z: rz }, 2.0, 0.5));
      }
    }

    // Power boost pad (20% chance, gives a speed burst when driven over).
    if (rng() > 0.8) {
      const bx = centerX + rand();
      const bz = centerZ + rand();
      if (terrainSlopeDegrees(bx, bz) < 12) {
        const by = terrainElevation(bx, bz) + 0.05;
        const boostGeo = new THREE.CylinderGeometry(2.5, 2.5, 0.1, 16);
        const boostMat = new THREE.MeshStandardMaterial({
          color: 0x00ffaa, emissive: 0x00ff88, emissiveIntensity: 0.8,
          roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.7,
        });
        const boost = new THREE.Mesh(boostGeo, boostMat);
        boost.position.set(bx, by, bz);
        boost.name = 'boost_pad';
        group.add(boost);
      }
    }
  }

  /** Place `count` instances of a shared geo/mat across the chunk on the surface. */
  private scatter(
    group: THREE.Group,
    instanced: THREE.InstancedMesh[],
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    count: number,
    centerX: number,
    centerZ: number,
    rand: () => number,
    rng: () => number,
    opts: { yawOnly: boolean; minScale: number; maxScale: number; maxSlope: number; castShadow?: boolean },
  ): void {
    if (count <= 0) return;

    const placements: Array<{ x: number; y: number; z: number; s: number; rx: number; ry: number; rz: number }> = [];
    for (let i = 0; i < count; i++) {
      const wx = centerX + rand();
      const wz = centerZ + rand();
      if (terrainSlopeDegrees(wx, wz) > opts.maxSlope) continue;
      placements.push({
        x: wx,
        y: terrainElevation(wx, wz),
        z: wz,
        s: opts.minScale + rng() * (opts.maxScale - opts.minScale),
        rx: opts.yawOnly ? 0 : rng() * Math.PI,
        ry: rng() * Math.PI * 2,
        rz: opts.yawOnly ? 0 : rng() * Math.PI,
      });
    }
    if (placements.length === 0) return;

    const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
    if (opts.castShadow) mesh.castShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let i = 0; i < placements.length; i++) {
      const pl = placements[i];
      if (!pl) continue;
      e.set(pl.rx, pl.ry, pl.rz);
      q.setFromEuler(e);
      p.set(pl.x, pl.y, pl.z);
      s.setScalar(pl.s);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    instanced.push(mesh);
  }

  /** Place individual tree meshes (trunk + canopy groups) with physics colliders. */
  private placeTrees(
    group: THREE.Group,
    trees: Chunk['trees'],
    trunkGeo: THREE.BufferGeometry,
    canopyGeo: THREE.BufferGeometry,
    leafMat: THREE.Material,
    count: number,
    centerX: number,
    centerZ: number,
    rand: () => number,
    rng: () => number,
  ): void {
    for (let i = 0; i < count; i++) {
      const wx = centerX + rand();
      const wz = centerZ + rand();
      if (terrainSlopeDegrees(wx, wz) > 22) continue;
      const s = 0.8 + rng() * 0.9;
      const wy = terrainElevation(wx, wz);

      const treeGroup = new THREE.Group();
      treeGroup.position.set(wx, wy, wz);
      treeGroup.scale.setScalar(s);
      treeGroup.rotation.y = rng() * Math.PI * 2;

      // Visible brown trunk.
      const trunk = new THREE.Mesh(trunkGeo, TRUNK_MAT);
      trunk.castShadow = true;
      treeGroup.add(trunk);

      // Leaf canopy with alpha-tested texture.
      const canopy = new THREE.Mesh(canopyGeo, leafMat);
      canopy.castShadow = true;
      treeGroup.add(canopy);

      group.add(treeGroup);

      // Physics collider (static sphere at trunk height).
      const radius = 0.35 * s;
      const colliderY = wy + 1.8 * s;
      const bodyId = this.physics.addStaticBoulder(
        { x: wx, y: colliderY, z: wz },
        radius,
        0.7,
      );
      trees.push({ bodyId, mesh: treeGroup, x: wx, z: wz, radius });
    }
  }

  /** Place cacti as single-mesh collidable objects (desert biome). */
  private placeCacti(
    group: THREE.Group,
    trees: Chunk['trees'],
    count: number,
    centerX: number,
    centerZ: number,
    rand: () => number,
    rng: () => number,
  ): void {
    for (let i = 0; i < count; i++) {
      const wx = centerX + rand();
      const wz = centerZ + rand();
      if (terrainSlopeDegrees(wx, wz) > 22) continue;
      const s = 0.8 + rng() * 0.9;
      const wy = terrainElevation(wx, wz);
      const mesh = new THREE.Mesh(CACTUS_GEO, CACTUS_MAT_TEX);
      mesh.position.set(wx, wy, wz);
      mesh.scale.setScalar(s);
      mesh.rotation.y = rng() * Math.PI * 2;
      mesh.castShadow = true;
      group.add(mesh);
      const radius = 0.4 * s;
      const colliderY = wy + 2 * s;
      const bodyId = this.physics.addStaticBoulder({ x: wx, y: colliderY, z: wz }, radius, 0.7);
      trees.push({ bodyId, mesh, x: wx, z: wz, radius });
    }
  }

  /**
   * Find all trees within `dist` of a point.
   */
  getTreesNear(pos: Vec3, dist: number): Array<{ bodyId: number; mesh: THREE.Object3D; x: number; z: number; radius: number; chunkKey: string }> {
    const results: Array<{ bodyId: number; mesh: THREE.Object3D; x: number; z: number; radius: number; chunkKey: string }> = [];
    for (const [key, chunk] of this.chunks) {
      for (const t of chunk.trees) {
        const dx = t.x - pos.x;
        const dz = t.z - pos.z;
        if (Math.hypot(dx, dz) <= dist + t.radius) {
          results.push({ ...t, chunkKey: key });
        }
      }
    }
    return results;
  }

  /** Remove a tree (collider + visual) after it has been uprooted. */
  uprootTree(chunkKey: string, bodyId: number): void {
    const chunk = this.chunks.get(chunkKey);
    if (!chunk) return;
    const idx = chunk.trees.findIndex((t) => t.bodyId === bodyId);
    if (idx < 0) return;
    const tree = chunk.trees[idx];
    if (!tree) return;
    this.physics.removeStaticBody(tree.bodyId);
    chunk.group.remove(tree.mesh);
    chunk.trees.splice(idx, 1);
  }

  /** Check if there's a boost pad near `pos` (within 2.5m). */
  isOnBoostPad(pos: Vec3): boolean {
    for (const [, chunk] of this.chunks) {
      for (const child of chunk.group.children) {
        if (child.name === 'boost_pad') {
          const dx = pos.x - child.position.x;
          const dz = pos.z - child.position.z;
          if (Math.hypot(dx, dz) < 2.5) return true;
        }
      }
    }
    return false;
  }
}
