import { balance as getBalance } from '../config';
import { getDb, lockUserRow, withTransaction, type Executor } from '../db/client';
import { feeOf } from '../game/money';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as economyRepo from '../repositories/economy.repo';
import * as playerRepo from '../repositories/player.repo';
import * as systemRepo from '../repositories/system.repo';
import type { TransactionType } from '../repositories/economy.repo';
import { trackAction } from './tracker.service';

const log = moduleLogger('economy');

/**
 * Monnaie, banque, dons et surveillance anti-inflation.
 *
 * Toutes les écritures passent par `economyRepo.credit/debit`, qui journalisent.
 * Ce service ajoute les RÈGLES : taxes, plafonds, niveaux minimum, détection
 * d'anomalies. Aucune commande n'appelle jamais le repository directement.
 */

export interface PayInput {
  userId: string;
  amount: number;
  type: TransactionType;
  itemKey?: string;
  quantity?: number;
  unitPrice?: number;
  counterpartyId?: string;
  discordGuildId?: string;
  metadata?: Record<string, unknown>;
  currency?: 'coins' | 'gems';
  /** Objet métier lié (quête, succès, enchère…) pour la traçabilité. */
  referenceType?: string;
  referenceId?: string;
}

/** Crédite un joueur. Lève si le montant est nul ou négatif. */
export async function pay(input: PayInput, tx: Executor): Promise<number> {
  return economyRepo.credit(
    {
      userId: input.userId,
      type: input.type,
      currency: input.currency ?? 'coins',
      amount: input.amount,
      itemKey: input.itemKey,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      counterpartyId: input.counterpartyId,
      discordGuildId: input.discordGuildId,
      // Ces deux champs étaient acceptés par `PayInput` puis silencieusement
      // abandonnés : la traçabilité vers l'enchère ou la quête d'origine,
      // pourtant documentée, n'arrivait jamais jusqu'au journal.
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      metadata: input.metadata,
    },
    tx,
  );
}

/**
 * Débite un joueur. Lève `insufficient_funds` (ou `insufficient_gems`) si le
 * solde ne suffit pas — SANS modifier la base, la transaction appelante peut
 * donc être annulée proprement.
 */
export async function charge(input: PayInput, tx: Executor): Promise<number> {
  const remaining = await economyRepo.debit(
    {
      userId: input.userId,
      type: input.type,
      currency: input.currency ?? 'coins',
      amount: input.amount,
      itemKey: input.itemKey,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      counterpartyId: input.counterpartyId,
      discordGuildId: input.discordGuildId,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      metadata: input.metadata,
    },
    tx,
  );

  if (remaining === null) {
    const user = await playerRepo.findUserById(input.userId, tx);
    const currency = input.currency ?? 'coins';
    const owned = currency === 'coins' ? (user?.coins ?? 0) : (user?.gems ?? 0);
    const missing = Math.max(0, input.amount - owned);
    throw gameError(
      currency === 'coins' ? 'insufficient_funds' : 'insufficient_gems',
      currency === 'coins'
        ? `You are ${missing.toLocaleString('en-US')} 🪙 short.`
        : `You are ${missing.toLocaleString('en-US')} 💎 short.`,
      {
        context: { required: input.amount, owned, missing },
        i18nKey: currency === 'coins' ? 'common.insufficient_funds' : 'common.insufficient_gems',
        // Où trouver des pièces : un nouveau joueur ne le sait pas encore.
        ...(currency === 'coins' ? { hintKey: 'onboarding.earn_hint' } : {}),
        params: { missing },
      },
    );
  }

  return remaining;
}

/**
 * Applique la taxe de vente et renvoie le détail.
 * La taxe est le principal PUITS MONÉTAIRE du jeu : elle retire en permanence
 * 3 % de toute vente. Les joueurs sous le niveau 5 en sont exonérés pour ne pas
 * plomber l'onboarding.
 */
