import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import * as systemRepo from '../repositories/system.repo';
import * as reminderService from '../services/reminder.service';
import { gameError } from '../utils/errors';
import type { Command, CommandContext } from '../types';

/**
 * `/server` — configuration propre à UN serveur Discord, par ses gestionnaires.
 *
 * À ne pas confondre avec `/admin` (propriétaires du bot) : ici l'autorité
 * vient de Discord — la permission « Gérer le serveur » — pas d'un drapeau en
 * base. Trois barrières, parce qu'une seule ne suffit pas :
 *  - `setDefaultMemberPermissions` cache la commande aux membres ordinaires,
 *    mais un administrateur peut la ré-exposer depuis les réglages du serveur ;
 *  - `setContexts(Guild)` empêche l'appel en message privé ;
 *  - `memberPermissions` est revérifié À L'EXÉCUTION. `requiredPermissions`
 *    existe dans l'interface `Command` mais aucun pipeline ne l'applique : on
 *    le déclare pour la documentation, on le vérifie soi-même.
 */

const REMINDER_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

/**
 * Ce qu'il faut au bot pour poster un rappel. Vérifié AVANT d'enregistrer le
 * salon : un salon accepté puis muet (permissions manquantes) serait découvert
 * dix minutes plus tard dans les journaux, pas par l'administrateur.
 */
const BOT_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
] as const;

function channelMention(channelId: string | null | undefined, none = ''): string {
  return channelId ? `<#${channelId}>` : none;
}

const server: Command = {
  category: 'admin',
  cooldown: { seconds: 3 },
  dmAllowed: false,
  requiredPermissions: [PermissionFlagsBits.ManageGuild],
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('Server-side configuration (Manage Server permission required)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('reminders')
        .setDescription('Post grouped farm reminders (crops, animals…) in a channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel where grouped reminders are posted')
            .addChannelTypes(...REMINDER_CHANNEL_TYPES),
        )
        .addIntegerOption((option) =>
          option
            .setName('every')
            .setDescription('Minimum minutes between two reminder messages (default 10)')
            .setMinValue(1)
            .setMaxValue(1440),
        )
        .addBooleanOption((option) =>
          option.setName('off').setDescription('Stop posting reminders in this server'),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show the configuration of this server'),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.inCachedGuild()) {
      throw gameError('forbidden', 'This command only works inside a server.', {
        i18nKey: 'common.guild_only_body',
      });
    }
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      throw gameError('forbidden', 'The Manage Server permission is required.', {
        i18nKey: 'server.forbidden',
      });
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      await showStatus(interaction, context);
      return;
    }
    await configureReminders(interaction, context);
  },
};

type GuildInteraction = ChatInputCommandInteraction<'cached'>;

function guildIdentity(interaction: GuildInteraction): reminderService.GuildIdentity {
  return {
    name: interaction.guild.name,
    memberCount: interaction.guild.memberCount,
    locale: interaction.guild.preferredLocale.startsWith('fr') ? 'fr' : 'en',
  };
}

async function configureReminders(
  interaction: GuildInteraction,
  context: CommandContext,
): Promise<void> {
  const off = interaction.options.getBoolean('off') ?? false;
  const channel = interaction.options.getChannel('channel', false, REMINDER_CHANNEL_TYPES);
  const every = interaction.options.getInteger('every') ?? undefined;
  const actor = { userId: context.player.id, discordId: context.player.discordId };

  if (off) {
    await reminderService.disableReminderChannel(interaction.guildId, guildIdentity(interaction), actor);
    await interaction.editReply({
      embeds: [successEmbed(context.t('server.reminders_off_title'), context.t('server.reminders_off_body'))],
    });
    return;
  }

  if (!channel) {
    if (every === undefined) {
      throw gameError('target_invalid', 'Nothing to change.', { i18nKey: 'server.nothing_to_do' });
    }
    // Régler l'espacement sans salon n'a pas de sens : on exige un salon
    // existant plutôt que d'enregistrer une valeur qui ne servira jamais.
    const current = await systemRepo.getGuildSettings(interaction.guildId);
    if (!current?.reminderChannelId) {
      throw gameError('invalid_state', 'No reminder channel configured yet.', {
        i18nKey: 'server.no_channel_for_interval',
      });
    }
    const result = await reminderService.enableReminderChannel(
      interaction.guildId,
      guildIdentity(interaction),
      current.reminderChannelId,
      every,
      actor,
    );
    await replyEnabled(interaction, context, result);
    return;
  }

  if (channel.guildId !== interaction.guildId) {
    throw gameError('target_invalid', 'That channel belongs to another server.', {
      i18nKey: 'server.channel_invalid',
    });
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  if (!channel.permissionsFor(me).has(BOT_CHANNEL_PERMISSIONS)) {
    throw gameError('forbidden', 'The bot cannot write in that channel.', {
      i18nKey: 'server.bot_cannot_write',
      params: { channel: channelMention(channel.id) },
    });
  }

  const result = await reminderService.enableReminderChannel(
    interaction.guildId,
    guildIdentity(interaction),
    channel.id,
    every,
    actor,
  );
  await replyEnabled(interaction, context, result);
}

async function replyEnabled(
  interaction: GuildInteraction,
  context: CommandContext,
  result: { channelId: string; batchMinutes: number },
): Promise<void> {
  await interaction.editReply({
    embeds: [
      successEmbed(
        context.t('server.reminders_set_title'),
        context.t('server.reminders_set_body', {
          channel: channelMention(result.channelId),
          minutes: result.batchMinutes,
          max: reminderService.MAX_MENTIONS_PER_MESSAGE,
        }),
      ),
    ],
  });
}

async function showStatus(interaction: GuildInteraction, context: CommandContext): Promise<void> {
  const settings = await systemRepo.getGuildSettings(interaction.guildId);

  const reminders = settings?.reminderChannelId
    ? context.t('server.status_reminders_on', {
        channel: channelMention(settings.reminderChannelId),
        minutes: settings.reminderBatchMinutes,
      })
    : context.t('server.status_reminders_off');

  const otherChannels = [
    ['server.status_channel_announcements', settings?.announcementChannelId],
    ['server.status_channel_market', settings?.marketChannelId],
    ['server.status_channel_events', settings?.eventChannelId],
  ] as const;

  await interaction.editReply({
    embeds: [
      baseEmbed({
        title: context.t('server.status_title', { name: interaction.guild.name }),
        color: COLORS.info,
        fields: [
          { name: context.t('server.status_reminders_field'), value: reminders, inline: false },
          {
            name: context.t('server.status_channels_field'),
            value: otherChannels
              .map(([labelKey, channelId]) =>
                context.t('server.status_channel_line', {
                  label: context.t(labelKey),
                  channel: channelMention(channelId, context.t('common.none')),
                }),
              )
              .join('\n'),
            inline: true,
          },
          {
            name: context.t('server.status_locale_field'),
            value: `**${settings?.locale ?? 'fr'}**`,
            inline: true,
          },
        ],
        footer: context.t('server.status_footer'),
      }),
    ],
  });
}

export const commands: Command[] = [server];
