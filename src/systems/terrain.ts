// Terrain — an INFINITE, biome-based procedural world.
//
// The world is no longer a single finite mesh. Instead `terrainElevation(x, z)`
// is an unbounded, smooth, gradient-limited height field defined for all (x, z),
// and `biomeAt(x, z)` partitions the plane into large biome regions (grassland,
// forest, rocky, snow). The ChunkManager (chunk-manager.ts) streams square
// terrain chunks — mesh + collider + decorations + collidable stones — around
// the player, so the map generates endlessly as you drive.
//
// This module owns the pure field maths (elevation, slope, biome, friction) and
// the per-chunk geometry build. It is framework-light: only the chunk-geometry
// and the finite test patch touch THREE.

import * as THREE from 'three';

import type { AssetLoader } from './asset-loader';
import type { LoadProgress, LoadResult, TerrainModel } from '../types';

// ---------------------------------------------------------------------------
// Friction bounds (Req 6.5)
// ---------------------------------------------------------------------------

export const MIN_REGION_FRICTION = 0.05;
export const MAX_REGION_FRICTION = 1.5;
export const DEFAULT_REGION = 'default';
export const DEFAULT_REGION_FRICTION = 1.0;

// ---------------------------------------------------------------------------
// Chunk sizing
// ---------------------------------------------------------------------------

/** Side length of a terrain chunk, in world units (metres). */
export const CHUNK_SIZE = 96;

/** Mesh/collider subdivisions per chunk edge (so facets are CHUNK_SIZE/SEG m). */
export const CHUNK_SEGMENTS = 32;

// ---------------------------------------------------------------------------
// Elevation field (infinite, smooth, gradient-bounded)
// ---------------------------------------------------------------------------

interface Octave {
  a: number;
  fx: number;
  fz: number;
  px: number;
  pz: number;
}

// World seed: randomised each session so the terrain is different every time.
const WORLD_SEED = Math.random() * 1000;

// Layered sine/cosine hills. Sum of amplitudes ~15 m; the per-axis derivative
// (sum of a*f) is ~0.45, keeping local slopes well under 45 degrees.
const HILLS: ReadonlyArray<Octave> = [
  { a: 9.0, fx: 0.012, fz: 0.011, px: WORLD_SEED, pz: WORLD_SEED * 0.7 },
  { a: 4.0, fx: 0.03, fz: 0.028, px: WORLD_SEED + 1.3, pz: WORLD_SEED + 2.1 },
  { a: 1.7, fx: 0.07, fz: 0.065, px: WORLD_SEED + 2.7, pz: WORLD_SEED + 0.5 },
  { a: 0.7, fx: 0.15, fz: 0.14, px: WORLD_SEED + 0.9, pz: WORLD_SEED + 1.7 },
];

function smoothstep01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Low-frequency biome field in roughly [-1.5, 1.5]. */
function biomeRaw(x: number, z: number): number {
  return (
    Math.sin(x * 0.0042 + WORLD_SEED * 0.3) * Math.cos(z * 0.0039 + WORLD_SEED * 0.5) +
    0.5 * Math.sin(x * 0.0091 + WORLD_SEED * 0.8) * Math.cos(z * 0.008 + WORLD_SEED * 0.2)
  );
}

/** Normalised biome parameter in [0, 1]. */
function biomeParam(x: number, z: number): number {
  return Math.min(1, Math.max(0, (biomeRaw(x, z) / 1.5 + 1) / 2));
}

/** Smooth terrain amplitude multiplier (gentle grassland -> rugged snow). */
function amplitudeAt(x: number, z: number): number {
  return 0.55 + 0.75 * smoothstep01(biomeParam(x, z));
}

/**
 * Infinite, continuous (C-infinity) elevation field. Defined for all (x, z),
 * with local gradients kept under ~30 degrees so the world stays drivable.
 */
export function terrainElevation(x: number, z: number): number {
  let h = 0;
  for (const o of HILLS) {
    h += o.a * Math.sin(o.fx * x + o.px) * Math.cos(o.fz * z + o.pz);
  }
  return h * amplitudeAt(x, z);
}

