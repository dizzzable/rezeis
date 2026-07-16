/**
 * InternalUserPaymentMethodsController
 * ────────────────────────────────────
 * User-facing saved payment methods (list + self-service unbind + autopay toggle).
 *
 * YooKassa autopayments store `payment_method.id` after a successful payment
 * with `save_payment_method: true`. Merchants cannot delete the method on the
 * provider side — unbind only deactivates the local row so we stop charging it.
 * Autopay can also be disabled per method without unbinding (card stays listed).
 *
 * Auth: InternalAdminAuthGuard (Bearer token from api_tokens table).
 * Path: `/api/internal/user/:userRef/payment-methods`
 * `:userRef` is a reiwa_id (CUID) or a telegramId.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean } from 'class-validator';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SavedPaymentMethodService } from '../../payments/services/saved-payment-method.service';
import { buildUserReferenceWhere } from '../utils/user-reference.util';

class UpdatePaymentMethodAutopayDto {
  @IsBoolean()
  public autopayEnabled!: boolean;
}

@Controller('internal/user')
@UseGuards(InternalAdminAuthGuard)
export class InternalUserPaymentMethodsController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly savedPaymentMethodService: SavedPaymentMethodService,
  ) {}

  /**
   * Lists active saved payment methods for the user.
   *
   * Reiwa calls: `GET /api/internal/user/:userRef/payment-methods`
   */
  @Get(':userRef/payment-methods')
  public async listPaymentMethods(@Param('userRef') userRef: string) {
    const userId = await this.resolveUserId(userRef);
    return this.savedPaymentMethodService.listActiveForUser(userId);
  }

  /**
   * Soft-unbinds a saved payment method owned by the user.
   *
   * Reiwa calls: `DELETE /api/internal/user/:userRef/payment-methods/:methodId`
   */
  @Delete(':userRef/payment-methods/:methodId')
  @HttpCode(HttpStatus.OK)
  public async unbindPaymentMethod(
    @Param('userRef') userRef: string,
    @Param('methodId') methodId: string,
  ) {
    const userId = await this.resolveUserId(userRef);
    return this.savedPaymentMethodService.unbindForUser(userId, methodId);
  }

  /**
   * Enables/disables autopay for a bound method without unbinding.
   *
   * Reiwa calls: `PATCH /api/internal/user/:userRef/payment-methods/:methodId`
   * Body: `{ "autopayEnabled": boolean }`
   */
  @Patch(':userRef/payment-methods/:methodId')
  public async updatePaymentMethodAutopay(
    @Param('userRef') userRef: string,
    @Param('methodId') methodId: string,
    @Body() body: UpdatePaymentMethodAutopayDto,
  ) {
    const userId = await this.resolveUserId(userRef);
    return this.savedPaymentMethodService.setAutopayEnabledForUser(
      userId,
      methodId,
      body.autopayEnabled,
    );
  }

  private async resolveUserId(userRef: string): Promise<string> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    if (user === null) {
      throw new NotFoundException('User not found');
    }
    return user.id;
  }
}
