import type { Balance, CropConfig } from '../config/gameplay/schemas';
import type { FarmModifiers } from './modifiers';
import { NEUTRAL_MODIFIERS } from './modifiers';

/**
 * ---------------------------------------------------------------------------
 * CROISSANCE CALCULÉE À LA LECTURE (« timestamp-based growth »)
 * ---------------------------------------------------------------------------
 * Rien ne « pousse » en base. À la plantation on fige `plantedAt` et `readyAt`,
 * et l'état visible est déduit du temps écoulé au moment où le joueur regarde.
 *
 * Pourquoi c'est le bon choix à l'échelle d'un bot Discord :
 *  1. COÛT NUL POUR LES INACTIFS. Un tick global devrait parcourir toutes les
 *     parcelles de tous les joueurs. À 100 000 fermes × 25 parcelles, une mise à
 *     jour par minute = 2,5 M d'UPDATE/minute, soit ~42 000 écritures/seconde
 *     pour un jeu où 95 % des fermes ne sont pas regardées dans l'heure.
 *     Ici, une ferme qui dort coûte exactement zéro.
 *  2. ROBUSTESSE. Un scheduler en retard, un redémarrage, une panne Redis n'ont
 *     aucun effet sur la progression : le temps réel est la seule source de
 *     vérité. Pas de « j'ai perdu 20 minutes de pousse pendant la maintenance ».
 *  3. SCALABILITÉ HORIZONTALE. Aucun état partagé à synchroniser entre shards :
 *     n'importe quel process peut répondre, le calcul est déterministe.
 *  4. TESTABILITÉ. `computeGrowth(crop, planted, now)` est une fonction pure ;
 *     on injecte `now` et on vérifie chaque stade sans attendre.
 *
 * Ce que les jobs font quand même, parce que ce sont des ÉVÉNEMENTS et non de la
 * progression : apparition de nuisibles, flétrissement définitif, notifications
 * DM, décroissance matérialisée des animaux (pour pouvoir les faire mourir).
 */

export type GrowthStage = 'planted' | 'sprouting' | 'growing' | 'maturing' | 'ready' | 'withered';

/** Cinq stades visuels, utilisés par le renderer pour choisir le sprite. */
export const GROWTH_STAGES: readonly GrowthStage[] = [
  'planted',
  'sprouting',
  'growing',
  'maturing',
  'ready',
];

export interface PlantedCropState {
  cropKey: string;
  plantedAt: Date;
  readyAt: Date;
  growthSeconds: number;
  withersAt: Date | null;
  waterNeeded: number;
  waterGiven: number;
  missedWaterings: number;
  nextWaterAt: Date | null;
  withered: boolean;
  regrowRemaining: number;
  harvestCount: number;
}

export interface GrowthState {
  stage: GrowthStage;
  /** 0 → 1. Atteint 1 quand la culture est prête. */
  progress: number;
  ready: boolean;
  withered: boolean;
  msRemaining: number;
  readyAt: Date;
  withersAt: Date | null;
  /** Un arrosage est attendu maintenant. */
  needsWater: boolean;
  /** Arrosages ratés cumulés (chaque manque coûte du rendement). */
  missedWaterings: number;
  nextWaterAt: Date | null;
}

export interface GrowthContext {
  /** Saison courante du monde. */
  season: string;
  /** Multiplicateur de vitesse issu de la météo du jour. */
  weatherGrowthModifier: number;
  modifiers: FarmModifiers;
  balance: Balance;
}

/**
 * Durée de pousse effective, modificateurs appliqués.
 *
 * Ordre de composition (documenté car il change le résultat) :
 *   durée = base
 *         ÷ (multiplicateur de vitesse des bonus)     ← coop, potion, événement
 *         ÷ (multiplicateur météo)                    ← canicule accélère
 *         × (1 + malus hors-saison)                   ← sauf serre
 * On divise pour les accélérations et multiplie pour les pénalités, de sorte
 * qu'un multiplicateur de 2 divise réellement le temps par deux.
 */
export function effectiveGrowthSeconds(
  crop: CropConfig,
  context: GrowthContext,
  baseSeconds = crop.growthSeconds,
): number {
  const { modifiers, balance } = context;
  let seconds = baseSeconds;

  seconds /= Math.max(0.05, modifiers.growthMultiplier);
  seconds /= Math.max(0.05, context.weatherGrowthModifier);

  if (!modifiers.seasonImmunity && !crop.seasons.includes(context.season as never)) {
    seconds *= 1 + balance.seasons.offSeasonGrowthPenalty;
    if (context.season === 'winter') {
      seconds *= 1 + balance.seasons.winterExtraPenalty;
    }
  }

  return Math.max(30, Math.round(seconds));
}

/**
 * Instants auxquels un arrosage est attendu.
 * Les arrosages sont répartis uniformément : pour 3 arrosages sur 60 minutes,
 * on attend le joueur à 15, 30 et 45 minutes. Le dernier quart est libre, sinon
 * une culture prête serait encore « à arroser » et l'interface deviendrait
 * contradictoire.
 */
export function wateringTimes(
  plantedAt: Date,
  growthSeconds: number,
  waterNeeded: number,
): Date[] {
  if (waterNeeded <= 0) return [];
  const times: Date[] = [];
  const step = growthSeconds / (waterNeeded + 1);
  for (let index = 1; index <= waterNeeded; index += 1) {
    times.push(new Date(plantedAt.getTime() + step * index * 1_000));
  }
  return times;
}

/**
 * Calcule combien d'arrosages ont été ratés et quand est le prochain.
 * `graceMinutes` évite de punir un joueur qui arrive deux minutes en retard :
 * un jeu qui exige la ponctualité à la seconde n'est pas jouable.
 */
