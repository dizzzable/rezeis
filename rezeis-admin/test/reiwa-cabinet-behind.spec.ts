import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import { EVENT_PRESENTATION, EVENT_TYPES } from '../src/common/services/system-events.service';
import { CABINET_CAPABILITY, capabilityRowsHostedBy } from '../src/modules/reiwa-peers/cabinet-capabilities';
import { PANEL_VERSION } from '../src/modules/reiwa-peers/panel-capabilities';
import { ReiwaCabinetBehindService } from '../src/modules/reiwa-peers/reiwa-cabinet-behind.service';
import {
  BEHIND_CARD_DEBOUNCE_MS,
  behindCardKey,
  behindKey,
} from '../src/modules/reiwa-peers/reiwa-peers.constants';
import { ReiwaPeerRegistry } from '../src/modules/reiwa-peers/reiwa-peer-registry.service';
import { memoryRawCache } from './helpers/memory-raw-cache';

/**
 * «🧩 Кабинет старше панели»
 * ═════════════════════════
 * One card per surface and cabinet version, after the surface has been behind
 * for ten minutes — so an ordinary update gap sends nothing — deduplicated by a
 * claim, re-armed when the cabinet catches up, and never for a surface the
 * panel has not seen or for a 0.9.7.53 cabinet, which lacks nothing this panel
 * registered.
 */

const T0 = Date.parse('2026-09-26T12:00:00.000Z');
const MINUTE = 60_000;
const API_054_ALL = {
  'x-reiwa-client': 'surface=api; version=0.9.7.54; instance=reiwa',
  'x-reiwa-capabilities': capabilityRowsHostedBy('api').map((row) => row.id).join(','),
};

