// Physics_Engine — Rapier (WASM) raycast-vehicle wrapper.
//
// This is the thin I/O shell described in design.md's "Physics_Engine
// (Rapier raycast vehicle)" section. It owns the Rapier `World`, the chassis
// `RigidBody`, the `DynamicRayCastVehicleController`, and the terrain collider,
// and exposes the plain-data `VehicleState` consumed by the game loop.
//
// All testable rules (suspension compression, traction capping, pitch/roll
// extraction) are delegated to the pure-logic core under `src/logic/` rather
// than reimplemented here.
//
// Requirements: 3.1, 3.2, 3.3, 4.3, 4.4, 4.5, 6.1, 6.2, 6.4, 6.5, 8.1

import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';

import { GRAVITY_Y, FIXED_DT, DEFAULT_TERRAIN_FRICTION, REVERSE_SPEED_THRESHOLD, REVERSE_FORCE_SCALE } from '../constants';
import type {
  DriveCommand,
  Quat,
  TerrainModel,
  Vec3,
  VehicleConfig,
  VehicleState,
  WheelConfig,
  WheelState,
} from '../types';

import { clampFriction } from '../logic/friction';
import { pitchRollFromQuaternion } from '../logic/orientation';
import { computeSuspensionCompression } from '../logic/suspension';
import { capDriveForce } from '../logic/traction';

/**
 * How the terrain collider geometry is built:
 * - `trimesh`  — an exact triangle mesh extracted from the loaded geometry.
 *                Matches the visuals precisely; preferred for the generated
 *                hilly terrain (Req 4.1).
 * - `heightfield` — a regular-grid heightfield collider, cheaper to evaluate.
 *                Only valid when the terrain mesh is a regular grid.
 */
export type TerrainColliderKind = 'trimesh' | 'heightfield';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * The Physics_Engine port (design.md). Implemented over Rapier below.
 *
 * `init` accepts either a raw Three.js scene graph (the terrain visual) or a
 * full {@link TerrainModel}. When a `TerrainModel` is supplied, its
 * `colliderKind` and `frictionByRegion` drive collider construction and surface
 * friction (Req 4.1, 6.5).
 */
export interface PhysicsEngine {
  init(wheels: WheelConfig[], terrain?: THREE.Object3D | TerrainModel): Promise<void>;
  setGravity(y: number): void;
  applyCommand(cmd: DriveCommand, fuelEmpty: boolean, damageFactor?: number): void;
  step(dt: number): void;
  readState(): VehicleState;
  reset(toPosition: Vec3): void;
}

/**
 * Rapier-backed raycast vehicle.
 *
 * The chassis is a single dynamic rigid body carrying a cuboid collider sized
 * from `VehicleConfig.chassisHalfExtents`. Four ray-cast wheels are attached to
 * a `DynamicRayCastVehicleController`, each configured from its `WheelConfig`.
 *
 * Coordinate convention (matches `src/logic/orientation.ts`): Y is up, Z is the
 * forward axis, X is the lateral / axle axis. Wheels cast downward along
 * `(0, -1, 0)` with axle direction `(-1, 0, 0)`.
 */
export class RapierPhysicsEngine implements PhysicsEngine {
  private readonly config: VehicleConfig;

  private world!: RAPIER.World;
  private chassis!: RAPIER.RigidBody;
  private controller!: RAPIER.DynamicRayCastVehicleController;
  private terrainBody: RAPIER.RigidBody | null = null;

  /** Per-wheel configuration, indexed to match the controller's wheel order. */
  private wheelConfigs: WheelConfig[] = [];

  /** Active landslide debris bodies (dynamic rocks) and their radii. */
  private readonly debris: Array<{ body: RAPIER.RigidBody; radius: number }> = [];

  /** Max simultaneous debris bodies; oldest are recycled beyond this. */
  private static readonly MAX_DEBRIS = 64;

  /** Static bodies (streamed terrain chunks + stone obstacles), keyed by id. */
  private readonly staticBodies = new Map<number, RAPIER.RigidBody>();
  private nextStaticId = 1;

