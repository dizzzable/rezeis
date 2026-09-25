import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PanelLinkCheckService } from '../src/modules/profile-sync/panel-link-check.service';
import { PanelLinkReconciliationService } from '../src/modules/profile-sync/panel-link-reconciliation.service';
import { PanelProfileComparisonService } from '../src/modules/profile-sync/panel-profile-comparison.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';
import { newUser, termModelFixtures, type TermModelFixtures } from './helpers/term-model-fixtures';

/**
 * THE AUTOMATIC PANEL-LINK CHECK ON POSTGRESQL (owner's decision, 24.09.2026).
 *
 * The unit specs answer the walk's page statement from a JavaScript mirror; the
 * statement itself — a regular expression Prisma cannot spell — is proven
 * here, on real rows: the population the check tries to prove is exactly the
 * live rows with a non-decimal link (the rows every destructive path refuses)
 * plus the empty ones that still record how to look them up. Then the walk and
 * the per-customer comparison WRITE through the real advisory lock, the real
 * collision probe and the real compare-and-swap.
 *
 * This file shares its database with every other PostgreSQL spec, so it never
 * asserts a whole-table number: it reads its own rows back, and counts the
 * population as a difference taken around its own inserts. Remnawave is a
 * double that answers for this file's profiles and for nobody else's, so the
 * walk it drives cannot write to another spec's rows.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

/** Panel ids no other spec uses. */
const PANEL_BASE = 1_700_000_000 + (Date.now() % 1_000_000) * 20;

let prisma: PrismaService;
let fx: TermModelFixtures;

/** A Redis double with the semantics the check relies on. */
class MemoryCache {
  public readonly store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.has(key) ? structuredClone(this.store.get(key)) : null) as T | null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, structuredClone(value));
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
  async take<T>(key: string): Promise<T | null> {
    const value = await this.get<T>(key);
    this.store.delete(key);
    return value;
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async claimOnce(key: string): Promise<boolean> {
    if (this.store.has(key)) return false;
    this.store.set(key, '1');
    return true;
  }
}

/** Remnawave, answering only for the profiles registered with it. */
class PanelDouble {
  private readonly byShortUuid = new Map<string, number>();
  private readonly byId = new Map<
    number,
    {
      username: string;
      description: string;
      subscriptionUrl: string;
      createdAt: string;
      lastTrafficResetAt: string | null;
    }
  >();

  add(
    panelId: number,
    input: {
      shortUuid: string;
      owner: string;
      subscriptionId?: string;
      /** The profile's own two facts, as Remnawave answers them. */
      createdAt?: string;
      lastTrafficResetAt?: string | null;
    },
  ): void {
    this.byShortUuid.set(input.shortUuid, panelId);
    this.byId.set(panelId, {
      username: `rz_pg_${panelId}`,
      description:
        `name: pg\nreiwa_id: ${input.owner}` +
        (input.subscriptionId === undefined ? '' : `\nsubscription_id: ${input.subscriptionId}`),
      subscriptionUrl: `https://sub.example.test/${input.shortUuid}`,
      createdAt: input.createdAt ?? '2026-09-01T00:00:00.000Z',
      lastTrafficResetAt: input.lastTrafficResetAt ?? null,
    });
  }

  private readonly missing = {
    kind: 'rejected' as const,
    status: 404,
    code: 'A063',
    detail: 'User with specified params not found',
    retryAfterMs: null,
  };

  readonly client = {
    resolveUser: async (selector: { shortUuid?: string; username?: string }) => {
      const panelId = selector.shortUuid === undefined ? undefined : this.byShortUuid.get(selector.shortUuid);
      if (panelId === undefined) return this.missing;
      const profile = this.byId.get(panelId);
      return { kind: 'ok', data: { response: { id: panelId, username: profile?.username, shortUuid: selector.shortUuid } } };
    },
    getUserById: async (panelId: number) => {
      const profile = this.byId.get(panelId);
      if (profile === undefined) return this.missing;
      return { kind: 'ok', data: { response: { id: panelId, ...profile } } };
    },
  };

