import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';

import { WebPushSubscription } from '@prisma/client';
import * as webpush from 'web-push';

import { WebPushService } from '../src/modules/push/services/web-push.service';

/**
 * THE TWO NEW FIELDS, ON THE WIRE.
 *
 * `push-payload-tag.spec.ts` beside this one settles WHICH notifications may
 * replace each other. This file settles the other half: that the answer
 * actually reaches the browser, and that a caller with no answer still produces
 * the payload an older panel produced — byte for byte.
 *
 * That second property is the cross-version contract, and it is testable here
 * because the payload is one JSON string. Panel and cabinet ship as separate
 * images and upgrade independently:
 *
 *   • new panel → OLD cabinet: the old service worker reads `title`, `body`,
 *     `url`, `icon` and `badgeCount` by name and ignores everything else, so
 *     two extra keys change nothing it does.
 *   • OLD panel → new cabinet: neither field is on the payload, and the
 *     cabinet's `resolveNotificationTag` falls through to the
 *     destination-plus-digest key it already uses today.
 *
 * The one thing that would break the second half is sending a field BLANK
 * rather than omitting it — an empty string is a key the cabinet has to have
 * been written to reject. It was, but relying on that is a promise the panel
 * does not need to make, so the fields are omitted instead. The last case here
 * is what holds that.
 */

const requireWebPush = createRequire(__filename);
const mutableWebPush = requireWebPush('web-push') as typeof webpush;
const originalSendNotification = mutableWebPush.sendNotification;

afterEach(() => {
  mutableWebPush.sendNotification = originalSendNotification;
});

describe('the identity fields on a push payload', () => {
  it('carries the collapse key the caller chose', async () => {
    const payload = await payloadFor({ tag: 'support_reply:notification-7' });

    assert.equal(
      payload.tag,
      'support_reply:notification-7',
      'the panel’s answer never left the process',
    );
  });

  it('carries the type beside it', async () => {
    const payload = await payloadFor({ tag: 'subscription-deadline', type: 'expires_in_3_days' });

    assert.equal(payload.tag, 'subscription-deadline');
    assert.equal(payload.type, 'expires_in_3_days');
  });

  it('sends the payload an older panel sent when the caller has no answer', async () => {
    // The old-panel shape, and the assertion is deliberately about the KEYS
    // rather than the two values: a field present and empty is a different
    // payload from a field that is absent, and only the second is what a
    // cabinet that predates this change was tested against.
    const payload = await payloadFor({});

    assert.deepStrictEqual(Object.keys(payload), ['title', 'body', 'url']);
  });

  it('omits a blank tag rather than sending an empty key', async () => {
    // A blank string is what a future caller gets from a missing template
    // field, an unset id, a trimmed constant. The cabinet does reject it — it
    // has a test for exactly this — but a payload that depends on the READER
    // for its correctness is a promise across a version boundary, and this one
    // costs nothing to keep on the sending side.
    const payload = await payloadFor({ tag: '   ', type: '' });

    assert.equal('tag' in payload, false, 'a blank tag went out as an empty key');
    assert.equal('type' in payload, false, 'a blank type went out as an empty key');
  });
});

/** The JSON payload one `sendToUser` handed to the push provider. */
async function payloadFor(input: {
  readonly tag?: string;
  readonly type?: string;
}): Promise<Record<string, unknown>> {
  const bodies: string[] = [];
  mutableWebPush.sendNotification = (async (_target, body) => {
    bodies.push(String(body));
    return {} as webpush.SendResult;
  }) as typeof webpush.sendNotification;

  const service = createService();
  await service.sendToUser({ userId: 'user-1', title: 'Заголовок', body: 'Текст', ...input });

  assert.equal(bodies.length, 1, 'the provider was not called exactly once');
  return JSON.parse(bodies[0]) as Record<string, unknown>;
}

function createService(): WebPushService {
  const subscription: WebPushSubscription = {
    id: 'subscription-1',
    userId: 'user-1',
    endpoint: 'https://push.example.test/subscription-1',
    p256dhKey: 'p256dh-key',
    authKey: 'auth-key',
    userAgent: null,
    failureCount: 0,
    createdAt: new Date('2026-04-20T10:00:00.000Z'),
    lastSeenAt: new Date('2026-04-20T10:00:00.000Z'),
  };
  const prisma = {
    webPushSubscription: {
      findMany: async () => [subscription],
      update: async (args: { where: { id: string } }) => ({ ...subscription, id: args.where.id }),
      delete: async () => subscription,
    },
    // No `settings` model on the double on purpose: `resolveNotificationBrand`
    // catches its own failure and falls back to the stock name with no icon, so
    // the payload here holds only what the CALLER put on it. An icon from
    // branding would sit between `url` and the assertions above.
  };
  const settingsService = {
    getDecryptedWebPushConfig: async () => ({
      publicKey: 'public-key-1',
      privateKey: 'private-key-1',
      subject: 'mailto:admin@example.com',
    }),
  };
  return new WebPushService(prisma as never, settingsService as never);
}
