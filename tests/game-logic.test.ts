import { describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig } from '../src/config';
import { addXp, levelFromTotalXp, removeXp, totalXpForLevel, xpForNextLevel } from '../src/game/xp';
import {
  computeGrowth,
  computeWaterStatus,
  effectiveGrowthSeconds,
  planCrop,
  wateringTimes,
  witherDelaySeconds,
} from '../src/game/growth';
import { computeHarvest, fertilityFactor, seasonFactor, waterPenalty, weedPenalty } from '../src/game/harvest';
import { NEUTRAL_MODIFIERS, buildModifiers, clampModifiers } from '../src/game/modifiers';
import { qualityDistribution, qualityScore, rollQuality } from '../src/game/quality';
import { createRng, dailyRng } from '../src/game/rng';
import { coordsToSlot, gridSizeFor, plotUnlockCost, slotToCoords } from '../src/game/grid';
import { assertMoney, feeOf, scaleMoney, totalCost } from '../src/game/money';
import { directSellPrice, minimumBid, referenceVolumeFor, updatePrice } from '../src/game/market';
import { projectAnimal, computeReadyProduction } from '../src/game/animals';
import { rollWeather, seasonAt } from '../src/game/world';
import { addCoopXp, coopBonuses, coopMemberLimit } from '../src/game/coop';
import { checkPrestigeEligibility, planPrestige } from '../src/game/prestige';
import { energyCost, projectEnergy, spendEnergy } from '../src/game/energy';
import {
  eligibleFish,
  isDaytime,
  rollFish,
  rollFishQuality,
  scoreCastTiming,
  timingAccuracy,
  type FishConfig,
} from '../src/game/fishing';
import { eligibleOre, maxDepthForLevel, rollAdvance, rollOre, type OreConfig } from '../src/game/mining';

const balance = getBalance();
const config = getConfig();

describe('courbe d\'expérience', () => {
  it('est strictement croissante', () => {
    for (let level = 1; level < balance.progression.maxLevel - 1; level += 1) {
      expect(xpForNextLevel(level + 1, balance)).toBeGreaterThan(xpForNextLevel(level, balance));
    }
  });

  it('donne 0 XP requis au niveau maximum', () => {
    expect(xpForNextLevel(balance.progression.maxLevel, balance)).toBe(0);
  });

  it('fait progresser le joueur en cascade sur plusieurs niveaux', () => {
    const result = addXp({ level: 1, xp: 0 }, 10_000, balance);
    expect(result.level).toBeGreaterThan(1);
    expect(result.crossedLevels.length).toBe(result.levelsGained);
    // Chaque niveau franchi est listé une seule fois, dans l'ordre.
    expect(result.crossedLevels).toEqual([...result.crossedLevels].sort((a, b) => a - b));
  });

  it('reconstruit le niveau depuis l\'XP cumulée (aller-retour)', () => {
    for (const level of [1, 5, 17, 33, 50, balance.progression.maxLevel]) {
      const total = totalXpForLevel(level, balance);
      expect(levelFromTotalXp(total, balance).level).toBe(level);
    }
  });

  it('removeXp() annule exactement un addXp() de même montant', () => {
    const granted = addXp({ level: 1, xp: 0 }, 50_000, balance);
    const reverted = removeXp({ level: granted.level, xp: granted.xpInLevel }, 50_000, balance);
    expect(reverted.level).toBe(1);
    expect(reverted.xpInLevel).toBe(0);
  });

  it('removeXp() fait redescendre le niveau en cascade sur plusieurs paliers', () => {
    const granted = addXp({ level: 1, xp: 0 }, 500_000, balance);
    expect(granted.level).toBeGreaterThan(10);
    const reverted = removeXp({ level: granted.level, xp: granted.xpInLevel }, 500_000, balance);
    expect(reverted.level).toBe(1);
  });

  it('removeXp() ne descend jamais sous le niveau 1 ni 0 XP', () => {
    const reverted = removeXp({ level: 3, xp: 10 }, 999_999_999, balance);
    expect(reverted.level).toBe(1);
    expect(reverted.xpInLevel).toBe(0);
  });

  it('conserve l\'XP excédentaire au niveau maximum', () => {
    const result = addXp({ level: balance.progression.maxLevel, xp: 0 }, 50_000, balance);
    expect(result.level).toBe(balance.progression.maxLevel);
    expect(result.xpInLevel).toBe(50_000);
    expect(result.isMaxLevel).toBe(true);
  });
});

