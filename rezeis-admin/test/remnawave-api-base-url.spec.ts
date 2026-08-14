import { Logger } from '@nestjs/common';

import {
  classifyPanelHost,
  resolvePanelBaseUrl,
} from '../src/modules/remnawave/services/panel-base-url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of } from 'rxjs';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

/**
 * Focused coverage for `RemnawaveApiService#getBaseUrl()`.
 *
 * The legacy spec file (`remnawave-api.service.spec.ts`) contains additional
 * cases that depend on methods which no longer exist on the service — those
 * are unrelated to the base-URL resolution and predate the HTTPS-aware
 * change introduced here. Keeping these new tests in a dedicated file lets
 * the targeted coverage compile and run regardless of the legacy file's state.
 */
describe('RemnawaveApiService base URL resolution', () => {
  it('targets the public HTTPS upstream when REMNAWAVE_HOST is a domain', async () => {
    const capturedBaseURLs: Array<string | undefined> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly url: string; readonly baseURL?: string }) => {
          capturedBaseURLs.push(input.baseURL);
          return of({
            data: {
              response: {
                isLoginAllowed: true,
                isRegisterAllowed: false,
                authentication: {
                  passkey: { enabled: false },
                  oauth2: { providers: {} },
                  password: { enabled: true },
                },
                branding: { title: 'Panel', logoUrl: null },
              },
            },
          });
        },
      } as never,
      {
        // Public HTTPS-domain scenario: dotted host, port intentionally null.
        host: 'panel.example.com',
        port: null,
        token: 'secret',
        webhookSecret: null,
      },
    );

    await service.getStatus();

    assert.deepStrictEqual(capturedBaseURLs, ['https://panel.example.com']);
  });

  it('targets the docker service over plain HTTP when REMNAWAVE_HOST has no dot', async () => {
    const capturedBaseURLs: Array<string | undefined> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly url: string; readonly baseURL?: string }) => {
          capturedBaseURLs.push(input.baseURL);
          return of({
            data: {
              response: {
                isLoginAllowed: true,
                isRegisterAllowed: false,
                authentication: {
                  passkey: { enabled: false },
                  oauth2: { providers: {} },
                  password: { enabled: true },
                },
                branding: { title: 'Panel', logoUrl: null },
              },
            },
          });
        },
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
      },
    );

    await service.getStatus();

    assert.deepStrictEqual(capturedBaseURLs, ['http://remnawave:3000']);
  });

  it('reports remnawave as not configured when a docker-style host has no port', async () => {
    const service = new RemnawaveApiService(
      { request: () => of({ data: {} }) } as never,
      {
        host: 'remnawave',
        port: null,
        token: 'secret',
        webhookSecret: null,
      },
    );

    assert.deepStrictEqual(await service.getStatus(), {
      isConfigured: false,
      isReachable: false,
      isLoginAllowed: null,
      isRegisterAllowed: null,
      authentication: null,
      branding: null,
    });
  });

  it('still treats a missing host as not configured', async () => {
    const service = new RemnawaveApiService(
      { request: () => of({ data: {} }) } as never,
      {
        host: null,
        port: 3000,
        token: 'secret',
        webhookSecret: null,
      },
    );

    assert.deepStrictEqual(await service.getStatus(), {
      isConfigured: false,
      isReachable: false,
      isLoginAllowed: null,
      isRegisterAllowed: null,
      authentication: null,
      branding: null,
    });
  });
});

// в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
//  The resolution table itself
// в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/**
 * `REMNAWAVE_HOST` used to be classified by one test — "does it contain a dot?"
 * — and every address literal contains dots. `10.0.0.5` with `REMNAWAVE_PORT`
 * set therefore resolved to `https://10.0.0.5`, i.e. TLS on 443, with the port
 * silently discarded; the only evidence was `ECONNREFUSED 10.0.0.5:443` naming a
 * port nobody had configured. These pin the shape of each case, because the
 * cases are the whole of the logic.
 */
