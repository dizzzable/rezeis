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

  it('resolves user devices from a subscription identifier and maps the payload', async () => {
    const capturedRequests: Array<{
      readonly method?: string;
      readonly url: string;
      readonly data?: unknown;
    }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          capturedRequests.push(input);
          if (input.url === '/api/subscriptions/by-uuid/subscription-uuid-1') {
            return of({
              data: createSubscriptionByUuidResponse({
                isFound: true,
                shortUuid: 'short-user-1',
              }),
            });
          }
          if (input.url === '/api/users/by-short-uuid/short-user-1') {
            return of({
              data: createUserByShortUuidResponse({
                uuid: '33333333-3333-4333-8333-333333333333',
                shortUuid: 'short-user-1',
              }),
            });
          }
          if (input.url === '/api/users/resolve') {
            return of({ data: null });
          }
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
                    requestIp: '203.0.113.10',
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

    const actualDevices = await service.getUserSubscriptionDevices({
      remnawaveSubscriptionId: 'subscription-uuid-1',
    });

    assert.deepStrictEqual(capturedRequests.map(projectRequestContractShape), [
      { method: 'get', url: '/api/subscriptions/by-uuid/subscription-uuid-1' },
      { method: 'get', url: '/api/users/by-short-uuid/short-user-1' },
      { method: 'get', url: '/api/hwid/devices/33333333-3333-4333-8333-333333333333' },
    ]);
    assert.deepStrictEqual(actualDevices, {
      deviceCount: 1,
      devices: [
        {
          hwid: 'hwid-1',
          deviceName: 'iPhone 15 Pro',
          platform: 'ios',
          osVersion: '17.4',
          appVersion: null,
          userAgent: 'Rezeis/1.0',
          ipAddress: '203.0.113.10',
          lastSeenAt: '2026-04-20T11:30:00.000Z',
          createdAt: '2026-04-19T10:00:00.000Z',
        },
      ],
    });
  });

  it('deletes one subscription device by hwid through the contract delete command', async () => {
    const capturedRequests: Array<{
      readonly method?: string;
      readonly url: string;
      readonly data?: unknown;
    }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          capturedRequests.push(input);
          if (input.url === '/api/subscriptions/by-uuid/subscription-uuid-1') {
            return of({
              data: createSubscriptionByUuidResponse({
                isFound: true,
                shortUuid: 'short-user-1',
              }),
            });
          }
          if (input.url === '/api/users/by-short-uuid/short-user-1') {
            return of({
              data: createUserByShortUuidResponse({
                uuid: '33333333-3333-4333-8333-333333333333',
                shortUuid: 'short-user-1',
              }),
            });
          }
          if (input.url === '/api/users/resolve') {
            return of({ data: null });
          }
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

    await service.revokeUserSubscriptionDevice({
      remnawaveSubscriptionId: 'subscription-uuid-1',
      hwid: 'hwid-to-delete',
    });

    assert.deepStrictEqual(capturedRequests.map(projectRequestContractShape), [
      { method: 'get', url: '/api/subscriptions/by-uuid/subscription-uuid-1' },
      { method: 'get', url: '/api/users/by-short-uuid/short-user-1' },
      {
        method: 'post',
        url: '/api/hwid/devices/delete',
        data: {
          userUuid: '33333333-3333-4333-8333-333333333333',
          hwid: 'hwid-to-delete',
        },
      },
    ]);
  });

  it('creates one subscription HWID device through the OpenAPI v274 transport route', async () => {
    const capturedRequests: Array<{
      readonly method?: string;
      readonly url: string;
      readonly data?: unknown;
    }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          capturedRequests.push(input);
          if (input.url === '/api/subscriptions/by-uuid/subscription-uuid-1') {
            return of({
              data: createSubscriptionByUuidResponse({
                isFound: true,
                shortUuid: 'short-user-1',
              }),
            });
          }
          if (input.url === '/api/users/by-short-uuid/short-user-1') {
            return of({
              data: createUserByShortUuidResponse({
                uuid: '33333333-3333-4333-8333-333333333333',
                shortUuid: 'short-user-1',
              }),
            });
          }
          return of({
            data: {
              response: {
                total: 1,
                devices: [
                  {
                    hwid: 'created-hwid-1',
                    platform: 'android',
                    osVersion: '14',
                    deviceModel: 'Pixel 8',
                    userAgent: 'Rezeis/2.0',
                    requestIp: '203.0.113.20',
                    createdAt: '2026-04-21T10:00:00.000Z',
                    updatedAt: '2026-04-21T10:01:00.000Z',
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

    const actualDevices = await service.createUserSubscriptionDevice({
      remnawaveSubscriptionId: 'subscription-uuid-1',
      hwid: ' created-hwid-1 ',
      platform: ' android ',
      osVersion: '14',
      deviceModel: 'Pixel 8',
      userAgent: 'Rezeis/2.0',
    });

    assert.deepStrictEqual(capturedRequests.map(projectRequestContractShape), [
      { method: 'get', url: '/api/subscriptions/by-uuid/subscription-uuid-1' },
      { method: 'get', url: '/api/users/by-short-uuid/short-user-1' },
      {
        method: 'post',
        url: '/api/hwid/devices',
        data: {
          userUuid: '33333333-3333-4333-8333-333333333333',
          hwid: 'created-hwid-1',
          platform: 'android',
          osVersion: '14',
          deviceModel: 'Pixel 8',
          userAgent: 'Rezeis/2.0',
        },
      },
    ]);
    assert.deepStrictEqual(actualDevices, {
      deviceCount: 1,
      devices: [
        {
          hwid: 'created-hwid-1',
          deviceName: 'Pixel 8',
          platform: 'android',
          osVersion: '14',
          appVersion: null,
          userAgent: 'Rezeis/2.0',
          ipAddress: '203.0.113.20',
          lastSeenAt: '2026-04-21T10:01:00.000Z',
          createdAt: '2026-04-21T10:00:00.000Z',
        },
      ],
    });
  });

  it('rejects blank HWID before calling the Remnawave create-device route', async () => {
    const capturedRequests: unknown[] = [];
    const service = new RemnawaveApiService(
      {
        request: (input: unknown) => {
          capturedRequests.push(input);
          return of({ data: {} });
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

    await assert.rejects(
      async () => {
        await service.createUserSubscriptionDevice({
          remnawaveSubscriptionId: 'subscription-uuid-1',
          hwid: '   ',
        });
      },
      {
        name: 'BadRequestException',
        message: 'hwid must be provided',
      },
    );
    assert.deepStrictEqual(capturedRequests, []);
  });

  it('updates a subscription user through the official Remnawave UpdateUser command', async () => {
    const capturedRequests: Array<{ readonly method?: string; readonly url: string; readonly data?: unknown }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          capturedRequests.push(projectRequestContractShape(input));
          if (input.url === '/api/subscriptions/by-uuid/subscription-uuid-1') {
            return of({ data: createSubscriptionByUuidResponse({ isFound: true, shortUuid: 'short-user-1' }) });
          }
          if (input.url === '/api/users/by-short-uuid/short-user-1') {
            return of({ data: createUserByShortUuidResponse({ uuid: '33333333-3333-4333-8333-333333333333', shortUuid: 'short-user-1' }) });
          }
          return of({ data: createUserByShortUuidResponse({ uuid: '33333333-3333-4333-8333-333333333333', shortUuid: 'short-user-1' }) });
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

    await service.updateSubscriptionUser({
      remnawaveSubscriptionId: 'subscription-uuid-1',
      expireAt: new Date('2026-06-01T00:00:00.000Z'),
      status: 'ACTIVE',
      trafficLimitBytes: 1073741824,
      hwidDeviceLimit: 3,
    });

    assert.deepStrictEqual(capturedRequests, [
      { method: 'get', url: '/api/subscriptions/by-uuid/subscription-uuid-1' },
      { method: 'get', url: '/api/users/by-short-uuid/short-user-1' },
      {
        method: 'patch',
        url: '/api/users/',
        data: {
          uuid: '33333333-3333-4333-8333-333333333333',
          expireAt: new Date('2026-06-01T00:00:00.000Z'),
          status: 'ACTIVE',
          trafficLimitBytes: 1073741824,
          hwidDeviceLimit: 3,
          activeInternalSquads: undefined,
          externalSquadUuid: undefined,
        },
      },
    ]);
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

  it('hides raw Remnawave subscription delivery metadata in API responses', async () => {
    const rawSupportLink = 'https://remnawave.example/sub/raw-support-token-secret-001';
    const rawHappAnnounce = '{"profile":"https://profile.example/config","token":"raw-happ-token-secret"}';
    const rawHappRouting = 'configUrl=https://config.example/raw-route-token-secret';
    const service = new RemnawaveApiService(
      {
        request: () => of({
          data: {
            response: {
              uuid: '11111111-1111-4111-8111-111111111111',
              profileTitle: 'Safe profile title',
              supportLink: rawSupportLink,
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
    assert.equal(settings?.supportLink, 'REMNAWAVE_DELIVERY_METADATA_HIDDEN');
    assert.equal(settings?.happAnnounce, 'REMNAWAVE_DELIVERY_METADATA_HIDDEN');
    assert.equal(settings?.happRouting, 'REMNAWAVE_DELIVERY_METADATA_HIDDEN');
    assert.equal(serializedSettings.includes(rawSupportLink), false);
    assert.equal(serializedSettings.includes(rawHappAnnounce), false);
    assert.equal(serializedSettings.includes(rawHappRouting), false);
    assert.equal(serializedSettings.includes('raw-support-token-secret-001'), false);
    assert.equal(serializedSettings.includes('raw-happ-token-secret'), false);
    assert.equal(serializedSettings.includes('raw-route-token-secret'), false);
  });

  it('resets subscription user traffic through the Remnawave reset-traffic action', async () => {
    const capturedRequests: Array<{ readonly method?: string; readonly url: string; readonly data?: unknown }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          capturedRequests.push(projectRequestContractShape(input));
          if (input.url === '/api/subscriptions/by-uuid/subscription-uuid-1') {
            return of({ data: createSubscriptionByUuidResponse({ isFound: true, shortUuid: 'short-user-1' }) });
          }
          if (input.url === '/api/users/by-short-uuid/short-user-1') {
            return of({ data: createUserByShortUuidResponse({ uuid: '33333333-3333-4333-8333-333333333333', shortUuid: 'short-user-1' }) });
          }
          return of({ data: { response: { uuid: '33333333-3333-4333-8333-333333333333' } } });
        },
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null, caddyToken: null, cookie: null },
    );

    await service.resetSubscriptionTraffic('subscription-uuid-1');

    assert.deepStrictEqual(capturedRequests, [
      { method: 'get', url: '/api/subscriptions/by-uuid/subscription-uuid-1' },
      { method: 'get', url: '/api/users/by-short-uuid/short-user-1' },
      { method: 'post', url: '/api/users/33333333-3333-4333-8333-333333333333/actions/reset-traffic' },
    ]);
  });

  it('surfaces a stable bad-request error when the subscription is missing in remnawave', async () => {
    const service = new RemnawaveApiService(
      {
        request: () =>
          of({
            data: createSubscriptionByUuidResponse({
              isFound: false,
              shortUuid: 'short-user-1',
            }),
          }),
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

    await assert.rejects(
      async () => {
        await service.getUserSubscriptionDevices({
          remnawaveSubscriptionId: 'subscription-uuid-1',
        });
      },
      {
        name: 'BadRequestException',
        message: 'Remnawave subscription was not found',
      },
    );
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

function createSubscriptionByUuidResponse(input: {
  readonly isFound: boolean;
  readonly shortUuid: string;
}): Record<string, unknown> {
  return {
    response: {
      isFound: input.isFound,
      user: {
        shortUuid: input.shortUuid,
        daysLeft: 12,
        trafficUsed: '0',
        trafficLimit: '0',
        lifetimeTrafficUsed: '0',
        trafficUsedBytes: '0',
        trafficLimitBytes: '0',
        lifetimeTrafficUsedBytes: '0',
        username: 'rezeis-user',
        expiresAt: '2026-05-01T00:00:00.000Z',
        isActive: true,
        userStatus: 'ACTIVE',
        trafficLimitStrategy: 'NO_RESET',
      },
      links: ['link-1'],
      ssConfLinks: { default: 'link-1' },
      subscriptionUrl: 'https://example.com/subscription',
    },
  };
}

function createUserByShortUuidResponse(input: {
  readonly uuid: string;
  readonly shortUuid: string;
}): Record<string, unknown> {
  return {
    response: {
      uuid: input.uuid,
      id: 1,
      shortUuid: input.shortUuid,
      username: 'rezeis-user',
      status: 'ACTIVE',
      trafficLimitBytes: 0,
      trafficLimitStrategy: 'NO_RESET',
      expireAt: '2026-05-01T00:00:00.000Z',
      telegramId: null,
      email: null,
      description: null,
      tag: null,
      hwidDeviceLimit: null,
      externalSquadUuid: null,
      trojanPassword: 'trojan-password',
      vlessUuid: '33333333-3333-4333-8333-333333333333',
      ssPassword: 'ss-password',
      lastTriggeredThreshold: 0,
      subRevokedAt: null,
      lastTrafficResetAt: null,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
      subscriptionUrl: 'https://example.com/subscription',
      activeInternalSquads: [],
      userTraffic: {
        usedTrafficBytes: 0,
        lifetimeUsedTrafficBytes: 0,
        onlineAt: null,
        firstConnectedAt: null,
        lastConnectedNodeUuid: null,
      },
    },
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
