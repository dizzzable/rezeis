import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InvalidRecipientEmailDeliveryException } from '../src/modules/email/errors/email-delivery.exception';
import { EmailService } from '../src/modules/email/services/email.service';

interface CapturedMailMessage {
  readonly to: string;
  readonly from: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

describe('EmailService', () => {
  it('sends the linked-account verification email with the expected recipient and content', async () => {
    let actualMessage: CapturedMailMessage | null = null;
    const smtpMailClient = {
      sendMail: async (input: CapturedMailMessage): Promise<void> => {
        actualMessage = input;
      },
    };
    const service = new EmailService(smtpMailClient as never, {
      fromAddress: 'no-reply@example.com',
      fromName: 'Rezeis Admin',
      replyTo: 'support@example.com',
    } as never);
    const expiresAt = new Date('2026-04-17T05:17:00.000Z');
    await service.sendLinkedAccountVerificationCode({
      emailAddress: 'user@example.com',
      code: '123456',
      expiresAt,
    });
    assert.deepStrictEqual(actualMessage, {
      to: 'user@example.com',
      from: '"Rezeis Admin" <no-reply@example.com>',
      replyTo: 'support@example.com',
      subject: 'Rezeis linked-account verification code',
      text: [
        'Your Rezeis linked-account verification code is below.',
        '',
        'Code: 123456',
        `Expires at: ${expiresAt.toISOString()}`,
        '',
        'If you did not request this code, you can ignore this email.',
      ].join('\n'),
      html: [
        '<p>Your Rezeis linked-account verification code is below.</p>',
        '<p><strong>Code:</strong> <code>123456</code></p>',
        `<p><strong>Expires at:</strong> ${expiresAt.toISOString()}</p>`,
        '<p>If you did not request this code, you can ignore this email.</p>',
      ].join(''),
    });
  });

  it('rejects an invalid persisted recipient email before SMTP send', async () => {
    let sendMailCallsCount: number = 0;
    const smtpMailClient = {
      sendMail: async (): Promise<void> => {
        sendMailCallsCount += 1;
      },
    };
    const service = new EmailService(smtpMailClient as never, {
      fromAddress: 'no-reply@example.com',
      fromName: 'Rezeis Admin',
      replyTo: 'support@example.com',
    } as never);
    await assert.rejects(
      async (): Promise<void> => {
        await service.sendLinkedAccountVerificationCode({
          emailAddress: 'user@example.com\r\nBCC:evil@example.com',
          code: '123456',
          expiresAt: new Date('2026-04-17T05:17:00.000Z'),
        });
      },
      {
        name: 'InvalidRecipientEmailDeliveryException',
        message: 'failed to deliver linked-account verification email',
      },
    );
    assert.equal(sendMailCallsCount, 0);
  });
});
