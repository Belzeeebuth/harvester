import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { buildHarvestEmbed, appendTracking } from '../../commands/farm';
import { auctionListView } from '../../commands/trade';
import { helpEmbed, TUTORIAL_STEPS, tutorialParams } from '../../commands/start';
import { sendLeaderboard, helpFarmer } from '../../commands/social';
import { applyLocale, isSupported } from '../../commands/language';
import { COLORS, baseEmbed, button, quantityModal, row, successEmbed, suggestionRow, textModal } from '../../framework/ui';
import {
  animalsView,
  blackMarketView,
  buildingsView,
  coopView,
  farmView,
  inventoryView,
  marketView,
  plotsView,
  productionView,
  questsView,
  shopView,
} from '../../framework/views';
import { followUpEphemeral, replyEphemeral } from '../../framework/interaction';
import { harvestFollowUpRows, sellMenuView } from '../../framework/selling';
import { mergeLevelUps, withLevelUp, type LevelUpInfo } from '../../framework/levelup';
import { recipesView } from '../../commands/craft';
import { profileView, statsView } from '../../commands/profile';
import * as animalService from '../../services/animal.service';
import * as coopService from '../../services/coop.service';
import * as craftService from '../../services/craft.service';
import * as farmService from '../../services/farm.service';
import * as fishingService from '../../services/fishing.service';
import * as inventoryService from '../../services/inventory.service';
import * as miscService from '../../services/misc.service';
import * as progressionService from '../../services/progression.service';
import * as playerRepo from '../../repositories/player.repo';
import { paramInt, paramString } from '../../utils/custom-id';
import { toLocalClock } from '../../utils/discord-clock';
import { formatCoins, formatNumber, qualityIcon } from '../../utils/format';
import type { ButtonHandler, CommandContext } from '../../types';

/**
 * Gestionnaires de boutons.
 *
 * Deux règles systématiques :
 *  - `deferUpdate()` pour les actions qui remplacent le message (navigation,
 *    rafraîchissement) : Discord attend un accusé en 3 s, et l'édition qui suit
 *    peut prendre le temps nécessaire ;
 *  - réponse ÉPHÉMÈRE pour les résultats d'action individuels, afin de ne pas
 *    noyer le salon sous les confirmations.
 */

// ---------------------------------------------------------------------------
// Ferme
// ---------------------------------------------------------------------------

