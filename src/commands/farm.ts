import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { harvestKeyOf, seedKeyOf } from '../config';
import { farmView, plotsView } from '../framework/views';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import { safeReply } from '../framework/interaction';
import { harvestFollowUpRows } from '../framework/selling';
import * as inventoryService from '../services/inventory.service';
import { withLevelUp } from '../framework/levelup';
import { describeItems } from '../services/inventory.service';
import * as farmService from '../services/farm.service';
import { qualityDistribution } from '../game/quality';
import { expectedYield } from '../game/harvest';
import { NEUTRAL_MODIFIERS } from '../game/modifiers';
import {
  COIN,
  discordTimestamp,
  formatCoins,
  formatDuration,
  formatNumber,
  mutationIcon,
  qualityIcon,
  truncate,
} from '../utils/format';
import { translatorFor } from '../i18n';
import type { AutocompleteContext, Command, CommandContext, Translator } from '../types';

/**
 * Commandes d'agriculture : le cœur de la boucle de jeu.
 *
 * Chaque commande suit le même contrat : différer la réponse si l'action peut
 * dépasser 2 secondes (rendu d'image, transaction), déléguer TOUTE la logique au
 * service, puis composer l'affichage. Aucune règle de jeu ici.
 */

// ---------------------------------------------------------------------------
// /farm
// ---------------------------------------------------------------------------

const ferme: Command = {
  category: 'agriculture',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('farm')
    .setDescription("Show your farm, or another farmer's")
    .addUserOption((option) =>
      option.setName('user').setDescription('The farmer to watch').setRequired(false),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user');

    if (target && target.id !== interaction.user.id) {
      // Consultation de la ferme d'un autre : on délègue à /visit, qui gère
      // la confidentialité et la récompense de visite.
      const { visitFarm } = await import('./social');
      await visitFarm(interaction, context, target);
      return;
    }

    const view = await farmView(context, {
      targetName: interaction.user.displayName,
      avatarUrl: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
    });
    await interaction.editReply(view);
  },
};

// ---------------------------------------------------------------------------
// /plant
// ---------------------------------------------------------------------------

