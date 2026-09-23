import { getConfig, type ItemConfig, localizeRows} from '../config';
import { getDb, type Executor } from '../db/client';
import { gameError } from '../utils/errors';
import { resolveLookup } from '../utils/lookup';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import * as collectionService from './collection.service';
import type { Quality, Mutation, StackKey } from '../repositories/inventory.repo';

/**
 * Inventaire : capacité, ajout, retrait, consommation d'objets.
 *
 * Le service ajoute au repository ce que celui-ci n'a pas le droit de savoir :
 * la CAPACITÉ de l'entrepôt (règle de jeu), la validation des clés d'objets
 * contre la configuration, et les messages d'erreur destinés au joueur.
 */

export interface InventoryPage {
  entries: inventoryRepo.InventoryEntry[];
  totalPages: number;
  page: number;
  used: number;
  capacity: number;
  totalValue: number;
}

const PAGE_SIZE = 10;

export function requireItem(itemKey: string, locale?: string): ItemConfig {
  const item = getConfig(locale).items.get(itemKey);
  if (!item || !item.enabled) {
    throw gameError('item_unknown', `Unknown item: \`${itemKey}\`.`, {
      i18nKey: 'errors.item_unknown',
      params: { item: itemKey },
    });
  }
  return item;
}

/**
 * Clé d'objet correspondant à une saisie libre (clé, ou nom français ou
 * anglais, sans casse ni accents), limitée aux objets acceptés par `filter`.
 * Rend la saisie telle quelle si rien ne correspond : l'appelant garde alors
 * son refus habituel (« objet inconnu », « rien à vendre »).
 */
export function resolveItemInput(raw: string, filter: (item: ItemConfig) => boolean = () => true): string {
  const french = getConfig();
  const english = getConfig('en');
  const candidates = french.itemList
    .filter((item) => item.enabled && filter(item))
    .map((item) => {
      // Une graine répond aussi au nom de sa culture (« blé » → graines de blé).
      const crop = item.category === 'seed' && item.sourceKey ? item.sourceKey : undefined;
      return {
        key: item.key,
        names: [item.name, english.items.get(item.key)?.name ?? item.name],
        aliases: crop
          ? [french.crops.get(crop)?.name, english.crops.get(crop)?.name].filter(
              (name): name is string => Boolean(name),
            )
          : [],
      };
    });
  return resolveLookup(raw, candidates) ?? raw.trim();
}

/** Clé de culture correspondant à une saisie libre (voir `resolveItemInput`). */
export function resolveCropInput(raw: string): string {
  const english = getConfig('en').crops;
  const candidates = getConfig()
    .cropList.filter((crop) => crop.enabled)
    .map((crop) => ({
      key: crop.key,
      names: [crop.name, english.get(crop.key)?.name ?? crop.nameEn ?? crop.name],
    }));
  return resolveLookup(raw, candidates) ?? raw.trim();
}

export async function getPage(
  userId: string,
  options: { category?: string; page?: number } = {},
  locale?: string,
): Promise<InventoryPage> {
  const [rawEntries, capacityInfo] = await Promise.all([
    inventoryRepo.listInventory(userId, { category: options.category }),
    getCapacity(userId),
  ]);

  // `listInventory` joint `items_config`, peuplée en français par le seed :
  // le libellé doit repasser par la configuration localisée.
  const entries = localizeRows(rawEntries, locale ?? '');

  const page = Math.max(1, options.page ?? 1);
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);

  return {
    entries: entries.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE),
    totalPages,
    page: clampedPage,
    used: capacityInfo.used,
    capacity: capacityInfo.capacity,
    totalValue: entries.reduce((sum, entry) => sum + entry.sellPrice * entry.quantity, 0),
  };
}

/**
 * Objets qui n'occupent pas de place dans l'entrepôt : les monnaies
 * d'événement (jetons citrouille, flocons...). Ni vendables ni échangeables,
 * elles ne pouvaient pas être évacuées ; les compter remplissait l'entrepôt et
 * un entrepôt plein annule toute la récolte, qui en produit justement.
 */
export function capacityExemptItemKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const event of getConfig().eventList) {
    if (event.currencyItemKey) keys.add(event.currencyItemKey);
    for (const shopItem of event.shopItems) {
      if (shopItem.currencyItemKey) keys.add(shopItem.currencyItemKey);
    }
  }
  return keys;
}

