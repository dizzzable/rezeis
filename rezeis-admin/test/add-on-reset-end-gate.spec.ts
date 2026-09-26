import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { InternalAddOnsController } from '../src/modules/add-ons/controllers/internal-add-ons.controller';
import { AddOnEligibilityService } from '../src/modules/add-ons/services/add-on-eligibility.service';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import { InternalAddOnsPurchaseController } from '../src/modules/payments/controllers/internal-addons-purchase.controller';
import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';
import {
  CABINET_CAPABILITY,
  CabinetView,
  capabilityRowsHostedBy,
} from '../src/modules/reiwa-peers/cabinet-capabilities';
import { ReiwaPeerRegistry } from '../src/modules/reiwa-peers/reiwa-peer-registry.service';
import { memoryRawCache } from './helpers/memory-raw-cache';

/**
 * «ДО СБРОСА» ONLY THROUGH A CABINET THAT CAN SHOW IT (pair reliability, 26.09.2026)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Reiwa 0.9.7.52 and older print «докупка трафика до сброса» as «Действует до
 * 01.10.26»: no word of the reset, by the phone's clock, no warning of a reset
 * less than a day away. So the panel withholds exactly that add-on from such a
 * cabinet — in the listing, at the checkout (a page opened before the update),
 * and in «Трафик исчерпан»'s «📦 Докупить трафик» — and from nothing else.
 *
 * The audience comes from the caller's own headers (0.9.7.54 and later) or,
 * for a silent caller, from the evidence it left: a poll is 0.9.7.53, which
 * shows «до сброса» and must keep selling it — it is the cabinet in every
 * "panel first" gap of this pair.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024n * 1024n * 1024n;
const NOW = Date.now();
const ENDS_AT = new Date(NOW + 20 * DAY_MS);

/** Stage 4 («Докупка трафика до сброса») and direct purchase on, as the panel ships them. */
const STAGE_4_ON = {
  flags: async () => resolveAddOnRolloutFlags({ durableAccounting: true, trafficResetExpiry: true }, {}),
};

type AddOnKind = 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES' | 'RESET_TRAFFIC';

/**
 * One subscriber on a 100 GB / 3-device plan in the term model, and a
 * catalogue — for the real listing and the real checkout alike.
 */
function subscriber(options: {
  readonly strategy?: 'MONTH' | 'NO_RESET';
  readonly lifetime?: boolean;
  readonly catalog?: readonly AddOnKind[];
} = {}) {
  const strategy = options.strategy ?? 'MONTH';
  const expiresAt = options.lifetime === true ? null : ENDS_AT;
  const subscription = {
    id: 'sub-1',
    userId: 'user-1',
    status: 'ACTIVE',
    trafficLimit: 100,
    deviceLimit: 3,
    expiresAt,
    createdAt: new Date(NOW - 10 * DAY_MS),
    remnawaveProfileCreatedAt: null,
    planSnapshot: { id: 'plan-a', trafficLimitStrategy: strategy, trafficLimit: 100, deviceLimit: 3 },
  };
  const term = {
    id: 'term-1',
    planId: 'plan-a',
    startsAt: new Date(NOW - 10 * DAY_MS),
    endsAt: expiresAt,
    baseTrafficLimitBytes: 100n * GIB,
    baseDeviceLimit: 3,
    trafficResetStrategy: strategy,
    resetAnchorAt: new Date(NOW - 10 * DAY_MS),
  };
  const catalog = (options.catalog ?? ['EXTRA_TRAFFIC', 'EXTRA_DEVICES', 'RESET_TRAFFIC']).map((type) => ({
    id: `addon-${type.toLowerCase()}`,
    revision: 1,
    name: type,
    description: null,
    type,
    icon: null,
    value: type === 'EXTRA_DEVICES' ? 1 : 50,
    lifetime: 'UNTIL_SUBSCRIPTION_END',
    freeUsesPerTerm: 0,
    isActive: true,
    archivedAt: null,
    orderIndex: 0,
    applicablePlanIds: [] as string[],
    prices: [{ currency: 'RUB', price: '99' }],
  }));
  const created: Array<Record<string, unknown>> = [];
  const counters = { providerCalls: 0 };
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
    subscription: { findUnique: async () => subscription },
    subscriptionTerm: { findFirst: async () => ({ ...term }) },
    subscriptionEffectiveProjection: { findUnique: async () => null },
    user: { findFirst: async () => ({ id: 'user-1' }) },
    addOn: {
      findMany: async () => catalog,
      findUnique: async (args: { where: { id: string } }) => {
        const row = catalog.find((candidate) => candidate.id === args.where.id);
        return row === undefined ? null : { ...row, prices: [{ currency: 'RUB', price: { toString: () => '99' } }] };
      },
    },
    paymentGateway: {
      findUnique: async () => ({ type: 'YOOKASSA', isActive: true, currency: 'RUB', settings: { shopId: 's', apiKey: 'k' } }),
    },
    transaction: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'tx-1', paymentId: 'pay-1', createdAt: new Date(), ...args.data };
      },
      update: async (args: { data: Record<string, unknown> }) => ({
        id: 'tx-1',
        paymentId: 'pay-1',
        status: 'PENDING',
        gatewayType: 'YOOKASSA',
        purchaseType: 'ADDITIONAL',
        amount: { toString: () => '99' },
        currency: 'RUB',
        createdAt: new Date(),
        ...args.data,
      }),
    },
  };
  const trafficReset = {
    describeAllowance: async () => ({ freeUsesPerTerm: 0, freeRemaining: 0, isFree: false }),
  };
  const offers = new AddOnEligibilityService(prisma as never, trafficReset as never, STAGE_4_ON as never);
  const checkout = new AddOnPurchaseService(
    prisma as never,
    { buildSnapshot: () => ({ price: '99' }) } as never,
    {
      createCheckout: async () => {
        counters.providerCalls += 1;
        return { gatewayId: 'g', gatewayData: {}, checkoutUrl: 'https://pay.example/x', providerMode: 'REDIRECT' };
      },
    } as never,
    { applyCompletedTransaction: async () => ({ syncJobs: [] }) } as never,
    { enqueue: async () => undefined } as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
    { evaluate: () => null } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined, emit: () => undefined } as never,
    { alignTailToExpiryInTransaction: async () => ({ outcome: 'NOT_IN_MODEL' }) } as never,
    STAGE_4_ON as never,
  );
  return { offers, checkout, created, counters };
}

