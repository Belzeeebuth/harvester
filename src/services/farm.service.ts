import { balance as getBalance, getConfig, harvestKeyOf, seedKeyOf, type CropConfig } from '../config';
import type { Balance } from '../config/gameplay/schemas';
import { getDb, lockUserRow, withTransaction } from '../db/client';
import {
  computeGrowth,
  computeWaterStatus,
  nextWateringAt,
  planCrop,
  type GrowthContext,
  type GrowthState,
} from '../game/growth';
import { gridSizeFor, plotUnlockCost } from '../game/grid';
import { computeHarvest, type HarvestResult } from '../game/harvest';
import { applyFertilizer, describeFertility, fallowRecovery, weedGrowth, type PestType } from '../game/plot';
import { liveRng } from '../game/rng';
import { waterMultiplierFor } from '../game/world';
import { batchCount } from '../game/planting';
import { inSeasonCropsFor } from '../game/starter-kit';
import { gameError } from '../utils/errors';
import { discordTimestamp, formatNumber } from '../utils/format';
import { moduleLogger } from '../utils/logger';
import * as economyRepo from '../repositories/economy.repo';
import * as farmRepo from '../repositories/farm.repo';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import * as socialRepo from '../repositories/social.repo';
import * as inventoryService from './inventory.service';
import * as economyService from './economy.service';
import { consumeEnergy, getFarmModifiers, grantXp } from './player.service';
import { grantPassXp, mergeResults, passXpFor, trackAction, trackHarvest, type TrackResult } from './tracker.service';
import { eventPriceMultiplier, getWorldState, type WorldState } from './world.service';
import type { FarmModifiers } from '../game/modifiers';
import type { PlayerContext } from '../types';

const log = moduleLogger('farm');

/**
 * ---------------------------------------------------------------------------
 * SERVICE DE FERME — planter, arroser, fertiliser, désherber, traiter, récolter
 * ---------------------------------------------------------------------------
 * C'est le cœur du jeu. Chaque action suit le même squelette, et ce n'est pas un
 * hasard :
 *
 *   1. LIRE le contexte (monde, modificateurs) hors transaction — c'est du cache.
 *   2. OUVRIR une transaction.
 *   3. VERROUILLER les lignes concernées (`SELECT ... FOR UPDATE`) : joueur,
 *      parcelle(s). C'est ce qui rend l'action idempotente face au double-clic.
 *   4. VALIDER l'état lu SOUS VERROU (la parcelle est-elle encore prête ?).
 *      Toute validation faite avant le verrou ne vaut rien.
 *   5. CONSOMMER (énergie, graines, argent) puis PRODUIRE (récolte, XP).
 *   6. SUIVRE la progression (quêtes, succès, coop) dans la même transaction.
 *   7. COMMIT.
 *
 * Aucune règle de jeu n'est implémentée ici : les calculs sont dans `src/game/`,
 * les requêtes dans `src/repositories/`. Ce fichier orchestre.
 */

export interface PlotView {
  slot: number;
  x: number;
  y: number;
  state: 'locked' | 'empty' | 'planted' | 'growing' | 'ready' | 'withered';
  fertility: number;
  fertilityLabel: string;
  weedLevel: number;
  pestType: PestType | null;
  pestDeadlineAt: Date | null;
  unlockCost: number;
  crop?: {
    key: string;
    name: string;
    emoji: string;
    rarity: string;
    growth: GrowthState;
    mutation: string;
    regrowRemaining: number;
    waterGiven: number;
    waterNeeded: number;
    fertilizerKey: string | null;
  };
}

export interface FarmView {
  farmId: string;
  name: string;
  grid: { width: number; height: number };
  plots: PlotView[];
  counts: { ready: number; growing: number; empty: number; locked: number; withered: number; pests: number };
  world: WorldState;
  modifiers: FarmModifiers;
  nextReadyAt: Date | null;
  unlockedPlots: number;
  nextPlotCost: number;
}

/**
 * Modificateurs du joueur, niveau de coopérative COMPRIS.
 *
 * Les actions de ferme appelaient `getFarmModifiers` sans niveau de
 * coopérative (donc 0) : les bonus de pousse, d'XP, de qualité et de vente de
 * la coopérative ne s'appliquaient pas aux cultures, et l'estimation affichée
 * à la récolte restait sous ce que `/sell` payait réellement. Un niveau fourni
 * par l'appelant (déjà lu pour l'affichage) évite une requête.
 */
async function farmModifiersFor(
  player: Pick<PlayerContext, 'id' | 'farmId' | 'prestige' | 'coopId'>,
  now: Date,
  coopLevel?: number,
): Promise<FarmModifiers> {
  let level = coopLevel;
  if (level === undefined) {
    level = player.coopId ? ((await socialRepo.findCoopById(player.coopId))?.level ?? 0) : 0;
  }
  return getFarmModifiers(player, { coopLevel: level, now });
}

