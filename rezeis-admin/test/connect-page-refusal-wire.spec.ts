import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, BadRequestException } from '@nestjs/common';

import {
  AdminSafeExceptionFilter,
  CODES_CARRYING_ISSUES,
  SAFE_PRODUCT_CODES,
} from '../src/common/filters/admin-safe-exception.filter';
import {
  CONNECT_PAGE_CATALOG_INVALID,
  ConnectPageService,
} from '../src/modules/subpage-config/connect-page/connect-page.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * What the editor actually receives when a save is refused.
 *
 * The service has thrown per-row diagnostics since the day it was written, and
 * the editor has read them since the day IT was written, and for the whole time
 * in between the operator saw four words and no rows — because the global
 * exception filter rebuilds every response body from an allowlist and `issues`
 * was not on it. Nothing was red. `connect-page.service.spec.ts` asserts on the
 * thrown exception's own body, which never passes through the filter, so it
 * stayed green while the screen it was defending said nothing.
 *
 * So these tests deliberately do not build an exception by hand for the cases
 * that matter. They call the real service, catch what it really throws, and
 * push THAT through the real filter — the two ends of the wire, with nothing
 * in between standing in for either. The hand-built exceptions further down
 * test the filter's own rules, which is the one place a stand-in is the subject.
 */

type Row = { key: string; config: unknown };

function service() {
  const store = new Map<string, unknown>();
  const prisma = {
    subpageConfig: {
      findUnique: ({ where }: { where: { key: string } }) =>
        Promise.resolve(store.has(where.key) ? { key: where.key, config: store.get(where.key) } : null),
      count: ({ where }: { where: { key: string } }) => Promise.resolve(store.has(where.key) ? 1 : 0),
      upsert: ({ where, create, update }: { where: { key: string }; create: Row; update: { config: unknown } }) => {
        store.set(where.key, store.has(where.key) ? update.config : create.config);
        return Promise.resolve({ key: where.key, config: store.get(where.key) });
      },
    },
  } as unknown as PrismaService;
  return new ConnectPageService(prisma);
}

