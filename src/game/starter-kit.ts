import type { CropConfig } from '../config/gameplay/schemas';
import type { SeasonName } from './world';

/**
 * Premier pas du joueur : sac de départ et suggestions de saison.
 *
 * Le sac était figé (blé et carotte) : en hiver, aucune des deux n'est de
 * saison, et la toute première récolte du joueur tombait sous le malus hors
 * saison. Le sac suit désormais la saison du moment : les cultures de niveau 1
 * de saison d'abord, puis, s'il en manque, la culture de saison la plus
 * accessible au-dessus (plantable dès le niveau 2, soit une ou deux récoltes).
 */

export interface StarterSeed {
  cropKey: string;
  quantity: number;
}

/** Quantités du sac, dans l'ordre des sortes de graines (même total qu'avant : 15). */
export const STARTER_SEED_QUANTITIES = [10, 5] as const;

/** Niveau maximal d'une graine « de complément » quand le niveau 1 n'offre qu'une sorte de saison. */
const STARTER_FALLBACK_MAX_LEVEL = 2;

function byLevelThenOrder(a: CropConfig, b: CropConfig): number {
  return a.requiredLevel - b.requiredLevel || a.sortOrder - b.sortOrder;
}

/** Graines du sac de départ pour la saison donnée. */
export function starterKitFor(season: SeasonName, crops: readonly CropConfig[]): StarterSeed[] {
  const enabled = crops.filter((crop) => crop.enabled && crop.seedPrice > 0);
  const inSeason = enabled.filter((crop) => crop.seasons.includes(season)).sort(byLevelThenOrder);

  const kinds = inSeason.filter((crop) => crop.requiredLevel <= 1);
  if (kinds.length < STARTER_SEED_QUANTITIES.length) {
    kinds.push(
      ...inSeason.filter(
        (crop) => crop.requiredLevel > 1 && crop.requiredLevel <= STARTER_FALLBACK_MAX_LEVEL,
      ),
    );
  }
  // Filet de sécurité : aucune culture de saison accessible (configuration
  // exotique). On retombe sur les cultures de niveau 1, de saison ou non, pour
  // que le joueur ait toujours de quoi semer.
  if (kinds.length === 0) {
    kinds.push(...enabled.filter((crop) => crop.requiredLevel <= 1).sort(byLevelThenOrder));
  }

  return kinds.slice(0, STARTER_SEED_QUANTITIES.length).map((crop, index) => ({
    cropKey: crop.key,
    quantity: STARTER_SEED_QUANTITIES[index] ?? STARTER_SEED_QUANTITIES[0],
  }));
}

/**
 * Cultures de saison qu'un joueur peut planter à son niveau, les plus avancées
 * d'abord (ce sont les plus rentables). Sert au conseil affiché quand une
 * plantation tombe hors saison, à la place de la serre de niveau 24.
 */
export function inSeasonCropsFor(
  season: SeasonName,
  level: number,
  crops: readonly CropConfig[],
  limit = 3,
): CropConfig[] {
  return crops
    .filter((crop) => crop.enabled && crop.requiredLevel <= level && crop.seasons.includes(season))
    .sort((a, b) => b.requiredLevel - a.requiredLevel || a.sortOrder - b.sortOrder)
    .slice(0, limit);
}
