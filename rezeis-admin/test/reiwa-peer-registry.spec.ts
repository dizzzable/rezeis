import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { configReportKey } from '../src/modules/bot-config/config-versions/config-versions.constants';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { AdminReiwaPeersController } from '../src/modules/reiwa-peers/admin-reiwa-peers.controller';
import {
  CABINET_CAPABILITY,
  CABINET_FLOOR_VERSION,
  capabilityRowsHostedBy,
} from '../src/modules/reiwa-peers/cabinet-capabilities';
import { PANEL_VERSION } from '../src/modules/reiwa-peers/panel-capabilities';
import {
  BOOT_GRACE_MS,
  HEARTBEAT_LIVE_WINDOW_MS,
  LEGACY_POLL_INSTANCE,
  legacyHeartbeatInstance,
  MAX_PEER_RECORDS,
  PEER_LIVE_WINDOW_MS,
  PEER_VIEW_CACHE_MS,
  peerIndexKey,
  peerKey,
  peerSilentIndexKey,
} from '../src/modules/reiwa-peers/reiwa-peers.constants';
import { ReiwaPeerRegistry } from '../src/modules/reiwa-peers/reiwa-peer-registry.service';
import { memoryRawCache } from './helpers/memory-raw-cache';

/**
 * What the panel knows about the connected cabinet
 * ════════════════════════════════════════════════
 * The records the cabinet's poll and heartbeat leave, and the two answers the
 * gates ask: `viewOfRequest` (a money gate: this caller, from its own headers)
 * and `view` (the panel's own behaviour: the surface, from the records).
 *
 * The rules pinned here are the ones a regression would quietly move:
 *  - a poll without headers is 0.9.7.53, and 0.9.7.53 can show «до сброса» —
 *    it is the cabinet in every "panel first" gap of this pair;
 *  - a heartbeat of 0.9.7.52 cannot;
 *  - a process counts for ten minutes after it was last seen (65 for a record
 *    only the hourly heartbeat refreshes), and then the last-known answer
 *    stands until 30 days;
 *  - several processes: the intersection;
 *  - review R1: silent heartbeats are filed per version; nothing is deleted
 *    when a declaring process writes; a record is superseded, when READ, only
 *    by a newer or declaring record that first appeared after it was last
 *    refreshed; a heartbeat claiming 0.9.7.53 needs a live poll; the panel's
 *    own restart gets a grace; each surface keeps at most 32 records;
 *  - review R1 round 3: a record written after a gap longer than its window
 *    is first seen again at that write (R1-17); declared and silent records
 *    are indexed apart, and a live silent record is never trimmed (R1-19);
 *  - Redis trouble is "no evidence", never a throw.
 */

