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
import type { SmtpEditorSettingsInterface } from '../interfaces/email.interface';
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

  /** `''` means "not set": letters then go out under `EMAIL_FROM_NAME` or the brand. */
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

type MaskedSmtpEditorSettings = SmtpEditorSettingsInterface & { passwordSet: boolean };

/** The password never leaves the panel; the card only learns whether one is set. */
function maskPassword(settings: SmtpEditorSettingsInterface): MaskedSmtpEditorSettings {
  return { ...settings, password: null, passwordSet: !!settings.password };
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

  // Both routes answer with the CARD's view (`getSmtpSettingsForEditor`): the
  // sender name as saved, `''` when none, never the effective one — the card
  // would put that into its field and save it back as a fixed name.
  @Get('settings')
  @ApiOperation({ summary: 'Get current SMTP settings (password masked)' })
  public async getSettings(): Promise<MaskedSmtpEditorSettings> {
    return maskPassword(await this.emailDeliveryService.getSmtpSettingsForEditor());
  }

  @Post('settings')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('email', 'edit')
  @ApiOperation({ summary: 'Update SMTP settings' })
  public async updateSettings(
    @Body() dto: UpdateSmtpSettingsDto,
  ): Promise<MaskedSmtpEditorSettings> {
    await this.emailDeliveryService.saveSmtpSettings(dto);
    return maskPassword(await this.emailDeliveryService.getSmtpSettingsForEditor());
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
