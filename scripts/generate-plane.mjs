// scripts/generate-plane.mjs
//
// Generates a plane GLB at public/assets/vehicle_plane.glb.
//
// The plane uses the SAME node structure as the cars (chassis + 4 wheels) so
// the existing loader/renderer code can mount it without changes. The "wheels"
// are the landing gear wheels (small, positioned under the fuselage). The
// "chassis" group holds the entire airframe (fuselage, wings, tail, cockpit).
//
// In flight mode the physics bypasses the raycast vehicle and uses custom
// aerodynamic forces instead, but the visual structure stays the same.

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'public', 'assets', 'vehicle_plane.glb');

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
  fuselage: new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.4, roughness: 0.35 }),
  wing: new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.3, roughness: 0.4 }),
  accent: new THREE.MeshStandardMaterial({ color: 0xcc2222, metalness: 0.3, roughness: 0.4 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x224488, metalness: 0.1, roughness: 0.02, opacity: 0.6, transparent: true }),
  trim: new THREE.MeshStandardMaterial({ color: 0x222228, metalness: 0.2, roughness: 0.7 }),
  engine: new THREE.MeshStandardMaterial({ color: 0x333340, metalness: 0.6, roughness: 0.5 }),
  prop: new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.95 }),
  rim: new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.3 }),
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

  // Fuselage: a tapered cylinder (wider in middle, narrow at tail).
  addPart(chassis, new THREE.CylinderGeometry(0.7, 0.5, 8, 48, 24), M.fuselage, [0, 0, 0], [0, 0, Math.PI / 2]);
  // Nose cone.
  addPart(chassis, new THREE.ConeGeometry(0.7, 1.5, 48, 12), M.fuselage, [0, 0, 4.5], [Math.PI / 2, 0, 0]);

  // Engine cowling at nose.
  addPart(chassis, new THREE.CylinderGeometry(0.55, 0.72, 0.6, 36, 8), M.engine, [0, 0, 5.1], [Math.PI / 2, 0, 0]);

  // Propeller (3 blades).
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.BoxGeometry(0.15, 2.2, 0.04, 4, 12, 2);
    addPart(chassis, blade, M.prop, [0, 0, 5.42], [0, 0, i * (Math.PI * 2 / 3)]);
  }
  // Prop hub.
  addPart(chassis, new THREE.SphereGeometry(0.14, 16, 12), M.engine, [0, 0, 5.4]);

  // Exhaust pipes (small cylinders on fuselage sides).
  for (const sx of [-0.5, 0.5]) {
    addPart(chassis, new THREE.CylinderGeometry(0.06, 0.06, 0.4, 12, 4), M.trim, [sx, -0.3, 3.5], [Math.PI / 2, 0, 0]);
  }

  // Main wings (left + right).
  for (const sx of [-1, 1]) {
    const wing = new THREE.BoxGeometry(6, 0.12, 1.6, 48, 4, 16);
    addPart(chassis, wing, M.wing, [sx * 3.5, -0.1, -0.3]);
    // Wing tip accent.
    addPart(chassis, new THREE.BoxGeometry(0.4, 0.14, 0.8, 8, 4, 8), M.accent, [sx * 6.5, -0.08, -0.3]);
  }

  // Horizontal tail stabilizer.
  for (const sx of [-1, 1]) {
    addPart(chassis, new THREE.BoxGeometry(2.2, 0.08, 0.9, 24, 4, 12), M.wing, [sx * 1.3, 0.15, -3.8]);
  }
  // Vertical tail fin.
  addPart(chassis, new THREE.BoxGeometry(0.08, 1.5, 1.2, 4, 16, 12), M.accent, [0, 0.85, -3.8]);

  // Cockpit canopy (glass dome).
  addPart(chassis, new THREE.SphereGeometry(0.58, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.glass, [0, 0.5, 1.5]);
  // Cockpit frame.
  addPart(chassis, new THREE.TorusGeometry(0.58, 0.04, 8, 16, Math.PI), M.trim, [0, 0.5, 1.5], [Math.PI / 2, 0, 0]);

  // Red racing stripes along fuselage.
  addPart(chassis, new THREE.BoxGeometry(0.12, 0.02, 6, 2, 1, 12), M.accent, [0.35, 0.68, 0]);
  addPart(chassis, new THREE.BoxGeometry(0.12, 0.02, 6, 2, 1, 12), M.accent, [-0.35, 0.68, 0]);

  // Landing gear struts (visible beneath fuselage).
  // Front gear.
  addPart(chassis, new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6), M.trim, [0, -0.9, 2.5]);
  // Rear gear struts.
  addPart(chassis, new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6), M.trim, [-0.8, -0.9, -0.5]);
  addPart(chassis, new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6), M.trim, [0.8, -0.9, -0.5]);

  return chassis;
}

function buildWheel(name, x, z) {
  const wheel = new THREE.Group();
  wheel.name = name;
  wheel.position.set(x, -1.3, z);

  // Small landing gear wheel.
  const tire = new THREE.CylinderGeometry(0.22, 0.22, 0.15, 24, 4);
  tire.rotateZ(Math.PI / 2);
  addPart(wheel, tire, M.tire);
  const rim = new THREE.CylinderGeometry(0.12, 0.12, 0.16, 16, 2);
  rim.rotateZ(Math.PI / 2);
  addPart(wheel, rim, M.rim);

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

  // 4 wheels required by the loader: front pair at the nose gear, rear pair at main gear.
  const wheels = {
    wheel_FL: buildWheel('wheel_FL', -0.3, 2.5),
    wheel_FR: buildWheel('wheel_FR', 0.3, 2.5),
    wheel_RL: buildWheel('wheel_RL', -0.8, -0.5),
    wheel_RR: buildWheel('wheel_RR', 0.8, -0.5),
  };
  for (const w of Object.values(wheels)) vehicle.add(w);

  const chassisTris = nodeTriangleCount(chassis);
  console.log(`chassis: ${chassisTris} tris (min 20000: ${chassisTris >= 20000 ? 'OK' : 'FAIL'})`);
  for (const [name, w] of Object.entries(wheels)) {
    const t = nodeTriangleCount(w);
    console.log(`${name}: ${t} tris`);
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
