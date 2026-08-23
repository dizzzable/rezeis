/**
 * The BODY of a SUCCESSFUL `POST` / `PATCH /api/users`.
 *
 * Nothing checked it before. `remnawave-api.service.spec.ts` covers the error
 * taxonomy of both writes and never asserts a 2xx payload;
 * `profile-sync.processor.spec.ts` mocks `createPanelUser` and hands the
 * processor an ALREADY-DECODED object, so the real response decoder was never
 * executed by any test at all. In that blind spot `unwrapPanelUser` was a bare
 * type assertion rather than a decoder, and on Remnawave 3.x — whose user rows
 * carry no `uuid` field, only a numeric `id` — it produced an object whose
 * `uuid` was `undefined` while its type promised `string`. `persistProfileLink`
 * wrote that `undefined` into `remnawaveId`, Prisma read `undefined` as "leave
 * this column alone", and the sync job COMPLETED having stored no link: the
 * panel profile existed, `remnawave_id` stayed NULL forever, the profile card
 * and the device list were permanently empty, and nothing retried because
 * nothing had failed.
 *
 * So these tests assert the DECODED result of the two writes, on the bodies of
 * all three panel eras in production — 2.7.4 (paying), 2.8.0 (testers), 3.2.x
 * (the operator who reported this) — and every fixture is pinned to the vendor's
 * own record of that body rather than to whatever our decoder happens to read.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CreateUserCommand as CreateUserV28,
  UpdateUserCommand as UpdateUserV28,
} from '@remnawave/contract-v28';
import {
  CreateUserCommand as CreateUserV3,
  UpdateUserCommand as UpdateUserV3,
} from '@remnawave/contract-v3';
import { of } from 'rxjs';

import type { PanelUserRef } from '../src/modules/remnawave/services/panel-user-address';
import {
  RemnawaveApiService,
  type RemnawavePanelUser,
} from '../src/modules/remnawave/services/remnawave-api.service';

interface PanelFixture {
  readonly version: string;
  readonly response: Record<string, unknown>;
}

function fixture(rel: string): PanelFixture {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'remnawave', rel), 'utf8'),
  ) as PanelFixture;
}

/**
 * The 2.x write fixtures, named ONCE so the two loops below cannot fall out of
 * step about what they cover — and so their eventual deletion is a single,
 * visible edit rather than two.
 *
 * Both loops register their `it(...)` calls FROM this list. An empty list
 * therefore registers zero tests and both blocks report green having asserted
 * nothing, which is this repository's signature failure mode arriving on a
 * timer: retiring the 2.x fixtures is a planned, gated phase. Each loop is
 * followed by a liveness floor that fails loudly instead.
 */
const TWO_X_WRITE_FIXTURES = ['2.7.4/created-user.json', '2.8.0/created-user.json'] as const;

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

/** Answers the version probe with `version`; every other call gets `body`. */
function panelOn(version: string, body: unknown) {
  return build((input) =>
    input.url.startsWith('/api/system/')
      ? of({ data: { response: { version } } })
      : of({ data: body }),
  );
}

function createInput(username: string) {
  return {
    username,
    telegramId: null,
    email: null,
    description: 'reiwa_id: user-1',
    tag: null,
    expireAt: '2099-01-01T00:00:00.000Z',
    trafficLimitBytes: 0,
    hwidDeviceLimit: 0,
    trafficLimitStrategy: 'NO_RESET',
    activeInternalSquads: [],
    externalSquadUuid: null,
  } as Parameters<RemnawaveApiService['createPanelUser']>[0];
}

/**
 * EXACTLY the five fields the two write callers read off the result, and no
 * others: `handleCreate` passes `uuid`, `panelId`, `username`, `subscriptionUrl`
 * and `createdAt` to `persistProfileLink`; `handleUpdate` passes `panelId`,
 * `username` and `createdAt` to `backfillPanelIdentity`. Anything wrong in here
 * is a profile that cannot be found again.
 */
function linkFields(user: RemnawavePanelUser) {
  return {
    uuid: user.uuid,
    panelId: user.panelId,
    username: user.username,
    subscriptionUrl: user.subscriptionUrl,
    createdAt: user.createdAt,
  };
}

interface EraCase {
  readonly label: string;
  /** What `/api/system/stats/recap` reports, i.e. which era we are addressing. */
  readonly version: string;
  readonly file: string;
  /** How an UPDATE names this profile, exactly as the row would hand it over. */
  readonly ref: PanelUserRef;
  readonly expected: ReturnType<typeof linkFields>;
}

