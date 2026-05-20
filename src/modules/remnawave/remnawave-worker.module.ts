import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { remnawaveConfig } from '@/common/config/remnawave.config';
import { RemnawaveApiService } from './services/remnawave-api.service';

@Module({
  imports: [
    HttpModule.register({ timeout: 15_000, maxRedirects: 3 }),
    ConfigModule.forFeature(remnawaveConfig),
  ],
  providers: [RemnawaveApiService],
  exports: [RemnawaveApiService],
})
export class RemnawaveWorkerModule {}
