import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ImportStatus,
  type ImportRecord,
  type PartnerReferral,
  type Prisma,
  type Referral,
  type ReferralReward,
  type Subscription,
  type Transaction,
  type TrialClaim,
  type User,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { RemnashopImporterService } from '../src/modules/imports/services/remnashop-importer.service';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import {
  RemnawaveApiService,
  type RemnawavePanelUser,
} from '../src/modules/remnawave/services/remnawave-api.service';

describe('RemnashopImporterService', () => {
  it('does not rebind a subscription already owned by another local user', async () => {
    const subscriptionUpdates: Prisma.SubscriptionUpdateArgs[] = [];
    const summaries: ImportSummary[] = [];
    const service = createService({
      user: {
        findUnique: async () => ({ id: 'user-matched' }),
        update: async () => undefined,
      },
      subscription: {
        findFirst: async () => ({ id: 'subscription-1', userId: 'another-user', planSnapshot: null }),
        update: async (input: Prisma.SubscriptionUpdateArgs) => subscriptionUpdates.push(input),
      },
      referral: { findUnique: async () => null },
      partnerReferral: { findFirst: async () => null },
      referralReward: { findUnique: async () => null },
      transaction: { findUnique: async () => null },
      importRecord: {
        create: async (input: ImportRecordCreate) => {
          summaries.push(input.data.result);
          return { id: 'import-1' };
        },
      },
    });

    await service.run({
      mode: 'import',
      createdBy: 'admin-1',
      users: [user(100000001)],
      subscriptions: [subscription(100000001)],
    });

    assert.deepEqual(subscriptionUpdates, []);
    assert.equal(summaries[0].conflictCounts.subscriptionOwnerMismatch, 1);
  });

  it('keeps a target plan chosen after an earlier import on a retry', async () => {
    const subscriptionUpdates: SubscriptionPlanSnapshotUpdate[] = [];
    const service = createService({
      user: {
        findUnique: async () => ({ id: 'user-matched' }),
        update: async () => undefined,
      },
      subscription: {
        findFirst: async () => ({
          id: 'subscription-1',
          userId: 'user-matched',
          planSnapshot: { importedFrom: 'remnashop', planId: 'target-plan' },
        }),
        update: async (input: SubscriptionPlanSnapshotUpdate) => {
          subscriptionUpdates.push(input);
        },
      },
      referral: { findUnique: async () => null },
      partnerReferral: { findFirst: async () => null },
      referralReward: { findUnique: async () => null },
      transaction: { findUnique: async () => null },
      importRecord: { create: async () => ({ id: 'import-1' }) },
    });

    await service.run({
      mode: 'import',
      createdBy: 'admin-1',
      users: [user(100000001)],
      subscriptions: [subscription(100000001)],
    });

    assert.equal(subscriptionUpdates.length, 1);
    assert.equal(subscriptionUpdates[0].data.planSnapshot.planId, 'target-plan');
  });

  it('rejects a donor subscription whose live panel profile belongs to another Telegram user', async () => {
    const summaries: ImportSummary[] = [];
    const service = createService(
      {
        user: { findUnique: async () => ({ id: 'user-matched' }), update: async () => undefined },
        subscription: { findFirst: async () => null, create: async () => ({ id: 'sub-1' }) },
        referral: { findUnique: async () => null },
        partnerReferral: { findFirst: async () => null },
        referralReward: { findUnique: async () => null },
        transaction: { findUnique: async () => null },
        importRecord: { create: async (input: ImportRecordCreate) => {
          summaries.push(input.data.result);
          return { id: 'import-1' };
        } },
      },
      panelReader([
        panelUser({ uuid: subscription(100000001).user_remna_id, telegramId: 100000002 }),
      ]),
    );
    await service.run({ mode: 'import', createdBy: null, users: [user(100000001)], subscriptions: [subscription(100000001)] });
    assert.equal(summaries[0].conflictCounts.panelOwnerMismatch, 1);
  });

  it('preserves an unavailable donor trial marker across import retries', async () => {
    const claims: Prisma.TrialClaimUpsertArgs[] = [];
    let consumedClaimExists = false;
    const service = createService({
      user: { findUnique: async () => ({ id: 'user-1' }), update: async () => undefined },
      subscription: { findFirst: async () => null },
      referral: { findUnique: async () => null },
      partnerReferral: { findFirst: async () => null },
      referralReward: { findUnique: async () => null },
      transaction: { findUnique: async () => null },
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

    const input = {
      mode: 'import' as const,
      createdBy: null,
      users: [user(100000001, false)],
      subscriptions: [],
    };
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

  it('keeps a direct referral out when the target user already has partner attribution', async () => {
    const summaries: ImportSummary[] = [];
    const users = new Map<bigint, string>([[100000001n, 'referrer'], [100000002n, 'referred']]);
    const service = createService({
      user: { findUnique: async (input: UserByTelegramId) => userRow(users, input), update: async () => undefined },
      subscription: { findFirst: async () => null },
      referral: { findUnique: async () => null, create: async () => assert.fail('must not create referral') },
      partnerReferral: { findFirst: async () => ({ id: 'partner-attribution' }) },
      referralReward: { findUnique: async () => null },
      transaction: { findUnique: async () => null },
      importRecord: { create: async (input: ImportRecordCreate) => {
        summaries.push(input.data.result);
        return { id: 'import-1' };
      } },
    });
    await service.run({
      mode: 'import', createdBy: null, users: [user(100000001), user(100000002)], subscriptions: [],
      referrals: [{ id: 1, referrer_telegram_id: 100000001, referred_telegram_id: 100000002, level: 'DIRECT', created_at: '2026-01-01T00:00:00.000Z' }],
    });
    assert.equal(summaries[0].conflictCounts.partnerAttribution, 1);
  });

  it('imports a historical transaction and referral reward without replaying customer effects', async () => {
    const transactions: Prisma.TransactionCreateArgs[] = [];
    const rewards: Prisma.ReferralRewardCreateArgs[] = [];
    const summaries: ImportSummary[] = [];
    const userByTelegram = new Map<bigint, string>([
      [100000001n, 'user-referrer'],
      [100000002n, 'user-referred'],
    ]);
    const service = createService({
      user: {
        findUnique: async (input: UserByTelegramId) => userRow(userByTelegram, input),
        update: async () => undefined,
      },
      subscription: { findFirst: async () => null },
      transaction: {
        findUnique: async () => null,
        create: async (input: Prisma.TransactionCreateArgs) => {
          transactions.push(input);
          return { id: 'transaction-1' };
        },
      },
      referral: {
        findUnique: async () => null,
        create: async () => ({ id: 'referral-1', referrerId: 'user-referrer' }),
      },
      partnerReferral: { findFirst: async () => null },
      referralReward: {
        findUnique: async () => null,
        create: async (input: Prisma.ReferralRewardCreateArgs) => {
          rewards.push(input);
          return { id: 'reward-1' };
        },
      },
      importRecord: {
        create: async (input: ImportRecordCreate) => {
          summaries.push(input.data.result);
          assert.equal(input.data.status, ImportStatus.COMMITTED);
          return { id: 'import-2' };
        },
      },
    });

    await service.run({
      mode: 'import',
      createdBy: 'admin-1',
      users: [user(100000001), user(100000002)],
      subscriptions: [],
      transactions: [
        {
          id: 7,
          payment_id: 'provider-payment-7',
          user_telegram_id: 100000002,
          status: 'COMPLETED',
          is_test: false,
          purchase_type: 'NEW',
          gateway_type: 'PLATEGA',
          pricing: { final_amount: '199.00' },
          currency: 'RUB',
          plan_snapshot: { id: 2, name: 'Example plan' },
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      referrals: [
        {
          id: 11,
          referrer_telegram_id: 100000001,
          referred_telegram_id: 100000002,
          level: 'FIRST',
          created_at: '2026-05-01T00:00:00.000Z',
        },
      ],
      referralRewards: [
        {
          id: 12,
          referral_id: 11,
          user_telegram_id: 100000001,
          type: 'POINTS',
          amount: 25,
          is_issued: true,
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    });

    assert.equal(transactions.length, 1);
    assert.equal(rewards.length, 1);
    const transaction = transactions[0];
    assert.equal(transaction.data.paymentId, 'remnashop:7');
    assert.equal(transaction.data.subscriptionId, undefined);
    assert.equal(transaction.data.gatewayId, undefined);
    const summary = summaries[0];
    assert.equal(summary.transactionsCreated, 1);
    assert.equal(summary.referralsCreated, 1);
    assert.equal(summary.referralRewardsCreated, 1);
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
interface RemnashopPrismaSurface {
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
    readonly create: StubWrite;
  };
  readonly referral: {
    readonly findUnique: StubRead<Pick<Referral, 'id' | 'referrerId'>>;
    readonly create: StubWriteReturning<Pick<Referral, 'id' | 'referrerId'>>;
  };
  readonly referralReward: {
    readonly findUnique: StubRead<Pick<ReferralReward, 'id'>>;
    readonly create: StubWrite;
  };
  readonly partnerReferral: {
    readonly findFirst: StubRead<Pick<PartnerReferral, 'id'>>;
  };
}

/**
 * A test stubs only the delegates its path reaches; anything else stays absent
 * and fails loudly at run time rather than answering with a silent fake. A
 * misspelled delegate or method is an excess-property error, not a no-op.
 */
type PrismaImporterStub = {
  readonly [Model in keyof RemnashopPrismaSurface]?: Partial<RemnashopPrismaSurface[Model]>;
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
): RemnashopImporterService {
  return new RemnashopImporterService(prisma as PrismaService, panel as RemnawaveApiService);
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
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
  };
}

/**
 * What RemnashopImporterService stores in `importRecord.result`: a flat block of
 * counters plus the `conflictCounts` block (note the name — the AltShop importer
 * calls the same block `conflicts`). Only `conflictCounts` is named here; the
 * flat counters are read by name and compared as values.
 */
type ImportSummary = Record<string, unknown> & {
  readonly conflictCounts: Record<string, number>;
};

/**
 * The importer's own `importRecord.create` argument, narrowed to the part these
 * tests read. Prisma types `result` as an opaque JSON input — correct for the
 * client, useless for a test that has to look inside the summary — so the
 * summary shape is named here instead.
 */
type ImportRecordCreate = {
  readonly data: { readonly result: ImportSummary; readonly status: ImportStatus };
};

/** The subscription update these tests inspect: the merged plan snapshot. */
type SubscriptionPlanSnapshotUpdate = {
  readonly data: { readonly planSnapshot: Record<string, unknown> };
};

/** How the importer addresses a donor user row. */
type UserByTelegramId = { readonly where: { readonly telegramId: bigint } };

/**
 * A user Prisma cannot find comes back as `null`, never as a row whose `id` is
 * undefined — the shape the importer would happily treat as found.
 */
function userRow(
  byTelegramId: ReadonlyMap<bigint, string>,
  input: UserByTelegramId,
): { readonly id: string } | null {
  const id = byTelegramId.get(input.where.telegramId);
  return id === undefined ? null : { id };
}

function user(telegramId: number, isTrialAvailable = true) {
  return {
    id: telegramId - 100000000,
    telegram_id: telegramId,
    username: null,
    referral_code: null,
    name: 'Example user',
    role: 1,
    language: 'RU',
    personal_discount: 0,
    purchase_discount: 0,
    points: 0,
    is_blocked: false,
    is_bot_blocked: false,
    is_rules_accepted: true,
    is_trial_available: isTrialAvailable,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function subscription(telegramId: number) {
  return {
    id: 1,
    user_remna_id: '11111111-1111-4111-8111-111111111111',
    user_telegram_id: telegramId,
    status: 'ACTIVE',
    is_trial: false,
    traffic_limit: 0,
    device_limit: 1,
    traffic_limit_strategy: 'NO_RESET',
    tag: null,
    internal_squads: [],
    external_squad: null,
    expire_at: null,
    url: null,
    plan_snapshot: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}
