import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdminRemnawaveController, RemnawaveWebhookController } from './controllers/admin-remnawave.controller';
import { RemnawaveApiService } from './services/remnawave-api.service';
import { RemnawaveMetricsCollectorService } from './services/remnawave-metrics-collector.service';
import { RemnawaveWebhookService } from './services/remnawave-webhook.service';

@Module({
  imports: [ConfigModule, HttpModule],
  controllers: [AdminRemnawaveController, RemnawaveWebhookController],
  providers: [RemnawaveApiService, RemnawaveMetricsCollectorService, RemnawaveWebhookService],
  exports: [RemnawaveApiService, RemnawaveMetricsCollectorService, RemnawaveWebhookService],
})
export class RemnawaveModule {}
