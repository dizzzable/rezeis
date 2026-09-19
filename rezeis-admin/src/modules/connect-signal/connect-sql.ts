/**
 * «КУПИЛ, НО НЕ ПОДКЛЮЧИЛСЯ» — THE SHARED DEFINITIONS, AS SQL
 * ═══════════════════════════════════════════════════════════
 * Written once, here, and composed by everything that asks the question: the
 * broadcast audience and the hint audiences (`ConnectAudienceService`), the
 * automatic «Помощь с подключением» sender, and this module's own probe and
 * health. Pure `Prisma.Sql` fragments with no Nest dependency, so any of them
 * can import this file without importing a module.
 *
 * ── Money (the owner's rule for this feature, 18.09.2026) ──────────────────
 * "Оплатил" means the customer PAID. A payment is paid money when it is
 * COMPLETED, for more than 0, through ANY gateway — a partner's balance
 * included — and is neither imported nor an add-on. A paid trial (a trial plan
 * bought for money) is paid. A 0 ₽ checkout (a 100 % promo code) is not: it is
 * a gift. This is deliberately NOT `moneyReceivedSql`: that one excludes
 * PARTNER_BALANCE because the analytics count new EXTERNAL money, which is a
 * different question. A full refund is written CANCELED, so it falls out by
 * status; a partial one stays COMPLETED and still counts — the customer paid.
 *
 * ── A payment's subscription ──────────────────────────────────────────────
 * `transactions.subscription_id`, or — for a combined renewal, whose own
 * `subscription_id` is NULL — each `transaction_items.subscription_id`.
 *
 * ── Time: NEVER `now()` ───────────────────────────────────────────────────
 * Prisma's pg adapter binds a JS `Date` as its UTC wall time with no offset,
 * and it fills `@default(now())` on the client the same way. On a database
 * whose `TimeZone` is not UTC every timestamp the panel wrote is therefore
 * shifted by the offset — consistently, so comparing them with a BOUND `Date`
 * is sound, while comparing them with SQL `now()` is off by the offset
 * (measured on PostgreSQL 17 with `timezone = Asia/Vladivostok`: a row created
 * at 03:04Z stored 17:04Z of the previous day, `now()` said 03:04Z). Every
 * fragment below that needs "now" takes it as a bound `Date`; callers composing
 * their own conditions must do the same.
 *
 * ── Aliases ───────────────────────────────────────────────────────────────
 * Every fragment names the caller's table by an alias the CALLER chose, which
 * is spliced into the SQL raw. So it is checked: a plain lower-case identifier,
 * never text from a request. Internal subqueries use the `wp4_` prefix, which a
 * caller's alias may not use, so an inner alias can never shadow an outer one.
 */
import { Prisma } from '@prisma/client';

/** How long a successful read keeps a subscription VERIFIED not connected. */
export const CONNECT_VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The outcomes after which help was actually GIVEN — something reached the
 * customer, or the banner is waiting for them. `pending` = one of these and
 * the profile still never connected.
 */
export const PENDING_HELP_OUTCOMES = ['bot', 'push', 'email', 'banner', 'broadcast'] as const;

/** Every value `subscription_connect_states.help_outcome` may hold (TEXT, validated in code). */
export const HELP_OUTCOMES = [
  ...PENDING_HELP_OUTCOMES,
  'opted_out',
  'merged',
  'skipped_unverifiable',
  'skipped_template_off',
] as const;

export type HelpOutcome = (typeof HELP_OUTCOMES)[number];

/** Who proved a connection first — `subscription_connect_states.connected_source`. */
export const CONNECT_SOURCES = ['webhook', 'cabinet', 'probe'] as const;

export type ConnectSource = (typeof CONNECT_SOURCES)[number];

const ALIAS = /^[a-z][a-z0-9_]{0,30}$/;

function checkedAlias(alias: string): string {
  if (!ALIAS.test(alias) || alias.startsWith('wp4_')) {
    throw new Error(`connect-sql: "${alias}" is not a table alias this file accepts`);
  }
  return alias;
}