/** What a listing offers, add-on type → the lifetime it is sold with. */
async function listed(offers: AddOnEligibilityService, audience: CabinetView): Promise<Record<string, string>> {
  const result = await offers.listForSubscription('sub-1', { userId: 'user-1' }, audience);
  return Object.fromEntries(result.addOns.map((addOn) => [addOn.type, addOn.lifetime]));
}

function refusalCode(error: unknown): string | null {
  if (!(error instanceof BadRequestException)) return null;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'code' in body ? String((body as Record<string, unknown>)['code']) : null;
}

const WITHOUT = CabinetView.of(
  capabilityRowsHostedBy('api')
    .map((row) => row.id)
    .filter((id) => id !== CABINET_CAPABILITY.addonResetEnd),
  'a cabinet with everything but the reset end',
);
const DECLARED_ALL = {
  'x-reiwa-client': 'surface=api; version=0.9.7.54; instance=reiwa',
  'x-reiwa-capabilities': capabilityRowsHostedBy('api').map((row) => row.id).join(','),
};

describe('the listing', () => {
  it('offers traffic «до сброса» to a cabinet that shows it, and withholds exactly that from one that does not', async () => {
    const { offers } = subscriber();
    assert.deepEqual(await listed(offers, CabinetView.all()), {
      EXTRA_TRAFFIC: 'UNTIL_NEXT_RESET',
      EXTRA_DEVICES: 'UNTIL_SUBSCRIPTION_END',
      RESET_TRAFFIC: 'UNTIL_SUBSCRIPTION_END',
    });
    const without = { EXTRA_DEVICES: 'UNTIL_SUBSCRIPTION_END', RESET_TRAFFIC: 'UNTIL_SUBSCRIPTION_END' };
    assert.deepEqual(await listed(offers, WITHOUT), without, 'devices and the reset are not touched');
    assert.deepEqual(await listed(offers, CabinetView.floor()), without);
  });

  it('does not touch traffic on a plan without a reset: it is sold «до конца подписки» to any cabinet', async () => {
    const { offers } = subscriber({ strategy: 'NO_RESET' });
    assert.deepEqual(await listed(offers, CabinetView.floor()), {
      EXTRA_TRAFFIC: 'UNTIL_SUBSCRIPTION_END',
      EXTRA_DEVICES: 'UNTIL_SUBSCRIPTION_END',
      RESET_TRAFFIC: 'UNTIL_SUBSCRIPTION_END',
    });
  });
});

