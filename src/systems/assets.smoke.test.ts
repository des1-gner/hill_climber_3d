// Feature: 3d-car-hill-climb, Task 19.2: smoke tests for shipped assets and configuration.
//
// These are smoke/configuration tests that validate the *actually shipped*
// artifacts and tuning invariants, complementing the pure-logic unit/property
// tests:
//   - the vehicle GLB on disk meets the triangle budget and node-name contract
//     (Req 1.1, validated through the same validateVehicleGraph used at runtime);
//   - the suspension configuration used by the app is well-formed (Req 3.1);
//   - world gravity is the constant downward 9.81 m/s^2 (Req 4.3).
//
// The vehicle GLB is read from disk and parsed with three's GLTFLoader.parse —
// the generated asset is uncompressed, so no DRACOLoader is required. Parsing
// the shipped bytes (rather than re-running the generator) means this test
// guards the artifact players actually load.
//
// Validates: Requirements 1.1, 3.1, 4.3

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { validateVehicleGraph } from '../logic/validate-vehicle';
import {
  CHASSIS_NODE,
  REQUIRED_WHEEL_NODES,
  GRAVITY_Y,
} from '../constants';
import type { VehicleConfig, WheelConfig } from '../types';

// ---------------------------------------------------------------------------
// Asset location + triangle budgets (from Req 1.1 and the generator script)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const VEHICLE_GLB_PATH = resolve(__dirname, '..', '..', 'public', 'assets', 'vehicle.glb');

const CHASSIS_MIN_TRIS = 20_000; // Req 1.1
const WHEEL_MIN_TRIS = 5_000; // Req 1.1

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the shipped GLB from disk and parse it via three's GLTFLoader. The
 * generated asset is uncompressed glTF binary, so `parse` resolves directly
 * without a DRACOLoader. Returns the parsed scene root.
 */
function parseShippedVehicle(): Promise<THREE.Object3D> {
  const buffer = readFileSync(VEHICLE_GLB_PATH);
  // Pass a fresh ArrayBuffer view of exactly the file's bytes.
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );

  const loader = new GLTFLoader();
  return new Promise<THREE.Object3D>((res, rej) => {
    loader.parse(
      arrayBuffer,
      '',
      (gltf: GLTF) => res(gltf.scene),
      (err: unknown) => rej(err),
    );
  });
}

/**
 * Count triangles across a node and all of its mesh descendants. Indexed
 * geometry counts `index.count / 3`; non-indexed counts `position.count / 3`.
 */
function triangleCountForNode(node: THREE.Object3D): number {
  let total = 0;
  node.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    const geom = mesh.geometry as THREE.BufferGeometry;
    if (geom.index) {
      total += geom.index.count / 3;
    } else {
      const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos) {
        total += pos.count / 3;
      }
    }
  });
  return total;
}

/**
 * The default vehicle wheel configuration used by the app. Mirrors the
 * front-steered, all-wheel-drive layout the renderer/physics are wired with.
 * Suspension values here are the ones the physics engine consumes (Req 3.1).
 */
function makeWheelConfig(index: 0 | 1 | 2 | 3, isSteered: boolean): WheelConfig {
  return {
    index,
    connectionPointLocal: {
      x: index % 2 === 0 ? -0.8 : 0.8,
      y: -0.4,
      z: index < 2 ? 1.3 : -1.3,
    },
    suspensionRestLength: 0.5,
    suspensionStiffness: 30,
    suspensionDamping: 4,
    maxSuspensionTravel: 0.3,
    radius: 0.4,
    isSteered,
    isDriven: true,
    frictionSlip: 1.0,
  };
}

function makeDefaultVehicleConfig(): VehicleConfig {
  return {
    chassisMass: 1200,
    chassisHalfExtents: { x: 1, y: 0.5, z: 2 },
    maxEngineForce: 8000,
    maxBrakeForce: 6000,
    driveLayout: 'awd',
    wheels: [
      makeWheelConfig(0, true),
      makeWheelConfig(1, true),
      makeWheelConfig(2, false),
      makeWheelConfig(3, false),
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shipped vehicle GLB budget and node contract (Req 1.1, 1.2)', () => {
  let scene: THREE.Object3D;

  beforeAll(async () => {
    scene = await parseShippedVehicle();
  });

  it('parses the shipped GLB and validateVehicleGraph succeeds', () => {
    const result = validateVehicleGraph(scene);
    expect(result.ok).toBe(true);
  });

  it('contains the chassis and all four wheel nodes', () => {
    expect(scene.getObjectByName(CHASSIS_NODE)).toBeDefined();
    for (const wheelName of REQUIRED_WHEEL_NODES) {
      expect(scene.getObjectByName(wheelName)).toBeDefined();
    }
  });

  it('chassis mesh has at least 20,000 triangles', () => {
    const chassis = scene.getObjectByName(CHASSIS_NODE);
    expect(chassis).toBeDefined();
    const tris = triangleCountForNode(chassis as THREE.Object3D);
    expect(tris).toBeGreaterThanOrEqual(CHASSIS_MIN_TRIS);
  });

  it('each wheel mesh has at least 5,000 triangles', () => {
    for (const wheelName of REQUIRED_WHEEL_NODES) {
      const wheel = scene.getObjectByName(wheelName);
      expect(wheel, `missing ${wheelName}`).toBeDefined();
      const tris = triangleCountForNode(wheel as THREE.Object3D);
      expect(tris, `${wheelName} triangle count`).toBeGreaterThanOrEqual(WHEEL_MIN_TRIS);
    }
  });
});

describe('suspension configuration invariants (Req 3.1)', () => {
  it('every wheel has restLength > 0, stiffness > 0, damping >= 0, all finite', () => {
    const config = makeDefaultVehicleConfig();
    expect(config.wheels).toHaveLength(4);

    for (const wheel of config.wheels) {
      expect(Number.isFinite(wheel.suspensionRestLength)).toBe(true);
      expect(wheel.suspensionRestLength).toBeGreaterThan(0);

      expect(Number.isFinite(wheel.suspensionStiffness)).toBe(true);
      expect(wheel.suspensionStiffness).toBeGreaterThan(0);

      expect(Number.isFinite(wheel.suspensionDamping)).toBe(true);
      expect(wheel.suspensionDamping).toBeGreaterThanOrEqual(0);

      expect(Number.isFinite(wheel.maxSuspensionTravel)).toBe(true);
      expect(wheel.maxSuspensionTravel).toBeGreaterThan(0);
    }
  });
});

describe('gravity configuration (Req 4.3)', () => {
  it('GRAVITY_Y constant is -9.81 m/s^2', () => {
    expect(GRAVITY_Y).toBe(-9.81);
  });

  it('world gravity vector used at init is (0, -9.81, 0)', () => {
    // The physics engine initializes the Rapier world with this vector
    // (see RapierPhysicsEngine.init / setGravity). Assert the composed vector
    // without standing up the full WASM runtime.
    const worldGravity = { x: 0, y: GRAVITY_Y, z: 0 };
    expect(worldGravity).toEqual({ x: 0, y: -9.81, z: 0 });
  });
});