/** Vue complète de la ferme : une requête pour les parcelles, tout est dérivé. */
export async function getFarmView(
  player: Pick<PlayerContext, 'id' | 'farmId' | 'prestige' | 'coopId' | 'locale'>,
  options: { coopLevel?: number; now?: Date } = {},
): Promise<FarmView> {
  const now = options.now ?? new Date();
  const config = getConfig(player.locale);
  const balance = getBalance();

  const [rows, farm, world, modifiers] = await Promise.all([
    farmRepo.listPlots(player.farmId),
    playerRepo.getFarmByUserId(player.id),
    getWorldState(now, player.locale),
    farmModifiersFor(player, now, options.coopLevel),
  ]);

  const counts = { ready: 0, growing: 0, empty: 0, locked: 0, withered: 0, pests: 0 };
  let nextReadyAt: Date | null = null;
  let unlockedPlots = 0;

  const plots: PlotView[] = rows.map(({ plot, crop }) => {
    const fertility = effectiveFertility(plot, now, balance);
    const weedLevel = currentWeedLevel(plot, now, balance);

    if (plot.state !== 'locked') unlockedPlots += 1;
    if (plot.pestType) counts.pests += 1;

    const view: PlotView = {
      slot: plot.slot,
      x: plot.x,
      y: plot.y,
      state: plot.state,
      fertility,
      fertilityLabel: describeFertility(fertility, balance),
      weedLevel,
      pestType: plot.pestType,
      pestDeadlineAt: plot.pestDeadlineAt,
      unlockCost: plot.unlockCost,
    };

    if (crop) {
      const cropConfig = config.crops.get(crop.cropKey);
      const growth = computeGrowth(
        {
          cropKey: crop.cropKey,
          plantedAt: crop.plantedAt,
          readyAt: crop.readyAt,
          growthSeconds: crop.growthSeconds,
          withersAt: crop.withersAt,
          waterNeeded: crop.waterNeeded,
          waterGiven: crop.waterGiven,
          missedWaterings: crop.missedWaterings,
          nextWaterAt: crop.nextWaterAt,
          withered: crop.withered,
          regrowRemaining: crop.regrowRemaining,
          harvestCount: crop.harvestCount,
        },
        now,
        balance.water.graceMinutes,
      );

      view.state = growth.withered ? 'withered' : growth.ready ? 'ready' : 'growing';
      view.crop = {
        key: crop.cropKey,
        name: cropConfig?.name ?? crop.cropKey,
        emoji: cropConfig?.emoji ?? '🌱',
        rarity: cropConfig?.rarity ?? 'common',
        growth,
        mutation: crop.mutation,
        regrowRemaining: crop.regrowRemaining,
        waterGiven: crop.waterGiven,
        waterNeeded: crop.waterNeeded,
        fertilizerKey: crop.fertilizerKey,
      };

      if (growth.withered) counts.withered += 1;
      else if (growth.ready) counts.ready += 1;
      else {
        counts.growing += 1;
        if (!nextReadyAt || crop.readyAt < nextReadyAt) nextReadyAt = crop.readyAt;
      }
    } else if (plot.state === 'locked') {
      counts.locked += 1;
    } else {
      counts.empty += 1;
    }

    return view;
  });

  const grid = gridSizeFor(unlockedPlots, balance);
  const nextSlot = rows.find(({ plot }) => plot.state === 'locked')?.plot.slot;

  return {
    farmId: player.farmId,
    name: farm?.name ?? 'My farm',
    grid: { width: grid.width, height: grid.height },
    plots,
    counts,
    world,
    modifiers,
    nextReadyAt,
    unlockedPlots,
    nextPlotCost: nextSlot ? plotUnlockCost(nextSlot, balance) : 0,
  };
}

/**
 * Origine du temps pour l'accumulation des mauvaises herbes : le dernier
 * « remue-ménage » sur la parcelle.
 *
 * `lastWeededAt` manquait à cette liste — la colonne n'existait pas. Désherber
 * remettait donc `weed_level` à zéro sans déplacer l'origine, et la pénalité
 * revenait intégralement à la lecture suivante : sur une parcelle jamais
 * récoltée, les herbes plafonnaient à 100 sans aucun recours.
 */
function weedAnchor(plot: {
  lastWeededAt: Date | null;
  lastHarvestAt: Date | null;
  unlockedAt: Date | null;
  createdAt: Date;
}): Date {
  let latest = plot.createdAt;
  for (const candidate of [plot.lastWeededAt, plot.lastHarvestAt, plot.unlockedAt]) {
    if (candidate && candidate.getTime() > latest.getTime()) latest = candidate;
  }
  return latest;
}

function currentWeedLevel(
  plot: Parameters<typeof weedAnchor>[0] & { weedLevel: number; state: string },
  now: Date,
  balance: Balance,
): number {
  if (plot.state === 'locked') return 0;
  return weedGrowth(plot.weedLevel, now.getTime() - weedAnchor(plot).getTime(), balance);
}

/**
 * Fertilité réelle d'une parcelle, jachère comprise.
 *
 * `fallowUntil` porte l'instant de MISE en jachère malgré son nom : c'est la
 * seule façon dont il est écrit et lu. La valeur récupérée était jusqu'ici
 * calculée à l'affichage mais jamais persistée — et comme rien n'écrivait
 * `fallowUntil`, la branche était morte et la fertilité ne remontait jamais.
 * Elle est désormais posée à la libération de la parcelle et encaissée à la
 * plantation, pour que l'affichage et le calcul de récolte ne divergent pas.
 */
function effectiveFertility(
  plot: { state: string; fertility: number; fallowUntil: Date | null },
  now: Date,
  balance: Balance,
): number {
  if (plot.state !== 'empty' || !plot.fallowUntil) return plot.fertility;
  return fallowRecovery(plot.fertility, now.getTime() - plot.fallowUntil.getTime(), balance);
}

function growthContext(world: WorldState, modifiers: FarmModifiers): GrowthContext {
  return {
    season: world.season.season,
    weatherGrowthModifier: world.weather.growthModifier,
    modifiers,
    balance: getBalance(),
  };
}

// ---------------------------------------------------------------------------
// PLANTER
// ---------------------------------------------------------------------------

export interface PlantResult {
  cropKey: string;
  cropName: string;
  emoji: string;
  slots: number[];
  readyAt: Date;
  offSeason: boolean;
  /** Cultures de saison accessibles au joueur, proposées quand la plantation est hors saison. */
  inSeasonAlternatives: Array<{ key: string; name: string; emoji: string }>;
  seedsUsed: number;
  waterNeeded: number;
  tracking: TrackResult;
}

