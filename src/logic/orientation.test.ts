import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { pitchRollFromQuaternion } from './orientation';

// Feature: 3d-car-hill-climb, Property 14: Pitch and roll extraction round-trips
//
// The implementation uses a Y-up intrinsic Tait-Bryan YXZ convention:
//   q = qYaw(Y) * qPitch(X) * qRoll(Z)
// pitch about X, roll about Z, yaw about Y (not returned). Extracted pitch/roll
// are independent of yaw. We construct the test quaternion with THREE.Euler
// using order 'YXZ' (which yields the same YXZ composition) and pass the raw
// {x,y,z,w} components to pitchRollFromQuaternion.
//
// Validates: Requirements 8.1

const DEG_TO_RAD = Math.PI / 180;

describe('pitchRollFromQuaternion (Property 14: round-trips)', () => {
  it('recovers original pitch and roll within tolerance, independent of yaw, always finite', () => {
    fc.assert(
      fc.property(
        // pitch strictly inside (-90, +90) to avoid gimbal lock
        fc.double({ min: -89, max: 89, noNaN: true }),
        // roll within (-180, 180]
        fc.double({ min: -179.999, max: 180, noNaN: true }),
        // arbitrary yaw to confirm yaw-independence
        fc.double({ min: -180, max: 180, noNaN: true }),
        (pitchDeg, rollDeg, yawDeg) => {
          const euler = new THREE.Euler(
            pitchDeg * DEG_TO_RAD, // X (pitch)
            yawDeg * DEG_TO_RAD, // Y (yaw)
            rollDeg * DEG_TO_RAD, // Z (roll)
            'YXZ',
          );
          const q = new THREE.Quaternion().setFromEuler(euler);

          const { pitchDeg: outPitch, rollDeg: outRoll } = pitchRollFromQuaternion({
            x: q.x,
            y: q.y,
            z: q.z,
            w: q.w,
          });

          // Extracted values must always be finite.
          expect(Number.isFinite(outPitch)).toBe(true);
          expect(Number.isFinite(outRoll)).toBe(true);

          // Round-trip recovery within numerical tolerance.
          const TOL = 1e-6;
          expect(Math.abs(outPitch - pitchDeg)).toBeLessThanOrEqual(TOL);

          // Roll wraps on the circle: 180 and -180 are equivalent. Compare the
          // smallest signed angular difference.
          let rollDiff = outRoll - rollDeg;
          rollDiff = ((rollDiff + 180) % 360 + 360) % 360 - 180;
          expect(Math.abs(rollDiff)).toBeLessThanOrEqual(TOL);
        },
      ),
      { numRuns: 200 },
    );
  });
});
