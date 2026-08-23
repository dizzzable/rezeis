/**
 * THE PANEL USER ROW, held against the vendor's own contracts — for EVERY panel
 * era rezeis ships to, not just the newest one.
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
 * WHY BOTH ERAS, AND WHY THAT IS THE POINT. rezeis ships to deployments whose
 * panels are still on 2.x, and to deployments on 3.x. Those operators upgrade on
 * their own schedule. So "supports the newest panel" is never a licence to
 * narrow: a decoder that satisfies 3.3.2 while silently breaking 2.x is exactly
 * the regression this repo must not ship again. Every claim below is therefore
 * made PER ERA.
 *
 * THE ANCHORS, all available in CI:
 *
 *   `@remnawave/backend-contract`  2.7.3  — the PRODUCTION dependency (runtime)
 *   `@remnawave/contract-v28`      2.8.35 — dev alias, the 2.8 line
 *   `@remnawave/contract-v3`       3.2.3  — dev alias, the 3.2 line
 *   `@remnawave/contract-v34`      3.4.2  — dev alias, exact pin, matches 3.3.2
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

import * as contractProd from '@remnawave/backend-contract';
import * as contractV28 from '@remnawave/contract-v28';
import * as contractV3 from '@remnawave/contract-v3';
import * as contractV34 from '@remnawave/contract-v34';
import { of } from 'rxjs';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
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
  /** Which panel era this contract line describes. */
  readonly era: '2.x' | '3.x';
}

