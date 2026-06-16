// scripts/generate-terrain.mjs
//
// Generates a continuous hilly hill-climb terrain mesh and exports it to
// public/assets/terrain.glb (binary GLB) using three.js + GLTFExporter.
//
// Design notes (see .kiro/specs/3d-car-hill-climb/design.md, Requirement 4.1):
//   - The mesh is a subdivided plane (heightfield) whose vertex elevations
//     come from smooth layered sine/cosine functions, so elevation varies
//     CONTINUOUSLY with no vertical discontinuities.
//   - Amplitude/frequency are tuned so the local surface gradient between any
//     two adjacent samples stays within [0, 45] degrees.
//   - The course is long in the driving (+x) direction (a hill-climb course).
//   - The mesh node is named "terrain".
//
// Draco: gltf-pipeline is not installed in this environment, so we export an
// uncompressed binary GLB. DRACOLoader loads uncompressed GLB fine, so this is
// drop-in usable. For production, run the uncompressed GLB through
// `gltf-pipeline -i terrain.glb -o terrain.glb -d` (or re-export from Blender
// with Draco enabled) to add Draco compression.

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Node polyfills
// ---------------------------------------------------------------------------
// GLTFExporter's binary path uses the browser `FileReader` API to read merged
// `Blob`s back into ArrayBuffers. Node has `Blob` (and Blob.arrayBuffer()) but
// no `FileReader`, so provide a minimal shim that covers readAsArrayBuffer +
// onloadend, which is all GLTFExporter relies on.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.onloadend = null;
      this.onload = null;
      this.onerror = null;
    }
    readAsArrayBuffer(blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = buf;
          if (typeof this.onload === 'function') this.onload({ target: this });
          if (typeof this.onloadend === 'function')
            this.onloadend({ target: this });
        })
        .catch((err) => {
          if (typeof this.onerror === 'function') this.onerror(err);
        });
    }
  };
}

// ---------------------------------------------------------------------------
// Terrain parameters
// ---------------------------------------------------------------------------

// Course dimensions (world units = metres).
const LENGTH_X = 240; // long driving direction
const WIDTH_Z = 80; // narrower cross-course width
const SEGMENTS_X = 256; // subdivisions along x
const SEGMENTS_Z = 96; // subdivisions along z

// Layered sine/cosine elevation field. Each layer has an amplitude, spatial
// frequencies along x/z, and a phase. Long wavelengths carry most of the
// amplitude (gentle rolling hills); short wavelengths add small-scale detail.
// Amplitudes/frequencies are tuned so the worst-case slope stays <= 45 deg.
const LAYERS = [
  { amp: 6.0, fx: 1.0, fz: 0.0, phx: 0.4, phz: 0.0 },
  { amp: 3.0, fx: 2.3, fz: 0.7, phx: 1.7, phz: 0.6 },
  { amp: 1.4, fx: 4.1, fz: 1.6, phx: 2.9, phz: 1.1 },
  { amp: 0.5, fx: 7.7, fz: 3.2, phx: 0.2, phz: 2.4 },
];

// Base angular frequency: 2*pi / dominant wavelength.
// With LENGTH_X = 240 and fx multipliers above, the dominant wavelength along
// x for layer 0 is LENGTH_X / 1.0. We derive per-axis omega from the course
// span so the field scales with the course.
const OMEGA_X = (2 * Math.PI) / LENGTH_X;
const OMEGA_Z = (2 * Math.PI) / WIDTH_Z;

/**
 * Continuous elevation function. Smooth (C-infinity) sum of sines/cosines, so
 * there are never vertical discontinuities between adjacent samples.
 * @param {number} x world x
 * @param {number} z world z
 * @returns {number} elevation y
 */
function elevation(x, z) {
  let y = 0;
  for (const l of LAYERS) {
    y +=
      l.amp *
      Math.sin(OMEGA_X * l.fx * x + l.phx) *
      Math.cos(OMEGA_Z * l.fz * z + l.phz);
  }
  return y;
}

// ---------------------------------------------------------------------------
// Build geometry
// ---------------------------------------------------------------------------

const geometry = new THREE.PlaneGeometry(
  LENGTH_X,
  WIDTH_Z,
  SEGMENTS_X,
  SEGMENTS_Z
);

