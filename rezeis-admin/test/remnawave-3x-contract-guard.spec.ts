import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Namespace imports: releases export different command NAMES, and a named
// import of a symbol a later release removes would fail at load rather than as
// an assertion.
//
// No 2.x contract is imported. This build refuses a 2.x panel on every path
// and builds no request in its shape, so there is no 2.x route left to pin.
import * as contractPanel321 from '@remnawave/contract-panel-3.2.1';
import * as contractPanel323 from '@remnawave/contract-panel-3.2.3';
import * as contractPanel33 from '@remnawave/contract-panel-3.3';
import * as contractPanel343 from '@remnawave/contract-panel-3.4.3';
import * as contractPanel344 from '@remnawave/contract-panel-3.4.4';

import {
  PANEL_ROUTES,
  PANEL_USER_NOT_FOUND_ERROR_CODES,
} from '../src/modules/remnawave/services/panel-routes';

/**
 * Pins every Remnawave route and "no such user" code in `panel-routes.ts`
 * against the contract each panel release actually ships.
 *
 * WHY THIS EXISTS. Everything in `panel-routes.ts` was originally transcribed by
 * hand off a panel running in a local lab. Hand transcription is exactly how
 * this integration has rotted before: a path or a field name changes upstream,
 * nothing here notices, and the first report comes from a customer rather than
 * from CI. This spec turns those constants from notes into checked facts.
 *
 * WHICH CONTRACT, FOR WHICH PANEL. The contract's version number is not the
 * panel's — contract 3.4.2 belongs to panel 3.3, and some contract releases
 * match no panel at all. The pairing below is the vendor's own table
 * (https://docs.rw/sdk/typescript-sdk/), installed as devDependency aliases
 * named by PANEL release:
 *
 *   `@remnawave/contract-panel-3.2.1`  backend-contract 3.2.0   panel 3.2.0–3.2.1
 *   `@remnawave/contract-panel-3.2.3`  backend-contract 3.2.3   panel 3.2.3
 *   `@remnawave/contract-panel-3.3`    backend-contract 3.4.2   panel 3.3.0–3.3.2
 *   `@remnawave/contract-panel-3.4.3`  backend-contract 3.4.13  panel 3.4.0–3.4.3
 *   `@remnawave/contract-panel-3.4.4`  backend-contract 3.4.15  panel 3.4.4
 *
 * None of them is a runtime dependency — `panel-command-conformance.spec.ts`
 * guards that — so they cost the image nothing. The routes are checked against
 * every 3.x release.
 */

/**
 * The vendor states collection routes with a trailing slash (`/api/users/`)
 * and rezeis states some without. Express treats the two as the same route and
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

type ContractNamespace = Readonly<Record<string, unknown>>;

interface Release {
  readonly panels: string;
  readonly contract: string;
  readonly module: ContractNamespace;
}

const THREE_X: readonly Release[] = [
  { panels: '3.2.0–3.2.1', contract: '3.2.0', module: contractPanel321 as unknown as ContractNamespace },
  { panels: '3.2.3', contract: '3.2.3', module: contractPanel323 as unknown as ContractNamespace },
  { panels: '3.3.0–3.3.2', contract: '3.4.2', module: contractPanel33 as unknown as ContractNamespace },
  { panels: '3.4.0–3.4.3', contract: '3.4.13', module: contractPanel343 as unknown as ContractNamespace },
  { panels: '3.4.4', contract: '3.4.15', module: contractPanel344 as unknown as ContractNamespace },
];

/** `url` off an export, or `null` when the release does not export that command. */
function urlOf(release: Release, name: string, arg = '{X}'): string | null {
  const command = release.module[name];
  if (command === null || typeof command !== 'object') return null;
  const url = (command as { url?: unknown }).url;
  if (typeof url === 'string') return route(url);
  if (typeof url !== 'function') return null;
  return route((url as (value: string) => string)(arg));
}

/** A route by export name. Fails loudly when a release stops exporting it. */
function vendorUrl(release: Release, name: string, arg?: string): string {
  const url = urlOf(release, name, arg);
  assert.ok(url !== null, `contract ${release.contract} (panel ${release.panels}) exports no url for ${name}`);
  return url;
}

