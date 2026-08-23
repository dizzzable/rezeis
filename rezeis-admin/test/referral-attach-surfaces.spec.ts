import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AdminReferralsController } from '../src/modules/referrals/controllers/admin-referrals.controller';
import { ReferralManualAttachService } from '../src/modules/referrals/services/referral-manual-attach.service';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

/**
 * Manual referral attach, across every surface that can perform it.
 *
 * FOUR operator routes reach `ReferralManualAttachService.attachReferrerManually`,
 * and every one of them replays the user's completed payments through the new
 * graph and credits partner earnings. All four move money. What they recorded
 * about the operator did not agree:
 *
 *   POST /admin/users/:telegramId/referral/attach          user.referral.attached
 *   POST /admin/users/:telegramId/partner/attach-referral   user.partner.referral.attached
 *   POST /admin/referrals/manual-attach                     nothing — no @CurrentAdmin at all
 *   POST /admin/referrals/attach                            nothing — no @CurrentAdmin at all
 *
 * The last one is what the Referrals page's "Attach referrer" dialog posts to,
 * so the single most-used surface was the one recording nothing. Two operators
 * attaching the same referrer on the same day left one of three different
 * traces depending on which screen they used, and the audit log could not be
 * queried for an act that moves money.
 *
 * ── One act or two? ───────────────────────────────────────────────────────────
 *
 * `partner/attach-referral` is addressed from the other end — the path names
 * the referrer and the body names the referred, the reverse of
 * `referral/attach` — and it is gated on `partners:edit` rather than
 * `referrals:edit`. Neither difference reaches the data: both create ONE
 * `Referral` edge from referrer to referred, both attach the same partner
 * chain, both replay the same payments, and no row afterwards can say which
 * route made it. A permission gate says who may open a door, not which room
 * the door leads to.
 *
 * So: one act, ONE audit action, and the surface in `metadata.source` —
 * `partner.balance.adjusted` and `user.subscription.limits_changed` settled the
 * same question the same way. The tests below pin that by name, including that
 * `user_detail` and `user_detail_partner` stay distinguishable so "an operator
 * holding only `partners:edit` rewrote the referral graph" is one query.
 *
 * ── What is asserted, and what is not ─────────────────────────────────────────
 *
 * Everything runs the REAL service and the REAL controllers against a fake
 * Prisma that HOLDS rows, and asserts on the rows and on the exact `data` handed
 * to the client. A double that only records calls cannot tell "nothing was
 * written" from "the writer was never wired up", so the first describe block is
 * a control proving this fake does record an audit row and an event when one is
 * actually written — every zero below is a real zero.
 *
 * Not asserted, and not claimed: atomicity. `attachReferrerManually` is not
 * transactional and this change does not make it so — the edge, the partner
 * chain and the replay are separate writes. What IS asserted is that the
 * operator record survives a replay that dies halfway, because that is the case
 * where money has already moved.
 *
 * Dates are relative. An absolute fixture date in this repo was live when
 * written and silently became an expired-subscription assertion months later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const ADMIN = { id: 'admin-1' } as never;
const REQ = {
  headers: { 'x-request-id': 'req-9', 'user-agent': 'panel/1.0' },
  ip: '10.0.0.7',
  socket: { remoteAddress: '10.0.0.7' },
} as never;

/** Telegram ids of the two fixture users. */
const REFERRED_TG = 2000n;
const REFERRER_TG = 1000n;

interface UserRow {
  id: string;
  telegramId: bigint;
  email: string | null;
  createdAt: Date;
}

interface ReferralRow {
  id: string;
  referrerId: string;
  referredId: string;
  level: number;
  inviteSource: string;
}

interface TransactionRow {
  id: string;
  userId: string;
  status: string;
  amount: number;
  gatewayType: string;
  createdAt: Date;
}

interface EmittedEvent {
  type: string;
  category: string;
  message: string;
  metadata: Record<string, unknown>;
}

/** One completed payment replayed through the new graph — i.e. money moving. */
interface ReplayedEarning {
  payerUserId: string;
  sourceTransactionId: string;
}

function project(row: Record<string, unknown>, select?: Record<string, unknown>): unknown {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = row[key];
  }
  return out;
}

