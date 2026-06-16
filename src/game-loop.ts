// GameLoop — the central orchestrator for the 3D Car Hill-Climb game.
//
// This is the thin I/O shell described in design.md's "Core loop layer". It ties
// together the four I/O subsystems (Physics_Engine, Renderer, Input_Controller,
// HUD, LOD controller) around a fixed-timestep accumulator and the pure
// run-lifecycle / fuel / balance reducers.
//
// Responsibilities (design.md "GameLoop / Run lifecycle"):
//   - Own the fixed-timestep accumulator so physics advances at a constant
//     FIXED_DT (1/60 s) independent of the render frame rate (Req 10.2).
//   - Sample input, resolve it, and drive the physics each fixed step.
//   - Advance the pure run lifecycle: start detection (Req 9.1), fuel accounting
//     (Req 7.1, 7.2, 7.4), balance evaluation (Req 8.2), distance tracking
//     (Req 9.2), and end conditions (Req 8.4, 9.5, 9.6).
//   - Handle player reset (Req 9.4).
//   - Interpolate between the two most recent physics snapshots and render
//     (Req 10.2), then project the run state onto the HUD and feed the measured
//     frame rate into the LOD controller.
//
// All testable rules live in the pure-logic core under `src/logic/`; this class
// performs only orchestration and I/O. `tick(now)` is intentionally a plain
// method (independent of requestAnimationFrame) so it can be unit-tested with
// stubbed collaborators.
//
// Requirements: 7.1, 7.2, 7.4, 8.2, 8.4, 9.1, 9.2, 9.4, 9.5, 9.6, 10.2

import { FIXED_DT } from './constants';
import type {
  DriveCommand,
  HudView,
  InterpolatedState,
  RunState,
  Vec3,
  VehicleState,
} from './types';

import { accumulateSteps } from './logic/timestep';
import { depleteFuel, isThrottleSuppressed } from './logic/fuel';
import { evaluateBalance } from './logic/balance';
import {
  applyEndConditions,
  resetRun,
  startRunIfMoving,
  updateDistance,
} from './logic/run-lifecycle';
import { toHudView } from './logic/hud';
import { applyImpact, type DamageState } from './systems/damage';
import { updateEngineSound, playCrash, playGlassShatter, playTreeCrack, playPickup, playCheckpoint } from './systems/audio';

import type { RapierPhysicsEngine } from './systems/physics-engine';
import type { Renderer } from './systems/renderer';
import type { InputController } from './systems/input-controller';
import type { LodController } from './systems/lod-controller';
import type { ObjectiveManager } from './systems/objective';
import type { ChunkManager } from './systems/chunk-manager';
import type { TreeRagdollManager } from './systems/tree-ragdoll';

/**
 * Structural type for the HUD collaborator.
 *
 * The concrete `Hud` class (src/systems/hud.ts, task 15.1) is wired in later;
 * the loop only needs to push a display-ready {@link HudView} once per frame, so
 * it depends on this minimal shape rather than the concrete class. Any HUD with
 * an `update(view)` method satisfies it.
 */
export interface HudLike {
  update(view: HudView): void;
  /** Optional checkpoint readout: reached count + distance to the next one. */
  setObjective?(reachedCount: number, distanceMeters: number): void;
}

/**
 * A dynamic-world entity (penguins, landslides, …) updated once per rendered
 * frame with the elapsed time and the current car position.
 */
export interface WorldEntity {
  update(dt: number, carPos: Vec3): void;
}

/** A function returning a monotonically increasing timestamp in milliseconds. */
export type NowFn = () => number;

/** A `requestAnimationFrame`-shaped scheduler. */
export type RafFn = (callback: (now: number) => void) => number;

/** A `cancelAnimationFrame`-shaped canceller. */
export type CancelRafFn = (handle: number) => void;

