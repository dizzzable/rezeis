import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';

describe('PasswordHashService', () => {
  it('stores passwords as scrypt hashes and verifies only the original plain text', async () => {
    const service = new PasswordHashService();
    const password = 'correct horse battery staple';

    const storedHash = await service.hashPassword({
      plainTextPassword: password,
      audience: 'subscriber',
    });

    // `scrypt$<N>$<r>$<p>$<salt>$<hash>`. The parameter block is what lets a
    // cost increase land without locking out the hashes already stored; the
    // migration itself is proved in `test/password-hash-parameters.spec.ts`.
    assert.match(storedHash, /^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[0-9a-f]+\$[0-9a-f]+$/i);
    assert.notEqual(storedHash, password);
    assert.equal(await service.verifyPassword({ plainTextPassword: password, passwordHash: storedHash }), true);
    assert.equal(
      await service.verifyPassword({ plainTextPassword: 'wrong password', passwordHash: storedHash }),
      false,
    );
  });

  it('uses a fresh salt for each hash of the same password', async () => {
    const service = new PasswordHashService();

    const firstHash = await service.hashPassword({
      plainTextPassword: 'same-password',
      audience: 'subscriber',
    });
    const secondHash = await service.hashPassword({
      plainTextPassword: 'same-password',
      audience: 'subscriber',
    });

    assert.notEqual(firstHash, secondHash);
    assert.equal(
      await service.verifyPassword({ plainTextPassword: 'same-password', passwordHash: firstHash }),
      true,
    );
    assert.equal(
      await service.verifyPassword({ plainTextPassword: 'same-password', passwordHash: secondHash }),
      true,
    );
  });

  it('rejects legacy bcrypt-shaped or malformed hashes instead of throwing', async () => {
    const service = new PasswordHashService();

    for (const passwordHash of [
      '$2b$10$legacy-bcrypt-hash',
      'scrypt$not-hex$not-hex',
      'scrypt$00$00',
      'scrypt$65536$8$2$not-hex$not-hex',
      'plain-password',
    ]) {
      assert.equal(
        await service.verifyPassword({ plainTextPassword: 'plain-password', passwordHash }),
        false,
        `Expected ${passwordHash} to be rejected`,
      );
    }
  });
});
