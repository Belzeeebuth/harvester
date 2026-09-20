import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed } from '../framework/ui';
import { safeReply } from '../framework/interaction';
import { SEASON_LABELS } from '../game/world';
import { describeNextSeason, getWorldState } from '../services/world.service';
import { discordTimestamp, formatPercent, progressBar, truncate } from '../utils/format';
import type { Command } from '../types';

/** Météo, saisons, événements et encyclopédie générale. */

const meteo: Command = {
  category: 'monde',
  requiresAccount: false,
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('weather')
    .setDescription("Today's weather and how it affects your crops")
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const world = await getWorldState(context.now, context.locale);
    const weather = world.weather;

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: `${weather.emoji} ${weather.label} · ${weather.temperature} °C`,
          description: weather.description,
          color: weather.damageChance > 0 ? COLORS.warning : COLORS.info,
          fields: [
            {
              name: context.t('world.weather_effects_field'),
              value: [
                context.t('world.weather_yield_line', {
                  percent: formatPercent(weather.yieldModifier - 1, undefined, context.locale),
                }),
                context.t('world.weather_growth_line', {
                  percent: formatPercent(weather.growthModifier - 1, undefined, context.locale),
                }),
                weather.freeWatering ? context.t('world.weather_free_watering_line') : '',
                weather.damageChance > 0
                  ? context.t('world.weather_damage_line', {
                      percent: (weather.damageChance * 100).toFixed(0),
                    })
                  : '',
                context.t('world.weather_pest_line', { percent: (weather.pestChance * 100).toFixed(0) }),
              ]
                .filter(Boolean)
                .join('\n'),
            },
            {
              name: context.t('world.weather_season_field'),
              value: context.t('world.weather_season_value', {
                emoji: SEASON_LABELS[world.season.season].emoji,
                name: context.t(`world.season.${world.season.season}`),
                year: world.season.gameYear,
                bar: progressBar(world.season.progress * 100, 100, 12),
                percent: Math.round(world.season.progress * 100),
              }),
            },
          ],
          footer: context.t('world.weather_footer'),
        }),
      ],
    });
  },
};

const saison: Command = {
  category: 'monde',
  requiresAccount: false,
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('season')
    .setDescription("Current season, favoured crops and what's next")
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const world = await getWorldState(context.now, context.locale);
    const next = describeNextSeason(context.now);
    const current = world.season.season;

    const inSeason = context.config.cropList.filter(
      (crop) => crop.enabled && crop.seasons.includes(current as never),
    );
    const comingSoon = context.config.cropList.filter(
      (crop) => crop.enabled && !crop.seasons.includes(current as never) && crop.seasons.includes(next.season as never),
    );

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: context.t('world.season_title', {
            emoji: SEASON_LABELS[current].emoji,
            name: context.t(`world.season.${current}`),
            year: world.season.gameYear,
          }),
          description: [
            context.t('world.season_progress_line', {
              bar: progressBar(world.season.progress * 100, 100, 16),
              percent: Math.round(world.season.progress * 100),
            }),
            context.t('world.season_next_line', {
              emoji: SEASON_LABELS[next.season].emoji,
              name: context.t(`world.season.${next.season}`),
              relative: discordTimestamp(next.startsAt, 'R'),
            }),
            '',
            context.t('world.season_bonus_line', {
              percent: (context.balance.seasons.inSeasonYieldBonus * 100).toFixed(0),
            }),
            context.t('world.season_penalty_line', {
              percent: (context.balance.seasons.offSeasonYieldPenalty * 100).toFixed(0),
            }),
          ].join('\n'),
          color: COLORS.primary,
          fields: [
            {
              name: context.t('world.season_crops_field'),
              value: truncate(
                inSeason.map((crop) => `${crop.emoji} ${crop.name}`).join(' · ') || context.t('common.none'),
                1000,
              ),
            },
            {
              name: context.t('world.season_coming_field'),
              value: truncate(
                comingSoon.map((crop) => `${crop.emoji} ${crop.name}`).join(' · ') || context.t('common.none'),
                1000,
              ),
            },
          ],
        }),
      ],
    });
  },
};

