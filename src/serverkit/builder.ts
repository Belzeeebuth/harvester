import {
  ChannelType,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildFeature,
  GuildVerificationLevel,
  Locale,
  OverwriteType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type GuildForumTagData,
  type NonThreadGuildBasedChannel,
  type OverwriteData,
  type Role,
} from 'discord.js';
import { translatorFor } from '../i18n';
import { toError } from '../utils/errors';
import { slugify } from '../utils/fancy-text';
import { moduleLogger } from '../utils/logger';
import {
  CATEGORIES,
  EVERYONE_PERMISSIONS,
  ROLES,
  type AccessProfile,
  type CategorySpec,
  type ChannelSpec,
  type RoleSpec,
} from './blueprint';
import { renderCategory, renderChannel, renderRole, slugsOf, type KitStyle } from './naming';
import { postPanel } from './panels';

const log = moduleLogger('serverkit');

/**
 * Exécution du plan sur un serveur Discord réel.
 *
 * Trois principes tiennent tout le module :
 *  1. REJOUABLE. Une entrée déjà présente est reconnue par l'empreinte de son
 *     libellé (`slugsOf`), jamais recréée. Relancer après un échec, ou pour
 *     changer de police, ne fabrique pas de doublon.
 *  2. RIEN NE FAIT TOMBER LE RESTE. Chaque appel Discord passe par `attempt` :
 *     un refus (rôle placé au-dessus du bot, salon protégé…) est consigné dans
 *     le rapport et le chantier continue. Quarante salons posés et deux échecs
 *     expliqués valent mieux qu'un arrêt au troisième appel.
 *  3. DEUX MODES face à l'existant : `keep` n'y touche pas, `sync` le réaligne
 *     sur le plan (nom, catégorie, sujet, droits).
 */

export type KitScope = 'all' | 'roles' | 'channels' | 'panels' | 'settings';
export type ExistingMode = 'keep' | 'sync';
export type WipeScope = 'kit' | 'all';

export interface BuildOptions {
  style: KitStyle;
  scope: KitScope;
  existing: ExistingMode;
  /** Tenter d'activer le mode « Communauté » (annonces, forums, scène). */
  community: boolean;
  /** Reçoit le rôle de fondateur s'il est propriétaire du serveur. */
  invokerId: string;
  /** Motif inscrit dans le journal d'audit de Discord. */
  reason: string;
}

export interface KitNote {
  key: string;
  params?: Record<string, string | number>;
}

export interface KitReport {
  created: number;
  updated: number;
  kept: number;
  removed: number;
  failed: Array<{ name: string; reason: string }>;
  notes: KitNote[];
  durationMs: number;
}

export interface Progress {
  phase: 'roles' | 'categories' | 'channels' | 'settings' | 'panels' | 'wipe';
  done: number;
  total: number;
}

export type ProgressListener = (progress: Progress) => void;

// ---------------------------------------------------------------------------
// Plan : ce qui existe déjà, ce qui manque
// ---------------------------------------------------------------------------

export interface PlannedRole {
  spec: RoleSpec;
  name: string;
  existing?: Role;
}

export interface PlannedChannel {
  spec: ChannelSpec;
  name: string;
  existing?: NonThreadGuildBasedChannel;
}

export interface PlannedCategory {
  spec: CategorySpec;
  name: string;
  existing?: CategoryChannel;
  channels: PlannedChannel[];
}

export interface KitPlan {
  style: KitStyle;
  roles: PlannedRole[];
  categories: PlannedCategory[];
}

const TEXT_FAMILY: ChannelType[] = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
const VOICE_FAMILY: ChannelType[] = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

const isVoiceKind = (spec: ChannelSpec): boolean => spec.kind === 'voice' || spec.kind === 'stage';

