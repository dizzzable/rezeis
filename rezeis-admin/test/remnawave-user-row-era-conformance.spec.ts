/**
 * THE PANEL USER ROW, held against the vendor's own contracts — for EVERY
 * Remnawave 3.x release rezeis ships to, not just the newest one.
 *
 * WHY THIS FILE EXISTS. `unwrapPanelUser` used to CAST the create/update
 * response into `RemnawavePanelUser` instead of decoding it. A Remnawave 3.x
 * user row has no `uuid` field at all, so the cast produced an object whose
 * `uuid` was `undefined` while its TypeScript type promised `string`. That went
 * into a Prisma `update`, Prisma reads `undefined` as "leave this column
 * alone", and the write SUCCEEDED having recorded no identity: `remnawave_id`
 * stayed NULL forever and the sync job reported COMPLETED. Months of rows were
 * silently damaged.
 *
 * A TYPES-ONLY CONTRACT CANNOT PREVENT THAT — `as` compiles regardless. A zod
 * schema can, because it PARSES. That is why the vendor SDKs are pinned and
 * actually executed here rather than imported for their types.
 *
 * WHY EVERY 3.x RELEASE. Operators upgrade on their own schedule, so "supports
 * the newest panel" is never a licence to narrow. A 2.x panel is a different
 * matter since the 2.x cut: it is refused on every path before a row is read,
 * so no 2.x row is decoded here and no 2.x contract is imported. A row that
 * still carries a `uuid` beside its numeric id is keyed by the id, and the
 * `uuid` is reported as drift — a 3.x panel never sends one.
 *
 * THE ANCHORS, all available in CI — the contract each panel release ships, per
 * the vendor's own table (https://docs.rw/sdk/typescript-sdk/), as devDependency
 * aliases named by panel release. None of them is a runtime dependency.
 *
 *   `@remnawave/contract-panel-3.2.1`  backend-contract 3.2.0   panel 3.2.0–3.2.1
 *   `@remnawave/contract-panel-3.2.3`  backend-contract 3.2.3   panel 3.2.3
 *   `@remnawave/contract-panel-3.3`    backend-contract 3.4.2   panel 3.3.0–3.3.2
 *   `@remnawave/contract-panel-3.4.3`  backend-contract 3.4.13  panel 3.4.0–3.4.3
 *   `@remnawave/contract-panel-3.4.4`  backend-contract 3.4.15  panel 3.4.4
 *   `test/fixtures/remnawave/3.3.2/user.json` — derived MECHANICALLY from
 *       `UserResponseDto.response` in the vendor's OpenAPI document for panel
 *       3.3.2. Its key set is the specification's, not something hand-written to
 *       match whatever our decoder happens to read. A fixture trimmed to the
 *       decoder is exactly how the original defect survived: the mocks agreed
 *       with the code instead of with the panel.
 *
 * WHAT THIS FILE DOES NOT DO: it does not change our decoder to match any one
 * vendor contract. Where the two genuinely disagree, our decoder is encoding a
 * decision no single contract can express, and the disagreement is recorded
 * below as a NAMED exception with its reason — a decision on the record rather
 * than a gap nobody noticed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import * as contractPanel321 from '@remnawave/contract-panel-3.2.1';
import * as contractPanel323 from '@remnawave/contract-panel-3.2.3';
import * as contractPanel33 from '@remnawave/contract-panel-3.3';
import * as contractPanel343 from '@remnawave/contract-panel-3.4.3';
import * as contractPanel344 from '@remnawave/contract-panel-3.4.4';
import { of } from 'rxjs';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { connectEvidenceOf } from '../src/modules/connect-signal/connect-evidence.util';
import {
  describePanelUserShapeDrift,
  PANEL_USER_KNOWN_ROW_KEYS,
  PANEL_USER_LEGACY_ROW_KEYS,
  PANEL_USER_SPEC_REQUIRED_KEYS_3X,
  RemnawaveApiService,
} from '../src/modules/remnawave/services/remnawave-api.service';

// ── the contracts under test ────────────────────────────────────────────────

interface UserCommand {
  readonly ResponseSchema: {
    safeParse: (value: unknown) =>
      | { success: true; data: { response: Record<string, unknown> } }
      | { success: false; error: { issues: ReadonlyArray<{ path: unknown[]; message: string }> } };
    readonly shape?: { response: { shape: Record<string, unknown> } };
  };
}

interface ContractUnderTest {
  readonly label: string;
  readonly version: string;
  readonly create: UserCommand;
  readonly update: UserCommand;
}

function contractOf(panels: string, version: string, mod: unknown): ContractUnderTest {
  const contract = mod as { CreateUserCommand: unknown; UpdateUserCommand: unknown };
  return {
    label: `contract ${version} (panel ${panels})`,
    version,
    create: contract.CreateUserCommand as UserCommand,
    update: contract.UpdateUserCommand as UserCommand,
  };
}

const CONTRACTS: readonly ContractUnderTest[] = [
  contractOf('3.2.0–3.2.1', '3.2.0', contractPanel321),
  contractOf('3.2.3', '3.2.3', contractPanel323),
  contractOf('3.3.0–3.3.2', '3.4.2', contractPanel33),
  contractOf('3.4.0–3.4.3', '3.4.13', contractPanel343),
  contractOf('3.4.4', '3.4.15', contractPanel344),
];

function contractByVersion(version: string): ContractUnderTest {
  const found = CONTRACTS.find((c) => c.version === version);
  assert.ok(found !== undefined, `contract ${version} is not wired into this spec`);
  return found;
}

/**
 * Direction-complete key-set comparison.
 *
 * A SEPARATE, TESTABLE UNIT on purpose. Every field-set claim in this file goes
 * through it, and the two tests directly beneath `describe('the key-set
 * comparison itself…')` prove it catches drift in BOTH directions. Written
 * inline at each call site instead, a one-directional `every(...)` would read
 * as a real assertion, pass forever, and let exactly the silent drift this file
 * exists to catch slip through — so the guard is guarded.
 */
