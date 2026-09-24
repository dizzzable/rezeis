import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import ts from 'typescript';

import { remnawaveConfig } from '../src/common/config/remnawave.config';
import { RemnawaveModule } from '../src/modules/remnawave/remnawave.module';
import {
  buildPanelClientProviders,
  PANEL_VERSION_PROBE,
  PanelVersionGate,
} from '../src/modules/remnawave/services/panel-clients.providers';
import { LEGACY_PANEL_REFUSAL_CODE, LEGACY_PANEL_REFUSAL_MESSAGE } from '../src/modules/remnawave/services/panel-transport';
import { PanelUsersClient } from '../src/modules/remnawave/services/panel-users.client';
import {
  RemnawaveApiService,
  RemnawavePanelTooOldError,
} from '../src/modules/remnawave/services/remnawave-api.service';

/**
 * A Remnawave 2.x panel is refused on EVERY path of the old adapter
 * ═══════════════════════════════════════════════════════════════════
 * The contract clients were refused through `LegacyPanelRefusal` from the start;
 * the old adapter sent its own HTTP and reached a 2.x panel on every path —
 * nodes, hosts, «Онлайн», user search, device deletes, user deletion. It now
 * asks the same `PanelVersionGate` first in each of its send points.
 *
 * THE METHOD LIST IS NOT KEPT BY HAND. It is read out of the adapter's source
 * (every non-private, non-static method of the class), so a public method added
 * tomorrow is exercised tomorrow — and fails here until the argument table can
 * call it. Each one is called against a panel whose probe says 2.x, through an
 * HTTP stub that records every request, and must:
 *   • send nothing but a version read, and
 *   • answer with the refusal (`RemnawavePanelTooOldError`, or a strict
 *     `invalidContract` carrying the refusal sentence) or with its documented
 *     fail-soft value (`null`, `[]`, `unavailable`).
 * Exactly two methods — the version readers — are let through, and
 * `getPanelShape` reaches the panel only through them.
 */

const CONFIG = { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null };

/** The two version reads a 2.x panel still answers. */
const VERSION_URLS: ReadonlySet<string> = new Set(['/api/system/stats/recap', '/api/system/metadata']);

/** Public instance methods of `RemnawaveApiService`, read from its source. */
function publicAdapterMethods(): string[] {
  const file = join(__dirname, '..', 'src', 'modules', 'remnawave', 'services', 'remnawave-api.service.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  ts.forEachChild(source, (node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== 'RemnawaveApiService') return;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const hidden = (ts.getModifiers(member) ?? []).some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === ts.SyntaxKind.StaticKeyword,
      );
      if (!hidden) names.push(member.name.getText(source));
    }
  });
  return names;
}

/** An identity that has to be RESOLVED first, so the resolve send is reached too. */
const RESOLVED_IDENTITY = {
  remnawaveId: '330f2b38-1362-46ab-9c1d-5e4d3c2b1a09',
  panelId: null,
  panelUsername: 'rz_alice_sub',
};

/**
 * Arguments for the methods whose parameters are not a plain profile id.
 * Everything else is called with `('42', 'hwid-1')`, which every other public
 * method accepts.
 */
const ARGS: Readonly<Record<string, readonly unknown[]>> = {
  getPanelShape: [true],
  resolvePanelSegment: [RESOLVED_IDENTITY],
  resolvePanelIdentity: [{ username: 'rz_alice_sub' }],
  createPanelUser: [
    {
      username: 'rz_alice_sub',
      telegramId: null,
      email: null,
      description: '',
      tag: null,
      expireAt: '2099-12-31T00:00:00.000Z',
      trafficLimitBytes: 0,
      hwidDeviceLimit: 0,
      trafficLimitStrategy: null,
      activeInternalSquads: [],
      externalSquadUuid: null,
    },
  ],
  updatePanelUser: ['42', { status: 'ACTIVE' }],
  getPanelUserByUsername: ['rz_alice_sub'],
  getNodeUsersBandwidth: [['0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e']],
  getHwidTopUsers: [10],
  fetchUsersIpsForNode: ['0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e'],
  dropConnections: [
    { dropBy: { by: 'userUuids', userUuids: ['42'] }, targetNodes: { target: 'allNodes' } },
  ],
  getSubscriptionRequestHistory: [{ limit: 10 }],
  strictGetSubscriptionRequestHistory: [10],
  resolveRemnawaveUser: [{ email: 'alice@example.test' }],
  reorderHosts: [['0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e']],
  strictSetUserLimits: ['42', { trafficLimitBytes: null, hwidDeviceLimit: null }],
};
const DEFAULT_ARGS: readonly unknown[] = ['42', 'hwid-1'];

