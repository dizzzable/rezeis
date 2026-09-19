import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  becamePaidAnchorSql,
  connectHorizonSql,
  moneyForSubscriptionSql,
  paidMoneyLinksSql,
  paidMoneySql,
  trialBucketSql,
} from '../src/modules/connect-signal/connect-sql';

/**
 * The shared «Оплатил» / «Пробный или подарок» definitions (`connect-sql.ts`)
 * against real rows, one fixture per case the owner decided (18.09.2026):
 *
 *   paid money = COMPLETED, amount > 0, ANY gateway — a partner's balance
 *                included — not imported, not an add-on. A paid trial is paid;
 *                a 0 ₽ checkout (100 % promo) is a gift.
 *
 * Every row is written the way the panel writes it (the purchase types, the
 * snapshot markers the importers and the add-on checkout leave), and every
 * statement runs as the callers will run it. A subscription's bucket is read
 * with the callers' own status filter (ACTIVE or LIMITED) applied.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `csql-${process.pid}-${Date.now()}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let prisma: PrismaService;
let userId: string;
let seq = 0;

function key(label: string): string {
  seq += 1;
  return `${prefix}-${label}-${seq}`;
}

interface PaymentInput {
  readonly subscriptionId?: string | null;
  readonly status?: 'COMPLETED' | 'CANCELED' | 'PENDING' | 'FAILED';
  readonly purchaseType: 'NEW' | 'RENEW' | 'UPGRADE' | 'ADDITIONAL';
  readonly gateway?: 'PLATEGA' | 'PARTNER_BALANCE' | 'YOOKASSA';
  readonly amount: number;
  readonly snapshot?: Record<string, unknown>;
  readonly gatewayData?: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly fulfilledAt?: Date | null;
  /** Combined renewal: the payment names no subscription, its items do. */
  readonly items?: readonly string[];
}

async function payment(input: PaymentInput): Promise<string> {
  const paymentId = key('tx');
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "transactions"
      ("id", "payment_id", "user_id", "subscription_id", "status", "purchase_type", "gateway_type", "currency",
       "amount", "plan_snapshot", "gateway_data", "fulfilled_at", "created_at", "updated_at")
    VALUES (${paymentId}, ${`${paymentId}-pay`}, ${userId}, ${input.subscriptionId ?? null},
            ${input.status ?? 'COMPLETED'}::"TransactionStatus", ${input.purchaseType}::"PurchaseType",
            ${input.gateway ?? 'PLATEGA'}::"PaymentGatewayType", 'RUB'::"Currency", ${input.amount},
            ${JSON.stringify(input.snapshot ?? {})}::jsonb,
            ${input.gatewayData === undefined || input.gatewayData === null ? null : JSON.stringify(input.gatewayData)}::jsonb,
            ${input.fulfilledAt === undefined ? input.createdAt : input.fulfilledAt}::timestamptz,
            ${input.createdAt}, ${input.createdAt})
  `);
  for (const subscriptionId of input.items ?? []) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "transaction_items"
        ("id", "transaction_id", "subscription_id", "plan_id", "duration_days", "amount", "currency", "created_at")
      VALUES (${key('item')}, ${paymentId}, ${subscriptionId}, 'plan-standard', 30, 250, 'RUB'::"Currency",
              ${input.createdAt})
    `);
  }
  return paymentId;
}

