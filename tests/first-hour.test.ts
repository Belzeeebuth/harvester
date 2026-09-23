import { beforeAll, describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig } from '../src/config';
import { nextWateringAt } from '../src/game/growth';
import { batchCount } from '../src/game/planting';
import { inSeasonCropsFor, starterKitFor } from '../src/game/starter-kit';
import { seasonAt } from '../src/game/world';
import { normalizeLookup, resolveLookup } from '../src/utils/lookup';
import type { ShopEntry } from '../src/services/market.service';

/**
 * Première heure de jeu : graines toujours en vente, plantation partielle,
 * sac de départ de saison, saisie libre de `/sell`, prochain arrosage.
 * Tout est pur : aucun test ne touche la base.
 */

const config = getConfig();
const crops = config.cropList;

describe('sac de départ de saison', () => {
  it("en hiver, donne l'oignon (seul de saison au niveau 1) puis la pomme de terre", () => {
    expect(starterKitFor('winter', crops)).toEqual([
      { cropKey: 'onion', quantity: 10 },
      { cropKey: 'potato', quantity: 5 },
    ]);
  });

  it('au printemps, garde le blé et la carotte', () => {
    expect(starterKitFor('spring', crops)).toEqual([
      { cropKey: 'wheat', quantity: 10 },
      { cropKey: 'carrot', quantity: 5 },
    ]);
  });

  it('ne donne que des graines de saison, deux sortes, 15 graines, quelle que soit la saison', () => {
    for (const season of ['spring', 'summer', 'autumn', 'winter'] as const) {
      const kit = starterKitFor(season, crops);
      expect(kit).toHaveLength(2);
      expect(kit.reduce((sum, seed) => sum + seed.quantity, 0)).toBe(15);
      for (const seed of kit) {
        const crop = config.crops.get(seed.cropKey);
        expect(crop?.seasons).toContain(season);
        expect(crop?.requiredLevel).toBeLessThanOrEqual(2);
      }
      // La première sorte se plante dès le niveau 1.
      expect(config.crops.get(kit[0]!.cropKey)?.requiredLevel).toBe(1);
    }
  });

  it("l'hiver commence le 2026-09-24 et le sac suit", () => {
    const balance = getBalance();
    expect(seasonAt(new Date('2026-09-23T12:00:00Z'), balance).season).toBe('autumn');
    expect(seasonAt(new Date('2026-09-24T12:00:00Z'), balance).season).toBe('winter');
  });

  it('propose des cultures de saison à la portée du joueur, les plus avancées d’abord', () => {
    const winter = inSeasonCropsFor('winter', 7, crops).map((crop) => crop.key);
    expect(winter).toEqual(['broccoli', 'garlic', 'potato']);
    expect(inSeasonCropsFor('winter', 1, crops).map((crop) => crop.key)).toEqual(['onion']);
  });
});

describe('plantation et fertilisation partielles', () => {
  it('plante autant que les graines le permettent au lieu de tout refuser', () => {
    expect(batchCount(9, 5)).toBe(5);
    expect(batchCount(9, 20)).toBe(9);
    expect(batchCount(9, 0)).toBe(0);
  });

  it('respecte la quantité demandée, sans dépasser le stock', () => {
    expect(batchCount(9, 20, 3)).toBe(3);
    expect(batchCount(9, 2, 3)).toBe(2);
    expect(batchCount(0, 10, 3)).toBe(0);
  });
});

describe('saisie libre de /sell, /buy et /plant', () => {
  const candidates = [
    { key: 'seed_wheat', names: ['Graines de blé', 'Wheat seeds'], aliases: ['Blé', 'Wheat'] },
    { key: 'wheat', names: ['Blé', 'Wheat'] },
    { key: 'carrot', names: ['Carotte', 'Carrot'] },
    { key: 'corn', names: ['Maïs', 'Corn'] },
    { key: 'cucumber', names: ['Concombre', 'Cucumber'] },
  ];

  it('normalise casse, accents et espaces', () => {
    expect(normalizeLookup('  Maïs   Doux ')).toBe('mais doux');
  });

  it('accepte la clé, puis le nom français ou anglais', () => {
    expect(resolveLookup('wheat', candidates)).toBe('wheat');
    expect(resolveLookup('Blé', candidates)).toBe('wheat');
    expect(resolveLookup('ble', candidates)).toBe('wheat');
    expect(resolveLookup('WHEAT', candidates)).toBe('wheat');
    expect(resolveLookup('mais', candidates)).toBe('corn');
    expect(resolveLookup('graines de ble', candidates)).toBe('seed_wheat');
  });

  it('préfère le nom affiché à un alias, et ne tranche pas une saisie ambiguë', () => {
    // « Blé » est le nom de la récolte et l'alias de la graine : la récolte l'emporte.
    expect(resolveLookup('Blé', candidates)).toBe('wheat');
    expect(resolveLookup('carot', candidates)).toBe('carrot');
    // « c » commence carotte, concombre et corn : aucun choix.
    expect(resolveLookup('c', candidates)).toBeUndefined();
    expect(resolveLookup('inconnu', candidates)).toBeUndefined();
  });

  it('résout les vrais noms de la configuration', async () => {
    const { resolveCropInput, resolveItemInput } = await import('../src/services/inventory.service');
    expect(resolveItemInput('Blé', (item) => item.sellPrice > 0)).toBe('wheat');
    expect(resolveItemInput('pumpkin', (item) => item.sellPrice > 0)).toBe('pumpkin');
    // Dans `/buy`, la récolte n'est pas achetable : le nom de culture désigne la graine.
    expect(resolveItemInput('Oignon', (item) => item.basePrice + item.priceGems > 0)).toBe('seed_onion');
    expect(resolveCropInput('oignon')).toBe('onion');
    expect(resolveCropInput('Sweet potato')).toBe('sweet_potato');
    // Rien ne correspond : la saisie est rendue telle quelle, pour le refus habituel.
    expect(resolveItemInput('zzz')).toBe('zzz');
  }, 60_000);
});

