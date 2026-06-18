import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  signBackupDownloadToken,
  verifyBackupDownloadToken,
} from '../src/modules/backup/utils/backup-download-token.util';

const SECRET = 'test-crypt-key-0123456789';

describe('backup download token', () => {
  it('round-trips a valid token back to its record id', () => {
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);
    assert.equal(verifyBackupDownloadToken(token, SECRET), 'rec-1');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);
    assert.equal(verifyBackupDownloadToken(token, 'other-secret'), null);
  });

  it('rejects an expired token', () => {
    const token = signBackupDownloadToken('rec-1', SECRET, -1_000);
    assert.equal(verifyBackupDownloadToken(token, SECRET), null);
  });

  it('rejects a tampered record id', () => {
    const token = signBackupDownloadToken('rec-1', SECRET, 60_000);
    const decoded = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const tampered = Buffer.from(decoded.replace('rec-1', 'rec-2')).toString('base64url');
    assert.equal(verifyBackupDownloadToken(tampered, SECRET), null);
  });

  it('rejects malformed input', () => {
    assert.equal(verifyBackupDownloadToken('not-a-token', SECRET), null);
    assert.equal(verifyBackupDownloadToken('', SECRET), null);
  });
});
