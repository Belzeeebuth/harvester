import { balance as getBalance, getConfig, type ItemConfig } from '../config';
import { getDb, lockUserRow, withTransaction, type Executor } from '../db/client';
import { scaleMoney, scaleMoneyUp } from '../game/money';
import {
  auctionCommission,
  describeTrend,
  directSellPrice,
  referenceVolumeFor,
  updatePrice,
  type MarketState,
  type MarketUpdate,
} from '../game/market';
import { qualityMultiplier } from '../game/quality';
import { dailyRng, liveRng } from '../game/rng';
import { gameError, type GameError } from '../utils/errors';
import { translatorFor, DEFAULT_LOCALE } from '../i18n';
import { moduleLogger } from '../utils/logger';
import * as economyRepo from '../repositories/economy.repo';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as inventoryService from './inventory.service';
import * as economyService from './economy.service';
import * as alertService from './alert.service';
import { mergeResults, trackAction, type TrackResult } from './tracker.service';
import { eventPriceMultiplier, getWorldState } from './world.service';
import { toSqlDate } from '../utils/time';
import { uuidv7 } from '../utils/uuid';
import type { PlayerContext } from '../types';
import type { Mutation, Quality } from '../repositories/inventory.repo';

const log = moduleLogger('market');

/**
 * Marché dynamique, vente directe et boutique quotidienne.
 *
 * Le prix affiché à un joueur est le produit de trois facteurs :
 *   prix marché courant (offre/demande globale, cf. game/market.ts)
 *   × multiplicateur de qualité (normal → iridium : ×1 à ×3)
 *   × multiplicateurs d'événement (Moisson d'automne : citrouilles ×2)
 * puis la décote de vente directe et la taxe de vente s'appliquent.
 */

export interface MarketRow {
  itemKey: string;
  name: string;
  emoji: string;
  category: string;
  rarity: string;
  price: number;
  basePrice: number;
  previousPrice: number;
  trend: number;
  trendLabel: string;
  trendEmoji: string;
  demandIndex: number;
  featured: boolean;
  nextUpdateAt: Date;
}

export async function getMarket(
  options: { category?: string } = {},
  locale?: string,
): Promise<MarketRow[]> {
  const config = getConfig(locale);
  const t = translatorFor(locale ?? DEFAULT_LOCALE);
  const world = await getWorldState();
  const rows = await economyRepo.listMarket({ category: options.category });

  return rows.map((row) => {
    const eventMultiplier = eventPriceMultiplier(world, row.itemKey, row.category);
    const trend = Number(row.trend);
    const described = describeTrend(trend);
    return {
      itemKey: row.itemKey,
      // Libellé pris dans la configuration en mémoire : la colonne jointe est
      // peuplée par le seed en français, quelle que soit la locale du joueur.
      name: config.items.get(row.itemKey)?.name ?? row.name,
      emoji: row.emoji,
      category: row.category,
      rarity: row.rarity,
      price: scaleMoney(row.currentPrice, eventMultiplier),
      basePrice: row.basePrice,
      previousPrice: row.previousPrice,
      trend,
      trendLabel: t(described.labelKey),
      trendEmoji: described.emoji,
      demandIndex: Number(row.demandIndex),
      featured: row.featured,
      nextUpdateAt: row.nextUpdateAt,
    };
  });
}

export async function getPriceHistory(
  itemKey: string,
): Promise<Array<{ price: number; recordedAt: Date }>> {
  const balance = getBalance();
  return economyRepo.priceHistory(itemKey, balance.market.historyPointsForChart);
}

