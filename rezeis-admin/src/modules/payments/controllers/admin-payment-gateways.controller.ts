import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { Currency, PaymentGatewayType } from '@prisma/client';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RbacService } from '../../rbac/services/rbac.service';
import { MovePaymentGatewayDto } from '../dto/move-payment-gateway.dto';
import { UpdatePaymentGatewayDto } from '../dto/update-payment-gateway.dto';
import { AdminPaymentGatewayInterface } from '../interfaces/admin-payment-gateway.interface';
import { PaymentGatewayRegistryService } from '../services/payment-gateway-registry.service';
import { GATEWAY_SUPPORTED_CURRENCIES } from '../utils/gateway-supported-currencies.util';

@Controller('admin/payments/gateways')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class AdminPaymentGatewaysController {
  public constructor(
    private readonly paymentGatewayRegistryService: PaymentGatewayRegistryService,
    private readonly rbacService: RbacService,
  ) {}

  /**
   * Whether this caller may see credentials in the clear.
   *
   * Checked here rather than with a second `@RequirePermission` because the
   * elevated permission must not gate the ENDPOINT — an operator holding only
   * `payment_gateways:view` has to keep listing and configuring gateways, just
   * with the secrets masked. `@RequirePermission` can only allow or refuse the
   * whole route, so the distinction lives in the response instead.
   */
  private async canRevealSecrets(admin: CurrentAdminInterface): Promise<boolean> {
    return this.rbacService.hasPermission(
      { id: admin.id, role: admin.role, rbacRoleId: admin.rbacRoleId ?? null },
      'payment_gateways',
      'view_secrets',
    );
  }

  @Get()
  @RequirePermission('payment_gateways', 'view')
  public async listGateways(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<readonly AdminPaymentGatewayInterface[]> {
    return this.paymentGatewayRegistryService.listGateways(await this.canRevealSecrets(admin));
  }

  /**
   * Returns the static map of currencies each gateway can issue checkouts in.
   * Cheap to compute (constant in code) but exposing it through the API
   * keeps the frontend list of supported currencies in sync with the
   * backend's validator without duplicating the table.
   */
  @Get('supported-currencies')
  @RequirePermission('payment_gateways', 'view')
  public getSupportedCurrencies(): Record<PaymentGatewayType, readonly Currency[]> {
    return GATEWAY_SUPPORTED_CURRENCIES;
  }

  @Get(':gatewayId')
  @RequirePermission('payment_gateways', 'view')
  public async getGateway(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Param('gatewayId') gatewayId: string,
  ): Promise<AdminPaymentGatewayInterface> {
    return this.paymentGatewayRegistryService.getGateway(
      gatewayId,
      await this.canRevealSecrets(admin),
    );
  }

  @Patch(':gatewayId')
  @RequirePermission('payment_gateways', 'edit')
  public async updateGateway(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Param('gatewayId') gatewayId: string,
    @Body() input: UpdatePaymentGatewayDto,
  ): Promise<AdminPaymentGatewayInterface> {
    // The echoed row follows the same rule as a read: `edit` alone does not
    // reveal what was just stored, so an operator cannot round-trip a save to
    // read out a credential they were never allowed to see.
    return this.paymentGatewayRegistryService.updateGateway(
      gatewayId,
      input,
      await this.canRevealSecrets(admin),
    );
  }

  @Patch(':gatewayId/move')
  @RequirePermission('payment_gateways', 'edit')
  public async moveGateway(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Param('gatewayId') gatewayId: string,
    @Body() input: MovePaymentGatewayDto,
  ): Promise<AdminPaymentGatewayInterface> {
    return this.paymentGatewayRegistryService.moveGateway(
      gatewayId,
      input.direction,
      await this.canRevealSecrets(admin),
    );
  }

  @Post('defaults')
  @RequirePermission('payment_gateways', 'edit')
  public async createDefaults(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<readonly AdminPaymentGatewayInterface[]> {
    return this.paymentGatewayRegistryService.createDefaults(await this.canRevealSecrets(admin));
  }
}
