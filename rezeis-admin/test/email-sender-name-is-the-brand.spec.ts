import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ConfigModule } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';

import { emailConfig } from '../src/common/config/email.config';
import { validateEnvironment } from '../src/common/config/env.schema';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';

/**
 * WHO THE CUSTOMER'S INBOX SAYS A LETTER IS FROM.
 *
 * The sender name was meant to be the operator's brand out of the box — the
 * resolver says so: stored name → explicit `EMAIL_FROM_NAME` → brand. It never
 * reached the third step, for two reasons that each made it unreachable alone:
 *
 *   - the environment schema gave `EMAIL_FROM_NAME` a default of `'Rezeis'`,
 *     and `ConfigModule.forRoot({ validate })` writes every validated value that
 *     is absent from `process.env` back INTO `process.env`
 *     (`assignVariablesToProcess`). By the time the resolver asked "did the
 *     operator set a name?", the answer was always yes, and the name was ours;
 *   - `.env.example`, which every install copies, set `EMAIL_FROM_NAME=Rezeis`
 *     outright.
 *
 * So every code, reset link and notification a customer received arrived as
 * "Rezeis <no-reply@…>" — the panel's name, not the brand they bought — unless
 * a name had been saved in the panel, and the SMTP form saves the name it shows,
 * which was that one. The cases below boot the configuration through the real
 * `ConfigModule` with the panel's own `validateEnvironment`, because the
 * mechanism that did the damage lives there and nowhere a hand-built config
 * object would reach.
 */

const BRAND = 'Acme VPN';
const REQUIRED = {
  REZEIS_CRYPT_KEY: 'sender-name-spec-crypt-key-0123456789abcdef',
  DATABASE_PASSWORD: 'sender-name-spec-db-password',
};

const originalEnvironment = process.env;

afterEach(() => {
  process.env = originalEnvironment;
});

/**
 * The panel's configuration after boot, over `env` and nothing else — the way
 * `AppModule` configures it (`validate: validateEnvironment`), minus the `.env`
 * file, which the container does not have: compose hands the variables over as
 * the process environment.
 */
async function bootEmailConfig(env: Record<string, string>) {
  process.env = { ...env };
  await ConfigModule.forRoot({ validate: validateEnvironment, ignoreEnvFile: true });
  return emailConfig();
}

/**
 * The `From` header of a letter sent to a customer, exactly as it goes on the
 * wire: the real `sendImmediate` and the real nodemailer message composer
 * (its stream transport), with only the SMTP socket and the template lookup
 * replaced. SMTP is switched on in the stored settings so the letter is
 * actually composed; the sender name is left to whatever `stored` says.
 */
async function fromHeaderOf(
  config: ReturnType<typeof emailConfig>,
  stored: Record<string, unknown> = {},
  brandName: string = BRAND,
): Promise<string> {
  const settings = {
    systemNotifications: { email: { enabled: true, host: 'smtp.example.com', ...stored } },
    brandingSettings: { brandName },
  };
  const service = new EmailDeliveryService(
    config,
    { settings: { findFirst: async () => settings } } as never,
    { render: async () => ({ subject: 'Код', html: '<p>123456</p>' }) } as never,
  );
  const wire = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const messages: string[] = [];
  (service as unknown as { transporter: unknown }).transporter = {
    sendMail: async (mail: Parameters<typeof wire.sendMail>[0]) => {
      const info = await wire.sendMail(mail);
      messages.push(info.message.toString());
      return info;
    },
  };

  const result = await service.sendImmediate({
    to: 'customer@example.com',
    templateType: '__verification_code__',
    variables: {},
    rawHtml: '<p>123456</p>',
  });
  assert.equal(result.success, true, `the letter was not sent: ${result.error ?? ''}`);
  assert.equal(messages.length, 1);
  const header = messages[0].split('\n').find((line) => line.startsWith('From: '));
  assert.ok(header !== undefined, 'the letter has no From header');
  return header.slice('From: '.length);
}

/** The display name a mail client reads out of that header. */
async function senderOf(
  config: ReturnType<typeof emailConfig>,
  stored: Record<string, unknown> = {},
  brandName: string = BRAND,
): Promise<string> {
  const parsed = addressparser(await fromHeaderOf(config, stored, brandName), { flatten: true });
  assert.equal(parsed.length, 1, 'the From header reads as more than one sender');
  assert.equal(parsed[0].address, config.fromAddress, 'the sender address was damaged');
  return parsed[0].name;
}

/** The `EMAIL_*` lines of `.env.example`, as `env_file` hands them to the container. */
function envExampleEmailBlock(): Record<string, string> {
  const text = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
  const block: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(EMAIL_[A-Z_]+)=(.*)$/.exec(line);
    if (match !== null) block[match[1]] = match[2];
  }
  assert.ok('EMAIL_ENABLED' in block, '.env.example no longer has an email block to read');
  return block;
}

describe('the sender name a customer sees', () => {
  it('is the operator’s brand when nobody set one', async () => {
    const config = await bootEmailConfig({ ...REQUIRED });

    assert.equal(await senderOf(config), BRAND);
  });

  it('is the operator’s brand on an install made from .env.example', async () => {
    const config = await bootEmailConfig({ ...REQUIRED, ...envExampleEmailBlock() });

    assert.equal(await senderOf(config), BRAND);
  });

  it('is the name the environment sets, when it sets one', async () => {
    // Still an override: an operator who put a name in `EMAIL_FROM_NAME` keeps it.
    const config = await bootEmailConfig({ ...REQUIRED, EMAIL_FROM_NAME: 'Acme Mail' });

    assert.equal(await senderOf(config), 'Acme Mail');
  });

  it('is the name saved in the panel, over both', async () => {
    // «Уведомления» → «Настройки доставки» → «Email (SMTP)» → «Имя отправителя».
    const config = await bootEmailConfig({ ...REQUIRED, EMAIL_FROM_NAME: 'Acme Mail' });

    assert.equal(await senderOf(config, { fromName: 'Acme Support' }), 'Acme Support');
  });
});

/**
 * The name went into the header as `"${name}" <address>` — quotes pasted
 * around whatever the operator typed. A brand with a quote or a backslash in
 * it broke out of them, and the composer re-read the damaged string: the
 * customer saw «WingerPro VPN» for «Winger "Pro" VPN». The name now goes to
 * nodemailer as `{ name, address }`, and it writes the RFC 5322 quoted
 * string (or encoded word) itself.
 */
describe('a sender name with characters that need quoting', () => {
  it('reaches the inbox intact, as a correctly quoted string', async () => {
    const config = await bootEmailConfig({ ...REQUIRED });

    assert.equal(
      await fromHeaderOf(config, { fromName: 'Winger "Pro" VPN' }),
      `"Winger \\"Pro\\" VPN" <${config.fromAddress}>`,
    );
    assert.equal(await senderOf(config, { fromName: 'Winger "Pro" VPN' }), 'Winger "Pro" VPN');
    assert.equal(await senderOf(config, { fromName: 'Back\\slash' }), 'Back\\slash');
  });

  it('reaches the inbox intact when it is the brand', async () => {
    // No name saved: the brand, as operator-typed as any saved name.
    const config = await bootEmailConfig({ ...REQUIRED });

    assert.equal(await senderOf(config, {}, 'Winger "Pro" VPN'), 'Winger "Pro" VPN');
  });

  it('cannot smuggle a second sender address in', async () => {
    const config = await bootEmailConfig({ ...REQUIRED });

    assert.equal(await senderOf(config, { fromName: 'x" <evil@example.net>, "y' }), 'x" <evil@example.net>, "y');
  });
});