/**
 * Plante une culture sur une ou plusieurs parcelles.
 *
 * `slot` non fourni ⇒ on remplit automatiquement les parcelles vides, dans
 * l'ordre. C'est le comportement attendu par les joueurs qui enchaînent
 * `/plant blé quantité:9` et ne veulent pas cliquer neuf fois.
 */
/** États de parcelle qui acceptent une plantation, si aucune culture n'y est. */
function isFreeState(state: string): boolean {
  return state === 'empty' || state === 'withered';
}

export async function plant(
  player: PlayerContext,
  input: { cropKey: string; slot?: number; quantity?: number; coopLevel?: number },
): Promise<PlantResult> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const crop = config.crops.get(input.cropKey);
  if (!crop || !crop.enabled) {
    throw gameError('item_unknown', `Unknown crop: \`${input.cropKey}\`.`, {
      i18nKey: 'errors.farm.unknown_crop',
      params: { cropKey: input.cropKey },
    });
  }
  if (player.level < crop.requiredLevel) {
    throw gameError(
      'level_too_low',
      `${crop.emoji} ${crop.name} requires level ${crop.requiredLevel}.`,
      {
        context: { required: crop.requiredLevel, current: player.level },
        i18nKey: 'plant.wrong_level',
        params: { crop: crop.name, level: crop.requiredLevel },
      },
    );
  }

  const now = new Date();
  const world = await getWorldState(now);
  const modifiers = await farmModifiersFor(player, now, input.coopLevel);
  const context = growthContext(world, modifiers);
  const seedKey = seedKeyOf(crop.key);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);

    // Graines possédées, lues SOUS verrou : elles plafonnent la plantation au
    // lieu de la faire échouer (voir `batchCount`).
    const owned = await inventoryRepo.countItem(player.id, seedKey, tx);
    const seedItem = inventoryService.requireItem(seedKey, player.locale);
    if (owned <= 0) {
      throw gameError('insufficient_items', `No ${seedItem.name} left.`, {
        i18nKey: 'first_hour.no_seeds',
        hintKey: 'first_hour.no_seeds_hint',
        params: { emoji: seedItem.emoji, name: seedItem.name },
        suggestedCommand: 'seeds',
      });
    }

    // Sélection des parcelles cibles, sous verrou.
    const freeSlots = input.slot
      ? [input.slot]
      : (await farmRepo.listPlots(player.farmId, tx))
          .filter(({ plot, crop: planted }) => isFreeState(plot.state) && !planted)
          .map(({ plot }) => plot.slot);
    const targetSlots = freeSlots.slice(0, batchCount(freeSlots.length, owned, input.quantity));

    if (targetSlots.length === 0) {
      throw gameError('plot_empty', 'No free plot.', {
        i18nKey: 'plant.no_free_plot',
        suggestedCommand: 'buy-plot',
      });
    }

    const locked = await farmRepo.lockPlotsBySlots(tx, player.farmId, targetSlots);
    // Une parcelle `withered` SANS culture est libre : séquelle d'une ancienne
    // course avec le job de flétrissement, elle était refusée à jamais.
    const occupied = await farmRepo.plotIdsWithCrop(
      locked.filter((plot) => isFreeState(plot.state)).map((plot) => plot.id),
      tx,
    );
    const plantable = locked.filter((plot) => isFreeState(plot.state) && !occupied.has(plot.id));

    if (plantable.length === 0) {
      const first = locked[0];
      if (!first) {
        throw gameError('plot_not_found', `Plot ${targetSlots[0]} not found.`, {
          i18nKey: 'errors.plot_not_found',
          params: { slot: targetSlots[0] ?? 0 },
        });
      }
      if (first.state === 'locked') {
        throw gameError('plot_locked', `Plot ${first.slot} is locked.`, {
          i18nKey: 'errors.plot_locked',
          hintKey: 'errors.farm.plot_locked_hint',
          params: {
            slot: first.slot,
            cost: formatNumber(plotUnlockCost(first.slot, balance), player.locale),
          },
          suggestedCommand: 'buy-plot',
        });
      }
      throw gameError('plot_occupied', `Plot ${first.slot} is already occupied.`, {
        i18nKey: 'plant.plot_occupied',
        hintKey: 'errors.farm.plot_occupied_hint',
        params: { slot: first.slot },
      });
    }

    const quantity = plantable.length;
    // `quantity` ne dépasse jamais les graines possédées (plafond ci-dessus) :
    // la consommation ne peut plus échouer faute de stock.
    await inventoryService.consume(player.id, seedKey, quantity, tx, player.locale);
    await consumeEnergy(player.id, 'plant', tx, {
      quantity,
      costReduction: modifiers.energyCostReduction,
      now,
    });

    const waterMultiplier =
      waterMultiplierFor(world.weather.weather, balance) * world.eventModifiers.waterMultiplier;
    const plan = planCrop(crop, context, now, { extraWaterMultiplier: waterMultiplier });

    for (const plot of plantable) {
      // La fertilité regagnée en jachère est ENCAISSÉE ici : tant qu'elle
      // restait un calcul d'affichage, la vue montrait un sol reposé et la
      // récolte utilisait la valeur épuisée stockée en base.
      const bankedFertility = effectiveFertility(plot, now, balance);

      await farmRepo.insertPlantedCrop(
        {
          plotId: plot.id,
          userId: player.id,
          cropKey: crop.key,
          plantedAt: now,
          readyAt: plan.readyAt,
          growthSeconds: plan.growthSeconds,
          withersAt: plan.withersAt,
          waterNeeded: plan.waterNeeded,
          nextWaterAt: plan.nextWaterAt,
          seasonPlanted: world.season.season,
          weatherPlanted: world.weather.weather,
          mutation: 'none',
          regrowRemaining: crop.regrowCycles,
        },
        tx,
      );
      await farmRepo.updatePlot(
        plot.id,
        // Les champs de nuisible repartent à zéro : un nuisible resté sur la
        // parcelle (posé juste avant la récolte) aurait sinon frappé la
        // nouvelle culture dès le passage suivant du job de conséquences.
        {
          state: 'planted',
          fertility: bankedFertility,
          fallowUntil: null,
          pestType: null,
          pestAppearedAt: null,
          pestDeadlineAt: null,
        },
        tx,
      );
    }

    await playerRepo.incrementStats(player.id, { totalPlanted: quantity }, tx);
    const tracking = await trackAction(
      { userId: player.id, coopId: player.coopId, level: player.level },
      'plant_seed',
      quantity,
      { cropKey: crop.key },
      tx,
    );

    log.debug({ userId: player.id, cropKey: crop.key, quantity }, 'plantation');
    const offSeason = !modifiers.seasonImmunity && !crop.seasons.includes(world.season.season);

    return {
      cropKey: crop.key,
      cropName: crop.name,
      emoji: crop.emoji,
      slots: plantable.map((plot) => plot.slot),
      readyAt: plan.readyAt,
      offSeason,
      inSeasonAlternatives: offSeason
        ? inSeasonCropsFor(world.season.season, player.level, config.cropList).map((entry) => ({
            key: entry.key,
            name: entry.name,
            emoji: entry.emoji,
          }))
        : [],
      seedsUsed: quantity,
      waterNeeded: plan.waterNeeded,
      tracking,
    };
  });
}

