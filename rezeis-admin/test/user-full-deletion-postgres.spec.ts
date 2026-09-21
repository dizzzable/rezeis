import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  Currency,
  PaymentGatewayType,
  PurchaseType,
  SubscriptionStatus,
  TransactionStatus,
  TrialClaimSource,
  TrialClaimStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { buildUserListWhere } from '../src/modules/users/services/admin-users.service';
import {
  USER_DELETE_PROTECTED_HISTORY_CODE,
  UserDeletionService,
} from '../src/modules/users/services/user-deletion.service';

/**
 * «УДАЛИТЬ ПОЛНОСТЬЮ», AGAINST REAL FOREIGN KEYS.
 *
 * This cannot be a unit test and it is not close. Everything that made the old
 * deletion refuse is a `Restrict` in Postgres, and everything that makes the
 * new one land is the ORDER the rows are moved in. A mocked Prisma would
 * accept any order at all and report a pass for a deletion that the database
 * rejects — which is precisely the shape of the bug being fixed.
 *
 * The four things proved here:
 *
 *   1. the ordinary deletion still refuses, and now SAYS what it refused on —
 *      the operator could not previously tell a test account that took a free
 *      trial from one that took real money, because both answered «нельзя»;
 *   2. a full deletion lands and frees the identity — the Telegram id is
 *      reusable, which is the whole point for an operator who creates test
 *      accounts to check their own product;
 *   3. the money is still there and still counted, on a row that is nobody:
 *      `anonymizedAt` set, no Telegram id, no name;
 *   4. A SUBSCRIPTION WITH A TERM DOES NOT BLOCK IT. `User → Subscription` is
 *      `Cascade`, `SubscriptionTerm → Subscription` is `Restrict`, and
 *      `TransactionItem → Subscription` is `Restrict` too — so deleting a user
 *      who has ever held a real subscription used to fail on a foreign key and
 *      be reported to the operator as "protected history". This is the case
 *      that has to run against Postgres or it proves nothing.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `ufd-${process.pid}-${Date.now()}`;

let prisma: PrismaService;
let service: UserDeletionService;
let seq = 0;

/** A Telegram id nothing else in the database can be using. */
function nextTelegramId(): bigint {
  seq += 1;
  return BigInt(Date.now()) * 1000n + BigInt(seq);
}

/**
 * The Remnawave panel, recorded rather than called.
 *
 * Most fixtures here are deliberately unprovisioned, so nothing reaches it —
 * but ONE is, and that one matters more than the rest: a full deletion that
 * forgot to snapshot the panel identity before moving the subscriptions would
 * pass every other assertion in this file while leaving the customer's profile
 * serving VPN upstream, addressed by nobody and billed to no one.
 */
const panelDeletes: string[] = [];
const recordingPanel = {
  getPanelShape: async () => ({ shape: 'id' as const }),
  deletePanelUser: async (identity: { readonly remnawaveId?: string }) => {
    panelDeletes.push(identity.remnawaveId ?? 'unknown');
  },
} as never;

/**
 * Every row this file made, so `after` can take them out in an order the
 * foreign keys allow. A holder is nameless by construction, so the usual
 * `name: { startsWith: prefix }` sweep cannot find one — and a holder left in
 * a shared CI database is a row every other spec's user counts would see.
 */
const touched: string[] = [];

async function createUser(): Promise<{ id: string; telegramId: bigint }> {
  seq += 1;
  const telegramId = nextTelegramId();
  const user = await prisma.user.create({
    data: {
      telegramId,
      name: `${prefix}-${seq}`,
      referralCode: `${prefix}-${seq}`,
    },
    select: { id: true },
  });
  touched.push(user.id);
  return { id: user.id, telegramId };
}

/** `deleteUser`, with any holder it leaves recorded for the sweep. */
async function remove(
  userId: string,
  mode?: 'full',
): Promise<Awaited<ReturnType<UserDeletionService['deleteUser']>>> {
  const summary = await service.deleteUser(userId, mode === undefined ? {} : { mode });
  if (summary.holderUserId !== null) touched.push(summary.holderUserId);
  return summary;
}

async function createPayment(userId: string, amount: string): Promise<string> {
  seq += 1;
  const transaction = await prisma.transaction.create({
    data: {
      userId,
      paymentId: `${prefix}-pay-${seq}`,
      status: TransactionStatus.COMPLETED,
      purchaseType: PurchaseType.NEW,
      gatewayType: PaymentGatewayType.YOOKASSA,
      currency: Currency.RUB,
      amount,
    },
    select: { id: true },
  });
  return transaction.id;
}

