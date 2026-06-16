// Renderer — Three.js (WebGL2) rendering shell for the 3D Car Hill-Climb game.
//
// This is the thin I/O shell described in design.md's "Renderer and Wheel
// Synchronization" section. It owns the Three.js `Scene`, `WebGLRenderer`,
// `PerspectiveCamera`, and lights, draws each frame, and applies the wheel
// spin / steer / suspension transforms computed from the interpolated physics
// state.
//
// Scene-graph layout (Req 2.5): the chassis mesh and the four wheel meshes are
// SIBLINGS under a shared `vehicleGroup`. Wheel meshes are NOT children of the
// chassis, so spinning or steering a wheel never transforms the chassis. Each
// wheel mesh is positioned every frame from physics-derived data: the chassis
// transform is read (never written) to keep the wheel visually attached, then
// the wheel's own spin/steer/suspension offset is layered on top.
//
// All testable kinematics are delegated to the pure-logic core:
//   - wheelSpinDelta / clampVisualSteer  (src/logic/wheel-kinematics.ts)
//   - wheelVerticalOffset                (src/logic/suspension.ts)
//
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.5, 10.1, 10.3

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { FIXED_DT } from '../constants';
import type {
  InterpolatedState,
  LODLevel,
  Quat,
  Vec3,
  VehicleConfig,
  VehicleMeshes,
  WheelConfig,
} from '../types';

import { clampVisualSteer, wheelSpinDelta } from '../logic/wheel-kinematics';
import { wheelVerticalOffset } from '../logic/suspension';

const DEG_TO_RAD = Math.PI / 180;

/** Local axle axis (wheels spin about local X). */
const AXIS_X = new THREE.Vector3(1, 0, 0);
/** Local vertical axis (wheels steer about local Y). */
const AXIS_Y = new THREE.Vector3(0, 1, 0);

/** Base chase-camera offset relative to the chassis, before yaw rotation. */
const CHASE_OFFSETS: THREE.Vector3[] = [
  new THREE.Vector3(0, 4, -9),    // default
  new THREE.Vector3(0, 6, -14),   // far
  new THREE.Vector3(0, 10, -22),  // very far
  new THREE.Vector3(-0.38, 1.35, -0.15), // first person (driver's eye position)
];
/** Height above the chassis the camera looks toward. */
const CHASE_LOOK_HEIGHT = 1.2;
/** Chase-camera damping rate (per second); higher = snappier follow. */
const CAM_SMOOTH = 4;

/** Sliding window length for the FPS estimate, in milliseconds (~1 s). */
const FPS_WINDOW_MS = 1000;

/**
 * Per-level rendering quality settings. Index by `LODLevel` where 0 is the
 * lowest detail and 3 is the highest.
 *
 * LOD mapping (Req 10.1, 10.3):
 *   Level 0 (lowest):  shadows OFF,                 pixelRatio 0.75, draw distance 200 m
 *   Level 1:           shadows ON,  512x512  map,   pixelRatio 1.00, draw distance 350 m
 *   Level 2:           shadows ON, 1024x1024 map,   pixelRatio <=1.5, draw distance 600 m
 *   Level 3 (highest): shadows ON, 2048x2048 map,   pixelRatio <=2.0, draw distance 1000 m
 *
 * `pixelRatio` is the multiplier applied on top of the device pixel ratio cap;
 * lowering it reduces the internal render resolution. `shadowMapSize` is the
 * square shadow-map resolution for the directional light. `drawDistance` is the
 * camera far plane.
 */
interface LODSettings {
  shadowsEnabled: boolean;
  shadowMapSize: number;
  pixelRatioCap: number;
  drawDistance: number;
}