// ---------------------------------------------------------------------------
// ARROSER
// ---------------------------------------------------------------------------

export interface WaterResult {
  watered: number;
  freeRain: boolean;
  tracking: TrackResult;
  toolPlots: number;
}

/**
 * Arrose une ou toutes les parcelles.
 * La pluie arrose gratuitement : dans ce cas on n'exige ni énergie ni action, on
 * informe simplement le joueur — sinon il gaspillerait son énergie pour rien.
 */
export async function water(
  player: PlayerContext,
  input: { slot?: number; all?: boolean; coopLevel?: number },
): Promise<WaterResult> {
  const now = new Date();
  const world = await getWorldState(now);
  const modifiers = await farmModifiersFor(player, now, input.coopLevel);

  if (world.weather.freeWatering) {
    return { watered: 0, freeRain: true, tracking: emptyTracking(), toolPlots: 0 };
  }

  // La capacité de l'arrosoir limite le nombre de parcelles par action.
  const tool = await inventoryService.bestTool(player.id, 'watering');
  const toolPlots = tool?.effect?.plots ?? 1;

  return withTransaction(async (tx) => {
    const rows = await farmRepo.listPlots(player.farmId, tx);
    const candidates = rows
      .filter(({ plot, crop }) => {
        if (!crop || crop.withered) return false;
        if (input.slot && plot.slot !== input.slot) return false;
        const status = computeWaterStatus(
          {
            plantedAt: crop.plantedAt,
            growthSeconds: crop.growthSeconds,
            waterNeeded: crop.waterNeeded,
            waterGiven: crop.waterGiven,
          },
          now,
          0,
        );
        return status.needsWater;
      })
      .slice(0, input.all ? Math.max(1, toolPlots) : 1);

    if (candidates.length === 0) {
      // Prochain arrosage connu : dit tout de suite, plutôt que renvoyer vers
      // `/farm` qui ne l'affiche pas.
      const next = nextWateringAt(
        rows
          .filter(({ plot, crop }) => crop && !crop.withered && (!input.slot || plot.slot === input.slot))
          .map(({ crop }) => crop!),
        now,
      );
      throw gameError('no_water_needed', "No plot needs water right now.", {
        i18nKey: 'water.nothing_to_water',
        hintKey: next ? 'first_hour.water_next_hint' : 'first_hour.water_none_hint',
        params: next ? { relative: discordTimestamp(next, 'R') } : {},
      });
    }

    await consumeEnergy(player.id, 'water', tx, {
      quantity: 1,
      costReduction: modifiers.energyCostReduction,
      now,
    });

    const cropIds = candidates
      .map(({ crop }) => crop?.id)
      .filter((id): id is string => id !== undefined);
    const watered = await farmRepo.waterCrops(cropIds, now, tx);

    await farmRepo.updatePlots(
      candidates.map(({ plot }) => plot.id),
      { lastWateredAt: now },
      tx,
    );
    await playerRepo.incrementStats(player.id, { totalWatered: watered }, tx);

    const tracking = await trackAction(
      { userId: player.id, coopId: player.coopId, level: player.level },
      'water_plot',
      watered,
      {},
      tx,
    );

    return { watered, freeRain: false, tracking, toolPlots };
  });
}

// ---------------------------------------------------------------------------
// RÉCOLTER
// ---------------------------------------------------------------------------

export interface HarvestedPlot {
  slot: number;
  cropKey: string;
  cropName: string;
  emoji: string;
  result: HarvestResult;
  regrew: boolean;
  nextReadyAt: Date | null;
}

export interface HarvestSummary {
  plots: HarvestedPlot[];
  totalQuantity: number;
  estimatedValue: number;
  xpGained: number;
  levelUp: { levelsGained: number; level: number; rewardCoins: number; rewardGems: number } | null;
  seedsRecovered: Array<{ itemKey: string; quantity: number }>;
  witheredSlots: number[];
  tracking: TrackResult;
  passTier?: number;
}

