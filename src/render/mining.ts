import { balance as getBalance } from '../config';
import { translate } from '../i18n';
import { clampAltText, joinSentences } from './alt-text';
import { PALETTE, encode, fillRoundRect, font, newCanvas, verticalGradient } from './canvas';
import { seededRandom } from './scenery';
import { mixHex, rarityColor } from './sprites';
import type { SKRSContext2D } from '@napi-rs/canvas';

/**
 * Coupe verticale du puits de mine. La règle de profondeur couvre TOUJOURS
 * `balance.mining.maxDepth` paliers (le maximum théorique du jeu), pas
 * seulement ceux débloqués par ce joueur : les paliers hors de portée
 * apparaissent assombris, comme les articles verrouillés de `/shop` — de quoi
 * donner un objectif visible, pas seulement un chiffre.
 *
 * La coupe est faite de PLANS : les strates de la roche encaissante de part et
 * d'autre, puis le puits creusé dedans — parois ombrées, fond éclairé par la
 * lanterne — et devant, les étais. Les filons prennent la couleur de la
 * rareté qu'on trouve à leur profondeur : le joueur reconnaît l'échelle des
 * objets (gris, vert, bleu, violet, orange, rouge) et sait ce que « creuser
 * plus bas » rapporte. Tout est semé : une profondeur donnée montre toujours
 * les mêmes filons.
 */

export interface MiningRenderInput {
  locale: string;
  depth: number;
  maxDepth: number;
  deepestReached: number;
}

const ROCK_TOP = '#8a7864';
const ROCK_BOTTOM = '#241b14';

/**
 * Rareté dominante d'un palier, en fraction de la profondeur totale. Les
 * bornes suivent la progression du jeu : le commun disparaît vite, le mythique
 * n'apparaît qu'au fond.
 */
export function depthRarity(fraction: number): string {
  if (fraction < 0.15) return 'common';
  if (fraction < 0.35) return 'uncommon';
  if (fraction < 0.55) return 'rare';
  if (fraction < 0.75) return 'epic';
  if (fraction < 0.9) return 'legendary';
  return 'mythic';
}

