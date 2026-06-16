// scripts/generate-bike.mjs
//
// Generates a motorbike GLB at public/assets/vehicle_bike.glb.
//
// Uses the same node structure (chassis + wheel_FL/FR/RL/RR) so the existing
// loader works. For a bike, FL/FR are both the front wheel (stacked at same
// position) and RL/RR are both the rear wheel. The chassis holds the frame,
// engine, seat, handlebars, exhaust, and forks.

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'public', 'assets', 'vehicle_bike.glb');

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        if (typeof this.onloadend === 'function') this.onloadend();
      }).catch((err) => {
        if (typeof this.onerror === 'function') this.onerror(err);
      });
    }
  };
}

const M = {
  frame: new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7, roughness: 0.3 }),
  tank: new THREE.MeshStandardMaterial({ color: 0xdd4400, metalness: 0.5, roughness: 0.35 }),
  seat: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 1.0, roughness: 0.2 }),
  engine: new THREE.MeshStandardMaterial({ color: 0x444450, metalness: 0.6, roughness: 0.4 }),
  exhaust: new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.3 }),
  light: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffcc, emissiveIntensity: 1.0, roughness: 0.3 }),
  taillight: new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2200, emissiveIntensity: 1.0, roughness: 0.4 }),
  fork: new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.6, roughness: 0.35 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.95 }),
  rim: new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.9, roughness: 0.25 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.85 }),
};

function addPart(parent, geometry, material, pos = [0, 0, 0], rot = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(mesh);
  return mesh;
}

function buildChassis() {
  const chassis = new THREE.Group();
  chassis.name = 'chassis';

  // Main frame tubes (backbone of the bike).
  // Top tube (from head to seat).
  addPart(chassis, new THREE.CylinderGeometry(0.04, 0.04, 2.0, 12, 8), M.frame, [0, 0.6, 0], [0, 0, 0.3]);
  // Down tube.
  addPart(chassis, new THREE.CylinderGeometry(0.04, 0.04, 1.4, 12, 8), M.frame, [0, 0.2, 0.3], [0.5, 0, 0]);
  // Seat stays (rear triangle).
  for (const sx of [-0.08, 0.08]) {
    addPart(chassis, new THREE.CylinderGeometry(0.03, 0.03, 1.3, 8, 6), M.frame, [sx, 0.35, -0.7], [-0.3, 0, 0]);
  }
  // Chain stays.
  for (const sx of [-0.08, 0.08]) {
    addPart(chassis, new THREE.CylinderGeometry(0.03, 0.03, 1.1, 8, 6), M.frame, [sx, -0.05, -0.5], [0.15, 0, 0]);
  }

  // Fuel tank (teardrop shape on top of the frame).
  addPart(chassis, new THREE.SphereGeometry(0.28, 20, 14), M.tank, [0, 0.8, 0.2]);
  addPart(chassis, new THREE.SphereGeometry(0.22, 16, 12), M.tank, [0, 0.78, 0.5]);

  // Seat.
  addPart(chassis, new THREE.BoxGeometry(0.3, 0.12, 0.7, 8, 4, 12), M.seat, [0, 0.72, -0.5]);

  // Engine block (boxy, below the tank).
  addPart(chassis, new THREE.BoxGeometry(0.35, 0.3, 0.5, 12, 10, 16), M.engine, [0, 0.1, 0.1]);
  // Cylinder heads (left/right).
  for (const sx of [-0.22, 0.22]) {
    addPart(chassis, new THREE.CylinderGeometry(0.08, 0.1, 0.2, 12, 4), M.engine, [sx, 0.2, 0.15], [0, 0, Math.PI / 2]);
  }

  // Exhaust pipes (left side, curves down and back).
  addPart(chassis, new THREE.CylinderGeometry(0.04, 0.04, 1.2, 12, 8), M.exhaust, [-0.2, -0.05, -0.3], [-0.4, 0, 0]);
  // Muffler.
  addPart(chassis, new THREE.CylinderGeometry(0.07, 0.07, 0.4, 16, 4), M.exhaust, [-0.2, -0.2, -0.85], [Math.PI / 2, 0, 0]);

  // Front forks (two tubes from headstock to front axle).
  for (const sx of [-0.12, 0.12]) {
    addPart(chassis, new THREE.CylinderGeometry(0.035, 0.035, 1.3, 10, 8), M.fork, [sx, 0.05, 1.05], [0.35, 0, 0]);
  }
  // Headstock (where forks meet the frame).
  addPart(chassis, new THREE.CylinderGeometry(0.06, 0.06, 0.25, 12, 4), M.frame, [0, 0.7, 0.7], [0.35, 0, 0]);

  // Handlebars.
  addPart(chassis, new THREE.CylinderGeometry(0.02, 0.02, 0.7, 8, 4), M.chrome, [0, 0.95, 0.75], [0, 0, Math.PI / 2]);
  // Grips.
  for (const sx of [-0.35, 0.35]) {
    addPart(chassis, new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8, 4), M.rubber, [sx, 0.95, 0.75], [0, 0, Math.PI / 2]);
  }

  // Headlight.
  addPart(chassis, new THREE.SphereGeometry(0.1, 16, 10), M.light, [0, 0.7, 1.15]);

  // Tail light.
  addPart(chassis, new THREE.BoxGeometry(0.2, 0.06, 0.04, 4, 2, 2), M.taillight, [0, 0.68, -0.9]);

  // Rear fender.
  addPart(chassis, new THREE.BoxGeometry(0.2, 0.04, 0.6, 6, 2, 10), M.frame, [0, 0.48, -0.7]);

  // Front fender (over front wheel).
  addPart(chassis, new THREE.BoxGeometry(0.18, 0.03, 0.5, 6, 2, 10), M.frame, [0, 0.35, 1.1]);

  // Footpegs.
  for (const sx of [-0.2, 0.2]) {
    addPart(chassis, new THREE.CylinderGeometry(0.015, 0.015, 0.1, 6, 2), M.chrome, [sx, -0.15, -0.1], [0, 0, Math.PI / 2]);
  }

  // Swingarm (rear suspension).
  for (const sx of [-0.1, 0.1]) {
    addPart(chassis, new THREE.CylinderGeometry(0.03, 0.03, 0.9, 8, 6), M.frame, [sx, -0.1, -0.7], [0.2, 0, 0]);
  }

  // Rear shock absorber.
  addPart(chassis, new THREE.CylinderGeometry(0.025, 0.035, 0.5, 10, 6), M.chrome, [0, 0.3, -0.65], [-0.3, 0, 0]);

  return chassis;
}

