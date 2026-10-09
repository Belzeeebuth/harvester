import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Livraison des webhooks — le garde contre le « DNS rebinding », qu'aucun test
 * n'exerçait.
 *
 * Le contrôle d'adresse est fait deux fois : une résolution avant l'envoi,
 * puis une seconde au moment où la socket se connecte (`guardedAgent`). Seule
 * la seconde ferme réellement la faille : un nom qui résout vers une adresse
 * publique au premier coup, puis vers le réseau interne au second, doit être
 * refusé à la connexion.
 *
 * Ce test aurait aussi attrapé la montée en undici 8 : avec le `fetch` global
 * de Node, l'agent n'était même pas appelé et TOUTES les livraisons
 * échouaient (« invalid onRequestStart method »), sans qu'aucun test ne rougisse.
 *
 * DNS et base sont remplacés par des doubles ; aucune requête ne sort.
 */

const dns = vi.hoisted(() => ({
  firstAnswer: '93.184.216.34',
  connectAnswer: '10.0.0.5',
}));

vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns/promises')>()),
  lookup: vi.fn(async () => [{ address: dns.firstAnswer, family: 4 }]),
}));

vi.mock('node:dns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns')>()),
  lookup: vi.fn(
    (
      _hostname: string,
      _options: unknown,
      callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void,
    ) => callback(null, [{ address: dns.connectAnswer, family: 4 }]),
  ),
}));

vi.mock('../src/repositories/webhook.repo', () => ({
  claimPendingEvents: vi.fn(),
  recordDeliveryOutcome: vi.fn(async () => ({ consecutiveFailures: 1 })),
  markEventDelivered: vi.fn(),
  markEventFailed: vi.fn(),
  disableSubscription: vi.fn(),
}));

const webhookRepo = await import('../src/repositories/webhook.repo');
const { dispatchPending } = await import('../src/services/webhook.service');

function pendingEvent() {
  return {
    event: { id: 1, eventType: 'ping', payload: {} },
    subscription: {
      id: 'abonnement',
      url: 'https://hooks.exemple.test/harvester',
      secret: 'secret',
      enabled: true,
    },
  };
}

describe('livraison des webhooks', () => {
  beforeEach(() => {
    vi.mocked(webhookRepo.claimPendingEvents).mockReset();
    vi.mocked(webhookRepo.markEventFailed).mockReset();
    vi.mocked(webhookRepo.markEventDelivered).mockReset();
    dns.firstAnswer = '93.184.216.34';
    dns.connectAnswer = '10.0.0.5';
  });

  it('refuse à la connexion un nom qui a basculé vers une adresse interne', async () => {
    vi.mocked(webhookRepo.claimPendingEvents).mockResolvedValue([pendingEvent()] as never);

    const result = await dispatchPending(10);

    expect(result).toEqual({ delivered: 0, failed: 1 });
    expect(webhookRepo.markEventDelivered).not.toHaveBeenCalled();
    expect(webhookRepo.markEventFailed).toHaveBeenCalledWith(1, 'blocked_address');
  });

  it('refuse avant tout envoi un nom qui résout déjà vers une adresse interne', async () => {
    dns.firstAnswer = '127.0.0.1';
    vi.mocked(webhookRepo.claimPendingEvents).mockResolvedValue([pendingEvent()] as never);

    await dispatchPending(10);

    expect(webhookRepo.markEventFailed).toHaveBeenCalledWith(1, 'blocked_address');
  });
});
