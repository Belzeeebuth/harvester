import { balance as getBalance, getConfig } from '../config';
import { translate } from '../i18n';
import type { FarmView, PlotView } from '../services/farm.service';
import { formatCompact, formatDuration, formatNumber } from '../utils/format';
import { clampAltText, joinSentences, listSome } from './alt-text';
import {
  PALETTE,
  THEME_PALETTES,
  clipText,
  drawAvatar,
  encode,
  fillRoundRect,
  fitFont,
  font,
  newCanvas,
  offscreen,
  outlineCanvas,
  progressBar,
  rainbowGradient,
  tintCanvas,
  withDropShadow,
} from './canvas';
import {
  drawBuilding,
  drawGrass,
  drawSky,
  drawWeatherOverlay,
  seasonPalette,
  seedFrom,
  seededRandom,
} from './scenery';
import {
  cropSkin,
  drawAnimal,
  drawAnimalForm,
  drawBadge,
  drawBed,
  drawCoin,
  drawCrop,
  drawGem,
  drawLockedTile,
  drawPetIcon,
  drawWeatherIcon,
  sprite,
} from './sprites';
import type { SKRSContext2D } from '@napi-rs/canvas';
import type { AnimalForm, AnimalPalette } from '../config/gameplay/schemas';

/**
 * Vue de ferme en PNG : un champ clôturé, vu de dessus, sous le ciel de la
 * saison et de la météo du jour.
 *
 * Le rendu est ENTIÈREMENT dérivé de `FarmView`, ce qui a deux conséquences
 * utiles : on peut prévisualiser une ferme sans base de données
 * (`npm run render:preview`), et la fonction est testable en comparant des
 * dimensions ou des sommes de contrôle.
 *
 * Trois principes de lecture, dans cet ordre :
 *  1. LA PLANTE PORTE L'INFORMATION. Sa silhouette dit l'espèce, sa taille dit
 *     le stade. C'est ce qui permet de n'afficher qu'UN seul compte à rebours
 *     dans toute l'image au lieu d'un par parcelle.
 *  2. ON NE SIGNALE QUE L'ACTIONNABLE. Une pastille veut dire « fais quelque
 *     chose » : récolter, arroser, traiter. Le reste se lit sans badge.
 *  3. LE DÉCOR EST DÉTERMINISTE. Sa disposition est semée sur `farmId` : deux
 *     fermes ne se ressemblent pas, et la même ferme est identique d'un
 *     affichage à l'autre — condition nécessaire pour que le cache d'images
 *     reste valide.
 */

export interface FarmRenderInput {
  /** Langue du spectateur. Toute chaîne dessinée en dépend. */
  locale: string;
  view: FarmView;
  player: { username: string; level: number; coins: number; gems: number; avatarUrl: string | null };
  xp: { current: number; needed: number };
  theme?: string;
  /**
   * Aperçu du cheptel en pied de page. `form`/`palette` viennent de
   * `animals.json` : sans eux, l'espèce retombe sur la silhouette générique.
   */
  animalsPreview?: Array<{
    emoji: string;
    animalKey: string;
    form?: AnimalForm | null;
    palette?: AnimalPalette | null;
  }>;
  /** Bâtiments possédés, dessinés autour du champ. */
  buildingsPreview?: Array<{ key: string; tier: number }>;
  /** Compagnon actuellement équipé (voir `game/pets.ts`), ou `null`. */
  equippedPetKey?: string | null;
}