async function createTrialClaim(userId: string): Promise<void> {
  await prisma.trialClaim.create({
    data: {
      userId,
      source: TrialClaimSource.FREE,
      status: TrialClaimStatus.CONSUMED,
      consumedAt: new Date(),
    },
  });
}

/** A subscription that carries a term — the `Restrict` edge that used to block. */
async function createSubscriptionWithTerm(userId: string): Promise<string> {
  const subscription = await prisma.subscription.create({
    data: { userId, status: SubscriptionStatus.ACTIVE, deviceLimit: 3 },
    select: { id: true },
  });
  await prisma.subscriptionTerm.create({
    data: { subscriptionId: subscription.id, generation: 1, startsAt: new Date() },
  });
  return subscription.id;
}

/** The holder a full deletion left behind, found through the payment it holds. */
async function holderOf(transactionId: string) {
  const transaction = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { userId: true, amount: true },
  });
  const holder = await prisma.user.findUniqueOrThrow({
    where: { id: transaction.userId },
    select: {
      id: true,
      anonymizedAt: true,
      telegramId: true,
      email: true,
      name: true,
      isBlocked: true,
    },
  });
  return { holder, amount: transaction.amount.toString() };
}

run('«Удалить полностью» — the account goes, the books stay', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new UserDeletionService(prisma, recordingPanel);
  });

  after(async () => {
    // In the order the foreign keys allow: a term holds its subscription, a
    // transaction holds its user, and a holder holds nothing but is held BY
    // everything a full deletion moved onto it.
    await prisma.subscriptionTerm.deleteMany({
      where: { subscription: { userId: { in: touched } } },
    });
    await prisma.subscription.deleteMany({ where: { userId: { in: touched } } });
    await prisma.trialClaim.deleteMany({ where: { userId: { in: touched } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: touched } } });
    await prisma.user.deleteMany({ where: { id: { in: touched } } });
    await prisma.user.deleteMany({ where: { name: { startsWith: prefix } } });
    await prisma.$disconnect();
  });

  it('refuses the ordinary deletion of a trial account — and names the trial', async () => {
    // THE REPORTED CASE. An operator creates a test account, takes the free
    // trial through it to check the flow, and can never remove it again.
    const user = await createUser();
    await createTrialClaim(user.id);

    const refusal = await remove(user.id).then(
      () => null,
      (error: unknown) => error as { getResponse?: () => unknown },
    );
    assert.notEqual(refusal, null, 'a trial account must not be deletable by the plain path');
    const body = refusal?.getResponse?.() as { code?: string; blockedBy?: Record<string, number> };
    assert.equal(body.code, USER_DELETE_PROTECTED_HISTORY_CODE);
    assert.equal(
      body.blockedBy?.trialClaims,
      1,
      'the refusal named nothing, so the operator could not tell a free trial from real money',
    );
    assert.equal(body.blockedBy?.transactions, 0);

    assert.notEqual(
      await prisma.user.findUnique({ where: { id: user.id }, select: { id: true } }),
      null,
      'a refused deletion must leave the account exactly where it was',
    );
  });

  it('deletes that account in full, and frees the Telegram id for the next test', async () => {
    const user = await createUser();
    await createTrialClaim(user.id);

    const summary = await remove(user.id, 'full');

    assert.equal(summary.purged.trialClaims, 1);
    assert.equal(
      await prisma.user.findUnique({ where: { id: user.id }, select: { id: true } }),
      null,
    );
    assert.equal(
      await prisma.user.findUnique({ where: { telegramId: user.telegramId }, select: { id: true } }),
      null,
      'the Telegram id must be reusable — an operator who cannot re-create the test account is where they started',
    );
    assert.equal(await prisma.trialClaim.count({ where: { userId: user.id } }), 0);
    assert.equal(
      summary.holderUserId,
      null,
      'nothing was owed to the books, so no holder should have been left behind',
    );
  });

  it('keeps the payment, on a row that is nobody', async () => {
    const user = await createUser();
    const transactionId = await createPayment(user.id, '499.00');

    const summary = await remove(user.id, 'full');

    assert.equal(summary.preserved.transactions, 1);
    assert.deepEqual(summary.preservedTotals, [{ currency: 'RUB', amount: '499' }]);

    const { holder, amount } = await holderOf(transactionId);
    assert.equal(amount, '499');
    assert.equal(holder.id, summary.holderUserId);
    assert.notEqual(holder.anonymizedAt, null, 'the holder must be marked, or it reads as a customer');
    assert.equal(holder.telegramId, null);
    assert.equal(holder.email, null);
    assert.equal(holder.name, '');
    assert.equal(holder.isBlocked, true);
  });

  it('leaves the holder out of the customer list — and out of its count', async () => {
    const user = await createUser();
    const transactionId = await createPayment(user.id, '100.00');
    await remove(user.id, 'full');
    const { holder } = await holderOf(transactionId);

    const where = buildUserListWhere({} as never);
    const found = await prisma.user.findFirst({
      where: { AND: [where, { id: holder.id }] },
      select: { id: true },
    });

    assert.equal(
      found,
      null,
      'the holder has no Telegram id, no e-mail and no name, so it would be a blank row with a live Delete button',
    );
    // ANTI-VACUITY: the same clause must still find an ordinary customer, or
    // "excluded" would be true of everybody and the list would be empty.
    const ordinary = await createUser();
    assert.notEqual(
      await prisma.user.findFirst({
        where: { AND: [where, { id: ordinary.id }] },
        select: { id: true },
      }),
      null,
    );
  });

  it('is not blocked by a subscription that carries a term', async () => {
    // THE FOREIGN KEY NOBODY WOULD FIND BY READING. `User → Subscription` is
    // `Cascade`, so deleting the user hard-deletes the subscription — and
    // `SubscriptionTerm → Subscription` is `Restrict`, so the database refuses
    // and the operator is told "protected history" about an account that has
    // none.
    const user = await createUser();
    const subscriptionId = await createSubscriptionWithTerm(user.id);
    const transactionId = await createPayment(user.id, '250.00');

    const summary = await remove(user.id, 'full');

    assert.equal(
      await prisma.user.findUnique({ where: { id: user.id }, select: { id: true } }),
      null,
    );
    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      select: { userId: true, status: true, remnawaveId: true },
    });
    assert.equal(subscription.userId, summary.holderUserId);
    assert.equal(
      subscription.status,
      SubscriptionStatus.DELETED,
      'a subscription kept for the books must not read as one somebody still holds',
    );
    assert.equal(subscription.remnawaveId, null);
    assert.equal(
      await prisma.subscriptionTerm.count({ where: { subscriptionId } }),
      1,
      'the term travels with its subscription — deleting it is what the Restrict forbids',
    );
    const { holder } = await holderOf(transactionId);
    assert.equal(holder.id, summary.holderUserId);
  });

  it('still deletes a clean account outright, with no holder left behind', async () => {
    // ANTI-VACUITY for the whole file: if every deletion left a holder, the
    // `users` table would grow one row per deletion for no reason at all.
    const user = await createUser();

    const summary = await remove(user.id);

    assert.equal(summary.mode, 'protected');
    assert.equal(summary.holderUserId, null);
    assert.equal(
      await prisma.user.findUnique({ where: { id: user.id }, select: { id: true } }),
      null,
    );
  });

  it('leaves no holder behind when the account owes the books nothing', async () => {
    // `mode: 'full'` is a wider PERMISSION, not a different act. Most accounts
    // it is used on are the test ones this path exists for, and a blank holder
    // per deletion would grow `users` by a row every time for nothing.
    const before = await prisma.user.count({ where: { anonymizedAt: { not: null } } });
    const user = await createUser();

    const summary = await remove(user.id, 'full');

    assert.equal(summary.mode, 'full');
    assert.equal(summary.preserved.transactions, 0);
    assert.equal(summary.holderUserId, null);
    assert.equal(await prisma.user.count({ where: { anonymizedAt: { not: null } } }), before);
  });

  it('still removes the panel profile of a subscription it keeps', async () => {
    // THE ORDER, AS A TEST. The move hands the subscriptions to the holder and
    // clears their `remnawaveId`, so a snapshot taken after it sees nothing —
    // and the deletion would silently leave a live profile behind.
    const user = await createUser();
    const subscriptionId = await createSubscriptionWithTerm(user.id);
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: { remnawaveId: `${prefix}-panel` },
    });
    await createPayment(user.id, '99.00');
    panelDeletes.length = 0;

    await remove(user.id, 'full');

    assert.deepEqual(
      panelDeletes,
      [`${prefix}-panel`],
      'the panel profile was never asked to go, so the customer is deleted and their VPN keeps working',
    );
  });

  it('holds the trial claim to the owner decision of 21.09.2026', async () => {
    // Destroyed outright rather than moved: an operator must be able to take
    // the free trial again from the same device to test it a second time.
    const user = await createUser();
    await createTrialClaim(user.id);
    await createPayment(user.id, '10.00');

    const summary = await remove(user.id, 'full');

    assert.equal(summary.purged.trialClaims, 1);
    assert.equal(
      await prisma.trialClaim.count({ where: { userId: summary.holderUserId ?? '' } }),
      0,
      'a trial claim moved to the holder would keep the quota spent for ever',
    );
  });
});
