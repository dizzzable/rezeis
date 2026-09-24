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
 * So these tests assert the DECODED result of the two writes on the verbatim
 * 3.2.1 capture, pinned to the vendor's own contracts rather than to whatever
 * our decoder happens to read. (The 2.x bodies are gone with the 2.x cut: such
 * a panel is refused before any write is sent.)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import * as contractPanel321 from '@remnawave/contract-panel-3.2.1';
import * as contractPanel323 from '@remnawave/contract-panel-3.2.3';
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

/** The two write commands, typed structurally: each release is a separate zod build. */
interface UserWriteContract {
  readonly CreateUserCommand: { readonly ResponseSchema: { safeParse(value: unknown): { success: boolean } } };
  readonly UpdateUserCommand: { readonly ResponseSchema: { safeParse(value: unknown): { success: boolean } } };
}

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
  /** What `/api/system/stats/recap` reports. */
  readonly version: string;
  readonly file: string;
  /** How an UPDATE names this profile, exactly as the link path stored it. */
  readonly ref: PanelUserRef;
  readonly expected: ReturnType<typeof linkFields>;
}

const ERAS: readonly EraCase[] = [
  {
    // The body is the verbatim 3.2.1 capture; the version reported is the
    // operator's actual build. The fixture guard below parses this same body
    // through BOTH contracts — 3.2.0, which panel 3.2.1 ships, and 3.2.3, which
    // that operator's panel ships.
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

describe('a 2xx body with no usable identity is refused, never half-decoded', () => {
  const UNREADABLE: ReadonlyArray<readonly [string, unknown]> = [
    [
      'a row carrying no id',
      { response: { username: 'rz_sub_1', subscriptionUrl: 'https://panel.example/sub/abc' } },
    ],
    [
      // A reverse proxy with no healthy backend answers this to everything,
      // status 200 included. It must not read as "a user was created".
      'a proxy maintenance page served with 200',
      '<html>backend is restarting</html>',
    ],
    [
      // What a 2.x panel answered. Keying it by the uuid would mint an identity
      // no 3.x panel can address — "we could not read this" silently becoming
      // a stored link that names nobody.
      'a row whose only identity is a uuid (must NOT be keyed by it)',
      { response: { uuid: '11111111-1111-4111-8111-111111111111', username: 'rz_sub_1' } },
    ],
  ];

  for (const [label, body] of UNREADABLE) {
    it(`POST refuses ${label}`, async () => {
      const { service } = panelOn('3.3.2', body);

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
      const { service } = panelOn('3.3.2', body);

      await assert.rejects(
        () => service.updatePanelUser({ remnawaveId: '4471', panelId: 4471, panelUsername: 'rz_sub_1' }, {
          description: 'x',
        }),
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

describe("the write fixture is the panel's record, not ours", () => {
  it('3.2.x has no uuid to give — the fact the whole defect rests on', () => {
    const body = { response: fixture('3.2.1/user.json').response };

    // ABSENCE of the key, not emptiness.
    assert.equal('uuid' in body.response, false);
    assert.equal(typeof body.response['id'], 'number');
    // The capture's own release first — panel 3.2.1 ships contract 3.2.0 — and
    // then contract 3.2.3, the build of the operator who reported the defect.
    for (const shipped of [contractPanel321, contractPanel323] as unknown as readonly UserWriteContract[]) {
      assert.equal(shipped.CreateUserCommand.ResponseSchema.safeParse(body).success, true);
      assert.equal(shipped.UpdateUserCommand.ResponseSchema.safeParse(body).success, true);
    }
  });
});
