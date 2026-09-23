import { and, asc, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import { inventory, itemsConfig } from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/**
 * Inventaire du joueur.
 *
 * Deux invariants sont garantis ICI et nulle part ailleurs :
 *  1. on ne retire jamais plus que ce qui existe — le `WHERE quantity >= n`
 *     rend l'opération atomique côté PostgreSQL, donc deux retraits simultanés
 *     ne peuvent pas passer tous les deux ;
 *  2. la quantité ne peut pas devenir négative — la contrainte CHECK de la table
 *     est le dernier rempart si jamais une requête oubliait la clause.
 */

export type Quality = 'normal' | 'silver' | 'gold' | 'iridium';
export type Mutation = 'none' | 'giant' | 'rainbow' | 'ancient';

export interface StackKey {
  itemKey: string;
  quality?: Quality;
  mutation?: Mutation;
}

export type InventoryRow = typeof inventory.$inferSelect;

export interface InventoryEntry {
  itemKey: string;
  quality: Quality;
  mutation: Mutation;
  quantity: number;
  locked: boolean;
  name: string;
  emoji: string;
  category: string;
  rarity: string;
  sellPrice: number;
  sellable: boolean;
  tradable: boolean;
}

/** Total d'unités détenues (pour la capacité d'entrepôt). */
export async function totalQuantity(
  userId: string,
  executor: Executor = getDb(),
  options: { excludeItemKeys?: readonly string[] } = {},
): Promise<number> {
  const excluded = options.excludeItemKeys ?? [];
  const [row] = await executor
    .select({ total: sql<number>`COALESCE(SUM(${inventory.quantity}), 0)::int` })
    .from(inventory)
    .where(
      excluded.length > 0
        ? and(eq(inventory.userId, userId), notInArray(inventory.itemKey, [...excluded]))
        : eq(inventory.userId, userId),
    );
  return row?.total ?? 0;
}

export async function getStack(
  userId: string,
  key: StackKey,
  executor: Executor = getDb(),
): Promise<InventoryRow | undefined> {
  const [row] = await executor
    .select()
    .from(inventory)
    .where(
      and(
        eq(inventory.userId, userId),
        eq(inventory.itemKey, key.itemKey),
        eq(inventory.quality, key.quality ?? 'normal'),
        eq(inventory.mutation, key.mutation ?? 'none'),
      ),
    )
    .limit(1);
  return row;
}

export async function countItem(
  userId: string,
  itemKey: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<number>`COALESCE(SUM(${inventory.quantity}), 0)::int` })
    .from(inventory)
    .where(and(eq(inventory.userId, userId), eq(inventory.itemKey, itemKey)));
  return row?.total ?? 0;
}

/**
 * Ajoute des unités, en créant la pile si nécessaire.
 * `ON CONFLICT ... DO UPDATE` : une seule requête, atomique, pas de « lire puis
 * écrire » sujet aux courses.
 */
export async function addItem(
  userId: string,
  key: StackKey,
  quantity: number,
  executor: Executor = getDb(),
): Promise<void> {
  if (quantity <= 0) return;
  await executor
    .insert(inventory)
    .values({
      id: uuidv7(),
      userId,
      itemKey: key.itemKey,
      quality: key.quality ?? 'normal',
      mutation: key.mutation ?? 'none',
      quantity,
    })
    .onConflictDoUpdate({
      target: [inventory.userId, inventory.itemKey, inventory.quality, inventory.mutation],
      set: {
        quantity: sql`${inventory.quantity} + ${quantity}`,
        updatedAt: new Date(),
      },
    });
}

export async function addItems(
  userId: string,
  entries: Array<{ key: StackKey; quantity: number }>,
  executor: Executor = getDb(),
): Promise<void> {
  for (const entry of entries) {
    await addItem(userId, entry.key, entry.quantity, executor);
  }
}

/**
 * Retire des unités. Renvoie `false` si le stock était insuffisant : AUCUNE
 * ligne n'est alors modifiée, l'appelant peut annuler sa transaction proprement.
 */
