import { ArchivedPlanRenewMode, Prisma, PurchaseType, SubscriptionStatus, TransactionStatus } from '@prisma/client';

import { resolvePlanMigrationGuardCandidate } from '../../payments/services/payment-renewal-plan-migration-guard.util';
import {
  readRefundedTotal,
  readRefundLedger,
  REFUND_REVERSAL_CLAIMED_AT_KEY,
} from '../../payments/utils/payment-refund-ledger.util';
import { isWithheldConversion, MANUAL_REFUND_RECORDED_AT_KEY } from '../../payments/utils/trial-conversion.util';

/**
 * What is left of the old plan when a subscription is UPGRADED, turned into
 * days on the new plan — «остаток дней правильно перенести не в пользу
 * пользователя, что бы не было абуза системы улучшения» (the owner).
 *
 * An upgrade restarts the term at the payment (`expiresAt = now + days`). What
 * the customer had paid for beyond `now` used to be lost; now it is added:
 * `expiresAt = now + days + convertedDays`. The PRICE of the upgrade does not
 * change — gateways, promocodes, provider autopay amounts and analytics are all
 * untouched. Only the expiry moves.
 *
 * ── The rule: money actually paid, never calendar days × list price ───────
 *
 * 1. PAID CHUNKS. A payment of THIS subscription that bought time: NEW,
 *    ADDITIONAL, RENEW or UPGRADE (a trial's conversion is an UPGRADE),
 *    COMPLETED and fulfilled, with a positive amount — and worth what actually
 *    arrived when the provider reported less than the invoice. Never an
 *    add-on, an imported donor payment, a withheld payment, one with any
 *    refund, partial refund, chargeback, reversal or «Отметить возврат» on it,
 *    or the upgrade being fulfilled. A renewal that paid for several
 *    subscriptions at once is worth only THIS subscription's own line (its
 *    amount and its days), and nothing when that line cannot be told.
 * 2. THE PAID-THROUGH DATE, rebuilt in fulfilment order: NEW, ADDITIONAL and
 *    UPGRADE start a chain (`end = fulfilledAt + days`), RENEW extends it
 *    (`end = max(end, fulfilledAt) + days`). Free days — the wheel, referrals,
 *    quests, compensation, an operator's extension, a pull from Remnawave, the
 *    trial itself — are in no chunk and so worth nothing; a renewal after a
 *    lapse starts at its payment; bonus days that sat between two chunks make
 *    the result smaller, never larger.
 * 3. THE WINDOW still paid for: `[now, min(paidThrough, expiresAt))`. The cap
 *    by `expiresAt` is an operator who shortened the subscription.
 * 4. EACH CHUNK in that window is worth `overlapDays × amount / chunkDays` in
 *    its own currency C, divided by the NEW plan's MOST EXPENSIVE day in C —
 *    `max(price_C / days)` over its active finite durations, usually the
 *    shortest. No exchange rates: a currency the new plan has no price in
 *    converts to nothing.
 * 5. SUM, FLOOR, CAP: the fractional days are summed, floored, and capped at
 *    the whole days still paid for — a plan with a cheaper day never makes the
 *    time longer than it was.
 *
 * Money is `Prisma.Decimal` throughout, and each chunk's days are ONE fraction
 * (`amount × overlapMs × planDays / (chunkDays × DAY_MS × planPrice)`), so a
 * vector the owner worked out by hand — 240 ₽ with 20 of 30 days left, onto
 * 600 ₽ / 30 days — comes out at exactly 8, not 7.999….
 *
 * ── Why chains of upgrades accumulate nothing ─────────────────────────────
 *
 * The days an upgrade ADDED are in no chunk: its own chunk is `days`, not
 * `days + converted`. So a second upgrade converts only what the first one's
 * payment bought, and upgrading back and forth cannot grow the term.
 *
 * Refinements over the rule as stated, each in the operator's favour and each
 * closing a way round it:
 *
 *   - A plan change that WAS applied restarts the chain even when it is worth
 *     nothing itself — refunded, charged back, free, or bought for an
 *     unlimited term. Everything before it ends at its payment. Dropping it
 *     instead would let the chunks it had already converted count a second
 *     time: pay an upgrade, get it refunded, upgrade again.
 *   - A renewal that is worth nothing — refunded, free, unlimited, or a line
 *     that cannot be told — is left out of the chain altogether, exactly like
 *     bonus days: its days never push a paid chunk later.
 *   - A plan change NOT YET APPLIED to the subscription is not in the chain.
 *     Every applied NEW, ADDITIONAL and UPGRADE stamps the subscription's
 *     `startedAt` with the `now` it stamps its own `fulfilledAt` with (the only
 *     writers of `startedAt` are the ones that create a subscription and the
 *     upgrade), so one fulfilled later than `startedAt`, and lately — see
 *     {@link CLAIM_IN_FLIGHT_MS} — is a payment another worker has only
 *     CLAIMED: waiting for this row's lock, to be applied, withheld as a
 *     trial's second conversion, or rolled back and released. Read as applied,
 *     it restarted the chain at its claim and priced the whole window at its
 *     own money.
 *   - When the rebuilt chain runs past the subscription's expiry — an operator
 *     cut it short, or a renewal is claimed and not applied yet (its days are
 *     in the chain but not in `expiresAt`, and no stamp tells it apart) — the
 *     excess comes off the DEAREST days first. So neither can make a day of
 *     the window dearer than one the subscription actually holds.
 *
 * A WITHHELD payment was applied to nothing (see `trial-conversion.util.ts`),
 * so it is not in the chain at all.
 *
 * ── A refund after the upgrade ────────────────────────────────────────────
 *
 * A payment refunded BEFORE an upgrade is worth nothing to it. One refunded
 * AFTER already bought days of the upgrade's term, and a refund takes no days
 * back from a renewal or a plan change (`reverseFulfilledPayment` leaves those
 * to the operator). {@link findDaysConvertedFromPayment} names those days, per
 * upgrade, for the refund's card.
 *
 * ── One function, two callers ─────────────────────────────────────────────
 *
 * Fulfilment (`upgradeSubscriptionFromPayment`, under the subscription's row
 * lock, with the same `now` as the new expiry) and the upgrade quote (an
 * estimate for the review screen) both call {@link reconstructPaidWindow} and
 * {@link convertPaidRemainder}, over rows read by
 * {@link readPaidRemainderCandidates}. They cannot disagree about the rule;
 * they differ only in `now`.
 *
 * ── A renewal priced for the plan an upgrade left ─────────────────────────
 *
 * The same money rule, the other way round: a RENEW drafted on the old plan
 * and paid after the subscription was upgraded buys days of the plan it is on
 * NOW — its amount divided by that plan's most expensive day, floored, never
 * more than the days it was priced for. See
 * {@link readRenewalPricedBeforeUpgrade} and
 * {@link convertRenewalPricedBeforeUpgrade}.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a payment can stay CLAIMED without being applied or released. The
 * claim (`fulfilledAt`) commits before fulfilment's own transaction, which
 * waits for the subscription's row lock and then commits — moving `startedAt`
 * to the claim's apply — or rolls back and releases the claim: seconds, on
 * Prisma's default interactive transaction (2 s to start, 5 s to run). Ten
 * minutes is a wide margin.
 *
 * Why there is a bound at all: a `fulfilledAt` later than the start is not
 * always a claim. The migration that introduced the column
 * (`20260706130000_add_transaction_fulfilled_at`) stamped every payment
 * completed before it with `fulfilled_at = updated_at` — after the start that
 * payment made, by milliseconds or by months. Without the bound, every chain
 * begun before that migration lost its first payment: the renewals after it
 * then started earlier, and the days still paid for came out fewer.
 */
