import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { RemnawaveImporterService } from '../src/modules/imports/services/remnawave-importer.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';

/**
 * ONE PANEL PROFILE, TWO LOCAL ROWS — how it happens and what it destroys.
 *
 * `Subscription.remnawaveId` carries a DUAL meaning by design: Remnawave 2.x
 * keys profiles by a uuid, 3.x dropped the uuid column outright and keys them
 * by a numeric id, and a row linked in the 2.x era deliberately keeps its uuid
 * after the operator upgrades. `RemnawaveApiService.parsePanelUserRow` mirrors
 * that on the way in — `uuid` is `String(id)` for a 3.x row.
 *
 * `RemnawaveImporterService` asked "do I already know this profile?" as one
 * bare string compared to one column. Across the 2.x → 3.x boundary that
 * compares a decimal to a uuid, misses forever, and mints a second
 * Subscription — and, through `matchOrCreateUser` Priority 4, a second User for
 * every customer the panel can only identify that way.
 *
 * The importer also wrote NEITHER supplementary identity column, and that is
 * what turned a duplication into a data-loss path: with
 * `remnawave_panel_username` NULL, `ProfileSyncProcessor`'s delete guard read
 * "no name" as "nobody else claims this profile" and returned before asking any
 * question at all — including the immutable ones such a row can answer. So
 * deleting either of the two rows destroyed the panel profile the OTHER, live,
 * paying subscription was sitting on. The panel confirms the deletion, so the
 * job completes and nothing is logged.
 *
 * Every test here drives the real service and asserts what reached the
 * database — which rows were created versus updated, which columns carry what,
 * and whether anything was sent to the panel.
 */

type WhereNode = Record<string, unknown>;

/**
 * Evaluates a Prisma `where` against a row.
 *
 * The subject of every test below is WHICH ROWS A QUERY SEES, so a double that
 * returned a canned answer would prove nothing about the query. Supports only
 * the operators these two call sites build; anything else THROWS rather than
 * silently matching, so a later widening cannot quietly turn this back into a
 * canned answer.
 */
function matchesWhere(row: Record<string, unknown>, where: WhereNode): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as WhereNode[]).some((b) => matchesWhere(row, b));
    if (key === 'AND') return (condition as WhereNode[]).every((b) => matchesWhere(row, b));
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('not' in (condition as Record<string, unknown>)) {
        return row[key] !== (condition as { not: unknown }).not;
      }
      throw new Error(`unsupported filter on ${key}: ${JSON.stringify(condition)}`);
    }
    return row[key] === condition;
  });
}

// ── Importer ────────────────────────────────────────────────────────────────