export function computeWaterStatus(
  planted: Pick<PlantedCropState, 'plantedAt' | 'growthSeconds' | 'waterNeeded' | 'waterGiven'>,
  now: Date,
  graceMinutes: number,
): { missed: number; needsWater: boolean; nextWaterAt: Date | null } {
  const times = wateringTimes(planted.plantedAt, planted.growthSeconds, planted.waterNeeded);
  if (times.length === 0) return { missed: 0, needsWater: false, nextWaterAt: null };

  const graceMs = graceMinutes * 60_000;
  let due = 0;
  for (const time of times) {
    if (time.getTime() <= now.getTime()) due += 1;
  }
  let overdue = 0;
  for (const time of times) {
    if (time.getTime() + graceMs <= now.getTime()) overdue += 1;
  }

  const missed = Math.max(0, overdue - planted.waterGiven);
  const needsWater = due > planted.waterGiven;
  const nextTime = times[Math.min(planted.waterGiven, times.length - 1)];
  const nextWaterAt = planted.waterGiven >= times.length ? null : (nextTime ?? null);

  return { missed, needsWater, nextWaterAt };
}

/**
 * Prochain arrosage à venir parmi des cultures, ou `null` si aucune n'en
 * demandera plus. Sert au refus « rien à arroser », qui renvoyait vers `/farm`
 * sans que `/farm` affiche l'heure du prochain arrosage.
 */
export function nextWateringAt(
  crops: ReadonlyArray<Pick<PlantedCropState, 'plantedAt' | 'growthSeconds' | 'waterNeeded' | 'waterGiven'>>,
  now: Date,
): Date | null {
  let next: Date | null = null;
  for (const crop of crops) {
    const at = computeWaterStatus(crop, now, 0).nextWaterAt;
    if (!at || at.getTime() <= now.getTime()) continue;
    if (!next || at.getTime() < next.getTime()) next = at;
  }
  return next;
}

/**
 * État de croissance à l'instant `now`. Fonction pure, cœur du moteur.
 */
export function computeGrowth(
  planted: PlantedCropState,
  now: Date,
  graceMinutes = 20,
): GrowthState {
  const water = computeWaterStatus(planted, now, graceMinutes);

  const total = Math.max(1, planted.readyAt.getTime() - planted.plantedAt.getTime());
  const elapsed = now.getTime() - planted.plantedAt.getTime();
  const progress = Math.min(1, Math.max(0, elapsed / total));
  const ready = now.getTime() >= planted.readyAt.getTime();
  const withered =
    planted.withered ||
    (planted.withersAt !== null && now.getTime() >= planted.withersAt.getTime());

  let stage: GrowthStage;
  if (withered) {
    stage = 'withered';
  } else if (ready) {
    stage = 'ready';
  } else if (progress < 0.25) {
    stage = 'planted';
  } else if (progress < 0.5) {
    stage = 'sprouting';
  } else if (progress < 0.8) {
    stage = 'growing';
  } else {
    stage = 'maturing';
  }

  return {
    stage,
    progress,
    ready: ready && !withered,
    withered,
    msRemaining: Math.max(0, planted.readyAt.getTime() - now.getTime()),
    readyAt: planted.readyAt,
    withersAt: planted.withersAt,
    needsWater: !ready && !withered && water.needsWater,
    missedWaterings: Math.max(planted.missedWaterings, water.missed),
    nextWaterAt: water.nextWaterAt,
  };
}

/**
 * Délai avant flétrissement après maturité.
 * Proportionnel à la durée de pousse (25 %), avec un plancher de 2 h et un
 * plafond de 48 h : une culture de 5 minutes ne doit pas mourir en 75 secondes,
 * et l'arbre-monde (36 h) ne doit pas rester récoltable une semaine.
 */
export function witherDelaySeconds(growthSeconds: number): number {
  return Math.min(172_800, Math.max(7_200, Math.round(growthSeconds * 0.25)));
}

/**
 * Prépare les champs d'une plantation. Utilisé par `FarmService.plant()` et par
 * la repousse — un seul endroit décide de `readyAt`, donc pas de divergence
 * possible entre premier cycle et repousses.
 */
export function planCrop(
  crop: CropConfig,
  context: GrowthContext,
  now: Date,
  options: { regrow?: boolean; extraWaterMultiplier?: number } = {},
): {
  readyAt: Date;
  growthSeconds: number;
  withersAt: Date;
  waterNeeded: number;
  nextWaterAt: Date | null;
} {
  const baseSeconds =
    options.regrow && crop.regrowSeconds > 0 ? crop.regrowSeconds : crop.growthSeconds;
  const growthSeconds = effectiveGrowthSeconds(crop, context, baseSeconds);
  const readyAt = new Date(now.getTime() + growthSeconds * 1_000);
  const withersAt = new Date(readyAt.getTime() + witherDelaySeconds(growthSeconds) * 1_000);
  const waterNeeded = Math.max(
    0,
    Math.round(crop.waterRequired * (options.extraWaterMultiplier ?? 1)),
  );
  const times = wateringTimes(now, growthSeconds, waterNeeded);
  return {
    readyAt,
    growthSeconds,
    withersAt,
    waterNeeded,
    nextWaterAt: times[0] ?? null,
  };
}

/** Contexte neutre, pratique pour les tests et les prévisualisations. */
export function neutralContext(balance: Balance, season = 'spring'): GrowthContext {
  return {
    season,
    weatherGrowthModifier: 1,
    modifiers: { ...NEUTRAL_MODIFIERS },
    balance,
  };
}
