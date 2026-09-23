import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import { plantedCrops, plots } from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/**
 * Parcelles et cultures en terre.
 *
 * Toutes les lectures de parcelles remontent la culture éventuelle en un seul
 * LEFT JOIN : une vue de ferme à 64 parcelles coûte UNE requête, pas 64.
 */

export type PlotRow = typeof plots.$inferSelect;
export type PlantedCropRow = typeof plantedCrops.$inferSelect;

export interface PlotWithCrop {
  plot: PlotRow;
  crop: PlantedCropRow | null;
}

export async function listPlots(
  farmId: string,
  executor: Executor = getDb(),
): Promise<PlotWithCrop[]> {
  const rows = await executor
    .select({ plot: plots, crop: plantedCrops })
    .from(plots)
    .leftJoin(plantedCrops, eq(plantedCrops.plotId, plots.id))
    .where(eq(plots.farmId, farmId))
    .orderBy(asc(plots.slot));
  return rows.map((row) => ({ plot: row.plot, crop: row.crop }));
}

export async function getPlotBySlot(
  farmId: string,
  slot: number,
  executor: Executor = getDb(),
): Promise<PlotWithCrop | undefined> {
  const [row] = await executor
    .select({ plot: plots, crop: plantedCrops })
    .from(plots)
    .leftJoin(plantedCrops, eq(plantedCrops.plotId, plots.id))
    .where(and(eq(plots.farmId, farmId), eq(plots.slot, slot)))
    .limit(1);
  return row ? { plot: row.plot, crop: row.crop } : undefined;
}

/**
 * Verrouille une parcelle pour la durée de la transaction.
 * Indispensable pour planter/récolter : sans `FOR UPDATE`, deux clics simultanés
 * sur « Récolter » pourraient tous deux lire une parcelle prête et créditer deux
 * fois la récolte.
 */
export async function lockPlot(
  tx: Executor,
  farmId: string,
  slot: number,
): Promise<PlotRow | undefined> {
  const [row] = await tx
    .select()
    .from(plots)
    .where(and(eq(plots.farmId, farmId), eq(plots.slot, slot)))
    .limit(1)
    .for('update');
  return row;
}

export async function lockPlotsBySlots(
  tx: Executor,
  farmId: string,
  slots: number[],
): Promise<PlotRow[]> {
  if (slots.length === 0) return [];
  return tx
    .select()
    .from(plots)
    .where(and(eq(plots.farmId, farmId), inArray(plots.slot, slots)))
    .orderBy(asc(plots.slot))
    .for('update');
}

export async function updatePlot(
  plotId: string,
  patch: Partial<typeof plots.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(plots)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(plots.id, plotId));
}

export async function updatePlots(
  plotIds: string[],
  patch: Partial<typeof plots.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  if (plotIds.length === 0) return;
  await executor
    .update(plots)
    .set({ ...patch, updatedAt: new Date() })
    .where(inArray(plots.id, plotIds));
}

/** Débloque la prochaine parcelle verrouillée (achat de parcelle). */
export async function unlockPlot(
  tx: Executor,
  farmId: string,
  slot: number,
): Promise<PlotRow | undefined> {
  const [row] = await tx
    .update(plots)
    .set({ state: 'empty', unlockedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(plots.farmId, farmId), eq(plots.slot, slot), eq(plots.state, 'locked')))
    .returning();
  return row;
}

export async function countUnlockedPlots(
  farmId: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(plots)
    .where(and(eq(plots.farmId, farmId), sql`${plots.state} <> 'locked'`));
  return row?.count ?? 0;
}

export interface PlantCropInput {
  plotId: string;
  userId: string;
  cropKey: string;
  plantedAt: Date;
  readyAt: Date;
  growthSeconds: number;
  withersAt: Date;
  waterNeeded: number;
  nextWaterAt: Date | null;
  seasonPlanted: 'spring' | 'summer' | 'autumn' | 'winter';
  weatherPlanted:
    | 'sunny'
    | 'cloudy'
    | 'rainy'
    | 'storm'
    | 'heatwave'
    | 'frost'
    | 'snow'
    | null;
  mutation: 'none' | 'giant' | 'rainbow' | 'ancient';
  regrowRemaining: number;
  fertilizerKey?: string | null;
  fertilizerBoost?: number;
  qualityBoost?: number;
}

