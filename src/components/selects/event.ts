import type { StringSelectMenuInteraction } from 'discord.js';
import { quantityModal } from '../../framework/ui';
import * as eventService from '../../services/event.service';
import { paramString } from '../../utils/custom-id';
import type { SelectHandler } from '../../types';

/**
 * Menu d'achat de la boutique d'événement : refuse d'emblée un article épuisé
 * pour le joueur, sinon demande la quantité (même parcours que `/shop`).
 */
const eventBuy: SelectHandler = {
  namespace: 'event',
  actions: ['buy'],
  lockKey: 'event-action',

  async execute(interaction: StringSelectMenuInteraction, parsed, context): Promise<void> {
    const itemKey = interaction.values[0];
    if (!itemKey) {
      await interaction.deferUpdate();
      return;
    }
    const eventKey = paramString(parsed, 0);
    const entry = await eventService.requireBuyableEntry(context.player, eventKey, itemKey, context.now);

    await interaction.showModal(
      quantityModal(
        {
          namespace: 'event',
          action: 'buy_qty',
          ownerId: interaction.user.id,
          params: [eventKey, itemKey],
          title: context.t('event.buy_qty_modal_title'),
          label: context.t('event.buy_qty_modal_label'),
          placeholder: context.t('event.buy_qty_modal_placeholder', { max: entry.remaining }),
        },
        context.locale,
        context.t,
      ),
    );
  },
};

export const handlers: SelectHandler[] = [eventBuy];
