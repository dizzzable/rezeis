import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { BotSigninConsumeDto } from '../dto/bot-signin-consume.dto';
import { BotSigninIssueDto } from '../dto/bot-signin-issue.dto';
import { PasswordResetConsumeDto } from '../dto/password-reset-consume.dto';
import { PasswordResetFirstPasswordDto } from '../dto/password-reset-first-password.dto';
import { PasswordResetRequestDto } from '../dto/password-reset-request.dto';
import { PasswordResetSubscriptionDto } from '../dto/password-reset-subscription.dto';
import { PasswordResetTelegramDto } from '../dto/password-reset-telegram.dto';
import { PasswordResetTokenDto } from '../dto/password-reset-token.dto';
import { WebAuthChangePasswordDto } from '../dto/web-auth-change-password.dto';
import { WebAuthCheckLoginDto } from '../dto/web-auth-check-login.dto';
import { WebAuthClaimDto } from '../dto/web-auth-claim.dto';
import { WebAuthLoginDto } from '../dto/web-auth-login.dto';
import { WebAuthRecoverDto } from '../dto/web-auth-recover.dto';
import { WebAuthRegisterDto } from '../dto/web-auth-register.dto';
import { WebAuthTelegramClaimDto } from '../dto/web-auth-telegram-claim.dto';
import {
  PasswordResetConsumeResultInterface,
  PasswordResetFirstPasswordResultInterface,
  PasswordResetInspectResultInterface,
  PasswordResetRequestResultInterface,
  PasswordResetSubscriptionResultInterface,
  PasswordResetTelegramResultInterface,
  WebAuthBotSigninConsumeResultInterface,
  WebAuthBotSigninIssueResultInterface,
  WebAuthChangePasswordResultInterface,
  WebAuthLoginResultInterface,
  WebAuthRecoverResultInterface,
  WebAuthRegisterResultInterface,
  WebAuthTelegramClaimResultInterface,
} from '../interfaces/web-auth.interface';
import { BotSigninTokenService } from '../services/bot-signin-token.service';
import { PasswordResetService, type PasswordResetFacade } from '../services/password-reset.service';
import { WebAuthService } from '../services/web-auth.service';

/**
 * InternalWebAuthController
 * ─────────────────────────
 * Exposes the credential lifecycle reiwa drives from its SPA / Mini App.
 * Every endpoint returns a stable contract so the frontend can rely on
 * primitive `userId` strings without worrying about the underlying
 * Prisma surface area.
 *
 * `bot-signin/*` is the magic-link bridge for telegram-only users:
 * the bot issues a token tied to a `telegramId`, embeds it in the
 * cabinet URL, and reiwa-web's BFF consumes it on the way in to mint
 * a real WebSession cookie. Lets a user with no login/password reach
 * the cabinet without having to register first.
 */
