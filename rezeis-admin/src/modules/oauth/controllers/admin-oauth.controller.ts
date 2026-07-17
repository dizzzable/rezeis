import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthProviderType } from '@prisma/client';
import { Request, Response } from 'express';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  AuthProviderConfigInterface,
  OAuthLoginResult,
  PublicProviderInfo,
} from '../interfaces/oauth-provider.interface';
import { CryptoService } from '../services/crypto.service';
import { GitHubAuthService } from '../services/github-auth.service';
import { OAuthConfigService } from '../services/oauth-config.service';
import { OAuthLoginService } from '../services/oauth-login.service';
import { TelegramAuthService } from '../services/telegram-auth.service';
import { Public } from '../../../common/decorators/public.decorator';

// ── Public endpoints (no JWT required) ───────────────────────────────────────

@Controller('admin/oauth')
@Public()
export class OAuthPublicController {
  public constructor(
    private readonly configService: OAuthConfigService,
    private readonly telegramAuth: TelegramAuthService,
    private readonly githubAuth: GitHubAuthService,
    private readonly loginService: OAuthLoginService,
  ) {}

  /**
   * Returns enabled providers for the login page.
   */
  @Get('providers')
  public async getProviders(): Promise<PublicProviderInfo[]> {
    return this.configService.getEnabledProviders();
  }

  /**
   * Telegram Login Widget callback.
   * Receives signed data from the widget and verifies it.
   */
  @Post('telegram/login')
  public async telegramLogin(
    @Body() data: Record<string, string>,
  ): Promise<OAuthLoginResult> {
    const profile = await this.telegramAuth.verifyTelegramLogin(data);
    return this.loginService.processOAuthLogin(profile);
  }

  /**
   * GitHub OAuth2: redirect to GitHub authorization page.
   */
  @Get('github/authorize')
  public async githubAuthorize(
    @Res() res: Response,
  ): Promise<void> {
    // Generate cryptographically random state for CSRF protection
    const { randomBytes } = await import('node:crypto');
    const state = randomBytes(16).toString('hex');
    // Store state in a short-lived cookie for validation in callback
    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 300_000, // 5 minutes
      path: '/api/admin/oauth/github',
    });
    const url = await this.githubAuth.getAuthorizationUrl(state);
    res.redirect(url);
  }

  /**
   * GitHub OAuth2: callback from GitHub after user authorizes.
   */
  @Get('github/callback')
  public async githubCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Validate CSRF state
    const storedState = req.cookies?.['oauth_state'];
    if (!state || !storedState || state !== storedState) {
      res.clearCookie('oauth_state', { path: '/api/admin/oauth/github' });
      res.status(403).send('Invalid OAuth state — possible CSRF attack');
      return;
    }
    res.clearCookie('oauth_state', { path: '/api/admin/oauth/github' });

    const profile = await this.githubAuth.handleCallback(code);
    const result = await this.loginService.processOAuthLogin(profile);
    // Use hash fragment — NOT query param — so token is never sent to server/logged
    res.redirect(`/#oauth_token=${result.accessToken}`);
  }
}

// ── Admin-only endpoints (JWT required) ──────────────────────────────────────

@Controller('admin/oauth/config')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class OAuthConfigController {
  public constructor(
    private readonly configService: OAuthConfigService,
    private readonly cryptoService: CryptoService,
  ) {}

  /**
   * Returns all provider configurations (admin view).
   */
  @Get()
  @RequirePermission('auth_providers', 'view')
  public async getAllConfigs(): Promise<AuthProviderConfigInterface[]> {
    return this.configService.getAllConfigs();
  }

  /**
   * Updates a provider configuration.
   */
  @Put(':type')
  @RequirePermission('auth_providers', 'edit')
  public async updateConfig(
    @Param('type') type: AuthProviderType,
    @Body() body: UpdateProviderConfigDto,
  ): Promise<AuthProviderConfigInterface> {
    // Encrypt client secret if provided
    const data: Record<string, unknown> = { ...body };
    if (body.clientSecret !== undefined && body.clientSecret !== null) {
      data['clientSecretEnc'] = this.cryptoService.encrypt(body.clientSecret);
      delete data['clientSecret'];
    } else {
      delete data['clientSecret'];
    }

    return this.configService.updateConfig(type, data as Parameters<typeof this.configService.updateConfig>[1]);
  }
}

// ── Linked accounts management (JWT required) ────────────────────────────────

@Controller('admin/oauth/links')
@UseGuards(AdminJwtAuthGuard)
export class OAuthLinksController {
  public constructor(private readonly loginService: OAuthLoginService) {}

  /**
   * Returns linked OAuth providers for the current admin.
   */
  @Get()
  public async getLinkedProviders(@Req() req: Request) {
    const admin = req.user as { id: string };
    return this.loginService.getLinkedProviders(admin.id);
  }

  /**
   * Unlinks a provider from the current admin.
   */
  @Delete(':type')
  public async unlinkProvider(
    @Req() req: Request,
    @Param('type') type: AuthProviderType,
  ) {
    const admin = req.user as { id: string };
    await this.loginService.unlinkProvider(admin.id, type);
    return { ok: true };
  }
}

// ── DTO ──────────────────────────────────────────────────────────────────────

interface UpdateProviderConfigDto {
  isEnabled?: boolean;
  displayName?: string;
  clientId?: string | null;
  clientSecret?: string | null;
  frontendDomain?: string | null;
  backendDomain?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  realm?: string | null;
  providerDomain?: string | null;
  usePkce?: boolean;
  allowedEmails?: string[];
  allowedTelegramIds?: string[];
}
