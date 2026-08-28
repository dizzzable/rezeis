import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeviceSignalKind } from '@prisma/client';

import { DeviceIntelligenceService } from '../src/modules/device-intelligence/services/device-intelligence.service';
import {
  deviceFlagFingerprint,
  normaliseDeviceSignal,
} from '../src/modules/device-intelligence/utils/device-signal.util';

/**
 * The cabinet can be used without a Telegram account and without ever
 * installing a VPN client, so for a person banned from it a new mailbox and a
 * new login is the entire cost of coming back. These signals are what makes
 * that visible.
 *
 * Two properties matter more than any individual assertion here, and both have
 * their own test: the flag is never a refusal, and the person carrying it can
 * never tell.
 */

const INSTALL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const HASH = 'f00dcafe1234567890abcdef';

function buildService(options: {
  /** The user id of a BLOCKED account that reported the same signal. */
  readonly blockedSibling?: string | null;
  /** True when the value itself is on the identity blocklist. */
  readonly listed?: boolean;
  readonly upsertThrows?: boolean;
} = {}) {
  const observations: Array<Record<string, unknown>> = [];
  const flags: Array<Record<string, unknown>> = [];
  const siblingQueries: Array<Record<string, unknown>> = [];

  const prisma = {
    deviceObservation: {
      upsert: async (args: Record<string, unknown>) => {
        if (options.upsertThrows === true) throw new Error('database is on fire');
        observations.push(args);
        return {};
      },
      findFirst: async (args: { where: Record<string, unknown> }) => {
        siblingQueries.push(args.where);
        return options.blockedSibling === undefined || options.blockedSibling === null
          ? null
          : { userId: options.blockedSibling };
      },
      findMany: async () => [{ value: HASH }],
    },
    userReviewFlag: {
      upsert: async (args: Record<string, unknown>) => {
        flags.push(args);
        return {};
      },
      groupBy: async () => [{ userId: 'user-1', _count: { _all: 2 } }],
      findMany: async () => [],
      updateMany: async (args: Record<string, unknown>) => {
        flags.push(args);
        return { count: 1 };
      },
    },
  };

  const blocklist = {
    find: async () => (options.listed === true ? { id: 'entry-1' } : null),
  };

  return {
    service: new DeviceIntelligenceService(prisma as never, blocklist as never),
    observations,
    flags,
    siblingQueries,
  };
}

describe('recording what the cabinet reported', () => {
  it('stores both signals', async () => {
    // Two, on purpose. The install id is exact and dies with a cleared profile;
    // the hash is approximate and survives one. Either alone inherits the worse
    // half of the other.
    const { service, observations } = buildService();
    await service.report({ userId: 'user-1', installId: INSTALL, deviceHash: HASH });

    const kinds = observations.map(
      (call) => (call['create'] as { kind: DeviceSignalKind }).kind,
    );
    assert.deepStrictEqual(kinds, [DeviceSignalKind.INSTALL_ID, DeviceSignalKind.DEVICE_HASH]);
  });

  it('counts a repeat sighting instead of writing a second row', async () => {
    // `hits` and `lastSeenAt` are what separate a machine somebody uses daily
    // from one they touched once — a distinction an operator needs before
    // acting on a match.
    const { service, observations } = buildService();
    await service.report({ userId: 'user-1', installId: INSTALL });

    const update = observations[0]['update'] as Record<string, unknown>;
    assert.deepStrictEqual(update['hits'], { increment: 1 });
    assert.ok(update['lastSeenAt'] instanceof Date);
  });

  it('drops a value that cannot be an identifier', async () => {
    // The endpoint is reachable by anybody with a session, so the column is a
    // write-anything-you-like target without this.
    const { service, observations } = buildService();
    await service.report({ userId: 'user-1', installId: 'short', deviceHash: 'has spaces!!' });
    assert.deepStrictEqual(observations, []);
  });

  it('never throws at its caller', async () => {
    // This runs beside a page load. A failed device report should lose a
    // signal, not the customer's session.
    const { service } = buildService({ upsertThrows: true });
    await service.report({ userId: 'user-1', installId: INSTALL });
  });
});