/**
 * Récolte une parcelle ou toutes celles qui sont prêtes.
 *
 * Point délicat : le RENDEMENT et la QUALITÉ sont tirés au sort. Le tirage a
 * lieu SOUS VERROU, une seule fois par parcelle, et le résultat est immédiatement
 * écrit. Un double-clic ne peut donc pas « rejouer les dés » pour obtenir une
 * meilleure qualité — c'est un vecteur d'abus classique dans ce genre de bot.
 */
export async function harvest(
  player: PlayerContext,
  input: { slot?: number; all?: boolean; coopLevel?: number },
): Promise<HarvestSummary> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const now = new Date();
  const world = await getWorldState(now);
  const modifiers = await farmModifiersFor(player, now, input.coopLevel);
  const context = growthContext(world, modifiers);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);

    const rows = await farmRepo.listPlots(player.farmId, tx);
    const ready = rows.filter(({ plot, crop }) => {
      if (!crop) return false;
      if (input.slot && plot.slot !== input.slot) return false;
      return now.getTime() >= crop.readyAt.getTime();
    });

    if (ready.length === 0) {
      throw gameError('crop_not_ready', "Nothing is ready to harvest.", {
        i18nKey: 'harvest.nothing_ready',
        suggestedCommand: 'farm',
      });
    }

    const selected = input.all ? ready : ready.slice(0, 1);
    const slots = selected.map(({ plot }) => plot.slot);
    await farmRepo.lockPlotsBySlots(tx, player.farmId, slots);

    await consumeEnergy(player.id, 'harvest', tx, {
      quantity: 1,
      costReduction: modifiers.energyCostReduction,
      now,
    });

    const marketPrices = await economyRepo.getMarketPrices(
      [...new Set(selected.map(({ crop }) => harvestKeyOf(crop!.cropKey)))],
      tx,
    );

    const harvested: HarvestedPlot[] = [];
    /** Tout ce que la récolte rapporte, déposé en un seul lot après la boucle. */
    const pending: Array<{
      itemKey: string;
      quantity: number;
      quality?: HarvestResult['quality'];
      mutation?: HarvestResult['mutation'];
    }> = [];
    const witheredSlots: number[] = [];
    const seedsRecovered = new Map<string, number>();
    const trackings: TrackResult[] = [];
    let totalQuantity = 0;
    let estimatedValue = 0;
    let xpTotal = 0;

    for (const { plot, crop } of selected) {
      if (!crop) continue;
      const cropConfig = config.crops.get(crop.cropKey);
      if (!cropConfig) continue;

      // Culture fanée : la parcelle est nettoyée, rien n'est récolté.
      if (crop.withered || (crop.withersAt && now.getTime() >= crop.withersAt.getTime())) {
        witheredSlots.push(plot.slot);
        await farmRepo.deletePlantedCrop(crop.id, tx);
        await farmRepo.updatePlot(
          plot.id,
          {
            state: 'empty',
            lastHarvestAt: now,
            fallowUntil: now,
            weedLevel: Math.min(100, plot.weedLevel + 10),
          },
          tx,
        );
        continue;
      }

      const water = computeWaterStatus(
        {
          plantedAt: crop.plantedAt,
          growthSeconds: crop.growthSeconds,
          waterNeeded: crop.waterNeeded,
          waterGiven: crop.waterGiven,
        },
        now,
        balance.water.graceMinutes,
      );

      // Un nuisible non traité dont le délai est passé abîme la récolte.
      let damagePenalty = Number(crop.damagePenalty);
      if (plot.pestType && plot.pestDeadlineAt && now.getTime() > plot.pestDeadlineAt.getTime()) {
        damagePenalty = Math.min(1, damagePenalty + balance.pests.yieldLossIfIgnored);
      }

      const harvestItemKey = harvestKeyOf(crop.cropKey);
      const marketPrice = marketPrices.get(harvestItemKey)?.currentPrice ?? cropConfig.sellPrice;

      const result = computeHarvest({
        crop: cropConfig,
        fertility: plot.fertility,
        weedLevel: currentWeedLevel(plot, now, balance),
        missedWaterings: Math.max(crop.missedWaterings, water.missed),
        damagePenalty,
        fertilizerBoost: Number(crop.fertilizerBoost),
        fertilizerQualityBoost: Number(crop.qualityBoost),
        helpers: crop.helpedBy.length,
        season: world.season.season,
        weatherYieldModifier: world.weather.yieldModifier,
        level: player.level,
        modifiers,
        marketUnitPrice: marketPrice,
        eventPriceMultiplier: eventPriceMultiplier(
          world,
          harvestItemKey,
          config.items.get(harvestItemKey)?.category ?? 'harvest',
        ),
        eventMutationMultiplier: world.eventModifiers.mutationMultiplier,
        balance,
        // `liveRng` mélange l'horloge : le tirage n'est PAS reproductible, et
        // ne prétend pas l'être. Ce qui interdit le « reroll », c'est le
        // `lockUserRow` en tête de transaction — la deuxième récolte attend,
        // relit une parcelle déjà vidée et échoue. La graine ne porte aucune
        // garantie de sécurité, seulement de la décorrélation entre parcelles.
        rng: liveRng(`${crop.id}:${crop.harvestCount}`),
      });

      // Les gains sont ACCUMULÉS et déposés en un seul appel après la boucle.
      // Un `addItems` par parcelle coûtait deux requêtes de capacité chacune —
      // soit une soixantaine sur une récolte complète, à l'intérieur d'une
      // transaction qui tient déjà le verrou du joueur.
      if (result.quantity > 0) {
        pending.push({
          itemKey: harvestItemKey,
          quantity: result.quantity,
          quality: result.quality,
          mutation: result.mutation,
        });
      }

      if (result.seedRecovered) {
        const seedKey = seedKeyOf(crop.cropKey);
        seedsRecovered.set(seedKey, (seedsRecovered.get(seedKey) ?? 0) + 1);
        pending.push({ itemKey: seedKey, quantity: 1 });
      }

      // Repousse ou parcelle libérée.
      let regrew = false;
      let nextReadyAt: Date | null = null;
      if (crop.regrowRemaining > 0 && cropConfig.regrowSeconds > 0) {
        const plan = planCrop(cropConfig, context, now, {
          regrow: true,
          extraWaterMultiplier: waterMultiplierFor(world.weather.weather, balance),
        });
        await farmRepo.updatePlantedCrop(
          crop.id,
          {
            plantedAt: now,
            readyAt: plan.readyAt,
            growthSeconds: plan.growthSeconds,
            withersAt: plan.withersAt,
            waterNeeded: plan.waterNeeded,
            waterGiven: 0,
            missedWaterings: 0,
            nextWaterAt: plan.nextWaterAt,
            regrowRemaining: crop.regrowRemaining - 1,
            harvestCount: crop.harvestCount + 1,
            damagePenalty: '0.000',
            helpedBy: [],
          },
          tx,
        );
        regrew = true;
        nextReadyAt = plan.readyAt;
        await farmRepo.updatePlot(plot.id, { state: 'planted', lastHarvestAt: now, fertility: result.fertilityAfter, pestType: null, pestAppearedAt: null, pestDeadlineAt: null }, tx);
      } else {
        await farmRepo.deletePlantedCrop(crop.id, tx);
        await farmRepo.updatePlot(
          plot.id,
          {
            state: 'empty',
            lastHarvestAt: now,
            fertility: result.fertilityAfter,
            // Départ de la jachère : la fertilité remonte tant que la parcelle
            // reste vide, et sera encaissée à la prochaine plantation.
            fallowUntil: now,
            weedLevel: Math.min(100, plot.weedLevel + balance.weeds.weedsPerClear),
            pestType: null,
            pestAppearedAt: null,
            pestDeadlineAt: null,
          },
          tx,
        );
      }

      harvested.push({
        slot: plot.slot,
        cropKey: crop.cropKey,
        cropName: cropConfig.name,
        emoji: cropConfig.emoji,
        result,
        regrew,
        nextReadyAt,
      });
      totalQuantity += result.quantity;
      estimatedValue += result.totalValue;
      xpTotal += result.xp;

      trackings.push(
        await trackHarvest(
          { userId: player.id, coopId: player.coopId, level: player.level },
          { cropKey: crop.cropKey, quantity: result.quantity, rarity: cropConfig.rarity },
          tx,
        ),
      );
    }

    // Récompenses d'événement (jetons de citrouille, etc.).
    for (const event of world.activeEvents) {
      const perHarvest = event.modifiers.tokenPerHarvest ?? 0;
      if (event.currencyItemKey && perHarvest > 0 && harvested.length > 0) {
        pending.push({
          itemKey: event.currencyItemKey,
          quantity: perHarvest * harvested.length,
        });
      }
    }

    // Dépôt unique, capacité VÉRIFIÉE. La récolte passait auparavant en
    // `allowOverflow`, comme 21 des 22 appels du projet : l'entrepôt ne limitait
    // donc rien, et le puits de pièces que son amélioration doit alimenter était
    // inerte. Un entrepôt plein annule maintenant toute la transaction — la
    // récolte reste mûre en terre, rien n'est perdu, et le message renvoie vers
    // `/buildings`, ce que le module d'inventaire documentait déjà.
    if (pending.length > 0) {
      // `discover` : la récolte est de la PRODUCTION, donc une vraie découverte
      // de collection — contrairement à un achat ou à un échange.
      await inventoryService.addItems(player.id, pending, tx, { discover: true });
    }

    await playerRepo.incrementStats(player.id, { totalHarvests: totalQuantity }, tx);
    await playerRepo.updateBestHarvest(player.id, estimatedValue, tx);

    const xpResult = xpTotal > 0 ? await grantXp(player.id, xpTotal, tx) : null;
    const passResult = await grantPassXp(player.id, passXpFor(xpTotal), tx);

    log.debug(
      { userId: player.id, plots: harvested.length, quantity: totalQuantity, xp: xpTotal },
      'harvest',
    );

    return {
      plots: harvested,
      totalQuantity,
      estimatedValue,
      xpGained: xpTotal,
      levelUp:
        xpResult && xpResult.levelsGained > 0
          ? {
              levelsGained: xpResult.levelsGained,
              level: xpResult.level,
              rewardCoins: xpResult.rewardCoins,
              rewardGems: xpResult.rewardGems,
            }
          : null,
      seedsRecovered: [...seedsRecovered.entries()].map(([itemKey, quantity]) => ({
        itemKey,
        quantity,
      })),
      witheredSlots,
      tracking: mergeResults(trackings),
      passTier: passResult?.tier,
    };
  });
}

