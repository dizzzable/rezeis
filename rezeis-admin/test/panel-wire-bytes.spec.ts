import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { SubscriptionStatus, SyncAction, SyncJobStatus, FraudSignalSeverity, FraudSignalStatus } from '@prisma/client';
import axios, { AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { AntiFraudService } from '../src/modules/anti-fraud/services/anti-fraud.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { PanelCommandExecutor } from '../src/modules/remnawave/services/panel-command.executor';
import { PanelDevicesClient } from '../src/modules/remnawave/services/panel-devices.client';
import { PanelInfraClient } from '../src/modules/remnawave/services/panel-infra.client';
import { AxiosPanelTransport } from '../src/modules/remnawave/services/panel-transport';
import { PanelUsersClient } from '../src/modules/remnawave/services/panel-users.client';
import { tunablesFromEnv } from './fixtures/anti-fraud-tunables';

/**
 * WHAT GOES ON THE WIRE, byte for byte, at every production call site
 * ═══════════════════════════════════════════════════════════════════
 * The panel clients used to hand every request body to the vendor's zod schema
 * and send what it PARSED. That parse was not a no-op: it put the keys in the
 * schema's order, filled `status: ACTIVE` and `trafficLimitStrategy: NO_RESET`
 * on a create that omitted them, and turned `expireAt` into a `Date` that axios
 * then rendered back through `toJSON`. Removing the vendor package from the
 * runtime must not change one byte of that, and "the bodies look the same" is
 * not a claim anybody can check by reading.
 *
 * So every expectation below is a LITERAL, recorded from the build that still
 * executed the vendor schema, and the requests are driven through the REAL
 * callers — the profile-sync processor, the anti-fraud enforcement and the
 * traffic detector — down through the real clients, executor and transport to a
 * fake `HttpService`. The body is serialized with axios's own
 * `transformRequest`, so what is compared is the string axios would send, not
 * an object that merely resembles it.
 *
 * Values in the fixtures are deliberately unlike any default on these paths
 * (a strategy of `MONTH`, a device limit of 3, a tag): a fixture that happened
 * to equal a schema default would pass whether the default was applied or not.
 */
Logger.overrideLogger(false);

const U1 = '2f1c9a44-0000-4000-8000-000000000001';
const U2 = '7aa64e53-f5da-4366-9760-0fdad1497a28';
const U3 = '11111111-1111-4111-8111-111111111111';
const NODE_UUID = '3a1f0c9e-6b2d-4f47-9c11-8d5e2b7a4c60';
const FUTURE = new Date('2099-03-04T05:06:07.089Z');

const CAPTURED_USER = (JSON.parse(readFileSync('test/fixtures/remnawave/3.3.2/user.json', 'utf8')) as {
  response: Record<string, unknown>;
}).response;

interface WireRequest {
  readonly method: string;
  readonly url: string;
  readonly contentType: string | null;
  readonly body: string | null;
}

interface AxiosLikeConfig {
  readonly method: string;
  readonly url: string;
  readonly data?: unknown;
  readonly headers?: Record<string, string>;
}

/** The request exactly as axios would serialize it — its own transformRequest, not JSON.stringify. */
function toWire(config: AxiosLikeConfig): WireRequest {
  const headers = AxiosHeaders.from(config.headers ?? {});
  let body: string | null = null;
  if (config.data !== undefined) {
    const context = { ...axios.defaults, headers };
    let data: unknown = config.data;
    // `InstanceType<typeof …>`, not the bare name: TypeScript 6 resolves `axios`
    // through its `exports` map to the CommonJS typings the runtime `require`
    // actually loads, where the named import is a value only.
    const transforms = axios.defaults.transformRequest as unknown as ReadonlyArray<
      (this: unknown, value: unknown, requestHeaders: InstanceType<typeof AxiosHeaders>) => unknown
    >;
    for (const transform of transforms) data = transform.call(context, data, headers);
    body = typeof data === 'string' ? data : String(data);
  }
  const contentType = headers.getContentType();
  return {
    method: config.method.toUpperCase(),
    url: config.url,
    contentType: typeof contentType === 'string' ? contentType : null,
    body,
  };
}

type Answer = { readonly status: number; readonly data?: unknown };

/** The real stack over a fake `HttpService` that records every request. */
function realStack(respond: (config: AxiosLikeConfig) => Answer) {
  const wires: WireRequest[] = [];
  const http = {
    request: (config: AxiosLikeConfig) => {
      wires.push(toWire(config));
      const answer = respond(config);
      if (answer.status >= 200 && answer.status < 300) {
        return of({ status: answer.status, data: answer.data ?? {} });
      }
      return throwError(() => ({
        isAxiosError: true,
        response: { status: answer.status, headers: {}, data: answer.data ?? {} },
        message: `Request failed with status code ${answer.status}`,
      }));
    },
  };
  const transport = new AxiosPanelTransport(http as never, {
    host: 'remnawave',
    port: 3000,
    token: 'secret',
  });
  const executor = new PanelCommandExecutor(transport);
  return {
    wires,
    transport,
    users: new PanelUsersClient(executor),
    devices: new PanelDevicesClient(executor),
    infra: new PanelInfraClient(executor),
  };
}

const USER_NOT_FOUND: Answer = {
  status: 404,
  data: { errorCode: 'A063', message: 'User with specified params not found' },
};

const USER_ROW: Answer = { status: 200, data: { response: { ...CAPTURED_USER, id: 4711, username: 'rz_login_sub' } } };

// ═════════════════════════════════════════════════════════════════════════════
//  The profile-sync processor
// ═════════════════════════════════════════════════════════════════════════════

interface SubscriptionSeed {
  readonly remnawaveId: string | null;
  readonly remnawavePanelId?: number | null;
  readonly remnawavePanelUsername?: string | null;
  readonly configUrl?: string | null;
  readonly status?: SubscriptionStatus;
  readonly isBlocked?: boolean;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  readonly expiresAt: Date | null;
  readonly planSnapshot: Record<string, unknown>;
}

function jobOf(action: SyncAction, seed: SubscriptionSeed, payload: Record<string, unknown> = {}) {
  return {
    id: `sync-job-${action.toLowerCase()}`,
    action,
    status: SyncJobStatus.PENDING,
    attempts: 0,
    supersededAt: null,
    createdAt: new Date(),
    aggregateKey: null as string | null,
    desiredRevision: null as bigint | null,
    payload,
    subscription: {
      id: 'subscription-1',
      userId: 'user-1',
      user: { isBlocked: seed.isBlocked ?? false },
      remnawaveId: seed.remnawaveId,
      remnawavePanelId: seed.remnawavePanelId ?? null,
      remnawavePanelUsername: seed.remnawavePanelUsername ?? null,
      configUrl: seed.configUrl ?? null,
      trafficLimit: seed.trafficLimit,
      deviceLimit: seed.deviceLimit,
      internalSquads: [...seed.internalSquads],
      externalSquad: seed.externalSquad,
      status: seed.status ?? SubscriptionStatus.ACTIVE,
      expiresAt: seed.expiresAt,
      planSnapshot: seed.planSnapshot,
    },
  };
}

async function runProcessor(options: {
  readonly job: ReturnType<typeof jobOf>;
  readonly respond: (config: AxiosLikeConfig) => Answer;
  readonly contacts?: { email: string | null; telegramId: string | null };
  readonly projection?: { desiredRevision: bigint; desiredTrafficLimitBytes: bigint | null; desiredDeviceLimit: number | null };
}): Promise<readonly WireRequest[]> {
  const stack = realStack(options.respond);
  const failures: unknown[] = [];
  const prisma = {
    profileSyncJob: {
      findUnique: async () => options.job,
      findMany: async () => [],
      updateMany: async (input: { data: { status?: SyncJobStatus; lastError?: unknown } }) => {
        if (input.data.status === SyncJobStatus.FAILED) failures.push(input.data.lastError);
        return { count: 1 };
      },
      update: async () => undefined,
    },
    subscription: {
      findFirst: async () => null,
      findMany: async () => [],
      updateMany: async () => ({ count: 1 }),
    },
    subscriptionEffectiveProjection: {
      findUnique: async () => options.projection ?? null,
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ status: options.job.subscription.status }],
        subscription: { update: async () => undefined, updateMany: async () => ({ count: 1 }) },
        subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
        profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete-job' }) },
      }),
  };
  const processor = new ProfileSyncProcessor(
    prisma as never,
    stack.users,
    {
      generateProfileName: async () => ({
        username: 'rz_login_sub',
        description: 'name: Buyer\nreiwa_id: user-1',
      }),
      getContactInfo: async () => options.contacts ?? { email: null, telegramId: null },
    } as never,
    { error: () => undefined, info: () => undefined, warn: () => undefined, emit: () => undefined } as never,
  );
  await processor.process({ data: { syncJobId: options.job.id } } as never);
  assert.deepStrictEqual(failures, [], 'the job must complete, or the wire below is not the success path');
  return stack.wires;
}

