import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AdminPartnersController } from '../src/modules/partners/controllers/admin-partners.controller';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { PartnerEarningsService } from '../src/modules/partners/services/partner-earnings.service';
import { PartnersService } from '../src/modules/partners/services/partners.service';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';

/**
 * Partner activation, across both surfaces that can perform it.
 *
 * Two rules are pinned here.
 *
 * 1. Partner earnings count ONLY from the moment of activation. People the
 *    partner invited before that must never acquire a `PartnerReferral` edge —
 *    not retroactively and not for their future payments either. Activation
 *    used to walk the partner's `Referral` graph and mint one edge per
 *    pre-activation invitee.
 *
 * 2. The Partners tab (`POST /admin/partners/:partnerId/toggle`) and the
 *    user-detail panel (`POST /admin/users/:telegramId/partner/toggle`,
 *    `POST /admin/users/:telegramId/create-partner`) are the same operator act
 *    and must leave the same trail. They used to disagree: only the Partners
 *    tab emitted an activation event at all.
 *
 * Everything here runs the REAL services against a fake Prisma that holds rows,
 * and asserts on the rows. A double that only records calls cannot tell
 * "nothing was written" from "the writer was never wired up" — so the first
 * test is a control proving this fake does record a write when one happens.
 *
 * Dates are relative. An absolute fixture date in this repo was live when
 * written and silently became an expired-subscription assertion months later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const NULL_NOTIFICATIONS = {
  notifyEarning: async () => undefined,
  notifyWithdrawalApproved: async () => undefined,
  notifyWithdrawalRejected: async () => undefined,
};

const ADMIN = { id: 'admin-1' } as never;
const REQ = { headers: {}, ip: null, socket: { remoteAddress: null } } as never;

interface UserRow {
  id: string;
  telegramId: bigint;
  name: string;
  username: string;
  createdAt: Date;
}

interface PartnerRow {
  id: string;
  userId: string;
  balance: number;
  totalEarned: number;
  totalWithdrawn: number;
  isActive: boolean;
  useGlobalSettings: boolean;
  accrualStrategy: string;
  rewardType: string;
  level1Percent: null;
  level2Percent: null;
  level3Percent: null;
  level1FixedAmount: null;
  level2FixedAmount: null;
  level3FixedAmount: null;
  createdAt: Date;
  updatedAt: Date;
}

interface EdgeRow {
  id: string;
  partnerId: string;
  referralUserId: string;
  level: number;
  parentPartnerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface EmittedEvent {
  type: string;
  category: string;
  message: string;
  metadata: unknown;
}

/** The plain `Partner` columns, in schema order — the user-detail response shape. */
const PARTNER_SCALAR_KEYS = [
  'id',
  'userId',
  'balance',
  'totalEarned',
  'totalWithdrawn',
  'isActive',
  'useGlobalSettings',
  'accrualStrategy',
  'rewardType',
  'level1Percent',
  'level2Percent',
  'level3Percent',
  'level1FixedAmount',
  'level2FixedAmount',
  'level3FixedAmount',
  'createdAt',
  'updatedAt',
];

function makeUser(id: string, telegramId: bigint): UserRow {
  return {
    id,
    telegramId,
    name: id,
    username: id,
    createdAt: new Date(Date.now() - 90 * DAY_MS),
  };
}

