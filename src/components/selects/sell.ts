import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import { sellResultEmbed } from '../../commands/economy';
import * as marketService from '../../services/market.service';
import type { SelectHandler } from '../../types';

/** Menu de vente de l'inventaire : vend toutes les piles de l'objet choisi. */
const sellItem: SelectHandler = {
  namespace: 'sell',
  actions: ['item'],
  lockKey: 'sell-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const itemKey = interaction.values[0];
    if (!itemKey) return;
    const result = await marketService.sell(context.player, {
      itemKey,
      quantity: 'all',
      discordGuildId: context.discordGuildId,
    });
    await interaction.editReply({ embeds: [sellResultEmbed(result, context.t, context.locale)] });
  },
};

export const handlers = [sellItem];
