import { Controller, Get, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { PaymentReconciliationHealthInterface } from '../interfaces/payment-reconciliation-health.interface';
import { PaymentWebhookOpsService } from '../services/payment-webhook-ops.service';

@Controller('admin/payments/reconciliation')
@UseGuards(AdminJwtAuthGuard)
export class AdminPaymentReconciliationController {
  public constructor(
    private readonly paymentWebhookOpsService: PaymentWebhookOpsService,
  ) {}

  @Get('health')
  public async getHealth(): Promise<PaymentReconciliationHealthInterface> {
    return this.paymentWebhookOpsService.getReconciliationHealth();
  }
}
