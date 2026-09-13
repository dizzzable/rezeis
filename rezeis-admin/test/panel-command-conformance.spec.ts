import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import * as contractPanel321 from '@remnawave/contract-panel-3.2.1';
import * as contractPanel323 from '@remnawave/contract-panel-3.2.3';
import * as contractPanel33 from '@remnawave/contract-panel-3.3';
import * as contractPanel343 from '@remnawave/contract-panel-3.4.3';
import * as contractPanel344 from '@remnawave/contract-panel-3.4.4';
import * as ts from 'typescript';

import type { PanelCommand } from '../src/modules/remnawave/services/panel-command.contract';
import { PANEL_COMMANDS } from '../src/modules/remnawave/services/panel-commands';

/**
 * THE HAND-OWNED COMMAND TABLE, held to every 3.x panel release in the fleet
 * ══════════════════════════════════════════════════════════════════════════
 * `panel-commands.ts` owns the routes, verbs and request rules of the twenty-one
 * commands rezeis issues, so no vendor package has to ship in the runtime image.
 * This spec is what makes owning them safe: every entry is compared with the
 * contract each panel release actually ships — per the vendor's own table at
 * https://docs.rw/sdk/typescript-sdk/ — on
 *
 *   • the URL a builder produces for sample segments (and string vs builder);
 *   • the verb;
 *   • which request schemas exist;
 *   • the accept/refuse VERDICT on a corpus of accepted and refused inputs, and
 *     for an accepted body the PARSED OUTPUT, byte for byte — because the
 *     executor sends the parsed body, a default or a key order that drifts is a
 *     wire change even when every verdict still agrees.
 *
 * Every corpus case names its expected verdict, and the table, the vendor and
 * the case must all agree. A case only the table gets wrong fails; so does a
 * case the vendor changes in a later era. The one place two eras legitimately
 * disagree is recorded as a named exception, and the number of exceptions is
 * pinned so a new one cannot slip in quietly.
 *
 * It also guards the boundary that made the table necessary: `src/` imports no
 * `@remnawave/*` package, by value or by type, and the production dependency
 * tree contains none.
 */

// ── The eras ────────────────────────────────────────────────────────────────

type Verdict = 'accept' | 'refuse';

