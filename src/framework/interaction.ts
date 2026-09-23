import {
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { balance as getBalance, getConfig } from '../config';
import { env } from '../config/env';
import { translate, translatorFor, normalizeLocale } from '../i18n';
import { assertNotEcoBanned, ensurePlayer } from '../services/player.service';
import { getMaintenance } from '../services/misc.service';
import { MaintenanceError, isGameError, toError } from '../utils/errors';
import { LockBusyError } from '../utils/lock';
import { NotOwnerError, parseCustomId } from '../utils/custom-id';
import { moduleLogger } from '../utils/logger';
import { discordTimestamp, formatDuration } from '../utils/format';
import { COLORS, baseEmbed, button, errorEmbed, row, suggestionRow, warningEmbed } from './ui';
import type { CommandContext, PlayerContext } from '../types';

const log = moduleLogger('interaction');

/**
 * Construction du contexte et gestion centralisée des erreurs.
 *
 * Toute interaction passe par ici. C'est le seul endroit qui sait :
 *  - créer/charger le joueur,
 *  - vérifier maintenance, bannissement économique et limitation de débit,
 *  - transformer une exception en message utilisateur compréhensible,
 *  - décider si l'incident mérite un rapport dans le salon d'erreurs.
 */

export interface BuildContextOptions {
  createIfMissing?: boolean;
  requiresAccount?: boolean;
  referralCode?: string;
}

/**
 * Commandes restant accessibles à un joueur banni de l'économie.
 *
 * Le bannissement doit couper les ACTIONS, pas l'information : quelqu'un de
 * sanctionné doit pouvoir lire pourquoi, consulter son profil et la
 * documentation de jeu. Les composants sont refusés par défaut — ce sont des
 * actions déguisées en boutons — sauf ceux listés dans
 * `ECO_BAN_READONLY_COMPONENTS` juste en dessous.
 */
const ECO_BAN_READONLY = new Set([
  'help',
  'profile',
  'stats',
  'settings',
  'lang',
  'crops',
  'encyclopedia',
  'recipes',
  'item',
  'leaderboard',
  'season',
  'weather',
  'tutorial',
  'achievements',
  // Lecture seule ajoutées avec /history, /almanac et /collection : consulter
  // son propre journal ou sa collection n'est pas un acte économique.
  'history',
  'almanac',
  'collection',
  // RGPD : l'export et l'effacement des données ne peuvent pas dépendre d'une
  // sanction de jeu.
  'account',
]);

/**
 * Composants restant accessibles à un joueur banni de l'économie, au format
 * `namespace:action` (`namespace:*` couvre tout un namespace).
 *
 * Sans cette liste, la garde s'appliquait à TOUS les composants : `commandName`
 * vaut `undefined` dès que l'interaction n'est pas une commande slash, donc la
 * liste blanche ci-dessus était inatteignable depuis un bouton. Conséquences
 * concrètes : la confirmation de `/account delete` — seul chemin d'effacement
 * des données — répondait `errors.player.eco_banned`, le droit à l'effacement
 * se retrouvant suspendu pendant toute la sanction (7 jours pour un ban
 * automatique de `flagSuspicion`, jusqu'à 30 pour un ban manuel) ; et la page 2
 * de `/history`, `/collection` ou `/almanac` était refusée alors que la page 1
 * s'affichait.
 *
 * `almanac:buy` en est volontairement absent : acheter une prévision dépense
 * des pièces, c'est exactement l'action que le bannissement doit couper.
 */
const ECO_BAN_READONLY_COMPONENTS = new Set([
  // RGPD : confirmer ou annuler la suppression de son compte.
  'account:confirm_delete',
  'account:cancel_delete',
  // Vues en lecture seule : pagination, filtres, rafraîchissement.
  'history:*',
  'collection:*',
  'almanac:refresh',
]);

/**
 * L'interaction échappe-t-elle au bannissement économique ?
 *
 * Exporté pour être testable sans base : c'est la seule décision qui sépare
 * « je peux lire » de « je peux agir » pour un joueur sanctionné.
 */
export function isEcoBanExempt(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand()) {
    return ECO_BAN_READONLY.has(interaction.commandName);
  }
  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    let parsed;
    try {
      parsed = parseCustomId(interaction.customId);
    } catch {
      // custom_id forgé ou d'une version antérieure : on refuse, le pipeline
      // répondra « composant expiré » puisqu'aucun gestionnaire ne le résout.
      return false;
    }
    return (
      ECO_BAN_READONLY_COMPONENTS.has(`${parsed.namespace}:${parsed.action}`) ||
      ECO_BAN_READONLY_COMPONENTS.has(`${parsed.namespace}:*`)
    );
  }
  // Menus contextuels et autocomplétion : aucune exemption.
  return false;
}

