import { describe, it, expect, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { GltfAssetLoader, type GltfLoaderLike } from './asset-loader';
import { LOAD_TIMEOUT_MS, CHASSIS_NODE, REQUIRED_WHEEL_NODES } from '../constants';
import type { LoadProgress } from '../types';

// Feature: 3d-car-hill-climb, Task 9.2: edge-case tests for the asset loader.
//
// These are example/edge-case tests (not property tests) covering the loader's
// failure and success paths without real network/file I/O. A controllable stub
// implementing `GltfLoaderLike` is injected so each test can deterministically
// drive the underlying `GLTFLoader.load` callbacks (success, error) or leave a
// load pending forever (timeout).
//
// Validates: Requirements 1.3, 1.5

/** A single captured `load` invocation and its callbacks. */
interface PendingLoad {
  url: string;
  onLoad: (gltf: GLTF) => void;
  onProgress?: ((event: ProgressEvent) => void) | undefined;
  onError?: ((err: unknown) => void) | undefined;
}

/**
 * Controllable stub `GLTFLoader`. It records each `load` call and exposes
 * helpers to resolve it with a scene, fail it with an error, or emit progress.
 * A load left untouched never settles, which exercises the timeout path.
 */
class StubGltfLoader implements GltfLoaderLike {
  readonly pending: PendingLoad[] = [];

  load(
    url: string,
    onLoad: (gltf: GLTF) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void,
  ): void {
    this.pending.push({ url, onLoad, onProgress, onError });
  }

  /** Settle the oldest pending load successfully with the given scene root. */
  succeed(scene: THREE.Object3D): void {
    const load = this.takeOldest();
    load.onLoad({ scene } as unknown as GLTF);
  }

  /** Settle the oldest pending load via its error callback. */
  fail(err: unknown): void {
    const load = this.takeOldest();
    load.onError?.(err);
  }

  /** Emit a progress event on the oldest pending load. */
  emitProgress(loaded: number, total: number): void {
    const load = this.takeOldest(false);
    load.onProgress?.({
      lengthComputable: true,
      loaded,
      total,
    } as ProgressEvent);
  }

  private takeOldest(remove = true): PendingLoad {
    const load = remove ? this.pending.shift() : this.pending[0];
    if (!load) {
      throw new Error('No pending load to act on');
    }
    return load;
  }
}

/** Build a valid vehicle scene graph: chassis + four named wheels. */
function buildValidVehicleScene(): THREE.Object3D {
  const root = new THREE.Object3D();
  root.name = 'root';

  const chassis = new THREE.Object3D();
  chassis.name = CHASSIS_NODE;
  root.add(chassis);

  for (const wheelName of REQUIRED_WHEEL_NODES) {
    const wheel = new THREE.Object3D();
    wheel.name = wheelName;
    root.add(wheel);
  }

  return root;
}

/**
 * Build a vehicle scene graph that is missing exactly one required node, so the
 * scene-graph validation should fail naming that node.
 */
function buildSceneMissing(missingNode: string): THREE.Object3D {
  const root = buildValidVehicleScene();
  const node = root.getObjectByName(missingNode);
  if (node) {
    root.remove(node);
  }
  return root;
}

const noop = (_p: LoadProgress): void => {};

describe('GltfAssetLoader edge cases', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('timeout (Req 1.3)', () => {
    it('loadVehicle resolves to a timeout error when the load never settles', async () => {
      vi.useFakeTimers();
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const resultPromise = loader.loadVehicle('vehicle.glb', noop);

      // The underlying load is left pending; advancing past the timeout should
      // make the race resolve to the timeout error.
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('timeout');
        expect(result.error.asset).toBe('vehicle');
        expect(result.error.message).toContain('vehicle');
      }
    });

    it('loadTerrain resolves to a timeout error naming the terrain asset', async () => {
      vi.useFakeTimers();
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const resultPromise = loader.loadTerrain('terrain.glb', noop);
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('timeout');
        expect(result.error.asset).toBe('terrain');
      }
    });

    it('does not time out when the load settles before the deadline', async () => {
      vi.useFakeTimers();
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const resultPromise = loader.loadVehicle('vehicle.glb', noop);

      // Settle just before the timeout fires.
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
      stub.succeed(buildValidVehicleScene());
      const result = await resultPromise;

      expect(result.ok).toBe(true);
    });
  });

  describe('load/network errors (Req 1.5)', () => {
    it('classifies a fetch/HTTP failure as a network error naming the asset', async () => {
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const resultPromise = loader.loadVehicle('vehicle.glb', noop);
      stub.fail(new Error('Failed to load resource: HTTP 404'));
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('network');
        expect(result.error.asset).toBe('vehicle');
        expect(result.error.message).toContain('vehicle');
      }
    });

    it('classifies a malformed-content failure as a parse error', async () => {
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const resultPromise = loader.loadTerrain('terrain.glb', noop);
      stub.fail(new Error('Unexpected token while parsing GLB chunk'));
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('parse');
        expect(result.error.asset).toBe('terrain');
        expect(result.error.message).toContain('terrain');
      }
    });
  });

  describe('missing-mesh detection (Req 1.5)', () => {
    it('fails when the chassis node is missing, naming the chassis', async () => {
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const resultPromise = loader.loadVehicle('vehicle.glb', noop);
      stub.succeed(buildSceneMissing(CHASSIS_NODE));
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('missing-mesh');
        expect(result.error.missingNode).toBe(CHASSIS_NODE);
      }
    });

    it('fails when a wheel node is missing, naming that wheel', async () => {
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const resultPromise = loader.loadVehicle('vehicle.glb', noop);
      stub.succeed(buildSceneMissing('wheel_RL'));
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('missing-mesh');
        expect(result.error.missingNode).toBe('wheel_RL');
      }
    });
  });

  describe('success path', () => {
    it('returns the validated chassis and four wheels for a valid scene', async () => {
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const resultPromise = loader.loadVehicle('vehicle.glb', noop);
      stub.succeed(buildValidVehicleScene());
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.chassis.name).toBe(CHASSIS_NODE);
        expect(result.value.wheels.map((w) => w.name)).toEqual([...REQUIRED_WHEEL_NODES]);
      }
    });

    it('loadTerrain returns the scene root for a valid load', async () => {
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const scene = new THREE.Object3D();
      scene.name = 'terrain-root';

      const resultPromise = loader.loadTerrain('terrain.glb', noop);
      stub.succeed(scene);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('terrain-root');
      }
    });

    it('reports clamped progress percentages from the underlying loader', async () => {
      const stub = new StubGltfLoader();
      const loader = new GltfAssetLoader(stub);

      const progress: LoadProgress[] = [];
      const resultPromise = loader.loadVehicle('vehicle.glb', (p) => progress.push(p));

      stub.emitProgress(25, 100);
      stub.emitProgress(100, 100);
      stub.succeed(buildValidVehicleScene());
      await resultPromise;

      expect(progress).toEqual([
        { asset: 'vehicle', percent: 25 },
        { asset: 'vehicle', percent: 100 },
      ]);
    });
  });
});
