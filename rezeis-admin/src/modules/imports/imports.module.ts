import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { AdminImportsController } from './controllers/admin-imports.controller';
import { AltshopImporterService } from './services/altshop-importer.service';
import { ImportsService } from './services/imports.service';
import { RemnashopImporterService } from './services/remnashop-importer.service';
import { RemnawaveImporterService } from './services/remnawave-importer.service';
import { ThreeXuiImporterService } from './services/threexui-importer.service';

@Module({
  imports: [AuthModule, RemnawaveModule],
  controllers: [AdminImportsController],
  providers: [
    ImportsService,
    RemnawaveImporterService,
    ThreeXuiImporterService,
    RemnashopImporterService,
    AltshopImporterService,
  ],
  exports: [ImportsService],
})
export class ImportsModule {}
