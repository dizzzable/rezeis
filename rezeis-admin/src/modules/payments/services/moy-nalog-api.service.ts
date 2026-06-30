import { createHash } from 'node:crypto';

import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { MOY_NALOG_BASE_URL } from '../constants/moy-nalog.constant';

/**
 * Authentication material for the «Мой Налог» (lknpd.nalog.ru) self-employed
 * cabinet. A fresh access token is obtained per call because income-register
 * jobs are infrequent and lknpd tokens are short-lived.
 */
export interface MoyNalogAuth {
  readonly method: 'password' | 'refresh';
  readonly inn?: string;
  readonly password?: string;
  readonly refreshToken?: string;
  readonly deviceId?: string;
  readonly proxy?: string;
  /**
   * Invoked when lknpd rotates the refresh token during `refresh` auth (the
   * `/api/v1/auth/token` response carries a new `refreshToken`). The caller
   * persists it so the next job authenticates with the current token —
   * otherwise the sync silently breaks after the first rotation. Mirrors the
   * reference port's `on_refresh_token` hook. Never called for `password` auth.
   */
  readonly onRefreshToken?: (refreshToken: string) => void | Promise<void>;
}

interface MoyNalogResponse {
  readonly status: number;
  readonly data: Record<string, unknown> | null;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  Origin: 'https://lknpd.nalog.ru/',
  Referer: 'https://lknpd.nalog.ru/',
  'User-Agent': USER_AGENT,
};

/**
 * Thin client for the «Мой Налог» income endpoints, ported from the Python
 * project `grandvan709/yookassa-to-mynalog`. Every public method is
 * best-effort: a network error, lknpd outage, or unexpected payload is logged
 * and swallowed so the payment-completion flow is never blocked. Secrets
 * (token / password / refreshToken / proxy credentials) are never logged.
 */
@Injectable()
export class MoyNalogApiService {
  private readonly logger = new Logger(MoyNalogApiService.name);

  public constructor(private readonly httpService: HttpService) {}

  /**
   * Authenticates against lknpd, registers the payment as self-employed
   * income, and returns the approved receipt UUID. Returns `null` on any
   * failure (logged) and never throws.
   */
  public async registerIncome(input: {
    readonly auth: MoyNalogAuth;
    readonly name: string;
    readonly amount: number;
    readonly date: Date;
  }): Promise<string | null> {
    try {
      const token = await this.authenticate(input.auth);
      if (token === null) {
        return null;
      }
      const body = buildIncomeBody({
        name: input.name,
        amount: input.amount,
        date: input.date,
      });
      let data: Record<string, unknown> | null = null;
      try {
        data = await this.postWithReauth(input.auth, token, '/api/v1/income', body);
      } catch (postError: unknown) {
        // The POST threw after lknpd may have already created the receipt
        // (e.g. a dropped response). Recover the existing receipt instead of
        // letting a retry register the income a second time.
        this.logger.warn(`МойНалог income POST failed, attempting receipt recovery: ${describeError(postError)}`);
        return await this.findIncomeReceipt(input.auth, token, input.name, input.amount);
      }
      const receiptUuid = data === null ? undefined : data['approvedReceiptUuid'];
      if (typeof receiptUuid === 'string' && receiptUuid.length > 0) {
        return receiptUuid;
      }
      // No receipt in the response (non-2xx or missing field). The income may
      // still have been recorded — look it up so a retry does not double-file.
      this.logger.warn('МойНалог income response is missing approvedReceiptUuid — attempting receipt recovery');
      return await this.findIncomeReceipt(input.auth, token, input.name, input.amount);
    } catch (error: unknown) {
      this.logger.error(`МойНалог registerIncome failed: ${describeError(error)}`);
      return null;
    }
  }

  /**
   * Looks up an already-registered, non-cancelled income receipt matching the
   * given name + amount within the last 7 days, reusing the token from the
   * caller. Mirrors the reference port's `find_income` safety net: it turns a
   * lost-response into an idempotent recovery so the same payment is never
   * filed twice. Returns `null` when no match exists or the lookup fails.
   */
  private async findIncomeReceipt(
    auth: MoyNalogAuth,
    token: string,
    name: string,
    amount: number,
  ): Promise<string | null> {
    try {
      const data = await this.getWithReauth(auth, token, buildIncomesQueryPath(new Date()));
      if (data === null) {
        return null;
      }
      const content = data['content'];
      if (!Array.isArray(content)) {
        return null;
      }
      const matches: string[] = [];
      for (const entry of content) {
        const record = (entry ?? {}) as Record<string, unknown>;
        if (record['cancellationInfo'] !== null && record['cancellationInfo'] !== undefined) {
          continue;
        }
        const entryName = typeof record['name'] === 'string' ? record['name'] : null;
        const entryTotal = Number(record['totalAmount']);
        const receipt = record['approvedReceiptUuid'];
        if (
          entryName === name &&
          Number.isFinite(entryTotal) &&
          entryTotal === amount &&
          typeof receipt === 'string' &&
          receipt.length > 0
        ) {
          matches.push(receipt);
        }
      }
      // Only reuse an existing receipt when the match is unambiguous. If two
      // incomes share the same name + amount in the window we cannot tell
      // which one belongs to this transaction, so we decline the recovery
      // rather than risk attributing someone else's receipt (which would
      // under-report this income). A blank-template default keeps the plan
      // name as the income name, so collisions are possible for identical
      // same-day purchases — declining is the safe choice.
      if (matches.length === 1) {
        this.logger.log('МойНалог recovered an existing receipt for a lost income response');
        return matches[0];
      }
      if (matches.length > 1) {
        this.logger.warn(
          `МойНалог receipt recovery is ambiguous (${matches.length} matches) — declining to reuse`,
        );
      }
      return null;
    } catch (error: unknown) {
      this.logger.warn(`МойНалог findIncome failed: ${describeError(error)}`);
      return null;
    }
  }