const CLAIM_IN_FLIGHT_MS = 10 * 60 * 1000;

/** The kinds of payment that buy a subscription time. */
const TIME_BUYING_PURCHASES: ReadonlySet<string> = new Set([
  PurchaseType.NEW,
  PurchaseType.ADDITIONAL,
  PurchaseType.RENEW,
  PurchaseType.UPGRADE,
]);

/** A NEW, ADDITIONAL or UPGRADE payment starts the term over at its payment. */
const CHAIN_STARTERS: ReadonlySet<string> = new Set([
  PurchaseType.NEW,
  PurchaseType.ADDITIONAL,
  PurchaseType.UPGRADE,
]);

/**
 * States a fulfilled payment can be in once it was APPLIED: COMPLETED, and
 * CANCELED (or the legacy REFUNDED) after a refund or chargeback reversed it.
 * A reversal of a RENEW or an UPGRADE does not undo what the payment did to
 * the subscription (`reverseFulfilledPayment`), so such a payment still
 * restarted the chain; it only stops being worth anything.
 */
const APPLIED_STATUSES: ReadonlySet<string> = new Set([
  TransactionStatus.COMPLETED,
  TransactionStatus.CANCELED,
  TransactionStatus.REFUNDED,
]);

/**
 * `gatewayData` keys only a refund, a partial refund, a chargeback or its
 * reversal writes (`payment-refund.service.ts`,
 * `PaymentReconciliationService.handleRefundReversal` /
 * `reverseFulfilledPayment`). Any of them, in any state, makes the payment
 * worth nothing here: a refund that is only requested, or a reversal still
 * under way, is not money the customer left with us.
 *
 * `manualRefundRecordedAt` is «Отметить возврат»: the operator's word that the
 * money went back at the provider. It is committed BEFORE the reversal takes
 * its own claim, so a run that dies in between leaves the payment COMPLETED
 * with that key alone.
 */
const REFUND_MARK_KEYS: readonly string[] = [
  'refundReversedAt',
  REFUND_REVERSAL_CLAIMED_AT_KEY,
  'partialRefundAt',
  'refundRequestedAt',
  'refundId',
  'refundNeedsManualReview',
  MANUAL_REFUND_RECORDED_AT_KEY,
];

type DecimalLike = Prisma.Decimal | string | number;

/** One line of a renewal that paid for several subscriptions at once. */
export interface PaidRemainderCandidateItem {
  readonly subscriptionId: string;
  readonly durationDays: number;
  readonly amount: DecimalLike;
  readonly currency: string;
  readonly appliedAt: Date | null;
}

/** A payment linked to the subscription, as {@link readPaidRemainderCandidates} reads it. */
export interface PaidRemainderCandidate {
  readonly id: string;
  readonly subscriptionId: string | null;
  readonly purchaseType: string;
  readonly status: string;
  readonly fulfilledAt: Date | null;
  readonly amount: DecimalLike;
  readonly currency: string;
  readonly planSnapshot: unknown;
  readonly gatewayData: unknown;
  readonly items: readonly PaidRemainderCandidateItem[];
}

/** One duration of a plan, with its prices. */
export interface PaidRemainderPlanDuration {
  readonly days: number;
  readonly isActive: boolean;
  readonly prices: readonly { readonly currency: string; readonly price: DecimalLike }[];
}

/** The subscription being upgraded, as it stands under its row lock. */
export interface PaidRemainderSubscription {
  readonly id: string;
  readonly status: string;
  readonly expiresAt: Date | null;
  /**
   * When its current term started: stamped by the payment that created it or
   * by its last applied upgrade. `null` on a row nothing ever stamped, which
   * then tells no applied plan change from a merely claimed one.
   */
  readonly startedAt: Date | null;
}

/** A paid chunk that overlaps the window still paid for. */
export interface PaidRemainderOverlap {
  readonly transactionId: string;
  /** The chunk's time from `now` to the rebuilt paid-through date. */
  readonly overlapMs: number;
  /** The days the chunk bought. */
  readonly chunkDays: number;
  readonly amount: Prisma.Decimal;
  readonly currency: string;
}

/** What {@link reconstructPaidWindow} found: the window still paid for and the chunks in it. */
export interface PaidRemainderWindow {
  readonly from: Date;
  /** `min(paidThrough, expiresAt)`; not after `from` when nothing is left. */
  readonly to: Date;
  /** The rebuilt paid-through date, or null with no paid chunk at all. */
  readonly paidThrough: Date | null;
  /** Chunk time in `[now, paidThrough)`, before the cap at `expiresAt`. */
  readonly overlaps: readonly PaidRemainderOverlap[];
  /** How far the rebuilt chain runs past `to`: taken off the dearest days. */
  readonly overshootMs: number;
}