/** The adapter over a recording HTTP stub, with the gate answering `major`. */
function adapterAt(major: number | null | 'throws') {
  const sent: Array<{ readonly method: string; readonly url: string }> = [];
  const http = {
    request: (config: { method: string; url: string }) => {
      sent.push({ method: config.method, url: config.url });
      if (config.url === '/api/system/stats/recap' || config.url === '/api/system/metadata') {
        return of({ data: { response: { version: '2.7.4' } } });
      }
      // One body that lets every sender complete: a job id for a start, a
      // completed job for a poll.
      return of({ data: { response: { jobId: 'job-1', isCompleted: true, result: {} } } });
    },
  };
  let gateReads = 0;
  const gate = {
    readMajor: async (): Promise<number | null> => {
      gateReads += 1;
      if (major === 'throws') throw new Error('probe failed');
      return major;
    },
  };
  const errors: string[] = [];
  const service = new RemnawaveApiService(http as never, CONFIG as never, undefined, gate);
  (service as unknown as { logger: unknown }).logger = {
    error: (message: string) => errors.push(message),
    warn: () => undefined,
    log: () => undefined,
    debug: () => undefined,
  };
  return { service, sent, errors, gateReads: () => gateReads };
}

type Outcome =
  | { readonly kind: 'tooOld' }
  | { readonly kind: 'legacyContract' }
  | { readonly kind: 'failSoft' }
  | { readonly kind: 'other'; readonly detail: string };

async function call(service: RemnawaveApiService, name: string): Promise<{ outcome: Outcome; value: unknown }> {
  const method = (service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name];
  try {
    const value = await method.apply(service, [...(ARGS[name] ?? DEFAULT_ARGS)]);
    if (value === null || (Array.isArray(value) && value.length === 0)) {
      return { outcome: { kind: 'failSoft' }, value };
    }
    const record = value as { kind?: unknown; details?: unknown };
    if (record.kind === 'unavailable') return { outcome: { kind: 'failSoft' }, value };
    if (record.kind === 'invalidContract' && record.details === LEGACY_PANEL_REFUSAL_MESSAGE) {
      return { outcome: { kind: 'legacyContract' }, value };
    }
    return { outcome: { kind: 'other', detail: JSON.stringify(value) }, value };
  } catch (error: unknown) {
    if (
      error instanceof RemnawavePanelTooOldError &&
      (error.getResponse() as { code?: unknown }).code === LEGACY_PANEL_REFUSAL_CODE
    ) {
      return { outcome: { kind: 'tooOld' }, value: undefined };
    }
    return { outcome: { kind: 'other', detail: `threw ${(error as Error)?.name}: ${(error as Error)?.message}` }, value: undefined };
  }
}

describe('the old adapter refuses a Remnawave 2.x panel on every path', () => {
  const methods = publicAdapterMethods();

  it('finds the public methods it is about (a non-empty, sane list)', () => {
    // An anchor: an AST read that silently found nothing would make every case
    // below pass by iterating over an empty list.
    assert.ok(methods.length >= 50, `only ${methods.length} public methods found`);
    for (const name of ['deletePanelUser', 'getAllNodes', 'getSystemRecap', 'strictHttp']) {
      assert.equal(methods.includes(name), name !== 'strictHttp', name);
    }
  });

  it('every argument table entry names a real public method', () => {
    for (const name of Object.keys(ARGS)) assert.ok(methods.includes(name), name);
  });

  for (const name of publicAdapterMethods()) {
    if (name === 'getSystemRecap' || name === 'getSystemMetadata' || name === 'getPanelShape') continue;
    it(`${name}: refused or fail-soft, and nothing but a version read goes out`, async () => {
      const { service, sent } = adapterAt(2);
      const { outcome } = await call(service, name);
      const refusedSends = sent.filter((request) => !VERSION_URLS.has(request.url));
      assert.deepEqual(refusedSends, [], `${name} reached a 2.x panel`);
      assert.notEqual(outcome.kind, 'other', `${name}: ${outcome.kind === 'other' ? outcome.detail : ''}`);
    });
  }

  it('the exemption is exactly the two version readers', async () => {
    const reaching: string[] = [];
    for (const name of methods) {
      const { service, sent } = adapterAt(2);
      // A spy on each reader, so a method that reaches the panel only THROUGH
      // them (the version detection) can be told from one with a sender of its
      // own.
      const viaReaders = { count: 0 };
      if (name !== 'getSystemRecap' && name !== 'getSystemMetadata') {
        for (const reader of ['getSystemRecap', 'getSystemMetadata'] as const) {
          const original = service[reader].bind(service);
          (service as unknown as Record<string, unknown>)[reader] = async () => {
            viaReaders.count += 1;
            return original();
          };
        }
      }
      await call(service, name);
      const own = sent.length - (name === 'getSystemRecap' || name === 'getSystemMetadata' ? 0 : viaReaders.count);
      if (own > 0) reaching.push(name);
    }
    assert.deepEqual(reaching.sort(), ['getSystemMetadata', 'getSystemRecap']);
  });

  it('the version readers still answer a 2.x panel — which is how the SPA can say "too old"', async () => {
    const { service, sent } = adapterAt(2);
    assert.deepEqual(await service.getSystemMetadata(), { version: '2.7.4' });
    assert.equal((await service.getSystemRecap())?.version, '2.7.4');
    assert.equal((await service.getPanelShape(true)).version, '2.7.4');
    assert.ok(sent.length >= 3);
    assert.ok(sent.every((request) => VERSION_URLS.has(request.url)));
  });

  it('a throwing sender raises the code and the Russian sentence as a 502 body, not a 503', async () => {
    const { service } = adapterAt(2);
    const error = await service.getAllHosts().then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.equal(error, null, 'getAllHosts is fail-soft');
    const refusal = await service.enableNode('0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e').then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(refusal instanceof RemnawavePanelTooOldError);
    assert.equal(refusal.getStatus(), 502);
    assert.deepEqual(refusal.getResponse(), {
      code: 'REZEIS_PANEL_TOO_OLD',
      message: LEGACY_PANEL_REFUSAL_MESSAGE,
    });
    assert.match(LEGACY_PANEL_REFUSAL_MESSAGE, /Обновите панель до 3\.x/);
  });

  it('the Remnawave page status read refuses with the code too, not "auth status is unavailable"', async () => {
    const { service } = adapterAt(2);
    await assert.rejects(() => service.getStatus(), RemnawavePanelTooOldError);
  });
});