export async function buildContext(
  interaction: Interaction,
  options: BuildContextOptions = {},
): Promise<CommandContext | null> {
  const maintenance = getMaintenance();
  if (maintenance.enabled && !env.BOT_OWNER_IDS.includes(interaction.user.id)) {
    throw new MaintenanceError(maintenance.message);
  }

  const result = await ensurePlayer({
    discordId: interaction.user.id,
    username: interaction.user.username,
    displayName: interaction.user.displayName ?? undefined,
    avatarHash: interaction.user.avatar ?? undefined,
    discordLocale: interaction.locale,
    discordGuildId: interaction.guildId ?? undefined,
    createIfMissing: options.createIfMissing ?? false,
    referralCode: options.referralCode,
  });

  if (!result) {
    if (options.requiresAccount === false) {
      // Contexte « invité » : suffisant pour /help, /crops, /encyclopedia.
      return guestContext(interaction);
    }
    return null;
  }

  // Bannissement économique. `assertNotEcoBanned` existait mais n'avait aucun
  // appelant : `/admin eco-ban` comme les bannissements automatiques de
  // `flagSuspicion` n'écrivaient qu'une date en base, sans le moindre effet.
  if (!isEcoBanExempt(interaction)) {
    assertNotEcoBanned(result.player);
  }

  const locale = normalizeLocale(result.player.locale);
  return {
    player: result.player,
    config: getConfig(locale),
    balance: getBalance(),
    discordGuildId: interaction.guildId ?? undefined,
    locale,
    t: translatorFor(locale),
    now: new Date(),
  };
}

function guestContext(interaction: Interaction): CommandContext {
  const locale = normalizeLocale(interaction.locale);
  const guest: PlayerContext = {
    id: '00000000-0000-0000-0000-000000000000',
    discordId: interaction.user.id,
    username: interaction.user.username,
    level: 1,
    xp: 0,
    coins: 0,
    gems: 0,
    prestige: 0,
    energy: 0,
    energyMax: 100,
    locale,
    isAdmin: env.BOT_OWNER_IDS.includes(interaction.user.id),
    compactMode: false,
    equippedPetKey: null,
    ecoBannedUntil: null,
    farmId: '',
    coopId: null,
    coopRole: null,
    created: false,
  };
  return {
    player: guest,
    config: getConfig(locale),
    balance: getBalance(),
    discordGuildId: interaction.guildId ?? undefined,
    locale,
    t: translatorFor(locale),
    now: new Date(),
  };
}

/** Le joueur est-il réellement enregistré ? (le contexte invité a un id nul) */
export function isGuest(context: CommandContext): boolean {
  return context.player.farmId === '';
}

// ---------------------------------------------------------------------------
// Réponses
// ---------------------------------------------------------------------------

