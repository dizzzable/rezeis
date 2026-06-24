import { Injectable, Logger, Optional } from '@nestjs/common';

import { EmailDeliveryService } from '../../modules/email/services/email-delivery.service';
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

  public constructor(
    @Optional() private readonly emailDelivery?: EmailDeliveryService,
  ) {}

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

    // No real transport wired (minimal runtimes / unit tests): preserve the
    // historical side-effect-free behaviour and log the rendered code at debug
    // level so dev environments can still observe the issued challenge.
    if (this.emailDelivery === undefined) {
      this.logger.debug(
        `Linked account verification code ${input.code} dispatched to ${emailAddress} ` +
          `(expires at ${input.expiresAt.toISOString()})`,
      );
      return;
    }

    // Real SMTP delivery: send the branded code email synchronously so the
    // caller can revoke the challenge if delivery definitively failed.
    const result = await this.emailDelivery.sendVerificationCode({
      to: emailAddress,
      code: input.code,
      expiresAt: input.expiresAt,
    });
    if (!result.success) {
      throw new EmailDeliveryException(
        `Verification email delivery failed: ${result.error ?? 'unknown error'}`,
        'definitely-not-delivered',
      );
    }
  }
}
