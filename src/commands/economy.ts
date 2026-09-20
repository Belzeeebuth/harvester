import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import { safeReply } from '../framework/interaction';
import { inventoryView, marketView, shopView } from '../framework/views';
import { NO_IMAGE, renderChartImage } from '../render';
import * as economyService from '../services/economy.service';
import * as marketService from '../services/market.service';
import * as inventoryService from '../services/inventory.service';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import { gameError } from '../utils/errors';
import {
  COIN,
  discordTimestamp,
  formatCoins,
  formatCompact,
  formatNumber,
  formatPercent,
  qualityIcon,
  truncate,
} from '../utils/format';
import { appendTracking } from './farm';
import { translatorFor } from '../i18n';
import type { Command } from '../types';

/** Boutique, marché, vente, banque, dons et inventaire. */

// ---------------------------------------------------------------------------
// /shop et /buy
// ---------------------------------------------------------------------------

const boutique: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Village shop, restocked every day')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter the shop')
        .addChoices(
          { name: "✨ Today's deals", value: 'daily' },
          { name: '🌱 Seeds', value: 'seeds' },
          { name: '📦 Supplies', value: 'supplies' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(
      await shopView(context, interaction.options.getString('category') ?? undefined),
    );
  },
};

const acheter: Command = {
  category: 'economie',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy an item from the shop')
    .addStringOption((option) =>
      option.setName('item').setDescription("The item to buy").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('How many?').setMinValue(1).setMaxValue(999),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await marketService.buy(context.player, {
      itemKey: interaction.options.getString('item', true),
      quantity: interaction.options.getInteger('quantity') ?? 1,
      discordGuildId: context.discordGuildId,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('shop.purchase_title'),
          context.t('shop.buy_body', {
            quantity: result.quantity,
            emoji: result.emoji,
            name: result.name,
            amount:
              result.currency === 'gems'
                ? `${formatNumber(result.total, context.locale)} 💎`
                : formatCoins(result.total, false, context.locale),
            stock: result.stockRemaining >= 999 ? context.t('common.unlimited') : result.stockRemaining,
          }),
        ),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    const t = translatorFor(context.locale);
    const query = interaction.options.getFocused().toString().toLowerCase();
    const entries = await marketService.getShop(new Date(), context.locale);
    await interaction.respond(
      entries
        .filter((entry) => !query || entry.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((entry) => ({
          name: truncate(
            `${entry.emoji} ${entry.name} · ${formatNumber(entry.price, context.locale)} ${entry.currency === 'gems' ? t('common.gems') : t('common.coins')}`,
            100,
          ),
          value: entry.itemKey,
        })),
    );
  },
};

// ---------------------------------------------------------------------------
// /sell
// ---------------------------------------------------------------------------

const vendre: Command = {
  category: 'economie',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Sell items to the village')
    .addStringOption((option) =>
      option.setName('item').setDescription("The item to sell").setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('quantity').setDescription('A number, or "all"').setMaxLength(10),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const itemKey = interaction.options.getString('item', true);
    const raw = (interaction.options.getString('quantity') ?? 'tout').toLowerCase();
    const quantity = raw === 'tout' || raw === 'all' ? ('all' as const) : Number.parseInt(raw, 10);

    if (quantity !== 'all' && (!Number.isFinite(quantity) || quantity <= 0)) {
      throw gameError('quantity_invalid', context.t('economy.invalid_quantity_or_all'));
    }

    const result = await marketService.sell(context.player, {
      itemKey,
      quantity,
      discordGuildId: context.discordGuildId,
    });

    const embed = successEmbed(
      context.t('economy.sell_title'),
      result.lines
        .map(
          (line) =>
            `${line.emoji} **${formatNumber(line.quantity, context.locale)}× ${line.name}**${qualityIcon(line.quality)} · ${formatNumber(line.unitPrice, context.locale)} ${COIN}/u`,
        )
        .join('\n'),
    );
    embed.addFields({
      name: context.t('common.total'),
      value: context.t('economy.sell_total', {
        gross: formatCoins(result.gross, false, context.locale),
        taxPart:
          result.tax > 0
            ? context.t('economy.sell_tax_part', { tax: formatCoins(result.tax, false, context.locale) })
            : '',
        net: formatCoins(result.net, false, context.locale),
      }),
    });
    appendTracking(embed, result.tracking, context.t);

    await interaction.editReply({ embeds: [embed] });
  },

  async autocomplete(interaction, context): Promise<void> {
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const query = interaction.options.getFocused().toString().toLowerCase();
    const entries = await inventoryRepo.listInventory(context.playerId, { onlySellable: true });
    await interaction.respond(
      entries
        .filter((entry) => !query || entry.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((entry) => ({
          name: truncate(
            `${entry.emoji} ${entry.name}${qualityIcon(entry.quality)} ×${entry.quantity} · ~${formatNumber(entry.sellPrice, context.locale)} 🪙/u`,
            100,
          ),
          value: entry.itemKey,
        })),
    );
  },
};

// ---------------------------------------------------------------------------
// /market et /market-history
// ---------------------------------------------------------------------------

const marche: Command = {
  category: 'economie',
  cooldown: { seconds: 5, bucket: 'market' },
  data: new SlashCommandBuilder()
    .setName('market')
    .setDescription('Market prices and trends')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter by product type')
        .addChoices(
          { name: '🌾 Harvests', value: 'harvest' },
          { name: '🥚 Animal products', value: 'animal_product' },
          { name: '🧀 Processed goods', value: 'product' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(
      await marketView(context, interaction.options.getString('category') ?? undefined),
    );
  },
};

const marcheHistorique: Command = {
  category: 'economie',
  cooldown: { seconds: 5, bucket: 'market' },
  data: new SlashCommandBuilder()
    .setName('market-history')
    .setDescription("Price history chart for a product")
    .addStringOption((option) =>
      option.setName('item').setDescription('The product to analyse').setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await sendMarketChart(interaction, context, interaction.options.getString('item', true));
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    const rows = await marketService.getMarket({}, context.locale);
    await interaction.respond(
      rows
        .filter((row) => !query || row.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((row) => ({
          name: truncate(`${row.emoji} ${row.name} · ${formatNumber(row.price, context.locale)} 🪙 (${row.trendLabel})`, 100),
          value: row.itemKey,
        })),
    );
  },
};

/** Envoie le graphique de marché d'un produit (réutilisé par le menu déroulant). */
export async function sendMarketChart(
  interaction: { editReply: (payload: import('discord.js').InteractionEditReplyOptions) => Promise<unknown> },
  context: import('../types').CommandContext,
  itemKey: string,
): Promise<void> {
  const item = inventoryService.requireItem(itemKey, context.locale);
  const rows = await marketService.getMarket({}, context.locale);
  const row = rows.find((entry) => entry.itemKey === itemKey);
  if (!row) throw gameError('not_found', context.t('market.not_tracked', { item: item.name }));

  const points = await marketService.getPriceHistory(itemKey);
  const image = context.player.compactMode
    ? NO_IMAGE
    : await renderChartImage({
        locale: context.locale,
        title: item.name,
        emoji: item.emoji,
        points: points.length > 0 ? points : [{ price: row.price, recordedAt: new Date() }],
        basePrice: row.basePrice,
        currentPrice: row.price,
        trend: row.trend,
        demandIndex: row.demandIndex,
      });

  await interaction.editReply({
    embeds: [
      baseEmbed({
        title: context.t('market.chart_title', { emoji: item.emoji, name: item.name }),
        description: [
          context.t('market.chart_current_price', {
            price: formatNumber(row.price, context.locale),
            coin: COIN,
            emoji: row.trendEmoji,
            label: row.trendLabel,
            percent: formatPercent(row.trend, undefined, context.locale),
          }),
          context.t('market.chart_base_price', {
            price: formatNumber(row.basePrice, context.locale),
            coin: COIN,
          }),
          context.t('market.chart_demand_index', {
            index: row.demandIndex.toFixed(2),
            status:
              row.demandIndex > 1
                ? context.t('market.demand_shortage')
                : context.t('market.demand_saturated'),
          }),
          context.t('market.next_update', { when: discordTimestamp(row.nextUpdateAt, 'R') }),
        ].join('\n'),
        color: row.trend >= 0 ? COLORS.success : COLORS.danger,
        // Image laissée en pièce jointe libre, hors de l'embed : voir la note
        // détaillée dans `farmView` (src/framework/views.ts). Un embed rend
        // l'image à sa propre largeur (~400 px) ; celle-ci en fait 900 px.
      }),
    ],
    files: image.attachment ? [image.attachment] : [],
  });
}

// ---------------------------------------------------------------------------
// /inventory, /item, /use, /discard
// ---------------------------------------------------------------------------

const inventaire: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Your inventory, paged by category')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter')
        .addChoices(
          { name: '🌱 Seeds', value: 'seed' },
          { name: '🌾 Harvests', value: 'harvest' },
          { name: '🥚 Animal products', value: 'animal_product' },
          { name: '🧀 Processed goods', value: 'product' },
          { name: '🛠️ Tools', value: 'tool' },
          { name: '🧪 Consumables', value: 'consumable' },
          { name: '🪵 Materials', value: 'material' },
          { name: '🎨 Cosmetics', value: 'cosmetic' },
          { name: '🎉 Event', value: 'event' },
          { name: '🐟 Fish', value: 'fish' },
          { name: '🪨 Ore', value: 'ore' },
        ),
    )
    .addIntegerOption((option) => option.setName('page').setDescription('Page').setMinValue(1))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(
      await inventoryView(context, {
        category: interaction.options.getString('category') ?? undefined,
        page: interaction.options.getInteger('page') ?? 1,
      }),
    );
  },
};

const objet: Command = {
  category: 'inventaire',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('item')
    .setDescription("Detailed item sheet")
    .addStringOption((option) =>
      option.setName('name').setDescription("The item").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const item = inventoryService.requireItem(
      interaction.options.getString('name', true),
      context.locale,
    );
    const market = await marketService.getMarket({}, context.locale);
    const price = market.find((row) => row.itemKey === item.key);
    const owned = context.player.farmId
      ? await inventoryService.count(context.player.id, item.key)
      : 0;

    const usedIn = context.config.recipeList.filter((recipe) =>
      (recipe.ingredients as Array<{ itemKey: string }>).some(
        (ingredient) => ingredient.itemKey === item.key,
      ),
    );
    const producedBy = context.config.recipeList.filter((recipe) => recipe.outputItemKey === item.key);

    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: `${item.emoji} ${item.name}`,
          description: item.description ?? context.t('economy.item_no_description'),
          color: COLORS.info,
          fields: [
            {
              name: context.t('economy.item_info_field'),
              value: [
                context.t('economy.item_category_line', {
                  category: context.t(`inventory.categories.${item.category}`),
                }),
                context.t('economy.item_rarity_line', {
                  rarity: context.t(`common.rarity.${item.rarity}`),
                }),
                item.basePrice > 0
                  ? context.t('economy.item_buy_line', {
                      price: `${formatNumber(item.basePrice, context.locale)} ${COIN}`,
                    })
                  : '',
                item.sellable
                  ? context.t('economy.item_sell_line', {
                      price: `${formatNumber(price?.price ?? item.sellPrice, context.locale)} ${COIN}`,
                    })
                  : context.t('economy.item_not_sellable'),
                item.tradable ? context.t('economy.item_tradable') : context.t('economy.item_not_tradable'),
                context.t('economy.item_owned_line', { owned: formatNumber(owned, context.locale) }),
              ]
                .filter(Boolean)
                .join('\n'),
              inline: true,
            },
            ...(producedBy.length > 0
              ? [
                  {
                    name: context.t('economy.item_crafted_by_field'),
                    value: producedBy.map((recipe) => `${recipe.emoji} \`${recipe.name}\``).join('\n'),
                    inline: true,
                  },
                ]
              : []),
            ...(usedIn.length > 0
              ? [
                  {
                    name: context.t('economy.item_used_in_field'),
                    value: usedIn
                      .slice(0, 8)
                      .map((recipe) => `${recipe.emoji} \`${recipe.name}\``)
                      .join('\n'),
                    inline: true,
                  },
                ]
              : []),
          ],
        }),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    await interaction.respond(
      context.config.itemList
        .filter((item) => item.enabled && (!query || item.name.toLowerCase().includes(query)))
        .slice(0, 25)
        .map((item) => ({ name: truncate(`${item.emoji} ${item.name}`, 100), value: item.key })),
    );
  },
};

