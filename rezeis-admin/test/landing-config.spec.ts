import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { DEFAULT_LANDING_CONFIG } from '../src/modules/landing-config/landing-config.default';
import { migrateLandingConfig } from '../src/modules/landing-config/landing-config.migrations';
import {
  collectPublishStrictIssues,
  landingConfigSchema,
  LANDING_SCHEMA_VERSION,
  type LandingConfigPayload,
} from '../src/modules/landing-config/landing-config.schema';
import { LandingConfigService } from '../src/modules/landing-config/services/landing-config.service';

const CURRENT_ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-04-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

const REQUEST_METADATA = {
  requestId: 'req-1',
  remoteAddress: '203.0.113.1',
  userAgent: 'landing-spec',
} as const;

/** A minimal invalidator that records how many times invalidateLanding fired. */
function createInvalidatorSpy(): { service: unknown; calls: string[] } {
  const calls: string[] = [];
  const service = {
    invalidateLanding: async (reason: string): Promise<boolean> => {
      calls.push(reason);
      return true;
    },
  };
  return { service, calls };
}

interface PrismaMockState {
  configRow: Record<string, unknown> | null;
  revisions: Array<Record<string, unknown>>;
  auditLogs: Array<Record<string, unknown>>;
}

/**
 * Builds a prisma mock backing `landingConfig` / `landingRevision` /
 * `adminAuditLog` plus a `$transaction` that runs the callback with the same
 * client (single connection, good enough for these unit assertions).
 */
function createPrismaMock(state: PrismaMockState): unknown {
  let revisionSeq = state.revisions.length;
  const client = {
    landingConfig: {
      findUnique: async () => state.configRow,
      count: async () => (state.configRow === null ? 0 : 1),
      upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        if (state.configRow === null) {
          state.configRow = { key: 'default', ...args.create };
        } else {
          state.configRow = { ...state.configRow, ...args.update };
        }
        return state.configRow;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        state.configRow = { ...(state.configRow ?? { key: 'default' }), ...args.data };
        return state.configRow;
      },
    },
    landingRevision: {
      create: async (args: { data: Record<string, unknown> }) => {
        revisionSeq += 1;
        const row = {
          id: `rev-${revisionSeq}`,
          publishedAt: new Date(2026, 0, revisionSeq),
          ...args.data,
        };
        state.revisions.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string } }) =>
        state.revisions.find((row) => row['id'] === args.where.id) ?? null,
      findMany: async () =>
        [...state.revisions].sort(
          (a, b) => (b['publishedAt'] as Date).getTime() - (a['publishedAt'] as Date).getTime(),
        ),
      deleteMany: async (args: { where: { id: { notIn: string[] } } }) => {
        const keep = new Set(args.where.id.notIn);
        const before = state.revisions.length;
        state.revisions = state.revisions.filter((row) => keep.has(row['id'] as string));
        return { count: before - state.revisions.length };
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.auditLogs.push(args.data);
        return args.data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return client;
}

function enabledConfig(): LandingConfigPayload {
  return { ...DEFAULT_LANDING_CONFIG, enabled: true };
}

describe('landing-config schema', () => {
  it('accepts the bundled default template', () => {
    const parsed = landingConfigSchema.safeParse(DEFAULT_LANDING_CONFIG);
    assert.equal(parsed.success, true);
  });

  it('rejects a javascript: URL in a CTA', () => {
    const bad = {
      ...DEFAULT_LANDING_CONFIG,
      sections: [
        {
          id: 'hero',
          type: 'hero',
          visible: true,
          data: {
            heading: { ru: 'a', en: 'b' },
            primaryCta: {
              label: { ru: 'a', en: 'b' },
              action: 'url',
              url: ['java', 'script:alert(1)'].join(''),
            },
            align: 'center',
          },
        },
      ],
    };
    const parsed = landingConfigSchema.safeParse(bad);
    assert.equal(parsed.success, false);
  });

  it('accepts a site-relative URL', () => {
    const parsed = landingConfigSchema.safeParse({
      ...DEFAULT_LANDING_CONFIG,
      sections: [
        {
          id: 'f',
          type: 'footer',
          visible: true,
          data: {
            columns: [
              { title: { ru: 'a', en: 'b' }, links: [{ label: { ru: 'a', en: 'b' }, href: '/sign-in' }] },
            ],
          },
        },
      ],
    });
    assert.equal(parsed.success, true);
  });

  it('publish-strict flags a missing en translation on a visible section', () => {
    const config = enabledConfig();
    const withGap: LandingConfigPayload = {
      ...config,
      sections: [
        {
          id: 'hero',
          type: 'hero',
          visible: true,
          data: {
            heading: { ru: 'Только русский' },
            primaryCta: { label: { ru: 'Старт', en: 'Start' }, action: 'register' },
            align: 'center',
          },
        },
      ],
    };
    const issues = collectPublishStrictIssues(withGap);
    assert.ok(issues.some((issue) => issue.message.includes('en')));
  });

  it('publish-strict passes for the fully-localized default', () => {
    const issues = collectPublishStrictIssues(enabledConfig());
    assert.deepEqual(issues, []);
  });

  it('publish-strict ignores hidden sections', () => {
    const config: LandingConfigPayload = {
      ...enabledConfig(),
      sections: [
        {
          id: 'hero',
          type: 'hero',
          visible: false,
          data: {
            heading: { ru: 'only-ru' },
            primaryCta: { label: { ru: 'a', en: 'b' }, action: 'register' },
            align: 'center',
          },
        },
      ],
    };
    assert.deepEqual(collectPublishStrictIssues(config), []);
  });
});

