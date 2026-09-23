import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import {
  achievementsConfig,
  dailyStreaks,
  questsConfig,
  userAchievements,
  userEvents,
  userQuests,
  userSeasonPass,
  users,
} from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/**
 * Quêtes, succès, passe saisonnier, événements et série quotidienne.
 *
 * Point d'attention : la progression de quête est incrémentée par des dizaines
 * d'actions de jeu (chaque récolte, chaque arrosage). L'opération doit donc être
 * la moins coûteuse possible — une seule requête `UPDATE ... WHERE` filtrée par
 * type d'objectif, jamais un « lire toutes les quêtes puis écrire ».
 */

export type UserQuestRow = typeof userQuests.$inferSelect;

export interface QuestSnapshot {
  title: string;
  description: string;
  rewardCoins: number;
  rewardGems: number;
  rewardXp: number;
  rewardPassXp: number;
  rewardItems: Array<{ itemKey: string; quantity: number }>;
  objectiveType: string;
  objectiveTarget: Record<string, string | undefined>;
}

export async function listUserQuests(
  userId: string,
  options: { type?: 'daily' | 'weekly' | 'story' | 'contract'; cycleKey?: string } = {},
  executor: Executor = getDb(),
): Promise<UserQuestRow[]> {
  const conditions = [eq(userQuests.userId, userId)];
  if (options.type) conditions.push(eq(userQuests.type, options.type));
  if (options.cycleKey) conditions.push(eq(userQuests.cycleKey, options.cycleKey));

  return executor
    .select()
    .from(userQuests)
    .where(and(...conditions))
    .orderBy(asc(userQuests.slotIndex), asc(userQuests.assignedAt));
}

/**
 * Quêtes utiles à l'assignation d'un cycle : celles du cycle journalier et
 * hebdomadaire courants, plus la chaîne narrative. Évite de relire tout
 * l'historique du joueur (des centaines de lignes réclamées) à chaque action.
 */
export async function listCycleQuests(
  userId: string,
  cycleKeys: string[],
  executor: Executor = getDb(),
): Promise<UserQuestRow[]> {
  return executor
    .select()
    .from(userQuests)
    .where(
      and(
        eq(userQuests.userId, userId),
        or(inArray(userQuests.cycleKey, cycleKeys), eq(userQuests.type, 'story')),
      ),
    )
    .orderBy(asc(userQuests.slotIndex), asc(userQuests.assignedAt));
}

/** Niveau courant d'un joueur, lu dans la transaction de l'appelant. */
export async function getUserLevel(
  userId: string,
  executor: Executor = getDb(),
): Promise<number | undefined> {
  const [row] = await executor
    .select({ level: users.level })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.level;
}

export async function assignQuests(
  rows: Array<Omit<typeof userQuests.$inferInsert, 'id'>>,
  executor: Executor = getDb(),
): Promise<void> {
  if (rows.length === 0) return;
  await executor
    .insert(userQuests)
    .values(rows.map((row) => ({ id: uuidv7(), ...row })))
    .onConflictDoNothing();
}

/**
 * Quête encore dans son cycle. Le job `quests:expire` ne passe qu'à 00:10 UTC
 * alors que journalières et hebdomadaires échoient à minuit (heure de Paris) :
 * sans ce filtre, une quête échue progresse et se réclame pendant ce battement.
 */
function notExpired() {
  return sql`(${userQuests.expiresAt} IS NULL OR ${userQuests.expiresAt} > now())`;
}

/**
 * Fait progresser toutes les quêtes actives correspondant à un objectif.
 *
 * Le filtrage sur `objectiveTarget` se fait en SQL avec l'opérateur JSONB `@>`
 * (« contient ») : une quête « récolter 10 tomates » a `{"cropKey":"tomato"}` et
 * ne progresse que si l'action porte bien sur des tomates, tandis qu'une quête
 * « récolter 10 unités » a `{}` et progresse toujours. Un seul UPDATE couvre les
 * deux cas.
 */