describe('only a PROVEN 2.x panel is refused', () => {
  // The inertness control for everything above: the same methods, the same
  // stub, a gate that does not say 2.x — and the requests go out. Without it a
  // sender broken some other way would read as "refused".
  for (const major of [3, null, 'throws'] as const) {
    it(`major ${String(major)}: every method that refused under 2.x sends its request`, async () => {
      const silent: string[] = [];
      for (const name of publicAdapterMethods()) {
        if (name === 'getSystemRecap' || name === 'getSystemMetadata' || name === 'getPanelShape') continue;
        const { service, sent } = adapterAt(major);
        await call(service, name);
        if (!sent.some((request) => !VERSION_URLS.has(request.url))) silent.push(name);
      }
      assert.deepEqual(silent, []);
    });
  }
});

describe('the refusal is read once and said once', () => {
  it('a burst of calls reads the version probe once (the gate caches)', async () => {
    let probeReads = 0;
    const probe = {
      readPanelVersion: async () => {
        probeReads += 1;
        return '2.8.0';
      },
    };
    const gate = new PanelVersionGate(probe as never, () => 1_000);
    const sent: string[] = [];
    const service = new RemnawaveApiService(
      { request: (config: { url: string }) => (sent.push(config.url), of({ data: {} })) } as never,
      CONFIG as never,
      undefined,
      gate,
    );
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(await service.getAllNodes(), []);
    }
    assert.equal(probeReads, 1);
    assert.deepEqual(sent, []);
  });

  it('the first refusal is logged at error level with the code, and the next ones are not', async () => {
    const { service, errors } = adapterAt(2);
    await service.getAllNodes();
    await service.getAllHosts();
    await service.enableNode('0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e').catch(() => undefined);
    const refusals = errors.filter((line) => line.includes(LEGACY_PANEL_REFUSAL_CODE));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0] ?? '', /Update the panel to 3\.x/);
  });

  it('an adapter built without a gate (a hand-built spec adapter) is never refused', async () => {
    const sent: string[] = [];
    const service = new RemnawaveApiService(
      { request: (config: { url: string }) => (sent.push(config.url), of({ data: { response: [] } })) } as never,
      CONFIG as never,
    );
    assert.deepEqual(await service.getAllNodes(), []);
    assert.deepEqual(sent, ['/api/nodes']);
  });
});

describe('the Nest module hands the adapter the gate the contract clients read', () => {
  it('RemnawaveModule provides the adapter and every panel-client provider', () => {
    const providers = Reflect.getMetadata('providers', RemnawaveModule) as unknown[];
    assert.ok(providers.includes(RemnawaveApiService));
    const tokens = new Set(
      providers.map((provider) =>
        typeof provider === 'function' ? provider : (provider as { provide: unknown }).provide,
      ),
    );
    for (const provider of buildPanelClientProviders()) {
      assert.ok(tokens.has((provider as { provide: unknown }).provide), String((provider as { provide: unknown }).provide));
    }
  });

  it('one gate instance: the adapter and the users client refuse from the same answer', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RemnawaveApiService,
        ...buildPanelClientProviders(),
        { provide: HttpService, useValue: { request: () => of({ data: {} }) } },
        { provide: remnawaveConfig.KEY, useValue: CONFIG },
      ],
    }).compile();
    const adapter = moduleRef.get(RemnawaveApiService);
    const gate = moduleRef.get<PanelVersionGate>(PANEL_VERSION_PROBE);
    assert.equal((adapter as unknown as { versionGate: unknown }).versionGate, gate);

    // Behaviour, not only identity: one answer planted on THE gate refuses both.
    (gate as unknown as { readMajor: () => Promise<number | null> }).readMajor = async () => 2;
    await assert.rejects(
      () => adapter.enableNode('0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e'),
      RemnawavePanelTooOldError,
    );
    const users = moduleRef.get(PanelUsersClient);
    const outcome = (await users.getUserById(42)) as { kind: string; code?: string };
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.code, LEGACY_PANEL_REFUSAL_CODE);
  });
});