/** Collaborators and injectable clock/scheduler for the {@link GameLoop}. */
export interface GameLoopDeps {
  physics: RapierPhysicsEngine;
  renderer: Renderer;
  input: InputController;
  hud: HudLike;
  lod: LodController;
  /** Position the vehicle starts at and returns to on reset. */
  startPosition: Vec3;
  /**
   * Optional checkpoint progression. When provided, the loop advances it from
   * the car position each frame, repositions the renderer's beacon when a
   * checkpoint is reached, and feeds the HUD's objective readout.
   */
  objective?: ObjectiveManager;
  /**
   * Optional per-surface friction sampler. When provided, each wheel's grip is
   * updated every fixed step from the terrain under it (e.g. snow is slippery).
   */
  surfaceFrictionAt?: (x: number, z: number) => number;
  /**
   * Optional dynamic-world entities (penguins, landslides) updated each frame.
   */
  entities?: WorldEntity[];
  /**
   * Optional chunk manager for tree collision/uprooting. When provided, the
   * game loop checks for tree hits each step and applies damage.
   */
  chunks?: ChunkManager;
  /** Optional hazard pools — water slows, lava damages. */
  hazardPools?: { inWater: boolean; inLava: boolean };
  /** Optional tree ragdoll manager — uprooted trees tumble realistically. */
  treeRagdolls?: TreeRagdollManager;
  /** Optional fuel pickup manager — collected fuel is added to the run state. */
  fuelPickups?: { lastCollectedFuel: number; fuelPerPickup: number };
  /**
   * Clock used to seed timing; defaults to `performance.now()` (or `Date.now()`
   * when `performance` is unavailable). Injectable for tests.
   */
  now?: NowFn;
  /**
   * Frame scheduler; defaults to the global `requestAnimationFrame` when
   * available. When neither an injected `raf` nor a global exists, {@link start}
   * is a no-op and {@link tick} must be driven manually (e.g. in tests).
   */
  raf?: RafFn;
  /** Frame canceller; defaults to the global `cancelAnimationFrame`. */
  cancelRaf?: CancelRafFn;
}

/** Resolve a default millisecond clock from the environment. */
function defaultNow(): NowFn {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return () => performance.now();
  }
  return () => Date.now();
}

/** Resolve the global `requestAnimationFrame`, or `null` when absent (SSR/test). */
function defaultRaf(): RafFn | null {
  if (typeof requestAnimationFrame === 'function') {
    return (cb: (now: number) => void) => requestAnimationFrame(cb);
  }
  return null;
}

/** Resolve the global `cancelAnimationFrame`, or `null` when absent. */
function defaultCancelRaf(): CancelRafFn | null {
  if (typeof cancelAnimationFrame === 'function') {
    return (handle: number) => cancelAnimationFrame(handle);
  }
  return null;
}

/**
 * Orchestrates input, physics, rendering, HUD, and LOD around a fixed-timestep
 * accumulator and the pure run-lifecycle reducers.
 *
 * Usage:
 * ```ts
 * const loop = new GameLoop({ physics, renderer, input, hud, lod, startPosition });
 * loop.start();   // begins the requestAnimationFrame loop
 * // ...
 * loop.stop();    // cancels the loop
 * ```
 * For tests, call {@link tick} directly with synthetic timestamps and inspect
 * {@link getRunState}.
 */
export class GameLoop {
  private readonly physics: RapierPhysicsEngine;
  private readonly renderer: Renderer;
  private readonly input: InputController;
  private readonly hud: HudLike;
  private readonly lod: LodController;
  private readonly startPosition: Vec3;
  private readonly objective: ObjectiveManager | null;
  private readonly surfaceFrictionAt: ((x: number, z: number) => number) | null;
  private readonly entities: WorldEntity[];
  private readonly chunks: ChunkManager | null;
  private readonly hazardPoolsRef: { inWater: boolean; inLava: boolean } | null;
  private readonly treeRagdolls: TreeRagdollManager | null;
  private readonly fuelPickupSource: { lastCollectedFuel: number } | null;
  private damage: DamageState;

  private readonly now: NowFn;
  private readonly raf: RafFn | null;
  private readonly cancelRaf: CancelRafFn | null;

  /** Pure run lifecycle state, advanced by the reducers each fixed step. */
  private run: RunState;

  /** Two most recent physics snapshots for render interpolation (Req 10.2). */
  private prev: VehicleState;
  private curr: VehicleState;