export async function renderFarm(input: FarmRenderInput): Promise<Buffer> {
  const balance = getBalance();
  const config = balance.render.farm;
  const catalog = getConfig(input.locale);
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);

  const weather = input.view.world.weather.weather;
  const season = input.view.world.season.season;
  // Le thème acheté prime sur la saison ; sans thème, la saison décide.
  const themed = input.theme && input.theme !== 'classic' ? THEME_PALETTES[input.theme] : undefined;
  const palette = themed ?? seasonPalette(season);

  const { width: gridWidth, height: gridHeight } = input.view.grid;

  // --- Géométrie ---------------------------------------------------------
  // La marge d'herbe n'est pas décorative : c'est elle qui porte la clôture et
  // les bâtiments, et qui fait qu'un champ ressemble à un champ.
  const FENCE_MARGIN = 20;
  const GRASS_MARGIN = 96;
  const tileSize = Math.min(
    config.tileSize,
    Math.floor(
      (config.maxWidth - (FENCE_MARGIN + GRASS_MARGIN) * 2) / Math.max(1, gridWidth),
    ),
  );
  const boardWidth = gridWidth * tileSize;
  const boardHeight = gridHeight * tileSize;
  const footerHeight = 84;
  const width = Math.max(880, boardWidth + (FENCE_MARGIN + GRASS_MARGIN) * 2);
  const boardX = Math.round((width - boardWidth) / 2);
  const boardY = config.headerHeight + FENCE_MARGIN + 12;
  const height = boardY + boardHeight + FENCE_MARGIN + 26 + footerHeight;

  const { canvas, ctx } = newCanvas(width, height);
  const horizon = config.headerHeight - 10;
  const random = seededRandom(seedFrom(input.view.farmId));

  drawSky(ctx, width, horizon, palette, weather);
  drawGrass(ctx, width, horizon, height, palette);
  // Décor de saison SUR l'herbe, avant le chemin et les bâtiments qui le
  // recouvrent naturellement. Graine dérivée de la ferme mais distincte de
  // celle des bâtiments : ajouter une feuille ne doit pas déplacer la grange.
  drawSeasonalGroundDecor(ctx, {
    width,
    horizon,
    height,
    season,
    weather,
    exclusion: {
      x: boardX - FENCE_MARGIN - 14,
      y: boardY - FENCE_MARGIN - 24,
      width: boardWidth + (FENCE_MARGIN + 14) * 2,
      height: boardHeight + (FENCE_MARGIN + 14) * 2 + 10,
    },
    random: seededRandom(seedFrom(`${input.view.farmId}:decor`)),
  });
  drawPath(ctx, width, boardY + boardHeight + FENCE_MARGIN + 14);
  drawBuildings(ctx, {
    buildings: input.buildingsPreview ?? [],
    width,
    boardX,
    boardY,
    boardWidth,
    boardHeight,
    fenceMargin: FENCE_MARGIN,
    random,
  });
  drawFence(ctx, boardX, boardY, boardWidth, boardHeight, FENCE_MARGIN);

  // --- Parcelles ---------------------------------------------------------
  const soilSprite = await sprite('tiles', 'soil');
  // Un seul compte à rebours : celui qui arrive. Les vingt-quatre autres
  // n'apprenaient rien à personne et écrasaient l'image de pastilles noires.
  let nextSlot = -1;
  let soonest = Number.POSITIVE_INFINITY;
  for (const plot of input.view.plots) {
    const growth = plot.crop?.growth;
    if (!growth || growth.ready || growth.withered) continue;
    if (growth.msRemaining < soonest) {
      soonest = growth.msRemaining;
      nextSlot = plot.slot;
    }
  }

  for (const plot of input.view.plots) {
    if (plot.x >= gridWidth || plot.y >= gridHeight) continue;
    const x = boardX + plot.x * tileSize + 3;
    const y = boardY + plot.y * tileSize + 3;
    const size = tileSize - 6;

    if (plot.state === 'locked') {
      drawLockedTile(ctx, x, y, size);
      continue;
    }

    if (soilSprite) {
      ctx.drawImage(soilSprite, x, y, size, size);
    } else {
      drawBed(ctx, x, y, size, {
        fertility: plot.fertility,
        wet: weather === 'rainy' || weather === 'storm',
      });
    }
    // Sol épuisé : la fertilité pilote déjà la teinte de la planche, mais un
    // dégradé continu ne se lit pas d'un coup d'œil. Sous le seuil où le jeu
    // pénalise le rendement, la terre pâlit et se craquelle — c'est à ce
    // moment-là que laisser la parcelle en jachère devient une décision.
    if (plot.fertility < balance.fertility.lowThreshold) {
      drawDepletedSoil(ctx, x, y, size, plot.slot);
    }

    if (plot.crop) {
      const stageIndex = STAGE_INDEX[plot.crop.growth.stage] ?? 1;
      const cropSprite = await sprite('crops', `${plot.crop.key}_${stageIndex}`);
      if (cropSprite) {
        ctx.drawImage(cropSprite, x, y, size, size);
      } else {
        drawPlotCrop(ctx, {
          x,
          y,
          size,
          stage: stageIndex,
          skin: cropSkin(catalog.crops.get(plot.crop.key)),
          ready: plot.crop.growth.ready,
          withered: plot.crop.growth.withered,
          seed: plot.slot,
          mutation: plot.crop.mutation,
        });
      }

      // Badges : uniquement ce sur quoi le joueur peut agir.
      if (plot.crop.growth.ready) {
        drawBadge(ctx, x + size * 0.82, y + size * 0.18, size * 0.28, 'ready', PALETTE.success);
      } else if (!plot.crop.growth.withered) {
        // La silhouette porte déjà le stade : l'anneau ne sert qu'à signaler
        // l'imminence, au moment où l'information devient actionnable.
        if (plot.crop.growth.progress > 0.62) {
          drawProgressRing(ctx, x, y, size, plot.crop.growth.progress);
        }
        if (plot.crop.growth.needsWater) {
          drawBadge(ctx, x + size * 0.18, y + size * 0.18, size * 0.28, 'water', PALETTE.water);
        }
      }
      if (plot.pestType) {
        drawBadge(ctx, x + size * 0.18, y + size * 0.5, size * 0.28, 'pest', PALETTE.danger);
      }
      if (plot.crop.mutation !== 'none') {
        drawBadge(ctx, x + size * 0.82, y + size * 0.5, size * 0.26, 'mutation', '#8e7cff');
      }

      if (plot.slot === nextSlot) {
        drawCountdown(ctx, x, y, size, formatDuration(plot.crop.growth.msRemaining, locale));
      }
    } else {
      // Une parcelle libre doit se lire comme une INVITATION, pas comme un trou.
      drawEmptyPlot(ctx, x, y, size, plot.weedLevel > 30);
    }

    ctx.font = font(Math.max(9, Math.round(tileSize * 0.12)), 'bold');
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(String(plot.slot), x + 6, y + 5);
  }

  // La météo passe au-dessus du champ, mais DERRIÈRE les panneaux : du texte
  // strié de pluie serait illisible.
  drawWeatherOverlay(ctx, width, height, weather);

  // --- En-tête -----------------------------------------------------------
  withDropShadow(ctx, () =>
    fillRoundRect(ctx, config.padding, 14, width - config.padding * 2, config.headerHeight - 34, 18, 'rgba(20,24,33,0.82)'),
  );

  const avatarSize = 68;
  await drawAvatar(ctx, input.player.avatarUrl, config.padding + 16, 26, avatarSize);

  // Compagnon équipé : badge rond superposé au coin bas-droit de l'avatar,
  // comme une pastille de statut plutôt qu'une case séparée dans l'en-tête.
  if (input.equippedPetKey) {
    const petSprite = await sprite('pets', input.equippedPetKey);
    const badgeRadius = 20;
    const badgeX = config.padding + 16 + avatarSize - 10;
    const badgeY = 26 + avatarSize - 10;

    withDropShadow(
      ctx,
      () => {
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeRadius + 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,24,33,0.9)';
        ctx.fill();
      },
      { blur: 8, offsetY: 3 },
    );

    if (petSprite) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(petSprite, badgeX - badgeRadius, badgeY - badgeRadius, badgeRadius * 2, badgeRadius * 2);
      ctx.restore();
    } else {
      drawPetIcon(ctx, badgeX, badgeY, badgeRadius, input.equippedPetKey);
    }

    ctx.beginPath();
    ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const textX = config.padding + 16 + avatarSize + 18;
  const infoX = width - config.padding - 262;
  ctx.fillStyle = PALETTE.text;
  // Le nom n'est plus tronqué : la taille s'adapte, et le clip ne sert que de
  // dernier recours. Un joueur qui prend la peine de nommer sa ferme doit la
  // voir en entier.
  const nameWidth = infoX - textX - 24;
  ctx.font = fitFont(ctx, input.view.name, nameWidth, [30, 27, 24, 21, 18, 16]);
  ctx.fillText(clipText(ctx, input.view.name, nameWidth), textX, 30);

  ctx.font = font(18);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    `${input.player.username} · ${t('render.farm.level', { level: input.player.level })}`,
    textX,
    66,
  );

  progressBar(ctx, {
    x: textX,
    y: 92,
    width: 240,
    height: 14,
    ratio: input.xp.needed > 0 ? input.xp.current / input.xp.needed : 1,
    fill: PALETTE.xp,
  });
  ctx.font = font(13);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    input.xp.needed > 0
      ? t('render.profile.xp', {
          current: formatCompact(input.xp.current, locale),
          needed: formatCompact(input.xp.needed, locale),
        })
      : t('render.farm.max_level'),
    textX + 252,
    92,
  );

  // Bloc météo / saison / monnaies, aligné à droite
  drawWeatherIcon(ctx, infoX, 22, 40, weather);
  ctx.font = font(16, 'bold');
  ctx.fillStyle = PALETTE.text;
  // Le libellé de `balance.json` est français : on passe par la clé i18n, et on
  // ne retombe sur la config que si la clé n'existe pas.
  const weatherKey = `world.weather.${weather}`;
  const weatherLabel = t(weatherKey);
  ctx.fillText(weatherLabel === weatherKey ? input.view.world.weather.label : weatherLabel, infoX + 46, 30);
  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    `${t(`world.season.${season}`)} · ${input.view.world.weather.temperature} °C`,
    infoX + 46,
    52,
  );
  // Monnaies : pièce et gemme dessinées, pour ne dépendre d'aucune police emoji.
  drawCoin(ctx, infoX + 8, 92, 9);
  ctx.font = font(17, 'bold');
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText(formatCompact(input.player.coins, locale), infoX + 24, 84);
  drawGem(ctx, infoX + 138, 92, 9);
  ctx.fillStyle = '#7fd8ff';
  ctx.fillText(formatCompact(input.player.gems, locale), infoX + 154, 84);

  // --- Pied de page ------------------------------------------------------
  const footerY = height - footerHeight + 6;
  withDropShadow(ctx, () =>
    fillRoundRect(ctx, config.padding, footerY, width - config.padding * 2, footerHeight - 24, 14, 'rgba(20,24,33,0.82)'),
  );

  const counts = input.view.counts;
  ctx.font = font(16, 'bold');
  ctx.fillStyle = PALETTE.text;
  const summary = t('render.farm.summary', {
    ready: counts.ready,
    growing: counts.growing,
    empty: counts.empty,
    locked: counts.locked,
  });
  ctx.fillText(
    clipText(ctx, summary, width - config.padding * 2 - 32 - (input.animalsPreview?.length ?? 0) * 34),
    config.padding + 16,
    footerY + 12,
  );

  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  const nextLabel = input.view.nextReadyAt
    ? t('render.farm.next_harvest', {
        duration: formatDuration(input.view.nextReadyAt.getTime() - Date.now(), locale),
      })
    : counts.ready > 0
      ? t('render.farm.harvest_waiting')
      : t('render.farm.nothing_planted');
  ctx.fillText(nextLabel, config.padding + 16, footerY + 36);

  // Aperçu du cheptel, à droite du pied de page
  if (input.animalsPreview && input.animalsPreview.length > 0) {
    const previewX = width - config.padding - 16 - input.animalsPreview.length * 34;
    for (const [index, animal] of input.animalsPreview.slice(0, 6).entries()) {
      const animalSprite = await sprite('animals', animal.animalKey);
      const ax = previewX + index * 34;
      if (animalSprite) {
        ctx.drawImage(animalSprite, ax, footerY + 12, 30, 30);
      } else if (animal.form && animal.palette) {
        // La même silhouette que dans `/animals`, semée sur la clé d'espèce
        // pour que deux poules côte à côte ne soient pas superposables.
        drawAnimalForm(ctx, {
          x: ax,
          y: footerY + 6,
          size: 34,
          form: animal.form,
          palette: animal.palette,
          seed: seedFrom(animal.animalKey) + index,
        });
      } else {
        drawAnimal(ctx, { x: ax, y: footerY + 6, size: 34, color: '#e8d8b7', emoji: animal.emoji });
      }
    }
  }

  return encode(canvas);
}

