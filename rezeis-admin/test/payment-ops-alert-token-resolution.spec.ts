/**
 * Where the payment-ops alert gets its bot token, and what it leaves behind
 * when it cannot get one.
 *
 * The defect these guard: both senders read the token ONLY from
 * `paymentsConfig.botToken`, i.e. `process.env.BOT_TOKEN`. This product keeps
 * every setting in the panel and sets no such variable, so the token was always
 * null — `sendWebhookAlert` returned at its guard with no log line of any kind,
 * and the settings form saved cleanly while delivering nothing. A form that
 * reports success and sends nothing is worse than no form at all, so these
 * specs assert the OUTBOUND REQUEST (which token actually went on the wire) and
 * the trace left when there is none, never that a getter was called.
 *
 * Nothing here reads or sets an environment variable: the "env" side is the
 * injected `paymentsConfig` object, passed explicitly in every case.
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PaymentGatewayType } from '@prisma/client';
import { of } from 'rxjs';

import { PaymentOpsAlertService } from '../src/modules/payments/services/payment-ops-alert.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';

const CRYPT_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ALERTS_ON = {
  paymentOps: {
    enabled: true,
    chatId: '-1003713706224',
    threadId: null,
    hashtag: '#payments_ops',
  },
};

interface Posted {
  readonly url: string;
  readonly payload: Record<string, unknown>;
}

interface Relayed {
  readonly event: string;
  readonly metadata: Record<string, unknown>;
}

interface Harness {
  readonly service: PaymentOpsAlertService;
  readonly posted: Posted[];
  readonly relayed: Relayed[];
  readonly errors: string[];
}

/**
 * What the reiwa relay looks like to this service.
 *
 *   none     - `ReiwaRelayModule` is not registered in this runtime.
 *   disabled - registered, but REIWA_URL / WEBHOOK_SECRET_HEADER are unset.
 *   ready    - configured; `enqueue` accepts the job for durable delivery.
 *   refuses  - configured, but Redis refused the enqueue. `enqueue` answers
 *              `false` AFTER making one direct attempt of its own.
 */
type RelayState = 'none' | 'disabled' | 'ready' | 'refuses';

/**
 * @param storedToken what the panel has saved (null = nothing saved)
 * @param envToken what `paymentsConfig.botToken` holds (null = no env var)
 */
function buildService(options: {
  readonly storedToken?: string | null;
  readonly envToken?: string | null;
  readonly systemNotifications?: Record<string, unknown>;
  readonly storedTokenThrows?: boolean;
  readonly relay?: RelayState;
}): Harness {
  const posted: Posted[] = [];
  const relayed: Relayed[] = [];
  const errors: string[] = [];
  const relayState: RelayState = options.relay ?? 'none';
  const relayQueue = {
    isEnabled: relayState === 'ready' || relayState === 'refuses',
    enqueue: async (event: string, metadata: Record<string, unknown>): Promise<boolean> => {
      relayed.push({ event, metadata });
      return relayState === 'ready';
    },
  };
  const moduleRef =
    relayState === 'none' ? undefined : { get: (): unknown => relayQueue };
  const settingsService = {
    getDecryptedBotToken: async (): Promise<string | null> => {
      if (options.storedTokenThrows === true) {
        throw new Error('database is down');
      }
      return options.storedToken ?? null;
    },
  };
  const service = new PaymentOpsAlertService(
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: options.systemNotifications ?? ALERTS_ON,
        }),
      },
    } as never,
    {
      post: (url: string, payload: Record<string, unknown>) => {
        posted.push({ url, payload });
        return of({ data: { ok: true } });
      },
    } as never,
    { botToken: options.envToken ?? null, domain: null } as never,
    settingsService as unknown as SettingsService,
    moduleRef as never,
  );
  (
    service as unknown as { readonly logger: { error: (message: string) => void } }
  ).logger.error = (message: string): void => {
    errors.push(message);
  };
  return { service, posted, relayed, errors };
}

async function fireAlert(
  service: PaymentOpsAlertService,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await service.notifyWebhookFailed({
    event: {
      id: 'event-1',
      paymentId: 'payment-1',
      providerEventId: 'provider-event-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      status: 'FAILED',
      lastError: 'provider rejected the callback',
      ...overrides,
    } as never,
  });
}

