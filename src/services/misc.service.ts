import { balance as getBalance, getActiveSeasonPass, getConfig, reloadConfig } from '../config';
import { env } from '../config/env';
import { lockUserRow, withTransaction, type Transaction } from '../db/client';
import { checkPrestigeEligibility, planPrestige, prestigeBadge } from '../game/prestige';
import { gameError } from '../utils/errors';
import { scaleMoney } from '../game/money';
import { moduleLogger } from '../utils/logger';
import { reloadCatalogs, translate } from '../i18n';
import * as animalRepo from '../repositories/animal.repo';
import * as economyRepo from '../repositories/economy.repo';
import * as farmRepo from '../repositories/farm.repo';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import * as progressionRepo from '../repositories/progression.repo';
import * as socialRepo from '../repositories/social.repo';
import * as systemRepo from '../repositories/system.repo';
import { broadcast } from './cluster';
import * as economyService from './economy.service';
import * as inventoryService from './inventory.service';
import { grantXp, levelUpOf, removeXpAmount, type LevelUpSummary } from './player.service';
import { claimOnce, releaseOnce } from '../utils/lock';
import { checkAndSet as setCooldown } from '../framework/cooldown';
import { dailyCycleKey, isWeekend, toSqlDate } from '../utils/time';
import type { PlayerContext } from '../types';

const log = moduleLogger('misc');

/**
 * Services transverses : classements, prestige, parrainage, votes, visites,
 * notifications et administration. Regroupés parce qu'ils sont tous courts et
 * qu'aucun ne justifie son propre fichier.
 */

// ---------------------------------------------------------------------------
// CLASSEMENTS
// ---------------------------------------------------------------------------

/** Les classements de joueurs, plus le classement de coopératives. */
export type LeaderboardType = socialRepo.LeaderboardType | 'coop_score';

/** Seuls les emoji sont figés ici : libellé et unité viennent du catalogue i18n. */
export const LEADERBOARD_EMOJI: Record<LeaderboardType, string> = {
  wealth: '🪙',
  level: '⭐',
  harvests: '🌾',
  animals: '🐄',
  crafts: '🛠️',
  coop_score: '🤝',
  weekly_xp: '📈',
  streak: '🔥',
};

/** Métadonnées d'un classement, dans la langue du spectateur. */
export function leaderboardMeta(
  type: LeaderboardType,
  locale: string,
): { label: string; emoji: string; unit: string } {
  return {
    label: translate(locale, `leaderboard.${type}`),
    emoji: LEADERBOARD_EMOJI[type],
    unit: translate(locale, `leaderboard.unit.${type}`),
  };
}

export async function getLeaderboard(
  type: LeaderboardType,
  options: {
    scope?: 'global' | 'discord' | 'coop';
    discordGuildId?: string;
    coopId?: string;
    limit?: number;
    /** Langue du spectateur : le champ `extra` est rendu tel quel dans l'image. */
    locale?: string;
  } = {},
) {
  const locale = options.locale ?? 'fr';
  if (type === 'coop_score') {
    const rows = await socialRepo.coopLeaderboard(options.limit ?? 10);
    return {
      kind: 'coop' as const,
      rows: rows.map((row, index) => ({
        rank: index + 1,
        name: `${row.emblem} ${row.name} [${row.tag}]`,
        score: row.weeklyScore,
        level: row.level,
        extra: translate(locale, 'leaderboard.entry_members', { count: row.memberCount }),
      })),
    };
  }

  const playerType = type;
  const rows = await socialRepo.leaderboard(playerType, {
    limit: options.limit ?? 10,
    ...(options.scope === 'discord' && options.discordGuildId
      ? { discordGuildId: options.discordGuildId }
      : {}),
    ...(options.scope === 'coop' && options.coopId ? { coopId: options.coopId } : {}),
  });

  return {
    kind: 'player' as const,
    rows: rows.map((row, index) => ({
      rank: index + 1,
      userId: row.userId,
      discordId: row.discordId,
      name: row.username,
      score: Number(row.score),
      level: row.level,
      prestige: row.prestige,
      extra: `${translate(locale, 'leaderboard.entry_level', { level: row.level })}${row.prestige > 0 ? ` ${prestigeBadge(row.prestige)}` : ''}`,
    })),
  };
}

export async function getUserRank(type: LeaderboardType, userId: string) {
  if (type === 'coop_score') return undefined;
  return socialRepo.userRank(type, userId);
}