export async function removeItem(
  userId: string,
  key: StackKey,
  quantity: number,
  executor: Executor = getDb(),
): Promise<boolean> {
  if (quantity <= 0) return true;
  const result = await executor
    .update(inventory)
    .set({ quantity: sql`${inventory.quantity} - ${quantity}`, updatedAt: new Date() })
    .where(
      and(
        eq(inventory.userId, userId),
        eq(inventory.itemKey, key.itemKey),
        eq(inventory.quality, key.quality ?? 'normal'),
        eq(inventory.mutation, key.mutation ?? 'none'),
        sql`${inventory.quantity} >= ${quantity}`,
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Retire des unités toutes qualités confondues, en commençant par la qualité la
 * plus basse. Utilisé par les recettes et les contrats : on ne consomme pas la
 * récolte iridium du joueur pour faire de la farine s'il a du blé normal.
 */
export async function removeItemAnyQuality(
  userId: string,
  itemKey: string,
  quantity: number,
  executor: Executor = getDb(),
): Promise<{ removed: boolean; consumed: Array<{ quality: Quality; mutation: Mutation; quantity: number }> }> {
  const order = sql`CASE ${inventory.quality}
    WHEN 'normal' THEN 0 WHEN 'silver' THEN 1 WHEN 'gold' THEN 2 ELSE 3 END`;

  const stacks = await executor
    .select()
    .from(inventory)
    .where(
      and(
        eq(inventory.userId, userId),
        eq(inventory.itemKey, itemKey),
        eq(inventory.locked, false),
        gt(inventory.quantity, 0),
      ),
    )
    .orderBy(order)
    .for('update');

  const available = stacks.reduce((sum, stack) => sum + stack.quantity, 0);
  if (available < quantity) return { removed: false, consumed: [] };

  let remaining = quantity;
  const consumed: Array<{ quality: Quality; mutation: Mutation; quantity: number }> = [];

  for (const stack of stacks) {
    if (remaining <= 0) break;
    const take = Math.min(stack.quantity, remaining);
    await executor
      .update(inventory)
      .set({ quantity: sql`${inventory.quantity} - ${take}`, updatedAt: new Date() })
      .where(eq(inventory.id, stack.id));
    consumed.push({
      quality: stack.quality,
      mutation: stack.mutation,
      quantity: take,
    });
    remaining -= take;
  }

  return { removed: true, consumed };
}

/** Inventaire enrichi des métadonnées d'objet, filtrable par catégorie. */
export async function listInventory(
  userId: string,
  options: { category?: string; onlySellable?: boolean } = {},
  executor: Executor = getDb(),
): Promise<InventoryEntry[]> {
  const conditions = [eq(inventory.userId, userId), gt(inventory.quantity, 0)];
  if (options.category) {
    conditions.push(eq(itemsConfig.category, options.category as never));
  }
  if (options.onlySellable) {
    conditions.push(eq(itemsConfig.sellable, true));
  }

  const rows = await executor
    .select({
      itemKey: inventory.itemKey,
      quality: inventory.quality,
      mutation: inventory.mutation,
      quantity: inventory.quantity,
      locked: inventory.locked,
      name: itemsConfig.name,
      emoji: itemsConfig.emoji,
      category: itemsConfig.category,
      rarity: itemsConfig.rarity,
      sellPrice: itemsConfig.sellPrice,
      sellable: itemsConfig.sellable,
      tradable: itemsConfig.tradable,
    })
    .from(inventory)
    .innerJoin(itemsConfig, eq(itemsConfig.key, inventory.itemKey))
    .where(and(...conditions))
    .orderBy(asc(itemsConfig.sortOrder), desc(inventory.quantity));

  return rows.map((row) => ({
    ...row,
    quality: row.quality,
    mutation: row.mutation,
  }));
}

/** Graines détenues, pour l'autocomplétion de `/plant`. */
export async function listSeeds(
  userId: string,
  executor: Executor = getDb(),
): Promise<Array<{ itemKey: string; name: string; emoji: string; quantity: number }>> {
  return executor
    .select({
      itemKey: inventory.itemKey,
      name: itemsConfig.name,
      emoji: itemsConfig.emoji,
      quantity: inventory.quantity,
    })
    .from(inventory)
    .innerJoin(itemsConfig, eq(itemsConfig.key, inventory.itemKey))
    .where(
      and(
        eq(inventory.userId, userId),
        eq(itemsConfig.category, 'seed'),
        gt(inventory.quantity, 0),
      ),
    )
    .orderBy(asc(itemsConfig.sortOrder));
}

export async function setLocked(
  userId: string,
  key: StackKey,
  locked: boolean,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(inventory)
    .set({ locked, updatedAt: new Date() })
    .where(
      and(
        eq(inventory.userId, userId),
        eq(inventory.itemKey, key.itemKey),
        eq(inventory.quality, key.quality ?? 'normal'),
        eq(inventory.mutation, key.mutation ?? 'none'),
      ),
    );
}

/** Supprime les piles vides (job de maintenance nocturne). */
export async function pruneEmptyStacks(executor: Executor = getDb()): Promise<number> {
  const result = await executor.delete(inventory).where(eq(inventory.quantity, 0));
  return result.rowCount ?? 0;
}

/** Remise à zéro partielle lors d'un prestige : garde certaines catégories. */
export async function wipeInventoryExcept(
  userId: string,
  keepCategories: string[],
  executor: Executor,
): Promise<number> {
  const keepKeys = await executor
    .select({ key: itemsConfig.key })
    .from(itemsConfig)
    .where(inArray(itemsConfig.category, keepCategories as never[]));

  const keys = keepKeys.map((row) => row.key);
  // `<> ALL(${keys})` liait le tableau JS comme un simple paramètre : PostgreSQL
  // le recevait en texte et refusait la requête (42809, « op ANY/ALL (array)
  // requires array on right side »). La transaction de prestige avortait donc
  // TOUJOURS, à la cinquième étape. `notInArray` produit un `NOT IN (…)` avec un
  // paramètre par clé, ce que le moteur accepte.
  const result =
    keys.length > 0
      ? await executor
          .delete(inventory)
          .where(and(eq(inventory.userId, userId), notInArray(inventory.itemKey, keys)))
      : await executor.delete(inventory).where(eq(inventory.userId, userId));

  return result.rowCount ?? 0;
}
