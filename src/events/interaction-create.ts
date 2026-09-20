import {
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { balance as getBalance, getConfig } from '../config';
import { env } from '../config/env';
import { normalizeLocale, translatorFor } from '../i18n';
import { checkAndSet, checkGlobalRate, clear as clearCooldown, cooldownSecondsFor } from '../framework/cooldown';
import {
  buildContext,
  cooldownMessage,
  noAccountEmbed,
  replyEphemeral,
  replyError,
} from '../framework/interaction';
import { findHandler, getCommand, getContextMenu } from '../framework/registry';
import { warningEmbed } from '../framework/ui';
import * as playerRepo from '../repositories/player.repo';
import { assertOwner, parseCustomId } from '../utils/custom-id';
import { isGameError } from '../utils/errors';
import { withUserLock } from '../utils/lock';
import { moduleLogger } from '../utils/logger';
import { recordCommand, recordInteraction, recordLateInteraction } from '../http/health';
import {
  OTHER_LABEL,
  boundedLabel,
  observeCommandDuration,
  observeComponentDuration,
  recordError,
} from '../http/metrics';
import { LATE_INTERACTION_MS, observeInteraction } from '../utils/discord-clock';
import { reportIncident } from './error-reporter';
import type { CommandContext } from '../types';

const log = moduleLogger('interactions');

/**
 * Point d'entrée unique de toutes les interactions Discord.
 *
 * Pipeline, dans cet ordre — l'ordre compte :
 *   1. Limitation de débit (avant tout accès base : c'est le bouclier).
 *   2. Résolution du gestionnaire (commande, bouton, menu, modal).
 *   3. Vérification du propriétaire du composant (anti-clic sur le message d'autrui).
 *   4. Construction du contexte joueur (création éventuelle du compte).
 *   5. Cooldown de commande.
 *   6. Verrou anti-double-clic pour les actions mutantes.
 *   7. Exécution, puis gestion centralisée des erreurs.
 */
export function registerInteractionHandler(client: Client): void {
  client.on('interactionCreate', (interaction: Interaction) => {
    void handleInteraction(interaction).catch((error: unknown) => {
      log.error({ err: error }, 'échec du traitement de l\'interaction');
    });
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  // Mesuré avant tout le reste : c'est le retard pris AVANT notre code, celui
  // qu'aucune optimisation du pipeline ne rattrape.
  const { lagMs } = observeInteraction(interaction.createdTimestamp);
  if (lagMs > LATE_INTERACTION_MS) {
    recordLateInteraction();
    log.warn(
      {
        lagMs: Math.round(lagMs),
        type: interaction.type,
        command: interaction.isCommand() ? interaction.commandName : undefined,
        wsPingMs: interaction.client.ws.ping,
      },
      'interaction reçue en retard de la passerelle : Discord l\'aura probablement déjà abandonnée',
    );
  }

  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  // `recordInteraction` et `recordCommand` étaient exportés sans aucun appelant :
  // les trois compteurs Prometheus correspondants restaient à zéro.
  recordInteraction();

  // --- 1. Limitation de débit -------------------------------------------
  const rate = await checkGlobalRate(interaction.user.id);
  if (rate.limited && interaction.isRepliable()) {
    const t = translatorFor(normalizeLocale(interaction.locale));
    await replyEphemeral(interaction, {
      embeds: [
        warningEmbed(
          t('common.rate_limited_title'),
          t('common.rate_limited', { seconds: Math.ceil(rate.resetInMs / 1000) }),
        ),
      ],
    });
    return;
  }

  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
  } else if (interaction.isButton()) {
    await handleComponent(interaction, 'button');
  } else if (interaction.isStringSelectMenu()) {
    await handleComponent(interaction, 'select');
  } else if (interaction.isModalSubmit()) {
    await handleComponent(interaction, 'modal');
  } else if (interaction.isUserContextMenuCommand() || interaction.isMessageContextMenuCommand()) {
    await handleContextMenu(interaction);
  }
}

// ---------------------------------------------------------------------------
// Commandes slash
// ---------------------------------------------------------------------------

async function handleCommand(
  interaction: import('discord.js').ChatInputCommandInteraction,
): Promise<void> {
  const command = getCommand(interaction.commandName);
  if (!command) {
    const t = translatorFor(normalizeLocale(interaction.locale));
    await replyEphemeral(interaction, {
      embeds: [warningEmbed(t('common.unknown_command_title'), t('common.unknown_command_body'))],
    });
    return;
  }

  const started = performance.now();
  let context: CommandContext | null = null;

  try {
    if (!interaction.inGuild() && command.dmAllowed === false) {
      const t = translatorFor(normalizeLocale(interaction.locale));
      await replyEphemeral(interaction, {
        embeds: [warningEmbed(t('common.guild_only_title'), t('common.guild_only_body'))],
      });
      return;
    }

    // Déféré AVANT `buildContext` quand la commande le demande : c'est le seul
    // moyen de tenir dans les 3 secondes de Discord quand la construction du
    // contexte fait un vrai travail (création de compte pour `/start`).
    if (command.deferBeforeContext) {
      await interaction.deferReply(
        command.deferBeforeContext === 'ephemeral' ? { flags: MessageFlags.Ephemeral } : {},
      );
    }

    context = await buildContext(interaction, {
      createIfMissing: interaction.commandName === 'start',
      requiresAccount: command.requiresAccount,
      referralCode: interaction.options.getString('code') ?? undefined,
    });

    if (!context) {
      await replyEphemeral(interaction, { embeds: [noAccountEmbed(interaction.locale)] });
      return;
    }

    if (command.adminOnly && !context.player.isAdmin) {
      await replyEphemeral(interaction, {
        embeds: [warningEmbed(context.t('common.admin_only_title'), context.t('common.admin_only_body'))],
      });
      return;
    }

    // --- 5. Cooldown ------------------------------------------------------
    //
    // La table `balance.cooldowns` PRIME sur la valeur codée dans la commande.
    // L'ordre inverse la rendait entièrement morte — les 66 commandes déclarent
    // toutes une durée — et un game designer qui réglait `prestige` à 24 h dans
    // le JSON obtenait silencieusement les 30 s du code.
    const bucket = command.cooldown?.bucket ?? interaction.commandName;
    const seconds = cooldownSecondsFor(bucket, command.cooldown?.seconds);
    if (seconds > 0) {
      const cooldown = await checkAndSet(context.player.id, bucket, seconds);
      if (cooldown.active) {
        await replyEphemeral(interaction, {
          embeds: [
            warningEmbed(
              context.t('common.cooldown_title'),
              cooldownMessage(cooldown.retryAt, context.locale),
            ),
          ],
        });
        return;
      }
    }

    // --- 6/7. Exécution sous verrou --------------------------------------
    await withUserLock(context.player.id, `cmd:${interaction.commandName}`, async () => {
      await command.execute(interaction, context!);
    });

    recordCommand(true);
    log.debug(
      {
        command: interaction.commandName,
        userId: context.player.discordId,
        ms: Math.round(performance.now() - started),
      },
      'commande exécutée',
    );
  } catch (error) {
    // Une `GameError` est une erreur ATTENDUE (pas assez de graines, aucune
    // parcelle libre) : l'action n'a rien fait, le cooldown posé avant
    // l'exécution n'a donc pas lieu d'être conservé. Sans cette libération, une
    // simple faute de frappe sur `/prestige` enfermait le joueur 24 h.
    if (context && isGameError(error)) {
      const bucket = command.cooldown?.bucket ?? interaction.commandName;
      await clearCooldown(context.player.id, bucket);
    }

    recordCommand(false);

    const report = await replyError(interaction, error, context ?? undefined);
    // `report.code` est le code documenté dans `utils/errors.ts` comme destiné
    // à `errors_total{code=…}` — métrique qui n'existait pas jusqu'ici.
    recordError('command', report.code);
    if (report.report) {
      await reportIncident(interaction.client, error, {
        command: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
    }
  } finally {
    // Mesurée quel que soit le dénouement — succès, refus, erreur, cooldown :
    // c'est la durée jusqu'à la réponse qui compte, et c'est elle qui aurait
    // montré le budget de 3 s de Discord dépassé avant qu'un joueur ne lise
    // « L'application ne répond pas ». Le nom vient du registre (≤ 70 valeurs) ;
    // `boundedLabel` le garantit même si cette fonction est restructurée.
    observeCommandDuration(
      boundedLabel(interaction.commandName, (name) => getCommand(name) !== undefined),
      (performance.now() - started) / 1_000,
    );
  }
}

// ---------------------------------------------------------------------------
// Composants (boutons, menus, modals)
// ---------------------------------------------------------------------------

async function handleComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  kind: 'button' | 'select' | 'modal',
): Promise<void> {
  const started = performance.now();
  let context: CommandContext | null = null;
  // Le namespace n'est retenu comme étiquette qu'une fois un gestionnaire
  // trouvé : les valeurs possibles sont donc celles des composants enregistrés
  // (≤ 30), et un custom_id forgé ou expiré reste compté sous `other`.
  let namespaceLabel = OTHER_LABEL;

  try {
    const parsed = parseCustomId(interaction.customId);
    const handler = findHandler(kind, parsed.namespace, parsed.action);

    if (!handler) {
      const t = translatorFor(normalizeLocale(interaction.locale));
      await replyEphemeral(interaction, {
        embeds: [warningEmbed(t('common.component_expired_title'), t('common.component_expired_body'))],
      });
      return;
    }
    namespaceLabel = parsed.namespace;

    // --- 3. Propriété du composant ---------------------------------------
    if (handler.checkOwner !== false) {
      assertOwner(parsed, interaction.user.id);
    }

    context = await buildContext(interaction, {
      requiresAccount: handler.requiresAccount,
    });
    if (!context) {
      await replyEphemeral(interaction, { embeds: [noAccountEmbed(interaction.locale)] });
      return;
    }

    if (handler.adminOnly && !context.player.isAdmin) {
      await replyEphemeral(interaction, {
        embeds: [warningEmbed(context.t('common.admin_only_title'), context.t('common.admin_only_body'))],
      });
      return;
    }

    const lockKey = handler.lockKey ?? `${parsed.namespace}:${parsed.action}`;
    await withUserLock(context.player.id, lockKey, async () => {
      // Le cast est nécessaire car un gestionnaire est enregistré pour un type
      // précis d'interaction, garanti par le dossier dont il provient.
      await handler.execute(interaction, parsed, context!);
    });
  } catch (error) {
    const report = await replyError(interaction, error, context ?? undefined);
    recordError('component', report.code);
    if (report.report) {
      await reportIncident(interaction.client, error, {
        command: `component:${interaction.customId}`,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
    }
  } finally {
    observeComponentDuration(namespaceLabel, (performance.now() - started) / 1_000);
  }
}

// ---------------------------------------------------------------------------
// Menus contextuels
// ---------------------------------------------------------------------------

async function handleContextMenu(
  interaction:
    | import('discord.js').UserContextMenuCommandInteraction
    | import('discord.js').MessageContextMenuCommandInteraction,
): Promise<void> {
  const menu = getContextMenu(interaction.commandName);
  if (!menu) return;

  const started = performance.now();
  let context: CommandContext | null = null;
  try {
    context = await buildContext(interaction, {});
    if (!context) {
      await replyEphemeral(interaction, { embeds: [noAccountEmbed(interaction.locale)] });
      return;
    }
    await menu.execute(interaction, context);
  } catch (error) {
    // Un menu contextuel est une commande d'application au sens de Discord :
    // même famille de métriques que les commandes slash, sous son nom de menu.
    const report = await replyError(interaction, error, context ?? undefined);
    recordError('command', report.code);
  } finally {
    observeCommandDuration(
      boundedLabel(interaction.commandName, (name) => getContextMenu(name) !== undefined),
      (performance.now() - started) / 1_000,
    );
  }
}

// ---------------------------------------------------------------------------
// Autocomplétion
// ---------------------------------------------------------------------------

/**
 * L'autocomplétion a un budget de 3 secondes et ne doit JAMAIS créer de compte
 * ni écrire en base. On lui donne un contexte allégé et on répond vide en cas
 * d'erreur : un menu vide est infiniment préférable à une commande cassée.
 */
async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const command = getCommand(interaction.commandName);
  if (!command?.autocomplete) {
    await interaction.respond([]);
    return;
  }

  try {
    const user = await playerRepo.findUserByDiscordId(interaction.user.id);
    // L'autocomplétion propose des noms de contenu : elle doit suivre la même
    // locale que le reste, sinon un joueur anglophone cherche « Wheat » dans
    // une liste restée française.
    const locale = normalizeLocale(user?.locale ?? interaction.locale);
    await command.autocomplete(interaction, {
      playerId: user?.id ?? null,
      discordId: interaction.user.id,
      config: getConfig(locale),
      balance: getBalance(),
      locale,
    });
  } catch (error) {
    log.debug({ err: error, command: interaction.commandName }, 'autocomplétion en échec');
    try {
      await interaction.respond([]);
    } catch {
      /* interaction déjà expirée */
    }
  }
}

export { MessageFlags, env };
