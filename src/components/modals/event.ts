import { MessageFlags, type ModalSubmitInteraction } from 'discord.js';
import { successEmbed } from '../../framework/ui';
import * as eventService from '../../services/event.service';
import { gameError } from '../../utils/errors';
import { paramString } from '../../utils/custom-id';
import { formatCoins, formatNumber } from '../../utils/format';
import type { ModalHandler } from '../../types';

/** Quantité saisie pour un achat en boutique d'événement. */
const eventBuyQuantity: ModalHandler = {
  namespace: 'event',
  actions: ['buy_qty'],
  lockKey: 'event-action',

  async execute(interaction: ModalSubmitInteraction, parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const raw = interaction.fields.getTextInputValue('quantity').trim().replace(/\s|_/g, '');
    const quantity = Number.parseInt(raw, 10);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw gameError('quantity_invalid', 'Invalid quantity.', { i18nKey: 'errors.quantity_invalid' });
    }

    const result = await eventService.buyEventItem(
      context.player,
      {
        eventKey: paramString(parsed, 0),
        itemKey: paramString(parsed, 1),
        quantity: Math.min(quantity, 999),
        discordGuildId: context.discordGuildId,
      },
      context.now,
    );

    const currency = result.currencyItemKey ? context.config.items.get(result.currencyItemKey) : undefined;
    const cost = result.currencyItemKey
      ? `${formatNumber(result.cost, context.locale)} ${currency?.emoji ?? '🎟️'}`
      : formatCoins(result.cost, false, context.locale);

    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('event.purchase_title'),
          context.t('event.purchase_body', {
            quantity: result.quantity,
            emoji: result.emoji,
            name: result.name,
            cost,
            remaining: result.remaining,
          }),
        ),
      ],
    });
  },
};

export const handlers: ModalHandler[] = [eventBuyQuantity];
