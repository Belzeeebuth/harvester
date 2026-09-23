import { balance as getBalance, getActiveSeasonPass, getConfig } from '../config';
import type { Executor } from '../db/client';
import * as progressionRepo from '../repositories/progression.repo';
import * as socialRepo from '../repositories/social.repo';
import { currentWeekStart, dailyCycleKey } from '../utils/time';
import { moduleLogger } from '../utils/logger';
import { eventOccurrenceKey, getActiveEvents } from './world.service';

const log = moduleLogger('tracker');

/**
 * ---------------------------------------------------------------------------
 * SUIVI DES ACTIONS DE JEU
 * ---------------------------------------------------------------------------
 * Un seul point d'entrée, `trackAction()`, alimente d'un coup :
 *   • les quêtes journalières / hebdomadaires / narratives / contrats,
 *   • les succès,
 *   • les objectifs hebdomadaires de coopérative,
 *   • les points d'événement,
 *   • l'XP du passe saisonnier.
 *
 * Pourquoi centraliser : sans cela, chaque service (récolte, élevage,
 * artisanat, marché) devrait connaître les cinq systèmes de progression, et
 * ajouter un sixième obligerait à modifier dix fichiers. Ici, `FarmService`
 * dit simplement « le joueur a récolté 12 tomates » et ne se soucie de rien
 * d'autre.
 *
 * Le suivi est appelé DANS la transaction de l'action : si la récolte est
 * annulée, la progression de quête l'est aussi. C'est la raison pour laquelle
 * ces fonctions prennent un `Executor` obligatoire.
 */

export type TrackedAction =
  | 'harvest_crop'
  | 'harvest_any'
  | 'harvest_category'
  | 'plant_seed'
  | 'water_plot'
  | 'fertilize_plot'
  | 'treat_pest'
  | 'collect_animal'
  | 'feed_animal'
  | 'pet_animal'
  | 'craft_item'
  | 'sell_item'
  | 'sell_value'
  | 'earn_coins'
  | 'spend_coins'
  | 'buy_plot'
  | 'reach_level'
  | 'deliver_items'
  | 'visit_farm'
  | 'help_farmer'
  | 'auction_sale'
  | 'login_streak'
  | 'catch_fish'
  | 'mine_ore'
  /** Première obtention d'une entrée de collection (`collection.service`). */
  | 'discover_entry';

export interface TrackTarget extends Record<string, string | undefined> {
  cropKey?: string;
  itemKey?: string;
  animalKey?: string;
  recipeKey?: string;
  recipeCategory?: string;
  category?: string;
  rarity?: string;
  /** Famille de collection d'une découverte (`crop`, `animal`, `variant`…). */
  kind?: string;
}

export interface TrackResult {
  /** Quêtes qui viennent d'être terminées (à annoncer au joueur). */
  completedQuests: Array<{ id: string; title: string }>;
  /** Succès qui viennent d'être débloqués. */
  unlockedAchievements: Array<{ key: string; name: string }>;
  /** Objectifs de coopérative terminés. */
  completedCoopObjectives: string[];
  /** Points d'événement gagnés. */
  eventPoints: number;
}

const EMPTY_RESULT: TrackResult = {
  completedQuests: [],
  unlockedAchievements: [],
  completedCoopObjectives: [],
  eventPoints: 0,
};

/** Correspondance action de jeu → objectif hebdomadaire de coopérative. */
const COOP_OBJECTIVE_BY_ACTION: Partial<Record<TrackedAction, string>> = {
  harvest_any: 'harvest_total',
  craft_item: 'craft_total',
  collect_animal: 'collect_total',
  sell_value: 'sell_value_total',
  help_farmer: 'help_total',
};

/** Correspondance action de jeu → défi quotidien de coopérative (mêmes actions, cible plus petite). */
const COOP_DAILY_OBJECTIVE_BY_ACTION: Partial<Record<TrackedAction, string>> = {
  harvest_any: 'daily_harvest_total',
  craft_item: 'daily_craft_total',
  collect_animal: 'daily_collect_total',
  sell_value: 'daily_sell_value_total',
  help_farmer: 'daily_help_total',
};

export interface TrackContext {
  userId: string;
  coopId?: string | null;
  /** Passé pour éviter une requête : niveau du joueur au moment de l'action. */
  level: number;
}