const ERAS: readonly EraCase[] = [
  {
    label: '2.7.4 (paying production)',
    version: '2.7.4',
    file: '2.7.4/created-user.json',
    ref: '11111111-1111-4111-8111-111111111111',
    expected: {
      uuid: '11111111-1111-4111-8111-111111111111',
      // The numeric id is on the 2.x row too, and recording it is the ONLY
      // thing that keeps this profile addressable after the operator upgrades:
      // the panel's own 3.x migration drops the uuid and never gives it back.
      panelId: 4471,
      username: 'rz_sub_1',
      subscriptionUrl: 'https://panel.example/sub/abc',
      createdAt: '2024-03-31T10:15:00.000Z',
    },
  },
  {
    label: '2.8.0 (testers)',
    version: '2.8.0',
    file: '2.8.0/created-user.json',
    ref: '22222222-2222-4222-8222-222222222222',
    expected: {
      uuid: '22222222-2222-4222-8222-222222222222',
      panelId: 8123,
      username: 'rz_sub_2',
      subscriptionUrl: 'https://panel.example/sub/def',
      createdAt: '2025-02-28T23:59:59.000Z',
    },
  },
  {
    // The body is the verbatim 3.2.1 capture; the version reported is the
    // operator's actual build. Both are `addressing: 'id'` and the row shape is
    // unchanged across the 3.2.x line — see `@remnawave/contract-v3`, pinned at
    // 3.2.3, which the fixture guard below parses this same body through.
    label: '3.2.3 (the operator who reported the defect)',
    version: '3.2.3',
    file: '3.2.1/user.json',
    ref: { remnawaveId: '2', panelId: 2, panelUsername: 'labuser1' },
    expected: {
      // A 3.x row has no uuid, so the identity IS the numeric id rendered as a
      // string — the same dual meaning `Subscription.remnawaveId` carries.
      uuid: '2',
      panelId: 2,
      username: 'labuser1',
      subscriptionUrl: 'https://panel.example/api/sub/PyTr7C5568QuLhup',
      createdAt: '2026-08-10T12:34:05.233Z',
    },
  },
];

describe('POST /api/users — the created profile is decoded, not cast', () => {
  for (const era of ERAS) {
    it(`${era.label}: yields the identity the CREATE path persists`, async () => {
      const { service } = panelOn(era.version, fixture(era.file));

      const created = await service.createPanelUser(createInput(era.expected.username));

      assert.deepStrictEqual(linkFields(created), era.expected);
    });
  }
});

describe('PATCH /api/users — the same body through the same decoder', () => {
  for (const era of ERAS) {
    it(`${era.label}: yields the identity the UPDATE path backfills`, async () => {
      const { service } = panelOn(era.version, fixture(era.file));

      const updated = await service.updatePanelUser(era.ref, { description: 'reiwa_id: user-1' });

      assert.deepStrictEqual(linkFields(updated), era.expected);
    });
  }
});

describe('2.7.4 keeps every field it already had — nothing narrows for the paying version', () => {
  /**
   * The decoder must be a SUPERSET of the assertion it replaces. The old
   * `unwrapPanelUser` handed callers the panel's own object, so on 2.x every one
   * of these fields already read correctly; the fix must not quietly drop or
   * rename any of them while it repairs 3.x.
   */
  const CARRIED_THROUGH = [
    'uuid',
    'username',
    'status',
    'subscriptionUrl',
    'telegramId',
    'email',
    'expireAt',
    'createdAt',
    'lastTrafficResetAt',
    'trafficLimitBytes',
    'hwidDeviceLimit',
    'trafficLimitStrategy',
    'tag',
    'description',
    'activeInternalSquads',
    'externalSquadUuid',
  ] as const;

  let registered = 0;
  for (const rel of TWO_X_WRITE_FIXTURES) {
    registered += 1;
    it(`${rel}: every field the cast produced survives, and panelId is added`, async () => {
      const loaded = fixture(rel);
      const raw = loaded.response;
      const { service } = panelOn(loaded.version, loaded);

      const created = await service.createPanelUser(createInput(raw['username'] as string));
      const decoded = created as unknown as Record<string, unknown>;

      for (const key of CARRIED_THROUGH) {
        assert.deepStrictEqual(decoded[key], raw[key], `${rel}: ${key} changed`);
      }
      assert.equal(created.panelId, raw['id'], `${rel}: panelId must come from the row's id`);
    });
  }

  // LIVENESS FLOOR — see `TWO_X_WRITE_FIXTURES`. The expected count is a
  // LITERAL and not `TWO_X_WRITE_FIXTURES.length`: comparing the loop against
  // the list it just iterated is satisfied by an empty list too, which is
  // exactly the state this must fail on.
  it('registered one case per 2.x write fixture', () => {
    assert.ok(registered > 0, 'the 2.x write fixture list is empty — this block asserts nothing');
    assert.equal(registered, 2, 'the 2.x write fixture coverage changed — was that deliberate?');
  });
});

