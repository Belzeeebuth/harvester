import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbedField,
} from 'discord.js';
import { buildCustomId, PUBLIC_OWNER } from '../utils/custom-id';
import { COIN, GEM, XP, formatCoins, formatNumber, truncate } from '../utils/format';
import { translatorFor, DEFAULT_LOCALE } from '../i18n';
import type { Translator } from '../types';

/**
 * Fabriques d'embeds et de composants.
 *
 * Centraliser ici garantit une identité visuelle homogène (couleurs, pied de
 * page, emoji) et évite que chaque commande réinvente sa mise en page. Les
 * limites de l'API Discord (25 champs, 1024 caractères par champ, 5 composants
 * par rangée, 5 rangées) sont appliquées ICI, pas dans les commandes.
 */

export const COLORS = {
  primary: 0x7ec850,
  success: 0x5cb85c,
  warning: 0xf0ad4e,
  danger: 0xd9534f,
  info: 0x5bc0de,
  gold: 0xffc93c,
  neutral: 0x2b2d31,
  xp: 0x8e7cff,
} as const;

export const FOOTER = 'Harvester 🌾 Greenvale';

export function baseEmbed(options: {
  title?: string;
  description?: string;
  color?: number;
  footer?: string;
  thumbnail?: string;
  image?: string;
  fields?: APIEmbedField[];
}): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(options.color ?? COLORS.primary);
  if (options.title) embed.setTitle(truncate(options.title, 256));
  if (options.description) embed.setDescription(truncate(options.description, 4096));
  if (options.thumbnail) embed.setThumbnail(options.thumbnail);
  if (options.image) embed.setImage(options.image);
  if (options.fields) {
    embed.addFields(
      options.fields.slice(0, 25).map((field) => ({
        name: truncate(field.name, 256),
        value: truncate(field.value || '​', 1024),
        inline: field.inline ?? false,
      })),
    );
  }
  embed.setFooter({ text: options.footer ?? FOOTER });
  return embed;
}

export function successEmbed(title: string, description?: string): EmbedBuilder {
  return baseEmbed({ title, description, color: COLORS.success });
}

export function errorEmbed(title: string, description?: string): EmbedBuilder {
  return baseEmbed({ title, description, color: COLORS.danger });
}

export function warningEmbed(title: string, description?: string): EmbedBuilder {
  return baseEmbed({ title, description, color: COLORS.warning });
}

/** Bloc de récompenses homogène, utilisé après chaque action rémunératrice. */
export function rewardsField(
  rewards: {
    coins?: number;
    gems?: number;
    xp?: number;
    items?: string;
  },
  locale?: string,
  t: Translator = translatorFor(locale ?? DEFAULT_LOCALE),
): APIEmbedField | undefined {
  const parts: string[] = [];
  if (rewards.coins) parts.push(`${formatNumber(rewards.coins, locale)} ${COIN}`);
  if (rewards.gems) parts.push(`${formatNumber(rewards.gems, locale)} ${GEM}`);
  if (rewards.xp) parts.push(`${formatNumber(rewards.xp, locale)} ${XP}`);
  if (rewards.items) parts.push(rewards.items);
  if (parts.length === 0) return undefined;
  return { name: `🎁 ${t('common.rewards_field')}`, value: parts.join(' · '), inline: false };
}

// ---------------------------------------------------------------------------
// Boutons
// ---------------------------------------------------------------------------

export interface ButtonSpec {
  namespace: string;
  action: string;
  ownerId: string;
  params?: Array<string | number | boolean>;
  label?: string;
  emoji?: string;
  style?: ButtonStyle;
  disabled?: boolean;
}

export function button(spec: ButtonSpec): ButtonBuilder {
  const builder = new ButtonBuilder()
    .setCustomId(buildCustomId(spec.namespace, spec.action, spec.ownerId, ...(spec.params ?? [])))
    .setStyle(spec.style ?? ButtonStyle.Secondary)
    .setDisabled(spec.disabled ?? false);
  if (spec.label) builder.setLabel(truncate(spec.label, 80));
  if (spec.emoji) builder.setEmoji(spec.emoji);
  return builder;
}

export function linkButton(label: string, url: string, emoji?: string): ButtonBuilder {
  const builder = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
  if (emoji) builder.setEmoji(emoji);
  return builder;
}

export function row(...components: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...components.slice(0, 5));
}

