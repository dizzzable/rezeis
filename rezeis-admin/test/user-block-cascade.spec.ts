import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserBlockService } from '../src/modules/users/services/user-block.service';

/**
 * What blocking an account actually DOES.
 *
 * Before this service existed, blocking was `UPDATE users SET is_blocked` and
 * nothing else — written twice, once per screen. The person kept their VPN,
 * kept their cabinet session, could sign back in with their password, and could
 * walk back in through `/start` with a fresh Telegram account.
 *
 * These tests are about the parts that reach OUTSIDE the users table, because
 * those are the parts that were missing. The one thing asserted about the flag
 * is that it is written FIRST — every other step depends on a network that can
 * be down, and an operator must never be shown a completed block that never
 * happened.
 */

interface Recorded {
  readonly updates: Array<Record<string, unknown>>;
  readonly syncJobs: Array<Record<string, unknown>>;
  readonly enqueued: string[];
  readonly captures: Array<Record<string, unknown>>;
  readonly releases: Array<Record<string, unknown>>;
  readonly ipCreates: Array<Record<string, unknown>>;
  readonly ipDeletes: string[];
  readonly drops: Array<Record<string, unknown>>;
}

const LINKED_SUBSCRIPTION = {
  id: 'subscription-1',
  remnawaveId: '4711',
  remnawavePanelId: 4711,
  remnawavePanelUsername: 'rz_sub_1',
};

function buildService(options: {
  readonly registrationIp?: string | null;
  readonly subscriptions?: ReadonlyArray<typeof LINKED_SUBSCRIPTION>;
  /** `null` makes every device read fail, as an unreachable panel would. */
  readonly devices?: readonly string[] | null;
  readonly nodeAddresses?: readonly string[];
  readonly existingIpEntryId?: string | null;
} = {}) {
  const recorded: Recorded = {
    updates: [],
    syncJobs: [],
    enqueued: [],
    captures: [],
    releases: [],
    ipCreates: [],
    ipDeletes: [],
    drops: [],
  };

  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        telegramId: 123n,
        email: 'blocked@example.test',
        registrationIp: options.registrationIp === undefined ? '192.0.2.55' : options.registrationIp,
        webAccount: { loginNormalized: 'abuser', emailNormalized: 'blocked@example.test' },
        subscriptions: options.subscriptions ?? [LINKED_SUBSCRIPTION],
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        recorded.updates.push(args.data);
        return {};
      },
    },
    profileSyncJob: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorded.syncJobs.push(args.data);
        return { id: `job-${recorded.syncJobs.length}` };
      },
    },
    blockedIp: {
      findFirst: async () =>
        options.existingIpEntryId === undefined || options.existingIpEntryId === null
          ? null
          : { id: options.existingIpEntryId },
    },
  };

  const identities = {
    captureFromUser: async (input: Record<string, unknown>) => {
      recorded.captures.push(input);
      const hwids = (input['hwids'] as readonly string[] | undefined) ?? [];
      return { identities: 3, devices: hwids.length };
    },
    releaseCascadeForUser: async (input: Record<string, unknown>) => {
      recorded.releases.push(input);
      return 4;
    },
  };

  const ips = {
    create: async (input: Record<string, unknown>) => {
      recorded.ipCreates.push(input);
      return {};
    },
    delete: async (id: string) => {
      recorded.ipDeletes.push(id);
    },
  };

  const remnawave = {
    getAllNodes: async () =>
      (options.nodeAddresses ?? ['203.0.113.10']).map((address) => ({ address, ips: [] })),
    strictListUserDevices: async () =>
      options.devices === null
        ? { kind: 'unavailable', retryAfterMs: null }
        : {
            kind: 'ok',
            value: {
              devices: (options.devices ?? ['hwid-aaa', 'hwid-bbb']).map((hwid) => ({ hwid })),
            },
          },
    dropConnections: async (input: Record<string, unknown>) => {
      recorded.drops.push(input);
      return { ok: true };
    },
  };

  const queue = {
    enqueue: async (id: string) => {
      recorded.enqueued.push(id);
    },
  };

  const service = new UserBlockService(
    prisma as never,
    identities as never,
    ips as never,
    remnawave as never,
    queue as never,
  );
  return { service, recorded };
}

