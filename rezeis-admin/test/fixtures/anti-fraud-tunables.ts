import { AntiFraudTunablesService } from '../../src/modules/anti-fraud/services/anti-fraud-tunables.service';
import { resolveSharingDetectionConfig } from '../../src/modules/anti-fraud/sharing-detection.config';
import { defaultSubscriptionUaDetectionConfig } from '../../src/modules/anti-fraud/subscription-ua-detection.config';
import { resolveTrafficAbuseConfig } from '../../src/modules/anti-fraud/traffic-abuse.config';
import type {
  AntiFraudTunables,
  StoredAntiFraudSettings,
} from '../../src/modules/settings/utils/anti-fraud-settings.util';
import { resolveAntiFraudTunables } from '../../src/modules/settings/utils/anti-fraud-settings.util';

/**
 * `AntiFraudTunablesService` double for the detector specs.
 *
 * The default — nothing stored — resolves straight from `process.env`, which is
 * exactly what the detectors did before the tunables became panel-managed. That
 * keeps every pre-existing detector test meaningful: those specs manipulate
 * `process.env.ANTIFRAUD_*` and still assert on the value the detector used, so
 * they now also prove the env fallback survived the change.
 *
 * `resolve` is read fresh on every call so a spec can mutate `process.env`
 * between runs, as `sharing-detectors.spec.ts` and `anti-fraud-node-outage.spec.ts`
 * already do.
 */
export function tunablesFromEnv(stored: StoredAntiFraudSettings = {}): AntiFraudTunablesService {
  return {
    resolve: async (): Promise<AntiFraudTunables> => resolveAntiFraudTunables(stored, process.env),
  } as unknown as AntiFraudTunablesService;
}

/**
 * The REAL `AntiFraudTunablesService` over a settings read that always fails.
 *
 * Deliberately not a hand-rolled thrower: the thing under test is the production
 * failure policy — that the read is wrapped in `AntiFraudTunablesUnavailableError`
 * and that nothing is fabricated in its place — so the real class has to be the
 * one running.
 */
export function tunablesThatFail(
  message = 'settings row unavailable',
): AntiFraudTunablesService {
  return new AntiFraudTunablesService({
    getAntiFraudTunablesRuntime: async (): Promise<AntiFraudTunables> => {
      throw new Error(message);
    },
  } as never);
}

/**
 * Env-only configs, for asserting what a detector WOULD have used as fallback.
 *
 * `subscriptionUa` has no env layer at all — those knobs are new and no
 * `ANTIFRAUD_UA_*` variable exists — so its "fallback" is the built-in default.
 */
export function envOnlyTunables(env: NodeJS.ProcessEnv = process.env): AntiFraudTunables {
  return {
    sharing: resolveSharingDetectionConfig(env),
    trafficAbuse: resolveTrafficAbuseConfig(env),
    subscriptionUa: defaultSubscriptionUaDetectionConfig(),
  };
}