/**
 * Fake Prisma holding real rows.
 *
 * `adminAuditLog.create` keeps the WHOLE `data` object it was handed, not a
 * count: the action name, the actor connection and the metadata are the thing
 * under test, and a call counter cannot tell `user.referral.attached` from
 * `user.partner.referral.attached`, nor a row naming its operator from one
 * that does not.
 */
function makeDb(seed: { users: UserRow[]; transactions?: TransactionRow[] }) {
  const users = [...seed.users];
  const referrals: ReferralRow[] = [];
  const partnerReferrals: Array<{ id: string; referralUserId: string }> = [];
  const transactions = [...(seed.transactions ?? [])];
  const auditLogs: Array<Record<string, unknown>> = [];
  let referralSeq = 0;

  const client = {
    user: {
      findUnique: async (args: {
        where: { id?: string; telegramId?: bigint };
        select?: Record<string, unknown>;
      }) => {
        const row = users.find((u) =>
          args.where.id !== undefined ? u.id === args.where.id : u.telegramId === args.where.telegramId,
        );
        return row ? project(row as unknown as Record<string, unknown>, args.select) : null;
      },
      findFirst: async (args: {
        where: { telegramId?: bigint; email?: { equals?: string } };
        select?: Record<string, unknown>;
      }) => {
        const row = users.find((u) => {
          if (args.where.telegramId !== undefined) return u.telegramId === args.where.telegramId;
          if (args.where.email?.equals !== undefined) return u.email === args.where.email.equals;
          return false;
        });
        return row ? project(row as unknown as Record<string, unknown>, args.select) : null;
      },
    },
    webAccount: {
      findFirst: async () => null,
    },
    referral: {
      findUnique: async (args: { where: { referredId?: string }; select?: Record<string, unknown> }) => {
        const row = referrals.find((r) => r.referredId === args.where.referredId);
        return row ? project(row as unknown as Record<string, unknown>, args.select) : null;
      },
      create: async (args: { data: Omit<ReferralRow, 'id'>; select?: Record<string, unknown> }) => {
        const row: ReferralRow = { id: `ref-${++referralSeq}`, ...args.data };
        referrals.push(row);
        return project(row as unknown as Record<string, unknown>, args.select);
      },
    },
    partnerReferral: {
      findFirst: async (args: { where: { referralUserId?: string } }) =>
        partnerReferrals.find((p) => p.referralUserId === args.where.referralUserId) ?? null,
    },
    transaction: {
      findMany: async (args: {
        where: { userId?: string; status?: string };
        select?: Record<string, unknown>;
      }) =>
        transactions
          .filter((t) => t.userId === args.where.userId && t.status === args.where.status)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((t) => project(t as unknown as Record<string, unknown>, args.select)),
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditLogs.push(args.data);
        return args.data;
      },
    },
  };

  const emitted: EmittedEvent[] = [];
  const events = {
    info: (type: string, category: string, message: string, metadata: Record<string, unknown>) =>
      emitted.push({ type, category, message, metadata }),
    warn: (type: string, category: string, message: string, metadata: Record<string, unknown>) =>
      emitted.push({ type, category, message, metadata }),
    error: () => undefined,
  };

  const replayed: ReplayedEarning[] = [];
  const failures = { earningAfter: Number.POSITIVE_INFINITY };
  const partnerEarnings = {
    attachPartnerReferralChain: async () => true,
    processPartnerEarning: async (input: { payerUserId: string; sourceTransactionId: string }) => {
      if (replayed.length >= failures.earningAfter) {
        throw new Error('partner earning refused');
      }
      replayed.push({ payerUserId: input.payerUserId, sourceTransactionId: input.sourceTransactionId });
    },
  };
  const qualification = {
    qualifyReferralAfterPurchase: async () => undefined,
  };

  return {
    client,
    events,
    emitted,
    replayed,
    failures,
    state: { users, referrals, partnerReferrals, auditLogs },
    partnerEarnings,
    qualification,
  };
}

type Db = ReturnType<typeof makeDb>;

