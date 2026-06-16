// Application entry point for the 3D Car Hill-Climb game (Vite module entry).
//
// Bootstrap sequence:
//   1. Show a loading overlay at 0% (Req 1.4).
//   2. Load and validate the vehicle GLB ('/assets/vehicle.glb'). On failure,
//      show an error panel naming the asset and HALT (Req 1.3, 1.5).
//   3. Build the mountain terrain procedurally (so the collider, the visuals,
//      and the spawn-height calculation all share one elevation field), then
//      initialise the Rapier physics engine with it.
//   4. Set up the renderer (mount vehicle + terrain, scatter trees), input,
//      HUD, LOD controller, and the checkpoint progression.
//   5. Start the game loop and remove the overlay.
//   6. Any fatal error is surfaced via the overlay with a retry affordance.

import type { LoadResult, Vec3, VehicleConfig, VehicleMeshes, WheelConfig } from './types';

import { GltfAssetLoader } from './systems/asset-loader';
import { terrainElevation, surfaceFrictionAt } from './systems/terrain';
import { ChunkManager } from './systems/chunk-manager';
import { FuelPickupManager } from './systems/fuel-pickup';
import { HazardPoolManager } from './systems/hazard-pools';
import { LoadingOverlay } from './systems/loading-overlay';
import { RapierPhysicsEngine } from './systems/physics-engine';
import { Renderer } from './systems/renderer';
import { InputController } from './systems/input-controller';
import { Hud } from './systems/hud';
import { LodController } from './systems/lod-controller';
import { ObjectiveManager } from './systems/objective';
import { AnimalManager } from './systems/animals';
import { TreeRagdollManager } from './systems/tree-ragdoll';
import { resumeAudio } from './systems/audio';
import { GameLoop } from './game-loop';

/** URL of the vehicle GLB per car type. */
const VEHICLE_URLS: Record<CarType, string> = {
  jeep: '/assets/vehicle.glb',
  rally: '/assets/vehicle_rally.glb',
  sports: '/assets/vehicle_sports.glb',
  plane: '/assets/vehicle_plane.glb',
  bike: '/assets/vehicle_bike.glb',
};

/** Horizontal (x, z) anchor the vehicle spawns at. */
const SPAWN_XZ = { x: 0, z: 0 };

/**
 * Vertical clearance (metres) added above the terrain surface at the spawn
 * point so the jeep starts fully above the ground and settles onto it. Must
 * exceed the chassis-centre-to-wheel-bottom distance: mountY (-0.1) -
 * restLength (0.55) - radius (0.5) = -1.15 m.
 */
const SPAWN_CLEARANCE = 1.5;

/** Resolve the spawn position from the terrain surface at the spawn anchor. */
function resolveSpawn(): Vec3 {
  const surfaceY = terrainElevation(SPAWN_XZ.x, SPAWN_XZ.z);
  return { x: SPAWN_XZ.x, y: surfaceY + SPAWN_CLEARANCE, z: SPAWN_XZ.z };
}

/**
 * Build the vehicle configuration used to size the chassis collider and
 * configure the four raycast wheels. Engine force is sized so the vehicle can
 * climb the mountain's sustained grades; `frictionSlip` stays within the
 * required [0.05, 1.50] bound (Req 6.5).
 */
