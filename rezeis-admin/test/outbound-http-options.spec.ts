import assert from 'node:assert/strict';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import test from 'node:test';

import { HttpModule } from '@nestjs/axios';
import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from '@nestjs/common/constants';

import { OutboundHttpModule } from '../src/common/http/outbound-http.module';
import {
  buildBoundedOutboundHttpOptions,
  OUTBOUND_HTTP_MAX_BODY_BYTES,
  OUTBOUND_HTTP_MAX_FREE_SOCKETS,
  OUTBOUND_HTTP_MAX_REDIRECTS,
  OUTBOUND_HTTP_MAX_SOCKETS,
  OUTBOUND_HTTP_TIMEOUT_MS,
} from '../src/common/http/outbound-http-options';

test('builds bounded outbound HTTP defaults without retries or sensitive labels', () => {
  const options = buildBoundedOutboundHttpOptions();

  assert.equal(options.timeout, OUTBOUND_HTTP_TIMEOUT_MS);
  assert.equal(options.timeout, 45_000);
  assert.equal(options.maxRedirects, OUTBOUND_HTTP_MAX_REDIRECTS);
  assert.equal(options.maxRedirects, 5);
  assert.equal(options.maxContentLength, OUTBOUND_HTTP_MAX_BODY_BYTES);
  assert.equal(options.maxBodyLength, OUTBOUND_HTTP_MAX_BODY_BYTES);
  assert.equal(options.maxContentLength, 1_048_576);
  assert.equal(options.httpAgent instanceof HttpAgent, true);
  assert.equal(options.httpsAgent instanceof HttpsAgent, true);
  assert.equal(options.httpAgent.keepAlive, true);
  assert.equal(options.httpsAgent.keepAlive, true);
  assert.equal(options.httpAgent.maxSockets, OUTBOUND_HTTP_MAX_SOCKETS);
  assert.equal(options.httpsAgent.maxSockets, OUTBOUND_HTTP_MAX_SOCKETS);
  assert.equal(options.httpAgent.maxFreeSockets, OUTBOUND_HTTP_MAX_FREE_SOCKETS);
  assert.equal(options.httpsAgent.maxFreeSockets, OUTBOUND_HTTP_MAX_FREE_SOCKETS);

  assert.deepEqual(options.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });

  assert.equal('retries' in options, false);
  assert.equal('retry' in options, false);
  assert.equal('proxy' in options, false);
  assert.equal('socketPath' in options, false);
  assert.equal('Authorization' in (options.headers ?? {}), false);
  assert.equal('Cookie' in (options.headers ?? {}), false);
});

test('returns a fresh options object so modules cannot share mutable headers', () => {
  const first = buildBoundedOutboundHttpOptions();
  const second = buildBoundedOutboundHttpOptions();

  assert.notEqual(first, second);
  assert.notEqual(first.headers, second.headers);
  assert.notEqual(first.httpAgent, second.httpAgent);
  assert.notEqual(first.httpsAgent, second.httpsAgent);
});

test('provides a single global outbound HTTP registration seam', () => {
  const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, OutboundHttpModule) as Array<{
    readonly module?: unknown;
    readonly providers?: readonly unknown[];
  }>;
  const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, OutboundHttpModule) as readonly unknown[];
  const isGlobal = Reflect.getMetadata(GLOBAL_MODULE_METADATA, OutboundHttpModule) as boolean | undefined;
  const httpRegistration = imports.find((importedModule) => importedModule.module === HttpModule);

  assert.equal(isGlobal, true);
  assert.ok(httpRegistration, 'OutboundHttpModule should wrap a registered Nest HttpModule');
  assert.deepEqual(exports, [HttpModule]);
  assert.equal(
    imports.filter((importedModule) => importedModule.module === HttpModule).length,
    1,
  );
  assert.equal((httpRegistration?.providers?.length ?? 0) > 0, true);
});
