// Pure Level-Of-Detail (LOD) performance state machine for the 3D Car
// Hill-Climb game.
//
// `updateLOD` is a side-effect-free reducer over `LODState`. Each call advances
// the timers by `dt` according to the measured frame rate `fps`, then applies
// at most one level change. It performs no I/O and is independent of the
// renderer, so it is unit- and property-testable in isolation.
//
// Requirements covered:
// - 10.3 IF fps < 30 for more than 2 continuous seconds, reduce the detail level
//         by one step and re-evaluate over the following window.
// - 10.4 WHILE fps remains below 60 after a reduction, continue reducing by one
//         step per re-evaluation window until fps >= 60 or the lowest level is
//         reached.
// - 10.5 At the lowest level (0), make no further reductions.
// - 10.6 IF fps sustains >= 60 for more than 5 continuous seconds and the level
//         is below the highest (3), raise the level by one step.

import type { LODLevel, LODState } from '../types';

/** Continuous seconds of fps < 30 required before the FIRST reduction. (Req 10.3) */
const REDUCE_INITIAL_WINDOW = 2;

/** Re-evaluation window in seconds between subsequent reductions while fps < 60. (Req 10.4) */
const REDUCE_REEVAL_WINDOW = 2;

/** Continuous seconds of fps >= 60 required before raising the level. (Req 10.6) */
const RAISE_WINDOW = 5;

const MIN_LEVEL: LODLevel = 0;
const MAX_LEVEL: LODLevel = 3;

/** Clamp an arbitrary number into a valid LODLevel in [0, 3]. */
function clampLevel(level: number): LODLevel {
  if (level <= MIN_LEVEL) return MIN_LEVEL;
  if (level >= MAX_LEVEL) return MAX_LEVEL;
  return level as LODLevel;
}

/**
 * Advance the LOD state machine for one frame.
 *
 * Timer / threshold semantics (documented precisely so tests can match exactly):
 *
 * Three timers are tracked, all advanced by `dt` each call:
 *  - `secondsBelow30`: continuous seconds with `fps < 30`. Resets to 0 whenever
 *    `fps >= 30`.
 *  - `secondsBelow60`: the re-evaluation window timer. It is the number of
 *    seconds spent below 60 fps SINCE the last reduction, and is also used as
 *    the in-sequence marker: it is `> 0` exactly while a reduction sequence is
 *    active. It resets to 0 on recovery (`fps >= 60`).
 *  - `secondsAbove60`: continuous seconds with `fps >= 60`. Resets to 0 whenever
 *    `fps < 60`.
 *
 * Branching by `fps`:
 *
 *  - `fps >= 60` (recovery / raise): `secondsAbove60` accumulates; `secondsBelow30`
 *    and `secondsBelow60` reset to 0 (ending any active reduction sequence). If
 *    `secondsAbove60 > 5` (strictly) and `level < 3`, raise the level by one and
 *    reset `secondsAbove60` to 0 so the next raise needs a fresh 5 s. (Req 10.6)
 *
 *  - `fps < 60`: `secondsAbove60` resets to 0. `secondsBelow30` accumulates while
 *    `fps < 30` (else resets to 0).
 *      * If NOT already in a reduction sequence (`secondsBelow60 == 0`): the
 *        first reduction fires only when `fps < 30` has been sustained for more
 *        than 2 s (`secondsBelow30 > 2`) and `level > 0`. On that reduction the
 *        sequence is entered. (Req 10.3) An `fps` held in [30, 60) from the start
 *        therefore never triggers a reduction on its own.
 *      * If already in a sequence (`secondsBelow60 > 0`): `secondsBelow60`
 *        accumulates, and each time it exceeds the 2 s re-evaluation window
 *        (`secondsBelow60 > 2`) the level is reduced by one (down to, but never
 *        below, 0) and the window restarts. The sequence continues for as long
 *        as `fps < 60`, regardless of whether `fps` is also below 30. (Req 10.4,
 *        10.5)
 *
 * On entering/continuing a sequence the window is restarted by setting
 * `secondsBelow60 = dt` (counting the current sub-60 frame), which keeps the
 * sequence marker positive. At the lowest level the sequence marker is left in
 * place but no further reduction occurs (Req 10.5).
 *
 * At most one level change occurs per call. The returned level is always clamped
 * to [0, 3]. The input state is not mutated.
 *
 * @param state Current LOD state.
 * @param fps Measured frame rate for this evaluation window.
 * @param dt Real time elapsed since the previous evaluation, in seconds.
 * @returns A new LOD state with updated timers and (at most one step of) level.
 *
 * Requirements: 10.3, 10.4, 10.5, 10.6
 */
export function updateLOD(state: LODState, fps: number, dt: number): LODState {
  let level: number = state.level;

  if (fps >= 60) {
    // Recovery: end any reduction sequence, accumulate the sustained-high timer.
    let secondsAbove60 = state.secondsAbove60 + dt;

    if (secondsAbove60 > RAISE_WINDOW && level < MAX_LEVEL) {
      level += 1; // raise one step (Req 10.6)
      secondsAbove60 = 0; // require a fresh window for the next raise
    }

    return {
      level: clampLevel(level),
      secondsBelow30: 0,
      secondsBelow60: 0,
      secondsAbove60,
    };
  }

  // fps < 60: any sustained-high streak is broken.
  const secondsAbove60 = 0;
  let secondsBelow30 = fps < 30 ? state.secondsBelow30 + dt : 0;
  let secondsBelow60 = state.secondsBelow60;

  const inSequence = secondsBelow60 > 0;

  if (inSequence) {
    // Re-evaluation window after a reduction (Req 10.4).
    secondsBelow60 += dt;
    if (secondsBelow60 > REDUCE_REEVAL_WINDOW && level > MIN_LEVEL) {
      level -= 1; // continue reducing one step per window (Req 10.4)
      secondsBelow60 = dt; // restart window, stay in sequence
      secondsBelow30 = 0;
    }
    // At the lowest level we keep the sequence marker but make no further
    // reductions (Req 10.5).
  } else if (secondsBelow30 > REDUCE_INITIAL_WINDOW && level > MIN_LEVEL) {
    // First reduction: requires fps < 30 sustained > 2 s (Req 10.3).
    level -= 1;
    secondsBelow60 = dt; // enter the reduction sequence, start the window
    secondsBelow30 = 0;
  }

  return {
    level: clampLevel(level),
    secondsBelow30,
    secondsBelow60,
    secondsAbove60,
  };
}