/** Capture les classements hebdomadaires (job du lundi). */
export async function snapshotLeaderboards(periodKey: string): Promise<number> {
  const types: LeaderboardType[] = ['wealth', 'level', 'harvests', 'weekly_xp'];
  let total = 0;

  for (const type of types) {
    const playerType = type as socialRepo.LeaderboardType;
  const rows = await socialRepo.leaderboard(playerType, { limit: 100 });
    await socialRepo.saveSnapshots(
      rows.map((row, index) => ({
        boardType: type,
        scope: 'global' as const,
        scopeId: 'global',
        period: 'weekly' as const,
        periodKey,
        userId: row.userId,
        rank: index + 1,
        score: Number(row.score),
      })),
    );
    total += rows.length;
  }

  log.info({ periodKey, total }, 'leaderboards frozen');
  return total;
}

// ---------------------------------------------------------------------------
// PRESTIGE
// ---------------------------------------------------------------------------

export async function previewPrestige(player: PlayerContext) {
  const balance = getBalance();
  const eligibility = checkPrestigeEligibility(player, balance);
  const unlockedPlots = await farmRepo.countUnlockedPlots(player.farmId);
  const plan = planPrestige(
    {
      level: player.level,
      xp: player.xp,
      coins: player.coins,
      prestige: player.prestige,
      unlockedPlots,
    },
    balance,
  );
  return { eligibility, plan, unlockedPlots };
}

/**
 * Refuse la renaissance tant que des biens sont en dépôt hors de l'inventaire
 * (annonces, enchères, échanges, fabrications). La remise à zéro ne les voyait
 * pas : annuler l'annonce ou récupérer la fabrication APRÈS la renaissance
 * rendait les objets, contournant l'effacement de l'inventaire. Refuser plutôt
 * qu'annuler d'office : le joueur garde la main sur ce qu'il récupère. La
 * banque, elle, survit à la renaissance par conception et n'est pas concernée.
 */
async function assertNothingInEscrow(
  player: Pick<PlayerContext, 'id' | 'locale'>,
  tx: Transaction,
): Promise<void> {
  const blockers = await playerRepo.countPrestigeBlockers(player.id, tx);
  const reasons: string[] = [];
  if (blockers.listings > 0) {
    reasons.push(translate(player.locale, 'errors.account.blocker_listings', { count: blockers.listings }));
  }
  if (blockers.bids > 0) {
    reasons.push(translate(player.locale, 'errors.player.prestige_blocker_bids', { count: blockers.bids }));
  }
  if (blockers.trades > 0) {
    reasons.push(translate(player.locale, 'errors.account.blocker_trades', { count: blockers.trades }));
  }
  if (blockers.crafts > 0) {
    reasons.push(translate(player.locale, 'errors.player.prestige_blocker_crafts', { count: blockers.crafts }));
  }
  if (reasons.length === 0) return;
  throw gameError('invalid_state', 'Settle your listings, bids, trades and crafts before prestige.', {
    i18nKey: 'errors.player.prestige_blocked',
    hintKey: 'errors.player.prestige_blocked_hint',
    params: { reasons: reasons.join('\n• ') },
    context: { blockers },
  });
}

/**
 * Exécute la renaissance. Action IRRÉVERSIBLE, donc :
 *  - elle est toujours précédée d'un aperçu et d'une double confirmation ;
 *  - elle est journalisée dans l'audit ;
 *  - elle se déroule dans une transaction unique : impossible de se retrouver
 *    avec un niveau remis à zéro mais les parcelles conservées.
 */
