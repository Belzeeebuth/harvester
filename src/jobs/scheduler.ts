import { Queue, Worker, type Job } from 'bullmq';
import type { Client } from 'discord.js';
import { env } from '../config/env';
import { getQueueConnection } from '../db/redis';
import { moduleLogger } from '../utils/logger';
import { toError } from '../utils/errors';
import * as systemRepo from '../repositories/system.repo';
import { jobs, type JobDefinition } from './definitions';
import { startNotificationWorker } from './notifications';

const log = moduleLogger('scheduler');

/**
 * ---------------------------------------------------------------------------
 * ORDONNANCEUR
 * ---------------------------------------------------------------------------
 * BullMQ (Redis) porte l'exécution : planifications par cron, réessais avec
 * back-off, et surtout DÉDOUBLONNAGE ENTRE PROCESS. Avec plusieurs shards, tous
 * exécutent ce code, mais une planification n'est enregistrée qu'une fois dans
 * Redis : la mise à jour du marché ne peut donc pas se produire quatre fois.
 *
 * Repli sans Redis (`QUEUES_ENABLED=false`) : un simple `setInterval` par job,
 * réservé au développement local. En production, Redis est requis — c'est écrit
 * dans le README.
 *
 * Chaque exécution est journalisée dans `scheduled_tasks` : `/admin stats`
 * affiche la dernière exécution, sa durée et son éventuelle erreur.
 */

/**
 * Nom de file BullMQ — SANS deux-points.
 *
 * BullMQ construit ses clés Redis en concaténant `<prefix>:<queue>:<suffixe>` ;
 * un `:` dans le nom casserait cette structure, et la bibliothèque le refuse
 * explicitement depuis la v5 (« Queue name cannot contain : »). Le
 * cloisonnement par instance passe donc par l'option `prefix`, prévue pour ça,
 * et non par un nom composé.
 */
const QUEUE_NAME = 'jobs';

/** Préfixe de clés, aligné sur celui du reste de l'application. */
const QUEUE_PREFIX = env.REDIS_PREFIX;

let queue: Queue | undefined;
let worker: Worker | undefined;
const timers: NodeJS.Timeout[] = [];

export async function startScheduler(client: Client): Promise<void> {
  if (!env.SCHEDULER_ENABLED) {
    log.info('ordonnanceur désactivé (SCHEDULER_ENABLED=false)');
    return;
  }

  // Enregistre les tâches en base : elles survivent à une purge de Redis.
  for (const definition of jobs) {
    await systemRepo.registerTask({
      taskKey: definition.key,
      kind: 'cron',
      cron: definition.cron,
      runAt: new Date(),
      payload: { description: definition.description },
    });
  }

  if (env.QUEUES_ENABLED) {
    await startWithBullMq();
  } else {
    startWithTimers();
  }

  startNotificationWorker(client);
  log.info({ jobs: jobs.length, mode: env.QUEUES_ENABLED ? 'bullmq' : 'timers' }, 'ordonnanceur démarré');
}

async function startWithBullMq(): Promise<void> {
  const connection = getQueueConnection();
  queue = new Queue(QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });

  // Un SEUL process réenregistre les planifications.
  //
  // Tous les shards démarrent à peu près en même temps et exécutaient ce bloc
  // en parallèle : la purge de l'un pouvait effacer l'enregistrement qu'un autre
  // venait de poser, et certaines tâches se retrouvaient tout simplement non
  // programmées. Le verrou n'est jamais relâché : il expire, ce qui suffit à
  // couvrir la fenêtre de démarrage.
  const registrar = await connection.set(
    `${QUEUE_PREFIX}:scheduler:register`,
    process.pid.toString(),
    'EX',
    60,
    'NX',
  );

  if (registrar === 'OK') {
    // Une planification (« job scheduler ») par tâche, identifiée par sa clé :
    // `upsertJobScheduler` met à jour en place, un cron modifié dans le code
    // remplace donc l'ancien sans purge préalable ni fenêtre sans planification.
    // Les jobs répétables (`queue.add` + `repeat`) disparaissent de BullMQ 6.
    for (const definition of jobs) {
      await queue.upsertJobScheduler(
        definition.key,
        { pattern: definition.cron, tz: 'UTC' },
        {
          name: definition.key,
          data: { key: definition.key },
          opts: {
            removeOnComplete: 50,
            removeOnFail: 100,
            attempts: 3,
            backoff: { type: 'exponential', delay: 30_000 },
          },
        },
      );
    }

    // Tout ce qui reste dans l'ensemble `repeat` sans correspondre à une tâche
    // actuelle est retiré : planification d'une tâche supprimée du code, et
    // anciens jobs répétables (clé = empreinte des options), que BullMQ 6
    // ne sait plus gérer. `removeRepeatableByKey` supprime aussi leur prochaine
    // exécution déjà programmée. À garder tant que la prod tourne en BullMQ 5 :
    // c'est cette purge qui rend la montée en v6 possible.
    const known = new Set(jobs.map((definition) => definition.key));
    let purged = 0;
    for (const entry of await queue.getRepeatableJobs()) {
      if (known.has(entry.key)) continue;
      await queue.removeRepeatableByKey(entry.key);
      purged += 1;
    }
    log.info({ jobs: jobs.length, purged }, 'tâches planifiées enregistrées par ce process');
  } else {
    log.info('tâches planifiées déjà enregistrées par un autre process');
  }

  worker = new Worker(
    QUEUE_NAME,
    async (job: Job<{ key: string }>) => {
      const definition = jobs.find((entry) => entry.key === job.data.key);
      if (!definition) throw new Error(`unknown job: ${job.data.key}`);
      return runJob(definition);
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 2 },
  );

  worker.on('failed', (job, error) => {
    log.error({ err: error, job: job?.name }, 'job en échec');
  });
}