function makeAttachService(db: Db): ReferralManualAttachService {
  return new ReferralManualAttachService(
    db.client as never,
    db.qualification as never,
    db.partnerEarnings as never,
    db.events as never,
  );
}

function buildReferralsTab(db: Db): AdminReferralsController {
  return new AdminReferralsController(
    {} as never, // ReferralsService
    {} as never, // ReferralInviteLimitsService
    makeAttachService(db),
    {} as never, // AdminRewardsService
    {} as never, // AdminReferralAnalyticsService
    db.client as never,
  );
}

function buildUserCard(db: Db): AdminUserManagementController {
  return new AdminUserManagementController(
    db.client as never,
    db.events as never,
    {} as never, // PartnerEarningsService
    makeAttachService(db),
    {} as never, // ReferralQualificationService
    {} as never, // StealthnetReferralSyncService
    {} as never, // ReferralInviteLimitsService
    {} as never, // RemnawaveApiService
    {} as never, // UserNotificationsService
    {} as never, // RbacService
    {} as never, // UserDeletionService
    {} as never, // PartnersService
    {} as never, // PlansAdminService
  );
}

function makeUser(id: string, telegramId: bigint): UserRow {
  return {
    id,
    telegramId,
    email: `${id}@example.test`,
    createdAt: new Date(Date.now() - 90 * DAY_MS),
  };
}

/**
 * The same pair every surface attaches: `u-referred` gains `u-referrer` as its
 * referrer. `completedPayments` are the historical transactions the attach
 * replays — the money.
 */
function seed(completedPayments = 0): Db {
  const transactions: TransactionRow[] = [];
  for (let i = 0; i < completedPayments; i++) {
    transactions.push({
      id: `tx-${i + 1}`,
      userId: 'u-referred',
      status: 'COMPLETED',
      amount: 1_000,
      gatewayType: 'YOOKASSA',
      createdAt: new Date(Date.now() - (30 - i) * DAY_MS),
    });
  }
  return makeDb({
    users: [makeUser('u-referred', REFERRED_TG), makeUser('u-referrer', REFERRER_TG)],
    transactions,
  });
}

/** `POST /admin/users/:telegramId/referral/attach` — the user card's referral panel. */
function attachViaUserCard(db: Db) {
  return buildUserCard(db).attachReferrer(
    String(REFERRED_TG),
    { referrerTelegramId: String(REFERRER_TG) },
    ADMIN,
    REQ,
  );
}

/**
 * `POST /admin/users/:telegramId/partner/attach-referral` — the user card's
 * partner panel. Addressed from the other end: the path names the REFERRER.
 */
function attachViaPartnerPanel(db: Db) {
  return buildUserCard(db).attachPartnerReferral(
    String(REFERRER_TG),
    { referralIdentifier: String(REFERRED_TG) },
    ADMIN,
    REQ,
  );
}

/** `POST /admin/referrals/manual-attach` — the Referrals page, cuid-addressed. */
function attachViaReferralsTabCuid(db: Db) {
  return buildReferralsTab(db).manualAttach(
    { userId: 'u-referred', referrerId: 'u-referrer' },
    ADMIN,
    REQ,
  );
}

/** `POST /admin/referrals/attach` — what the Referrals page's dialog posts. */
function attachViaReferralsTabDialog(db: Db) {
  return buildReferralsTab(db).attach(
    { referredTelegramId: String(REFERRED_TG), referrerTelegramId: String(REFERRER_TG) },
    ADMIN,
    REQ,
  );
}

/** Every operator entry point, with the `source` each one is expected to record. */
const SURFACES = [
  ['user card · referral panel', attachViaUserCard, 'user_detail'],
  ['user card · partner panel', attachViaPartnerPanel, 'user_detail_partner'],
  ['referrals page · manual-attach', attachViaReferralsTabCuid, 'referrals_tab'],
  ['referrals page · attach dialog', attachViaReferralsTabDialog, 'referrals_tab'],
] as const;

function auditRow(db: Db, index = 0): Record<string, unknown> {
  const row = db.state.auditLogs[index];
  assert.ok(row, `expected an audit row at index ${index}`);
  return row;
}