  // Scratch objects reused for per-frame wheel-surface sampling.
  private readonly _scratchVec = new THREE.Vector3();
  private readonly _scratchQuat = new THREE.Quaternion();

  /** Default spawn height so the chassis starts clear of the origin. */
  private static readonly DEFAULT_SPAWN: Vec3 = { x: 0, y: 2, z: 0 };

  constructor(config: VehicleConfig) {
    this.config = config;
  }

  /**
   * Initialize the Rapier world, chassis, vehicle controller, wheels, and the
   * terrain collider. Must be awaited before any other method.
   *
   * @param wheels  Per-wheel configuration (length 4: FL, FR, RL, RR).
   * @param terrain The loaded terrain scene graph, or a {@link TerrainModel}
   *                carrying the visual plus `colliderKind`/`frictionByRegion`.
   */
  async init(wheels: WheelConfig[], terrain?: THREE.Object3D | TerrainModel): Promise<void> {
    await RAPIER.init();

    this.wheelConfigs = wheels.length > 0 ? wheels : this.config.wheels;

    // World with downward gravity (Req 4.3) and the fixed simulation timestep
    // (Req 10.2). The accumulator in the game loop also steps at FIXED_DT.
    this.world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
    this.world.timestep = FIXED_DT;

    // Chassis: one dynamic rigid body with a cuboid collider sized from the
    // configured half extents. The collider carries the chassis mass.
    const spawn = RapierPhysicsEngine.DEFAULT_SPAWN;
    const chassisDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      // High angular damping makes it very resistant to rolling/flipping.
      .setAngularDamping(3.0);
    // Shift centre of mass downward so the car is bottom-heavy and self-rights.
    chassisDesc.centerOfMass = { x: 0, y: -0.4, z: 0 };
    this.chassis = this.world.createRigidBody(chassisDesc);

    const he = this.config.chassisHalfExtents;
    // The cuboid collider covers the entire car body (top, sides, bottom) so
    // terrain contact happens on all faces, not just the wheels.
    const chassisCollider = RAPIER.ColliderDesc.cuboid(he.x, he.y, he.z)
      .setMass(this.config.chassisMass)
      .setFriction(0.4)
      .setRestitution(0.1);
    this.world.createCollider(chassisCollider, this.chassis);

    // Raycast-vehicle controller driven by the chassis body.
    this.controller = this.world.createVehicleController(this.chassis);
    // Y-up convention to match the pure orientation math (Req 8.1).
    this.controller.indexUpAxis = 1;

    // Suspension axis points straight down; axle runs along local -X.
    const downDir: RAPIER.Vector = { x: 0, y: -1, z: 0 };
    const axleDir: RAPIER.Vector = { x: -1, y: 0, z: 0 };

    for (const w of this.wheelConfigs) {
      const connection: RAPIER.Vector = {
        x: w.connectionPointLocal.x,
        y: w.connectionPointLocal.y,
        z: w.connectionPointLocal.z,
      };
      this.controller.addWheel(connection, downDir, axleDir, w.suspensionRestLength, w.radius);

      const i = w.index;
      // Suspension tuning (Req 3.1). Rapier exposes separate compression and
      // relaxation damping; we drive both from the single configured damping.
      this.controller.setWheelSuspensionStiffness(i, w.suspensionStiffness);
      this.controller.setWheelSuspensionCompression(i, w.suspensionDamping);
      this.controller.setWheelSuspensionRelaxation(i, w.suspensionDamping);
      this.controller.setWheelMaxSuspensionTravel(i, w.maxSuspensionTravel);
      // Surface traction coefficient (Req 6.5).
      this.controller.setWheelFrictionSlip(i, w.frictionSlip);
    }

    this.buildTerrainCollider(terrain);
  }

