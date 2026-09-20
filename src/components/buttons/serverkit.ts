import { PermissionFlagsBits, type ButtonInteraction } from 'discord.js';
import { env } from '../../config/env';
import { followUpEphemeral, isGuest } from '../../framework/interaction';
import { COLORS, baseEmbed } from '../../framework/ui';
import * as systemRepo from '../../repositories/system.repo';
import { ROLES } from '../../serverkit/blueprint';
import {
  buildKit,
  isKitRunning,
  planKit,
  wipeKit,
  type KitReport,
  type Progress,
} from '../../serverkit/builder';
import { slugsOf } from '../../serverkit/naming';
import {
  buildReportEmbed,
  decodeFlags,
  decodeStyle,
  parseScope,
  parseStyle,
  progressEmbed,
  wipeReportEmbed,
} from '../../serverkit/views';
import { paramString } from '../../utils/custom-id';
import { gameError } from '../../utils/errors';
import { slugify } from '../../utils/fancy-text';
import { moduleLogger } from '../../utils/logger';
import type { ButtonHandler, CommandContext } from '../../types';

const log = moduleLogger('serverkit');

/** Un chantier dure des minutes : l'écran d'avancement n'est rafraîchi qu'à ce rythme. */
const PROGRESS_INTERVAL_MS = 2_500;

function progressReporter(interaction: ButtonInteraction, context: CommandContext): (progress: Progress) => void {
  let last = 0;
  return (progress) => {
    const now = Date.now();
    if (now - last < PROGRESS_INTERVAL_MS && progress.done < progress.total) return;
    last = now;
    // Volontairement non attendu : l'affichage ne doit jamais ralentir le
    // chantier, et un jeton d'interaction expiré (15 min) ne doit pas l'arrêter.
    interaction.editReply({ embeds: [progressEmbed(progress, context.t)], components: [] }).catch(() => undefined);
  };
}

async function audit(
  interaction: ButtonInteraction,
  context: CommandContext,
  guildId: string,
  action: string,
  report: KitReport,
  details: Record<string, unknown>,
): Promise<void> {
  await systemRepo
    .audit({
      actorId: isGuest(context) ? null : context.player.id,
      actorDiscordId: interaction.user.id,
      action,
      targetType: 'guild',
      targetId: guildId,
      discordGuildId: guildId,
      payload: {
        ...details,
        created: report.created,
        updated: report.updated,
        kept: report.kept,
        removed: report.removed,
        failed: report.failed.length,
        durationMs: report.durationMs,
      },
      severity: action === 'serverkit_wipe' ? 'warning' : 'info',
    })
    .catch((error: unknown) => log.warn({ err: error }, "journal d'audit du kit serveur non écrit"));
}

