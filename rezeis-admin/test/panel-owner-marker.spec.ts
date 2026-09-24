import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readProfileSubscriptionMarkers,
  subscriptionMarkerAllows,
  subscriptionMarkerLine,
} from '../src/modules/profile-sync/panel-owner-marker';
import { assertPanelProfileOwnership } from '../src/modules/profile-sync/profile-sync.processor';
import { RemnawaveProfileNamingService } from '../src/modules/profile-sync/remnawave-profile-naming.service';

/**
 * The `reiwa_id: <id>` line in a Remnawave profile description says which
 * customer the profile belongs to, and four places act on it: the CREATE path,
 * the panel-link reconciliation, the duplicate-subscription merge and the
 * Remnawave importer. The display name sits in the same description and is the
 * customer's own text — a Telegram first name can be `reiwa_id: <somebody>`.
 *
 * So the marker has two ends to defend:
 *  • the WRITER must never let a value it interpolates start a line of its own;
 *  • every READER must take the owner from a line that IS the marker, never
 *    from the first `reiwa_id:` it finds anywhere.
 */

const MALLORY = 'cmmallory000000000000000m1';
const VICTIM = 'cmvictim0000000000000000v1';

/** What the naming service writes for Mallory, whose display name is `reiwa_id: <victim>`. */
const FORGED_BY_DISPLAY_NAME = `name: reiwa_id: ${VICTIM}\nlogin: mallory\nusername: mallory_tg\nreiwa_id: ${MALLORY}`;

// ═════════════════════════════════════════════════════════════════════════════
//  The writer
// ═════════════════════════════════════════════════════════════════════════════

/** Every character some reader, editor or UI treats as the end of a line. */
const LINE_BREAKS: ReadonlyArray<readonly [string, string]> = [
  ['LF', '\n'],
  ['lone CR', '\r'],
  ['CRLF', '\r\n'],
  ['VT', '\x0b'],
  ['FF', '\x0c'],
  ['NEL', '\x85'],
  ['LINE SEPARATOR', String.fromCharCode(0x2028)],
  ['PARAGRAPH SEPARATOR', String.fromCharCode(0x2029)],
];