const farmButtons: ButtonHandler = {
  namespace: 'farm',
  actions: ['refresh', 'harvest_all', 'water_all', 'plant_menu', 'plots', 'buy_plot', 'weed_all', 'page', 'noop'],
  lockKey: 'farm-action',

  async execute(interaction: ButtonInteraction, parsed, context: CommandContext): Promise<void> {
    switch (parsed.action) {
      case 'noop':
        await interaction.deferUpdate();
        return;

      case 'refresh': {
        await interaction.deferUpdate();
        await interaction.editReply(
          await farmView(context, {
            targetName: interaction.user.displayName,
            avatarUrl: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
          }),
        );
        return;
      }

      case 'plots':
      case 'page': {
        await interaction.deferUpdate();
        const page = parsed.action === 'page' ? paramInt(parsed, 0, { min: 1, fallback: 1 }) : 1;
        await interaction.editReply(await plotsView(context, page));
        return;
      }

      case 'harvest_all': {
        await interaction.deferUpdate();
        const summary = await farmService.harvest(context.player, { all: true });
        await followUpEphemeral(interaction, {
          embeds: [buildHarvestEmbed(summary, context.t, context.locale)],
          components: harvestFollowUpRows(summary, interaction.user.id, context.t),
        });
        await interaction.editReply(await farmView(context));
        return;
      }

      case 'water_all': {
        await interaction.deferUpdate();
        const result = await farmService.water(context.player, { all: true });
        await followUpEphemeral(interaction, {
          embeds: [
            result.freeRain
              ? baseEmbed({
                  title: context.t('farm.rain_title'),
                  description: context.t('farm.rain_body'),
                  color: COLORS.info,
                })
              : successEmbed(
                  context.t('farm.water_title'),
                  context.t('farm.water_body', { count: result.watered, note: '' }),
                ),
          ],
        });
        await interaction.editReply(await farmView(context));
        return;
      }

      case 'weed_all': {
        await interaction.deferUpdate();
        const result = await farmService.weed(context.player, { all: true });
        await followUpEphemeral(interaction, {
          embeds: [
            successEmbed(
              context.t('farm.weed_title'),
              context.t('farm.weed_all_body', {
                count: result.slots.length,
                collected: result.weedsCollected,
              }),
            ),
          ],
        });
        await interaction.editReply(await plotsView(context, 1));
        return;
      }

      case 'buy_plot': {
        await interaction.deferUpdate();
        const result = await farmService.buyPlot(context.player);
        await followUpEphemeral(interaction, {
          embeds: [
            successEmbed(
              context.t('farm.plot_unlocked_title'),
              context.t('farm.plot_unlocked_body', {
                slot: result.slot,
                cost: formatCoins(result.cost, false, context.locale),
                width: result.grid.width,
                height: result.grid.height,
                nextPart:
                  result.nextCost > 0
                    ? context.t('farm.plot_unlocked_next', {
                        cost: formatCoins(result.nextCost, false, context.locale),
                      })
                    : '',
              }),
            ),
          ],
        });
        await interaction.editReply(await plotsView(context, 1));
        return;
      }

      case 'plant_menu': {
        // Menu de sélection des graines disponibles.
        const seeds = await farmService.plantableCrops(context.player.id, context.player.level, '', context.locale);
        if (seeds.length === 0) {
          await replyEphemeral(interaction, {
            embeds: [
              baseEmbed({
                title: context.t('farm.no_seeds_title'),
                description: context.t('farm.no_seeds_body'),
                color: COLORS.warning,
              }),
            ],
            // Sans graines, la seule suite utile : la boutique, rayon graines.
            components: [suggestionRow('seeds', interaction.user.id, context.locale, context.t)].filter(
              (entry) => entry !== undefined,
            ),
          });
          return;
        }

        const { select, selectRow } = await import('../../framework/ui');
        await replyEphemeral(interaction, {
          embeds: [
            baseEmbed({
              title: context.t('farm.plant_menu_title'),
              description: context.t('farm.plant_menu_body'),
              color: COLORS.primary,
            }),
          ],
          components: [
            selectRow(
              select({
                namespace: 'farm',
                action: 'plant',
                ownerId: interaction.user.id,
                placeholder: context.t('farm.plant_menu_placeholder'),
                choices: seeds.map((entry) => ({
                  label: context.t('farm.plant_menu_choice_label', {
                    name: entry.crop.name,
                    owned: entry.owned,
                  }),
                  value: entry.crop.key,
                  emoji: entry.crop.emoji,
                  description: context.t('farm.plant_menu_choice_desc', {
                    minutes: Math.round(entry.crop.growthSeconds / 60),
                    yield: entry.crop.baseYield,
                    price: entry.crop.sellPrice,
                    coins: context.t('common.coins'),
                  }),
                })),
              }),
            ),
          ],
        });
        return;
      }

      default:
        await interaction.deferUpdate();
    }
  },
};

// ---------------------------------------------------------------------------
// Inventaire, boutique, marché
// ---------------------------------------------------------------------------

