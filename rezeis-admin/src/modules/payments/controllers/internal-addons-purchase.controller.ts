import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { InternalAddOnPurchaseDto } from '../dto/internal-addon-purchase.dto';
import { InternalPaymentCheckoutInterface } from '../interfaces/internal-payment-checkout.interface';
import { AddOnPurchaseService } from '../services/addon-purchase.service';

/**
 * Internal add-on purchase endpoint consumed by the reiwa user edge.
 * Creates a checkout for an extra-traffic / extra-devices top-up on an
 * existing subscription. Fulfillment (limit increment + Remnawave sync)
 * runs through the standard payment reconciliation pipeline once the
 * provider confirms payment.
 */
@ApiTags('internal/add-ons')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/add-ons')
export class InternalAddOnsPurchaseController {
  public constructor(private readonly addOnPurchaseService: AddOnPurchaseService) {}

  @Post('purchase')
  @ApiOperation({ summary: 'Create a checkout for an add-on top-up (reiwa edge)' })
  public purchase(
    @Body() input: InternalAddOnPurchaseDto,
  ): Promise<InternalPaymentCheckoutInterface> {
    return this.addOnPurchaseService.checkout({
      userId: input.userId,
      telegramId: input.telegramId,
      addOnId: input.addOnId,
      subscriptionId: input.subscriptionId,
      gatewayType: input.gatewayType,
      channel: input.channel,
      successUrl: input.successUrl ?? null,
      failUrl: input.failUrl ?? null,
      contractVersion: input.contractVersion,
      idempotencyKey: input.idempotencyKey,
      expectedAddOnRevision: input.expectedAddOnRevision,
    });
  }
}
