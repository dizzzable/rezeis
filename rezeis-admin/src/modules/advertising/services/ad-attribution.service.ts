import { Injectable, Logger } from '@nestjs/common';
import { AdClickSurface } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PartnerEarningsService } from '../../partners/services/partner-earnings.service';
import { AdClickRecordInput } from '../interfaces/advertising.interface';
import { AdSignupBonusService } from './ad-signup-bonus.service';

/**
 * Ingests advertising clicks ("the bot/Mini-App was opened from a placement")
 * and sets the user's immutable first-touch attribution. For PARTNER placements
 * it also attaches the partner-referral chain so the existing commission engine
 * pays the partner — without that, a partner placement would be tracked but
 * never paid.
 *
 * Every method is best-effort: a failure is logged and swallowed so it can never
 * block the bot welcome flow or Mini-App load.
 */
@Injectable()
export class AdAttributionService {
  private readonly logger = new Logger(AdAttributionService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly partnerEarningsService: PartnerEarningsService,
    private readonly signupBonusService: AdSignupBonusService,
  ) {}

  public async recordClick(input: AdClickRecordInput): Promise<void> {
    try {
      const placement = await this.prismaService.adPlacement.findUnique({
        where: { trackingCode: input.code },
      });
      if (placement === null || placement.status !== 'ACTIVE') {
        // Unknown / inactive code — record nothing, fall through to normal flow.
        return;
      }

      const telegramId = parseTelegramId(input.telegramId);
      const userId = await this.resolveUserId(input.userId ?? null, telegramId);

      await this.prismaService.adClick.create({
        data: {
          placementId: placement.id,
          campaignId: placement.campaignId,
          telegramId,
          userId,
          surface: input.surface ?? AdClickSurface.BOT,
          isNewUser: input.isNewUser ?? false,
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          utmContent: input.utmContent,
          utmCreative: input.utmCreative,
        },
      });

      if (userId === null) {
        return;
      }

      // First-touch: set acquisition only when unset (atomic, immutable).
      const updated = await this.prismaService.user.updateMany({
        where: { id: userId, acquisitionPlacementId: null },
        data: { acquisitionPlacementId: placement.id, acquisitionAt: new Date() },
      });

      // Attach the partner-referral chain for PARTNER placements so commission
      // flows — only on first touch (when we actually claimed acquisition) and
      // never for the partner's own account (self-attribution guard).
      if (
        updated.count > 0 &&
        placement.ownerType === 'PARTNER' &&
        placement.partnerId !== null
      ) {
        await this.attachPartnerChain(placement.partnerId, userId);
      }

      // Grant the optional signup bonus to a brand-new user, once, on first
      // touch. Best-effort (the service swallows its own errors).
      if (updated.count > 0 && placement.signupBonusType !== 'NONE') {
        await this.signupBonusService.grantIfEligible({
          userId,
          bonusType: placement.signupBonusType,
          bonusJson: placement.signupBonus,
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        `ad click ingest failed (code=${input.code}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async resolveUserId(
    explicitUserId: string | null,
    telegramId: bigint | null,
  ): Promise<string | null> {
    if (explicitUserId !== null && explicitUserId.length > 0) {
      return explicitUserId;
    }
    if (telegramId === null) {
      return null;
    }
    const user = await this.prismaService.user.findUnique({
      where: { telegramId },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  private async attachPartnerChain(partnerId: string, newUserId: string): Promise<void> {
    const partner = await this.prismaService.partner.findUnique({
      where: { id: partnerId },
      select: { userId: true, isActive: true },
    });
    if (partner === null || !partner.isActive) {
      return;
    }
    if (partner.userId === newUserId) {
      // Self-attribution guard: a partner cannot acquire themselves.
      return;
    }
    await this.partnerEarningsService.attachPartnerReferralChain({
      newUserId,
      referrerUserId: partner.userId,
    });
  }
}

function parseTelegramId(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{1,19}$/.test(trimmed)) {
    return null;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}
