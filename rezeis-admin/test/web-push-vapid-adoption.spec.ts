import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SystemEventPayload } from '../src/common/services/system-events.service';
import { WebPushService } from '../src/modules/push/services/web-push.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { decryptTotpSecret, encryptTotpSecret } from '../src/modules/two-factor/utils/secret-cipher';

/**
 * VAPID keys live in the panel, and nowhere else.
 *
 * `SettingsService.getDecryptedWebPushConfig` used to fall back to
 * `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_CONTACT_EMAIL` at SEND
 * time. That branch is gone. Two things have to be true for the removal to be
 * safe rather than merely tidy, and each has its own describe block below:
 *
 *   1. Nothing serves from the environment any more — not the resolver, not
 *      the status the settings card renders. A second configuration surface is
 *      a second thing to disagree with the first.
 *   2. A deployment left with no keys SAYS SO. The panel can only GENERATE a
 *      keypair — `SettingsService.generateWebPushKeys` is the only writer and
 *      there is no paste path — so "stop reading the env" and "generate fresh
 *      keys" would be the same action, and that action strands every browser
 *      subscription in existence: each was created by `pushManager.subscribe()`
 *      against the OLD public key and does not re-bind. Adoption is what makes
 *      the removal safe, and a deployment where adoption did not happen is one
 *      where push is dead. Discovering that from a container log is what
 *      "silently" meant; it is now a `system.web_push_unconfigured` event.
 */

const CRYPT_KEY = 'test-crypt-key-0123456789';

const PANEL_CONFIG = {
  publicKey: 'panel-public-key',
  privateKey: 'panel-private-key',
  subject: 'mailto:ops@example.test',
};

afterEach(clearVapidEnv);

// ── 1. The environment is not a configuration surface ────────────────────────

describe('web-push VAPID resolution', () => {
  it('returns null when the keys exist only in the environment', async () => {
    // The removed branch, stated as a behaviour. With all three variables set
    // and an empty panel store this used to hand back a live keypair and a
    // `source: 'env'` label; restoring that branch turns this null into a
    // config object and fails here.
    process.env.VAPID_PUBLIC_KEY = 'env-public-key';
    process.env.VAPID_PRIVATE_KEY = 'env-private-key';
    process.env.VAPID_CONTACT_EMAIL = 'ops@example.test';

    const settingsService = createSettingsService({});

    assert.equal(await settingsService.getDecryptedWebPushConfig(), null);
  });

  it('reports web-push as unconfigured to the SPA when only the environment has keys', async () => {
    // Same branch, reached through the surface the operator actually looks at.
    // `getWebPushStatus` feeds the settings overview; an env fallback here is
    // how a card could read "configured" while the panel entry was empty.
    process.env.VAPID_PUBLIC_KEY = 'env-public-key';
    process.env.VAPID_PRIVATE_KEY = 'env-private-key';

    const status = await createSettingsService({}).getWebPushStatus();

    assert.deepStrictEqual(status, { configured: false, publicKey: '' });
  });

  it('does not fall back to the environment when the stored key will not decrypt', async () => {
    // The other way into the old fallback: the panel HAS a key, decryption
    // throws, and control used to drop through to the env branch. A corrupt
    // panel key must disable push, not quietly resurrect a stale keypair whose
    // subscriptions the operator has already replaced.
    process.env.VAPID_PUBLIC_KEY = 'env-public-key';
    process.env.VAPID_PRIVATE_KEY = 'env-private-key';

    const settingsService = createSettingsService({
      webPush: {
        publicKey: 'panel-public-key',
        privateKeyEnc: 'not-a-valid-aes-gcm-envelope',
        contactEmail: 'ops@example.test',
      },
    });

    assert.equal(await settingsService.getDecryptedWebPushConfig(), null);
  });

  it('still resolves the panel keypair', async () => {
    // Anti-vacuity control for the three assertions above: without it, a
    // `getDecryptedWebPushConfig` that returned `null` unconditionally — push
    // dead on every deployment — would pass all of them.
    process.env.VAPID_PUBLIC_KEY = 'env-public-key';
    process.env.VAPID_PRIVATE_KEY = 'env-private-key';

    const settingsService = createSettingsService({
      webPush: {
        publicKey: 'panel-public-key',
        privateKeyEnc: encryptTotpSecret('panel-private-key', CRYPT_KEY),
        contactEmail: 'ops@example.test',
      },
    });

    assert.deepStrictEqual(await settingsService.getDecryptedWebPushConfig(), {
      publicKey: 'panel-public-key',
      privateKey: 'panel-private-key',
      subject: 'mailto:ops@example.test',
    });
  });
});

// ── 2. The one-time migration that keeps existing subscribers ────────────────

