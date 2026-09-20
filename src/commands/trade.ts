import { ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, button, row, successEmbed } from '../framework/ui';
import * as tradeService from '../services/trade.service';
import * as inventoryService from '../services/inventory.service';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import { gameError } from '../utils/errors';
import {
  discordTimestamp,
  formatCoins,
  formatNumber,
  qualityIcon,
  truncate,
} from '../utils/format';
import type { Command, CommandContext } from '../types';

/** Hôtel des ventes et échanges directs. */

const hdv: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('auction')
    .setDescription('Player-to-player auction house')
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Browse listings')
        .addStringOption((option) =>
          option.setName('item').setDescription('Filter by item').setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('sell')
        .setDescription('List a stack for sale')
        .addStringOption((option) =>
          option.setName('item').setDescription("The item").setRequired(true).setAutocomplete(true),
        )
        .addIntegerOption((option) =>
          option.setName('quantity').setDescription('Quantity').setRequired(true).setMinValue(1),
        )
        .addIntegerOption((option) =>
          option.setName('price').setDescription('Price for the whole stack').setRequired(true).setMinValue(1),
        )
        .addIntegerOption((option) =>
          option
            .setName('duration')
            .setDescription('Duration in hours')
            .addChoices(
              { name: '6 hours', value: 6 },
              { name: '12 hours', value: 12 },
              { name: '24 hours', value: 24 },
              { name: '48 hours', value: 48 },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('buy')
        .setDescription('Buy a listing')
        .addStringOption((option) =>
          option.setName('listing').setDescription("Listing ID").setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('my-listings').setDescription('Your listings and their status'))
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel a listing that has no bids')
        .addStringOption((option) =>
          option.setName('listing').setDescription("Listing ID").setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'sell': {
        const result = await tradeService.createListing(context.player, {
          itemKey: interaction.options.getString('item', true),
          quantity: interaction.options.getInteger('quantity', true),
          price: interaction.options.getInteger('price', true),
          durationHours: interaction.options.getInteger('duration') ?? undefined,
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('trade.sell_title'),
              [
                context.t('trade.sell_lot_line', {
                  quantity: result.quantity,
                  price: formatCoins(result.price, false, context.locale),
                }),
                context.t('trade.sell_fee_line', { fee: formatCoins(result.fee, false, context.locale) }),
                context.t('trade.sell_expiration_line', {
                  relative: discordTimestamp(result.expiresAt, 'R'),
                }),
                context.t('trade.sell_commission_line', {
                  rate: (context.balance.auction.commissionRate * 100).toFixed(0),
                }),
                '',
                context.t('trade.sell_id_line', { id: result.id }),
              ].join('\n'),
            ),
          ],
        });
        break;
      }
      case 'buy': {
        const result = await tradeService.buyout(
          context.player,
          interaction.options.getString('listing', true),
        );
        await interaction.editReply({
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
        break;
      }
      case 'cancel': {
        const result = await tradeService.cancelListing(
          context.player,
          interaction.options.getString('listing', true),
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('trade.cancel_title'),
              context.t('trade.cancel_body', { quantity: result.quantity, name: result.itemName }),
            ),
          ],
        });
        break;
      }
      case 'my-listings': {
        const listings = await tradeService.myListings(context.player.id, 10);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: context.t('trade.my_listings_title'),
              description:
                listings
                  .map((entry) => {
                    const status =
                      entry.listing.status === 'sold'
                        ? context.t('trade.status_sold', {
                            price: formatCoins(entry.listing.soldPrice ?? 0, false, context.locale),
                          })
                        : entry.listing.status === 'active'
                          ? context.t('trade.status_active', {
                              relative: discordTimestamp(entry.listing.expiresAt, 'R'),
                            })
                          : entry.listing.status === 'expired'
                            ? context.t('trade.status_expired')
                            : context.t('trade.status_cancelled');
                    return context.t('trade.my_listings_line', {
                      emoji: entry.itemEmoji,
                      quantity: entry.listing.quantity,
                      name: entry.itemName,
                      price: formatCoins(entry.listing.startPrice, false, context.locale),
                      status,
                      id: entry.listing.id,
                    });
                  })
                  .join('\n') || context.t('trade.my_listings_empty'),
              color: COLORS.info,
            }),
          ],
        });
        break;
      }
      default: {
        await interaction.editReply(
          await auctionListView(context, interaction.options.getString('item') ?? undefined, 1),
        );
      }
    }
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const entries = await inventoryRepo.listInventory(context.playerId, {});
    await interaction.respond(
      entries
        .filter((entry) => entry.tradable && (!query || entry.name.toLowerCase().includes(query)))
        .slice(0, 25)
        .map((entry) => ({
          name: truncate(`${entry.emoji} ${entry.name}${qualityIcon(entry.quality)} ×${entry.quantity}`, 100),
          value: entry.itemKey,
        })),
    );
  },
};

