import { describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig, harvestKeyOf, localizeRow, seedKeyOf } from '../src/config';
import { cumulativePlotCost } from '../src/game/grid';
import { xpTable } from '../src/game/xp';
import {
  buildCustomId,
  CUSTOM_ID_MAX_LENGTH,
  isOwner,
  parseCustomId,
  PUBLIC_OWNER,
} from '../src/utils/custom-id';
import { formatDuration, formatNumber, progressBar, truncate } from '../src/utils/format';
import { isUuid, referralCode, uuidTimestamp, uuidv7 } from '../src/utils/uuid';
import {
  currentWeekStart,
  dailyCycleKey,
  isWeekend,
  nextMidnight,
  weeklyCycleKey,
} from '../src/utils/time';
import { loadMergedCatalog } from '../src/i18n';
// Import STATIQUE de chaque module de commandes. Le registre les charge en
// production par `require` dynamique sur le système de fichiers, ce que le
// résolveur de vitest ne sait pas suivre ; ici l'objectif est de contrôler les
// payloads, pas le chargeur.
import * as accountModule from '../src/commands/account';
import * as adminModule from '../src/commands/admin';
import * as alertsModule from '../src/commands/alerts';
import * as almanacModule from '../src/commands/almanac';
import * as animalsModule from '../src/commands/animals';
import * as collectionModule from '../src/commands/collection';
import * as contextMenusModule from '../src/commands/context-menus';
import * as craftModule from '../src/commands/craft';
import * as economyModule from '../src/commands/economy';
import * as farmModule from '../src/commands/farm';
import * as historyModule from '../src/commands/history';
import * as languageModule from '../src/commands/language';
import * as postcardModule from '../src/commands/postcard';
import * as profileModule from '../src/commands/profile';
import * as progressionModule from '../src/commands/progression';
import * as serverModule from '../src/commands/server';
import * as serverkitModule from '../src/commands/serverkit';
import * as socialModule from '../src/commands/social';
import * as startModule from '../src/commands/start';
import * as tradeModule from '../src/commands/trade';
import * as worldModule from '../src/commands/world';

const config = getConfig();
const balance = getBalance();

/**
 * Ces tests transforment le document d'équilibrage en CONTRAT exécutable.
 * Un game designer qui déséquilibre `crops.json` casse la CI, pas seulement la
 * documentation — c'est tout l'intérêt de dériver le contenu de fichiers.
 */