export async function doPrestige(player: PlayerContext): Promise<{
  newPrestige: number;
  multiplier: number;
  plotsKept: number;
  coinsKept: number;
  pointsGained: number;
}> {
  const balance = getBalance();
  const { eligibility, unlockedPlots } = await previewPrestige(player);
  if (!eligibility.eligible) {
    throw gameError('level_too_low', 'Prestige unavailable.', {
      i18nKey: eligibility.reasonKey ?? 'errors.player.prestige_unavailable',
      params: eligibility.reasonParams,
    });
  }

  return withTransaction(async (tx) => {
    const locked = await lockUserRow(tx, player.id);
    if (!locked) {
      throw gameError('not_registered', 'Player not found.', {
        i18nKey: 'errors.player_not_found',
      });
    }
    await assertNothingInEscrow(player, tx);
    const schema = await import('../db/schema');
    const { eq, sql, gt, inArray } = await import('drizzle-orm');

    // Le plan est REJOUÉ sous verrou : celui de l'aperçu s'appuie sur le solde
    // du contexte, lu hors transaction, et une récolte encaissée entre-temps
    // fausserait le montant conservé.
    const lockedPlan = planPrestige(
      {
        level: locked.level,
        xp: locked.xp,
        coins: locked.coins,
        prestige: player.prestige,
        unlockedPlots,
      },
      balance,
    );
    const coinsBefore = locked.coins;
    const coinsAfter = lockedPlan.coinsKept + lockedPlan.startingCoins;

    // 1. Niveau, XP, énergie, prestige et points.
    await tx
      .update(schema.users)
      .set({
        level: 1,
        xp: 0,
        coins: coinsAfter,
        prestige: lockedPlan.newPrestige,
        prestigePoints: sql`${schema.users.prestigePoints} + ${lockedPlan.pointsGained}`,
        energy: balance.energy.startingMax,
        energyUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, player.id));

    // La VARIATION du solde, jamais le solde lui-même : le prestige détruit des
    // pièces, la ligne doit donc être négative pour que
    // `SUM(transactions) = users.coins` continue de tenir. Y écrire le solde
    // entier créait un écart permanent, signalé chaque heure par l'audit.
    await economyRepo.recordDirectBalanceLedger(
      {
        userId: player.id,
        type: 'prestige_reset',
        amount: coinsAfter - coinsBefore,
        balanceAfter: coinsAfter,
        metadata: {
          prestige: lockedPlan.newPrestige,
          kept: lockedPlan.coinsKept,
          before: coinsBefore,
        },
      },
      tx,
    );

    // 2. Parcelles : on reverrouille au-delà de la moitié conservée.
    await tx
      .update(schema.plots)
      .set({
        state: 'locked',
        unlockedAt: null,
        fertility: balance.fertility.start,
        weedLevel: 0,
        lastWeededAt: null,
        lastHarvestAt: null,
        pestType: null,
        pestAppearedAt: null,
        pestDeadlineAt: null,
      })
      .where(
        (await import('drizzle-orm')).and(
          eq(schema.plots.farmId, player.farmId),
          gt(schema.plots.slot, lockedPlan.plotsKept),
        ),
      );

    // 3. Cultures en cours : perdues. Les parcelles conservées repartent à
    // « vide » quel que soit leur état — `withered` compris, écrit par le job de
    // flétrissement. Sans lui, la parcelle restait comptée comme libre à
    // l'affichage mais refusée par `plant()`, donc définitivement morte.
    await tx.delete(schema.plantedCrops).where(eq(schema.plantedCrops.userId, player.id));
    await tx
      .update(schema.plots)
      .set({
        state: 'empty',
        pestType: null,
        pestAppearedAt: null,
        pestDeadlineAt: null,
      })
      .where(
        (await import('drizzle-orm')).and(
          eq(schema.plots.farmId, player.farmId),
          inArray(schema.plots.state, ['planted', 'growing', 'ready', 'withered']),
        ),
      );

    // 4. Animaux (non conservés par défaut).
    if (!lockedPlan.animalsKept) {
      await tx.delete(schema.ownedAnimals).where(eq(schema.ownedAnimals.userId, player.id));
    }

    // 5. Inventaire : seules les catégories listées survivent.
    await inventoryRepo.wipeInventoryExcept(player.id, lockedPlan.inventoryCategoriesKept, tx);
    // Kit de renaissance : une récompense de prestige, jamais refusée.
    await inventoryService.addItems(
      player.id,
      [
        { itemKey: 'seed_wheat', quantity: 15 },
        { itemKey: 'fertilizer_basic', quantity: 3 },
      ],
      tx,
      { allowOverflow: true },
    );

    await systemRepo.audit(
      {
        actorId: player.id,
        actorDiscordId: player.discordId,
        action: 'prestige',
        targetType: 'user',
        targetId: player.id,
        payload: { from: locked.level, prestige: lockedPlan.newPrestige, unlockedPlots },
        severity: 'info',
      },
      tx,
    );

    log.info({ userId: player.id, prestige: lockedPlan.newPrestige }, 'rebirth completed');

    return {
      newPrestige: lockedPlan.newPrestige,
      multiplier: lockedPlan.newMultiplier,
      plotsKept: lockedPlan.plotsKept,
      coinsKept: lockedPlan.coinsKept,
      pointsGained: lockedPlan.pointsGained,
    };
  });
}