/** Une parcelle dont la présence de culture est établie : évite les `?.` en cascade. */
type PlantedPlot = PlotView & { crop: NonNullable<PlotView['crop']> };

/** Au-delà, une liste de parcelles n'apprend plus rien et mange le budget de Discord. */
const MAX_LISTED_PLOTS = 8;

/**
 * Texte alternatif de l'image de ferme, pour les lecteurs d'écran.
 *
 * Même source que le dessin — `FarmView` — et aucune horloge : la prochaine
 * récolte se lit dans `msRemaining`, déjà calculé par le service à l'instant
 * de la vue, jamais dans `Date.now()`. La description est donc reproductible,
 * ce qui la rend testable et lui permet d'accompagner aussi une image servie
 * depuis le cache.
 *
 * On ne décrit pas les parcelles une à une : on dit ce que l'image met en
 * avant — l'état d'ensemble, puis ce qui appelle une action (récolter,
 * arroser, traiter) — dans la limite des 1 024 caractères de Discord.
 */
export function describeFarm(input: FarmRenderInput): string {
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);
  const view = input.view;
  const counts = view.counts;

  // Même repli que le dessin : la clé i18n d'abord, le libellé (français) de
  // la configuration seulement si la météo est inconnue du catalogue.
  const weatherKey = `world.weather.${view.world.weather.weather}`;
  const weatherLabel = t(weatherKey);

  const planted = view.plots.filter((plot): plot is PlantedPlot => plot.crop !== undefined);
  const plotLabel = (plot: PlantedPlot): string =>
    t('render_alt.farm.plot', { slot: plot.slot, crop: plot.crop.name });
  const pestLabel = (plot: PlantedPlot): string =>
    t('render_alt.farm.plot_pest', {
      slot: plot.slot,
      crop: plot.crop.name,
      pest: t(`farm.pest_${String(plot.pestType)}`),
    });
  const mutationLabel = (plot: PlantedPlot): string =>
    t('render_alt.farm.plot_mutation', {
      slot: plot.slot,
      crop: plot.crop.name,
      mutation: t(`render_alt.farm.mutation.${plot.crop.mutation}`),
    });
  // Le sol épuisé se voit désormais sur l'image (terre pâle et craquelée) :
  // il doit s'entendre aussi. Parcelles ouvertes uniquement — une parcelle
  // verrouillée n'a pas de sol à ménager.
  const depleted = view.plots.filter(
    (plot) => plot.state !== 'locked' && plot.fertility < getBalance().fertility.lowThreshold,
  );
  const more = (rest: number): string => t('render_alt.farm.more', { count: rest });
  const listed = (
    plots: PlantedPlot[],
    key: string,
    label: (plot: PlantedPlot) => string = plotLabel,
  ): string | null =>
    plots.length > 0 ? t(key, { plots: listSome(plots.map(label), MAX_LISTED_PLOTS, more) }) : null;

  // Le même compte à rebours que celui dessiné : la culture qui arrive en premier.
  let next: PlantedPlot | undefined;
  for (const plot of planted) {
    const growth = plot.crop.growth;
    if (growth.ready || growth.withered) continue;
    if (!next || growth.msRemaining < next.crop.growth.msRemaining) next = plot;
  }
  const nextLabel = next
    ? t('render_alt.farm.next_harvest', {
        duration: formatDuration(next.crop.growth.msRemaining, locale),
        slot: next.slot,
        crop: next.crop.name,
      })
    : counts.ready > 0
      ? t('render_alt.farm.harvest_waiting')
      : t('render_alt.farm.nothing_planted');

  const animals = input.animalsPreview?.length ?? 0;
  const buildings = input.buildingsPreview?.length ?? 0;

  return clampAltText(
    joinSentences([
      t('render_alt.farm.header', {
        name: view.name,
        username: input.player.username,
        level: input.player.level,
      }),
      input.xp.needed > 0
        ? t('render_alt.farm.xp', {
            current: formatNumber(input.xp.current, locale),
            needed: formatNumber(input.xp.needed, locale),
          })
        : t('render_alt.farm.max_level'),
      t('render_alt.farm.world', {
        season: t(`world.season.${view.world.season.season}`),
        weather: weatherLabel === weatherKey ? view.world.weather.label : weatherLabel,
        temperature: view.world.weather.temperature,
      }),
      t('render_alt.farm.wallet', {
        coins: formatNumber(input.player.coins, locale),
        gems: formatNumber(input.player.gems, locale),
      }),
      t('render_alt.farm.grid', {
        width: view.grid.width,
        height: view.grid.height,
        ready: counts.ready,
        growing: counts.growing,
        empty: counts.empty,
        locked: counts.locked,
      }),
      counts.withered > 0 ? t('render_alt.farm.withered', { count: counts.withered }) : null,
      nextLabel,
      listed(planted.filter((plot) => plot.crop.growth.ready), 'render_alt.farm.ready_list'),
      listed(
        planted.filter((plot) => {
          const growth = plot.crop.growth;
          return growth.needsWater && !growth.ready && !growth.withered;
        }),
        'render_alt.farm.water_list',
      ),
      listed(planted.filter((plot) => plot.pestType !== null), 'render_alt.farm.pest_list', pestLabel),
      listed(planted.filter((plot) => plot.crop.growth.withered), 'render_alt.farm.withered_list'),
      listed(
        planted.filter((plot) => plot.crop.mutation !== 'none' && !plot.crop.growth.withered),
        'render_alt.farm.mutation_list',
        mutationLabel,
      ),
      depleted.length > 0
        ? t('render_alt.farm.depleted_list', {
            plots: listSome(
              depleted.map((plot) => t('render_alt.farm.plot_bare', { slot: plot.slot })),
              MAX_LISTED_PLOTS,
              more,
            ),
          })
        : null,
      animals > 0 ? t('render_alt.farm.animals', { count: animals }) : null,
      buildings > 0 ? t('render_alt.farm.buildings', { count: buildings }) : null,
      input.equippedPetKey
        ? t('render_alt.farm.pet', { pet: t(`pets.catalog.${input.equippedPetKey}.title`) })
        : null,
    ]),
  );
}

