import { balance as getBalance, getConfig, type EventConfig } from '../config';
import { env } from '../config/env';
import { getDb } from '../db/client';
import { cacheGet, cacheSet, key as redisKey } from '../db/redis';
import { seasonPass } from '../db/schema';
import { currentEventWindow } from '../game/events';
import { seasonAt, nextSeason, rollWeather, type SeasonState, type WeatherState } from '../game/world';
import * as systemRepo from '../repositories/system.repo';
import { toSqlDate } from '../utils/time';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('world');

/**
 * État du monde : saison, météo du jour, événements actifs.
 *
 * Ces trois informations sont lues par presque toutes les commandes de jeu. Elles
 * sont donc mises en cache Redis avec un TTL court (5 min) : la météo ne change
 * qu'une fois par jour, la saison tous les 14 jours, et un cache raté coûte une
 * seule petite requête.
 */

export interface WorldState {
  season: SeasonState;
  weather: WeatherState;
  activeEvents: EventConfig[];
  /** Modificateurs agrégés des événements en cours. */
  eventModifiers: {
    xpMultiplier: number;
    growthMultiplier: number;
    globalPriceMultiplier: number;
    mutationMultiplier: number;
    qualityBonus: number;
    waterMultiplier: number;
    dailyRewardMultiplier: number;
    itemPriceMultipliers: Record<string, number>;
    categoryPriceMultipliers: Record<string, number>;
  };
}

const CACHE_TTL_SECONDS = 300;

export async function getWorldState(now: Date = new Date(), locale?: string): Promise<WorldState> {
  const balance = getBalance();
  const season = seasonAt(now, balance);
  const day = toSqlDate(now);
  const cacheKey = redisKey('world', day, season.key);

  const cached = await cacheGet<{ weather: WeatherState }>(cacheKey);
  let weather: WeatherState;

  if (cached) {
    weather = { ...cached.weather };
  } else {
    weather = await resolveWeather(day, season, now);
    await cacheSet(cacheKey, { weather }, CACHE_TTL_SECONDS);
  }

  // Le libellé/la description mis en cache sont toujours en français (`balance`
  // n'a pas de notion de langue). On les réécrit ici, après lecture du cache,
  // pour ne pas dupliquer l'entrée Redis par langue.
  if (locale?.startsWith('en')) {
    const localized = getConfig(locale).balance.weather.table.find(
      (entry) => entry.weather === weather.weather,
    );
    if (localized) {
      weather = { ...weather, label: localized.label, description: localized.description };
    }
  }

  const activeEvents = getActiveEvents(now, locale);
  return { season, weather, activeEvents, eventModifiers: aggregateEventModifiers(activeEvents) };
}

/**
 * Météo du jour : lue en base si elle existe (un administrateur a pu la forcer),
 * sinon tirée de façon déterministe puis persistée.
 */
async function resolveWeather(day: string, season: SeasonState, now: Date): Promise<WeatherState> {
  const balance = getBalance();
  const existing = await systemRepo.getWeatherForDay(day);
  if (existing) {
    // La table `weather` ne stocke pas de libellé séparé (seulement la
    // description) : on le retrouve dans la configuration par la clé météo,
    // comme le fait `rollWeather()` pour un tirage frais. Un `.slice()` sur la
    // description tronquait ici le libellé au milieu d'un mot.
    const config = balance.weather.table.find((entry) => entry.weather === existing.weather);
    return {
      weather: existing.weather,
      emoji: existing.emoji,
      label: config?.label ?? existing.description,
      description: existing.description,
      yieldModifier: Number(existing.yieldModifier),
      growthModifier: Number(existing.growthModifier),
      freeWatering: existing.freeWatering,
      damageChance: Number(existing.damageChance),
      pestChance: Number(existing.pestChance),
      temperature: existing.temperature,
      season: existing.season,
      day,
    };
  }

  const rolled = rollWeather(day, season.season, balance);
  const forced = getActiveEvents(now).find((event) => event.modifiers.forcedWeather);
  const finalWeather =
    forced?.modifiers.forcedWeather
      ? {
          ...rolled,
          ...(balance.weather.table.find((entry) => entry.weather === forced.modifiers.forcedWeather) ??
            {}),
          weather: forced.modifiers.forcedWeather,
        }
      : rolled;

  await systemRepo.ensureWeather({
    day,
    weather: finalWeather.weather,
    season: season.season,
    temperature: finalWeather.temperature,
    yieldModifier: finalWeather.yieldModifier.toFixed(3),
    growthModifier: finalWeather.growthModifier.toFixed(3),
    freeWatering: finalWeather.freeWatering,
    damageChance: finalWeather.damageChance.toFixed(4),
    pestChance: finalWeather.pestChance.toFixed(4),
    description: finalWeather.description,
    emoji: finalWeather.emoji,
  });

  log.info({ day, weather: finalWeather.weather, season: season.season }, 'daily weather set');
  return finalWeather;
}

