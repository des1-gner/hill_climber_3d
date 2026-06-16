// Fuel pickups — collectible fuel canisters scattered around the world.
//
// The chunk manager places fuel pickups as part of its per-chunk decoration.
// This system tracks active pickups, animates them (hover + spin), and detects
// when the car drives over one to collect it. Collected pickups restore fuel
// and are removed until the chunk is regenerated.
//
// Implements the game loop's WorldEntity shape (update(dt, carPos)).

import * as THREE from 'three';

import type { Vec3 } from '../types';

export interface FuelPickupEntry {
  mesh: THREE.Object3D;
  x: number;
  z: number;
  baseY: number;
  phase: number;
  collected: boolean;
}

export interface FuelPickupManagerOptions {
  /** Horizontal distance (m) within which a pickup is collected. Defaults to 4. */
  collectRadius?: number;
  /** Fuel units restored per pickup. Defaults to 25. */
  fuelPerPickup?: number;
}

/** Build the shared fuel canister mesh (reused via clone). */
function buildCanisterTemplate(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 1.2, 16, 4),
    new THREE.MeshStandardMaterial({ color: 0xff3333, metalness: 0.4, roughness: 0.5 }),
  );
  body.position.y = 0.6;
  g.add(body);
  // Handle on top.
  const handle = new THREE.Mesh(
    new THREE.TorusGeometry(0.28, 0.07, 8, 12),
    new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.6, roughness: 0.4 }),
  );
  handle.position.y = 1.3;
  handle.rotation.x = Math.PI / 2;
  g.add(handle);
  // Yellow fuel label stripe.
  const stripe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52, 0.52, 0.25, 16, 1),
    new THREE.MeshStandardMaterial({ color: 0xffd700, emissive: 0x665500, emissiveIntensity: 0.5, roughness: 0.4 }),
  );
  stripe.position.y = 0.6;
  g.add(stripe);

  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.castShadow = true;
  });
  return g;
}

const CANISTER_TEMPLATE = buildCanisterTemplate();

/**
 * Manages fuel pickups: places them, animates hover/spin, detects collection.
 *
 * The game loop calls `update(dt, carPos)` each frame. When a pickup is
 * collected, `lastCollectedFuel` is set (consumed by the loop to add fuel).
 */
export class FuelPickupManager {
  private readonly pickups: FuelPickupEntry[] = [];
  private readonly collectRadius: number;
  readonly fuelPerPickup: number;

  /** Fuel collected this frame (read + reset by the game loop each tick). */
  lastCollectedFuel = 0;

  constructor(options: FuelPickupManagerOptions = {}) {
    this.collectRadius = options.collectRadius ?? 4;
    this.fuelPerPickup = options.fuelPerPickup ?? 25;
  }

  /**
   * Register a pickup placed by the chunk manager. The mesh should already be
   * added to the scene graph.
   */
  addPickup(mesh: THREE.Object3D, x: number, z: number, baseY: number): FuelPickupEntry {
    const entry: FuelPickupEntry = { mesh, x, z, baseY, phase: Math.random() * Math.PI * 2, collected: false };
    this.pickups.push(entry);
    return entry;
  }

  /** Remove all pickups that belong to a chunk being torn down. */
  removePickupsIn(meshes: Set<THREE.Object3D>): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (p && meshes.has(p.mesh)) {
        this.pickups.splice(i, 1);
      }
    }
  }

  /** Create a clone of the canister template (add it to the scene yourself). */
  createCanisterMesh(): THREE.Group {
    return CANISTER_TEMPLATE.clone();
  }

  /** WorldEntity hook: animate and detect collection. */
  update(dt: number, carPos: Vec3): void {
    this.lastCollectedFuel = 0;
    for (const p of this.pickups) {
      if (p.collected) continue;
      // Hover + spin.
      p.phase += dt * 2.5;
      p.mesh.position.y = p.baseY + 0.4 + Math.sin(p.phase) * 0.15;
      p.mesh.rotation.y += dt * 2;

      // Collection check.
      const dx = carPos.x - p.x;
      const dz = carPos.z - p.z;
      if (Math.hypot(dx, dz) < this.collectRadius) {
        p.collected = true;
        p.mesh.visible = false;
        this.lastCollectedFuel += this.fuelPerPickup;
      }
    }
  }
}
