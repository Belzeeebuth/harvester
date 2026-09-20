import { ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, button, linkButton, row, successEmbed } from '../framework/ui';
import { safeReply } from '../framework/interaction';
import { questsView } from '../framework/views';
import * as progressionService from '../services/progression.service';
import * as miscService from '../services/misc.service';
import { describeItems } from '../services/inventory.service';
import { peek } from '../framework/cooldown';
import {
  discordTimestamp,
  formatCoins,
  formatCompact,
  formatNumber,
  progressBar,
  truncate,
} from '../utils/format';
import type { Command } from '../types';

/** Quêtes, succès, passe saisonnier, récompense quotidienne et vote. */

const quetes: Command = {
  category: 'progression',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('quests')
    .setDescription('Your active quests and contracts')
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Filter')
        .addChoices(
          { name: '📅 Daily', value: 'daily' },
          { name: '🗓️ Weekly', value: 'weekly' },
          { name: '📖 Story', value: 'story' },
          { name: '📦 Contracts', value: 'contract' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const type = interaction.options.getString('type') as
      | 'daily'
      | 'weekly'
      | 'story'
      | 'contract'
      | null;
    await interaction.editReply(await questsView(context, type ?? undefined));
  },
};

const rerollQuete: Command = {
  category: 'progression',
  cooldown: { seconds: 5, bucket: 'reroll' },
  data: new SlashCommandBuilder()
    .setName('reroll-quest')
    .setDescription('Swap a daily quest for another one')
    .addStringOption((option) =>
      option.setName('quest').setDescription('The quest to reroll').setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await progressionService.rerollQuest(
      context.player,
      interaction.options.getString('quest', true),
    );

    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('quests.reroll_result_title'),
          [
            result.usedToken
              ? context.t('quests.reroll_token_used')
              : context.t('quests.reroll_cost_line', {
                  cost: formatCoins(result.cost, false, context.locale),
                }),
            '',
            `**${result.newQuest.title}**`,
            result.newQuest.description,
            context.t('quests.reroll_goal_line', { required: result.newQuest.required }),
          ].join('\n'),
        ),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const quests = await progressionService.listQuests(
      { id: context.playerId, level: 1 },
      { type: 'daily' },
    );
    await interaction.respond(
      quests
        .filter((quest) => quest.status === 'active')
        .slice(0, 25)
        .map((quest) => ({
          name: truncate(`${quest.title} (${quest.progress}/${quest.required})`, 100),
          value: quest.id,
        })),
    );
  },
};

const succes: Command = {
  category: 'progression',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('achievements')
    .setDescription('Your achievements and their progress')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter')
        .addChoices(
          { name: '🌾 Farming', value: 'agriculture' },
          { name: '🐄 Livestock', value: 'elevage' },
          { name: '🛠️ Crafting', value: 'artisanat' },
          { name: '💰 Economy', value: 'economie' },
          { name: '⭐ Progression', value: 'progression' },
          { name: '🤝 Social', value: 'social' },
          { name: '🔥 Loyalty', value: 'fidelite' },
          { name: '🗺️ Estate', value: 'domaine' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const category = interaction.options.getString('category') ?? undefined;
    const achievements = await progressionService.listAchievements(context.player.id, category, context.locale);

    const unlocked = achievements.filter((entry) => entry.unlocked);
    const claimable = unlocked.filter((entry) => !entry.claimed);

    const lines = achievements.slice(0, 18).map((entry) => {
      const progress = Number(entry.progress ?? 0);
      const target = Number(entry.conditionAmount);
      const status = entry.unlocked
        ? entry.claimed
          ? '✅'
          : context.t('progression.achievements_to_claim')
        : `${progressBar(progress, target, 8)} ${formatCompact(progress, context.locale)}/${formatCompact(target, context.locale)}`;
      return `${entry.icon} **${entry.name}** · ${status}\n   *${entry.description}*`;
    });

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: context.t('progression.achievements_title'),
          description: lines.join('\n') || context.t('progression.achievements_empty'),
          color: COLORS.gold,
          footer: context.t('progression.achievements_footer', {
            unlocked: unlocked.length,
            total: achievements.length,
            claimablePart:
              claimable.length > 0
                ? context.t('progression.achievements_claimable_part', { count: claimable.length })
                : '',
          }),
        }),
      ],
      components:
        claimable.length > 0
          ? [
              row(
                button({
                  namespace: 'achv',
                  action: 'claim_all',
                  ownerId: interaction.user.id,
                  label: context.t('progression.achievements_claim_button', { count: claimable.length }),
                  emoji: '🎁',
                  style: ButtonStyle.Success,
                }),
              ),
            ]
          : [],
    });
  },
};

