import { balance as getBalance } from '../config';
import { translate } from '../i18n';
import { formatCompact, formatNumber } from '../utils/format';
import { clampAltText, joinSentences } from './alt-text';
import {
  PALETTE,
  hasEmojiFont,
  clipText,
  drawAvatar,
  encode,
  fillRoundRect,
  font,
  newCanvas,
  progressBar,
  starPath,
  verticalGradient,
  withDropShadow,
} from './canvas';
import { seedFrom, seededRandom } from './scenery';
import { drawCoin, drawGem, rarityColor } from './sprites';
import type { SKRSContext2D } from '@napi-rs/canvas';

/** Carte de profil : avatar, bannière, niveau, XP, statistiques clés, badges. */

export interface ProfileRenderInput {
  /** Langue du spectateur. Toute chaîne dessinée en dépend. */
  locale: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  title: string | null;
  badges: string[];
  level: number;
  prestige: number;
  xp: { current: number; needed: number };
  coins: number;
  gems: number;
  bank: number;
  energy: { current: number; max: number };
  stats: {
    harvests: number;
    animals: number;
    crafts: number;
    plots: number;
    streak: number;
    achievements: number;
    bestHarvest: number;
    coinsEarned: number;
  };
  coop: { name: string; tag: string; level: number; role: string } | null;
  themeColor: string;
  bannerStyle?: string;
  farmName: string;
  createdAt: Date;
}

const BANNERS: Record<string, [string, string]> = {
  default: ['#2b3a55', '#1f2430'],
  sunset: ['#ff7e5f', '#feb47b'],
  starry: ['#0f1b3d', '#3a2a6d'],
  autumn: ['#8b4513', '#d2691e'],
  winter: ['#4a6fa5', '#a8c8e8'],
  neon: ['#3a0ca3', '#f72585'],
};