describe('PaymentOpsAlertService bot token resolution', () => {
  it('sends with the panel-configured token when the environment has none', async () => {
    const { service, posted, errors } = buildService({
      storedToken: 'panel-token-123',
      envToken: null,
    });

    await fireAlert(service);

    // The observable outcome: a request went out, and it carried the token the
    // operator saved in the panel. Before the fix this deployment posted
    // nothing at all.
    assert.equal(posted.length, 1);
    assert.equal(
      posted[0]?.url,
      'https://api.telegram.org/botpanel-token-123/sendMessage',
    );
    assert.equal(posted[0]?.payload.chat_id, '-1003713706224');
    assert.equal(String(posted[0]?.payload.text).includes('kind:webhook_failed'), true);
    // Anti-vacuity: a successful send must not be reported as a failure.
    assert.deepStrictEqual(errors, []);
  });

  it('still falls back to the environment token when the panel has none', async () => {
    const { service, posted, errors } = buildService({
      storedToken: null,
      envToken: 'env-token-456',
    });

    await fireAlert(service);

    // Deployments that genuinely set BOT_TOKEN must not lose alerting.
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.url, 'https://api.telegram.org/botenv-token-456/sendMessage');
    assert.deepStrictEqual(errors, []);
  });

  it('prefers the panel token over the environment token when both exist', async () => {
    const { service, posted } = buildService({
      storedToken: 'panel-token-123',
      envToken: 'env-token-456',
    });

    await fireAlert(service);

    assert.equal(posted.length, 1);
    assert.equal(
      posted[0]?.url,
      'https://api.telegram.org/botpanel-token-123/sendMessage',
    );
  });

  it('leaves a findable error line instead of dropping the alert in silence', async () => {
    const { service, posted, errors } = buildService({ storedToken: null, envToken: null });

    await fireAlert(service);

    assert.equal(posted.length, 0);
    assert.equal(errors.length, 1);
    // Stable, greppable reason code plus the remedy that actually fixes it.
    assert.equal(
      errors[0]?.includes('[BOT_TOKEN_NOT_CONFIGURED] Payment ops alert NOT delivered.'),
      true,
    );
    assert.equal(errors[0]?.includes('Settings -> Bot Token'), true);
  });

  it('names the missing chat separately from the missing token', async () => {
    const { service, posted, errors } = buildService({
      storedToken: 'panel-token-123',
      systemNotifications: {
        paymentOps: { enabled: true, chatId: null, threadId: null, hashtag: '#payments_ops' },
      },
    });

    await fireAlert(service);

    assert.equal(posted.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.includes('[ALERT_CHAT_NOT_CONFIGURED] Payment ops alert NOT delivered.'),
      true,
    );
  });

  it('stays silent when the operator has switched the alerts off', async () => {
    const { service, posted, errors } = buildService({
      storedToken: null,
      envToken: null,
      systemNotifications: {
        paymentOps: { enabled: false, chatId: null, threadId: null, hashtag: '#payments_ops' },
      },
    });

    await fireAlert(service);

    // Off is a decision, not a fault. If this ever logs, the log becomes noise
    // on every panel that does not use the feature.
    assert.equal(posted.length, 0);
    assert.deepStrictEqual(errors, []);
  });

  it('logs one line for a burst, not one per dropped alert', async () => {
    const { service, posted, errors } = buildService({ storedToken: null, envToken: null });

    // `notifyWebhookFailed` fires once per failed webhook, so a provider
    // outage is exactly when this path runs hottest.
    await fireAlert(service);
    await fireAlert(service);
    await fireAlert(service);
    await fireAlert(service);

    assert.equal(posted.length, 0);
    assert.equal(errors.length, 1);
  });

  it('survives a failing token lookup instead of failing its caller', async () => {
    const { service, posted, errors } = buildService({
      storedTokenThrows: true,
      envToken: 'env-token-456',
    });

    // Both callers await this inside code paths that do not guard it — one
    // from a catch block that then re-throws the ORIGINAL error — so a throw
    // escaping here would corrupt webhook reconciliation and admin replay.
    await fireAlert(service);

    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.url, 'https://api.telegram.org/botenv-token-456/sendMessage');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.includes('[BOT_TOKEN_LOOKUP_FAILED]'), true);
  });
});

// ── The panel's "send a test alert" button ──────────────────────────────────

const CURRENT_ADMIN = { id: 'admin-1' } as unknown as CurrentAdminInterface;
const REQUEST_METADATA = {
  requestId: 'request-1',
  remoteAddress: '203.0.113.10',
  userAgent: 'payment-ops-spec',
} as const;

