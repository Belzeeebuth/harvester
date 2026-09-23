import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import {
  featureLevel,
  levelGatedFeatures,
  levelRewardsBetween,
  nextUnlock,
  unlocksAtLevels,
  unlocksBetween,
  type UnlockCatalog,
} from '../src/game/unlocks';
import { levelRewardCoins, levelRewardGems } from '../src/game/xp';
import { levelUpField, mergeLevelUps } from '../src/framework/levelup';
import { translatorFor } from '../src/i18n';

/**
 * Déblocages par niveau : tout vient de la configuration, rien n'est listé à
 * la main. Ces tests croisent le calcul avec les valeurs réelles de
 * l'équilibrage et du catalogue, puis avec un petit catalogue synthétique.
 */

const config = getConfig('fr');
const balance = config.balance;

describe('fonctionnalités à seuil', () => {
  it('lit chaque seuil dans l\'équilibrage', () => {
    expect(featureLevel(balance, 'trade')).toBe(balance.trade.minLevel);
    expect(featureLevel(balance, 'coop_create')).toBe(balance.coop.creationMinLevel);
    expect(featureLevel(balance, 'fishing')).toBe(balance.fishing.unlockLevel);
    expect(featureLevel(balance, 'mining')).toBe(balance.mining.unlockLevel);
    expect(featureLevel(balance, 'black_market')).toBe(balance.blackMarket.minLevel);
    expect(featureLevel(balance, 'gift')).toBe(balance.economy.giftMinLevel);
    expect(featureLevel(balance, 'prestige')).toBe(balance.prestige.requiredLevel);
  });

  it('suit un seuil modifié sans rien réécrire', () => {
    const tweaked = { ...balance, fishing: { ...balance.fishing, unlockLevel: 3 } };
    expect(levelGatedFeatures(tweaked).find((feature) => feature.key === 'fishing')?.level).toBe(3);
  });

  it('annonce la pêche, la mine et la coopérative au bon niveau', () => {
    const atFishing = unlocksAtLevels(config, [balance.fishing.unlockLevel]);
    expect(atFishing.some((unlock) => unlock.kind === 'feature' && unlock.key === 'fishing')).toBe(true);
    const atCoop = unlocksAtLevels(config, [balance.coop.creationMinLevel]);
    expect(atCoop.some((unlock) => unlock.kind === 'feature' && unlock.key === 'coop_create')).toBe(true);
  });
});

