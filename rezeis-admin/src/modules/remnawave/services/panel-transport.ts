import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

import { resolvePanelBaseUrl } from './panel-base-url';
import type {
  PanelTransport,
  PanelTransportResult,
} from './panel-command.executor';
import type { PanelMethod } from './panel-command.contract';

/**
 * AxiosPanelTransport
 * ═══════════════════
 * Bytes to the panel and back, and nothing else. No routes, no schemas, no
 * knowledge of what a user is — those live in the contract now, and the
 * executor reads them from there.
 *
 * This replaces the shared half of three near-identical helpers
 * (`strictHttp`, `requestJson`, `requestJsonWithBody`), each of which rebuilt
 * the base URL, the token and the same four headers, and each of which decided
 * for itself what a failure meant. They disagreed: one threw, one returned a
 * tagged union, one returned raw data. A caller had to know which it had.
 */
export class AxiosPanelTransport implements PanelTransport {
  private readonly logger = new Logger(AxiosPanelTransport.name);
  /**
   * Latch for the base-URL warning. `resolvePanelBaseUrl` runs on every
   * request and the condition it warns about is a static configuration fact,
   * so a line repeated a thousand times an hour is a line nobody reads.
   */
  private baseUrlWarningIssued = false;

  public constructor(
    private readonly httpService: HttpService,
    private readonly configuration: {
      readonly host: string | null;
      readonly port: number | null;
      readonly token: string | null;
    },
  ) {}

  public async send(input: {
    readonly method: PanelMethod;
    readonly url: string;
    readonly body?: unknown;
    readonly query?: Readonly<Record<string, string | number | undefined>>;
  }): Promise<PanelTransportResult> {
    const baseUrl = this.resolveBaseUrl();
    const token = this.configuration.token;
    if (baseUrl === null || token === null) {
      return { kind: 'unconfigured' };
    }

    const url = appendQuery(input.url, input.query);
    try {
      const response = await firstValueFrom(
        this.httpService.request<unknown>({
          method: input.method,
          url,
          baseURL: baseUrl,
          ...(input.body === undefined ? {} : { data: input.body }),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            // Kept from the helpers this replaces. The panel reads these when
            // it is behind its own proxy; dropping them changes what it logs
            // and, on some deployments, whether it answers at all.
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
          },
        }),
      );
      return { kind: 'ok', data: response.data };
    } catch (err: unknown) {
      if (isAxiosError(err) && err.response !== undefined) {
        const status = err.response.status;
        const code = readPanelErrorCode(err.response.data);
        // Logged HERE, once, at the only place that knows a request failed.
        // The read methods above this layer swallow failures into `null` /
        // `[]` fallbacks, which makes a panel outage indistinguishable from
        // "no data" unless the transport says something.
        this.logger.warn(
          `Remnawave ${input.method.toUpperCase()} ${url} → HTTP ${status}${
            code === null ? '' : ` (${code})`
          }`,
        );
        return {
          kind: 'rejected',
          status,
          code,
          detail: readPanelErrorMessage(err.response.data),
          retryAfterMs: parseRetryAfterMs(err.response.headers),
        };
      }
      const detail = err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`Remnawave ${input.method.toUpperCase()} ${url} did not complete: ${detail}`);
      return { kind: 'network', detail };
    }
  }

  private resolveBaseUrl(): string | null {
    const resolved = resolvePanelBaseUrl(this.configuration.host, this.configuration.port);
    if (resolved.warning !== null && !this.baseUrlWarningIssued) {
      this.baseUrlWarningIssued = true;
      this.logger.warn(resolved.warning);
    }
    return resolved.url;
  }
}

/**
 * LegacyPanelRefusal
 * ══════════════════
 * The one place a panel this build no longer supports is turned away.
 *
 * Support for Remnawave 2.x was removed deliberately, with the alternative
 * named and rejected: letting 3.x-shaped requests go out and collect `400`s at
 * fourteen different call sites. Those `400`s are classified as terminal by
 * the sync layer, so a 2.x operator would watch their subscriptions quietly
 * stop converging with nothing anywhere saying why. A refusal that names the
 * remedy is worth more than fourteen accurate error codes.
 *
 * ── Two things this deliberately does NOT do ────────────────────────────────
 *
 * It does not refuse an UNKNOWN version. Unknown means the version probe did
 * not answer — an unreachable panel, an expired token, a slow moment — and it
 * is a state every healthy 3.x panel passes through. A refusal keyed on it
 * fires exactly when the panel is already struggling, and the sync layer reads
 * "cannot act" as transient, so the result is an endless retry loop with no
 * alert. `stale-panel-link.ts` reached the same conclusion for its own guard
 * and recorded it. Unknown therefore proceeds AS 3.X — which after this change
 * is the only supported era and so the only sensible guess. That is the exact
 * inverse of the old default, where unknown meant 2.x at eight sites out of
 * nine, and it is the single behavioural change this refusal carries with it.
 *
 * It does not gate the version probe itself. The probe is what produces the
 * answer this gate reads, so gating it would be a circular wait. That is
 * enforced structurally rather than by an allowlist of paths: the client that
 * probes is built on the BARE transport, everything else on this wrapper.
 */
export class LegacyPanelRefusal implements PanelTransport {
  public constructor(
    private readonly inner: PanelTransport,
    /** Reads the detected major, or `null` when the probe has no answer yet. */
    private readonly readPanelMajor: () => Promise<number | null>,
  ) {}

  public async send(
    input: Parameters<PanelTransport['send']>[0],
  ): Promise<PanelTransportResult> {
    const major = await this.readPanelMajor();
    if (major !== null && major < 3) {
      return {
        kind: 'rejected',
        status: 0,
        code: LEGACY_PANEL_REFUSAL_CODE,
        detail: LEGACY_PANEL_REFUSAL_MESSAGE,
        retryAfterMs: null,
      };
    }
    return this.inner.send(input);
  }
}

/**
 * `status: 0` above is not an HTTP status and is not meant to look like one:
 * no request was made. The code is what callers should branch on.
 */
export const LEGACY_PANEL_REFUSAL_CODE = 'REZEIS_PANEL_TOO_OLD';

export const LEGACY_PANEL_REFUSAL_MESSAGE =
  'Панель Remnawave версии 2.x больше не поддерживается. ' +
  'Обновите панель до 3.x — до этого синхронизация профилей, устройств и подписок работать не будет.';

/** Appends defined query parameters; leaves the path untouched when there are none. */
function appendQuery(
  url: string,
  query: Readonly<Record<string, string | number | undefined>> | undefined,
): string {
  if (query === undefined) return url;
  const parts = Object.entries(query)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  if (parts.length === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${parts.join('&')}`;
}

/**
 * The panel's `A0xx` code out of an error envelope.
 *
 * Both spellings are read because the panel uses both and they drift
 * independently — the same reason the code this replaces read both.
 */
function readPanelErrorCode(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const code = record['errorCode'] ?? record['code'];
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function readPanelErrorMessage(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const message = (data as Record<string, unknown>)['message'];
  return typeof message === 'string' && message.length > 0 ? message.slice(0, 300) : null;
}

function parseRetryAfterMs(headers: unknown): number | null {
  if (headers === null || typeof headers !== 'object') return null;
  const raw = (headers as Record<string, unknown>)['retry-after'];
  const value =
    typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : null;
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}