function auditMetadata(db: Db, index = 0): Record<string, unknown> {
  return auditRow(db, index)['metadata'] as Record<string, unknown>;
}

function withoutSource(metadata: Record<string, unknown>): Record<string, unknown> {
  const { source: _source, ...rest } = metadata;
  return rest;
}

/** The `REFERRAL_MANUAL_ATTACHED` events — the operator record in the event stream. */
function manualAttachEvents(db: Db): EmittedEvent[] {
  return db.emitted.filter((event) => event.type === 'referral.manual_attached');
}

describe('referral attach — the fake records audit rows and events (control)', () => {
  // Without this, every "no audit row was written" and "no event was emitted"
  // assertion below could pass simply because nothing in this fake is capable
  // of recording either.
  it('an attach DOES produce an audit row, a referral row and two events through this fake', async () => {
    const db = seed();

    await attachViaUserCard(db);

    assert.equal(db.state.auditLogs.length, 1);
    assert.equal(auditRow(db)['action'], 'user.referral.attached');
    assert.deepEqual(auditRow(db)['adminUser'], { connect: { id: 'admin-1' } });
    assert.equal(db.state.referrals.length, 1);
    assert.equal(db.state.referrals[0]?.referrerId, 'u-referrer');
    assert.equal(db.state.referrals[0]?.referredId, 'u-referred');
    assert.deepEqual(
      db.emitted.map((event) => event.type),
      ['referral.attached', 'referral.manual_attached'],
    );
  });
});

describe('all four attach surfaces leave the same trail', () => {
  it('writes ONE audit action, differing only in metadata.source', async () => {
    const rows: Array<{ label: string; row: Record<string, unknown>; source: string }> = [];

    for (const [label, run, expectedSource] of SURFACES) {
      const db = seed();
      await run(db);

      assert.equal(db.state.auditLogs.length, 1, `${label}: exactly one audit row`);
      assert.equal(
        auditRow(db)['action'],
        'user.referral.attached',
        `${label}: one action name for one act`,
      );
      assert.equal(
        auditMetadata(db)['source'],
        expectedSource,
        `${label}: the origin is metadata, not part of the action name`,
      );
      rows.push({ label, row: auditRow(db), source: expectedSource });
    }

    // Same row shape everywhere, and the same values but the origin.
    const reference = rows[0];
    for (const { label, row } of rows.slice(1)) {
      assert.deepEqual(
        Object.keys(row).sort(),
        Object.keys(reference.row).sort(),
        `${label}: same audit row columns`,
      );
      assert.deepEqual(
        Object.keys(row['metadata'] as Record<string, unknown>).sort(),
        Object.keys(reference.row['metadata'] as Record<string, unknown>).sort(),
        `${label}: same metadata keys`,
      );
      assert.deepEqual(
        withoutSource(row['metadata'] as Record<string, unknown>),
        withoutSource(reference.row['metadata'] as Record<string, unknown>),
        `${label}: same values but the origin`,
      );
    }

    // The exact `data` handed to the database, for one surface, spelled out.
    assert.deepEqual(reference.row, {
      action: 'user.referral.attached',
      ipAddress: '10.0.0.7',
      userAgent: 'panel/1.0',
      metadata: {
        requestId: 'req-9',
        source: 'user_detail',
        userId: 'u-referred',
        referrerId: 'u-referrer',
        referralId: 'ref-1',
        partnerChainAttached: true,
        historicalPaymentsProcessed: 0,
        replayFailed: false,
      },
      adminUser: { connect: { id: 'admin-1' } },
    });
  });

  it('emits the same system event from every surface, carrying no source', async () => {
    const events: Array<{ label: string; event: EmittedEvent }> = [];

    for (const [label, run] of SURFACES) {
      const db = seed();
      await run(db);

      const manual = manualAttachEvents(db);
      assert.equal(manual.length, 1, `${label}: exactly one manual-attach event`);
      assert.equal(
        'source' in manual[0].metadata,
        false,
        `${label}: the event states the same fact whichever screen produced it`,
      );
      events.push({ label, event: manual[0] });
    }

    for (const { label, event } of events.slice(1)) {
      assert.deepEqual(event, events[0].event, `${label}: same operator act, same system event`);
    }

    assert.deepEqual(events[0].event, {
      type: 'referral.manual_attached',
      category: 'REFERRAL',
      message: 'Referrer manually attached',
      metadata: {
        userId: 'u-referred',
        referredUserId: 'u-referred',
        referrerId: 'u-referrer',
        referralId: 'ref-1',
        partnerChainAttached: true,
        historicalPaymentsProcessed: 0,
        replayFailed: false,
        adminId: 'admin-1',
      },
    });
  });

  it('names the operator on every surface, including the two that had no actor parameter', async () => {
    for (const [label, run] of SURFACES) {
      const db = seed();
      await run(db);

      assert.deepEqual(
        auditRow(db)['adminUser'],
        { connect: { id: 'admin-1' } },
        `${label}: the row names who did it`,
      );
      assert.equal(auditRow(db)['ipAddress'], '10.0.0.7', `${label}: and from where`);
      assert.equal(auditRow(db)['userAgent'], 'panel/1.0', `${label}: and with what`);
      assert.equal(auditMetadata(db)['requestId'], 'req-9', `${label}: and under which request`);
    }
  });

  it('never writes the retired user.partner.referral.attached action', async () => {
    const written: unknown[] = [];
    for (const [, run] of SURFACES) {
      const db = seed();
      await run(db);
      written.push(...db.state.auditLogs.map((row) => row['action']));
    }

    assert.deepEqual(written, [
      'user.referral.attached',
      'user.referral.attached',
      'user.referral.attached',
      'user.referral.attached',
    ]);
  });
});