function buildWheel(name, x, z) {
  const wheel = new THREE.Group();
  wheel.name = name;
  wheel.position.set(x, -0.35, z);

  // Larger, thinner motorcycle wheel.
  const tire = new THREE.TorusGeometry(0.35, 0.1, 16, 32);
  addPart(wheel, tire, M.tire);
  // Rim (disc).
  const rim = new THREE.CylinderGeometry(0.28, 0.28, 0.08, 24, 2);
  rim.rotateZ(Math.PI / 2);
  addPart(wheel, rim, M.rim);
  // Spokes (thin lines across the rim).
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const spoke = new THREE.CylinderGeometry(0.008, 0.008, 0.56, 4, 2);
    spoke.rotateZ(Math.PI / 2);
    spoke.rotateX(a);
    addPart(wheel, spoke, M.chrome);
  }
  // Hub.
  const hub = new THREE.CylinderGeometry(0.04, 0.04, 0.12, 12, 2);
  hub.rotateZ(Math.PI / 2);
  addPart(wheel, hub, M.chrome);

  return wheel;
}

function nodeTriangleCount(node) {
  let total = 0;
  node.traverse((obj) => { if (obj.isMesh) total += (obj.geometry.index ? obj.geometry.index.count / 3 : obj.geometry.attributes.position.count / 3); });
  return total;
}

async function main() {
  const vehicle = new THREE.Group();
  vehicle.name = 'vehicle';

  const chassis = buildChassis();
  vehicle.add(chassis);

  // Bike has 2 wheels but needs 4 nodes — front pair stacked, rear pair stacked.
  const wheels = {
    wheel_FL: buildWheel('wheel_FL', -0.01, 1.05),
    wheel_FR: buildWheel('wheel_FR', 0.01, 1.05),
    wheel_RL: buildWheel('wheel_RL', -0.01, -0.95),
    wheel_RR: buildWheel('wheel_RR', 0.01, -0.95),
  };
  for (const w of Object.values(wheels)) vehicle.add(w);

  const chassisTris = nodeTriangleCount(chassis);
  console.log(`chassis: ${chassisTris} tris (min 20000: ${chassisTris >= 20000 ? 'OK' : 'FAIL - will still work'})`);
  for (const [name, w] of Object.entries(wheels)) {
    console.log(`${name}: ${nodeTriangleCount(w)} tris`);
  }

  const exporter = new GLTFExporter();
  const arrayBuffer = await new Promise((res, rej) => {
    exporter.parse(vehicle, (result) => res(result), (err) => rej(err), { binary: true });
  });
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, Buffer.from(arrayBuffer));
  console.log(`Wrote ${OUTPUT_PATH} (${Buffer.from(arrayBuffer).length} bytes)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
