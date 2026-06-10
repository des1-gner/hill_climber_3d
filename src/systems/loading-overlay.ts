// LoadingOverlay — a small DOM overlay shown above the WebGL canvas during the
// bootstrap sequence (asset loading) and used to surface fatal/asset errors.
//
// Responsibilities (Req 1.3, 1.4, 1.5, 4.2):
// - `showProgress(percent)` renders a 0..100 progress bar while the vehicle and
//   terrain GLBs load, reporting combined load progress (Req 1.4).
// - `showError(assetName, message, onRetry?)` switches the overlay from the
//   progress view to an error panel that NAMES the failed asset and offers a
//   retry affordance (a button that re-runs bootstrap) (Req 1.3, 1.5, 4.2).
// - `hide()` removes the overlay from view — called by the bootstrap only after
//   all required meshes are validated and mounted into the scene (Req 1.4).
//
// This is a thin I/O shell with no game rules. It degrades gracefully when no
// DOM is available (SSR/test) so importing it never throws; in that case every
// method is a no-op. The owning document is taken from the mount element so a
// lightweight fake document can be injected for testing.

const STYLE_ELEMENT_ID = 'loading-overlay-style';

/** Inline stylesheet injected once per document. */
const OVERLAY_CSS = `
.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  background: radial-gradient(circle at 50% 40%, #243049, #11151f 75%);
  color: #fff;
  font: 500 16px/1.4 system-ui, sans-serif;
  z-index: 10;
  pointer-events: auto;
}
.loading-overlay.loading-overlay-hidden { display: none; }

.loading-overlay-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.loading-overlay-progress-wrap {
  width: min(60vw, 360px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.loading-overlay-bar {
  position: relative;
  width: 100%;
  height: 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.15);
  overflow: hidden;
}
.loading-overlay-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  border-radius: 6px;
  background: linear-gradient(90deg, #4f8cff, #69f0ae);
  transition: width 120ms linear;
}
.loading-overlay-percent {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  font-size: 14px;
}

.loading-overlay-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: min(80vw, 460px);
  text-align: center;
}
.loading-overlay-error-title {
  font-size: 20px;
  font-weight: 700;
  color: #ff6b6b;
}
.loading-overlay-error-asset {
  font-size: 16px;
  font-weight: 600;
}
.loading-overlay-error-message {
  font-size: 14px;
  opacity: 0.85;
  word-break: break-word;
}
.loading-overlay-retry {
  margin-top: 4px;
  padding: 10px 22px;
  border: 0;
  border-radius: 8px;
  background: #4f8cff;
  color: #fff;
  font: 600 15px/1 system-ui, sans-serif;
  cursor: pointer;
}
.loading-overlay-retry:hover { background: #3d76e0; }
.loading-overlay-hidden-section { display: none; }
`;

/** Clamp a raw percent into the inclusive [0, 100] display range. */
function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  if (percent < 0) return 0;
  if (percent > 100) return 100;
  return percent;
}

/**
 * DOM-overlay loading indicator and error panel for the bootstrap sequence.
 *
 * Construct with the container the overlay should fill (typically `#app`, the
 * positioned wrapper around the canvas), then drive it with
 * {@link showProgress}, {@link showError}, and {@link hide}.
 */
export class LoadingOverlay {
  private readonly doc: Document | null;

  private root: HTMLElement | null = null;
  private progressSection: HTMLElement | null = null;
  private barFill: HTMLElement | null = null;
  private percentLabel: HTMLElement | null = null;

  private errorSection: HTMLElement | null = null;
  private errorAsset: HTMLElement | null = null;
  private errorMessage: HTMLElement | null = null;
  private retryButton: HTMLButtonElement | null = null;

  /** Current retry handler, invoked when the retry button is pressed. */
  private retryHandler: (() => void) | null = null;

  private readonly onRetryClick = (): void => {
    const handler = this.retryHandler;
    if (handler) {
      handler();
    }
  };

  /**
   * @param mountEl The positioned container the overlay fills (e.g. `#app`).
   *                The owning document is read from `mountEl.ownerDocument`.
   */
  constructor(mountEl: HTMLElement) {
    const ownerDoc = (mountEl && mountEl.ownerDocument) || null;
    const globalDoc = typeof document !== 'undefined' ? (document as Document) : null;
    this.doc = ownerDoc ?? globalDoc;

    if (this.doc) {
      this.injectStyles(this.doc);
      this.buildDom(this.doc, mountEl);
    }
  }

  /** Inject the overlay stylesheet once per document. */
  private injectStyles(doc: Document): void {
    const head = doc.head ?? doc.body ?? null;
    if (!head || (doc.getElementById && doc.getElementById(STYLE_ELEMENT_ID))) {
      return;
    }
    const style = doc.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = OVERLAY_CSS;
    head.appendChild(style);
  }