const T0 = Date.parse('2026-09-26T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A registry whose process started a day before T0 — no boot grace — unless the case says otherwise. */
function registry(startedAt = T0 - DAY) {
  let now = T0;
  const cache = memoryRawCache({ now: () => now });
  return {
    peers: new ReiwaPeerRegistry(cache.store, startedAt),
    cache,
    at: (value: number) => {
      now = value;
    },
  };
}

function headers(client: string, capabilities?: string): Record<string, string> {
  return {
    'x-reiwa-client': client,
    ...(capabilities === undefined ? {} : { 'x-reiwa-capabilities': capabilities }),
  };
}

const API_054 = 'surface=api; version=0.9.7.54; commit=0123456789ab; instance=reiwa';
const BOT_054 = 'surface=bot; version=0.9.7.54; commit=0123456789ab; instance=reiwa-bot';
const EVERYTHING_API = capabilityRowsHostedBy('api').map((row) => row.id).join(',');
const EVERYTHING_BOT = capabilityRowsHostedBy('bot').map((row) => row.id).join(',');
const RESET_END = CABINET_CAPABILITY.addonResetEnd;

describe('a silent cabinet, placed by the evidence it leaves', () => {
  it('a poll without headers is 0.9.7.53 — which can show «до сброса»', async () => {
    const { peers, cache } = registry();
    await peers.observePoll('api', {}, T0);

    const record = cache.read(peerKey('api', LEGACY_POLL_INSTANCE.api)) as Record<string, unknown>;
    assert.equal(record['source'], 'poll');
    assert.equal(record['version'], '0.9.7.53');
    const web = await peers.view('web', T0);
    assert.equal(web.can(RESET_END), true, 'the 0.9.7.53 cabinet keeps «до сброса»');
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0)).can(RESET_END), true);
    const status = await peers.surfaceStatus('api', T0);
    assert.equal(status.state, 'live');
    assert.deepEqual(status.missing, [], 'nothing this panel registered is missing from 0.9.7.53');
  });

  it('a heartbeat of 0.9.7.52 without headers cannot show it', async () => {
    const { peers, cache } = registry();
    await peers.observeHeartbeat('0.9.7.52', undefined, T0);

    const record = cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.52'))) as Record<string, unknown>;
    assert.deepEqual([record['source'], record['version']], ['heartbeat', '0.9.7.52']);
    assert.equal((await peers.view('web', T0)).can(RESET_END), false);
    assert.equal((await peers.viewOfRequest({}, 'api', T0)).can(RESET_END), false);
    const status = await peers.surfaceStatus('api', T0);
    assert.equal(status.version, '0.9.7.52');
    assert.deepEqual(
      status.missing.map((row) => row.id),
      capabilityRowsHostedBy('api').map((row) => row.id).sort((a, b) => Number(a !== RESET_END) - Number(b !== RESET_END)),
    );
    assert.equal(status.missing[0]?.kind, 'gate', 'the withheld sale is named first');
  });

  it('no evidence at all is the floor, which sells nothing new', async () => {
    const { peers } = registry();
    const silent = await peers.viewOfRequest(undefined, 'api', T0);
    assert.equal(silent.can(RESET_END), false);
    assert.match(silent.basis, new RegExp(CABINET_FLOOR_VERSION.replace(/\./g, '\\.')));
    const status = await peers.surfaceStatus('api', T0);
    assert.equal(status.state, 'never');
    assert.equal(status.view.can(RESET_END), false);
  });

  it('the bot is its own surface: its poll speaks for the bot, never for the web', async () => {
    const { peers } = registry();
    await peers.observePoll('bot', undefined, T0);
    assert.equal((await peers.view('bot', T0)).can(CABINET_CAPABILITY.staleButtonMenu), true);
    assert.equal((await peers.view('web', T0)).can(RESET_END), false);
    assert.equal((await peers.surfaceStatus('api', T0)).state, 'never');
    // A consumer this panel does not know files nothing.
    await peers.observePoll('worker', undefined, T0);
    assert.equal((await peers.snapshot(T0)).surfaces.api.instances.length, 0);
  });
});

describe('live, quiet and never', () => {
  it(`a poll record is live for exactly ${PEER_LIVE_WINDOW_MS / MINUTE} minutes, then the last-known answer stands`, async () => {
    // The owner's ten minutes (D3): more than the poll's longest backoff (5
    // min), and the card's debounce. Pinned as a number, not only as itself.
    assert.equal(PEER_LIVE_WINDOW_MS, 10 * MINUTE);
    assert.equal(HEARTBEAT_LIVE_WINDOW_MS, 65 * MINUTE);
    const { peers } = registry();
    await peers.observePoll('api', undefined, T0);

    assert.equal((await peers.surfaceStatus('api', T0 + PEER_LIVE_WINDOW_MS)).state, 'live');
    const quiet = await peers.surfaceStatus('api', T0 + PEER_LIVE_WINDOW_MS + 1);
    assert.equal(quiet.state, 'quiet');
    assert.equal(quiet.view.can(RESET_END), true, 'quiet keeps the last known answer');
    // …but a money gate only trusts LIVE silent evidence.
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + PEER_LIVE_WINDOW_MS)).can(RESET_END), true);
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + PEER_LIVE_WINDOW_MS + 1)).can(RESET_END), false);
  });

  it(`a heartbeat record is live for ${HEARTBEAT_LIVE_WINDOW_MS / MINUTE} minutes`, async () => {
    const { peers } = registry();
    await peers.observeHeartbeat('0.9.7.52', undefined, T0);
    assert.equal((await peers.surfaceStatus('api', T0 + HEARTBEAT_LIVE_WINDOW_MS)).state, 'live');
    assert.equal((await peers.surfaceStatus('api', T0 + HEARTBEAT_LIVE_WINDOW_MS + 1)).state, 'quiet');
  });
});

