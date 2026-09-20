import { PermissionFlagsBits } from 'discord.js';

/**
 * Plan du serveur communautaire « Greenvale » posé par `/serverkit`.
 *
 * Ce fichier ne contient QUE de la structure : clés stables, emoji, couleurs,
 * droits. Aucun libellé — noms, sujets de salon et panneaux vivent dans
 * `i18n/locales/<langue>/serverkit.json`, sous la clé de chaque entrée :
 * le même plan se pose en français ou en anglais, et le garde-fou
 * `i18n-source` reste valable ici comme ailleurs.
 *
 * Les couleurs reprennent la palette de `render/brand.ts` et `framework/ui.ts`
 * (vert colline, or du grain, bleu ciel) : la liste des membres doit avoir
 * l'air de sortir du même pot de peinture que les images du bot.
 *
 * L'ORDRE des tableaux est l'ordre d'affichage dans Discord, de haut en bas.
 */

// ---------------------------------------------------------------------------
// Rôles
// ---------------------------------------------------------------------------

export type RoleGroup = 'separator' | 'staff' | 'bots' | 'badge' | 'rank' | 'notify' | 'language';

/** Qui voit les salons d'équipe : `senior` voit aussi le journal de modération. */
export type StaffTier = 'senior' | 'junior';

export interface RoleSpec {
  key: string;
  /** Vide pour un séparateur : son décor vient du cadre, pas d'un emoji. */
  emoji: string;
  group: RoleGroup;
  color: number;
  /** Affiché à part dans la liste des membres. */
  hoist?: boolean;
  permissions: bigint[];
  staffTier?: StaffTier;
  /** Proposé en libre-service par le panneau du salon des rôles. */
  selfAssignable?: boolean;
}

const P = PermissionFlagsBits;

const MODERATION = [
  P.KickMembers,
  P.BanMembers,
  P.ModerateMembers,
  P.ManageMessages,
  P.ManageThreads,
  P.ManageNicknames,
  P.ViewAuditLog,
  P.MuteMembers,
  P.DeafenMembers,
  P.MoveMembers,
  P.MentionEveryone,
];

export const ROLES: RoleSpec[] = [
  { key: 'sep_staff', emoji: '', group: 'separator', color: 0x2b2d31, permissions: [] },
  {
    key: 'founder',
    emoji: '👑',
    group: 'staff',
    color: 0xffc93c,
    hoist: true,
    permissions: [P.Administrator],
    staffTier: 'senior',
  },
  {
    key: 'admin',
    emoji: '🛡️',
    group: 'staff',
    color: 0xd9534f,
    hoist: true,
    permissions: [
      ...MODERATION,
      P.ManageGuild,
      P.ManageChannels,
      P.ManageRoles,
      P.ManageWebhooks,
      P.ManageEvents,
      P.ManageGuildExpressions,
    ],
    staffTier: 'senior',
  },
  {
    key: 'moderator',
    emoji: '⚔️',
    group: 'staff',
    color: 0x5bc0de,
    hoist: true,
    permissions: MODERATION,
    staffTier: 'senior',
  },
  {
    key: 'support',
    emoji: '🧰',
    group: 'staff',
    color: 0x8e7cff,
    hoist: true,
    permissions: [P.ModerateMembers, P.ManageThreads, P.ManageNicknames],
    staffTier: 'junior',
  },
  { key: 'bots', emoji: '🤖', group: 'bots', color: 0x9fb0c4, hoist: true, permissions: [] },

  { key: 'sep_badges', emoji: '', group: 'separator', color: 0x2b2d31, permissions: [] },
  { key: 'patron', emoji: '💎', group: 'badge', color: 0x9ad9f2, hoist: true, permissions: [] },
  { key: 'artisan', emoji: '🎨', group: 'badge', color: 0xf0b429, permissions: [] },
  { key: 'bughunter', emoji: '🐞', group: 'badge', color: 0x68b043, permissions: [] },

  { key: 'sep_ranks', emoji: '', group: 'separator', color: 0x2b2d31, permissions: [] },
  { key: 'legend', emoji: '🏆', group: 'rank', color: 0xffd96b, permissions: [] },
  { key: 'grandfarmer', emoji: '🚜', group: 'rank', color: 0xc98b1e, permissions: [] },
  { key: 'grower', emoji: '🌻', group: 'rank', color: 0x7ec850, permissions: [] },
  { key: 'sprout', emoji: '🌱', group: 'rank', color: 0xd8f2c9, permissions: [] },

  { key: 'sep_notify', emoji: '', group: 'separator', color: 0x2b2d31, permissions: [] },
  { key: 'notify_news', emoji: '📣', group: 'notify', color: 0, permissions: [], selfAssignable: true },
  { key: 'notify_updates', emoji: '🛠️', group: 'notify', color: 0, permissions: [], selfAssignable: true },
  { key: 'notify_events', emoji: '🎉', group: 'notify', color: 0, permissions: [], selfAssignable: true },
  { key: 'notify_giveaways', emoji: '🎁', group: 'notify', color: 0, permissions: [], selfAssignable: true },
  { key: 'notify_polls', emoji: '📊', group: 'notify', color: 0, permissions: [], selfAssignable: true },
  { key: 'lang_fr', emoji: '🇫🇷', group: 'language', color: 0, permissions: [], selfAssignable: true },
  { key: 'lang_en', emoji: '🇬🇧', group: 'language', color: 0, permissions: [], selfAssignable: true },
];

