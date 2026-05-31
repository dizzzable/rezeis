import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminUpdateCheckerController, InternalUpdateCheckerController } from './controllers/admin-update-checker.controller';
import { UpdateCheckerService } from './services/update-checker.service';

/**
 * Phase 9 — Update Checker.
 *
 * Periodically asks GitHub for the latest release of this repository
 * and surfaces an `hasUpdate` flag the admin UI can render as a banner.
 * `REZEIS_UPDATE_REPO=<owner>/<repo>` enables the check; without it the
 * service is a no-op so self-hosted forks aren't bothered.
 *
 * The reiwa user cabinet reports its running version via the internal
 * heartbeat (`InternalUpdateCheckerController`); set
 * `REZEIS_REIWA_UPDATE_REPO` to also surface reiwa's latest release.
 */
@Module({
  imports: [AuthModule, HttpModule],
  controllers: [AdminUpdateCheckerController, InternalUpdateCheckerController],
  providers: [UpdateCheckerService],
  exports: [UpdateCheckerService],
})
export class UpdateCheckerModule {}
