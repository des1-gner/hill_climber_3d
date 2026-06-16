// Asset loader: the bootstrap-layer I/O wrapper that loads Draco-compressed
// GLB assets via Three.js `GLTFLoader` + `DRACOLoader`.
//
// Responsibilities (Req 1.1–1.5, 4.2):
// - Load the vehicle and terrain GLBs.
// - Surface percentage progress (0..100) from `GLTFLoader`'s onProgress. (Req 1.4)
// - Enforce a 30 s timeout per load via `Promise.race`. (Req 1.3)
// - On success, validate the vehicle scene graph with `validateVehicleGraph`. (Req 1.2, 1.5)
// - Convert network/parse failures and timeouts into typed `LoadResult` errors so
//   callers can block gameplay entry and retain prior state. (Req 1.5, 4.2)
//
// All real network/parse I/O lives here so the rest of the system can stay pure
// and testable. The pure scene-graph validation is delegated to
// `validateVehicleGraph` (src/logic/validate-vehicle.ts).
//
// Testability / dependency injection
// ----------------------------------
// `GltfAssetLoader` accepts an optional `GltfLoaderLike` in its constructor. In
// production it is omitted and a real `GLTFLoader` + `DRACOLoader` pair is built
// (unchanged default behavior). Tests inject a stub loader to drive the success,
// network/parse-error, timeout, and missing-mesh paths without real I/O.
//
// DRACO decoder path choice
// -------------------------
// Three's `DRACOLoader` needs a separate WebAssembly/JS decoder module to
// decompress Draco geometry. We point it at the Google-hosted decoder CDN
// (`https://www.gstatic.com/draco/v1/decoders/`). This is the path documented
// in the three.js examples and avoids an extra Vite build/copy step to serve the
// decoder out of `node_modules/three/examples/jsm/libs/draco/`. If the project
// later needs to run fully offline, swap `DRACO_DECODER_PATH` to a locally
// served copy of that `libs/draco/` directory (e.g. copied into `public/draco/`).

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

import { LOAD_TIMEOUT_MS } from '../constants';
import { validateVehicleGraph } from '../logic/validate-vehicle';
import type { LoadProgress, LoadResult, VehicleMeshes } from '../types';

/**
 * Location of the Draco decoder modules. Uses the Google-hosted CDN so the
 * decoder does not need to be copied into the app's served assets. See the
 * file header for the rationale and the offline alternative.
 */
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/v1/decoders/';

/** Stable asset names used in progress reports and error details. */
const VEHICLE_ASSET = 'vehicle';
const TERRAIN_ASSET = 'terrain';

/**
 * The bootstrap asset loader interface (mirrors design.md). Loads and validates
 * the vehicle and terrain GLBs, reporting progress and surfacing typed errors.
 */
export interface AssetLoader {
  loadVehicle(
    url: string,
    onProgress: (p: LoadProgress) => void,
  ): Promise<LoadResult<VehicleMeshes>>;
  loadTerrain(
    url: string,
    onProgress: (p: LoadProgress) => void,
  ): Promise<LoadResult<THREE.Object3D>>;
}

/**
 * The minimal subset of `GLTFLoader` that {@link GltfAssetLoader} depends on.
 *
 * Declaring this structural interface lets callers (and tests) inject a stub
 * loader so the timeout, network/parse-error, and validation paths can be
 * exercised without real network or file I/O. The real `GLTFLoader` satisfies
 * this interface, so the default behavior is unchanged. The signature mirrors
 * `GLTFLoader.load`: `onProgress`/`onError` are optional on the real loader.
 */
export interface GltfLoaderLike {
  load(
    url: string,
    onLoad: (gltf: GLTF) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void,
  ): void;
}

/**
 * Concrete {@link AssetLoader} backed by Three.js `GLTFLoader` + `DRACOLoader`.
 *
 * A single `GLTFLoader`/`DRACOLoader` pair is constructed per instance and
 * reused across loads. Call {@link dispose} when the loader is no longer needed
 * to release the Draco decoder worker(s).
 */
export class GltfAssetLoader implements AssetLoader {
  private readonly gltfLoader: GltfLoaderLike;
  private readonly dracoLoader?: DRACOLoader;

  /**
   * @param loader Optional injected loader. When omitted (the default,
   * production path), a real `GLTFLoader` + `DRACOLoader` pair is constructed
   * and reused across loads. Inject a {@link GltfLoaderLike} stub in tests to
   * drive the success, error, and timeout paths without real I/O.
   */
  constructor(loader?: GltfLoaderLike) {
    if (loader) {
      // Injected loader: skip Draco/GLTF construction entirely.
      this.gltfLoader = loader;
      return;
    }

    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath(DRACO_DECODER_PATH);

    const gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(this.dracoLoader);
    this.gltfLoader = gltfLoader;
  }

