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
    // Had no assertions at all and passed for that reason. What it is FOR is
    // the negative half of the channel: a save that succeeds must not answer
    // with a refusal shape at all.
    const written = await service().replaceConfig(catalog(true));

    assert.equal(written.config.platforms.length, 1);
    assert.deepEqual(written.cleanedIcons, {});
    assert.equal('issues' in (written as Record<string, unknown>), false);
    assert.equal('code' in (written as Record<string, unknown>), false);
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

  it('delivers a row that quotes what the operator typed, address and all', () => {
    // The pattern scrub used to run here and it wrecked exactly this row. Icon
    // keys come from `slugify`, so an icon named "Password Manager" becomes the
    // key `password-manager`, which those patterns read as a credential: the
    // path was blanked to `` and the editor drew a dash where the address goes.
    // The scrub protected nothing — `POST /validate` serves the identical
    // sentence on 200 to the same operator — so it is gone, and this test is
    // what notices if it comes back.
    const body = throughFilter(
      refusal([
        {
          path: 'icons.password-manager',
          message: 'Icon "password-manager" is not in the icon library',
        },
        {
          path: 'platforms[0].apps[0]',
          message: '"Auth token" has no way to hand over the subscription',
        },
      ]),
    );

    assert.deepEqual(assertIssues(body.issues), [
      { path: 'icons.password-manager', message: 'Icon "password-manager" is not in the icon library' },
      { path: 'platforms[0].apps[0]', message: '"Auth token" has no way to hand over the subscription' },
    ]);
  });

  it('caps the list so a refusal cannot become a payload', () => {
    const body = throughFilter(
      refusal(Array.from({ length: 50 }, (_, index) => ({ path: `platforms[${index}]`, message: 'bad' }))),
    );

    assert.equal(assertIssues(body.issues).length, 20);
  });

  it('trims a row that is longer than a diagnostic ever is, instead of dropping it', () => {
    // Dropping reinstated the very bug this channel exists to fix. Twenty
    // unknown top-level keys make zod write ONE 367-character sentence; the
    // only row was dropped, `issues` came back absent, and the editor said
    // "could not save" and nothing else.
    const body = throughFilter(
      refusal([
        { path: 'platforms[0]', message: 'x'.repeat(400) },
        { path: `platforms[0].${'y'.repeat(300)}`, message: 'short' },
        { path: 'platforms[1]', message: 'kept whole' },
      ]),
    );

    const issues = assertIssues(body.issues);
    assert.equal(issues.length, 3, 'every row survives, trimmed');
    assert.equal(issues[0]?.message.length, 300);
    assert.equal(issues[0]?.message.endsWith('…'), true);
    assert.equal(issues[0]?.path, 'platforms[0]', 'a long message does not cost the address');
    assert.equal(issues[1]?.path.length, 200);
    assert.equal(issues[2]?.message, 'kept whole', 'a short row is untouched');
  });

  it('never answers a refusal with no rows when the server sent one long row', () => {
    // The zod "Unrecognized keys" case, which is one row and nothing else.
    const body = throughFilter(refusal([{ path: '', message: 'Unrecognized keys: '.repeat(30) }]));

    assert.equal(assertIssues(body.issues).length, 1);
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
