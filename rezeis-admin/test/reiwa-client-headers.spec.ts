import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CABINET_CAPABILITY } from '../src/modules/reiwa-peers/cabinet-capabilities';
import {
  CAPABILITIES_HEADER_MAX_CHARACTERS,
  CAPABILITIES_HEADER_MAX_NAMES,
  CLIENT_HEADER_MAX_CHARACTERS,
  normalizeReiwaVersion,
  parseReiwaCapabilities,
  parseReiwaClient,
  readReiwaDeclaration,
  REIWA_CAPABILITIES_HEADER,
  REIWA_CLIENT_HEADER,
  UNNAMED_INSTANCE,
} from '../src/modules/reiwa-peers/reiwa-client-headers';

/**
 * The two headers a Reiwa cabinet from 0.9.7.54 on sends on every internal
 * call, read the way the hint doors are: bounded, known ids only, exact case,
 * and never a throw — a newer cabinet must never get a 400 from an older panel.
 */

const API_CLIENT = 'surface=api; version=0.9.7.54; commit=0123456789ab; instance=reiwa';

function declared(client: string | undefined, capabilities?: string) {
  return readReiwaDeclaration({
    ...(client === undefined ? {} : { [REIWA_CLIENT_HEADER]: client }),
    ...(capabilities === undefined ? {} : { [REIWA_CAPABILITIES_HEADER]: capabilities }),
  });
}

describe('x-reiwa-client', () => {
  it('reads surface, version, commit and instance', () => {
    assert.deepEqual(parseReiwaClient(API_CLIENT), {
      surface: 'api',
      version: '0.9.7.54',
      commit: '0123456789ab',
      instance: 'reiwa',
    });
    assert.deepEqual(parseReiwaClient('instance=reiwa-bot;surface=bot;version=v0.9.7.54-rc.1'), {
      surface: 'bot',
      version: '0.9.7.54-rc.1',
      commit: null,
      instance: 'reiwa-bot',
    });
  });

  it('is silence when absent, and a declaration of nothing when it names no surface this panel knows', () => {
    assert.equal(parseReiwaClient(undefined), null);
    assert.equal(declared(undefined, 'web.addon-reset-end'), null, 'capabilities alone are not a declaration');
    for (const header of ['', 'surface=web', 'surface=API', 'garbage', '=;=;;', 'surface']) {
      const declaration = declared(header, 'web.addon-reset-end,api.appearance-report');
      assert.ok(declaration !== null, `present: ${JSON.stringify(header)}`);
      assert.equal(declaration.surface, null, header);
      assert.deepEqual(declaration.capabilities, [], `vouches for nothing: ${JSON.stringify(header)}`);
    }
  });

  it('takes the first of a repeated key, and a value its key does not allow as absent', () => {
    assert.equal(parseReiwaClient('surface=bot; surface=api')?.surface, 'bot');
    const odd = parseReiwaClient('surface=api; version=latest; commit=unknown; instance=has space');
    assert.deepEqual(odd, { surface: 'api', version: null, commit: null, instance: UNNAMED_INSTANCE });
    assert.equal(parseReiwaClient('surface=api; commit=ABCDEF1')?.commit, 'abcdef1', 'a commit is hex, any case');
  });

  it('never lets a declaration take a record name the panel keeps for silent cabinets', () => {
    assert.equal(parseReiwaClient('surface=api; instance=legacy-poll-api')?.instance, UNNAMED_INSTANCE);
    assert.equal(parseReiwaClient('surface=api; instance=legacy-heartbeat-api')?.instance, UNNAMED_INSTANCE);
    assert.equal(parseReiwaClient('surface=api; instance=../../x')?.instance, UNNAMED_INSTANCE);
  });

  it(`reads at most ${CLIENT_HEADER_MAX_CHARACTERS} characters`, () => {
    const padding = 'x'.repeat(CLIENT_HEADER_MAX_CHARACTERS);
    assert.equal(parseReiwaClient(`pad=${padding}; surface=api`)?.surface, null, 'a surface past the bound is not read');
    assert.equal(parseReiwaClient(`surface=api; pad=${padding}`)?.surface, 'api');
  });
});

