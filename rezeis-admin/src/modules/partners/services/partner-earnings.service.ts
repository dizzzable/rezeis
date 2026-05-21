import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';

/**
 * Shape of `Settings.partnerSettings` JSON (donor: altshop partner_settings).
 */
interface PartnerSettingsJson {
  enabled?: boolean;
  /// Per-level percent: { LEVEL_1: number, LEVEL_2: number, LEVEL_3: number }
  levels?: Record<string, number>;
  /// Gateway commission percents: { YOOKASSA: number, HELEKET: number, ... }
  gatewayCommissions?: Record<string, number>;
  /// Whether to auto-subtract gateway commission before calculating earning.
  autoCalculateCommission?: boolean;
  /// Tax percent subtracted from net amount before partner percent.
  taxPercent?: number;
  /// Minimum withdrawal amount in minor units (kopecks).
  minWithdrawalAmount?: number;
}

/**
 * Per-partner individual settings stored as JSON on the Partner record.
 * When `useGlobalSettings` is true (default), the global PartnerSettingsJson
 * is used. Otherwise, the individual overrides take precedence.
 *
 * Donor: `PartnerIndividualSettingsDto`.
 */
interface PartnerIndividualSettings {
  useGlobalSettings?: boolean;
  accrualStrategy?: 'ON_EACH_PAYMENT' | 'ON_FIRST_PAYMENT';
  rewardType?: 'PERCENT' | 'FIXED_AMOUNT';
  level1Percent?: number | null;
  level2Percent?: number | null;
  level3Percent?: number | null;
  level1FixedAmount?: number | null;
  level2FixedAmount?: number | null;
  level3FixedAmount?: number | null;
}

interface ProcessPartnerEarningInput {
  readonly payerUserId: string;
  readonly paymentAmountMinorUnits: number;
  readonly gatewayType: string | null;
  readonly sourceTransactionId: string | null;
}

/**
 * Donor: `src/services/partner_earnings.py` + `partner_balance_ops.py`.
 *
 * Processes partner earnings after a completed payment. Walks the
 * `PartnerReferral` chain for the payer and credits each active partner's
 * balance proportionally to their level percent.
 *
 * The service is intentionally stateless — it reads settings and partner
 * chain from the database on every call so concurrent payments don't
 * conflict with stale in-memory state.
 */
@Injectable()
export class PartnerEarningsService {
  private readonly logger = new Logger(PartnerEarningsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
  ) {}

  /**
   * Main entry point — called by the payment reconciliation pipeline after
   * a transaction is marked COMPLETED.
   */
  public async processPartnerEarning(input: ProcessPartnerEarningInput): Promise<void> {
    const settings = await this.loadPartnerSettings();
    if (!settings.enabled) {
      return;
    }

    // Find all partner-referral edges where this payer is the referral user.
    const partnerChain = await this.prismaService.partnerReferral.findMany({
      where: { referralUserId: input.payerUserId },
      include: { partner: { select: { id: true, userId: true, balance: true, totalEarned: true, isActive: true } } },
      orderBy: { level: 'asc' },
    });

    if (partnerChain.length === 0) {
      return;
    }

    const gatewayCommission = this.resolveGatewayCommission(settings, input.gatewayType);

    for (const edge of partnerChain) {
      if (!edge.partner.isActive) {
        continue;
      }

      const levelKey = `LEVEL_${edge.level}`;
      const levelPercent = settings.levels?.[levelKey] ?? 0;
      if (levelPercent <= 0) {
        continue;
      }

      // Idempotency: skip if we already have a transaction for this partner + source
      if (input.sourceTransactionId !== null) {
        const existing = await this.prismaService.partnerTransaction.findFirst({
          where: {
            partnerId: edge.partnerId,
            sourceTransactionId: input.sourceTransactionId,
          },
          select: { id: true },
        });
        if (existing !== null) {
          this.logger.debug(
            `Partner ${edge.partnerId} already earned from transaction ${input.sourceTransactionId}`,
          );
          continue;
        }
      }

      const earning = this.calculateEarning({
        paymentAmount: input.paymentAmountMinorUnits,
        levelPercent,
        gatewayCommission,
        taxPercent: settings.taxPercent ?? 0,
        autoCalculateCommission: settings.autoCalculateCommission ?? false,
        individualSettings: null, // TODO: load from partner record when schema supports it
        level: edge.level,
      });

      if (earning <= 0) {
        continue;
      }

      // Create ledger entry + update partner balance atomically
      await this.prismaService.$transaction(async (tx) => {
        await tx.partnerTransaction.create({
          data: {
            partnerId: edge.partnerId,
            referralUserId: input.payerUserId,
            level: edge.level,
            paymentAmount: input.paymentAmountMinorUnits,
            percent: levelPercent,
            earnedAmount: earning,
            sourceTransactionId: input.sourceTransactionId,
            description: `Earning from L${edge.level} referral payment${input.gatewayType ? ` via ${input.gatewayType}` : ''}`,
          },
        });
        await tx.partner.update({
          where: { id: edge.partnerId },
          data: {
            balance: { increment: earning },
            totalEarned: { increment: earning },
          },
        });
      });

      this.logger.debug(
        `Partner ${edge.partnerId} earned ${earning} from payer ${input.payerUserId} (L${edge.level}, ${levelPercent}%)`,
      );

      // Emit partner earning event
      this.events.info(EVENT_TYPES.PARTNER_EARNING, 'PARTNER', `Partner earned ${earning} kopecks`, {
        partnerId: edge.partnerId,
        payerUserId: input.payerUserId,
        level: edge.level,
        percent: levelPercent,
        earning,
        gatewayType: input.gatewayType,
      });
    }
  }

