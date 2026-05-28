import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { BotSigninConsumeDto } from '../dto/bot-signin-consume.dto';
import { BotSigninIssueDto } from '../dto/bot-signin-issue.dto';
import { WebAuthChangePasswordDto } from '../dto/web-auth-change-password.dto';
import { WebAuthLoginDto } from '../dto/web-auth-login.dto';
import { WebAuthRecoverDto } from '../dto/web-auth-recover.dto';
import { WebAuthRegisterDto } from '../dto/web-auth-register.dto';
import {
  WebAuthBotSigninConsumeResultInterface,
  WebAuthBotSigninIssueResultInterface,
  WebAuthChangePasswordResultInterface,
  WebAuthLoginResultInterface,
  WebAuthRecoverResultInterface,
  WebAuthRegisterResultInterface,
} from '../interfaces/web-auth.interface';
import { BotSigninTokenService } from '../services/bot-signin-token.service';
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
export class InternalWebAuthController {
  public constructor(
    private readonly webAuthService: WebAuthService,
    private readonly botSigninTokenService: BotSigninTokenService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a WebAccount + (optionally) link to existing Telegram User' })
  public register(@Body() body: WebAuthRegisterDto): Promise<WebAuthRegisterResultInterface> {
    return this.webAuthService.register(body);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify login + password and return session flags' })
  public login(@Body() body: WebAuthLoginDto): Promise<WebAuthLoginResultInterface> {
    return this.webAuthService.login(body);
  }

  @Post('recover')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve recovery channel for a login (telegram / email / none)' })
  public recover(@Body() body: WebAuthRecoverDto): Promise<WebAuthRecoverResultInterface> {
    return this.webAuthService.recover(body);
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
