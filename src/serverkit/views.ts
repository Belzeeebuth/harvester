import type { APIEmbedField, EmbedBuilder } from 'discord.js';
import { COLORS, baseEmbed } from '../framework/ui';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../i18n';
import { FANCY_FONTS, type FancyFont } from '../utils/fancy-text';
import { progressBar } from '../utils/format';
import type { Translator } from '../types';
import {
  planTotals,
  type BuildOptions,
  type ExistingMode,
  type KitPlan,
  type KitReport,
  type KitScope,
  type Progress,
} from './builder';
import { DEFAULT_FONT, DEFAULT_FRAME, FRAMES, categoryName, textChannelName, type Frame, type KitStyle } from './naming';

/**
 * Écrans de `/serverkit` : galerie de styles, plan, confirmation, avancement,
 * rapport. Partagés entre la commande et ses boutons de confirmation.
 */

export const KIT_SCOPES: KitScope[] = ['all', 'roles', 'channels', 'settings', 'panels'];
export const EXISTING_MODES: ExistingMode[] = ['keep', 'sync'];

/** Noms affichés dans les choix de la commande (anglais : payload Discord). */
export const FONT_LABELS: Record<FancyFont, string> = {
  bold: 'Bold serif',
  sans: 'Bold modern',
  italic: 'Bold italic',
  script: 'Script',
  gothic: 'Gothic',
  double: 'Double struck',
  mono: 'Typewriter',
  smallcaps: 'Small caps',
  wide: 'Wide',
  plain: 'Plain',
};

export const FRAME_LABELS: Record<Frame, string> = {
  dot: 'Dot',
  bracket: 'Brackets',
  bar: 'Bar',
  cloud: 'Cloud',
  sparkle: 'Sparkle',
};

const oneOf = <T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Style validé depuis des options de commande ou des paramètres de custom_id. */
export function parseStyle(
  locale: string | null | undefined,
  font: string | null | undefined,
  frame: string | null | undefined,
  fallbackLocale: SupportedLocale,
): KitStyle {
  return {
    locale: oneOf(locale, SUPPORTED_LOCALES, fallbackLocale),
    font: oneOf(font, FANCY_FONTS, DEFAULT_FONT),
    frame: oneOf(frame, FRAMES, DEFAULT_FRAME),
  };
}

/**
 * Style et options, compactés pour tenir dans un custom_id (100 caractères,
 * dont deux identifiants Discord de 20) : `fr.7.4` = langue, rang de la police,
 * rang du cadre ; `s1` = mode `sync`, Communauté demandée.
 */
export function encodeStyle(style: KitStyle): string {
  return `${style.locale}.${FANCY_FONTS.indexOf(style.font)}.${FRAMES.indexOf(style.frame)}`;
}

export function decodeStyle(token: string, fallbackLocale: SupportedLocale): KitStyle {
  const [locale, font, frame] = token.split('.');
  return parseStyle(locale, FANCY_FONTS[Number(font)], FRAMES[Number(frame)], fallbackLocale);
}

export function encodeFlags(existing: ExistingMode, community: boolean): string {
  return `${existing === 'sync' ? 's' : 'k'}${community ? 1 : 0}`;
}

export function decodeFlags(token: string): { existing: ExistingMode; community: boolean } {
  return { existing: token.startsWith('s') ? 'sync' : 'keep', community: token.endsWith('1') };
}

export function parseScope(value: string | null | undefined): KitScope {
  return oneOf(value, KIT_SCOPES, 'all');
}

export function parseExisting(value: string | null | undefined): ExistingMode {
  return oneOf(value, EXISTING_MODES, 'keep');
}

/**
 * Découpe des lignes en champs d'embed de moins de 1 024 unités UTF-16.
 *
 * `truncate()` coupe à la longueur JavaScript ; or une lettre mathématique
 * occupe DEUX unités (paire de substitution) : tronquer au milieu d'une paire
 * produirait un caractère invalide. On ne tronque donc jamais ces listes, on
 * les répartit.
 */
export function chunkFields(name: string, lines: string[], limit = 1000): APIEmbedField[] {
  const fields: APIEmbedField[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > limit && current.length > 0) {
      fields.push({ name: fields.length === 0 ? name : '\u200b', value: current.join('\n') });
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) fields.push({ name: fields.length === 0 ? name : '\u200b', value: current.join('\n') });
  return fields;
}