export async function renderProfile(input: ProfileRenderInput): Promise<Buffer> {
  const dims = getBalance().render.profile;
  const { canvas, ctx } = newCanvas(dims.width, dims.height);
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);

  // --- Bannière et fond -------------------------------------------------
  // La bannière ne porte AUCUN texte : sa couleur est choisie par le joueur, on
  // ne peut donc pas garantir le contraste. Tout le texte vit sur la carte
  // sombre, dont le contraste est maîtrisé.
  const bannerHeight = 118;
  const banner = BANNERS[input.bannerStyle ?? 'default'] ?? BANNERS.default!;
  ctx.fillStyle = verticalGradient(ctx, 0, 0, bannerHeight, banner[0], banner[1]);
  ctx.fillRect(0, 0, dims.width, bannerHeight);
  // Le prestige se lit sur la bannière : le motif est semé sur le pseudo pour
  // que deux joueurs de même rang n'aient pas le même ciel, et reste identique
  // d'un affichage à l'autre (le cache d'images en dépend).
  drawPrestigeBanner(ctx, dims.width, bannerHeight, input.prestige, seedFrom(input.username));
  ctx.fillStyle = PALETTE.card;
  ctx.fillRect(0, bannerHeight, dims.width, dims.height - bannerHeight);

  // Accent coloré du joueur, en bas de la bannière
  ctx.fillStyle = input.themeColor;
  ctx.fillRect(0, bannerHeight - 4, dims.width, 5);

  // --- Identité ---------------------------------------------------------
  // L'avatar chevauche la bannière et la carte : repère visuel classique.
  const avatarSize = 112;
  const avatarX = 36;
  const avatarY = bannerHeight - 56;
  await drawAvatar(ctx, input.avatarUrl, avatarX, avatarY, avatarSize, input.themeColor);
  // Anneau de niveau : la couleur dit la tranche avant même de lire le chiffre.
  drawLevelRing(ctx, avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, input.level);

  const nameX = 172;
  ctx.fillStyle = PALETTE.text;
  ctx.font = font(32, 'bold');
  ctx.fillText(clipText(ctx, input.displayName, 400), nameX, bannerHeight + 12);

  ctx.font = font(16);
  ctx.fillStyle = PALETTE.textMuted;
  const subtitle = [
    input.title ?? t('render.profile.default_title'),
    input.prestige > 0 ? t('render.profile.prestige', { rank: input.prestige }) : null,
    input.coop ? `[${input.coop.tag}] ${input.coop.name}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  ctx.fillText(clipText(ctx, subtitle, 420), nameX, bannerHeight + 52);

  // --- Niveau et XP -----------------------------------------------------
  ctx.font = font(20, 'bold');
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(t('render.profile.level', { level: input.level }), nameX, bannerHeight + 82);

  // Les libellés sont dessinés DANS les barres : à droite, ils empiéteraient
  // sur le bloc des monnaies.
  progressBar(ctx, {
    x: nameX,
    y: bannerHeight + 112,
    width: 400,
    height: 22,
    ratio: input.xp.needed > 0 ? input.xp.current / input.xp.needed : 1,
    fill: PALETTE.xp,
    label:
      input.xp.needed > 0
        ? t('render.profile.xp', {
            current: formatCompact(input.xp.current, locale),
            needed: formatCompact(input.xp.needed, locale),
          })
        : t('render.profile.max_level'),
  });

  progressBar(ctx, {
    x: nameX,
    y: bannerHeight + 144,
    width: 400,
    height: 18,
    ratio: input.energy.max > 0 ? input.energy.current / input.energy.max : 1,
    fill: '#f7c948',
    label: t('render.profile.energy', {
      current: input.energy.current,
      max: input.energy.max,
    }),
  });

  // --- Monnaies ---------------------------------------------------------
  const walletX = dims.width - 288;
  withDropShadow(ctx, () => fillRoundRect(ctx, walletX, bannerHeight + 26, 252, 116, 14, PALETTE.cardAlt));
  drawCoin(ctx, walletX + 26, bannerHeight + 56, 11);
  ctx.font = font(20, 'bold');
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText(formatNumber(input.coins, locale), walletX + 46, bannerHeight + 46);
  drawGem(ctx, walletX + 26, bannerHeight + 92, 11);
  ctx.fillStyle = '#7fd8ff';
  ctx.fillText(formatNumber(input.gems, locale), walletX + 46, bannerHeight + 82);
  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    t('render.profile.in_bank', { amount: formatCompact(input.bank, locale) }),
    walletX + 20,
    bannerHeight + 116,
  );

  // --- Statistiques en grille ------------------------------------------
  const statsY = bannerHeight + 176;
  const cells: Array<{ label: string; value: string; color: string }> = [
    { label: t('render.profile.stat.harvests'), value: formatCompact(input.stats.harvests, locale), color: PALETTE.grass },
    { label: t('render.profile.stat.animals'), value: formatCompact(input.stats.animals, locale), color: '#e8b04b' },
    { label: t('render.profile.stat.crafts'), value: formatCompact(input.stats.crafts, locale), color: '#7fd8ff' },
    { label: t('render.profile.stat.plots'), value: `${input.stats.plots}/64`, color: PALETTE.soil },
    { label: t('render.profile.stat.streak'), value: t('render.profile.streak_unit', { days: input.stats.streak }), color: '#ff7043' },
    { label: t('render.profile.stat.achievements'), value: String(input.stats.achievements), color: PALETTE.gold },
    { label: t('render.profile.stat.best_harvest'), value: formatCompact(input.stats.bestHarvest, locale), color: rarityColor('epic') },
    { label: t('render.profile.stat.coins_earned'), value: formatCompact(input.stats.coinsEarned, locale), color: rarityColor('legendary') },
  ];

  const columns = 4;
  const cellWidth = (dims.width - 72 - (columns - 1) * 12) / columns;
  const cellHeight = 62;

  cells.forEach((cell, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = 36 + column * (cellWidth + 12);
    const y = statsY + row * (cellHeight + 12);

    withDropShadow(ctx, () => fillRoundRect(ctx, x, y, cellWidth, cellHeight, 12, PALETTE.cardAlt), {
      blur: 8,
      offsetY: 3,
    });
    ctx.fillStyle = cell.color;
    ctx.fillRect(x, y + 12, 4, cellHeight - 24);
    ctx.font = font(20, 'bold');
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(clipText(ctx, cell.value, cellWidth - 24), x + 16, y + 10);
    ctx.font = font(13);
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(clipText(ctx, cell.label, cellWidth - 24), x + 16, y + 38);
  });

  // --- Pied de carte : badges à gauche, ferme et ancienneté à droite -----
  // Les badges SONT des emoji. On les dessine tels quels quand la police couleur
  // est installée — c'est le cas de l'image Docker, qui embarque
  // `fonts-noto-color-emoji` — et on retombe sur des pastilles sinon, pour ne
  // jamais afficher de carrés « tofu » sur une machine qui ne l'a pas.
  const footerY = dims.height - 34;
  const emojiAvailable = hasEmojiFont();
  if (input.badges.length > 0) {
    for (const [index, badge] of input.badges.slice(0, 10).entries()) {
      const x = 42 + index * 22;
      if (emojiAvailable) {
        ctx.font = font(17);
        ctx.textAlign = 'center';
        ctx.fillStyle = PALETTE.text;
        ctx.fillText(badge, x, footerY);
        ctx.textAlign = 'left';
        continue;
      }
      ctx.beginPath();
      ctx.arc(x, footerY + 8, 8, 0, Math.PI * 2);
      ctx.fillStyle = index % 2 === 0 ? PALETTE.gold : rarityColor('epic');
      ctx.fill();
    }
    ctx.font = font(13);
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(
      t('render.profile.badges', { count: input.badges.length }),
      42 + Math.min(10, input.badges.length) * 22 + 6,
      footerY + 2,
    );
  }

  ctx.font = font(13);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.textAlign = 'right';
  ctx.fillText(
    clipText(
      ctx,
      t('render.profile.since', {
        farm: input.farmName,
        date: input.createdAt.toLocaleDateString(locale.startsWith('en') ? 'en-US' : 'fr-FR'),
      }),
      480,
    ),
    dims.width - 36,
    footerY + 4,
  );
  ctx.textAlign = 'left';

  return encode(canvas);
}

/**
 * Couleur de l'anneau d'avatar selon la tranche de niveau. Les paliers suivent
 * les grandes étapes du jeu (déblocage des enclos, de la mine, du prestige) ;
 * la couleur monte la même échelle que les raretés d'objets, déjà connue du
 * joueur, pour que « violet » veuille dire la même chose partout.
 */
export function levelRingColor(level: number): string {
  if (level >= 100) return rarityColor('mythic');
  if (level >= 75) return rarityColor('legendary');
  if (level >= 50) return PALETTE.gold;
  if (level >= 25) return rarityColor('epic');
  if (level >= 10) return rarityColor('rare');
  return PALETTE.grass;
}

function drawLevelRing(ctx: SKRSContext2D, cx: number, cy: number, radius: number, level: number): void {
  const ringRadius = radius + 4;
  // Liseré sombre extérieur : sépare l'anneau d'une bannière de teinte proche.
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius + 2.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(20,24,33,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
  ctx.strokeStyle = levelRingColor(level);
  ctx.lineWidth = 5;
  ctx.stroke();
  // Au-delà du niveau 100, un second anneau fin : le plafond est franchi.
  if (level >= 100) {
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius + 6, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/**
 * Motif de bannière selon le prestige : uni (0), étoiles semées (1),
 * constellation reliée (2 et plus, plus dense à chaque rang). Blanc
 * translucide uniquement : la bannière est de la couleur choisie par le
 * joueur, un motif coloré pourrait jurer avec n'importe laquelle.
 */
function drawPrestigeBanner(ctx: SKRSContext2D, width: number, height: number, prestige: number, seed: number): void {
  if (prestige <= 0) return;
  const random = seededRandom(seed);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();

  // Poussière d'étoiles : présente dès le rang 1.
  for (let index = 0; index < 60; index += 1) {
    const x = random() * width;
    const y = random() * height;
    ctx.fillStyle = `rgba(255,255,255,${(0.25 + random() * 0.45).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.8 + random() * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  // Étoiles à quatre branches, plus grandes.
  for (let index = 0; index < 14; index += 1) {
    const x = random() * width;
    const y = random() * height;
    const size = 3 + random() * 4;
    ctx.fillStyle = `rgba(255,255,255,${(0.45 + random() * 0.4).toFixed(2)})`;
    starPath(ctx, x, y, size, size * 0.35, 4);
    ctx.fill();
  }

  if (prestige >= 2) {
    // Constellation : des nœuds reliés de proche en proche, tracés d'un trait
    // fin. Le nombre de nœuds croît avec le rang, dans la limite du lisible.
    const nodes = Math.min(22, 8 + prestige * 3);
    const points: Array<{ x: number; y: number }> = [];
    let x = width * 0.28 + random() * width * 0.1;
    for (let index = 0; index < nodes; index += 1) {
      x += (width * 0.62) / nodes;
      points.push({ x, y: 14 + random() * (height - 28) });
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    // Quelques branches latérales, pour que la ligne ne soit pas une polyligne.
    for (let index = 1; index < points.length - 1; index += 3) {
      const from = points[index]!;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(from.x + (random() - 0.5) * 60, from.y + (random() - 0.5) * 50);
      ctx.stroke();
    }
    for (const point of points) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      starPath(ctx, point.x, point.y, 4, 1.6, 4);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * Texte alternatif de la carte de profil : les mêmes chiffres que l'image,
 * mais en entier — la carte abrège (« 1,3 M ») faute de place, un lecteur
 * d'écran n'a pas cette contrainte. Les libellés des statistiques sont ceux
 * des cases dessinées, pour qu'on parle de la même chose des deux côtés.
 */
export function describeProfile(input: ProfileRenderInput): string {
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);
  const pair = (label: string, value: string | number): string =>
    t('render_alt.common.pair', { label, value });

  const stats = [
    pair(t('render.profile.stat.harvests'), formatNumber(input.stats.harvests, locale)),
    pair(t('render.profile.stat.animals'), formatNumber(input.stats.animals, locale)),
    pair(t('render.profile.stat.crafts'), formatNumber(input.stats.crafts, locale)),
    pair(t('render.profile.stat.plots'), `${input.stats.plots}/64`),
    pair(t('render.profile.stat.streak'), t('render_alt.profile.streak_days', { days: input.stats.streak })),
    pair(t('render.profile.stat.achievements'), formatNumber(input.stats.achievements, locale)),
    pair(t('render.profile.stat.best_harvest'), formatNumber(input.stats.bestHarvest, locale)),
    pair(t('render.profile.stat.coins_earned'), formatNumber(input.stats.coinsEarned, locale)),
  ].join(', ');

  return clampAltText(
    joinSentences([
      t('render_alt.profile.header', {
        name: input.displayName,
        title: input.title ?? t('render.profile.default_title'),
      }),
      input.prestige > 0 ? t('render_alt.profile.prestige', { rank: input.prestige }) : null,
      input.coop
        ? t('render_alt.profile.coop', {
            tag: input.coop.tag,
            name: input.coop.name,
            level: input.coop.level,
          })
        : null,
      input.xp.needed > 0
        ? t('render_alt.profile.level', {
            level: input.level,
            current: formatNumber(input.xp.current, locale),
            needed: formatNumber(input.xp.needed, locale),
          })
        : t('render_alt.profile.max_level', { level: input.level }),
      t('render_alt.profile.energy', { current: input.energy.current, max: input.energy.max }),
      t('render_alt.profile.wallet', {
        coins: formatNumber(input.coins, locale),
        gems: formatNumber(input.gems, locale),
        bank: formatNumber(input.bank, locale),
      }),
      t('render_alt.profile.stats', { stats }),
      input.badges.length > 0
        ? t('render_alt.profile.badges', {
            count: input.badges.length,
            badges: input.badges.join(' '),
          })
        : null,
      t('render_alt.profile.since', {
        farm: input.farmName,
        date: input.createdAt.toLocaleDateString(locale.startsWith('en') ? 'en-US' : 'fr-FR'),
      }),
    ]),
  );
}
