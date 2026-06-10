// Integration tests: RapierPhysicsEngine against procedurally generated terrain.
//
// Unlike the pure-logic unit/property tests, these exercise the REAL Rapier
// WASM raycast-vehicle controller (src/systems/physics-engine.ts) driving over
// a real trimesh collider built from generateProceduralTerrain()
// (src/systems/terrain.ts). They require the Rapier WASM runtime;
// @dimforge/rapier3d-compat bundles the module so it instantiates under Node.
//
// These are heavier/slower than the unit tests (they step the simulation for
// hundreds of fixed-timestep frames), so they live in their own file and use a
// generous per-test timeout.
//
// Requirements covered:
// - 4.4 Per-frame wheel/terrain collision detection (all four wheels report
//       contact while resting on the surface).
// - 4.5 At-rest penetration bound (vehicle settles stably and rests on the
//       surface without tunnelling through the terrain).
// - 6.1 Traction coherence (throttle accelerates the vehicle from rest, and the
//       per-wheel applied drive force never exceeds the available traction
//       limit while in contact).

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { RapierPhysicsEngine } from './physics-engine';
import { generateProceduralTerrain, terrainElevation, terrainSlopeDegrees } from './terrain';
import { FIXED_DT, REST_PENETRATION_MAX } from '../constants';
import type { DriveCommand, TerrainModel, VehicleConfig, WheelConfig } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A neutral command: no throttle, no brake, wheels straight. */
const NEUTRAL: DriveCommand = { throttle: 0, brake: 0, steerDeg: 0 };

/** Full throttle, straight ahead. */
const FULL_THROTTLE: DriveCommand = { throttle: 1, brake: 0, steerDeg: 0 };

function makeWheelConfig(index: 0 | 1 | 2 | 3, isSteered: boolean): WheelConfig {
  return {
    index,
    connectionPointLocal: {
      x: index % 2 === 0 ? -0.8 : 0.8,
      y: -0.3,
      z: index < 2 ? 1.3 : -1.3,
    },
    suspensionRestLength: 0.5,
    suspensionStiffness: 30,
    suspensionDamping: 4,
    maxSuspensionTravel: 0.3,
    radius: 0.4,
    isSteered,
    isDriven: true, // AWD: all four wheels driven
    frictionSlip: 1.0,
  };
}

const VEHICLE_CONFIG: VehicleConfig = {
  chassisMass: 1200,
  chassisHalfExtents: { x: 1, y: 0.5, z: 2 },
  maxEngineForce: 8000,
  maxBrakeForce: 6000,
  driveLayout: 'awd',
  // Front wheels (index 0, 1) steer; rear (2, 3) do not.
  wheels: [
    makeWheelConfig(0, true),
    makeWheelConfig(1, true),
    makeWheelConfig(2, false),
    makeWheelConfig(3, false),
  ],
};

// A smaller terrain grid than the production default keeps trimesh-collider
// construction and the WASM raycasts cheap while preserving the same continuous
// elevation field as the runtime/exported terrain.
function makeTerrain(): TerrainModel {
  return generateProceduralTerrain({ size: 320, segments: 200 });
}

/**
 * Scan the lower mountain for the flattest spot, so a brakeless vehicle settles
 * and rests rather than sliding down a grade. The mountain is a real climb with
 * few perfectly level areas, so we pick the minimum-slope sample on a coarse
 * grid over the base band of the course.
 */
function findStableBasin(): { x: number; z: number } {
  let best = { x: 0, z: 0 };
  let bestSlope = Infinity;
  for (let x = -120; x <= 120; x += 4) {
    for (let z = -120; z <= 120; z += 4) {
      const slope = terrainSlopeDegrees(x, z);
      if (slope < bestSlope) {
        bestSlope = slope;
        best = { x, z };
      }
    }
  }
  return best;
}

/**
 * Build and initialise an engine over fresh terrain, spawn the chassis just
 * above a stable terrain basin, and step the simulation until the vehicle
 * settles. Returns the live engine (caller disposes) plus the spawn (x, z).
 */
