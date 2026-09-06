import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';

/**
 * The one switch standing between an upgrade and a mailshot
 * ═════════════════════════════════════════════════════════
 * Eight things have to be true before an automated notification becomes a
 * letter. Seven of them are open on a freshly upgraded install: the operator's
 * per-type toggles default to on, the subscriber has chosen nothing, the
 * templates are seeded active, the mailer is registered, SMTP is usually
 * enabled already because the product mails sign-in codes — and the address is
 * verified, because a sign-in address is a verified address.
 *
 * `notifyUsers` is the eighth, and it is the only closed one. It is what keeps
 * the promise the owner made in their own words: most addresses on file were
 * attached to sign in, not to hear from the product, and their owners never
 * asked for mail.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * Every other gate has a test. This one had none: the fanout's specs stub
 * `getSmtpSettings` wholesale, so they assert what the gate DOES with a value
 * and never how the value is composed. Change
 *
 *     notifyUsers: dbEmail.notifyUsers === true
 *
 * to `?? this.emailConfiguration.enabled`, or to `!== false` — the shape every
 * neighbouring field on the same lines uses, and therefore the change the next
 * person makes in the name of consistency — and the whole suite stays green
 * while the next boot starts mailing a live customer base.
 *
 * So: the composition itself, at the only place it happens.
 */

function build(dbEmail: Record<string, unknown> | undefined) {
  const prismaService = {
    settings: {
      findFirst: async () => ({
        systemNotifications: dbEmail === undefined ? {} : { email: dbEmail },
        brandingSettings: null,
      }),
    },
  };
  // Env says "we can send mail" as loudly as it can. That must not become
  // "send THIS mail to customers".
  const emailConfiguration = {
    enabled: true,
    host: 'smtp.example.com',
    port: 587,
    username: 'u',
    password: 'p',
    fromAddress: 'a@b.co',
    fromName: 'X',
    useTls: true,
    useSsl: false,
  };
  return new EmailDeliveryService(
    emailConfiguration as never,
    prismaService as never,
    {} as never,
  );
}

describe('notifyUsers on an install that upgraded into the feature', () => {
  it('is off when the key was never written', async () => {
    // THE case. Every row created before this release is this row.
    const config = await build({ enabled: true, host: 'smtp.example.com' }).getSmtpSettings();
    assert.equal(config.enabled, true, 'SMTP itself stays usable — that is the point');
    assert.equal(config.notifyUsers, false);
  });

  it('is off when there is no email block at all', async () => {
    const config = await build(undefined).getSmtpSettings();
    assert.equal(config.notifyUsers, false);
  });

  it('does not inherit the env switch', async () => {
    // `enabled` falls back to env; this one deliberately does not. An install
    // that mails sign-in codes must not thereby mail notifications.
    const config = await build({}).getSmtpSettings();
    assert.equal(config.enabled, true, 'the env fallback for `enabled` still works');
    assert.equal(config.notifyUsers, false, 'and it must not reach `notifyUsers`');
  });

  it('is off for anything that is not the boolean true', async () => {
    // A JSON column is hand-editable and has held strings before. `"false"`
    // is the trap this codebase has already paid for once.
    for (const stored of ['true', 'false', 1, 0, null, 'yes', {}]) {
      const config = await build({ notifyUsers: stored }).getSmtpSettings();
      assert.equal(
        config.notifyUsers,
        false,
        `stored ${JSON.stringify(stored)} opened the inbox`,
      );
    }
  });

  it('is on only when an operator wrote true', async () => {
    const config = await build({ notifyUsers: true }).getSmtpSettings();
    assert.equal(config.notifyUsers, true);
  });
});
