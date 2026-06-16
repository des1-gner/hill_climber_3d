// Pure input resolution for the 3D Car Hill-Climb game.
//
// `resolveInput` takes a raw, unvalidated input sample (which may contain
// out-of-range or non-finite channel values) and produces a clean, clamped,
// and arbitrated `DriveCommand` for a single frame.
//
// Requirements covered:
// - 5.1 Throttle is a normalized magnitude in [0, 1].
// - 5.2 Brake is a normalized magnitude in [0, 1].
// - 5.3 Steering is clamped to [-CONTROL_STEER_LIMIT, +CONTROL_STEER_LIMIT].
// - 5.4 Released inputs (all zero) resolve to a neutral (0, 0, 0) command.
// - 5.6 When both throttle and brake are active, brake wins and throttle is
//        suppressed for that frame (brake-over-throttle arbitration).
// - 5.7 Out-of-range values clamp to the nearest in-range bound; in-range
//        values pass through unchanged.

import type { DriveCommand, RawInput } from '../types';
import { CONTROL_STEER_LIMIT } from '../constants';

/**
 * Coerce a possibly non-finite value (NaN, +/-Infinity) to a safe default.
 * Finite values pass through unchanged. (Req 5.7, defensive handling)
 */
function coerceFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Clamp `value` to the inclusive range [min, max]. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Resolve a raw input sample into a clamped, arbitrated drive command.
 *
 * Processing order (important):
 * 1. Coerce non-finite channel values to 0 BEFORE clamping (Req 5.7).
 * 2. Clamp throttle to [0, 1], brake to [0, 1], steer to
 *    [-CONTROL_STEER_LIMIT, +CONTROL_STEER_LIMIT] (Req 5.1, 5.2, 5.3, 5.7).
 * 3. Apply brake-over-throttle arbitration: if both throttle and brake are
 *    positive, suppress throttle for this frame (Req 5.6).
 *
 * When all raw inputs are zero, the result is the neutral command (Req 5.4).
 */
export function resolveInput(raw: RawInput): DriveCommand {
  // Step 1 + 2: coerce non-finite values, then clamp to range.
  let throttle = clamp(coerceFinite(raw.throttle), 0, 1);
  const brake = clamp(coerceFinite(raw.brake), 0, 1);
  const steerDeg = clamp(
    coerceFinite(raw.steer),
    -CONTROL_STEER_LIMIT,
    CONTROL_STEER_LIMIT,
  );

  // Step 3: brake-over-throttle arbitration (Req 5.6).
  if (throttle > 0 && brake > 0) {
    throttle = 0;
  }

  return { throttle, brake, steerDeg };
}