const utiliser: Command = {
  category: 'inventaire',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('use')
    .setDescription('Use a consumable item')
    .addStringOption((option) =>
      option.setName('item').setDescription("The item to use").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('How many?').setMinValue(1).setMaxValue(50),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const itemKey = interaction.options.getString('item', true);
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const item = inventoryService.requireItem(itemKey, context.locale);

    if (!item.effect?.type) {
      throw gameError(
        'item_unknown',
        context.t('errors.consumable.not_directly_usable', { item: item.name }),
      );
    }

    const { useConsumable } = await import('../services/consumable.service');
    const result = await useConsumable(context.player, itemKey, quantity);

    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('economy.use_title', { emoji: item.emoji, name: item.name }),
          result.message,
        ),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const query = interaction.options.getFocused().toString().toLowerCase();
    const entries = await inventoryRepo.listInventory(context.playerId, { category: 'consumable' });
    await interaction.respond(
      entries
        .filter((entry) => !query || entry.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((entry) => ({
          name: truncate(`${entry.emoji} ${entry.name} ×${entry.quantity}`, 100),
          value: entry.itemKey,
        })),
    );
  },
};

const jeter: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('discard')
    .setDescription('Permanently discard items')
    .addStringOption((option) =>
      option.setName('item').setDescription("The item to discard").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('How many?').setRequired(true).setMinValue(1),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const itemKey = interaction.options.getString('item', true);
    const quantity = interaction.options.getInteger('quantity', true);
    const item = inventoryService.requireItem(itemKey, context.locale);

    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: context.t('economy.discard_confirm_title'),
          description: context.t('economy.discard_confirm_body', {
            quantity,
            emoji: item.emoji,
            name: item.name,
          }),
          color: COLORS.warning,
        }),
      ],
      components: [
        (await import('../framework/ui')).confirmRow(
          {
            namespace: 'inv',
            action: 'discard',
            ownerId: interaction.user.id,
            params: [itemKey, quantity],
            confirmLabel: context.t('economy.discard_button'),
            danger: true,
          },
          context.locale,
          context.t,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },

  autocomplete: vendre.autocomplete,
};

