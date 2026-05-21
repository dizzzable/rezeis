import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminBackupController } from './controllers/admin-backup.controller';
import { BackupService } from './services/backup.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminBackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
