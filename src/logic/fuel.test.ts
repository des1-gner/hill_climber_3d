import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { depleteFuel, isThrottleSuppressed } from './fuel';
import { FUEL_BURN_RATE } from '../constants';

// Property-based tests for the pure fuel-accounting core.
//
// These tests exercise the universal properties from the design's Correctness
// Properties section (Properties 11 and 12) across many generated inputs.

const NUM_RUNS = 200;

describe('fuel logic — property-based', () => {
  // Feature: 3d-car-hill-climb, Property 11: Fuel depletes proportionally and never goes negative
  // Validates: Requirements 7.2, 7.3
  it('depletes fuel by FUEL_BURN_RATE * throttle * dt before clamping, never below 0', () => {
    fc.assert(
      fc.property(
        // Current fuel: any finite non-negative level (well beyond the 0..100 range too).
        fc.double({ min: 0, max: 1000, noNaN: true }),
        // Throttle constrained to its valid input space [0, 1].
        fc.double({ min: 0, max: 1, noNaN: true }),
        // Elapsed simulation time: any non-negative duration.
        fc.double({ min: 0, max: 100, noNaN: true }),
        (fuel, throttle, dt) => {
          const result = depleteFuel(fuel, throttle, dt);

          // Always non-negative (Req 7.3).
          expect(result).toBeGreaterThanOrEqual(0);

          // Reduces by FUEL_BURN_RATE * throttle * dt before clamping (Req 7.2).
          const burned = FUEL_BURN_RATE * throttle * dt;
          const expected = Math.max(0, fuel - burned);
          expect(result).toBeCloseTo(expected, 9);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 11: Fuel depletes proportionally and never goes negative
  // Validates: Requirements 7.2, 7.3
  it('leaves fuel unchanged when throttle is 0 or dt is 0', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (fuel, throttle, dt) => {
          expect(depleteFuel(fuel, 0, dt)).toBe(fuel);
          expect(depleteFuel(fuel, throttle, 0)).toBe(fuel);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 12: Empty fuel suppresses throttle force
  // Validates: Requirements 7.4
  it('suppresses throttle drive force whenever fuel is 0, regardless of throttle', () => {
    // Model the engine drive force: suppressed -> 0, otherwise proportional to throttle.
    const MAX_ENGINE_FORCE = 5000;
    const engineForce = (throttle: number, fuel: number) =>
      isThrottleSuppressed(fuel) ? 0 : throttle * MAX_ENGINE_FORCE;

    fc.assert(
      fc.property(
        // Any throttle input, including out-of-range values.
        fc.double({ min: -2, max: 2, noNaN: true }),
        (throttle) => {
          // Fuel exactly 0 must suppress throttle (Req 7.4).
          expect(isThrottleSuppressed(0)).toBe(true);
          expect(engineForce(throttle, 0)).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 12: Empty fuel suppresses throttle force
  // Validates: Requirements 7.4
  it('does not suppress throttle while fuel remains above 0', () => {
    fc.assert(
      fc.property(
        // Strictly positive fuel.
        fc.double({ min: Math.fround(1e-6), max: 1000, noNaN: true }),
        (fuel) => {
          expect(isThrottleSuppressed(fuel)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
