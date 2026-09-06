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
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import type { SmtpSettingsInterface } from '../interfaces/email.interface';
import { EmailDeliveryService } from '../services/email-delivery.service';

// ── DTOs ────────────────────────────────────────────────────────────────────

class UpdateSmtpSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Deliver subscriber notifications by email too. Off unless asked for. */
  @IsOptional()
  @IsBoolean()
  notifyUsers?: boolean;

  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  fromAddress?: string;

  @IsOptional()
  @IsString()
  fromName?: string;

  @IsOptional()
  @IsBoolean()
  useTls?: boolean;

  @IsOptional()
  @IsBoolean()
  useSsl?: boolean;
}

class SendTestEmailDto {
  @IsEmail()
  to!: string;
}

// ── Controller ──────────────────────────────────────────────────────────────

/**
 * Admin email settings and test endpoints.
 *
 * Endpoints:
 *   GET  /admin/email/settings     — current SMTP config (password masked)
 *   POST /admin/email/settings     — update SMTP config
 *   POST /admin/email/verify       — verify SMTP connection
 *   POST /admin/email/test         — send a test email
 */
@ApiTags('admin/email')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('email', 'view')
@Controller('admin/email')
export class AdminEmailController {
  public constructor(
    private readonly emailDeliveryService: EmailDeliveryService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Get current SMTP settings (password masked)' })
  public async getSettings(): Promise<SmtpSettingsInterface & { passwordSet: boolean }> {
    const settings = await this.emailDeliveryService.getSmtpSettings();
    return {
      ...settings,
      password: null, // Never expose password
      passwordSet: !!settings.password,
    };
  }

  @Post('settings')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('email', 'edit')
  @ApiOperation({ summary: 'Update SMTP settings' })
  public async updateSettings(
    @Body() dto: UpdateSmtpSettingsDto,
  ): Promise<SmtpSettingsInterface & { passwordSet: boolean }> {
    const settings = await this.emailDeliveryService.saveSmtpSettings(dto);
    return {
      ...settings,
      password: null,
      passwordSet: !!settings.password,
    };
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('email', 'edit')
  @ApiOperation({ summary: 'Verify SMTP connection (does not send email)' })
  public async verify(): Promise<{ success: boolean; error?: string }> {
    return this.emailDeliveryService.verifyConnection();
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('email', 'edit')
  @ApiOperation({ summary: 'Send a test email to verify delivery' })
  public async sendTest(
    @Body() dto: SendTestEmailDto,
  ): Promise<{ success: boolean; error?: string }> {
    return this.emailDeliveryService.sendTest(dto.to);
  }
}
