import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AddOnEntitlementState, AddOnLifetime, AddOnType, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { DuplicateSubscriptionMergeService } from '../src/modules/profile-sync/duplicate-subscription-merge.service';

/**
 * «СЛИЯНИЕ ПОДПИСОК-ДУБЛИКАТОВ» AFTER THE BACKGROUND CUTOVER — against
 * PostgreSQL, because what decides it is the foreign-key graph: a term is
 * `Restrict` on its subscription, a projection on its term, an add-on on both.
 *
 * The duplicate a Remnawave import mints gets its first term and projection
 * from the background cutover within minutes. Refusing every duplicate that has
 * a term would therefore refuse every merge from then on. So a duplicate whose
 * only durable rows are the cutover's own merges — those two rows are deleted
 * with it — and one that holds anything paid is still refused, by name.
 *
 * Runs only with TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `d1merge-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';

let prisma: PrismaService;
const users: string[] = [];
let panelSeq = 900_100;

const SILENT_EVENTS = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * One pair, as the 2.x → 3.x identity split leaves it: the OLDER row holds a
 * dead uuid, the NEWER one the live numeric identity, both for one customer on
 * one panel profile.
 */
async function pair(tag: string): Promise<{ userId: string; survivorId: string; duplicateId: string; panelId: number }> {
  const userId = `${prefix}-${tag}-user`;
  await prisma.user.create({ data: { id: userId, referralCode: userId, name: userId } });
  users.push(userId);
  panelSeq += 1;
  const panelId = panelSeq;
  const survivorId = `${prefix}-${tag}-old`;
  const duplicateId = `${prefix}-${tag}-new`;
  await prisma.subscription.create({
    data: {
      id: survivorId,
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: { id: 'plan-year', name: 'Годовой', trafficLimitStrategy: 'NO_RESET' },
      trafficLimit: 100,
      deviceLimit: 3,
      createdAt: new Date(Date.now() - 400 * DAY_MS),
      expiresAt: new Date(Date.now() + 20 * DAY_MS),
      remnawaveId: DEAD_UUID,
      remnawavePanelUsername: `${prefix}-${tag}`,
      configUrl: `https://sub.example.test/OLD${tag}`,
    },
  });
  await prisma.subscription.create({
    data: {
      id: duplicateId,
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: { importedFrom: 'remnawave', trafficLimitStrategy: 'NO_RESET' },
      trafficLimit: 100,
      deviceLimit: 3,
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      expiresAt: new Date(Date.now() + 20 * DAY_MS),
      remnawaveId: String(panelId),
      remnawavePanelId: panelId,
      remnawavePanelUsername: `${prefix}-${tag}`,
      configUrl: `https://sub.example.test/NEW${tag}`,
    },
  });
  return { userId, survivorId, duplicateId, panelId };
}

/** The panel: both halves resolve to the one profile, which names this customer. */
function panelFor(panelId: number, userId: string) {
  return {
    resolveUser: async () => ({ kind: 'ok', data: { response: { id: panelId, shortUuid: null, username: null } } }),
    getUserById: async () => ({
      kind: 'ok',
      data: { response: { description: `reiwa_id: ${userId}`, username: 'profile' } },
    }),
  };
}

