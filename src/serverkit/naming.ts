import { SUPPORTED_LOCALES, translatorFor, type SupportedLocale } from '../i18n';
import { fancy, slugify, type FancyFont } from '../utils/fancy-text';
import type { CategorySpec, ChannelSpec, RoleSpec } from './blueprint';

/**
 * Fabrique des noms affichés : emoji + cadre + libellé en police fantaisie.
 *
 * RÈGLE D'OR — aucun tiret, nulle part. Discord remplace chaque espace d'un
 * salon textuel par « - » ; un nom de salon textuel sort donc d'ici SANS
 * espace, ses mots soudés par un point médian japonais (`・`), et le tout
 * repasse par `sealTextName` qui retire ce qui pourrait encore devenir un
 * tiret. Vocaux, catégories et rôles gardent leurs espaces : Discord les
 * affiche tels quels.
 */

export const FRAMES = ['dot', 'bracket', 'bar', 'cloud', 'sparkle'] as const;
export type Frame = (typeof FRAMES)[number];

export interface KitStyle {
  locale: SupportedLocale;
  font: FancyFont;
  frame: Frame;
}

export const DEFAULT_FONT: FancyFont = 'bold';
export const DEFAULT_FRAME: Frame = 'dot';

/** Soude les mots d'un salon textuel, là où Discord aurait mis un tiret. */
export const WORD_JOINER = '・';

/** Toute la famille des tirets Unicode, du trait d'union au tiret cadratin. */
const DASHES = /[-\u00ad\u2010-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/g;

interface FrameShape {
  /** Préfixe collé (salon textuel) : aucun espace permis. */
  tight: (emoji: string) => string;
  /** Préfixe aéré (vocal, rôle, catégorie). */
  loose: (emoji: string) => string;
  /** Habillage d'une catégorie ou d'un séparateur de rôles. */
  banner: (label: string) => string;
}

const SHAPES: Record<Frame, FrameShape> = {
  dot: {
    tight: (emoji) => `${emoji}・`,
    loose: (emoji) => `${emoji} ・ `,
    banner: (label) => `⋆ ${label} ⋆`,
  },
  bracket: {
    tight: (emoji) => `「${emoji}」`,
    loose: (emoji) => `「${emoji}」 `,
    banner: (label) => `『 ${label} 』`,
  },
  bar: {
    tight: (emoji) => `${emoji}┃`,
    loose: (emoji) => `${emoji} ┃ `,
    banner: (label) => `┃ ${label} ┃`,
  },
  cloud: {
    tight: (emoji) => `꒰${emoji}꒱`,
    loose: (emoji) => `꒰${emoji}꒱ `,
    banner: (label) => `꒰ ${label} ꒱`,
  },
  sparkle: {
    tight: (emoji) => `${emoji}✧`,
    loose: (emoji) => `✧ ${emoji} `,
    banner: (label) => `✦ ⋆ ${label} ⋆ ✦`,
  },
};

/**
 * Majuscule initiale seulement : le reste de la casse appartient au libellé.
 * « Légende de Greenvale » et « Feu de camp » gardent leurs petits mots en
 * minuscules — capitaliser chaque mot est un usage anglais, pas français.
 */
function capitalize(label: string): string {
  return label.replace(/^\p{L}/u, (letter) => letter.toUpperCase());
}

/** Dernier filet : ni espace ni tiret ne sortent d'un nom de salon textuel. */
export function sealTextName(name: string): string {
  return name.replace(/\s+/g, '').replace(DASHES, '');
}

export function textChannelName(emoji: string, label: string, style: KitStyle): string {
  const words = label.toLowerCase().split(/[\s-]+/).filter(Boolean);
  const body = words.map((word) => fancy(word, style.font)).join(WORD_JOINER);
  return sealTextName(SHAPES[style.frame].tight(emoji) + body);
}

export function voiceChannelName(emoji: string, label: string, style: KitStyle): string {
  return (SHAPES[style.frame].loose(emoji) + fancy(capitalize(label), style.font)).replace(DASHES, ' ');
}

export function categoryName(emoji: string, label: string, style: KitStyle): string {
  // Discord affiche les catégories en capitales par CSS ; les alphabets
  // mathématiques n'ont pas de casse, il faut donc capitaliser AVANT.
  return (SHAPES[style.frame].loose(emoji) + fancy(label.toUpperCase(), style.font)).replace(DASHES, ' ');
}

export function roleName(emoji: string, label: string, style: KitStyle): string {
  const text = fancy(capitalize(label), style.font);
  const name = emoji ? SHAPES[style.frame].loose(emoji) + text : SHAPES[style.frame].banner(text);
  return name.replace(DASHES, ' ');
}

// ---------------------------------------------------------------------------
// Noms rendus d'une entrée du plan
// ---------------------------------------------------------------------------

const isVoice = (channel: ChannelSpec): boolean => channel.kind === 'voice' || channel.kind === 'stage';

export function labelOf(kind: 'roles' | 'categories' | 'channels', key: string, locale: SupportedLocale): string {
  const path = kind === 'channels' ? `serverkit.channels.${key}.name` : `serverkit.${kind}.${key}`;
  return translatorFor(locale)(path);
}

export function renderRole(spec: RoleSpec, style: KitStyle): string {
  return roleName(spec.emoji, labelOf('roles', spec.key, style.locale), style);
}

export function renderCategory(spec: CategorySpec, style: KitStyle): string {
  return categoryName(spec.emoji, labelOf('categories', spec.key, style.locale), style);
}

export function renderChannel(spec: ChannelSpec, style: KitStyle): string {
  const label = labelOf('channels', spec.key, style.locale);
  return isVoice(spec) ? voiceChannelName(spec.emoji, label, style) : textChannelName(spec.emoji, label, style);
}

/**
 * Empreintes d'une entrée, toutes langues confondues. Reconnaître un salon par
 * l'empreinte de son libellé — et non par son nom exact — est ce qui rend le
 * constructeur rejouable : changer de police, de cadre ou de langue retrouve
 * les salons déjà posés au lieu d'en créer des doublons.
 */
export function slugsOf(kind: 'roles' | 'categories' | 'channels', key: string): Set<string> {
  return new Set(SUPPORTED_LOCALES.map((locale) => slugify(labelOf(kind, key, locale))));
}
