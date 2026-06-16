import { describe, it, expect, beforeEach } from 'vitest';
import { InputController, type InputTarget } from './input-controller';
import { CONTROL_STEER_LIMIT } from '../constants';

// A tiny fake EventTarget that lets the tests drive keydown/keyup events
// without a real DOM. It mimics just the addEventListener/removeEventListener
// surface the controller uses and can synthesise KeyboardEvent-like objects.
class FakeTarget implements InputTarget {
  private listeners = new Map<string, Set<(event: KeyboardEvent) => void>>();

  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: KeyboardEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, code: string): void {
    const event = { code } as KeyboardEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  keydown(code: string): void {
    this.emit('keydown', code);
  }

  keyup(code: string): void {
    this.emit('keyup', code);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe('InputController', () => {
  let target: FakeTarget;
  let controller: InputController;

  beforeEach(() => {
    target = new FakeTarget();
    controller = new InputController(target);
  });

  it('exposes a neutral command of (0, 0, 0)', () => {
    expect(controller.neutral).toEqual({ throttle: 0, brake: 0, steerDeg: 0 });
  });

  it('samples neutral input when no keys are pressed (Req 5.4)', () => {
    expect(controller.sample()).toEqual({ throttle: 0, brake: 0, steer: 0 });
  });

  it('maps ArrowUp and KeyW to throttle (Req 5.1)', () => {
    target.keydown('ArrowUp');
    expect(controller.sample().throttle).toBe(1);
    target.keyup('ArrowUp');
    expect(controller.sample().throttle).toBe(0);

    target.keydown('KeyW');
    expect(controller.sample().throttle).toBe(1);
  });

  it('maps ArrowDown and KeyS to brake (Req 5.2)', () => {
    target.keydown('ArrowDown');
    expect(controller.sample().brake).toBe(1);
    target.keyup('ArrowDown');

    target.keydown('KeyS');
    expect(controller.sample().brake).toBe(1);
  });

  it('maps ArrowLeft/KeyA to negative steer and ArrowRight/KeyD to positive steer (Req 5.3)', () => {
    target.keydown('ArrowLeft');
    // Smooth steering: sample several times so the angle converges to the limit.
    let steer = 0;
    for (let i = 0; i < 20; i++) steer = controller.sample().steer;
    expect(steer).toBeCloseTo(-CONTROL_STEER_LIMIT, 0);
    target.keyup('ArrowLeft');

    target.keydown('KeyD');
    for (let i = 0; i < 30; i++) steer = controller.sample().steer;
    expect(steer).toBeCloseTo(CONTROL_STEER_LIMIT, 0);
  });

  it('cancels steer when both left and right are held', () => {
    target.keydown('ArrowLeft');
    target.keydown('ArrowRight');
    expect(controller.sample().steer).toBe(0);
  });

  it('resolve() arbitrates brake over throttle (Req 5.6)', () => {
    target.keydown('ArrowUp'); // throttle
    target.keydown('ArrowDown'); // brake
    const cmd = controller.resolve();
    expect(cmd.brake).toBe(1);
    expect(cmd.throttle).toBe(0);
  });

  it('resolve() produces a clamped, in-range DriveCommand (Req 5.3, 5.7)', () => {
    target.keydown('ArrowLeft');
    // Let smooth steering converge.
    let cmd = controller.resolve();
    for (let i = 0; i < 20; i++) cmd = controller.resolve();
    expect(cmd.steerDeg).toBeGreaterThanOrEqual(-CONTROL_STEER_LIMIT);
    expect(cmd.steerDeg).toBeLessThanOrEqual(CONTROL_STEER_LIMIT);
    expect(cmd.steerDeg).toBeCloseTo(-CONTROL_STEER_LIMIT, 0);
  });

  it('latches and consumes a reset request on KeyR', () => {
    expect(controller.consumeResetRequested()).toBe(false);
    target.keydown('KeyR');
    expect(controller.consumeResetRequested()).toBe(true);
    // Latch is cleared after consumption.
    expect(controller.consumeResetRequested()).toBe(false);
  });

  it('incorporates touch input when keyboard channels are idle', () => {
    controller.setTouchInput({ throttle: 0.5, steer: 10 });
    // Let smooth steer converge to the touch target.
    let raw = controller.sample();
    for (let i = 0; i < 10; i++) raw = controller.sample();
    expect(raw.throttle).toBe(0.5);
    expect(raw.steer).toBeCloseTo(10, 0);

    controller.clearTouchInput();
    for (let i = 0; i < 20; i++) raw = controller.sample();
    expect(raw.throttle).toBe(0);
    expect(Math.abs(raw.steer)).toBeLessThan(1);
  });

  it('lets held keyboard input take precedence over touch', () => {
    controller.setTouchInput({ throttle: 0.3, steer: 5 });
    target.keydown('ArrowUp');
    target.keydown('ArrowRight');
    let raw = controller.sample();
    for (let i = 0; i < 20; i++) raw = controller.sample();
    expect(raw.throttle).toBe(1);
    expect(raw.steer).toBeCloseTo(CONTROL_STEER_LIMIT, 0);
  });

  it('attaches listeners on construction and removes them on dispose', () => {
    expect(target.listenerCount('keydown')).toBe(1);
    expect(target.listenerCount('keyup')).toBe(1);

    controller.dispose();
    expect(target.listenerCount('keydown')).toBe(0);
    expect(target.listenerCount('keyup')).toBe(0);
  });

  it('does not throw when constructed without a target (SSR/test guard)', () => {
    expect(() => new InputController(null)).not.toThrow();
    const headless = new InputController(null);
    expect(headless.sample()).toEqual({ throttle: 0, brake: 0, steer: 0 });
    expect(() => headless.dispose()).not.toThrow();
  });
});