function column(alias: string, name: string): Prisma.Sql {
  return Prisma.raw(`"${alias}"."${name}"`);
}

/**
 * The payment (alias `tAlias` of `transactions`) is PAID MONEY — see the file
 * header. Add-on: an ADDITIONAL payment whose snapshot says `ADDON_PURCHASE`,
 * the same test `purchaseKindSql` uses; written so a snapshot WITHOUT that key
 * stays in (a bare `NOT (… = 'ADDON_PURCHASE')` would be NULL there, and drop
 * every ordinary second-subscription purchase).
 */
export function paidMoneySql(tAlias: string): Prisma.Sql {
  const t = checkedAlias(tAlias);
  return paidMoneyOf(t);
}

function paidMoneyOf(t: string): Prisma.Sql {
  return Prisma.sql`(${column(t, 'status')} = 'COMPLETED'
    AND ${column(t, 'amount')} > 0
    AND ${column(t, 'plan_snapshot')}->>'importedFrom' IS NULL
    AND (${column(t, 'purchase_type')} <> 'ADDITIONAL'
         OR ${column(t, 'plan_snapshot')}->>'snapshotSource' IS DISTINCT FROM 'ADDON_PURCHASE'))`;
}

/**
 * The subscription (alias `sAlias` of `subscriptions`) has paid money — at
 * least one payment of {@link paidMoneySql} linked to it directly or through a
 * combined renewal's items — optionally created at or after `since`.
 *
 * Two `EXISTS`, one per link, rather than one `EXISTS` over an `OR`: each is
 * then served by its own index (`transactions(subscription_id)`,
 * `transaction_items(subscription_id)`), where an `OR` across the two would
 * make the planner read every payment for every subscription.
 */
export function moneyForSubscriptionSql(
  sAlias: string,
  options: { readonly since?: Date } = {},
): Prisma.Sql {
  const s = checkedAlias(sAlias);
  const since = (alias: string): Prisma.Sql =>
    options.since === undefined ? Prisma.empty : Prisma.sql` AND ${column(alias, 'created_at')} >= ${options.since}`;
  return Prisma.sql`(EXISTS (
      SELECT 1 FROM "transactions" "wp4_m"
       WHERE "wp4_m"."subscription_id" = ${column(s, 'id')}
         AND ${paidMoneyOf('wp4_m')}${since('wp4_m')})
    OR EXISTS (
      SELECT 1 FROM "transaction_items" "wp4_mi"
        JOIN "transactions" "wp4_m" ON "wp4_m"."id" = "wp4_mi"."transaction_id"
       WHERE "wp4_mi"."subscription_id" = ${column(s, 'id')}
         AND ${paidMoneyOf('wp4_m')}${since('wp4_m')}))`;
}

/**
 * Every paid-money payment WITH the subscription it paid for, as a derived
 * table — join it (`JOIN ${paidMoneyLinksSql()} p ON p.subscription_id = s.id`)
 * when a query needs the payment's own time, as the broadcast bucket's
 * «оплатил за последние N дней» does. Columns:
 *
 *   subscription_id  the subscription paid for (direct link or item)
 *   transaction_id   the payment
 *   purchase_type    as stored
 *   created_at       the payment's creation — the analytics' window column,
 *                    and the one `transactions_status_created_at_idx` serves
 *   paid_at          COALESCE(fulfilled_at, created_at)
 *
 * A UNION ALL of two plain SELECTs, so PostgreSQL pushes a caller's
 * `p.created_at >= …` into both arms and each keeps its index.
 */