interface VendorSchema {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

interface VendorCommand {
  readonly url: string | ((segment: string) => string);
  readonly endpointDetails: { readonly REQUEST_METHOD: string };
  readonly RequestBodySchema?: VendorSchema;
  readonly RequestParamSchema?: VendorSchema;
  readonly RequestQuerySchema?: VendorSchema;
}

interface Era {
  /** The panel releases that ship this contract, per the vendor's own table. */
  readonly panels: string;
  /** The devDependency alias, named by panel release. */
  readonly alias: string;
  /** The backend-contract version that alias must resolve to. */
  readonly contract: string;
  readonly module: Readonly<Record<string, unknown>>;
}

const ERAS: readonly Era[] = [
  { panels: '3.2.0–3.2.1', alias: '@remnawave/contract-panel-3.2.1', contract: '3.2.0', module: contractPanel321 },
  { panels: '3.2.3', alias: '@remnawave/contract-panel-3.2.3', contract: '3.2.3', module: contractPanel323 },
  { panels: '3.3.0–3.3.2', alias: '@remnawave/contract-panel-3.3', contract: '3.4.2', module: contractPanel33 },
  { panels: '3.4.0–3.4.3', alias: '@remnawave/contract-panel-3.4.3', contract: '3.4.13', module: contractPanel343 },
  { panels: '3.4.4', alias: '@remnawave/contract-panel-3.4.4', contract: '3.4.15', module: contractPanel344 },
];

function vendorCommand(era: Era, name: string): VendorCommand {
  const command = era.module[name];
  assert.ok(
    command !== null && typeof command === 'object',
    `contract ${era.contract} (panel ${era.panels}) exports no ${name}`,
  );
  return command as VendorCommand;
}

const OURS: Readonly<Record<string, PanelCommand>> = PANEL_COMMANDS;

/** The commands production reaches — the table must hold exactly these. */
const PRODUCTION_COMMANDS = [
  'ConnectionsByNodeCommand',
  'ConnectionsByNodeResultCommand',
  'ConnectionsByUserCommand',
  'ConnectionsByUserResultCommand',
  'CreateUserCommand',
  'DeleteUserCommand',
  'DropConnectionsCommand',
  'GetExternalSquadsCommand',
  'GetHwidDevicesCommand',
  'GetHwidDevicesStatsCommand',
  'GetInternalSquadsCommand',
  'GetMetadataCommand',
  'GetNodesCommand',
  'GetStatsNodesUsersUsageCommand',
  'GetSubscriptionRequestHistoryCommand',
  'GetTopUsersByHwidDevicesCommand',
  'GetUserByIdCommand',
  'GetUserByUsernameCommand',
  'ResetUserTrafficCommand',
  'ResolveUserCommand',
  'UpdateUserCommand',
] as const;

describe('the oracles are the contracts the panel releases ship', () => {
  it('every era alias resolves to the contract version the vendor table names', () => {
    for (const era of ERAS) {
      const manifest = JSON.parse(
        readFileSync(require.resolve(`${era.alias}/package.json`), 'utf8'),
      ) as { name: string; version: string };
      assert.equal(manifest.name, '@remnawave/backend-contract', era.alias);
      assert.equal(
        manifest.version,
        era.contract,
        `${era.alias} must be backend-contract ${era.contract} — the contract panel ${era.panels} ships`,
      );
    }
    // Anchor: five 3.x eras, not an empty loop.
    assert.equal(ERAS.length, 5);
  });

  it('the table holds exactly the twenty-one production commands', () => {
    assert.deepStrictEqual(Object.keys(OURS).sort(), [...PRODUCTION_COMMANDS].sort());
  });
});

// ── Routes and verbs ────────────────────────────────────────────────────────

const SEGMENTS = ['4471', 'job-7', 'rz_sub%2Fx', '7aa64e53-f5da-4366-9760-0fdad1497a28'];

describe('every route and verb matches every era', () => {
  for (const name of PRODUCTION_COMMANDS) {
    it(`${name}: url and method`, () => {
      const ours = OURS[name] as PanelCommand;
      for (const era of ERAS) {
        const theirs = vendorCommand(era, name);
        const where = `${name} vs contract ${era.contract} (panel ${era.panels})`;
        assert.equal(typeof ours.url, typeof theirs.url, `${where}: builder vs constant`);
        if (typeof ours.url === 'string') {
          assert.equal(ours.url, theirs.url, `${where}: url`);
        } else {
          const builder = theirs.url as (segment: string) => string;
          for (const segment of SEGMENTS) {
            assert.equal(ours.url(segment), builder(segment), `${where}: url(${segment})`);
          }
        }
        assert.equal(ours.method, theirs.endpointDetails.REQUEST_METHOD, `${where}: method`);
      }
    });
  }
});

// ── Which request schemas exist ─────────────────────────────────────────────

/**
 * Queries the vendor declares and the table deliberately does not, because the
 * client has never validated them. The queries production sends are checked
 * against every era below instead.
 */
const UNVALIDATED_QUERIES = new Set(['GetStatsNodesUsersUsageCommand', 'GetSubscriptionRequestHistoryCommand']);

describe('the table declares the same request schemas as every era', () => {
  for (const name of PRODUCTION_COMMANDS) {
    it(`${name}: body / params / query`, () => {
      const ours = OURS[name] as PanelCommand;
      for (const era of ERAS) {
        const theirs = vendorCommand(era, name);
        const where = `${name} vs contract ${era.contract}`;
        assert.equal(ours.body !== undefined, theirs.RequestBodySchema !== undefined, `${where}: body`);
        assert.equal(ours.params !== undefined, theirs.RequestParamSchema !== undefined, `${where}: params`);
        if (UNVALIDATED_QUERIES.has(name)) {
          assert.equal(ours.query, undefined, `${where}: this query is deliberately not validated`);
          assert.notEqual(theirs.RequestQuerySchema, undefined, `${where}: the vendor dropped a query`);
        } else {
          assert.equal(ours.query !== undefined, theirs.RequestQuerySchema !== undefined, `${where}: query`);
        }
      }
    });
  }
});

// ── Verdicts ────────────────────────────────────────────────────────────────

type SchemaKey = 'body' | 'params' | 'query';

const VENDOR_KEY: Readonly<Record<SchemaKey, keyof VendorCommand>> = {
  body: 'RequestBodySchema',
  params: 'RequestParamSchema',
  query: 'RequestQuerySchema',
};

interface Case {
  readonly command: (typeof PRODUCTION_COMMANDS)[number];
  readonly schema: SchemaKey;
  readonly label: string;
  readonly input: unknown;
  readonly expect: Verdict;
  /** Eras that legitimately answer otherwise, by contract version, with the reason. */
  readonly eraExceptions?: { readonly verdicts: Readonly<Record<string, Verdict>>; readonly reason: string };
}

const U1 = '2f1c9a44-0000-4000-8000-000000000001';
const U2 = '7aa64e53-f5da-4366-9760-0fdad1497a28';
const DAY = 24 * 60 * 60 * 1000;
// Anchored to now, so neither can quietly change side as the calendar moves.
const FUTURE_ISO = new Date(Date.now() + 365 * DAY).toISOString();
const PAST_ISO = new Date(Date.now() - 2 * DAY).toISOString();

function cases(
  command: Case['command'],
  schema: SchemaKey,
  rows: ReadonlyArray<readonly [label: string, expect: Verdict, input: unknown]>,
): Case[] {
  return rows.map(([label, expect, input]) => ({ command, schema, label, input, expect }));
}

const USER_ID_PARAMS: ReadonlyArray<readonly [string, Verdict, unknown]> = [
  ['a real id', 'accept', { userId: 4471 }],
  ['a decimal string (coerced)', 'accept', { userId: '4471' }],
  ['a fraction (the client refuses it separately)', 'accept', { userId: 4471.5 }],
  ['zero', 'refuse', { userId: 0 }],
  ['negative', 'refuse', { userId: -7 }],
  ['NaN — Number() of a 2.x uuid', 'refuse', { userId: Number.NaN }],
  ['undefined — a resolve that answered no id', 'refuse', { userId: undefined }],
  ['null', 'refuse', { userId: null }],
  ['a uuid string', 'refuse', { userId: U1 }],
  ['absent', 'refuse', {}],
];

const JOB_ID_PARAMS: ReadonlyArray<readonly [string, Verdict, unknown]> = [
  ['a job id', 'accept', { jobId: 'job-9' }],
  ['an empty job id', 'accept', { jobId: '' }],
  ['a numeric job id', 'refuse', { jobId: 9 }],
  ['absent', 'refuse', {}],
];

const CREATE_FULL = {
  username: 'rz_sub_4471',
  telegramId: 813364774,
  email: 'buyer@example.com',
  description: 'name: Buyer\nreiwa_id: user-1',
  tag: 'PLAN_X',
  expireAt: FUTURE_ISO,
  trafficLimitBytes: 53687091200,
  hwidDeviceLimit: 3,
  trafficLimitStrategy: 'MONTH',
  activeInternalSquads: [U1, U2],
  externalSquadUuid: U2,
};

const CORPUS: readonly Case[] = [
  // ── params ──
  ...cases('GetUserByIdCommand', 'params', USER_ID_PARAMS),
  ...cases('DeleteUserCommand', 'params', USER_ID_PARAMS),
  ...cases('ResetUserTrafficCommand', 'params', USER_ID_PARAMS),
  ...cases('ConnectionsByUserCommand', 'params', USER_ID_PARAMS),
  ...cases('GetUserByUsernameCommand', 'params', [
    ['a panel username', 'accept', { username: 'rz_sub_4471' }],
    ['an encoded name with a slash', 'accept', { username: 'rz%2Fsub%3Fx' }],
    ['an empty name (the client refuses it separately)', 'accept', { username: '' }],
    ['a number', 'refuse', { username: 4471 }],
    ['absent', 'refuse', {}],
  ]),
  ...cases('ConnectionsByUserResultCommand', 'params', JOB_ID_PARAMS),
  ...cases('ConnectionsByNodeResultCommand', 'params', JOB_ID_PARAMS),
  ...cases('ConnectionsByNodeCommand', 'params', [
    ['a v4 uuid', 'accept', { nodeUuid: U2 }],
    ['the nil uuid', 'accept', { nodeUuid: '00000000-0000-0000-0000-000000000000' }],
    ['a node name', 'refuse', { nodeUuid: 'node-3' }],
    ['a uuid one character short', 'refuse', { nodeUuid: U2.slice(0, -1) }],
    ['a uuid with version 0', 'refuse', { nodeUuid: '7aa64e53-f5da-0366-9760-0fdad1497a28' }],
    ['absent', 'refuse', {}],
  ]),

  // ── queries ──
  ...cases('GetHwidDevicesCommand', 'query', [
    ['the first full page', 'accept', { start: 0, size: 1000 }],
    ['a later full page', 'accept', { start: 1000, size: 1000 }],
    ['nothing — the defaults', 'accept', {}],
    ['strings (coerced)', 'accept', { start: '5', size: '10' }],
    ['one over the ceiling', 'refuse', { start: 0, size: 1001 }],
    ['zero rows', 'refuse', { start: 0, size: 0 }],
    ['a start that is not a number', 'refuse', { start: 'x', size: 10 }],
    ['a size that is NaN', 'refuse', { start: 0, size: Number.NaN }],
  ]),
  ...cases('GetTopUsersByHwidDevicesCommand', 'query', [
    ['the first full page', 'accept', { start: 0, size: 100 }],
    ['nothing — the defaults', 'accept', {}],
    ['one over the ceiling', 'refuse', { start: 0, size: 101 }],
    ['zero rows', 'refuse', { start: 100, size: 0 }],
  ]),

  // ── bodies ──
  ...cases('CreateUserCommand', 'body', [
    ['every field production sends', 'accept', CREATE_FULL],
    [
      'a blocked owner with no strategy, no tag and no contacts',
      'accept',
      { ...CREATE_FULL, status: 'DISABLED', trafficLimitStrategy: undefined, tag: null, telegramId: null, email: null, activeInternalSquads: [], externalSquadUuid: null },
    ],
    ['only what is required', 'accept', { username: 'abc', expireAt: FUTURE_ISO }],
    ['an expiry in the past — create does not check it', 'accept', { username: 'abc', expireAt: PAST_ISO }],
    ['an offset expiry', 'accept', { username: 'abc', expireAt: '2099-10-13T09:15:00+03:00' }],
    ['a zone-less expiry', 'accept', { username: 'abc', expireAt: '2099-10-13T09:15:00' }],
    ['a two-character username', 'refuse', { username: 'ab', expireAt: FUTURE_ISO }],
    ['a 37-character username', 'refuse', { username: 'a'.repeat(37), expireAt: FUTURE_ISO }],
    ['a username with a space', 'refuse', { username: 'rz sub', expireAt: FUTURE_ISO }],
    ['no expiry', 'refuse', { username: 'abc' }],
    ['a date without a time', 'refuse', { username: 'abc', expireAt: '2099-10-13' }],
    ['trafficLimitStrategy: null — never nullable', 'refuse', { ...CREATE_FULL, trafficLimitStrategy: null }],
    ['description: null — not nullable on create', 'refuse', { ...CREATE_FULL, description: null }],
    ['a lowercase tag', 'refuse', { ...CREATE_FULL, tag: 'plan_x' }],
    ['a 17-character tag', 'refuse', { ...CREATE_FULL, tag: 'A'.repeat(17) }],
    ['an email that is not one', 'refuse', { ...CREATE_FULL, email: 'not-an-email' }],
    ['a negative device limit', 'refuse', { ...CREATE_FULL, hwidDeviceLimit: -1 }],
    ['a fractional device limit', 'refuse', { ...CREATE_FULL, hwidDeviceLimit: 1.5 }],
    ['a negative traffic limit', 'refuse', { ...CREATE_FULL, trafficLimitBytes: -1 }],
    ['a squad that is not a uuid', 'refuse', { ...CREATE_FULL, activeInternalSquads: ['not-a-uuid'] }],
    ['an external squad that is not a uuid', 'refuse', { ...CREATE_FULL, externalSquadUuid: 'squad' }],
    ['a telegram id as a string', 'refuse', { ...CREATE_FULL, telegramId: '813364774' }],
    ['a status the panel does not have', 'refuse', { ...CREATE_FULL, status: 'BANNED' }],
  ]),
  {
    command: 'CreateUserCommand',
    schema: 'body',
    label: 'an expiry with Z and no seconds',
    input: { username: 'abc', expireAt: '2099-10-13T09:15Z' },
    expect: 'refuse',
    eraExceptions: {
      verdicts: { '3.2.0': 'accept', '3.2.3': 'accept', '3.4.2': 'accept' },
      reason:
        'zod 4.5 requires seconds in a datetime carrying Z or an offset; contracts up to 3.4.11 run ' +
        'zod 4.4.3 and accept it, contracts from 3.4.12 run 4.5.4 and refuse it, as does this table. ' +
        'Production sends toISOString(), which always has seconds.',
    },
  },
  ...cases('UpdateUserCommand', 'body', [
    ['addressed by id', 'accept', { id: 4471 }],
    ['addressed by username', 'accept', { username: 'rz_sub_4471' }],
    [
      'the desired-state write',
      'accept',
      { id: 4471, trafficLimitBytes: 0, hwidDeviceLimit: 0, tag: null, trafficLimitStrategy: 'NO_RESET', activeInternalSquads: [U1], externalSquadUuid: null },
    ],
    [
      'the absolute update',
      'accept',
      { id: 4471, telegramId: null, email: null, description: 'x', status: 'ACTIVE', tag: 'T', expireAt: FUTURE_ISO, trafficLimitBytes: 1073741824, hwidDeviceLimit: 2, activeInternalSquads: [U1, U2], externalSquadUuid: null },
    ],
    ['an absolute update with no end date', 'accept', { id: 4471, expireAt: undefined, description: 'x' }],
    ['a device limit of null — nullable on update', 'accept', { id: 4471, hwidDeviceLimit: null }],
    ['no identity — the old { uuid } body', 'refuse', { uuid: U1, tag: 'T' }],
    ['id 0 — falsy is not an identity', 'refuse', { id: 0 }],
    ['an empty username — falsy is not an identity', 'refuse', { username: '' }],
    ['an expiry in the past', 'refuse', { id: 4471, expireAt: PAST_ISO }],
    ['a status update cannot set', 'refuse', { id: 4471, status: 'EXPIRED' }],
    ['trafficLimitStrategy: null', 'refuse', { id: 4471, trafficLimitStrategy: null }],
    ['a negative device limit', 'refuse', { id: 4471, hwidDeviceLimit: -1 }],
    ['an id as a string', 'refuse', { id: '4471' }],
    ['an email that is not one', 'refuse', { id: 4471, email: 'not-an-email' }],
  ]),
  ...cases('ResolveUserCommand', 'body', [
    ['by id', 'accept', { id: 4471 }],
    ['by username', 'accept', { username: 'rz_sub_4471' }],
    ['by short uuid', 'accept', { shortUuid: 'PyTr7C5568QuLhup' }],
    ['nothing', 'refuse', {}],
    ['two keys', 'refuse', { id: 4471, username: 'rz_sub_4471' }],
    ['an id as a string', 'refuse', { id: '4471' }],
    ['an id of null', 'refuse', { id: null }],
  ]),
  ...cases('DropConnectionsCommand', 'body', [
    ['by user ids, everywhere', 'accept', { dropBy: { by: 'userIds', userIds: [4471, 4472] }, targetNodes: { target: 'allNodes' } }],
    ['by IPv4 and IPv6, everywhere', 'accept', { dropBy: { by: 'ipAddresses', ipAddresses: ['203.0.113.7', '2001:db8::1'] }, targetNodes: { target: 'allNodes' } }],
    ['on specific nodes', 'accept', { dropBy: { by: 'userIds', userIds: [1] }, targetNodes: { target: 'specificNodes', nodeUuids: [U2] } }],
    ['the 2.x userUuids arm', 'refuse', { dropBy: { by: 'userUuids', userUuids: [U1] }, targetNodes: { target: 'allNodes' } }],
    ['no user ids', 'refuse', { dropBy: { by: 'userIds', userIds: [] }, targetNodes: { target: 'allNodes' } }],
    ['no addresses', 'refuse', { dropBy: { by: 'ipAddresses', ipAddresses: [] }, targetNodes: { target: 'allNodes' } }],
    ['an address that is not one', 'refuse', { dropBy: { by: 'ipAddresses', ipAddresses: ['999.1.1.1'] }, targetNodes: { target: 'allNodes' } }],
    ['user ids as strings', 'refuse', { dropBy: { by: 'userIds', userIds: ['4471'] }, targetNodes: { target: 'allNodes' } }],
    ['specific nodes, none named', 'refuse', { dropBy: { by: 'userIds', userIds: [1] }, targetNodes: { target: 'specificNodes', nodeUuids: [] } }],
    ['specific nodes named by name', 'refuse', { dropBy: { by: 'userIds', userIds: [1] }, targetNodes: { target: 'specificNodes', nodeUuids: ['node-3'] } }],
    ['no target', 'refuse', { dropBy: { by: 'userIds', userIds: [1] } }],
  ]),
  ...cases('GetStatsNodesUsersUsageCommand', 'body', [
    ['one node', 'accept', { nodesUuids: [U2] }],
    ['no nodes', 'refuse', { nodesUuids: [] }],
    ['a node by name', 'refuse', { nodesUuids: ['node-3'] }],
    ['absent', 'refuse', {}],
  ]),
];

/** A parse result rendered the way the wire renders it: `Date` through `toJSON`. */
function wireForm(data: unknown): string {
  return JSON.stringify(data);
}

describe('every request rule matches every era on the corpus', () => {
  it('every schema the table declares has corpus cases, accepted AND refused', () => {
    for (const name of PRODUCTION_COMMANDS) {
      const ours = OURS[name] as PanelCommand;
      for (const schema of ['body', 'params', 'query'] as const) {
        if (ours[schema] === undefined) continue;
        const own = CORPUS.filter((c) => c.command === name && c.schema === schema);
        assert.ok(own.some((c) => c.expect === 'accept'), `${name}.${schema}: no accepted case`);
        assert.ok(own.some((c) => c.expect === 'refuse'), `${name}.${schema}: no refused case`);
      }
    }
  });

  it('the recorded era exceptions are exactly the one zod-minor divergence', () => {
    // Pinned so an exception cannot be added to make a real drift pass.
    assert.deepStrictEqual(
      CORPUS.filter((c) => c.eraExceptions !== undefined).map((c) => `${c.command}: ${c.label}`),
      ['CreateUserCommand: an expiry with Z and no seconds'],
    );
  });

  for (const testCase of CORPUS) {
    it(`${testCase.command}.${testCase.schema} — ${testCase.label}: ${testCase.expect}`, () => {
      const ourSchema = (OURS[testCase.command] as PanelCommand)[testCase.schema];
      assert.ok(ourSchema !== undefined, `${testCase.command} declares no ${testCase.schema} schema`);
      const ours = ourSchema.safeParse(testCase.input);
      assert.equal(
        ours.success ? 'accept' : 'refuse',
        testCase.expect,
        `the table's verdict on "${testCase.label}"`,
      );

      for (const era of ERAS) {
        const theirSchema = vendorCommand(era, testCase.command)[VENDOR_KEY[testCase.schema]] as
          | VendorSchema
          | undefined;
        assert.ok(theirSchema !== undefined, `contract ${era.contract} has no ${testCase.schema} schema`);
        const theirs = theirSchema.safeParse(testCase.input);
        const expected = testCase.eraExceptions?.verdicts[era.contract] ?? testCase.expect;
        assert.equal(
          theirs.success ? 'accept' : 'refuse',
          expected,
          `contract ${era.contract} (panel ${era.panels}) on "${testCase.label}"`,
        );
        // What is SENT is the parsed body, so an accepted body must also PARSE to
        // the same wire form: the same defaults, the same key order, the same
        // rendering of a transformed date.
        if (testCase.schema === 'body' && ours.success && theirs.success) {
          assert.equal(
            wireForm(ours.data),
            wireForm(theirs.data),
            `contract ${era.contract} parses "${testCase.label}" to a different body than the table`,
          );
        }
      }
    });
  }
});

describe('the queries production sends unvalidated are accepted by every era', () => {
  const SENT: ReadonlyArray<readonly [string, unknown]> = [
    // `RemnawaveDetectors.detectPerUserNodeTrafficAbuse` — a one-day UTC window, 25 000 rows.
    ['GetStatsNodesUsersUsageCommand', { start: '2026-08-04', end: '2026-08-05', topUsersLimit: 25_000 }],
    // `SubscriptionUaDetectors` at its default page size.
    ['GetSubscriptionRequestHistoryCommand', { start: 0, size: 500 }],
  ];
  for (const [name, query] of SENT) {
    it(`${name} ${JSON.stringify(query)}`, () => {
      for (const era of ERAS) {
        const schema = vendorCommand(era, name).RequestQuerySchema;
        assert.ok(schema !== undefined, `contract ${era.contract} has no query schema for ${name}`);
        assert.equal(schema.safeParse(query).success, true, `contract ${era.contract} refuses ${JSON.stringify(query)}`);
      }
    });
  }
});

// ── The runtime boundary ────────────────────────────────────────────────────

const PACKAGE_ROOT = join(__dirname, '..');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry)) files.push(path);
  }
  return files;
}

