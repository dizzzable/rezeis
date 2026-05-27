import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { ImportProcessor } from './import.processor';
import { IMPORT_QUEUE } from './imports.constants';
import { AdminImportsController } from './controllers/admin-imports.controller';
import { AltshopImporterService } from './services/altshop-importer.service';
import { BackupPlanClonerService } from './services/backup-plan-cloner.service';
import { BulkPlanAssignmentService } from './services/bulk-plan-assignment.service';
import { ImportQueueService } from './services/import-queue.service';
import { ImportsService } from './services/imports.service';
import { RemnashopImporterService } from './services/remnashop-importer.service';
import { RemnawaveImporterService } from './services/remnawave-importer.service';
import { ThreeXuiImporterService } from './services/threexui-importer.service';

@Module({
  imports: [
    AuthModule,
    RemnawaveModule,
    BullModule.registerQueue({ name: IMPORT_QUEUE }),
  ],
  controllers: [AdminImportsController],
  providers: [
    ImportsService,
    ImportQueueService,
    ImportProcessor,
    RemnawaveImporterService,
    ThreeXuiImporterService,
    RemnashopImporterService,
    AltshopImporterService,
    BackupPlanClonerService,
    BulkPlanAssignmentService,
  ],
  exports: [ImportsService, ImportQueueService, BackupPlanClonerService],
})
export class ImportsModule {}