/**
 * The question the fix answers by name: are `referral/attach` and
 * `partner/attach-referral` one act or two?
 *
 * One. They are addressed from opposite ends and gated differently, and the
 * rows they produce are indistinguishable — so they get one action name and
 * stay told apart by `source`.
 */
describe('referral attach and partner referral attach are ONE act', () => {
  it('produce the same referral edge from opposite ends of the same pair', async () => {
    const viaReferralPanel = seed();
    await attachViaUserCard(viaReferralPanel);

    const viaPartnerPanel = seed();
    await attachViaPartnerPanel(viaPartnerPanel);

    // The partner panel names the REFERRER in its path and the REFERRED in its
    // body; the referral panel does the reverse. The edge is the same either way.
    assert.deepEqual(viaPartnerPanel.state.referrals, viaReferralPanel.state.referrals);
    assert.equal(viaReferralPanel.state.referrals[0]?.referrerId, 'u-referrer');
    assert.equal(viaReferralPanel.state.referrals[0]?.referredId, 'u-referred');
  });

  it('share one action name and stay distinguishable by source alone', async () => {
    const viaReferralPanel = seed();
    await attachViaUserCard(viaReferralPanel);

    const viaPartnerPanel = seed();
    await attachViaPartnerPanel(viaPartnerPanel);

    assert.equal(
      auditRow(viaPartnerPanel)['action'],
      auditRow(viaReferralPanel)['action'],
      'one act, one name — a reader must not have to union a second action',
    );
    assert.equal(auditMetadata(viaReferralPanel)['source'], 'user_detail');
    assert.equal(
      auditMetadata(viaPartnerPanel)['source'],
      'user_detail_partner',
      'the only route of the four gated on partners:edit stays identifiable',
    );
    assert.notEqual(
      auditMetadata(viaPartnerPanel)['source'],
      auditMetadata(viaReferralPanel)['source'],
    );
  });

  it('records the referred user under userId, not the partner under partnerId', async () => {
    // The retired `user.partner.referral.attached` row carried `partnerId:
    // partnerUser.id` — a USER id under a key naming a `Partner`. Both surfaces
    // now name the two ends of the edge and nothing else.
    const db = seed();
    await attachViaPartnerPanel(db);

    assert.equal(auditMetadata(db)['userId'], 'u-referred');
    assert.equal(auditMetadata(db)['referrerId'], 'u-referrer');
    assert.equal('partnerId' in auditMetadata(db), false);
    assert.equal('identifier' in auditMetadata(db), false);
  });
});

