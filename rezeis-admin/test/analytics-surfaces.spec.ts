import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '@nestjs/common';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { BusinessAnalyticsService } from '../src/modules/business-analytics/services/business-analytics.service';
import {
  buildUsageSurfaceReport,
  PWA_INSTALL_OS_UNKNOWN,
  usageSurfaceReportSql,
  type UsageSurfaceRow,
} from '../src/modules/business-analytics/utils/usage-surface-report.util';
import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';

Logger.overrideLogger(false);

/**
 * The usage-surface report without a database: how the rows of its one
 * statement become the card's figures, that it IS one statement, and that the
 * install's OS is written where that statement reads it.
 *
 * What the statement itself computes — the buckets, the install-OS rule, one
 * snapshot for every figure, the migration that carried old installs over — is
 * proven on PostgreSQL by `analytics-surfaces-postgres.spec.ts`; a fake cannot
 * run SQL, and a test that pretended to would prove the fake.
 */

const DAY_MS = 86_400_000;

const row = (
  dimension: string,
  key: string | null,
  counts: { tracked?: number; active?: number; installed?: number } = {},
): UsageSurfaceRow => ({
  dimension,
  key,
  // The driver hands counts over as bigint; the mapping must not care.
  tracked: BigInt(counts.tracked ?? 0),
  active: BigInt(counts.active ?? 0),
  installed: BigInt(counts.installed ?? 0),
});

describe('the report built from the statement’s rows', () => {
  const GENERATED = new Date('2026-09-15T12:00:00.000Z');

  it('takes the totals from the grand-total row and each ring from its own grouping', () => {
    const report = buildUsageSurfaceReport(
      [
        row('total', null, { tracked: 9, active: 8, installed: 6 }),
        row('surface', 'tma', { tracked: 2, installed: 1 }),
        row('surface', 'pwa', { tracked: 3, installed: 3 }),
        row('surface', 'browser', { tracked: 4, installed: 2 }),
        row('form', 'mobile', { tracked: 5, installed: 3 }),
        row('form', 'desktop', { tracked: 4, installed: 3 }),
        row('os', 'ios', { tracked: 6, installed: 5 }),
        row('os', 'android', { tracked: 3, installed: 1 }),
        row('install_os', 'ios', { tracked: 4, installed: 4 }),
        row('install_os', PWA_INSTALL_OS_UNKNOWN, { tracked: 2, installed: 2 }),
      ],
      GENERATED,
    );

    assert.equal(report.totalTracked, 9);
    assert.equal(report.activeLast30d, 8);
    assert.equal(report.pwaInstalls, 6);
    // Tracked customers in the three latest-visit rings…
    assert.deepEqual(report.surfaces, [
      { key: 'browser', count: 4 },
      { key: 'pwa', count: 3 },
      { key: 'tma', count: 2 },
    ]);
    assert.deepEqual(report.formFactors, [{ key: 'mobile', count: 5 }, { key: 'desktop', count: 4 }]);
    assert.deepEqual(report.operatingSystems, [{ key: 'ios', count: 6 }, { key: 'android', count: 3 }]);
    // …installed customers in the installs ring — not its tracked column.
    assert.deepEqual(report.pwaInstallsByOs, [{ key: 'ios', count: 4 }, { key: PWA_INSTALL_OS_UNKNOWN, count: 2 }]);
    assert.equal(report.generatedAt, GENERATED.toISOString());
  });

  it('calls a customer with no value "other", counted together with those the cabinet reported as "other"', () => {
    const report = buildUsageSurfaceReport(
      [
        row('total', null, { tracked: 5 }),
        row('os', 'other', { tracked: 2 }),
        row('os', null, { tracked: 1 }),
        row('os', 'linux', { tracked: 2 }),
      ],
      GENERATED,
    );

    // 3 beats 2: merged, "other" leads; tied counts fall back to the key.
    assert.deepEqual(report.operatingSystems, [{ key: 'other', count: 3 }, { key: 'linux', count: 2 }]);
  });

  it('drops the buckets that count nobody — the untracked, the not installed', () => {
    const report = buildUsageSurfaceReport(
      [
        row('total', null, { tracked: 1, installed: 1 }),
        // The NULL group of a grouping holds the customers it does not count.
        row('surface', null, { tracked: 0 }),
        row('surface', 'tma', { tracked: 1 }),
        row('install_os', null, { installed: 0 }),
        row('install_os', 'android', { installed: 1 }),
      ],
      GENERATED,
    );

    assert.deepEqual(report.surfaces, [{ key: 'tma', count: 1 }]);
    assert.deepEqual(report.pwaInstallsByOs, [{ key: 'android', count: 1 }]);
  });

  it('orders a ring by count, then by key, so two equal buckets never swap between requests', () => {
    const report = buildUsageSurfaceReport(
      [
        row('total', null, { tracked: 6 }),
        row('form', 'tablet', { tracked: 2 }),
        row('form', 'desktop', { tracked: 2 }),
        row('form', 'mobile', { tracked: 2 }),
      ],
      GENERATED,
    );

    assert.deepEqual(report.formFactors.map((bucket) => bucket.key), ['desktop', 'mobile', 'tablet']);
  });

  it('reads an empty table as zeros and empty rings', () => {
    const report = buildUsageSurfaceReport([row('total', null)], GENERATED);

    assert.deepEqual(
      [report.surfaces, report.formFactors, report.operatingSystems, report.pwaInstallsByOs],
      [[], [], [], []],
    );
    assert.deepEqual([report.totalTracked, report.activeLast30d, report.pwaInstalls], [0, 0, 0]);
  });
});