describe('blocking a user — the identity and device cascade', () => {
  it('copies every identity the account carries onto the blocklist', async () => {
    // This is what makes the ban outlast the account. `is_blocked` can only
    // refuse a row that exists, and somebody registering again has none.
    const { service, recorded } = buildService();
    const report = await service.block({ userId: 'user-1', adminId: 'admin-1' });

    assert.equal(recorded.captures.length, 1);
    assert.equal(recorded.captures[0]['userId'], 'user-1');
    assert.equal(recorded.captures[0]['telegramId'], 123n);
    assert.equal(recorded.captures[0]['webLogin'], 'abuser');
    assert.equal(report.identitiesCaptured, 3);
  });

  it('reads the hardware ids off the VPN panel and lists them too', async () => {
    // The one identifier a ban evader carries across a new Telegram account and
    // a new mailbox: the client on the machine.
    const { service, recorded } = buildService();
    const report = await service.block({ userId: 'user-1', adminId: 'admin-1' });

    assert.deepStrictEqual(recorded.captures[0]['hwids'], ['hwid-aaa', 'hwid-bbb']);
    assert.equal(report.devicesCaptured, 2);
    assert.equal(report.devicesUnreadable, 0);
  });

  it('reports an unreadable device list instead of a confident empty one', async () => {
    // The distinction that matters to an operator: "this person has no devices"
    // and "we could not look" are different facts, and only one of them means
    // the ban is complete.
    const { service, recorded } = buildService({ devices: null });
    const report = await service.block({ userId: 'user-1', adminId: 'admin-1' });

    assert.deepStrictEqual(recorded.captures[0]['hwids'], []);
    assert.equal(report.devicesCaptured, 0);
    assert.equal(report.devicesUnreadable, 1);
  });

  it('writes the flag first, so an unreachable panel cannot lose the block', async () => {
    // Every step after the flag depends on a network that can be down. If the
    // expensive work ran first, a panel timeout would leave an account that was
    // never blocked at all after the operator watched a spinner.
    const { service, recorded } = buildService({ devices: null, nodeAddresses: [] });
    await service.block({ userId: 'user-1', adminId: 'admin-1' });
    assert.deepStrictEqual(recorded.updates, [{ isBlocked: true }]);
  });
});

describe('blocking a user — the VPN', () => {
  it('queues one status push per linked subscription and drops live connections', async () => {
    // The job survives an unreachable panel; the drop makes it immediate. Both
    // are needed: a status of DISABLED stops the NEXT handshake, while an
    // established tunnel keeps carrying traffic until it renegotiates.
    const { service, recorded } = buildService();
    const report = await service.block({ userId: 'user-1', adminId: 'admin-1' });

    assert.equal(recorded.syncJobs.length, 1);
    assert.equal(recorded.syncJobs[0]['action'], 'UPDATE');
    assert.deepStrictEqual(recorded.syncJobs[0]['payload'], {
      source: 'USER_BLOCK',
      propagateStatus: true,
    });
    assert.deepStrictEqual(recorded.enqueued, ['job-1']);
    assert.equal(report.subscriptionsQueued, 1);

    assert.equal(recorded.drops.length, 1);
    assert.deepStrictEqual(recorded.drops[0]['dropBy'], {
      by: 'userUuids',
      userUuids: ['4711'],
    });
    assert.equal(report.connectionsDropped, true);
  });

  it('does nothing upstream for an account with no panel link', async () => {
    // An imported or never-provisioned row has no profile to disable. Queuing a
    // job for it would fail forever in the sweep.
    const { service, recorded } = buildService({ subscriptions: [] });
    const report = await service.block({ userId: 'user-1', adminId: 'admin-1' });

    assert.equal(recorded.syncJobs.length, 0);
    assert.equal(recorded.drops.length, 0);
    assert.equal(report.subscriptionsQueued, 0);
    assert.equal(report.connectionsDropped, false);
  });
});