/**
 * Événements dont la fenêtre couvre l'instant donné.
 *
 * Trois formes coexistent dans `events.json` :
 *  - dates explicites (`startsAt`/`endsAt`) : une opération ponctuelle ;
 *  - `recurringCron` + `durationHours` : la fenêtre courante est CALCULÉE à la
 *    lecture (game/events.ts). Auparavant on attendait qu'un ordonnanceur
 *    écrive les dates dans la configuration — un fichier JSON en lecture seule,
 *    que personne n'a jamais écrit : cinq évènements sur six ne se sont jamais
 *    déclenchés ;
 *  - ni l'un ni l'autre : évènement permanent, actif tant qu'il est activé.
 *
 * Les évènements récurrents renvoyés portent les dates de LEUR occurrence en
 * cours, pour que `/world` affiche une fin réelle.
 */
export function getActiveEvents(now: Date = new Date(), locale?: string): EventConfig[] {
  const active: EventConfig[] = [];
  for (const event of getConfig(locale).eventList) {
    if (!event.enabled) continue;
    const starts = event.startsAt ? new Date(event.startsAt).getTime() : undefined;
    const ends = event.endsAt ? new Date(event.endsAt).getTime() : undefined;
    if (starts !== undefined && now.getTime() < starts) continue;
    if (ends !== undefined && now.getTime() > ends) continue;

    if (starts === undefined && ends === undefined && event.recurringCron) {
      // `durationHours` est garanti par le schéma dès qu'un cron est posé.
      const window = currentEventWindow(event.recurringCron, event.durationHours ?? 0, now);
      if (!window) continue;
      active.push({
        ...event,
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt.toISOString(),
      });
      continue;
    }
    active.push(event);
  }
  return active;
}

function aggregateEventModifiers(events: EventConfig[]): WorldState['eventModifiers'] {
  const result: WorldState['eventModifiers'] = {
    xpMultiplier: 1,
    growthMultiplier: 1,
    globalPriceMultiplier: 1,
    mutationMultiplier: 1,
    qualityBonus: 0,
    waterMultiplier: 1,
    dailyRewardMultiplier: 1,
    itemPriceMultipliers: {},
    categoryPriceMultipliers: {},
  };

  for (const event of events) {
    const modifiers = event.modifiers;
    result.xpMultiplier *= modifiers.xpMultiplier ?? 1;
    result.growthMultiplier *= modifiers.growthMultiplier ?? 1;
    result.globalPriceMultiplier *= modifiers.globalPriceMultiplier ?? 1;
    result.mutationMultiplier *= modifiers.mutationMultiplier ?? 1;
    result.qualityBonus += modifiers.qualityBonus ?? 0;
    result.waterMultiplier *= modifiers.waterMultiplier ?? 1;
    result.dailyRewardMultiplier *= modifiers.dailyRewardMultiplier ?? 1;
    for (const [itemKey, multiplier] of Object.entries(modifiers.cropPriceMultipliers ?? {})) {
      result.itemPriceMultipliers[itemKey] = (result.itemPriceMultipliers[itemKey] ?? 1) * multiplier;
    }
    for (const [category, multiplier] of Object.entries(modifiers.categoryPriceMultipliers ?? {})) {
      result.categoryPriceMultipliers[category] =
        (result.categoryPriceMultipliers[category] ?? 1) * multiplier;
    }
  }

  return result;
}

