import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BroadcastStatus } from '@prisma/client';

import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';
import {
  captionLengthOf,
  captionOverflowOf,
  isMediaPayload,
} from '../src/modules/broadcast/utils/broadcast-caption.util';
import { TELEGRAM_CAPTION_LIMIT } from '../src/modules/broadcast/broadcast.constants';

/**
 * Two content defects that both read as "delivery is broken" when they are not.
 *
 * A caption over Telegram's limit is refused ONCE PER RECIPIENT, so one length
 * mistake filled the panel with hundreds of independent-looking failures. And
 * the promo button only ever reached the text path, so a promo-tagged photo
 * arrived with no way to use the code — while the channel copy DID carry one,
 * which is why nobody noticed from the operator's own screen.
 */

const filler = (n: number) => 'x'.repeat(n);

/** A payload that really is sent as a caption: a media TYPE and a media FILE. */
const media = (over: Record<string, unknown> = {}) => ({
  mediaType: 'photo',
  mediaFileId: 'file-1',
  ...over,
});

describe('what counts against the caption limit', () => {
  it('a plain message is not a caption and is not measured against 1024', () => {
    // 4096 is the message limit; applying the caption limit to plain text
    // would refuse perfectly sendable broadcasts.
    assert.equal(captionOverflowOf({ mediaType: 'none', text: filler(2000) }), null);
    assert.equal(isMediaPayload({ mediaType: 'none' }), false);
  });

  it('counts a photo and a video the same', () => {
    for (const mediaType of ['photo', 'video']) {
      assert.equal(
        isMediaPayload(media({ mediaType })),
        true,
        `${mediaType} was not treated as media`,
      );
      assert.equal(
        captionOverflowOf(media({ mediaType, text: filler(TELEGRAM_CAPTION_LIMIT + 1) })),
        TELEGRAM_CAPTION_LIMIT + 1,
      );
    }
  });

  it('asks the same question delivery asks: a type AND a file', () => {
    // Delivery's own `hasMedia` requires both, and a payload with only the type
    // is reachable — a draft patch that sets `mediaType` leaves the absent
    // `mediaFileId` alone. Keying on the type alone here measured such a
    // payload against 1024 while delivery sent it as a 4096-character plain
    // message, so staging refused a broadcast that would have gone out fine and
    // cleared its schedule doing it.
    assert.equal(isMediaPayload({ mediaType: 'photo' }), false, 'a type with no file is not media');
    assert.equal(isMediaPayload({ mediaType: 'photo', mediaFileId: '' }), false);
    assert.equal(
      captionOverflowOf({ mediaType: 'photo', text: filler(1500) }),
      null,
      'a broadcast with no attachment was held to the caption limit',
    );
    assert.equal(isMediaPayload(media()), true);
  });

  it('counts the title and the blank line after it', () => {
    // The delivery path joins title and body into ONE caption. Measuring the
    // body alone let a caption a few characters over the limit pass here and
    // fail at the API — the exact failure this check exists to prevent.
    assert.equal(captionLengthOf(media({ title: 'Hi', text: 'body' })), 8);
    assert.equal(captionLengthOf(media({ title: '   ', text: 'body' })), 4);
  });

  it('lets a caption exactly on the limit through', () => {
    // Off-by-one in the strict direction is not harmless: it refuses a send the
    // operator can see no problem with and cannot shorten further.
    assert.equal(captionOverflowOf(media({ text: filler(TELEGRAM_CAPTION_LIMIT) })), null);
    assert.equal(
      captionOverflowOf(media({ text: filler(TELEGRAM_CAPTION_LIMIT + 1) })),
      TELEGRAM_CAPTION_LIMIT + 1,
    );
  });

  it('survives a payload with nothing in it', () => {
    // Payloads come out of a JSON column and older rows are missing fields.
    // A throw here would take down staging for every broadcast.
    for (const payload of [null, undefined, {}, { mediaType: 'photo' }, media(), media({ text: 42 })]) {
      assert.doesNotThrow(() => captionOverflowOf(payload));
    }
  });

  it('reports the real length, so the operator knows how much to cut', () => {
    const overflow = captionOverflowOf(media({ text: filler(1500) }));
    assert.equal(overflow, 1500, 'a bare boolean would not say how far over it is');
  });
});

// ── The wiring, not just the arithmetic ────────────────────────────────────
//
// The check being correct is worth nothing if staging does not call it. That is
// the exact failure the email renderer had: a correct, well-tested function
// beside a live call site that never reached it.