function buildSettingsService(options: {
  readonly storedToken?: string | null;
  readonly envToken?: string | null;
  readonly relay?: RelayState;
}): {
  readonly service: SettingsService;
  readonly posted: Posted[];
  readonly relayed: Relayed[];
  readonly audits: Array<Record<string, unknown>>;
} {
  const posted: Posted[] = [];
  const relayed: Relayed[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const relayState: RelayState = options.relay ?? 'none';
  const relayQueue = {
    isEnabled: relayState === 'ready' || relayState === 'refuses',
    enqueue: async (event: string, metadata: Record<string, unknown>): Promise<boolean> => {
      relayed.push({ event, metadata });
      return relayState === 'ready';
    },
  };
  const moduleRef =
    relayState === 'none' ? undefined : { get: (): unknown => relayQueue };
  const systemNotifications: Record<string, unknown> = { ...ALERTS_ON };
  if (options.storedToken != null) {
    systemNotifications.botTokenEnc = encryptTotpSecret(options.storedToken, CRYPT_KEY);
  }
  const prismaService = {
    settings: {
      findFirst: async () => ({ id: 'settings-1', systemNotifications }),
      create: async () => ({ id: 'settings-1', systemNotifications }),
    },
    adminAuditLog: {
      create: async (args: { data?: Record<string, unknown> }) => {
        audits.push(args?.data ?? {});
        return {};
      },
    },
  };
  const service = new SettingsService(
    prismaService as never,
    {} as unknown as IconUploadService,
    { cryptKey: CRYPT_KEY } as never,
    {
      post: (url: string, payload: Record<string, unknown>) => {
        posted.push({ url, payload });
        return of({ data: { ok: true } });
      },
    } as never,
    { botToken: options.envToken ?? null } as never,
    undefined,
    undefined,
    moduleRef as never,
  );
  return { service, posted, relayed, audits };
}

describe('SettingsService.sendPaymentOpsAlertTest token resolution', () => {
  it('sends the test with the panel-stored token when the environment has none', async () => {
    const { service, posted } = buildSettingsService({
      storedToken: 'panel-token-123',
      envToken: null,
    });

    await service.sendPaymentOpsAlertTest({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      sendPaymentOpsAlertTestDto: {},
    } as never);

    // The token is stored ENCRYPTED, so this also proves the ciphertext was
    // decrypted on the way to the wire.
    assert.equal(posted.length, 1);
    assert.equal(
      posted[0]?.url,
      'https://api.telegram.org/botpanel-token-123/sendMessage',
    );
    assert.equal(posted[0]?.payload.chat_id, '-1003713706224');
  });

  it('answers with a code naming the real remedy when no token exists anywhere', async () => {
    const { service, posted } = buildSettingsService({ storedToken: null, envToken: null });

    await assert.rejects(
      () =>
        service.sendPaymentOpsAlertTest({
          currentAdmin: CURRENT_ADMIN,
          requestMetadata: REQUEST_METADATA,
          sendPaymentOpsAlertTestDto: {},
        } as never),
      // Not the old generic 'BOT_TOKEN is not configured': the panel turns this
      // code into copy pointing at Settings -> Bot Token, which is where an
      // operator of this product actually fixes it.
      (error: unknown) =>
        String((error as { message?: string }).message).includes(
          'PAYMENT_OPS_ALERT_BOT_TOKEN_NOT_CONFIGURED',
        ),
    );
    assert.equal(posted.length, 0);
  });

  it('relays the test through the cabinet when this host holds no token', async () => {
    // A test button that reaches Telegram by a route the real alert does not
    // use is testing the wrong thing. On the split deployment this used to
    // answer 503 while a real alert would have relayed perfectly well - which
    // told the operator the feature was broken when it was not.
    const { service, posted, relayed, audits } = buildSettingsService({
      storedToken: null,
      envToken: null,
      relay: 'ready',
    });

    await service.sendPaymentOpsAlertTest({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      sendPaymentOpsAlertTestDto: {},
    } as never);

    assert.equal(posted.length, 0);
    assert.equal(relayed.length, 1);
    assert.equal(relayed[0]?.event, 'reiwa.channel.broadcast');
    assert.equal(relayed[0]?.metadata.chatId, '-1003713706224');
    assert.equal(
      Object.prototype.hasOwnProperty.call(relayed[0]?.metadata ?? {}, 'parseMode'),
      false,
    );
    // The audit says which door it went out of.
    const metadata = (audits[0]?.metadata ?? {}) as Record<string, unknown>;
    assert.equal(metadata.via, 'relay');
  });

  it('still posts directly, and records that, when a token is present', async () => {
    // Anti-vacuity: the relay must not swallow a deployment that can send.
    const { service, posted, relayed, audits } = buildSettingsService({
      storedToken: 'panel-token-123',
      relay: 'ready',
    });

    await service.sendPaymentOpsAlertTest({
      currentAdmin: CURRENT_ADMIN,
      requestMetadata: REQUEST_METADATA,
      sendPaymentOpsAlertTestDto: {},
    } as never);

    assert.equal(posted.length, 1);
    assert.deepStrictEqual(relayed, []);
    const metadata = (audits[0]?.metadata ?? {}) as Record<string, unknown>;
    assert.equal(metadata.via, 'direct');
  });
});

/**
 * The split deployment this product actually ships: the bot token lives in
 * reiwa, not here, so "no local token" is the NORMAL state. Every other
 * Telegram sender in the tree already falls back to the reiwa relay; this one
 * did not, which left the alert loud-but-undelivered even after the token fix.
 */
describe('PaymentOpsAlertService reiwa relay fallback', () => {
  it('relays the alert when there is no local token but the relay is up', async () => {
    const { service, posted, relayed, errors } = buildService({
      storedToken: null,
      envToken: null,
      relay: 'ready',
    });

    await fireAlert(service);

    // Nothing went to api.telegram.org (no token to do it with), and the card
    // is on the durable queue instead of being dropped.
    assert.equal(posted.length, 0);
    assert.equal(relayed.length, 1);
    assert.equal(relayed[0]?.event, 'reiwa.channel.broadcast');
    assert.equal(relayed[0]?.metadata.chatId, '-1003713706224');
    assert.equal(
      String(relayed[0]?.metadata.text).includes('kind:webhook_failed'),
      true,
    );
    // Nothing to report HERE - not because the alert is delivered (an accepted
    // enqueue is not a delivery; `isRelayDelivered` is the whole essay on that
    // distinction) but because the queue now owns the outcome. A cabinet that
    // never answers burns four attempts and then emits
    // `reiwa.relay_undelivered`, which writes an `AdminAuditLog` row and cards
    // the operator. Logging an error here as well would fire on every relayed
    // alert, including the ones that arrive.
    assert.deepStrictEqual(errors, []);
  });

  it('carries the forum topic through, and omits it when there is none', async () => {
    const withTopic = buildService({
      relay: 'ready',
      systemNotifications: {
        paymentOps: {
          enabled: true,
          chatId: '-1003713706224',
          threadId: '10',
          hashtag: '#payments_ops',
        },
      },
    });
    await fireAlert(withTopic.service);
    // Stored as a string, sent as the number the cabinet schema wants.
    assert.equal(withTopic.relayed[0]?.metadata.topicThreadId, 10);

    const withoutTopic = buildService({ relay: 'ready' });
    await fireAlert(withoutTopic.service);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        withoutTopic.relayed[0]?.metadata ?? {},
        'topicThreadId',
      ),
      false,
    );
  });

  it('does not touch the relay when a local token exists', async () => {
    // Anti-vacuity for the whole fallback: a host that HAS a token must keep
    // posting directly, not pay for a queue and a network hop it does not
    // need. If the ordering ever flips, the alert stops being the thing whose
    // redaction and formatting are pinned by the direct-path specs.
    const { service, posted, relayed, errors } = buildService({
      storedToken: 'panel-token-123',
      relay: 'ready',
    });

    await fireAlert(service);

    assert.equal(posted.length, 1);
    assert.equal(
      posted[0]?.url,
      'https://api.telegram.org/botpanel-token-123/sendMessage',
    );
    assert.deepStrictEqual(relayed, []);
    assert.deepStrictEqual(errors, []);
  });

  it('relays exactly the text the direct path would have posted', async () => {
    // The alert names a failing webhook. Everything it is allowed to say is
    // decided by `buildWebhookAlertMessage` and `redactPaymentDiagnosticMessage`
    // on the direct path; the fallback must not become a second, laxer door.
    const raw =
      'provider said https://provider.example/raw?token=secret admin@example.com evt_supersecret123456';
    const direct = buildService({ storedToken: 'panel-token-123' });
    await fireAlert(direct.service, { lastError: raw });
    const directText = String(direct.posted[0]?.payload.text ?? '');

    const relay = buildService({ relay: 'ready' });
    await fireAlert(relay.service, { lastError: raw });
    const relayText = String(relay.relayed[0]?.metadata.text ?? '');

    assert.equal(relayText, directText);
    assert.equal(relayText.includes('provider.example'), false);
    assert.equal(relayText.includes('admin@example.com'), false);
    assert.equal(relayText.includes('evt_supersecret123456'), false);
  });

  it('sends no parseMode, so provider text is never read as markup', async () => {
    // The direct path posts with no `parse_mode` and the redactor does not
    // escape markup. Relaying with `parseMode: 'HTML'` would make Telegram
    // parse a provider's `<` or `&` - mangling the alert, or rejecting it,
    // which the relay treats as terminal and the alert is lost.
    const { service, relayed } = buildService({ relay: 'ready' });

    await fireAlert(service, { lastError: 'gateway said <bad> & worse' });

    assert.equal(
      Object.prototype.hasOwnProperty.call(relayed[0]?.metadata ?? {}, 'parseMode'),
      false,
    );
    assert.equal(String(relayed[0]?.metadata.text).includes('<bad> & worse'), true);
  });

  it('keys the relay on a digest, never on the raw webhook event id', async () => {
    // `buildWebhookAlertMessage` renders `event_id:hidden` on purpose and the
    // delivery spec pins that the raw id never reaches an alert. The relay
    // metadata is another door out of rezeis and must hold the same line.
    const { service, relayed } = buildService({ relay: 'ready' });

    await fireAlert(service, {
      id: 'evt_rawpaymentalertsecret123456',
      updatedAt: new Date('2026-08-21T10:00:00.000Z'),
    });

    const eventId = String(relayed[0]?.metadata.eventId ?? '');
    assert.equal(eventId.includes('evt_rawpaymentalertsecret123456'), false);
    assert.equal(eventId.startsWith('payops:'), true);
    // The cabinet validates this field with a REQUIRED `.max(128)` and no soft
    // fallback: an over-long key is a 400, read as non-transient, alert lost.
    assert.equal(eventId.length <= 128, true);
  });

  it('gives a later failure of the same webhook its own key', async () => {
    const first = buildService({ relay: 'ready' });
    await fireAlert(first.service, {
      updatedAt: new Date('2026-08-21T10:00:00.000Z'),
    });
    const second = buildService({ relay: 'ready' });
    await fireAlert(second.service, {
      updatedAt: new Date('2026-08-21T11:00:00.000Z'),
    });
    const again = buildService({ relay: 'ready' });
    await fireAlert(again.service, {
      updatedAt: new Date('2026-08-21T10:00:00.000Z'),
    });

    // Stable for one emission (so a queue retry dedups), different for the
    // next (so the bot does not swallow a second failure as a duplicate).
    assert.notEqual(
      first.relayed[0]?.metadata.eventId,
      second.relayed[0]?.metadata.eventId,
    );
    assert.equal(
      first.relayed[0]?.metadata.eventId,
      again.relayed[0]?.metadata.eventId,
    );
  });

  it('reports no-token-and-no-relay when the relay is not configured', async () => {
    const { service, posted, relayed, errors } = buildService({ relay: 'disabled' });

    await fireAlert(service);

    assert.equal(posted.length, 0);
    assert.deepStrictEqual(relayed, []);
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.includes('[BOT_TOKEN_NOT_CONFIGURED] Payment ops alert NOT delivered.'),
      true,
    );
    assert.equal(errors[0]?.includes('no reiwa relay'), true);
  });

  it('tells a refused enqueue apart from a missing token', async () => {
    const { service, relayed, errors } = buildService({ relay: 'refuses' });

    await fireAlert(service);

    // The attempt WAS made, so this is a different situation with a different
    // remedy - the cabinet link and Redis, not the panel's token field.
    assert.equal(relayed.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.includes('[RELAY_UNAVAILABLE]'), true);
    assert.equal(errors[0]?.includes('BOT_TOKEN_NOT_CONFIGURED'), false);
  });

  it('bounds the relay-unavailable line the same way as the others', async () => {
    const { service, errors } = buildService({ relay: 'refuses' });

    await fireAlert(service);
    await fireAlert(service);
    await fireAlert(service);

    assert.equal(errors.length, 1);
  });
});
