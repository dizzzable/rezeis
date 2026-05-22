import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuthProviderType } from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { OAuthUserProfile } from '../interfaces/oauth-provider.interface';
import { CryptoService } from './crypto.service';

/**
 * GitHub OAuth2 authentication adapter.
 *
 * Flow:
 *   1. Frontend redirects to GitHub authorization URL
 *   2. GitHub redirects back with a `code`
 *   3. Backend exchanges code for access_token
 *   4. Backend fetches user profile from GitHub API
 *   5. Returns normalized OAuthUserProfile
 *
 * Reference: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 */
@Injectable()
export class GitHubAuthService {
  private readonly logger = new Logger(GitHubAuthService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly httpService: HttpService,
    private readonly cryptoService: CryptoService,
  ) {}

  /**
   * Returns the GitHub authorization URL for the frontend to redirect to.
   */
  public async getAuthorizationUrl(state: string): Promise<string> {
    const config = await this.getConfig();
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: `${config.backendDomain}/api/admin/oauth/github/callback`,
      scope: 'user:email',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchanges the authorization code for a user profile.
   */
  public async handleCallback(code: string): Promise<OAuthUserProfile> {
    const config = await this.getConfig();
    const clientSecret = this.cryptoService.decrypt(config.clientSecretEnc);

    // Exchange code for access token
    const tokenResponse = await firstValueFrom(
      this.httpService.post<{ access_token: string }>(
        'https://github.com/login/oauth/access_token',
        {
          client_id: config.clientId,
          client_secret: clientSecret,
          code,
        },
        { headers: { Accept: 'application/json' } },
      ),
    );

    const accessToken = tokenResponse.data.access_token;
    if (!accessToken) {
      throw new UnauthorizedException('Failed to obtain GitHub access token');
    }

    // Fetch user profile
    const [userResponse, emailsResponse] = await Promise.all([
      firstValueFrom(
        this.httpService.get<GitHubUser>('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ),
      firstValueFrom(
        this.httpService.get<GitHubEmail[]>('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ),
    ]);

    const user = userResponse.data;
    const primaryEmail = emailsResponse.data.find((e) => e.primary && e.verified)?.email
      ?? emailsResponse.data.find((e) => e.verified)?.email
      ?? null;

    return {
      providerId: user.id.toString(),
      providerType: AuthProviderType.GITHUB,
      email: primaryEmail,
      name: user.name ?? user.login,
      avatarUrl: user.avatar_url ?? null,
      rawProfile: {
        id: user.id,
        login: user.login,
        name: user.name,
        email: primaryEmail,
        avatarUrl: user.avatar_url,
      },
    };
  }

  private async getConfig(): Promise<{
    clientId: string;
    clientSecretEnc: string;
    backendDomain: string;
  }> {
    const config = await this.prismaService.authProviderConfig.findUnique({
      where: { type: AuthProviderType.GITHUB },
      select: { clientId: true, clientSecretEnc: true, backendDomain: true, isEnabled: true },
    });

    if (!config || !config.isEnabled || !config.clientId || !config.clientSecretEnc || !config.backendDomain) {
      throw new UnauthorizedException('GitHub OAuth is not configured');
    }

    return {
      clientId: config.clientId,
      clientSecretEnc: config.clientSecretEnc,
      backendDomain: config.backendDomain,
    };
  }
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}
