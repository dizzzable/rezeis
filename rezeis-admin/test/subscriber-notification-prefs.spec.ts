import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';
import {
  SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES,
  isSubscriberNotificationEnabled,
  readSubscriberNotificationPrefs,
} from '../src/modules/notifications/utils/notification-toggle.util';

/**
 * The storage half of the cabinet's notification switches.
 *
 * There was none. Seven `<Switch>` on the «Уведомления» screen had no
 * handler, no route and no column; whether a customer received an expiry
 * reminder was decided entirely by the operator's global map.
 *
 * Two directions have to hold, and getting either backwards is a silent
 * disaster on a live customer base:
 *
 *  - ABSENT MEANS SEND. The column is nullable, so nearly every row reads
 *    back as nothing stored. Treating that as "opted out" would mute the
 *    whole product overnight.
 *  - THE LIST IS CLOSED. A browser posts this body. Without narrowing, a
 *    customer could store `support_reply: false` and silence the answer to
 *    their own question — or fill the column with keys nobody reads.
 */

function buildService(stored: unknown) {
  const updates: Array<Record<string, unknown>> = [];
  const writeWheres: Array<Record<string, unknown>> = [];
  const selects: Array<Record<string, unknown>> = [];
  const prisma = {
    user: {
      // Honours `select`, because the read is half the gate: drop
      // `notificationPrefs: true` and the column is simply absent, every
      // subscriber reads as "never chose anything", and all five switches stop
      // working while nothing throws.
      findUnique: async (args: {
        where: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        selects.push(args.select ?? {});
        const row: Record<string, unknown> = { id: 'u-1' };
        if (args.select?.['notificationPrefs'] === true) row['notificationPrefs'] = stored;
        return row;
      },
      update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        // The write's `where` is recorded separately: addressing the wrong row
        // overwrites another customer's switches, and a double that ignores it
        // cannot tell the two apart.
        writeWheres.push(args.where);
        updates.push(args.data);
        return { id: 'u-1' };
      },
    },
  };
  const service = new InternalUserEdgeService(
    prisma as never,
    {} as never,
    {} as never,
    { info: () => undefined } as never,
    {} as never,
  );
  return { service, updates, writeWheres, selects };
}

describe('reading a subscriber switch', () => {
  it('sends when nothing is stored', () => {
    assert.equal(isSubscriberNotificationEnabled(null, 'expires_in_3_days'), true);
    assert.equal(isSubscriberNotificationEnabled(undefined, 'expires_in_3_days'), true);
    assert.equal(isSubscriberNotificationEnabled({}, 'expires_in_3_days'), true);
  });

  it('sends when the column holds something malformed', () => {
    // A hand-edited row, or a column written by a future shape. Refusing to
    // send over it would be a data problem becoming a delivery outage.
    assert.equal(isSubscriberNotificationEnabled('nonsense', 'expired'), true);
    assert.equal(isSubscriberNotificationEnabled([1, 2, 3], 'expired'), true);
  });

  it('stops only on an explicit false', () => {
    assert.equal(isSubscriberNotificationEnabled({ expired: false }, 'expired'), false);
    assert.equal(isSubscriberNotificationEnabled({ expired: true }, 'expired'), true);
  });

  it('ignores a switch for a type nobody may mute', () => {
    assert.equal(isSubscriberNotificationEnabled({ support_reply: false }, 'support_reply'), true);
    assert.equal(isSubscriberNotificationEnabled({ ADMIN_MESSAGE: false }, 'ADMIN_MESSAGE'), true);
    assert.equal(isSubscriberNotificationEnabled({ broadcast: false }, 'broadcast'), true);
  });

  it('covers exactly the expiry family', () => {
    // Named here so widening the list is a deliberate edit in two places
    // rather than a quiet one in a constant.
    assert.deepEqual([...SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES], [
      'expires_in_3_days',
      'expires_in_2_days',
      'expires_in_1_days',
      'expired',
      'expired_1_day_ago',
    ]);
  });
});

describe('narrowing what a browser sent', () => {
  it('keeps the switches it knows', () => {
    assert.deepEqual(readSubscriberNotificationPrefs({ expired: false, expires_in_1_days: true }), {
      expired: false,
      expires_in_1_days: true,
    });
  });

  it('drops a key outside the list', () => {
    assert.deepEqual(readSubscriberNotificationPrefs({ support_reply: false }), {});
  });

  it('drops a value that is not a boolean', () => {
    assert.deepEqual(readSubscriberNotificationPrefs({ expired: 'no', expires_in_1_days: 0 }), {});
  });

  it('answers with an empty map for anything unusable', () => {
    for (const input of [null, undefined, 'x', 42, []]) {
      assert.deepEqual(readSubscriberNotificationPrefs(input), {});
    }
  });
});

describe('the internal preferences route', () => {
  it('returns what is stored, plus the switches this build honours', async () => {
    const { service } = buildService({ expired: false });
    const result = await service.getNotificationPrefs('42');
    assert.deepEqual(result.prefs, { expired: false });
    assert.deepEqual([...result.available], [...SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES]);
  });

  it('returns an empty map for a subscriber who never opened the screen', async () => {
    const { service } = buildService(null);
    assert.deepEqual((await service.getNotificationPrefs('42')).prefs, {});
  });

  it('MERGES a patch instead of replacing the map', async () => {
    // THE case. The cabinet sends the one switch that moved; a replace would
    // silently reset every other switch to its default, on a screen that goes
    // on showing them all as still set.
    const { service, updates } = buildService({ expired: false, expires_in_1_days: false });
    const result = await service.updateNotificationPrefs('42', { expires_in_3_days: false });

    assert.deepEqual(result.prefs, {
      expires_in_3_days: false,
      expires_in_1_days: false,
      expired: false,
    });
    assert.deepEqual(updates[0].notificationPrefs, result.prefs);
  });

  it('lets a switch be turned back on', async () => {
    const { service } = buildService({ expired: false });
    const result = await service.updateNotificationPrefs('42', { expired: true });
    assert.equal(result.prefs.expired, true);
  });

  it('refuses to store a switch for a type nobody may mute', async () => {
    const { service, updates } = buildService(null);
    const result = await service.updateNotificationPrefs('42', {
      support_reply: false,
      expired: false,
    });
    assert.deepEqual(result.prefs, { expired: false });
    assert.deepEqual(updates[0].notificationPrefs, { expired: false });
  });

  it('survives a body that is not an object', async () => {
    const { service } = buildService({ expired: false });
    const result = await service.updateNotificationPrefs('42', 'nonsense');
    assert.deepEqual(result.prefs, { expired: false });
  });
});

describe('the queries behind the switches', () => {
  it('reads the column it is about to merge into', async () => {
    // Without `select: { notificationPrefs: true }` the merge base is
    // `undefined`, every stored answer reads as absent, and the screen quietly
    // reverts to sending everything while nothing throws.
    const { service, selects } = buildService({ expired: false });
    await service.getNotificationPrefs('42');
    assert.ok(
      selects.some((select) => select['notificationPrefs'] === true),
      'the preferences column is not being read',
    );
  });

  it('writes to the resolved user, not to the reference it was handed', async () => {
    // `42` is a telegram id; `u-1` is the row. Writing by the reference would
    // land on whichever row happened to match it.
    const { service, writeWheres } = buildService({});
    await service.updateNotificationPrefs('42', { expired: false });
    assert.equal(writeWheres.length, 1);
    assert.deepEqual(writeWheres[0], { id: 'u-1' });
  });
});
