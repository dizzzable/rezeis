import type { PrismaService } from '../../src/common/prisma/prisma.service';

/**
 * Removes every row the durable add-on specs made for these users, in an order
 * the foreign keys allow: everything in the term model is `Restrict` on its
 * parent, an add-on entitlement is `Restrict` on its source transaction, and a
 * transaction on its user. Anonymous holders a full user deletion left behind
 * are passed in with the users.
 *
 * Deliberately scoped to the given users: these specs share one database with
 * every other PostgreSQL spec, and a cleanup that swept by table would delete
 * somebody else's fixtures.
 */
export async function removeDurableFixtures(
  prisma: PrismaService,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const users = [...userIds];
  const subscriptions = (
    await prisma.subscription.findMany({ where: { userId: { in: users } }, select: { id: true } })
  ).map((row) => row.id);
  const inSubscriptions = { subscriptionId: { in: subscriptions } };
  await prisma.entitlementIncident.deleteMany({ where: inSubscriptions });
  await prisma.addOnEntitlementEvent.deleteMany({ where: { entitlement: inSubscriptions } });
  await prisma.deviceReductionPlan.deleteMany({ where: inSubscriptions });
  await prisma.addOnEntitlement.deleteMany({ where: inSubscriptions });
  await prisma.subscriptionEffectiveProjection.deleteMany({ where: inSubscriptions });
  await prisma.subscriptionResetEpoch.deleteMany({ where: { term: inSubscriptions } });
  await prisma.subscriptionTerm.deleteMany({ where: inSubscriptions });
  await prisma.transactionItem.deleteMany({ where: inSubscriptions });
  await prisma.transaction.deleteMany({ where: { userId: { in: users } } });
  await prisma.subscription.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
}