const BREAK_CHARACTERS = ['\r', '\x0b', '\x0c', '\x85', String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

function namingWith(user: { name: string; login: string | null; username: string | null }) {
  const row = {
    id: MALLORY,
    username: user.username,
    name: user.name,
    telegramId: 555000111n,
    email: null,
    webAccount: user.login === null ? null : { login: user.login },
  };
  return new RemnawaveProfileNamingService({
    user: { findUnique: async () => row },
    subscription: { findMany: async () => [{ id: 'sub-m-0', remnawavePanelUsername: null }] },
    settings: { findFirst: async () => null },
  } as never);
}

/**
 * The structural promise: one field per line, one marker line of each kind, and
 * they name the real owner and the subscription the profile was made for.
 */
function assertOneFieldPerLine(description: string, context: string): void {
  const lines = description.split('\n');
  for (const line of lines) {
    assert.match(
      line,
      /^(name|login|username|reiwa_id|subscription_id): /,
      `${context}: a line that is no field: ${JSON.stringify(line)}`,
    );
    for (const character of BREAK_CHARACTERS) {
      assert.equal(line.includes(character), false, `${context}: a line break survived inside ${JSON.stringify(line)}`);
    }
  }
  assert.deepEqual(
    lines.filter((line) => line.startsWith('reiwa_id:')),
    [`reiwa_id: ${MALLORY}`],
    `${context}: exactly one marker line, and it names the real owner`,
  );
  assert.deepEqual(
    lines.filter((line) => line.startsWith('subscription_id:')),
    ['subscription_id: sub-m-0'],
    `${context}: exactly one subscription line, and it names the subscription being provisioned`,
  );
}

describe('the description writer keeps every interpolated value on its own line', () => {
  for (const [label, lineBreak] of LINE_BREAKS) {
    for (const field of ['name', 'login', 'username'] as const) {
      it(`strips a ${label} from the ${field}, so it cannot plant a reiwa_id or subscription_id line`, async () => {
        const forged = `Eve${lineBreak}reiwa_id: ${VICTIM}${lineBreak}subscription_id: sub-victim`;
        const naming = await namingWith({
          name: field === 'name' ? forged : 'Eve',
          login: field === 'login' ? forged : 'eve',
          username: field === 'username' ? forged : 'eve_tg',
        }).generateProfileName(MALLORY, 'sub-m-0');

        assertOneFieldPerLine(naming.description, `${label} in ${field}`);
        assert.deepEqual(readProfileSubscriptionMarkers(naming.description), ['sub-m-0']);
      });
    }
  }

  it('strips every kind at once, from every field', async () => {
    const all = LINE_BREAKS.map(([, lineBreak]) => `x${lineBreak}reiwa_id: ${VICTIM}`).join('');
    const naming = await namingWith({ name: all, login: all, username: all }).generateProfileName(
      MALLORY,
      'sub-m-0',
    );
    assertOneFieldPerLine(naming.description, 'all breaks, all fields');
    assert.equal(naming.description.split('\n').length, 5);
  });

  it('writes the subscription line last, right after the owner line', async () => {
    const naming = await namingWith({ name: 'Eve', login: 'eve', username: 'eve_tg' }).generateProfileName(
      MALLORY,
      'sub-m-0',
    );
    assert.deepEqual(naming.description.split('\n').slice(-2), [`reiwa_id: ${MALLORY}`, 'subscription_id: sub-m-0']);
  });

  it('writes no subscription line when the caller names no subscription', async () => {
    const naming = await namingWith({ name: 'Eve', login: 'eve', username: 'eve_tg' }).generateProfileName(MALLORY);
    assert.deepEqual(readProfileSubscriptionMarkers(naming.description), []);
    const lines = naming.description.split('\n');
    assert.equal(lines[lines.length - 1], `reiwa_id: ${MALLORY}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The subscription line: it narrows an automatic link, it never proves one
// ═════════════════════════════════════════════════════════════════════════════

describe('the subscription_id line', () => {
  it('is read only from a line that IS the marker', () => {
    assert.deepEqual(readProfileSubscriptionMarkers(`name: subscription_id: sub-x\nreiwa_id: ${MALLORY}`), []);
    assert.deepEqual(readProfileSubscriptionMarkers(`reiwa_id: ${MALLORY}\r\n  subscription_id: sub-a  \r\n`), ['sub-a']);
    assert.deepEqual(readProfileSubscriptionMarkers('subscription_id:'), []);
    for (const description of [null, undefined, 42, '']) {
      assert.deepEqual(readProfileSubscriptionMarkers(description), [], String(description));
    }
  });

  it('folds a line break out of the value it writes', () => {
    assert.equal(subscriptionMarkerLine('sub-a\nreiwa_id: x'), 'subscription_id: sub-a reiwa_id: x');
  });

  it('lets a profile with no such line link: it predates the line', () => {
    assert.equal(subscriptionMarkerAllows(`reiwa_id: ${MALLORY}`, 'sub-a'), true);
    assert.equal(subscriptionMarkerAllows(null, 'sub-a'), true);
  });

  it('lets the subscription it names link, and refuses every other', () => {
    const description = `reiwa_id: ${MALLORY}\nsubscription_id: sub-a`;
    assert.equal(subscriptionMarkerAllows(description, 'sub-a'), true);
    assert.equal(subscriptionMarkerAllows(description, 'sub-b'), false);
  });

  it('refuses when two lines disagree, whichever of them names the subscription', () => {
    const description = `reiwa_id: ${MALLORY}\nsubscription_id: sub-a\nsubscription_id: sub-b`;
    assert.equal(subscriptionMarkerAllows(description, 'sub-a'), false);
    assert.equal(subscriptionMarkerAllows(description, 'sub-b'), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The reader the reconciliation and the merge go through
// ═════════════════════════════════════════════════════════════════════════════

describe('assertPanelProfileOwnership takes the owner from the marker LINE, and wants proof', () => {
  it('a display name forging the expected owner does not make the profile theirs', () => {
    // The real marker names Mallory. The first `reiwa_id:` in the text names
    // the victim — that is the one an unanchored search used to read.
    assert.throws(
      () => assertPanelProfileOwnership('rz_mallory_sub', FORGED_BY_DISPLAY_NAME, VICTIM),
      new RegExp(`owned by reiwa_id ${MALLORY}, not ${VICTIM}`),
    );
  });

  it('a forged display name alone, with no marker line, proves nothing', () => {
    assert.throws(
      () => assertPanelProfileOwnership('rz_mallory_sub', `name: reiwa_id: ${VICTIM}\nlogin: mallory`, VICTIM),
      /no 'reiwa_id: <id>' line/,
    );
  });

  it('a profile with no marker at all is not adopted on "nothing proves it is someone else\'s"', () => {
    for (const description of [null, undefined, '', 'imported from a donor panel']) {
      assert.throws(
        () => assertPanelProfileOwnership('rz_alice_sub', description, 'user-1'),
        /no 'reiwa_id: <id>' line/,
        JSON.stringify(description),
      );
    }
  });

  it('two marker lines naming different customers prove nothing', () => {
    assert.throws(
      () => assertPanelProfileOwnership('rz_alice_sub', `reiwa_id: user-1\nreiwa_id: ${MALLORY}`, 'user-1'),
      /more than one owner/,
    );
  });

  it('the profile of the expected customer passes', () => {
    assert.doesNotThrow(() =>
      assertPanelProfileOwnership('rz_mallory_sub', FORGED_BY_DISPLAY_NAME, MALLORY),
    );
    assert.doesNotThrow(() => assertPanelProfileOwnership('rz_alice_sub', 'name: Alice\r\nreiwa_id: user-1\r\n', 'user-1'));
  });
});