describe('intégrité de la configuration', () => {
  it('livre le contenu annoncé au cahier des charges', () => {
    expect(config.cropList.length).toBeGreaterThanOrEqual(25);
    expect(config.animalList.length).toBeGreaterThanOrEqual(12);
    expect(config.recipeList.length).toBeGreaterThanOrEqual(20);
    expect(config.buildingList.length).toBeGreaterThanOrEqual(10);
    expect(config.questList.length).toBeGreaterThanOrEqual(30);
    expect(config.achievementList.length).toBeGreaterThanOrEqual(20);
  });

  it('dérive une graine et une récolte par culture', () => {
    for (const crop of config.cropList) {
      const seed = config.items.get(seedKeyOf(crop.key));
      const harvest = config.items.get(harvestKeyOf(crop.key));
      expect(seed, `graine manquante pour ${crop.key}`).toBeDefined();
      expect(harvest, `récolte manquante pour ${crop.key}`).toBeDefined();
      expect(seed!.category).toBe('seed');
      expect(harvest!.category).toBe('harvest');
      expect(harvest!.marketTracked).toBe(true);
    }
  });

  it('rend la revente de graines toujours perdante', () => {
    for (const crop of config.cropList) {
      const seed = config.items.get(seedKeyOf(crop.key))!;
      expect(seed.sellPrice).toBeLessThan(seed.basePrice);
    }
  });

  it('référence des objets, bâtiments et animaux existants', () => {
    for (const recipe of config.recipeList) {
      expect(config.buildings.has(recipe.buildingKey)).toBe(true);
      expect(config.items.has(recipe.outputItemKey)).toBe(true);
      for (const ingredient of recipe.ingredients) {
        expect(config.items.has(ingredient.itemKey), `ingrédient ${ingredient.itemKey}`).toBe(true);
      }
    }
    for (const animal of config.animalList) {
      expect(config.buildings.has(animal.buildingKey)).toBe(true);
      expect(config.items.has(animal.productItemKey)).toBe(true);
      expect(config.items.has(animal.feedItemKey)).toBe(true);
    }
  });

  it('n\'a aucune clé dupliquée', () => {
    const keys = [
      ...config.cropList.map((entry) => `crop:${entry.key}`),
      ...config.animalList.map((entry) => `animal:${entry.key}`),
      ...config.itemList.map((entry) => `item:${entry.key}`),
      ...config.recipeList.map((entry) => `recipe:${entry.key}`),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('équilibrage des cultures', () => {
  it('reste rentable pour toutes les cultures', () => {
    for (const crop of config.cropList) {
      const cycles = 1 + crop.regrowCycles;
      const gross = crop.sellPrice * crop.baseYield * cycles;
      expect(gross, `${crop.key} n'est pas rentable`).toBeGreaterThan(crop.seedPrice);
    }
  });

  it('fait croître le revenu horaire avec le niveau requis', () => {
    const byLevel = [...config.cropList].sort((a, b) => a.requiredLevel - b.requiredLevel);
    const perHour = byLevel.map((crop) => {
      const cycles = 1 + crop.regrowCycles;
      const totalSeconds = crop.growthSeconds + crop.regrowCycles * crop.regrowSeconds;
      return ((crop.sellPrice * crop.baseYield * cycles - crop.seedPrice) / totalSeconds) * 3_600;
    });

    // La progression n'est pas strictement monotone (les cultures repousseuses
    // sortent du lot), mais la moyenne du dernier tiers doit dépasser largement
    // celle du premier : sans cela, monter en niveau n'apporterait rien.
    const third = Math.floor(perHour.length / 3);
    const early = perHour.slice(0, third).reduce((sum, value) => sum + value, 0) / third;
    const late = perHour.slice(-third).reduce((sum, value) => sum + value, 0) / third;
    expect(late).toBeGreaterThan(early * 5);
  });

  it('n\'a aucune culture au rendement horaire aberrant pour son niveau', () => {
    for (const crop of config.cropList) {
      const cycles = 1 + crop.regrowCycles;
      const totalSeconds = crop.growthSeconds + crop.regrowCycles * crop.regrowSeconds;
      const perHour = ((crop.sellPrice * crop.baseYield * cycles - crop.seedPrice) / totalSeconds) * 3_600;
      // Plafond souple : 90 × le niveau requis. Au-delà, une culture de bas
      // niveau rendrait tout le reste du jeu inutile.
      expect(perHour, `${crop.key} rapporte trop pour son niveau`).toBeLessThan(
        90 * crop.requiredLevel + 400,
      );
    }
  });

  it('propose au moins une culture par saison', () => {
    for (const season of ['spring', 'summer', 'autumn', 'winter']) {
      const available = config.cropList.filter((crop) => crop.seasons.includes(season as never));
      expect(available.length, `aucune culture en ${season}`).toBeGreaterThan(0);
    }
  });

  it('exige un niveau accessible pour toutes les cultures', () => {
    for (const crop of config.cropList) {
      expect(crop.requiredLevel).toBeLessThanOrEqual(balance.progression.maxLevel);
    }
  });
});

describe('équilibrage de la transformation', () => {
  it('crée toujours de la valeur, sans excès', () => {
    for (const recipe of config.recipeList) {
      const output = config.items.get(recipe.outputItemKey)!;
      // Les recettes produisant un objet non vendable (compost) sont exclues :
      // leur valeur est fonctionnelle, pas marchande.
      if (!output.sellable || output.sellPrice === 0) continue;

      const inputValue = recipe.ingredients.reduce((sum, ingredient) => {
        const item = config.items.get(ingredient.itemKey)!;
        return sum + item.sellPrice * ingredient.quantity;
      }, 0);
      const outputValue = output.sellPrice * recipe.outputQuantity;
      const margin = outputValue / Math.max(1, inputValue);

      expect(margin, `${recipe.key} : marge de ${margin.toFixed(2)}`).toBeGreaterThan(1.2);
      expect(margin, `${recipe.key} : marge de ${margin.toFixed(2)}`).toBeLessThan(2.4);
    }
  });

  it('ne crée pas de boucle infinie de fabrication', () => {
    for (const recipe of config.recipeList) {
      const ingredientKeys = recipe.ingredients.map((ingredient) => ingredient.itemKey);
      expect(ingredientKeys).not.toContain(recipe.outputItemKey);
    }
  });
});

describe('équilibrage des animaux', () => {
  it('amortit chaque animal en un temps raisonnable', () => {
    for (const animal of config.animalList) {
      const product = config.items.get(animal.productItemKey)!;
      const feed = config.items.get(animal.feedItemKey)!;
      const cycleHours = animal.productionSeconds / 3_600;
      const revenue = (product.sellPrice * animal.productQuantity) / cycleHours;
      const cost = (feed.basePrice * animal.feedPerCycle) / cycleHours;
      const net = revenue - cost;
      const price = animal.price > 0 ? animal.price : animal.priceGems * 250;

      expect(net, `${animal.key} n'est pas rentable`).toBeGreaterThan(0);
      const payback = price / net;
      // Entre 5 h (sinon trivial) et 48 h (sinon décourageant) de production.
      expect(payback, `${animal.key} s'amortit en ${payback.toFixed(1)} h`).toBeGreaterThan(5);
      expect(payback, `${animal.key} s'amortit en ${payback.toFixed(1)} h`).toBeLessThan(48);
    }
  });
});

describe('équilibrage de la progression', () => {
  it('mène au niveau maximum en un temps de jeu cohérent', () => {
    const table = xpTable(balance);
    const total = table.at(-1)!.cumulative;
    // Cible : 400 000 à 1 200 000 XP pour le niveau maximum, soit plusieurs mois
    // de jeu régulier avant le prestige.
    expect(total).toBeGreaterThan(400_000);
    expect(total).toBeLessThan(1_200_000);
  });

  it('garde les récompenses de palier marginales face aux revenus de récolte', () => {
    const table = xpTable(balance);
    const totalLevelRewards = table.reduce((sum, row) => sum + row.rewardCoins, 0);
    const fullGridCost = cumulativePlotCost(
      balance.plots.startingUnlocked,
      balance.plots.maxPlots,
      balance,
    );
    // Les récompenses de niveau ne doivent pas financer l'extension : elles
    // représentent un coup de pouce, pas la source principale de revenus.
    expect(totalLevelRewards).toBeLessThan(fullGridCost * 0.2);
  });

  it('rend l\'extension complète coûteuse mais atteignable', () => {
    const total = cumulativePlotCost(
      balance.plots.startingUnlocked,
      balance.plots.maxPlots,
      balance,
    );
    expect(total).toBeGreaterThan(1_000_000);
    expect(total).toBeLessThan(60_000_000);
  });

  it('conserve des puits monétaires actifs', () => {
    expect(balance.economy.salesTaxRate).toBeGreaterThan(0);
    expect(balance.auction.commissionRate).toBeGreaterThan(0);
    expect(balance.economy.sellDirectPenalty).toBeGreaterThan(0);
    expect(balance.economy.giftTaxRate).toBeGreaterThan(0);
  });
});

describe('custom_id', () => {
  it('fait un aller-retour fidèle', () => {
    const id = buildCustomId('farm', 'harvest', '123456789012345678', 12, 'wheat');
    const parsed = parseCustomId(id);
    expect(parsed.namespace).toBe('farm');
    expect(parsed.action).toBe('harvest');
    expect(parsed.ownerId).toBe('123456789012345678');
    expect(parsed.params).toEqual(['12', 'wheat']);
  });

  it('refuse les caractères qui casseraient le format', () => {
    expect(() => buildCustomId('farm', 'harvest', '1', 'a:b')).toThrow();
    expect(() => buildCustomId('farm', 'harvest', '1', 'espace interdit')).toThrow();
  });

  it('refuse un identifiant trop long pour Discord', () => {
    expect(() => buildCustomId('farm', 'harvest', '123456789012345678', 'x'.repeat(120))).toThrow();
    expect(buildCustomId('a', 'b', '1').length).toBeLessThan(CUSTOM_ID_MAX_LENGTH);
  });

  it('protège le propriétaire du composant', () => {
    const parsed = parseCustomId(buildCustomId('farm', 'harvest', '111'));
    expect(isOwner(parsed, '111')).toBe(true);
    expect(isOwner(parsed, '222')).toBe(false);
  });

  it('autorise tout le monde sur un composant public', () => {
    const parsed = parseCustomId(buildCustomId('help', 'page', PUBLIC_OWNER, 2));
    expect(isOwner(parsed, "n'importe qui")).toBe(true);
  });

  it('rejette un identifiant malformé', () => {
    expect(() => parseCustomId('incomplet')).toThrow();
  });
});

describe('utilitaires', () => {
  it('génère des UUID v7 croissants et horodatés', () => {
    // 5 000 identifiants d'affilée : la boucle tient dans quelques
    // millisecondes, donc la plupart partagent leur horodatage. C'est
    // précisément le cas qui compte — comparer deux appels ne prouvait rien,
    // puisqu'ils tombaient le plus souvent dans des millisecondes différentes.
    const ids = Array.from({ length: 5_000 }, () => uuidv7());

    for (const id of ids) expect(isUuid(id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]! > ids[index - 1]!).toBe(true);
    }

    const timestamp = uuidTimestamp(ids[0]!);
    expect(timestamp).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - timestamp!.getTime())).toBeLessThan(5_000);
  });

  it('génère des codes de parrainage sans caractères ambigus', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(referralCode(8)).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    }
  });

  it('formate durées et nombres en français', () => {
    expect(formatDuration(0)).toBe('< 1 s');
    expect(formatDuration(90_000)).toBe('1 min 30 s');
    expect(formatDuration(3_600_000 * 26)).toContain('j');
    expect(formatNumber(1234567)).toMatch(/1.234.567/);
  });

  it('dessine une barre de progression bornée', () => {
    expect(progressBar(0, 10, 10)).toBe('▱'.repeat(10));
    expect(progressBar(10, 10, 10)).toBe('▰'.repeat(10));
    expect(progressBar(20, 10, 10)).toBe('▰'.repeat(10));
    expect(progressBar(5, 0, 10)).toBe('▰'.repeat(10));
  });

  it('tronque sans dépasser la limite', () => {
    expect(truncate('abcdef', 4)).toHaveLength(4);
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('calcule des clés de cycle stables', () => {
    const date = new Date('2026-07-26T22:30:00Z');
    expect(dailyCycleKey(date, 'UTC')).toBe('2026-07-26');
    expect(weeklyCycleKey(date, 'UTC')).toMatch(/^2026-W\d{2}$/);
    expect(currentWeekStart(date, 'UTC')).toBe('2026-07-20');
    expect(nextMidnight(date, 'UTC').toISOString()).toBe('2026-07-27T00:00:00.000Z');
  });

  it('détecte le week-end', () => {
    expect(isWeekend(new Date('2026-07-25T12:00:00Z'), 'UTC')).toBe(true); // samedi
    expect(isWeekend(new Date('2026-07-22T12:00:00Z'), 'UTC')).toBe(false); // mercredi
  });
});

describe('internationalisation', () => {
  // Catalogues FUSIONNÉS (fichier principal + fragments `locales/<langue>/*.json`) :
  // la parité doit tenir sur ce que `translate()` voit réellement.
  const frCatalog = loadMergedCatalog('fr');
  const enCatalog = loadMergedCatalog('en');

  /**
   * Les deux catalogues doivent porter EXACTEMENT les mêmes clés.
   *
   * Une clé absente de `en.json` ne casse rien visiblement : `translate()`
   * retombe sur le français. C'est précisément le problème — le bot paraît
   * traduit, et affiche du français à un anglophone sans qu'aucune erreur ne le
   * signale. Ce test transforme ce silence en échec de CI.
   */
  // Les clés `$…` sont des métadonnées du fichier (commentaire d'en-tête), pas
  // des chaînes traduisibles : le moteur de traduction ne les lit jamais.
  const isMeta = (key: string): boolean => key.startsWith('$');

  const flatten = (value: unknown, prefix = ''): string[] =>
    typeof value === 'string'
      ? [prefix]
      : Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !isMeta(key))
          .flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));

  it('les catalogues fr et en ont les mêmes clés', () => {
    const fr = flatten(frCatalog).sort();
    const en = flatten(enCatalog).sort();

    expect(fr.filter((key) => !en.includes(key))).toEqual([]);
    expect(en.filter((key) => !fr.includes(key))).toEqual([]);
    expect(fr.length).toBeGreaterThan(200);
  });

  it('les paramètres {nom} sont identiques dans les deux langues', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

    const walk = (a: unknown, b: unknown, path = ''): void => {
      if (typeof a === 'string' && typeof b === 'string') {
        expect({ path, params: placeholders(b) }).toEqual({ path, params: placeholders(a) });
        return;
      }
      for (const [key, child] of Object.entries(a as Record<string, unknown>)) {
        if (key.startsWith('$')) continue;
        walk(child, (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      }
    };

    walk(frCatalog, enCatalog);
  });
});

