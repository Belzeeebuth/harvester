import { ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { CATEGORY_LABELS, type Command, type CommandCategory, type CommandContext, type Translator } from '../types';
import type { View } from '../framework/views';
import { COLORS, baseEmbed, button, row, select, selectRow } from '../framework/ui';
import { getRegistry } from '../framework/registry';
import { formatCoins } from '../utils/format';
import { translatorFor, DEFAULT_LOCALE } from '../i18n';
import { commandDescription } from '../i18n/commands';
import { replyEphemeral, safeReply } from '../framework/interaction';
import { getConfig, seedKeyOf, type GameConfig } from '../config';
import { starterSeedsAt } from '../services/player.service';
import { levelGatedFeatures } from '../game/unlocks';
import type { Balance } from '../config/gameplay/schemas';

/** Onboarding, tutoriel et aide. */

/** Réponse de `/start` pour un joueur qui a déjà une ferme. */
export function alreadyStartedView(context: CommandContext, ownerId: string): View {
  return {
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
          ownerId,
          label: context.t('suggestion.farm'),
          emoji: '🌾',
          style: ButtonStyle.Success,
        }),
        button({
          namespace: 'quest',
          action: 'open',
          ownerId,
          label: context.t('suggestion.quests'),
          emoji: '📋',
        }),
      ),
    ],
  };
}

/**
 * Accueil d'un nouveau joueur, partagé par `/start` et le bouton « Créer ma
 * ferme » proposé quand un joueur sans ferme tente une action.
 */
export function welcomeView(context: CommandContext, ownerId: string): View {
  // Même calcul que le sac réellement remis (`createPlayer`) : les graines
  // dépendent de la saison du jour.
  const config = getConfig(context.locale);
  const kit = starterSeedsAt(context.now).flatMap((seed) => {
    const crop = config.crops.get(seed.cropKey);
    const item = config.items.get(seedKeyOf(seed.cropKey));
    return crop && item ? [{ ...seed, crop, item }] : [];
  });
  const seedLines = kit.map(({ quantity, crop, item }) =>
    context.t(crop.requiredLevel > context.player.level ? 'first_hour.kit_seed_line_level' : 'first_hour.kit_seed_line', {
      quantity,
      emoji: item.emoji,
      name: item.name,
      level: crop.requiredLevel,
    }),
  );

  return {
    embeds: [
      baseEmbed({
        title: context.t('start.welcome_title'),
        description: context.t('start.welcome_body', {
          coins: formatCoins(context.player.coins, false, context.locale),
          seed: kit[0]?.crop.name ?? '…',
        }),
        color: COLORS.success,
        fields: [
          {
            name: `🎒 ${context.t('start.starter_kit')}`,
            value: context.t('start.starter_kit_body', { seeds: seedLines.join('\n') }),
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
          ownerId,
          params: [1],
          label: context.t('start.button_tutorial'),
          emoji: '🎓',
          style: ButtonStyle.Primary,
        }),
        button({
          namespace: 'farm',
          action: 'refresh',
          ownerId,
          label: context.t('start.button_farm'),
          emoji: '🌾',
          style: ButtonStyle.Success,
        }),
        button({
          namespace: 'farm',
          action: 'plant_menu',
          ownerId,
          label: context.t('start.button_plant'),
          emoji: '🌱',
        }),
        // Proposition unique : les rappels restent coupés par défaut, le
        // joueur les allume d'un clic s'il le souhaite.
        button({
          namespace: 'settings',
          action: 'dm_on',
          ownerId,
          label: context.t('onboarding.start_dm_button'),
          emoji: '🔔',
        }),
      ),
    ],
  };
}

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
      await replyEphemeral(interaction, alreadyStartedView(context, interaction.user.id));
      return;
    }
    await safeReply(interaction, welcomeView(context, interaction.user.id));
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

/**
 * Niveaux cités par le tutoriel, lus dans la configuration : le texte
 * annonçait `/buy-animal` au niveau 1, où rien n'est achetable.
 */
export function tutorialParams(config: Pick<GameConfig, 'animalList' | 'balance'>): Record<string, number> {
  const animalLevels = config.animalList
    .filter((animal) => animal.enabled && !animal.eventOnly)
    .map((animal) => animal.requiredLevel);
  return {
    animalLevel: animalLevels.length > 0 ? Math.min(...animalLevels) : 1,
    coopLevel: config.balance.coop.creationMinLevel,
  };
}

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
          description: context.t(step.bodyKey, tutorialParams(context.config)),
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

/**
 * Niveau de déblocage affiché à côté des commandes concernées dans `/help`,
 * dérivé de l'équilibrage. `coop` et `auction` ne sont bridées qu'en partie
 * (création, achats) : on le précise plutôt que de tout marquer verrouillé.
 */
function commandLevelGates(balance: Balance, t: Translator): Map<string, string> {
  const gates = new Map<string, string>();
  for (const feature of levelGatedFeatures(balance)) {
    if (feature.key === 'bank_tier' || feature.level <= 1) continue;
    const [name, sub] = feature.command.split(' ');
    if (!name) continue;
    gates.set(
      name,
      sub
        ? t('onboarding.help_partial_from_level', { what: t(`onboarding.help_what.${feature.key}`), level: feature.level })
        : t('onboarding.help_from_level', { level: feature.level }),
    );
    if (feature.key === 'trade') {
      // L'hôtel des ventes applique la même barrière, côté acheteur seulement.
      gates.set('auction', t('onboarding.help_partial_from_level', { what: t('onboarding.help_what.auction'), level: feature.level }));
    }
  }
  return gates;
}

export function helpEmbed(
  category?: CommandCategory,
  locale?: string,
  t: Translator = translatorFor(locale ?? DEFAULT_LOCALE),
) {
  const registry = getRegistry();
  const commandsByCategory = new Map<CommandCategory, string[]>();
  const gates = commandLevelGates(getConfig(locale).balance, t);

  for (const command of registry.commands.values()) {
    if (command.adminOnly && category !== 'admin') continue;
    const list = commandsByCategory.get(command.category) ?? [];
    const description = commandDescription(command.data, locale ?? DEFAULT_LOCALE);
    const gate = gates.get(command.data.name);
    list.push(`\`/${command.data.name}\` · ${description}${gate ? ` · 🔒 ${gate}` : ''}`);
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