/** What one paid chunk contributed, as the provenance records it. */
export interface PaidRemainderSource {
  readonly transactionId: string;
  /** The chunk's days inside the window, 4 decimal places. */
  readonly overlapDays: string;
  /** What those days were paid, in `currency`, 2 decimal places. */
  readonly value: string;
  readonly currency: string;
  /** Days on the new plan, before the floor and the cap, 4 decimal places. */
  readonly days: string;
}

/** The outcome: whole days to add to the new term, and where they came from. */
export interface PaidRemainderConversion {
  /** Whole days added to the new term: floored, then capped. Never negative. */
  readonly days: number;
  /** The sum before the floor and the cap, 4 decimal places. */
  readonly fractionalDays: string;
  /** The whole days still paid for — the cap. */
  readonly remainingPaidDays: number;
  readonly paidThrough: Date | null;
  readonly sources: readonly PaidRemainderSource[];
}

/** The columns {@link readPaidRemainderCandidates} reads, both halves alike. */
const CANDIDATE_SELECT = {
  id: true,
  subscriptionId: true,
  purchaseType: true,
  status: true,
  fulfilledAt: true,
  amount: true,
  currency: true,
  planSnapshot: true,
  gatewayData: true,
  items: {
    select: { subscriptionId: true, durationDays: true, amount: true, currency: true, appliedAt: true },
  },
} as const satisfies Prisma.TransactionSelect;

/**
 * Reads every payment linked to `subscriptionId` that was ever fulfilled — its
 * own, and the renewals that paid for it among others (their `items`). Status,
 * refunds and the rest are decided by {@link reconstructPaidWindow}, not here,
 * so both callers see the same rows.
 *
 * TWO reads, merged here, each on its own index: `transactions.subscription_id`
 * for the subscription's own payments, and `transaction_items.subscription_id`
 * for the renewals that paid for it among others (a semi-join to their
 * parents). One read with an `OR` over both made PostgreSQL scan every payment
 * — 27 ms, and 383 ms in the EXISTS form, at 400 000 rows — under the
 * subscription's row lock and on every upgrade quote.
 */