const ORIGINAL_PROJECTION_SYNC = process.env['ADDON_PROJECTION_SYNC'];
afterEach(() => {
  if (ORIGINAL_PROJECTION_SYNC === undefined) delete process.env['ADDON_PROJECTION_SYNC'];
  else process.env['ADDON_PROJECTION_SYNC'] = ORIGINAL_PROJECTION_SYNC;
});

describe('profile-sync CREATE puts the same bytes on the wire', () => {
  it('a paid plan with every field the create carries', async () => {
    const wires = await runProcessor({
      job: jobOf(SyncAction.CREATE, {
        remnawaveId: null,
        trafficLimit: 50,
        deviceLimit: 3,
        internalSquads: [U1, U2],
        externalSquad: U3,
        expiresAt: FUTURE,
        planSnapshot: { name: 'Plan X', tag: 'PLAN_X', trafficLimitStrategy: 'MONTH' },
      }),
      contacts: { email: 'buyer@example.com', telegramId: '813364774' },
      respond: (config) => (config.url.startsWith('/api/users/by-username/') ? USER_NOT_FOUND : USER_ROW),
    });
    assert.deepStrictEqual(wires, EXPECTED['create-full']);
  });

  it('a blocked owner, a 3x-ui import with no strategy and no tag, and no contacts', async () => {
    // The two defaults the vendor schema used to fill are exactly what this
    // body omits: `status` (absent for an unblocked owner, DISABLED here) and
    // `trafficLimitStrategy` (absent). The recorded bytes say what reached the
    // panel for each.
    const wires = await runProcessor({
      job: jobOf(SyncAction.CREATE, {
        remnawaveId: null,
        isBlocked: true,
        trafficLimit: null,
        deviceLimit: 0,
        internalSquads: [],
        externalSquad: null,
        expiresAt: FUTURE,
        planSnapshot: { importedFrom: '3xui' },
      }),
      respond: (config) => (config.url.startsWith('/api/users/by-username/') ? USER_NOT_FOUND : USER_ROW),
    });
    assert.deepStrictEqual(wires, EXPECTED['create-blocked-import']);
  });

  it('an unblocked owner whose plan carries no strategy', async () => {
    const wires = await runProcessor({
      job: jobOf(SyncAction.CREATE, {
        remnawaveId: null,
        trafficLimit: 1,
        deviceLimit: 1,
        internalSquads: [U1],
        externalSquad: null,
        expiresAt: FUTURE,
        planSnapshot: { tag: 'TRIAL' },
      }),
      respond: (config) => (config.url.startsWith('/api/users/by-username/') ? USER_NOT_FOUND : USER_ROW),
    });
    assert.deepStrictEqual(wires, EXPECTED['create-no-strategy']);
  });

  it('a subscription with no end date', async () => {
    const wires = await runProcessor({
      job: jobOf(SyncAction.CREATE, {
        remnawaveId: null,
        trafficLimit: 100,
        deviceLimit: 3,
        internalSquads: [U1],
        externalSquad: null,
        expiresAt: null,
        planSnapshot: { tag: 'FOREVER' },
      }),
      respond: (config) => (config.url.startsWith('/api/users/by-username/') ? USER_NOT_FOUND : USER_ROW),
    });
    assert.deepStrictEqual(wires, EXPECTED['create-open-ended']);
  });
});