// ---------------------------------------------------------------------------
// FERTILISER / DÉSHERBER / TRAITER
// ---------------------------------------------------------------------------

export async function fertilize(
  player: PlayerContext,
  input: { fertilizerKey: string; slot?: number; all?: boolean },
): Promise<{ slots: number[]; fertilizer: string; fertilityAfter: number; tracking: TrackResult }> {
  const balance = getBalance();
  const item = inventoryService.requireItem(input.fertilizerKey, player.locale);
  if (item.effect?.type !== 'fertilizer') {
    throw gameError('item_unknown', `${item.name} is not a fertilizer.`, {
      i18nKey: 'errors.farm.not_a_fertilizer',
      params: { item: item.name },
    });
  }

  const now = new Date();
  const modifiers = await farmModifiersFor(player, now);

  return withTransaction(async (tx) => {
    const rows = await farmRepo.listPlots(player.farmId, tx);
    const fertilizable = rows
      .filter(({ plot }) => plot.state !== 'locked')
      .filter(({ plot }) => (input.slot ? plot.slot === input.slot : true))
      .filter(({ plot }) => effectiveFertility(plot, now, balance) < balance.fertility.max);

    if (fertilizable.length === 0) {
      throw gameError('invalid_state', 'No plot can be fertilized further.', {
        i18nKey: 'errors.farm.fully_fertilized',
      });
    }

    // Autant de parcelles que de sacs : 3 sacs pour 9 parcelles en fertilisent
    // 3, au lieu d'échouer sur « Il vous faut 9× ». Sans aucun sac, `consume`
    // ci-dessous garde son refus habituel.
    const owned = await inventoryRepo.countItem(player.id, input.fertilizerKey, tx);
    const candidates = fertilizable.slice(
      0,
      input.all ? Math.max(1, batchCount(fertilizable.length, owned)) : 1,
    );

    await inventoryService.consume(player.id, input.fertilizerKey, candidates.length, tx, player.locale);
    await consumeEnergy(player.id, 'fertilize', tx, {
      quantity: 1,
      costReduction: modifiers.energyCostReduction,
      now,
    });

    let lastFertility = 0;
    for (const { plot, crop } of candidates) {
      const applied = applyFertilizer(
        effectiveFertility(plot, now, balance),
        item.effect ?? {},
        balance,
      );
      lastFertility = applied.fertility;
      await farmRepo.updatePlot(
        plot.id,
        { fertility: applied.fertility, fallowUntil: null },
        tx,
      );
      if (crop) {
        await farmRepo.updatePlantedCrop(
          crop.id,
          {
            fertilizerKey: input.fertilizerKey,
            fertilizerBoost: Math.max(Number(crop.fertilizerBoost), applied.yieldBoost).toFixed(3),
            qualityBoost: Math.max(Number(crop.qualityBoost), applied.qualityBoost).toFixed(3),
          },
          tx,
        );
      }
    }

    const tracking = await trackAction(
      { userId: player.id, coopId: player.coopId, level: player.level },
      'fertilize_plot',
      candidates.length,
      {},
      tx,
    );

    return {
      slots: candidates.map(({ plot }) => plot.slot),
      fertilizer: `${item.emoji} ${item.name}`,
      fertilityAfter: lastFertility,
      tracking,
    };
  });
}

