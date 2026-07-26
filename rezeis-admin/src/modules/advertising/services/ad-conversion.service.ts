import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { FxRateService } from '../../fx/fx-rate.service';
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

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly fxRateService: FxRateService,
  ) {}

  /**
   * Attributes a completed purchase to the placement that acquired the payer,
   * when the purchase falls within the placement's attribution window. Only the
   * user's first such purchase is recorded (unique per user).
   */
  public async recordFirstPurchase(input: AdConversionTransactionInput): Promise<void> {
    try {
      const user = await this.prismaService.user.findUnique({
        where: { id: input.userId },
        select: {
          acquisitionPlacementId: true,
          acquisitionAt: true,
          acquisitionWindowDays: true,
        },
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

      // The window frozen at first touch, not today's value: widening it on the
      // placement used to turn old renewals into advertising revenue retroactively
      // (and narrowing it changed which past purchases counted), so reported
      // payback moved without a single new sale. Legacy rows fall back to the
      // placement.
      const windowDays = user.acquisitionWindowDays ?? placement.attributionWindowDays;
      if (!isWithinAttributionWindow(user.acquisitionAt, input.completedAt, windowDays)) {
        return; // outside the window → organic.
      }

      // A "first purchase" must be the user's first PAID one. Legacy attributions
      // (and any future path that bypasses the novelty gate) can point an existing
      // paying customer at a placement, and then their next renewal would be
      // recorded as that placement's conversion — revenue the advertisement never
      // earned.
      //
      // `amount > 0` matters: the platform creates COMPLETED transactions worth 0
      // itself (a 100% promo code, a free add-on, a balance-funded purchase), and
      // this same patch treats those as "no money moved" everywhere else. Counting
      // one as an earlier purchase would reject not just this conversion but every
      // future one for that user — `recordFirstPurchase` runs only from the
      // fulfilment hook, so there is no replay to recover from.
      const earlierPurchase = await this.prismaService.transaction.findFirst({
        where: {
          userId: input.userId,
          status: 'COMPLETED',
          amount: { gt: 0 },
          id: { not: input.id },
          createdAt: { lt: user.acquisitionAt ?? input.completedAt },
        },
        select: { id: true },
      });
      if (earlierPurchase !== null) {
        this.logger.log(
          `ad conversion skipped (tx=${input.id}): user ${input.userId} already paid before the advertising touch`,
        );
        return;
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
      // Convert now, at the rate that holds now, and store it. `toMinorUnits`
      // multiplies by 100, which is right for two-decimal fiat and destroys a
      // crypto amount (0.004 BTC → 0), so the base figure is derived from the
      // original decimal instead. Reports read `amountBase` and therefore never
      // add different currencies together, and a rate change tomorrow cannot
      // rewrite yesterday's payback.
      const converted = await this.fxRateService.toBaseMinor(input.amount, input.currency);
      if (converted === null) {
        this.logger.warn(
          `ad conversion recorded without a base amount (tx=${input.id}, currency=${input.currency}): no rate available`,
        );
      }

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
          amountBase: converted?.amountBaseMinor ?? null,
          baseCurrency: converted === null ? null : this.fxRateService.getBaseCurrency(),
          fxRate: converted === null ? null : new Prisma.Decimal(converted.rate.toFixed(12)),
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
