/**
 * THE SQUAD AND STATUS READS, held against EVERY panel era rezeis ships to —
 * and against the vendor schemas that used to execute here and could not be.
 *
 * WHY THIS FILE EXISTS. `remnawave-api.service.ts` imported
 * `GetExternalSquadsCommand` from `@remnawave/backend-contract@2.7.3` and
 * `safeParse`d live responses with it. That schema declares `responseHeaders`
 * REQUIRED on every external-squad row; panel 3.x renamed the field to
 * `responseHeadersAdd` + `responseHeadersRemove` and stopped sending
 * `responseHeaders` at all. The parse therefore failed DETERMINISTICALLY on a
 * healthy 3.x panel and `getExternalSquadOptions()` threw
 * `ServiceUnavailableException` — but only once the panel had at least one
 * external squad, because an EMPTY list satisfies the schema trivially. That is
 * why the outage read as intermittent instead of as a version incompatibility.
 *
 * NO SINGLE VENDOR SCHEMA CAN SERVE BOTH ERAS — asserted below, not assumed.
 * 2.7.3 and 2.8.35 accept a 2.x list and reject a 3.3.2 one; 3.2.3 and 3.4.2 do
 * exactly the reverse. Pinning forward would have recreated the same outage for
 * every installation still on a 2.x panel. The two `*Options` reads need
 * `{ uuid, name }` and the status read needs a handful of booleans — fields no
 * era has ever spelled differently — so the fix is a tolerant local decoder,
 * `panel-response-decoders.ts`, in the style of `parsePanelUserRow` and
 * `mapExternalSquadDetails`, which read the same endpoints and never broke.
 *
 * THE OTHER HALF, and the reason a "tolerant" decoder is not automatically an
 * improvement: an empty list that means "we could not read the panel" is
 * indistinguishable from "the panel has none", and the caller acts on the wrong
 * one. `PlansAdminValidators.assertSquadsAreValid` is that caller — a throw
 * makes it refuse the write ("the panel could not be asked"), an empty list
 * makes it tell the operator `External squad not found: <uuid>` about a squad
 * that exists. Both outcomes are pinned here, separately.
 *
 * THE ANCHORS, all available in CI:
 *
 *   `@remnawave/backend-contract`  2.7.3  — the 2.7 line (dev; was the runtime
 *                                           dependency until this change)
 *   `@remnawave/contract-v28`      2.8.35 — the 2.8 line
 *   `@remnawave/contract-v3`       3.2.3  — the 3.2 line
 *   `@remnawave/contract-v34`      3.4.2  — exact pin, matches panel 3.3.2
 *   `test/fixtures/remnawave/{2.7.4,2.8.0,3.3.2}/{external,internal}-squads.json`
 *   `test/fixtures/remnawave/{2.7.4,2.8.0,3.3.2}/auth-status.json`
 *       — derived MECHANICALLY from each version's own OpenAPI document, key
 *         set and key ORDER included, following the precedent set by
 *         `test/fixtures/remnawave/3.3.2/user.json`. A fixture hand-trimmed to
 *         what the decoder happens to read is how the original defect survived:
 *         the mocks agreed with the code instead of with the panel.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ServiceUnavailableException } from '@nestjs/common';
import * as contractProd from '@remnawave/backend-contract';
import * as contractV28 from '@remnawave/contract-v28';
import * as contractV3 from '@remnawave/contract-v3';
import * as contractV34 from '@remnawave/contract-v34';
import { of } from 'rxjs';

import {
  decodePanelAuthStatus,
  decodeSquadOptionList,
} from '../src/modules/remnawave/services/panel-response-decoders';
import { PANEL_ROUTES } from '../src/modules/remnawave/services/panel-routes';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

// ── the vendor contracts, structurally typed ────────────────────────────────
// Same approach as `remnawave-user-row-era-conformance.spec.ts`: the four
// packages are separate zod builds and their inferred types are not mutually
// assignable, so they are consumed through one hand-written shape.

interface VendorCommand {
  readonly url: string;
  readonly endpointDetails: { readonly REQUEST_METHOD: string };
  readonly ResponseSchema: {
    safeParse: (value: unknown) =>
      | { success: true }
      | { success: false; error: { issues: ReadonlyArray<{ path: unknown[]; message: string }> } };
  };
}

interface ContractLine {
  readonly label: string;
  readonly era: '2.x' | '3.x';
  readonly externalSquads: VendorCommand;
  readonly internalSquads: VendorCommand;
  readonly status: VendorCommand;
}

function lineOf(label: string, era: '2.x' | '3.x', mod: unknown): ContractLine {
  const contract = mod as Record<string, unknown>;
  return {
    label,
    era,
    externalSquads: contract.GetExternalSquadsCommand as VendorCommand,
    internalSquads: contract.GetInternalSquadsCommand as VendorCommand,
    status: contract.GetStatusCommand as VendorCommand,
  };
}

const CONTRACT_LINES: readonly ContractLine[] = [
  lineOf('backend-contract 2.7.3', '2.x', contractProd),
  lineOf('contract-v28 2.8.35', '2.x', contractV28),
  lineOf('contract-v3 3.2.3', '3.x', contractV3),
  lineOf('contract-v34 3.4.2', '3.x', contractV34),
];

// ── fixtures ────────────────────────────────────────────────────────────────

/** Panel builds with a mechanically derived fixture set, oldest first. */
const PANEL_ERAS = [
  { version: '2.7.4', era: '2.x' as const },
  { version: '2.8.0', era: '2.x' as const },
  { version: '3.3.2', era: '3.x' as const },
];

