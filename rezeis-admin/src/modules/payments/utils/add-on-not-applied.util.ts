/**
 * AN ADD-ON PAYMENT THAT ADDED NOTHING — the record its refund reads.
 *
 * A capture can settle an add-on payment without changing any limit: the
 * subscription was no longer active, it had no term, the quote had no end or
 * ended before the money came, the catalogue value adds nothing (the customer
 * is told and the operator gets «Докупка оплачена, но не применена»), a paid
 * «Обнулить трафик» Remnawave did not perform, or the subscription is
 * unlimited in what the add-on adds. Nothing was added, so a refund must take
 * nothing away. It used to: with no entitlement to reverse,
 * `AddOnRefundService` took such a payment for a raw `+N` and lowered the
 * column — or rebased the ACTIVE term — by the add-on's value, taking traffic
 * or devices the customer had from somewhere else (FX5 item 4).
 *
 * The capture stamps the payment in its own transaction, with the atomic
 * JSONB merge every `gatewayData` writer uses (`writeTransactionGatewayData`).
 * A capture from before the stamp left its ledger no-op instead: the
 * `profile_sync_jobs` row `recordAddOnLedgerNoOp` writes, `payload.source =
 * 'ADDON_PURCHASE_LEDGER'` with one of {@link ADD_ON_LEDGER_NO_OP_NOTES}.
 */

import { Prisma } from '@prisma/client';

/** The `gatewayData` key: `{ reason, at }`. */
export const ADD_ON_NOT_APPLIED_KEY = 'addOnNotApplied';

/**
 * Why nothing was added: a not-applied reason, or a baseline unlimited in what
 * the add-on adds. `RESET_NOT_PERFORMED` is a paid «Обнулить трафик» Remnawave
 * did not perform (see {@link PAID_TRAFFIC_RESET_CAUSE}).
 */
export type AddOnAddedNothingReason =
  | 'SUBSCRIPTION_NOT_ACTIVE'
  | 'NO_ACTIVE_TERM'
  | 'INCOHERENT_VALUE'
  | 'NO_END'
  | 'ENDED_BEFORE_CAPTURE'
  | 'RESET_NOT_PERFORMED'
  | 'UNLIMITED_BASELINE';

/**
 * `cause` and `payload.source` of the TRAFFIC_RESET job a paid «Обнулить
 * трафик» keeps from its capture until it is settled
 * (`PaymentSubscriptionMutationService.settlePaidTrafficResets`).
 *
 * Written HELD — born superseded, so neither the profile-sync sweep nor its
 * worker takes it — in the capture's own transaction: it is the durable record
 * that a reset is owed. The capture's run performs the reset right after the
 * commit. A failure that can pass (Remnawave unreachable, a 5xx) RELEASES the
 * job to the profile-sync machinery, whose sweep re-drives it. One that cannot
 * (no profile, Remnawave not configured, a refusal) settles it as not applied
 * at once. The settle claims every outcome on the job row, once: the sale is
 * announced once, and the operator's card and the customer's notice go once.
 * The profile-sync worker leaves such a job's final failure to that card
 * (`ProfileSyncProcessor.reportFailure`).
 *
 * A FULL refund that comes first closes the job instead (R5-01): nothing
 * performs it after that, and nothing about it is told — the refund's own card
 * says what became of the reset (`AddOnRefundService`).
 */
export const PAID_TRAFFIC_RESET_CAUSE = 'PAID_TRAFFIC_RESET';

/**
 * How a paid reset's job ended (`payload.settledAs`):
 *  - `APPLIED`: Remnawave zeroed the counter;
 *  - `NOT_APPLIED`: it did not, and cannot — the payment is stamped
 *    `RESET_NOT_PERFORMED`, and the operator and the customer are told;
 *  - `CLOSED`: it did not, and will not, because the payment was refunded
 *    first. Nothing is told: the refund's card says it.
 */
export type PaidResetOutcome = 'APPLIED' | 'NOT_APPLIED' | 'CLOSED';

/**
 * What the settle told of it (`payload.announcedAs`): the sale, the operator's
 * card with the customer's notice, or nothing — the payment was refunded, or
 * the job was closed.
 */
