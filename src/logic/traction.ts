// Pure traction logic for the 3D Car Hill-Climb game.
//
// Extracted from the physics engine so the traction cap can be unit- and
// property-tested without Rapier, Three.js, a browser, or a GPU.
//
// Requirements covered:
// - 6.1 Traction limit = surface friction coefficient * normal force
// - 6.2 Transmitted drive force capped at the traction limit
// - 6.3 Demand above the limit implies slip (the cap is the precondition)
// - 6.4 A wheel with no terrain contact transmits zero drive force

/**
 * Cap the drive force transmitted through a wheel contact point at the
 * available traction limit.
 *
 * The available traction limit is the product of the surface friction
 * coefficient at the contact point and the normal force at that point
 * (Req 6.1): `tractionLimit = frictionCoeff * normalForce`.
 *
 * Behavior:
 * - When the wheel is in contact, the transmitted force is
 *   `min(demandedForce, tractionLimit)` (Req 6.2). Whenever the demanded force
 *   exceeds the limit, the excess cannot be transmitted and the wheel slips
 *   (Req 6.3).
 * - When the wheel is NOT in contact, zero force is transmitted (Req 6.4).
 *
 * Note on the signature: the design lists this as
 * `capDriveForce(demandedForce, frictionCoeff, normalForce)`. The optional
 * `inContact` parameter (default `true`) is added so the no-contact zero-force
 * case (Req 6.4) is handled by the same pure function; callers that have
 * already established contact can omit it.
 *
 * @param demandedForce The drive force demanded at the contact point, in N.
 * @param frictionCoeff The surface friction coefficient at the contact point.
 * @param normalForce   The normal force at the contact point, in N.
 * @param inContact     Whether the wheel is in contact with the terrain.
 *                      Defaults to `true`.
 * @returns The transmitted drive force, never exceeding the traction limit and
 *          0 when there is no contact.
 */
export function capDriveForce(
  demandedForce: number,
  frictionCoeff: number,
  normalForce: number,
  inContact = true,
): number {
  if (!inContact) {
    return 0;
  }

  const tractionLimit = frictionCoeff * normalForce;
  return Math.min(demandedForce, tractionLimit);
}
