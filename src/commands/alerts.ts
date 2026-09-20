import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import * as alertService from '../services/alert.service';
import * as marketService from '../services/market.service';
import { discordTimestamp, formatCoins, formatNumber, truncate } from '../utils/format';
import type { AlertDirection } from '../game/alerts';
import type { Command } from '../types';

/**
 * `/alert` — alertes de prix sur le marché dynamique.
 *
 * Tout est éphémère : une alerte est un réglage personnel, comme `/settings`,
 * et son identifiant n'a rien à faire dans le salon.
 */

const alerte: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('alert')
    .setDescription('Price alerts: get a DM when the market crosses your threshold')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Be notified when an item reaches a market price')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('The market-tracked item')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('price')
            .setDescription('Threshold market price per unit, in coins')
            .setRequired(true)
            .setMinValue(1),
        )
        .addStringOption((option) =>
          option
            .setName('direction')
            .setDescription('Fire when the price goes above or below the threshold')
            .setRequired(true)
            .addChoices(
              { name: 'Above or equal (sell high)', value: 'above' },
              { name: 'Below or equal (buy low)', value: 'below' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Your active price alerts'))
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Remove a price alert')
        .addStringOption((option) =>
          option
            .setName('alert')
            .setDescription('Alert ID shown by /alert list (the first 8 characters are enough)')
            .setRequired(true)
            .setAutocomplete(true)
            .setMaxLength(40),
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const t = context.t;
    const locale = context.locale;

    switch (sub) {
      case 'create': {
        const created = await alertService.createAlert(
          context.player,
          {
            itemKey: interaction.options.getString('item', true),
            threshold: interaction.options.getInteger('price', true),
            direction: interaction.options.getString('direction', true) as AlertDirection,
          },
          context.now,
        );
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: t('alerts.created_title'),
              description: [
                t('alerts.created_body', {
                  emoji: created.itemEmoji,
                  name: created.itemName,
                  symbol: created.symbol,
                  threshold: formatCoins(created.threshold, false, locale),
                  price: formatCoins(created.currentPrice ?? 0, false, locale),
                  relative: discordTimestamp(created.expiresAt, 'R'),
                  id: created.shortId,
                }),
                created.alreadyMet
                  ? t('alerts.created_already_met', { when: discordTimestamp(created.nextUpdateAt, 'R') })
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
              color: COLORS.success,
              footer: t('alerts.created_footer'),
            }),
          ],
        });
        break;
      }
      case 'delete': {
        const removed = await alertService.deleteAlert(
          context.player,
          interaction.options.getString('alert', true),
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              t('alerts.deleted_title'),
              t('alerts.deleted_body', {
                emoji: removed.itemEmoji,
                name: removed.itemName,
                symbol: removed.symbol,
                threshold: formatCoins(removed.threshold, false, locale),
              }),
            ),
          ],
        });
        break;
      }
      default: {
        const alerts = await alertService.listAlerts(context.player.id, locale);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: t('alerts.list_title'),
              description:
                alerts
                  .map((alert) =>
                    t('alerts.list_line', {
                      emoji: alert.itemEmoji,
                      name: alert.itemName,
                      symbol: alert.symbol,
                      threshold: formatCoins(alert.threshold, false, locale),
                      price: alert.currentPrice === null ? '?' : formatCoins(alert.currentPrice, false, locale),
                      relative: discordTimestamp(alert.expiresAt, 'R'),
                      id: alert.shortId,
                    }),
                  )
                  .join('\n\n') || t('alerts.list_empty'),
              color: COLORS.info,
              footer: t('alerts.list_footer', {
                count: alerts.length,
                max: context.balance.alerts.maxPerUser,
              }),
            }),
          ],
        });
      }
    }
  },

  async autocomplete(interaction, context): Promise<void> {
    const focused = interaction.options.getFocused(true);
    const query = focused.value.toString().toLowerCase();

    if (focused.name === 'alert') {
      if (!context.playerId) {
        await interaction.respond([]);
        return;
      }
      const alerts = await alertService.listAlerts(context.playerId, context.locale);
      await interaction.respond(
        alerts
          .filter(
            (alert) =>
              !query ||
              alert.itemName.toLowerCase().includes(query) ||
              alert.shortId.startsWith(query.replace(/`/g, '')),
          )
          .slice(0, 25)
          .map((alert) => ({
            name: truncate(
              `${alert.itemEmoji} ${alert.itemName} ${alert.symbol} ${formatNumber(alert.threshold, context.locale)} 🪙 · ${alert.shortId}`,
              100,
            ),
            value: alert.shortId,
          })),
      );
      return;
    }

    // Même source que `/market-history` : seuls les objets suivis par le marché
    // ont un prix dynamique, et afficher le prix courant aide à choisir un seuil.
    const rows = await marketService.getMarket({}, context.locale);
    await interaction.respond(
      rows
        .filter((row) => !query || row.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((row) => ({
          name: truncate(
            `${row.emoji} ${row.name} · ${formatNumber(row.price, context.locale)} 🪙 (${row.trendLabel})`,
            100,
          ),
          value: row.itemKey,
        })),
    );
  },
};

export const commands: Command[] = [alerte];
