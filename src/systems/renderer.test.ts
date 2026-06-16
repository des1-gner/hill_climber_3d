// Feature: 3d-car-hill-climb, Property 4: Wheel transforms are independent of the chassis
//
// Property-based test for the Renderer's wheel/chassis scene-graph behavior
// (src/systems/renderer.ts).
//
// Property 4: Wheel transforms are independent of the chassis.
// Validates: Requirements 2.5
//
// *For any* sequence of wheel spin / steering / suspension transforms applied
// to the wheel meshes (driven via `renderFrame` across a sequence of
// `InterpolatedState` values with varying linearSpeed, steering, and
// suspension compression), the chassis mesh's orientation and position remain
// determined SOLELY by the (interpolated) chassis transform. Applying wheel
// spin/steer/suspension never moves the chassis mesh away from the interpolated
// chassis transform.
//
// Testing approach (option (a) from the task notes):
//   The Renderer constructor builds a THREE.WebGLRenderer which needs a real
//   WebGL context not available under the `node` test env. We partial-mock the
//   `three` module, replacing ONLY `WebGLRenderer` with a no-op stub. All real
//   THREE math (Vector3, Quaternion, slerp, lerp) is preserved, so the chassis
//   interpolation we assert against is computed by the genuine library.

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

// Partial mock: keep all of THREE, swap out the GPU-bound WebGLRenderer for a
// no-op that satisfies the surface the Renderer touches.
vi.mock('three', async (importActual) => {
  const actual = await importActual<typeof import('three')>();
  class MockWebGLRenderer {
    outputColorSpace = '';
    shadowMap = { type: 0, enabled: false, map: null as unknown };
    constructor(_params?: unknown) {}
    setSize(): void {}
    setPixelRatio(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: MockWebGLRenderer };
});

import * as THREE from 'three';
import { Renderer } from './renderer';
import type {
  InterpolatedState,
  Quat,
  Vec3,
  VehicleConfig,
  VehicleMeshes,
  VehicleState,
  WheelConfig,
  WheelState,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** A stub canvas adequate for the (mocked) renderer in a node env. */
function makeCanvas(): HTMLCanvasElement {
  return {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
  } as unknown as HTMLCanvasElement;
}

/** Fresh chassis + 4 wheel meshes for a renderer to mount. */
function makeMeshes(): VehicleMeshes {
  const chassis = new THREE.Object3D();
  chassis.name = 'chassis';
  const wheels = [0, 1, 2, 3].map((i) => {
    const w = new THREE.Object3D();
    w.name = `wheel_${i}`;
    return w;
  }) as [THREE.Object3D, THREE.Object3D, THREE.Object3D, THREE.Object3D];
  return { chassis, wheels };
}

function defaultWheelState(index: 0 | 1 | 2 | 3): WheelState {
  return {
    index,
    inContact: true,
    suspensionLength: 0.5,
    suspensionCompression: 0,
    contactNormal: { x: 0, y: 1, z: 0 },
    steerDeg: 0,
    normalForce: 0,
    tractionLimit: 0,
    appliedDriveForce: 0,
    slipRatio: 0,
  };
}

/** Per-frame wheel kinematics inputs (the things being varied). */
interface WheelParams {
  suspensionCompression: number;
  steerDeg: number;
}

function makeVehicleState(
  position: Vec3,
  quaternion: Quat,
  linearSpeed: number,
  wheelParams: WheelParams[],
): VehicleState {
  const wheels = ([0, 1, 2, 3] as const).map((i) => {
    const ws = defaultWheelState(i);
    const p = wheelParams[i];
    if (p) {
      ws.suspensionCompression = p.suspensionCompression;
      ws.steerDeg = p.steerDeg;
    }
    return ws;
  });
  return {
    chassisPosition: position,
    chassisQuaternion: quaternion,
    linearSpeed,
    horizontalSpeed: Math.abs(linearSpeed),
    pitchDeg: 0,
    rollDeg: 0,
    wheels,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const fcFinite = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

const arbVec3: fc.Arbitrary<Vec3> = fc.record({
  x: fcFinite(-100, 100),
  y: fcFinite(-100, 100),
  z: fcFinite(-100, 100),
});

/** A genuine unit quaternion built from a random axis + angle. */
const arbQuat: fc.Arbitrary<Quat> = fc
  .record({
    ax: fcFinite(-1, 1),
    ay: fcFinite(-1, 1),
    az: fcFinite(-1, 1),
    angle: fcFinite(-Math.PI, Math.PI),
  })
  .map(({ ax, ay, az, angle }) => {
    const axis = new THREE.Vector3(ax, ay, az);
    if (axis.lengthSq() < 1e-9) axis.set(0, 1, 0);
    axis.normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  });

const arbWheelParams: fc.Arbitrary<WheelParams> = fc.record({
  suspensionCompression: fcFinite(0, 0.3),
  // Deliberately exceed the steering range to exercise clamping too.
  steerDeg: fcFinite(-90, 90),
});

const arbWheelParamsQuad: fc.Arbitrary<WheelParams[]> = fc.tuple(
  arbWheelParams,
  arbWheelParams,
  arbWheelParams,
  arbWheelParams,
);

/**
 * One render frame: a shared chassis transform plus TWO independent sets of
 * wheel kinematics (A and B) and two linear speeds. The chassis transform is
 * identical for both passes; only the wheel transforms differ.
 */
const arbFrame = fc.record({
  alpha: fcFinite(0, 1),
  prevPos: arbVec3,
  currPos: arbVec3,
  prevQuat: arbQuat,
  currQuat: arbQuat,
  // Pass A wheel inputs.
  linearSpeedPrevA: fcFinite(-60, 60),
  linearSpeedCurrA: fcFinite(-60, 60),
  wheelsPrevA: arbWheelParamsQuad,
  wheelsCurrA: arbWheelParamsQuad,
  steerCmdA: fcFinite(-90, 90),
  // Pass B wheel inputs (intentionally different space).
  linearSpeedPrevB: fcFinite(-60, 60),
  linearSpeedCurrB: fcFinite(-60, 60),
  wheelsPrevB: arbWheelParamsQuad,
  wheelsCurrB: arbWheelParamsQuad,
  steerCmdB: fcFinite(-90, 90),
});

// ---------------------------------------------------------------------------
// Expected chassis transform (computed independently of any wheel state)
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function expectedChassisPosition(prev: Vec3, curr: Vec3, alpha: number): THREE.Vector3 {
  const a = clamp01(alpha);
  return new THREE.Vector3(
    prev.x + (curr.x - prev.x) * a,
    prev.y + (curr.y - prev.y) * a,
    prev.z + (curr.z - prev.z) * a,
  );
}

function expectedChassisQuaternion(prev: Quat, curr: Quat, alpha: number): THREE.Quaternion {
  const a = clamp01(alpha);
  const p = new THREE.Quaternion(prev.x, prev.y, prev.z, prev.w);
  const c = new THREE.Quaternion(curr.x, curr.y, curr.z, curr.w);
  return new THREE.Quaternion().slerpQuaternions(p, c, a);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Renderer wheel/chassis independence (Property 4)', () => {
  it('chassis pose is determined solely by the chassis transform, regardless of wheel transforms', () => {
    fc.assert(
      fc.property(fc.array(arbFrame, { minLength: 1, maxLength: 8 }), (frames) => {
        // Two independent renderers fed the SAME chassis transforms but
        // DIFFERENT wheel kinematics each frame.
        const meshesA = makeMeshes();
        const meshesB = makeMeshes();
        const rendererA = new Renderer(makeCanvas(), VEHICLE_CONFIG);
        const rendererB = new Renderer(makeCanvas(), VEHICLE_CONFIG);
        rendererA.mount(meshesA, new THREE.Object3D());
        rendererB.mount(meshesB, new THREE.Object3D());

        try {
          // Wheels must be SIBLINGS of the chassis (Req 2.5): same parent, and
          // that parent is not the chassis itself.
          for (const meshes of [meshesA, meshesB]) {
            const chassisParent = meshes.chassis.parent;
            expect(chassisParent).not.toBeNull();
            expect(chassisParent?.name).toBe('vehicleGroup');
            for (const wheel of meshes.wheels) {
              expect(wheel.parent).toBe(chassisParent);
              expect(wheel.parent).not.toBe(meshes.chassis);
            }
          }

          for (const f of frames) {
            const interpA: InterpolatedState = {
              alpha: f.alpha,
              prev: makeVehicleState(f.prevPos, f.prevQuat, f.linearSpeedPrevA, f.wheelsPrevA),
              curr: makeVehicleState(f.currPos, f.currQuat, f.linearSpeedCurrA, f.wheelsCurrA),
              command: { throttle: 0, brake: 0, steerDeg: f.steerCmdA },
            };
            const interpB: InterpolatedState = {
              alpha: f.alpha,
              prev: makeVehicleState(f.prevPos, f.prevQuat, f.linearSpeedPrevB, f.wheelsPrevB),
              curr: makeVehicleState(f.currPos, f.currQuat, f.linearSpeedCurrB, f.wheelsCurrB),
              command: { throttle: 0, brake: 0, steerDeg: f.steerCmdB },
            };

            rendererA.renderFrame(interpA);
            rendererB.renderFrame(interpB);

            const expPos = expectedChassisPosition(f.prevPos, f.currPos, f.alpha);
            const expQuat = expectedChassisQuaternion(f.prevQuat, f.currQuat, f.alpha);

            const EPS = 1e-9;

            // (1) Chassis pose equals the interpolated chassis transform for
            //     BOTH passes — i.e. it is unaffected by the wheel transforms.
            for (const chassis of [meshesA.chassis, meshesB.chassis]) {
              expect(chassis.position.x).toBeCloseTo(expPos.x, 9);
              expect(chassis.position.y).toBeCloseTo(expPos.y, 9);
              expect(chassis.position.z).toBeCloseTo(expPos.z, 9);

              // Quaternion may differ by overall sign (q and -q are the same
              // rotation); compare via dot-product magnitude ~ 1.
              const q = chassis.quaternion;
              const dot = Math.abs(q.x * expQuat.x + q.y * expQuat.y + q.z * expQuat.z + q.w * expQuat.w);
              expect(dot).toBeGreaterThan(1 - 1e-7);
            }

            // (2) The two passes (different wheels) yield IDENTICAL chassis
            //     pose — direct evidence of wheel independence.
            expect(meshesA.chassis.position.x).toBeCloseTo(meshesB.chassis.position.x, 12);
            expect(meshesA.chassis.position.y).toBeCloseTo(meshesB.chassis.position.y, 12);
            expect(meshesA.chassis.position.z).toBeCloseTo(meshesB.chassis.position.z, 12);
            expect(Math.abs(meshesA.chassis.quaternion.x - meshesB.chassis.quaternion.x)).toBeLessThanOrEqual(EPS);
            expect(Math.abs(meshesA.chassis.quaternion.y - meshesB.chassis.quaternion.y)).toBeLessThanOrEqual(EPS);
            expect(Math.abs(meshesA.chassis.quaternion.z - meshesB.chassis.quaternion.z)).toBeLessThanOrEqual(EPS);
            expect(Math.abs(meshesA.chassis.quaternion.w - meshesB.chassis.quaternion.w)).toBeLessThanOrEqual(EPS);
          }
        } finally {
          rendererA.dispose();
          rendererB.dispose();
        }
      }),
      { numRuns: 200 },
    );
  });
});
