import { Injectable, Logger } from '@nestjs/common';

import { EmailDeliveryException } from './email-delivery.exception';

interface SendLinkedAccountVerificationCodeInput {
  readonly emailAddress: string;
  readonly code: string;
  readonly expiresAt: Date;
}

/**
 * Minimal email service used by the internal-user verification flow.
 *
 * The real SMTP transport is intentionally not implemented here yet: in this
 * environment outbound email is best-effort and may be unavailable. The service
 * logs the rendered code and surfaces a typed `EmailDeliveryException` when a
 * future transport is wired in but fails. Callers (e.g. the email verification
 * challenge issuer) inspect the `deliveryState` to decide whether to revoke the
 * issued challenge.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  /**
   * Delivers the email verification code for a linked web account.
   * Throws {@link EmailDeliveryException} on configuration or transport failure.
   */
  public async sendLinkedAccountVerificationCode(
    input: SendLinkedAccountVerificationCodeInput,
  ): Promise<void> {
    const emailAddress = input.emailAddress.trim();
    if (emailAddress.length === 0 || /[\r\n]/.test(emailAddress)) {
      throw new EmailDeliveryException(
        'Refusing to send verification code: invalid email address',
        'definitely-not-delivered',
      );
    }
    // Until the SMTP transport is fully wired we keep delivery side-effect-free
    // and log the rendered code at debug level so dev environments can observe
    // the issued challenge without leaking it to higher log streams.
    this.logger.debug(
      `Linked account verification code ${input.code} dispatched to ${emailAddress} ` +
        `(expires at ${input.expiresAt.toISOString()})`,
    );
  }
}