export function applySalesTax(gross: number, level: number): { net: number; tax: number } {
  const balance = getBalance();
  if (level < balance.economy.salesTaxFreeLevel) return { net: gross, tax: 0 };
  const tax = feeOf(gross, balance.economy.salesTaxRate);
  return { net: Math.max(0, gross - tax), tax };
}

// ---------------------------------------------------------------------------
// Banque
// ---------------------------------------------------------------------------

export interface BankResult {
  balance: number;
  walletBalance: number;
  capacity: number;
  tier: number;
  interestRate: number;
}

export async function bankStatus(userId: string): Promise<BankResult> {
  const [account, user] = await Promise.all([
    playerRepo.getBankAccount(userId),
    playerRepo.findUserById(userId),
  ]);
  if (!account || !user) {
    throw gameError('not_registered', 'Account not found.', {
      i18nKey: 'errors.economy.account_not_found',
    });
  }
  return {
    balance: account.balance,
    walletBalance: user.coins,
    capacity: account.capacity,
    tier: account.tier,
    interestRate: Number(account.interestRate),
  };
}

/**
 * Dépôt en banque. L'argent en banque est protégé du vol (mécanique v2) et
 * génère des intérêts plafonnés — le plafond est essentiel : sans lui, un joueur
 * riche gagnerait passivement plus que tout le reste du jeu réuni.
 */
export async function deposit(userId: string, amount: number): Promise<BankResult> {
  if (amount <= 0) {
    throw gameError('quantity_invalid', 'The amount must be positive.', {
      i18nKey: 'errors.economy.amount_must_be_positive',
    });
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, userId);
    const account = await economyRepo.lockBankAccount(tx, userId);
    if (!account) {
      throw gameError('not_registered', 'Bank account not found.', {
        i18nKey: 'errors.economy.bank_not_found',
      });
    }

    if (account.balance + amount > account.capacity) {
      throw gameError(
        'bank_capacity',
        `Your vault can only hold ${account.capacity.toLocaleString('en-US')} 🪙.`,
        {
          i18nKey: 'errors.economy.bank_capacity',
          hintKey: 'errors.economy.bank_capacity_hint',
          params: { capacity: account.capacity },
        },
      );
    }

    await charge({ userId, amount, type: 'bank_deposit' }, tx);
    const balanceAfter = await economyRepo.updateBankBalance(userId, amount, tx);
    if (balanceAfter === null) {
      throw gameError('bank_capacity', 'Deposit refused: capacity exceeded.', {
        i18nKey: 'errors.economy.deposit_refused',
      });
    }

    const user = await playerRepo.findUserById(userId, tx);
    return {
      balance: balanceAfter,
      walletBalance: user?.coins ?? 0,
      capacity: account.capacity,
      tier: account.tier,
      interestRate: Number(account.interestRate),
    };
  });
}

export async function withdraw(userId: string, amount: number): Promise<BankResult> {
  if (amount <= 0) {
    throw gameError('quantity_invalid', 'The amount must be positive.', {
      i18nKey: 'errors.economy.amount_must_be_positive',
    });
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, userId);
    const account = await economyRepo.lockBankAccount(tx, userId);
    if (!account) {
      throw gameError('not_registered', 'Bank account not found.', {
        i18nKey: 'errors.economy.bank_not_found',
      });
    }

    const balanceAfter = await economyRepo.updateBankBalance(userId, -amount, tx);
    if (balanceAfter === null) {
      throw gameError(
        'insufficient_funds',
        `Your vault only holds ${account.balance.toLocaleString('en-US')} 🪙.`,
        { i18nKey: 'errors.economy.vault_insufficient', params: { balance: account.balance } },
      );
    }

    await pay({ userId, amount, type: 'bank_withdraw' }, tx);
    const user = await playerRepo.findUserById(userId, tx);
    return {
      balance: balanceAfter,
      walletBalance: user?.coins ?? 0,
      capacity: account.capacity,
      tier: account.tier,
      interestRate: Number(account.interestRate),
    };
  });
}

