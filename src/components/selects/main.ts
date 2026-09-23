import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import { helpEmbed } from '../../commands/start';
import { sendMarketChart } from '../../commands/economy';
import { auctionListView } from '../../commands/trade';
import { COLORS, baseEmbed, quantityModal, successEmbed } from '../../framework/ui';
import { buildingsView, coopView, inventoryView, marketView } from '../../framework/views';
import { followUpEphemeral, replyEphemeral } from '../../framework/interaction';
import * as animalService from '../../services/animal.service';
import * as coopService from '../../services/coop.service';
import * as craftService from '../../services/craft.service';
import * as farmService from '../../services/farm.service';
import * as marketService from '../../services/market.service';
import * as progressionService from '../../services/progression.service';
import * as tradeService from '../../services/trade.service';
import { appendTracking, offSeasonAdvice } from '../../commands/farm';
import { discordTimestamp, formatCoins, formatNumber, gaugeBar } from '../../utils/format';
import type { SelectHandler } from '../../types';

/** Gestionnaires de menus déroulants. */

const inventoryCategory: SelectHandler = {
  namespace: 'inv',
  actions: ['category'],

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const category = interaction.values[0] ?? 'all';
    await interaction.editReply(
      await inventoryView(context, { category: category === 'all' ? undefined : category, page: 1 }),
    );
  },
};

const shopBuy: SelectHandler = {
  namespace: 'shop',
  actions: ['buy'],
  lockKey: 'shop-buy',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    const itemKey = interaction.values[0];
    if (!itemKey) {
      await interaction.deferUpdate();
      return;
    }

    // Le menu liste aussi les articles verrouillés ou épuisés (voir
    // `shopChoices`) : on les refuse ici, avant de demander une quantité.
    const entry = await marketService.findShopEntry(itemKey, context.now, context.locale);
    if (entry) marketService.assertPurchasable(context.player, entry);

    // Une quantité personnalisée est demandée par modal : plus souple qu'une
    // liste figée de boutons 1/5/10.
    await interaction.showModal(
      quantityModal(
        {
          namespace: 'shop',
          action: 'buy_qty',
          ownerId: interaction.user.id,
          params: [itemKey],
          title: context.t('shop.buy_qty_modal_title'),
          label: context.t('shop.buy_qty_modal_label'),
          placeholder: context.t('shop.buy_qty_modal_placeholder'),
        },
        context.locale,
        context.t,
      ),
    );
  },
};

const marketChart: SelectHandler = {
  namespace: 'market',
  actions: ['chart'],

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const itemKey = interaction.values[0];
    if (!itemKey) return;
    await sendMarketChart(interaction, context, itemKey);
  },
};

const plantSelect: SelectHandler = {
  namespace: 'farm',
  actions: ['plant'],
  lockKey: 'farm-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const cropKey = interaction.values[0];
    if (!cropKey) return;

    // Sans quantité : autant de parcelles libres que de graines possédées.
    const result = await farmService.plant(context.player, { cropKey });
    const embed = successEmbed(
      context.t('farm.plant_success_title', { emoji: result.emoji, cropName: result.cropName }),
      [
        context.t('farm.plant_select_slots', {
          count: result.slots.length,
          slots: result.slots.map((slot) => `\`${slot}\``).join(' '),
        }),
        context.t('farm.plant_select_harvest', { relative: discordTimestamp(result.readyAt, 'R') }),
        result.offSeason ? context.t('farm.plant_select_off_season') : '',
        offSeasonAdvice(result, context.t),
      ]
        .filter(Boolean)
        .join('\n'),
    );
    appendTracking(embed, result.tracking, context.t);
    await followUpEphemeral(interaction, { embeds: [embed] });
  },
};

const animalPet: SelectHandler = {
  namespace: 'animal',
  actions: ['pet'],
  lockKey: 'animal-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const animalId = interaction.values[0];
    if (!animalId) return;

    const result = await animalService.pet(context.player, animalId);
    await followUpEphemeral(interaction, {
      embeds: [
        successEmbed(
          context.t('animals.pet_title', { emoji: result.emoji, name: result.name }),
          context.t('animals.pet_body', {
            gain: result.gain,
            bar: gaugeBar(result.happiness, 8),
            happiness: result.happiness,
          }),
        ),
      ],
    });
  },
};

const buildingUpgrade: SelectHandler = {
  namespace: 'build',
  actions: ['upgrade'],
  lockKey: 'build-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const buildingKey = interaction.values[0];
    if (!buildingKey) return;

    const result = await craftService.buildOrUpgrade(context.player, buildingKey);
    await followUpEphemeral(interaction, {
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
            context.t('craft.build_cost_line', { cost: formatCoins(result.costCoins, false, context.locale) }),
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
    await interaction.editReply(await buildingsView(context));
  },
};

const questReroll: SelectHandler = {
  namespace: 'quest',
  actions: ['reroll'],
  lockKey: 'quest-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const questId = interaction.values[0];
    if (!questId) return;

    const result = await progressionService.rerollQuest(context.player, questId);
    await followUpEphemeral(interaction, {
      embeds: [
        successEmbed(
          context.t('quests.reroll_result_title'),
          `${
            result.usedToken
              ? context.t('quests.reroll_token_used')
              : context.t('quests.reroll_cost_line', { cost: formatCoins(result.cost, false, context.locale) })
          }\n\n**${result.newQuest.title}**\n${result.newQuest.description}`,
        ),
      ],
    });
    const { questsView } = await import('../../framework/views');
    await interaction.editReply(await questsView(context));
  },
};

const coopJoin: SelectHandler = {
  namespace: 'coop',
  actions: ['join'],
  lockKey: 'coop-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const tag = interaction.values[0];
    if (!tag) return;

    const info = await coopService.joinCoop(context.player, tag);
    await followUpEphemeral(interaction, {
      embeds: [
        successEmbed(
          context.t('coop.join_title', { emblem: info.emblem, name: info.name }),
          context.t('coop.join_body', { level: info.level }),
        ),
      ],
    });
    await interaction.editReply(await coopView({ ...context, player: { ...context.player, coopId: info.id } }));
  },
};

const auctionBuy: SelectHandler = {
  namespace: 'hdv',
  actions: ['buy'],
  lockKey: 'hdv-buy',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const listingId = interaction.values[0];
    if (!listingId) return;

    const result = await tradeService.buyout(context.player, listingId);
    await followUpEphemeral(interaction, {
      embeds: [
        successEmbed(
          context.t('trade.buy_title'),
          context.t('trade.buy_body', {
            quantity: result.quantity,
            emoji: result.emoji,
            name: result.itemName,
            price: formatCoins(result.price, false, context.locale),
          }),
        ),
      ],
    });
    await interaction.editReply(await auctionListView(context, undefined, 1));
  },
};

const helpCategory: SelectHandler = {
  namespace: 'help',
  actions: ['category'],

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [helpEmbed(interaction.values[0] as never, context.locale, context.t)],
    });
  },
};

export const handlers: SelectHandler[] = [
  inventoryCategory,
  shopBuy,
  marketChart,
  plantSelect,
  animalPet,
  buildingUpgrade,
  questReroll,
  coopJoin,
  auctionBuy,
  helpCategory,
];

export { baseEmbed, COLORS, marketService, marketView, replyEphemeral };
