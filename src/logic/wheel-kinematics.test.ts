import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { wheelSpinDelta, clampVisualSteer } from './wheel-kinematics';
import { VISUAL_STEER_LIMIT } from '../constants';

// Property-based tests for the pure wheel kinematics used by the Renderer's
// wheel synchronization. Each property runs >= 100 iterations via fast-check.

const NUM_RUNS = 200;

describe('wheelSpinDelta', () => {
  // Feature: 3d-car-hill-climb, Property 2: Wheel spin tracks ground speed and direction
  // Validates: Requirements 2.1, 2.2, 2.6
  it('equals (s/r)*dt, sign tracks ground speed, and is 0 when s == 0', () => {
    fc.assert(
      fc.property(
        // signed ground speed (forward positive, reverse negative)
        fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
        // wheel radius strictly > 0
        fc.double({ min: 1e-3, max: 5, noNaN: true, noDefaultInfinity: true }),
        // frame duration >= 0
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (s, r, dt) => {
          const delta = wheelSpinDelta(s, r, dt);
          const expected = (s / r) * dt;

          // Req 2.1: equals (s / r) * dt within numerical tolerance.
          const tolerance = 1e-9 + Math.abs(expected) * 1e-9;
          expect(Math.abs(delta - expected)).toBeLessThanOrEqual(tolerance);

          // Req 2.2 / 2.6: delta never has the opposite sign of the ground
          // speed. (r > 0 and dt >= 0, so the scale factor is non-negative.)
          // With extreme denormal magnitudes the product can underflow to zero;
          // that is physically negligible and acceptable — only an inverted
          // sign would be a bug.
          expect(delta === 0 || Math.sign(delta) === Math.sign(s)).toBe(true);

          // Req 2.6: delta is exactly 0 when ground speed is 0.
          // (Use sign-agnostic zero: -0 and +0 are both valid "no rotation".)
          if (s === 0) {
            expect(Math.abs(delta)).toBe(0);
          }

          // Req 2.2: reverse motion spins opposite to forward motion of equal magnitude.
          if (dt > 0) {
            const forward = wheelSpinDelta(Math.abs(s), r, dt);
            const reverse = wheelSpinDelta(-Math.abs(s), r, dt);
            expect(reverse).toBeCloseTo(-forward, 9);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 2: Wheel spin tracks ground speed and direction
  // Validates: Requirements 2.6
  it('is exactly 0 for any non-positive radius (guard) regardless of speed', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -5, max: 0, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (s, r, dt) => {
          expect(wheelSpinDelta(s, r, dt)).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('clampVisualSteer', () => {
  // Feature: 3d-car-hill-climb, Property 3: Visual steering angle is clamped to [-45, 45]
  // Validates: Requirements 2.3, 2.4
  it('returns a value within [-45, 45], unchanged when in range, nearest bound when out of range', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
        (commandedDeg) => {
          const result = clampVisualSteer(commandedDeg);

          // Req 2.3 / 2.4: result always within the visual steering range.
          expect(result).toBeGreaterThanOrEqual(-VISUAL_STEER_LIMIT);
          expect(result).toBeLessThanOrEqual(VISUAL_STEER_LIMIT);

          if (commandedDeg > VISUAL_STEER_LIMIT) {
            // Req 2.4: above range clamps to the upper bound.
            expect(result).toBe(VISUAL_STEER_LIMIT);
          } else if (commandedDeg < -VISUAL_STEER_LIMIT) {
            // Req 2.4: below range clamps to the lower bound.
            expect(result).toBe(-VISUAL_STEER_LIMIT);
          } else {
            // Req 2.3: in-range input passes through unchanged.
            expect(result).toBe(commandedDeg);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