const inventoryButtons: ButtonHandler = {
  namespace: 'inv',
  actions: ['open', 'page', 'sell_menu', 'discard', 'noop'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'noop') {
      await interaction.deferUpdate();
      return;
    }

    if (parsed.action === 'discard') {
      const decision = paramString(parsed, 0);
      const itemKey = paramString(parsed, 1);
      const quantity = paramInt(parsed, 2, { min: 1, fallback: 1 });

      if (decision !== 'yes') {
        await interaction.update({
          embeds: [
            baseEmbed({
              title: context.t('economy.discard_cancelled_title'),
              description: context.t('economy.discard_cancelled_body'),
              color: COLORS.neutral,
            }),
          ],
          components: [],
        });
        return;
      }

      const { withTransaction } = await import('../../db/client');
      await withTransaction(async (tx) => {
        await inventoryService.consume(context.player.id, itemKey, quantity, tx, context.locale);
      });
      const item = inventoryService.requireItem(itemKey, context.locale);
      await interaction.update({
        embeds: [
          successEmbed(
            context.t('economy.discard_done_title'),
            context.t('economy.discard_done_body', { quantity, emoji: item.emoji, name: item.name }),
          ),
        ],
        components: [],
      });
      return;
    }

    if (parsed.action === 'sell_menu') {
      // Vente réelle (menu d'objets et « toutes les récoltes ») : ce bouton
      // n'affichait que la syntaxe de `/sell`.
      await replyEphemeral(interaction, await sellMenuView(context));
      return;
    }

    await interaction.deferUpdate();
    const page = parsed.action === 'page' ? paramInt(parsed, 0, { min: 1, fallback: 1 }) : 1;
    const category = paramString(parsed, parsed.action === 'page' ? 1 : 0, 'all');
    await interaction.editReply(
      await inventoryView(context, {
        category: category === 'all' ? undefined : category,
        page,
      }),
    );
  },
};

const shopButtons: ButtonHandler = {
  namespace: 'shop',
  // `seeds` : raccourci vers le rayon graines (suggestion d'erreur « plus de graines »).
  actions: ['open', 'filter', 'seeds'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const category =
      parsed.action === 'filter' ? paramString(parsed, 0, 'all') : parsed.action === 'seeds' ? 'seeds' : 'all';
    await interaction.editReply(await shopView(context, category === 'all' ? undefined : category));
  },
};

const blackMarketButtons: ButtonHandler = {
  namespace: 'blackmarket',
  actions: ['open'],

  async execute(interaction: ButtonInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply(await blackMarketView(context));
  },
};

const fishingButtons: ButtonHandler = {
  namespace: 'fishing',
  actions: ['hook'],
  lockKey: 'fishing-hook',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const castId = paramString(parsed, 0, '');
    // L'instant du clic est celui de Discord (le réseau ne pénalise pas le
    // joueur), ramené sur NOTRE horloge : `biteAt` a été daté par elle, et les
    // deux peuvent diverger de plusieurs minutes sur un hôte sans NTP.
    const result = await fishingService.resolveHook(
      context.player,
      castId,
      toLocalClock(interaction.createdTimestamp),
    );

    let embed;
    if (result.fish) {
      embed = successEmbed(
        context.t('fishing.catch_title'),
        context.t('fishing.catch_body', {
          emoji: result.fish.emoji,
          icon: qualityIcon(result.fish.quality),
          name: result.fish.name,
          value: formatCoins(result.fish.value, false, context.locale),
        }),
      );
    } else if (result.outcome === 'hit') {
      embed = baseEmbed({
        title: context.t('fishing.miss_title'),
        description: context.t('fishing.nothing_body'),
        color: COLORS.info,
      });
    } else if (result.outcome === 'too_early') {
      embed = baseEmbed({
        title: context.t('fishing.miss_title'),
        description: context.t('fishing.too_early_body'),
        color: COLORS.warning,
      });
    } else if (result.outcome === 'too_late') {
      embed = baseEmbed({
        title: context.t('fishing.miss_title'),
        description: context.t('fishing.too_late_body'),
        color: COLORS.warning,
      });
    } else {
      embed = baseEmbed({
        title: context.t('fishing.miss_title'),
        description: context.t('fishing.expired_body'),
        color: COLORS.neutral,
      });
    }

    await interaction.editReply({ embeds: [embed], components: [] });
  },
};

const marketButtons: ButtonHandler = {
  namespace: 'market',
  actions: ['open', 'filter'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const category = parsed.action === 'filter' ? paramString(parsed, 0, 'all') : 'all';
    await interaction.editReply(await marketView(context, category === 'all' ? undefined : category));
  },
};

// ---------------------------------------------------------------------------
// Élevage
// ---------------------------------------------------------------------------

