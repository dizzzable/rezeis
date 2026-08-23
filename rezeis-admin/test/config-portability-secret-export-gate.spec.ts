/**
 * Two holes on the config-portability boundary, both reached from the webhook
 * work and neither webhook-specific.
 *
 * 1. The webhook-secret export gate lived only in the SPA
 * ──────────────────────────────────────────────────────
 * `web/src/features/rbac/permission-gate.tsx` says of itself that it is "a UX
 * hint, not a security boundary", and it is right. The endpoint enforced only
 * `config_portability:export`, so an admin holding that alone could send
 * `?includeWebhookSecrets=true` by hand and read every live signing secret.
 *
 * That matters more than an ordinary missing check, because this flag is the
 * ONLY way in the panel to read an EXISTING webhook secret: list responses
 * hardcode `secret: null`, and both endpoints that return plaintext (`POST
 * subscriptions`, `POST subscriptions/:id/regenerate-secret`) MINT a new value.
 *
 * 2. Raw driver text was echoed into an HTTP response
 * ──────────────────────────────────────────────────
 * `ConfigImportService` pushed `(err as Error).message` into the section
 * summary, which is returned in the body of a 200. `AdminSafeExceptionFilter`
 * is an `ExceptionFilter` and only ever sees a THROWN exception, so an error
 * caught and embedded in a successful response walks straight past it.
 * `ConfigExportService` had already ruled that Prisma messages are log-only
 * because they "routinely carry a connection string" — the import side was
 * doing the opposite to the same operator from the same module.
 *
 * Every case drives the REAL controller or the REAL service and asserts what
 * reached the caller.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenException } from '@nestjs/common';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminConfigPortabilityController } from '../src/modules/config-portability/controllers/admin-config-portability.controller';
import type {
  ConfigExportPayloadInterface,
  ConfigExportRequestOptions,
} from '../src/modules/config-portability/services/config-export.service';
import { ConfigImportService } from '../src/modules/config-portability/services/config-import.service';

const ADMIN: CurrentAdminInterface = {
  id: 'admin-7',
  login: 'ops',
  email: null,
  name: null,
  role: 'ADMIN' as CurrentAdminInterface['role'],
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: 'role-ops',
  mustChangePassword: false,
};

function fakeRequest(): never {
  return {
    headers: {},
    socket: { remoteAddress: '203.0.113.4' },
  } as never;
}

interface ControllerHarness {
  readonly controller: AdminConfigPortabilityController;
  readonly exportCalls: ConfigExportRequestOptions[];
  /** How many times the controller resolved the caller's grants. */
  readonly permissionLookups: { count: number };
}

/**
 * Real controller, recording doubles. `exportCalls` is the load-bearing one: a
 * gate that throws AFTER the export service has already read the secrets out of
 * the database is not a gate, so every refusal asserts zero calls rather than
 * merely asserting a throw.
 */
function buildController(grants: ReadonlyArray<[string, string]>): ControllerHarness {
  const exportCalls: ConfigExportRequestOptions[] = [];
  const permissionLookups = { count: 0 };
  const controller = new AdminConfigPortabilityController(
    {
      exportConfig: async (_sections: unknown, options: ConfigExportRequestOptions) => {
        exportCalls.push(options);
        return {};
      },
    } as never,
    { importConfig: async () => ({}) } as never,
    {
      getEffectivePermissions: async () => {
        permissionLookups.count += 1;
        return grants.map(([resource, action]) => ({ resource, action }));
      },
    } as never,
  );
  return { controller, exportCalls, permissionLookups };
}