describe('croissance des cultures', () => {
  const wheat = config.crops.get('wheat')!;
  const context = {
    season: 'summer',
    weatherGrowthModifier: 1,
    modifiers: { ...NEUTRAL_MODIFIERS },
    balance,
  };

  it('accélère la pousse avec un multiplicateur de vitesse', () => {
    const base = effectiveGrowthSeconds(wheat, context);
    const boosted = effectiveGrowthSeconds(wheat, {
      ...context,
      modifiers: { ...NEUTRAL_MODIFIERS, growthMultiplier: 2 },
    });
    expect(boosted).toBeCloseTo(base / 2, 0);
  });

  it('ralentit la pousse hors saison, sauf avec une serre', () => {
    const inSeason = effectiveGrowthSeconds(wheat, { ...context, season: 'summer' });
    const offSeason = effectiveGrowthSeconds(wheat, { ...context, season: 'winter' });
    expect(offSeason).toBeGreaterThan(inSeason);

    const greenhouse = effectiveGrowthSeconds(wheat, {
      ...context,
      season: 'winter',
      modifiers: { ...NEUTRAL_MODIFIERS, seasonImmunity: true },
    });
    expect(greenhouse).toBe(inSeason);
  });

  it('répartit les arrosages uniformément avant la maturité', () => {
    const plantedAt = new Date('2026-07-01T10:00:00Z');
    const times = wateringTimes(plantedAt, 3_600, 3);
    expect(times).toHaveLength(3);
    expect(times[0]!.getTime()).toBe(plantedAt.getTime() + 900_000);
    expect(times[2]!.getTime()).toBeLessThan(plantedAt.getTime() + 3_600_000);
  });

  it('ne compte un arrosage manqué qu\'après le délai de grâce', () => {
    const plantedAt = new Date('2026-07-01T10:00:00Z');
    const planted = { plantedAt, growthSeconds: 3_600, waterNeeded: 1, waterGiven: 0 };

    // À 30 min + 5 min : l'arrosage est dû mais dans le délai de grâce.
    const soon = computeWaterStatus(planted, new Date('2026-07-01T10:35:00Z'), 20);
    expect(soon.needsWater).toBe(true);
    expect(soon.missed).toBe(0);

    // À 30 min + 25 min : au-delà du délai, l'arrosage est raté.
    const late = computeWaterStatus(planted, new Date('2026-07-01T10:55:00Z'), 20);
    expect(late.missed).toBe(1);
  });

  it('traverse les cinq stades puis fane', () => {
    const plantedAt = new Date('2026-07-01T10:00:00Z');
    const state = {
      cropKey: 'wheat',
      plantedAt,
      readyAt: new Date(plantedAt.getTime() + 1_000_000),
      growthSeconds: 1_000,
      withersAt: new Date(plantedAt.getTime() + 2_000_000),
      waterNeeded: 0,
      waterGiven: 0,
      missedWaterings: 0,
      nextWaterAt: null,
      withered: false,
      regrowRemaining: 0,
      harvestCount: 0,
    };

    const stages = [0.1, 0.3, 0.6, 0.9, 1.1, 2.5].map(
      (ratio) => computeGrowth(state, new Date(plantedAt.getTime() + 1_000_000 * ratio)).stage,
    );
    expect(stages).toEqual(['planted', 'sprouting', 'growing', 'maturing', 'ready', 'withered']);
  });

  it('borne le délai de flétrissement entre 2 h et 48 h', () => {
    expect(witherDelaySeconds(60)).toBe(7_200);
    expect(witherDelaySeconds(3_600)).toBe(7_200);
    expect(witherDelaySeconds(1_000_000)).toBe(172_800);
  });

  it('planifie une repousse plus courte que le premier cycle', () => {
    const tomato = config.crops.get('tomato')!;
    const now = new Date('2026-07-01T10:00:00Z');
    const first = planCrop(tomato, context, now);
    const regrow = planCrop(tomato, context, now, { regrow: true });
    expect(regrow.growthSeconds).toBeLessThan(first.growthSeconds);
  });
});