export async function safeReply(
  interaction: RepliableInteraction,
  payload: InteractionReplyOptions,
): Promise<void> {
  try {
    if (interaction.deferred) {
      await interaction.editReply({
        embeds: payload.embeds,
        components: payload.components,
        files: payload.files,
        content: payload.content ?? undefined,
      });
    } else if (interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    // Interaction expirée (10062) ou déjà acquittée (40060) : rien à faire de
    // plus, on journalise en debug pour ne pas polluer les alertes.
    log.debug({ err: error }, 'réponse impossible (interaction expirée ?)');
  }
}

export async function replyEphemeral(
  interaction: RepliableInteraction,
  payload: InteractionReplyOptions,
): Promise<void> {
  // `ephemeral` distingue les deux formes de différé, et c'est vital ici :
  // seul `deferReply()` le renseigne (`false` public, `true` éphémère) ;
  // `deferUpdate()` de composant le laisse à `null`.
  //
  //  - `deferUpdate()` (null) : `@original` EST le message porteur de la vue.
  //    Le supprimer effacerait /farm, /animals, /almanac… — et le message
  //    d'échange partagé par DEUX joueurs — sur la moindre `GameError`. On passe
  //    donc par un simple `followUp`, la vue reste intacte.
  //  - `deferReply()` public (false) : le « … réfléchit » doit être résorbé,
  //    sinon Discord laisse un placeholder mort dans le salon pendant quinze
  //    minutes ; et `editReply` ignorerait le drapeau éphémère, exposant
  //    l'erreur à tout le salon.
  //  - `deferReply()` éphémère (true) : `safeReply` → `editReply`, déjà privé.
  if (interaction.deferred && interaction.ephemeral === null) {
    await followUpEphemeral(interaction, payload);
    return;
  }
  if (interaction.deferred && interaction.ephemeral === false) {
    try {
      await interaction.deleteReply().catch(() => undefined);
      await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
      return;
    } catch (error) {
      log.debug({ err: error }, 'followUp éphémère impossible (interaction expirée ?)');
      return;
    }
  }
  await safeReply(interaction, { ...payload, flags: MessageFlags.Ephemeral });
}

/**
 * Message complémentaire éphémère, après un `deferUpdate()` de composant.
 *
 * Le message d'origine — la vue avec ses boutons — reste en place et sera mis
 * à jour par `editReply` ; ce helper n'y touche pas. Ce n'est PAS
 * `replyEphemeral` : sur une interaction déférée, celui-ci SUPPRIME la réponse
 * différée avant son followUp, ce qui ferait disparaître la vue elle-même.
 *
 * Comme `safeReply`, une interaction expirée est journalisée en debug plutôt
 * que propagée : le gestionnaire poursuit (la mise à jour de la vue, par
 * exemple) au lieu de tomber pour un message d'accompagnement.
 */
export async function followUpEphemeral(
  interaction: RepliableInteraction,
  payload: InteractionReplyOptions,
): Promise<void> {
  try {
    await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  } catch (error) {
    log.debug({ err: error }, 'followUp éphémère impossible (interaction expirée ?)');
  }
}

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

export interface ErrorReport {
  /** Message affiché au joueur. */
  userMessage: string;
  /** Faut-il remonter l'incident dans le salon d'erreurs ? */
  report: boolean;
  code: string;
}

/**
 * Traducteur de repli quand aucun `CommandContext` n'est encore disponible
 * (échec de propriété d'un composant, verrou pris avant la résolution du
 * joueur…) : on retombe sur la locale Discord de l'interaction plutôt que sur
 * le français fixe, pour qu'un client anglophone ne voie pas du français.
 */
function resolveTranslator(context: CommandContext | undefined, fallbackLocale?: string | null) {
  return context?.t ?? translatorFor(normalizeLocale(fallbackLocale));
}

export function classifyError(
  error: unknown,
  context?: CommandContext,
  fallbackLocale?: string | null,
): ErrorReport {
  const t = resolveTranslator(context, fallbackLocale ?? context?.locale);

  if (error instanceof MaintenanceError) {
    return {
      userMessage: t('common.maintenance', { message: error.message }).trim(),
      report: false,
      code: 'maintenance',
    };
  }
  if (error instanceof NotOwnerError) {
    return {
      userMessage: t('common.not_your_button'),
      report: false,
      code: 'not_owner',
    };
  }
  if (error instanceof LockBusyError) {
    return {
      userMessage: t('common.action_in_progress'),
      report: false,
      code: 'busy',
    };
  }
  if (isGameError(error)) {
    const message = error.i18nKey ? t(error.i18nKey, error.params) : error.message;
    const hintText = error.hintKey ? t(error.hintKey, error.params) : error.hint;
    const hint = hintText ? `\n💡 ${hintText}` : '';
    return { userMessage: `${message}${hint}`, report: false, code: error.code };
  }

  const normalized = toError(error);
  log.error({ err: normalized, userId: context?.player.discordId }, 'erreur non gérée');
  return {
    userMessage: t('common.unknown_error'),
    report: true,
    code: 'internal',
  };
}

/** Répond à une interaction en erreur, avec un éventuel bouton de rattrapage. */
export async function replyError(
  interaction: RepliableInteraction,
  error: unknown,
  context?: CommandContext,
): Promise<ErrorReport> {
  const report = classifyError(error, context, interaction.locale);
  const t = resolveTranslator(context, interaction.locale);
  const embed = isGameError(error)
    ? warningEmbed(t('common.action_failed_title'), report.userMessage)
    : errorEmbed(t('common.internal_error_title'), report.userMessage);

  const components =
    isGameError(error) && error.suggestedCommand
      ? [suggestionRow(error.suggestedCommand, interaction.user.id, undefined, t)].filter(
          (component): component is NonNullable<typeof component> => component !== undefined,
        )
      : [];

  await replyEphemeral(interaction, { embeds: [embed], components });
  return report;
}

/** Embed « vous n'avez pas encore de ferme ». */
export function noAccountEmbed(locale?: string | null) {
  const t = translatorFor(normalizeLocale(locale));
  return baseEmbed({
    title: `🌱 ${t('common.no_account_title')}`,
    description: t('common.no_account'),
    color: COLORS.info,
  });
}

/**
 * Réponse complète « pas encore de ferme » : l'embed et un bouton qui crée la
 * ferme (`start:create`), pour ne pas laisser le joueur chercher `/start`.
 */
export function noAccountReply(interaction: { locale?: string | null; user: { id: string } }) {
  const t = translatorFor(normalizeLocale(interaction.locale));
  return {
    embeds: [noAccountEmbed(interaction.locale)],
    components: [
      row(
        button({
          namespace: 'start',
          action: 'create',
          ownerId: interaction.user.id,
          label: t('onboarding.start_button'),
          emoji: '🌱',
          style: ButtonStyle.Success,
        }),
      ),
    ],
  };
}

/** Message de cooldown lisible. */
export function cooldownMessage(retryAt: Date, locale?: string | null): string {
  const normalized = normalizeLocale(locale);
  return translate(normalized, 'common.cooldown', {
    when: `${discordTimestamp(retryAt, 'R')} (${formatDuration(retryAt.getTime() - Date.now(), normalized)})`,
  });
}

/** Type-guard utilitaire pour les interactions de composant que l'on gère. */
export function isComponentInteraction(
  interaction: Interaction,
): interaction is ButtonInteraction | StringSelectMenuInteraction {
  return interaction.isButton() || interaction.isStringSelectMenu();
}

export function isModal(interaction: Interaction): interaction is ModalSubmitInteraction {
  return interaction.isModalSubmit();
}

export function isChatCommand(interaction: Interaction): interaction is ChatInputCommandInteraction {
  return interaction.isChatInputCommand();
}
