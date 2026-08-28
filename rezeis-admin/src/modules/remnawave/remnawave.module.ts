import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { OutboundHttpModule } from '../../common/http/outbound-http.module';
import { AdminRemnawaveController, RemnawaveWebhookController } from './controllers/admin-remnawave.controller';
import { buildPanelClientProviders } from './services/panel-clients.providers';
import { PanelDevicesClient } from './services/panel-devices.client';
import { PanelInfraClient } from './services/panel-infra.client';
import { PanelUsersClient } from './services/panel-users.client';
import { RemnawaveApiService } from './services/remnawave-api.service';
import { RemnawaveMetricsCollectorService } from './services/remnawave-metrics-collector.service';
import { RemnawaveVersionService } from './services/remnawave-version.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RemnawaveWebhookService } from './services/remnawave-webhook.service';
import { SubscriptionNoticePayloadService } from './services/subscription-notice-payload.service';

@Module({
  // `NotificationsModule` is what lets the webhook TELL the customer their
  // traffic limit was reached. The edge is one-way — notifications knows
  // nothing about the panel — so there is no cycle to introduce.
  imports: [ConfigModule, OutboundHttpModule, NotificationsModule],
  controllers: [AdminRemnawaveController, RemnawaveWebhookController],
  providers: [
    RemnawaveApiService,
    RemnawaveMetricsCollectorService,
    RemnawaveVersionService,
    RemnawaveWebhookService,
    SubscriptionNoticePayloadService,
    ...buildPanelClientProviders(),
  ],
  exports: [
    RemnawaveApiService,
    RemnawaveMetricsCollectorService,
    RemnawaveVersionService,
    RemnawaveWebhookService,
    SubscriptionNoticePayloadService,
    PanelUsersClient,
    PanelDevicesClient,
    PanelInfraClient,
  ],
})
export class RemnawaveModule {}
