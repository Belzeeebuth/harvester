import { ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, button, confirmRow, row } from '../framework/ui';
import { safeReply } from '../framework/interaction';
import { NO_IMAGE, renderProfileImage } from '../render';
import { getProfile } from '../services/player.service';
import * as miscService from '../services/misc.service';
import * as playerRepo from '../repositories/player.repo';
import * as reminderService from '../services/reminder.service';
import { prestigeBadge } from '../game/prestige';
import { gameError } from '../utils/errors';
import { isValidTimezone } from '../utils/time';
import {
  COIN,
  GEM,
  discordTimestamp,
  formatCoins,
  formatCompact,
  formatNumber,
  progressBar,
} from '../utils/format';
import type { Command } from '../types';

/** Profil, statistiques, paramètres, solde et prestige. */

const profil: Command = {
  category: 'demarrage',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Illustrated profile card')
    .addUserOption((option) => option.setName('user').setDescription('The farmer to show'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') ?? interaction.user;
    const profile = await getProfile(target.id);
    if (!profile) {
      throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
    }

    const image = context.player.compactMode
      ? NO_IMAGE
      : await renderProfileImage({
          locale: context.locale,
          username: profile.user.username,
          displayName: profile.user.displayName ?? profile.user.username,
          avatarUrl: target.displayAvatarURL({ extension: 'png', size: 256 }),
          title: profile.user.title,
          badges: profile.user.badges,
          level: profile.user.level,
          prestige: profile.user.prestige,
          xp: { current: profile.user.xp, needed: profile.xpForNext },
          coins: profile.user.coins,
          gems: profile.user.gems,
          bank: profile.bankBalance,
          energy: { current: profile.energy.current, max: profile.energy.max },
          stats: {
            harvests: profile.user.totalHarvests,
            animals: profile.user.totalAnimalsRaised,
            crafts: profile.user.totalCrafts,
            plots: profile.plotsUnlocked,
            streak: profile.streak,
            achievements: profile.achievementsUnlocked,
            bestHarvest: profile.user.bestHarvestValue,
            coinsEarned: profile.user.totalCoinsEarned,
          },
          coop: profile.coop,
          themeColor: profile.user.profileColor,
          bannerStyle: profile.user.profileTheme,
          farmName: profile.farm.name,
          createdAt: profile.user.createdAt,
        });

    const embed = baseEmbed({
      title: `${profile.user.displayName ?? profile.user.username} ${prestigeBadge(profile.user.prestige)}`,
      description: [
        profile.user.title ? `*${profile.user.title}*` : '',
        context.t('profile.level_line', {
          level: profile.user.level,
          bar: progressBar(profile.user.xp, profile.xpForNext || 1, 12),
          xp: formatCompact(profile.user.xp, context.locale),
          needed: formatCompact(profile.xpForNext, context.locale),
        }),
        context.t('profile.wallet_line', {
          coin: COIN,
          coins: formatNumber(profile.user.coins, context.locale),
          gem: GEM,
          gems: formatNumber(profile.user.gems, context.locale),
          bank: formatCompact(profile.bankBalance, context.locale),
        }),
        context.t('profile.energy_line', {
          current: profile.energy.current,
          max: profile.energy.max,
          fullPart: profile.energy.fullAt
            ? context.t('profile.energy_full_at', {
                relative: discordTimestamp(profile.energy.fullAt, 'R'),
              })
            : '',
        }),
        profile.coop
          ? context.t('profile.coop_line', {
              name: profile.coop.name,
              tag: profile.coop.tag,
              level: context.t('common.level_abbr', { level: profile.coop.level }),
            })
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.primary,
      // Image laissée en pièce jointe libre, hors de l'embed : voir la note
      // détaillée dans `farmView` (src/framework/views.ts). Un embed rend
      // l'image à sa propre largeur (~400 px) ; celle-ci en fait 900 px.
    });

    if (!image.attachment) {
      embed.addFields(
        {
          name: context.t('profile.field_harvests'),
          value: formatNumber(profile.user.totalHarvests, context.locale),
          inline: true,
        },
        {
          name: context.t('profile.field_animals'),
          value: formatNumber(profile.user.totalAnimalsRaised, context.locale),
          inline: true,
        },
        {
          name: context.t('profile.field_crafts'),
          value: formatNumber(profile.user.totalCrafts, context.locale),
          inline: true,
        },
        {
          name: context.t('profile.field_plots'),
          value: context.t('profile.plots_value', { unlocked: profile.plotsUnlocked, max: 64 }),
          inline: true,
        },
        {
          name: context.t('profile.field_streak'),
          value: context.t('profile.streak_value', { count: profile.streak }),
          inline: true,
        },
        {
          name: context.t('profile.field_achievements'),
          value: String(profile.achievementsUnlocked),
          inline: true,
        },
      );
    }

    await interaction.editReply({
      embeds: [embed],
      files: image.attachment ? [image.attachment] : [],
      components: [
        row(
          button({
            namespace: 'farm',
            action: 'refresh',
            ownerId: interaction.user.id,
            label: context.t('common.my_farm'),
            emoji: '🌾',
          }),
          button({
            namespace: 'profile',
            action: 'stats',
            ownerId: interaction.user.id,
            params: [target.id],
            label: context.t('profile.stats_button'),
            emoji: '📊',
          }),
        ),
      ],
    });
  },
};

const stats: Command = {
  category: 'demarrage',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Detailed statistics')
    .addUserOption((option) => option.setName('user').setDescription('The farmer to analyse'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') ?? interaction.user;
    const data = await miscService.playerStats(target.id);
    if (!data) {
      throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
    }

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: context.t('profile.stats_title', { name: data.user.displayName ?? data.user.username }),
          color: COLORS.info,
          fields: [
            {
              name: context.t('profile.stats_agriculture_field'),
              value: [
                context.t('profile.stats_harvests_line', {
                  count: formatNumber(data.user.totalHarvests, context.locale),
                }),
                context.t('profile.stats_planted_line', {
                  count: formatNumber(data.user.totalPlanted, context.locale),
                }),
                context.t('profile.stats_watered_line', {
                  count: formatNumber(data.user.totalWatered, context.locale),
                }),
                context.t('profile.stats_best_harvest_line', {
                  value: formatCoins(data.user.bestHarvestValue, true, context.locale),
                }),
              ].join('\n'),
              inline: true,
            },
            {
              name: context.t('profile.stats_livestock_field'),
              value: [
                context.t('profile.stats_animals_line', {
                  count: formatNumber(data.user.totalAnimalsRaised, context.locale),
                }),
                context.t('profile.stats_alive_line', { count: data.animalsAlive }),
                context.t('profile.stats_crafts_line', {
                  count: formatNumber(data.user.totalCrafts, context.locale),
                }),
              ].join('\n'),
              inline: true,
            },
            {
              name: context.t('profile.stats_economy_field'),
              value: [
                context.t('profile.stats_earned_line', {
                  value: formatCoins(data.user.totalCoinsEarned, true, context.locale),
                }),
                context.t('profile.stats_spent_line', {
                  value: formatCoins(data.user.totalCoinsSpent, true, context.locale),
                }),
                context.t('profile.stats_balance_line', {
                  value: formatCoins(data.user.coins, true, context.locale),
                }),
              ].join('\n'),
              inline: true,
            },
            {
              name: context.t('profile.stats_social_field'),
              value: [
                context.t('profile.stats_help_line', {
                  count: formatNumber(data.user.totalHelpGiven, context.locale),
                }),
                context.t('profile.stats_streak_line', {
                  count: data.streak,
                  best: data.longestStreak,
                }),
                context.t('profile.stats_commands_line', {
                  count: formatNumber(data.user.commandsUsed, context.locale),
                }),
              ].join('\n'),
              inline: true,
            },
            {
              name: context.t('profile.stats_leaderboards_field'),
              value:
                [
                  data.ranks.wealth
                    ? context.t('profile.stats_rank_line', {
                        label: context.t('leaderboard.wealth'),
                        rank: data.ranks.wealth.rank,
                      })
                    : '',
                  data.ranks.level
                    ? context.t('profile.stats_rank_line', {
                        label: context.t('leaderboard.level'),
                        rank: data.ranks.level.rank,
                      })
                    : '',
                  data.ranks.harvests
                    ? context.t('profile.stats_rank_line', {
                        label: context.t('leaderboard.harvests'),
                        rank: data.ranks.harvests.rank,
                      })
                    : '',
                ]
                  .filter(Boolean)
                  .join('\n') || context.t('common.none'),
              inline: true,
            },
            {
              name: context.t('profile.stats_misc_field'),
              value: [
                context.t('profile.stats_inventory_line', {
                  count: formatNumber(data.inventoryTotal, context.locale),
                }),
                context.t('profile.stats_created_line', {
                  date: discordTimestamp(data.user.createdAt, 'D'),
                }),
                context.t('profile.stats_prestige_line', {
                  count: data.user.prestige,
                  badge: prestigeBadge(data.user.prestige),
                }),
              ].join('\n'),
              inline: true,
            },
          ],
        }),
      ],
    });
  },
};

