import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerContext } from '../../src/types';
import { startIsolatedStack, type IsolatedStack } from './stack';

/**
 * ENCHÈRES — une mise détrônée n'est remboursée qu'UNE fois.
 *
 * Deux chemins rendent le séquestre d'un enchérisseur : la surenchère
 * (`bid`, immédiatement) et la clôture (`closeExpiredListings`, pour toute mise
 * encore en séquestre). Ils ne se coordonnent que par une colonne :
 * `auction_bids.refunded`, posée dans la même transaction que le remboursement.
 * Si ce marquage manquait — ou n'était pas validé avec le paiement — chaque
 * enchérisseur évincé toucherait deux fois sa mise, et la clôture créerait de
 * la monnaie ex nihilo. Ce n'est visible qu'en enchaînant vraiment les deux
 * chemins contre un PostgreSQL, ce que fait ce fichier.
 *
 * Tout module applicatif est importé dynamiquement, après le démarrage des
 * conteneurs : voir `stack.ts`.
 */

type Helpers = typeof import('./helpers');
type TradeService = typeof import('../../src/services/trade.service');
type InventoryService = typeof import('../../src/services/inventory.service');
type EconomyRepo = typeof import('../../src/repositories/economy.repo');
type DbClient = typeof import('../../src/db/client');
type Money = typeof import('../../src/game/money');
type Config = typeof import('../../src/config');

const ITEM = 'wheat';
const QUANTITY = 20;

