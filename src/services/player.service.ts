import { balance as getBalance, getConfig, seedKeyOf } from '../config';
import { env } from '../config/env';
import { getDb, withTransaction, type Executor } from '../db/client';
import {
  addXp,
  levelRewardCoins,
  levelRewardGems,
  levelFromTotalXp,
  removeXp,
  totalXpForLevel,
  xpForNextLevel,
} from '../game/xp';
import { energyCost, hasEnergy, projectEnergy, spendEnergy, type EnergyProjection } from '../game/energy';
import { buildModifiers, type FarmModifiers, type ModifierSources } from '../game/modifiers';
import { coopBonuses } from '../game/coop';
import { starterKitFor, type StarterSeed } from '../game/starter-kit';
import { seasonAt } from '../game/world';
import { gameError } from '../utils/errors';
import { discordTimestamp } from '../utils/format';
import { moduleLogger } from '../utils/logger';
import * as animalRepo from '../repositories/animal.repo';
import * as economyRepo from '../repositories/economy.repo';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import * as progressionRepo from '../repositories/progression.repo';
import { activeBoosts } from './consumable.service';
import { readCachedModifiers, writeCachedModifiers } from './modifier-cache';
import { unlockPetsForLevel } from './pet.service';
import { getWorldState, globalMultipliers } from './world.service';
import type { PlayerContext } from '../types';

const log = moduleLogger('player');

/**
 * Cycle de vie du joueur : création, progression, énergie, modificateurs.
 *
 * `ensurePlayer()` est appelé au début de CHAQUE interaction : c'est le point
 * d'entrée qui garantit qu'un joueur existe et que ses métadonnées Discord sont
 * à jour. Il est optimisé pour une seule requête en régime normal.
 */

export interface EnsurePlayerInput {
  discordId: string;
  username: string;
  displayName?: string;
  avatarHash?: string;
  discordLocale?: string;
  discordGuildId?: string;
  /** Créer le compte s'il n'existe pas (vrai uniquement pour `/start`). */
  createIfMissing?: boolean;
  referralCode?: string;
}

export interface EnsurePlayerResult {
  player: PlayerContext;
  created: boolean;
}

export async function ensurePlayer(input: EnsurePlayerInput): Promise<EnsurePlayerResult | null> {
  const bundle = await playerRepo.loadPlayerBundle(input.discordId);

  if (bundle) {
    // Mise à jour opportuniste des métadonnées : on ne bloque pas la commande
    // dessus (pas de `await` sur le chemin critique en cas d'erreur).
    void playerRepo
      .touchUser(bundle.user.id, {
        username: input.username,
        displayName: input.displayName,
        avatarHash: input.avatarHash,
        discordGuildId: input.discordGuildId,
      })
      .catch((error: unknown) => log.warn({ err: error }, 'touchUser failed'));

    return { player: toPlayerContext(bundle), created: false };
  }

  if (!input.createIfMissing) return null;

  const created = await createPlayer(input);
  return { player: created, created: true };
}

export interface StartingGrant {
  /**
   * Delta appliqué au solde de départ standard, transmis tel quel au dépôt
   * (`coins = startingCoins + bonusDelta`). Négatif quand il faut ramener le
   * solde à zéro.
   */
  bonusDelta: number;
  /** Total réellement crédité, donc montant de la ligne `starting_bonus`. */
  total: number;
}

/**
 * Bonus de départ : UNE FOIS par compte Discord, jamais par ligne `users`.
 *
 * La suppression de compte est logique (`deleted_at`) et l'unicité de
 * `discord_id` ne porte que sur les comptes vivants : `/account delete` puis
 * `/start` recréaient donc un compte neuf sur la même identité Discord, avec
 * 500 🪙 (et 1 500 🪙 de plus avec un code de parrainage) à chaque tour. Ces
 * pièces partaient ensuite au compte principal par un achat immédiat à l'hôtel
 * des ventes : un robinet sans puits, invisible pour l'audit comptable
 * puisqu'un compte jetable ferme toujours à zéro. Le compte est donc toujours
 * recréé — le droit à l'effacement ne se négocie pas — mais sans bourse.
 */
export function startingGrant(
  startingCoins: number,
  referralBonus: number,
  alreadyGranted: boolean,
): StartingGrant {
  if (alreadyGranted) return { bonusDelta: -startingCoins, total: 0 };
  return { bonusDelta: referralBonus, total: startingCoins + referralBonus };
}

