import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { balance as getBalance } from '../../src/config';
import { getDb, lockUserRow, withTransaction } from '../../src/db/client';
import * as economyRepo from '../../src/repositories/economy.repo';
import * as farmRepo from '../../src/repositories/farm.repo';
import * as systemRepo from '../../src/repositories/system.repo';
import * as coopService from '../../src/services/coop.service';
import * as farmService from '../../src/services/farm.service';
import * as inventoryService from '../../src/services/inventory.service';
import * as tradeService from '../../src/services/trade.service';
import { doPrestige } from '../../src/services/misc.service';
import type { PlayerContext } from '../../src/types';
import {
  createTestPlayer,
  createTrader,
  grantCoins,
  reloadPlayer,
  resetDatabase,
  resetRedis,
  setLevel,
} from './helpers';

/**
 * Économie et tâches planifiées : verrous, écritures conditionnelles des jobs,
 * renaissance et coopératives.
 */

async function plotState(farmId: string, slot: number): Promise<string> {
  const rows = await getDb().execute<{ state: string }>(
    sql`SELECT state FROM plots WHERE farm_id = ${farmId} AND slot = ${slot}`,
  );
  return rows.rows[0]?.state ?? 'inconnu';
}

async function giveSeeds(userId: string, quantity = 5): Promise<void> {
  await withTransaction(async (tx) => {
    await inventoryService.addItems(userId, [{ itemKey: 'seed_wheat', quantity }], tx, {
      allowOverflow: true,
    });
  });
}

