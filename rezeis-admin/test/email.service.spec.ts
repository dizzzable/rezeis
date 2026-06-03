import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EmailDeliveryException } from '../src/modules/email/errors/email-delivery.exception';
import { EmailService } from '../src/modules/email/services/email.service';

describe('EmailService', () => {
  it('dispatches linked-account verification codes through the current debug-only transport', async () => {
    const debugMessages: string[] = [];
    const service = new EmailService();
    (service as unknown as { readonly logger: { debug: (message: string) => void } }).logger.debug = (
      message: string,
    ): void => {
      debugMessages.push(message);
    };
    const expiresAt = new Date('2026-04-17T05:17:00.000Z');

    await service.sendLinkedAccountVerificationCode({
      emailAddress: '  user@example.com  ',
      code: '123456',
      expiresAt,
    });

    assert.deepStrictEqual(debugMessages, [
      'Linked account verification code 123456 dispatched to user@example.com ' +
        '(expires at 2026-04-17T05:17:00.000Z)',
    ]);
  });

  it('rejects empty recipient emails before dispatch', async () => {
    const debugMessages: string[] = [];
    const service = new EmailService();
    (service as unknown as { readonly logger: { debug: (message: string) => void } }).logger.debug = (
      message: string,
    ): void => {
      debugMessages.push(message);
    };

    await assert.rejects(
      async (): Promise<void> => {
        await service.sendLinkedAccountVerificationCode({
          emailAddress: '   ',
          code: '123456',
          expiresAt: new Date('2026-04-17T05:17:00.000Z'),
        });
      },
      (error: unknown): boolean => {
        assert.ok(error instanceof EmailDeliveryException);
        assert.equal(error.deliveryState, 'definitely-not-delivered');
        assert.equal(error.message, 'Refusing to send verification code: invalid email address');
        return true;
      },
    );

    assert.deepStrictEqual(debugMessages, []);
  });

  it('rejects control-character recipient emails before dispatch', async () => {
    const debugMessages: string[] = [];
    const service = new EmailService();
    (service as unknown as { readonly logger: { debug: (message: string) => void } }).logger.debug = (
      message: string,
    ): void => {
      debugMessages.push(message);
    };

    await assert.rejects(
      async (): Promise<void> => {
        await service.sendLinkedAccountVerificationCode({
          emailAddress: 'user@example.com\r\nBCC:evil@example.com',
          code: '123456',
          expiresAt: new Date('2026-04-17T05:17:00.000Z'),
        });
      },
      (error: unknown): boolean => {
        assert.ok(error instanceof EmailDeliveryException);
        assert.equal(error.deliveryState, 'definitely-not-delivered');
        assert.equal(error.message, 'Refusing to send verification code: invalid email address');
        return true;
      },
    );

    assert.deepStrictEqual(debugMessages, []);
  });
});
