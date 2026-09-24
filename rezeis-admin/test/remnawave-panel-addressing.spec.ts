import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import {
  isNumericPanelIdentity,
  panelDeviceOwnerKey,
  panelIdentityLookup,
  panelShortUuidFromConfigUrl,
  panelUserAddress,
  panelUserPatchKey,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { mapHwidTopUser } from '../src/modules/remnawave/services/remnawave-extended-mappers';

/**
 * The layer that decides HOW a panel profile is named on a Remnawave 3.x panel —
 * the only version this build speaks.
 *
 * This is the load-bearing piece: every user-scoped adapter method builds its
 * path from it, and the failure it must never produce is the quiet one —
 * addressing SOMEBODY rather than nobody. 3.x deleted the user uuid column and
 * keys users by a numeric id, and a row linked back on 2.x keeps its uuid in our
 * database. So an identifier that "looks fine" can belong to a different profile
 * entirely.
 *
 * ONE SET OF RULES. The version probe no longer shapes a request: a 2.x panel is
 * refused before anything is built, and an unreadable version is addressed
 * exactly as a proven 3.x one.
 */

const UUID = '330f2b38-1362-46ab-b5c0-dea32167eff9';
const SHORT_UUID = 'PyTr7C5568QuLhup';

function stored(patch: Partial<StoredPanelIdentity> = {}): StoredPanelIdentity {
  return { remnawaveId: UUID, panelId: null, panelUsername: null, ...patch };
}

describe('panelShortUuidFromConfigUrl', () => {
  it('extracts the 3.2.3 root-path subscription short uuid', () => {
    assert.equal(panelShortUuidFromConfigUrl(`https://subscription.example.test/${SHORT_UUID}`), SHORT_UUID);
    assert.equal(
      panelShortUuidFromConfigUrl(`https://subscription.example.test/${SHORT_UUID}?format=sing-box#devices`),
      SHORT_UUID,
    );
  });

  it('keeps the older explicit subscription path formats', () => {
    assert.equal(panelShortUuidFromConfigUrl(`https://subscription.example.test/api/sub/${SHORT_UUID}`), SHORT_UUID);
    assert.equal(panelShortUuidFromConfigUrl(`https://subscription.example.test/sub/${SHORT_UUID}`), SHORT_UUID);
  });

  it('does not confuse service routes with profile material', () => {
    for (const value of [
      'https://subscription.example.test/api',
      'https://subscription.example.test/subscription',
      'https://subscription.example.test/subscriptions',
      'https://subscription.example.test/favicon.ico',
      'https://subscription.example.test/assets/app.js',
    ]) {
      assert.equal(panelShortUuidFromConfigUrl(value), null, value);
    }
  });
});

describe('panelUserAddress — the one set of rules', () => {
  it('uses the stored identity when it is already the numeric id', () => {
    const address = panelUserAddress(stored({ remnawaveId: '42' }));
    assert.deepEqual(address, { kind: 'ready', segment: '42' });
  });

  it('prefers the recorded numeric id over a round-trip', () => {
    const address = panelUserAddress(stored({ panelId: 7, panelUsername: 'rz_bob_1' }));
    assert.deepEqual(address, { kind: 'ready', segment: '7' });
  });

  it('falls back to the short uuid when the panel was upgraded before we saw the id', () => {
    const address = panelUserAddress(stored({ panelShortUuid: SHORT_UUID, panelUsername: 'rz_bob_1' }));
    assert.deepEqual(address, { kind: 'needsResolve', selector: { shortUuid: SHORT_UUID } });
  });

  it('uses the name when no saved subscription short uuid exists', () => {
    const address = panelUserAddress(stored({ panelUsername: 'rz_bob_1' }));
    assert.deepEqual(address, { kind: 'needsResolve', selector: { username: 'rz_bob_1' } });
  });

  it('refuses when neither the id nor the name was ever recorded', () => {
    const address = panelUserAddress(stored());
    assert.equal(address.kind, 'impossible');
    // The reason has to name the actual obstacle — an operator reads this.
    assert.match((address as { reason: string }).reason, /not a 3\.x numeric id/);
  });

  it('NEVER emits the uuid, which a 3.x panel rejects as NaN', () => {
    // The whole point. A 3.x panel answers `400 expected number, received NaN`
    // for a uuid in an id slot — safe, but the integration is dead. Emitting the
    // uuid anyway would be the bug this type exists to prevent.
    //
    // THE REGRESSION THIS WATCHES FOR, by name: the tempting "just return what
    // we stored" edit. Every case below then emits a 2.x uuid into an id slot.
    // The third case is what makes the guard live: a recorded numeric id DOES
    // reach `ready`, so the uuid comparison actually runs, and `reachedReady`
    // fails loudly if a later edit makes it dead again.
    const CASES: ReadonlyArray<readonly [string, StoredPanelIdentity, string | null]> = [
      ['the uuid alone', stored(), null],
      ['the uuid and a name', stored({ panelUsername: 'rz_bob_1' }), null],
      ['the uuid and a recorded numeric id', stored({ panelId: 7 }), '7'],
    ];

    let reachedReady = 0;
    for (const [label, identity, expected] of CASES) {
      const address = panelUserAddress(identity);
      if (expected === null) {
        assert.notEqual(address.kind, 'ready', `${label}: emitted a segment where none was safe`);
        continue;
      }
      if (address.kind !== 'ready') {
        assert.fail(`${label}: expected the recorded id to be usable, got ${address.kind}`);
      }
      reachedReady += 1;
      assert.notEqual(address.segment, UUID, `${label}: emitted the stored 2.x uuid`);
      assert.equal(address.segment, expected, label);
    }
    assert.equal(reachedReady, 1, 'the uuid comparison never executed — this guard is dead again');
  });
});

describe('panelUserPatchKey — the key half of a PATCH', () => {
  it('keys by the numeric id — the stored one or the recorded one', () => {
    assert.deepEqual(panelUserPatchKey(stored({ remnawaveId: '42' })), { id: 42 });
    assert.deepEqual(panelUserPatchKey(stored({ panelId: 7 })), { id: 7 });
  });

  it('falls back to the username when the chain resolves by name', () => {
    assert.deepEqual(panelUserPatchKey(stored({ panelUsername: 'rz_bob_1' })), {
      username: 'rz_bob_1',
    });
  });

  it('has no uuid key, and never parses a uuid into an id', () => {
    // `{ uuid }` was the 2.x key; a 3.x panel drops it and answers `400 At
    // least one of username, id must be provided`. And `parseInt` of this uuid is
    // 330 — somebody else's id.
    for (const identity of [stored(), stored({ panelShortUuid: SHORT_UUID })]) {
      const key = panelUserPatchKey(identity);
      assert.equal(key, null, JSON.stringify(identity));
    }
  });

  it('prefers the immutable identifier over the name', () => {
    // An operator who renames a profile by hand in the panel would otherwise
    // silently retarget every later write.
    assert.deepEqual(panelUserPatchKey(stored({ panelId: 7, panelUsername: 'renamed' })), { id: 7 });
  });
});

describe('panelDeviceOwnerKey — the HWID body key', () => {
  it('is userId, the number, chosen by the form of the segment', () => {
    assert.deepEqual(panelDeviceOwnerKey('42'), { userId: 42 });
    assert.equal(panelDeviceOwnerKey(UUID), null, 'a uuid is refused, never read as user 330');
  });
});

describe('isNumericPanelIdentity', () => {
  it('accepts a decimal id and rejects everything a uuid can look like', () => {
    assert.equal(isNumericPanelIdentity('42'), true);
    assert.equal(isNumericPanelIdentity('0'), true);
    assert.equal(isNumericPanelIdentity(UUID), false);
    assert.equal(isNumericPanelIdentity('4e2'), false);
    assert.equal(isNumericPanelIdentity('+42'), false);
    assert.equal(isNumericPanelIdentity(' 42'), false);
    assert.equal(isNumericPanelIdentity(''), false);
  });
});

/**
 * The BATCH lookup: the same "a 2.x row is named by a 3.x id" problem
 * `panelIdentityWhere` solves one event at a time, asked of a whole batch.
 *
 * Its two bounds are what these cases pin. The first: a numeric angle may only
 * be taken from an identity that is entirely digits, because
 * `Number.parseInt('330f2b38-…')` is `330` — a valid-looking id belonging to
 * somebody else. The second is specific to the plural form and is the dangerous
 * one: `remnawave_panel_id` has no unique constraint and is null on most rows, so
 * an EMPTY numeric list that degenerates into `remnawavePanelId: null` (or an
 * `in` carrying a null) matches every row that has no panel id — inside an
 * anti-fraud detector, every customer at once.
 */
describe('panelIdentityLookup — matching a batch on both angles', () => {
  it('asks only the stored column when nothing in the batch is numeric', () => {
    const lookup = panelIdentityLookup([UUID, 'not-a-panel-identity']);

    assert.notEqual(lookup, null);
    // The numeric arm is ABSENT, not empty and not null. `remnawavePanelId`
    // must not appear anywhere in this object.
    assert.deepEqual(lookup!.where, { remnawaveId: { in: [UUID, 'not-a-panel-identity'] } });
    assert.equal(JSON.stringify(lookup!.where).includes('remnawavePanelId'), false);
  });

  it('adds the numeric angle for the identities that have one', () => {
    const lookup = panelIdentityLookup([UUID, '4471']);

    assert.deepEqual(lookup!.where, {
      OR: [{ remnawaveId: { in: [UUID, '4471'] } }, { remnawavePanelId: { in: [4471] } }],
    });
  });

  it('never mints a numeric angle out of a uuid or an unsafe integer', () => {
    // `parseInt` reads leading digits and stops; the digits-only test is what
    // stands between `330f2b38-…` and panel user #330.
    const fromUuid = panelIdentityLookup(['330f2b38-1362-46ab-b5c0-dea32167eff9']);
    assert.deepEqual(fromUuid!.where, {
      remnawaveId: { in: ['330f2b38-1362-46ab-b5c0-dea32167eff9'] },
    });

    const huge = '9007199254740993000';
    const fromHuge = panelIdentityLookup([huge]);
    assert.deepEqual(fromHuge!.where, { remnawaveId: { in: [huge] } });
  });

  it('is null when there is nothing to ask about', () => {
    // A `where` built from an empty batch is the other road to "match
    // everything"; the caller returns early instead.
    assert.equal(panelIdentityLookup([]), null);
    assert.equal(panelIdentityLookup(['']), null);
  });

  it('keys a fetched row by the identity the CALLER asked about', () => {
    const lookup = panelIdentityLookup(['4471'])!;

    // The 3.x panel said "4471"; the row that answers is stamped with the uuid
    // it was created under in the 2.x era. Keying by the row would re-lose the
    // match the widened `where` just recovered.
    assert.deepEqual(lookup.keysFor({ remnawaveId: UUID, remnawavePanelId: 4471 }), ['4471']);
    // Named by both angles at once — one key, not two entries.
    assert.deepEqual(lookup.keysFor({ remnawaveId: '4471', remnawavePanelId: 4471 }), ['4471']);
    // A row that arrived for a reason nobody asked about answers for nobody.
    assert.deepEqual(lookup.keysFor({ remnawaveId: UUID, remnawavePanelId: 9 }), []);
    assert.deepEqual(lookup.keysFor({ remnawaveId: UUID, remnawavePanelId: null }), []);
    // A caller whose `select` omitted the column hands over `undefined`, which
    // must answer for nobody rather than for whoever a loose lookup finds.
    assert.deepEqual(lookup.keysFor({ remnawaveId: null }), []);
  });

  it('answers for every spelling that shares one numeric angle', () => {
    // `'42'` and `'042'` parse to the same id. Attributing the row to one of
    // them would drop the other's downgrade grace silently.
    const lookup = panelIdentityLookup(['42', '042'])!;

    assert.deepEqual(lookup.keysFor({ remnawaveId: UUID, remnawavePanelId: 42 }), ['42', '042']);
  });
});

// ── The adapter half: version detection and the resolve round-trip ──────────

const CONFIG = {
  host: 'remnawave',
  port: 3000,
  token: 'secret',
  webhookSecret: null,
} as const;

function build(handler: (input: { method: string; url: string; data?: unknown }) => unknown) {
  const captured: Array<{ method: string; url: string; data?: unknown }> = [];
  const service = new RemnawaveApiService(
    {
      request: (input: { method: string; url: string; data?: unknown }) => {
        captured.push({ method: input.method, url: input.url, data: input.data });
        return handler(input);
      },
    } as never,
    CONFIG as never,
  );
  return { service, captured };
}

const recap = (version: string) => of({ data: { response: { version } } });

describe('RemnawaveApiService.getPanelShape — detection, not addressing', () => {
  it('reads 3.2.1 with the keyset user stream', async () => {
    const { service } = build(() => recap('3.2.1'));
    assert.deepEqual(await service.getPanelShape(), { version: '3.2.1', usersStream: true });
  });

  it('carries no addressing, live-connection family or lookup shortcuts any more', async () => {
    // Every request is built in the 3.x shape whatever the version reads, so a
    // shape that still carried these would be a second place a version decision
    // could live. A 2.x version is still READ — it is what lets the SPA say
    // "too old" — and is not refused here.
    const { service } = build(() => recap('2.8.0'));
    const shape = await service.getPanelShape();
    assert.deepEqual(Object.keys(shape).sort(), ['usersStream', 'version']);
    assert.equal(shape.version, '2.8.0');
    assert.equal(shape.usersStream, false, 'keyset walking is a 3.x route');
  });

  it('falls back to /api/system/metadata when recap carries no version', async () => {
    const { service, captured } = build(({ url }) =>
      url.includes('recap') ? of({ data: { response: {} } }) : of({ data: { response: { version: '3.2.1' } } }),
    );
    assert.equal((await service.getPanelShape()).version, '3.2.1');
    assert.deepEqual(
      captured.map((c) => c.url),
      ['/api/system/stats/recap', '/api/system/metadata'],
    );
  });

  it('an unreachable panel is an unknown version and the offset walk, never a default', async () => {
    const { service } = build(() => throwError(() => new Error('ECONNREFUSED')));
    assert.deepEqual(await service.getPanelShape(), { version: null, usersStream: false });
  });

  it('caches a successful read instead of asking on every call', async () => {
    const { service, captured } = build(() => recap('3.2.1'));
    await service.getPanelShape();
    await service.getPanelShape();
    await service.getPanelShape();
    assert.equal(captured.length, 1);
  });

  it('force re-reads, so a fixed token does not wait out the window', async () => {
    const { service, captured } = build(() => recap('3.2.1'));
    await service.getPanelShape();
    await service.getPanelShape(true);
    assert.equal(captured.length, 2);
  });

  it('does not cache a failure for the full success window', async () => {
    // Both readers fail, so the negative window applies. Asserting the window
    // itself rather than sleeping: a 15s wait in a unit test is not a test.
    const { service } = build(() => throwError(() => new Error('down')));
    await service.getPanelShape();
    const { CAPABILITIES_CACHE_TTL_MS, CAPABILITIES_NEGATIVE_CACHE_TTL_MS } = await import(
      '../src/modules/remnawave/services/panel-version.util'
    );
    assert.ok(CAPABILITIES_NEGATIVE_CACHE_TTL_MS < CAPABILITIES_CACHE_TTL_MS);
  });
});

/** A user row as 2.x sent it: a `uuid` beside the numeric `id`. */
function rowWithUuid(over: Record<string, unknown> = {}) {
  return {
    uuid: UUID,
    id: 7,
    username: 'rz_bob_1',
    status: 'ACTIVE',
    subscriptionUrl: 'https://example.test/abc',
    telegramId: null,
    email: null,
    expireAt: '2030-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastTrafficResetAt: null,
    trafficLimitBytes: 0,
    hwidDeviceLimit: 3,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
    ...over,
  };
}

/** A 3.x user row: no `uuid` FIELD AT ALL, keyed by the numeric `id`. */
function row3x(over: Record<string, unknown> = {}) {
  const { uuid: _dropped, ...rest } = rowWithUuid();
  return { ...rest, id: 42, shortUuid: 'PyTr7C5568QuLhup', ...over };
}

describe('decoding a user row: the numeric id is the identity', () => {
  it('a 3.x row is keyed by its numeric id, and the read is ok', async () => {
    const { service } = build(() => of({ data: { response: { users: [row3x()], total: 1 } } }));
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users[0].uuid, '42');
    assert.equal(outcome.value.users[0].panelId, 42);
  });

  it('a row that still carries a uuid is keyed by its numeric id, never by the uuid', async () => {
    const { service } = build(() => of({ data: { response: { users: [rowWithUuid()], total: 1 } } }));
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users[0].uuid, '7');
  });

  it('a row without a numeric id is undecodable, whatever uuid it carries', async () => {
    // Keyed by anything else, a row would mint a key that matches no stored
    // `remnawaveId` — turning "could not read" into "user unknown", and the
    // callers that act on absence would act.
    for (const row of [rowWithUuid({ id: null }), row3x({ id: null })]) {
      const { service } = build(() => of({ data: { response: { users: [row], total: 1 } } }));
      assert.equal((await service.strictGetAllPanelUsers()).kind, 'invalidContract');
    }
  });

  it('the CREATE idempotency lookup finds a 3.x profile', async () => {
    // `getPanelUserByUsername` used to require a string `uuid` and so answered
    // "no such profile" for every 3.x profile that exists.
    const { service } = build(() => of({ data: { response: row3x() } }));
    const found = await service.getPanelUserByUsername('rz_bob_1');
    assert.notEqual(found, null);
    assert.equal(found?.uuid, '42');
    assert.equal(found?.panelId, 42);
  });
});

