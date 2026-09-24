import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ModuleRef } from '@nestjs/core';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalBotConfigController } from '../src/modules/bot-config/controllers/internal-bot-config.controller';
import { configVersionOf } from '../src/modules/bot-config/config-versions/config-version-hash';
import { buildConfigVersionSources } from '../src/modules/bot-config/config-versions/config-version-sources';
import { CONFIG_VERSION_KEYS } from '../src/modules/bot-config/config-versions/config-versions.constants';
import {
  ConfigVersionsService,
  type ConfigVersionSource,
} from '../src/modules/bot-config/config-versions/config-versions.service';
import type { ConfigDeliveryState } from '../src/modules/bot-config/config-versions/config-delivery-state';
import {
  InternalConfigVersionsController,
  readConfigVersionsPoll,
} from '../src/modules/bot-config/config-versions/internal-config-versions.controller';
import { InternalCustomEmojiController } from '../src/modules/custom-emoji/controllers/internal-custom-emoji.controller';
import { InternalLandingConfigController } from '../src/modules/landing-config/controllers/internal-landing-config.controller';
import { InternalLegalDocumentsController } from '../src/modules/legal-documents/controllers/internal-legal-documents.controller';
import { InternalBrandingController } from '../src/modules/settings/controllers/internal-branding.controller';
import { InternalPlatformPolicyController } from '../src/modules/settings/controllers/internal-platform-policy.controller';
import { InternalConnectPageController } from '../src/modules/subpage-config/connect-page/connect-page.controllers';
import { InternalGuestSupportController } from '../src/modules/support-tickets/controllers/internal-guest-support.controller';

/**
 * The versions the cabinet polls
 * ══════════════════════════════
 * Three things are pinned here, and each fails a different way:
 *
 *  1. WHAT IS VERSIONED. A version computed from anything but exactly what the
 *     cabinet copies never matches its copy: every group would read "changed"
 *     on every poll, and every save would end in a card. So each source must
 *     call the handler of the very route the cabinet calls — the paths below
 *     are the cabinet's (`reiwa/src/infrastructure/admin-client/namespaces/`).
 *  2. HOW CHEAPLY. Two cabinet processes poll every ~20 s; one computation
 *     serves them for a while, and a hint busts it — with a generation, so a
 *     computation begun before the save cannot land after the bust.
 *  3. THE ROUTE. Behind the cabinet's credential, never throttled per address,
 *     and lenient about the report it carries: a poll must not fail on it.
 */

type Controller = new (...args: never[]) => object;

/** What the cabinet calls, per group: the route, and the handler that serves it. */
const ROUTES_THE_CABINET_CALLS: ReadonlyArray<{
  readonly key: (typeof CONFIG_VERSION_KEYS)[number];
  readonly controller: Controller;
  readonly handler: string;
  readonly path: string;
  readonly args: readonly unknown[];
}> = [
  { key: 'publicConfig', controller: InternalBrandingController, handler: 'getPublicConfig', path: 'internal/branding/public-config', args: [] },
  { key: 'botConfig', controller: InternalBotConfigController, handler: 'getBotConfig', path: 'internal/bot-config', args: [] },
  { key: 'landing', controller: InternalLandingConfigController, handler: 'getEffective', path: 'internal/landing-config/effective', args: [] },
  { key: 'connectPage', controller: InternalConnectPageController, handler: 'getEffective', path: 'internal/connect-page/effective', args: [] },
  { key: 'platformPolicy', controller: InternalPlatformPolicyController, handler: 'getPlatformPolicy', path: 'internal/settings/platform-policy', args: [] },
  { key: 'legalDocuments.ru', controller: InternalLegalDocumentsController, handler: 'list', path: 'internal/legal-documents', args: ['ru'] },
  { key: 'legalDocuments.en', controller: InternalLegalDocumentsController, handler: 'list', path: 'internal/legal-documents', args: ['en'] },
  { key: 'customEmojiPacks', controller: InternalCustomEmojiController, handler: 'listPacks', path: 'internal/custom-emoji/packs', args: [] },
  { key: 'guestSupport', controller: InternalGuestSupportController, handler: 'getConfig', path: 'internal/support/guest/config', args: [] },
];

