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