export async function upgradeBank(userId: string, level: number): Promise<{ tier: number; capacity: number }> {
  const balance = getBalance();
  return withTransaction(async (tx) => {
    const account = await economyRepo.lockBankAccount(tx, userId);
    if (!account) {
      throw gameError('not_registered', 'Bank account not found.', {
        i18nKey: 'errors.economy.bank_not_found',
      });
    }

    const nextTier = balance.bank.tiers.find((tier) => tier.tier === account.tier + 1);
    if (!nextTier) {
      throw gameError('invalid_state', 'Your bank is already at the maximum level.', {
        i18nKey: 'errors.economy.bank_max_level',
      });
    }
    if (level < nextTier.requiredLevel) {
      throw gameError(
        'level_too_low',
        `The bank upgrade requires level ${nextTier.requiredLevel}.`,
        { i18nKey: 'errors.economy.bank_upgrade_level', params: { level: nextTier.requiredLevel } },
      );
    }

    await charge({ userId, amount: nextTier.upgradeCost, type: 'building_upgrade' }, tx);
    await economyRepo.upgradeBankTier(userId, nextTier, tx);
    return { tier: nextTier.tier, capacity: nextTier.capacity };
  });
}

// ---------------------------------------------------------------------------
// Dons entre joueurs
// ---------------------------------------------------------------------------

/**
 * Don de pièces. Trois garde-fous, tous nécessaires :
 *  - niveau minimum : empêche la création de comptes jetables pour transférer ;
 *  - taxe de 5 % : rend le blanchiment coûteux ;
 *  - plafond quotidien : borne l'ampleur d'un éventuel abus.
 */
export async function gift(
  from: { id: string; level: number },
  toUserId: string,
  amount: number,
  options: { discordGuildId?: string } = {},
): Promise<{ sent: number; tax: number; received: number }> {
  const balance = getBalance();
  if (amount <= 0) {
    throw gameError('quantity_invalid', 'The amount must be positive.', {
      i18nKey: 'errors.economy.amount_must_be_positive',
    });
  }
  if (from.id === toUserId) {
    throw gameError('target_invalid', 'You cannot gift yourself.', {
      i18nKey: 'errors.economy.self_gift',
    });
  }
  if (from.level < balance.economy.giftMinLevel) {
    throw gameError(
      'level_too_low',
      `Gifts are available from level ${balance.economy.giftMinLevel}.`,
      { i18nKey: 'errors.economy.gift_min_level', params: { level: balance.economy.giftMinLevel } },
    );
  }

  const since = new Date(Date.now() - 86_400_000);
  const alreadyGifted = await economyRepo.giftedToday(from.id, since);
  if (alreadyGifted + amount > balance.economy.giftDailyLimit) {
    throw gameError(
      'forbidden',
      `Gift cap reached: ${balance.economy.giftDailyLimit.toLocaleString('en-US')} 🪙 per 24 h ` +
        `(already gifted: ${alreadyGifted.toLocaleString('en-US')} 🪙).`,
      {
        i18nKey: 'errors.economy.gift_cap',
        params: { limit: balance.economy.giftDailyLimit, gifted: alreadyGifted },
      },
    );
  }

  const tax = feeOf(amount, balance.economy.giftTaxRate);
  const received = amount - tax;

  return withTransaction(async (tx) => {
    // Verrouillage dans un ordre déterministe : évite l'interblocage si deux
    // joueurs se font un don mutuel au même instant.
    const [first, second] = [from.id, toUserId].sort();
    await lockUserRow(tx, first!);
    await lockUserRow(tx, second!);

    await charge(
      {
        userId: from.id,
        amount,
        type: 'gift_out',
        counterpartyId: toUserId,
        discordGuildId: options.discordGuildId,
        metadata: { tax },
      },
      tx,
    );
    await pay(
      {
        userId: toUserId,
        amount: received,
        type: 'gift_in',
        counterpartyId: from.id,
        discordGuildId: options.discordGuildId,
        metadata: { tax },
      },
      tx,
    );

    await systemRepo.audit(
      {
        actorId: from.id,
        action: 'gift',
        targetType: 'user',
        targetId: toUserId,
        payload: { amount, tax, received },
        severity: amount >= 1_000_000 ? 'warn' : 'info',
      },
      tx,
    );

    return { sent: amount, tax, received };
  });
}

