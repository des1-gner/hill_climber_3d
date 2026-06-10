import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluateBalance } from './balance';
import { OVERTURN_ANGLE, OVERTURN_HOLD } from '../constants';
import type { RunState, BalanceState } from '../types';

// Property-based tests for the pure balance / overturn reducer.
//
// Exercises Property 15 from the design's Correctness Properties section by
// folding evaluateBalance across generated sequences of per-frame pitch/roll
// angles and frame durations and checking the latch + reset behavior.

const NUM_RUNS = 200;

/** A fresh, upright run state with a zeroed overturn timer. */
function baseState(): RunState {
  return {
    status: 'running',
    fuel: 100,
    startPosition: { x: 0, y: 0, z: 0 },
    distanceTraveled: 0,
    balance: 'upright',
    overturnElapsed: 0,
    endReason: null,
  };
}

/** A single generated frame: pitch/roll angles in degrees and a frame duration. */
interface Frame {
  pitchDeg: number;
  rollDeg: number;
  dt: number;
}

// Bias angle generation around the 75-degree threshold so sequences regularly
// cross the breach boundary in both directions, while still covering the wider
// orientation range.
const angleArb = fc.oneof(
  fc.double({ min: -180, max: 180, noNaN: true }),
  fc.double({ min: OVERTURN_ANGLE - 10, max: OVERTURN_ANGLE + 10, noNaN: true }),
);

const frameArb: fc.Arbitrary<Frame> = fc.record({
  pitchDeg: angleArb,
  rollDeg: angleArb,
  dt: fc.double({ min: 0, max: 1, noNaN: true }),
});

describe('balance logic — property-based', () => {
  // Feature: 3d-car-hill-climb, Property 15: Balance becomes overturned only after sustained threshold breach
  // Validates: Requirements 8.2, 8.3
  it('latches overturned only after a continuous >75deg breach lasting >= 1.5s, and resets when within bounds', () => {
    fc.assert(
      fc.property(
        fc.array(frameArb, { minLength: 1, maxLength: 40 }),
        (frames) => {
          let state = baseState();

          // Independently track the continuous-breach duration ending at the
          // current frame, using logic separate from the implementation.
          let expectedElapsed = 0;

          for (const { pitchDeg, rollDeg, dt } of frames) {
            state = evaluateBalance(state, pitchDeg, rollDeg, dt);

            const breached =
              Math.abs(pitchDeg) > OVERTURN_ANGLE ||
              Math.abs(rollDeg) > OVERTURN_ANGLE;

            if (breached) {
              expectedElapsed += dt;
            } else {
              // Both angles at or below threshold: timer resets to 0 (Req 8.3).
              expectedElapsed = 0;
            }

            const expectedBalance: BalanceState =
              expectedElapsed >= OVERTURN_HOLD ? 'overturned' : 'upright';

            // Timer reflects the continuous breach duration.
            expect(state.overturnElapsed).toBeCloseTo(expectedElapsed, 9);

            // Balance is overturned exactly when the continuous breach has been
            // sustained for >= OVERTURN_HOLD (Req 8.2); otherwise upright (Req 8.3).
            expect(state.balance).toBe(expectedBalance);

            // Whenever within bounds, the timer is zeroed and state is upright.
            if (!breached) {
              expect(state.overturnElapsed).toBe(0);
              expect(state.balance).toBe('upright');
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 15: Balance becomes overturned only after sustained threshold breach
  // Validates: Requirements 8.2, 8.3
  it('stays upright while breach is interrupted, even if total breached time exceeds 1.5s', () => {
    fc.assert(
      fc.property(
        // Number of breached frames whose durations sum past the hold threshold.
        fc.integer({ min: 2, max: 10 }),
        fc.double({ min: 0.2, max: 1, noNaN: true }),
        (count, dt) => {
          let state = baseState();
          const overAngle = OVERTURN_ANGLE + 5;

          for (let i = 0; i < count; i++) {
            // Breached frame.
            state = evaluateBalance(state, overAngle, 0, dt);
            // Interrupting upright frame resets the timer (Req 8.3).
            state = evaluateBalance(state, 0, 0, dt);

            // Because each breach is interrupted, it never sustains long enough.
            expect(state.overturnElapsed).toBe(0);
            expect(state.balance).toBe('upright');
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
