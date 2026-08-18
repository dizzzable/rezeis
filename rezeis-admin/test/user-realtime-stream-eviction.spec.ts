import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { InternalUserRealtimeController } from '../src/modules/realtime/controllers/internal-user-realtime.controller';
import { UserRealtimeService } from '../src/modules/realtime/services/user-realtime.service';

/**
 * An evicted SSE stream has to actually close
 * ═══════════════════════════════════════════
 * `UserRealtimeService` caps a user at four concurrent streams and evicts the
 * oldest beyond that. It used to evict by deleting a map entry — and that is
 * all it could do, because the registry holds only the handler while the
 * `Response` and its 25s heartbeat live in the controller, whose cleanup runs
 * on request/response close and on nothing else.
 *
 * The result was a stream that stayed open forever, wrote `: keepalive` every
 * 25s, and delivered zero events. Every party involved thought it was healthy:
 *
 *  - the subscriber's `EventSource` stayed `OPEN`, so `onerror` never fired and
 *    nothing prompted a reconnect;
 *  - the cabinet's idle watchdog — which ends a stream after 60s without
 *    upstream bytes — stayed rearmed by those very keepalives.
 *
 * So the tests below assert the two things that were false, not the one that
 * was already true. Asserting `connectedCount() === 4` passes on the broken
 * code: the map entry WAS removed. What was not happening is the response
 * ending and the heartbeat stopping, and those are what is checked here — with
 * mocked timers, so "the keepalives stopped" is a fact this test observes
 * rather than a claim it repeats.
 */

const HEARTBEAT_INTERVAL_MS = 25_000;

interface FakeStream {
  readonly response: unknown;
  readonly request: unknown;
  readonly writes: string[];
  ended: boolean;
}

function fakeStream(): FakeStream {
  const stream: FakeStream = {
    writes: [],
    ended: false,
    response: null,
    request: null,
  } as unknown as FakeStream;

  const response = {
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    status: () => response,
    write: (chunk: string) => {
      if (stream.ended) throw new Error('write after end');
      stream.writes.push(chunk);
      return true;
    },
    end: () => {
      stream.ended = true;
    },
    get writableEnded() {
      return stream.ended;
    },
    on: () => response,
  };
  const request = { on: () => request };

  (stream as { response: unknown }).response = response;
  (stream as { request: unknown }).request = request;
  return stream;
}

function build() {
  // `moduleRef.get` throws, so `installHookOnce` logs and disables the gateway
  // hook — irrelevant here, the cap runs on `subscribe()` regardless.
  const service = new UserRealtimeService({
    get: () => {
      throw new Error('no gateway in this test');
    },
  } as never);
  const controller = new InternalUserRealtimeController(
    {
      user: {
        findUnique: async () => ({ id: 'user-1', telegramId: 12345n, isBlocked: false }),
      },
    } as never,
    service,
  );
  return { service, controller };
}

const keepalives = (s: FakeStream): number => s.writes.filter((w) => w.startsWith(': keepalive')).length;

describe('the per-user SSE stream cap', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('ends the oldest response when a fifth stream opens for the same user', async () => {
    const { controller } = build();
    const streams: FakeStream[] = [];
    for (let i = 0; i < 5; i++) {
      const s = fakeStream();
      streams.push(s);
      await controller.stream('12345', s.request as never, s.response as never);
    }

    const [oldest, ...survivors] = streams;
    assert.equal(oldest.ended, true, 'the evicted stream must be closed, not merely forgotten');
    for (const [i, s] of survivors.entries()) {
      assert.equal(s.ended, false, `survivor ${i + 1} must stay open`);
    }
  });

  it('stops the evicted stream heartbeat, so it cannot look alive forever', async () => {
    const { controller } = build();
    const streams: FakeStream[] = [];
    for (let i = 0; i < 5; i++) {
      const s = fakeStream();
      streams.push(s);
      await controller.stream('12345', s.request as never, s.response as never);
    }

    const [oldest] = streams;
    const before = keepalives(oldest);
    mock.timers.tick(HEARTBEAT_INTERVAL_MS * 3);

    assert.equal(
      keepalives(oldest),
      before,
      'an evicted stream that keeps writing keepalives is the defect: the client ' +
        'never reconnects and the cabinet watchdog never fires',
    );
    // The survivors are unaffected — the fix must not silence live streams.
    assert.ok(keepalives(streams[4]) >= 3, 'a live stream still heartbeats');
  });

  it('tells the evicted client why, before ending the response', async () => {
    // A bare close is indistinguishable from a dropped connection. The frame
    // is written while the response is still writable, which is the ordering
    // this asserts as much as the content.
    const { controller } = build();
    const streams: FakeStream[] = [];
    for (let i = 0; i < 5; i++) {
      const s = fakeStream();
      streams.push(s);
      await controller.stream('12345', s.request as never, s.response as never);
    }

    const oldest = streams[0];
    assert.ok(
      oldest.writes.some((w) => w.includes('realtime.evicted')),
      'the evicted stream is told it was closed on purpose',
    );
    assert.equal(oldest.ended, true);
  });

  it('leaves four streams registered — the cap itself still holds', async () => {
    const { controller, service } = build();
    for (let i = 0; i < 5; i++) {
      const s = fakeStream();
      await controller.stream('12345', s.request as never, s.response as never);
    }
    assert.equal(service.connectedCount(), 4);
  });
});
