import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import {
  LinkEmailInitiateDto,
  LinkEmailVerifyDto,
  LinkTelegramConsumeDto,
  LinkTelegramGenerateDto,
} from '../dto/linking.dto';
import {
  LinkEmailInitiateResultInterface,
  LinkEmailVerifyResultInterface,
  LinkTelegramConsumeResultInterface,
  LinkTelegramGenerateResultInterface,
} from '../interfaces/linking.interface';
import { LinkingService } from '../services/linking.service';

/**
 * InternalLinkingController
 * ─────────────────────────
 * Wires the opt-in identity-channel attachments for an existing
 * `reiwa_id`. Both Telegram and email flows funnel through the same
 * service so the wire is small and easy to audit.
 *
 * Path layout:
 *   - `link/telegram/generate`  — SPA settings → bot deeplink code.
 *   - `link/telegram/consume`   — bot → admin (called by reiwa-bot when
 *                                  the user enters the code).
 *   - `link/email/initiate`     — SPA settings → email OTP issuance.
 *   - `link/email/verify`       — SPA settings → consume OTP.
 */
@ApiTags('internal/link')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/link')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalLinkingController {
  public constructor(private readonly linkingService: LinkingService) {}

  @Post('telegram/generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a 6-digit code that the user types into the bot to attach Telegram' })
  public telegramGenerate(
    @Body() body: LinkTelegramGenerateDto,
  ): Promise<LinkTelegramGenerateResultInterface> {
    return this.linkingService.telegramGenerate(body);
  }

  @Post('telegram/consume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume the linking code on behalf of an incoming Telegram identity' })
  public telegramConsume(
    @Body() body: LinkTelegramConsumeDto,
  ): Promise<LinkTelegramConsumeResultInterface> {
    return this.linkingService.telegramConsume(body);
  }

  @Post('email/initiate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a verification code to a candidate email address' })
  public emailInitiate(
    @Body() body: LinkEmailInitiateDto,
  ): Promise<LinkEmailInitiateResultInterface> {
    return this.linkingService.emailInitiate(body);
  }

  @Post('email/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume the email verification code and stamp `email_verified_at`' })
  public emailVerify(
    @Body() body: LinkEmailVerifyDto,
  ): Promise<LinkEmailVerifyResultInterface> {
    return this.linkingService.emailVerify(body);
  }
}
