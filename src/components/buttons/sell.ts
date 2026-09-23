import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { sellResultEmbed } from '../../commands/economy';
import * as marketService from '../../services/market.service';
import { paramString } from '../../utils/custom-id';
import type { ButtonHandler } from '../../types';

/**
 * Bouton « vendre la récolte » : sous la réponse de `/harvest` (objets
 * récoltés dans l'identifiant) et dans le menu de vente de l'inventaire (toute
 * la catégorie « récoltes »). Les piles verrouillées ne partent jamais.
 */
const sellButtons: ButtonHandler = {
  namespace: 'sell',
  actions: ['harvest'],
  lockKey: 'sell-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const itemKeys = paramString(parsed, 0, '')
      .split('|')
      .filter((key) => key.length > 0);
    const result = await marketService.sell(context.player, {
      ...(itemKeys.length > 0 ? { itemKeys } : { category: 'harvest' }),
      quantity: 'all',
      discordGuildId: context.discordGuildId,
    });
    await interaction.editReply({ embeds: [sellResultEmbed(result, context.t, context.locale)] });
  },
};

export const handlers = [sellButtons];
