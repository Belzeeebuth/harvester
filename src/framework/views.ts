import { ButtonStyle, type AttachmentBuilder, type BaseMessageOptions } from 'discord.js';
import { getConfig } from '../config';
import { variantIcon } from '../game/animals';
import * as animalService from '../services/animal.service';
import * as coopService from '../services/coop.service';
import * as craftService from '../services/craft.service';
import * as farmService from '../services/farm.service';
import * as inventoryService from '../services/inventory.service';
import * as marketService from '../services/market.service';
import * as progressionService from '../services/progression.service';
import { getWorldState } from '../services/world.service';
import { NO_IMAGE, renderAnimalsImage, renderFarmImage, type AnimalsRenderInput } from '../render';
import {
  COIN,
  discordTimestamp,
  formatCoins,
  formatCompact,
  formatDuration,
  formatNumber,
  formatPercent,
  gaugeBar,
  progressBar,
  qualityIcon,
  mutationIcon,
  truncate,
} from '../utils/format';
import { COLORS, baseEmbed, button, farmShortcutsRow, paginationRow, row, select, selectRow } from './ui';
import type { CommandContext } from '../types';

/**
 * Vues partagées entre commandes et composants.
 *
 * Une commande et le bouton « Rafraîchir » du même message doivent produire
 * EXACTEMENT le même rendu. Les construire ici, une seule fois, garantit cette
 * cohérence : `/farm` et le bouton appellent tous deux `farmView()`.
 */

export interface View extends BaseMessageOptions {
  files?: AttachmentBuilder[];
}

// ---------------------------------------------------------------------------
// FERME
// ---------------------------------------------------------------------------

