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
import {
  CHUNK_SIZE,
  BIOME_FRICTION,
  biomeAt,
  buildChunkGeometry,
  terrainElevation,
  terrainSlopeDegrees,
  type Biome,
} from './terrain';

interface Chunk {
  group: THREE.Group;
  terrainBodyId: number;
  stoneIds: number[];
  instanced: THREE.InstancedMesh[];
  terrainGeo: THREE.BufferGeometry;
  terrainMat: THREE.Material;
}

export interface ChunkManagerOptions {
  /** Chunk view radius (in chunks) around the player. Defaults to 3. */
  viewRadius?: number;
}

// --- Shared decoration assets (created once; never disposed) ---------------

const TERRAIN_MAT = () =>
  new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });

function coloredGeo(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const n = posAttr.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

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

// Tree (trunk + conifer cone) merged with baked vertex colours.
const TREE_GEO = (() => {
  const trunk = new THREE.CylinderGeometry(0.18, 0.26, 2, 6);
  trunk.translate(0, 1, 0);
  coloredGeo(trunk, 0x6b4a2b);
  const cone = new THREE.ConeGeometry(1.5, 4.4, 7);
  cone.translate(0, 4.0, 0);
  coloredGeo(cone, 0x2f6b35);
  return BufferGeometryUtils.mergeGeometries([trunk, cone], false);
})();
const TREE_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });

// Snowy pine variant.
const SNOW_TREE_GEO = (() => {
  const trunk = new THREE.CylinderGeometry(0.18, 0.26, 2, 6);
  trunk.translate(0, 1, 0);
  coloredGeo(trunk, 0x5a4630);
  const cone = new THREE.ConeGeometry(1.5, 4.4, 7);
  cone.translate(0, 4.0, 0);
  coloredGeo(cone, 0xdfe8f0);
  return BufferGeometryUtils.mergeGeometries([trunk, cone], false);
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
  grassland: { grass: 220, trees: 4, rocks: 8, stones: 1 },
  forest: { grass: 120, trees: 28, rocks: 10, stones: 2 },
  rocky: { grass: 24, trees: 2, rocks: 44, stones: 5 },
  snow: { grass: 30, trees: 7, rocks: 16, stones: 2 },
};

export class ChunkManager {
  private readonly scene: THREE.Object3D;
  private readonly physics: RapierPhysicsEngine;
  private readonly viewRadius: number;
  private readonly chunks = new Map<string, Chunk>();

  constructor(scene: THREE.Object3D, physics: RapierPhysicsEngine, options: ChunkManagerOptions = {}) {
    this.scene = scene;
    this.physics = physics;
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
    this.decorate(group, cx, cz, centerX, centerZ, biome, instanced, stoneIds);

    this.scene.add(group);
    this.chunks.set(key, { group, terrainBodyId, stoneIds, instanced, terrainGeo: geometry, terrainMat });
  }

  private removeChunk(key: string, chunk: Chunk): void {
    this.scene.remove(chunk.group);
    this.physics.removeStaticBody(chunk.terrainBodyId);
    for (const id of chunk.stoneIds) this.physics.removeStaticBody(id);
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
  ): void {
    const rng = makeRng((cx * 73856093) ^ (cz * 19349663));
    const d = DENSITY[biome];
    const half = CHUNK_SIZE / 2;
    const rand = () => (rng() * 2 - 1) * half;

    const treeGeo = biome === 'snow' ? SNOW_TREE_GEO : TREE_GEO;

    this.scatter(group, instanced, GRASS_GEO, GRASS_MAT, d.grass, centerX, centerZ, rand, rng, {
      yawOnly: true,
      minScale: 0.6,
      maxScale: 1.5,
      maxSlope: 24,
    });
    this.scatter(group, instanced, treeGeo, TREE_MAT, d.trees, centerX, centerZ, rand, rng, {
      yawOnly: true,
      minScale: 0.8,
      maxScale: 1.6,
      maxSlope: 22,
    });
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
}