/** Prix unitaire effectif d'un objet pour un joueur, qualité comprise. */
export async function effectiveUnitPrice(
  itemKey: string,
  quality: Quality,
  mutation: Mutation,
  executor: Executor = getDb(),
): Promise<number> {
  const config = getConfig();
  const balance = getBalance();
  const item = config.items.get(itemKey);
  if (!item) {
    throw gameError('item_unknown', `Unknown item: ${itemKey}`, {
      i18nKey: 'errors.item_unknown',
      params: { item: itemKey },
    });
  }

  const world = await getWorldState();
  const market = await economyRepo.getMarketPrice(itemKey, executor);
  const base = market?.currentPrice ?? item.sellPrice;
  const mutationMultiplier =
    mutation === 'none' ? 1 : (balance.mutations[mutation]?.priceMultiplier ?? 1);

  return scaleMoney(
    base,
    qualityMultiplier(quality, balance) *
      mutationMultiplier *
      eventPriceMultiplier(world, itemKey, item.category),
  );
}

// ---------------------------------------------------------------------------
// VENTE DIRECTE
// ---------------------------------------------------------------------------

export interface SellResult {
  lines: Array<{
    itemKey: string;
    name: string;
    emoji: string;
    quality: Quality;
    mutation: Mutation;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
  gross: number;
  tax: number;
  net: number;
  tracking: TrackResult;
}

/**
 * Vend un objet (ou tout l'inventaire d'une catégorie) au village.
 *
 * La vente directe applique une décote de 15 % par rapport au prix du marché :
 * c'est le prix de la commodité, et un puits monétaire discret. Les joueurs qui
 * veulent le prix plein passent par l'hôtel des ventes, ce qui crée un marché
 * entre joueurs — exactement l'effet recherché.
 */
export async function sell(
  player: PlayerContext,
  input: {
    itemKey?: string;
    quantity?: number | 'all';
    category?: string;
    quality?: Quality;
    mutation?: Mutation;
    discordGuildId?: string;
  },
): Promise<SellResult> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const world = await getWorldState();

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);

    // Constitution de la liste des piles à vendre.
    const stacks = await inventoryRepo.listInventory(
      player.id,
      { category: input.category, onlySellable: true },
      tx,
    );
    const targets = stacks.filter((stack) => {
      if (stack.locked) return false;
      if (!stack.sellable) return false;
      if (input.itemKey && stack.itemKey !== input.itemKey) return false;
      if (input.quality && stack.quality !== input.quality) return false;
      if (input.mutation && stack.mutation !== input.mutation) return false;
      return true;
    });

    if (targets.length === 0) {
      throw gameError('insufficient_items', "You have nothing matching to sell.", {
        i18nKey: 'errors.market.nothing_to_sell',
        hintKey: 'errors.market.nothing_to_sell_hint',
        suggestedCommand: 'inventory',
      });
    }

    const lines: SellResult['lines'] = [];
    let gross = 0;

    for (const stack of targets) {
      const item = config.items.get(stack.itemKey);
      if (!item) continue;

      const quantity =
        input.quantity === 'all' || input.quantity === undefined
          ? stack.quantity
          : Math.min(stack.quantity, Math.max(1, input.quantity));
      if (quantity <= 0) continue;

      const market = await economyRepo.getMarketPrice(stack.itemKey, tx);
      const marketPrice = market?.currentPrice ?? item.sellPrice;
      const mutationMultiplier =
        stack.mutation === 'none' ? 1 : (balance.mutations[stack.mutation]?.priceMultiplier ?? 1);

      const unitPrice = scaleMoney(
        directSellPrice(marketPrice, balance),
        qualityMultiplier(stack.quality, balance) *
          mutationMultiplier *
          eventPriceMultiplier(world, stack.itemKey, item.category),
      );

      const total = unitPrice * quantity;

      await inventoryService.removeExact(
        player.id,
        { itemKey: stack.itemKey, quality: stack.quality, mutation: stack.mutation },
        quantity,
        tx,
        player.locale,
      );

      // Le volume vendu alimente la pression sur le marché : vendre en masse
      // fera baisser le prix au prochain cycle horaire.
      if (item.marketTracked) {
        await economyRepo.recordSaleVolume(stack.itemKey, quantity, tx);
      }

      lines.push({
        itemKey: stack.itemKey,
        name: item.name,
        emoji: item.emoji,
        quality: stack.quality,
        mutation: stack.mutation,
        quantity,
        unitPrice,
        total,
      });
      gross += total;

      // Une seule pile si l'appelant a demandé une quantité précise.
      if (input.itemKey && input.quantity !== 'all') break;
    }

    if (lines.length === 0 || gross <= 0) {
      throw gameError('insufficient_items', 'Nothing to sell.', {
        i18nKey: 'errors.market.nothing_to_sell',
      });
    }

    const { net, tax } = economyService.applySalesTax(gross, player.level);
    await economyService.pay(
      {
        userId: player.id,
        amount: net,
        type: 'market_sale',
        quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
        itemKey: lines.length === 1 ? lines[0]!.itemKey : undefined,
        discordGuildId: input.discordGuildId,
        metadata: { gross, tax, lines: lines.length },
      },
      tx,
    );

    const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
    // Séquentiel : une transaction ne dispose que d'un client PostgreSQL, un
    // `Promise.all` n'y parallélise rien et brouille l'ordre des écritures.
    const trackContext = { userId: player.id, coopId: player.coopId, level: player.level };
    const tracking: TrackResult[] = [];
    tracking.push(await trackAction(trackContext, 'sell_item', totalQuantity, {}, tx));
    tracking.push(await trackAction(trackContext, 'sell_value', gross, {}, tx));
    tracking.push(await trackAction(trackContext, 'earn_coins', net, {}, tx));

    log.debug({ userId: player.id, gross, net, tax, lines: lines.length }, 'vente au village');

    return {
      lines,
      gross,
      tax,
      net,
      tracking: mergeResults(tracking),
    };
  });
}