export async function farmView(
  context: CommandContext,
  options: { targetName?: string; avatarUrl?: string | null; readOnly?: boolean } = {},
): Promise<View> {
  const player = context.player;
  const t = context.t;
  const locale = context.locale;
  const catalog = getConfig(locale);
  const coopLevel = await coopLevelOf(player.coopId);
  const view = await farmService.getFarmView(player, { coopLevel, now: context.now });
  const herd = await animalService.getHerd(player, context.now);

  const xpForNext = (await import('../game/xp')).xpForNextLevel(player.level, context.balance);

  const image = player.compactMode ? NO_IMAGE : await renderFarmImage({
    locale: context.locale,
    view,
    player: {
      username: options.targetName ?? player.username,
      level: player.level,
      coins: player.coins,
      gems: player.gems,
      avatarUrl: options.avatarUrl ?? null,
    },
    xp: { current: player.xp, needed: xpForNext },
    theme: 'classic',
    // Silhouette et palette de chaque espèce, pour que l'aperçu du pied de page
    // montre les MÊMES bêtes que `/animals` et non six formes beiges identiques.
    animalsPreview: herd.animals.slice(0, 6).map((animal) => {
      const species = catalog.animals.get(animal.animalKey);
      return {
        emoji: animal.emoji,
        animalKey: animal.animalKey,
        form: species?.form ?? null,
        palette: species?.palette ?? null,
      };
    }),
    buildingsPreview: herd.ownedBuildings,
    equippedPetKey: player.equippedPetKey,
  });

  const counts = view.counts;
  const embed = baseEmbed({
    title: `🌾 ${view.name}`,
    description: [
      `**${view.world.weather.emoji} ${view.world.weather.label}** · ${view.world.weather.description}`,
      view.world.weather.freeWatering ? t('farm.free_watering_today') : '',
      '',
      t('farm.summary', { ready: counts.ready, growing: counts.growing, empty: counts.empty, locked: counts.locked }),
      counts.pests > 0 ? t('farm.pests_warning', { count: counts.pests }) : '',
      counts.withered > 0 ? t('farm.withered_warning', { count: counts.withered }) : '',
      view.nextReadyAt
        ? t('render.farm.next_harvest', { duration: discordTimestamp(view.nextReadyAt, 'R') })
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    color: counts.ready > 0 ? COLORS.success : COLORS.primary,
    // L'image n'est VOLONTAIREMENT pas référencée par l'embed.
    //
    // Un `attachment://` dans un embed est rendu à la largeur de l'embed
    // (~400 px) : notre vue de ferme, large de 760 px et plus, y perd la moitié
    // de sa définition. Laissée en pièce jointe libre, Discord l'affiche à sa
    // taille de prévisualisation normale, nettement plus grande.
    //
    // Elle reste dans le MÊME message plutôt que dans un second : le bouton
    // « rafraîchir » passe par `editReply`, qui ne modifie que le message de la
    // réponse. Une image envoyée en `followUp` se figerait sur l'état précédent
    // à chaque rafraîchissement.
  });

  // Repli texte : si le rendu a échoué, on liste les parcelles.
  if (!image.attachment) {
    embed.addFields({
      name: t('common.plots'),
      value:
        view.plots
          .filter((plot) => plot.state !== 'locked')
          .slice(0, 20)
          .map((plot) => {
            if (!plot.crop) return `\`${String(plot.slot).padStart(2, ' ')}\` ⬜ ${t('farm.plot_empty')}`;
            const status = plot.crop.growth.withered
              ? `💀 ${t('farm.plot_withered')}`
              : plot.crop.growth.ready
                ? `✅ ${t('farm.plot_ready')}`
                : `⏳ ${formatDuration(plot.crop.growth.msRemaining, locale)}`;
            return `\`${String(plot.slot).padStart(2, ' ')}\` ${plot.crop.emoji} ${plot.crop.name} · ${status}${plot.crop.growth.needsWater ? ' 💧' : ''}`;
          })
          .join('\n') || t('farm.no_plot_unlocked'),
    });
  }

  if (options.readOnly) {
    return { embeds: [embed], files: image.attachment ? [image.attachment] : [] };
  }

  return {
    embeds: [embed],
    files: image.attachment ? [image.attachment] : [],
    components: [
      farmShortcutsRow(
        player.discordId,
        {
          canHarvest: counts.ready > 0 || counts.withered > 0,
          canWater: counts.growing > 0,
          canPlant: counts.empty > 0,
        },
        locale,
        t,
      ),
      row(
        button({
          namespace: 'farm',
          action: 'plots',
          ownerId: player.discordId,
          label: t('common.plots'),
          emoji: '🗺️',
        }),
        button({
          namespace: 'animal',
          action: 'open',
          ownerId: player.discordId,
          label: t('common.animals'),
          emoji: '🐄',
        }),
        button({
          namespace: 'inv',
          action: 'open',
          ownerId: player.discordId,
          label: t('common.inventory'),
          emoji: '🎒',
        }),
        button({
          namespace: 'quest',
          action: 'open',
          ownerId: player.discordId,
          label: t('common.quests'),
          emoji: '📋',
        }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// PARCELLES
// ---------------------------------------------------------------------------

export async function plotsView(context: CommandContext, page = 1): Promise<View> {
  const player = context.player;
  const t = context.t;
  const locale = context.locale;
  const view = await farmService.getFarmView(player, { now: context.now });
  const pageSize = 12;
  const totalPages = Math.max(1, Math.ceil(view.plots.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = view.plots.slice((current - 1) * pageSize, current * pageSize);

  const lines = slice.map((plot) => {
    if (plot.state === 'locked') {
      return `\`${String(plot.slot).padStart(2, ' ')}\` 🔒 ${t('farm.plot_locked')} · ${formatCoins(plot.unlockCost, false, locale)}`;
    }
    const soil = t('farm.soil_status', { pct: plot.fertility, label: t(plot.fertilityLabel) });
    if (!plot.crop) {
      return `\`${String(plot.slot).padStart(2, ' ')}\` ⬜ ${t('farm.plot_empty')} · ${soil}${plot.weedLevel > 30 ? ` · ${t('farm.weeds_status', { pct: plot.weedLevel })}` : ''}`;
    }
    const status = plot.crop.growth.withered
      ? `💀 ${t('farm.plot_withered')}`
      : plot.crop.growth.ready
        ? `✅ **${t('farm.plot_ready')}**`
        : `⏳ ${discordTimestamp(plot.crop.growth.readyAt, 'R')}`;
    return [
      `\`${String(plot.slot).padStart(2, ' ')}\` ${plot.crop.emoji} **${plot.crop.name}** · ${status}`,
      `      ${soil} · 💧 ${plot.crop.waterGiven}/${plot.crop.waterNeeded}${plot.pestType ? ` · 🐛 ${t('farm.plot_pest')}` : ''}${plot.crop.regrowRemaining > 0 ? ` · ${t('farm.regrow_count', { count: plot.crop.regrowRemaining })}` : ''}`,
    ].join('\n');
  });

  const embed = baseEmbed({
    title: `🗺️ ${t('farm.plots_title')}`,
    description: lines.join('\n') || t('farm.no_plot'),
    color: COLORS.primary,
    fields: [
      {
        name: t('farm.expansion_field'),
        value:
          view.nextPlotCost > 0
            ? t('farm.next_plot_cost', {
                cost: formatCoins(view.nextPlotCost, false, locale),
                unlocked: view.unlockedPlots,
                max: context.balance.plots.maxPlots,
              })
            : t('farm.all_plots_unlocked', { unlocked: view.unlockedPlots }),
      },
    ],
  });

  return {
    embeds: [embed],
    components: [
      paginationRow({
        namespace: 'farm',
        ownerId: player.discordId,
        page: current,
        totalPages,
      }),
      row(
        button({
          namespace: 'farm',
          action: 'buy_plot',
          ownerId: player.discordId,
          label:
            view.nextPlotCost > 0
              ? t('farm.buy_plot_button', { cost: formatCompact(view.nextPlotCost, locale) })
              : t('common.complete'),
          emoji: '🛒',
          style: ButtonStyle.Success,
          disabled: view.nextPlotCost === 0,
        }),
        button({
          namespace: 'farm',
          action: 'weed_all',
          ownerId: player.discordId,
          label: t('farm.weed_button'),
          emoji: '🌿',
        }),
        button({ namespace: 'farm', action: 'refresh', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// INVENTAIRE
// ---------------------------------------------------------------------------

const INVENTORY_CATEGORY_KEYS = [
  'seed',
  'harvest',
  'animal_product',
  'product',
  'tool',
  'consumable',
  'material',
  'cosmetic',
  'event',
] as const;

export async function inventoryView(
  context: CommandContext,
  options: { category?: string; page?: number } = {},
): Promise<View> {
  const player = context.player;
  const t = context.t;
  const locale = context.locale;
  const page = await inventoryService.getPage(
    player.id,
    { category: options.category, page: options.page },
    context.locale,
  );

  const categoryChoice = (key: string): { label: string; emoji: string } => {
    const emojis: Record<string, string> = {
      seed: '🌱',
      harvest: '🌾',
      animal_product: '🥚',
      product: '🧀',
      tool: '🛠️',
      consumable: '🧪',
      material: '🪵',
      cosmetic: '🎨',
      event: '🎉',
      fish: '🐟',
      ore: '🪨',
    };
    return { label: t(`inventory.categories.${key}`), emoji: emojis[key] ?? '📦' };
  };

  const lines = page.entries.map((entry) => {
    const icons = `${qualityIcon(entry.quality)}${mutationIcon(entry.mutation)}`;
    const value = entry.sellable ? ` · ${formatCoins(entry.sellPrice * entry.quantity, true, locale)}` : '';
    return `${entry.emoji} **${entry.name}**${icons} ×${formatNumber(entry.quantity, locale)}${value}`;
  });

  const embed = baseEmbed({
    title: t('inventory.title', { name: `${player.username}’s` }),
    description: lines.join('\n') || `*${t('inventory.empty_category')}*`,
    color: COLORS.info,
    fields: [
      {
        name: t('inventory.warehouse_field'),
        value: `${progressBar(page.used, page.capacity, 12)} ${formatNumber(page.used, locale)}/${formatNumber(page.capacity, locale)}`,
        inline: true,
      },
      {
        name: t('inventory.estimated_value_field'),
        value: formatCoins(page.totalValue, true, locale),
        inline: true,
      },
    ],
  });

  return {
    embeds: [embed],
    components: [
      selectRow(
        select({
          namespace: 'inv',
          action: 'category',
          ownerId: player.discordId,
          placeholder: t('inventory.filter_placeholder'),
          choices: [
            { label: t('common.all'), value: 'all', emoji: '📦', default: !options.category },
            ...INVENTORY_CATEGORY_KEYS.map((value) => {
              const meta = categoryChoice(value);
              return {
                label: meta.label,
                value,
                emoji: meta.emoji,
                default: options.category === value,
              };
            }),
          ],
        }),
      ),
      paginationRow({
        namespace: 'inv',
        ownerId: player.discordId,
        page: page.page,
        totalPages: page.totalPages,
        extraParams: [options.category ?? 'all'],
      }),
      row(
        button({
          namespace: 'inv',
          action: 'sell_menu',
          ownerId: player.discordId,
          label: t('common.sell'),
          emoji: '💰',
          style: ButtonStyle.Success,
        }),
        button({
          namespace: 'farm',
          action: 'refresh',
          ownerId: player.discordId,
          label: t('common.my_farm'),
          emoji: '🌾',
        }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// BOUTIQUE
// ---------------------------------------------------------------------------

/**
 * Options du menu d'achat. Le menu liste TOUT ce que l'écran affiche, articles
 * verrouillés et épuisés compris : les masquer donnait un menu à une seule ligne
 * sous six offres du jour, sans un mot d'explication. Discord ne sait pas griser
 * une option isolée : le motif du refus est écrit dans la description, et
 * `shopBuy` le prononce avant d'ouvrir le modal de quantité.
 *
 * Achetables d'abord, pour que la limite de 25 options ne coupe jamais un
 * article que le joueur peut réellement prendre.
 */
export function shopChoices(
  entries: marketService.ShopEntry[],
  context: Pick<CommandContext, 't' | 'locale' | 'player'>,
): Array<{ label: string; value: string; emoji: string; description: string }> {
  const { t, locale, player } = context;
  const rank = (entry: marketService.ShopEntry): number =>
    entry.stockRemaining <= 0 ? 2 : entry.requiredLevel > player.level ? 1 : 0;

  return [...entries]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 25)
    .map((entry) => {
      const price = `${formatNumber(entry.price, locale)} ${entry.currency === 'gems' ? t('common.gems') : t('common.coins')}`;
      const blocked =
        entry.stockRemaining <= 0
          ? t('shop.sold_out')
          : entry.requiredLevel > player.level
            ? `🔒 ${t('shop.option_locked', { level: entry.requiredLevel })}`
            : null;
      return {
        label: `${entry.name} · ${price}`,
        value: entry.itemKey,
        emoji: entry.emoji,
        description: truncate(blocked ?? entry.description ?? '', 100),
      };
    });
}

export async function shopView(context: CommandContext, category?: string): Promise<View> {
  const player = context.player;
  const t = context.t;
  const locale = context.locale;
  const entries = await marketService.getShop(context.now, context.locale);
  const filtered = category ? entries.filter((entry) => entry.category === category) : entries;

  const grouped = new Map<string, typeof filtered>();
  for (const entry of filtered) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }

  const categoryTitle = (key: string): string => {
    if (key === 'daily') return `✨ ${t('shop.category_daily')}`;
    if (key === 'seeds') return `🌱 ${t('inventory.categories.seed')}`;
    if (key === 'supplies') return `📦 ${t('shop.category_supplies')}`;
    return key;
  };

  const fields = [...grouped.entries()].map(([key, list]) => ({
    name: categoryTitle(key),
    value: list
      .slice(0, 10)
      .map((entry) => {
        const price = `${formatNumber(entry.price, locale)} ${entry.currency === 'gems' ? '💎' : COIN}`;
        const discount = entry.discountPercent > 0 ? ` (-${entry.discountPercent} %)` : '';
        const stock =
          entry.stockRemaining >= 999
            ? ''
            : entry.stockRemaining <= 0
              ? ` · **${t('shop.sold_out')}**`
              : ` · ${t('shop.in_stock', { remaining: entry.stockRemaining })}`;
        const level = entry.requiredLevel > player.level ? ` 🔒 ${t('common.level_abbr', { level: entry.requiredLevel })}` : '';
        return `${entry.emoji} **${entry.name}** · ${price}${discount}${stock}${level}`;
      })
      .join('\n'),
  }));

  const first = entries[0];
  const embed = baseEmbed({
    title: t('shop.title'),
    description: first
      ? t('shop.refreshed_body', { when: discordTimestamp(first.expiresAt, 'R') })
      : t('shop.empty_body'),
    color: COLORS.gold,
    fields,
  });

  return {
    embeds: [embed],
    components: [
      selectRow(
        select({
          namespace: 'shop',
          action: 'buy',
          ownerId: player.discordId,
          placeholder: t('shop.buy_placeholder'),
          choices: shopChoices(filtered, context),
        }),
      ),
      row(
        button({
          namespace: 'shop',
          action: 'filter',
          ownerId: player.discordId,
          params: ['all'],
          label: t('common.all'),
          emoji: '📦',
        }),
        button({
          namespace: 'shop',
          action: 'filter',
          ownerId: player.discordId,
          params: ['daily'],
          label: t('shop.category_daily'),
          emoji: '✨',
        }),
        button({
          namespace: 'shop',
          action: 'filter',
          ownerId: player.discordId,
          params: ['seeds'],
          label: t('inventory.categories.seed'),
          emoji: '🌱',
        }),
        button({ namespace: 'shop', action: 'open', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

export async function blackMarketView(context: CommandContext): Promise<View> {
  const player = context.player;
  const t = context.t;
  const locale = context.locale;
  const entries = await marketService.getBlackMarket(context.now, context.locale);

  const fields =
    entries.length > 0
      ? [
          {
            name: t('blackmarket.stock_field'),
            value: entries
              .map((entry) => {
                const price = `${formatNumber(entry.price, locale)} ${COIN}`;
                const stock =
                  entry.stockRemaining <= 0
                    ? ` · **${t('shop.sold_out')}**`
                    : ` · ${t('shop.in_stock', { remaining: entry.stockRemaining })}`;
                const level =
                  entry.requiredLevel > player.level
                    ? ` 🔒 ${t('common.level_abbr', { level: entry.requiredLevel })}`
                    : '';
                return `${entry.emoji} **${entry.name}** · ${price}${stock}${level}`;
              })
              .join('\n'),
          },
        ]
      : [];

  const first = entries[0];
  const embed = baseEmbed({
    title: t('blackmarket.title'),
    description: first
      ? t('blackmarket.intro_body', { when: discordTimestamp(first.expiresAt, 'R') })
      : t('blackmarket.empty_body'),
    color: COLORS.danger,
    fields,
  });

  return {
    embeds: [embed],
    components: [
      selectRow(
        select({
          namespace: 'shop',
          action: 'buy',
          ownerId: player.discordId,
          placeholder: t('shop.buy_placeholder'),
          choices: shopChoices(entries, context),
        }),
      ),
      row(button({ namespace: 'blackmarket', action: 'open', ownerId: player.discordId, emoji: '🔄' })),
    ],
  };
}

// ---------------------------------------------------------------------------
// MARCHÉ
// ---------------------------------------------------------------------------

export async function marketView(context: CommandContext, category?: string): Promise<View> {
  const t = context.t;
  const locale = context.locale;
  const rows = await marketService.getMarket({ category }, context.locale);
  // Ne classer « en hausse »/« en baisse » que les objets dont la variation
  // dépasse le seuil de `describeTrend` (2 %) : sinon un marché stable (toutes
  // les tendances à 0, par exemple avant le premier cycle horaire) finissait
  // par répartir arbitrairement des objets ➡️ « stables » dans les deux
  // colonnes, juste par ordre du catalogue.
  const rising = rows
    .filter((entry) => entry.trend >= 0.02)
    .sort((a, b) => b.trend - a.trend)
    .slice(0, 8);
  const falling = rows
    .filter((entry) => entry.trend <= -0.02)
    .sort((a, b) => a.trend - b.trend)
    .slice(0, 8);
  const alphabetical = [...rows].sort((a, b) => a.name.localeCompare(b.name));

  const format = (entry: (typeof rows)[number]): string =>
    `${entry.trendEmoji} ${entry.emoji} **${entry.name}** · ${formatNumber(entry.price, locale)} ${COIN} (${formatPercent(entry.trend, 1, locale)})`;

  // Marché entièrement plat (aucun objet ne franchit le seuil de mouvement) :
  // plutôt que deux champs vides, on affiche un repère par prix. Pas de
  // pourcentage ici — en montrer un après avoir expliqué que rien ne bouge
  // reproduirait exactement la confusion d'origine.
  const byPrice = [...rows].sort((a, b) => a.price - b.price);
  const formatPriceOnly = (entry: (typeof rows)[number]): string =>
    `${entry.emoji} **${entry.name}** · ${formatNumber(entry.price, locale)} ${COIN}`;
  const fields =
    rising.length > 0 || falling.length > 0
      ? [
          { name: `📈 ${t('market.trend_up')}`, value: rising.map(format).join('\n') || t('common.none'), inline: false },
          { name: `📉 ${t('market.trend_down')}`, value: falling.map(format).join('\n') || t('common.none'), inline: false },
        ]
      : [
          {
            name: `💰 ${t('market.cheapest_title')}`,
            value: byPrice.slice(0, 8).map(formatPriceOnly).join('\n') || t('common.none'),
            inline: false,
          },
          {
            name: `💎 ${t('market.priciest_title')}`,
            value: [...byPrice].reverse().slice(0, 8).map(formatPriceOnly).join('\n') || t('common.none'),
            inline: false,
          },
        ];

  const embed = baseEmbed({
    title: t('market.title'),
    description: [
      t('market.description'),
      rows[0] ? t('market.next_update', { when: discordTimestamp(rows[0].nextUpdateAt, 'R') }) : '',
    ]
      .filter(Boolean)
      .join('\n'),
    color: COLORS.info,
    fields,
  });

  const featured = rows.filter((entry) => entry.featured);
  if (featured.length > 0) {
    embed.addFields({
      name: `⭐ ${t('market.featured_field')}`,
      value: featured.map((entry) => `${entry.emoji} ${entry.name}`).join(' · '),
    });
  }

  return {
    embeds: [embed],
    components: [
      selectRow(
        select({
          namespace: 'market',
          action: 'chart',
          ownerId: context.player.discordId,
          placeholder: t('market.chart_placeholder'),
          choices: alphabetical.slice(0, 25).map((entry) => ({
            label: `${entry.name} · ${entry.price} 🪙`,
            value: entry.itemKey,
            emoji: entry.emoji,
            description: `${entry.trendLabel} · ${t(`common.rarity.${entry.rarity}`)}`,
          })),
        }),
      ),
      row(
        button({
          namespace: 'market',
          action: 'filter',
          ownerId: context.player.discordId,
          params: ['harvest'],
          label: t('inventory.categories.harvest'),
          emoji: '🌾',
        }),
        button({
          namespace: 'market',
          action: 'filter',
          ownerId: context.player.discordId,
          params: ['product'],
          label: t('market.products_label'),
          emoji: '🧀',
        }),
        button({
          namespace: 'market',
          action: 'filter',
          ownerId: context.player.discordId,
          params: ['animal_product'],
          label: t('market.livestock_label'),
          emoji: '🥚',
        }),
        button({
          namespace: 'market',
          action: 'open',
          ownerId: context.player.discordId,
          emoji: '🔄',
        }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// ANIMAUX
// ---------------------------------------------------------------------------

/**
 * Entrée du rendu de basse-cour, dérivée du cheptel déjà chargé.
 *
 * Les formes et palettes viennent du catalogue et non de `HerdView`, qui ne
 * les porte pas : le service n'a pas à connaître l'apparence des bêtes.
 */
async function animalsRenderInput(
  context: CommandContext,
  herd: animalService.HerdView,
): Promise<AnimalsRenderInput> {
  const player = context.player;
  const catalog = getConfig(context.locale);
  const world = await getWorldState(context.now, context.locale);
  return {
    locale: context.locale,
    farmId: player.farmId,
    ownerName: player.username,
    season: world.season.season,
    weather: world.weather.weather,
    buildings: herd.capacityByBuilding.map((entry) => ({
      key: entry.buildingKey,
      name: entry.name,
      tier: entry.tier,
      capacity: entry.capacity,
      used: entry.used,
    })),
    animals: herd.animals.map((animal) => {
      const species = catalog.animals.get(animal.animalKey);
      return {
        id: animal.id,
        animalKey: animal.animalKey,
        name: animal.name,
        nickname: animal.nickname,
        emoji: animal.emoji,
        form: species?.form ?? null,
        palette: species?.palette ?? null,
        variant: animal.variant,
        buildingKey: animal.buildingKey,
        hunger: animal.status.hunger,
        happiness: animal.status.happiness,
        health: animal.status.health,
        hungry: animal.status.hungry,
        sick: animal.status.sick,
        canCollect: animal.canCollect,
        canFeed: animal.canFeed,
        canPet: animal.canPet,
        readyProduction: animal.status.readyProduction,
        productEmoji: animal.productEmoji,
      };
    }),
    totals: {
      alive: herd.totals.alive,
      hungry: herd.totals.hungry,
      sick: herd.totals.sick,
      ready: herd.totals.readyToCollect,
    },
  };
}

export async function animalsView(context: CommandContext, page = 1): Promise<View> {
  const player = context.player;
  const t = context.t;
  const herd = await animalService.getHerd(player, context.now);
  // L'image montre tout le cheptel d'un coup ; le texte paginé garde ce qu'elle
  // ne dit pas (prochaine production, génération). Les deux se complètent, le
  // texte reste donc affiché même quand l'image est là — c'est aussi le repli
  // quand le rendu échoue ou que le joueur a choisi le mode compact.
  const image = player.compactMode
    ? NO_IMAGE
    : await renderAnimalsImage(await animalsRenderInput(context, herd));
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(herd.animals.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = herd.animals.slice((current - 1) * pageSize, current * pageSize);

  const lines = slice.map((animal) => {
    const production = animal.canCollect
      ? `✅ **${animal.status.readyProduction}× ${animal.productEmoji}**`
      : animal.status.nextProductionAt
        ? `⏳ ${discordTimestamp(animal.status.nextProductionAt, 'R')}`
        : '';
    // L'icône de variante (✨ shiny, 🌟 dorée) suit le nom : c'est la seule
    // trace textuelle d'une bête rare, l'image la montre par son halo.
    const icon = variantIcon(animal.variant);
    return [
      `${animal.emoji} **${animal.nickname ?? animal.name}**${icon ? ` ${icon}` : ''} · ${animal.status.mood}`,
      `   🍽️ ${gaugeBar(animal.status.hunger, 5)} ${animal.status.hunger}%  💛 ${gaugeBar(animal.status.happiness, 5)} ${animal.status.happiness}%  ❤️ ${animal.status.health}%`,
      [
        production,
        animal.generation > 1 ? t('animals.generation_suffix', { gen: animal.generation }) : '',
        animal.qualityMultiplier !== 1 ? `×${animal.qualityMultiplier.toFixed(2)}` : '',
      ]
        .filter(Boolean)
        .map((part, index) => (index === 0 ? `   ${part}` : part))
        .join(' · '),
    ]
      .filter(Boolean)
      .join('\n');
  });

  const embed = baseEmbed({
    title: t('animals.title', { name: `${player.username}’s` }),
    description: lines.join('\n\n') || t('animals.empty'),
    color: herd.totals.readyToCollect > 0 ? COLORS.success : COLORS.primary,
    fields: [
      {
        name: t('common.buildings'),
        value:
          herd.capacityByBuilding
            .map((entry) => `${entry.emoji} ${entry.name} · ${entry.used}/${entry.capacity} (${t('craft.tier_label', { tier: entry.tier })})`)
            .join('\n') || t('animals.no_building_field'),
        inline: false,
      },
      {
        name: t('common.summary'),
        value: t('animals.summary_line', {
          alive: herd.totals.alive,
          hungry: herd.totals.hungry,
          sick: herd.totals.sick,
          ready: herd.totals.readyToCollect,
        }),
        inline: false,
      },
    ],
  });

  return {
    embeds: [embed],
    // Pièce jointe libre, hors de l'embed, pour la même raison que `farmView` :
    // intégrée à l'embed, l'image serait réduite à sa largeur.
    files: image.attachment ? [image.attachment] : [],
    components: [
      row(
        button({
          namespace: 'animal',
          action: 'collect_all',
          ownerId: player.discordId,
          label: t('animals.collect_all_button'),
          emoji: '🥚',
          style: ButtonStyle.Success,
          disabled: herd.totals.readyToCollect === 0,
        }),
        button({
          namespace: 'animal',
          action: 'feed_all',
          ownerId: player.discordId,
          label: t('animals.feed_all_button'),
          emoji: '🌾',
          style: ButtonStyle.Primary,
          disabled: herd.totals.alive === 0,
        }),
        button({
          namespace: 'animal',
          action: 'pet_menu',
          ownerId: player.discordId,
          label: t('animals.pet_button'),
          emoji: '🤍',
          disabled: herd.totals.alive === 0,
        }),
        button({ namespace: 'animal', action: 'open', ownerId: player.discordId, emoji: '🔄' }),
      ),
      ...(totalPages > 1
        ? [paginationRow({ namespace: 'animal', ownerId: player.discordId, page: current, totalPages })]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// QUÊTES
// ---------------------------------------------------------------------------

export async function questsView(
  context: CommandContext,
  type?: 'daily' | 'weekly' | 'story' | 'contract',
): Promise<View> {
  const player = context.player;
  const t = context.t;
  const locale = context.locale;
  const quests = await progressionService.listQuests(player, { type });
  const resets = progressionService.questResetTimes();

  const allSections: Array<{ key: 'daily' | 'weekly' | 'story' | 'contract'; title: string }> = [
    { key: 'daily', title: `📅 ${t('quests.daily')} · ${t('quests.resets', { when: discordTimestamp(resets.daily, 'R') })}` },
    { key: 'weekly', title: `🗓️ ${t('quests.weekly')} · ${t('quests.resets', { when: discordTimestamp(resets.weekly, 'R') })}` },
    { key: 'story', title: `📖 ${t('quests.story')}` },
    { key: 'contract', title: `📦 ${t('quests.contract')}` },
  ];
  const sections = allSections.filter((section) => !type || section.key === type);

  const fields = sections
    .map((section) => {
      const list = quests.filter((quest) => quest.type === section.key);
      if (list.length === 0) return undefined;
      return {
        name: section.title,
        value: list
          .map((quest) => {
            const status =
              quest.status === 'claimed'
                ? `✅ ${t('quests.claimed')}`
                : quest.status === 'completed'
                  ? `🎁 **${t('quests.to_claim_indicator')}**`
                  : `${progressBar(quest.progress, quest.required, 8)} ${quest.progress}/${quest.required}`;
            const rewards = [
              quest.rewards.coins ? `${formatCompact(quest.rewards.coins, locale)} 🪙` : '',
              quest.rewards.gems ? `${quest.rewards.gems} 💎` : '',
              quest.rewards.xp ? `${formatCompact(quest.rewards.xp, locale)} ✨` : '',
            ]
              .filter(Boolean)
              .join(' · ');
            return `**${quest.title}**\n${quest.description}\n${status} · ${rewards}`;
          })
          .join('\n\n'),
      };
    })
    .filter((field): field is NonNullable<typeof field> => field !== undefined);

  const claimable = quests.filter((quest) => quest.status === 'completed');

  const embed = baseEmbed({
    title: t('quests.title', { name: `${player.username}'s` }),
    description:
      claimable.length > 0
        ? t('quests.rewards_waiting', { count: claimable.length })
        : t('quests.description_default'),
    color: claimable.length > 0 ? COLORS.gold : COLORS.primary,
    fields,
  });

  const rerollable = quests.filter((quest) => quest.type === 'daily' && quest.status === 'active');

  return {
    embeds: [embed],
    components: [
      row(
        button({
          namespace: 'quest',
          action: 'claim_all',
          ownerId: player.discordId,
          label: t('quests.claim_all_button', { count: claimable.length }),
          emoji: '🎁',
          style: ButtonStyle.Success,
          disabled: claimable.length === 0,
        }),
        button({
          namespace: 'quest',
          action: 'filter',
          ownerId: player.discordId,
          params: ['daily'],
          label: t('quests.daily'),
          emoji: '📅',
        }),
        button({
          namespace: 'quest',
          action: 'filter',
          ownerId: player.discordId,
          params: ['weekly'],
          label: t('quests.weekly'),
          emoji: '🗓️',
        }),
        button({
          namespace: 'quest',
          action: 'open',
          ownerId: player.discordId,
          emoji: '🔄',
        }),
      ),
      ...(rerollable.length > 0
        ? [
            selectRow(
              select({
                namespace: 'quest',
                action: 'reroll',
                ownerId: player.discordId,
                placeholder: t('quests.reroll_placeholder'),
                choices: rerollable.slice(0, 25).map((quest) => ({
                  label: truncate(quest.title, 90),
                  value: quest.id,
                  description: truncate(quest.description, 100),
                  emoji: '🔄',
                })),
              }),
            ),
          ]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// COOPÉRATIVE
// ---------------------------------------------------------------------------

/** Ligne résumant un objectif (hebdomadaire ou défi quotidien) — même gabarit pour les deux. */
function objectiveSummaryLine(
  objective: { objectiveKey: string; status: string; progress: number; target: number; rewardCoins: number },
  t: CommandContext['t'],
  locale: string,
): string {
  const check = objective.status === 'completed' ? '✅' : '';
  return `**${t(`coop.objective.${objective.objectiveKey}.title`)}** ${check}\n${progressBar(objective.progress, objective.target, 10)} ${formatCompact(objective.progress, locale)}/${formatCompact(objective.target, locale)} · ${formatCompact(objective.rewardCoins, locale)} 🪙`;
}

export async function coopView(context: CommandContext): Promise<View> {
  const player = context.player;
  const t = context.t;
  const locale = context.locale;
  if (!player.coopId) {
    const publics = await coopService.listPublicCoops(8);
    return {
      embeds: [
        baseEmbed({
          title: t('coop.browse_title'),
          description: t('coop.browse_intro'),
          color: COLORS.info,
          fields: [
            {
              name: t('coop.open_coops_field'),
              value:
                publics
                  .map(
                    (coop) =>
                      `${coop.emblem} **${coop.name}** \`[${coop.tag}]\` · lvl ${coop.level} · ${coop.memberCount}/${coop.memberLimit} ${t('common.members').toLowerCase()}`,
                  )
                  .join('\n') || t('coop.no_public_coops'),
            },
          ],
        }),
      ],
      components: [
        row(
          button({
            namespace: 'coop',
            action: 'create',
            ownerId: player.discordId,
            label: t('coop.create_button'),
            emoji: '➕',
            style: ButtonStyle.Success,
          }),
        ),
        ...(publics.length > 0
          ? [
              selectRow(
                select({
                  namespace: 'coop',
                  action: 'join',
                  ownerId: player.discordId,
                  placeholder: t('coop.join_placeholder'),
                  choices: publics.map((coop) => ({
                    label: `${coop.name} [${coop.tag}]`,
                    value: coop.tag,
                    emoji: coop.emblem,
                    description: truncate(
                      coop.description ?? t('coop.listing_description', { level: coop.level, count: coop.memberCount }),
                      100,
                    ),
                  })),
                }),
              ),
            ]
          : []),
      ],
    };
  }

  const info = await coopService.getCoopInfo(player.coopId, player.id);
  const objectives = await coopService.listWeeklyObjectives(player.coopId, context.now);
  const dailyObjectives = await coopService.listDailyObjectives(player.coopId, context.now);
  const members = await coopService.listMembers(player.coopId);

  const embed = baseEmbed({
    title: `${info.emblem} ${info.name} [${info.tag}]`,
    description: info.description ?? t('coop.no_description'),
    color: COLORS.primary,
    fields: [
      {
        name: t('common.progression_field'),
        value: `${t('common.level')} **${info.level}**\n${progressBar(info.xp, info.xpForNext || 1, 12)} ${formatCompact(info.xp, locale)}/${formatCompact(info.xpForNext, locale)}`,
        inline: true,
      },
      {
        name: t('coop.treasury_field'),
        value: formatCoins(info.treasury, true, locale),
        inline: true,
      },
      {
        name: t('common.members'),
        value: `${info.memberCount}/${info.memberLimit}`,
        inline: true,
      },
      {
        name: `🎁 ${t('coop.bonuses')}`,
        value: [
          t('coop.bonus_growth', { pct: (info.bonuses.growthSpeed * 100).toFixed(1) }),
          t('coop.bonus_sell', { pct: (info.bonuses.sellBonus * 100).toFixed(1) }),
          t('coop.bonus_xp', { pct: (info.bonuses.xpBonus * 100).toFixed(1) }),
          t('coop.bonus_quality', { pct: (info.bonuses.qualityBonus * 100).toFixed(1) }),
        ].join('\n'),
        inline: false,
      },
      {
        name: `🎯 ${t('coop.objectives')}`,
        value:
          objectives.map((objective) => objectiveSummaryLine(objective, t, locale)).join('\n') ||
          t('coop.no_active_goal'),
        inline: false,
      },
      {
        name: `🌟 ${t('coop.daily_challenge')}`,
        value:
          dailyObjectives.map((objective) => objectiveSummaryLine(objective, t, locale)).join('\n') ||
          t('coop.no_daily_challenge'),
        inline: false,
      },
      {
        name: t('coop.top_contributors_field'),
        value:
          members
            .slice(0, 5)
            .map(
              (member, index) =>
                `${index + 1}. **${member.username}** (${t(`common.role.${member.member.role}`)}) · ${formatCompact(member.member.weeklyContribution, locale)} 🪙`,
            )
            .join('\n') || t('common.none'),
        inline: false,
      },
    ],
  });

  return {
    embeds: [embed],
    components: [
      row(
        button({
          namespace: 'coop',
          action: 'contribute',
          ownerId: player.discordId,
          label: t('coop.contribute_button'),
          emoji: '💰',
          style: ButtonStyle.Success,
        }),
        button({
          namespace: 'coop',
          action: 'members',
          ownerId: player.discordId,
          label: t('common.members'),
          emoji: '👥',
        }),
        button({
          namespace: 'coop',
          action: 'objectives',
          ownerId: player.discordId,
          label: t('coop.objectives_button'),
          emoji: '🎯',
        }),
        button({ namespace: 'coop', action: 'open', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// PRODUCTION / BÂTIMENTS
// ---------------------------------------------------------------------------

export async function productionView(context: CommandContext): Promise<View> {
  const player = context.player;
  const t = context.t;
  const lines = await craftService.listProduction(player);
  const ready = lines.filter((line) => line.ready);

  const embed = baseEmbed({
    title: t('craft.queue_title'),
    description:
      lines
        .map(
          (line) =>
            `${line.buildingEmoji} **${line.recipeName}** ×${line.quantity} · ${
              line.ready ? `✅ **${t('craft.ready_indicator')}**` : `⏳ ${discordTimestamp(line.finishAt, 'R')}`
            }\n   → ${line.outputQuantity}× ${line.outputName}`,
        )
        .join('\n') || t('craft.queue_empty'),
    color: ready.length > 0 ? COLORS.success : COLORS.primary,
  });

  return {
    embeds: [embed],
    components: [
      row(
        button({
          namespace: 'craft',
          action: 'collect_all',
          ownerId: player.discordId,
          label: t('craft.collect_all_button', { count: ready.length }),
          emoji: '📦',
          style: ButtonStyle.Success,
          disabled: ready.length === 0,
        }),
        button({
          namespace: 'craft',
          action: 'recipes',
          ownerId: player.discordId,
          label: t('craft.recipes_button'),
          emoji: '📜',
        }),
        button({
          namespace: 'build',
          action: 'open',
          ownerId: player.discordId,
          label: t('common.buildings'),
          emoji: '🏗️',
        }),
        button({ namespace: 'craft', action: 'queue', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

export async function buildingsView(context: CommandContext): Promise<View> {
  const player = context.player;
  const t = context.t;
  const buildings = await craftService.listBuildings(player);

  const groups = new Map<string, typeof buildings>();
  for (const building of buildings) {
    const list = groups.get(building.category) ?? [];
    list.push(building);
    groups.set(building.category, list);
  }

  const categoryTitle = (key: string): string => {
    if (key === 'livestock') return `🐄 ${t('craft.building_category_livestock')}`;
    if (key === 'production') return `🏭 ${t('craft.building_category_production')}`;
    if (key === 'storage') return `📦 ${t('craft.building_category_storage')}`;
    if (key === 'utility') return `🔧 ${t('craft.building_category_utility')}`;
    return key;
  };

  const embed = baseEmbed({
    title: t('craft.buildings_title'),
    description: t('craft.buildings_description'),
    color: COLORS.primary,
    fields: [...groups.entries()].map(([category, list]) => ({
      name: categoryTitle(category),
      value: list
        .map((building) => {
          const state = building.owned
            ? `${t('craft.tier_progress', { tier: building.tier, max: building.maxTier })}`
            : `*${t('craft.not_built')}*`;
          const next = building.nextTier
            ? ` → ${formatCompact(building.nextTier.costCoins, context.locale)} 🪙${
                building.nextTier.costItems.length > 0
                  ? ` + ${building.nextTier.costItems.map((cost) => `${cost.quantity}× ${cost.emoji}`).join(' ')}`
                  : ''
              }${building.nextTier.requiredLevel > player.level ? ` 🔒 ${t('common.level_abbr', { level: building.nextTier.requiredLevel })}` : ''}`
            : ` ✅ ${t('craft.max_tier_reached')}`;
          return `${building.emoji} **${building.name}** · ${state}${next}`;
        })
        .join('\n'),
    })),
  });

  const upgradable = buildings.filter(
    (building) => building.nextTier && building.nextTier.requiredLevel <= player.level,
  );

  return {
    embeds: [embed],
    components: [
      selectRow(
        select({
          namespace: 'build',
          action: 'upgrade',
          ownerId: player.discordId,
          placeholder: t('craft.build_upgrade_placeholder'),
          choices: upgradable.slice(0, 25).map((building) => ({
            label: `${building.name} → ${t('craft.tier_progress', { tier: building.nextTier!.tier, max: building.maxTier })}`,
            value: building.key,
            emoji: building.emoji,
            description: `${formatCompact(building.nextTier!.costCoins, context.locale)} ${t('common.coins')}`,
          })),
          disabled: upgradable.length === 0,
        }),
      ),
      row(
        button({
          namespace: 'craft',
          action: 'queue',
          ownerId: player.discordId,
          label: t('craft.production_button'),
          emoji: '🛠️',
        }),
        button({ namespace: 'build', action: 'open', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/** Niveau de la coopérative d'un joueur (0 s'il n'en a pas). */
export async function coopLevelOf(coopId: string | null): Promise<number> {
  if (!coopId) return 0;
  try {
    const info = await coopService.getCoopInfo(coopId);
    return info.level;
  } catch {
    return 0;
  }
}

export { getConfig };
