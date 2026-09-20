import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import { commandDescription, commandTexts, localizeCommand } from '../src/i18n/commands';

/**
 * Textes français des commandes slash (`src/i18n/locales/commands.fr.json`).
 *
 * Une commande ajoutée sans son texte français ne casse rien de visible :
 * Discord retombe sur l'anglais, et un joueur francophone lit une aide à moitié
 * traduite. Ce test transforme cet oubli en échec de build, comme la règle de
 * parité fr/en le fait pour les catalogues de textes.
 */

/** Outils du propriétaire du bot : jamais vus par un joueur, laissés en anglais. */
const OWNER_ONLY = new Set(['serverkit']);

const french = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(join(__dirname, '../src/i18n/locales/commands.fr.json'), 'utf8'),
    ) as Record<string, string>,
  ).filter(([key]) => !key.startsWith('$')),
);

let payloads: RESTPostAPIApplicationCommandsJSONBody[];
let english: Record<string, string>;

beforeAll(async () => {
  // Chaque fichier de `src/commands` est importé directement : le registre les
  // charge par `require` dynamique, que le résolveur de vitest ne suit pas. Lire
  // le dossier plutôt qu'une liste garantit qu'une commande neuve est couverte.
  const commandsDir = join(__dirname, '../src/commands');
  payloads = [];
  for (const file of readdirSync(commandsDir).filter((name) => name.endsWith('.ts'))) {
    const module = (await import(join(commandsDir, file))) as Record<string, unknown>;
    const entries = [module.command, module.contextMenu, module.commands, module.contextMenus]
      .flat()
      .filter(Boolean) as Array<{ data: RESTPostAPIApplicationCommandsJSONBody }>;
    // Même greffe que `loadCommands()` dans le registre.
    payloads.push(...entries.map((entry) => localizeCommand(entry.data)));
  }
  english = Object.fromEntries(
    payloads
      .filter((payload) => !OWNER_ONLY.has(payload.name))
      .flatMap((payload) => Object.entries(commandTexts(payload))),
  );
}, 60_000);

describe('textes français des commandes', () => {
  it('couvre chaque description, option et choix vus par un joueur', () => {
    expect(Object.keys(english).filter((key) => !(key in french))).toEqual([]);
  });

  it("ne garde aucune entrée pour une commande ou une option qui n'existe plus", () => {
    expect(Object.keys(french).filter((key) => !(key in english))).toEqual([]);
  });

  it('respecte les limites de Discord et les règles de rédaction', () => {
    const offenders = Object.entries(french).filter(
      ([, text]) => text.trim().length === 0 || [...text].length > 100 || /[\u2012-\u2015]/u.test(text),
    );
    expect(offenders).toEqual([]);
  });

  it('greffe le français sur le corps envoyé à Discord', () => {
    const shop = payloads.find((payload) => payload.name === 'shop') as unknown as {
      description_localizations?: Record<string, string>;
      options: Array<{
        description_localizations?: Record<string, string>;
        choices: Array<{ value: string; name_localizations?: Record<string, string> }>;
      }>;
    };
    expect(shop.description_localizations?.fr).toBe(french['shop#description']);
    expect(shop.options[0]?.description_localizations?.fr).toBe(french['shop/category#description']);
    expect(shop.options[0]?.choices.find((choice) => choice.value === 'daily')?.name_localizations?.fr).toBe(
      french['shop/category#choice:daily'],
    );
  });

  it("sert la description dans la langue du joueur, l'anglais à défaut", () => {
    const payload = localizeCommand(
      { name: 'demo', description: 'A demo command' },
      { 'demo#description': 'Une commande de démonstration' },
    );
    expect(commandDescription(payload, 'fr')).toBe('Une commande de démonstration');
    expect(commandDescription(payload, 'en')).toBe('A demo command');
  });
});