const STAGE_INDEX: Record<string, number> = {
  planted: 1,
  sprouting: 2,
  growing: 3,
  maturing: 4,
  ready: 5,
  withered: 5,
};

// ---------------------------------------------------------------------------
// DÉCOR
// ---------------------------------------------------------------------------

function drawPath(ctx: SKRSContext2D, width: number, y: number): void {
  ctx.fillStyle = 'rgba(150,120,84,0.5)';
  ctx.fillRect(0, y, width, 22);
  ctx.fillStyle = 'rgba(120,95,64,0.32)';
  ctx.fillRect(0, y, width, 4);
}

/** Clôture en bois : c'est elle qui dit « ferme » d'un coup d'œil. */
function drawFence(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  boardWidth: number,
  boardHeight: number,
  margin: number,
): void {
  const post = '#a5825a';
  const postDark = '#7a5c3c';
  const rail = '#b08e63';
  const left = x - margin;
  const right = x + boardWidth + margin;
  const top = y - margin;
  const bottom = y + boardHeight + margin;

  const horizontalRail = (py: number): void => {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(left - 6, py + 4, right - left + 12, 5);
    ctx.fillStyle = rail;
    ctx.fillRect(left - 6, py, right - left + 12, 5);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(left - 6, py, right - left + 12, 1.5);
  };
  const verticalRail = (px: number): void => {
    ctx.fillStyle = rail;
    ctx.fillRect(px, top - 6, 5, bottom - top + 12);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(px, top - 6, 1.5, bottom - top + 12);
  };

  horizontalRail(top - 10);
  horizontalRail(top + 2);
  horizontalRail(bottom - 10);
  horizontalRail(bottom + 2);
  verticalRail(left - 4);
  verticalRail(left + 8);
  verticalRail(right - 4);
  verticalRail(right + 8);

  const drawPost = (px: number, py: number): void => {
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(px + 2, py + 3, 9, 32);
    ctx.fillStyle = postDark;
    ctx.fillRect(px, py, 9, 32);
    ctx.fillStyle = post;
    ctx.fillRect(px, py, 5, 32);
  };
  for (let px = left - 6; px <= right + 6; px += 58) {
    drawPost(px, top - 18);
    drawPost(px, bottom - 14);
  }
  for (let py = top + 22; py < bottom - 20; py += 62) {
    drawPost(left - 8, py);
    drawPost(right - 2, py);
  }
}

