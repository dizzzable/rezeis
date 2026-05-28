import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalWebAuthController } from './controllers/internal-web-auth.controller';
import { BotSigninTokenService } from './services/bot-signin-token.service';
import { WebAuthService } from './services/web-auth.service';

/**
 * WebAuthModule
 * ─────────────
 * Owns the credential-driven authentication flow consumed by the reiwa
 * SPA and Telegram Mini App. Sits next to `InternalUserModule` (which
 * exposes the *session* surface) and `AuthModule` (which provides the
 * shared `PasswordHashService`).
 *
 * `BotSigninTokenService` is the magic-link bridge for telegram-only
 * users: bot issues a one-time token, browser cabinet consumes it,
 * user gets a real WebSession without typing a password.
 */
@Module({
  imports: [AuthModule],
  controllers: [InternalWebAuthController],
  providers: [WebAuthService, BotSigninTokenService],
  exports: [WebAuthService, BotSigninTokenService],
})
export class WebAuthModule {}