export async function weed(
  player: PlayerContext,
  input: { slot?: number; all?: boolean },
): Promise<{ slots: number[]; weedsCollected: number }> {
  const balance = getBalance();
  const now = new Date();
  const modifiers = await farmModifiersFor(player, now);

  return withTransaction(async (tx) => {
    const rows = await farmRepo.listPlots(player.farmId, tx);
    const candidates = rows
      .filter(({ plot }) => plot.state !== 'locked')
      .filter(({ plot }) => (input.slot ? plot.slot === input.slot : true))
      .filter(({ plot }) => currentWeedLevel(plot, now, balance) > 0)
      .slice(0, input.all ? 64 : 1);

    if (candidates.length === 0) {
      throw gameError('invalid_state', 'No weeds to pull. Nice work!', {
        i18nKey: 'errors.farm.no_weeds',
      });
    }

    await consumeEnergy(player.id, 'weed', tx, {
      quantity: 1,
      costReduction: modifiers.energyCostReduction,
      now,
    });

    // Désherber produit des mauvaises herbes, matière première du compost :
    // une corvée qui rapporte est une corvée qu'on fait.
    const weedsCollected = candidates.length * balance.weeds.weedsPerClear;
    // `lastWeededAt` est l'essentiel : remettre `weedLevel` à zéro sans déplacer
    // l'origine du temps ne retirait que le socle stocké — au plus 3 points sur
    // 100 — et la pénalité revenait intacte à la lecture suivante.
    await farmRepo.updatePlots(
      candidates.map(({ plot }) => plot.id),
      { weedLevel: 0, lastWeededAt: now },
      tx,
    );
    await inventoryService.addItems(player.id, [{ itemKey: 'weeds', quantity: weedsCollected }], tx);

    return { slots: candidates.map(({ plot }) => plot.slot), weedsCollected };
  });
}

export async function treatPest(
  player: PlayerContext,
  input: { slot: number },
): Promise<{ slot: number; pestType: PestType; usedItem: boolean; tracking: TrackResult }> {
  const now = new Date();
  const modifiers = await farmModifiersFor(player, now);

  return withTransaction(async (tx) => {
    const plot = await farmRepo.lockPlot(tx, player.farmId, input.slot);
    if (!plot) {
      throw gameError('plot_not_found', `Plot ${input.slot} not found.`, {
        i18nKey: 'errors.plot_not_found',
        params: { slot: input.slot },
      });
    }
    if (!plot.pestType) {
      throw gameError('no_pest', `Plot ${input.slot} has no pest.`, {
        i18nKey: 'errors.farm.no_pest',
        params: { slot: input.slot },
      });
    }

    // Le traitement bio accélère : s'il n'en a pas, le joueur traite à la main
    // pour un coût d'énergie plus élevé. On ne bloque jamais l'action.
    const hasPesticide = await inventoryService.has(player.id, 'pesticide', 1, tx);
    if (hasPesticide) {
      await inventoryService.consume(player.id, 'pesticide', 1, tx, player.locale);
    }
    await consumeEnergy(player.id, 'treat', tx, {
      quantity: hasPesticide ? 1 : 2,
      costReduction: modifiers.energyCostReduction,
      now,
    });

    await farmRepo.updatePlot(
      plot.id,
      { pestType: null, pestAppearedAt: null, pestDeadlineAt: null },
      tx,
    );

    const tracking = await trackAction(
      { userId: player.id, coopId: player.coopId, level: player.level },
      'treat_pest',
      1,
      {},
      tx,
    );

    return {
      slot: plot.slot,
      pestType: plot.pestType,
      usedItem: hasPesticide,
      tracking,
    };
  });
}

