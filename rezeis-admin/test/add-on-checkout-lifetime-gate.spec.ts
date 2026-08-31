import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import { AddOnEligibilityService } from '../src/modules/add-ons/services/add-on-eligibility.service';
import { AddOnPurchaseService } from '../src/modules/payments/services/addon-purchase.service';

/**
 * ── The offer and the checkout must agree about UNTIL WHEN ──────────────────
 *
 * `test/addon-purchase.service.spec.ts` pins the RESOURCE axis: the two gates
 * must answer "is this subscription already unlimited?" the same way. This file
 * pins the LIFETIME axis, which was open in a nastier direction — checkout did
 * not ask at all.
 *
 * `AddOnEligibilityService` withholds a `UNTIL_NEXT_RESET` add-on whose reset
 * window the intake cannot honour. Withholding an OFFER is not a gate: a
 * crafted request, or an honest one replayed from a client that cached the
 * catalog before a rollout flag moved, still drafted, was paid, and reached
 * `PaymentSubscriptionMutationService.applyAddOnTopUp` — whose ledger path
 * declines an entitlement it cannot bind to a reset epoch and falls through to
 * the PERMANENT legacy increment. The customer paid for a temporary top-up and
 * received a permanent one, on a raw column, with no entitlement row anything
 * could ever expire.
 *
 * So every case asks the SAME world twice — once through the real
 * `AddOnEligibilityService` and once through the real `AddOnPurchaseService` —
 * and asserts on the PAIR. Asserting only on checkout would pass just as well
 * with checkout refusing everything, which is its own outage.
 */

const GIB = 1024n * 1024n * 1024n;

type Lifetime = 'UNTIL_NEXT_RESET' | 'UNTIL_SUBSCRIPTION_END';

/** The ACTIVE durable term as BOTH services select it. */
type TermRow = {
  baseTrafficLimitBytes: bigint | null;
  baseDeviceLimit: number | null;
  endsAt: Date | null;
  trafficResetStrategy: string;
  resetAnchorAt: Date | null;
};

/**
 * A term with a real commercial reset window: MONTH strategy and a panel-derived
 * anchor. Everything the reset-scoped lifetime needs EXCEPT the rollout flags,
 * so a case can vary the flags alone.
 */
const defaultTerm: TermRow = {
  baseTrafficLimitBytes: 100n * GIB,
  baseDeviceLimit: 3,
  endsAt: new Date('2099-01-01T00:00:00.000Z'),
  trafficResetStrategy: 'MONTH',
  resetAnchorAt: new Date('2026-01-01T00:00:00.000Z'),
};

type SubColumns = {
  trafficLimit: number | null;
  deviceLimit: number;
  planSnapshot: unknown;
  createdAt: Date;
  expiresAt: Date | null;
};

/** A never-individually-adjusted subscriber, so the term's baseline governs. */
const defaultSub: SubColumns = {
  trafficLimit: 100,
  deviceLimit: 3,
  planSnapshot: {
    id: 'plan-a',
    trafficLimitStrategy: 'MONTH',
    trafficLimit: 100,
    deviceLimit: 3,
    internalSquads: [],
    externalSquad: null,
  },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
};

/**
 * The two rollout flags the intake gate composes. Both are read per call from
 * `process.env`, so a case sets them around its own run and restores them.
 */
