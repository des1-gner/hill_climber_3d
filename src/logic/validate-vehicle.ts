// Pure vehicle scene-graph validation, independent of the loader I/O.
//
// After a GLB is parsed, the loaded scene graph must expose exactly one node
// named `chassis` and all four named wheel nodes (`wheel_FL`, `wheel_FR`,
// `wheel_RL`, `wheel_RR`), each individually selectable/transformable (Req 1.2).
// If any required node is missing, the load is treated as failed and gameplay
// is halted with an error naming the missing node (Req 1.5).
//
// This function only inspects an in-memory scene graph, so it can be unit- and
// property-tested without performing real network/file I/O.

import * as THREE from 'three';
import { CHASSIS_NODE, REQUIRED_WHEEL_NODES } from '../constants';
import type { LoadResult, VehicleMeshes } from '../types';

/** Name used to identify the vehicle asset in error reports. */
const VEHICLE_ASSET_NAME = 'vehicle';

/**
 * Validate that a loaded scene graph contains the required vehicle nodes.
 *
 * Looks up the chassis node and the four wheel nodes by name via
 * `Object3D.getObjectByName`. On success returns the chassis plus the four
 * wheels in canonical FL, FR, RL, RR order. On the first missing node it
 * returns a `missing-mesh` failure naming that node (Req 1.5).
 *
 * @param root The root of the parsed GLB scene graph.
 * @returns `{ ok: true, value }` with the validated meshes, or `{ ok: false, error }`.
 *
 * Requirements: 1.2, 1.5
 */
export function validateVehicleGraph(root: THREE.Object3D): LoadResult<VehicleMeshes> {
  const chassis = root.getObjectByName(CHASSIS_NODE);
  if (!chassis) {
    return missingMesh(CHASSIS_NODE);
  }

  const [flName, frName, rlName, rrName] = REQUIRED_WHEEL_NODES;
  const wheelFL = root.getObjectByName(flName);
  if (!wheelFL) {
    return missingMesh(flName);
  }
  const wheelFR = root.getObjectByName(frName);
  if (!wheelFR) {
    return missingMesh(frName);
  }
  const wheelRL = root.getObjectByName(rlName);
  if (!wheelRL) {
    return missingMesh(rlName);
  }
  const wheelRR = root.getObjectByName(rrName);
  if (!wheelRR) {
    return missingMesh(rrName);
  }

  return {
    ok: true,
    value: {
      chassis,
      wheels: [wheelFL, wheelFR, wheelRL, wheelRR],
    },
  };
}

/** Build a `missing-mesh` failure result naming the absent node. */
function missingMesh(missingNode: string): LoadResult<VehicleMeshes> {
  return {
    ok: false,
    error: {
      asset: VEHICLE_ASSET_NAME,
      kind: 'missing-mesh',
      missingNode,
      message: `Vehicle model is missing required node "${missingNode}".`,
    },
  };
}
