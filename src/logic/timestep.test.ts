import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { accumulateSteps, MAX_STEPS_PER_FRAME } from './timestep';
import { FIXED_DT } from '../constants';

// Feature: 3d-car-hill-climb, Property 20: Fixed-timestep accumulation is frame-rate independent
//
// The fixed-timestep accumulator advances physics by whole steps of exactly
// FIXED_DT, carrying the sub-step remainder to the next frame so that total
// simulated time depends only on elapsed real time, not on frame pacing. The
// MAX_STEPS_PER_FRAME cap intentionally drops excess time on pathologically
// long frames, so conservation is tested below the cap and the cap is tested
// separately.
//
// Validates: Requirements 10.2

const NUM_RUNS = 200;

describe('accumulateSteps (Property 20: frame-rate independent accumulation)', () => {
  // Conservation: fold a sequence of small per-frame elapsed durations, carrying
  // the remainder as the next accumulated value. Elapsed is kept in
  // [0, 4*FIXED_DT] so that accumulated (< FIXED_DT) + elapsed (<= 4*FIXED_DT)
  // is always < 5*FIXED_DT, meaning floor(total/FIXED_DT) <= 4 and the
  // MAX_STEPS_PER_FRAME (=5) cap is never hit.
  it('conserves total simulated time across a variable-rate frame sequence (below the cap)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 4 * FIXED_DT, noNaN: true }), {
          minLength: 0,
          maxLength: 200,
        }),
        (elapsedSequence) => {
          let accumulated = 0;
          let totalSteps = 0;
          let totalElapsed = 0;

          for (const elapsed of elapsedSequence) {
            const before = accumulated;
            const { stepsToRun, remainder, alpha } = accumulateSteps(before, elapsed);

            totalElapsed += elapsed;

            // The cap must not be reached for these inputs.
            expect(stepsToRun).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME);

            // Whole-step advancement equals the floor of total over the step.
            const expectedSteps = Math.floor((before + elapsed) / FIXED_DT);
            expect(stepsToRun).toBe(expectedSteps);

            // Remainder stays a true sub-step value in [0, FIXED_DT).
            expect(remainder).toBeGreaterThanOrEqual(0);
            expect(remainder).toBeLessThan(FIXED_DT);

            // Alpha is the normalized remainder in [0, 1).
            expect(alpha).toBeGreaterThanOrEqual(0);
            expect(alpha).toBeLessThan(1);
            expect(alpha).toBeCloseTo(remainder / FIXED_DT, 12);

            // Local conservation: every step consumes exactly FIXED_DT, and the
            // remainder accounts for the leftover sub-step time this frame.
            expect(stepsToRun * FIXED_DT + remainder).toBeCloseTo(before + elapsed, 9);

            totalSteps += stepsToRun;
            accumulated = remainder;
          }

          // Global conservation: total simulated time (whole steps) plus the
          // final carried remainder equals the total elapsed real time.
          const simulated = totalSteps * FIXED_DT + accumulated;
          // Floating-point error accumulates per frame; tolerance scales with
          // the number of frames folded.
          const tolerance = 1e-9 * (elapsedSequence.length + 1);
          expect(Math.abs(simulated - totalElapsed)).toBeLessThanOrEqual(tolerance);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Cap: when a single frame's elapsed time is huge, the number of steps is
  // capped at MAX_STEPS_PER_FRAME and the remainder is still a valid sub-step
  // value (the excess accumulated time is intentionally dropped).
  it('caps stepsToRun at MAX_STEPS_PER_FRAME for huge frames, remainder stays in [0, FIXED_DT)', () => {
    fc.assert(
      fc.property(
        // Carried accumulator from the previous frame (any non-negative value).
        fc.double({ min: 0, max: 10, noNaN: true }),
        // Elapsed large enough that floor(total/FIXED_DT) > MAX_STEPS_PER_FRAME.
        fc.double({ min: (MAX_STEPS_PER_FRAME + 1) * FIXED_DT, max: 1000, noNaN: true }),
        (accumulated, elapsed) => {
          const { stepsToRun, remainder, alpha } = accumulateSteps(accumulated, elapsed);

          // Cap is enforced.
          expect(stepsToRun).toBe(MAX_STEPS_PER_FRAME);

          // Remainder remains a true sub-step value in [0, FIXED_DT).
          expect(remainder).toBeGreaterThanOrEqual(0);
          expect(remainder).toBeLessThan(FIXED_DT);

          // Alpha is the normalized remainder in [0, 1).
          expect(alpha).toBeGreaterThanOrEqual(0);
          expect(alpha).toBeLessThan(1);
          expect(alpha).toBeCloseTo(remainder / FIXED_DT, 12);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Below the cap, stepsToRun is exactly floor((accumulated + elapsed) / FIXED_DT)
  // and alpha = remainder / FIXED_DT in [0, 1).
  it('matches floor((accumulated + elapsed) / FIXED_DT) when below the cap', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: FIXED_DT, noNaN: true }),
        // Keep total below the cap: accumulated (<= FIXED_DT) + elapsed
        // (<= 4*FIXED_DT) < 6*FIXED_DT, but guard inside the assertion anyway.
        fc.double({ min: 0, max: 4 * FIXED_DT, noNaN: true }),
        (accumulated, elapsed) => {
          const expectedSteps = Math.floor((accumulated + elapsed) / FIXED_DT);
          fc.pre(expectedSteps <= MAX_STEPS_PER_FRAME);

          const { stepsToRun, remainder, alpha } = accumulateSteps(accumulated, elapsed);

          expect(stepsToRun).toBe(expectedSteps);
          expect(alpha).toBeCloseTo(remainder / FIXED_DT, 12);
          expect(alpha).toBeGreaterThanOrEqual(0);
          expect(alpha).toBeLessThan(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
