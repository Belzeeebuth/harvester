import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Status, type Client } from 'discord.js';
import { env } from '../config/env';
import { pingDatabase } from '../db/client';
import { pingRedis } from '../db/redis';
import { getConfig } from '../config';
import { getRegistry } from '../framework/registry';
import * as economyRepo from '../repositories/economy.repo';
import { renderPoolStats } from '../render/pool';
import { clockOffsetEstimate, formatClockOffset } from '../utils/discord-clock';
import { handleApiRequest } from './api';
import { metricsRegistry, setRenderPoolGauges } from './metrics';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('http');

/**
 * Serveur HTTP d'observabilité.
 *
 *   GET /health   → 200 si le bot est connecté ET la base joignable ; 503 sinon.
 *                   C'est ce que doivent interroger Docker, Kubernetes ou un
 *                   superviseur : un process vivant mais déconnecté de Discord
 *                   n'est PAS sain, et il faut le redémarrer.
 *   GET /ready    → 200 dès que les commandes sont chargées (démarrage).
 *   GET /metrics  → métriques au format Prometheus (texte).
 *
 * Aucun framework HTTP : trois routes ne justifient pas Express, et une
 * dépendance de moins, c'est une surface d'attaque de moins.
 */

interface Metrics {
  commandsTotal: number;
  commandErrors: number;
  interactionsTotal: number;
  lateInteractions: number;
  startedAt: number;
}

const metrics: Metrics = {
  commandsTotal: 0,
  commandErrors: 0,
  interactionsTotal: 0,
  lateInteractions: 0,
  startedAt: Date.now(),
};

export function recordCommand(success: boolean): void {
  metrics.commandsTotal += 1;
  if (!success) metrics.commandErrors += 1;
}

export function recordInteraction(): void {
  metrics.interactionsTotal += 1;
}

/** Interaction livrée par la passerelle trop tard pour être acquittée dans les 3 s. */
export function recordLateInteraction(): void {
  metrics.lateInteractions += 1;
}

/**
 * Autorise `/metrics` : libre si `HTTP_METRICS_TOKEN` est vide, sinon
 * `Authorization: Bearer <jeton>` en comparaison à temps constant.
 */
function metricsAuthorized(request: import('node:http').IncomingMessage): boolean {
  const expected = env.HTTP_METRICS_TOKEN;
  if (!expected) return true;

  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length).trim());
  const reference = Buffer.from(expected);
  return provided.length === reference.length && timingSafeEqual(provided, reference);
}

export function startHealthServer(client: Client): Server | undefined {
  if (env.HTTP_PORT <= 0) return undefined;

  const server = createServer((request, response) => {
    const url = request.url ?? '/';

    if (url === '/health' || url === '/healthz') {
      void handleHealth(client, response);
      return;
    }

    if (url === '/ready') {
      const ready = getRegistry().commands.size > 0;
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready, commands: getRegistry().commands.size }));
      return;
    }

    if (url === '/metrics') {
      // `/metrics` publie la masse monétaire, les joueurs actifs, le ratio
      // faucet/sink et les écarts comptables — et partage son port avec l'API
      // publique `/api/v1`, qui est faite pour être exposée. Exposer l'une
      // exposait donc l'autre. Le jeton est facultatif : sur un port lié à la
      // boucle locale, l'accès libre reste le bon réglage.
      if (!metricsAuthorized(request)) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      void handleMetrics(client, response);
      return;
    }

    if (url.startsWith('/api/')) {
      void handleApiRequest(request, response);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  server.listen(env.HTTP_PORT, () => {
    log.info({ port: env.HTTP_PORT }, 'serveur de santé démarré');
  });

  return server;
}

async function handleHealth(client: Client, response: import('node:http').ServerResponse): Promise<void> {
  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

  checks.discord = {
    ok: client.isReady() && client.ws.status === Status.Ready,
    latencyMs: Math.max(0, Math.round(client.ws.ping)),
  };

  try {
    checks.database = { ok: true, latencyMs: await pingDatabase() };
  } catch (error) {
    checks.database = { ok: false, error: (error as Error).message };
  }

  try {
    checks.redis = { ok: true, latencyMs: await pingRedis() };
  } catch (error) {
    // Redis dégradé n'est pas fatal : le bot fonctionne sans cache.
    checks.redis = { ok: false, error: (error as Error).message };
  }

  const healthy = checks.discord.ok && checks.database.ok;
  response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1_000),
      checks,
    }),
  );
}

async function handleMetrics(client: Client, response: import('node:http').ServerResponse): Promise<void> {
  response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
  response.end(await renderMetrics(client));
}

