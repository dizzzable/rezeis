import assert from 'node:assert/strict';

import { AddOnLifetime, AddOnType, Prisma, SubscriptionStatus, SubscriptionTermStatus } from '@prisma/client';

import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { EffectiveProjectionService } from '../../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../../src/modules/add-on-entitlements/services/subscription-term.service';

/**
 * Fixtures for the PostgreSQL specs about subscriptions IN the durable term
 * model. Every instant is anchored to now, so a fixture never changes the side
 * of "now" it is on as time passes. Rows are tracked in `users` / `plans` for
 * the spec's own cleanup (`removeDurableFixtures` plus the plans).
 */
export interface TermModelFixtures {
  readonly prisma: PrismaService;
  readonly prefix: string;
  readonly users: string[];
  readonly plans: string[];
  next(): number;
}

export const DAY_MS = 86_400_000;
export const GIB = 1024n * 1024n * 1024n;

export interface Limits {
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
}

export function termModelFixtures(prisma: PrismaService, prefix: string): TermModelFixtures {
  let seq = 0;
  return { prisma, prefix, users: [], plans: [], next: () => ++seq };
}

export const at = (days: number): Date => new Date(Date.now() + days * DAY_MS);

export async function createPlan(fx: TermModelFixtures, limits: Limits): Promise<string> {
  const id = `${fx.prefix}-plan-${fx.next()}`;
  await fx.prisma.plan.create({
    data: {
      id,
      name: id,
      orderIndex: 600_000 + fx.next(),
      trafficLimit: limits.trafficLimit,
      deviceLimit: limits.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      trafficLimitStrategy: 'NO_RESET',
      durations: { create: [{ days: 30, prices: { create: [{ currency: 'RUB', price: '299' }] } }] },
    },
  });
  fx.plans.push(id);
  return id;
}

export async function newUser(
  fx: TermModelFixtures,
  extra: { readonly telegramId?: bigint; readonly points?: number } = {},
): Promise<string> {
  const id = `${fx.prefix}-user-${fx.next()}`;
  await fx.prisma.user.create({
    data: {
      id,
      referralCode: `${id}-ref`,
      name: id,
      ...(extra.telegramId === undefined ? {} : { telegramId: extra.telegramId }),
      ...(extra.points === undefined ? {} : { points: extra.points }),
    },
  });
  fx.users.push(id);
  return id;
}

/**
 * A subscription on `planId` whose snapshot records the plan's own limits and
 * whose COLUMNS are `columns` — brought into the term model the way the
 * background cutover does it: its first term minted from those columns.
 */
export async function subscriptionInModel(
  fx: TermModelFixtures,
  input: {
    readonly planId: string;
    readonly plan: Limits;
    readonly columns?: Limits;
    readonly userId?: string;
    readonly snapshot?: Record<string, unknown>;
    /** No panel profile linked (`remnawaveId` null). */
    readonly unlinked?: boolean;
  },
): Promise<{ userId: string; subscriptionId: string; panelId: number }> {
  const userId = input.userId ?? (await newUser(fx));
  const panelId = 810_000 + fx.next();
  const columns = input.columns ?? input.plan;
  const subscription = await fx.prisma.subscription.create({
    data: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: (input.snapshot ?? {
        id: input.planId,
        name: input.planId,
        trafficLimit: input.plan.trafficLimit,
        deviceLimit: input.plan.deviceLimit,
        trafficLimitStrategy: 'NO_RESET',
        internalSquads: [],
        externalSquad: null,
        selectedDurationDays: 30,
      }) as Prisma.InputJsonValue,
      trafficLimit: columns.trafficLimit,
      deviceLimit: columns.deviceLimit,
      internalSquads: [],
      externalSquad: null,
      remnawaveId: input.unlinked === true ? null : String(panelId),
      remnawavePanelId: input.unlinked === true ? null : panelId,
      createdAt: at(-10),
      startedAt: at(-10),
      expiresAt: at(20),
    },
    select: { id: true },
  });
  const terms = new SubscriptionTermService();
  const projections = new EffectiveProjectionService();
  const cutover = new EntitlementCutoverService(fx.prisma, terms, projections);
  const entered = await fx.prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, subscription.id));
  assert.equal(entered.outcome, 'CREATED');
  return { userId, subscriptionId: subscription.id, panelId };
}

