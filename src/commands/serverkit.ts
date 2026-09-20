import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
} from 'discord.js';
import { env } from '../config/env';
import { replyEphemeral } from '../framework/interaction';
import { confirmRow, warningEmbed } from '../framework/ui';
import { SUPPORTED_LOCALES } from '../i18n';
import { isKitRunning, missingBuildPermissions, planKit, wipeTargets } from '../serverkit/builder';
import { FRAMES, textChannelName } from '../serverkit/naming';
import {
  EXISTING_MODES,
  FONT_LABELS,
  FRAME_LABELS,
  KIT_SCOPES,
  confirmBuildEmbed,
  encodeFlags,
  encodeStyle,
  parseExisting,
  parseScope,
  parseStyle,
  previewEmbed,
  stylesEmbed,
} from '../serverkit/views';
import { gameError } from '../utils/errors';
import { FANCY_FONTS } from '../utils/fancy-text';
import type { Command } from '../types';

/**
 * `/serverkit` — bâtit de A à Z le serveur communautaire de Harvester : rôles,
 * catégories, salons, permissions, réglages et panneaux d'accueil, dans la
 * direction artistique du bot (palette de `brand.ts`, ton de Greenvale).
 *
 * RÉSERVÉ AUX PROPRIÉTAIRES DU BOT, au sens strict : `adminOnly` accepte aussi
 * le drapeau `users.is_admin` posé en base, ce qui convient à `/admin give`
 * mais pas à une commande capable de raser un serveur. L'identifiant du
 * cliqueur est donc revérifié ici contre `BOT_OWNER_IDS`, et une seconde fois
 * dans le gestionnaire des boutons de confirmation.
 *
 * CIBLE. Les commandes de ce bot sont souvent publiées sur le seul serveur de
 * développement (`DISCORD_DEV_GUILD_ID`) : `/serverkit` n'existerait alors pas
 * sur le serveur neuf qu'on veut bâtir. L'option `server` vise donc n'importe
 * quel serveur où le bot est présent, depuis celui où la commande existe.
 *
 * Rien n'est modifié par la commande elle-même : `build` et `wipe` n'affichent
 * qu'un écran de confirmation ; le chantier part du bouton
 * (`components/buttons/serverkit.ts`).
 */

const SCOPE_LABELS: Record<(typeof KIT_SCOPES)[number], string> = {
  all: 'Everything: roles, channels, settings, panels',
  roles: 'Roles only',
  channels: 'Categories and channels only',
  settings: 'Server settings only',
  panels: 'Info panels only (welcome, rules, roles, guide…)',
};

/** Serveur visé, quand ce n'est pas celui où la commande est tapée. */
function withTargetOption(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return sub.addStringOption((option) =>
    option
      .setName('server')
      .setDescription('Target server ID, when it is not this one (the bot must be a member)')
      .setMinLength(17)
      .setMaxLength(20),
  );
}

/** Options de style communes à `preview` et `build`. */
function withStyleOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return withTargetOption(sub)
    .addStringOption((option) =>
      option
        .setName('language')
        .setDescription('Language of names, topics and panels (default: your language)')
        .addChoices(...SUPPORTED_LOCALES.map((locale) => ({ name: locale, value: locale }))),
    )
    .addStringOption((option) =>
      option
        .setName('font')
        .setDescription('Fancy Unicode font used in every name (default: bold)')
        .addChoices(
          ...FANCY_FONTS.map((font) => ({
            name: `${FONT_LABELS[font]} ・ ${textChannelName('🌾', 'greenvale', { locale: 'en', font, frame: 'dot' })}`,
            value: font,
          })),
        ),
    )
    .addStringOption((option) =>
      option
        .setName('frame')
        .setDescription('Decoration around the emoji (default: dot)')
        .addChoices(
          ...FRAMES.map((frame) => ({
            name: `${FRAME_LABELS[frame]} ・ ${textChannelName('🌾', 'greenvale', { locale: 'en', font: 'bold', frame })}`,
            value: frame,
          })),
        ),
    );
}

