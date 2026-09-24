import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import type { RawCacheService } from '../src/common/cache/raw-cache.service';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import type { ConfigVersionsService } from '../src/modules/bot-config/config-versions/config-versions.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { AdminBrandingDeliveryController } from '../src/modules/settings/branding-delivery/admin-branding-delivery.controller';
import {
  MAX_FIELD_VALUE_LENGTH,
  MAX_REPORTED_FIELDS,
  readBrandingDeliveryReport,
} from '../src/modules/settings/branding-delivery/branding-delivery-report';
import {
  BRANDING_DELIVERY_REPORTS_KEY,
  BrandingDeliveryService,
  MAX_KEPT_BRANDING_DELIVERY_REPORTS,
} from '../src/modules/settings/branding-delivery/branding-delivery.service';
import { InternalBrandingDeliveryController } from '../src/modules/settings/branding-delivery/internal-branding-delivery.controller';

/**
 * «Кабинет не принял часть оформления»
 * ═══════════════════════════════════
 * The cabinet judges each field of the appearance alone since 24.09.2026 and
 * keeps the previous value for a field it refuses; it tells the panel which,
 * once per version. The branding page shows the report on the version the
 * panel serves NOW — so a fixed value (a new version) clears it, and a report
 * that arrives late for an older version can neither show nor push the
 * current one out.
 */

const V_OLD = 'a'.repeat(32);
const V_NOW = 'b'.repeat(32);

const BORDER_RADIUS = { path: 'branding.borderRadius', reason: 'not-an-allowed-value', value: '"rounded-md"' };