export function selectRow(
  menu: StringSelectMenuBuilder,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * Rangée de pagination standard.
 * Les boutons sont désactivés aux extrémités plutôt que masqués : la position
 * des contrôles reste stable d'une page à l'autre, ce qui évite les clics ratés.
 */
export function paginationRow(options: {
  namespace: string;
  ownerId: string;
  page: number;
  totalPages: number;
  extraParams?: Array<string | number>;
}): ActionRowBuilder<ButtonBuilder> {
  const { namespace, ownerId, page, totalPages } = options;
  const params = options.extraParams ?? [];
  return row(
    button({
      namespace,
      action: 'page',
      ownerId,
      params: [1, ...params],
      emoji: '⏮️',
      disabled: page <= 1,
    }),
    button({
      namespace,
      action: 'page',
      ownerId,
      params: [Math.max(1, page - 1), ...params],
      emoji: '◀️',
      disabled: page <= 1,
    }),
    button({
      namespace,
      action: 'noop',
      ownerId,
      params: [page],
      label: `${page}/${totalPages}`,
      disabled: true,
    }),
    button({
      namespace,
      action: 'page',
      ownerId,
      params: [Math.min(totalPages, page + 1), ...params],
      emoji: '▶️',
      disabled: page >= totalPages,
    }),
    button({
      namespace,
      action: 'page',
      ownerId,
      params: [totalPages, ...params],
      emoji: '⏭️',
      disabled: page >= totalPages,
    }),
  );
}

/** Rangée de confirmation pour une action destructive ou irréversible. */
export function confirmRow(
  options: {
    namespace: string;
    action: string;
    ownerId: string;
    params?: Array<string | number>;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  },
  locale?: string,
  t: Translator = translatorFor(locale ?? DEFAULT_LOCALE),
): ActionRowBuilder<ButtonBuilder> {
  return row(
    button({
      namespace: options.namespace,
      action: options.action,
      ownerId: options.ownerId,
      params: ['yes', ...(options.params ?? [])],
      label: options.confirmLabel ?? t('common.confirm'),
      emoji: '✅',
      style: options.danger ? ButtonStyle.Danger : ButtonStyle.Success,
    }),
    button({
      namespace: options.namespace,
      action: options.action,
      ownerId: options.ownerId,
      params: ['no', ...(options.params ?? [])],
      label: options.cancelLabel ?? t('common.cancel'),
      emoji: '✖️',
      style: ButtonStyle.Secondary,
    }),
  );
}

/** Raccourcis contextuels affichés sous la plupart des embeds de ferme. */
export function farmShortcutsRow(
  ownerId: string,
  options: {
    canHarvest?: boolean;
    canWater?: boolean;
    canPlant?: boolean;
  } = {},
  locale?: string,
  t: Translator = translatorFor(locale ?? DEFAULT_LOCALE),
): ActionRowBuilder<ButtonBuilder> {
  return row(
    button({
      namespace: 'farm',
      action: 'harvest_all',
      ownerId,
      label: t('common.harvest_all'),
      emoji: '🧺',
      style: ButtonStyle.Success,
      disabled: options.canHarvest === false,
    }),
    button({
      namespace: 'farm',
      action: 'water_all',
      ownerId,
      label: t('common.water_all'),
      emoji: '💧',
      style: ButtonStyle.Primary,
      disabled: options.canWater === false,
    }),
    button({
      namespace: 'farm',
      action: 'plant_menu',
      ownerId,
      label: t('common.plant'),
      emoji: '🌱',
      disabled: options.canPlant === false,
    }),
    button({ namespace: 'farm', action: 'refresh', ownerId, emoji: '🔄' }),
  );
}

export function select(options: {
  namespace: string;
  action: string;
  ownerId: string;
  params?: Array<string | number>;
  placeholder: string;
  choices: Array<{ label: string; value: string; description?: string; emoji?: string; default?: boolean }>;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
}): StringSelectMenuBuilder {
  // Discord exige entre 1 et 25 options, MÊME sur un menu désactivé : une liste
  // de choix vide (rien à acheter, rien à sélectionner) ferait échouer l'appel
  // API entier plutôt que produire un menu simplement grisé. On force donc une
  // option de repli, et le menu à l'état désactivé, dans ce cas précis.
  const hasChoices = options.choices.length > 0;
  const choices = hasChoices
    ? options.choices.slice(0, 25)
    : [{ label: truncate(options.placeholder, 100), value: 'none' }];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      buildCustomId(options.namespace, options.action, options.ownerId, ...(options.params ?? [])),
    )
    .setPlaceholder(truncate(options.placeholder, 150))
    .setMinValues(options.minValues ?? 1)
    .setMaxValues(options.maxValues ?? 1)
    .setDisabled(!hasChoices || (options.disabled ?? false));

  menu.addOptions(
    choices.map((choice) => {
      const builder = new StringSelectMenuOptionBuilder()
        .setLabel(truncate(choice.label, 100))
        .setValue(choice.value)
        .setDefault(choice.default ?? false);
      if (choice.description) builder.setDescription(truncate(choice.description, 100));
      if (choice.emoji) builder.setEmoji(choice.emoji);
      return builder;
    }),
  );

  return menu;
}