// PlaneGeometry lies in the XY plane facing +Z. Rotate it so it lies in the
// XZ plane (ground plane) with +Y up.
geometry.rotateX(-Math.PI / 2);

// Displace vertex heights using the elevation field. After rotateX, each
// vertex has (x, 0, z); we set y from elevation(x, z).
const pos = geometry.attributes.position;
for (let i = 0; i < pos.count; i++) {
  const x = pos.getX(i);
  const z = pos.getZ(i);
  pos.setY(i, elevation(x, z));
}
pos.needsUpdate = true;
geometry.computeVertexNormals();

// ---------------------------------------------------------------------------
// Verify gradient constraint across the heightfield
// ---------------------------------------------------------------------------

// Sample the field on the same regular grid the mesh uses and compute the
// maximum local surface gradient between adjacent samples (both x and z
// neighbours). gradient angle = atan(rise / run).
function maxGradientDegrees() {
  const dx = LENGTH_X / SEGMENTS_X;
  const dz = WIDTH_Z / SEGMENTS_Z;
  const halfX = LENGTH_X / 2;
  const halfZ = WIDTH_Z / 2;

  let maxTan = 0;
  for (let ix = 0; ix <= SEGMENTS_X; ix++) {
    const x = -halfX + ix * dx;
    for (let iz = 0; iz <= SEGMENTS_Z; iz++) {
      const z = -halfZ + iz * dz;
      const h = elevation(x, z);

      if (ix < SEGMENTS_X) {
        const hRight = elevation(x + dx, z);
        const tanX = Math.abs(hRight - h) / dx;
        if (tanX > maxTan) maxTan = tanX;
      }
      if (iz < SEGMENTS_Z) {
        const hUp = elevation(x, z + dz);
        const tanZ = Math.abs(hUp - h) / dz;
        if (tanZ > maxTan) maxTan = tanZ;
      }
    }
  }
  return (Math.atan(maxTan) * 180) / Math.PI;
}

const maxGradDeg = maxGradientDegrees();

// ---------------------------------------------------------------------------
// Assemble mesh + scene
// ---------------------------------------------------------------------------

const material = new THREE.MeshStandardMaterial({
  color: 0x6b8e5a,
  roughness: 0.95,
  metalness: 0.0,
});

const terrain = new THREE.Mesh(geometry, material);
terrain.name = 'terrain';

const scene = new THREE.Scene();
scene.add(terrain);

const triangleCount = geometry.index
  ? geometry.index.count / 3
  : pos.count / 3;

// ---------------------------------------------------------------------------
// Export to binary GLB
// ---------------------------------------------------------------------------

function exportGLB(input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      input,
      (result) => {
        // With binary:true the result is an ArrayBuffer.
        resolvePromise(result);
      },
      (error) => rejectPromise(error),
      { binary: true }
    );
  });
}

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const outDir = resolve(__dirname, '..', 'public', 'assets');
  const outPath = resolve(outDir, 'terrain.glb');

  const arrayBuffer = await exportGLB(scene);
  const buffer = Buffer.from(arrayBuffer);

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, buffer);

  console.log('Terrain GLB generated.');
  console.log(`  Output:            ${outPath}`);
  console.log(`  File size:         ${(buffer.length / 1024).toFixed(1)} KiB`);
  console.log(`  Mesh node name:    "${terrain.name}"`);
  console.log(`  Course size (x,z): ${LENGTH_X} x ${WIDTH_Z} units`);
  console.log(`  Grid segments:     ${SEGMENTS_X} x ${SEGMENTS_Z}`);
  console.log(`  Triangle count:    ${triangleCount}`);
  console.log(`  Max gradient:      ${maxGradDeg.toFixed(2)} deg (constraint: <= 45 deg)`);

  if (maxGradDeg > 45) {
    console.error(
      `\nERROR: max gradient ${maxGradDeg.toFixed(2)} deg exceeds 45 deg. ` +
        'Reduce layer amplitudes or frequencies.'
    );
    process.exit(1);
  }

  console.log(
    '\nNote: GLB is exported UNCOMPRESSED (gltf-pipeline not installed). ' +
      'DRACOLoader loads uncompressed GLB fine. For production Draco ' +
      'compression run: gltf-pipeline -i terrain.glb -o terrain.glb -d'
  );
}

main().catch((err) => {
  console.error('Failed to generate terrain GLB:', err);
  process.exit(1);
});
