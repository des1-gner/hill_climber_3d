// Shared type definitions for the 3D Car Hill-Climb game.
//
// These types form the shared data model used across the pure-logic core and
// the thin I/O wrappers (Three.js renderer, Rapier physics, asset loader, HUD).
//
// Design notes:
// - The pure-logic-facing types use plain `Vec3`/`Quat` structs rather than
//   THREE.js types so the rules engine can be unit- and property-tested without
//   a browser, GPU, or WASM.
// - Only the loader/renderer-facing types (`VehicleMeshes`, `TerrainModel`,
//   `WheelVisualState` consumers) reference `THREE.Object3D` directly.

import type * as THREE from 'three';

// ---------------------------------------------------------------------------
// Math primitives (logic-facing, framework-agnostic)
// ---------------------------------------------------------------------------

/** A 3D vector in world or local space. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A unit quaternion describing an orientation. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

// ---------------------------------------------------------------------------
// Input (Req 5)
// ---------------------------------------------------------------------------

/** Raw, unvalidated input sampled from keyboard/touch. May be out of range or non-finite. */
export interface RawInput {
  throttle: number; // may be out of range; possibly NaN from bad sources
  brake: number;
  steer: number; // degrees, may be out of range
}

/** Resolved, clamped, and arbitrated drive command for a single frame. */
export interface DriveCommand {
  throttle: number; // clamped 0..1
  brake: number; // clamped 0..1
  steerDeg: number; // clamped -35..+35
}

// ---------------------------------------------------------------------------
// Physics: wheels and vehicle state (Req 2, 3, 4, 6, 8)
// ---------------------------------------------------------------------------

/** Static per-wheel configuration, authored once and loaded at init. */
export interface WheelConfig {
  index: 0 | 1 | 2 | 3;
  connectionPointLocal: Vec3; // mount point on chassis (local space)
  suspensionRestLength: number; // > 0  (Req 3.1)
  suspensionStiffness: number; // > 0
  suspensionDamping: number; // >= 0
  maxSuspensionTravel: number; // travel limit (Req 3.3, 3.4)
  radius: number; // wheel radius, for spin math (Req 2.1)
  isSteered: boolean; // front wheels true
  isDriven: boolean; // drive layout (e.g. all four)
  frictionSlip: number; // surface friction coefficient 0.05..1.50 (Req 6.5)
}

/** Per-wheel dynamic state produced by the physics step. */
export interface WheelState {
  index: 0 | 1 | 2 | 3;
  inContact: boolean; // ray hit terrain this step (Req 4.4)
  suspensionLength: number; // current ray length to contact
  suspensionCompression: number; // restLength - contactDistance, clamped (Req 3.2, 3.4)
  contactNormal: Vec3;
  steerDeg: number; // applied steering this step
  // derived for traction (Req 6):
  normalForce: number;
  tractionLimit: number; // frictionSlip * normalForce
  appliedDriveForce: number; // capped at tractionLimit (Req 6.2)
  slipRatio: number; // (Req 6.3)
}

/** Snapshot of the whole vehicle's dynamic state after a physics step. */
export interface VehicleState {
  chassisPosition: Vec3;
  chassisQuaternion: Quat;
  linearSpeed: number; // m/s along forward axis (signed)
  horizontalSpeed: number; // m/s in ground plane
  pitchDeg: number; // (Req 8.1)
  rollDeg: number; // (Req 8.1)
  wheels: WheelState[];
}

// ---------------------------------------------------------------------------
// Run lifecycle / game state (Req 7, 8, 9)
// ---------------------------------------------------------------------------

export type RunStatus = 'idle' | 'running' | 'ended';
export type EndReason = 'out-of-fuel' | 'overturned' | 'player-reset';
export type BalanceState = 'upright' | 'overturned';

/** The full run lifecycle state, advanced by the pure reducers. */
export interface RunState {
  status: RunStatus;
  fuel: number; // 0..100
  startPosition: Vec3 | null;
  distanceTraveled: number; // metres, horizontal
  balance: BalanceState;
  overturnElapsed: number; // seconds chassis has been past threshold
  endReason: EndReason | null;
}

// ---------------------------------------------------------------------------
// LOD / performance (Req 10)
// ---------------------------------------------------------------------------

export type LODLevel = 0 | 1 | 2 | 3; // 3 = highest detail, 0 = lowest

/** State for the LOD adjustment state machine. */
export interface LODState {
  level: LODLevel;
  secondsBelow30: number; // continuous seconds fps < 30
  secondsBelow60: number; // seconds fps < 60 since last reduction
  secondsAbove60: number; // continuous seconds fps >= 60
}

// ---------------------------------------------------------------------------
// Rendering (Req 2, 3.5, 10)
// ---------------------------------------------------------------------------

/** Visual transform state for a single wheel mesh. */
export interface WheelVisualState {
  spinAngleRad: number; // accumulated rotation about axle
  steerAngleDeg: number; // about vertical axis, clamped -45..+45
  verticalOffset: number; // local Y offset reflecting compression
}

/** Two physics snapshots plus blend factor for render interpolation. */
export interface InterpolatedState {
  alpha: number; // 0..1 blend between prev and curr physics state
  prev: VehicleState;
  curr: VehicleState;
  command: DriveCommand;
}

// ---------------------------------------------------------------------------
// HUD (Req 7.5, 9.3)
// ---------------------------------------------------------------------------

/** Pure projection of run state for display. */
export interface HudView {
  fuelInt: number; // Math.floor/round of fuel, 0..100 (Req 7.5)
  distanceText: string; // run-end: rounded to 0.1 m (Req 9.3)
  status: RunStatus;
  endReason: EndReason | null;
}

// ---------------------------------------------------------------------------
// Asset loading (Req 1) — loader-facing, references THREE.Object3D
// ---------------------------------------------------------------------------

/** The validated vehicle scene graph: one chassis and four wheels (FL, FR, RL, RR). */
export interface VehicleMeshes {
  chassis: THREE.Object3D; // exactly one
  wheels: [THREE.Object3D, THREE.Object3D, THREE.Object3D, THREE.Object3D]; // FL, FR, RL, RR
}

/** Progress for a single in-flight asset load. */
export interface LoadProgress {
  asset: string;
  percent: number; // 0..100
}

/** Structured failure detail for an asset load. */
export interface AssetError {
  asset: string; // identifies failed/missing asset by name
  kind: 'network' | 'timeout' | 'parse' | 'missing-mesh';
  missingNode?: string; // e.g. "wheel_RL" when kind === 'missing-mesh'
  message: string;
}

/** Discriminated result of an asset load or validation. */
export type LoadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AssetError };

// ---------------------------------------------------------------------------
// Configuration and terrain data models
// ---------------------------------------------------------------------------

/** Vehicle configuration authored once and loaded at init. */
export interface VehicleConfig {
  chassisMass: number; // kg
  chassisHalfExtents: Vec3; // collider size
  maxEngineForce: number; // N, throttle 1.0 (Req 5.1)
  maxBrakeForce: number; // N, brake 1.0 (Req 5.2)
  wheels: WheelConfig[]; // length 4
  driveLayout: 'fwd' | 'rwd' | 'awd';
}

/** Terrain model: visual mesh plus collider/friction metadata. */
export interface TerrainModel {
  visual: THREE.Object3D;
  colliderKind: 'trimesh' | 'heightfield';
  frictionByRegion: Map<string, number>; // 0.05..1.50
}