interface Card {
  readonly type: string;
  readonly category: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

/** The worker process started a day before T0: no boot grace in these cases. */
const STARTED = T0 - 24 * 60 * MINUTE;

function world() {
  let now = T0;
  const cache = memoryRawCache({ now: () => now });
  const peers = new ReiwaPeerRegistry(cache.store, STARTED);
  const cards: Card[] = [];
  const events = {
    warn: (type: string, category: string, message: string, metadata: Record<string, unknown>) => {
      cards.push({ type, category, message, metadata });
    },
  };
  const service = new ReiwaCabinetBehindService(peers, cache.store, events as never);
  return {
    peers,
    cache,
    cards,
    service,
    /** Another worker over the same Redis. */
    twin: () => new ReiwaCabinetBehindService(new ReiwaPeerRegistry(cache.store, STARTED), cache.store, events as never),
    at: (value: number) => {
      now = value;
      return value;
    },
  };
}

describe('«🧩 Кабинет старше панели»', () => {
  afterEach(() => {
    delete process.env.RUID_PROCESS_ROLE;
    _resetProcessRoleCacheForTests();
  });

  it('waits ten minutes, then sends one card — and never a second for the same version', async () => {
    assert.equal(BEHIND_CARD_DEBOUNCE_MS, 10 * MINUTE, 'the owner’s ten minutes (D5)');
    const w = world();
    await w.peers.observeHeartbeat('0.9.7.52', undefined, T0);

    assert.deepEqual(await w.service.check(T0), { api: 'waiting', bot: 'not-compared' });
    assert.deepEqual(w.cards, [], 'an update gap sends nothing');
    assert.equal((await w.service.check(T0 + BEHIND_CARD_DEBOUNCE_MS - 1)).api, 'waiting');
    assert.deepEqual(w.cards, []);

    assert.equal((await w.service.check(T0 + BEHIND_CARD_DEBOUNCE_MS)).api, 'sent');
    assert.equal(w.cards.length, 1);
    assert.equal((await w.service.check(T0 + BEHIND_CARD_DEBOUNCE_MS + 5 * MINUTE)).api, 'already-sent');
    assert.equal((await w.twin().check(T0 + BEHIND_CARD_DEBOUNCE_MS + 5 * MINUTE)).api, 'already-sent', 'another worker too');
    assert.equal(w.cards.length, 1);
  });

  it('says which cabinet, what does not work — the withheld sale first — and that nothing is charged', async () => {
    const w = world();
    await w.peers.observeHeartbeat('0.9.7.52', undefined, T0);
    await w.service.check(T0);
    await w.service.check(T0 + BEHIND_CARD_DEBOUNCE_MS);

    const [card] = w.cards;
    assert.ok(card);
    assert.equal(card.type, EVENT_TYPES.REIWA_CABINET_BEHIND);
    assert.equal(card.type, 'reiwa.cabinet_behind');
    assert.equal(card.category, 'SYSTEM');
    assert.deepEqual(EVENT_PRESENTATION[card.type], { emoji: '🧩', title: 'Кабинет старше панели' });
    const note = String(card.metadata['note']);
    const lines = note.split('\n');
    assert.equal(lines[0], `Кабинет Reiwa 0.9.7.52 (сайт и API) старше этой панели ${PANEL_VERSION}. До его обновления:`);
    assert.equal(lines[1], '• докупка трафика «до сброса» в кабинете не продаётся;');
    assert.equal(lines.length, capabilityRowsHostedBy('api').length + 2);
    assert.ok(lines[lines.length - 2]?.endsWith('.'), 'the last item closes the list');
    assert.equal(lines[lines.length - 1], 'Остальное работает, деньги за скрытое не списываются. Обновите Reiwa.');
    assert.equal(card.metadata['cabinetVersion'], '0.9.7.52');
    assert.equal(card.metadata['panelVersion'], PANEL_VERSION);
    assert.deepEqual((card.metadata['missingCapabilities'] as string[])[0], CABINET_CAPABILITY.addonResetEnd);
  });

  it('a cabinet that catches up is re-armed: falling behind again is a new ten minutes and a new card', async () => {
    const w = world();
    await w.peers.observeHeartbeat('0.9.7.52', undefined, T0);
    await w.service.check(T0);
    await w.service.check(T0 + BEHIND_CARD_DEBOUNCE_MS);
    assert.equal(w.cards.length, 1);

    // Updated to a declaring cabinet: caught up, the mark and the claim go.
    const t1 = T0 + 20 * MINUTE;
    await w.peers.observePoll('api', API_054_ALL, t1);
    assert.equal((await w.service.check(t1)).api, 'caught-up');
    assert.equal(w.cache.read(behindKey('api')), undefined);
    assert.equal(w.cache.read(behindCardKey('api', '0.9.7.52')), undefined);

    // Rolled back to 0.9.7.52 an hour later.
    const t2 = t1 + 60 * MINUTE;
    await w.peers.observeHeartbeat('0.9.7.52', undefined, t2);
    assert.equal((await w.service.check(t2)).api, 'waiting');
    assert.equal((await w.service.check(t2 + BEHIND_CARD_DEBOUNCE_MS)).api, 'sent');
    assert.equal(w.cards.length, 2);
  });

  it('a later version still behind is a new card, after its own ten minutes', async () => {
    const w = world();
    await w.peers.observeHeartbeat('0.9.7.51', undefined, T0);
    await w.service.check(T0);
    await w.service.check(T0 + BEHIND_CARD_DEBOUNCE_MS);
    assert.equal(w.cards.length, 1);

    const t1 = T0 + 15 * MINUTE;
    await w.peers.observeHeartbeat('0.9.7.52', undefined, t1);
    assert.equal((await w.service.check(t1)).api, 'waiting');
    assert.equal((await w.service.check(t1 + BEHIND_CARD_DEBOUNCE_MS)).api, 'sent');
    assert.deepEqual(w.cards.map((card) => card.metadata['cabinetVersion']), ['0.9.7.51', '0.9.7.52']);
  });

  it('nothing for a surface never seen, for one silent for a day, or for a 0.9.7.53 cabinet', async () => {
    const never = world();
    assert.deepEqual(await never.service.check(T0 + 60 * MINUTE), { api: 'not-compared', bot: 'not-compared' });

    const silent = world();
    await silent.peers.observeHeartbeat('0.9.7.52', undefined, T0);
    await silent.service.check(T0);
    const dayLater = T0 + 24 * 60 * MINUTE + 1;
    assert.equal((await silent.service.check(dayLater)).api, 'not-compared');
    assert.equal(silent.cache.read(behindKey('api')), undefined, 'the mark is dropped');
    assert.deepEqual(silent.cards, []);

    const current = world();
    await current.peers.observePoll('api', undefined, T0);
    await current.peers.observePoll('bot', undefined, T0);
    await current.service.check(T0);
    assert.deepEqual(await current.service.check(T0 + BEHIND_CARD_DEBOUNCE_MS), { api: 'caught-up', bot: 'caught-up' });
    assert.deepEqual(current.cards, []);
  });

  it('no card for a cabinet updated to 0.9.7.53 whose boot heartbeat was lost (review R1-05)', async () => {
    const w = world();
    await w.peers.observeHeartbeat('0.9.7.52', undefined, T0);
    // Updated five minutes later; the boot heartbeat never arrives, the polls do.
    const pollUntil = async (from: number, to: number) => {
      for (let t = from; t <= to; t += MINUTE) await w.peers.observePoll('api', undefined, t);
    };
    await pollUntil(T0 + 5 * MINUTE, T0 + 10 * MINUTE);
    assert.equal((await w.service.check(T0 + 10 * MINUTE)).api, 'caught-up');
    await pollUntil(T0 + 11 * MINUTE, T0 + 25 * MINUTE);
    assert.equal((await w.service.check(T0 + 25 * MINUTE)).api, 'caught-up');
    assert.deepEqual(w.cards, [], 'no «Кабинет Reiwa 0.9.7.52 старше» while 0.9.7.53 runs');
  });

  it('no card after a cabinet updated, rolled back and updated again (review R1-17)', async () => {
    const w = world();
    const HOUR = 60 * MINUTE;
    await w.peers.observeHeartbeat('0.9.7.52', undefined, T0);
    // Updated to 0.9.7.53 for two days: a poll every five minutes, a heartbeat hourly.
    const updated = T0 + 10 * MINUTE;
    const back = updated + 48 * HOUR;
    for (let t = updated; t < back; t += 5 * MINUTE) {
      await w.peers.observePoll('api', undefined, w.at(t));
      if ((t - updated) % HOUR === 0) await w.peers.observeHeartbeat('0.9.7.53', undefined, t);
    }
    // Rolled back to 0.9.7.52: its boot heartbeat lands, then hourly. No sweep
    // carded it (a rollback shorter than the card's ten minutes, say).
    for (let t = back; t <= back + 2 * HOUR; t += HOUR) await w.peers.observeHeartbeat('0.9.7.52', undefined, w.at(t));
    // Updated to 0.9.7.53 again, 30 minutes after that heartbeat: it would count for 35 more.
    const again = back + 2 * HOUR + 30 * MINUTE;
    await w.peers.observeHeartbeat('0.9.7.53', undefined, w.at(again));
    for (let t = again; t <= again + 40 * MINUTE; t += MINUTE) {
      await w.peers.observePoll('api', undefined, w.at(t));
      if ((t - again) % (5 * MINUTE) === 0) {
        assert.equal((await w.service.check(t)).api, 'caught-up', `${(t - again) / MINUTE} min after the re-update`);
      }
    }
    assert.deepEqual(w.cards, [], 'no «Кабинет Reiwa 0.9.7.52 старше» while 0.9.7.53 runs again');
  });

  it('a cache it cannot read decides nothing', async () => {
    const w = world();
    await w.peers.observeHeartbeat('0.9.7.52', undefined, T0);
    await w.service.check(T0);
    w.cache.down();
    assert.deepEqual(await w.service.check(T0 + BEHIND_CARD_DEBOUNCE_MS), { api: 'unreadable', bot: 'unreadable' });
    w.cache.down(false);
    w.cache.failing();
    assert.deepEqual(await w.service.check(T0 + BEHIND_CARD_DEBOUNCE_MS), { api: 'unreadable', bot: 'unreadable' });
    assert.deepEqual(w.cards, []);
  });

  it('runs only in the process that runs schedules', async () => {
    const w = world();
    await w.peers.observeHeartbeat('0.9.7.52', undefined, Date.now());
    process.env.RUID_PROCESS_ROLE = 'api';
    _resetProcessRoleCacheForTests();
    await w.service.sweep();
    assert.equal(w.cache.read(behindKey('api')), undefined, 'the API container does not sweep');
    process.env.RUID_PROCESS_ROLE = 'worker';
    _resetProcessRoleCacheForTests();
    await w.service.sweep();
    assert.notEqual(w.cache.read(behindKey('api')), undefined);
  });
});
