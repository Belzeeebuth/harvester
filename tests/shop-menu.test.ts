import { beforeAll, describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n';
import { isGameError } from '../src/utils/errors';
import type { ShopEntry } from '../src/services/market.service';
import type { PlayerContext } from '../src/types';

/**
 * Menu d'achat de `/shop`.
 *
 * Le menu ne listait que les articles ACHETABLES sur-le-champ : sous six
 * « offres du jour » dont cinq demandaient un niveau supérieur, il n'en
 * proposait qu'une, sans dire pourquoi les autres manquaient — le joueur
 * concluait que la graine de melon affichée juste au-dessus avait disparu.
 * Le menu reprend désormais tout ce que l'écran affiche, et le refus (niveau,
 * rupture) est dit dans l'option puis prononcé avant le modal de quantité.
 */

/** Tirage réel du 2026-09-20, niveaux requis compris. */
const DEALS: Array<[key: string, level: number, stock: number]> = [
  ['quest_reroll_token', 1, 7],
  ['seed_cucumber', 5, 12],
  ['seed_melon', 10, 6],
  ['tool_scythe_iron', 12, 0],
  ['seed_mandarin', 25, 11],
  ['seed_frost_rose', 45, 23],
];

function entry([itemKey, requiredLevel, stockRemaining]: (typeof DEALS)[number]): ShopEntry {
  return {
    id: itemKey,
    itemKey,
    name: itemKey,
    emoji: '🌱',
    category: 'daily',
    rarity: 'common',
    price: 1600,
    currency: 'coins',
    discountPercent: 0,
    stockRemaining,
    stockTotal: 23,
    requiredLevel,
    featured: false,
    description: 'Une description de catalogue.',
    expiresAt: new Date('2026-09-20T23:59:59.000Z'),
  };
}

const context = (level: number) => ({
  t: translatorFor('fr'),
  locale: 'fr' as const,
  player: { level } as PlayerContext,
});

let shopChoices: typeof import('../src/framework/views').shopChoices;
let assertPurchasable: typeof import('../src/services/market.service').assertPurchasable;

beforeAll(async () => {
  // `views` tire tout le graphe (services, rendu) : l'import prend plusieurs
  // secondes sur un hôte chargé, d'où le délai explicite.
  ({ shopChoices } = await import('../src/framework/views'));
  ({ assertPurchasable } = await import('../src/services/market.service'));
}, 60_000);

describe("menu d'achat de la boutique", () => {
  it('liste toutes les offres affichées, pas seulement celles du niveau du joueur', () => {
    const choices = shopChoices(DEALS.map(entry), context(3));
    expect(choices.map((choice) => choice.value).sort()).toEqual(DEALS.map(([key]) => key).sort());
  });

  it("place les articles achetables d'abord, puis les verrouillés, puis les épuisés", () => {
    const choices = shopChoices(DEALS.map(entry), context(10));
    expect(choices.map((choice) => choice.value)).toEqual([
      'quest_reroll_token',
      'seed_cucumber',
      'seed_melon',
      'seed_mandarin',
      'seed_frost_rose',
      'tool_scythe_iron',
    ]);
  });

  it('dit pourquoi un article ne peut pas être pris', () => {
    const choices = shopChoices(DEALS.map(entry), context(3));
    const byKey = new Map(choices.map((choice) => [choice.value, choice]));
    expect(byKey.get('quest_reroll_token')?.description).toBe('Une description de catalogue.');
    expect(byKey.get('seed_melon')?.description).toBe('🔒 Niveau 10 requis');
    // Épuisé ET verrouillé : la rupture l'emporte, monter de niveau n'y changerait rien.
    expect(byKey.get('tool_scythe_iron')?.description).toBe('Épuisé');
  });

  it('formate le prix et ne contient aucun tiret long', () => {
    const [first] = shopChoices(DEALS.map(entry), context(3));
    expect(first?.label).toMatch(/^quest_reroll_token · 1\s?600 /u);
    expect(first?.label).not.toMatch(/[\u2013\u2014]/u);
  });

  it('ne dépasse jamais 25 options et garde les achetables', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      entry([`item_${index}`, index < 30 ? 50 : 1, 5]),
    );
    const choices = shopChoices(many, context(3));
    expect(choices).toHaveLength(25);
    expect(choices.slice(0, 10).map((choice) => choice.value)).toEqual(
      Array.from({ length: 10 }, (_, index) => `item_${30 + index}`),
    );
  });
});

describe('refus avant le modal de quantité', () => {
  const thrown = (run: () => void): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('laisse passer un article au niveau du joueur et en stock', () => {
    expect(thrown(() => assertPurchasable({ level: 10 }, entry(DEALS[2]!)))).toBeUndefined();
  });

  it('refuse un article au-dessus du niveau du joueur', () => {
    const error = thrown(() => assertPurchasable({ level: 3 }, entry(DEALS[2]!)));
    expect(isGameError(error) && error.code).toBe('level_too_low');
  });

  it('refuse un article épuisé', () => {
    const error = thrown(() => assertPurchasable({ level: 50 }, entry(DEALS[3]!)));
    expect(isGameError(error) && error.code).toBe('not_found');
  });
});
