import { ButtonStyle, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, button, row, select, selectRow } from '../framework/ui';
import { safeReply } from '../framework/interaction';
import type { View } from '../framework/views';
import { SEASON_LABELS } from '../game/world';
import * as eventService from '../services/event.service';
import { describeItems } from '../services/inventory.service';
import { describeNextSeason, getWorldState } from '../services/world.service';
import {
  discordTimestamp,
  formatCoins,
  formatNumber,
  formatPercent,
  progressBar,
  truncate,
} from '../utils/format';
import type { Command, CommandContext } from '../types';

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

/** Monnaie d'un article de boutique d'événement : icône de jeton, ou pièces. */
function eventPrice(
  amount: number,
  currencyItemKey: string | null,
  context: Pick<CommandContext, 'config' | 'locale'>,
): string {
  if (!currencyItemKey) return formatCoins(amount, false, context.locale);
  const currency = context.config.items.get(currencyItemKey);
  return `${formatNumber(amount, context.locale)} ${currency?.emoji ?? '🎟️'}`;
}

/**
 * Vue de `/event` : modificateurs, paliers (bouton de réclamation) et boutique
 * (menu d'achat). Réutilisée par les composants pour se rafraîchir après une
 * réclamation ou un achat.
 */
export async function eventView(context: CommandContext, ownerId: string): Promise<View> {
  const { t, locale } = context;
  const world = await getWorldState(context.now, locale);

  if (world.activeEvents.length === 0) {
    return {
      embeds: [
        baseEmbed({
          title: t('world.event_none_title'),
          description: t('world.event_none_body', {
            list: context.config.eventList
              .filter((event) => event.enabled)
              .map((event) =>
                t('world.event_calendar_line', {
                  name: event.name,
                  description: event.description,
                }),
              )
              .join('\n'),
          }),
          color: COLORS.info,
        }),
      ],
      components: [],
    };
  }

  // L'événement « principal » est celui qui a des paliers ou une boutique : un
  // week-end doublé qui chevauche la Moisson ne doit pas masquer cette dernière.
  const event =
    world.activeEvents.find((entry) => entry.rewardTiers.length > 0 || entry.shopItems.length > 0) ??
    world.activeEvents[0]!;
  const others = world.activeEvents.filter((entry) => entry.key !== event.key);
  const status = await eventService.getEventStatus(context.player.id, event, locale);

  const fields = [
    {
      name: t('world.event_modifiers_field'),
      value:
        [
          event.modifiers.xpMultiplier
            ? t('world.event_xp_line', { multiplier: event.modifiers.xpMultiplier })
            : '',
          event.modifiers.growthMultiplier
            ? t('world.event_growth_line', { multiplier: event.modifiers.growthMultiplier })
            : '',
          event.modifiers.globalPriceMultiplier
            ? t('world.event_prices_line', { multiplier: event.modifiers.globalPriceMultiplier })
            : '',
          event.modifiers.mutationMultiplier
            ? t('world.event_mutations_line', { multiplier: event.modifiers.mutationMultiplier })
            : '',
          event.modifiers.waterMultiplier
            ? t('world.event_water_line', { multiplier: event.modifiers.waterMultiplier })
            : '',
        ]
          .filter(Boolean)
          .join('\n') || t('world.event_modifiers_none'),
    },
    {
      name: t('world.event_progress_field'),
      value: [
        t('world.event_points_value', { points: formatNumber(status.points, locale) }),
        Object.keys(status.balances).length > 0
          ? t('event.balance_line', {
              balances: Object.entries(status.balances)
                .map(([itemKey, amount]) => eventPrice(amount, itemKey, context))
                .join(' · '),
            })
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      name: t('world.event_reward_tiers_field'),
      value:
        event.rewardTiers
          .map((tier) => {
            const claimed = status.claimedTiers.includes(tier.points);
            const rewards = [
              tier.rewards.coins ? formatCoins(tier.rewards.coins, true, locale) : '',
              tier.rewards.gems ? `${tier.rewards.gems} 💎` : '',
              tier.rewards.items?.length ? describeItems(tier.rewards.items, locale) : '',
              tier.rewards.title
                ? t('world.event_reward_title_part', { title: tier.rewards.title })
                : '',
            ]
              .filter(Boolean)
              .join(' · ');
            return t('world.event_tier_line', {
              icon: claimed ? '✅' : status.points >= tier.points ? '🎁' : '🔒',
              points: formatNumber(tier.points, locale),
              rewards,
            });
          })
          .join('\n') || t('world.event_no_tier'),
    },
  ];

  if (status.shop.length > 0) {
    fields.push({
      name: t('event.shop_field'),
      value: truncate(
        status.shop
          .map((entry) =>
            t('event.shop_line', {
              emoji: entry.emoji,
              name: entry.name,
              price: eventPrice(entry.price, entry.currencyItemKey, context),
              remaining: entry.remaining,
              limit: entry.limit,
            }),
          )
          .join('\n'),
        1000,
      ),
    });
  }
  if (others.length > 0) {
    fields.push({
      name: t('event.also_active_field'),
      value: others.map((entry) => entry.name).join(' · '),
    });
  }

  const components: Array<ReturnType<typeof row> | ReturnType<typeof selectRow>> = [];
  if (status.claimableTiers.length > 0) {
    components.push(
      row(
        button({
          namespace: 'event',
          action: 'claim',
          ownerId,
          params: [event.key],
          label: t('event.claim_button', { count: status.claimableTiers.length }),
          emoji: '🎁',
          style: ButtonStyle.Success,
        }),
      ),
    );
  }
  if (status.shop.length > 0) {
    components.push(
      selectRow(
        select({
          namespace: 'event',
          action: 'buy',
          ownerId,
          params: [event.key],
          placeholder: t('event.buy_placeholder'),
          choices: status.shop.slice(0, 25).map((entry) => ({
            label: truncate(
              `${entry.name} · ${eventPrice(entry.price, entry.currencyItemKey, context)}`,
              100,
            ),
            value: entry.itemKey,
            emoji: entry.emoji,
            description: truncate(
              entry.remaining > 0
                ? t('event.buy_option_description', { remaining: entry.remaining, limit: entry.limit })
                : t('event.buy_option_sold_out'),
              100,
            ),
          })),
        }),
      ),
    );
  }

  return {
    embeds: [
      baseEmbed({
        title: `🎪 ${event.name}`,
        description: event.endsAt
          ? `${event.description}\n${t('event.ends_line', { relative: discordTimestamp(new Date(event.endsAt), 'R') })}`
          : event.description,
        color: COLORS.gold,
        fields,
      }),
    ],
    components,
  };
}

const evenement: Command = {
  category: 'monde',
  requiresAccount: false,
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('Active event: rewards to claim and event shop')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(await eventView(context, interaction.user.id));
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
                            .map((ingredient) => describeItems([ingredient], context.locale))
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
