import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Whether a user arrived through an invite link — either the regular
 * referral graph (`Referral`) or the partner program (`PartnerReferral`).
 * Used by the `INVITED`-scoped trial guard so trials can be restricted to
 * users who signed up via a referral or partner link.
 *
 * The two edges are intentionally separate tables (the partner program
 * runs its own ledger), so an "invited" trial audience must check both.
 */
export async function isInvitedUser(
  prismaService: PrismaService,
  userId: string,
): Promise<boolean> {
  const [referralEdge, partnerEdge] = await Promise.all([
    prismaService.referral.findUnique({
      where: { referredId: userId },
      select: { id: true },
    }),
    prismaService.partnerReferral.findFirst({
      where: { referralUserId: userId },
      select: { id: true },
    }),
  ]);
  return referralEdge !== null || partnerEdge !== null;
}