export function stylesEmbed(t: Translator, locale: SupportedLocale): EmbedBuilder {
  const sample = t('serverkit.ui.styles_sample');
  return baseEmbed({
    title: t('serverkit.ui.styles_title'),
    description: t('serverkit.ui.styles_body'),
    color: COLORS.xp,
    fields: [
      {
        name: t('serverkit.ui.styles_fonts_field'),
        value: FANCY_FONTS.map(
          (font) => `\`${font}\` ${textChannelName('🛠️', sample, { locale, font, frame: DEFAULT_FRAME })}`,
        ).join('\n'),
      },
      {
        name: t('serverkit.ui.styles_frames_field'),
        value: FRAMES.map((frame) => {
          const style = { locale, font: DEFAULT_FONT, frame };
          return `\`${frame}\` ${textChannelName('🛠️', sample, style)} ・ ${categoryName('🌾', 'Greenvale', style)}`;
        }).join('\n'),
      },
    ],
  });
}

const mark = (item: { existing?: unknown }): string => (item.existing ? '✅' : '➕');

function styleParams(style: KitStyle): Record<string, string> {
  return {
    language: style.locale,
    font: `\`${style.font}\``,
    frame: `\`${style.frame}\``,
  };
}

function summary(plan: KitPlan, t: Translator): string {
  return t('serverkit.ui.summary', planTotals(plan));
}

export function previewEmbed(plan: KitPlan, guildName: string, t: Translator): EmbedBuilder {
  return baseEmbed({
    title: t('serverkit.ui.preview_title'),
    description: t('serverkit.ui.preview_body', { summary: summary(plan, t), guild: guildName, ...styleParams(plan.style) }),
    color: COLORS.primary,
    fields: [
      ...chunkFields(
        t('serverkit.ui.preview_roles_field'),
        plan.roles.map((role) => `${mark(role)} ${role.name}`),
      ),
      ...plan.categories.flatMap((category) =>
        chunkFields(
          `${mark(category)} ${category.name}`,
          category.channels.map((channel) => `${mark(channel)} ${channel.name}`),
        ),
      ),
    ],
  });
}

export function confirmBuildEmbed(plan: KitPlan, options: BuildOptions, guildName: string, t: Translator): EmbedBuilder {
  const sample = plan.categories[0]?.channels[0];
  return baseEmbed({
    title: t('serverkit.ui.confirm_title'),
    description: t('serverkit.ui.confirm_body', {
      summary: summary(plan, t),
      scope: t(`serverkit.ui.scope_${options.scope}`),
      existing: t(`serverkit.ui.existing_${options.existing}`),
      community: t(options.community ? 'serverkit.ui.community_on' : 'serverkit.ui.community_off'),
      sample: `${plan.categories[0]?.name ?? ''} › ${sample?.name ?? ''}`,
      guild: guildName,
      ...styleParams(plan.style),
    }),
    color: COLORS.gold,
  });
}

export function progressEmbed(progress: Progress, t: Translator): EmbedBuilder {
  return baseEmbed({
    title: t('serverkit.ui.progress_title'),
    description: t('serverkit.ui.progress_body', {
      bar: progressBar(progress.done, progress.total, 16),
      phase: t(`serverkit.ui.phase_${progress.phase}`),
      done: progress.done,
      total: progress.total,
    }),
    color: COLORS.info,
  });
}

function outcomeFields(report: KitReport, t: Translator): APIEmbedField[] {
  return [
    ...chunkFields(
      t('serverkit.ui.failures_field'),
      report.failed
        .slice(0, 12)
        .map((failure) => t('serverkit.ui.failure_line', { name: failure.name, reason: failure.reason.slice(0, 120) })),
    ),
    ...chunkFields(
      t('serverkit.ui.notes_field'),
      report.notes.slice(0, 12).map((note) => t(note.key, note.params)),
    ),
  ];
}

const seconds = (report: KitReport): number => Math.max(1, Math.floor(report.durationMs / 1_000));

export function buildReportEmbed(report: KitReport, t: Translator, remindersMention: string): EmbedBuilder {
  return baseEmbed({
    title: t('serverkit.ui.done_title'),
    description: t('serverkit.ui.done_body', {
      created: report.created,
      updated: report.updated,
      kept: report.kept,
      failed: report.failed.length,
      seconds: seconds(report),
    }),
    color: report.failed.length > 0 ? COLORS.warning : COLORS.success,
    fields: [
      ...outcomeFields(report, t),
      { name: t('serverkit.ui.next_field'), value: t('serverkit.ui.next_body', { reminders: remindersMention }) },
    ],
  });
}

export function wipeReportEmbed(report: KitReport, t: Translator): EmbedBuilder {
  return baseEmbed({
    title: t('serverkit.ui.wipe_done_title'),
    description: t('serverkit.ui.wipe_done_body', {
      removed: report.removed,
      failed: report.failed.length,
      seconds: seconds(report),
    }),
    color: report.failed.length > 0 ? COLORS.warning : COLORS.success,
    fields: outcomeFields(report, t),
  });
}
