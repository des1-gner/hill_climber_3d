# Implementation Plan: 3D Car Hill-Climb

## Overview

This plan implements a browser-based 3D car hill-climbing game in TypeScript using Three.js for rendering and Rapier WASM for physics. The implementation follows a bottom-up approach: project scaffold first, then pure logic functions with property-based tests, followed by the physics/rendering wrappers, and finally wiring everything together into the game loop with HUD and lifecycle management.

## Tasks

- [x] 1. Project setup and core interfaces
  - [x] 1.1 Scaffold Vite + TypeScript project with dependencies
    - Initialize a Vite TypeScript project
    - Install dependencies: `three`, `@types/three`, `@dimforge/rapier3d-compat`, `vite-plugin-wasm`, `vite-plugin-top-level-await`
    - Install dev dependencies: `vitest`, `fast-check`, `@vitest/coverage-v8`
    - Configure `vite.config.ts` with WASM and top-level-await plugins
    - Configure `vitest.config.ts` for the test runner
    - Create `tsconfig.json` with strict mode enabled
    - _Requirements: 10.2 (fixed timestep needs correct build), Assumptions & Constraints_

  - [x] 1.2 Define shared type interfaces and constants
    - Create `src/types.ts` with `Vec3`, `Quat`, `DriveCommand`, `RawInput`, `WheelConfig`, `WheelState`, `VehicleState`, `RunState`, `RunStatus`, `EndReason`, `BalanceState`, `LODLevel`, `LODState`, `InterpolatedState`, `HudView`, `LoadResult`, `AssetError`, `LoadProgress`, `VehicleMeshes`, `VehicleConfig`, `TerrainModel`, `WheelVisualState`
    - Create `src/constants.ts` with `GRAVITY_Y`, `FIXED_DT`, `START_FUEL`, `FUEL_BURN_RATE`, `RUN_START_SPEED`, `OVERTURN_ANGLE`, `OVERTURN_HOLD`, `CONTROL_STEER_LIMIT`, `VISUAL_STEER_LIMIT`, `REST_PENETRATION_MAX`, `SUSPENSION_VIS_TOLERANCE`, `LOAD_TIMEOUT_MS`, `REQUIRED_WHEEL_NODES`, `CHASSIS_NODE`
    - _Requirements: All (shared data model)_

- [x] 2. Pure logic — Input and wheel kinematics
  - [x] 2.1 Implement `resolveInput`
    - Create `src/logic/input.ts`
    - Implement clamping of throttle [0,1], brake [0,1], steer [-35,+35]
    - Coerce non-finite values (NaN, Infinity) to 0 before clamping
    - Implement brake-over-throttle arbitration (when both active, zero the throttle)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7_

  - [x]* 2.2 Write property test for `resolveInput`
    - **Property 8: Input resolution is bounded, proportional, and arbitrated**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6, 5.7**

  - [x] 2.3 Implement `wheelSpinDelta` and `clampVisualSteer`
    - Create `src/logic/wheel-kinematics.ts`
    - `wheelSpinDelta(groundSpeed, wheelRadius, dt)` returns `(groundSpeed / wheelRadius) * dt`; guard against radius <= 0
    - `clampVisualSteer(commandedDeg)` clamps to [-45, +45]
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

  - [x]* 2.4 Write property tests for wheel kinematics
    - **Property 2: Wheel spin tracks ground speed and direction**
    - **Validates: Requirements 2.1, 2.2, 2.6**
    - **Property 3: Visual steering angle is clamped to [-45, 45]**
    - **Validates: Requirements 2.3, 2.4**

- [x] 3. Pure logic — Suspension, traction, and orientation
  - [x] 3.1 Implement `computeSuspensionCompression`, `wheelVerticalOffset`, and `capDriveForce`
    - Create `src/logic/suspension.ts`
    - `computeSuspensionCompression(restLength, contactDistance, minTravel, maxTravel, inContact)`: when in contact returns `max(0, restLength - contactDistance)` clamped to [minTravel, maxTravel]; when not in contact returns maxTravel
    - `wheelVerticalOffset(restLength, compression)` returns the vertical position offset
    - Create `src/logic/traction.ts`
    - `capDriveForce(demandedForce, frictionCoeff, normalForce)`: returns `min(demandedForce, frictionCoeff * normalForce)` when in contact, 0 when not
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 6.1, 6.2, 6.3, 6.4_

  - [x]* 3.2 Write property tests for suspension and traction
    - **Property 5: Suspension compression is well-defined and bounded**
    - **Validates: Requirements 3.2, 3.3, 3.4**
    - **Property 6: Rendered wheel offset reflects compression within tolerance**
    - **Validates: Requirements 3.5**
    - **Property 9: Drive force never exceeds the traction limit**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
    - **Property 10: Surface friction coefficient stays within bounds**
    - **Validates: Requirements 6.5**

  - [x] 3.3 Implement `pitchRollFromQuaternion`
    - Create `src/logic/orientation.ts`
    - Extract pitch and roll (degrees) from a quaternion; ensure always-finite output
    - _Requirements: 8.1_

  - [x]* 3.4 Write property test for orientation extraction
    - **Property 14: Pitch and roll extraction round-trips**
    - **Validates: Requirements 8.1**