const evenement: Command = {
  category: 'monde',
  requiresAccount: false,
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('Active event and its rewards')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const world = await getWorldState(context.now, context.locale);

    if (world.activeEvents.length === 0) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: context.t('world.event_none_title'),
            description: context.t('world.event_none_body', {
              list: context.config.eventList
                .filter((event) => event.enabled)
                .map((event) =>
                  context.t('world.event_calendar_line', {
                    name: event.name,
                    description: event.description,
                  }),
                )
                .join('\n'),
            }),
            color: COLORS.info,
          }),
        ],
      });
      return;
    }

    const event = world.activeEvents[0]!;
    const progress = await (
      await import('../repositories/progression.repo')
    ).getUserEvent(context.player.id, event.key);

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: `🎪 ${event.name}`,
          description: event.description,
          color: COLORS.gold,
          fields: [
            {
              name: context.t('world.event_modifiers_field'),
              value:
                [
                  event.modifiers.xpMultiplier
                    ? context.t('world.event_xp_line', { multiplier: event.modifiers.xpMultiplier })
                    : '',
                  event.modifiers.growthMultiplier
                    ? context.t('world.event_growth_line', {
                        multiplier: event.modifiers.growthMultiplier,
                      })
                    : '',
                  event.modifiers.globalPriceMultiplier
                    ? context.t('world.event_prices_line', {
                        multiplier: event.modifiers.globalPriceMultiplier,
                      })
                    : '',
                  event.modifiers.mutationMultiplier
                    ? context.t('world.event_mutations_line', {
                        multiplier: event.modifiers.mutationMultiplier,
                      })
                    : '',
                  event.modifiers.waterMultiplier
                    ? context.t('world.event_water_line', {
                        multiplier: event.modifiers.waterMultiplier,
                      })
                    : '',
                ]
                  .filter(Boolean)
                  .join('\n') || context.t('world.event_modifiers_none'),
            },
            {
              name: context.t('world.event_progress_field'),
              value: context.t('world.event_points_value', { points: progress?.points ?? 0 }),
            },
            {
              name: context.t('world.event_reward_tiers_field'),
              value:
                event.rewardTiers
                  .map((tier) => {
                    const claimed = (progress?.claimedTiers ?? []).includes(tier.points);
                    const rewards = [
                      tier.rewards.coins ? `${tier.rewards.coins} 🪙` : '',
                      tier.rewards.gems ? `${tier.rewards.gems} 💎` : '',
                      tier.rewards.title
                        ? context.t('world.event_reward_title_part', { title: tier.rewards.title })
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ');
                    return `${claimed ? '✅' : (progress?.points ?? 0) >= tier.points ? '🎁' : '🔒'} **${tier.points} pts** · ${rewards}`;
                  })
                  .join('\n') || context.t('world.event_no_tier'),
            },
          ],
        }),
      ],
    });
  },
};

const encyclopedie: Command = {
  category: 'monde',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('encyclopedia')
    .setDescription('Search the entire game database')
    .addStringOption((option) =>
      option.setName('term').setDescription('Crop, animal, item, recipe or building').setRequired(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const term = interaction.options.getString('term', true).toLowerCase();
    const config = context.config;

    const crops = config.cropList.filter((entry) => entry.name.toLowerCase().includes(term));
    const animals = config.animalList.filter((entry) => entry.name.toLowerCase().includes(term));
    const items = config.itemList.filter((entry) => entry.name.toLowerCase().includes(term));
    const recipes = config.recipeList.filter((entry) => entry.name.toLowerCase().includes(term));
    const buildings = config.buildingList.filter((entry) => entry.name.toLowerCase().includes(term));

    const total = crops.length + animals.length + items.length + recipes.length + buildings.length;

    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: context.t('world.encyclopedia_title', { term }),
          description:
            total === 0
              ? context.t('world.encyclopedia_no_result')
              : context.t('world.encyclopedia_result_count', { count: total }),
          color: COLORS.info,
          fields: [
            ...(crops.length > 0
              ? [
                  {
                    name: context.t('world.encyclopedia_crops_field'),
                    value: crops
                      .slice(0, 5)
                      .map((crop) =>
                        context.t('world.encyclopedia_crop_line', {
                          emoji: crop.emoji,
                          name: crop.name,
                          level: context.t('common.level_abbr', { level: crop.requiredLevel }),
                          minutes: Math.round(crop.growthSeconds / 60),
                          yield: crop.baseYield,
                          price: crop.sellPrice,
                        }),
                      )
                      .join('\n'),
                  },
                ]
              : []),
            ...(animals.length > 0
              ? [
                  {
                    name: context.t('world.encyclopedia_animals_field'),
                    value: animals
                      .slice(0, 5)
                      .map((animal) =>
                        context.t('world.encyclopedia_animal_line', {
                          emoji: animal.emoji,
                          name: animal.name,
                          level: context.t('common.level_abbr', { level: animal.requiredLevel }),
                          price: animal.price,
                          quantity: animal.productQuantity,
                          minutes: Math.round(animal.productionSeconds / 60),
                        }),
                      )
                      .join('\n'),
                  },
                ]
              : []),
            ...(items.length > 0
              ? [
                  {
                    name: context.t('world.encyclopedia_items_field'),
                    value: items
                      .slice(0, 6)
                      .map((item) =>
                        context.t('world.encyclopedia_item_line', {
                          emoji: item.emoji,
                          name: item.name,
                          description: item.description ?? item.category,
                        }),
                      )
                      .join('\n'),
                  },
                ]
              : []),
            ...(recipes.length > 0
              ? [
                  {
                    name: context.t('world.encyclopedia_recipes_field'),
                    value: recipes
                      .slice(0, 5)
                      .map((recipe) =>
                        context.t('world.encyclopedia_recipe_line', {
                          emoji: recipe.emoji,
                          name: recipe.name,
                          ingredients: (recipe.ingredients as Array<{ itemKey: string; quantity: number }>)
                            .map((ingredient) => `${ingredient.quantity}× ${ingredient.itemKey}`)
                            .join(' + '),
                        }),
                      )
                      .join('\n'),
                  },
                ]
              : []),
            ...(buildings.length > 0
              ? [
                  {
                    name: context.t('world.encyclopedia_buildings_field'),
                    value: buildings
                      .slice(0, 5)
                      .map((building) =>
                        context.t('world.encyclopedia_building_line', {
                          emoji: building.emoji,
                          name: building.name,
                          description: building.description ?? '',
                        }),
                      )
                      .join('\n'),
                  },
                ]
              : []),
          ],
        }),
      ],
    });
  },
};

export const commands: Command[] = [meteo, saison, evenement, encyclopedie];
