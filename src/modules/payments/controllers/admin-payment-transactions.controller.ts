import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CreateTransactionDraftDto } from '../dto/create-transaction-draft.dto';
import { ListTransactionsQueryDto } from '../dto/list-transactions-query.dto';
import { AdminPaymentTransactionInterface } from '../interfaces/admin-payment-transaction.interface';
import { PaymentsTransactionsService } from '../services/payments-transactions.service';

@Controller('admin/payments/transactions')
@UseGuards(AdminJwtAuthGuard)
export class AdminPaymentTransactionsController {
  public constructor(
    private readonly paymentsTransactionsService: PaymentsTransactionsService,
  ) {}

  @Get()
  public async listTransactions(
    @Query() query: ListTransactionsQueryDto,
  ): Promise<{ readonly items: readonly AdminPaymentTransactionInterface[]; readonly total: number }> {
    return this.paymentsTransactionsService.listTransactions(query);
  }

  @Post('draft')
  public async createDraft(
    @Body() input: CreateTransactionDraftDto,
  ): Promise<AdminPaymentTransactionInterface> {
    return this.paymentsTransactionsService.createDraft(input);
  }
}
