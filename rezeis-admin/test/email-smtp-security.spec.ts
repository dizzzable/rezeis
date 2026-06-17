import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveSmtpSecurity } from '../src/modules/email/services/email-delivery.service';
import type { SmtpSettingsInterface } from '../src/modules/email/interfaces/email.interface';

/**
 * SMTP encryption is chosen by PORT, not by the raw toggle, so a "use SSL on
 * 587" misconfiguration upgrades via STARTTLS instead of crashing the TLS
 * handshake (`SSL routines:...:wrong version number`). Guards that mapping.
 */
function cfg(partial: Partial<SmtpSettingsInterface>): SmtpSettingsInterface {
  return {
    enabled: true,
    host: 'smtp.example.com',
    port: 587,
    username: 'u',
    password: 'p',
    fromAddress: 'a@b.co',
    fromName: 'X',
    useTls: false,
    useSsl: false,
    ...partial,
  };
}

describe('deriveSmtpSecurity', () => {
  it('uses implicit TLS only on port 465', () => {
    assert.deepEqual(deriveSmtpSecurity(cfg({ port: 465, useSsl: false })), {
      secure: true,
      requireTls: false,
    });
  });

  it('auto-heals "SSL on 587" to STARTTLS (no implicit TLS handshake)', () => {
    assert.deepEqual(deriveSmtpSecurity(cfg({ port: 587, useSsl: true })), {
      secure: false,
      requireTls: true,
    });
  });

  it('uses STARTTLS on 587 when TLS is requested', () => {
    assert.deepEqual(deriveSmtpSecurity(cfg({ port: 587, useTls: true })), {
      secure: false,
      requireTls: true,
    });
  });

  it('treats port 25 the same (plaintext + optional STARTTLS)', () => {
    assert.deepEqual(deriveSmtpSecurity(cfg({ port: 25, useTls: false, useSsl: false })), {
      secure: false,
      requireTls: false,
    });
  });

  it('honours explicit implicit-TLS on a custom port', () => {
    assert.deepEqual(deriveSmtpSecurity(cfg({ port: 2465, useSsl: true })), {
      secure: true,
      requireTls: false,
    });
  });

  it('uses STARTTLS on a custom port when only TLS is set', () => {
    assert.deepEqual(deriveSmtpSecurity(cfg({ port: 2525, useTls: true, useSsl: false })), {
      secure: false,
      requireTls: true,
    });
  });
});
