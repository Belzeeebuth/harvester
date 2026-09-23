import type { Balance, CropConfig } from '../config/gameplay/schemas';
import { directSellPrice } from './market';
import { scaleMoney } from './money';
import type { FarmModifiers } from './modifiers';
import {
  mutationEffects,
  qualityMultiplier,
  qualityScore,
  rollMutation,
  rollQuality,
  type Mutation,
  type Quality,
} from './quality';
import type { Rng } from './rng';

/**
 * Calcul du résultat d'une récolte. C'est la fonction la plus sensible du jeu :
 * elle décide combien de valeur entre dans l'économie. Elle est donc PURE,
 * entièrement paramétrée, et couverte par des tests qui figent la graine du RNG.
 *
 * Chaîne de calcul du rendement (l'ordre est significatif) :
 *   rendement = rendementDeBase
 *             × facteurFertilité      (0,55 à 1,15)
 *             × (1 − malusArrosage)   (0 à 0,40)
 *             × (1 − malusHerbes)     (0 à 0,30)
 *             × (1 − dégâtsMétéo)     (0 à 1,00)
 *             × facteurSaison         (0,65 / 1,00 / 1,20)
 *             × modificateurMétéo     (0,80 à 1,10)
 *             × (1 + engrais)         (0 à 0,25)
 *             × (1 + aide des voisins)(0 à 0,12)
 *             × multiplicateurBonus   (coop, prestige, abeilles…)
 *             + rendementPlat         (outils)
 *             × multiplicateurMutation(1,0 / 1,5 / 2,5)
 * puis arrondi au plus proche, avec un plancher de 1 unité : une parcelle
 * récoltée ne rend JAMAIS zéro, sinon le joueur a l'impression d'un bug.
 */

export interface HarvestInput {
  crop: CropConfig;
  /** Fertilité de la parcelle avant récolte (0-100). */
  fertility: number;
  /** Niveau de mauvaises herbes (0-100). */
  weedLevel: number;
  /** Arrosages manqués sur le cycle. */
  missedWaterings: number;
  /** Malus de dégâts accumulé (orage, gel, nuisibles ignorés) — 0 à 1. */
  damagePenalty: number;
  /** Bonus multiplicatif apporté par l'engrais appliqué. */
  fertilizerBoost: number;
  /** Bonus de qualité apporté par l'engrais appliqué. */
  fertilizerQualityBoost: number;
  /** Nombre de joueurs ayant aidé sur cette parcelle. */
  helpers: number;
  /** Saison courante. */
  season: string;
  /** Multiplicateur de rendement de la météo du jour. */
  weatherYieldModifier: number;
  /** Niveau du joueur. */
  level: number;
  modifiers: FarmModifiers;
  /** Prix unitaire courant au marché pour cette récolte. */
  marketUnitPrice: number;
  /** Multiplicateur de mutation apporté par l'événement en cours. */
  eventMutationMultiplier?: number;
  /** Multiplicateur de prix apporté par l'événement en cours. */
  eventPriceMultiplier?: number;
  balance: Balance;
  rng: Rng;
}

export interface HarvestBreakdown {
  baseYield: number;
  fertilityFactor: number;
  waterPenalty: number;
  weedPenalty: number;
  damagePenalty: number;
  seasonFactor: number;
  weatherFactor: number;
  fertilizerFactor: number;
  helpFactor: number;
  bonusMultiplier: number;
  flatYield: number;
  mutationYieldMultiplier: number;
}

export interface HarvestResult {
  quantity: number;
  quality: Quality;
  mutation: Mutation;
  /** Valeur unitaire estimée (prix marché × qualité × mutation). */
  unitValue: number;
  /** Valeur totale du lot, avant taxe de vente. */
  totalValue: number;
  xp: number;
  /** Fertilité de la parcelle après la récolte. */
  fertilityAfter: number;
  /** La grainerie a-t-elle rendu la graine ? */
  seedRecovered: boolean;
  breakdown: HarvestBreakdown;
}

/**
 * Facteur de fertilité, linéaire par morceaux entre trois points d'ancrage :
 * sol épuisé (0 → 0,55), sol normal (70 → 1,00), sol optimal (100 → 1,15).
 * Le point d'ancrage à 70 est la fertilité de départ d'une parcelle : un joueur
 * qui ne fait rien reste à un rendement de référence, celui qui néglige son sol
 * perd jusqu'à 45 %, celui qui l'entretient gagne 15 %.
 */
export function fertilityFactor(fertility: number, balance: Balance): number {
  const config = balance.fertility;
  const clamped = Math.min(100, Math.max(0, fertility));
  const floorFactor = 1 - config.yieldPenaltyAtZero;
  const anchor = config.start;

  if (clamped <= anchor) {
    return floorFactor + ((1 - floorFactor) * clamped) / Math.max(1, anchor);
  }
  const span = Math.max(1, 100 - anchor);
  return 1 + (config.yieldBonusAtMax * (clamped - anchor)) / span;
}

export function waterPenalty(missedWaterings: number, balance: Balance): number {
  return Math.min(
    balance.water.maxPenalty,
    Math.max(0, missedWaterings) * balance.water.penaltyPerMissedWatering,
  );
}

export function weedPenalty(weedLevel: number, balance: Balance): number {
  const config = balance.weeds;
  if (weedLevel <= config.penaltyThreshold) return 0;
  const span = Math.max(1, 100 - config.penaltyThreshold);
  return Math.min(
    config.yieldPenaltyAtMax,
    (config.yieldPenaltyAtMax * (weedLevel - config.penaltyThreshold)) / span,
  );
}