describe('contenu débloqué', () => {
  it('reprend les cultures, animaux, bâtiments et recettes du catalogue', () => {
    const all = unlocksBetween(config, 1, balance.progression.maxLevel);
    for (const crop of config.cropList.filter((entry) => entry.enabled && entry.requiredLevel > 1)) {
      expect(all.some((unlock) => unlock.kind === 'crop' && unlock.key === crop.key), crop.key).toBe(true);
    }
    for (const animal of config.animalList.filter((entry) => entry.enabled && entry.requiredLevel > 1)) {
      expect(all.some((unlock) => unlock.kind === 'animal' && unlock.key === animal.key), animal.key).toBe(true);
    }
    for (const recipe of config.recipeList.filter((entry) => entry.enabled && entry.requiredLevel > 1)) {
      expect(all.some((unlock) => unlock.kind === 'recipe' && unlock.key === recipe.key), recipe.key).toBe(true);
    }
  });

  it('ne compte ni graines ni récoltes comme objets (déjà couvertes par les cultures)', () => {
    const all = unlocksBetween(config, 0, balance.progression.maxLevel);
    const items = all.filter((unlock) => unlock.kind === 'item');
    expect(items.some((unlock) => unlock.key.startsWith('seed_'))).toBe(false);
    for (const unlock of items) {
      expect(config.items.get(unlock.key)?.category).not.toBe('harvest');
    }
  });

  it('borne l\'intervalle : niveau de départ exclu, niveau d\'arrivée inclus', () => {
    const level = balance.coop.creationMinLevel;
    expect(unlocksBetween(config, level, level)).toEqual([]);
    const crossed = unlocksBetween(config, level - 1, level);
    expect(crossed.length).toBeGreaterThan(0);
    expect(crossed.every((unlock) => unlock.level === level)).toBe(true);
  });

  it('trie par niveau quand plusieurs niveaux sont franchis', () => {
    const levels = unlocksBetween(config, 1, 12).map((unlock) => unlock.level);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it('trouve le prochain palier notable', () => {
    const next = nextUnlock(config, 1);
    expect(next).not.toBeNull();
    expect(next!.level).toBeGreaterThan(1);
    expect(next!.unlocks.length).toBeGreaterThan(0);
    expect(nextUnlock(config, balance.progression.maxLevel)).toBeNull();
  });
});

describe('catalogue synthétique', () => {
  const catalog = {
    balance,
    cropList: [
      { key: 'wheat', name: 'Blé', emoji: '🌾', requiredLevel: 1, enabled: true },
      { key: 'corn', name: 'Maïs', emoji: '🌽', requiredLevel: 3, enabled: true },
      { key: 'ghost', name: 'Fantôme', emoji: '👻', requiredLevel: 3, enabled: false },
    ],
    animalList: [{ key: 'cow', name: 'Vache', emoji: '🐄', requiredLevel: 3, enabled: true }],
    buildingList: [
      {
        key: 'barn',
        name: 'Étable',
        emoji: '🏚️',
        requiredLevel: 2,
        enabled: true,
        tiers: [
          { tier: 1, requiredLevel: 2 },
          { tier: 2, requiredLevel: 3 },
        ],
      },
    ],
    recipeList: [],
    itemList: [
      { key: 'hoe', name: 'Houe', emoji: '⛏️', category: 'tool', basePrice: 100, priceGems: 0, requiredLevel: 3, enabled: true },
      { key: 'fish_x', name: 'Poisson', emoji: '🐟', category: 'fish', basePrice: 0, priceGems: 0, requiredLevel: 3, enabled: true },
    ],
  } as unknown as UnlockCatalog;

  it('liste exactement ce qui s\'ouvre au niveau 3', () => {
    const keys = unlocksAtLevels(catalog, [3])
      .filter((unlock) => unlock.kind !== 'feature' && unlock.kind !== 'pet')
      .map((unlock) => `${unlock.kind}:${unlock.key}${unlock.tier ? `#${unlock.tier}` : ''}`);
    expect(keys.sort()).toEqual(['animal:cow', 'building_tier:barn#2', 'crop:corn', 'item:hoe']);
  });

  it('ignore le contenu désactivé et les objets non achetables', () => {
    const keys = unlocksAtLevels(catalog, [3]).map((unlock) => unlock.key);
    expect(keys).not.toContain('ghost');
    expect(keys).not.toContain('fish_x');
  });
});

describe('récompenses de palier', () => {
  it('reprend exactement la formule de grantXp', () => {
    let coins = 0;
    let gems = 0;
    for (let level = 4; level <= 7; level += 1) {
      coins += levelRewardCoins(level, balance);
      gems += levelRewardGems(level, balance);
    }
    expect(levelRewardsBetween(balance, 3, 7)).toEqual({ coins, gems });
    expect(levelRewardsBetween(balance, 5, 5)).toEqual({ coins: 0, gems: 0 });
  });
});

describe('bloc de montée de niveau', () => {
  const t = translatorFor('fr');

  it('ne produit rien sans montée de niveau', () => {
    expect(levelUpField(null, t, 'fr')).toBeNull();
    expect(levelUpField({ level: 4, levelsGained: 0 }, t, 'fr')).toBeNull();
  });

  it('cite la récompense et les déblocages du niveau atteint', () => {
    const level = balance.fishing.unlockLevel;
    const field = levelUpField({ level, levelsGained: 1 }, t, 'fr');
    expect(field).not.toBeNull();
    expect(field!.name).toContain(String(level));
    expect(field!.value).toContain('/fish');
    expect(field!.value.length).toBeLessThanOrEqual(1024);
    // Aucune clé brute ni paramètre non résolu.
    expect(field!.value).not.toMatch(/levelup\.|\{[a-z]+\}/);
  });

  it('cumule les montées de plusieurs réclamations', () => {
    expect(mergeLevelUps([null, { level: 5, levelsGained: 1 }, { level: 7, levelsGained: 2 }])).toEqual({
      level: 7,
      levelsGained: 3,
    });
    expect(mergeLevelUps([null, undefined])).toBeNull();
  });
});