describe('enchères : remboursement unique de la mise détrônée', () => {
  let stack: IsolatedStack;
  let helpers: Helpers;
  let tradeService: TradeService;
  let inventoryService: InventoryService;
  let economyRepo: EconomyRepo;
  let db: DbClient;
  let money: Money;
  let config: Config;

  let seller: PlayerContext;
  let alice: PlayerContext;
  let bob: PlayerContext;

  beforeAll(async () => {
    stack = await startIsolatedStack();
    helpers = await import('./helpers');
    tradeService = await import('../../src/services/trade.service');
    inventoryService = await import('../../src/services/inventory.service');
    economyRepo = await import('../../src/repositories/economy.repo');
    db = await import('../../src/db/client');
    money = await import('../../src/game/money');
    config = await import('../../src/config');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  beforeEach(async () => {
    await helpers.resetDatabase();
    await helpers.resetRedis();
    seller = await helpers.createTestPlayer('vendeur');
    alice = await helpers.createTrader('alice');
    bob = await helpers.createTrader('bob');
    await helpers.grantCoins(alice.id, 500_000);
    await helpers.grantCoins(bob.id, 500_000);
  });

  async function itemsOf(userId: string): Promise<number> {
    return inventoryService.count(userId, ITEM);
  }

  /** Enchère pure (pas d'achat immédiat) au cours du marché, dans les bornes du lot. */
  async function openAuction(): Promise<{ id: string; price: number }> {
    await db.withTransaction(async (tx) => {
      await inventoryService.addItems(seller.id, [{ itemKey: ITEM, quantity: QUANTITY }], tx, {
        allowOverflow: true,
      });
    });
    const reference = (await economyRepo.getMarketPrice(ITEM))?.currentPrice ?? 10;
    const price = reference * QUANTITY;
    const listing = await tradeService.createListing(seller, {
      itemKey: ITEM,
      quantity: QUANTITY,
      price,
      buyout: false,
      durationHours: 24,
    });
    return { id: listing.id, price };
  }

  /** Fait expirer l'annonce sans attendre : la clôture est un job, pas une horloge. */
  async function expireListing(listingId: string): Promise<void> {
    await db.getDb().execute(
      sql`UPDATE auction_listings SET expires_at = now() - interval '1 hour' WHERE id = ${listingId}`,
    );
  }

  /** Lignes de journal `auction_refund` d'un joueur pour cette annonce. */
  async function refundsOf(userId: string, listingId: string): Promise<number> {
    const rows = await db.getDb().execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM transactions
           WHERE user_id = ${userId} AND type = 'auction_refund'
             AND reference_type = 'auction' AND reference_id = ${listingId}`,
    );
    return Number(rows.rows[0]?.count ?? 0);
  }

  /** Mises encore en séquestre (non marquées remboursées), gagnante comprise. */
  async function unrefundedBids(
    listingId: string,
  ): Promise<Array<{ bidderId: string; amount: number; isWinning: boolean }>> {
    const rows = await db.getDb().execute<{
      bidder_id: string;
      amount: string;
      is_winning: boolean;
    }>(
      sql`SELECT bidder_id, amount::text AS amount, is_winning FROM auction_bids
           WHERE listing_id = ${listingId} AND refunded = false ORDER BY id`,
    );
    return rows.rows.map((row) => ({
      bidderId: row.bidder_id,
      amount: Number(row.amount),
      isWinning: row.is_winning,
    }));
  }

  async function listingStatus(listingId: string): Promise<string> {
    const rows = await db.getDb().execute<{ status: string }>(
      sql`SELECT status FROM auction_listings WHERE id = ${listingId}`,
    );
    return rows.rows[0]?.status ?? 'inconnu';
  }

  it('surenchère puis clôture : Alice est remboursée une fois, pas deux', async () => {
    const listing = await openAuction();
    // Les frais de mise en vente sont déjà payés : seul le produit net compte.
    const sellerAfterFee = await helpers.coinsOf(seller.id);
    const aliceBefore = await helpers.coinsOf(alice.id);
    const bobBefore = await helpers.coinsOf(bob.id);

    await tradeService.bid(alice, listing.id, listing.price);
    const winning = Math.ceil(listing.price * 1.05);
    const outbid = await tradeService.bid(bob, listing.id, winning);
    expect(outbid.previousBidderId).toBe(alice.id);

    // Premier chemin : remboursée à l'instant, et sa mise est MARQUÉE.
    expect(await helpers.coinsOf(alice.id)).toBe(aliceBefore);
    expect(await refundsOf(alice.id, listing.id)).toBe(1);
    expect(await unrefundedBids(listing.id)).toEqual([
      { bidderId: bob.id, amount: winning, isWinning: true },
    ]);

    await expireListing(listing.id);
    expect(await tradeService.closeExpiredListings()).toEqual({ sold: 1, returned: 0 });

    // Second chemin, le cœur du scénario : pas de second remboursement.
    expect(await helpers.coinsOf(alice.id)).toBe(aliceBefore);
    expect(await refundsOf(alice.id, listing.id)).toBe(1);
    expect(await helpers.ledgerOf(alice.id)).toBe(aliceBefore);

    // Le vendeur encaisse net de commission — celle du jeu, pas une formule
    // recopiée — et le gagnant reçoit le lot au prix de sa mise.
    const commission = money.feeOf(winning, config.balance().auction.commissionRate);
    expect(await helpers.coinsOf(seller.id)).toBe(sellerAfterFee + winning - commission);
    expect(await helpers.coinsOf(bob.id)).toBe(bobBefore - winning);
    expect(await itemsOf(bob.id)).toBe(QUANTITY);
    expect(await refundsOf(bob.id, listing.id)).toBe(0);
    expect(await listingStatus(listing.id)).toBe('sold');
    await helpers.expectLedgerBalanced();

    // Rejouer la clôture ne rend rien à personne : l'annonce n'est plus active.
    expect(await tradeService.closeExpiredListings()).toEqual({ sold: 0, returned: 0 });
    expect(await helpers.coinsOf(alice.id)).toBe(aliceBefore);
    expect(await refundsOf(alice.id, listing.id)).toBe(1);
    expect(await helpers.coinsOf(seller.id)).toBe(sellerAfterFee + winning - commission);
    await helpers.expectLedgerBalanced();
  });

  it('un enchérisseur qui reprend la main ne récupère que sa première mise, une fois', async () => {
    const listing = await openAuction();
    const sellerAfterFee = await helpers.coinsOf(seller.id);
    const aliceBefore = await helpers.coinsOf(alice.id);
    const bobBefore = await helpers.coinsOf(bob.id);

    const first = listing.price;
    const second = Math.ceil(first * 1.05);
    const third = Math.ceil(second * 1.05);
    await tradeService.bid(alice, listing.id, first);
    await tradeService.bid(bob, listing.id, second);
    await tradeService.bid(alice, listing.id, third);

    // Avant clôture : Alice ne porte que sa dernière mise, Bob est rendu à zéro.
    expect(await helpers.coinsOf(alice.id)).toBe(aliceBefore - third);
    expect(await helpers.coinsOf(bob.id)).toBe(bobBefore);
    expect(await refundsOf(alice.id, listing.id)).toBe(1);
    expect(await refundsOf(bob.id, listing.id)).toBe(1);
    expect(await unrefundedBids(listing.id)).toEqual([
      { bidderId: alice.id, amount: third, isWinning: true },
    ]);

    await expireListing(listing.id);
    expect(await tradeService.closeExpiredListings()).toEqual({ sold: 1, returned: 0 });

    // La clôture n'a rien trouvé à rembourser : les deux mises évincées
    // l'étaient déjà, et la gagnante finance le vendeur.
    expect(await helpers.coinsOf(alice.id)).toBe(aliceBefore - third);
    expect(await helpers.coinsOf(bob.id)).toBe(bobBefore);
    expect(await refundsOf(alice.id, listing.id)).toBe(1);
    expect(await refundsOf(bob.id, listing.id)).toBe(1);
    const commission = money.feeOf(third, config.balance().auction.commissionRate);
    expect(await helpers.coinsOf(seller.id)).toBe(sellerAfterFee + third - commission);
    expect(await itemsOf(alice.id)).toBe(QUANTITY);
    expect(await itemsOf(bob.id)).toBe(0);
    await helpers.expectLedgerBalanced();
  });
});