  /**
   * Build the single-mesh terrain collider used by the finite-patch path
   * (integration tests / authored GLB). The streaming world instead calls
   * {@link addTerrainChunk} per chunk and passes no `terrain` to {@link init}.
   */
  private buildTerrainCollider(terrain?: THREE.Object3D | TerrainModel): void {
    if (!terrain) {
      return;
    }
    const model = toTerrainModel(terrain);
    const visual = model.visual;

    // Resolve the global/default surface friction, clamped to [0.05, 1.50].
    const globalFriction = clampFriction(resolveGlobalFriction(model.frictionByRegion));

    // Fixed (static) rigid body so the terrain never moves (Req 4.4, 4.5).
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    const colliderDesc = this.buildTerrainColliderDesc(visual, model.colliderKind);
    if (colliderDesc) {
      // Per-region friction is primarily applied per-wheel; the collider carries
      // the global default so general contacts behave sensibly (Req 6.5).
      colliderDesc.setFriction(globalFriction);
      this.world.createCollider(colliderDesc, body);
    } else {
      // Fallback: a large thin ground slab centered at the origin so the world
      // always has a floor even when no terrain geometry is present.
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(500, 0.5, 500)
          .setTranslation(0, -0.5, 0)
          .setFriction(globalFriction),
        body,
      );
    }

