import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plategaBuyerMetadata, plategaUserEmail } from '../src/modules/payments/utils/platega-buyer.util';

/**
 * Platega's three recipes for `metadata.user_email` (its memo «Как передавать
 * e-mail покупателя» and the create pages of 30.10 / 04.11.2026), and the one
 * rule over them: one buyer, one address, on every payment.
 */
describe('plategaUserEmail', () => {
  const buyer = { id: 'cm3buyer0000', telegramId: null, email: null, webAccountEmail: null };

  it('takes the numeric Telegram id at telegram.org first — never a username, never without a domain', () => {
    assert.equal(
      plategaUserEmail({ ...buyer, telegramId: 5512345678n, email: 'ivan.petrov@gmail.com' }),
      '5512345678@telegram.org',
    );
  });

  it('takes the buyer’s own address unchanged but for surrounding spaces, then the web account’s', () => {
    assert.equal(plategaUserEmail({ ...buyer, email: '  Ivan.Petrov@Gmail.com ' }), 'Ivan.Petrov@Gmail.com');
    assert.equal(plategaUserEmail({ ...buyer, webAccountEmail: 'web@yandex.ru' }), 'web@yandex.ru');
  });

  it('passes over an address that is not one', () => {
    for (const email of ['', '   ', 'ivan', 'ivan@', '@mail.ru', 'ivan@localhost', 'iv an@mail.ru', `${'a'.repeat(250)}@mail.ru`]) {
      assert.equal(plategaUserEmail({ ...buyer, email, webAccountEmail: 'web@yandex.ru' }), 'web@yandex.ru', email);
    }
  });

  it('falls back to our id of the buyer at mail.ru — the same address on every payment', () => {
    assert.equal(plategaUserEmail(buyer), 'cm3buyer0000@mail.ru');
    assert.equal(plategaUserEmail({ ...buyer, telegramId: 0n }), 'cm3buyer0000@mail.ru');
  });
});

describe('plategaBuyerMetadata', () => {
  it('carries our id of the buyer beside the address', () => {
    assert.deepStrictEqual(
      plategaBuyerMetadata({ id: 'cm3buyer0000', telegramId: 42n, email: null, webAccountEmail: null }),
      { user_email: '42@telegram.org', userId: 'cm3buyer0000' },
    );
  });
});