const animalButtons: ButtonHandler = {
  namespace: 'animal',
  actions: ['open', 'page', 'collect_all', 'feed_all', 'pet_menu', 'noop'],
  lockKey: 'animal-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    switch (parsed.action) {
      case 'collect_all': {
        await interaction.deferUpdate();
        const result = await animalService.collect(context.player, { all: true });
        const embed = successEmbed(
          context.t('animals.collect_title'),
          result.lines.map((line) => `${line.emoji} **${line.quantity}× ${line.itemName}**`).join('\n'),
        );
        withLevelUp(embed, result.levelUp, context.t, context.locale);
        appendTracking(embed, result.tracking, context.t);
        await followUpEphemeral(interaction, { embeds: [embed] });
        await interaction.editReply(await animalsView(context));
        return;
      }
      case 'feed_all': {
        await interaction.deferUpdate();
        const result = await animalService.feed(context.player, { all: true });
        await followUpEphemeral(interaction, {
          embeds: [
            successEmbed(
              context.t('animals.feed_title'),
              context.t('animals.feed_all_body', { count: result.fed }),
            ),
          ],
        });
        await interaction.editReply(await animalsView(context));
        return;
      }
      case 'pet_menu': {
        const herd = await animalService.getHerd(context.player, context.now);
        const petable = herd.animals.filter((animal) => animal.canPet);
        if (petable.length === 0) {
          await replyEphemeral(interaction, {
            embeds: [
              baseEmbed({
                title: context.t('animals.no_pet_title'),
                description: context.t('animals.no_pet_body'),
                color: COLORS.info,
              }),
            ],
          });
          return;
        }
        const { select, selectRow } = await import('../../framework/ui');
        await replyEphemeral(interaction, {
          embeds: [baseEmbed({ title: context.t('animals.pet_menu_title'), color: COLORS.primary })],
          components: [
            selectRow(
              select({
                namespace: 'animal',
                action: 'pet',
                ownerId: interaction.user.id,
                placeholder: context.t('animals.pet_menu_placeholder'),
                choices: petable.slice(0, 25).map((animal) => ({
                  label: context.t('animals.pet_menu_choice_label', {
                    name: animal.nickname ?? animal.name,
                    happiness: animal.status.happiness,
                  }),
                  value: animal.id,
                  emoji: animal.emoji,
                })),
              }),
            ),
          ],
        });
        return;
      }
      default: {
        await interaction.deferUpdate();
        const page = parsed.action === 'page' ? paramInt(parsed, 0, { min: 1, fallback: 1 }) : 1;
        await interaction.editReply(await animalsView(context, page));
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Quêtes, succès, passe
// ---------------------------------------------------------------------------

const questButtons: ButtonHandler = {
  namespace: 'quest',
  actions: ['open', 'filter', 'claim_all'],
  lockKey: 'quest-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'claim_all') {
      await interaction.deferUpdate();
      const results = await progressionService.claimAllQuests(context.player);
      const totals = results.reduce(
        (accumulator, result) => ({
          coins: accumulator.coins + result.coins,
          gems: accumulator.gems + result.gems,
          xp: accumulator.xp + result.xp,
        }),
        { coins: 0, gems: 0, xp: 0 },
      );
      await followUpEphemeral(interaction, {
        embeds: [
          withLevelUp(successEmbed(
            context.t('progression.quest_claim_title', { count: results.length }),
            context.t('progression.quest_claim_body', {
              coins: formatCoins(totals.coins, false, context.locale),
              gems: totals.gems,
              xp: formatNumber(totals.xp, context.locale),
              list: results.map((result) => `• ${result.title}`).join('\n'),
            }),
          ), mergeLevelUps(results.map((result) => result.levelUp)), context.t, context.locale),
        ],
      });
      await interaction.editReply(await questsView(context));
      return;
    }

    await interaction.deferUpdate();
    const type = parsed.action === 'filter' ? paramString(parsed, 0) : '';
    await interaction.editReply(
      await questsView(context, (type || undefined) as 'daily' | 'weekly' | undefined),
    );
  },
};