describe('several cabinets on one panel (review R1-01, R1-04)', () => {
  it('files each silent heartbeat under its version: 0.9.7.52 and 0.9.7.53 coexist', async () => {
    const { peers, cache } = registry();
    await peers.observeHeartbeat('0.9.7.53', undefined, T0);
    await peers.observeHeartbeat('0.9.7.52', undefined, T0 + MINUTE);
    await peers.observeHeartbeat('0.9.7.53', undefined, T0 + 2 * MINUTE);
    assert.notEqual(cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.52'))), undefined);
    assert.notEqual(cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.53'))), undefined);
    assert.deepEqual(cache.index(peerIndexKey('api')), [], 'silent records are indexed apart');
    assert.deepEqual(cache.index(peerSilentIndexKey('api')).sort(), [
      legacyHeartbeatInstance('0.9.7.52'),
      legacyHeartbeatInstance('0.9.7.53'),
    ]);
  });

  it('a silent 0.9.7.52 beside a running 0.9.7.53 keeps the gate closed for every silent caller', async () => {
    const { peers } = registry();
    // For a day, production on 0.9.7.53 polls (every five minutes here) and
    // heartbeats hourly, and staging on 0.9.7.52 heartbeats hourly beside it.
    for (let t = T0 - DAY; t <= T0; t += 5 * MINUTE) {
      await peers.observePoll('api', undefined, t);
      if ((t - T0) % HOUR === -20 * MINUTE) await peers.observeHeartbeat('0.9.7.53', undefined, t);
      if ((t - T0) % HOUR === -30 * MINUTE) await peers.observeHeartbeat('0.9.7.52', undefined, t);
    }

    const silent = await peers.viewOfRequest(undefined, 'api', T0 + MINUTE);
    assert.equal(silent.can(RESET_END), false, 'the 0.9.7.52 caller is not sold «до сброса»');
    assert.match(silent.basis, /legacy-heartbeat-api:0\.9\.7\.52/);
    const status = await peers.surfaceStatus('api', T0 + MINUTE);
    assert.equal(status.version, '0.9.7.52');
  });

  it('a newer silent record supersedes an older one only while the older is not refreshed after it appeared', async () => {
    const { peers } = registry();
    // 0.9.7.52's last heartbeat, then a 0.9.7.53 first appears: the same cabinet, updated in place.
    await peers.observeHeartbeat('0.9.7.52', undefined, T0);
    await peers.observePoll('api', undefined, T0 + MINUTE);
    await peers.observeHeartbeat('0.9.7.53', undefined, T0 + 2 * MINUTE);
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + 3 * MINUTE)).can(RESET_END), true);

    // It heartbeats again while the 0.9.7.53 keeps polling: it was a second
    // cabinet all along, and is back in the intersection.
    for (let t = T0 + 2 * MINUTE; t < T0 + 50 * MINUTE; t += MINUTE) await peers.observePoll('api', undefined, t);
    await peers.observeHeartbeat('0.9.7.52', undefined, T0 + 50 * MINUTE);
    await peers.observePoll('api', undefined, T0 + 51 * MINUTE);
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + 51 * MINUTE)).can(RESET_END), false);
  });

  it('a declaring cabinet deletes nothing: a silent 0.9.7.53 beside it is still served, and counted in the view', async () => {
    const { peers, cache } = registry();
    await peers.observePoll('api', undefined, T0);
    await peers.observeHeartbeat('0.9.7.53', undefined, T0);
    // Staging on 0.9.7.54 starts declaring.
    await peers.observePoll('api', headers(API_054.replace('instance=reiwa', 'instance=reiwa-staging'), EVERYTHING_API), T0 + 5_000);

    assert.notEqual(cache.read(peerKey('api', LEGACY_POLL_INSTANCE.api)), undefined);
    assert.notEqual(cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.53'))), undefined);
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + 6_000)).can(RESET_END), true, 'production is still served');

    // Production keeps polling: the page counts both.
    await peers.observePoll('api', undefined, T0 + 20_000);
    const status = await peers.surfaceStatus('api', T0 + 21_000);
    assert.deepEqual(status.basis.map((record) => record.instance).sort(), [LEGACY_POLL_INSTANCE.api, 'reiwa-staging'].sort());
  });

  it('a cabinet updated in place to one that declares: its silent records are superseded when read', async () => {
    const { peers } = registry();
    await peers.observePoll('api', undefined, T0);
    await peers.observeHeartbeat('0.9.7.53', undefined, T0);
    await peers.observePoll('api', headers(API_054, EVERYTHING_API), T0 + MINUTE);

    const status = await peers.surfaceStatus('api', T0 + MINUTE);
    assert.deepEqual(status.basis.map((record) => record.instance), ['reiwa']);
    assert.equal(status.state, 'live');
    const snapshot = await peers.snapshot(T0 + MINUTE);
    assert.equal(snapshot.surfaces.api.declared, true);
    assert.deepEqual(
      snapshot.surfaces.api.instances.map((instance) => [instance.instance, instance.counted]).sort(),
      [
        ['legacy-heartbeat-api:0.9.7.53', false],
        [LEGACY_POLL_INSTANCE.api, false],
        ['reiwa', true],
      ],
    );
    // A rollback: the silent process polls again after the declaration, and counts again.
    await peers.observePoll('api', undefined, T0 + 2 * MINUTE);
    const rolledBack = await peers.surfaceStatus('api', T0 + 2 * MINUTE);
    assert.deepEqual(rolledBack.basis.map((record) => record.instance).sort(), [LEGACY_POLL_INSTANCE.api, 'reiwa'].sort());
  });
});

