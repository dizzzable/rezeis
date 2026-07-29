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
});
