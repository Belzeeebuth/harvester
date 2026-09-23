import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { capacityExemptItemKeys } from '../src/services/inventory.service';
import { eventOccurrenceKey, getActiveEvents } from '../src/services/world.service';

/**
 * Paliers et boutique d'événement : garde-fous de configuration et règles
 * pures. Le parcours complet (réclamation, achat, limite, remise à zéro) est
 * couvert contre une vraie base par `integration/event-rewards.test.ts`.
 */

const config = getConfig();

describe("configuration des événements", () => {
  it('chaque palier a un seuil unique (il sert d’identifiant de réclamation)', () => {
    for (const event of config.eventList) {
      const thresholds = event.rewardTiers.map((tier) => tier.points);
      expect(new Set(thresholds).size, event.key).toBe(thresholds.length);
    }
  });

  it('chaque article de boutique existe et se paie dans un objet-monnaie connu', () => {
    for (const event of config.eventList) {
      for (const shopItem of event.shopItems) {
        expect(config.items.has(shopItem.itemKey), `${event.key}/${shopItem.itemKey}`).toBe(true);
        const currency = shopItem.currencyItemKey ?? event.currencyItemKey;
        if (currency) expect(config.items.has(currency), `${event.key}/${currency}`).toBe(true);
      }
    }
  });
});

describe('occurrences', () => {
  it('la Moisson 2026 et la Moisson 2027 sont deux occurrences distinctes', () => {
    const find = (iso: string) =>
      getActiveEvents(new Date(iso)).find((event) => event.key === 'autumn_harvest');
    const y2026 = find('2026-10-05T12:00:00.000Z');
    const y2027 = find('2027-10-05T12:00:00.000Z');
    expect(y2026).toBeDefined();
    expect(y2027).toBeDefined();
    expect(eventOccurrenceKey(y2026!)).not.toBe(eventOccurrenceKey(y2027!));
    // Deux instants de la même occurrence partagent la même clé.
    expect(eventOccurrenceKey(find('2026-10-01T00:30:00.000Z')!)).toBe(eventOccurrenceKey(y2026!));
  });
});

describe('entrepôt', () => {
  it("les monnaies d'événement ne comptent pas dans la capacité", () => {
    const exempt = capacityExemptItemKeys();
    for (const key of ['pumpkin_token', 'snowflake_token', 'spring_petal']) {
      expect(exempt.has(key), key).toBe(true);
    }
    expect(exempt.has('wheat')).toBe(false);
    expect(exempt.has('seed_pumpkin')).toBe(false);
  });
});