export async function renderMining(input: MiningRenderInput): Promise<Buffer> {
  const balance = getBalance();
  const dims = balance.render.mining;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(input.locale, key, params);
  const totalDepth = Math.max(1, balance.mining.maxDepth);

  const { canvas, ctx } = newCanvas(dims.width, dims.height);
  const headerHeight = 70;
  const surfaceHeight = 26;
  const shaftTop = headerHeight + surfaceHeight;
  const shaftBottom = dims.height - 16;
  const shaftHeight = shaftBottom - shaftTop;
  const shaftX = dims.width * 0.32;
  const shaftWidth = dims.width * 0.4;
  const random = seededRandom(17);

  // --- Fond -----------------------------------------------------------------
  ctx.fillStyle = PALETTE.card;
  ctx.fillRect(0, 0, dims.width, dims.height);

  // --- Roche encaissante : strates de part et d'autre du puits ---------------
  // Bandes horizontales aux bords ondulés, de plus en plus sombres ; elles
  // donnent l'échelle et font du puits un trou creusé dans quelque chose.
  const strata = 9;
  for (let index = 0; index < strata; index += 1) {
    const ratio = index / (strata - 1);
    const y0 = shaftTop + (shaftHeight / strata) * index;
    const y1 = y0 + shaftHeight / strata + 8;
    // Une strate sur deux est un peu plus claire : c'est l'alternance qui se
    // lit comme des couches, pas le dégradé seul.
    const tone = mixHex(mixHex(ROCK_TOP, ROCK_BOTTOM, ratio), PALETTE.card, 0.3);
    ctx.fillStyle = index % 2 === 0 ? tone : mixHex(tone, '#ffffff', 0.07);
    ctx.beginPath();
    ctx.moveTo(0, y0);
    const edge: number[] = [];
    for (let x = 0; x <= dims.width; x += 40) {
      const wave = y0 + Math.sin(x / 55 + index) * 4 + (random() - 0.5) * 3;
      edge.push(wave);
      ctx.lineTo(x, wave);
    }
    ctx.lineTo(dims.width, y1);
    ctx.lineTo(0, y1);
    ctx.closePath();
    ctx.fill();
    // Arête de la couche : un fil clair, comme une fracture qui prend la lumière.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    edge.forEach((wave, step) => {
      if (step === 0) ctx.moveTo(0, wave);
      else ctx.lineTo(step * 40, wave);
    });
    ctx.stroke();
  }
  // Cailloux enchâssés dans la roche, à l'écart du puits.
  for (let index = 0; index < 70; index += 1) {
    const left = random() > 0.5;
    const px = left ? random() * (shaftX - 40) + 10 : shaftX + shaftWidth + 30 + random() * (dims.width - shaftX - shaftWidth - 40);
    const py = shaftTop + 10 + random() * (shaftHeight - 20);
    const radius = 2 + random() * 4;
    ctx.fillStyle = random() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(px, py, radius * 1.4, radius, random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Surface, juste sous l'en-tête -----------------------------------------
  ctx.fillStyle = '#5da13c';
  ctx.fillRect(0, headerHeight, dims.width, surfaceHeight);
  ctx.fillStyle = '#7a5230';
  ctx.fillRect(0, headerHeight + surfaceHeight - 6, dims.width, 6);

  // --- Puits : dégradé clair en surface, sombre en profondeur ----------------
  ctx.fillStyle = verticalGradient(ctx, 0, shaftTop, shaftHeight, ROCK_TOP, ROCK_BOTTOM);
  ctx.fillRect(shaftX, shaftTop, shaftWidth, shaftHeight);
  // Parois : ombre vers les bords, le fond du puits paraît en retrait.
  const walls = ctx.createLinearGradient(shaftX, 0, shaftX + shaftWidth, 0);
  walls.addColorStop(0, 'rgba(0,0,0,0.42)');
  walls.addColorStop(0.18, 'rgba(0,0,0,0)');
  walls.addColorStop(0.82, 'rgba(0,0,0,0)');
  walls.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = walls;
  ctx.fillRect(shaftX, shaftTop, shaftWidth, shaftHeight);
  // Grain de la paroi du fond.
  for (let index = 0; index < 120; index += 1) {
    const px = shaftX + 8 + random() * (shaftWidth - 16);
    const py = shaftTop + random() * shaftHeight;
    ctx.fillStyle = random() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.16)';
    ctx.fillRect(px, py, 2 + random() * 5, 1.5);
  }

  const depthToY = (depth: number): number => shaftTop + ((depth - 1) / (totalDepth - 1 || 1)) * shaftHeight;

  // Filons : grappes de gemmes, couleur de la rareté du palier, plus denses en
  // profondeur. Dessinés AVANT le voile des paliers verrouillés : on devine ce
  // qu'il y a en bas, sans le voir en clair.
  const veins = 30;
  for (let index = 0; index < veins; index += 1) {
    const fraction = random() ** 0.7;
    const depth = 1 + fraction * (totalDepth - 1);
    const x = shaftX + 16 + random() * (shaftWidth - 32);
    const y = depthToY(depth);
    const color = rarityColor(depthRarity(fraction));
    const size = 2.5 + fraction * 2.5;
    drawVein(ctx, x, y, size, color, random);
  }

  // Paliers hors de portée du joueur : voile sombre, pour montrer le potentiel
  // sans le rendre accessible visuellement.
  if (input.maxDepth < totalDepth) {
    const lockedY = depthToY(input.maxDepth + 1);
    fillRoundRect(ctx, shaftX, lockedY, shaftWidth, shaftBottom - lockedY, 0, 'rgba(0,0,0,0.62)');
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(shaftX, lockedY);
    ctx.lineTo(shaftX + shaftWidth, lockedY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Étais de bois tous les 5 paliers, pour donner une échelle visuelle au puits.
  for (let depth = 1; depth <= totalDepth; depth += 5) {
    const y = depthToY(depth);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(shaftX - 6, y + 5, shaftWidth + 12, 4);
    ctx.fillStyle = 'rgba(122,82,48,0.9)';
    ctx.fillRect(shaftX - 6, y, shaftWidth + 12, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(shaftX - 6, y, shaftWidth + 12, 1.5);
  }
  // Montants verticaux des étais, aux deux parois.
  ctx.fillStyle = 'rgba(122,82,48,0.75)';
  ctx.fillRect(shaftX - 6, shaftTop, 6, shaftHeight);
  ctx.fillRect(shaftX + shaftWidth, shaftTop, 6, shaftHeight);

  // Règle de profondeur, à gauche du puits.
  ctx.font = font(13);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.textAlign = 'right';
  const tickStep = totalDepth > 12 ? 5 : 2;
  for (let depth = 1; depth <= totalDepth; depth += tickStep) {
    const y = depthToY(depth);
    ctx.fillText(String(depth), shaftX - 16, y - 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(shaftX - 12, y);
    ctx.lineTo(shaftX - 6, y);
    ctx.stroke();
  }
  ctx.textAlign = 'left';

  // Marqueur du joueur : une lanterne à sa profondeur courante.
  const playerY = depthToY(Math.max(1, Math.min(input.depth, totalDepth)));
  const playerX = shaftX + shaftWidth / 2;
  const glow = ctx.createRadialGradient(playerX, playerY, 2, playerX, playerY, 46);
  glow.addColorStop(0, 'rgba(255,201,60,0.7)');
  glow.addColorStop(0.5, 'rgba(255,201,60,0.18)');
  glow.addColorStop(1, 'rgba(255,201,60,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(playerX, playerY, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.gold;
  ctx.beginPath();
  ctx.arc(playerX, playerY, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PALETTE.text;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Meilleure profondeur atteinte : petit repère discret, si différent de l'actuelle.
  if (input.deepestReached > input.depth) {
    const bestY = depthToY(Math.min(input.deepestReached, totalDepth));
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(shaftX, bestY);
    ctx.lineTo(shaftX + shaftWidth, bestY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // --- Bandeau d'en-tête ------------------------------------------------------
  fillRoundRect(ctx, 16, 12, dims.width - 32, headerHeight - 22, 14, 'rgba(20,24,33,0.82)');
  ctx.font = font(22, 'bold');
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(
    t('mining.depth_field') + ` · ${input.depth} / ${input.maxDepth}`,
    32,
    22,
  );
  if (input.deepestReached > input.depth) {
    ctx.font = font(14);
    ctx.fillStyle = PALETTE.textMuted;
    ctx.textAlign = 'right';
    ctx.fillText(t('mining.best_depth_field', { depth: input.deepestReached }), dims.width - 32, 26);
    ctx.textAlign = 'left';
  }

  return encode(canvas);
}

/** Grappe de trois ou quatre gemmes à facettes, avec un éclat blanc sur chacune. */
function drawVein(ctx: SKRSContext2D, x: number, y: number, size: number, color: string, random: () => number): void {
  const gems = 3 + Math.floor(random() * 2);
  for (let index = 0; index < gems; index += 1) {
    const gx = x + (random() - 0.5) * size * 4;
    const gy = y + (random() - 0.5) * size * 2.5;
    const s = size * (0.7 + random() * 0.6);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(gx, gy - s);
    ctx.lineTo(gx + s, gy);
    ctx.lineTo(gx, gy + s);
    ctx.lineTo(gx - s, gy);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.moveTo(gx, gy - s);
    ctx.lineTo(gx + s * 0.45, gy - s * 0.45);
    ctx.lineTo(gx - s * 0.2, gy - s * 0.2);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Texte alternatif de la coupe de mine : profondeur courante, record et
 * paliers hors de portée — les trois choses que l'image montre, avec le même
 * total que sa règle (`balance.mining.maxDepth`), pour que l'objectif lointain
 * soit aussi audible que visible.
 */
export function describeMining(input: MiningRenderInput): string {
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(input.locale, key, params);
  const total = Math.max(1, getBalance().mining.maxDepth);
  const locked = total - Math.min(total, input.maxDepth);

  return clampAltText(
    joinSentences([
      t('render_alt.mining.scene', { total, accessible: input.maxDepth }),
      t('render_alt.mining.position', { depth: input.depth, accessible: input.maxDepth }),
      input.deepestReached > input.depth
        ? t('render_alt.mining.best', { deepest: input.deepestReached })
        : null,
      locked > 0 ? t('render_alt.mining.locked', { count: locked }) : null,
    ]),
  );
}