describe('an update whose boot heartbeat was lost (review R1-05)', () => {
  it('0.9.7.52 → 0.9.7.53: the stale 0.9.7.52 heartbeat is dropped once the 0.9.7.53 polls — sold, no «behind»', async () => {
    const { peers } = registry();
    await peers.observeHeartbeat('0.9.7.52', undefined, T0);
    for (let t = T0 + 5 * MINUTE; t <= T0 + 40 * MINUTE; t += MINUTE) await peers.observePoll('api', undefined, t);

    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + 40 * MINUTE)).can(RESET_END), true);
    const status = await peers.surfaceStatus('api', T0 + 40 * MINUTE);
    assert.deepEqual([status.version, status.missing.length], ['0.9.7.53', 0]);
  });

  it('0.9.7.53 → 0.9.7.52: a 0.9.7.53 heartbeat counts only while a 0.9.7.53 poll is live', async () => {
    const { peers } = registry();
    await peers.observeHeartbeat('0.9.7.53', undefined, T0);
    await peers.observePoll('api', undefined, T0);
    // Rolled back; the 0.9.7.52 boot heartbeat is lost, and 0.9.7.52 does not poll.
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + PEER_LIVE_WINDOW_MS)).can(RESET_END), true);
    const later = await peers.viewOfRequest(undefined, 'api', T0 + PEER_LIVE_WINDOW_MS + MINUTE);
    assert.equal(later.can(RESET_END), false, 'the heartbeat is 11 minutes old and still in its window, but no poll backs it');
  });
});

describe('a cabinet updated, rolled back and updated again (review R1-17)', () => {
  /**
   * The reviewer's P6 at the cabinet's own cadence: 0.9.7.52; updated to
   * 0.9.7.53 for two days (a poll every five minutes, a heartbeat hourly);
   * rolled back to 0.9.7.52 for two and a half hours (its boot heartbeat lands,
   * then hourly); updated to 0.9.7.53 again, its boot heartbeat landing — all
   * within the records' 30 days. `after` observes the re-update. Answers when
   * it started.
   */
  async function updateRollBackUpdateAgain(before: ReiwaPeerRegistry, after: ReiwaPeerRegistry): Promise<number> {
    await before.observeHeartbeat('0.9.7.52', undefined, T0);
    const updated = T0 + 10 * MINUTE;
    const back = updated + 2 * DAY;
    for (let t = updated; t < back; t += 5 * MINUTE) {
      await before.observePoll('api', undefined, t);
      if ((t - updated) % HOUR === 0) await before.observeHeartbeat('0.9.7.53', undefined, t);
    }
    for (let t = back; t <= back + 2 * HOUR; t += HOUR) await before.observeHeartbeat('0.9.7.52', undefined, t);
    const again = back + 2 * HOUR + 30 * MINUTE;
    await after.observeHeartbeat('0.9.7.53', undefined, again);
    await after.observePoll('api', undefined, again);
    return again;
  }

  for (const restarted of [false, true]) {
    const label = restarted ? 'the panel restarted during the rollback' : 'one process of the panel throughout';
    it(`the re-updated 0.9.7.53 is served at once and the site is not behind — ${label}`, async () => {
      const { peers, cache } = registry();
      // A process with no memory of the records, started an hour into the rollback: its boot grace is over by the re-update.
      const after = restarted ? new ReiwaPeerRegistry(cache.store, T0 + 10 * MINUTE + 2 * DAY + HOUR) : peers;
      const again = await updateRollBackUpdateAgain(peers, after);

      const status = await after.surfaceStatus('api', again);
      assert.deepEqual([status.version, status.missing.length], ['0.9.7.53', 0], 'the rolled-back 0.9.7.52 is superseded');
      // Its last heartbeat was 30 minutes before the re-update: it would have counted until 35 minutes after.
      for (let t = again; t <= again + 40 * MINUTE; t += MINUTE) {
        await after.observePoll('api', undefined, t);
        const view = await after.viewOfRequest(undefined, 'api', t);
        assert.equal(view.can(RESET_END), true, `served ${(t - again) / MINUTE} min after the re-update: ${view.basis}`);
      }
    });
  }
});