async function setupSettledVehicle(settleSteps = 360): Promise<{
  engine: RapierPhysicsEngine;
  spawn: { x: number; z: number };
}> {
  const engine = new RapierPhysicsEngine(VEHICLE_CONFIG);
  const terrain = makeTerrain();
  await engine.init(VEHICLE_CONFIG.wheels, terrain);

  // Spawn just above the basin surface so the vehicle drops a short distance
  // and settles with all wheels resting on the terrain.
  const spawn = findStableBasin();
  const spawnY = terrainElevation(spawn.x, spawn.z) + 1.15;
  engine.reset({ x: spawn.x, y: spawnY, z: spawn.z });

  for (let i = 0; i < settleSteps; i += 1) {
    engine.applyCommand(NEUTRAL, false);
    engine.step(FIXED_DT);
  }

  return { engine, spawn };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('RapierPhysicsEngine + procedural terrain (integration)', () => {
  it(
    'Regression: spawning at the origin surface height does not fall through the terrain',
    async () => {
      // Reproduces the reported "spawn and instantly fall through the world"
      // bug: the bootstrap previously spawned the chassis at a fixed y=2, which
      // is BELOW the terrain surface at the origin (~4.87 m), so the body
      // started under the one-sided trimesh collider and tunnelled through.
      // The fix computes the spawn height from the terrain surface.
      const engine = new RapierPhysicsEngine(VEHICLE_CONFIG);
      await engine.init(VEHICLE_CONFIG.wheels, makeTerrain());

      // Same spawn the bootstrap now uses: terrain surface at (0,0) + clearance.
      const surfaceY = terrainElevation(0, 0);
      const spawnY = surfaceY + 1.8;
      engine.reset({ x: 0, y: spawnY, z: 0 });

      try {
        for (let i = 0; i < 360; i += 1) {
          engine.applyCommand(NEUTRAL, false);
          engine.step(FIXED_DT);
        }

        const state = engine.readState();

        // The chassis must remain finite and resting near the surface — NOT
        // plummeting away below the terrain (the fall-through symptom).
        expect(Number.isFinite(state.chassisPosition.y)).toBe(true);
        const surfaceUnderCar = terrainElevation(
          state.chassisPosition.x,
          state.chassisPosition.z,
        );
        // Resting on top of the surface (allowing for chassis half-height and a
        // little suspension compression), and never far below it.
        expect(state.chassisPosition.y).toBeGreaterThan(surfaceUnderCar - 0.5);
        expect(state.chassisPosition.y).toBeLessThan(surfaceUnderCar + 3);

        // Collision is actually engaged: at least one wheel touches the ground.
        expect(state.wheels.some((w) => w.inContact)).toBe(true);
      } finally {
        engine.dispose();
      }
    },
    60_000,
  );

  it(
    'Req 4.4: all four wheels report terrain contact while resting on the surface',
    async () => {
      const { engine } = await setupSettledVehicle();
      try {
        const state = engine.readState();

        expect(state.wheels).toHaveLength(4);
        for (const wheel of state.wheels) {
          expect(
            wheel.inContact,
            `wheel ${wheel.index} should be in contact with the terrain at rest`,
          ).toBe(true);
        }
      } finally {
        engine.dispose();
      }
    },
    60_000,
  );

  it(
    'Req 4.5: vehicle settles stably and rests on the surface without penetrating the terrain',
    async () => {
      const { engine } = await setupSettledVehicle();
      try {
        const before = engine.readState();

        // Continue stepping with no throttle/brake; a settled vehicle should
        // barely move (low residual speed) and hold a stable height.
        for (let i = 0; i < 60; i += 1) {
          engine.applyCommand(NEUTRAL, false);
          engine.step(FIXED_DT);
        }
        const after = engine.readState();

        // Settled: small residual horizontal speed and a near-constant height.
        expect(after.horizontalSpeed).toBeLessThan(0.5);
        const heightDrift = Math.abs(after.chassisPosition.y - before.chassisPosition.y);
        expect(heightDrift).toBeLessThan(0.05);

        // At-rest penetration (Req 4.5): Rapier's raycast-vehicle controller
        // does not expose a direct per-wheel penetration-depth reading, so we
        // assert the equivalent observable condition documented in the task:
        // the chassis rests ON TOP of the local terrain surface rather than
        // tunnelling through it. The chassis centre must stay above the terrain
        // elevation sampled at its (x, z) by at least its lower half-extent —
        // i.e. the body has not sunk into / passed through the ground.
        const surfaceY = terrainElevation(
          after.chassisPosition.x,
          after.chassisPosition.z,
        );
        const clearance = after.chassisPosition.y - surfaceY;
        expect(
          clearance,
          'chassis should rest above the terrain surface (no tunnelling/penetration)',
        ).toBeGreaterThan(VEHICLE_CONFIG.chassisHalfExtents.y - REST_PENETRATION_MAX);

        // Every wheel that is in contact should sit on the surface, not below
        // it: derive the wheel-bottom world position from the chassis transform
        // and the reported suspension length, and confirm it is not buried more
        // than the discretised-mesh tolerance below the sampled surface.
        const quat = new THREE.Quaternion(
          after.chassisQuaternion.x,
          after.chassisQuaternion.y,
          after.chassisQuaternion.z,
          after.chassisQuaternion.w,
        );
        const chassisPos = new THREE.Vector3(
          after.chassisPosition.x,
          after.chassisPosition.y,
          after.chassisPosition.z,
        );
        const down = new THREE.Vector3(0, -1, 0).applyQuaternion(quat);

        // Allowance for the trimesh collider being a piecewise-linear sample of
        // the smooth elevation field (the sampler curves between grid points).
        const MESH_DISCRETISATION_TOLERANCE = 0.25;

        for (const wheel of after.wheels) {
          if (!wheel.inContact) {
            continue;
          }
          const cfg = VEHICLE_CONFIG.wheels[wheel.index];
          if (!cfg) continue;
          const connection = new THREE.Vector3(
            cfg.connectionPointLocal.x,
            cfg.connectionPointLocal.y,
            cfg.connectionPointLocal.z,
          ).applyQuaternion(quat);
          const wheelCenter = chassisPos
            .clone()
            .add(connection)
            .add(down.clone().multiplyScalar(wheel.suspensionLength));
          const wheelBottom = wheelCenter.add(down.clone().multiplyScalar(cfg.radius));

          const groundAtWheel = terrainElevation(wheelBottom.x, wheelBottom.z);
          const penetration = groundAtWheel - wheelBottom.y;
          expect(
            penetration,
            `wheel ${wheel.index} should not be buried below the terrain surface`,
          ).toBeLessThan(MESH_DISCRETISATION_TOLERANCE);
        }
      } finally {
        engine.dispose();
      }
    },
    60_000,
  );

  it(
    'Req 6.1: throttle accelerates the vehicle and drive force never exceeds the traction limit',
    async () => {
      const { engine } = await setupSettledVehicle();
      try {
        const atRest = engine.readState();
        expect(atRest.horizontalSpeed).toBeLessThan(0.5);

        const FORCE_EPSILON = 1e-3;
        let sawDrivenContact = false;

        // Apply full throttle for a few simulated seconds.
        for (let i = 0; i < 180; i += 1) {
          engine.applyCommand(FULL_THROTTLE, false);
          engine.step(FIXED_DT);

          const s = engine.readState();
          for (const wheel of s.wheels) {
            const cfg = VEHICLE_CONFIG.wheels[wheel.index];
            if (!cfg || !cfg.isDriven || !wheel.inContact) {
              continue;
            }
            sawDrivenContact = true;
            // Req 6.1/6.2: transmitted (applied) drive force is capped at the
            // traction limit = frictionSlip * normalForce for every step.
            expect(
              Math.abs(wheel.appliedDriveForce),
              `wheel ${wheel.index} applied drive force must not exceed its traction limit`,
            ).toBeLessThanOrEqual(wheel.tractionLimit + FORCE_EPSILON);
          }
        }

        const driving = engine.readState();

        // The vehicle accelerated from (near) rest under throttle.
        expect(
          driving.horizontalSpeed,
          'vehicle should accelerate from rest under throttle',
        ).toBeGreaterThan(atRest.horizontalSpeed + 0.5);

        // Sanity: at least one driven wheel was actually in contact and
        // transmitting force during the drive (otherwise the cap assertion
        // above would be vacuous).
        expect(sawDrivenContact).toBe(true);
      } finally {
        engine.dispose();
      }
    },
    60_000,
  );
});
