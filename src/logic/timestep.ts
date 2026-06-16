// Pure fixed-timestep accumulator for the GameLoop.
//
// Physics advances on a constant timestep (FIXED_DT) independent of the
// rendering frame rate (Req 10.2). Each rendered frame carries an accumulator
// of leftover real time; newly elapsed time is added, whole fixed steps are
// drained from it, and the sub-step remainder is carried to the next frame.
//
// This function is side-effect-free and decoupled from any clock so it can be
// unit- and property-tested without a browser or GPU.

import { FIXED_DT } from '../constants';

/** Result of accumulating elapsed real time into whole fixed steps. */
export interface AccumulateResult {
  /** Number of whole fixed steps to advance the simulation this frame. */
  stepsToRun: number;
  /** Leftover real time (seconds) carried to the next frame; in [0, fixedDt). */
  remainder: number;
  /** Interpolation blend factor `remainder / fixedDt`, in [0, 1). */
  alpha: number;
}

/**
 * Maximum number of fixed steps to run in a single frame.
 *
 * This caps the work done per frame to avoid the "spiral of death": if a frame
 * is very long (tab was backgrounded, a GC pause, a debugger breakpoint), the
 * accumulated time could otherwise demand hundreds of steps, each of which
 * makes the next frame even longer. When the cap is hit, excess accumulated
 * time is discarded (simulation time slows rather than stalling the loop).
 */
export const MAX_STEPS_PER_FRAME = 5;

/**
 * Accumulate newly elapsed real time and compute how many fixed steps to run.
 *
 * Given the carried-over accumulator plus newly elapsed real time:
 * - `stepsToRun = floor((accumulated + elapsed) / fixedDt)`
 * - `remainder  = (accumulated + elapsed) - stepsToRun * fixedDt`
 * - `alpha      = remainder / fixedDt` (0..1 blend factor for interpolation)
 *
 * Every step consumes exactly `fixedDt`; the leftover sub-step time is returned
 * as `remainder` so total simulated time depends only on elapsed real time, not
 * on frame pacing (Req 10.2).
 *
 * Defensive handling:
 * - Non-finite or negative `elapsed` is treated as 0 (the clock did not move).
 * - A non-finite or non-positive `accumulated` is treated as 0.
 * - `stepsToRun` is capped at {@link MAX_STEPS_PER_FRAME} to avoid the
 *   spiral-of-death; when capped, the returned `remainder` is the leftover
 *   after the capped steps (so `alpha` stays in [0, 1)) and the excess time is
 *   intentionally dropped.
 *
 * @param accumulated Carried-over accumulator from the previous frame (seconds).
 * @param elapsed Newly elapsed real time this frame (seconds).
 * @param fixedDt Fixed timestep in seconds. Defaults to FIXED_DT (1/60).
 * @returns The number of steps to run, the carried remainder, and the blend alpha.
 *
 * Requirements: 10.2
 */
export function accumulateSteps(
  accumulated: number,
  elapsed: number,
  fixedDt: number = FIXED_DT,
): AccumulateResult {
  // A non-positive or non-finite timestep is nonsensical; nothing can advance.
  if (!(fixedDt > 0)) {
    return { stepsToRun: 0, remainder: 0, alpha: 0 };
  }

  const safeAccumulated = accumulated > 0 ? accumulated : 0;
  const safeElapsed = elapsed > 0 && Number.isFinite(elapsed) ? elapsed : 0;

  const total = safeAccumulated + safeElapsed;

  let stepsToRun = Math.floor(total / fixedDt);

  if (stepsToRun > MAX_STEPS_PER_FRAME) {
    // Spiral-of-death guard: run a bounded number of steps and drop the excess
    // accumulated time, keeping the remainder a true sub-step value.
    stepsToRun = MAX_STEPS_PER_FRAME;
    const remainder = total - Math.floor(total / fixedDt) * fixedDt;
    return { stepsToRun, remainder, alpha: remainder / fixedDt };
  }

  const remainder = total - stepsToRun * fixedDt;

  return { stepsToRun, remainder, alpha: remainder / fixedDt };
}
