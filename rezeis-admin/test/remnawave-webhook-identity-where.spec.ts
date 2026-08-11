import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { panelIdentityWhere } from '../src/modules/remnawave/services/remnawave-webhook.service';
describe('panelIdentityWhere — the inbound mirror of panelUserAddress', () => {
  it('a 2.x uuid matches on remnawaveId alone', () => {
    assert.deepEqual(panelIdentityWhere('330f2b38-1362-46ab-b5c0-dea32167eff9'), {
      remnawaveId: '330f2b38-1362-46ab-b5c0-dea32167eff9',
    });
  });

  it('a numeric identity ALSO matches the recorded panel id', () => {
    // The case this exists for: created on 2.x, panel since upgraded. The row
    // still holds the old uuid in `remnawaveId`, so matching on that alone would
    // miss it on every event the 3.x panel sends — silently, forever.
    assert.deepEqual(panelIdentityWhere('4471'), {
      OR: [{ remnawaveId: '4471' }, { remnawavePanelId: 4471 }],
    });
  });

  it('never parses a uuid into a number', () => {
    // `Number.parseInt('330f2b38-…')` is 330 — a valid-looking id belonging to
    // somebody else. The digits-only test is what stands between that and a
    // reconciliation applied to the wrong customer.
    const where = panelIdentityWhere('330f2b38-1362-46ab-b5c0-dea32167eff9');
    assert.equal('OR' in where, false);
  });

  it('refuses the numeric arm for an id outside the exact integer range', () => {
    const huge = '9007199254740993';
    assert.deepEqual(panelIdentityWhere(huge), { remnawaveId: huge });
  });
});

