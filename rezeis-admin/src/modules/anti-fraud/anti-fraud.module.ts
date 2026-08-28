import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminFraudController } from './controllers/admin-fraud.controller';
import { FraudDetectors } from './detectors/fraud-detectors';
import { RemnawaveDetectors } from './detectors/remnawave-detectors';
import { SharingDetectors } from './detectors/sharing-detectors';
import { SubscriptionUaDetectors } from './detectors/subscription-ua-detectors';
import { AntiFraudService } from './services/anti-fraud.service';
import { AntiFraudTunablesService } from './services/anti-fraud-tunables.service';
import { DetectorAccuracyService } from './services/detector-accuracy.service';

/**
 * Anti-fraud module — persistent fraud signals + scheduled detectors.
 *
 * Phase 3 evolves the previous stateless `generateReport()` flow into a
 * row-per-finding model. Detectors live in `detectors/` as pure functions;
 * the orchestrator in `services/anti-fraud.service.ts` upserts candidates
 * keyed by `(code, fingerprint)` and triggers the configured action
 * policy (notify / block_user / freeze_subscription).
 *
 * Remnawave detectors (Phase 4+) poll the panel API, and their output splits
 * two ways. Per-user node traffic abuse names a customer, so it stays a fraud
 * signal and goes through the same upsert as the rest. The four panel-wide
 * observations — nodes offline, node traffic quota, geo concentration, and the
 * panel-wide device average — name nobody and are nobody's doing, so they are
 * emitted as operator alerts through `SystemEventsService` (the channel the
 * panel's own webhooks already use for these facts) rather than being filed
 * against whoever happens to be online.
 *
 * Panel access
 *   `RemnawaveModule` provides and exports `PanelDevicesClient` and
 *   `PanelInfraClient`, the contract-driven readers this module talks to. They
 *   are what makes "we looked and found nobody" a different value from "we
 *   could not look" — the distinction every detector here decides an accusation
 *   on. `RemnawaveVersionService` is deliberately NOT injected anywhere in this
 *   module any more: the version gates it fed existed to tell 2.7 from 2.8 from
 *   3.x, this build serves 3.x only, and `LegacyPanelRefusal` turns a 2.x panel
 *   away once, centrally, in the transport.
 *
 *   `SharingDetectors` still takes `RemnawaveApiService`, for exactly one call:
 *   the whole-panel user walk that supplies every subscriber's device limit.
 *   See the note on its constructor.
 *
 * Scheduling
 *   `AntiFraudService.runDetectorsScheduled` runs every 5 minutes via
 *   `@nestjs/schedule`. The same logic is exposed under
 *   `POST /admin/fraud/detectors/run` for manual triggering.
 *
 * Tunables
 *   The sharing, traffic-abuse and subscription-UA thresholds are
 *   operator-editable from Settings → Anti-fraud, not environment-only.
 *   `SettingsModule` is imported for `AntiFraudTunablesService`, which resolves
 *   "stored panel value, else `ANTIFRAUD_*` env var, else built-in default" at
 *   the top of each detector — the subscription-UA section having no env layer,
 *   so stored-value-else-default. A change lands on the next run — no restart.
 *   See that service for the caching and failure policy.
 *
 *   `SubscriptionUaDetectors` ships with its switch OFF: it is a User-Agent
 *   heuristic, new and unproven on a real panel, so an operator opts in.
 *
 * Feedback loop
 *   `DetectorAccuracyService` closes the other half of that tuning story: it
 *   reads back the verdicts operators already recorded on the signals
 *   (`status`, `resolvedBy`) and reports a per-code dismissal rate under
 *   `GET /admin/fraud/detector-accuracy`. Strictly read-only — `groupBy` only —
 *   so it can be looked at without disturbing what it measures, and it is
 *   deliberately NOT wired into the detectors: nothing auto-tunes on it.
 */
@Module({
  imports: [AuthModule, RemnawaveModule, SettingsModule],
  controllers: [AdminFraudController],
  providers: [
    AntiFraudService,
    AntiFraudTunablesService,
    DetectorAccuracyService,
    FraudDetectors,
    RemnawaveDetectors,
    SharingDetectors,
    SubscriptionUaDetectors,
  ],
  exports: [AntiFraudService],
})
export class AntiFraudModule {}