export async function getCapacity(
  userId: string,
  executor: Executor = getDb(),
): Promise<{ used: number; capacity: number; free: number }> {
  const [used, farm] = await Promise.all([
    inventoryRepo.totalQuantity(userId, executor, {
      excludeItemKeys: [...capacityExemptItemKeys()],
    }),
    playerRepo.getFarmByUserId(userId, executor),
  ]);
  const capacity = farm?.warehouseCapacity ?? 0;
  return { used, capacity, free: Math.max(0, capacity - used) };
}

/**
 * Ajoute des objets en vérifiant la capacité de l'entrepôt.
 *
 * Choix de design : on REFUSE l'ajout plutôt que de perdre silencieusement le
 * surplus. Un joueur qui perd 40 truffes parce que son entrepôt était plein sans
 * avertissement quitte le jeu ; un joueur à qui l'on dit « videz ou améliorez
 * votre entrepôt » va acheter l'amélioration.
 *
 * ⚠ `allowOverflow` est une EXCEPTION, pas le mode normal. Il a longtemps été
 * passé par 21 des 22 appels du projet : l'entrepôt ne limitait donc rien, et le
 * puits de pièces que son amélioration doit alimenter était inerte. La règle,
 * désormais tenue :
 *
 *   - capacité VÉRIFIÉE sur tout ce que le joueur PRODUIT et peut refaire plus
 *     tard — récolte, désherbage, artisanat, pêche, mine, collecte d'élevage.
 *     La transaction est annulée, la ressource reste où elle était ;
 *   - `allowOverflow` réservé à ce qu'on ne peut pas refuser sans le DÉTRUIRE :
 *     récompenses de quête, de succès et de passe, remboursements d'annulation,
 *     livraison d'une enchère gagnée, retour d'une annonce expirée, transferts
 *     d'échange, kit de départ, dons d'administration.
 *
 * Tout nouvel appel doit se ranger explicitement dans l'une des deux colonnes.
 *
 * ⚠ `discover` suit exactement la même discipline, pour la collection : il ne
 * se pose QUE sur ce que le joueur produit lui-même (récolte, collecte
 * d'élevage, pêche, mine, artisanat). Un objet qui ne fait que changer de
 * mains — achat à l'hôtel des ventes, échange, retour d'annonce, remboursement,
 * récompense, don d'administration — n'est pas une découverte : le compter
 * ouvrirait les succès de collection (jusqu'à 40 000 🪙 + 10 💎) à un compte
 * qui n'a jamais planté, sans aucun puits en face.
 */
export async function addItems(
  userId: string,
  entries: Array<{ itemKey: string; quantity: number; quality?: Quality; mutation?: Mutation }>,
  tx: Executor,
  options: { allowOverflow?: boolean; discover?: boolean } = {},
): Promise<void> {
  const positive = entries.filter((entry) => entry.quantity > 0);
  if (positive.length === 0) return;

  for (const entry of positive) requireItem(entry.itemKey);

  // Les monnaies d'événement ne comptent pas : ni dans l'occupation, ni dans
  // ce qui arrive (voir `capacityExemptItemKeys`).
  const exempt = capacityExemptItemKeys();
  const total = positive
    .filter((entry) => !exempt.has(entry.itemKey))
    .reduce((sum, entry) => sum + entry.quantity, 0);
  if (!options.allowOverflow && total > 0) {
    const capacity = await getCapacity(userId, tx);
    if (total > capacity.free) {
      throw gameError(
        'inventory_full',
        `Your warehouse is full (${capacity.used}/${capacity.capacity}).`,
        {
          context: { needed: total, free: capacity.free },
          i18nKey: 'errors.inventory.full',
          params: { used: capacity.used, capacity: capacity.capacity },
          suggestedCommand: 'buildings',
        },
      );
    }
  }

  await inventoryRepo.addItems(
    userId,
    positive.map((entry) => ({
      key: { itemKey: entry.itemKey, quality: entry.quality, mutation: entry.mutation },
      quantity: entry.quantity,
    })),
    tx,
  );

  // Collection du fermier : seule la PRODUCTION est une découverte, et
  // l'appelant doit le dire (`discover: true`). L'enregistrement était
  // inconditionnel ici : l'acheteur d'une annonce, le destinataire d'un
  // échange, le vendeur qui récupère une annonce annulée ou le joueur qui
  // reçoit un don d'administration « découvraient » donc les 41 récoltes sans
  // rien produire — de quoi réclamer `herbarium_complete` (40 000 🪙 + 10 💎)
  // et les succès `collection_*` sur un compte qui n'a jamais planté, et de
  // quoi gonfler le « ×n » de `/collection` en listant puis annulant la même
  // pile en boucle. Le libellé du succès dit « Récoltez », `game/collection.ts`
  // dit « seul ce que le joueur PRODUIT » : c'est ce contrat qu'on tient ici.
  if (options.discover) {
    await collectionService.recordItemDiscoveries({ userId }, positive, tx);
  }
}

