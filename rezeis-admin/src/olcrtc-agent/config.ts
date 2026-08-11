import { hostname } from 'node:os';

export interface OlcrtcAgentConfig {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly sharedSecret: string;
  readonly gatewayName: string;
  readonly managementUrl: string;
  readonly capacity: number;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly trafficIntervalMs: number;
  readonly sessionKillTimeoutMs: number;
  readonly sessionCommand: string | null;
  readonly trafficCounterFileTemplate: string | null;
  readonly version: string;
}

export function loadOlcrtcAgentConfig(env: NodeJS.ProcessEnv = process.env): OlcrtcAgentConfig {
  const gatewayName = env.OLCRTC_AGENT_NAME?.trim() || hostname();
  return {
    baseUrl: required(env.REZEIS_ADMIN_BASE_URL ?? env.OLCRTC_REZEIS_BASE_URL, 'REZEIS_ADMIN_BASE_URL'),
    apiToken: required(env.REZEIS_INTERNAL_API_TOKEN ?? env.OLCRTC_AGENT_API_TOKEN, 'REZEIS_INTERNAL_API_TOKEN'),
    sharedSecret: env.REZEIS_INTERNAL_SHARED_SECRET ?? '',
    gatewayName,
    managementUrl: env.OLCRTC_AGENT_MANAGEMENT_URL ?? `http://${gatewayName}:9090`,
    capacity: positiveInt(env.OLCRTC_AGENT_CAPACITY, 32),
    heartbeatIntervalMs: positiveInt(env.OLCRTC_AGENT_HEARTBEAT_INTERVAL_MS, 15_000),
    pollIntervalMs: positiveInt(env.OLCRTC_AGENT_POLL_INTERVAL_MS, 2_000),
    trafficIntervalMs: positiveInt(env.OLCRTC_AGENT_TRAFFIC_INTERVAL_MS, 60_000),
    sessionKillTimeoutMs: positiveInt(env.OLCRTC_AGENT_SESSION_KILL_TIMEOUT_MS, 10_000),
    sessionCommand: env.OLCRTC_AGENT_SESSION_COMMAND?.trim() || null,
    trafficCounterFileTemplate: env.OLCRTC_AGENT_TRAFFIC_COUNTER_FILE_TEMPLATE?.trim() || null,
    version: env.OLCRTC_AGENT_VERSION ?? '0.1.0',
  };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for rezeis-olc-agent`);
  return normalized;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