function makePartnerRow(id: string, userId: string, isActive: boolean): PartnerRow {
  const bornAt = new Date(Date.now() - 60 * DAY_MS);
  return {
    id,
    userId,
    balance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    isActive,
    useGlobalSettings: true,
    accrualStrategy: 'ON_EACH_PAYMENT',
    rewardType: 'PERCENT',
    level1Percent: null,
    level2Percent: null,
    level3Percent: null,
    level1FixedAmount: null,
    level2FixedAmount: null,
    level3FixedAmount: null,
    createdAt: bornAt,
    updatedAt: bornAt,
  };
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
 * Fake Prisma holding real rows. Every delegate the activation, signup and
 * (removed) backfill paths could reach is implemented — including
 * `referral.findMany` and `partnerReferral.create` — so restoring a backfill
 * would produce visible rows rather than a TypeError.
 */
function makeDb(seed: {
  users?: UserRow[];
  partners?: PartnerRow[];
  referrals?: Array<{ referrerId: string; referredId: string }>;
  edges?: EdgeRow[];
}) {
  const users = [...(seed.users ?? [])];
  const partners = [...(seed.partners ?? [])];
  const referrals = [...(seed.referrals ?? [])];
  const partnerReferrals = [...(seed.edges ?? [])];
  const auditLogs: Array<Record<string, unknown>> = [];
  let nextId = 1;

  function decoratePartner(row: PartnerRow, args: { include?: Record<string, unknown>; select?: Record<string, unknown> }): unknown {
    if (args.select) return project(row as unknown as Record<string, unknown>, args.select);
    const base: Record<string, unknown> = { ...row };
    if (args.include?.['user']) {
      const user = users.find((u) => u.id === row.userId);
      base['user'] = user
        ? { id: user.id, name: user.name, username: user.username, telegramId: user.telegramId, createdAt: user.createdAt }
        : null;
    }
    if (args.include?.['_count']) {
      base['_count'] = { referrals: partnerReferrals.filter((e) => e.partnerId === row.id).length };
    }
    return base;
  }

  const client = {
    user: {
      findFirst: async (args: { where: { telegramId?: bigint } }) =>
        users.find((u) => u.telegramId === args.where.telegramId) ?? null,
      findUnique: async (args: { where: { id?: string } }) =>
        users.find((u) => u.id === args.where.id) ?? null,
    },
    partner: {
      findUnique: async (args: {
        where: { id?: string; userId?: string };
        include?: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        const row = partners.find((p) =>
          args.where.id !== undefined ? p.id === args.where.id : p.userId === args.where.userId,
        );
        return row ? decoratePartner(row, args) : null;
      },
      update: async (args: {
        where: { id: string };
        data: { isActive: boolean };
        include?: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        const row = partners.find((p) => p.id === args.where.id);
        if (!row) throw new Error('fake prisma: partner.update on a missing row');
        row.isActive = args.data.isActive;
        return decoratePartner(row, args);
      },
      create: async (args: { data: { userId: string; isActive: boolean } }) => {
        const row = makePartnerRow(`partner-${nextId++}`, args.data.userId, args.data.isActive);
        partners.push(row);
        return { ...row };
      },
    },
    referral: {
      findMany: async (args: { where: { referrerId: string }; select?: Record<string, unknown> }) =>
        referrals
          .filter((r) => r.referrerId === args.where.referrerId)
          .map((r) => project(r as unknown as Record<string, unknown>, args.select)),
    },
    partnerReferral: {
      findFirst: async (args: { where: { referralUserId: string; level?: number } }) => {
        const edge = partnerReferrals.find(
          (e) =>
            e.referralUserId === args.where.referralUserId &&
            (args.where.level === undefined || e.level === args.where.level),
        );
        if (!edge) return null;
        const partner = partners.find((p) => p.id === edge.partnerId) ?? null;
        return { ...edge, partner: partner ? { ...partner } : null };
      },
      findUnique: async (args: {
        where: { partnerId_referralUserId: { partnerId: string; referralUserId: string } };
      }) => {
        const key = args.where.partnerId_referralUserId;
        return (
          partnerReferrals.find(
            (e) => e.partnerId === key.partnerId && e.referralUserId === key.referralUserId,
          ) ?? null
        );
      },
      create: async (args: {
        data: { partnerId: string; referralUserId: string; level: number; parentPartnerId: string | null };
      }) => {
        const now = new Date();
        const edge: EdgeRow = {
          id: `edge-${nextId++}`,
          partnerId: args.data.partnerId,
          referralUserId: args.data.referralUserId,
          level: args.data.level,
          parentPartnerId: args.data.parentPartnerId ?? null,
          createdAt: now,
          updatedAt: now,
        };
        partnerReferrals.push(edge);
        return { ...edge };
      },
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
    info: (type: string, category: string, message: string, metadata: unknown) =>
      emitted.push({ type, category, message, metadata }),
    warn: (type: string, category: string, message: string, metadata: unknown) =>
      emitted.push({ type, category, message, metadata }),
    error: () => undefined,
  };

  return { client, events, emitted, state: { users, partners, referrals, partnerReferrals, auditLogs } };
}

function buildPartnersTab(db: ReturnType<typeof makeDb>) {
  const partnersService = new PartnersService(db.client as never, db.events as never, NULL_NOTIFICATIONS as never);
  return new AdminPartnersController(partnersService, {} as never, {} as never, {} as never);
}

function buildUserPanel(db: ReturnType<typeof makeDb>) {
  const partnersService = new PartnersService(db.client as never, db.events as never, NULL_NOTIFICATIONS as never);
  return new AdminUserManagementController(
    db.client as never,
    db.events as never,
    {} as never, // PartnerEarningsService
    {} as never, // ReferralManualAttachService
    {} as never, // ReferralQualificationService
    {} as never, // StealthnetReferralSyncService
    {} as never, // ReferralInviteLimitsService
    {} as never, // RemnawaveApiService
    {} as never, // UserNotificationsService
    {} as never, // RbacService
    {} as never, // UserDeletionService
    partnersService,
    {} as never, // PlansAdminService
    undefined as never,
    { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
    new PointsWalletService(),
    { listForUser: async () => ({ items: [], nextCursor: null }) } as never,
  );
}

/** A partner who invited two people BEFORE ever being activated. */
function seedDormantPartnerWithPriorInvitees() {
  return makeDb({
    users: [makeUser('u-partner', 1000n), makeUser('u-early-a', 1001n), makeUser('u-early-b', 1002n)],
    partners: [makePartnerRow('p1', 'u-partner', false)],
    referrals: [
      { referrerId: 'u-partner', referredId: 'u-early-a' },
      { referrerId: 'u-partner', referredId: 'u-early-b' },
    ],
  });
}

describe('partner activation — the fake records writes (control)', () => {
  // Without this, every "no edges were written" assertion below could pass
  // simply because nothing in the fake is capable of writing an edge.
  it('the signup path DOES write a PartnerReferral row through this fake', async () => {
    const db = makeDb({
      users: [makeUser('u-partner', 1000n), makeUser('u-newbie', 1003n)],
      partners: [makePartnerRow('p1', 'u-partner', true)],
    });
    const earnings = new PartnerEarningsService(db.client as never, db.events as never, NULL_NOTIFICATIONS as never);

    const attached = await earnings.attachPartnerReferralChain({
      newUserId: 'u-newbie',
      referrerUserId: 'u-partner',
    });

    assert.equal(attached, true);
    assert.equal(db.state.partnerReferrals.length, 1);
    assert.equal(db.state.partnerReferrals[0]?.partnerId, 'p1');
    assert.equal(db.state.partnerReferrals[0]?.referralUserId, 'u-newbie');
    assert.equal(db.state.partnerReferrals[0]?.level, 1);
  });
});

describe('partner activation counts only from activation', () => {
  it('Partners tab: activation writes no edge for anyone invited beforehand', async () => {
    const db = seedDormantPartnerWithPriorInvitees();

    const result = await buildPartnersTab(db).toggle('p1');

    assert.equal(result.isActive, true);
    assert.equal(db.state.partners[0]?.isActive, true);
    assert.deepEqual(
      db.state.partnerReferrals,
      [],
      'the two people invited before activation must not earn for this partner',
    );
  });

  it('user-detail panel: activation writes no edge for anyone invited beforehand', async () => {
    const db = seedDormantPartnerWithPriorInvitees();

    const result = (await buildUserPanel(db).togglePartner('1000')) as { isActive: boolean };

    assert.equal(result.isActive, true);
    assert.equal(db.state.partners[0]?.isActive, true);
    assert.deepEqual(db.state.partnerReferrals, []);
  });

  it('minting an already-active partner writes no edge for anyone invited beforehand', async () => {
    const db = makeDb({
      users: [makeUser('u-fresh', 2000n), makeUser('u-early', 2001n)],
      referrals: [{ referrerId: 'u-fresh', referredId: 'u-early' }],
    });

    await buildUserPanel(db).createPartner('2000', ADMIN, REQ);

    assert.equal(db.state.partners.length, 1);
    assert.equal(db.state.partners[0]?.isActive, true);
    assert.deepEqual(db.state.partnerReferrals, []);
  });
});

describe('the two activation surfaces agree', () => {
  it('emit the same activation event and leave the same rows', async () => {
    const viaTab = seedDormantPartnerWithPriorInvitees();
    await buildPartnersTab(viaTab).toggle('p1');

    const viaPanel = seedDormantPartnerWithPriorInvitees();
    await buildUserPanel(viaPanel).togglePartner('1000');

    assert.deepEqual(viaPanel.emitted, viaTab.emitted, 'same operator act, same audit trail');
    assert.deepEqual(viaTab.emitted, [
      {
        type: 'partner.activated',
        category: 'PARTNER',
        message: 'Partner activated',
        metadata: { partnerId: 'p1', userId: 'u-partner' },
      },
    ]);
    assert.deepEqual(
      viaPanel.state.partners.map((p) => ({ id: p.id, userId: p.userId, isActive: p.isActive })),
      viaTab.state.partners.map((p) => ({ id: p.id, userId: p.userId, isActive: p.isActive })),
    );
    assert.deepEqual(viaPanel.state.partnerReferrals, viaTab.state.partnerReferrals);
  });

  it('deactivation agrees too', async () => {
    const viaTab = makeDb({
      users: [makeUser('u-partner', 1000n)],
      partners: [makePartnerRow('p1', 'u-partner', true)],
    });
    await buildPartnersTab(viaTab).toggle('p1');

    const viaPanel = makeDb({
      users: [makeUser('u-partner', 1000n)],
      partners: [makePartnerRow('p1', 'u-partner', true)],
    });
    await buildUserPanel(viaPanel).togglePartner('1000');

    assert.deepEqual(viaPanel.emitted, viaTab.emitted);
    assert.equal(viaTab.emitted[0]?.type, 'partner.deactivated');
    assert.equal(viaPanel.state.partners[0]?.isActive, false);
  });

  // A partner created active IS activated. Before, this surface emitted only
  // `partner.created`, so "when did this partner start earning?" had no answer
  // when the operator used the user-detail panel.
  it('creating an active partner emits the same activation event as toggling one', async () => {
    const viaTab = seedDormantPartnerWithPriorInvitees();
    await buildPartnersTab(viaTab).toggle('p1');
    const toggleActivation = viaTab.emitted.find((e) => e.type === 'partner.activated');

    const db = makeDb({ users: [makeUser('u-fresh', 2000n)] });
    await buildUserPanel(db).createPartner('2000', ADMIN, REQ);
    const createActivation = db.emitted.find((e) => e.type === 'partner.activated');

    assert.ok(createActivation, 'create-partner must report the activation it performs');
    assert.equal(createActivation?.type, toggleActivation?.type);
    assert.equal(createActivation?.category, toggleActivation?.category);
    assert.equal(createActivation?.message, toggleActivation?.message);
    assert.deepEqual(Object.keys(createActivation?.metadata as object).sort(), ['partnerId', 'userId']);
    assert.deepEqual(createActivation?.metadata, {
      partnerId: db.state.partners[0]?.id,
      userId: 'u-fresh',
    });

    // The pre-existing `partner.created` event and the admin audit row survive.
    assert.equal(db.emitted.filter((e) => e.type === 'partner.created').length, 1);
    assert.deepEqual(
      db.state.auditLogs.map((row) => row['action']),
      ['user.partner.created'],
    );
  });
});

describe('HTTP contracts are unchanged', () => {
  it('user-detail create-partner returns the bare Partner row', async () => {
    const db = makeDb({ users: [makeUser('u-fresh', 2000n)] });

    const body = (await buildUserPanel(db).createPartner('2000', ADMIN, REQ)) as Record<string, unknown>;

    assert.deepEqual(Object.keys(body).sort(), [...PARTNER_SCALAR_KEYS].sort());
    assert.equal('user' in body, false);
    assert.equal('_count' in body, false);
  });

  it('user-detail partner/toggle returns the bare Partner row, relations stripped', async () => {
    const db = seedDormantPartnerWithPriorInvitees();

    const body = (await buildUserPanel(db).togglePartner('1000')) as Record<string, unknown>;

    assert.deepEqual(Object.keys(body).sort(), [...PARTNER_SCALAR_KEYS].sort());
    assert.equal(body['isActive'], true);
  });

  it('Partners tab toggle still returns the mapped PartnerInterface', async () => {
    const db = seedDormantPartnerWithPriorInvitees();

    const body = await buildPartnersTab(db).toggle('p1');

    assert.equal(body.id, 'p1');
    assert.equal(body.referralsCount, 0);
    assert.equal(body.user.telegramId, '1000');
    assert.equal(typeof body.createdAt, 'string');
  });

  it('user-detail partner/toggle still 404s when the user has no partner', async () => {
    const db = makeDb({ users: [makeUser('u-nopartner', 3000n)] });

    await assert.rejects(() => buildUserPanel(db).togglePartner('3000'), NotFoundException);
  });

  it('user-detail create-partner still 400s when a partner already exists', async () => {
    const db = makeDb({
      users: [makeUser('u-partner', 1000n)],
      partners: [makePartnerRow('p1', 'u-partner', true)],
    });

    await assert.rejects(() => buildUserPanel(db).createPartner('1000', ADMIN, REQ), BadRequestException);
    assert.equal(db.state.partners.length, 1);
  });

  it('Partners tab toggle still 404s on an unknown partner id', async () => {
    const db = makeDb({});

    await assert.rejects(() => buildPartnersTab(db).toggle('nope'), NotFoundException);
  });
});