/** Modal de saisie d'une quantité personnalisée. */
export function quantityModal(
  options: {
    namespace: string;
    action: string;
    ownerId: string;
    params?: Array<string | number>;
    title: string;
    label?: string;
    placeholder?: string;
  },
  locale?: string,
  t: Translator = translatorFor(locale ?? DEFAULT_LOCALE),
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(
      buildCustomId(options.namespace, options.action, options.ownerId, ...(options.params ?? [])),
    )
    .setTitle(truncate(options.title, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('quantity')
          .setLabel(truncate(options.label ?? t('common.quantity'), 45))
          .setPlaceholder(options.placeholder ?? t('common.quantity_placeholder'))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12),
      ),
    );
}

/** Modal générique à un champ long (description de coop, annonce admin). */
export function textModal(options: {
  namespace: string;
  action: string;
  ownerId: string;
  params?: Array<string | number>;
  title: string;
  fieldId: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  paragraph?: boolean;
  required?: boolean;
}): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(
      buildCustomId(options.namespace, options.action, options.ownerId, ...(options.params ?? [])),
    )
    .setTitle(truncate(options.title, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(options.fieldId)
          .setLabel(truncate(options.label, 45))
          .setPlaceholder(options.placeholder ?? '')
          .setStyle(options.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(options.required ?? true)
          .setMaxLength(options.maxLength ?? 200),
      ),
    );
}

/** Désactive tous les composants d'un message (expiration d'un collecteur). */
export function disableAll(
  rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[],
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  for (const actionRow of rows) {
    for (const component of actionRow.components) {
      if ('setDisabled' in component) component.setDisabled(true);
    }
  }
  return rows;
}

/**
 * Raccourcis proposés automatiquement sur les erreurs (`suggestedCommand`).
 *
 * ⚠ Deux règles, chacune apprise d'un bug :
 *  1. Les clés doivent correspondre EXACTEMENT aux valeurs `suggestedCommand`
 *     des erreurs (src/utils/errors.ts). Elles étaient restées en français après
 *     le renommage des commandes : la table ne matchait plus rien et le bouton
 *     de suggestion disparaissait silencieusement.
 *  2. Le couple (`namespace`, `action`) doit correspondre à un gestionnaire
 *     réellement enregistré dans src/components, sinon le bouton s'affiche mais
 *     le clic répond « ce composant a expiré ». C'était le cas de l'ancienne
 *     entrée `event` (`world:event`) : aucun namespace `world` n'existe. Elle
 *     est retirée — mieux vaut pas de bouton qu'un bouton mort — et la table est
 *     exportée pour que les tests croisent chaque entrée avec le registre.
 */
export const SUGGESTIONS: Record<
  string,
  { labelKey: string; emoji: string; namespace: string; action: string }
> = {
  shop: { labelKey: 'suggestion.shop', emoji: '🏪', namespace: 'shop', action: 'open' },
  farm: { labelKey: 'suggestion.farm', emoji: '🌾', namespace: 'farm', action: 'refresh' },
  inventory: { labelKey: 'suggestion.inventory', emoji: '🎒', namespace: 'inv', action: 'open' },
  buildings: { labelKey: 'suggestion.buildings', emoji: '🏗️', namespace: 'build', action: 'open' },
  quests: { labelKey: 'suggestion.quests', emoji: '📋', namespace: 'quest', action: 'open' },
  production: { labelKey: 'suggestion.production', emoji: '🛠️', namespace: 'craft', action: 'queue' },
  animals: { labelKey: 'suggestion.animals', emoji: '🐄', namespace: 'animal', action: 'open' },
  'buy-plot': { labelKey: 'suggestion.buy_plot', emoji: '🗺️', namespace: 'farm', action: 'buy_plot' },
  coop: { labelKey: 'suggestion.coop', emoji: '🤝', namespace: 'coop', action: 'open' },
};

/** Bouton « boutique » proposé automatiquement sur les erreurs de fonds. */
export function suggestionRow(
  command: string,
  ownerId = PUBLIC_OWNER,
  locale?: string,
  t: Translator = translatorFor(locale ?? DEFAULT_LOCALE),
): ActionRowBuilder<ButtonBuilder> | undefined {
  const suggestion = SUGGESTIONS[command];
  if (!suggestion) return undefined;
  return row(
    button({
      namespace: suggestion.namespace,
      action: suggestion.action,
      ownerId,
      label: t(suggestion.labelKey),
      emoji: suggestion.emoji,
      style: ButtonStyle.Primary,
    }),
  );
}

export { formatCoins };
