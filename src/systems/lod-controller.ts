// LodController — bridges the pure LOD performance state machine to the
// Renderer's quality settings.
//
// The detail-adjustment policy lives entirely in the side-effect-free reducer
// `updateLOD` (src/logic/lod.ts), which advances timers and decides at most one
// level change per call from the measured frame rate. This controller owns the
// mutable `LODState`, feeds each frame's FPS/dt into the reducer, and applies a
// resulting level change to the renderer via `renderer.setLOD`. Keeping the
// policy pure means the only I/O here is the single `setLOD` call on change.
//
// The GameLoop drives this each frame as
//   lodController.update(renderer.measureFps(now), dt)
// so the renderer's sliding-window FPS estimate feeds the same renderer's LOD.
//
// Requirements: 10.3, 10.4, 10.5, 10.6

import { updateLOD } from '../logic/lod';
import type { LODLevel, LODState } from '../types';
import type { Renderer } from './renderer';

/**
 * Owns an {@link LODState} and applies level changes to a {@link Renderer}.
 *
 * On construction the controller seeds the state at `initialLevel` with zeroed
 * timers and immediately applies that level to the renderer so the renderer and
 * controller start in agreement. Each {@link update} call advances the pure
 * state machine and forwards a level change (if any) to the renderer.
 */
export class LodController {
  private readonly renderer: Renderer;
  private state: LODState;

  /**
   * @param renderer     The renderer whose detail level is controlled.
   * @param initialLevel Starting detail level (3 = highest detail). Defaults to 3.
   */
  constructor(renderer: Renderer, initialLevel: LODLevel = 3) {
    this.renderer = renderer;
    this.state = {
      level: initialLevel,
      secondsBelow30: 0,
      secondsBelow60: 0,
      secondsAbove60: 0,
    };
    this.renderer.setLOD(initialLevel);
  }

  /**
   * Advance the LOD state machine for one frame and apply any level change.
   *
   * Delegates the decision to {@link updateLOD}; if the returned level differs
   * from the current level, calls `renderer.setLOD` with the new level. The new
   * state is stored regardless of whether the level changed.
   *
   * @param fps Measured frame rate for this evaluation window (e.g. from
   *            `renderer.measureFps(now)`).
   * @param dt  Real time elapsed since the previous update, in seconds.
   */
  update(fps: number, dt: number): void {
    const next = updateLOD(this.state, fps, dt);
    if (next.level !== this.state.level) {
      this.renderer.setLOD(next.level);
    }
    this.state = next;
  }

  /** The currently applied LOD level. */
  getLevel(): LODLevel {
    return this.state.level;
  }

  /** A snapshot of the full LOD state (level plus timers). */
  getState(): LODState {
    return this.state;
  }
}
