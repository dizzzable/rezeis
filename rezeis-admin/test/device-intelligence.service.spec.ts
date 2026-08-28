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
  /** Distinct accounts reporting the same signal — see the crowd guard. */
  readonly sharedByAccounts?: number;
  /** Distinct signals this account already holds — see the per-account cap. */
  readonly signalsHeld?: number;
  /** True when the reported value is already on file for this account. */
  readonly alreadyOnFile?: boolean;
} = {}) {
  const observations: Array<Record<string, unknown>> = [];
  const refreshes: Array<Record<string, unknown>> = [];
  const flags: Array<Record<string, unknown>> = [];
  const siblingQueries: Array<Record<string, unknown>> = [];

  const prisma = {
    deviceObservation: {
      // `record` updates first and creates only on a miss, so the double has
      // to model both halves — an `upsert`-only stub would make the per-account
      // cap unreachable.
      updateMany: async (args: Record<string, unknown>) => {
        refreshes.push(args);
        return { count: options.alreadyOnFile === true ? 1 : 0 };
      },
      count: async () => options.signalsHeld ?? 0,
      create: async (args: Record<string, unknown>) => {
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
      // How many DISTINCT accounts have reported this value. One row per
      // account, which is what `groupBy: ['userId']` yields. The default is a
      // single account so every pre-existing case keeps meaning what it meant;
      // `sharedByAccounts` is what a test raises to reach the crowd guard.
      groupBy: async () =>
        Array.from({ length: options.sharedByAccounts ?? 1 }, (_, index) => ({
          userId: `sharer-${index}`,
          _count: { _all: 1 },
        })),
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
    refreshes,
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
      (call) => (call['data'] as { kind: DeviceSignalKind }).kind,
    );
    assert.deepStrictEqual(kinds, [DeviceSignalKind.INSTALL_ID, DeviceSignalKind.DEVICE_HASH]);
  });

  it('counts a repeat sighting instead of writing a second row', async () => {
    // `hits` and `lastSeenAt` are what separate a machine somebody uses daily
    // from one they touched once — a distinction an operator needs before
    // acting on a match.
    const { service, refreshes } = buildService({ alreadyOnFile: true });
    await service.report({ userId: 'user-1', installId: INSTALL });

    const update = refreshes[0]['data'] as Record<string, unknown>;
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
    await service.clear('flag-1', 'admin-1', 'user-1');

    const data = (flags[0] as { data: Record<string, unknown> }).data;
    assert.ok(data['clearedAt'] instanceof Date);
    assert.equal(data['clearedById'], 'admin-1');
  });

  it('scopes the clear to the account it was asked about', async () => {
    // The route is per-user and the audit row it writes names the user from the
    // URL. Matching on the flag id alone let an admin clear a flag belonging to
    // somebody else, and the trail then named the untouched account while the
    // real one lost its mark with no record at all.
    const { service, flags } = buildService();
    await service.clear('flag-1', 'admin-1', 'user-7');

    const where = (flags[0] as { where: Record<string, unknown> }).where;
    assert.equal(where['id'], 'flag-1');
    assert.equal(where['userId'], 'user-7');
  });
});

describe('a signal a crowd reports is not a device', () => {
  it('raises no flag once too many accounts share the same value', async () => {
    // Tor, Firefox with `resistFingerprinting` and Apple Silicon Safari all
    // spoof or generalise every component the digest is built from, so whole
    // populations produce an IDENTICAL hash. Without this guard one blocked
    // member of such a population marks every other member on their next page
    // load — thousands of innocent accounts, all pointing at the same stranger.
    const { service, flags } = buildService({
      blockedSibling: 'blocked-1',
      sharedByAccounts: 40,
    });

    await service.report({ userId: 'user-1', installId: null, deviceHash: HASH });

    assert.deepStrictEqual(flags, []);
  });

  it('still flags a value only a couple of accounts share', async () => {
    // The positive control: a machine genuinely lent around a household is
    // exactly what this feature is for, and the guard must not swallow it.
    const { service, flags } = buildService({
      blockedSibling: 'blocked-1',
      sharedByAccounts: 2,
    });

    await service.report({ userId: 'user-1', installId: null, deviceHash: HASH });

    assert.equal(flags.length, 1);
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

describe('one account cannot write rows without end', () => {
  it('stops recording new values past the per-account cap', async () => {
    // The endpoint takes the value from the request body, the unique index
    // dedupes only identical values, and the only limit in front of it is a
    // generic per-IP one shared with the rest of the API. A script with a valid
    // session could mint a fresh install id per request and write until the
    // disk complained — and Brave does the same thing without meaning to, by
    // re-randomising its canvas every session.
    const { service, observations } = buildService({ signalsHeld: 50 });

    await service.report({ userId: 'user-1', installId: INSTALL, deviceHash: HASH });

    assert.deepStrictEqual(observations, []);
  });

  it('still refreshes a signal it has already seen, however many are on file', async () => {
    // The cap is about NEW values. Evidence already given must keep its `hits`
    // and `lastSeenAt`, which are what tell a daily machine from a one-off.
    const { service, observations } = buildService({ signalsHeld: 500, alreadyOnFile: true });

    await service.report({ userId: 'user-1', installId: INSTALL, deviceHash: HASH });

    // Nothing CREATED, and no refusal either — the update did the work.
    assert.deepStrictEqual(observations, []);
  });

  it('records normally below the cap', async () => {
    const { service, observations } = buildService({ signalsHeld: 3 });

    await service.report({ userId: 'user-1', installId: INSTALL, deviceHash: HASH });

    assert.equal(observations.length, 2);
  });
});
