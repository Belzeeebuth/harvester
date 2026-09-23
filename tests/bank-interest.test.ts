import { describe, expect, it } from 'vitest';
import { interestCutoff, isInterestDue } from '../src/jobs/bank-interest';

/**
 * Échéance des intérêts bancaires.
 *
 * Bogue d'origine : éligible si `last_interest_at <= début du job - 24 h`, alors
 * que `last_interest_at` était horodaté un peu APRÈS le début du job. Le
 * lendemain, le versement de la veille dépassait la borne de quelques
 * secondes : un jour sur deux, rien n'était versé.
 */

const DAY = 86_400_000;
const START = Date.UTC(2026, 8, 1, 3, 0, 0);

/** Pseudo-aléa déterministe (LCG) pour la gigue du planificateur. */
function jitterSequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/**
 * Simule `days` exécutions quotidiennes à 03:00 UTC, avec une gigue de départ
 * et un délai de traitement avant l'horodatage du compte. Renvoie le nombre de
 * versements.
 */
function simulate(
  days: number,
  isDue: (lastInterestAt: Date, runStart: Date) => boolean,
  seed = 42,
): number {
  const random = jitterSequence(seed);
  let lastInterestAt = new Date(START - DAY + 5_000);
  let payments = 0;
  for (let day = 0; day < days; day += 1) {
    // Départ entre 02:59:30 et 03:02:00 (horloge imprécise, file BullMQ chargée).
    const runStart = new Date(START + day * DAY - 30_000 + Math.floor(random() * 150_000));
    if (isDue(lastInterestAt, runStart)) {
      // Le compte est horodaté pendant la boucle, jusqu'à une minute plus tard.
      lastInterestAt = new Date(runStart.getTime() + Math.floor(random() * 60_000));
      payments += 1;
    }
  }
  return payments;
}

describe('intérêts bancaires : échéance', () => {
  it('borne au début du jour UTC', () => {
    expect(interestCutoff(new Date(Date.UTC(2026, 8, 23, 3, 1, 7))).toISOString()).toBe(
      '2026-09-23T00:00:00.000Z',
    );
  });

  it('verse chaque jour malgré la gigue du planificateur', () => {
    for (const seed of [1, 7, 42, 1_234, 99_999]) {
      expect(simulate(60, isInterestDue, seed)).toBe(60);
    }
  });

  it("l'ancienne règle (24 h glissantes) sautait des jours", () => {
    const legacy = (last: Date, runStart: Date) => last.getTime() <= runStart.getTime() - DAY;
    expect(simulate(60, legacy)).toBeLessThan(45);
  });

  it('ne verse pas deux fois le même jour (relance du job)', () => {
    const paidAt = new Date(Date.UTC(2026, 8, 23, 3, 0, 12));
    expect(isInterestDue(paidAt, new Date(Date.UTC(2026, 8, 23, 15, 0, 0)))).toBe(false);
    expect(isInterestDue(paidAt, new Date(Date.UTC(2026, 8, 23, 23, 59, 59)))).toBe(false);
    expect(isInterestDue(paidAt, new Date(Date.UTC(2026, 8, 24, 2, 59, 0)))).toBe(true);
  });

  it("ne rattrape pas un jour manqué : un seul versement à la reprise", () => {
    const paidAt = new Date(Date.UTC(2026, 8, 20, 3, 0, 5));
    // Job arrêté les 21 et 22 : le 23, un versement, puis plus rien le même jour.
    const run = new Date(Date.UTC(2026, 8, 23, 3, 0, 0));
    expect(isInterestDue(paidAt, run)).toBe(true);
    expect(isInterestDue(new Date(run.getTime() + 1_000), run)).toBe(false);
  });
});
