/**
 * MONEY RECEIVED — the one rule every money figure of «Бизнес-аналитика» is
 * built on: revenue, paying customers, the average check, «Откуда деньги», the
 * plans' and the payment systems' money, LTV, «Лидеры», trial → paid, the
 * funnel's «Оплатили» and the cohorts. A payment is money received when:
 *
 *   - it is COMPLETED. A full refund is not: reconciliation writes it as
 *     CANCELED and stamps `gateway_data.refundReversedAt`
 *     (`PaymentReconciliationService.reverseFulfilledPayment`). No writer and
 *     no importer ever sets REFUNDED; importers map a donor's refund to
 *     CANCELED;
 *   - for more than nothing. A 100 % promo code or a free add-on completes at 0
 *     without reaching any payment system (`PaymentsCheckoutService`);
 *   - not paid from a partner's balance. That spends money the panel already
 *     counted when the partner's referral paid — "not new external money", in
 *     `PartnerBalancePaymentService`'s own words. The reports state it on a
 *     line of its own.
 *
 * And it counts NET of a partial refund. A partial refund leaves the payment
 * COMPLETED at its full amount and records the total given back so far in
 * `gateway_data.refundedAmountTotal` (a decimal string; YooKassa is the only
 * provider that reports an amount — every other refund is a full one).
 *
 * Subscription-state figures (paid subscriptions in force, churn) are NOT
 * money: they count subscriptions on paid plans, however they were paid.
 *
 * A PAID TRIAL IS PAID (the owner's rule, 2026-09-18): the purchase of a trial
 * plan is a subscription's first money, so it is `new` like any other, and a
 * later move of that subscription to a regular plan is a `change`. Only a FREE
 * trial starts a customer's trial → paid journey — and a trial plan checked out
 * for 0 with a 100 % promo code is a free one: "paid" means bought for money,
 * a partner's balance included ({@link boughtSubscriptionSql}).
 */
import { Prisma } from '@prisma/client';

/** The aliases the statements give `transactions` — a fixed set, never caller text. */
export type TransactionAlias = 't' | 'e';

function column(alias: TransactionAlias, name: string): Prisma.Sql {
  return Prisma.raw(`"${alias}"."${name}"`);
}

/** The payment is money received (see the file comment). */
export function moneyReceivedSql(alias: TransactionAlias = 't'): Prisma.Sql {
  return Prisma.sql`(${column(alias, 'status')} = 'COMPLETED' AND ${column(alias, 'amount')} > 0 AND ${column(alias, 'gateway_type')} <> 'PARTNER_BALANCE')`;
}

/** What has been given back of the payment so far without refunding it in full; `0` when nothing was. */
export function refundedSoFarSql(alias: TransactionAlias = 't'): Prisma.Sql {
  const total = Prisma.sql`(${column(alias, 'gateway_data')}->>'refundedAmountTotal')`;
  return Prisma.sql`COALESCE(CASE WHEN ${total} ~ '^[0-9]+([.][0-9]+)?$' THEN ${total}::numeric END, 0)`;
}

/** The part of the payment the panel kept: its amount less a partial refund, never below zero. */
export function netAmountSql(alias: TransactionAlias = 't'): Prisma.Sql {
  return Prisma.sql`GREATEST(${column(alias, 'amount')} - ${refundedSoFarSql(alias)}, 0)`;
}

/** How a checkout ended — see {@link paymentOutcomeSql}. */
export type PaymentOutcome = 'completed' | 'refunded' | 'canceled' | 'failed' | 'pending';

/**
 * How a checkout ended, as the panel writes it. A refund is an outcome of a
 * checkout that WENT THROUGH: reconciliation writes a full one as CANCELED
 * stamped `gateway_data.refundReversedAt`; REFUNDED is what older rows may
 * carry, though no writer sets it now. A partial refund leaves the payment
 * COMPLETED — `completed` here; a report that shows it apart tests
 * {@link refundedSoFarSql} first. Anything not yet settled is `pending`.
 */
export function paymentOutcomeSql(alias: TransactionAlias = 't'): Prisma.Sql {
  const status = column(alias, 'status');
  return Prisma.sql`(CASE
      WHEN ${status} = 'COMPLETED' THEN 'completed'
      WHEN ${status} = 'REFUNDED' THEN 'refunded'
      WHEN ${status} = 'CANCELED' AND ${column(alias, 'gateway_data')}->>'refundReversedAt' IS NOT NULL THEN 'refunded'
      WHEN ${status} = 'CANCELED' THEN 'canceled'
      WHEN ${status} = 'FAILED' THEN 'failed'
      ELSE 'pending'
    END)`;
}

/**
 * The payment bought a trial plan — a paid trial's own purchase, whatever it
 * cost; the caller says which statuses and amounts it means. Three marks, one
 * for each era of the data:
 *
 *   - the payment's snapshot carries `availability: 'TRIAL'` — the checkout
 *     persists it (`buildTransactionDraftSnapshot`) and the fulfilment reads it
 *     back to make the row a trial (`createSubscriptionFromPayment`);
 *   - the trial ledger names the payment (`trial_claims.transaction_id`,
 *     `consumePaidTrialClaim`);
 *   - its plan is a trial plan (`plans.availability`). Both marks above exist
 *     only since 0.9.6.80 (ce638af8, 31 Jul 2026): a paid trial bought before
 *     it has neither, and the ledger's backfill left such a customer a LEGACY
 *     claim naming no payment and, once the trial was moved to a plan, no
 *     subscription either. The plan is what remains — a deleted plan keeps its
 *     row (`deletedAt`), so it still answers. It answers with the plan as it is
 *     NOW: a plan that stopped or started being a trial plan since reads the
 *     old payments its new way.
 */
