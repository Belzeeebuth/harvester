import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerContext } from '../../src/types';
import { startIsolatedStack, type IsolatedStack } from './stack';

/**
 * ORDRES D'ACHAT PERMANENTS — rapprochement contre une vraie base.
 *
 * Le rapprochement (`matchStandingOrders`) tourne en tâche de fond : personne
 * n'est devant l'écran pour remarquer un débit fantôme. Deux garanties doivent
 * donc tenir toutes seules, et elles vivent dans le moteur, pas dans la logique
 * de jeu : un ordre annulé n'achète JAMAIS (relecture de l'ordre sous
 * `SELECT ... FOR UPDATE` avant la moindre dépense), et un ordre actif n'achète
 * qu'UNE fois par annonce (`fillOrder` conditionné par `status = 'active'`,
 * annonce marquée vendue de façon atomique). Seul un PostgreSQL réel peut le
 * prouver, d'où la pile Testcontainers.
 *
 * Tout module applicatif est importé dynamiquement, après le démarrage des
 * conteneurs : voir `stack.ts`.
 */

type Helpers = typeof import('./helpers');
type TradeService = typeof import('../../src/services/trade.service');
type EconomyService = typeof import('../../src/services/economy.service');
type InventoryService = typeof import('../../src/services/inventory.service');
type EconomyRepo = typeof import('../../src/repositories/economy.repo');
type DbClient = typeof import('../../src/db/client');
type MarketRules = typeof import('../../src/game/market');
type Config = typeof import('../../src/config');

const ITEM = 'wheat';
const QUANTITY = 20;