// ---------------------------------------------------------------------------
// VISITES ET PARRAINAGE
// ---------------------------------------------------------------------------

/**
 * Vérifie le plafond quotidien d'aides, sans rien modifier.
 *
 * Exposé séparément pour que l'appelant le contrôle AVANT d'arroser la ferme
 * hôte : les deux opérations vivent dans des transactions distinctes, et
 * l'ancien ordre laissait le travail fait avant de le refuser.
 */
export async function assertCanHelp(visitor: PlayerContext): Promise<void> {
  const balance = getBalance();
  const helpsToday = await socialRepo.countHelpsToday(visitor.id, toSqlDate(new Date()));
  if (helpsToday >= balance.social.maxHelpsPerDay) {
    throw gameError(
      'forbidden',
      `You have already helped ${balance.social.maxHelpsPerDay} farmers today.`,
      { i18nKey: 'errors.social.help_limit', params: { max: balance.social.maxHelpsPerDay } },
    );
  }
}

export async function recordVisit(
  visitor: PlayerContext,
  host: { id: string; farmId: string },
  helped: boolean,
  plotsWatered: number,
): Promise<{ rewarded: boolean; coins: number; xp: number; levelUp?: LevelUpSummary | null }> {
  const balance = getBalance();
  const today = toSqlDate(new Date());

  if (visitor.id === host.id) return { rewarded: false, coins: 0, xp: 0 };

  if (helped) await assertCanHelp(visitor);

  const coins = helped ? balance.social.helpRewardCoins : balance.social.visitRewardCoins;
  const xp = helped ? balance.social.helpRewardXp : balance.social.visitRewardXp;

  return withTransaction(async (tx) => {
    const rewarded = await socialRepo.recordVisit(
      {
        visitorId: visitor.id,
        hostId: host.id,
        helped,
        plotsWatered,
        rewardCoins: coins,
        rewardXp: xp,
        visitDate: today,
      },
      tx,
    );

    // Sans récompense (déjà visité aujourd'hui), la visite reste possible : on ne
    // bloque jamais la consultation, on ne paie simplement pas deux fois.
    if (!rewarded) return { rewarded: false, coins: 0, xp: 0 };

    await economyService.pay(
      { userId: visitor.id, amount: coins, type: 'quest_reward', counterpartyId: host.id },
      tx,
    );
    const levelUp = levelUpOf(await grantXp(visitor.id, xp, tx));

    if (helped) {
      // L'hôte reçoit aussi une petite récompense : l'entraide profite aux deux,
      // sinon personne n'accepterait les visites.
      await economyService.pay(
        { userId: host.id, amount: Math.floor(coins / 2), type: 'quest_reward', counterpartyId: visitor.id },
        tx,
      );
      await tx
        .update((await import('../db/schema')).farms)
        .set({ helpsReceived: (await import('drizzle-orm')).sql`helps_received + 1` })
        .where((await import('drizzle-orm')).eq((await import('../db/schema')).farms.id, host.farmId));
    }

    await tx
      .update((await import('../db/schema')).farms)
      .set({ visitsCount: (await import('drizzle-orm')).sql`visits_count + 1` })
      .where((await import('drizzle-orm')).eq((await import('../db/schema')).farms.id, host.farmId));

    const { trackAction } = await import('./tracker.service');
    await trackAction(
      { userId: visitor.id, coopId: visitor.coopId, level: visitor.level },
      helped ? 'help_farmer' : 'visit_farm',
      1,
      {},
      tx,
    );

    return { rewarded: true, coins, xp, levelUp };
  });
}

export async function referralStatus(userId: string) {
  const user = await playerRepo.findUserById(userId);
  const balance = getBalance();
  return {
    code: user?.referralCode ?? '',
    rewardCoins: balance.social.referralRewardCoins,
    rewardGems: balance.social.referralRewardGems,
    qualifyLevel: balance.social.referralQualifyLevel,
    referredBy: user?.referredBy ?? null,
  };
}

// ---------------------------------------------------------------------------
// VOTES
// ---------------------------------------------------------------------------

export interface VoteResult {
  userId: string;
  gems: number;
  coins: number;
  weekend: boolean;
  premiumGranted: boolean;
  nextVoteAt: Date;
}

