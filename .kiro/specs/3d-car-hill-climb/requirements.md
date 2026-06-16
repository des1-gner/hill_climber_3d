# Requirements Document

## Introduction

This document defines the requirements for a 3D car hill-climbing game. The game presents a high-resolution 3D vehicle that the player drives across uneven, hilly terrain using throttle, brake, and steering controls. The vehicle responds to gravity, traction, and suspension physics. Wheels spin and steer independently of the chassis, and suspension compression is visually reflected on the vehicle model. The game tracks a resource (fuel) and a balance state typical of hill-climb games, and reports run outcomes to the player.

The game is a browser-based application. The agreed technology stack is captured in the Assumptions and Constraints section and treated as a project constraint rather than a behavioral requirement.

## Glossary

- **Game**: The complete browser-based 3D car hill-climbing application, including rendering, physics, input handling, and game state management.
- **Renderer**: The subsystem responsible for drawing 3D scenes to the screen each frame.
- **Physics_Engine**: The subsystem responsible for simulating rigid-body dynamics, vehicle dynamics, gravity, and collisions.
- **Vehicle**: The player-controlled car, composed of a chassis and four wheels, simulated as a raycast vehicle.
- **Chassis**: The rigid body of the Vehicle that the wheels attach to.
- **Wheel**: One of four rotating components of the Vehicle that contact the Terrain and transmit traction and steering.
- **Suspension**: The simulated spring-and-damper system connecting each Wheel to the Chassis.
- **Terrain**: The 3D hilly ground surface the Vehicle drives over.
- **Input_Controller**: The subsystem that maps player keyboard or touch input to throttle, brake, and steering commands.
- **Throttle**: A player command that applies forward driving force to the driven Wheels.
- **Brake**: A player command that applies decelerating force to the Wheels.
- **Steering**: A player command that changes the heading angle of the steerable Wheels.
- **Fuel**: A depletable numeric resource that the Vehicle consumes while the Throttle is applied.
- **Balance_State**: The orientation status of the Vehicle, classified as upright or overturned based on the Chassis pitch and roll angles.
- **Run**: A single play session that begins when the Vehicle starts moving and ends when a terminal condition (out of Fuel, overturned, or player reset) is reached.
- **Asset_Loader**: The subsystem responsible for loading 3D model assets before gameplay begins.
- **HUD**: The on-screen heads-up display showing Fuel level, distance traveled, and Run status.
- **Frame**: A single rendering and simulation update cycle.

## Assumptions and Constraints

- **Constraint**: THE Game SHALL be implemented in TypeScript.
- **Constraint**: THE Renderer SHALL use Three.js for 3D rendering.
- **Constraint**: THE Physics_Engine SHALL use Rapier (compiled to WebAssembly) configured with a raycast-vehicle setup.
- **Constraint**: THE Game SHALL use Vite as the build and development tooling.
- **Constraint**: THE Vehicle and Terrain models SHALL be authored in Blender and delivered as glTF/GLB assets with Draco compression.
- **Assumption**: React Three Fiber and Drei MAY be used as an optional rendering layer; their use is not required by these requirements.
- **Assumption**: The game targets modern desktop browsers with WebGL2 and WebAssembly support; mobile touch support is a secondary target.

## Requirements

### Requirement 1: High-Resolution Vehicle Model

**User Story:** As a player, I want a detailed, high-resolution car, so that the game feels visually polished and realistic.

#### Acceptance Criteria