  /** Build the progress + error node trees and append them to the mount. */
  private buildDom(doc: Document, mountEl: HTMLElement): void {
    const root = doc.createElement('div');
    root.className = 'loading-overlay';

    // --- Progress view ---
    const progressSection = doc.createElement('div');
    progressSection.className = 'loading-overlay-progress-wrap';

    const title = doc.createElement('div');
    title.className = 'loading-overlay-title';
    title.textContent = 'Loading…';

    const bar = doc.createElement('div');
    bar.className = 'loading-overlay-bar';
    const barFill = doc.createElement('div');
    barFill.className = 'loading-overlay-bar-fill';
    bar.appendChild(barFill);

    const percentLabel = doc.createElement('div');
    percentLabel.className = 'loading-overlay-percent';
    percentLabel.textContent = '0%';

    progressSection.appendChild(title);
    progressSection.appendChild(bar);
    progressSection.appendChild(percentLabel);

    // --- Error view (hidden until showError) ---
    const errorSection = doc.createElement('div');
    errorSection.className = 'loading-overlay-error loading-overlay-hidden-section';

    const errorTitle = doc.createElement('div');
    errorTitle.className = 'loading-overlay-error-title';
    errorTitle.textContent = 'Unable to start';

    const errorAsset = doc.createElement('div');
    errorAsset.className = 'loading-overlay-error-asset';

    const errorMessage = doc.createElement('div');
    errorMessage.className = 'loading-overlay-error-message';

    const retryButton = doc.createElement('button');
    retryButton.className = 'loading-overlay-retry';
    retryButton.type = 'button';
    retryButton.textContent = 'Retry';
    if (typeof retryButton.addEventListener === 'function') {
      retryButton.addEventListener('click', this.onRetryClick);
    }

    errorSection.appendChild(errorTitle);
    errorSection.appendChild(errorAsset);
    errorSection.appendChild(errorMessage);
    errorSection.appendChild(retryButton);

    root.appendChild(progressSection);
    root.appendChild(errorSection);
    mountEl.appendChild(root);

    this.root = root;
    this.progressSection = progressSection;
    this.barFill = barFill;
    this.percentLabel = percentLabel;
    this.errorSection = errorSection;
    this.errorAsset = errorAsset;
    this.errorMessage = errorMessage;
    this.retryButton = retryButton;
  }

  /**
   * Show (or update) the progress view with a percentage in [0, 100].
   *
   * Switches the overlay back to the progress view if it was previously showing
   * an error (so a retry re-renders progress), un-hides the overlay, and sizes
   * the progress bar to reflect the clamped percent (Req 1.4). No-ops without a
   * DOM.
   *
   * @param percent Combined load progress, 0..100.
   */
  showProgress(percent: number): void {
    if (!this.root) return;
    const p = clampPercent(percent);

    this.setHidden(this.root, false);
    this.setSectionHidden(this.errorSection, true);
    this.setSectionHidden(this.progressSection, false);

    if (this.barFill) {
      this.barFill.style.width = `${p}%`;
    }
    if (this.percentLabel) {
      this.percentLabel.textContent = `${Math.round(p)}%`;
    }
  }

  /**
   * Switch the overlay to the error panel, naming the failed asset and offering
   * a retry affordance (Req 1.3, 1.5, 4.2).
   *
   * @param assetName Name of the failed/missing asset (e.g. "vehicle").
   * @param message   Human-readable failure detail.
   * @param onRetry   Optional handler invoked when the retry button is pressed.
   *                  When omitted, the retry button is hidden.
   */
  showError(assetName: string, message: string, onRetry?: () => void): void {
    if (!this.root) return;

    this.retryHandler = onRetry ?? null;

    this.setHidden(this.root, false);
    this.setSectionHidden(this.progressSection, true);
    this.setSectionHidden(this.errorSection, false);

    if (this.errorAsset) {
      this.errorAsset.textContent = `Failed asset: ${assetName}`;
    }
    if (this.errorMessage) {
      this.errorMessage.textContent = message;
    }
    if (this.retryButton) {
      this.setHidden(this.retryButton, !onRetry);
    }
  }

  /**
   * Hide the overlay entirely. Called by the bootstrap only after all required
   * meshes have been validated and added to the scene (Req 1.4). No-ops without
   * a DOM.
   */
  hide(): void {
    if (!this.root) return;
    this.setHidden(this.root, true);
  }

  /** Detach listeners and remove the overlay nodes from the DOM. */
  dispose(): void {
    if (this.retryButton && typeof this.retryButton.removeEventListener === 'function') {
      this.retryButton.removeEventListener('click', this.onRetryClick);
    }
    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.root = null;
    this.progressSection = null;
    this.barFill = null;
    this.percentLabel = null;
    this.errorSection = null;
    this.errorAsset = null;
    this.errorMessage = null;
    this.retryButton = null;
    this.retryHandler = null;
  }

  /** Toggle the top-level hidden class on the overlay root or a button. */
  private setHidden(el: HTMLElement, hidden: boolean): void {
    if (el.classList && typeof el.classList.toggle === 'function') {
      el.classList.toggle('loading-overlay-hidden', hidden);
    } else {
      el.style.display = hidden ? 'none' : '';
    }
  }

  /** Toggle the per-section hidden class (progress vs error views). */
  private setSectionHidden(el: HTMLElement | null, hidden: boolean): void {
    if (!el) return;
    if (el.classList && typeof el.classList.toggle === 'function') {
      el.classList.toggle('loading-overlay-hidden-section', hidden);
    } else {
      el.style.display = hidden ? 'none' : '';
    }
  }
}
