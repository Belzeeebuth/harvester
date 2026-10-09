import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsCallbackLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
// `fetch` vient du MÊME paquet que `Agent`, pas du `fetch` global : celui de
// Node embarque sa propre copie d'undici (6.x en Node 22), qui appelle le
// dispatcher avec l'ancienne interface. Un `Agent` undici 8 la refuse
// (« invalid onRequestStart method ») et chaque livraison échouait.
import { Agent, fetch } from 'undici';
import { balance as getBalance } from '../config';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as webhookRepo from '../repositories/webhook.repo';
import type { PlayerContext } from '../types';

const log = moduleLogger('webhook');

const dnsLookup = lookup;

/**
 * Webhooks sortants (v3.2 — API publique).
 *
 * Le déclenchement d'un évènement de jeu (`enqueueEvent`) se contente d'écrire
 * une ligne en base, dans la MÊME transaction que l'action qui le cause : un
 * appel HTTP sortant vers un serveur tiers ne doit jamais faire échouer ni
 * ralentir une récolte ou la clôture d'une enchère. La livraison réelle est
 * un travail séparé (`dispatchPending`, appelé par le job planifié
 * `webhooks:dispatch`), une tentative unique par évènement — pas de reprise
 * avec attente exponentielle, la fiabilité vient plutôt de la désactivation
 * automatique d'un abonnement qui échoue en boucle (`webhookMaxFailures`).
 */

export const WEBHOOK_EVENT_TYPES = ['crop_ready', 'auction_won', 'price_alert'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

function generateSecret(): string {
  return randomBytes(24).toString('hex');
}

export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * ---------------------------------------------------------------------------
 * DÉFENSE ANTI-SSRF
 * ---------------------------------------------------------------------------
 * L'URL d'un webhook est fournie par un JOUEUR, et le bot la contacte depuis
 * l'intérieur du réseau Docker. Sans filtrage, n'importe qui pouvait enregistrer
 * `http://harvester-db:5432`, `http://127.0.0.1:3001/metrics` ou
 * `http://169.254.169.254/` puis lire le résultat via `/webhook test` : un
 * scanner de l'infrastructure offert à tous les joueurs.
 *
 * Trois barrières, nécessaires ENSEMBLE :
 *  1. HTTPS seul — un `http://` en clair vers une IP interne n'a aucun usage
 *     légitime pour un webhook public ;
 *  2. résolution DNS puis refus des plages privées, AVANT la requête — filtrer
 *     sur le nom d'hôte ne sert à rien, `evil.com` peut pointer sur 127.0.0.1 ;
 *  3. `redirect: 'manual'` — sans quoi une redirection 302 contourne les deux
 *     premières ;
 *  4. ÉPINGLAGE de l'adresse validée — `fetch(url)` refaisait sa propre
 *     résolution DNS après le contrôle, ce qui laissait entière la fenêtre du
 *     « DNS rebinding » : un domaine à TTL très court peut répondre par une
 *     adresse publique à la vérification et par `127.0.0.1` à la requête. On
 *     se connecte donc à l'adresse effectivement contrôlée, et le contrôle est
 *     rejoué au moment de l'établissement de la connexion.
 */

/** Adresse hors de portée d'un webhook : boucle locale, réseaux privés, métadonnées cloud. */
function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === '::1' || normalized === '::') return true;
    // Adresses locales uniques (fc00::/7) et lien-local (fe80::/10).
    if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized)) return true;
    // IPv4 encapsulée : on retombe sur les règles v4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isBlockedAddress(mapped[1], 4);
    return false;
  }

  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [a = 0, b = 0] = octets;

  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // privé
  if (a === 127) return true;                        // boucle locale
  if (a === 169 && b === 254) return true;           // lien-local + métadonnées cloud
  if (a === 172 && b >= 16 && b <= 31) return true;  // privé
  if (a === 192 && b === 168) return true;           // privé
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                         // multicast et réservé
  return false;
}