/** Vue paginée de l'hôtel des ventes, réutilisée par les boutons. */
export async function auctionListView(
  context: CommandContext,
  itemKey: string | undefined,
  page: number,
) {
  const result = await tradeService.browse(context.player.id, { itemKey, page }, context.locale);

  const t = context.t;
  const locale = context.locale;
  const embed = baseEmbed({
    title: t('trade.house_title'),
    description:
      result.listings
        .map((listing) => {
          const bid = listing.currentBid
            ? t('trade.bid_current', { price: formatCoins(listing.currentBid, false, locale) })
            : t('trade.bid_starting', { price: formatCoins(listing.startPrice, false, locale) });
          const buyout = listing.buyoutPrice
            ? t('trade.buyout_part', { price: formatCoins(listing.buyoutPrice, false, locale) })
            : '';
          return [
            `${listing.itemEmoji} **${listing.quantity}× ${listing.itemName}**${qualityIcon(listing.quality)}${listing.isOwn ? t('trade.own_listing_marker') : ''}`,
            `   ${t('trade.listing_line2', {
              bid,
              buyout,
              seller: listing.sellerName,
              relative: discordTimestamp(listing.expiresAt, 'R'),
            })}`,
            `   \`${listing.id}\``,
          ].join('\n');
        })
        .join('\n\n') || t('trade.house_empty'),
    color: COLORS.gold,
    footer: t('trade.house_footer', { total: result.total, page: result.page, totalPages: result.totalPages }),
  });

  const buyable = result.listings.filter((listing) => !listing.isOwn && listing.buyoutPrice);

  return {
    embeds: [embed],
    components: [
      ...(buyable.length > 0
        ? [
            (await import('../framework/ui')).selectRow(
              (await import('../framework/ui')).select({
                namespace: 'hdv',
                action: 'buy',
                ownerId: context.player.discordId,
                placeholder: t('trade.buy_placeholder'),
                choices: buyable.map((listing) => ({
                  label: truncate(`${listing.quantity}× ${listing.itemName} · ${listing.buyoutPrice} 🪙`, 90),
                  value: listing.id,
                  emoji: listing.itemEmoji,
                  description: t('trade.seller_line', { seller: listing.sellerName }),
                })),
              }),
            ),
          ]
        : []),
      (await import('../framework/ui')).paginationRow({
        namespace: 'hdv',
        ownerId: context.player.discordId,
        page: result.page,
        totalPages: result.totalPages,
        extraParams: [itemKey ?? 'all'],
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// /trade
// ---------------------------------------------------------------------------

const echange: Command = {
  category: 'economie',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Open a secure trade with another player')
    .addUserOption((option) =>
      option.setName('user').setDescription('Your trading partner').setRequired(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user', true);
    if (target.bot) throw gameError('target_invalid', context.t('trade.bots_no_trade'));

    const targetUser = await playerRepo.findUserByDiscordId(target.id);
    if (!targetUser) {
      throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
    }

    const trade = await tradeService.openTrade(context.player, targetUser.id);
    await interaction.editReply(tradeView(context, trade, target.displayName));
  },
};

/** Rendu d'un échange en cours, avec double confirmation. */
export function tradeView(
  context: CommandContext,
  trade: tradeService.TradeView,
  partnerName: string,
) {
  const t = context.t;
  const locale = context.locale;
  const mine = trade.items.filter((item) => item.userId === context.player.id);
  const theirs = trade.items.filter((item) => item.userId !== context.player.id);
  const isInitiator = trade.initiatorId === context.player.id;

  const format = (items: typeof mine, coins: number): string =>
    [
      ...items.map((item) => `${item.emoji} ${item.quantity}× ${item.name}`),
      coins > 0 ? t('trade.coins_line', { coins: formatNumber(coins, locale) }) : '',
    ]
      .filter(Boolean)
      .join('\n') || t('trade.nothing_yet');

  return {
    embeds: [
      baseEmbed({
        title: t('trade.view_title', { name: partnerName }),
        description: [
          t('trade.view_confirm_notice'),
          t('trade.view_expires_line', {
            relative: discordTimestamp(trade.expiresAt, 'R'),
            revision: trade.revision,
          }),
        ].join('\n'),
        color: COLORS.info,
        fields: [
          {
            // « Votre offre » doit refléter LA confirmation du spectateur : le
            // test précédent ne s'allumait que pour l'initiateur, si bien que le
            // partenaire ne voyait jamais sa propre coche.
            name: `${(isInitiator ? trade.initiatorConfirmed : trade.partnerConfirmed) ? '✅' : '⬜'} ${t('trade.your_offer_field')}`,
            value: format(mine, isInitiator ? trade.initiatorCoins : trade.partnerCoins),
            inline: true,
          },
          {
            name: `${(isInitiator ? trade.partnerConfirmed : trade.initiatorConfirmed) ? '✅' : '⬜'} ${t('trade.their_offer_field', { name: partnerName })}`,
            value: format(theirs, isInitiator ? trade.partnerCoins : trade.initiatorCoins),
            inline: true,
          },
        ],
      }),
    ],
    components: [
      row(
        button({
          namespace: 'trade',
          action: 'add_item',
          ownerId: context.player.discordId,
          params: [trade.id],
          label: t('trade.add_item_button'),
          emoji: '📦',
        }),
        button({
          namespace: 'trade',
          action: 'add_coins',
          ownerId: context.player.discordId,
          params: [trade.id],
          label: t('trade.add_coins_button'),
          emoji: '🪙',
        }),
        button({
          namespace: 'trade',
          action: 'confirm',
          ownerId: context.player.discordId,
          params: [trade.id, trade.revision],
          label: t('common.confirm'),
          emoji: '✅',
          style: ButtonStyle.Success,
        }),
        button({
          namespace: 'trade',
          action: 'cancel',
          ownerId: context.player.discordId,
          params: [trade.id],
          label: t('common.cancel'),
          emoji: '✖️',
          style: ButtonStyle.Danger,
        }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// /order — ordres d'achat permanents
// ---------------------------------------------------------------------------

const ordre: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('order')
    .setDescription('Standing buy orders on the auction house')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Buy automatically the next time a matching listing appears')
        .addStringOption((option) =>
          option.setName('item').setDescription('The item to buy').setRequired(true).setAutocomplete(true),
        )
        .addIntegerOption((option) =>
          option.setName('quantity').setDescription('Quantity wanted').setRequired(true).setMinValue(1),
        )
        .addIntegerOption((option) =>
          option
            .setName('max-unit-price')
            .setDescription('Maximum price per unit you are willing to pay')
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Your active standing orders'))
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel a standing order')
        .addStringOption((option) =>
          option.setName('order').setDescription('Order ID, shown by /order list').setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'create': {
        const created = await tradeService.createStandingOrder(context.player, {
          itemKey: interaction.options.getString('item', true),
          quantity: interaction.options.getInteger('quantity', true),
          maxUnitPrice: interaction.options.getInteger('max-unit-price', true),
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('trade.order_created_title'),
              context.t('trade.order_created_body', {
                emoji: created.itemEmoji,
                name: created.itemName,
                quantity: created.totalQuantity,
                price: formatCoins(created.maxUnitPrice, false, context.locale),
                relative: discordTimestamp(created.expiresAt, 'R'),
              }),
            ),
          ],
        });
        break;
      }
      case 'list': {
        const orders = await tradeService.listStandingOrders(context.player.id);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: context.t('trade.order_list_title'),
              description:
                orders
                  .map((order) =>
                    context.t('trade.order_list_line', {
                      emoji: order.itemEmoji,
                      name: order.itemName,
                      remaining: order.remainingQuantity,
                      total: order.totalQuantity,
                      price: formatCoins(order.maxUnitPrice, false, context.locale),
                      relative: discordTimestamp(order.expiresAt, 'R'),
                      id: order.id,
                    }),
                  )
                  .join('\n') || context.t('trade.order_list_empty'),
              color: COLORS.info,
            }),
          ],
        });
        break;
      }
      case 'cancel': {
        await tradeService.cancelStandingOrder(
          context.player,
          interaction.options.getString('order', true),
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('trade.order_cancelled_title'),
              context.t('trade.order_cancelled_body'),
            ),
          ],
        });
        break;
      }
    }
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    await interaction.respond(
      context.config.itemList
        .filter((item) => item.enabled && item.tradable && (!query || item.name.toLowerCase().includes(query)))
        .slice(0, 25)
        .map((item) => ({ name: truncate(`${item.emoji} ${item.name}`, 100), value: item.key })),
    );
  },
};

export const commands: Command[] = [hdv, echange, ordre];
export { inventoryService, MessageFlags };