  /**
   * Cancels a previously-registered income receipt. Implemented for a
   * future/manual refund flow — no trigger is wired in v1. Returns `true`
   * only when lknpd accepted the cancellation.
   */
  public async cancelIncome(input: {
    readonly auth: MoyNalogAuth;
    readonly receiptUuid: string;
  }): Promise<boolean> {
    try {
      const token = await this.authenticate(input.auth);
      if (token === null) {
        return false;
      }
      const now = new Date();
      const body = {
        operationTime: toMoscowIsoSeconds(now),
        requestTime: toMoscowIsoSeconds(now),
        comment: 'Возврат средств',
        receiptUuid: input.receiptUuid,
      };
      const data = await this.postWithReauth(input.auth, token, '/api/v1/cancel', body);
      return data !== null;
    } catch (error: unknown) {
      this.logger.error(`МойНалог cancelIncome failed: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * Obtains an access token via the configured method. Returns `null` when
   * required credentials are missing or lknpd rejects the request.
   */
  private async authenticate(auth: MoyNalogAuth): Promise<string | null> {
    const deviceId = resolveDeviceId(auth);
    if (deviceId === null) {
      this.logger.warn('МойНалог auth skipped: device id could not be resolved (set INN or deviceId)');
      return null;
    }
    const deviceInfo = buildDeviceInfo(deviceId);
    const proxyUrl = normalize(auth.proxy);

    if (auth.method === 'password') {
      const inn = normalize(auth.inn);
      const password = normalize(auth.password);
      if (inn === null || password === null) {
        this.logger.warn('МойНалог password auth skipped: INN or password missing');
        return null;
      }
      const response = await this.request(
        'POST',
        '/api/v1/auth/lkfl',
        { username: inn, password, deviceInfo },
        { proxyUrl },
      );
      return this.readToken(response, 'password');
    }

    const refreshToken = normalize(auth.refreshToken);
    if (refreshToken === null) {
      this.logger.warn('МойНалог refresh auth skipped: refresh token missing');
      return null;
    }
    const response = await this.request(
      'POST',
      '/api/v1/auth/token',
      { deviceInfo, refreshToken },
      { proxyUrl },
    );
    const token = this.readToken(response, 'refresh');
    if (token !== null && response.data !== null) {
      const rotated = response.data['refreshToken'];
      if (
        typeof rotated === 'string' &&
        rotated.length > 0 &&
        rotated !== refreshToken &&
        auth.onRefreshToken !== undefined
      ) {
        try {
          await auth.onRefreshToken(rotated);
        } catch (error: unknown) {
          this.logger.warn(`МойНалог refresh-token persist failed: ${describeError(error)}`);
        }
      }
    }
    return token;
  }

  private readToken(response: MoyNalogResponse, method: MoyNalogAuth['method']): string | null {
    if (response.status < 200 || response.status >= 300 || response.data === null) {
      this.logger.warn(`МойНалог ${method} auth failed with status ${response.status}`);
      return null;
    }
    const token = response.data['token'];
    if (typeof token !== 'string' || token.length === 0) {
      this.logger.warn('МойНалог auth response is missing token');
      return null;
    }
    return token;
  }

  /**
   * Posts an authorized request, re-authenticating exactly once if lknpd
   * answers 401 (an expired access token). Returns the parsed JSON body on a
   * 2xx response, or `null` otherwise.
   */
  private async postWithReauth(
    auth: MoyNalogAuth,
    initialToken: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const proxyUrl = normalize(auth.proxy);
    let token = initialToken;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.request('POST', path, body, { proxyUrl, bearerToken: token });
      if (response.status === 401 && attempt === 0) {
        const refreshed = await this.authenticate(auth);
        if (refreshed === null) {
          return null;
        }
        token = refreshed;
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        return response.data ?? {};
      }
      this.logger.warn(`МойНалог ${path} failed with status ${response.status}`);
      return null;
    }
    return null;
  }

  /**
   * GET variant of {@link postWithReauth}: issues an authorized read,
   * re-authenticating exactly once on 401. Returns the parsed JSON body on a
   * 2xx response, or `null` otherwise.
   */
  private async getWithReauth(
    auth: MoyNalogAuth,
    initialToken: string,
    path: string,
  ): Promise<Record<string, unknown> | null> {
    const proxyUrl = normalize(auth.proxy);
    let token = initialToken;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.request('GET', path, null, { proxyUrl, bearerToken: token });
      if (response.status === 401 && attempt === 0) {
        const refreshed = await this.authenticate(auth);
        if (refreshed === null) {
          return null;
        }
        token = refreshed;
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        return response.data ?? {};
      }
      this.logger.warn(`МойНалог ${path} failed with status ${response.status}`);
      return null;
    }
    return null;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | null,
    options: { readonly proxyUrl: string | null; readonly bearerToken?: string },
  ): Promise<MoyNalogResponse> {
    const headers: Record<string, string> = { ...BROWSER_HEADERS };
    if (options.bearerToken !== undefined) {
      headers.Authorization = `Bearer ${options.bearerToken}`;
    }
    const config: AxiosRequestConfig = {
      method,
      url: `${MOY_NALOG_BASE_URL}${path}`,
      headers,
      // Inspect the status code ourselves so a 401 can trigger a single
      // re-auth instead of being thrown as an error.
      validateStatus: () => true,
      // Disable axios' built-in proxy handling — when configured we route
      // through an explicit SOCKS5 agent instead (lknpd often blocks
      // non-RU IPs).
      proxy: false,
    };
    if (body !== null) {
      config.data = body;
    }
    if (options.proxyUrl !== null) {
      const proxyAgent = new SocksProxyAgent(options.proxyUrl);
      config.httpsAgent = proxyAgent;
      config.httpAgent = proxyAgent;
    }
    const response: AxiosResponse<unknown> = await firstValueFrom(this.httpService.request(config));
    return {
      status: response.status,
      data: asRecord(response.data),
    };
  }
}

function buildDeviceInfo(deviceId: string): Record<string, unknown> {
  return {
    sourceDeviceId: deviceId,
    sourceType: 'WEB',
    appVersion: '1.0.0',
    metaDetails: {
      userAgent: USER_AGENT,
    },
  };
}

function buildIncomeBody(input: {
  readonly name: string;
  readonly amount: number;
  readonly date: Date;
}): Record<string, unknown> {
  return {
    operationTime: toMoscowIsoSeconds(input.date),
    requestTime: toMoscowIsoSeconds(new Date()),
    services: [
      {
        name: input.name,
        amount: input.amount,
        quantity: 1,
      },
    ],
    totalAmount: formatAmount(input.amount),
    client: {
      contactPhone: null,
      displayName: null,
      inn: null,
      incomeType: 'FROM_INDIVIDUAL',
    },
    paymentType: 'CASH',
    ignoreMaxTotalIncomeRestriction: false,
  };
}

/**
 * Resolves the lknpd device id: the operator-provided value when set,
 * otherwise the first 21 hex chars of `sha256(INN)` (mirrors the Python
 * port). Returns `null` when neither a device id nor an INN is available.
 */
function resolveDeviceId(auth: MoyNalogAuth): string | null {
  const explicit = normalize(auth.deviceId);
  if (explicit !== null) {
    return explicit;
  }
  const inn = normalize(auth.inn);
  if (inn === null) {
    return null;
  }
  return createHash('sha256').update(inn).digest('hex').slice(0, 21);
}

function formatAmount(amount: number): string {
  return String(amount);
}

/** Formats a date as an ISO8601 seconds-precision string in Moscow time (UTC+3). */
function toMoscowIsoSeconds(date: Date): string {
  const moscow = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const year = moscow.getUTCFullYear();
  const month = pad(moscow.getUTCMonth() + 1);
  const day = pad(moscow.getUTCDate());
  const hours = pad(moscow.getUTCHours());
  const minutes = pad(moscow.getUTCMinutes());
  const seconds = pad(moscow.getUTCSeconds());
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+03:00`;
}

/** Formats a date as an ISO8601 milliseconds-precision string in Moscow time (UTC+3). */
function toMoscowIsoMillis(date: Date): string {
  const moscow = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const millis = String(moscow.getUTCMilliseconds()).padStart(3, '0');
  return (
    `${moscow.getUTCFullYear()}-${pad(moscow.getUTCMonth() + 1)}-${pad(moscow.getUTCDate())}` +
    `T${pad(moscow.getUTCHours())}:${pad(moscow.getUTCMinutes())}:${pad(moscow.getUTCSeconds())}.${millis}+03:00`
  );
}

/**
 * Builds the `/api/v1/incomes` query used by the receipt-recovery lookup: the
 * last 7 days, newest first, capped at 50 rows (mirrors the reference port).
 */
function buildIncomesQueryPath(now: Date): string {
  const to = toMoscowIsoMillis(now);
  const from = toMoscowIsoMillis(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const params = new URLSearchParams({
    from,
    to,
    offset: '0',
    sortBy: 'operation_time:desc',
    limit: '50',
  });
  return `/api/v1/incomes?${params.toString()}`;
}

function normalize(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