export async function insertPlantedCrop(
  input: PlantCropInput,
  executor: Executor,
): Promise<PlantedCropRow> {
  const [row] = await executor
    .insert(plantedCrops)
    .values({
      id: uuidv7(),
      plotId: input.plotId,
      userId: input.userId,
      cropKey: input.cropKey,
      plantedAt: input.plantedAt,
      readyAt: input.readyAt,
      growthSeconds: input.growthSeconds,
      withersAt: input.withersAt,
      waterNeeded: input.waterNeeded,
      nextWaterAt: input.nextWaterAt,
      seasonPlanted: input.seasonPlanted,
      weatherPlanted: input.weatherPlanted,
      mutation: input.mutation,
      regrowRemaining: input.regrowRemaining,
      fertilizerKey: input.fertilizerKey ?? null,
      fertilizerBoost: (input.fertilizerBoost ?? 0).toFixed(3),
      qualityBoost: (input.qualityBoost ?? 0).toFixed(3),
    })
    .returning();
  return row!;
}

export async function updatePlantedCrop(
  cropId: string,
  patch: Partial<typeof plantedCrops.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(plantedCrops)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(plantedCrops.id, cropId));
}

export async function deletePlantedCrop(cropId: string, executor: Executor = getDb()): Promise<void> {
  await executor.delete(plantedCrops).where(eq(plantedCrops.id, cropId));
}

/** Enregistre un arrosage sur plusieurs cultures d'un coup. */
export async function waterCrops(
  cropIds: string[],
  now: Date,
  executor: Executor = getDb(),
): Promise<number> {
  if (cropIds.length === 0) return 0;
  const result = await executor
    .update(plantedCrops)
    .set({
      waterGiven: sql`LEAST(${plantedCrops.waterGiven} + 1, ${plantedCrops.waterNeeded} + 8)`,
      lastWateredAt: now,
      updatedAt: now,
    })
    .where(inArray(plantedCrops.id, cropIds));
  return result.rowCount ?? 0;
}

/** Ajoute un aidant à une culture (`/assist`), sans doublon. */
export async function addHelper(
  cropId: string,
  helperId: string,
  executor: Executor = getDb(),
): Promise<void> {
  // `helperId` est passé en PARAMÈTRE lié (jamais concaténé) : aucune injection
  // possible même si la valeur venait d'une entrée utilisateur.
  await executor
    .update(plantedCrops)
    .set({
      helpedBy: sql`(
        SELECT ARRAY_AGG(DISTINCT helper)
        FROM unnest(array_append(${plantedCrops.helpedBy}, ${helperId}::uuid)) AS helper
      )`,
      updatedAt: new Date(),
    })
    .where(eq(plantedCrops.id, cropId));
}

/** Cultures arrivées à maturité dont le joueur n'a pas encore été notifié. */
export async function findCropsReadyForNotification(
  limit: number,
  executor: Executor = getDb(),
): Promise<Array<{ userId: string; plotSlot: number; cropKey: string; readyAt: Date }>> {
  const rows = await executor
    .select({
      userId: plantedCrops.userId,
      plotSlot: plots.slot,
      cropKey: plantedCrops.cropKey,
      readyAt: plantedCrops.readyAt,
    })
    .from(plantedCrops)
    .innerJoin(plots, eq(plots.id, plantedCrops.plotId))
    .where(
      and(
        lte(plantedCrops.readyAt, new Date()),
        eq(plantedCrops.withered, false),
        isNotNull(plantedCrops.readyAt),
      ),
    )
    .limit(limit);
  return rows;
}

/**
 * Cultures dépassées qui doivent faner (job de maintenance).
 *
 * UNE seule requête, qui verrouille d'abord la PARCELLE (même ordre que
 * planter et récolter : parcelle puis culture) et saute celles qu'une action
 * du joueur tient déjà. L'ancienne version lisait les cultures puis écrivait
 * par identifiant sans condition : une récolte glissée entre les deux laissait
 * une parcelle vide marquée `withered`, sans culture, que `plant()` refusait
 * ensuite pour toujours. Ici, une culture supprimée ou replantée entre-temps
 * n'est plus modifiée, et la parcelle ne change d'état que si SA culture a
 * effectivement fané.
 */
export async function witherOverdueCrops(
  now: Date,
  limit: number,
  executor: Executor = getDb(),
): Promise<number> {
  const result = await executor.execute(sql`
    WITH picked AS (
      SELECT p.id AS plot_id, pc.id AS crop_id
        FROM plots AS p
        JOIN planted_crops AS pc ON pc.plot_id = p.id
       WHERE pc.withered = false
         AND pc.withers_at IS NOT NULL
         AND pc.withers_at <= ${now}
       LIMIT ${limit}
         FOR UPDATE OF p SKIP LOCKED
    ),
    faded AS (
      UPDATE planted_crops AS pc
         SET withered = true, updated_at = ${now}
        FROM picked
       WHERE pc.id = picked.crop_id
         AND pc.plot_id = picked.plot_id
         AND pc.withered = false
         AND pc.withers_at <= ${now}
   RETURNING pc.plot_id
    )
    UPDATE plots AS p
       SET state = 'withered', updated_at = ${now}
      FROM faded
     WHERE p.id = faded.plot_id
 RETURNING p.id
  `);
  return result.rows.length;
}

