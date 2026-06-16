// Tree ragdoll — when a tree is uprooted, its actual mesh is reparented to the
// scene root and animated with simple ballistic + tumble physics (not a Rapier
// body, just kinematic integration) so it visibly topples and falls rather than
// vanishing or turning into a rock.
//
// The game loop calls `update(dt)` each frame to advance all active ragdolls.
// After a ragdoll has come to rest on the ground (or fallen far enough), it is
// faded out and removed.

import * as THREE from 'three';

import type { Vec3 } from '../types';
import { terrainElevation } from './terrain';

interface FallingTree {
  mesh: THREE.Object3D;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Angular velocity (radians/s) around each axis. */
  wx: number;
  wy: number;
  wz: number;
  /** Accumulated rotation. */
  rx: number;
  ry: number;
  rz: number;
  /** Seconds since the tree was uprooted. */
  age: number;
  /** Whether the tree has landed (stops moving, fades out). */
  landed: boolean;
}

const GRAVITY = 12;

export class TreeRagdollManager {
  private readonly scene: THREE.Object3D;
  private readonly active: FallingTree[] = [];

  constructor(scene: THREE.Object3D) {
    this.scene = scene;
  }

  /**
   * Launch a tree mesh as a ragdoll. The mesh is reparented from its chunk
   * group to the scene root so it persists after the chunk is torn down.
   *
   * @param mesh the tree's THREE.Group (trunk + canopy)
   * @param launchVel initial velocity (away from the car)
   */
  launch(mesh: THREE.Object3D, _pos: Vec3, launchVel: Vec3): void {
    // Reparent to scene root at its current world position.
    const worldPos = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);
    mesh.removeFromParent();
    mesh.position.copy(worldPos);
    this.scene.add(mesh);

    this.active.push({
      mesh,
      x: worldPos.x,
      y: worldPos.y,
      z: worldPos.z,
      vx: launchVel.x,
      vy: launchVel.y + 3,
      vz: launchVel.z,
      wx: (Math.random() - 0.5) * 4,
      wy: (Math.random() - 0.5) * 2,
      wz: (Math.random() - 0.5) * 4,
      rx: mesh.rotation.x,
      ry: mesh.rotation.y,
      rz: mesh.rotation.z,
      age: 0,
      landed: false,
    });
  }

  /** Advance all active ragdolls. */
  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    for (let i = this.active.length - 1; i >= 0; i--) {
      const t = this.active[i];
      if (!t) continue;

      t.age += step;

      if (!t.landed) {
        // Ballistic motion.
        t.vy -= GRAVITY * step;
        t.x += t.vx * step;
        t.y += t.vy * step;
        t.z += t.vz * step;

        // Tumble.
        t.rx += t.wx * step;
        t.ry += t.wy * step;
        t.rz += t.wz * step;

        // Ground check.
        const ground = terrainElevation(t.x, t.z);
        if (t.y <= ground && t.vy < 0) {
          t.y = ground;
          t.vy = 0;
          t.vx *= 0.3;
          t.vz *= 0.3;
          t.wx *= 0.2;
          t.wy *= 0.1;
          t.wz *= 0.2;
          t.landed = true;
        }
      }

      t.mesh.position.set(t.x, t.y, t.z);
      t.mesh.rotation.set(t.rx, t.ry, t.rz);

      // Never remove — fallen trees remain in the world permanently.
      // Only stop simulating once landed and settled.
      if (t.landed && t.age > 2) {
        // Stop physics updates but keep the mesh in place.
        t.wx = 0; t.wy = 0; t.wz = 0;
        t.vx = 0; t.vz = 0;
      }
    }
  }
}
