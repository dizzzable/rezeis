import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { AdminFraudController } from './controllers/admin-fraud.controller';
import { FraudDetectors } from './detectors/fraud-detectors';
import { RemnawaveDetectors } from './detectors/remnawave-detectors';
import { SharingDetectors } from './detectors/sharing-detectors';
import { AntiFraudService } from './services/anti-fraud.service';

/**
 * Anti-fraud module — persistent fraud signals + scheduled detectors.
 *
 * Phase 3 evolves the previous stateless `generateReport()` flow into a
 * row-per-finding model. Detectors live in `detectors/` as pure functions;
 * the orchestrator in `services/anti-fraud.service.ts` upserts candidates
 * keyed by `(code, fingerprint)` and triggers the configured action
 * policy (notify / block_user / freeze_subscription).
 *
 * Remnawave detectors (Phase 4+) add HWID anomaly detection, node traffic
 * abuse, geo concentration risk, and offline node alerts by querying the
 * Remnawave panel API.
 *
 * Scheduling
 *   `AntiFraudService.runDetectorsScheduled` runs every 5 minutes via
 *   `@nestjs/schedule`. The same logic is exposed under
 *   `POST /admin/fraud/detectors/run` for manual triggering.
 */
@Module({
  imports: [AuthModule, RemnawaveModule],
  controllers: [AdminFraudController],
  providers: [AntiFraudService, FraudDetectors, RemnawaveDetectors, SharingDetectors],
  exports: [AntiFraudService],
})
export class AntiFraudModule {}
