/**
 * Tunables for the subscription-sharing detectors. Read from the environment
 * with conservative defaults so the feature is safe out of the box and node
 * load from the `ip-control` jobs stays bounded.
 *
 * All values are resolved once per call (cheap) so tests can override
 * `process.env` without module-reload gymnastics.
 */
export interface SharingDetectionConfig {
  /** Enable the HWID device-overage detector. */
  readonly enableHwidOverage: boolean;
  /** Enable the concurrent-IP sharing detector. */
  readonly enableIpSharing: boolean;
  /** Only count IPs whose lastSeen is within this many minutes of now. */
  readonly ipWindowMinutes: number;
  /** Max connected nodes probed per detector run (protects nodes). */
  readonly maxNodesPerRun: number;
  /** Bounded job-poll attempts per ip-control job. */
  readonly jobPollAttempts: number;
  /** Delay between poll attempts, ms. */
  readonly jobPollIntervalMs: number;
  /** Cap on the number of IP samples persisted in signal metadata. */
  readonly maxIpsInMetadata: number;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

export function resolveSharingDetectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): SharingDetectionConfig {
  return {
    enableHwidOverage: parseBoolean(env.ANTIFRAUD_SHARING_HWID_ENABLED, true),
    enableIpSharing: parseBoolean(env.ANTIFRAUD_SHARING_IP_ENABLED, true),
    ipWindowMinutes: parseInteger(env.ANTIFRAUD_SHARING_IP_WINDOW_MINUTES, 10, 1, 1440),
    maxNodesPerRun: parseInteger(env.ANTIFRAUD_SHARING_MAX_NODES_PER_RUN, 25, 1, 500),
    jobPollAttempts: parseInteger(env.ANTIFRAUD_SHARING_JOB_POLL_ATTEMPTS, 12, 1, 60),
    jobPollIntervalMs: parseInteger(env.ANTIFRAUD_SHARING_JOB_POLL_INTERVAL_MS, 500, 100, 10000),
    maxIpsInMetadata: parseInteger(env.ANTIFRAUD_SHARING_MAX_IPS_IN_METADATA, 20, 1, 200),
  };
}
