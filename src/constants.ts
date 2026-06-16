// Shared tuning constants for the 3D Car Hill-Climb game.
//
// These values are referenced across the pure-logic core, the physics engine,
// and the asset loader. Each is annotated with the requirement it derives from.

// ---------------------------------------------------------------------------
// Physics tuning
// ---------------------------------------------------------------------------

/** World gravity along Y, in m/s^2. (Req 4.3) */
export const GRAVITY_Y = -9.81;

/** Fixed physics timestep in seconds (16.67 ms). (Req 10.2) */
export const FIXED_DT = 1 / 60;

// ---------------------------------------------------------------------------
// Fuel (Req 7)
// ---------------------------------------------------------------------------

/** Starting fuel level for a fresh run. (Req 7.1) */
export const START_FUEL = 1000;

/** Fuel units consumed per second at throttle 1.0. (Req 7.2) */
export const FUEL_BURN_RATE = 5;

// ---------------------------------------------------------------------------
// Run lifecycle / balance (Req 8, 9)
// ---------------------------------------------------------------------------

/** Horizontal speed (m/s) above which a run is considered started. (Req 9.1) */
export const RUN_START_SPEED = 0.5;

/** Pitch/roll angle (degrees) beyond which the chassis is past the overturn threshold. (Req 8.2) */
export const OVERTURN_ANGLE = 75;

/** Continuous seconds past the overturn angle required to latch overturned. (Req 8.2) */
export const OVERTURN_HOLD = 1.5;

// ---------------------------------------------------------------------------
// Surface friction (Req 6.5)
// ---------------------------------------------------------------------------

/** Minimum allowed surface friction coefficient. (Req 6.5) */
export const FRICTION_MIN = 0.05;

/** Maximum allowed surface friction coefficient. (Req 6.5) */
export const FRICTION_MAX = 1.5;

/**
 * Default/global terrain friction applied to the terrain collider and used as
 * the fallback for regions absent from the friction lookup. (Req 6.5)
 *
 * Note: in Rapier's raycast vehicle, longitudinal/lateral traction is driven
 * primarily by each wheel's `frictionSlip`; the collider friction set here
 * combines with the wheel value and governs non-vehicle contacts. 1.0 is a
 * neutral, grippy default that does not artificially reduce wheel traction.
 */
export const DEFAULT_TERRAIN_FRICTION = 1.0;

// ---------------------------------------------------------------------------
// Reverse drive (arcade reverse via the brake / down control)
// ---------------------------------------------------------------------------

/**
 * Forward speed (m/s) at or below which the brake (down) control engages
 * reverse drive instead of braking. Above this the same control brakes.
 */
export const REVERSE_SPEED_THRESHOLD = 1.0;

/** Reverse engine force as a fraction of the configured forward maximum. */
export const REVERSE_FORCE_SCALE = 0.8;

// ---------------------------------------------------------------------------
// Steering (Req 2, 5)
// ---------------------------------------------------------------------------

/** Maximum control steering angle in degrees (-/+). (Req 5.3) */
export const CONTROL_STEER_LIMIT = 35;

/** Maximum visual steering angle in degrees (-/+). (Req 2.3, 2.4) */
export const VISUAL_STEER_LIMIT = 45;

// ---------------------------------------------------------------------------
// Tolerances (Req 3, 4)
// ---------------------------------------------------------------------------

/** Maximum allowed wheel penetration into terrain at rest, in metres. (Req 4.5) */
export const REST_PENETRATION_MAX = 0.01;

/** Maximum allowed visual deviation of suspension offset, in metres. (Req 3.5) */
export const SUSPENSION_VIS_TOLERANCE = 0.001;

// ---------------------------------------------------------------------------
// Asset loading (Req 1)
// ---------------------------------------------------------------------------

/** Asset load timeout in milliseconds. (Req 1.3) */
export const LOAD_TIMEOUT_MS = 30_000;

/** Required wheel node names in the vehicle GLB (FL, FR, RL, RR). (Req 1.2, 1.5) */
export const REQUIRED_WHEEL_NODES = ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'] as const;

/** Required chassis node name in the vehicle GLB. (Req 1.2, 1.5) */
export const CHASSIS_NODE = 'chassis';