/**
 * Périodicité de chaque forme de cron utilisée par `definitions.ts`.
 * Sert au repli sans Redis et à l'estimation de la prochaine exécution.
 */
const CRON_INTERVALS: Record<string, number> = {
  '* * * * *': 60_000,
  '*/5 * * * *': 5 * 60_000,
  '*/10 * * * *': 10 * 60_000,
  '*/15 * * * *': 15 * 60_000,
  '0 * * * *': 60 * 60_000,
  '15 * * * *': 60 * 60_000,
  '30 * * * *': 60 * 60_000,
  '0 */2 * * *': 2 * 60 * 60_000,
  '30 */2 * * *': 2 * 60 * 60_000,
  '0 */3 * * *': 3 * 60 * 60_000,
  // Mensuel (`ledger:checkpoint`, le 1er à 05:00 UTC) : approximé à 30 jours
  // pour le repli minuteur et l'estimation de la prochaine exécution.
  '0 5 1 * *': 30 * 24 * 60 * 60_000,
};

function startWithTimers(): void {
  // Repli minimaliste : on approxime le cron par un intervalle. Suffisant en
  // développement, jamais recommandé en production (pas de coordination).
  //
  // ⚠ Les crons journaliers et hebdomadaires ne figurent pas dans la table et
  // retombent sur 24 h à partir du démarrage : en particulier
  // `leaderboard:weekly` s'exécuterait alors CHAQUE JOUR, remettant à zéro les
  // compteurs hebdomadaires. Raison de plus pour ne pas l'utiliser ailleurs
  // qu'en développement.
  for (const definition of jobs) {
    const interval = CRON_INTERVALS[definition.cron] ?? 24 * 60 * 60_000;
    timers.push(
      setInterval(() => {
        void runJob(definition).catch((error: unknown) =>
          log.error({ err: error, job: definition.key }, 'job en échec'),
        );
      }, interval),
    );
  }
}

/**
 * Prochaine exécution attendue, déduite du cron.
 *
 * `/admin stats` affichait « dans une minute » pour toutes les tâches, valeur
 * codée en dur sans rapport avec leur planification réelle. On se contente d'une
 * lecture des formes de cron utilisées ici, plutôt que d'embarquer un
 * analyseur complet pour une colonne d'affichage.
 */
function nextRunFor(definition: JobDefinition): Date {
  const intervalMs = CRON_INTERVALS[definition.cron] ?? 24 * 60 * 60_000;
  return new Date(Date.now() + intervalMs);
}

async function runJob(definition: JobDefinition): Promise<string> {
  const started = Date.now();
  log.debug({ job: definition.key }, 'job démarré');

  try {
    const result = await definition.run();
    const durationMs = Date.now() - started;
    await systemRepo.completeTask(definition.key, {
      durationMs,
      nextRunAt: nextRunFor(definition),
    });
    log.info({ job: definition.key, durationMs, result }, 'job terminé');
    return result;
  } catch (error) {
    const normalized = toError(error);
    await systemRepo.completeTask(definition.key, {
      durationMs: Date.now() - started,
      error: normalized.message,
      nextRunAt: nextRunFor(definition),
    });
    log.error({ err: normalized, job: definition.key }, 'job en échec');
    throw normalized;
  }
}

/** Déclenche un job à la demande (utile en exploitation). */
export async function runJobNow(key: string): Promise<string> {
  const definition = jobs.find((entry) => entry.key === key);
  if (!definition) throw new Error(`unknown job: ${key}`);
  return runJob(definition);
}

export async function stopScheduler(): Promise<void> {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  await worker?.close();
  await queue?.close();
  log.info('ordonnanceur arrêté');
}

export { jobs };
