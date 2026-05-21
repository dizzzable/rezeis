import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminConfigPortabilityController } from './controllers/admin-config-portability.controller';
import { ConfigExportService } from './services/config-export.service';
import { ConfigImportService } from './services/config-import.service';

/**
 * Phase 8 — Configuration Portability.
 *
 * Lets operators export the curated configuration of the panel
 * (roles, permissions, automations, webhooks, settings, FAQ, IP lists,
 * notification templates) as JSON and import it on another deployment
 * with a `skip` / `overwrite` strategy plus an explicit dry-run mode.
 */
@Module({
  imports: [AuthModule, RbacModule],
  controllers: [AdminConfigPortabilityController],
  providers: [ConfigExportService, ConfigImportService],
  exports: [ConfigExportService, ConfigImportService],
})
export class ConfigPortabilityModule {}
