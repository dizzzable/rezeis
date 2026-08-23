import 'reflect-metadata';

import assert from 'node:assert/strict';
import { connect, AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Controller, Get } from '@nestjs/common';

import { AdminIpAllowlistGuard } from '../src/modules/two-factor/guards/admin-ip-allowlist.guard';
import { AdminIpAllowlistService } from '../src/modules/two-factor/services/admin-ip-allowlist.service';

/**
 * The admin IP allowlist was bypassable by respelling the URL — twice, in two
 * different ways, with one root cause.
 *
 * The guard tested the RAW `request.originalUrl` and returned `true` — allow,
 * allowlist not consulted — for anything that did not match `/api/admin/` byte
 * for byte. The router it is supposed to be gating asks a different question,
 * so any request the two spell differently walks through:
 *
 *   1. CASE. Express routes case-insensitively unless `case sensitive routing`
 *      is enabled, and this app never enables it (verified: no such setting
 *      anywhere in `src/`). `GET /api/ADMIN/auth/login` reached the very same
 *      handler as `/api/admin/auth/login`.
 *   2. SHAPE. RFC 7230 §5.3.2 absolute-form —
 *      `GET http://host/api/admin/... HTTP/1.1` — which Node accepts and
 *      Express routes on its pathname, while `originalUrl` is the whole URI
 *      and can match no prefix at all. Measured against this app before the
 *      fix, over a real socket:
 *
 *          ORIGIN-FORM   -> 403 Forbidden | allowlist asked: 1
 *          ABSOLUTE-FORM -> 200 OK        | allowlist asked: 0
 *
 * Both were reachable from an IP the operator had deliberately excluded,
 * without the allowlist ever being asked.
 *
 * This file pins it from BOTH ends, because either end alone is a comfortable
 * lie:
 *
 *   - The routing premise, through a real Nest app over a real socket. If
 *     Express ever became case-sensitive here, the guard change would be
 *     harmless but the story behind it would be false, and the next person
 *     would be entitled to "simplify" it back.
 *   - The guard's own decision, unit-level, across the shapes that matter —
 *     including the four fail-OPEN paths that are deliberate and must survive
 *     the fix untouched.
 */

const BLOCKED_IP_MESSAGE = 'Your IP is not allowed to access the admin panel';

/** Records every address the guard hands to the allowlist service. */
class RecordingAllowlist {
  public readonly asked: string[] = [];
  public constructor(private readonly verdict: boolean | Error = false) {}
  public async isRequestAllowed(ipAddress: string): Promise<boolean> {
    this.asked.push(ipAddress);
    if (this.verdict instanceof Error) throw this.verdict;
    return this.verdict;
  }
}