/** Premier élément dont l'empreinte figure dans `slugs`, et pas déjà attribué. */
function claim<T extends { id: string; name: string }>(
  pool: Iterable<T>,
  slugs: Set<string>,
  taken: Set<string>,
): T | undefined {
  for (const candidate of pool) {
    if (taken.has(candidate.id)) continue;
    const slug = slugify(candidate.name);
    if (slug && slugs.has(slug)) {
      taken.add(candidate.id);
      return candidate;
    }
  }
  return undefined;
}

export function planKit(guild: Guild, style: KitStyle): KitPlan {
  const taken = new Set<string>();
  const channels = [...guild.channels.cache.values()].filter(
    (channel): channel is NonThreadGuildBasedChannel => !channel.isThread(),
  );
  const freeRoles = [...guild.roles.cache.values()].filter((role) => !role.managed && role.id !== guild.id);
  const categories = channels.filter(
    (channel): channel is CategoryChannel => channel.type === ChannelType.GuildCategory,
  );

  return {
    style,
    roles: ROLES.map((spec) => ({
      spec,
      name: renderRole(spec, style),
      existing: claim(freeRoles, slugsOf('roles', spec.key), taken),
    })),
    categories: CATEGORIES.map((spec) => ({
      spec,
      name: renderCategory(spec, style),
      existing: claim(categories, slugsOf('categories', spec.key), taken),
      channels: spec.channels.map((channel) => {
        const family = isVoiceKind(channel) ? VOICE_FAMILY : TEXT_FAMILY;
        return {
          spec: channel,
          name: renderChannel(channel, style),
          existing: claim(
            channels.filter((candidate) => family.includes(candidate.type)),
            slugsOf('channels', channel.key),
            taken,
          ),
        };
      }),
    })),
  };
}

export function planTotals(plan: KitPlan): { missing: number; existing: number } {
  const items = [
    ...plan.roles,
    ...plan.categories,
    ...plan.categories.flatMap((category) => category.channels),
  ];
  const existing = items.filter((item) => item.existing).length;
  return { existing, missing: items.length - existing };
}

// ---------------------------------------------------------------------------
// Outils d'exécution
// ---------------------------------------------------------------------------

const running = new Set<string>();

/** Un chantier est-il en cours sur ce serveur ? (le verrou joueur expire en 30 s) */
export function isKitRunning(guildId: string): boolean {
  return running.has(guildId);
}

/**
 * Discord ne permet que deux renommages par salon et par tranche de dix
 * minutes ; au troisième, discord.js ATTEND la fin de la pénalité au lieu
 * d'échouer. Sans garde, un simple changement de police figerait le chantier
 * dix minutes sur un seul salon. Passé ce délai l'étape est consignée comme
 * échouée — la requête, elle, aboutira d'elle-même un peu plus tard.
 */
const STEP_TIMEOUT_MS = 45_000;

function emptyReport(): KitReport {
  return { created: 0, updated: 0, kept: 0, removed: 0, failed: [], notes: [], durationMs: 0 };
}

async function attempt<T>(report: KitReport, label: string, operation: () => Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout (Discord rate limit)')), STEP_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    const reason = toError(error).message;
    report.failed.push({ name: label, reason });
    log.warn({ label, reason }, 'étape du kit serveur en échec');
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Le bot a-t-il de quoi bâtir ? Renvoie les permissions manquantes. */
export async function missingBuildPermissions(guild: Guild): Promise<string[]> {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  // Poser des surcharges de permissions exige de détenir soi-même chaque droit
  // accordé ou refusé : seul `Administrator` couvre tout le plan d'un coup.
  return me.permissions.has(PermissionFlagsBits.Administrator) ? [] : ['Administrator'];
}

interface AccessContext {
  everyoneId: string;
  botId: string;
  senior: string[];
  junior: string[];
  bots?: string;
}

const STAFF_WRITE = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];

const BOT_WRITE = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];

