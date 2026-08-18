import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveRequestTimeoutMs } from '../src/common/middleware/request-timeout.middleware';

describe('request timeout route policy', () => {
  it('gives FAQ media uploads the long upload timeout', () => {
    assert.equal(resolveRequestTimeoutMs('/api/admin/faq/uploads'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/faq/uploads?locale=ru'), 120_000);
  });

  it('does not widen similarly named FAQ routes', () => {
    assert.equal(resolveRequestTimeoutMs('/api/admin/faq/uploads-extra'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/faq/faq-1'), 30_000);
  });

  it('preserves infinite stream timeouts', () => {
    assert.equal(resolveRequestTimeoutMs('/api/internal/user/123/stream'), null);
    assert.equal(resolveRequestTimeoutMs('/api/realtime'), null);
  });

  it('exempts CUID reiwa_id streams, not just numeric telegramIds', () => {
    // The cabinet prefers the WebSession reiwa_id, so most live streams
    // carry a CUID rather than a telegramId.
    assert.equal(
      resolveRequestTimeoutMs('/api/internal/user/clzk3q8s90000abcd1234efgh/stream'),
      null,
    );
  });

  it('does not widen similarly named internal routes', () => {
    assert.equal(resolveRequestTimeoutMs('/api/internal/user/123/streaming'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/internal/user/123/devices'), 30_000);
  });

  it('gives BOTH restore routes the long upload timeout', () => {
    // The two shapes differ and the old pattern only covered one of them:
    // `restore/:filename` ends in a slash, `restore-upload` ends at the path
    // end, so the upload route fell through to the 30s default. The edge
    // proxies advertise `client_max_body_size 2g` for exactly that path and the
    // controller accepts 1 GiB by default / 2 GiB hard, so the ceiling everyone
    // else agreed on was undone here by three characters -- and the failure
    // reads as a network fault, not as a policy the app applied to itself.
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/restore-upload'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/restore-upload?force=1'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/restore/dump.sql.gz'), 120_000);
  });

  it('does not widen similarly named backup routes', () => {
    // The widened pattern must not swallow a neighbour: `restored-*` shares the
    // prefix, and the settings/list routes are ordinary JSON.
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/restored-elsewhere'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/settings'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup'), 30_000);
  });
});
