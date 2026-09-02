import { Injectable, Logger } from '@nestjs/common';
import { Currency, PointsLedgerSource, Prisma, PurchaseType, Transaction } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import {
  CashbackComputation,
  CashbackConfig,
  CashbackLineInput,
  CashbackRule,
  computeCashback,
  readCashbackSettings,
} from '../points-cashback.util';
import { PointsWalletService } from './points-wallet.service';

/** The slice of a transaction row the cashback reads. */
export type CashbackTransaction = Pick<
  Transaction,
  'id' | 'userId' | 'amount' | 'currency' | 'purchaseType' | 'planSnapshot'
>;

export type CashbackCreditOutcome =
  | { readonly credited: true; readonly points: number; readonly balanceAfter: number; readonly entryId: string }
  | {
      readonly credited: false;
      readonly reason:
        | 'ALREADY_CREDITED'
        | 'PARTNER'
        | 'NOTHING_PAID'
        | 'NO_POINTS'
        | 'USER_NOT_FOUND';
      readonly computation?: CashbackComputation;
    };

export type CashbackReverseOutcome =
  | { readonly reversed: true; readonly credited: number; readonly debited: number; readonly shortfall: number }
  | { readonly reversed: false; readonly reason: 'NOT_CREDITED' | 'ALREADY_REVERSED' | 'USER_NOT_FOUND' };

/**
 * Points cashback for a paid purchase: resolves the payment into lines, asks
 * the one computation for the points, credits them through the wallet and
 * takes them back on a refund.
 *
 * ── Where it sits ─────────────────────────────────────────────────────────
 *
 * A post-fulfilment hook after the referral and partner ones, and a reversal
 * beside theirs. Both are best-effort like their neighbours: the money is
 * captured and the entitlement granted before this runs, so nothing here may
 * fail a checkout, and every refusal is logged rather than thrown.
 *
 * ── Exactly once ──────────────────────────────────────────────────────────
 *
 * The ledger key is (CASHBACK, transaction id). A hook that runs twice for
 * one payment — the inline fulfilment path and the webhook reconciler both
 * call the hooks — is told DUPLICATE by the wallet and does nothing. The
 * reversal is keyed the same way on CASHBACK_REVERSED, so a replayed refund
 * webhook is a no-op too.
 *
 * ── Who does not get it ───────────────────────────────────────────────────
 *
 * An active partner: the same rule that denies them a referral reward — they
 * are paid in money. And a payment of nothing: a free trial creates no
 * transaction at all, and a zero-amount one earns nothing.
 */
@Injectable()
export class PointsCashbackService {
  private readonly logger = new Logger(PointsCashbackService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly pointsWallet: PointsWalletService,
    private readonly events: SystemEventsService,
  ) {}

