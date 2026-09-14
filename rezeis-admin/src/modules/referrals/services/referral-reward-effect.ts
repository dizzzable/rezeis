import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  PointsLedgerSource,
  Prisma,
  ReferralRewardType,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import {
  PointsMovementRefusal,
  PointsWalletService,
} from '../../points/services/points-wallet.service';

/** The reward row facts that decide what issuing it grants. */
export interface ReferralRewardToIssue {
  readonly id: string;
  readonly referralId: string;
  readonly userId: string;
  readonly type: ReferralRewardType;
  readonly amount: number;
}

/**
 * Why an effect was not applied. Every refusal leaves the transaction usable:
 * nothing reached PostgreSQL that failed, so the caller decides whether a
 * refusal aborts its work (the operator's «Выдать» — an error on screen) or
 * leaves the reward pending (the automatic path after a payment, which must
 * not undo the qualification it is part of).
 */
export type ReferralRewardEffectRefusal =
  | { readonly kind: 'EARNER_NOT_FOUND' }
  | { readonly kind: 'POINTS_ALREADY_CREDITED'; readonly walletReason: PointsMovementRefusal }
  | { readonly kind: 'NO_ACTIVE_FINITE_SUBSCRIPTION' };

export type ReferralRewardEffectOutcome =
  | { readonly applied: true; readonly syncJobId: string | null }
  | { readonly applied: false; readonly refusal: ReferralRewardEffectRefusal };