/** Forme de l'URL. La résolution DNS, elle, est vérifiée juste avant l'envoi. */
function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Vérifie qu'un hôte ne résout QUE vers des adresses publiques.
 *
 * Contrôlé à chaque envoi, et non seulement à l'inscription : un nom de domaine
 * accepté aujourd'hui peut être repointé vers 127.0.0.1 demain (« DNS
 * rebinding »). Un refus de résolution bloque, plutôt que de laisser passer.
 */
async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  try {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) return false;
    return records.every((record) => !isBlockedAddress(record.address, record.family));
  } catch {
    return false;
  }
}

/**
 * Agent HTTP dont la résolution DNS est elle-même filtrée.
 *
 * C'est la seule barrière qui ferme réellement le « DNS rebinding » : le
 * contrôle porte sur l'adresse à laquelle la socket va SE CONNECTER, pas sur
 * une résolution antérieure et indépendante. Une résolution qui renvoie la
 * moindre adresse interne fait échouer la connexion avec une erreur explicite.
 */
const guardedAgent = new Agent({
  // undici 8 négocie HTTP/2 par défaut ; vers des adresses fournies par les
  // joueurs, on s'en tient à HTTP/1.1, seul chemin éprouvé avec ce garde.
  allowH2: false,
  connect: {
    lookup(hostname, options, callback) {
      dnsCallbackLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
        if (error) {
          callback(error, '', 0);
          return;
        }
        const records = addresses as unknown as Array<{ address: string; family: number }>;
        if (
          records.length === 0 ||
          records.some((record) => isBlockedAddress(record.address, record.family))
        ) {
          callback(new Error('blocked_address'), '', 0);
          return;
        }
        // `all: true` a été imposé pour pouvoir inspecter TOUTES les réponses ;
        // on rend ensuite la forme attendue par l'appelant d'origine.
        if (options.all) {
          callback(null, records);
          return;
        }
        const first = records[0]!;
        callback(null, first.address, first.family);
      });
    },
  },
});

export async function subscribe(
  player: PlayerContext,
  url: string,
  events: string[],
): Promise<{ id: string; secret: string }> {
  const balance = getBalance();
  if (!balance.api.enabled) {
    throw gameError('forbidden', 'The public API is currently disabled.', {
      i18nKey: 'errors.api.disabled',
    });
  }

  if (!isValidWebhookUrl(url) || url.length > 500) {
    throw gameError('target_invalid', 'Invalid webhook URL.', {
      i18nKey: 'errors.webhook.invalid_url',
    });
  }
  if (!(await resolvesToPublicAddress(new URL(url).hostname))) {
    throw gameError('target_invalid', 'This address is not reachable.', {
      i18nKey: 'errors.webhook.invalid_url',
    });
  }
  const uniqueEvents = [...new Set(events)];
  if (uniqueEvents.length === 0 || uniqueEvents.some((event) => !WEBHOOK_EVENT_TYPES.includes(event as WebhookEventType))) {
    throw gameError('target_invalid', 'Unknown event type.', {
      i18nKey: 'errors.webhook.invalid_event',
      params: { events: WEBHOOK_EVENT_TYPES.join(', ') },
    });
  }

  const existing = await webhookRepo.countSubscriptions(player.id);
  if (existing >= balance.api.maxWebhooksPerUser) {
    throw gameError(
      'forbidden',
      `You can have at most ${balance.api.maxWebhooksPerUser} webhooks.`,
      { i18nKey: 'errors.webhook.too_many', params: { max: balance.api.maxWebhooksPerUser } },
    );
  }

  const secret = generateSecret();
  const row = await webhookRepo.insertSubscription({
    userId: player.id,
    url,
    secret,
    events: uniqueEvents,
  });
  return { id: row.id, secret };
}

export async function listSubscriptions(player: PlayerContext) {
  return webhookRepo.listSubscriptions(player.id);
}

export async function unsubscribe(player: PlayerContext, id: string): Promise<void> {
  const removed = await webhookRepo.deleteSubscription(player.id, id);
  if (!removed) {
    throw gameError('not_found', 'Webhook not found.', { i18nKey: 'errors.webhook.not_found' });
  }
}

interface DeliveryOutcome {
  ok: boolean;
  status?: number;
  error?: string;
}