/** A catalog that parses; `featured` is the knob each test turns. */
function catalog(featured: boolean) {
  return {
    version: 2,
    connectScreenEnabled: false,
    icons: { happ: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>' },
    platforms: [
      {
        id: 'ios',
        title: { ru: 'iOS', en: 'iOS' },
        iconKey: null,
        apps: [
          {
            id: 'happ',
            name: 'Happ',
            iconKey: 'happ',
            featured,
            steps: [
              {
                title: { ru: 'Добавьте', en: 'Add' },
                body: null,
                iconKey: null,
                buttons: [{ kind: 'copyLink', label: { ru: 'Копировать', en: 'Copy' } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('a refused catalog names its rows on the wire', () => {
  it('carries the audit rows the editor scrolls to', async () => {
    // No recommended app: the audit refuses, and the refusal is worthless
    // without saying which platform.
    const thrown = await refusalFrom(() => service().replaceConfig(catalog(false)));
    const body = throughFilter(thrown);

    assert.equal(body.statusCode, 400);
    assert.equal(body.code, CONNECT_PAGE_CATALOG_INVALID);
    const issues = assertIssues(body.issues);
    assert.equal(issues.length > 0, true);
    assert.equal(
      issues.some((issue) => issue.message.includes('no recommended app')),
      true,
      'the row that explains the refusal did not survive the filter',
    );
    assert.equal(
      issues.every((issue) => typeof issue.path === 'string'),
      true,
    );
  });

  it('carries the schema rows too, not only the audit ones', async () => {
    // A different throw site inside the same method, and it was missing the
    // code first: a catalog with no platforms never reaches the audit.
    const thrown = await refusalFrom(() =>
      service().replaceConfig({ version: 2, connectScreenEnabled: false, icons: {}, platforms: [] }),
    );
    const body = throughFilter(thrown);

    assert.equal(body.code, CONNECT_PAGE_CATALOG_INVALID);
    const issues = assertIssues(body.issues);
    assert.equal(issues.length > 0, true);
    assert.equal(issues[0]?.path.startsWith('platforms'), true);
  });

  it('says nothing extra when the catalog is fine', async () => {
    await service().replaceConfig(catalog(true));
  });
});

describe('the allowlists that let those rows through', () => {
  it('lists the code in both sets', () => {
    assert.equal(SAFE_PRODUCT_CODES.has(CONNECT_PAGE_CATALOG_INVALID), true);
    assert.equal(CODES_CARRYING_ISSUES.has(CONNECT_PAGE_CATALOG_INVALID), true);
  });

  it('keeps the issue-carrying set contained in the product set', () => {
    // The same subset rule `CODES_CARRYING_REAUTH_FACTOR` has, and for the same
    // reason: a code listed only in the narrow set forwards nothing at all,
    // because the payload it is fed comes from the product allowlist.
    for (const code of CODES_CARRYING_ISSUES) {
      assert.equal(SAFE_PRODUCT_CODES.has(code), true, `${code} carries issues but is not a safe product code`);
    }
  });

  it('drops the rows for a code that does not declare it carries them', () => {
    const body = throughFilter(
      new BadRequestException({
        code: 'REGISTRATION_DISABLED',
        message: 'nope',
        issues: [{ path: 'platforms[0]', message: 'should not appear' }],
      }),
    );

    assert.equal(body.code, 'REGISTRATION_DISABLED');
    assert.equal('issues' in body, false);
  });

  it('drops the rows entirely when the code is not allowlisted at all', () => {
    const body = throughFilter(
      new BadRequestException({
        code: 'MADE_UP_CODE',
        message: 'nope',
        issues: [{ path: 'platforms[0]', message: 'should not appear' }],
      }),
    );

    assert.equal('code' in body, false);
    assert.equal('issues' in body, false);
  });
});

describe('each row is rebuilt, never forwarded', () => {
  it('keeps the two fields and leaves everything else behind', () => {
    const body = throughFilter(
      refusal([
        {
          path: 'platforms[0].apps[0]',
          message: 'no recommended app',
          sql: 'select * from subpage_configs',
          stack: 'at ConnectPageService.replaceConfig',
        },
      ]),
    );

    const issues = assertIssues(body.issues);
    assert.deepEqual(issues, [{ path: 'platforms[0].apps[0]', message: 'no recommended app' }]);
    assert.equal(JSON.stringify(body).includes('subpage_configs'), false);
    assert.equal(JSON.stringify(body).includes('ConnectPageService'), false);
  });

  it('skips a row whose halves are not both strings', () => {
    const body = throughFilter(
      refusal([
        { path: 'platforms[0]', message: { nested: 'object' } },
        { path: 42, message: 'a number is not a path' },
        { path: 'platforms[1]', message: 'this one is fine' },
      ]),
    );

    assert.deepEqual(assertIssues(body.issues), [{ path: 'platforms[1]', message: 'this one is fine' }]);
  });

  it('scrubs a row that quotes something it should not, and keeps its address', () => {
    // Half of what a row quotes is text the operator typed. The scrub is what
    // stops a submitted document from choosing what this filter says.
    const body = throughFilter(
      refusal([
        {
          path: 'platforms[0].apps[0]',
          message: 'App "postgres://admin:secret-password@db.internal/rezeis" has no way to hand over',
        },
      ]),
    );

    const issues = assertIssues(body.issues);
    assert.equal(issues[0]?.path, 'platforms[0].apps[0]');
    assert.equal(issues[0]?.message.includes('postgres://'), false);
    assert.equal(issues[0]?.message.includes('secret-password'), false);
    assert.equal(JSON.stringify(body).includes('secret-password'), false);
  });

  it('caps the list so a refusal cannot become a payload', () => {
    const body = throughFilter(
      refusal(Array.from({ length: 50 }, (_, index) => ({ path: `platforms[${index}]`, message: 'bad' }))),
    );

    assert.equal(assertIssues(body.issues).length, 20);
  });

  it('drops a row whose text is longer than a diagnostic ever is', () => {
    const body = throughFilter(
      refusal([
        { path: 'platforms[0]', message: 'x'.repeat(301) },
        { path: `platforms[0].${'y'.repeat(200)}`, message: 'short' },
        { path: 'platforms[1]', message: 'kept' },
      ]),
    );

    assert.deepEqual(assertIssues(body.issues), [{ path: 'platforms[1]', message: 'kept' }]);
  });

  it('says nothing rather than an empty list when no row survives', () => {
    const body = throughFilter(refusal([{ path: 1, message: 2 }]));
    assert.equal('issues' in body, false);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function refusal(issues: readonly unknown[]): BadRequestException {
  return new BadRequestException({
    code: CONNECT_PAGE_CATALOG_INVALID,
    message: 'The catalog would not work',
    issues,
  });
}

async function refusalFrom(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the save to be refused, and it was not');
}

function assertIssues(value: unknown): { path: string; message: string }[] {
  assert.equal(Array.isArray(value), true, 'the wire carried no issues at all');
  const rows = value as unknown[];
  for (const row of rows) {
    assert.equal(typeof row, 'object');
    assert.notEqual(row, null);
  }
  return rows as { path: string; message: string }[];
}

function throughFilter(exception: unknown): Record<string, unknown> {
  const captured: { body?: unknown } = {};
  const response = {
    status() {
      return response;
    },
    json(body: unknown) {
      captured.body = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: '/api/admin/connect-page', headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new AdminSafeExceptionFilter().catch(exception, host);
  assert.equal(typeof captured.body, 'object');
  assert.notEqual(captured.body, null);
  return captured.body as Record<string, unknown>;
}
