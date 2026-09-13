import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';

/**
 * An unknown route under the global prefix answers the SAME JSON envelope as
 * every other API error — asserted with the prefix read out of `src/main.ts`.
 *
 * WHY THIS SPEC EXISTS.
 *
 * NestJS 12 changed where the Express not-found handler lives: 11 mounted it at
 * the root, 12.0.1 mounts it on the global prefix exactly as `setGlobalPrefix`
 * received it. Express never matches a mount path without its leading slash,
 * so with `setGlobalPrefix('api')` — the form every Nest example uses, and the
 * one `main.ts` had — an unknown `/api/*` route no longer reached
 * `AdminSafeExceptionFilter` at all. It got Express's own HTML "Cannot GET"
 * page: no `errorCode`, no `statusCode`, nothing a JSON client can branch on,
 * and no WARN line in the log. Routes themselves still resolved, so typecheck,
 * the build, `smoke:boot` and all 7507 tests were green with it; only a request
 * to the running app showed it. Upstream: nestjs/nest#17647, fix pending in
 * #17648.
 *
 * The prefix comes from `main.ts` rather than being typed here, because the
 * defect lives in that one string: a spec that hard-coded `'/api'` would stay
 * green the day someone tidies `main.ts` back to `'api'`.
 */

@Controller('probe')
class ProbeController {
  @Get()
  public ping(): { readonly ok: true } {
    return { ok: true };
  }
}

const MAIN_SOURCE = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');

function productionPrefix(): string {
  const match = /app\.setGlobalPrefix\(\s*'([^']*)'\s*\)/u.exec(MAIN_SOURCE);
  assert.ok(match, 'src/main.ts no longer calls app.setGlobalPrefix with a string literal');
  return match[1]!;
}

describe('unknown routes under the global prefix — the envelope on the wire', () => {
  let application: INestApplication;

  before(async () => {
    const testingModule = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    application = testingModule.createNestApplication({ logger: false });
    // Mirrors `main.ts`: the same prefix string and the same global filter.
    application.setGlobalPrefix(productionPrefix());
    application.useGlobalFilters(new AdminSafeExceptionFilter());
    await application.init();
  });

  after(async () => {
    await application.close();
  });

  it('still mounts real routes under /api', async () => {
    const response = await request(application.getHttpServer()).get('/api/probe');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
  });

  it('answers an unknown /api route with the JSON 404 envelope, not an HTML page', async () => {
    const response = await request(application.getHttpServer()).get('/api/no-such-route');

    assert.equal(response.status, 404);
    // Asserted before the body: the broken shape was a 404 too, just HTML.
    assert.match(
      String(response.headers['content-type']),
      /^application\/json/u,
      'an unknown /api route answered a non-JSON body — Express handled the 404 ' +
        'itself, so AdminSafeExceptionFilter never saw it. Check the prefix ' +
        'passed to setGlobalPrefix in src/main.ts (it needs its leading slash on ' +
        '@nestjs/platform-express 12.0.1).',
    );
    const body = response.body as Record<string, unknown>;
    assert.equal(body.statusCode, 404);
    assert.equal(body.errorCode, 'NOT_FOUND');
    assert.equal(body.path, '/api/no-such-route');
  });

  it('keeps the safe filter installed on the real entrypoint', () => {
    // Evidence about production only while production installs it too.
    assert.match(
      MAIN_SOURCE,
      /useGlobalFilters\(\s*new AdminSafeExceptionFilter\(\)\s*\)/u,
      'src/main.ts no longer installs AdminSafeExceptionFilter globally',
    );
  });
});
