// Flight physics — aerodynamic simulation for the plane vehicle.
//
// When the car type is 'plane', this module takes over from the raycast vehicle
// controller. It applies lift, drag, and thrust forces to the chassis rigid body
// each step, and interprets the input differently:
//   W/↑ = increase thrust
//   S/↓ = decrease thrust
//   A/← = roll left
//   D/→ = roll right
//   (Pitch is auto-controlled: the plane pitches toward the steering direction)
//
// Takeoff: the plane drives on its landing gear (normal raycast vehicle) until
// airspeed > TAKEOFF_SPEED, then transitions to flight mode.
// Landing: when altitude is very low and speed is below a threshold, it
// transitions back to ground mode.

import type { Vec3, DriveCommand } from '../types';
import type { RapierPhysicsEngine } from './physics-engine';

const TAKEOFF_SPEED = 18; // m/s before lift overcomes weight
const LIFT_COEFFICIENT = 0.035; // lift per (speed^2)
const DRAG_COEFFICIENT = 0.008; // drag per (speed^2)
const THRUST_MAX = 12000; // N at full throttle
const ROLL_RATE = 2.5; // rad/s

export class FlightController {
  private thrust = 0;
  private airborne = false;

  /** Whether the plane is currently in flight mode. */
  isAirborne(): boolean {
    return this.airborne;
  }

  /**
   * Apply flight forces each fixed step. Returns true if in flight mode
   * (so the caller should skip the raycast vehicle step).
   */
  step(
    physics: RapierPhysicsEngine,
    cmd: DriveCommand,
    dt: number,
  ): boolean {
    const state = physics.readState();
    const speed = state.horizontalSpeed;

    // Transition to flight when fast enough and has upward velocity or is
    // already off the ground.
    if (!this.airborne) {
      if (speed > TAKEOFF_SPEED) {
        this.airborne = true;
      } else {
        // Still on ground — let the raycast vehicle handle it.
        // Adjust thrust from throttle.
        this.thrust = cmd.throttle * THRUST_MAX;
        return false;
      }
    }

    // Check for landing: very low altitude + low speed + descending.
    if (this.airborne && state.chassisPosition.y < 3 && speed < TAKEOFF_SPEED * 0.7) {
      this.airborne = false;
      return false;
    }

    // --- Flight mode ---
    this.thrust = cmd.throttle * THRUST_MAX;

    // Lift: proportional to speed^2, opposes gravity.
    const lift = LIFT_COEFFICIENT * speed * speed;
    // Drag: opposes motion.
    const drag = DRAG_COEFFICIENT * speed * speed;

    // Get forward direction from chassis orientation.
    const q = state.chassisQuaternion;
    // Forward is +Z in our coordinate system.
    const fwdX = 2 * (q.x * q.z + q.w * q.y);
    const fwdY = 2 * (q.y * q.z - q.w * q.x);
    const fwdZ = 1 - 2 * (q.x * q.x + q.y * q.y);

    // Apply thrust along forward.
    const thrustForce: Vec3 = {
      x: fwdX * this.thrust,
      y: fwdY * this.thrust,
      z: fwdZ * this.thrust,
    };
    physics.applyChassisImpulse({
      x: thrustForce.x * dt,
      y: thrustForce.y * dt + lift * dt,
      z: thrustForce.z * dt,
    });

    // Apply drag opposing velocity.
    physics.applyChassisImpulse({
      x: -fwdX * drag * dt,
      y: 0,
      z: -fwdZ * drag * dt,
    });

    // Roll from A/D steering input.
    // We can't directly set angular velocity easily through impulses alone,
    // but we can apply a torque-like impulse around the forward axis.
    if (Math.abs(cmd.steerDeg) > 1) {
      const rollImpulse = -cmd.steerDeg / 35 * ROLL_RATE * 500 * dt;
      physics.applyChassisImpulse({ x: 0, y: rollImpulse * 0.01, z: 0 });
    }

    return true;
  }
}
