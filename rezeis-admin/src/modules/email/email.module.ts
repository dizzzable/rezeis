import { Module } from '@nestjs/common';

import { SMTP_MAIL_CLIENT } from './email.constants';
import { EmailService } from './services/email.service';
import { SmtpMailClientService } from './services/smtp-mail-client.service';

/**
 * Registers the minimal admin-side email delivery services.
 */
@Module({
  providers: [
    EmailService,
    {
      provide: SMTP_MAIL_CLIENT,
      useClass: SmtpMailClientService,
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