describe('a 2xx body with no usable identity is refused, never half-decoded', () => {
  const UNREADABLE: ReadonlyArray<readonly [string, unknown]> = [
    [
      'a row carrying neither a uuid nor an id',
      { response: { username: 'rz_sub_1', subscriptionUrl: 'https://panel.example/sub/abc' } },
    ],
    [
      // A reverse proxy with no healthy backend answers this to everything,
      // status 200 included. It must not read as "a user was created".
      'a proxy maintenance page served with 200',
      '<html>backend is restarting</html>',
    ],
    [
      // The row is from the uuid era and its uuid arrived damaged. Keying it by
      // the numeric id would mint an identity matching no `remnawaveId` ever
      // stored from that era — "we could not read this" silently becoming "this
      // user is unknown to us".
      'a 2.x row whose uuid arrived empty (must NOT fall back to the numeric id)',
      { response: { uuid: '', id: 4471, username: 'rz_sub_1' } },
    ],
  ];

  for (const [label, body] of UNREADABLE) {
    it(`POST refuses ${label}`, async () => {
      const { service } = panelOn('2.7.4', body);

      await assert.rejects(
        () => service.createPanelUser(createInput('rz_sub_1')),
        (err: unknown) => {
          assert.match((err as Error).message, /POST \/api\/users/);
          assert.match((err as Error).message, /no usable identity/);
          return true;
        },
      );
    });

    it(`PATCH refuses ${label}`, async () => {
      const { service } = panelOn('2.7.4', body);

      await assert.rejects(
        () => service.updatePanelUser('11111111-1111-4111-8111-111111111111', { description: 'x' }),
        (err: unknown) => {
          assert.match((err as Error).message, /PATCH \/api\/users/);
          // NOT laundered into ServiceUnavailableException by the transport
          // catch: that is what `classifyRecovery` calls TRANSIENT, and a body
          // we cannot read will not read any better in five minutes. It has to
          // stay the failure that pages somebody.
          assert.equal((err as Error).name, 'Error');
          return true;
        },
      );
    });
  }
});

describe("the write fixtures are the panel's record, not ours", () => {
  /**
   * Quoted verbatim from `CreateUserResponseDto.response.required` in
   * `icon/Remnawave API v274.json`. `Remnawave API v280.json` declares the
   * identical array, and so does `UpdateUserResponseDto` in both specs — which
   * is why one fixture per era answers for POST and PATCH alike.
   *
   * Without this guard the fixtures could be trimmed to whatever the decoder
   * happens to read, which is exactly how the defect survived: the mocks agreed
   * with the code instead of with the panel.
   */
  const REQUIRED_2X = [
    'uuid', 'id', 'shortUuid', 'username', 'expireAt', 'telegramId', 'email',
    'description', 'tag', 'hwidDeviceLimit', 'externalSquadUuid', 'trojanPassword',
    'vlessUuid', 'ssPassword', 'subRevokedAt', 'lastTrafficResetAt', 'createdAt',
    'updatedAt', 'subscriptionUrl', 'activeInternalSquads', 'userTraffic',
  ] as const;

  let registered = 0;
  for (const rel of TWO_X_WRITE_FIXTURES) {
    registered += 2;
    it(`${rel} carries every field the 2.x DTO guarantees — uuid AND id`, () => {
      const keys = Object.keys(fixture(rel).response);
      for (const name of REQUIRED_2X) {
        assert.ok(keys.includes(name), `${rel}: the panel always sends ${name}`);
      }
    });

    it(`${rel} parses as the vendor's own create/update response`, () => {
      const body = { response: fixture(rel).response };
      assert.equal(CreateUserV28.ResponseSchema.safeParse(body).success, true, rel);
      assert.equal(UpdateUserV28.ResponseSchema.safeParse(body).success, true, rel);
    });
  }

  // LIVENESS FLOOR — see `TWO_X_WRITE_FIXTURES`. Two cases per fixture, and the
  // total is a LITERAL for the same reason as the block above: an empty list
  // satisfies any comparison drawn from itself.
  it('registered both cases for every 2.x write fixture', () => {
    assert.ok(registered > 0, 'the 2.x write fixture list is empty — this block asserts nothing');
    assert.equal(registered, 4, 'the 2.x write fixture coverage changed — was that deliberate?');
  });

  it('3.2.x has no uuid to give — the fact the whole defect rests on', () => {
    const body = { response: fixture('3.2.1/user.json').response };

    // ABSENCE of the key, not emptiness: that is what the decoder branches on.
    assert.equal('uuid' in body.response, false);
    assert.equal(typeof body.response['id'], 'number');
    // `@remnawave/contract-v3` is pinned at 3.2.3 — this operator's exact build.
    assert.equal(CreateUserV3.ResponseSchema.safeParse(body).success, true);
    assert.equal(UpdateUserV3.ResponseSchema.safeParse(body).success, true);
  });
});
