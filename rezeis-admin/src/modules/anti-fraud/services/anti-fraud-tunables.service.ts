import { Injectable, Logger } from '@nestjs/common';

import { SettingsService } from '../../settings/services/settings.service';
import type { AntiFraudTunables } from '../../settings/utils/anti-fraud-settings.util';

/**
 * Raised when the effective tunables cannot be read.
 *
 * A distinct type so a caller (and a test) can tell "the settings row was
 * unreadable" apart from "the panel API misbehaved" — the two demand different
 * operator responses and only one of them means the detector's own data source
 * is fine.
 */
export class AntiFraudTunablesUnavailableError extends Error {
  public constructor(cause: unknown) {
    super(
      'Anti-fraud tunables could not be read from the settings row; ' +
        `the run was skipped rather than guessed at: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AntiFraudTunablesUnavailableError';
  }
}

/**
 * How a database-backed tunable reaches the detectors.
 *
 * WHY AN INJECTED READER RATHER THAN RESOLVING ONCE PER RUN AND PASSING DOWN.
 * Both were viable. Passing down from `AntiFraudService.runDetectors` would give
 * one read and one consistent snapshot for the whole run — but the read would
 * then sit in front of ALL EIGHT detectors, so an unreadable settings row would
 * take down `detectExcessiveFailedPayments`, `detectRapidReferralVelocity`,
 * `detectPromoAbuse` and `detectRapidChurn`, none of which have any interest in
 * these knobs. An injected reader keeps the blast radius on exactly the four
 * detectors that read the values. The consistency the pass-down would have
 * bought is not lost in practice: all four detectors resolve at the top of
 * their method and `runDetectors` starts them in one `Promise.allSettled`, so
 * their reads land milliseconds apart, inside one cache generation.
 *
 * CACHING. There is none here on purpose. `SettingsService` already serves the
 * singleton row from a 5-second cache that write transactions drop and the TTL
 * self-heals; a second cache would be a second staleness budget to reason about
 * and the thing most likely to let the API container and the BullMQ worker
 * disagree. As it stands each process holds its own 5-second window, so the
 * worst-case divergence between them is 5 s — against a 5-minute detector
 * cadence, they cannot disagree within a run.
 *
 * WHEN A CHANGE TAKES EFFECT. On the next detector run: at most ~5 minutes
 * (`@Cron(EVERY_5_MINUTES)`), or immediately via `POST /admin/fraud/detectors/run`.
 * No restart, in either the API or the worker container. The admin form says so.
 *
 * ON FAILURE. This throws. It does NOT fall back to the environment layer, and
 * it emphatically does not fall back to range floors — the second is the defect
 * class this codebase already shipped once, and the first is subtler but worse
 * in the direction that matters: an operator who switched a detector OFF in the
 * panel because it was misfiring would have it switched back ON by a transient
 * database blip, and the detector would resume accusing customers. Throwing
 * routes the detector into the `Promise.allSettled` rejected branch in
 * `AntiFraudService.runDetectors`, which is already built for "this detector saw
 * nothing": it logs a warning naming the detector and keeps that detector's
 * codes out of the reconcile set, so no live signal is auto-resolved by the
 * outage either.
 */
@Injectable()
export class AntiFraudTunablesService {
  private readonly logger = new Logger(AntiFraudTunablesService.name);

  public constructor(private readonly settingsService: SettingsService) {}

  /** Effective tunables, or throws {@link AntiFraudTunablesUnavailableError}. */
  public async resolve(): Promise<AntiFraudTunables> {
    try {
      return await this.settingsService.getAntiFraudTunablesRuntime();
    } catch (error) {
      this.logger.error(
        'Anti-fraud tunables are unreadable — the detectors that depend on them ' +
          'will skip this run instead of falling back to environment defaults, ' +
          'because falling back could re-enable a detector the operator turned off: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw new AntiFraudTunablesUnavailableError(error);
    }
  }
}