const achievementButtons: ButtonHandler = {
  namespace: 'achv',
  actions: ['claim_all'],

  async execute(interaction: ButtonInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const achievements = await progressionService.listAchievements(context.player.id, undefined, context.locale);
    const claimable = achievements.filter((entry) => entry.unlocked && !entry.claimed);

    let coins = 0;
    let gems = 0;
    const names: string[] = [];
    const levelUps: Array<LevelUpInfo | null> = [];
    for (const achievement of claimable) {
      try {
        const result = await progressionService.claimAchievement(context.player, achievement.key);
        coins += result.coins;
        gems += result.gems;
        names.push(result.name);
        levelUps.push(result.levelUp);
      } catch {
        /* déjà réclamé entre-temps */
      }
    }

    await interaction.editReply({
      embeds: [
        withLevelUp(successEmbed(
          context.t('progression.achv_claim_title', { count: names.length }),
          names.length > 0
            ? context.t('progression.achv_claim_body', {
                coins: formatCoins(coins, false, context.locale),
                gems,
                list: names.map((name) => `• ${name}`).join('\n'),
              })
            : context.t('progression.achv_claim_none'),
        ), mergeLevelUps(levelUps), context.t, context.locale),
      ],
    });
  },
};

const passButtons: ButtonHandler = {
  namespace: 'pass',
  actions: ['claim_all'],

  async execute(interaction: ButtonInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const pass = await progressionService.getSeasonPass(context.player.id);
    if (!pass) {
      await interaction.editReply({ content: context.t('progression.pass_none_content') });
      return;
    }

    let coins = 0;
    let gems = 0;
    let claimed = 0;
    const levelUps: Array<LevelUpInfo | null> = [];
    for (const tier of pass.tiers) {
      if (tier.tier > pass.tier) continue;

      // Voie gratuite, puis voie premium quand le joueur y a droit. La seconde
      // était codée en dur à `false` : même une fois le premium débloqué, la
      // moitié des récompenses restait hors de portée de « tout réclamer ».
      const tracks: boolean[] = pass.premium ? [false, true] : [false];
      for (const premium of tracks) {
        const already = premium ? pass.claimedPremiumTiers : pass.claimedTiers;
        if (already.includes(tier.tier)) continue;
        try {
          const result = await progressionService.claimPassTier(
            context.player,
            tier.tier,
            premium,
          );
          coins += result.coins;
          gems += result.gems;
          claimed += 1;
          levelUps.push(result.levelUp);
        } catch {
          /* palier déjà réclamé, ou voie non débloquée */
        }
      }
    }

    await interaction.editReply({
      embeds: [
        withLevelUp(successEmbed(
          context.t('progression.pass_claim_result_title', { count: claimed }),
          claimed > 0
            ? context.t('progression.pass_claim_result_body', {
                coins: formatCoins(coins, false, context.locale),
                gems,
              })
            : context.t('progression.pass_claim_result_none'),
        ), mergeLevelUps(levelUps), context.t, context.locale),
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// Artisanat et bâtiments
// ---------------------------------------------------------------------------

const craftButtons: ButtonHandler = {
  namespace: 'craft',
  actions: ['queue', 'collect_all', 'recipes'],
  lockKey: 'craft-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'collect_all') {
      await interaction.deferUpdate();
      const result = await craftService.collectProduction(context.player, { all: true });
      const embed = successEmbed(
        context.t('craft.collect_title'),
        result.lines.map((line) => `${line.emoji} **${line.quantity}× ${line.itemName}**`).join('\n'),
      );
      withLevelUp(embed, result.levelUp, context.t, context.locale);
      appendTracking(embed, result.tracking, context.t);
      await followUpEphemeral(interaction, { embeds: [embed] });
      await interaction.editReply(await productionView(context));
      return;
    }

    if (parsed.action === 'recipes') {
      // La vue complète, et non plus un renvoi vers `/recipes`.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await recipesView(context));
      return;
    }

    await interaction.deferUpdate();
    await interaction.editReply(await productionView(context));
  },
};

const buildingButtons: ButtonHandler = {
  namespace: 'build',
  actions: ['open'],

  async execute(interaction: ButtonInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply(await buildingsView(context));
  },
};

// ---------------------------------------------------------------------------
// Coopérative
// ---------------------------------------------------------------------------

const coopButtons: ButtonHandler = {
  namespace: 'coop',
  actions: ['open', 'create', 'contribute', 'members', 'objectives'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'create') {
      // Niveau et fonds vérifiés avant la fenêtre de saisie du nom.
      coopService.assertCanCreateCoop(context.player);
      await interaction.showModal(
        textModal({
          namespace: 'coop',
          action: 'create',
          ownerId: interaction.user.id,
          title: context.t('coop.create_modal_title'),
          fieldId: 'name',
          label: context.t('coop.create_modal_label'),
          placeholder: context.t('coop.create_modal_placeholder'),
          maxLength: 32,
        }),
      );
      return;
    }

    if (parsed.action === 'contribute') {
      await interaction.showModal(
        quantityModal(
          {
            namespace: 'coop',
            action: 'contribute',
            ownerId: interaction.user.id,
            title: context.t('coop.contribute_modal_title'),
            label: context.t('coop.contribute_modal_label'),
            placeholder: context.t('coop.contribute_modal_placeholder'),
          },
          context.locale,
          context.t,
        ),
      );
      return;
    }

    await interaction.deferUpdate();
    await interaction.editReply(await coopView(context));
  },
};

// ---------------------------------------------------------------------------
// Aide, tutoriel, paramètres, prestige, social
// ---------------------------------------------------------------------------

const helpButtons: ButtonHandler = {
  namespace: 'help',
  actions: ['category'],
  checkOwner: false,

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [helpEmbed(paramString(parsed, 0) as never, context.locale, context.t)],
    });
  },
};

