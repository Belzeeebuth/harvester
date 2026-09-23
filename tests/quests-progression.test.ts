import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../src/repositories/progression.repo';
import { balance as getBalance, getConfig } from '../src/config';
import * as progression from '../src/services/progression.service';

/**
 * Quêtes et série quotidienne : les correctifs testables sans base.
 *
 * Le dépôt est remplacé par des doublures pour vérifier deux invariants de
 * transaction (toutes les requêtes d'assignation passent par l'exécuteur
 * transmis) ; le reste est de la logique pure.
 */

// `vi.mock` est remonté avant les imports : le service reçoit les doublures.
vi.mock('../src/repositories/progression.repo', () => ({
  listCycleQuests: vi.fn(() => Promise.resolve([])),
  listQuestPool: vi.fn(() => Promise.resolve([])),
  highestStoryStep: vi.fn(() => Promise.resolve(0)),
  nextStoryQuest: vi.fn(() => Promise.resolve(undefined)),
  assignQuests: vi.fn(() => Promise.resolve(undefined)),
  getUserLevel: vi.fn(() => Promise.resolve(5)),
}));

const balance = getBalance();
const config = getConfig();

describe('objectifs mis à l’échelle : toujours atteignables dans leur cycle', () => {
  const scalable = [...config.quests.values()].filter(
    (quest) => quest.type === 'daily' || quest.type === 'weekly',
  );

  it('ne dépasse jamais un plafond connu, du niveau requis au niveau maximal', () => {
    for (const quest of scalable) {
      const days = progression.cycleDays(quest.type) ?? 1;
      for (let level = quest.requiredLevel; level <= balance.progression.maxLevel; level += 1) {
        // Tous les jours restants possibles : une hebdomadaire peut être
        // attribuée en cours de semaine.
        for (let daysLeft = 1; daysLeft <= days; daysLeft += 1) {
          const required = progression.questRequirement(quest, level, daysLeft);
          const cap = progression.objectiveCap(quest.objectiveType, daysLeft);
          expect(required, `${quest.key} niveau ${level}`).toBeGreaterThanOrEqual(1);
          if (cap !== null) {
            expect(required, `${quest.key} niveau ${level}, ${daysLeft} j`).toBeLessThanOrEqual(cap);
          }
        }
      }
    }
  });

  it('garde la valeur de base pour la connexion hebdomadaire et les aides', () => {
    const login = config.quests.get('weekly_login_5')!;
    expect(progression.questRequirement(login, 11)).toBe(5);
    expect(progression.questRequirement(login, balance.progression.maxLevel)).toBe(5);
    // Attribuée un vendredi : il ne reste que trois jours de connexion.
    expect(progression.questRequirement(login, 30, 3)).toBe(3);

    const help = config.quests.get('daily_help_3')!;
    expect(progression.questRequirement(help, balance.progression.maxLevel)).toBeLessThanOrEqual(
      balance.social.maxHelpsPerDay,
    );
  });

  it('continue de faire grandir les objectifs libres avec le niveau', () => {
    const harvest = config.quests.get('daily_harvest_any_10')!;
    expect(progression.questRequirement(harvest, 1)).toBe(10);
    expect(progression.questRequirement(harvest, 21)).toBe(20);
  });

  it('ne met à l’échelle ni la chaîne narrative ni les contrats', () => {
    for (const quest of config.quests.values()) {
      if (quest.type !== 'story' && quest.type !== 'contract') continue;
      expect(progression.questRequirement(quest, balance.progression.maxLevel)).toBe(quest.requiredAmount);
    }
  });
});

describe('quêtes d’artisanat : la cible correspond à une vraie recette', () => {
  it('chaque cible craft_item est couverte par au moins une recette', () => {
    const targets = [
      ...[...config.quests.values()]
        .filter((quest) => quest.objectiveType === 'craft_item')
        .map((quest) => ({ key: quest.key, target: quest.objectiveTarget })),
      ...[...config.achievements.values()]
        .filter((achievement) => achievement.conditionType === 'craft_item')
        .map((achievement) => ({
          key: achievement.key,
          target: achievement.conditionTarget,
        })),
    ];
    expect(targets.length).toBeGreaterThan(0);

    for (const { key, target } of targets) {
      // Même règle que `progressQuests` : la cible doit être un sous-ensemble
      // de `{ recipeKey, recipeCategory }` suivi par `collectProduction`.
      const matched = [...config.recipes.values()].some((recipe) => {
        const tracked: Record<string, string> = { recipeKey: recipe.key, recipeCategory: recipe.category };
        return Object.entries(target).every(([field, value]) => value === undefined || tracked[field] === value);
      });
      expect(matched, key).toBe(true);
    }
  });
});