describe('config export — the webhook-secret opt-in is enforced on the server, not just in the SPA', () => {
  it('refuses includeWebhookSecrets from an admin without webhooks:edit, without reading anything', async () => {
    // The headline: `config_portability:export` alone used to be enough to
    // read every live signing secret by typing the query parameter.
    const { controller, exportCalls } = buildController([['config_portability', 'export']]);

    await assert.rejects(
      () =>
        controller.exportConfig(
          { sections: ['webhooks'], includeWebhookSecrets: true },
          ADMIN,
          fakeRequest(),
        ),
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenException, `expected 403, got ${String(err)}`);
        assert.match(err.message, /webhooks:edit/);
        // The remedy has to be in the message, or the operator's only move is
        // to guess. Re-running without the option is one click.
        assert.match(err.message, /without that option/i);
        return true;
      },
    );

    assert.deepEqual(
      exportCalls,
      [],
      'the export service ran anyway — the secrets were read out of the database before the refusal',
    );
  });

  it('allows it once the admin holds webhooks:edit', async () => {
    // The other half. A gate that refuses everyone would break the one
    // workflow this flag exists for: promoting a config to a fresh environment
    // whose receivers must keep validating signatures.
    const { controller, exportCalls } = buildController([
      ['config_portability', 'export'],
      ['webhooks', 'edit'],
    ]);

    await controller.exportConfig(
      { sections: ['webhooks'], includeWebhookSecrets: true },
      ADMIN,
      fakeRequest(),
    );

    assert.equal(exportCalls.length, 1);
    assert.equal(exportCalls[0]?.includeWebhookSecrets, true);
  });

  it('leaves an ordinary export completely untouched, and does not even resolve grants', async () => {
    // The outage guard. A caller who never asks for secrets must see no change
    // at all — not a refusal, and not the extra round trip either. Asserting
    // the lookup count is what makes "untouched" mean untouched rather than
    // "happens to still succeed".
    const { controller, exportCalls, permissionLookups } = buildController([
      ['config_portability', 'export'],
    ]);

    await controller.exportConfig({ sections: ['roles'] }, ADMIN, fakeRequest());
    await controller.exportConfig(
      { sections: ['webhooks'], includeWebhookSecrets: false },
      ADMIN,
      fakeRequest(),
    );

    assert.equal(exportCalls.length, 2, 'an export that asks for no secrets must still run');
    assert.equal(exportCalls[0]?.includeWebhookSecrets, false);
    assert.equal(exportCalls[1]?.includeWebhookSecrets, false);
    assert.equal(
      permissionLookups.count,
      0,
      'the common path paid for a permission lookup it never needed',
    );
  });

  it('refuses rather than silently downgrading to a redacted file', async () => {
    // The deliberate choice. A silent downgrade hands back a file that looks
    // complete and whose receivers all fail signature validation after the
    // promote — the same shape this module already rejected when it stopped
    // emitting partial exports. Nothing may come back at all.
    const { controller } = buildController([['config_portability', 'export']]);

    const outcome = await controller
      .exportConfig({ includeWebhookSecrets: true }, ADMIN, fakeRequest())
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (err: unknown) => ({ kind: 'rejected' as const, value: err }),
      );

    assert.equal(
      outcome.kind,
      'rejected',
      'a redacted payload was returned instead of a refusal — the operator is not told',
    );
  });
});

// ── The import side ────────────────────────────────────────────────────────

/** A Prisma message of the shape that was reaching the browser verbatim. */
const PRISMA_DUMP =
  'Invalid `prisma.webhookSubscription.create()` invocation in\n'
  + '/app/dist/modules/config-portability/services/config-import.service.js:112:44\n\n'
  + 'Argument `secret` is missing.\n'
  + 'datasource db: postgresql://rezeis:hunter2@10.0.0.7:5432/rezeis?schema=public';

interface ImportOutcome {
  readonly errors: readonly string[];
  readonly status: string;
  readonly logged: string[];
}

/**
 * Drives the real import service against a double whose write throws, and
 * captures BOTH what came back to the caller and what went to the log — the
 * two halves of "stop echoing driver text without losing it".
 */