- [x] 4. Pure logic — Fuel, balance, and run lifecycle
  - [x] 4.1 Implement fuel and balance reducers
    - Create `src/logic/fuel.ts` with `depleteFuel(fuel, throttle, dt)` and `isThrottleSuppressed(fuel)`
    - Create `src/logic/balance.ts` with `evaluateBalance(state, pitchDeg, rollDeg, dt)`
    - `depleteFuel`: reduces fuel by `FUEL_BURN_RATE * throttle * dt`, clamps to >= 0
    - `evaluateBalance`: accumulates overturn timer when either angle > 75°; resets when both <= 75°; sets overturned after 1.5 s continuous breach
    - _Requirements: 7.2, 7.3, 7.4, 8.2, 8.3_

  - [x]* 4.2 Write property tests for fuel and balance
    - **Property 11: Fuel depletes proportionally and never goes negative**
    - **Validates: Requirements 7.2, 7.3**
    - **Property 12: Empty fuel suppresses throttle force**
    - **Validates: Requirements 7.4**
    - **Property 15: Balance becomes overturned only after sustained threshold breach**
    - **Validates: Requirements 8.2, 8.3**

  - [x] 4.3 Implement run lifecycle reducers
    - Create `src/logic/run-lifecycle.ts`
    - `startRunIfMoving(state, horizontalSpeed, pos)`: transitions idle → running when speed > 0.5 m/s
    - `updateDistance(state, currentPos)`: horizontal Euclidean distance from start
    - `applyEndConditions(state)`: ends run on fuel=0 or overturned
    - `resetRun(startPosition)`: restores initial state
    - _Requirements: 9.1, 9.2, 9.4, 9.5, 9.6_

  - [x]* 4.4 Write property tests for run lifecycle
    - **Property 16: Run end conditions are honored**
    - **Validates: Requirements 8.4, 9.5, 9.6**
    - **Property 17: A run starts when horizontal speed first exceeds the threshold**
    - **Validates: Requirements 9.1**
    - **Property 18: Distance is the horizontal displacement from the start**
    - **Validates: Requirements 9.2**
    - **Property 19: Reset restores the defined initial run state**
    - **Validates: Requirements 9.4**

- [x] 5. Pure logic — HUD projection and LOD state machine
  - [x] 5.1 Implement `toHudView` and `updateLOD`
    - Create `src/logic/hud.ts` with `toHudView(run: RunState): HudView`
    - Create `src/logic/lod.ts` with `updateLOD(state: LODState, fps: number, dt: number): LODState`
    - `toHudView`: rounds fuel to integer [0,100], formats distance to 0.1 m
    - `updateLOD`: reduces level after 2 s below 30 fps; continues reducing per re-evaluation while < 60 fps; raises after 5 s sustained >= 60 fps; clamps [0, 3]
    - _Requirements: 7.5, 9.3, 10.3, 10.4, 10.5, 10.6_

  - [x]* 5.2 Write property tests for HUD and LOD
    - **Property 13: HUD projection bounds fuel and rounds distance**
    - **Validates: Requirements 7.5, 9.3**
    - **Property 21: LOD level adjusts within bounds based on sustained frame rate**
    - **Validates: Requirements 10.3, 10.4, 10.5, 10.6**

- [x] 6. Pure logic — Timestep accumulator and scene-graph validation
  - [x] 6.1 Implement fixed-timestep accumulator and `validateVehicleGraph`
    - Create `src/logic/timestep.ts` with an accumulator function that given elapsed time returns (stepsToRun, remainder, alpha)
    - Create `src/logic/validate-vehicle.ts` with `validateVehicleGraph(root)` that checks for chassis + 4 named wheel nodes
    - _Requirements: 10.2, 1.2, 1.5_

  - [x]* 6.2 Write property tests for timestep and validation
    - **Property 20: Fixed-timestep accumulation is frame-rate independent**
    - **Validates: Requirements 10.2**
    - **Property 1: Vehicle scene-graph validation**
    - **Validates: Requirements 1.2, 1.5**