function routeOf(controller: Controller, handler: string): { readonly method: unknown; readonly path: string } {
  const method = (controller.prototype as Record<string, unknown>)[handler] as object;
  const parts = [Reflect.getMetadata(PATH_METADATA, controller), Reflect.getMetadata(PATH_METADATA, method)]
    .map((part: unknown) => String(part ?? '').replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0);
  return { method: Reflect.getMetadata(METHOD_METADATA, method), path: parts.join('/') };
}

/** A ModuleRef whose controllers answer with what they were called with. */
function recordingModuleRef() {
  const calls: Array<{ controller: string; handler: string; args: unknown[] }> = [];
  const instances = new Map<unknown, object>();
  for (const route of ROUTES_THE_CABINET_CALLS) {
    const instance = instances.get(route.controller) ?? {};
    (instance as Record<string, unknown>)[route.handler] = async (...args: unknown[]) => {
      calls.push({ controller: route.controller.name, handler: route.handler, args });
      return { servedBy: `${route.controller.name}.${route.handler}`, args };
    };
    instances.set(route.controller, instance);
  }
  const moduleRef = {
    get: (type: unknown, options?: { strict?: boolean }) => {
      assert.equal(options?.strict, false, 'a handler lives in another module: the lookup must not be strict');
      const instance = instances.get(type);
      assert.ok(instance !== undefined, `no controller registered for ${String((type as { name?: string }).name)}`);
      return instance;
    },
  } as unknown as ModuleRef;
  return { moduleRef, calls };
}

describe('what each version is computed from', () => {
  it('each source calls the handler of the route the cabinet copies — and there is one per group', async () => {
    const { moduleRef, calls } = recordingModuleRef();
    const sources = buildConfigVersionSources(moduleRef);

    assert.deepEqual(
      sources.map((source) => source.key).sort(),
      [...CONFIG_VERSION_KEYS].sort(),
      'one source per group the cabinet polls',
    );
    for (const route of ROUTES_THE_CABINET_CALLS) {
      const source = sources.find((candidate) => candidate.key === route.key) as ConfigVersionSource;
      calls.length = 0;
      const payload = await source.read();
      assert.deepEqual(
        calls,
        [{ controller: route.controller.name, handler: route.handler, args: [...route.args] }],
        `${route.key} must be read from ${route.controller.name}.${route.handler}`,
      );
      assert.deepEqual(payload, { servedBy: `${route.controller.name}.${route.handler}`, args: [...route.args] });
    }
  });

  it('and each of those handlers serves exactly the GET route the cabinet calls', () => {
    for (const route of ROUTES_THE_CABINET_CALLS) {
      assert.deepEqual(
        routeOf(route.controller, route.handler),
        { method: RequestMethod.GET, path: route.path },
        `${route.key}: ${route.controller.name}.${route.handler}`,
      );
    }
  });
});

/** Sources that count their reads and answer what the test sets. */
function countingSources(payloads: Record<string, unknown>) {
  const reads: string[] = [];
  const sources: ConfigVersionSource[] = Object.keys(payloads).map((key) => ({
    key: key as ConfigVersionSource['key'],
    read: async () => {
      reads.push(key);
      const value = payloads[key];
      if (value instanceof Error) throw value;
      return value;
    },
  }));
  return { sources, reads };
}

