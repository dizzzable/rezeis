import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import {
  panelAnswerStatusMove,
  readPanelUserStatus,
  type PanelAnswerPush,
} from '../src/modules/profile-sync/panel-answer-status';
import {
  withoutWithheldReadbackFields,
  type TermModelReadbackVerdict,
} from '../src/modules/remnawave/services/term-model-readback';

/**
 * The status a subscription in the term model takes from Remnawave — the pure
 * halves. What a read-back may write (`withoutWithheldReadbackFields`), and
 * what the panel's answer to a push may move (`panelAnswerStatusMove`). The
 * paths through the database are `remnawave-status-term-model-postgres`.
 */

const { ACTIVE, LIMITED, EXPIRED, DISABLED, DELETED } = SubscriptionStatus;
const NOW = new Date('2026-09-24T12:00:00.000Z');
const AHEAD = new Date('2026-10-24T12:00:00.000Z');
const PAST = new Date('2026-09-23T12:00:00.000Z');

/** A push that sent no status, for an owner who is not blocked: the common case. */
const PLAIN: PanelAnswerPush = { sent: null, ownerBlocked: false };

describe('readPanelUserStatus', () => {
  it('reads the four statuses a profile has, as the panel spells them or not', () => {
    assert.equal(readPanelUserStatus('ACTIVE'), ACTIVE);
    assert.equal(readPanelUserStatus('LIMITED'), LIMITED);
    assert.equal(readPanelUserStatus(' expired '), EXPIRED);
    assert.equal(readPanelUserStatus('DISABLED'), DISABLED);
  });

  it('reads nothing else: a body nobody validated may say anything', () => {
    for (const raw of ['DELETED', 'UNKNOWN', '', null, undefined, 7, { status: 'ACTIVE' }]) {
      assert.equal(readPanelUserStatus(raw), null, JSON.stringify(raw) ?? String(raw));
    }
  });
});

describe('panelAnswerStatusMove', () => {
  const move = (
    status: SubscriptionStatus,
    expiresAt: Date | null,
    answer: SubscriptionStatus,
    push: PanelAnswerPush = PLAIN,
    disabledByPanel = false,
  ) => panelAnswerStatusMove({ status, expiresAt }, answer, NOW, push, disabledByPanel);

  it('lifts LIMITED and a stale EXPIRED while the date runs, and limits a running subscription', () => {
    assert.equal(move(LIMITED, AHEAD, ACTIVE), ACTIVE, 'a top-up or a reset lifted it');
    assert.equal(move(EXPIRED, AHEAD, ACTIVE), ACTIVE, 'an EXPIRED with days left is stale');
    assert.equal(move(EXPIRED, AHEAD, LIMITED), LIMITED);
    assert.equal(move(ACTIVE, AHEAD, LIMITED), LIMITED, 'ran out before the push landed');
    assert.equal(move(ACTIVE, null, LIMITED), LIMITED, 'no end date runs for ever');
  });

  it('ends only a LIMITED subscription past its date: ending an ACTIVE one is the autopay sweep’s', () => {
    assert.equal(move(LIMITED, PAST, EXPIRED), EXPIRED);
    assert.equal(move(ACTIVE, PAST, EXPIRED), null, 'held ACTIVE while autopay retries remain');
    assert.equal(move(LIMITED, AHEAD, EXPIRED), null, 'our date runs: not ended');
    assert.equal(move(LIMITED, null, EXPIRED), null);
  });

  it('never moves a subscription past its date to ACTIVE or LIMITED', () => {
    assert.equal(move(EXPIRED, PAST, ACTIVE), null, 'Remnawave behind its own expiry job');
    assert.equal(move(ACTIVE, PAST, LIMITED), null, 'out of the autopay retries all the same');
    assert.equal(move(LIMITED, PAST, ACTIVE), null);
    assert.equal(move(EXPIRED, PAST, LIMITED), null);
  });

  it('the date is ended AT its instant, not a millisecond later', () => {
    assert.equal(move(EXPIRED, NOW, ACTIVE), null);
    assert.equal(move(LIMITED, NOW, EXPIRED), EXPIRED);
    assert.equal(move(EXPIRED, new Date(NOW.getTime() + 1), ACTIVE), ACTIVE);
  });

  it('moves nothing to itself, and never a DELETED row', () => {
    assert.equal(move(ACTIVE, AHEAD, ACTIVE), null);
    assert.equal(move(LIMITED, AHEAD, LIMITED), null);
    assert.equal(move(DISABLED, AHEAD, DISABLED), null);
    for (const answer of [ACTIVE, LIMITED, EXPIRED, DISABLED]) {
      assert.equal(move(DELETED, AHEAD, answer), null, `DELETED → ${answer}`);
    }
  });

  it('takes DISABLED when the push sent no status and the owner is not blocked: a switch-off made in Remnawave', () => {
    for (const status of [ACTIVE, LIMITED, EXPIRED]) {
      assert.equal(move(status, AHEAD, DISABLED), DISABLED, `${status} → DISABLED`);
    }
    assert.equal(move(ACTIVE, PAST, DISABLED), DISABLED, 'whatever the date: nothing derives it from the clock');
  });

  it('never takes DISABLED from a push that sent a status, or from a blocked owner’s answer', () => {
    assert.equal(move(ACTIVE, AHEAD, DISABLED, { sent: 'DISABLED', ownerBlocked: true }), null, 'the block sent it');
    assert.equal(move(ACTIVE, AHEAD, DISABLED, { sent: null, ownerBlocked: true }), null, 'a blocked owner, whatever was sent');
    assert.equal(move(ACTIVE, AHEAD, DISABLED, { sent: 'ACTIVE', ownerBlocked: false }), null);
    assert.equal(move(ACTIVE, AHEAD, DISABLED, { sent: 'DISABLED', ownerBlocked: false }), null);
  });

  it('lifts a DISABLED only to ACTIVE, when this push sent ACTIVE or the DISABLED was Remnawave’s', () => {
    assert.equal(move(DISABLED, AHEAD, ACTIVE, { sent: 'ACTIVE', ownerBlocked: false }, true), ACTIVE, 'our own switch-on');
    assert.equal(move(DISABLED, AHEAD, ACTIVE, PLAIN, false), ACTIVE, 'switched back on in Remnawave');
    assert.equal(move(DISABLED, null, ACTIVE, PLAIN, false), ACTIVE, 'no end date runs for ever');
  });

  it('keeps a DISABLED the panel set, a blocked owner’s, and one the push did not lift to ACTIVE', () => {
    assert.equal(move(DISABLED, AHEAD, ACTIVE, PLAIN, true), null, 'the operator switched it off in the panel');
    assert.equal(move(DISABLED, AHEAD, ACTIVE, { sent: null, ownerBlocked: true }, false), null);
    assert.equal(move(DISABLED, AHEAD, ACTIVE, { sent: 'DISABLED', ownerBlocked: false }, false), null);
    assert.equal(move(DISABLED, AHEAD, LIMITED, PLAIN, false), null);
    assert.equal(move(DISABLED, PAST, EXPIRED, PLAIN, false), null);
    assert.equal(move(DISABLED, PAST, ACTIVE, PLAIN, false), null, 'nor revived past its date');
    assert.equal(move(DISABLED, PAST, ACTIVE, { sent: 'ACTIVE', ownerBlocked: false }, true), null);
  });
});

