import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Currency, PaymentGatewayType, Prisma, ProviderSubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * `provider_subscriptions` (migration `20260919210000_provider_subscriptions`)
 * on PostgreSQL.
 *
 * The one property the code cannot check by itself: deleting an account keeps
 * the row and empties its user key (`ON DELETE SET NULL`). The row is the only
 * record that the provider still charges someone; with a cascade it vanished
 * with the account and the sweep had nothing left to cancel. And the provider's
 * id is unique per gateway, which is what makes a lost write safe to redo.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `psub-${process.pid}-${Date.now()}`;

let prisma: PrismaService;

function row(userId: string, providerSubscriptionId: string): Prisma.ProviderSubscriptionUncheckedCreateInput {
  return {
    userId,
    gatewayType: PaymentGatewayType.PLATEGA,
    providerSubscriptionId,
    status: ProviderSubscriptionStatus.ACTIVE,
    planId: `${prefix}-plan`,
    durationDays: 30,
    amount: new Prisma.Decimal('299'),
    currency: Currency.RUB,
    intervalUnit: 'month',
    intervalCount: 1,
    firstTransactionId: `${providerSubscriptionId}-first`,
    consentVersion: 'provider-subscription-v1',
  };
}

run('provider_subscriptions on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.providerSubscription.deleteMany({ where: { providerSubscriptionId: { startsWith: prefix } } });
    await prisma.$disconnect();
  });

  it('keeps the row, without its user, when the account is deleted', async () => {
    const userId = `${prefix}-user`;
    await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
    const created = await prisma.providerSubscription.create({ data: row(userId, `${prefix}-sub-1`) });

    await prisma.user.delete({ where: { id: userId } });

    const kept = await prisma.providerSubscription.findUnique({ where: { id: created.id } });
    assert.notEqual(kept, null);
    assert.equal(kept?.userId, null);
    assert.equal(kept?.status, ProviderSubscriptionStatus.ACTIVE);
  });

  it('holds one row per provider id on a gateway', async () => {
    const userId = `${prefix}-user-2`;
    await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId } });
    await prisma.providerSubscription.create({ data: row(userId, `${prefix}-sub-2`) });
    await assert.rejects(
      prisma.providerSubscription.create({
        data: { ...row(userId, `${prefix}-sub-2`), firstTransactionId: `${prefix}-another-first` },
      }),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
    );
    await prisma.user.delete({ where: { id: userId } });
  });
});