/**
 * Enregistre un vote confirmé par top.gg et verse la récompense.
 *
 * Cette fonction manquait entièrement : `/vote` affichait un lien et un montant,
 * mais rien ne créditait jamais quoi que ce soit, et `grantPassPremium` n'avait
 * aucun appelant — la moitié des récompenses de chaque palier du passe était
 * donc inaccessible.
 *
 * L'idempotence passe par `claimOnce` : top.gg relivre son webhook en cas de
 * réponse lente, et un vote ne doit payer qu'une fois.
 */
export async function recordVote(
  discordId: string,
  options: { weekend?: boolean; voteId?: string } = {},
): Promise<VoteResult | null> {
  const balance = getBalance();
  const user = await playerRepo.findUserByDiscordId(discordId);
  if (!user) return null;

  const weekend = options.weekend ?? isWeekend();
  const multiplier = weekend ? balance.vote.weekendMultiplier : 1;
  const gems = scaleMoney(balance.vote.rewardGems, multiplier);
  const coins = scaleMoney(balance.vote.rewardCoins, multiplier);

  // Fenêtre d'idempotence alignée sur le cooldown : deux livraisons du même
  // vote ne peuvent pas payer deux fois, y compris à cheval sur un redémarrage.
  const token = `vote:${options.voteId ?? `${user.id}:${dailyCycleKey(new Date())}`}`;
  if (!(await claimOnce(token, balance.vote.cooldownHours * 3_600))) {
    return null;
  }

  const pass = getActiveSeasonPass();
  let premiumGranted = false;

  try {
    await withTransaction(async (tx) => {
      await lockUserRow(tx, user.id);
      if (gems > 0) {
        await economyService.pay(
          { userId: user.id, amount: gems, currency: 'gems', type: 'vote_reward' },
          tx,
        );
      }
      if (coins > 0) {
        await economyService.pay({ userId: user.id, amount: coins, type: 'vote_reward' }, tx);
      }

      // Voter débloque la voie premium du passe en cours.
      if (pass) {
        await progressionRepo.grantPassPremium(user.id, pass.id, tx);
        premiumGranted = true;
      }
    });
  } catch (error) {
    // La marque d'idempotence a été posée AVANT le paiement : si celui-ci
    // échoue, la garder condamnerait le joueur à ne rien toucher pendant toute
    // la fenêtre de cooldown, sans que personne ne le sache — le webhook top.gg
    // a déjà reçu son 200. On la rend, la relivraison suivante repaiera.
    await releaseOnce(token);
    throw error;
  }

  // Le cooldown affiché par `/vote` était consulté mais jamais posé.
  await setCooldown(user.id, 'vote', balance.vote.cooldownHours * 3_600);

  await systemRepo.audit({
    actorId: user.id,
    actorDiscordId: discordId,
    action: 'vote',
    targetType: 'user',
    targetId: user.id,
    payload: { gems, coins, weekend, premiumGranted },
    severity: 'info',
  });

  log.info({ userId: user.id, gems, coins, weekend }, 'vote enregistré');

  return {
    userId: user.id,
    gems,
    coins,
    weekend,
    premiumGranted,
    nextVoteAt: new Date(Date.now() + balance.vote.cooldownHours * 3_600_000),
  };
}

export function voteInfo() {
  const balance = getBalance();
  return {
    url: env.TOPGG_VOTE_URL ?? 'https://top.gg',
    rewardGems: balance.vote.rewardGems,
    rewardCoins: balance.vote.rewardCoins,
    weekendMultiplier: balance.vote.weekendMultiplier,
    cooldownHours: balance.vote.cooldownHours,
  };
}

// ---------------------------------------------------------------------------
// ADMINISTRATION
// ---------------------------------------------------------------------------

export interface AdminGrantInput {
  actor: PlayerContext;
  targetDiscordId: string;
  resource: 'coins' | 'gems' | 'xp' | 'item' | 'energy';
  amount: number;
  itemKey?: string;
  reason?: string;
}

/**
 * Attribution ou retrait de ressources par un administrateur.
 * TOUT passe par le journal comptable et l'audit : une commande admin est la
 * seule façon de créer de la monnaie hors gameplay, elle doit donc être la plus
 * traçable du système.
 */