describe('the panel’s own restart (review R1-06)', () => {
  it('for ten minutes after it starts, a silent record seen within a day counts as live', async () => {
    // The last hourly heartbeat 59 minutes before an 8-minute outage, the last poll at its start.
    const setUp = async (startedAt: number) => {
      const r = registry(startedAt);
      await r.peers.observeHeartbeat('0.9.7.53', undefined, T0 - 59 * MINUTE);
      await r.peers.observePoll('api', undefined, T0);
      return r.peers;
    };
    const restarted = await setUp(T0 + 8 * MINUTE);
    assert.equal(BOOT_GRACE_MS, 10 * MINUTE);
    assert.equal((await restarted.viewOfRequest(undefined, 'api', T0 + 11 * MINUTE)).can(RESET_END), true);
    assert.equal((await restarted.surfaceStatus('api', T0 + 11 * MINUTE)).state, 'live');
    // The grace ends ten minutes after the start.
    assert.equal((await restarted.viewOfRequest(undefined, 'api', T0 + 8 * MINUTE + BOOT_GRACE_MS)).can(RESET_END), false);

    const runningAllAlong = await setUp(T0 - DAY);
    assert.equal((await runningAllAlong.viewOfRequest(undefined, 'api', T0 + 11 * MINUTE)).can(RESET_END), false);
  });

  it('a record older than a day is not revived', async () => {
    const { peers } = registry(T0);
    await peers.observePoll('api', undefined, T0 - DAY - MINUTE);
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + MINUTE)).can(RESET_END), false);
  });
});

describe('a bounded record set (review R1-07)', () => {
  it('70 made-up bot instances neither hide the live site nor grow the store past 32 per surface', async () => {
    const { peers, cache } = registry();
    for (let i = 0; i < 70; i += 1) {
      await peers.observePoll('bot', headers(`surface=bot; version=0.9.7.54; instance=junk-${i}`, ''), T0 + i);
    }
    await peers.observePoll('api', headers(API_054, EVERYTHING_API), T0 + 100);

    const snapshot = await peers.snapshot(T0 + 1_000);
    assert.equal(snapshot.surfaces.api.state, 'live');
    assert.equal((await peers.view('web', T0 + 1_000)).can(RESET_END), true);
    assert.equal(MAX_PEER_RECORDS, 32);
    const botIndex = cache.index(peerIndexKey('bot'));
    assert.equal(botIndex.length, MAX_PEER_RECORDS);
    assert.deepEqual(botIndex[0], 'junk-38', 'the newest 32 are kept');
    const botRecords = [...cache.data.keys()].filter((key) => key.startsWith(peerKey('bot', '')));
    assert.equal(botRecords.length, MAX_PEER_RECORDS, 'the trimmed records are deleted with their index entries');
    assert.equal(cache.read(peerKey('bot', 'junk-0')), undefined);
  });

  it('made-up declaring instances never push out a silent cabinet’s evidence (review R1-19)', async () => {
    const { peers, cache } = registry();
    // A 0.9.7.53 cabinet polling all along, and a 0.9.7.52 beside it that heartbeats at T0.
    for (let t = T0 - HOUR; t <= T0; t += MINUTE) await peers.observePoll('api', undefined, t);
    await peers.observeHeartbeat('0.9.7.52', undefined, T0);
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + 30_000)).can(RESET_END), false);

    // A token holder makes up 40 declaring instances within a minute.
    for (let i = 0; i < 40; i += 1) {
      const madeUp = headers(API_054.replace('instance=reiwa', `instance=made-up-${i}`), EVERYTHING_API);
      await peers.observePoll('api', madeUp, T0 + MINUTE + i);
    }
    await peers.observePoll('api', undefined, T0 + 2 * MINUTE);

    assert.equal(cache.index(peerIndexKey('api')).length, MAX_PEER_RECORDS, 'they push out only each other');
    assert.deepEqual(
      cache.index(peerSilentIndexKey('api')).sort(),
      [legacyHeartbeatInstance('0.9.7.52'), LEGACY_POLL_INSTANCE.api].sort(),
    );
    assert.notEqual(cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.52'))), undefined, 'nothing silent is deleted');
    const silent = await peers.viewOfRequest(undefined, 'api', T0 + 2 * MINUTE + 1_000);
    assert.equal(silent.can(RESET_END), false, `the silent 0.9.7.52 caller is still refused: ${silent.basis}`);
  });

  it('the silent index is trimmed past 32 only of records that can no longer count (review R1-19)', async () => {
    const { peers, cache } = registry();
    await peers.observeHeartbeat('0.9.7.40', undefined, T0 - 2 * HOUR);
    await peers.observeHeartbeat('0.9.7.52', undefined, T0);
    // Heartbeats naming 40 made-up versions within a minute.
    for (let i = 0; i < 40; i += 1) await peers.observeHeartbeat(`0.9.6.${i}`, undefined, T0 + MINUTE + i);

    const silent = cache.index(peerSilentIndexKey('api'));
    assert.equal(silent.includes(legacyHeartbeatInstance('0.9.7.52')), true, 'a live record stays past the cap');
    assert.notEqual(cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.52'))), undefined);
    assert.equal(silent.length, 41, 'more than 32 only while they are live');
    assert.equal(silent.includes(legacyHeartbeatInstance('0.9.7.40')), false, 'one past its window goes');
    assert.equal(cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.40'))), undefined, 'with its record');
  });

  it('a silent entry an earlier build left in the declared index is dropped from it, its record kept', async () => {
    const { peers, cache } = registry();
    for (let t = T0 - HOUR; t <= T0; t += MINUTE) await peers.observePoll('api', undefined, t);
    await peers.observeHeartbeat('0.9.7.52', undefined, T0 - MINUTE);
    // Where the build before round 3 filed it, too.
    await cache.store.sortedIndexAdd(peerIndexKey('api'), legacyHeartbeatInstance('0.9.7.52'), T0 - MINUTE, {
      cap: MAX_PEER_RECORDS,
      ttlSeconds: 60,
    });
    for (let i = 0; i < MAX_PEER_RECORDS; i += 1) {
      await peers.observePoll('api', headers(API_054.replace('instance=reiwa', `instance=made-up-${i}`), EVERYTHING_API), T0 + i);
    }
    await peers.observePoll('api', undefined, T0 + MINUTE);

    assert.equal(cache.index(peerIndexKey('api')).includes(legacyHeartbeatInstance('0.9.7.52')), false);
    assert.notEqual(cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.52'))), undefined);
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + MINUTE)).can(RESET_END), false);
  });
});

