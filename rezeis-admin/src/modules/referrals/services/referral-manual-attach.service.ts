import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { PartnerEarningsService } from '../../partners/services/partner-earnings.service';
import { ReferralQualificationService } from './referral-qualification.service';

export interface ManualAttachResult {
  readonly referralCreated: boolean;
  readonly partnerChainAttached: boolean;
  readonly historicalPaymentsProcessed: number;
}

/**
 * Manual referral attachment with historical payment replay.
 *
 * Donor: `referral_rewards.attach_referrer_manually`.
 *
 * Use case: admin manually links a user to a referrer after the fact
 * (e.g. the user forgot to use the invite link). The service:
 *   1. Creates the Referral edge.
 *   2. Attaches the partner referral chain (L1/L2/L3).
 *   3. Replays all historical completed payments — qualifying the referral
 *      and crediting partner earnings for each.
 */
@Injectable()
export class ReferralManualAttachService {
  private readonly logger = new Logger(ReferralManualAttachService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly qualificationService: ReferralQualificationService,
    private readonly partnerEarningsService: PartnerEarningsService,
    private readonly events: SystemEventsService,
  ) {}

  /**
   * Manually attaches a referrer to a user and replays historical payments.
   *
   * @throws BadRequestException if the user already has a referral or is the same as referrer.
   */
  public async attachReferrerManually(input: {
    readonly userId: string;
    readonly referrerId: string;
  }): Promise<ManualAttachResult> {
    if (input.userId === input.referrerId) {
      throw new BadRequestException('Cannot attach a user as their own referrer');
    }

    // Verify both users exist
    const [user, referrer] = await Promise.all([
      this.prismaService.user.findUnique({ where: { id: input.userId }, select: { id: true } }),
      this.prismaService.user.findUnique({ where: { id: input.referrerId }, select: { id: true } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    if (!referrer) throw new NotFoundException('Referrer not found');

    // Check no existing referral
    const existingReferral = await this.prismaService.referral.findUnique({
      where: { referredId: input.userId },
      select: { id: true },
    });
    if (existingReferral) {
      throw new BadRequestException('User already has a referral attribution');
    }

    // Check no existing partner attribution
    const existingPartnerRef = await this.prismaService.partnerReferral.findFirst({
      where: { referralUserId: input.userId },
      select: { id: true },
    });
    if (existingPartnerRef) {
      throw new BadRequestException('User already has a partner attribution');
    }

    // 1. Create referral edge
    const referral = await this.prismaService.referral.create({
      data: {
        referrerId: input.referrerId,
        referredId: input.userId,
        level: 1,
        inviteSource: 'UNKNOWN',
      },
      select: { id: true },
    });

    // Notify the dev of the new referral edge (covers invite-link sign-ups and
    // admin manual attaches alike — the single creation chokepoint).
    this.events.info(EVENT_TYPES.REFERRAL_ATTACHED, 'REFERRAL', 'Referral attached', {
      referralId: referral.id,
      referrerId: input.referrerId,
      referredUserId: input.userId,
      userId: input.userId,
    });

    // 2. Attach partner referral chain
    const partnerChainAttached = await this.partnerEarningsService.attachPartnerReferralChain({
      newUserId: input.userId,
      referrerUserId: input.referrerId,
    });

    // 3. Replay historical completed payments
    const historicalTransactions = await this.prismaService.transaction.findMany({
      where: {
        userId: input.userId,
        status: TransactionStatus.COMPLETED,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, amount: true, gatewayType: true },
    });

    let historicalPaymentsProcessed = 0;
    for (const tx of historicalTransactions) {
      // Qualify referral (creates reward for referrer)
      await this.qualificationService.qualifyReferralAfterPurchase(tx.id);

      // Credit partner earnings
      await this.partnerEarningsService.processPartnerEarning({
        payerUserId: input.userId,
        paymentAmountMinorUnits: Number(tx.amount) * 100, // Decimal → minor units
        gatewayType: tx.gatewayType,
        sourceTransactionId: tx.id,
      });

      historicalPaymentsProcessed++;
    }

    this.logger.log(
      `Manual referral attach: ${input.referrerId} → ${input.userId}, ` +
      `partnerChain=${partnerChainAttached}, historicalPayments=${historicalPaymentsProcessed}`,
    );

    return {
      referralCreated: true,
      partnerChainAttached,
      historicalPaymentsProcessed,
    };
  }
}