// ---------------------------------------------------------------------------
// BOUTIQUE QUOTIDIENNE
// ---------------------------------------------------------------------------

export interface ShopEntry {
  id: string;
  itemKey: string;
  name: string;
  emoji: string;
  category: string;
  rarity: string;
  price: number;
  currency: 'coins' | 'gems';
  discountPercent: number;
  stockRemaining: number;
  stockTotal: number;
  requiredLevel: number;
  featured: boolean;
  description: string | null;
  expiresAt: Date;
}

/** Catégorie réservée au marché noir dans `shop_stock` — exclue de la boutique normale. */
const BLACK_MARKET_CATEGORY = 'black_market';

function toShopEntries(
  rows: Awaited<ReturnType<typeof economyRepo.listShopStock>>,
  config: ReturnType<typeof getConfig>,
): ShopEntry[] {
  return rows.map((row) => ({
    id: row.id,
    itemKey: row.itemKey,
    name: config.items.get(row.itemKey)?.name ?? row.name,
    emoji: row.emoji,
    category: row.category,
    rarity: row.rarity,
    price: row.price,
    currency: row.currency,
    discountPercent: row.discountPercent,
    stockRemaining: row.stockRemaining,
    stockTotal: row.stockTotal,
    requiredLevel: row.requiredLevel,
    featured: row.featured,
    description: config.items.get(row.itemKey)?.description ?? row.description,
    expiresAt: row.expiresAt,
  }));
}

function levelTooLow(level: number): GameError {
  return gameError('level_too_low', `This article requires level ${level}.`, {
    i18nKey: 'errors.market.item_level_too_low',
    params: { level },
  });
}

function outOfStock(remaining: number): GameError {
  return gameError('not_found', `Not enough stock: only ${remaining} unit(s) left.`, {
    i18nKey: 'errors.market.out_of_stock',
    params: { remaining },
  });
}

/** Article en vente aujourd'hui (boutique ou marché noir), ou `undefined`. */
export async function findShopEntry(
  itemKey: string,
  now: Date = new Date(),
  locale?: string,
): Promise<ShopEntry | undefined> {
  const rows = (await economyRepo.listShopStock(toSqlDate(now))).filter((row) => row.itemKey === itemKey);
  return toShopEntries(rows, getConfig(locale))[0];
}

/**
 * Refus connus AVANT l'achat : niveau insuffisant, rupture. Le menu de la
 * boutique liste aussi ces articles (voir `shopChoices`) ; on les refuse donc
 * avant d'ouvrir un modal de quantité voué à l'échec. `buy` refait ces contrôles
 * sous verrou : ceci n'est qu'un raccourci d'affichage, pas une garantie.
 */
