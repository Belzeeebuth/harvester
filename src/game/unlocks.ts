import type { GameConfig } from '../config';
import type { Balance } from '../config/gameplay/schemas';
import { PET_CATALOG } from './pets';
import { levelRewardCoins, levelRewardGems } from './xp';

/**
 * Déblocages par niveau, dérivés de la configuration.
 *
 * Aucune liste écrite à la main : cultures, animaux, bâtiments, recettes,
 * objets achetables et fonctionnalités à seuil (`trade.minLevel`,
 * `coop.creationMinLevel`…) sont lus dans le catalogue et l'équilibrage. Un
 * contenu ajouté ou un seuil modifié apparaît donc tout seul dans le message
 * de montée de niveau, dans `/help` et dans les messages de blocage.
 */

export type UnlockKind = 'crop' | 'animal' | 'building' | 'building_tier' | 'recipe' | 'item' | 'pet' | 'feature';

/** Fonctionnalités dont l'accès dépend du niveau du joueur. */
export type FeatureKey =
  | 'trade'
  | 'gift'
  | 'coop_create'
  | 'fishing'
  | 'mining'
  | 'black_market'
  | 'prestige'
  | 'bank_tier';

export interface LevelGatedFeature {
  key: FeatureKey;
  level: number;
  emoji: string;
  /** Commande slash associée, sans la barre oblique. */
  command: string;
  /** Palier (banque). */
  tier?: number;
}

export interface Unlock {
  kind: UnlockKind;
  key: string;
  level: number;
  emoji: string;
  /** Nom déjà localisé (catalogue) ; absent pour `pet` et `feature`, résolus par l'affichage. */
  name?: string;
  /** Palier (bâtiments, banque). */
  tier?: number;
  /** Commande (fonctionnalités). */
  command?: string;
}

/** Catalogue minimal nécessaire au calcul : un `GameConfig` localisé convient. */
export type UnlockCatalog = Pick<
  GameConfig,
  'balance' | 'cropList' | 'animalList' | 'buildingList' | 'recipeList' | 'itemList'
>;

/** Seuils des fonctionnalités, lus dans l'équilibrage. */
export function levelGatedFeatures(balance: Balance): LevelGatedFeature[] {
  const features: LevelGatedFeature[] = [
    { key: 'trade', level: balance.trade.minLevel, emoji: '🤝', command: 'trade' },
    { key: 'gift', level: balance.economy.giftMinLevel, emoji: '🎁', command: 'gift' },
    { key: 'coop_create', level: balance.coop.creationMinLevel, emoji: '🏘️', command: 'coop create' },
    { key: 'fishing', level: balance.fishing.unlockLevel, emoji: '🎣', command: 'fish' },
    { key: 'mining', level: balance.mining.unlockLevel, emoji: '⛏️', command: 'mine' },
    { key: 'black_market', level: balance.blackMarket.minLevel, emoji: '🕶️', command: 'black-market' },
    { key: 'prestige', level: balance.prestige.requiredLevel, emoji: '🌟', command: 'prestige' },
  ];
  for (const tier of balance.bank.tiers) {
    if (tier.tier > 1 && tier.requiredLevel > 1) {
      features.push({ key: 'bank_tier', level: tier.requiredLevel, emoji: '🏦', command: 'bank', tier: tier.tier });
    }
  }
  return features;
}

/** Niveau de déblocage d'une fonctionnalité (le premier palier pour la banque). */
export function featureLevel(balance: Balance, key: FeatureKey): number {
  const feature = levelGatedFeatures(balance).find((entry) => entry.key === key);
  return feature?.level ?? 1;
}

/**
 * Objets explicites achetables (outils, consommables, matériaux) : graines et
 * récoltes sont déjà couvertes par les cultures, poissons et minerais par la
 * pêche et la mine.
 */
function isBuyableItem(item: UnlockCatalog['itemList'][number]): boolean {
  if (item.category === 'seed' || item.category === 'harvest') return false;
  return item.basePrice > 0 || item.priceGems > 0;
}