  /**
   * Attaches the partner-referral chain when a new user registers through a
   * partner's referral code. Creates L1 edge for the direct partner, L2 for
   * the partner's parent, and L3 for the grandparent (if they exist and are
   * active).
   *
   * Donor: `partner_referrals.attach_partner_referral_chain`.
   */
  public async attachPartnerReferralChain(input: {
    readonly newUserId: string;
    readonly referrerUserId: string;
  }): Promise<boolean> {
    // L1: direct referrer must be an active partner
    const referrerPartner = await this.prismaService.partner.findUnique({
      where: { userId: input.referrerUserId },
      select: { id: true, isActive: true },
    });
    if (!referrerPartner || !referrerPartner.isActive) {
      return false;
    }

    await this.upsertPartnerReferral({
      partnerId: referrerPartner.id,
      referralUserId: input.newUserId,
      level: 1,
      parentPartnerId: null,
    });

    // L2: referrer's own partner-referral edge → that partner gets L2
    const referrerEdge = await this.prismaService.partnerReferral.findFirst({
      where: { referralUserId: input.referrerUserId },
      select: { partnerId: true, partner: { select: { id: true, isActive: true } } },
    });
    if (!referrerEdge || !referrerEdge.partner.isActive) {
      return true;
    }

    await this.upsertPartnerReferral({
      partnerId: referrerEdge.partnerId,
      referralUserId: input.newUserId,
      level: 2,
      parentPartnerId: referrerPartner.id,
    });

    // L3: L2 partner's own referral edge → that partner gets L3
    const l2User = await this.prismaService.partner.findUnique({
      where: { id: referrerEdge.partnerId },
      select: { userId: true },
    });
    if (!l2User) {
      return true;
    }
    const l2Edge = await this.prismaService.partnerReferral.findFirst({
      where: { referralUserId: l2User.userId },
      select: { partnerId: true, partner: { select: { id: true, isActive: true } } },
    });
    if (!l2Edge || !l2Edge.partner.isActive) {
      return true;
    }

    await this.upsertPartnerReferral({
      partnerId: l2Edge.partnerId,
      referralUserId: input.newUserId,
      level: 3,
      parentPartnerId: referrerEdge.partnerId,
    });

    return true;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async upsertPartnerReferral(input: {
    readonly partnerId: string;
    readonly referralUserId: string;
    readonly level: number;
    readonly parentPartnerId: string | null;
  }): Promise<void> {
    const existing = await this.prismaService.partnerReferral.findUnique({
      where: {
        partnerId_referralUserId: {
          partnerId: input.partnerId,
          referralUserId: input.referralUserId,
        },
      },
      select: { id: true },
    });
    if (existing !== null) {
      return;
    }
    await this.prismaService.partnerReferral.create({
      data: {
        partnerId: input.partnerId,
        referralUserId: input.referralUserId,
        level: input.level,
        parentPartnerId: input.parentPartnerId,
      },
    });
  }

  private calculateEarning(input: {
    readonly paymentAmount: number;
    readonly levelPercent: number;
    readonly gatewayCommission: number;
    readonly taxPercent: number;
    readonly autoCalculateCommission: boolean;
    readonly individualSettings: PartnerIndividualSettings | null;
    readonly level: number;
  }): number {
    const individual = input.individualSettings;

    // If individual settings exist and useGlobalSettings is false, check for
    // FIXED_AMOUNT reward type first (donor parity).
    if (individual && individual.useGlobalSettings === false) {
      if (individual.rewardType === 'FIXED_AMOUNT') {
        const fixedKey = `level${input.level}FixedAmount` as keyof PartnerIndividualSettings;
        const fixedAmount = individual[fixedKey] as number | null | undefined;
        if (fixedAmount !== null && fixedAmount !== undefined && fixedAmount > 0) {
          return fixedAmount;
        }
        // Fall through to percent-based if no fixed amount configured for this level
      }

      // Individual percent override
      const percentKey = `level${input.level}Percent` as keyof PartnerIndividualSettings;
      const individualPercent = individual[percentKey] as number | null | undefined;
      if (individualPercent !== null && individualPercent !== undefined && individualPercent > 0) {
        let netAmount = input.paymentAmount;
        if (input.autoCalculateCommission) {
          netAmount = netAmount * (100 - input.gatewayCommission) / 100;
          netAmount = netAmount * (100 - input.taxPercent) / 100;
        }
        return Math.max(0, Math.floor(netAmount * individualPercent / 100));
      }
    }

    // Global percent-based calculation (default path)
    let netAmount = input.paymentAmount;
    if (input.autoCalculateCommission) {
      netAmount = netAmount * (100 - input.gatewayCommission) / 100;
      netAmount = netAmount * (100 - input.taxPercent) / 100;
    }
    const earning = Math.floor(netAmount * input.levelPercent / 100);
    return Math.max(0, earning);
  }

  private resolveGatewayCommission(
    settings: PartnerSettingsJson,
    gatewayType: string | null,
  ): number {
    if (gatewayType === null || !settings.gatewayCommissions) {
      return 0;
    }
    return settings.gatewayCommissions[gatewayType] ?? 0;
  }

  private async loadPartnerSettings(): Promise<PartnerSettingsJson> {
    const row = await this.prismaService.settings.findFirst({
      select: { partnerSettings: true },
    });
    if (!row) {
      return {};
    }
    return row.partnerSettings as unknown as PartnerSettingsJson;
  }
}
