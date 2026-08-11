import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConnectionsByNodeCommand,
  ConnectionsByNodeResultCommand,
  ConnectionsByUserCommand,
  ConnectionsByUserResultCommand,
  DeleteAllUserHwidDevicesCommand,
  DeleteUserCommand,
  DeleteUserHwidDeviceCommand,
  DropConnectionsCommand,
  ERRORS,
  GetUserByIdCommand,
  GetUserByShortUuidCommand,
  GetUserByUsernameCommand,
  GetUserHwidDevicesCommand,
  GetUsersCommand,
  ResetUserTrafficCommand,
  ResolveUserCommand,
  RevokeUserSubscriptionCommand,
  SyncSnippetCommand,
  UpdateUserCommand,
} from '@remnawave/contract-v3';

// Namespace imports for the 2.x lines: their export NAMES differ from 3.x
// (`GetUserByUuidCommand` vs `GetUserByIdCommand`), and a named import of a
// symbol a future patch removes would fail at load rather than as an assertion.
import * as contract27 from '@remnawave/backend-contract';
import * as contract28 from '@remnawave/contract-v28';

import {
  PANEL_ROUTES,
  PANEL_USER_NOT_FOUND_ERROR_CODES,
} from '../src/modules/remnawave/services/panel-routes';

/**
 * Pins every Remnawave 3.x route and error code rezeis builds against the
 * vendor's own published contract (`@remnawave/backend-contract@3.2.3`,
 * installed as the devDependency alias `@remnawave/contract-v3`).
 *
 * WHY THIS EXISTS. Everything in `panel-routes.ts` was originally transcribed by
 * hand off a panel running in a local lab. Hand transcription is exactly how
 * this integration has rotted before: a path or a field name changes upstream,
 * nothing here notices, and the first report comes from a customer rather than
 * from CI. This spec turns those constants from notes into checked facts —
 * bump the alias and a drifted route fails here.
 *
 * WHY THE VENDOR PACKAGE IS NOT A PRODUCTION DEPENDENCY. It pins `zod@4.4.3`
 * while this project pins `4.3.6`, so importing it from `src/` would ship a
 * third copy of zod in order to execute schemas the adapter deliberately does
 * not use — its response parsing is on purpose more tolerant than the published
 * contract (see `mapSubscriptionSettings`, and the defensive `total` reads in
 * `strictListUserDevices`). Strict vendor validation there would turn cosmetic
 * panel drift into an outage. So: the vendor's authority at build time, nothing
 * extra at runtime.
 *
 * SCOPE. Both eras. The 3.x half is pinned against `@remnawave/contract-v3`
 * (3.2.3); the 2.x half against `@remnawave/contract-v28` (2.8.35), because the
 * production dependency is pinned at `~2.7.3` — the 2.7 LINE — while the
 * operator's panels are 2.7.4 and 2.8.0. That pin turns out to be harmless (the
 * two contract lines declare ZERO differing paths across 185/186 commands, and
 * the three commands the adapter imports at runtime are identical), but
 * "harmless" is a measurement, not a guarantee, so the 2.8 line is checked here
 * rather than assumed.
 */

/**
 * The vendor states collection routes with a trailing slash (`/api/users/`)
 * and rezeis states them without. Express treats the two as the same route and
 * the panel answers both, so the difference is cosmetic — but it has to be
 * normalised away deliberately rather than silently, otherwise this spec would
 * be asserting a formatting convention instead of a route.
 */
function route(value: string): string {
  return value.endsWith('/') && value.length > 1 ? value.slice(0, -1) : value;
}

/** A stand-in identifier that is unambiguous in a URL and survives encoding. */
const ID = '4242';
const NODE_UUID = '7aa64e53-f5da-4366-9760-0fdad1497a28';
const JOB_ID = '7';

type UrlBuilder = { readonly url: string | ((...args: string[]) => string) };

/** The vendor exposes parameterised routes as builders and fixed ones as strings. */
function vendorUrl(command: UrlBuilder, arg?: string): string {
  const { url } = command;
  return route(typeof url === 'function' ? url(arg ?? '') : url);
}

/** `url` off an unknown export, or `null` when it carries none. */
function urlOfUnknown(command: unknown, arg = '{X}'): string | null {
  if (command === null || typeof command !== 'object') return null;
  const url = (command as { url?: unknown }).url;
  if (typeof url === 'string') return route(url);
  if (typeof url !== 'function') return null;
  return route((url as (value: string) => string)(arg));
}

