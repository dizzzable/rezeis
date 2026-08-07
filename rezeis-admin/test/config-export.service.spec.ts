import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ServiceUnavailableException } from '@nestjs/common';

import {
  ALL_SECTIONS,
  ConfigExportSection,
  ConfigExportService,
} from '../src/modules/config-portability/services/config-export.service';

/**
 * An export that quietly drops a section
 * ──────────────────────────────────────
 * `exportConfig` used to wrap each section in its own try/catch and write
 * `[]` on failure, then return 200. The resulting file is indistinguishable
 * from a healthy one: `"roles": []` reads as "this deployment has no roles".
 * Restoring it into an empty deployment — the one moment the file exists for
 * — produces a panel with no roles, no permissions and no IP allowlist, and
 * the import summary reports zeros with no errors.
 *
 * These tests hold the export to two rules:
 *   1. if any requested section could not be read, no file comes back at all;
 *   2. a file that does come back states its own row counts, so the import
 *      side can tell a genuinely-empty section from an emptied one.
 */

/** Row shapes are irrelevant here — only how many rows each section yields. */
const SECTION_DELEGATE: Readonly<Record<ConfigExportSection, string>> = {
  roles: 'adminRole',
  permissions: 'adminPermission',
  scopePolicies: 'adminScopePolicy',
  automations: 'automationRule',
  webhooks: 'webhookSubscription',
  notificationTemplates: 'notificationTemplate',
  settings: 'settings',
  blockedIps: 'blockedIp',
  adminIpAllowlist: 'adminIpAllowlist',
  faqItems: 'faqItem',
  legalDocuments: 'legalDocument',
};

/** Deliberately uneven so an all-zero manifest cannot pass by accident. */
const ROW_COUNTS: Readonly<Record<ConfigExportSection, number>> = {
  roles: 3,
  permissions: 7,
  scopePolicies: 0,
  automations: 2,
  webhooks: 1,
  notificationTemplates: 4,
  settings: 1,
  blockedIps: 0,
  adminIpAllowlist: 5,
  faqItems: 6,
  legalDocuments: 2,
};

/**
 * Prisma stub whose delegates yield `ROW_COUNTS[section]` rows, except for
 * the sections named in `broken`, which reject the way a connection hiccup
 * would.
 */
function buildPrismaStub(broken: readonly ConfigExportSection[] = []) {
  const brokenSet = new Set<ConfigExportSection>(broken);
  const prisma: Record<string, unknown> = {};

  for (const section of ALL_SECTIONS) {
    const delegate = SECTION_DELEGATE[section];
    const fail = brokenSet.has(section);
    const rows = Array.from({ length: ROW_COUNTS[section] }, (_, i) => ({
      id: `${section}-${i}`,
    }));

    if (section === 'settings') {
      // `settings` is a singleton read through findFirst, not findMany.
      prisma[delegate] = {
        findFirst: async () => {
          if (fail) throw new Error(`relation "${delegate}" is unavailable`);
          return rows[0] ?? null;
        },
      };
      continue;
    }
    prisma[delegate] = {
      findMany: async () => {
        if (fail) throw new Error(`relation "${delegate}" is unavailable`);
        return rows;
      },
    };
  }
  return prisma;
}

