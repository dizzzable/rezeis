import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

describe('RemnawaveApiService', () => {
  it('maps auth status from the official Remnawave contract', async () => {
    const capturedPaths: string[] = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly url: string }) => {
          capturedPaths.push(input.url);
          return of({
            data: {
              response: {
                isLoginAllowed: true,
                isRegisterAllowed: false,
                authentication: {
                  passkey: { enabled: true },
                  oauth2: { providers: { github: true } },
                  password: { enabled: true },
                },
                branding: {
                  title: 'Panel',
                  logoUrl: null,
                },
              },
            },
          });
        },
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    const actualStatus = await service.getStatus();

    assert.deepStrictEqual(capturedPaths, ['/api/auth/status']);
    assert.deepStrictEqual(actualStatus, {
      isConfigured: true,
      isReachable: true,
      isLoginAllowed: true,
      isRegisterAllowed: false,
      authentication: {
        passwordEnabled: true,
        passkeyEnabled: true,
        oauth2Providers: { github: true },
      },
      branding: {
        title: 'Panel',
        logoUrl: null,
      },
    });
  });

  it('returns an offline status snapshot when remnawave is not configured', async () => {
    const service = new RemnawaveApiService(
      { request: () => of({ data: {} }) } as never,
      {
        host: null,
        port: null,
        token: null,
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    assert.deepStrictEqual(await service.getStatus(), {
      isConfigured: false,
      isReachable: false,
      isLoginAllowed: null,
      isRegisterAllowed: null,
      authentication: null,
      branding: null,
    });
  });

  it('maps internal and external squad option payloads from Remnawave', async () => {
    const capturedPaths: string[] = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly url: string }) => {
          capturedPaths.push(input.url);
          if (input.url === '/api/internal-squads/') {
            return of({
              data: {
                response: {
                  total: 1,
                  internalSquads: [createInternalSquadPayload('11111111-1111-1111-1111-111111111111', 'Core')],
                },
              },
            });
          }
          return of({
            data: {
              response: {
                total: 1,
                externalSquads: [createExternalSquadPayload('22222222-2222-2222-2222-222222222222', 'Public')],
              },
            },
          });
        },
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    const internalSquads = await service.getInternalSquadOptions();
    const externalSquads = await service.getExternalSquadOptions();

    assert.deepStrictEqual(capturedPaths, ['/api/internal-squads/', '/api/external-squads/']);
    assert.deepStrictEqual(internalSquads, [{ uuid: '11111111-1111-1111-1111-111111111111', name: 'Core' }]);
    assert.deepStrictEqual(externalSquads, [{ uuid: '22222222-2222-2222-2222-222222222222', name: 'Public' }]);
  });

  it('raises a stable service-unavailable error when remnawave is not configured or upstream fails', async () => {
    const unconfiguredService = new RemnawaveApiService(
      { request: () => of({ data: {} }) } as never,
      {
        host: null,
        port: null,
        token: null,
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    await assert.rejects(
      async () => {
        await unconfiguredService.getInternalSquadOptions();
      },
      {
        name: 'ServiceUnavailableException',
        message: 'Remnawave integration is not configured',
      },
    );

    const failingService = new RemnawaveApiService(
      { request: () => throwError(() => new Error('upstream failed')) } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    await assert.rejects(
      async () => {
        await failingService.getExternalSquadOptions();
      },
      {
        name: 'ServiceUnavailableException',
        message: 'Remnawave integration is unavailable',
      },
    );
  });

  it('lists panel HWID devices by user UUID and maps the payload', async () => {
    const capturedRequests: Array<{
      readonly method?: string;
      readonly url: string;
      readonly data?: unknown;
    }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          capturedRequests.push(input);
          return of({
            data: {
              response: {
                total: 1,
                devices: [
                  {
                    hwid: 'hwid-1',
                    userId: 1,
                    platform: 'ios',
                    osVersion: '17.4',
                    deviceModel: 'iPhone 15 Pro',
                    userAgent: 'Rezeis/1.0',
                    createdAt: '2026-04-19T10:00:00.000Z',
                    updatedAt: '2026-04-20T11:30:00.000Z',
                  },
                ],
              },
            },
          });
        },
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    const actualDevices = await service.getPanelUserDevices('33333333-3333-4333-8333-333333333333');

    assert.deepStrictEqual(capturedRequests.map(projectRequestContractShape), [
      { method: 'get', url: '/api/hwid/devices/33333333-3333-4333-8333-333333333333' },
    ]);
    assert.deepStrictEqual(actualDevices, {
      total: 1,
      devices: [
        {
          hwid: 'hwid-1',
          platform: 'ios',
          osVersion: '17.4',
          deviceModel: 'iPhone 15 Pro',
          userAgent: 'Rezeis/1.0',
          lastSeenAt: '2026-04-20T11:30:00.000Z',
          createdAt: '2026-04-19T10:00:00.000Z',
        },
      ],
    });
  });

  it('deletes one panel HWID device by user UUID and hwid', async () => {
    const capturedRequests: Array<{
      readonly method?: string;
      readonly url: string;
      readonly data?: unknown;
    }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          capturedRequests.push(input);
          return of({
            data: {
              response: {
                total: 0,
                devices: [],
              },
            },
          });
        },
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    const result = await service.deletePanelUserDevice(
      '33333333-3333-4333-8333-333333333333',
      'hwid-to-delete',
    );

    assert.deepStrictEqual(capturedRequests.map(projectRequestContractShape), [
      {
        method: 'post',
        url: '/api/hwid/devices/delete',
        data: {
          userUuid: '33333333-3333-4333-8333-333333333333',
          hwid: 'hwid-to-delete',
        },
      },
    ]);
    assert.deepStrictEqual(result, { total: 0 });
  });

  it('updates a panel user through the current Remnawave PATCH /api/users contract', async () => {
    const capturedRequests: Array<{ readonly method?: string; readonly url: string; readonly data?: unknown }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          capturedRequests.push(projectRequestContractShape(input));
          return of({
            data: {
              response: {
                uuid: '33333333-3333-4333-8333-333333333333',
                username: 'rezeis-user',
                status: 'ACTIVE',
                subscriptionUrl: 'https://example.com/subscription',
                telegramId: null,
                email: null,
                expireAt: '2026-06-01T00:00:00.000Z',
                trafficLimitBytes: 1073741824,
                hwidDeviceLimit: 3,
                trafficLimitStrategy: null,
                tag: null,
                description: null,
                activeInternalSquads: [],
                externalSquadUuid: null,
              },
            },
          });
        },
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    const updatedUser = await service.updatePanelUser('33333333-3333-4333-8333-333333333333', {
      expireAt: '2026-06-01T00:00:00.000Z',
      status: 'ACTIVE',
      trafficLimitBytes: 1073741824,
      hwidDeviceLimit: 3,
    });

    assert.deepStrictEqual(capturedRequests, [
      {
        method: 'patch',
        url: '/api/users',
        data: {
          uuid: '33333333-3333-4333-8333-333333333333',
          status: 'ACTIVE',
          expireAt: '2026-06-01T00:00:00.000Z',
          trafficLimitBytes: 1073741824,
          hwidDeviceLimit: 3,
        },
      },
    ]);
    assert.equal(updatedUser.uuid, '33333333-3333-4333-8333-333333333333');
    assert.equal(updatedUser.status, 'ACTIVE');
  });

  it('redacts sensitive Remnawave node status messages from API responses', async () => {
    const rawStatusMessage = 'node failed https://remnawave.example/profile/0194f4b6-7cc7-7ecb-9f62-123456789abc?token=raw-token-secret subscriptionUrl=configUrl auth cookie';
    const service = new RemnawaveApiService(
      {
        request: () => of({
          data: {
            response: [
              createNodePayload({
                uuid: '11111111-1111-4111-8111-111111111111',
                name: 'Node A',
                lastStatusMessage: rawStatusMessage,
              }),
              createNodePayload({
                uuid: '22222222-2222-4222-8222-222222222222',
                name: 'Node B',
                lastStatusMessage: 'Node is online',
              }),
              createNodePayload({
                uuid: '33333333-3333-4333-8333-333333333333',
                name: 'Node C',
                lastStatusMessage: 'Authentication failed',
              }),
              createNodePayload({
                uuid: '44444444-4444-4444-8444-444444444444',
                name: 'Node D',
                lastStatusMessage: 'Profile not assigned',
              }),
              createNodePayload({
                uuid: '55555555-5555-4555-8555-555555555555',
                name: 'Node E',
                lastStatusMessage: 'auth=Bearer raw-remnawave-node-token',
              }),
            ],
          },
        }),
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null, caddyToken: null, cookie: null },
    );

    const actualNodes = await service.getAllNodes();
    const serializedNodes = JSON.stringify(actualNodes);

    assert.equal(actualNodes[0]?.lastStatusMessage, 'REMNAWAVE_NODE_STATUS_MESSAGE_HIDDEN');
    assert.equal(actualNodes[1]?.lastStatusMessage, 'Node is online');
    assert.equal(actualNodes[2]?.lastStatusMessage, 'Authentication failed');
    assert.equal(actualNodes[3]?.lastStatusMessage, 'Profile not assigned');
    assert.equal(actualNodes[4]?.lastStatusMessage, 'REMNAWAVE_NODE_STATUS_MESSAGE_HIDDEN');
    assert.equal(serializedNodes.includes(rawStatusMessage), false);
    assert.equal(serializedNodes.includes('https://remnawave.example'), false);
    assert.equal(serializedNodes.includes('raw-token-secret'), false);
    assert.equal(serializedNodes.includes('raw-remnawave-node-token'), false);
    assert.equal(serializedNodes.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false);
  });

  it('hides raw Happ subscription delivery metadata while preserving safe settings fields', async () => {
    const supportLink = 'https://support.example/help';
    const rawHappAnnounce = '{"profile":"https://profile.example/config","token":"raw-happ-token-secret"}';
    const rawHappRouting = 'configUrl=https://config.example/raw-route-token-secret';
    const service = new RemnawaveApiService(
      {
        request: () => of({
          data: {
            response: {
              uuid: '11111111-1111-4111-8111-111111111111',
              profileTitle: 'Safe profile title',
              supportLink,
              profileUpdateInterval: 12,
              isProfileWebpageUrlEnabled: true,
              serveJsonAtBaseSubscription: false,
              isShowCustomRemarks: true,
              customRemarks: {
                expiredUsers: ['expired'],
                limitedUsers: ['limited'],
                disabledUsers: ['disabled'],
                emptyHosts: ['empty'],
                HWIDMaxDevicesExceeded: ['max'],
                HWIDNotSupported: ['unsupported'],
              },
              randomizeHosts: false,
              happAnnounce: rawHappAnnounce,
              happRouting: rawHappRouting,
              customResponseHeaders: null,
              responseRules: null,
              hwidSettings: null,
              createdAt: '2026-04-19T10:00:00.000Z',
              updatedAt: '2026-04-19T10:00:00.000Z',
            },
          },
        }),
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null, caddyToken: null, cookie: null },
    );

    const settings = await service.getSubscriptionSettings();
    const serializedSettings = JSON.stringify(settings);

    assert.equal(settings?.profileTitle, 'Safe profile title');
    assert.equal(settings?.supportLink, supportLink);
    assert.equal(settings?.hasHappAnnounce, true);
    assert.equal(settings?.hasHappRouting, true);
    assert.equal(serializedSettings.includes(rawHappAnnounce), false);
    assert.equal(serializedSettings.includes(rawHappRouting), false);
    assert.equal(serializedSettings.includes('raw-happ-token-secret'), false);
    assert.equal(serializedSettings.includes('raw-route-token-secret'), false);
  });

  it('resets subscription user traffic through the Remnawave reset-traffic action', async () => {
    const capturedRequests: Array<{ readonly method?: string; readonly url: string; readonly data?: unknown }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          capturedRequests.push(projectRequestContractShape(input));
          return of({ data: { response: { uuid: '33333333-3333-4333-8333-333333333333' } } });
        },
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null, caddyToken: null, cookie: null },
    );

    await service.resetPanelUserTraffic('33333333-3333-4333-8333-333333333333');

    assert.deepStrictEqual(capturedRequests, [
      { method: 'post', url: '/api/users/33333333-3333-4333-8333-333333333333/actions/reset-traffic' },
    ]);
  });
});

