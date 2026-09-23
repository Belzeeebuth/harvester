import { describe, expect, it } from 'vitest';
import { coopRejoinAvailableAt, objectivePayoutMembers } from '../src/services/coop.service';

/**
 * Coopératives : délai après un départ et droit aux récompenses d'objectif.
 *
 * Faille d'origine : `coop.leaveCooldownHours` n'était lu nulle part. Un joueur
 * rejoignait une coop dont l'objectif venait d'être atteint, touchait sa part
 * au passage du job, repartait, et recommençait ailleurs.
 */

const HOUR = 3_600_000;
const NOW = new Date(Date.UTC(2026, 8, 23, 12, 0, 0));

describe('délai avant de rejoindre une coopérative', () => {
  it('libre sans départ connu', () => {
    expect(coopRejoinAvailableAt(undefined, 24, NOW)).toBeUndefined();
  });

  it('bloque pendant le délai et donne la date de fin', () => {
    const left = new Date(NOW.getTime() - 3 * HOUR);
    expect(coopRejoinAvailableAt(left, 24, NOW)?.toISOString()).toBe(
      new Date(left.getTime() + 24 * HOUR).toISOString(),
    );
  });

  it('libre une fois le délai écoulé, ou si le délai est nul', () => {
    expect(coopRejoinAvailableAt(new Date(NOW.getTime() - 24 * HOUR), 24, NOW)).toBeUndefined();
    expect(coopRejoinAvailableAt(new Date(NOW.getTime() - HOUR), 0, NOW)).toBeUndefined();
  });
});

describe('membres payés pour un objectif', () => {
  const member = (id: string, joinedAt: Date) => ({ id, member: { joinedAt } });
  const completedAt = new Date(NOW.getTime() - 2 * HOUR);
  const members = [
    member('fondateur', new Date(NOW.getTime() - 30 * 24 * HOUR)),
    member('pile', completedAt),
    member('opportuniste', new Date(completedAt.getTime() + 60_000)),
  ];

  it("exclut ceux arrivés après l'achèvement", () => {
    expect(objectivePayoutMembers(members, completedAt).map((entry) => entry.id)).toEqual([
      'fondateur',
      'pile',
    ]);
  });

  it("paie tout le monde si la date d'achèvement manque (lignes anciennes)", () => {
    expect(objectivePayoutMembers(members, null)).toHaveLength(3);
  });
});
