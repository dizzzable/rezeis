import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SystemEventsService } from '../src/common/services/system-events.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * The one control whose entire job is to tell the truth about delivery.
 *
 * «Настройки → Доставка в Telegram → Отправить тест» reported success for
 * every outcome there is. The endpoint's return type was the literal
 * `{ sent: true }`, so failure was unrepresentable by construction, and the
 * send underneath swallowed Telegram's refusal into a log line — a revoked
 * token, a bot removed from the group, a wrong topic id and a working channel
 * were indistinguishable from the operator's chair.
 *
 * The button is also the ONLY verification surface for the whole operator
 * alerting pipeline, which is what makes a lying one worse than none: an
 * operator who presses it and reads "отправлено" stops looking.
 *
 * Three outcomes have to stay distinguishable, because each calls for a
 * different next step:
 *   - delivered — the channel works;
 *   - queued / relayed — handed to the reiwa bot; nothing is known YET;
 *   - failed — with Telegram's own words, which name the thing to fix.
 */

interface Sent {
  readonly url: string;
  readonly payload: Record<string, unknown>;
}

function buildService(opts: {
  readonly telegram: Record<string, unknown>;
  readonly botToken?: string;
  /** What the Bot API does with the probe. */
  readonly api?: 'ok' | { readonly throws: unknown } | { readonly body: unknown };
}): { service: SystemEventsService; sent: Sent[]; relayed: string[] } {
  const sent: Sent[] = [];
  const relayed: string[] = [];

  const httpService = {
    post: (url: string, payload: Record<string, unknown>) => {
      sent.push({ url, payload });
      const api = opts.api ?? 'ok';
      if (typeof api === 'object' && 'throws' in api) {
        return {
          subscribe: (observer: { error: (e: unknown) => void }) => observer.error(api.throws),
        };
      }
      const data = typeof api === 'object' && 'body' in api ? api.body : { ok: true };
      return {
        subscribe: (observer: { next: (v: unknown) => void; complete: () => void }) => {
          observer.next({ data });
          observer.complete();
        },
      };
    },
  };
  const notifier = {
    deliverRelayEvent: async (event: string) => {
      relayed.push(event);
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
    },
  };
  const relayQueue = {
    enqueue: async (event: string) => {
      relayed.push(event);
      return true;
    },
  };
  const prisma = {
    settings: { findFirst: async () => ({ systemNotifications: { telegram: opts.telegram } }) },
    adminAuditLog: { create: async () => ({}) },
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
  return { service, sent, relayed };
}

const GROUP = {
  enabled: true,
  chatId: '-1001234567890',
  devChatId: null,
  errorReports: { mode: 'manual', telegramTxt: false },
};

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = 'test-token';
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = savedToken;
});

describe('the Telegram delivery probe reports what happened', () => {
  it('says sent when the Bot API accepted it', async () => {
    const { service, sent } = buildService({ telegram: GROUP });
    const result = await service.sendTelegramTest({
      category: 'SYSTEM',
      note: null,
      adminId: 'admin-1',
    });
    assert.equal(result.delivery.kind, 'sent');
    assert.equal(sent.length, 1);
  });

  it('says failed, in Telegram’s own words, when the token is revoked', async () => {
    // THE case. This is the outcome that used to read "Тестовое сообщение
    // отправлено".
    const { service } = buildService({
      telegram: GROUP,
      api: { throws: { response: { status: 401, data: { description: 'Unauthorized' } } } },
    });
    const result = await service.sendTelegramTest({
      category: 'SYSTEM',
      note: null,
      adminId: 'admin-1',
    });
    assert.equal(result.delivery.kind, 'failed');
    assert.equal(
      result.delivery.kind === 'failed' ? result.delivery.reason : null,
      'Unauthorized',
    );
  });

  it('carries the sentence an operator can act on, not the status line', async () => {
    // `Request failed with status code 400` names nothing. Telegram puts the
    // useful words in `description`.
    const { service } = buildService({
      telegram: GROUP,
      api: {
        throws: {
          message: 'Request failed with status code 400',
          response: { status: 400, data: { description: 'message thread not found' } },
        },
      },
    });
    const result = await service.sendTelegramTest({
      category: 'SYSTEM',
      note: null,
      adminId: 'admin-1',
    });
    assert.equal(
      result.delivery.kind === 'failed' ? result.delivery.reason : null,
      'message thread not found',
    );
  });

  it('falls back to the status when Telegram said nothing useful', async () => {
    const { service } = buildService({
      telegram: GROUP,
      api: { throws: { response: { status: 502, data: {} } } },
    });
    const result = await service.sendTelegramTest({
      category: 'SYSTEM',
      note: null,
      adminId: 'admin-1',
    });
    assert.match(
      result.delivery.kind === 'failed' ? result.delivery.reason : '',
      /502/,
    );
  });

  it('treats a 200 that says ok:false as a failure', async () => {
    const { service } = buildService({
      telegram: GROUP,
      api: { body: { ok: false, description: 'chat not found' } },
    });
    const result = await service.sendTelegramTest({
      category: 'SYSTEM',
      note: null,
      adminId: 'admin-1',
    });
    assert.equal(result.delivery.kind, 'failed');
    assert.equal(
      result.delivery.kind === 'failed' ? result.delivery.reason : null,
      'chat not found',
    );
  });

  it('says relayed — not sent — when the panel has no bot token', async () => {
    // The split deployment. The panel hands the card to the reiwa bot and
    // genuinely does not yet know whether it arrived; reporting that as
    // "delivered" is the same lie in a quieter voice.
    delete process.env.BOT_TOKEN;
    const { service, relayed, sent } = buildService({ telegram: GROUP });
    const result = await service.sendTelegramTest({
      category: 'SYSTEM',
      note: null,
      adminId: 'admin-1',
    });
    assert.equal(result.delivery.kind, 'relayed');
    assert.equal(sent.length, 0);
    assert.equal(relayed.length, 1);
  });

  it('is not silenced by the operator’s own event selection', async () => {
    // `isEventTelegramAllowed` exempts this type by name, and that exemption
    // is load-bearing: without it, an operator in `selected` mode who had not
    // ticked the probe would press the button, receive nothing, and have no
    // way to tell that from a broken channel. Pinned here because the
    // exemption lives three files away from the button.
    const { service, sent } = buildService({
      telegram: { ...GROUP, eventsMode: 'selected', events: ['payment.completed'] },
    });
    const result = await service.sendTelegramTest({
      category: 'SYSTEM',
      note: null,
      adminId: 'admin-1',
    });
    assert.equal(result.delivery.kind, 'sent');
    assert.equal(sent.length, 1);
  });

  it('still reports where it routed the card', async () => {
    const { service } = buildService({ telegram: GROUP });
    const result = await service.sendTelegramTest({
      category: 'SYSTEM',
      note: null,
      adminId: 'admin-1',
    });
    assert.equal(result.via, 'primary');
  });
});
