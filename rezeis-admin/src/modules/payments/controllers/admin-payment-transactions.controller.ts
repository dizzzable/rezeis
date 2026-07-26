import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { CreateTransactionDraftDto } from '../dto/create-transaction-draft.dto';
import { ListTransactionsQueryDto } from '../dto/list-transactions-query.dto';
import { RefundTransactionDto } from '../dto/refund-transaction.dto';
import { AdminPaymentTransactionInterface } from '../interfaces/admin-payment-transaction.interface';
import {
  PaymentRefundService,
  RefundEligibilityInterface,
  RefundResultInterface,
} from '../services/payment-refund.service';
import { PaymentsTransactionsService } from '../services/payments-transactions.service';

@Controller('admin/payments/transactions')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class AdminPaymentTransactionsController {
  public constructor(
    private readonly paymentsTransactionsService: PaymentsTransactionsService,
    private readonly paymentRefundService: PaymentRefundService,
  ) {}

  @Get()
  @RequirePermission('payments', 'view')
  public async listTransactions(
    @Query() query: ListTransactionsQueryDto,
  ): Promise<{ readonly items: readonly AdminPaymentTransactionInterface[]; readonly total: number }> {
    return this.paymentsTransactionsService.listTransactions(query);
  }

  @Post('draft')
  @RequirePermission('payments', 'create')
  public async createDraft(
    @Body() input: CreateTransactionDraftDto,
  ): Promise<AdminPaymentTransactionInterface> {
    return this.paymentsTransactionsService.createDraft(input);
  }

  /**
   * Whether this transaction can be refunded (and how much is left). Read-only,
   * so it rides on `payments:view` — the panel calls it to decide whether to
   * offer the refund control at all.
   */
  @Get(':transactionId/refund-eligibility')
  @RequirePermission('payments', 'view')
  public async getRefundEligibility(
    @Param('transactionId') transactionId: string,
  ): Promise<RefundEligibilityInterface> {
    return this.paymentRefundService.getEligibility(transactionId);
  }

  /**
   * Issues the refund at the provider. Gated on the dedicated `payments:refund`
   * permission — this moves real money and is not something a role with plain
   * transaction-edit rights should inherit.
   */
  @Post(':transactionId/refund')
  @RequirePermission('payments', 'refund')
  public async refundTransaction(
    @Param('transactionId') transactionId: string,
    @Body() input: RefundTransactionDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<RefundResultInterface> {
    return this.paymentRefundService.refundTransaction({
      transactionId,
      amount: input.amount ?? null,
      reason: input.reason ?? null,
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }
}
