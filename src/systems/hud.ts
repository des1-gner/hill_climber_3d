// HUD — DOM-overlay heads-up display for the 3D Car Hill-Climb game.
//
// This is a thin I/O shell. It owns no game rules: it simply renders a
// display-ready `HudView` (produced upstream by the pure `toHudView`
// projection in src/logic/hud.ts) into DOM nodes layered over the WebGL
// canvas. All numeric formatting (fuel rounding to an integer 0–100, distance
// rounded to 0.1 m) is already done by `toHudView`, so the HUD only positions
// and prints those values.
//
// Layout: a small live readout (fuel bar + integer, distance, status) sits in
// the top-left while a run is active. When the run status is `ended`, an
// end-of-run summary panel is shown with the final distance and a friendly
// end-reason label. Because the game loop calls `update` every frame, the
// summary appears on the very frame the run ends — well within the 1 second
// budget required by Req 9.3.
//
// The overlay mount (`#hud-overlay`) has `pointer-events: none` (see
// index.html); interactive children opt back in individually if needed.
//
// Test/SSR safety: construction degrades gracefully when there is no DOM
// (e.g. a `node` test environment or server render). The document is taken
// from `mountEl.ownerDocument`, so a lightweight fake document can be injected
// for testing without a real browser.
//
// Requirements: 7.5, 9.3

import type { EndReason, HudView } from '../types';

/** Friendly, human-readable labels for each run end reason (Req 9.3). */
const END_REASON_LABEL: Record<EndReason, string> = {
  'out-of-fuel': 'Out of fuel',
  overturned: 'Flipped over',
  'player-reset': 'Reset',
};

/** Map an end reason (possibly null) to display text. */
function endReasonLabel(reason: EndReason | null): string {
  if (reason && reason in END_REASON_LABEL) {
    return END_REASON_LABEL[reason];
  }
  return 'Run over';
}

/** Clamp a fuel integer into the displayable [0, 100] range for the bar width. */
function fuelBarPercent(fuelInt: number): number {
  if (!Number.isFinite(fuelInt)) return 0;
  if (fuelInt < 0) return 0;
  if (fuelInt > 100) return 100;
  return fuelInt;
}

const STYLE_ELEMENT_ID = 'hud-style';

/**
 * Inline stylesheet injected once per document. Kept intentionally small; the
 * overlay container's positioning/pointer-events come from index.html.
 */
const HUD_CSS = `
.hud-readout {
  position: absolute;
  top: 16px;
  left: 16px;
  min-width: 180px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font: 600 14px/1.3 system-ui, sans-serif;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
.hud-fuel-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.hud-fuel-bar {
  position: relative;
  flex: 1;
  height: 10px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.2);
  overflow: hidden;
}
.hud-fuel-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 100%;
  border-radius: 5px;
  background: linear-gradient(90deg, #ff5252, #ffd740, #69f0ae);
  transition: width 120ms linear;
}
.hud-fuel-value { min-width: 34px; text-align: right; }
.hud-distance { font-variant-numeric: tabular-nums; }
.hud-status { opacity: 0.75; font-weight: 500; text-transform: capitalize; }

.hud-summary {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  min-width: 240px;
  padding: 24px 28px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  text-align: center;
  font: 500 16px/1.4 system-ui, sans-serif;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
.hud-summary-title { font-size: 22px; font-weight: 700; margin-bottom: 12px; }
.hud-summary-reason { font-size: 18px; margin-bottom: 8px; }
.hud-summary-distance { font-size: 15px; opacity: 0.85; font-variant-numeric: tabular-nums; }
.hud-hidden { display: none; }

.hud-objective {
  position: absolute;
  top: 16px;
  right: 16px;
  min-width: 150px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  text-align: right;
  font: 600 14px/1.4 system-ui, sans-serif;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
.hud-objective-count { color: #ffd54a; font-weight: 700; }
.hud-objective-distance { opacity: 0.85; font-variant-numeric: tabular-nums; }
.hud-toast {
  position: absolute;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 18px;
  border-radius: 999px;
  background: rgba(32, 160, 90, 0.92);
  color: #fff;
  font: 700 16px/1.2 system-ui, sans-serif;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
}
`;

/**
 * DOM-overlay HUD for the gameplay readout and end-of-run summary.
 *
 * Construct with the overlay mount element (e.g. `#hud-overlay`), then call
 * {@link update} every frame with the current {@link HudView}. Call
 * {@link dispose} to remove all created nodes.
 */
