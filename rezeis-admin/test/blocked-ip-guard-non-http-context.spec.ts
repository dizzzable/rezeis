import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { BlockedIpGuard } from '../src/modules/blocked-ips/guards/blocked-ip.guard';
import type { BlockedIpService } from '../src/modules/blocked-ips/services/blocked-ip.service';

/**
 * DEFECT 2 — what `BlockedIpGuard` does when the context is not an HTTP one.
 *
 * The guard used to read `request.socket.remoteAddress` with no optional
 * chaining and OUTSIDE its try, so anything that is not an Express request made
 * it throw a `TypeError` out of a guard — a failure mode neither of its two
 * fail-open branches can catch. Its sibling `AdminIpAllowlistGuard` already
 * wrote `request.socket?.remoteAddress` on the equivalent line; this file had
 * simply drifted.
 *
 * A CORRECTION TO THE REPORT THAT PROMPTED THIS. The review held that the
 * throw broke `@SubscribeMessage` handlers because "global guards DO run" on
 * them. Measured against this app, they do not run at all: an `APP_GUARD` that
 * records every context it is handed logged the HTTP probe and never once saw a
 * `ws` context, and a real Socket.IO `subscribe` frame was acknowledged
 * normally — `43/realtime,1[{"ok":true,...}]` — in the same run. The cause is in
 * the framework: `SocketModule.getContextCreator()` builds
 * `new GuardsContextCreator(container)` WITHOUT the `ApplicationConfig`
 * (`@nestjs/websockets@11.1.23/socket-module.js`), so `getGlobalMetadata()`
 * reads an undefined config and returns `[]`. No `APP_GUARD` reaches a gateway.
 *
 * So nothing hands this guard a `ws` context TODAY. `BlockedIpsModule` is
 * `@Global()` and exports the guard precisely so a controller — or a gateway —
 * can `@UseGuards(BlockedIpGuard)`, and these tests pin what happens the moment
 * one does: the guard resolves the address and answers honestly. It neither
 * allows blind (which is how the sibling defect happened) nor denies blind.
 */

function makeGuard(
  blockedAddresses: readonly string[],
  trustProxy?: 'disabled' | 'loopback' | 'uniquelocal',
): { guard: BlockedIpGuard; asked: string[] } {
  const asked: string[] = [];
  const service = {
    isBlocked: async (ip: string) => {
      asked.push(ip);
      return { blocked: blockedAddresses.includes(ip) };
    },
  } as unknown as BlockedIpService;
  const guard = new BlockedIpGuard(
    service,
    trustProxy === undefined ? undefined : ({ trustProxy } as never),
  );
  return { guard, asked };
}

/** The real `ExecutionContextHost` Nest hands a guard, typed as a WS context. */
function wsContext(client: unknown): ExecutionContextHost {
  const context = new ExecutionContextHost([client, { topics: [] }]);
  context.setType('ws');
  return context;
}

function httpContext(request: unknown): ExecutionContextHost {
  const context = new ExecutionContextHost([request, {}, () => undefined]);
  context.setType('http');
  return context;
}

function rpcContext(data: unknown): ExecutionContextHost {
  const context = new ExecutionContextHost([data, {}]);
  context.setType('rpc');
  return context;
}

/** The shape of a Socket.IO `Socket` the guard can read an address from. */
function socketClient(
  address: string,
  headers: Record<string, string> = {},
): Record<string, unknown> {
  return {
    id: 'sock-1',
    handshake: { address, headers, auth: {}, query: {} },
    conn: { remoteAddress: address },
  };
}

