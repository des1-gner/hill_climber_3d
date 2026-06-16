// Pure surface-friction logic for the 3D Car Hill-Climb game.
//
// Extracted from the physics engine so the friction-coefficient bounds (Req
// 6.5) can be unit- and property-tested without Rapier, Three.js, a browser,
// or a GPU. These functions operate purely on plain data.
//
// Requirements covered:
// - 6.5 Surface friction coefficients are constrained to [0.05, 1.50]

import { FRICTION_MIN, FRICTION_MAX, DEFAULT_TERRAIN_FRICTION } from '../constants';

/**
 * Clamp a surface friction coefficient into the inclusive range
 * `[FRICTION_MIN, FRICTION_MAX]` = `[0.05, 1.50]` (Req 6.5).
 *
 * Non-finite inputs (`NaN`, `Infinity`) are coerced to the default terrain
 * friction so the result is always a usable, in-range coefficient.
 *
 * @param value A raw friction coefficient (possibly out of range or non-finite).
 * @returns A finite coefficient within [0.05, 1.50].
 */
export function clampFriction(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TERRAIN_FRICTION;
  }
  if (value < FRICTION_MIN) {
    return FRICTION_MIN;
  }
  if (value > FRICTION_MAX) {
    return FRICTION_MAX;
  }
  return value;
}

/**
 * Resolve the friction coefficient for a named terrain region from a lookup
 * table, falling back to the default terrain friction when the region is
 * absent. The returned value is always clamped into [0.05, 1.50] (Req 6.5),
 * regardless of how the table was populated.
 *
 * @param frictionByRegion Lookup of region/material key -> raw coefficient.
 * @param region           The region/material key to resolve, if known.
 * @param fallback         Coefficient used when the region is missing.
 *                         Defaults to {@link DEFAULT_TERRAIN_FRICTION}.
 * @returns A finite coefficient within [0.05, 1.50].
 */
export function resolveRegionFriction(
  frictionByRegion: Map<string, number> | undefined,
  region: string | undefined,
  fallback: number = DEFAULT_TERRAIN_FRICTION,
): number {
  const raw =
    region !== undefined && frictionByRegion !== undefined && frictionByRegion.has(region)
      ? (frictionByRegion.get(region) as number)
      : fallback;
  return clampFriction(raw);
}