describe('ConfigVersionsService', () => {
  it('versions each group from what its source serves, as the cabinet will from its copy', async () => {
    const payloads = { publicConfig: { branding: { brandName: 'Northern' } }, landing: { enabled: false } };
    const service = new ConfigVersionsService(countingSources(payloads).sources);

    assert.deepEqual(await service.current(), {
      publicConfig: configVersionOf(payloads.publicConfig),
      landing: configVersionOf(payloads.landing),
    });
  });

  it('leaves out a group it cannot read — never a guess the cabinet would act on', async () => {
    const service = new ConfigVersionsService(
      countingSources({ landing: { enabled: true }, botConfig: new Error('database gone') }).sources,
    );
    assert.deepEqual(await service.current(), { landing: configVersionOf({ enabled: true }) });
  });

  it('serves one computation to every poll within the TTL, and a bust ends it', async () => {
    const { sources, reads } = countingSources({ landing: { enabled: true } });
    const service = new ConfigVersionsService(sources);

    await service.current();
    await service.current();
    assert.equal(reads.length, 1, 'the second poll is served from the computation of the first');

    service.bust();
    await service.current();
    assert.equal(reads.length, 2, 'a hint means the next poll is told the save');

    await service.current({ fresh: true });
    assert.equal(reads.length, 3, 'the delivery check asks the database, not the cache');
  });

  it('polls that arrive during a computation join it', async () => {
    const { sources, reads } = countingSources({ landing: { enabled: true }, publicConfig: { a: 1 } });
    const service = new ConfigVersionsService(sources);
    await Promise.all([service.current(), service.current(), service.current()]);
    assert.equal(reads.length, 2, 'one read per source, not one per poll');
  });

  it('a computation begun before a save does not land its versions after the bust', async () => {
    // The race of memory note `invalidation-undone-by-inflight-read`, in the panel.
    let answer!: (value: unknown) => void;
    let reads = 0;
    const source: ConfigVersionSource = {
      key: 'landing',
      read: () => {
        reads += 1;
        if (reads === 1) {
          return new Promise((resolve) => {
            answer = resolve;
          });
        }
        return Promise.resolve({ enabled: true, revision: 'saved' });
      },
    };
    const service = new ConfigVersionsService([source]);

    const beforeSave = service.current();
    service.bust();
    const afterSave = await service.current();
    assert.deepEqual(afterSave, { landing: configVersionOf({ enabled: true, revision: 'saved' }) });

    answer({ enabled: true, revision: 'before-save' }); // the old computation lands last
    await beforeSave;

    assert.deepEqual(await service.current(), afterSave);
    assert.equal(reads, 2);
  });
});

describe('POST /api/internal/config-versions', () => {
  function controller(versions: Record<string, string>) {
    const reports: Array<{ consumer: string; report: unknown }> = [];
    const state = {
      recordReport: async (consumer: string, report: unknown) => {
        reports.push({ consumer, report });
      },
    } as unknown as ConfigDeliveryState;
    const service = { current: async () => versions } as unknown as ConfigVersionsService;
    return { controller: new InternalConfigVersionsController(service, state), reports };
  }

  const V1 = 'a'.repeat(32);

  it('answers the versions, and keeps what the cabinet says it holds for the delivery check', async () => {
    const { controller: route, reports } = controller({ landing: V1 });
    const before = Date.now();

    const answer = await route.poll({ consumer: 'bot', held: { botConfig: V1, platformPolicy: null } });

    assert.deepEqual(answer, { versions: { landing: V1 } });
    assert.equal(reports.length, 1);
    const kept = reports[0] as { consumer: string; report: { held: unknown; reportedAt: number } };
    assert.equal(kept.consumer, 'bot');
    assert.deepEqual(kept.report.held, { botConfig: V1, platformPolicy: null });
    assert.ok(kept.report.reportedAt >= before);
  });

  it('answers the versions to a poll with no report worth keeping, and keeps none', async () => {
    const { controller: route, reports } = controller({ landing: V1 });
    assert.deepEqual(await route.poll(undefined), { versions: { landing: V1 } });
    assert.deepEqual(await route.poll({ consumer: 'worker', held: {} }), { versions: { landing: V1 } });
    assert.equal(reports.length, 0);
  });

  it('keeps only groups it knows, holding a version or nothing', () => {
    assert.deepEqual(
      readConfigVersionsPoll({
        consumer: 'api',
        held: {
          landing: V1,
          connectPage: null,
          publicConfig: 'not-a-version',
          aNewGroupFromANewerCabinet: V1,
          customEmojiPacks: 42,
        },
      }),
      { consumer: 'api', held: { landing: V1, connectPage: null } },
    );
    assert.equal(readConfigVersionsPoll({ consumer: 'api', held: [V1] }), null);
    assert.equal(readConfigVersionsPoll({ consumer: 'api' }), null);
    assert.equal(readConfigVersionsPoll('api'), null);
  });

  it('is a POST behind the cabinet’s credential, not throttled per address, answering 200', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalConfigVersionsController), 'internal/config-versions');
    const poll = InternalConfigVersionsController.prototype.poll;
    assert.equal(Reflect.getMetadata(METHOD_METADATA, poll), RequestMethod.POST);
    assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, poll), 200);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, InternalConfigVersionsController), [InternalAdminAuthGuard]);
  });
});