/** Retire une quantité précise d'une pile donnée. Lève si le stock manque. */
export async function removeExact(
  userId: string,
  key: StackKey,
  quantity: number,
  tx: Executor,
  locale?: string,
): Promise<void> {
  const item = requireItem(key.itemKey, locale);
  const removed = await inventoryRepo.removeItem(userId, key, quantity, tx);
  if (!removed) {
    const owned = await inventoryRepo.countItem(userId, key.itemKey, tx);
    throw gameError(
      'insufficient_items',
      `You need ${quantity}× ${item.emoji} ${item.name} (you have ${owned}).`,
      {
        context: { itemKey: key.itemKey, quantity, owned },
        i18nKey: 'errors.inventory.need_more',
        params: { quantity, emoji: item.emoji, name: item.name, owned },
      },
    );
  }
}

/**
 * Retire une quantité toutes qualités confondues, de la plus basse à la plus
 * haute. Utilisé par l'artisanat et les livraisons : on ne consomme pas une
 * récolte iridium pour faire de la farine.
 */
export async function consume(
  userId: string,
  itemKey: string,
  quantity: number,
  tx: Executor,
  locale?: string,
): Promise<Array<{ quality: Quality; mutation: Mutation; quantity: number }>> {
  const item = requireItem(itemKey, locale);
  const result = await inventoryRepo.removeItemAnyQuality(userId, itemKey, quantity, tx);
  if (!result.removed) {
    const owned = await inventoryRepo.countItem(userId, itemKey, tx);
    throw gameError(
      'insufficient_items',
      `You need ${quantity}× ${item.emoji} ${item.name} (you have ${owned}).`,
      {
        context: { itemKey, quantity, owned },
        i18nKey: 'errors.inventory.need_more',
        params: { quantity, emoji: item.emoji, name: item.name, owned },
      },
    );
  }
  return result.consumed;
}

export async function count(
  userId: string,
  itemKey: string,
  executor: Executor = getDb(),
): Promise<number> {
  return inventoryRepo.countItem(userId, itemKey, executor);
}

export async function has(
  userId: string,
  itemKey: string,
  quantity: number,
  executor: Executor = getDb(),
): Promise<boolean> {
  return (await inventoryRepo.countItem(userId, itemKey, executor)) >= quantity;
}

/** Le joueur possède-t-il cet outil ? (les outils ne se consomment jamais) */
export async function hasTool(
  userId: string,
  itemKey: string,
  executor: Executor = getDb(),
): Promise<boolean> {
  return has(userId, itemKey, 1, executor);
}

/** Meilleur outil d'un type possédé, d'après l'ordre de la configuration. */
export async function bestTool(
  userId: string,
  effectType: string,
  executor: Executor = getDb(),
): Promise<ItemConfig | undefined> {
  const config = getConfig();
  const owned = await inventoryRepo.listInventory(userId, { category: 'tool' }, executor);
  const candidates = owned
    .map((entry) => config.items.get(entry.itemKey))
    .filter((item): item is ItemConfig => item?.effect?.type === effectType);
  return candidates.sort((a, b) => b.sortOrder - a.sortOrder)[0];
}

/** Résumé lisible d'une liste d'objets, pour les messages de récompense. */
export function describeItems(
  entries: Array<{ itemKey: string; quantity: number; quality?: string }>,
  locale?: string,
): string {
  const config = getConfig(locale);
  return entries
    .map((entry) => {
      const item = config.items.get(entry.itemKey);
      const qualityIcon =
        entry.quality && entry.quality !== 'normal'
          ? { silver: '🥈', gold: '🥇', iridium: '💠' }[entry.quality] ?? ''
          : '';
      return `${entry.quantity}× ${item?.emoji ?? '📦'} ${item?.name ?? entry.itemKey}${qualityIcon}`;
    })
    .join(', ');
}

export { PAGE_SIZE as INVENTORY_PAGE_SIZE };