type ContractNamespace = Record<string, unknown>;

const CONTRACTS: Readonly<Record<string, ContractNamespace>> = {
  '@remnawave/backend-contract': contract27 as unknown as ContractNamespace,
  '@remnawave/contract-v28': contract28 as unknown as ContractNamespace,
};

function loadContract(spec: string): ContractNamespace {
  const found = CONTRACTS[spec];
  assert.ok(found !== undefined, `contract ${spec} is not wired into this spec`);
  return found;
}

/**
 * A 2.x route by EXPORT NAME. Fails loudly when the vendor stops exporting it,
 * which is the signal we want — a silently skipped assertion is how a guard
 * test turns green while guarding nothing.
 */
function vendorUrl28(name: string, arg?: string): string {
  const url = urlOfUnknown((contract28 as unknown as ContractNamespace)[name], arg);
  assert.ok(url !== null, `@remnawave/contract-v28 exports no url for ${name}`);
  return url;
}

describe('Remnawave 3.x routes match the vendor contract', () => {
  // [what it is, ours, theirs]
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['GET one profile', route(PANEL_ROUTES.user(ID)), vendorUrl(GetUserByIdCommand, ID)],
    ['DELETE one profile', route(PANEL_ROUTES.deleteUser(ID)), vendorUrl(DeleteUserCommand, ID)],
    [
      'reset traffic',
      route(PANEL_ROUTES.resetUserTraffic(ID)),
      vendorUrl(ResetUserTrafficCommand, ID),
    ],
    [
      'revoke subscription',
      route(PANEL_ROUTES.revokeUserSubscription(ID)),
      vendorUrl(RevokeUserSubscriptionCommand, ID),
    ],
    [
      'devices of one profile',
      route(PANEL_ROUTES.userHwidDevices(ID)),
      vendorUrl(GetUserHwidDevicesCommand, ID),
    ],
    [
      'delete one device',
      route(PANEL_ROUTES.deleteHwidDevice),
      vendorUrl(DeleteUserHwidDeviceCommand),
    ],
    [
      'delete every device',
      route(PANEL_ROUTES.deleteAllHwidDevices),
      vendorUrl(DeleteAllUserHwidDevicesCommand),
    ],
    ['user collection (list)', route(PANEL_ROUTES.users), vendorUrl(GetUsersCommand)],
    ['user collection (write)', route(PANEL_ROUTES.users), vendorUrl(UpdateUserCommand)],
    ['resolve identity', route(PANEL_ROUTES.resolveUser), vendorUrl(ResolveUserCommand)],
    [
      'lookup by username',
      route(PANEL_ROUTES.userByUsername('labuser1')),
      vendorUrl(GetUserByUsernameCommand, 'labuser1'),
    ],
    [
      'lookup by short uuid',
      route(PANEL_ROUTES.userByShortUuid('PyTr7C5568QuLhup')),
      vendorUrl(GetUserByShortUuidCommand, 'PyTr7C5568QuLhup'),
    ],
    [
      'connections by user — start',
      route(PANEL_ROUTES.connectionsByUserStart(ID)),
      vendorUrl(ConnectionsByUserCommand, ID),
    ],
    [
      'connections by user — result',
      route(PANEL_ROUTES.connectionsByUserResult(JOB_ID)),
      vendorUrl(ConnectionsByUserResultCommand, JOB_ID),
    ],
    [
      'connections by node — start',
      route(PANEL_ROUTES.connectionsByNodeStart(NODE_UUID)),
      vendorUrl(ConnectionsByNodeCommand, NODE_UUID),
    ],
    [
      'connections by node — result',
      route(PANEL_ROUTES.connectionsByNodeResult(JOB_ID)),
      vendorUrl(ConnectionsByNodeResultCommand, JOB_ID),
    ],
    ['drop connections', route(PANEL_ROUTES.connectionsDrop), vendorUrl(DropConnectionsCommand)],
    ['sync snippet', route(PANEL_ROUTES.snippetSync), vendorUrl(SyncSnippetCommand)],
  ];

  for (const [label, ours, theirs] of CASES) {
    it(`${label}: ${theirs}`, () => {
      assert.equal(ours, theirs);
    });
  }

  it('checks every route family, so a bad import cannot pass by checking nothing', () => {
    // A liveness floor. If the vendor package stops exporting these, the loop
    // above would simply run fewer cases and still be green.
    assert.ok(CASES.length >= 18, `only ${CASES.length} routes checked`);
    const families = new Set(CASES.map(([, ours]) => ours.split('/')[2]));
    assert.deepEqual([...families].sort(), ['connections', 'hwid', 'snippets', 'users']);
  });

  it('the comparison can actually fail', () => {
    // Self-test: proves `route()` is not flattening everything to one value.
    assert.notEqual(route(PANEL_ROUTES.user(ID)), vendorUrl(GetUserHwidDevicesCommand, ID));
  });
});