export function assertPurchasable(player: Pick<PlayerContext, 'level'>, entry: ShopEntry): void {
  if (player.level < entry.requiredLevel) throw levelTooLow(entry.requiredLevel);
  if (entry.stockRemaining <= 0) {
    throw gameError('not_found', 'This item is sold out for today.', { i18nKey: 'errors.market.sold_out' });
  }
}

export async function getShop(now: Date = new Date(), locale?: string): Promise<ShopEntry[]> {
  const config = getConfig(locale);
  const rotationDate = toSqlDate(now);
  const dailyRows = (row: { category: string }): boolean => row.category !== BLACK_MARKET_CATEGORY;
  let rows = (await economyRepo.listShopStock(rotationDate)).filter(dailyRows);

  // Auto-réparation : si le job de rotation n'a pas tourné (démarrage à froid,
  // panne), on génère le stock du jour à la demande. Le joueur ne voit jamais
  // une boutique vide.
  if (rows.length === 0) {
    await rotateShop(now);
    rows = (await economyRepo.listShopStock(rotationDate)).filter(dailyRows);
  }

  return toShopEntries(rows, config);
}

/**
 * Boutique de contrebande : contenu rare (produits transformés et animaliers
 * épiques et au-delà), stock symbolique, prix très au-dessus du prix de vente —
 * c'est un puits monétaire pour les joueurs de fin de partie qui n'ont plus
 * rien à acheter, pas une bonne affaire.
 */
export async function getBlackMarket(now: Date = new Date(), locale?: string): Promise<ShopEntry[]> {
  const config = getConfig(locale);
  const rotationDate = toSqlDate(now);
  const blackMarketRows = (row: { category: string }): boolean => row.category === BLACK_MARKET_CATEGORY;
  let rows = (await economyRepo.listShopStock(rotationDate)).filter(blackMarketRows);

  if (rows.length === 0) {
    await rotateBlackMarket(now);
    rows = (await economyRepo.listShopStock(rotationDate)).filter(blackMarketRows);
  }

  return toShopEntries(rows, config);
}

/** Génère la rotation du jour pour le marché noir (voir `rotateShop` pour la boutique normale). */
export async function rotateBlackMarket(now: Date = new Date()): Promise<number> {
  const config = getConfig();
  const balance = getBalance();
  const bm = balance.blackMarket;
  const rotationDate = toSqlDate(now);
  const rng = dailyRng('black_market', rotationDate);
  const expiresAt = new Date(`${rotationDate}T23:59:59.000Z`);

  // Produits transformés et animaliers rares : jamais vendus autrement contre
  // pièces, ce qui garantit qu'un même objet ne peut pas apparaître à la fois
  // ici et dans la boutique du jour le même jour.
  const pool = config.itemList.filter(
    (item) =>
      item.enabled &&
      ['product', 'animal_product'].includes(item.category) &&
      ['epic', 'legendary', 'mythic'].includes(item.rarity) &&
      item.sellPrice > 0,
  );

  const [minStock, maxStock] = bm.stockRange;
  const picked = rng.shuffle(pool).slice(0, bm.slots);

  const rows: Array<Parameters<typeof economyRepo.insertShopStock>[0][number]> = picked.map((item) => {
    const stockTotal = rng.int(minStock, maxStock);
    return {
      id: uuidv7(),
      itemKey: item.key,
      rotationDate,
      category: BLACK_MARKET_CATEGORY,
      // Arrondi à la baisse comme partout ailleurs (`money.ts`) : c'est un prix
      // affiché au joueur, il doit suivre la même règle que le reste.
      price: Math.max(1, scaleMoney(item.sellPrice, bm.priceMultiplier)),
      currency: 'coins' as const,
      discountPercent: 0,
      stockTotal,
      stockRemaining: stockTotal,
      perUserLimit: 1,
      requiredLevel: Math.max(item.requiredLevel, bm.minLevel),
      featured: false,
      expiresAt,
    };
  });

  await economyRepo.insertShopStock(rows);
  log.info({ rotationDate, entries: rows.length }, 'black market generated');
  return rows.length;
}