describe('profile-sync UPDATE puts the same bytes on the wire', () => {
  it('an operator status toggle with contacts, squads, strategy and a traffic reset', async () => {
    const wires = await runProcessor({
      job: jobOf(
        SyncAction.UPDATE,
        {
          remnawaveId: '4711',
          remnawavePanelId: 4711,
          remnawavePanelUsername: 'rz_login_sub',
          status: SubscriptionStatus.DISABLED,
          trafficLimit: 50,
          deviceLimit: 3,
          internalSquads: [U1, U2],
          externalSquad: U3,
          expiresAt: FUTURE,
          planSnapshot: { tag: 'PLAN_X', trafficLimitStrategy: 'MONTH' },
        },
        { source: 'ADMIN_MUTATION', propagateStatus: true, resetTraffic: true },
      ),
      contacts: { email: 'buyer@example.com', telegramId: '813364774' },
      respond: () => USER_ROW,
    });
    assert.deepStrictEqual(wires, EXPECTED['update-full']);
  });

  it('a blocked owner on a term with no end date and a plan with no strategy or tag', async () => {
    const wires = await runProcessor({
      job: jobOf(SyncAction.UPDATE, {
        remnawaveId: '4711',
        remnawavePanelId: 4711,
        remnawavePanelUsername: 'rz_login_sub',
        isBlocked: true,
        trafficLimit: null,
        deviceLimit: 0,
        internalSquads: [],
        externalSquad: null,
        expiresAt: null,
        planSnapshot: {},
      }),
      respond: () => USER_ROW,
    });
    assert.deepStrictEqual(wires, EXPECTED['update-blocked-open-ended']);
  });

  it('a 2.x-era row that has to be resolved by its subscription short uuid first', async () => {
    const wires = await runProcessor({
      job: jobOf(SyncAction.UPDATE, {
        remnawaveId: '330f2b38-1362-46ab-b5c0-dea32167eff9',
        remnawavePanelId: null,
        remnawavePanelUsername: 'rz_login_sub',
        configUrl: 'https://sub.example/api/sub/PyTr7C5568QuLhup',
        trafficLimit: 5,
        deviceLimit: 2,
        internalSquads: [U1],
        externalSquad: null,
        expiresAt: FUTURE,
        planSnapshot: { trafficLimitStrategy: 'WEEK' },
      }),
      respond: (config) =>
        config.url === '/api/users/resolve'
          ? { status: 201, data: { response: { id: 4711, username: 'rz_login_sub', shortUuid: 'PyTr7C5568QuLhup' } } }
          : USER_ROW,
    });
    assert.deepStrictEqual(wires, EXPECTED['update-resolve-short-uuid']);
  });

  it('a 2.x-era row with only the panel username to resolve by', async () => {
    const wires = await runProcessor({
      job: jobOf(SyncAction.UPDATE, {
        remnawaveId: '330f2b38-1362-46ab-b5c0-dea32167eff9',
        remnawavePanelId: null,
        remnawavePanelUsername: 'rz_login_sub',
        configUrl: null,
        trafficLimit: 5,
        deviceLimit: 2,
        internalSquads: [],
        externalSquad: U2,
        expiresAt: FUTURE,
        planSnapshot: { trafficLimitStrategy: 'DAY', tag: 'VIP_1' },
      }),
      respond: (config) =>
        config.url === '/api/users/resolve'
          ? { status: 201, data: { response: { id: 4711, username: 'rz_login_sub', shortUuid: 'PyTr7C5568QuLhup' } } }
          : USER_ROW,
    });
    assert.deepStrictEqual(wires, EXPECTED['update-resolve-username']);
  });

  it('the versioned desired-state write and its independent read-back', async () => {
    process.env['ADDON_PROJECTION_SYNC'] = 'true';
    const job = {
      ...jobOf(SyncAction.UPDATE, {
        remnawaveId: '4711',
        remnawavePanelId: 4711,
        remnawavePanelUsername: 'rz_login_sub',
        trafficLimit: 20,
        deviceLimit: 5,
        internalSquads: [U2],
        externalSquad: U1,
        expiresAt: FUTURE,
        planSnapshot: { tag: 'PLAN_X', trafficLimitStrategy: 'MONTH_ROLLING' },
      }),
      aggregateKey: 'subscription-1',
      desiredRevision: 5n,
    };
    const limits = { trafficLimitBytes: 20 * 1024 ** 3, hwidDeviceLimit: 5 };
    const wires = await runProcessor({
      job,
      projection: { desiredRevision: 5n, desiredTrafficLimitBytes: 20n * 1024n ** 3n, desiredDeviceLimit: 5 },
      respond: () => ({ status: 200, data: { response: { ...CAPTURED_USER, id: 4711, username: 'rz_login_sub', ...limits } } }),
    });
    assert.deepStrictEqual(wires, EXPECTED['update-desired-state']);
  });
});