describe('prochain arrosage', () => {
  const plantedAt = new Date('2026-09-23T10:00:00Z');

  it("donne l'échéance la plus proche parmi les cultures", () => {
    const now = new Date('2026-09-23T10:01:00Z');
    const next = nextWateringAt(
      [
        // 600 s, 1 arrosage : à mi-pousse (10:05).
        { plantedAt, growthSeconds: 600, waterNeeded: 1, waterGiven: 0 },
        // 300 s, 2 arrosages : 10:01:40 et 10:03:20.
        { plantedAt, growthSeconds: 300, waterNeeded: 2, waterGiven: 0 },
      ],
      now,
    );
    expect(next?.toISOString()).toBe('2026-09-23T10:01:40.000Z');
  });

  it("rend null quand plus rien n'attend d'eau", () => {
    const now = new Date('2026-09-23T10:01:00Z');
    expect(nextWateringAt([{ plantedAt, growthSeconds: 600, waterNeeded: 1, waterGiven: 1 }], now)).toBeNull();
    expect(nextWateringAt([], now)).toBeNull();
  });
});

describe('graines en vente permanente', () => {
  let market: typeof import('../src/services/market.service');

  beforeAll(async () => {
    market = await import('../src/services/market.service');
  }, 60_000);

  it('met en vente toutes les cultures actives, à leur prix et leur niveau', () => {
    const permanent = market.permanentSeedCrops(crops);
    expect(permanent).toHaveLength(crops.filter((crop) => crop.enabled).length);
    expect(permanent.length).toBeGreaterThanOrEqual(41);
    expect(permanent.every((crop) => crop.seedPrice > 0)).toBe(true);
  });

  function seedEntry(key: string, requiredLevel: number): ShopEntry {
    return {
      id: key,
      itemKey: `seed_${key}`,
      name: key,
      emoji: '🌱',
      category: 'seeds',
      rarity: 'common',
      price: requiredLevel * 10,
      currency: 'coins',
      discountPercent: 0,
      stockRemaining: market.UNLIMITED_STOCK,
      stockTotal: market.UNLIMITED_STOCK,
      requiredLevel,
      featured: false,
      description: null,
      expiresAt: new Date('2026-09-23T23:59:59Z'),
    };
  }

  it('montre les graines du niveau du joueur et les trois suivantes', () => {
    const all = crops.map((crop) => seedEntry(crop.key, crop.requiredLevel));
    const daily = { ...seedEntry('token', 1), itemKey: 'quest_reroll_token', category: 'daily' };
    const window = market.seedShopWindow([daily, ...all], 5);
    const seeds = window.filter((entry) => entry.category === 'seeds');
    expect(window[0]).toBe(daily);
    expect(seeds.filter((entry) => entry.requiredLevel <= 5)).toHaveLength(
      crops.filter((crop) => crop.requiredLevel <= 5).length,
    );
    expect(seeds.filter((entry) => entry.requiredLevel > 5)).toHaveLength(market.SEED_PREVIEW_LOCKED);
    // Au niveau maximal, les 41 graines sont atteignables.
    expect(market.seedShopWindow(all, 60)).toHaveLength(all.length);
  });

  it('traite le stock permanent comme illimité', () => {
    expect(market.isUnlimitedStock({ stockTotal: market.UNLIMITED_STOCK })).toBe(true);
    expect(market.isUnlimitedStock({ stockTotal: 25 })).toBe(false);
  });
});