describe('resolvePanelBaseUrl — a dot does not make an address a domain', () => {
  it('a docker service name takes plain HTTP with its port', () => {
    assert.deepEqual(resolvePanelBaseUrl('remnawave', 3000), {
      url: 'http://remnawave:3000',
      warning: null,
    });
  });

  it('a docker service name with no port stays unconfigured, and says why', () => {
    const resolved = resolvePanelBaseUrl('remnawave', null);
    assert.equal(resolved.url, null);
    assert.match(String(resolved.warning), /REMNAWAVE_PORT is not set/);
  });

  it('a public domain takes HTTPS and needs no port', () => {
    assert.deepEqual(resolvePanelBaseUrl('panel.example.com', null), {
      url: 'https://panel.example.com',
      warning: null,
    });
  });

  it('a public domain WITH a port keeps HTTPS but says the port is discarded', () => {
    const resolved = resolvePanelBaseUrl('panel.example.com', 8080);
    assert.equal(resolved.url, 'https://panel.example.com');
    // Naming both the port and the resolved URL is the point: "my port is
    // ignored" is otherwise indistinguishable from "the panel is down".
    assert.match(String(resolved.warning), /8080 is ignored/);
    assert.match(String(resolved.warning), /https:\/\/panel\.example\.com/);
  });

  it('an IPv4 literal with a port takes plain HTTP — the reported bug', () => {
    assert.deepEqual(resolvePanelBaseUrl('10.0.0.5', 8080), {
      url: 'http://10.0.0.5:8080',
      warning: null,
    });
  });

  it('an IPv4 literal with NO port keeps its old HTTPS answer, and explains it', () => {
    // Deliberately not changed to `null`. There is no port to build a
    // plain-HTTP URL from, and a deployment terminating TLS at a bare IP works
    // today — taking it dark on an upgrade would be a worse answer than the
    // one it already has.
    const resolved = resolvePanelBaseUrl('10.0.0.5', null);
    assert.equal(resolved.url, 'https://10.0.0.5');
    assert.match(String(resolved.warning), /address literal/);
  });

  it('localhost with a port takes plain HTTP', () => {
    assert.deepEqual(resolvePanelBaseUrl('localhost', 8080), {
      url: 'http://localhost:8080',
      warning: null,
    });
  });

  it('a name under .localhost is local however many dots it has', () => {
    // RFC 6761 reserves the whole tree to the loopback, so the dot rule was
    // wrong about this one too.
    assert.equal(resolvePanelBaseUrl('panel.localhost', 8080).url, 'http://panel.localhost:8080');
  });

  it('an IPv6 literal is bracketed, and an already-bracketed one is not doubled', () => {
    assert.equal(resolvePanelBaseUrl('::1', 8080).url, 'http://[::1]:8080');
    assert.equal(resolvePanelBaseUrl('[fe80::1]', 8080).url, 'http://[fe80::1]:8080');
    // Unbracketed, the colons would be read as the port separator.
    assert.equal(resolvePanelBaseUrl('::1', null).url, 'https://[::1]');
  });

  it('a dotted value that is NOT a valid address stays a public domain', () => {
    // `999.1.1.1` and `1.2.3` look numeric but cannot be addresses, so the
    // widened rule must not swallow them — they are still DNS names.
    assert.equal(resolvePanelBaseUrl('999.1.1.1', null).url, 'https://999.1.1.1');
    assert.equal(resolvePanelBaseUrl('1.2.3', null).url, 'https://1.2.3');
  });

  it('classifies each family explicitly', () => {
    assert.equal(classifyPanelHost('remnawave'), 'service');
    assert.equal(classifyPanelHost('panel.example.com'), 'public');
    assert.equal(classifyPanelHost('LocalHost'), 'privateLiteral');
    assert.equal(classifyPanelHost('127.0.0.1'), 'privateLiteral');
    assert.equal(classifyPanelHost('10.0.0.5'), 'privateLiteral');
    assert.equal(classifyPanelHost('192.168.1.4'), 'privateLiteral');
    assert.equal(classifyPanelHost('172.16.0.1'), 'privateLiteral');
    assert.equal(classifyPanelHost('172.32.0.1'), 'public', '172.32 is outside RFC 1918');
    assert.equal(classifyPanelHost('::1'), 'privateLiteral');
    assert.equal(classifyPanelHost('fd00::1'), 'privateLiteral');
    // Routable, so it is treated exactly like a domain — see the test below.
    assert.equal(classifyPanelHost('203.0.113.10'), 'public');
    assert.equal(classifyPanelHost('2606:4700::1111'), 'public');
    assert.equal(classifyPanelHost('256.0.0.1'), 'public', 'not a valid address at all');
  });

  it('a ROUTABLE address keeps HTTPS even with a port, and says why', () => {
    // The port is refused here on purpose. Honouring it would mean plain HTTP
    // across the internet carrying REMNAWAVE_TOKEN — and it would be a NEW
    // hole, because this host resolved to `https://` before and merely failed
    // to connect. "Does not connect" beats "connects in the clear".
    const resolved = resolvePanelBaseUrl('203.0.113.10', 8080);
    assert.equal(resolved.url, 'https://203.0.113.10');
    assert.match(String(resolved.warning), /8080 is ignored/);
    assert.match(String(resolved.warning), /public internet/);
  });

  it('a routable IPv6 literal is bracketed on the HTTPS side too', () => {
    assert.equal(resolvePanelBaseUrl('2606:4700::1111', null).url, 'https://[2606:4700::1111]');
  });

  it('an absent or blank host is unconfigured, silently', () => {
    // Not a misconfiguration — it is how the integration is switched off.
    assert.deepEqual(resolvePanelBaseUrl(null, 3000), { url: null, warning: null });
    assert.deepEqual(resolvePanelBaseUrl('   ', 3000), { url: null, warning: null });
  });
});

