import { balance as getBalance, getConfig } from '../config';
import { getRedis, key as redisKey } from '../db/redis';
import { lockUserRow, withTransaction } from '../db/client';
import {
  eligibleFish,
  isDaytime,
  rollFish,
  rollFishQuality,
  scoreCastTiming,
  timingAccuracy,
  type FishConfig,
} from '../game/fishing';
import { qualityMultiplier, type Quality } from '../game/quality';
import { liveRng } from '../game/rng';
import { gameError } from '../utils/errors';
import { scaleMoney } from '../game/money';
import { moduleLogger } from '../utils/logger';
import { uuidv7 } from '../utils/uuid';
import * as inventoryService from './inventory.service';
import { consumeEnergy } from './player.service';
import { trackAction } from './tracker.service';
import { getWorldState } from './world.service';
import type { PlayerContext } from '../types';

const log = moduleLogger('fishing');

/**
 * Pêche : un seul étang, débloqué par niveau, un poisson par prise.
 *
 * L'ÉTAT DE FERRAGE (`CastState`) vit uniquement dans REDIS, avec un TTL
 * légèrement supérieur à la fenêtre de touche : comme les boosts de
 * `consumable.service.ts`, c'est une donnée volatile sans valeur d'audit — si
 * Redis tombe entre le lancer et le ferrage, le joueur perd sa prise en cours,
 * pas une ressource durable. Aucune table n'est nécessaire.
 *
 * La fenêtre de touche est comparée en TIMESTAMPS ABSOLUS (epoch ms), jamais en
 * délais relatifs mesurés côté serveur au moment du clic : ça élimine la
 * latence de traitement de l'équation d'équité, seule la latence réseau du clic
 * lui-même — symétrique pour tous les joueurs — subsiste.
 */

interface CastState {
  userId: string;
  biteAt: number;
  level: number;
  season: string;
  daytime: boolean;
  /**
   * Prise déjà tirée mais pas encore rangée : l'ajout à l'inventaire a échoué
   * (entrepôt plein). Le lancer est remis en place avec elle pour que le joueur
   * puisse la récupérer après avoir fait de la place, sans rejouer le ferrage.
   */
  caught?: { itemKey: string; quality: Quality };
}

/** Délai laissé pour récupérer une prise refusée faute de place. */
const PENDING_CATCH_TTL_SECONDS = 15 * 60;

function castKey(castId: string): string {
  return redisKey('fishing', 'cast', castId);
}

export interface CastResult {
  castId: string;
  biteAt: number;
  windowMs: number;
}

export async function cast(player: PlayerContext, now: Date = new Date()): Promise<CastResult> {
  const balance = getBalance();
  const fishing = balance.fishing;

  if (player.level < fishing.unlockLevel) {
    throw gameError('level_too_low', `Fishing requires level ${fishing.unlockLevel}.`, {
      i18nKey: 'errors.fishing.level_too_low',
      params: { level: fishing.unlockLevel },
      suggestedCommand: 'profile',
    });
  }

  await withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    await consumeEnergy(player.id, 'fish', tx, { now });
  });

  const world = await getWorldState(now);
  const rng = liveRng(`fish-cast:${player.id}`);
  const [minDelay, maxDelay] = fishing.biteDelayMsRange;
  const biteAt = now.getTime() + rng.int(minDelay, maxDelay);
  const castId = uuidv7();

  const state: CastState = {
    userId: player.id,
    biteAt,
    level: player.level,
    season: world.season.season,
    daytime: isDaytime(now.getUTCHours()),
  };

  try {
    const ttlSeconds = Math.ceil((biteAt - now.getTime() + fishing.windowMs) / 1_000) + 30;
    await getRedis().set(castKey(castId), JSON.stringify(state), 'EX', ttlSeconds);
  } catch (error) {
    log.warn({ err: error }, "impossible d'enregistrer le lancer de ligne");
    throw gameError('invalid_state', 'Fishing is temporarily unavailable, please retry.', {
      i18nKey: 'errors.fishing.unavailable',
    });
  }

  return { castId, biteAt, windowMs: fishing.windowMs };
}

