import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { env, isProduction } from '../config/env';
import { moduleLogger } from '../utils/logger';
import * as schema from './schema';

const log = moduleLogger('db');

export type Database = NodePgDatabase<typeof schema>;
/** Type d'une transaction Drizzle : même API que `Database`, dans un `BEGIN`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Accepte indifféremment le pool ou une transaction en cours. */
export type Executor = Database | Transaction;

let pool: Pool | undefined;
let db: Database | undefined;

/**
 * Options TLS de la connexion PostgreSQL.
 *
 * On VÉRIFIE le certificat par défaut. `rejectUnauthorized: false` inconditionnel
 * — l'ancien comportement — chiffre sans authentifier : cela protège de l'écoute
 * passive, mais un intercepteur actif lit alors les identifiants et l'intégralité
 * du trafic de jeu. Un PaaS à CA privée se configure par `DATABASE_SSL_CA` ;
 * `DATABASE_SSL_INSECURE` reste possible, mais devient un choix explicite,
 * annoncé bruyamment au démarrage plutôt que subi en silence.
 */
function sslOptions(): { rejectUnauthorized: boolean; ca?: string } {
  if (env.DATABASE_SSL_INSECURE) {
    log.warn(
      'DATABASE_SSL_INSECURE=true : le certificat du serveur PostgreSQL n\'est PAS vérifié. ' +
        'La connexion est chiffrée mais reste vulnérable à une interception active.',
    );
    return { rejectUnauthorized: false };
  }
  return env.DATABASE_SSL_CA
    ? { rejectUnauthorized: true, ca: readFileSync(env.DATABASE_SSL_CA, 'utf8') }
    : { rejectUnauthorized: true };
}

function createPool(): Pool {
  const created = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000,
    // Coupe net toute requête qui partirait en vrille (jointure oubliée,
    // verrou pris par un autre process) au lieu de saturer le pool.
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: 'harvester',
    ...(env.DATABASE_SSL ? { ssl: sslOptions() } : {}),
  });

  created.on('error', (error) => {
    // Un client idle qui meurt (redémarrage PG, failover) ne doit pas faire
    // tomber le process : pg le retirera du pool et en recréera un.
    log.error({ err: error }, 'erreur inattendue sur un client PostgreSQL idle');
  });

  return created;
}

export function getPool(): Pool {
  if (!pool) pool = createPool();
  return pool;
}

export function getDb(): Database {
  if (!db) {
    db = drizzle(getPool(), {
      schema,
      logger: !isProduction && env.LOG_LEVEL === 'trace',
    });
  }
  return db;
}

/**
 * Exécute `fn` dans une transaction en lecture/écriture, isolation READ
 * COMMITTED — le défaut de PostgreSQL.
 *
 * Ce n'est délibérément PAS du SERIALIZABLE : ce niveau ferait échouer des
 * transactions concurrentes avec `40001` qu'il faudrait rejouer, pour un
 * bénéfice nul ici. La correction vient des verrous de ligne explicites
 * (`lockUserRow`, `lockListing`, `lockPlot`) et des écritures conditionnelles
 * (`WHERE coins >= amount`), qui sérialisent les accès au même joueur sans
 * verrou global ni rejeu.
 *
 * Toute opération économique (achat, vente, échange, craft, enchère) DOIT passer
 * par ici : c'est ce qui garantit qu'un double-clic ne débite pas deux fois, et
 * que le débit du solde et l'écriture du journal `transactions` sont atomiques.
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => fn(tx), {
    isolationLevel: 'read committed',
  });
}

/**
 * Verrouille la ligne joueur pour la durée de la transaction.
 * `SELECT ... FOR NO KEY UPDATE` : les autres transactions qui veulent le même
 * joueur attendent ici, ce qui rend impossible la course « lire solde →
 * décider → écrire solde ». Retourne `undefined` si le joueur n'existe pas.
 *
 * Pas `FOR UPDATE` : ce mode-là entre en conflit avec le `FOR KEY SHARE` que
 * PostgreSQL pose pour vérifier chaque clé étrangère vers `users`. Tout INSERT
 * dans une table qui référence le joueur (journal, notification, audit…) fait
 * sur UNE AUTRE connexion du pool pendant la transaction attendait alors sa
 * fin, c'est-à-dire le délai d'expiration de 15 s quand c'est la transaction
 * elle-même qui attendait cet INSERT. `NO KEY UPDATE` sérialise toujours les
 * transactions qui verrouillent le joueur, sans bloquer ces vérifications :
 * nous ne modifions jamais `users.id`.
 */
export async function lockUserRow(tx: Transaction, userId: string) {
  const [row] = await tx
    .select({
      id: schema.users.id,
      coins: schema.users.coins,
      gems: schema.users.gems,
      level: schema.users.level,
      xp: schema.users.xp,
      ecoBannedUntil: schema.users.ecoBannedUntil,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .for('no key update');
  return row;
}

/**
 * Verrouille plusieurs lignes joueur dans un ordre déterministe (tri par UUID).
 * Indispensable pour les échanges et enchères : si A verrouille A puis B tandis
 * que B verrouille B puis A, on obtient un interblocage. Trier les IDs impose
 * un ordre global unique et supprime la classe entière de deadlocks.
 */
export async function lockUserRows(tx: Transaction, userIds: string[]) {
  const ordered = [...new Set(userIds)].sort();
  const locked: Array<Awaited<ReturnType<typeof lockUserRow>>> = [];
  for (const id of ordered) {
    locked.push(await lockUserRow(tx, id));
  }
  return locked.filter((row): row is NonNullable<typeof row> => row !== undefined);
}

/** Emprunte un client brut du pool (migrations, requêtes de maintenance). */
export async function withRawClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function pingDatabase(): Promise<number> {
  const started = Date.now();
  await getPool().query('SELECT 1');
  return Date.now() - started;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
    log.info('pool PostgreSQL fermé');
  }
}
