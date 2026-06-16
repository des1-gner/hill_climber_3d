// Hazard pools — water and lava patches placed in terrain depressions.
//
// Water: semi-transparent blue reflective disc that slows the car (high drag).
// Lava: glowing orange/red emissive disc that damages the car over time.
//
// The ChunkManager places these per chunk; the game loop calls `update(dt,
// carPos)` each frame to apply effects.

import * as THREE from 'three';

import type { Vec3 } from '../types';
import { terrainElevation } from './terrain';

export interface Pool {
  mesh: THREE.Mesh;
  x: number;
  z: number;
  radius: number;
  type: 'water' | 'lava';
}

const WATER_MAT = new THREE.MeshStandardMaterial({
  color: 0x3388cc,
  metalness: 0.3,
  roughness: 0.1,
  transparent: true,
  opacity: 0.6,
  envMapIntensity: 2.0,
});

const LAVA_MAT = new THREE.MeshStandardMaterial({
  color: 0xff4400,
  emissive: 0xff2200,
  emissiveIntensity: 1.5,
  metalness: 0.0,
  roughness: 0.3,
});

const POOL_GEO = new THREE.CircleGeometry(1, 24);
POOL_GEO.rotateX(-Math.PI / 2); // flat on the ground

export class HazardPoolManager {
  private readonly pools: Pool[] = [];

  /** Whether the car is currently in water (for drag) or lava (for damage). */
  inWater = false;
  inLava = false;

  /**
   * Place a pool at (x, z) on the terrain surface. The mesh should be added to
   * the chunk group by the caller.
   */
  createPool(type: 'water' | 'lava', x: number, z: number, radius: number, parent: THREE.Object3D): Pool {
    const mat = type === 'water' ? WATER_MAT : LAVA_MAT;
    const mesh = new THREE.Mesh(POOL_GEO, mat);
    const y = terrainElevation(x, z) + 0.05; // just above terrain surface
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(radius);
    parent.add(mesh);
    const pool: Pool = { mesh, x, z, radius, type };
    this.pools.push(pool);
    return pool;
  }

  /** Remove pools whose meshes are in the given set (chunk teardown). */
  removePoolsIn(meshes: Set<THREE.Object3D>): void {
    for (let i = this.pools.length - 1; i >= 0; i--) {
      const p = this.pools[i];
      if (p && meshes.has(p.mesh)) {
        this.pools.splice(i, 1);
      }
    }
  }

  /** Check if the car is over any pool and set flags accordingly. */
  update(_dt: number, carPos: Vec3): void {
    this.inWater = false;
    this.inLava = false;
    for (const p of this.pools) {
      const dx = carPos.x - p.x;
      const dz = carPos.z - p.z;
      if (Math.hypot(dx, dz) < p.radius) {
        if (p.type === 'water') this.inWater = true;
        else this.inLava = true;
      }
    }
  }
}
