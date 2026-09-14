import { Prisma, TransactionStatus } from '@prisma/client';

type TransactionUpdateManyClient = {
  readonly transaction: {
    updateMany(args: Prisma.TransactionUpdateManyArgs): Promise<Prisma.BatchPayload>;
  };
};

/**
 * Atomically reserves a pending transaction for immediate fulfillment.
 *
 * The durable `fulfilledAt` marker is the shared claim with webhook
 * reconciliation, so only one path can provision a payment.
 *
 * Returns the claim timestamp on success (use it to fence
 * {@link releaseFulfillmentClaim}); `null` when another path already claimed.
 */
export async function claimForImmediateFulfillment(
  prisma: TransactionUpdateManyClient,
  transactionId: string,
): Promise<Date | null> {
  const claimedAt = new Date();
  const claim = await prisma.transaction.updateMany({
    where: {
      id: transactionId,
      status: TransactionStatus.PENDING,
      fulfilledAt: null,
    },
    data: {
      status: TransactionStatus.COMPLETED,
      fulfilledAt: claimedAt,
    },
  });

  return claim.count === 1 ? claimedAt : null;
}

/**
 * Releases a failed fulfillment attempt so reconciliation can retry it.
 *
 * Fenced by the exact `claimedAt` returned from
 * {@link claimForImmediateFulfillment}: a delayed former claimant cannot
 * erase a newer lease after stale recovery reclaimed the row.
 */
export async function releaseFulfillmentClaim(
  prisma: TransactionUpdateManyClient,
  transactionId: string,
  claimedAt: Date,
): Promise<void> {
  await prisma.transaction.updateMany({
    where: {
      id: transactionId,
      fulfilledAt: claimedAt,
    },
    data: { fulfilledAt: null },
  });
}

/**
 * Pushes the sync jobs a fulfilment created, stopping at the first refusal, and
 * RETURNS that refusal instead of throwing it.
 *
 * Every fulfilling path still has work after this that must not depend on
 * Redis: the post-fulfilment hooks — referral rewards, partner earnings,
 * cashback, МойНалог, the ad conversion. An enqueue used to throw straight past
 * them, and nothing ever ran them later: the retry early-returns on the row
 * that is now COMPLETED and fulfilled, so the payment's side effects were
 * simply lost. The PENDING job rows are already durable and the profile-sync
 * sweep re-drives them, so the caller runs its hooks first and rethrows what
 * this returns afterwards — keeping the failure exactly as visible as before.
 */
export async function enqueueSyncJobsDeferringFailure(
  queue: { enqueue(syncJobId: string): Promise<void> },
  syncJobs: readonly { readonly id: string }[],
): Promise<{ readonly error: unknown } | null> {
  for (const syncJob of syncJobs) {
    try {
      await queue.enqueue(syncJob.id);
    } catch (error: unknown) {
      return { error };
    }
  }
  return null;
}