  /** The whole-list read, as `strictGetAllPanelUsers` answers it. */
  list() {
    return strictOk({
      users: [...this.byId.entries()].map(([panelId, profile]) => ({
        uuid: String(panelId),
        panelId,
        username: profile.username,
        status: 'ACTIVE',
        subscriptionUrl: profile.subscriptionUrl,
        telegramId: null,
        email: null,
        expireAt: '2099-12-31T00:00:00.000Z',
        createdAt: profile.createdAt,
        lastTrafficResetAt: profile.lastTrafficResetAt,
        trafficLimitBytes: 0,
        hwidDeviceLimit: 0,
        trafficLimitStrategy: null,
        tag: null,
        description: profile.description,
        activeInternalSquads: [],
        externalSquadUuid: null,
        userTraffic: { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null },
      })),
      total: this.byId.size,
      complete: true,
    });
  }
}

async function subscription(userId: string, id: string, data: Record<string, unknown> = {}): Promise<string> {
  await prisma.subscription.create({
    data: {
      id,
      userId,
      status: SubscriptionStatus.ACTIVE,
      planSnapshot: { name: 'pg-plan' },
      trafficLimit: 100,
      deviceLimit: 3,
      ...data,
    },
  });
  return id;
}

function checkService(panel: PanelDouble, cache: MemoryCache) {
  const walk = new PanelLinkReconciliationService(prisma, panel.client as never);
  const comparison = new PanelProfileComparisonService(prisma, { strictGetAllPanelUsers: async () => panel.list() } as never);
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  return { walk, comparison, check: new PanelLinkCheckService(prisma, walk, comparison, cache as never, silent as never) };
}

async function populationCount(check: PanelLinkCheckService): Promise<{ total: number; nonNumeric: number }> {
  return (check as unknown as { countPopulation(): Promise<{ total: number; nonNumeric: number }> }).countPopulation();
}

