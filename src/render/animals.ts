import { balance as getBalance } from '../config';
import type { AnimalForm, AnimalPalette, AnimalVariant } from '../config/gameplay/schemas';
import { translate } from '../i18n';
import { clampAltText, joinSentences, listSome } from './alt-text';
import {
  PALETTE,
  clipText,
  drawableText,
  encode,
  fillRoundRect,
  fitFont,
  font,
  lighten,
  newCanvas,
  roundRect,
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
  drawAnimal,
  drawAnimalForm,
  drawBadge,
  drawVariantMark,
  drawWeatherIcon,
  sprite,
} from './sprites';
import type { SKRSContext2D } from '@napi-rs/canvas';

/**
 * Basse-cour de `/animals` : un enclos par bâtiment d'élevage, sous le même
 * ciel que le champ, avec chaque bête dessinée selon sa silhouette d'espèce.
 *
 * Trois principes, hérités de la vue de ferme :
 *  1. LA SILHOUETTE PORTE L'ESPÈCE. Une poule n'est pas une vache : pas besoin
 *     d'un libellé par bête pour savoir ce qu'on regarde, le nom n'est écrit
 *     que quand la place le permet.
 *  2. ON NE SIGNALE QUE L'ACTIONNABLE. Une pastille veut dire « fais quelque
 *     chose » : nourrir, collecter, soigner, caresser. Une bête heureuse et
 *     repue n'a rien sur elle — elle dort.
 *  3. LE DÉCOR EST DÉTERMINISTE. Les positions dans l'enclos sont semées sur
 *     l'identifiant de ferme : la même basse-cour est identique d'un affichage
 *     à l'autre, condition pour que le cache d'images reste valide.
 *
 * L'entrée est un objet SIMPLE (chaînes, nombres, booléens, tableaux) : elle
 * traverse `postMessage` vers le worker de rendu sans rien perdre.
 */

export interface AnimalsRenderBuilding {
  key: string;
  name: string;
  tier: number;
  capacity: number;
  used: number;
}

export interface AnimalsRenderAnimal {
  id: string;
  animalKey: string;
  name: string;
  nickname: string | null;
  emoji: string;
  /** Silhouette et palette de `animals.json` ; `null` → silhouette générique. */
  form: AnimalForm | null;
  palette: AnimalPalette | null;
  /**
   * Variante (`shiny`, `golden`) ; absente → `normal`. Immuable pour une bête
   * donnée : l'identifiant, déjà dans la clé de cache, suffit à distinguer
   * l'image d'une shiny de celle d'une ordinaire.
   */
  variant?: AnimalVariant;
  buildingKey: string;
  hunger: number;
  happiness: number;
  health: number;
  hungry: boolean;
  sick: boolean;
  canCollect: boolean;
  canFeed: boolean;
  canPet: boolean;
  readyProduction: number;
  productEmoji: string;
}

export interface AnimalsRenderInput {
  /** Langue du spectateur. Toute chaîne dessinée en dépend. */
  locale: string;
  /** Graine de la disposition : deux fermes ne rangent pas leurs bêtes pareil. */
  farmId: string;
  /** Propriétaire du cheptel, dans le titre. */
  ownerName: string;
  season: string;
  weather: string;
  /** Bâtiments d'élevage possédés, dans l'ordre d'affichage. */
  buildings: AnimalsRenderBuilding[];
  animals: AnimalsRenderAnimal[];
  totals: { alive: number; hungry: number; sick: number; ready: number };
}

/**
 * Au-delà, l'image devient un tableau de timbres : les bêtes restantes sont
 * comptées dans un « +N » et listées par le texte de l'embed.
 */
export const MAX_VISIBLE_ANIMALS = 24;

/**
 * Sous ce bonheur, une caresse fait une vraie différence : c'est là qu'on la
 * signale. Au-dessus, `canPet` reste vrai la moitié de la journée pour toute
 * la basse-cour, et un cœur sur chaque bête n'apprendrait rien à personne.
 */
const PET_HAPPINESS_THRESHOLD = 70;

/** Indicateurs dessinés sur une bête : les mêmes pour l'image, son cache et son texte alternatif. */
export interface AnimalIndicators {
  ready: boolean;
  feed: boolean;
  sick: boolean;
  pet: boolean;
  /** Rien à faire et bonheur élevé : la bête dort, sans pastille. */
  sleeping: boolean;
}