interface PanelFixture {
  readonly version: string;
  readonly endpoint: string;
  readonly specRequired: readonly string[];
  /** The COMPLETE HTTP body, `response` envelope included. */
  readonly body: unknown;
}

function loadFixture(version: string, file: string): PanelFixture {
  const path = join(__dirname, 'fixtures', 'remnawave', version, file);
  return JSON.parse(readFileSync(path, 'utf8')) as PanelFixture;
}

/** The rows inside a squad fixture, as the panel sent them. */
function fixtureRows(fixture: PanelFixture, listKey: string): readonly Record<string, unknown>[] {
  const envelope = (fixture.body as { response: Record<string, unknown> }).response;
  return envelope[listKey] as readonly Record<string, unknown>[];
}

// ── the adapter under test ──────────────────────────────────────────────────

function serviceAnswering(body: unknown, capturedPaths: string[] = []): RemnawaveApiService {
  return new RemnawaveApiService(
    {
      request: (input: { readonly url: string }) => {
        capturedPaths.push(input.url);
        return of({ data: body });
      },
    } as never,
    { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null },
  );
}

/**
 * Runs a read and reports what it DID, never what it was supposed to do.
 *
 * Deliberately not `assert.rejects`: the failure this file guards is a read
 * that RESOLVES with `[]` where it should have thrown, and `assert.rejects`
 * reports that as "missing expected exception" without ever showing that an
 * empty list was handed to the caller. The resolved value has to be in the
 * message or the next person debugs the wrong thing.
 */
async function outcomeOf<T>(
  read: () => Promise<T>,
): Promise<{ readonly threw: false; readonly value: T } | { readonly threw: true; readonly error: unknown }> {
  try {
    return { threw: false, value: await read() };
  } catch (error: unknown) {
    return { threw: true, error };
  }
}

// ── payloads no era ever sends ──────────────────────────────────────────────

/**
 * Answers that carry no readable list. Each MUST refuse, and specifically must
 * not decode to `[]`.
 *
 * `[]` at the root and `{ response: [] }` are in here on purpose: an array
 * passes `typeof x === 'object'`, and every property read off one yields
 * `undefined`, so a decoder that only checks `typeof` sees "an object whose
 * every field is missing" and reports a confident, empty answer.
 */
function unreadableExternalSquadPayloads(): readonly { readonly label: string; readonly body: unknown }[] {
  return [
    { label: 'null body (panel answered 204 / proxy ate it)', body: null },
    { label: 'a string body (an HTML error page)', body: '<html>502</html>' },
    { label: 'an array at the root', body: [] },
    { label: 'no `response` envelope', body: {} },
    { label: '`response` is an array', body: { response: [] } },
    { label: '`response` carries no `externalSquads`', body: { response: { total: 2 } } },
    {
      label: '`externalSquads` is not an array',
      body: { response: { total: 2, externalSquads: 'squad-a,squad-b' } },
    },
    {
      label: 'empty list while the panel counts two — a contradiction, not an answer',
      body: { response: { total: 2, externalSquads: [] } },
    },
    {
      label: 'empty list with no count at all',
      body: { response: { externalSquads: [] } },
    },
  ];
}