/** Rejette si la promesse n'aboutit pas dans le délai : un blocage ne doit pas passer pour un succès. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`bloqué plus de ${ms} ms`)), ms)),
  ]);
}

describe('économie et tâches planifiées', () => {
  let player: PlayerContext;

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    player = await createTestPlayer('fermier');
  });

  it("le verrou joueur ne bloque plus une insertion référençant le joueur sur une autre connexion", async () => {
    await withTransaction(async (tx) => {
      await lockUserRow(tx, player.id);
      // Autre connexion du pool : la vérification de clé étrangère pose un
      // FOR KEY SHARE, qui attendait la fin de la transaction sous FOR UPDATE.
      await within(
        systemRepo.enqueueNotification({
          userId: player.id,
          type: 'crop_ready',
          payload: { titleKey: 'notifications.crop_ready_title', bodyKey: 'notifications.crop_ready_body' },
          dedupeKey: `verrou:${player.id}`,
        }),
        3_000,
      );
    });
  });

  it('le flétrissement saute une parcelle tenue par une action du joueur', async () => {
    await giveSeeds(player.id);
    await farmService.plant(player, { cropKey: 'wheat', slot: 1 });
    await getDb().execute(
      sql`UPDATE planted_crops SET withers_at = now() - interval '1 minute' WHERE user_id = ${player.id}`,
    );

    await withTransaction(async (tx) => {
      await farmRepo.lockPlot(tx, player.farmId, 1);
      // Parcelle verrouillée (récolte en cours) : rien n'est écrit, rien n'attend.
      expect(await within(farmRepo.witherOverdueCrops(new Date(), 50), 3_000)).toBe(0);
    });
    expect(await farmRepo.witherOverdueCrops(new Date(), 50)).toBe(1);
    expect(await plotState(player.farmId, 1)).toBe('withered');
  });

  it('une parcelle fanée sans culture redevient cultivable', async () => {
    await getDb().execute(
      sql`UPDATE plots SET state = 'withered', pest_type = 'crows' WHERE farm_id = ${player.farmId} AND slot = 2`,
    );
    await giveSeeds(player.id);
    await expect(farmService.plant(player, { cropKey: 'wheat', slot: 2 })).resolves.toBeTruthy();
    const rows = await getDb().execute<{ state: string; pest_type: string | null }>(
      sql`SELECT state, pest_type FROM plots WHERE farm_id = ${player.farmId} AND slot = 2`,
    );
    expect(rows.rows[0]).toEqual({ state: 'planted', pest_type: null });

    // Et le nettoyage du job remet les orphelines à « vide ».
    await getDb().execute(
      sql`UPDATE plots SET state = 'withered' WHERE farm_id = ${player.farmId} AND slot = 3`,
    );
    expect(await farmRepo.repairOrphanWitheredPlots(new Date())).toBe(1);
    expect(await plotState(player.farmId, 3)).toBe('empty');
    expect(await plotState(player.farmId, 2)).toBe('planted');
  });

  it("un nuisible n'apparaît pas sur une parcelle vidée entre-temps", async () => {
    const spawned = await farmRepo.spawnPestIfStillPlanted(
      (await farmRepo.getPlotBySlot(player.farmId, 1))!.plot.id,
      { pestType: 'crows', pestAppearedAt: new Date(), pestDeadlineAt: new Date(Date.now() + 3_600_000) },
    );
    expect(spawned).toBe(false);
  });

  it('les intérêts ne sont versés qu’une fois par jour, même job relancé', async () => {
    const rows = await getDb().execute<{ id: string }>(
      sql`UPDATE bank_accounts SET balance = 100000, last_interest_at = now() - interval '2 days'
           WHERE user_id = ${player.id} RETURNING id`,
    );
    const accountId = rows.rows[0]?.id;
    expect(accountId).toBeTruthy();
    if (!accountId) return;
    const now = new Date();
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const first = await withTransaction((tx) => economyRepo.applyInterest(accountId, 10, now, cutoff, tx));
    const second = await withTransaction((tx) => economyRepo.applyInterest(accountId, 10, now, cutoff, tx));
    expect([first, second]).toEqual([true, false]);
  });

  it('la renaissance est refusée tant qu’une annonce est ouverte', async () => {
    const trader = await createTrader('vendeur');
    await withTransaction(async (tx) => {
      await inventoryService.addItems(trader.id, [{ itemKey: 'wheat', quantity: 20 }], tx, {
        allowOverflow: true,
      });
    });
    const market = await economyRepo.getMarketPrice('wheat');
    await tradeService.createListing(trader, {
      itemKey: 'wheat',
      quantity: 20,
      price: (market?.currentPrice ?? 10) * 20,
      buyout: false,
      durationHours: 24,
    });
    await setLevel(trader.id, getBalance().prestige.requiredLevel);
    const eligible = await reloadPlayer(trader.discordId);

    await expect(doPrestige(eligible)).rejects.toMatchObject({
      i18nKey: 'errors.player.prestige_blocked',
    });
    const rows = await getDb().execute<{ prestige: number }>(
      sql`SELECT prestige FROM users WHERE id = ${trader.id}`,
    );
    expect(Number(rows.rows[0]?.prestige)).toBe(0);
  });

  it('quitter une coopérative impose le délai avant d’en rejoindre une autre', async () => {
    const owner = await createTestPlayer('chef');
    await grantCoins(owner.id, 1_000_000);
    await setLevel(owner.id, 50);
    await setLevel(player.id, 50);
    const ownerCtx = await reloadPlayer(owner.discordId);
    const coop = await coopService.createCoop(ownerCtx, { name: 'Les Semeurs', tag: 'SEM' });

    await coopService.joinCoop(await reloadPlayer(player.discordId), coop.tag);
    await coopService.leaveCoop(await reloadPlayer(player.discordId));

    await expect(
      coopService.joinCoop(await reloadPlayer(player.discordId), coop.tag),
    ).rejects.toMatchObject({ i18nKey: 'errors.coop.leave_cooldown' });
  });

  it('un membre exclu pendant son départ ne vide pas la trésorerie', async () => {
    const owner = await createTestPlayer('chef');
    await grantCoins(owner.id, 1_000_000);
    await setLevel(owner.id, 50);
    await setLevel(player.id, 50);
    const ownerCtx = await reloadPlayer(owner.discordId);
    const coop = await coopService.createCoop(ownerCtx, { name: 'Les Glaneurs', tag: 'GLA' });
    await coopService.joinCoop(await reloadPlayer(player.discordId), coop.tag);
    await getDb().execute(sql`UPDATE guilds SET treasury = 50000 WHERE id = ${coop.id}`);

    const member = await reloadPlayer(player.discordId);
    await coopService.kickMember(await reloadPlayer(owner.discordId), player.id);
    // Contexte périmé (encore « membre »). La course réelle (exclusion validée
    // entre la lecture de l'appartenance et la transaction) ne se rejoue pas
    // de façon déterministe ; on vérifie au moins que le départ relit
    // l'appartenance et refuse, sans verser la trésorerie.
    await expect(coopService.leaveCoop(member)).rejects.toMatchObject({ i18nKey: 'coop.not_member' });
    const rows = await getDb().execute<{ treasury: string }>(
      sql`SELECT treasury::text AS treasury FROM guilds WHERE id = ${coop.id}`,
    );
    expect(Number(rows.rows[0]?.treasury)).toBe(50000);
  });
});