function buildVehicleConfig(carType: CarType): VehicleConfig {
  // Base values (jeep).
  let chassisMass = 1250;
  let maxEngineForce = 9000;
  let maxBrakeForce = 4000;
  let frictionSlip = 1.3;
  let suspensionStiffness = 26;

  if (carType === 'rally') {
    chassisMass = 1000;
    maxEngineForce = 11000;
    maxBrakeForce = 5000;
    frictionSlip = 1.4;
    suspensionStiffness = 30;
  } else if (carType === 'sports') {
    chassisMass = 900;
    maxEngineForce = 14000;
    maxBrakeForce = 6000;
    frictionSlip = 1.1;
    suspensionStiffness = 34;
  } else if (carType === 'plane') {
    chassisMass = 800;
    maxEngineForce = 12000;
    maxBrakeForce = 3000;
    frictionSlip = 0.9;
    suspensionStiffness = 20;
  } else if (carType === 'bike') {
    chassisMass = 350;
    maxEngineForce = 6000;
    maxBrakeForce = 3500;
    frictionSlip = 1.0;
    suspensionStiffness = 35;
  }

  const halfWidth = carType === 'bike' ? 0.15 : 0.95;
  const halfLength = carType === 'bike' ? 1.0 : 1.5;
  const mountY = carType === 'bike' ? -0.2 : -0.1;

  const wheel = (
    index: 0 | 1 | 2 | 3,
    x: number,
    z: number,
    isSteered: boolean,
  ): WheelConfig => ({
    index,
    connectionPointLocal: { x, y: mountY, z },
    suspensionRestLength: 0.55,
    suspensionStiffness,
    suspensionDamping: 3.2,
    maxSuspensionTravel: 0.4, // generous travel for visible off-road suspension
    radius: 0.5, // chunky off-road tyres
    isSteered,
    isDriven: true,
    frictionSlip,
  });

  return {
    chassisMass,
    chassisHalfExtents: carType === 'bike' ? { x: 0.3, y: 0.5, z: 1.2 } : { x: 1.1, y: 0.6, z: 2.2 },
    maxEngineForce,
    maxBrakeForce,
    wheels: [
      wheel(0, halfWidth, halfLength, true), //  FL
      wheel(1, -halfWidth, halfLength, true), //  FR
      wheel(2, halfWidth, -halfLength, false), // RL
      wheel(3, -halfWidth, -halfLength, false), // RR
    ],
    driveLayout: 'awd',
  };
}

/** Resolve a required DOM element by id, throwing a descriptive fatal error. */
function requireElement<T extends HTMLElement>(
  id: string,
  guard: (el: HTMLElement) => el is T,
): T {
  const el = document.getElementById(id);
  if (!el || !guard(el)) {
    throw new Error(`Required element #${id} not found or of the wrong type.`);
  }
  return el;
}

function isCanvas(el: HTMLElement): el is HTMLCanvasElement {
  return el instanceof HTMLCanvasElement;
}

function isHtmlElement(el: HTMLElement): el is HTMLElement {
  return el instanceof HTMLElement;
}

/**
 * Run the full bootstrap sequence. Safe to call again (e.g. from the loading
 * overlay's retry button) after a failure.
 */
async function bootstrap(overlay: LoadingOverlay, carType: CarType = 'jeep'): Promise<void> {
  const canvas = requireElement('game-canvas', isCanvas);
  const hudMount = requireElement('hud-overlay', isHtmlElement);

  // 1 + 2. Load and validate the vehicle GLB, reporting progress (Req 1.4).
  overlay.showProgress(0);
  const assetLoader = new GltfAssetLoader();
  let vehicleResult: LoadResult<VehicleMeshes>;
  try {
    vehicleResult = await assetLoader.loadVehicle(VEHICLE_URLS[carType], (p) =>
      overlay.showProgress(p.percent),
    );
  } finally {
    assetLoader.dispose();
  }

  if (!vehicleResult.ok) {
    const { asset, message } = vehicleResult.error;
    overlay.showError(asset, message, () => {
      void bootstrap(overlay).catch((err) => reportFatal(overlay, err));
    });
    return;
  }
  const vehicleMeshes = vehicleResult.value;

  // 3. Initialise physics (no single terrain — chunks add colliders below).
  const config = buildVehicleConfig(carType);
  const physics = new RapierPhysicsEngine(config);
  try {
    await physics.init(config.wheels);
  } catch (err) {
    overlay.showError(
      'physics engine',
      `The physics engine could not start (WebAssembly init failed): ${errorText(err)}`,
      () => {
        void bootstrap(overlay).catch((e) => reportFatal(overlay, e));
      },
    );
    return;
  }

  // 4. Renderer + input + HUD + LOD.
  const renderer = new Renderer(canvas, config);
  renderer.mount(vehicleMeshes);

  const input = new InputController();
  const hud = new Hud(hudMount);
  const lod = new LodController(renderer);

  // Infinite streaming world: generate chunks around the spawn before starting
  // so the vehicle lands on solid ground.
  const fuelPickups = new FuelPickupManager({ fuelPerPickup: 200 });
  const hazardPools = new HazardPoolManager();
  const chunks = new ChunkManager(renderer.scene, physics, { viewRadius: 5, fuelPickups, hazardPools });
  const startPosition = resolveSpawn();
  chunks.ensureAround(startPosition);

  const objective = new ObjectiveManager({
    sampler: terrainElevation,
    startZ: SPAWN_XZ.z + 90, // first checkpoint just ahead
    stepZ: 90, // each next checkpoint ~90 m further out
    maxZ: Number.POSITIVE_INFINITY, // never-ending
    lateralAmplitude: 60, // weave across the terrain
    radius: 11,
  });

  // Dynamic world: biome animals (that shove the car).
  const animals = new AnimalManager(renderer.scene, physics, { perBiome: 4 });
  const treeRagdolls = new TreeRagdollManager(renderer.scene);

  // 5. Game loop — start, then remove the overlay now the scene is ready.
  const loop = new GameLoop({
    physics,
    renderer,
    input,
    hud,
    lod,
    startPosition,
    carType,
    objective,
    surfaceFrictionAt,
    entities: [chunks, animals, fuelPickups, hazardPools],
    chunks,
    hazardPools,
    treeRagdolls,
    fuelPickups,
  });
  loop.start();

  // Resume audio on first user interaction (browser autoplay policy).
  const onInteraction = (): void => {
    resumeAudio();
    document.removeEventListener('keydown', onInteraction);
    document.removeEventListener('click', onInteraction);
  };
  document.addEventListener('keydown', onInteraction);
  document.addEventListener('click', onInteraction);

  overlay.hide();
}