function createInternalSquadPayload(uuid: string, name: string): Record<string, unknown> {
  return {
    uuid,
    viewPosition: 1,
    name,
    info: {
      membersCount: 0,
      inboundsCount: 0,
    },
    inbounds: [],
    createdAt: '2026-04-19T10:00:00.000Z',
    updatedAt: '2026-04-19T10:00:00.000Z',
  };
}

function createExternalSquadPayload(uuid: string, name: string): Record<string, unknown> {
  return {
    uuid,
    viewPosition: 1,
    name,
    info: {
      membersCount: 0,
    },
    templates: [],
    subscriptionSettings: null,
    hostOverrides: null,
    responseHeaders: {},
    hwidSettings: null,
    customRemarks: null,
    subpageConfigUuid: null,
    createdAt: '2026-04-19T10:00:00.000Z',
    updatedAt: '2026-04-19T10:00:00.000Z',
  };
}

function createNodePayload(input: {
  readonly uuid: string;
  readonly name: string;
  readonly lastStatusMessage: string;
}): Record<string, unknown> {
  return {
    uuid: input.uuid,
    name: input.name,
    address: '203.0.113.10',
    port: 443,
    isConnected: true,
    isDisabled: false,
    isConnecting: false,
    isTrafficTrackingActive: true,
    trafficResetDay: null,
    trafficLimitBytes: null,
    trafficUsedBytes: 0,
    notifyPercent: null,
    viewPosition: 1,
    countryCode: 'DE',
    consumptionMultiplier: 1,
    tags: [],
    lastStatusChange: '2026-04-20T00:00:00.000Z',
    lastStatusMessage: input.lastStatusMessage,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-20T00:00:00.000Z',
    xrayUptime: 10,
    usersOnline: 2,
    configProfile: {
      activeConfigProfileUuid: '33333333-3333-4333-8333-333333333333',
      activeInbounds: [],
    },
    providerUuid: null,
    provider: null,
    activePluginUuid: null,
    system: null,
    versions: null,
  };
}

function projectRequestContractShape(input: {
  readonly method?: string;
  readonly url: string;
  readonly data?: unknown;
}): { readonly method?: string; readonly url: string; readonly data?: unknown } {
  if (input.data === undefined) {
    return {
      method: input.method,
      url: input.url,
    };
  }

  return {
    method: input.method,
    url: input.url,
    data: input.data,
  };
}
