import { getConfig, type EventConfig } from '../config';
import { lockUserRow, withTransaction } from '../db/client';
import { gameError } from '../utils/errors';
import * as progressionRepo from '../repositories/progression.repo';
import * as economyService from './economy.service';
import * as inventoryService from './inventory.service';
import { grantXp } from './player.service';
import { eventOccurrenceKey, getActiveEvents } from './world.service';
import type { PlayerContext } from '../types';

/**
 * Paliers de récompense et boutique des événements.
 *
 * `events.json` décrivait des paliers et une boutique pour chaque grand
 * événement, mais rien ne permettait de les réclamer ni d'y acheter quoi que
 * ce soit : `claimEventTier` n'avait aucun appelant. Ce module les branche.
 *
 * Règles tenues ici :
 *  - un palier est identifié par son seuil de points (`rewardTiers[].points`) ;
 *  - points, paliers et achats valent pour UNE occurrence de l'événement
 *    (`eventOccurrenceKey`) et repartent de zéro à la suivante ;
 *  - `shopItems[].stock` est une limite PAR JOUEUR et par occurrence ;
 *  - un article se paie dans la monnaie de l'article, à défaut celle de
 *    l'événement, à défaut en pièces.
 */

export interface EventShopEntry {
  itemKey: string;
  name: string;
  emoji: string;
  price: number;
  /** Clé de l'objet-monnaie, ou `null` pour un prix en pièces. */
  currencyItemKey: string | null;
  limit: number;
  bought: number;
  remaining: number;
}

export interface EventStatus {
  points: number;
  claimedTiers: number[];
  /** Seuils atteints et pas encore réclamés. */
  claimableTiers: number[];
  shop: EventShopEntry[];
  /** Solde du joueur par objet-monnaie utilisé par la boutique. */
  balances: Record<string, number>;
}

function requireActiveEvent(eventKey: string, now: Date, locale?: string): EventConfig {
  const event = getActiveEvents(now, locale).find((entry) => entry.key === eventKey);
  if (!event) {
    throw gameError('invalid_state', 'This event is not running.', {
      i18nKey: 'errors.event.not_active',
    });
  }
  return event;
}

function shopCurrency(
  event: EventConfig,
  shopItem: EventConfig['shopItems'][number],
): string | null {
  return shopItem.currencyItemKey ?? event.currencyItemKey ?? null;
}

/** Progression du joueur sur l'occurrence EN COURS de l'événement. */
export async function getEventStatus(
  userId: string,
  event: EventConfig,
  locale?: string,
): Promise<EventStatus> {
  const config = getConfig(locale);
  const row = await progressionRepo.getUserEvent(userId, event.key);
  const progress = (row?.progress ?? {}) as progressionRepo.UserEventProgress;
  const current = row !== undefined && progress.occurrence === eventOccurrenceKey(event);

  const points = current ? row.points : 0;
  const claimedTiers = current ? row.claimedTiers : [];
  const purchases = current ? (progress.purchases ?? {}) : {};

  const currencies = new Set<string>();
  const shop: EventShopEntry[] = [];
  for (const shopItem of event.shopItems) {
    const item = config.items.get(shopItem.itemKey);
    if (!item) continue;
    const currency = shopCurrency(event, shopItem);
    if (currency) currencies.add(currency);
    const bought = purchases[shopItem.itemKey] ?? 0;
    shop.push({
      itemKey: shopItem.itemKey,
      name: item.name,
      emoji: item.emoji,
      price: shopItem.price,
      currencyItemKey: currency,
      limit: shopItem.stock,
      bought,
      remaining: Math.max(0, shopItem.stock - bought),
    });
  }
  if (event.currencyItemKey) currencies.add(event.currencyItemKey);

  const balances: Record<string, number> = {};
  for (const currency of currencies) {
    balances[currency] = await inventoryService.count(userId, currency);
  }

  return {
    points,
    claimedTiers,
    claimableTiers: event.rewardTiers
      .filter((tier) => tier.points <= points && !claimedTiers.includes(tier.points))
      .map((tier) => tier.points),
    shop,
    balances,
  };
}

export interface EventClaimResult {
  tiers: number[];
  coins: number;
  gems: number;
  xp: number;
  items: Array<{ itemKey: string; quantity: number }>;
  titles: string[];
}

/**
 * Réclame TOUS les paliers atteints et non réclamés, dans une seule
 * transaction. Idempotent : un double clic ne paie qu'une fois, la seconde
 * réclamation ne trouve plus rien (`claimEventTier` filtre en SQL).
 */