/** Best-effort extraction of a readable message from a thrown value. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/**
 * Surface a fatal bootstrap error to the user via the overlay's error panel
 * (with a retry affordance) and log it for diagnostics.
 */
function reportFatal(overlay: LoadingOverlay, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap:', err);
  overlay.showError('startup', errorText(err), () => {
    void bootstrap(overlay).catch((e) => reportFatal(overlay, e));
  });
}

/** Car type selected from the menu. */
type CarType = 'jeep' | 'rally' | 'sports' | 'plane' | 'bike';

/** Entry point: show start menu with car selection, then bootstrap. */
function main(): void {
  const app = document.getElementById('app');
  const mount = app instanceof HTMLElement ? app : document.body;

  const menu = document.createElement('div');
  menu.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    color: #fff; font-family: system-ui, sans-serif;
  `;
  menu.innerHTML = `
    <h1 style="font-size: 3rem; margin-bottom: 0.5rem; text-shadow: 0 4px 12px rgba(0,0,0,0.5);">🏔️ Hill Climber 3D</h1>
    <p style="opacity: 0.7; margin-bottom: 1.5rem; font-size: 1.1rem;">Drive across infinite biomes. Dodge wildlife. Reach checkpoints.</p>
    <p style="opacity: 0.8; margin-bottom: 0.8rem; font-size: 1rem;">Choose your car:</p>
    <div style="display: flex; gap: 16px; margin-bottom: 2rem;">
      <button class="car-btn" data-car="jeep" style="padding: 12px 24px; font-size: 1rem; font-weight: 700; border: 2px solid #cc3322; border-radius: 8px; cursor: pointer; background: #cc3322; color: #fff;">🚙 Jeep</button>
      <button class="car-btn" data-car="rally" style="padding: 12px 24px; font-size: 1rem; font-weight: 700; border: 2px solid #2288dd; border-radius: 8px; cursor: pointer; background: #2288dd; color: #fff;">🏎️ Rally</button>
      <button class="car-btn" data-car="sports" style="padding: 12px 24px; font-size: 1rem; font-weight: 700; border: 2px solid #ffaa00; border-radius: 8px; cursor: pointer; background: #ffaa00; color: #111;">⚡ Sports</button>
      <button class="car-btn" data-car="plane" style="padding: 12px 24px; font-size: 1rem; font-weight: 700; border: 2px solid #66bbff; border-radius: 8px; cursor: pointer; background: #66bbff; color: #111;">✈️ Plane</button>
      <button class="car-btn" data-car="bike" style="padding: 12px 24px; font-size: 1rem; font-weight: 700; border: 2px solid #ff6600; border-radius: 8px; cursor: pointer; background: #ff6600; color: #fff;">🏍️ Bike</button>
    </div>
    <p style="opacity: 0.5; font-size: 0.85rem;">
      W/↑ = throttle &nbsp; S/↓ = brake/reverse &nbsp; A←/D→ = steer &nbsp; Z = camera &nbsp; C = rear view &nbsp; R = reset
    </p>
  `;
  mount.appendChild(menu);

  menu.querySelectorAll('.car-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const carType = (btn as HTMLElement).dataset.car as CarType;
      menu.remove();
      const overlay = new LoadingOverlay(mount);
      bootstrap(overlay, carType).catch((err) => reportFatal(overlay, err));
    });
  });
}

main();
