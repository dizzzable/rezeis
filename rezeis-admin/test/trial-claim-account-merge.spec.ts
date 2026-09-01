import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PlanAvailability, TrialClaimSource, TrialClaimStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountMergeService } from '../src/modules/account-merge/services/account-merge.service';
import { TRIAL_CLAIM_LIMIT_MESSAGE } from '../src/modules/plans/utils/trial-settings.util';
import { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';

/**
 * A merge consolidates two identities into one, and trial quota is global per
 * surviving identity. The source's ledger rows therefore have to survive the
 * merge and keep denying a second trial — losing them would hand the merged
 * account a free trial it already used.
 */
describe('trial claim ledger across an account merge', () => {
  it('moves the source trial history to the survivor before deleting the source', async () => {
    const world = createMergeWorld();

    await world.merge();

    const claim = world.claims[0];
    assert.equal(world.claims.length, 1, 'merge must not duplicate or drop ledger rows');
    assert.equal(claim?.id, 'claim-src');
    assert.equal(claim?.userId, 'TGT');
    assert.equal(claim?.status, TrialClaimStatus.CONSUMED);
    assert.equal(claim?.source, TrialClaimSource.FREE);
    assert.deepStrictEqual(claim?.consumedAt, new Date('2026-06-01T00:00:00.000Z'));
    // The FK is RESTRICT, so the re-point has to happen before the delete —
    // the fake enforces that ordering rather than trusting the call list.
    assert.ok(
      world.order.indexOf('trialClaim.updateMany') < world.order.indexOf('user.delete'),
    );
  });

  it('refuses a fresh trial for the merged account that the source already used', async () => {
    const world = createMergeWorld();

    await world.merge();

    await assert.rejects(
      () => world.grantTrial('TGT'),
      (error: unknown) =>
        error instanceof BadRequestException && error.message === TRIAL_CLAIM_LIMIT_MESSAGE,
    );
    assert.equal(world.subscriptionCreates.length, 0);
    assert.equal(world.claims.length, 1);
  });

  it('still grants a trial to an unrelated identity after the merge', async () => {
    const world = createMergeWorld();

    await world.merge();
    const granted = await world.grantTrial('OTHER');

    // Guards the inverse mistake: the ledger must deny the merged identity,
    // not every user in the table.
    assert.equal(granted.subscriptionId, 'sub-1');
    assert.equal(world.claims.length, 2);
  });
});

interface ClaimRow {
  id: string;
  userId: string;
  planId: string | null;
  subscriptionId: string | null;
  source: TrialClaimSource;
  status: TrialClaimStatus;
  units: number;
  consumedAt: Date | null;
}

function createMergeWorld() {
  const claims: ClaimRow[] = [
    {
      id: 'claim-src',
      userId: 'SRC',
      planId: 'trial-plan',
      subscriptionId: 'sub-src',
      source: TrialClaimSource.FREE,
      status: TrialClaimStatus.CONSUMED,
      units: 1,
      consumedAt: new Date('2026-06-01T00:00:00.000Z'),
    },
  ];
  const subscriptionCreates: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  let sequence = 0;

  const noopUpdateMany = (model: string) => async () => {
    order.push(`${model}.updateMany`);
    return { count: 0 };
  };

  const users: Record<string, Record<string, unknown>> = {
    SRC: {
      id: 'SRC',
      telegramId: null,
      email: 'src@example.com',
      points: 0,
      personalDiscount: 0,
      purchaseDiscount: 0,
      maxSubscriptions: 1,
      acquisitionPlacementId: null,
      acquisitionAt: null,
      registrationIp: null,
      registrationUserAgent: null,
      registrationReferer: null,
      registrationUtm: null,
      registrationChannel: null,
      partner: null,
      webAccount: null,
      trialGrant: null,
    },
    TGT: {
      id: 'TGT',
      telegramId: null,
      email: null,
      points: 0,
      personalDiscount: 0,
      purchaseDiscount: 0,
      maxSubscriptions: 1,
      acquisitionPlacementId: null,
      acquisitionAt: null,
      registrationIp: null,
      registrationUserAgent: null,
      registrationReferer: null,
      registrationUtm: null,
      registrationChannel: null,
      partner: null,
      webAccount: null,
      trialGrant: null,
    },
  };

  const tx = {
    $queryRaw: async () => [{ id: 'locked-user' }],
    user: {
      findUnique: async (args: { where: { id: string } }) => users[args.where.id] ?? null,
      update: async () => ({ id: 'u' }),
      delete: async (args: { where: { id: string } }) => {
        // `TrialClaim.userId` is ON DELETE RESTRICT: a source that still owns
        // ledger rows cannot be removed.
        const blocking = claims.filter((claim) => claim.userId === args.where.id);
        if (blocking.length > 0) {
          throw new Error(
            'Foreign key constraint violated: trial_claims_user_id_fkey (RESTRICT)',
          );
        }
        order.push('user.delete');
        return { id: args.where.id };
      },
    },
    trialClaim: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string };
        data: { userId: string };
      }) => {
        order.push('trialClaim.updateMany');
        const matched = claims.filter((claim) => claim.userId === where.userId);
        for (const claim of matched) claim.userId = data.userId;
        return { count: matched.length };
      },
      aggregate: async (args: {
        where: { userId: string; status: { in: readonly TrialClaimStatus[] } };
      }) => ({
        _sum: {
          units: claims
            .filter(
              (claim) =>
                claim.userId === args.where.userId && args.where.status.in.includes(claim.status),
            )
            .reduce((total, claim) => total + claim.units, 0),
        },
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created: ClaimRow = {
          id: `claim-${++sequence}`,
          userId: String(data['userId']),
          planId: (data['planId'] as string | null) ?? null,
          subscriptionId: (data['subscriptionId'] as string | null) ?? null,
          source: data['source'] as TrialClaimSource,
          status: data['status'] as TrialClaimStatus,
          units: (data['units'] as number | undefined) ?? 1,
          consumedAt: (data['consumedAt'] as Date | undefined) ?? null,
        };
        claims.push(created);
        return created;
      },
    },
    subscription: {
      updateMany: noopUpdateMany('subscription'),
      findMany: async () => [],
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `sub-${subscriptionCreates.length + 1}`, ...data };
        subscriptionCreates.push(created);
        return created;
      },
    },
    transaction: { updateMany: noopUpdateMany('transaction') },
    referralReward: { updateMany: noopUpdateMany('referralReward') },
    // Unspent discount grants move with the customer: the source user is
    // deleted and the FK cascades, so a restricted grant would be destroyed.
    userPendingDiscount: { updateMany: noopUpdateMany('userPendingDiscount') },
    referralInvite: { updateMany: noopUpdateMany('referralInvite') },
    userNotificationEvent: { updateMany: noopUpdateMany('userNotificationEvent') },
    webPushSubscription: { updateMany: noopUpdateMany('webPushSubscription') },
    supportTicket: { updateMany: noopUpdateMany('supportTicket') },
    adClick: { updateMany: noopUpdateMany('adClick') },
    broadcastMessage: { updateMany: noopUpdateMany('broadcastMessage') },
    userOAuthLink: { updateMany: noopUpdateMany('userOAuthLink') },
    savedPaymentMethod: { updateMany: noopUpdateMany('savedPaymentMethod') },
    paymentMethodSetup: { updateMany: noopUpdateMany('paymentMethodSetup') },
    partnerWithdrawal: { updateMany: noopUpdateMany('partnerWithdrawal') },
    partnerTransaction: { updateMany: noopUpdateMany('partnerTransaction') },
    referralPointsExchange: {
      findMany: async () => [],
      updateMany: noopUpdateMany('referralPointsExchange'),
    },
    // Consents ride the same merge transaction; this spec is about the trial
    // ledger, so an empty pair is enough — but the delegate has to exist, or
    // the merge throws before it reaches anything this file asserts.
    userLegalConsent: {
      findMany: async () => [],
      update: async () => ({}),
      delete: async () => ({}),
    },
    promocodeActivation: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
      updateMany: noopUpdateMany('promocodeActivation'),
    },
    partnerReferral: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
      updateMany: noopUpdateMany('partnerReferral'),
    },
    questCompletion: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
      updateMany: noopUpdateMany('questCompletion'),
    },
    adConversion: {
      findFirst: async () => null,
      deleteMany: async () => ({ count: 0 }),
      updateMany: noopUpdateMany('adConversion'),
    },
    referral: {
      deleteMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      updateMany: noopUpdateMany('referral'),
    },
    partner: { update: async () => ({ id: 'p' }), delete: async () => ({ id: 'p' }) },
    trialGrant: {
      update: async () => ({ id: 't' }),
      delete: async () => ({ id: 't' }),
      upsert: async () => undefined,
    },
    webAccount: { update: async () => ({ id: 'w' }), delete: async () => ({ id: 'w' }) },
    profileSyncJob: { create: async () => ({ id: `sync-${++sequence}` }) },
  };

  const prisma = {
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>): Promise<T> =>
      callback(tx),
    plan: {
      findUnique: async () => ({
        id: 'trial-plan',
        name: 'Trial',
        type: 'BOTH',
        icon: null,
        trafficLimit: 10,
        deviceLimit: 1,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        tag: null,
        availability: PlanAvailability.TRIAL,
        trialSettings: { free: true, maxClaims: 1, availabilityScope: 'ALL' },
      }),
    },
    profileSyncJob: tx.profileSyncJob,
  };

  const mergeService = new AccountMergeService(
    prisma as unknown as PrismaService,
    { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
    { enqueue: async () => undefined } as never,
  );
  const mutationsService = new SubscriptionMutationsService(prisma as never, {
    enqueue: async () => undefined,
  } as never);

  return {
    claims,
    subscriptionCreates,
    order,
    merge: () =>
      mergeService.merge({
        sourceId: 'SRC',
        targetId: 'TGT',
        choices: {},
        confirm: true,
        actorAdminId: 'admin-1',
      }),
    grantTrial: (userId: string) =>
      mutationsService.grantTrial({ userId, planId: 'trial-plan', durationDays: 7 }),
  };
}