/**
 * `REMNAWAVE_HOST` is documented as bare — "without HTTP/HTTPS and without
 * trailing slash", the wording the upstream project this convention came from
 * uses too. Operators write both anyway, and before this the resolver did not
 * refuse them, it MANGLED them: a scheme survived the embedded-port split (two
 * parts, the second not digits), fell into the IPv6 branch on its `:` and came
 * back bracketed as `https://[https://panel.example.com]`. That is not a URL,
 * so every request died at the transport with nothing in the log naming why.
 *
 * The security rule is unchanged and is what the last two cases are for: a
 * declared scheme may say anything except "plain HTTP to a routable host".
 */
describe('resolvePanelBaseUrl — a scheme or a slash in the host field', () => {
  it('accepts a host that carries its own scheme instead of bracketing it', () => {
    // Was `https://[https://2get.pro]` — an address no request could reach.
    assert.deepEqual(resolvePanelBaseUrl('https://2get.pro', null), {
      url: 'https://2get.pro',
      warning: null,
    });
  });

  it('keeps a scheme together with an embedded port', () => {
    assert.deepEqual(resolvePanelBaseUrl('https://panel.example.com:8443', null), {
      url: 'https://panel.example.com:8443',
      warning: null,
    });
  });

  it('strips trailing slashes so they cannot double up against request paths', () => {
    assert.deepEqual(resolvePanelBaseUrl('2get.pro/', null), {
      url: 'https://2get.pro',
      warning: null,
    });
    assert.deepEqual(resolvePanelBaseUrl('https://2get.pro///', null), {
      url: 'https://2get.pro',
      warning: null,
    });
  });

  it('treats a scheme with nothing after it as unconfigured rather than as a host', () => {
    assert.deepEqual(resolvePanelBaseUrl('https://', 3000), { url: null, warning: null });
  });

  it('honours an explicit scheme on a private target, in both directions', () => {
    // A private panel terminating its own TLS is the operator's to declare, and
    // `http://` there is the default this branch already had.
    assert.equal(resolvePanelBaseUrl('https://10.0.0.5', 8080).url, 'https://10.0.0.5:8080');
    assert.equal(resolvePanelBaseUrl('http://10.0.0.5', 8080).url, 'http://10.0.0.5:8080');
    assert.equal(resolvePanelBaseUrl('http://10.0.0.5', null).url, 'http://10.0.0.5');
  });

  it('REFUSES plain HTTP to a routable host even when the operator wrote it', () => {
    // The same refusal as the discarded port, for the same reason: the token
    // would cross the internet in clear. A declared scheme does not get a vote
    // on this one.
    const resolved = resolvePanelBaseUrl('http://2get.pro', null);
    assert.equal(resolved.url, 'https://2get.pro');
    assert.match(resolved.warning ?? '', /plain HTTP .* in clear|in clear/);
  });

  it('says BOTH things when the operator wrote a downgrade and a port', () => {
    // The caller latches on the first warning per service instance, so a branch
    // that returned only one of these would silence the other for the life of
    // the process.
    const resolved = resolvePanelBaseUrl('http://2get.pro', 3000);
    assert.equal(resolved.url, 'https://2get.pro');
    assert.match(resolved.warning ?? '', /in clear/);
    assert.match(resolved.warning ?? '', /REMNAWAVE_PORT 3000 is ignored/);
  });
});

