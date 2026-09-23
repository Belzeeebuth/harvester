import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import {
  auctionBids,
  auctionListings,
  bankAccounts,
  coopMembers,
  coops,
  craftingQueue,
  dailyStreaks,
  farms,
  plots,
  settings,
  trades,
  users,
} from '../db/schema';
import type { Balance } from '../config/gameplay/schemas';
import { gridSizeFor, plotUnlockCost, slotToCoords } from '../game/grid';
import { referralCode, uuidv7 } from '../utils/uuid';

/**
 * Accès aux données du joueur : `users`, `settings`, `farms`, `plots`,
 * `bank_accounts`, `daily_streaks` et l'appartenance à une coopérative.
 *
 * Les repositories ne contiennent AUCUNE règle de jeu : ils traduisent des
 * intentions en SQL et rien de plus. C'est ce qui permet de tester la logique
 * métier sans base de données, et de remplacer PostgreSQL sans toucher aux
 * services.
 */

export type UserRow = typeof users.$inferSelect;
export type FarmRow = typeof farms.$inferSelect;
export type PlotRow = typeof plots.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;

export interface PlayerBundle {
  user: UserRow;
  farm: FarmRow;
  settings: SettingsRow;
  coop: { id: string; name: string; tag: string; level: number; role: string } | null;
}

export async function findUserByDiscordId(
  discordId: string,
  executor: Executor = getDb(),
): Promise<UserRow | undefined> {
  const [row] = await executor
    .select()
    .from(users)
    .where(and(eq(users.discordId, discordId), isNull(users.deletedAt)))
    .limit(1);
  return row;
}

export async function findUserById(
  userId: string,
  executor: Executor = getDb(),
): Promise<UserRow | undefined> {
  const [row] = await executor.select().from(users).where(eq(users.id, userId)).limit(1);
  return row;
}

/**
 * Lit le joueur en posant le verrou de ligne (`FOR NO KEY UPDATE`, comme
 * `lockUserRow`) : pour les lectures suivies d'une écriture absolue, l'énergie
 * au premier chef. Sans verrou, deux actions simultanées lisaient la même
 * énergie et la seconde écriture effaçait la dépense de la première.
 */
export async function findUserByIdForUpdate(
  userId: string,
  tx: Executor,
): Promise<UserRow | undefined> {
  const [row] = await tx
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for('no key update');
  return row;
}

/** Charge tout ce qu'il faut pour exécuter une commande, en une seule requête. */
export async function loadPlayerBundle(
  discordId: string,
  executor: Executor = getDb(),
): Promise<PlayerBundle | undefined> {
  const [row] = await executor
    .select({
      user: users,
      farm: farms,
      settings,
      coopId: coops.id,
      coopName: coops.name,
      coopTag: coops.tag,
      coopLevel: coops.level,
      coopRole: coopMembers.role,
    })
    .from(users)
    .innerJoin(farms, eq(farms.userId, users.id))
    .innerJoin(settings, eq(settings.userId, users.id))
    .leftJoin(coopMembers, eq(coopMembers.userId, users.id))
    .leftJoin(coops, eq(coops.id, coopMembers.guildId))
    .where(and(eq(users.discordId, discordId), isNull(users.deletedAt)))
    .limit(1);

  if (!row) return undefined;

  return {
    user: row.user,
    farm: row.farm,
    settings: row.settings,
    coop:
      row.coopId && row.coopName && row.coopTag !== null && row.coopRole
        ? {
            id: row.coopId,
            name: row.coopName,
            tag: row.coopTag,
            level: row.coopLevel ?? 1,
            role: row.coopRole,
          }
        : null,
  };
}

export interface CreatePlayerInput {
  discordId: string;
  username: string;
  displayName?: string;
  avatarHash?: string;
  locale: string;
  balance: Balance;
  referrerId?: string;
  startingCoinsBonus?: number;
}

/**
 * Crée un joueur complet : compte, paramètres, ferme, parcelles de départ,
 * compte bancaire et suivi de série. Le tout dans UNE transaction : soit le
 * joueur existe entièrement, soit il n'existe pas du tout. Un compte à moitié
 * créé (ferme sans parcelles) serait irréparable sans intervention manuelle.
 */
