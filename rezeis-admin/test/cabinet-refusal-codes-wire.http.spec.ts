import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  BadRequestException,
  INestApplication,
  Provider,
  ServiceUnavailableException,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { DeviceIntelligenceService } from '../src/modules/device-intelligence/services/device-intelligence.service';
import { InternalUserController } from '../src/modules/internal-user/controllers/internal-user.controller';
import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';
import { InternalAddOnsPurchaseController } from '../src/modules/payments/controllers/internal-addons-purchase.controller';
import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';
import { CabinetView } from '../src/modules/reiwa-peers/cabinet-capabilities';
import { ReiwaPeerRegistry } from '../src/modules/reiwa-peers/reiwa-peer-registry.service';
import { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';

/**
 * THE FOUR REFUSAL CODES THE REIWA CABINET BRANCHES ON, ON THE BYTES IT READS
 * (pair reliability, 26.09.2026)
 *
 * Every throw site below has sent `{ code, message }` all along, and every
 * service spec asserted exactly that — on the exception object, which never
 * meets the global `AdminSafeExceptionFilter`. The filter forwards a `code` only
 * when it is in `SAFE_PRODUCT_CODES`, and these four were not. So the wire
 * carried the sentence and a status-derived `errorCode` (`BAD_REQUEST`,
 * `CONFLICT`, `INTERNAL_SERVER_ERROR`, `FORBIDDEN`) and no `code`, and the
 * cabinet reads the `code` and nothing else (`readUpstreamCode`, reiwa
 * `src/api/lib/upstream-error.ts`):
 *
 *  - `USER_BLOCKED`. Reiwa ends a blocked customer's session on this code
 *    (`src/api/lib/stale-user-session.ts`, since 0.9.7.19). It never arrived,
 *    so a customer signed in when the operator blocked them kept the cabinet:
 *    the profile read was refused and the cookie survived it.
 *  - `ADDON_LIFETIME_UNAVAILABLE`, `ADDON_REVISION_CONFLICT`,
 *    `PROVIDER_OUTCOME_UNKNOWN`. The add-on purchase page words each refusal
 *    and returns to the step where it can be fixed (Reiwa 0.9.7.54). Without
 *    the code it could recognise them only by their exact English sentence.
 *    The pair E2E's scenario 21 asks the add-on checkout directly, silent and
 *    signed, and requires `ADDON_LIFETIME_UNAVAILABLE` on the answer.
 *
 * The rule of `internal-payments-renewal-refusals.http.spec.ts`: no stubs on
 * the path under test. The real controllers, the real services with their real
 * throws, the real router, the real global `ValidationPipe` and the real
 * `AdminSafeExceptionFilter` run, wired as `src/main.ts` wires them (that spec
 * holds `main.ts` to installing the filter). Only the edges are faked: Prisma,
 * pricing, the payment provider, the platform policy, the event bus, the add-on
 * switches, the API-token guard, and the cabinet registry — the audience is an
 * input of the checkout here, not the seam. What is asserted is the response
 * text a cabinet parses.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024n * 1024n * 1024n;

/**
 * Everything the filter writes for a `{ code, message }` refusal. The code
 * joins the envelope and nothing else from the exception body does.
 */
const REFUSAL_KEYS = ['code', 'errorCode', 'message', 'path', 'requestId', 'statusCode', 'timestamp'];

const PURCHASE_ROUTE = '/api/internal/add-ons/purchase';

/** What the cabinet posts: only DTO fields, since the real pipe forbids the rest. */
const PURCHASE = {
  userId: 'user-1',
  addOnId: 'addon-1',
  subscriptionId: 'sub-1',
  gatewayType: 'YOOKASSA',
  contractVersion: 2,
  idempotencyKey: 'addon-checkout-key-1',
};

let application: INestApplication | undefined;

async function boot(controllers: Type<unknown>[], providers: Provider[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ controllers, providers })
    // Token verification decides whether a call is admitted, never what its
    // refusal looks like.
    .overrideGuard(InternalAdminAuthGuard)
    .useValue({ canActivate: (): boolean => true })
    .compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('/api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new AdminSafeExceptionFilter());
  await app.init();
  application = app;
  return app;
}

async function closeApplication(): Promise<void> {
  await application?.close();
  application = undefined;
}

/**
 * The code as the cabinet reads it: `readUpstreamCode` parses the raw text and
 * takes the top-level `code`, else the one under `message`. Read off
 * `response.text`, not supertest's parsed body, so the assertion is on bytes.
 */
function wireCode(text: string): string | null {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const top = (parsed as { code?: unknown }).code;
  if (typeof top === 'string' && top.length > 0) return top;
  const nested = (parsed as { message?: unknown }).message;
  if (typeof nested === 'object' && nested !== null) {
    const inner = (nested as { code?: unknown }).code;
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return null;
}

function assertForwarded(
  response: { readonly status: number; readonly text: string },
  expected: { readonly status: number; readonly code: string; readonly message: string },
): void {
  const seen = `${response.status} ${response.text}`;
  // The code first: it is the part that went missing.
  assert.equal(
    wireCode(response.text),
    expected.code,
    `the cabinet reads no ${expected.code} in the panel's answer: ${seen}`,
  );
  assert.equal(response.status, expected.status, seen);
  const body = JSON.parse(response.text) as Record<string, unknown>;
  assert.equal(body['errorCode'], expected.code, seen);
  assert.equal(body['message'], expected.message, `the sentence beside the code did not survive: ${seen}`);
  assert.deepEqual(Object.keys(body).sort(), REFUSAL_KEYS, `more than the code joined the envelope: ${seen}`);
}

// ── The add-on checkout ────────────────────────────────────────────────────

interface CheckoutWorld {
  /** What the add-on adds. */
  readonly addOn: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  /** A subscription with no end date. */
  readonly lifetime?: boolean;
  /** The purchaser's `users.is_blocked`. */
  readonly blocked?: boolean;
  /** The payment provider's create — the edge. */
  readonly provider?: () => Promise<unknown>;
  /** What the calling cabinet can show; a silent caller with no evidence gets the floor. */
  readonly audience?: CabinetView;
}

/**
 * One subscriber on a 100 GB / 3-device plan with a monthly reset, in the term
 * model, and one add-on priced in the gateway's currency.
 */
function addOnCheckout(world: CheckoutWorld): {
  readonly service: AddOnPurchaseService;
  readonly drafts: Array<Record<string, unknown>>;
} {
  const now = Date.now();
  const endsAt = world.lifetime === true ? null : new Date(now + 20 * DAY_MS);
  const startedAt = new Date(now - 10 * DAY_MS);
  const drafts: Array<Record<string, unknown>> = [];
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
    user: {
      // `assertPurchaserNotBlocked`, before anything else is read.
      findFirst: async () => ({ isBlocked: world.blocked === true }),
      // The payer's language for the provider's line.
      findUnique: async () => ({ language: 'RU', telegramId: null }),
    },
    paymentGateway: {
      findUnique: async () => ({
        type: 'YOOKASSA',
        isActive: true,
        currency: 'RUB',
        settings: { shopId: 'shop', apiKey: 'key' },
      }),
    },
    subscription: {
      findUnique: async () => ({
        id: 'sub-1',
        userId: 'user-1',
        status: 'ACTIVE',
        trafficLimit: 100,
        deviceLimit: 3,
        planSnapshot: { id: 'plan-a', trafficLimitStrategy: 'MONTH', trafficLimit: 100, deviceLimit: 3 },
        createdAt: startedAt,
        expiresAt: endsAt,
        remnawaveProfileCreatedAt: null,
      }),
    },
    // Ends where the subscription does, so the checkout aligns nothing.
    subscriptionTerm: {
      findFirst: async () => ({
        baseTrafficLimitBytes: 100n * GIB,
        baseDeviceLimit: 3,
        planId: 'plan-a',
        startsAt: startedAt,
        endsAt,
        trafficResetStrategy: 'MONTH',
        resetAnchorAt: startedAt,
      }),
    },
    subscriptionEffectiveProjection: { findUnique: async () => null },
    addOn: {
      findUnique: async () => ({
        id: 'addon-1',
        revision: 1,
        name: world.addOn === 'EXTRA_DEVICES' ? '+1 device' : '+50 GB',
        type: world.addOn,
        value: world.addOn === 'EXTRA_DEVICES' ? 1 : 50,
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        isActive: true,
        applicablePlanIds: [] as string[],
        prices: [{ currency: 'RUB', price: { toString: () => '99' } }],
      }),
    },
    transaction: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        drafts.push(args.data);
        return { id: 'tx-1', paymentId: 'pay-1', createdAt: new Date(now), ...args.data };
      },
      update: async (args: { data: Record<string, unknown> }) => ({
        id: 'tx-1',
        paymentId: 'pay-1',
        createdAt: new Date(now),
        ...args.data,
      }),
    },
  };
  const service = new AddOnPurchaseService(
    prisma as never,
    { buildSnapshot: () => ({ price: '99' }) } as never,
    {
      createCheckout:
        world.provider ??
        (async () => ({
          gatewayId: 'g-1',
          gatewayData: {},
          checkoutUrl: 'https://pay.example/1',
          providerMode: 'REDIRECT',
        })),
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { enqueue: async () => undefined } as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
    { evaluate: () => null } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
    { alignTailToExpiryInTransaction: async () => ({ outcome: 'NOT_IN_MODEL' }) } as never,
    // «Новый учёт докупок» and «Докупка трафика до сброса» on, as the panel
    // ships them; the process environment is not read.
    { flags: async () => resolveAddOnRolloutFlags({ durableAccounting: true, trafficResetExpiry: true }, {}) } as never,
  );
  return { service, drafts };
}