  /**
   * Load the Draco-compressed vehicle GLB, then validate its scene graph.
   *
   * Reports progress percent (0..100) via `onProgress`, races the load against
   * a {@link LOAD_TIMEOUT_MS} timeout (Req 1.3), and on a successful parse runs
   * `validateVehicleGraph` on the loaded scene, returning its result (Req 1.2,
   * 1.5). Network/parse failures become `{ ok: false, error: { kind:
   * 'network' | 'parse', ... } }`; timeouts become `kind: 'timeout'`.
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
   */
  async loadVehicle(
    url: string,
    onProgress: (p: LoadProgress) => void,
  ): Promise<LoadResult<VehicleMeshes>> {
    const loaded = await this.loadScene(url, VEHICLE_ASSET, onProgress);
    if (!loaded.ok) {
      return loaded;
    }
    // Validate the parsed scene graph: exactly one chassis + four named wheels.
    return validateVehicleGraph(loaded.value);
  }

  /**
   * Load the Draco-compressed terrain GLB and return its scene root on success.
   *
   * Uses the same progress + timeout pattern as {@link loadVehicle}. On failure
   * returns a typed error so run start can be halted and prior state retained
   * (Req 4.2).
   *
   * Requirements: 1.1, 1.3, 1.4, 4.2
   */
  loadTerrain(
    url: string,
    onProgress: (p: LoadProgress) => void,
  ): Promise<LoadResult<THREE.Object3D>> {
    return this.loadScene(url, TERRAIN_ASSET, onProgress);
  }

  /** Release the Draco decoder worker(s). Safe to call once when done. */
  dispose(): void {
    this.dracoLoader?.dispose();
  }

  /**
   * Shared GLB load: kicks off `GLTFLoader.load`, reports progress, and races
   * the result against a {@link LOAD_TIMEOUT_MS} timer. Resolves to the loaded
   * scene root on success or a typed `LoadResult` failure otherwise. Never
   * rejects.
   */
  private loadScene(
    url: string,
    asset: string,
    onProgress: (p: LoadProgress) => void,
  ): Promise<LoadResult<THREE.Object3D>> {
    const loadPromise = new Promise<LoadResult<THREE.Object3D>>((resolve) => {
      this.gltfLoader.load(
        url,
        (gltf: GLTF) => {
          resolve({ ok: true, value: gltf.scene });
        },
        (event: ProgressEvent) => {
          // Report percent only when the total length is known (Req 1.4).
          if (event.lengthComputable && event.total > 0) {
            const percent = clampPercent((event.loaded / event.total) * 100);
            onProgress({ asset, percent });
          }
        },
        (err: unknown) => {
          resolve({
            ok: false,
            error: {
              asset,
              kind: classifyLoadError(err),
              message: `Failed to load asset "${asset}" from ${url}: ${errorMessage(err)}`,
            },
          });
        },
      );
    });

    // Race the load against a timeout so a stalled fetch cannot block bootstrap
    // forever (Req 1.3). The timer is cleared as soon as the load settles.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<LoadResult<THREE.Object3D>>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          error: {
            asset,
            kind: 'timeout',
            message: `Loading asset "${asset}" from ${url} timed out after ${LOAD_TIMEOUT_MS} ms.`,
          },
        });
      }, LOAD_TIMEOUT_MS);
    });

    return Promise.race([loadPromise, timeoutPromise]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }
}

/** Clamp a computed progress percentage into the inclusive [0, 100] range. */
function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, percent));
}

/**
 * Best-effort classification of a `GLTFLoader` failure into `network` vs
 * `parse`. The loader surfaces fetch/HTTP failures (transport) distinctly from
 * malformed-content failures thrown while parsing the GLB. We inspect the error
 * text for transport markers and default to `parse` otherwise.
 */
function classifyLoadError(err: unknown): 'network' | 'parse' {
  const message = errorMessage(err).toLowerCase();
  const looksLikeNetwork =
    message.includes('fetch') ||
    message.includes('http') ||
    message.includes('status') ||
    message.includes('network') ||
    message.includes('failed to load') ||
    message.includes('404') ||
    message.includes('cors');
  return looksLikeNetwork ? 'network' : 'parse';
}

/** Extract a human-readable message from an arbitrary thrown/error value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const { message } = err as { message: unknown };
    if (typeof message === 'string') {
      return message;
    }
  }
  if (typeof err === 'string') {
    return err;
  }
  return 'unknown error';
}
