import {
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type InteractionEditReplyOptions,
  type User,
} from 'discord.js';
import { COLORS, baseEmbed, button, row, successEmbed } from '../framework/ui';
import { safeReply } from '../framework/interaction';
import { coopView, farmView } from '../framework/views';
import { NO_IMAGE, renderLeaderboardImage } from '../render';
import * as coopService from '../services/coop.service';
import * as farmService from '../services/farm.service';
import * as miscService from '../services/misc.service';
import * as playerRepo from '../repositories/player.repo';
import { gameError } from '../utils/errors';
import { formatCoins, formatCompact, formatNumber, progressBar, truncate } from '../utils/format';
import type { Command, CommandContext } from '../types';

/** Commandes sociales : coopératives, classements, visites, parrainage. */

// ---------------------------------------------------------------------------
// /coop
// ---------------------------------------------------------------------------

const coop: Command = {
  category: 'social',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('coop')
    .setDescription('Manage your co-op')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a co-op')
        .addStringOption((option) =>
          option.setName('name').setDescription('Name (3-32 characters)').setRequired(true).setMaxLength(32),
        )
        .addStringOption((option) =>
          option.setName('tag').setDescription('Tag (2-5 characters)').setRequired(true).setMaxLength(5),
        )
        .addStringOption((option) =>
          option.setName('description').setDescription('Co-op description').setMaxLength(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('join')
        .setDescription('Join a public co-op')
        .addStringOption((option) =>
          option.setName('name').setDescription('Name or tag').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('leave').setDescription('Leave your co-op'))
    .addSubcommand((sub) => sub.setName('info').setDescription('Your co-op at a glance'))
    .addSubcommand((sub) => sub.setName('members').setDescription('Member list'))
    .addSubcommand((sub) =>
      sub
        .setName('invite')
        .setDescription('Invite a player')
        .addUserOption((option) => option.setName('user').setDescription('The player').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('kick')
        .setDescription('Kick a member')
        .addUserOption((option) => option.setName('user').setDescription('The member').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('promote')
        .setDescription("Change a member's rank")
        .addUserOption((option) => option.setName('user').setDescription('The member').setRequired(true))
        .addStringOption((option) =>
          option
            .setName('rank')
            .setDescription('New rank')
            .setRequired(true)
            .addChoices(
              { name: 'Leader (transfers leadership)', value: 'owner' },
              { name: 'Officer', value: 'officer' },
              { name: 'Member', value: 'member' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('treasury').setDescription('Treasury status'))
    .addSubcommand((sub) =>
      sub
        .setName('contribute')
        .setDescription('Pay coins into the treasury')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('Amount in coins').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName('objectives').setDescription('Weekly objectives'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();

    switch (sub) {
      case 'create': {
        const info = await coopService.createCoop(context.player, {
          name: interaction.options.getString('name', true),
          tag: interaction.options.getString('tag', true),
          description: interaction.options.getString('description') ?? undefined,
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('coop.create_title', { emblem: info.emblem, name: info.name, tag: info.tag }),
              context.t('coop.create_body', {
                cost: formatCoins(context.balance.coop.creationCostCoins, false, context.locale),
              }),
            ),
          ],
        });
        break;
      }
      case 'join': {
        const info = await coopService.joinCoop(context.player, interaction.options.getString('name', true));
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('coop.join_title', { emblem: info.emblem, name: info.name }),
              context.t('coop.join_body', { level: info.level }),
            ),
          ],
        });
        break;
      }
      case 'leave': {
        const result = await coopService.leaveCoop(context.player);
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('coop.leave_title'),
              result.dissolved
                ? context.t('coop.leave_dissolved', { name: result.coopName })
                : context.t('coop.leave_body', { name: result.coopName }),
            ),
          ],
        });
        break;
      }
      case 'members': {
        const membership = await coopService.requireMembership(context.player.id);
        const members = await coopService.listMembers(membership.coop.id);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: context.t('coop.members_title', { name: membership.coop.name }),
              description: members
                .map((member, index) =>
                  context.t('coop.members_line', {
                    index: index + 1,
                    username: member.username,
                    role: context.t(`common.role.${member.member.role}`),
                    level: context.t('common.level_abbr', { level: member.level }),
                    weekly: formatCoins(member.member.weeklyContribution, true, context.locale),
                    total: formatCoins(member.member.contributedCoins, true, context.locale),
                  }),
                )
                .join('\n'),
              color: COLORS.primary,
              footer: context.t('coop.members_footer', {
                count: members.length,
                limit: membership.coop.memberLimit,
              }),
            }),
          ],
        });
        break;
      }
      case 'invite': {
        const target = interaction.options.getUser('user', true);
        const targetUser = await playerRepo.findUserByDiscordId(target.id);
        if (!targetUser) {
          throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
        }
        const result = await coopService.inviteMember(context.player, targetUser.id);
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('coop.invite_title'),
              context.t('coop.invite_body', { target: target.toString(), name: result.coopName }),
            ),
          ],
        });
        break;
      }
      case 'kick': {
        const target = interaction.options.getUser('user', true);
        const targetUser = await playerRepo.findUserByDiscordId(target.id);
        if (!targetUser) throw gameError('not_found', context.t('errors.player_not_found'));
        const result = await coopService.kickMember(context.player, targetUser.id);
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('coop.kick_title'),
              context.t('coop.kick_body', { target: target.toString(), name: result.coopName }),
            ),
          ],
        });
        break;
      }
      case 'promote': {
        const target = interaction.options.getUser('user', true);
        const role = interaction.options.getString('rank', true) as 'owner' | 'officer' | 'member';
        const targetUser = await playerRepo.findUserByDiscordId(target.id);
        if (!targetUser) throw gameError('not_found', context.t('errors.player_not_found'));
        const result = await coopService.promoteMember(context.player, targetUser.id, role);
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('coop.promote_title'),
              context.t('coop.promote_body', {
                target: target.toString(),
                role: context.t(`common.role.${result.role}`),
              }),
            ),
          ],
        });
        break;
      }
      case 'contribute': {
        const amount = interaction.options.getInteger('amount', true);
        const result = await coopService.contribute(context.player, amount);
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('coop.contribute_title'),
              context.t('coop.contribute_body', {
                amount: formatCoins(amount, false, context.locale),
                treasury: formatCoins(result.treasury, false, context.locale),
                xp: formatNumber(result.coopXp, context.locale),
                levelUp:
                  result.levelsGained > 0
                    ? context.t('coop.contribute_level_up', { level: result.level })
                    : '',
              }),
            ),
          ],
        });
        break;
      }
      case 'treasury': {
        const membership = await coopService.requireMembership(context.player.id);
        const info = await coopService.getCoopInfo(membership.coop.id, context.player.id);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: context.t('coop.treasury_title', { name: info.name }),
              description: context.t('coop.treasury_body', {
                treasury: formatCoins(info.treasury, false, context.locale),
              }),
              color: COLORS.gold,
            }),
          ],
          components: [
            row(
              button({
                namespace: 'coop',
                action: 'contribute',
                ownerId: context.player.discordId,
                label: context.t('coop.contribute_button'),
                emoji: '💰',
                style: ButtonStyle.Success,
              }),
            ),
          ],
        });
        break;
      }
      case 'objectives': {
        const membership = await coopService.requireMembership(context.player.id);
        const [weekly, daily] = await Promise.all([
          coopService.listWeeklyObjectives(membership.coop.id, context.now),
          coopService.listDailyObjectives(membership.coop.id, context.now),
        ]);

        const objectiveLine = (objective: {
          objectiveKey: string;
          status: string;
          progress: number;
          target: number;
          rewardCoins: number;
          rewardGems: number;
        }): string =>
          context.t('coop.objectives_line', {
            title: context.t(`coop.objective.${objective.objectiveKey}.title`),
            check: objective.status === 'completed' ? '✅' : '',
            description: context.t(`coop.objective.${objective.objectiveKey}.description`, {
              target: objective.target,
            }),
            bar: progressBar(Number(objective.progress), Number(objective.target), 12),
            progress: formatCompact(Number(objective.progress), context.locale),
            target: formatCompact(Number(objective.target), context.locale),
            coins: formatCoins(objective.rewardCoins, false, context.locale),
            gems: objective.rewardGems,
          });

        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: context.t('coop.objectives_title', { name: membership.coop.name }),
              fields: [
                {
                  name: `🎯 ${context.t('coop.objectives')}`,
                  value: weekly.map(objectiveLine).join('\n\n') || context.t('coop.no_active_goal'),
                  inline: false,
                },
                {
                  name: `🌟 ${context.t('coop.daily_challenge')}`,
                  value: daily.map(objectiveLine).join('\n\n') || context.t('coop.no_daily_challenge'),
                  inline: false,
                },
              ],
              color: COLORS.primary,
            }),
          ],
        });
        break;
      }
      default: {
        await interaction.editReply(await coopView(context));
      }
    }
  },
};

