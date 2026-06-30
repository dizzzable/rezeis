import { join } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { appConfig } from './common/config/app.config';
import { authConfig } from './common/config/auth.config';
import { databaseConfig } from './common/config/database.config';
import { emailConfig } from './common/config/email.config';
import { validateEnvironment } from './common/config/env.schema';
import { advertisingConfig } from './common/config/advertising.config';
import { paymentsConfig } from './common/config/payments.config';
import { remnawaveConfig } from './common/config/remnawave.config';
import { redisConfig } from './common/config/redis.config';
import { webhookConfig } from './common/config/webhook.config';
import { OutboundHttpModule } from './common/http/outbound-http.module';
import { AppLifecycleLogger } from './common/lifecycle/app-lifecycle.logger';
import { PrismaModule } from './common/prisma/prisma.module';
import { RawCacheModule } from './common/cache/raw-cache.module';
import { QueueModule } from './common/queue/queue.module';
import { ThrottleModule } from './common/throttle/throttle.module';
import { SystemEventsModule } from './common/services/system-events.module';
import { AddOnsModule } from './modules/add-ons/add-ons.module';
import { AntiFraudModule } from './modules/anti-fraud/anti-fraud.module';
import { ApiTokensModule } from './modules/api-tokens/api-tokens.module';
import { AuditModule } from './modules/audit/audit.module';
import { SystemEventsIngestModule } from './modules/system-events-ingest/system-events-ingest.module';
import { AuthModule } from './modules/auth/auth.module';
import { AutoRenewModule } from './modules/auto-renew/auto-renew.module';
import { AutomationsModule } from './modules/automations/automations.module';
import { BackupModule } from './modules/backup/backup.module';
import { BlockedIpsModule } from './modules/blocked-ips/blocked-ips.module';
import { BlockedIpGuard } from './modules/blocked-ips/guards/blocked-ip.guard';
import { BotConfigModule } from './modules/bot-config/bot-config.module';
import { BotFlowModule } from './modules/bot-flow/bot-flow.module';
import { BotMapModule } from './modules/bot-map/bot-map.module';
import { BroadcastModule } from './modules/broadcast/broadcast.module';
import { BusinessAnalyticsModule } from './modules/business-analytics/business-analytics.module';
import { ClientErrorsModule } from './modules/client-errors/client-errors.module';
import { ConfigPortabilityModule } from './modules/config-portability/config-portability.module';
import { ContestsModule } from './modules/contests/contests.module';
import { CustomEmojiModule } from './modules/custom-emoji/custom-emoji.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { FaqModule } from './modules/faq/faq.module';
import { HealthModule } from './modules/health/health.module';
import { ImportsModule } from './modules/imports/imports.module';
import { InternalUserModule } from './modules/internal-user/internal-user.module';
import { LinkingModule } from './modules/linking/linking.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OAuthModule } from './modules/oauth/oauth.module';
import { EmailDeliveryModule } from './modules/email/email.module';
import { PartnersModule } from './modules/partners/partners.module';
import { AdvertisingModule } from './modules/advertising/advertising.module';import { AccountMergeModule } from './modules/account-merge/account-merge.module';
import { PaymentAnalyticsModule } from './modules/payment-analytics/payment-analytics.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PlansModule } from './modules/plans/plans.module';
import { ProfileSyncModule } from './modules/profile-sync/profile-sync.module';
import { PromocodesModule } from './modules/promocodes/promocodes.module';
import { InternalPushModule } from './modules/push/internal-push.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { ReferralsModule } from './modules/referrals/referrals.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { SupportTicketsModule } from './modules/support-tickets/support-tickets.module';
import { SystemLogsModule } from './modules/system-logs/system-logs.module';
import { ThemePresetsModule } from './modules/theme-presets/theme-presets.module';
import { AdminIpAllowlistGuard } from './modules/two-factor/guards/admin-ip-allowlist.guard';
import { TwoFactorModule } from './modules/two-factor/two-factor.module';
import { UpdateCheckerModule } from './modules/update-checker/update-checker.module';
import { UsersModule } from './modules/users/users.module';
import { WebAuthModule } from './modules/web-auth/web-auth.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

/**
 * Configures the root NestJS application module.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      validate: validateEnvironment,
      load: [appConfig, advertisingConfig, authConfig, databaseConfig, emailConfig, paymentsConfig, redisConfig, remnawaveConfig, webhookConfig],
    }),
    OutboundHttpModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'web'),
      renderPath: /^(?!\/api\/)(?!\/uploads\/).*/,
      serveStaticOptions: {
        // Vite hashes asset filenames (e.g. `index-Hxt7IezJ.js`), so
        // any cached asset is safe to keep for a year. The `index.html`
        // shell that points at the latest hashed asset must NEVER be
        // cached or operators get stuck on a stale SPA after a deploy
        // and see runtime errors when the cached index references
        // assets that no longer exist.
        setHeaders: (res, path) => {
          if (/\.(?:html?)$/i.test(path)) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          } else if (/\/assets\//.test(path)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      },
    }),
    PrismaModule,
    RawCacheModule,
    QueueModule,
    ThrottleModule,
    ScheduleModule.forRoot(),
    SystemEventsModule,
    AddOnsModule,
    HealthModule,
    AuthModule,
    AntiFraudModule,
    AdvertisingModule,
    AccountMergeModule,
    ApiTokensModule,
    AuditModule,
    SystemEventsIngestModule,
    AutoRenewModule,
    AutomationsModule,
    BackupModule,
    BlockedIpsModule,
    BotConfigModule,
    BotFlowModule,
    BotMapModule,
    BusinessAnalyticsModule,
    BroadcastModule,
    ClientErrorsModule,
    ConfigPortabilityModule,
    CustomEmojiModule,
    ContestsModule,
    DashboardModule,
    FaqModule,
    ImportsModule,
    NotificationsModule,
    OAuthModule,
    EmailDeliveryModule,
    PartnersModule,
    ProfileSyncModule,
    PromocodesModule,
    InternalPushModule,
    RbacModule,
    RealtimeModule,
    ReferralsModule,
    PlansModule,
    SubscriptionsModule,
    SupportTicketsModule,
    SystemLogsModule,
    ThemePresetsModule,
    TwoFactorModule,
    UpdateCheckerModule,
    PaymentsModule,
    PaymentAnalyticsModule,
    InternalUserModule,
    LinkingModule,
    SettingsModule,
    UsersModule,
    WebAuthModule,
    WebhooksModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AppLifecycleLogger,
    /**
     * Global IP blocklist. Wired as `APP_GUARD` so it runs before any
     * controller-specific guards — even before `AdminJwtAuthGuard`.
     * The guard is fail-open on infra errors (see `BlockedIpGuard`)
     * to keep operators reachable during transient DB failures.
     */
    { provide: APP_GUARD, useClass: BlockedIpGuard },
    /**
     * Phase 5: Admin Panel IP allowlist. Runs only on `/api/admin/*`
     * paths and only when the allowlist contains active entries; behind
     * those gates it rejects every IP that does not match a listed
     * address/CIDR. Sits BEFORE the JWT guard so we never even consult
     * the auth store for off-list traffic.
     */
    { provide: APP_GUARD, useClass: AdminIpAllowlistGuard },
  ],
})
export class AppModule {}
