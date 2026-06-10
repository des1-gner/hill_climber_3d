// Pure wheel kinematics for the Renderer's wheel synchronization.
//
// These functions are side-effect-free and decoupled from Three.js so they can
// be unit- and property-tested without a browser or GPU.

import { VISUAL_STEER_LIMIT } from '../constants';

/**
 * Angular change (radians) to advance a wheel mesh about its axle this frame.
 *
 * Equals `(groundSpeed / wheelRadius) * dt`. The sign of the result follows the
 * sign of `groundSpeed`, so reverse motion spins the wheel opposite to forward
 * motion (Req 2.2). When `groundSpeed` is exactly 0 the result is exactly 0,
 * holding the wheel at a constant angle (Req 2.6).
 *
 * Guards against a non-positive `wheelRadius` (returns 0) to avoid division by
 * zero or sign inversion from a negative radius.
 *
 * @param groundSpeed Wheel linear ground speed in m/s (signed: negative = reverse).
 * @param wheelRadius Wheel radius in metres.
 * @param dt Frame duration in seconds.
 * @returns Angular delta in radians for this frame.
 *
 * Requirements: 2.1, 2.2, 2.6
 */
export function wheelSpinDelta(groundSpeed: number, wheelRadius: number, dt: number): number {
  if (!(wheelRadius > 0)) {
    return 0;
  }
  return (groundSpeed / wheelRadius) * dt;
}

/**
 * Clamp a commanded steering angle to the visual steering range
 * [-VISUAL_STEER_LIMIT, +VISUAL_STEER_LIMIT] degrees.
 *
 * Returns the input unchanged when already in range, and the nearest bound when
 * out of range. Non-finite inputs (NaN, +/-Infinity) are coerced to 0.
 *
 * @param commandedDeg Commanded steering angle in degrees.
 * @returns Clamped steering angle in degrees within [-45, +45].
 *
 * Requirements: 2.3, 2.4
 */
export function clampVisualSteer(commandedDeg: number): number {
  if (!Number.isFinite(commandedDeg)) {
    return 0;
  }
  if (commandedDeg > VISUAL_STEER_LIMIT) {
    return VISUAL_STEER_LIMIT;
  }
  if (commandedDeg < -VISUAL_STEER_LIMIT) {
    return -VISUAL_STEER_LIMIT;
  }
  return commandedDeg;
}
