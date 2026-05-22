import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { authConfig } from '../../common/config/auth.config';
import {
  OAuthConfigController,
  OAuthLinksController,
  OAuthPublicController,
} from './controllers/admin-oauth.controller';
import {
  PasskeyProtectedController,
  PasskeyPublicController,
} from './controllers/passkey.controller';
import { CryptoService } from './services/crypto.service';
import { GitHubAuthService } from './services/github-auth.service';
import { OAuthConfigService } from './services/oauth-config.service';
import { OAuthLoginService } from './services/oauth-login.service';
import { PasskeyService } from './services/passkey.service';
import { TelegramAuthService } from './services/telegram-auth.service';

/**
 * OAuth2 + Passkey authentication module.
 *
 * Provides:
 *   - Multi-provider OAuth2 login (Telegram, GitHub, Yandex, Keycloak, PocketID, Generic)
 *   - Provider configuration management (admin UI)
 *   - Account linking (one admin → multiple providers)
 *   - Passkey (WebAuthn/FIDO2) registration and authentication
 *
 * All provider secrets are stored AES-256-GCM encrypted using REZEIS_CRYPT_KEY.
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule.register({ timeout: 10_000 }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: { jwtSecret: string; jwtExpiresIn: string }) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.jwtExpiresIn as `${number}${'s' | 'm' | 'h' | 'd'}` },
      }),
      inject: [authConfig.KEY],
    }),
  ],
  controllers: [OAuthPublicController, OAuthConfigController, OAuthLinksController, PasskeyPublicController, PasskeyProtectedController],
  providers: [
    CryptoService,
    OAuthConfigService,
    OAuthLoginService,
    TelegramAuthService,
    GitHubAuthService,
    PasskeyService,
  ],
  exports: [OAuthConfigService, OAuthLoginService, CryptoService, PasskeyService],
})
export class OAuthModule {}
