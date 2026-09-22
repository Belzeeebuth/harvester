import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { balance as getBalance } from '../../src/config';
import { getDb, withTransaction } from '../../src/db/client';
import { feeOf } from '../../src/game/money';
import * as economyRepo from '../../src/repositories/economy.repo';
import * as inventoryService from '../../src/services/inventory.service';
import * as tradeService from '../../src/services/trade.service';
import type { PlayerContext } from '../../src/types';
import {
  coinsOf,
  createTrader,
  expectLedgerBalanced,
  grantCoins,
  resetDatabase,
  resetRedis,
} from './helpers';

/**
 * ENCHÈRES — non-régression du constat C-1.
 *
 * Le bug d'origine : `placeBid` lisait la mise « précédente » dans le
 * `RETURNING` de son propre `UPDATE`. Or `RETURNING` renvoie les valeurs
 * NOUVELLES. Chaque enchérisseur était donc remboursé de sa propre mise dans la
 * transaction même où il venait d'être débité — miser ne coûtait rien, et la
 * clôture payait le vendeur avec de la monnaie créée de toutes pièces.
 *
 * Aucun test unitaire ne pouvait le voir : le bug est dans la sémantique du
 * moteur, pas dans la logique de jeu. D'où ces tests contre un vrai PostgreSQL.
 */

const ITEM = 'wheat';
const QUANTITY = 20;

async function listingPrice(): Promise<number> {
  const market = await economyRepo.getMarketPrice(ITEM);
  const reference = market?.currentPrice ?? 10;
  // Au prix du marché : toujours dans les bornes [0,4× ; 5×] du lot.
  return reference * QUANTITY;
}

async function giveItems(userId: string, quantity: number): Promise<void> {
  await withTransaction(async (tx) => {
    await inventoryService.addItems(userId, [{ itemKey: ITEM, quantity }], tx, {
      allowOverflow: true,
    });
  });
}

async function itemsOf(userId: string): Promise<number> {
  const rows = await getDb().execute<{ quantity: string }>(
    sql`SELECT COALESCE(SUM(quantity), 0)::text AS quantity
          FROM inventory WHERE user_id = ${userId} AND item_key = ${ITEM}`,
  );
  return Number(rows.rows[0]?.quantity ?? 0);
}

/** Fait expirer l'annonce sans attendre : la clôture est un job, pas une horloge. */
async function expireListing(listingId: string): Promise<void> {
  await getDb().execute(
    sql`UPDATE auction_listings SET expires_at = now() - interval '1 hour' WHERE id = ${listingId}`,
  );
}

async function openListing(
  seller: PlayerContext,
  options: { buyout?: boolean } = {},
): Promise<{ id: string; price: number }> {
  await giveItems(seller.id, QUANTITY);
  const price = await listingPrice();
  const listing = await tradeService.createListing(seller, {
    itemKey: ITEM,
    quantity: QUANTITY,
    price,
    buyout: options.buyout ?? false,
    durationHours: 24,
  });
  return { id: listing.id, price };
}