describe('live connections: /api/connections/*, whatever the version reads', () => {
  /** Answers the version probe, then plays the two-phase job. */
  function panel(version: string | null, result: unknown) {
    return build(({ url }) => {
      if (url.startsWith('/api/system/')) {
        return version === null ? throwError(() => new Error('down')) : recap(version);
      }
      if (url.includes('by-user') || url.includes('by-node')) {
        // A POST starts the job, a GET collects it. Both hit the same path, so
        // the METHOD is what tells them apart.
        return of({ data: { response: { jobId: '9', isCompleted: true, isFailed: false, result } } });
      }
      return of({ data: { response: {} } });
    });
  }

  for (const version of ['3.2.1', null] as const) {
    it(`is asked through connections on ${version ?? 'an unreadable version'}`, async () => {
      // An unreadable version used to mean the 2.x family here — a guaranteed
      // 404 on every 3.x, which the sharing detector read as "nobody online".
      const { service, captured } = panel(version, { success: true, users: [{ userId: 7, ips: [] }] });
      await service.fetchUsersIpsForNode('node-uuid');
      const paths = captured.map((c) => c.url).filter((u) => !u.startsWith('/api/system/'));
      assert.ok(paths.length > 0, 'the panel was never asked');
      assert.ok(paths.every((p) => p.startsWith('/api/connections/')), paths.join(', '));
    });
  }

  it('reads a row whose userId is a NUMBER — and not a string one, which only 2.x sent', async () => {
    const { service } = panel('3.2.1', {
      success: true,
      users: [
        { userId: 42, ips: [{ ip: '203.0.113.9', lastSeen: '2026-08-10T13:13:02.000Z' }] },
        { userId: '43', ips: [] },
      ],
    });
    const rows = await service.fetchUsersIpsForNode('node-uuid');
    // `null` is the separate "could not read this node" answer, not an empty
    // snapshot — see the test below.
    assert.ok(rows !== null, 'the node was not read at all');
    assert.deepEqual(
      rows.map((row) => row.userId),
      ['42'],
    );
    assert.equal(rows[0].ips.length, 1);
  });

  it('a completed-but-failed job is a failure, not an empty snapshot', async () => {
    // `null` = could not look, `[]` = looked and found nobody.
    const { service } = panel('3.2.1', { success: false, users: [] });
    assert.equal(await service.fetchUsersIpsForNode('node-uuid'), null);

    const ok = panel('3.2.1', { success: true, users: [] });
    assert.deepEqual(await ok.service.fetchUsersIpsForNode('node-uuid'), []);
  });

  it('dropping by user sends numeric ids, on every version reading', async () => {
    for (const version of ['3.2.1', null] as const) {
      const harness = panel(version, {});
      await harness.service.dropConnections({
        dropBy: { by: 'userUuids', userUuids: ['42', '77'] },
        targetNodes: { target: 'allNodes' },
      });
      const dropped = harness.captured.filter((c) => !c.url.startsWith('/api/system/'));
      assert.deepEqual(
        dropped.map((c) => [c.url, c.data]),
        [
          [
            '/api/connections/drop',
            { dropBy: { by: 'userIds', userIds: [42, 77] }, targetNodes: { target: 'allNodes' } },
          ],
        ],
        String(version),
      );
    }
  });

  it('refuses a drop whose identities are all 2.x uuids', async () => {
    // Sending them would have the panel reject the whole request over the first
    // bad element, taking the enforcement action for every OTHER user with it —
    // and `parseInt` of this uuid is somebody else's id.
    const { service, captured } = panel('3.2.1', {});
    const outcome = await service.dropConnections({
      dropBy: { by: 'userUuids', userUuids: [UUID] },
      targetNodes: { target: 'allNodes' },
    });
    assert.deepEqual(outcome, { ok: false });
    assert.equal(captured.filter((c) => c.url.includes('/drop')).length, 0);
  });
});

