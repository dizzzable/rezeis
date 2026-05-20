import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdminRemnawaveController } from './controllers/admin-remnawave.controller';
import { RemnawaveApiService } from './services/remnawave-api.service';

@Module({
  imports: [ConfigModule, HttpModule],
  controllers: [AdminRemnawaveController],
  providers: [RemnawaveApiService],
  exports: [RemnawaveApiService],
})
export class RemnawaveModule {}
