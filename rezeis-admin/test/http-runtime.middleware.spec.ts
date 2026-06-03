import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';

import {
  configureBoundedBodyParsers,
  HTTP_BODY_PARSER_LIMIT,
} from '../src/common/http/body-parser-limits';
import {
  buildHelmetOptions,
  configureHttpRuntimeMiddleware,
  EXPRESS_POWERED_BY_SETTING,
} from '../src/common/http/configure-http-runtime';
import {
  buildHttpCompressionOptions,
  createHttpCompressionMiddleware,
  HTTP_COMPRESSION_THRESHOLD_BYTES,
} from '../src/common/http/http-compression';
import {
  buildCorsOptions,
  CORS_ALLOWED_METHODS,
  parseCorsOrigins,
} from '../src/common/http/cors-origin';
import {
  noRobotsMiddleware,
  NO_ROBOTS_HEADER,
  NO_ROBOTS_HEADER_VALUE,
} from '../src/common/http/no-robots';
import {
  buildTrustedProxyValue,
  EXPRESS_TRUST_PROXY_SETTING,
} from '../src/common/http/trusted-proxy';

describe('HTTP runtime middleware foundation', () => {
  it('configures bounded JSON and URL-encoded parsers through the rawBody-aware Nest API', () => {
    const parserCalls: Array<{ readonly parser: string; readonly options: unknown }> = [];
    const app = {
      useBodyParser: (parser: string, options: unknown): unknown => {
        parserCalls.push({ parser, options });
        return app;
      },
    };

    configureBoundedBodyParsers(app as never);

    assert.deepEqual(parserCalls, [
      {
        parser: 'json',
        options: { limit: HTTP_BODY_PARSER_LIMIT },
      },
      {
        parser: 'urlencoded',
        options: { extended: true, limit: HTTP_BODY_PARSER_LIMIT },
      },
    ]);
    assert.equal(HTTP_BODY_PARSER_LIMIT, '10mb');
  });

  it('uses an explicit compression threshold', () => {
    assert.deepEqual(buildHttpCompressionOptions(), {
      threshold: HTTP_COMPRESSION_THRESHOLD_BYTES,
    });
    assert.equal(HTTP_COMPRESSION_THRESHOLD_BYTES, 1024);
  });

  it('creates an express middleware without requiring request data', () => {
    const middleware = createHttpCompressionMiddleware();

    assert.equal(typeof middleware, 'function');
    assert.equal(middleware.length, 3);
  });

  it('configures trusted proxy before fingerprint hardening and middleware registration', () => {
    const events: string[] = [];
    const app = {
      set: (setting: string, value: unknown): INestApplication => {
        events.push(`set:${setting}:${String(value)}`);
        return app as unknown as INestApplication;
      },
      disable: (setting: string): INestApplication => {
        events.push(`disable:${setting}`);
        return app as unknown as INestApplication;
      },
      use: (middleware: unknown): INestApplication => {
        assert.equal(typeof middleware, 'function');
        events.push('use');
        return app as unknown as INestApplication;
      },
    };

    configureHttpRuntimeMiddleware(
      app as Pick<INestApplication, 'use'> & {
        disable: (setting: string) => unknown;
        set: (setting: string, value: unknown) => unknown;
      },
      { trustProxy: 'loopback' },
    );

    assert.deepEqual(events, [
      `set:${EXPRESS_TRUST_PROXY_SETTING}:loopback`,
      `disable:${EXPRESS_POWERED_BY_SETTING}`,
      'use',
      'use',
      'use',
      'use',
    ]);
  });

  it('keeps trusted proxy disabled by default and accepts only bounded named modes', () => {
    assert.equal(buildTrustedProxyValue('disabled'), false);
    assert.equal(buildTrustedProxyValue('loopback'), 'loopback');
    assert.equal(buildTrustedProxyValue('linklocal'), 'linklocal');
    assert.equal(buildTrustedProxyValue('uniquelocal'), 'uniquelocal');
  });

  it('registers no-robots, helmet, compression, and safe correlation middleware in order', () => {
    const registeredMiddleware: unknown[] = [];
    const app = {
      use: (middleware: unknown): INestApplication => {
        registeredMiddleware.push(middleware);
        return app as INestApplication;
      },
    };

    configureHttpRuntimeMiddleware(app as Pick<INestApplication, 'use'>);

    assert.equal(registeredMiddleware.length, 4);
    assert.equal(registeredMiddleware[0], noRobotsMiddleware);
    registeredMiddleware.forEach((middleware) => {
      assert.equal(typeof middleware, 'function');
    });
  });

  it('keeps Helmet CSP disabled outside production to avoid breaking Vite and tests', () => {
    const options = buildHelmetOptions('development');

    assert.equal(options.contentSecurityPolicy, false);
    assert.equal(options.crossOriginEmbedderPolicy, false);
    assert.deepEqual(options.crossOriginResourcePolicy, { policy: 'cross-origin' });
  });

  it('rolls out production CSP as report-only with explicit SPA directives', () => {
    const options = buildHelmetOptions('production');
    const contentSecurityPolicy = options.contentSecurityPolicy;

    assert.notEqual(contentSecurityPolicy, false);
    assert.equal(typeof contentSecurityPolicy, 'object');
    if (contentSecurityPolicy === false || contentSecurityPolicy === undefined || contentSecurityPolicy === true) {
      assert.fail('Expected production CSP options');
    }
    assert.equal(contentSecurityPolicy.reportOnly, true);
    assert.equal(contentSecurityPolicy.useDefaults, false);
    assert.deepEqual(contentSecurityPolicy.directives?.defaultSrc, ["'self'"]);
    assert.deepEqual(contentSecurityPolicy.directives?.objectSrc, ["'none'"]);
    assert.deepEqual(contentSecurityPolicy.directives?.frameAncestors, ["'none'"]);
    assert.deepEqual(contentSecurityPolicy.directives?.scriptSrc, ["'self'"]);
    assert.deepEqual(contentSecurityPolicy.directives?.scriptSrcAttr, ["'none'"]);
    assert.deepEqual(contentSecurityPolicy.directives?.styleSrc, ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(contentSecurityPolicy.directives?.connectSrc, ["'self'", 'https:', 'wss:', 'ws:']);
    assert.deepEqual(contentSecurityPolicy.directives?.imgSrc, ["'self'", 'data:', 'blob:', 'https:']);
    assert.deepEqual(contentSecurityPolicy.directives?.workerSrc, ["'self'", 'blob:']);
  });

  it('emits a report-only CSP header in production without an enforcing CSP header', async () => {
    const helmetMiddleware = createHelmetMiddlewareForTest('production');
    const headers = new Map<string, string>();
    const response = {
      setHeader: (name: string, value: string): void => {
        headers.set(name.toLowerCase(), value);
      },
      removeHeader: (name: string): void => {
        headers.delete(name.toLowerCase());
      },
    };

    await new Promise<void>((resolve, reject) => {
      helmetMiddleware({} as never, response as never, (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    assert.equal(headers.has('content-security-policy'), false);
    const reportOnlyHeader = headers.get('content-security-policy-report-only');
    assert.ok(reportOnlyHeader);
    assert.match(reportOnlyHeader, /default-src 'self'/);
    assert.match(reportOnlyHeader, /script-src 'self'/);
    assert.match(reportOnlyHeader, /object-src 'none'/);
  });

  it('sets a static no-robots header without reading sensitive request data', () => {
    let headerName: string | undefined;
    let headerValue: string | undefined;
    let nextCalled = false;
    const sensitiveRequest = {
      url: '/api/users/user-secret-token?authorization=secret',
      headers: {
        authorization: 'Bearer secret-token',
        cookie: 'session=secret-cookie',
      },
      body: {
        password: 'secret-password',
      },
    };
    const response = {
      setHeader: (name: string, value: string): void => {
        headerName = name;
        headerValue = value;
      },
    };

    noRobotsMiddleware(
      sensitiveRequest as never,
      response as never,
      (): void => {
        nextCalled = true;
      },
    );

    assert.equal(headerName, NO_ROBOTS_HEADER);
    assert.equal(headerValue, NO_ROBOTS_HEADER_VALUE);
    assert.equal(nextCalled, true);
    assert.equal(headerValue?.includes('secret'), false);
    assert.equal(headerValue?.includes('authorization'), false);
  });

  it('builds a credentials-aware CORS policy from validated origins', () => {
    assert.deepEqual(buildCorsOptions('https://admin.example.com'), {
      origin: 'https://admin.example.com',
      credentials: true,
      methods: [...CORS_ALLOWED_METHODS],
    });

    assert.deepEqual(buildCorsOptions(['https://admin.example.com', 'https://ops.example.com']), {
      origin: ['https://admin.example.com', 'https://ops.example.com'],
      credentials: true,
      methods: [...CORS_ALLOWED_METHODS],
    });
  });

  it('keeps CORS closed when no admin origins are configured outside production', () => {
    assert.equal(parseCorsOrigins(undefined), false);
    assert.deepEqual(buildCorsOptions(false), {
      origin: false,
      credentials: false,
      methods: [...CORS_ALLOWED_METHODS],
    });
  });

  it('normalizes configured admin CORS origins without reflecting arbitrary origins', () => {
    assert.equal(parseCorsOrigins(' https://admin.example.com/ '), 'https://admin.example.com');
    assert.deepEqual(
      parseCorsOrigins('https://admin.example.com, https://admin.example.com/, http://localhost:5173'),
      ['https://admin.example.com', 'http://localhost:5173'],
    );
  });

  it('fails closed for production when no trusted admin CORS origin is configured', () => {
    assert.throws(
      () => parseCorsOrigins(undefined, { requireConfiguredOrigins: true }),
      /ADMIN_CORS_ORIGINS must define at least one trusted admin origin/,
    );
  });

  it('rejects wildcard and invalid credentialed CORS origins', () => {
    for (const invalidOrigins of [
      '*',
      'not-a-url',
      'ftp://admin.example.com',
      'https://user:pass@admin.example.com',
      'https://admin.example.com/panel',
      'https://admin.example.com?token=secret',
      'https://admin.example.com#fragment',
    ]) {
      assert.throws(() => parseCorsOrigins(invalidOrigins), /ADMIN_CORS_ORIGINS/);
    }
  });

  it('does not echo raw CORS origin values in validation errors', () => {
    assert.throws(
      () => parseCorsOrigins('https://admin.example.com?token=secret-token'),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ADMIN_CORS_ORIGINS/);
        assert.doesNotMatch(error.message, /secret-token/);
        assert.doesNotMatch(error.message, /admin\.example\.com/);
        return true;
      },
    );
  });
});

function createHelmetMiddlewareForTest(nodeEnv: string): ReturnType<typeof helmet> {
  return helmet(buildHelmetOptions(nodeEnv));
}
