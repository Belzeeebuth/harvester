import { describe, expect, it } from 'vitest';
import { getActiveSeasonPass, getConfig } from '../src/config';

/**
 * Le passe saisonnier a vécu trois mois sans successeur : après le 20 juin
 * 2026, `getActiveSeasonPass` ne renvoyait plus rien et l'XP de passe était
 * jetée sans un mot. Ce test échoue dès qu'il reste moins d'un an de passes
 * programmés : c'est le rappel d'en écrire les suivants.
 */

const DAY = 86_400_000;

describe('calendrier des passes saisonniers', () => {
  const passes = getConfig()
    .seasonPasses.filter((pass) => pass.active)
    .map((pass) => ({
      id: pass.id,
      start: new Date(pass.startsAt).getTime(),
      end: new Date(pass.endsAt).getTime(),
    }))
    .sort((a, b) => a.start - b.start);

  it('chaque passe a des dates valides', () => {
    for (const pass of passes) {
      expect(Number.isFinite(pass.start), pass.id).toBe(true);
      expect(Number.isFinite(pass.end), pass.id).toBe(true);
      expect(pass.end, pass.id).toBeGreaterThan(pass.start);
    }
  });

  it("aucun chevauchement : deux passes ne sont jamais actifs au même instant", () => {
    for (let i = 1; i < passes.length; i++) {
      const previous = passes[i - 1]!;
      const current = passes[i]!;
      expect(current.start, `${previous.id} / ${current.id}`).toBeGreaterThan(previous.end);
    }
  });

  it("un passe couvre chaque instant d'aujourd'hui à dans un an", () => {
    const from = Date.now();
    const to = from + 365 * DAY;
    // Les bornes sont inclusives (`startsAt <= now <= endsAt`) : le passe
    // suivant doit démarrer à la milliseconde qui suit la fin du précédent.
    const covering = passes.filter((pass) => pass.end >= from && pass.start <= to);
    expect(covering.length).toBeGreaterThan(0);
    expect(covering[0]!.start).toBeLessThanOrEqual(from);
    expect(covering.at(-1)!.end).toBeGreaterThanOrEqual(to);
    for (let i = 1; i < covering.length; i++) {
      expect(covering[i]!.start - covering[i - 1]!.end, covering[i]!.id).toBe(1);
    }
  });

  it('getActiveSeasonPass renvoie un passe à chaque jour de l’année à venir', () => {
    const from = Date.now();
    for (let t = from; t <= from + 365 * DAY; t += DAY / 4) {
      expect(getActiveSeasonPass(new Date(t)), new Date(t).toISOString()).toBeDefined();
    }
  });
});
