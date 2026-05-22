import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { GetExternalSquadsCommand, GetInternalSquadsCommand, GetStatusCommand } from '@remnawave/backend-contract';
import { firstValueFrom } from 'rxjs';

import { remnawaveConfig } from '../../../common/config/remnawave.config';
import { RemnawaveSquadOptionInterface } from '../interfaces/remnawave-squad-option.interface';
import { RemnawaveStatusInterface } from '../interfaces/remnawave-status.interface';
import {
  RemnawaveBandwidthStatsInterface,
  RemnawaveSystemRecapInterface,
  RemnawaveSystemStatsInterface,
} from '../interfaces/remnawave-system-stats.interface';
import { RemnawaveNodeInterface } from '../interfaces/remnawave-node.interface';
import { RemnawaveHostInterface } from '../interfaces/remnawave-host.interface';
import { RemnawaveHwidStatsInterface } from '../interfaces/remnawave-hwid-stats.interface';
import { RemnawaveConfigProfileInterface } from '../interfaces/remnawave-config-profile.interface';

/**
 * Remnawave panel user — shape returned by the panel API.
 */
export interface RemnawavePanelUser {
  uuid: string;
  username: string;
  status: string;
  subscriptionUrl: string;
  telegramId: number | null;
  email: string | null;
  expireAt: string;
  trafficLimitBytes: number;
  hwidDeviceLimit: number;
  trafficLimitStrategy: string | null;
  tag: string | null;
  description: string | null;
  activeInternalSquads: Array<{ uuid: string; name: string }>;
  externalSquadUuid: string | null;
}

export interface RemnawaveHwidDevice {
  hwid: string;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

@Injectable()
export class RemnawaveApiService {
  private readonly logger = new Logger(RemnawaveApiService.name);