run('duplicate merge after the cutover — PostgreSQL', () => {
  const terms = new SubscriptionTermService();
  const projections = new EffectiveProjectionService();
  let cutover: EntitlementCutoverService;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    cutover = new EntitlementCutoverService(prisma, terms, projections);
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, users);
    await prisma.$disconnect();
  });

  const merge = (panel: unknown, survivorId: string, duplicateId: string) =>
    new DuplicateSubscriptionMergeService(prisma, panel as never, {} as never, SILENT_EVENTS as never).merge({
      dryRun: false,
      pairs: [{ survivorSubscriptionId: survivorId, duplicateSubscriptionId: duplicateId }],
    });

  it('merges a duplicate whose only durable rows are the cutover term and projection, and deletes them', async () => {
    const { userId, survivorId, duplicateId, panelId } = await pair('cutover');
    // Both halves went through the background cutover.
    for (const id of [survivorId, duplicateId]) {
      const ensured = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, id));
      assert.equal(ensured.outcome, 'CREATED');
    }
    const survivorTerm = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: survivorId } });

    const report = await merge(panelFor(panelId, userId), survivorId, duplicateId);

    const row = report.rows[0]!;
    assert.equal(row.outcome, 'merged', row.reason ?? '');
    assert.deepEqual(
      row.discardedCutoverRows.map((discard) => `${discard.model}=${discard.discarded}`),
      ['SubscriptionEffectiveProjection=1', 'SubscriptionTerm=1'],
    );
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: duplicateId } }), 0);
    assert.equal(await prisma.subscriptionEffectiveProjection.count({ where: { subscriptionId: duplicateId } }), 0);
    const retired = await prisma.subscription.findUniqueOrThrow({ where: { id: duplicateId } });
    assert.equal(retired.status, SubscriptionStatus.DELETED);
    assert.equal(retired.remnawaveId, null);
    // The survivor keeps its own term and takes the identity.
    const kept = await prisma.subscriptionTerm.findFirstOrThrow({ where: { subscriptionId: survivorId } });
    assert.equal(kept.id, survivorTerm.id);
    assert.equal(kept.status, 'ACTIVE');
    const survivor = await prisma.subscription.findUniqueOrThrow({ where: { id: survivorId } });
    assert.equal(survivor.remnawaveId, String(panelId));
  });

  it('refuses a duplicate that holds a paid add-on, names it, and deletes nothing', async () => {
    const { userId, survivorId, duplicateId, panelId } = await pair('paid');
    const ensured = await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, duplicateId));
    const payment = await prisma.transaction.create({
      data: {
        paymentId: `${prefix}-paid-pay`,
        userId,
        subscriptionId: duplicateId,
        status: 'COMPLETED',
        purchaseType: 'ADDITIONAL',
        channel: 'WEB',
        gatewayType: 'YOOKASSA',
        currency: 'USD',
        amount: new Prisma.Decimal('1.00'),
        planSnapshot: {},
      },
    });
    const activatedAt = new Date(Date.now() - 20 * DAY_MS);
    // Long over — but a sale on the books is history a merge may not drop.
    await prisma.addOnEntitlement.create({
      data: {
        subscriptionId: duplicateId,
        termId: ensured.activeTermId!,
        sourceTransactionId: payment.id,
        sourceLineKey: 'line',
        catalogRevision: 1,
        receiptName: '+1 device',
        type: AddOnType.EXTRA_DEVICES,
        valuePerUnit: 1,
        totalValue: 1n,
        lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
        unitAmount: new Prisma.Decimal('1.00'),
        totalAmount: new Prisma.Decimal('1.00'),
        currency: 'USD',
        purchasedAt: activatedAt,
        scheduledActivationAt: activatedAt,
        activatedAt,
        expiresAt: new Date(Date.now() - 10 * DAY_MS),
        state: AddOnEntitlementState.EXPIRED,
        terminalAt: new Date(Date.now() - 10 * DAY_MS),
      },
    });

    const report = await merge(panelFor(panelId, userId), survivorId, duplicateId);

    const row = report.rows[0]!;
    assert.equal(row.outcome, 'refused');
    assert.equal(row.refusal, 'entitlementHistoryOnDuplicate');
    assert.match(row.reason ?? '', /AddOnEntitlement: 1 \(add-on purchases\)/);
    assert.match(row.reason ?? '', /resolved by hand/);
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: duplicateId } }), 1);
    const untouched = await prisma.subscription.findUniqueOrThrow({ where: { id: duplicateId } });
    assert.equal(untouched.status, SubscriptionStatus.ACTIVE);
    assert.equal(untouched.remnawaveId, String(panelId));
  });
});