const passe: Command = {
  category: 'progression',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('pass')
    .setDescription('Your free season pass')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const pass = await progressionService.getSeasonPass(context.player.id);

    if (!pass) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: context.t('progression.pass_title'),
            description: context.t('progression.pass_inactive_body'),
            color: COLORS.info,
          }),
        ],
      });
      return;
    }

    const nextTiers = pass.tiers
      .filter((tier) => tier.tier > pass.tier)
      .slice(0, 3)
      .map((tier) => {
        const free = tier.free as { coins?: number; gems?: number; items?: Array<{ itemKey: string; quantity: number }> };
        return context.t('progression.pass_tier_line', {
          tier: tier.tier,
          rewards: [
            free.coins ? `${formatCompact(free.coins, context.locale)} 🪙` : '',
            free.gems ? `${free.gems} 💎` : '',
            free.items ? describeItems(free.items, context.locale) : '',
          ]
            .filter(Boolean)
            .join(' · '),
        });
      });

    const claimable = pass.tiers.filter(
      (tier) => tier.tier <= pass.tier && !pass.claimedTiers.includes(tier.tier),
    );

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: context.t('progression.pass_active_title', { name: pass.name }),
          description: [
            context.t('progression.pass_tier_progress', { tier: pass.tier, max: pass.maxTier }),
            context.t('progression.pass_xp_line', {
              bar: progressBar(pass.passXp % pass.xpPerTier, pass.xpPerTier, 14),
              xp: formatNumber(pass.passXp % pass.xpPerTier, context.locale),
              max: formatNumber(pass.xpPerTier, context.locale),
            }),
            context.t('progression.pass_ends_line', { relative: discordTimestamp(pass.endsAt, 'R') }),
            '',
            pass.premium
              ? context.t('progression.pass_premium_unlocked')
              : context.t('progression.pass_premium_locked', {
                  count: context.balance.seasonPass.premiumVotesRequired,
                }),
          ].join('\n'),
          color: COLORS.xp,
          fields: [
            {
              name: context.t('progression.pass_claim_field'),
              value:
                claimable.length > 0
                  ? context.t('progression.pass_claim_available', { count: claimable.length })
                  : context.t('progression.pass_claim_none'),
            },
            {
              name: context.t('progression.pass_next_field'),
              value: nextTiers.join('\n') || context.t('progression.pass_completed'),
            },
          ],
        }),
      ],
      components:
        claimable.length > 0
          ? [
              row(
                button({
                  namespace: 'pass',
                  action: 'claim_all',
                  ownerId: interaction.user.id,
                  label: context.t('progression.pass_claim_button', { count: claimable.length }),
                  emoji: '🎁',
                  style: ButtonStyle.Success,
                }),
              ),
            ]
          : [],
    });
  },
};

const daily: Command = {
  category: 'progression',
  cooldown: { seconds: 0, bucket: 'daily' },
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily reward')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await progressionService.claimDaily(context.player);

    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('progression.daily_title', { day: result.streak }),
          [
            context.t('progression.daily_reward_line', {
              coins: formatCoins(result.coins, false, context.locale),
              xp: formatNumber(result.xp, context.locale),
              gemsPart:
                result.gems > 0 ? context.t('progression.daily_gems_part', { gems: result.gems }) : '',
            }),
            result.items.length > 0
              ? context.t('progression.daily_bonus_line', {
                  items: describeItems(result.items, context.locale),
                })
              : '',
            '',
            result.streakBroken
              ? context.t('progression.daily_streak_broken')
              : result.usedFreeze
                ? context.t('progression.daily_freeze_used')
                : context.t('progression.daily_streak_line', {
                    count: result.streak,
                    best: result.longestStreak,
                  }),
            context.t('progression.daily_next_line', {
              relative: discordTimestamp(result.nextClaimAt, 'R'),
            }),
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ],
      components: [
        row(
          button({
            namespace: 'quest',
            action: 'open',
            ownerId: interaction.user.id,
            label: context.t('suggestion.quests'),
            emoji: '📋',
          }),
          button({
            namespace: 'farm',
            action: 'refresh',
            ownerId: interaction.user.id,
            label: context.t('common.my_farm'),
            emoji: '🌾',
          }),
        ),
      ],
    });
  },
};

const vote: Command = {
  category: 'progression',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Vote for the bot and claim your gems')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const info = miscService.voteInfo();
    const cooldown = await peek(context.player.id, 'vote');

    await safeReply(interaction, {
      embeds: [
        baseEmbed({
          title: context.t('progression.vote_title'),
          description: [
            context.t('progression.vote_reward_line', {
              gems: info.rewardGems,
              coins: formatCoins(info.rewardCoins, false, context.locale),
            }),
            context.t('progression.vote_weekend_line', { multiplier: info.weekendMultiplier }),
            context.t('progression.vote_cooldown_line', { hours: info.cooldownHours }),
            '',
            cooldown.active
              ? context.t('progression.vote_wait_line', {
                  relative: discordTimestamp(cooldown.retryAt, 'R'),
                })
              : context.t('progression.vote_ready_line'),
            '',
            context.t('progression.vote_footer_line'),
          ].join('\n'),
          color: COLORS.info,
        }),
      ],
      components: [row(linkButton(context.t('progression.vote_button'), info.url, '🗳️'))],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const commands: Command[] = [quetes, rerollQuete, succes, passe, daily, vote];