/**
 * Remet à « vide » les parcelles `withered` restées SANS culture.
 *
 * Séquelle de l'ancienne course entre le job de flétrissement et la récolte
 * (voir `witherOverdueCrops`) : ces parcelles étaient comptées libres à
 * l'affichage mais refusées par `plant()`. `plant()` les accepte désormais ;
 * ce nettoyage rend en plus l'affichage cohérent. Une plantation concurrente
 * tient le verrou de la parcelle et la fait passer à `planted` : la condition
 * est réévaluée après son COMMIT et la ligne est alors laissée telle quelle.
 */
export async function repairOrphanWitheredPlots(
  now: Date,
  executor: Executor = getDb(),
): Promise<number> {
  const result = await executor
    .update(plots)
    .set({ state: 'empty', pestType: null, pestAppearedAt: null, pestDeadlineAt: null, updatedAt: now })
    .where(
      and(
        eq(plots.state, 'withered'),
        sql`NOT EXISTS (SELECT 1 FROM ${plantedCrops} WHERE ${plantedCrops.plotId} = ${plots.id})`,
      ),
    );
  return result.rowCount ?? 0;
}

/** Verrouille une parcelle par identifiant (jobs de maintenance). */
export async function lockPlotById(tx: Executor, plotId: string): Promise<PlotRow | undefined> {
  const [row] = await tx.select().from(plots).where(eq(plots.id, plotId)).limit(1).for('update');
  return row;
}

export async function getCropByPlotId(
  plotId: string,
  executor: Executor = getDb(),
): Promise<PlantedCropRow | undefined> {
  const [row] = await executor
    .select()
    .from(plantedCrops)
    .where(eq(plantedCrops.plotId, plotId))
    .limit(1);
  return row;
}

/** Parcelles, parmi celles données, qui portent une culture (fanée ou non). */
export async function plotIdsWithCrop(
  plotIds: string[],
  executor: Executor = getDb(),
): Promise<Set<string>> {
  if (plotIds.length === 0) return new Set();
  const rows = await executor
    .select({ plotId: plantedCrops.plotId })
    .from(plantedCrops)
    .where(inArray(plantedCrops.plotId, plotIds));
  return new Set(rows.map((row) => row.plotId));
}

/**
 * Pose un nuisible, seulement si la parcelle porte TOUJOURS une culture vivante
 * et n'a pas déjà de nuisible. Sans ces conditions, une récolte faite entre la
 * sélection du job et l'écriture recevait un nuisible sur une parcelle vide.
 */
export async function spawnPestIfStillPlanted(
  plotId: string,
  pest: { pestType: NonNullable<PlotRow['pestType']>; pestAppearedAt: Date; pestDeadlineAt: Date },
  executor: Executor = getDb(),
): Promise<boolean> {
  const result = await executor
    .update(plots)
    .set({ ...pest, updatedAt: new Date() })
    .where(
      and(
        eq(plots.id, plotId),
        eq(plots.state, 'planted'),
        isNull(plots.pestType),
        sql`EXISTS (SELECT 1 FROM ${plantedCrops} WHERE ${plantedCrops.plotId} = ${plots.id} AND ${plantedCrops.withered} = false)`,
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Ajoute des dégâts à une culture encore vivante, en SQL : lire la pénalité
 * puis écrire une valeur absolue écrasait les dégâts posés entre-temps.
 */
export async function addCropDamage(
  cropId: string,
  damage: number,
  options: { wither?: boolean } = {},
  executor: Executor = getDb(),
): Promise<boolean> {
  const result = await executor
    .update(plantedCrops)
    .set({
      damagePenalty: sql`LEAST(1, ${plantedCrops.damagePenalty} + ${damage.toFixed(3)}::numeric)`,
      ...(options.wither ? { withered: true } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(plantedCrops.id, cropId), eq(plantedCrops.withered, false)));
  return (result.rowCount ?? 0) > 0;
}

/** Parcelles plantées éligibles à l'apparition d'un nuisible. */
export async function findPlotsForPestRoll(
  limit: number,
  executor: Executor = getDb(),
): Promise<Array<{ plotId: string; farmId: string; userId: string; weedLevel: number; slot: number }>> {
  return executor
    .select({
      plotId: plots.id,
      farmId: plots.farmId,
      userId: plantedCrops.userId,
      weedLevel: plots.weedLevel,
      slot: plots.slot,
    })
    .from(plots)
    .innerJoin(plantedCrops, eq(plantedCrops.plotId, plots.id))
    .where(
      and(
        eq(plots.state, 'planted'),
        sql`${plots.pestType} IS NULL`,
        eq(plantedCrops.withered, false),
      ),
    )
    .limit(limit);
}
