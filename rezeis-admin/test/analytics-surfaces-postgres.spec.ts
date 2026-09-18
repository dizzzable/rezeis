import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import type { UsageSurfaceReportInterface } from '../src/modules/business-analytics/interfaces/business-analytics.types';
import { BusinessAnalyticsService } from '../src/modules/business-analytics/services/business-analytics.service';
import type { FxRateService } from '../src/modules/fx/fx-rate.service';
import type { SettingsService } from '../src/modules/settings/services/settings.service';
import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';

Logger.overrideLogger(false);

/**
 * The install's OS, from the write to the ring, on PostgreSQL.
 *
 * Three things only a real engine can settle:
 *
 *   1. the migration carries over the OS of the FIRST open for installs older
 *      than the column — from the milestone's audit rows, the earliest valid one
 *      per customer, never over a value already there — and replays as a no-op;
 *   2. the report's one statement puts every customer in the right bucket of
 *      every ring (`GROUPING SETS`, `FILTER`, NULLs that mean "no value" versus
 *      NULLs a grouping leaves behind) and every ring adds up to its total;
 *   3. what the cabinet's surface report writes is what the report counts.
 *
 * Everything runs inside a transaction that is rolled back: the database is
 * shared by the whole job, and other specs' customers are in `users` too. So
 * figures are read as the DIFFERENCE this spec's customers make, and agreement
 * is checked on the whole table.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `asp${process.pid}x${Date.now()}`;
const MIGRATION = '20260915210000_user_pwa_installed_os';
const ACTION = 'event.user.pwa_installed';
const DAY_MS = 86_400_000;
let prisma: PrismaService;

class RolledBack extends Error {}

/** Run `body` in a transaction that never commits, and hand back what it observed. */
async function inRolledBackTransaction<T>(body: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let observed: { value: T } | null = null;
  await assert.rejects(
    prisma.$transaction(
      async (tx) => {
        observed = { value: await body(tx) };
        throw new RolledBack();
      },
      { maxWait: 15_000, timeout: 60_000 },
    ),
    RolledBack,
  );
  assert.ok(observed !== null, 'the transaction never reached its observations');
  return (observed as { value: T }).value;
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

interface Customer {
  readonly id: string;
  readonly lastSeenAt?: Date | null;
  readonly lastSurface?: string | null;
  readonly lastFormFactor?: string | null;
  readonly lastOs?: string | null;
  readonly pwaInstalledAt?: Date | null;
  readonly pwaInstalledOs?: string | null;
}

async function seed(tx: Prisma.TransactionClient, customers: readonly Customer[]): Promise<void> {
  for (const customer of customers) {
    await tx.user.create({
      data: {
        id: customer.id,
        referralCode: `${customer.id}-ref`,
        name: customer.id,
        lastSeenAt: customer.lastSeenAt ?? null,
        lastSurface: customer.lastSurface ?? null,
        lastFormFactor: customer.lastFormFactor ?? null,
        lastOs: customer.lastOs ?? null,
        pwaInstalledAt: customer.pwaInstalledAt ?? null,
        pwaInstalledOs: customer.pwaInstalledOs ?? null,
      },
    });
  }
}

/** The surfaces report counts no days: it must not even ask for the operator's time zone. */
const NO_ZONE = ({
  getPlatformBranding: () => Promise.reject(new Error('the surfaces report read the time zone setting')),
} satisfies Pick<SettingsService, 'getPlatformBranding'>) as unknown as SettingsService;

const report = (tx: Prisma.TransactionClient): Promise<UsageSurfaceReportInterface> =>
  new BusinessAnalyticsService(
    tx as never,
    ({ getBaseCurrency: () => 'RUB' } satisfies Pick<FxRateService, 'getBaseCurrency'>) as unknown as FxRateService,
    NO_ZONE,
  ).getSurfaceAnalytics();

type Ring = 'surfaces' | 'formFactors' | 'operatingSystems' | 'pwaInstallsByOs';
const RINGS: readonly Ring[] = ['surfaces', 'formFactors', 'operatingSystems', 'pwaInstallsByOs'];

/** What this spec's customers added to every figure: `after − before`, buckets that did not move left out. */
function difference(beforeReport: UsageSurfaceReportInterface, afterReport: UsageSurfaceReportInterface) {
  const ring = (name: Ring): Record<string, number> => {
    const was = new Map(beforeReport[name].map((bucket) => [bucket.key, bucket.count]));
    return Object.fromEntries(
      afterReport[name]
        .map((bucket) => [bucket.key, bucket.count - (was.get(bucket.key) ?? 0)] as const)
        .filter(([, delta]) => delta !== 0),
    );
  };
  return {
    totalTracked: afterReport.totalTracked - beforeReport.totalTracked,
    activeLast30d: afterReport.activeLast30d - beforeReport.activeLast30d,
    pwaInstalls: afterReport.pwaInstalls - beforeReport.pwaInstalls,
    surfaces: ring('surfaces'),
    formFactors: ring('formFactors'),
    operatingSystems: ring('operatingSystems'),
    pwaInstallsByOs: ring('pwaInstallsByOs'),
  };
}

/** Every ring adds up to the total printed beside it — on the whole table, not just this spec's rows. */
function assertRingsAddUp(figures: UsageSurfaceReportInterface): void {
  const sum = (name: Ring): number => figures[name].reduce((total, bucket) => total + bucket.count, 0);
  assert.equal(sum('surfaces'), figures.totalTracked, 'surfaces vs «С телеметрией»');
  assert.equal(sum('formFactors'), figures.totalTracked, 'devices vs «С телеметрией»');
  assert.equal(sum('operatingSystems'), figures.totalTracked, 'OS vs «С телеметрией»');
  assert.equal(sum('pwaInstallsByOs'), figures.pwaInstalls, 'installs by OS vs «Установок PWA»');
  for (const name of RINGS) {
    assert.equal(new Set(figures[name].map((bucket) => bucket.key)).size, figures[name].length, `${name}: a key twice`);
  }
}

run('the install’s OS, from the write to the ring, on PostgreSQL', () => {
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

  it('carries the earliest valid audit row over to installs that have no OS yet, and replays as a no-op', async () => {
    const migrationSql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', MIGRATION, 'migration.sql'), 'utf8');
    // A user id made only of digits, so a JSON NUMBER `userId` spells it exactly.
    const numericId = `9${String(process.pid).padStart(6, '0')}${String(Date.now()).slice(-8)}`;
    const id = (name: string): string => `${prefix}${name}`;

    const read = async (tx: Prisma.TransactionClient) =>
      Object.fromEntries(
        (
          await tx.user.findMany({
            where: { OR: [{ id: { startsWith: prefix } }, { id: numericId }] },
            select: { id: true, pwaInstalledOs: true },
          })
        ).map((user) => [user.id === numericId ? 'numeric' : user.id.slice(prefix.length), user.pwaInstalledOs]),
      );

    const observed = await inRolledBackTransaction(async (tx) => {
      await seed(tx, [
        { id: id('twoValidRows'), pwaInstalledAt: daysAgo(40) },
        { id: id('invalidFirstRow'), pwaInstalledAt: daysAgo(40) },
        { id: id('alreadyWritten'), pwaInstalledAt: daysAgo(10), pwaInstalledOs: 'windows' },
        { id: numericId, pwaInstalledAt: daysAgo(40) },
        { id: id('neverInstalled'), pwaInstalledAt: null },
        { id: id('noRowAtAll'), pwaInstalledAt: daysAgo(400) },
        { id: id('otherActionOnly'), pwaInstalledAt: daysAgo(40) },
      ]);
      const audit = (userId: unknown, os: unknown, createdAt: Date, action = ACTION) =>
        tx.adminAuditLog.create({
          data: { action, ipAddress: 'system', userAgent: 'rezeis-admin/system-events', metadata: { category: 'USER', userId, os } as Prisma.InputJsonValue, createdAt },
        });
      // Written newest first on purpose: only the ordering can find the first open.
      await audit(id('twoValidRows'), 'android', daysAgo(5));
      await audit(id('twoValidRows'), 'ios', daysAgo(40));
      await audit(id('invalidFirstRow'), 'android', daysAgo(20));
      await audit(id('invalidFirstRow'), 'beos', daysAgo(40));
      await audit(id('alreadyWritten'), 'ios', daysAgo(10));
      await audit(Number(numericId), 'ios', daysAgo(40));
      await audit(id('neverInstalled'), 'ios', daysAgo(40));
      await audit(id('otherActionOnly'), 'ios', daysAgo(40), 'event.user.registered');

      await tx.$executeRawUnsafe(migrationSql);
      const first = await read(tx);
      await tx.$executeRawUnsafe(migrationSql);
      return { first, replay: await read(tx) };
    });

    assert.deepEqual(observed.first, {
      twoValidRows: 'ios',
      invalidFirstRow: 'android',
      alreadyWritten: 'windows',
      numeric: null,
      neverInstalled: null,
      noRowAtAll: null,
      otherActionOnly: null,
    });
    assert.deepEqual(observed.replay, observed.first, 'running the migration again changed something');
  });

  it('puts every customer in the right bucket of every ring, and every ring adds up to its total', async () => {
    const id = (name: string): string => `${prefix}${name}`;
    const active = daysAgo(2);
    const observed = await inRolledBackTransaction(async (tx) => {
      const beforeReport = await report(tx);
      await seed(tx, [
        { id: id('telegramIos'), lastSeenAt: active, lastSurface: 'tma', lastFormFactor: 'mobile', lastOs: 'ios' },
        { id: id('lapsedWindows'), lastSeenAt: daysAgo(40), lastSurface: 'browser', lastFormFactor: 'desktop', lastOs: 'windows' },
        // Installed; the column names the OS of the first open.
        { id: id('appAndroid'), lastSeenAt: active, lastSurface: 'pwa', lastFormFactor: 'mobile', lastOs: 'android', pwaInstalledAt: daysAgo(30), pwaInstalledOs: 'android' },
        // Installed before the column, last seen in Telegram: unknown.
        { id: id('installedBackInTelegram'), lastSeenAt: active, lastSurface: 'tma', lastFormFactor: 'mobile', lastOs: 'ios', pwaInstalledAt: daysAgo(300) },
        // Installed before the column, last seen in the app: the app's OS.
        { id: id('installedStillInApp'), lastSeenAt: active, lastSurface: 'pwa', lastFormFactor: 'tablet', lastOs: 'ios', pwaInstalledAt: daysAgo(300) },
        // Installed on an iPhone, since seen in a Windows browser: iOS.
        { id: id('installedIosNowDesktop'), lastSeenAt: active, lastSurface: 'browser', lastFormFactor: 'desktop', lastOs: 'windows', pwaInstalledAt: daysAgo(20), pwaInstalledOs: 'ios' },
        // Installed on an iPhone, now opening the app on an Android tablet: still the FIRST open's iOS.
        { id: id('firstOpenBeatsLastApp'), lastSeenAt: active, lastSurface: 'pwa', lastFormFactor: 'tablet', lastOs: 'android', pwaInstalledAt: daysAgo(20), pwaInstalledOs: 'ios' },
        // Never reported anything.
        { id: id('untracked') },
        // Tracked with no values at all, and installed: "other" in the three, unknown in installs.
        { id: id('noValues'), lastSeenAt: active, pwaInstalledAt: daysAgo(5) },
        // The clamp's own "other".
        { id: id('clampedOther'), lastSeenAt: active, lastSurface: 'browser', lastFormFactor: 'desktop', lastOs: 'other' },
      ]);
      const afterReport = await report(tx);
      return { beforeReport, afterReport };
    });

    assert.deepEqual(difference(observed.beforeReport, observed.afterReport), {
      totalTracked: 9,
      activeLast30d: 8,
      pwaInstalls: 6,
      surfaces: { tma: 2, browser: 3, pwa: 3, other: 1 },
      formFactors: { mobile: 3, desktop: 3, tablet: 2, other: 1 },
      operatingSystems: { ios: 3, windows: 2, android: 2, other: 2 },
      pwaInstallsByOs: { android: 1, unknown: 2, ios: 3 },
    });
    assertRingsAddUp(observed.beforeReport);
    assertRingsAddUp(observed.afterReport);
  });

  it('counts an install under the OS the cabinet reported on the first open from the app, however it is opened later', async () => {
    const userId = `${prefix}writer`;
    const observed = await inRolledBackTransaction(async (tx) => {
      const beforeReport = await report(tx);
      await seed(tx, [{ id: userId }]);
      const edge = new InternalUserEdgeService(tx as never, {} as never, {} as never, { info: () => undefined } as never, {} as never);

      // As the cabinet sends it, then a Windows browser, then the app on Android.
      await edge.recordSurfaceSeen(userId, { surface: 'pwa', formFactor: 'mobile', os: ' iOS ' });
      await edge.recordSurfaceSeen(userId, { surface: 'browser', formFactor: 'desktop', os: 'windows' });
      await edge.recordSurfaceSeen(userId, { surface: 'pwa', formFactor: 'tablet', os: 'android' });

      const stored = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { pwaInstalledAt: true, pwaInstalledOs: true, lastOs: true, lastSurface: true },
      });
      return { stored, beforeReport, afterReport: await report(tx) };
    });

    assert.ok(observed.stored.pwaInstalledAt instanceof Date);
    assert.equal(observed.stored.pwaInstalledOs, 'ios');
    assert.deepEqual([observed.stored.lastSurface, observed.stored.lastOs], ['pwa', 'android']);
    assert.deepEqual(difference(observed.beforeReport, observed.afterReport).pwaInstallsByOs, { ios: 1 });
  });
});