describe('getHwidTopUsers — the size the panel would otherwise pick for us', () => {
  /** Serves `/api/hwid/devices/top-users` out of one flat list, honouring the query. */
  function topUsersPanel(total: number) {
    const rows = Array.from({ length: total }, (_, i) => ({
      id: i + 1,
      username: `rz_user_${i + 1}`,
      devicesCount: total - i,
    }));
    return build((input) => {
      if (input.url.startsWith('/api/system/')) return recap('3.2.1');
      const query = new URLSearchParams(input.url.split('?')[1] ?? '');
      const start = Number(query.get('start') ?? '0');
      const size = Number(query.get('size') ?? '5');
      return of({ data: { response: { users: rows.slice(start, start + size), total } } });
    });
  }

  const pages = (captured: ReadonlyArray<{ url: string }>) =>
    captured.filter((c) => c.url.startsWith('/api/hwid/devices/top-users'));

  it('sends an explicit size instead of inheriting the contract default of five', async () => {
    const { service, captured } = topUsersPanel(3);
    await service.getHwidTopUsers();
    assert.equal(pages(captured).length, 1);
    assert.match(pages(captured)[0].url, /[?&]size=100(&|$)/);
    assert.match(pages(captured)[0].url, /[?&]start=0(&|$)/);
  });

  it('walks past the first page and stops on the reported total', async () => {
    const { service, captured } = topUsersPanel(250);
    const rows = await service.getHwidTopUsers();
    assert.equal(rows.length, 250, 'a 250-user panel must not be judged on 100 of them');
    assert.deepEqual(
      pages(captured).map((c) => c.url),
      [
        '/api/hwid/devices/top-users?start=0&size=100',
        '/api/hwid/devices/top-users?start=100&size=100',
        '/api/hwid/devices/top-users?start=200&size=100',
      ],
    );
  });

  it('honours a caller that only wants a card of rows', async () => {
    const { service, captured } = topUsersPanel(250);
    const rows = await service.getHwidTopUsers(5);
    assert.equal(rows.length, 5);
    assert.deepEqual(
      pages(captured).map((c) => c.url),
      ['/api/hwid/devices/top-users?start=0&size=5'],
    );
  });

  it('stops on a short page even when the panel ignores size and reports nonsense', async () => {
    const { service, captured } = build((input) =>
      input.url.startsWith('/api/system/')
        ? recap('3.2.1')
        : of({ data: { response: { users: [{ id: 1, username: 'a', devicesCount: 9 }], total: 999 } } }),
    );
    const rows = await service.getHwidTopUsers();
    assert.equal(rows.length, 1);
    assert.equal(pages(captured).length, 1);
  });

  it('still reports a read failure as blind rather than as a clean panel', async () => {
    const { service } = build((input) =>
      input.url.startsWith('/api/system/') ? recap('3.2.1') : throwError(() => new Error('down')),
    );
    assert.deepEqual(await service.getHwidTopUsers(), []);
  });
});