export async function claimEventRewards(
  player: PlayerContext,
  eventKey: string,
  now: Date = new Date(),
): Promise<EventClaimResult> {
  const event = requireActiveEvent(eventKey, now, player.locale);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const row = await progressionRepo.lockUserEventOccurrence(
      tx,
      player.id,
      event.key,
      eventOccurrenceKey(event),
    );

    const result: EventClaimResult = { tiers: [], coins: 0, gems: 0, xp: 0, items: [], titles: [] };
    const tiers = [...event.rewardTiers].sort((a, b) => a.points - b.points);
    for (const tier of tiers) {
      if (tier.points > row.points || row.claimedTiers.includes(tier.points)) continue;
      const claimed = await progressionRepo.claimEventTier(player.id, event.key, tier.points, tx);
      if (!claimed) continue;

      const rewards = tier.rewards;
      const reference = { referenceType: 'event', referenceId: `${event.key}:${tier.points}` };
      if (rewards.coins) {
        await economyService.pay(
          { userId: player.id, amount: rewards.coins, type: 'event_reward', ...reference },
          tx,
        );
        result.coins += rewards.coins;
      }
      if (rewards.gems) {
        await economyService.pay(
          { userId: player.id, amount: rewards.gems, currency: 'gems', type: 'event_reward', ...reference },
          tx,
        );
        result.gems += rewards.gems;
      }
      if (rewards.items?.length) {
        // Récompense : ne peut pas être refusée sans être perdue.
        await inventoryService.addItems(player.id, rewards.items, tx, { allowOverflow: true });
        result.items.push(...rewards.items);
      }
      if (rewards.xp) {
        await grantXp(player.id, rewards.xp, tx);
        result.xp += rewards.xp;
      }
      if (rewards.title) {
        await progressionRepo.setUserTitle(tx, player.id, rewards.title);
        result.titles.push(rewards.title);
      }
      // `animalKey` (dragonnet du Réveil du dragon, événement désactivé) n'est
      // pas distribué : il demande un bâtiment libre et relève d'un autre chantier.
      result.tiers.push(tier.points);
    }

    if (result.tiers.length === 0) {
      throw gameError('invalid_state', 'No reward tier to claim.', {
        i18nKey: 'errors.event.nothing_to_claim',
      });
    }
    return result;
  });
}

export interface EventPurchaseResult {
  itemKey: string;
  name: string;
  emoji: string;
  quantity: number;
  cost: number;
  currencyItemKey: string | null;
  remaining: number;
}

/**
 * Achète un article de la boutique d'événement. Le paiement (jetons consommés
 * ou pièces débitées), la limite par joueur et la livraison tiennent dans une
 * seule transaction : un entrepôt plein ou des jetons manquants annulent tout.
 */
export async function buyEventItem(
  player: PlayerContext,
  input: { eventKey: string; itemKey: string; quantity: number; discordGuildId?: string },
  now: Date = new Date(),
): Promise<EventPurchaseResult> {
  const event = requireActiveEvent(input.eventKey, now, player.locale);
  const shopItem = event.shopItems.find((entry) => entry.itemKey === input.itemKey);
  if (!shopItem) {
    throw gameError('not_found', 'This item is not sold during the event.', {
      i18nKey: 'errors.event.not_in_shop',
    });
  }
  const item = inventoryService.requireItem(shopItem.itemKey, player.locale);
  const quantity = Math.floor(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 1) {
    throw gameError('quantity_invalid', 'Invalid quantity.', { i18nKey: 'errors.quantity_invalid' });
  }
  const currency = shopCurrency(event, shopItem);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const row = await progressionRepo.lockUserEventOccurrence(
      tx,
      player.id,
      event.key,
      eventOccurrenceKey(event),
    );
    const purchases = ((row.progress ?? {}) as progressionRepo.UserEventProgress).purchases ?? {};
    const bought = purchases[shopItem.itemKey] ?? 0;
    const remaining = Math.max(0, shopItem.stock - bought);
    if (quantity > remaining) {
      throw gameError('forbidden', `Limit of ${shopItem.stock} per player for this event.`, {
        i18nKey: 'errors.event.shop_limit',
        params: { limit: shopItem.stock, remaining },
      });
    }

    const cost = shopItem.price * quantity;
    if (currency) {
      // Retrait atomique (`WHERE quantity >= n`) : lève si les jetons manquent.
      await inventoryService.consume(player.id, currency, cost, tx, player.locale);
    } else {
      await economyService.charge(
        {
          userId: player.id,
          amount: cost,
          type: 'shop_purchase',
          itemKey: shopItem.itemKey,
          quantity,
          unitPrice: shopItem.price,
          discordGuildId: input.discordGuildId,
          referenceType: 'event',
          referenceId: event.key,
        },
        tx,
      );
    }

    // Un achat se refuse sans rien détruire : capacité VÉRIFIÉE.
    await inventoryService.addItems(player.id, [{ itemKey: shopItem.itemKey, quantity }], tx);
    await progressionRepo.recordEventPurchase(tx, row.id, shopItem.itemKey, quantity);

    return {
      itemKey: shopItem.itemKey,
      name: item.name,
      emoji: item.emoji,
      quantity,
      cost,
      currencyItemKey: currency,
      remaining: remaining - quantity,
    };
  });
}

/**
 * Article de boutique vu par le joueur, pour refuser un achat impossible AVANT
 * d'ouvrir la fenêtre de quantité (même logique que `assertPurchasable`).
 * Lève si l'événement est terminé, l'article inconnu ou la limite atteinte.
 */
export async function requireBuyableEntry(
  player: Pick<PlayerContext, 'id' | 'locale'>,
  eventKey: string,
  itemKey: string,
  now: Date = new Date(),
): Promise<EventShopEntry> {
  const event = requireActiveEvent(eventKey, now, player.locale);
  const status = await getEventStatus(player.id, event, player.locale);
  const entry = status.shop.find((candidate) => candidate.itemKey === itemKey);
  if (!entry) {
    throw gameError('not_found', 'This item is not sold during the event.', {
      i18nKey: 'errors.event.not_in_shop',
    });
  }
  if (entry.remaining <= 0) {
    throw gameError('forbidden', `Limit of ${entry.limit} per player for this event.`, {
      i18nKey: 'errors.event.shop_limit',
      params: { limit: entry.limit, remaining: 0 },
    });
  }
  return entry;
}