- [x] 7. Checkpoint — Pure logic complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Physics engine wrapper (Rapier)
  - [x] 8.1 Implement the PhysicsEngine class
    - Create `src/systems/physics-engine.ts`
    - Initialize Rapier world with gravity (0, -9.81, 0)
    - Create chassis rigid body with convex/box collider
    - Create `DynamicRayCastVehicleController` with 4 wheels configured per `WheelConfig`
    - Implement `applyCommand`: map throttle to engine force (suppressed when fuel empty), brake to brake force, steer to wheel steering radians on front wheels
    - Implement `step(dt)`: call `vehicleController.updateVehicle(dt)` then `world.step()`
    - Implement `readState()`: extract chassis transform, per-wheel contact/suspension/traction state, compute pitch/roll
    - Implement `reset(toPosition)`: reposition chassis, zero velocities
    - _Requirements: 3.1, 3.2, 3.3, 4.3, 4.4, 4.5, 6.1, 6.2, 6.4, 6.5, 8.1_

  - [x] 8.2 Create terrain collider from loaded mesh
    - Add method to build trimesh or heightfield collider from Three.js geometry
    - Support per-region friction via material lookup table
    - _Requirements: 4.1, 4.4, 6.5_

- [x] 9. Asset loader
  - [x] 9.1 Implement the AssetLoader class
    - Create `src/systems/asset-loader.ts`
    - Use Three.js `GLTFLoader` + `DRACOLoader` for Draco-compressed GLBs
    - Implement `loadVehicle(url, onProgress)` with 30 s timeout via `Promise.race`
    - Implement `loadTerrain(url, onProgress)` with 30 s timeout
    - Call `validateVehicleGraph` after successful parse; fail load if validation fails
    - Surface progress percentage from GLTFLoader's `onProgress` callback
    - Return typed `LoadResult` with error details (network, timeout, parse, missing-mesh)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.2_

  - [x]* 9.2 Write edge-case tests for asset loader
    - Test timeout rejection after 30 s
    - Test missing-mesh detection (missing chassis, missing any wheel)
    - Test error message identifies the failed/missing asset by name
    - _Requirements: 1.3, 1.5_

- [x] 10. Renderer and wheel synchronization
  - [x] 10.1 Implement the Renderer class
    - Create `src/systems/renderer.ts`
    - Set up Three.js `WebGLRenderer` with WebGL2 context, `Scene`, camera, lights
    - Place vehicle group in scene with wheel meshes as siblings of chassis
    - Implement `renderFrame(interp: InterpolatedState)`: interpolate chassis position/rotation, then for each wheel compute spin, steer, and vertical offset using pure functions
    - Implement `setLOD(level)`: adjust shadow quality, draw distance, mesh detail
    - Implement `measureFps(now)`: sliding-window FPS measurement
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.5, 10.1, 10.3_

  - [x]* 10.2 Write property test for wheel independence
    - **Property 4: Wheel transforms are independent of the chassis**
    - **Validates: Requirements 2.5**

- [x] 11. Terrain generation/loading
  - [x] 11.1 Implement terrain loading and placeholder generation
    - Create `src/systems/terrain.ts`
    - Load terrain GLB via AssetLoader, extract geometry for physics collider
    - Provide a procedural fallback heightfield for development (continuous, gradients 0–45°)
    - Wire terrain visual to scene and physics collider to Rapier world
    - _Requirements: 4.1, 4.2_

  - [x]* 11.2 Write property test for terrain constraints
    - **Property 7: Generated terrain is continuous with bounded gradient**
    - **Validates: Requirements 4.1**

- [x] 12. Input controller
  - [x] 12.1 Implement the InputController class
    - Create `src/systems/input-controller.ts`
    - Map keyboard events (arrow keys / WASD) to normalized `RawInput`
    - Map touch events (virtual joystick / buttons) to normalized `RawInput`
    - Implement `sample()`: read current state, return `RawInput`
    - Pipe through `resolveInput` to get final `DriveCommand`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

- [x] 13. Checkpoint — Systems complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Game loop and run lifecycle wiring
  - [x] 14.1 Implement the GameLoop orchestrator
    - Create `src/game-loop.ts`
    - Implement fixed-timestep accumulator using `src/logic/timestep.ts`
    - Each tick: sample input → resolve → check fuel suppression → apply command to physics → step physics → read state → evaluate balance → deplete fuel → update distance → apply end conditions → check run start
    - Compute interpolation alpha for renderer
    - Call renderer with interpolated state
    - Call HUD update with `toHudView`
    - Call LOD update with measured FPS
    - Handle reset command: call `resetRun` + physics reset
    - Use `requestAnimationFrame` for the render loop
    - _Requirements: 7.1, 7.2, 7.4, 8.2, 8.4, 9.1, 9.2, 9.4, 9.5, 9.6, 10.2_