export async function createPlayer(
  input: CreatePlayerInput,
  executor: Executor,
): Promise<{ user: UserRow; farm: FarmRow; settings: SettingsRow }> {
  const balance = input.balance;
  const userId = uuidv7();
  const farmId = uuidv7();
  const startingPlots = balance.plots.startingUnlocked;
  const grid = gridSizeFor(startingPlots, balance);
  const now = new Date();

  const [user] = await executor
    .insert(users)
    .values({
      id: userId,
      discordId: input.discordId,
      username: input.username.slice(0, 32),
      displayName: input.displayName?.slice(0, 64),
      avatarHash: input.avatarHash,
      coins: balance.economy.startingCoins + (input.startingCoinsBonus ?? 0),
      gems: balance.economy.startingGems,
      energy: balance.energy.startingMax,
      energyMax: balance.energy.startingMax,
      energyUpdatedAt: now,
      locale: input.locale,
      referralCode: referralCode(8),
      referredBy: input.referrerId,
      lastSeenAt: now,
    })
    .returning();

  const [settingsRow] = await executor
    .insert(settings)
    .values({ id: uuidv7(), userId, locale: input.locale })
    .returning();

  const [farm] = await executor
    .insert(farms)
    .values({
      id: farmId,
      userId,
      gridWidth: grid.width,
      gridHeight: grid.height,
      warehouseCapacity: balance.plots.startingUnlocked * 34,
      craftingSlots: 1,
    })
    .returning();

  // Toutes les parcelles (1..64) sont créées d'emblée : celles au-delà du
  // palier de départ sont marquées `locked`. Créer les lignes tout de suite
  // évite un INSERT concurrent à chaque achat (donc une race condition sur
  // (farm_id, slot)) et rend le rendu de la grille trivial.
  const plotRows = [];
  for (let slot = 1; slot <= balance.plots.maxPlots; slot += 1) {
    const coords = slotToCoords(slot, balance);
    const unlocked = slot <= startingPlots;
    plotRows.push({
      id: uuidv7(),
      farmId,
      x: coords.x,
      y: coords.y,
      slot,
      state: unlocked ? ('empty' as const) : ('locked' as const),
      fertility: balance.fertility.start,
      unlockedAt: unlocked ? now : null,
      unlockCost: plotUnlockCost(slot, balance),
    });
  }
  await executor.insert(plots).values(plotRows);

  const firstBankTier = balance.bank.tiers[0]!;
  await executor.insert(bankAccounts).values({
    id: uuidv7(),
    userId,
    capacity: firstBankTier.capacity,
    interestRate: firstBankTier.interestRate.toFixed(4),
    interestCap: firstBankTier.interestCap,
  });

  await executor.insert(dailyStreaks).values({ id: uuidv7(), userId });

  return { user: user!, farm: farm!, settings: settingsRow! };
}

