// Pure orientation extraction for the Physics_Engine's balance detection.
//
// This function is side-effect-free and decoupled from Three.js / Rapier so it
// can be unit- and property-tested without a browser, GPU, or WASM runtime.

import type { Quat } from '../types';

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Extract the chassis pitch and roll angles (in degrees) relative to the
 * horizontal ground plane from an orientation quaternion (Req 8.1).
 *
 * ## Euler convention
 *
 * We use a **Y-up, intrinsic Tait–Bryan `YXZ`** decomposition. With the body's
 * local axes being X = right (the wheel axle / lateral axis), Y = up, and
 * Z = forward, an orientation is composed as:
 *
 * ```
 *   q = qYaw(about Y) * qPitch(about X) * qRoll(about Z)
 * ```
 *
 * applied to a body-space vector as `v_world = Ry(yaw) · Rx(pitch) · Rz(roll) · v_body`.
 *
 * - **pitch** is rotation about the lateral X axis (nose up / nose down).
 * - **roll**  is rotation about the forward Z axis (banking left / right).
 * - **yaw**   is rotation about the up Y axis (heading) and is *not* returned.
 *
 * A key property of this `YXZ` ordering is that the extracted pitch and roll are
 * **independent of yaw**: the matrix row used for extraction (`R10`, `R11`,
 * `R12`) carries no yaw term, so heading does not contaminate the tilt angles.
 *
 * To build a matching quaternion for round-trip testing (Property 14), construct
 * `q = qPitch(X) * qRoll(Z)` (yaw = 0), or include a leading `qYaw(Y)` — either
 * way the recovered pitch/roll are unaffected by the yaw factor.
 *
 * ### Extraction formulas
 *
 * From the rotation matrix `R = Ry·Rx·Rz`:
 * - `pitch = asin(-R12) = asin(2 · (w·x − y·z))`
 * - `roll  = atan2(R10, R11) = atan2(2 · (x·y + w·z), 1 − 2 · (x² + z²))`
 *
 * ### Valid range (for round-trip)
 *
 * Pitch is recovered in `[-90°, +90°]` via `asin`; roll in `(-180°, +180°]` via
 * `atan2`. Round-trip is exact (within numerical tolerance) for pitch in
 * `(-90°, +90°)` and roll in `(-180°, +180°]`. At pitch = ±90° the decomposition
 * is at gimbal lock and roll is no longer uniquely determined.
 *
 * ## Robustness
 *
 * The quaternion is normalized defensively. A degenerate (near-zero norm)
 * quaternion falls back to the identity orientation (pitch = 0, roll = 0). The
 * `asin` argument is clamped to `[-1, 1]` so the output is always finite.
 *
 * @param q A (not necessarily normalized) orientation quaternion.
 * @returns Pitch and roll in degrees, both guaranteed finite.
 *
 * Requirements: 8.1
 */
export function pitchRollFromQuaternion(q: Quat): { pitchDeg: number; rollDeg: number } {
  let { x, y, z, w } = q;

  // Defensive normalization. If any component is non-finite or the norm is
  // effectively zero, fall back to the identity orientation.
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!Number.isFinite(norm) || norm < 1e-8) {
    return { pitchDeg: 0, rollDeg: 0 };
  }
  const inv = 1 / norm;
  x *= inv;
  y *= inv;
  z *= inv;
  w *= inv;

  // pitch = asin(-R12), with R12 = 2 (y z - w x)  ->  arg = 2 (w x - y z)
  let sinPitch = 2 * (w * x - y * z);
  // Clamp to the valid asin domain so the result is always finite.
  if (sinPitch > 1) {
    sinPitch = 1;
  } else if (sinPitch < -1) {
    sinPitch = -1;
  }
  const pitch = Math.asin(sinPitch);

  // roll = atan2(R10, R11)
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const roll = Math.atan2(r10, r11);

  return {
    pitchDeg: pitch * RAD_TO_DEG,
    rollDeg: roll * RAD_TO_DEG,
  };
}
