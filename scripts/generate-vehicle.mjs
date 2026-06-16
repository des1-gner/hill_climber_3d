// scripts/generate-vehicle.mjs
//
// Generates the vehicle GLB asset (public/assets/vehicle.glb) — a detailed
// boxy off-road jeep built for hill climbing — without Blender.
//
// The GLB contains exactly the nodes the loader/renderer require:
//   - "chassis"  : a group holding the body and all its detail meshes
//                  (>= 20,000 triangles overall, Req 1.1)
//   - "wheel_FL/FR/RL/RR" : four chunky off-road wheels (>= 5,000 tris each)
//
// Detail features: 7-slot grille, reflective glass (windshield, side + rear
// windows), round headlights, red tail lights, side mirrors on stalks, front +
// rear number plates, wheel arches, and bumpers. Reflections on the glass and
// chrome are produced at runtime by the renderer's environment map; the
// materials here just carry the metalness/roughness/emissive that drive them.
//
// Wheels are modelled centred on their hub with the axle along local X (the
// renderer spins them about X and steers about Y), and the body is centred on
// the chassis origin so it aligns with the physics collider.
//
// Draco note: a Draco encoder is not available in this Node environment, so the
// GLB is exported UNCOMPRESSED. DRACOLoader loads uncompressed GLBs fine. For
// production: npx gltf-pipeline -i public/assets/vehicle.glb -o public/assets/vehicle.glb -d

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHASSIS_NODE = 'chassis';
const REQUIRED_WHEEL_NODES = ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'];
const CHASSIS_MIN_TRIS = 20_000;
const WHEEL_MIN_TRIS = 5_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'public', 'assets', 'vehicle.glb');

// GLTFExporter's binary path uses Blob + FileReader; Node has Blob but not
// FileReader, so provide a minimal shim backed by Blob.arrayBuffer().
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = buf;
          if (typeof this.onloadend === 'function') this.onloadend();
        })
        .catch((err) => {
          if (typeof this.onerror === 'function') this.onerror(err);
        });
    }
  };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

const M = {
  paint: new THREE.MeshStandardMaterial({ color: 0xcc3322, metalness: 0.5, roughness: 0.4 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x20242a, metalness: 0.3, roughness: 0.7 }),
  plastic: new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.1, roughness: 0.85 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 1.0, roughness: 0.22 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0x88bbdd,
    metalness: 0.05,
    roughness: 0.02,
    opacity: 0.2,
    transparent: true,
    envMapIntensity: 1.8,
  }),
  headlight: new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xfff1c0,
    emissiveIntensity: 1.3,
    roughness: 0.3,
  }),
  taillight: new THREE.MeshStandardMaterial({
    color: 0x330000,
    emissive: 0xff2200,
    emissiveIntensity: 1.2,
    roughness: 0.4,
  }),
  plate: new THREE.MeshStandardMaterial({ color: 0xf5d21a, metalness: 0.1, roughness: 0.5 }),
  plateText: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x16181c, metalness: 0.0, roughness: 0.95 }),
  rim: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.9, roughness: 0.3 }),
  // Interior materials
  dashboard: new THREE.MeshStandardMaterial({ color: 0x1a1a1f, metalness: 0.05, roughness: 0.8 }),
  seat: new THREE.MeshStandardMaterial({ color: 0x2a2a2f, metalness: 0.0, roughness: 0.9 }),
  steeringWheel: new THREE.MeshStandardMaterial({ color: 0x1c1c20, metalness: 0.2, roughness: 0.6 }),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function triangleCount(geometry) {
  if (geometry.index) return geometry.index.count / 3;
  return geometry.attributes.position.count / 3;
}

