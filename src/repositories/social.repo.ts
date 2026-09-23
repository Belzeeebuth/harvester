import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import {
  auditLogs,
  coopMembers,
  coopObjectives,
  coopTreasuryLog,
  coops,
  farmVisits,
  leaderboardSnapshots,
  users,
} from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/** Coopératives, visites de ferme et classements. */

export type CoopRow = typeof coops.$inferSelect;
export type CoopMemberRow = typeof coopMembers.$inferSelect;

export async function findCoopById(coopId: string, executor: Executor = getDb()) {
  const [row] = await executor.select().from(coops).where(eq(coops.id, coopId)).limit(1);
  return row;
}

export async function findCoopByNameOrTag(query: string, executor: Executor = getDb()) {
  const [row] = await executor
    .select()
    .from(coops)
    .where(sql`lower(${coops.name}) = lower(${query}) OR upper(${coops.tag}) = upper(${query})`)
    .limit(1);
  return row;
}

export async function getMembership(userId: string, executor: Executor = getDb()) {
  const [row] = await executor
    .select({ member: coopMembers, coop: coops })
    .from(coopMembers)
    .innerJoin(coops, eq(coops.id, coopMembers.guildId))
    .where(eq(coopMembers.userId, userId))
    .limit(1);
  return row;
}

export async function createCoop(
  input: { name: string; tag: string; ownerId: string; description?: string; emblem?: string; memberLimit: number },
  executor: Executor,
): Promise<CoopRow> {
  const coopId = uuidv7();
  const [coop] = await executor
    .insert(coops)
    .values({
      id: coopId,
      name: input.name,
      tag: input.tag.toUpperCase(),
      description: input.description,
      emblem: input.emblem ?? '🌾',
      ownerId: input.ownerId,
      memberLimit: input.memberLimit,
      memberCount: 1,
    })
    .returning();

  await executor.insert(coopMembers).values({
    id: uuidv7(),
    guildId: coopId,
    userId: input.ownerId,
    role: 'owner',
  });

  return coop!;
}

/**
 * Ajoute un membre en vérifiant la capacité de façon atomique.
 * On incrémente `member_count` sous condition `< member_limit` : deux joueurs qui
 * rejoignent la dernière place simultanément ne peuvent pas passer tous les deux.
 */
export async function joinCoop(
  coopId: string,
  userId: string,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(coops)
    .set({ memberCount: sql`${coops.memberCount} + 1`, updatedAt: new Date() })
    .where(and(eq(coops.id, coopId), sql`${coops.memberCount} < ${coops.memberLimit}`));

  if ((result.rowCount ?? 0) === 0) return false;

  await executor
    .insert(coopMembers)
    .values({ id: uuidv7(), guildId: coopId, userId, role: 'member' });
  return true;
}

/**
 * Retire un membre et renvoie le nombre de membres RESTANTS, ou `undefined` si
 * le joueur n'était (plus) membre de cette coopérative. Le décompte vient de
 * l'UPDATE lui-même : c'est la seule valeur fiable pour décider d'une
 * dissolution, un départ ou une exclusion concurrents ayant pu passer entre-temps.
 */
export async function removeMember(
  coopId: string,
  userId: string,
  executor: Executor,
): Promise<{ remaining: number } | undefined> {
  const result = await executor
    .delete(coopMembers)
    .where(and(eq(coopMembers.guildId, coopId), eq(coopMembers.userId, userId)));
  if ((result.rowCount ?? 0) === 0) return undefined;

  const [row] = await executor
    .update(coops)
    .set({ memberCount: sql`GREATEST(${coops.memberCount} - 1, 0)`, updatedAt: new Date() })
    .where(eq(coops.id, coopId))
    .returning({ memberCount: coops.memberCount });
  return { remaining: row?.memberCount ?? 0 };
}

export async function leaveCoop(
  coopId: string,
  userId: string,
  executor: Executor,
): Promise<boolean> {
  return (await removeMember(coopId, userId, executor)) !== undefined;
}

/** Action d'audit d'un départ volontaire : sert aussi au délai avant de rejoindre. */
export const COOP_LEAVE_AUDIT_ACTION = 'coop_leave';

/**
 * Dernier départ VOLONTAIRE du joueur (`/coop leave`), lu dans le journal
 * d'audit (index `actor_id, created_at`). Une exclusion n'y figure pas : elle
 * n'est pas du fait du joueur et ne lui impose pas de délai.
 */
