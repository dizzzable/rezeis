import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AddOnLifetime, AddOnType, Prisma, SubscriptionStatus, SubscriptionTermStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import {
  REFUND_WITHDRAWN_DAYS_KEY,
  RefundedDaysWithdrawalService,
  type WithdrawnLine,
} from '../src/modules/payments/services/refunded-days-withdrawal.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * «Снять купленные дни» (the owner, 08.11.2026), on PostgreSQL with the real
 * term chain: a refunded renewal takes its days off the subscription, the
 * queued period it bought is cancelled, the tail follows the new end, and a
 * sync job carries it to Remnawave.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `rdw-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;

let prisma: PrismaService;
let service: RefundedDaysWithdrawalService;
const users: string[] = [];
let seq = 0;

const at = (offsetDays: number): Date => new Date(Date.now() + offsetDays * DAY_MS);

async function newUser(tag: string): Promise<string> {
  const id = `${prefix}-${tag}`;
  await prisma.user.create({ data: { id, referralCode: id, name: id } });
  users.push(id);
  return id;
}

async function subscription(userId: string, tag: string, expiresAt: Date | null): Promise<string> {
  const id = `${prefix}-${tag}`;
  await prisma.subscription.create({
    data: {
      id,
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: { id: 'plan', trafficLimit: 100, deviceLimit: 3, trafficLimitStrategy: 'NO_RESET' },
      trafficLimit: 100,
      deviceLimit: 3,
      expiresAt,
      remnawaveId: `${id}-rw`,
    },
  });
  return id;
}

async function term(
  subscriptionId: string,
  generation: number,
  status: SubscriptionTermStatus,
  startsAt: Date,
  endsAt: Date,
): Promise<string> {
  const created = await prisma.subscriptionTerm.create({
    data: {
      subscriptionId,
      generation,
      status,
      planSnapshot: {},
      startsAt,
      endsAt,
      baseTrafficLimitBytes: 100n * 1024n * 1024n * 1024n,
      baseDeviceLimit: 3,
      trafficResetStrategy: 'NO_RESET',
      resetAnchorAt: startsAt,
    },
  });
  return created.id;
}

async function renewal(userId: string, subscriptionId: string, days: number) {
  seq += 1;
  return prisma.transaction.create({
    data: {
      paymentId: `${prefix}-pay-${seq}`,
      userId,
      subscriptionId,
      status: 'COMPLETED',
      purchaseType: 'RENEW',
      channel: 'WEB',
      gatewayType: 'PLATEGA',
      currency: 'RUB',
      amount: new Prisma.Decimal('300'),
      planSnapshot: { id: 'plan', selectedDurationDays: days },
      fulfilledAt: new Date(),
    },
  });
}

function lines(outcome: { audit: Record<string, unknown> }): WithdrawnLine[] {
  return outcome.audit[REFUND_WITHDRAWN_DAYS_KEY] as WithdrawnLine[];
}

const close = (left: Date | null | undefined, right: Date): boolean =>
  left !== null && left !== undefined && Math.abs(left.getTime() - right.getTime()) < 5_000;

run('RefundedDaysWithdrawalService on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new RefundedDaysWithdrawalService(prisma, undefined, new SubscriptionTermService());
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, users);
    await prisma.$disconnect();
  });

  it('takes a renewal’s days off a subscription outside the term model, and tells Remnawave', async () => {
    const userId = await newUser('columns');
    const id = await subscription(userId, 'columns', at(40));
    const payment = await renewal(userId, id, 30);

    const outcome = await service.withdraw(payment);

    assert.equal(outcome.withdrawn, true);
    assert.equal(outcome.needsManualReview, false);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    assert.ok(close(row.expiresAt, at(10)), String(row.expiresAt));
    assert.equal(row.status, SubscriptionStatus.ACTIVE);
    const jobs = await prisma.profileSyncJob.findMany({ where: { subscriptionId: id } });
    assert.equal(jobs.length, 1);
    assert.equal((jobs[0]?.payload as Record<string, unknown>)['source'], 'PAYMENT_REFUND');
  });

  it('cancels the queued period a renewal bought, and the chain ends where it did before', async () => {
    const userId = await newUser('queued');
    const id = await subscription(userId, 'queued', at(40));
    const activeId = await term(id, 1, SubscriptionTermStatus.ACTIVE, at(-20), at(10));
    const queuedId = await term(id, 2, SubscriptionTermStatus.SCHEDULED, at(10), at(40));
    const payment = await renewal(userId, id, 30);

    const outcome = await service.withdraw(payment);

    assert.equal(outcome.withdrawn, true);
    assert.deepStrictEqual(lines(outcome)[0]?.canceledTermIds, [queuedId]);
    const queued = await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: queuedId } });
    assert.equal(queued.status, SubscriptionTermStatus.CANCELED);
    const active = await prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: activeId } });
    assert.equal(active.status, SubscriptionTermStatus.ACTIVE);
    assert.ok(close(active.endsAt, at(10)), String(active.endsAt));
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    assert.ok(close(row.expiresAt, at(10)), String(row.expiresAt));
  });

  it('ends the subscription now when fewer days are left than were refunded', async () => {
    const userId = await newUser('ends');
    const id = await subscription(userId, 'ends', at(5));
    await term(id, 1, SubscriptionTermStatus.ACTIVE, at(-25), at(5));
    const payment = await renewal(userId, id, 30);

    const outcome = await service.withdraw(payment);

    assert.equal(lines(outcome)[0]?.ended, true);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    assert.equal(row.status, SubscriptionStatus.EXPIRED);
    assert.ok(close(row.expiresAt, new Date()), String(row.expiresAt));
  });

  it('leaves a queued period that carries an add-on to an operator, and writes nothing', async () => {
    const userId = await newUser('addon');
    const id = await subscription(userId, 'addon', at(40));
    await term(id, 1, SubscriptionTermStatus.ACTIVE, at(-20), at(10));
    const queuedId = await term(id, 2, SubscriptionTermStatus.SCHEDULED, at(10), at(40));
    const source = await renewal(userId, id, 30);
    await prisma.addOnEntitlement.create({
      data: {
        subscriptionId: id,
        termId: queuedId,
        sourceTransactionId: source.id,
        sourceLineKey: 'line',
        catalogRevision: 1,
        receiptName: '+1 device',
        type: AddOnType.EXTRA_DEVICES,
        valuePerUnit: 1,
        totalValue: 1n,
        lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
        unitAmount: new Prisma.Decimal('100'),
        totalAmount: new Prisma.Decimal('100'),
        currency: 'RUB',
        purchasedAt: new Date(),
        scheduledActivationAt: at(10),
        activatedAt: null,
        expiresAt: at(40),
        state: 'PENDING_ACTIVATION',
      },
    });
    const payment = await renewal(userId, id, 30);

    const outcome = await service.withdraw(payment);

    assert.equal(outcome.withdrawn, false);
    assert.equal(outcome.needsManualReview, true);
    assert.equal(lines(outcome)[0]?.skipped, 'QUEUED_PERIOD_HAS_ADD_ONS');
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    assert.ok(close(row.expiresAt, at(40)), String(row.expiresAt));
  });
});