interface ImportRow {
  id: string;
  userId: string;
  remnawaveId: string | null;
  remnawavePanelId: number | null;
  remnawavePanelUsername: string | null;
  status: string;
  planSnapshot: unknown;
  configUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

const OWNER_ID = 'ckowner000000000000000001';
const LEGACY_UUID = '7d1f0c9a-2b3e-4c55-9f10-abc123456789';
const PANEL_ID = 111;

/**
 * A panel row as each era actually puts it on the wire, decoded exactly the way
 * `parsePanelUserRow` decodes it: a 3.x body has NO `uuid` key at all, so the
 * identity string becomes `String(id)`.
 */
function decodedPanelRow(input: {
  era: '2.x' | '3.x';
  username: string;
  panelId: number;
  legacyUuid: string;
  description?: string | null;
}) {
  const uuid = input.era === '2.x' ? input.legacyUuid : String(input.panelId);
  return {
    uuid,
    panelId: input.panelId,
    username: input.username,
    status: 'ACTIVE',
    subscriptionUrl: `https://sub.example.test/${input.username}`,
    telegramId: null,
    email: null,
    expireAt: '2099-06-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastTrafficResetAt: null,
    trafficLimitBytes: 0,
    hwidDeviceLimit: 3,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: input.description ?? null,
    activeInternalSquads: [],
    externalSquadUuid: null,
  };
}

interface ImportHarness {
  readonly service: RemnawaveImporterService;
  readonly rows: ImportRow[];
  readonly createdUserIds: string[];
  /** `User.username` per user id — the PUBLIC handle, not the panel profile name. */
  readonly handles: Map<string, string | null>;
}

function buildImporter(input: {
  readonly rows: ImportRow[];
  readonly panelUsers: ReadonlyArray<ReturnType<typeof decodedPanelRow>>;
  /** Seeds `User.username`. Absent means the account has no handle yet. */
  readonly handles?: Readonly<Record<string, string>>;
}): ImportHarness {
  const rows = input.rows;
  const createdUserIds: string[] = [];
  const handles = new Map<string, string | null>(Object.entries(input.handles ?? {}));
  let seq = 0;
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const id = where.id as string | undefined;
        if (id === undefined) return null;
        if (id !== OWNER_ID && !createdUserIds.includes(id)) return null;
        return {
          id,
          username: handles.get(id) ?? null,
          // Old enough that `wasJustCreated` reports false for a MATCHED user.
          createdAt: createdUserIds.includes(id) ? new Date() : new Date(0),
          currentSubscriptionId: rows.find((r) => r.userId === id)?.id ?? null,
        };
      },
      // Records what it is told, and — for `updateMany` — REFUSES the write when
      // the guard does not match. A pass-through that always applied would make
      // "never overwrites an existing handle" pass against a service that has no
      // guard at all.
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if ('username' in data) handles.set(where.id, data.username as string | null);
        return { id: where.id };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; OR?: ReadonlyArray<{ username: string | null }> };
        data: Record<string, unknown>;
      }) => {
        const current = handles.get(where.id) ?? null;
        const guard = where.OR;
        const passes =
          guard === undefined ? true : guard.some((clause) => clause.username === current);
        if (!passes) return { count: 0 };
        if ('username' in data) handles.set(where.id, data.username as string | null);
        return { count: 1 };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const id = `minted-user-${seq}`;
        createdUserIds.push(id);
        handles.set(id, (data.username as string | null) ?? null);
        return { id };
      },
    },
    subscription: {
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: WhereNode;
        orderBy?: { createdAt?: 'asc' | 'desc' };
      }) => {
        const hits = rows.filter((r) => matchesWhere(r as unknown as Record<string, unknown>, where));
        if (orderBy?.createdAt === 'asc') {
          hits.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        } else if (orderBy?.createdAt === 'desc') {
          hits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return hits[0] ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (row === undefined) throw new Error(`update of unknown row ${where.id}`);
        const { user, ...columns } = data as Record<string, unknown> & { user?: unknown };
        if (user !== undefined) {
          row.userId = (user as { connect: { id: string } }).connect.id;
        }
        Object.assign(row, columns);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row: ImportRow = {
          id: `created-sub-${seq}`,
          userId: (data.user as { connect: { id: string } }).connect.id,
          remnawaveId: (data.remnawaveId as string) ?? null,
          remnawavePanelId: (data.remnawavePanelId as number) ?? null,
          remnawavePanelUsername: (data.remnawavePanelUsername as string) ?? null,
          status: (data.status as string) ?? 'ACTIVE',
          planSnapshot: data.planSnapshot,
          configUrl: (data.configUrl as string) ?? null,
          expiresAt: (data.expiresAt as Date) ?? null,
          createdAt: new Date(Date.now() + seq),
        };
        rows.push(row);
        return row;
      },
    },
    importRecord: { create: async () => ({ id: 'import-record-1' }) },
  };
  const api = {
    strictGetAllPanelUsers: async () =>
      strictOk({ users: input.panelUsers, total: input.panelUsers.length, complete: true }),
    updatePanelUser: async () => ({}),
  };
  return {
    service: new RemnawaveImporterService(prisma as never, api as never),
    rows,
    createdUserIds,
    handles,
  };
}

