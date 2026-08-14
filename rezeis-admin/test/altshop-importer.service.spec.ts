import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ImportRecord,
  Partner,
  PartnerReferral,
  PartnerTransaction,
  Prisma,
  Referral,
  ReferralReward,
  Subscription,
  Transaction,
  TrialClaim,
  User,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AltshopImporterService } from '../src/modules/imports/services/altshop-importer.service';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import {
  RemnawaveApiService,
  type RemnawavePanelUser,
} from '../src/modules/remnawave/services/remnawave-api.service';

describe('AltshopImporterService', () => {
  it('does not rebind an existing subscription owned by another user', async () => {
    const updates: Prisma.SubscriptionUpdateArgs[] = [];
    const summaries: ImportSummary[] = [];
    const service = createService({
      user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
      subscription: {
        findFirst: async () => ({ id: 'subscription-1', userId: 'user-other', planSnapshot: {} }),
        update: async (value: Prisma.SubscriptionUpdateArgs) => updates.push(value),
      },
      importRecord: { create: async (input: ImportRecordCreate) => {
        summaries.push(input.data.result);
        return { id: 'import-1' };
      } },
    });
    await service.run({ mode: 'import', createdBy: null, users: [user(1)], subscriptions: [subscription(1)] });
    assert.deepEqual(updates, []);
    assert.equal(summaries[0].conflicts.subscriptionOwnerMismatch, 1);
  });

  it('preserves a target plan selected after an earlier import', async () => {
    const updates: SubscriptionPlanSnapshotUpdate[] = [];
    const service = createService({
      user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
      subscription: {
        findFirst: async () => ({ id: 'subscription-1', userId: 'user-1', planSnapshot: { planId: 'target-plan' } }),
        update: async (value: SubscriptionPlanSnapshotUpdate) => updates.push(value),
      },
      importRecord: { create: async () => ({ id: 'import-1' }) },
    });
    await service.run({ mode: 'import', createdBy: null, users: [user(1)], subscriptions: [subscription(1)] });
    assert.equal(updates[0].data.planSnapshot.planId, 'target-plan');
  });

  it('rejects a donor subscription when its live Remnawave owner differs', async () => {
    const summaries: ImportSummary[] = [];
    const service = createService(
      {
        user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
        subscription: { findFirst: async () => null, create: async () => ({ id: 'sub-1' }) },
        importRecord: { create: async (input: ImportRecordCreate) => {
          summaries.push(input.data.result);
          return { id: 'import-1' };
        } },
      },
      panelReader([panelUser({ uuid: subscription(1).user_remna_id, telegramId: 2 })]),
    );
    await service.run({ mode: 'import', createdBy: null, users: [user(1)], subscriptions: [subscription(1)] });
    assert.equal(summaries[0].conflicts.panelOwnerMismatch, 1);
  });

  it('preserves an unavailable donor trial marker across import retries', async () => {
    const claims: Prisma.TrialClaimUpsertArgs[] = [];
    let consumedClaimExists = false;
    const service = createService({
      user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
      subscription: { findFirst: async () => null },
      importRecord: { create: async () => ({ id: 'import-1' }) },
      $transaction: async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(
          trialClaimTx({
            $queryRaw: async () => [{ id: 'user-1' }],
            trialClaim: {
              findFirst: async () => (consumedClaimExists ? { id: 'existing-claim' } : null),
              upsert: async (input: Prisma.TrialClaimUpsertArgs) => {
                claims.push(input);
                consumedClaimExists = true;
              },
            },
          }),
        ),
    });

    const input = { mode: 'import' as const, createdBy: null, users: [user(1, false)], subscriptions: [] };
    await service.run(input);
    await service.run(input);

    assert.equal(claims.length, 1);
    assert.deepEqual(claims[0]?.create, {
      id: 'legacy-trial-unavailable:user-1',
      userId: 'user-1',
      planId: null,
      source: 'LEGACY',
      status: 'CONSUMED',
      units: 1,
      consumedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('imports payment and referral history without reissuing customer effects', async () => {
    const transactions: Prisma.TransactionCreateArgs[] = [];
    const rewards: Prisma.ReferralRewardCreateArgs[] = [];
    const summaries: ImportSummary[] = [];
    const users = new Map<bigint, string>([[1n, 'referrer'], [2n, 'referred']]);
    const service = createService({
      user: {
        // A user Prisma cannot find comes back as `null`, never as a row whose
        // `id` is undefined — the shape the importer would happily treat as found.
        findUnique: async (input: UserByTelegramId) => {
          const id = users.get(input.where.telegramId);
          return id === undefined ? null : { id };
        },
        update: async () => undefined,
      },
      subscription: { findFirst: async () => null },
      transaction: {
        findUnique: async () => null,
        create: async (input: Prisma.TransactionCreateArgs) => {
          transactions.push(input);
          return { id: 'tx-7' };
        },
      },
      referral: {
        findUnique: async () => null,
        create: async () => ({ id: 'referral-1', referrerId: 'referrer' }),
      },
      partnerReferral: { findFirst: async () => null },
      referralReward: {
        findUnique: async () => null,
        create: async (input: Prisma.ReferralRewardCreateArgs) => rewards.push(input),
      },
      importRecord: { create: async (input: ImportRecordCreate) => {
        summaries.push(input.data.result);
        return { id: 'import-2' };
      } },
    });
    await service.run({
      mode: 'import', createdBy: null, users: [user(1), user(2)], subscriptions: [],
      transactions: [{ id: 7, payment_id: 'provider-id', user_telegram_id: 2, status: 'COMPLETED', purchase_type: 'ADDITIONAL', gateway_type: 'PLATEGA', pricing: { final_amount: 100 }, currency: 'RUB', channel: 'WEB', created_at: '2026-01-01T00:00:00.000Z', plan_snapshot: null }],
      referrals: [{ id: 3, referrer_telegram_id: 1, referred_telegram_id: 2, level: 1, invite_source: 'BOT', created_at: '2026-01-01T00:00:00.000Z' }],
      referralRewards: [{ id: 4, referral_id: 3, user_telegram_id: 1, type: 'POINTS', amount: 20, is_issued: true, created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.equal(transactions[0].data.paymentId, 'altshop:7');
    assert.equal(transactions[0].data.gatewayId, undefined);
    assert.equal(rewards.length, 1);
    assert.equal(summaries[0].transactionsCreated, 1);
    assert.equal(summaries[0].referralsCreated, 1);
    assert.equal(summaries[0].referralRewardsCreated, 1);
  });

  it('preserves partner attribution instead of also creating a direct referral', async () => {
    const created: Prisma.ReferralCreateArgs[] = [];
    const summaries: ImportSummary[] = [];
    const service = createService({
      user: {
        findUnique: async (input: UserByTelegramId) => ({ id: input.where.telegramId === 1n ? 'partner' : 'referred' }),
        update: async () => undefined,
      },
      subscription: { findFirst: async () => null },
      referral: {
        findUnique: async () => null,
        create: async (row: Prisma.ReferralCreateArgs) => {
          created.push(row);
          return { id: 'referral-unexpected', referrerId: 'partner' };
        },
      },
      partnerReferral: { findFirst: async () => null },
      importRecord: { create: async (input: ImportRecordCreate) => {
        summaries.push(input.data.result);
        return { id: 'import-5' };
      } },
    });
    await service.run({
      mode: 'import', createdBy: null, users: [user(1), user(2)], subscriptions: [],
      referrals: [{ id: 1, referrer_telegram_id: 1, referred_telegram_id: 2, level: 1, created_at: '2026-01-01T00:00:00.000Z' }],
      partnerReferrals: [{ id: 5, partner_id: 99, parent_partner_id: null, referral_telegram_id: 2, level: 1, created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.deepEqual(created, []);
    assert.equal(summaries[0].conflicts.partnerAttribution, 1);
  });

  it('uses source keys so a partner ledger retry cannot duplicate history', async () => {
    const partnerTransactions: Prisma.PartnerTransactionCreateArgs[] = [];
    const service = createService({
      user: { findUnique: async () => ({ id: 'partner-user' }), update: async () => undefined },
      subscription: { findFirst: async () => null },
      partner: { findUnique: async () => null, create: async () => ({ id: 'partner-1' }) },
      partnerTransaction: {
        findUnique: async () => null,
        create: async (input: Prisma.PartnerTransactionCreateArgs) => partnerTransactions.push(input),
      },
      importRecord: { create: async () => ({ id: 'import-3' }) },
    });
    await service.run({
      mode: 'import', createdBy: null, users: [user(1), user(2)], subscriptions: [],
      partners: [{ id: 10, user_telegram_id: 1, balance: 100, total_earned: 100, total_withdrawn: 0, is_active: true, individual_settings: null, created_at: '2026-01-01T00:00:00.000Z' }],
      partnerTransactions: [{ id: 9, partner_id: 10, referral_telegram_id: 2, level: 1, payment_amount: 100, percent: '10', earned_amount: 10, source_transaction_id: null, description: null, created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.equal(partnerTransactions.length, 1);
    assert.equal(partnerTransactions[0].data.sourceKey, 'altshop:partner-transaction:9');
  });

  it('skips an unresolvable partner ledger row instead of creating a misattributed payout', async () => {
    const created: Prisma.PartnerTransactionCreateArgs[] = [];
    const summaries: ImportSummary[] = [];
    const service = createService({
      user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
      subscription: { findFirst: async () => null },
      partnerTransaction: {
        findUnique: async () => null,
        create: async (row: Prisma.PartnerTransactionCreateArgs) => created.push(row),
      },
      importRecord: { create: async (input: ImportRecordCreate) => {
        summaries.push(input.data.result);
        return { id: 'import-4' };
      } },
    });
    await service.run({
      mode: 'import', createdBy: null, users: [user(1)], subscriptions: [],
      partnerTransactions: [{ id: 5, partner_id: 999, referral_telegram_id: 1, level: 1, payment_amount: 100, percent: '10', earned_amount: 10, source_transaction_id: null, description: null, created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.deepEqual(created, []);
    assert.equal(summaries[0].conflicts.partnerTransactionSkipped, 1);
  });
});

// ─── Stubbed dependencies ───────────────────────────────────────────────────
//
// The two constructor arguments are stubbed differently because the two types
// admit different amounts of checking, and pretending otherwise is what the
// blanket `as never` casts used to hide.
//
// `RemnawaveApiService` is one of ours: `Pick` keeps the member type IDENTICAL
// to the real one, so the stub is checked in full — that is what forced the
// panel list below to carry `complete` and the panel rows to be whole profiles.
//
// `PrismaService` cannot be stubbed that way. It extends the GENERATED
// `PrismaClient`, whose delegates are 16-method interfaces returning the fluent
// `Prisma__UserClient` rather than a `Promise`; no hand-written stand-in is
// assignable to one, and no narrowed signature stays comparable to one either,
// so `as PrismaService` on such a stub does not compile at all. What DOES hold
// is the shape below: `(...args: never[]) => PromiseLike<Row>`. It is the widest
// parameter list that keeps the RETURN side honest, so the compiler still checks
//   • that every delegate name exists on the client,
//   • that every method name exists on that delegate,
//   • that every column a stubbed row claims is a real column of the right type,
// and only the ARGUMENTS go unchecked. The stub bodies therefore annotate their
// own arguments with the generated `Prisma.*Args` types wherever a test reads
// them, which puts that half of the check back where it can still catch a
// renamed column.

/** A stubbed delegate read: Prisma answers with the projected row, or `null`. */
type StubRead<Row> = (...args: never[]) => PromiseLike<Row | null>;
/** A stubbed delegate write whose result the importer does not read. */
type StubWrite = (...args: never[]) => PromiseLike<unknown>;
/** A stubbed delegate write whose result the importer DOES read. */
type StubWriteReturning<Row> = (...args: never[]) => PromiseLike<Row>;

/** Every delegate + method this importer reaches, with its real row shape. */
interface AltshopPrismaSurface {
  readonly user: {
    readonly findUnique: StubRead<Pick<User, 'id'>>;
    readonly update: StubWrite;
  };
  readonly subscription: {
    readonly findFirst: StubRead<Pick<Subscription, 'id' | 'userId' | 'planSnapshot'>>;
    readonly update: StubWrite;
    readonly create: StubWriteReturning<Pick<Subscription, 'id'>>;
  };
  readonly importRecord: {
    readonly create: StubWriteReturning<Pick<ImportRecord, 'id'>>;
  };
  readonly transaction: {
    readonly findUnique: StubRead<Pick<Transaction, 'id'>>;
    readonly create: StubWriteReturning<Pick<Transaction, 'id'>>;
  };
  readonly referral: {
    readonly findUnique: StubRead<Pick<Referral, 'id' | 'referrerId'>>;
    readonly create: StubWriteReturning<Pick<Referral, 'id' | 'referrerId'>>;
  };
  readonly referralReward: {
    readonly findUnique: StubRead<Pick<ReferralReward, 'id'>>;
    readonly create: StubWrite;
  };
  readonly partner: {
    readonly findUnique: StubRead<Pick<Partner, 'id'>>;
    readonly create: StubWriteReturning<Pick<Partner, 'id'>>;
  };
  readonly partnerReferral: {
    readonly findFirst: StubRead<Pick<PartnerReferral, 'id'>>;
  };
  readonly partnerTransaction: {
    readonly findUnique: StubRead<Pick<PartnerTransaction, 'id'>>;
    readonly create: StubWrite;
  };
}

/**
 * A test stubs only the delegates its path reaches; anything else stays absent
 * and fails loudly at run time rather than answering with a silent fake. A
 * misspelled delegate or method is an excess-property error, not a no-op.
 */
type PrismaImporterStub = {
  readonly [Model in keyof AltshopPrismaSurface]?: Partial<AltshopPrismaSurface[Model]>;
} & {
  readonly $transaction?: StubWrite;
};

/** The slice of a transaction client the trial-claim ledger touches. */
interface TrialClaimTxStub {
  /** Prisma's raw escape hatch is typed by its CALLER, so nothing to pin here. */
  readonly $queryRaw: (...args: never[]) => PromiseLike<unknown>;
  readonly trialClaim: {
    readonly findFirst: StubRead<Pick<TrialClaim, 'id'>>;
    readonly upsert: StubWrite;
  };
}

/** Only what the importer reads back out of `strictGetAllPanelUsers`. */
type PanelReaderStub = Pick<RemnawaveApiService, 'strictGetAllPanelUsers'>;

function createService(
  prisma: PrismaImporterStub,
  panel: PanelReaderStub = panelReader(),
): AltshopImporterService {
  return new AltshopImporterService(prisma as PrismaService, panel as RemnawaveApiService);
}

function trialClaimTx(tx: TrialClaimTxStub): Prisma.TransactionClient {
  return tx as Prisma.TransactionClient;
}

/**
 * `complete: true` states what these tests mean: a whole-panel read, not one
 * truncated at the page ceiling. It matters — a truncated list sends every miss
 * through the per-UUID confirmation path, which these stubs deliberately do not
 * answer.
 */
function panelReader(users: readonly RemnawavePanelUser[] = []): PanelReaderStub {
  return {
    strictGetAllPanelUsers: async () => strictOk({ users, total: users.length, complete: true }),
  };
}

/**
 * A panel profile as Remnawave actually serves it. The owner-mismatch check
 * reads `telegramId` and returns before anything else is touched — but it is
 * the FIRST thing on that path, and everything after it projects the whole
 * profile, so a two-field stand-in would let that half run against `undefined`
 * and still report success.
 */
function panelUser(input: { readonly uuid: string; readonly telegramId: number }): RemnawavePanelUser {
  return {
    uuid: input.uuid,
    username: 'donor-user',
    status: 'ACTIVE',
    subscriptionUrl: 'https://panel.example/sub/1',
    telegramId: input.telegramId,
    panelId: 1,
    email: null,
    expireAt: '2026-12-31T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastTrafficResetAt: null,
    trafficLimitBytes: 0,
    hwidDeviceLimit: 1,
    trafficLimitStrategy: null,
    tag: null,
    description: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
  };
}

/**
 * What AltshopImporterService stores in `importRecord.result`: a flat block of
 * counters plus the `conflicts` counter block. Only `conflicts` is named here —
 * the flat counters are read by name and compared as values, so the open index
 * signature is enough for them and does not pretend to pin a shape the service
 * builds inline.
 */
type ImportSummary = Record<string, unknown> & {
  readonly conflicts: Record<string, number>;
};

/**
 * The importer's own `importRecord.create` argument, narrowed to the part these
 * tests read. Prisma types `result` as an opaque JSON input — correct for the
 * client, useless for a test that has to look inside the summary — so the
 * summary shape is named here instead.
 */
type ImportRecordCreate = { readonly data: { readonly result: ImportSummary } };

/** The subscription update these tests inspect: the merged plan snapshot. */
type SubscriptionPlanSnapshotUpdate = {
  readonly data: { readonly planSnapshot: Record<string, unknown> };
};

/** How the importer addresses a donor user row. */
type UserByTelegramId = { readonly where: { readonly telegramId: bigint } };

function user(telegramId: number, isTrialAvailable = true) {
  return { id: telegramId, telegram_id: telegramId, username: null, referral_code: null, name: 'Example', role: 1, language: 'RU', personal_discount: 0, purchase_discount: 0, points: 0, is_blocked: false, is_bot_blocked: false, is_rules_accepted: true, is_trial_available: isTrialAvailable, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
}

function subscription(telegramId: number) {
  return { id: 1, user_remna_id: '11111111-1111-4111-8111-111111111111', user_telegram_id: telegramId, status: 'ACTIVE', is_trial: false, traffic_limit: 0, device_limit: 1, traffic_limit_strategy: null, tag: null, internal_squads: [], external_squad: null, expire_at: null, url: null, plan_snapshot: null, device_type: null, created_at: '2026-01-01T00:00:00.000Z' };
}
