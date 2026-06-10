// Property-based tests for the pure suspension logic.
//
// Uses fast-check + Vitest. Covers the suspension correctness properties from
// the design's Correctness Properties section.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { computeSuspensionCompression, wheelVerticalOffset } from './suspension';
import { SUSPENSION_VIS_TOLERANCE } from '../constants';

const NUM_RUNS = 200;

// A finite double generator constrained to a physically reasonable range so we
// avoid NaN/Infinity and overflow while still exercising the full input space.
const finite = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

// Generate a valid travel range [minTravel, maxTravel] with minTravel <= maxTravel.
const travelRange = fc
  .tuple(finite(-50, 50), finite(0, 100))
  .map(([minTravel, span]) => ({ minTravel, maxTravel: minTravel + span }));

describe('computeSuspensionCompression', () => {
  // Feature: 3d-car-hill-climb, Property 5: Suspension compression is well-defined and bounded
  // Validates: Requirements 3.2, 3.3, 3.4
  it('Property 5: compression is well-defined and bounded', () => {
    fc.assert(
      fc.property(
        finite(0.01, 10), // restLength (> 0 per Req 3.1)
        finite(0, 20), // contactDistance
        travelRange,
        fc.boolean(), // inContact
        (restLength, contactDistance, { minTravel, maxTravel }, inContact) => {
          const result = computeSuspensionCompression(
            restLength,
            contactDistance,
            minTravel,
            maxTravel,
            inContact,
          );

          // Result is always within the travel range (Req 3.4).
          expect(result).toBeGreaterThanOrEqual(minTravel);
          expect(result).toBeLessThanOrEqual(maxTravel);

          if (inContact) {
            // In contact: max(0, restLength - contactDistance) clamped to range (Req 3.2).
            const raw = Math.max(0, restLength - contactDistance);
            const expected = Math.min(Math.max(raw, minTravel), maxTravel);
            expect(result).toBeCloseTo(expected, 10);
          } else {
            // Out of contact: full extension = max-travel value (Req 3.3).
            expect(result).toBeCloseTo(maxTravel, 10);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('wheelVerticalOffset', () => {
  // Feature: 3d-car-hill-climb, Property 6: Rendered wheel offset reflects compression within tolerance
  // Validates: Requirements 3.5
  it('Property 6: rendered wheel offset reflects compression within tolerance', () => {
    fc.assert(
      fc.property(
        finite(0.01, 10), // restLength
        travelRange,
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), // interpolation t
        (restLength, { minTravel, maxTravel }, t) => {
          // A compression value within the travel range.
          const compression = minTravel + t * (maxTravel - minTravel);

          const offset = wheelVerticalOffset(restLength, compression);

          // The offset implied by that compression along the downward axis.
          const impliedOffset = -(restLength - compression);

          expect(Math.abs(offset - impliedOffset)).toBeLessThanOrEqual(
            SUSPENSION_VIS_TOLERANCE,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
