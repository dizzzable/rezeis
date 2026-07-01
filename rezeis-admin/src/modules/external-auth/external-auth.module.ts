import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EmailDeliveryModule } from '../email/email.module';
import { OAuthModule } from '../oauth/oauth.module';
import { AdminExternalAuthController } from './controllers/admin-external-auth.controller';
import { InternalExternalAuthController } from './controllers/internal-external-auth.controller';
import { DisposableEmailService } from './services/disposable-email.service';
import { ExternalAuthService } from './services/external-auth.service';
import { ExternalProviderConfigService } from './services/external-provider-config.service';
import { GoogleOAuthAdapter } from './services/providers/google-oauth.adapter';
import { MailruOAuthAdapter } from './services/providers/mailru-oauth.adapter';
import { TelegramOidcAdapter } from './services/providers/telegram-oidc.adapter';
import { YandexOAuthAdapter } from './services/providers/yandex-oauth.adapter';

/**
 * End-user external sign-in / registration for the web cabinet.
 *
 * Owns provider configuration (encrypted secrets, reusing the admin OAuth
 * `CryptoService`), the disposable-email policy, the OAuth adapters
 * (Google/Yandex/Mail.ru), the resolve engine, and the reiwa-facing internal
 * endpoints. Telegram is verified upstream by reiwa (which holds the bot
 * token) and resolved here. Kept separate from the admin-only `OAuthModule`.
 */
@Module({
  imports: [OAuthModule, AuthModule, EmailDeliveryModule, HttpModule.register({ timeout: 10_000 })],
  controllers: [AdminExternalAuthController, InternalExternalAuthController],
  providers: [
    ExternalProviderConfigService,
    DisposableEmailService,
    ExternalAuthService,
    GoogleOAuthAdapter,
    YandexOAuthAdapter,
    MailruOAuthAdapter,
    TelegramOidcAdapter,
  ],
  exports: [ExternalProviderConfigService, DisposableEmailService, ExternalAuthService],
})
export class ExternalAuthModule {}