const serverkit: Command = {
  category: 'admin',
  adminOnly: true,
  requiresAccount: false,
  dmAllowed: false,
  cooldown: { seconds: 0 },
  requiredPermissions: [PermissionFlagsBits.Administrator],
  data: new SlashCommandBuilder()
    .setName('serverkit')
    .setDescription('Bot owner only: build a complete Harvester community server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName('styles').setDescription('Show every fancy font and frame available for names'),
    )
    .addSubcommand((sub) =>
      withStyleOptions(
        sub.setName('preview').setDescription('Dry run: show the full blueprint and what already exists'),
      ),
    )
    .addSubcommand((sub) =>
      withStyleOptions(
        sub
          .setName('build')
          .setDescription('Create roles, categories, channels, permissions, settings and panels')
          .addStringOption((option) =>
            option
              .setName('scope')
              .setDescription('What to build (default: everything)')
              .addChoices(...KIT_SCOPES.map((scope) => ({ name: SCOPE_LABELS[scope], value: scope }))),
          )
          .addStringOption((option) =>
            option
              .setName('existing')
              .setDescription('Items already on the server (default: keep them untouched)')
              .addChoices(
                { name: 'Keep untouched', value: EXISTING_MODES[0]! },
                { name: 'Sync: rename, move and fix permissions to match the blueprint', value: EXISTING_MODES[1]! },
              ),
          )
          .addBooleanOption((option) =>
            option
              .setName('community')
              .setDescription('Try to enable Community mode for announcements, forums, stage (default: yes)'),
          ),
      ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('wipe')
        .setDescription('Delete what the kit created, or the whole server layout')
        .addStringOption((option) =>
          option
            .setName('scope')
            .setDescription('What to delete')
            .setRequired(true)
            .addChoices(
              { name: 'Kit: only channels and roles matching the blueprint', value: 'kit' },
              { name: 'All: EVERY channel and role (server_name required)', value: 'all' },
            ),
        )
        .addStringOption((option) =>
          option.setName('server_name').setDescription('Exact server name, required to wipe everything'),
        )
        .addStringOption((option) =>
          option
            .setName('server')
            .setDescription('Target server ID, when it is not this one (the bot must be a member)')
            .setMinLength(17)
            .setMaxLength(20),
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    if (!env.BOT_OWNER_IDS.includes(interaction.user.id)) {
      await replyEphemeral(interaction, {
        embeds: [warningEmbed(context.t('serverkit.ui.owner_only_title'), context.t('serverkit.ui.owner_only_body'))],
      });
      return;
    }
    if (!interaction.inCachedGuild()) {
      throw gameError('invalid_state', context.t('common.guild_only_body'));
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const targetId = sub === 'styles' ? null : interaction.options.getString('server')?.trim();
    const guild = targetId ? interaction.client.guilds.cache.get(targetId) : interaction.guild;
    if (!guild) throw gameError('not_found', context.t('serverkit.ui.unknown_server', { id: targetId ?? '' }));
    const style = parseStyle(
      interaction.options.getString('language'),
      interaction.options.getString('font'),
      interaction.options.getString('frame'),
      context.locale === 'en' ? 'en' : 'fr',
    );

    if (sub === 'styles') {
      await interaction.editReply({ embeds: [stylesEmbed(context.t, style.locale)] });
      return;
    }

    if (sub === 'preview') {
      await interaction.editReply({ embeds: [previewEmbed(planKit(guild, style), guild.name, context.t)] });
      return;
    }

    if (isKitRunning(guild.id)) throw gameError('busy', context.t('serverkit.ui.busy'));
    const missing = await missingBuildPermissions(guild);
    if (missing.length > 0) {
      await interaction.editReply({
        embeds: [
          warningEmbed(
            context.t('serverkit.ui.missing_permissions_title'),
            context.t('serverkit.ui.missing_permissions_body', { permissions: missing.join(', ') }),
          ),
        ],
      });
      return;
    }

    if (sub === 'build') {
      const options = {
        style,
        scope: parseScope(interaction.options.getString('scope')),
        existing: parseExisting(interaction.options.getString('existing')),
        community: interaction.options.getBoolean('community') ?? true,
        invokerId: interaction.user.id,
        reason: '',
      };
      await interaction.editReply({
        embeds: [confirmBuildEmbed(planKit(guild, style), options, guild.name, context.t)],
        components: [
          confirmRow(
            {
              namespace: 'serverkit',
              action: 'build',
              ownerId: interaction.user.id,
              params: [options.scope, encodeStyle(style), encodeFlags(options.existing, options.community), guild.id],
            },
            context.locale,
            context.t,
          ),
        ],
      });
      return;
    }

    // --- wipe ---------------------------------------------------------------
    const scope = interaction.options.getString('scope', true) === 'all' ? 'all' : 'kit';
    if (scope === 'all' && interaction.options.getString('server_name')?.trim() !== guild.name) {
      throw gameError('invalid_state', context.t('serverkit.ui.wipe_name_mismatch', { guild: guild.name }));
    }
    const targets = await wipeTargets(guild, scope, { style, keepChannelId: interaction.channelId });
    await interaction.editReply({
      embeds: [
        warningEmbed(
          context.t('serverkit.ui.wipe_confirm_title'),
          context.t(`serverkit.ui.wipe_confirm_${scope}`, {
            channels: targets.channels.length,
            roles: targets.roles.length,
            guild: guild.name,
          }),
        ),
      ],
      components: [
        confirmRow(
          { namespace: 'serverkit', action: 'wipe', ownerId: interaction.user.id, params: [scope, guild.id], danger: true },
          context.locale,
          context.t,
        ),
      ],
    });
  },
};

export const commands: Command[] = [serverkit];