describe('landing-config migrations', () => {
  it('stamps an old config forward to the current schema version', () => {
    const migrated = migrateLandingConfig({ schemaVersion: 0, enabled: false });
    assert.equal(migrated['schemaVersion'], LANDING_SCHEMA_VERSION);
  });

  it('leaves a current config untouched', () => {
    const migrated = migrateLandingConfig({ schemaVersion: LANDING_SCHEMA_VERSION, enabled: true });
    assert.equal(migrated['schemaVersion'], LANDING_SCHEMA_VERSION);
    assert.equal(migrated['enabled'], true);
  });
});

describe('LandingConfigService', () => {
  it('getDraft returns the bundled default at version 0 when nothing stored', async () => {
    const state: PrismaMockState = { configRow: null, revisions: [], auditLogs: [] };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );
    const draft = await service.getDraft();
    assert.equal(draft.version, 0);
    assert.equal(draft.stored, false);
    assert.equal(draft.config.sections.length, DEFAULT_LANDING_CONFIG.sections.length);
  });

  it('getDraft flags a corrupted stored draft instead of silently serving the default', async () => {
    // Regression: this used to fall back to DEFAULT_LANDING_CONFIG with no
    // signal at all, so the builder opened a blank landing over the operator's
    // real content and the first autosave destroyed it. The fallback stays
    // (something must render), but it now announces itself and carries the raw
    // row so the original can be recovered.
    const state: PrismaMockState = {
      configRow: {
        key: 'default',
        draft: { schemaVersion: 1, enabled: true, sections: 'not-an-array' },
        version: 12,
        publishedRevisionId: null,
      },
      revisions: [],
      auditLogs: [],
    };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );

    const draft = await service.getDraft();

    assert.ok(draft.corrupted, 'expected the corrupted marker to be present');
    assert.ok(draft.corrupted.issues.length > 0, 'expected at least one schema issue');
    assert.ok(
      draft.corrupted.issues.every(
        (issue) => typeof issue.path === 'string' && typeof issue.message === 'string',
      ),
      'issues must be serialisable {path, message} pairs',
    );
    // The raw row travels back untouched so the operator can export it.
    assert.deepEqual(draft.corrupted.raw, state.configRow?.draft);
    // Version is preserved: a later save must still hit the optimistic-lock check.
    assert.equal(draft.version, 12);
    assert.equal(draft.stored, true);
  });

  it('getDraft reports no corruption for a valid stored draft', async () => {
    const state: PrismaMockState = {
      configRow: { key: 'default', draft: DEFAULT_LANDING_CONFIG, version: 3, publishedRevisionId: null },
      revisions: [],
      auditLogs: [],
    };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );

    const draft = await service.getDraft();

    assert.equal(draft.corrupted, undefined);
    assert.equal(draft.version, 3);
  });

  it('saveDraft rejects a stale version with 409 and does not invalidate', async () => {
    const state: PrismaMockState = {
      configRow: { key: 'default', draft: DEFAULT_LANDING_CONFIG, version: 5, publishedRevisionId: null },
      revisions: [],
      auditLogs: [],
    };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );
    await assert.rejects(
      () => service.saveDraft(enabledConfig(), 4),
      (err: unknown) => err instanceof ConflictException,
    );
    assert.equal(invalidator.calls.length, 0);
  });

  it('saveDraft bumps the version and never invalidates the cache', async () => {
    const state: PrismaMockState = {
      configRow: { key: 'default', draft: DEFAULT_LANDING_CONFIG, version: 2, publishedRevisionId: null },
      revisions: [],
      auditLogs: [],
    };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );
    const result = await service.saveDraft(enabledConfig(), 2);
    assert.equal(result.version, 3);
    assert.equal(invalidator.calls.length, 0);
  });

  it('publish appends a revision, repoints, audits and invalidates', async () => {
    const state: PrismaMockState = {
      configRow: { key: 'default', draft: enabledConfig(), version: 1, publishedRevisionId: null },
      revisions: [],
      auditLogs: [],
    };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );
    const { revisionId } = await service.publish(CURRENT_ADMIN, REQUEST_METADATA);
    assert.ok(revisionId.startsWith('rev-'));
    assert.equal(state.revisions.length, 1);
    assert.equal(state.configRow?.['publishedRevisionId'], revisionId);
    assert.equal(state.auditLogs.length, 1);
    assert.equal(state.auditLogs[0]?.['action'], 'landing.published');
    assert.deepEqual(invalidator.calls, ['publish']);
  });

  it('publish is blocked (400) when a visible string is missing a locale', async () => {
    const incomplete: LandingConfigPayload = {
      ...enabledConfig(),
      sections: [
        {
          id: 'hero',
          type: 'hero',
          visible: true,
          data: {
            heading: { ru: 'только ru' },
            primaryCta: { label: { ru: 'a', en: 'b' }, action: 'register' },
            align: 'center',
          },
        },
      ],
    };
    const state: PrismaMockState = {
      configRow: { key: 'default', draft: incomplete, version: 1, publishedRevisionId: null },
      revisions: [],
      auditLogs: [],
    };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );
    await assert.rejects(
      () => service.publish(CURRENT_ADMIN, REQUEST_METADATA),
      (err: unknown) => err instanceof BadRequestException,
    );
    assert.equal(state.revisions.length, 0);
    assert.equal(invalidator.calls.length, 0);
  });

  it('rollback of a missing revision throws 404', async () => {
    const state: PrismaMockState = {
      configRow: { key: 'default', draft: enabledConfig(), version: 1, publishedRevisionId: null },
      revisions: [],
      auditLogs: [],
    };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );
    await assert.rejects(
      () => service.rollback('rev-nope', CURRENT_ADMIN, REQUEST_METADATA),
      (err: unknown) => err instanceof NotFoundException,
    );
  });

  it('getEffectivePublished returns the disabled sentinel when nothing published', async () => {
    const state: PrismaMockState = { configRow: null, revisions: [], auditLogs: [] };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );
    const effective = await service.getEffectivePublished();
    assert.deepEqual(effective, { enabled: false });
  });

  it('getEffectivePublished returns the sentinel when the published config is disabled', async () => {
    const disabledRevision = { ...DEFAULT_LANDING_CONFIG, enabled: false };
    const state: PrismaMockState = {
      configRow: { key: 'default', draft: DEFAULT_LANDING_CONFIG, version: 1, publishedRevisionId: 'rev-1' },
      revisions: [
        { id: 'rev-1', schemaVersion: LANDING_SCHEMA_VERSION, config: disabledRevision, publishedBy: 'admin-1', publishedAt: new Date(2026, 0, 1) },
      ],
      auditLogs: [],
    };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );
    assert.deepEqual(await service.getEffectivePublished(), { enabled: false });
  });

  it('getEffectivePublished returns the published config when enabled with visible sections', async () => {
    const state: PrismaMockState = {
      configRow: { key: 'default', draft: enabledConfig(), version: 1, publishedRevisionId: 'rev-1' },
      revisions: [
        { id: 'rev-1', schemaVersion: LANDING_SCHEMA_VERSION, config: enabledConfig(), publishedBy: 'admin-1', publishedAt: new Date(2026, 0, 1) },
      ],
      auditLogs: [],
    };
    const invalidator = createInvalidatorSpy();
    const service = new LandingConfigService(
      createPrismaMock(state) as never,
      invalidator.service as never,
    );
    const effective = await service.getEffectivePublished();
    assert.equal((effective as LandingConfigPayload).enabled, true);
  });
});
