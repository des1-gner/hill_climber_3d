// Tests for the pure surface-friction logic.
//
// Uses fast-check + Vitest. Covers the friction-bounds correctness property
// (Property 10 / Req 6.5) as it applies to the friction clamp/resolution
// helpers used by the terrain collider.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { clampFriction, resolveRegionFriction } from './friction';
import { FRICTION_MIN, FRICTION_MAX, DEFAULT_TERRAIN_FRICTION } from '../constants';

const NUM_RUNS = 200;

describe('clampFriction', () => {
  it('passes in-range values through unchanged', () => {
    expect(clampFriction(0.05)).toBe(0.05);
    expect(clampFriction(1.0)).toBe(1.0);
    expect(clampFriction(1.5)).toBe(1.5);
  });

  it('clamps out-of-range values to the nearest bound', () => {
    expect(clampFriction(0)).toBe(FRICTION_MIN);
    expect(clampFriction(-3)).toBe(FRICTION_MIN);
    expect(clampFriction(2.5)).toBe(FRICTION_MAX);
  });

  it('coerces non-finite values to the default terrain friction', () => {
    expect(clampFriction(NaN)).toBe(DEFAULT_TERRAIN_FRICTION);
    expect(clampFriction(Infinity)).toBe(DEFAULT_TERRAIN_FRICTION);
    expect(clampFriction(-Infinity)).toBe(DEFAULT_TERRAIN_FRICTION);
  });

  // Feature: 3d-car-hill-climb, Property 10: Surface friction coefficient stays within bounds
  // Validates: Requirements 6.5
  it('Property 10: clamped friction always lies within [0.05, 1.50]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
        (raw) => {
          const f = clampFriction(raw);
          expect(f).toBeGreaterThanOrEqual(FRICTION_MIN);
          expect(f).toBeLessThanOrEqual(FRICTION_MAX);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('resolveRegionFriction', () => {
  it('returns the clamped region value when present', () => {
    const table = new Map<string, number>([['ice', 0.05], ['tarmac', 1.2]]);
    expect(resolveRegionFriction(table, 'tarmac')).toBe(1.2);
    expect(resolveRegionFriction(table, 'ice')).toBe(0.05);
  });

  it('clamps an out-of-range region value', () => {
    const table = new Map<string, number>([['superglue', 9]]);
    expect(resolveRegionFriction(table, 'superglue')).toBe(FRICTION_MAX);
  });

  it('falls back to the default when the region is missing', () => {
    const table = new Map<string, number>([['tarmac', 1.2]]);
    expect(resolveRegionFriction(table, 'unknown')).toBe(DEFAULT_TERRAIN_FRICTION);
    expect(resolveRegionFriction(undefined, 'tarmac')).toBe(DEFAULT_TERRAIN_FRICTION);
    expect(resolveRegionFriction(table, undefined)).toBe(DEFAULT_TERRAIN_FRICTION);
  });

  // Feature: 3d-car-hill-climb, Property 10: Surface friction coefficient stays within bounds
  // Validates: Requirements 6.5
  it('Property 10: resolved region friction always lies within [0.05, 1.50]', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string(),
          fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
        ),
        fc.string(),
        (dict, region) => {
          const table = new Map<string, number>(Object.entries(dict));
          const f = resolveRegionFriction(table, region);
          expect(f).toBeGreaterThanOrEqual(FRICTION_MIN);
          expect(f).toBeLessThanOrEqual(FRICTION_MAX);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
