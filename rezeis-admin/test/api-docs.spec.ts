import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldEnableApiDocs } from '../src/common/http/api-docs';

describe('API docs exposure policy', () => {
  it('mounts documentation only when validated app configuration enables it outside production', () => {
    assert.equal(shouldEnableApiDocs({ docsEnabled: true, nodeEnv: 'development' }), true);
    assert.equal(shouldEnableApiDocs({ docsEnabled: false, nodeEnv: 'development' }), false);
    assert.equal(shouldEnableApiDocs({ docsEnabled: true, nodeEnv: 'test' }), true);
    assert.equal(shouldEnableApiDocs({ docsEnabled: true }), true);
  });

  it('keeps Swagger disabled in production even when API_DOCS_ENABLED is true', () => {
    assert.equal(shouldEnableApiDocs({ docsEnabled: true, nodeEnv: 'production' }), false);
    assert.equal(shouldEnableApiDocs({ docsEnabled: false, nodeEnv: 'production' }), false);
  });
});
