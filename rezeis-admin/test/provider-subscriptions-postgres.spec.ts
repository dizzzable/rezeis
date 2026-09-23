import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';
import { Currency, PaymentGatewayType, Prisma, ProviderSubscriptionStatus } from '@prisma/client';
import { of, throwError } from 'rxjs';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  ProviderSubscriptionService,
  STRANDED_SWEEP_PAGE,
} from '../src/modules/payments/services/provider-subscription.service';

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
    await prisma.user.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.$disconnect();
  });

  it('sweeps every live row: a stranded one behind more than a page it cannot change is still cancelled', async () => {
    // The sweep read the oldest 500 once, and the oldest are the rows that stay.
    // Every row here is older than anything else in the table, and all share one
    // instant, so the page boundary falls inside one `createdAt` and only the id
    // carries the cursor past it.
    mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(Logger.prototype, 'log', () => undefined);
    const userId = `${prefix}-blocked`;
    await prisma.user.create({ data: { id: userId, referralCode: `${userId}-ref`, name: userId, isBlocked: true } });
    const createdAt = new Date('2020-01-01T00:00:00.000Z');
    const stuckCount = STRANDED_SWEEP_PAGE + 20;
    await prisma.providerSubscription.createMany({
      data: Array.from({ length: stuckCount }, (_, index) => {
        const id = `${prefix}-a-stuck-${String(index).padStart(4, '0')}`;
        return { ...row(userId, id), id, createdAt };
      }),
    });
    const lastId = `${prefix}-z-last`;
    await prisma.providerSubscription.create({ data: { ...row(userId, lastId), id: lastId, createdAt } });

    // The provider refuses the stuck ones for good; the gateway row is the
    // only thing not read from PostgreSQL.
    const client = new Proxy(prisma, {
      get: (target, property) =>
        property === 'paymentGateway'
          ? { findUnique: async () => ({ type: PaymentGatewayType.PLATEGA, settings: { merchantId: 'm-1', secret: 's-1' } }) }
          : Reflect.get(target, property, target),
    });
    const http = {
      post: (url: string) =>
        url.includes('-a-stuck-') ? throwError(() => new Error('provider refused')) : of({ data: { status: 'cancelled' } }),
    };
    const service = new ProviderSubscriptionService(client as never, http as never, {} as never, {} as never);

    await service.cancelStranded();
    mock.restoreAll();

    const last = await prisma.providerSubscription.findUniqueOrThrow({ where: { id: lastId } });
    assert.equal(last.status, ProviderSubscriptionStatus.CANCELLED, 'the row behind the stuck ones was never reached');
    assert.equal(last.cancelledBy, 'SYSTEM');
    assert.equal(
      await prisma.providerSubscription.count({
        where: { id: { startsWith: `${prefix}-a-stuck-` }, status: ProviderSubscriptionStatus.ACTIVE },
      }),
      stuckCount,
    );
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