function compareKeySets(actual: readonly string[], expected: readonly string[]) {
  return {
    /** Declared/expected, but not present in `actual`. */
    absent: expected.filter((k) => !actual.includes(k)).sort(),
    /** Present in `actual`, but not declared/expected. */
    unexpected: actual.filter((k) => !expected.includes(k)).sort(),
  };
}

/** Fails, NAMING the difference, if the two sets are not identical. */
function assertKeySetsAgree(
  actual: readonly string[],
  expected: readonly string[],
  what: string,
): void {
  const { absent, unexpected } = compareKeySets(actual, expected);
  assert.deepStrictEqual(unexpected, [], `${what}: unexpected ${unexpected.join(', ')}`);
  assert.deepStrictEqual(absent, [], `${what}: absent ${absent.join(', ')}`);
}

/** A contract's declared user-row key set. */
function declaredRowKeys(contract: ContractUnderTest): readonly string[] {
  const shape = (contract.create.ResponseSchema as unknown as {
    shape: { response: { shape: Record<string, unknown> } };
  }).shape.response.shape;
  return Object.keys(shape);
}

// ── fixtures ────────────────────────────────────────────────────────────────

interface PanelFixture {
  readonly version: string;
  readonly response: Record<string, unknown>;
  readonly specRequired?: readonly string[];
}

function fixture(rel: string): PanelFixture {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'remnawave', rel), 'utf8'),
  ) as PanelFixture;
}

const ROW_321 = fixture('3.2.1/user.json');
const ROW_332 = fixture('3.3.2/user.json');

/** The uuid a 2.x panel would have sent beside the numeric id. */
const STRAY_UUID = '11111111-1111-4111-8111-111111111111';

interface EraCase {
  readonly label: string;
  /** What `/api/system/stats/recap` reports. */
  readonly panelVersion: string;
  /** The contract that panel release ships — the one its row is judged by. */
  readonly shippedContract: string;
  readonly row: PanelFixture;
  readonly expectedIdentity: string;
  readonly expectedPanelId: number;
  /** How an UPDATE names this profile, exactly as the link path stored it. */
  readonly ref: { remnawaveId: string; panelId: number; panelUsername: string };
}

const ERAS: readonly EraCase[] = [
  {
    label: '3.2.1 (verbatim live capture)',
    panelVersion: '3.2.1',
    shippedContract: '3.2.0',
    row: ROW_321,
    expectedIdentity: '2',
    expectedPanelId: 2,
    ref: { remnawaveId: '2', panelId: 2, panelUsername: 'labuser1' },
  },
  {
    label: "3.3.2 (the owner's panel, shape taken from its OpenAPI document)",
    panelVersion: '3.3.2',
    shippedContract: '3.4.2',
    row: ROW_332,
    expectedIdentity: '7',
    expectedPanelId: 7,
    ref: { remnawaveId: '7', panelId: 7, panelUsername: 'rz_sub_332' },
  },
];

// ── harness ─────────────────────────────────────────────────────────────────

const CONFIG = {
  host: 'remnawave',
  port: 3000,
  token: 'secret',
  webhookSecret: null,
} as const;

