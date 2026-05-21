import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { AdminBroadcastController } from './controllers/admin-broadcast.controller';
import { BroadcastDeliveryService } from './services/broadcast-delivery.service';
import { BroadcastMediaUploadService } from './services/broadcast-media-upload.service';
import { BroadcastService } from './services/broadcast.service';

@Module({
  imports: [AuthModule, ConfigModule],
  controllers: [AdminBroadcastController],
  providers: [BroadcastService, BroadcastDeliveryService, BroadcastMediaUploadService],
  exports: [BroadcastService, BroadcastDeliveryService],
})
export class BroadcastModule {}
