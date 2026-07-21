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