export async function adminGrant(
  input: AdminGrantInput,
  remove = false,
): Promise<{ targetId: string; applied: number }> {
  const target = await playerRepo.findUserByDiscordId(input.targetDiscordId);
  if (!target) {
    throw gameError('not_found', 'Player not found.', { i18nKey: 'errors.player_not_found' });
  }
  const amount = Math.abs(Math.floor(input.amount));

  return withTransaction(async (tx) => {
    await lockUserRow(tx, target.id);

    switch (input.resource) {
      case 'coins':
      case 'gems': {
        const currency = input.resource;
        if (remove) {
          await economyService.charge(
            {
              userId: target.id,
              amount,
              currency,
              type: 'admin_remove',
              metadata: { actor: input.actor.discordId, reason: input.reason },
            },
            tx,
          );
        } else {
          await economyService.pay(
            {
              userId: target.id,
              amount,
              currency,
              type: 'admin_grant',
              metadata: { actor: input.actor.discordId, reason: input.reason },
            },
            tx,
          );
        }
        break;
      }
      case 'xp':
        if (remove) {
          await removeXpAmount(target.id, amount, tx);
        } else {
          await grantXp(target.id, amount, tx);
        }
        break;
      case 'energy':
        await playerRepo.setEnergy(
          target.id,
          {
            energy: Math.min(target.energyMax, Math.max(0, target.energy + (remove ? -amount : amount))),
            energyUpdatedAt: new Date(),
          },
          tx,
        );
        break;
      case 'item': {
        if (!input.itemKey) {
          throw gameError('item_unknown', 'Specify the item key.', {
            i18nKey: 'errors.admin.specify_item_key',
          });
        }
        if (remove) {
          await inventoryService.consume(target.id, input.itemKey, amount, tx, input.actor.locale);
        } else {
          // Don administratif (compensation, support) : une récompense manuelle,
          // jamais refusée pour un entrepôt plein.
          await inventoryService.addItems(
            target.id,
            [{ itemKey: input.itemKey, quantity: amount }],
            tx,
            { allowOverflow: true },
          );
        }
        break;
      }
      default:
        throw gameError('target_invalid', 'Unknown resource.', {
          i18nKey: 'errors.admin.unknown_resource',
        });
    }

    await systemRepo.audit(
      {
        actorId: input.actor.id,
        actorDiscordId: input.actor.discordId,
        action: remove ? 'admin_remove' : 'admin_grant',
        targetType: 'user',
        targetId: target.id,
        targetDiscordId: target.discordId,
        reason: input.reason ?? null,
        payload: { resource: input.resource, amount, itemKey: input.itemKey },
        severity: 'warn',
      },
      tx,
    );

    return { targetId: target.id, applied: amount };
  });
}

export async function adminEcoBan(
  actor: PlayerContext,
  targetDiscordId: string,
  durationHours: number,
  reason: string,
): Promise<{ until: Date }> {
  const target = await playerRepo.findUserByDiscordId(targetDiscordId);
  if (!target) {
    throw gameError('not_found', 'Player not found.', { i18nKey: 'errors.player_not_found' });
  }
  const until = new Date(Date.now() + Math.max(1, durationHours) * 3_600_000);

  await playerRepo.setEcoBan(target.id, until, reason);
  await systemRepo.audit({
    actorId: actor.id,
    actorDiscordId: actor.discordId,
    action: 'admin_eco_ban',
    targetType: 'user',
    targetId: target.id,
    targetDiscordId: target.discordId,
    reason,
    payload: { until: until.toISOString(), durationHours },
    severity: 'warn',
  });

  return { until };
}

export async function adminResetPlayer(
  actor: PlayerContext,
  targetDiscordId: string,
  reason: string,
): Promise<void> {
  const target = await playerRepo.findUserByDiscordId(targetDiscordId);
  if (!target) {
    throw gameError('not_found', 'Player not found.', { i18nKey: 'errors.player_not_found' });
  }

  await withTransaction(async (tx) => {
    const schema = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    // Soft delete : le joueur disparaît du jeu mais son journal comptable reste
    // consultable pour l'audit. Un `/start` recréera un compte neuf.
    await tx
      .update(schema.users)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.users.id, target.id));

    await systemRepo.audit(
      {
        actorId: actor.id,
        actorDiscordId: actor.discordId,
        action: 'admin_reset',
        targetType: 'user',
        targetId: target.id,
        targetDiscordId: target.discordId,
        reason,
        payload: { level: target.level, coins: target.coins },
        severity: 'error',
      },
      tx,
    );
  });
}

