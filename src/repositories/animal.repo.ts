import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import { animalsConfig, buildingsConfig, craftingQueue, ownedAnimals, ownedBuildings } from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/**
 * Animaux, bâtiments possédés et file d'artisanat.
 * Ces trois entités partagent le même repository car elles sont interrogées
 * ensemble : la capacité d'un poulailler conditionne l'achat d'une poule, et les
 * emplacements d'un moulin conditionnent la file de production.
 */

export type OwnedAnimalRow = typeof ownedAnimals.$inferSelect;
export type OwnedBuildingRow = typeof ownedBuildings.$inferSelect;
export type CraftingQueueRow = typeof craftingQueue.$inferSelect;

export interface AnimalWithConfig {
  animal: OwnedAnimalRow;
  name: string;
  emoji: string;
  productItemKey: string;
  productionSeconds: number;
  feedItemKey: string;
  feedPerCycle: number;
  buildingKey: string;
  animalKey: string;
}

export async function listAnimals(
  farmId: string,
  options: { includeDead?: boolean } = {},
  executor: Executor = getDb(),
): Promise<AnimalWithConfig[]> {
  const conditions = [eq(ownedAnimals.farmId, farmId)];
  if (!options.includeDead) conditions.push(eq(ownedAnimals.isAlive, true));

  const rows = await executor
    .select({
      animal: ownedAnimals,
      name: animalsConfig.name,
      emoji: animalsConfig.emoji,
      productItemKey: animalsConfig.productItemKey,
      productionSeconds: animalsConfig.productionSeconds,
      feedItemKey: animalsConfig.feedItemKey,
      feedPerCycle: animalsConfig.feedPerCycle,
      buildingKey: animalsConfig.buildingKey,
    })
    .from(ownedAnimals)
    .innerJoin(animalsConfig, eq(animalsConfig.key, ownedAnimals.animalKey))
    .where(and(...conditions))
    .orderBy(asc(animalsConfig.sortOrder), asc(ownedAnimals.bornAt));

  return rows.map((row) => ({ ...row, animalKey: row.animal.animalKey }));
}

export async function getAnimalById(
  animalId: string,
  executor: Executor = getDb(),
): Promise<OwnedAnimalRow | undefined> {
  const [row] = await executor
    .select()
    .from(ownedAnimals)
    .where(eq(ownedAnimals.id, animalId))
    .limit(1);
  return row;
}

export async function lockAnimal(
  tx: Executor,
  animalId: string,
  userId: string,
): Promise<OwnedAnimalRow | undefined> {
  const [row] = await tx
    .select()
    .from(ownedAnimals)
    .where(and(eq(ownedAnimals.id, animalId), eq(ownedAnimals.userId, userId)))
    .limit(1)
    .for('update');
  return row;
}

export async function countAnimalsInBuilding(
  farmId: string,
  buildingKey: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(ownedAnimals)
    .innerJoin(animalsConfig, eq(animalsConfig.key, ownedAnimals.animalKey))
    .where(
      and(
        eq(ownedAnimals.farmId, farmId),
        eq(ownedAnimals.isAlive, true),
        eq(animalsConfig.buildingKey, buildingKey),
      ),
    );
  return row?.count ?? 0;
}

export async function insertAnimal(
  values: Omit<typeof ownedAnimals.$inferInsert, 'id'>,
  executor: Executor,
): Promise<OwnedAnimalRow> {
  const [row] = await executor
    .insert(ownedAnimals)
    .values({ id: uuidv7(), ...values })
    .returning();
  return row!;
}

export async function updateAnimal(
  animalId: string,
  patch: Partial<typeof ownedAnimals.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(ownedAnimals)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(ownedAnimals.id, animalId));
}

export async function updateAnimals(
  animalIds: string[],
  patch: Partial<typeof ownedAnimals.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  if (animalIds.length === 0) return;
  await executor
    .update(ownedAnimals)
    .set({ ...patch, updatedAt: new Date() })
    .where(inArray(ownedAnimals.id, animalIds));
}