const tutorialButtons: ButtonHandler = {
  namespace: 'tuto',
  actions: ['step'],
  requiresAccount: false,

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    const index = paramInt(parsed, 0, { min: 1, max: TUTORIAL_STEPS.length, fallback: 1 });
    const step = TUTORIAL_STEPS[index - 1]!;

    await interaction.update({
      embeds: [
        baseEmbed({
          title: `🎓 ${context.t(step.titleKey)}`,
          description: context.t(step.bodyKey, tutorialParams(context.config)),
          color: COLORS.info,
          footer: context.t('tutorial.footer'),
        }),
      ],
      components: [
        row(
          button({
            namespace: 'tuto',
            action: 'step',
            ownerId: interaction.user.id,
            params: [Math.max(1, index - 1)],
            emoji: '◀️',
            disabled: index <= 1,
          }),
          button({
            namespace: 'tuto',
            action: 'step',
            ownerId: interaction.user.id,
            params: [Math.min(TUTORIAL_STEPS.length, index + 1)],
            label: context.t('tutorial.next_button'),
            emoji: '▶️',
            disabled: index >= TUTORIAL_STEPS.length,
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

const settingsButtons: ButtonHandler = {
  namespace: 'settings',
  actions: ['toggle', 'dm_on'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    // `dm_on` : proposition faite après `/start`. Elle ALLUME les messages
    // privés sans jamais les éteindre, même en cas de double clic.
    const field = parsed.action === 'dm_on' ? 'dmNotifications' : paramString(parsed, 0);
    const allowed = ['notifyCrops', 'notifyAnimals', 'notifyEnergy', 'notifyMarket', 'dailyReminder', 'dmNotifications'];
    if (!allowed.includes(field)) {
      await replyEphemeral(interaction, { content: context.t('settings.unknown_field') });
      return;
    }

    const settings = await playerRepo.getSettings(context.player.id);
    const current = (settings as unknown as Record<string, boolean>)[field] ?? false;
    const next = parsed.action === 'dm_on' ? true : !current;
    await playerRepo.updateSettings(context.player.id, { [field]: next });

    // L'avertissement « activez aussi les messages privés » n'a de sens que pour
    // une alerte qu'on allume alors que les messages privés restent coupés.
    const dmStillOff = field !== 'dmNotifications' && !settings?.dmNotifications && next;
    await replyEphemeral(interaction, {
      embeds: [
        successEmbed(
          context.t('settings.toggle_title'),
          context.t('settings.toggle_body', {
            field: context.t(`onboarding.settings_field.${field}`),
            state: next ? context.t('common.enabled') : context.t('common.disabled'),
          }) + (dmStillOff ? context.t('settings.toggle_dm_warning') : ''),
        ),
      ],
    });
  },
};

const prestigeButtons: ButtonHandler = {
  namespace: 'prestige',
  actions: ['confirm'],
  lockKey: 'prestige',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (paramString(parsed, 0) !== 'yes') {
      await interaction.update({
        embeds: [
          baseEmbed({
            title: context.t('progression.prestige_cancelled_title'),
            description: context.t('progression.prestige_cancelled_body'),
            color: COLORS.neutral,
          }),
        ],
        components: [],
      });
      return;
    }

    await interaction.deferUpdate();
    const result = await miscService.doPrestige(context.player);
    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('progression.prestige_done_title', { prestige: result.newPrestige }),
          [
            context.t('progression.prestige_done_multiplier', {
              multiplier: result.multiplier.toFixed(2),
            }),
            context.t('progression.prestige_done_plots', { count: result.plotsKept }),
            context.t('progression.prestige_done_coins', {
              value: formatCoins(result.coinsKept, false, context.locale),
            }),
            context.t('progression.prestige_done_points', { count: result.pointsGained }),
            '',
            context.t('progression.prestige_done_footer'),
          ].join('\n'),
        ),
      ],
      components: [],
    });
  },
};

const socialButtons: ButtonHandler = {
  namespace: 'social',
  actions: ['help', 'leaderboard'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'help') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const targetDiscordId = paramString(parsed, 0);
      await helpFarmer(interaction, context, targetDiscordId, `<@${targetDiscordId}>`);
      return;
    }

    await interaction.deferUpdate();
    await sendLeaderboard(
      interaction,
      context,
      paramString(parsed, 0, 'wealth') as miscService.LeaderboardType,
      'global',
    );
  },
};

