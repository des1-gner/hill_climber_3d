// Pure balance / overturn evaluation for the 3D Car Hill-Climb game.
//
// `evaluateBalance` is a side-effect-free reducer over `RunState`. It tracks how
// long the chassis has continuously exceeded the overturn angle and latches the
// balance state to overturned once that breach has been sustained long enough.
//
// Requirements covered:
// - 8.2 When the chassis roll OR pitch angle exceeds OVERTURN_ANGLE (75 deg)
//        from horizontal continuously for at least OVERTURN_HOLD (1.5 s), the
//        balance state becomes overturned.
// - 8.3 While both roll and pitch remain at or below OVERTURN_ANGLE, the balance
//        state is upright (and the overturn timer is reset to 0).

import type { RunState } from '../types';
import { OVERTURN_ANGLE, OVERTURN_HOLD } from '../constants';

/**
 * Evaluate the chassis balance for a single simulation step.
 *
 * The breach condition is true when either `|pitchDeg|` or `|rollDeg|` exceeds
 * `OVERTURN_ANGLE` (Req 8.2). While breached, the `overturnElapsed` timer
 * accumulates by `dt`; once it reaches `OVERTURN_HOLD` the balance latches to
 * `'overturned'`. When both angles are at or below `OVERTURN_ANGLE` the timer
 * resets to 0 and the balance is `'upright'` (Req 8.3).
 *
 * Returns a new `RunState`; the input state is not mutated.
 *
 * @param state Current run state.
 * @param pitchDeg Chassis pitch angle in degrees relative to horizontal.
 * @param rollDeg Chassis roll angle in degrees relative to horizontal.
 * @param dt Simulation time elapsed since the previous frame, in seconds.
 * @returns A new run state with updated `overturnElapsed` and `balance`.
 *
 * Requirements: 8.2, 8.3
 */
export function evaluateBalance(
  state: RunState,
  pitchDeg: number,
  rollDeg: number,
  dt: number,
): RunState {
  const breached =
    Math.abs(pitchDeg) > OVERTURN_ANGLE || Math.abs(rollDeg) > OVERTURN_ANGLE;

  if (!breached) {
    // Both angles within bounds: reset the timer and stay/return upright (Req 8.3).
    return { ...state, overturnElapsed: 0, balance: 'upright' };
  }

  // Breached: accumulate the continuous-breach timer (Req 8.2).
  const overturnElapsed = state.overturnElapsed + dt;
  const balance = overturnElapsed >= OVERTURN_HOLD ? 'overturned' : 'upright';

  return { ...state, overturnElapsed, balance };
}