run('the automatic panel-link check on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '4';
    prisma = new PrismaService();
    await prisma.$connect();
    fx = termModelFixtures(prisma, `plc-${process.pid}-${Date.now()}`);
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, fx.users).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('selects exactly the live rows with a non-decimal link and the damaged empty ones', async () => {
    const userId = await newUser(fx);
    const id = (suffix: string) => `${fx.prefix}-pop-${suffix}`;
    const { walk, check } = checkService(new PanelDouble(), new MemoryCache());
    const before = await populationCount(check);

    await subscription(userId, id('a-damaged-empty'), {
      remnawavePanelUsername: 'rz_pg_a',
      configUrl: 'https://sub.example.test/NOSUCHa',
    });
    await subscription(userId, id('b-never-provisioned'), { configUrl: 'https://sub.example.test/x' });
    await subscription(userId, id('c-no-config-url'), { remnawavePanelUsername: 'rz_pg_c' });
    await subscription(userId, id('d-uuid'), { remnawaveId: '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f' });
    await subscription(userId, id('e-empty-string'), { remnawaveId: '' });
    await subscription(userId, id('f-junk'), { remnawaveId: 'abc' });
    await subscription(userId, id('g-signed'), { remnawaveId: '+12' });
    await subscription(userId, id('h-decimal'), { remnawaveId: '12345', remnawavePanelId: 12345 });
    await subscription(userId, id('i-deleted'), {
      status: SubscriptionStatus.DELETED,
      remnawaveId: '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f',
    });
    await subscription(userId, id('j-spaced'), { remnawaveId: ' 12' });

    const expected = [id('a-damaged-empty'), id('d-uuid'), id('e-empty-string'), id('f-junk'), id('g-signed'), id('j-spaced')];

    // The walk's pages, two rows at a time: every row once, in id order. It
    // starts just before this file's ids, so another spec's leftovers cannot
    // use up its row cap first.
    const report = await walk.reconcile({
      dryRun: true,
      pageSize: 2,
      limit: 1000,
      startAfterId: `${fx.prefix}-pop-`,
    });
    const reached = [...report.repaired, ...report.unrepaired]
      .filter((entry) => entry.scanned && entry.subscriptionId.startsWith(`${fx.prefix}-pop-`))
      .map((entry) => entry.subscriptionId);
    assert.deepEqual(reached, expected);

    // The operator's list reads the same population.
    const list = await check.listUnlinked();
    const mine = list.rows.filter((entry) => entry.subscriptionId.startsWith(`${fx.prefix}-pop-`));
    assert.deepEqual(mine.map((entry) => entry.subscriptionId).sort(), [...expected].sort());
    assert.equal(mine.find((entry) => entry.subscriptionId === id('a-damaged-empty'))?.linkKind, 'empty');
    assert.equal(mine.find((entry) => entry.subscriptionId === id('e-empty-string'))?.linkKind, 'nonNumeric');

    // And the count after an import, as a difference around these inserts.
    const afterInsert = await populationCount(check);
    assert.equal(afterInsert.total - before.total, 6);
    assert.equal(afterInsert.nonNumeric - before.nonNumeric, 5);
  });

  it('links a lost link for real, under the lock, and the row leaves the list at once', async () => {
    const userId = await newUser(fx);
    const panelId = PANEL_BASE + fx.next();
    const panel = new PanelDouble();
    panel.add(panelId, { shortUuid: `SHORT${panelId}`, owner: userId });
    const lost = await subscription(userId, `${fx.prefix}-walk-lost`, {
      remnawaveId: '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f',
      configUrl: `https://sub.example.test/SHORT${panelId}`,
    });
    const cache = new MemoryCache();
    // Where the last pass stopped: just before this file's ids, so the pass
    // reaches this row whatever other specs left in the shared database.
    cache.store.set('panel-link-check:state', { walkCursor: `${fx.prefix}-walk-` });
    const { check } = checkService(panel, cache);

    assert.equal(await check.run('boot'), 'ran');

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: lost } });
    assert.equal(row.remnawaveId, String(panelId));
    assert.equal(row.remnawavePanelId, panelId);
    assert.equal(row.id, lost, 'our own id never changes');
    const list = await check.listUnlinked();
    assert.equal(list.rows.some((entry) => entry.subscriptionId === lost), false);
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'subscriptions.panel_link_reconciled', metadata: { path: ['automatic'], equals: true } },
      orderBy: { createdAt: 'desc' },
    });
    const links = (audit?.metadata as { links?: Array<{ subscriptionId: string }> } | undefined)?.links ?? [];
    assert.ok(links.some((link) => link.subscriptionId === lost), 'the audit names the row it linked');
    await prisma.adminAuditLog.deleteMany({ where: { id: audit?.id } });
  });

  it("links a customer's one extra profile to their one subscription without a link, and nothing ambiguous", async () => {
    const panel = new PanelDouble();
    const one = await newUser(fx);
    const two = await newUser(fx);
    const marked = await newUser(fx);
    const taken = await newUser(fx);
    const stranger = await newUser(fx);
    const p1 = PANEL_BASE + fx.next();
    const p2 = PANEL_BASE + fx.next();
    const p3 = PANEL_BASE + fx.next();
    const p4 = PANEL_BASE + fx.next();
    panel.add(p1, { shortUuid: `CMP${p1}`, owner: one });
    panel.add(p2, { shortUuid: `CMP${p2}`, owner: two });
    panel.add(p3, { shortUuid: `CMP${p3}`, owner: marked, subscriptionId: 'some-other-subscription' });
    panel.add(p4, { shortUuid: `CMP${p4}`, owner: taken });

    const s1 = await subscription(one, `${fx.prefix}-cmp-one`);
    const s2a = await subscription(two, `${fx.prefix}-cmp-two-a`);
    const s2b = await subscription(two, `${fx.prefix}-cmp-two-b`);
    const s3 = await subscription(marked, `${fx.prefix}-cmp-marked`);
    const s4 = await subscription(taken, `${fx.prefix}-cmp-taken`);
    await subscription(stranger, `${fx.prefix}-cmp-stranger`, { remnawaveId: String(p4), remnawavePanelId: p4 });

    const { comparison } = checkService(panel, new MemoryCache());
    const outcome = await comparison.compare();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;

    const linked = await prisma.subscription.findUniqueOrThrow({ where: { id: s1 } });
    assert.equal(linked.remnawaveId, String(p1));
    assert.equal(linked.remnawavePanelId, p1);
    assert.equal(linked.remnawavePanelUsername, `rz_pg_${p1}`);
    assert.equal(linked.configUrl, `https://sub.example.test/CMP${p1}`);

    for (const untouched of [s2a, s2b, s3, s4]) {
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: untouched } });
      assert.equal(row.remnawaveId, null, `${untouched} is left alone`);
    }
    const outcomes = new Map(
      outcome.result.customers.map((customer) => [customer.userId, customer.profiles.map((entry) => entry.autoLink)]),
    );
    assert.deepEqual(outcomes.get(one), ['linked']);
    assert.deepEqual(outcomes.get(two), ['severalSubscriptions']);
    assert.deepEqual(outcomes.get(marked), ['subscriptionMarkerMismatch']);
    assert.deepEqual(outcomes.get(taken), ['takenByOtherRow']);
  });

  it('R3b-03: a customer deleted here is listed apart and dated by the audit; another install\'s after; this install\'s customer is still linked', async () => {
    const panel = new PanelDouble();
    const one = await newUser(fx);
    // Ids no user row has: one an operator deleted (its audit row says so),
    // one another install's.
    const deleted = `${fx.prefix}-deleted-customer`;
    const stranger = `${fx.prefix}-other-install`;
    const p1 = PANEL_BASE + fx.next();
    const p2 = PANEL_BASE + fx.next();
    const p3 = PANEL_BASE + fx.next();
    panel.add(p1, { shortUuid: `UNK${p1}`, owner: one });
    panel.add(p2, { shortUuid: `UNK${p2}`, owner: deleted });
    panel.add(p3, { shortUuid: `UNK${p3}`, owner: stranger });
    const s1 = await subscription(one, `${fx.prefix}-unk-one`);
    const deletion = await prisma.adminAuditLog.create({
      data: { action: 'user.deleted', metadata: { userId: deleted, source: 'user_detail', mode: 'full' } },
      select: { id: true, createdAt: true },
    });
    // Not a deletion, and about the stranger: proves nothing.
    const blocked = await prisma.adminAuditLog.create({
      data: { action: 'user.blocked', metadata: { userId: stranger } },
      select: { id: true },
    });
    const cache = new MemoryCache();
    cache.store.set('panel-link-check:state', { walkCursor: `${fx.prefix}-unk-` });
    const { check } = checkService(panel, cache);
    const startedAt = new Date();

    try {
      assert.equal(await check.run('daily'), 'ran');

      const linked = await prisma.subscription.findUniqueOrThrow({ where: { id: s1 } });
      assert.equal(linked.remnawaveId, String(p1), 'this install\'s customer is still compared and linked');

      const list = await check.listExtraProfiles();
      assert.equal(list.customers.some((customer) => customer.userId === deleted || customer.userId === stranger), false);
      const apart = list.unknownOwners.filter((owner) => owner.userId === deleted || owner.userId === stranger);
      assert.deepEqual(
        apart.map((owner) => [owner.userId, owner.deletedAt, owner.profiles.map((entry) => [entry.profileId, entry.autoLink])]),
        [
          [deleted, deletion.createdAt.toISOString(), [[String(p2), 'ownerNotInPanel']]],
          [stranger, null, [[String(p3), 'ownerNotInPanel']]],
        ],
      );
      assert.ok(list.unknownOwnersTotal >= 2);
    } finally {
      // Only the rows this test made: the fixtures, and the pass's own audit row.
      const passAudit = await prisma.adminAuditLog.findFirst({
        where: {
          action: 'subscriptions.panel_link_reconciled',
          metadata: { path: ['automatic'], equals: true },
          createdAt: { gte: startedAt },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const ids = [deletion.id, blocked.id, ...(passAudit === null ? [] : [passAudit.id])];
      await prisma.adminAuditLog.deleteMany({ where: { id: { in: ids } } });
    }
  });

  // ── Review R3b-05: the CREATE's link write is a compare-and-swap ─────────
  //
  // The CREATE reads the row unlinked, then talks to Remnawave. A link another
  // writer commits meanwhile — the operator's «Привязать профиль», written as
  // that endpoint writes it — must survive the CREATE's own link write.

  /** Runs one CREATE job for `subscriptionId`; `duringPost` runs while the POST is in flight. */
  async function runCreate(input: {
    readonly userId: string;
    readonly subscriptionId: string;
    readonly mintedId: number;
    readonly duringPost: () => Promise<void>;
  }) {
    const patched: number[] = [];
    const enqueued: string[] = [];
    const answer = (id: number, createdAt: string, lastTrafficResetAt: string | null) => ({
      kind: 'ok' as const,
      data: {
        response: {
          id,
          username: `rz_pg_${id}`,
          status: 'ACTIVE',
          subscriptionUrl: `https://sub.example.test/MINT${id}`,
          description: `reiwa_id: ${input.userId}`,
          expireAt: '2099-12-31T00:00:00.000Z',
          createdAt,
          lastTrafficResetAt,
          trafficLimitBytes: 100 * 1024 ** 3,
          hwidDeviceLimit: 3,
        },
      },
    });
    const missing = { kind: 'rejected' as const, status: 404, code: 'A063', detail: 'User not found', retryAfterMs: null };
    const processor = new ProfileSyncProcessor(
      prisma,
      {
        getUserByUsername: async () => missing,
        resolveUser: async () => missing,
        // The profile the POST makes says it was reset lately — a fact of ITS
        // own that must never reach a row linking another profile.
        createUser: async () => {
          await input.duringPost();
          return answer(input.mintedId, '2026-01-15T12:30:00.000Z', '2026-09-20T00:00:00.000Z');
        },
        updateUser: async (body: { id: number }) => {
          patched.push(body.id);
          return answer(body.id, '2025-05-05T05:05:00.000Z', null);
        },
      } as never,
      {
        generateProfileName: async () => ({ username: `rz_pg_${input.mintedId}`, description: `reiwa_id: ${input.userId}` }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, warn: () => undefined, info: () => undefined, emit: () => undefined } as never,
      { enqueue: async (jobId: string) => void enqueued.push(jobId) } as never,
    );
    const job = await prisma.profileSyncJob.create({
      data: { subscriptionId: input.subscriptionId, action: SyncAction.CREATE, status: SyncJobStatus.PENDING, payload: {} },
      select: { id: true },
    });
    await processor.process({ data: { syncJobId: job.id } } as never);
    const jobs = await prisma.profileSyncJob.findMany({
      where: { subscriptionId: input.subscriptionId },
      orderBy: { createdAt: 'asc' },
    });
    return { job: jobs.find((row) => row.id === job.id)!, others: jobs.filter((row) => row.id !== job.id), patched, enqueued };
  }

  /** What «Привязать профиль» writes (`admin-user-subscriptions.controller.ts`), under the same lock. */
  async function operatorLinks(subscriptionId: string, panelId: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`remnawave-profile:${panelId}`})::bigint)`;
      const written = await tx.subscription.updateMany({
        where: { id: subscriptionId, remnawaveId: null },
        data: { remnawaveId: String(panelId), remnawavePanelId: panelId, remnawavePendingUsername: null, remnawavePendingOwnerId: null },
      });
      assert.equal(written.count, 1, 'the operator\'s link lands first');
    });
  }

  it('R3b-05: a link the operator wrote during the POST survives; the profile the CREATE made is queued for deletion; the row is pushed to the operator\'s profile', async () => {
    const userId = await newUser(fx);
    const own = PANEL_BASE + fx.next();
    const minted = PANEL_BASE + fx.next();
    const subscriptionId = await subscription(userId, `${fx.prefix}-r3b05-lost`);

    const run = await runCreate({ userId, subscriptionId, mintedId: minted, duringPost: () => operatorLinks(subscriptionId, own) });

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal(row.remnawaveId, String(own), 'the operator\'s link is not overwritten');
    assert.equal(row.remnawavePanelId, own);
    assert.equal(
      row.remnawaveProfileCreatedAt?.toISOString(),
      '2025-05-05T05:05:00.000Z',
      'the facts are those of the profile the row links, never of the one that lost',
    );
    assert.equal(row.remnawaveLastTrafficResetAt, null, 'the losing profile\'s reset never reaches the row');
    assert.equal(run.job.status, SyncJobStatus.COMPLETED);
    assert.deepEqual(run.patched, [own], 'the row\'s state goes out to the profile it links');
    assert.equal(run.others.length, 1);
    const [deletion] = run.others;
    assert.equal(deletion?.action, SyncAction.DELETE);
    assert.deepEqual(deletion?.payload, {
      source: 'CREATE_SUPERSEDED_BY_NEWER_LINK',
      targetRemnawaveId: String(minted),
      targetRemnawavePanelId: minted,
      targetRemnawavePanelUsername: `rz_pg_${minted}`,
    });
    assert.deepEqual(run.enqueued, [deletion?.id]);
  });

  it('R3b-05 control: nothing written meanwhile — the CREATE links the profile it made, and nothing is deleted', async () => {
    const userId = await newUser(fx);
    const minted = PANEL_BASE + fx.next();
    const subscriptionId = await subscription(userId, `${fx.prefix}-r3b05-won`);

    const run = await runCreate({ userId, subscriptionId, mintedId: minted, duringPost: async () => undefined });

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    assert.equal(row.remnawaveId, String(minted));
    assert.equal(row.remnawaveProfileCreatedAt?.toISOString(), '2026-01-15T12:30:00.000Z');
    assert.equal(row.remnawaveLastTrafficResetAt?.toISOString(), '2026-09-20T00:00:00.000Z');
    assert.equal(run.job.status, SyncJobStatus.COMPLETED);
    assert.deepEqual(run.others, []);
    assert.deepEqual(run.patched, []);
  });

  // ── FX5b: the walk's link clears the pending name; what the check reads, it stamps ──
  //
  // The walk and the comparison are driven one at a time here: in a whole pass
  // the comparison also reads every profile the walk just linked, and would
  // hide which of the two stamped it.

  const UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
  const iso = (value: Date | null) => value?.toISOString() ?? null;

  it('FX5b-1: the walk clears the name a CREATE recorded when it links the row', async () => {
    const userId = await newUser(fx);
    const panelId = PANEL_BASE + fx.next();
    const panel = new PanelDouble();
    panel.add(panelId, { shortUuid: `PEND${panelId}`, owner: userId });
    const lost = await subscription(userId, `${fx.prefix}-pend-lost`, {
      remnawaveId: UUID,
      configUrl: `https://sub.example.test/PEND${panelId}`,
      remnawavePendingUsername: `rz_pg_${panelId}_2`,
      remnawavePendingOwnerId: userId,
    });
    const { walk } = checkService(panel, new MemoryCache());

    const report = await walk.reconcile({ dryRun: false, startAfterId: `${fx.prefix}-pend-`, limit: 5 });

    assert.ok(report.repaired.some((row) => row.subscriptionId === lost && row.outcome === 'linked'));
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: lost } });
    assert.equal(row.remnawaveId, String(panelId));
    assert.equal(row.remnawavePendingUsername, null, 'nothing is left for a CREATE to look for');
    assert.equal(row.remnawavePendingOwnerId, null);
  });

  it('FX5b-7: the walk stamps the profile it read onto the row it links — never null over a value, the reset only forward', async () => {
    const userId = await newUser(fx);
    const [a, b, c] = [PANEL_BASE + fx.next(), PANEL_BASE + fx.next(), PANEL_BASE + fx.next()];
    const panel = new PanelDouble();
    panel.add(a, { shortUuid: `WFA${a}`, owner: userId, createdAt: '2025-03-20T09:15:00.000Z', lastTrafficResetAt: '2026-09-25T00:10:00.000Z' });
    // Its reset is OLDER than the one the row already holds.
    panel.add(b, { shortUuid: `WFB${b}`, owner: userId, createdAt: '2025-04-01T00:00:00.000Z', lastTrafficResetAt: '2026-09-01T00:00:00.000Z' });
    // It has never been reset: that says nothing about the reset the row holds.
    panel.add(c, { shortUuid: `WFC${c}`, owner: userId, createdAt: '2025-05-05T05:05:00.000Z', lastTrafficResetAt: null });
    const row = (suffix: string, panelId: number, data: Record<string, unknown> = {}) =>
      subscription(userId, `${fx.prefix}-wfacts-${suffix}`, {
        remnawaveId: UUID,
        configUrl: `https://sub.example.test/WF${suffix.toUpperCase()}${panelId}`,
        ...data,
      });
    const idA = await row('a', a);
    const idB = await row('b', b, { remnawaveLastTrafficResetAt: new Date('2026-09-20T00:00:00.000Z') });
    const idC = await row('c', c, { remnawaveLastTrafficResetAt: new Date('2026-09-10T00:00:00.000Z') });
    const { walk } = checkService(panel, new MemoryCache());

    const report = await walk.reconcile({ dryRun: false, startAfterId: `${fx.prefix}-wfacts-`, limit: 3 });

    assert.equal(report.linked, 3);
    const read = async (id: string) => {
      const stored = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      return [iso(stored.remnawaveProfileCreatedAt), iso(stored.remnawaveLastTrafficResetAt)];
    };
    assert.deepEqual(await read(idA), ['2025-03-20T09:15:00.000Z', '2026-09-25T00:10:00.000Z']);
    assert.deepEqual(await read(idB), ['2025-04-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z'], 'the reset only moves forward');
    assert.deepEqual(await read(idC), ['2025-05-05T05:05:00.000Z', '2026-09-10T00:00:00.000Z'], 'never null over a value');
  });

  it('FX5b-7 control: a dry run of the walk stamps nothing — not even the row that already links the profile', async () => {
    const userId = await newUser(fx);
    const other = await newUser(fx);
    const panelId = PANEL_BASE + fx.next();
    const panel = new PanelDouble();
    panel.add(panelId, { shortUuid: `WDRY${panelId}`, owner: userId, createdAt: '2025-03-20T09:15:00.000Z' });
    const id = await subscription(userId, `${fx.prefix}-wdry-a`, {
      remnawaveId: UUID,
      configUrl: `https://sub.example.test/WDRY${panelId}`,
    });
    // Another customer's row already on that profile: a real run would stamp it.
    const holder = await subscription(other, `${fx.prefix}-wdry-holder`, { remnawaveId: String(panelId), remnawavePanelId: panelId });
    const { walk } = checkService(panel, new MemoryCache());

    const report = await walk.reconcile({ dryRun: true, startAfterId: `${fx.prefix}-wdry-`, limit: 1 });

    assert.equal(report.unrepaired.find((row) => row.subscriptionId === id)?.outcome, 'conflict');
    for (const row of [id, holder]) {
      const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: row } });
      assert.equal(stored.remnawaveProfileCreatedAt, null, `${row} was stamped by a dry run`);
    }
  });

  it('FX5b-7: the comparison stamps every profile it read onto the live rows that link it, by either identifier', async () => {
    const one = await newUser(fx);
    const two = await newUser(fx);
    const [p1, p2, p3, p4] = [PANEL_BASE + fx.next(), PANEL_BASE + fx.next(), PANEL_BASE + fx.next(), PANEL_BASE + fx.next()];
    const panel = new PanelDouble();
    panel.add(p1, { shortUuid: `CFA${p1}`, owner: one, createdAt: '2025-01-01T01:00:00.000Z', lastTrafficResetAt: '2026-09-24T00:00:00.000Z' });
    panel.add(p2, { shortUuid: `CFB${p2}`, owner: two, createdAt: '2025-02-02T02:00:00.000Z', lastTrafficResetAt: '2026-09-01T00:00:00.000Z' });
    panel.add(p3, { shortUuid: `CFC${p3}`, owner: two, createdAt: '2025-03-03T03:00:00.000Z', lastTrafficResetAt: '2026-09-03T00:00:00.000Z' });
    panel.add(p4, { shortUuid: `CFD${p4}`, owner: one, createdAt: '2025-04-04T04:00:00.000Z', lastTrafficResetAt: '2026-09-04T00:00:00.000Z' });
    const linked = await subscription(one, `${fx.prefix}-cfacts-linked`, { remnawaveId: String(p1), remnawavePanelId: p1 });
    // Linked by the numeric panel id beside a 2.x uuid, with a LATER reset than p2's.
    const byPanelId = await subscription(two, `${fx.prefix}-cfacts-by-panel-id`, {
      remnawaveId: UUID,
      remnawavePanelId: p2,
      remnawaveLastTrafficResetAt: new Date('2026-09-15T00:00:00.000Z'),
    });
    const deleted = await subscription(two, `${fx.prefix}-cfacts-deleted`, {
      status: SubscriptionStatus.DELETED,
      remnawaveId: String(p3),
      remnawavePanelId: p3,
    });
    // The comparison's own link: `one` has this one row without a link and p4 as the one extra profile.
    const autoLinked = await subscription(one, `${fx.prefix}-cfacts-auto`);
    const { comparison } = checkService(panel, new MemoryCache());

    const outcome = await comparison.compare();

    assert.equal(outcome.kind, 'ok');
    const read = async (id: string) => {
      const stored = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      return [stored.remnawaveId, iso(stored.remnawaveProfileCreatedAt), iso(stored.remnawaveLastTrafficResetAt)];
    };
    assert.deepEqual(await read(linked), [String(p1), '2025-01-01T01:00:00.000Z', '2026-09-24T00:00:00.000Z']);
    assert.deepEqual(await read(byPanelId), [UUID, '2025-02-02T02:00:00.000Z', '2026-09-15T00:00:00.000Z'], 'the reset only moves forward');
    assert.deepEqual(await read(deleted), [String(p3), null, null], 'a DELETED row is left alone');
    assert.deepEqual(await read(autoLinked), [String(p4), '2025-04-04T04:00:00.000Z', '2026-09-04T00:00:00.000Z']);
  });
});
