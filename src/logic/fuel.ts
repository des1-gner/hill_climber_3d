// Pure fuel accounting for the 3D Car Hill-Climb game.
//
// These functions are side-effect-free and decoupled from the physics/render
// I/O so they can be unit- and property-tested without a browser or WASM.
//
// Requirements covered:
// - 7.2 While throttle is applied, fuel decreases at FUEL_BURN_RATE units/sec
//        scaled linearly by the throttle input (0.0..1.0), measured against the
//        simulation time elapsed since the previous frame.
// - 7.3 A fuel decrease that would go below 0 clamps to 0.
// - 7.4 When fuel reaches 0, throttle driving force is suppressed.

import { FUEL_BURN_RATE } from '../constants';

/**
 * Deplete fuel for a single simulation step.
 *
 * Reduces `fuel` by `FUEL_BURN_RATE * throttle * dt`, then clamps the result to
 * be non-negative so fuel never goes below 0 (Req 7.3). With `throttle` of 0 or
 * `dt` of 0 the fuel is unchanged. The caller is expected to pass a throttle in
 * [0, 1] and a non-negative `dt`.
 *
 * @param fuel Current fuel level in fuel units.
 * @param throttle Normalized throttle input in [0, 1].
 * @param dt Simulation time elapsed since the previous frame, in seconds.
 * @returns The new fuel level, clamped to >= 0.
 *
 * Requirements: 7.2, 7.3
 */
export function depleteFuel(fuel: number, throttle: number, dt: number): number {
  const next = fuel - FUEL_BURN_RATE * throttle * dt;
  return next < 0 ? 0 : next;
}

/**
 * Whether throttle driving force must be suppressed because fuel is exhausted.
 *
 * Returns `true` when `fuel <= 0`, signaling that the engine should apply zero
 * throttle driving force for the remainder of the run regardless of throttle
 * input (Req 7.4).
 *
 * @param fuel Current fuel level in fuel units.
 * @returns `true` when fuel is exhausted (<= 0), otherwise `false`.
 *
 * Requirements: 7.4
 */
export function isThrottleSuppressed(fuel: number): boolean {
  return fuel <= 0;
}