// ---------------------------------------------------------------------------
// BÂTIMENTS — ce que le joueur a construit, enfin visible
// ---------------------------------------------------------------------------

function drawBuildings(
  ctx: SKRSContext2D,
  options: {
    buildings: Array<{ key: string; tier: number }>;
    width: number;
    boardX: number;
    boardY: number;
    boardWidth: number;
    boardHeight: number;
    fenceMargin: number;
    random: () => number;
  },
): void {
  if (options.buildings.length === 0) return;

  // Largeur d'herbe réellement disponible de chaque côté de la clôture. Une
  // grille 8×8 la réduit fortement : mieux vaut un bâtiment plus petit qu'un
  // bâtiment coupé par le bord de l'image.
  const EDGE = 12;
  const leftSpace = options.boardX - options.fenceMargin - EDGE * 2;
  const rightSpace =
    options.width - (options.boardX + options.boardWidth + options.fenceMargin) - EDGE * 2;
  const space = Math.min(leftSpace, rightSpace);
  if (space < 44) return;

  const rows = Math.max(2, Math.floor(options.boardHeight / 150));
  const slots: Array<{ center: number; y: number }> = [];
  const leftCenter = EDGE + leftSpace / 2;
  const rightCenter = options.width - EDGE - rightSpace / 2;
  for (let row = 0; row < rows; row += 1) {
    const y = options.boardY + 40 + (options.boardHeight / rows) * row;
    slots.push({ center: leftCenter, y });
    slots.push({ center: rightCenter, y });
  }

  for (const [index, building] of options.buildings.slice(0, slots.length).entries()) {
    const slot = slots[index]!;
    const size = Math.min(space, 52 + Math.min(3, building.tier) * 6);
    // Décalage semé, borné pour que le bâtiment reste entièrement visible.
    const room = Math.max(0, (space - size) / 2);
    const jitter = (options.random() - 0.5) * Math.min(20, room * 2);
    const jitterY = (options.random() - 0.5) * 18;
    drawBuilding(ctx, building.key, slot.center - size / 2 + jitter, slot.y + jitterY, size);
  }
}