describe('calcul de récolte', () => {
  const wheat = config.crops.get('wheat')!;

  const baseInput = {
    crop: wheat,
    fertility: balance.fertility.start,
    weedLevel: 0,
    missedWaterings: 0,
    damagePenalty: 0,
    fertilizerBoost: 0,
    fertilizerQualityBoost: 0,
    helpers: 0,
    season: 'summer',
    weatherYieldModifier: 1,
    level: 10,
    modifiers: { ...NEUTRAL_MODIFIERS },
    marketUnitPrice: wheat.sellPrice,
    balance,
  };

  it('donne un facteur de fertilité de 1 au sol de départ', () => {
    expect(fertilityFactor(balance.fertility.start, balance)).toBeCloseTo(1, 5);
    expect(fertilityFactor(0, balance)).toBeCloseTo(1 - balance.fertility.yieldPenaltyAtZero, 5);
    expect(fertilityFactor(100, balance)).toBeCloseTo(1 + balance.fertility.yieldBonusAtMax, 5);
  });

  it('plafonne le malus d\'arrosage', () => {
    expect(waterPenalty(100, balance)).toBe(balance.water.maxPenalty);
    expect(waterPenalty(0, balance)).toBe(0);
  });

  it('n\'applique un malus d\'herbes qu\'au-delà du seuil', () => {
    expect(weedPenalty(balance.weeds.penaltyThreshold, balance)).toBe(0);
    expect(weedPenalty(100, balance)).toBeCloseTo(balance.weeds.yieldPenaltyAtMax, 5);
  });

  it('récompense la saison favorable et pénalise l\'hiver', () => {
    const summer = seasonFactor(wheat, 'summer', NEUTRAL_MODIFIERS, balance);
    const winter = seasonFactor(wheat, 'winter', NEUTRAL_MODIFIERS, balance);
    expect(summer).toBeGreaterThan(1);
    expect(winter).toBeLessThan(1);
  });

  it('la serre annule la pénalité hors saison sans retirer le bonus de saison', () => {
    const greenhouse = { ...NEUTRAL_MODIFIERS, seasonImmunity: true };
    expect(seasonFactor(wheat, 'summer', greenhouse, balance)).toBe(
      seasonFactor(wheat, 'summer', NEUTRAL_MODIFIERS, balance),
    );
    expect(seasonFactor(wheat, 'summer', greenhouse, balance)).toBeGreaterThan(1);
    expect(seasonFactor(wheat, 'winter', greenhouse, balance)).toBe(1);
  });

  it('produit toujours au moins une unité quand la culture est saine', () => {
    const result = computeHarvest({
      ...baseInput,
      fertility: 0,
      missedWaterings: 10,
      weedLevel: 100,
      season: 'winter',
      rng: createRng('worst-case'),
    });
    expect(result.quantity).toBeGreaterThanOrEqual(1);
  });

  it('ne rend rien si les dégâts sont totaux', () => {
    const result = computeHarvest({ ...baseInput, damagePenalty: 1, rng: createRng('destroyed') });
    expect(result.quantity).toBe(0);
  });

  it('est déterministe pour une graine donnée', () => {
    const first = computeHarvest({ ...baseInput, rng: createRng('graine-42') });
    const second = computeHarvest({ ...baseInput, rng: createRng('graine-42') });
    expect(second).toEqual(first);
  });

  it('augmente le rendement avec la fertilité et les bonus', () => {
    const poor = computeHarvest({ ...baseInput, fertility: 10, rng: createRng('a') }).quantity;
    const rich = computeHarvest({
      ...baseInput,
      fertility: 100,
      fertilizerBoost: 0.25,
      modifiers: { ...NEUTRAL_MODIFIERS, yieldMultiplier: 1.5 },
      rng: createRng('a'),
    }).quantity;
    expect(rich).toBeGreaterThan(poor);
  });
});

