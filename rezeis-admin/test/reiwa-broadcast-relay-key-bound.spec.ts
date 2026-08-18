import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SystemEventsService } from '../src/common/services/system-events.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * The channel-relay dedup key has to fit what the cabinet accepts
 * ═══════════════════════════════════════════════════════════════
 * `reiwa.channel.broadcast` and `.broadcast.document` carry `eventId` through a
 * REQUIRED `eventIdSchema` on the cabinet — `z.string().trim().min(1).max(128)`
 * with no `.catch(undefined)` (`reiwa/src/api/routes/webhooks.ts:91,329,341`).
 * That is the difference between these two routes and the dev pair: the dev
 * schema degrades an unusable key to `undefined` and still delivers, while an
 * over-long key HERE is a 400. The relay reads 400 as unrecoverable, so the
 * operator card is not merely undeduplicated — it is lost outright, and
 * `reiwa.relay_undelivered` fires in its place.
 *
 * The key is built from `event.type`, and event types are NOT a closed set:
 * automation rules and the reiwa ingest both mint them at runtime. The longest
 * type registered in this repo is 37 characters against a budget of 83, so
 * nothing shipped can overflow it today — which is exactly why the bound needs
 * a test rather than a reader's confidence. Without one, the day someone adds a
 * long type the failure is silent, remote, and looks like a delivery outage.
 *
 * Note this asserts the BOUND, not the shape. Clipping deliberately changes no
 * key that exists today, so a test pinned to a literal key would pass on the
 * broken code too.
 */

interface Relayed {
  readonly event: string;
  readonly metadata: Record<string, unknown>;
}

/** Mirrors the helper in `reiwa-dev-relay-idempotency.spec.ts`. */
function buildService(telegram: Record<string, unknown>): {
  service: SystemEventsService;
  queued: Relayed[];
  direct: Relayed[];
} {
  const queued: Relayed[] = [];
  const direct: Relayed[] = [];

  const notifier = {
    deliverRelayEvent: async (event: string, metadata: Record<string, unknown>) => {
      direct.push({ event, metadata });
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
    },
  };
  const relayQueue = {
    enqueue: async (event: string, metadata: Record<string, unknown>) => {
      queued.push({ event, metadata });
      return true;
    },
  };
  const prisma = {
    settings: { findFirst: async () => ({ systemNotifications: { telegram } }) },
    adminAuditLog: { create: async () => ({}) },
  };
  const httpService = {
    post: () => {
      throw new Error('Bot API must not be called without a token');
    },
  };
  const moduleRef = {
    get: (token: unknown) => {
      if (token === BotNotifierClient) return notifier;
      if (token === ReiwaRelayQueueService) return relayQueue;
      throw new Error('not registered');
    },
  };

  const service = new SystemEventsService(
    prisma as never,
    { enabled: false, urls: [] } as never,
    httpService as never,
    moduleRef as never,
  );
  return { service, queued, direct };
}

/** Delivery is fire-and-forget; let the microtasks settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Operator channel configured, error reports as an inline card. */
const CHANNEL_CARD_ONLY = {
  enabled: true,
  chatId: '-1001234567890',
  devChatId: null,
  errorReports: { mode: 'manual', telegramTxt: false },
};

/** Same channel, with the `.txt` attachment on — the document route. */
const CHANNEL_WITH_TXT = {
  enabled: true,
  chatId: '-1001234567890',
  devChatId: null,
  errorReports: { mode: 'manual', telegramTxt: true },
};

/** The cabinet's own limit, restated here rather than imported across repos. */
const CABINET_EVENT_ID_MAX = 128;

/**
 * The longest `type` the panel will accept over the wire.
 *
 * Read out of the controller rather than written down, because a mirrored
 * literal is only as good as the day it was copied. `ReceiveSystemEventDto`
 * carries `@MaxLength(200)` on `type`; raise it there and the boundary case
 * below has to grow with it, which it now does on its own.
 */
const INGEST_TYPE_MAX_LENGTH = readIngestTypeMaxLength();

function readIngestTypeMaxLength(): number {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'modules', 'settings', 'controllers', 'internal-events.controller.ts'),
    'utf8',
  );
  // The first `@MaxLength(n)` that precedes `public type!: string`.
  const match = /@MaxLength\((\d+)\)\s*\r?\n\s*public type!: string;/.exec(source);
  assert.ok(
    match !== null,
    'could not read the @MaxLength on ReceiveSystemEventDto.type — the boundary ' +
      'test below would silently fall back to guessing, so this fails instead',
  );
  const max = Number(match[1]);
  assert.ok(Number.isInteger(max) && max > 0, `unusable @MaxLength: ${match[1]}`);
  return max;
}

/** A type long enough to overflow the key — the ingest can mint one like it. */
const HOSTILE_TYPE = `reiwa.ingest.${'x'.repeat(400)}`;