export function animalIndicators(animal: AnimalsRenderAnimal): AnimalIndicators {
  const ready = animal.canCollect;
  const feed = animal.hungry && animal.canFeed;
  const sick = animal.sick;
  const pet = animal.canPet && animal.happiness < PET_HAPPINESS_THRESHOLD;
  return {
    ready,
    feed,
    sick,
    pet,
    sleeping: !ready && !feed && !sick && !pet && animal.happiness >= 85 && !animal.hungry,
  };
}

/** Sol de chaque enclos : la paille du poulailler, la terre de l'étable, l'herbe ailleurs. */
const PEN_GROUNDS: Record<string, { fill: string; dark: string }> = {
  coop: { fill: '#d9c48a', dark: '#b9a466' },
  barn: { fill: '#a88458', dark: '#86683f' },
  mythic_pen: { fill: '#5e4d80', dark: '#473a63' },
};

export async function renderAnimals(input: AnimalsRenderInput): Promise<Buffer> {
  const dims = getBalance().render.animals;
  const width = dims.width;
  const height = dims.height;
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);
  const palette = seasonPalette(input.season);
  const random = seededRandom(seedFrom(input.farmId));

  const { canvas, ctx } = newCanvas(width, height);

  // --- Géométrie ---------------------------------------------------------
  const horizon = 110;
  const headerY = 12;
  const headerHeight = 58;
  const footerHeight = 52;
  const footerY = height - footerHeight - 12;
  const pensTop = horizon + 14;
  const pensBottom = footerY - 14;
  const margin = 24;
  const gap = 14;

  drawSky(ctx, width, horizon, palette, input.weather);
  drawGrass(ctx, width, horizon, height, palette);

  // --- Enclos ------------------------------------------------------------
  const cells = layoutPens(input.buildings.length, {
    x: margin,
    y: pensTop,
    width: width - margin * 2,
    height: pensBottom - pensTop,
    gap,
  });

  if (input.buildings.length === 0) {
    drawSignpost(ctx, width / 2, pensTop + (pensBottom - pensTop) / 2, t('render.animals.no_building'));
  }

  let remaining = MAX_VISIBLE_ANIMALS;
  for (const [index, building] of input.buildings.entries()) {
    const cell = cells[index];
    if (!cell) break;
    const residents = input.animals
      .filter((animal) => animal.buildingKey === building.key)
      // Tri stable sur l'identifiant : l'ordre de la base peut varier, pas l'image.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const shown = await drawPen(ctx, {
      building,
      residents,
      cell,
      palette,
      random,
      budget: remaining,
      t,
    });
    remaining -= shown;
  }

  // La météo passe au-dessus des enclos mais DERRIÈRE les panneaux : du texte
  // strié de pluie serait illisible.
  drawWeatherOverlay(ctx, width, height, input.weather);

  // --- En-tête -----------------------------------------------------------
  withDropShadow(ctx, () =>
    fillRoundRect(ctx, 16, headerY, width - 32, headerHeight, 14, 'rgba(20,24,33,0.82)'),
  );
  drawWeatherIcon(ctx, 30, headerY + 8, 40, input.weather);
  const weatherKey = `world.weather.${input.weather}`;
  const weatherLabel = t(weatherKey);
  const title = drawableText(t('render.animals.title', { name: input.ownerName }));
  const capacity = input.buildings.reduce((sum, building) => sum + building.capacity, 0);
  const used = input.buildings.reduce((sum, building) => sum + building.used, 0);
  // Sans bâtiment, « 0 / 0 places » n'informe de rien : le panneau au centre s'en charge.
  const capacityLabel = input.buildings.length > 0 ? t('render.animals.capacity', { used, capacity }) : '';
  ctx.font = font(14);
  const capacityWidth = ctx.measureText(capacityLabel).width;
  const titleWidth = width - 32 - 80 - capacityWidth - 40;
  ctx.fillStyle = PALETTE.text;
  ctx.font = fitFont(ctx, title, titleWidth, [22, 20, 18, 16]);
  ctx.fillText(clipText(ctx, title, titleWidth), 80, headerY + 10);
  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    `${t(`world.season.${input.season}`)} · ${weatherLabel === weatherKey ? input.weather : weatherLabel}`,
    80,
    headerY + 36,
  );
  if (capacityLabel) {
    ctx.textAlign = 'right';
    ctx.fillText(capacityLabel, width - 32, headerY + 22);
    ctx.textAlign = 'left';
  }

  // --- Bandeau récapitulatif --------------------------------------------
  withDropShadow(ctx, () =>
    fillRoundRect(ctx, 16, footerY, width - 32, footerHeight, 14, 'rgba(20,24,33,0.82)'),
  );
  const chips: Array<{ kind: 'feed' | 'sick' | 'ready' | null; color: string; label: string; count: number }> = [
    { kind: null, color: PALETTE.text, label: t('render.animals.alive', { count: input.totals.alive }), count: input.totals.alive },
    { kind: 'feed', color: '#f0932b', label: t('render.animals.hungry', { count: input.totals.hungry }), count: input.totals.hungry },
    { kind: 'sick', color: PALETTE.danger, label: t('render.animals.sick', { count: input.totals.sick }), count: input.totals.sick },
    { kind: 'ready', color: PALETTE.success, label: t('render.animals.ready', { count: input.totals.ready }), count: input.totals.ready },
  ];
  const chipWidth = (width - 64) / chips.length;
  for (const [index, chip] of chips.entries()) {
    const chipX = 32 + index * chipWidth;
    const centerY = footerY + footerHeight / 2;
    // Un compteur à zéro n'appelle aucune action : on l'estompe au lieu de le cacher,
    // pour que la ligne garde la même géométrie d'un affichage à l'autre.
    const active = chip.count > 0;
    let textX = chipX;
    if (chip.kind) {
      ctx.globalAlpha = active ? 1 : 0.4;
      drawBadge(ctx, chipX + 11, centerY, 22, chip.kind, chip.color);
      ctx.globalAlpha = 1;
      textX = chipX + 30;
    }
    ctx.font = font(16, 'bold');
    ctx.fillStyle = active ? PALETTE.text : PALETTE.textMuted;
    ctx.fillText(clipText(ctx, chip.label, chipWidth - 40), textX, centerY - 9);
  }

  return encode(canvas);
}

