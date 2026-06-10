// Pure suspension logic for the 3D Car Hill-Climb game.
//
// These functions are extracted from the physics engine so they can be unit-
// and property-tested without Rapier, Three.js, a browser, or a GPU. They
// operate purely on plain numbers.
//
// Requirements covered:
// - 3.2 Compression on contact = restLength - contactDistance, clamped >= 0
// - 3.3 Out of contact => full extension (maxTravel)
// - 3.4 Compression constrained to [minTravel, maxTravel]
// - 3.5 Wheel vertical offset reflects current compression

/**
 * Clamp `value` into the inclusive range `[min, max]`.
 *
 * If `min > max` (a misconfiguration) the function still returns a value within
 * the intended range by collapsing to `min`, keeping the result well-defined.
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Compute a wheel's suspension compression along the suspension axis.
 *
 * Behavior (Req 3.2, 3.3, 3.4):
 * - When the wheel is in contact with the terrain, compression is the amount
 *   the suspension has been pushed in: `max(0, restLength - contactDistance)`.
 *   A contact distance greater than the rest length (fully extended, barely
 *   touching) yields 0 rather than a negative value.
 * - When the wheel is NOT in contact, the suspension sits at full extension,
 *   which is represented by the maximum travel limit (`maxTravel`).
 * - In every case the result is constrained to the inclusive travel range
 *   `[minTravel, maxTravel]`, holding at the nearest limit when a computed
 *   value falls outside the range.
 *
 * @param restLength      Suspension rest length in metres (> 0 per Req 3.1).
 * @param contactDistance Measured ray distance from the mount point to the
 *                        terrain contact, in metres.
 * @param minTravel       Minimum travel limit in metres.
 * @param maxTravel       Maximum travel limit (full extension) in metres.
 * @param inContact       Whether the wheel's ray hit the terrain this step.
 * @returns Suspension compression in metres, always within [minTravel, maxTravel].
 */
export function computeSuspensionCompression(
  restLength: number,
  contactDistance: number,
  minTravel: number,
  maxTravel: number,
  inContact: boolean,
): number {
  if (!inContact) {
    // Full extension when there is no terrain contact (Req 3.3). Still clamp so
    // the returned value honors the defined travel range (Req 3.4).
    return clamp(maxTravel, minTravel, maxTravel);
  }

  const rawCompression = Math.max(0, restLength - contactDistance);
  return clamp(rawCompression, minTravel, maxTravel);
}

/**
 * Compute the vertical position offset of a wheel mesh relative to the chassis,
 * reflecting the current suspension compression (Req 3.5).
 *
 * Sign convention:
 * - The offset is measured along the chassis-local downward suspension axis,
 *   expressed as a Y offset where NEGATIVE is downward (away from the chassis).
 * - At full extension (`compression == 0`) the wheel hangs the full rest length
 *   below its mount point, so the offset is `-restLength`.
 * - As the suspension compresses, the wheel moves UP toward the chassis, so the
 *   offset increases toward 0. At full compression (`compression == restLength`)
 *   the offset is 0 (wheel sits at the mount point).
 *
 * Formula: `offset = -(restLength - compression)`.
 *
 * @param restLength  Suspension rest length in metres.
 * @param compression Current suspension compression in metres.
 * @returns The wheel's local vertical (Y) offset relative to the chassis, where
 *          negative values point downward.
 */
export function wheelVerticalOffset(restLength: number, compression: number): number {
  return -(restLength - compression);
}