describe('ConfigExportService — a partial export is never presented as a whole one', () => {
  it('refuses to return a payload when a section cannot be read', async () => {
    const service = new ConfigExportService(buildPrismaStub(['roles']) as never);

    // Under the swallowing implementation this resolved — with
    // `sections.roles === []` and an HTTP 200 — so the rejection itself is
    // the assertion. `assert.rejects` would pass on any thrown error, so
    // the callback pins the type and the message.
    await assert.rejects(
      () => service.exportConfig(null),
      (err: unknown) => {
        assert.ok(
          err instanceof ServiceUnavailableException,
          `expected ServiceUnavailableException, got ${String(err)}`,
        );
        assert.match(err.message, /roles/);
        return true;
      },
    );
  });

  it('reports every broken section, not just the first one it hit', async () => {
    // `roles` is the first section in ALL_SECTIONS and `faqItems` the last:
    // an implementation that stopped at the first failure would name only
    // `roles`, so this fails on a short-circuiting fix as well as on the
    // swallowing one.
    const service = new ConfigExportService(
      buildPrismaStub(['roles', 'adminIpAllowlist', 'faqItems']) as never,
    );

    const err = await service.exportConfig(null).then(
      () => null,
      (caught: unknown) => caught,
    );

    assert.ok(err instanceof ServiceUnavailableException, 'export should have rejected');
    for (const section of ['roles', 'adminIpAllowlist', 'faqItems']) {
      assert.match(err.message, new RegExp(section), `message should name "${section}"`);
    }
    // Healthy sections are not accused.
    assert.ok(!/webhooks/.test(err.message), 'message should not name a healthy section');
  });

  it('keeps the underlying Prisma message out of the response', async () => {
    // The safe exception filter blanks any 5xx body carrying a connection
    // string, which would reduce this to a generic 500 and cost the
    // operator the section names — the only part they can act on.
    const service = new ConfigExportService(buildPrismaStub(['webhooks']) as never);

    const err = await service.exportConfig(null).then(
      () => null,
      (caught: unknown) => caught,
    );

    assert.ok(err instanceof ServiceUnavailableException);
    assert.match(err.message, /webhooks/);
    assert.ok(
      !/relation "webhookSubscription" is unavailable/.test(err.message),
      'raw Prisma text must not reach the response body',
    );
  });

  it('states its own row counts so an emptied section is detectable later', async () => {
    const service = new ConfigExportService(buildPrismaStub() as never);

    const payload = await service.exportConfig(null);

    assert.ok(payload.manifest, 'a healthy export must carry a manifest');
    const sectionKeys = Object.keys(payload.sections) as ConfigExportSection[];
    assert.equal(sectionKeys.length, ALL_SECTIONS.length);

    // Walk the SECTIONS, not the manifest: an empty manifest would satisfy
    // a loop over its own keys and prove nothing.
    let nonZero = 0;
    for (const section of sectionKeys) {
      const rows = payload.sections[section];
      assert.ok(Array.isArray(rows), `sections.${section} should be an array`);
      assert.equal(
        payload.manifest[section],
        rows.length,
        `manifest.${section} should match the rows it describes`,
      );
      if (rows.length > 0) nonZero += 1;
    }
    // Without this an all-empty stub would make the equality above vacuous.
    assert.ok(nonZero >= 5, `expected several non-empty sections, got ${nonZero}`);
  });

  it('omits unrequested sections from both the payload and the manifest', async () => {
    // This is what lets the import side treat "absent" as a fact rather
    // than a failure: a deliberate subset export says nothing at all about
    // the sections the operator did not pick.
    const service = new ConfigExportService(buildPrismaStub() as never);

    const payload = await service.exportConfig(['roles', 'webhooks']);

    assert.deepEqual(Object.keys(payload.sections).sort(), ['roles', 'webhooks']);
    assert.deepEqual(Object.keys(payload.manifest ?? {}).sort(), ['roles', 'webhooks']);
    assert.equal(payload.manifest?.roles, ROW_COUNTS.roles);
    assert.equal(payload.manifest?.webhooks, ROW_COUNTS.webhooks);
  });

  it('still shapes a healthy export the way it always did', async () => {
    const service = new ConfigExportService(buildPrismaStub() as never);

    const payload = await service.exportConfig(null);

    assert.equal(payload.version, 1);
    assert.equal(payload.source, 'rezeis-admin');
    assert.ok(!Number.isNaN(Date.parse(payload.exportedAt)));
    assert.deepEqual(
      payload.sections.roles,
      Array.from({ length: ROW_COUNTS.roles }, (_, i) => ({ id: `roles-${i}` })),
    );
  });
});
