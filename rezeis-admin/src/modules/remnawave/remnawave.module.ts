import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { OutboundHttpModule } from '../../common/http/outbound-http.module';
import { AdminRemnawaveController, RemnawaveWebhookController } from './controllers/admin-remnawave.controller';
import { buildPanelClientProviders } from './services/panel-clients.providers';
import { PanelDevicesClient } from './services/panel-devices.client';
import { PanelInfraClient } from './services/panel-infra.client';
import { PanelUsersClient } from './services/panel-users.client';
import { NodeAddressesService } from './services/node-addresses.service';
import { RemnawaveApiService } from './services/remnawave-api.service';
import { RemnawaveMetricsCollectorService } from './services/remnawave-metrics-collector.service';
import { RemnawaveProfileFactsService } from './services/remnawave-profile-facts.service';
import { RemnawaveVersionService } from './services/remnawave-version.service';
import { StalePanelIdentityCensus } from './services/stale-panel-identity.census';
import { SubscriberServersService } from './services/subscriber-servers.service';
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
    NodeAddressesService,
    RemnawaveApiService,
    RemnawaveMetricsCollectorService,
    // The profile's `createdAt` / `lastTrafficResetAt`, read once when no
    // answer of Remnawave's has stamped them yet (the add-on offer, the sweep).
    RemnawaveProfileFactsService,
    RemnawaveVersionService,
    RemnawaveWebhookService,
    // The boot count of rows the stale-link net refuses (worker only).
    StalePanelIdentityCensus,
    SubscriberServersService,
    SubscriptionNoticePayloadService,
    ...buildPanelClientProviders(),
  ],
  exports: [
    NodeAddressesService,
    RemnawaveApiService,
    RemnawaveMetricsCollectorService,
    RemnawaveProfileFactsService,
    RemnawaveVersionService,
    RemnawaveWebhookService,
    StalePanelIdentityCensus,
    SubscriberServersService,
    SubscriptionNoticePayloadService,
    PanelUsersClient,
    PanelDevicesClient,
    PanelInfraClient,
  ],
})
export class RemnawaveModule {}
