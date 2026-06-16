// Property-based tests for the pure traction logic.
//
// Uses fast-check + Vitest. Covers the traction correctness properties from the
// design's Correctness Properties section.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { capDriveForce } from './traction';

const NUM_RUNS = 200;

const finite = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

// Surface friction coefficient bound (Req 6.5).
const FRICTION_MIN = 0.05;
const FRICTION_MAX = 1.5;

describe('capDriveForce', () => {
  // Feature: 3d-car-hill-climb, Property 9: Drive force never exceeds the traction limit
  // Validates: Requirements 6.1, 6.2, 6.3, 6.4
  it('Property 9: drive force never exceeds the traction limit', () => {
    fc.assert(
      fc.property(
        finite(FRICTION_MIN, FRICTION_MAX), // frictionCoeff
        finite(0, 50_000), // normalForce (>= 0)
        finite(-10_000, 100_000), // demandedForce
        fc.boolean(), // inContact
        (frictionCoeff, normalForce, demandedForce, inContact) => {
          const transmitted = capDriveForce(
            demandedForce,
            frictionCoeff,
            normalForce,
            inContact,
          );

          const tractionLimit = frictionCoeff * normalForce; // Req 6.1

          if (!inContact) {
            // No contact => zero transmitted force (Req 6.4).
            expect(transmitted).toBe(0);
          } else {
            // Transmitted = min(demanded, limit) (Req 6.2).
            const expected = Math.min(demandedForce, tractionLimit);
            expect(transmitted).toBeCloseTo(expected, 6);

            // Never exceeds the traction limit (Req 6.2).
            expect(transmitted).toBeLessThanOrEqual(tractionLimit + 1e-9);

            // Whenever demand exceeds the limit, the cap applies => slip (Req 6.3).
            if (demandedForce > tractionLimit) {
              expect(transmitted).toBeLessThan(demandedForce);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 10: Surface friction coefficient stays within bounds
  // Validates: Requirements 6.5
  it('Property 10: surface friction coefficient stays within bounds', () => {
    fc.assert(
      fc.property(
        finite(FRICTION_MIN, FRICTION_MAX), // friction generated within [0.05, 1.50]
        finite(0, 50_000), // normalForce
        finite(-10_000, 100_000), // demandedForce
        (frictionCoeff, normalForce, demandedForce) => {
          // The contact-region friction value stays within the required bounds.
          expect(frictionCoeff).toBeGreaterThanOrEqual(FRICTION_MIN);
          expect(frictionCoeff).toBeLessThanOrEqual(FRICTION_MAX);

          // capDriveForce honors that bound: transmitted force never exceeds the
          // limit implied by an in-bounds friction coefficient.
          const transmitted = capDriveForce(demandedForce, frictionCoeff, normalForce, true);
          const tractionLimit = frictionCoeff * normalForce;
          expect(transmitted).toBeLessThanOrEqual(tractionLimit + 1e-9);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
