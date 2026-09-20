import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import { PET_CATALOG } from '../game/pets';
import * as petRepo from '../repositories/pet.repo';
import * as petService from '../services/pet.service';
import { translatorFor } from '../i18n';
import { truncate } from '../utils/format';
import type { Command } from '../types';

/** Compagnons de ferme : collection cosmétique débloquée par niveau (`game/pets.ts`). */

const compagnon: Command = {
  category: 'progression',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('companion')
    .setDescription('Your farm companions')
    .addSubcommand((sub) => sub.setName('list').setDescription('All companions and their unlock level'))
    .addSubcommand((sub) =>
      sub
        .setName('equip')
        .setDescription('Equip a companion on your farm')
        .addStringOption((option) =>
          option
            .setName('companion')
            .setDescription('The companion to equip')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('unequip').setDescription('Remove your equipped companion'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'list': {
        const pets = await petService.listPets(context.player);
        const lines = pets.map((pet) => {
          const name = context.t(`pets.catalog.${pet.key}.title`);
          const description = context.t(`pets.catalog.${pet.key}.description`);
          const status = pet.equipped
            ? context.t('pets.equipped_marker')
            : pet.owned
              ? context.t('pets.owned_marker')
              : context.t('pets.locked_marker', { level: pet.unlockLevel });
          return `${pet.emoji} **${name}** · ${status}\n   *${description}*`;
        });
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: context.t('pets.list_title'),
              description: lines.join('\n'),
              color: COLORS.info,
            }),
          ],
        });
        break;
      }
      case 'equip': {
        const key = interaction.options.getString('companion', true);
        await petService.equipPet(context.player, key);
        await interaction.editReply({
          embeds: [
            successEmbed(
              context.t('pets.equipped_title'),
              context.t('pets.equipped_body', { name: context.t(`pets.catalog.${key}.title`) }),
            ),
          ],
        });
        break;
      }
      case 'unequip': {
        await petService.unequipPet(context.player);
        await interaction.editReply({
          embeds: [successEmbed(context.t('pets.unequipped_title'), context.t('pets.unequipped_body'))],
        });
        break;
      }
    }
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    const t = translatorFor(context.locale);
    const owned = context.playerId ? new Set(await petRepo.listOwnedPetKeys(context.playerId)) : new Set<string>();

    await interaction.respond(
      PET_CATALOG.filter((pet) => owned.has(pet.key))
        .map((pet) => ({ pet, name: t(`pets.catalog.${pet.key}.title`) }))
        .filter(({ name }) => !query || name.toLowerCase().includes(query))
        .slice(0, 25)
        .map(({ pet, name }) => ({ name: truncate(`${pet.emoji} ${name}`, 100), value: pet.key })),
    );
  },
};

export const command: Command = compagnon;