1. WHEN the Game starts, THE Asset_Loader SHALL load the Vehicle model from a Draco-compressed glTF/GLB asset, where the Chassis mesh contains at least 20,000 triangles and each Wheel mesh contains at least 5,000 triangles.
2. THE Vehicle model SHALL be composed of exactly one Chassis mesh and exactly four separate Wheel meshes, each exposed as an individually named node in the scene graph that is selectable and transformable independently.
3. IF the Vehicle model fails to load OR loading does not complete within 30 seconds of the load request, THEN THE Asset_Loader SHALL display an error message identifying the failed asset by name, SHALL retain any previously loaded state without entering gameplay, and SHALL halt entry into gameplay.
4. WHILE the Vehicle model is loading, THE Game SHALL display a loading indicator showing load progress as a percentage from 0 to 100, and SHALL remove the indicator only after all required Chassis and Wheel meshes are loaded and available in the scene graph.
5. IF a loaded Vehicle model is missing the Chassis mesh or any of the four Wheel meshes, THEN THE Asset_Loader SHALL treat the load as failed, SHALL display an error message identifying the missing mesh, and SHALL halt entry into gameplay.

### Requirement 2: Wheel Rotation and Steering Visualization

**User Story:** As a player, I want the wheels to spin and turn realistically, so that the car's motion looks believable.

#### Acceptance Criteria

1. WHILE the Vehicle is moving, THE Renderer SHALL rotate each Wheel mesh about its axle axis at an angular velocity equal to the Wheel's linear ground speed divided by the Wheel radius, updated each rendered Frame.
2. WHILE the Vehicle is moving in reverse, THE Renderer SHALL rotate each Wheel mesh about its axle axis in the direction opposite to its forward-motion rotation.
3. WHEN the player applies Steering input, THE Renderer SHALL rotate the steerable Wheel meshes about their vertical steering axis to match the commanded steering angle, clamped within the range -45 to +45 degrees, synchronized to the commanded angle within 100 milliseconds.
4. IF a commanded steering angle is received outside the range -45 to +45 degrees, THEN THE Renderer SHALL clamp the rendered steering angle to the nearest in-range bound.
5. THE Renderer SHALL render each Wheel mesh as a transform independent of the Chassis mesh so that Wheel rotation does not rotate the Chassis.
6. WHILE the Vehicle's linear ground speed is 0 and no Throttle is applied, THE Renderer SHALL hold each Wheel mesh at a constant rotation angle with zero angular change between consecutive Frames.

### Requirement 3: Suspension Physics and Visualization

**User Story:** As a player, I want the car's suspension to compress and extend over bumps, so that driving over hills feels dynamic.

#### Acceptance Criteria

1. THE Physics_Engine SHALL model each Wheel's Suspension as a spring-and-damper configured per Wheel with a rest length greater than 0.0 metres, a stiffness greater than 0.0, and a damping coefficient greater than or equal to 0.0, all defined as finite values.
2. WHEN a Wheel contacts the Terrain, THE Physics_Engine SHALL compute that Wheel's Suspension compression along the suspension axis as the difference between the Suspension rest length and the measured Wheel contact distance, clamped to a non-negative value greater than or equal to 0.0 metres.
3. IF a Wheel is not in contact with the Terrain, THEN THE Physics_Engine SHALL set that Wheel's Suspension to its maximum travel limit (full extension).
4. THE Physics_Engine SHALL constrain each Wheel's Suspension compression to remain within its defined minimum and maximum travel limits, holding the value at the nearest limit when a computed value falls outside the range.
5. WHEN a Wheel's Suspension compression changes, THE Renderer SHALL offset that Wheel mesh's vertical position relative to the Chassis on the next rendered Frame to reflect the current compression within a tolerance of 0.001 metres.

### Requirement 4: Hill-Climb Terrain and Gravity

**User Story:** As a player, I want to drive over uneven hilly ground, so that the climb is challenging.

#### Acceptance Criteria

1. WHEN a Run begins, THE Renderer SHALL display Terrain whose surface elevation varies continuously with no vertical discontinuities and with local surface gradients ranging from 0 degrees (flat) to 45 degrees (steepest climbable incline).
2. IF the Terrain fails to load when a Run begins, THEN THE Renderer SHALL halt Run start and present an error indication that Terrain loading failed, retaining the prior game state.
3. THE Physics_Engine SHALL apply a constant downward gravitational acceleration of 9.81 metres per second squared to the Vehicle on each Frame.
4. WHEN each Frame is processed, THE Physics_Engine SHALL evaluate collision detection between each of the Vehicle's four Wheels and the Terrain surface.
5. WHILE the Vehicle rests on the Terrain with a linear speed below 0.05 metres per second and no Throttle or Brake is applied, THE Physics_Engine SHALL constrain the Vehicle so that no Wheel penetrates the Terrain surface by more than 0.01 metres.