async function withEnv(
  vars: Readonly<Record<string, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Every rollout flag this file cares about, explicitly OFF. */
const FLAGS_OFF = {
  ADDON_ENTITLEMENT_DIRECT_PURCHASE: undefined,
  ADDON_RESET_EXPIRY_MONTH: undefined,
} as const;

interface Answer {
  readonly offered: boolean;
  readonly bought: boolean;
  readonly refusalCode: string | null;
  readonly refusalMessage: string | null;
  readonly draftsCreated: number;
  readonly providerCalls: number;
  readonly inlineGrants: number;
  readonly marker: Record<string, unknown> | null;
}

function refusalCodeOf(error: BadRequestException): string | null {
  const body = error.getResponse();
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const code = (body as Record<string, unknown>)['code'];
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * Runs one world past BOTH gates. The two services are handed the identical
 * subscription row, the identical ACTIVE term and the identical catalog entry,
 * so a disagreement here is a disagreement about the rule and never about the
 * fixture.
 */
async function askBoth(world: {
  readonly lifetime: Lifetime;
  readonly term?: Partial<TermRow> | null;
  readonly sub?: Partial<SubColumns>;
  /** `'0'` selects the free-add-on branch, which must be gated too. */
  readonly amount?: string;
}): Promise<Answer> {
  const columns: SubColumns = { ...defaultSub, ...world.sub };
  const term = world.term === null ? null : { ...defaultTerm, ...(world.term ?? {}) };
  const amount = world.amount ?? '2.50';

  const catalogRow = {
    id: 'addon-1',
    revision: 3,
    name: 'Extra 50GB',
    description: null,
    type: 'EXTRA_TRAFFIC' as const,
    icon: null,
    value: 50,
    lifetime: world.lifetime,
    isActive: true,
    archivedAt: null,
    orderIndex: 0,
    applicablePlanIds: [] as string[],
  };

  const subscriptionRow = { id: 'sub-1', userId: 'user-1', status: 'ACTIVE', ...columns };
  const termRow = term === null ? null : { id: 'term-1', planId: 'plan-a', ...term };

  const eligibilityPrisma = {
    subscription: { findUnique: async () => subscriptionRow },
    subscriptionTerm: { findFirst: async () => termRow },
    subscriptionEffectiveProjection: { findUnique: async () => null },
    user: { findFirst: async () => ({ id: 'user-1' }) },
    addOn: {
      findMany: async () => [
        { ...catalogRow, prices: [{ currency: 'USD', price: amount }] },
      ],
    },
  };
  const offer = await new AddOnEligibilityService(eligibilityPrisma as never, {} as never).listForSubscription(
    'sub-1',
  );

  const created: Array<{ data: Record<string, unknown> }> = [];
  const counters = { providerCalls: 0, inlineGrants: 0 };
  const checkoutPrisma = {
    user: { findFirst: async () => ({ id: 'user-1' }) },
    paymentGateway: {
      findUnique: async () => ({
        type: 'YOOKASSA',
        isActive: true,
        currency: 'USD',
        settings: { shopId: 's', apiKey: 'k' },
      }),
    },
    subscription: { findUnique: async () => subscriptionRow },
    subscriptionTerm: { findFirst: async () => termRow },
    subscriptionEffectiveProjection: { findUnique: async () => null },
    addOn: {
      findUnique: async () => ({
        ...catalogRow,
        prices: [{ currency: 'USD', price: { toString: () => amount } }],
      }),
    },
    transaction: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args);
        return { id: 'tx-1', paymentId: 'pay-1', createdAt: new Date(), ...args.data };
      },
      update: async (args: { data: Record<string, unknown> }) => ({
        id: 'tx-1',
        paymentId: 'pay-1',
        status: 'PENDING',
        gatewayType: 'YOOKASSA',
        purchaseType: 'ADDITIONAL',
        amount: { toString: () => amount },
        currency: 'USD',
        createdAt: new Date(),
        ...args.data,
      }),
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => completedRow(amount),
      findUniqueOrThrow: async () => completedRow(amount),
    },
  };
  const pricing = { buildSnapshot: () => ({ price: amount }) };
  const provider = {
    createCheckout: async () => {
      counters.providerCalls += 1;
      return {
        gatewayId: 'g1',
        gatewayData: {},
        checkoutUrl: 'https://pay/1',
        providerMode: 'REDIRECT',
      };
    },
  };
  const mutation = {
    applyCompletedTransaction: async () => {
      counters.inlineGrants += 1;
      return { syncJobs: [] };
    },
  };
  const service = new AddOnPurchaseService(
    checkoutPrisma as never,
    pricing as never,
    provider as never,
    mutation as never,
    { enqueue: async () => undefined } as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' }) } as never,
    { evaluate: () => null } as never,
  );

  let bought = false;
  let refusalCode: string | null = null;
  let refusalMessage: string | null = null;
  try {
    await service.checkout({
      userId: 'user-1',
      addOnId: 'addon-1',
      subscriptionId: 'sub-1',
      gatewayType: 'YOOKASSA' as never,
      contractVersion: 2,
    });
    bought = true;
  } catch (error: unknown) {
    if (!(error instanceof BadRequestException)) throw error;
    refusalCode = refusalCodeOf(error);
    refusalMessage = error.message;
  }

  const draft = created[0];
  return {
    offered: offer.addOns.some((addOn) => addOn.id === 'addon-1'),
    bought,
    refusalCode,
    refusalMessage,
    draftsCreated: created.length,
    providerCalls: counters.providerCalls,
    inlineGrants: counters.inlineGrants,
    marker: draft === undefined ? null : (draft.data.planSnapshot as Record<string, unknown>),
  };
}

