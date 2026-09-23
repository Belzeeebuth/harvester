import { describe, expect, it } from 'vitest';
import { balance as getBalance } from '../src/config';
import { projectEnergy, restoreEnergy, spendEnergy } from '../src/game/energy';

// La régénération se calcule à la lecture : ces tests vérifient que la
// fraction de minute en cours n'est plus perdue à chaque action.
const base = getBalance();
const balance = { ...base, energy: { ...base.energy, enabled: true, regenPerMinute: 1 } };
const t0 = new Date('2026-07-01T10:00:00Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

describe('régénération de l\'énergie', () => {
  it('place l\'ancre au moment où le point courant a été atteint', () => {
    const projection = projectEnergy({ energy: 10, energyMax: 100, energyUpdatedAt: t0 }, at(90), balance);
    expect(projection.current).toBe(11);
    expect(projection.anchor.getTime()).toBe(at(60).getTime());
    expect(projection.minutesToNextPoint).toBeCloseTo(0.5);
    // 89 points manquants à partir de l'ancre (t0 + 60 s).
    expect(projection.fullAt?.getTime()).toBe(at(60 + 89 * 60).getTime());
  });

  it('conserve la fraction de minute quand on agit souvent', () => {
    // Une action toutes les 40 s pendant 10 minutes : sans ancre, chaque
    // action repartait de zéro et aucun point ne revenait jamais.
    let state = { energy: 50, energyMax: 100, energyUpdatedAt: t0 };
    for (let step = 1; step <= 15; step += 1) {
      const now = at(step * 40);
      const projection = projectEnergy(state, now, balance);
      state = { ...state, ...spendEnergy(projection, 0, now) };
    }
    const final = projectEnergy(state, at(600), balance);
    expect(final.current).toBe(60);
  });

  it('dépense sans toucher à la fraction en cours', () => {
    const projection = projectEnergy({ energy: 20, energyMax: 100, energyUpdatedAt: t0 }, at(150), balance);
    const next = spendEnergy(projection, 5, at(150));
    expect(next.energy).toBe(17);
    expect(next.energyUpdatedAt.getTime()).toBe(at(120).getTime());
    // 30 s plus tard, le point suivant est déjà là.
    expect(projectEnergy({ ...next, energyMax: 100 }, at(180), balance).current).toBe(18);
  });

  it('repart de maintenant quand l\'énergie était pleine', () => {
    const projection = projectEnergy({ energy: 100, energyMax: 100, energyUpdatedAt: t0 }, at(3600), balance);
    expect(projection.fullAt).toBeNull();
    expect(projection.minutesToNextPoint).toBe(0);
    const next = spendEnergy(projection, 10, at(3600));
    expect(next.energyUpdatedAt.getTime()).toBe(at(3600).getTime());
  });

  it('ne dépasse jamais le maximum et ne passe pas sous zéro', () => {
    const projection = projectEnergy({ energy: 3, energyMax: 100, energyUpdatedAt: t0 }, at(30), balance);
    expect(spendEnergy(projection, 10, at(30)).energy).toBe(0);
    const restored = restoreEnergy(projection, 500, at(30));
    expect(restored.energy).toBe(100);
    expect(restored.energyUpdatedAt.getTime()).toBe(at(30).getTime());
  });

  it('garde la fraction après un jus d\'énergie partiel', () => {
    const projection = projectEnergy({ energy: 10, energyMax: 100, energyUpdatedAt: t0 }, at(45), balance);
    const restored = restoreEnergy(projection, 20, at(45));
    expect(restored.energy).toBe(30);
    expect(restored.energyUpdatedAt.getTime()).toBe(t0.getTime());
  });
});