/** Add a mesh built from `geometry` + `material` to `parent` at a pose. */
function addPart(parent, geometry, material, pos = [0, 0, 0], rot = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Chassis (body + all detail)
// ---------------------------------------------------------------------------

function buildChassis() {
  const chassis = new THREE.Group();
  chassis.name = CHASSIS_NODE;

  // Main hull — rounded by using very high segments so env map smooths it.
  addPart(chassis, new THREE.BoxGeometry(2.0, 0.85, 4.2, 48, 24, 72), M.paint, [0, 0.1, 0]);
  // Lower rocker / skirt (rounded edges).
  addPart(chassis, new THREE.BoxGeometry(2.06, 0.3, 4.0, 20, 8, 48), M.trim, [0, -0.4, 0]);
  // Cabin / greenhouse — using a capsule-like shape (rounded box via high segments).
  addPart(chassis, new THREE.BoxGeometry(1.78, 0.72, 2.1, 36, 18, 38), M.paint, [0, 0.92, -0.25]);
  // Rounded roof cap.
  addPart(chassis, new THREE.SphereGeometry(1.0, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.trim, [0, 1.28, -0.25]);
  // Hood (slightly rounded).
  addPart(chassis, new THREE.BoxGeometry(1.88, 0.14, 1.5, 32, 8, 28), M.paint, [0, 0.56, 1.35]);

  // --- 7-slot jeep grille ---
  addPart(chassis, new THREE.BoxGeometry(1.6, 0.62, 0.12, 8, 8, 2), M.plastic, [0, 0.28, 2.12]);
  for (let i = 0; i < 7; i += 1) {
    const x = -0.66 + i * 0.22;
    addPart(chassis, new THREE.BoxGeometry(0.12, 0.5, 0.16, 3, 8, 3), M.chrome, [x, 0.28, 2.15]);
  }

  // --- Bumpers ---
  addPart(chassis, new THREE.BoxGeometry(2.1, 0.3, 0.34, 20, 6, 6), M.plastic, [0, -0.12, 2.16]);
  addPart(chassis, new THREE.BoxGeometry(2.1, 0.3, 0.34, 20, 6, 6), M.plastic, [0, -0.12, -2.16]);

  // --- Lights ---
  // Round headlights.
  const headGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.12, 24, 2);
  addPart(chassis, headGeo, M.headlight, [-0.62, 0.34, 2.18], [Math.PI / 2, 0, 0]);
  addPart(chassis, headGeo, M.headlight, [0.62, 0.34, 2.18], [Math.PI / 2, 0, 0]);
  // Rectangular tail lights.
  const tailGeo = new THREE.BoxGeometry(0.26, 0.36, 0.1, 4, 6, 2);
  addPart(chassis, tailGeo, M.taillight, [-0.74, 0.36, -2.16]);
  addPart(chassis, tailGeo, M.taillight, [0.74, 0.36, -2.16]);

  // --- Side mirrors (stalk + reflective face) — named for detachment on impact ---
  for (const [sx, side] of [[-1.04, 'left'], [1.04, 'right']]) {
    const mirrorGroup = new THREE.Group();
    mirrorGroup.name = `mirror_${side}`;
    mirrorGroup.position.set(sx, 0.72, 1.06);
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.05, 4, 2, 2), M.trim);
    mirrorGroup.add(stalk);
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.24, 2, 4, 4), M.chrome);
    face.position.set(0.12 * Math.sign(sx), 0.02, 0);
    mirrorGroup.add(face);
    chassis.add(mirrorGroup);
  }

  // --- Glass (reflective) ---
  // Windshield (leaning forward).
  addPart(chassis, new THREE.BoxGeometry(1.62, 0.72, 0.06, 8, 8, 2), M.glass, [0, 0.92, 0.82], [-0.32, 0, 0]);
  // Rear window.
  addPart(chassis, new THREE.BoxGeometry(1.6, 0.6, 0.06, 8, 6, 2), M.glass, [0, 0.95, -1.32], [0.28, 0, 0]);
  // Side windows.
  addPart(chassis, new THREE.BoxGeometry(0.06, 0.52, 1.7, 2, 6, 18), M.glass, [-0.9, 0.98, -0.25]);
  addPart(chassis, new THREE.BoxGeometry(0.06, 0.52, 1.7, 2, 6, 18), M.glass, [0.9, 0.98, -0.25]);

  // --- Wheel arches (half-circle arcs over each wheel) ---
  // Smaller radius + lower position so they sit flush with the body panels.
  const archGeo = new THREE.TorusGeometry(0.54, 0.08, 8, 16, Math.PI);
  for (const [ax, az] of [[-0.95, 1.5], [0.95, 1.5], [-0.95, -1.5], [0.95, -1.5]]) {
    addPart(chassis, archGeo, M.plastic, [ax, -0.32, az], [0, Math.PI / 2, 0]);
  }

  // --- Number plates (front + rear) with a row of "characters" ---
  addNumberPlate(chassis, [0, -0.12, 2.2], 0);
  addNumberPlate(chassis, [0, -0.12, -2.2], Math.PI);

  // --- Interior (visible through transparent glass) ---
  buildInterior(chassis);

  return chassis;
}

