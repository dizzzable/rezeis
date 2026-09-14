import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReiwaCacheInvalidatorService } from '../bot-config/services/reiwa-cache-invalidator.service';
import { ReiwaRelayModule } from '../notifications/reiwa-relay.module';
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
 *
 * `ReiwaCacheInvalidatorService` is declared here, with the `ReiwaRelayModule`
 * it enqueues through, for the reason `LegalDocumentsModule` gives: a committed
 * import has to drop the cabinet's and the bot's caches of what it wrote, and
 * importing `BotConfigModule` for one stateless dispatcher would pull the bot
 * editor in.
 */
@Module({
  imports: [AuthModule, RbacModule, ReiwaRelayModule],
  controllers: [AdminConfigPortabilityController],
  providers: [ConfigExportService, ConfigImportService, ReiwaCacheInvalidatorService],
  exports: [ConfigExportService, ConfigImportService],
})
export class ConfigPortabilityModule {}
