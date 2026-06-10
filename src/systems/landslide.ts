// Landslides — periodic showers of tumbling boulders that roll down the
// mountain toward the climbing player.
//
// Every so often a "slide" spawns several dynamic rock rigid bodies up-slope
// (higher z) from the player, with a downhill initial velocity. Gravity and the
// terrain do the rest: the rocks tumble down and can collide with the vehicle.
// Rocks that fall off the world are pruned. The renderer draws the active
// debris each frame.
//
// The game loop calls `update(dt, carPos)` each frame; this manager owns the
// timing and delegates body creation/removal to the physics engine and drawing
// to the renderer.

import type { Vec3 } from '../types';
import type { RapierPhysicsEngine } from './physics-engine';
import type { Renderer } from './renderer';
import type { ElevationSampler } from './terrain';

/** Construction options for {@link LandslideManager}. */
export interface LandslideOptions {
  /** Minimum / maximum seconds between slides (randomised in range). */
  minInterval?: number;
  maxInterval?: number;
  /** Rocks released per slide (randomised up to this many). */
  rocksPerSlide?: number;
  /** Y below which fallen rocks are pruned. */
  pruneBelowY?: number;
  /** Seconds before the first slide. */
  firstDelay?: number;
}

export class LandslideManager {
  private readonly physics: RapierPhysicsEngine;
  private readonly renderer: Renderer;
  private readonly sampler: ElevationSampler;
  private readonly minInterval: number;
  private readonly maxInterval: number;
  private readonly rocksPerSlide: number;
  private readonly pruneBelowY: number;

  private timer: number;

  constructor(
    physics: RapierPhysicsEngine,
    renderer: Renderer,
    sampler: ElevationSampler,
    options: LandslideOptions = {},
  ) {
    this.physics = physics;
    this.renderer = renderer;
    this.sampler = sampler;
    this.minInterval = options.minInterval ?? 7;
    this.maxInterval = options.maxInterval ?? 13;
    this.rocksPerSlide = options.rocksPerSlide ?? 6;
    this.pruneBelowY = options.pruneBelowY ?? -60;
    this.timer = options.firstDelay ?? 5;
  }

  /** Advance the slide timer, trigger slides, prune, and render debris. */
  update(dt: number, carPos: Vec3): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.trigger(carPos);
      this.timer = this.minInterval + Math.random() * (this.maxInterval - this.minInterval);
    }

    this.physics.pruneDebris(this.pruneBelowY);
    this.renderer.updateDebris(this.physics.getDebris());
  }

  /** Release a batch of rocks up-slope from the player. */
  private trigger(carPos: Vec3): void {
    const n = 2 + Math.floor(Math.random() * (this.rocksPerSlide - 1));
    for (let i = 0; i < n; i += 1) {
      const x = carPos.x + (Math.random() - 0.5) * 30;
      // Up-slope (higher z) and ahead of the player.
      const z = carPos.z + 35 + Math.random() * 25;
      const y = this.sampler(x, z) + 6;
      const radius = 0.6 + Math.random() * 1.1;
      // Roll downhill (toward -z, i.e. back down at the climbing player).
      const vel: Vec3 = {
        x: (Math.random() - 0.5) * 3,
        y: -2,
        z: -(8 + Math.random() * 9),
      };
      this.physics.spawnRock({ x, y, z }, radius, vel);
    }
  }
}
