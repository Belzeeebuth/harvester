import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import { animalsView } from '../framework/views';
import { variantIcon } from '../game/animals';
import * as animalService from '../services/animal.service';
import * as animalRepo from '../repositories/animal.repo';
import { gameError } from '../utils/errors';
import { formatCoins, formatNumber, gaugeBar, truncate } from '../utils/format';
import { translatorFor } from '../i18n';
import { appendTracking } from './farm';
import type { Command } from '../types';
import { withLevelUp } from '../framework/levelup';
import { getConfig } from '../config';
import { describeItems } from '../services/inventory.service';

/** Commandes d'élevage. */

/** Autocomplétion commune : les animaux vivants du joueur. */
async function autocompleteOwnedAnimals(
  interaction: import('discord.js').AutocompleteInteraction,
  context: import('../types').AutocompleteContext,
): Promise<void> {
  if (!context.playerId) {
    await interaction.respond([]);
    return;
  }
  const farm = await (await import('../repositories/player.repo')).getFarmByUserId(context.playerId);
  if (!farm) {
    await interaction.respond([]);
    return;
  }
  const t = translatorFor(context.locale);
  const query = interaction.options.getFocused().toString().toLowerCase();
  const animals = await animalRepo.listAnimals(farm.id);
  await interaction.respond(
    animals
      .filter(
        (entry) =>
          !query ||
          entry.name.toLowerCase().includes(query) ||
          (entry.animal.nickname ?? '').toLowerCase().includes(query),
      )
      .slice(0, 25)
      .map((entry) => ({
        name: truncate(
          `${entry.emoji} ${entry.animal.nickname ?? entry.name} · ${t('animals.autocomplete_status', {
            hunger: entry.animal.hunger,
            happiness: entry.animal.happiness,
          })}`,
          100,
        ),
        value: entry.animal.id,
      })),
  );
}

const animaux: Command = {
  category: 'elevage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('animals')
    .setDescription('Your livestock: status, output, buildings')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(await animalsView(context, 1));
  },
};

const acheterAnimal: Command = {
  category: 'elevage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('buy-animal')
    .setDescription('Buy an animal for your farm')
    .addStringOption((option) =>
      option.setName('species').setDescription("The species to buy").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('How many animals (max 10)').setMinValue(1).setMaxValue(10),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.buyAnimal(context.player, {
      animalKey: interaction.options.getString('species', true),
      quantity: interaction.options.getInteger('quantity') ?? 1,
      discordGuildId: context.discordGuildId,
    });

    // Une variante rare s'annonce en tête : c'est l'événement de l'achat, et
    // le joueur ne la verrait sinon qu'à l'icône de `/animals`.
    const lucky = result.variants
      .filter((variant) => variant !== 'normal')
      .map((variant) => context.t(`animals.lucky_${variant}`, { name: result.name }));
    const embed = successEmbed(
      `${result.emoji} ${result.quantity}× ${result.name}`,
      [
        ...lucky,
        context.t('animals.buy_body', {
          amount:
            result.currency === 'gems'
              ? `${formatNumber(result.total, context.locale)} 💎`
              : formatCoins(result.total, false, context.locale),
        }),
      ].join('\n'),
    );
    appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },

  async autocomplete(interaction, context): Promise<void> {
    const t = translatorFor(context.locale);
    const query = interaction.options.getFocused().toString();
    const level = context.playerId
      ? ((await (await import('../repositories/player.repo')).findUserById(context.playerId))?.level ?? 1)
      : 1;
    const animals = animalService.purchasableAnimals(level, query, context.locale);
    if (animals.length === 0 && !query.trim()) {
      // Rien d'achetable à ce niveau : une liste vide laissait croire à une
      // panne. On montre les prochains animaux et le niveau qui les débloque
      // (les choisir renvoie le message de niveau insuffisant).
      const next = getConfig(context.locale).animalList
        .filter((animal) => animal.enabled && !animal.eventOnly && animal.requiredLevel > level)
        .sort((a, b) => a.requiredLevel - b.requiredLevel)
        .slice(0, 5);
      await interaction.respond(
        next.map((animal) => ({
          name: truncate(
            t('onboarding.buy_animal_locked', {
              emoji: animal.emoji,
              name: animal.name,
              level: t('common.level_abbr', { level: animal.requiredLevel }),
            }),
            100,
          ),
          value: animal.key,
        })),
      );
      return;
    }
    await interaction.respond(
      animals.map((animal) => ({
        name: truncate(
          t('animals.buy_autocomplete', {
            emoji: animal.emoji,
            name: animal.name,
            price:
              animal.price > 0
                ? `${formatNumber(animal.price, context.locale)} ${t('common.coins')}`
                : `${animal.priceGems} ${t('common.gems')}`,
            level: t('common.level_abbr', { level: animal.requiredLevel }),
          }),
          100,
        ),
        value: animal.key,
      })),
    );
  },
};