describe('raising the flag', () => {
  it('says nothing when the device matches nobody', async () => {
    // The overwhelmingly common case, and the control for everything below: a
    // detector that fires for everybody is worse than no detector.
    const { service, flags } = buildService();
    await service.report({ userId: 'user-1', installId: INSTALL, deviceHash: HASH });
    assert.deepStrictEqual(flags, []);
  });

  it('flags an account whose device also belongs to a blocked one', async () => {
    const { service, flags } = buildService({ blockedSibling: 'banned-user' });
    await service.report({ userId: 'user-1', installId: INSTALL });

    assert.equal(flags.length, 1);
    const create = (flags[0] as { create: Record<string, unknown> }).create;
    assert.equal(create['userId'], 'user-1');
    assert.equal(create['relatedUserId'], 'banned-user');
    assert.equal((create['detail'] as { source: string }).source, 'blocked_account');
  });

  it('only ever considers siblings that are actually blocked', async () => {
    // Households share laptops and offices deploy one image to hundreds of
    // them. Matching an UNBLOCKED account is not evidence of anything, and
    // flagging on it would bury the queue in families.
    const { service, siblingQueries } = buildService();
    await service.report({ userId: 'user-1', installId: INSTALL });
    assert.deepStrictEqual(siblingQueries[0]['user'], { isBlocked: true });
    assert.deepStrictEqual(siblingQueries[0]['userId'], { not: 'user-1' });
  });

  it('flags on the blocklist entry when the banned account is already deleted', async () => {
    // Observations cascade-delete with the user, and deleting a banned account
    // is frequently the next thing an operator does. Without the blocklist copy
    // the evidence would disappear exactly when the ban was enforced hardest.
    const { service, flags } = buildService({ blockedSibling: null, listed: true });
    await service.report({ userId: 'user-1', deviceHash: HASH });

    assert.equal(flags.length, 1);
    const create = (flags[0] as { create: Record<string, unknown> }).create;
    assert.equal(create['relatedUserId'], null);
    assert.equal((create['detail'] as { source: string }).source, 'blocklist_entry');
  });

  it('keys the flag on the signal so a page view does not add a row', async () => {
    // Every session load reports the same device. A queue that grows by one
    // entry per page view is a queue nobody reads.
    const { service, flags } = buildService({ blockedSibling: 'banned-user' });
    await service.report({ userId: 'user-1', installId: INSTALL });

    const where = (flags[0] as { where: Record<string, unknown> }).where;
    const key = where['userId_kind_fingerprint'] as { fingerprint: string };
    assert.equal(
      key.fingerprint,
      deviceFlagFingerprint(DeviceSignalKind.INSTALL_ID, INSTALL),
    );
  });

  it('refreshes a repeat match without reopening a judged flag', async () => {
    // The device does not stop matching because an operator decided it was a
    // household, so `clearedAt` must not be touched on the update path — else
    // the same row comes back to be dismissed on every page load.
    const { service, flags } = buildService({ blockedSibling: 'banned-user' });
    await service.report({ userId: 'user-1', installId: INSTALL });

    const update = (flags[0] as { update: Record<string, unknown> }).update;
    assert.equal('clearedAt' in update, false);
    assert.equal('clearedById' in update, false);
  });

  it('stores no raw signal value in the operator-visible detail', async () => {
    // The detail is rendered on admin screens. An opaque digest is not something
    // an operator can act on, and spreading a tracking identifier across the UI
    // buys nothing.
    const { service, flags } = buildService({ blockedSibling: 'banned-user' });
    await service.report({ userId: 'user-1', installId: INSTALL });

    const create = (flags[0] as { create: Record<string, unknown> }).create;
    assert.equal(JSON.stringify(create['detail']).includes(INSTALL), false);
  });
});

describe('the flag stays invisible to the account it marks', () => {
  it('reports the same outcome whether or not a flag was raised', async () => {
    // The whole value of a quiet mark is that the person marked cannot tell. A
    // distinguishable answer here teaches an evader which of the two signals
    // gave them away and what to change before the next attempt.
    const clean = buildService();
    const matched = buildService({ blockedSibling: 'banned-user' });

    const a = await clean.service.report({ userId: 'user-1', installId: INSTALL });
    const b = await matched.service.report({ userId: 'user-1', installId: INSTALL });

    assert.deepStrictEqual(a, b);
    assert.equal(a, undefined);
    assert.equal(matched.flags.length, 1, 'the second one really did flag');
  });
});

describe('what the operator screens read', () => {
  it('counts open flags for a whole page in one query', async () => {
    // The users list renders fifty rows. A per-row lookup would be fifty
    // round-trips on the busiest admin screen there is.
    const { service } = buildService();
    const counts = await service.openFlagCounts(['user-1', 'user-2']);
    assert.equal(counts.get('user-1'), 2);
    assert.equal(counts.get('user-2'), undefined);
  });

  it('asks nothing at all for an empty page', async () => {
    const { service } = buildService();
    assert.equal((await service.openFlagCounts([])).size, 0);
  });

  it('marks a flag judged without deleting it', async () => {
    // "Was this account ever flagged, and what did we decide" is the question
    // that gets asked later. A queue that deletes what it resolves cannot
    // answer it.
    const { service, flags } = buildService();
    await service.clear('flag-1', 'admin-1');

    const data = (flags[0] as { data: Record<string, unknown> }).data;
    assert.ok(data['clearedAt'] instanceof Date);
    assert.equal(data['clearedById'], 'admin-1');
  });
});

describe('normalising a signal', () => {
  it('lower-cases so one device has one spelling', () => {
    // The unique index decides what "the same device" means. A writer storing
    // `AB12` and a reader looking up `ab12` records everything and matches
    // nothing.
    const result = normaliseDeviceSignal(DeviceSignalKind.DEVICE_HASH, '  F00DCAFE1234  ');
    assert.deepStrictEqual(result, {
      ok: true,
      kind: DeviceSignalKind.DEVICE_HASH,
      value: 'f00dcafe1234',
    });
  });

  for (const [reason, value] of [
    ['EMPTY', '   '],
    ['TOO_SHORT', 'abc'],
    ['TOO_LONG', 'a'.repeat(129)],
    ['BAD_CHARSET', 'has spaces here'],
  ] as const) {
    it(`refuses ${reason}`, () => {
      const result = normaliseDeviceSignal(DeviceSignalKind.INSTALL_ID, value);
      assert.deepStrictEqual(result, { ok: false, reason });
    });
  }

  it('refuses a value short enough to collide across strangers', () => {
    // A four-character value would be shared by unrelated people, and one flag
    // would become a flag on everybody.
    assert.equal(normaliseDeviceSignal(DeviceSignalKind.INSTALL_ID, 'ab12').ok, false);
  });
});