/** Build the interior: dashboard, steering wheel, two front seats. */
function buildInterior(chassis) {
  // Dashboard: spans the cabin width, just behind the windshield.
  addPart(chassis, new THREE.BoxGeometry(1.6, 0.35, 0.6, 8, 4, 4), M.dashboard, [0, 0.6, 0.55]);

  // Instrument cluster (raised panel on dashboard).
  addPart(chassis, new THREE.BoxGeometry(0.5, 0.18, 0.12, 4, 2, 2), M.trim, [0, 0.82, 0.58]);

  // Steering wheel (torus + column).
  const wheelColumn = new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8);
  addPart(chassis, wheelColumn, M.steeringWheel, [-0.38, 0.72, 0.45], [-0.5, 0, 0]);
  const steeringRing = new THREE.TorusGeometry(0.2, 0.03, 10, 20);
  addPart(chassis, steeringRing, M.steeringWheel, [-0.38, 0.88, 0.32], [0.4, 0, 0]);

  // Front seats (two bucket-shaped boxes).
  for (const sx of [-0.42, 0.42]) {
    // Seat base.
    addPart(chassis, new THREE.BoxGeometry(0.52, 0.18, 0.55, 4, 2, 4), M.seat, [sx, 0.35, -0.1]);
    // Seat back.
    addPart(chassis, new THREE.BoxGeometry(0.5, 0.6, 0.14, 4, 6, 2), M.seat, [sx, 0.7, -0.35]);
  }

  // Centre console between seats.
  addPart(chassis, new THREE.BoxGeometry(0.22, 0.28, 0.8, 3, 3, 4), M.dashboard, [0, 0.42, -0.15]);

  // Floor.
  addPart(chassis, new THREE.BoxGeometry(1.5, 0.06, 1.8, 4, 1, 4), M.dashboard, [0, 0.15, -0.1]);
}

/** Add a number plate (yellow panel + dark frame + 6 character blocks). */
function addNumberPlate(parent, pos, yaw) {
  const plate = new THREE.Group();
  plate.position.set(pos[0], pos[1], pos[2]);
  plate.rotation.y = yaw;
  // Panel faces +Z in local space (front of the plate).
  addPart(plate, new THREE.BoxGeometry(0.62, 0.2, 0.04, 6, 3, 1), M.plate, [0, 0, 0.02]);
  for (let i = 0; i < 6; i += 1) {
    const x = -0.24 + i * 0.096;
    addPart(plate, new THREE.BoxGeometry(0.05, 0.11, 0.02, 1, 2, 1), M.plateText, [x, 0, 0.05]);
  }
  parent.add(plate);
}

// ---------------------------------------------------------------------------
// Wheels (chunky off-road, axle along local X, centred on the hub)
// ---------------------------------------------------------------------------

