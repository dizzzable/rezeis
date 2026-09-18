import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AutomationTriggerKind, Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * SWITCHING OFF THE RULES SAVED WITH `{}`, against a real PostgreSQL.
 *
 * `evaluateCondition({})` answered false until this release, so an enabled rule
 * with empty conditions was SKIPPED on every event and tick and never ran an
 * action. It now answers true, and the migration below switches those rules off
 * before the new image can start running them. What only an engine can prove is
 * the migration's own SQL: that `conditions = '{}'::jsonb` picks out exactly the
 * empty object — not SQL NULL, not JSON `null`, not a real expression — that the
 * enum comparison keeps MANUAL rules out, that a switched-off rule gets its audit
 * row in the same statement, and that a replay changes nothing.
 *
 * Every shape is seeded, the migration's file is executed as it will be deployed,
 * and everything happens inside ONE transaction that is rolled back at the end:
 * the migration's UPDATE is not scoped to this spec's rows, and the table is
 * shared with every other live spec.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const MIGRATION = '20260915160000_automation_rules_empty_conditions_switched_off';
const ACTION = 'automations.rule_switched_off_on_upgrade';
const prefix = `aec-${process.pid}-${Date.now()}`;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

type ConditionShape = 'empty' | 'sql-null' | 'json-null' | 'expression';

interface Shape {
  readonly id: string;
  readonly isEnabled: boolean;
  readonly triggerKind: AutomationTriggerKind;
  readonly condition: ConditionShape;
}

const SHAPES: readonly Shape[] = [true, false].flatMap((isEnabled) =>
  [AutomationTriggerKind.REALTIME, AutomationTriggerKind.CRON, AutomationTriggerKind.MANUAL].flatMap(
    (triggerKind) =>
      (['empty', 'sql-null', 'json-null', 'expression'] as const).map((condition) => ({
        id: `${prefix}-${isEnabled ? 'on' : 'off'}-${triggerKind.toLowerCase()}-${condition}`,
        isEnabled,
        triggerKind,
        condition,
      })),
  ),
);

/** The only shapes the migration may touch. */
const EXPECTED_OFF = SHAPES.filter(
  (shape) => shape.isEnabled && shape.triggerKind !== AutomationTriggerKind.MANUAL && shape.condition === 'empty',
).map((shape) => shape.id);

function conditionsOf(shape: ConditionShape): Prisma.InputJsonValue | typeof Prisma.DbNull | typeof Prisma.JsonNull {
  switch (shape) {
    case 'empty':
      return {};
    case 'sql-null':
      return Prisma.DbNull;
    case 'json-null':
      return Prisma.JsonNull;
    case 'expression':
      return { '==': ['$userId', 'user-1'] };
  }
}

function triggerSpecOf(kind: AutomationTriggerKind): string {
  if (kind === AutomationTriggerKind.CRON) return '0 3 * * *';
  if (kind === AutomationTriggerKind.REALTIME) return 'payment.completed';
  return '';
}

interface RuleRow {
  readonly id: string;
  readonly isEnabled: boolean;
  readonly updatedAt: Date;
}

interface Observed {
  readonly rules: readonly RuleRow[];
  readonly audit: ReadonlyArray<{ readonly id: string; readonly adminUserId: string | null; readonly metadata: Record<string, unknown> }>;
  readonly auditAfterReplay: number;
  readonly rulesAfterReplay: readonly RuleRow[];
}

/** Thrown at the end of the transaction so that nothing it did is kept. */
class RolledBack extends Error {}

let prisma: PrismaService;

