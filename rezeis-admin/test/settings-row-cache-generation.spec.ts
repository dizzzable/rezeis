import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConfigType } from '@nestjs/config';
import { AccessMode, Currency, UserRole, type Prisma, type Settings } from '@prisma/client';

import type { appConfig } from '../src/common/config/app.config';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import type { ReiwaCacheInvalidatorService } from '../src/modules/bot-config/services/reiwa-cache-invalidator.service';
import type { BrandingSettingsInterface } from '../src/modules/settings/interfaces/branding-settings.interface';
import type { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';

/**
 * The settings row cache and the writes that race it
 * ═══════════════════════════════════════════════════
 * `SettingsService` keeps the settings row for five seconds. It used to CLEAR
 * that cache when a write transaction started, which is not invalidation:
 *
 *   - a read that began before the save and finished after it cached the old
 *     row with a fresh timestamp;
 *   - so did a read landing between the save's start and its commit;
 *   - and the save's own reiwa invalidation dropped the cabinet's cache, so the
 *     cabinet's next request re-read branding through exactly that entry and
 *     kept the old row for its own 60 seconds: the save looked lost for a
 *     minute. The last case below re-reads from inside the invalidation call,
 *     the earliest that request can possibly arrive.
 *
 * The fix is a generation the settings-write helper bumps once a write
 * transaction settles, checked on both sides of the cache: an entry is served
 * only while its generation is current, and a fetch stores its result only if
 * no write settled while it was in flight.
 *
 * Every read here is resolved BY HAND. The fake's `findFirst` returns a
 * promise the test settles with the row a real read would have seen at that
 * moment, which is the only way to put a read's start and its answer on
 * opposite sides of a commit on purpose. Whether a read went to the database
 * at all is visible as a pending entry in `pendingReads`.
 */

const CRYPT_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.test',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

const REQUEST_METADATA = {
  requestId: 'request-cache-generation',
  remoteAddress: '203.0.113.20',
  userAgent: 'settings-row-cache-generation-spec',
} as const;

/** A complete row, typed as Prisma's own `Settings`. */
function settingsRow(brandName: string): Settings {
  return {
    id: 1,
    rulesRequired: false,
    channelRequired: false,
    rulesLink: '',
    channelId: null,
    channelLink: '',
    accessMode: AccessMode.PUBLIC,
    inviteModeStartedAt: null,
    defaultCurrency: Currency.RUB,
    paymentOpsAlerts: {},
    systemNotifications: {},
    platformPolicy: {},
    userNotifications: {},
    referralSettings: {},
    partnerSettings: {},
    questPartnerSettings: {},
    multiSubscriptionSettings: {},
    brandingSettings: { brandName },
    supportSettings: {},
    botMenuSettings: {},
    remnawaveCleanupSettings: {},
    customIcons: [],
    aiSupportSettings: {},
    antiFraudSettings: {},
    pointsSettings: {},
    wheelSettings: {},
    updatedAt: new Date('2026-09-13T10:00:00.000Z'),
  };
}

/**
 * The Prisma surface these paths touch, in Prisma's own argument and row
 * types, so the doubles below are checked against it.
 */
interface FakeTransaction {
  readonly settings: {
    findFirst(args?: Prisma.SettingsFindFirstArgs): Promise<Settings | null>;
    update(args: Prisma.SettingsUpdateArgs): Promise<Settings>;
  };
  readonly adminAuditLog: {
    create(args: Prisma.AdminAuditLogCreateArgs): Promise<unknown>;
  };
  $queryRaw(query: Prisma.Sql): Promise<ReadonlyArray<{ readonly id: number }>>;
}

interface FakePrisma {
  readonly settings: {
    findFirst(args?: Prisma.SettingsFindFirstArgs): Promise<Settings | null>;
  };
  $transaction<T>(work: (tx: FakeTransaction) => Promise<T>): Promise<T>;
}

interface Harness {
  readonly service: SettingsService;
  /** Reads that went to the database and are waiting for an answer. */
  readonly pendingReads: Array<(row: Settings | null) => void>;
  /** Branding re-reads fired by the save's reiwa invalidation. */
  readonly relayReads: Array<Promise<BrandingSettingsInterface>>;
  committed(): Settings;
  resolveNextRead(row: Settings | null): void;
  save(brandName: string): Promise<BrandingSettingsInterface>;
  /** Keep the next write transaction from committing until `releaseCommit`. */
  holdCommit(): { readonly reachedCommit: Promise<void>; releaseCommit(): void };
}

function harness(options: { readonly relay: boolean }): Harness {
  let committed = settingsRow('Old Brand');
  let staged: Settings | null = null;
  const pendingReads: Array<(row: Settings | null) => void> = [];
  const relayReads: Array<Promise<BrandingSettingsInterface>> = [];
  let beforeCommit: () => Promise<void> = async () => undefined;

  const tx: FakeTransaction = {
    settings: {
      // Inside the write transaction the row is read under the lock, after
      // every earlier writer committed: the committed row, at once.
      findFirst: async () => committed,
      update: async ({ data }) => {
        staged = {
          ...committed,
          brandingSettings: (data.brandingSettings ?? committed.brandingSettings) as Prisma.JsonValue,
          updatedAt: new Date(),
        };
        return staged;
      },
    },
    adminAuditLog: { create: async () => ({}) },
    $queryRaw: async () => [{ id: committed.id }],
  };

  const prisma = {
    settings: {
      findFirst: () =>
        new Promise<Settings | null>((resolve) => {
          pendingReads.push(resolve);
        }),
    },
    $transaction: async <T>(work: (client: FakeTransaction) => Promise<T>): Promise<T> => {
      const result = await work(tx);
      await beforeCommit();
      if (staged !== null) committed = staged;
      staged = null;
      return result;
    },
  } satisfies FakePrisma;

  const invalidator = {
    // What the cabinet does when this webhook lands: re-read branding at once.
    invalidateBranding: async (_reason: string): Promise<void> => {
      relayReads.push(service.getBrandingSettings());
    },
  } satisfies Pick<ReiwaCacheInvalidatorService, 'invalidateBranding'>;

  // The constructor is typed with Nest's DI classes. The doubles are checked
  // against `FakePrisma` and the invalidator's own method signature above;
  // these casts only widen them to the class tokens.
  const service = new SettingsService(
    prisma as unknown as PrismaService,
    {} as IconUploadService,
    { cryptKey: CRYPT_KEY } as ConfigType<typeof appConfig>,
    undefined,
    undefined,
    options.relay ? (invalidator as unknown as ReiwaCacheInvalidatorService) : undefined,
  );

  return {
    service,
    pendingReads,
    relayReads,
    committed: () => committed,
    resolveNextRead: (row) => {
      const resolve = pendingReads.shift();
      assert.ok(resolve !== undefined, 'there is no read waiting for an answer');
      resolve(row);
    },
    save: (brandName) =>
      service.updateBrandingSettings({
        currentAdmin: ADMIN,
        requestMetadata: REQUEST_METADATA,
        updateBrandingSettingsDto: { brandName },
      }),
    holdCommit: () => {
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const reachedCommit = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeCommit = async () => {
        beforeCommit = async () => undefined;
        reached();
        await released;
      };
      return { reachedCommit, releaseCommit: () => release() };
    },
  };
}

describe('SettingsService row cache — a save is never answered with the row it replaced', () => {
  it('serves a repeated read from the cache when nothing was written (control)', async () => {
    // Without this, "the next read went to the database" below would also
    // hold for a service that never caches at all, and prove nothing about
    // which entries the cache refuses.
    const h = harness({ relay: false });
    const first = h.service.getBrandingSettings();
    h.resolveNextRead(h.committed());
    assert.equal((await first).brandName, 'Old Brand');

    const second = h.service.getBrandingSettings();
    assert.equal(h.pendingReads.length, 0, 'an unchanged row must be served from the cache');
    assert.equal((await second).brandName, 'Old Brand');
  });

  it('does not keep a read that began before a save and finished after it', async () => {
    const h = harness({ relay: false });

    // The read starts while the stored brand is still the old one...
    const early = h.service.getBrandingSettings();
    assert.equal(h.pendingReads.length, 1);

    // ...the operator's save commits while it is still in flight...
    await h.save('New Brand');

    // ...and its answer arrives afterwards, from the snapshot it started with.
    h.resolveNextRead(settingsRow('Old Brand'));
    assert.equal((await early).brandName, 'Old Brand', 'the early read may answer with what it saw');

    const next = h.service.getBrandingSettings();
    assert.equal(
      h.pendingReads.length,
      1,
      'the next read must go to the database, not to a cache the early read refilled',
    );
    h.resolveNextRead(h.committed());
    assert.equal((await next).brandName, 'New Brand');
  });

  it('does not let a read taken between a save and its commit outlive the commit', async () => {
    const h = harness({ relay: false });
    const gate = h.holdCommit();

    const saving = h.save('New Brand');
    await gate.reachedCommit;

    // The write has run its statements and has not committed: a read now sees
    // the old row, and caching it is legitimate — until the commit.
    const during = h.service.getBrandingSettings();
    h.resolveNextRead(h.committed());
    assert.equal((await during).brandName, 'Old Brand');

    gate.releaseCommit();
    await saving;

    const after = h.service.getBrandingSettings();
    assert.equal(h.pendingReads.length, 1, 'the entry cached before the commit must not survive it');
    h.resolveNextRead(h.committed());
    assert.equal((await after).brandName, 'New Brand');
  });

  it("answers the cabinet's re-read, fired by the save's own invalidation, with the saved row", async () => {
    const h = harness({ relay: true });

    // A busy panel: the cache already holds the current row.
    const primed = h.service.getBrandingSettings();
    h.resolveNextRead(h.committed());
    assert.equal((await primed).brandName, 'Old Brand');

    await h.save('New Brand');

    assert.equal(h.relayReads.length, 1, 'the save must have fired the branding invalidation');
    assert.equal(
      h.pendingReads.length,
      1,
      'the re-read the invalidation triggers must miss the cache — the generation is bumped before it fires',
    );
    h.resolveNextRead(h.committed());
    assert.equal((await h.relayReads[0]!).brandName, 'New Brand');
  });
});
