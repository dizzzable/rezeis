import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { AdminImportsController } from './controllers/admin-imports.controller';
import { ImportsService } from './services/imports.service';
import { RemnawaveImporterService } from './services/remnawave-importer.service';

@Module({
  imports: [AuthModule, RemnawaveModule],
  controllers: [AdminImportsController],
  providers: [ImportsService, RemnawaveImporterService],
  exports: [ImportsService],
})
export class ImportsModule {}