@ApiTags('internal/web-auth')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/web-auth')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalWebAuthController {
  public constructor(
    private readonly webAuthService: WebAuthService,
    private readonly botSigninTokenService: BotSigninTokenService,
    @Inject(PasswordResetService) private readonly passwordResetService: PasswordResetFacade,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a WebAccount + (optionally) link to existing Telegram User' })
  public register(@Body() body: WebAuthRegisterDto): Promise<WebAuthRegisterResultInterface> {
    return this.webAuthService.register(body);
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Attach a WebAccount (login + password) to an existing User by reiwa_id',
    description:
      'Mandatory first-entry onboarding for Telegram-first users: links credentials to the caller\'s own existing User. Never creates a new User. 409 on existing web account / taken login.',
  })
  public claim(@Body() body: WebAuthClaimDto): Promise<WebAuthRegisterResultInterface> {
    return this.webAuthService.claim(body);
  }

  @Post('telegram-claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bind the current Telegram id to an existing web account (self-service)',
    description:
      "Mini App 'I already have an account' flow. Verifies login+password, then links the caller's Telegram id to that account when safe (free / same / empty-shell). Returns { status, userId? }: `linked` / `already_linked` re-mint the session; `needs_admin_merge` (the Telegram already owns an account with data) and `web_account_has_other_telegram` are typed refusals the BFF maps to 409.",
  })
  public telegramClaim(
    @Body() body: WebAuthTelegramClaimDto,
  ): Promise<WebAuthTelegramClaimResultInterface> {
    return this.webAuthService.telegramClaim(body);
  }

  @Post('check-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Non-mutating availability probe for a login',
    description:
      'Returns { available } without creating an account or consuming the registration rate limit. Used by the SPA register form for live feedback.',
  })
  public checkLogin(@Body() body: WebAuthCheckLoginDto): Promise<{ available: boolean }> {
    return this.webAuthService.checkLoginAvailable(body.login);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify login + password and return session flags' })
  public login(@Body() body: WebAuthLoginDto): Promise<WebAuthLoginResultInterface> {
    return this.webAuthService.login(body);
  }

  @Post('recover')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Legacy "forgot password": name the channel a login could recover through (telegram / email / none)',
    description:
      'Kept for cabinets up to 0.9.7.45 with the answers it always gave. Sends nothing — those cabinets have no page a reset link could open. Newer cabinets call password-reset/request.',
  })
  public recover(@Body() body: WebAuthRecoverDto): Promise<WebAuthRecoverResultInterface> {
    return this.passwordResetService.legacyRecover(body.login);
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a password-reset link to the account named by a login or a verified e-mail',
    description:
      'Answers before anything is sent. `method` is for logs; the cabinet shows every visitor the same message. `resetLinks: true` tells the cabinet this panel sends links.',
  })
  public requestPasswordReset(
    @Body() body: PasswordResetRequestDto,
  ): Promise<PasswordResetRequestResultInterface> {
    return this.passwordResetService.request({
      identifier: body.identifier,
      cabinetUrl: body.cabinetUrl ?? null,
    });
  }

  @Post('password-reset/inspect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Whether a reset link still works, and for which login. Spends nothing.' })
  public inspectPasswordReset(
    @Body() body: PasswordResetTokenDto,
  ): Promise<PasswordResetInspectResultInterface> {
    return this.passwordResetService.inspect(body.token);
  }

  @Post('password-reset/consume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Spend a reset link and set the new password',
    description: 'Single use. `ok` carries the userId the cabinet opens a session for.',
  })
  public consumePasswordReset(
    @Body() body: PasswordResetConsumeDto,
  ): Promise<PasswordResetConsumeResultInterface> {
    return this.passwordResetService.consume(body.token, body.password);
  }

  @Post('password-reset/telegram')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue a reset link for the Telegram user the bot is talking to',
    description: 'The bot sends it itself, behind a button on its own cabinet address.',
  })
  public issuePasswordResetForTelegram(
    @Body() body: PasswordResetTelegramDto,
  ): Promise<PasswordResetTelegramResultInterface> {
    return this.passwordResetService.issueForTelegram(body.telegramId);
  }

  @Post('password-reset/subscription')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recover by VPN subscription link, for an account with no Telegram and no verified e-mail',
    description:
      '`verified` carries a reset token; `sent_to_channels` means the account has a channel and got the ordinary link there; every failed verification is the same `mismatch`; `disabled` means the operator switched the path off (answered before any lookup).',
  })
  public recoverPasswordBySubscription(
    @Body() body: PasswordResetSubscriptionDto,
  ): Promise<PasswordResetSubscriptionResultInterface> {
    return this.passwordResetService.recoverBySubscription({
      link: body.link,
      login: body.login,
      clientIp: body.clientIp ?? null,
      cabinetUrl: body.cabinetUrl ?? null,
    });
  }

  @Post('password-reset/first-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'After a refused sign-in: send the reset link to an account that has no password yet',
    description:
      'For accounts imported without a password (`passwordBootstrapPending`). Sends the ordinary reset link through the same caps as password-reset/request; `not_applicable` for every other login, and the cabinet then shows its ordinary refusal.',
  })
  public sendFirstPasswordLink(
    @Body() body: PasswordResetFirstPasswordDto,
  ): Promise<PasswordResetFirstPasswordResultInterface> {
    return this.passwordResetService.sendFirstPasswordLink({
      login: body.login,
      cabinetUrl: body.cabinetUrl ?? null,
    });
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the password after verifying the current one' })
  public changePassword(
    @Body() body: WebAuthChangePasswordDto,
  ): Promise<WebAuthChangePasswordResultInterface> {
    return this.webAuthService.changePassword(body);
  }

  @Post('bot-signin/issue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue a one-time bot-signin token (5 min TTL) for a Telegram-bound user',
    description:
      'Reiwa-bot calls this when rendering the Cabinet URL button so the user lands in the SPA pre-authenticated. Returns null when the user can\'t be resolved or is blocked — caller falls back to a tokenless URL.',
  })
  public async issueBotSigninToken(
    @Body() body: BotSigninIssueDto,
  ): Promise<WebAuthBotSigninIssueResultInterface | { token: null; expiresAt: null }> {
    const result = await this.botSigninTokenService.issue(body.telegramId);
    if (result === null) {
      // Returning a typed null pair keeps the wire shape predictable
      // for the bot — it just looks at `token === null` to decide
      // whether to embed `?signin=...` in the URL.
      return { token: null, expiresAt: null };
    }
    return result;
  }

  @Post('bot-signin/consume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consume a bot-signin token and return the bound userId',
    description:
      'Single-use; second consume returns `{ userId: null }`. BFF should treat null as a 401 and redirect the SPA to /sign-in.',
  })
  public async consumeBotSigninToken(
    @Body() body: BotSigninConsumeDto,
  ): Promise<WebAuthBotSigninConsumeResultInterface> {
    const result = await this.botSigninTokenService.consume(body.token);
    return { userId: result?.userId ?? null };
  }
}
