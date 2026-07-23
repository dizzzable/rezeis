import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { isWithinAttributionWindow } from '../utils/ad-attribution-window.util';

/** Minimal transaction shape the conversion hook needs. */
export interface AdConversionTransactionInput {
  readonly id: string;
  readonly userId: string;
  readonly amount: Prisma.Decimal | number | string;
  readonly currency: string;
  readonly completedAt: Date;
}

/**
 * Creates / reverts the first-purchase advertising conversion. Best-effort and
 * idempotent: it never blocks payment fulfillment, and a unique constraint on
 * `(userId)` / `(transactionId)` guarantees at most one conversion per user.
 */
@Injectable()
export class AdConversionService {
  private readonly logger = new Logger(AdConversionService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Attributes a completed purchase to the placement that acquired the payer,
   * when the purchase falls within the placement's attribution window. Only the
   * user's first such purchase is recorded (unique per user).
   */
  public async recordFirstPurchase(input: AdConversionTransactionInput): Promise<void> {
    try {
      const user = await this.prismaService.user.findUnique({
        where: { id: input.userId },
        select: { acquisitionPlacementId: true, acquisitionAt: true },
      });
      if (user === null || user.acquisitionPlacementId === null) {
        return; // organic — no advertising attribution.
      }

      const placement = await this.prismaService.adPlacement.findUnique({
        where: { id: user.acquisitionPlacementId },
        select: { id: true, campaignId: true, attributionWindowDays: true },
      });
      if (placement === null) {
        return;
      }

      if (
        !isWithinAttributionWindow(user.acquisitionAt, input.completedAt, placement.attributionWindowDays)
      ) {
        return; // outside the window → organic.
      }

      // Fetch utm from the originating click (best-effort; should always exist for attributed conversions).
      const click = await this.prismaService.adClick.findFirst({
        where: {
          placementId: placement.id,
          userId: input.userId,
        },
        select: {
          utmSource: true,
          utmMedium: true,
          utmCampaign: true,
          utmContent: true,
          utmCreative: true,
        },
      });

      const amountMinor = toMinorUnits(input.amount);

      // Idempotent create: unique on userId AND transactionId. A replay or a
      // second purchase is silently ignored (P0002 unique violation).
      await this.prismaService.adConversion.create({
        data: {
          placementId: placement.id,
          campaignId: placement.campaignId,
          userId: input.userId,
          transactionId: input.id,
          amount: amountMinor,
          currency: input.currency,
          status: 'ATTRIBUTED',
          occurredAt: input.completedAt,
          utmSource: click?.utmSource ?? null,
          utmMedium: click?.utmMedium ?? null,
          utmCampaign: click?.utmCampaign ?? null,
          utmContent: click?.utmContent ?? null,
          utmCreative: click?.utmCreative ?? null,
        },
      });
      this.logger.log(`Recorded ad conversion for placement ${placement.id} (tx ${input.id})`);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Already attributed (one conversion per user / transaction) — fine.
        return;
      }
      this.logger.warn(
        `ad conversion record failed (tx=${input.id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Reverts the conversion tied to a refunded/cancelled transaction so its
   * revenue stops counting. Idempotent (ATTRIBUTED → REVERTED only); a missing
   * conversion is a no-op.
   */
  public async revertConversion(transactionId: string): Promise<void> {
    try {
      await this.prismaService.adConversion.updateMany({
        where: { transactionId, status: 'ATTRIBUTED' },
        data: { status: 'REVERTED' },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `ad conversion revert failed (tx=${transactionId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Converts a major-unit amount (e.g. 299.50) into integer minor units. */
function toMinorUnits(amount: Prisma.Decimal | number | string): number {
  const major = typeof amount === 'number' ? amount : Number(amount.toString());
  if (!Number.isFinite(major)) {
    return 0;
  }
  return Math.round(major * 100);
}
