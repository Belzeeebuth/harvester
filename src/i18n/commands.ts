import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('i18n');

/**
 * Textes français des commandes slash.
 *
 * Les commandes sont déclarées en anglais dans le code : c'est le texte par
 * défaut que Discord exige. Ce module leur greffe la version française que
 * Discord affiche aux clients réglés en français (`description_localizations`
 * pour les commandes, groupes, sous-commandes et options, `name_localizations`
 * pour les choix), et que `/help` reprend pour les joueurs à qui le bot parle
 * français. Sans lui, un joueur francophone lisait des descriptions anglaises
 * dans le sélecteur de commandes et dans l'aide.
 *
 * `locales/commands.fr.json` est une table plate `chemin → texte` :
 *   `shop#description`             description de `/shop`
 *   `shop/category#description`    description de son option `category`
 *   `shop/category#choice:daily`   nom affiché du choix `daily`
 * Les chemins plus profonds suivent groupe, sous-commande puis option.
 *
 * Les NOMS de commandes et d'options restent anglais : les localiser changerait
 * ce que le joueur tape, et les textes du jeu citent partout `/plant`, `/sell`.
 */

/** Code de langue Discord ; c'est aussi celui du bot (`SUPPORTED_LOCALES`). */
const FRENCH = 'fr';

type Texts = Record<string, string>;

/** Nœud générique d'un corps de commande : commande, groupe, sous-commande ou option. */
interface CommandNode {
  name: string;
  description?: string;
  description_localizations?: Record<string, string | null> | null;
  options?: CommandNode[];
  choices?: Array<{
    name: string;
    value: string | number;
    name_localizations?: Record<string, string | null> | null;
  }>;
}

let cached: Texts | undefined;

function frenchTexts(): Texts {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, 'locales', 'commands.fr.json'), 'utf8')) as Texts;
    cached = Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('$')));
  } catch (error) {
    // Des commandes en anglais valent mieux qu'un bot qui ne démarre pas.
    log.warn({ err: error }, 'textes français des commandes introuvables');
    cached = {};
  }
  return cached;
}

/** Chemin → texte anglais, pour tout ce qu'un joueur lit dans une commande. */
export function commandTexts(payload: RESTPostAPIApplicationCommandsJSONBody): Texts {
  const out: Texts = {};
  const walk = (node: CommandNode, path: string): void => {
    if (node.description) out[`${path}#description`] = node.description;
    for (const choice of node.choices ?? []) out[`${path}#choice:${choice.value}`] = choice.name;
    for (const option of node.options ?? []) walk(option, `${path}/${option.name}`);
  };
  walk(payload, payload.name);
  return out;
}

/**
 * Greffe les textes français sur un corps de commande, en place. Un texte absent
 * du catalogue laisse simplement l'anglais : Discord retombe dessus tout seul.
 */
export function localizeCommand<T extends RESTPostAPIApplicationCommandsJSONBody>(
  payload: T,
  texts: Texts = frenchTexts(),
): T {
  const walk = (node: CommandNode, path: string): void => {
    const description = texts[`${path}#description`];
    if (node.description && description) {
      node.description_localizations = { ...node.description_localizations, [FRENCH]: description };
    }
    for (const choice of node.choices ?? []) {
      const name = texts[`${path}#choice:${choice.value}`];
      if (name) choice.name_localizations = { ...choice.name_localizations, [FRENCH]: name };
    }
    for (const option of node.options ?? []) walk(option, `${path}/${option.name}`);
  };
  walk(payload, payload.name);
  return payload;
}

/** Description d'une commande dans la langue du joueur, l'anglais à défaut. */
export function commandDescription(payload: RESTPostAPIApplicationCommandsJSONBody, locale: string): string {
  const node = payload as CommandNode;
  return node.description_localizations?.[locale] ?? node.description ?? '';
}
