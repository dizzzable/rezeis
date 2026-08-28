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
import { RemnawaveWebhookService } from './services/remnawave-webhook.service';

@Module({
  imports: [ConfigModule, OutboundHttpModule],
  controllers: [AdminRemnawaveController, RemnawaveWebhookController],
  providers: [
    RemnawaveApiService,
    RemnawaveMetricsCollectorService,
    RemnawaveVersionService,
    RemnawaveWebhookService,
    ...buildPanelClientProviders(),
  ],
  exports: [
    RemnawaveApiService,
    RemnawaveMetricsCollectorService,
    RemnawaveVersionService,
    RemnawaveWebhookService,
    PanelUsersClient,
    PanelDevicesClient,
    PanelInfraClient,
  ],
})
export class RemnawaveModule {}
