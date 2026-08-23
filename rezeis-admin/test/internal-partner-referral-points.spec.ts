import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalPartnerController } from '../src/modules/partners/controllers/internal-partner.controller';

/**
 * `GET /internal/user/:ref/partner/info` — the referral points a partner still owns.
 *
 * ── The situation this payload field exists for ──────────────────────────────
 *
 * A subscriber earns referral points (`User.points`) by inviting friends. When
 * the owner appoints them a partner, `createConfiguredRewards` stops creating
 * referral rewards for them — the partner engine pays them instead. Their
 * ALREADY-EARNED points are untouched and still spendable: no redemption path
 * checks partner status, in this service or in the cabinet.
 *
 * But the cabinet has one nav slot for both programs, and an active partner
 * gets the Partner tab in it — which meant the points existed, were spendable,
 * and were invisible. This field is what lets the cabinet and the bot say the
 * number out loud and offer a way to spend it.
 *
 * ── Two units, never merged ─────────────────────────────────────────────────
 *
 * `balance` is minor units of `balanceCurrency` and is rendered by dividing by
 * 100. `referralPoints` is a DIMENSIONLESS integer from a different pool, the
 * one quests and operator adjustments also write to. There is no conversion
 * between them and there cannot be one. The specs below pin that the two
 * travel independently, because merging the pots is the single thing that must
 * never happen to this payload.
 *
 * ── Why the number is sent even at zero ─────────────────────────────────────
 *
 * The owner's rule — show the points only while they are above zero — is about
 * what the operator's customer SEES. That is a presentation rule, and it lives
 * on the surface that renders it: reiwa ships on its own release train, and
 * rezeis serves installs on mixed panel versions, so a key that vanished at
 * zero would be indistinguishable from a key an older panel never sent. The
 * wire states the fact; the surface decides whether to show it.
 *
 * ── About this fake ─────────────────────────────────────────────────────────
 *
 * The REAL controller runs against a fake Prisma that holds rows and, crucially,
 * HONOURS `select`: a field the controller does not ask for comes back
 * undefined, exactly as Prisma would return it. A fake that ignored `select`
 * would keep every assertion below green even if the query stopped reading
 * `points` at all. The first two tests are controls proving this fake serves
 * real rows and can say "no".
 *
 * Dates are relative. An absolute fixture date in this repo was live when
 * written and silently became an expired-subscription assertion months later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface UserRow {
  readonly id: string;
  readonly telegramId: bigint;
  readonly points: number;
  readonly partnerBalanceCurrencyOverride: string | null;
}

interface PartnerRow {
  readonly id: string;
  readonly userId: string;
  readonly isActive: boolean;
  readonly balance: number;
  readonly totalEarned: number;
  readonly totalWithdrawn: number;
  readonly createdAt: Date;
}

interface FakeInput {
  readonly user: UserRow | null;
  readonly partner: PartnerRow | null;
  readonly defaultCurrency?: string | null;
  readonly partnerSettings?: Record<string, unknown>;
  readonly invitedEdge?: boolean;
}

/**
 * Applies a Prisma `select` the way Prisma does: only the requested keys come
 * back. This is what makes "the controller stopped selecting `points`" a
 * failing assertion rather than an invisible change.
 */
function project(
  row: Record<string, unknown>,
  select: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted === true) out[key] = row[key];
  }
  return out;
}

function buildPrisma(input: FakeInput) {
  const asRecord = (row: UserRow | PartnerRow): Record<string, unknown> =>
    row as unknown as Record<string, unknown>;

  return {
    user: {
      findUnique: async (args: {
        where: { id?: string; telegramId?: bigint };
        select?: Record<string, unknown>;
      }) => {
        const row = input.user;
        if (!row) return null;
        if (args.where.telegramId !== undefined && args.where.telegramId !== row.telegramId) {
          return null;
        }
        if (args.where.id !== undefined && args.where.id !== row.id) return null;
        return project(asRecord(row), args.select);
      },
    },
    partner: {
      findUnique: async (args: {
        where: { userId?: string };
        select?: Record<string, unknown>;
      }) => {
        const row = input.partner;
        if (!row) return null;
        if (args.where.userId !== undefined && args.where.userId !== row.userId) return null;
        return project(asRecord(row), args.select);
      },
    },
    settings: {
      findUnique: async (args: { select?: Record<string, unknown> }) =>
        project(
          {
            partnerSettings: input.partnerSettings ?? {},
            defaultCurrency: input.defaultCurrency ?? null,
          },
          args.select,
        ),
    },
    referral: {
      findUnique: async () => (input.invitedEdge === true ? { id: 'edge-1' } : null),
    },
  };
}

function buildController(input: FakeInput): InternalPartnerController {
  return new InternalPartnerController(buildPrisma(input) as never, {} as never);
}

/** A partner appointed a month ago. Relative, so it never ages into a defect. */
function partnerRow(over: Partial<PartnerRow> = {}): PartnerRow {
  return {
    id: 'partner-1',
    userId: 'user-1',
    isActive: true,
    balance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    createdAt: new Date(Date.now() - 30 * DAY_MS),
    ...over,
  };
}

