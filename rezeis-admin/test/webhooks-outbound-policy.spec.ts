import 'reflect-metadata';

import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import axios from 'axios';
import { of } from 'rxjs';
import request from 'supertest';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { buildBoundedOutboundHttpOptions } from '../src/common/http/outbound-http-options';
import type { LookupAll } from '../src/common/net/outbound-url';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacService } from '../src/modules/rbac/services/rbac.service';
import { AdminWebhooksController } from '../src/modules/webhooks/controllers/admin-webhooks.controller';
import { WebhookDeliveriesService } from '../src/modules/webhooks/services/webhook-deliveries.service';
import { WebhookDispatcherService } from '../src/modules/webhooks/services/webhook-dispatcher.service';
import { WebhookSubscriptionsService } from '../src/modules/webhooks/services/webhook-subscriptions.service';

/**
 * The panel's own outgoing webhooks follow the outbound policy
 * ═══════════════════════════════════════════════════════════
 *
 * A subscription URL was checked for its scheme and its shape, and nothing
 * else: `webhooks:create` could point the panel's signed event feed at the
 * Docker API on the loopback or at the cloud metadata service, and the
 * dispatcher would POST there on every event. Now the policy the `webhook_post`
 * automation action follows (`common/net/outbound-url.ts`) applies here too:
 *
 *   - at save, a 400 that names the reason;
 *   - at send, the URL again (a subscription saved before this existed), then
 *     every address its host resolves to at the moment the socket connects;
 *     a refusal is a FINAL failure with the reason in the delivery log — never
 *     a silent drop, never a retry that cannot change the answer;
 *   - no redirects and no environment proxy, so neither can route around it.
 *
 * Private networks and compose service names stay allowed: that is where a
 * receiver beside the panel lives.
 */

// ── The subscriptions API, through the real guard, pipe and filter ──────────

interface SubscriptionRow {
  id: string;
  name: string;
  url: string;
  secret: string;
  eventTypes: string[];
  description: string | null;
  isActive: boolean;
  createdById: string | null;
  lastDeliveredAt: Date | null;
  consecutiveFailures: number;
  totalDeliveries: number;
  totalFailures: number;
  autoDisabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptions = new Map<string, SubscriptionRow>();
let app: INestApplication;

before(async () => {
  let counter = 0;
  const prisma = {
    webhookSubscription: {
      findMany: async () => [...subscriptions.values()].map((row) => ({ ...row })),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = subscriptions.get(where.id);
        return row === undefined ? null : { ...row };
      },
      create: async ({ data }: { data: Partial<SubscriptionRow> }) => {
        counter += 1;
        const now = new Date();
        const row: SubscriptionRow = {
          id: `sub-${counter}`,
          name: data.name ?? '',
          url: data.url ?? '',
          secret: data.secret ?? '',
          eventTypes: data.eventTypes ?? [],
          description: data.description ?? null,
          isActive: data.isActive ?? true,
          createdById: data.createdById ?? null,
          lastDeliveredAt: null,
          consecutiveFailures: 0,
          totalDeliveries: 0,
          totalFailures: 0,
          autoDisabledAt: null,
          createdAt: now,
          updatedAt: now,
        };
        subscriptions.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = subscriptions.get(where.id);
        if (row === undefined) throw Object.assign(new Error('not found'), { code: 'P2025' });
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) (row as unknown as Record<string, unknown>)[key] = value;
        }
        return { ...row };
      },
    },
  };
  const rbacService = new RbacService({
    adminRole: {
      findUnique: async () => ({
        name: 'custom-hooks',
        isSystem: false,
        permissions: [
          { resource: 'webhooks', action: 'view' },
          { resource: 'webhooks', action: 'create' },
          { resource: 'webhooks', action: 'edit' },
        ],
      }),
    },
    $transaction: async () => {
      throw new Error('no seed here');
    },
  } as never);

  const moduleRef = await Test.createTestingModule({
    controllers: [AdminWebhooksController],
    providers: [
      { provide: WebhookSubscriptionsService, useValue: new WebhookSubscriptionsService(prisma as never) },
      { provide: WebhookDeliveriesService, useValue: {} },
      { provide: WebhookDispatcherService, useValue: {} },
      { provide: RbacService, useValue: rbacService },
    ],
  })
    .overrideGuard(AdminJwtAuthGuard)
    .useValue({
      canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }): boolean => {
        context.switchToHttp().getRequest()['user'] = {
          id: 'admin-hooks',
          login: 'admin-hooks',
          email: null,
          name: null,
          role: 'ADMIN',
          isActive: true,
          tokenVersion: 0,
          createdAt: new Date(),
          lastLoginAt: null,
          lastLoginIp: null,
          rbacRoleId: 'role-hooks',
          mustChangePassword: false,
        };
        return true;
      },
    })
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('/api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new AdminSafeExceptionFilter());
  await app.init();
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  subscriptions.clear();
});