/**
 * Génère la rotation du jour.
 *
 * Le tirage est DÉTERMINISTE (graine = date) : tous les shards produisent la
 * même boutique sans se coordonner, et l'on peut reproduire la boutique d'hier
 * pour instruire une réclamation. Les graines de base sont toujours présentes —
 * un débutant ne doit jamais tomber sur une boutique où il ne peut rien acheter.
 */
export async function rotateShop(now: Date = new Date()): Promise<number> {
  const config = getConfig();
  const balance = getBalance();
  const rotationDate = toSqlDate(now);
  const rng = dailyRng('shop', rotationDate);
  const expiresAt = new Date(`${rotationDate}T23:59:59.000Z`);

  const rows: Array<Parameters<typeof economyRepo.insertShopStock>[0][number]> = [];

  // 1. Graines des cinq premières cultures : socle permanent.
  const basicSeeds = config.cropList
    .filter((crop) => crop.enabled && crop.requiredLevel <= 5)
    .slice(0, 5);
  for (const crop of basicSeeds) {
    rows.push({
      id: uuidv7(),
      itemKey: `seed_${crop.key}`,
      rotationDate,
      category: 'seeds',
      price: crop.seedPrice,
      currency: 'coins',
      stockTotal: 999,
      stockRemaining: 999,
      requiredLevel: crop.requiredLevel,
      expiresAt,
    });
  }

  // 2. Nourriture et matériaux : toujours disponibles, sans quoi l'élevage et la
  // construction se bloquent.
  for (const itemKey of ['feed_grain', 'feed_hay', 'feed_premium', 'flower_pollen', 'wood', 'stone', 'clay', 'iron_bar']) {
    const item = config.items.get(itemKey);
    if (!item) continue;
    rows.push({
      id: uuidv7(),
      itemKey,
      rotationDate,
      category: 'supplies',
      price: item.basePrice,
      currency: 'coins',
      stockTotal: 999,
      stockRemaining: 999,
      requiredLevel: item.requiredLevel,
      expiresAt,
    });
  }

  // 3. Emplacements tournants : consommables, outils, graines rares, cosmétiques.
  const pool = config.itemList.filter(
    (item) =>
      item.enabled &&
      item.basePrice + item.priceGems > 0 &&
      ['consumable', 'tool', 'seed', 'cosmetic'].includes(item.category) &&
      !rows.some((row) => row.itemKey === item.key),
  );

  const picked = rng.shuffle(pool).slice(0, balance.shop.dailySlots);
  const [minDiscount, maxDiscount] = balance.shop.discountRange;
  const [minStock, maxStock] = balance.shop.stockRange;

  picked.forEach((item: ItemConfig, index: number) => {
    const discount = rng.chance(balance.shop.discountChance)
      ? rng.int(minDiscount, maxDiscount)
      : 0;
    const useGems = item.priceGems > 0 && item.basePrice === 0;
    const basePrice = useGems ? item.priceGems : item.basePrice;
    rows.push({
      id: uuidv7(),
      itemKey: item.key,
      rotationDate,
      category: 'daily',
      // Prix payé par le joueur : arrondi au supérieur (money.ts), jamais au plus proche.
      price: Math.max(1, scaleMoneyUp(basePrice, (100 - discount) / 100)),
      currency: useGems ? 'gems' : 'coins',
      discountPercent: discount,
      stockTotal: rng.int(minStock, maxStock),
      stockRemaining: 0,
      perUserLimit: item.category === 'cosmetic' ? 1 : 0,
      requiredLevel: item.requiredLevel,
      featured: index < balance.shop.featuredCount,
      expiresAt,
    });
  });

  // `stockRemaining` doit refléter `stockTotal` : on le corrige après tirage.
  for (const row of rows) {
    if (row.category === 'daily') row.stockRemaining = row.stockTotal;
  }

  await economyRepo.insertShopStock(rows);

  // Objets vedettes du marché : bonus de prix de vente temporaire.
  const marketItems = config.itemList.filter((item) => item.marketTracked && item.enabled);
  const featured = rng.shuffle(marketItems).slice(0, balance.market.featuredCount);
  await withTransaction(async (tx) => {
    await economyRepo.setFeatured(
      featured.map((item: ItemConfig) => item.key),
      tx,
    );
  });

  log.info({ rotationDate, entries: rows.length }, 'daily shop generated');
  return rows.length;
}