describe('WebPushService env→panel VAPID adoption', () => {
  it('copies the environment keypair into the panel instead of generating a new one', async () => {
    const { service, state } = createService({ envKeys: true });

    await service.onModuleInit();

    assert.equal(state.updates.length, 1);
    const written = state.updates[0]?.data.systemNotifications as Record<string, unknown>;
    const webPush = written.webPush as Record<string, unknown>;

    // Same public key, verbatim. This is the assertion that separates adoption
    // from "generate a fresh pair in the panel": a new public key would leave
    // every existing WebPushSubscription row pointing at a key the browsers
    // never agreed to, and no amount of retrying brings them back.
    assert.equal(webPush.publicKey, 'env-public-key');
    // Private half encrypted at rest, exactly as the panel generator stores it,
    // and it must round-trip to the original — an adoption that wrote a
    // corrupted secret would look identical in the row and fail at send time.
    assert.equal(decryptTotpSecret(webPush.privateKeyEnc as string, CRYPT_KEY), 'env-private-key');
    assert.equal(webPush.contactEmail, 'ops@example.test');
  });

  it('preserves every other key in the shared systemNotifications column', async () => {
    // `systemNotifications` is a single JSON column several features share.
    // Writing it back wholesale from a stale copy would silently drop the bot
    // token and the Telegram delivery config on every boot of an env-configured
    // deployment — a far worse bug than the one being fixed.
    const { service, state } = createService({
      envKeys: true,
      systemNotifications: {
        botTokenEnc: 'encrypted-bot-token',
        telegram: { enabled: true, chatId: '-100123' },
      },
    });

    await service.onModuleInit();

    const written = state.updates[0]?.data.systemNotifications as Record<string, unknown>;
    assert.equal(written.botTokenEnc, 'encrypted-bot-token');
    assert.deepStrictEqual(written.telegram, { enabled: true, chatId: '-100123' });
    assert.notEqual(written.webPush, undefined);
  });

  it('does not write when the keys already come from the panel', async () => {
    // Anti-vacuity control. Everything above asserts that a write happened;
    // without this, an implementation that wrote on EVERY boot — clobbering the
    // operator's panel keys with stale env values on each restart — would pass
    // the whole file.
    const { service, state } = createService({ envKeys: true, webPushConfig: PANEL_CONFIG });

    await service.onModuleInit();

    assert.deepStrictEqual(state.updates, []);
  });

  it('leaves panel keys that appeared mid-transaction alone', async () => {
    // The settings read is repeated inside the transaction precisely so a
    // concurrent operator "Generate keys" click — or the other container, since
    // both api and worker run this — is not overwritten by an env value that is
    // now older intent, and whose subscriptions are already being replaced.
    const { service, state } = createService({
      envKeys: true,
      systemNotifications: { webPush: { publicKey: 'panel-public-key' } },
    });

    await service.onModuleInit();

    assert.deepStrictEqual(state.updates, []);
  });

  it('marks the migration done so a later "Remove keys" survives a restart', async () => {
    // Without the marker, adoption's only trigger is "the panel store is
    // empty" — which is exactly the state an operator creates on purpose by
    // clicking "Remove keys". The next container restart would re-adopt the
    // leftover `.env` pair and switch push back on behind them.
    const { service, state } = createService({ envKeys: true });

    await service.onModuleInit();

    const written = state.updates[0]?.data.systemNotifications as Record<string, unknown>;
    assert.equal(typeof written.webPushEnvAdoptedAt, 'string');
  });

  it('does not re-adopt once the migration marker is present', async () => {
    const { service, state } = createService({
      envKeys: true,
      systemNotifications: { webPushEnvAdoptedAt: '2026-08-20T10:00:00.000Z' },
    });

    await service.onModuleInit();

    assert.deepStrictEqual(state.updates, []);
  });

  it('does not touch the panel when no environment keys exist', async () => {
    const { service, state } = createService({});

    await service.onModuleInit();

    assert.deepStrictEqual(state.updates, []);
  });

  it('never lets an adoption failure take push down with it', async () => {
    const { service } = createService({
      envKeys: true,
      transactionError: new Error('settings table is locked'),
    });

    // Must not reject: `onModuleInit` throwing aborts the Nest bootstrap, so a
    // transient settings failure would take the whole panel down at start.
    await service.onModuleInit();
  });
});

// ── 3. A deployment with no keys is not allowed to be quiet ──────────────────