export interface CaughtFish {
  itemKey: string;
  name: string;
  emoji: string;
  quality: Quality;
  value: number;
}

export interface HookResult {
  outcome: 'too_early' | 'hit' | 'too_late' | 'expired';
  fish?: CaughtFish;
}

/** Construit le vivier d'espèces disponibles à partir de la configuration chargée. */
function fishPool(config: ReturnType<typeof getConfig>): FishConfig[] {
  return config.itemList
    .filter((item) => item.category === 'fish' && item.enabled)
    .map((item) => ({
      key: item.key,
      rarity: item.rarity,
      requiredLevel: item.requiredLevel,
      seasons: item.seasons,
      timeOfDay: item.timeOfDay,
    }));
}

export async function resolveHook(
  player: PlayerContext,
  castId: string,
  clickAt: number,
): Promise<HookResult> {
  const balance = getBalance();
  const config = getConfig(player.locale);
  const redis = getRedis();

  const raw = await redis.get(castKey(castId)).catch(() => null);
  // Consommé dès la lecture, quel que soit le résultat : un second clic sur le
  // même ferrage (double-clic, ou après coup) ne peut plus rien produire. Le
  // verrou anti-double-clic du framework (lockKey côté bouton) protège la
  // fenêtre entre la lecture et cette suppression.
  if (raw) await redis.del(castKey(castId)).catch(() => undefined);
  if (!raw) return { outcome: 'expired' };

  const state = JSON.parse(raw) as CastState;
  if (state.userId !== player.id) return { outcome: 'expired' };

  let picked: { itemKey: string; quality: Quality } | undefined = state.caught;
  if (!picked) {
    const outcome = scoreCastTiming(clickAt, state.biteAt, balance.fishing.windowMs);
    if (outcome !== 'hit') return { outcome };

    const eligible = eligibleFish(fishPool(config), {
      level: state.level,
      season: state.season,
      daytime: state.daytime,
    });
    const rng = liveRng(`fish-catch:${player.id}:${castId}`);
    const fish = rollFish(eligible, balance, rng);
    if (!fish) return { outcome: 'hit' };

    const accuracy = timingAccuracy(clickAt, state.biteAt, balance.fishing.windowMs);
    picked = { itemKey: fish.key, quality: rollFishQuality(accuracy, balance, rng) };
  }

  const item = config.items.get(picked.itemKey);
  if (!item) return { outcome: 'expired' };
  const quality = picked.quality;
  const value = scaleMoney(item.sellPrice, qualityMultiplier(quality, balance));
  const caught = picked;

  try {
    await withTransaction(async (tx) => {
      await lockUserRow(tx, player.id);
      await inventoryService.addItems(player.id, [{ itemKey: caught.itemKey, quantity: 1, quality }], tx, {
        discover: true,
      });
      await trackAction(
        { userId: player.id, coopId: player.coopId, level: player.level },
        'catch_fish',
        1,
        { itemKey: caught.itemKey, rarity: item.rarity },
        tx,
      );
    });
  } catch (error) {
    // Le lancer a été consommé avant la transaction (anti double-clic) : sans
    // cette remise en place, un entrepôt plein faisait perdre la prise ET
    // l'énergie dépensée au lancer. La prise est conservée telle quelle.
    const pending: CastState = { ...state, caught: { itemKey: caught.itemKey, quality } };
    await redis
      .set(castKey(castId), JSON.stringify(pending), 'EX', PENDING_CATCH_TTL_SECONDS)
      .catch((redisError: unknown) =>
        log.warn({ err: redisError }, 'impossible de remettre en place une prise refusée'),
      );
    throw error;
  }

  return {
    outcome: 'hit',
    fish: { itemKey: caught.itemKey, name: item.name, emoji: item.emoji, quality, value },
  };
}
