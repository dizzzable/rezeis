import { Injectable, Logger } from '@nestjs/common';
import { PartnerAccrualStrategy, PartnerRewardType, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { PartnerNotificationsService } from './partner-notifications.service';

/**
 * Shape of `Settings.partnerSettings` JSON (donor: altshop partner_settings).
 */
interface PartnerSettingsJson {
  enabled?: boolean;
  /// Per-level percent: { LEVEL_1: number, LEVEL_2: number, LEVEL_3: number }
  levels?: Record<string, number>;
  /// Per-level percent expressed as flat fields (donor parity / SPA payload).
  level1Percent?: number;
  level2Percent?: number;
  level3Percent?: number;
  /// Gateway commission percents: { YOOKASSA: number, HELEKET: number, ... }
  gatewayCommissions?: Record<string, number>;
  /// Whether to auto-subtract gateway commission before calculating earning.
  autoCalculateCommission?: boolean;
  /// Tax percent subtracted from net amount before partner percent.
  taxPercent?: number;
  /// Minimum withdrawal amount in minor units (kopecks).
  minWithdrawalAmount?: number;
  /// Global accrual strategy. Per-partner override on `Partner` row wins.
  accrualStrategy?: 'ON_EACH_PAYMENT' | 'ON_FIRST_PAYMENT';
  /// Flat per-gateway commissions also accepted at the top level.
  [k: string]: unknown;
}

/**
 * Subset of `Partner` columns relevant for earnings calculation. Mirrors the
 * per-partner override DTO described in `update-partner-settings.dto.ts`.
 */
interface PartnerWithIndividualSettings {
  readonly id: string;
  readonly userId: string;
  readonly balance: number;
  readonly totalEarned: number;
  readonly isActive: boolean;
  readonly useGlobalSettings: boolean;
  readonly accrualStrategy: PartnerAccrualStrategy;
  readonly rewardType: PartnerRewardType;
  readonly level1Percent: Prisma.Decimal | null;
  readonly level2Percent: Prisma.Decimal | null;
  readonly level3Percent: Prisma.Decimal | null;
  readonly level1FixedAmount: number | null;
  readonly level2FixedAmount: number | null;
  readonly level3FixedAmount: number | null;
}

interface ProcessPartnerEarningInput {
  readonly payerUserId: string;
  readonly paymentAmountMinorUnits: number;
  readonly gatewayType: string | null;
  readonly sourceTransactionId: string | null;
}

const PARTNER_FOR_EARNINGS_SELECT = {
  id: true,
  userId: true,
  balance: true,
  totalEarned: true,
  isActive: true,
  useGlobalSettings: true,
  accrualStrategy: true,
  rewardType: true,
  level1Percent: true,
  level2Percent: true,
  level3Percent: true,
  level1FixedAmount: true,
  level2FixedAmount: true,
  level3FixedAmount: true,
} as const;

/**
 * Donor: `src/services/partner_earnings.py` + `partner_balance_ops.py`.
 *
 * Processes partner earnings after a completed payment. Walks the
 * `PartnerReferral` chain for the payer and credits each active partner's
 * balance proportionally to their level percent — or to a fixed amount,
 * if the partner uses individual `FIXED` reward settings.
 *
 * The service is intentionally stateless — it reads settings and the
 * partner chain from the database on every call so concurrent payments
 * don't conflict with stale in-memory state.
 */
@Injectable()
export class PartnerEarningsService {
  private readonly logger = new Logger(PartnerEarningsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
    private readonly partnerNotificationsService: PartnerNotificationsService,
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
      include: { partner: { select: PARTNER_FOR_EARNINGS_SELECT } },
      orderBy: { level: 'asc' },
    });

    if (partnerChain.length === 0) {
      return;
    }

    const gatewayCommission = this.resolveGatewayCommission(settings, input.gatewayType);

    for (const edge of partnerChain) {
      const partner = edge.partner;
      if (!partner.isActive) {
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

      // Per-partner accrual strategy can short-circuit ON_FIRST_PAYMENT mode.
      const effectiveStrategy = this.resolveAccrualStrategy(partner, settings);
      if (effectiveStrategy === 'ON_FIRST_PAYMENT') {
        const previous = await this.prismaService.partnerTransaction.findFirst({
          where: {
            partnerId: edge.partnerId,
            referralUserId: input.payerUserId,
          },
          select: { id: true },
        });
        if (previous !== null) {
          this.logger.debug(
            `Partner ${edge.partnerId} already earned at least once from payer ${input.payerUserId} (ON_FIRST_PAYMENT)`,
          );
          continue;
        }
      }

      const calc = this.calculateEarning({
        paymentAmount: input.paymentAmountMinorUnits,
        gatewayCommission,
        taxPercent: settings.taxPercent ?? 0,
        autoCalculateCommission: settings.autoCalculateCommission ?? false,
        partner,
        settings,
        level: edge.level,
      });

      if (calc.amount <= 0) {
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
            percent: calc.percent,
            earnedAmount: calc.amount,
            sourceTransactionId: input.sourceTransactionId,
            description: this.formatDescription({
              level: edge.level,
              gatewayType: input.gatewayType,
              source: calc.source,
            }),
          },
        });
        await tx.partner.update({
          where: { id: edge.partnerId },
          data: {
            balance: { increment: calc.amount },
            totalEarned: { increment: calc.amount },
          },
        });
      });

      this.logger.debug(
        `Partner ${edge.partnerId} earned ${calc.amount} (${calc.source}) from payer ${input.payerUserId} (L${edge.level})`,
      );

      this.events.info(EVENT_TYPES.PARTNER_EARNING, 'PARTNER', `Partner earned ${calc.amount} kopecks`, {
        userId: partner.userId,
        partnerId: edge.partnerId,
        payerUserId: input.payerUserId,
        level: edge.level,
        percent: calc.percent.toString(),
        source: calc.source,
        earning: calc.amount,
        gatewayType: input.gatewayType,
        sourceTransactionId: input.sourceTransactionId,
      });

      await this.partnerNotificationsService.notifyEarning({
        partnerUserId: partner.userId,
        amount: calc.amount,
        level: edge.level,
        payerUserId: input.payerUserId,
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
    if (input.newUserId === input.referrerUserId) return false;

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
      select: { partnerId: true, partner: { select: { id: true, userId: true, isActive: true } } },
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
    const l2Edge = await this.prismaService.partnerReferral.findFirst({
      where: { referralUserId: referrerEdge.partner.userId },
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

  /**
   * Retroactively builds the partner referral chain for a newly-activated
   * partner. Iterates over their existing `Referral` graph (regular referral
   * edges where the user is the referrer) and reuses
   * `attachPartnerReferralChain` for each referred user.
   *
   * Idempotent: edges already present are skipped by the upsert.
   */
  public async backfillPartnerReferralChainForUser(referrerUserId: string): Promise<{
    readonly attached: number;
    readonly considered: number;
  }> {
    const partner = await this.prismaService.partner.findUnique({
      where: { userId: referrerUserId },
      select: { id: true, isActive: true },
    });
    if (!partner || !partner.isActive) {
      return { attached: 0, considered: 0 };
    }
    const referrals = await this.prismaService.referral.findMany({
      where: { referrerId: referrerUserId },
      select: { referredId: true },
    });
    let attached = 0;
    for (const referral of referrals) {
      const ok = await this.attachPartnerReferralChain({
        newUserId: referral.referredId,
        referrerUserId,
      });
      if (ok) attached += 1;
    }
    return { attached, considered: referrals.length };
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

  private resolveAccrualStrategy(
    partner: PartnerWithIndividualSettings,
    settings: PartnerSettingsJson,
  ): 'ON_EACH_PAYMENT' | 'ON_FIRST_PAYMENT' {
    if (!partner.useGlobalSettings) {
      return partner.accrualStrategy === PartnerAccrualStrategy.ONCE_PER_USER
        ? 'ON_FIRST_PAYMENT'
        : 'ON_EACH_PAYMENT';
    }
    return settings.accrualStrategy === 'ON_FIRST_PAYMENT' ? 'ON_FIRST_PAYMENT' : 'ON_EACH_PAYMENT';
  }

  private calculateEarning(input: {
    readonly paymentAmount: number;
    readonly gatewayCommission: number;
    readonly taxPercent: number;
    readonly autoCalculateCommission: boolean;
    readonly partner: PartnerWithIndividualSettings;
    readonly settings: PartnerSettingsJson;
    readonly level: number;
  }): {
    readonly amount: number;
    readonly percent: Prisma.Decimal;
    readonly source: 'global_percent' | 'individual_percent' | 'individual_fixed';
  } {
    const partner = input.partner;
    const useIndividual = !partner.useGlobalSettings;

    // FIXED reward: paid only via individual override.
    if (useIndividual && partner.rewardType === PartnerRewardType.FIXED) {
      const fixed = pickLevelFixed(partner, input.level);
      if (fixed !== null && fixed > 0) {
        return {
          amount: fixed,
          percent: new Prisma.Decimal(0),
          source: 'individual_fixed',
        };
      }
      // Fall through to percent if no fixed amount configured for this level.
    }

    const netAmount = input.autoCalculateCommission
      ? Math.max(
          0,
          (input.paymentAmount * (100 - input.gatewayCommission) * (100 - input.taxPercent)) /
            (100 * 100),
        )
      : input.paymentAmount;

    if (useIndividual) {
      const indPercent = pickLevelPercent(partner, input.level);
      // Honour an EXPLICIT individual percent — including 0% (this partner
      // earns nothing at this level). Only a `null` (unset) individual percent
      // falls back to the global rate; previously an explicit 0 was treated
      // like "unset" and wrongly paid the global percent instead.
      if (indPercent !== null) {
        const earned = indPercent.gt(0)
          ? Math.floor((netAmount * indPercent.toNumber()) / 100)
          : 0;
        return {
          amount: Math.max(0, earned),
          percent: indPercent,
          source: 'individual_percent',
        };
      }
    }

    const globalPercentValue = pickGlobalLevelPercent(input.settings, input.level);
    if (globalPercentValue <= 0) {
      return {
        amount: 0,
        percent: new Prisma.Decimal(0),
        source: 'global_percent',
      };
    }
    const globalPercent = new Prisma.Decimal(globalPercentValue);
    const earned = Math.floor((netAmount * globalPercentValue) / 100);
    return {
      amount: Math.max(0, earned),
      percent: globalPercent,
      source: 'global_percent',
    };
  }

  private resolveGatewayCommission(
    settings: PartnerSettingsJson,
    gatewayType: string | null,
  ): number {
    if (gatewayType === null) return 0;
    const map = settings.gatewayCommissions;
    if (map && typeof map === 'object') {
      const direct = map[gatewayType];
      if (typeof direct === 'number') return direct;
    }
    // Donor parity: settings may store flat fields like `yookassaCommission`.
    const flatKey = `${gatewayType.toLowerCase()}Commission`;
    const flatValue = settings[flatKey];
    return typeof flatValue === 'number' ? flatValue : 0;
  }

  private formatDescription(input: {
    readonly level: number;
    readonly gatewayType: string | null;
    readonly source: 'global_percent' | 'individual_percent' | 'individual_fixed';
  }): string {
    const sourceLabel =
      input.source === 'individual_fixed'
        ? 'fixed'
        : input.source === 'individual_percent'
          ? 'individual'
          : 'global';
    return input.gatewayType
      ? `L${input.level} ${sourceLabel} accrual via ${input.gatewayType}`
      : `L${input.level} ${sourceLabel} accrual`;
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

// ── Module-level helpers ────────────────────────────────────────────────────

function pickLevelPercent(
  partner: PartnerWithIndividualSettings,
  level: number,
): Prisma.Decimal | null {
  switch (level) {
    case 1:
      return partner.level1Percent;
    case 2:
      return partner.level2Percent;
    case 3:
      return partner.level3Percent;
    default:
      return null;
  }
}

function pickLevelFixed(
  partner: PartnerWithIndividualSettings,
  level: number,
): number | null {
  switch (level) {
    case 1:
      return partner.level1FixedAmount;
    case 2:
      return partner.level2FixedAmount;
    case 3:
      return partner.level3FixedAmount;
    default:
      return null;
  }
}

function pickGlobalLevelPercent(settings: PartnerSettingsJson, level: number): number {
  // Preferred: `levels: { LEVEL_1: ... }` map.
  const mapKey = `LEVEL_${level}`;
  const fromMap = settings.levels?.[mapKey];
  if (typeof fromMap === 'number' && fromMap > 0) return fromMap;

  // Legacy flat `level1Percent` fields (donor parity / SPA payload).
  const flatKey = `level${level}Percent` as const;
  const flat = settings[flatKey];
  return typeof flat === 'number' ? flat : 0;
}