export class Hud {
  private readonly mountEl: HTMLElement;
  private readonly doc: Document | null;

  // Live readout nodes (null when no DOM is available).
  private root: HTMLElement | null = null;
  private fuelFill: HTMLElement | null = null;
  private fuelValue: HTMLElement | null = null;
  private distanceEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  // End-of-run summary nodes.
  private summary: HTMLElement | null = null;
  private summaryReason: HTMLElement | null = null;
  private summaryDistance: HTMLElement | null = null;

  // Objective / checkpoint nodes.
  private objectivePanel: HTMLElement | null = null;
  private objectiveCount: HTMLElement | null = null;
  private objectiveDistance: HTMLElement | null = null;
  private toast: HTMLElement | null = null;

  /** Last reached-checkpoint count seen, to detect increments for the toast. */
  private lastReachedCount = 0;
  /** Timestamp (ms) after which the checkpoint toast is hidden. */
  private toastHideAt = 0;

  /**
   * @param mountEl The overlay container the HUD nodes are appended under
   *                (typically the `#hud-overlay` element). The owning document
   *                is read from `mountEl.ownerDocument`.
   */
  constructor(mountEl: HTMLElement) {
    this.mountEl = mountEl;

    // Resolve the document defensively: prefer the mount's owner document,
    // fall back to a global `document` if present. Either may be absent in a
    // headless/SSR/test context, in which case the HUD becomes a no-op.
    const ownerDoc = (mountEl && mountEl.ownerDocument) || null;
    const globalDoc =
      typeof document !== 'undefined' ? (document as Document) : null;
    this.doc = ownerDoc ?? globalDoc;

    if (this.doc) {
      this.injectStyles(this.doc);
      this.buildDom(this.doc);
    }
  }

  /** Inject the HUD stylesheet once per document. */
  private injectStyles(doc: Document): void {
    const head = doc.head ?? doc.body ?? null;
    if (!head || (doc.getElementById && doc.getElementById(STYLE_ELEMENT_ID))) {
      return;
    }
    const style = doc.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = HUD_CSS;
    head.appendChild(style);
  }

  /** Build the readout and summary node trees and append them to the mount. */
  private buildDom(doc: Document): void {
    // --- Live readout ---
    const root = doc.createElement('div');
    root.className = 'hud-readout';

    const fuelRow = doc.createElement('div');
    fuelRow.className = 'hud-fuel-row';

    const fuelBar = doc.createElement('div');
    fuelBar.className = 'hud-fuel-bar';
    const fuelFill = doc.createElement('div');
    fuelFill.className = 'hud-fuel-bar-fill';
    fuelBar.appendChild(fuelFill);

    const fuelValue = doc.createElement('span');
    fuelValue.className = 'hud-fuel-value';
    fuelValue.textContent = '100';

    fuelRow.appendChild(fuelBar);
    fuelRow.appendChild(fuelValue);

    const distanceEl = doc.createElement('div');
    distanceEl.className = 'hud-distance';
    distanceEl.textContent = '0.0 m';

    const statusEl = doc.createElement('div');
    statusEl.className = 'hud-status';
    statusEl.textContent = 'idle';

    root.appendChild(fuelRow);
    root.appendChild(distanceEl);
    root.appendChild(statusEl);

    // --- End-of-run summary (hidden until the run ends) ---
    const summary = doc.createElement('div');
    summary.className = 'hud-summary hud-hidden';

    const title = doc.createElement('div');
    title.className = 'hud-summary-title';
    title.textContent = 'Run complete';

    const summaryReason = doc.createElement('div');
    summaryReason.className = 'hud-summary-reason';

    const summaryDistance = doc.createElement('div');
    summaryDistance.className = 'hud-summary-distance';

    summary.appendChild(title);
    summary.appendChild(summaryReason);
    summary.appendChild(summaryDistance);

    this.mountEl.appendChild(root);
    this.mountEl.appendChild(summary);

    // --- Objective / checkpoint panel + reached toast ---
    const objectivePanel = doc.createElement('div');
    objectivePanel.className = 'hud-objective';
    const objectiveCount = doc.createElement('div');
    objectiveCount.className = 'hud-objective-count';
    objectiveCount.textContent = 'Checkpoints: 0';
    const objectiveDistance = doc.createElement('div');
    objectiveDistance.className = 'hud-objective-distance';
    objectiveDistance.textContent = 'Next: — m';
    objectivePanel.appendChild(objectiveCount);
    objectivePanel.appendChild(objectiveDistance);

    const toast = doc.createElement('div');
    toast.className = 'hud-toast hud-hidden';

    this.mountEl.appendChild(objectivePanel);
    this.mountEl.appendChild(toast);

    this.root = root;
    this.fuelFill = fuelFill;
    this.fuelValue = fuelValue;
    this.distanceEl = distanceEl;
    this.statusEl = statusEl;
    this.summary = summary;
    this.summaryReason = summaryReason;
    this.summaryDistance = summaryDistance;
    this.objectivePanel = objectivePanel;
    this.objectiveCount = objectiveCount;
    this.objectiveDistance = objectiveDistance;
    this.toast = toast;
  }

