import {
  Prisma,
  TrialClaim,
  TrialClaimSource,
  TrialClaimStatus,
} from '@prisma/client';

import { TRIAL_CLAIM_LIMIT_MESSAGE } from '../../plans/utils/trial-settings.util';

type TrialClaimClient = Pick<Prisma.TransactionClient, 'trialClaim'>;
type TrialClaimCompatibilityClient = TrialClaimClient &
  Pick<Prisma.TransactionClient, 'trialGrant'>;
type TrialClaimLockClient = TrialClaimClient & Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Trial quota is global per user: every immutable CONSUMED unit and every
 * unresolved paid RESERVED unit counts against the requested plan's maxClaims.
 * RELEASED reservations no longer consume capacity.
 */
export async function countCommittedTrialClaimUnits(
  client: TrialClaimClient,
  userId: string,
  excludeTransactionId?: string,
): Promise<number> {
  const result = await client.trialClaim.aggregate({
    where: {
      userId,
      status: { in: [TrialClaimStatus.RESERVED, TrialClaimStatus.CONSUMED] },
      ...(excludeTransactionId === undefined
        ? {}
        : { transactionId: { not: excludeTransactionId } }),
    },
    _sum: { units: true },
  });
  return result._sum.units ?? 0;
}

/** Serialize free grants and paid reservations on the canonical user row. */
export async function lockTrialClaimUser(
  client: TrialClaimLockClient,
  userId: string,
): Promise<void> {
  const rows = await client.$queryRaw<readonly { readonly id: string }[]>(Prisma.sql`
    SELECT "id"
    FROM "users"
    WHERE "id" = ${userId}
    FOR UPDATE
  `);
  if (rows.length !== 1) {
    throw new Error('TRIAL_CLAIM_USER_NOT_FOUND');
  }
}

export function assertTrialClaimCapacity(currentUnits: number, maxClaims: number): void {
  if (currentUnits >= maxClaims) {
    throw new Error(TRIAL_CLAIM_LIMIT_MESSAGE);
  }
}

/**
 * Create or revive the single reservation bound to a payment draft. The caller
 * owns the per-user lock and capacity check. A CONSUMED claim is immutable and
 * is simply returned for an idempotent replay.
 */
export async function reservePaidTrialClaim(
  client: TrialClaimClient,
  input: {
    readonly userId: string;
    readonly planId: string | null;
    readonly transactionId: string;
    readonly now?: Date;
  },
): Promise<TrialClaim> {
  const existing = await client.trialClaim.findUnique({
    where: { transactionId: input.transactionId },
  });
  if (existing !== null) {
    if (
      existing.status === TrialClaimStatus.RESERVED ||
      existing.status === TrialClaimStatus.CONSUMED
    ) {
      return existing;
    }
    return client.trialClaim.update({
      where: { id: existing.id },
      data: {
        status: TrialClaimStatus.RESERVED,
        reservedAt: input.now ?? new Date(),
        releasedAt: null,
        releaseReason: null,
      },
    });
  }
  const now = input.now ?? new Date();
  return client.trialClaim.create({
    data: {
      userId: input.userId,
      planId: input.planId,
      transactionId: input.transactionId,
      source: TrialClaimSource.PAID,
      status: TrialClaimStatus.RESERVED,
      units: 1,
      reservedAt: now,
    },
  });
}

/**
 * Consume the transaction-bound reservation in the same database transaction
 * as subscription creation. Legacy captured drafts without a reservation get
 * a CONSUMED row and are never denied after money has been captured.
 */
export async function consumePaidTrialClaim(
  client: TrialClaimClient,
  input: {
    readonly userId: string;
    readonly planId: string | null;
    readonly transactionId: string;
    readonly subscriptionId: string;
    readonly now?: Date;
  },
): Promise<{ readonly claim: TrialClaim; readonly revivedReleased: boolean }> {
  const existing = await client.trialClaim.findUnique({
    where: { transactionId: input.transactionId },
  });
  if (existing?.status === TrialClaimStatus.CONSUMED) {
    return { claim: existing, revivedReleased: false };
  }
  const now = input.now ?? new Date();
  if (existing === null) {
    const claim = await client.trialClaim.create({
      data: {
        userId: input.userId,
        planId: input.planId,
        transactionId: input.transactionId,
        subscriptionId: input.subscriptionId,
        source: TrialClaimSource.PAID,
        status: TrialClaimStatus.CONSUMED,
        units: 1,
        consumedAt: now,
      },
    });
    return { claim, revivedReleased: false };
  }
  const revivedReleased = existing.status === TrialClaimStatus.RELEASED;
  const claim = await client.trialClaim.update({
    where: { id: existing.id },
    data: {
      status: TrialClaimStatus.CONSUMED,
      subscriptionId: input.subscriptionId,
      consumedAt: now,
      releasedAt: null,
      releaseReason: null,
    },
  });
  return { claim, revivedReleased };
}

/** Provider-terminal release. Local timeout callers must never invoke this. */
export async function releasePaidTrialClaim(
  client: TrialClaimClient,
  transactionId: string,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  const released = await client.trialClaim.updateMany({
    where: { transactionId, status: TrialClaimStatus.RESERVED },
    data: {
      status: TrialClaimStatus.RELEASED,
      releasedAt: now,
      releaseReason: reason,
    },
  });
  return released.count === 1;
}

/**
 * Idempotently records a trial subscription created by an importer or another
 * trusted legacy writer. The subscriptionId unique key prevents retries from
 * minting quota units; a later update to isTrial=false never removes history.
 */
export async function recordConsumedTrialSubscription(
  client: TrialClaimCompatibilityClient,
  input: {
    readonly userId: string;
    readonly planId: string | null;
    readonly subscriptionId: string;
    readonly source: TrialClaimSource;
    readonly consumedAt?: Date;
  },
): Promise<void> {
  const consumedAt = input.consumedAt ?? new Date();
  await client.trialClaim.upsert({
    where: { subscriptionId: input.subscriptionId },
    create: {
      userId: input.userId,
      planId: input.planId,
      subscriptionId: input.subscriptionId,
      source: input.source,
      status: TrialClaimStatus.CONSUMED,
      units: 1,
      consumedAt,
    },
    update: {},
  });
  await client.trialGrant.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, planId: input.planId, grantedAt: consumedAt },
    update: { planId: input.planId, grantedAt: consumedAt },
  });
}

/**
 * A donor's unavailable-trial marker proves at least one consumed trial even
 * when its current subscriptions were upgraded and no longer carry isTrial.
 * The caller owns the per-user lock. If a concrete subscription claim already
 * exists, it is stronger evidence and no synthetic unit is added.
 */
export async function recordConsumedLegacyTrialAvailability(
  client: TrialClaimClient,
  input: {
    readonly userId: string;
    readonly consumedAt?: Date;
  },
): Promise<void> {
  const existing = await client.trialClaim.findFirst({
    where: {
      userId: input.userId,
      status: TrialClaimStatus.CONSUMED,
    },
    select: { id: true },
  });
  if (existing !== null) return;

  const consumedAt = input.consumedAt ?? new Date();
  const id = `legacy-trial-unavailable:${input.userId}`;
  await client.trialClaim.upsert({
    where: { id },
    create: {
      id,
      userId: input.userId,
      planId: null,
      source: TrialClaimSource.LEGACY,
      status: TrialClaimStatus.CONSUMED,
      units: 1,
      consumedAt,
    },
    update: {},
  });
}
