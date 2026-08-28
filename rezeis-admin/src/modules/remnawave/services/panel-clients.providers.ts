import { HttpService } from '@nestjs/axios';
import { Logger, type Provider } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { remnawaveConfig } from '../../../common/config/remnawave.config';
import { PanelCommandExecutor } from './panel-command.executor';
import { PanelDevicesClient } from './panel-devices.client';
import { PanelInfraClient } from './panel-infra.client';
import { PanelUsersClient } from './panel-users.client';
import { AxiosPanelTransport, LegacyPanelRefusal } from './panel-transport';

/**
 * Wiring for the contract-driven panel clients
 * ════════════════════════════════════════════
 * Assembled here rather than inside the module file because the graph has one
 * shape that is easy to get wrong and expensive when you do: there are TWO
 * transports, and which client gets which is not a preference.
 *
 *   bare transport ──→ probe client ──→ panel version
 *                                            │
 *   bare transport ──→ refusal ←─────────────┘
 *                         │
 *                         └──→ executor ──→ users / devices / infra
 *
 * The refusal has to ask what version the panel is. The only thing that can
 * answer is the probe. So a probe placed behind the refusal waits on itself
 * and every call in the process hangs on the first one. Building the probe on
 * the BARE transport is what makes that impossible rather than merely
 * discouraged — there is no path from `PANEL_VERSION_PROBE` to the refusal to
 * follow.
 *
 * The version is cached for the same reason the old adapter cached it: this
 * lookup now sits in front of EVERY panel call, and an uncached probe would
 * put a second round-trip on each one.
 */

/** Injection token for the probe — deliberately not the same class as the rest. */
export const PANEL_VERSION_PROBE = Symbol('PANEL_VERSION_PROBE');
export const PANEL_COMMAND_EXECUTOR = Symbol('PANEL_COMMAND_EXECUTOR');

/**
 * How long a version answer is trusted, and how long a FAILURE is.
 *
 * The negative window is short on purpose and the two numbers are not
 * interchangeable. A successful read is a fact about a running panel and holds
 * for minutes. A failure is a fact about one bad moment, and caching it for
 * minutes would keep the whole integration in its "unknown" mode long after
 * the panel came back — which, since unknown now proceeds as 3.x, is survivable
 * but still means several minutes of decisions made without the answer. These
 * mirror the windows `panel-version.util.ts` already uses, so the two version
 * readers in this codebase age at the same rate.
 */
const VERSION_CACHE_TTL_MS = 5 * 60_000;
const VERSION_NEGATIVE_CACHE_TTL_MS = 15_000;

/**
 * Reads the panel's major version through the probe, cached.
 *
 * `null` means "could not tell" and never "old" — the distinction the refusal
 * depends on. A panel that cannot be probed is not refused; see
 * `LegacyPanelRefusal`.
 */
export class PanelVersionGate {
  private readonly logger = new Logger(PanelVersionGate.name);
  private cache: { readonly major: number | null; readonly at: number } | null = null;

  public constructor(
    private readonly probe: PanelInfraClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public async readMajor(): Promise<number | null> {
    const at = this.now();
    if (this.cache !== null) {
      const ttl = this.cache.major === null ? VERSION_NEGATIVE_CACHE_TTL_MS : VERSION_CACHE_TTL_MS;
      if (at - this.cache.at < ttl) return this.cache.major;
    }
    const major = await this.readMajorUncached();
    this.cache = { major, at };
    return major;
  }

  private async readMajorUncached(): Promise<number | null> {
    const version = await this.probe.readPanelVersion();
    if (version === null) return null;
    // The leading integer, and nothing clever. A version string this cannot
    // read is an unknown panel, which is a state the refusal already handles
    // correctly — guessing at it would be the one way to get this wrong.
    const match = /^\s*(\d+)\./.exec(version);
    if (match === null) {
      this.logger.warn(`Remnawave reported a version this build cannot parse: ${version}`);
      return null;
    }
    return Number.parseInt(match[1] as string, 10);
  }
}

export function buildPanelClientProviders(): readonly Provider[] {
  return [
    {
      provide: PANEL_VERSION_PROBE,
      inject: [HttpService, remnawaveConfig.KEY],
      useFactory: (
        httpService: HttpService,
        configuration: ConfigType<typeof remnawaveConfig>,
      ): PanelVersionGate =>
        new PanelVersionGate(
          // BARE transport. See the header — a probe behind the refusal waits
          // for an answer only it can produce.
          PanelInfraClient.forVersionProbe(
            new AxiosPanelTransport(httpService, {
              host: configuration.host,
              port: configuration.port,
              token: configuration.token,
            }),
          ),
        ),
    },
    {
      provide: PANEL_COMMAND_EXECUTOR,
      inject: [HttpService, remnawaveConfig.KEY, PANEL_VERSION_PROBE],
      useFactory: (
        httpService: HttpService,
        configuration: ConfigType<typeof remnawaveConfig>,
        gate: PanelVersionGate,
      ): PanelCommandExecutor =>
        new PanelCommandExecutor(
          new LegacyPanelRefusal(
            new AxiosPanelTransport(httpService, {
              host: configuration.host,
              port: configuration.port,
              token: configuration.token,
            }),
            () => gate.readMajor(),
          ),
        ),
    },
    {
      provide: PanelUsersClient,
      inject: [PANEL_COMMAND_EXECUTOR],
      useFactory: (executor: PanelCommandExecutor): PanelUsersClient =>
        new PanelUsersClient(executor),
    },
    {
      provide: PanelDevicesClient,
      inject: [PANEL_COMMAND_EXECUTOR],
      useFactory: (executor: PanelCommandExecutor): PanelDevicesClient =>
        new PanelDevicesClient(executor),
    },
    {
      provide: PanelInfraClient,
      inject: [PANEL_COMMAND_EXECUTOR],
      useFactory: (executor: PanelCommandExecutor): PanelInfraClient =>
        new PanelInfraClient(executor),
    },
  ];
}