describe('the record follows the money', () => {
  it('carries the number of payments replayed through the new graph', async () => {
    for (const [label, run] of SURFACES) {
      const db = seed(3);
      await run(db);

      assert.equal(db.replayed.length, 3, `${label}: three completed payments were replayed`);
      assert.equal(
        auditMetadata(db)['historicalPaymentsProcessed'],
        3,
        `${label}: and the audit row says so`,
      );
      assert.equal(
        manualAttachEvents(db)[0]?.metadata['historicalPaymentsProcessed'],
        3,
        `${label}: as does the event`,
      );
    }
  });

  it('keeps the operator record when the replay dies halfway, and still throws', async () => {
    // The graph has already changed by the time the replay starts. A throw here
    // used to leave a rewritten graph, partner earnings credited for however
    // many transactions got through, and nothing at all naming the operator.
    const db = seed(3);
    db.failures.earningAfter = 1;

    await assert.rejects(() => attachViaReferralsTabDialog(db), /partner earning refused/);

    assert.equal(db.replayed.length, 1, 'money moved for one transaction before the failure');
    assert.equal(db.state.referrals.length, 1, 'and the edge exists');
    assert.equal(db.state.auditLogs.length, 1, 'so the operator record must exist too');
    assert.equal(auditMetadata(db)['historicalPaymentsProcessed'], 1);
    assert.equal(auditMetadata(db)['replayFailed'], true);
    assert.equal(auditMetadata(db)['source'], 'referrals_tab');
    assert.equal(manualAttachEvents(db)[0]?.metadata['replayFailed'], true);
  });
});

/**
 * The same service is reached by two paths that NOBODY performed — a `?ref=`
 * web sign-up and a `t.me/…?start=ref_` bot deep-link. `operator` is required
 * so the compiler names every call site, and nullable so those two can say
 * "there is no operator" out loud instead of by omission.
 */
describe('an organic attach has no operator, and records none', () => {
  it('creates the edge and emits referral.attached, but writes no audit row', async () => {
    const db = seed(2);

    const result = await makeAttachService(db).attachReferrerManually({
      userId: 'u-referred',
      referrerId: 'u-referrer',
      inviteSource: 'WEB' as never,
      operator: null,
    });

    assert.equal(result.referralCreated, true);
    assert.equal(result.historicalPaymentsProcessed, 2);
    assert.equal(db.state.referrals.length, 1, 'the edge is created either way');
    assert.deepEqual(db.state.auditLogs, [], 'nobody performed it, so nobody is recorded');
    assert.deepEqual(
      db.emitted.map((event) => event.type),
      ['referral.attached'],
      'the creation is still observable; only the operator record is absent',
    );
  });
});

describe('the refusals still refuse, and leave nothing behind', () => {
  it('refuses a second attach for a user who already has one, on every surface', async () => {
    for (const [label, run] of SURFACES) {
      const db = seed();
      await run(db);
      assert.equal(db.state.auditLogs.length, 1, `${label}: the first attach recorded`);

      await assert.rejects(() => run(db), BadRequestException, `${label}: the second is refused`);

      assert.equal(db.state.auditLogs.length, 1, `${label}: and records nothing extra`);
      assert.equal(db.state.referrals.length, 1, `${label}: and creates no second edge`);
      assert.equal(manualAttachEvents(db).length, 1, `${label}: and emits no second event`);
    }
  });

  it('refuses self-attachment without touching the log', async () => {
    const db = seed();

    await assert.rejects(
      () =>
        buildReferralsTab(db).manualAttach(
          { userId: 'u-referred', referrerId: 'u-referred' },
          ADMIN,
          REQ,
        ),
      BadRequestException,
    );

    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.state.referrals, []);
    assert.deepEqual(db.emitted, []);
  });

  it('404s on an unknown user without touching the log', async () => {
    const db = seed();

    await assert.rejects(
      () =>
        buildReferralsTab(db).manualAttach(
          { userId: 'u-nobody', referrerId: 'u-referrer' },
          ADMIN,
          REQ,
        ),
      NotFoundException,
    );

    assert.deepEqual(db.state.auditLogs, []);
    assert.deepEqual(db.emitted, []);
  });
});
