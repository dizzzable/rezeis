import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { MovePaymentGatewayDto } from '../dto/move-payment-gateway.dto';
import { UpdatePaymentGatewayDto } from '../dto/update-payment-gateway.dto';
import { AdminPaymentGatewayInterface } from '../interfaces/admin-payment-gateway.interface';
import { PaymentGatewayRegistryService } from '../services/payment-gateway-registry.service';

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
