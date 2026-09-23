import type { APIEmbedField } from 'discord.js';
import { getConfig } from '../config';
import { levelRewardsBetween, nextUnlock, unlocksBetween, type Unlock, type UnlockKind } from '../game/unlocks';
import { formatCoins, formatGems } from '../utils/format';
import type { Translator } from '../types';

/**
 * Bloc « montée de niveau » commun à toutes les sources d'XP (récolte,
 * animaux, fabrication, quêtes, récompense quotidienne, succès, passe…).
 *
 * Il dit ce que le joueur a gagné ET ce qu'il peut faire de nouveau : un
 * message qui se contente de « niveau 7 atteint » n'aide personne. Tout est
 * dérivé de la configuration (`game/unlocks.ts`).
 */

export interface LevelUpInfo {
  /** Niveau atteint. */
  level: number;
  /** Nombre de niveaux gagnés par l'action. */
  levelsGained: number;
}

/** Ordre d'affichage des groupes. */
const GROUP_ORDER: UnlockKind[] = ['feature', 'crop', 'animal', 'building', 'building_tier', 'recipe', 'item', 'pet'];
/** Au-delà, on résume par « et N de plus » pour rester sous la limite d'un champ. */
const MAX_PER_GROUP = 6;

function unlockLabel(unlock: Unlock, t: Translator): string {
  switch (unlock.kind) {
    case 'feature':
      return `${unlock.emoji} ${t(`levelup.features.${unlock.key}`, { tier: unlock.tier ?? 0 })}`;
    case 'pet':
      return `${unlock.emoji} ${t(`pets.catalog.${unlock.key}.title`)}`;
    case 'building_tier':
      return `${unlock.emoji} ${t('levelup.tier_name', { name: unlock.name ?? unlock.key, tier: unlock.tier ?? 1 })}`;
    default:
      return `${unlock.emoji} ${unlock.name ?? unlock.key}`;
  }
}

/** Lignes « groupe : a · b · c » des déblocages, dans l'ordre d'affichage. */
export function unlockLines(unlocks: Unlock[], t: Translator): string[] {
  const lines: string[] = [];
  for (const kind of GROUP_ORDER) {
    const group = unlocks.filter((unlock) => unlock.kind === kind);
    if (group.length === 0) continue;
    const shown = group.slice(0, MAX_PER_GROUP).map((unlock) => unlockLabel(unlock, t));
    const more = group.length > MAX_PER_GROUP
      ? t('levelup.more', { count: group.length - MAX_PER_GROUP })
      : '';
    lines.push(t('levelup.group_line', { label: t(`levelup.groups.${kind}`), list: shown.join(' · ') + more }));
  }
  return lines;
}

/** Corps du bloc : récompense, déblocages, puis prochain palier notable. */
export function levelUpBody(levelUp: LevelUpInfo, t: Translator, locale?: string): string {
  const catalog = getConfig(locale);
  const from = levelUp.level - Math.max(1, levelUp.levelsGained);
  const rewards = levelRewardsBetween(catalog.balance, from, levelUp.level);
  const lines: string[] = [];

  const rewardParts = [
    rewards.coins > 0 ? formatCoins(rewards.coins, false, locale) : '',
    rewards.gems > 0 ? formatGems(rewards.gems, locale) : '',
  ].filter(Boolean);
  if (rewardParts.length > 0) lines.push(t('levelup.reward_line', { rewards: rewardParts.join(' · ') }));

  const unlocked = unlockLines(unlocksBetween(catalog, from, levelUp.level), t);
  if (unlocked.length > 0) {
    lines.push(t('levelup.unlocked_header'), ...unlocked);
  }

  const next = nextUnlock(catalog, levelUp.level);
  if (next) {
    const preview = next.unlocks.slice(0, 3).map((unlock) => unlockLabel(unlock, t));
    const more = next.unlocks.length > 3 ? t('levelup.more', { count: next.unlocks.length - 3 }) : '';
    lines.push(t('levelup.next_line', { level: next.level, list: preview.join(' · ') + more }));
  }

  return lines.join('\n');
}

export function levelUpTitle(levelUp: LevelUpInfo, t: Translator): string {
  return levelUp.levelsGained > 1
    ? t('levelup.title_multi', { level: levelUp.level, gained: levelUp.levelsGained })
    : t('levelup.title', { level: levelUp.level });
}

/** Champ d'embed prêt à ajouter, ou `null` s'il n'y a pas eu de montée de niveau. */
export function levelUpField(
  levelUp: LevelUpInfo | null | undefined,
  t: Translator,
  locale?: string,
): APIEmbedField | null {
  if (!levelUp || levelUp.levelsGained <= 0) return null;
  const value = levelUpBody(levelUp, t, locale);
  return {
    name: levelUpTitle(levelUp, t),
    value: (value || t('levelup.no_unlock')).slice(0, 1024),
    inline: false,
  };
}

/** Version texte (réponses sans embed) : titre en gras puis corps. */
export function levelUpText(levelUp: LevelUpInfo | null | undefined, t: Translator, locale?: string): string {
  const field = levelUpField(levelUp, t, locale);
  return field ? `**${field.name}**\n${field.value}` : '';
}

/** Ajoute le bloc à un embed s'il y a eu montée de niveau ; renvoie l'embed. */
export function withLevelUp<T extends { addFields: (...fields: APIEmbedField[]) => unknown }>(
  embed: T,
  levelUp: LevelUpInfo | null | undefined,
  t: Translator,
  locale?: string,
): T {
  const field = levelUpField(levelUp, t, locale);
  if (field) embed.addFields(field);
  return embed;
}

/** Cumule plusieurs montées (réclamations groupées) : dernier niveau, total des niveaux gagnés. */
export function mergeLevelUps(levelUps: Array<LevelUpInfo | null | undefined>): LevelUpInfo | null {
  const gained = levelUps.filter((entry): entry is LevelUpInfo => !!entry && entry.levelsGained > 0);
  if (gained.length === 0) return null;
  return {
    level: Math.max(...gained.map((entry) => entry.level)),
    levelsGained: gained.reduce((total, entry) => total + entry.levelsGained, 0),
  };
}
