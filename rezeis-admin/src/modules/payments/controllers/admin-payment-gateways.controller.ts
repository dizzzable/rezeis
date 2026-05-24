import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { Currency, PaymentGatewayType } from '@prisma/client';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { MovePaymentGatewayDto } from '../dto/move-payment-gateway.dto';
import { UpdatePaymentGatewayDto } from '../dto/update-payment-gateway.dto';
import { AdminPaymentGatewayInterface } from '../interfaces/admin-payment-gateway.interface';
import { PaymentGatewayRegistryService } from '../services/payment-gateway-registry.service';
import { GATEWAY_SUPPORTED_CURRENCIES } from '../utils/gateway-supported-currencies.util';

@Controller('admin/payments/gateways')
@UseGuards(AdminJwtAuthGuard)
export class AdminPaymentGatewaysController {
  public constructor(
    private readonly paymentGatewayRegistryService: PaymentGatewayRegistryService,
  ) {}

  @Get()
  public async listGateways(): Promise<readonly AdminPaymentGatewayInterface[]> {
    return this.paymentGatewayRegistryService.listGateways();
  }

  /**
   * Returns the static map of currencies each gateway can issue checkouts in.
   * Cheap to compute (constant in code) but exposing it through the API
   * keeps the frontend list of supported currencies in sync with the
   * backend's validator without duplicating the table.
   */
  @Get('supported-currencies')
  public getSupportedCurrencies(): Record<PaymentGatewayType, readonly Currency[]> {
    return GATEWAY_SUPPORTED_CURRENCIES;
  }

  @Get(':gatewayId')
  public async getGateway(
    @Param('gatewayId') gatewayId: string,
  ): Promise<AdminPaymentGatewayInterface> {
    return this.paymentGatewayRegistryService.getGateway(gatewayId);
  }

  @Patch(':gatewayId')
  public async updateGateway(
    @Param('gatewayId') gatewayId: string,
    @Body() input: UpdatePaymentGatewayDto,
  ): Promise<AdminPaymentGatewayInterface> {
    return this.paymentGatewayRegistryService.updateGateway(gatewayId, input);
  }

  @Patch(':gatewayId/move')
  public async moveGateway(
    @Param('gatewayId') gatewayId: string,
    @Body() input: MovePaymentGatewayDto,
  ): Promise<AdminPaymentGatewayInterface> {
    return this.paymentGatewayRegistryService.moveGateway(gatewayId, input.direction);
  }

  @Post('defaults')
  public async createDefaults(): Promise<readonly AdminPaymentGatewayInterface[]> {
    return this.paymentGatewayRegistryService.createDefaults();
  }
}