function create(url: string): request.Test {
  return request(app.getHttpServer())
    .post('/api/admin/webhooks/subscriptions')
    .send({ name: 'Receiver', url, eventTypes: [] });
}

function messages(body: unknown): string[] {
  const message = (body as { message?: unknown }).message;
  return Array.isArray(message) ? (message as string[]) : [String(message)];
}

describe('a subscription URL is checked at save', () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['http://127.0.0.1:2375/containers/create', 'the URL points at a loopback address (127.0.0.0/8)'],
    ['http://[::1]:8080/', 'the URL points at a loopback address (::1/128)'],
    ['http://0.0.0.0:9000/', 'the URL points at an unspecified address (0.0.0.0/8)'],
    ['http://169.254.169.254/latest/meta-data/iam/', 'the URL points at a link-local address, where cloud metadata services answer (169.254.0.0/16)'],
    ['http://[fd00:ec2::254]/latest/', 'the URL points at a cloud metadata address (fd00:ec2::254/128)'],
    ['http://100.100.100.200/latest/meta-data/', 'the URL points at a cloud metadata address (100.100.100.200/32)'],
    ['http://localhost:5678/webhook', 'the URL names this machine itself (localhost)'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'the URL names a cloud metadata service'],
  ];
  for (const [url, problem] of refused) {
    it(`refuses ${url}, naming why, and saves nothing`, async () => {
      const response = await create(url);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.deepStrictEqual(messages(response.body), [`The panel does not send webhooks there: ${problem}`]);
      assert.equal(subscriptions.size, 0);
    });
  }

  it('saves a receiver on the compose network, on a private address and on Tailscale', async () => {
    for (const url of ['http://n8n:5678/webhook/rezeis', 'http://10.0.0.5:8080/hook', 'http://100.101.102.103/hook']) {
      const response = await create(url);
      assert.equal(response.status, 201, `${url}: ${JSON.stringify(response.body)}`);
    }
    assert.equal(subscriptions.size, 3);
  });

  it('refuses to change a subscription’s URL to the loopback, and keeps the old one', async () => {
    const created = await create('http://n8n:5678/webhook/rezeis');
    const id = created.body.id as string;
    const response = await request(app.getHttpServer())
      .patch(`/api/admin/webhooks/subscriptions/${id}`)
      .send({ url: 'http://127.0.0.1:2375/containers/create' });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.deepStrictEqual(messages(response.body), [
      'The panel does not send webhooks there: the URL points at a loopback address (127.0.0.0/8)',
    ]);
    assert.equal(subscriptions.get(id)?.url, 'http://n8n:5678/webhook/rezeis');
  });
});

// ── The dispatcher ──────────────────────────────────────────────────────────

interface DeliveryRow {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: unknown;
  status: string;
  attempt: number;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  nextRetryAt: Date | null;
  finishedAt: Date | null;
}

interface Dispatch {
  readonly dispatcher: WebhookDispatcherService;
  readonly delivery: DeliveryRow;
  readonly subscription: { consecutiveFailures: number; totalFailures: number; totalDeliveries: number; isActive: boolean };
  readonly posts: Array<{ url: string; config: Record<string, unknown> }>;
  readonly retries: string[];
}

