import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { validateVehicleGraph } from './validate-vehicle';
import { CHASSIS_NODE, REQUIRED_WHEEL_NODES } from '../constants';

// Feature: 3d-car-hill-climb, Property 1: Vehicle scene-graph validation
//
// validateVehicleGraph succeeds if and only if the scene graph contains a node
// named 'chassis' and all four wheel nodes ('wheel_FL','wheel_FR','wheel_RL',
// 'wheel_RR'); otherwise it fails with a 'missing-mesh' error naming an absent
// required node. We build graphs by randomly including/excluding each required
// node plus random decoy nodes.
//
// Validates: Requirements 1.2, 1.5

const NUM_RUNS = 200;

// All required node names in the order the validator checks them.
const REQUIRED_NODES: readonly string[] = [CHASSIS_NODE, ...REQUIRED_WHEEL_NODES];

/** Build a scene-graph root from a set of present required nodes plus decoys. */
function buildGraph(present: Record<string, boolean>, decoys: string[]): THREE.Object3D {
  const root = new THREE.Object3D();
  root.name = 'root';

  // Add the included required nodes.
  for (const name of REQUIRED_NODES) {
    if (present[name]) {
      const node = new THREE.Object3D();
      node.name = name;
      root.add(node);
    }
  }

  // Add decoy nodes that are guaranteed not to collide with required names.
  for (const name of decoys) {
    const node = new THREE.Object3D();
    node.name = name;
    root.add(node);
  }

  return root;
}

describe('validateVehicleGraph (Property 1: scene-graph validation)', () => {
  it('succeeds iff all required nodes are present; otherwise fails naming an absent node', () => {
    fc.assert(
      fc.property(
        // Independently include/exclude each required node.
        fc.record({
          [CHASSIS_NODE]: fc.boolean(),
          wheel_FL: fc.boolean(),
          wheel_FR: fc.boolean(),
          wheel_RL: fc.boolean(),
          wheel_RR: fc.boolean(),
        }),
        // Random extra decoy node names that never collide with required names.
        fc.array(
          fc.string().filter((s) => !REQUIRED_NODES.includes(s)),
          { minLength: 0, maxLength: 8 },
        ),
        (presence, decoys) => {
          const present = presence as Record<string, boolean>;
          const root = buildGraph(present, decoys);

          const allPresent = REQUIRED_NODES.every((name) => present[name]);
          const absent = REQUIRED_NODES.filter((name) => !present[name]);

          const result = validateVehicleGraph(root);

          // Success exactly mirrors "all required nodes present".
          expect(result.ok).toBe(allPresent);

          if (result.ok) {
            // On success the validated meshes expose chassis + 4 wheels in order.
            expect(result.value.chassis.name).toBe(CHASSIS_NODE);
            const wheelNames = result.value.wheels.map((w) => w.name);
            expect(wheelNames).toEqual([...REQUIRED_WHEEL_NODES]);
          } else {
            // On failure the error is a missing-mesh error naming an absent node.
            expect(result.error.kind).toBe('missing-mesh');
            expect(result.error.missingNode).toBeDefined();
            expect(absent).toContain(result.error.missingNode);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