describe('the checkout', () => {
  it('refuses «до сброса» to a cabinet that cannot show it: no draft, no invoice', async () => {
    const { checkout, created, counters } = subscriber();
    let refused: unknown = null;
    try {
      await checkout.checkout({
        userId: 'user-1',
        addOnId: 'addon-extra_traffic',
        subscriptionId: 'sub-1',
        gatewayType: 'YOOKASSA' as never,
        contractVersion: 2,
        audience: WITHOUT,
      });
    } catch (error: unknown) {
      refused = error;
    }
    assert.equal(refusalCode(refused), 'ADDON_LIFETIME_UNAVAILABLE');
    assert.deepEqual(created, []);
    assert.equal(counters.providerCalls, 0);
  });

  it('drafts it, as «до сброса», for a cabinet that shows it', async () => {
    const { checkout, created } = subscriber();
    await checkout.checkout({
      userId: 'user-1',
      addOnId: 'addon-extra_traffic',
      subscriptionId: 'sub-1',
      gatewayType: 'YOOKASSA' as never,
      contractVersion: 2,
      audience: CabinetView.all(),
    });
    assert.equal(created.length, 1);
    assert.equal((created[0]!['planSnapshot'] as Record<string, unknown>)['lifetime'], 'UNTIL_NEXT_RESET');
  });

  it('sells devices to any cabinet', async () => {
    const { checkout, created } = subscriber();
    await checkout.checkout({
      userId: 'user-1',
      addOnId: 'addon-extra_devices',
      subscriptionId: 'sub-1',
      gatewayType: 'YOOKASSA' as never,
      contractVersion: 2,
      audience: CabinetView.floor(),
    });
    assert.equal(created.length, 1);
  });
});

describe('through the cabinet routes, the caller is the audience', () => {
  function routes() {
    const cache = memoryRawCache();
    const peers = new ReiwaPeerRegistry(cache.store);
    const world = subscriber();
    return {
      peers,
      world,
      listing: new InternalAddOnsController({} as never, world.offers, {} as never, peers),
      purchase: new InternalAddOnsPurchaseController(world.checkout, peers),
    };
  }
  const buy = { userId: 'user-1', addOnId: 'addon-extra_traffic', subscriptionId: 'sub-1', gatewayType: 'YOOKASSA' } as never;

  it('a cabinet that declares it is offered and sold «до сброса»', async () => {
    const { listing, purchase, world } = routes();
    const result = await listing.listForSubscription('sub-1', 'user-1', undefined, DECLARED_ALL);
    assert.ok(result.addOns.some((addOn) => addOn.lifetime === 'UNTIL_NEXT_RESET'));
    await purchase.purchase(buy, DECLARED_ALL);
    assert.equal(world.created.length, 1);
  });

  it('a cabinet of 0.9.7.54 that does not declare it is not', async () => {
    const { listing, purchase, world } = routes();
    const declaredLess = { ...DECLARED_ALL, 'x-reiwa-capabilities': CABINET_CAPABILITY.appearanceReport };
    const result = await listing.listForSubscription('sub-1', 'user-1', undefined, declaredLess);
    assert.equal(result.addOns.some((addOn) => addOn.lifetime === 'UNTIL_NEXT_RESET'), false);
    await assert.rejects(() => purchase.purchase(buy, declaredLess), (error: unknown) => refusalCode(error) === 'ADDON_LIFETIME_UNAVAILABLE');
    assert.deepEqual(world.created, []);
  });

  it('a silent caller with no evidence gets the floor; after the 0.9.7.53 poll it is served again', async () => {
    const { listing, purchase, peers, world } = routes();
    const before = await listing.listForSubscription('sub-1', 'user-1', undefined, {});
    assert.equal(before.addOns.some((addOn) => addOn.lifetime === 'UNTIL_NEXT_RESET'), false);
    await assert.rejects(() => purchase.purchase(buy, {}), (error: unknown) => refusalCode(error) === 'ADDON_LIFETIME_UNAVAILABLE');

    await peers.observePoll('api', {});
    const after = await listing.listForSubscription('sub-1', 'user-1', undefined, {});
    assert.ok(after.addOns.some((addOn) => addOn.lifetime === 'UNTIL_NEXT_RESET'), 'the 0.9.7.53 cabinet keeps «до сброса»');
    await purchase.purchase(buy, {});
    assert.equal(world.created.length, 1);
  });

  it('a silent caller whose site only heartbeats 0.9.7.52 is not served it', async () => {
    const { listing, peers } = routes();
    await peers.observeHeartbeat('0.9.7.52', undefined);
    const result = await listing.listForSubscription('sub-1', 'user-1', undefined, undefined);
    assert.equal(result.addOns.some((addOn) => addOn.lifetime === 'UNTIL_NEXT_RESET'), false);
    assert.equal(result.addOns.length, 2, 'devices and the reset still are');
  });
});

