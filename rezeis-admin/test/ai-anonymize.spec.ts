import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { anonymizeTranscript } from '../src/modules/ai-config/utils/anonymize';

describe('anonymizeTranscript (learn-from-tickets PII scrub)', () => {
  it('redacts emails', () => {
    const out = anonymizeTranscript('пишите на john.doe+vpn@example.com спасибо');
    assert.ok(!out.includes('@example.com'));
    assert.ok(out.includes('[email]'));
  });

  it('redacts URLs', () => {
    const out = anonymizeTranscript('ссылка https://panel.internal.example.com/x?token=abc');
    assert.ok(!out.includes('http'));
    assert.ok(out.includes('[ссылка]'));
  });

  it('redacts card-like digit runs', () => {
    const out = anonymizeTranscript('карта 4111 1111 1111 1111 оплачена');
    assert.ok(!/\d{4} \d{4}/.test(out));
    assert.ok(out.includes('[номер]'));
  });

  it('redacts IPv4 addresses', () => {
    const out = anonymizeTranscript('сервер 192.168.10.42 недоступен');
    assert.ok(!out.includes('192.168.10.42'));
    assert.ok(out.includes('[ip]'));
  });

  it('redacts @handles', () => {
    const out = anonymizeTranscript('мой ник @secret_user_123 в телеге');
    assert.ok(!out.includes('@secret_user_123'));
    assert.ok(out.includes('[username]'));
  });

  it('redacts long tokens/keys', () => {
    const out = anonymizeTranscript('ключ sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    assert.ok(!out.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'));
    assert.ok(out.includes('[токен]'));
  });

  it('redacts phone numbers', () => {
    const out = anonymizeTranscript('звоните +7 999 123-45-67 в любое время');
    assert.ok(!out.includes('999 123'));
    assert.ok(out.includes('[номер]'));
  });

  it('redacts bare long digit runs (ids / order numbers)', () => {
    const out = anonymizeTranscript('мой telegram id 123456789 заказ 55501234');
    assert.ok(!out.includes('123456789'));
    assert.ok(!out.includes('55501234'));
  });

  it('redacts unicode/cyrillic-domain emails', () => {
    const out = anonymizeTranscript('почта иван@почта.рф для связи');
    assert.ok(!out.includes('@почта.рф'));
    assert.ok(out.includes('[email]'));
  });

  it('keeps ordinary support text intact', () => {
    const text = 'Как настроить приложение на телефоне? Нажмите импорт и вставьте подписку.';
    assert.equal(anonymizeTranscript(text), text);
  });

  it('caps the length', () => {
    // Spaced words (not one long token) so only the length cap applies.
    assert.equal(anonymizeTranscript('слово '.repeat(200), 100).length, 100);
  });
});