    this.terrainBody = body;
  }

  /**
   * Build the Rapier collider description for the terrain geometry, honoring the
   * requested {@link TerrainColliderKind}. Returns `null` when the geometry
   * carries no usable mesh data (the caller then installs a flat-ground
   * fallback).
   */
  private buildTerrainColliderDesc(
    visual: THREE.Object3D,
    kind: TerrainColliderKind,
  ): RAPIER.ColliderDesc | null {
    if (kind === 'heightfield') {
      const field = extractHeightfield(visual);
      if (field) {
        // Rapier heightfield: (nrows, ncols, heights, scale). Heights are
        // sampled on a regular grid in world space.
        return RAPIER.ColliderDesc.heightfield(
          field.nrows,
          field.ncols,
          field.heights,
          field.scale,
        );
      }
      // Irregular geometry: fall through to a trimesh so collision is preserved.
    }

    const mesh = extractTrimesh(visual);
    if (mesh && mesh.indices.length > 0) {
      return RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices);
    }
    return null;
  }

  /** The static rigid body holding the terrain collider, or null before init. */
  getTerrainBody(): RAPIER.RigidBody | null {
    return this.terrainBody;
  }

  /** Set world gravity along Y (Req 4.3). */
  setGravity(y: number): void {
    this.world.gravity = { x: 0, y, z: 0 };
  }

  /**
   * Map a resolved drive command onto the vehicle controller.
   *
   * - Forward drive: throttle * maxEngineForce on driven wheels (zeroed when
   *   fuel is empty, Req 6.4/7.4).
   * - The brake/down control is context-sensitive (arcade reverse): while the
   *   vehicle is moving forward faster than `REVERSE_SPEED_THRESHOLD` it applies
   *   braking force; once stopped or already rolling backward it instead applies
   *   reverse engine force (a fraction of the forward maximum).
   * - Steering is applied to the steered wheels. The commanded angle is negated
   *   here so that a "left" command turns the vehicle left in world space
   *   (corrects the previously inverted steering).
   */
  applyCommand(cmd: DriveCommand, fuelEmpty: boolean, damageFactor = 1): void {
    // damageFactor: 1 = pristine handling, approaches 0 = nearly undrivable.
    // No floor — damage accumulates forever, making it progressively harder.
    const df = Math.max(0.05, Math.min(1, damageFactor));

    // Negate to correct the steering inversion: +steerDeg (right) must turn the
    // vehicle right.
    const steerRad = -cmd.steerDeg * DEG_TO_RAD * df;

    // Signed forward speed (positive = forward) used to decide brake vs reverse.
    const forwardSpeed = this.controller.currentVehicleSpeed();

    let engineForce = 0;
    let brakeForce = 0;

    if (cmd.throttle > 0) {
      // Forward acceleration (scaled by damage).
      engineForce = fuelEmpty ? 0 : cmd.throttle * this.config.maxEngineForce * df;
    } else if (cmd.brake > 0) {
      if (forwardSpeed > REVERSE_SPEED_THRESHOLD) {
        // Still moving forward: the down control brakes.
        brakeForce = cmd.brake * this.config.maxBrakeForce;
      } else {
        // Stopped or already reversing: drive backward at a reduced force.
        engineForce = fuelEmpty
          ? 0
          : -cmd.brake * this.config.maxEngineForce * REVERSE_FORCE_SCALE * df;
      }
    }

    for (const w of this.wheelConfigs) {
      const i = w.index;
      this.controller.setWheelEngineForce(i, w.isDriven ? engineForce : 0);
      this.controller.setWheelBrake(i, brakeForce);
      this.controller.setWheelSteering(i, w.isSteered ? steerRad : 0);
    }
  }

  /**
   * Advance the simulation by `dt`. The vehicle controller raycasts the wheels
   * and resolves suspension/traction before the world integrates (Req 10.2).
   */
  step(dt: number): void {
    this.controller.updateVehicle(dt);
    this.world.step();
    this.applyDebrisImpacts();
  }

  /**
   * Extract the current vehicle state as plain data for the game loop and
   * renderer. Pitch/roll come from the pure orientation helper, suspension
   * compression from the pure suspension helper, and the per-wheel applied
   * drive force from the pure traction cap.
   */
  readState(): VehicleState {
    const t = this.chassis.translation();
    const r = this.chassis.rotation();
    const v = this.chassis.linvel();

    const chassisPosition: Vec3 = { x: t.x, y: t.y, z: t.z };
    const chassisQuaternion = { x: r.x, y: r.y, z: r.z, w: r.w };

    // Signed forward speed from the controller; horizontal speed in the XZ plane.
    const linearSpeed = this.controller.currentVehicleSpeed();
    const horizontalSpeed = Math.hypot(v.x, v.z);

    const { pitchDeg, rollDeg } = pitchRollFromQuaternion(chassisQuaternion);

    const wheels: WheelState[] = this.wheelConfigs.map((w) => {
      const i = w.index;
      const inContact = this.controller.wheelIsInContact(i);
      const suspensionLength = this.controller.wheelSuspensionLength(i) ?? w.suspensionRestLength;

      // Compression via the pure helper (Req 3.2, 3.3, 3.4). The suspension
      // length is the ray distance to contact; minTravel is 0, maxTravel is the
      // configured suspension travel.
      const suspensionCompression = computeSuspensionCompression(
        w.suspensionRestLength,
        suspensionLength,
        0,
        w.maxSuspensionTravel,
        inContact,
      );

      const n = this.controller.wheelContactNormal(i);
      const contactNormal: Vec3 = n ? { x: n.x, y: n.y, z: n.z } : { x: 0, y: 0, z: 0 };

      const steerRad = this.controller.wheelSteering(i) ?? 0;
      const steerDeg = steerRad * RAD_TO_DEG;

      // Suspension force approximates the contact normal force used for the
      // traction limit (Req 6.1).
      const normalForce = this.controller.wheelSuspensionForce(i) ?? 0;
      const tractionLimit = w.frictionSlip * normalForce;

      // Demanded engine force this step, capped at the traction limit via the
      // pure helper (Req 6.2, 6.4).
      const demanded = this.controller.wheelEngineForce(i) ?? 0;
      const sign = demanded < 0 ? -1 : 1;
      const appliedDriveForce =
        sign * capDriveForce(Math.abs(demanded), w.frictionSlip, normalForce, inContact);

      // Longitudinal slip model (Req 6.3): demand beyond the traction limit
      // produces slip. Kept finite and non-negative.
      let slipRatio = 0;
      if (inContact && tractionLimit > 1e-6) {
        slipRatio = Math.max(0, (Math.abs(demanded) - tractionLimit) / tractionLimit);
      } else if (inContact && Math.abs(demanded) > 1e-6) {
        slipRatio = 1;
      }
      if (!Number.isFinite(slipRatio)) {
        slipRatio = 0;
      }

      return {
        index: w.index,
        inContact,
        suspensionLength,
        suspensionCompression,
        contactNormal,
        steerDeg,
        normalForce,
        tractionLimit,
        appliedDriveForce,
        slipRatio,
      };
    });

    return {
      chassisPosition,
      chassisQuaternion,
      linearSpeed,
      horizontalSpeed,
      pitchDeg,
      rollDeg,
      wheels,
    };
  }

  /**
   * Reposition the chassis at `toPosition`, reset its orientation to upright,
   * and zero its linear and angular velocities (Req 9.4 support).
   */
  reset(toPosition: Vec3): void {
    this.chassis.setTranslation({ x: toPosition.x, y: toPosition.y, z: toPosition.z }, true);
    this.chassis.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /**
   * Update each wheel's grip from the surface beneath it (Req 6.5). The mount
   * point of every wheel is transformed into world space and the supplied
   * `frictionAt(x, z)` sampler (e.g. snow vs rock vs grass) gives the friction
   * coefficient, which is clamped to [0.05, 1.50] and applied to that wheel.
   * Called each fixed step so grip changes as the vehicle crosses terrain types
   * (e.g. snow becomes slippery).
   */
  updateSurfaceFriction(frictionAt: (x: number, z: number) => number): void {
    const t = this.chassis.translation();
    const r = this.chassis.rotation();
    this._scratchQuat.set(r.x, r.y, r.z, r.w);
    for (const w of this.wheelConfigs) {
      this._scratchVec
        .set(w.connectionPointLocal.x, w.connectionPointLocal.y, w.connectionPointLocal.z)
        .applyQuaternion(this._scratchQuat);
      const f = clampFriction(frictionAt(t.x + this._scratchVec.x, t.z + this._scratchVec.z));
      this.controller.setWheelFrictionSlip(w.index, f);
    }
  }

  /**
   * Spawn a dynamic "boulder" rigid body for landslides. The rock collides with
   * the terrain and the vehicle and tumbles under gravity. Beyond
   * {@link MAX_DEBRIS} active rocks the oldest is recycled.
   *
   * @param pos spawn position
   * @param radius rock radius
   * @param vel initial linear velocity (e.g. down-slope)
   */
  spawnRock(pos: Vec3, radius: number, vel: Vec3): void {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinvel(vel.x, vel.y, vel.z);
    const body = this.world.createRigidBody(desc);
    body.setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 }, true);

    const collider = RAPIER.ColliderDesc.ball(radius)
      .setDensity(28) // heavy enough to shove the car around
      .setFriction(0.85)
      .setRestitution(0.25);
    this.world.createCollider(collider, body);

    this.debris.push({ body, radius });
    while (this.debris.length > RapierPhysicsEngine.MAX_DEBRIS) {
      const oldest = this.debris.shift();
      if (oldest) this.world.removeRigidBody(oldest.body);
    }
  }

  /** Snapshot the active debris transforms for rendering. */
  getDebris(): Array<{ position: Vec3; quaternion: Quat; radius: number }> {
    return this.debris.map((d) => {
      const t = d.body.translation();
      const r = d.body.rotation();
      return {
        position: { x: t.x, y: t.y, z: t.z },
        quaternion: { x: r.x, y: r.y, z: r.z, w: r.w },
        radius: d.radius,
      };
    });
  }

  /** Remove debris rocks that have fallen below `minY` (off the world). */
  pruneDebris(minY: number): void {
    for (let i = this.debris.length - 1; i >= 0; i -= 1) {
      const d = this.debris[i];
      if (!d) continue;
      if (d.body.translation().y < minY) {
        this.world.removeRigidBody(d.body);
        this.debris.splice(i, 1);
      }
    }
  }

  /**
   * Add a streamed terrain chunk collider (fixed trimesh) from world-space
   * vertices + indices. Returns an id for later {@link removeStaticBody}.
   */
  addTerrainChunk(vertices: Float32Array, indices: Uint32Array, friction: number): number {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(clampFriction(friction));
    this.world.createCollider(collider, body);
    const id = this.nextStaticId++;
    this.staticBodies.set(id, body);
    return id;
  }

  /**
   * Add a static stone obstacle (fixed ball collider) the vehicle can bump into.
   * Returns an id for later {@link removeStaticBody}.
   */
  addStaticBoulder(pos: Vec3, radius: number, friction = 0.9): number {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z),
    );
    const collider = RAPIER.ColliderDesc.ball(radius).setFriction(clampFriction(friction));
    this.world.createCollider(collider, body);
    const id = this.nextStaticId++;
    this.staticBodies.set(id, body);
    return id;
  }

  /** Remove a previously added static body (terrain chunk or stone). */
  removeStaticBody(id: number): void {
    const body = this.staticBodies.get(id);
    if (body) {
      this.world.removeRigidBody(body);
      this.staticBodies.delete(id);
    }
  }

  /** Current chassis position (for entity proximity checks). */
  getChassisPosition(): Vec3 {
    const t = this.chassis.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  /** Apply an instantaneous impulse to the chassis (e.g. a creature shove). */
  applyChassisImpulse(impulse: Vec3): void {
    this.chassis.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }

  /**
   * Shove the chassis when a landslide rock is overlapping it, so debris
   * visibly knocks the car around (in addition to Rapier's own contact
   * resolution). The impulse is along the rock->chassis direction, scaled by the
   * rock's speed; the rock is damped so it doesn't ping-pong.
   */
  private applyDebrisImpacts(): void {
    if (this.debris.length === 0) return;
    const c = this.chassis.translation();
    const reach = 2.4; // approximate chassis half-size + skin
    const mass = this.config.chassisMass;

    for (const d of this.debris) {
      const t = d.body.translation();
      const dx = c.x - t.x;
      const dy = c.y - t.y;
      const dz = c.z - t.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > d.radius + reach || dist < 1e-3) continue;

      const v = d.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed < 1) continue;

      const inv = 1 / dist;
      // Push the car away from the rock proportional to the rock's speed.
      const k = Math.min(speed, 22) * mass * 0.06;
      this.applyChassisImpulse({ x: dx * inv * k, y: Math.abs(dy * inv) * k * 0.3, z: dz * inv * k });
      // Damp the rock so the exchange isn't explosive.
      d.body.setLinvel({ x: v.x * 0.5, y: v.y * 0.5, z: v.z * 0.5 }, true);
    }
  }

  /** Release the underlying WASM resources. */
  dispose(): void {
    this.world.free();
  }
}

