import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { AdminDuplicateSubscriptionMergeController } from '../src/modules/profile-sync/duplicate-subscription-merge.controller';
import { DuplicateSubscriptionMergeService } from '../src/modules/profile-sync/duplicate-subscription-merge.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * «СЛИЯНИЕ ПОДПИСОК-ДУБЛИКАТОВ» RECORDS WHAT IT DELETED, on PostgreSQL,
 * through the real controller and merge service.
 *
 * A duplicate whose only durable rows are the cutover's own term and
 * projection merges, and the merge DELETES those two rows. Nothing reattaches
 * them and nothing can undo them, so the audit row — the operator's only record
 * of a merge — has to say they existed. It used to copy the report's other
 * fields and drop this one.
 *
 * Skipped without TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `d2mergeaudit-${process.pid}-${Date.now()}`;
const DAY_MS = 86_400_000;
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
const SILENT_EVENTS = { info: () => undefined, warn: () => undefined, error: () => undefined };
const REQUEST = { headers: {}, ip: '10.0.0.9', socket: { remoteAddress: null } } as never;

let prisma: PrismaService;
let adminId = '';
const users: string[] = [];

run('the duplicate merge audit — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const admin = await prisma.adminUser.create({
      data: { login: `${prefix}-admin`, loginNormalized: `${prefix}-admin`, passwordHash: 'not-a-hash' },
      select: { id: true },
    });
    adminId = admin.id;
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: adminId } }).catch(() => undefined);
    await removeDurableFixtures(prisma, users).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('the audit row names the cutover term and projection the merge deleted', async () => {
    // One pair, as the 2.x → 3.x identity split leaves it: the OLDER row holds
    // a dead uuid, the NEWER one the live numeric identity.
    const userId = `${prefix}-user`;
    await prisma.user.create({ data: { id: userId, referralCode: userId, name: userId } });
    users.push(userId);
    const panelId = 930_000 + (process.pid % 1000);
    const survivorId = `${prefix}-old`;
    const duplicateId = `${prefix}-new`;
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
        remnawavePanelUsername: `${prefix}-profile`,
        configUrl: `https://sub.example.test/OLD${prefix}`,
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
        remnawavePanelUsername: `${prefix}-profile`,
        configUrl: `https://sub.example.test/NEW${prefix}`,
      },
    });
    const terms = new SubscriptionTermService();
    const projections = new EffectiveProjectionService();
    const cutover = new EntitlementCutoverService(prisma, terms, projections);
    for (const id of [survivorId, duplicateId]) {
      await prisma.$transaction((tx) => cutover.ensureTermInTransaction(tx, id));
    }
    // The panel: both halves resolve to the one profile, which names this customer.
    const panel = {
      resolveUser: async () => ({ kind: 'ok', data: { response: { id: panelId, shortUuid: null, username: null } } }),
      getUserById: async () => ({
        kind: 'ok',
        data: { response: { description: `reiwa_id: ${userId}`, username: 'profile' } },
      }),
    };
    const controller = new AdminDuplicateSubscriptionMergeController(
      new DuplicateSubscriptionMergeService(prisma, panel as never, {} as never, SILENT_EVENTS as never),
      prisma,
    );

    const report = await controller.mergeDuplicateSubscriptions(
      { dryRun: false, pairs: [{ survivorSubscriptionId: survivorId, duplicateSubscriptionId: duplicateId }] },
      { id: adminId } as never,
      REQUEST,
    );

    assert.equal(report.rows[0]?.outcome, 'merged', report.rows[0]?.reason ?? '');
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { adminUserId: adminId, action: 'subscriptions.duplicate_pair_merged' },
    });
    const pairs = (audit.metadata as { pairs: Array<Record<string, unknown>> }).pairs;
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0]!['discardedCutoverRows'], [
      { relation: 'effectiveProjection', model: 'SubscriptionEffectiveProjection', column: 'subscription_id', discarded: 1 },
      { relation: 'terms', model: 'SubscriptionTerm', column: 'subscription_id', discarded: 1 },
    ]);
    // …and what it reports is what happened.
    assert.equal(await prisma.subscriptionTerm.count({ where: { subscriptionId: duplicateId } }), 0);
  });
});