  public constructor(
    private readonly httpService: HttpService,
    @Inject(remnawaveConfig.KEY)
    private readonly configuration: ConfigType<typeof remnawaveConfig>,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  USER CRUD (Remnawave Panel)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Creates a user on the Remnawave panel.
   * Donor: `remnawave_sync_crud.create_user`.
   */
  public async createPanelUser(input: {
    username: string;
    telegramId: number | null;
    email: string | null;
    description: string;
    tag: string | null;
    expireAt: string; // ISO datetime
    trafficLimitBytes: number;
    hwidDeviceLimit: number;
    trafficLimitStrategy: string | null;
    activeInternalSquads: string[];
    externalSquadUuid: string | null;
  }): Promise<RemnawavePanelUser> {
    return this.requestJsonWithBody<RemnawavePanelUser>('post', '/api/users', {
      username: input.username,
      telegram_id: input.telegramId,
      email: input.email,
      description: input.description,
      tag: input.tag,
      expire_at: input.expireAt,
      traffic_limit_bytes: input.trafficLimitBytes,
      hwid_device_limit: input.hwidDeviceLimit,
      traffic_limit_strategy: input.trafficLimitStrategy,
      active_internal_squads: input.activeInternalSquads,
      external_squad_uuid: input.externalSquadUuid,
    });
  }

  /**
   * Updates a user on the Remnawave panel.
   * Donor: `remnawave_sync_crud.updated_user`.
   */
  public async updatePanelUser(
    uuid: string,
    input: {
      status?: string;
      telegramId?: number | null;
      email?: string | null;
      description?: string;
      tag?: string | null;
      expireAt?: string;
      trafficLimitBytes?: number;
      hwidDeviceLimit?: number;
      trafficLimitStrategy?: string | null;
      activeInternalSquads?: string[];
      externalSquadUuid?: string | null;
    },
  ): Promise<RemnawavePanelUser> {
    const body: Record<string, unknown> = { uuid };
    if (input.status !== undefined) body['status'] = input.status;
    if (input.telegramId !== undefined) body['telegram_id'] = input.telegramId;
    if (input.email !== undefined) body['email'] = input.email;
    if (input.description !== undefined) body['description'] = input.description;
    if (input.tag !== undefined) body['tag'] = input.tag;
    if (input.expireAt !== undefined) body['expire_at'] = input.expireAt;
    if (input.trafficLimitBytes !== undefined) body['traffic_limit_bytes'] = input.trafficLimitBytes;
    if (input.hwidDeviceLimit !== undefined) body['hwid_device_limit'] = input.hwidDeviceLimit;
    if (input.trafficLimitStrategy !== undefined) body['traffic_limit_strategy'] = input.trafficLimitStrategy;
    if (input.activeInternalSquads !== undefined) body['active_internal_squads'] = input.activeInternalSquads;
    if (input.externalSquadUuid !== undefined) body['external_squad_uuid'] = input.externalSquadUuid;
    return this.requestJsonWithBody<RemnawavePanelUser>('patch', `/api/users/${uuid}`, body);
  }

  /**
   * Deletes a user from the Remnawave panel.
   */
  public async deletePanelUser(uuid: string): Promise<{ isDeleted: boolean }> {
    return this.requestJson<{ isDeleted: boolean }>({ method: 'delete', url: `/api/users/${uuid}` });
  }

  /**
   * Resets traffic counter for a user on the panel.
   */
  public async resetPanelUserTraffic(uuid: string): Promise<void> {
    await this.requestJson({ method: 'post', url: `/api/users/${uuid}/reset-traffic` });
  }

  /**
   * Gets a user by UUID from the panel.
   */
  public async getPanelUser(uuid: string): Promise<RemnawavePanelUser | null> {
    try {
      return await this.requestJson<RemnawavePanelUser>({ method: 'get', url: `/api/users/${uuid}` });
    } catch {
      return null;
    }
  }

  /**
   * Gets all users by telegram_id from the panel.
   */
  public async getPanelUsersByTelegramId(telegramId: string): Promise<RemnawavePanelUser[]> {
    try {
      const result = await this.requestJson<RemnawavePanelUser[] | { root: RemnawavePanelUser[] }>({
        method: 'get',
        url: `/api/users/telegram/${telegramId}`,
      });
      return Array.isArray(result) ? result : result.root ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Gets HWID devices for a user by UUID.
   */
  public async getPanelUserDevices(uuid: string): Promise<{ devices: RemnawaveHwidDevice[]; total: number }> {
    try {
      const result = await this.requestJson<{ devices: RemnawaveHwidDevice[]; total: number }>({
        method: 'get',
        url: `/api/hwid/user/${uuid}`,
      });
      return result;
    } catch {
      return { devices: [], total: 0 };
    }
  }

  /**
   * Deletes a specific HWID device from a user.
   */
  public async deletePanelUserDevice(userUuid: string, hwid: string): Promise<{ total: number }> {
    return this.requestJsonWithBody<{ total: number }>('delete', '/api/hwid/user', {
      user_uuid: userUuid,
      hwid,
    });
  }

  /**
   * Lists all users on the Remnawave panel, paginating through `/api/users`.
   *
   * Donor: altshop's `RemnawaveSDK.users.get_all` — but since we're inside
   * a Nest project we go via the same HTTP client used everywhere else.
   * The panel returns at most `pageSize` rows per call so we keep
   * iterating until the total is reached. A safety cap of 50 pages
   * (50 × 500 = 25 000 users) protects against runaway responses.
   */
  public async getAllPanelUsers(): Promise<RemnawavePanelUser[]> {
    const pageSize = 500
    const maxPages = 50
    const collected: RemnawavePanelUser[] = []

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const start = pageIndex * pageSize
      let response: { response?: { users?: unknown[]; total?: number }; users?: unknown[]; total?: number } | null = null
      try {
        response = await this.requestJson<typeof response>({
          method: 'get',
          url: `/api/users/?start=${start}&size=${pageSize}`,
        })
      } catch (err) {
        this.logger.warn(`getAllPanelUsers page ${pageIndex} failed: ${(err as Error).message}`)
        break
      }
      if (response === null) break
      const usersPayload = response.response?.users ?? response.users ?? []
      if (!Array.isArray(usersPayload) || usersPayload.length === 0) break

      for (const candidate of usersPayload) {
        if (typeof candidate !== 'object' || candidate === null) continue
        const value = candidate as Record<string, unknown>
        const uuid = typeof value.uuid === 'string' ? value.uuid : ''
        if (uuid.length === 0) continue
        collected.push({
          uuid,
          username: typeof value.username === 'string' ? value.username : '',
          status: typeof value.status === 'string' ? value.status : 'UNKNOWN',
          subscriptionUrl: typeof value.subscriptionUrl === 'string' ? value.subscriptionUrl : '',
          telegramId:
            typeof value.telegramId === 'number'
              ? value.telegramId
              : typeof value.telegram_id === 'number'
                ? (value.telegram_id as number)
                : null,
          email: typeof value.email === 'string' ? value.email : null,
          expireAt:
            typeof value.expireAt === 'string'
              ? value.expireAt
              : value.expireAt instanceof Date
                ? value.expireAt.toISOString()
                : '',
          trafficLimitBytes:
            typeof value.trafficLimitBytes === 'number' ? value.trafficLimitBytes : 0,
          hwidDeviceLimit:
            typeof value.hwidDeviceLimit === 'number' ? value.hwidDeviceLimit : 0,
          trafficLimitStrategy:
            typeof value.trafficLimitStrategy === 'string'
              ? value.trafficLimitStrategy
              : null,
          tag: typeof value.tag === 'string' ? value.tag : null,
          description: typeof value.description === 'string' ? value.description : null,
          activeInternalSquads: Array.isArray(value.activeInternalSquads)
            ? (value.activeInternalSquads as Array<{ uuid: string; name: string }>).filter(
                (squad) => typeof squad?.uuid === 'string' && typeof squad?.name === 'string',
              )
            : [],
          externalSquadUuid:
            typeof value.externalSquadUuid === 'string' ? value.externalSquadUuid : null,
        })
      }

      const totalReported = response.response?.total ?? response.total ?? null
      if (typeof totalReported === 'number' && collected.length >= totalReported) break
      if (usersPayload.length < pageSize) break
    }

    return collected
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SYSTEM STATS, NODES, HOSTS (panel proxy)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns system-wide statistics from the Remnawave panel.
   */
  public async getSystemStats(): Promise<RemnawaveSystemStatsInterface | null> {
    try {
      const response = await this.requestJson<{ response: RemnawaveSystemStatsInterface }>({
        method: 'get',
        url: '/api/system/stats',
      });
      return response.response ?? (response as unknown as RemnawaveSystemStatsInterface);
    } catch {
      return null;
    }
  }

  /**
   * Returns system recap (version, totals, this month).
   */
  public async getSystemRecap(): Promise<RemnawaveSystemRecapInterface | null> {
    try {
      const response = await this.requestJson<{ response: RemnawaveSystemRecapInterface }>({
        method: 'get',
        url: '/api/system/recap',
      });
      return response.response ?? (response as unknown as RemnawaveSystemRecapInterface);
    } catch {
      return null;
    }
  }

  /**
   * Returns bandwidth comparison stats.
   */
  public async getBandwidthStats(): Promise<RemnawaveBandwidthStatsInterface | null> {
    try {
      const response = await this.requestJson<{ response: RemnawaveBandwidthStatsInterface }>({
        method: 'get',
        url: '/api/system/bandwidth',
      });
      return response.response ?? (response as unknown as RemnawaveBandwidthStatsInterface);
    } catch {
      return null;
    }
  }

  /**
   * Returns all nodes from the panel.
   */
  public async getAllNodes(): Promise<RemnawaveNodeInterface[]> {
    try {
      const response = await this.requestJson<{ response: RemnawaveNodeInterface[] }>({
        method: 'get',
        url: '/api/nodes',
      });
      return response.response ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Enables a node by UUID.
   */
  public async enableNode(uuid: string): Promise<void> {
    await this.requestJsonWithBody('post', `/api/nodes/enable`, { uuid });
  }

  /**
   * Disables a node by UUID.
   */
  public async disableNode(uuid: string): Promise<void> {
    await this.requestJsonWithBody('post', `/api/nodes/disable`, { uuid });
  }

  /**
   * Restarts a node's xray core by UUID.
   */
  public async restartNode(uuid: string): Promise<void> {
    await this.requestJsonWithBody('post', `/api/nodes/restart`, { uuid });
  }

  /**
   * Resets traffic counter for a node.
   */
  public async resetNodeTraffic(uuid: string): Promise<void> {
    await this.requestJsonWithBody('post', `/api/nodes/reset-traffic`, { uuid });
  }

  /**
   * Returns all hosts from the panel.
   */
  public async getAllHosts(): Promise<RemnawaveHostInterface[]> {
    try {
      const response = await this.requestJson<{ response: RemnawaveHostInterface[] }>({
        method: 'get',
        url: '/api/hosts',
      });
      return response.response ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Returns HWID statistics.
   */
  public async getHwidStats(): Promise<RemnawaveHwidStatsInterface | null> {
    try {
      const response = await this.requestJson<{ response: RemnawaveHwidStatsInterface }>({
        method: 'get',
        url: '/api/hwid/stats',
      });
      return response.response ?? (response as unknown as RemnawaveHwidStatsInterface);
    } catch {
      return null;
    }
  }

  /**
   * Returns config profiles from the panel.
   */
  public async getConfigProfiles(): Promise<RemnawaveConfigProfileInterface[]> {
    try {
      const response = await this.requestJson<{ response: RemnawaveConfigProfileInterface[] }>({
        method: 'get',
        url: '/api/config-profiles',
      });
      return response.response ?? [];
    } catch {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SQUADS & STATUS (existing)
  // ═══════════════════════════════════════════════════════════════════════════

  public async getInternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    const payload = await this.requestJson<GetInternalSquadsCommand.Response>({
      method: GetInternalSquadsCommand.endpointDetails.REQUEST_METHOD,
      url: GetInternalSquadsCommand.url,
    });
    const parsedPayload = GetInternalSquadsCommand.ResponseSchema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new ServiceUnavailableException('Remnawave internal squads are unavailable');
    }
    return parsedPayload.data.response.internalSquads.map((squad) => ({
      uuid: squad.uuid,
      name: squad.name,
    }));
  }

  public async getExternalSquadOptions(): Promise<readonly RemnawaveSquadOptionInterface[]> {
    const payload = await this.requestJson<GetExternalSquadsCommand.Response>({
      method: GetExternalSquadsCommand.endpointDetails.REQUEST_METHOD,
      url: GetExternalSquadsCommand.url,
    });
    const parsedPayload = GetExternalSquadsCommand.ResponseSchema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new ServiceUnavailableException('Remnawave external squads are unavailable');
    }
    return parsedPayload.data.response.externalSquads.map((squad) => ({
      uuid: squad.uuid,
      name: squad.name,
    }));
  }

  public async getStatus(): Promise<RemnawaveStatusInterface> {
    if (!this.isConfigured()) {
      return {
        isConfigured: false,
        isReachable: false,
        isLoginAllowed: null,
        isRegisterAllowed: null,
        authentication: null,
        branding: null,
      };
    }
    try {
      const payload = await this.requestJson<GetStatusCommand.Response>({
        method: GetStatusCommand.endpointDetails.REQUEST_METHOD,
        url: GetStatusCommand.url,
      });
      const parsedPayload = GetStatusCommand.ResponseSchema.safeParse(payload);
      if (!parsedPayload.success) {
        throw new ServiceUnavailableException('Remnawave auth status is unavailable');
      }
      const { response } = parsedPayload.data;
      return {
        isConfigured: true,
        isReachable: true,
        isLoginAllowed: response.isLoginAllowed,
        isRegisterAllowed: response.isRegisterAllowed,
        authentication: response.authentication === null
          ? null
          : {
              passwordEnabled: response.authentication.password.enabled,
              passkeyEnabled: response.authentication.passkey.enabled,
              oauth2Providers: response.authentication.oauth2.providers,
            },
        branding: response.branding,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException('Remnawave auth status is unavailable');
    }
  }

  private async requestJson<TResponse>(input: {
    readonly method: 'post' | 'get' | 'put' | 'delete' | 'patch';
    readonly url: string;
  }): Promise<TResponse> {
    const baseUrl = this.getBaseUrl();
    const token = this.configuration.token;
    if (baseUrl === null || token === null) {
      throw new ServiceUnavailableException('Remnawave integration is not configured');
    }
    try {
      const response = await firstValueFrom(
        this.httpService.request<TResponse>({
          method: input.method,
          url: input.url,
          baseURL: baseUrl,
          headers: {
            Authorization: `Bearer ${token}`,
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
          },
        }),
      );
      return response.data;
    } catch {
      throw new ServiceUnavailableException('Remnawave integration is unavailable');
    }
  }

  private async requestJsonWithBody<TResponse>(
    method: 'post' | 'put' | 'patch' | 'delete',
    url: string,
    body: Record<string, unknown>,
  ): Promise<TResponse> {
    const baseUrl = this.getBaseUrl();
    const token = this.configuration.token;
    if (baseUrl === null || token === null) {
      throw new ServiceUnavailableException('Remnawave integration is not configured');
    }
    try {
      const response = await firstValueFrom(
        this.httpService.request<TResponse>({
          method,
          url,
          baseURL: baseUrl,
          data: body,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'https',
          },
        }),
      );
      return response.data;
    } catch (err: unknown) {
      this.logger.error(`Remnawave ${method.toUpperCase()} ${url} failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Remnawave integration is unavailable');
    }
  }

  private getBaseUrl(): string | null {
    if (this.configuration.host === null || this.configuration.port === null) {
      return null;
    }
    return `http://${this.configuration.host}:${this.configuration.port}`;
  }

  private isConfigured(): boolean {
    return this.getBaseUrl() !== null && this.configuration.token !== null;
  }
}