export function paidMoneyLinksSql(): Prisma.Sql {
  return Prisma.sql`(SELECT "wp4_l"."subscription_id" AS "subscription_id",
          "wp4_l"."id" AS "transaction_id",
          "wp4_l"."purchase_type" AS "purchase_type",
          "wp4_l"."created_at" AS "created_at",
          COALESCE("wp4_l"."fulfilled_at", "wp4_l"."created_at") AS "paid_at"
     FROM "transactions" "wp4_l"
    WHERE "wp4_l"."subscription_id" IS NOT NULL
      AND ${paidMoneyOf('wp4_l')}
   UNION ALL
   SELECT "wp4_li"."subscription_id",
          "wp4_l"."id",
          "wp4_l"."purchase_type",
          "wp4_l"."created_at",
          COALESCE("wp4_l"."fulfilled_at", "wp4_l"."created_at")
     FROM "transaction_items" "wp4_li"
     JOIN "transactions" "wp4_l" ON "wp4_l"."id" = "wp4_li"."transaction_id"
    WHERE ${paidMoneyOf('wp4_l')})`;
}

/** `e` was made before `a` — by time, then by id, so two payments of one instant still have an order. */
function earlierThanAnchor(): Prisma.Sql {
  return Prisma.sql`("wp4_e"."created_at" < "wp4_a"."created_at"
    OR ("wp4_e"."created_at" = "wp4_a"."created_at" AND "wp4_e"."id" < "wp4_a"."id"))`;
}

/**
 * The payment that made a subscription PAID, one row per subscription that
 * became paid, as a derived table:
 *
 *   subscription_id  the subscription
 *   transaction_id   the payment
 *   anchor_at        COALESCE(fulfilled_at, created_at) — when it became paid
 *   created_at       the payment's creation; bound THIS for the index
 *                    (`transactions_status_created_at_idx`), with slack for
 *                    fulfilment: `anchor_at` is never earlier than it
 *
 * That payment is the subscription's FIRST paid money — linked directly or
 * through a combined renewal's items, ordered by creation — and only when that
 * first money is not a renewal. So: a NEW purchase anchors; a paid trial's own
 * purchase anchors (a paid trial is paid); a free trial or a gift UPGRADEd for
 * money anchors on the upgrade; a partner-balance purchase anchors; a 0 ₽
 * checkout never does, and a later paid upgrade of it does. A renewal is NEVER
 * an anchor: renewing an old subscription must not make it "newly paid", and a
 * subscription whose first money was a renewal (a gift renewed, a combined
 * renewal) is paid — {@link moneyForSubscriptionSql} says so — but has no
 * moment it "became" paid to count hours from.
 *
 * Join it: `JOIN ${becamePaidAnchorSql()} a ON a.subscription_id = s.id`. It is
 * a plain SELECT, so a caller's condition on `a.created_at` reaches the index.
 */
export function becamePaidAnchorSql(): Prisma.Sql {
  return Prisma.sql`(SELECT "wp4_a"."subscription_id" AS "subscription_id",
          "wp4_a"."id" AS "transaction_id",
          COALESCE("wp4_a"."fulfilled_at", "wp4_a"."created_at") AS "anchor_at",
          "wp4_a"."created_at" AS "created_at"
     FROM "transactions" "wp4_a"
    WHERE "wp4_a"."subscription_id" IS NOT NULL
      AND ${paidMoneyOf('wp4_a')}
      AND "wp4_a"."purchase_type" <> 'RENEW'
      AND NOT EXISTS (
        SELECT 1 FROM "transactions" "wp4_e"
         WHERE "wp4_e"."subscription_id" = "wp4_a"."subscription_id"
           AND ${paidMoneyOf('wp4_e')}
           AND ${earlierThanAnchor()})
      AND NOT EXISTS (
        SELECT 1 FROM "transaction_items" "wp4_ei"
          JOIN "transactions" "wp4_e" ON "wp4_e"."id" = "wp4_ei"."transaction_id"
         WHERE "wp4_ei"."subscription_id" = "wp4_a"."subscription_id"
           AND ${paidMoneyOf('wp4_e')}
           AND ${earlierThanAnchor()}))`;
}

