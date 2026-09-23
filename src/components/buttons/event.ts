import type { ButtonInteraction } from 'discord.js';
import { eventView } from '../../commands/world';
import { successEmbed } from '../../framework/ui';
import { followUpEphemeral } from '../../framework/interaction';
import { withLevelUp } from '../../framework/levelup';
import * as eventService from '../../services/event.service';
import { describeItems } from '../../services/inventory.service';
import { paramString } from '../../utils/custom-id';
import { formatCoins, formatNumber } from '../../utils/format';
import type { ButtonHandler } from '../../types';

/**
 * Bouton « Réclamer les paliers » de `/event` : réclame d'un coup tous les
 * paliers atteints, puis rafraîchit la vue et livre le reçu en éphémère.
 */
const eventClaim: ButtonHandler = {
  namespace: 'event',
  actions: ['claim', 'open'],
  lockKey: 'event-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    if (parsed.action === 'open') {
      // Raccourci proposé sur les erreurs liées à un événement.
      await interaction.editReply(await eventView(context, interaction.user.id));
      return;
    }
    const { t, locale } = context;
    const result = await eventService.claimEventRewards(
      context.player,
      paramString(parsed, 0),
      context.now,
    );

    const rewards = [
      result.coins > 0 ? formatCoins(result.coins, false, locale) : '',
      result.gems > 0 ? `${formatNumber(result.gems, locale)} 💎` : '',
      result.xp > 0 ? `${formatNumber(result.xp, locale)} XP` : '',
      result.items.length > 0 ? describeItems(result.items, locale) : '',
    ]
      .filter(Boolean)
      .join(' · ');

    await interaction.editReply(await eventView(context, interaction.user.id));
    await followUpEphemeral(interaction, {
      embeds: [
        withLevelUp(successEmbed(
          t('event.claim_title', { count: result.tiers.length }),
          [
            rewards ? t('event.claim_rewards_line', { rewards }) : '',
            ...result.titles.map((title) => t('event.claim_title_line', { title })),
          ]
            .filter(Boolean)
            .join('\n'),
        ), result.levelUp, t, locale),
      ],
    });
  },
};

export const handlers: ButtonHandler[] = [eventClaim];