const CONTRACTS: readonly ContractUnderTest[] = [
  {
    label: 'prod 2.7.3 (the RUNTIME dependency)',
    version: '2.7.3',
    era: '2.x',
    create: contractProd.CreateUserCommand as unknown as UserCommand,
    update: contractProd.UpdateUserCommand as unknown as UserCommand,
  },
  {
    label: 'v28 2.8.35',
    version: '2.8.35',
    era: '2.x',
    create: contractV28.CreateUserCommand as unknown as UserCommand,
    update: contractV28.UpdateUserCommand as unknown as UserCommand,
  },
  {
    label: 'v3 3.2.3',
    version: '3.2.3',
    era: '3.x',
    create: contractV3.CreateUserCommand as unknown as UserCommand,
    update: contractV3.UpdateUserCommand as unknown as UserCommand,
  },
  {
    label: 'v34 3.4.2 (exact pin for panel 3.3.2)',
    version: '3.4.2',
    era: '3.x',
    create: contractV34.CreateUserCommand as unknown as UserCommand,
    update: contractV34.UpdateUserCommand as unknown as UserCommand,
  },
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

const ROW_274 = fixture('2.7.4/created-user.json');
const ROW_280 = fixture('2.8.0/created-user.json');
const ROW_321 = fixture('3.2.1/user.json');
const ROW_332 = fixture('3.3.2/user.json');

/** What a contract does with a given era's row. Measured, then pinned here. */
type Verdict = 'accepts, uuid preserved' | 'accepts, uuid DISCARDED' | 'rejects: uuid required';

interface EraCase {
  readonly label: string;
  /** What `/api/system/stats/recap` reports, i.e. which era we are addressing. */
  readonly panelVersion: string;
  readonly row: PanelFixture;
  /** Which field the ROW itself says is its identity. */
  readonly identityField: 'uuid' | 'id';
  readonly expectedIdentity: string;
  readonly expectedPanelId: number;
  /** How an UPDATE names this profile, exactly as the row would hand it over. */
  readonly ref: string | { remnawaveId: string; panelId: number; panelUsername: string };
  /** Verdict per contract VERSION. Every contract must appear. */
  readonly verdicts: Readonly<Record<string, Verdict>>;
}

const ERAS: readonly EraCase[] = [
  {
    label: '2.7.4 (a shipped deployment still on the 2.7 line)',
    panelVersion: '2.7.4',
    row: ROW_274,
    identityField: 'uuid',
    expectedIdentity: '11111111-1111-4111-8111-111111111111',
    expectedPanelId: 4471,
    ref: '11111111-1111-4111-8111-111111111111',
    verdicts: {
      '2.7.3': 'accepts, uuid preserved',
      '2.8.35': 'accepts, uuid preserved',
      '3.2.3': 'accepts, uuid DISCARDED',
      '3.4.2': 'accepts, uuid DISCARDED',
    },
  },
  {
    label: '2.8.0 (a shipped deployment on the 2.8 line)',
    panelVersion: '2.8.0',
    row: ROW_280,
    identityField: 'uuid',
    expectedIdentity: '22222222-2222-4222-8222-222222222222',
    expectedPanelId: 8123,
    ref: '22222222-2222-4222-8222-222222222222',
    verdicts: {
      '2.7.3': 'accepts, uuid preserved',
      '2.8.35': 'accepts, uuid preserved',
      '3.2.3': 'accepts, uuid DISCARDED',
      '3.4.2': 'accepts, uuid DISCARDED',
    },
  },
  {
    label: '3.2.1 (verbatim live capture)',
    panelVersion: '3.2.3',
    row: ROW_321,
    identityField: 'id',
    expectedIdentity: '2',
    expectedPanelId: 2,
    ref: { remnawaveId: '2', panelId: 2, panelUsername: 'labuser1' },
    verdicts: {
      '2.7.3': 'rejects: uuid required',
      '2.8.35': 'rejects: uuid required',
      '3.2.3': 'accepts, uuid DISCARDED',
      '3.4.2': 'accepts, uuid DISCARDED',
    },
  },
  {
    label: "3.3.2 (the owner's panel, shape taken from its OpenAPI document)",
    panelVersion: '3.3.2',
    row: ROW_332,
    identityField: 'id',
    expectedIdentity: '7',
    expectedPanelId: 7,
    ref: { remnawaveId: '7', panelId: 7, panelUsername: 'rz_sub_332' },
    verdicts: {
      '2.7.3': 'rejects: uuid required',
      '2.8.35': 'rejects: uuid required',
      '3.2.3': 'accepts, uuid DISCARDED',
      '3.4.2': 'accepts, uuid DISCARDED',
    },
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
//  1. NO SINGLE CONTRACT CAN READ BOTH ERAS — the measured table
// ═══════════════════════════════════════════════════════════════════════════

/**
 * This table is the reason a single pinned runtime contract would be a DEFECT
 * rather than a fix, and the reason our hand-written decoder still exists.
 *
 *   • a 2.x contract REJECTS every 3.x row outright (`uuid` is required there);
 *   • a 3.x contract ACCEPTS a 2.x row and SILENTLY DISCARDS its `uuid`, because
 *     3.x declares no such field and zod strips unknown keys by default.
 *
 * The second is the more dangerous: it is the original defect arriving from the
 * other direction — a successful parse that quietly loses the identity.
 */
describe('no single vendor contract reads both panel eras', () => {
  for (const era of ERAS) {
    for (const contract of CONTRACTS) {
      const expected = era.verdicts[contract.version];

      it(`${era.label} through ${contract.label}: ${expected}`, () => {
        assert.ok(expected !== undefined, `no verdict recorded for ${contract.version}`);
        const body = { response: era.row.response };
        const parsed = contract.create.ResponseSchema.safeParse(body);

        if (expected === 'rejects: uuid required') {
          assert.equal(parsed.success, false, 'expected a rejection, got a successful parse');
          const issues = (parsed as { error: { issues: ReadonlyArray<{ path: unknown[] }> } }).error
            .issues;
          assert.ok(issues.length > 0, 'rejected with no issues — cannot confirm the reason');
          assert.ok(
            issues.some((i) => i.path.join('.') === 'response.uuid'),
            `rejected, but not for the uuid: ${JSON.stringify(issues.map((i) => i.path.join('.')))}`,
          );
          return;
        }

        assert.equal(parsed.success, true, 'expected a successful parse, got a rejection');
        const out = (parsed as { data: { response: Record<string, unknown> } }).data.response;
        const kept = Object.prototype.hasOwnProperty.call(out, 'uuid');

        if (expected === 'accepts, uuid preserved') {
          assert.equal(kept, true, 'the contract dropped a uuid it declares');
          assert.equal(out['uuid'], era.row.response['uuid']);
          return;
        }

        // 'accepts, uuid DISCARDED'
        assert.equal(kept, false, 'the contract preserved a uuid — this verdict is stale');
        // Only meaningful when the row HAD one to lose.
        if (era.identityField === 'uuid') {
          assert.equal(
            typeof era.row.response['uuid'],
            'string',
            'precondition: this era\'s row carries a uuid',
          );
        }
      });
    }
  }

  it('the table covers every contract for every era — no era silently skipped', () => {
    for (const era of ERAS) {
      const covered = Object.keys(era.verdicts).sort();
      const all = CONTRACTS.map((c) => c.version).sort();
      assert.deepStrictEqual(covered, all, `${era.label} does not name every contract`);
    }
    // Anchor: the matrix is not empty.
    assert.equal(ERAS.length, 4);
    assert.equal(CONTRACTS.length, 4);
  });

  it('at least one era is REJECTED by the 2.x line and one loses its uuid to the 3.x line', () => {
    // Without this, the table above could degenerate to "everything accepts
    // everything" and still pass its own assertions.
    const rejections = ERAS.flatMap((e) =>
      Object.entries(e.verdicts).filter(([, v]) => v === 'rejects: uuid required'),
    );
    const losses = ERAS.filter((e) => e.identityField === 'uuid').flatMap((e) =>
      Object.entries(e.verdicts).filter(([, v]) => v === 'accepts, uuid DISCARDED'),
    );
    assert.ok(rejections.length > 0, 'no era is rejected by any contract — the table is toothless');
    assert.ok(losses.length > 0, 'no 2.x row loses its uuid to a 3.x contract — table is toothless');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. OUR DECODER READS EVERY ERA CORRECTLY
// ═══════════════════════════════════════════════════════════════════════════

describe('our decoder keys every era by what the ROW says its identity is', () => {
  for (const era of ERAS) {
    it(`${era.label}: CREATE yields the identity the link path persists`, async () => {
      const { service } = panelOn(era.panelVersion, era.row);

      const created = await service.createPanelUser(createInput('rz_sub'));

      assert.equal(created.uuid, era.expectedIdentity);
      assert.equal(created.panelId, era.expectedPanelId);
      if (era.identityField === 'uuid') {
        assert.equal(created.uuid, era.row.response['uuid']);
        assert.notEqual(
          created.uuid,
          String(era.row.response['id']),
          'a 2.x row must NOT be keyed by its numeric id',
        );
      } else {
        assert.equal(created.uuid, String(era.row.response['id']));
        assert.equal('uuid' in era.row.response, false);
      }
    });

    it(`${era.label}: PATCH decodes the same body to the same identity`, async () => {
      const { service } = panelOn(era.panelVersion, era.row);

      const updated = await service.updatePanelUser(era.ref, { description: 'reiwa_id: user-1' });

      assert.equal(updated.uuid, era.expectedIdentity);
      assert.equal(updated.panelId, era.expectedPanelId);
    });
  }

  it('the 2.x eras and the 3.x eras really do differ in identity field', () => {
    // Anchor for the loop above: if every era were 'id', the uuid branch would
    // never execute and the loop would prove nothing about 2.x.
    const byField = new Set(ERAS.map((e) => e.identityField));
    assert.deepStrictEqual([...byField].sort(), ['id', 'uuid']);
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

  it('the 3.4.2 SDK and the 3.3.2 document agree with each other — the pin is right', () => {
    const sdk = [...declaredRowKeys(contractByVersion('3.4.2'))].sort();
    const spec = [...(ROW_332.specRequired as readonly string[])].sort();
    assertKeySetsAgree(sdk, spec, 'the 3.4.2 SDK vs the 3.3.2 OpenAPI document');
  });

  it('the 2.x contracts declare exactly one field more, and it is the uuid', () => {
    const threeX = new Set(declaredRowKeys(contractByVersion('3.4.2')));
    for (const version of ['2.7.3', '2.8.35']) {
      const twoX = declaredRowKeys(contractByVersion(version));
      const extra = twoX.filter((k) => !threeX.has(k)).sort();
      assert.deepStrictEqual(extra, ['uuid'], `${version} differs from 3.x by more than the uuid`);
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
    // `uuid` MUST stay known. Deployments on 2.x panels are live, and our own
    // database holds uuids recorded in that era; dropping the ability to read
    // them would strand paying customers permanently.
    assert.ok(PANEL_USER_KNOWN_ROW_KEYS.includes('uuid'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. A DAMAGED uuid IS UNDECODABLE — NEVER SILENTLY RE-KEYED
// ═══════════════════════════════════════════════════════════════════════════

describe('a 2.x row whose uuid arrived damaged stays UNDECODABLE', () => {
  /**
   * The test is ABSENCE of the field, not emptiness of it:
   *   • no `uuid` key at all  → a 3.x row; key it by the numeric id.
   *   • `uuid` present but unusable → a 2.x row that arrived damaged. Keying it
   *     by its numeric id would mint a key matching no `remnawaveId` ever stored
   *     from that era, turning "we could not read this row" into "this user is
   *     unknown to us" — and the callers that act on absence would act.
   */
  const DAMAGED: ReadonlyArray<readonly [string, unknown]> = [
    ['an empty string', ''],
    ['a number', 12345],
    ['null', null],
    ['an object', {}],
  ];

  for (const [label, badUuid] of DAMAGED) {
    it(`POST refuses a row whose uuid is ${label} — no fallback to the numeric id`, async () => {
      const row: Record<string, unknown> = { ...ROW_274.response, uuid: badUuid };
      // The numeric id is present and perfectly usable. Refusing anyway is the
      // whole point: this row must not be re-keyed onto 3.x terms.
      assert.equal(typeof row['id'], 'number');
      const { service } = panelOn('2.7.4', { response: row });

      await assert.rejects(
        () => service.createPanelUser(createInput('rz_sub_1')),
        (err: unknown) => {
          assert.match((err as Error).message, /POST \/api\/users/);
          assert.match((err as Error).message, /no usable identity/);
          return true;
        },
      );
    });

    it(`PATCH refuses it too, and NOT as a transient failure`, async () => {
      const row = { ...ROW_274.response, uuid: badUuid };
      const { service } = panelOn('2.7.4', { response: row });

      await assert.rejects(
        () => service.updatePanelUser('11111111-1111-4111-8111-111111111111', { description: 'x' }),
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

  it('a genuinely ABSENT uuid is not damaged — the distinction is load-bearing', async () => {
    // The same row, uuid REMOVED rather than emptied. This must decode.
    const row = { ...ROW_274.response };
    delete (row as Record<string, unknown>)['uuid'];
    const { service } = panelOn('3.3.2', { response: row });

    const created = await service.createPanelUser(createInput('rz_sub_1'));

    assert.equal(created.uuid, String(ROW_274.response['id']));
    assert.equal(created.panelId, ROW_274.response['id']);
  });

  /**
   * DIVERGENCE — NAMED EXCEPTION.
   *
   * Every 3.x contract ACCEPTS all four damaged rows above, because 3.x declares
   * no `uuid` at all and a stray key of any type is simply stripped. The
   * contract cannot express "this row is damaged"; it has no vocabulary for a
   * field it does not know exists.
   *
   * Our decoder is right and the contract is not wrong — it is SILENT. This is
   * recorded so that "the vendor accepts it" is never mistaken for "the vendor
   * agrees it is fine".
   */
  it('DIVERGENCE: every 3.x contract accepts each damaged row we refuse', () => {
    for (const contract of CONTRACTS.filter((c) => c.era === '3.x')) {
      for (const [label, badUuid] of DAMAGED) {
        const row = { ...ROW_274.response, uuid: badUuid };
        const parsed = contract.create.ResponseSchema.safeParse({ response: row });
        assert.equal(
          parsed.success,
          true,
          `${contract.label} unexpectedly rejected the ${label} case`,
        );
        const out = (parsed as { data: { response: Record<string, unknown> } }).data.response;
        assert.equal(
          Object.prototype.hasOwnProperty.call(out, 'uuid'),
          false,
          `${contract.label} preserved the damaged uuid for ${label} — divergence is stale`,
        );
      }
    }
  });

  /**
   * DIVERGENCE — NAMED EXCEPTION, the other direction.
   *
   * The 2.x contracts REJECT a damaged uuid, and so do we. We agree on the
   * outcome for a different reason (they type-check a declared field; we refuse
   * to re-key), and that agreement is worth pinning: if a 2.x contract ever
   * started tolerating an empty uuid, our stricter behaviour would become the
   * only thing standing between a damaged row and a wrong identity.
   */
  it('the 2.x contracts also refuse a damaged uuid — we agree, for our own reason', () => {
    for (const contract of CONTRACTS.filter((c) => c.era === '2.x')) {
      const row = { ...ROW_274.response, uuid: 12345 };
      const parsed = contract.create.ResponseSchema.safeParse({ response: row });
      assert.equal(parsed.success, false, `${contract.label} accepted a numeric uuid`);
    }
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
  userTraffic: 'usage is read through the dedicated usage call, not the write response',
};

/**
 * Fields our decoder reads that panel 3.x does not declare. Both are legacy
 * tolerances and both must survive.
 */
const READ_BUT_NOT_DECLARED_BY_3X: Readonly<Record<string, string>> = {
  uuid: '2.x identity spelling; deployments on 2.x panels are live and send it',
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
  async function observedReadSet(): Promise<Set<string>> {
    const { proxy, reads } = recordingRow({ ...ROW_332.response });
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

  it('the decoder reads the 2.x uuid when the row carries one', async () => {
    // The exception list above is only honest if `uuid` is genuinely read on a
    // 2.x row rather than merely probed on a 3.x one.
    const { proxy, reads } = recordingRow({ ...ROW_274.response });
    const { service } = panelOn('2.7.4', { response: proxy });

    const created = await service.createPanelUser(createInput('rz_sub_1'));

    assert.ok(reads.has('uuid'));
    assert.equal(created.uuid, ROW_274.response['uuid']);
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
 * With multiple eras in the field, "the panel started answering differently" is
 * a routine event rather than an exception — which is exactly why the detector
 * must REPORT and never REJECT. A panel patch release that adds a field must not
 * become an outage.
 */
describe('runtime shape drift is detected and reported on a live panel', () => {
  it('a conformant 3.3.2 row raises nothing at all', async () => {
    const { service, events } = panelOn('3.3.2', ROW_332);

    await service.createPanelUser(createInput('rz_sub_332'));

    assert.deepStrictEqual(events, [], 'the detector cried wolf on a conformant panel');
  });

  for (const era of ERAS) {
    it(`${era.label}: a conformant row of this era raises nothing`, async () => {
      const { service, events } = panelOn(era.panelVersion, era.row);

      await service.createPanelUser(createInput('rz_sub'));

      assert.deepStrictEqual(
        events.map((e) => e.message),
        [],
        'a conformant row of a shipped era was reported as drift',
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
    // Damaged uuid: the decode is refused, but the operator still needs to see
    // what the panel actually sent.
    const row = { ...ROW_274.response, uuid: '', mysteryField: 1 };
    const { service, events } = panelOn('2.7.4', { response: row });

    await assert.rejects(() => service.createPanelUser(createInput('rz_sub_1')));

    assert.equal(events.length, 1, 'an undecodable row reported no shape');
    assert.deepStrictEqual(events[0].metadata['unknownFields'], ['mysteryField']);
  });

  it('the reported signal NAMES THE DETECTED ERA', async () => {
    // Two operators, same field drift, different panel eras. Their reports must
    // be distinguishable — otherwise a 2.x report and a 3.x report look
    // identical in the feed and neither can be acted on.
    //
    // Driven through UPDATE rather than CREATE because update resolves the panel
    // segment first, which warms the shape cache — as every read path does in
    // production. The cold-CREATE case is asserted separately below, because it
    // reports something different and that difference is deliberate.
    const threeX = panelOn('3.3.2', { response: { ...ROW_332.response, mystery: 1 } });
    await threeX.service.updatePanelUser(
      { remnawaveId: '7', panelId: 7, panelUsername: 'rz_sub_332' },
      { description: 'x' },
    );

    const twoX = panelOn('2.7.4', { response: { ...ROW_274.response, mystery: 1 } });
    await twoX.service.updatePanelUser('11111111-1111-4111-8111-111111111111', {
      description: 'x',
    });

    assert.equal(threeX.events.length, 1);
    assert.equal(twoX.events.length, 1);
    assert.equal(threeX.events[0].metadata['panelEra'], '3.x');
    assert.equal(twoX.events[0].metadata['panelEra'], '2.x');
    assert.equal(threeX.events[0].metadata['panelVersion'], '3.3.2');
    assert.equal(twoX.events[0].metadata['panelVersion'], '2.7.4');
    assert.notEqual(
      threeX.events[0].metadata['signature'],
      twoX.events[0].metadata['signature'],
      'the same field drift on two different eras produced the same signature',
    );
    assert.match(threeX.events[0].message, /3\.x/);
    assert.match(twoX.events[0].message, /2\.x/);
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
  it('returns null for a conformant row of every shipped era', () => {
    for (const era of ERAS) {
      assert.equal(
        describePanelUserShapeDrift(era.row.response),
        null,
        `${era.label} was reported as drift`,
      );
    }
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
