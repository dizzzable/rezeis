import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as nodemailer from 'nodemailer';

import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';
import type { SendEmailPayload } from '../src/modules/email/interfaces/email.interface';

/**
 * A LETTER'S `Date` IS THE ONE ITS CALLER PINS, WHEN IT PINS ONE.
 *
 * The guest reply letter dates itself with the stamp its link carries, so an
 * inbox that sorts by `Date` shows the letters in the order of their links
 * (`support-guest-letter-order.spec.ts`). That only holds if the date reaches
 * the header nodemailer writes: the real `sendImmediate` and the real message
 * composer (stream transport) here, with only the SMTP socket replaced.
 */

async function dateHeaderOf(payload: Partial<SendEmailPayload>): Promise<string> {
  const service = new EmailDeliveryService(
    {
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      username: null,
      password: null,
      fromAddress: 'no-reply@example.com',
      fromName: 'Acme VPN',
      useTls: true,
      useSsl: false,
    } as never,
    { settings: { findFirst: async () => ({ systemNotifications: {}, brandingSettings: {} }) } } as never,
    { render: async () => ({ subject: 'Поддержка ответила', html: '<p>ответ</p>' }) } as never,
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
    to: 'guest@example.com',
    templateType: '__support_guest_reply__',
    variables: {},
    rawHtml: '<p>ответ</p>',
    ...payload,
  });
  assert.equal(result.success, true, `the letter was not sent: ${result.error ?? ''}`);
  const header = messages[0]?.split('\n').find((line) => line.startsWith('Date: '));
  assert.ok(header !== undefined, 'the letter has no Date header');
  return header.slice('Date: '.length);
}

describe('the Date header of a directly sent letter', () => {
  it('is the date the caller pinned', async () => {
    const pinned = new Date('2026-09-23T10:00:05.123Z');

    assert.equal(await dateHeaderOf({ date: pinned }), 'Wed, 23 Sep 2026 10:00:05 +0000');
  });

  it('is the moment it is composed when nothing is pinned', async () => {
    const before = Date.now();
    const header = await dateHeaderOf({});

    const dated = Date.parse(header);
    assert.ok(dated >= Math.floor(before / 1000) * 1000 && dated <= Date.now(), `dated ${header}`);
  });
});