// ---------------------------------------------------------------------------
// /leaderboard
// ---------------------------------------------------------------------------

const classement: Command = {
  category: 'social',
  cooldown: { seconds: 10, bucket: 'classement' },
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Farmer leaderboards')
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Leaderboard type')
        .addChoices(
          { name: '🪙 Wealth', value: 'wealth' },
          { name: '⭐ Experience', value: 'level' },
          { name: '🌾 Harvests', value: 'harvests' },
          { name: '🐄 Livestock', value: 'animals' },
          { name: '🛠️ Crafting', value: 'crafts' },
          { name: '📈 Weekly XP', value: 'weekly_xp' },
          { name: '🤝 Co-ops', value: 'coop_score' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('scope')
        .setDescription('Leaderboard scope')
        .addChoices(
          { name: '🌍 Global', value: 'global' },
          { name: '🏠 This server', value: 'discord' },
          { name: '🤝 My co-op', value: 'coop' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const type = (interaction.options.getString('type') ?? 'wealth') as miscService.LeaderboardType;
    const scope = (interaction.options.getString('scope') ?? 'global') as 'global' | 'discord' | 'coop';

    await sendLeaderboard(interaction, context, type, scope);
  },
};

/** Interface minimale nécessaire pour répondre : commande ou composant. */
export interface Replyable {
  editReply: (payload: InteractionEditReplyOptions) => Promise<unknown>;
}

export async function sendLeaderboard(
  interaction: Replyable,
  context: CommandContext,
  type: miscService.LeaderboardType,
  scope: 'global' | 'discord' | 'coop',
): Promise<void> {
  const t = context.t;
  const meta = miscService.leaderboardMeta(type, context.locale);
  const board = await miscService.getLeaderboard(type, {
    scope,
    discordGuildId: context.discordGuildId,
    coopId: context.player.coopId ?? undefined,
    limit: 10,
    locale: context.locale,
  });
  const viewerRank = await miscService.getUserRank(type, context.player.id);

  const scopeLabel =
    scope === 'discord'
      ? t('leaderboard.scope.discord')
      : scope === 'coop'
        ? t('leaderboard.scope.coop')
        : t('leaderboard.scope.global');

  const image = context.player.compactMode
    ? NO_IMAGE
    : await renderLeaderboardImage({
        locale: context.locale,
        title: meta.label,
        emoji: meta.emoji,
        unit: meta.unit,
        scopeLabel,
        entries: board.rows.map((entry) => ({
          rank: entry.rank,
          name: entry.name,
          score: entry.score,
          extra: entry.extra,
          isViewer: 'userId' in entry ? entry.userId === context.player.id : false,
        })),
        viewer: viewerRank,
      });

  const embed = baseEmbed({
    title: `${meta.emoji} ${t('render.leaderboard.title', { title: meta.label })}`,
    description:
      board.rows
        .map(
          (entry) =>
            `${entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : `\`#${entry.rank}\``} **${entry.name}** · ${formatCompact(entry.score, context.locale)} ${meta.unit}`,
        )
        .join('\n') || t('leaderboard.empty'),
    color: COLORS.gold,
    // Image laissée en pièce jointe libre, hors de l'embed : voir la note
    // détaillée dans `farmView` (src/framework/views.ts). Un embed rend
    // l'image à sa propre largeur (~400 px) ; celle-ci en fait 900 px.
    footer: viewerRank
      ? t('leaderboard.footer_with_rank', { rank: viewerRank.rank, scope: scopeLabel })
      : scopeLabel,
  });

  await interaction.editReply({
    embeds: [embed],
    files: image.attachment ? [image.attachment] : [],
  });
}

// ---------------------------------------------------------------------------
// /visit, /assist
// ---------------------------------------------------------------------------

const visiter: Command = {
  category: 'social',
  cooldown: { seconds: 30, bucket: 'visit' },
  data: new SlashCommandBuilder()
    .setName('visit')
    .setDescription("Visit another player's farm")
    .addUserOption((option) =>
      option.setName('user').setDescription('The farmer to visit').setRequired(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await visitFarm(interaction, context, interaction.options.getUser('user', true));
  },
};

/** Affiche la ferme d'un autre joueur et enregistre la visite. */
export async function visitFarm(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  target: User,
): Promise<void> {
  if (target.bot) throw gameError('target_invalid', context.t('farm.bots_no_farm'));

  const bundle = await playerRepo.loadPlayerBundle(target.id);
  if (!bundle) {
    throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
  }
  if (bundle.settings.privacy === 'private' && target.id !== interaction.user.id) {
    throw gameError('privacy_blocked', context.t('errors.privacy_blocked'));
  }

  const visitorContext: CommandContext = {
    ...context,
    player: {
      ...context.player,
      id: bundle.user.id,
      farmId: bundle.farm.id,
      level: bundle.user.level,
      coins: bundle.user.coins,
      gems: bundle.user.gems,
      prestige: bundle.user.prestige,
      xp: bundle.user.xp,
      username: bundle.user.displayName ?? bundle.user.username,
    },
  };

  const view = await farmView(visitorContext, {
    targetName: target.displayName,
    avatarUrl: target.displayAvatarURL({ extension: 'png', size: 128 }),
    readOnly: true,
  });

  const reward =
    target.id === interaction.user.id
      ? { rewarded: false, coins: 0, xp: 0 }
      : await miscService.recordVisit(
          context.player,
          { id: bundle.user.id, farmId: bundle.farm.id },
          false,
          0,
        );

  const embed = view.embeds?.[0] as EmbedBuilder | undefined;
  if (embed && reward.rewarded) {
    embed.setFooter({
      text: context.t('social.visit_reward_footer', { coins: reward.coins, xp: reward.xp }),
    });
  }

  await interaction.editReply({
    embeds: view.embeds ?? [],
    files: view.files ?? [],
    components:
      target.id === interaction.user.id
        ? []
        : [
            row(
              button({
                namespace: 'social',
                action: 'help',
                ownerId: interaction.user.id,
                params: [target.id],
                label: context.t('social.help_button'),
                emoji: '🤝',
                style: ButtonStyle.Success,
              }),
            ),
          ],
  });
}

const aider: Command = {
  category: 'social',
  cooldown: { seconds: 60, bucket: 'help' },
  data: new SlashCommandBuilder()
    .setName('assist')
    .setDescription("Water another farmer's plots: you both gain")
    .addUserOption((option) =>
      option.setName('user').setDescription('The farmer to help').setRequired(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user', true);
    await helpFarmer(interaction, context, target.id, target.displayName);
  },
};

export async function helpFarmer(
  interaction: Replyable,
  context: CommandContext,
  targetDiscordId: string,
  targetName: string,
): Promise<void> {
  if (targetDiscordId === context.player.discordId) {
    throw gameError('target_invalid', context.t('social.cannot_help_self'));
  }

  const bundle = await playerRepo.loadPlayerBundle(targetDiscordId);
  if (!bundle) {
    throw gameError('not_found', context.t('economy.target_no_farm', { name: targetName }));
  }

  // Le plafond d'aides du jour est vérifié AVANT d'arroser : `recordVisit` et
  // `helpFarmer` ouvrent deux transactions distinctes, et l'ordre inverse
  // arrosait la ferme hôte puis refusait l'action — travail fait, joueur
  // sanctionné, compteur d'aides incrémenté sans limite.
  await miscService.assertCanHelp(context.player);

  const helped = await farmService.helpFarmer(context.player, bundle.farm.id);
  const reward = await miscService.recordVisit(
    context.player,
    { id: bundle.user.id, farmId: bundle.farm.id },
    true,
    helped.plotsWatered,
  );

  await interaction.editReply({
    embeds: [
      successEmbed(
        context.t('social.help_title'),
        [
          context.t('social.help_watered_line', { count: helped.plotsWatered, name: targetName }),
          reward.rewarded
            ? context.t('social.help_reward_line', {
                coins: formatCoins(reward.coins, false, context.locale),
                xp: reward.xp,
                name: targetName,
              })
            : context.t('social.help_no_reward_line', { name: targetName }),
          context.t('social.help_footer_line'),
        ].join('\n'),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// /referral
// ---------------------------------------------------------------------------

const parrainage: Command = {
  category: 'social',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('referral')
    .setDescription('Your referral code and rewards')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const status = await miscService.referralStatus(context.player.id);
    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: context.t('social.referral_title'),
          description: [
            context.t('social.referral_code_line', { code: status.code }),
            '',
            context.t('social.referral_bonus_line', {
              code: status.code,
              bonus: formatCoins(context.balance.social.referredStartBonusCoins, false, context.locale),
            }),
            context.t('social.referral_reward_line', {
              level: status.qualifyLevel,
              coins: formatCoins(status.rewardCoins, false, context.locale),
              gems: status.rewardGems,
            }),
            '',
            status.referredBy ? context.t('social.referral_was_referred') : '',
          ]
            .filter(Boolean)
            .join('\n'),
          color: COLORS.info,
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const commands: Command[] = [coop, classement, visiter, aider, parrainage];
export { truncate };