describe('WebPushService announces a deployment that cannot deliver push', () => {
  it('raises an ERROR event when env keys are set but could not be migrated', async () => {
    // The state the removal creates and the reason it was deferred: the three
    // variables are sitting right there in `.env`, so every sign the operator
    // has says push is configured — and since the send-time fallback is gone,
    // it is not. Before this event the only trace was a container log line.
    const { service, state } = createService({
      envKeys: true,
      transactionError: new Error('settings table is locked'),
    });

    await service.onModuleInit();

    assert.equal(state.events.length, 1);
    const event = state.events[0];
    assert.equal(event?.type, 'system.web_push_unconfigured');
    assert.equal(event?.severity, 'ERROR');
    assert.equal(event?.category, 'SYSTEM');
    assert.equal(event?.metadata?.legacyEnvKeysStranded, true);
    // The reason has to travel with the event. "Push is off" without "because
    // the settings table is locked" is a second investigation, not an alert.
    assert.match(String(event?.metadata?.reason), /settings table is locked/);
  });

  it('raises an ERROR event when the private key cannot be encrypted at rest', async () => {
    // Same class of stranding, different cause: no REZEIS_CRYPT_KEY means the
    // env pair cannot be moved into the panel. This used to be survivable —
    // the env keys kept delivering — and is not any more.
    const { service, state } = createService({ envKeys: true, cryptKey: '' });

    await service.onModuleInit();

    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]?.severity, 'ERROR');
    assert.match(String(state.events[0]?.metadata?.reason), /REZEIS_CRYPT_KEY/);
  });

  it('raises a WARNING event when nothing is configured anywhere', async () => {
    // A deployment that simply does not use push. Still surfaced — "push does
    // nothing" is a fact an operator needs before they wonder why a
    // notification never arrived — but it is not an emergency.
    const { service, state } = createService({});

    await service.onModuleInit();

    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]?.type, 'system.web_push_unconfigured');
    assert.equal(state.events[0]?.severity, 'WARNING');
    assert.equal(state.events[0]?.metadata?.legacyEnvKeysStranded, false);
  });

  it('says nothing when the panel holds a keypair', async () => {
    // Anti-vacuity control: an implementation that emitted on every boot would
    // pass all three assertions above and train operators to ignore the event.
    const { service, state } = createService({ webPushConfig: PANEL_CONFIG });

    await service.onModuleInit();

    assert.deepStrictEqual(state.events, []);
  });

  it('says nothing on the boot that completes the migration', async () => {
    // Adoption succeeding IS a configured deployment. Alerting here would fire
    // on the one upgrade this whole migration exists to make uneventful.
    const { service, state } = createService({ envKeys: true });

    await service.onModuleInit();

    assert.deepStrictEqual(state.events, []);
  });
});

// ── Harness ─────────────────────────────────────────────────────────────────

function clearVapidEnv(): void {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_CONTACT_EMAIL;
}

/**
 * A real `SettingsService` over a stubbed settings row — the resolver under
 * test is the production one, not a re-implementation of it.
 */
function createSettingsService(systemNotifications: Record<string, unknown>): SettingsService {
  const prismaService = {
    settings: {
      findFirst: async () => ({ id: 'settings-1', systemNotifications }),
    },
  };
  return new SettingsService(
    prismaService as never,
    {} as unknown as IconUploadService,
    { cryptKey: CRYPT_KEY } as never,
  );
}

interface Options {
  /** Panel-managed keys the mocked `SettingsService` resolves, if any. */
  readonly webPushConfig?: {
    publicKey: string;
    privateKey: string;
    subject: string;
  };
  /** Put the legacy `VAPID_*` trio in the environment for this test. */
  readonly envKeys?: boolean;
  readonly systemNotifications?: Record<string, unknown>;
  readonly cryptKey?: string;
  readonly transactionError?: Error;
}

function createService(options: Options) {
  if (options.envKeys === true) {
    process.env.VAPID_PUBLIC_KEY = 'env-public-key';
    process.env.VAPID_PRIVATE_KEY = 'env-private-key';
    process.env.VAPID_CONTACT_EMAIL = 'ops@example.test';
  }

  const state = {
    updates: [] as { where: { id: number }; data: { systemNotifications: unknown } }[],
    events: [] as SystemEventPayload[],
  };

  const settingsRow = {
    id: 1,
    systemNotifications: options.systemNotifications ?? {},
  };

  const tx = {
    settings: {
      findFirst: async () => settingsRow,
      update: async (args: { where: { id: number }; data: { systemNotifications: unknown } }) => {
        state.updates.push(args);
        return {};
      },
    },
  };

  const prisma = {
    settings: { findFirst: async () => settingsRow },
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>): Promise<T> => {
      if (options.transactionError !== undefined) throw options.transactionError;
      return fn(tx);
    },
    webPushSubscription: {
      count: async () => 0,
      findMany: async () => [],
    },
  };

  const settingsService = {
    getDecryptedWebPushConfig: async () => options.webPushConfig ?? null,
  };

  const systemEvents = {
    emit: (event: SystemEventPayload) => {
      state.events.push(event);
    },
  };

  const service = new WebPushService(
    prisma as never,
    settingsService as never,
    { cryptKey: options.cryptKey ?? CRYPT_KEY } as never,
    systemEvents as never,
  );

  return { service, state };
}