describe('no vendor contract reaches the runtime', () => {
  it('src/ imports no @remnawave/* package — by value, by type, dynamically or by require', () => {
    // `ts.preProcessFile` reads module specifiers the way the compiler does, so
    // prose in comments and strings — this codebase names the vendor package in
    // several — is not mistaken for an import, while `import type`, `export …
    // from`, `import()` and `require()` all are.
    const files = sourceFiles(join(PACKAGE_ROOT, 'src'));
    assert.ok(files.length > 100, `only ${files.length} source files found — wrong directory?`);
    const offenders: string[] = [];
    let specifiers = 0;
    for (const file of files) {
      const imported = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles;
      specifiers += imported.length;
      for (const { fileName } of imported) {
        if (fileName.startsWith('@remnawave/')) offenders.push(`${relative(PACKAGE_ROOT, file)} → ${fileName}`);
      }
    }
    // Anchor: the scan really read imports, so an empty offender list means something.
    assert.ok(specifiers > 1000, `only ${specifiers} import specifiers read`);
    assert.deepStrictEqual(offenders, []);
  });

  it('package.json lists no @remnawave/* package outside devDependencies', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const runtime = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    assert.deepStrictEqual(Object.keys(runtime).filter((name) => name.startsWith('@remnawave/')), []);
    // Anchor: the oracles are still there, where they belong.
    assert.equal(
      Object.keys(manifest.devDependencies ?? {}).filter((name) => name.startsWith('@remnawave/')).length,
      7,
    );
  });

  it('the lockfile marks every @remnawave/* package dev-only — what `npm ci --omit=dev` skips', () => {
    const lock = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { name?: string; version?: string; dev?: boolean }>;
    };
    const vendor = Object.entries(lock.packages).filter(([path]) => path.includes('node_modules/@remnawave/'));
    assert.ok(vendor.length >= 7, 'the lockfile lost the oracles — this check would compare nothing');
    assert.deepStrictEqual(
      vendor.filter(([, entry]) => entry.dev !== true).map(([path]) => path),
      [],
    );
    const runtimeZod = Object.entries(lock.packages).filter(
      ([path, entry]) => /(^|\/)node_modules\/zod$/.test(path) && entry.dev !== true,
    );
    assert.deepStrictEqual(
      runtimeZod.map(([path, entry]) => `${path}@${entry.version}`),
      ['node_modules/zod@4.5.4'],
    );
  });

  it('`npm ls --omit=dev` lists no @remnawave/* package, and exactly one zod', () => {
    // The literal check an operator would run against an install. One constant
    // command string, so the shell sees nothing a caller supplied.
    const result = spawnSync('npm ls --omit=dev --all --json', {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, `npm could not be run: ${String(result.error)}`);
    const tree = JSON.parse(result.stdout) as { dependencies?: Record<string, unknown> };
    const seen = new Map<string, Set<string>>();
    const walk = (node: { dependencies?: Record<string, unknown> }): void => {
      for (const [name, child] of Object.entries(node.dependencies ?? {})) {
        const dependency = child as { version?: string; dependencies?: Record<string, unknown> };
        const versions = seen.get(name) ?? new Set<string>();
        if (dependency.version !== undefined) versions.add(dependency.version);
        seen.set(name, versions);
        walk(dependency);
      }
    };
    walk(tree);
    // Anchor: a real production tree was read, not an empty object.
    assert.ok(seen.size > 100, `npm ls reported only ${seen.size} packages`);
    assert.deepStrictEqual([...seen.keys()].filter((name) => name.startsWith('@remnawave/')), []);
    assert.deepStrictEqual([...(seen.get('zod') ?? [])], ['4.5.4']);
  });
});