const nourrir: Command = {
  category: 'elevage',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('feed')
    .setDescription('Feed your animals')
    .addStringOption((option) =>
      option
        .setName('animal')
        .setDescription('A specific animal (otherwise: all)')
        .setAutocomplete(true)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const animalId = interaction.options.getString('animal') ?? undefined;
    const result = await animalService.feed(context.player, { animalId, all: !animalId });

    const embed = successEmbed(
      context.t('animals.feed_title'),
      context.t('animals.feed_body', {
        count: result.fed,
        items: describeItems(result.consumed, context.locale),
      }),
    );
    appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const collecter: Command = {
  category: 'elevage',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('collect')
    .setDescription('Collect what your animals have produced')
    .addStringOption((option) =>
      option
        .setName('animal')
        .setDescription('A specific animal (otherwise: all)')
        .setAutocomplete(true)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const animalId = interaction.options.getString('animal') ?? undefined;
    const result = await animalService.collect(context.player, { animalId, all: !animalId });

    const embed = successEmbed(
      context.t('animals.collect_title'),
      result.lines
        .map((line) => `${line.emoji} **${line.quantity}× ${line.itemName}** · ${line.name}`)
        .join('\n'),
    );
    embed.addFields({
      name: context.t('common.total'),
      value: context.t('animals.collect_total_value', {
        count: formatNumber(result.totalQuantity, context.locale),
        xp: formatNumber(result.xpGained, context.locale),
        // Le détail de la montée de niveau est dans le bloc commun ci-dessous.
        levelUp: '',
      }),
    });
    withLevelUp(embed, result.levelUp, context.t, context.locale);
    appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const soigner: Command = {
  category: 'elevage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('heal')
    .setDescription('Have the vet treat a sick animal')
    .addStringOption((option) =>
      option.setName('animal').setDescription("The animal to treat").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.heal(
      context.player,
      interaction.options.getString('animal', true),
    );
    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('animals.heal_title', { emoji: result.emoji, name: result.name }),
          context.t('animals.heal_body', { cost: formatCoins(result.cost, false, context.locale) }),
        ),
      ],
    });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const caresser: Command = {
  category: 'elevage',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('pet')
    .setDescription('Pet an animal: happier animals produce more')
    .addStringOption((option) =>
      option.setName('animal').setDescription("The animal to pet").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.pet(
      context.player,
      interaction.options.getString('animal', true),
    );
    const embed = successEmbed(
      context.t('animals.pet_title', { emoji: result.emoji, name: result.name }),
      context.t('animals.pet_body', {
        gain: result.gain,
        bar: gaugeBar(result.happiness, 8),
        happiness: result.happiness,
      }),
    );
    appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const reproduire: Command = {
  category: 'elevage',
  cooldown: { seconds: 30, bucket: 'breed' },
  data: new SlashCommandBuilder()
    .setName('breed')
    .setDescription('Breed two animals of the same species')
    .addStringOption((option) =>
      option.setName('parent1').setDescription('First parent').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('parent2').setDescription('Second parent').setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.breed(context.player, {
      animalAId: interaction.options.getString('parent1', true),
      animalBId: interaction.options.getString('parent2', true),
    });

    if (!result.success) {
      const reason = context.t(result.reasonKey ?? 'errors.animal.breed_failed', result.reasonParams);
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: `💔 ${context.t('animals.breed_failed_title')}`,
            description: context.t('animals.breed_failed_body', {
              reason,
              cost: formatCoins(result.cost, false, context.locale),
            }),
            color: COLORS.warning,
          }),
        ],
      });
      return;
    }

    const variant = result.variant ?? 'normal';
    const embed = successEmbed(
      context.t('animals.breed_success_title'),
      [
        context.t('animals.breed_success_line1', { generation: result.generation ?? 1 }),
        context.t('animals.breed_success_line2', {
          multiplier: result.qualityMultiplier?.toFixed(3) ?? '1.000',
        }),
        // Un petit shiny est l'aboutissement de l'élevage sélectif : on le dit.
        ...(variant !== 'normal'
          ? [
              context.t('animals.breed_variant_line', {
                icon: variantIcon(variant),
                variant: context.t(`animals.variant.${variant}`),
              }),
            ]
          : []),
        '',
        context.t('animals.breed_success_footer'),
      ].join('\n'),
    );
    if (result.tracking) appendTracking(embed, result.tracking, context.t);
    await interaction.editReply({ embeds: [embed] });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const vendreAnimal: Command = {
  category: 'elevage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('sell-animal')
    .setDescription('Sell an animal (60% of price, scaled by health)')
    .addStringOption((option) =>
      option.setName('animal').setDescription("The animal to sell").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.sellAnimal(
      context.player,
      interaction.options.getString('animal', true),
    );
    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('animals.sell_title', { emoji: result.emoji, name: result.name }),
          context.t('animals.sell_body', { price: formatCoins(result.price, false, context.locale) }),
        ),
      ],
    });
  },

  autocomplete: autocompleteOwnedAnimals,
};

export const commands: Command[] = [
  animaux,
  acheterAnimal,
  nourrir,
  collecter,
  soigner,
  caresser,
  reproduire,
  vendreAnimal,
];
export { gameError };
