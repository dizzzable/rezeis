import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import {
  buildNodeUsersBandwidthPath,
  RemnawaveApiService,
  RemnawaveProfileNotFoundError,
  RemnawaveUpstreamRejectionError,
} from '../src/modules/remnawave/services/remnawave-api.service';

describe('RemnawaveApiService', () => {
  // `topUsersLimit` is required on 2.8.0 too — see
  // `remnawave-node-write-contract.spec.ts` for why the limit is sized the way
  // it is and for the wire-level assertions.
  it('includes the required UTC date range in node-user bandwidth requests', () => {
    assert.equal(
      buildNodeUsersBandwidthPath(new Date('2026-07-18T00:30:00.000Z')),
      '/api/bandwidth-stats/nodes/users?start=2026-07-17&end=2026-07-18&topUsersLimit=25000',
    );
  });

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
          // The adapter reads the panel's own version before building any
          // user-scoped path — 2.x addresses users by uuid, 3.x by numeric id.
          // Those probes are not part of the operation under test.
          if (input.url.startsWith('/api/system/')) return of({ data: { response: {} } });
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
      },
    );

    const outcome = await service.strictGetPanelUserDevices('33333333-3333-4333-8333-333333333333');

    assert.deepStrictEqual(capturedRequests.map(projectRequestContractShape), [
      { method: 'get', url: '/api/hwid/devices/33333333-3333-4333-8333-333333333333' },
    ]);
    assert.equal(outcome.kind, 'ok');
    assert.deepStrictEqual(outcome.kind === 'ok' ? outcome.value : null, {
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

  it('reports an unreachable panel as `unavailable`, never as an empty device list', async () => {
    const service = new RemnawaveApiService(
      {
        request: () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:3000');
        },
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
      },
    );

    const outcome = await service.strictGetPanelUserDevices('33333333-3333-4333-8333-333333333333');

    // The whole point of the type: the caller can tell this apart from a real
    // empty list. Asserting the kind AND that no list is reachable on it.
    assert.equal(outcome.kind, 'unavailable');
    assert.equal('value' in outcome, false);
  });

  it('reports a payload with no devices array as `invalidContract`, never as an empty device list', async () => {
    const service = new RemnawaveApiService(
      {
        request: () => of({ data: { response: { total: 3 } } }),
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
      },
    );

    const outcome = await service.strictGetPanelUserDevices('33333333-3333-4333-8333-333333333333');

    assert.equal(outcome.kind, 'invalidContract');
    assert.equal('value' in outcome, false);
  });

  it('still reports a genuinely empty panel device list as an empty list', async () => {
    const service = new RemnawaveApiService(
      {
        request: () => of({ data: { response: { total: 0, devices: [] } } }),
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
      },
    );

    const outcome = await service.strictGetPanelUserDevices('33333333-3333-4333-8333-333333333333');

    assert.equal(outcome.kind, 'ok');
    assert.deepStrictEqual(outcome.kind === 'ok' ? outcome.value : null, {
      total: 0,
      devices: [],
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
          // The adapter reads the panel's own version before building any
          // user-scoped path — 2.x addresses users by uuid, 3.x by numeric id.
          // Those probes are not part of the operation under test.
          if (input.url.startsWith('/api/system/')) return of({ data: { response: {} } });
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
      },
    );

    // The era the method used to read for itself is now handed in: the
    // destructive calls take ONE observation so a guard and the address it
    // guards cannot be built from two different readings. `getPanelShape()` is
    // cached, so this is the same single probe the assertion below still
    // filters out of `capturedRequests`.
    const result = await service.deletePanelUserDevice(
      '33333333-3333-4333-8333-333333333333',
      'hwid-to-delete',
      await service.getPanelShape(),
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
          // The adapter reads the panel's own version before building any
          // user-scoped path — 2.x addresses users by uuid, 3.x by numeric id.
          // Those probes are not part of the operation under test.
          if (input.url.startsWith('/api/system/')) return of({ data: { response: {} } });
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
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
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
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
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

  it('surfaces a 404 carrying the panel USER_NOT_FOUND envelope as RemnawaveProfileNotFoundError', async () => {
    const service = new RemnawaveApiService(
      {
        request: () =>
          throwError(() => ({
            isAxiosError: true,
            // Remnawave's own not-found body (code A025) — the profile is truly gone.
            response: { status: 404, data: { message: 'User not found', errorCode: 'A025' } },
            message: 'Request failed with status code 404',
          })),
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
    );

    await assert.rejects(
      () => service.updatePanelUser('33333333-3333-4333-8333-333333333333', { status: 'ACTIVE' }),
      (err: unknown) => {
        assert.ok(err instanceof RemnawaveProfileNotFoundError);
        assert.equal(err.uuid, '33333333-3333-4333-8333-333333333333');
        return true;
      },
    );
  });

  it('treats a bare 404 with no panel error envelope (proxy/gateway) as a transient outage, NOT a missing profile', async () => {
    const service = new RemnawaveApiService(
      {
        request: () =>
          throwError(() => ({
            isAxiosError: true,
            // A generic gateway 404 page — no A025, so it must not detach the profile.
            response: { status: 404, data: '<html>404 Not Found</html>' },
            message: 'Request failed with status code 404',
          })),
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
    );

    await assert.rejects(
      () => service.updatePanelUser('33333333-3333-4333-8333-333333333333', { status: 'ACTIVE' }),
      { name: 'ServiceUnavailableException', message: 'Remnawave integration is unavailable' },
    );
  });

  it('maps a non-404 PATCH /api/users failure to the generic service-unavailable error', async () => {
    const service = new RemnawaveApiService(
      {
        request: () =>
          throwError(() => ({
            isAxiosError: true,
            response: { status: 500 },
            message: 'Request failed with status code 500',
          })),
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
    );

    await assert.rejects(
      () => service.updatePanelUser('33333333-3333-4333-8333-333333333333', { status: 'ACTIVE' }),
      { name: 'ServiceUnavailableException', message: 'Remnawave integration is unavailable' },
    );
  });

  it('resets subscription user traffic through the Remnawave reset-traffic action', async () => {
    const capturedRequests: Array<{ readonly method?: string; readonly url: string; readonly data?: unknown }> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly method?: string; readonly url: string; readonly data?: unknown }) => {
          // The adapter reads the panel's own version before building any
          // user-scoped path — 2.x addresses users by uuid, 3.x by numeric id.
          // Those probes are not part of the operation under test.
          if (input.url.startsWith('/api/system/')) return of({ data: { response: {} } });
          capturedRequests.push(projectRequestContractShape(input));
          return of({ data: { response: { uuid: '33333333-3333-4333-8333-333333333333' } } });
        },
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
    );

    await service.resetPanelUserTraffic('33333333-3333-4333-8333-333333333333');

    assert.deepStrictEqual(capturedRequests, [
      { method: 'post', url: '/api/users/33333333-3333-4333-8333-333333333333/actions/reset-traffic' },
    ]);
  });

  // ── The panel answering "no" is not the panel being down ──────────────────
  //
  // Every legacy transport failure used to collapse into a single
  // `ServiceUnavailableException`, which `ProfileSyncProcessor.classifyRecovery`
  // reads as TRANSIENT. A permanently-rejected body therefore retried every 5
  // minutes forever (the sweep resets TRANSIENT rows to PENDING/attempts=0),
  // the customer's subscription never provisioned, and — because the operator
  // alert only fires for TERMINAL — nobody was ever told. The status has to
  // survive the transport for the caller to tell the two apart.

  const REJECTED_STATUSES = [400, 401, 403, 409, 422] as const;
  const TRANSIENT_STATUSES = [408, 429, 500, 502, 503, 504] as const;

  function axiosServiceFor(failure: { status?: number; data?: unknown }): RemnawaveApiService {
    return new RemnawaveApiService(
      {
        request: () =>
          throwError(() =>
            failure.status === undefined
              ? Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:3000'), {
                  isAxiosError: true,
                })
              : {
                  isAxiosError: true,
                  response: { status: failure.status, data: failure.data ?? {} },
                  message: `Request failed with status code ${failure.status}`,
                },
          ),
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
    );
  }

  function createUserInput(overrides: Record<string, unknown> = {}) {
    return {
      username: 'rz_login_sub',
      telegramId: null,
      email: null,
      description: 'reiwa_id: user-1',
      tag: null,
      expireAt: '2099-01-01T00:00:00.000Z',
      trafficLimitBytes: 0,
      hwidDeviceLimit: 0,
      trafficLimitStrategy: 'NO_RESET',
      activeInternalSquads: [],
      externalSquadUuid: null,
      ...overrides,
    } as Parameters<RemnawaveApiService['createPanelUser']>[0];
  }

  for (const status of REJECTED_STATUSES) {
    it(`surfaces a POST /api/users rejection (HTTP ${status}) as a terminal upstream rejection, not "unavailable"`, async () => {
      const service = axiosServiceFor({ status });

      await assert.rejects(
        () => service.createPanelUser(createUserInput()),
        (err: unknown) => {
          assert.ok(err instanceof RemnawaveUpstreamRejectionError, `HTTP ${status} must not be "unavailable"`);
          assert.equal(err.upstreamStatus, status);
          assert.equal(err.upstreamUrl, '/api/users');
          assert.equal(err.upstreamMethod, 'post');
          return true;
        },
      );
    });
  }

  for (const status of TRANSIENT_STATUSES) {
    it(`keeps a genuine outage (HTTP ${status}) on POST /api/users retryable`, async () => {
      const service = axiosServiceFor({ status });

      await assert.rejects(
        () => service.createPanelUser(createUserInput()),
        (err: unknown) => {
          assert.equal(err instanceof RemnawaveUpstreamRejectionError, false);
          assert.equal((err as Error).name, 'ServiceUnavailableException');
          return true;
        },
      );
    });
  }

  it('keeps a network-level failure (panel restart, no HTTP response) retryable', async () => {
    const service = axiosServiceFor({});

    await assert.rejects(
      () => service.createPanelUser(createUserInput()),
      { name: 'ServiceUnavailableException', message: 'Remnawave integration is unavailable' },
    );
  });

  it('keeps a bare 404 (proxy with no healthy backend) on a write retryable, not a rejection', async () => {
    const service = axiosServiceFor({ status: 404, data: '<html>404 Not Found</html>' });

    await assert.rejects(
      () => service.createPanelUser(createUserInput()),
      { name: 'ServiceUnavailableException' },
    );
  });

  it('surfaces a PATCH /api/users rejection (HTTP 400) as a terminal upstream rejection', async () => {
    const service = axiosServiceFor({ status: 400, data: { message: 'status must be one of ACTIVE, DISABLED' } });

    await assert.rejects(
      () => service.updatePanelUser('33333333-3333-4333-8333-333333333333', { status: 'EXPIRED' }),
      (err: unknown) => {
        assert.ok(err instanceof RemnawaveUpstreamRejectionError);
        assert.equal(err.upstreamStatus, 400);
        return true;
      },
    );
  });

  it('surfaces a DELETE /api/users rejection (HTTP 400) as a terminal upstream rejection', async () => {
    const service = axiosServiceFor({ status: 400 });

    await assert.rejects(
      async () => service.deletePanelUser('not-a-uuid', await service.getPanelShape()),
      (err: unknown) => {
        assert.ok(err instanceof RemnawaveUpstreamRejectionError);
        assert.equal(err.upstreamStatus, 400);
        return true;
      },
    );
  });

  it('answers a 5xx to the admin API for an upstream rejection rather than an unhandled 500', async () => {
    // The class is an HttpException so the ~20 admin endpoints that let this
    // bubble keep answering a gateway error. 502, not 503: there is nothing to
    // wait for — the panel already gave its final answer.
    const service = axiosServiceFor({ status: 400 });

    await assert.rejects(
      () => service.createPanelUser(createUserInput()),
      (err: unknown) => {
        assert.equal((err as RemnawaveUpstreamRejectionError).getStatus(), 502);
        return true;
      },
    );
  });

  // ── `trafficLimitStrategy` is optional, and never nullable ────────────────
  //
  // Both 2.7.4 and 2.8.0 declare `{"type":"string","enum":[...],"default":
  // "NO_RESET"}`. An explicit `null` is a validation failure. Every plan
  // snapshot without the key — every 3x-ui import — reads as `null`.

  function capturingService(captured: unknown[]): RemnawaveApiService {
    return new RemnawaveApiService(
      {
        request: (input: { readonly url?: string; readonly data?: unknown }) => {
          // The panel-version probe is not a body under test. Any user-scoped
          // call makes one first — it is how the adapter learns whether this
          // panel wants a uuid or a numeric id — and capturing it would shift
          // every `captured[0]` in this file by one.
          if (input.url?.startsWith('/api/system/') !== true) captured.push(input.data);
          return of({ data: { response: { uuid: '33333333-3333-4333-8333-333333333333' } } });
        },
      } as never,
      { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
    );
  }

  it('omits trafficLimitStrategy from POST /api/users when the caller has no value for it', async () => {
    const captured: unknown[] = [];
    await capturingService(captured).createPanelUser(createUserInput({ trafficLimitStrategy: null }));

    const body = captured[0] as Record<string, unknown>;
    assert.equal('trafficLimitStrategy' in body, false);
    // The rest of the body is untouched — this is an omission, not a rewrite.
    assert.equal(body['username'], 'rz_login_sub');
    assert.equal(body['hwidDeviceLimit'], 0);
  });

  it('still sends trafficLimitStrategy on POST /api/users when the plan declares one', async () => {
    const captured: unknown[] = [];
    await capturingService(captured).createPanelUser(createUserInput({ trafficLimitStrategy: 'MONTH' }));

    assert.equal((captured[0] as Record<string, unknown>)['trafficLimitStrategy'], 'MONTH');
  });

  it('omits trafficLimitStrategy from PATCH /api/users when it is null, and keeps it when set', async () => {
    const captured: unknown[] = [];
    const service = capturingService(captured);

    await service.updatePanelUser('33333333-3333-4333-8333-333333333333', {
      trafficLimitStrategy: null,
      hwidDeviceLimit: 3,
    });
    await service.updatePanelUser('33333333-3333-4333-8333-333333333333', {
      trafficLimitStrategy: 'DAY',
    });

    assert.equal('trafficLimitStrategy' in (captured[0] as Record<string, unknown>), false);
    assert.equal((captured[0] as Record<string, unknown>)['hwidDeviceLimit'], 3);
    assert.equal((captured[1] as Record<string, unknown>)['trafficLimitStrategy'], 'DAY');
  });

  it('omits a null trafficLimitStrategy from the strict desired-limit PATCH', async () => {
    const captured: unknown[] = [];
    await capturingService(captured).strictSetUserLimits('33333333-3333-4333-8333-333333333333', {
      trafficLimitBytes: null,
      hwidDeviceLimit: null,
      trafficLimitStrategy: null,
    });

    assert.equal('trafficLimitStrategy' in (captured[0] as Record<string, unknown>), false);
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
