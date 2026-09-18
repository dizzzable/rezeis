import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Test } from '@nestjs/testing';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { AccountMergePreviewService } from '../src/modules/account-merge/services/account-merge-preview.service';
import { AccountMergeService } from '../src/modules/account-merge/services/account-merge.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';
import {
  RECOVERY_WITHDRAWAL_HOLD_CHANNEL,
  RECOVERY_WITHDRAWAL_HOLD_PURPOSE,
  WITHDRAWAL_HOLD_ERROR_CODE,
  assertPartnerBalanceNotHeld,
  findRecoveryWithdrawalHold,
} from '../src/modules/web-auth/utils/recovery-withdrawal-hold.util';

/**
 * An operator's account merge keeps the recovery hold, against a real PostgreSQL
 * ════════════════════════════════════════════════════════════════════════════
 * The hold after a password recovery by subscription link is a row in
 * `auth_challenges` on the WEB ACCOUNT, and it cascades with it. A merge adds
 * the source's partner balance to the survivor and keeps only one web account:
 * when the survivor's login is kept, the source web account is deleted — and
 * the hold went with it, so money held a moment earlier could be withdrawn at
 * once. When the source's login is kept, the survivor's own web account is
 * deleted, and its hold went the same way.
 *
 * The merge now carries a standing hold over to the web account it keeps; with
 * one on each side, the later end wins. And the merge preview shows a standing
 * hold, so the operator sees it before pressing the button.
 *
 * Only a real database proves the part that matters: the cascade is the
 * schema's, not a fake's.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `amh-${process.pid}-${Date.now()}`;
const HOUR_MS = 60 * 60 * 1000;
let prisma: PrismaService;

interface Side {
  readonly userId: string;
  readonly webAccountId: string;
}

run('an account merge and the recovery hold, on PostgreSQL', () => {
  const created: string[] = [];

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.partner.deleteMany({ where: { userId: { in: created } } });
    await prisma.webAccount.deleteMany({ where: { userId: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  /** A customer with a web account and a partner balance, and a hold ending at `holdUntil` when given. */
  async function customer(name: string, balance: number, holdUntil?: Date): Promise<Side> {
    const userId = `${prefix}-${name}`;
    const webAccountId = `${prefix}-${name}-wa`;
    created.push(userId);
    await prisma.user.create({ data: { id: userId, referralCode: `${prefix}-${name}-ref`, name } });
    await prisma.webAccount.create({
      data: { id: webAccountId, userId, login: `${prefix}-${name}`, loginNormalized: `${prefix}-${name}`, passwordHash: 'scrypt$x' },
    });
    await prisma.partner.create({ data: { userId, balance } });
    if (holdUntil !== undefined) {
      await prisma.authChallenge.create({
        data: {
          webAccountId,
          purpose: RECOVERY_WITHDRAWAL_HOLD_PURPOSE,
          channel: RECOVERY_WITHDRAWAL_HOLD_CHANNEL,
          destination: userId,
          expiresAt: holdUntil,
        },
      });
    }
    return { userId, webAccountId };
  }

  async function merger(): Promise<AccountMergeService> {
    const events: Pick<SystemEventsService, 'info'> = { info: () => undefined };
    const queue: Pick<ProfileSyncQueueService, 'enqueue'> = { enqueue: async () => undefined };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountMergeService,
        PointsWalletService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemEventsService, useValue: events },
        { provide: ProfileSyncQueueService, useValue: queue },
      ],
    }).compile();
    return moduleRef.get(AccountMergeService);
  }

  async function holdOf(userId: string): Promise<string | null> {
    return (await findRecoveryWithdrawalHold(prisma, userId, new Date()))?.toISOString() ?? null;
  }

  it('keeps the source’s hold when the survivor’s own login is kept — the held money stays held', async () => {
    const holdUntil = new Date(Date.now() + 48 * HOUR_MS);
    const source = await customer('src1', 10_000, holdUntil);
    const target = await customer('tgt1', 500);

    await (await merger()).merge({ sourceId: source.userId, targetId: target.userId, choices: {}, confirm: true, actorAdminId: 'admin' });

    assert.equal(await holdOf(target.userId), holdUntil.toISOString(), 'the merged balance can be withdrawn at once');
    await assert.rejects(() => assertPartnerBalanceNotHeld(prisma, target.userId), (error: unknown) => {
      const body = (error as { getResponse(): { code?: string } }).getResponse();
      return body.code === WITHDRAWAL_HOLD_ERROR_CODE;
    });
    const partner = await prisma.partner.findUniqueOrThrow({ where: { userId: target.userId } });
    assert.equal(partner.balance, 10_500);
    assert.equal(await prisma.webAccount.count({ where: { id: source.webAccountId } }), 0);
  });

  it('keeps the survivor’s own hold when the source’s login is kept instead', async () => {
    const holdUntil = new Date(Date.now() + 30 * HOUR_MS);
    const source = await customer('src2', 100);
    const target = await customer('tgt2', 9_000, holdUntil);

    await (await merger()).merge({
      sourceId: source.userId,
      targetId: target.userId,
      choices: { keepLogin: 'source' },
      confirm: true,
      actorAdminId: 'admin',
    });

    assert.equal(await prisma.webAccount.count({ where: { id: target.webAccountId } }), 0, 'the survivor’s web account stayed');
    assert.equal(await holdOf(target.userId), holdUntil.toISOString(), 'the survivor’s hold went with its web account');
  });

  it('lets the later of two holds win', async () => {
    const earlier = new Date(Date.now() + 5 * HOUR_MS);
    const later = new Date(Date.now() + 70 * HOUR_MS);

    const laterOnSource = await customer('src3', 1_000, later);
    const earlierOnTarget = await customer('tgt3', 1_000, earlier);
    await (await merger()).merge({ sourceId: laterOnSource.userId, targetId: earlierOnTarget.userId, choices: {}, confirm: true, actorAdminId: 'admin' });
    assert.equal(await holdOf(earlierOnTarget.userId), later.toISOString());

    const earlierOnSource = await customer('src4', 1_000, earlier);
    const laterOnTarget = await customer('tgt4', 1_000, later);
    await (await merger()).merge({
      sourceId: earlierOnSource.userId,
      targetId: laterOnTarget.userId,
      choices: { keepLogin: 'source' },
      confirm: true,
      actorAdminId: 'admin',
    });
    assert.equal(await holdOf(laterOnTarget.userId), later.toISOString());
  });

  it('shows a standing hold in the merge preview, and none where there is none', async () => {
    const holdUntil = new Date(Date.now() + 24 * HOUR_MS);
    const held = await customer('prev1', 2_000, holdUntil);
    const free = await customer('prev2', 2_000);
    const lapsed = await customer('prev3', 2_000, new Date(Date.now() - HOUR_MS));
    const preview = new AccountMergePreviewService(prisma);

    assert.equal((await preview.buildSummary(held.userId)).balanceHoldUntil, holdUntil.toISOString());
    assert.equal((await preview.buildSummary(free.userId)).balanceHoldUntil, null);
    assert.equal((await preview.buildSummary(lapsed.userId)).balanceHoldUntil, null, 'an ended hold is shown as standing');
  });
});