const planter: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('plant')
    .setDescription('Sow seeds on your plots')
    .addStringOption((option) =>
      option
        .setName('seed')
        .setDescription('The crop to plant')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('plot')
        .setDescription('A specific plot (otherwise fills empty ones)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('quantity')
        .setDescription('How many plots to plant (default: as many as your seeds allow)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    // Nom tapé sans choisir dans l'autocomplétion (« Oignon ») : résolu vers la clé.
    const cropKey = inventoryService.resolveCropInput(interaction.options.getString('seed', true));
    const slot = interaction.options.getInteger('plot') ?? undefined;
    // Sans quantité : autant de parcelles libres que de graines possédées.
    const quantity = interaction.options.getInteger('quantity') ?? undefined;

    const result = await farmService.plant(context.player, { cropKey, slot, quantity });

    const embed = successEmbed(
      context.t('farm.plant_success_title', { emoji: result.emoji, cropName: result.cropName }),
      [
        context.t('farm.plant_body_slots', {
          count: result.slots.length,
          slots: result.slots.map((value) => `\`${value}\``).join(' '),
        }),
        context.t('farm.plant_body_harvest', {
          relative: discordTimestamp(result.readyAt, 'R'),
          time: discordTimestamp(result.readyAt, 't'),
        }),
        result.waterNeeded > 0
          ? context.t('farm.plant_body_water', { count: result.waterNeeded })
          : '',
        result.offSeason ? context.t('farm.plant_body_off_season') : '',
        offSeasonAdvice(result, context.t),
      ]
        .filter(Boolean)
        .join('\n'),
    );

    appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },

  async autocomplete(interaction, context: AutocompleteContext): Promise<void> {
    const query = interaction.options.getFocused().toString();
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const t = translatorFor(context.locale);
    const crops = await farmService.plantableCrops(context.playerId, 60, query, context.locale);
    await interaction.respond(
      crops.map((entry) => ({
        name: truncate(
          t('farm.plant_autocomplete', {
            emoji: entry.crop.emoji,
            name: entry.crop.name,
            owned: entry.owned,
            minutes: Math.round(entry.crop.growthSeconds / 60),
          }),
          100,
        ),
        value: entry.crop.key,
      })),
    );
  },
};

// ---------------------------------------------------------------------------
// /harvest
// ---------------------------------------------------------------------------

const recolter: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('harvest')
    .setDescription('Harvest the crops that are ready')
    .addIntegerOption((option) =>
      option
        .setName('plot')
        .setDescription('A specific plot (otherwise: everything ready)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('plot') ?? undefined;

    const summary = await farmService.harvest(context.player, { slot, all: slot === undefined });
    await interaction.editReply({
      embeds: [buildHarvestEmbed(summary, context.t, context.locale)],
      // Suite naturelle d'une récolte : la vendre sans retaper `/sell`.
      components: harvestFollowUpRows(summary, interaction.user.id, context.t),
    });
  },
};

/** Conseil affiché sous une plantation hors saison : les cultures de saison à la portée du joueur. */
export function offSeasonAdvice(
  result: Pick<farmService.PlantResult, 'offSeason' | 'inSeasonAlternatives'>,
  t: Translator,
): string {
  if (!result.offSeason || result.inSeasonAlternatives.length === 0) return '';
  return t('first_hour.off_season_advice', {
    crops: result.inSeasonAlternatives.map((crop) => `${crop.emoji} ${crop.name}`).join(' · '),
  });
}

export function buildHarvestEmbed(summary: farmService.HarvestSummary, t: Translator, locale?: string) {
  const lines = summary.plots.map((plot) => {
    const quality =
      plot.result.quality === 'normal'
        ? ''
        : ` ${qualityIcon(plot.result.quality)} ${t(`common.quality.${plot.result.quality}`)}`;
    const mutation = plot.result.mutation === 'none' ? '' : ` ${mutationIcon(plot.result.mutation)} **${t(`render_alt.farm.mutation.${plot.result.mutation}`)}**`;
    const regrow =
      plot.regrew && plot.nextReadyAt
        ? ` ${t('farm.harvest_regrow', { relative: discordTimestamp(plot.nextReadyAt, 'R') })}`
        : '';
    return `\`${String(plot.slot).padStart(2, ' ')}\` ${plot.emoji} **${plot.result.quantity}× ${plot.cropName}**${quality}${mutation} · ~${formatCoins(plot.result.totalValue, true, locale)}${regrow}`;
  });

  const embed = baseEmbed({
    title: t('farm.harvest_title'),
    description: lines.join('\n') || t('farm.harvest_nothing'),
    color: COLORS.success,
    fields: [
      {
        name: t('common.total'),
        value: t('farm.harvest_total_value', {
          quantity: formatNumber(summary.totalQuantity, locale),
          value: formatCoins(summary.estimatedValue, false, locale),
          xp: formatNumber(summary.xpGained, locale),
        }),
      },
    ],
  });

  if (summary.witheredSlots.length > 0) {
    embed.addFields({
      name: t('farm.harvest_withered_title'),
      value: t('farm.harvest_withered_body', { slots: summary.witheredSlots.join(', ') }),
    });
  }
  if (summary.seedsRecovered.length > 0) {
    embed.addFields({
      name: t('farm.harvest_seed_store_title'),
      value: describeItems(summary.seedsRecovered, locale),
    });
  }
  // Bloc commun : récompense, déblocages du niveau atteint, prochain palier.
  withLevelUp(embed, summary.levelUp, t, locale);
  appendTracking(embed, summary.tracking, t);

  return embed;
}

// ---------------------------------------------------------------------------
// /water
// ---------------------------------------------------------------------------

const arroser: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('water')
    .setDescription('Water your thirsty crops')
    .addIntegerOption((option) =>
      option
        .setName('plot')
        .setDescription('A specific plot (otherwise: as many as possible)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('plot') ?? undefined;
    const result = await farmService.water(context.player, { slot, all: slot === undefined });

    if (result.freeRain) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: context.t('farm.rain_title'),
            description: context.t('farm.rain_body'),
            color: COLORS.info,
          }),
        ],
      });
      return;
    }

    const embed = successEmbed(
      context.t('farm.water_title'),
      context.t('farm.water_body', {
        count: result.watered,
        note:
          result.toolPlots > 1
            ? context.t('farm.water_tool_note', { count: result.toolPlots })
            : '',
      }),
    );
    appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /fertilize, /weed, /treat