describe('withoutWithheldReadbackFields', () => {
  const data = {
    status: EXPIRED,
    expiresAt: PAST,
    trafficLimit: 300,
    deviceLimit: 7,
    configUrl: 'https://panel.example/sub/1',
  };
  const verdict = (taken: boolean, keepsOpenEnd = false): TermModelReadbackVerdict => ({
    takeExpiry: taken,
    takeStatus: taken,
    keepsOpenEnd,
    outrankedByFailedPush: false,
    limits: taken ? 'IN_STEP' : 'OUTRANKED',
  });

  it('withholds the status with the expiry when the panel’s own push outranks the read', () => {
    assert.deepEqual(withoutWithheldReadbackFields(data, verdict(false)), { configUrl: data.configUrl });
  });

  it('passes the status and the expiry of a read nothing outranks, never the limits', () => {
    assert.deepEqual(withoutWithheldReadbackFields(data, verdict(true)), {
      status: EXPIRED,
      expiresAt: PAST,
      configUrl: data.configUrl,
    });
  });

  it('decides the two apart when told to, and invents neither', () => {
    assert.deepEqual(
      withoutWithheldReadbackFields(data, { ...verdict(false), takeStatus: true }),
      { status: EXPIRED, configUrl: data.configUrl },
    );
    assert.deepEqual(
      withoutWithheldReadbackFields({ configUrl: 'x' }, verdict(true)),
      { configUrl: 'x' },
      'a writer that stated no status gets none',
    );
  });

  it('on a row with no end, withholds the stated date and the EXPIRED derived from it, nothing else', () => {
    assert.deepEqual(withoutWithheldReadbackFields(data, verdict(true, true)), { configUrl: data.configUrl });
    assert.deepEqual(
      withoutWithheldReadbackFields({ ...data, status: LIMITED }, verdict(true, true)),
      { status: LIMITED, configUrl: data.configUrl },
      'LIMITED says nothing about the date',
    );
  });
});