/**
 * Normalize the `init`/`buildTerrainCollider` terrain argument into a
 * {@link TerrainModel}. A raw `THREE.Object3D` is wrapped with the default
 * collider kind (`trimesh`, which matches the generated terrain visuals exactly
 * per Req 4.1) and an empty friction table.
 */
function toTerrainModel(terrain: THREE.Object3D | TerrainModel): TerrainModel {
  if (isTerrainModel(terrain)) {
    return terrain;
  }
  return {
    visual: terrain,
    colliderKind: 'trimesh',
    frictionByRegion: new Map<string, number>(),
  };
}

/** Type guard distinguishing a {@link TerrainModel} from a raw scene graph. */
function isTerrainModel(terrain: THREE.Object3D | TerrainModel): terrain is TerrainModel {
  return (
    (terrain as TerrainModel).visual !== undefined &&
    (terrain as TerrainModel).colliderKind !== undefined
  );
}

/**
 * Pick the global/default terrain friction from a per-region table (Req 6.5).
 *
 * The collider can only carry a single friction value, so we use the most
 * conservative (smallest) region coefficient when a table is provided — this
 * avoids over-stating grip for the slipperiest authored surface. When the table
 * is empty we use the grippy default so the terrain never throttles wheel
 * traction. The returned value is clamped to [0.05, 1.50] by the caller.
 */
