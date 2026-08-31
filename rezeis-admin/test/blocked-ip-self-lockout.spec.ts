import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BlockedIpsController } from '../src/modules/blocked-ips/controllers/blocked-ips.controller';

/**
 * An operator must not be able to lock themselves out of the panel.
 *
 * `BlockedIpGuard` is the FIRST global guard — ahead of the admin IP allowlist
 * and ahead of the JWT guard — so a blocked address is turned away before
 * anything can recognise it as an operator's. Being allowlisted does not help;
 * being signed in does not help. The only way back is an UPDATE against the
 * database, which is not available from the panel you just closed.
 *
 * The mistake is ordinary: blocking a pest who shares your office NAT, or
 * pasting a /24 to stop a scan without noticing you are inside it.
 */

const ADMIN = { id: 'admin-1' } as never;

function build() {
  const created: Array<Record<string, unknown>> = [];
  const service = {
    create: async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: 'ip-1', ...input };
    },
  };
  return { controller: new BlockedIpsController(service as never), created };
}

function reqFrom(ip: string | undefined) {
  // Shaped like Express: `req.ip` is what honours `trust proxy`, and the socket
  // is the fallback the resolver reads when it is absent.
  return { ip, socket: { remoteAddress: ip } } as never;
}

describe('the IP blocklist refuses to lock the operator out', () => {
  it('refuses an exact match on the caller’s own address', async () => {
    const { controller, created } = build();

    await assert.rejects(
      () => controller.create({ address: '203.0.113.7' } as never, ADMIN, reqFrom('203.0.113.7')),
      /your own address/i,
    );
    assert.deepStrictEqual(created, [], 'refused, but the entry was written anyway');
  });

  it('refuses a CIDR that CONTAINS the caller, which is the likelier mistake', async () => {
    // String equality would pass this. Pasting a /24 to stop a scan without
    // noticing you are inside it is the ordinary version of this accident.
    const { controller, created } = build();

    await assert.rejects(
      () => controller.create({ address: '203.0.113.0/24' } as never, ADMIN, reqFrom('203.0.113.7')),
      /your own address/i,
    );
    assert.deepStrictEqual(created, []);
  });

  it('recognises the caller through the IPv4-mapped spelling', async () => {
    // Node hands `::ffff:1.2.3.4` to a dual-stack listener, and every entry
    // here is compared family-first — so an unstripped mapped address matches
    // nothing and the check would wave the operator straight through.
    const { controller, created } = build();

    await assert.rejects(
      () =>
        controller.create(
          { address: '203.0.113.7' } as never,
          ADMIN,
          reqFrom('::ffff:203.0.113.7'),
        ),
      /your own address/i,
    );
    assert.deepStrictEqual(created, []);
  });

  it('still blocks somebody else', async () => {
    // The guard must not become a reason the feature stops working.
    const { controller, created } = build();

    await controller.create({ address: '198.51.100.9' } as never, ADMIN, reqFrom('203.0.113.7'));

    assert.equal(created.length, 1);
    assert.equal(created[0]?.address, '198.51.100.9');
  });

  it('still blocks a CIDR the caller is outside of', async () => {
    const { controller, created } = build();

    await controller.create({ address: '198.51.100.0/24' } as never, ADMIN, reqFrom('203.0.113.7'));

    assert.equal(created.length, 1);
  });

  it('does not refuse everything when the caller has no derivable address', async () => {
    // Fail OPEN here, deliberately. The guard itself lets a request through
    // when it cannot derive an address, so treating "unknown" as a match would
    // break the whole feature to protect against a case the guard ignores.
    const { controller, created } = build();

    await controller.create({ address: '203.0.113.7' } as never, ADMIN, reqFrom(undefined));

    assert.equal(created.length, 1);
  });

  it('leaves an unparseable address to the service to reject', async () => {
    // Not this check's job to report a malformed entry, and swallowing it here
    // would replace the service's precise error with a confusing one.
    const { controller, created } = build();

    await controller.create({ address: 'not-an-address' } as never, ADMIN, reqFrom('203.0.113.7'));

    assert.equal(created.length, 1);
  });
});