export async function progressQuests(
  userId: string,
  objectiveType: string,
  amount: number,
  target: Record<string, string | undefined>,
  executor: Executor = getDb(),
): Promise<UserQuestRow[]> {
  if (amount <= 0) return [];

  const cleanTarget = Object.fromEntries(
    Object.entries(target).filter(([, value]) => value !== undefined),
  );

  const rows = await executor
    .update(userQuests)
    .set({
      progress: sql`LEAST(${userQuests.progress} + ${amount}, ${userQuests.required})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userQuests.userId, userId),
        eq(userQuests.status, 'active'),
        notExpired(),
        sql`${userQuests.snapshot}->>'objectiveType' = ${objectiveType}`,
        // La cible de la quête doit être un SOUS-ENSEMBLE de l'action réalisée.
        sql`${JSON.stringify(cleanTarget)}::jsonb @> (${userQuests.snapshot}->'objectiveTarget')`,
      ),
    )
    .returning();

  // Marque comme terminées celles qui viennent d'atteindre leur cible.
  const completed = rows.filter((row) => row.progress >= row.required);
  if (completed.length > 0) {
    await executor
      .update(userQuests)
      .set({ status: 'completed', completedAt: new Date() })
      .where(
        and(
          inArray(
            userQuests.id,
            completed.map((row) => row.id),
          ),
          eq(userQuests.status, 'active'),
        ),
      );
  }

  return completed;
}

/** Force la progression d'une quête « atteindre le niveau N ». */
export async function setQuestProgress(
  userId: string,
  objectiveType: string,
  value: number,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(userQuests)
    .set({
      progress: sql`LEAST(GREATEST(${userQuests.progress}, ${value}), ${userQuests.required})`,
      status: sql`CASE WHEN LEAST(GREATEST(${userQuests.progress}, ${value}), ${userQuests.required}) >= ${userQuests.required} THEN 'completed'::quest_status ELSE ${userQuests.status} END`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userQuests.userId, userId),
        eq(userQuests.status, 'active'),
        notExpired(),
        sql`${userQuests.snapshot}->>'objectiveType' = ${objectiveType}`,
      ),
    );
}

export async function lockQuest(
  tx: Executor,
  questId: string,
  userId: string,
): Promise<UserQuestRow | undefined> {
  const [row] = await tx
    .select()
    .from(userQuests)
    .where(and(eq(userQuests.id, questId), eq(userQuests.userId, userId)))
    .limit(1)
    .for('update');
  return row;
}

export async function markQuestClaimed(
  questId: string,
  now: Date,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(userQuests)
    .set({ status: 'claimed', claimedAt: now, updatedAt: now })
    .where(
      and(
        eq(userQuests.id, questId),
        eq(userQuests.status, 'completed'),
        sql`(${userQuests.expiresAt} IS NULL OR ${userQuests.expiresAt} > ${now})`,
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Remplace une quête journalière relancée.
 *
 * L'ancienne ligne n'est PAS supprimée : elle passe en `failed` avec
 * `rerolled = true` et sert de témoin pour `countRerollsToday`. Supprimer puis
 * réinsérer faisait disparaître le témoin, le compteur restait à zéro, et la
 * limite quotidienne comme le coût croissant ne s'appliquaient jamais. Garder
 * la ligne empêche aussi de retirer la même quête dans le cycle (index unique).
 */
export async function replaceQuest(
  questId: string,
  replacement: Omit<typeof userQuests.$inferInsert, 'id'>,
  executor: Executor,
): Promise<UserQuestRow | undefined> {
  const now = new Date();
  const retired = await executor
    .update(userQuests)
    .set({ status: 'failed', rerolled: true, updatedAt: now })
    .where(and(eq(userQuests.id, questId), eq(userQuests.status, 'active')));
  if ((retired.rowCount ?? 0) === 0) return undefined;
  const [row] = await executor
    .insert(userQuests)
    // `rerolled` marque aussi la remplaçante (affichage) ; seul le statut
    // `failed` distingue le témoin compté par `countRerollsToday`.
    .values({ id: uuidv7(), ...replacement, rerolled: true })
    .returning();
  return row;
}

/** Relances du jour : une ligne témoin `failed` + `rerolled` par relance. */
export async function countRerollsToday(
  userId: string,
  cycleKey: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(userQuests)
    .where(
      and(
        eq(userQuests.userId, userId),
        eq(userQuests.cycleKey, cycleKey),
        eq(userQuests.type, 'daily'),
        eq(userQuests.rerolled, true),
        eq(userQuests.status, 'failed'),
      ),
    );
  return row?.count ?? 0;
}

export async function expireQuests(
  now: Date,
  executor: Executor = getDb(),
): Promise<number> {
  const result = await executor
    .update(userQuests)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        inArray(userQuests.status, ['active', 'completed']),
        sql`${userQuests.expiresAt} IS NOT NULL AND ${userQuests.expiresAt} <= ${now}`,
      ),
    );
  return result.rowCount ?? 0;
}

/** Quêtes disponibles pour un tirage, filtrées par niveau et par type. */
export async function listQuestPool(
  type: 'daily' | 'weekly' | 'contract',
  level: number,
  executor: Executor = getDb(),
) {
  return executor
    .select()
    .from(questsConfig)
    .where(
      and(
        eq(questsConfig.type, type),
        eq(questsConfig.enabled, true),
        sql`${questsConfig.requiredLevel} <= ${level}`,
      ),
    );
}

export async function nextStoryQuest(
  chainKey: string,
  step: number,
  executor: Executor = getDb(),
) {
  const [row] = await executor
    .select()
    .from(questsConfig)
    .where(
      and(
        eq(questsConfig.chainKey, chainKey),
        eq(questsConfig.chainStep, step),
        eq(questsConfig.enabled, true),
      ),
    )
    .limit(1);
  return row;
}

export async function highestStoryStep(
  userId: string,
  chainKey: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ step: sql<number>`COALESCE(MAX((${userQuests.snapshot}->>'chainStep')::int), 0)` })
    .from(userQuests)
    .where(
      and(
        eq(userQuests.userId, userId),
        eq(userQuests.type, 'story'),
        sql`${userQuests.snapshot}->>'chainKey' = ${chainKey}`,
      ),
    );
  return row?.step ?? 0;
}

// ---------------------------------------------------------------------------
// Succès
// ---------------------------------------------------------------------------

/**
 * Fait progresser les succès d'un type donné et renvoie ceux qui viennent d'être
 * débloqués. `INSERT ... ON CONFLICT DO UPDATE` crée la ligne au premier passage :
 * inutile de pré-remplir 28 succès × N joueurs.
 */
export async function progressAchievements(
  userId: string,
  conditionType: string,
  amount: number,
  target: Record<string, string | undefined>,
  executor: Executor = getDb(),
): Promise<Array<{ key: string; name: string; rewardCoins: number; rewardGems: number; rewardTitle: string | null; rewardBadge: string | null; rewardItems: unknown }>> {
  if (amount <= 0) return [];

  const cleanTarget = Object.fromEntries(
    Object.entries(target).filter(([, value]) => value !== undefined),
  );

  const candidates = await executor
    .select()
    .from(achievementsConfig)
    .where(
      and(
        eq(achievementsConfig.conditionType, conditionType as never),
        eq(achievementsConfig.enabled, true),
        sql`${JSON.stringify(cleanTarget)}::jsonb @> ${achievementsConfig.conditionTarget}`,
      ),
    );

  const unlocked: Array<{
    key: string;
    name: string;
    rewardCoins: number;
    rewardGems: number;
    rewardTitle: string | null;
    rewardBadge: string | null;
    rewardItems: unknown;
  }> = [];

  for (const achievement of candidates) {
    const [row] = await executor
      .insert(userAchievements)
      .values({ userId, achievementKey: achievement.key, progress: amount })
      .onConflictDoUpdate({
        target: [userAchievements.userId, userAchievements.achievementKey],
        set: {
          progress: sql`${userAchievements.progress} + ${amount}`,
          updatedAt: new Date(),
        },
      })
      .returning({ progress: userAchievements.progress, unlocked: userAchievements.unlocked });

    if (row && !row.unlocked && row.progress >= achievement.conditionAmount) {
      await executor
        .update(userAchievements)
        .set({ unlocked: true, unlockedAt: new Date() })
        .where(
          and(
            eq(userAchievements.userId, userId),
            eq(userAchievements.achievementKey, achievement.key),
            eq(userAchievements.unlocked, false),
          ),
        );
      unlocked.push({
        key: achievement.key,
        name: achievement.name,
        rewardCoins: achievement.rewardCoins,
        rewardGems: achievement.rewardGems,
        rewardTitle: achievement.rewardTitle,
        rewardBadge: achievement.rewardBadge,
        rewardItems: achievement.rewardItems,
      });
    }
  }

  return unlocked;
}

/** Force la valeur absolue d'un succès (« atteindre le niveau N »). */
export async function setAchievementProgress(
  userId: string,
  conditionType: string,
  value: number,
  executor: Executor = getDb(),
): Promise<Array<{ key: string; name: string; rewardCoins: number; rewardGems: number; rewardTitle: string | null; rewardBadge: string | null; rewardItems: unknown }>> {
  const candidates = await executor
    .select()
    .from(achievementsConfig)
    .where(
      and(
        eq(achievementsConfig.conditionType, conditionType as never),
        eq(achievementsConfig.enabled, true),
      ),
    );

  const unlocked = [];
  for (const achievement of candidates) {
    const [row] = await executor
      .insert(userAchievements)
      .values({ userId, achievementKey: achievement.key, progress: value })
      .onConflictDoUpdate({
        target: [userAchievements.userId, userAchievements.achievementKey],
        set: { progress: sql`GREATEST(${userAchievements.progress}, ${value})`, updatedAt: new Date() },
      })
      .returning({ progress: userAchievements.progress, unlocked: userAchievements.unlocked });

    if (row && !row.unlocked && row.progress >= achievement.conditionAmount) {
      await executor
        .update(userAchievements)
        .set({ unlocked: true, unlockedAt: new Date() })
        .where(
          and(
            eq(userAchievements.userId, userId),
            eq(userAchievements.achievementKey, achievement.key),
            eq(userAchievements.unlocked, false),
          ),
        );
      unlocked.push({
        key: achievement.key,
        name: achievement.name,
        rewardCoins: achievement.rewardCoins,
        rewardGems: achievement.rewardGems,
        rewardTitle: achievement.rewardTitle,
        rewardBadge: achievement.rewardBadge,
        rewardItems: achievement.rewardItems,
      });
    }
  }
  return unlocked;
}

export async function listAchievements(
  userId: string,
  category: string | undefined,
  executor: Executor = getDb(),
) {
  const conditions = [eq(achievementsConfig.enabled, true)];
  if (category) conditions.push(eq(achievementsConfig.category, category));

  return executor
    .select({
      key: achievementsConfig.key,
      name: achievementsConfig.name,
      description: achievementsConfig.description,
      category: achievementsConfig.category,
      icon: achievementsConfig.icon,
      tier: achievementsConfig.tier,
      conditionAmount: achievementsConfig.conditionAmount,
      rewardCoins: achievementsConfig.rewardCoins,
      rewardGems: achievementsConfig.rewardGems,
      rewardTitle: achievementsConfig.rewardTitle,
      hidden: achievementsConfig.hidden,
      progress: userAchievements.progress,
      unlocked: userAchievements.unlocked,
      unlockedAt: userAchievements.unlockedAt,
      claimed: userAchievements.claimed,
    })
    .from(achievementsConfig)
    .leftJoin(
      userAchievements,
      and(
        eq(userAchievements.achievementKey, achievementsConfig.key),
        eq(userAchievements.userId, userId),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(achievementsConfig.sortOrder));
}

export async function claimAchievement(
  userId: string,
  achievementKey: string,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(userAchievements)
    .set({ claimed: true, claimedAt: new Date() })
    .where(
      and(
        eq(userAchievements.userId, userId),
        eq(userAchievements.achievementKey, achievementKey),
        eq(userAchievements.unlocked, true),
        eq(userAchievements.claimed, false),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Passe saisonnier
// ---------------------------------------------------------------------------

export async function getUserPass(
  userId: string,
  seasonPassId: string,
  executor: Executor = getDb(),
) {
  const [row] = await executor
    .select()
    .from(userSeasonPass)
    .where(and(eq(userSeasonPass.userId, userId), eq(userSeasonPass.seasonPassId, seasonPassId)))
    .limit(1);
  return row;
}

export async function addPassXp(
  userId: string,
  seasonPassId: string,
  amount: number,
  xpPerTier: number,
  maxTier: number,
  executor: Executor = getDb(),
): Promise<{ passXp: number; tier: number } | undefined> {
  if (amount <= 0) return undefined;
  const [row] = await executor
    .insert(userSeasonPass)
    .values({
      id: uuidv7(),
      userId,
      seasonPassId,
      passXp: amount,
      tier: Math.min(maxTier, Math.floor(amount / xpPerTier)),
    })
    .onConflictDoUpdate({
      target: [userSeasonPass.userId, userSeasonPass.seasonPassId],
      set: {
        passXp: sql`${userSeasonPass.passXp} + ${amount}`,
        tier: sql`LEAST(${maxTier}, (${userSeasonPass.passXp} + ${amount}) / ${xpPerTier})`,
        updatedAt: new Date(),
      },
    })
    .returning({ passXp: userSeasonPass.passXp, tier: userSeasonPass.tier });
  return row;
}

export async function claimPassTier(
  userId: string,
  seasonPassId: string,
  tier: number,
  premium: boolean,
  executor: Executor,
): Promise<boolean> {
  const column = premium ? userSeasonPass.claimedPremiumTiers : userSeasonPass.claimedTiers;
  const result = await executor
    .update(userSeasonPass)
    .set({
      ...(premium
        ? { claimedPremiumTiers: sql`array_append(${column}, ${tier})` }
        : { claimedTiers: sql`array_append(${column}, ${tier})` }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userSeasonPass.userId, userId),
        eq(userSeasonPass.seasonPassId, seasonPassId),
        sql`${userSeasonPass.tier} >= ${tier}`,
        sql`NOT (${tier} = ANY(${column}))`,
        premium ? eq(userSeasonPass.premium, true) : sql`true`,
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Débloque la voie premium du passe. Upsert et non simple `UPDATE` : un joueur
 * qui vote avant d'avoir gagné la moindre XP de passe n'a pas encore de ligne,
 * et l'ancienne écriture ne touchait alors rien du tout — ce qui, combiné à
 * l'absence d'appelant, rendait toute la voie premium inatteignable.
 */
export async function grantPassPremium(
  userId: string,
  seasonPassId: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .insert(userSeasonPass)
    .values({
      id: uuidv7(),
      userId,
      seasonPassId,
      premium: true,
      premiumGrantedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userSeasonPass.userId, userSeasonPass.seasonPassId],
      set: { premium: true, premiumGrantedAt: new Date(), updatedAt: new Date() },
    });
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------

/**
 * Occurrence d'un événement récurrent, rangée dans `progress.occurrence`.
 * `user_events` n'a qu'une ligne par (joueur, événement) : sans cette marque,
 * les points de la Moisson 2026 s'ajoutaient à ceux de 2027 et les paliers
 * réclamés une année restaient bloqués pour toujours.
 */
export interface UserEventProgress {
  occurrence?: string;
  /** Achats de la boutique d'événement pour cette occurrence, par objet. */
  purchases?: Record<string, number>;
}

export type UserEventRow = typeof userEvents.$inferSelect;

export async function addEventPoints(
  userId: string,
  eventKey: string,
  points: number,
  executor: Executor = getDb(),
  occurrence?: string,
): Promise<{ points: number } | undefined> {
  if (points <= 0) return undefined;
  if (occurrence === undefined) {
    const [row] = await executor
      .insert(userEvents)
      .values({ id: uuidv7(), userId, eventKey, points })
      .onConflictDoUpdate({
        target: [userEvents.userId, userEvents.eventKey],
        set: { points: sql`${userEvents.points} + ${points}`, updatedAt: new Date() },
      })
      .returning({ points: userEvents.points });
    return row;
  }

  // Nouvelle occurrence : la ligne repart de zéro (points, paliers, achats).
  // Toutes les expressions du SET lisent l'ANCIENNE ligne, d'où la même
  // condition répétée.
  const stale = sql`(${userEvents.progress}->>'occurrence') IS DISTINCT FROM ${occurrence}`;
  const [row] = await executor
    .insert(userEvents)
    .values({ id: uuidv7(), userId, eventKey, points, progress: { occurrence } })
    .onConflictDoUpdate({
      target: [userEvents.userId, userEvents.eventKey],
      set: {
        points: sql`CASE WHEN ${stale} THEN ${points} ELSE ${userEvents.points} + ${points} END`,
        claimedTiers: sql`CASE WHEN ${stale} THEN ARRAY[]::integer[] ELSE ${userEvents.claimedTiers} END`,
        progress: sql`CASE WHEN ${stale} THEN jsonb_build_object('occurrence', ${occurrence}::text) ELSE ${userEvents.progress} END`,
        updatedAt: new Date(),
      },
    })
    .returning({ points: userEvents.points });
  return row;
}

export async function getUserEvent(
  userId: string,
  eventKey: string,
  executor: Executor = getDb(),
) {
  const [row] = await executor
    .select()
    .from(userEvents)
    .where(and(eq(userEvents.userId, userId), eq(userEvents.eventKey, eventKey)))
    .limit(1);
  return row;
}

/**
 * Crée si besoin puis VERROUILLE la ligne d'événement du joueur, remise à zéro
 * si elle date d'une occurrence précédente. Point d'entrée des réclamations et
 * des achats : tout ce qui suit dans la transaction lit une ligne à jour.
 */
export async function lockUserEventOccurrence(
  tx: Executor,
  userId: string,
  eventKey: string,
  occurrence: string,
): Promise<UserEventRow> {
  await tx
    .insert(userEvents)
    .values({ id: uuidv7(), userId, eventKey, points: 0, progress: { occurrence } })
    .onConflictDoNothing({ target: [userEvents.userId, userEvents.eventKey] });
  const [row] = await tx
    .select()
    .from(userEvents)
    .where(and(eq(userEvents.userId, userId), eq(userEvents.eventKey, eventKey)))
    .limit(1)
    .for('update');
  if (!row) throw new Error(`user_events introuvable après insertion (${eventKey})`);
  if ((row.progress as UserEventProgress | null)?.occurrence === occurrence) return row;

  const [reset] = await tx
    .update(userEvents)
    .set({ points: 0, tier: 0, claimedTiers: [], progress: { occurrence }, updatedAt: new Date() })
    .where(eq(userEvents.id, row.id))
    .returning();
  return reset ?? row;
}

/**
 * Marque un palier (identifié par son seuil de points) comme réclamé.
 * Idempotent et sûr en concurrence : la clause exige que le palier soit
 * atteint et pas encore réclamé, une seconde réclamation ne touche aucune ligne.
 */
export async function claimEventTier(
  userId: string,
  eventKey: string,
  tier: number,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(userEvents)
    .set({ claimedTiers: sql`array_append(${userEvents.claimedTiers}, ${tier})`, updatedAt: new Date() })
    .where(
      and(
        eq(userEvents.userId, userId),
        eq(userEvents.eventKey, eventKey),
        sql`${userEvents.points} >= ${tier}`,
        sql`NOT (${tier} = ANY(${userEvents.claimedTiers}))`,
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

/** Enregistre un achat en boutique d'événement (ligne déjà verrouillée). */
export async function recordEventPurchase(
  tx: Executor,
  rowId: string,
  itemKey: string,
  quantity: number,
): Promise<void> {
  await tx
    .update(userEvents)
    .set({
      progress: sql`jsonb_set(
        jsonb_set(${userEvents.progress}, '{purchases}', COALESCE(${userEvents.progress}->'purchases', '{}'::jsonb)),
        ARRAY['purchases', ${itemKey}::text],
        to_jsonb(COALESCE((${userEvents.progress}->'purchases'->>${itemKey}::text)::int, 0) + ${quantity}::int)
      )`,
      updatedAt: new Date(),
    })
    .where(eq(userEvents.id, rowId));
}

/** Titre de profil accordé par une récompense d'événement. */
export async function setUserTitle(tx: Executor, userId: string, title: string): Promise<void> {
  await tx.update(users).set({ title }).where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Série quotidienne
// ---------------------------------------------------------------------------

export async function lockStreak(tx: Executor, userId: string) {
  const [row] = await tx
    .select()
    .from(dailyStreaks)
    .where(eq(dailyStreaks.userId, userId))
    .limit(1)
    .for('update');
  return row;
}

export async function updateStreak(
  userId: string,
  data: { currentStreak: number; lastClaimDate: string; freezeTokens?: number },
  executor: Executor,
): Promise<void> {
  await executor
    .update(dailyStreaks)
    .set({
      currentStreak: data.currentStreak,
      longestStreak: sql`GREATEST(${dailyStreaks.longestStreak}, ${data.currentStreak})`,
      lastClaimDate: data.lastClaimDate,
      totalClaims: sql`${dailyStreaks.totalClaims} + 1`,
      ...(data.freezeTokens !== undefined ? { freezeTokens: data.freezeTokens } : {}),
      updatedAt: new Date(),
    })
    .where(eq(dailyStreaks.userId, userId));
}