/** Graines du sac de départ à l'instant donné (saison en cours). */
export function starterSeedsAt(now: Date): StarterSeed[] {
  return starterKitFor(seasonAt(now, getBalance()).season, getConfig().cropList);
}

async function createPlayer(input: EnsurePlayerInput): Promise<PlayerContext> {
  const balance = getBalance();
  const config = getConfig();

  return withTransaction(async (tx) => {
    const now = new Date();
    // Antécédent sur la MÊME identité Discord. `anonymizeUser` ne fait que
    // poser `deleted_at` : la ligne morte garde `discord_id`, `referral_code`
    // et l'éventuel bannissement économique, et c'est elle qui dit si le bonus
    // de départ a déjà été versé une fois.
    const schema = await import('../db/schema');
    const { and, desc, eq, isNotNull } = await import('drizzle-orm');
    const [previous] = await tx
      .select({
        id: schema.users.id,
        ecoBannedUntil: schema.users.ecoBannedUntil,
        ecoBanReason: schema.users.ecoBanReason,
      })
      .from(schema.users)
      .where(and(eq(schema.users.discordId, input.discordId), isNotNull(schema.users.deletedAt)))
      .orderBy(desc(schema.users.deletedAt))
      .limit(1);

    let referrerId: string | undefined;
    let referralBonus = 0;
    if (input.referralCode) {
      const match = await playerRepo.findUserByReferralCode(input.referralCode, tx);
      // `findUserByReferralCode` ne filtre pas les comptes supprimés et la
      // suppression n'efface pas `referral_code` : sans ce contrôle, un joueur
      // se parrainait LUI-MÊME avec le code de son ancien compte, et le
      // déclencheur anti-boucle (`parent = NEW.id`) ne voyait rien puisque
      // l'uuid est neuf.
      const referrer = match ? await playerRepo.findUserById(match.id, tx) : undefined;
      if (referrer && !referrer.deletedAt && referrer.discordId !== input.discordId) {
        referrerId = referrer.id;
        referralBonus = balance.social.referredStartBonusCoins;
      }
    }

    const grant = startingGrant(balance.economy.startingCoins, referralBonus, Boolean(previous));

    const { user, farm, settings } = await playerRepo.createPlayer(
      {
        discordId: input.discordId,
        username: input.username,
        displayName: input.displayName,
        avatarHash: input.avatarHash,
        locale: input.discordLocale?.startsWith('en') ? 'en' : 'fr',
        balance,
        referrerId,
        startingCoinsBonus: grant.bonusDelta,
      },
      tx,
    );

    // Kit de départ : de quoi jouer immédiatement sans passer par la boutique.
    // Le choix des objets est délibéré — deux cultures rapides DE SAISON pour
    // la boucle d'apprentissage (`starterKitFor` : le blé et la carotte fixes
    // d'autrefois étaient hors saison tout l'hiver), un engrais pour découvrir
    // la mécanique de sol, et l'arrosoir de base qui est un OUTIL (donc jamais
    // consommé). `/start` affiche le même calcul (`starterSeedsAt`).
    await inventoryRepo.addItems(
      user.id,
      [
        ...starterSeedsAt(now).map((seed) => ({
          key: { itemKey: seedKeyOf(seed.cropKey) },
          quantity: seed.quantity,
        })),
        { key: { itemKey: 'fertilizer_basic' }, quantity: 2 },
        { key: { itemKey: 'tool_wateringcan_wood' }, quantity: 1 },
        { key: { itemKey: 'feed_grain' }, quantity: 10 },
      ],
      tx,
    );

    // Entrepôt et maison de niveau 1 : offerts, ils matérialisent la capacité
    // d'inventaire et l'énergie maximale sans que le joueur ait à les construire.
    for (const buildingKey of ['warehouse', 'house']) {
      const building = config.buildings.get(buildingKey);
      const tier = building?.tiers[0];
      if (!building || !tier) continue;
      await animalRepo.upsertBuilding(
        {
          farmId: farm.id,
          userId: user.id,
          buildingKey,
          tier: 1,
          capacity: tier.capacity,
          slots: tier.slots,
          speedMultiplier: tier.speedMultiplier.toFixed(3),
          totalInvested: 0,
        },
        tx,
      );
    }

    // Le solde de départ est déjà posé par l'INSERT de `createPlayer` ; on écrit
    // seulement la ligne comptable correspondante pour que l'égalité
    // « solde = somme du journal » soit vraie dès la création. Un compte recréé
    // ouvre à zéro : pas de ligne du tout, la table interdit un montant nul
    // (`transactions_amount_non_zero`) et 0 = 0 vérifie déjà l'égalité.
    if (grant.total > 0) {
      await economyRepo.recordDirectBalanceLedger(
        {
          userId: user.id,
          type: 'starting_bonus',
          amount: grant.total,
          balanceAfter: grant.total,
          metadata: { referred: Boolean(referrerId) },
        },
        tx,
      );
    }

    // Un bannissement économique en cours suit l'identité Discord, pas la ligne
    // `users` : sinon `/account delete` + `/start` le purgerait, ce qui ferait
    // de la suppression de compte un contournement de modération.
    let ecoBannedUntil = user.ecoBannedUntil;
    if (previous?.ecoBannedUntil && previous.ecoBannedUntil.getTime() > now.getTime()) {
      await playerRepo.setEcoBan(user.id, previous.ecoBannedUntil, previous.ecoBanReason, tx);
      ecoBannedUntil = previous.ecoBannedUntil;
    }

    // Compagnon de niveau 1 : débloqué dès la création, comme le reste du kit
    // de départ (voir `game/pets.ts`).
    await unlockPetsForLevel(user.id, user.level, tx);

    log.info(
      { userId: user.id, discordId: input.discordId, recreated: Boolean(previous), coins: grant.total },
      'new farm created',
    );

    return {
      id: user.id,
      discordId: user.discordId,
      username: user.username,
      level: user.level,
      xp: user.xp,
      coins: grant.total,
      gems: user.gems,
      prestige: user.prestige,
      energy: user.energy,
      energyMax: user.energyMax,
      locale: settings.locale,
      isAdmin: env.BOT_OWNER_IDS.includes(user.discordId),
      compactMode: settings.compactMode,
      equippedPetKey: user.equippedPetKey,
      ecoBannedUntil,
      farmId: farm.id,
      coopId: null,
      coopRole: null,
      created: true,
    };
  });
}