// ---------------------------------------------------------------------------
// ACHETER UNE PARCELLE
// ---------------------------------------------------------------------------

export interface BuyPlotResult {
  slot: number;
  cost: number;
  unlockedPlots: number;
  grid: { width: number; height: number };
  nextCost: number;
  tracking: TrackResult;
}

export async function buyPlot(player: PlayerContext): Promise<BuyPlotResult> {
  const balance = getBalance();

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const rows = await farmRepo.listPlots(player.farmId, tx);
    const next = rows.find(({ plot }) => plot.state === 'locked');

    if (!next) {
      throw gameError(
        'invalid_state',
        `You already own all ${balance.plots.maxPlots} plots. Well done!`,
        { i18nKey: 'errors.farm.all_plots_owned', params: { max: balance.plots.maxPlots } },
      );
    }

    const cost = plotUnlockCost(next.plot.slot, balance);
    await economyService.charge(
      {
        userId: player.id,
        amount: cost,
        type: 'plot_purchase',
        metadata: { slot: next.plot.slot },
      },
      tx,
    );

    const unlocked = await farmRepo.unlockPlot(tx, player.farmId, next.plot.slot);
    if (!unlocked) {
      // Un autre clic a déjà débloqué cette parcelle : on annule pour ne pas
      // facturer deux fois.
      throw gameError('busy', 'That plot was just unlocked.', {
        i18nKey: 'errors.farm.plot_just_unlocked',
      });
    }

    const unlockedCount = await farmRepo.countUnlockedPlots(player.farmId, tx);
    const grid = gridSizeFor(unlockedCount, balance);
    await playerRepo.updateFarm(
      player.farmId,
      {
        gridWidth: grid.width,
        gridHeight: grid.height,
        warehouseCapacity: undefined,
      },
      tx,
    );

    const tracking = await trackAction(
      { userId: player.id, coopId: player.coopId, level: player.level },
      'buy_plot',
      1,
      {},
      tx,
    );
    await economyService.trackSpending(
      { userId: player.id, coopId: player.coopId, level: player.level },
      cost,
      tx,
    );

    const followingSlot = rows.find(
      ({ plot }) => plot.state === 'locked' && plot.slot > next.plot.slot,
    )?.plot.slot;

    return {
      slot: next.plot.slot,
      cost,
      unlockedPlots: unlockedCount,
      grid: { width: grid.width, height: grid.height },
      nextCost: followingSlot ? plotUnlockCost(followingSlot, balance) : 0,
      tracking,
    };
  });
}

// ---------------------------------------------------------------------------
// AIDER UN AUTRE JOUEUR
// ---------------------------------------------------------------------------

export async function helpFarmer(
  helper: PlayerContext,
  hostFarmId: string,
): Promise<{ plotsWatered: number }> {
  const now = new Date();

  return withTransaction(async (tx) => {
    const rows = await farmRepo.listPlots(hostFarmId, tx);
    const needsWater = rows.filter(({ crop }) => {
      if (!crop || crop.withered) return false;
      return computeWaterStatus(
        {
          plantedAt: crop.plantedAt,
          growthSeconds: crop.growthSeconds,
          waterNeeded: crop.waterNeeded,
          waterGiven: crop.waterGiven,
        },
        now,
        0,
      ).needsWater;
    });

    const cropIds = needsWater
      .map(({ crop }) => crop?.id)
      .filter((id): id is string => id !== undefined);
    const watered = await farmRepo.waterCrops(cropIds, now, tx);

    // L'aidant est enregistré sur chaque culture : sa contribution donnera un
    // bonus de rendement à l'hôte lors de la récolte.
    for (const id of cropIds) {
      await farmRepo.addHelper(id, helper.id, tx);
    }

    await playerRepo.incrementStats(helper.id, { totalHelpGiven: watered }, tx);
    return { plotsWatered: watered };
  });
}

function emptyTracking(): TrackResult {
  return {
    completedQuests: [],
    unlockedAchievements: [],
    completedCoopObjectives: [],
    eventPoints: 0,
  };
}

/** Cultures plantables par un joueur, pour l'autocomplétion de `/plant`. */
export async function plantableCrops(
  userId: string,
  level: number,
  query: string,
  locale?: string,
): Promise<Array<{ crop: CropConfig; owned: number }>> {
  const config = getConfig(locale);
  const seeds = await inventoryRepo.listSeeds(userId, getDb());
  const ownedBySeed = new Map(seeds.map((seed) => [seed.itemKey, seed.quantity]));
  const needle = query.trim().toLowerCase();

  return config.cropList
    .filter((crop) => crop.enabled && crop.requiredLevel <= level)
    .map((crop) => ({ crop, owned: ownedBySeed.get(seedKeyOf(crop.key)) ?? 0 }))
    .filter((entry) => entry.owned > 0)
    .filter((entry) => !needle || entry.crop.name.toLowerCase().includes(needle) || entry.crop.key.includes(needle))
    .slice(0, 25);
}
