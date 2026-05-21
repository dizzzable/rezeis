import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldEnableApiDocs } from '../src/common/http/api-docs';

describe('API docs exposure policy', () => {
  it('mounts documentation only when validated app configuration enables it', () => {
    assert.equal(shouldEnableApiDocs({ docsEnabled: true }), true);
    assert.equal(shouldEnableApiDocs({ docsEnabled: false }), false);
  });
});
