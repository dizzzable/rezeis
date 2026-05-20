import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EmailService } from '../src/modules/email/services/email.service';
import { runSmtpQuitWithTimeout, runSmtpSessionCloseSilently } from '../src/modules/email/services/smtp-mail-client.service';

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

  it('sends the linked-account password reset email with the expected recipient and content', async () => {
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
    const resetUrl = 'https://app.example.com/password-reset?token=token-123';
    await service.sendLinkedAccountPasswordResetLink({
      emailAddress: 'user@example.com',
      resetUrl,
      expiresAt,
    });
    assert.deepStrictEqual(actualMessage, {
      to: 'user@example.com',
      from: '"Rezeis Admin" <no-reply@example.com>',
      replyTo: 'support@example.com',
      subject: 'Rezeis linked-account password reset',
      text: [
        'Use the link below to reset your Rezeis linked-account password.',
        '',
        `Reset link: ${resetUrl}`,
        `Expires at: ${expiresAt.toISOString()}`,
        '',
        'If you did not request this email, you can ignore it.',
      ].join('\n'),
      html: [
        '<p>Use the link below to reset your Rezeis linked-account password.</p>',
        `<p><a href="${resetUrl}">Reset password</a></p>`,
        `<p><strong>Reset link:</strong> <a href="${resetUrl}">${resetUrl}</a></p>`,
        `<p><strong>Expires at:</strong> ${expiresAt.toISOString()}</p>`,
        '<p>If you did not request this email, you can ignore it.</p>',
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
        message: 'failed to deliver transactional email',
      },
    );
    assert.equal(sendMailCallsCount, 0);
  });

  it('bounds SMTP graceful quit waits and swallows late quit failures', async () => {
    const startedAt = Date.now();
    await runSmtpQuitWithTimeout(
      async (): Promise<void> => {
        await new Promise<void>((resolve): void => {
          setTimeout(resolve, 50);
        });
      },
      5,
    );
    assert.ok(Date.now() - startedAt < 45);

    const rawError = new Error('smtp quit failed after timeout');
    await assert.doesNotReject(
      async (): Promise<void> => {
        await runSmtpQuitWithTimeout(async (): Promise<void> => {
          throw rawError;
        }, 5);
      },
    );

    const observedUnhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      observedUnhandledReasons.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await runSmtpQuitWithTimeout(
        async (): Promise<void> => {
          await new Promise<void>((resolve): void => {
            setTimeout(resolve, 10);
          });
          throw rawError;
        },
        5,
      );
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 20);
      });
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
    assert.deepEqual(observedUnhandledReasons, []);
  });

  it('swallows synchronous SMTP graceful quit failures inside the bounded cleanup helper', async () => {
    const rawError = new Error('smtp quit sync failure smtp://admin:secret@mail.internal');

    await assert.doesNotReject(
      async (): Promise<void> => {
        await runSmtpQuitWithTimeout((): Promise<void> => {
          throw rawError;
        }, 5);
      },
    );
  });

  it('swallows SMTP session close failures so cleanup cannot mask delivery state', async () => {
    const rawError = new Error('smtp close failed redis://default:secret@redis.internal payment_id=pay_secret');

    await assert.doesNotReject(async (): Promise<void> => {
      await runSmtpSessionCloseSilently(async (): Promise<void> => {
        throw rawError;
      });
    });

    await assert.doesNotReject(async (): Promise<void> => {
      await runSmtpSessionCloseSilently((): Promise<void> => {
        throw rawError;
      });
    });

    let closeAttempted = false;
    await runSmtpSessionCloseSilently(async (): Promise<void> => {
      closeAttempted = true;
    });
    assert.equal(closeAttempted, true);
  });
});