function buildWheel(name, x, z) {
  const wheel = new THREE.Group();
  wheel.name = name;
  wheel.position.set(x, -0.5, z);

  // Tire: high-segment cylinder rotated so its axis lies along X.
  const tire = new THREE.CylinderGeometry(0.5, 0.5, 0.42, 100, 26);
  tire.rotateZ(Math.PI / 2);
  addPart(wheel, tire, M.tire);

  // Rim disc.
  const rim = new THREE.CylinderGeometry(0.3, 0.3, 0.44, 36, 2);
  rim.rotateZ(Math.PI / 2);
  addPart(wheel, rim, M.rim);

  // Hub + a few spokes for detail.
  const hub = new THREE.CylinderGeometry(0.12, 0.12, 0.46, 16, 2);
  hub.rotateZ(Math.PI / 2);
  addPart(wheel, hub, M.chrome);
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    const spoke = new THREE.BoxGeometry(0.1, 0.5, 0.05, 2, 4, 1);
    spoke.rotateX(a);
    addPart(wheel, spoke, M.rim);
  }

  return wheel;
}

// ---------------------------------------------------------------------------
// Assemble, report, export
// ---------------------------------------------------------------------------

function buildVehicle() {
  const vehicle = new THREE.Group();
  vehicle.name = 'vehicle';

  const chassis = buildChassis();
  vehicle.add(chassis);

  const wheels = {
    wheel_FL: buildWheel('wheel_FL', -0.95, 1.5),
    wheel_FR: buildWheel('wheel_FR', 0.95, 1.5),
    wheel_RL: buildWheel('wheel_RL', -0.95, -1.5),
    wheel_RR: buildWheel('wheel_RR', 0.95, -1.5),
  };
  for (const w of Object.values(wheels)) vehicle.add(w);

  return { vehicle, chassis, wheels };
}

function nodeTriangleCount(node) {
  let total = 0;
  node.traverse((obj) => {
    if (obj.isMesh) total += triangleCount(obj.geometry);
  });
  return total;
}

function reportTriangleCounts(chassis, wheels) {
  console.log('\nPer-node triangle counts:');
  let ok = true;

  const chassisTris = nodeTriangleCount(chassis);
  const chassisOk = chassisTris >= CHASSIS_MIN_TRIS;
  ok &&= chassisOk;
  console.log(`  ${CHASSIS_NODE.padEnd(10)} ${String(chassisTris).padStart(7)} tris  (min ${CHASSIS_MIN_TRIS})  ${chassisOk ? 'OK' : 'FAIL'}`);

  for (const name of REQUIRED_WHEEL_NODES) {
    const tris = nodeTriangleCount(wheels[name]);
    const nodeOk = tris >= WHEEL_MIN_TRIS;
    ok &&= nodeOk;
    console.log(`  ${name.padEnd(10)} ${String(tris).padStart(7)} tris  (min ${WHEEL_MIN_TRIS})  ${nodeOk ? 'OK' : 'FAIL'}`);
  }
  return ok;
}

function exportGlb(group) {
  const exporter = new GLTFExporter();
  return new Promise((res, rej) => {
    exporter.parse(group, (result) => res(result), (err) => rej(err), { binary: true });
  });
}

async function main() {
  const { vehicle, chassis, wheels } = buildVehicle();

  if (!reportTriangleCounts(chassis, wheels)) {
    console.error('\nTriangle budgets not met — aborting export.');
    process.exit(1);
  }

  const arrayBuffer = await exportGlb(vehicle);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, Buffer.from(arrayBuffer));

  console.log(`\nWrote ${OUTPUT_PATH} (${Buffer.from(arrayBuffer).length} bytes, uncompressed GLB).`);
  console.log('Note: Draco compression not applied (no encoder in this environment).');
}

main().catch((err) => {
  console.error('Failed to generate vehicle GLB:', err);
  process.exit(1);
});