describe('Remnawave squads and auth status decode on every panel era', () => {
  // ══════════════════════════════════════════════════════════════════════════
  //  THE LIVE DEFECT
  // ══════════════════════════════════════════════════════════════════════════

  it('decodes a panel 3.3.2 external-squad list that the pinned vendor schema rejects', async () => {
    const fixture = loadFixture('3.3.2', 'external-squads.json');
    const rows = fixtureRows(fixture, 'externalSquads');

    // The payload really is the one that broke: the schema that used to run at
    // runtime rejects it, and rejects it precisely over the renamed field.
    const vendor = contractProd.GetExternalSquadsCommand.ResponseSchema.safeParse(fixture.body);
    assert.equal(
      vendor.success,
      false,
      'the 2.7.3 schema is supposed to REJECT a 3.3.2 external-squad list — if it now accepts it, ' +
        'this fixture no longer reproduces the defect',
    );
    assert.ok(
      fixture.specRequired.includes('responseHeadersAdd') &&
        fixture.specRequired.includes('responseHeadersRemove') &&
        !fixture.specRequired.includes('responseHeaders'),
      'panel 3.3.2 declares responseHeadersAdd/Remove and no responseHeaders',
    );

    const capturedPaths: string[] = [];
    const options = await serviceAnswering(fixture.body, capturedPaths).getExternalSquadOptions();

    assert.equal(options.length, 2, 'both squads the panel sent must survive the decode');
    assert.deepStrictEqual(
      options,
      rows.map((row) => ({ uuid: row.uuid as string, name: row.name as string })),
    );
    assert.deepStrictEqual(capturedPaths, ['/api/external-squads/']);
  });

  it('decodes external-squad lists from every panel era, 2.x `responseHeaders` included', async () => {
    for (const { version } of PANEL_ERAS) {
      const fixture = loadFixture(version, 'external-squads.json');
      const rows = fixtureRows(fixture, 'externalSquads');
      const options = await serviceAnswering(fixture.body).getExternalSquadOptions();
      assert.deepStrictEqual(
        options,
        rows.map((row) => ({ uuid: row.uuid as string, name: row.name as string })),
        `panel ${version} external squads`,
      );
      assert.equal(options.length, 2, `panel ${version} must yield both squads`);
    }

    // …and the 2.x fixtures are genuinely the OTHER spelling, so a decoder that
    // only handled 3.x could not have passed the loop above.
    for (const version of ['2.7.4', '2.8.0']) {
      const fixture = loadFixture(version, 'external-squads.json');
      assert.ok(
        fixture.specRequired.includes('responseHeaders') &&
          !fixture.specRequired.includes('responseHeadersAdd'),
        `panel ${version} declares responseHeaders, not responseHeadersAdd`,
      );
    }
  });

  it('records that no single vendor schema accepts every era — why none is executed at runtime', () => {
    for (const line of CONTRACT_LINES) {
      for (const { version, era } of PANEL_ERAS) {
        const fixture = loadFixture(version, 'external-squads.json');
        const parsed = line.externalSquads.ResponseSchema.safeParse(fixture.body);
        assert.equal(
          parsed.success,
          line.era === era,
          `${line.label} vs panel ${version}: a vendor schema accepts its OWN era and only its own era. ` +
            'That is the whole reason the runtime stopped executing them.',
        );
      }
    }
  });

  it('parses an EMPTY external-squad list under every vendor schema — why the outage looked intermittent', () => {
    const empty = { response: { total: 0, externalSquads: [] } };
    for (const line of CONTRACT_LINES) {
      assert.equal(
        line.externalSquads.ResponseSchema.safeParse(empty).success,
        true,
        `${line.label} accepts an empty list regardless of era, so the defect only appeared once an ` +
          'operator created the first external squad',
      );
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  EMPTY IS NOT UNREADABLE
  // ══════════════════════════════════════════════════════════════════════════

  it('tells "the panel has no squads" apart from "we could not read the panel"', async () => {
    const answered = await outcomeOf(() =>
      serviceAnswering({ response: { total: 0, externalSquads: [] } }).getExternalSquadOptions(),
    );
    assert.equal(answered.threw, false, 'a well-formed empty list is an ANSWER and must not throw');
    assert.deepStrictEqual(answered.threw === false ? answered.value : null, []);

    const unread = await outcomeOf(() =>
      serviceAnswering({ response: { total: 2, externalSquads: [] } }).getExternalSquadOptions(),
    );
    assert.equal(
      unread.threw,
      true,
      'a payload we could not read must NOT arrive at the caller as an empty list: ' +
        'PlansAdminValidators reads a throw as "the panel could not be asked" and refuses the write, ' +
        'but reads [] as "no such squad" and rejects a squad that exists',
    );
  });

  it('refuses every unreadable external-squad answer instead of reporting an empty panel', async () => {
    for (const { label, body } of unreadableExternalSquadPayloads()) {
      const outcome = await outcomeOf(() => serviceAnswering(body).getExternalSquadOptions());
      assert.equal(
        outcome.threw,
        true,
        `${label}: expected a refusal, got ${JSON.stringify(
          outcome.threw === false ? outcome.value : undefined,
        )}`,
      );
      assert.ok(
        outcome.threw === true && outcome.error instanceof ServiceUnavailableException,
        `${label}: must refuse as ServiceUnavailableException so the caller can tell it from a 400`,
      );
    }
  });

  it('refuses every unreadable internal-squad answer instead of reporting an empty panel', async () => {
    const bodies: readonly { readonly label: string; readonly body: unknown }[] = [
      { label: 'null body', body: null },
      { label: 'an array at the root', body: [] },
      { label: 'no `response` envelope', body: {} },
      { label: '`internalSquads` missing', body: { response: { total: 1 } } },
      { label: 'empty list while the panel counts one', body: { response: { total: 1, internalSquads: [] } } },
    ];
    for (const { label, body } of bodies) {
      const outcome = await outcomeOf(() => serviceAnswering(body).getInternalSquadOptions());
      assert.equal(
        outcome.threw,
        true,
        `${label}: expected a refusal, got ${JSON.stringify(
          outcome.threw === false ? outcome.value : undefined,
        )}`,
      );
    }
    const answered = await outcomeOf(() =>
      serviceAnswering({ response: { total: 0, internalSquads: [] } }).getInternalSquadOptions(),
    );
    assert.equal(answered.threw, false);
    assert.deepStrictEqual(answered.threw === false ? answered.value : null, []);
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  ROWS
  // ══════════════════════════════════════════════════════════════════════════

  it('labels a squad whose `name` is unusable with its own uuid, never with undefined or blank', () => {
    const decoded = decodeSquadOptionList(
      {
        response: {
          total: 3,
          externalSquads: [
            { uuid: 'squad-no-name' },
            { uuid: 'squad-blank-name', name: '   ' },
            { uuid: 'squad-number-name', name: 7 },
          ],
        },
      },
      'externalSquads',
    );
    assert.equal(decoded.ok, true, 'a cosmetic field must not take the whole panel read down');
    assert.deepStrictEqual(decoded.ok === true ? decoded.value : null, [
      { uuid: 'squad-no-name', name: 'squad-no-name' },
      { uuid: 'squad-blank-name', name: 'squad-blank-name' },
      { uuid: 'squad-number-name', name: 'squad-number-name' },
    ]);
    for (const option of decoded.ok === true ? decoded.value : []) {
      assert.equal(typeof option.name, 'string');
      assert.ok(
        option.name.trim().length > 0,
        'an option whose label is blank renders as an invisible, still-selectable row in the admin dropdown',
      );
    }
  });

  it('refuses the whole read rather than handing back a list one squad short', () => {
    const rows: readonly unknown[] = [
      { uuid: 'squad-a', name: 'A' },
      { uuid: '', name: 'blank identity' },
      { uuid: 'squad-c', name: 'C' },
    ];
    const decoded = decodeSquadOptionList(
      { response: { total: rows.length, externalSquads: rows } },
      'externalSquads',
    );
    assert.equal(
      decoded.ok,
      false,
      'dropping the unkeyable row would hand back two squads as if they were all the panel has, and ' +
        'the operator would assign subscribers to the wrong set with nothing saying so',
    );

    for (const bad of [null, 'squad-b', 42, { name: 'no uuid at all' }, { uuid: 12 }]) {
      const result = decodeSquadOptionList(
        { response: { total: 2, externalSquads: [{ uuid: 'squad-a', name: 'A' }, bad] } },
        'externalSquads',
      );
      assert.equal(result.ok, false, `row ${JSON.stringify(bad)} must not be silently dropped`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  INTERNAL SQUADS
  // ══════════════════════════════════════════════════════════════════════════

  it('decodes internal-squad lists from every panel era', async () => {
    for (const { version } of PANEL_ERAS) {
      const fixture = loadFixture(version, 'internal-squads.json');
      const rows = fixtureRows(fixture, 'internalSquads');
      const capturedPaths: string[] = [];
      const options = await serviceAnswering(fixture.body, capturedPaths).getInternalSquadOptions();
      assert.deepStrictEqual(
        options,
        rows.map((row) => ({ uuid: row.uuid as string, name: row.name as string })),
        `panel ${version} internal squads`,
      );
      assert.deepStrictEqual(capturedPaths, ['/api/internal-squads/']);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  AUTH STATUS
  // ══════════════════════════════════════════════════════════════════════════

  it('decodes the auth status of every panel era', async () => {
    for (const { version } of PANEL_ERAS) {
      const fixture = loadFixture(version, 'auth-status.json');
      const capturedPaths: string[] = [];
      const status = await serviceAnswering(fixture.body, capturedPaths).getStatus();
      const expected = (fixture.body as { response: Record<string, unknown> }).response;
      assert.deepStrictEqual(capturedPaths, ['/api/auth/status']);
      assert.equal(status.isConfigured, true, `panel ${version}`);
      assert.equal(status.isReachable, true, `panel ${version}`);
      assert.equal(status.isLoginAllowed, expected.isLoginAllowed, `panel ${version}`);
      assert.equal(status.isRegisterAllowed, expected.isRegisterAllowed, `panel ${version}`);
      assert.deepStrictEqual(
        status.authentication,
        {
          passwordEnabled: true,
          passkeyEnabled: true,
          oauth2Providers: {
            telegram: true,
            github: true,
            pocketid: true,
            yandex: true,
            keycloak: true,
            generic: true,
          },
        },
        `panel ${version} authentication block`,
      );
      assert.deepStrictEqual(status.branding, expected.branding, `panel ${version} branding`);
    }
  });

  it('refuses to guess the two answers the status endpoint exists to give', () => {
    const readable = decodePanelAuthStatus({
      response: {
        isLoginAllowed: false,
        isRegisterAllowed: false,
        authentication: null,
        branding: null,
      },
    });
    assert.equal(readable.ok, true, 'an explicit "login is off, no auth block" is an ANSWER');
    assert.deepStrictEqual(readable.ok === true ? readable.value : null, {
      isLoginAllowed: false,
      isRegisterAllowed: false,
      authentication: null,
      branding: null,
    });

    // ABSENT, not just explicitly null. The decoder's doc comment promises both
    // spellings produce `null`, and a promise nothing checks is how this
    // codebase grows comments that are no longer true. A future panel that
    // stops publishing the decorative blocks must not take the login screen
    // down, and the two questions that matter must still be answered.
    const absentBlocks = decodePanelAuthStatus({
      response: { isLoginAllowed: true, isRegisterAllowed: false },
    });
    assert.equal(absentBlocks.ok, true, 'a missing decorative block is not an unreadable answer');
    assert.deepStrictEqual(absentBlocks.ok === true ? absentBlocks.value : null, {
      isLoginAllowed: true,
      isRegisterAllowed: false,
      authentication: null,
      branding: null,
    });

    for (const [label, body] of [
      ['no body at all', null],
      ['no `response` envelope', {}],
      ['`isLoginAllowed` absent', { response: { isRegisterAllowed: true } }],
      ['`isLoginAllowed` is a string', { response: { isLoginAllowed: 'true', isRegisterAllowed: true } }],
      ['`isRegisterAllowed` absent', { response: { isLoginAllowed: true } }],
      [
        '`authentication` is a scalar',
        { response: { isLoginAllowed: true, isRegisterAllowed: true, authentication: 'password' } },
      ],
    ] as ReadonlyArray<readonly [string, unknown]>) {
      const decoded = decodePanelAuthStatus(body);
      assert.equal(
        decoded.ok,
        false,
        `${label}: defaulting an unreadable isLoginAllowed to false tells the operator the panel has ` +
          'login switched off, which is a wrong answer rather than a degraded one',
      );
    }
  });

  it('refuses a field that is an array where an object belongs, instead of reading every key as missing', () => {
    // `typeof [] === 'object'`, and every property read off an array yields
    // `undefined` — so a decoder that only checks `typeof` sees "an object whose
    // every field happens to be missing" and answers confidently out of its own
    // defaults. That is the same misreading as an empty list standing in for an
    // unread panel, one level down, so every envelope decoder rejects arrays.
    for (const [label, body] of [
      [
        '`authentication` is an array',
        { response: { isLoginAllowed: true, isRegisterAllowed: true, authentication: [] } },
      ],
      [
        '`branding` is an array',
        {
          response: {
            isLoginAllowed: true,
            isRegisterAllowed: true,
            authentication: null,
            branding: [],
          },
        },
      ],
      ['the whole body is an array', []],
      ['`response` is an array', { response: [] }],
    ] as ReadonlyArray<readonly [string, unknown]>) {
      const decoded = decodePanelAuthStatus(body);
      assert.equal(
        decoded.ok,
        false,
        `${label}: an array is not "an object whose fields are all missing", and answering ` +
          'passkeyEnabled:false / branding:{title:null} out of that reads as fact in the admin SPA',
      );
    }

    // The same guard on the squad path. Stated for what it is: here the checks
    // that follow would refuse these anyway, so the array test is defence in
    // depth rather than the thing doing the work. Saying so beats implying an
    // assertion that guards nothing.
    for (const body of [[], { response: [] }, { response: { total: 1, externalSquads: [[]] } }]) {
      assert.equal(decodeSquadOptionList(body, 'externalSquads').ok, false);
    }
  });

  it('keeps tolerating the partial provider map a 2.x panel really sends', async () => {
    const status = await serviceAnswering({
      response: {
        isLoginAllowed: true,
        isRegisterAllowed: false,
        authentication: {
          passkey: { enabled: true },
          oauth2: { providers: { github: true, telegram: false, future: { enabled: true } } },
          password: { enabled: true },
        },
        branding: { title: 'Panel', logoUrl: null },
      },
    }).getStatus();
    assert.deepStrictEqual(status.authentication, {
      passwordEnabled: true,
      passkeyEnabled: true,
      // A provider whose value is not a boolean is dropped, not guessed at, and
      // does NOT take the login screen down with it.
      oauth2Providers: { github: true, telegram: false },
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  ROUTES — what replaced the vendor command constants
  // ══════════════════════════════════════════════════════════════════════════

  it('addresses exactly the URLs every vendor contract line publishes', () => {
    const pinned: readonly (readonly [string, keyof ContractLine & ('externalSquads' | 'internalSquads' | 'status')])[] = [
      [PANEL_ROUTES.externalSquads, 'externalSquads'],
      [PANEL_ROUTES.internalSquads, 'internalSquads'],
      [PANEL_ROUTES.authStatus, 'status'],
    ];
    for (const [route, command] of pinned) {
      for (const line of CONTRACT_LINES) {
        assert.equal(
          route,
          line[command].url,
          `${line.label} publishes a different URL for ${command}; the runtime no longer imports the ` +
            'package, so this assertion is the only thing holding the path to the vendor',
        );
        assert.equal(line[command].endpointDetails.REQUEST_METHOD, 'get', `${line.label} ${command}`);
      }
    }
  });
});