// ---------------------------------------------------------------------------
// INDICATEURS DE TUILE
// ---------------------------------------------------------------------------

/** Anneau de progression : un seul geste de lecture, pas une ligne de texte. */
function drawProgressRing(ctx: SKRSContext2D, x: number, y: number, size: number, ratio: number): void {
  const radius = size * 0.11;
  const cx = x + size - radius - size * 0.06;
  const cy = y + radius + size * 0.06;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = size * 0.045;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, Math.max(0, ratio)));
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawCountdown(ctx: SKRSContext2D, x: number, y: number, size: number, label: string): void {
  ctx.font = font(Math.max(11, Math.round(size * 0.14)), 'bold');
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + 16;
  const boxHeight = size * 0.2;
  fillRoundRect(ctx, x + (size - boxWidth) / 2, y + size * 0.72, boxWidth, boxHeight, boxHeight / 2, 'rgba(20,24,33,0.86)');
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText(label, x + (size - textWidth) / 2, y + size * 0.72 + boxHeight * 0.16);
}

/**
 * Sol épuisé (fertilité sous `balance.fertility.lowThreshold`) : voile pâle
 * et craquelures. Les fissures sont semées sur le numéro de parcelle, pas sur
 * la fertilité exacte — une parcelle qui passe de 12 à 11 % ne doit pas
 * changer de dessin, seulement de teinte (ce que `drawBed` fait déjà).
 */