describe('a refusal is a refusal: no version re-read decides its class', () => {
  const rejection = (status: number) =>
    throwError(() => ({
      isAxiosError: true,
      response: { status, headers: {}, data: { message: 'expected number, received NaN' } },
      message: `HTTP ${status}`,
    }));

  it('a 400 on the PATCH is terminal, and costs no extra version read', async () => {
    // The adapter used to re-read the version on every refusal to ask "did the
    // panel change era under this request?" and make such a refusal retryable.
    // No request is built from the era any more, so there is nothing for an
    // upgrade to have changed — a refusal is the panel's answer.
    const { service, captured } = build((input) =>
      input.url.startsWith('/api/system/') ? recap('3.3.2') : rejection(400),
    );
    await service.getPanelShape();
    const versionReads = () => captured.filter((c) => c.url.startsWith('/api/system/')).length;
    const before = versionReads();
    await assert.rejects(
      () => service.updatePanelUser(stored({ panelId: 7 }), { description: 'x' }),
      (err: Error) => {
        assert.equal(err.name, 'RemnawaveUpstreamRejectionError', err.name);
        return true;
      },
    );
    assert.equal(versionReads(), before);
  });
});

describe('RemnawaveApiService.resolvePanelSegment', () => {
  it('needs no round-trip when the stored identity already is the numeric id', async () => {
    const { service, captured } = build(() => recap('3.3.2'));
    const resolved = await service.resolvePanelSegment(stored({ remnawaveId: '4471' }));
    assert.deepEqual(resolved, { segment: '4471', panelId: 4471 });
    assert.equal(captured.filter((c) => c.url.includes('resolve')).length, 0);
  });

  it('resolves by username when a 2.x-linked row recorded nothing else', async () => {
    const { service, captured } = build(({ url }) =>
      url.includes('recap')
        ? recap('3.2.1')
        : of({ data: { response: { id: 77, shortUuid: 'abc', username: 'rz_bob_1' } } }),
    );
    const resolved = await service.resolvePanelSegment(stored({ panelUsername: 'rz_bob_1' }));
    assert.deepEqual(resolved, { segment: '77', panelId: 77 });
    const call = captured.find((c) => c.url.includes('resolve'));
    assert.ok(call !== undefined);
    assert.deepEqual(call.data, { username: 'rz_bob_1' });
  });

  it('resolves by saved subscription short uuid before falling back to username', async () => {
    const { service, captured } = build(({ url }) =>
      url.includes('recap')
        ? recap('3.2.3')
        : of({ data: { response: { id: 77, shortUuid: SHORT_UUID, username: 'rz_bob_1' } } }),
    );
    const resolved = await service.resolvePanelSegment(
      stored({ panelShortUuid: SHORT_UUID, panelUsername: 'rz_bob_1' }),
    );
    assert.deepEqual(resolved, { segment: '77', panelId: 77 });
    const call = captured.find((c) => c.url.includes('resolve'));
    assert.ok(call !== undefined);
    assert.deepEqual(call.data, { shortUuid: SHORT_UUID });
  });

  it('returns null — not a guess — when the profile cannot be named', async () => {
    const { service } = build(() => recap('3.2.1'));
    assert.equal(await service.resolvePanelSegment(stored()), null);
  });

  it('returns null when the panel does not know that username either', async () => {
    const { service } = build(({ url }) =>
      url.includes('recap')
        ? recap('3.2.1')
        : throwError(() => ({
            isAxiosError: true,
            response: { status: 404, headers: {}, data: { errorCode: 'A025' } },
            message: 'HTTP 404',
          })),
    );
    assert.equal(await service.resolvePanelSegment(stored({ panelUsername: 'gone' })), null);
  });

  it('an unreadable version is addressed exactly as a 3.x one', async () => {
    // It used to send the stored uuid unchanged — a certain 400 on a 3.x panel.
    // Now the version is not consulted at all: the recorded numeric id names the
    // profile. (Destructive verbs never get here with a uuid; they refuse it
    // first — see `stale-panel-identity.spec.ts`.)
    const { service, captured } = build(() => throwError(() => new Error('down')));
    assert.deepEqual(await service.resolvePanelSegment(stored({ panelId: 7 })), {
      segment: '7',
      panelId: 7,
    });
    assert.deepEqual(captured, [], 'no version read and no resolve: the id was recorded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  The identifier in the BODY, and the reads that build it
// ═══════════════════════════════════════════════════════════════════════════

/** Answers the version probe with `version`, everything else with `payload`. */
function panelOn(version: string, payload: unknown) {
  return build((input) =>
    input.url.startsWith('/api/system/')
      ? of({ data: { response: { version } } })
      : of({ data: payload }),
  );
}

/** A row carrying a `uuid` beside its numeric id — how 2.x sent it. */
const USER_WITH_UUID = {
  response: {
    uuid: UUID,
    id: 4471,
    username: 'rz_bob_1',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    expireAt: '2099-01-01T00:00:00.000Z',
    trafficLimitBytes: 0,
    hwidDeviceLimit: 0,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
  },
};

/** A 3.x row: the `uuid` KEY is absent entirely, not merely empty. */
const USER_3X = {
  response: {
    id: 4471,
    username: 'rz_bob_1',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    expireAt: '2099-01-01T00:00:00.000Z',
    trafficLimitBytes: 0,
    hwidDeviceLimit: 0,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
  },
};

function bodyOf(captured: ReadonlyArray<{ url: string; data?: unknown }>): Record<string, unknown> {
  const call = captured.find((c) => !c.url.startsWith('/api/system/'));
  assert.ok(call !== undefined, 'expected a panel request');
  return call.data as Record<string, unknown>;
}

function patchBodyOf(captured: ReadonlyArray<{ method: string; url: string; data?: unknown }>): Record<string, unknown> {
  const call = captured.find((c) => c.method === 'patch' && c.url === '/api/users');
  assert.ok(call !== undefined, 'expected a panel PATCH /api/users request');
  return call.data as Record<string, unknown>;
}

function pathOf(captured: ReadonlyArray<{ url: string }>): string {
  const call = captured.find((c) => !c.url.startsWith('/api/system/'));
  assert.ok(call !== undefined, 'expected a panel request');
  return call.url;
}

describe('updatePanelUser — the identifier travels in the body as the number', () => {
  it('gets { id } as a NUMBER — a decimal string fails validation upstream', async () => {
    const { service, captured } = panelOn('3.2.1', USER_3X);
    await service.updatePanelUser(stored({ remnawaveId: '4471' }), { description: 'x' });
    assert.deepEqual(bodyOf(captured)['id'], 4471);
    assert.equal('uuid' in bodyOf(captured), false);
  });

  it('a 2.x-created profile is keyed by its RECORDED id', async () => {
    const { service, captured } = panelOn('3.2.1', USER_3X);
    await service.updatePanelUser(stored({ panelId: 4471 }), { description: 'x' });
    assert.equal(bodyOf(captured)['id'], 4471);
    assert.equal('uuid' in bodyOf(captured), false);
  });

  it('resolves a saved subscription short uuid to the numeric id before PATCH on 3.2.3', async () => {
    const { service, captured } = build((input) => {
      if (input.url.startsWith('/api/system/')) return recap('3.2.3');
      if (input.url === '/api/users/resolve') {
        return of({ data: { response: { id: 4471, shortUuid: SHORT_UUID, username: 'rz_bob_1' } } });
      }
      if (input.method === 'patch' && input.url === '/api/users') return of({ data: USER_3X });
      throw new Error(`unexpected panel call ${input.method} ${input.url}`);
    });

    await service.updatePanelUser(stored({ panelShortUuid: SHORT_UUID, panelUsername: 'rz_bob_1' }), {
      description: 'x',
    });

    assert.deepEqual(
      captured.filter((c) => c.url === '/api/users/resolve').map((c) => c.data),
      [{ shortUuid: SHORT_UUID }],
    );
    assert.equal(patchBodyOf(captured)['id'], 4471);
    assert.equal('shortUuid' in patchBodyOf(captured), false);
    assert.equal('uuid' in patchBodyOf(captured), false);
  });

  it('a row that recorded only a name is keyed by the name — never by its uuid', async () => {
    // The name is the address chain's last step, taken only when nothing else
    // was recorded; the uuid is never a key (3.x drops `{ uuid }` and answers
    // `400 At least one of username, id must be provided`).
    const { service, captured } = panelOn('3.2.1', USER_3X);
    await service.updatePanelUser(stored({ panelUsername: 'rz_bob_1' }), { description: 'x' });
    assert.equal(bodyOf(captured)['username'], 'rz_bob_1');
    assert.equal('uuid' in bodyOf(captured), false);
  });

  it('refuses rather than guessing when nothing can name the profile', async () => {
    // A 2.x uuid, and neither a numeric id, a short uuid nor a name recorded.
    const { service, captured } = panelOn('3.2.1', USER_3X);
    await assert.rejects(() => service.updatePanelUser(stored(), { description: 'x' }));
    assert.equal(captured.some((c) => c.method === 'patch'), false);
  });
});

describe('strictSetUserLimits — same key, and an unaddressable profile DEFERS', () => {
  it('gets { id }', async () => {
    const { service, captured } = panelOn('3.2.1', USER_3X);
    const outcome = await service.strictSetUserLimits(stored({ remnawaveId: '4471' }), {
      trafficLimitBytes: null,
      hwidDeviceLimit: null,
    });
    assert.equal(outcome.kind, 'ok');
    assert.equal(bodyOf(captured)['id'], 4471);
  });

  it('resolves a saved subscription short uuid to the numeric id before PATCH on 3.2.3', async () => {
    const { service, captured } = build((input) => {
      if (input.url.startsWith('/api/system/')) return recap('3.2.3');
      if (input.url === '/api/users/resolve') {
        return of({ data: { response: { id: 4471, shortUuid: SHORT_UUID, username: 'rz_bob_1' } } });
      }
      if (input.method === 'patch' && input.url === '/api/users') return of({ data: USER_3X });
      throw new Error(`unexpected panel call ${input.method} ${input.url}`);
    });

    const outcome = await service.strictSetUserLimits(
      stored({ panelShortUuid: SHORT_UUID, panelUsername: 'rz_bob_1' }),
      {
        trafficLimitBytes: null,
        hwidDeviceLimit: null,
      },
    );

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(
      captured.filter((c) => c.url === '/api/users/resolve').map((c) => c.data),
      [{ shortUuid: SHORT_UUID }],
    );
    assert.equal(patchBodyOf(captured)['id'], 4471);
    assert.equal('shortUuid' in patchBodyOf(captured), false);
    assert.equal('uuid' in patchBodyOf(captured), false);
  });

  it('reports unavailable, NOT invalidContract, when the profile cannot be named', async () => {
    // The distinction decides whether the saga retries or gives up. The
    // contract is fine here; only our ability to name the profile is missing.
    const { service } = panelOn('3.2.1', USER_3X);
    const outcome = await service.strictSetUserLimits(stored(), {
      trafficLimitBytes: null,
      hwidDeviceLimit: null,
    });
    assert.equal(outcome.kind, 'unavailable');
  });
});

describe('strictGetPanelUserDevices — legacy profile recovery on Remnawave 3.2.3', () => {
  it('resolves a 2.x uuid-backed subscription through its saved shortUuid before reading HWID rows', async () => {
    const { service, captured } = build((input) => {
      if (input.url.startsWith('/api/system/')) return recap('3.2.3');
      if (input.url === '/api/users/resolve') {
        return of({ data: { response: { id: 4471, shortUuid: SHORT_UUID, username: 'rz_bob_1' } } });
      }
      if (input.url === '/api/hwid/devices/4471') {
        return of({ data: { response: { total: 0, devices: [] } } });
      }
      throw new Error(`unexpected panel call ${input.url}`);
    });

    const outcome = await service.strictGetPanelUserDevices(stored({ panelShortUuid: SHORT_UUID }));

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(
      captured.filter((c) => c.url === '/api/users/resolve').map((c) => c.data),
      [{ shortUuid: SHORT_UUID }],
    );
    assert.equal(captured.some((c) => c.url === `/api/hwid/devices/${UUID}`), false);
    assert.equal(captured.some((c) => c.url === '/api/hwid/devices/4471'), true);
  });
});

describe('parseStrictUser — the numeric id is the identity', () => {
  it('decodes a 3.x row by its numeric id', async () => {
    const { service } = panelOn('3.2.1', USER_3X);
    const outcome = await service.strictGetPanelUser(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.uuid, '4471');
    assert.equal(outcome.value.panelId, 4471);
  });

  it('keys a row that still carries a uuid by its numeric id', async () => {
    const { service } = panelOn('3.2.1', USER_WITH_UUID);
    const outcome = await service.strictGetPanelUser(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.uuid, '4471');
  });

  it('REFUSES a row without a numeric id, whatever uuid it carries', async () => {
    const damaged = { response: { ...USER_WITH_UUID.response, id: null } };
    const { service } = panelOn('3.2.1', damaged);
    const outcome = await service.strictGetPanelUser(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'invalidContract');
  });
});

describe('the two path-building reads that were still interpolating the raw string', () => {
  it('getPanelUserUsage addresses by id', async () => {
    const { service, captured } = panelOn('3.2.1', USER_3X);
    await service.getPanelUserUsage(stored({ panelId: 4471 }));
    assert.equal(pathOf(captured), '/api/users/4471');
  });

  it('getPanelUserUsage answers null — never a zeroed card — when unaddressable', async () => {
    const { service } = panelOn('3.2.1', USER_3X);
    assert.equal(await service.getPanelUserUsage(stored()), null);
  });

  it('the per-user request log follows the same addressing', async () => {
    const { service, captured } = panelOn('3.2.1', { response: { records: [], total: 0 } });
    await service.getSubscriptionRequestHistory({ user: stored({ panelId: 4471 }) });
    assert.equal(pathOf(captured), '/api/users/4471/subscription-request-history');
  });
});

describe('mapHwidTopUser — the HWID overage detector must see 3.x rows', () => {
  it('reads a 3.x row by its numeric id', () => {
    // Before this, a 3.x row mapped to '', missed the limit map keyed by what
    // rezeis stored, took the `?? 0` limit and was filtered out. The detector
    // reported "nobody is over their device limit" for every 3.x panel and
    // logged nothing.
    assert.equal(mapHwidTopUser({ id: 4471, username: 'a', devicesCount: 9 }).userUuid, '4471');
  });

  it('does not invent an identity from a non-integer id', () => {
    assert.equal(mapHwidTopUser({ id: 1.5, username: 'a', devicesCount: 9 }).userUuid, '');
  });
});

describe('resolveRemnawaveUser — e-mail and Telegram id go through the stream', () => {
  // The row carries the selector it was found by, which is what a panel that
  // actually APPLIED the filter returns. A row that does not is how a panel
  // which ignored the filter looks, and the adapter refuses those.
  const SUMMARY = {
    response: {
      users: [
        { id: 7, username: 'rz_bob_1', status: 'ACTIVE', email: 'bob@example.test', telegramId: 12345 },
      ],
    },
  };

  it('filters the stream by e-mail — the old shortcut answers 404 Cannot GET on 3.x', async () => {
    // Measured on a live 3.2.1, not inferred: `by-email` and `by-telegram-id`
    // are gone, and `stream` gained `email` / `telegramId` filters.
    const { service, captured } = panelOn('3.2.1', SUMMARY);
    const found = await service.resolveRemnawaveUser({ email: 'bob@example.test' });
    assert.equal(pathOf(captured), '/api/users/stream?size=1&email=bob%40example.test');
    assert.equal(found?.username, 'rz_bob_1');
  });

  it('filters the stream by telegram id too', async () => {
    const { service, captured } = panelOn('3.2.1', SUMMARY);
    await service.resolveRemnawaveUser({ telegramId: '12345' });
    assert.equal(pathOf(captured), '/api/users/stream?size=1&telegramId=12345');
  });

  it('an unreadable version takes the stream as well, and asks nothing else', async () => {
    // An unknown version used to try the 2.x shortcut first. That route does not
    // exist on any supported panel.
    const { service, captured } = build((input) =>
      input.url.startsWith('/api/system/')
        ? throwError(() => new Error('ECONNREFUSED'))
        : of({ data: SUMMARY }),
    );
    await service.resolveRemnawaveUser({ email: 'bob@example.test' });
    assert.deepEqual(
      captured.map((c) => c.url),
      ['/api/users/stream?size=1&email=bob%40example.test'],
    );
  });

  it('a stream answer that does not match the selector is nobody, not the first customer', async () => {
    const stranger = {
      response: { users: [{ id: 9, username: 'rz_carol', status: 'ACTIVE', email: 'carol@example.test' }] },
    };
    const { service } = panelOn('3.2.1', stranger);
    assert.equal(await service.resolveRemnawaveUser({ email: 'bob@example.test' }), null);
  });

  it('the two selectors with routes of their own are never rerouted', async () => {
    const byName = panelOn('3.2.1', SUMMARY);
    await byName.service.resolveRemnawaveUser({ username: 'rz_bob_1' });
    assert.equal(pathOf(byName.captured), '/api/users/by-username/rz_bob_1');

    const byShort = panelOn('3.2.1', SUMMARY);
    await byShort.service.resolveRemnawaveUser({ subscriptionUuid: 'abc123' });
    assert.equal(pathOf(byShort.captured), '/api/users/by-short-uuid/abc123');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Whole-panel walk, and the read that separates "gone" from "unreachable"
// ═══════════════════════════════════════════════════════════════════════════

const ROW_3X = (id: number) => ({
  id,
  username: `rz_u${id}`,
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  expireAt: '2099-01-01T00:00:00.000Z',
  trafficLimitBytes: 0,
  hwidDeviceLimit: 0,
  subscriptionUrl: 'https://sub/x',
});

/** Answers the version probe, then serves `pages` in order to the walker. */
function walker(version: string, pages: readonly unknown[]) {
  let served = 0;
  const urls: string[] = [];
  const { service } = build((input) => {
    if (input.url.startsWith('/api/system/')) return of({ data: { response: { version } } });
    urls.push(input.url);
    const page = pages[Math.min(served, pages.length - 1)];
    served += 1;
    return of({ data: page });
  });
  return { service, urls };
}

describe('strictGetAllPanelUsers — keyset on 3.x', () => {
  it('walks by cursor, and the cursor is what the panel handed back', async () => {
    // Offset paging loses a row whenever the list shrinks mid-walk: every later
    // row shifts one place left, one live user is never served, and the count
    // check still reconciles because the panel's own total fell by the same one.
    const { service, urls } = walker('3.3.2', [
      { response: { users: [ROW_3X(1)], nextCursor: '41', hasMore: true } },
      { response: { users: [ROW_3X(2)], nextCursor: null, hasMore: false } },
    ]);

    const outcome = await service.strictGetAllPanelUsers();

    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, 2);
    assert.equal(outcome.value.complete, true);
    assert.equal(urls[0], '/api/users/stream?size=500');
    assert.equal(urls[1], '/api/users/stream?size=500&cursor=41');
  });

  it('an unknown version keeps the offset walk, which every 3.x serves too', async () => {
    const urls: string[] = [];
    const { service } = build((input) => {
      if (input.url.startsWith('/api/system/')) return throwError(() => new Error('ECONNREFUSED'));
      urls.push(input.url);
      return of({ data: { response: { users: [ROW_3X(1)], total: 1 } } });
    });
    const outcome = await service.strictGetAllPanelUsers();
    assert.equal(outcome.kind, 'ok');
    assert.equal(urls[0], '/api/users/?start=0&size=500');
  });

  it('a SHORT keyset page is not the end of the list', async () => {
    // The offset walk reads a short page as the end. Applying that heuristic to
    // a keyset walk would bless a prefix of the panel as all of it.
    const { service } = walker('3.2.1', [
      { response: { users: [ROW_3X(1)], nextCursor: '9', hasMore: true } },
      { response: { users: [ROW_3X(2), ROW_3X(3)], nextCursor: null, hasMore: false } },
    ]);

    const outcome = await service.strictGetAllPanelUsers();

    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.equal(outcome.value.users.length, 3, 'a short first page must not end the walk');
    assert.equal(outcome.value.complete, true);
  });

  it('refuses a cursor that does not advance instead of spinning to the page cap', async () => {
    const { service } = walker('3.2.1', [
      { response: { users: [ROW_3X(1)], nextCursor: '7', hasMore: true } },
      { response: { users: [ROW_3X(1)], nextCursor: '7', hasMore: true } },
    ]);

    const outcome = await service.strictGetAllPanelUsers();

    assert.equal(outcome.kind, 'invalidContract');
  });
});

describe('getPanelUserOutcome — an outage is not a missing profile', () => {
  const NOT_FOUND = { errorCode: 'A025', message: 'User not found' };

  it('reports missing only when the PANEL said so', async () => {
    const { service } = build((input) =>
      input.url.startsWith('/api/system/')
        ? of({ data: { response: { version: '3.2.1' } } })
        : throwError(() => ({ isAxiosError: true, response: { status: 404, headers: {}, data: NOT_FOUND }, message: 'HTTP 404' })),
    );
    const outcome = await service.getPanelUserOutcome(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'missing');
  });

  it('reports a BARE 404 as unavailable — that is what a proxy answers to everything', async () => {
    const { service } = build((input) =>
      input.url.startsWith('/api/system/')
        ? of({ data: { response: { version: '3.2.1' } } })
        : throwError(() => ({ isAxiosError: true, response: { status: 404, headers: {}, data: '<html>502</html>' }, message: 'HTTP 404' })),
    );
    const outcome = await service.getPanelUserOutcome(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'unavailable');
  });

  it('reports a network failure as unavailable, never as missing', async () => {
    const { service } = build(() => throwError(() => new Error('ETIMEDOUT')));
    const outcome = await service.getPanelUserOutcome(stored({ remnawaveId: '4471' }));
    assert.equal(outcome.kind, 'unavailable');
  });

  it('an unaddressable profile is unavailable — it may be perfectly alive', async () => {
    const { service } = panelOn('3.2.1', USER_3X);
    const outcome = await service.getPanelUserOutcome(stored());
    assert.equal(outcome.kind, 'unavailable');
  });

  it('getPanelUser still collapses all of it to null, for the cards that want that', async () => {
    const { service } = build(() => throwError(() => new Error('ETIMEDOUT')));
    assert.equal(await service.getPanelUser(stored({ remnawaveId: '4471' })), null);
  });
});