/** Tout ce qui se débloque aux niveaux `levels` (ordre : par niveau, puis par type). */
export function unlocksAtLevels(catalog: UnlockCatalog, levels: Iterable<number>): Unlock[] {
  const wanted = new Set(levels);
  if (wanted.size === 0) return [];
  const unlocks: Unlock[] = [];

  for (const crop of catalog.cropList) {
    if (crop.enabled && wanted.has(crop.requiredLevel)) {
      unlocks.push({ kind: 'crop', key: crop.key, level: crop.requiredLevel, emoji: crop.emoji, name: crop.name });
    }
  }
  for (const animal of catalog.animalList) {
    if (animal.enabled && wanted.has(animal.requiredLevel)) {
      unlocks.push({ kind: 'animal', key: animal.key, level: animal.requiredLevel, emoji: animal.emoji, name: animal.name });
    }
  }
  for (const building of catalog.buildingList) {
    if (!building.enabled) continue;
    if (wanted.has(building.requiredLevel)) {
      unlocks.push({
        kind: 'building',
        key: building.key,
        level: building.requiredLevel,
        emoji: building.emoji,
        name: building.name,
      });
    }
    for (const tier of building.tiers) {
      if (tier.tier > 1 && wanted.has(tier.requiredLevel)) {
        unlocks.push({
          kind: 'building_tier',
          key: building.key,
          level: tier.requiredLevel,
          emoji: building.emoji,
          name: building.name,
          tier: tier.tier,
        });
      }
    }
  }
  for (const recipe of catalog.recipeList) {
    if (recipe.enabled && wanted.has(recipe.requiredLevel)) {
      unlocks.push({ kind: 'recipe', key: recipe.key, level: recipe.requiredLevel, emoji: recipe.emoji, name: recipe.name });
    }
  }
  for (const item of catalog.itemList) {
    if (item.enabled && isBuyableItem(item) && wanted.has(item.requiredLevel)) {
      unlocks.push({ kind: 'item', key: item.key, level: item.requiredLevel, emoji: item.emoji, name: item.name });
    }
  }
  for (const pet of PET_CATALOG) {
    if (wanted.has(pet.unlockLevel)) {
      unlocks.push({ kind: 'pet', key: pet.key, level: pet.unlockLevel, emoji: pet.emoji });
    }
  }
  for (const feature of levelGatedFeatures(catalog.balance)) {
    if (wanted.has(feature.level)) {
      unlocks.push({
        kind: 'feature',
        key: feature.key,
        level: feature.level,
        emoji: feature.emoji,
        command: feature.command,
        ...(feature.tier !== undefined ? { tier: feature.tier } : {}),
      });
    }
  }

  return unlocks.sort((a, b) => a.level - b.level);
}

/** Déblocages obtenus en passant du niveau `from` (exclu) au niveau `to` (inclus). */
export function unlocksBetween(catalog: UnlockCatalog, from: number, to: number): Unlock[] {
  const levels: number[] = [];
  for (let level = Math.max(1, from + 1); level <= to; level += 1) levels.push(level);
  return unlocksAtLevels(catalog, levels);
}

/**
 * Prochain niveau (strictement au-dessus de `level`) qui débloque quelque
 * chose, avec son contenu. `null` au-delà du dernier déblocage.
 */
export function nextUnlock(catalog: UnlockCatalog, level: number): { level: number; unlocks: Unlock[] } | null {
  const maxLevel = catalog.balance.progression.maxLevel;
  for (let candidate = level + 1; candidate <= maxLevel; candidate += 1) {
    const unlocks = unlocksAtLevels(catalog, [candidate]);
    if (unlocks.length > 0) return { level: candidate, unlocks };
  }
  return null;
}

/**
 * Récompenses de palier versées par `grantXp()` pour les niveaux franchis
 * entre `from` (exclu) et `to` (inclus). Même formule, donc même total.
 */
export function levelRewardsBetween(balance: Balance, from: number, to: number): { coins: number; gems: number } {
  let coins = 0;
  let gems = 0;
  for (let level = Math.max(1, from + 1); level <= to; level += 1) {
    coins += levelRewardCoins(level, balance);
    gems += levelRewardGems(level, balance);
  }
  return { coins, gems };
}