function resolveGlobalFriction(frictionByRegion: Map<string, number> | undefined): number {
  if (!frictionByRegion || frictionByRegion.size === 0) {
    return DEFAULT_TERRAIN_FRICTION;
  }
  let min = Number.POSITIVE_INFINITY;
  for (const value of frictionByRegion.values()) {
    const f = clampFriction(value);
    if (f < min) {
      min = f;
    }
  }
  return Number.isFinite(min) ? min : DEFAULT_TERRAIN_FRICTION;
}

/**
 * Attempt to extract a regular-grid heightfield from a Three.js scene graph for
 * use with a Rapier heightfield collider.
 *
 * A heightfield is only valid when the terrain is authored as a regular grid:
 * the merged world-space vertices must form `nrows * ncols` points whose X/Z
 * coordinates lie on an evenly spaced lattice. The function reconstructs the
 * grid by sorting the unique X and Z sample coordinates; if the vertex count
 * does not equal `uniqueX * uniqueZ`, the geometry is irregular and `null` is
 * returned so the caller falls back to a trimesh.
 *
 * Vertices are taken in WORLD space (the mesh `matrixWorld` is applied), and
 * the returned `scale` maps the unit heightfield grid onto the terrain's world
 * X/Z extents, with `scale.y = 1` since heights are already in world units.
 */
