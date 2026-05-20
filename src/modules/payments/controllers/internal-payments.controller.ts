import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { InternalPaymentCheckoutDto } from '../dto/internal-payment-checkout.dto';
import {
  InternalPaymentCheckoutInterface,
  InternalPaymentStatusInterface,
} from '../interfaces/internal-payment-checkout.interface';
import { PaymentsCheckoutService } from '../services/payments-checkout.service';

@Controller('internal/payments')
@UseGuards(InternalAdminAuthGuard)
export class InternalPaymentsController {
  public constructor(private readonly paymentsCheckoutService: PaymentsCheckoutService) {}

  @Post('checkout')
  public async checkout(
    @Body() input: InternalPaymentCheckoutDto,
  ): Promise<InternalPaymentCheckoutInterface> {
    return this.paymentsCheckoutService.checkout(input);
  }

  @Get(':paymentId')
  public async getStatus(
    @Param('paymentId') paymentId: string,
    @Query('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
  ): Promise<InternalPaymentStatusInterface> {
    return this.paymentsCheckoutService.getPaymentStatus({ paymentId, userId });
  }
}
