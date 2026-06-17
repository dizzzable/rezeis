import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { BACKUP_QUEUE } from './backup.constants';
import { BackupProcessor } from './backup.processor';
import { AdminBackupController } from './controllers/admin-backup.controller';
import { BackupService } from './services/backup.service';

@Module({
  imports: [
    AuthModule,
    SettingsModule,
    BullModule.registerQueue({ name: BACKUP_QUEUE }),
  ],
  controllers: [AdminBackupController],
  providers: [BackupService, BackupProcessor],
  exports: [BackupService],
})
export class BackupModule {}