export async function killAnimal(
  animalId: string,
  reason: string,
  now: Date,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(ownedAnimals)
    .set({ isAlive: false, diedAt: now, deathReason: reason, updatedAt: now })
    .where(eq(ownedAnimals.id, animalId));
}

/**
 * Écrit le résultat du job de décroissance SEULEMENT si l'animal n'a pas bougé
 * depuis la lecture : vivant, et `stats_updated_at` inchangé. Toute action du
 * joueur (nourrir, soigner, caresser, récolter) réécrit cet horodatage ; sans
 * ce garde-fou, un animal nourri entre-temps retrouvait sa faim d'avant, et un
 * animal tout juste soigné mourait quand même.
 *
 * La comparaison se fait à la milliseconde : PostgreSQL stocke la microseconde
 * alors qu'une `Date` JavaScript s'arrête à la milliseconde. Une égalité
 * stricte échouerait donc toujours sur une valeur posée par `now()` en SQL.
 */
export async function applyDecayIfUnchanged(
  animalId: string,
  seenStatsUpdatedAt: Date,
  patch: Partial<typeof ownedAnimals.$inferInsert>,
  executor: Executor = getDb(),
): Promise<boolean> {
  const result = await executor
    .update(ownedAnimals)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(ownedAnimals.id, animalId),
        eq(ownedAnimals.isAlive, true),
        sql`date_trunc('milliseconds', ${ownedAnimals.statsUpdatedAt}) = ${seenStatsUpdatedAt}`,
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteAnimal(animalId: string, executor: Executor): Promise<void> {
  await executor.delete(ownedAnimals).where(eq(ownedAnimals.id, animalId));
}

/** Animaux dont les jauges doivent être matérialisées (job de décroissance). */
export async function findAnimalsForDecay(
  before: Date,
  limit: number,
  executor: Executor = getDb(),
) {
  return executor
    .select({
      animal: ownedAnimals,
      hungerRate: animalsConfig.hungerRate,
      happinessRate: animalsConfig.happinessRate,
      lifespanDays: animalsConfig.lifespanDays,
      productionSeconds: animalsConfig.productionSeconds,
      name: animalsConfig.name,
      emoji: animalsConfig.emoji,
    })
    .from(ownedAnimals)
    .innerJoin(animalsConfig, eq(animalsConfig.key, ownedAnimals.animalKey))
    .where(and(eq(ownedAnimals.isAlive, true), lte(ownedAnimals.statsUpdatedAt, before)))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Bâtiments
// ---------------------------------------------------------------------------

export interface BuildingWithConfig {
  building: OwnedBuildingRow;
  name: string;
  emoji: string;
  category: string;
  maxTier: number;
  buildingKey: string;
}

export async function listBuildings(
  farmId: string,
  executor: Executor = getDb(),
): Promise<BuildingWithConfig[]> {
  const rows = await executor
    .select({
      building: ownedBuildings,
      name: buildingsConfig.name,
      emoji: buildingsConfig.emoji,
      category: buildingsConfig.category,
      maxTier: buildingsConfig.maxTier,
    })
    .from(ownedBuildings)
    .innerJoin(buildingsConfig, eq(buildingsConfig.key, ownedBuildings.buildingKey))
    .where(eq(ownedBuildings.farmId, farmId))
    .orderBy(asc(buildingsConfig.sortOrder));

  return rows.map((row) => ({ ...row, buildingKey: row.building.buildingKey }));
}

export async function getBuilding(
  farmId: string,
  buildingKey: string,
  executor: Executor = getDb(),
): Promise<OwnedBuildingRow | undefined> {
  const [row] = await executor
    .select()
    .from(ownedBuildings)
    .where(and(eq(ownedBuildings.farmId, farmId), eq(ownedBuildings.buildingKey, buildingKey)))
    .limit(1);
  return row;
}

export async function upsertBuilding(
  values: Omit<typeof ownedBuildings.$inferInsert, 'id'>,
  executor: Executor,
): Promise<OwnedBuildingRow> {
  const [row] = await executor
    .insert(ownedBuildings)
    .values({ id: uuidv7(), ...values })
    .onConflictDoUpdate({
      target: [ownedBuildings.farmId, ownedBuildings.buildingKey],
      set: {
        tier: values.tier,
        capacity: values.capacity,
        slots: values.slots,
        speedMultiplier: values.speedMultiplier,
        upgradedAt: new Date(),
        totalInvested: sql`${ownedBuildings.totalInvested} + ${values.totalInvested ?? 0}`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

/** Somme des emplacements d'artisanat de la ferme. */
export async function totalCraftingSlots(
  farmId: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<number>`COALESCE(SUM(${ownedBuildings.slots}), 0)::int` })
    .from(ownedBuildings)
    .where(eq(ownedBuildings.farmId, farmId));
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// File d'artisanat
// ---------------------------------------------------------------------------

export async function listCraftingQueue(
  userId: string,
  options: { includeCollected?: boolean } = {},
  executor: Executor = getDb(),
) {
  const conditions = [eq(craftingQueue.userId, userId)];
  if (!options.includeCollected) conditions.push(eq(craftingQueue.collected, false));

  return executor
    .select({
      job: craftingQueue,
      buildingKey: ownedBuildings.buildingKey,
      buildingName: buildingsConfig.name,
      buildingEmoji: buildingsConfig.emoji,
    })
    .from(craftingQueue)
    .innerJoin(ownedBuildings, eq(ownedBuildings.id, craftingQueue.buildingId))
    .innerJoin(buildingsConfig, eq(buildingsConfig.key, ownedBuildings.buildingKey))
    .where(and(...conditions))
    .orderBy(asc(craftingQueue.finishAt));
}

export async function countActiveJobs(
  buildingId: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(craftingQueue)
    .where(and(eq(craftingQueue.buildingId, buildingId), eq(craftingQueue.collected, false)));
  return row?.count ?? 0;
}

/** Premier index d'emplacement libre dans un bâtiment. */
export async function firstFreeSlot(
  buildingId: string,
  slots: number,
  executor: Executor = getDb(),
): Promise<number | undefined> {
  const used = await executor
    .select({ slotIndex: craftingQueue.slotIndex })
    .from(craftingQueue)
    .where(and(eq(craftingQueue.buildingId, buildingId), eq(craftingQueue.collected, false)));
  const taken = new Set(used.map((row) => row.slotIndex));
  for (let index = 0; index < slots; index += 1) {
    if (!taken.has(index)) return index;
  }
  return undefined;
}

export async function insertCraftJob(
  values: Omit<typeof craftingQueue.$inferInsert, 'id'>,
  executor: Executor,
): Promise<CraftingQueueRow> {
  const [row] = await executor
    .insert(craftingQueue)
    .values({ id: uuidv7(), ...values })
    .returning();
  return row!;
}

export async function lockCraftJob(
  tx: Executor,
  jobId: string,
  userId: string,
): Promise<CraftingQueueRow | undefined> {
  const [row] = await tx
    .select()
    .from(craftingQueue)
    .where(and(eq(craftingQueue.id, jobId), eq(craftingQueue.userId, userId)))
    .limit(1)
    .for('update');
  return row;
}

export async function markCraftCollected(
  jobId: string,
  now: Date,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(craftingQueue)
    .set({ collected: true, collectedAt: now, updatedAt: now })
    .where(and(eq(craftingQueue.id, jobId), eq(craftingQueue.collected, false)));
  return (result.rowCount ?? 0) > 0;
}

export async function deleteCraftJob(jobId: string, executor: Executor): Promise<void> {
  await executor.delete(craftingQueue).where(eq(craftingQueue.id, jobId));
}

/** Productions terminées non collectées, pour les notifications. */
export async function findFinishedJobs(
  now: Date,
  limit: number,
  executor: Executor = getDb(),
) {
  return executor
    .select({
      id: craftingQueue.id,
      userId: craftingQueue.userId,
      recipeKey: craftingQueue.recipeKey,
      finishAt: craftingQueue.finishAt,
    })
    .from(craftingQueue)
    .where(and(eq(craftingQueue.collected, false), lte(craftingQueue.finishAt, now)))
    .limit(limit);
}