function toPlayerContext(bundle: playerRepo.PlayerBundle): PlayerContext {
  return {
    id: bundle.user.id,
    discordId: bundle.user.discordId,
    username: bundle.user.displayName ?? bundle.user.username,
    level: bundle.user.level,
    xp: bundle.user.xp,
    coins: bundle.user.coins,
    gems: bundle.user.gems,
    prestige: bundle.user.prestige,
    energy: bundle.user.energy,
    energyMax: bundle.user.energyMax,
    locale: bundle.settings.locale,
    isAdmin: bundle.user.isAdmin || env.BOT_OWNER_IDS.includes(bundle.user.discordId),
    compactMode: bundle.settings.compactMode,
    equippedPetKey: bundle.user.equippedPetKey,
    ecoBannedUntil: bundle.user.ecoBannedUntil,
    farmId: bundle.farm.id,
    coopId: bundle.coop?.id ?? null,
    coopRole: bundle.coop?.role ?? null,
    created: false,
  };
}

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

export interface XpGainResult {
  level: number;
  xpInLevel: number;
  xpForNext: number;
  levelsGained: number;
  rewardCoins: number;
  rewardGems: number;
  crossedLevels: number[];
}

/** Montée de niveau à remonter jusqu'à l'affichage (`framework/levelup.ts`). */
export interface LevelUpSummary {
  level: number;
  levelsGained: number;
}

/** `null` si l'octroi d'XP n'a fait franchir aucun niveau. */
export function levelUpOf(result: XpGainResult | null | undefined): LevelUpSummary | null {
  return result && result.levelsGained > 0 ? { level: result.level, levelsGained: result.levelsGained } : null;
}

/**
 * Attribue de l'XP et distribue les récompenses de palier.
 * Toujours appelé DANS la transaction de l'action qui l'a produite : si la
 * récolte échoue, l'XP n'est pas accordée.
 */