/** Confirmation de `/serverkit build` et `/serverkit wipe` — c'est ICI que le serveur est modifié. */
const kitConfirm: ButtonHandler = {
  namespace: 'serverkit',
  actions: ['build', 'wipe'],
  adminOnly: true,
  requiresAccount: false,
  lockKey: 'serverkit',

  async execute(interaction, parsed, context): Promise<void> {
    // Même barrière stricte que la commande : `adminOnly` accepte aussi le
    // drapeau `is_admin` de la base, pas ce gestionnaire.
    if (!env.BOT_OWNER_IDS.includes(interaction.user.id)) {
      throw gameError('forbidden', context.t('serverkit.ui.owner_only_body'));
    }
    if (!interaction.inCachedGuild()) throw gameError('invalid_state', context.t('common.guild_only_body'));

    if (paramString(parsed, 0) !== 'yes') {
      await interaction.update({
        embeds: [
          baseEmbed({
            title: context.t('serverkit.ui.cancelled_title'),
            description: context.t('serverkit.ui.cancelled_body'),
            color: COLORS.neutral,
          }),
        ],
        components: [],
      });
      return;
    }

    // Dernier paramètre des deux actions : le serveur visé, qui n'est pas
    // forcément celui où le bouton est cliqué (option `server` de la commande).
    const guildId = paramString(parsed, parsed.action === 'wipe' ? 2 : 4, interaction.guildId);
    const guild = interaction.client.guilds.cache.get(guildId);
    if (!guild) throw gameError('not_found', context.t('serverkit.ui.unknown_server', { id: guildId }));
    if (isKitRunning(guild.id)) throw gameError('busy', context.t('serverkit.ui.busy'));
    await interaction.deferUpdate();
    const onProgress = progressReporter(interaction, context);
    const reason = `Harvester serverkit (${interaction.user.username})`;

    if (parsed.action === 'wipe') {
      const scope = paramString(parsed, 1) === 'all' ? 'all' : 'kit';
      const style = parseStyle(null, null, null, context.locale === 'en' ? 'en' : 'fr');
      const report = await wipeKit(guild, scope, { style, keepChannelId: interaction.channelId, reason }, onProgress);
      await audit(interaction, context, guild.id, 'serverkit_wipe', report, { scope });
      await interaction.editReply({ embeds: [wipeReportEmbed(report, context.t)], components: [] });
      return;
    }

    const style = decodeStyle(paramString(parsed, 2), context.locale === 'en' ? 'en' : 'fr');
    const scope = parseScope(paramString(parsed, 1));
    const report = await buildKit(
      guild,
      {
        style,
        scope,
        ...decodeFlags(paramString(parsed, 3)),
        invokerId: interaction.user.id,
        reason,
      },
      onProgress,
    );
    await audit(interaction, context, guild.id, 'serverkit_build', report, { scope, ...style });

    const reminders = planKit(guild, style)
      .categories.flatMap((category) => category.channels)
      .find((channel) => channel.spec.key === 'reminders');
    await interaction.editReply({
      embeds: [
        buildReportEmbed(
          report,
          context.t,
          reminders?.existing ? `<#${reminders.existing.id}>` : (reminders?.name ?? ''),
        ),
      ],
      components: [],
    });
  },
};

/** Droits qu'un rôle en libre-service ne doit JAMAIS porter, quoi qu'on lui ait ajouté depuis. */
const SENSITIVE =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageWebhooks |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.MentionEveryone;

/**
 * Boutons du panneau des rôles : chacun prend ou rend un rôle de notification
 * ou de langue. Public par nature (`PUBLIC_OWNER`), donc verrouillé autrement :
 * la clé reçue doit désigner un rôle `selfAssignable` du plan, et le rôle
 * retrouvé sur le serveur ne doit porter aucun droit sensible.
 */
const kitRoles: ButtonHandler = {
  namespace: 'serverkit',
  actions: ['role'],
  checkOwner: false,
  requiresAccount: false,

  async execute(interaction, parsed, context): Promise<void> {
    if (!interaction.inCachedGuild()) throw gameError('invalid_state', context.t('common.guild_only_body'));
    await interaction.deferUpdate();

    const spec = ROLES.find((role) => role.key === paramString(parsed, 0));
    if (!spec?.selfAssignable) throw gameError('forbidden', context.t('serverkit.ui.role_forbidden'));

    const slugs = slugsOf('roles', spec.key);
    const role = interaction.guild.roles.cache.find(
      (candidate) => !candidate.managed && candidate.id !== interaction.guildId && slugs.has(slugify(candidate.name)),
    );
    if (!role) throw gameError('not_found', context.t('serverkit.ui.role_missing'));
    if (role.permissions.any(SENSITIVE)) throw gameError('forbidden', context.t('serverkit.ui.role_forbidden'));

    const owned = interaction.member.roles.cache.has(role.id);
    try {
      if (owned) await interaction.member.roles.remove(role);
      else await interaction.member.roles.add(role);
    } catch {
      throw gameError('invalid_state', context.t('serverkit.ui.role_failed', { role: role.toString() }));
    }
    await followUpEphemeral(interaction, {
      content: context.t(owned ? 'serverkit.ui.role_removed' : 'serverkit.ui.role_added', { role: role.toString() }),
    });
  },
};

export const handlers: ButtonHandler[] = [kitConfirm, kitRoles];
