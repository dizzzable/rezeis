import 'reflect-metadata';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Controller, type DynamicModule, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ServeStaticModule, type ServeStaticModuleOptions } from '@nestjs/serve-static';
import request from 'supertest';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';

/**
 * THE SPA FALLBACK NEVER ANSWERS `/api/*` OR `/uploads/*`.
 *
 * `ServeStaticModule` in `src/app.module.ts` answers every GET its `renderPath`
 * matches with `index.html`, status 200. It registers that route in
 * `onModuleInit`, which runs BEFORE Nest mounts its routers — so on Nest 12 the
 * regex sits ahead of the not-found handler that is mounted on the `/api`
 * prefix. The only thing standing between an unknown `/api/*` route and a 200
 * HTML page is the `(?!\/api\/)` in that regex; the same holds for a missing
 * upload and `(?!\/uploads\/)`. A JSON client would get HTML with a 200 where
 * it branches on the envelope's `errorCode`, and an `<img>` pointing at a
 * deleted upload would get the SPA shell.
 *
 * `unknown-api-route-envelope.http.spec.ts` cannot see this: it builds an app
 * without `ServeStaticModule`. Nothing else booted the static module or read
 * the regex, so deleting either lookahead left every test green.
 *
 * This spec boots the static module with the regex READ OUT OF
 * `src/app.module.ts` (so tidying that file cannot leave a stale copy green),
 * mounted the way `main.ts` mounts the app: the same global prefix, `/uploads`
 * as static assets registered before init, the same global filter, and a
 * `setHeaders` hook, which makes the loader stat `index.html` before sending
 * it. The root is a temp directory WITH an `index.html`: without one the
 * loader turns the missing file into a 404 and the mutated regex would pass.
 *
 * Booted through `NestFactory.create`, as `main.ts` is, and NOT through
 * `Test.createTestingModule`: a testing module instantiates its providers
 * before any HTTP adapter exists, so `ServeStaticModule` picks its no-op loader
 * and registers nothing — every path 404s and the assertions below about the
 * fallback's absence would hold for the wrong reason.
 */

@Controller('probe')
class ProbeController {
  @Get()
  public ping(): { readonly ok: true } {
    return { ok: true };
  }
}

@Module({})
class SpaFallbackHarnessModule {
  public static with(options: ServeStaticModuleOptions): DynamicModule {
    return {
      module: SpaFallbackHarnessModule,
      imports: [ServeStaticModule.forRoot(options)],
      controllers: [ProbeController],
    };
  }
}

const APP_MODULE_SOURCE = readFileSync(resolve(__dirname, '../src/app.module.ts'), 'utf8');
const MAIN_SOURCE = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');

const INDEX_MARKER = 'spa-fallback-index-marker';

/** The `renderPath` regex literal passed to `ServeStaticModule.forRoot` in `app.module.ts`. */
function productionRenderPath(): RegExp {
  assert.equal(
    APP_MODULE_SOURCE.split('ServeStaticModule.forRoot(').length - 1,
    1,
    'src/app.module.ts should call ServeStaticModule.forRoot exactly once',
  );
  const literals = [...APP_MODULE_SOURCE.matchAll(/renderPath:\s*\/((?:\\.|[^/\n\\])+)\/([a-z]*)\s*,/gu)];
  assert.equal(literals.length, 1, 'src/app.module.ts no longer passes renderPath as one regex literal');
  const [, source, flags] = literals[0];
  return new RegExp(source, flags);
}

function productionPrefix(): string {
  const match = /app\.setGlobalPrefix\(\s*'([^']*)'\s*\)/u.exec(MAIN_SOURCE);
  assert.ok(match, 'src/main.ts no longer calls app.setGlobalPrefix with a string literal');
  return match[1];
}

describe('the SPA fallback and the paths it must leave alone', () => {
  let application: NestExpressApplication;
  let workspace: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'rezeis-spa-fallback-'));
    const webRoot = join(workspace, 'web');
    const uploadsRoot = join(workspace, 'uploads');
    mkdirSync(webRoot);
    mkdirSync(uploadsRoot);
    writeFileSync(join(webRoot, 'index.html'), `<!doctype html><title>${INDEX_MARKER}</title>`);
    writeFileSync(join(uploadsRoot, 'present.txt'), 'an upload that exists');

    application = await NestFactory.create<NestExpressApplication>(
      SpaFallbackHarnessModule.with({
        rootPath: webRoot,
        renderPath: productionRenderPath(),
        serveStaticOptions: {
          setHeaders: (res: { setHeader(name: string, value: string): void }) => {
            res.setHeader('Cache-Control', 'no-cache');
          },
        },
      }),
      { logger: false, abortOnError: false },
    );
    // Mirrors `main.ts`: prefix and `/uploads` are set up before init, the
    // static module registers its fallback during init.
    application.setGlobalPrefix(productionPrefix());
    application.useStaticAssets(uploadsRoot, { prefix: '/uploads' });
    application.useGlobalFilters(new AdminSafeExceptionFilter());
    await application.init();
  });

  after(async () => {
    await application.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('serves index.html for an app route, so the fallback under test is live', async () => {
    const response = await request(application.getHttpServer()).get('/settings/branding');

    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /^text\/html/u);
    assert.ok(response.text.includes(INDEX_MARKER), 'the SPA shell was not served for an app route');
  });

  it('still mounts real routes under the prefix', async () => {
    const response = await request(application.getHttpServer()).get('/api/probe');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
  });

  it('answers an unknown /api route with the JSON 404 envelope, not the SPA shell', async () => {
    const response = await request(application.getHttpServer()).get('/api/no-such-route');

    assert.ok(
      !response.text.includes(INDEX_MARKER),
      `GET /api/no-such-route answered ${response.status} with index.html — the renderPath ` +
        'in src/app.module.ts matches /api/* again, and the fallback now shadows every ' +
        'unknown API route',
    );
    assert.equal(response.status, 404);
    assert.match(String(response.headers['content-type']), /^application\/json/u);
    assert.equal((response.body as Record<string, unknown>).errorCode, 'NOT_FOUND');
  });

  it('serves an upload that exists from the /uploads mount', async () => {
    const response = await request(application.getHttpServer()).get('/uploads/present.txt');

    assert.equal(response.status, 200);
    assert.equal(response.text, 'an upload that exists');
  });

  it('answers a missing upload with 404, not the SPA shell', async () => {
    const response = await request(application.getHttpServer()).get('/uploads/missing.png');

    assert.ok(
      !response.text.includes(INDEX_MARKER),
      `GET /uploads/missing.png answered ${response.status} with index.html — the renderPath ` +
        'in src/app.module.ts matches /uploads/* again, so a deleted upload answers 200 HTML',
    );
    assert.equal(response.status, 404);
  });
});