async function deliver(url: string, secret: string, eventType: string, payload: unknown): Promise<DeliveryOutcome> {
  const balance = getBalance();

  if (!isValidWebhookUrl(url)) {
    return { ok: false, error: 'blocked_url' };
  }
  const target = new URL(url);
  if (!(await resolvesToPublicAddress(target.hostname))) {
    log.warn({ hostname: target.hostname }, 'webhook vers une adresse non publique, bloqué');
    return { ok: false, error: 'blocked_address' };
  }

  const body = JSON.stringify({ event: eventType, data: payload, sentAt: new Date().toISOString() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), balance.api.webhookTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      // Une redirection contournerait le contrôle d'adresse ci-dessus.
      redirect: 'manual',
      // Le contrôle d'adresse est rejoué à l'établissement de la connexion :
      // sans cela, `fetch` refait sa propre résolution et la vérification
      // ci-dessus ne porte que sur une réponse DNS déjà périmée.
      dispatcher: guardedAgent,
      headers: {
        'content-type': 'application/json',
        'x-harvester-event': eventType,
        'x-harvester-signature': signPayload(secret, body),
      },
      body,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    // `fetch` ne dit que « fetch failed » : la vraie raison (refus du garde
    // DNS, connexion refusée, délai…) est dans `cause`. Elle ne va qu'en base
    // (`last_error`), jamais au joueur (voir `sendTestPing`).
    const cause = (error as Error).cause;
    return { ok: false, error: cause instanceof Error ? cause.message : (error as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Envoi immédiat, hors file, pour que le joueur vérifie son point de terminaison.
 *
 * Ne renvoie qu'un booléen : rendre le statut HTTP et le message d'erreur bruts
 * transformait cette commande en scanner de ports — la différence entre
 * « connexion refusée », « expiré » et « 200 » suffit à cartographier un réseau.
 */
export async function sendTestPing(
  player: PlayerContext,
  id: string,
): Promise<{ ok: boolean }> {
  const subscription = await webhookRepo.findSubscription(player.id, id);
  if (!subscription) {
    throw gameError('not_found', 'Webhook not found.', { i18nKey: 'errors.webhook.not_found' });
  }
  const outcome = await deliver(subscription.url, subscription.secret, 'ping', {
    message: 'Test delivery from Harvester.',
  });
  return { ok: outcome.ok };
}

/** Met en file un évènement pour chaque abonnement actif du joueur qui l'écoute. */
export async function enqueueEvent(
  userId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  const subscriptions = await webhookRepo.findEnabledSubscriptionsForEvent(userId, eventType);
  for (const subscription of subscriptions) {
    await webhookRepo.enqueueEvent({ subscriptionId: subscription.id, eventType, payload });
  }
}

/** Appelé par le job planifié `webhooks:dispatch`. Une tentative par évènement en attente. */
export async function dispatchPending(limit: number): Promise<{ delivered: number; failed: number }> {
  const balance = getBalance();
  const pending = await webhookRepo.claimPendingEvents(limit);
  let delivered = 0;
  let failed = 0;

  for (const { event, subscription } of pending) {
    if (!subscription.enabled) {
      await webhookRepo.markEventFailed(event.id, 'subscription disabled');
      failed += 1;
      continue;
    }

    const outcome = await deliver(subscription.url, subscription.secret, event.eventType, event.payload);
    const { consecutiveFailures } = await webhookRepo.recordDeliveryOutcome(subscription.id, outcome.ok);

    if (outcome.ok) {
      await webhookRepo.markEventDelivered(event.id);
      delivered += 1;
    } else {
      await webhookRepo.markEventFailed(event.id, outcome.error ?? `HTTP ${outcome.status}`);
      failed += 1;
      if (consecutiveFailures >= balance.api.webhookMaxFailures) {
        await webhookRepo.disableSubscription(subscription.id);
        log.warn(
          { subscriptionId: subscription.id, consecutiveFailures },
          'webhook désactivé après trop d\'échecs consécutifs',
        );
      }
    }
  }

  return { delivered, failed };
}