// `null` means "no derivable IP". Not `undefined`: that would select the
// default parameter and quietly test the opposite of what the caller asked for.
function contextFor(url: string, ip: string | null = '203.0.113.9'): ExecutionContext {
  const request = { originalUrl: url, url, ip: ip ?? undefined, socket: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AdminIpAllowlistGuard — which requests the allowlist is asked about', () => {
  it('consults the allowlist for an upper-case /api/ADMIN/ path', async () => {
    const allowlist = new RecordingAllowlist(false);
    const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);

    await assert.rejects(
      () => guard.canActivate(contextFor('/api/ADMIN/auth/login')),
      (err: unknown) =>
        err instanceof ForbiddenException && (err.message as string) === BLOCKED_IP_MESSAGE,
      'a case-shifted admin URL walked past the allowlist. Express routes ' +
        'case-insensitively, so this request reaches the real handler — the ' +
        'guard just declined to look at it.',
    );

    assert.deepStrictEqual(
      allowlist.asked,
      ['203.0.113.9'],
      'the allowlist was never consulted — the guard returned "allow" on the ' +
        'prefix test alone',
    );
  });

  it('consults the allowlist for mixed case anywhere in the admin prefix', async () => {
    for (const url of ['/api/Admin/users', '/API/ADMIN/settings', '/Api/aDmIn/2fa/status']) {
      const allowlist = new RecordingAllowlist(false);
      const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
      await assert.rejects(
        () => guard.canActivate(contextFor(url)),
        ForbiddenException,
        `${url} bypassed the allowlist`,
      );
      assert.equal(allowlist.asked.length, 1, `${url} did not reach the allowlist`);
    }
  });

  it('consults the allowlist for an absolute-form request target', async () => {
    // The second spelling. `originalUrl` here is the WHOLE URI, so no prefix
    // test on the raw target can match — while Express goes on dispatching to
    // the admin handler by the pathname inside it. The authority is not the
    // guard's business and deliberately varies below, including a foreign host
    // and userinfo: none of it changes which handler serves the request.
    for (const url of [
      'http://panel.example.com/api/admin/auth/login',
      'https://evil.example/api/admin/users',
      'HTTP://panel.example.com/api/ADMIN/users',
      'http://user:pw@panel.example.com:8443/api/admin/users',
      'http://panel.example.com/api/admin/users?search=BOB&page=2',
    ]) {
      const allowlist = new RecordingAllowlist(false);
      const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
      await assert.rejects(
        () => guard.canActivate(contextFor(url)),
        ForbiddenException,
        `${url} walked past the allowlist. Node accepts an absolute-form ` +
          'request target and Express routes it by its pathname, so this ' +
          'reaches the real admin handler — the guard just declined to look.',
      );
      assert.equal(allowlist.asked.length, 1, `${url} did not reach the allowlist`);
    }
  });

  it('still consults the allowlist for the exact lower-case path', async () => {
    const allowlist = new RecordingAllowlist(false);
    const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
    await assert.rejects(
      () => guard.canActivate(contextFor('/api/admin/auth/login')),
      ForbiddenException,
    );
    assert.deepStrictEqual(allowlist.asked, ['203.0.113.9']);
  });

  it('keeps a query string from changing the answer', async () => {
    // `originalUrl` carries the query. Only the prefix is examined, and it must
    // stay that way — a guard that stopped matching once a query appeared would
    // be bypassable by appending `?x=1`.
    const allowlist = new RecordingAllowlist(false);
    const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
    await assert.rejects(
      () => guard.canActivate(contextFor('/api/ADMIN/users?search=BOB&page=2')),
      ForbiddenException,
    );
    assert.equal(allowlist.asked.length, 1);
  });

  it('leaves non-admin surfaces alone, in any case', async () => {
    // The scope of the allowlist is unchanged by the fix: the internal API and
    // the user-facing paths are never subject to it. A guard that started
    // matching `/api/internal/...` would take reiwa down.
    for (const url of [
      '/api/internal/user/session',
      '/api/INTERNAL/user/session',
      '/api/health',
      '/uploads/faq/a.png',
      '/api/administrators',
      '/api/admin',
    ]) {
      const allowlist = new RecordingAllowlist(false);
      const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
      assert.equal(await guard.canActivate(contextFor(url)), true, `${url} was gated`);
      assert.deepStrictEqual(allowlist.asked, [], `${url} was sent to the allowlist`);
    }
  });
});

describe('AdminIpAllowlistGuard — the parse answers what the router answers', () => {
  // The guard is only ever correct relative to the router. Reading a pathname
  // out of the target is the fix; NORMALISING one would be a different bug,
  // because Express normalises nothing — it matches the raw path. Every
  // spelling below was fired at the installed Express 5.2.1 through a real
  // socket and answered 404: no admin handler ever sees them. A guard that
  // collapsed dot segments, squashed slashes or percent-decoded would start
  // deciding "admin request" about traffic that does not exist, and — the
  // reason this is a test and not a comment — the obvious implementation,
  // `new URL(target, base)`, does exactly that. It also reads `//api/admin/x`
  // as a protocol-relative URL and answers `/admin/x`, which is not the string
  // the router matched on. Answering about a different path than the router is
  // the whole defect class this file exists for; it must not be reintroduced
  // in the shape of a fix.
  const routerRefuses = [
    '//api/admin/users',
    '/api//admin/users',
    '/api/./admin/users',
    '/api/x/../admin/users',
    '/api/%61dmin/users',
    '/api/admin./users',
    '/api/\u0430dmin/users',
  ];

  it('leaves alone the spellings Express refuses to route', async () => {
    for (const url of routerRefuses) {
      const allowlist = new RecordingAllowlist(false);
      const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
      assert.equal(
        await guard.canActivate(contextFor(url)),
        true,
        `${url} is now gated, but Express 5.2.1 answers 404 for it — the ` +
          'guard has started normalising a path the router does not',
      );
      assert.deepStrictEqual(allowlist.asked, [], `${url} was sent to the allowlist`);
    }
  });

  it('strips the query and the fragment, and nothing else, from the path', async () => {
    // `;x=1` is part of the path (a path parameter), not the query, and Express
    // treats it that way — so the guard must too.
    const allowlist = new RecordingAllowlist(false);
    const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
    await assert.rejects(
      () => guard.canActivate(contextFor('/api/admin/users;x=1?q=2#frag')),
      ForbiddenException,
      'a path parameter or a fragment stopped the prefix from matching',
    );
    assert.equal(allowlist.asked.length, 1);
  });
});