export async function readPaidRemainderCandidates(
  db: Pick<Prisma.TransactionClient, 'transaction'>,
  subscriptionId: string,
): Promise<PaidRemainderCandidate[]> {
  const own = await db.transaction.findMany({
    where: { subscriptionId, fulfilledAt: { not: null } },
    select: CANDIDATE_SELECT,
  });
  const lines = await db.transaction.findMany({
    where: { fulfilledAt: { not: null }, items: { some: { subscriptionId } } },
    select: CANDIDATE_SELECT,
  });
  const byId = new Map<string, PaidRemainderCandidate>();
  for (const row of [...own, ...lines]) byId.set(row.id, row);
  return [...byId.values()].sort(
    (left, right) =>
      (left.fulfilledAt?.getTime() ?? 0) - (right.fulfilledAt?.getTime() ?? 0) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

/**
 * Rebuilds the paid-through date from the payments and returns the window
 * still paid for, with the chunks that overlap it. Pure.
 */
export function reconstructPaidWindow(input: {
  readonly now: Date;
  readonly subscription: PaidRemainderSubscription;
  readonly candidates: readonly PaidRemainderCandidate[];
  /** The upgrade being fulfilled: never a source of its own conversion. */
  readonly excludeTransactionId?: string | null;
}): PaidRemainderWindow {
  const nowMs = input.now.getTime();
  const empty = (paidThrough: Date | null): PaidRemainderWindow => ({
    from: input.now,
    to: input.now,
    paidThrough,
    overlaps: [],
    overshootMs: 0,
  });
  // An expired subscription has nothing left, whatever its payments say.
  if (
    input.subscription.status === SubscriptionStatus.EXPIRED ||
    input.subscription.status === SubscriptionStatus.DELETED ||
    (input.subscription.expiresAt !== null && input.subscription.expiresAt.getTime() <= nowMs)
  ) {
    return empty(null);
  }

  const startedAtMs = input.subscription.startedAt?.getTime() ?? null;
  const events = input.candidates
    .map((candidate) => readChainEvent(candidate, input.subscription.id, input.excludeTransactionId ?? null))
    .filter((event): event is ChainEvent => event !== null)
    // A plan change fulfilled after the subscription's own start, lately, was
    // not applied to it: only claimed, see "NOT YET APPLIED" above.
    .filter(
      (event) =>
        !(
          event.startsChain &&
          startedAtMs !== null &&
          event.atMs > startedAtMs &&
          event.atMs > nowMs - CLAIM_IN_FLIGHT_MS
        ),
    )
    .sort((left, right) => left.atMs - right.atMs || (left.transactionId < right.transactionId ? -1 : 1));

  interface Chunk {
    readonly transactionId: string;
    readonly startMs: number;
    endMs: number;
    readonly days: number;
    readonly amount: Prisma.Decimal;
    readonly currency: string;
  }
  const chunks: Chunk[] = [];
  let endMs: number | null = null;
  for (const event of events) {
    if (event.startsChain) {
      // Whatever came before ends here: the plan change discarded it.
      for (const chunk of chunks) chunk.endMs = Math.min(chunk.endMs, event.atMs);
      if (event.paid === null) {
        endMs = event.atMs;
        continue;
      }
      const chunkEnd = event.atMs + event.paid.days * DAY_MS;
      chunks.push({ transactionId: event.transactionId, startMs: event.atMs, endMs: chunkEnd, ...event.paid });
      endMs = chunkEnd;
      continue;
    }
    // A renewal worth nothing is left out, like bonus days.
    if (event.paid === null) continue;
    const startMs = Math.max(endMs ?? event.atMs, event.atMs);
    const chunkEnd = startMs + event.paid.days * DAY_MS;
    chunks.push({ transactionId: event.transactionId, startMs, endMs: chunkEnd, ...event.paid });
    endMs = chunkEnd;
  }
  if (chunks.length === 0 || endMs === null) return empty(null);

  const paidThroughMs = endMs;
  const toMs =
    input.subscription.expiresAt === null
      ? paidThroughMs
      : Math.min(paidThroughMs, input.subscription.expiresAt.getTime());
  if (toMs <= nowMs) return empty(new Date(paidThroughMs));

  const overlaps: PaidRemainderOverlap[] = [];
  for (const chunk of chunks) {
    const overlapMs = Math.min(chunk.endMs, paidThroughMs) - Math.max(chunk.startMs, nowMs);
    if (overlapMs <= 0) continue;
    overlaps.push({
      transactionId: chunk.transactionId,
      overlapMs,
      chunkDays: chunk.days,
      amount: chunk.amount,
      currency: chunk.currency,
    });
  }
  return {
    from: input.now,
    to: new Date(toMs),
    paidThrough: new Date(paidThroughMs),
    overlaps,
    overshootMs: paidThroughMs - toMs,
  };
}

/**
 * Turns the window into whole days on the new plan: each chunk's unused money
 * divided by the new plan's most expensive day in its currency, summed,
 * floored, capped at the whole days still paid for. Pure.
 */
export function convertPaidRemainder(input: {
  readonly window: PaidRemainderWindow;
  readonly targetPlanDurations: readonly PaidRemainderPlanDuration[];
  /**
   * The term the upgrade buys. An unlimited one (`-1`) has no end to add days
   * to, so nothing converts.
   */
  readonly purchasedDurationDays?: number | null;
}): PaidRemainderConversion {
  const windowMs = Math.max(0, input.window.to.getTime() - input.window.from.getTime());
  const remainingPaidDays = Math.floor(windowMs / DAY_MS);
  const finiteTerm =
    input.purchasedDurationDays === undefined ||
    input.purchasedDurationDays === null ||
    input.purchasedDurationDays > 0;

  const rated = input.window.overlaps.map((overlap, index) => {
    const dearest = finiteTerm ? mostExpensiveDay(input.targetPlanDurations, overlap.currency) : null;
    // New-plan days per millisecond of this chunk: amount × planDays / (chunkDays × DAY_MS × planPrice).
    const rate =
      dearest === null
        ? new Prisma.Decimal(0)
        : overlap.amount
            .mul(dearest.days)
            .div(new Prisma.Decimal(overlap.chunkDays).mul(DAY_MS).mul(dearest.price));
    return { overlap, dearest, rate, index };
  });
  // The chain's time past the expiry comes off the dearest days first.
  const countedMs = new Map<number, number>(rated.map((entry) => [entry.index, entry.overlap.overlapMs]));
  let excessMs = Math.max(0, input.window.overshootMs);
  for (const entry of [...rated].sort((left, right) => right.rate.comparedTo(left.rate) || left.index - right.index)) {
    if (excessMs <= 0) break;
    const cut = Math.min(excessMs, entry.overlap.overlapMs);
    countedMs.set(entry.index, entry.overlap.overlapMs - cut);
    excessMs -= cut;
  }

  let total = new Prisma.Decimal(0);
  const sources: PaidRemainderSource[] = [];
  for (const { overlap, dearest, index } of rated) {
    const counted = countedMs.get(index) ?? 0;
    if (counted <= 0) continue;
    const chunkMs = new Prisma.Decimal(overlap.chunkDays).mul(DAY_MS);
    const value = overlap.amount.mul(counted).div(chunkMs);
    // ONE fraction per chunk: amount × counted × planDays / (chunkDays × DAY_MS × planPrice).
    const days =
      dearest === null
        ? new Prisma.Decimal(0)
        : overlap.amount.mul(counted).mul(dearest.days).div(chunkMs.mul(dearest.price));
    total = total.add(days);
    sources.push({
      transactionId: overlap.transactionId,
      overlapDays: new Prisma.Decimal(counted).div(DAY_MS).toFixed(4),
      value: value.toFixed(2),
      currency: overlap.currency,
      days: days.toFixed(4),
    });
  }
  const floored = total.floor().toNumber();
  return {
    days: Math.max(0, Math.min(floored, remainingPaidDays)),
    fractionalDays: total.toFixed(4),
    remainingPaidDays,
    paidThrough: input.window.paidThrough,
    sources,
  };
}

/** {@link reconstructPaidWindow} then {@link convertPaidRemainder}, for a caller holding everything. */
export function resolvePaidRemainderConversion(input: {
  readonly now: Date;
  readonly subscription: PaidRemainderSubscription;
  readonly candidates: readonly PaidRemainderCandidate[];
  readonly excludeTransactionId?: string | null;
  readonly targetPlanDurations: readonly PaidRemainderPlanDuration[];
  readonly purchasedDurationDays?: number | null;
}): PaidRemainderConversion {
  return convertPaidRemainder({
    window: reconstructPaidWindow(input),
    targetPlanDurations: input.targetPlanDurations,
    purchasedDurationDays: input.purchasedDurationDays,
  });
}

/**
 * The conversion at fulfilment, inside its transaction. The caller holds the
 * subscription's row lock and passes the row it read under it, and the `now`
 * the new expiry is counted from.
 *
 * The new plan's prices are read only when a paid chunk overlaps the window —
 * the outcome is the same either way; a trial's conversion and an expired
 * subscription simply skip the query.
 */
export async function resolvePaidRemainderConversionInTransaction(
  tx: Pick<Prisma.TransactionClient, 'transaction' | 'planDuration'>,
  input: {
    readonly now: Date;
    readonly subscription: PaidRemainderSubscription;
    readonly excludeTransactionId: string;
    readonly planId: string;
    readonly purchasedDurationDays: number;
  },
): Promise<PaidRemainderConversion> {
  const window = reconstructPaidWindow({
    now: input.now,
    subscription: input.subscription,
    candidates: await readPaidRemainderCandidates(tx, input.subscription.id),
    excludeTransactionId: input.excludeTransactionId,
  });
  const targetPlanDurations =
    window.overlaps.length === 0
      ? []
      : await tx.planDuration.findMany({
          where: { planId: input.planId },
          select: { days: true, isActive: true, prices: { select: { currency: true, price: true } } },
        });
  return convertPaidRemainder({ window, targetPlanDurations, purchasedDurationDays: input.purchasedDurationDays });
}

/**
 * Where the upgrade records its conversion, in its own `gatewayData`: the days
 * added and, per source payment, what it contributed. Written with the upgrade
 * whenever a paid chunk was found, so «why +6 days» has an answer on the row —
 * and so a later refund of a source payment can find the days it bought
 * ({@link findDaysConvertedFromPayment}).
 */
export const PAID_REMAINDER_CONVERSION_KEY = 'paidRemainderConversion';

/** The provenance written under {@link PAID_REMAINDER_CONVERSION_KEY}. */
export function paidRemainderProvenance(
  conversion: PaidRemainderConversion,
  now: Date,
): Record<string, unknown> {
  return {
    days: conversion.days,
    fractionalDays: conversion.fractionalDays,
    remainingPaidDays: conversion.remainingPaidDays,
    paidThrough: conversion.paidThrough?.toISOString() ?? null,
    computedAt: now.toISOString(),
    sources: conversion.sources.map((source) => ({ ...source })),
  };
}

// ── A refund after the upgrade ─────────────────────────────────────────────

/** Days of one applied upgrade's conversion that a given payment's money bought. */
export interface ConvertedDaysAttribution {
  readonly upgradeTransactionId: string;
  readonly upgradePaymentId: string;
  readonly subscriptionId: string;
  readonly upgradeFulfilledAt: Date;
  /** Whole days: the ceiling of the payment's share, never more than the upgrade added. */
  readonly days: number;
  /** Every day that upgrade added. */
  readonly upgradeDays: number;
}

/**
 * Contract: for a refund of payment `transactionId`, every later applied upgrade of its subscription(s) whose conversion counted its money, with the whole days of each it bought (ceiling of its share, capped at the upgrade's days) — named for the operator's review, nothing taken back.
 *
 * Read by the upgrades' own provenance ({@link PAID_REMAINDER_CONVERSION_KEY});
 * a withheld upgrade converted nothing and has none. Two indexed reads: the
 * payment by id (with its lines, for a renewal that paid for several
 * subscriptions — each line's subscription is searched), then the UPGRADEs of
 * those subscriptions fulfilled at or after it (`transactions.subscription_id`).
 * Conservative on purpose: a share of 6.15 days names 7, unless the upgrade
 * added only 6.
 */
export async function findDaysConvertedFromPayment(
  db: Pick<Prisma.TransactionClient, 'transaction'>,
  transactionId: string,
): Promise<ConvertedDaysAttribution[]> {
  const payment = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, subscriptionId: true, fulfilledAt: true, items: { select: { subscriptionId: true } } },
  });
  if (payment === null || payment.fulfilledAt === null) return [];
  const subscriptionIds = [
    ...new Set(
      [payment.subscriptionId, ...payment.items.map((item) => item.subscriptionId)].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
  if (subscriptionIds.length === 0) return [];
  const upgrades = await db.transaction.findMany({
    where: {
      subscriptionId: { in: subscriptionIds },
      purchaseType: PurchaseType.UPGRADE,
      fulfilledAt: { gte: payment.fulfilledAt },
      id: { not: payment.id },
    },
    select: { id: true, paymentId: true, subscriptionId: true, fulfilledAt: true, gatewayData: true },
    orderBy: [{ fulfilledAt: 'asc' }, { id: 'asc' }],
  });
  const attributions: ConvertedDaysAttribution[] = [];
  for (const upgrade of upgrades) {
    const provenance = asRecord(asRecord(upgrade.gatewayData)[PAID_REMAINDER_CONVERSION_KEY]);
    const added = provenance['days'];
    if (typeof added !== 'number' || !Number.isInteger(added) || added <= 0) continue;
    const sources = Array.isArray(provenance['sources']) ? provenance['sources'] : [];
    let share = new Prisma.Decimal(0);
    for (const entry of sources) {
      const source = asRecord(entry);
      if (source['transactionId'] !== payment.id) continue;
      const days = readDecimal(source['days']);
      if (days !== null && days.gt(0)) share = share.add(days);
    }
    if (!share.gt(0) || upgrade.subscriptionId === null || upgrade.fulfilledAt === null) continue;
    attributions.push({
      upgradeTransactionId: upgrade.id,
      upgradePaymentId: upgrade.paymentId,
      subscriptionId: upgrade.subscriptionId,
      upgradeFulfilledAt: upgrade.fulfilledAt,
      days: Math.min(share.ceil().toNumber(), added),
      upgradeDays: added,
    });
  }
  return attributions;
}

// ── A renewal priced for the plan an upgrade left ──────────────────────────

/**
 * Whether a RENEW being fulfilled was priced for a plan the subscription has
 * since been UPGRADED off: the plan it paid for is not the one its snapshot
 * names, and the subscription's `startedAt` — which only an applied upgrade
 * moves on an existing row — is later than the payment's draft. Returns the
 * plan it is on now, or `null`.
 *
 * `null` for every other renewal onto another plan: one priced for an
 * archived plan's replacement or for a plan the subscriber chose is meant to
 * move the subscription and still does, and one a plan migration moved is
 * `findLatePlanMigrationRenewal`'s (owner's decision 10: kept on the current
 * plan for its whole period). "Another plan" is read exactly as that guard
 * reads it (`resolvePlanMigrationGuardCandidate`).
 */
export function readRenewalPricedBeforeUpgrade(input: {
  readonly subscription: { readonly planSnapshot: unknown; readonly startedAt: Date | null };
  readonly paidPlanId: string;
  readonly draftedAt: Date;
}): { readonly currentPlanId: string } | null {
  const currentPlanId = resolvePlanMigrationGuardCandidate(input.subscription.planSnapshot, input.paidPlanId);
  if (currentPlanId === null) return null;
  // A row read without the column says nothing about an upgrade, as a row
  // nothing ever stamped does.
  const startedAt = input.subscription.startedAt ?? null;
  if (startedAt === null || startedAt.getTime() <= input.draftedAt.getTime()) return null;
  return { currentPlanId };
}

/** The fields of a plan row {@link renewsAsItself} reads. */
export interface RenewalSourcePlan {
  readonly id: string;
  readonly deletedAt: Date | null;
  readonly isArchived: boolean;
  readonly archivedRenewMode: ArchivedPlanRenewMode;
}

/**
 * Whether a renewal of a subscription on `plan` prices `plan` itself — and
 * nothing else. It does unless the plan is soft-deleted (the renewal offers
 * the catalogue to choose from) or archived to be REPLACED on renewal (it
 * offers the replacements). The same branches `SubscriptionQuoteService`
 * walks for a RENEW (`getSourceSelection`).
 */
export function renewsAsItself(plan: Omit<RenewalSourcePlan, 'id'>): boolean {
  if (plan.deletedAt !== null) return false;
  return !(plan.isArchived && plan.archivedRenewMode === ArchivedPlanRenewMode.REPLACE_ON_RENEW);
}

/**
 * Whether a RENEW being fulfilled was priced for a plan the subscription has
 * since been MOVED off by something that leaves `startedAt` alone —
 * «Назначить план», the bulk assignment of imported subscriptions — judged by
 * PLAN IDENTITY: the plan it paid for is not the one its snapshot names, and
 * the plan it is on now renews as itself ({@link renewsAsItself}). No renewal
 * checkout of the subscription as it stands could have priced the paid plan,
 * so the payment was drafted before the move. Returns the plan it is on now,
 * or `null`.
 *
 * `null` for a renewal onto another plan the current plan legitimately leads
 * to — an archived plan's replacement, a plan chosen because the current one
 * is deleted or gone — and when the current plan's row is missing.
 *
 * Asked AFTER {@link readRenewalPricedBeforeUpgrade} and after the plan
 * migration guard (`findLatePlanMigrationRenewal`, owner's decision 10), which
 * both settle their own cases first: a move by a migration keeps its whole
 * period, and this rule would otherwise read it as an assignment.
 */
export function readRenewalPricedBeforePlanChange(input: {
  readonly subscription: { readonly planSnapshot: unknown };
  readonly paidPlanId: string;
  /** The row of the plan the snapshot names, read by id; `null` when it is gone. */
  readonly currentPlan: RenewalSourcePlan | null;
}): { readonly currentPlanId: string } | null {
  const currentPlanId = resolvePlanMigrationGuardCandidate(input.subscription.planSnapshot, input.paidPlanId);
  if (currentPlanId === null || input.currentPlan === null || input.currentPlan.id !== currentPlanId) return null;
  return renewsAsItself(input.currentPlan) ? { currentPlanId } : null;
}

/** What a renewal priced before an upgrade buys on the plan the subscription is on now. */
export interface RenewalPricedBeforeUpgradeConversion {
  /** Whole days added on the current plan: floored, never more than {@link paidDays}. */
  readonly days: number;
  /** Before the floor and the cap, 4 decimal places. */
  readonly fractionalDays: string;
  /** The days the payment was priced for. */
  readonly paidDays: number;
  /** The money counted — what arrived — 2 decimal places. */
  readonly amount: string;
  readonly currency: string;
  /** The current plan's most expensive day in {@link currency}; null when it has no price there. */
  readonly dearestDay: { readonly price: string; readonly days: number } | null;
}

/**
 * The money rule for such a renewal: its amount divided by the current plan's
 * most expensive day in the payment's currency, floored, capped at the days it
 * was priced for; a currency the plan has no price in gives 0. Never the full
 * period — that would sell the dearer plan at the old plan's price. Pure.
 */
export function convertRenewalPricedBeforeUpgrade(input: {
  /** The payment's amount, or its line's for a renewal of several subscriptions. */
  readonly amount: DecimalLike;
  readonly currency: string;
  readonly paidDays: number;
  readonly currentPlanDurations: readonly PaidRemainderPlanDuration[];
  /** The payment's `gatewayData`: a reported shortfall lowers the money counted. */
  readonly gatewayData?: unknown;
  /** The whole payment's amount when {@link amount} is one line of it. */
  readonly paymentAmount?: DecimalLike;
}): RenewalPricedBeforeUpgradeConversion {
  const line = toDecimal(input.amount) ?? new Prisma.Decimal(0);
  const whole = input.paymentAmount === undefined ? line : (toDecimal(input.paymentAmount) ?? line);
  const received = receivedPart(line, whole, input.gatewayData);
  const dearest = mostExpensiveDay(input.currentPlanDurations, input.currency);
  const fractional =
    dearest === null || !received.gt(0) ? new Prisma.Decimal(0) : received.mul(dearest.days).div(dearest.price);
  const floored = fractional.floor().toNumber();
  const capped = input.paidDays > 0 ? Math.min(floored, input.paidDays) : floored;
  return {
    days: Math.max(0, capped),
    fractionalDays: fractional.toFixed(4),
    paidDays: input.paidDays,
    amount: received.toFixed(2),
    currency: input.currency,
    dearestDay: dearest === null ? null : { price: dearest.price.toString(), days: dearest.days },
  };
}

/**
 * Where such a renewal records what it did, in its own `gatewayData`: per
 * subscription line, the plan it was priced for, the plan it renewed, the days
 * it was priced for and the days it bought.
 */
export const RENEWAL_PRICED_BEFORE_UPGRADE_KEY = 'renewalPricedBeforeUpgrade';

/** Machine code on the completion of such a renewal. */
export const RENEWAL_PRICED_BEFORE_UPGRADE_CODE = 'RENEWAL_PRICED_BEFORE_UPGRADE';

/** The completion's message; operator text, as `LATE_PLAN_MIGRATION_RENEWAL_MESSAGE` is. */
export const RENEWAL_PRICED_BEFORE_UPGRADE_MESSAGE =
  'Продление оплачено по цене тарифа, с которого подписку уже улучшили';

/**
 * Machine code on the completion of a renewal priced before a plan change
 * that was not an upgrade ({@link readRenewalPricedBeforePlanChange}).
 */
export const RENEWAL_PRICED_BEFORE_PLAN_CHANGE_CODE = 'RENEWAL_PRICED_BEFORE_PLAN_CHANGE';

/** Its message, beside {@link RENEWAL_PRICED_BEFORE_UPGRADE_MESSAGE}. */
export const RENEWAL_PRICED_BEFORE_PLAN_CHANGE_MESSAGE =
  'Продление оплачено по цене тарифа, с которого подписку уже перевели';

/** One renewal line kept on the plan an upgrade put its subscription on. */
export interface RenewalPricedBeforeUpgrade {
  readonly subscriptionId: string;
  readonly paidPlanId: string;
  readonly paidPlanName: string;
  readonly currentPlanId: string;
  readonly currentPlanName: string | null;
  readonly conversion: RenewalPricedBeforeUpgradeConversion;
  /**
   * What moved the subscription after the draft: a paid UPGRADE (its
   * `startedAt`, {@link readRenewalPricedBeforeUpgrade}), or any other
   * PLAN_CHANGE (plan identity, {@link readRenewalPricedBeforePlanChange}).
   * Absent means UPGRADE. The money rule is the same; only the words differ.
   */
  readonly cause?: 'UPGRADE' | 'PLAN_CHANGE';
}

/** The completion's message for these lines: the upgrade's unless every line is another plan change. */
export function renewalPricedBeforeUpgradeMessage(lines: readonly RenewalPricedBeforeUpgrade[]): string {
  return lines.length > 0 && lines.every((line) => line.cause === 'PLAN_CHANGE')
    ? RENEWAL_PRICED_BEFORE_PLAN_CHANGE_MESSAGE
    : RENEWAL_PRICED_BEFORE_UPGRADE_MESSAGE;
}

/** The completion's code for these lines, chosen as {@link renewalPricedBeforeUpgradeMessage} chooses. */
export function renewalPricedBeforeUpgradeCode(lines: readonly RenewalPricedBeforeUpgrade[]): string {
  return lines.length > 0 && lines.every((line) => line.cause === 'PLAN_CHANGE')
    ? RENEWAL_PRICED_BEFORE_PLAN_CHANGE_CODE
    : RENEWAL_PRICED_BEFORE_UPGRADE_CODE;
}

/** The provenance written under {@link RENEWAL_PRICED_BEFORE_UPGRADE_KEY}. */
export function renewalPricedBeforeUpgradeProvenance(
  lines: readonly RenewalPricedBeforeUpgrade[],
  now: Date,
): Record<string, unknown> {
  return {
    computedAt: now.toISOString(),
    lines: lines.map((line) => ({
      subscriptionId: line.subscriptionId,
      paidPlanId: line.paidPlanId,
      currentPlanId: line.currentPlanId,
      ...line.conversion,
      ...(line.cause === 'PLAN_CHANGE' ? { cause: line.cause } : {}),
    })),
  };
}

/**
 * The operator's note («📝 Заметка») on the completion, in Russian: what was
 * bought, what it bought instead, and what to do when it bought nothing. It
 * names the subscription because a combined renewal's card has no
 * subscription block of its own.
 */
export function describeRenewalPricedBeforeUpgrade(line: RenewalPricedBeforeUpgrade): string {
  const current = line.currentPlanName === null ? 'текущий тариф' : `«${line.currentPlanName}»`;
  const moved = line.cause === 'PLAN_CHANGE' ? `уже перевели на ${current}` : `уже улучшили до ${current}`;
  const head =
    `Продление тарифа «${line.paidPlanName}» на ${line.conversion.paidDays} дн. оплачено, когда подписку ` +
    `${line.subscriptionId} ${moved}. Тариф, лимиты и сквады не менялись`;
  if (line.conversion.dearestDay === null) {
    return (
      `${head}, а у нового тарифа нет цены в ${line.conversion.currency}: дни не добавлены. ` +
      'Верните деньги или продлите подписку вручную.'
    );
  }
  // Less than one day of the current plan: nothing is renewed — the status and
  // the expiry stay as they were — so the money is to go back, exactly as when
  // the plan has no price at all.
  if (line.conversion.days === 0) {
    return (
      `${head}; по самому дорогому дню нового тарифа оплаты не хватает даже на один день: дни не добавлены. ` +
      'Верните деньги или продлите подписку вручную.'
    );
  }
  return (
    `${head}; оплата пересчитана по самому дорогому дню нового тарифа: ` +
    `+${line.conversion.days} дн. вместо ${line.conversion.paidDays}.`
  );
}

/** The flat keys the renewal's card («Подписка продлена») prints its line from. */
export function renewalPricedBeforeUpgradeMetadata(line: RenewalPricedBeforeUpgrade): Record<string, unknown> {
  return {
    renewalPricedForPlan: line.paidPlanName,
    renewalPricedDays: line.conversion.paidDays,
    renewalConvertedDays: line.conversion.days,
  };
}

/**
 * The flat keys a single renewal's completion carries — the card's, plus the
 * code and the two plans, as `latePlanMigrationRenewalMetadata` gives them.
 */
export function renewalPricedBeforeUpgradeCompletionMetadata(
  line: RenewalPricedBeforeUpgrade,
): Record<string, unknown> {
  return {
    code: renewalPricedBeforeUpgradeCode([line]),
    paidPlanId: line.paidPlanId,
    paidPlanName: line.paidPlanName,
    currentPlanId: line.currentPlanId,
    currentPlanName: line.currentPlanName,
    ...renewalPricedBeforeUpgradeMetadata(line),
  };
}

// ── Reading one payment ────────────────────────────────────────────────────

interface ChainEvent {
  readonly transactionId: string;
  readonly atMs: number;
  readonly startsChain: boolean;
  /** What the payment bought and paid, or null when it is worth nothing here. */
  readonly paid: {
    readonly days: number;
    readonly amount: Prisma.Decimal;
    readonly currency: string;
  } | null;
}

/**
 * The payment as an event of this subscription's chain, or null when it is
 * not one: not applied, not a purchase of time, not this subscription's.
 */
function readChainEvent(
  candidate: PaidRemainderCandidate,
  subscriptionId: string,
  excludeTransactionId: string | null,
): ChainEvent | null {
  if (candidate.id === excludeTransactionId) return null;
  if (candidate.fulfilledAt === null || !APPLIED_STATUSES.has(candidate.status)) return null;
  if (!TIME_BUYING_PURCHASES.has(candidate.purchaseType)) return null;
  const snapshot = asRecord(candidate.planSnapshot);
  // An add-on raises a limit and buys no time; an imported donor payment was
  // settled by the other bot, for a plan that is not one here.
  if (snapshot['snapshotSource'] === 'ADDON_PURCHASE') return null;
  const importedFrom = snapshot['importedFrom'];
  if (typeof importedFrom === 'string' && importedFrom.length > 0) return null;
  // Withheld: received and applied to nothing, so it moved no term.
  if (isWithheldConversion(candidate.gatewayData)) return null;

  const line = readOwnLine(candidate, subscriptionId);
  if (line === undefined) return null;
  // Worth something only as money kept: COMPLETED, nothing given back, a
  // finite term, a positive amount that arrived. An unlimited (`-1`) or empty
  // term has no days to spread the money over.
  const paid =
    line !== null &&
    candidate.status === TransactionStatus.COMPLETED &&
    !carriesRefundMark(candidate.gatewayData) &&
    Number.isInteger(line.days) &&
    line.days > 0 &&
    line.amount !== null &&
    line.amount.isFinite() &&
    line.amount.gt(0)
      ? { days: line.days, amount: line.amount, currency: line.currency }
      : null;
  return {
    transactionId: candidate.id,
    atMs: candidate.fulfilledAt.getTime(),
    startsChain: CHAIN_STARTERS.has(candidate.purchaseType),
    paid,
  };
}

/**
 * This subscription's part of the payment: the whole payment for one of its
 * own, its line for a renewal that paid for several at once — as money that
 * arrived ({@link receivedPart}).
 *
 * `undefined` — not this subscription's payment at all. `null` — it is, and
 * its share cannot be told (no line of its own, or more than one), so it is
 * worth nothing.
 */
function readOwnLine(
  candidate: PaidRemainderCandidate,
  subscriptionId: string,
):
  | { readonly days: number; readonly amount: Prisma.Decimal | null; readonly currency: string }
  | null
  | undefined {
  const whole = toDecimal(candidate.amount);
  if (candidate.items.length > 0) {
    const own = candidate.items.filter((item) => item.subscriptionId === subscriptionId);
    if (own.length === 0) return candidate.subscriptionId === subscriptionId ? null : undefined;
    // Two lines for one subscription in one payment is not a shape checkout
    // makes; which of them is the time is not a thing to guess.
    if (own.length > 1) return null;
    const item = own[0]!;
    // A line never applied renewed nothing.
    if (item.appliedAt === null) return undefined;
    const lineAmount = toDecimal(item.amount);
    return {
      days: item.durationDays,
      amount: lineAmount === null || whole === null ? null : receivedPart(lineAmount, whole, candidate.gatewayData),
      currency: item.currency,
    };
  }
  if (candidate.subscriptionId !== subscriptionId) return undefined;
  const days = asRecord(candidate.planSnapshot)['selectedDurationDays'];
  return {
    days: typeof days === 'number' ? days : Number.NaN,
    amount: whole === null ? null : receivedPart(whole, whole, candidate.gatewayData),
    currency: candidate.currency,
  };
}

/**
 * The part of `lineAmount` that actually arrived, when the provider reported
 * less than the invoice for the whole payment (`wholeAmount`):
 * `gatewayData.notifiedAmount`, which reconciliation writes with
 * `notifiedAmountShortfallAt` for a completion whose notice was short, and
 * with `amountMismatchAt` for a payment held as underpaid. A line of a payment
 * for several subscriptions gets its share of what arrived. A payment held as
 * underpaid with no figure reported is worth nothing.
 */
function receivedPart(lineAmount: Prisma.Decimal, wholeAmount: Prisma.Decimal, gatewayData: unknown): Prisma.Decimal {
  const record = asRecord(gatewayData);
  const reported = readDecimal(record['notifiedAmount']);
  if (reported === null) {
    return typeof record['amountMismatchAt'] === 'string' ? new Prisma.Decimal(0) : lineAmount;
  }
  if (reported.gte(wholeAmount)) return lineAmount;
  if (!wholeAmount.gt(0) || !reported.gt(0)) return new Prisma.Decimal(0);
  return lineAmount.mul(reported).div(wholeAmount);
}

function carriesRefundMark(gatewayData: unknown): boolean {
  const record = asRecord(gatewayData);
  if (readRefundedTotal(record) > 0 || readRefundLedger(record).length > 0) return true;
  return REFUND_MARK_KEYS.some((key) => record[key] !== undefined && record[key] !== null);
}

/**
 * A plan's most expensive day in `currency`: the largest `price / days` over
 * its active finite durations priced above zero. Compared as fractions
 * (`a / b > c / d` ⇔ `a × d > c × b`), so no rounding decides it.
 */
function mostExpensiveDay(
  durations: readonly PaidRemainderPlanDuration[],
  currency: string,
): { readonly price: Prisma.Decimal; readonly days: number } | null {
  let dearest: { price: Prisma.Decimal; days: number } | null = null;
  for (const duration of durations) {
    if (!duration.isActive || !Number.isInteger(duration.days) || duration.days <= 0) continue;
    for (const entry of duration.prices) {
      if (entry.currency !== currency) continue;
      const price = toDecimal(entry.price);
      if (price === null || !price.isFinite() || !price.gt(0)) continue;
      if (dearest === null || price.mul(dearest.days).gt(dearest.price.mul(duration.days))) {
        dearest = { price, days: duration.days };
      }
    }
  }
  return dearest;
}

/** A decimal read from JSON: a string or a number, finite; anything else is null. */
function readDecimal(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const decimal = toDecimal(value);
  return decimal !== null && decimal.isFinite() ? decimal : null;
}

function toDecimal(value: DecimalLike): Prisma.Decimal | null {
  try {
    return new Prisma.Decimal(value.toString());
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
