import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { TwoFactorDisableDto, TwoFactorVerifyDto } from '../dto/two-factor.dto';
import { TwoFactorService } from '../services/two-factor.service';

/**
 * Admin self-service surface for managing 2FA on their own account.
 *
 * Notes
 *   - Every endpoint is JWT-protected. The login flow itself uses
 *     dedicated public endpoints (see admin-auth.controller.ts).
 *   - We deliberately do NOT expose endpoints that let an admin manage
 *     2FA for a *different* admin — security factors are personal.
 */
@ApiTags('admin/2fa')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/2fa')
export class AdminTwoFactorController {
  public constructor(private readonly twoFactorService: TwoFactorService) {}

  @Get('status')
  @ApiOperation({ summary: 'Returns the 2FA status of the current admin' })
  public status(@CurrentAdmin() currentAdmin: CurrentAdminInterface) {
    return this.twoFactorService.getStatus(currentAdmin.id);
  }

  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Begins (or restarts) the 2FA enrollment, returning the OTP URI + recovery codes',
  })
  public enroll(@CurrentAdmin() currentAdmin: CurrentAdminInterface) {
    return this.twoFactorService.beginEnrollment(currentAdmin.id);
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirms a fresh enrollment by verifying the first code' })
  public confirm(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Body() dto: TwoFactorVerifyDto,
  ) {
    return this.twoFactorService.confirmEnrollment(currentAdmin.id, dto.code);
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turns off 2FA — requires a valid code (TOTP or recovery)' })
  public disable(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Body() dto: TwoFactorDisableDto,
  ) {
    return this.twoFactorService.disable(currentAdmin.id, dto.code);
  }

  @Post('recovery-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issues a fresh set of recovery codes' })
  public regenerateRecoveryCodes(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Body() dto: TwoFactorVerifyDto,
  ) {
    return this.twoFactorService
      .regenerateRecoveryCodes(currentAdmin.id, dto.code)
      .then((codes) => ({ recoveryCodes: codes }));
  }
}
