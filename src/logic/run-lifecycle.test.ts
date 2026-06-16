// Property-based tests for the pure run-lifecycle reducers.
//
// Uses fast-check + Vitest. Covers run-lifecycle correctness properties 16-19
// from the design's Correctness Properties section.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  startRunIfMoving,
  updateDistance,
  applyEndConditions,
  resetRun,
} from './run-lifecycle';
import { RUN_START_SPEED, START_FUEL } from '../constants';
import type {
  RunState,
  RunStatus,
  BalanceState,
  EndReason,
  Vec3,
} from '../types';

const NUM_RUNS = 200;

// A finite double generator constrained to a physically reasonable range so we
// avoid NaN/Infinity and overflow while still exercising the full input space.
const finite = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

const vec3 = fc.record<Vec3>({
  x: finite(-1000, 1000),
  y: finite(-1000, 1000),
  z: finite(-1000, 1000),
});

const status = fc.constantFrom<RunStatus>('idle', 'running', 'ended');
const balance = fc.constantFrom<BalanceState>('upright', 'overturned');
const endReason = fc.constantFrom<EndReason | null>(
  null,
  'out-of-fuel',
  'overturned',
  'player-reset',
);

// An arbitrary, internally-loose RunState for general-purpose property inputs.
const runState = fc.record<RunState>({
  status,
  fuel: finite(-50, 150),
  startPosition: fc.option(vec3, { nil: null }),
  distanceTraveled: finite(0, 5000),
  balance,
  overturnElapsed: finite(0, 100),
  endReason,
});

describe('applyEndConditions', () => {
  // Feature: 3d-car-hill-climb, Property 16: Run end conditions are honored
  // Validates: Requirements 8.4, 9.5, 9.6
  it('Property 16: run end conditions are honored', () => {
    fc.assert(
      fc.property(runState, (state) => {
        const result = applyEndConditions(state);

        if (state.status !== 'running') {
          // Idempotent / no-op for non-running states.
          expect(result).toBe(state);
          return;
        }

        if (state.fuel <= 0) {
          // Fuel exhaustion ends the run with exactly the out-of-fuel reason.
          expect(result.status).toBe('ended');
          expect(result.endReason).toBe('out-of-fuel');
        } else if (state.balance === 'overturned') {
          // Overturned ends the run with exactly the overturned reason.
          expect(result.status).toBe('ended');
          expect(result.endReason).toBe('overturned');
        } else {
          // No terminal condition: state unchanged.
          expect(result).toBe(state);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Applying end conditions twice yields the same result (idempotence).
  it('Property 16: applyEndConditions is idempotent', () => {
    fc.assert(
      fc.property(runState, (state) => {
        const once = applyEndConditions(state);
        const twice = applyEndConditions(once);
        expect(twice).toEqual(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('startRunIfMoving', () => {
  // Feature: 3d-car-hill-climb, Property 17: A run starts when horizontal speed first exceeds the threshold
  // Validates: Requirements 9.1
  it('Property 17: a run starts when horizontal speed first exceeds the threshold', () => {
    fc.assert(
      fc.property(runState, finite(-10, 50), vec3, (state, speed, pos) => {
        const result = startRunIfMoving(state, speed, pos);

        if (state.status === 'idle' && speed > RUN_START_SPEED) {
          // Transitions to running and records current position as start.
          expect(result.status).toBe('running');
          expect(result.startPosition).toEqual({ x: pos.x, y: pos.y, z: pos.z });
        } else {
          // Otherwise unchanged (non-idle, or speed at/below threshold).
          expect(result).toBe(state);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Once started, the recorded start position does not change on subsequent
  // calls (calling again in a non-idle state leaves it unchanged).
  it('Property 17: recorded start position is stable once running', () => {
    fc.assert(
      fc.property(
        runState,
        finite(-10, 50),
        vec3,
        finite(-10, 50),
        vec3,
        (state, speed1, pos1, speed2, pos2) => {
          // First call to (possibly) start the run.
          const started = startRunIfMoving(state, speed1, pos1);
          const recorded = started.startPosition;

          // A second call must not move the recorded start position when the
          // state is no longer idle.
          const again = startRunIfMoving(started, speed2, pos2);
          if (started.status !== 'idle') {
            expect(again).toBe(started);
            expect(again.startPosition).toEqual(recorded);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('updateDistance', () => {
  // Feature: 3d-car-hill-climb, Property 18: Distance is the horizontal displacement from the start
  // Validates: Requirements 9.2
  it('Property 18: distance is the horizontal (x,z) displacement from the start', () => {
    fc.assert(
      fc.property(runState, vec3, (state, currentPos) => {
        const result = updateDistance(state, currentPos);

        // Result is always non-negative.
        expect(result.distanceTraveled).toBeGreaterThanOrEqual(0);

        if (state.startPosition === null) {
          // No start position recorded: distance stays 0.
          expect(result.distanceTraveled + 0).toBe(0);
        } else {
          // Euclidean distance in the ground plane (x,z), ignoring y.
          const dx = currentPos.x - state.startPosition.x;
          const dz = currentPos.z - state.startPosition.z;
          const expected = Math.sqrt(dx * dx + dz * dz);
          expect(result.distanceTraveled).toBeCloseTo(expected, 10);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Vertical (y) displacement is ignored: changing only y does not change distance.
  it('Property 18: vertical displacement is ignored', () => {
    fc.assert(
      fc.property(
        runState.filter((s) => s.startPosition !== null),
        vec3,
        finite(-1000, 1000),
        (state, currentPos, newY) => {
          const a = updateDistance(state, currentPos);
          const b = updateDistance(state, { ...currentPos, y: newY });
          expect(b.distanceTraveled).toBeCloseTo(a.distanceTraveled, 10);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('resetRun', () => {
  // Feature: 3d-car-hill-climb, Property 19: Reset restores the defined initial run state
  // Validates: Requirements 9.4
  it('Property 19: reset restores the defined initial run state', () => {
    fc.assert(
      fc.property(vec3, (pos) => {
        const result = resetRun(pos);

        expect(result.fuel + 0).toBe(START_FUEL);
        expect(result.distanceTraveled + 0).toBe(0);
        expect(result.balance).toBe('upright');
        expect(result.overturnElapsed + 0).toBe(0);
        expect(result.endReason).toBeNull();
        expect(result.status).toBe('idle');
        expect(result.startPosition).toEqual({ x: pos.x, y: pos.y, z: pos.z });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