async function subscription(input: {
  readonly status?: 'ACTIVE' | 'LIMITED' | 'EXPIRED' | 'DELETED';
  readonly isTrial?: boolean;
  readonly snapshot?: Record<string, unknown>;
  readonly createdAt: Date;
}): Promise<string> {
  const subscriptionId = key('sub');
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "subscriptions" ("id", "user_id", "status", "is_trial", "plan_snapshot", "remnawave_id",
                                 "created_at", "updated_at")
    VALUES (${subscriptionId}, ${userId}, ${input.status ?? 'ACTIVE'}::"SubscriptionStatus", ${input.isTrial ?? false},
            ${JSON.stringify(input.snapshot ?? { name: 'Standard' })}::jsonb, ${subscriptionId}, ${input.createdAt},
            ${input.createdAt})
  `);
  return subscriptionId;
}

interface Verdict {
  readonly live: boolean;
  readonly paid: boolean;
  readonly trial: boolean;
  readonly anchorTx: string | null;
  readonly anchorAt: Date | null;
}

async function verdicts(ids: readonly string[]): Promise<Map<string, Verdict>> {
  const rows = await prisma.$queryRaw<
    Array<{
      readonly id: string;
      readonly live: boolean;
      readonly paid: boolean;
      readonly trial: boolean;
      readonly anchor_tx: string | null;
      readonly anchor_at: Date | null;
      readonly anchors: number;
    }>
  >(Prisma.sql`
    SELECT "s"."id",
           ("s"."status" IN ('ACTIVE', 'LIMITED')) AS "live",
           ${moneyForSubscriptionSql('s')} AS "paid",
           ${trialBucketSql('s')} AS "trial",
           (SELECT "a"."transaction_id" FROM ${becamePaidAnchorSql()} "a" WHERE "a"."subscription_id" = "s"."id") AS "anchor_tx",
           (SELECT "a"."anchor_at" FROM ${becamePaidAnchorSql()} "a" WHERE "a"."subscription_id" = "s"."id") AS "anchor_at",
           (SELECT count(*)::int FROM ${becamePaidAnchorSql()} "a" WHERE "a"."subscription_id" = "s"."id") AS "anchors"
      FROM "subscriptions" "s"
     WHERE "s"."id" IN (${Prisma.join([...ids])})
  `);
  for (const row of rows) {
    assert.ok(row.anchors <= 1, `${row.id} has ${row.anchors} "became paid" payments — at most one`);
  }
  return new Map(
    rows.map((row) => [
      row.id,
      { live: row.live, paid: row.paid, trial: row.trial, anchorTx: row.anchor_tx, anchorAt: row.anchor_at },
    ]),
  );
}

/** The bucket a live subscription falls in, as the callers filter it. */
function bucketOf(verdict: Verdict): 'paid' | 'trial' | 'neither' {
  if (!verdict.live) return 'neither';
  if (verdict.paid) return 'paid';
  return verdict.trial ? 'trial' : 'neither';
}

run('the «не подключился» buckets in PostgreSQL', () => {
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const cases: Record<
    string,
    { readonly id: string; readonly bucket: 'paid' | 'trial' | 'neither'; readonly anchorTx: string | null }
  > = {};
  /** Single payments, by what `paidMoneySql` must say about each ON ITS OWN. */
  const payments: Record<string, { readonly id: string; readonly paid: boolean }> = {};

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    userId = key('user');
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "users" ("id", "referral_code", "updated_at") VALUES (${userId}, ${`${userId}-ref`}, ${now})
    `);

    // A native purchase: paid, and it is the moment the subscription became paid.
    {
      const s = await subscription({ createdAt: ago(3 * DAY) });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(3 * DAY), fulfilledAt: new Date(ago(3 * DAY).getTime() + 90_000) });
      cases['native'] = { id: s, bucket: 'paid', anchorTx: tx };
    }
    // Imported with its payment: neither — the donor's money is not this panel's,
    // and an imported subscription is no trial or gift either.
    {
      const s = await subscription({ createdAt: ago(3 * DAY), snapshot: { importedFrom: 'bedolaga' } });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 299, snapshot: { importedFrom: 'bedolaga', sourceTransactionId: 'b-1' }, createdAt: ago(3 * DAY) });
      cases['imported'] = { id: s, bucket: 'neither', anchorTx: null };
      payments['imported'] = { id: tx, paid: false };
    }
    // A gift with an add-on bought for it: the add-on is not the subscription's money.
    {
      const s = await subscription({ createdAt: ago(2 * DAY) });
      const tx = await payment({ subscriptionId: s, purchaseType: 'ADDITIONAL', amount: 99, snapshot: { snapshotSource: 'ADDON_PURCHASE', addOnId: 'addon-1', addOnType: 'EXTRA_TRAFFIC' }, createdAt: ago(1 * DAY) });
      cases['addon-only'] = { id: s, bucket: 'trial', anchorTx: null };
      payments['addon'] = { id: tx, paid: false };
    }
    // A second subscription bought as ADDITIONAL (no snapshotSource at all): paid.
    {
      const s = await subscription({ createdAt: ago(2 * DAY) });
      const tx = await payment({ subscriptionId: s, purchaseType: 'ADDITIONAL', amount: 350, snapshot: { name: 'Standard' }, createdAt: ago(2 * DAY) });
      cases['additional-subscription'] = { id: s, bucket: 'paid', anchorTx: tx };
      payments['additional-no-snapshot-source'] = { id: tx, paid: true };
    }
    // Paid from a partner's balance: PAID for this feature (the owner's rule).
    {
      const s = await subscription({ createdAt: ago(2 * DAY) });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 299, gateway: 'PARTNER_BALANCE', createdAt: ago(2 * DAY) });
      cases['partner-balance'] = { id: s, bucket: 'paid', anchorTx: tx };
      payments['partner-balance'] = { id: tx, paid: true };
    }
    // Checked out for 0 with a 100 % promo code: a gift.
    {
      const s = await subscription({ createdAt: ago(2 * DAY) });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 0, createdAt: ago(2 * DAY) });
      cases['zero-promo'] = { id: s, bucket: 'trial', anchorTx: null };
      payments['zero'] = { id: tx, paid: false };
    }
    // A trial plan bought for money: PAID (owner, 18.09.2026), anchored on its purchase.
    {
      const s = await subscription({ createdAt: ago(1 * DAY), isTrial: true, snapshot: { name: 'Trial', availability: 'TRIAL' } });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 10, snapshot: { availability: 'TRIAL', name: 'Trial' }, createdAt: ago(1 * DAY) });
      cases['paid-trial'] = { id: s, bucket: 'paid', anchorTx: tx };
      payments['paid-trial'] = { id: tx, paid: true };
    }
    // A free trial: the trial bucket.
    {
      const s = await subscription({ createdAt: ago(1 * DAY), isTrial: true, snapshot: { name: 'Trial', availability: 'TRIAL' } });
      cases['free-trial'] = { id: s, bucket: 'trial', anchorTx: null };
    }
    // A free trial upgraded in place for money: paid from the upgrade on.
    {
      const s = await subscription({ createdAt: ago(5 * DAY), isTrial: true });
      const tx = await payment({ subscriptionId: s, purchaseType: 'UPGRADE', amount: 499, createdAt: ago(1 * DAY) });
      cases['trial-upgraded'] = { id: s, bucket: 'paid', anchorTx: tx };
    }
    // A 0 ₽ subscription later upgraded for money: the upgrade is the anchor.
    {
      const s = await subscription({ createdAt: ago(6 * DAY) });
      await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 0, createdAt: ago(6 * DAY) });
      const tx = await payment({ subscriptionId: s, purchaseType: 'UPGRADE', amount: 499, createdAt: ago(2 * DAY) });
      cases['zero-then-upgrade'] = { id: s, bucket: 'paid', anchorTx: tx };
    }
    // A partner-balance purchase later upgraded: the purchase stays the anchor.
    {
      const s = await subscription({ createdAt: ago(6 * DAY) });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 299, gateway: 'PARTNER_BALANCE', createdAt: ago(6 * DAY) });
      await payment({ subscriptionId: s, purchaseType: 'UPGRADE', amount: 499, createdAt: ago(2 * DAY) });
      cases['balance-then-upgrade'] = { id: s, bucket: 'paid', anchorTx: tx };
    }
    // A gift renewed in a combined checkout: paid through the ITEM, never an anchor.
    {
      const s = await subscription({ createdAt: ago(9 * DAY) });
      await payment({ subscriptionId: null, purchaseType: 'RENEW', amount: 500, createdAt: ago(1 * DAY), items: [s] });
      cases['combined-renewal-only'] = { id: s, bucket: 'paid', anchorTx: null };
    }
    // Bought, then renewed in a combined checkout: the purchase stays the anchor.
    {
      const s = await subscription({ createdAt: ago(20 * DAY) });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(20 * DAY) });
      await payment({ subscriptionId: null, purchaseType: 'RENEW', amount: 500, createdAt: ago(1 * DAY), items: [s] });
      cases['new-then-combined'] = { id: s, bucket: 'paid', anchorTx: tx };
    }
    // A gift renewed in a combined checkout, then upgraded: its first money was
    // the renewal (through the ITEM), so the upgrade is not "became paid" either.
    {
      const s = await subscription({ createdAt: ago(12 * DAY) });
      await payment({ subscriptionId: null, purchaseType: 'RENEW', amount: 500, createdAt: ago(5 * DAY), items: [s] });
      await payment({ subscriptionId: s, purchaseType: 'UPGRADE', amount: 300, createdAt: ago(1 * DAY) });
      cases['combined-then-upgrade'] = { id: s, bucket: 'paid', anchorTx: null };
    }
    // A gift renewed on its own: paid, and a renewal is never the anchor.
    {
      const s = await subscription({ createdAt: ago(9 * DAY) });
      await payment({ subscriptionId: s, purchaseType: 'RENEW', amount: 300, createdAt: ago(2 * DAY) });
      cases['renewal-only'] = { id: s, bucket: 'paid', anchorTx: null };
    }
    // Refunded in full: CANCELED, and the refund expired the subscription.
    {
      const s = await subscription({ createdAt: ago(3 * DAY), status: 'EXPIRED' });
      const tx = await payment({ subscriptionId: s, status: 'CANCELED', purchaseType: 'NEW', amount: 499, gatewayData: { refundReversedAt: ago(1 * DAY).toISOString() }, createdAt: ago(3 * DAY) });
      cases['refunded'] = { id: s, bucket: 'neither', anchorTx: null };
      payments['refunded'] = { id: tx, paid: false };
    }
    // Refunded in part: still COMPLETED, still paid.
    {
      const s = await subscription({ createdAt: ago(3 * DAY) });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 499, gatewayData: { refundedAmountTotal: '200.00' }, createdAt: ago(3 * DAY) });
      cases['partial-refund'] = { id: s, bucket: 'paid', anchorTx: tx };
      payments['partial-refund'] = { id: tx, paid: true };
    }
    // A pending checkout is no money yet.
    {
      const s = await subscription({ createdAt: ago(1 * DAY) });
      const tx = await payment({ subscriptionId: s, status: 'PENDING', purchaseType: 'NEW', amount: 499, createdAt: ago(1 * DAY), fulfilledAt: null });
      cases['pending'] = { id: s, bucket: 'trial', anchorTx: null };
      payments['pending'] = { id: tx, paid: false };
    }
    // Paid, but no longer live: in no bucket — the status is the callers' filter,
    // and the anchor, which is not, still names the purchase.
    {
      const s = await subscription({ createdAt: ago(3 * DAY), status: 'EXPIRED' });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(3 * DAY) });
      const d = await subscription({ createdAt: ago(3 * DAY), status: 'DELETED' });
      cases['expired'] = { id: s, bucket: 'neither', anchorTx: tx };
      cases['deleted'] = { id: d, bucket: 'neither', anchorTx: null };
    }
    // A gift made long before the window, never paid for.
    {
      const s = await subscription({ createdAt: ago(10 * DAY) });
      cases['old-gift'] = { id: s, bucket: 'trial', anchorTx: null };
    }
    // LIMITED counts as live.
    {
      const s = await subscription({ createdAt: ago(3 * DAY), status: 'LIMITED' });
      const tx = await payment({ subscriptionId: s, purchaseType: 'NEW', amount: 499, createdAt: ago(3 * DAY) });
      cases['limited'] = { id: s, bucket: 'paid', anchorTx: tx };
    }
  });

  after(async () => {
    const like = `${prefix}-%`;
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "transactions" WHERE "id" LIKE ${like}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "subscriptions" WHERE "id" LIKE ${like}`);
    await prisma.$executeRaw(Prisma.sql`DELETE FROM "users" WHERE "id" LIKE ${like}`);
    await prisma.$disconnect();
  });

  it('puts every case in the bucket the owner decided', async () => {
    const found = await verdicts(Object.values(cases).map((c) => c.id));
    const wrong: string[] = [];
    for (const [label, expected] of Object.entries(cases)) {
      const verdict = found.get(expected.id);
      assert.ok(verdict !== undefined, `${label} was not read back`);
      const actual = bucketOf(verdict);
      if (actual !== expected.bucket) wrong.push(`${label}: expected ${expected.bucket}, got ${actual}`);
    }
    assert.deepStrictEqual(wrong, []);
    // Anchor: every bucket is represented, so none of them can pass by being empty.
    const buckets = new Set(Object.values(cases).map((c) => c.bucket));
    assert.deepStrictEqual([...buckets].sort(), ['neither', 'paid', 'trial']);
  });

  it('the two buckets never overlap', async () => {
    const found = await verdicts(Object.values(cases).map((c) => c.id));
    for (const [label, expected] of Object.entries(cases)) {
      const verdict = found.get(expected.id)!;
      assert.ok(!(verdict.paid && verdict.trial), `${label} is in both buckets`);
    }
  });

  it('anchors "became paid" on the subscription’s first paid money — never a renewal, never a gift', async () => {
    const found = await verdicts(Object.values(cases).map((c) => c.id));
    const wrong: string[] = [];
    for (const [label, expected] of Object.entries(cases)) {
      const actual = found.get(expected.id)!.anchorTx;
      if (actual !== expected.anchorTx) wrong.push(`${label}: expected ${expected.anchorTx}, got ${actual}`);
    }
    assert.deepStrictEqual(wrong, []);
    assert.ok(Object.values(cases).filter((c) => c.anchorTx !== null).length >= 8, 'anchored cases exist');
  });

  it('dates the anchor by fulfilment, falling back to creation', async () => {
    const found = await verdicts([cases['native']!.id, cases['partner-balance']!.id]);
    assert.equal(
      found.get(cases['native']!.id)?.anchorAt?.toISOString(),
      new Date(ago(3 * DAY).getTime() + 90_000).toISOString(),
      'fulfilled 90 s after creation',
    );
    assert.equal(found.get(cases['partner-balance']!.id)?.anchorAt?.toISOString(), ago(2 * DAY).toISOString());
  });

  it('bounds "paid" by the payment’s time when asked — a renewal of an old subscription counts in its window', async () => {
    const since = ago(36 * HOUR);
    const rows = await prisma.$queryRaw<Array<{ readonly id: string; readonly recent: boolean }>>(Prisma.sql`
      SELECT "s"."id", ${moneyForSubscriptionSql('s', { since })} AS "recent"
        FROM "subscriptions" "s"
       WHERE "s"."id" IN (${Prisma.join([
         cases['native']!.id,
         cases['new-then-combined']!.id,
         cases['trial-upgraded']!.id,
         cases['partner-balance']!.id,
       ])})
    `);
    const recent = new Map(rows.map((row) => [row.id, row.recent]));
    assert.equal(recent.get(cases['native']!.id), false, 'paid 3 days ago');
    assert.equal(recent.get(cases['new-then-combined']!.id), true, 'renewed yesterday, through an item');
    assert.equal(recent.get(cases['trial-upgraded']!.id), true);
    assert.equal(recent.get(cases['partner-balance']!.id), false);
  });

  it('lists each payment with the subscription it paid for — directly or through an item', async () => {
    const rows = await prisma.$queryRaw<Array<{ readonly subscription_id: string; readonly purchase_type: string }>>(Prisma.sql`
      SELECT "p"."subscription_id", "p"."purchase_type"
        FROM ${paidMoneyLinksSql()} "p"
       WHERE "p"."subscription_id" IN (${Prisma.join([cases['combined-renewal-only']!.id, cases['zero-promo']!.id, cases['imported']!.id])})
    `);
    assert.deepStrictEqual(rows, [{ subscription_id: cases['combined-renewal-only']!.id, purchase_type: 'RENEW' }]);
  });

  it('judges each payment by itself: a partner’s balance is money, an add-on, 0 ₽, an import, a refund and a pending checkout are not', async () => {
    const rows = await prisma.$queryRaw<Array<{ readonly id: string; readonly paid: boolean }>>(Prisma.sql`
      SELECT "t"."id", ${paidMoneySql('t')} AS "paid"
        FROM "transactions" "t"
       WHERE "t"."id" IN (${Prisma.join(Object.values(payments).map((entry) => entry.id))})
    `);
    const paid = new Map(rows.map((row) => [row.id, row.paid]));
    const wrong = Object.entries(payments)
      .filter(([, entry]) => paid.get(entry.id) !== entry.paid)
      .map(([label, entry]) => `${label}: expected ${entry.paid}, got ${String(paid.get(entry.id))}`);
    assert.deepStrictEqual(wrong, []);
    // Both answers are exercised, so neither can pass by being absent.
    assert.deepStrictEqual(new Set(Object.values(payments).map((entry) => entry.paid)).size, 2);
  });

  it('keeps the horizon to live subscriptions made, or paid for, in the window', async () => {
    const rows = await prisma.$queryRaw<Array<{ readonly subscription_id: string }>>(Prisma.sql`
      SELECT "h"."subscription_id" FROM ${connectHorizonSql(ago(4 * DAY))} "h"
       WHERE "h"."subscription_id" LIKE ${`${prefix}-%`}
    `);
    const inside = new Set(rows.map((row) => row.subscription_id));
    assert.ok(inside.has(cases['native']!.id), 'made 3 days ago');
    assert.ok(inside.has(cases['combined-renewal-only']!.id), 'made 9 days ago, paid for yesterday');
    assert.ok(inside.has(cases['zero-then-upgrade']!.id), 'made 6 days ago, upgraded for money 2 days ago');
    assert.ok(!inside.has(cases['old-gift']!.id), 'made 10 days ago and never paid for');
    assert.ok(!inside.has(cases['refunded']!.id), 'EXPIRED, and its only payment was refunded');
    assert.ok(!inside.has(cases['deleted']!.id), 'DELETED');
  });
});