describe('a declaring cabinet', () => {
  it('is judged by what it declared, on the request itself, without reading the store', async () => {
    const { peers, cache } = registry();
    const before = cache.commands.length;
    const view = await peers.viewOfRequest(headers(API_054, EVERYTHING_API), 'api', T0);
    assert.equal(view.can(RESET_END), true);
    assert.equal(cache.commands.length, before, 'no storage read for a declaring caller');

    const without = await peers.viewOfRequest(headers(API_054, CABINET_CAPABILITY.appearanceReport), 'api', T0);
    assert.equal(without.can(RESET_END), false, 'exactly what it declared');
    const nothing = await peers.viewOfRequest(headers(API_054), 'api', T0);
    assert.equal(nothing.can(RESET_END), false, 'a declaration without the list declares nothing');
  });

  it('the worker declares itself with an empty list: nothing is filed, and it is never taken for a silent 0.9.7.53', async () => {
    const { peers, cache } = registry();
    const worker = headers('surface=worker; version=0.9.7.54; instance=reiwa-worker', '');
    await peers.observePoll('api', worker, T0);
    await peers.observeHeartbeat('0.9.7.54', worker, T0);
    assert.deepEqual([...cache.data.keys()], [], 'no record, and no legacy one');
    assert.deepEqual([...cache.sets.keys()], []);
    assert.equal((await peers.viewOfRequest(worker, 'api', T0)).can(RESET_END), false);
  });

  it('a heartbeat with headers only refreshes the declared record and files no silent one', async () => {
    const { peers, cache } = registry();
    await peers.observeHeartbeat('0.9.7.54', headers(API_054, EVERYTHING_API), T0);
    assert.deepEqual(cache.index(peerIndexKey('api')), ['reiwa']);
    const record = cache.read(peerKey('api', 'reiwa')) as Record<string, unknown>;
    assert.deepEqual([record['source'], record['version']], ['declared', '0.9.7.54']);
  });

  it('several processes of a surface: only what every live one can do', async () => {
    const { peers } = registry();
    await peers.observePoll('api', headers(API_054, EVERYTHING_API), T0);
    await peers.observePoll(
      'api',
      headers('surface=api; version=0.9.7.54; instance=staging', CABINET_CAPABILITY.appearanceReport),
      T0,
    );
    const web = await peers.view('web', T0);
    assert.equal(web.can(RESET_END), false);
    assert.equal(web.can(CABINET_CAPABILITY.appearanceReport), true);
    // Staging stops; ten minutes later the one still polling decides alone.
    await peers.observePoll('api', headers(API_054, EVERYTHING_API), T0 + 11 * MINUTE);
    assert.equal((await peers.surfaceStatus('api', T0 + 11 * MINUTE)).view.can(RESET_END), true);
  });

  it('keeps when this build was first seen across its polls, and starts again with a new version', async () => {
    const { peers, cache } = registry();
    await peers.observePoll('api', headers(API_054, EVERYTHING_API), T0);
    await peers.observePoll('api', headers(API_054, EVERYTHING_API), T0 + MINUTE);
    const first = cache.read(peerKey('api', 'reiwa')) as Record<string, number>;
    assert.deepEqual([first['firstSeenAt'], first['lastSeenAt']], [T0, T0 + MINUTE]);

    const fresh = new ReiwaPeerRegistry(cache.store, T0 - DAY); // another process, no memory of it
    await fresh.observePoll('api', headers(API_054, EVERYTHING_API), T0 + 2 * MINUTE);
    assert.equal((cache.read(peerKey('api', 'reiwa')) as Record<string, number>)['firstSeenAt'], T0);

    const newer = headers(API_054.replace('0.9.7.54', '0.9.7.55'), EVERYTHING_API);
    await peers.observePoll('api', newer, T0 + 3 * MINUTE);
    assert.equal((cache.read(peerKey('api', 'reiwa')) as Record<string, number>)['firstSeenAt'], T0 + 3 * MINUTE);

    // Silent for exactly its window: the same appearance. For longer: a new one (review R1-17).
    const edge = T0 + 3 * MINUTE + PEER_LIVE_WINDOW_MS;
    await peers.observePoll('api', newer, edge);
    assert.equal((cache.read(peerKey('api', 'reiwa')) as Record<string, number>)['firstSeenAt'], T0 + 3 * MINUTE);
    await peers.observePoll('api', newer, edge + PEER_LIVE_WINDOW_MS + 1);
    assert.equal((cache.read(peerKey('api', 'reiwa')) as Record<string, number>)['firstSeenAt'], edge + PEER_LIVE_WINDOW_MS + 1);
  });

  it('counts what it declared that this panel does not know — a cabinet newer than the panel', async () => {
    const { peers } = registry();
    await peers.observePoll('api', headers(API_054, `${EVERYTHING_API},web.from-the-future,api.also-new`), T0);
    const snapshot = await peers.snapshot(T0);
    assert.equal(snapshot.surfaces.api.unknownToPanel, 2);
    assert.equal(snapshot.surfaces.api.declared, true);
    assert.equal(snapshot.surfaces.api.behind, false);
  });
});

