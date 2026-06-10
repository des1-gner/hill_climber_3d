// Property + example tests for the biome-based surface-friction system.
//
// Different biomes affect the car via different grip. Whatever biome is
// resolved, the friction it produces must stay within the required
// [0.05, 1.50] bound (Req 6.5), and snow must be the most slippery so it
// actually feels different to drive on.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { biomeAt, surfaceFrictionAt, BIOME_FRICTION } from './terrain';
import { FRICTION_MIN, FRICTION_MAX } from '../constants';

const coord = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

describe('biome surface friction', () => {
  // Feature: 3d-car-hill-climb, Property 10: Surface friction coefficient stays within bounds
  // Validates: Requirements 6.5
  it('surfaceFrictionAt is always within [0.05, 1.50] across the infinite plane', () => {
    fc.assert(
      fc.property(coord(-50000, 50000), coord(-50000, 50000), (x, z) => {
        const f = surfaceFrictionAt(x, z);
        expect(f).toBeGreaterThanOrEqual(FRICTION_MIN);
        expect(f).toBeLessThanOrEqual(FRICTION_MAX);
      }),
      { numRuns: 300 },
    );
  });

  it('every biome friction is within bounds and snow is the slipperiest', () => {
    for (const f of Object.values(BIOME_FRICTION)) {
      expect(f).toBeGreaterThanOrEqual(FRICTION_MIN);
      expect(f).toBeLessThanOrEqual(FRICTION_MAX);
    }
    expect(BIOME_FRICTION.snow).toBeLessThan(BIOME_FRICTION.grassland);
    expect(BIOME_FRICTION.snow).toBeLessThan(BIOME_FRICTION.forest);
    expect(BIOME_FRICTION.snow).toBeLessThan(BIOME_FRICTION.rocky);
  });

  it('resolves the friction of whatever biome a coordinate falls in', () => {
    // Scan a region to confirm each reachable biome maps to its coefficient.
    for (let x = -2000; x <= 2000; x += 53) {
      for (let z = -2000; z <= 2000; z += 53) {
        expect(surfaceFrictionAt(x, z)).toBe(BIOME_FRICTION[biomeAt(x, z)]);
      }
    }
  });

  it('is deterministic for a given coordinate', () => {
    expect(surfaceFrictionAt(12.5, -40.2)).toBe(surfaceFrictionAt(12.5, -40.2));
    expect(biomeAt(12.5, -40.2)).toBe(biomeAt(12.5, -40.2));
  });
});
