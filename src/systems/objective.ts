// Objective system — the climb's checkpoint progression.
//
// The player chases a sequence of checkpoints up the mountain. Reaching one
// (driving within its horizontal radius) advances to the next, placed further
// up the climb (greater z, and therefore higher elevation), weaving laterally
// so the route is not a straight line. Once the summit band is reached the
// checkpoints keep appearing near the top so progression never dead-ends.
//
// This module is pure/data-only: it knows nothing about Three.js or physics. It
// is fed the car's position each frame and reports whether a checkpoint was
// reached, the current target, and how far away it is. The renderer draws a
// beacon at the target; the HUD shows the count and distance.

import type { Vec3 } from '../types';
import type { ElevationSampler } from './terrain';

/** A single checkpoint to reach. */
export interface Objective {
  /** 0-based checkpoint index (also the count reached before it). */
  index: number;
  /** World position of the checkpoint; `y` sits on the terrain surface. */
  position: Vec3;
  /** Horizontal reach radius (metres) within which the checkpoint counts. */
  radius: number;
}

/** Construction options for {@link ObjectiveManager}. */
export interface ObjectiveOptions {
  /** Terrain elevation sampler used to place each checkpoint on the surface. */
  sampler: ElevationSampler;
  /** z of the first checkpoint. */
  startZ: number;
  /** z advance added per checkpoint (the climb step). */
  stepZ: number;
  /** Maximum z (summit band); checkpoints are clamped at/below this. */
  maxZ: number;
  /** Lateral (x) weave amplitude, in metres. Defaults to 0 (straight line). */
  lateralAmplitude?: number;
  /** Horizontal reach radius. Defaults to 10 m. */
  radius?: number;
}

/** Horizontal (ground-plane) distance between two positions. */
function horizontalDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

/**
 * Tracks the active checkpoint and advances it as the player reaches each one.
 *
 * Checkpoints climb the mountain: checkpoint `i` sits at
 * `z = min(maxZ, startZ + i * stepZ)`, weaves laterally by
 * `lateralAmplitude * sin(i * 1.3)`, and is placed on the terrain surface via
 * the elevation `sampler`.
 */
export class ObjectiveManager {
  private readonly sampler: ElevationSampler;
  private readonly startZ: number;
  private readonly stepZ: number;
  private readonly maxZ: number;
  private readonly lateralAmplitude: number;
  private readonly radius: number;

  /** Number of checkpoints already reached. */
  private reachedCount = 0;
  /** The checkpoint currently being chased. */
  private current: Objective;

  constructor(options: ObjectiveOptions) {
    this.sampler = options.sampler;
    this.startZ = options.startZ;
    this.stepZ = options.stepZ;
    this.maxZ = options.maxZ;
    this.lateralAmplitude = options.lateralAmplitude ?? 0;
    this.radius = options.radius ?? 10;
    this.current = this.build(0);
  }

  /** Build checkpoint `index` on the terrain surface. */
  private build(index: number): Objective {
    const z = Math.min(this.maxZ, this.startZ + index * this.stepZ);
    const x = this.lateralAmplitude * Math.sin(index * 1.3);
    const y = this.sampler(x, z);
    return { index, position: { x, y, z }, radius: this.radius };
  }

  /** The checkpoint currently being chased. */
  getCurrent(): Objective {
    return this.current;
  }

  /** Number of checkpoints reached so far. */
  getReachedCount(): number {
    return this.reachedCount;
  }

  /** Horizontal distance from `carPos` to the current checkpoint. */
  distanceTo(carPos: Vec3): number {
    return horizontalDistance(carPos, this.current.position);
  }

  /**
   * Update against the car's current position. If the car is within the current
   * checkpoint's radius, increment the reached count, advance to the next
   * checkpoint, and return `true`. Otherwise return `false`.
   */
  update(carPos: Vec3): boolean {
    if (this.distanceTo(carPos) <= this.current.radius) {
      this.reachedCount += 1;
      this.current = this.build(this.reachedCount);
      return true;
    }
    return false;
  }
}