/**
 * Clé de l'occurrence en cours d'un événement actif : le début de sa fenêtre
 * pour un événement récurrent ou daté, une constante pour un événement
 * permanent. Sert à remettre à zéro points, paliers et achats d'une année sur
 * l'autre (voir `progressionRepo.lockUserEventOccurrence`).
 */
export function eventOccurrenceKey(event: Pick<EventConfig, 'startsAt'>): string {
  return event.startsAt ?? 'permanent';
}

/** Multiplicateur de prix appliqué à un objet par les événements actifs. */
export function eventPriceMultiplier(
  world: WorldState,
  itemKey: string,
  category: string,
): number {
  return (
    world.eventModifiers.globalPriceMultiplier *
    (world.eventModifiers.itemPriceMultipliers[itemKey] ?? 1) *
    (world.eventModifiers.categoryPriceMultipliers[category] ?? 1)
  );
}

/** Prépare le calendrier des saisons sur un an (job de démarrage). */
export async function ensureSeasonCalendar(now: Date = new Date()): Promise<void> {
  const balance = getBalance();
  let cursor = seasonAt(now, balance);
  const horizon = new Date(now.getTime() + 365 * 86_400_000);

  while (cursor.startsAt < horizon) {
    await systemRepo.upsertSeason({
      key: cursor.key,
      season: cursor.season,
      seasonIndex: cursor.index,
      gameYear: cursor.gameYear,
      startsAt: cursor.startsAt,
      endsAt: cursor.endsAt,
      active: false,
    });
    cursor = seasonAt(new Date(cursor.endsAt.getTime() + 1_000), balance);
  }

  await systemRepo.setActiveSeason(seasonAt(now, balance).key);
  await ensureSeasonPasses();
}

/**
 * Recopie les passes de `season-pass.json` dans la table `season_pass`.
 *
 * `user_season_pass` référence cette table par clé étrangère : un passe ajouté
 * à la configuration mais absent de la base ferait échouer `addPassXp`, donc
 * TOUTE transaction de récolte, d'artisanat ou d'élevage qui accorde de l'XP de
 * passe. Le seed le faisait, mais seulement quand on pensait à le lancer ; ce
 * rattrapage tourne au démarrage et chaque jour avec le calendrier des saisons.
 * Idempotent (UPSERT sur l'identifiant), mêmes valeurs que `scripts/seed.ts`.
 */
export async function ensureSeasonPasses(): Promise<void> {
  const db = getDb();
  for (const pass of getConfig().seasonPasses) {
    const values = {
      id: pass.id,
      seasonKey: pass.seasonKey,
      name: pass.name,
      description: pass.description,
      startsAt: new Date(pass.startsAt),
      endsAt: new Date(pass.endsAt),
      maxTier: pass.maxTier,
      xpPerTier: pass.xpPerTier,
      tiers: pass.tiers,
      active: pass.active,
    };
    await db
      .insert(seasonPass)
      .values(values)
      .onConflictDoUpdate({ target: seasonPass.id, set: { ...values, updatedAt: new Date() } });
  }
}

export function describeNextSeason(now: Date = new Date()): SeasonState {
  return nextSeason(now, getBalance());
}

/** Multiplicateurs globaux issus de l'environnement (`.env`). */
export function globalMultipliers(): { growth: number; economy: number } {
  return {
    growth: env.GLOBAL_GROWTH_MULTIPLIER,
    economy: env.GLOBAL_ECONOMY_MULTIPLIER,
  };
}