/**
 * Live «until the end of the subscription» add-ons, as the ledger leaves them:
 * ACTIVE entitlements on the ACTIVE term ending with it, the projection
 * recomputed over them, and the columns mirroring `desired`.
 */
export async function buyAddOns(
  fx: TermModelFixtures,
  owner: { readonly userId: string; readonly subscriptionId: string },
  bought: { readonly devices?: number; readonly trafficGb?: number },
): Promise<string[]> {
  const projections = new EffectiveProjectionService();
  return fx.prisma.$transaction(async (tx) => {
    const term = await tx.subscriptionTerm.findFirstOrThrow({
      where: { subscriptionId: owner.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
    });
    const ids: string[] = [];
    const lines: Array<{ type: AddOnType; value: number; total: bigint }> = [];
    if (bought.devices !== undefined) {
      lines.push({ type: AddOnType.EXTRA_DEVICES, value: bought.devices, total: BigInt(bought.devices) });
    }
    if (bought.trafficGb !== undefined) {
      lines.push({ type: AddOnType.EXTRA_TRAFFIC, value: bought.trafficGb, total: BigInt(bought.trafficGb) * GIB });
    }
    for (const line of lines) {
      const payment = await tx.transaction.create({
        data: {
          paymentId: `${fx.prefix}-pay-${fx.next()}`,
          userId: owner.userId,
          subscriptionId: owner.subscriptionId,
          status: 'COMPLETED',
          purchaseType: 'ADDITIONAL',
          channel: 'WEB',
          gatewayType: 'YOOKASSA',
          currency: 'RUB',
          amount: new Prisma.Decimal('99'),
          planSnapshot: {},
        },
      });
      const entitlement = await tx.addOnEntitlement.create({
        data: {
          subscriptionId: owner.subscriptionId,
          termId: term.id,
          sourceTransactionId: payment.id,
          sourceLineKey: 'line',
          catalogRevision: 1,
          receiptName: `${line.type} +${line.value}`,
          type: line.type,
          valuePerUnit: line.value,
          totalValue: line.total,
          lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
          unitAmount: new Prisma.Decimal('99'),
          totalAmount: new Prisma.Decimal('99'),
          currency: 'RUB',
          purchasedAt: at(-1),
          scheduledActivationAt: at(-1),
          activatedAt: at(-1),
          expiresAt: term.endsAt,
          state: 'ACTIVE',
        },
      });
      ids.push(entitlement.id);
    }
    const projection = await projections.recomputeInTransaction(tx, {
      subscriptionId: owner.subscriptionId,
      mode: 'ACTIVE',
    });
    await tx.subscription.update({
      where: { id: owner.subscriptionId },
      data: {
        trafficLimit:
          projection.desiredTrafficLimitBytes === null ? null : Number(projection.desiredTrafficLimitBytes / GIB),
        deviceLimit: projection.desiredDeviceLimit ?? 0,
      },
    });
    return ids;
  });
}

export function activeTerm(prisma: PrismaService, subscriptionId: string) {
  return prisma.subscriptionTerm.findFirstOrThrow({
    where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
  });
}

/**
 * The tail term and every given add-on end exactly where the subscription now
 * does — the one assertion every expiry writer owes the term model.
 */
export async function assertFollowsExpiry(
  prisma: PrismaService,
  subscriptionId: string,
  addOnIds: readonly string[],
  expectedBefore: Date,
): Promise<Date> {
  const row = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    select: { expiresAt: true },
  });
  const expiresAt = row.expiresAt!;
  assert.ok(expiresAt.getTime() > expectedBefore.getTime(), 'the writer moved the expiry');
  assert.equal((await activeTerm(prisma, subscriptionId)).endsAt?.getTime(), expiresAt.getTime(), 'the tail term follows it');
  for (const id of addOnIds) {
    const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id } });
    assert.equal(addOn.expiresAt?.getTime(), expiresAt.getTime(), 'the add-on sold "until the end" follows it');
  }
  return expiresAt;
}

/** Runs `body` with `ADDON_ENTITLEMENT_SHADOW` set to `value` (unset for `undefined`). */
export async function withStage1<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const name = 'ADDON_ENTITLEMENT_SHADOW';
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}