/** One delivery to `url`, over a dispatcher whose DNS answers from `dns`. */
function dispatchTo(
  url: string,
  options: { readonly dns?: Record<string, string[]>; readonly http?: HttpService } = {},
): Dispatch {
  const delivery: DeliveryRow = {
    id: 'delivery-1',
    subscriptionId: 'sub-1',
    eventType: 'payment.completed',
    payload: { event: 'payment.completed', metadata: {} },
    status: 'PENDING',
    attempt: 0,
    httpStatus: null,
    responseBody: null,
    errorMessage: null,
    nextRetryAt: null,
    finishedAt: null,
  };
  const subscription = { consecutiveFailures: 0, totalFailures: 0, totalDeliveries: 0, isActive: true };
  const posts: Array<{ url: string; config: Record<string, unknown> }> = [];
  const retries: string[] = [];
  const increment = (value: unknown, current: number): number =>
    typeof value === 'object' && value !== null ? current + Number((value as { increment?: number }).increment ?? 0) : Number(value);
  const prisma = {
    webhookDelivery: {
      findUnique: async () => ({
        ...delivery,
        subscription: { id: 'sub-1', url, secret: 'whsec-test', isActive: subscription.isActive, consecutiveFailures: subscription.consecutiveFailures },
      }),
      update: async ({ data }: { data: Partial<DeliveryRow> }) => Object.assign(delivery, data),
    },
    webhookSubscription: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if ('consecutiveFailures' in data) subscription.consecutiveFailures = increment(data['consecutiveFailures'], subscription.consecutiveFailures);
        if ('totalFailures' in data) subscription.totalFailures = increment(data['totalFailures'], subscription.totalFailures);
        if ('totalDeliveries' in data) subscription.totalDeliveries = increment(data['totalDeliveries'], subscription.totalDeliveries);
        if (data['isActive'] === false) subscription.isActive = false;
        return {};
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  };
  const http =
    options.http ??
    ({
      post: (target: string, _body: unknown, config: Record<string, unknown>) => {
        posts.push({ url: target, config });
        return of({ status: 200, data: 'ok' });
      },
    } as unknown as HttpService);
  const queue = {
    enqueueImmediate: async () => undefined,
    enqueueDelayed: async (id: string) => {
      retries.push(id);
    },
  };
  const lookupAll: LookupAll = (hostname, _options, callback) => {
    const addresses = options.dns?.[hostname];
    if (addresses === undefined) {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
      return;
    }
    callback(null, addresses.map((address): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
  const dispatcher = new WebhookDispatcherService(prisma as never, http, queue as never, lookupAll);
  return { dispatcher, delivery, subscription, posts, retries };
}

describe('a delivery is judged again when it is sent', () => {
  it('fails a delivery to a stored loopback URL with the reason in its log, sends nothing and does not retry', async () => {
    const run = dispatchTo('http://127.0.0.1:2375/containers/create');

    await run.dispatcher.processDelivery('delivery-1');

    assert.equal(run.delivery.status, 'FAILED');
    assert.equal(run.delivery.errorMessage, 'Refused before sending: the URL points at a loopback address (127.0.0.0/8)');
    assert.deepStrictEqual(run.posts, [], 'the request went out anyway');
    assert.deepStrictEqual(run.retries, [], 'a refusal was queued for a retry that cannot change it');
    assert.equal(run.subscription.consecutiveFailures, 1, 'the refusal is not counted as a failure');
    assert.equal(run.subscription.totalFailures, 1);
  });

  it('fails a delivery to a cloud metadata service by name', async () => {
    const run = dispatchTo('http://metadata.google.internal/computeMetadata/v1/');

    await run.dispatcher.processDelivery('delivery-1');

    assert.equal(run.delivery.status, 'FAILED');
    assert.equal(run.delivery.errorMessage, 'Refused before sending: the URL names a cloud metadata service');
    assert.deepStrictEqual(run.posts, []);
  });

  it('sends to a compose service name with no proxy, no redirect and agents that judge every address', async () => {
    const run = dispatchTo('http://n8n:5678/webhook/rezeis', {
      dns: { n8n: ['172.18.0.7'], 'loopback.example.test': ['127.0.0.1'], 'imds.example.test': ['169.254.169.254'] },
    });

    await run.dispatcher.processDelivery('delivery-1');

    assert.equal(run.delivery.status, 'SUCCEEDED', String(run.delivery.errorMessage));
    assert.equal(run.posts.length, 1);
    const { url, config } = run.posts[0]!;
    assert.equal(url, 'http://n8n:5678/webhook/rezeis');
    assert.equal(config['maxRedirects'], 0);
    assert.equal(config['proxy'], false, 'an environment proxy would resolve the host past the check');

    type LookupFn = (host: string, opts: Record<string, unknown>, cb: (err: Error | null, address?: unknown) => void) => void;
    const lookup = (config['httpAgent'] as { options: { lookup: LookupFn } }).options.lookup;
    assert.equal(typeof lookup, 'function', 'the agent carries no guarded lookup');
    assert.equal(lookup, (config['httpsAgent'] as { options: { lookup: LookupFn } }).options.lookup);
    const ask = (host: string) =>
      new Promise<{ error: Error | null; address?: unknown }>((resolve) => lookup(host, {}, (error, address) => resolve({ error, address })));
    assert.deepStrictEqual(await ask('n8n'), { error: null, address: '172.18.0.7' });
    for (const host of ['loopback.example.test', 'imds.example.test']) {
      const answer = await ask(host);
      assert.equal(answer.error?.name, 'OutboundAddressRefusedError', `${host} was handed to the socket`);
    }
  });
});

describe('through the real HTTP client, against a real socket', () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  before(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reaches the stand-in server at all — the control that makes "nothing heard" mean something', async () => {
    const before = hits;
    await axios.post(`http://127.0.0.1:${port}/control`, 'x', { proxy: false });
    assert.equal(hits, before + 1);
  });

  it('refuses at the moment of connecting a name that resolves to the loopback, and the receiver hears nothing', async () => {
    const before = hits;
    const run = dispatchTo(`http://rebind.example.test:${port}/hook`, {
      dns: { 'rebind.example.test': ['127.0.0.1'] },
      http: new HttpService(axios.create(buildBoundedOutboundHttpOptions())),
    });

    await run.dispatcher.processDelivery('delivery-1');

    assert.equal(hits, before, 'the delivery reached the loopback server');
    assert.equal(run.delivery.status, 'FAILED', String(run.delivery.errorMessage));
    assert.equal(
      run.delivery.errorMessage,
      'Refused before sending: rebind.example.test resolves to a loopback address (127.0.0.0/8): 127.0.0.1',
    );
    assert.deepStrictEqual(run.retries, []);
  });
});
