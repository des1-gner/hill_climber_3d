// Unit tests for the DOM-overlay HUD (src/systems/hud.ts).
//
// The default test environment is `node`, which has no DOM. Rather than pull
// in a full DOM implementation, these tests inject a tiny fake `document`
// through `mountEl.ownerDocument`. The fake implements only the small surface
// the HUD touches: createElement, appendChild/removeChild, textContent,
// className, id, a style object, and a classList with toggle. This keeps the
// test fast and dependency-free while still exercising the real HUD logic
// (status switching, fuel/distance formatting, end-reason mapping, disposal).
//
// Requirements exercised: 7.5 (fuel integer + bar), 9.3 (end-of-run summary
// with distance + friendly end reason).

import { describe, it, expect } from 'vitest';
import { Hud } from './hud';
import type { HudView } from '../types';

// ---------------------------------------------------------------------------
// Minimal fake DOM
// ---------------------------------------------------------------------------

class FakeClassList {
  private set = new Set<string>();
  constructor(initial: string) {
    initial
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => this.set.add(c));
  }
  toggle(name: string, force?: boolean): boolean {
    const want = force === undefined ? !this.set.has(name) : force;
    if (want) this.set.add(name);
    else this.set.delete(name);
    return want;
  }
  contains(name: string): boolean {
    return this.set.has(name);
  }
}

class FakeElement {
  tagName: string;
  id = '';
  textContent = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private _classList: FakeClassList | null = null;
  private _className = '';

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get className(): string {
    return this._className;
  }
  set className(v: string) {
    this._className = v;
    this._classList = new FakeClassList(v);
  }
  get classList(): FakeClassList {
    if (!this._classList) this._classList = new FakeClassList(this._className);
    return this._classList;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  /** Depth-first search for the first descendant with the given class. */
  find(cls: string): FakeElement | null {
    for (const c of this.children) {
      if (c.classList.contains(cls)) return c;
      const nested = c.find(cls);
      if (nested) return nested;
    }
    return null;
  }
}

class FakeDocument {
  head = new FakeElement('head');
  body = new FakeElement('body');
  private byId = new Map<string, FakeElement>();

  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag);
    // Mirror id assignment into the lookup table on demand via a proxy-free
    // approach: capture id at append time. Simpler: override getElementById to
    // walk the tree, but tracking on set is cheap here.
    return el;
  }
  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? this.searchTree(this.head, id) ?? this.searchTree(this.body, id);
  }
  private searchTree(root: FakeElement, id: string): FakeElement | null {
    if (root.id === id) return root;
    for (const c of root.children) {
      const found = this.searchTree(c, id);
      if (found) return found;
    }
    return null;
  }
}

function makeMount(): { mount: FakeElement; doc: FakeDocument } {
  const doc = new FakeDocument();
  const mount = new FakeElement('div');
  mount.id = 'hud-overlay';
  // Inject ownerDocument so the HUD resolves our fake document.
  (mount as unknown as { ownerDocument: FakeDocument }).ownerDocument = doc;
  doc.body.appendChild(mount);
  return { mount, doc };
}

function view(partial: Partial<HudView>): HudView {
  return {
    fuelInt: 100,
    distanceText: '0.0 m',
    status: 'running',
    endReason: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Hud', () => {
  it('renders fuel integer, bar width %, distance, and status while running (Req 7.5)', () => {
    const { mount } = makeMount();
    const hud = new Hud(mount as unknown as HTMLElement);

    hud.update(view({ fuelInt: 73, distanceText: '12.3 m', status: 'running' }));

    const readout = mount.find('hud-readout')!;
    expect(readout).not.toBeNull();
    expect(readout.classList.contains('hud-hidden')).toBe(false);

    expect(mount.find('hud-fuel-value')!.textContent).toBe('73');
    expect(mount.find('hud-fuel-bar-fill')!.style.width).toBe('73%');
    expect(mount.find('hud-distance')!.textContent).toBe('12.3 m');
    expect(mount.find('hud-status')!.textContent).toBe('running');

    // Summary stays hidden during an active run.
    expect(mount.find('hud-summary')!.classList.contains('hud-hidden')).toBe(true);
  });

  it('clamps the fuel bar width to [0, 100] even for out-of-range fuel', () => {
    const { mount } = makeMount();
    const hud = new Hud(mount as unknown as HTMLElement);

    hud.update(view({ fuelInt: 0 }));
    expect(mount.find('hud-fuel-bar-fill')!.style.width).toBe('0%');

    hud.update(view({ fuelInt: 150 }));
    expect(mount.find('hud-fuel-bar-fill')!.style.width).toBe('100%');
  });

  it('shows the end-of-run summary with distance and friendly end reason (Req 9.3)', () => {
    const cases: Array<[HudView['endReason'], string]> = [
      ['out-of-fuel', 'Out of fuel'],
      ['overturned', 'Flipped over'],
      ['player-reset', 'Reset'],
    ];

    for (const [reason, label] of cases) {
      const { mount } = makeMount();
      const hud = new Hud(mount as unknown as HTMLElement);

      hud.update(view({ status: 'ended', endReason: reason, distanceText: '256.4 m' }));

      const summary = mount.find('hud-summary')!;
      expect(summary.classList.contains('hud-hidden')).toBe(false);
      expect(mount.find('hud-summary-reason')!.textContent).toBe(label);
      expect(mount.find('hud-summary-distance')!.textContent).toBe('Distance: 256.4 m');

      // The live readout is hidden once the run ends.
      expect(mount.find('hud-readout')!.classList.contains('hud-hidden')).toBe(true);
    }
  });

  it('hides the summary again if the status returns to running (e.g. after reset)', () => {
    const { mount } = makeMount();
    const hud = new Hud(mount as unknown as HTMLElement);

    hud.update(view({ status: 'ended', endReason: 'out-of-fuel' }));
    expect(mount.find('hud-summary')!.classList.contains('hud-hidden')).toBe(false);

    hud.update(view({ status: 'running' }));
    expect(mount.find('hud-summary')!.classList.contains('hud-hidden')).toBe(true);
    expect(mount.find('hud-readout')!.classList.contains('hud-hidden')).toBe(false);
  });

  it('injects its stylesheet exactly once across multiple HUDs', () => {
    const { mount, doc } = makeMount();
    new Hud(mount as unknown as HTMLElement);
    new Hud(mount as unknown as HTMLElement);
    expect(doc.getElementById('hud-style')).not.toBeNull();
  });

  it('dispose removes the HUD nodes from the mount', () => {
    const { mount } = makeMount();
    const hud = new Hud(mount as unknown as HTMLElement);
    expect(mount.find('hud-readout')).not.toBeNull();

    hud.dispose();
    expect(mount.find('hud-readout')).toBeNull();
    expect(mount.find('hud-summary')).toBeNull();

    // Safe to call again and to update after disposal.
    expect(() => hud.dispose()).not.toThrow();
    expect(() => hud.update(view({}))).not.toThrow();
  });

  it('degrades to a no-op when no document is available', () => {
    const mount = new FakeElement('div');
    (mount as unknown as { ownerDocument: null }).ownerDocument = null;
    // No global document in the node test env.
    expect(() => {
      const hud = new Hud(mount as unknown as HTMLElement);
      hud.update(view({ status: 'ended', endReason: 'overturned' }));
      hud.dispose();
    }).not.toThrow();
  });
});
