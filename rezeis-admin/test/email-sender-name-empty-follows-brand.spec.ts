import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminEmailController } from '../src/modules/email/controllers/admin-email.controller';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';

/**
 * AN EMPTY «ИМЯ ОТПРАВИТЕЛЯ» IS "USE THE BRAND", AND STAYS THAT WAY.
 *
 * The SMTP card was filled from `GET /admin/email/settings`, which answered
 * with the name letters would go out under right now, and the card would not
 * save an empty one. So the first save wrote that name into the database and
 * made it a stored choice — "Rezeis" for years; after that default was removed,
 * today's brand, which a later brand rename would never reach.
 *
 * The card is now given the name SAVED in the panel (empty when none) and,
 * separately, the name an empty field sends, which it shows as a placeholder.
 * An empty save is stored as "not set", so the letters keep following the
 * brand. These cases go through the controller the SPA calls.
 */

interface StoredEmail {
  [key: string]: unknown;
}

/**
 * The panel's settings row, held in memory: the SMTP block the card writes and
 * the brand «WEB Reiwa» writes. Saves go through the real row-lock path.
 */
function buildPanel(input: { readonly email?: StoredEmail; readonly envFromName?: string | null }) {
  const row = {
    id: 'settings-1',
    systemNotifications: { email: { enabled: true, host: 'smtp.example.com', ...(input.email ?? {}) } } as Record<
      string,
      unknown
    >,
    brandingSettings: { brandName: 'Acme VPN' } as Record<string, unknown>,
  };
  const settings = {
    findFirst: async () => row,
    update: async ({ data }: { data: { systemNotifications: Record<string, unknown> } }) => {
      row.systemNotifications = data.systemNotifications;
      return row;
    },
  };
  const tx = { settings, $queryRaw: async () => [{ id: row.id }] };
  const prisma = {
    settings,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };
  const service = new EmailDeliveryService(
    {
      enabled: false,
      host: null,
      port: 587,
      username: null,
      password: null,
      fromAddress: 'no-reply@acme.example',
      fromName: input.envFromName ?? null,
      useTls: true,
      useSsl: false,
    },
    prisma as never,
    { render: async () => ({ subject: 'Код', html: '<p>1</p>' }) } as never,
  );
  return { row, service, controller: new AdminEmailController(service) };
}

function storedEmail(row: { systemNotifications: Record<string, unknown> }): StoredEmail {
  return row.systemNotifications.email as StoredEmail;
}

describe('what the SMTP card is given', () => {
  it('is an empty name when none was saved, with the brand as what an empty one sends', async () => {
    const { controller } = buildPanel({});

    const settings = await controller.getSettings();

    assert.equal(settings.fromName, '');
    assert.equal(settings.fromNameFallback, 'Acme VPN');
    assert.equal(settings.fromNameFallbackSource, 'brand');
  });

  it('is the saved name, when one was saved', async () => {
    const { controller } = buildPanel({ email: { fromName: 'Acme Support' } });

    const settings = await controller.getSettings();

    assert.equal(settings.fromName, 'Acme Support');
    assert.equal(settings.fromNameFallback, 'Acme VPN');
  });

  it('names EMAIL_FROM_NAME as what an empty one sends, when the environment sets it', async () => {
    const { controller } = buildPanel({ envFromName: 'Acme Mail' });

    const settings = await controller.getSettings();

    assert.equal(settings.fromName, '');
    assert.equal(settings.fromNameFallback, 'Acme Mail');
    assert.equal(settings.fromNameFallbackSource, 'env');
  });

  it('is the same view in the answer to a save', async () => {
    const { controller } = buildPanel({ email: { fromName: 'Rezeis' } });

    const saved = await controller.updateSettings({ fromName: '' });

    assert.equal(saved.fromName, '');
    assert.equal(saved.fromNameFallback, 'Acme VPN');
  });
});

describe('an empty sender name, saved', () => {
  it('is stored as not set, and the letters follow the brand from then on', async () => {
    // The install that saved "Rezeis" from the old pre-filled card.
    const { row, service, controller } = buildPanel({ email: { fromName: 'Rezeis' } });

    await controller.updateSettings({ fromName: '   ' });

    assert.equal('fromName' in storedEmail(row), false, 'a blank name was stored as a name');
    assert.equal((await service.getSmtpSettings()).fromName, 'Acme VPN');
    row.brandingSettings = { brandName: 'Beta VPN' };
    assert.equal((await service.getSmtpSettings()).fromName, 'Beta VPN');
  });

  it('reads a blank name stored before this change as not set', async () => {
    // Rows written by earlier versions can hold `''` or spaces; neither is a name.
    const { service, controller } = buildPanel({ email: { fromName: '   ' } });

    assert.equal((await controller.getSettings()).fromName, '');
    assert.equal((await service.getSmtpSettings()).fromName, 'Acme VPN');
  });

  it('keeps a real name, without the spaces around it', async () => {
    const { row, service, controller } = buildPanel({});

    await controller.updateSettings({ fromName: '  Acme Support ' });

    assert.equal(storedEmail(row).fromName, 'Acme Support');
    assert.equal((await service.getSmtpSettings()).fromName, 'Acme Support');
  });
});
