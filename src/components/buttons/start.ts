import type { ButtonInteraction } from 'discord.js';
import { alreadyStartedView, welcomeView } from '../../commands/start';
import { buildContext, isGuest } from '../../framework/interaction';
import type { ButtonHandler } from '../../types';

/**
 * Bouton « Créer ma ferme », joint au message « vous n'avez pas encore de
 * ferme » : le joueur qui clique un bouton ou lance une commande avant `/start`
 * n'a plus à deviner la commande, un clic crée la ferme et affiche l'accueil.
 */
const startCreate: ButtonHandler = {
  namespace: 'start',
  actions: ['create'],
  // Le contexte « invité » suffit pour arriver jusqu'ici ; la ferme est créée
  // juste en dessous, comme le fait `/start`.
  requiresAccount: false,
  lockKey: 'start-create',

  async execute(interaction: ButtonInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply();
    const created = isGuest(context)
      ? await buildContext(interaction, { createIfMissing: true })
      : context;
    if (!created) return;
    const view = created.player.created
      ? welcomeView(created, interaction.user.id)
      : alreadyStartedView(created, interaction.user.id);
    await interaction.editReply(view);
  },
};

export const handlers: ButtonHandler[] = [startCreate];
