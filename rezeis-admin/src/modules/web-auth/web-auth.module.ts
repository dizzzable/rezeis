import { Module } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { LegalDocumentsModule } from '../legal-documents/legal-documents.module';
import { BotNotifierClient } from '../notifications/services/bot-notifier.client';
import { InternalPushModule } from '../push/internal-push.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { SettingsModule } from '../settings/settings.module';
import { InternalWebAuthCredentialsController } from './controllers/internal-web-auth-credentials.controller';
import { InternalWebAuthController } from './controllers/internal-web-auth.controller';
import { BotSigninTokenService } from './services/bot-signin-token.service';
import {
  asPasswordResetDatabase,
  PASSWORD_RESET_DATABASE,
  PasswordResetService,
} from './services/password-reset.service';
import { RegistrationSnapshotService } from './services/registration-snapshot.service';
import { WebAuthService } from './services/web-auth.service';
import {
  asWebFirstPasswordDatabase,
  WEB_FIRST_PASSWORD_DATABASE,
  WebFirstPasswordService,
} from './services/web-first-password.service';
import {
  asWebSessionRevocationDatabase,
  WEB_SESSION_REVOCATION_DATABASE,
  WebSessionRevocationService,
} from './services/web-session-revocation.service';

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
 *
 * `PasswordResetService` gets a customer who forgot the password (or the
 * login) back in without support. It declares its own `BotNotifierClient`,
 * the way `BackupModule` does: a reset link must not ride the relay QUEUE,
 * which keeps finished jobs readable in Redis long after the link expired
 * (see `RELAY_DIRECT_DELIVERY_EXCEPTIONS`), and the client is a stateless
 * reader of two env vars. `InternalPushModule` is here for the one web-push
 * notice after a reset by subscription link.
 *
 * `WebSessionRevocationService` keeps the moment before which a customer's
 * cabinet sessions are signed out; `WebFirstPasswordService` lets a signed-in
 * customer whose account has no password set the first one.
 */
@Module({
  imports: [AuthModule, LegalDocumentsModule, ReferralsModule, SettingsModule, InternalPushModule],
  controllers: [InternalWebAuthController, InternalWebAuthCredentialsController],
  providers: [
    WebAuthService,
    BotSigninTokenService,
    RegistrationSnapshotService,
    PasswordResetService,
    WebSessionRevocationService,
    WebFirstPasswordService,
    BotNotifierClient,
    // The factories' declared return types are the compile-time proof that the
    // real client fits the ports these services are written against.
    { provide: PASSWORD_RESET_DATABASE, inject: [PrismaService], useFactory: asPasswordResetDatabase },
    {
      provide: WEB_SESSION_REVOCATION_DATABASE,
      inject: [PrismaService],
      useFactory: asWebSessionRevocationDatabase,
    },
    { provide: WEB_FIRST_PASSWORD_DATABASE, inject: [PrismaService], useFactory: asWebFirstPasswordDatabase },
  ],
  exports: [WebAuthService, BotSigninTokenService, RegistrationSnapshotService],
})
export class WebAuthModule {}