### Requirement 5: Throttle, Brake, and Steering Controls

**User Story:** As a player, I want to control acceleration, braking, and steering, so that I can drive the car through the terrain.

#### Acceptance Criteria

1. WHEN the player issues a Throttle command with a normalized input magnitude in the range 0.0 to 1.0, THE Input_Controller SHALL direct the Physics_Engine to apply forward driving force to the driven Wheels proportional to the input magnitude, where 0.0 applies zero force and 1.0 applies the configured maximum driving force.
2. WHEN the player issues a Brake command with a normalized input magnitude in the range 0.0 to 1.0, THE Input_Controller SHALL direct the Physics_Engine to apply decelerating force to the Wheels proportional to the input magnitude, where 0.0 applies zero force and 1.0 applies the configured maximum braking force.
3. WHEN the player issues a Steering command, THE Input_Controller SHALL set the steering angle of the steerable Wheels to a value clamped within the range -35 degrees to +35 degrees, where negative values steer left and positive values steer right.
4. WHEN the player releases all control inputs, THE Input_Controller SHALL set Throttle force to zero, Brake force to zero, and Steering angle to zero.
5. WHILE the game simulation is running, THE Input_Controller SHALL sample and process player input once per rendered Frame, within 16.7 milliseconds of the prior sample at 60 frames per second.
6. IF the player simultaneously issues both a Throttle command and a Brake command, THEN THE Input_Controller SHALL apply the Brake command and suppress the forward driving force for that Frame.
7. IF a control input value is received outside the range 0.0 to 1.0 for Throttle or Brake, or outside -35 degrees to +35 degrees for Steering, THEN THE Input_Controller SHALL clamp the value to the nearest in-range bound before directing the Physics_Engine.

### Requirement 6: Traction

**User Story:** As a player, I want the car to grip or slip based on the surface and slope, so that the climb requires skill.

#### Acceptance Criteria

1. WHEN the Throttle is applied and a driven Wheel is in contact with the Terrain, THE Physics_Engine SHALL transmit driving force through that Wheel's contact point up to the available traction limit, where the available traction limit equals the product of the Surface friction coefficient at that contact point and the normal force at that contact point, and the normal force is derived from the vehicle weight resolved against the Terrain slope at that contact point.
2. IF the driving force demanded at a Wheel contact point exceeds the available traction limit, THEN THE Physics_Engine SHALL cap the transmitted driving force at the available traction limit.
3. IF the driving force demanded at a Wheel contact point exceeds the available traction limit, THEN THE Physics_Engine SHALL allow that Wheel to slip such that the Wheel's contact-point surface speed exceeds the vehicle's forward speed along the Terrain by more than 5 percent.
4. WHILE a driven Wheel has no Terrain contact, THE Physics_Engine SHALL transmit zero driving force through that Wheel.
5. WHEN computing a driven Wheel's available traction limit, THE Physics_Engine SHALL apply the Surface friction coefficient assigned to the Terrain surface at that contact point, where each Surface friction coefficient is a value between 0.05 and 1.50 inclusive.

### Requirement 7: Fuel Mechanic

**User Story:** As a player, I want a fuel resource that depletes as I drive, so that I must manage throttle use during the climb.

#### Acceptance Criteria