describe('Remnawave 2.x routes match the vendor contract', () => {
  // The 2.x half of `PANEL_ROUTES`: the same operations, addressed by UUID, plus
  // the `ip-control/*` family that 3.x deleted outright.
  const UUID = '330f2b38-1362-46ab-b5c0-dea32167eff9';

  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['GET one profile', route(PANEL_ROUTES.user(UUID)), vendorUrl28('GetUserByUuidCommand', UUID)],
    [
      'DELETE one profile',
      route(PANEL_ROUTES.deleteUser(UUID)),
      vendorUrl28('DeleteUserCommand', UUID),
    ],
    [
      'reset traffic',
      route(PANEL_ROUTES.resetUserTraffic(UUID)),
      vendorUrl28('ResetUserTrafficCommand', UUID),
    ],
    [
      'revoke subscription',
      route(PANEL_ROUTES.revokeUserSubscription(UUID)),
      vendorUrl28('RevokeUserSubscriptionCommand', UUID),
    ],
    [
      'devices of one profile',
      route(PANEL_ROUTES.userHwidDevices(UUID)),
      vendorUrl28('GetUserHwidDevicesCommand', UUID),
    ],
    [
      'delete one device',
      route(PANEL_ROUTES.deleteHwidDevice),
      vendorUrl28('DeleteUserHwidDeviceCommand'),
    ],
    [
      'delete every device',
      route(PANEL_ROUTES.deleteAllHwidDevices),
      vendorUrl28('DeleteAllUserHwidDevicesCommand'),
    ],
    ['drop connections (2.x)', route(PANEL_ROUTES.ipControlDrop), vendorUrl28('DropConnectionsCommand')],
  ];

  for (const [label, ours, theirs] of CASES) {
    it(`${label}: ${theirs}`, () => {
      assert.equal(ours, theirs);
    });
  }

  it('checks the 2.x families too', () => {
    assert.ok(CASES.length >= 8, `only ${CASES.length} routes checked`);
    const families = new Set(CASES.map(([, ours]) => ours.split('/')[2]));
    assert.deepEqual([...families].sort(), ['hwid', 'ip-control', 'users']);
  });

  it('the two contract lines agree on every path rezeis builds', () => {
    // The reason the stale `~2.7.3` production pin does not matter. If a future
    // 2.x patch ever moves a path, this is where it surfaces.
    const v27 = loadContract('@remnawave/backend-contract');
    const v28 = loadContract('@remnawave/contract-v28');
    const drifted: string[] = [];
    for (const name of Object.keys(v27)) {
      if (!name.endsWith('Command')) continue;
      const a = urlOfUnknown(v27[name]);
      const b = urlOfUnknown(v28[name]);
      if (a !== null && b !== null && a !== b) drifted.push(`${name}: ${a} -> ${b}`);
    }
    assert.deepEqual(drifted, []);
  });
});

describe('Remnawave "no such user" codes match the vendor contract', () => {
  it('both codes are the vendor\'s, and both mean a missing user', () => {
    assert.equal(ERRORS.USER_NOT_FOUND.code, 'A025');
    assert.equal(ERRORS.GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND.code, 'A063');
    assert.equal(ERRORS.USER_NOT_FOUND.httpCode, 404);
    assert.equal(ERRORS.GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND.httpCode, 404);
  });

  it('rezeis recognises exactly those two, no more and no fewer', () => {
    assert.deepEqual(
      [...PANEL_USER_NOT_FOUND_ERROR_CODES].sort(),
      [ERRORS.USER_NOT_FOUND.code, ERRORS.GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND.code].sort(),
    );
  });

  it('A063\'s message does NOT contain the A025 message, which is why the code matters', () => {
    // The reason recognising A025 alone was not enough: a substring check on
    // "user not found" does not match "User with specified params not found".
    assert.ok(
      !ERRORS.GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND.message
        .toLowerCase()
        .includes(ERRORS.USER_NOT_FOUND.message.toLowerCase()),
    );
  });
});
