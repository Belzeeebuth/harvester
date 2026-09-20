import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transactionTypeEnum } from '../src/db/schema/enums';
import { translatorFor } from '../src/i18n';
import {
  DEFAULT_HISTORY_DAYS,
  HISTORY_DAYS,
  HISTORY_FAMILIES,
  HISTORY_FAMILY_CHOICES,
  HISTORY_PAGE_SIZE,
  clampPage,
  familyTypes,
  formatHistoryLine,
  formatHistoryTotals,
  formatSignedAmount,
  isHistoryFamily,
  normalizeDays,
  normalizeFamily,
  pageCount,
  windowStart,
  type HistoryLine,
} from '../src/services/history.service';
import { buildCustomId } from '../src/utils/custom-id';
import { formatNumber } from '../src/utils/format';

/**
 * `/history` : tout ce qui est décidable sans base. Le regroupement des types
 * en familles, la borne de page et la mise en forme d'une ligne sont des
 * fonctions pures de `history.service.ts` ; `getHistory` ne fait que les
 * brancher sur le dépôt.
 */

const fr = translatorFor('fr');
const en = translatorFor('en');

describe('historique : familles', () => {
  it('classe chaque type de transaction dans exactement une famille', () => {
    // Un type oublié disparaîtrait de tous les filtres sauf « tout », sans
    // erreur : c'est ce test qui rend l'oubli visible.
    const grouped = Object.values(HISTORY_FAMILIES).flat();
    expect([...grouped].sort()).toEqual([...transactionTypeEnum.enumValues].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('propose « tout » et chaque famille comme choix Discord, sans dépasser 25', () => {
    expect(HISTORY_FAMILY_CHOICES[0]).toBe('all');
    for (const family of Object.keys(HISTORY_FAMILIES)) {
      expect(HISTORY_FAMILY_CHOICES).toContain(family);
    }
    expect(new Set(HISTORY_FAMILY_CHOICES).size).toBe(HISTORY_FAMILY_CHOICES.length);
    expect(HISTORY_FAMILY_CHOICES.length).toBeLessThanOrEqual(25);
  });

  it('ne filtre rien pour « tout » et renvoie les types de la famille sinon', () => {
    expect(familyTypes('all')).toBeUndefined();
    expect(familyTypes('taxes')).toEqual(['tax']);
    expect(familyTypes('sales')).toContain('harvest_sale');
    expect(familyTypes('sales')).not.toContain('auction_sale');
    expect(familyTypes('trades')).toEqual(['trade_in', 'trade_out', 'gift_in', 'gift_out']);
  });

  it('retombe sur « tout » pour une famille inconnue ou absente', () => {
    expect(normalizeFamily('bank')).toBe('bank');
    expect(normalizeFamily('nope')).toBe('all');
    expect(normalizeFamily('')).toBe('all');
    expect(normalizeFamily(null)).toBe('all');
    expect(normalizeFamily(undefined)).toBe('all');
    expect(isHistoryFamily('coop')).toBe(true);
    expect(isHistoryFamily('COOP')).toBe(false);
  });
});

describe('historique : période et pages', () => {
  it('n\'accepte que les périodes proposées, 7 jours par défaut', () => {
    expect(DEFAULT_HISTORY_DAYS).toBe(7);
    expect(HISTORY_DAYS).toEqual([1, 7, 30, 90]);
    expect(normalizeDays(30)).toBe(30);
    expect(normalizeDays('90')).toBe(90);
    expect(normalizeDays('12')).toBe(7);
    expect(normalizeDays(0)).toBe(7);
    expect(normalizeDays(null)).toBe(7);
    expect(normalizeDays(undefined)).toBe(7);
    expect(normalizeDays('abc')).toBe(7);
  });

  it('calcule le début de fenêtre depuis « maintenant »', () => {
    const now = new Date('2026-09-02T10:00:00.000Z');
    expect(windowStart(now, 7).toISOString()).toBe('2026-08-26T10:00:00.000Z');
    expect(windowStart(now, 1).toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });

  it('compte les pages par tranche de dix, jamais moins d\'une', () => {
    expect(HISTORY_PAGE_SIZE).toBe(10);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(10)).toBe(1);
    expect(pageCount(11)).toBe(2);
    expect(pageCount(95)).toBe(10);
    expect(pageCount(-5)).toBe(1);
  });

  it('borne la page demandée dans [1, total]', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(-3, 5)).toBe(1);
    expect(clampPage(3, 5)).toBe(3);
    expect(clampPage(9, 5)).toBe(5);
    // Fenêtre vide : une seule page, la première.
    expect(clampPage(3, 0)).toBe(1);
    expect(clampPage(Number.NaN, 5)).toBe(1);
    expect(clampPage(Number.POSITIVE_INFINITY, 5)).toBe(1);
    expect(clampPage(2.7, 5)).toBe(2);
  });
});

describe('historique : mise en forme d\'une ligne', () => {
  const createdAt = new Date('2026-09-02T10:00:00.000Z');
  const stamp = `<t:${Math.floor(createdAt.getTime() / 1_000)}:R>`;

  function line(overrides: Partial<HistoryLine> = {}): HistoryLine {
    return {
      id: 1,
      type: 'market_sale',
      currency: 'coins',
      amount: 120,
      balanceAfter: 1340,
      createdAt,
      item: { emoji: '🌾', name: 'Blé' },
      quantity: 12,
      unitPrice: 10,
      counterpartyName: null,
      counterpartyMissing: false,
      ...overrides,
    };
  }

  it('enchaîne date relative, libellé traduit, montant signé et solde', () => {
    const text = formatHistoryLine(line(), fr, 'fr');
    expect(text).toContain(stamp);
    expect(text).toContain('Vente au marché');
    expect(text).toContain(`**+${formatNumber(120, 'fr')} 🪙**`);
    expect(text).toContain(`solde ${formatNumber(1340, 'fr')} 🪙`);
    expect(text).toContain(`🌾 Blé ×${formatNumber(12, 'fr')}`);
    expect(text).toContain(`(${formatNumber(10, 'fr')} 🪙 l'unité)`);
  });

  it('se traduit en anglais avec les mêmes informations', () => {
    const text = formatHistoryLine(line(), en, 'en');
    expect(text).toContain(stamp);
    expect(text).toContain('Market sale');
    expect(text).toContain(`**+${formatNumber(120, 'en')} 🪙**`);
    expect(text).toContain(`balance ${formatNumber(1340, 'en')} 🪙`);
    expect(text).toContain('(10 🪙 each)');
  });

  it('nomme la contrepartie : « à » quand on paie, « de » quand on reçoit', () => {
    const paid = formatHistoryLine(
      line({ type: 'gift_out', amount: -50, balanceAfter: 1290, item: null, quantity: null, unitPrice: null, counterpartyName: 'Alice' }),
      fr,
      'fr',
    );
    expect(paid).toContain('Don envoyé');
    expect(paid).toContain('**−50 🪙**');
    expect(paid).toContain(' · à Alice');
    expect(paid).not.toContain('×');

    const received = formatHistoryLine(
      line({ type: 'gift_in', amount: 50, item: null, quantity: null, unitPrice: null, counterpartyName: 'Bob' }),
      fr,
      'fr',
    );
    expect(received).toContain(' · de Bob');

    expect(
      formatHistoryLine(line({ type: 'trade_out', amount: -5, counterpartyName: 'Carol' }), en, 'en'),
    ).toContain(' · to Carol');
    expect(
      formatHistoryLine(line({ type: 'trade_in', amount: 5, counterpartyName: 'Dan' }), en, 'en'),
    ).toContain(' · from Dan');
  });

  it('neutralise le markdown du pseudo de la contrepartie', () => {
    const text = formatHistoryLine(line({ amount: -5, counterpartyName: '*Eve*' }), fr, 'fr');
    expect(text).toContain('\\*Eve\\*');
    expect(text).not.toContain(' *Eve* ');
  });

  it('signale une contrepartie dont le compte a disparu', () => {
    const text = formatHistoryLine(
      line({ type: 'auction_purchase', amount: -80, counterpartyName: null, counterpartyMissing: true }),
      fr,
      'fr',
    );
    expect(text).toContain('un ancien joueur');
  });

  it('affiche les gemmes avec leur propre icône', () => {
    const text = formatHistoryLine(
      line({ type: 'shop_purchase', currency: 'gems', amount: -30, balanceAfter: 5, quantity: 1, unitPrice: 30 }),
      fr,
      'fr',
    );
    expect(text).toContain('**−30 💎**');
    expect(text).toContain('solde 5 💎');
    // Sur une pièce unique, le prix unitaire répète le montant : on le tait.
    expect(text).not.toContain("l'unité");
  });

  it('montre l\'objet sans quantité quand elle n\'est pas renseignée', () => {
    const text = formatHistoryLine(
      line({ type: 'building_purchase', amount: -500, item: { emoji: '🏠', name: 'Grange' }, quantity: null, unitPrice: null }),
      fr,
      'fr',
    );
    expect(text).toContain(' · 🏠 Grange');
    expect(text).not.toContain('×');
  });

  it('signe les montants, sans signe pour zéro', () => {
    expect(formatSignedAmount(120, 'coins', 'en')).toBe('+120 🪙');
    expect(formatSignedAmount(-120, 'coins', 'en')).toBe('−120 🪙');
    expect(formatSignedAmount(0, 'coins', 'en')).toBe('0 🪙');
    expect(formatSignedAmount(-3, 'gems', 'en')).toBe('−3 💎');
  });
});

describe('historique : en-tête', () => {
  it('résume entrées, sorties et net sur la fenêtre', () => {
    const lines = formatHistoryTotals(
      { count: 3, coinsIn: 1200, coinsOut: 800, gemsIn: 0, gemsOut: 0 },
      fr('history.window.7'),
      fr,
      'fr',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('7 derniers jours');
    // Seul le net est en gras : c'est la réponse à « où sont passées mes pièces ? ».
    expect(lines[0]).toContain(`entrées ${formatNumber(1200, 'fr')} 🪙`);
    expect(lines[0]).toContain(`sorties ${formatNumber(800, 'fr')} 🪙`);
    expect(lines[0]).toContain('net **+400 🪙**');
  });

  it('n\'ajoute la ligne des gemmes que si elles ont bougé', () => {
    const lines = formatHistoryTotals(
      { count: 3, coinsIn: 0, coinsOut: 900, gemsIn: 10, gemsOut: 25 },
      en('history.window.30'),
      en,
      'en',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('net **−900 🪙**');
    expect(lines[1]).toContain('net **−15 💎**');
  });
});

describe('historique : pagination', () => {
  it('tient dans les 100 caractères d\'un custom_id, même au pire', () => {
    const longest = [...HISTORY_FAMILY_CHOICES].sort((a, b) => b.length - a.length)[0]!;
    const id = buildCustomId('history', 'page', '9'.repeat(20), 10_000, longest, 90);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id.split(':')).toEqual(['history', 'page', '9'.repeat(20), '10000', longest, '90']);
  });
});

describe('historique : traductions', () => {
  const fragment = (locale: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', locale, 'history.json'), 'utf8'),
    ) as Record<string, unknown>;

  const flatten = (value: unknown, prefix = ''): Array<[string, string]> =>
    typeof value === 'string'
      ? [[prefix, value]]
      : Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !key.startsWith('$'))
          .flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));

  it('livre le même fragment en français et en anglais', () => {
    const frKeys = new Map(flatten(fragment('fr')));
    const enKeys = new Map(flatten(fragment('en')));
    expect([...enKeys.keys()].sort()).toEqual([...frKeys.keys()].sort());

    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
    for (const [key, text] of frKeys) {
      expect({ key, params: placeholders(enKeys.get(key)!) }).toEqual({ key, params: placeholders(text) });
    }
  });

  it('a un libellé pour chaque type, chaque famille et chaque période', () => {
    const keys = new Map(flatten(fragment('fr')));
    for (const type of transactionTypeEnum.enumValues) {
      expect(keys.has(`history.type.${type}`), type).toBe(true);
    }
    for (const family of HISTORY_FAMILY_CHOICES) {
      expect(keys.has(`history.family.${family}`), family).toBe(true);
    }
    for (const days of HISTORY_DAYS) {
      expect(keys.has(`history.window.${days}`), String(days)).toBe(true);
    }
    // Le fragment est bien fusionné dans le catalogue que voit `translate()`.
    expect(en('history.type.tax')).toBe('Tax');
    expect(fr('history.type.tax')).toBe('Taxe');
  });
});