/** Traduit un profil d'accès en surcharges de permissions. */
export function overwritesFor(access: AccessProfile, context: AccessContext): OverwriteData[] {
  const role = (id: string, allow: bigint[], deny: bigint[] = []): OverwriteData => ({
    id,
    type: OverwriteType.Role,
    allow,
    deny,
  });
  // Le bot garde la main partout où @everyone la perd : il doit pouvoir poster
  // ses panneaux et ses rappels même si on lui retire `Administrator` ensuite.
  const bot: OverwriteData = { id: context.botId, type: OverwriteType.Member, allow: BOT_WRITE };
  const staff = [...context.senior, ...context.junior];

  switch (access) {
    case 'public':
      return [];
    case 'readonly':
      return [
        role(context.everyoneId, [], [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
        ]),
        ...staff.map((id) => role(id, STAFF_WRITE)),
        ...(context.bots ? [role(context.bots, BOT_WRITE.slice(0, 4))] : []),
        bot,
      ];
    case 'staff':
    case 'senior':
      return [
        role(context.everyoneId, [], [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]),
        ...(access === 'senior' ? context.senior : staff).map((id) => role(id, STAFF_WRITE)),
        bot,
      ];
    case 'afk':
      return [role(context.everyoneId, [], [PermissionFlagsBits.Speak, PermissionFlagsBits.Stream])];
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const includes = (scope: KitScope, part: Exclude<KitScope, 'all'>): boolean => scope === 'all' || scope === part;

function totalSteps(plan: KitPlan, options: BuildOptions): number {
  const channels = plan.categories.flatMap((category) => category.channels);
  return (
    (includes(options.scope, 'roles') ? plan.roles.length : 0) +
    (includes(options.scope, 'channels') ? plan.categories.length + channels.length : 0) +
    (includes(options.scope, 'settings') ? 1 : 0) +
    (includes(options.scope, 'panels') ? channels.filter((channel) => channel.spec.panel).length : 0)
  );
}

export async function buildKit(
  guild: Guild,
  options: BuildOptions,
  onProgress: ProgressListener = () => undefined,
): Promise<KitReport> {
  const started = Date.now();
  const report = emptyReport();
  running.add(guild.id);

  try {
    const plan = planKit(guild, options.style);
    const total = totalSteps(plan, options);
    let done = 0;
    const tick = (phase: Progress['phase']): void => {
      done += 1;
      onProgress({ phase, done, total });
    };

    const me = guild.members.me ?? (await guild.members.fetchMe());
    const roleIds = new Map<string, string>();
    const channelIds = new Map<string, string>();
    for (const planned of plan.roles) if (planned.existing) roleIds.set(planned.spec.key, planned.existing.id);
    for (const category of plan.categories) {
      for (const planned of category.channels) {
        if (planned.existing) channelIds.set(planned.spec.key, planned.existing.id);
      }
    }

    // --- Rôles -------------------------------------------------------------
    if (includes(options.scope, 'roles')) {
      await buildRoles(guild, plan, options, report, roleIds, () => tick('roles'));
      const botsRole = roleIds.get('bots');
      if (botsRole && !me.roles.cache.has(botsRole)) {
        await attempt(report, 'bots', () => me.roles.add(botsRole, options.reason));
      }
      const founder = roleIds.get('founder');
      if (founder && guild.ownerId === options.invokerId) {
        await attempt(report, 'founder', () =>
          guild.members.addRole({ user: options.invokerId, role: founder, reason: options.reason }),
        );
      }
    }

    const access: AccessContext = {
      everyoneId: guild.id,
      botId: me.id,
      senior: ROLES.filter((role) => role.staffTier === 'senior').flatMap((role) => roleIds.get(role.key) ?? []),
      junior: ROLES.filter((role) => role.staffTier === 'junior').flatMap((role) => roleIds.get(role.key) ?? []),
      bots: roleIds.get('bots'),
    };

    // --- Catégories et salons ----------------------------------------------
    //
    // Les deux salons qu'exige le mode Communauté (règlement, nouvelles de
    // Discord) sont posés EN PREMIER, puis le mode est activé, puis le reste :
    // c'est la seule façon d'obtenir de vrais salons d'annonces et une vraie
    // scène dès le premier passage, sans conversion après coup.
    const categoryIds = new Map<string, string>();
    if (includes(options.scope, 'channels')) {
      for (const planned of plan.categories) {
        const id = await ensureCategory(guild, planned, options, report, access);
        if (id) categoryIds.set(planned.spec.key, id);
        tick('categories');
      }
      for (const category of plan.categories) {
        for (const [position, planned] of category.channels.entries()) {
          if (planned.spec.wire !== 'rules' && planned.spec.wire !== 'updates') continue;
          const id = await ensureChannel(guild, planned, position, categoryIds.get(category.spec.key), options, report, access);
          if (id) channelIds.set(planned.spec.key, id);
          tick('channels');
        }
      }
    }

    if (includes(options.scope, 'settings') && options.community) {
      await enableCommunity(guild, options, report, channelIds);
    }

    if (includes(options.scope, 'channels')) {
      for (const category of plan.categories) {
        for (const [position, planned] of category.channels.entries()) {
          if (planned.spec.wire === 'rules' || planned.spec.wire === 'updates') continue;
          const id = await ensureChannel(guild, planned, position, categoryIds.get(category.spec.key), options, report, access);
          if (id) channelIds.set(planned.spec.key, id);
          tick('channels');
        }
      }
    }

    // --- Réglages du serveur ------------------------------------------------
    if (includes(options.scope, 'settings')) {
      await applySettings(guild, options, report, channelIds);
      tick('settings');
    }

    // --- Panneaux ------------------------------------------------------------
    if (includes(options.scope, 'panels')) {
      for (const category of plan.categories) {
        for (const planned of category.channels) {
          if (!planned.spec.panel) continue;
          const panel = planned.spec.panel;
          const channelId = channelIds.get(planned.spec.key);
          if (!channelId) {
            report.failed.push({ name: planned.name, reason: 'channel missing' });
          } else {
            const outcome = await attempt(report, planned.name, () =>
              postPanel(guild, channelId, panel, options.style, { channelIds, roleIds }),
            );
            if (outcome === 'created') report.created += 1;
            if (outcome === 'updated') report.updated += 1;
          }
          tick('panels');
        }
      }
    }
  } finally {
    running.delete(guild.id);
    report.durationMs = Date.now() - started;
  }

  log.info(
    { guildId: guild.id, scope: options.scope, created: report.created, updated: report.updated, failed: report.failed.length },
    'kit serveur appliqué',
  );
  return report;
}

async function buildRoles(
  guild: Guild,
  plan: KitPlan,
  options: BuildOptions,
  report: KitReport,
  roleIds: Map<string, string>,
  tick: () => void,
): Promise<void> {
  // Créés de haut en bas : Discord insère chaque nouveau rôle tout en bas de
  // la liste, ce qui repousse les précédents vers le haut — l'ordre du plan
  // est donc obtenu sans le moindre appel de repositionnement.
  for (const planned of plan.roles) {
    const data = {
      name: planned.name,
      colors: { primaryColor: planned.spec.color },
      hoist: planned.spec.hoist ?? false,
      mentionable: false,
      permissions: planned.spec.permissions,
      reason: options.reason,
    };
    const existing = planned.existing;
    if (!existing) {
      const role = await attempt(report, planned.name, () => guild.roles.create(data));
      if (role) {
        roleIds.set(planned.spec.key, role.id);
        report.created += 1;
      }
    } else if (options.existing === 'sync') {
      if (await attempt(report, planned.name, () => existing.edit(data))) report.updated += 1;
    } else {
      report.kept += 1;
    }
    tick();
  }

  // L'ordre naturel tient à un comportement de Discord, pas à une garantie de
  // son API, et ne vaut plus rien dès qu'un rôle préexistait : le kit est donc
  // rangé explicitement, d'un bloc, sous le rôle du bot. En mode `keep`, on ne
  // déplace pas des rôles que le propriétaire a pu ranger lui-même.
  if (options.existing !== 'sync' && plan.roles.some((planned) => planned.existing)) return;

  // Chaque création décale le rôle du bot d'un rang, et le cache ne l'apprend
  // que par la passerelle, avec retard : sans ce rafraîchissement, `ceiling`
  // serait celui d'AVANT le chantier et les rangs calculés tomberaient sous zéro.
  await attempt(report, 'role order', () => guild.roles.fetch());
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const ceiling = me.roles.highest.position;
  // Seuls les rôles SOUS le bot sont déplaçables, et ils occupent déjà autant
  // de rangs qu'on leur en attribue : `ceiling - 1 - index` reste donc ≥ 1.
  const movable = ROLES.flatMap((spec) => {
    const role = guild.roles.cache.get(roleIds.get(spec.key) ?? '');
    return role && role.position < ceiling ? [role] : [];
  });
  if (movable.length < 2) return;
  await attempt(report, 'role order', () =>
    guild.roles.setPositions(movable.map((role, index) => ({ role: role.id, position: ceiling - 1 - index }))),
  );
}

async function ensureCategory(
  guild: Guild,
  planned: PlannedCategory,
  options: BuildOptions,
  report: KitReport,
  access: AccessContext,
): Promise<string | undefined> {
  const permissionOverwrites = overwritesFor(planned.spec.access === 'readonly' ? 'public' : planned.spec.access, access);
  const existing = planned.existing;

  if (!existing) {
    const created = await attempt(report, planned.name, () =>
      guild.channels.create({
        name: planned.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites,
        reason: options.reason,
      }),
    );
    if (created) report.created += 1;
    return created?.id;
  }

  if (options.existing === 'sync') {
    const edited = await attempt(report, planned.name, () =>
      existing.edit({
        ...(existing.name === planned.name ? {} : { name: planned.name }),
        permissionOverwrites,
        reason: options.reason,
      }),
    );
    if (edited) report.updated += 1;
  } else {
    report.kept += 1;
  }
  return existing.id;
}

function forumTags(spec: ChannelSpec, style: KitStyle): GuildForumTagData[] {
  const t = translatorFor(style.locale);
  return (spec.tags ?? []).map((tag) => ({
    name: t(`serverkit.tags.${tag.key}`),
    emoji: { id: null, name: tag.emoji },
    moderated: tag.moderated ?? false,
  }));
}

function resolveType(spec: ChannelSpec, community: boolean): ChannelType.GuildText | ChannelType.GuildAnnouncement | ChannelType.GuildForum | ChannelType.GuildVoice | ChannelType.GuildStageVoice {
  switch (spec.kind) {
    case 'announcement':
      return community ? ChannelType.GuildAnnouncement : ChannelType.GuildText;
    case 'stage':
      return community ? ChannelType.GuildStageVoice : ChannelType.GuildVoice;
    case 'forum':
      return ChannelType.GuildForum;
    case 'voice':
      return ChannelType.GuildVoice;
    case 'text':
      return ChannelType.GuildText;
  }
}

async function ensureChannel(
  guild: Guild,
  planned: PlannedChannel,
  position: number,
  parent: string | undefined,
  options: BuildOptions,
  report: KitReport,
  access: AccessContext,
): Promise<string | undefined> {
  const { spec } = planned;
  const t = translatorFor(options.style.locale);
  const community = guild.features.includes(GuildFeature.Community);
  const permissionOverwrites = overwritesFor(spec.access, access);
  const topic = isVoiceKind(spec) ? undefined : t(`serverkit.channels.${spec.key}.topic`);
  const existing = planned.existing;

  if (existing) {
    if (options.existing !== 'sync') {
      report.kept += 1;
      return existing.id;
    }
    // Un forum déjà en service garde ses étiquettes : les remplacer détacherait
    // celles que portent les fils existants. On n'ajoute que les manquantes.
    const tags =
      existing.type === ChannelType.GuildForum
        ? [
            ...existing.availableTags,
            ...forumTags(spec, options.style).filter(
              (tag) => !existing.availableTags.some((known) => slugify(known.name) === slugify(tag.name)),
            ),
          ]
        : undefined;
    const promote =
      spec.kind === 'announcement' && community && existing.type === ChannelType.GuildText;
    const edited = await attempt<NonThreadGuildBasedChannel>(report, planned.name, () =>
      existing.edit({
        ...(existing.name === planned.name ? {} : { name: planned.name }),
        ...(promote ? { type: ChannelType.GuildAnnouncement } : {}),
        ...(tags ? { availableTags: tags } : {}),
        // Catégorie en échec = `parent` indéfini : on laisse le salon où il est
        // plutôt que de le renvoyer à la racine du serveur.
        ...(parent ? { parent } : {}),
        topic,
        rateLimitPerUser: spec.slowmode ?? 0,
        userLimit: spec.userLimit,
        permissionOverwrites,
        reason: options.reason,
      }),
    );
    if (edited) report.updated += 1;
    return existing.id;
  }

  const base = {
    name: planned.name,
    parent,
    position,
    permissionOverwrites,
    reason: options.reason,
  };
  const type = resolveType(spec, community);
  if (type !== resolveType(spec, true)) {
    report.notes.push({ key: 'serverkit.note.community_fallback', params: { name: planned.name } });
  }

  let created: NonThreadGuildBasedChannel | undefined;
  if (type === ChannelType.GuildForum) {
    // Tenté sans `attempt` : un refus n'est pas un échec, c'est le signal du repli.
    created = await guild.channels
      .create({
        ...base,
        type,
        topic,
        rateLimitPerUser: spec.slowmode,
        availableTags: forumTags(spec, options.style),
        defaultReactionEmoji: spec.reaction ? { id: null, name: spec.reaction } : undefined,
      })
      .catch((error: unknown) => {
        log.warn({ name: planned.name, reason: toError(error).message }, 'forum refusé, repli sur un salon textuel');
        return undefined;
      });
    if (!created) {
      report.notes.push({ key: 'serverkit.note.forum_fallback', params: { name: planned.name } });
    }
  }
  if (!created) {
    const fallback = type === ChannelType.GuildForum ? ChannelType.GuildText : type;
    created = await attempt(report, planned.name, () =>
      guild.channels.create({
        ...base,
        type: fallback,
        topic,
        rateLimitPerUser: spec.slowmode,
        userLimit: spec.userLimit,
      }),
    );
  }
  if (created) report.created += 1;
  return created?.id;
}

async function enableCommunity(
  guild: Guild,
  options: BuildOptions,
  report: KitReport,
  channelIds: Map<string, string>,
): Promise<void> {
  if (guild.features.includes(GuildFeature.Community)) return;

  const spec = (wire: string): ChannelSpec | undefined =>
    CATEGORIES.flatMap((category) => category.channels).find((channel) => channel.wire === wire);
  const rulesChannel = channelIds.get(spec('rules')?.key ?? '');
  const publicUpdatesChannel = channelIds.get(spec('updates')?.key ?? '');
  if (!rulesChannel || !publicUpdatesChannel) {
    report.notes.push({ key: 'serverkit.note.community_failed', params: { reason: 'rules or updates channel missing' } });
    return;
  }

  // Tenté hors `attempt` : un refus se traduit par une note lisible (« active
  // la Communauté à la main ») plutôt que par un message d'erreur brut.
  let refusal = '';
  const enabled = await guild
    .edit({
      features: [...guild.features, GuildFeature.Community],
      rulesChannel,
      publicUpdatesChannel,
      // Exigences de Discord pour un serveur communautaire.
      verificationLevel: Math.max(guild.verificationLevel, GuildVerificationLevel.Low),
      explicitContentFilter: GuildExplicitContentFilter.AllMembers,
      defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
      preferredLocale: options.style.locale === 'fr' ? Locale.French : Locale.EnglishUS,
      reason: options.reason,
    })
    .catch((error: unknown) => {
      refusal = toError(error).message;
      log.warn({ guildId: guild.id, reason: refusal }, 'activation du mode Communauté refusée');
      return undefined;
    });
  report.notes.push(
    enabled
      ? { key: 'serverkit.note.community_enabled' }
      : { key: 'serverkit.note.community_failed', params: { reason: refusal.slice(0, 160) } },
  );
}

async function applySettings(
  guild: Guild,
  options: BuildOptions,
  report: KitReport,
  channelIds: Map<string, string>,
): Promise<void> {
  const wired = (wire: string): string | undefined => {
    const spec = CATEGORIES.flatMap((category) => category.channels).find((channel) => channel.wire === wire);
    return spec ? channelIds.get(spec.key) : undefined;
  };

  const everyone = await attempt(report, '@everyone', () =>
    guild.roles.everyone.setPermissions(EVERYONE_PERMISSIONS, options.reason),
  );
  const edited = await attempt(report, guild.name, () =>
    guild.edit({
      systemChannel: wired('system') ?? guild.systemChannelId,
      afkChannel: wired('afk') ?? guild.afkChannelId,
      afkTimeout: 300,
      defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
      reason: options.reason,
    }),
  );
  if (everyone) report.updated += 1;
  if (edited) report.updated += 1;
}

// ---------------------------------------------------------------------------
// Nettoyage
// ---------------------------------------------------------------------------

export interface WipeOptions {
  style: KitStyle;
  /**
   * Salon épargné — celui d'où part la commande : le supprimer couperait le
   * fil de réponse, et le propriétaire ne verrait jamais le rapport.
   */
  keepChannelId?: string;
  reason: string;
}

/** Ce que `wipeKit` supprimerait. Sert aussi à chiffrer l'écran de confirmation. */
export async function wipeTargets(
  guild: Guild,
  scope: WipeScope,
  options: Pick<WipeOptions, 'style' | 'keepChannelId'>,
): Promise<{ channels: NonThreadGuildBasedChannel[]; roles: Role[] }> {
  let channels: NonThreadGuildBasedChannel[];
  let roles: Role[];

  if (scope === 'all') {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    channels = [...guild.channels.cache.values()].filter(
      (channel): channel is NonThreadGuildBasedChannel => !channel.isThread(),
    );
    roles = [...guild.roles.cache.values()].filter(
      (role) => !role.managed && role.id !== guild.id && role.position < me.roles.highest.position,
    );
  } else {
    const plan = planKit(guild, options.style);
    channels = [
      ...plan.categories.flatMap((category) => category.channels.flatMap((planned) => planned.existing ?? [])),
      ...plan.categories.flatMap((category) => category.existing ?? []),
    ];
    roles = plan.roles.flatMap((planned) => planned.existing ?? []);
  }

  // Les salons avant leurs catégories : l'inverse les laisserait orphelins
  // le temps du chantier, et visibles de tous si la catégorie les cachait.
  channels = channels
    .filter((channel) => channel.id !== options.keepChannelId)
    .sort((a, b) => Number(a.type === ChannelType.GuildCategory) - Number(b.type === ChannelType.GuildCategory));
  return { channels, roles };
}

/** Supprime ce que le kit a posé (`kit`), ou TOUT le serveur (`all`). */
export async function wipeKit(
  guild: Guild,
  scope: WipeScope,
  options: WipeOptions,
  onProgress: ProgressListener = () => undefined,
): Promise<KitReport> {
  const started = Date.now();
  const report = emptyReport();
  running.add(guild.id);

  try {
    const { channels, roles } = await wipeTargets(guild, scope, options);
    const total = channels.length + roles.length;
    let done = 0;
    for (const target of [...channels, ...roles]) {
      if (await attempt<unknown>(report, target.name, () => target.delete(options.reason))) report.removed += 1;
      done += 1;
      onProgress({ phase: 'wipe', done, total });
    }
  } finally {
    running.delete(guild.id);
    report.durationMs = Date.now() - started;
  }

  log.warn({ guildId: guild.id, scope, removed: report.removed, failed: report.failed.length }, 'kit serveur nettoyé');
  return report;
}
