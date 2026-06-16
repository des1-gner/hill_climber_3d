// Input_Controller for the 3D Car Hill-Climb game.
//
// Maps keyboard (arrow keys / WASD) and optional touch input to a normalized
// `RawInput` sample, once per frame. The raw sample is intentionally kept
// "dumb": steering is produced in degrees within the control bound, and the
// pure `resolveInput` function (src/logic/input.ts) performs the clamping and
// brake-over-throttle arbitration that the requirements mandate.
//
// Requirements covered:
// - 5.1 Throttle is a normalized magnitude proportional to forward force.
// - 5.2 Brake is a normalized magnitude proportional to braking force.
// - 5.3 Steering is bounded to [-CONTROL_STEER_LIMIT, +CONTROL_STEER_LIMIT]
//        degrees; negative steers left, positive steers right.
// - 5.4 Releasing all inputs yields the neutral (0, 0, 0) command.
// - 5.5 `sample()` is called once per rendered frame by the GameLoop.
// - 5.6 Brake-over-throttle arbitration (delegated to resolveInput).
// - 5.7 Out-of-range values are clamped (delegated to resolveInput).

import type { DriveCommand, RawInput } from '../types';
import { CONTROL_STEER_LIMIT } from '../constants';
import { resolveInput } from '../logic/input';

/**
 * A minimal subset of the DOM `EventTarget` surface this controller needs.
 * Accepting it via the constructor keeps the class testable without a real
 * `window` (e.g. under Vitest/Node) and guards against SSR.
 */
export interface InputTarget {
  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
}

/** Touch / virtual-button state, settable by an on-screen control overlay. */
export interface TouchInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // degrees, negative left / positive right
}

/**
 * Resolve the default input target. Returns `window` when running in a browser
 * and `null` under SSR/test environments where no DOM is present (Req 5.5
 * wiring, defensive).
 */
function defaultTarget(): InputTarget | null {
  return typeof window !== 'undefined' ? (window as unknown as InputTarget) : null;
}

export class InputController {
  /** Neutral command: no throttle, no brake, centred steering (Req 5.4). */
  readonly neutral: DriveCommand = { throttle: 0, brake: 0, steerDeg: 0 };

  /** Currently held key codes (KeyboardEvent.code values). */
  private readonly pressed = new Set<string>();

  /** Latched reset request, cleared by `consumeResetRequested()`. */
  private resetRequested = false;

  /** Latched camera-zoom-cycle request, cleared by `consumeZoomRequested()`. */
  private cameraZoomRequested = false;

  /**
   * Optional touch/virtual-button contribution. When any channel is non-zero
   * it is combined with keyboard input in `sample()`. Defaults to all-zero so
   * touch is inert until an overlay wires it up via `setTouchInput`.
   */
  private touch: TouchInput = { throttle: 0, brake: 0, steer: 0 };

  private readonly target: InputTarget | null;

  // Bound handlers retained so they can be detached in `dispose()`.
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'KeyR') {
      this.resetRequested = true;
    }
    if (event.code === 'KeyZ') {
      this.cameraZoomRequested = true;
    }
    this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  /**
   * @param target Event source for keyboard input. Defaults to `window` in the
   *   browser, or `null` under SSR/test where no listeners are attached.
   */
  constructor(target: InputTarget | null = defaultTarget()) {
    this.target = target;
    if (this.target) {
      this.target.addEventListener('keydown', this.onKeyDown);
      this.target.addEventListener('keyup', this.onKeyUp);
    }
  }

  /** Current smoothed steering angle — eases back toward 0 when keys are released. */
  private smoothSteer = 0;

  /** Steering rate: degrees per second the wheel angle moves toward its target. */
  private static readonly STEER_RATE = 180;

  /**
   * Read the current control state and produce a raw input sample for this
   * frame (Req 5.5). Steering uses a smooth transition so wheels ease back to
   * centre rather than snapping.
   */
  sample(): RawInput {
    const throttleKey = this.pressed.has('ArrowUp') || this.pressed.has('KeyW');
    const brakeKey = this.pressed.has('ArrowDown') || this.pressed.has('KeyS');

    const left = this.pressed.has('ArrowLeft') || this.pressed.has('KeyA');
    const right = this.pressed.has('ArrowRight') || this.pressed.has('KeyD');

    let targetSteer = 0;
    if (left) targetSteer -= CONTROL_STEER_LIMIT;
    if (right) targetSteer += CONTROL_STEER_LIMIT;
    if (targetSteer === 0) {
      targetSteer = this.touch.steer;
    }

    // Smooth steering: move current angle toward target at a fixed rate per
    // frame (~60 fps assumed for the per-sample dt). This prevents the harsh
    // snap-to-zero when keys are released.
    const dt = 1 / 60;
    const maxDelta = InputController.STEER_RATE * dt;
    const diff = targetSteer - this.smoothSteer;
    if (Math.abs(diff) <= maxDelta) {
      this.smoothSteer = targetSteer;
    } else {
      this.smoothSteer += Math.sign(diff) * maxDelta;
    }

    const throttle = (throttleKey ? 1 : 0) || this.touch.throttle;
    const brake = (brakeKey ? 1 : 0) || this.touch.brake;

    return { throttle, brake, steer: this.smoothSteer };
  }

  /**
   * Convenience: sample and resolve in one call, yielding the clamped,
   * arbitrated `DriveCommand` for this frame (Req 5.3, 5.4, 5.6, 5.7). The
   * GameLoop may call this directly or call `sample()` + `resolveInput`.
   */
  resolve(): DriveCommand {
    return resolveInput(this.sample());
  }

  /**
   * Update the touch/virtual-button contribution. An on-screen control overlay
   * (virtual joystick + pedals) calls this as the player interacts. Values are
   * passed through to the raw sample and clamped downstream by `resolveInput`.
   */
  setTouchInput(input: Partial<TouchInput>): void {
    this.touch = {
      throttle: input.throttle ?? this.touch.throttle,
      brake: input.brake ?? this.touch.brake,
      steer: input.steer ?? this.touch.steer,
    };
  }

  /** Clear any active touch contribution (e.g. on touchend / blur). */
  clearTouchInput(): void {
    this.touch = { throttle: 0, brake: 0, steer: 0 };
  }

  /**
   * Returns `true` once if a reset (KeyR) was requested since the last call,
   * then clears the latch. Lets the GameLoop consume reset edges without
   * missing or repeating them.
   */
  consumeResetRequested(): boolean {
    const requested = this.resetRequested;
    this.resetRequested = false;
    return requested;
  }

  /** Returns true once if Z was pressed (camera zoom cycle). */
  consumeZoomRequested(): boolean {
    const requested = this.cameraZoomRequested;
    this.cameraZoomRequested = false;
    return requested;
  }

  /** Whether C (rear view) is currently held. */
  isRearViewHeld(): boolean {
    return this.pressed.has('KeyC');
  }

  /** Detach all event listeners and clear transient state. */
  dispose(): void {
    if (this.target) {
      this.target.removeEventListener('keydown', this.onKeyDown);
      this.target.removeEventListener('keyup', this.onKeyUp);
    }
    this.pressed.clear();
    this.resetRequested = false;
    this.clearTouchInput();
  }
}