  /** Last resolved command, surfaced to the renderer for wheel steer/spin viz. */
  private command: DriveCommand;

  /** Carried sub-step remainder of the fixed-timestep accumulator (seconds). */
  private accumulator = 0;

  /** Timestamp (ms) of the previous tick, or null before the first tick. */
  private lastNow: number | null = null;

  /** Whether the RAF loop is active. */
  private running = false;

  /** Handle of the pending RAF callback, or null when not scheduled. */
  private rafHandle: number | null = null;

  constructor(deps: GameLoopDeps) {
    this.physics = deps.physics;
    this.renderer = deps.renderer;
    this.input = deps.input;
    this.hud = deps.hud;
    this.lod = deps.lod;
    this.objective = deps.objective ?? null;
    this.surfaceFrictionAt = deps.surfaceFrictionAt ?? null;
    this.entities = deps.entities ?? [];
    this.chunks = deps.chunks ?? null;
    this.hazardPoolsRef = deps.hazardPools ?? null;
    this.treeRagdolls = deps.treeRagdolls ?? null;
    this.fuelPickupSource = deps.fuelPickups ?? null;
    this.damage = { health: 100 };
    this.startPosition = {
      x: deps.startPosition.x,
      y: deps.startPosition.y,
      z: deps.startPosition.z,
    };

    this.now = deps.now ?? defaultNow();
    this.raf = deps.raf ?? defaultRaf();
    this.cancelRaf = deps.cancelRaf ?? defaultCancelRaf();

    // Fresh idle run anchored at the start position (Req 9.4).
    this.run = resetRun(this.startPosition);

    // Place the physics chassis at the start position so the body and the run
    // state agree from frame one. The engine's own default spawn is unrelated
    // to the terrain surface, so without this the vehicle could start inside or
    // below the ground. `reset` also zeroes velocities for a clean start.
    this.physics.reset(this.startPosition);

    // Seed both interpolation snapshots from the (now repositioned) physics
    // state so the first rendered frame has a valid prev/curr pair.
    const initial = this.physics.readState();
    this.prev = initial;
    this.curr = initial;

    this.command = this.input.neutral;

    // Show the first checkpoint beacon, if a progression was supplied.
    if (this.objective) {
      this.renderer.setObjectivePosition(this.objective.getCurrent().position);
    }
  }

  /**
   * Begin the requestAnimationFrame loop. Idempotent: a second call while
   * already running is ignored. When no frame scheduler is available (no
   * injected `raf` and no global `requestAnimationFrame`), this is a no-op and
   * the caller must drive {@link tick} manually.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastNow = null;

    const raf = this.raf;
    if (!raf) {
      // No scheduler available; the loop stays "running" so a later environment
      // with RAF could be wired, but nothing is scheduled here.
      return;
    }

    const loop = (now: number): void => {
      if (!this.running) {
        return;
      }
      this.tick(now);
      this.rafHandle = raf(loop);
    };

    this.rafHandle = raf(loop);
  }

  /** Stop the loop and cancel any pending frame. Safe to call when not running. */
  stop(): void {
    this.running = false;
    if (this.rafHandle !== null && this.cancelRaf) {
      this.cancelRaf(this.rafHandle);
    }
    this.rafHandle = null;
  }