1. WHEN a Run begins, THE Game SHALL set Fuel to a starting amount of 100 Fuel units.
2. WHILE the Throttle is applied, THE Game SHALL decrease Fuel at a rate of 5 Fuel units per second scaled linearly by the Throttle input value (0.0 to 1.0), measured against simulation time elapsed since the previous Frame.
3. IF a Fuel decrease would result in a value below 0 Fuel units, THEN THE Game SHALL clamp Fuel to 0 Fuel units.
4. WHEN Fuel reaches 0 Fuel units, THE Game SHALL apply 0 Throttle driving force for the remainder of the Run, regardless of Throttle input.
5. WHILE a Run is active, THE HUD SHALL display the current Fuel level, expressed as an integer from 0 to 100, updated each Frame.

### Requirement 8: Balance and Overturn Detection

**User Story:** As a player, I want the car to be able to flip over, so that maintaining balance on steep slopes is part of the challenge.

#### Acceptance Criteria

1. THE Physics_Engine SHALL compute the Chassis pitch angle and roll angle, each expressed in degrees relative to the horizontal ground plane, every simulation Frame.
2. WHEN the Chassis roll angle exceeds 75 degrees from horizontal, or the Chassis pitch angle exceeds 75 degrees from horizontal, continuously for at least 1.5 seconds, THE Game SHALL set the Balance_State to overturned.
3. WHILE the Chassis roll angle remains at or below 75 degrees from horizontal and the Chassis pitch angle remains at or below 75 degrees from horizontal, THE Game SHALL set the Balance_State to upright.
4. WHEN the Balance_State becomes overturned, THE Game SHALL end the current Run within 0.5 seconds.

### Requirement 9: Run Lifecycle and Outcome Reporting

**User Story:** As a player, I want to see how far I got and be able to restart, so that I can track progress and try again.

#### Acceptance Criteria

1. WHEN the Vehicle's horizontal speed first exceeds 0.5 metres per second from a stationary start, THE Game SHALL begin a Run and record the Vehicle's current position as the Run start position.
2. WHILE a Run is active, THE Game SHALL update the horizontal distance traveled by the Vehicle from the Run start position, measured in metres, once per rendered Frame.
3. WHEN a Run ends, THE Game SHALL display the total horizontal distance traveled rounded to the nearest 0.1 metres and the reason the Run ended as one of out of fuel, Vehicle overturned, or player reset, within 1 second of the Run ending.
4. WHEN the player issues a reset command, THE Game SHALL end any active Run, return the Vehicle to the start position, restore Fuel to the defined starting amount, set the Balance_State to upright, and reset the tracked horizontal distance traveled to zero.
5. IF the Vehicle's Fuel reaches zero WHILE a Run is active, THEN THE Game SHALL end the Run.
6. IF the Balance_State becomes overturned WHILE a Run is active, THEN THE Game SHALL end the Run.

### Requirement 10: Rendering Performance

**User Story:** As a player, I want smooth gameplay, so that controlling the car feels responsive.

#### Acceptance Criteria

1. WHILE gameplay is active, THE Renderer SHALL render the scene at an average rate of at least 60 Frames per second measured over any 1 second sliding window on the target desktop hardware.
2. THE Physics_Engine SHALL advance the simulation using a fixed time step of 16.67 milliseconds (1/60 second) that remains constant and independent of the rendering Frame rate.
3. IF the rendering Frame rate falls below 30 Frames per second for more than 2 continuous seconds, THEN THE Game SHALL reduce the active visual detail level by one predefined step and re-evaluate the Frame rate over the following 2 seconds.
4. WHILE the rendering Frame rate remains below 60 Frames per second after a visual detail reduction, THE Game SHALL continue reducing the active visual detail level by one step per re-evaluation window until the rate reaches at least 60 Frames per second or the lowest detail level is reached.
5. WHILE the active visual detail level is at its lowest setting and the Frame rate remains below 30 Frames per second, THE Game SHALL make no further visual detail reductions.
6. IF the rendering Frame rate sustains at least 60 Frames per second for more than 5 continuous seconds and the active visual detail level is below its highest setting, THEN THE Game SHALL increase the active visual detail level by one step.
