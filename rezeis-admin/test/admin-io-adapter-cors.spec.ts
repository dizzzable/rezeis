import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import type { INestApplicationContext } from '@nestjs/common';
import type { Server as IoServer, ServerOptions } from 'socket.io';

import { CORS_ALLOWED_METHODS, type CorsOriginConfig } from '../src/common/http/cors-origin';
import { AdminIoAdapter } from '../src/common/realtime/admin-io.adapter';

/**
 * SOCKET.IO HANDSHAKES ARE HELD TO THE SAME ORIGIN ALLOWLIST AS HTTP.
 *
 * `AdminIoAdapter` exists for one line: it overrides whatever `cors` a gateway
 * declares with the runtime-validated `ADMIN_CORS_ORIGINS`, because a gateway
 * decorator can only carry a static value. No spec constructed the adapter, so
 * deleting that override — or spreading the gateway's options AFTER it, which
 * lets a hardcoded `origin: true` win — left every test green.
 *
 * Asserted at the wire: a real HTTP server, the adapter attaching socket.io to
 * it exactly as `main.ts` does through the app (`createIOServer(0, …)`), and an
 * engine.io polling handshake sent with an `Origin` header. What a browser
 * would enforce is what the response headers say.
 *
 * Scope, so this is not read as more than it is: CORS binds browsers on the
 * polling transport. WebSocket upgrades are not CORS-gated at all, and the
 * handshake token comes from `auth`, a header or the query — never a cookie —
 * so the gateway's own JWT check is the authentication, not this.
 */

const GATEWAY_PATH = '/api/socket.io';
const PANEL = 'https://panel.example.com';
const OPS = 'https://ops.example.com';
const FOREIGN = 'https://evil.example.net';

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Harness {
  send(method: 'GET' | 'OPTIONS', path: string, headers?: Record<string, string>): Promise<Answer>;
  close(): Promise<void>;
}

async function startAdapter(corsOrigins: CorsOriginConfig, gatewayOptions: Partial<ServerOptions>): Promise<Harness> {
  const http: HttpServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end('not socket.io');
  });
  // A non-Nest argument is kept as the HTTP server itself (AbstractWsAdapter),
  // and port 0 attaches socket.io to it — the path main.ts takes via the app.
  const adapter = new AdminIoAdapter(http as unknown as INestApplicationContext, corsOrigins);
  const io = adapter.createIOServer(0, gatewayOptions as ServerOptions) as IoServer;
  await new Promise<void>((listening) => http.listen(0, '127.0.0.1', listening));
  const { port } = http.address() as AddressInfo;

  return {
    send: (method, path, headers = {}) =>
      new Promise<Answer>((answered, failed) => {
        const outgoing = httpRequest(
          { host: '127.0.0.1', port, method, path, headers, agent: false },
          (incoming) => {
            let body = '';
            incoming.setEncoding('utf8');
            incoming.on('data', (chunk: string) => {
              body += chunk;
            });
            incoming.on('end', () => answered({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
          },
        );
        outgoing.on('error', failed);
        outgoing.end();
      }),
    // Closes the engine.io sessions the handshakes opened, then the HTTP server.
    close: () => new Promise<void>((closed) => io.close(() => closed())),
  };
}

const handshakePath = (path: string): string => `${path}/?EIO=4&transport=polling`;

describe('AdminIoAdapter: the realtime handshake answers only allowlisted origins', () => {
  it('lets an allowlisted origin read the handshake, with credentials', async () => {
    const harness = await startAdapter([PANEL, OPS], { path: GATEWAY_PATH });
    try {
      const answer = await harness.send('GET', handshakePath(GATEWAY_PATH), { Origin: PANEL });

      assert.equal(answer.status, 200);
      assert.ok(answer.body.startsWith('0'), `not an engine.io open packet: ${answer.body.slice(0, 40)}`);
      assert.equal(
        answer.headers['access-control-allow-origin'],
        PANEL,
        'an allowlisted admin origin cannot read the socket.io handshake — the adapter no ' +
          'longer hands ADMIN_CORS_ORIGINS to socket.io',
      );
      assert.equal(answer.headers['access-control-allow-credentials'], 'true');

      // The whole list, not one fixed value.
      const second = await harness.send('GET', handshakePath(GATEWAY_PATH), { Origin: OPS });
      assert.equal(second.headers['access-control-allow-origin'], OPS);
    } finally {
      await harness.close();
    }
  });

  it('gives a foreign origin no CORS grant', async () => {
    const harness = await startAdapter([PANEL, OPS], { path: GATEWAY_PATH });
    try {
      const answer = await harness.send('GET', handshakePath(GATEWAY_PATH), { Origin: FOREIGN });

      // No allow-origin is the refusal a browser enforces. (`cors` still sends
      // allow-credentials whenever credentials are on, matched origin or not —
      // the HTTP server's `enableCors` answers the same way.)
      assert.equal(answer.headers['access-control-allow-origin'], undefined);
    } finally {
      await harness.close();
    }
  });

  it('overrides a gateway that declares its own open cors', async () => {
    // The mistake the gateway's comment warns against: `origin: true` there
    // would reflect ANY origin with credentials.
    const harness = await startAdapter([PANEL, OPS], {
      path: GATEWAY_PATH,
      cors: { origin: true, credentials: true },
    });
    try {
      const answer = await harness.send('GET', handshakePath(GATEWAY_PATH), { Origin: FOREIGN });

      assert.equal(
        answer.headers['access-control-allow-origin'],
        undefined,
        "a gateway's own cors setting beat the allowlist: a foreign origin can read the handshake",
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps the gateway's other options, such as its path", async () => {
    const harness = await startAdapter([PANEL], { path: GATEWAY_PATH });
    try {
      const atGatewayPath = await harness.send('GET', handshakePath(GATEWAY_PATH), { Origin: PANEL });
      const atDefaultPath = await harness.send('GET', handshakePath('/socket.io'), { Origin: PANEL });

      assert.equal(atGatewayPath.status, 200);
      assert.equal(atDefaultPath.body, 'not socket.io', 'socket.io answered on its default path instead');
    } finally {
      await harness.close();
    }
  });

  it("answers a preflight with the HTTP server's method list", async () => {
    const harness = await startAdapter([PANEL], { path: GATEWAY_PATH });
    try {
      const answer = await harness.send('OPTIONS', handshakePath(GATEWAY_PATH), {
        Origin: PANEL,
        'Access-Control-Request-Method': 'POST',
      });

      assert.equal(answer.headers['access-control-allow-origin'], PANEL);
      assert.equal(answer.headers['access-control-allow-methods'], CORS_ALLOWED_METHODS.join(','));
    } finally {
      await harness.close();
    }
  });

  it('grants nothing when no origin is configured', async () => {
    // `parseCorsOrigins` returns false outside production when the variable is
    // empty; production refuses to start without it.
    const harness = await startAdapter(false, { path: GATEWAY_PATH });
    try {
      const answer = await harness.send('GET', handshakePath(GATEWAY_PATH), { Origin: PANEL });

      assert.equal(answer.status, 200);
      assert.equal(answer.headers['access-control-allow-origin'], undefined);
      assert.equal(answer.headers['access-control-allow-credentials'], undefined);
    } finally {
      await harness.close();
    }
  });
});