/** Recharge la configuration de gameplay et les traductions à chaud. */
export async function adminReloadConfig(actor: PlayerContext): Promise<{
  crops: number;
  items: number;
  recipes: number;
  quests: number;
  loadedAt: Date;
}> {
  const config = reloadConfig();
  reloadCatalogs();
  // Même raison que la maintenance : sans diffusion, seuls les joueurs servis
  // par ce shard voient la nouvelle configuration.
  await broadcast({ type: 'reload-config' });

  await systemRepo.audit({
    actorId: actor.id,
    actorDiscordId: actor.discordId,
    action: 'admin_reload_config',
    payload: { loadedAt: config.loadedAt.toISOString() },
    severity: 'warn',
  });

  return {
    crops: config.cropList.length,
    items: config.itemList.length,
    recipes: config.recipeList.length,
    quests: config.questList.length,
    loadedAt: config.loadedAt,
  };
}

export async function adminStats() {
  const [counts, economy, tasks] = await Promise.all([
    systemRepo.globalCounts(),
    economyService.economyDashboard(),
    systemRepo.listTasks(),
  ]);
  const config = getConfig();

  return {
    counts,
    economy,
    tasks: tasks.slice(0, 12),
    config: {
      loadedAt: config.loadedAt,
      crops: config.cropList.length,
      items: config.itemList.length,
      recipes: config.recipeList.length,
    },
  };
}

export async function adminLookup(targetDiscordId: string, limit = 15) {
  const [target, logs] = await Promise.all([
    playerRepo.findUserByDiscordId(targetDiscordId),
    systemRepo.listAuditForTarget(targetDiscordId, limit),
  ]);
  if (!target) {
    throw gameError('not_found', 'Player not found.', { i18nKey: 'errors.player_not_found' });
  }
  const transactions = await economyRepo.listTransactions(target.id, limit);
  return { target, logs, transactions };
}

// ---------------------------------------------------------------------------
// MAINTENANCE
// ---------------------------------------------------------------------------

let maintenanceState = { enabled: env.MAINTENANCE_MODE, message: env.MAINTENANCE_MESSAGE };

export function getMaintenance(): { enabled: boolean; message: string } {
  return { ...maintenanceState };
}

/**
 * Applique l'état de maintenance au process courant, sans le rediffuser.
 * Appelé par le récepteur inter-shards ; l'ordre initial passe par
 * `setMaintenance`.
 */
export function applyMaintenanceLocally(enabled: boolean, message: string): void {
  maintenanceState = { enabled, message };
  log.warn({ enabled }, 'maintenance appliquée (ordre inter-shards)');
}

export async function setMaintenance(
  actor: PlayerContext,
  enabled: boolean,
  message?: string,
): Promise<void> {
  maintenanceState = {
    enabled,
    message: message ?? maintenanceState.message,
  };
  // `maintenanceState` est une variable de PROCESS : sans diffusion, la
  // maintenance n'éteignait que le shard qui a reçu la commande.
  await broadcast({
    type: 'maintenance',
    enabled: maintenanceState.enabled,
    message: maintenanceState.message,
  });
  await systemRepo.audit({
    actorId: actor.id,
    actorDiscordId: actor.discordId,
    action: 'admin_maintenance',
    payload: { enabled, message: maintenanceState.message },
    severity: 'warn',
  });
  log.warn({ enabled }, 'maintenance mode changed');
}

/** Statistiques d'un joueur pour `/stats`. */
export async function playerStats(discordId: string) {
  const user = await playerRepo.findUserByDiscordId(discordId);
  if (!user) return null;
  const [farm, animals, inventoryTotal, streak, ranks] = await Promise.all([
    playerRepo.getFarmByUserId(user.id),
    animalRepo.listAnimals((await playerRepo.getFarmByUserId(user.id))?.id ?? '', { includeDead: true }),
    inventoryRepo.totalQuantity(user.id),
    playerRepo.getDailyStreak(user.id),
    Promise.all([
      socialRepo.userRank('wealth', user.id),
      socialRepo.userRank('level', user.id),
      socialRepo.userRank('harvests', user.id),
    ]),
  ]);

  return {
    user,
    farm,
    animalsTotal: animals.length,
    animalsAlive: animals.filter((entry) => entry.animal.isAlive).length,
    inventoryTotal,
    streak: streak?.currentStreak ?? 0,
    longestStreak: streak?.longestStreak ?? 0,
    ranks: { wealth: ranks[0], level: ranks[1], harvests: ranks[2] },
  };
}