export async function grantXp(
  userId: string,
  amount: number,
  tx: Executor,
  options: { discordGuildId?: string } = {},
): Promise<XpGainResult> {
  const balance = getBalance();
  const user = await playerRepo.findUserById(userId, tx);
  if (!user) throw gameError('not_registered', 'Player not found.', { i18nKey: 'errors.player_not_found' });

  const result = addXp({ level: user.level, xp: user.xp }, amount, balance);
  await playerRepo.setLevelAndXp(
    userId,
    { level: result.level, xp: result.xpInLevel, totalXpDelta: Math.max(0, Math.floor(amount)) },
    tx,
  );

  let rewardCoins = 0;
  let rewardGems = 0;
  for (const level of result.crossedLevels) {
    rewardCoins += levelRewardCoins(level, balance);
    rewardGems += levelRewardGems(level, balance);
  }

  if (rewardCoins > 0) {
    await economyRepo.credit(
      {
        userId,
        type: 'level_reward',
        amount: rewardCoins,
        discordGuildId: options.discordGuildId ?? null,
        metadata: { levels: result.crossedLevels },
      },
      tx,
    );
  }
  if (rewardGems > 0) {
    await economyRepo.credit(
      {
        userId,
        type: 'level_reward',
        currency: 'gems',
        amount: rewardGems,
        metadata: { levels: result.crossedLevels },
      },
      tx,
    );
  }

  if (result.levelsGained > 0) {
    // Les quêtes et succès « atteindre le niveau N » sont mis à jour ici, une
    // seule fois, plutôt que d'être vérifiés à chaque action.
    await progressionRepo.setQuestProgress(userId, 'reach_level', result.level, tx);
    await progressionRepo.setAchievementProgress(userId, 'reach_level', result.level, tx);
    await unlockPetsForLevel(userId, result.level, tx);
  }

  return {
    level: result.level,
    xpInLevel: result.xpInLevel,
    xpForNext: result.xpForNext,
    levelsGained: result.levelsGained,
    rewardCoins,
    rewardGems,
    crossedLevels: result.crossedLevels,
  };
}

export interface XpLossResult {
  level: number;
  xpInLevel: number;
  xpForNext: number;
  levelsLost: number;
}

/**
 * Retire de l'XP (correction d'un octroi erroné, typiquement). Ne reprend PAS
 * les récompenses de palier déjà versées par `grantXp()` — pièces et gemmes
 * restent un puits/robinet indépendant, à corriger séparément via
 * `/admin take` si besoin, comme pour n'importe quelle autre ressource.
 */
export async function removeXpAmount(
  userId: string,
  amount: number,
  tx: Executor,
): Promise<XpLossResult> {
  const balance = getBalance();
  const user = await playerRepo.findUserById(userId, tx);
  if (!user) throw gameError('not_registered', 'Player not found.', { i18nKey: 'errors.player_not_found' });

  const previousLevel = user.level;
  const previousTotal = totalXpForLevel(previousLevel, balance) + user.xp;
  const result = removeXp({ level: previousLevel, xp: user.xp }, amount, balance);
  const actuallyRemoved = previousTotal - result.totalXp;

  await playerRepo.setLevelAndXp(
    userId,
    { level: result.level, xp: result.xpInLevel, totalXpDelta: -Math.max(0, Math.floor(actuallyRemoved)) },
    tx,
  );

  return {
    level: result.level,
    xpInLevel: result.xpInLevel,
    xpForNext: result.xpForNext,
    levelsLost: previousLevel - result.level,
  };
}

// ---------------------------------------------------------------------------
// Énergie
// ---------------------------------------------------------------------------

export async function getEnergy(
  userId: string,
  now: Date = new Date(),
  executor: Executor = getDb(),
): Promise<EnergyProjection> {
  const user = await playerRepo.findUserById(userId, executor);
  if (!user) throw gameError('not_registered', 'Player not found.', { i18nKey: 'errors.player_not_found' });
  return projectEnergy(
    { energy: user.energy, energyMax: user.energyMax, energyUpdatedAt: user.energyUpdatedAt },
    now,
    getBalance(),
  );
}