describe('blocking a user — the address', () => {
  it('lists an ordinary public registration address', async () => {
    const { service, recorded } = buildService({ registrationIp: '192.0.2.55' });
    const report = await service.block({ userId: 'user-1', adminId: 'admin-1' });

    assert.equal(recorded.ipCreates.length, 1);
    assert.equal(recorded.ipCreates[0]['address'], '192.0.2.55');
    assert.equal(recorded.ipCreates[0]['source'], 'cascade');
    assert.equal(report.ipListed, '192.0.2.55');
    assert.equal(report.ipRefusedBecause, null);
  });

  it('never lists an address belonging to one of our own nodes', async () => {
    // A customer who opens the cabinet while connected to the VPN registers
    // from a node exit address. Listing it would refuse every other customer
    // behind that node.
    const { service, recorded } = buildService({
      registrationIp: '203.0.113.10',
      nodeAddresses: ['203.0.113.10'],
    });
    const report = await service.block({ userId: 'user-1', adminId: 'admin-1' });

    assert.equal(recorded.ipCreates.length, 0);
    assert.equal(report.ipListed, null);
    assert.equal(report.ipRefusedBecause, 'OUR_NODE');
  });

  it('lists nothing when the node list could not be read', async () => {
    // Fail-closed. `getAllNodes()` answers `[]` on every failure, so an empty
    // answer cannot be told apart from an unreachable panel, and the safe
    // reading of both is that we did not check.
    const { service, recorded } = buildService({
      registrationIp: '192.0.2.55',
      nodeAddresses: [],
    });
    const report = await service.block({ userId: 'user-1', adminId: 'admin-1' });

    assert.equal(recorded.ipCreates.length, 0);
    assert.equal(report.ipRefusedBecause, 'NODES_UNKNOWN');
  });

  it('says so plainly when the account has no address at all', async () => {
    // The commonest outcome: a bot-first user never touched a browser edge.
    const { service, recorded } = buildService({ registrationIp: null });
    const report = await service.block({ userId: 'user-1', adminId: 'admin-1' });

    assert.equal(recorded.ipCreates.length, 0);
    assert.equal(report.ipRefusedBecause, 'NO_ADDRESS');
  });
});

describe('unblocking a user', () => {
  it('releases the cascade its own ban created', async () => {
    // Without this the person stays locked out by the entries their ban wrote —
    // a bug that looks exactly like "unblock does nothing".
    const { service, recorded } = buildService({ existingIpEntryId: 'ip-1' });
    const report = await service.unblock({ userId: 'user-1', adminId: 'admin-1' });

    assert.deepStrictEqual(recorded.updates, [{ isBlocked: false }]);
    assert.equal(recorded.releases.length, 1);
    assert.equal(recorded.releases[0]['userId'], 'user-1');
    assert.equal(report.entriesReleased, 4);
    assert.deepStrictEqual(recorded.ipDeletes, ['ip-1']);
    assert.equal(report.ipsReleased, 1);
  });

  it('pushes the profile back up but does not drop connections', async () => {
    // Dropping is an enforcement action. Doing it on the way out would kick a
    // customer we have just decided to let back in.
    const { service, recorded } = buildService();
    const report = await service.unblock({ userId: 'user-1', adminId: 'admin-1' });

    assert.equal(recorded.syncJobs.length, 1);
    assert.deepStrictEqual(recorded.syncJobs[0]['payload'], {
      source: 'USER_UNBLOCK',
      propagateStatus: true,
    });
    assert.equal(recorded.drops.length, 0);
    assert.equal(report.connectionsDropped, false);
  });
});
