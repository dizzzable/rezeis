import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  STALE_PANEL_IDENTITY_CENSUS_REASON,
  StalePanelIdentityCensus,
} from '../src/modules/remnawave/services/stale-panel-identity.census';
import { isStalePanelIdentity } from '../src/modules/remnawave/services/stale-panel-link';

/**
 * THE BOOT COUNT, against PostgreSQL.
 *
 * The count is one SQL filter (`remnawave_id !~ '^[0-9]+$'`), and the per-row
 * refusals are one code predicate (`isStalePanelIdentity`). They are meant to
 * describe the SAME rows — the card says "n subscriptions are refused", and n
 * has to be the number the refusals actually refuse. Only a real PostgreSQL can
 * say what `!~` does with an empty string, a uuid or a decimal, so this runs
 * the count on one and holds it against the code predicate row by row.
 *
 * The table is shared with every other PostgreSQL spec, so the assertion is on
 * the DELTA this file's own rows make, never on an absolute count.
 *
 * Runs only with TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `xa-census-${process.pid}-${Date.now()}`;

let prisma: PrismaService;

interface RecordedError {
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

function census(): { service: StalePanelIdentityCensus; errors: RecordedError[] } {
  const errors: RecordedError[] = [];
  const events = {
    error: (_type: string, _category: string, message: string, metadata: Record<string, unknown>) => {
      errors.push({ message, metadata });
    },
  };
  return { service: new StalePanelIdentityCensus(prisma, events as never), errors };
}

/** Every stored identity this file inserts, live unless marked otherwise. */
const ROWS: ReadonlyArray<{
  readonly label: string;
  readonly remnawaveId: string | null;
  readonly status?: SubscriptionStatus;
}> = [
  { label: 'uuid', remnawaveId: '330f2b38-1362-46ab-b5c0-dea32167eff9' },
  { label: 'empty', remnawaveId: '' },
  { label: 'junk', remnawaveId: 'rw-imported-1' },
  { label: 'decimal', remnawaveId: '4471' },
  { label: 'decimal-zero', remnawaveId: '0' },
  { label: 'unlinked', remnawaveId: null },
  { label: 'deleted-uuid', remnawaveId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', status: SubscriptionStatus.DELETED },
];

run('the stale panel identity count — PostgreSQL', () => {
  const userId = `${prefix}-user`;

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.user.create({ data: { id: userId, referralCode: userId, name: userId } });
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.subscription.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('counts exactly the live rows the refusals refuse — uuid, empty and junk; never a decimal, NULL or a DELETED row', async () => {
    const before = await census().service.run();
    assert.notEqual(before, null, 'the count could not be taken at all');

    for (const row of ROWS) {
      await prisma.subscription.create({
        data: {
          id: `${prefix}-${row.label}`,
          userId,
          status: row.status ?? SubscriptionStatus.ACTIVE,
          planSnapshot: {},
          remnawaveId: row.remnawaveId,
        },
      });
    }

    const { service, errors } = census();
    const after = await service.run();
    assert.notEqual(after, null);

    // What the CODE refuses among the rows just inserted: live, linked, stale.
    const refusedByCode = ROWS.filter(
      (row) =>
        (row.status ?? SubscriptionStatus.ACTIVE) !== SubscriptionStatus.DELETED &&
        row.remnawaveId !== null &&
        isStalePanelIdentity(row.remnawaveId),
    ).map((row) => row.label);
    // Anchor: the fixture really does hold rows on both sides of the line.
    assert.deepEqual(refusedByCode, ['uuid', 'empty', 'junk']);

    assert.equal(
      (after as number) - (before as number),
      refusedByCode.length,
      'the SQL count and the code predicate disagree about the rows this file inserted',
    );

    // …and it said so, with the number it counted.
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.metadata['subscriptions'], after);
    assert.equal(errors[0]?.metadata['reason'], STALE_PANEL_IDENTITY_CENSUS_REASON);
    assert.match(String(errors[0]?.metadata['why']), new RegExp(`: ${after}\\.`));
  });

  it('a row re-linked to a decimal leaves the count', async () => {
    const before = await census().service.run();
    await prisma.subscription.update({
      where: { id: `${prefix}-uuid` },
      data: { remnawaveId: '4472' },
    });
    const after = await census().service.run();
    assert.equal((before as number) - (after as number), 1);
  });
});