  /**
   * Render the current HUD view. Safe to call every frame.
   *
   * While the run is active (status `idle`/`running`) the live readout shows
   * the fuel integer + bar width % (Req 7.5), the distance text, and the run
   * status. When the status is `ended`, the end-of-run summary panel is shown
   * with the final distance and a friendly end-reason label (Req 9.3); since
   * the loop calls this on the ending frame, the summary appears immediately.
   *
   * No-ops when no DOM is available.
   *
   * @param view Display-ready projection from `toHudView`.
   */
  update(view: HudView): void {
    if (!this.doc || !this.root) return;

    // Live readout — always kept current.
    if (this.fuelValue) {
      this.fuelValue.textContent = String(view.fuelInt);
    }
    if (this.fuelFill) {
      this.fuelFill.style.width = `${fuelBarPercent(view.fuelInt)}%`;
    }
    if (this.distanceEl) {
      this.distanceEl.textContent = view.distanceText;
    }
    if (this.statusEl) {
      this.statusEl.textContent = view.status;
    }

    const ended = view.status === 'ended';

    // Toggle the live readout / summary panels by status.
    this.setHidden(this.root, ended);
    this.setHidden(this.summary, !ended);

    if (ended) {
      if (this.summaryReason) {
        this.summaryReason.textContent = endReasonLabel(view.endReason);
      }
      if (this.summaryDistance) {
        this.summaryDistance.textContent = `Distance: ${view.distanceText}`;
      }
    }
  }

  /** Add/remove the `hud-hidden` class to show or hide a node. */
  private setHidden(el: HTMLElement | null, hidden: boolean): void {
    if (!el) return;
    if (el.classList && typeof el.classList.toggle === 'function') {
      el.classList.toggle('hud-hidden', hidden);
    } else {
      // Fallback for minimal DOM shims without classList.
      el.style.display = hidden ? 'none' : '';
    }
  }

  /**
   * Update the objective/checkpoint readout. Shows the number of checkpoints
   * reached and the horizontal distance to the next one. When the reached count
   * increases, a short-lived "checkpoint reached" toast is shown.
   *
   * Safe to call every frame; no-ops when no DOM is available.
   *
   * @param reachedCount checkpoints reached so far
   * @param distanceMeters horizontal distance to the next checkpoint
   */
  setObjective(reachedCount: number, distanceMeters: number): void {
    if (!this.doc || !this.objectivePanel) return;

    if (this.objectiveCount) {
      this.objectiveCount.textContent = `Checkpoints: ${reachedCount}`;
    }
    if (this.objectiveDistance) {
      const d = Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : 0;
      this.objectiveDistance.textContent = `Next: ${d} m`;
    }

    const now =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();

    // Newly reached a checkpoint -> flash the toast.
    if (reachedCount > this.lastReachedCount) {
      this.lastReachedCount = reachedCount;
      if (this.toast) {
        this.toast.textContent = `Checkpoint ${reachedCount} reached!`;
        this.setHidden(this.toast, false);
      }
      this.toastHideAt = now + 2200;
    } else if (this.toast && now > this.toastHideAt) {
      this.setHidden(this.toast, true);
    }
  }

  /** Remove all HUD nodes from the DOM. Safe to call when never built. */
  dispose(): void {
    for (const el of [this.root, this.summary, this.objectivePanel, this.toast]) {
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }
    this.root = null;
    this.summary = null;
    this.fuelFill = null;
    this.fuelValue = null;
    this.distanceEl = null;
    this.statusEl = null;
    this.summaryReason = null;
    this.summaryDistance = null;
    this.objectivePanel = null;
    this.objectiveCount = null;
    this.objectiveDistance = null;
    this.toast = null;
  }
}