  /** The hook. Never throws. */
  public async creditForTransactionBestEffort(transaction: CashbackTransaction): Promise<void> {
    try {
      await this.creditForTransaction(transaction);
    } catch (error: unknown) {
      this.logger.error(
        `Points cashback hook failed for transaction ${transaction.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The reversal. Never throws. */
  public async reverseForTransactionBestEffort(transactionId: string): Promise<void> {
    try {
      await this.reverseForTransaction(transactionId);
    } catch (error: unknown) {
      this.logger.error(
        `Points cashback reversal failed for transaction ${transactionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  public async creditForTransaction(transaction: CashbackTransaction): Promise<CashbackCreditOutcome> {
    if (transaction.amount.lte(0)) return { credited: false, reason: 'NOTHING_PAID' };

    const partner = await this.prismaService.partner.findUnique({
      where: { userId: transaction.userId },
      select: { isActive: true },
    });
    if (partner?.isActive === true) {
      this.logger.debug(`Points cashback skipped for transaction ${transaction.id}: payer is an active partner`);
      return { credited: false, reason: 'PARTNER' };
    }

    const config = await this.loadConfig();
    const lines = await this.resolveLines(transaction);
    const computation = computeCashback(lines, config);
    this.reportSkippedLines(transaction, computation);

    if (computation.points <= 0) {
      return { credited: false, reason: 'NO_POINTS', computation };
    }

    const details: Prisma.InputJsonObject = {
      transactionId: transaction.id,
      purchaseType: transaction.purchaseType,
      paidAmount: transaction.amount.toString(),
      paidCurrency: transaction.currency,
      defaultCurrency: config.defaultCurrency,
      lines: computation.lines.map((line) => ({
        kind: line.kind,
        id: line.id,
        name: line.name,
        durationDays: line.durationDays,
        amount: line.amount,
        currency: line.currency,
        mode: line.mode,
        effective: line.effective,
        percent: line.percent,
        base: line.base,
        points: line.points,
        skipped: line.skipped,
      })),
    };

    const moved = await this.prismaService.$transaction((tx) =>
      this.pointsWallet.apply(tx, {
        userId: transaction.userId,
        delta: computation.points,
        source: PointsLedgerSource.CASHBACK,
        referenceKey: transaction.id,
        details,
      }),
    );
    if (!moved.applied) {
      if (moved.reason === 'DUPLICATE') {
        this.logger.debug(`Points cashback for transaction ${transaction.id} was already credited`);
        return { credited: false, reason: 'ALREADY_CREDITED', computation };
      }
      this.logger.warn(
        `Points cashback for transaction ${transaction.id} not credited: ${moved.reason}`,
      );
      return { credited: false, reason: 'USER_NOT_FOUND', computation };
    }

    this.events.info(
      EVENT_TYPES.POINTS_CASHBACK_CREDITED,
      'USER',
      `Cashback credited: ${computation.points} points for transaction ${transaction.id}`,
      {
        userId: transaction.userId,
        transactionId: transaction.id,
        purchaseType: transaction.purchaseType,
        points: computation.points,
        balanceAfter: moved.balanceAfter,
        lines: computation.lines.filter((line) => line.points > 0).length,
      },
    );
    return {
      credited: true,
      points: computation.points,
      balanceAfter: moved.balanceAfter,
      entryId: moved.entryId,
    };
  }

  /**
   * Takes back what the purchase credited, floored at zero: the money has
   * already gone back to the payer, and a wallet driven negative is a debt
   * nobody collects. What was bought with the points is not hunted down —
   * the refunded subscription is revoked by the refund handler itself.
   */
  public async reverseForTransaction(transactionId: string): Promise<CashbackReverseOutcome> {
    const credited = await this.prismaService.pointsLedgerEntry.findUnique({
      where: {
        source_referenceKey: { source: PointsLedgerSource.CASHBACK, referenceKey: transactionId },
      },
      select: { id: true, userId: true, delta: true },
    });
    if (credited === null || credited.delta <= 0) return { reversed: false, reason: 'NOT_CREDITED' };

    const moved = await this.prismaService.$transaction((tx) =>
      this.pointsWallet.apply(tx, {
        userId: credited.userId,
        delta: -credited.delta,
        source: PointsLedgerSource.CASHBACK_REVERSED,
        referenceKey: transactionId,
        shortfall: 'floor',
        details: { transactionId, credited: credited.delta, creditedEntryId: credited.id },
      }),
    );
    if (!moved.applied) {
      if (moved.reason === 'DUPLICATE') return { reversed: false, reason: 'ALREADY_REVERSED' };
      this.logger.warn(`Points cashback reversal for transaction ${transactionId} not applied: ${moved.reason}`);
      return { reversed: false, reason: 'USER_NOT_FOUND' };
    }

    const debited = -moved.delta;
    this.events.info(
      EVENT_TYPES.POINTS_CASHBACK_REVERSED,
      'USER',
      `Cashback reversed: ${debited} of ${credited.delta} points taken back for transaction ${transactionId}`,
      {
        userId: credited.userId,
        transactionId,
        credited: credited.delta,
        debited,
        shortfall: moved.shortfall,
        balanceAfter: moved.balanceAfter,
      },
    );
    return { reversed: true, credited: credited.delta, debited, shortfall: moved.shortfall };
  }

  /** The global rule and the default currency, as the catalogue will read them too. */
  public async loadConfig(): Promise<CashbackConfig> {
    const settings = await this.prismaService.settings.findFirst({
      select: { pointsSettings: true, defaultCurrency: true },
    });
    const cashback = readCashbackSettings(settings?.pointsSettings);
    return {
      enabled: cashback.enabled,
      percent: cashback.percent,
      defaultCurrency: settings?.defaultCurrency ?? Currency.RUB,
    };
  }

  /**
   * The payment as lines. Three shapes, in the order they are told apart:
   * a combined renewal carries its items (each with its own add-on lines), a
   * standalone add-on carries an `ADDON_PURCHASE` snapshot, and everything
   * else is one plan with one purchased duration.
   */
  public async resolveLines(transaction: CashbackTransaction): Promise<CashbackLineInput[]> {
    const items = await this.prismaService.transactionItem.findMany({
      where: { transactionId: transaction.id },
      select: { planId: true, durationDays: true, amount: true, currency: true, addOnLines: true, planSnapshot: true },
    });

    const drafts: DraftLine[] = [];
    if (items.length > 0) {
      for (const item of items) {
        drafts.push({
          kind: 'PLAN',
          id: item.planId,
          name: readString(asRecord(item.planSnapshot)?.['name']) ?? item.planId,
          durationDays: item.durationDays,
          amount: item.amount,
          currency: item.currency,
        });
        for (const addOn of readAddOnLines(item.addOnLines)) {
          drafts.push({
            kind: 'ADD_ON',
            id: addOn.addOnId,
            name: addOn.name ?? addOn.addOnId,
            amount: addOn.unitAmount,
            currency: item.currency,
          });
        }
      }
    } else {
      const snapshot = asRecord(transaction.planSnapshot) ?? {};
      const addOnId = readString(snapshot['addOnId']);
      if (snapshot['snapshotSource'] === 'ADDON_PURCHASE' && addOnId !== null) {
        drafts.push({
          kind: 'ADD_ON',
          id: addOnId,
          name: readString(snapshot['name']) ?? addOnId,
          amount: transaction.amount,
          currency: transaction.currency,
        });
      } else {
        const planId = readString(snapshot['id']);
        if (planId === null) {
          this.logger.warn(`Points cashback: transaction ${transaction.id} names no plan and no add-on`);
          return [];
        }
        const durationDays = snapshot['selectedDurationDays'];
        drafts.push({
          kind: 'PLAN',
          id: planId,
          name: readString(snapshot['name']) ?? planId,
          durationDays: typeof durationDays === 'number' && Number.isInteger(durationDays) ? durationDays : undefined,
          amount: transaction.amount,
          currency: transaction.currency,
        });
      }
    }

    return this.attachRules(drafts, transaction.purchaseType);
  }

  private async attachRules(drafts: readonly DraftLine[], purchaseType: PurchaseType): Promise<CashbackLineInput[]> {
    const planIds = [...new Set(drafts.filter((line) => line.kind === 'PLAN').map((line) => line.id))];
    const addOnIds = [...new Set(drafts.filter((line) => line.kind === 'ADD_ON').map((line) => line.id))];

    const [plans, addOns] = await Promise.all([
      planIds.length === 0
        ? Promise.resolve([])
        : this.prismaService.plan.findMany({
            where: { id: { in: planIds } },
            select: {
              id: true,
              name: true,
              cashbackMode: true,
              cashbackPercent: true,
              durations: {
                select: {
                  days: true,
                  cashbackPoints: true,
                  prices: { select: { currency: true, price: true } },
                },
              },
            },
          }),
      addOnIds.length === 0
        ? Promise.resolve([])
        : this.prismaService.addOn.findMany({
            where: { id: { in: addOnIds } },
            select: {
              id: true,
              name: true,
              cashbackMode: true,
              cashbackPercent: true,
              cashbackPoints: true,
              prices: { select: { currency: true, price: true } },
            },
          }),
    ]);
    const planById = new Map(plans.map((plan) => [plan.id, plan]));
    const addOnById = new Map(addOns.map((addOn) => [addOn.id, addOn]));

    void purchaseType;
    return drafts.map((line): CashbackLineInput => {
      if (line.kind === 'PLAN') {
        const plan = planById.get(line.id);
        if (plan === undefined) return { ...line, rule: null, prices: [] };
        const duration =
          line.durationDays === undefined
            ? undefined
            : plan.durations.find((row) => row.days === line.durationDays);
        const rule: CashbackRule = {
          mode: plan.cashbackMode,
          percent: plan.cashbackPercent,
          fixedPoints: duration?.cashbackPoints ?? null,
        };
        return { ...line, name: line.name || plan.name, rule, prices: duration?.prices ?? [] };
      }
      const addOn = addOnById.get(line.id);
      if (addOn === undefined) return { ...line, rule: null, prices: [] };
      const rule: CashbackRule = {
        mode: addOn.cashbackMode,
        percent: addOn.cashbackPercent,
        fixedPoints: addOn.cashbackPoints,
      };
      return { ...line, name: line.name || addOn.name, rule, prices: addOn.prices };
    });
  }

  /**
   * A rule that exists and pays nothing for a reason the operator can fix is
   * worth a card: the plan has no price in the default currency, or the row
   * is gone from the catalogue. Excluded, disabled and zero rules are the
   * operator's own choices and stay quiet.
   */
  private reportSkippedLines(transaction: CashbackTransaction, computation: CashbackComputation): void {
    const worthReporting = computation.lines.filter(
      (line) => line.skipped === 'NO_DEFAULT_PRICE' || line.skipped === 'MISSING_CATALOG',
    );
    if (worthReporting.length === 0) return;
    this.events.warn(
      EVENT_TYPES.POINTS_CASHBACK_SKIPPED,
      'USER',
      `Cashback skipped for ${worthReporting.length} line(s) of transaction ${transaction.id}`,
      {
        userId: transaction.userId,
        transactionId: transaction.id,
        lines: worthReporting.map((line) => ({
          kind: line.kind,
          id: line.id,
          name: line.name,
          currency: line.currency,
          reason: line.skipped,
        })),
      },
    );
  }
}

interface DraftLine {
  readonly kind: 'PLAN' | 'ADD_ON';
  readonly id: string;
  readonly name: string;
  readonly durationDays?: number;
  readonly amount: Prisma.Decimal | string | number;
  readonly currency: Currency;
}

interface PaidAddOnLine {
  readonly addOnId: string;
  readonly unitAmount: string | number;
  readonly name: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Lenient on purpose. Fulfilment already validated these lines strictly and
 * refused the payment otherwise; by the time cashback reads them they are
 * commercial history, and a hook that runs after the money moved must not
 * throw over a field it does not even use. An entry it cannot read is left
 * out, and left out is zero points, not a failed hook.
 */
function readAddOnLines(raw: Prisma.JsonValue | null): PaidAddOnLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: PaidAddOnLine[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) continue;
    const addOnId = readString(record['addOnId']);
    const unitAmount = readAmount(record['unitAmount']);
    if (addOnId === null || unitAmount === null) continue;
    lines.push({ addOnId, unitAmount, name: readString(record['receiptName']) });
  }
  return lines;
}

/** A decimal the computation can take: a finite number, or a plain decimal string. */
function readAmount(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim();
  return null;
}