async function lockSubscription(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`,
  );
}

async function resolveActiveFiniteSubscription(
  tx: Prisma.TransactionClient,
  userId: string,
  currentSubscriptionId: string | null,
) {
  const fallback = await tx.subscription.findFirst({
    where: { userId, status: SubscriptionStatus.ACTIVE, expiresAt: { not: null } },
    select: { id: true },
    orderBy: [{ expiresAt: 'desc' }, { id: 'desc' }],
  });
  const candidateIds = Array.from(
    new Set(
      [currentSubscriptionId, fallback?.id ?? null].filter((id): id is string => id !== null),
    ),
  );

  for (const subscriptionId of candidateIds) {
    await lockSubscription(tx, subscriptionId);
    const subscription = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        status: true,
        remnawaveId: true,
      },
    });
    if (
      subscription !== null &&
      subscription.userId === userId &&
      subscription.status === SubscriptionStatus.ACTIVE &&
      subscription.expiresAt !== null
    ) {
      // A finite end date IS the eligibility rule for EXTRA_DAYS — a perpetual
      // subscription has nothing to extend. Re-attaching the checked value
      // carries that fact into the return type, so the caller cannot reach the
      // date arithmetic without it.
      return { ...subscription, expiresAt: subscription.expiresAt };
    }
  }
  return null;
}

/**
 * Apply the reward effect inside a Prisma transaction. THE ONLY implementation
 * of reward issuance in this repository, and it must stay that way.
 *
 * It has two callers and they differ only in what a refusal means: the
 * operator's «Выдать» (`AdminRewardsService.issue`, which turns a refusal into
 * the error it always showed — {@link referralRewardRefusalError}) and the
 * automatic issue right after a qualifying payment
 * (`ReferralQualificationService`, which leaves the reward pending). That is
 * why a refusal is RETURNED rather than thrown here: a throw inside the
 * payment's qualification transaction would roll the qualification back with
 * it, and a reward the inviter cannot receive yet is no reason to forget that
 * the friend paid.
 *
 * It used to cite a second one — the private effect block of
 * `ReferralQualificationService.issueReward` — as the model it mirrored. That
 * method had no caller anywhere in `src/`, and it had diverged on every point
 * that decides whether an `EXTRA_DAYS` reward actually reaches the customer:
 * it targeted `user.currentSubscriptionId` alone with no fallback and no lock,
 * it marked the reward ISSUED and granted nothing when there was no eligible
 * subscription, and it created no `ProfileSyncJob`. Pointing a reader at it was
 * pointing them at the broken half, so it was deleted rather than re-synced.
 */
export async function applyReferralRewardEffect(
  tx: Prisma.TransactionClient,
  wallet: PointsWalletService,
  reward: ReferralRewardToIssue,
): Promise<ReferralRewardEffectOutcome> {
  if (reward.type === ReferralRewardType.POINTS) {
    // Through the wallet, keyed on the reward: the ledger row is what the
    // earner sees as "+N for an invited friend", and the key is what makes a
    // re-driven issue a no-op instead of a second credit.
    const moved = await wallet.apply(tx, {
      userId: reward.userId,
      delta: reward.amount,
      source: PointsLedgerSource.REFERRAL_REWARD,
      referenceKey: reward.id,
      details: { rewardId: reward.id, referralId: reward.referralId },
    });
    if (!moved.applied) {
      if (moved.reason === 'USER_NOT_FOUND') {
        return { applied: false, refusal: { kind: 'EARNER_NOT_FOUND' } };
      }
      // DUPLICATE: a ledger row for this reward exists while the reward is not
      // marked issued. That state cannot be produced by this code — the row
      // and the mark commit together — so it is refused rather than papered
      // over with a second credit or a silent mark.
      return {
        applied: false,
        refusal: { kind: 'POINTS_ALREADY_CREDITED', walletReason: moved.reason },
      };
    }
    return { applied: true, syncJobId: null };
  }
  if (reward.type === ReferralRewardType.EXTRA_DAYS) {
    const user = await tx.user.findUnique({
      where: { id: reward.userId },
      select: { currentSubscriptionId: true },
    });
    const subscription = await resolveActiveFiniteSubscription(
      tx,
      reward.userId,
      user?.currentSubscriptionId ?? null,
    );
    if (subscription === null) {
      return { applied: false, refusal: { kind: 'NO_ACTIVE_FINITE_SUBSCRIPTION' } };
    }
    const newExpiresAt = new Date(
      Math.max(subscription.expiresAt.getTime(), Date.now()) + reward.amount * 24 * 60 * 60 * 1000,
    );
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { expiresAt: newExpiresAt },
    });
    // Push the extended expiry to Remnawave. Without this ProfileSyncJob the
    // extra days only live in the local DB and never reach the user's real VPN
    // profile ("дни выдались, только с задержкой" — the sync never fired).
    const syncJob = await tx.profileSyncJob.create({
      data: {
        subscriptionId: subscription.id,
        action: subscription.remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: {
          source: 'REFERRAL_EXTRA_DAYS_REWARD',
          userId: reward.userId,
          days: reward.amount,
          // Names the reward on the job, and so names the subscription these
          // days went to: the fallback above may pick a subscription that is
          // not `currentSubscriptionId`, and a refund has to take the days
          // back from the one that got them (`reverseReferralRewardEffect`).
          rewardId: reward.id,
        } as Prisma.InputJsonObject,
      },
    });
    return { applied: true, syncJobId: syncJob.id };
  }
  // TWO different failures reach this line, and they need two different guards.
  //
  // The COMPILER one: `refuseUnhandledRewardType` takes `never`, so this call
  // only type-checks while every `ReferralRewardType` member has been peeled off
  // above. Add a third member to the enum and `tsc -p tsconfig.json` fails HERE
  // — the developer who widened the type is made to decide what issuing it
  // grants, at build time, instead of shipping a branch that grants nothing.
  //
  // The RUNTIME one: `reward.type` is read out of a database column, and the
  // enum compiled into this process is only the compiler's BELIEF about that
  // column. A row written by an older or newer deployment, by a migration in
  // flight, or by hand carries whatever it carries, and no compile-time check
  // ever inspects it. So the same guard also THROWS, inside the transaction and
  // before the reward is marked issued, which rolls back the reward update, the
  // audit row and anything the effect had already written.
  //
  // What must never come back is a bare `applied: true` here. Both callers mark
  // the reward ISSUED on it, so an unhandled type would produce a row claiming
  // the customer had been paid with nothing granted — precisely the failure the
  // deleted second copy of this logic was deleted for. Refusing is the safe
  // direction: the operator sees an error and the reward stays payable.
  return refuseUnhandledRewardType(reward.type);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The subscription an issued EXTRA_DAYS reward extended.
 *
 * The sync job the issue created names it (`payload.rewardId`). Rewards issued
 * before that key existed fall back to the same order the issue resolves in —
 * `currentSubscriptionId`, then the newest ACTIVE finite subscription — which
 * is the best evidence left for them. The row is locked, and it must still
 * belong to the earner and still have an end date to move back.
 */
async function resolveExtendedSubscription(
  tx: Prisma.TransactionClient,
  reward: ReferralRewardToIssue,
) {
  const job = await tx.profileSyncJob.findFirst({
    where: { payload: { path: ['rewardId'], equals: reward.id } },
    select: { subscriptionId: true },
    orderBy: { createdAt: 'asc' },
  });
  let candidateIds: string[];
  if (job !== null) {
    candidateIds = [job.subscriptionId];
  } else {
    const user = await tx.user.findUnique({
      where: { id: reward.userId },
      select: { currentSubscriptionId: true },
    });
    const fallback = await tx.subscription.findFirst({
      where: { userId: reward.userId, status: SubscriptionStatus.ACTIVE, expiresAt: { not: null } },
      select: { id: true },
      orderBy: [{ expiresAt: 'desc' }, { id: 'desc' }],
    });
    candidateIds = Array.from(
      new Set(
        [user?.currentSubscriptionId ?? null, fallback?.id ?? null].filter(
          (id): id is string => id !== null,
        ),
      ),
    );
  }

  for (const subscriptionId of candidateIds) {
    await lockSubscription(tx, subscriptionId);
    const subscription = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, userId: true, expiresAt: true, status: true, remnawaveId: true },
    });
    if (
      subscription !== null &&
      subscription.userId === reward.userId &&
      subscription.status !== SubscriptionStatus.DELETED &&
      subscription.expiresAt !== null
    ) {
      return { ...subscription, expiresAt: subscription.expiresAt };
    }
  }
  return null;
}

/**
 * Takes back what {@link applyReferralRewardEffect} granted, for a refund or a
 * chargeback of the payment that earned the reward. The mirror of the issue,
 * kept next to it so the two cannot drift apart again: the reversal used to
 * live in `ReferralQualificationService`, subtracted the days from
 * `currentSubscriptionId` whatever subscription had received them, and created
 * no sync job — so every refund left the inviter's Remnawave profile extended.
 * While rewards waited for a manual «Выдать» that path was rare; issued
 * automatically, every refunded EXTRA_DAYS reward reaches it.
 *
 * POINTS: floored, through the wallet. This used to be a bare `decrement` with
 * no floor, and a referrer who had already spent the payout was driven
 * negative. The money has gone back to the payer; what the referrer still
 * holds is taken, the rest is recorded as shortfall on the ledger row, and the
 * balance stops at zero. The wallet's answer is not inspected on purpose:
 * DUPLICATE means an earlier replay already reversed this reward, and
 * USER_NOT_FOUND means the referrer is gone — neither is a reason to abort the
 * rest of the reversal.
 *
 * EXTRA_DAYS: the extended subscription loses the days and gets an UPDATE sync
 * job, returned for the caller to enqueue after commit. A subscription with no
 * remote profile has nothing to push; one that cannot be found any more
 * (deleted, perpetual, handed to someone else) keeps nothing to take back.
 */
export async function reverseReferralRewardEffect(
  tx: Prisma.TransactionClient,
  wallet: PointsWalletService,
  reward: ReferralRewardToIssue,
  context: { readonly transactionId: string },
): Promise<{ readonly syncJobId: string | null }> {
  if (reward.type === ReferralRewardType.POINTS) {
    await wallet.apply(tx, {
      userId: reward.userId,
      delta: -reward.amount,
      source: PointsLedgerSource.REFERRAL_REWARD_REVOKED,
      referenceKey: reward.id,
      shortfall: 'floor',
      details: {
        rewardId: reward.id,
        referralId: reward.referralId,
        transactionId: context.transactionId,
      },
    });
    return { syncJobId: null };
  }
  if (reward.type === ReferralRewardType.EXTRA_DAYS) {
    const subscription = await resolveExtendedSubscription(tx, reward);
    if (subscription === null) return { syncJobId: null };
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { expiresAt: new Date(subscription.expiresAt.getTime() - reward.amount * DAY_MS) },
    });
    if (subscription.remnawaveId === null) return { syncJobId: null };
    const syncJob = await tx.profileSyncJob.create({
      data: {
        subscriptionId: subscription.id,
        action: SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: {
          source: 'REFERRAL_EXTRA_DAYS_REWARD_REVOKED',
          userId: reward.userId,
          days: -reward.amount,
          rewardId: reward.id,
          transactionId: context.transactionId,
        } as Prisma.InputJsonObject,
      },
    });
    return { syncJobId: syncJob.id };
  }
  // Unreachable for a reward that was issued: the issue refuses a type it has
  // no branch for, so such a reward is never marked issued. Same two-halved
  // guard as the issue.
  return refuseUnhandledRewardType(reward.type);
}

/**
 * The error the operator's «Выдать» has always answered a refusal with — the
 * same classes and the same words as when the effect threw them itself, so the
 * rewards table and `bulkIssue`'s `errors` array read exactly as before.
 */
export function referralRewardRefusalError(
  reward: Pick<ReferralRewardToIssue, 'id'>,
  refusal: ReferralRewardEffectRefusal,
): NotFoundException | BadRequestException {
  switch (refusal.kind) {
    case 'EARNER_NOT_FOUND':
      return new NotFoundException('Cannot issue POINTS reward: the earner no longer exists');
    case 'POINTS_ALREADY_CREDITED':
      return new BadRequestException(
        `Cannot issue POINTS reward ${reward.id}: the points were already credited (${refusal.walletReason})`,
      );
    case 'NO_ACTIVE_FINITE_SUBSCRIPTION':
      return new BadRequestException(
        'Cannot issue EXTRA_DAYS reward: user has no finite active subscription. ' +
          'Grant once an eligible subscription exists, or convert to POINTS.',
      );
  }
}

/**
 * The `never` parameter is the compile-time half of the guard above: passing
 * anything that is not provably impossible is a type error at the call site.
 * The throw is the runtime half, for a `type` column that no longer matches the
 * enum. `BadRequestException` rather than a bare `Error` on purpose — Nest
 * hides a 500's message, and this one names the offending value, which is the
 * only thing that tells an operator (and `bulkIssue`'s `errors` array) what is
 * wrong with that reward.
 */
function refuseUnhandledRewardType(type: never): never {
  throw new BadRequestException(
    `Cannot issue reward: reward type "${String(type)}" has no issuance branch in ` +
      'applyReferralRewardEffect. Nothing was granted and the reward is still unissued.',
  );
}
