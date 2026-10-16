import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readConnection } from '../src/modules/connect-signal/controllers/internal-subscription-connection.controller';

/**
 * The guided walk's live read: "is this profile online right now".
 *
 * `unknown` must stay distinct from every answer that says something about
 * the profile — the walk shows the customer a manual «Всё работает» on it, and
 * reading an outage as "not connected" would keep a working VPN waiting.
 */
const NOW = new Date('2026-10-16T12:00:00.000Z');
const IDENTITY = { remnawaveId: 'uuid-1', panelId: null, panelUsername: null };

function panel(answer: unknown) {
  return { getPanelUserUsage: () => Promise.resolve(answer as never) };
}

describe('readConnection', () => {
  it('passes Remnawave’s instants through, stamped with this panel’s clock', async () => {
    const view = await readConnection(
      panel({
        userTraffic: {
          usedTrafficBytes: 10,
          lifetimeUsedTrafficBytes: 10,
          onlineAt: '2026-10-16T11:59:40.000Z',
          firstConnectedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      IDENTITY,
      NOW,
    );
    assert.deepEqual(view, {
      state: 'known',
      onlineAt: '2026-10-16T11:59:40.000Z',
      firstConnectedAt: '2026-01-01T00:00:00.000Z',
      checkedAt: NOW.toISOString(),
    });
  });

  it('says a never-connected profile is known and offline, not unknown', async () => {
    const view = await readConnection(
      panel({ userTraffic: { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null } }),
      IDENTITY,
      NOW,
    );
    assert.equal(view.state, 'known');
    assert.equal(view.onlineAt, null);
  });

  it('answers unknown for an outage, a block it could not read, and a subscription without a profile', async () => {
    assert.equal((await readConnection(panel(null), IDENTITY, NOW)).state, 'unknown');
    assert.equal((await readConnection(panel({ userTraffic: null }), IDENTITY, NOW)).state, 'unknown');
    let asked = false;
    const view = await readConnection(
      { getPanelUserUsage: () => { asked = true; return Promise.resolve(null); } },
      null,
      NOW,
    );
    assert.equal(view.state, 'unknown');
    assert.equal(asked, false, 'no profile, no request');
  });
});
