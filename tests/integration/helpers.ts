import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { balance } from '../../src/config';
import { getDb, withRawClient, withTransaction } from '../../src/db/client';
import { getRedis } from '../../src/db/redis';
import * as economyRepo from '../../src/repositories/economy.repo';
import * as economyService from '../../src/services/economy.service';
import { ensurePlayer } from '../../src/services/player.service';
import type { PlayerContext } from '../../src/types';
import { TEST_REDIS_PREFIX } from './env';

/**
 * Outils communs aux tests d'intégration.
 *
 * Principe : les fixtures passent par le VRAI code de création de compte et par
 * les vrais services d'économie. Fabriquer un joueur à coups d'`INSERT` donnerait
 * une base que le code de production n'aurait jamais pu produire — et un test
 * qui valide une situation impossible ne prouve rien.
 */

/**
 * Tables de RÉFÉRENCE, jamais vidées entre deux tests : elles sont peuplées une
 * fois par `global-setup` à partir de `src/config/gameplay/`, et le code de jeu
 * s'appuie dessus par clé étrangère (l'inventaire référence `items_config`).
 * Les vider reviendrait à rejouer le seed avant chaque test pour rien.
 */
const KEEP = new Set([
  'migrations',
  'season_pass',
  'market_prices',
  'seasons',
  'shop_stock',
]);

function isReferenceTable(name: string): boolean {
  return KEEP.has(name) || name.endsWith('_config');
}

/** Remet la base à zéro. TRUNCATE plutôt que DELETE : les séquences repartent à 1. */
export async function resetDatabase(): Promise<void> {
  await withRawClient(async (client) => {
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const targets = tables.rows
      .map((row) => row.tablename)
      .filter((name) => !isReferenceTable(name))
      .map((name) => `"${name}"`);
    if (targets.length === 0) return;
    await client.query(`TRUNCATE TABLE ${targets.join(', ')} RESTART IDENTITY CASCADE`);
  });
}

/**
 * Efface les clés Redis de la suite. On ne fait PAS `FLUSHALL` : le Redis de
 * développement est partagé avec le bot, seul le préfixe de test est effacé.
 */
export async function resetRedis(): Promise<void> {
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${TEST_REDIS_PREFIX}:*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

let sequence = 0;

/** Crée un joueur complet par le chemin de production (`/start`). */
export async function createTestPlayer(username = 'joueur'): Promise<PlayerContext> {
  sequence += 1;
  // Un identifiant Discord plausible : 18 chiffres, unique par appel.
  const discordId = String(100_000_000_000_000_000n + BigInt(sequence));
  const result = await ensurePlayer({
    discordId,
    username: `${username}${sequence}`,
    createIfMissing: true,
  });
  if (!result) throw new Error('création du joueur de test impossible');
  return result.player;
}

/**
 * Joueur au niveau `trade.minLevel` : l'HDV (achat, enchère, ordre permanent)
 * l'exige côté acheteur depuis 66a7dfa. Le contexte est RECHARGÉ, c'est lui
 * que les services lisent.
 */
export async function createTrader(username = 'joueur'): Promise<PlayerContext> {
  const created = await createTestPlayer(username);
  await setLevel(created.id, balance().trade.minLevel);
  return reloadPlayer(created.discordId);
}

/** Crédite un joueur PAR LE JOURNAL, pour que l'invariant reste vrai au départ. */
export async function grantCoins(userId: string, amount: number): Promise<void> {
  await withTransaction(async (tx) => {
    await economyService.pay({ userId, amount, type: 'admin_grant' }, tx);
  });
}

export async function coinsOf(userId: string): Promise<number> {
  const rows = await getDb().execute<{ coins: string }>(
    sql`SELECT coins::text AS coins FROM users WHERE id = ${userId}`,
  );
  return Number(rows.rows[0]?.coins ?? 0);
}

export async function ledgerOf(userId: string): Promise<number> {
  const rows = await getDb().execute<{ total: string }>(
    sql`SELECT COALESCE(SUM(amount), 0)::text AS total
          FROM transactions
         WHERE user_id = ${userId} AND currency = 'coins'`,
  );
  return Number(rows.rows[0]?.total ?? 0);
}

/** Force le niveau d'un joueur : il ne participe à aucun invariant monétaire. */
export async function setLevel(userId: string, level: number, xp = 0): Promise<void> {
  await getDb().execute(
    sql`UPDATE users SET level = ${level}, xp = ${xp} WHERE id = ${userId}`,
  );
}

/**
 * L'invariant central du projet : `SUM(transactions.amount) = users.coins`.
 * C'est ce que le job `economy:snapshot` audite toutes les heures en production ;
 * le vérifier ici fait échouer le test au moment exact où la monnaie se crée.
 */
export async function expectLedgerBalanced(): Promise<void> {
  const mismatches = await economyRepo.findLedgerMismatches(50, new Date(0));
  expect(mismatches).toEqual([]);
}

/** Relit un joueur depuis la base : le contexte est un instantané, pas un lien. */
export async function reloadPlayer(discordId: string): Promise<PlayerContext> {
  const result = await ensurePlayer({ discordId, username: 'rechargé' });
  if (!result) throw new Error('joueur introuvable');
  return result.player;
}
