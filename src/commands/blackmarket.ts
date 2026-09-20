import { SlashCommandBuilder } from 'discord.js';
import { blackMarketView } from '../framework/views';
import type { Command } from '../types';

/** Boutique de contrebande : contenu rare, stock symbolique, niveau élevé requis. */

const marcheNoir: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('black-market')
    .setDescription('Rare, expensive, very limited stock. For high-level farmers with coins to burn')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(await blackMarketView(context));
  },
};

export const commands: Command[] = [marcheNoir];
