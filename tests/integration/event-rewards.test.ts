import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerContext } from '../../src/types';
import { gameErrorCodeOf, startIsolatedStack, type IsolatedStack } from './stack';

/**
 * ÉVÉNEMENTS : paliers et boutique.
 *
 * `claimEventTier` n'avait aucun appelant : les paliers et la boutique de
 * `events.json` étaient affichés mais inaccessibles. On vérifie ici, contre une
 * vraie base, que la réclamation est idempotente et passe par le journal, que
 * la boutique débite les jetons atomiquement et tient sa limite par joueur,
 * que tout repart de zéro à l'occurrence suivante, et que les jetons
 * n'occupent pas l'entrepôt.
 */

type Helpers = typeof import('./helpers');
type EventService = typeof import('../../src/services/event.service');
type WorldService = typeof import('../../src/services/world.service');
type InventoryService = typeof import('../../src/services/inventory.service');
type InventoryRepo = typeof import('../../src/repositories/inventory.repo');
type ProgressionRepo = typeof import('../../src/repositories/progression.repo');
type DbClient = typeof import('../../src/db/client');

const EVENT = 'autumn_harvest';
const TOKEN = 'pumpkin_token';
/** Moisson d'automne 2026 : du 1er au 15 octobre. */
const DURING = new Date('2026-10-05T12:00:00.000Z');
const NEXT_YEAR = new Date('2027-10-05T12:00:00.000Z');

describe('événements : paliers et boutique', () => {
  let stack: IsolatedStack;
  let helpers: Helpers;
  let eventService: EventService;
  let worldService: WorldService;
  let inventoryService: InventoryService;
  let inventoryRepo: InventoryRepo;
  let progressionRepo: ProgressionRepo;
  let db: DbClient;
  let player: PlayerContext;

  beforeAll(async () => {
    stack = await startIsolatedStack();
    helpers = await import('./helpers');
    eventService = await import('../../src/services/event.service');
    worldService = await import('../../src/services/world.service');
    inventoryService = await import('../../src/services/inventory.service');
    inventoryRepo = await import('../../src/repositories/inventory.repo');
    progressionRepo = await import('../../src/repositories/progression.repo');
    db = await import('../../src/db/client');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  beforeEach(async () => {
    await helpers.resetDatabase();
    await helpers.resetRedis();
    player = await helpers.createTestPlayer('moisson');
  });

  function occurrence(now: Date): string {
    const event = worldService.getActiveEvents(now).find((entry) => entry.key === EVENT);
    if (!event) throw new Error('la Moisson devrait être active');
    return worldService.eventOccurrenceKey(event);
  }

  async function addPoints(points: number, now = DURING): Promise<void> {
    await progressionRepo.addEventPoints(player.id, EVENT, points, db.getDb(), occurrence(now));
  }

  async function giveTokens(quantity: number): Promise<void> {
    await db.withTransaction(async (tx) => {
      await inventoryRepo.addItems(player.id, [{ key: { itemKey: TOKEN }, quantity }], tx);
    });
  }

  it('réclame les paliers atteints une seule fois, par le journal', async () => {
    await addPoints(80);
    const coinsBefore = await helpers.coinsOf(player.id);

    const result = await eventService.claimEventRewards(player, EVENT, DURING);
    expect(result.tiers).toEqual([25, 75]);
    expect(result.coins).toBe(25_000);
    expect(result.gems).toBe(5);
    expect(await helpers.coinsOf(player.id)).toBe(coinsBefore + 25_000);
    expect(await inventoryService.count(player.id, 'fertilizer_quality')).toBe(3);
    await helpers.expectLedgerBalanced();

    // Idempotent : rien de plus à réclamer.
    expect(await gameErrorCodeOf(eventService.claimEventRewards(player, EVENT, DURING))).toBe(
      'invalid_state',
    );
    expect(await helpers.coinsOf(player.id)).toBe(coinsBefore + 25_000);
  });

  it('deux réclamations simultanées ne paient qu’une fois', async () => {
    await addPoints(30);
    const coinsBefore = await helpers.coinsOf(player.id);
    const outcomes = await Promise.allSettled([
      eventService.claimEventRewards(player, EVENT, DURING),
      eventService.claimEventRewards(player, EVENT, DURING),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await helpers.coinsOf(player.id)).toBe(coinsBefore + 5_000);
    await helpers.expectLedgerBalanced();
  });

  it('achète avec des jetons, tient la limite par joueur, refuse sans jetons', async () => {
    await giveTokens(10);

    const bought = await eventService.buyEventItem(
      player,
      { eventKey: EVENT, itemKey: 'seed_pumpkin', quantity: 3 },
      DURING,
    );
    expect(bought.cost).toBe(6);
    expect(await inventoryService.count(player.id, TOKEN)).toBe(4);
    expect(await inventoryService.count(player.id, 'seed_pumpkin')).toBe(3);

    // Jetons insuffisants : rien ne bouge.
    expect(
      await gameErrorCodeOf(
        eventService.buyEventItem(player, { eventKey: EVENT, itemKey: 'fertilizer_deluxe', quantity: 1 }, DURING),
      ),
    ).toBe('insufficient_items');
    expect(await inventoryService.count(player.id, TOKEN)).toBe(4);

    // Limite de 40 graines par joueur : 3 déjà achetées.
    await giveTokens(200);
    expect(
      await gameErrorCodeOf(
        eventService.buyEventItem(player, { eventKey: EVENT, itemKey: 'seed_pumpkin', quantity: 38 }, DURING),
      ),
    ).toBe('forbidden');
    await eventService.buyEventItem(
      player,
      { eventKey: EVENT, itemKey: 'seed_pumpkin', quantity: 37 },
      DURING,
    );
    expect(await inventoryService.count(player.id, 'seed_pumpkin')).toBe(40);
  });

  it('repart de zéro à l’occurrence suivante', async () => {
    await addPoints(30);
    await eventService.claimEventRewards(player, EVENT, DURING);

    await addPoints(10, NEXT_YEAR);
    const row = await progressionRepo.getUserEvent(player.id, EVENT);
    expect(row?.points).toBe(10);
    expect(row?.claimedTiers).toEqual([]);
  });

  it('les jetons n’occupent pas l’entrepôt', async () => {
    const before = await inventoryService.getCapacity(player.id);
    await db.withTransaction(async (tx) => {
      await inventoryRepo.addItems(player.id, [{ key: { itemKey: 'weeds' }, quantity: before.free }], tx);
    });
    expect((await inventoryService.getCapacity(player.id)).free).toBe(0);

    await db.withTransaction(async (tx) => {
      await inventoryService.addItems(player.id, [{ itemKey: TOKEN, quantity: 50 }], tx);
    });
    expect(await inventoryService.count(player.id, TOKEN)).toBe(50);
    expect((await inventoryService.getCapacity(player.id)).free).toBe(0);

    const rows = await db.getDb().execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM inventory WHERE user_id = ${player.id}`,
    );
    expect(Number(rows.rows[0]?.n)).toBeGreaterThan(0);
  });
});