/**
 * Droits de base de @everyone. Un serveur neuf laisse `MentionEveryone` à tout
 * le monde : c'est la première chose qu'un raid exploite. La liste est donc
 * posée en entier (et non « retirée de l'existant »), pour un résultat
 * identique quel que soit l'état de départ.
 */
export const EVERYONE_PERMISSIONS: bigint[] = [
  P.ViewChannel,
  P.SendMessages,
  P.SendMessagesInThreads,
  P.CreatePublicThreads,
  P.EmbedLinks,
  P.AttachFiles,
  P.AddReactions,
  P.UseExternalEmojis,
  P.UseExternalStickers,
  P.ReadMessageHistory,
  P.UseApplicationCommands,
  P.ChangeNickname,
  P.CreateInstantInvite,
  P.Connect,
  P.Speak,
  P.Stream,
  P.UseVAD,
  P.UseSoundboard,
  P.UseEmbeddedActivities,
  P.RequestToSpeak,
  P.SendVoiceMessages,
  P.SendPolls,
];

// ---------------------------------------------------------------------------
// Catégories et salons
// ---------------------------------------------------------------------------

/**
 * Profil d'accès, traduit en surcharges de permissions par le constructeur :
 *  - `public`    tout le monde lit et écrit ;
 *  - `readonly`  tout le monde lit, seule l'équipe écrit (réactions permises) ;
 *  - `staff`     invisible hors équipe ;
 *  - `senior`    invisible hors fondateur, administrateurs et modérateurs ;
 *  - `afk`       vocal où personne ne parle.
 */
export type AccessProfile = 'public' | 'readonly' | 'staff' | 'senior' | 'afk';

/**
 * Nature voulue. `announcement` et `stage` exigent un serveur « Communauté » :
 * sans lui, le constructeur se replie sur `text` et `voice` plutôt que
 * d'échouer. `forum` est tenté, puis replié sur `text` si Discord le refuse.
 */
export type ChannelKind = 'text' | 'announcement' | 'forum' | 'voice' | 'stage';

export type PanelKey = 'welcome' | 'rules' | 'roles' | 'guide' | 'faq' | 'staff';

/** Branchement sur un réglage du serveur (salon système, règlement, AFK…). */
export type Wire = 'system' | 'rules' | 'updates' | 'afk';

export interface TagSpec {
  key: string;
  emoji: string;
  /** Réservée à l'équipe (« Résolu », « Confirmé »…). */
  moderated?: boolean;
}