function drawDepletedSoil(ctx: SKRSContext2D, x: number, y: number, size: number, seed: number): void {
  const topHeight = size * 0.9;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, topHeight);
  ctx.clip();

  ctx.fillStyle = 'rgba(232,218,190,0.30)';
  ctx.fillRect(x, y, size, topHeight);

  const random = seededRandom(seed * 7919 + 17);
  ctx.strokeStyle = 'rgba(70,45,25,0.36)';
  ctx.lineWidth = Math.max(1.2, size / 60);
  ctx.lineCap = 'round';
  // Quatre fissures principales, chacune ramifiée une fois : assez pour lire
  // « terre sèche », pas assez pour cacher la plante.
  for (let crack = 0; crack < 4; crack += 1) {
    let px = x + size * (0.12 + random() * 0.76);
    let py = y + topHeight * (0.1 + random() * 0.8);
    ctx.beginPath();
    ctx.moveTo(px, py);
    const segments = 3 + Math.floor(random() * 3);
    let angle = random() * Math.PI * 2;
    for (let segment = 0; segment < segments; segment += 1) {
      angle += (random() - 0.5) * 1.4;
      const length = size * (0.07 + random() * 0.08);
      px += Math.cos(angle) * length;
      py += Math.sin(angle) * length;
      ctx.lineTo(px, py);
      if (segment === 1) {
        // Ramification courte, en angle franc.
        const branch = angle + (random() > 0.5 ? 1 : -1) * (0.9 + random() * 0.5);
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(branch) * size * 0.08, py + Math.sin(branch) * size * 0.08);
        ctx.moveTo(px, py);
      }
    }
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.restore();
}

/**
 * Culture d'une parcelle, avec sa MUTATION rendue visible.
 *
 * Le badge violet disait « mutée » sans dire laquelle ; or les trois mutations
 * du moteur (`game/quality.ts`) n'ont ni la même valeur ni la même rareté. On
 * leur donne une apparence propre, lisible à la taille d'une tuile :
 *  - `giant` : la plante est dessinée un quart plus grande, débordant vers le
 *    haut — jamais sur les voisines, grâce au clip latéral ;
 *  - `rainbow` : liseré irisé autour de la silhouette ;
 *  - `ancient` : teinte sépia dorée et halo chaud, comme une relique.
 * Les deux dernières passent par une toile hors écran : c'est ce qui permet
 * de traiter n'importe quelle silhouette sans toucher à `drawCrop`.
 */
function drawPlotCrop(
  ctx: SKRSContext2D,
  options: {
    x: number;
    y: number;
    size: number;
    stage: number;
    skin: ReturnType<typeof cropSkin>;
    ready: boolean;
    withered: boolean;
    seed: number;
    mutation: string;
  },
): void {
  const { x, y, size } = options;
  const giant = options.mutation === 'giant' && !options.withered;
  // Une plante peut dépasser vers le HAUT — c'est naturel — mais jamais sur
  // les parcelles voisines : sans ce clip, un caféier mûr en mange trois.
  const overflowTop = size * (giant ? 0.5 : 0.3);
  const clip = { x: x - 1, y: y - overflowTop, width: size + 2, height: size + overflowTop };

  // Géante : même ligne de base (la plante reste plantée dans SA planche),
  // taille × 1,25, donc décalée vers le haut et centrée sur la tuile.
  const drawSize = giant ? size * 1.25 : size;
  const drawX = x - (drawSize - size) / 2;
  const drawY = y - (drawSize - size) * 0.8;
  const cropOptions = {
    x: drawX,
    y: drawY,
    size: drawSize,
    stage: options.stage,
    skin: options.skin,
    ready: options.ready,
    withered: options.withered,
    seed: options.seed,
  };

  const decorated =
    !options.withered && (options.mutation === 'rainbow' || options.mutation === 'ancient');
  if (!decorated) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.width, clip.height);
    ctx.clip();
    drawCrop(ctx, cropOptions);
    ctx.restore();
    return;
  }

  // Toile hors écran de la taille du clip : la plante y est dessinée avec le
  // même décalage, puis habillée et recopiée d'un bloc.
  const layer = offscreen(clip.width, clip.height);
  drawCrop(layer.ctx, { ...cropOptions, x: drawX - clip.x, y: drawY - clip.y });

  if (options.mutation === 'ancient') {
    const glow = ctx.createRadialGradient(
      x + size / 2, y + size * 0.62, size * 0.05,
      x + size / 2, y + size * 0.62, size * 0.5,
    );
    glow.addColorStop(0, 'rgba(255,214,120,0.45)');
    glow.addColorStop(1, 'rgba(255,214,120,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(clip.x, clip.y, clip.width, clip.height);
    tintCanvas(layer.canvas, 'rgba(184,140,58,0.48)');
    ctx.drawImage(layer.canvas, clip.x, clip.y);
    return;
  }

  // Irisé : un contour fin aux couleurs de l'arc-en-ciel, sous la plante.
  const halo = outlineCanvas(layer.canvas, Math.max(2, size * 0.035), rainbowGradient);
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.drawImage(halo, clip.x, clip.y);
  ctx.restore();
  ctx.drawImage(layer.canvas, clip.x, clip.y);
}