  /**
   * Advance the game by the real time elapsed since the previous tick.
   *
   * Pipeline:
   *  1. Compute elapsed real time and accumulate whole fixed steps + the
   *     interpolation alpha via {@link accumulateSteps} (Req 10.2).
   *  2. For each fixed step: sample + resolve input, suppress throttle when fuel
   *     is empty (Req 7.4), drive and step the physics at FIXED_DT, then advance
   *     the pure run lifecycle (start detection, fuel burn, balance, distance,
   *     end conditions) and shift the interpolation snapshots.
   *  3. Apply a pending player reset (Req 9.4).
   *  4. Render the interpolated state (Req 10.2).
   *  5. Project the run state onto the HUD.
   *  6. Feed the measured frame rate into the LOD controller.
   *
   * `tick` is independent of requestAnimationFrame so it can be unit-tested with
   * stubbed collaborators and synthetic timestamps.
   *
   * @param now Current timestamp in milliseconds (e.g. from RAF / performance.now()).
   */
  tick(now: number): void {
    // 1. Elapsed real time since the previous tick (seconds).
    const elapsedSeconds =
      this.lastNow === null ? 0 : Math.max(0, (now - this.lastNow) / 1000);
    this.lastNow = now;

    const { stepsToRun, remainder, alpha } = accumulateSteps(this.accumulator, elapsedSeconds);
    this.accumulator = remainder;

    // 2. Fixed simulation steps, each consuming exactly FIXED_DT (Req 10.2).
    for (let step = 0; step < stepsToRun; step += 1) {
      // Sample + resolve this frame's input (Req 5.5 wiring).
      const command = this.input.resolve();
      this.command = command;

      // Update per-wheel grip from the surface beneath the vehicle so different
      // terrain (snow, grass, rock) drives differently (Req 6.5).
      if (this.surfaceFrictionAt) {
        this.physics.updateSurfaceFriction(this.surfaceFrictionAt);
      }

      // Suppress throttle driving force when fuel is exhausted (Req 7.4); the
      // engine zeroes drive force when `fuelEmpty` is true.
      const fuelEmpty = isThrottleSuppressed(this.run.fuel);

      // Handling degrades with accumulated damage — no floor, no reset.
      const damageFactor = Math.max(0, this.damage.health) / 100;

      this.physics.applyCommand(command, fuelEmpty, damageFactor);
      this.physics.step(FIXED_DT);
      const state = this.physics.readState();

      // Run start detection (Req 9.1).
      this.run = startRunIfMoving(this.run, state.horizontalSpeed, state.chassisPosition);

      // Fuel burns only while a run is active and throttle is applied (Req 7.2).
      // `depleteFuel` already no-ops at throttle 0, but gating on the active run
      // ensures an idle/ended vehicle never loses fuel.
      if (this.run.status === 'running') {
        this.run = {
          ...this.run,
          fuel: depleteFuel(this.run.fuel, command.throttle, FIXED_DT),
        };
      }

      // Balance evaluation (Req 8.2), distance tracking (Req 9.2), and terminal
      // conditions (Req 8.4, 9.5, 9.6).
      this.run = evaluateBalance(this.run, state.pitchDeg, state.rollDeg, FIXED_DT);
      this.run = updateDistance(this.run, state.chassisPosition);
      this.run = applyEndConditions(this.run);

      // Hazard pools: water slows the car, lava damages.
      if (this.hazardPoolsRef) {
        if (this.hazardPoolsRef.inWater) {
          // Apply drag impulse opposing velocity to simulate water resistance.
          const v = state.linearSpeed;
          if (Math.abs(v) > 0.5) {
            this.physics.applyChassisImpulse({ x: 0, y: 0, z: -v * 80 });
          }
        }
        if (this.hazardPoolsRef.inLava) {
          // Lava damages over time (burns the car).
          this.damage = { health: this.damage.health - 2 * FIXED_DT };
        }
      }

      // Shift interpolation snapshots.
      this.prev = this.curr;
      this.curr = state;
    }

    // 2b. Camera controls: Z cycles distance, C held = rear view.
    if (this.input.consumeZoomRequested()) {
      this.renderer.cycleCamera();
    }
    this.renderer.setRearView(this.input.isRearViewHeld());

    // 3. Player reset (Req 9.4): snap physics + run state back to the start.
    if (this.input.consumeResetRequested()) {
      this.physics.reset(this.startPosition);
      this.run = resetRun(this.startPosition);
      const resetState = this.physics.readState();
      this.prev = resetState;
      this.curr = resetState;
      this.command = this.input.neutral;
      // Drop any carried sub-step time so the fresh run starts clean.
      this.accumulator = 0;
    }

    // 4. Render the interpolated state (Req 10.2).
    const interp: InterpolatedState = {
      alpha,
      prev: this.prev,
      curr: this.curr,
      command: this.command,
    };
    this.renderer.renderFrame(interp);

    // Audio: engine loop tracks throttle + speed.
    updateEngineSound(this.command.throttle, this.curr.horizontalSpeed);

    // 4b. Checkpoint progression: advance against the car position, move the
    // beacon when one is reached, and feed the HUD's objective readout.
    if (this.objective) {
      const carPos = this.curr.chassisPosition;
      if (this.objective.update(carPos)) {
        playCheckpoint();
        this.renderer.setObjectivePosition(this.objective.getCurrent().position);
      }
      this.hud.setObjective?.(
        this.objective.getReachedCount(),
        this.objective.distanceTo(carPos),
      );
    }

    // 4c. Tree and stone collision detection + damage + uprooting.
    if (this.chunks) {
      const carPos = this.curr.chassisPosition;
      const speed = this.curr.horizontalSpeed;

      // --- Trees: hit detection, damage, localised crumple, and ragdoll uprooting ---
      const nearTrees = this.chunks.getTreesNear(carPos, 3.0);
      for (const tree of nearTrees) {
        const dx = carPos.x - tree.x;
        const dz = carPos.z - tree.z;
        const dist = Math.hypot(dx, dz);
        if (dist < tree.radius + 1.4) {
          const result = applyImpact(this.damage, speed, 'tree');
          this.damage = result.newState;

          // Sound + localised crumple.
          if (result.damage > 0) {
            playCrash(Math.min(1, result.damage / 15));
          }

          // Localised crumple: deform the chassis at the impact side.
          if (result.damage > 0 && dist > 0.1) {
            const inv = 1 / dist;
            const strength = Math.min(1, result.damage / 20);
            const crumpleResult = this.renderer.applyCrumpleAt(
              { x: -dx * inv, y: 0, z: -dz * inv },
              strength,
            );
            if (crumpleResult.glassShattered) {
              playGlassShatter();
            }
          }

          if (result.uprooted) {
            playTreeCrack();
            const inv = dist > 0.5 ? 1 / dist : 1;
            // Ragdoll the actual tree mesh (topple it away from the car).
            if (this.treeRagdolls) {
              this.treeRagdolls.launch(
                tree.mesh,
                { x: tree.x, y: this.curr.chassisPosition.y, z: tree.z },
                { x: dx * inv * 6, y: 4, z: dz * inv * 6 },
              );
            }
            this.chunks.uprootTree(tree.chunkKey, tree.bodyId);
          }
        }
      }
    }

    // 5. HUD projection (Req 7.5, 9.3 — projection is pure in toHudView).
    // First, consume any fuel collected by pickups (entities already updated).
    if (this.fuelPickupSource && this.fuelPickupSource.lastCollectedFuel > 0) {
      playPickup();
      this.run = {
        ...this.run,
        fuel: Math.min(1000, this.run.fuel + this.fuelPickupSource.lastCollectedFuel),
      };
    }
    this.hud.update(toHudView(this.run));
    this.renderer.applyCrumple(this.damage.health);

    // 5b. Dynamic-world entities (penguins, landslides) advance per frame.
    if (this.entities.length > 0) {
      const carPos = this.curr.chassisPosition;
      for (const entity of this.entities) {
        entity.update(elapsedSeconds, carPos);
      }
    }
    // Tree ragdolls (tumbling uprooted trees) advance independently.
    this.treeRagdolls?.update(elapsedSeconds);

    // 6. LOD controller fed by the renderer's measured frame rate (Req 10.3-10.6).
    this.lod.update(this.renderer.measureFps(now), elapsedSeconds);
  }

  /**
   * Advance the game using the injected clock for the current timestamp.
   *
   * Convenience over {@link tick} for callers (and tests) that want to drive the
   * loop from the configured `now()` source rather than supplying a timestamp.
   */
  tickNow(): void {
    this.tick(this.now());
  }

  /** The current run lifecycle state. Exposed for tests and HUD consumers. */
  getRunState(): RunState {
    return this.run;
  }

  /** Whether the RAF loop is currently active. */
  isRunning(): boolean {
    return this.running;
  }
}
