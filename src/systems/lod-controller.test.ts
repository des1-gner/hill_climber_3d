// Unit tests for LodController (src/systems/lod-controller.ts).
//
// These verify the bridge behavior between the pure `updateLOD` state machine
// and the renderer: the controller applies the initial level on construction,
// calls `setLOD` exactly when the computed level changes, and exposes its state.
//
// Requirements: 10.3, 10.4, 10.5, 10.6

import { describe, it, expect } from 'vitest';

import { LodController } from './lod-controller';
import type { LODLevel } from '../types';
import type { Renderer } from './renderer';

/** Minimal stub recording every setLOD call. */
class StubRenderer {
  readonly calls: LODLevel[] = [];
  setLOD(level: LODLevel): void {
    this.calls.push(level);
  }
}

function makeController(initial: LODLevel = 3): {
  controller: LodController;
  stub: StubRenderer;
} {
  const stub = new StubRenderer();
  const controller = new LodController(stub as unknown as Renderer, initial);
  return { controller, stub };
}

describe('LodController', () => {
  it('applies the initial level to the renderer on construction', () => {
    const { controller, stub } = makeController(3);
    expect(stub.calls).toEqual([3]);
    expect(controller.getLevel()).toBe(3);
  });

  it('defaults the initial level to 3', () => {
    const stub = new StubRenderer();
    const controller = new LodController(stub as unknown as Renderer);
    expect(stub.calls).toEqual([3]);
    expect(controller.getLevel()).toBe(3);
  });

  it('does not call setLOD again while the level is unchanged', () => {
    const { controller, stub } = makeController(3);
    // Healthy frame rate: no change expected.
    controller.update(60, 1 / 60);
    controller.update(60, 1 / 60);
    expect(stub.calls).toEqual([3]); // only the constructor call
    expect(controller.getLevel()).toBe(3);
  });

  it('calls renderer.setLOD when a sustained low frame rate forces a reduction', () => {
    const { controller, stub } = makeController(3);
    // Below 30 fps for > 2 continuous seconds triggers the first reduction (Req 10.3).
    controller.update(20, 1.5);
    expect(controller.getLevel()).toBe(3); // not yet (only 1.5 s)
    controller.update(20, 1.0); // now 2.5 s below 30
    expect(controller.getLevel()).toBe(2);
    expect(stub.calls).toEqual([3, 2]); // construction + one reduction
  });

  it('raises the level after sustained high frame rate from a lowered state', () => {
    const { controller, stub } = makeController(1);
    expect(stub.calls).toEqual([1]);
    // >= 60 fps sustained for > 5 s raises by one step (Req 10.6).
    controller.update(60, 6);
    expect(controller.getLevel()).toBe(2);
    expect(stub.calls).toEqual([1, 2]);
  });

  it('exposes the full state including timers via getState', () => {
    const { controller } = makeController(3);
    controller.update(60, 2);
    const state = controller.getState();
    expect(state.level).toBe(3);
    expect(state.secondsAbove60).toBeCloseTo(2, 9);
    expect(state.secondsBelow30).toBe(0);
    expect(state.secondsBelow60).toBe(0);
  });
});
