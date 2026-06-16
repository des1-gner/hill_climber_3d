import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { toHudView } from './hud';
import type { EndReason, RunState, RunStatus } from '../types';

// Property-based tests for the pure HUD projection (`toHudView`).
//
// Exercises Property 13 from the design's Correctness Properties section across
// many generated run states.

const NUM_RUNS = 200;

const statusArb: fc.Arbitrary<RunStatus> = fc.constantFrom(
  'idle',
  'running',
  'ended',
);

const endReasonArb: fc.Arbitrary<EndReason | null> = fc.constantFrom(
  'out-of-fuel',
  'overturned',
  'player-reset',
  null,
);

/** A Vec3-or-null start position generator (not used by the projection). */
const startPositionArb = fc.oneof(
  fc.constant(null),
  fc.record({
    x: fc.double({ min: -1000, max: 1000, noNaN: true }),
    y: fc.double({ min: -1000, max: 1000, noNaN: true }),
    z: fc.double({ min: -1000, max: 1000, noNaN: true }),
  }),
);

/** Generate an arbitrary, well-formed RunState. */
const runStateArb: fc.Arbitrary<RunState> = fc.record({
  status: statusArb,
  // Fuel spans well beyond the nominal [0, 100] range to exercise clamping.
  fuel: fc.double({ min: -50, max: 200, noNaN: true }),
  startPosition: startPositionArb,
  // Distance spans 0..large to exercise rounding/formatting.
  distanceTraveled: fc.double({ min: 0, max: 100000, noNaN: true }),
  balance: fc.constantFrom('upright', 'overturned'),
  overturnElapsed: fc.double({ min: 0, max: 10, noNaN: true }),
  endReason: endReasonArb,
});

describe('toHudView — property-based', () => {
  // Feature: 3d-car-hill-climb, Property 13: HUD projection bounds fuel and rounds distance
  // Validates: Requirements 7.5, 9.3
  it('produces an integer fuelInt within [0, 1000] equal to round(fuel) clamped', () => {
    fc.assert(
      fc.property(runStateArb, (run) => {
        const view = toHudView(run);
        expect(Number.isInteger(view.fuelInt)).toBe(true);
        expect(view.fuelInt).toBeGreaterThanOrEqual(0);
        expect(view.fuelInt).toBeLessThanOrEqual(1000);
        const expected = Math.min(1000, Math.max(0, Math.round(run.fuel)));
        expect(view.fuelInt + 0).toBe(expected + 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 13: HUD projection bounds fuel and rounds distance
  // Validates: Requirements 7.5, 9.3
  it('formats distanceText as distance rounded to 0.1 m with one decimal and a " m" suffix', () => {
    fc.assert(
      fc.property(runStateArb, (run) => {
        const view = toHudView(run);

        // Must end with the unit suffix and match the one-decimal format.
        expect(view.distanceText).toMatch(/^-?\d+\.\d m$/);

        // Numeric portion equals distance rounded to the nearest 0.1 m.
        const rounded = Math.round(run.distanceTraveled * 10) / 10;
        expect(view.distanceText).toBe(`${rounded.toFixed(1)} m`);

        // The displayed tenths value is within 0.05 m of the true distance.
        const shown = parseFloat(view.distanceText);
        expect(Math.abs(shown - run.distanceTraveled)).toBeLessThanOrEqual(0.05 + 1e-9);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 13: HUD projection bounds fuel and rounds distance
  // Validates: Requirements 7.5, 9.3
  it('passes status and endReason through unchanged', () => {
    fc.assert(
      fc.property(runStateArb, (run) => {
        const view = toHudView(run);

        // status passed through.
        expect(view.status).toBe(run.status);

        // endReason is one of the valid union members (or null), passed through.
        expect([
          'out-of-fuel',
          'overturned',
          'player-reset',
          null,
        ]).toContain(view.endReason);
        expect(view.endReason).toBe(run.endReason);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 13: HUD projection bounds fuel and rounds distance
  // Validates: Requirements 7.5, 9.3
  it('does not mutate the input run state', () => {
    fc.assert(
      fc.property(runStateArb, (run) => {
        const snapshot = JSON.stringify(run);
        toHudView(run);
        expect(JSON.stringify(run)).toBe(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
