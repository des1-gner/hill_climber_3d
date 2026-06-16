// Pure run-lifecycle reducers for the 3D Car Hill-Climb game.
//
// These functions are side-effect-free reducers over `RunState`. They never
// mutate their input; each returns a new state object. Being decoupled from the
// physics/render I/O, they can be unit- and property-tested without a browser
// or WASM.
//
// Requirements covered:
// - 9.1 When the vehicle's horizontal speed first exceeds RUN_START_SPEED
//        (0.5 m/s) from a stationary start, begin a run and record the current
//        position as the run start position.
// - 9.2 While a run is active, update the horizontal distance traveled from the
//        run start position (ground plane, ignoring vertical).
// - 9.4 On reset, return the vehicle to a fresh idle state with fuel restored,
//        distance zeroed, balance upright, and the start position recorded.
// - 9.5 If fuel reaches zero while a run is active, end the run.
// - 9.6 If the balance state becomes overturned while a run is active, end the
//        run.
// - 8.4 When the balance state becomes overturned, end the current run.

import type { RunState, Vec3 } from '../types';
import { RUN_START_SPEED, START_FUEL } from '../constants';

/**
 * Begin a run when the vehicle first moves fast enough.
 *
 * When the run is `'idle'` and `horizontalSpeed` exceeds `RUN_START_SPEED`
 * (0.5 m/s), the run transitions to `'running'` and the supplied position is
 * recorded as the run start position. Once a run has started, the recorded
 * start position is never changed; calls in any non-idle state return the input
 * state unchanged (Req 9.1).
 *
 * Returns a new `RunState`; the input state is not mutated.
 *
 * @param state Current run state.
 * @param horizontalSpeed Vehicle horizontal (ground-plane) speed in m/s.
 * @param pos Current vehicle position, recorded as the start position.
 * @returns A new run state, transitioned to `'running'` when the start
 *          condition is met; otherwise the unchanged input state.
 *
 * Requirements: 9.1
 */
export function startRunIfMoving(
  state: RunState,
  horizontalSpeed: number,
  pos: Vec3,
): RunState {
  if (state.status === 'idle' && horizontalSpeed > RUN_START_SPEED) {
    return {
      ...state,
      status: 'running',
      startPosition: { x: pos.x, y: pos.y, z: pos.z },
    };
  }
  return state;
}

/**
 * Update the tracked horizontal distance traveled from the start position.
 *
 * The distance is the Euclidean distance between `startPosition` and
 * `currentPos` measured in the ground plane only (x and z), ignoring vertical
 * (y) displacement (Req 9.2). The result is always non-negative. If no start
 * position has been recorded yet, the distance stays 0.
 *
 * Returns a new `RunState`; the input state is not mutated.
 *
 * @param state Current run state.
 * @param currentPos Current vehicle position.
 * @returns A new run state with `distanceTraveled` set to the horizontal
 *          displacement from the start position.
 *
 * Requirements: 9.2
 */
export function updateDistance(state: RunState, currentPos: Vec3): RunState {
  if (state.startPosition === null) {
    return { ...state, distanceTraveled: 0 };
  }

  const dx = currentPos.x - state.startPosition.x;
  const dz = currentPos.z - state.startPosition.z;
  const distanceTraveled = Math.sqrt(dx * dx + dz * dz);

  return { ...state, distanceTraveled };
}

/**
 * End the run when a terminal physical condition is met.
 *
 * Only acts while the run is active (`status === 'running'`). When fuel is
 * exhausted (`fuel <= 0`) the run ends with reason `'out-of-fuel'` (Req 9.5);
 * otherwise, when the balance state is `'overturned'`, the run ends with reason
 * `'overturned'` (Req 8.4, 9.6). Exactly one end reason is set. If neither
 * condition holds the state is returned unchanged, and the function is
 * idempotent once the run has already ended.
 *
 * Returns a new `RunState` when a condition fires; the input state is not
 * mutated.
 *
 * @param state Current run state.
 * @returns A new ended run state when a terminal condition is met; otherwise
 *          the unchanged input state.
 *
 * Requirements: 8.4, 9.5, 9.6
 */
export function applyEndConditions(state: RunState): RunState {
  // Idempotent: only an active run can end (Req 9.5, 9.6).
  if (state.status !== 'running') {
    return state;
  }

  // Fuel exhaustion takes precedence; exactly one end reason is set.
  if (state.fuel <= 0) {
    return { ...state, status: 'ended', endReason: 'out-of-fuel' };
  }

  if (state.balance === 'overturned') {
    return { ...state, status: 'ended', endReason: 'overturned' };
  }

  return state;
}

/**
 * Produce a fresh run state for the start of play or after a reset.
 *
 * Returns an `'idle'` state (no active run) with fuel restored to `START_FUEL`
 * (100), distance zeroed, balance `'upright'`, the overturn timer cleared, no
 * end reason, and the start position set to the supplied position (Req 9.4).
 *
 * @param startPosition The position to record as the run start position.
 * @returns A fresh idle `RunState`.
 *
 * Requirements: 9.4
 */
export function resetRun(startPosition: Vec3): RunState {
  return {
    status: 'idle',
    fuel: START_FUEL,
    startPosition: { x: startPosition.x, y: startPosition.y, z: startPosition.z },
    distanceTraveled: 0,
    balance: 'upright',
    overturnElapsed: 0,
    endReason: null,
  };
}
