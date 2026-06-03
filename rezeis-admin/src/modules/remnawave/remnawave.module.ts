import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { OutboundHttpModule } from '../../common/http/outbound-http.module';
import { AdminRemnawaveController, RemnawaveWebhookController } from './controllers/admin-remnawave.controller';
import { RemnawaveApiService } from './services/remnawave-api.service';
import { RemnawaveMetricsCollectorService } from './services/remnawave-metrics-collector.service';
import { RemnawaveWebhookService } from './services/remnawave-webhook.service';

@Module({
  imports: [ConfigModule, OutboundHttpModule],
  controllers: [AdminRemnawaveController, RemnawaveWebhookController],
  providers: [RemnawaveApiService, RemnawaveMetricsCollectorService, RemnawaveWebhookService],
  exports: [RemnawaveApiService, RemnawaveMetricsCollectorService, RemnawaveWebhookService],
})
export class RemnawaveModule {}