/**
 * Vérifie et consomme l'énergie d'une action.
 * Lève `insufficient_energy` sans rien modifier si le joueur n'a pas assez.
 *
 * La lecture VERROUILLE la ligne joueur jusqu'à la fin de la transaction :
 * arroser, désherber, nourrir ou fabriquer n'appellent pas `lockUserRow`, et
 * deux actions simultanées lisaient la même énergie puis écrivaient chacune
 * une valeur absolue (une seule dépense retenue). Le verrou ne coûte rien de
 * plus : l'écriture qui suit l'aurait pris de toute façon.
 */
export async function consumeEnergy(
  userId: string,
  action: string,
  tx: Executor,
  options: { quantity?: number; costReduction?: number; now?: Date } = {},
): Promise<{ spent: number; remaining: number }> {
  const balance = getBalance();
  if (!balance.energy.enabled) return { spent: 0, remaining: 0 };

  const now = options.now ?? new Date();
  const user = await playerRepo.findUserByIdForUpdate(userId, tx);
  if (!user) throw gameError('not_registered', 'Player not found.', { i18nKey: 'errors.player_not_found' });
  const projection = projectEnergy(
    { energy: user.energy, energyMax: user.energyMax, energyUpdatedAt: user.energyUpdatedAt },
    now,
    balance,
  );
  const cost = energyCost(action, balance, options.costReduction ?? 0, options.quantity ?? 1);

  if (!hasEnergy(projection, cost)) {
    throw gameError(
      'insufficient_energy',
      `You need ${cost} ⚡ (you have ${projection.current}).`,
      {
        context: { cost, current: projection.current },
        i18nKey: 'common.energy_required',
        hintKey: 'errors.player.energy_hint',
        params: { cost, current: projection.current },
        suggestedCommand: 'shop',
      },
    );
  }

  const next = spendEnergy(projection, cost, now);
  await playerRepo.setEnergy(userId, next, tx);
  return { spent: cost, remaining: next.energy };
}

// ---------------------------------------------------------------------------
// Modificateurs de ferme
// ---------------------------------------------------------------------------

/**
 * Assemble les modificateurs actifs d'un joueur.
 *
 * Coûteux (4 requêtes plus les boosts Redis), donc mis en cache 60 s : les
 * bâtiments, outils et animaux ne changent pas d'une seconde à l'autre, alors
 * qu'une session enchaîne plusieurs actions qui en ont besoin. Le cache est
 * invalidé explicitement par les actions qui modifient ces sources.
 */
export async function getFarmModifiers(
  player: { id: string; farmId: string; prestige: number; coopId: string | null },
  options: { coopLevel?: number; now?: Date } = {},
): Promise<FarmModifiers> {
  const coopLevel = options.coopLevel ?? 0;
  const hit = await readCachedModifiers(player.id, coopLevel);
  if (hit) return hit;

  const modifiers = await computeFarmModifiers(player, { ...options, coopLevel });
  await writeCachedModifiers(player.id, coopLevel, modifiers);
  return modifiers;
}