/**
 * Décor de saison posé sur l'herbe : fleurs au printemps, feuilles mortes en
 * automne, neige au sol en hiver, herbe jaunie en canicule. Rien n'est dessiné
 * dans la zone du champ (`exclusion`), qui doit rester lisible, ni sous
 * l'horizon (ciel). Tout est semé sur `random`, donc reproductible.
 */
function drawSeasonalGroundDecor(
  ctx: SKRSContext2D,
  options: {
    width: number;
    horizon: number;
    height: number;
    season: string;
    weather: string;
    exclusion: { x: number; y: number; width: number; height: number };
    random: () => number;
  },
): void {
  const { random, exclusion } = options;
  const top = options.horizon + 4;
  const bottom = options.height - 70;
  if (bottom <= top) return;

  // Tirage d'un point sur l'herbe, hors du champ. Le rejet est borné : sur une
  // grille 8×8, le champ occupe presque toute la largeur.
  const spot = (): { x: number; y: number } | null => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const px = 8 + random() * (options.width - 16);
      const py = top + random() * (bottom - top);
      const inside =
        px > exclusion.x &&
        px < exclusion.x + exclusion.width &&
        py > exclusion.y &&
        py < exclusion.y + exclusion.height;
      if (!inside) return { x: px, y: py };
    }
    return null;
  };

  if (options.weather === 'heatwave') {
    // Herbe jaunie : voile paille sur toute la bande, puis brins secs. La
    // canicule coûte des récoltes ; le sol doit le dire avant le voile chaud.
    ctx.fillStyle = 'rgba(214,186,72,0.30)';
    ctx.fillRect(0, options.horizon - 10, options.width, options.height - options.horizon + 10);
    ctx.strokeStyle = 'rgba(120,90,30,0.28)';
    ctx.lineWidth = 1.4;
    for (let index = 0; index < 90; index += 1) {
      const point = spot();
      if (!point) continue;
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x + 2.5, point.y - 6);
      ctx.moveTo(point.x + 1, point.y);
      ctx.lineTo(point.x - 2, point.y - 5);
      ctx.stroke();
    }
  }

  switch (options.season) {
    case 'spring': {
      // Petites fleurs : cinq pétales et un cœur, trois teintes.
      const petals = ['#fff5f8', '#ffd6e7', '#fff2a8'];
      for (let index = 0; index < 34; index += 1) {
        const point = spot();
        if (!point) continue;
        const radius = 2 + random() * 1.6;
        ctx.fillStyle = petals[Math.floor(random() * petals.length)]!;
        for (let petal = 0; petal < 5; petal += 1) {
          const angle = (petal / 5) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(point.x + Math.cos(angle) * radius, point.y + Math.sin(angle) * radius, radius * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#f2b632';
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    case 'autumn': {
      // Feuilles mortes : ellipses orientées au hasard, nervure centrale.
      const tones = ['#d9782a', '#c0451f', '#e0a83a', '#8f5a2b'];
      for (let index = 0; index < 46; index += 1) {
        const point = spot();
        if (!point) continue;
        const length = 5 + random() * 4;
        const angle = random() * Math.PI;
        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.rotate(angle);
        ctx.fillStyle = tones[Math.floor(random() * tones.length)]!;
        ctx.beginPath();
        ctx.ellipse(0, 0, length, length * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(60,30,10,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-length * 0.8, 0);
        ctx.lineTo(length * 0.8, 0);
        ctx.stroke();
        ctx.restore();
      }
      return;
    }
    case 'winter': {
      // Neige au sol : plaques floues et flocons posés. Distinct de la neige
      // qui TOMBE (voile météo) : ici, elle reste même par temps clair.
      for (let index = 0; index < 14; index += 1) {
        const point = spot();
        if (!point) continue;
        const radius = 14 + random() * 22;
        const patch = ctx.createRadialGradient(point.x, point.y, 1, point.x, point.y, radius);
        patch.addColorStop(0, 'rgba(255,255,255,0.55)');
        patch.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = patch;
        ctx.beginPath();
        ctx.ellipse(point.x, point.y, radius, radius * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let index = 0; index < 70; index += 1) {
        const point = spot();
        if (!point) continue;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 1 + random() * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    default:
      return;
  }
}

function drawEmptyPlot(ctx: SKRSContext2D, x: number, y: number, size: number, weedy: boolean): void {
  if (weedy) {
    drawBadge(ctx, x + size * 0.5, y + size * 0.46, size * 0.32, 'weeds', PALETTE.grassDark);
    return;
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = Math.max(1.5, size / 48);
  ctx.setLineDash([size / 16, size / 16]);
  const inset = size * 0.26;
  ctx.strokeRect(x + inset, y + inset * 0.8, size - inset * 2, size * 0.9 - inset * 1.6);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = font(Math.round(size * 0.2), 'bold');
  const plus = '+';
  ctx.fillText(plus, x + size / 2 - ctx.measureText(plus).width / 2, y + size * 0.34);
}