describe('enchères', () => {
  let seller: PlayerContext;
  let alice: PlayerContext;
  let bob: PlayerContext;

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    seller = await createTrader('vendeur');
    alice = await createTrader('alice');
    bob = await createTrader('bob');
    await grantCoins(alice.id, 500_000);
    await grantCoins(bob.id, 500_000);
  });

  it('miser débite réellement l\'enchérisseur', async () => {
    const listing = await openListing(seller);
    const before = await coinsOf(alice.id);

    await tradeService.bid(alice, listing.id, listing.price);

    // Le cœur de C-1 : avant correctif, ce solde était INCHANGÉ.
    expect(await coinsOf(alice.id)).toBe(before - listing.price);
    await expectLedgerBalanced();
  });

  it('la mise détrônée est remboursée une fois, et une seule', async () => {
    const listing = await openListing(seller);
    const aliceBefore = await coinsOf(alice.id);
    const bobBefore = await coinsOf(bob.id);

    await tradeService.bid(alice, listing.id, listing.price);
    const higher = Math.ceil(listing.price * 1.05);
    const result = await tradeService.bid(bob, listing.id, higher);

    expect(result.previousBidderId).toBe(alice.id);
    // Alice est rendue à son solde d'avant, exactement.
    expect(await coinsOf(alice.id)).toBe(aliceBefore);
    expect(await coinsOf(bob.id)).toBe(bobBefore - higher);
    await expectLedgerBalanced();

    // La mise remboursée est MARQUÉE : sans cela, la clôture la rembourserait
    // une seconde fois.
    const unrefunded = await getDb().execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM auction_bids
           WHERE listing_id = ${listing.id} AND bidder_id = ${alice.id} AND refunded = false`,
    );
    expect(Number(unrefunded.rows[0]?.count)).toBe(0);
  });

  it('à la clôture, le vendeur encaisse et le gagnant ne récupère rien', async () => {
    const listing = await openListing(seller);
    const sellerAfterFee = await coinsOf(seller.id);
    const aliceBefore = await coinsOf(alice.id);
    const bobBefore = await coinsOf(bob.id);

    await tradeService.bid(alice, listing.id, listing.price);
    const winning = Math.ceil(listing.price * 1.05);
    await tradeService.bid(bob, listing.id, winning);

    await expireListing(listing.id);
    const closed = await tradeService.closeExpiredListings();
    expect(closed).toEqual({ sold: 1, returned: 0 });

    // La commission est celle du jeu, pas une formule recopiée : le test suit
    // l'équilibrage si la valeur change.
    const commission = feeOf(winning, getBalance().auction.commissionRate);
    expect(await coinsOf(seller.id)).toBe(sellerAfterFee + winning - commission);
    // Le perdant est revenu à son point de départ, le gagnant a payé son lot.
    expect(await coinsOf(alice.id)).toBe(aliceBefore);
    expect(await coinsOf(bob.id)).toBe(bobBefore - winning);
    expect(await itemsOf(bob.id)).toBe(QUANTITY);
    await expectLedgerBalanced();

    // Rejouer la clôture ne doit rien produire : l'annonce n'est plus active.
    expect(await tradeService.closeExpiredListings()).toEqual({ sold: 0, returned: 0 });
    expect(await coinsOf(alice.id)).toBe(aliceBefore);
    await expectLedgerBalanced();
  });

  it('sans mise, le lot revient au vendeur', async () => {
    const listing = await openListing(seller);
    const sellerCoins = await coinsOf(seller.id);

    await expireListing(listing.id);
    expect(await tradeService.closeExpiredListings()).toEqual({ sold: 0, returned: 1 });

    expect(await itemsOf(seller.id)).toBe(QUANTITY);
    // Les frais de mise en vente ne sont PAS rendus : c'est un puits assumé.
    expect(await coinsOf(seller.id)).toBe(sellerCoins);
    await expectLedgerBalanced();
  });

  it('l\'achat immédiat rend son séquestre à l\'enchérisseur évincé', async () => {
    const listing = await openListing(seller, { buyout: true });
    const aliceBefore = await coinsOf(alice.id);
    const bobBefore = await coinsOf(bob.id);

    await tradeService.bid(alice, listing.id, listing.price);
    await tradeService.buyout(bob, listing.id);

    expect(await coinsOf(alice.id)).toBe(aliceBefore);
    expect(await coinsOf(bob.id)).toBe(bobBefore - listing.price);
    expect(await itemsOf(bob.id)).toBe(QUANTITY);
    await expectLedgerBalanced();
  });

  it('se surenchérir soi-même ne coûte que la nouvelle mise', async () => {
    const listing = await openListing(seller);
    const before = await coinsOf(alice.id);

    await tradeService.bid(alice, listing.id, listing.price);
    const higher = Math.ceil(listing.price * 1.05);
    await tradeService.bid(alice, listing.id, higher);

    expect(await coinsOf(alice.id)).toBe(before - higher);
    await expectLedgerBalanced();
  });

  it('une mise inférieure au minimum est refusée et ne débite rien', async () => {
    const listing = await openListing(seller);
    await tradeService.bid(alice, listing.id, listing.price);
    const bobBefore = await coinsOf(bob.id);

    await expect(tradeService.bid(bob, listing.id, listing.price)).rejects.toThrow();

    expect(await coinsOf(bob.id)).toBe(bobBefore);
    await expectLedgerBalanced();
  });

  it('le vendeur ne peut pas miser sur sa propre annonce', async () => {
    const listing = await openListing(seller);
    const before = await coinsOf(seller.id);

    await expect(tradeService.bid(seller, listing.id, listing.price)).rejects.toThrow();

    expect(await coinsOf(seller.id)).toBe(before);
    await expectLedgerBalanced();
  });
});