describe('BlockedIpGuard on a WebSocket execution context', () => {
  it('refuses a blocked address instead of throwing a TypeError', async () => {
    const { guard, asked } = makeGuard(['203.0.113.5']);

    const outcome = await guard
      .canActivate(wsContext(socketClient('203.0.113.5')) as never)
      .then(
        (allowed) => ({ allowed, error: null as unknown }),
        (error: unknown) => ({ allowed: null, error }),
      );

    assert.ok(outcome.error instanceof ForbiddenException, 'expected a refusal, got: ' + String(outcome.error));
    assert.deepEqual(asked, ['203.0.113.5'], 'the blocklist was never consulted');
  });

  it('lets an unblocked address through — the guard is not a blanket deny', async () => {
    // ANTI-VACUITY CONTROL. "Deny every non-HTTP context" would pass the test
    // above and quietly kill any gateway this guard is ever attached to.
    const { guard, asked } = makeGuard(['203.0.113.5']);

    const allowed = await guard.canActivate(wsContext(socketClient('198.51.100.7')) as never);

    assert.equal(allowed, true);
    assert.deepEqual(asked, ['198.51.100.7']);
  });

  it('resolves the forwarded client behind a trusted proxy, not the proxy itself', async () => {
    // The reason the WS branch resolves rather than reading the raw peer:
    // behind the reverse proxy this panel normally runs behind, every client
    // presents as the proxy, and a per-client blocklist that can never match a
    // client is a protection that does not run.
    const { guard, asked } = makeGuard(['203.0.113.5'], 'loopback');

    const outcome = await guard
      .canActivate(
        wsContext(socketClient('127.0.0.1', { 'x-forwarded-for': '203.0.113.5' })) as never,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    assert.ok(outcome instanceof ForbiddenException, 'the forwarded client was not resolved');
    assert.deepEqual(asked, ['203.0.113.5'], 'the guard asked about the proxy, not the client');
  });

  it('ignores X-Forwarded-For when the peer is not a trusted proxy', async () => {
    // The other half, and the one that matters for a BLOCKlist: a header must
    // not be a way to step out of a block.
    const { guard, asked } = makeGuard(['203.0.113.5'], 'disabled');

    const allowed = await guard.canActivate(
      wsContext(socketClient('203.0.113.5', { 'x-forwarded-for': '198.51.100.7' })) as never,
    ).then(
      () => 'allowed',
      (error: unknown) => (error instanceof ForbiddenException ? 'refused' : 'threw'),
    );

    assert.equal(allowed, 'refused', 'a spoofed header stepped out of the block');
    assert.deepEqual(asked, ['203.0.113.5']);
  });

  it('does not throw when the client carries no address at all', async () => {
    const { guard, asked } = makeGuard(['203.0.113.5']);

    const allowed = await guard.canActivate(wsContext({ id: 'sock-2' }) as never);

    assert.equal(allowed, true, 'no derivable IP is the documented fail-open, not a crash');
    assert.deepEqual(asked, [], 'the blocklist cannot be asked about an address we do not have');
  });
});

describe('BlockedIpGuard on other execution contexts', () => {
  it('allows an RPC context, whose transport carries no client address', async () => {
    const { guard, asked } = makeGuard(['203.0.113.5']);

    const allowed = await guard.canActivate(rpcContext({ pattern: 'x' }) as never);

    assert.equal(allowed, true);
    assert.deepEqual(asked, []);
  });

  it('still reads req.ip on an HTTP context — the original behaviour is intact', async () => {
    const { guard, asked } = makeGuard(['203.0.113.5']);

    const outcome = await guard
      .canActivate(
        httpContext({
          ip: '::ffff:203.0.113.5',
          socket: { remoteAddress: '10.0.0.1' },
          headers: {},
        }) as never,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    assert.ok(outcome instanceof ForbiddenException);
    assert.deepEqual(asked, ['203.0.113.5'], 'the IPv4-mapped prefix must still be stripped');
  });

  it('falls back to the peer address when req.ip is absent', async () => {
    const { guard, asked } = makeGuard([]);

    const allowed = await guard.canActivate(
      httpContext({ socket: { remoteAddress: '::ffff:198.51.100.7' }, headers: {} }) as never,
    );

    assert.equal(allowed, true);
    assert.deepEqual(asked, ['198.51.100.7']);
  });

  it('does not throw on an HTTP-typed context with no socket', async () => {
    const { guard, asked } = makeGuard(['203.0.113.5']);

    const allowed = await guard.canActivate(httpContext({ headers: {} }) as never);

    assert.equal(allowed, true);
    assert.deepEqual(asked, []);
  });
});
