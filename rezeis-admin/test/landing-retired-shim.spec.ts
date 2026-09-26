import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { INestApplication, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { configVersionOf } from '../src/modules/bot-config/config-versions/config-version-hash';
import { buildConfigVersionSources } from '../src/modules/bot-config/config-versions/config-version-sources';
import { CONFIG_VERSION_KEYS } from '../src/modules/bot-config/config-versions/config-versions.constants';
import { InternalLandingConfigController } from '../src/modules/landing-config/controllers/internal-landing-config.controller';
import { LandingConfigModule } from '../src/modules/landing-config/landing-config.module';
import {
  LAST_LANDING_READER,
  RETIRED_LANDING_ANSWER,
} from '../src/modules/landing-config/landing-retired';
import {
  CABINET_FLOOR_VERSION,
  compareCabinetVersions,
} from '../src/modules/reiwa-peers/cabinet-capabilities';

/**
 * The retired landing route (0.9.7.71)
 * ════════════════════════════════════
 * The landing builder is gone, but cabinets up to 0.9.7.53 still read
 * `GET /api/internal/landing-config/effective`. What they do with the answer
 * decides whether an old landing ever disappears from them:
 *
 *  - `{"enabled":false}` — sign-in at `/`, and 0.9.7.53 replaces the copy it
 *    keeps in Redis (only an object with a BOOLEAN `enabled` may replace it);
 *  - `{}` — sign-in, but the Redis copy stays and comes back after a restart
 *    during a panel outage;
 *  - a 404 — 0.9.7.53 serves the landing it last read, forever.
 *
 * So the route stays, answering the constant, with its version group: the
 * group's version moves once, to the constant's hash, and a 0.9.7.53 re-reads
 * at its next poll. Pinned here: the route and its guard, that it can reach no
 * data, the exact answer on the wire, the version, that no other landing route
 * is left, and how long all of this has to stay.
 */

/** sha256 of `{"enabled":false}`, first 32 hex digits — what both sides compute. */
const RETIRED_LANDING_VERSION = '5acf3ff77b4420677b5923071f303fac';

describe('the retired landing route', () => {
  it('is the same GET the cabinets call, behind the cabinet credential, not throttled per address', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalLandingConfigController), 'internal/landing-config');
    const handler = InternalLandingConfigController.prototype.getEffective;
    assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'effective');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, InternalLandingConfigController), [InternalAdminAuthGuard]);
    assert.equal(Reflect.getMetadata('THROTTLER:SKIPdefault', InternalLandingConfigController), true);
  });

  it('serves one route and nothing else', () => {
    const routes = Object.getOwnPropertyNames(InternalLandingConfigController.prototype).filter(
      (name) =>
        name !== 'constructor'
        && Reflect.getMetadata(
          METHOD_METADATA,
          (InternalLandingConfigController.prototype as unknown as Record<string, object>)[name] as object,
        ) !== undefined,
    );
    assert.deepEqual(routes, ['getEffective']);
    assert.deepEqual(Reflect.getMetadata('controllers', LandingConfigModule), [InternalLandingConfigController]);
    assert.deepEqual(Reflect.getMetadata('providers', LandingConfigModule) ?? [], [], 'no service is left to read the landing tables');
  });

  it('cannot read the landing tables: nothing is injected into it', () => {
    assert.equal(InternalLandingConfigController.length, 0);
    assert.deepEqual(Reflect.getMetadata('design:paramtypes', InternalLandingConfigController) ?? [], []);
  });

  it('answers {"enabled":false}, with a real boolean — what 0.9.7.53 needs to replace its Redis copy', async () => {
    const controller = new InternalLandingConfigController();
    const answer = await controller.getEffective();
    assert.deepEqual(answer, { enabled: false });
    assert.equal(typeof (answer as { enabled: unknown }).enabled, 'boolean');
    assert.equal(JSON.stringify(answer), '{"enabled":false}');
    assert.deepEqual(RETIRED_LANDING_ANSWER, { enabled: false });
    // A fresh object per call: a caller that mutates what it was served
    // cannot change what the next cabinet reads.
    assert.notEqual(await controller.getEffective(), answer);
  });

  it('keeps its settings-version group, whose version is the constant’s', async () => {
    assert.ok(CONFIG_VERSION_KEYS.includes('landing'), 'the landing group stays until the shim goes');
    const shim = new InternalLandingConfigController();
    const moduleRef = {
      get: (type: unknown) => {
        if (type === InternalLandingConfigController) return shim;
        return new Proxy({}, {
          get: () => () => {
            throw new Error('only the landing source is read here');
          },
        });
      },
    } as unknown as ModuleRef;
    const sources = buildConfigVersionSources(moduleRef);
    const landing = sources.find((source) => source.key === 'landing');
    assert.ok(landing !== undefined, 'the landing version source must stay');
    const payload = await landing.read();
    assert.deepEqual(payload, { enabled: false });
    assert.equal(configVersionOf(payload), RETIRED_LANDING_VERSION);
  });
});

describe('the retired landing route, over HTTP', () => {
  let app: INestApplication;

  before(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [InternalLandingConfigController] })
      .overrideGuard(InternalAdminAuthGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
  });

  after(async () => {
    await app.close();
  });

  it('writes exactly {"enabled":false} with 200 — a 2xx, since the cabinet throws on anything else', async () => {
    const response = await request(app.getHttpServer()).get('/api/internal/landing-config/effective');
    assert.equal(response.status, 200);
    assert.equal(response.text, '{"enabled":false}');
    assert.match(String(response.headers['content-type']), /application\/json/);
  });
});

describe('nothing else of the landing is left on the panel', () => {
  const SRC = join(__dirname, '..', 'src');
  const files = (function walk(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
  })(SRC);
  const rel = (path: string): string => relative(SRC, path).split(sep).join('/');

  it('reads the tree it scans', () => {
    // Anti-emptiness: a scan of nothing finds nothing.
    assert.ok(files.length > 500, `only ${files.length} files under src/`);
    assert.ok(files.some((file) => rel(file) === 'modules/landing-config/landing-retired.ts'));
  });

  it('declares no route with "landing" in it but the shim — /api/admin/landing-config is a 404', () => {
    const ROUTE = /@(?:Controller|Get|Post|Put|Patch|Delete|All)\(\s*(['"`])([^'"`]*landing[^'"`]*)\1/gi;
    const found: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(ROUTE)) {
        found.push(`${rel(file)}: ${match[2]}`);
      }
    }
    assert.deepEqual(found, [
      'modules/landing-config/controllers/internal-landing-config.controller.ts: internal/landing-config',
    ]);
  });
});

describe('how long the shim stays', () => {
  it('until the oldest supported cabinet is newer than the last one that reads the landing', () => {
    assert.ok(
      compareCabinetVersions(CABINET_FLOOR_VERSION, LAST_LANDING_READER) <= 0,
      `the floor passed ${LAST_LANDING_READER} (it is ${CABINET_FLOOR_VERSION}): no supported cabinet reads ` +
        'the landing any more — delete the shim (`landing-config/`, `LandingConfigModule` in app.module.ts), ' +
        'the `landing` version group (`CONFIG_VERSION_KEY.landing` and its source in config-version-sources.ts), ' +
        '`GROUP_TITLES.landing` in config-delivery-check.service.ts, its row in test/config-versions.spec.ts ' +
        'and this spec. Keep the tables: test/landing-data-kept.spec.ts.',
    );
  });

  it('names the reader it waits for', () => {
    assert.equal(LAST_LANDING_READER, '0.9.7.53');
  });
});