/** A type at EXACTLY the DTO ceiling — the longest value that can legally arrive. */
const MAX_LENGTH_TYPE = `reiwa.ingest.${'x'.repeat(INGEST_TYPE_MAX_LENGTH - 'reiwa.ingest.'.length)}`;

function relayedKeys(relayed: readonly Relayed[]): readonly string[] {
  const keys = relayed
    .filter((entry) => entry.event.startsWith('reiwa.channel.broadcast'))
    .map((entry) => entry.metadata['eventId']);
  // Anti-vacuity: a config change that stops the channel route from running at
  // all would leave this empty, and every length assertion below would then
  // pass by describing nothing.
  assert.ok(
    keys.length > 0,
    'no channel relay was produced — the assertions below would prove nothing',
  );
  for (const key of keys) {
    assert.equal(typeof key, 'string', 'a channel relay went out with no eventId');
  }
  return keys as readonly string[];
}

void describe('the channel relay key fits the cabinet bound', () => {
  void it('bounds the inline-card key against a runtime-minted type', async () => {
    const { service, queued, direct } = buildService(CHANNEL_CARD_ONLY);
    service.error(HOSTILE_TYPE, 'SYSTEM', 'z'.repeat(2_000), { blob: 'q'.repeat(5_000) });
    await flush();

    for (const key of relayedKeys([...queued, ...direct])) {
      assert.ok(
        key.length <= CABINET_EVENT_ID_MAX,
        `the cabinet rejects an eventId over ${CABINET_EVENT_ID_MAX} chars with a 400, ` +
          `which the relay treats as unrecoverable — the operator card is then lost, ` +
          `not merely duplicated. This key is ${key.length} chars.`,
      );
    }
  });

  void it('bounds the document key, which carries an extra suffix', async () => {
    // `:error-report` is appended on this branch, so it is the tighter of the
    // two budgets and would be the first to overflow.
    const { service, queued, direct } = buildService(CHANNEL_WITH_TXT);
    service.error(HOSTILE_TYPE, 'SYSTEM', 'z'.repeat(2_000), { blob: 'q'.repeat(5_000) });
    await flush();

    for (const key of relayedKeys([...queued, ...direct])) {
      assert.ok(
        key.length <= CABINET_EVENT_ID_MAX,
        `the document route appends its own suffix, so it overflows before the card ` +
          `route does. This key is ${key.length} chars.`,
      );
    }
  });

  void it('holds at the DTO ceiling — the longest type that can legally arrive', async () => {
    // The boundary the wire actually permits, as opposed to the deliberately
    // absurd 400-character type above. `ReceiveSystemEventDto` accepts this
    // exact length, so this is not a hypothetical input: an ingested event or
    // an automation rule can mint it, and before the clip it produced
    // 7 + 200 + 1 + 24 = 232 characters on the card route and 245 on the
    // document route — both a 400 from the cabinet, both a lost operator card.
    assert.equal(
      MAX_LENGTH_TYPE.length,
      INGEST_TYPE_MAX_LENGTH,
      'the fixture drifted off the DTO ceiling it is supposed to sit on',
    );

    for (const config of [CHANNEL_CARD_ONLY, CHANNEL_WITH_TXT]) {
      const { service, queued, direct } = buildService(config);
      service.error(MAX_LENGTH_TYPE, 'SYSTEM', 'boom', {});
      await flush();

      for (const key of relayedKeys([...queued, ...direct])) {
        assert.ok(
          key.length <= CABINET_EVENT_ID_MAX,
          `a type at the DTO maximum of ${INGEST_TYPE_MAX_LENGTH} produced a ` +
            `${key.length}-character key; the cabinet rejects anything over ` +
            `${CABINET_EVENT_ID_MAX} with a 400, which the relay treats as ` +
            `unrecoverable — the operator card is dropped, not retried.`,
        );
      }
    }
  });

  void it('still tells two same-millisecond types apart after clipping', async () => {
    // Clipping trades tail characters for a bound, so it can only be safe while
    // the surviving prefix still discriminates. The key is also the BullMQ
    // `jobId`: a collision does not duplicate a card, it DELETES the second one
    // before it is ever queued. Two long types sharing a prefix is the case
    // that would do it.
    const shared = 'reiwa.ingest.' + 'x'.repeat(400);
    const first = buildService(CHANNEL_CARD_ONLY);
    first.service.error(`${shared}.alpha`, 'SYSTEM', 'boom', {});
    await flush();

    const second = buildService(CHANNEL_CARD_ONLY);
    second.service.error(`${shared}.beta`, 'SYSTEM', 'boom', {});
    await flush();

    const a = relayedKeys([...first.queued, ...first.direct])[0];
    const b = relayedKeys([...second.queued, ...second.direct])[0];
    assert.notEqual(
      a,
      b,
      'two distinct alerts collapsed onto one job id — the second card would vanish',
    );
  });
});