/** Approximate surface slope (degrees from horizontal) at (x, z). */
export function terrainSlopeDegrees(x: number, z: number): number {
  const e = 0.5;
  const dEdx = (terrainElevation(x + e, z) - terrainElevation(x - e, z)) / (2 * e);
  const dEdz = (terrainElevation(x, z + e) - terrainElevation(x, z - e)) / (2 * e);
  return (Math.atan(Math.hypot(dEdx, dEdz)) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Biomes
// ---------------------------------------------------------------------------

/** The world's biome categories. */
export type Biome = 'grassland' | 'forest' | 'rocky' | 'snow' | 'desert';

/** Classify the biome at (x, z) from the low-frequency biome field. */
export function biomeAt(x: number, z: number): Biome {
  const t = biomeParam(x, z);
  if (t < 0.22) return 'grassland';
  if (t < 0.42) return 'forest';
  if (t < 0.58) return 'desert';
  if (t < 0.78) return 'rocky';
  return 'snow';
}

/** Driving friction per biome (within [0.05, 1.50], Req 6.5). */
export const BIOME_FRICTION: Record<Biome, number> = {
  grassland: 0.75,
  forest: 0.85,
  desert: 0.6,
  rocky: 1.35,
  snow: 0.25,
};

/** Surface driving friction at (x, z), from its biome. */
export function surfaceFrictionAt(x: number, z: number): number {
  return BIOME_FRICTION[biomeAt(x, z)];
}

// Base biome ground colours (further shaded by slope/snow per vertex).
const BIOME_COLOR: Record<Biome, THREE.Color> = {
  grassland: new THREE.Color(0x4f8a3a),
  forest: new THREE.Color(0x3c6b34),
  desert: new THREE.Color(0xc2a060),
  rocky: new THREE.Color(0x6f7176),
  snow: new THREE.Color(0xeef2f8),
};

const C_ROCK = new THREE.Color(0x595b60);
const _cScratch = new THREE.Color();

const _cBlend = new THREE.Color();

/** Resolve a vertex colour with wide smooth biome transition blending. */
function vertexColor(x: number, z: number, slopeDeg: number, jitter: number, target: THREE.Color): void {
  const t = biomeParam(x, z);

  // Biome boundaries (matching biomeAt): 0.22, 0.42, 0.58, 0.78
  // Blend 10% of the range on each side of a boundary.
  const B = 0.05; // half-width of blend zone

  if (t < 0.22 - B) {
    target.copy(BIOME_COLOR.grassland);
  } else if (t < 0.22 + B) {
    const blend = (t - (0.22 - B)) / (2 * B);
    target.copy(BIOME_COLOR.grassland).lerp(_cBlend.copy(BIOME_COLOR.forest), blend);
  } else if (t < 0.42 - B) {
    target.copy(BIOME_COLOR.forest);
  } else if (t < 0.42 + B) {
    const blend = (t - (0.42 - B)) / (2 * B);
    target.copy(BIOME_COLOR.forest).lerp(_cBlend.copy(BIOME_COLOR.desert), blend);
  } else if (t < 0.58 - B) {
    target.copy(BIOME_COLOR.desert);
  } else if (t < 0.58 + B) {
    const blend = (t - (0.58 - B)) / (2 * B);
    target.copy(BIOME_COLOR.desert).lerp(_cBlend.copy(BIOME_COLOR.rocky), blend);
  } else if (t < 0.78 - B) {
    target.copy(BIOME_COLOR.rocky);
  } else if (t < 0.78 + B) {
    const blend = (t - (0.78 - B)) / (2 * B);
    target.copy(BIOME_COLOR.rocky).lerp(_cBlend.copy(BIOME_COLOR.snow), blend);
  } else {
    target.copy(BIOME_COLOR.snow);
  }

  // Steep faces show bare rock.
  const b = biomeAt(x, z);
  if (slopeDeg > 30 && b !== 'snow') {
    target.lerp(C_ROCK, Math.min(1, (slopeDeg - 30) / 15));
  }
  const shade = 0.9 + jitter * 0.2;
  target.multiplyScalar(shade);
}

function hashJitter(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// Gradient analysis (property-testable)
// ---------------------------------------------------------------------------

export type ElevationSampler = (x: number, z: number) => number;

export interface TerrainBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface TerrainSegments {
  x: number;
  z: number;
}

/** Maximum local surface gradient (degrees) of a field over a sampled grid. */
export function maxLocalGradientDegrees(
  sampler: ElevationSampler,
  bounds: TerrainBounds,
  segments: TerrainSegments,
): number {
  const segX = Math.max(1, Math.floor(segments.x));
  const segZ = Math.max(1, Math.floor(segments.z));
  const dx = (bounds.maxX - bounds.minX) / segX;
  const dz = (bounds.maxZ - bounds.minZ) / segZ;

  let maxTan = 0;
  for (let ix = 0; ix <= segX; ix++) {
    const x = bounds.minX + ix * dx;
    for (let iz = 0; iz <= segZ; iz++) {
      const z = bounds.minZ + iz * dz;
      const h = sampler(x, z);
      if (ix < segX && dx > 0) {
        const t = Math.abs(sampler(x + dx, z) - h) / dx;
        if (t > maxTan) maxTan = t;
      }
      if (iz < segZ && dz > 0) {
        const t = Math.abs(sampler(x, z + dz) - h) / dz;
        if (t > maxTan) maxTan = t;
      }
    }
  }
  return (Math.atan(maxTan) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Chunk geometry
// ---------------------------------------------------------------------------

/** Build result for one terrain chunk. */
export interface ChunkGeometry {
  /** Local-space mesh geometry (centre at origin); position the mesh at the chunk centre. */
  geometry: THREE.BufferGeometry;
  /** World-space vertices for the physics trimesh collider. */
  colliderVertices: Float32Array;
  /** Triangle indices for the collider. */
  colliderIndices: Uint32Array;
  /** World-space centre of the chunk. */
  centerX: number;
  centerZ: number;
}

/**
 * Build the mesh + collider geometry for chunk (cx, cz). Chunk edges sample the
 * exact shared world coordinates, so neighbouring chunks tile seamlessly.
 */
export function buildChunkGeometry(cx: number, cz: number): ChunkGeometry {
  const seg = CHUNK_SEGMENTS;
  const centerX = cx * CHUNK_SIZE;
  const centerZ = cz * CHUNK_SIZE;

  const geometry = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, seg, seg);
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  const colliderVertices = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const lx = pos.getX(i);
    const lz = pos.getZ(i);
    const wx = centerX + lx;
    const wz = centerZ + lz;
    const y = terrainElevation(wx, wz);
    pos.setY(i, y);

    colliderVertices[i * 3] = wx;
    colliderVertices[i * 3 + 1] = y;
    colliderVertices[i * 3 + 2] = wz;

    const slope = terrainSlopeDegrees(wx, wz);
    vertexColor(wx, wz, slope, hashJitter(wx, wz), _cScratch);
    colors[i * 3] = _cScratch.r;
    colors[i * 3 + 1] = _cScratch.g;
    colors[i * 3 + 2] = _cScratch.b;
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const index = geometry.getIndex();
  const colliderIndices = index
    ? new Uint32Array(index.array as ArrayLike<number>)
    : new Uint32Array(0);

  return { geometry, colliderVertices, colliderIndices, centerX, centerZ };
}

// ---------------------------------------------------------------------------
// Finite test patch (used by integration tests) + authored-GLB loading
// ---------------------------------------------------------------------------

export interface ProceduralTerrainOptions {
  size?: number;
  segments?: number;
  regionFriction?: number;
}

/**
 * Build a single finite terrain patch centred on the origin sampling the
 * infinite field. Used by integration tests that want one collider mesh; the
 * live game uses the ChunkManager instead.
 */
export function generateProceduralTerrain(options: ProceduralTerrainOptions = {}): TerrainModel {
  const size = options.size ?? 300;
  const segments = options.segments ?? 200;
  const friction = clampRegionFriction(options.regionFriction ?? DEFAULT_REGION_FRICTION);

  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrainElevation(x, z);
    pos.setY(i, y);
    vertexColor(x, z, terrainSlopeDegrees(x, z), hashJitter(x, z), _cScratch);
    colors[i * 3] = _cScratch.r;
    colors[i * 3 + 1] = _cScratch.g;
    colors[i * 3 + 2] = _cScratch.b;
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
  );
  mesh.name = 'terrain';

  return {
    visual: mesh,
    colliderKind: 'trimesh',
    frictionByRegion: new Map<string, number>([[DEFAULT_REGION, friction]]),
  };
}

/** Load an authored terrain GLB (forwarded errors per Req 4.2). */
export async function loadTerrain(
  assetLoader: AssetLoader,
  url: string,
  onProgress: (p: LoadProgress) => void,
): Promise<LoadResult<TerrainModel>> {
  const loaded = await assetLoader.loadTerrain(url, onProgress);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    value: {
      visual: loaded.value,
      colliderKind: 'trimesh',
      frictionByRegion: new Map<string, number>([[DEFAULT_REGION, DEFAULT_REGION_FRICTION]]),
    },
  };
}

function clampRegionFriction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REGION_FRICTION;
  return Math.max(MIN_REGION_FRICTION, Math.min(MAX_REGION_FRICTION, value));
}