describe('AdminIpAllowlistGuard — the deliberate fail-open paths survive the fix', () => {
  it('allows when the allowlist service says the request is allowed', async () => {
    const allowlist = new RecordingAllowlist(true);
    const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
    assert.equal(await guard.canActivate(contextFor('/api/ADMIN/users')), true);
  });

  it('allows on an infra error — a Postgres hiccup must not lock operators out', async () => {
    const allowlist = new RecordingAllowlist(new Error('connection terminated'));
    const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
    assert.equal(await guard.canActivate(contextFor('/api/ADMIN/users')), true);
    assert.equal(allowlist.asked.length, 1, 'the error path was not reached');
  });

  it('allows when no client IP can be derived', async () => {
    const allowlist = new RecordingAllowlist(false);
    const guard = new AdminIpAllowlistGuard(allowlist as unknown as AdminIpAllowlistService);
    assert.equal(await guard.canActivate(contextFor('/api/ADMIN/users', null)), true);
    assert.deepStrictEqual(
      allowlist.asked,
      [],
      'the guard asked about an IP it could not determine',
    );
  });
});

// ── The routing premise, end to end ──────────────────────────────────────────

@Controller('admin/probe')
class CaseProbeController {
  @Get('ping')
  public ping(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Sends a request line verbatim. Neither supertest nor any HTTP client will
 * emit an absolute-form target, so the only way to fire the request this file
 * is about is to write the bytes.
 */
function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(buffer.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

describe('Express routing — the premise the guard fix rests on', () => {
  it('dispatches /api/ADMIN/PROBE/PING to the handler registered as admin/probe/ping', async () => {
    // If this ever fails, the case bypass is gone for a different reason and
    // the guard comment above is wrong. Either way the next reader needs to
    // know before they "tidy" the lower-casing away.
    const testingModule: TestingModule = await Test.createTestingModule({
      controllers: [CaseProbeController],
    }).compile();
    const application: INestApplication = testingModule.createNestApplication();
    application.setGlobalPrefix('api');
    await application.init();

    try {
      const upper = await request(application.getHttpServer()).get('/api/ADMIN/PROBE/PING');
      assert.equal(
        upper.status,
        200,
        'Express no longer routes case-insensitively here — the bypass this ' +
          'guard fix closes would have had a different shape',
      );
      assert.deepStrictEqual(upper.body, { ok: true });
    } finally {
      await application.close();
    }
  });
});

describe('AdminIpAllowlistGuard, end to end — both request-target forms are gated', () => {
  it('403s an absolute-form admin request and asks the allowlist about it', async () => {
    // The unit cases above pin the guard's decision; this pins that the
    // decision is the one the deployment actually makes. The guard is
    // registered exactly as `app.module.ts` registers it — `APP_GUARD`, ahead
    // of every controller-level guard — and the request is written to a real
    // socket, because the bypass lives in the request LINE and no HTTP client
    // will produce it for us.
    //
    // Before the fix, against this very setup:
    //   ORIGIN-FORM   -> HTTP/1.1 403 Forbidden | allowlist asked: 1
    //   ABSOLUTE-FORM -> HTTP/1.1 200 OK        | allowlist asked: 0
    const allowlist = new RecordingAllowlist(false);
    const testingModule: TestingModule = await Test.createTestingModule({
      controllers: [CaseProbeController],
      providers: [
        { provide: AdminIpAllowlistService, useValue: allowlist },
        { provide: APP_GUARD, useClass: AdminIpAllowlistGuard },
      ],
    }).compile();
    const application: INestApplication = testingModule.createNestApplication();
    application.setGlobalPrefix('api');
    await application.listen(0, '127.0.0.1');

    try {
      const { port } = application.getHttpServer().address() as AddressInfo;

      // Control: the spelling that was always gated. If this stops being 403
      // the whole comparison below is meaningless.
      allowlist.asked.length = 0;
      const originForm = await rawRequest(port, '/api/admin/probe/ping');
      assert.match(originForm, /^HTTP\/1\.1 403\b/u, `origin-form answered ${originForm}`);
      assert.equal(allowlist.asked.length, 1, 'origin-form did not reach the allowlist');

      for (const target of [
        `http://127.0.0.1:${port}/api/admin/probe/ping`,
        `http://127.0.0.1:${port}/api/ADMIN/probe/ping`,
        // The authority need not even be this server: Express routes on the
        // pathname regardless of what is in front of it.
        'https://evil.example/api/admin/probe/ping',
      ]) {
        allowlist.asked.length = 0;
        const status = await rawRequest(port, target);
        assert.match(
          status,
          /^HTTP\/1\.1 403\b/u,
          `${target} answered ${status} — an absolute-form request target ` +
            'reached the admin handler from a blocked IP. `originalUrl` is the ' +
            'whole URI for this spelling, so a prefix test on it never matches, ' +
            'while the router keeps dispatching on the pathname inside it.',
        );
        assert.equal(
          allowlist.asked.length,
          1,
          `${target}: the allowlist was never consulted — the guard returned ` +
            '"allow" on the prefix test alone',
        );
      }
    } finally {
      await application.close();
    }
  });
});