export async function lastVoluntaryLeaveAt(
  userId: string,
  executor: Executor = getDb(),
): Promise<Date | undefined> {
  const [row] = await executor
    .select({ at: auditLogs.createdAt })
    .from(auditLogs)
    .where(and(eq(auditLogs.actorId, userId), eq(auditLogs.action, COOP_LEAVE_AUDIT_ACTION)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return row?.at;
}

/**
 * Supprime définitivement une coopérative vidée de ses membres.
 *
 * Sans cela, la ligne survivait au départ du dernier membre : sa trésorerie
 * sortait de l'économie sans être détruite, son nom et son tag restaient
 * réservés à jamais, et `listPublicCoops` proposait des coops fantômes dont le
 * premier arrivant héritait du magot. Le service annonçait pourtant
 * « dissoute » au joueur.
 *
 * Les objectifs, le journal de trésorerie et les membres partent en cascade.
 */
export async function dissolveCoop(coopId: string, executor: Executor): Promise<boolean> {
  const result = await executor
    .delete(coops)
    .where(and(eq(coops.id, coopId), lte(coops.memberCount, 0)));
  return (result.rowCount ?? 0) > 0;
}

export async function listMembers(coopId: string, executor: Executor = getDb()) {
  return executor
    .select({
      member: coopMembers,
      username: users.username,
      displayName: users.displayName,
      discordId: users.discordId,
      level: users.level,
      prestige: users.prestige,
    })
    .from(coopMembers)
    .innerJoin(users, eq(users.id, coopMembers.userId))
    .where(eq(coopMembers.guildId, coopId))
    .orderBy(desc(coopMembers.weeklyContribution), asc(coopMembers.joinedAt));
}

export async function setMemberRole(
  coopId: string,
  userId: string,
  role: 'owner' | 'officer' | 'member',
  executor: Executor,
): Promise<void> {
  await executor
    .update(coopMembers)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(coopMembers.guildId, coopId), eq(coopMembers.userId, userId)));
}

export async function lockCoop(tx: Executor, coopId: string) {
  const [row] = await tx.select().from(coops).where(eq(coops.id, coopId)).limit(1).for('update');
  return row;
}

/** Verse des pièces à la trésorerie et journalise l'opération. */
export async function contributeTreasury(
  coopId: string,
  userId: string,
  amount: number,
  note: string,
  executor: Executor,
): Promise<number> {
  const [row] = await executor
    .update(coops)
    .set({ treasury: sql`${coops.treasury} + ${amount}`, updatedAt: new Date() })
    .where(eq(coops.id, coopId))
    .returning({ treasury: coops.treasury });

  await executor
    .update(coopMembers)
    .set({
      contributedCoins: sql`${coopMembers.contributedCoins} + ${amount}`,
      weeklyContribution: sql`${coopMembers.weeklyContribution} + ${amount}`,
      lastContributionAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(coopMembers.guildId, coopId), eq(coopMembers.userId, userId)));

  await executor.insert(coopTreasuryLog).values({
    guildId: coopId,
    userId,
    operation: 'deposit',
    amount,
    balanceAfter: row?.treasury ?? 0,
    note,
  });

  return row?.treasury ?? 0;
}

export async function withdrawTreasury(
  coopId: string,
  userId: string,
  amount: number,
  operation: 'withdraw' | 'upgrade' | 'reward',
  note: string,
  executor: Executor,
): Promise<number | null> {
  const [row] = await executor
    .update(coops)
    .set({ treasury: sql`${coops.treasury} - ${amount}`, updatedAt: new Date() })
    .where(and(eq(coops.id, coopId), gte(coops.treasury, amount)))
    .returning({ treasury: coops.treasury });

  if (!row) return null;

  await executor.insert(coopTreasuryLog).values({
    guildId: coopId,
    userId,
    operation,
    amount: -amount,
    balanceAfter: row.treasury,
    note,
  });

  return row.treasury;
}

export async function addCoopXp(
  coopId: string,
  level: number,
  xp: number,
  executor: Executor,
): Promise<void> {
  await executor
    .update(coops)
    .set({
      level,
      xp,
      totalScore: sql`${coops.totalScore} + ${xp}`,
      weeklyScore: sql`${coops.weeklyScore} + ${xp}`,
      updatedAt: new Date(),
    })
    .where(eq(coops.id, coopId));
}

