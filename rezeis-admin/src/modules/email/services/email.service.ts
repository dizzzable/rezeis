import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { z } from 'zod';

import { emailConfig } from '../../../common/config/email.config';
import { InvalidRecipientEmailDeliveryException } from '../errors/email-delivery.exception';
import { SMTP_MAIL_CLIENT } from '../email.constants';

interface SmtpMailMessage {
  readonly to: string;
  readonly from: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

interface SmtpMailClient {
  sendMail(input: SmtpMailMessage): Promise<void>;
}

interface SendLinkedAccountVerificationCodeInput {
  readonly emailAddress: string;
  readonly code: string;
  readonly expiresAt: Date;
}

const VERIFICATION_EMAIL_SUBJECT = 'Rezeis linked-account verification code';
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F]/;
const recipientEmailSchema = z
  .string()
  .email()
  .refine(
    (value): boolean => !CONTROL_CHARACTER_PATTERN.test(value),
    'recipient email must not contain control characters',
  );

/**
 * Composes and dispatches admin-side transactional emails.
 */
@Injectable()
export class EmailService {
  public constructor(
    @Inject(SMTP_MAIL_CLIENT)
    private readonly smtpMailClient: SmtpMailClient,
    @Inject(emailConfig.KEY)
    private readonly configuration: ConfigType<typeof emailConfig>,
  ) {}

  /**
   * Sends the linked-account email verification code to the target email address.
   */
  public async sendLinkedAccountVerificationCode(
    input: SendLinkedAccountVerificationCodeInput,
  ): Promise<void> {
    const recipientEmailAddress = validateRecipientEmailAddress(input.emailAddress);
    await this.smtpMailClient.sendMail({
      to: recipientEmailAddress,
      from: formatMailbox(this.configuration.fromAddress, this.configuration.fromName),
      replyTo: this.configuration.replyTo,
      subject: VERIFICATION_EMAIL_SUBJECT,
      text: createVerificationEmailText(input),
      html: createVerificationEmailHtml(input),
    });
  }
}

function createVerificationEmailText(input: SendLinkedAccountVerificationCodeInput): string {
  return [
    'Your Rezeis linked-account verification code is below.',
    '',
    `Code: ${input.code}`,
    `Expires at: ${input.expiresAt.toISOString()}`,
    '',
    'If you did not request this code, you can ignore this email.',
  ].join('\n');
}

function createVerificationEmailHtml(input: SendLinkedAccountVerificationCodeInput): string {
  return [
    '<p>Your Rezeis linked-account verification code is below.</p>',
    `<p><strong>Code:</strong> <code>${input.code}</code></p>`,
    `<p><strong>Expires at:</strong> ${input.expiresAt.toISOString()}</p>`,
    '<p>If you did not request this code, you can ignore this email.</p>',
  ].join('');
}

function formatMailbox(address: string, name: string): string {
  const safeName = name.trim().replace(/"/g, '\\"');
  return `"${safeName}" <${address}>`;
}

function validateRecipientEmailAddress(emailAddress: string): string {
  const normalizedEmailAddress = emailAddress.trim();
  const parsedEmailAddress = recipientEmailSchema.safeParse(normalizedEmailAddress);
  if (parsedEmailAddress.success) {
    return parsedEmailAddress.data;
  }
  throw new InvalidRecipientEmailDeliveryException();
}