// ---------------------------------------------------------------------------
// Anti-triche économique
// ---------------------------------------------------------------------------

/**
 * Vérifie la cohérence entre les soldes et le journal comptable.
 * Exécuté toutes les heures par le scheduler. Tout écart signifie soit un bug,
 * soit une manipulation directe de la base : dans les deux cas il faut le savoir
 * immédiatement, d'où l'alerte en niveau `error`.
 */
export async function auditLedger(limit = 50): Promise<Array<{ userId: string; coins: number; ledger: number }>> {
  const mismatches = await economyRepo.findLedgerMismatches(limit);
  if (mismatches.length > 0) {
    log.error({ count: mismatches.length, sample: mismatches.slice(0, 5) }, 'LEDGER DRIFT detected');
    for (const mismatch of mismatches) {
      await systemRepo.audit({
        action: 'ledger_mismatch',
        targetType: 'user',
        targetId: mismatch.userId,
        payload: mismatch,
        severity: 'error',
      });
    }
  }
  return mismatches;
}

/** Enregistre un comportement suspect et applique une sanction graduée. */
export async function flagSuspicion(
  userId: string,
  points: number,
  reason: string,
): Promise<{ score: number; action: 'none' | 'warn' | 'review' | 'ban' }> {
  const balance = getBalance();
  const score = await playerRepo.addSuspicion(userId, points);
  const thresholds = balance.economy.suspicionThresholds;

  let action: 'none' | 'warn' | 'review' | 'ban' = 'none';
  if (score >= thresholds.autoBan) action = 'ban';
  else if (score >= thresholds.review) action = 'review';
  else if (score >= thresholds.warn) action = 'warn';

  await systemRepo.audit({
    actorId: null,
    action: 'suspicion',
    targetType: 'user',
    targetId: userId,
    reason,
    payload: { points, score, action },
    severity: action === 'ban' ? 'error' : action === 'review' ? 'warn' : 'info',
  });

  if (action === 'ban') {
    await playerRepo.setEcoBan(
      userId,
      new Date(Date.now() + 7 * 86_400_000),
      `Repeated economic anomalies (score ${score}).`,
    );
    log.error({ userId, score, reason }, 'automatic economic ban');
  }

  return { score, action };
}

/** Statistiques économiques globales pour `/admin stats`. */
export async function economyDashboard(): Promise<{
  snapshot: Awaited<ReturnType<typeof economyRepo.captureEconomySnapshot>> | undefined;
  history: Awaited<ReturnType<typeof economyRepo.lastEconomySnapshots>>;
  flows: Array<{ type: string; total: number }>;
  inflationRate: number;
}> {
  const since = new Date(Date.now() - 86_400_000);
  const [history, flows] = await Promise.all([
    economyRepo.lastEconomySnapshots(24),
    economyRepo.sumByType(since),
  ]);

  const newest = history[0];
  const oldest = history.at(-1);
  const inflationRate =
    newest && oldest && oldest.totalCoins > 0
      ? (newest.totalCoins - oldest.totalCoins) / oldest.totalCoins
      : 0;

  return { snapshot: newest, history, flows, inflationRate };
}

/** Suit une dépense pour les quêtes « dépenser N pièces ». */
export async function trackSpending(
  context: { userId: string; coopId?: string | null; level: number },
  amount: number,
  tx: Executor,
): Promise<void> {
  await trackAction(context, 'spend_coins', amount, {}, tx);
}

export { economyRepo as economyRepository };
export const dbForReads = getDb;
