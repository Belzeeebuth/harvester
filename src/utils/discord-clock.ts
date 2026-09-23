import { moduleLogger } from './logger';

const log = moduleLogger('clock');

/**
 * Horloge de ce serveur contre horloge de Discord.
 *
 * Chaque interaction porte l'instant de sa création, daté par Discord (son
 * identifiant est un snowflake). `Date.now() - createdTimestamp` vaut donc :
 *
 *     décalage de notre horloge  +  délai d'acheminement par la passerelle
 *
 * Le délai n'est jamais négatif et tombe souvent à quelques dizaines de
 * millisecondes : le MINIMUM observé sur une fenêtre glissante est une bonne
 * estimation du décalage seul. Ce qui dépasse ce minimum est du retard.
 *
 * Deux usages :
 *  - comparer un instant Discord à un instant local (la pêche juge le clic à
 *    3 s près : sur un serveur dont l'horloge traîne de deux minutes, faute de
 *    NTP joignable, TOUTES les prises étaient « trop tard ») ;
 *  - voir dans les journaux les interactions livrées trop tard. Discord
 *    abandonne une interaction sans accusé au bout de 3 s et affiche
 *    « L'application ne répond plus » : quand le retard est pris AVANT notre
 *    code (connexion passerelle dégradée), aucun traitement rapide n'y change
 *    rien, et sans cette mesure l'épisode ne laisse aucune trace.
 */

/** Fenêtre d'estimation. Mesurée sur l'horloge monotone : l'autre peut sauter. */
const WINDOW_MS = 5 * 60_000;
/** Au-delà, l'écart entre mesures ne peut plus être du retard : l'horloge a été recalée. */
const STEP_MS = 5_000;
/** Nombre de mesures concordantes qui confirment un recalage. */
const STEP_CONFIRMATIONS = 3;
/** Décalage qui fausse les horaires affichés aux joueurs : à signaler. */
const SKEW_WARNING_MS = 2_000;
const SKEW_WARNING_EVERY_MS = 30 * 60_000;
/** Retard au-delà duquel Discord aura très probablement abandonné l'interaction. */
export const LATE_INTERACTION_MS = 2_000;

interface Sample {
  /** Instant de la mesure, horloge monotone. */
  at: number;
  /** `Date.now() - createdTimestamp` au moment de la mesure. */
  delta: number;
}

let samples: Sample[] = [];
let lastSkewWarningAt = Number.NEGATIVE_INFINITY;

function minimum(list: Sample[]): number {
  return list.reduce((min, sample) => Math.min(min, sample.delta), Number.POSITIVE_INFINITY);
}

/** Ne garde que les mesures encore dans la fenêtre glissante (horloge monotone). */
function prune(monotonic: number): void {
  samples = samples.filter((sample) => monotonic - sample.at <= WINDOW_MS);
}

/**
 * Décalage estimé de notre horloge par rapport à celle de Discord (positif : nous
 * avançons), ou `undefined` faute de mesure récente.
 *
 * Les mesures sont élaguées À LA LECTURE aussi : sans cela, un bot sans trafic
 * exportait pendant des jours la dernière valeur vue (-116 s, alors que
 * l'horloge avait été recalée depuis), et la jauge ne voulait plus rien dire.
 */
export function clockOffsetEstimate(monotonic: number = performance.now()): number | undefined {
  prune(monotonic);
  return samples.length > 0 ? minimum(samples) : undefined;
}

/** Décalage estimé, ou 0 faute de mesure récente dans la fenêtre. */
export function clockOffsetMs(monotonic: number = performance.now()): number {
  return clockOffsetEstimate(monotonic) ?? 0;
}

/** Valeur de la jauge Prometheus : `NaN` (inconnu) plutôt qu'une mesure périmée. */
export function formatClockOffset(estimate: number | undefined): string {
  return estimate === undefined ? 'NaN' : String(Math.round(estimate));
}

/** Convertit un instant daté par Discord en instant de NOTRE horloge. */
export function toLocalClock(discordTimestamp: number): number {
  return discordTimestamp + clockOffsetMs();
}

/**
 * Enregistre une interaction reçue et renvoie le décalage estimé ainsi que le
 * retard d'acheminement de CETTE interaction.
 */
export function observeInteraction(
  createdTimestamp: number,
  now: number = Date.now(),
  monotonic: number = performance.now(),
): { offsetMs: number; lagMs: number } {
  prune(monotonic);
  samples.push({ at: monotonic, delta: now - createdTimestamp });

  // Horloge recalée vers l'avant (NTP enfin joignable, correction manuelle) :
  // toutes les mesures montent d'un coup et le minimum resterait celui d'avant
  // jusqu'à la fin de la fenêtre. Un retard isolé ne passe pas ce filtre, il
  // faut plusieurs mesures d'affilée. Un recalage vers l'arrière n'a pas besoin
  // d'aide : le minimum le suit tout seul.
  const recent = samples.slice(-STEP_CONFIRMATIONS);
  const older = samples.slice(0, -STEP_CONFIRMATIONS);
  if (
    recent.length === STEP_CONFIRMATIONS &&
    older.length > 0 &&
    minimum(recent) - minimum(older) > STEP_MS
  ) {
    samples = recent;
  }

  const offsetMs = clockOffsetMs(monotonic);
  if (Math.abs(offsetMs) > SKEW_WARNING_MS && monotonic - lastSkewWarningAt > SKEW_WARNING_EVERY_MS) {
    lastSkewWarningAt = monotonic;
    log.warn(
      { offsetMs: Math.round(offsetMs) },
      "horloge du serveur décalée par rapport à Discord : les horaires affichés aux joueurs sont faux d'autant (vérifier la synchronisation NTP de l'hôte)",
    );
  }

  return { offsetMs, lagMs: Math.max(0, now - createdTimestamp - offsetMs) };
}

/** Remise à zéro, pour les tests. */
export function resetDiscordClock(): void {
  samples = [];
  lastSkewWarningAt = Number.NEGATIVE_INFINITY;
}
