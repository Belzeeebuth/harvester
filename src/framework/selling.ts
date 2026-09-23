import { ButtonStyle, type ActionRowBuilder, type ButtonBuilder } from 'discord.js';
import { harvestKeyOf, localizeRows } from '../config';
import * as inventoryRepo from '../repositories/inventory.repo';
import { COIN, formatNumber, truncate } from '../utils/format';
import { CUSTOM_ID_MAX_LENGTH, CUSTOM_ID_SEPARATOR } from '../utils/custom-id';
import { COLORS, baseEmbed, button, row, select, selectRow } from './ui';
import type { HarvestSummary } from '../services/farm.service';
import type { CommandContext, Translator } from '../types';
import type { View } from './views';

/**
 * Vente depuis les boutons : après une récolte, et depuis l'inventaire.
 *
 * Deux impasses de la première heure : `/harvest` ne proposait aucune suite,
 * et le bouton « Vendre » de l'inventaire n'affichait que la syntaxe de
 * `/sell`. Les deux ouvrent désormais une vente réelle (gestionnaires
 * `sell:*` dans src/components).
 */

/**
 * Bouton « vendre la récolte ». Les objets récoltés voyagent dans l'identifiant
 * (`wheat|carrot`) ; s'ils ne tiennent pas dans les 100 caractères de Discord,
 * le bouton vend toute la catégorie « récoltes », ce qui les inclut.
 */
export function harvestSellButton(itemKeys: readonly string[], ownerId: string, t: Translator): ButtonBuilder {
  const joined = [...new Set(itemKeys)].join('|');
  const length = ['sell', 'harvest', ownerId, joined].join(CUSTOM_ID_SEPARATOR).length;
  const params = joined && length <= CUSTOM_ID_MAX_LENGTH ? [joined] : [];
  return button({
    namespace: 'sell',
    action: 'harvest',
    ownerId,
    params,
    label: t('first_hour.sell_harvest_button'),
    emoji: '💰',
    style: ButtonStyle.Success,
  });
}

/** Rangée isolée du bouton de vente, pour les réponses qui n'ont pas d'autres boutons. */
export function harvestSellRow(
  itemKeys: readonly string[],
  ownerId: string,
  t: Translator,
): ActionRowBuilder<ButtonBuilder> {
  return row(harvestSellButton(itemKeys, ownerId, t));
}

/** Composants à joindre au bilan d'une récolte : le bouton de vente, s'il y a de quoi vendre. */
export function harvestFollowUpRows(
  summary: Pick<HarvestSummary, 'plots'>,
  ownerId: string,
  t: Translator,
): Array<ActionRowBuilder<ButtonBuilder>> {
  const itemKeys = summary.plots
    .filter((plot) => plot.result.quantity > 0)
    .map((plot) => harvestKeyOf(plot.cropKey));
  return itemKeys.length > 0 ? [harvestSellRow(itemKeys, ownerId, t)] : [];
}

/** Menu de vente : toutes les récoltes d'un clic, ou un objet précis (toutes ses piles). */
export async function sellMenuView(context: CommandContext): Promise<View> {
  const { t, locale, player } = context;
  const stacks = localizeRows(
    (await inventoryRepo.listInventory(player.id, { onlySellable: true })).filter(
      (stack) => !stack.locked && stack.sellPrice > 0,
    ),
    locale,
  );

  // Une option par objet : les qualités d'un même objet partent ensemble.
  const byItem = new Map<string, { name: string; emoji: string; quantity: number; value: number; category: string }>();
  for (const stack of stacks) {
    const entry = byItem.get(stack.itemKey) ?? {
      name: stack.name,
      emoji: stack.emoji,
      quantity: 0,
      value: 0,
      category: stack.category,
    };
    entry.quantity += stack.quantity;
    entry.value += stack.quantity * stack.sellPrice;
    byItem.set(stack.itemKey, entry);
  }
  const hasHarvest = [...byItem.values()].some((entry) => entry.category === 'harvest');

  const choices = [...byItem.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 25)
    .map(([itemKey, entry]) => ({
      label: truncate(`${entry.name} ×${formatNumber(entry.quantity, locale)}`, 100),
      value: itemKey,
      emoji: entry.emoji,
      description: t('first_hour.sell_option_description', {
        value: `${formatNumber(entry.value, locale)} ${COIN}`,
      }),
    }));

  return {
    embeds: [
      baseEmbed({
        title: t('economy.sell_menu_title'),
        description: byItem.size > 0 ? t('first_hour.sell_menu_body') : t('first_hour.sell_menu_empty'),
        color: COLORS.gold,
      }),
    ],
    components:
      byItem.size > 0
        ? [
            selectRow(
              select({
                namespace: 'sell',
                action: 'item',
                ownerId: player.discordId,
                placeholder: t('first_hour.sell_menu_placeholder'),
                choices,
              }),
            ),
            row(
              button({
                namespace: 'sell',
                action: 'harvest',
                ownerId: player.discordId,
                label: t('first_hour.sell_all_harvest_button'),
                emoji: '🌾',
                style: ButtonStyle.Success,
                disabled: !hasHarvest,
              }),
            ),
          ]
        : [],
  };
}
