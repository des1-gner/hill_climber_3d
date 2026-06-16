// Pure HUD projection for the 3D Car Hill-Climb game.
//
// `toHudView` is a side-effect-free projection of the run lifecycle state into
// the small, display-ready view consumed by the HUD overlay. It performs no
// I/O and references no rendering framework, so it is unit- and
// property-testable in isolation.
//
// Requirements covered:
// - 7.5 While a run is active, the HUD displays the current fuel level expressed
//        as an integer from 0 to 100.
// - 9.3 When a run ends, the HUD displays the total horizontal distance traveled
//        rounded to the nearest 0.1 metres, alongside the run status and the
//        reason the run ended.

import type { HudView, RunState } from '../types';

/**
 * Project the run lifecycle state into a display-ready HUD view.
 *
 * Semantics (documented precisely so tests can match exactly):
 *
 * - `fuelInt`: `run.fuel` rounded to the nearest integer via `Math.round`
 *   (round-half-up: a value of exactly N.5 rounds toward +Infinity), then
 *   clamped to the inclusive range [0, 100]. So fuel 42.6 -> 43, fuel 100.4 ->
 *   100, fuel -3 -> 0. (Req 7.5)
 *
 * - `distanceText`: `run.distanceTraveled` rounded to the nearest 0.1 metres
 *   (`Math.round(distance * 10) / 10`, round-half-up on the tenths) and then
 *   formatted to exactly one decimal place with a trailing " m" suffix. So
 *   123.44 -> "123.4 m", 123.45 -> "123.5 m", 0 -> "0.0 m". (Req 9.3)
 *
 * - `status` and `endReason` are passed through unchanged from the run state.
 *
 * The input state is not mutated.
 *
 * @param run Current run lifecycle state.
 * @returns A pure, display-ready HUD view.
 *
 * Requirements: 7.5, 9.3
 */
export function toHudView(run: RunState): HudView {
  // Fuel: round to integer, then clamp to [0, 100] (Req 7.5).
  const roundedFuel = Math.round(run.fuel);
  const fuelInt = roundedFuel < 0 ? 0 : roundedFuel > 100 ? 100 : roundedFuel;

  // Distance: round to nearest 0.1 m, format to one decimal place (Req 9.3).
  const roundedDistance = Math.round(run.distanceTraveled * 10) / 10;
  const distanceText = `${roundedDistance.toFixed(1)} m`;

  return {
    fuelInt,
    distanceText,
    status: run.status,
    endReason: run.endReason,
  };
}