function completedRow(amount: string): Record<string, unknown> {
  return {
    id: 'tx-1',
    paymentId: 'pay-1',
    status: 'COMPLETED',
    gatewayType: 'YOOKASSA',
    purchaseType: 'ADDITIONAL',
    amount: { toString: () => amount },
    currency: 'USD',
    checkoutUrl: null,
    createdAt: new Date(),
    fulfilledAt: new Date(),
  };
}

const LIFETIME_REFUSAL = 'ADDON_LIFETIME_UNAVAILABLE';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A term window that has ALREADY CLOSED. Not a corruption: the boundary sweep is
 * event-driven, so an expired subscription keeps its ACTIVE term until something
 * sweeps it, and the offer is listed for it the whole time.
 */
const CLOSED_WINDOW_ENDED_AT = new Date(Date.now() - 30 * DAY_MS);

describe('add-on checkout can only sell a lifetime the intake can honour', () => {
  it('refuses a reset-scoped add-on while every rollout flag is off, exactly as the offer withholds it', async () => {
    await withEnv(FLAGS_OFF, async () => {
      const answer = await askBoth({ lifetime: 'UNTIL_NEXT_RESET' });

      assert.equal(answer.offered, false, 'the offer must withhold a lifetime the intake cannot honour');
      assert.equal(
        answer.bought,
        false,
        'a crafted checkout sold a reset-scoped add-on the intake cannot bind to an epoch. ' +
          'It falls through to the PERMANENT legacy increment, so the customer is charged for a ' +
          'top-up until the next reset and receives one that never expires.',
      );
      assert.equal(answer.refusalCode, LIFETIME_REFUSAL);
      assert.equal(answer.draftsCreated, 0, 'nothing may be drafted for a product we cannot deliver');
      assert.equal(answer.providerCalls, 0, 'and no invoice may be created at the provider');
    });
  });

  it('refuses a reset-scoped add-on when the reset flag is on but directPurchase is off', async () => {
    // The intake half of the gate, on its own. `directPurchase` guards
    // `applyAddOnViaLedger`, which is the ONLY code that binds an entitlement to
    // a reset epoch; with it off the reset flag alone changes nothing about what
    // the money path can deliver.
    await withEnv(
      { ADDON_RESET_EXPIRY_MONTH: 'true', ADDON_ENTITLEMENT_DIRECT_PURCHASE: undefined },
      async () => {
        const answer = await askBoth({ lifetime: 'UNTIL_NEXT_RESET' });

        assert.equal(answer.offered, false);
        assert.equal(answer.bought, false, answer.refusalMessage ?? 'checkout sold it anyway');
        assert.equal(answer.refusalCode, LIFETIME_REFUSAL);
        assert.equal(answer.draftsCreated, 0);
      },
    );
  });

  it('sells a reset-scoped add-on once BOTH the reset flag and directPurchase are on', async () => {
    // The other direction, and it is not optional: a gate that refused every
    // reset-scoped add-on would satisfy every case above and take the product
    // off sale the moment the rollout reaches stage 4.
    await withEnv(
      { ADDON_RESET_EXPIRY_MONTH: 'true', ADDON_ENTITLEMENT_DIRECT_PURCHASE: 'true' },
      async () => {
        const answer = await askBoth({ lifetime: 'UNTIL_NEXT_RESET' });

        assert.equal(answer.offered, true, 'both flags on → the offer must list it');
        assert.equal(
          answer.bought,
          true,
          `checkout refused an add-on the offer advertised (${answer.refusalMessage ?? 'no refusal recorded'})`,
        );
        assert.equal(answer.draftsCreated, 1);
        assert.equal(
          answer.marker?.lifetime,
          'UNTIL_NEXT_RESET',
          'the draft must carry the lifetime the customer is buying',
        );
      },
    );
  });

  it('refuses a reset-scoped add-on on a NO_RESET term even with both flags on', async () => {
    await withEnv(
      { ADDON_RESET_EXPIRY_MONTH: 'true', ADDON_ENTITLEMENT_DIRECT_PURCHASE: 'true' },
      async () => {
        const answer = await askBoth({
          lifetime: 'UNTIL_NEXT_RESET',
          term: { trafficResetStrategy: 'NO_RESET' },
        });

        assert.equal(answer.offered, false, 'a strategy with no boundary has no reset to expire on');
        assert.equal(answer.bought, false);
        assert.equal(answer.refusalCode, LIFETIME_REFUSAL);
      },
    );
  });

  it('refuses a reset-scoped add-on when the ACTIVE term carries no reset anchor', async () => {
    // A boundary strategy with no anchor yields no epoch. MONTH_ROLLING keeps a
    // null anchor until profile sync stamps the panel timestamp, so this is the
    // ordinary state of a freshly-created term, not a corruption.
    await withEnv(
      { ADDON_RESET_EXPIRY_MONTH: 'true', ADDON_ENTITLEMENT_DIRECT_PURCHASE: 'true' },
      async () => {
        const answer = await askBoth({
          lifetime: 'UNTIL_NEXT_RESET',
          term: { resetAnchorAt: null },
        });

        assert.equal(answer.offered, false);
        assert.equal(answer.bought, false);
        assert.equal(answer.refusalCode, LIFETIME_REFUSAL);
      },
    );
  });

  it('still sells an ordinary UNTIL_SUBSCRIPTION_END add-on with every rollout flag off', async () => {
    // The gate must not become a blanket refusal. This is the case the whole
    // add-on product currently consists of: the legacy increment is authoritative
    // until the rollout opens, and a term-scoped add-on has a real end date to
    // expire at without any flag.
    await withEnv(FLAGS_OFF, async () => {
      const answer = await askBoth({ lifetime: 'UNTIL_SUBSCRIPTION_END' });

      assert.equal(answer.offered, true);
      assert.equal(
        answer.bought,
        true,
        `checkout refused an ordinary add-on (${answer.refusalMessage ?? 'no refusal recorded'}). ` +
          'The lifetime guard is meant to withhold what cannot be delivered, not to close the product.',
      );
      assert.equal(answer.draftsCreated, 1);
      assert.equal(answer.providerCalls, 1);
      assert.equal(answer.marker?.lifetime, 'UNTIL_SUBSCRIPTION_END');
    });
  });

  it('refuses UNTIL_SUBSCRIPTION_END on a term whose window has already closed', async () => {
    // A term with a real `endsAt` that is already in the PAST. `resolveAddOnLifetimeGrant`
    // used to test only `endsAt === null`, so this was offered and — once checkout
    // started asking the same question — sold. `applyAddOnViaLedger` then requires
    // `endsAt > now` before it will bind the entitlement to that window, does not
    // get it, and falls through to the PERMANENT legacy increment: the customer
    // buys something bounded, pays the bounded price, and receives an unbounded
    // raw-column increment with no entitlement row anything could ever expire.
    await withEnv(FLAGS_OFF, async () => {
      const answer = await askBoth({
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        term: { endsAt: CLOSED_WINDOW_ENDED_AT },
      });

      assert.equal(answer.offered, false, 'a closed window is not a period anything can be delivered for');
      assert.equal(answer.bought, false, answer.refusalMessage ?? 'checkout sold an expired term');
      assert.equal(answer.refusalCode, LIFETIME_REFUSAL);
      assert.equal(answer.draftsCreated, 0);
      assert.equal(answer.providerCalls, 0);
    });
  });

  it('refuses UNTIL_SUBSCRIPTION_END on a pre-cutover row that has already expired', async () => {
    // The same closed window reached through the fallback, whose `endsAt` is
    // derived from `subscription.expiresAt`. Both sides have to answer through
    // the same reader on that path too, or the gate exists only for rows that
    // already have a durable term.
    await withEnv(FLAGS_OFF, async () => {
      const answer = await askBoth({
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        term: null,
        sub: { expiresAt: CLOSED_WINDOW_ENDED_AT },
      });

      assert.equal(answer.offered, false);
      assert.equal(answer.bought, false, answer.refusalMessage ?? 'checkout sold an expired fallback row');
      assert.equal(answer.refusalCode, LIFETIME_REFUSAL);
      assert.equal(answer.draftsCreated, 0);
    });
  });

  it('still sells a reset-scoped add-on on that same closed window', async () => {
    // The control, and it is the reason the test sits on ONE arm of
    // `resolveAddOnLifetimeGrant` rather than at its top. `UNTIL_NEXT_RESET`
    // expires on the plan's reset boundary, which keeps rolling forward
    // regardless of the term's own end — applying the `endsAt > now` test to it
    // too would take a perfectly deliverable product off sale.
    await withEnv(
      { ADDON_RESET_EXPIRY_MONTH: 'true', ADDON_ENTITLEMENT_DIRECT_PURCHASE: 'true' },
      async () => {
        const answer = await askBoth({
          lifetime: 'UNTIL_NEXT_RESET',
          term: { endsAt: CLOSED_WINDOW_ENDED_AT },
        });

        assert.equal(answer.offered, true, 'a reset boundary does not depend on the term window');
        assert.equal(
          answer.bought,
          true,
          `checkout refused a reset-scoped add-on (${answer.refusalMessage ?? 'no refusal recorded'})`,
        );
        assert.equal(answer.draftsCreated, 1);
        assert.equal(answer.marker?.lifetime, 'UNTIL_NEXT_RESET');
      },
    );
  });

  it('refuses UNTIL_SUBSCRIPTION_END on an open-ended term, exactly as the offer withholds it', async () => {
    await withEnv(FLAGS_OFF, async () => {
      const answer = await askBoth({
        lifetime: 'UNTIL_SUBSCRIPTION_END',
        term: { endsAt: null },
      });

      assert.equal(answer.offered, false, 'an open-ended term has no "subscription end" to expire at');
      assert.equal(answer.bought, false);
      assert.equal(answer.refusalCode, LIFETIME_REFUSAL);
      assert.equal(answer.draftsCreated, 0);
    });
  });

  it('refuses a reset-scoped add-on on the pre-cutover fallback, which has no panel anchor', async () => {
    // No ACTIVE term. The fallback derives its baseline from the subscription's
    // own columns and deliberately supplies NO reset anchor —
    // `subscription.createdAt` is local provenance, not a panel reset boundary.
    // Both sides must reach the same answer through that same fallback.
    await withEnv(
      { ADDON_RESET_EXPIRY_MONTH: 'true', ADDON_ENTITLEMENT_DIRECT_PURCHASE: 'true' },
      async () => {
        const answer = await askBoth({ lifetime: 'UNTIL_NEXT_RESET', term: null });

        assert.equal(answer.offered, false);
        assert.equal(
          answer.bought,
          false,
          'the pre-cutover path has no durable term at all, so `applyAddOnViaLedger` returns ' +
            'immediately and the legacy increment delivers the top-up forever',
        );
        assert.equal(answer.refusalCode, LIFETIME_REFUSAL);
      },
    );
  });

  it('still sells an UNTIL_SUBSCRIPTION_END add-on on the pre-cutover fallback', async () => {
    // The fallback's other direction: it derives a real `endsAt` from the
    // subscription's own expiry, so a term-scoped add-on stays sellable there.
    await withEnv(FLAGS_OFF, async () => {
      const answer = await askBoth({ lifetime: 'UNTIL_SUBSCRIPTION_END', term: null });

      assert.equal(answer.offered, true);
      assert.equal(answer.bought, true, answer.refusalMessage ?? 'checkout refused the fallback path');
    });
  });

  it('refuses a ZERO-PRICE add-on with an unhonourable lifetime before it is granted inline', async () => {
    // A 0-price add-on skips the provider and is fulfilled inline, so a gate
    // placed after the draft would grant it before anyone could refuse.
    await withEnv(FLAGS_OFF, async () => {
      const answer = await askBoth({ lifetime: 'UNTIL_NEXT_RESET', amount: '0' });

      assert.equal(answer.offered, false);
      assert.equal(answer.bought, false);
      assert.equal(answer.refusalCode, LIFETIME_REFUSAL);
      assert.equal(answer.draftsCreated, 0);
      assert.equal(
        answer.inlineGrants,
        0,
        'the free branch applies the add-on immediately — the guard has to run before the draft',
      );
    });
  });
});