export async function listPublicCoops(limit: number, executor: Executor = getDb()) {
  return executor
    .select({
      id: coops.id,
      name: coops.name,
      tag: coops.tag,
      emblem: coops.emblem,
      level: coops.level,
      memberCount: coops.memberCount,
      memberLimit: coops.memberLimit,
      joinRequirementLevel: coops.joinRequirementLevel,
      weeklyScore: coops.weeklyScore,
      description: coops.description,
    })
    .from(coops)
    .where(and(eq(coops.isPublic, true), sql`${coops.deletedAt} IS NULL`))
    .orderBy(desc(coops.weeklyScore))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Objectifs hebdomadaires
// ---------------------------------------------------------------------------

export async function listObjectives(
  coopId: string,
  weekStart: string,
  period: 'weekly' | 'daily' = 'weekly',
  executor: Executor = getDb(),
) {
  return executor
    .select()
    .from(coopObjectives)
    .where(
      and(
        eq(coopObjectives.guildId, coopId),
        eq(coopObjectives.weekStart, weekStart),
        eq(coopObjectives.period, period),
      ),
    )
    .orderBy(asc(coopObjectives.objectiveKey));
}

export async function insertObjectives(
  rows: Array<Omit<typeof coopObjectives.$inferInsert, 'id'>>,
  executor: Executor = getDb(),
): Promise<void> {
  if (rows.length === 0) return;
  await executor
    .insert(coopObjectives)
    .values(rows.map((row) => ({ id: uuidv7(), ...row })))
    .onConflictDoNothing();
}

export async function progressObjective(
  coopId: string,
  objectiveKey: string,
  weekStart: string,
  amount: number,
  executor: Executor = getDb(),
): Promise<{ id: string; progress: number; target: number; completed: boolean } | undefined> {
  const [row] = await executor
    .update(coopObjectives)
    .set({
      progress: sql`LEAST(${coopObjectives.progress} + ${amount}, ${coopObjectives.target})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(coopObjectives.guildId, coopId),
        eq(coopObjectives.objectiveKey, objectiveKey),
        eq(coopObjectives.weekStart, weekStart),
        eq(coopObjectives.status, 'active'),
      ),
    )
    .returning({
      id: coopObjectives.id,
      progress: coopObjectives.progress,
      target: coopObjectives.target,
    });

  if (!row) return undefined;

  const completed = row.progress >= row.target;
  if (completed) {
    await executor
      .update(coopObjectives)
      .set({ status: 'completed', completedAt: new Date() })
      .where(and(eq(coopObjectives.id, row.id), eq(coopObjectives.status, 'active')));
  }
  return { ...row, completed };
}

export async function findObjectivesToDistribute(limit: number, executor: Executor = getDb()) {
  return executor
    .select()
    .from(coopObjectives)
    .where(and(eq(coopObjectives.status, 'completed'), eq(coopObjectives.distributed, false)))
    .limit(limit);
}

export async function markObjectiveDistributed(
  objectiveId: string,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(coopObjectives)
    .set({ distributed: true, updatedAt: new Date() })
    .where(and(eq(coopObjectives.id, objectiveId), eq(coopObjectives.distributed, false)));
  return (result.rowCount ?? 0) > 0;
}

export async function resetWeeklyCoopScores(executor: Executor = getDb()): Promise<void> {
  await executor.update(coops).set({ weeklyScore: 0 });
  await executor.update(coopMembers).set({ weeklyContribution: 0, weeklyScore: 0 });
}

// ---------------------------------------------------------------------------
// Visites et coups de main
// ---------------------------------------------------------------------------

/**
 * Enregistre une visite/aide. L'index unique (visitor, host, date) fait le travail :
 * `onConflictDoNothing` renvoie 0 ligne si l'aide du jour a déjà été comptée,
 * ce qui bloque le farming d'XP entre deux comptes complices sans requête
 * supplémentaire.
 */
export async function recordVisit(
  input: {
    visitorId: string;
    hostId: string;
    helped: boolean;
    plotsWatered: number;
    rewardCoins: number;
    rewardXp: number;
    visitDate: string;
  },
  executor: Executor,
): Promise<boolean> {
  const result = await executor.insert(farmVisits).values(input).onConflictDoNothing();
  return (result.rowCount ?? 0) > 0;
}

export async function countHelpsToday(
  visitorId: string,
  visitDate: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(farmVisits)
    .where(
      and(
        eq(farmVisits.visitorId, visitorId),
        eq(farmVisits.visitDate, visitDate),
        eq(farmVisits.helped, true),
      ),
    );
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Classements
// ---------------------------------------------------------------------------

export type LeaderboardType =
  | 'wealth'
  | 'level'
  | 'harvests'
  | 'animals'
  | 'crafts'
  | 'weekly_xp'
  | 'streak';

const BOARD_COLUMNS = {
  wealth: users.coins,
  level: users.totalXp,
  harvests: users.totalHarvests,
  animals: users.totalAnimalsRaised,
  crafts: users.totalCrafts,
  weekly_xp: users.weeklyXp,
  streak: users.totalHarvests,
} as const;

/**
 * Classement live, calculé en SQL avec une fonction de fenêtre.
 * `RANK() OVER (ORDER BY score DESC)` donne le rang exact en une passe, ce qui
 * évite de rapatrier 100 000 lignes pour compter. Pour les très gros volumes, un
 * ZSET Redis alimenté en écriture prendrait le relais (cf. docs/02).
 */
export async function leaderboard(
  type: LeaderboardType,
  options: { limit?: number; discordGuildId?: string; coopId?: string } = {},
  executor: Executor = getDb(),
): Promise<Array<{ userId: string; discordId: string; username: string; level: number; prestige: number; score: number; rank: number }>> {
  const column = BOARD_COLUMNS[type];
  const conditions = [sql`${users.deletedAt} IS NULL`];
  if (options.discordGuildId) {
    conditions.push(eq(users.lastGuildId, options.discordGuildId));
  }

  const base = executor
    .select({
      userId: users.id,
      discordId: users.discordId,
      username: users.username,
      level: users.level,
      prestige: users.prestige,
      score: sql<number>`${column}`.as('score'),
      rank: sql<number>`RANK() OVER (ORDER BY ${column} DESC)::int`.as('rank'),
    })
    .from(users);

  if (options.coopId) {
    return base
      .innerJoin(coopMembers, eq(coopMembers.userId, users.id))
      .where(and(eq(coopMembers.guildId, options.coopId), ...conditions))
      .orderBy(desc(column))
      .limit(options.limit ?? 10);
  }

  return base
    .where(and(...conditions))
    .orderBy(desc(column))
    .limit(options.limit ?? 10);
}

/** Rang d'un joueur donné (peut être hors du top 10). */
export async function userRank(
  type: LeaderboardType,
  userId: string,
  executor: Executor = getDb(),
): Promise<{ rank: number; score: number } | undefined> {
  const column = BOARD_COLUMNS[type];
  const rows = await executor.execute<{ rank: string; score: string }>(sql`
    SELECT rank, score FROM (
      SELECT id, ${column} AS score, RANK() OVER (ORDER BY ${column} DESC) AS rank
      FROM users WHERE deleted_at IS NULL
    ) ranked WHERE id = ${userId}
  `);
  const row = rows.rows[0];
  return row ? { rank: Number(row.rank), score: Number(row.score) } : undefined;
}

export async function coopLeaderboard(limit: number, executor: Executor = getDb()) {
  return executor
    .select({
      id: coops.id,
      name: coops.name,
      tag: coops.tag,
      emblem: coops.emblem,
      level: coops.level,
      memberCount: coops.memberCount,
      weeklyScore: coops.weeklyScore,
      totalScore: coops.totalScore,
    })
    .from(coops)
    .where(sql`${coops.deletedAt} IS NULL`)
    .orderBy(desc(coops.weeklyScore), desc(coops.totalScore))
    .limit(limit);
}

export async function saveSnapshots(
  rows: Array<Omit<typeof leaderboardSnapshots.$inferInsert, 'id'>>,
  executor: Executor = getDb(),
): Promise<void> {
  if (rows.length === 0) return;
  await executor.insert(leaderboardSnapshots).values(rows).onConflictDoNothing();
}

export async function lastSnapshot(
  boardType: LeaderboardType,
  periodKey: string,
  userId: string,
  executor: Executor = getDb(),
) {
  const [row] = await executor
    .select()
    .from(leaderboardSnapshots)
    .where(
      and(
        eq(leaderboardSnapshots.boardType, boardType),
        eq(leaderboardSnapshots.periodKey, periodKey),
        eq(leaderboardSnapshots.userId, userId),
      ),
    )
    .limit(1);
  return row;
}