export async function trackAction(
  context: TrackContext,
  action: TrackedAction,
  amount: number,
  target: TrackTarget,
  tx: Executor,
): Promise<TrackResult> {
  if (amount <= 0) return EMPTY_RESULT;

  const result: TrackResult = {
    completedQuests: [],
    unlockedAchievements: [],
    completedCoopObjectives: [],
    eventPoints: 0,
  };

  // Les quêtes du cycle doivent exister AVANT la progression : `progressQuests`
  // ne fait que mettre à jour des lignes, il n'en crée aucune. Import dynamique :
  // progression.service dépend d'economy.service, qui dépend de ce module.
  // `ensureQuestsForAction` pose son propre point de reprise ; son échec ne
  // coûte que l'assignation, jamais l'action du joueur.
  try {
    const { ensureQuestsForAction } = await import('./progression.service');
    await ensureQuestsForAction(context, tx);
  } catch (error) {
    log.warn({ err: error, action, userId: context.userId }, 'assignation des quêtes impossible');
  }

  // ⚠ POINT DE REPRISE OBLIGATOIRE.
  //
  // Cette fonction s'exécute DANS la transaction de l'action de jeu. En
  // PostgreSQL, une requête en échec fait basculer toute la transaction en état
  // « aborted » : chaque instruction suivante renvoie 25P02 et le COMMIT échoue.
  // Un simple `try/catch` ne sauvait donc rien — il transformait juste un
  // message clair en « erreur interne » et masquait la cause.
  //
  // `tx.transaction()` ouvre un SAVEPOINT quand on lui passe une transaction en
  // cours : l'échec de la progression annule alors la seule progression, et la
  // récolte qui l'a déclenchée survit vraiment.
  try {
    await tx.transaction(async (scope) => {
      await trackWithin(scope, context, action, amount, target, result);
    });
  } catch (error) {
    // La progression est un système SECONDAIRE : son échec ne doit pas coûter au
    // joueur l'action qu'il vient de faire. L'incohérence éventuelle est
    // rattrapée au cycle suivant.
    log.error({ err: error, action, userId: context.userId }, 'progress tracking failed');
  }

  return result;
}

/** Corps de `trackAction`, exécuté sous point de reprise. */
async function trackWithin(
  tx: Executor,
  context: TrackContext,
  action: TrackedAction,
  amount: number,
  target: TrackTarget,
  result: TrackResult,
): Promise<void> {
  {
    const completedQuests = await progressionRepo.progressQuests(
      context.userId,
      action,
      amount,
      target,
      tx,
    );
    for (const quest of completedQuests) {
      const snapshot = quest.snapshot as { title?: string };
      result.completedQuests.push({ id: quest.id, title: snapshot.title ?? quest.questKey });
    }

    const unlocked = await progressionRepo.progressAchievements(
      context.userId,
      action,
      amount,
      target,
      tx,
    );
    result.unlockedAchievements = unlocked.map((entry) => ({ key: entry.key, name: entry.name }));

    // Objectifs de coopérative — hebdomadaire, puis défi quotidien (même clé
    // d'action, deux tables de correspondance distinctes ci-dessus).
    const objectiveKey = COOP_OBJECTIVE_BY_ACTION[action];
    if (context.coopId && objectiveKey) {
      const progressed = await socialRepo.progressObjective(
        context.coopId,
        objectiveKey,
        currentWeekStart(new Date()),
        amount,
        tx,
      );
      if (progressed?.completed) {
        // On pousse la CLÉ, pas un libellé : l'objectif est partagé entre membres
        // de langues potentiellement différentes, donc seul l'affichage (avec le
        // traducteur du joueur qui consulte) peut choisir le bon texte.
        result.completedCoopObjectives.push(objectiveKey);
      }
    }

    const dailyObjectiveKey = COOP_DAILY_OBJECTIVE_BY_ACTION[action];
    if (context.coopId && dailyObjectiveKey) {
      const progressed = await socialRepo.progressObjective(
        context.coopId,
        dailyObjectiveKey,
        dailyCycleKey(new Date()),
        amount,
        tx,
      );
      if (progressed?.completed) {
        result.completedCoopObjectives.push(dailyObjectiveKey);
      }
    }

    // Points d'événement : certains événements accordent des jetons par récolte
    // ou par fabrication.
    const events = getActiveEvents();
    for (const event of events) {
      const perHarvest = event.modifiers.tokenPerHarvest ?? 0;
      const perCraft = event.modifiers.tokenPerCraft ?? 0;
      let points = 0;
      if (action === 'harvest_any' && perHarvest > 0) points = perHarvest * amount;
      if (action === 'craft_item' && perCraft > 0) points = perCraft * amount;
      if (points > 0) {
        await progressionRepo.addEventPoints(
          context.userId,
          event.key,
          points,
          tx,
          eventOccurrenceKey(event),
        );
        result.eventPoints += points;
      }
    }
  }
}

