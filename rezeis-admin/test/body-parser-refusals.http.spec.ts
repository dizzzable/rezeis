import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import {
  configureBoundedBodyParsers,
  HTTP_BODY_PARSER_LIMIT,
} from '../src/common/http/body-parser-limits';

/**
 * A request the body parser refuses answers ITS status in the admin error
 * envelope — asserted through the real parsers `src/main.ts` installs.
 *
 * WHY THIS SPEC EXISTS.
 *
 * body-parser refuses before any route runs, with `http-errors` instances: a
 * body over the limit is 413, an unsupported charset 415. Nest's Express
 * adapter turns only SyntaxError and URIError into HttpExceptions, so these
 * reached `AdminSafeExceptionFilter` as unknown errors and left as 500
 * "Internal server error", logged with a stack as a server fault. An operator
 * importing a configuration a little over 10 MB was told the server broke,
 * and the one fact they needed — the file is too big — never reached them.
 *
 * `admin-safe-exception.filter.spec.ts` pins the filter's rule on hand-built
 * errors. This file is the half that proves the rule meets the errors the
 * parsers really throw, which a hand-built shape cannot.
 */

const LIMIT_BYTES = parseLimit(HTTP_BODY_PARSER_LIMIT);

function parseLimit(limit: string): number {
  const match = /^(\d+)mb$/u.exec(limit);
  assert.ok(match, `HTTP_BODY_PARSER_LIMIT is "${limit}"; this spec reads only an "<n>mb" limit`);
  return Number(match[1]) * 1024 * 1024;
}

/** A JSON document of exactly `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  const frame = '{"blob":""}';
  return `{"blob":"${'a'.repeat(bytes - frame.length)}"}`;
}

@Controller('probe')
class ProbeController {
  @Post()
  @HttpCode(200)
  public accept(@Body() body: { readonly blob?: string }): { readonly received: number } {
    return { received: body.blob?.length ?? 0 };
  }
}

describe('body-parser refusals — the envelope on the wire', () => {
  let application: NestExpressApplication;

  before(async () => {
    const testingModule = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    // `bodyParser: false` plus the bounded parsers is exactly how `main.ts`
    // builds the app; Nest's default parsers would be a different limit.
    application = testingModule.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureBoundedBodyParsers(application);
    application.setGlobalPrefix('/api');
    application.useGlobalFilters(new AdminSafeExceptionFilter());
    await application.init();
  });

  after(async () => {
    await application.close();
  });

  it('accepts a body exactly at the limit', async () => {
    // The control: without it, every refusal below could be a probe that
    // never worked at all.
    const response = await request(application.getHttpServer())
      .post('/api/probe')
      .set('Content-Type', 'application/json')
      .send(jsonOfSize(LIMIT_BYTES));

    assert.equal(response.status, 200);
    assert.equal((response.body as { received: number }).received, LIMIT_BYTES - '{"blob":""}'.length);
  });

  it('answers a body one byte over the limit with 413 in the envelope, not 500', async () => {
    const response = await request(application.getHttpServer())
      .post('/api/probe')
      .set('Content-Type', 'application/json')
      .send(jsonOfSize(LIMIT_BYTES + 1));

    assert.equal(
      response.status,
      413,
      'a body over HTTP_BODY_PARSER_LIMIT did not answer 413. A 500 here means the filter ' +
        'treated the parser refusal as a server fault again (readExposedClientHttpError).',
    );
    assert.match(String(response.headers['content-type']), /^application\/json/u);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.statusCode, 413);
    assert.equal(body.errorCode, 'HTTP_413');
    assert.equal(body.error, 'Payload Too Large');
    assert.equal(body.message, 'request entity too large');
    assert.equal(body.path, '/api/probe');
  });

  it('answers an unsupported charset with 415 in the envelope', async () => {
    const response = await request(application.getHttpServer())
      .post('/api/probe')
      .set('Content-Type', 'application/json; charset=koi8-r')
      .send('{"blob":"x"}');

    assert.equal(response.status, 415);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, 'HTTP_415');
    assert.equal(body.error, 'Unsupported Media Type');
    assert.equal(body.message, 'unsupported charset "KOI8-R"');
  });

  it('keeps malformed JSON a 400, as Nest maps it before the filter', async () => {
    const response = await request(application.getHttpServer())
      .post('/api/probe')
      .set('Content-Type', 'application/json')
      .send('{"blob":');

    assert.equal(response.status, 400);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.errorCode, 'BAD_REQUEST');
  });
});