describe('the report asks the database once', () => {
  it('runs a single statement, bound to the start of the 30-day window, and nothing else', async () => {
    const statements: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
    const prisma = new Proxy(
      {
        $queryRaw: async (query: { sql: string; values: unknown[] }) => {
          statements.push({ sql: query.sql, values: query.values });
          return [row('total', null, { tracked: 3, active: 2, installed: 1 }), row('surface', 'tma', { tracked: 3 })];
        },
      },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          // A second read of any kind — a model delegate, a count — is the
          // shape this report left behind: totals and rings from different
          // snapshots.
          throw new Error(`the report reached for prisma.${String(property)} besides its one statement`);
        },
      },
    );
    const before = Date.now();

    const report = await new BusinessAnalyticsService(prisma as never).getSurfaceAnalytics();

    assert.equal(statements.length, 1);
    const [statement] = statements;
    assert.match(statement.sql, /GROUP BY GROUPING SETS \(\("surface"\), \("form_factor"\), \("os"\), \("install_os"\), \(\)\)/);
    assert.equal(statement.sql.match(/FROM "users"/g)?.length, 1, 'the statement reads users once');
    assert.equal(statement.values.length, 1);
    const since = statement.values[0] as Date;
    assert.ok(since instanceof Date);
    assert.ok(Math.abs(before - 30 * DAY_MS - since.getTime()) < 5_000, `window starts ${since.toISOString()}`);
    assert.deepEqual(
      [report.totalTracked, report.activeLast30d, report.pwaInstalls, report.surfaces],
      [3, 2, 1, [{ key: 'tma', count: 3 }]],
    );
  });

  it('counts an install under its recorded OS first, the app’s last visit next, and names the rest as the SPA does', () => {
    const sql = usageSurfaceReportSql(new Date()).sql;
    const installOs = /CASE\s+WHEN "pwa_installed_at" IS NULL THEN NULL([\s\S]*?)END\s+AS "install_os"/.exec(sql)?.[1] ?? '';
    const branches = [...installOs.matchAll(/WHEN ([^\n]+?) THEN ([^\n]+)|ELSE ([^\n]+)/g)].map((m) => (m[3] ?? `${m[1]} → ${m[2]}`).trim());

    assert.deepEqual(branches, [
      '"pwa_installed_os" IS NOT NULL → "pwa_installed_os"',
      `"last_surface" = 'pwa' → COALESCE("last_os", 'other')`,
      `'${PWA_INSTALL_OS_UNKNOWN}'`,
    ]);
    assert.equal(PWA_INSTALL_OS_UNKNOWN, 'unknown');
  });
});

describe('the first open from the app writes its OS where the report reads it', () => {
  interface Write {
    readonly kind: 'update' | 'updateMany';
    readonly where: Record<string, unknown>;
    readonly data: Record<string, unknown>;
  }

  function edge(stampCount = 1) {
    const writes: Write[] = [];
    const milestones: Array<Record<string, unknown>> = [];
    const service = new InternalUserEdgeService(
      {
        user: {
          update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            writes.push({ kind: 'update', where: args.where, data: args.data });
            return { id: 'cmf0writer000000000000001' };
          },
          updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            writes.push({ kind: 'updateMany', where: args.where, data: args.data });
            return { count: stampCount };
          },
        },
      } as never,
      {} as never,
      {} as never,
      {
        info: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
          if (type === EVENT_TYPES.USER_PWA_INSTALLED) milestones.push(metadata);
        },
      } as never,
      {} as never,
    );
    return { service, writes, milestones };
  }

  it('in the same conditional update that stamps the install, clamped as the report counts it', async () => {
    const { service, writes, milestones } = edge();

    // As the cabinet sends it.
    await service.recordSurfaceSeen('777000111', { surface: 'pwa', formFactor: 'mobile', os: ' iOS ' });

    const stamp = writes.filter((write) => write.kind === 'updateMany');
    assert.equal(stamp.length, 1, 'one write stamps the install');
    assert.deepEqual(stamp[0].where, { id: 'cmf0writer000000000000001', pwaInstalledAt: null });
    assert.ok(stamp[0].data.pwaInstalledAt instanceof Date);
    assert.equal(stamp[0].data.pwaInstalledOs, 'ios');
    // The latest-visit snapshot is a different write, and never carries it.
    assert.equal(writes.find((write) => write.kind === 'update')?.data.pwaInstalledOs, undefined);
    // The milestone still says the same OS.
    assert.deepEqual(milestones.map((metadata) => metadata.os), ['ios']);
  });

  it('writes an OS the clamp does not know as "other", never the raw text', async () => {
    const { service, writes } = edge();

    await service.recordSurfaceSeen('777000111', { surface: 'pwa', formFactor: 'mobile', os: 'Symbian' });

    assert.equal(writes.find((write) => write.kind === 'updateMany')?.data.pwaInstalledOs, 'other');
  });

  it('writes nothing about an install from Telegram or a browser', async () => {
    for (const surface of ['tma', 'browser']) {
      const { service, writes } = edge();
      await service.recordSurfaceSeen('777000111', { surface, formFactor: 'desktop', os: 'windows' });
      assert.deepEqual(writes.map((write) => write.kind), ['update'], surface);
    }
  });
});
