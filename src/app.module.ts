import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { appConfig } from './common/config/app.config';
import { authConfig } from './common/config/auth.config';
import { databaseConfig } from './common/config/database.config';
import { emailConfig } from './common/config/email.config';
import { validateEnvironment } from './common/config/env.schema';
import { paymentsConfig } from './common/config/payments.config';
import { remnawaveConfig } from './common/config/remnawave.config';
import { redisConfig } from './common/config/redis.config';
import { webhookConfig } from './common/config/webhook.config';
import { PrismaModule } from './common/prisma/prisma.module';
import { RawCacheModule } from './common/cache/raw-cache.module';
import { SystemEventsModule } from './common/services/system-events.module';
import { AddOnsModule } from './modules/add-ons/add-ons.module';
import { AntiFraudModule } from './modules/anti-fraud/anti-fraud.module';
import { ApiTokensModule } from './modules/api-tokens/api-tokens.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { AutoRenewModule } from './modules/auto-renew/auto-renew.module';
import { AutomationsModule } from './modules/automations/automations.module';
import { BackupModule } from './modules/backup/backup.module';
import { BlockedIpsModule } from './modules/blocked-ips/blocked-ips.module';
import { BlockedIpGuard } from './modules/blocked-ips/guards/blocked-ip.guard';
import { BotConfigModule } from './modules/bot-config/bot-config.module';
import { BroadcastModule } from './modules/broadcast/broadcast.module';
import { BusinessAnalyticsModule } from './modules/business-analytics/business-analytics.module';
import { ClientErrorsModule } from './modules/client-errors/client-errors.module';
import { ConfigPortabilityModule } from './modules/config-portability/config-portability.module';
import { ContestsModule } from './modules/contests/contests.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { FaqModule } from './modules/faq/faq.module';
import { HealthModule } from './modules/health/health.module';
import { ImportsModule } from './modules/imports/imports.module';
import { InternalUserModule } from './modules/internal-user/internal-user.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PartnersModule } from './modules/partners/partners.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PlansModule } from './modules/plans/plans.module';
import { ProfileSyncModule } from './modules/profile-sync/profile-sync.module';
import { PromocodesModule } from './modules/promocodes/promocodes.module';
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
      load: [appConfig, authConfig, databaseConfig, emailConfig, paymentsConfig, redisConfig, remnawaveConfig, webhookConfig],
    }),
    PrismaModule,
    RawCacheModule,
    ScheduleModule.forRoot(),
    SystemEventsModule,
    AddOnsModule,
    HealthModule,
    AuthModule,
    AntiFraudModule,
    ApiTokensModule,
    AuditModule,
    AutoRenewModule,
    AutomationsModule,
    BackupModule,
    BlockedIpsModule,
    BotConfigModule,
    BusinessAnalyticsModule,
    BroadcastModule,
    ClientErrorsModule,
    ConfigPortabilityModule,
    ContestsModule,
    DashboardModule,
    FaqModule,
    ImportsModule,
    NotificationsModule,
    PartnersModule,
    ProfileSyncModule,
    PromocodesModule,
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
    InternalUserModule,
    SettingsModule,
    UsersModule,
    WebhooksModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
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
