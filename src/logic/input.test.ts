import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveInput } from './input';
import { CONTROL_STEER_LIMIT } from '../constants';

// Property-based tests for the pure input resolution used by the
// Input_Controller. Each property runs >= 100 iterations via fast-check.

const NUM_RUNS = 100;

// A channel arbitrary that deliberately includes out-of-range AND non-finite
// values (NaN, +/-Infinity) so the property exercises the defensive coercion
// and clamping paths. noNaN is left at its default (false) and infinities are
// allowed by adding them explicitly.
const rawChannel = fc.oneof(
  // wide finite range covering in-range and out-of-range values
  fc.double({ min: -1000, max: 1000 }),
  // explicit non-finite cases
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

describe('resolveInput', () => {
  // Feature: 3d-car-hill-climb, Property 8: Input resolution is bounded, proportional, and arbitrated
  // Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6, 5.7
  it('is bounded, passes in-range values through, clamps out-of-range, and arbitrates brake over throttle', () => {
    fc.assert(
      fc.property(rawChannel, rawChannel, rawChannel, (throttle, brake, steer) => {
        const cmd = resolveInput({ throttle, brake, steer });

        // The resolved command must always be finite (no NaN/Infinity leaks).
        expect(Number.isFinite(cmd.throttle)).toBe(true);
        expect(Number.isFinite(cmd.brake)).toBe(true);
        expect(Number.isFinite(cmd.steerDeg)).toBe(true);

        // Req 5.1 / 5.2 / 5.7: throttle and brake are bounded within [0, 1].
        expect(cmd.throttle).toBeGreaterThanOrEqual(0);
        expect(cmd.throttle).toBeLessThanOrEqual(1);
        expect(cmd.brake).toBeGreaterThanOrEqual(0);
        expect(cmd.brake).toBeLessThanOrEqual(1);

        // Req 5.3 / 5.7: steering is bounded within [-35, 35].
        expect(cmd.steerDeg).toBeGreaterThanOrEqual(-CONTROL_STEER_LIMIT);
        expect(cmd.steerDeg).toBeLessThanOrEqual(CONTROL_STEER_LIMIT);

        // Compute the expected per-channel clamped values, treating non-finite
        // inputs as the safe default (0) before clamping (Req 5.7).
        const safe = (v: number) => (Number.isFinite(v) ? v : 0);
        const expectedBrake = Math.min(1, Math.max(0, safe(brake)));
        const expectedSteer = Math.min(
          CONTROL_STEER_LIMIT,
          Math.max(-CONTROL_STEER_LIMIT, safe(steer)),
        );
        const clampedThrottle = Math.min(1, Math.max(0, safe(throttle)));

        // Req 5.2 / 5.7: brake clamps independently and is never suppressed.
        expect(cmd.brake + 0).toBe(expectedBrake + 0);

        // Req 5.3 / 5.7: steering clamps independently; in-range passes through.
        expect(cmd.steerDeg + 0).toBe(expectedSteer + 0);

        // Req 5.6: brake-over-throttle arbitration. When both the clamped
        // throttle and brake are positive, throttle is suppressed to 0;
        // otherwise the clamped throttle passes through (Req 5.1 / 5.7).
        if (clampedThrottle > 0 && expectedBrake > 0) {
          expect(cmd.throttle).toBe(0);
        } else {
          // Normalize the harmless -0/+0 distinction (clamp can yield -0 while
          // Math.max normalizes to +0); both are numerically equal to 0.
          expect(cmd.throttle + 0).toBe(clampedThrottle + 0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 8: Input resolution is bounded, proportional, and arbitrated
  // Validates: Requirements 5.1, 5.4
  it('resolves to the neutral (0, 0, 0) command when no input is active', () => {
    expect(resolveInput({ throttle: 0, brake: 0, steer: 0 })).toEqual({
      throttle: 0,
      brake: 0,
      steerDeg: 0,
    });
  });

  // Feature: 3d-car-hill-climb, Property 8: Input resolution is bounded, proportional, and arbitrated
  // Validates: Requirements 5.1, 5.2
  it('maps proportional in-range throttle/brake through unchanged (0 -> 0, 1 -> max)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (magnitude) => {
          // Throttle alone (no brake) passes through proportionally.
          expect(resolveInput({ throttle: magnitude, brake: 0, steer: 0 }).throttle).toBe(
            magnitude,
          );
          // Brake alone passes through proportionally.
          expect(resolveInput({ throttle: 0, brake: magnitude, steer: 0 }).brake).toBe(
            magnitude,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