describe('qualité et mutations', () => {
  it('améliore la distribution quand le score monte', () => {
    const low = qualityDistribution(1, balance);
    const high = qualityDistribution(2, balance);
    expect(high.iridium).toBeGreaterThan(low.iridium);
    expect(high.normal).toBeLessThan(low.normal);
  });

  it('somme à 1', () => {
    const distribution = qualityDistribution(1.4, balance);
    const total = distribution.normal + distribution.silver + distribution.gold + distribution.iridium;
    expect(total).toBeCloseTo(1, 10);
  });

  it('garde l\'iridium rare même pour une ferme optimisée', () => {
    const lotus = config.crops.get('star_lotus')!;
    const score = qualityScore(
      lotus,
      { fertility: 100, level: 60, fertilizerQualityBoost: 0.25, qualityBonus: 0.1, luck: 0.6 },
      balance,
    );
    // Moins de 25 % : l'iridium reste un événement, pas la norme.
    expect(qualityDistribution(score, balance).iridium).toBeLessThan(0.25);
  });

  it('tire une qualité valide', () => {
    const quality = rollQuality(1.5, balance, createRng('q'));
    expect(['normal', 'silver', 'gold', 'iridium']).toContain(quality);
  });
});

describe('grille et parcelles', () => {
  it('associe chaque slot à des coordonnées uniques', () => {
    const seen = new Set<string>();
    for (let slot = 1; slot <= balance.plots.maxPlots; slot += 1) {
      const coords = slotToCoords(slot, balance);
      const key = `${coords.x},${coords.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(coordsToSlot(coords.x, coords.y, balance)).toBe(slot);
    }
    expect(seen.size).toBe(balance.plots.maxPlots);
  });

  it('remplit exactement la grille de chaque palier', () => {
    for (const step of balance.plots.gridSteps) {
      for (let slot = 1; slot <= step.plots; slot += 1) {
        const coords = slotToCoords(slot, balance);
        expect(coords.x).toBeLessThan(step.width);
        expect(coords.y).toBeLessThan(step.height);
      }
      const size = gridSizeFor(step.plots, balance);
      expect(size.width * size.height).toBe(step.plots);
    }
  });

  /**
   * Le test ci-dessus ne vérifiait QUE les bornes exactes des paliers, et c'est
   * précisément par là que le défaut est passé : entre deux paliers,
   * `gridSizeFor` renvoyait la grille du palier précédent alors que
   * `slotToCoords` plaçait déjà les nouvelles parcelles dans le palier suivant.
   * Le renderer sautait donc les parcelles hors grille — payées, invisibles.
   */
  it('garde toute parcelle débloquée à l\'intérieur de la grille, y compris entre deux paliers', () => {
    for (let unlocked = 1; unlocked <= balance.plots.maxPlots; unlocked += 1) {
      const grid = gridSizeFor(unlocked, balance);
      for (let slot = 1; slot <= unlocked; slot += 1) {
        const coords = slotToCoords(slot, balance);
        expect(
          coords.x < grid.width && coords.y < grid.height,
          `parcelle ${slot} hors de la grille ${grid.width}×${grid.height} ` +
            `pour ${unlocked} parcelles débloquées`,
        ).toBe(true);
      }
    }
  });

  it('ne fait jamais rétrécir la grille quand on débloque une parcelle', () => {
    let previous = gridSizeFor(1, balance);
    for (let unlocked = 2; unlocked <= balance.plots.maxPlots; unlocked += 1) {
      const grid = gridSizeFor(unlocked, balance);
      expect(grid.width).toBeGreaterThanOrEqual(previous.width);
      expect(grid.height).toBeGreaterThanOrEqual(previous.height);
      previous = grid;
    }
  });

  it('fait croître le coût des parcelles de façon monotone', () => {
    let previous = 0;
    for (let slot = balance.plots.startingUnlocked + 1; slot <= balance.plots.maxPlots; slot += 1) {
      const cost = plotUnlockCost(slot, balance);
      expect(cost).toBeGreaterThanOrEqual(previous);
      previous = cost;
    }
    expect(plotUnlockCost(1, balance)).toBe(0);
  });
});

describe('arithmétique monétaire', () => {
  it('refuse les montants non entiers', () => {
    expect(() => assertMoney(12.5)).toThrow();
    expect(() => assertMoney(Number.NaN)).toThrow();
    expect(assertMoney(1234)).toBe(1234);
  });

  it('arrondit les gains vers le bas et les frais vers le haut', () => {
    expect(scaleMoney(100, 1.239)).toBe(123);
    expect(feeOf(101, 0.05)).toBe(6);
  });

  it('calcule un coût total exact', () => {
    expect(totalCost(37, 13)).toBe(481);
    expect(() => totalCost(10, -1)).toThrow();
  });
});

describe('marché dynamique', () => {
  const state = {
    itemKey: 'wheat',
    basePrice: 100,
    currentPrice: 100,
    previousPrice: 100,
    demandIndex: 1,
    volumeWindow: 0,
    referenceVolume: 100,
    volatility: 0.08,
    priceFloorPct: 0.55,
    priceCeilPct: 1.8,
    featured: false,
  };

  it('respecte toujours le plancher et le plafond', () => {
    for (const volume of [0, 50, 500, 100_000]) {
      let current = { ...state, volumeWindow: volume };
      for (let cycle = 0; cycle < 40; cycle += 1) {
        const update = updatePrice(current, balance, createRng(`c${cycle}`));
        expect(update.price).toBeGreaterThanOrEqual(Math.floor(state.basePrice * state.priceFloorPct));
        expect(update.price).toBeLessThanOrEqual(Math.ceil(state.basePrice * state.priceCeilPct));
        current = { ...current, currentPrice: update.price, demandIndex: update.demandIndex };
      }
    }
  });

  it('fait baisser le prix quand le volume vendu explose', () => {
    let saturated = { ...state, volumeWindow: 1_000 };
    let price = saturated.currentPrice;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const update = updatePrice(saturated, balance, createRng('flood'));
      price = update.price;
      saturated = { ...saturated, currentPrice: price, demandIndex: update.demandIndex };
    }
    expect(price).toBeLessThan(state.basePrice);
  });

  it('fait monter le prix en l\'absence de vente', () => {
    let scarce = { ...state, volumeWindow: 0 };
    let price = scarce.currentPrice;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const update = updatePrice(scarce, balance, createRng('scarce'));
      price = update.price;
      scarce = { ...scarce, currentPrice: price, demandIndex: update.demandIndex };
    }
    expect(price).toBeGreaterThan(state.basePrice);
  });

  it('amortit le volume au lieu de le remettre à zéro', () => {
    const update = updatePrice({ ...state, volumeWindow: 200 }, balance, createRng('decay'));
    expect(update.volumeWindow).toBeLessThan(200);
    expect(update.volumeWindow).toBeGreaterThan(0);
  });

  it('décote la vente directe', () => {
    expect(directSellPrice(100, balance)).toBeLessThan(100);
  });

  it('calibre le volume de référence par rareté', () => {
    expect(referenceVolumeFor('common', balance)).toBeGreaterThan(referenceVolumeFor('mythic', balance));
  });

  it('exige une surenchère minimale', () => {
    expect(minimumBid({ startPrice: 100, currentBid: null }, balance)).toBe(100);
    expect(minimumBid({ startPrice: 100, currentBid: 100 }, balance)).toBeGreaterThan(100);
  });
});

describe('animaux', () => {
  const chicken = config.animals.get('chicken')!;
  const bornAt = new Date('2026-07-01T00:00:00Z');

  const state = {
    animalKey: 'chicken',
    hunger: 100,
    happiness: 80,
    health: 100,
    statsUpdatedAt: bornAt,
    lastFedAt: bornAt,
    lastCollectedAt: null,
    lastPettedAt: null,
    productionReadyAt: new Date(bornAt.getTime() + chicken.productionSeconds * 1_000),
    pendingProduction: 0,
    qualityMultiplier: 1,
    isSick: false,
    isAlive: true,
    bornAt,
  };

  it('fait descendre la faim avec le temps et alerte sous le seuil', () => {
    // 5 points de faim par heure : après 12 h il reste 40 (au-dessus du seuil
    // d'alerte de 30), après 16 h il ne reste que 20 (alerte).
    const after12h = projectAnimal(state, chicken, new Date(bornAt.getTime() + 12 * 3_600_000), balance);
    expect(after12h.hunger).toBe(40);
    expect(after12h.hungry).toBe(false);

    const after16h = projectAnimal(state, chicken, new Date(bornAt.getTime() + 16 * 3_600_000), balance);
    expect(after16h.hunger).toBe(20);
    expect(after16h.hungry).toBe(true);
  });

  it('réduit la production d\'un animal affamé', () => {
    const starving = projectAnimal(
      { ...state, hunger: 5 },
      chicken,
      new Date(bornAt.getTime() + 1_000),
      balance,
    );
    expect(starving.productionFactor).toBeLessThan(1);
  });

  it('plafonne les productions accumulées', () => {
    const cycles = computeReadyProduction(
      state,
      chicken,
      new Date(bornAt.getTime() + 40 * 3_600_000),
      balance,
    );
    expect(cycles).toBe(balance.animals.maxPendingProduction);
  });

  it('déclenche la mort après une négligence prolongée', () => {
    const dead = projectAnimal(
      { ...state, hunger: 0, health: 1 },
      chicken,
      new Date(bornAt.getTime() + 200 * 3_600_000),
      balance,
    );
    expect(dead.shouldDie).toBe(true);
  });
});

describe('monde : saisons et météo', () => {
  it('fait tourner les saisons dans l\'ordre', () => {
    const epoch = new Date('2026-01-01T00:00:00Z');
    const lengthMs = balance.seasons.lengthDays * 86_400_000;
    const seasons = [0, 1, 2, 3, 4].map(
      (index) => seasonAt(new Date(epoch.getTime() + index * lengthMs + 1_000), balance, epoch).season,
    );
    expect(seasons).toEqual(['spring', 'summer', 'autumn', 'winter', 'spring']);
  });

  it('incrémente l\'année de jeu après quatre saisons', () => {
    const epoch = new Date('2026-01-01T00:00:00Z');
    const lengthMs = balance.seasons.lengthDays * 86_400_000;
    expect(seasonAt(new Date(epoch.getTime() + 4 * lengthMs + 1_000), balance, epoch).gameYear).toBe(2);
  });

  it('tire une météo déterministe pour un jour donné', () => {
    const first = rollWeather('2026-07-26', 'summer', balance);
    const second = rollWeather('2026-07-26', 'summer', balance);
    expect(second).toEqual(first);
  });

  it('ne tire jamais de neige en été', () => {
    for (let day = 1; day <= 28; day += 1) {
      const weather = rollWeather(`2026-07-${String(day).padStart(2, '0')}`, 'summer', balance);
      expect(weather.weather).not.toBe('snow');
    }
  });
});

describe('coopératives', () => {
  it('fait monter le niveau en cascade', () => {
    const result = addCoopXp({ level: 1, xp: 0 }, 500_000, balance);
    expect(result.level).toBeGreaterThan(1);
    expect(result.levelsGained).toBe(result.level - 1);
  });

  it('augmente la limite de membres avec le niveau', () => {
    expect(coopMemberLimit(10, balance)).toBeGreaterThan(coopMemberLimit(1, balance));
    expect(coopMemberLimit(100, balance)).toBeLessThanOrEqual(50);
  });

  it('accorde des bonus proportionnels au niveau', () => {
    const bonuses = coopBonuses(10, balance);
    expect(bonuses.growthSpeed).toBeCloseTo(balance.coop.bonusesPerLevel.growthSpeed * 10, 6);
  });
});

describe('prestige', () => {
  it('refuse le prestige avant le niveau requis', () => {
    const eligibility = checkPrestigeEligibility({ level: 10, prestige: 0 }, balance);
    expect(eligibility.eligible).toBe(false);
  });

  it('conserve la moitié des parcelles et 5 % des pièces', () => {
    const plan = planPrestige(
      { level: 60, xp: 0, coins: 1_000_000, prestige: 0, unlockedPlots: 40 },
      balance,
    );
    expect(plan.plotsKept).toBe(20);
    expect(plan.coinsKept).toBe(50_000);
    expect(plan.newMultiplier).toBeCloseTo(1.15, 5);
  });

  it('ne dépasse jamais le nombre maximum de renaissances', () => {
    const eligibility = checkPrestigeEligibility(
      { level: 60, prestige: balance.prestige.maxPrestige },
      balance,
    );
    expect(eligibility.eligible).toBe(false);
  });
});

describe('énergie', () => {
  it('régénère avec le temps sans dépasser le maximum', () => {
    const state = {
      energy: 10,
      energyMax: 100,
      energyUpdatedAt: new Date('2026-07-01T10:00:00Z'),
    };
    const later = projectEnergy(state, new Date('2026-07-01T10:30:00Z'), balance);
    expect(later.current).toBe(40);

    const full = projectEnergy(state, new Date('2026-07-02T10:00:00Z'), balance);
    expect(full.current).toBe(100);
    expect(full.fullAt).toBeNull();
  });

  it('réduit le coût avec les gants mais jamais sous 1', () => {
    expect(energyCost('harvest', balance, 0)).toBe(balance.energy.costs.harvest);
    expect(energyCost('harvest', balance, 0.9)).toBeGreaterThanOrEqual(1);
  });

  it('dépense sans passer sous zéro', () => {
    const projection = projectEnergy(
      { energy: 3, energyMax: 100, energyUpdatedAt: new Date() },
      new Date(),
      balance,
    );
    expect(spendEnergy(projection, 10, new Date()).energy).toBe(0);
  });
});

describe('modificateurs', () => {
  it('borne les valeurs extrêmes', () => {
    const clamped = clampModifiers({
      ...NEUTRAL_MODIFIERS,
      yieldMultiplier: 99,
      growthMultiplier: 0,
      luck: 12,
      energyCostReduction: 5,
    });
    expect(clamped.yieldMultiplier).toBeLessThanOrEqual(4);
    expect(clamped.growthMultiplier).toBeGreaterThanOrEqual(0.25);
    expect(clamped.luck).toBeLessThanOrEqual(1.5);
    expect(clamped.energyCostReduction).toBeLessThanOrEqual(0.75);
  });

  it('cumule les bonus de coopérative et de prestige', () => {
    const modifiers = buildModifiers(
      {
        buildings: [],
        tools: [],
        animals: [],
        coopLevel: 10,
        prestige: 2,
        activeBoosts: [],
      },
      balance,
    );
    expect(modifiers.yieldMultiplier).toBeGreaterThan(1);
    expect(modifiers.xpMultiplier).toBeGreaterThan(1);
  });
});

describe('générateur aléatoire', () => {
  it('est reproductible pour une graine donnée', () => {
    const a = createRng('graine');
    const b = createRng('graine');
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it('respecte les bornes de int()', () => {
    const rng = createRng('bornes');
    for (let index = 0; index < 500; index += 1) {
      const value = rng.int(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
    }
  });

  it('produit le même tirage quotidien sur tous les shards', () => {
    expect(dailyRng('shop', '2026-07-26').next()).toBe(dailyRng('shop', '2026-07-26').next());
  });

  it('respecte les poids sur un grand nombre de tirages', () => {
    const rng = createRng('poids');
    let rare = 0;
    for (let index = 0; index < 10_000; index += 1) {
      if (rng.weighted([{ value: 'rare', weight: 1 }, { value: 'commun', weight: 9 }]) === 'rare') {
        rare += 1;
      }
    }
    expect(rare).toBeGreaterThan(700);
    expect(rare).toBeLessThan(1_300);
  });
});

describe('pêche', () => {
  const pool: FishConfig[] = [
    { key: 'a', rarity: 'common', requiredLevel: 18 },
    { key: 'b', rarity: 'rare', requiredLevel: 25, seasons: ['summer'] },
    { key: 'c', rarity: 'epic', requiredLevel: 30, timeOfDay: 'night' },
    { key: 'd', rarity: 'legendary', requiredLevel: 50 },
  ];

  it('découpe jour/nuit à 6h et 20h UTC', () => {
    expect(isDaytime(0)).toBe(false);
    expect(isDaytime(6)).toBe(true);
    expect(isDaytime(19)).toBe(true);
    expect(isDaytime(20)).toBe(false);
    expect(isDaytime(23)).toBe(false);
  });

  it('exclut les espèces hors niveau, hors saison ou hors moment', () => {
    const eligible = eligibleFish(pool, { level: 26, season: 'winter', daytime: true });
    const keys = eligible.map((fish) => fish.key);
    expect(keys).toContain('a');
    expect(keys).not.toContain('b'); // mauvaise saison
    expect(keys).not.toContain('c'); // nuit uniquement
    expect(keys).not.toContain('d'); // niveau trop bas
  });

  it('inclut une espèce saisonnière pendant sa saison, nocturne la nuit', () => {
    const eligible = eligibleFish(pool, { level: 30, season: 'summer', daytime: false });
    const keys = eligible.map((fish) => fish.key);
    expect(keys).toContain('b');
    expect(keys).toContain('c');
  });

  it('ne tire jamais une espèce hors du pool éligible', () => {
    const rng = createRng('peche-graine');
    const eligible = eligibleFish(pool, { level: 18, season: 'spring', daytime: true });
    for (let i = 0; i < 200; i += 1) {
      const fish = rollFish(eligible, balance, createRng(`${rng.next()}`));
      if (fish) expect(eligible.map((f) => f.key)).toContain(fish.key);
    }
  });

  it('retourne undefined pour un pool vide', () => {
    expect(rollFish([], balance, createRng('vide'))).toBeUndefined();
  });

  it('note le ferrage : trop tôt, à l\'heure, trop tard', () => {
    expect(scoreCastTiming(999, 1000, 3000)).toBe('too_early');
    expect(scoreCastTiming(1000, 1000, 3000)).toBe('hit');
    expect(scoreCastTiming(2500, 1000, 3000)).toBe('hit');
    expect(scoreCastTiming(4001, 1000, 3000)).toBe('too_late');
  });

  it('la précision de ferrage est maximale au centre de la fenêtre', () => {
    const center = timingAccuracy(2500, 1000, 3000);
    const edge = timingAccuracy(1000, 1000, 3000);
    expect(center).toBeCloseTo(1, 5);
    expect(edge).toBeCloseTo(0, 5);
    expect(center).toBeGreaterThan(edge);
  });

  it('une meilleure précision de ferrage ne peut jamais réduire la chance de qualité', () => {
    let goodCount = 0;
    let badCount = 0;
    for (let i = 0; i < 2_000; i += 1) {
      if (rollFishQuality(1, balance, createRng(`good-${i}`)) !== 'normal') goodCount += 1;
      if (rollFishQuality(0, balance, createRng(`bad-${i}`)) !== 'normal') badCount += 1;
    }
    expect(goodCount).toBeGreaterThan(badCount);
  });
});

describe('mine', () => {
  const pool: OreConfig[] = [
    { key: 'shallow', rarity: 'common', requiredLevel: 22, minDepth: 1 },
    { key: 'mid', rarity: 'rare', requiredLevel: 30, minDepth: 10 },
    { key: 'deep', rarity: 'legendary', requiredLevel: 50, minDepth: 18 },
  ];

  it('est fermée avant le niveau de déblocage', () => {
    expect(maxDepthForLevel(balance.mining.unlockLevel - 1, balance)).toBe(0);
  });

  it('commence à la profondeur 1 pile au niveau de déblocage', () => {
    expect(maxDepthForLevel(balance.mining.unlockLevel, balance)).toBe(1);
  });

  it('ne dépasse jamais la profondeur maximale configurée', () => {
    expect(maxDepthForLevel(999, balance)).toBe(balance.mining.maxDepth);
  });

  it('augmente avec le niveau, jamais ne diminue', () => {
    let previous = 0;
    for (let level = balance.mining.unlockLevel; level <= 200; level += 1) {
      const depth = maxDepthForLevel(level, balance);
      expect(depth).toBeGreaterThanOrEqual(previous);
      previous = depth;
    }
  });

  it('exclut le minerai trop profond ou hors niveau', () => {
    // Niveau 35 : suffisant pour "mid" (requiert 30) et "shallow", pas pour
    // "deep" (requiert 50). Profondeur 5 : insuffisante pour "mid" (10) et
    // "deep" (18). Isole donc les deux motifs d'exclusion.
    const eligible = eligibleOre(pool, { level: 35, depth: 5 });
    const keys = eligible.map((ore) => ore.key);
    expect(keys).toContain('shallow');
    expect(keys).not.toContain('mid'); // profondeur insuffisante malgré le niveau suffisant
    expect(keys).not.toContain('deep'); // niveau insuffisant
  });

  it('ne tire jamais un minerai hors du pool éligible', () => {
    const eligible = eligibleOre(pool, { level: 22, depth: 3 });
    for (let i = 0; i < 100; i += 1) {
      const ore = rollOre(eligible, balance, createRng(`mine-${i}`));
      if (ore) expect(eligible.map((o) => o.key)).toContain(ore.key);
    }
  });

  it("ne propose jamais d'avancer au-delà de la profondeur maximale", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(rollAdvance(10, 10, balance, createRng(`stuck-${i}`))).toBe(false);
    }
  });

  it("peut avancer d'un niveau tant que le plafond n'est pas atteint", () => {
    let advanced = 0;
    for (let i = 0; i < 500; i += 1) {
      if (rollAdvance(5, 20, balance, createRng(`advance-${i}`))) advanced += 1;
    }
    expect(advanced).toBeGreaterThan(0);
  });
});