const auctionButtons: ButtonHandler = {
  namespace: 'hdv',
  actions: ['page', 'noop'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    if (parsed.action === 'noop') return;
    const page = paramInt(parsed, 0, { min: 1, fallback: 1 });
    const itemKey = paramString(parsed, 1, 'all');
    await interaction.editReply(
      await auctionListView(context, itemKey === 'all' ? undefined : itemKey, page),
    );
  },
};

const profileButtons: ButtonHandler = {
  namespace: 'profile',
  actions: ['stats', 'open'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'open') {
      // Raccourci des erreurs de niveau : sa propre carte de profil.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await profileView(context, interaction.user, interaction.user.id));
      return;
    }
    // Les statistiques elles-mêmes, et non plus un renvoi vers `/stats`.
    const targetId = paramString(parsed, 0) || interaction.user.id;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const name = interaction.client.users.cache.get(targetId)?.displayName ?? context.player.username;
    await interaction.editReply(await statsView(context, targetId, name));
  },
};

// ---------------------------------------------------------------------------
// Langue
// ---------------------------------------------------------------------------

const langButtons: ButtonHandler = {
  namespace: 'lang',
  actions: ['set'],
  lockKey: 'lang-set',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    const requested = paramString(parsed, 0);
    if (!isSupported(requested)) {
      await replyEphemeral(interaction, { content: context.t('settings.unknown_language_content') });
      return;
    }

    // `deferUpdate` puis `editReply` : on remplace le message existant plutôt
    // que d'en empiler un nouveau, et la confirmation arrive dans la langue
    // qui vient d'être choisie.
    await interaction.deferUpdate();
    await applyLocale(interaction, context, requested, { edit: true });
  },
};

export const handlers: ButtonHandler[] = [
  farmButtons,
  inventoryButtons,
  shopButtons,
  blackMarketButtons,
  fishingButtons,
  marketButtons,
  animalButtons,
  questButtons,
  achievementButtons,
  passButtons,
  craftButtons,
  buildingButtons,
  coopButtons,
  helpButtons,
  tutorialButtons,
  settingsButtons,
  prestigeButtons,
  socialButtons,
  auctionButtons,
  profileButtons,
  langButtons,
];