run('switching off rules saved with empty conditions, on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.$disconnect();
  });

  it('switches off exactly the enabled event and schedule rules with `{}`, one audit row each, and replays as a no-op', async () => {
    const migrationSql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', MIGRATION, 'migration.sql'), 'utf8');
    const longAgo = new Date(Date.now() - YEAR_MS);
    let observed: Observed | null = null;

    const auditRowsOfThisSpec = async (tx: Prisma.TransactionClient) =>
      (await tx.adminAuditLog.findMany({ where: { action: ACTION }, select: { id: true, adminUserId: true, metadata: true } }))
        .map((row) => ({ ...row, metadata: row.metadata as Record<string, unknown> }))
        .filter((row) => String(row.metadata.targetId ?? '').startsWith(prefix));
    const rulesOfThisSpec = (tx: Prisma.TransactionClient) =>
      tx.automationRule.findMany({
        where: { id: { startsWith: prefix } },
        select: { id: true, isEnabled: true, updatedAt: true },
        orderBy: { id: 'asc' },
      });

    await assert.rejects(
      prisma.$transaction(
        async (tx) => {
          for (const shape of SHAPES) {
            await tx.automationRule.create({
              data: {
                id: shape.id,
                name: `${prefix} ${shape.triggerKind} ${shape.condition}`,
                isEnabled: shape.isEnabled,
                triggerKind: shape.triggerKind,
                triggerSpec: triggerSpecOf(shape.triggerKind),
                conditions: conditionsOf(shape.condition),
                actions: [],
              },
            });
          }
          // A known old stamp, so a rule the migration rewrote is told apart
          // from one it left alone.
          await tx.$executeRaw(
            Prisma.sql`UPDATE "automation_rules" SET "updated_at" = ${longAgo} WHERE "id" LIKE ${`${prefix}%`}`,
          );

          await tx.$executeRawUnsafe(migrationSql);
          const rules = await rulesOfThisSpec(tx);
          const audit = await auditRowsOfThisSpec(tx);

          await tx.$executeRawUnsafe(migrationSql);
          observed = {
            rules,
            audit,
            auditAfterReplay: (await auditRowsOfThisSpec(tx)).length,
            rulesAfterReplay: await rulesOfThisSpec(tx),
          };
          throw new RolledBack();
        },
        { maxWait: 15_000, timeout: 60_000 },
      ),
      RolledBack,
    );

    assert.ok(observed !== null, 'the transaction never reached its observations');
    const seen: Observed = observed;
    assert.equal(seen.rules.length, SHAPES.length, 'a seeded rule is missing');
    assert.equal(EXPECTED_OFF.length, 2, 'fixture: exactly two shapes are meant to be switched off');

    for (const shape of SHAPES) {
      const row = seen.rules.find((rule) => rule.id === shape.id);
      assert.ok(row !== undefined, `${shape.id} is missing`);
      const switchedOff = EXPECTED_OFF.includes(shape.id);
      assert.equal(row.isEnabled, switchedOff ? false : shape.isEnabled, `${shape.id}: is_enabled`);
      assert.equal(
        row.updatedAt.getTime() !== longAgo.getTime(),
        switchedOff,
        `${shape.id}: updated_at ${switchedOff ? 'was not stamped' : 'was rewritten'}`,
      );
    }

    assert.deepEqual(seen.audit.map((row) => row.metadata.targetId).sort(), [...EXPECTED_OFF].sort());
    for (const row of seen.audit) {
      const shape = SHAPES.find((candidate) => candidate.id === row.metadata.targetId);
      assert.ok(shape !== undefined);
      assert.equal(row.adminUserId, null, 'the migration is not an admin');
      assert.match(row.id, /^[0-9a-f-]{36}$/);
      assert.equal(row.metadata.targetType, 'automation_rule');
      assert.equal(row.metadata.ruleName, `${prefix} ${shape.triggerKind} ${shape.condition}`);
      assert.equal(row.metadata.triggerKind, shape.triggerKind);
      assert.equal(row.metadata.triggerSpec, triggerSpecOf(shape.triggerKind));
      assert.equal(row.metadata.migration, MIGRATION);
      assert.match(String(row.metadata.reason), /\{\}/);
      assert.match(String(row.metadata.reasonEn), /\{\}/);
    }
    assert.equal(new Set(seen.audit.map((row) => row.id)).size, seen.audit.length, 'two audit rows share an id');

    assert.equal(seen.auditAfterReplay, EXPECTED_OFF.length, 'a replay wrote audit rows again');
    assert.deepEqual(seen.rulesAfterReplay, seen.rules, 'a replay changed rules again');

    // And the rollback kept nothing.
    assert.equal(await prisma.automationRule.count({ where: { id: { startsWith: prefix } } }), 0);
  });
});
