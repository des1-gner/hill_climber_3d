// Damage system — speed/impact-based vehicle damage with a health pool.
//
// The car has a health value (0..100) that decreases when it hits obstacles.
// Damage depends on the speed at impact and the type of object hit. The physics
// engine reports the chassis speed, and the game loop feeds impacts from trees,
// stones, debris, and animals. The HUD renders a health bar from this state.
//
// Objects can also be "uprooted" (destroyed) on a hard-enough hit, which costs
// extra damage. The caller decides whether the impact qualifies; this module
// just applies the formula and tracks health.

/** Types of collidable world objects the car can hit. */
export type ImpactSource = 'tree' | 'stone' | 'debris' | 'animal';

/** Damage multiplier per impact source. Trees hurt more than loose debris. */
const SOURCE_MULTIPLIER: Record<ImpactSource, number> = {
  tree: 1.4,
  stone: 1.0,
  debris: 0.7,
  animal: 0.3,
};

/**
 * Impact speed (m/s) below which no damage is dealt (a gentle bump). Above
 * this, damage scales linearly with speed.
 */
const DAMAGE_SPEED_THRESHOLD = 3.5;

/**
 * Speed (m/s) above which the object gets "uprooted" (removed/destroyed) on
 * impact. Uprooting costs extra damage on top of the base collision damage.
 */
const UPROOT_SPEED_THRESHOLD = 11;

/** Extra damage fraction added when an object is uprooted (0..1 → 0..100 hp). */
const UPROOT_EXTRA_DAMAGE = 8;

/** Linear damage scale: damage per (m/s above threshold) at multiplier 1.0. */
const DAMAGE_PER_MPS = 2.2;

export interface DamageState {
  health: number; // 0..100
}

/** A fresh, undamaged state. */
export function initialDamageState(): DamageState {
  return { health: 100 };
}

export interface ImpactResult {
  damage: number; // HP lost (0 if below threshold)
  uprooted: boolean; // Whether the object should be destroyed/removed
  newState: DamageState;
}

/**
 * Compute damage from a collision.
 *
 * @param state  Current damage state.
 * @param speed  Car horizontal speed at the moment of impact (m/s).
 * @param source What type of object was hit.
 * @returns Updated state + how much damage was dealt + whether the object is
 *          uprooted (caller removes it from the world).
 */
export function applyImpact(
  state: DamageState,
  speed: number,
  source: ImpactSource,
): ImpactResult {
  if (speed < DAMAGE_SPEED_THRESHOLD) {
    return { damage: 0, uprooted: false, newState: state };
  }

  const excess = speed - DAMAGE_SPEED_THRESHOLD;
  let damage = excess * DAMAGE_PER_MPS * SOURCE_MULTIPLIER[source];

  const uprooted = speed >= UPROOT_SPEED_THRESHOLD;
  if (uprooted) {
    damage += UPROOT_EXTRA_DAMAGE;
  }

  const health = Math.max(0, state.health - damage);
  return { damage, uprooted, newState: { health } };
}

/** Whether the vehicle is totalled (health reached 0). */
export function isDestroyed(state: DamageState): boolean {
  return state.health <= 0;
}