export type PaidResetAnnouncement = 'SALE' | 'NOT_APPLIED' | 'NONE';

/** `column` as a JSON object, whatever it holds. */
export function jsonObjectSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END)`;
}

/**
 * A paid reset job's payload, settled: no longer held, when and how it ended,
 * why (`settledDetail`, the words of the operator's card), and the claim on
 * telling it (`announceClaimAt`). The telling is recorded apart
 * (`announcedAt`) once it is done, so a telling that failed is done again by
 * the next settle. A CLOSED job tells nothing, and is told as it closes.
 */
export function paidResetSettledPayloadSql(
  column: Prisma.Sql,
  outcome: PaidResetOutcome,
  now: Date,
  detail: string | null = null,
): Prisma.Sql {
  const at = now.toISOString();
  const told =
    outcome === 'CLOSED'
      ? Prisma.sql` || jsonb_build_object('announcedAt', ${at}::text, 'announcedAs', 'NONE')`
      : Prisma.empty;
  const why = detail === null ? Prisma.empty : Prisma.sql` || jsonb_build_object('settledDetail', ${detail}::text)`;
  return Prisma.sql`(((${jsonObjectSql(column)} - 'held')
    || jsonb_build_object('settledAt', ${at}::text, 'settledAs', ${outcome}::text, 'announceClaimAt', ${at}::text))${told}${why})`;
}

/**
 * Whether the payment — the `transactions` row under `alias` — is still a paid
 * sale: COMPLETED. A full refund makes it CANCELED, in the one statement that
 * stamps its `refundReversedAt` (`PaymentReconciliationService.
 * reverseFulfilledPayment`); a partial one leaves it COMPLETED — paid, as it
 * leaves an add-on or a lifetime paid for elsewhere.
 */
export function paymentStillPaidSql(alias: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${alias}."status" = 'COMPLETED')`;
}

/** {@link paymentStillPaidSql}, for a payment already read. */
export function isPaymentStillPaid(payment: { readonly status: string }): boolean {
  return payment.status === 'COMPLETED';
}

/** `payload.source` of the push a ledger capture leaves. */
export const ADD_ON_LEDGER_SOURCE = 'ADDON_PURCHASE_LEDGER';

/** `payload.note` of a ledger capture that added nothing, stamp or no stamp. */
export const ADD_ON_LEDGER_NO_OP_NOTES: readonly string[] = ['RESET_QUOTE_NOT_APPLIED', 'UNLIMITED_NOOP'];

/** The merge a capture writes: `{ addOnNotApplied: { reason, at } }`. */
export function addOnNotAppliedStamp(reason: AddOnAddedNothingReason, at: Date): Record<string, unknown> {
  return { [ADD_ON_NOT_APPLIED_KEY]: { reason, at: at.toISOString() } };
}

/** The stamp on a payment's `gatewayData`, or `null`. */
export function readAddOnNotApplied(gatewayData: unknown): { readonly reason: string } | null {
  if (typeof gatewayData !== 'object' || gatewayData === null || Array.isArray(gatewayData)) return null;
  const stamp = (gatewayData as Record<string, unknown>)[ADD_ON_NOT_APPLIED_KEY];
  if (typeof stamp !== 'object' || stamp === null || Array.isArray(stamp)) return null;
  const reason = (stamp as Record<string, unknown>)['reason'];
  return typeof reason === 'string' && reason.length > 0 ? { reason } : null;
}

/**
 * Whether the payment was settled as NOT APPLIED — told to the operator as
 * `payment.withheld`, never announced as a sale — so that its refund, in full
 * or in part, and a payment of it after the refund are the operator's alone
 * too (`PaymentReconciliationService`). Not a subscription unlimited in what
 * the add-on adds (`UNLIMITED_BASELINE`): that one was a sale, announced as
 * `payment.completed`, and its refund is announced like any refund.
 */
export function wasAddOnNotApplied(gatewayData: unknown): boolean {
  const stamp = readAddOnNotApplied(gatewayData);
  return stamp !== null && stamp.reason !== 'UNLIMITED_BASELINE';
}