// ---------------------------------------------------------------------------
// ENCLOS
// ---------------------------------------------------------------------------

interface Cell {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Répartit `count` enclos dans la zone : une colonne pour un seul, deux
 * jusqu'à quatre, trois au-delà. La dernière rangée s'étire sur toute la
 * largeur plutôt que de laisser une case vide — cinq bâtiments donnent trois
 * enclos en haut et deux plus larges en bas.
 */
function layoutPens(count: number, area: Cell & { gap: number }): Cell[] {
  if (count === 0) return [];
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  const cellHeight = (area.height - area.gap * (rows - 1)) / rows;
  const cells: Cell[] = [];
  for (let row = 0; row < rows; row += 1) {
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const cellWidth = (area.width - area.gap * (inRow - 1)) / inRow;
    for (let col = 0; col < inRow; col += 1) {
      cells.push({
        x: area.x + col * (cellWidth + area.gap),
        y: area.y + row * (cellHeight + area.gap),
        width: cellWidth,
        height: cellHeight,
      });
    }
  }
  return cells;
}

/** Tailles de bête candidates, de la plus lisible à la plus dense. */
const ANIMAL_SIZES = [72, 64, 56, 48, 40, 34] as const;

interface PenOptions {
  building: AnimalsRenderBuilding;
  residents: AnimalsRenderAnimal[];
  cell: Cell;
  palette: { grass: string; grassDark: string };
  random: () => number;
  /** Bêtes encore dessinables avant d'atteindre `MAX_VISIBLE_ANIMALS`. */
  budget: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}

/** Dessine un enclos et ses pensionnaires ; renvoie le nombre de bêtes dessinées. */
async function drawPen(ctx: SKRSContext2D, options: PenOptions): Promise<number> {
  const { building, residents, cell, random, t } = options;
  const ground = PEN_GROUNDS[building.key] ?? {
    fill: lighten(options.palette.grass, 0.08),
    dark: options.palette.grassDark,
  };

  // Sol et clôture
  withDropShadow(
    ctx,
    () => fillRoundRect(ctx, cell.x, cell.y, cell.width, cell.height, 12, ground.dark),
    { blur: 10, offsetY: 4 },
  );
  fillRoundRect(ctx, cell.x + 3, cell.y + 3, cell.width - 6, cell.height - 8, 10, ground.fill);
  if (building.key === 'apiary') drawFlowers(ctx, cell, random);
  drawPenFence(ctx, cell);

  // Étiquette : bâtiment, nom, palier, occupation
  const labelHeight = 34;
  const iconSize = 30;
  drawBuilding(ctx, building.key, cell.x + 12, cell.y + 4, iconSize);
  const occupancy = `${building.used}/${building.capacity}`;
  ctx.font = font(13, 'bold');
  const occupancyWidth = ctx.measureText(occupancy).width + 16;
  const chipX = cell.x + cell.width - 12 - occupancyWidth;
  fillRoundRect(ctx, chipX, cell.y + 10, occupancyWidth, 20, 10, 'rgba(20,24,33,0.78)');
  ctx.fillStyle = building.used >= building.capacity ? PALETTE.gold : PALETTE.text;
  ctx.fillText(occupancy, chipX + 8, cell.y + 13);

  const name = `${building.name} · ${t('craft.tier_label', { tier: building.tier })}`;
  const nameWidth = chipX - (cell.x + 12 + iconSize + 8) - 8;
  ctx.font = font(14, 'bold');
  ctx.fillStyle = PALETTE.text;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  const clippedName = clipText(ctx, name, nameWidth);
  ctx.strokeText(clippedName, cell.x + 12 + iconSize + 8, cell.y + 12);
  ctx.fillText(clippedName, cell.x + 12 + iconSize + 8, cell.y + 12);
  ctx.lineJoin = 'miter';

  if (residents.length === 0) return 0;

  // Grille des bêtes : la plus grande taille qui loge tout le monde, sinon la
  // plus dense, et un « +N » pour ce qui déborde.
  const areaX = cell.x + 10;
  const areaY = cell.y + labelHeight + 4;
  const areaWidth = cell.width - 20;
  const areaHeight = cell.height - labelHeight - 16;
  const wanted = Math.min(residents.length, options.budget);
  let size: number = ANIMAL_SIZES[ANIMAL_SIZES.length - 1] ?? 34;
  let cols = 1;
  let rows = 1;
  for (const candidate of ANIMAL_SIZES) {
    const slotWidth = candidate + 6;
    const slotHeight = candidate + (candidate >= 48 ? 14 : 4);
    const fitCols = Math.max(1, Math.floor(areaWidth / slotWidth));
    const fitRows = Math.max(1, Math.floor(areaHeight / slotHeight));
    size = candidate;
    cols = fitCols;
    rows = fitRows;
    if (fitCols * fitRows >= wanted) break;
  }
  const slotWidth = size + 6;
  const slotHeight = size + (size >= 48 ? 14 : 4);
  const visible = Math.min(wanted, cols * rows);
  const hidden = residents.length - visible;
  // Centrage horizontal de la grille dans l'enclos.
  const usedCols = Math.min(cols, visible);
  const usedRows = Math.ceil(visible / cols);
  const originX = areaX + (areaWidth - usedCols * slotWidth) / 2;
  const originY = areaY + Math.max(0, (areaHeight - usedRows * slotHeight) / 2);

  for (let index = 0; index < visible; index += 1) {
    const animal = residents[index]!;
    const col = index % cols;
    const row = Math.floor(index / cols);
    // Décalage semé : une rangée trop régulière ressemble à un inventaire.
    const jitterX = (random() - 0.5) * 6;
    const jitterY = (random() - 0.5) * 4;
    const facing: 1 | -1 = random() > 0.5 ? 1 : -1;
    const x = originX + col * slotWidth + 3 + jitterX;
    const y = originY + row * slotHeight + jitterY;
    await drawResident(ctx, animal, { x, y, size, facing, seed: seedFrom(animal.id) });

    if (size >= 48) {
      const label = animal.nickname ?? animal.name;
      ctx.font = font(11, 'bold');
      const text = clipText(ctx, label, slotWidth - 4);
      const textWidth = ctx.measureText(text).width;
      const labelX = x + size / 2 - textWidth / 2 - 5;
      fillRoundRect(ctx, labelX, y + size - 2, textWidth + 10, 15, 7, 'rgba(20,24,33,0.72)');
      ctx.fillStyle = PALETTE.text;
      ctx.fillText(text, labelX + 5, y + size);
    }
  }

  if (hidden > 0) {
    const label = t('render.animals.more', { count: hidden });
    ctx.font = font(14, 'bold');
    const labelWidth = ctx.measureText(label).width + 18;
    fillRoundRect(ctx, cell.x + cell.width - 12 - labelWidth, cell.y + cell.height - 34, labelWidth, 24, 12, 'rgba(20,24,33,0.85)');
    ctx.fillStyle = PALETTE.gold;
    ctx.fillText(label, cell.x + cell.width - 12 - labelWidth + 9, cell.y + cell.height - 30);
  }

  return visible;
}

/** Une bête : sprite PNG si présent, sinon sa silhouette, puis ses pastilles. */
async function drawResident(
  ctx: SKRSContext2D,
  animal: AnimalsRenderAnimal,
  box: { x: number; y: number; size: number; facing: 1 | -1; seed: number },
): Promise<void> {
  const { x, y, size } = box;
  const flags = animalIndicators(animal);
  const variant = animal.variant ?? 'normal';
  const image = await sprite('animals', animal.animalKey);
  if (image) {
    ctx.drawImage(image, x, y, size, size);
    // Un sprite PNG ne se reteinte pas : la marque (étincelles, étoile)
    // reste le signe de la variante.
    drawVariantMark(ctx, { x, y, size, variant, seed: box.seed });
  } else if (animal.form && animal.palette) {
    drawAnimalForm(ctx, {
      x,
      y,
      size,
      form: animal.form,
      palette: animal.palette,
      facing: box.facing,
      seed: box.seed,
      sleeping: flags.sleeping,
      sick: flags.sick,
      variant,
    });
  } else {
    drawAnimal(ctx, { x, y, size, color: '#e8d8b7', emoji: animal.emoji });
    drawVariantMark(ctx, { x, y, size, variant, seed: box.seed });
  }

  // Pastilles aux quatre coins, chacune à sa place fixe pour être reconnue
  // d'une bête à l'autre sans la lire.
  const badge = Math.max(12, size * 0.3);
  const inset = badge * 0.45;
  if (flags.ready) drawBadge(ctx, x + size - inset, y + inset, badge, 'ready', PALETTE.success);
  if (flags.feed) drawBadge(ctx, x + inset, y + inset, badge, 'feed', '#f0932b');
  if (flags.sick) drawBadge(ctx, x + inset, y + size * 0.72, badge, 'sick', PALETTE.danger);
  if (flags.pet) drawBadge(ctx, x + size - inset, y + size * 0.72, badge, 'pet', '#e58fb0');
}

/** Clôture de bois : des poteaux à intervalle fixe et deux lisses. */
function drawPenFence(ctx: SKRSContext2D, cell: Cell): void {
  const rail = '#b08e63';
  const post = '#7a5c3c';
  ctx.strokeStyle = rail;
  ctx.lineWidth = 3;
  roundRect(ctx, cell.x + 4, cell.y + 4, cell.width - 8, cell.height - 8, 10);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  roundRect(ctx, cell.x + 6, cell.y + 6, cell.width - 12, cell.height - 12, 8);
  ctx.stroke();
  ctx.fillStyle = post;
  for (let px = cell.x + 14; px < cell.x + cell.width - 8; px += 46) {
    ctx.fillRect(px, cell.y + cell.height - 14, 5, 12);
  }
}

/** Fleurs du rucher : quelques corolles semées, la raison d'être des abeilles. */
function drawFlowers(ctx: SKRSContext2D, cell: Cell, random: () => number): void {
  const colors = ['#f2c2c8', '#f5d76e', '#c9a4f0', '#ffffff'];
  for (let index = 0; index < 18; index += 1) {
    const fx = cell.x + 14 + random() * (cell.width - 28);
    const fy = cell.y + 40 + random() * (cell.height - 56);
    ctx.fillStyle = colors[index % colors.length]!;
    ctx.beginPath();
    ctx.arc(fx, fy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(fx, fy, 1, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Panneau sur pied, pour une basse-cour sans bâtiment : l'invitation plutôt que le vide. */
function drawSignpost(ctx: SKRSContext2D, cx: number, cy: number, text: string): void {
  ctx.font = font(16, 'bold');
  const clean = drawableText(text);
  // La planche s'élargit jusqu'aux marges de l'image : une invitation tronquée
  // en son milieu ne dit plus quoi construire.
  const textWidth = Math.min(ctx.measureText(clean).width + 40, cx * 2 - 80);
  const boardHeight = 48;
  ctx.fillStyle = '#7a5c3c';
  ctx.fillRect(cx - 5, cy, 10, 70);
  withDropShadow(ctx, () =>
    fillRoundRect(ctx, cx - textWidth / 2, cy - boardHeight, textWidth, boardHeight, 8, '#c8b393'),
  );
  ctx.fillStyle = '#3b2a1a';
  ctx.textAlign = 'center';
  ctx.fillText(clipText(ctx, clean, textWidth - 24), cx, cy - boardHeight / 2 - 9);
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------------------
// TEXTE ALTERNATIF
// ---------------------------------------------------------------------------

/** Au-delà, une liste de bêtes n'apprend plus rien et mange le budget de Discord. */
const MAX_LISTED_ANIMALS = 6;

/**
 * Texte alternatif de la basse-cour : les compteurs, chaque enclos avec son
 * occupation et ses pensionnaires, puis ce qui appelle une action — les mêmes
 * pastilles que l'image, décidées par `animalIndicators()`. Aucune horloge :
 * tout vient de l'entrée, donc la description accompagne aussi une image
 * servie depuis le cache.
 */
export function describeAnimals(input: AnimalsRenderInput): string {
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(input.locale, key, params);
  const weatherKey = `world.weather.${input.weather}`;
  const weatherLabel = t(weatherKey);
  const label = (animal: AnimalsRenderAnimal): string =>
    animal.nickname ? t('render_alt.animals.named', { nickname: animal.nickname, species: animal.name }) : animal.name;
  const more = (rest: number): string => t('render_alt.animals.more', { count: rest });
  const listed = (animals: AnimalsRenderAnimal[], key: string): string | null =>
    animals.length > 0
      ? t(key, { animals: listSome(animals.map(label), MAX_LISTED_ANIMALS, more) })
      : null;

  const buildings = input.buildings.map((building) => {
    const residents = input.animals.filter((animal) => animal.buildingKey === building.key);
    return residents.length > 0
      ? t('render_alt.animals.building', {
          name: building.name,
          tier: building.tier,
          used: building.used,
          capacity: building.capacity,
          animals: listSome(residents.map(label), MAX_LISTED_ANIMALS, more),
        })
      : t('render_alt.animals.building_empty', {
          name: building.name,
          tier: building.tier,
          capacity: building.capacity,
        });
  });

  const flagged = input.animals.map((animal) => ({ animal, flags: animalIndicators(animal) }));
  const hidden = Math.max(0, input.animals.length - MAX_VISIBLE_ANIMALS);

  // Les variantes rares : l'image les montre par un halo ou une teinte d'or,
  // que seul le texte peut restituer à qui ne la voit pas.
  const rare = input.animals
    .filter((animal) => animal.variant && animal.variant !== 'normal')
    .map((animal) =>
      t('render_alt.animals.variant_entry', {
        label: label(animal),
        variant: t(`animals.variant.${animal.variant ?? 'normal'}`),
      }),
    );

  return clampAltText(
    joinSentences([
      t('render_alt.animals.header', {
        name: input.ownerName,
        season: t(`world.season.${input.season}`),
        weather: weatherLabel === weatherKey ? input.weather : weatherLabel,
      }),
      t('render_alt.animals.totals', {
        alive: input.totals.alive,
        hungry: input.totals.hungry,
        sick: input.totals.sick,
        ready: input.totals.ready,
      }),
      input.buildings.length === 0 ? t('render_alt.animals.no_building') : null,
      ...buildings,
      listed(flagged.filter((entry) => entry.flags.ready).map((entry) => entry.animal), 'render_alt.animals.ready_list'),
      listed(flagged.filter((entry) => entry.flags.feed).map((entry) => entry.animal), 'render_alt.animals.feed_list'),
      listed(flagged.filter((entry) => entry.flags.sick).map((entry) => entry.animal), 'render_alt.animals.sick_list'),
      listed(flagged.filter((entry) => entry.flags.pet).map((entry) => entry.animal), 'render_alt.animals.pet_list'),
      rare.length > 0
        ? t('render_alt.animals.variant_list', { animals: listSome(rare, MAX_LISTED_ANIMALS, more) })
        : null,
      hidden > 0 ? t('render_alt.animals.hidden', { count: hidden, max: MAX_VISIBLE_ANIMALS }) : null,
    ]),
  );
}
