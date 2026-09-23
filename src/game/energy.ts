import type { Balance } from '../config/gameplay/schemas';

/**
 * Système d'énergie, calculé à la lecture (aucun job de régénération).
 *
 * On stocke `energy` + `energyUpdatedAt`, et l'énergie courante est
 * `min(max, energy + minutesÉcoulées × regen)`. Même raisonnement que pour la
 * croissance : zéro écriture pour les joueurs inactifs, aucune dérive possible.
 *
 * Rôle de l'énergie dans le design : c'est un limitateur DOUX de session. À 100
 * points et 1 point/minute, un joueur peut faire ~70 actions d'affilée puis doit
 * revenir plus tard — ce qui correspond exactement au format visé (sessions de
 * 2-5 minutes, plusieurs fois par jour) sans jamais bloquer une session normale.
 * Le système est désactivable (`ENERGY_SYSTEM_ENABLED=false`) car certains
 * serveurs préfèrent le jeu libre.
 */

export interface EnergyState {
  energy: number;
  energyMax: number;
  energyUpdatedAt: Date;
}

export interface EnergyProjection {
  current: number;
  max: number;
  /** Instant où l'énergie sera pleine (null si déjà pleine). */
  fullAt: Date | null;
  /** Minutes avant le prochain point d'énergie. */
  minutesToNextPoint: number;
  /**
   * Ancre de régénération : l'instant où `current` a été atteint exactement.
   * Stocker `current` avec cette ancre (plutôt qu'avec `now`) conserve la
   * fraction de minute déjà écoulée ; sinon chaque action la perdait.
   * Vaut `now` quand l'énergie est pleine (rien ne s'accumule au-delà).
   */
  anchor: Date;
}

export function projectEnergy(
  state: EnergyState,
  now: Date,
  balance: Balance,
): EnergyProjection {
  if (!balance.energy.enabled) {
    return { current: state.energyMax, max: state.energyMax, fullAt: null, minutesToNextPoint: 0, anchor: now };
  }

  const elapsedMs = Math.max(0, now.getTime() - state.energyUpdatedAt.getTime());
  const regen = balance.energy.regenPerMinute;
  const raw = state.energy + (elapsedMs / 60_000) * regen;
  if (regen <= 0 || raw >= state.energyMax) {
    const current = Math.min(state.energyMax, Math.floor(raw));
    return {
      current,
      max: state.energyMax,
      fullAt: null,
      minutesToNextPoint: 0,
      anchor: current >= state.energyMax ? now : state.energyUpdatedAt,
    };
  }

  const current = Math.floor(raw);
  // Fraction de point déjà accumulée, convertie en temps écoulé depuis que
  // `current` a été atteint.
  const fractionMs = ((raw - current) / regen) * 60_000;
  const anchor = new Date(now.getTime() - fractionMs);
  const missing = state.energyMax - current;

  return {
    current,
    max: state.energyMax,
    fullAt: new Date(anchor.getTime() + (missing / regen) * 60_000),
    minutesToNextPoint: Math.max(0, (1 / regen) - fractionMs / 60_000),
    anchor,
  };
}

/** Coût en énergie d'une action, après réduction par les outils. */
export function energyCost(
  action: string,
  balance: Balance,
  costReduction = 0,
  quantity = 1,
): number {
  if (!balance.energy.enabled) return 0;
  const base = balance.energy.costs[action] ?? balance.energy.costs.default ?? 1;
  const reduced = base * quantity * (1 - Math.min(0.75, Math.max(0, costReduction)));
  // Une action coûte toujours au moins 1 point si elle a un coût de base.
  return base === 0 ? 0 : Math.max(1, Math.round(reduced));
}

export function hasEnergy(projection: EnergyProjection, cost: number): boolean {
  return projection.current >= cost;
}

/**
 * Ancre à stocker avec la nouvelle valeur : on garde la fraction de minute déjà
 * régénérée, sauf si l'énergie repart d'un plein (aucune fraction à conserver).
 */
function nextAnchor(projection: EnergyProjection, now: Date): Date {
  if (projection.current >= projection.max) return now;
  return projection.anchor.getTime() <= now.getTime() ? projection.anchor : now;
}

/** Nouvel état après consommation (la fraction de régénération en cours est conservée). */
export function spendEnergy(
  projection: EnergyProjection,
  cost: number,
  now: Date,
): { energy: number; energyUpdatedAt: Date } {
  return {
    energy: Math.max(0, projection.current - Math.max(0, cost)),
    energyUpdatedAt: nextAnchor(projection, now),
  };
}

/** Nouvel état après restauration (jus d'énergie, gemmes, montée de niveau). */
export function restoreEnergy(
  projection: EnergyProjection,
  amount: number,
  now: Date,
): { energy: number; energyUpdatedAt: Date } {
  const energy = Math.min(projection.max, projection.current + Math.max(0, amount));
  return {
    energy,
    // Remplie à ras bord : la fraction en cours n'a plus de sens.
    energyUpdatedAt: energy >= projection.max ? now : nextAnchor(projection, now),
  };
}