/**
 * Ajoute de l'XP au passe saisonnier actif, s'il y en a un.
 * Retourne le nouveau palier atteint, ou `undefined` si aucun passe n'est actif.
 */
export async function grantPassXp(
  userId: string,
  amount: number,
  tx: Executor,
): Promise<{ tier: number; passXp: number } | undefined> {
  if (amount <= 0) return undefined;
  const pass = getActiveSeasonPass();
  if (!pass) return undefined;
  const result = await progressionRepo.addPassXp(
    userId,
    pass.id,
    amount,
    pass.xpPerTier,
    pass.maxTier,
    tx,
  );
  return result ? { tier: result.tier, passXp: result.passXp } : undefined;
}

/**
 * Suit une récolte : c'est l'action la plus riche du jeu, elle alimente à elle
 * seule cinq objectifs différents (par culture, par catégorie, générique, valeur
 * vendue plus tard, et le compteur d'événement).
 */
export async function trackHarvest(
  context: TrackContext,
  input: { cropKey: string; quantity: number; rarity: string },
  tx: Executor,
): Promise<TrackResult> {
  // Séquentiel, et non `Promise.all` : une transaction Drizzle tient UN SEUL
  // client PostgreSQL. Les paralléliser ne gagnait rien — node-postgres les
  // sérialise de toute façon — et laissait l'ordre d'écriture indéterminé sur
  // des lignes de quête communes.
  const results: TrackResult[] = [];
  results.push(await trackAction(context, 'harvest_any', input.quantity, {}, tx));
  results.push(
    await trackAction(context, 'harvest_crop', input.quantity, { cropKey: input.cropKey }, tx),
  );
  results.push(
    await trackAction(context, 'harvest_category', input.quantity, { category: 'harvest' }, tx),
  );
  return mergeResults(results);
}

export function mergeResults(results: TrackResult[]): TrackResult {
  return results.reduce<TrackResult>(
    (accumulator, current) => ({
      completedQuests: [...accumulator.completedQuests, ...current.completedQuests],
      unlockedAchievements: [
        ...accumulator.unlockedAchievements,
        ...current.unlockedAchievements.filter(
          (entry) => !accumulator.unlockedAchievements.some((seen) => seen.key === entry.key),
        ),
      ],
      completedCoopObjectives: [
        ...new Set([...accumulator.completedCoopObjectives, ...current.completedCoopObjectives]),
      ],
      eventPoints: accumulator.eventPoints + current.eventPoints,
    }),
    { completedQuests: [], unlockedAchievements: [], completedCoopObjectives: [], eventPoints: 0 },
  );
}

/** XP de passe accordée par une action, dérivée de l'XP de jeu. */
export function passXpFor(gameXp: number): number {
  // 25 % de l'XP de jeu alimente le passe : le passe progresse donc en JOUANT,
  // pas en payant, et suit naturellement l'intensité de jeu.
  return Math.floor(gameXp * 0.25);
}

/** Quantité de jetons d'événement à créditer pour une action donnée. */
export function eventCurrencyFor(action: TrackedAction, amount: number): Array<{ itemKey: string; quantity: number }> {
  const config = getConfig();
  const rewards: Array<{ itemKey: string; quantity: number }> = [];
  for (const event of getActiveEvents()) {
    if (!event.currencyItemKey || !config.items.has(event.currencyItemKey)) continue;
    const perHarvest = event.modifiers.tokenPerHarvest ?? 0;
    const perCraft = event.modifiers.tokenPerCraft ?? 0;
    if (action === 'harvest_any' && perHarvest > 0) {
      rewards.push({ itemKey: event.currencyItemKey, quantity: perHarvest * amount });
    }
    if (action === 'craft_item' && perCraft > 0) {
      rewards.push({ itemKey: event.currencyItemKey, quantity: perCraft * amount });
    }
  }
  return rewards;
}

/** Bornes d'un cycle de quête, exposées pour l'affichage. */
export function questCycleInfo(): { balanceQuests: ReturnType<typeof getBalance>['quests'] } {
  return { balanceQuests: getBalance().quests };
}