describe('«Трафик исчерпан» asks the offer for the cabinet’s web', () => {
  const SEEDED_LIMITED = DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.type === 'limited');

  async function notice(peers: ReiwaPeerRegistry | undefined): Promise<Record<string, unknown>> {
    // A subscription with no end date on a monthly plan: its only way to more
    // traffic is the «до сброса» add-on.
    const world = subscriber({ lifetime: true, catalog: ['EXTRA_TRAFFIC'] });
    const written: Array<Record<string, unknown>> = [];
    const pushed: unknown[] = [];
    const prisma = {
      userNotificationEvent: {
        create: async (args: { data: { userId: string; type: string; payload: Record<string, unknown> } }) => {
          written.push(args.data.payload);
          return { id: 'evt-1', userId: args.data.userId, type: args.data.type, payload: args.data.payload };
        },
        count: async () => 0,
        update: async () => ({}),
      },
      user: {
        findUnique: async () => ({
          telegramId: 42n,
          isBotBlocked: false,
          name: 'Вася',
          username: null,
          language: 'RU',
          notificationPrefs: null,
        }),
      },
      settings: { findUnique: async () => null },
    };
    const moduleRef = {
      get: (token: unknown) => {
        if (token !== AddOnEligibilityService) throw new Error('unknown provider');
        return world.offers;
      },
    };
    const service = new UserNotificationsService(
      prisma as never,
      {
        getByType: async (type: string) => ({
          type,
          title: 'T',
          body: 'B',
          titleEn: null,
          bodyEn: null,
          isActive: true,
          bannerUrl: null,
          buttons: SEEDED_LIMITED?.buttons,
        }),
      } as never,
      {} as never,
      {
        sendToUser: async (payload: unknown) => {
          pushed.push(payload);
          return { attempted: 1, delivered: 1, failed: 0, disabled: false };
        },
      } as never,
      { substituteTelegramHtml: async (text: string) => text, substituteFallbacks: async (text: string) => text } as never,
      { enqueue: async () => true } as never,
      undefined,
      undefined,
      undefined,
      moduleRef as never,
      peers,
    );
    await service.create({ userId: 'u-1', type: 'limited', payload: { subscriptionId: 'sub-1', expiresAt: null } });
    // Let the background fan-out finish before the next case builds its own.
    for (let turn = 0; turn < 50 && pushed.length === 0; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return written[0]!;
  }

  it('a cabinet that shows «до сброса» gets the button; one whose site heartbeats 0.9.7.52 does not', async () => {
    const current = new ReiwaPeerRegistry(memoryRawCache().store);
    await current.observePoll('api', undefined);
    assert.equal((await notice(current))['trafficTopUp'], true);

    const old = new ReiwaPeerRegistry(memoryRawCache().store);
    await old.observeHeartbeat('0.9.7.52', undefined);
    assert.equal((await notice(old))['trafficTopUp'], false, 'nothing that cabinet lists brings traffic back');
  });

  it('a cabinet the panel does not know leaves the answer out, so the notice keeps its buttons (review R1-08)', async () => {
    // Never heard from: the floor would stand in at a gate, but written into
    // the notice it would outlast the moment.
    const never = new ReiwaPeerRegistry(memoryRawCache().store);
    assert.equal('trafficTopUp' in (await notice(never)), false);

    // Its records unreadable right now.
    const cache = memoryRawCache();
    const unreadable = new ReiwaPeerRegistry(cache.store);
    await unreadable.observePoll('api', undefined);
    cache.down();
    assert.equal('trafficTopUp' in (await notice(unreadable)), false);

    // No registry at all (a spec, a partial module).
    assert.equal('trafficTopUp' in (await notice(undefined)), false);
  });
});