interface RecordedEvent {
  readonly type: string;
  readonly category: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

function eventSink() {
  const events: RecordedEvent[] = [];
  const sink = {
    warn: (type: string, category: string, message: string, metadata?: Record<string, unknown>) => {
      events.push({ type, category, message, metadata: metadata ?? {} });
    },
  };
  return { events, sink };
}

/**
 * A panel answering `version` to the probe and `body` to everything else.
 *
 * The decoder is reached ONLY through the service's real public methods. It is
 * never imported and called directly, because the defect this file guards
 * against lived in the seam between the transport and the decoder, and a test
 * that calls the decoder in isolation cannot see that seam at all.
 */
function panelOn(version: string, body: unknown) {
  const { events, sink } = eventSink();
  const service = new RemnawaveApiService(
    {
      request: (input: { url: string }) =>
        input.url.startsWith('/api/system/')
          ? of({ data: { response: { version } } })
          : of({ data: body }),
    } as never,
    CONFIG as never,
    sink as never,
  );
  return { service, events };
}

/** One service whose transport answers a different row on each successive call. */
function panelServing(version: string, rows: ReadonlyArray<Record<string, unknown>>) {
  const { events, sink } = eventSink();
  let index = 0;
  const service = new RemnawaveApiService(
    {
      request: (input: { url: string }) => {
        if (input.url.startsWith('/api/system/')) {
          return of({ data: { response: { version } } });
        }
        const row = rows[Math.min(index, rows.length - 1)];
        index += 1;
        return of({ data: { response: row } });
      },
    } as never,
    CONFIG as never,
    sink as never,
  );
  return { service, events };
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

// ═══════════════════════════════════════════════════════════════════════════
//  1. EVERY 3.x CONTRACT READS EVERY 3.x ROW — the measured table
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every pinned 3.x contract accepts every 3.x row. The one thing none of them
 * can do is keep a `uuid`: 3.x declares no such field, and zod strips unknown
 * keys by default — so a contract would silently drop the identity a 2.x row
 * carried. That is why our decoder keys by the numeric id and REPORTS a stray
 * `uuid` rather than reading it.
 */
describe('every 3.x contract reads every 3.x row', () => {
  for (const era of ERAS) {
    for (const contract of CONTRACTS) {
      it(`${era.label} through ${contract.label}: accepted, no uuid`, () => {
        const parsed = contract.create.ResponseSchema.safeParse({ response: era.row.response });
        assert.equal(parsed.success, true, 'expected a successful parse, got a rejection');
        const out = (parsed as { data: { response: Record<string, unknown> } }).data.response;
        assert.equal(Object.prototype.hasOwnProperty.call(out, 'uuid'), false);
        assert.equal(out['id'], era.expectedPanelId);
      });
    }
  }

  it('a stray uuid is stripped by every 3.x contract — the vendor cannot say "damaged"', () => {
    for (const contract of CONTRACTS) {
      const parsed = contract.create.ResponseSchema.safeParse({
        response: { ...ROW_332.response, uuid: STRAY_UUID },
      });
      assert.equal(parsed.success, true, `${contract.label} rejected a row with a stray uuid`);
      const out = (parsed as { data: { response: Record<string, unknown> } }).data.response;
      assert.equal(
        Object.prototype.hasOwnProperty.call(out, 'uuid'),
        false,
        `${contract.label} preserved a uuid it does not declare`,
      );
    }
  });

  it('the matrix is not empty and names every pinned 3.x release', () => {
    assert.equal(ERAS.length, 2);
    assert.equal(CONTRACTS.length, 5);
  });

  it('each row is accepted by the contract its own panel release ships', () => {
    for (const era of ERAS) {
      const shipped = contractByVersion(era.shippedContract);
      const body = { response: era.row.response };
      assert.equal(
        shipped.create.ResponseSchema.safeParse(body).success,
        true,
        `${era.label}: refused by ${shipped.label}, the contract that release ships`,
      );
      assert.equal(
        shipped.update.ResponseSchema.safeParse(body).success,
        true,
        `${era.label}: the update response refused by ${shipped.label}`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. OUR DECODER KEYS EVERY ROW BY ITS NUMERIC ID
// ═══════════════════════════════════════════════════════════════════════════

describe('our decoder keys every row by its numeric id', () => {
  for (const era of ERAS) {
    it(`${era.label}: CREATE yields the identity the link path persists`, async () => {
      const { service } = panelOn(era.panelVersion, era.row);

      const created = await service.createPanelUser(createInput('rz_sub'));

      assert.equal(created.uuid, era.expectedIdentity);
      assert.equal(created.panelId, era.expectedPanelId);
      assert.equal(created.uuid, String(era.row.response['id']));
      assert.equal('uuid' in era.row.response, false);
    });

    it(`${era.label}: PATCH decodes the same body to the same identity`, async () => {
      const { service } = panelOn(era.panelVersion, era.row);

      const updated = await service.updatePanelUser(era.ref, { description: 'reiwa_id: user-1' });

      assert.equal(updated.uuid, era.expectedIdentity);
      assert.equal(updated.panelId, era.expectedPanelId);
    });
  }

  it('a row that still carries a uuid is keyed by its numeric id — and the uuid is drift', async () => {
    // What a 2.x panel sent. Keying it by the uuid would mint an identity no
    // 3.x panel can address; the numeric id is the one that works.
    const { service, events } = panelOn('3.3.2', {
      response: { ...ROW_332.response, uuid: STRAY_UUID },
    });

    const created = await service.createPanelUser(createInput('rz_sub_332'));

    assert.equal(created.uuid, String(ROW_332.response['id']));
    assert.notEqual(created.uuid, STRAY_UUID);
    assert.equal(events.length, 1, 'the stray uuid was not reported');
    assert.deepStrictEqual(events[0].metadata['unknownFields'], ['uuid']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. THE KEY-SET CONSTANT IS THE VENDOR'S, NOT OURS
// ═══════════════════════════════════════════════════════════════════════════

describe('the key-set comparison itself catches drift in both directions', () => {
  /**
   * Guards the guard. Every field-set claim in this file is only as good as
   * `assertKeySetsAgree`; weakened to a one-directional subset check it would
   * keep passing while drift walked straight through, which is this repo's
   * signature failure mode. These two tests make that weakening fail loudly.
   */
  it('catches a key that is present but not expected', () => {
    assert.throws(
      () => assertKeySetsAgree(['a', 'b'], ['a'], 'probe'),
      /unexpected b/,
      'an EXTRA key passed the comparison — the unexpected direction is gone',
    );
  });

  it('catches a key that is expected but absent', () => {
    assert.throws(
      () => assertKeySetsAgree(['a'], ['a', 'b'], 'probe'),
      /absent b/,
      'a MISSING key passed the comparison — the absent direction is gone',
    );
  });

  it('accepts two identical sets regardless of order', () => {
    assertKeySetsAgree(['b', 'a'], ['a', 'b'], 'probe');
    assert.deepStrictEqual(compareKeySets(['b', 'a'], ['a', 'b']), { absent: [], unexpected: [] });
  });
});

describe('PANEL_USER_SPEC_REQUIRED_KEYS_3X is pinned to the vendor, two ways', () => {
  it('the 3.3.2 fixture has NO uuid key at all — absence, not emptiness', () => {
    // The single fact the whole incident diagnosis rests on. Remnawave 3.0
    // removed the column; `/api/users/{userId}` takes a number. If this fixture
    // ever grows a uuid, every identity claim below is being made about a row
    // the panel does not produce.
    assert.equal('uuid' in ROW_332.response, false);
    assert.equal(Object.prototype.hasOwnProperty.call(ROW_332.response, 'uuid'), false);
    assert.equal(typeof ROW_332.response['id'], 'number');
    assertKeySetsAgree(
      Object.keys(ROW_332.response),
      [...PANEL_USER_SPEC_REQUIRED_KEYS_3X],
      'the 3.3.2 fixture row vs the declared key set',
    );
  });

  it('equals what the 3.4.2 SDK declares on a user row — exactly, both directions', () => {
    const sdk = [...declaredRowKeys(contractByVersion('3.4.2'))].sort();
    const ours = [...PANEL_USER_SPEC_REQUIRED_KEYS_3X].sort();

    // Anchor: both sides are non-empty, so the comparison cannot pass by
    // comparing two empty lists — how schema-introspection tests go vacuous.
    assert.ok(sdk.length > 20, `SDK declared only ${sdk.length} user-row fields`);
    assert.ok(ours.length > 20, `we declared only ${ours.length} user-row fields`);

    assertKeySetsAgree(ours, sdk, 'our key-set constant vs the 3.4.2 SDK');
  });

  it("equals the 3.3.2 OpenAPI document's own required list — exactly, both directions", () => {
    const declared = ROW_332.specRequired;
    assert.ok(
      Array.isArray(declared) && declared.length > 20,
      'the 3.3.2 fixture carries no usable specRequired list',
    );
    const spec = [...(declared as readonly string[])].sort();
    const ours = [...PANEL_USER_SPEC_REQUIRED_KEYS_3X].sort();

    assertKeySetsAgree(ours, spec, 'our key-set constant vs the 3.3.2 OpenAPI document');
  });

  it('the 3.4.2 SDK and the 3.3.2 document agree with each other — the pairing is right', () => {
    const sdk = [...declaredRowKeys(contractByVersion('3.4.2'))].sort();
    const spec = [...(ROW_332.specRequired as readonly string[])].sort();
    assertKeySetsAgree(sdk, spec, 'the 3.4.2 SDK vs the 3.3.2 OpenAPI document');
  });

  it('no 3.x contract declares a uuid on a user row', () => {
    for (const contract of CONTRACTS) {
      assert.equal(declaredRowKeys(contract).includes('uuid'), false, contract.label);
    }
  });

  it('the legacy keys are additive — they never shadow the 3.x declared set', () => {
    const overlap = PANEL_USER_LEGACY_ROW_KEYS.filter((k) =>
      PANEL_USER_SPEC_REQUIRED_KEYS_3X.includes(k),
    );
    assert.deepStrictEqual(overlap, [], `legacy keys shadow declared fields: ${overlap.join(', ')}`);
    assert.equal(
      PANEL_USER_KNOWN_ROW_KEYS.length,
      PANEL_USER_SPEC_REQUIRED_KEYS_3X.length + PANEL_USER_LEGACY_ROW_KEYS.length,
    );
  });

  it('`uuid` is NOT a known key — a row carrying one is drift, not a shape we decode', () => {
    // It used to be kept "because 2.x deployments are live". A 2.x panel is now
    // refused before any row is read, so the only way a uuid reaches the decoder
    // is a panel that is not what it says — which an operator should see.
    assert.equal(PANEL_USER_KNOWN_ROW_KEYS.includes('uuid'), false);
    assert.equal(PANEL_USER_LEGACY_ROW_KEYS.includes('uuid'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. A ROW WITHOUT A USABLE NUMERIC id IS UNDECODABLE — NEVER RE-KEYED
// ═══════════════════════════════════════════════════════════════════════════

describe('a row without a usable numeric id stays UNDECODABLE', () => {
  /**
   * The identity is the numeric `id`, and nothing else. Keying a row by a uuid
   * it happens to carry would mint a key that no 3.x panel can address and no
   * stored `remnawaveId` should match — turning "we could not read this row"
   * into "this user is unknown to us", and the callers that act on absence
   * would act.
   */
  const DAMAGED_IDS: ReadonlyArray<readonly [string, unknown]> = [
    ['missing', undefined],
    ['null', null],
    ['a decimal string', '7'],
    ['a fraction', 7.5],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ];

  function damagedRow(badId: unknown): Record<string, unknown> {
    const row: Record<string, unknown> = { ...ROW_332.response, uuid: STRAY_UUID };
    if (badId === undefined) delete row['id'];
    else row['id'] = badId;
    return row;
  }

  for (const [label, badId] of DAMAGED_IDS) {
    it(`POST refuses a row whose id is ${label} — even with a uuid right there`, async () => {
      const { service } = panelOn('3.3.2', { response: damagedRow(badId) });

      await assert.rejects(
        () => service.createPanelUser(createInput('rz_sub_1')),
        (err: unknown) => {
          assert.match((err as Error).message, /POST \/api\/users/);
          assert.match((err as Error).message, /no usable identity/);
          return true;
        },
      );
    });

    it(`PATCH refuses a row whose id is ${label} too, and NOT as a transient failure`, async () => {
      const { service } = panelOn('3.3.2', { response: damagedRow(badId) });

      await assert.rejects(
        () => service.updatePanelUser(ERAS[1]!.ref, { description: 'x' }),
        (err: unknown) => {
          assert.match((err as Error).message, /PATCH \/api\/users/);
          // NOT laundered into ServiceUnavailableException: that is what
          // `classifyRecovery` calls TRANSIENT, and a body we cannot read will
          // not read any better in five minutes. It has to stay the failure
          // that pages somebody.
          assert.equal((err as Error).name, 'Error');
          return true;
        },
      );
    });
  }

  it('the same row with a usable id decodes — the refusal is about the id alone', async () => {
    const { service } = panelOn('3.3.2', { response: damagedRow(7) });

    const created = await service.createPanelUser(createInput('rz_sub_1'));

    assert.equal(created.uuid, '7');
    assert.equal(created.panelId, 7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. THE FIELD SET — WHAT THE DECODER ACTUALLY TOUCHES, MEASURED
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fields the vendor declares that our decoder deliberately never reads. Each is
 * an explicit decision, not an oversight; a NEW name appearing here must fail
 * this test so somebody decides about it.
 */
const DECLARED_BUT_DELIBERATELY_IGNORED: Readonly<Record<string, string>> = {
  shortUuid: 'the subscription slug; the cabinet reads it off subscriptionUrl instead',
  trojanPassword: 'credential material — deliberately never copied into our model',
  vlessUuid: 'credential material — deliberately never copied into our model',
  ssPassword: 'credential material — deliberately never copied into our model',
  subRevokedAt: 'subscription revocation is panel-owned; nothing downstream reads it',
  updatedAt: 'resets key off createdAt and lastTrafficResetAt, never updatedAt',
  lastTriggeredThreshold: 'panel-internal bandwidth notification state',
  // `userTraffic` used to be excused here ("usage is read through the dedicated
  // usage call"). It is READ now: whether a profile ever connected comes from
  // its `firstConnectedAt`, `onlineAt` and lifetime counter — see the traffic
  // block section below.
};

/**
 * Fields our decoder reads that panel 3.x does not declare. One legacy
 * tolerance, and it must survive. (`uuid` was the other, until the 2.x cut.)
 */
const READ_BUT_NOT_DECLARED_BY_3X: Readonly<Record<string, string>> = {
  telegram_id: 'snake_case fallback accepted when telegramId is absent or not a number',
};

/** Records every string property the decoder actually reads off a row. */
function recordingRow(row: Record<string, unknown>) {
  const reads = new Set<string>();
  const proxy = new Proxy(row, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') reads.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxy, reads };
}

describe('the decoder and the vendor contract cover the same fields, both directions', () => {
  /**
   * MEASURED, not listed. A hand-maintained "fields we read" list is exactly the
   * kind of note that rots silently; this drives the REAL decoder over a
   * recording Proxy and observes what it genuinely touches.
   */
  async function observedReadSet(row: Record<string, unknown> = { ...ROW_332.response }): Promise<Set<string>> {
    const { proxy, reads } = recordingRow(row);
    const { service } = panelOn('3.3.2', { response: proxy });
    await service.createPanelUser(createInput('rz_sub_332'));
    return reads;
  }

  it('reads nothing the contract does not declare, except the named legacy keys', async () => {
    const reads = await observedReadSet();

    // Anchor: the decoder really did run and really did read fields.
    assert.ok(reads.size > 10, `the decoder read only ${reads.size} fields — did it run?`);

    const undeclared = [...reads].filter((k) => !PANEL_USER_SPEC_REQUIRED_KEYS_3X.includes(k)).sort();
    const allowed = Object.keys(READ_BUT_NOT_DECLARED_BY_3X).sort();

    assertKeySetsAgree(
      undeclared,
      allowed,
      'fields the decoder reads that panel 3.3.2 does not declare, vs the recorded exceptions',
    );
  });

  it('ignores nothing the contract declares, except the named deliberate ignores', async () => {
    const reads = await observedReadSet();

    const ignored = PANEL_USER_SPEC_REQUIRED_KEYS_3X.filter((k) => !reads.has(k)).sort();
    const allowed = Object.keys(DECLARED_BUT_DELIBERATELY_IGNORED).sort();

    assertKeySetsAgree(
      ignored,
      allowed,
      'declared fields the decoder never reads, vs the recorded deliberate ignores',
    );
  });

  it('the decoder never reads a uuid, even when the row carries one', async () => {
    // The exception list above is only honest if `uuid` is genuinely unread on
    // a row that HAS one, rather than merely absent from a 3.x row.
    const reads = await observedReadSet({ ...ROW_332.response, uuid: STRAY_UUID });

    assert.ok(reads.size > 10, 'the decoder did not run');
    assert.equal(reads.has('uuid'), false);
  });

  it('every recorded exception names a real field, so the lists cannot rot', () => {
    for (const name of Object.keys(DECLARED_BUT_DELIBERATELY_IGNORED)) {
      assert.ok(
        PANEL_USER_SPEC_REQUIRED_KEYS_3X.includes(name),
        `${name} is excused as "declared but ignored" but 3.3.2 does not declare it`,
      );
    }
    for (const name of Object.keys(READ_BUT_NOT_DECLARED_BY_3X)) {
      assert.ok(
        PANEL_USER_KNOWN_ROW_KEYS.includes(name),
        `${name} is excused as a legacy read but is not in the known key set`,
      );
      assert.ok(
        !PANEL_USER_SPEC_REQUIRED_KEYS_3X.includes(name),
        `${name} is excused as undeclared but 3.3.2 declares it`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  6. THE RUNTIME DRIFT DETECTOR — REPORTS, NEVER REJECTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The CI checks above catch drift when WE bump a pin. They cannot catch what
 * actually happened: a panel upgraded in production and started returning a
 * different shape, silently, for months, with CI green throughout.
 *
 * With several 3.x releases in the field, "the panel started answering
 * differently" is a routine event rather than an exception — which is exactly
 * why the detector must REPORT and never REJECT. A panel patch release that adds
 * a field must not become an outage.
 */
describe('runtime shape drift is detected and reported on a live panel', () => {
  it('a conformant 3.3.2 row raises nothing at all', async () => {
    const { service, events } = panelOn('3.3.2', ROW_332);

    await service.createPanelUser(createInput('rz_sub_332'));

    assert.deepStrictEqual(events, [], 'the detector cried wolf on a conformant panel');
  });

  for (const era of ERAS) {
    it(`${era.label}: a conformant row of this release raises nothing`, async () => {
      const { service, events } = panelOn(era.panelVersion, era.row);

      await service.createPanelUser(createInput('rz_sub'));

      assert.deepStrictEqual(
        events.map((e) => e.message),
        [],
        'a conformant row of a shipped release was reported as drift',
      );
    });
  }

  it('a field the panel ADDED is reported and does NOT break decoding', async () => {
    const row = { ...ROW_332.response, sponsorshipTier: 'GOLD' };
    const { service, events } = panelOn('3.3.2', { response: row });

    // Decoding still succeeds and still returns exactly what it returned before.
    const created = await service.createPanelUser(createInput('rz_sub_332'));
    assert.equal(created.uuid, String(ROW_332.response['id']));
    assert.equal(created.panelId, ROW_332.response['id']);

    assert.equal(events.length, 1, 'the added field was not reported');
    assert.equal(events[0].type, EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC);
    assert.equal(events[0].category, 'SYSTEM');
    assert.deepStrictEqual(events[0].metadata['unknownFields'], ['sponsorshipTier']);
    assert.deepStrictEqual(events[0].metadata['missingFields'], []);
    assert.match(events[0].message, /sponsorshipTier/);
  });

  it('a field the panel DROPPED is reported and does NOT break decoding', async () => {
    const row = { ...ROW_332.response };
    delete (row as Record<string, unknown>)['tag'];
    const { service, events } = panelOn('3.3.2', { response: row });

    const created = await service.createPanelUser(createInput('rz_sub_332'));
    assert.equal(created.uuid, String(ROW_332.response['id']));
    assert.equal(created.tag, null);

    assert.equal(events.length, 1, 'the dropped field was not reported');
    assert.deepStrictEqual(events[0].metadata['missingFields'], ['tag']);
    assert.deepStrictEqual(events[0].metadata['unknownFields'], []);
    assert.match(events[0].message, /tag/);
  });

  it('both directions are reported together when both drift at once', async () => {
    const row = { ...ROW_332.response, sponsorshipTier: 'GOLD' };
    delete (row as Record<string, unknown>)['tag'];
    const { service, events } = panelOn('3.3.2', { response: row });

    await service.createPanelUser(createInput('rz_sub_332'));

    assert.equal(events.length, 1);
    assert.deepStrictEqual(events[0].metadata['unknownFields'], ['sponsorshipTier']);
    assert.deepStrictEqual(events[0].metadata['missingFields'], ['tag']);
  });

  it('a row that cannot be decoded at all still reports its shape', async () => {
    // No numeric id: the decode is refused, but the operator still needs to see
    // what the panel actually sent.
    const row: Record<string, unknown> = { ...ROW_332.response, mysteryField: 1 };
    delete row['id'];
    const { service, events } = panelOn('3.3.2', { response: row });

    await assert.rejects(() => service.createPanelUser(createInput('rz_sub_1')));

    assert.equal(events.length, 1, 'an undecodable row reported no shape');
    assert.deepStrictEqual(events[0].metadata['unknownFields'], ['mysteryField']);
    assert.deepStrictEqual(events[0].metadata['missingFields'], ['id']);
  });

  it('the reported signal NAMES THE DETECTED MAJOR', async () => {
    // Two operators, same field drift, different panel majors. Their reports
    // must be distinguishable — otherwise a 3.x report and a report from a
    // newer major look identical in the feed and neither can be acted on.
    //
    // The version is read first, as every read path in production does before
    // a row is decoded. The cold-CREATE case is asserted separately below,
    // because it reports something different and that difference is deliberate.
    const threeX = panelOn('3.3.2', { response: { ...ROW_332.response, mystery: 1 } });
    await threeX.service.getPanelShape();
    await threeX.service.updatePanelUser(ERAS[1]!.ref, { description: 'x' });

    const fourX = panelOn('4.0.0', { response: { ...ROW_332.response, mystery: 1 } });
    await fourX.service.getPanelShape();
    await fourX.service.updatePanelUser(ERAS[1]!.ref, { description: 'x' });

    assert.equal(threeX.events.length, 1);
    assert.equal(fourX.events.length, 1);
    assert.equal(threeX.events[0].metadata['panelEra'], '3.x');
    assert.equal(fourX.events[0].metadata['panelEra'], '4.x');
    assert.equal(threeX.events[0].metadata['panelVersion'], '3.3.2');
    assert.equal(fourX.events[0].metadata['panelVersion'], '4.0.0');
    assert.notEqual(
      threeX.events[0].metadata['signature'],
      fourX.events[0].metadata['signature'],
      'the same field drift on two different majors produced the same signature',
    );
    assert.match(threeX.events[0].message, /3\.x/);
    assert.match(fourX.events[0].message, /4\.x/);
  });

  it('an unprobed panel reports "unprobed" rather than guessing an era', async () => {
    // `createPanelUser` needs no addressing decision, so on a cold process it can
    // decode a row before the version has ever been read. The era is genuinely
    // not known at that moment and is reported as such — a guessed era in a
    // drift report is worse than an honest "we had not looked yet", because an
    // operator would act on it.
    const { service, events } = panelOn('3.3.2', {
      response: { ...ROW_332.response, mystery: 1 },
    });

    await service.createPanelUser(createInput('rz_sub_332'));

    assert.equal(events.length, 1);
    assert.equal(events[0].metadata['panelEra'], 'unprobed');
    assert.equal(events[0].metadata['panelVersion'], null);
  });

  it('one event per distinct signature, however many rows carry it', async () => {
    const row = { ...ROW_332.response, sponsorshipTier: 'GOLD' };
    const { service, events } = panelOn('3.3.2', { response: row });

    for (let i = 0; i < 200; i += 1) {
      await service.createPanelUser(createInput('rz_sub_332'));
    }

    assert.equal(
      events.length,
      1,
      `200 identically drifted rows produced ${events.length} events; a drifted panel with ` +
        `5000 users would flood the operator feed at exactly the wrong moment`,
    );
    assert.equal(events[0].metadata['suppressedSinceLastReport'], 0);
  });

  it('DISTINCT signatures are each reported — dedupe must not swallow new drift', async () => {
    const withAlpha = { ...ROW_332.response, alphaField: 1 };
    const withBeta = { ...ROW_332.response, betaField: 2 };
    const withoutEmail = { ...ROW_332.response };
    delete (withoutEmail as Record<string, unknown>)['email'];

    const { service, events } = panelServing('3.3.2', [
      withAlpha,
      withAlpha,
      withAlpha,
      withBeta,
      withBeta,
      withoutEmail,
      withAlpha,
      withBeta,
    ]);

    for (let i = 0; i < 8; i += 1) {
      await service.createPanelUser(createInput('rz_sub_332'));
    }

    const signatures = events.map((e) => e.metadata['signature']);
    assert.equal(
      events.length,
      3,
      `expected one event per distinct signature, got ${events.length}: ${JSON.stringify(signatures)}`,
    );
    assert.equal(new Set(signatures).size, 3, 'the same signature was reported twice');

    const unknowns = events.map((e) => JSON.stringify(e.metadata['unknownFields'])).sort();
    // Lexicographic on the JSON text: '"' (0x22) sorts before ']' (0x5D), so
    // the empty list comes LAST.
    assert.deepStrictEqual(unknowns, ['["alphaField"]', '["betaField"]', '[]']);
  });

  it('key ORDER alone does not mint a new signature', async () => {
    const a: Record<string, unknown> = { ...ROW_332.response, zeta: 1, alpha: 2 };
    const b: Record<string, unknown> = { ...ROW_332.response, alpha: 2, zeta: 1 };

    const { service, events } = panelServing('3.3.2', [a, b]);
    await service.createPanelUser(createInput('rz_sub_332'));
    await service.createPanelUser(createInput('rz_sub_332'));

    assert.equal(events.length, 1, 'reordered keys minted a second signature');
    assert.deepStrictEqual(events[0].metadata['unknownFields'], ['alpha', 'zeta']);
  });

  it('the adapter still works with no event sink at all', async () => {
    // Constructed with two arguments, as a dozen existing specs do. A diagnostic
    // must never make the adapter unconstructable.
    const service = new RemnawaveApiService(
      {
        request: (input: { url: string }) =>
          input.url.startsWith('/api/system/')
            ? of({ data: { response: { version: '3.3.2' } } })
            : of({ data: { response: { ...ROW_332.response, mystery: 1 } } }),
      } as never,
      CONFIG as never,
    );

    const created = await service.createPanelUser(createInput('rz_sub_332'));

    assert.equal(created.uuid, String(ROW_332.response['id']));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  7. THE DETECTOR ITSELF, DIRECTLY
// ═══════════════════════════════════════════════════════════════════════════

describe('describePanelUserShapeDrift', () => {
  it('returns null for a conformant row of every shipped release', () => {
    for (const era of ERAS) {
      assert.equal(
        describePanelUserShapeDrift(era.row.response),
        null,
        `${era.label} was reported as drift`,
      );
    }
  });

  it('names a stray uuid as unknown — it is not a shape any supported panel sends', () => {
    const drift = describePanelUserShapeDrift({ ...ROW_332.response, uuid: STRAY_UUID });
    assert.deepStrictEqual(drift?.unknownFields, ['uuid']);
    assert.deepStrictEqual(drift?.missingFields, []);
  });

  it('names an added field in the unknown direction only', () => {
    const drift = describePanelUserShapeDrift({ ...ROW_332.response, added: 1 });
    assert.notEqual(drift, null);
    assert.deepStrictEqual(drift?.unknownFields, ['added']);
    assert.deepStrictEqual(drift?.missingFields, []);
  });

  it('names a dropped field in the missing direction only', () => {
    const row = { ...ROW_332.response };
    delete (row as Record<string, unknown>)['status'];
    const drift = describePanelUserShapeDrift(row);
    assert.notEqual(drift, null);
    assert.deepStrictEqual(drift?.missingFields, ['status']);
    assert.deepStrictEqual(drift?.unknownFields, []);
  });

  it('sorts both directions so the signature is order-independent', () => {
    const one = describePanelUserShapeDrift({ ...ROW_332.response, zed: 1, abc: 2 });
    const two = describePanelUserShapeDrift({ ...ROW_332.response, abc: 2, zed: 1 });
    assert.equal(one?.signature, two?.signature);
    assert.deepStrictEqual(one?.unknownFields, ['abc', 'zed']);
  });

  it('distinct drifts get distinct signatures', () => {
    const a = describePanelUserShapeDrift({ ...ROW_332.response, alpha: 1 });
    const b = describePanelUserShapeDrift({ ...ROW_332.response, beta: 1 });
    assert.notEqual(a?.signature, b?.signature);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  8. THE TRAFFIC BLOCK — "DID THIS PROFILE EVER CONNECT" — ON EVERY RELEASE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * «Купил, но не подключился» reads the connection from the row's `userTraffic`
 * block, which every 3.x release carries, nested and REQUIRED, under the same
 * five keys. Each case below is first proven to be a row the vendor's own
 * contract for that release accepts (`GetUserByUsernameCommand` — the
 * single-profile read shape), then pushed through the service's real public
 * reads — never the decoder in isolation — and the decoded block is compared
 * with the input.
 *
 * Three states per release, because the whole feature depends on telling them
 * apart: a block that shows a connection (its `usedTrafficBytes` is 0, as it is
 * after every monthly reset — the counter the old reader relied on), a block
 * that is present and empty (never connected), and NO block (unknown: the
 * contract refuses such a row, and so must the "not connected" answer).
 */
interface TrafficEra {
  readonly label: string;
  readonly panelVersion: string;
  readonly contract: unknown;
  readonly row: PanelFixture;
  readonly ref: EraCase['ref'];
}

const TRAFFIC_ERAS: readonly TrafficEra[] = [
  { label: '3.2.1', panelVersion: '3.2.1', contract: contractPanel321, row: ROW_321, ref: ERAS[0]!.ref },
  { label: '3.2.3', panelVersion: '3.2.3', contract: contractPanel323, row: ROW_321, ref: ERAS[0]!.ref },
  { label: '3.3.2', panelVersion: '3.3.2', contract: contractPanel33, row: ROW_332, ref: ERAS[1]!.ref },
  { label: '3.4.3', panelVersion: '3.4.3', contract: contractPanel343, row: ROW_332, ref: ERAS[1]!.ref },
  { label: '3.4.4', panelVersion: '3.4.4', contract: contractPanel344, row: ROW_332, ref: ERAS[1]!.ref },
];

/** A connection the panel remembers, on a counter that was just reset. */
const CONNECTED_BLOCK = {
  usedTrafficBytes: 0,
  lifetimeUsedTrafficBytes: 5_368_709_120,
  onlineAt: '2026-09-01T10:00:00.000Z',
  firstConnectedAt: '2026-08-20T08:00:00.000Z',
  lastConnectedNodeUuid: '5b9c0e34-2a71-4d8f-9b06-1c7a4e2d8f50',
};

function acceptedByContract(contract: unknown, row: Record<string, unknown>): boolean {
  const schema = (contract as { GetUserByUsernameCommand: UserCommand }).GetUserByUsernameCommand.ResponseSchema;
  return schema.safeParse({ response: row }).success;
}

describe('the traffic block decodes on every release the panel serves', () => {
  for (const era of TRAFFIC_ERAS) {
    it(`${era.label}: a connection survives a traffic reset — decoded, and read as connected`, async () => {
      const row = { ...era.row.response, userTraffic: CONNECTED_BLOCK };
      assert.equal(acceptedByContract(era.contract, row), true, 'the fixture is not a row this release sends');
      const { service } = panelOn(era.panelVersion, { response: row });

      const outcome = await service.getPanelUserOutcome(era.ref);

      assert.equal(outcome.kind, 'ok');
      const traffic = outcome.kind === 'ok' ? outcome.user.userTraffic : undefined;
      assert.deepStrictEqual(traffic, {
        usedTrafficBytes: 0,
        lifetimeUsedTrafficBytes: 5_368_709_120,
        onlineAt: '2026-09-01T10:00:00.000Z',
        firstConnectedAt: '2026-08-20T08:00:00.000Z',
      });
      const evidence = connectEvidenceOf(traffic, new Date('2026-09-19T00:00:00.000Z'));
      assert.deepStrictEqual(evidence, { kind: 'connected', at: new Date('2026-08-20T08:00:00.000Z') });

      // The cabinet's card read is the same GET, and hands the same block on.
      const usage = await service.getPanelUserUsage(era.ref);
      assert.deepStrictEqual(usage?.userTraffic, traffic);
    });

    it(`${era.label}: a present, empty block is "never connected"`, async () => {
      const row = era.row.response;
      assert.equal(acceptedByContract(era.contract, row), true);
      assert.equal(typeof row['userTraffic'], 'object', 'precondition: the fixture carries the block');
      const { service } = panelOn(era.panelVersion, { response: row });

      const outcome = await service.getPanelUserOutcome(era.ref);

      assert.equal(outcome.kind, 'ok');
      const traffic = outcome.kind === 'ok' ? outcome.user.userTraffic : undefined;
      assert.deepStrictEqual(traffic, {
        usedTrafficBytes: 0,
        lifetimeUsedTrafficBytes: 0,
        onlineAt: null,
        firstConnectedAt: null,
      });
      assert.deepStrictEqual(connectEvidenceOf(traffic, new Date()), { kind: 'not_connected' });
    });

    it(`${era.label}: NO block is unknown — never "not connected"`, async () => {
      const row: Record<string, unknown> = { ...era.row.response };
      delete row['userTraffic'];
      // The vendor contract refuses such a row outright: the block is required.
      assert.equal(acceptedByContract(era.contract, row), false);
      const { service } = panelOn(era.panelVersion, { response: row });

      const outcome = await service.getPanelUserOutcome(era.ref);

      assert.equal(outcome.kind, 'ok', 'the row still decodes — only its traffic is unknown');
      const traffic = outcome.kind === 'ok' ? outcome.user.userTraffic : undefined;
      assert.equal(traffic, null);
      assert.deepStrictEqual(connectEvidenceOf(traffic, new Date()), { kind: 'unknown' });
      const usage = await service.getPanelUserUsage(era.ref);
      assert.equal(usage?.userTraffic, null);
    });
  }

  it('a malformed block is unknown, not an empty one', async () => {
    const row = {
      ...ROW_332.response,
      userTraffic: { ...CONNECTED_BLOCK, firstConnectedAt: 'yesterday-ish', onlineAt: null },
    };
    const { service } = panelOn('3.3.2', { response: row });

    const outcome = await service.getPanelUserOutcome(ERAS[1]!.ref);

    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.kind === 'ok' ? outcome.user.userTraffic : undefined, null);
  });

  it('the live 3.2.1 capture of a connected user decodes as connected at its own first connection', async () => {
    // `connected-user.json` is the panel's own `user.first_connected` body.
    const captured = fixture('3.2.1/connected-user.json');
    const { service } = panelOn('3.2.1', { response: captured.response });

    const outcome = await service.getPanelUserOutcome(ERAS[0]!.ref);

    assert.equal(outcome.kind, 'ok');
    const traffic = outcome.kind === 'ok' ? outcome.user.userTraffic : undefined;
    assert.equal(traffic?.firstConnectedAt, '2026-08-10T12:56:15.010Z');
    assert.deepStrictEqual(connectEvidenceOf(traffic, new Date('2026-09-19T00:00:00.000Z')), {
      kind: 'connected',
      at: new Date('2026-08-10T12:56:15.010Z'),
    });
  });

  it('covers every contract the matrix above covers', () => {
    // Anchor: the loop is not empty, and no pinned release is left out.
    assert.equal(TRAFFIC_ERAS.length, CONTRACTS.length);
  });
});