async function checkoutRoute(world: CheckoutWorld): Promise<{
  readonly app: INestApplication;
  readonly drafts: Array<Record<string, unknown>>;
}> {
  const { service, drafts } = addOnCheckout(world);
  const app = await boot(
    [InternalAddOnsPurchaseController],
    [
      { provide: AddOnPurchaseService, useValue: service },
      {
        provide: ReiwaPeerRegistry,
        useValue: { viewOfRequest: async () => world.audience ?? CabinetView.all() },
      },
    ],
  );
  return { app, drafts };
}

describe('POST /api/internal/add-ons/purchase: the add-on checkout refusals on the wire', () => {
  afterEach(closeApplication);

  it('carries ADDON_LIFETIME_UNAVAILABLE at 400: devices «до конца подписки» on a subscription with no end date', async () => {
    const { app, drafts } = await checkoutRoute({ addOn: 'EXTRA_DEVICES', lifetime: true });

    const response = await request(app.getHttpServer()).post(PURCHASE_ROUTE).send(PURCHASE);

    assertForwarded(response, {
      status: 400,
      code: 'ADDON_LIFETIME_UNAVAILABLE',
      message: 'This add-on cannot be delivered for its advertised period on this subscription',
    });
    assert.deepEqual(drafts, [], 'refused before any draft');
  });

  it('carries ADDON_LIFETIME_UNAVAILABLE at 400: «до сброса» asked by a silent cabinet that cannot show it (E2E scenario 21)', async () => {
    const { app, drafts } = await checkoutRoute({ addOn: 'EXTRA_TRAFFIC', audience: CabinetView.floor() });

    const response = await request(app.getHttpServer()).post(PURCHASE_ROUTE).send(PURCHASE);

    assertForwarded(response, {
      status: 400,
      code: 'ADDON_LIFETIME_UNAVAILABLE',
      message: 'This add-on ends at the next traffic reset, which the calling cabinet cannot show; update Reiwa',
    });
    assert.deepEqual(drafts, [], 'refused before any draft');
  });

  it('carries ADDON_REVISION_CONFLICT at 409: the operator changed the add-on after the page read it', async () => {
    const { app, drafts } = await checkoutRoute({ addOn: 'EXTRA_DEVICES' });

    const response = await request(app.getHttpServer())
      .post(PURCHASE_ROUTE)
      .send({ ...PURCHASE, expectedAddOnRevision: 2 });

    assertForwarded(response, {
      status: 409,
      code: 'ADDON_REVISION_CONFLICT',
      message: 'Add-on changed since it was shown; refresh and try again',
    });
    assert.deepEqual(drafts, [], 'refused before any draft');
  });

  it('carries PROVIDER_OUTCOME_UNKNOWN at 503, sentence intact: the provider did not answer, and the draft is kept', async () => {
    const { app, drafts } = await checkoutRoute({
      addOn: 'EXTRA_DEVICES',
      provider: async () => {
        throw new ServiceUnavailableException('provider timed out');
      },
    });

    const response = await request(app.getHttpServer()).post(PURCHASE_ROUTE).send(PURCHASE);

    // 5xx is the band where the filter swaps anything it deems sensitive for
    // "Internal server error"; the warning is the payload here.
    assertForwarded(response, {
      status: 503,
      code: 'PROVIDER_OUTCOME_UNKNOWN',
      message: 'Payment provider outcome is unknown; awaiting reconciliation',
    });
    assert.equal(drafts.length, 1, 'the draft is kept for reconciliation, not deleted');
  });

  it('carries USER_BLOCKED at 403 for a blocked purchaser, before anything is read', async () => {
    const { app, drafts } = await checkoutRoute({ addOn: 'EXTRA_DEVICES', blocked: true });

    const response = await request(app.getHttpServer()).post(PURCHASE_ROUTE).send(PURCHASE);

    assertForwarded(response, { status: 403, code: 'USER_BLOCKED', message: 'This account is blocked' });
    assert.deepEqual(drafts, []);
  });

  it('still strips a code no client reads, on the same route', async () => {
    // A stand-in at the provider edge: a 400 the checkout passes on unchanged,
    // with a code nobody allowlisted. One entry per code, not "any code".
    const { app } = await checkoutRoute({
      addOn: 'EXTRA_DEVICES',
      provider: async () => {
        throw new BadRequestException({ code: 'NOT_AN_ALLOWLISTED_CODE', message: 'The provider refused the order' });
      },
    });

    const response = await request(app.getHttpServer()).post(PURCHASE_ROUTE).send(PURCHASE);

    const seen = `${response.status} ${response.text}`;
    assert.equal(response.status, 400, seen);
    assert.equal(wireCode(response.text), null, `an unlisted code reached the wire: ${seen}`);
    assert.equal((JSON.parse(response.text) as Record<string, unknown>)['errorCode'], 'BAD_REQUEST', seen);
  });
});