export function paidTrialPurchaseSql(alias: TransactionAlias = 't'): Prisma.Sql {
  const snapshot = column(alias, 'plan_snapshot');
  return Prisma.sql`(UPPER(COALESCE(${snapshot}->>'availability', '')) = 'TRIAL'
    OR EXISTS (SELECT 1 FROM "trial_claims" tc WHERE tc."transaction_id" = ${column(alias, 'id')})
    OR EXISTS (SELECT 1 FROM "plans" tp WHERE tp."id" = ${snapshot}->>'id' AND tp."availability" = 'TRIAL'))`;
}

/**
 * The subscription (the SQL expression naming its id) was BOUGHT FOR MONEY: a
 * completed payment of more than 0 linked to it bought its plan — NEW, or an
 * ADDITIONAL that is not an add-on. `createSubscriptionFromPayment` links that
 * payment to the row it creates; a free trial never has one (the cabinet's and
 * the operator's grant, and an import, create the row with no payment), and a
 * plan change or a renewal is not the purchase that made the row. So a trial
 * subscription that was bought is a PAID trial — told apart without `is_trial`,
 * which both kinds carry, and without the ledger's PAID claims, which exist
 * only since 2026-07-31 (its backfill wrote LEGACY claims for every trial).
 *
 * MORE THAN 0: a trial plan checked out with a 100 % promo code completes at
 * 0 without reaching a payment system (`PaymentsCheckoutService`), and it is a
 * FREE trial. A partner's balance is money here — the purchase was paid, even
 * if the reports keep that money out of revenue.
 */
export function boughtSubscriptionSql(subscriptionId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "transactions" bp
     WHERE bp."subscription_id" = ${subscriptionId}
       AND bp."status" = 'COMPLETED'
       AND bp."amount" > 0
       AND (bp."purchase_type" = 'NEW'
            OR (bp."purchase_type" = 'ADDITIONAL' AND bp."plan_snapshot"->>'snapshotSource' IS DISTINCT FROM 'ADDON_PURCHASE')))`;
}

/** `e` was made before `t` — by time, then by id, so two payments of one instant still have an order. */
function earlierSql(): Prisma.Sql {
  return Prisma.sql`(e."created_at" < t."created_at" OR (e."created_at" = t."created_at" AND e."id" < t."id"))`;
}

/**
 * What a payment of money received (alias `t`) paid for:
 *
 *   - `addon`: an ADDITIONAL payment whose snapshot says `ADDON_PURCHASE` — the
 *     test fulfilment and the points cashback make;
 *   - `renewal`: RENEW, a combined renewal included;
 *   - `new`: NEW; an ADDITIONAL payment that bought another subscription; and
 *     the FIRST money a subscription ever brought in, whatever its purchase
 *     type. That is how a trial becomes paid: a customer with an active trial
 *     cannot buy NEW (`SubscriptionQuoteService`), the trial row is UPGRADEd in
 *     place (`PaymentSubscriptionMutationService`) — and it is a new paying
 *     subscription, not a plan change;
 *   - `change`: an UPGRADE of a subscription that had already brought money in.
 *
 * "Already brought money in" is read off every earlier payment that can be
 * this subscription's: linked to it, or through a combined renewal's items —
 * and, because importers link a donor's payments to no subscription at all,
 * any earlier unlinked payment of the same customer. So an imported customer's
 * first plan change in the panel stays a change: their money arrived before
 * the panel could say for what. An UPGRADE with no subscription recorded, or
 * one itself imported, keeps the donor's word for it: a change.
 */
export function purchaseKindSql(): Prisma.Sql {
  return Prisma.sql`(CASE
    WHEN t."purchase_type" = 'ADDITIONAL' AND t."plan_snapshot"->>'snapshotSource' = 'ADDON_PURCHASE' THEN 'addon'
    WHEN t."purchase_type" = 'RENEW' THEN 'renewal'
    WHEN t."purchase_type" = 'UPGRADE' THEN (CASE
      WHEN t."subscription_id" IS NOT NULL
       AND t."plan_snapshot"->>'importedFrom' IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM "transactions" e
          WHERE e."user_id" = t."user_id"
            AND ${moneyReceivedSql('e')}
            AND ${earlierSql()}
            AND (e."subscription_id" = t."subscription_id"
                 OR EXISTS (SELECT 1 FROM "transaction_items" i WHERE i."transaction_id" = e."id" AND i."subscription_id" = t."subscription_id")
                 OR (e."subscription_id" IS NULL
                     AND NOT EXISTS (SELECT 1 FROM "transaction_items" i WHERE i."transaction_id" = e."id")))
       ) THEN 'new'
      ELSE 'change'
    END)
    ELSE 'new'
  END)`;
}
