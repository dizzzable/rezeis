import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Test } from '@nestjs/testing';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { AccountMergeService } from '../src/modules/account-merge/services/account-merge.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';
import { SpinWalletService } from '../src/modules/wheel/services/spin-wallet.service';

/**
 * An account merge keeps what the schema grew after it was written — against a
 * real PostgreSQL, because what was lost was lost by the schema's own cascade.
 *
 * Until 17.10.2026 the merge re-pointed the tables it knew and deleted the
 * merged-away account, and the delete decided for everything else: the wheel
 * spins on its balance were never read, its device and address observations
 * cascaded away, and its autopay at the provider was orphaned (SetNull) — so
 * the sweep that cancels an owner-less one stopped the survivor's autopay.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `amc-${process.pid}-${Date.now()}`;
let prisma: PrismaService;

run('an account merge and the child tables it used to lose, on PostgreSQL', () => {
  const created: string[] = [];

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.providerSubscription.deleteMany({ where: { providerSubscriptionId: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  async function customer(name: string, spinBalance: number): Promise<string> {
    const userId = `${prefix}-${name}`;
    created.push(userId);
    await prisma.user.create({ data: { id: userId, referralCode: `${prefix}-${name}-ref`, name, spinBalance } });
    return userId;
  }

  async function merger(): Promise<AccountMergeService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountMergeService,
        PointsWalletService,
        SpinWalletService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemEventsService, useValue: { info: () => undefined } },
        { provide: ProfileSyncQueueService, useValue: { enqueue: async () => undefined } },
      ],
    }).compile();
    return moduleRef.get(AccountMergeService);
  }

  it('moves the spins, the provider autopay and the observations, and still deletes the source', async () => {
    const target = await customer('target', 2);
    const source = await customer('source', 5);
    await prisma.providerSubscription.create({
      data: {
        userId: source,
        gatewayType: 'YOOKASSA',
        providerSubscriptionId: `${prefix}-ps`,
        status: 'ACTIVE',
        planId: 'plan-x',
        durationDays: 30,
        amount: 199,
        currency: 'RUB',
        intervalUnit: 'MONTH',
        intervalCount: 1,
        firstTransactionId: `${prefix}-tx`,
        consentVersion: 'v1',
      },
    });
    // One device both accounts were seen on, one only the source was.
    await prisma.deviceObservation.createMany({
      data: [
        { userId: target, kind: 'INSTALL_ID', value: `${prefix}-shared` },
        { userId: source, kind: 'INSTALL_ID', value: `${prefix}-shared` },
        { userId: source, kind: 'DEVICE_HASH', value: `${prefix}-own` },
      ],
    });
    await prisma.userIpObservation.createMany({
      data: [
        { userId: target, address: '198.51.100.7' },
        { userId: source, address: '198.51.100.7' },
        { userId: source, address: '203.0.113.9' },
      ],
    });

    const result = await (await merger()).merge({
      sourceId: source,
      targetId: target,
      choices: {},
      confirm: true,
      actorAdminId: 'admin-test',
    });

    assert.equal(result.mergedUserId, target);
    assert.equal(await prisma.user.count({ where: { id: source } }), 0, 'the source is deleted');

    const survivor = await prisma.user.findUniqueOrThrow({ where: { id: target }, select: { spinBalance: true } });
    assert.equal(survivor.spinBalance, 7, 'the source\'s 5 spins land on the survivor\'s 2');
    const credit = await prisma.spinLedgerEntry.findFirst({ where: { userId: target, delta: 5 } });
    assert.equal(credit?.source, 'MANUAL_ADJUSTMENT', 'the move is journaled on the survivor');

    const autopay = await prisma.providerSubscription.findFirstOrThrow({
      where: { providerSubscriptionId: `${prefix}-ps` },
    });
    assert.equal(autopay.userId, target, 'the autopay stays owned, so the orphan sweep leaves it alone');

    const devices = await prisma.deviceObservation.findMany({ where: { userId: target }, orderBy: { value: 'asc' } });
    assert.deepEqual(
      devices.map((d) => d.value),
      [`${prefix}-own`, `${prefix}-shared`],
      'the shared device once, the source\'s own one moved',
    );
    const addresses = await prisma.userIpObservation.findMany({ where: { userId: target }, orderBy: { address: 'asc' } });
    assert.deepEqual(addresses.map((a) => a.address), ['198.51.100.7', '203.0.113.9']);
  });
});