describe('RemnawaveApiService — the discarded port is said out loud, once', () => {
  function capture() {
    const warns: string[] = [];
    const original = Logger.prototype.warn;
    Logger.prototype.warn = function patched(message: unknown): void {
      warns.push(String(message));
    } as typeof Logger.prototype.warn;
    return { warns, restore: () => { Logger.prototype.warn = original; } };
  }

  function service(host: string | null, port: number | null, seen: Array<string | undefined>) {
    return new RemnawaveApiService(
      {
        request: (input: { readonly baseURL?: string }) => {
          seen.push(input.baseURL);
          // The full auth-status envelope: `getStatus` validates it and throws
          // on anything thinner, which would fail these tests for a reason that
          // has nothing to do with the base URL.
          return of({
            data: {
              response: {
                isLoginAllowed: true,
                isRegisterAllowed: false,
                authentication: {
                  passkey: { enabled: false },
                  oauth2: { providers: {} },
                  password: { enabled: true },
                },
                branding: { title: 'Panel', logoUrl: null },
              },
            },
          });
        },
      } as never,
      { host, port, token: 'secret', webhookSecret: null },
    );
  }

  it('reaches an IPv4 panel over plain HTTP on its configured port', async () => {
    const seen: Array<string | undefined> = [];
    const captured = capture();
    try {
      await service('10.0.0.5', 8080, seen).getStatus();
    } finally {
      captured.restore();
    }
    assert.deepEqual(seen, ['http://10.0.0.5:8080']);
    assert.deepEqual(captured.warns, [], 'a correct configuration must not warn');
  });

  it('warns ONCE about a discarded port, not once per request', async () => {
    // `getBaseUrl()` runs on every call. Without the latch this is a line
    // repeated for the life of the process, which is the same as no line.
    const seen: Array<string | undefined> = [];
    const captured = capture();
    try {
      const svc = service('panel.example.com', 8080, seen);
      await svc.getStatus();
      await svc.getStatus();
      await svc.getStatus();
    } finally {
      captured.restore();
    }
    assert.deepEqual(seen, [
      'https://panel.example.com',
      'https://panel.example.com',
      'https://panel.example.com',
    ]);
    assert.equal(captured.warns.length, 1, `saw ${JSON.stringify(captured.warns)}`);
    assert.match(captured.warns[0], /8080 is ignored/);
  });
});