const solde: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Show your balance')
    .addUserOption((option) => option.setName('user').setDescription('The farmer to look up'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const user = await playerRepo.findUserByDiscordId(target.id);
    if (!user) {
      throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
    }
    const bank = await playerRepo.getBankAccount(user.id);

    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: context.t('profile.balance_title', { name: user.displayName ?? user.username }),
          description: [
            context.t('profile.balance_coins_line', {
              coin: COIN,
              coins: formatNumber(user.coins, context.locale),
            }),
            context.t('profile.balance_gems_line', {
              gem: GEM,
              gems: formatNumber(user.gems, context.locale),
            }),
            context.t('profile.balance_bank_line', {
              bank: formatNumber(bank?.balance ?? 0, context.locale),
              capacity: formatCompact(bank?.capacity ?? 0, context.locale),
            }),
            '',
            context.t('profile.balance_networth_line', {
              total: formatCoins(user.coins + (bank?.balance ?? 0), false, context.locale),
            }),
          ].join('\n'),
          color: COLORS.gold,
        }),
      ],
    });
  },
};

const parametres: Command = {
  category: 'demarrage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Your preferences: notifications, language, privacy')
    .addBooleanOption((option) =>
      option.setName('dm-notifications').setDescription('Receive reminders by direct message'),
    )
    .addStringOption((option) =>
      option
        .setName('language')
        .setDescription('Interface language')
        .addChoices({ name: 'Français', value: 'fr' }, { name: 'English', value: 'en' }),
    )
    .addStringOption((option) =>
      option
        .setName('privacy')
        .setDescription('Who can see your farm?')
        .addChoices(
          { name: 'Everyone', value: 'public' },
          { name: 'My co-op', value: 'coop_only' },
          { name: 'Nobody', value: 'private' },
        ),
    )
    .addStringOption((option) =>
      option.setName('timezone').setDescription('Time zone (e.g. Europe/Paris)').setMaxLength(48),
    )
    .addBooleanOption((option) =>
      option.setName('compact-mode').setDescription('Disable generated images'),
    )
    .addBooleanOption((option) =>
      option
        .setName('channel-reminders')
        .setDescription('Get farm reminders as mentions in the server reminder channel instead of DMs'),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const patch: Record<string, unknown> = {};
    const dm = interaction.options.getBoolean('dm-notifications');
    const locale = interaction.options.getString('language');
    const privacy = interaction.options.getString('privacy');
    const timezone = interaction.options.getString('timezone');
    const compact = interaction.options.getBoolean('compact-mode');
    const channelReminders = interaction.options.getBoolean('channel-reminders');

    if (dm !== null) patch.dmNotifications = dm;
    if (locale) patch.locale = locale;
    if (privacy) patch.privacy = privacy;
    if (compact !== null) patch.compactMode = compact;
    if (channelReminders !== null) patch.channelReminders = channelReminders;
    if (timezone) {
      if (!isValidTimezone(timezone)) {
        throw gameError('target_invalid', context.t('profile.unknown_timezone', { timezone }), {
          hint: context.t('profile.unknown_timezone_hint'),
        });
      }
      patch.timezone = timezone;
    }

    if (Object.keys(patch).length > 0) {
      await playerRepo.updateSettings(context.player.id, patch);
    }

    const settings = await playerRepo.getSettings(context.player.id);

    // Second opt-in sans le premier : le joueur vient d'accepter les mentions
    // mais ce serveur n'a désigné aucun salon. Sans avertissement, il croirait
    // la fonctionnalité en panne alors qu'elle attend un administrateur.
    const missingChannelWarning =
      channelReminders === true &&
      context.discordGuildId &&
      !(await reminderService.hasReminderChannel(context.discordGuildId))
        ? context.t('settings.channel_reminders_no_channel')
        : '';

    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: context.t('settings.title'),
          description:
            (Object.keys(patch).length > 0
              ? context.t('settings.updated_body')
              : context.t('settings.current_body')) + missingChannelWarning,
          color: COLORS.info,
          fields: [
            {
              name: context.t('settings.notifications_field'),
              value: [
                context.t('settings.dm_line', {
                  state: settings?.dmNotifications ? context.t('common.enabled') : context.t('common.disabled'),
                }),
                context.t('settings.notify_crops_line', { check: settings?.notifyCrops ? '✅' : '❌' }),
                context.t('settings.notify_animals_line', { check: settings?.notifyAnimals ? '✅' : '❌' }),
                context.t('settings.notify_daily_line', { check: settings?.dailyReminder ? '✅' : '❌' }),
                context.t('settings.channel_reminders_line', {
                  check: settings?.channelReminders ? '✅' : '❌',
                }),
              ].join('\n'),
              inline: true,
            },
            {
              name: context.t('settings.display_field'),
              value: [
                context.t('settings.language_line', { locale: settings?.locale ?? 'fr' }),
                context.t('settings.timezone_line', { timezone: settings?.timezone ?? 'Europe/Paris' }),
                context.t('settings.compact_mode_line', { check: settings?.compactMode ? '✅' : '❌' }),
              ].join('\n'),
              inline: true,
            },
            {
              name: context.t('settings.privacy_field'),
              value: [
                context.t('settings.privacy_visible_line', {
                  scope:
                    settings?.privacy === 'private'
                      ? context.t('settings.privacy_nobody')
                      : settings?.privacy === 'coop_only'
                        ? context.t('settings.privacy_coop')
                        : context.t('settings.privacy_everyone'),
                }),
                context.t('settings.trades_line', {
                  state: settings?.allowTrades
                    ? context.t('settings.trades_allowed')
                    : context.t('settings.trades_refused'),
                }),
              ].join('\n'),
              inline: false,
            },
          ],
        }),
      ],
      components: [
        row(
          button({
            namespace: 'settings',
            action: 'toggle',
            ownerId: interaction.user.id,
            params: ['notifyCrops'],
            label: context.t('settings.crop_alerts_button'),
            emoji: '🌱',
          }),
          button({
            namespace: 'settings',
            action: 'toggle',
            ownerId: interaction.user.id,
            params: ['notifyAnimals'],
            label: context.t('settings.animal_alerts_button'),
            emoji: '🐄',
          }),
          button({
            namespace: 'settings',
            action: 'toggle',
            ownerId: interaction.user.id,
            params: ['dailyReminder'],
            label: context.t('settings.daily_reminder_button'),
            emoji: '📅',
          }),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const prestige: Command = {
  category: 'progression',
  cooldown: { seconds: 30, bucket: 'prestige' },
  data: new SlashCommandBuilder()
    .setName('prestige')
    .setDescription('Rebirth: start over for permanent bonuses')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { eligibility, plan } = await miscService.previewPrestige(context.player);

    if (!eligibility.eligible) {
      const reason = context.t(
        eligibility.reasonKey ?? 'errors.player.prestige_unavailable',
        eligibility.reasonParams,
      );
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: `🌟 ${context.t('progression.prestige_locked_title')}`,
            description: context.t('progression.prestige_locked_body', {
              reason,
              level: eligibility.requiredLevel,
            }),
            color: COLORS.warning,
          }),
        ],
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: context.t('progression.prestige_confirm_title'),
          description: context.t('progression.prestige_confirm_body'),
          color: COLORS.warning,
          fields: [
            {
              name: context.t('progression.prestige_keep_field'),
              value: [
                context.t('progression.prestige_keep_buildings'),
                context.t('progression.prestige_keep_plots', { plots: plan.plotsKept }),
                context.t('progression.prestige_keep_gems'),
                context.t('progression.prestige_keep_coins', {
                  kept: formatCoins(plan.coinsKept, false, context.locale),
                  starting: formatCoins(plan.startingCoins, false, context.locale),
                }),
                context.t('progression.prestige_keep_misc'),
              ].join('\n'),
              inline: true,
            },
            {
              name: context.t('progression.prestige_lose_field'),
              value: [
                context.t('progression.prestige_lose_level'),
                context.t('progression.prestige_lose_animals'),
                context.t('progression.prestige_lose_crops'),
                context.t('progression.prestige_lose_inventory'),
              ].join('\n'),
              inline: true,
            },
            {
              name: context.t('progression.prestige_gain_field'),
              value: context.t('progression.prestige_gain_value', {
                multiplier: plan.newMultiplier.toFixed(2),
                prestige: plan.newPrestige,
                points: plan.pointsGained,
              }),
              inline: false,
            },
          ],
        }),
      ],
      components: [
        confirmRow(
          {
            namespace: 'prestige',
            action: 'confirm',
            ownerId: interaction.user.id,
            confirmLabel: context.t('progression.prestige_confirm_button'),
            danger: true,
          },
          context.locale,
          context.t,
        ),
      ],
    });
  },
};

export const commands: Command[] = [profil, stats, solde, parametres, prestige];
export { ButtonStyle };