describe('the first boot of this release', () => {
  it('takes the previous panel’s poll report as a silent 0.9.7.53, and only for a surface with no record', async () => {
    const { peers, cache } = registry(T0);
    await cache.store.set(configReportKey('api'), { held: {}, reportedAt: T0 - 40 * MINUTE });
    await cache.store.set(configReportKey('bot'), { held: {}, reportedAt: T0 - DAY - MINUTE });

    assert.equal(await peers.adoptPollReports(T0), true);
    const api = cache.read(peerKey('api', LEGACY_POLL_INSTANCE.api)) as Record<string, unknown>;
    assert.deepEqual([api['source'], api['version'], api['lastSeenAt']], ['poll', '0.9.7.53', T0 - 40 * MINUTE]);
    assert.equal(cache.read(peerKey('bot', LEGACY_POLL_INSTANCE.bot)), undefined, 'a report older than a day is not evidence');
    // A 40-minute update: the boot grace counts the adopted record.
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0 + MINUTE)).can(RESET_END), true);

    // A surface the cabinet already spoke for is left alone.
    const declared = registry(T0);
    await declared.peers.observePoll('api', headers(API_054, EVERYTHING_API), T0);
    await declared.cache.store.set(configReportKey('api'), { held: {}, reportedAt: T0 });
    await declared.peers.adoptPollReports(T0);
    assert.equal(declared.cache.read(peerKey('api', LEGACY_POLL_INSTANCE.api)), undefined);
  });

  it('asks to be retried while the cache is not connected', async () => {
    const { peers, cache } = registry();
    cache.down();
    assert.equal(await peers.adoptPollReports(T0), false);
  });

  it('reiwa’s /health is filed only while nothing is known about the site', async () => {
    const { peers, cache } = registry();
    await peers.observeHealth('0.9.7.53', T0);
    const health = cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.53'))) as Record<string, unknown>;
    assert.deepEqual([health['source'], health['version']], ['health', '0.9.7.53']);

    const known = registry();
    await known.peers.observeHeartbeat('0.9.7.52', undefined, T0);
    await known.peers.observeHealth('0.9.7.53', T0 + MINUTE);
    assert.equal(known.cache.read(peerKey('api', legacyHeartbeatInstance('0.9.7.53'))), undefined);
  });
});