export interface BuyResult {
  itemKey: string;
  name: string;
  emoji: string;
  quantity: number;
  unitPrice: number;
  total: number;
  currency: 'coins' | 'gems';
  stockRemaining: number;
}

/**
 * Achat en boutique.
 * L'ordre est capital : on réserve le STOCK avant de débiter. Si le débit
 * échoue, la transaction est annulée et le stock revient — l'inverse permettrait
 * de « perdre » du stock sans paiement en cas d'échec.
 */
export async function buy(
  player: PlayerContext,
  input: { itemKey: string; quantity: number; discordGuildId?: string },
): Promise<BuyResult> {
  const item = inventoryService.requireItem(input.itemKey, player.locale);
  const quantity = Math.max(1, Math.floor(input.quantity));
  const rotationDate = toSqlDate(new Date());

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const stock = (await economyRepo.listShopStock(rotationDate, tx)).find(
      (row) => row.itemKey === input.itemKey,
    );

    if (!stock) {
      throw gameError('not_found', `${item.emoji} ${item.name} is not on sale today.`, {
        i18nKey: 'errors.market.not_on_sale',
        hintKey: 'errors.market.not_on_sale_hint',
        params: { emoji: item.emoji, item: item.name },
        suggestedCommand: 'shop',
      });
    }
    if (player.level < stock.requiredLevel) throw levelTooLow(stock.requiredLevel);
    // Limite PAR JOUEUR, cumulée sur la journée — et non par achat. La
    // comparaison portait auparavant sur la seule quantité demandée : un joueur
    // bloqué à 1 exemplaire en achetait dix en dix commandes, ce qui vidait de
    // son sens la rareté des cosmétiques et du marché noir.
    if (stock.perUserLimit > 0) {
      const already = await economyRepo.countUserPurchases(player.id, stock.id, tx);
      if (already + quantity > stock.perUserLimit) {
        throw gameError(
          'forbidden',
          `Limit of ${stock.perUserLimit} unit(s) per player for this article.`,
          {
            i18nKey: 'errors.market.per_user_limit',
            params: { limit: stock.perUserLimit },
            context: { already, requested: quantity },
          },
        );
      }
    }

    const reserved = await economyRepo.reserveShopStock(stock.id, quantity, tx);
    if (!reserved) throw outOfStock(stock.stockRemaining);

    const total = stock.price * quantity;
    await economyService.charge(
      {
        userId: player.id,
        amount: total,
        type: 'shop_purchase',
        currency: stock.currency,
        itemKey: input.itemKey,
        quantity,
        unitPrice: stock.price,
        discordGuildId: input.discordGuildId,
      },
      tx,
    );

    await inventoryService.addItems(
      player.id,
      [{ itemKey: input.itemKey, quantity }],
      tx,
    );

    if (stock.perUserLimit > 0) {
      await economyRepo.recordUserPurchase(player.id, stock.id, quantity, tx);
    }

    if (stock.currency === 'coins') {
      await economyService.trackSpending(
        { userId: player.id, coopId: player.coopId, level: player.level },
        total,
        tx,
      );
    }

    return {
      itemKey: input.itemKey,
      name: item.name,
      emoji: item.emoji,
      quantity,
      unitPrice: stock.price,
      total,
      currency: stock.currency,
      stockRemaining: Math.max(0, stock.stockRemaining - quantity),
    };
  });
}

// ---------------------------------------------------------------------------
// MISE À JOUR HORAIRE DU MARCHÉ
// ---------------------------------------------------------------------------