describe('Remnawave 3.x routes match every 3.x release', () => {
  // [what it is, ours, the vendor's command, the segment]
  const CASES: ReadonlyArray<readonly [string, string, string, string | undefined]> = [
    ['GET one profile', route(PANEL_ROUTES.user(ID)), 'GetUserByIdCommand', ID],
    ['DELETE one profile', route(PANEL_ROUTES.deleteUser(ID)), 'DeleteUserCommand', ID],
    ['reset traffic', route(PANEL_ROUTES.resetUserTraffic(ID)), 'ResetUserTrafficCommand', ID],
    [
      'revoke subscription',
      route(PANEL_ROUTES.revokeUserSubscription(ID)),
      'RevokeUserSubscriptionCommand',
      ID,
    ],
    ['devices of one profile', route(PANEL_ROUTES.userHwidDevices(ID)), 'GetUserHwidDevicesCommand', ID],
    ['delete one device', route(PANEL_ROUTES.deleteHwidDevice), 'DeleteUserHwidDeviceCommand', undefined],
    [
      'delete every device',
      route(PANEL_ROUTES.deleteAllHwidDevices),
      'DeleteAllUserHwidDevicesCommand',
      undefined,
    ],
    ['user collection (list)', route(PANEL_ROUTES.users), 'GetUsersCommand', undefined],
    ['user collection (write)', route(PANEL_ROUTES.users), 'UpdateUserCommand', undefined],
    ['resolve identity', route(PANEL_ROUTES.resolveUser), 'ResolveUserCommand', undefined],
    [
      'lookup by username',
      route(PANEL_ROUTES.userByUsername('labuser1')),
      'GetUserByUsernameCommand',
      'labuser1',
    ],
    [
      'lookup by short uuid',
      route(PANEL_ROUTES.userByShortUuid('PyTr7C5568QuLhup')),
      'GetUserByShortUuidCommand',
      'PyTr7C5568QuLhup',
    ],
    [
      'connections by user — start',
      route(PANEL_ROUTES.connectionsByUserStart(ID)),
      'ConnectionsByUserCommand',
      ID,
    ],
    [
      'connections by user — result',
      route(PANEL_ROUTES.connectionsByUserResult(JOB_ID)),
      'ConnectionsByUserResultCommand',
      JOB_ID,
    ],
    [
      'connections by node — start',
      route(PANEL_ROUTES.connectionsByNodeStart(NODE_UUID)),
      'ConnectionsByNodeCommand',
      NODE_UUID,
    ],
    [
      'connections by node — result',
      route(PANEL_ROUTES.connectionsByNodeResult(JOB_ID)),
      'ConnectionsByNodeResultCommand',
      JOB_ID,
    ],
    ['drop connections', route(PANEL_ROUTES.connectionsDrop), 'DropConnectionsCommand', undefined],
  ];

  for (const [label, ours, command, arg] of CASES) {
    it(`${label}: ${ours}`, () => {
      for (const release of THREE_X) {
        assert.equal(ours, vendorUrl(release, command, arg), `contract ${release.contract} (panel ${release.panels})`);
      }
    });
  }

  it('snippet sync exists from panel 3.2.3 on, and panel 3.2.0–3.2.1 does not serve it', () => {
    // Measured, not assumed: contract 3.2.0 exports no `SyncSnippetCommand`.
    // `PANEL_ROUTES.snippetSync` has no caller in `src/`, so this is a fact
    // about the constant rather than a live request — recorded so that the day
    // something calls it, the release it cannot work on is already named.
    const [oldest, ...rest] = THREE_X;
    assert.equal(urlOf(oldest as Release, 'SyncSnippetCommand'), null);
    for (const release of rest) {
      assert.equal(route(PANEL_ROUTES.snippetSync), vendorUrl(release, 'SyncSnippetCommand'), release.contract);
    }
  });

  it('checks every route family, so a bad import cannot pass by checking nothing', () => {
    // A liveness floor. If the vendor packages stopped exporting these, the
    // loop above would simply run fewer cases and still be green.
    assert.equal(CASES.length, 17);
    assert.equal(THREE_X.length, 5);
    const families = new Set(CASES.map(([, ours]) => ours.split('/')[2]));
    assert.deepEqual([...families].sort(), ['connections', 'hwid', 'users']);
  });

  it('the comparison can actually fail', () => {
    // Self-test: proves `route()` is not flattening everything to one value.
    assert.notEqual(
      route(PANEL_ROUTES.user(ID)),
      vendorUrl(THREE_X[0] as Release, 'GetUserHwidDevicesCommand', ID),
    );
  });
});

describe('Remnawave "no such user" codes match every release', () => {
  interface Errors {
    readonly USER_NOT_FOUND: { readonly code: string; readonly httpCode: number; readonly message: string };
    readonly GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND: {
      readonly code: string;
      readonly httpCode: number;
      readonly message: string;
    };
  }
  const RELEASES = THREE_X;
  const errorsOf = (release: Release): Errors => release.module['ERRORS'] as Errors;

  it('both codes are the vendor’s, and both mean a missing user, in every release', () => {
    assert.equal(RELEASES.length, 5);
    for (const release of RELEASES) {
      const errors = errorsOf(release);
      assert.equal(errors.USER_NOT_FOUND.code, 'A025', release.contract);
      assert.equal(errors.GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND.code, 'A063', release.contract);
      assert.equal(errors.USER_NOT_FOUND.httpCode, 404, release.contract);
      assert.equal(errors.GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND.httpCode, 404, release.contract);
    }
  });

  it('rezeis recognises exactly those two, no more and no fewer', () => {
    const newest = errorsOf(THREE_X[THREE_X.length - 1] as Release);
    assert.deepEqual(
      [...PANEL_USER_NOT_FOUND_ERROR_CODES].sort(),
      [newest.USER_NOT_FOUND.code, newest.GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND.code].sort(),
    );
  });

  it('A063’s message does NOT contain the A025 message, which is why the code matters', () => {
    // The reason recognising A025 alone was not enough: a substring check on
    // "user not found" does not match "User with specified params not found".
    for (const release of RELEASES) {
      const errors = errorsOf(release);
      assert.ok(
        !errors.GET_USER_BY_UNIQUE_FIELDS_NOT_FOUND.message
          .toLowerCase()
          .includes(errors.USER_NOT_FOUND.message.toLowerCase()),
        release.contract,
      );
    }
  });
});