describe('relances de quête', () => {
  it('coûte 500 puis double, dans la limite quotidienne', () => {
    expect(balance.quests.maxRerollsPerDay).toBe(3);
    const costs = Array.from({ length: balance.quests.maxRerollsPerDay }, (_, index) => progression.rerollCost(index));
    expect(costs).toEqual([500, 1000, 2000]);
  });
});

describe('série quotidienne : la veille en jours calendaires', () => {
  it('25 octobre 2026, 23:30 à Paris (passage à l’heure d’hiver ce jour-là)', () => {
    // 23:30 CET = 22:30 UTC ; `now - 24 h` tombait encore le 25.
    expect(progression.previousDailyCycleKey(new Date('2026-10-25T22:30:00Z'))).toBe('2026-10-24');
    expect(progression.previousDailyCycleKey(new Date('2026-10-26T00:30:00Z'))).toBe('2026-10-25');
  });

  it('29 et 30 mars 2026 (passage à l’heure d’été le 29)', () => {
    // 30 mars 00:30 CEST = 29 mars 22:30 UTC ; `now - 24 h` donnait le 28.
    expect(progression.previousDailyCycleKey(new Date('2026-03-29T22:30:00Z'))).toBe('2026-03-29');
    // 29 mars 23:30 CEST.
    expect(progression.previousDailyCycleKey(new Date('2026-03-29T21:30:00Z'))).toBe('2026-03-28');
    // 29 mars 01:30 CET, avant le changement.
    expect(progression.previousDailyCycleKey(new Date('2026-03-29T00:30:00Z'))).toBe('2026-03-28');
  });
});

describe('assignation des quêtes dans la transaction de l’appelant', () => {
  const now = new Date('2026-09-23T10:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
    progression.resetEnsuredCyclesForTests();
  });

  it('passe l’exécuteur à chaque requête du dépôt', async () => {
    const pool = [...config.quests.values()]
      .filter((quest) => quest.type === 'daily')
      .map((quest) => ({ ...quest, chainKey: null, chainStep: null }));
    vi.mocked(repo.listQuestPool).mockResolvedValue(pool as never);
    const tx = { marker: 'tx' } as never;

    const assigned = await progression.ensureQuests({ id: 'u1', level: 60 }, 'Europe/Paris', now, tx);
    expect(assigned).toBeGreaterThan(0);

    for (const fn of [repo.listCycleQuests, repo.listQuestPool, repo.highestStoryStep, repo.nextStoryQuest, repo.assignQuests]) {
      const calls = vi.mocked(fn).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.at(-1)).toBe(tx);
    }
  });

  it('assigne avant l’action, puis ne relit plus une fois le cycle complet', async () => {
    const transaction = vi.fn(async (fn: (scope: unknown) => Promise<unknown>) => fn('scope'));
    const tx = { transaction } as never;
    vi.mocked(repo.listQuestPool).mockResolvedValueOnce([
      { ...config.quests.get('daily_plant_10')!, chainKey: null, chainStep: null },
    ] as never);

    // Premier passage : des quêtes sont insérées, rien n'est mémorisé (la
    // transaction pourrait encore être annulée).
    await progression.ensureQuestsForAction({ userId: 'u2', level: 5 }, tx, 'Europe/Paris', now);
    expect(repo.assignQuests).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.assignQuests).mock.calls[0]![1]).toBe('scope');

    // Deuxième passage : tout existe déjà, le cycle est mémorisé.
    vi.mocked(repo.listQuestPool).mockResolvedValue([]);
    await progression.ensureQuestsForAction({ userId: 'u2', level: 5 }, tx, 'Europe/Paris', now);
    expect(transaction).toHaveBeenCalledTimes(2);

    await progression.ensureQuestsForAction({ userId: 'u2', level: 5 }, tx, 'Europe/Paris', now);
    expect(transaction).toHaveBeenCalledTimes(2);

    // Une montée de niveau relance la vérification (étape narrative suivante).
    await progression.ensureQuestsForAction({ userId: 'u2', level: 6 }, tx, 'Europe/Paris', now);
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
