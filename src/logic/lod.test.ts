import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { updateLOD } from './lod';
import type { LODLevel, LODState } from '../types';

// Property-based tests for the pure LOD performance state machine (`updateLOD`).
//
// Exercises Property 21 from the design's Correctness Properties section. The
// properties focus on the robust invariants (level bounds, single-step changes,
// and the eventual-convergence behaviour under sustained frame rates) rather
// than brittle exact-timer equality.

const NUM_RUNS = 200;

const levelArb: fc.Arbitrary<LODLevel> = fc.constantFrom(0, 1, 2, 3);

/** An arbitrary, well-formed starting LODState. */
const lodStateArb: fc.Arbitrary<LODState> = fc.record({
  level: levelArb,
  secondsBelow30: fc.double({ min: 0, max: 10, noNaN: true }),
  secondsBelow60: fc.double({ min: 0, max: 10, noNaN: true }),
  secondsAbove60: fc.double({ min: 0, max: 10, noNaN: true }),
});

/** A measured fps for one window: spans the well-below, mid, and recovery bands. */
const fpsArb = fc.double({ min: 0, max: 120, noNaN: true });

/** A non-negative, bounded frame delta in seconds. */
const dtArb = fc.double({ min: Math.fround(1e-3), max: 2, noNaN: true });

describe('updateLOD — property-based', () => {
  // Feature: 3d-car-hill-climb, Property 21: LOD level adjusts within bounds based on sustained frame rate
  // Validates: Requirements 10.3, 10.4, 10.5, 10.6
  it('keeps level within [0, 3] and changes it by at most one step per call', () => {
    fc.assert(
      fc.property(lodStateArb, fpsArb, dtArb, (state, fps, dt) => {
        const next = updateLOD(state, fps, dt);

        // Level always clamped to [0, 3].
        expect(next.level).toBeGreaterThanOrEqual(0);
        expect(next.level).toBeLessThanOrEqual(3);
        expect([0, 1, 2, 3]).toContain(next.level);

        // At most one level change per call.
        expect(Math.abs(next.level - state.level)).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 21: LOD level adjusts within bounds based on sustained frame rate
  // Validates: Requirements 10.3, 10.4, 10.5, 10.6
  it('keeps level within [0, 3] when folding any sequence of fps/dt windows', () => {
    fc.assert(
      fc.property(
        lodStateArb,
        fc.array(fc.tuple(fpsArb, dtArb), { minLength: 1, maxLength: 100 }),
        (initial, windows) => {
          let state = initial;
          for (const [fps, dt] of windows) {
            const prevLevel = state.level;
            state = updateLOD(state, fps, dt);

            // Bounds and single-step invariants hold at every fold step.
            expect(state.level).toBeGreaterThanOrEqual(0);
            expect(state.level).toBeLessThanOrEqual(3);
            expect(Math.abs(state.level - prevLevel)).toBeLessThanOrEqual(1);

            // Timers never go negative.
            expect(state.secondsBelow30).toBeGreaterThanOrEqual(0);
            expect(state.secondsBelow60).toBeGreaterThanOrEqual(0);
            expect(state.secondsAbove60).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 21: LOD level adjusts within bounds based on sustained frame rate
  // Validates: Requirements 10.3, 10.4, 10.5, 10.6
  it('drives the level down to 0 (never below) under sustained fps < 30', () => {
    fc.assert(
      fc.property(levelArb, dtArb, (startLevel, dt) => {
        let state: LODState = {
          level: startLevel,
          secondsBelow30: 0,
          secondsBelow60: 0,
          secondsAbove60: 0,
        };

        // Sustain a very low frame rate long enough to exhaust every step.
        // Each reduction needs a ~2 s window; ample iterations guarantee
        // convergence regardless of dt within its bound.
        const iterations = Math.ceil((4 * 3) / dt) + 20;
        for (let i = 0; i < iterations; i++) {
          state = updateLOD(state, 10, dt);
          // Never drops below the lowest level (Req 10.5).
          expect(state.level).toBeGreaterThanOrEqual(0);
        }

        // Sustained sub-30 fps eventually reaches the lowest level (Req 10.3, 10.4, 10.5).
        expect(state.level).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 21: LOD level adjusts within bounds based on sustained frame rate
  // Validates: Requirements 10.3, 10.4, 10.5, 10.6
  it('drives the level up to 3 (never above) under sustained fps >= 60', () => {
    fc.assert(
      fc.property(levelArb, dtArb, (startLevel, dt) => {
        let state: LODState = {
          level: startLevel,
          secondsBelow30: 0,
          secondsBelow60: 0,
          secondsAbove60: 0,
        };

        // Each raise needs a ~5 s sustained window; ample iterations guarantee
        // convergence regardless of dt within its bound.
        const iterations = Math.ceil((6 * 3) / dt) + 20;
        for (let i = 0; i < iterations; i++) {
          state = updateLOD(state, 60, dt);
          // Never exceeds the highest level.
          expect(state.level).toBeLessThanOrEqual(3);
        }

        // Sustained >= 60 fps eventually reaches the highest level (Req 10.6).
        expect(state.level).toBe(3);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 21: LOD level adjusts within bounds based on sustained frame rate
  // Validates: Requirements 10.3, 10.4, 10.5, 10.6
  it('does not mutate the input state', () => {
    fc.assert(
      fc.property(lodStateArb, fpsArb, dtArb, (state, fps, dt) => {
        const snapshot = JSON.stringify(state);
        updateLOD(state, fps, dt);
        expect(JSON.stringify(state)).toBe(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
