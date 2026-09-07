import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { OPERATOR_LIMIT_SOURCE } from '../src/modules/anti-fraud/detectors/sharing-detectors';

/**
 * WHO moved the device limit, against a real PostgreSQL.
 *
 * The provenance that decides whether the anti-fraud grace excuses an overage
 * is written by a TRIGGER, from a transaction-local setting the admin route
 * sets. Neither half can be checked without a database: the trigger is SQL, and
 * "transaction-local" is a claim about a connection, not about a function.
 *
 * Three things have to hold, and each of them fails in a direction that is
 * invisible from the outside:
 *
 *   1. an update that carries the setting records it — otherwise an operator
 *      who sets a limit by hand still gets their customer accused, which is the
 *      report this whole change answers;
 *   2. an update that does NOT carry it records `NULL` — otherwise a fleet-wide
 *      importer sweep (`0 → N` on every row) would look operator-set, and the
 *      detector would go quiet across the entire customer base at exactly the
 *      moment a new limit starts to mean something;
 *   3. the setting does not survive its transaction — otherwise the NEXT writer
 *      on that pooled connection inherits it, and (2) fails without anybody
 *      writing a line of wrong code.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's fourth job runs
 * it. `npm test` does not, so a failure here is only ever seen in CI — which is
 * the reason the assertions below say what they mean rather than what they
 * check.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `dlp-${process.pid}-${Date.now()}`;
let prisma: PrismaService;

interface Stamp {
  readonly device_limit: number;
  readonly device_limit_before_reduction: number | null;
  readonly device_limit_reduction_by: string | null;
  readonly device_limit_reduced_at: Date | null;
}

async function makeSubscription(suffix: string, deviceLimit: number): Promise<string> {
  const userId = `${prefix}-u-${suffix}`;
  const id = `${prefix}-s-${suffix}`;
  await prisma.user.create({
    data: { id: userId, referralCode: `${id}-ref`, name: suffix },
  });
  await prisma.subscription.create({
    data: { id, userId, deviceLimit, status: 'ACTIVE' },
  });
  return id;
}

async function stampOf(id: string): Promise<Stamp> {
  const rows = await prisma.$queryRaw<Stamp[]>(Prisma.sql`
    SELECT "device_limit",
           "device_limit_before_reduction",
           "device_limit_reduction_by",
           "device_limit_reduced_at"
      FROM "subscriptions"
     WHERE "id" = ${id}
  `);
  assert.equal(rows.length, 1, `no subscription row for ${id}`);
  return rows[0] as Stamp;
}

run('the device limit remembers who moved it', () => {
  before(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    await prisma.subscription.deleteMany({ where: { id: { startsWith: `${prefix}-s-` } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: `${prefix}-u-` } } });
    await prisma.$disconnect();
  });

  it('records the operator when the setting travels with the update', async () => {
    const id = await makeSubscription('operator', 0);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rezeis.device_limit_source', ${OPERATOR_LIMIT_SOURCE}, true)`;
      await tx.subscription.update({ where: { id }, data: { deviceLimit: 2 } });
    });

    const stamp = await stampOf(id);
    assert.equal(stamp.device_limit_reduction_by, OPERATOR_LIMIT_SOURCE);
    // Stamped in the SAME assignment block, so the provenance can never
    // describe a different reduction than the one it gates.
    assert.equal(stamp.device_limit_before_reduction, 0);
    assert.notEqual(stamp.device_limit_reduced_at, null);
  });

  it('records nothing when the update carries no setting', async () => {
    // The importer, a plan change, a renewal — every writer but the panel. This
    // is the behaviour that existed before provenance, and it has to survive:
    // it is what keeps a fleet-wide `0 → N` sweep loud.
    const id = await makeSubscription('anonymous', 0);
    await prisma.subscription.update({ where: { id }, data: { deviceLimit: 2 } });

    const stamp = await stampOf(id);
    assert.equal(stamp.device_limit_reduction_by, null);
    assert.equal(stamp.device_limit_before_reduction, 0);
  });

  it('does not let the setting outlive its transaction', async () => {
    // THE ONE THAT FAILS SILENTLY. `set_config(..., true)` is transaction-local;
    // with `false` it would stay on the pooled connection and the next writer
    // of ANY subscription's limit would be recorded as operator-set. Both
    // updates below run through the same client on purpose.
    const first = await makeSubscription('leak-first', 0);
    const second = await makeSubscription('leak-second', 0);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rezeis.device_limit_source', ${OPERATOR_LIMIT_SOURCE}, true)`;
      await tx.subscription.update({ where: { id: first }, data: { deviceLimit: 2 } });
    });
    await prisma.subscription.update({ where: { id: second }, data: { deviceLimit: 2 } });

    assert.equal((await stampOf(first)).device_limit_reduction_by, OPERATOR_LIMIT_SOURCE);
    assert.equal(
      (await stampOf(second)).device_limit_reduction_by,
      null,
      'the operator setting leaked out of its transaction onto the next writer',
    );
  });

  it('leaves provenance alone on a write the trigger does not stamp', async () => {
    // A RAISE is not a reduction, so the trigger's branch never runs and there
    // is nothing to attribute. The row keeps whatever the last real reduction
    // recorded — which is correct, because that is the reduction the anti-fraud
    // window is still measuring.
    const id = await makeSubscription('raise', 0);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rezeis.device_limit_source', ${OPERATOR_LIMIT_SOURCE}, true)`;
      await tx.subscription.update({ where: { id }, data: { deviceLimit: 2 } });
    });
    // 2 → 9, upward: no stamp, nothing overwritten.
    await prisma.subscription.update({ where: { id }, data: { deviceLimit: 9 } });

    const stamp = await stampOf(id);
    assert.equal(stamp.device_limit, 9);
    assert.equal(stamp.device_limit_reduction_by, OPERATOR_LIMIT_SOURCE);
    assert.equal(stamp.device_limit_before_reduction, 0);
  });

  it('re-attributes a second operator edit rather than keeping the first', async () => {
    // Two manual edits in a row. A design that carried provenance in a column
    // the writer fills would have had to clear it between them and could not
    // tell "set again to the same value" from "not set at all"; a
    // transaction-local setting simply arrives again.
    const id = await makeSubscription('twice', 0);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rezeis.device_limit_source', ${OPERATOR_LIMIT_SOURCE}, true)`;
      await tx.subscription.update({ where: { id }, data: { deviceLimit: 5 } });
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rezeis.device_limit_source', ${OPERATOR_LIMIT_SOURCE}, true)`;
      await tx.subscription.update({ where: { id }, data: { deviceLimit: 3 } });
    });

    const stamp = await stampOf(id);
    assert.equal(stamp.device_limit_reduction_by, OPERATOR_LIMIT_SOURCE);
    // The ceiling moved with it: the second reduction reduced from 5, not 0.
    assert.equal(stamp.device_limit_before_reduction, 5);
  });
});