function extractHeightfield(
  root: THREE.Object3D,
): { nrows: number; ncols: number; heights: Float32Array; scale: RAPIER.Vector } | null {
  const mesh = extractTrimesh(root);
  if (!mesh) {
    return null;
  }

  const verts = mesh.vertices;
  const pointCount = verts.length / 3;
  if (pointCount === 0) {
    return null;
  }

  // Collect unique X and Z coordinates (quantized to tolerate float noise).
  const QUANT = 1e4;
  const xs = new Set<number>();
  const zs = new Set<number>();
  const heightAt = new Map<string, number>();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < pointCount; i += 1) {
    const x = verts[i * 3] ?? 0;
    const y = verts[i * 3 + 1] ?? 0;
    const z = verts[i * 3 + 2] ?? 0;
    const xq = Math.round(x * QUANT) / QUANT;
    const zq = Math.round(z * QUANT) / QUANT;
    xs.add(xq);
    zs.add(zq);
    heightAt.set(`${xq},${zq}`, y);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const ncols = xs.size;
  const nrows = zs.size;

  // Regular grid requires exactly nrows * ncols distinct lattice points.
  if (nrows < 2 || ncols < 2 || nrows * ncols !== pointCount) {
    return null;
  }

  const sortedX = [...xs].sort((a, b) => a - b);
  const sortedZ = [...zs].sort((a, b) => a - b);

  // Rapier expects heights in column-major order: index = col * nrows + row.
  const heights = new Float32Array(nrows * ncols);
  for (let col = 0; col < ncols; col += 1) {
    for (let row = 0; row < nrows; row += 1) {
      const key = `${sortedX[col]},${sortedZ[row]}`;
      const h = heightAt.get(key);
      if (h === undefined) {
        // Missing lattice point => not a complete regular grid.
        return null;
      }
      heights[col * nrows + row] = h;
    }
  }

  const scale: RAPIER.Vector = {
    x: maxX - minX,
    y: 1,
    z: maxZ - minZ,
  };

  return { nrows, ncols, heights, scale };
}

/**
 * Extract a single merged triangle mesh (world-space vertices + indices) from a
 * Three.js scene graph. Returns `null` when the graph contains no mesh
 * geometry. Non-indexed geometry is treated as a sequential triangle list.
 */
function extractTrimesh(
  root: THREE.Object3D,
): { vertices: Float32Array; indices: Uint32Array } | null {
  const positions: number[] = [];
  const indices: number[] = [];
  let indexOffset = 0;
  const v = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }

    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) {
      return;
    }

    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }

    const idx = geom.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i += 1) {
        indices.push(idx.getX(i) + indexOffset);
      }
    } else {
      for (let i = 0; i < pos.count; i += 1) {
        indices.push(i + indexOffset);
      }
    }

    indexOffset += pos.count;
  });

  if (positions.length === 0) {
    return null;
  }

  return {
    vertices: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}