// ── The blocked account where the cabinet reads it ─────────────────────────

/**
 * `GET session` and `POST bootstrap` over the real `InternalUserService` and
 * `InternalUserEdgeService`. `user` is the row both read; `listed` puts the
 * Telegram id on the identity blocklist.
 */
async function userRoutes(options: {
  readonly user: Record<string, unknown> | null;
  readonly listed?: boolean;
}): Promise<INestApplication> {
  const prisma = { user: { findUnique: async () => options.user } };
  const users = new InternalUserService(prisma as never, {} as never, {} as never);
  const edge = new InternalUserEdgeService(
    prisma as never,
    // Settings, access mode, events and referrals are reached only by a
    // brand-new, unlisted Telegram id: empty, so reaching them would throw.
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { findByTelegramId: async () => (options.listed === true ? { id: 'entry-1' } : null) } as never,
  );
  return boot(
    [InternalUserController],
    [
      { provide: InternalUserService, useValue: users },
      { provide: InternalUserEdgeService, useValue: edge },
      { provide: SubscriptionMutationsService, useValue: {} },
      { provide: DeviceIntelligenceService, useValue: {} },
    ],
  );
}

const BLOCKED_ROW = { id: 'user-1', isBlocked: true };

describe('USER_BLOCKED on the routes the cabinet reads a session and signs in through', () => {
  afterEach(closeApplication);

  it('GET /api/internal/user/session: 403 USER_BLOCKED, the answer the cabinet ends the session on', async () => {
    const app = await userRoutes({ user: BLOCKED_ROW });

    const response = await request(app.getHttpServer()).get('/api/internal/user/session').query({ userId: 'user-1' });

    assertForwarded(response, { status: 403, code: 'USER_BLOCKED', message: 'USER_BLOCKED' });
  });

  it('POST /api/internal/user/bootstrap: 403 USER_BLOCKED for a blocked account', async () => {
    const app = await userRoutes({ user: BLOCKED_ROW });

    const response = await request(app.getHttpServer())
      .post('/api/internal/user/bootstrap')
      .send({ telegramId: '424242', name: 'Blocked Customer' });

    assertForwarded(response, { status: 403, code: 'USER_BLOCKED', message: 'This account is blocked' });
  });

  it('POST /api/internal/user/bootstrap: 403 USER_BLOCKED for a Telegram id on the blocklist', async () => {
    const app = await userRoutes({ user: null, listed: true });

    const response = await request(app.getHttpServer())
      .post('/api/internal/user/bootstrap')
      .send({ telegramId: '424242', name: 'Listed Customer' });

    assertForwarded(response, {
      status: 403,
      code: 'USER_BLOCKED',
      message: 'Registration is not available for this account',
    });
  });
});