describe('x-reiwa-capabilities', () => {
  it('keeps the registered ids of the surfaces the process hosts, and counts the ones this panel does not know', () => {
    const declaration = declared(
      API_CLIENT,
      ' web.addon-reset-end, api.appearance-report,web.something-newer,bot.stale-button-menu,panel.anything,web.addon-reset-end',
    );
    assert.ok(declaration !== null);
    assert.deepEqual([...declaration.capabilities].sort(), [CABINET_CAPABILITY.addonResetEnd, CABINET_CAPABILITY.appearanceReport].sort());
    assert.equal(declaration.unknownCapabilities, 1, 'web.something-newer: a cabinet newer than the panel');
  });

  it('the bot vouches for bot ids only, the worker for none', () => {
    const all = 'web.addon-reset-end,api.config-version-poll,bot.config-version-poll,bot.stale-button-menu';
    assert.deepEqual(
      [...(declared('surface=bot; version=0.9.7.54; instance=reiwa-bot', all)?.capabilities ?? [])].sort(),
      [CABINET_CAPABILITY.botConfigVersionPoll, CABINET_CAPABILITY.staleButtonMenu].sort(),
    );
    assert.deepEqual(declared('surface=worker; version=0.9.7.54', all)?.capabilities, []);
  });

  it('an EMPTY list — what the worker sends — is a declaration of nothing, never silence', () => {
    const worker = declared('surface=worker; version=0.9.7.54; instance=reiwa-worker', '');
    assert.ok(worker !== null, 'the worker declared itself: not a silent 0.9.7.53');
    assert.deepEqual([worker.surface, worker.capabilities, worker.unknownCapabilities], ['worker', [], 0]);
    const api = declared(API_CLIENT, '');
    assert.deepEqual([api?.surface, api?.capabilities], ['api', []]);
  });

  it('is exact: another case, a stray character or an over-long name is not an id', () => {
    const parsed = parseReiwaCapabilities(
      `Web.addon-reset-end,WEB.ADDON-RESET-END,web.addon-reset-end.,web.addon_reset_end,web.${'a'.repeat(60)}`,
      ['web', 'api'],
    );
    assert.deepEqual(parsed, { known: [], unknown: 0 });
  });

  it(`reads at most ${CAPABILITIES_HEADER_MAX_NAMES} names and ${CAPABILITIES_HEADER_MAX_CHARACTERS} characters`, () => {
    const filler = Array.from({ length: CAPABILITIES_HEADER_MAX_NAMES }, (_, index) => `web.filler-${index}`);
    const pastNames = parseReiwaCapabilities([...filler, CABINET_CAPABILITY.addonResetEnd].join(','), ['web']);
    assert.deepEqual(pastNames.known, [], `the ${CAPABILITIES_HEADER_MAX_NAMES + 1}th name is not read`);
    assert.equal(pastNames.unknown, CAPABILITIES_HEADER_MAX_NAMES);

    const long = `${' '.repeat(CAPABILITIES_HEADER_MAX_CHARACTERS)},${CABINET_CAPABILITY.addonResetEnd}`;
    assert.deepEqual(parseReiwaCapabilities(long, ['web']).known, [], 'a name past the character bound is not read');
    assert.deepEqual(
      parseReiwaCapabilities(`${CABINET_CAPABILITY.addonResetEnd},${' '.repeat(CAPABILITIES_HEADER_MAX_CHARACTERS)}`, ['web']).known,
      [CABINET_CAPABILITY.addonResetEnd],
    );
  });

  it('never throws, whatever arrives', () => {
    const junk: unknown[] = [
      undefined,
      '',
      ',,,',
      '\u0000￿\ud800',
      'x'.repeat(100_000),
      ['surface=api', 'surface=bot'],
      [],
    ];
    for (const value of junk) {
      assert.doesNotThrow(() =>
        readReiwaDeclaration({ [REIWA_CLIENT_HEADER]: value as string, [REIWA_CAPABILITIES_HEADER]: value as string }),
      );
    }
    // A repeated header arrives as an array and is read joined.
    assert.deepEqual(
      readReiwaDeclaration({
        [REIWA_CLIENT_HEADER]: [API_CLIENT],
        [REIWA_CAPABILITIES_HEADER]: ['web.addon-reset-end', 'api.appearance-report'],
      })?.capabilities,
      [CABINET_CAPABILITY.addonResetEnd, CABINET_CAPABILITY.appearanceReport],
    );
  });
});

describe('a reported version', () => {
  it('is the heartbeat DTO’s shape, without its v', () => {
    assert.equal(normalizeReiwaVersion('v0.9.7.54'), '0.9.7.54');
    assert.equal(normalizeReiwaVersion(' 0.9.7.53 '), '0.9.7.53');
    assert.equal(normalizeReiwaVersion('0.9.7'), '0.9.7');
    for (const bad of ['', 'latest', '0.9', '1.2.3.4.5', `0.9.7.${'1'.repeat(40)}`, 42, null]) {
      assert.equal(normalizeReiwaVersion(bad), null, String(bad));
    }
  });
});
