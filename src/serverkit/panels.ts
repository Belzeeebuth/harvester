import {
  ChannelType,
  type ActionRowBuilder,
  type ButtonBuilder,
  type EmbedBuilder,
  type Guild,
} from 'discord.js';
import { env } from '../config/env';
import { FOOTER, baseEmbed, button, linkButton, row } from '../framework/ui';
import { translatorFor } from '../i18n';
import { PUBLIC_OWNER } from '../utils/custom-id';
import { PANELS, ROLES, allChannels, selfAssignableRoles, type PanelKey, type RoleGroup } from './blueprint';
import { labelOf, renderChannel, renderRole, type KitStyle } from './naming';

/**
 * Panneaux d'information : l'embed posé dans un salon à sa création
 * (bienvenue, règlement, rôles, guide, FAQ, mémo d'équipe).
 *
 * Un panneau se RECONNAÎT à son pied de page (`panelMarker`). Le constructeur
 * s'en sert pour modifier le message en place au lieu d'en empiler un nouveau
 * à chaque passage — relancer `/serverkit build scope:panels` après avoir
 * retouché un texte met le salon à jour sans le salir.
 */

/** Droits d'invitation affichés sur le site public (`site/index.html`). */
const INVITE_PERMISSIONS = '278528';

export interface PanelRefs {
  channelIds: Map<string, string>;
  roleIds: Map<string, string>;
}

export function panelMarker(key: PanelKey): string {
  return `${FOOTER} ・ ${key}`;
}

/**
 * Paramètres d'interpolation communs à tous les panneaux : `{ch_rules}`,
 * `{role_moderator}`… Une mention cliquable quand l'entrée existe sur le
 * serveur, son nom rendu sinon — un panneau posé avant ses salons reste lisible.
 */
function mentionParams(style: KitStyle, refs: PanelRefs): Record<string, string> {
  const params: Record<string, string> = {};
  for (const { channel } of allChannels()) {
    const id = refs.channelIds.get(channel.key);
    params[`ch_${channel.key}`] = id ? `<#${id}>` : renderChannel(channel, style);
  }
  for (const role of ROLES) {
    const id = refs.roleIds.get(role.key);
    params[`role_${role.key}`] = id ? `<@&${id}>` : renderRole(role, style);
  }
  return params;
}

function roleButtons(style: KitStyle, group: RoleGroup): ActionRowBuilder<ButtonBuilder> {
  return row(
    ...selfAssignableRoles()
      .filter((role) => role.group === group)
      .map((role) =>
        button({
          namespace: 'serverkit',
          action: 'role',
          ownerId: PUBLIC_OWNER,
          params: [role.key],
          label: labelOf('roles', role.key, style.locale),
          emoji: role.emoji,
        }),
      ),
  );
}

export function buildPanel(
  key: PanelKey,
  style: KitStyle,
  refs: PanelRefs,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const t = translatorFor(style.locale);
  const params = mentionParams(style, refs);
  const spec = PANELS[key];

  const embed = baseEmbed({
    title: t(`serverkit.panels.${key}.title`),
    description: t(`serverkit.panels.${key}.body`, params),
    color: spec.color,
    footer: panelMarker(key),
    fields: spec.fields.map((field) => ({
      name: t(`serverkit.panels.${key}.fields.${field}.name`),
      value: t(`serverkit.panels.${key}.fields.${field}.value`, params),
    })),
  });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (key === 'roles') components.push(roleButtons(style, 'notify'), roleButtons(style, 'language'));
  if (key === 'welcome') {
    const invite =
      `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_CLIENT_ID}` +
      `&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
    components.push(row(linkButton(t('serverkit.panels.welcome.invite_button'), invite, '🌾')));
  }
  return { embeds: [embed], components };
}

export async function postPanel(
  guild: Guild,
  channelId: string,
  key: PanelKey,
  style: KitStyle,
  refs: PanelRefs,
): Promise<'created' | 'updated'> {
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
  if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) {
    throw new Error('panel target is not a text channel');
  }

  const payload = buildPanel(key, style, refs);
  const marker = panelMarker(key);
  const recent = await channel.messages.fetch({ limit: 30 });
  const previous = recent.find(
    (message) =>
      message.author.id === guild.client.user.id && message.embeds.some((embed) => embed.footer?.text === marker),
  );

  if (previous) {
    await previous.edit(payload);
    return 'updated';
  }
  await channel.send(payload);
  return 'created';
}