async function renderMetrics(client: Client): Promise<string> {
  const config = getConfig();
  const lines = [
    '# HELP harvester_uptime_seconds Temps depuis le démarrage',
    '# TYPE harvester_uptime_seconds gauge',
    `harvester_uptime_seconds ${Math.round((Date.now() - metrics.startedAt) / 1_000)}`,
    '# HELP harvester_commands_total Commandes exécutées',
    '# TYPE harvester_commands_total counter',
    `harvester_commands_total ${metrics.commandsTotal}`,
    '# HELP harvester_command_errors_total Commandes en erreur',
    '# TYPE harvester_command_errors_total counter',
    `harvester_command_errors_total ${metrics.commandErrors}`,
    '# HELP harvester_interactions_total Interactions traitées',
    '# TYPE harvester_interactions_total counter',
    `harvester_interactions_total ${metrics.interactionsTotal}`,
    '# HELP harvester_late_interactions_total Interactions reçues de la passerelle avec plus de 2 s de retard',
    '# TYPE harvester_late_interactions_total counter',
    `harvester_late_interactions_total ${metrics.lateInteractions}`,
    '# HELP harvester_clock_offset_ms Décalage estimé de l’horloge du serveur par rapport à Discord',
    '# TYPE harvester_clock_offset_ms gauge',
    // NaN faute d'interaction récente : une valeur périmée ferait croire à un
    // décalage qui n'existe peut-être plus (ou masquerait un nouveau).
    `harvester_clock_offset_ms ${formatClockOffset(clockOffsetEstimate())}`,
    '# HELP harvester_guilds Serveurs Discord connectés (ce shard)',
    '# TYPE harvester_guilds gauge',
    `harvester_guilds ${client.guilds.cache.size}`,
    '# HELP harvester_ws_ping_ms Latence WebSocket Discord',
    '# TYPE harvester_ws_ping_ms gauge',
    `harvester_ws_ping_ms ${Math.max(0, Math.round(client.ws.ping))}`,
    '# HELP harvester_config_items Objets chargés en configuration',
    '# TYPE harvester_config_items gauge',
    `harvester_config_items ${config.itemList.length}`,
  ];

  // Dérivées de l'instantané horaire (`economy:snapshot`), jamais recalculées
  // à la volée : une jointure sur `transactions` à chaque scrape Prometheus,
  // multipliée par le nombre de shards, serait une charge inutile sur la base.
  try {
    const [snapshot] = await economyRepo.lastEconomySnapshots(1);
    if (snapshot) {
      const ageSeconds = Math.max(
        0,
        Math.round((Date.now() - snapshot.capturedAt.getTime()) / 1_000),
      );
      const ratio =
        snapshot.coinsDestroyed > 0
          ? (snapshot.coinsCreated / snapshot.coinsDestroyed).toFixed(4)
          : snapshot.coinsCreated > 0
            ? '+Inf'
            : '0';

      lines.push(
        '# HELP harvester_economy_total_coins Masse monétaire totale en portefeuille',
        '# TYPE harvester_economy_total_coins gauge',
        `harvester_economy_total_coins ${snapshot.totalCoins}`,
        '# HELP harvester_economy_total_bank_coins Masse monétaire en banque',
        '# TYPE harvester_economy_total_bank_coins gauge',
        `harvester_economy_total_bank_coins ${snapshot.totalBankCoins}`,
        '# HELP harvester_economy_total_gems Gemmes en circulation',
        '# TYPE harvester_economy_total_gems gauge',
        `harvester_economy_total_gems ${snapshot.totalGems}`,
        '# HELP harvester_economy_coins_created Pièces créées (faucets) sur la fenêtre de l\'instantané',
        '# TYPE harvester_economy_coins_created gauge',
        `harvester_economy_coins_created ${snapshot.coinsCreated}`,
        '# HELP harvester_economy_coins_destroyed Pièces détruites (sinks) sur la fenêtre de l\'instantané',
        '# TYPE harvester_economy_coins_destroyed gauge',
        `harvester_economy_coins_destroyed ${snapshot.coinsDestroyed}`,
        '# HELP harvester_economy_faucet_sink_ratio Ratio création/destruction (> 1 = inflation nette)',
        '# TYPE harvester_economy_faucet_sink_ratio gauge',
        `harvester_economy_faucet_sink_ratio ${ratio}`,
        '# HELP harvester_economy_active_users_24h Joueurs actifs sur les dernières 24h',
        '# TYPE harvester_economy_active_users_24h gauge',
        `harvester_economy_active_users_24h ${snapshot.activeUsers24h}`,
        '# HELP harvester_economy_total_users Joueurs enregistrés',
        '# TYPE harvester_economy_total_users gauge',
        `harvester_economy_total_users ${snapshot.totalUsers}`,
        '# HELP harvester_economy_ledger_mismatches Écarts détectés entre solde et journal comptable',
        '# TYPE harvester_economy_ledger_mismatches gauge',
        `harvester_economy_ledger_mismatches ${snapshot.ledgerMismatches}`,
        '# HELP harvester_economy_suspicious_users Joueurs au-dessus du seuil de revue anti-triche',
        '# TYPE harvester_economy_suspicious_users gauge',
        `harvester_economy_suspicious_users ${snapshot.suspiciousUsers}`,
        '# HELP harvester_economy_snapshot_age_seconds Ancienneté du dernier instantané économique',
        '# TYPE harvester_economy_snapshot_age_seconds gauge',
        `harvester_economy_snapshot_age_seconds ${ageSeconds}`,
      );
    }
  } catch (error) {
    log.warn({ err: error }, "lecture de l'instantané économique impossible pour /metrics");
  }

  // Jauges du pool de rendu lues à l'instant du scrape : elles décrivent un
  // état, pas un flux, et `renderPoolStats()` est une lecture mémoire sans
  // coût. Le registre à étiquettes (erreurs par code, latences) est rendu à
  // la suite des compteurs historiques, dont noms et sémantique restent
  // inchangés pour ne pas casser un tableau de bord déjà branché.
  setRenderPoolGauges(renderPoolStats());
  return `${lines.join('\n')}\n${metricsRegistry.render()}`;
}

export { metrics };