- [x] 15. HUD overlay
  - [x] 15.1 Implement the HUD renderer
    - Create `src/systems/hud.ts`
    - Render fuel bar/number (integer 0–100), distance display, run status
    - Show end-of-run summary (distance to 0.1 m + end reason) within 1 s of run end
    - Use DOM overlay or canvas-based HUD above the WebGL canvas
    - _Requirements: 7.5, 9.3_

- [x] 16. LOD performance controller wiring
  - [x] 16.1 Wire LOD state machine to renderer
    - Create `src/systems/lod-controller.ts`
    - Each frame: measure FPS → call `updateLOD` → if level changed, call `renderer.setLOD(newLevel)`
    - _Requirements: 10.3, 10.4, 10.5, 10.6_

- [x] 17. Checkpoint — Full game loop functional
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. Asset authoring and acquisition
  - [x] 18.1 Create or acquire vehicle GLB asset
    - Author or source a high-poly car model with chassis >= 20,000 triangles and each wheel >= 5,000 triangles
    - Ensure separate named nodes: `chassis`, `wheel_FL`, `wheel_FR`, `wheel_RL`, `wheel_RR`
    - Set each wheel origin to hub center with axle on local X axis
    - Export as GLB with Draco compression enabled
    - Place in `public/assets/vehicle.glb`
    - _Requirements: 1.1, 1.2_

  - [x] 18.2 Create or acquire terrain GLB asset
    - Author or source a continuous hilly terrain mesh with gradients 0–45°
    - Export as GLB with Draco compression
    - Place in `public/assets/terrain.glb`
    - _Requirements: 4.1_

- [x] 19. Integration and smoke tests
  - [x]* 19.1 Write integration tests for physics + terrain
    - Test per-frame collision detection produces contact for all 4 wheels on terrain
    - Test at-rest settling keeps wheel penetration <= 0.01 m
    - Test end-to-end driving session with suspension/traction/slip coherence
    - _Requirements: 4.4, 4.5, 6.1_

  - [x]* 19.2 Write smoke tests for shipped assets and configuration
    - Verify vehicle GLB loads with chassis >= 20,000 tris, each wheel >= 5,000 tris, all 5 nodes present
    - Verify suspension config: restLength > 0, stiffness > 0, damping >= 0, all finite
    - Verify gravity is (0, -9.81, 0)
    - _Requirements: 1.1, 3.1, 4.3_

- [x] 20. Final wiring and entry point
  - [x] 20.1 Create application entry point and bootstrap
    - Create `src/main.ts` as Vite entry point
    - Implement bootstrap sequence: init Rapier WASM → show loading overlay → load vehicle + terrain → validate → init physics engine → init renderer → init input → start game loop
    - Handle fatal errors (WASM init failure, asset failures) with user-facing messages
    - Create `index.html` with canvas container and HUD overlay mount
    - _Requirements: 1.3, 1.4, 4.2_

  - [x] 20.2 Wire loading UI (progress indicator and error display)
    - Show percentage progress bar during asset loading
    - Switch to error panel on failure, naming the failed asset
    - Provide retry affordance on error
    - Remove loading indicator only after all meshes validated and in scene graph
    - _Requirements: 1.3, 1.4, 1.5_

- [x] 21. Final checkpoint — Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design's Correctness Properties section (Properties 1–21)
- Unit tests validate specific examples and edge cases
- The pure logic layer (tasks 2–6) is testable without a browser, GPU, or WASM runtime
- Integration tests (task 19) require Rapier WASM and are heavier; run them separately
- Asset authoring (task 18) can proceed in parallel with systems implementation

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.3", "3.1", "3.3", "4.1", "4.3", "5.1", "6.1"] },
    { "id": 3, "tasks": ["2.2", "2.4", "3.2", "3.4", "4.2", "4.4", "5.2", "6.2"] },
    { "id": 4, "tasks": ["8.1", "9.1", "12.1", "18.1", "18.2"] },
    { "id": 5, "tasks": ["8.2", "9.2", "10.1", "11.1"] },
    { "id": 6, "tasks": ["10.2", "11.2"] },
    { "id": 7, "tasks": ["14.1", "15.1", "16.1"] },
    { "id": 8, "tasks": ["20.1", "20.2"] },
    { "id": 9, "tasks": ["19.1", "19.2"] }
  ]
}
```