/**
 * The subscription (alias `sAlias`) belongs in «Пробный период или подарок»:
 * no paid money ever (a free trial, an operator's grant, a promo-code or ad
 * reward, a 0 ₽ checkout), and not imported. A paid trial is NOT here — it was
 * bought. Status and the creation window are the caller's: both buckets share
 * them (`status IN ('ACTIVE','LIMITED')`, `created_at >= since` — the index
 * `subscriptions_created_status_idx` serves exactly that pair).
 */
export function trialBucketSql(sAlias: string): Prisma.Sql {
  const s = checkedAlias(sAlias);
  return Prisma.sql`(NOT ${moneyForSubscriptionSql(s)}
    AND ${column(s, 'plan_snapshot')}->>'importedFrom' IS NULL)`;
}

/**
 * The subscription whose state row is `cAlias` (of `subscription_connect_states`)
 * is VERIFIED not connected: no evidence of a connection ever, and a
 * successful read said so after `anchor` (the purchase, or whatever moment the
 * caller counts from — any SQL expression or bound value) and within the last
 * 24 hours before `now`. A profile the panel has since reported missing is not
 * verified by a read made before that report.
 *
 * Everything else — no state row, never read, read before the purchase, read
 * too long ago — is UNVERIFIED, and nothing is ever sent on unverified.
 * `now` is bound, never SQL `now()` (see the file header).
 */
export function verifiedNotConnectedSql(
  cAlias: string,
  anchor: Prisma.Sql | Date,
  now: Date = new Date(),
): Prisma.Sql {
  const c = checkedAlias(cAlias);
  const freshSince = new Date(now.getTime() - CONNECT_VERIFICATION_MAX_AGE_MS);
  // COALESCE: TRUE or FALSE, never NULL — a NULL anchor or an absent state row
  // must not turn `NOT verified…` into a condition that drops the row too.
  return Prisma.sql`COALESCE((${column(c, 'first_connected_at')} IS NULL
    AND ${column(c, 'checked_at')} IS NOT NULL
    AND ${column(c, 'checked_at')} >= ${anchor}
    AND ${column(c, 'checked_at')} >= ${freshSince}
    AND (${column(c, 'profile_missing_at')} IS NULL OR ${column(c, 'profile_missing_at')} < ${column(c, 'checked_at')})), false)`;
}

/**
 * The subscriptions the connection signal is kept for, as a derived table of
 * one column, `subscription_id`: live (ACTIVE or LIMITED) and created at or
 * after `since`, or with paid money created at or after `since` (a renewal of an
 * older subscription included). Each arm is served by an existing index —
 * `subscriptions_created_status_idx`, `transactions_status_created_at_idx` —
 * and the caller still filters the status of the second arm's rows.
 */
export function connectHorizonSql(since: Date): Prisma.Sql {
  return Prisma.sql`(SELECT "wp4_h"."id" AS "subscription_id"
     FROM "subscriptions" "wp4_h"
    WHERE "wp4_h"."created_at" >= ${since}
      AND "wp4_h"."status" IN ('ACTIVE', 'LIMITED')
   UNION
   SELECT "wp4_hp"."subscription_id"
     FROM ${paidMoneyLinksSql()} "wp4_hp"
    WHERE "wp4_hp"."created_at" >= ${since})`;
}

/**
 * Help was GIVEN on this subscription (`help_outcome` one of
 * {@link PENDING_HELP_OUTCOMES}) and its profile has still never connected.
 * Whether the subscription is still live is the caller's (`s.status`).
 *
 * TRUE or FALSE, never NULL: `help_outcome IN (…)` alone is NULL for a row with
 * no outcome (and for a missing row behind a LEFT JOIN), and `NOT
 * pendingHelp…` would then drop exactly the rows it was meant to keep.
 */
export function pendingHelpSql(cAlias: string): Prisma.Sql {
  const c = checkedAlias(cAlias);
  return Prisma.sql`COALESCE((${column(c, 'help_outcome')} IN (${Prisma.join([...PENDING_HELP_OUTCOMES])})
    AND ${column(c, 'first_connected_at')} IS NULL), false)`;
}