describe('ordres d\'achat permanents', () => {
  let stack: IsolatedStack;
  let helpers: Helpers;
  let tradeService: TradeService;
  let economyService: EconomyService;
  let inventoryService: InventoryService;
  let economyRepo: EconomyRepo;
  let db: DbClient;
  let market: MarketRules;
  let config: Config;

  let seller: PlayerContext;
  let buyer: PlayerContext;

  beforeAll(async () => {
    stack = await startIsolatedStack();
    helpers = await import('./helpers');
    tradeService = await import('../../src/services/trade.service');
    economyService = await import('../../src/services/economy.service');
    inventoryService = await import('../../src/services/inventory.service');
    economyRepo = await import('../../src/repositories/economy.repo');
    db = await import('../../src/db/client');
    market = await import('../../src/game/market');
    config = await import('../../src/config');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  beforeEach(async () => {
    await helpers.resetDatabase();
    await helpers.resetRedis();
    seller = await helpers.createTestPlayer('vendeur');
    buyer = await helpers.createTrader('acheteur');
    await helpers.grantCoins(buyer.id, 100_000);
  });

  async function giveItems(userId: string, quantity: number): Promise<void> {
    await db.withTransaction(async (tx) => {
      // Fixture, pas production : la marchandise est posée comme une dotation.
      await inventoryService.addItems(userId, [{ itemKey: ITEM, quantity }], tx, {
        allowOverflow: true,
      });
    });
  }

  async function itemsOf(userId: string): Promise<number> {
    return inventoryService.count(userId, ITEM);
  }

  /**
   * Annonce en achat immédiat au cours du marché : dans les bornes [0,4× ; 5×]
   * du lot, et le prix UNITAIRE en ressort entier, ce qui permet un ordre au
   * budget exactement égal au prix de l'annonce — l'égalité est le cas limite
   * du `<=` de `findMatchingListings`.
   */
  async function openBuyoutListing(): Promise<{ id: string; price: number; unitPrice: number }> {
    await giveItems(seller.id, QUANTITY);
    const reference = (await economyRepo.getMarketPrice(ITEM))?.currentPrice ?? 10;
    const price = reference * QUANTITY;
    const listing = await tradeService.createListing(seller, {
      itemKey: ITEM,
      quantity: QUANTITY,
      price,
      buyout: true,
      durationHours: 24,
    });
    return { id: listing.id, price, unitPrice: reference };
  }

  async function orderRow(orderId: string): Promise<{ status: string; remaining: number }> {
    const rows = await db.getDb().execute<{ status: string; remaining_quantity: number }>(
      sql`SELECT status, remaining_quantity FROM standing_orders WHERE id = ${orderId}`,
    );
    const row = rows.rows[0];
    if (!row) throw new Error('ordre permanent introuvable');
    return { status: row.status, remaining: Number(row.remaining_quantity) };
  }

  async function listingStatus(listingId: string): Promise<string> {
    const rows = await db.getDb().execute<{ status: string }>(
      sql`SELECT status FROM auction_listings WHERE id = ${listingId}`,
    );
    return rows.rows[0]?.status ?? 'inconnu';
  }

  it('un ordre annulé n\'achète rien : ni débit, ni annonce consommée', async () => {
    const listing = await openBuyoutListing();
    const buyerBefore = await helpers.coinsOf(buyer.id);
    const sellerBefore = await helpers.coinsOf(seller.id);

    const order = await tradeService.createStandingOrder(buyer, {
      itemKey: ITEM,
      quantity: QUANTITY,
      maxUnitPrice: listing.unitPrice,
    });
    await tradeService.cancelStandingOrder(buyer, order.id);

    expect(await tradeService.matchStandingOrders()).toBe(0);

    expect(await helpers.coinsOf(buyer.id)).toBe(buyerBefore);
    expect(await helpers.coinsOf(seller.id)).toBe(sellerBefore);
    expect(await itemsOf(buyer.id)).toBe(0);
    expect(await listingStatus(listing.id)).toBe('active');
    expect(await orderRow(order.id)).toEqual({ status: 'cancelled', remaining: QUANTITY });
    await helpers.expectLedgerBalanced();

    // Annuler deux fois est refusé : l'ordre n'est plus actif.
    await expect(tradeService.cancelStandingOrder(buyer, order.id)).rejects.toThrow();
  });

  it('un ordre actif achète une fois : débit exact, livraison, ordre soldé', async () => {
    const listing = await openBuyoutListing();
    const buyerBefore = await helpers.coinsOf(buyer.id);
    // Les frais de mise en vente sont déjà payés : seul le produit net compte.
    const sellerAfterFee = await helpers.coinsOf(seller.id);

    const order = await tradeService.createStandingOrder(buyer, {
      itemKey: ITEM,
      quantity: QUANTITY,
      maxUnitPrice: listing.unitPrice,
    });
    expect(await tradeService.matchStandingOrders()).toBe(1);

    // La commission est celle du jeu, pas une formule recopiée.
    const commission = market.auctionCommission(listing.price, config.balance());
    expect(await helpers.coinsOf(buyer.id)).toBe(buyerBefore - listing.price);
    expect(await helpers.coinsOf(seller.id)).toBe(sellerAfterFee + listing.price - commission);
    expect(await itemsOf(buyer.id)).toBe(QUANTITY);
    expect(await itemsOf(seller.id)).toBe(0);
    expect(await listingStatus(listing.id)).toBe('sold');
    expect(await orderRow(order.id)).toEqual({ status: 'fulfilled', remaining: 0 });
    await helpers.expectLedgerBalanced();

    // Relancer le job ne rachète rien : l'ordre est soldé, l'annonce vendue.
    expect(await tradeService.matchStandingOrders()).toBe(0);
    expect(await helpers.coinsOf(buyer.id)).toBe(buyerBefore - listing.price);
    expect(await helpers.coinsOf(seller.id)).toBe(sellerAfterFee + listing.price - commission);
    expect(await itemsOf(buyer.id)).toBe(QUANTITY);
    await helpers.expectLedgerBalanced();
  });

  it('un ordre plus large que l\'annonce est décrémenté, puis reste actif sans racheter', async () => {
    const listing = await openBuyoutListing();
    const buyerBefore = await helpers.coinsOf(buyer.id);

    const order = await tradeService.createStandingOrder(buyer, {
      itemKey: ITEM,
      quantity: QUANTITY * 3,
      maxUnitPrice: listing.unitPrice,
    });
    expect(await tradeService.matchStandingOrders()).toBe(1);

    expect(await orderRow(order.id)).toEqual({ status: 'active', remaining: QUANTITY * 2 });
    expect(await helpers.coinsOf(buyer.id)).toBe(buyerBefore - listing.price);
    expect(await itemsOf(buyer.id)).toBe(QUANTITY);

    // Second passage : plus aucune annonce compatible, rien ne bouge.
    expect(await tradeService.matchStandingOrders()).toBe(0);
    expect(await orderRow(order.id)).toEqual({ status: 'active', remaining: QUANTITY * 2 });
    expect(await helpers.coinsOf(buyer.id)).toBe(buyerBefore - listing.price);
    expect(await itemsOf(buyer.id)).toBe(QUANTITY);
    await helpers.expectLedgerBalanced();
  });

  it('sans les fonds, rien n\'est débité ni livré et l\'ordre attend le cycle suivant', async () => {
    const listing = await openBuyoutListing();
    const sellerAfterFee = await helpers.coinsOf(seller.id);

    // L'acheteur est ramené à une pièce de moins que le prix — par le journal,
    // pour que l'invariant du grand livre reste vrai avant comme après.
    const buyerCoins = await helpers.coinsOf(buyer.id);
    const excess = buyerCoins - (listing.price - 1);
    expect(excess).toBeGreaterThan(0);
    await db.withTransaction(async (tx) => {
      await economyService.charge({ userId: buyer.id, amount: excess, type: 'admin_remove' }, tx);
    });
    const buyerBefore = await helpers.coinsOf(buyer.id);
    expect(buyerBefore).toBe(listing.price - 1);

    const order = await tradeService.createStandingOrder(buyer, {
      itemKey: ITEM,
      quantity: QUANTITY,
      maxUnitPrice: listing.unitPrice,
    });
    // Le job avale l'échec et passe : l'ordre reste candidat pour plus tard.
    expect(await tradeService.matchStandingOrders()).toBe(0);

    expect(await helpers.coinsOf(buyer.id)).toBe(buyerBefore);
    expect(await helpers.coinsOf(seller.id)).toBe(sellerAfterFee);
    expect(await itemsOf(buyer.id)).toBe(0);
    expect(await listingStatus(listing.id)).toBe('active');
    expect(await orderRow(order.id)).toEqual({ status: 'active', remaining: QUANTITY });
    await helpers.expectLedgerBalanced();

    // Une pièce de plus, et le même passage aboutit : c'était bien les fonds.
    await helpers.grantCoins(buyer.id, 1);
    expect(await tradeService.matchStandingOrders()).toBe(1);
    expect(await helpers.coinsOf(buyer.id)).toBe(0);
    expect(await itemsOf(buyer.id)).toBe(QUANTITY);
    expect(await orderRow(order.id)).toEqual({ status: 'fulfilled', remaining: 0 });
    await helpers.expectLedgerBalanced();
  });
});