const LOD_SETTINGS: Record<LODLevel, LODSettings> = {
  0: { shadowsEnabled: false, shadowMapSize: 512, pixelRatioCap: 0.75, drawDistance: 200 },
  1: { shadowsEnabled: true, shadowMapSize: 512, pixelRatioCap: 1.0, drawDistance: 350 },
  2: { shadowsEnabled: true, shadowMapSize: 1024, pixelRatioCap: 1.5, drawDistance: 600 },
  3: { shadowsEnabled: true, shadowMapSize: 2048, pixelRatioCap: 2.0, drawDistance: 1000 },
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Extract the yaw (rotation about world Y) from a unit quaternion. */
function yawFromQuaternion(q: THREE.Quaternion): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

/**
 * Three.js-backed renderer for the vehicle and terrain.
 *
 * Construction sets up the WebGL2 renderer (antialiased), scene, camera, and
 * lighting (hemisphere fill + shadow-casting directional key light), and adds
 * the shared `vehicleGroup` to the scene. Call {@link mount} with the loaded
 * vehicle meshes and terrain before rendering, then drive frames through
 * {@link renderFrame}.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly canvas: HTMLCanvasElement;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly dirLight: THREE.DirectionalLight;
  private readonly vehicleGroup: THREE.Group;

  /** Beacon marking the current objective/checkpoint (hidden until placed). */
  private readonly objectiveMarker = new THREE.Group();
  /** Rotating top assembly of the objective beacon. */
  private readonly objectiveSpinner = new THREE.Group();
  /** Accumulated time driving the beacon's spin/bob animation. */
  private markerSpin = 0;

  /** Group holding the reusable landslide-debris rock meshes. */
  private readonly debrisGroup = new THREE.Group();
  /** Reusable rock meshes for rendering landslide debris. */
  private readonly debrisPool: THREE.Mesh[] = [];
  /** Shared geometry/material for debris rocks (unit radius). */
  private readonly debrisGeo = new THREE.IcosahedronGeometry(1, 1);
  private readonly debrisMat = new THREE.MeshStandardMaterial({
    color: 0x6b6d70,
    roughness: 0.9,
    metalness: 0.05,
  });

  /** Static per-wheel config (radius, rest length, steered flag, mount point). */
  private readonly wheelConfigs: WheelConfig[];

  // Mounted scene-graph references (null until `mount` is called).
  private chassisMesh: THREE.Object3D | null = null;
  private readonly wheelMeshes: Array<THREE.Object3D | null> = [null, null, null, null];

  /** Base connection (mount) point of each wheel in chassis-local space. */
  private readonly wheelBaseConnections: THREE.Vector3[] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];

  /** Accumulated spin angle (radians) per wheel, held across frames (Req 2.6). */
  private readonly spinAngles: number[] = [0, 0, 0, 0];

  /** Smoothed ground speed for wheel spin — prevents snapping on direction changes. */
  private smoothedGroundSpeed = 0;

  /** LOD level currently applied (3 = highest detail). */
  private lodLevel: LODLevel = 3;

  // Frame timing.
  private lastFrameNow: number | null = null;
  private readonly fpsSamples: number[] = [];

  // Chase-camera state.
  private cameraInitialized = false;
  private cameraOffsetIndex = 0;
  private rearView = false;

  // Reusable scratch objects (avoid per-frame allocation).
  private readonly _chassisPos = new THREE.Vector3();
  private readonly _chassisQuat = new THREE.Quaternion();
  private readonly _prevQuat = new THREE.Quaternion();
  private readonly _currQuat = new THREE.Quaternion();
  private readonly _wheelLocalOffset = new THREE.Vector3();
  private readonly _wheelPos = new THREE.Vector3();
  private readonly _steerQuat = new THREE.Quaternion();
  private readonly _spinQuat = new THREE.Quaternion();
  private readonly _wheelQuat = new THREE.Quaternion();
  private readonly _camOffset = new THREE.Vector3();
  private readonly _desiredCamPos = new THREE.Vector3();
  private readonly _lookTarget = new THREE.Vector3();

  private readonly onWindowResize = (): void => {
    this.resize(this.canvas.clientWidth || this.canvas.width, this.canvas.clientHeight || this.canvas.height);
  };

  /**
   * @param canvas The HTML canvas element to render into.
   * @param config Vehicle configuration; its `wheels` provide the radius, rest
   *               length, steered flag, and mount point used for wheel sync.
   */
  constructor(canvas: HTMLCanvasElement, config: VehicleConfig) {
    this.canvas = canvas;
    this.wheelConfigs = config.wheels;

    // WebGL2, antialiased renderer (Req 10.1).
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Filmic tone mapping for richer paint/metal/emissive response.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;

    this.scene = new THREE.Scene();
    // Sky: gradient from blue to light blue at horizon.
    this.scene.background = new THREE.Color(0x87ceeb);
    // Distance fog blends the far edges of the big map into the sky.
    this.scene.fog = new THREE.Fog(0x87ceeb, 220, 900);

    // Sun (a bright sphere in the sky for visual reference).
    const sunGeo = new THREE.SphereGeometry(8, 16, 12);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffffd0 });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    sun.position.set(200, 350, 300);
    this.scene.add(sun);

    // Clouds: a scattering of semi-transparent ellipsoids at high altitude.
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
    for (let i = 0; i < 30; i++) {
      const cg = new THREE.SphereGeometry(12 + Math.random() * 20, 8, 6);
      const cloud = new THREE.Mesh(cg, cloudMat);
      cloud.scale.set(1 + Math.random() * 2, 0.4 + Math.random() * 0.3, 1 + Math.random());
      cloud.position.set(
        (Math.random() - 0.5) * 800,
        180 + Math.random() * 80,
        (Math.random() - 0.5) * 800,
      );
      this.scene.add(cloud);
    }

    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, LOD_SETTINGS[3].drawDistance);
    this.camera.position.set(0, 5, -10);

    // Hemisphere fill light (sky/ground ambient).
    this.hemiLight = new THREE.HemisphereLight(0xbfd4ff, 0x4a3b2a, 0.9);
    this.scene.add(this.hemiLight);

    // Directional key light with shadows (Req 10.3 toggles these per LOD).
    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    this.dirLight.position.set(40, 80, 30);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.camera.near = 1;
    this.dirLight.shadow.camera.far = 300;
    this.dirLight.shadow.camera.left = -80;
    this.dirLight.shadow.camera.right = 80;
    this.dirLight.shadow.camera.top = 80;
    this.dirLight.shadow.camera.bottom = -80;
    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);

    // Shared group holding chassis + wheels as siblings (Req 2.5). The group
    // itself stays at identity; meshes are placed in world space each frame.
    this.vehicleGroup = new THREE.Group();
    this.vehicleGroup.name = 'vehicleGroup';
    this.scene.add(this.vehicleGroup);

    // Objective beacon (added once; positioned/shown via setObjectivePosition).
    this.buildObjectiveMarker();
    this.scene.add(this.objectiveMarker);

    // Landslide debris group (rocks added on demand via updateDebris).
    this.debrisGroup.name = 'debris';
    this.scene.add(this.debrisGroup);

    this.renderer.setSize(width, height, false);
    this.setLOD(3);
    this.setupEnvironment();

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', this.onWindowResize);
    }
  }

  /**
   * Generate a prefiltered environment map from a neutral room and assign it as
   * the scene environment so metalness / low-roughness materials (the car's
   * glass, chrome grille, and mirrors) show real reflections. Guarded so it is
   * a no-op in headless/test contexts without a real WebGL context.
   */
  private setupEnvironment(): void {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new RoomEnvironment();
      this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
      pmrem.dispose();
    } catch {
      // No WebGL context (e.g. unit tests) — skip reflections.
    }
  }

  /**
   * Mount the loaded vehicle meshes and terrain into the scene.
   *
   * The chassis mesh and the four wheel meshes are added as SIBLINGS under the
   * shared `vehicleGroup` (wheels are explicitly NOT parented to the chassis),
   * satisfying the wheel-independence requirement (Req 2.5). The wheels' base
   * connection points are captured from the wheel configuration so each wheel
   * can be repositioned relative to the chassis every frame.
   *
   * @param meshes  Validated vehicle meshes (chassis + 4 wheels: FL, FR, RL, RR).
   * @param terrain The terrain visual scene graph.
   */
  mount(meshes: VehicleMeshes, terrain?: THREE.Object3D): void {
    // Chassis as a direct child of the group (sibling of wheels). The chassis
    // node is a group of detail meshes, so enable shadow casting on all of them.
    this.chassisMesh = meshes.chassis;

    // Collect meshes first, then add outlines (avoids traverse + modify loop).
    const chassisMeshes: THREE.Mesh[] = [];
    this.chassisMesh.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        chassisMeshes.push(mesh);
      }
    });

    // Add black outlines (inverted-hull method) after traversal is complete.
    const outlineMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
    for (const mesh of chassisMeshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat && !mat.transparent) {
        const outline = new THREE.Mesh(mesh.geometry, outlineMat);
        outline.scale.multiplyScalar(1.04);
        mesh.add(outline);
      }
    }

    this.vehicleGroup.add(this.chassisMesh);

    // Wheels as siblings of the chassis under the same group.
    for (let i = 0; i < 4; i += 1) {
      const wheel = meshes.wheels[i];
      if (!wheel) continue;
      wheel.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
        }
      });
      this.vehicleGroup.add(wheel);
      this.wheelMeshes[i] = wheel;

      const cfg = this.wheelConfigs[i];
      const base = this.wheelBaseConnections[i];
      if (cfg && base) {
        base.set(
          cfg.connectionPointLocal.x,
          cfg.connectionPointLocal.y,
          cfg.connectionPointLocal.z,
        );
      }
      this.spinAngles[i] = 0;
    }

    // Terrain visual (optional; the streaming ChunkManager adds chunk meshes
    // directly to the scene in the infinite-world configuration).
    if (terrain) {
      terrain.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.receiveShadow = true;
        }
      });
      this.scene.add(terrain);
    }
  }

  /**
   * Build the objective beacon: a tall pole with a rotating, glowing ring and
   * gem on top so the next checkpoint is visible from a distance. Hidden until
   * {@link setObjectivePosition} places it.
   */
  private buildObjectiveMarker(): void {
    this.objectiveMarker.name = 'objectiveMarker';
    this.objectiveMarker.visible = false;

    const poleHeight = 24;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.25, poleHeight, 8),
      new THREE.MeshStandardMaterial({
        color: 0xffd54a,
        emissive: 0x6b4e00,
        emissiveIntensity: 0.5,
        roughness: 0.5,
      }),
    );
    pole.position.y = poleHeight / 2;
    this.objectiveMarker.add(pole);

    // Rotating beacon assembly at the top of the pole.
    this.objectiveSpinner.position.y = poleHeight;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.2, 0.32, 10, 24),
      new THREE.MeshStandardMaterial({
        color: 0x33ddff,
        emissive: 0x1488bb,
        emissiveIntensity: 0.9,
        roughness: 0.4,
      }),
    );
    ring.rotation.x = Math.PI / 2;
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.5),
      new THREE.MeshStandardMaterial({
        color: 0xffee66,
        emissive: 0xffae00,
        emissiveIntensity: 1.0,
        roughness: 0.3,
      }),
    );
    this.objectiveSpinner.add(ring);
    this.objectiveSpinner.add(gem);
    this.objectiveMarker.add(this.objectiveSpinner);
  }

  /**
   * Place the objective beacon at a world position (its `y` should be the
   * terrain surface) and make it visible. Called whenever the active checkpoint
   * changes.
   */
  setObjectivePosition(pos: Vec3): void {
    this.objectiveMarker.position.set(pos.x, pos.y, pos.z);
    this.objectiveMarker.visible = true;
  }

  /**
   * Apply localised crumple deformation at a specific impact point on the
   * chassis. Pushes vertices near the impact inward, creating a visible dent.
   * All child meshes (body panels, glass, interior) deform together since
   * they're all traversed. Additionally, glass meshes (transparent materials)
   * facing the impact are shattered (made invisible) on strong-enough hits.
   *
   * @param impactLocalDir normalised direction FROM the impact point TOWARD the
   *        car centre, in chassis-local space.
   * @param strength how hard the hit was (0..1, from speed/damage).
   */
  applyCrumpleAt(impactLocalDir: Vec3, strength: number): { glassShattered: boolean } {
    if (!this.chassisMesh) return { glassShattered: false };
    const dir = new THREE.Vector3(impactLocalDir.x, impactLocalDir.y, impactLocalDir.z).normalize();
    const maxDisplace = 0.25 * Math.min(1, strength);
    const falloff = 1.8;
    let glassShattered = false;

    // Collect objects first to avoid traverse-during-modify issues.
    const objects: THREE.Object3D[] = [];
    this.chassisMesh.traverse((obj) => { objects.push(obj); });

    for (const obj of objects) {
      // --- Mirror detachment ---
      if (obj.name.startsWith('mirror_')) {
        const isLeft = obj.name === 'mirror_left';
        const sideAlign = isLeft ? -dir.x : dir.x;
        if (sideAlign > 0.3 && strength > 0.25) {
          obj.visible = false;
        }
        continue;
      }

      // --- Shift POSITION of direct children (grille, lights, plates, etc.) ---
      if (obj !== this.chassisMesh && obj.parent === this.chassisMesh) {
        const p = obj.position;
        const dot = p.x * dir.x + p.y * dir.y + p.z * dir.z;
        if (dot > 0) {
          const proximity = Math.max(0, 1 - (1.5 - dot) / falloff);
          if (proximity > 0) {
            const shift = maxDisplace * proximity * 0.7;
            p.x -= dir.x * shift;
            p.y -= dir.y * shift * 0.2;
            p.z -= dir.z * shift;
          }
        }
      }

      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) continue;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) continue;

      const mat = mesh.material as THREE.MeshStandardMaterial;
      const isGlass = mat && mat.transparent && mat.opacity < 0.9;

      // Windows shatter first.
      if (isGlass && strength > 0.15) {
        const meshPos = new THREE.Vector3();
        mesh.getWorldPosition(meshPos);
        if (this.chassisMesh) {
          const chassisWorldPos = new THREE.Vector3();
          this.chassisMesh.getWorldPosition(chassisWorldPos);
          meshPos.sub(chassisWorldPos);
        }
        if (meshPos.dot(dir) > 0) {
          mesh.visible = false;
          glassShattered = true;
          continue;
        }
      }

      // Deform vertices.
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const vz = pos.getZ(i);
        const dot = vx * dir.x + vy * dir.y + vz * dir.z;
        if (dot < 0) continue;
        const proximity = Math.max(0, 1 - (1.5 - dot) / falloff);
        if (proximity <= 0) continue;
        const displace = maxDisplace * proximity;
        pos.setXYZ(i, vx - dir.x * displace, vy - dir.y * displace * 0.3, vz - dir.z * displace);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    }
    return { glassShattered };
  }

  /**
   * Legacy whole-car crumple (for HUD-driven proportional display). Now a no-op
   * since deformation is localised via applyCrumpleAt; kept for API compat.
   */
  applyCrumple(_health: number): void {
    // Intentionally empty — localised crumple replaces global scaling.
  }

  /**
   * Render the active landslide debris. A pool of rock meshes is grown on demand
   * and reused; each entry is positioned/oriented/scaled to a debris snapshot,
   * and any surplus pool meshes are hidden.
   *
   * @param debris snapshots from the physics engine (position, quaternion, radius)
   */
  updateDebris(
    debris: ReadonlyArray<{ position: Vec3; quaternion: Quat; radius: number }>,
  ): void {
    while (this.debrisPool.length < debris.length) {
      const mesh = new THREE.Mesh(this.debrisGeo, this.debrisMat);
      mesh.castShadow = true;
      mesh.visible = false;
      this.debrisPool.push(mesh);
      this.debrisGroup.add(mesh);
    }

    for (let i = 0; i < this.debrisPool.length; i += 1) {
      const mesh = this.debrisPool[i];
      if (!mesh) continue;
      const d = debris[i];
      if (d) {
        mesh.visible = true;
        mesh.position.set(d.position.x, d.position.y, d.position.z);
        mesh.quaternion.set(d.quaternion.x, d.quaternion.y, d.quaternion.z, d.quaternion.w);
        mesh.scale.setScalar(d.radius);
      } else {
        mesh.visible = false;
      }
    }
  }

  /**
   * Render a single frame from an interpolated physics state.
   *
   * Steps:
   *  1. Blend the chassis position (lerp) and orientation (slerp) between the
   *     previous and current physics snapshots by `alpha`, and apply them to
   *     the chassis mesh.
   *  2. For each wheel, compute and apply:
   *     - spin: accumulate the axle angle by `wheelSpinDelta(groundSpeed,
   *       radius, dt)` so the wheel tracks ground speed and direction, holding
   *       constant at zero speed (Req 2.1, 2.2, 2.6);
   *     - steer: `clampVisualSteer` about the vertical axis for steered (front)
   *       wheels (Req 2.3, 2.4);
   *     - suspension: a chassis-local vertical offset from `wheelVerticalOffset`
   *       reflecting compression (Req 3.5).
   *     Wheels are placed in world space relative to the (read-only) chassis
   *     transform, never as children of the chassis (Req 2.5).
   *  3. Update the smooth chase camera and draw the scene.
   *
   * @param interp Interpolated physics state (alpha, prev, curr, command).
   */
  renderFrame(interp: InterpolatedState): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let dt = this.lastFrameNow === null ? FIXED_DT : (now - this.lastFrameNow) / 1000;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1; // clamp long stalls so spin/camera don't jump
    this.lastFrameNow = now;

    const { prev, curr, command } = interp;
    const a = clamp01(interp.alpha);

    // 1. Chassis transform (interpolated).
    this._chassisPos.set(
      lerp(prev.chassisPosition.x, curr.chassisPosition.x, a),
      lerp(prev.chassisPosition.y, curr.chassisPosition.y, a),
      lerp(prev.chassisPosition.z, curr.chassisPosition.z, a),
    );
    this._prevQuat.set(
      prev.chassisQuaternion.x,
      prev.chassisQuaternion.y,
      prev.chassisQuaternion.z,
      prev.chassisQuaternion.w,
    );
    this._currQuat.set(
      curr.chassisQuaternion.x,
      curr.chassisQuaternion.y,
      curr.chassisQuaternion.z,
      curr.chassisQuaternion.w,
    );
    this._chassisQuat.slerpQuaternions(this._prevQuat, this._currQuat, a);

    if (this.chassisMesh) {
      this.chassisMesh.position.copy(this._chassisPos);
      this.chassisMesh.quaternion.copy(this._chassisQuat);
    }

    // Per-wheel ground speed: smoothed to prevent snapping when speed sign
    // flips (forward ↔ stop ↔ reverse).
    const rawGroundSpeed = lerp(prev.linearSpeed, curr.linearSpeed, a);
    const speedSmooth = 1 - Math.exp(-12 * dt); // fast but not instant
    this.smoothedGroundSpeed += (rawGroundSpeed - this.smoothedGroundSpeed) * speedSmooth;
    const groundSpeed = this.smoothedGroundSpeed;

    // 2. Wheels (siblings of the chassis; independent transforms).
    for (let i = 0; i < 4; i += 1) {
      const mesh = this.wheelMeshes[i];
      const cfg = this.wheelConfigs[i];
      const base = this.wheelBaseConnections[i];
      if (!mesh || !cfg || !base) continue;

      const prevW = prev.wheels[i];
      const currW = curr.wheels[i];

      // Interpolated suspension compression (Req 3.5).
      const compression = lerp(
        prevW?.suspensionCompression ?? 0,
        currW?.suspensionCompression ?? 0,
        a,
      );

      // Commanded steering: prefer the per-wheel applied angle, else the command.
      const steerDegRaw = currW?.steerDeg ?? command.steerDeg;

      // Spin: accumulate axle rotation (Req 2.1, 2.2, 2.6).
      const prevSpin = this.spinAngles[i] ?? 0;
      this.spinAngles[i] = prevSpin + wheelSpinDelta(groundSpeed, cfg.radius, dt);
      const spinAngle = this.spinAngles[i] ?? 0;

      // Steer: only steered (front) wheels turn; clamped to the visual range.
      const steerDeg = cfg.isSteered ? clampVisualSteer(steerDegRaw) : 0;

      // Suspension offset (chassis-local, negative = downward).
      const vOff = wheelVerticalOffset(cfg.suspensionRestLength, compression);

      // World position = chassisPos + chassisQuat * (baseConnection + vOffset).
      this._wheelLocalOffset.copy(base);
      this._wheelLocalOffset.y += vOff;
      this._wheelPos
        .copy(this._wheelLocalOffset)
        .applyQuaternion(this._chassisQuat)
        .add(this._chassisPos);
      mesh.position.copy(this._wheelPos);

      // Orientation = chassis * steer(Y) * spin(X). Steer is applied before spin
      // so spinning about the axle does not change the steered heading.
      this._steerQuat.setFromAxisAngle(AXIS_Y, steerDeg * DEG_TO_RAD);
      this._spinQuat.setFromAxisAngle(AXIS_X, spinAngle);
      this._wheelQuat
        .copy(this._chassisQuat)
        .multiply(this._steerQuat)
        .multiply(this._spinQuat);
      mesh.quaternion.copy(this._wheelQuat);
    }

    // 3. Chase camera + draw.
    this.updateChaseCamera(dt);

    // Animate the objective beacon (spin + gentle bob) for visibility.
    if (this.objectiveMarker.visible) {
      this.markerSpin += dt;
      this.objectiveSpinner.rotation.y = this.markerSpin * 1.5;
      this.objectiveSpinner.position.y = 24 + Math.sin(this.markerSpin * 2) * 0.5;
    }

    this.renderer.render(this.scene, this.camera);
  }

  /** Cycle to the next camera distance (Z key). */
  cycleCamera(): void {
    this.cameraOffsetIndex = (this.cameraOffsetIndex + 1) % CHASE_OFFSETS.length;
  }

  /** Set rear-view mode (C held). */
  setRearView(active: boolean): void {
    this.rearView = active;
  }

  /**
   * Smoothly follow the chassis from behind and above. The base offset is
   * rotated by the chassis yaw so the camera trails the vehicle's heading, and
   * the position is damped frame-rate-independently toward the target.
   */
  private updateChaseCamera(dt: number): void {
    const yaw = yawFromQuaternion(this._chassisQuat);
    const baseOffset = CHASE_OFFSETS[this.cameraOffsetIndex] ?? CHASE_OFFSETS[0]!;

    // Rear view: flip the offset forward (look backward from behind the car).
    const offset = this.rearView
      ? new THREE.Vector3(-baseOffset.x, baseOffset.y, -baseOffset.z)
      : baseOffset.clone();

    this._camOffset.copy(offset).applyAxisAngle(AXIS_Y, yaw);
    this._desiredCamPos.copy(this._chassisPos).add(this._camOffset);

    if (!this.cameraInitialized) {
      this.camera.position.copy(this._desiredCamPos);
      this.cameraInitialized = true;
    } else {
      // Exponential smoothing: k -> 1 as dt grows, 0 as dt -> 0.
      const k = 1 - Math.exp(-CAM_SMOOTH * dt);
      this.camera.position.lerp(this._desiredCamPos, k);
    }

    this._lookTarget.copy(this._chassisPos);
    this._lookTarget.y += CHASE_LOOK_HEIGHT;
    this.camera.lookAt(this._lookTarget);

    // Keep the shadow frustum centered on the vehicle for crisp shadows.
    this.dirLight.target.position.copy(this._chassisPos);
    this.dirLight.target.updateMatrixWorld();
  }

  /**
   * Apply a level-of-detail setting (Req 10.3). Levels run 0 (lowest) to 3
   * (highest) and adjust shadow-map enablement/size, the render pixel ratio,
   * and the camera draw distance. See {@link LOD_SETTINGS} for the full mapping.
   *
   * @param level Desired detail level.
   */
  setLOD(level: LODLevel): void {
    this.lodLevel = level;
    const s = LOD_SETTINGS[level];

    // Shadows.
    this.renderer.shadowMap.enabled = s.shadowsEnabled;
    this.dirLight.castShadow = s.shadowsEnabled;
    this.dirLight.shadow.mapSize.set(s.shadowMapSize, s.shadowMapSize);
    // Force the shadow map to be rebuilt at the new resolution.
    if (this.dirLight.shadow.map) {
      this.dirLight.shadow.map.dispose();
      this.dirLight.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }

    // Render resolution.
    const deviceRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.renderer.setPixelRatio(Math.min(deviceRatio, s.pixelRatioCap));

    // Draw distance.
    this.camera.far = s.drawDistance;
    this.camera.updateProjectionMatrix();
  }

  /** The currently applied LOD level. */
  getLOD(): LODLevel {
    return this.lodLevel;
  }

  /**
   * Sliding-window FPS estimate over roughly the last second. Records `now`
   * (milliseconds), drops samples older than the window, and returns frames per
   * second derived from the span of retained samples.
   *
   * @param now Current timestamp in milliseconds (e.g. `performance.now()`).
   * @returns Estimated frames per second, or 0 until at least two samples exist.
   */
  measureFps(now: number): number {
    this.fpsSamples.push(now);

    const cutoff = now - FPS_WINDOW_MS;
    while (this.fpsSamples.length > 0 && (this.fpsSamples[0] ?? 0) < cutoff) {
      this.fpsSamples.shift();
    }

    if (this.fpsSamples.length < 2) {
      return 0;
    }
    const oldest = this.fpsSamples[0] ?? now;
    const span = now - oldest;
    if (span <= 0) {
      return 0;
    }
    return ((this.fpsSamples.length - 1) * 1000) / span;
  }

  /**
   * Resize the renderer drawing buffer and update the camera aspect ratio.
   *
   * @param width  New viewport width in CSS pixels.
   * @param height New viewport height in CSS pixels.
   */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /**
   * Release GPU resources, dispose scene geometries/materials, and detach the
   * window resize listener.
   */
  dispose(): void {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', this.onWindowResize);
    }

    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
          material.forEach((m) => m.dispose());
        } else {
          material?.dispose();
        }
      }
    });

    if (this.dirLight.shadow.map) {
      this.dirLight.shadow.map.dispose();
    }
    this.renderer.dispose();
  }
}
