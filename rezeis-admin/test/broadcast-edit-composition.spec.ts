import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastStatus } from '@prisma/client';

import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';

/**
 * A correction must produce the message a fresh send would produce.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * `editBatch` had no test of any kind, and it had drifted away from delivery in
 * three separate ways at once: it sent the body without the title, it took the
 * caller's parse mode instead of deriving the wire value the way delivery does,
 * and it wrote that caller's value back into the stored payload. Each was
 * invisible in isolation. Together they meant that pressing "retry failed"
 * after an edit sent the stragglers a DIFFERENT message from everyone else —
 * longer by the title, under a parse mode the first recipients never saw — and
 * on a media broadcast that difference was enough for Telegram to refuse every
 * one of them, permanently, with the reason in a column no screen renders.
 */

interface Sent {
  readonly endpoint: string;
  readonly body: Record<string, unknown>;
}

function build(payload: Record<string, unknown>) {
  const sent: Sent[] = [];
  const payloadWrites: Array<Record<string, unknown>> = [];
  const client = {
    broadcast: {
      findUnique: async () => ({
        id: 'b-1',
        status: BroadcastStatus.COMPLETED,
        payload,
        promoCode: null,
        channelChatId: null,
        channelMessageId: null,
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        payloadWrites.push(data);
        return {};
      },
      updateMany: async () => ({ count: 1 }),
    },
    broadcastMessage: {
      findMany: async () => [{ id: 'm-1', userId: 'u-1', telegramMessageId: 5n }],
      update: async () => ({}),
      count: async () => 0,
    },
    user: { findUnique: async () => ({ telegramId: 77n }) },
  };
  const noop = () => undefined;
  const service = new BroadcastDeliveryService(
    client as never,
    { get: () => 'token' } as never,
    { info: noop, warn: noop, error: noop } as never,
    { create: noop } as never,
    { getDecryptedBotToken: async () => 'token' } as never,
    {} as never,
    { isEnabled: false } as never,
    { checkPromoCodeDispatchable: async () => ({ ok: true }) } as never,
  );
  return { service, sent, payloadWrites };
}

async function capture<T>(sent: Sent[], run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    sent.push({
      endpoint: url.slice(url.lastIndexOf('/') + 1),
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return {
      ok: true,
      json: async () => ({ result: { message_id: 1 } }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const MEDIA = { mediaType: 'photo', mediaFileId: 'file-1', title: 'Скидка 30%', parseMode: 'HTML' };
const TEXT = { mediaType: 'none', mediaFileId: null, title: 'Новости', parseMode: null };

describe('an edit carries the title, exactly as delivery does', () => {
  it('puts the title back into an edited caption', async () => {
    // `deliverBatch` composes `<b>title</b>\n\n<body>`; the edit used to send
    // the body alone. So the correction silently deleted the headline from
    // every message that had one, and a later retry — which composes — sent a
    // caption longer than the one the guard had approved.
    const fake = build(MEDIA);

    await capture(fake.sent, () => fake.service.editBatch('b-1', ['m-1'], 'новый текст', 'HTML'));

    const caption = String(fake.sent[0]?.body.caption ?? '');
    assert.ok(caption.includes('<b>'), `the title is gone: ${caption}`);
    assert.ok(caption.includes('новый текст'));
    assert.equal(fake.sent[0]?.endpoint, 'editMessageCaption');
  });

  it('edits a text broadcast as text, always under HTML', async () => {
    // Text delivery hard-codes HTML (`notifyUser`), so an edit that took the
    // caller's value could render a message differently from how it was sent.
    const fake = build(TEXT);

    await capture(fake.sent, () => fake.service.editBatch('b-1', ['m-1'], 'новый текст', null));

    assert.equal(fake.sent[0]?.endpoint, 'editMessageText');
    assert.equal(fake.sent[0]?.body.parse_mode, 'HTML');
  });

  it('leaves a media caption unparsed when the operator chose no mode', async () => {
    // Mutation check: forcing HTML on media too would make a bare `<` in the
    // operator's text a per-recipient 400.
    const fake = build({ ...MEDIA, parseMode: null });

    await capture(fake.sent, () => fake.service.editBatch('b-1', ['m-1'], 'a < b', null));

    assert.equal(fake.sent[0]?.body.parse_mode, undefined);
  });
});

describe('an edit does not rewrite how the broadcast is formatted', () => {
  it('keeps the stored parse mode when the caller passes none', async () => {
    // The worker used to write `parseMode ?? null` back into the payload, and
    // the controller handed it a transport default of 'HTML'. A later "retry
    // failed" then read HTML and re-sent the tail of the audience with it,
    // where the head had got none.
    const fake = build({ ...MEDIA, parseMode: null });

    await capture(fake.sent, () => fake.service.editBatch('b-1', ['m-1'], 'новый текст', null));

    const written = fake.payloadWrites[0]?.payload as Record<string, unknown> | undefined;
    assert.ok(written, 'the edit wrote no payload at all');
    assert.equal(written.parseMode, null, 'the edit invented a parse mode');
    assert.equal(written.text, 'новый текст');
  });

  it('does store a parse mode the caller really did pass', async () => {
    // Mutation check: never writing it would make the edit unable to change
    // formatting at all.
    const fake = build(MEDIA);

    await capture(fake.sent, () => fake.service.editBatch('b-1', ['m-1'], 'новый текст', 'HTML'));

    const written = fake.payloadWrites[0]?.payload as Record<string, unknown> | undefined;
    assert.equal(written?.parseMode, 'HTML');
  });
});
