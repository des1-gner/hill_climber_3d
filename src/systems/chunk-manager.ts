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
  /** Chunk view radius (in chunks) around the player. Defaults to 3. */
  viewRadius?: number;
  /** Optional fuel pickup manager to place pickups per chunk. */
  fuelPickups?: FuelPickupManager;
}

// --- Shared decoration assets (created once; never disposed) ---------------

const TERRAIN_MAT = () =>
  new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });

// Grass tuft (three crossed blades), green.
const GRASS_GEO = (() => {
  const blade = new THREE.PlaneGeometry(0.4, 0.6, 1, 1);
  blade.translate(0, 0.3, 0);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const b = blade.clone();
    b.rotateY((i / 3) * Math.PI);
    parts.push(b);
  }
  blade.dispose();
  return BufferGeometryUtils.mergeGeometries(parts, false);
})();
const GRASS_MAT = new THREE.MeshStandardMaterial({ color: 0x5b8f3a, roughness: 1, side: THREE.DoubleSide });

// --- Textured materials for vegetation ---
const LEAF_MAT = new THREE.MeshStandardMaterial({
  map: leafTex, alphaMap: leafTex, transparent: true, alphaTest: 0.4,
  side: THREE.DoubleSide, roughness: 0.8, color: 0x55aa44,
});
const SNOW_LEAF_MAT = new THREE.MeshStandardMaterial({
  map: leafTex, alphaMap: leafTex, transparent: true, alphaTest: 0.4,
  side: THREE.DoubleSide, roughness: 0.8, color: 0xd8e8f0,
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

// Pine canopy: dense conical shell of leaf planes. 5× density so there are no
// visible gaps — the canopy reads as a solid mass of foliage.
const PINE_CANOPY_GEO = (() => {
  const leaves: THREE.BufferGeometry[] = [];
  for (let tier = 0; tier < 8; tier++) {
    const y = 2.2 + tier * 0.7;
    const r = 2.6 - tier * 0.28;
    const count = 24 - tier * 2;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + tier * 0.37;
      const jitter = 0.6 + Math.sin(a * 5 + tier * 2.1) * 0.4;
      const lx = Math.cos(a) * r * jitter;
      const lz = Math.sin(a) * r * jitter;
      const leaf = new THREE.PlaneGeometry(1.3, 1.3);
      leaf.rotateY(a + (i % 3) * 0.4);
      leaf.rotateX(-0.25 + tier * 0.06);
      leaf.rotateZ((Math.sin(a * 7) - 0.5) * 0.3);
      leaf.translate(lx, y + (Math.random() - 0.5) * 0.3, lz);
      leaves.push(leaf);
    }
  }
  return BufferGeometryUtils.mergeGeometries(leaves, false);
})();

// Oak canopy: very dense spherical ball — 400 overlapping leaf planes so there
// are no gaps and you can barely see the trunk through the foliage.
const OAK_CANOPY_GEO = (() => {
  const leaves: THREE.BufferGeometry[] = [];
  const centreY = 4.6;
  for (let i = 0; i < 400; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const r = 0.4 + Math.random() * 2.2;
    const lx = r * Math.sin(phi) * Math.cos(theta);
    const ly = centreY + r * Math.cos(phi) * 0.7;
    const lz = r * Math.sin(phi) * Math.sin(theta);
    const size = 0.7 + Math.random() * 0.5;
    const leaf = new THREE.PlaneGeometry(size, size);
    leaf.rotateY(Math.random() * Math.PI);
    leaf.rotateX(Math.random() * Math.PI * 0.7);
    leaf.translate(lx, ly, lz);
    leaves.push(leaf);
  }
  return BufferGeometryUtils.mergeGeometries(leaves, false);
})();

// Cactus: smooth connected body + arms with sphere joints (no gaps).
const CACTUS_GEO = (() => {
  const body = new THREE.CylinderGeometry(0.38, 0.42, 4.2, 16, 8);
  body.translate(0, 2.1, 0);
  const jointL = new THREE.SphereGeometry(0.26, 12, 8);
  jointL.translate(-0.42, 2.8, 0);
  const armL = new THREE.CylinderGeometry(0.22, 0.24, 2.0, 12, 4);
  armL.rotateZ(0.7);
  armL.translate(-0.9, 3.5, 0);
  const jointR = new THREE.SphereGeometry(0.26, 12, 8);
  jointR.translate(0.42, 3.4, 0);
  const armR = new THREE.CylinderGeometry(0.22, 0.24, 1.7, 12, 4);
  armR.rotateZ(-0.6);
  armR.translate(0.85, 4.0, 0);
  return BufferGeometryUtils.mergeGeometries([body, jointL, armL, jointR, armR], false);
})();

// Loose decorative rock + collidable stone share an icosahedron.
const ROCK_GEO = new THREE.IcosahedronGeometry(0.5, 1);
const ROCK_MAT = new THREE.MeshStandardMaterial({ color: 0x6d6f73, roughness: 0.9, metalness: 0.05 });
const STONE_GEO = new THREE.IcosahedronGeometry(1, 1);
const STONE_MAT = new THREE.MeshStandardMaterial({ color: 0x76787c, roughness: 0.85, metalness: 0.08 });

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
const DENSITY: Record<Biome, { grass: number; trees: number; rocks: number; stones: number }> = {
  grassland: { grass: 220, trees: 5, rocks: 8, stones: 1 },
  forest: { grass: 120, trees: 26, rocks: 10, stones: 2 },
  desert: { grass: 14, trees: 3, rocks: 6, stones: 2 },
  rocky: { grass: 24, trees: 2, rocks: 44, stones: 5 },
  snow: { grass: 30, trees: 7, rocks: 16, stones: 2 },
};

export class ChunkManager {
  private readonly scene: THREE.Object3D;
  private readonly physics: RapierPhysicsEngine;
  private readonly fuelPickups: FuelPickupManager | null;
  private readonly viewRadius: number;
  private readonly chunks = new Map<string, Chunk>();

  constructor(scene: THREE.Object3D, physics: RapierPhysicsEngine, options: ChunkManagerOptions = {}) {
    this.scene = scene;
    this.physics = physics;
    this.fuelPickups = options.fuelPickups ?? null;
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

    this.scatter(group, instanced, GRASS_GEO, GRASS_MAT, d.grass, centerX, centerZ, rand, rng, {
      yawOnly: true,
      minScale: 0.6,
      maxScale: 1.5,
      maxSlope: 24,
    });

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

    // Fuel pickup: one per chunk (50% chance), placed on gentle ground.
    if (this.fuelPickups && rng() > 0.5) {
      const fx = centerX + rand();
      const fz = centerZ + rand();
      if (terrainSlopeDegrees(fx, fz) < 18) {
        const fy = terrainElevation(fx, fz);
        const canister = this.fuelPickups.createCanisterMesh();
        canister.position.set(fx, fy + 1.2, fz);
        group.add(canister);
        this.fuelPickups.addPickup(canister, fx, fz, fy);
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
}