export interface ChannelSpec {
  key: string;
  emoji: string;
  kind: ChannelKind;
  access: AccessProfile;
  /** Mode lent, en secondes. */
  slowmode?: number;
  userLimit?: number;
  panel?: PanelKey;
  wire?: Wire;
  tags?: TagSpec[];
  /** Emoji de réaction par défaut d'un forum. */
  reaction?: string;
}

export interface CategorySpec {
  key: string;
  emoji: string;
  access: AccessProfile;
  channels: ChannelSpec[];
}

export const CATEGORIES: CategorySpec[] = [
  {
    key: 'welcome',
    emoji: '🌾',
    access: 'readonly',
    channels: [
      { key: 'welcome', emoji: '👋', kind: 'text', access: 'readonly', panel: 'welcome', wire: 'system' },
      { key: 'rules', emoji: '📜', kind: 'text', access: 'readonly', panel: 'rules', wire: 'rules' },
      { key: 'news', emoji: '📣', kind: 'announcement', access: 'readonly' },
      { key: 'updates', emoji: '🛠️', kind: 'announcement', access: 'readonly' },
      { key: 'roles', emoji: '🎭', kind: 'text', access: 'readonly', panel: 'roles' },
      { key: 'guide', emoji: '🧭', kind: 'text', access: 'readonly', panel: 'guide' },
      { key: 'faq', emoji: '❓', kind: 'text', access: 'readonly', panel: 'faq' },
    ],
  },
  {
    key: 'square',
    emoji: '🏡',
    access: 'public',
    channels: [
      { key: 'general', emoji: '💬', kind: 'text', access: 'public' },
      { key: 'intros', emoji: '🙋', kind: 'text', access: 'public', slowmode: 60 },
      { key: 'international', emoji: '🌍', kind: 'text', access: 'public' },
      { key: 'showcase', emoji: '📸', kind: 'text', access: 'public', slowmode: 10 },
      { key: 'creations', emoji: '🎨', kind: 'text', access: 'public', slowmode: 10 },
      { key: 'offtopic', emoji: '🎲', kind: 'text', access: 'public' },
    ],
  },
  {
    key: 'farm',
    emoji: '🚜',
    access: 'public',
    channels: [
      { key: 'fields', emoji: '🌱', kind: 'text', access: 'public' },
      { key: 'barn', emoji: '🐄', kind: 'text', access: 'public' },
      { key: 'pond', emoji: '🎣', kind: 'text', access: 'public' },
      { key: 'mine', emoji: '⛏️', kind: 'text', access: 'public' },
      { key: 'market', emoji: '🪙', kind: 'text', access: 'public' },
      { key: 'coops', emoji: '🤝', kind: 'text', access: 'public', slowmode: 30 },
      { key: 'leaderboards', emoji: '🏆', kind: 'text', access: 'public' },
      { key: 'reminders', emoji: '🔔', kind: 'text', access: 'readonly' },
    ],
  },
  {
    key: 'festival',
    emoji: '🎉',
    access: 'public',
    channels: [
      { key: 'events', emoji: '🎪', kind: 'announcement', access: 'readonly' },
      { key: 'giveaways', emoji: '🎁', kind: 'text', access: 'readonly' },
      { key: 'polls', emoji: '📊', kind: 'text', access: 'readonly' },
      { key: 'contests', emoji: '🏅', kind: 'text', access: 'public', slowmode: 30 },
    ],
  },
  {
    key: 'workshop',
    emoji: '🧰',
    access: 'public',
    channels: [
      {
        key: 'help',
        emoji: '🆘',
        kind: 'forum',
        access: 'public',
        reaction: '👍',
        tags: [
          { key: 'question', emoji: '❔' },
          { key: 'gameplay', emoji: '🌾' },
          { key: 'account', emoji: '👤' },
          { key: 'solved', emoji: '✅', moderated: true },
        ],
      },
      {
        key: 'bugs',
        emoji: '🐞',
        kind: 'forum',
        access: 'public',
        reaction: '🐛',
        tags: [
          { key: 'fresh', emoji: '🆕' },
          { key: 'confirmed', emoji: '🔎', moderated: true },
          { key: 'fixed', emoji: '✅', moderated: true },
          { key: 'duplicate', emoji: '♻️', moderated: true },
        ],
      },
      {
        key: 'suggestions',
        emoji: '💡',
        kind: 'forum',
        access: 'public',
        reaction: '⬆️',
        tags: [
          { key: 'gameplay', emoji: '🌾' },
          { key: 'economy', emoji: '🪙' },
          { key: 'interface', emoji: '🖼️' },
          { key: 'accepted', emoji: '✅', moderated: true },
          { key: 'declined', emoji: '⛔', moderated: true },
        ],
      },
      { key: 'translations', emoji: '🌐', kind: 'text', access: 'public' },
      { key: 'status', emoji: '📡', kind: 'text', access: 'readonly' },
    ],
  },
  {
    key: 'hayloft',
    emoji: '🔊',
    access: 'public',
    channels: [
      { key: 'v_campfire', emoji: '🔥', kind: 'voice', access: 'public' },
      { key: 'v_evening', emoji: '🌙', kind: 'voice', access: 'public' },
      { key: 'v_games', emoji: '🎮', kind: 'voice', access: 'public', userLimit: 8 },
      { key: 'v_music', emoji: '🎵', kind: 'voice', access: 'public' },
      { key: 'v_stage', emoji: '🎤', kind: 'stage', access: 'public' },
      { key: 'v_nap', emoji: '💤', kind: 'voice', access: 'afk', wire: 'afk' },
    ],
  },
  {
    key: 'council',
    emoji: '🛡️',
    access: 'staff',
    channels: [
      { key: 'staff_chat', emoji: '🗝️', kind: 'text', access: 'staff', panel: 'staff' },
      { key: 'staff_moderation', emoji: '📋', kind: 'text', access: 'staff' },
      { key: 'staff_reports', emoji: '🚨', kind: 'text', access: 'staff' },
      { key: 'staff_logs', emoji: '🧾', kind: 'text', access: 'senior' },
      { key: 'staff_discord', emoji: '📥', kind: 'text', access: 'staff', wire: 'updates' },
      { key: 'staff_tests', emoji: '🧪', kind: 'text', access: 'staff' },
      { key: 'v_council', emoji: '🔒', kind: 'voice', access: 'staff' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Panneaux
// ---------------------------------------------------------------------------

export interface PanelSpec {
  key: PanelKey;
  color: number;
  /** Champs d'embed : `serverkit.panels.<key>.fields.<champ>.{name,value}`. */
  fields: string[];
}

export const PANELS: Record<PanelKey, PanelSpec> = {
  welcome: { key: 'welcome', color: 0x7ec850, fields: ['start', 'where', 'values'] },
  rules: { key: 'rules', color: 0xffc93c, fields: ['respect', 'content', 'fairplay', 'staff'] },
  roles: { key: 'roles', color: 0x8e7cff, fields: ['notify', 'language', 'ranks'] },
  guide: { key: 'guide', color: 0x5bc0de, fields: ['first', 'daily', 'economy', 'together', 'more'] },
  faq: { key: 'faq', color: 0xf0b429, fields: ['free', 'reset', 'reminders', 'bug', 'idea'] },
  staff: { key: 'staff', color: 0xd9534f, fields: ['channels', 'ladder', 'tools'] },
};

export function allChannels(): Array<{ category: CategorySpec; channel: ChannelSpec }> {
  return CATEGORIES.flatMap((category) =>
    category.channels.map((channel) => ({ category, channel })),
  );
}

export function selfAssignableRoles(): RoleSpec[] {
  return ROLES.filter((role) => role.selfAssignable);
}
