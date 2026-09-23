import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import { buildingsView, productionView } from '../framework/views';
import * as craftService from '../services/craft.service';
import { discordTimestamp, formatCoins, formatNumber, truncate } from '../utils/format';
import { translatorFor } from '../i18n';
import { describeItems } from '../services/inventory.service';
import type { View } from '../framework/views';
import { appendTracking } from './farm';
import type { Command, CommandContext } from '../types';

/** Artisanat, recettes, file de production et bâtiments. */

const crafter: Command = {
  category: 'inventaire',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('craft')
    .setDescription('Start a production run in one of your buildings')
    .addStringOption((option) =>
      option.setName('recipe').setDescription('The recipe').setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('Number of batches').setMinValue(1).setMaxValue(20),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await craftService.craft(context.player, {
      recipeKey: interaction.options.getString('recipe', true),
      quantity: interaction.options.getInteger('quantity') ?? 1,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('craft.start_title', { emoji: result.emoji, recipeName: result.recipeName }),
          [
            context.t('craft.start_building_line', {
              name: result.buildingName,
              slot: result.slotIndex + 1,
            }),
            context.t('craft.start_quantity_line', { quantity: result.quantity }),
            context.t('craft.start_ready_line', {
              relative: discordTimestamp(result.finishAt, 'R'),
              time: discordTimestamp(result.finishAt, 't'),
            }),
            '',
            context.t('craft.start_ingredients_line', {
              ingredients: describeItems(result.consumed, context.locale),
            }),
          ].join('\n'),
        ),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    const t = translatorFor(context.locale);
    const query = interaction.options.getFocused().toString();
    const level = context.playerId
      ? ((await (await import('../repositories/player.repo')).findUserById(context.playerId))?.level ?? 1)
      : 1;
    const recipes = craftService.craftableRecipes(level, query, context.locale);
    await interaction.respond(
      recipes.map((recipe) => ({
        name: truncate(
          t('craft.autocomplete_line', {
            emoji: recipe.emoji,
            name: recipe.name,
            minutes: Math.round(recipe.durationSeconds / 60),
            level: t('common.level_abbr', { level: recipe.requiredLevel }),
          }),
          100,
        ),
        value: recipe.key,
      })),
    );
  },
};

const recettes: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('recipes')
    .setDescription('Every processing recipe')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter by workshop')
        .addChoices(
          { name: '🌬️ Bakery', value: 'boulangerie' },
          { name: '🫙 Cannery', value: 'conserverie' },
          { name: '🧈 Dairy', value: 'laiterie' },
          { name: '🍺 Brewery', value: 'brasserie' },
          { name: '🫗 Oil press', value: 'huilerie' },
          { name: '🔥 Smokehouse', value: 'fumoir' },
          { name: '🍬 Confectionery', value: 'confiserie' },
          { name: '🛠️ Workshop', value: 'atelier' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const category = interaction.options.getString('category') ?? undefined;
    await interaction.editReply(await recipesView(context, category));
  },
};

/**
 * Liste des recettes, partagée par `/recipes` et le bouton « Recettes » de
 * `/production` (qui renvoyait auparavant vers la commande sans rien montrer).
 */
export async function recipesView(context: CommandContext, category?: string): Promise<View> {
  const recipes = await craftService.listRecipes(context.player, { category });

  const lines = recipes.slice(0, 20).map((entry) => {
    const lock = !entry.unlocked
      ? context.t('craft.lock_level', { level: context.t('common.level_abbr', { level: entry.recipe.requiredLevel }) })
      : !entry.hasBuilding
        ? context.t('craft.lock_building', { building: entry.building?.name ?? entry.recipe.buildingKey })
        : entry.craftableCount > 0
          ? context.t('craft.lock_craftable', { count: entry.craftableCount })
          : context.t('craft.lock_missing');
    const ingredients = entry.ingredients
      .map((ingredient) => `${ingredient.needed}× ${ingredient.emoji}${ingredient.owned < ingredient.needed ? `(${ingredient.owned})` : ''}`)
      .join(' + ');
    return [
      `${entry.recipe.emoji} **${entry.recipe.name}** · ${lock}`,
      `   ${context.t('craft.recipe_line2', {
        ingredients,
        quantity: entry.recipe.outputQuantity,
        emoji: entry.outputEmoji,
        margin: entry.margin.toFixed(2),
        minutes: Math.round(entry.recipe.durationSeconds / 60),
      })}`,
    ].join('\n');
  });

  return {
    embeds: [
      baseEmbed({
        title: context.t('craft.recipes_title'),
        description: lines.join('\n') || context.t('craft.recipes_empty'),
        color: COLORS.primary,
        footer: context.t('craft.recipes_footer'),
      }),
    ],
  };
}

const production: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('production')
    .setDescription('Status of your production queues')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(await productionView(context));
  },
};

const batiments: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('buildings')
    .setDescription('Build and upgrade your buildings')
    .addStringOption((option) =>
      option
        .setName('build')
        .setDescription('Build or upgrade a building directly')
        .setAutocomplete(true)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const buildingKey = interaction.options.getString('build');

    if (buildingKey) {
      const result = await craftService.buildOrUpgrade(context.player, buildingKey);
      await interaction.editReply({
        embeds: [
          successEmbed(
            context.t('craft.build_title', {
              emoji: result.emoji,
              name: result.name,
              status: result.built
                ? context.t('craft.build_status_built')
                : context.t('craft.build_status_tier', { tier: result.tier }),
            }),
            [
              context.t('craft.build_cost_line', {
                cost: formatCoins(result.costCoins, false, context.locale),
              }),
              result.capacity > 0
                ? context.t('craft.build_capacity_line', {
                    capacity: formatNumber(result.capacity, context.locale),
                  })
                : '',
              result.slots > 0 ? context.t('craft.build_slots_line', { slots: result.slots }) : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ],
      });
      return;
    }

    await interaction.editReply(await buildingsView(context));
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    await interaction.respond(
      context.config.buildingList
        .filter((building) => building.enabled && (!query || building.name.toLowerCase().includes(query)))
        .slice(0, 25)
        .map((building) => ({
          name: truncate(`${building.emoji} ${building.name} · ${building.description ?? ''}`, 100),
          value: building.key,
        })),
    );
  },
};

export const commands: Command[] = [crafter, recettes, production, batiments];
export { appendTracking };