/**
 * Recalcule tous les prix. Exécuté par le scheduler toutes les heures.
 * Le RNG est semé par l'heure : deux exécutions du même cycle (relance après
 * incident) produisent le même résultat, donc pas de double variation.
 */
export async function updateMarket(now: Date = new Date()): Promise<number> {
  const config = getConfig();
  const balance = getBalance();
  // Une seule lecture pour tout le marché : la version précédente listait les
  // prix puis relisait CHAQUE ligne une par une dans la transaction, soit une
  // centaine d'allers-retours séquentiels par heure pour des données déjà
  // chargées.
  const prices = await economyRepo.listMarketPrices();
  const nextUpdateAt = new Date(now.getTime() + balance.market.updateMinutes * 60_000);
  const rng = dailyRng('market', `${toSqlDate(now)}-${now.getUTCHours()}`);

  let updated = 0;
  // Les prix écrits sont conservés pour l'évaluation des alertes : relire la
  // table après la transaction coûterait une requête de plus pour retrouver
  // exactement ce que l'on vient d'écrire.
  const updates: MarketUpdate[] = [];
  await withTransaction(async (tx) => {
    for (const price of prices) {
      const item = config.items.get(price.itemKey);
      if (!item) continue;

      const state: MarketState = {
        itemKey: price.itemKey,
        basePrice: price.basePrice,
        currentPrice: price.currentPrice,
        previousPrice: price.previousPrice,
        demandIndex: Number(price.demandIndex),
        volumeWindow: price.volumeWindow,
        referenceVolume: price.referenceVolume,
        volatility: Number(price.volatility),
        priceFloorPct: Number(price.priceFloorPct),
        priceCeilPct: Number(price.priceCeilPct),
        featured: price.featured,
      };

      const update = updatePrice(state, balance, rng);
      await economyRepo.applyMarketUpdate(update, nextUpdateAt, tx);
      updates.push(update);
      updated += 1;
    }
  });

  log.info({ updated, nextUpdateAt }, 'market updated');

  // Alertes de prix, APRÈS la validation des prix : elles doivent voir des
  // prix réellement écrits, et un incident sur les alertes (notification en
  // échec, base indisponible entre-temps) ne doit jamais annuler la mise à
  // jour du marché — l'évaluation est rejouée au cycle suivant, de façon
  // idempotente.
  try {
    await alertService.evaluate(
      updates.map((update) => ({ itemKey: update.itemKey, price: update.price })),
      now,
    );
  } catch (error) {
    log.error({ err: error }, 'évaluation des alertes de prix en échec');
  }

  return updated;
}

/** Initialise les lignes de marché manquantes (seed et rattrapage). */
export async function ensureMarketRows(): Promise<number> {
  const config = getConfig();
  const balance = getBalance();
  let created = 0;

  // Un seul chargement des lignes existantes : une requête par objet au
  // démarrage, sur plusieurs centaines d'objets, retardait le boot pour rien.
  const existingKeys = new Set(
    (await economyRepo.listMarketPrices()).map((row) => row.itemKey),
  );

  for (const item of config.itemList) {
    if (!item.marketTracked || !item.enabled || item.sellPrice <= 0) continue;
    if (existingKeys.has(item.key)) continue;

    await economyRepo.upsertMarketPrice({
      itemKey: item.key,
      basePrice: item.sellPrice,
      currentPrice: item.sellPrice,
      previousPrice: item.sellPrice,
      referenceVolume: referenceVolumeFor(item.rarity, balance),
      volatility: balance.market.volatility.toFixed(4),
      priceFloorPct: balance.market.priceFloorPct.toFixed(4),
      priceCeilPct: balance.market.priceCeilPct.toFixed(4),
      nextUpdateAt: new Date(),
    });
    created += 1;
  }

  if (created > 0) log.info({ created }, 'market rows initialised');
  return created;
}

/** Commission de l'hôtel des ventes, exposée pour l'affichage. */
export function commissionFor(price: number): number {
  return auctionCommission(price, getBalance());
}

/** RNG non déterministe pour les cas où la reproductibilité n'importe pas. */
export const marketRng = liveRng;