// ---------------------------------------------------------------------------
// /bank et /gift
// ---------------------------------------------------------------------------

const banque: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('bank')
    .setDescription('Your bank: deposits, withdrawals, upgrades')
    .addSubcommand((sub) => sub.setName('balance').setDescription('Check your balance'))
    .addSubcommand((sub) =>
      sub
        .setName('deposit')
        .setDescription('Deposit coins')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('withdraw')
        .setDescription('Withdraw coins')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName('upgrade').setDescription('Upgrade your bank'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();

    if (sub === 'deposit' || sub === 'withdraw') {
      const amount = interaction.options.getInteger('amount', true);
      const result =
        sub === 'deposit'
          ? await economyService.deposit(context.player.id, amount)
          : await economyService.withdraw(context.player.id, amount);

      await interaction.editReply({
        embeds: [
          successEmbed(
            sub === 'deposit'
              ? context.t('economy.bank_deposit_title')
              : context.t('economy.bank_withdraw_title'),
            context.t('economy.bank_result_body', {
              balance: formatCoins(result.balance, false, context.locale),
              capacity: formatCompact(result.capacity, context.locale),
              wallet: formatCoins(result.walletBalance, false, context.locale),
            }),
          ),
        ],
      });
      return;
    }

    if (sub === 'upgrade') {
      const result = await economyService.upgradeBank(context.player.id, context.player.level);
      await interaction.editReply({
        embeds: [
          successEmbed(
            context.t('economy.bank_upgrade_title'),
            context.t('economy.bank_upgrade_body', {
              tier: result.tier,
              capacity: formatCoins(result.capacity, false, context.locale),
            }),
          ),
        ],
      });
      return;
    }

    const status = await economyService.bankStatus(context.player.id);
    const nextTier = context.balance.bank.tiers.find((tier) => tier.tier === status.tier + 1);

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: context.t('economy.bank_status_title'),
          description: [
            context.t('economy.bank_account_line', {
              balance: formatCoins(status.balance, false, context.locale),
              capacity: formatCompact(status.capacity, context.locale),
            }),
            context.t('economy.bank_wallet_line', {
              wallet: formatCoins(status.walletBalance, false, context.locale),
            }),
            context.t('economy.bank_interest_line', {
              rate: (status.interestRate * 100).toFixed(2),
            }),
            '',
            context.t('economy.bank_status_footer_line'),
            nextTier
              ? `\n${context.t('economy.bank_next_tier', {
                  level: nextTier.requiredLevel,
                  cost: formatCoins(nextTier.upgradeCost, false, context.locale),
                  capacity: formatCompact(nextTier.capacity, context.locale),
                })}`
              : `\n${context.t('economy.bank_max_tier')}`,
          ].join('\n'),
          color: COLORS.gold,
        }),
      ],
    });
  },
};

const donner: Command = {
  category: 'economie',
  cooldown: { seconds: 10 },
  data: new SlashCommandBuilder()
    .setName('gift')
    .setDescription('Send coins to another farmer')
    .addUserOption((option) =>
      option.setName('user').setDescription('The recipient').setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName('amount').setDescription('Amount in coins').setRequired(true).setMinValue(1),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);

    if (target.bot) throw gameError('target_invalid', context.t('economy.bots_no_wallet'));
    const targetUser = await playerRepo.findUserByDiscordId(target.id);
    if (!targetUser) {
      throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
    }

    const result = await economyService.gift(context.player, targetUser.id, amount, {
      discordGuildId: context.discordGuildId,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('economy.gift_title'),
          context.t('economy.gift_body', {
            target: target.toString(),
            received: formatCoins(result.received, false, context.locale),
            tax: formatCoins(result.tax, false, context.locale),
            rate: (context.balance.economy.giftTaxRate * 100).toFixed(0),
          }),
        ),
      ],
    });
  },
};

export const commands: Command[] = [
  boutique,
  acheter,
  vendre,
  marche,
  marcheHistorique,
  inventaire,
  objet,
  utiliser,
  jeter,
  banque,
  donner,
];