function memoryStore(fail: { get?: boolean; set?: boolean } = {}) {
  const data = new Map<string, string>();
  const store = {
    get: async <T>(key: string): Promise<T | null> => {
      if (fail.get) throw new Error('redis down');
      const raw = data.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    set: async (key: string, value: unknown): Promise<void> => {
      if (fail.set) throw new Error('redis down');
      data.set(key, JSON.stringify(value));
    },
  };
  return { data, store: store as unknown as RawCacheService };
}

function versionsAt(current: () => string | undefined | Error) {
  return {
    current: async () => {
      const version = current();
      if (version instanceof Error) throw version;
      return version === undefined ? {} : { publicConfig: version };
    },
  } as unknown as ConfigVersionsService;
}

describe('the report the cabinet sends', () => {
  it('reads a well-formed report', () => {
    assert.deepEqual(readBrandingDeliveryReport({ version: V_NOW, rejected: [BORDER_RADIUS] }), {
      version: V_NOW,
      rejected: [BORDER_RADIUS],
    });
    assert.deepEqual(readBrandingDeliveryReport({ version: V_NOW, rejected: [] }), { version: V_NOW, rejected: [] });
  });

  it('refuses a body that is not a report', () => {
    assert.equal(readBrandingDeliveryReport(null), null);
    assert.equal(readBrandingDeliveryReport([]), null);
    assert.equal(readBrandingDeliveryReport({ version: 'v1', rejected: [] }), null, 'a version is 32 hex digits');
    assert.equal(readBrandingDeliveryReport({ version: V_NOW.toUpperCase(), rejected: [] }), null);
    assert.equal(readBrandingDeliveryReport({ version: V_NOW }), null);
    assert.equal(readBrandingDeliveryReport({ version: V_NOW, rejected: 'branding.primary' }), null);
  });

  it('drops an entry that is not a field instead of refusing the report', () => {
    const report = readBrandingDeliveryReport({
      version: V_NOW,
      rejected: [null, { path: '', reason: 'x', value: '1' }, { path: 'a', reason: 1, value: '1' }, BORDER_RADIUS],
    });
    assert.deepEqual(report?.rejected, [BORDER_RADIUS]);
  });

  it('cuts what it keeps: the value to the limit, the list to its ceiling', () => {
    const long = `"${'x'.repeat(500)}"`;
    const report = readBrandingDeliveryReport({
      version: V_NOW,
      rejected: Array.from({ length: MAX_REPORTED_FIELDS + 10 }, (_, index) => ({
        path: `branding.f${index}`,
        reason: 'not-a-string',
        value: long,
      })),
    });
    assert.equal(MAX_FIELD_VALUE_LENGTH, 120);
    assert.equal(report?.rejected.length, MAX_REPORTED_FIELDS);
    assert.equal(report?.rejected[0]?.value.length, 120);
    assert.ok(report?.rejected[0]?.value.endsWith('…'));
  });
});

describe('which report the branding page sees', () => {
  it('the one on the version the panel serves now', async () => {
    const { store } = memoryStore();
    const service = new BrandingDeliveryService(store, versionsAt(() => V_NOW));
    await service.record({ version: V_NOW, rejected: [BORDER_RADIUS] }, Date.parse('2026-09-24T20:00:00Z'));

    assert.deepEqual(await service.currentReport(), {
      version: V_NOW,
      rejected: [BORDER_RADIUS],
      reportedAt: '2026-09-24T20:00:00.000Z',
    });
  });

  it('nothing once a later save made a new version — an old report never shows', async () => {
    const { store } = memoryStore();
    let current = V_OLD;
    const service = new BrandingDeliveryService(store, versionsAt(() => current));
    await service.record({ version: V_OLD, rejected: [BORDER_RADIUS] });
    assert.notEqual(await service.currentReport(), null);

    current = V_NOW;
    assert.equal(await service.currentReport(), null);
  });

  it('a late report on an older version does not push out the current one', async () => {
    const { store } = memoryStore();
    const service = new BrandingDeliveryService(store, versionsAt(() => V_NOW));
    await service.record({ version: V_NOW, rejected: [BORDER_RADIUS] });
    await service.record({ version: V_OLD, rejected: [] });

    assert.deepEqual((await service.currentReport())?.rejected, [BORDER_RADIUS]);
  });

  it('the newest report on a version replaces the one before it', async () => {
    const { data, store } = memoryStore();
    const service = new BrandingDeliveryService(store, versionsAt(() => V_NOW));
    await service.record({ version: V_NOW, rejected: [BORDER_RADIUS] });
    await service.record({ version: V_NOW, rejected: [] });

    assert.deepEqual((await service.currentReport())?.rejected, []);
    // Replaced, not stacked: one entry per version.
    assert.equal((JSON.parse(data.get(BRANDING_DELIVERY_REPORTS_KEY) as string).entries as unknown[]).length, 1);
  });

  it('keeps a bounded few', async () => {
    const { data, store } = memoryStore();
    const service = new BrandingDeliveryService(store, versionsAt(() => V_NOW));
    for (let index = 0; index < MAX_KEPT_BRANDING_DELIVERY_REPORTS + 5; index += 1) {
      await service.record({ version: index.toString(16).padStart(32, '0'), rejected: [] });
    }
    const kept = JSON.parse(data.get(BRANDING_DELIVERY_REPORTS_KEY) as string).entries as unknown[];
    assert.equal(kept.length, MAX_KEPT_BRANDING_DELIVERY_REPORTS);
  });

  it('nothing, and no error, when Redis or the version cannot be read', async () => {
    const down = memoryStore({ get: true, set: true });
    const service = new BrandingDeliveryService(down.store, versionsAt(() => V_NOW));
    await service.record({ version: V_NOW, rejected: [BORDER_RADIUS] });
    assert.equal(await service.currentReport(), null);

    const { store } = memoryStore();
    const unversioned = new BrandingDeliveryService(store, versionsAt(() => undefined));
    await unversioned.record({ version: V_NOW, rejected: [BORDER_RADIUS] });
    assert.equal(await unversioned.currentReport(), null);

    const failing = new BrandingDeliveryService(store, versionsAt(() => new Error('db down')));
    assert.equal(await failing.currentReport(), null);
  });
});

describe('the routes', () => {
  it('the cabinet’s: a POST behind its credential, answering 200', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalBrandingDeliveryController), 'internal/branding/delivery');
    const report = InternalBrandingDeliveryController.prototype.report;
    assert.equal(Reflect.getMetadata(METHOD_METADATA, report), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, report), 200);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, InternalBrandingDeliveryController), [InternalAdminAuthGuard]);
  });

  it('the cabinet’s keeps a report and refuses a body that is not one', async () => {
    const { store } = memoryStore();
    const service = new BrandingDeliveryService(store, versionsAt(() => V_NOW));
    const controller = new InternalBrandingDeliveryController(service);

    assert.deepEqual(await controller.report({ version: V_NOW, rejected: [BORDER_RADIUS] }), { ok: true });
    assert.deepEqual((await service.currentReport())?.rejected, [BORDER_RADIUS]);
    await assert.rejects(() => controller.report({ rejected: [] }), BadRequestException);
  });

  it('the page’s: a GET for whoever may view settings, with the current report', async () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminBrandingDeliveryController), 'admin/settings/branding/delivery');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminBrandingDeliveryController.prototype.get), RequestMethod.GET);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminBrandingDeliveryController), [AdminJwtAuthGuard, RbacGuard]);

    const { store } = memoryStore();
    const service = new BrandingDeliveryService(store, versionsAt(() => V_NOW));
    const controller = new AdminBrandingDeliveryController(service);
    assert.deepEqual(await controller.get(), { report: null });
    await service.record({ version: V_NOW, rejected: [BORDER_RADIUS] });
    assert.deepEqual((await controller.get()).report?.rejected, [BORDER_RADIUS]);
  });
});