/** A local row linked while the panel was still 2.x. */
function legacyRow(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    id: 'legacy-sub',
    userId: OWNER_ID,
    remnawaveId: LEGACY_UUID,
    remnawavePanelId: null,
    remnawavePanelUsername: null,
    status: 'ACTIVE',
    planSnapshot: { name: 'Unlimited', priceRub: 500 },
    configUrl: 'https://sub.example.test/rz_owner',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('RemnawaveImporterService recognises one panel profile across both panel eras', () => {
  it('matches a 2.x-linked row on a 3.x panel through the recorded numeric id', async () => {
    // THE PRODUCTION DEFECT, in its smallest form. The row stores the uuid the
    // 2.x panel issued; the upgraded panel has no uuid column left and reports
    // the numeric id, which `parsePanelUserRow` renders as the decimal '111'.
    // `remnawaveId === panelUser.uuid` compares '7d1f0c9a-…' to '111'.
    const harness = buildImporter({
      rows: [legacyRow({ remnawavePanelId: PANEL_ID })],
      panelUsers: [
        decodedPanelRow({
          era: '3.x',
          username: 'rz_owner',
          panelId: PANEL_ID,
          legacyUuid: LEGACY_UUID,
          description: `reiwa_id: ${OWNER_ID}`,
        }),
      ],
    });

    const summary = await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(summary.subscriptionsCreated, 0, 'the profile was already known');
    assert.equal(summary.subscriptionsUpdated, 1);
    assert.equal(harness.rows.length, 1, 'no second row may appear for one profile');
    // The stored 2.x identity is deliberately NOT rewritten — see
    // `prisma/schema.prisma`, `Subscription.remnawaveId`.
    assert.equal(harness.rows[0].remnawaveId, LEGACY_UUID);
  });

  it('matches a row whose stored identity IS the identity the panel reports', async () => {
    // The plain arm, and the only one that ever worked. Kept as its own test so
    // that removing it from the OR is visible.
    const harness = buildImporter({
      rows: [legacyRow()],
      panelUsers: [
        decodedPanelRow({
          era: '2.x',
          username: 'rz_owner',
          panelId: PANEL_ID,
          legacyUuid: LEGACY_UUID,
          description: `reiwa_id: ${OWNER_ID}`,
        }),
      ],
    });

    const summary = await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(summary.subscriptionsCreated, 0);
    assert.equal(summary.subscriptionsUpdated, 1);
    assert.equal(harness.rows.length, 1);
  });

  it('matches a 3.x-provisioned row after the operator rolls the panel BACK to 2.x', async () => {
    // The third arm, `remnawaveId = String(panelId)`, and the one scenario that
    // isolates it: on a 3.x panel `uuid` and `String(panelId)` are the same
    // string, so the arm only does work when the panel reports a uuid while a
    // local row holds the decimal. That is a DOWNGRADE, which this build
    // supports — it is the single build for 2.7.4 and 3.x alike, and an
    // operator who hits trouble on 3.x rolls back.
    const harness = buildImporter({
      rows: [legacyRow({ remnawaveId: String(PANEL_ID), remnawavePanelId: null })],
      panelUsers: [
        decodedPanelRow({
          era: '2.x',
          username: 'rz_owner',
          panelId: PANEL_ID,
          legacyUuid: LEGACY_UUID,
          description: `reiwa_id: ${OWNER_ID}`,
        }),
      ],
    });

    const summary = await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(summary.subscriptionsCreated, 0);
    assert.equal(summary.subscriptionsUpdated, 1);
    assert.equal(harness.rows.length, 1);
  });

  it('does not mint a second User for a web-only customer after the upgrade', async () => {
    // Priority 4 is the ONLY handle on a customer who signed up through the web
    // cabinet: no Telegram, no email, and no `reiwa_id` marker written back
    // yet. A miss there does not skip — it falls through to Priority 5, which
    // in `import` mode CREATES a User. So the same broken comparison that
    // duplicates a subscription duplicates the customer.
    const harness = buildImporter({
      rows: [legacyRow({ remnawavePanelId: PANEL_ID })],
      panelUsers: [
        decodedPanelRow({
          era: '3.x',
          username: 'rz_owner',
          panelId: PANEL_ID,
          legacyUuid: LEGACY_UUID,
          description: null,
        }),
      ],
    });

    const summary = await harness.service.run({ mode: 'import', createdBy: 'admin-1' });

    assert.deepStrictEqual(harness.createdUserIds, [], 'no User may be minted for a known profile');
    assert.equal(summary.created, 0);
    assert.equal(summary.subscriptionsCreated, 0);
    assert.equal(harness.rows.length, 1);
    assert.equal(harness.rows[0].userId, OWNER_ID, 'the profile stays with its owner');
  });

  it('records the panel id and username on the row it updates', async () => {
    // DEFECT 3, and the reason defect 1 was ever reachable. Both facts are on
    // the panel row the importer is already holding — 2.x returns the numeric
    // id beside the uuid — and leaving them NULL is what disarms
    // `panelProfileClaimedByAnother` for every row this importer touches.
    const harness = buildImporter({
      rows: [legacyRow({ remnawavePanelId: PANEL_ID })],
      panelUsers: [
        decodedPanelRow({
          era: '3.x',
          username: 'rz_owner',
          panelId: PANEL_ID,
          legacyUuid: LEGACY_UUID,
          description: `reiwa_id: ${OWNER_ID}`,
        }),
      ],
    });

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(harness.rows[0].remnawavePanelId, PANEL_ID);
    assert.equal(harness.rows[0].remnawavePanelUsername, 'rz_owner');
  });

  it('records the panel id and username on the row it creates', async () => {
    const harness = buildImporter({
      rows: [],
      panelUsers: [
        decodedPanelRow({
          era: '3.x',
          username: 'rz_newcomer',
          panelId: 990,
          legacyUuid: LEGACY_UUID,
          description: `reiwa_id: ${OWNER_ID}`,
        }),
      ],
    });

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(harness.rows.length, 1);
    assert.equal(harness.rows[0].remnawaveId, '990');
    assert.equal(harness.rows[0].remnawavePanelId, 990);
    assert.equal(harness.rows[0].remnawavePanelUsername, 'rz_newcomer');
  });

  it('merges into planSnapshot instead of replacing it, so the plan name survives', async () => {
    // DEFECT 4. Prisma writes a `Json` column WHOLESALE — there is no per-key
    // update — so the object literal the importer builds from panel facts alone
    // used to erase every key the row already carried. `name` is what the
    // cabinet, the bot and every invoice render as the customer's plan: a row
    // this importer MATCHED came out of the sync nameless.
    const harness = buildImporter({
      rows: [legacyRow({ remnawavePanelId: PANEL_ID })],
      panelUsers: [
        decodedPanelRow({
          era: '3.x',
          username: 'rz_owner',
          panelId: PANEL_ID,
          legacyUuid: LEGACY_UUID,
          description: `reiwa_id: ${OWNER_ID}`,
        }),
      ],
    });

    await harness.service.run({ mode: 'sync', createdBy: null });

    const snapshot = harness.rows[0].planSnapshot as Record<string, unknown>;
    assert.equal(snapshot.name, 'Unlimited', 'the plan name must survive a sync');
    assert.equal(snapshot.priceRub, 500, 'and so must every other key the row carried');
    // The panel facts still land on top.
    assert.equal(snapshot.importedFrom, 'remnawave');
    assert.equal(snapshot.trafficLimitStrategy, 'NO_RESET');
  });

  it('ANTI-VACUITY: a genuinely new panel profile still creates exactly one row', async () => {
    // The control that keeps every assertion above honest. A matcher widened
    // until it matches ANY row would satisfy all of them — it would report
    // "updated" for everything and never create. Here an unrelated local row
    // exists and must NOT be adopted: the panel profile is new, so exactly one
    // row must appear and the bystander must be untouched.
    const bystander = legacyRow({
      id: 'unrelated-sub',
      remnawaveId: 'ffffffff-0000-0000-0000-000000000000',
      remnawavePanelId: 777,
      remnawavePanelUsername: 'rz_somebody_else',
    });
    const harness = buildImporter({
      rows: [bystander],
      panelUsers: [
        decodedPanelRow({
          era: '3.x',
          username: 'rz_brand_new',
          panelId: 424242,
          legacyUuid: LEGACY_UUID,
          description: `reiwa_id: ${OWNER_ID}`,
        }),
      ],
    });

    const summary = await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(summary.subscriptionsCreated, 1, 'a new profile must still be created');
    assert.equal(summary.subscriptionsUpdated, 0);
    assert.equal(harness.rows.length, 2);
    assert.equal(bystander.remnawaveId, 'ffffffff-0000-0000-0000-000000000000');
    assert.equal(bystander.remnawavePanelId, 777, 'the bystander must not be rewritten');
    assert.deepStrictEqual(bystander.planSnapshot, { name: 'Unlimited', priceRub: 500 });
  });
});

// ── Delete guard ────────────────────────────────────────────────────────────

interface GuardRow {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
  readonly configUrl: string | null;
}

interface GuardHarness {
  readonly processor: ProfileSyncProcessor;
  /** Every identity that actually reached `deletePanelUser`. */
  readonly deletedTargets: unknown[];
}

function buildDeleteGuard(input: {
  readonly payload: Record<string, unknown>;
  readonly doomed: GuardRow;
  readonly table: readonly GuardRow[];
}): GuardHarness {
  const deletedTargets: unknown[] = [];
  const processor = new ProfileSyncProcessor(
    {
      profileSyncJob: {
        findUnique: async () => ({
          id: 'sync-job-delete',
          action: SyncAction.DELETE,
          status: SyncJobStatus.PENDING,
          attempts: 0,
          payload: input.payload,
          subscription: {
            userId: 'user-1',
            trafficLimit: null,
            deviceLimit: 0,
            internalSquads: [],
            externalSquad: null,
            expiresAt: new Date('2020-01-01T00:00:00.000Z'),
            planSnapshot: {},
            ...input.doomed,
          },
        }),
        updateMany: async () => ({ count: 1 }),
        update: async () => undefined,
      },
      subscription: {
        findMany: async (args: { where: WhereNode }) =>
          input.table
            .filter((row) => matchesWhere(row as unknown as Record<string, unknown>, args.where))
            .map((row) => ({ id: row.id, remnawaveId: row.remnawaveId })),
        updateMany: async () => ({ count: 1 }),
      },
    } as never,
    {
      deletePanelUser: async (ref: unknown) => {
        deletedTargets.push(ref);
        return { isDeleted: true };
      },
    } as never,
    {} as never,
    { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
  );
  return { processor, deletedTargets };
}

const DOOMED_UUID = '330f2b38-1362-46ab-b5c0-dea32167eff9';
const SHARED_PANEL_ID = 4471;

describe('profile-sync DELETE guard on a row that never recorded a panel username', () => {
  it('refuses when another LIVE row holds the very identity this job targets', async () => {
    // THE DATA-LOSS PATH, exactly as production produced it. Both rows were
    // written by the importer, so both carry `remnawave_panel_username = NULL`
    // and both hold the same identity string. The guard opened with
    // `if (username === null) return null` — no name, therefore (it concluded)
    // no claimant — so it never asked the one question these rows CAN answer,
    // and `SubscriptionDeletionService` enqueues a DELETE for any row with a
    // non-null `remnawaveId`. The panel profile of the live, paying row was
    // destroyed, the panel confirmed it, and the job completed.
    const harness = buildDeleteGuard({
      payload: { targetRemnawaveId: String(SHARED_PANEL_ID) },
      doomed: {
        id: 'subscription-doomed',
        status: SubscriptionStatus.DELETED,
        remnawaveId: String(SHARED_PANEL_ID),
        remnawavePanelId: null,
        remnawavePanelUsername: null,
        configUrl: null,
      },
      table: [
        {
          id: 'subscription-doomed',
          status: SubscriptionStatus.DELETED,
          remnawaveId: String(SHARED_PANEL_ID),
          remnawavePanelId: null,
          remnawavePanelUsername: null,
          configUrl: null,
        },
        {
          id: 'subscription-victim',
          status: SubscriptionStatus.ACTIVE,
          remnawaveId: String(SHARED_PANEL_ID),
          remnawavePanelId: null,
          remnawavePanelUsername: null,
          configUrl: 'https://sub.example.test/api/sub/vvv',
        },
      ],
    });

    await assert.rejects(
      () => harness.processor.process({ data: { syncJobId: 'sync-job-delete' } } as never),
      /Refusing to delete/,
    );
    // The assertion that matters is not the message but that NOTHING was sent:
    // a refusal that still calls the panel has refused nothing.
    assert.deepStrictEqual(harness.deletedTargets, []);
  });

  it('refuses when the claimant names the profile by its recorded numeric id', async () => {
    // Same profile, named the other way round: the doomed job carries the 2.x
    // uuid plus the numeric id recorded at enqueue, and the live row records
    // that id in the supplementary column beside a uuid of its own. Neither row
    // has a username, so this is unreachable without the immutable arms.
    const harness = buildDeleteGuard({
      payload: {
        targetRemnawaveId: DOOMED_UUID,
        targetRemnawavePanelId: SHARED_PANEL_ID,
      },
      doomed: {
        id: 'subscription-doomed',
        status: SubscriptionStatus.DELETED,
        remnawaveId: DOOMED_UUID,
        remnawavePanelId: SHARED_PANEL_ID,
        remnawavePanelUsername: null,
        configUrl: null,
      },
      table: [
        {
          id: 'subscription-victim',
          status: SubscriptionStatus.ACTIVE,
          remnawaveId: 'b2a4c6e8-1111-2222-3333-444455556666',
          remnawavePanelId: SHARED_PANEL_ID,
          remnawavePanelUsername: null,
          configUrl: 'https://sub.example.test/api/sub/vvv',
        },
      ],
    });

    await assert.rejects(
      () => harness.processor.process({ data: { syncJobId: 'sync-job-delete' } } as never),
      /Refusing to delete/,
    );
    assert.deepStrictEqual(harness.deletedTargets, []);
  });

  it('refuses when the claimant stores the numeric id as its remnawaveId', async () => {
    // The duplication this build's importer fix stops producing, met on the way
    // out: the original row holds the 2.x uuid, the duplicate the importer
    // minted on the 3.x panel holds the SAME profile as the decimal. Deleting
    // the original resolves to the profile the duplicate is live on.
    const harness = buildDeleteGuard({
      payload: {
        targetRemnawaveId: DOOMED_UUID,
        targetRemnawavePanelId: SHARED_PANEL_ID,
      },
      doomed: {
        id: 'subscription-doomed',
        status: SubscriptionStatus.DELETED,
        remnawaveId: DOOMED_UUID,
        remnawavePanelId: SHARED_PANEL_ID,
        remnawavePanelUsername: null,
        configUrl: null,
      },
      table: [
        {
          id: 'subscription-duplicate',
          status: SubscriptionStatus.ACTIVE,
          remnawaveId: String(SHARED_PANEL_ID),
          remnawavePanelId: null,
          remnawavePanelUsername: null,
          configUrl: 'https://sub.example.test/api/sub/vvv',
        },
      ],
    });

    await assert.rejects(
      () => harness.processor.process({ data: { syncJobId: 'sync-job-delete' } } as never),
      /Refusing to delete/,
    );
    assert.deepStrictEqual(harness.deletedTargets, []);
  });

  it('ANTI-VACUITY: still deletes when nobody else names the profile', async () => {
    // The control that keeps the three refusals honest. A guard widened until
    // it refuses everything would pass all of them — and would break every
    // ordinary delete, leaving an orphaned profile on the panel for each one.
    // Same shape as above: no usernames anywhere, so the only thing separating
    // this case from the first is WHICH identity the other row holds.
    const harness = buildDeleteGuard({
      payload: {
        targetRemnawaveId: DOOMED_UUID,
        targetRemnawavePanelId: SHARED_PANEL_ID,
      },
      doomed: {
        id: 'subscription-doomed',
        status: SubscriptionStatus.DELETED,
        remnawaveId: DOOMED_UUID,
        remnawavePanelId: SHARED_PANEL_ID,
        remnawavePanelUsername: null,
        configUrl: null,
      },
      table: [
        {
          id: 'subscription-unrelated',
          status: SubscriptionStatus.ACTIVE,
          remnawaveId: 'ffffffff-0000-0000-0000-000000000000',
          remnawavePanelId: 9999,
          remnawavePanelUsername: null,
          configUrl: 'https://sub.example.test/api/sub/zzz',
        },
      ],
    });

    await harness.processor.process({ data: { syncJobId: 'sync-job-delete' } } as never);

    assert.equal(harness.deletedTargets.length, 1, 'an uncontested profile must still be removed');
  });

  it('ANTI-VACUITY: a retired row holding the same identity is not a claimant', async () => {
    // A DELETED row is nobody's service. Counting it would make the second and
    // subsequent deletes of a re-provisioned subscription refuse forever, and
    // that is how a fail-safe guard turns into a stuck queue.
    const harness = buildDeleteGuard({
      payload: { targetRemnawaveId: String(SHARED_PANEL_ID) },
      doomed: {
        id: 'subscription-doomed',
        status: SubscriptionStatus.DELETED,
        remnawaveId: String(SHARED_PANEL_ID),
        remnawavePanelId: null,
        remnawavePanelUsername: null,
        configUrl: null,
      },
      table: [
        {
          id: 'subscription-long-retired',
          status: SubscriptionStatus.DELETED,
          remnawaveId: String(SHARED_PANEL_ID),
          remnawavePanelId: null,
          remnawavePanelUsername: null,
          configUrl: null,
        },
      ],
    });

    await harness.processor.process({ data: { syncJobId: 'sync-job-delete' } } as never);

    assert.equal(harness.deletedTargets.length, 1);
  });
});

/**
 * THE PANEL PROFILE NAME IS NOT A PERSON'S HANDLE.
 *
 * Reported from production on 2026-08-24: a subscriber who registered on the
 * web with the login `Lant35` was shown to the operator with the public
 * username `@2GET_Lant35_sub`. That string is not something anyone typed — it
 * is `{prefix}_{identity}_{suffix}`, the name OUR OWN naming service minted for
 * the Remnawave profile. The importer read it back off the panel and wrote it
 * into `User.username`, and because the importer runs on every sync, an
 * operator correcting it by hand watched it come back.
 *
 * The tell is in the profile description: everything we create carries
 * `reiwa_id: <user id>`. A profile that names one is ours, and its username
 * says nothing about the person. A profile that does NOT is foreign — imported
 * from someone else's panel — and there its username may be the only handle
 * that exists, which is the case this field was added for.
 *
 * The three specs below are the same run with ONE field moved.
 */
describe('the importer separates our generated profile name from a public handle', () => {
  it('does not put OUR generated profile name into the public username', async () => {
    const harness = buildImporter({
      rows: [legacyRow({ remnawavePanelId: PANEL_ID })],
      panelUsers: [
        decodedPanelRow({
          era: '3.x',
          username: '2GET_Lant35_sub',
          panelId: PANEL_ID,
          legacyUuid: LEGACY_UUID,
          description: `login: Lant35\nreiwa_id: ${OWNER_ID}`,
        }),
      ],
    });

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(harness.handles.get(OWNER_ID) ?? null, null);
  });

  it('still adopts a FOREIGN panel username when the account has no handle', async () => {
    // Same run, `reiwa_id` removed from the description. Without this the fix
    // above would read as "never fill the handle", which would silently undo
    // what importing a stranger's panel is for.
    const harness = buildImporter({
      rows: [legacyRow({ remnawavePanelId: PANEL_ID })],
      panelUsers: [
        decodedPanelRow({
          era: '3.x',
          username: 'someone_elses_handle',
          panelId: PANEL_ID,
          legacyUuid: LEGACY_UUID,
          description: 'imported from a foreign panel',
        }),
      ],
    });

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(harness.handles.get(OWNER_ID), 'someone_elses_handle');
  });

  it('never overwrites a handle the account already has', async () => {
    // This one runs on EVERY sync. Overwriting would mean the operator cannot
    // keep a correction, and the subscriber cannot keep a chosen name.
    const harness = buildImporter({
      rows: [legacyRow({ remnawavePanelId: PANEL_ID })],
      panelUsers: [
        decodedPanelRow({
          era: '3.x',
          username: 'someone_elses_handle',
          panelId: PANEL_ID,
          legacyUuid: LEGACY_UUID,
          description: 'imported from a foreign panel',
        }),
      ],
      handles: { [OWNER_ID]: 'chosen_by_the_subscriber' },
    });

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(harness.handles.get(OWNER_ID), 'chosen_by_the_subscriber');
  });
});
