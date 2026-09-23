import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { advertisingConfig } from '../../common/config/advertising.config';
import { AuthModule } from '../auth/auth.module';
import { FxModule } from '../fx/fx.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartnersModule } from '../partners/partners.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AdminAdRequestsController } from './controllers/admin-ad-requests.controller';
import { AdminAdvertisingController } from './controllers/admin-advertising.controller';
import { InternalAdvertisingController } from './controllers/internal-advertising.controller';
import { InternalPartnerAdvertisingController } from './controllers/internal-partner-advertising.controller';
import { AdAttributionService } from './services/ad-attribution.service';
import { AdConversionService } from './services/ad-conversion.service';
import { AdMetricsService } from './services/ad-metrics.service';
import { AdPlacementRequestService } from './services/ad-placement-request.service';
import { AdSignupBonusService } from './services/ad-signup-bonus.service';
import { AdvertisingCampaignService } from './services/advertising-campaign.service';
import { ReiwaPublicLinksModule } from './reiwa-public-links.module';

/**
 * Advertising cabinet — marketing attribution layered beside the referral
 * (non-material) and partner (material) programs. Exposes admin CRUD +
 * moderation + metrics and a reiwa-facing click-ingest endpoint;
 * `AdConversionService` is consumed by the payments reconciliation hook.
 */
@Module({
  imports: [
    ConfigModule.forFeature(advertisingConfig),
    AuthModule,
    FxModule,
    NotificationsModule,
    PartnersModule,
    SubscriptionsModule,
    // The cabinet-links resolver the letters share; see that module.
    ReiwaPublicLinksModule,
  ],
  controllers: [
    AdminAdvertisingController,
    AdminAdRequestsController,
    InternalAdvertisingController,
    InternalPartnerAdvertisingController,
  ],
  providers: [
    AdvertisingCampaignService,
    AdPlacementRequestService,
    AdAttributionService,
    AdConversionService,
    AdMetricsService,
    AdSignupBonusService,
  ],
  exports: [AdConversionService, AdPlacementRequestService],
})
export class AdvertisingModule {}