async function computeFarmModifiers(
  player: { id: string; farmId: string; prestige: number; coopId: string | null },
  options: { coopLevel?: number; now?: Date } = {},
): Promise<FarmModifiers> {
  const config = getConfig();
  const balance = getBalance();
  const world = await getWorldState(options.now);
  const globals = globalMultipliers();

  const [buildings, animals, tools, boosts] = await Promise.all([
    animalRepo.listBuildings(player.farmId),
    animalRepo.listAnimals(player.farmId),
    inventoryRepo.listInventory(player.id, { category: 'tool' }),
    activeBoosts(player.id),
  ]);

  const animalCounts = new Map<string, number>();
  for (const entry of animals) {
    animalCounts.set(entry.animalKey, (animalCounts.get(entry.animalKey) ?? 0) + 1);
  }

  const sources: ModifierSources = {
    buildings: buildings
      .map((entry) => {
        const buildingConfig = config.buildings.get(entry.buildingKey);
        return buildingConfig
          ? {
              config: buildingConfig,
              tier: entry.building.tier,
              speedMultiplier: Number(entry.building.speedMultiplier),
            }
          : undefined;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
    tools: tools
      .map((entry) => config.items.get(entry.itemKey))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
    animals: [...animalCounts.entries()]
      .map(([animalKey, count]) => {
        const animalConfig = config.animals.get(animalKey);
        return animalConfig ? { config: animalConfig, count } : undefined;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
    coopLevel: options.coopLevel ?? 0,
    prestige: player.prestige,
    // Les boosts consommables étaient câblés à `[]` : les potions d'XP, de
    // croissance et de chance étaient écrites dans Redis, annoncées au joueur,
    // et n'avaient aucun effet. `buildModifiers` sait déjà les appliquer.
    activeBoosts: boosts,
    eventModifiers: {
      xpMultiplier: world.eventModifiers.xpMultiplier,
      growthMultiplier: world.eventModifiers.growthMultiplier,
      mutationMultiplier: world.eventModifiers.mutationMultiplier,
      qualityBonus: world.eventModifiers.qualityBonus,
    },
    globalGrowthMultiplier: globals.growth,
    globalEconomyMultiplier: globals.economy,
  };

  return buildModifiers(sources, balance);
}

/** Bonus de coopérative d'un joueur (0 s'il n'en a pas). */
export function coopBonusesFor(coopLevel: number) {
  return coopBonuses(coopLevel, getBalance());
}

// ---------------------------------------------------------------------------
// Profil et statistiques
// ---------------------------------------------------------------------------

export interface PlayerProfile {
  user: playerRepo.UserRow;
  farm: playerRepo.FarmRow;
  levelState: ReturnType<typeof levelFromTotalXp>;
  xpForNext: number;
  energy: EnergyProjection;
  plotsUnlocked: number;
  animalsAlive: number;
  inventoryUsed: number;
  inventoryCapacity: number;
  bankBalance: number;
  streak: number;
  achievementsUnlocked: number;
  coop: { name: string; tag: string; level: number; role: string } | null;
  rank: { wealth?: number; level?: number } ;
}

export async function getProfile(discordId: string): Promise<PlayerProfile | null> {
  const bundle = await playerRepo.loadPlayerBundle(discordId);
  if (!bundle) return null;
  const balance = getBalance();

  const [plotsUnlocked, animals, inventoryUsed, bank, streak, achievements] = await Promise.all([
    (await import('../repositories/farm.repo')).countUnlockedPlots(bundle.farm.id),
    animalRepo.listAnimals(bundle.farm.id),
    inventoryRepo.totalQuantity(bundle.user.id),
    playerRepo.getBankAccount(bundle.user.id),
    playerRepo.getDailyStreak(bundle.user.id),
    progressionRepo.listAchievements(bundle.user.id, undefined),
  ]);

  return {
    user: bundle.user,
    farm: bundle.farm,
    levelState: levelFromTotalXp(bundle.user.totalXp, balance),
    xpForNext: xpForNextLevel(bundle.user.level, balance),
    energy: projectEnergy(
      {
        energy: bundle.user.energy,
        energyMax: bundle.user.energyMax,
        energyUpdatedAt: bundle.user.energyUpdatedAt,
      },
      new Date(),
      balance,
    ),
    plotsUnlocked,
    animalsAlive: animals.length,
    inventoryUsed,
    inventoryCapacity: bundle.farm.warehouseCapacity,
    bankBalance: bank?.balance ?? 0,
    streak: streak?.currentStreak ?? 0,
    achievementsUnlocked: achievements.filter((entry) => entry.unlocked).length,
    coop: bundle.coop
      ? {
          name: bundle.coop.name,
          tag: bundle.coop.tag,
          level: bundle.coop.level,
          role: bundle.coop.role,
        }
      : null,
    rank: {},
  };
}

/** Vérifie qu'un joueur n'est pas banni de l'économie. */
export function assertNotEcoBanned(player: PlayerContext, now: Date = new Date()): void {
  if (player.ecoBannedUntil && player.ecoBannedUntil.getTime() > now.getTime()) {
    throw gameError(
      'eco_banned',
      `Your access to the economy is suspended until ${player.ecoBannedUntil.toLocaleString('en-US')}.`,
      {
        i18nKey: 'errors.player.eco_banned',
        params: { when: discordTimestamp(player.ecoBannedUntil, 'F') },
      },
    );
  }
}

/** Vérifie un niveau requis et lève une erreur explicite sinon. */
export function assertLevel(player: { level: number }, required: number, what: string): void {
  if (player.level < required) {
    throw gameError('level_too_low', `${what} requires level ${required}.`, {
      context: { required, current: player.level },
      i18nKey: 'errors.player.level_required',
      hintKey: 'errors.player.level_required_hint',
      params: { what, required, current: player.level },
    });
  }
}