function userRow(over: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    telegramId: 424242n,
    points: 0,
    partnerBalanceCurrencyOverride: null,
    ...over,
  };
}

describe('InternalPartnerController.getInfo — referral points', () => {
  it('CONTROL: the fake serves real rows, so an assertion below can fail', async () => {
    const controller = buildController({
      user: userRow({ points: 120 }),
      partner: partnerRow({ id: 'partner-9', balance: 5_000, totalEarned: 7_500 }),
      defaultCurrency: 'RUB',
    });

    const info = (await controller.getInfo('424242')) as Record<string, unknown> | null;

    assert.ok(info, 'the fake did not serve a partner at all — nothing below would mean anything');
    assert.equal(info['id'], 'partner-9');
    assert.equal(info['balance'], 5_000);
    assert.equal(info['balanceCurrency'], 'RUB');
  });

  it('CONTROL: says null for a user who is not a partner, points or no points', async () => {
    const controller = buildController({ user: userRow({ points: 120 }), partner: null });

    assert.equal(await controller.getInfo('424242'), null);
  });

  it('carries the points the user actually holds', async () => {
    const controller = buildController({
      user: userRow({ points: 120 }),
      partner: partnerRow(),
    });

    const info = (await controller.getInfo('424242')) as Record<string, unknown>;

    assert.equal(info['referralPoints'], 120);
  });

  it('sends the number at zero too — the surface, not the wire, decides what is shown', async () => {
    // The owner's rule is "show the balance only while it is above zero". That
    // is a rendering decision about the operator's customer, and it belongs to
    // the two surfaces that render it. Dropping the key here would encode a UI
    // policy in a contract shared by two independently released repositories,
    // and would make "zero" and "a panel too old to send this" the same wire.
    const controller = buildController({ user: userRow({ points: 0 }), partner: partnerRow() });

    const info = (await controller.getInfo('424242')) as Record<string, unknown>;

    assert.ok('referralPoints' in info, 'the key disappeared at zero');
    assert.equal(info['referralPoints'], 0);
  });

  it('keeps points and the money balance in different units', async () => {
    // 12_345 minor units renders as "123.45 RUB". 40 points renders as "40".
    // Nothing converts one into the other, so the payload must carry the raw
    // integer, untouched by the balance or the currency sitting next to it.
    const controller = buildController({
      user: userRow({ points: 40 }),
      partner: partnerRow({ balance: 12_345, totalEarned: 20_000 }),
      defaultCurrency: 'RUB',
    });

    const info = (await controller.getInfo('424242')) as Record<string, unknown>;

    assert.equal(info['referralPoints'], 40);
    assert.equal(info['balance'], 12_345);
    assert.ok(Number.isInteger(info['referralPoints'] as number));
    assert.notEqual(info['referralPoints'], (info['balance'] as number) / 100);
    assert.notEqual(info['referralPoints'], info['balance']);
  });

  it('reports the same points however much money the partner has', async () => {
    // Independence, stated as an experiment rather than an assertion about one
    // row: move the balance by three orders of magnitude, keep the points row
    // fixed, and the reported points must not budge.
    const points = 40;
    const infos = await Promise.all(
      [0, 12_345, 9_900_000].map(async (balance) => {
        const controller = buildController({
          user: userRow({ points }),
          partner: partnerRow({ balance }),
          defaultCurrency: 'RUB',
        });
        return (await controller.getInfo('424242')) as Record<string, unknown>;
      }),
    );

    assert.deepStrictEqual(
      infos.map((info) => info['referralPoints']),
      [points, points, points],
    );
  });

  it('leaves every pre-existing payload key exactly where it was', async () => {
    const controller = buildController({
      user: userRow({ points: 120, partnerBalanceCurrencyOverride: 'USD' }),
      partner: partnerRow(),
      defaultCurrency: 'RUB',
      partnerSettings: { allowBalancePayment: true },
    });

    const info = (await controller.getInfo('424242')) as Record<string, unknown>;

    assert.deepStrictEqual(Object.keys(info).sort(), [
      'balance',
      'balanceCurrency',
      'balancePaymentEnabled',
      'createdAt',
      'id',
      'isActive',
      'programAvailable',
      'referralPoints',
      'totalEarned',
      'totalWithdrawn',
    ]);
    // …and the neighbours still say what they said before.
    assert.equal(info['balanceCurrency'], 'USD');
    assert.equal(info['balancePaymentEnabled'], true);
    assert.equal(info['programAvailable'], true);
  });

  it('resolves the same points through a reiwa_id as through a telegramId', async () => {
    const controller = buildController({
      user: userRow({ id: 'cmphfcr6i007v01jg0lcu653h', points: 77 }),
      partner: partnerRow({ userId: 'cmphfcr6i007v01jg0lcu653h' }),
    });

    const info = (await controller.getInfo('cmphfcr6i007v01jg0lcu653h')) as Record<string, unknown>;

    assert.equal(info['referralPoints'], 77);
  });
});