// ---------------------------------------------------------------------------

const fertiliser: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('fertilize')
    .setDescription('Apply fertilizer to your plots')
    .addStringOption((option) =>
      option
        .setName('fertilizer')
        .setDescription("The fertilizer type")
        .setRequired(true)
        .addChoices(
          { name: '💩 Basic fertilizer (+15 fertility, +10% yield)', value: 'fertilizer_basic' },
          { name: '🧪 Quality fertilizer (+25 fertility, +15% quality)', value: 'fertilizer_quality' },
          { name: '✨ Deluxe fertilizer (+40 fertility, +25% yield and quality)', value: 'fertilizer_deluxe' },
          { name: '🌟 Mythic fertilizer (+60 fertility, +40% yield and quality)', value: 'fertilizer_mythic' },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName('plot')
        .setDescription('A specific plot (leave empty to fertilize ALL your plots, one bag each)')
        .setMinValue(1)
        .setMaxValue(64),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const fertilizerKey = interaction.options.getString('fertilizer', true);
    const slot = interaction.options.getInteger('plot') ?? undefined;

    const result = await farmService.fertilize(context.player, { fertilizerKey, slot, all: !slot });
    const embed = successEmbed(
      context.t('farm.fertilize_title'),
      context.t('farm.fertilize_body', {
        fertilizer: result.fertilizer,
        count: result.slots.length,
        percent: result.fertilityAfter,
      }),
    );
    appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },
};

const desherber: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('weed')
    .setDescription('Pull weeds and collect compost material')
    .addIntegerOption((option) =>
      option.setName('plot').setDescription('A specific plot').setMinValue(1).setMaxValue(64),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('plot') ?? undefined;
    const result = await farmService.weed(context.player, { slot, all: !slot });

    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('farm.weed_title'),
          context.t('farm.weed_body', {
            count: result.slots.length,
            collected: result.weedsCollected,
          }),
        ),
      ],
    });
  },
};

const traiter: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('treat')
    .setDescription('Treat a plot infested with pests')
    .addIntegerOption((option) =>
      option
        .setName('plot')
        .setDescription('The plot to treat')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(64),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('plot', true);
    const result = await farmService.treatPest(context.player, { slot });

    const { PEST_LABELS } = await import('../game/plot');
    const pest = PEST_LABELS[result.pestType];
    const pestName = context.t(`farm.pest_${result.pestType}`);

    const embed = successEmbed(
      context.t('farm.treat_title', { emoji: pest.emoji, pestName }),
      result.usedItem
        ? context.t('farm.treat_body_used', { slot: result.slot })
        : context.t('farm.treat_body_noitem', { slot: result.slot }),
    );
    appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /plots, /buy-plot
// ---------------------------------------------------------------------------

const parcelles: Command = {
  category: 'agriculture',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('plots')
    .setDescription('Detailed view of your plots and their soil')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(await plotsView(context, 1));
  },
};