/**
 * Facteur de saison. Une culture plantée dans sa saison favorable gagne 20 %,
 * hors saison elle perd 35 % (et 10 % de plus en hiver). La serre annule la
 * PÉNALITÉ hors saison, jamais le bonus : elle renvoyait 1 dans tous les cas,
 * si bien qu'une culture de saison rendait 20 % de moins sous serre qu'à l'air
 * libre. D'où `max(facteur normal, 1)`.
 */
export function seasonFactor(
  crop: CropConfig,
  season: string,
  modifiers: FarmModifiers,
  balance: Balance,
): number {
  let factor: number;
  if (crop.seasons.includes(season as never)) {
    factor = 1 + balance.seasons.inSeasonYieldBonus;
  } else {
    factor = 1 - balance.seasons.offSeasonYieldPenalty;
    if (season === 'winter') factor *= 1 - balance.seasons.winterExtraPenalty;
  }
  return modifiers.seasonImmunity ? Math.max(factor, 1) : factor;
}

export function computeHarvest(input: HarvestInput): HarvestResult {
  const { crop, balance, rng, modifiers } = input;

  const breakdown: HarvestBreakdown = {
    baseYield: crop.baseYield,
    fertilityFactor: fertilityFactor(input.fertility, balance),
    waterPenalty: waterPenalty(input.missedWaterings, balance),
    weedPenalty: weedPenalty(input.weedLevel, balance),
    damagePenalty: Math.min(1, Math.max(0, input.damagePenalty)),
    seasonFactor: seasonFactor(crop, input.season, modifiers, balance),
    weatherFactor: Math.max(0.1, input.weatherYieldModifier),
    fertilizerFactor: 1 + Math.max(0, input.fertilizerBoost),
    helpFactor:
      1 +
      Math.min(
        balance.water.maxHelpBonus,
        Math.max(0, input.helpers) * balance.water.helpBonusPerHelper,
      ),
    bonusMultiplier: modifiers.yieldMultiplier,
    flatYield: modifiers.flatYield,
    mutationYieldMultiplier: 1,
  };

  const mutation = rollMutation(
    crop,
    { luck: modifiers.luck, eventMultiplier: input.eventMutationMultiplier ?? 1 },
    balance,
    rng,
  );
  const mutationEffect = mutationEffects(mutation, balance);
  breakdown.mutationYieldMultiplier = mutationEffect.yieldMultiplier;

  let quantity =
    breakdown.baseYield *
    breakdown.fertilityFactor *
    (1 - breakdown.waterPenalty) *
    (1 - breakdown.weedPenalty) *
    (1 - breakdown.damagePenalty) *
    breakdown.seasonFactor *
    breakdown.weatherFactor *
    breakdown.fertilizerFactor *
    breakdown.helpFactor *
    breakdown.bonusMultiplier;

  quantity += breakdown.flatYield;
  quantity *= breakdown.mutationYieldMultiplier;

  // Dégâts totaux (1.0) = récolte perdue : c'est le seul cas où l'on rend 0.
  const finalQuantity =
    breakdown.damagePenalty >= 1 ? 0 : Math.max(1, Math.round(quantity));

  const score = qualityScore(
    crop,
    {
      fertility: input.fertility,
      level: input.level,
      fertilizerQualityBoost: input.fertilizerQualityBoost,
      qualityBonus: modifiers.qualityBonus,
      luck: modifiers.luck,
    },
    balance,
  );
  const quality = finalQuantity > 0 ? rollQuality(score, balance, rng) : 'normal';

  // La valeur affichée doit refléter ce que `/sell` paiera réellement : même
  // décote de vente directe et même multiplicateur d'événement que le marché,
  // sinon l'estimation à la récolte et le montant reçu à la vente divergent.
  const unitValue = scaleMoney(
    directSellPrice(input.marketUnitPrice, balance),
    qualityMultiplier(quality, balance) *
      mutationEffect.priceMultiplier *
      (input.eventPriceMultiplier ?? 1) *
      (1 + modifiers.sellBonus),
  );

  // XP : proportionnelle à la culture, majorée par la qualité obtenue (récompense
  // l'optimisation) et par les multiplicateurs d'XP (coop, prestige, événement).
  const qualityXpBonus = { normal: 1, silver: 1.1, gold: 1.25, iridium: 1.5 }[quality];
  // De l'XP, pas de la monnaie : `Math.round` est légitime ici.
  const baseXp = crop.xpReward;
  const xp = Math.max(1, Math.round(baseXp * qualityXpBonus * modifiers.xpMultiplier));

  const fertilityAfter = Math.max(
    balance.fertility.min,
    input.fertility - crop.fertilityCost,
  );

  return {
    quantity: finalQuantity,
    quality,
    mutation,
    unitValue,
    totalValue: unitValue * finalQuantity,
    xp,
    fertilityAfter,
    seedRecovered: modifiers.seedRecoveryChance > 0 && rng.chance(modifiers.seedRecoveryChance),
    breakdown,
  };
}

/**
 * Rendement moyen attendu, sans tirage aléatoire.
 * Utilisé par `/crops` (affichage « rendement moyen ») et par le rapport
 * d'équilibrage : on veut comparer les cultures sans dépendre du hasard.
 */
export function expectedYield(
  crop: CropConfig,
  input: Pick<HarvestInput, 'fertility' | 'season' | 'modifiers' | 'balance'>,
): number {
  const { balance, modifiers } = input;
  const quantity =
    crop.baseYield *
    fertilityFactor(input.fertility, balance) *
    seasonFactor(crop, input.season, modifiers, balance) *
    modifiers.yieldMultiplier +
    modifiers.flatYield;
  return Math.max(1, Math.round(quantity));
}