describe('profile-sync DELETE and TRAFFIC_RESET put the same bytes on the wire', () => {
  it('retires a profile by its numeric id', async () => {
    const wires = await runProcessor({
      job: jobOf(SyncAction.DELETE, {
        remnawaveId: '4711',
        remnawavePanelId: 4711,
        remnawavePanelUsername: 'rz_login_sub',
        status: SubscriptionStatus.DELETED,
        trafficLimit: null,
        deviceLimit: 0,
        internalSquads: [],
        externalSquad: null,
        expiresAt: null,
        planSnapshot: {},
      }),
      respond: () => ({ status: 204, data: '' }),
    });
    assert.deepStrictEqual(wires, EXPECTED['delete']);
  });

  it('zeroes a counter by its numeric id', async () => {
    const wires = await runProcessor({
      job: jobOf(SyncAction.TRAFFIC_RESET, {
        remnawaveId: '4711',
        remnawavePanelId: 4711,
        trafficLimit: 10,
        deviceLimit: 1,
        internalSquads: [],
        externalSquad: null,
        expiresAt: FUTURE,
        planSnapshot: {},
      }),
      respond: () => USER_ROW,
    });
    assert.deepStrictEqual(wires, EXPECTED['traffic-reset']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Anti-fraud enforcement and the traffic detector
// ═════════════════════════════════════════════════════════════════════════════

function antiFraudOver(metadata: Record<string, unknown>) {
  const stack = realStack(() => ({ status: 202, data: '' }));
  const prisma = {
    fraudSignal: {
      findUnique: async () => ({
        id: 'sig-1',
        code: 'SUBSCRIPTION_SHARING_IP',
        severity: FraudSignalSeverity.HIGH,
        status: FraudSignalStatus.OPEN,
        metadata,
        affectedUserIds: [],
      }),
    },
    subscription: { findMany: async () => [] },
    adminAuditLog: { create: async () => ({}) },
  } as unknown as PrismaService;
  const service = new AntiFraudService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    stack.devices,
    { warn: () => undefined } as never,
  );
  return { service, wires: stack.wires };
}

const REQUEST_METADATA = { requestId: 'r1', remoteAddress: '10.0.0.1', userAgent: 'spec' };

describe('anti-fraud drops put the same bytes on the wire', () => {
  it('by the panel user id', async () => {
    const { service, wires } = antiFraudOver({ remnawaveUuid: '4471' });
    await service.enforceDropConnections({ signalId: 'sig-1', mode: 'user', adminId: 'admin-1', requestMetadata: REQUEST_METADATA });
    assert.deepStrictEqual(wires, EXPECTED['drop-user']);
  });

  it('by IPv4 and IPv6 addresses', async () => {
    const { service, wires } = antiFraudOver({ ips: [{ ip: '203.0.113.7' }, { ip: '2001:db8::1' }] });
    await service.enforceDropConnections({ signalId: 'sig-1', mode: 'ip', adminId: 'admin-1', requestMetadata: REQUEST_METADATA });
    assert.deepStrictEqual(wires, EXPECTED['drop-ip']);
  });
});

describe('the per-user traffic detector puts the same bytes on the wire', () => {
  it('reads the nodes, then posts the node list with the window in the query', async () => {
    const node = {
      uuid: NODE_UUID,
      name: 'de-1',
      isConnected: true,
      isDisabled: false,
      isConnecting: false,
      lastStatusChange: '1970-01-01T00:00:00.000Z',
      countryCode: 'DE',
      usersOnline: 0,
      trafficLimitBytes: null,
      trafficUsedBytes: null,
    };
    const stack = realStack((config) =>
      config.url.startsWith('/api/nodes')
        ? { status: 200, data: { response: [node] } }
        : { status: 200, data: { response: { categories: [], sparklineData: [], topUsers: [] } } },
    );
    const detectors = new RemnawaveDetectors(
      {} as unknown as PrismaService,
      stack.devices,
      stack.infra,
      tunablesFromEnv(),
    );
    await detectors.detectPerUserNodeTrafficAbuse(new Date('2026-08-05T12:00:00.000Z'));
    assert.deepStrictEqual(stack.wires, EXPECTED['bandwidth']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The reads, with the arguments their callers pass
// ═════════════════════════════════════════════════════════════════════════════

describe('the reads production makes put the same bytes on the wire', () => {
  it('users: by id, by username', async () => {
    const stack = realStack(() => USER_ROW);
    await stack.users.getUserById(4711);
    await stack.users.getUserByUsername('rz_login_sub');
    assert.deepStrictEqual(stack.wires, EXPECTED['users-reads']);
  });

  it('devices: both walks, the stats and both connection jobs', async () => {
    const stack = realStack((config) => {
      if (config.url.startsWith('/api/hwid/devices/top-users')) {
        return { status: 200, data: { response: { users: [], total: 0 } } };
      }
      if (config.url.startsWith('/api/hwid/devices/stats')) {
        return {
          status: 200,
          data: { response: { byPlatform: [], stats: { totalUniqueDevices: 0, totalHwidDevices: 0, averageHwidDevicesPerUser: 0 } } },
        };
      }
      if (config.url.startsWith('/api/hwid/devices')) {
        return { status: 200, data: { response: { devices: [], total: 0 } } };
      }
      if (config.method === 'post') return { status: 201, data: { response: { jobId: 'job-9' } } };
      if (config.url.startsWith('/api/connections/by-user/')) {
        return {
          status: 200,
          data: {
            response: {
              isCompleted: true,
              isFailed: false,
              progress: { total: 1, completed: 1, percent: 100 },
              result: { success: true, userId: 4471, nodes: [] },
            },
          },
        };
      }
      return {
        status: 200,
        data: { response: { isCompleted: true, isFailed: false, result: { success: true, nodeUuid: NODE_UUID, users: [] } } },
      };
    });
    await stack.devices.listTopUsersByDeviceCount();
    await stack.devices.listAllDevices();
    await stack.devices.getDeviceStats();
    await stack.devices.fetchNodeConnections(NODE_UUID);
    await stack.devices.fetchUserConnections(4471);
    assert.deepStrictEqual(stack.wires, EXPECTED['devices-reads']);
  });

  it('infra: nodes, both squad lists, the request log and the version probe', async () => {
    const stack = realStack((config) => {
      if (config.url.startsWith('/api/internal-squads')) return { status: 200, data: { response: { total: 0, internalSquads: [] } } };
      if (config.url.startsWith('/api/external-squads')) return { status: 200, data: { response: { total: 0, externalSquads: [] } } };
      if (config.url.startsWith('/api/subscription-request-history')) return { status: 200, data: { response: { total: 0, records: [] } } };
      if (config.url.startsWith('/api/system/metadata')) return { status: 200, data: { response: { version: '3.4.4' } } };
      return { status: 200, data: { response: [] } };
    });
    await stack.infra.getNodes();
    await stack.infra.getInternalSquadOptions();
    await stack.infra.getExternalSquadOptions();
    await stack.infra.getSubscriptionRequestHistory({ start: 0, size: 500 });
    await PanelInfraClient.forVersionProbe(stack.transport).readPanelVersion();
    assert.deepStrictEqual(stack.wires, EXPECTED['infra-reads']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The recorded bytes
// ═════════════════════════════════════════════════════════════════════════════

const EXPECTED: Readonly<Record<string, readonly WireRequest[]>> = {
  'create-full': [
    { method: 'GET', url: '/api/users/by-username/rz_login_sub', contentType: null, body: null },
    {
      method: 'POST',
      url: '/api/users/',
      contentType: 'application/json',
      body:
        '{"username":"rz_login_sub","status":"ACTIVE","trafficLimitBytes":53687091200,"trafficLimitStrategy":"MONTH","expireAt":"2099-03-04T05:06:07.089Z","description":"name: Buyer\\nreiwa_id: user-1","tag":"PLAN_X","telegramId":813364774,"email":"buyer@example.com","hwidDeviceLimit":3,"activeInternalSquads":["2f1c9a44-0000-4000-8000-000000000001","7aa64e53-f5da-4366-9760-0fdad1497a28"],"externalSquadUuid":"11111111-1111-4111-8111-111111111111"}',
    },
  ],
  'create-blocked-import': [
    { method: 'GET', url: '/api/users/by-username/rz_login_sub', contentType: null, body: null },
    {
      method: 'POST',
      url: '/api/users/',
      contentType: 'application/json',
      body:
        '{"username":"rz_login_sub","status":"DISABLED","trafficLimitBytes":0,"trafficLimitStrategy":"NO_RESET","expireAt":"2099-03-04T05:06:07.089Z","description":"name: Buyer\\nreiwa_id: user-1","tag":null,"telegramId":null,"email":null,"hwidDeviceLimit":0,"activeInternalSquads":[],"externalSquadUuid":null}',
    },
  ],
  'create-no-strategy': [
    { method: 'GET', url: '/api/users/by-username/rz_login_sub', contentType: null, body: null },
    {
      method: 'POST',
      url: '/api/users/',
      contentType: 'application/json',
      body:
        '{"username":"rz_login_sub","status":"ACTIVE","trafficLimitBytes":1073741824,"trafficLimitStrategy":"NO_RESET","expireAt":"2099-03-04T05:06:07.089Z","description":"name: Buyer\\nreiwa_id: user-1","tag":"TRIAL","telegramId":null,"email":null,"hwidDeviceLimit":1,"activeInternalSquads":["2f1c9a44-0000-4000-8000-000000000001"],"externalSquadUuid":null}',
    },
  ],
  // A subscription with no end: the sentinel, where this used to be now + 30
  // days and Remnawave cut the customer off at day 30.
  'create-open-ended': [
    { method: 'GET', url: '/api/users/by-username/rz_login_sub', contentType: null, body: null },
    {
      method: 'POST',
      url: '/api/users/',
      contentType: 'application/json',
      body:
        '{"username":"rz_login_sub","status":"ACTIVE","trafficLimitBytes":107374182400,"trafficLimitStrategy":"NO_RESET","expireAt":"2099-12-31T00:00:00.000Z","description":"name: Buyer\\nreiwa_id: user-1","tag":"FOREVER","telegramId":null,"email":null,"hwidDeviceLimit":3,"activeInternalSquads":["2f1c9a44-0000-4000-8000-000000000001"],"externalSquadUuid":null}',
    },
  ],
  'update-full': [
    {
      method: 'PATCH',
      url: '/api/users/',
      contentType: 'application/json',
      body:
        '{"id":4711,"status":"DISABLED","trafficLimitBytes":53687091200,"trafficLimitStrategy":"MONTH","expireAt":"2099-03-04T05:06:07.089Z","description":"name: Buyer\\nreiwa_id: user-1","tag":"PLAN_X","telegramId":813364774,"email":"buyer@example.com","hwidDeviceLimit":3,"activeInternalSquads":["2f1c9a44-0000-4000-8000-000000000001","7aa64e53-f5da-4366-9760-0fdad1497a28"],"externalSquadUuid":"11111111-1111-4111-8111-111111111111"}',
    },
    { method: 'POST', url: '/api/users/4711/actions/reset-traffic', contentType: null, body: null },
  ],
  // "No end" goes out as the sentinel (`panel-expiry.ts`). The key used to be
  // left out, and the profile kept the thirty days its CREATE had given it.
  'update-blocked-open-ended': [
    {
      method: 'PATCH',
      url: '/api/users/',
      contentType: 'application/json',
      body:
        '{"id":4711,"status":"DISABLED","trafficLimitBytes":0,"expireAt":"2099-12-31T00:00:00.000Z","description":"name: Buyer\\nreiwa_id: user-1","tag":null,"telegramId":null,"email":null,"hwidDeviceLimit":0,"activeInternalSquads":[],"externalSquadUuid":null}',
    },
  ],
  'update-resolve-short-uuid': [
    {
      method: 'POST',
      url: '/api/users/resolve',
      contentType: 'application/json',
      body:
        '{"shortUuid":"PyTr7C5568QuLhup"}',
    },
    {
      method: 'PATCH',
      url: '/api/users/',
      contentType: 'application/json',
      body:
        '{"id":4711,"trafficLimitBytes":5368709120,"trafficLimitStrategy":"WEEK","expireAt":"2099-03-04T05:06:07.089Z","description":"name: Buyer\\nreiwa_id: user-1","tag":null,"telegramId":null,"email":null,"hwidDeviceLimit":2,"activeInternalSquads":["2f1c9a44-0000-4000-8000-000000000001"],"externalSquadUuid":null}',
    },
  ],
  'update-resolve-username': [
    {
      method: 'POST',
      url: '/api/users/resolve',
      contentType: 'application/json',
      body:
        '{"username":"rz_login_sub"}',
    },
    {
      method: 'PATCH',
      url: '/api/users/',
      contentType: 'application/json',
      body:
        '{"id":4711,"trafficLimitBytes":5368709120,"trafficLimitStrategy":"DAY","expireAt":"2099-03-04T05:06:07.089Z","description":"name: Buyer\\nreiwa_id: user-1","tag":"VIP_1","telegramId":null,"email":null,"hwidDeviceLimit":2,"activeInternalSquads":[],"externalSquadUuid":"7aa64e53-f5da-4366-9760-0fdad1497a28"}',
    },
  ],
  'update-desired-state': [
    {
      method: 'PATCH',
      url: '/api/users/',
      contentType: 'application/json',
      body:
        '{"id":4711,"trafficLimitBytes":21474836480,"trafficLimitStrategy":"MONTH_ROLLING","tag":"PLAN_X","hwidDeviceLimit":5,"activeInternalSquads":["7aa64e53-f5da-4366-9760-0fdad1497a28"],"externalSquadUuid":"2f1c9a44-0000-4000-8000-000000000001"}',
    },
    { method: 'GET', url: '/api/users/4711', contentType: null, body: null },
  ],
  'delete': [
    { method: 'DELETE', url: '/api/users/4711', contentType: null, body: null },
  ],
  'traffic-reset': [
    { method: 'POST', url: '/api/users/4711/actions/reset-traffic', contentType: null, body: null },
  ],
  'drop-user': [
    {
      method: 'POST',
      url: '/api/connections/drop',
      contentType: 'application/json',
      body:
        '{"dropBy":{"by":"userIds","userIds":[4471]},"targetNodes":{"target":"allNodes"}}',
    },
  ],
  'drop-ip': [
    {
      method: 'POST',
      url: '/api/connections/drop',
      contentType: 'application/json',
      body:
        '{"dropBy":{"by":"ipAddresses","ipAddresses":["203.0.113.7","2001:db8::1"]},"targetNodes":{"target":"allNodes"}}',
    },
  ],
  'bandwidth': [
    { method: 'GET', url: '/api/nodes/', contentType: null, body: null },
    {
      method: 'POST',
      url: '/api/bandwidth-stats/nodes/users?start=2026-08-04&end=2026-08-05&topUsersLimit=25000',
      contentType: 'application/json',
      body:
        '{"nodesUuids":["3a1f0c9e-6b2d-4f47-9c11-8d5e2b7a4c60"]}',
    },
  ],
  'users-reads': [
    { method: 'GET', url: '/api/users/4711', contentType: null, body: null },
    { method: 'GET', url: '/api/users/by-username/rz_login_sub', contentType: null, body: null },
  ],
  'devices-reads': [
    { method: 'GET', url: '/api/hwid/devices/top-users?start=0&size=100', contentType: null, body: null },
    { method: 'GET', url: '/api/hwid/devices?start=0&size=1000', contentType: null, body: null },
    { method: 'GET', url: '/api/hwid/devices/stats', contentType: null, body: null },
    {
      method: 'POST',
      url: '/api/connections/by-node/3a1f0c9e-6b2d-4f47-9c11-8d5e2b7a4c60',
      contentType: 'application/json',
      body:
        '{}',
    },
    { method: 'GET', url: '/api/connections/by-node/job-9', contentType: null, body: null },
    {
      method: 'POST',
      url: '/api/connections/by-user/4471',
      contentType: 'application/json',
      body:
        '{}',
    },
    { method: 'GET', url: '/api/connections/by-user/job-9', contentType: null, body: null },
  ],
  'infra-reads': [
    { method: 'GET', url: '/api/nodes/', contentType: null, body: null },
    { method: 'GET', url: '/api/internal-squads/', contentType: null, body: null },
    { method: 'GET', url: '/api/external-squads/', contentType: null, body: null },
    { method: 'GET', url: '/api/subscription-request-history/?start=0&size=500', contentType: null, body: null },
    { method: 'GET', url: '/api/system/metadata', contentType: null, body: null },
  ],
};