const acheterParcelle: Command = {
  category: 'agriculture',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('buy-plot')
    .setDescription('Unlock the next plot of your farm')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await farmService.buyPlot(context.player);

    const embed = successEmbed(
      context.t('farm.new_plot_title'),
      [
        context.t('farm.new_plot_unlocked', {
          slot: result.slot,
          cost: formatCoins(result.cost, false, context.locale),
        }),
        context.t('farm.new_plot_size', {
          width: result.grid.width,
          height: result.grid.height,
          count: result.unlockedPlots,
        }),
        result.nextCost > 0
          ? context.t('farm.new_plot_next_cost', {
              cost: formatCoins(result.nextCost, false, context.locale),
            })
          : context.t('farm.new_plot_complete'),
      ].join('\n'),
    );
    appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /crops — encyclopédie
// ---------------------------------------------------------------------------

const cultures: Command = {
  category: 'agriculture',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('crops')
    .setDescription('Crop encyclopedia')
    .addStringOption((option) =>
      option
        .setName('rarity')
        .setDescription('Filter by rarity')
        .addChoices(
          { name: 'Common', value: 'common' },
          { name: 'Uncommon', value: 'uncommon' },
          { name: 'Rare', value: 'rare' },
          { name: 'Epic', value: 'epic' },
          { name: 'Legendary', value: 'legendary' },
          { name: 'Mythic', value: 'mythic' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('season')
        .setDescription('Filter by season')
        .addChoices(
          { name: 'Spring', value: 'spring' },
          { name: 'Summer', value: 'summer' },
          { name: 'Autumn', value: 'autumn' },
          { name: 'Winter', value: 'winter' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const rarity = interaction.options.getString('rarity');
    const season = interaction.options.getString('season');

    const crops = context.config.cropList.filter((crop) => {
      if (!crop.enabled) return false;
      if (rarity && crop.rarity !== rarity) return false;
      if (season && !crop.seasons.includes(season as never)) return false;
      return true;
    });

    const lines = crops.slice(0, 25).map((crop) => {
      const profit = crop.sellPrice * crop.baseYield - crop.seedPrice;
      const perHour = Math.round((profit / crop.growthSeconds) * 3_600);
      const locked = crop.requiredLevel > context.player.level ? '🔒 ' : '';
      return [
        `${locked}${crop.emoji} **${crop.name}** · ${context.t(`common.rarity.${crop.rarity}`)} · ${context.t('common.level_abbr', { level: crop.requiredLevel })}`,
        `   🌱 ${formatNumber(crop.seedPrice, context.locale)} ${COIN} → 🧺 ${crop.baseYield}× ${formatNumber(crop.sellPrice, context.locale)} ${COIN} · ⏳ ${formatDuration(crop.growthSeconds * 1000, context.locale)} · **~${formatNumber(perHour, context.locale)} ${COIN}/h/plot**${crop.regrowCycles > 0 ? ` · 🔁 ${crop.regrowCycles}` : ''}`,
      ].join('\n');
    });

    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: context.t('farm.crops_title'),
          description: lines.join('\n') || context.t('farm.crops_empty'),
          color: COLORS.primary,
          footer: context.t('farm.crops_footer', { count: crops.length }),
        }),
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// Utilitaires partagés
// ---------------------------------------------------------------------------

/** Ajoute les quêtes/succès débloqués sous un embed d'action. */
export function appendTracking(
  embed: ReturnType<typeof baseEmbed>,
  tracking: { completedQuests: Array<{ title: string }>; unlockedAchievements: Array<{ name: string }>; completedCoopObjectives: string[] },
  t: Translator,
): void {
  const parts: string[] = [];
  if (tracking.completedQuests.length > 0) {
    parts.push(
      t('common.tracking_quest_completed', {
        quests: tracking.completedQuests.map((quest) => `**${quest.title}**`).join(', '),
      }),
    );
  }
  if (tracking.unlockedAchievements.length > 0) {
    parts.push(
      t('common.tracking_achievement_unlocked', {
        achievements: tracking.unlockedAchievements.map((entry) => `**${entry.name}**`).join(', '),
      }),
    );
  }
  if (tracking.completedCoopObjectives.length > 0) {
    parts.push(
      t('common.tracking_coop_objective', {
        objectives: tracking.completedCoopObjectives
          .map((key) => `**${t(`coop.objective.${key}.title`)}**`)
          .join(', '),
      }),
    );
  }
  if (parts.length > 0) {
    embed.addFields({ name: '​', value: parts.join('\n') });
  }
}

export const commands: Command[] = [
  ferme,
  planter,
  recolter,
  arroser,
  fertiliser,
  desherber,
  traiter,
  parcelles,
  acheterParcelle,
  cultures,
];

export { MessageFlags, harvestKeyOf, seedKeyOf, qualityDistribution, expectedYield, NEUTRAL_MODIFIERS };