describe('when the cache misbehaves', () => {
  it('a command error is no evidence: nothing throws, gates take the floor', async () => {
    const { peers, cache } = registry();
    await peers.observePoll('api', undefined, T0);
    cache.failing();
    await assert.doesNotReject(() => peers.observePoll('api', undefined, T0));
    await assert.doesNotReject(() => peers.observeHeartbeat('0.9.7.53', undefined, T0));
    await assert.doesNotReject(() => peers.observeHealth('0.9.7.53', T0));
    assert.equal((await peers.viewOfRequest(undefined, 'api', T0)).can(RESET_END), false);
    const status = await peers.surfaceStatus('api', T0);
    assert.equal(status.state, 'unavailable');
    assert.equal(status.view.can(RESET_END), false);
    assert.equal((await peers.snapshot(T0)).surfaces.api.state, 'unavailable');
    assert.deepEqual(await peers.behindSurfaces(T0), [], 'unknown is not behind');
    assert.equal(await peers.knownView('web', T0), null, 'unknown is not written down anywhere');
    // A declaring caller does not need the cache at all.
    assert.equal((await peers.viewOfRequest(headers(API_054, EVERYTHING_API), 'api', T0)).can(RESET_END), true);
  });

  it('a cache that is not connected reads as unavailable, not as never', async () => {
    const { peers, cache } = registry();
    cache.down();
    assert.equal((await peers.surfaceStatus('bot', T0)).state, 'unavailable');
  });
});

describe('what the panel does with it', () => {
  it('view() is cached for 15 s in the process', async () => {
    const { peers } = registry();
    assert.equal((await peers.view('web', T0)).can(RESET_END), false);
    await peers.observePoll('api', undefined, T0 + 1_000);
    assert.equal((await peers.view('web', T0 + 1_000)).can(RESET_END), false, 'still the cached answer');
    assert.equal((await peers.view('web', T0 + PEER_VIEW_CACHE_MS)).can(RESET_END), true);
  });

  it('knownView() is the view only for a surface the panel has heard from', async () => {
    const { peers } = registry();
    assert.equal(await peers.knownView('web', T0), null, 'never');
    await peers.observeHeartbeat('0.9.7.52', undefined, T0 + PEER_VIEW_CACHE_MS);
    assert.equal((await peers.knownView('web', T0 + PEER_VIEW_CACHE_MS))?.can(RESET_END), false);
  });

  it('names the running version: the exact one first, then the poll’s', async () => {
    const { peers } = registry();
    assert.equal(await peers.runningVersion('api', T0), null);
    await peers.observePoll('api', undefined, T0);
    assert.equal(await peers.runningVersion('api', T0), '0.9.7.53');
    await peers.observeHeartbeat('0.9.7.53', undefined, T0 - MINUTE);
    assert.equal(await peers.runningVersion('api', T0), '0.9.7.53');
    await peers.observePoll('api', headers(API_054, EVERYTHING_API), T0 + MINUTE);
    assert.equal(await peers.runningVersion('api', T0 + MINUTE), '0.9.7.54');
  });

  it('snapshot: both surfaces, every instance, the missing capabilities gates first', async () => {
    const { peers } = registry();
    await peers.observeHeartbeat('0.9.7.52', undefined, T0);
    await peers.observePoll('bot', headers(BOT_054, EVERYTHING_BOT), T0);
    const snapshot = await peers.snapshot(T0 + MINUTE);

    assert.equal(snapshot.panelVersion, PANEL_VERSION);
    assert.equal(snapshot.floorVersion, CABINET_FLOOR_VERSION);
    const api = snapshot.surfaces.api;
    assert.deepEqual([api.state, api.version, api.declared, api.behind], ['live', '0.9.7.52', false, true]);
    assert.equal(api.missing[0]?.id, RESET_END);
    assert.ok(api.missing.every((row) => row.operatorText.length > 0 && row.operatorTextEn.length > 0));
    assert.deepEqual(api.instances.map((instance) => [instance.instance, instance.source, instance.live, instance.counted]), [
      [legacyHeartbeatInstance('0.9.7.52'), 'heartbeat', true, true],
    ]);
    const bot = snapshot.surfaces.bot;
    assert.deepEqual([bot.state, bot.version, bot.declared, bot.behind, bot.missing.length], ['live', '0.9.7.54', true, false, 0]);
    assert.deepEqual(await peers.behindSurfaces(T0 + MINUTE), ['api']);
  });
});

describe('GET /api/admin/reiwa-peers', () => {
  it('is behind the admin JWT and settings:view, as the branding delivery notice is', async () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReiwaPeersController), 'admin/reiwa-peers');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminReiwaPeersController.prototype.get), RequestMethod.GET);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminReiwaPeersController), [AdminJwtAuthGuard, RbacGuard]);
    assert.deepEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AdminReiwaPeersController), [
      { resource: 'settings', action: 'view' },
    ]);
    const { peers } = registry();
    const answer = await new AdminReiwaPeersController(peers).get();
    assert.deepEqual(Object.keys(answer.surfaces).sort(), ['api', 'bot']);
  });
});