describe('commandes Discord', () => {
  /**
   * Ce test sérialise les commandes EXACTEMENT comme elles partent vers l'API
   * Discord, puis contrôle deux choses que le typage ne peut pas garantir :
   * les limites de l'API, et l'absence de français résiduel.
   *
   * Contrôler le payload plutôt que le code source n'est pas un détail : les
   * catégories d'aide sont construites dynamiquement depuis `CATEGORY_LABELS`,
   * donc invisibles à toute recherche de littéral dans `src/commands/`. C'est
   * précisément par là que trois libellés français étaient passés.
   */
  const modules: Array<Record<string, unknown>> = [
    accountModule, adminModule, alertsModule, almanacModule, animalsModule,
    collectionModule, contextMenusModule, craftModule, economyModule, farmModule,
    historyModule, languageModule, postcardModule, profileModule, progressionModule,
    serverModule, serverkitModule, socialModule, startModule, tradeModule, worldModule,
  ] as Array<Record<string, unknown>>;

  const payloads = modules.flatMap((module) => [
    ...((module.commands ?? []) as Array<{ data: { name: string } }>),
    ...((module.contextMenus ?? []) as Array<{ data: { name: string } }>),
  ].map((entry) => entry.data));

  const walk = (node: unknown, path: string, visit: (n: never, p: string) => void): void => {
    const value = node as { name?: string; options?: unknown[] };
    visit(node as never, path);
    for (const option of value.options ?? []) {
      visit(option as never, `${path} ${(option as { name?: string }).name ?? '?'}`);
      walk(option, `${path} ${(option as { name?: string }).name ?? '?'}`, visit);
    }
  };

  it('respecte les limites de nommage de l\'API Discord', () => {
    const problems: string[] = [];
    for (const payload of payloads) {
      // type 2/3 = menus contextuels : ils acceptent espaces et majuscules.
      const isContextMenu = (payload as { type?: number }).type === 2
        || (payload as { type?: number }).type === 3;
      if (!isContextMenu && !/^[-_a-z0-9]{1,32}$/u.test(payload.name)) {
        problems.push(`nom invalide : ${payload.name}`);
      }
      walk(payload, `/${payload.name}`, (node, path) => {
        const description = (node as { description?: string }).description;
        if (description !== undefined && (description.length < 1 || description.length > 100)) {
          problems.push(`${path} : description de ${description.length} caractères`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it('n\'expose plus aucune chaîne française', () => {
    const FRENCH = /[éèêàùôûçÉÈÀîïœ]|\b(le|la|les|des|une|vos|votre|pour|avec|dans|par)\b/;
    // Le sélecteur de langue affiche chaque langue DANS sa propre langue :
    // « Français » y est correct, pas un oubli de traduction.
    const languagePicker = new Set(['fr', 'en']);
    const problems: string[] = [];

    for (const payload of payloads) {
      walk(payload, `/${payload.name}`, (node, path) => {
        const typed = node as { description?: string; choices?: Array<{ name: string; value: unknown }> };
        if (typed.description && FRENCH.test(typed.description)) {
          problems.push(`${path} description : ${typed.description}`);
        }
        for (const choice of typed.choices ?? []) {
          if (FRENCH.test(String(choice.name)) && !languagePicker.has(String(choice.value))) {
            problems.push(`${path} choix : ${choice.name}`);
          }
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it('charge les 62 commandes sans doublon', () => {
    const names = payloads.map((payload) => payload.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(60);
  });
});

describe('contenu bilingue', () => {
  /**
   * Chaque entrée de contenu doit porter sa traduction anglaise.
   *
   * Le champ `*En` est OPTIONNEL au niveau du schéma — pour qu'ajouter du
   * contenu ne bloque pas le démarrage sur une traduction manquante — mais il
   * est OBLIGATOIRE ici : sans ce test, une entrée non traduite retomberait
   * silencieusement en français chez un joueur anglophone, exactement le
   * problème que la version bilingue est censée résoudre.
   */
  const localized = getConfig('en');

  const groups: Array<[string, Array<Record<string, unknown>>, 'name' | 'title']> = [
    ['crops', config.cropList, 'name'],
    ['animals', config.animalList, 'name'],
    ['items', config.itemList, 'name'],
    ['recipes', config.recipeList, 'name'],
    ['buildings', config.buildingList, 'name'],
    ['quests', config.questList, 'title'],
    ['achievements', config.achievementList, 'name'],
    ['events', config.eventList, 'name'],
  ];


  /**
   * Les dépôts joignent les tables `*_config` pour trier, et en profitent pour
   * rapatrier `name`. Or ces colonnes sont peuplées par le seed depuis la
   * version FRANÇAISE : sans `localizeRow`, une ligne lue en base affiche
   * « Blé » à un joueur anglophone en contournant `getConfig(locale)`.
   */
  describe('localizeRow', () => {
    it('traduit un libellé venant d\'une jointure SQL', () => {
      const row = { itemKey: 'wheat', name: 'Blé', quantity: 3 };
      expect(localizeRow(row, 'en').name).toBe('Wheat');
      expect(localizeRow(row, 'en').quantity).toBe(3);
    });

    it('laisse le français intact hors locale anglaise', () => {
      const row = { itemKey: 'wheat', name: 'Blé' };
      expect(localizeRow(row, 'fr').name).toBe('Blé');
    });

    /**
     * Une ligne de cheptel porte `animalKey` ET `buildingKey` : son `name` est
     * celui de l'ANIMAL. Une boucle naïve sur les clés écraserait « Hen » par
     * le nom du bâtiment, ce qui afficherait le poulailler à la place de la poule.
     */
    it('résout `name` sur l\'entité principale, pas sur la clé secondaire', () => {
      const animal = localized.animalList[0];
      if (!animal) throw new Error('configuration sans animal');
      const row = {
        animalKey: animal.key,
        buildingKey: animal.buildingKey,
        name: 'Poule',
      };
      expect(localizeRow(row, 'en').name).toBe(animal.name);
      expect(localizeRow(row, 'en').name).not.toBe(
        localized.buildings.get(animal.buildingKey)?.name,
      );
    });

    it('rattache `buildingName` au bâtiment même si la ligne porte un itemKey', () => {
      const building = localized.buildingList[0];
      if (!building) throw new Error('configuration sans bâtiment');
      const row = { itemKey: 'wheat', buildingKey: building.key, buildingName: 'Moulin' };
      expect(localizeRow(row, 'en').buildingName).toBe(building.name);
    });

    it('ne touche pas une ligne sans clé de configuration', () => {
      const row = { name: 'Ma coopérative' };
      expect(localizeRow(row, 'en').name).toBe('Ma coopérative');
    });
  });

  it('traduit toutes les entrées de contenu', () => {
    const missing: string[] = [];
    for (const [group, list, field] of groups) {
      for (const entry of list) {
        if (typeof entry[`${field}En`] !== 'string' || !(entry[`${field}En`] as string)) {
          missing.push(`${group}.${String(entry.key)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("n'expose plus de français dans la variante anglaise", () => {
    const FRENCH = /[éèêàùôûçÉÈÀîï]/;
    const problems: string[] = [];
    const lists: Array<[string, Array<Record<string, unknown>>]> = [
      ['crops', localized.cropList],
      ['animals', localized.animalList],
      ['items', localized.itemList],
      ['recipes', localized.recipeList],
      ['buildings', localized.buildingList],
      ['quests', localized.questList],
      ['achievements', localized.achievementList],
      ['events', localized.eventList],
    ];
    for (const [group, list] of lists) {
      for (const entry of list) {
        for (const field of ['name', 'title', 'description'] as const) {
          const value = entry[field];
          if (typeof value === 'string' && FRENCH.test(value)) {
            problems.push(`${group}.${String(entry.key)}.${field}: ${value}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('laisse la variante française intacte', () => {
    expect(getConfig('fr').crops.get('wheat')?.name).toBe('Blé');
    expect(getConfig().crops.get('wheat')?.name).toBe('Blé');
    expect(localized.crops.get('wheat')?.name).toBe('Wheat');
  });
});