/** Met à jour les métadonnées Discord et l'activité (appelé à chaque commande). */
export async function touchUser(
  userId: string,
  data: { username?: string; displayName?: string; avatarHash?: string; discordGuildId?: string },
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(users)
    .set({
      ...(data.username ? { username: data.username.slice(0, 32) } : {}),
      ...(data.displayName ? { displayName: data.displayName.slice(0, 64) } : {}),
      ...(data.avatarHash ? { avatarHash: data.avatarHash } : {}),
      ...(data.discordGuildId ? { lastGuildId: data.discordGuildId } : {}),
      lastSeenAt: new Date(),
      commandsUsed: sql`${users.commandsUsed} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/** Incrémente un ou plusieurs compteurs de statistiques. */
export async function incrementStats(
  userId: string,
  deltas: Partial<
    Record<
      | 'totalHarvests'
      | 'totalPlanted'
      | 'totalCoinsEarned'
      | 'totalCoinsSpent'
      | 'totalAnimalsRaised'
      | 'totalCrafts'
      | 'totalWatered'
      | 'totalHelpGiven',
      number
    >
  >,
  executor: Executor = getDb(),
): Promise<void> {
  const entries = Object.entries(deltas).filter(([, value]) => (value ?? 0) !== 0);
  if (entries.length === 0) return;

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [column, value] of entries) {
    // `keyof typeof deltas` : les seules colonnes autorisées, sans les méthodes de la table.
    const col = users[column as keyof typeof deltas];
    patch[column] = sql`${col} + ${value}`;
  }
  await executor.update(users).set(patch).where(eq(users.id, userId));
}

export async function updateBestHarvest(
  userId: string,
  value: number,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(users)
    .set({ bestHarvestValue: sql`GREATEST(${users.bestHarvestValue}, ${value})` })
    .where(eq(users.id, userId));
}

/** Écrit le niveau et l'XP après un gain (le calcul se fait dans `game/xp.ts`). */
export async function setLevelAndXp(
  userId: string,
  data: { level: number; xp: number; totalXpDelta: number },
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(users)
    .set({
      level: data.level,
      xp: data.xp,
      // GREATEST : `totalXpDelta` négatif (retrait admin) ne doit jamais faire
      // passer le compteur historique sous zéro.
      totalXp: sql`GREATEST(0, ${users.totalXp} + ${data.totalXpDelta})`,
      weeklyXp: sql`GREATEST(0, ${users.weeklyXp} + ${data.totalXpDelta})`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

export async function setEnergy(
  userId: string,
  data: { energy: number; energyUpdatedAt: Date; energyMax?: number },
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(users)
    .set({
      energy: data.energy,
      energyUpdatedAt: data.energyUpdatedAt,
      ...(data.energyMax ? { energyMax: data.energyMax } : {}),
    })
    .where(eq(users.id, userId));
}

export async function getFarmByUserId(
  userId: string,
  executor: Executor = getDb(),
): Promise<FarmRow | undefined> {
  const [row] = await executor.select().from(farms).where(eq(farms.userId, userId)).limit(1);
  return row;
}

export async function updateFarm(
  farmId: string,
  patch: Partial<typeof farms.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(farms)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(farms.id, farmId));
}

export async function getSettings(
  userId: string,
  executor: Executor = getDb(),
): Promise<SettingsRow | undefined> {
  const [row] = await executor.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  return row;
}

export async function updateSettings(
  userId: string,
  patch: Partial<typeof settings.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.userId, userId));
}

export async function getBankAccount(userId: string, executor: Executor = getDb()) {
  const [row] = await executor
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.userId, userId))
    .limit(1);
  return row;
}

export async function getDailyStreak(userId: string, executor: Executor = getDb()) {
  const [row] = await executor
    .select()
    .from(dailyStreaks)
    .where(eq(dailyStreaks.userId, userId))
    .limit(1);
  return row;
}

export async function findUserByReferralCode(code: string, executor: Executor = getDb()) {
  const [row] = await executor
    .select({ id: users.id, level: users.level })
    .from(users)
    .where(eq(users.referralCode, code.toUpperCase()))
    .limit(1);
  return row;
}

/** Marque un joueur comme banni économiquement (commande admin). */
export async function setEcoBan(
  userId: string,
  until: Date | null,
  reason: string | null,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(users)
    .set({ ecoBannedUntil: until, ecoBanReason: reason, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function addSuspicion(
  userId: string,
  amount: number,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .update(users)
    .set({ suspicionScore: sql`${users.suspicionScore} + ${amount}` })
    .where(eq(users.id, userId))
    .returning({ score: users.suspicionScore });
  return row?.score ?? 0;
}

/** Réinitialise l'XP hebdomadaire de tous les joueurs (job du lundi). */
export async function resetWeeklyXp(executor: Executor = getDb()): Promise<number> {
  const result = await executor.update(users).set({ weeklyXp: 0 }).where(sql`${users.weeklyXp} > 0`);
  return result.rowCount ?? 0;
}

export interface PrestigeBlockers {
  /** Annonces encore ouvertes à l'hôtel des ventes (objets en dépôt). */
  listings: number;
  /** Enchères non remboursées sur des annonces ouvertes (pièces en dépôt). */
  bids: number;
  /** Échanges directs en attente (objets verrouillés). */
  trades: number;
  /** Fabrications pas encore récupérées. */
  crafts: number;
}

/**
 * Tout ce qui garde des biens HORS de l'inventaire et des pièces, et que la
 * renaissance ne saurait donc pas remettre à zéro : une annonce annulée, une
 * enchère remboursée ou une fabrication récupérée après coup rendait objets et
 * pièces au joueur fraîchement « remis à zéro ». Les annonces échues pas
 * encore clôturées par le job comptent aussi : leur clôture rend les objets.
 */
export async function countPrestigeBlockers(
  userId: string,
  executor: Executor = getDb(),
): Promise<PrestigeBlockers> {
  const [row] = await executor
    .select({
      listings: sql<number>`(SELECT count(*)::int FROM ${auctionListings}
        WHERE ${auctionListings.sellerId} = ${userId} AND ${auctionListings.status} = 'active')`,
      bids: sql<number>`(SELECT count(*)::int FROM ${auctionBids}
        JOIN ${auctionListings} ON ${auctionListings.id} = ${auctionBids.listingId}
        WHERE ${auctionBids.bidderId} = ${userId} AND ${auctionBids.refunded} = false
          AND ${auctionListings.status} = 'active')`,
      trades: sql<number>`(SELECT count(*)::int FROM ${trades}
        WHERE ${trades.status} = 'pending'
          AND (${trades.initiatorId} = ${userId} OR ${trades.partnerId} = ${userId}))`,
      crafts: sql<number>`(SELECT count(*)::int FROM ${craftingQueue}
        WHERE ${craftingQueue.userId} = ${userId} AND ${craftingQueue.collected} = false)`,
    })
    .from(users)
    .where(eq(users.id, userId));
  return {
    listings: Number(row?.listings ?? 0),
    bids: Number(row?.bids ?? 0),
    trades: Number(row?.trades ?? 0),
    crafts: Number(row?.crafts ?? 0),
  };
}