function stagingFake(
  payload: Record<string, unknown>,
  promo: { ok: true } | { ok: false; reason: string } = { ok: true },
) {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const staged: unknown[] = [];
  const events: Array<{ severity: string; message: string }> = [];
  const client = {
    broadcast: {
      findUnique: async () => ({
        id: 'b-1',
        status: BroadcastStatus.SCHEDULED,
        audience: 'ALL',
        audienceFilter: null,
        payload,
        promoCode: null,
      }),
      update: async () => ({}),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    broadcastMessage: {
      findMany: async () => [],
      count: async () => 0,
      createMany: async (args: unknown) => {
        staged.push(args);
        return { count: 1 };
      },
    },
    user: { findMany: async () => [{ id: 'u-1', telegramId: 1n, email: null, webAccount: null }] },
  };
  const noop = () => undefined;
  const service = new BroadcastDeliveryService(
    client as never,
    { get: () => undefined } as never,
    {
      info: (_t: string, _s: string, message: string) => events.push({ severity: 'info', message }),
      warn: (_t: string, _s: string, message: string) => events.push({ severity: 'warn', message }),
      error: (_t: string, _s: string, message: string) => events.push({ severity: 'error', message }),
    } as never,
    { create: noop } as never,
    { create: noop } as never,
    { getSettings: async () => ({}) } as never,
    { isEnabled: false } as never,
      // Promo gate dependency. OBEYS the verdict it is handed — a stub that
      // always answered "usable" would make the gate untestable, which is
      // exactly how it went unnoticed that it was never called at fire time.
      { checkPromoCodeDispatchable: async () => promo } as never,
    { isEnabled: false } as never,
  );
  return { service, updates, staged, events };
}

describe('staging refuses a caption Telegram will not take', () => {
  it('stages nobody rather than failing once per recipient', async () => {
    const fake = stagingFake({ mediaType: 'photo', mediaFileId: 'file-1', text: filler(1500) });

    const result = await fake.service.stageRecipients('b-1');

    assert.deepStrictEqual(result, [], 'an unsendable broadcast was staged anyway');
    assert.equal(fake.staged.length, 0, 'recipient rows were created for a send that cannot happen');
  });

  it('puts it back to DRAFT so the operator can shorten it', async () => {
    // Not FAILED: the content is fine, only too long, and DRAFT is the one
    // status `updateDraft` still accepts. Clearing the schedule also takes it
    // out of the reconciler's overdue query, so this stops instead of being
    // revived every ten minutes for ever.
    const fake = stagingFake({ mediaType: 'photo', mediaFileId: 'file-1', text: filler(1500) });

    await fake.service.stageRecipients('b-1');

    const write = fake.updates[0];
    assert.equal(write?.data.status, BroadcastStatus.DRAFT);
    assert.equal(write?.data.scheduledAt, null, 'it would still claim a due time it will not honour');
    assert.equal(write?.data.queueJobId, null);
  });

  it('says how long the caption is, at error severity', async () => {
    // A `logger.warn` into a ring buffer is what the channel-post failure had,
    // and the operator learned about that one from recipients.
    const fake = stagingFake({ mediaType: 'photo', mediaFileId: 'file-1', text: filler(1500) });

    await fake.service.stageRecipients('b-1');

    const reported = fake.events.find((event) => event.severity === 'error');
    assert.ok(reported, 'an unsendable broadcast was refused silently');
    assert.ok(/1500/.test(reported.message), 'the report does not say how far over the limit it is');
  });

  it('does not stand in the way of a caption that fits', async () => {
    // Mutation check: a guard that refuses everything would pass all three
    // tests above.
    const fake = stagingFake({ mediaType: 'photo', mediaFileId: 'file-1', text: 'short enough' });

    await fake.service.stageRecipients('b-1');

    assert.equal(
      fake.events.some((event) => event.severity === 'error'),
      false,
      'a perfectly sendable media broadcast was refused',
    );
  });
});

describe('the promo tag is checked when the send fires, not when it was set', () => {
  const dead = { ok: false as const, reason: 'Promocode "SALE30" is fully used up' };
  const fits = { mediaType: 'none', text: 'hi' };

  it('refuses a scheduled send whose code went dead during the wait', async () => {
    // `POST /send` checks the promo when the operator presses the button. On a
    // scheduled send that is hours before dispatch, and a code that expires or
    // depletes in between used to reach the whole audience behind a button that
    // opens nothing — which cannot be taken back.
    const fake = stagingFake(fits, dead);

    const result = await fake.service.stageRecipients('b-1');

    assert.deepStrictEqual(result, [], 'a broadcast went out carrying a dead promo button');
    assert.equal(fake.staged.length, 0);
  });

  it('puts it back to DRAFT and names the code', async () => {
    const fake = stagingFake(fits, dead);

    await fake.service.stageRecipients('b-1');

    assert.equal(fake.updates[0]?.data.status, BroadcastStatus.DRAFT);
    assert.equal(fake.updates[0]?.data.scheduledAt, null);
    const reported = fake.events.find((event) => event.severity === 'error');
    assert.ok(reported && /SALE30/.test(reported.message), 'the operator is not told which code');
  });

  it('lets a live promo through', async () => {
    // Mutation check: a gate that refuses every promo-tagged broadcast would
    // pass both tests above and break the feature it guards.
    const fake = stagingFake(fits, { ok: true });

    await fake.service.stageRecipients('b-1');

    assert.equal(
      fake.events.some((event) => event.severity === 'error'),
      false,
      'a broadcast with a perfectly usable promo was refused',
    );
  });
});

// ── The email leg renders the same source as Telegram ─────────────────────

describe('custom emoji reach the inbox as something an inbox can draw', () => {
  it('substitutes the shortcode for its fallback glyph', async () => {
    // A premium Telegram custom emoji is a lottie animation addressed by id and
    // drawn by Telegram's own client — there is no format to send an inbox, and
    // no public url either. The glyph the operator chose for it is an ordinary
    // unicode character every mail client renders.
    //
    // The email leg used to be handed the RAW payload text, which is neither:
    // it still carries `:slug:`, so a broadcast that reached Telegram with the
    // operator's emoji reached the inbox with `:party:` spelled out mid-sentence.
    const { CustomEmojiService } = await import(
      '../src/modules/custom-emoji/services/custom-emoji.service'
    );
    const service = Object.create(CustomEmojiService.prototype) as {
      listPacks: () => Promise<unknown>;
      substituteFallbacks: (text: string) => Promise<string>;
    };
    service.listPacks = async () => [
      { emojis: [{ slug: 'party', fallback: '🎉', customEmojiId: '5391112412445288650' }] },
    ];

    assert.equal(await service.substituteFallbacks('Ура :party: сегодня'), 'Ура 🎉 сегодня');
  });

  it('leaves an unknown shortcode alone rather than deleting it', async () => {
    // Mutation check: stripping everything that looks like a shortcode would
    // eat ordinary colons out of the operator's copy.
    const { CustomEmojiService } = await import(
      '../src/modules/custom-emoji/services/custom-emoji.service'
    );
    const service = Object.create(CustomEmojiService.prototype) as {
      listPacks: () => Promise<unknown>;
      substituteFallbacks: (text: string) => Promise<string>;
    };
    service.listPacks = async () => [{ emojis: [] }];

    assert.equal(await service.substituteFallbacks('время :30: минут'), 'время :30: минут');
  });
});

describe('the picture of a custom emoji, when an inbox can fetch it', () => {
  const emoji = new Map([
    ['party', { imageUrl: 'https://cabinet.example/uploads/emoji/a.webp', fallback: '🎉' }],
    ['nofile', { imageUrl: null, fallback: '✨' }],
  ]);

  it('embeds the image and keeps the glyph as its alt', async () => {
    // The glyph is the whole safety net: most clients block remote images until
    // the reader allows them, and some deployments will not serve the asset at
    // all. `alt` makes both degrade to exactly the previous behaviour instead
    // of a broken-image box.
    const { renderBroadcastEmailHtml } = await import(
      '../src/modules/broadcast/utils/broadcast-email-html.util'
    );

    const html = renderBroadcastEmailHtml(null, 'Ура :party: сегодня', emoji);

    assert.ok(html.includes('src="https://cabinet.example/uploads/emoji/a.webp"'));
    assert.ok(html.includes('alt="🎉"'), `no glyph to fall back to: ${html}`);
    assert.ok(!html.includes(':party:'), 'the shortcode survived into the inbox');
  });

  it('falls back to the glyph when there is no picture', async () => {
    const { renderBroadcastEmailHtml } = await import(
      '../src/modules/broadcast/utils/broadcast-email-html.util'
    );

    const html = renderBroadcastEmailHtml(null, 'Вот :nofile: так', emoji);

    assert.ok(html.includes('✨'));
    assert.ok(!html.includes('<img'), 'an image tag with no image');
  });

  it('does not let the operator smuggle an image tag through', async () => {
    // `<img>` stays off the allow-list — an operator-authored one is a tracking
    // pixel with extra steps. The tags above are ours, built from the panel's
    // own records; anything the operator types is still escaped.
    const { renderBroadcastEmailHtml } = await import(
      '../src/modules/broadcast/utils/broadcast-email-html.util'
    );

    const html = renderBroadcastEmailHtml(null, '<img src="https://tracker.example/p.gif">', emoji);

    assert.ok(!html.includes('<img src="https://tracker.example'), 'a tracking pixel got through');
    assert.ok(html.includes('&lt;img'), 'the tag was neither rendered nor shown as text');
  });

  it('leaves the text alone when there are no emoji at all', async () => {
    // Mutation check: a substitution that ran unconditionally would eat colons
    // out of ordinary copy.
    const { renderBroadcastEmailHtml } = await import(
      '../src/modules/broadcast/utils/broadcast-email-html.util'
    );

    const html = renderBroadcastEmailHtml(null, 'время :30: минут', new Map());

    assert.ok(html.includes(':30:'));
  });
});
