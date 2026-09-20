import { ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { CATEGORY_LABELS, type Command, type CommandCategory, type Translator } from '../types';
import { COLORS, baseEmbed, button, row, select, selectRow } from '../framework/ui';
import { getRegistry } from '../framework/registry';
import { formatCoins } from '../utils/format';
import { translatorFor, DEFAULT_LOCALE } from '../i18n';
import { commandDescription } from '../i18n/commands';
import { replyEphemeral, safeReply } from '../framework/interaction';

/** Onboarding, tutoriel et aide. */

const start: Command = {
  category: 'demarrage',
  requiresAccount: false,
  // `buildContext` crée ici la ferme entière : sans ce `defer`, tout le travail
  // de création se déroulait à l'intérieur des 3 secondes de Discord, avant la
  // moindre réponse. Sur une base lente, le joueur voyait « L'application ne
  // répond pas » alors que son compte venait d'être créé.
  deferBeforeContext: 'public',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('start')
    .setDescription('Create your farm and start playing')
    .addStringOption((option) =>
      option
        .setName('code')
        .setDescription('Referral code (starting bonus)')
        .setRequired(false)
        .setMaxLength(12),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    // `buildContext` a déjà créé le compte si nécessaire (createIfMissing).
    if (!context.player.created) {
      await replyEphemeral(interaction, {
        embeds: [
          baseEmbed({
            title: context.t('start.already_title'),
            description: context.t('start.already_body'),
            color: COLORS.info,
          }),
        ],
        components: [
          row(
            button({
              namespace: 'farm',
              action: 'refresh',
              ownerId: interaction.user.id,
              label: context.t('suggestion.farm'),
              emoji: '🌾',
              style: ButtonStyle.Success,
            }),
            button({
              namespace: 'quest',
              action: 'open',
              ownerId: interaction.user.id,
              label: context.t('suggestion.quests'),
              emoji: '📋',
            }),
          ),
        ],
      });
      return;
    }

    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: context.t('start.welcome_title'),
          description: context.t('start.welcome_body', {
            coins: formatCoins(context.player.coins, false, context.locale),
          }),
          color: COLORS.success,
          fields: [
            {
              name: `🎒 ${context.t('start.starter_kit')}`,
              value: context.t('start.starter_kit_body'),
              inline: true,
            },
            {
              name: context.t('start.estate_field'),
              value: context.t('start.estate_body', { plots: context.balance.plots.startingUnlocked }),
              inline: true,
            },
          ],
        }),
      ],
      components: [
        row(
          button({
            namespace: 'tuto',
            action: 'step',
            ownerId: interaction.user.id,
            params: [1],
            label: context.t('start.button_tutorial'),
            emoji: '🎓',
            style: ButtonStyle.Primary,
          }),
          button({
            namespace: 'farm',
            action: 'refresh',
            ownerId: interaction.user.id,
            label: context.t('start.button_farm'),
            emoji: '🌾',
            style: ButtonStyle.Success,
          }),
          button({
            namespace: 'farm',
            action: 'plant_menu',
            ownerId: interaction.user.id,
            label: context.t('start.button_plant'),
            emoji: '🌱',
          }),
        ),
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// /tutorial
// ---------------------------------------------------------------------------

export const TUTORIAL_STEPS = [
  { titleKey: 'tutorial.step1.title', bodyKey: 'tutorial.step1.body' },
  { titleKey: 'tutorial.step2.title', bodyKey: 'tutorial.step2.body' },
  { titleKey: 'tutorial.step3.title', bodyKey: 'tutorial.step3.body' },
  { titleKey: 'tutorial.step4.title', bodyKey: 'tutorial.step4.body' },
  { titleKey: 'tutorial.step5.title', bodyKey: 'tutorial.step5.body' },
  { titleKey: 'tutorial.step6.title', bodyKey: 'tutorial.step6.body' },
] as const;

const tutoriel: Command = {
  category: 'demarrage',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('tutorial')
    .setDescription('Step-by-step tutorial to get started')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const step = TUTORIAL_STEPS[0];
    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: `🎓 ${context.t(step.titleKey)}`,
          description: context.t(step.bodyKey),
          color: COLORS.info,
          footer: context.t('tutorial.footer'),
        }),
      ],
      components: [
        row(
          button({
            namespace: 'tuto',
            action: 'step',
            ownerId: interaction.user.id,
            params: [1],
            emoji: '◀️',
            disabled: true,
          }),
          button({
            namespace: 'tuto',
            action: 'step',
            ownerId: interaction.user.id,
            params: [2],
            label: context.t('tutorial.next_button'),
            emoji: '▶️',
            style: ButtonStyle.Primary,
          }),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

export function helpEmbed(
  category?: CommandCategory,
  locale?: string,
  t: Translator = translatorFor(locale ?? DEFAULT_LOCALE),
) {
  const registry = getRegistry();
  const commandsByCategory = new Map<CommandCategory, string[]>();

  for (const command of registry.commands.values()) {
    if (command.adminOnly && category !== 'admin') continue;
    const list = commandsByCategory.get(command.category) ?? [];
    const description = commandDescription(command.data, locale ?? DEFAULT_LOCALE);
    list.push(`\`/${command.data.name}\` · ${description}`);
    commandsByCategory.set(command.category, list);
  }

  if (category) {
    const meta = CATEGORY_LABELS[category];
    return baseEmbed({
      title: `${meta.emoji} ${t(`help.category.${category}.label`)}`,
      description: `${t(`help.category.${category}.description`)}\n\n${(commandsByCategory.get(category) ?? []).sort().join('\n')}`,
      color: COLORS.primary,
    });
  }

  return baseEmbed({
    title: t('help.title'),
    description: t('help.intro'),
    color: COLORS.primary,
    fields: [
      {
        name: t('help.getting_started_field'),
        value: t('help.getting_started_value'),
      },
      {
        name: t('help.categories_field'),
        value: Object.entries(CATEGORY_LABELS)
          .filter(([key]) => key !== 'admin')
          .map(([key, meta]) =>
            t('help.categories_line', {
              emoji: meta.emoji,
              label: t(`help.category.${key}.label`),
              count: commandsByCategory.get(key as CommandCategory)?.length ?? 0,
            }),
          )
          .join('\n'),
      },
      {
        name: t('help.tips_field'),
        value: t('help.tips_value'),
      },
    ],
  });
}

const aide: Command = {
  category: 'demarrage',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription("Interactive help menu")
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Jump straight to a category')
        .addChoices(
          ...Object.entries(CATEGORY_LABELS)
            .filter(([key]) => key !== 'admin')
            .map(([key, meta]) => ({ name: `${meta.emoji} ${meta.label}`, value: key })),
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const category = interaction.options.getString('category') as CommandCategory | null;
    await safeReply(interaction, {
      embeds: [helpEmbed(category ?? undefined, context.locale, context.t)],
      components: [
        selectRow(
          select({
            namespace: 'help',
            action: 'category',
            ownerId: interaction.user.id,
            placeholder: context.t('help.select_placeholder'),
            choices: Object.entries(CATEGORY_LABELS)
              .filter(([key]) => key !== 'admin')
              .map(([key, meta]) => ({
                label: context.t(`help.category.${key}.label`),
                value: key,
                emoji: meta.emoji,
                description: context.t(`help.category.${key}.description`),
                default: category === key,
              })),
          }),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const commands: Command[] = [start, tutoriel, aide];
