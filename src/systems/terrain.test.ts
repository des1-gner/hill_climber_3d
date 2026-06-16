// Property-based tests for the infinite procedural terrain field.
//
// The world is endless, so we sample the field over arbitrary regions of the
// plane and assert it stays well-formed: finite everywhere (no vertical
// discontinuities) and with local gradients bounded under 45 degrees so it is
// drivable (Req 4.1).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { terrainElevation, maxLocalGradientDegrees } from './terrain';

const NUM_RUNS = 150;
const MAX_GRADIENT_DEGREES = 45;
const GRADIENT_EPSILON = 1e-6;

// Mesh-equivalent sample spacing (chunks are CHUNK_SIZE/CHUNK_SEGMENTS = 3 m).
const SAMPLE_SPACING = 3;

const coord = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

describe('terrainElevation (infinite field)', () => {
  // Feature: 3d-car-hill-climb, Property 7: Generated terrain is continuous with bounded gradient
  // Validates: Requirements 4.1
  it('Property 7 (continuity): elevation is finite anywhere on the infinite plane', () => {
    fc.assert(
      fc.property(coord(-100000, 100000), coord(-100000, 100000), (x, z) => {
        expect(Number.isFinite(terrainElevation(x, z))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 7: Generated terrain is continuous with bounded gradient
  // Validates: Requirements 4.1
  it('Property 7 (gradient bound): local gradient stays <= 45 degrees over any region', () => {
    fc.assert(
      fc.property(
        coord(-50000, 50000),
        coord(-50000, 50000),
        fc.integer({ min: 4, max: 30 }),
        (originX, originZ, cells) => {
          const span = cells * SAMPLE_SPACING;
          const gradient = maxLocalGradientDegrees(
            terrainElevation,
            { minX: originX, maxX: originX + span, minZ: originZ, maxZ: originZ + span },
            { x: cells, z: cells },
          );
          expect(Number.isFinite(gradient)).toBe(true);
          expect(gradient).toBeLessThanOrEqual(MAX_GRADIENT_DEGREES + GRADIENT_EPSILON);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: 3d-car-hill-climb, Property 7: Generated terrain is continuous with bounded gradient
  // Validates: Requirements 4.1
  it('Property 7 (continuity): per-step elevation delta shrinks with the step', () => {
    fc.assert(
      fc.property(
        coord(-10000, 10000),
        coord(-10000, 10000),
        fc.double({ min: 1e-6, max: 0.5, noNaN: true, noDefaultInfinity: true }),
        (x, z, eps) => {
          const h = terrainElevation(x, z);
          const dx = Math.abs(terrainElevation(x + eps, z) - h);
          const dz = Math.abs(terrainElevation(x, z + eps) - h);
          // Slope < 45 deg means |delta| <= eps; allow a small higher-order margin.
          const bound = eps * 1.5 + 1e-9;
          expect(dx).toBeLessThanOrEqual(bound);
          expect(dz).toBeLessThanOrEqual(bound);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