async function importFailing(
  section: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  thrown: Error,
): Promise<ImportOutcome> {
  const logged: string[] = [];
  const delegate = () => ({
    findUnique: async () => null,
    findFirst: async () => null,
    create: async () => {
      throw thrown;
    },
    update: async () => {
      throw thrown;
    },
  });
  const tx = {
    adminRole: delegate(),
    adminPermission: delegate(),
    adminScopePolicy: delegate(),
    automationRule: delegate(),
    webhookSubscription: delegate(),
    notificationTemplate: delegate(),
    settings: delegate(),
    blockedIp: delegate(),
    adminIpAllowlist: delegate(),
    faqItem: delegate(),
    legalDocument: delegate(),
  };
  const prisma = {
    ...tx,
    $transaction: async <T>(cb: (client: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  };
  const service = new ConfigImportService(prisma as never);
  (service as unknown as { logger: { error: (m: string, s?: string) => void } }).logger = {
    error: (message: string) => {
      logged.push(message);
    },
  };

  const payload = {
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: 'rezeis-admin',
    manifest: { [section]: rows.length },
    sections: { [section]: [...rows] },
  } as unknown as ConfigExportPayloadInterface;

  const result = await service.importConfig({
    payload,
    sections: [section] as never,
    strategy: 'overwrite',
    dryRun: false,
    // Every section gate satisfied on purpose: these cases are about what a
    // FAILED WRITE reports, so a refusal at the permission gate would make them
    // pass without the code under test ever running.
    importerPermissions: new Set([
      'config_portability:import',
      'rbac_roles:edit',
      'settings:edit',
      'webhooks:create',
      'webhooks:edit',
      'automations:create',
      'automations:edit',
      'notifications:edit',
      'admins:edit',
      'blocked_ips:create',
      'blocked_ips:delete',
      'faq:create',
      'faq:edit',
    ]),
  });
  const summary = result.summaries.find((s) => s.section === section);
  return { errors: summary?.errors ?? [], status: String(summary?.status), logged };
}

describe('config import — a failed section explains itself without quoting the driver', () => {
  it('keeps the Prisma dump and its connection string out of the response', async () => {
    // The leak, verbatim. The credential in `PRISMA_DUMP` is the point: the
    // export side keeps these log-only precisely because they carry one.
    const outcome = await importFailing(
      'webhooks',
      [{ id: 'wh-1', name: 'Ops', url: 'https://ops.example/hook', secret: 'kept' }],
      new Error(PRISMA_DUMP),
    );

    assert.equal(outcome.status, 'failed', 'the failure must still be reported as a failure');
    assert.equal(outcome.errors.length, 1);
    const message = outcome.errors[0]!;
    assert.doesNotMatch(message, /postgresql:\/\//, 'a connection string reached the client');
    assert.doesNotMatch(message, /hunter2/, 'a database password reached the client');
    assert.doesNotMatch(message, /prisma\./i, 'raw driver text reached the client');
    assert.doesNotMatch(message, /\bArgument `secret` is missing\b/);
    assert.ok(!message.includes('\n'), 'a multi-line driver dump reached the client');
  });

  it('still puts the real message in the server log', async () => {
    // Sanitising the response is only half of it. Losing the cause would trade
    // a leak for a blind operator and a blind engineer.
    const outcome = await importFailing(
      'webhooks',
      [{ id: 'wh-1', name: 'Ops', url: 'https://ops.example/hook', secret: 'kept' }],
      new Error(PRISMA_DUMP),
    );

    assert.equal(outcome.logged.length, 1, 'the failure was not logged at all');
    assert.match(outcome.logged[0]!, /Argument `secret` is missing/);
    assert.match(outcome.logged[0]!, /webhooks/);
  });

  it('names the cause and the remedy when the export redacted a required secret', async () => {
    // The workflow that produces this: export, promote to a fresh environment,
    // import. `webhooks.secret` is required and redacted by default, so the
    // create branch cannot succeed — and the old message named a Prisma
    // argument without ever mentioning the flag that prevents it.
    const outcome = await importFailing(
      'webhooks',
      [{ id: 'wh-1', name: 'Ops alerts', url: 'https://ops.example/hook', eventTypes: ['*'] }],
      new Error(PRISMA_DUMP),
    );

    const message = outcome.errors[0]!;
    assert.match(message, /Ops alerts/, 'the operator is not told WHICH subscription');
    assert.match(message, /signing secret/i, 'the operator is not told what is missing');
    assert.match(message, /webhooks:edit/, 'the operator is not told what the remedy needs');
    assert.match(
      message,
      /re-export|create the subscription/i,
      'the operator is not told what to DO',
    );
    assert.doesNotMatch(message, /postgresql:\/\//);
  });

  it('sanitises every section, not only webhooks', async () => {
    // The catch it replaced is the one all eleven sections funnel through, so
    // fixing only the webhook message would have left the leak open
    // everywhere else.
    for (const section of ['settings', 'faqItems', 'automations', 'blockedIps']) {
      const outcome = await importFailing(
        section,
        [{ id: 'x-1', address: '203.0.113.9', question: 'q', answer: 'a', name: 'n' }],
        new Error(PRISMA_DUMP),
      );
      assert.equal(outcome.status, 'failed', `${section} should have failed`);
      const message = outcome.errors[0]!;
      assert.doesNotMatch(message, /postgresql:\/\//, `${section} leaked a connection string`);
      assert.doesNotMatch(message, /hunter2/, `${section} leaked a database password`);
      assert.match(message, new RegExp(section), `${section} should name itself`);
    }
  });

  it('does not blame a missing secret when the webhooks rows all carry one', async () => {
    // The specific diagnosis is read off the PAYLOAD, so it must not fire for
    // a webhooks failure that has nothing to do with secrets.
    const outcome = await importFailing(
      'webhooks',
      [{ id: 'wh-1', name: 'Ops', url: 'https://ops.example/hook', secret: 'present' }],
      new Error(PRISMA_DUMP),
    );

    assert.doesNotMatch(
      outcome.errors[0]!,
      /signing secret/i,
      'a webhooks failure was misdiagnosed as a missing secret',
    );
  });

  it('leaves a successful import reporting no errors at all', async () => {
    // Sanity: none of the above may turn a clean section into a noisy one.
    const logged: string[] = [];
    const writes: string[] = [];
    const delegate = (name: string) => ({
      findUnique: async () => null,
      findFirst: async () => null,
      create: async (a: { data: Record<string, unknown> }) => {
        writes.push(name);
        return a.data;
      },
      update: async (a: { data: Record<string, unknown> }) => a.data,
    });
    const tx = { faqItem: delegate('faqItem') };
    const service = new ConfigImportService({
      ...tx,
      $transaction: async <T>(cb: (c: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never);
    (service as unknown as { logger: { error: (m: string) => void } }).logger = {
      error: (m: string) => logged.push(m),
    };

    const result = await service.importConfig({
      payload: {
        version: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        source: 'rezeis-admin',
        manifest: { faqItems: 1 },
        sections: { faqItems: [{ id: 'faq-1', question: 'q', answer: 'a' }] },
      } as unknown as ConfigExportPayloadInterface,
      sections: ['faqItems'],
      strategy: 'overwrite',
      dryRun: false,
      importerPermissions: new Set(['config_portability:import', 'faq:create', 'faq:edit']),
    });

    const summary = result.summaries.find((s) => s.section === 'faqItems');
    assert.equal(summary?.status, 'imported');
    assert.deepEqual(summary?.errors, []);
    assert.deepEqual(writes, ['faqItem']);
    assert.deepEqual(logged, [], 'a clean import must not log an error');
  });
});
