import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import {
  CAPABILITIES_CACHE_TTL_MS,
  CAPABILITIES_NEGATIVE_CACHE_TTL_MS,
  RemnawaveCapabilities,
  RemnawaveVersionService,
} from '../src/modules/remnawave/services/remnawave-version.service';

/**
 * Capability detection decides, on a live paying panel, whether rezeis calls
 * endpoints that exist. Three panel versions are in play — 2.7.4 for paying
 * customers, 2.8.x for testers and 3.2.1 — so every field is asserted in full
 * for every pinned version: an extra or renamed field fails these tests rather
 * than shipping as a silent shape change.
 */

interface PanelMock {
  /** `undefined` = endpoint not stubbed (behaves as "returned null"). */
  readonly recap?: () => Promise<{ version?: string | null } | null>;
  readonly metadata?: () => Promise<{ version: string | null } | null>;
}

interface Harness {
  readonly service: RemnawaveVersionService;
  readonly counts: { recap: number; metadata: number };
}

function makeService(panel: PanelMock): Harness {
  const counts = { recap: 0, metadata: 0 };
  const api = {
    getSystemRecap: async (): Promise<unknown> => {
      counts.recap += 1;
      return panel.recap ? panel.recap() : null;
    },
    getSystemMetadata: async (): Promise<unknown> => {
      counts.metadata += 1;
      return panel.metadata ? panel.metadata() : null;
    },
  } as unknown as RemnawaveApiService;
  return { service: new RemnawaveVersionService(api), counts };
}

/** A panel that reports `version` from the recap endpoint. */
function panelOn(version: string): PanelMock {
  return { recap: async () => ({ version }) };
}

async function capabilitiesOf(version: string): Promise<RemnawaveCapabilities> {
  return makeService(panelOn(version)).service.getCapabilities();
}

// ── Controllable clock (the service reads Date.now for its cache window) ─────

const originalDateNow = Date.now;
let clock = Date.parse('2026-08-05T12:00:00.000Z');

beforeEach(() => {
  clock = Date.parse('2026-08-05T12:00:00.000Z');
  Date.now = (): number => clock;
});

afterEach(() => {
  Date.now = originalDateNow;
});

function advance(ms: number): void {
  clock += ms;
}

describe('RemnawaveVersionService — pinned panel versions', () => {
  it('2.7.4 (paying production) reports every version-gated flag off', async () => {
    assert.deepEqual(await capabilitiesOf('2.7.4'), {
      version: '2.7.4',
      major: 2,
      minor: 7,
      patch: 4,
      supported: true,
      reachable: true,
      liveIpControl: false,
      bandwidthNodesUsers: false,
      userAddressing: 'uuid',
      connectionsApi: 'ip-control',
      userLookups: { byTelegramId: true, byEmail: true },
    });
  });

  it('2.8.0 (testers) reports every version-gated flag on', async () => {
    assert.deepEqual(await capabilitiesOf('2.8.0'), {
      version: '2.8.0',
      major: 2,
      minor: 8,
      patch: 0,
      supported: true,
      reachable: true,
      liveIpControl: true,
      bandwidthNodesUsers: true,
      userAddressing: 'uuid',
      connectionsApi: 'ip-control',
      userLookups: { byTelegramId: true, byEmail: true },
    });
  });

  it('2.9.0 keeps the 2.x shape but is outside the tested set', async () => {
    assert.deepEqual(await capabilitiesOf('2.9.0'), {
      version: '2.9.0',
      major: 2,
      minor: 9,
      patch: 0,
      // Not in the tested set: 2.9 has never been run against rezeis, so the
      // operator keeps getting the untested-version banner.
      supported: false,
      reachable: true,
      liveIpControl: true,
      bandwidthNodesUsers: true,
      userAddressing: 'uuid',
      connectionsApi: 'ip-control',
      userLookups: { byTelegramId: true, byEmail: true },
    });
  });

  it('3.1.0 gets the 3.x shape but not the tested-version badge', async () => {
    assert.deepEqual(await capabilitiesOf('3.1.0'), {
      version: '3.1.0',
      major: 3,
      minor: 1,
      patch: 0,
      // Not a stale leftover of the 3.x work: the tested set is exact, and
      // 3.1 has never been run. Only 3.2 earned its way in.
      supported: false,
      reachable: true,
      liveIpControl: true,
      bandwidthNodesUsers: true,
      userAddressing: 'id',
      connectionsApi: 'connections',
      userLookups: { byTelegramId: false, byEmail: false },
    });
  });

  it('3.2.1 is supported, with the 3.x shape rather than the 2.x one', async () => {
    assert.deepEqual(await capabilitiesOf('3.2.1'), {
      version: '3.2.1',
      major: 3,
      minor: 2,
      patch: 1,
      // 3.2 is in the tested set: it has been run against a live panel, so the
      // operator gets no untested-version banner.
      //
      // `liveIpControl: true` below is not a contradiction, though the comment
      // that used to sit here said it was — it claimed the flag "stays off
      // because 3.x deleted `ip-control/*`". That was true while nothing read
      // the replacement. The adapter now speaks `connections/*`, so live
      // connection data IS available on 3.x, and the flag means exactly that:
      // whether the data can be had, not which route family serves it. A
      // comment describing the opposite of its own assertion is worse than no
      // comment — the next reader "fixes" the assertion in the wrong direction.
      supported: true,
      reachable: true,
      liveIpControl: true,
      bandwidthNodesUsers: true,
      userAddressing: 'id',
      connectionsApi: 'connections',
      userLookups: { byTelegramId: false, byEmail: false },
    });
  });

  it('an unparseable version is reachable but wholly unknown', async () => {
    assert.deepEqual(await capabilitiesOf('nightly-build'), {
      version: 'nightly-build',
      major: null,
      minor: null,
      patch: null,
      supported: false,
      // The panel answered — it just did not answer with a semver.
      reachable: true,
      liveIpControl: false,
      bandwidthNodesUsers: false,
      userAddressing: 'unknown',
      connectionsApi: 'unknown',
      userLookups: { byTelegramId: false, byEmail: false },
    });
  });

  it('a calver build string parses but stays unknown — 2026 is not 2.x', async () => {
    // Reachable in production: a panel that switches to date-based build
    // strings reports e.g. `2026.08.05`, which parses cleanly to major 2026.
    // The version *is* readable, so this never touches the unparseable branch
    // — it goes through `userAddressingFor` / `connectionsApiFor`, whose
    // fallback is the only thing keeping rezeis from addressing a live panel
    // by a scheme it does not run.
    assert.deepEqual(await capabilitiesOf('2026.08.05'), {
      version: '2026.08.05',
      major: 2026,
      minor: 8,
      patch: 5,
      supported: false,
      reachable: true,
      // `major === 2 && minor >= 8` must not be fooled by a 2026.8 build.
      liveIpControl: false,
      bandwidthNodesUsers: true,
      userAddressing: 'unknown',
      connectionsApi: 'unknown',
      userLookups: { byTelegramId: false, byEmail: false },
    });
  });

  it('a future 4.x is unknown rather than silently addressed as 3.x', async () => {
    assert.deepEqual(await capabilitiesOf('4.0.0'), {
      version: '4.0.0',
      major: 4,
      minor: 0,
      patch: 0,
      supported: false,
      reachable: true,
      liveIpControl: false,
      bandwidthNodesUsers: true,
      userAddressing: 'unknown',
      connectionsApi: 'unknown',
      userLookups: { byTelegramId: false, byEmail: false },
    });
  });

  it('a pre-2.x panel is unknown rather than silently addressed as 2.x', async () => {
    assert.deepEqual(await capabilitiesOf('1.9.9'), {
      version: '1.9.9',
      major: 1,
      minor: 9,
      patch: 9,
      supported: false,
      reachable: true,
      liveIpControl: false,
      bandwidthNodesUsers: false,
      userAddressing: 'unknown',
      connectionsApi: 'unknown',
      userLookups: { byTelegramId: false, byEmail: false },
    });
  });

  it('only majors 2 and 3 ever produce a concrete addressing / api family', async () => {
    // The doc comments on `userAddressingFor` / `connectionsApiFor` claim
    // "anything else stays unknown". Sweep the neighbourhood of the two known
    // majors plus a calver major so that replacing either fallback with a
    // concrete guess fails here instead of shipping.
    for (const major of [0, 1, 4, 5, 9, 42, 2026]) {
      const caps = await capabilitiesOf(`${major}.0.0`);
      assert.equal(caps.major, major);
      assert.equal(
        caps.userAddressing,
        'unknown',
        `major ${major} must not guess a user-addressing scheme`,
      );
      assert.equal(
        caps.connectionsApi,
        'unknown',
        `major ${major} must not guess a live-connection endpoint family`,
      );
    }

    for (const [version, addressing, api] of [
      ['2.8.0', 'uuid', 'ip-control'],
      ['3.2.1', 'id', 'connections'],
    ] as const) {
      const caps = await capabilitiesOf(version);
      assert.equal(caps.userAddressing, addressing);
      assert.equal(caps.connectionsApi, api);
    }
  });

  it('an unreachable panel is unknown, not "2.x with everything off"', async () => {
    const { service } = makeService({
      recap: async () => {
        throw new Error('ECONNREFUSED');
      },
      metadata: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.deepEqual(await service.getCapabilities(), {
      version: null,
      major: null,
      minor: null,
      patch: null,
      supported: false,
      reachable: false,
      liveIpControl: false,
      bandwidthNodesUsers: false,
      userAddressing: 'unknown',
      connectionsApi: 'unknown',
      userLookups: { byTelegramId: false, byEmail: false },
    });
  });

  it('a 401 on both reads reads exactly like an outage — never as a known panel', async () => {
    const unauthorized = async (): Promise<never> => {
      throw new Error('Request failed with status code 401');
    };
    const { service } = makeService({ recap: unauthorized, metadata: unauthorized });
    const caps = await service.getCapabilities();
    assert.equal(caps.userAddressing, 'unknown');
    assert.equal(caps.connectionsApi, 'unknown');
    assert.equal(caps.reachable, false);
  });
});

describe('RemnawaveVersionService — version source', () => {
  it('prefers the recap version and does not touch metadata', async () => {
    const harness = makeService({
      recap: async () => ({ version: '2.7.4' }),
      metadata: async () => ({ version: '9.9.9' }),
    });
    const caps = await harness.service.getCapabilities();
    assert.equal(caps.version, '2.7.4');
    assert.equal(harness.counts.recap, 1);
    assert.equal(harness.counts.metadata, 0);
  });

  it('falls back to metadata when recap has no usable version', async () => {
    for (const recap of [
      async (): Promise<null> => null,
      async (): Promise<{ version: null }> => ({ version: null }),
      async (): Promise<{ version: string }> => ({ version: '' }),
      async (): Promise<never> => {
        throw new Error('recap not found');
      },
    ]) {
      const harness = makeService({ recap, metadata: async () => ({ version: '2.8.0' }) });
      const caps = await harness.service.getCapabilities();
      assert.equal(caps.version, '2.8.0');
      assert.equal(caps.liveIpControl, true);
      assert.equal(harness.counts.metadata, 1);
    }
  });

  it('is unreachable when neither source carries a version', async () => {
    const harness = makeService({
      recap: async () => ({ version: null }),
      metadata: async () => ({ version: null }),
    });
    const caps = await harness.service.getCapabilities();
    assert.equal(caps.reachable, false);
    assert.equal(caps.version, null);
    assert.equal(harness.counts.recap, 1);
    assert.equal(harness.counts.metadata, 1);
  });
});

describe('RemnawaveVersionService — cache windows', () => {
  it('caches a successful detection for the positive TTL', async () => {
    const harness = makeService(panelOn('2.8.0'));
    await harness.service.getCapabilities();
    advance(CAPABILITIES_CACHE_TTL_MS - 1);
    await harness.service.getCapabilities();
    assert.equal(harness.counts.recap, 1);

    advance(2);
    await harness.service.getCapabilities();
    assert.equal(harness.counts.recap, 2);
  });

  it('holds a successful detection well past the negative TTL', async () => {
    const harness = makeService(panelOn('2.8.0'));
    await harness.service.getCapabilities();
    advance(CAPABILITIES_NEGATIVE_CACHE_TTL_MS * 4);
    await harness.service.getCapabilities();
    // A success must not inherit the short window — that would quadruple the
    // panel read rate for no reason.
    assert.equal(harness.counts.recap, 1);
  });

  it('retries a failed detection after the short negative TTL', async () => {
    let version: string | null = null;
    const harness = makeService({ recap: async () => (version === null ? null : { version }) });

    const first = await harness.service.getCapabilities();
    assert.equal(first.reachable, false);

    // Still inside the negative window: cached, no extra panel traffic.
    advance(CAPABILITIES_NEGATIVE_CACHE_TTL_MS - 1);
    await harness.service.getCapabilities();
    assert.equal(harness.counts.recap, 1);

    // Past it — and still far inside the 5-minute positive window, which is
    // the whole point: a transient auth blip must not pin every capability to
    // all-false until the positive TTL expires.
    version = '2.8.0';
    advance(2);
    const recovered = await harness.service.getCapabilities();
    assert.equal(harness.counts.recap, 2);
    assert.equal(recovered.version, '2.8.0');
    assert.equal(recovered.liveIpControl, true);
    assert.ok(CAPABILITIES_NEGATIVE_CACHE_TTL_MS + 1 < CAPABILITIES_CACHE_TTL_MS);
  });

  it('gives an unparseable version the negative window too', async () => {
    const harness = makeService(panelOn('nightly-build'));
    await harness.service.getCapabilities();
    advance(CAPABILITIES_NEGATIVE_CACHE_TTL_MS + 1);
    await harness.service.getCapabilities();
    assert.equal(harness.counts.recap, 2);
  });

  it('keeps the negative TTL strictly shorter than the positive one', () => {
    assert.ok(
      CAPABILITIES_NEGATIVE_CACHE_TTL_MS < CAPABILITIES_CACHE_TTL_MS,
      'a negative TTL at or above the positive TTL would not shorten anything',
    );
  });

  it('force bypasses the cache entirely', async () => {
    let version = '2.7.4';
    const harness = makeService({ recap: async () => ({ version }) });

    await harness.service.getCapabilities();
    version = '2.8.0';

    const cached = await harness.service.getCapabilities();
    assert.equal(cached.version, '2.7.4');
    assert.equal(harness.counts.recap, 1);

    const forced = await harness.service.getCapabilities(true);
    assert.equal(forced.version, '2.8.0');
    assert.equal(harness.counts.recap, 2);

    // The forced read replaces the cache rather than bypassing and discarding.
    const afterForce = await harness.service.getCapabilities();
    assert.equal(afterForce.version, '2.8.0');
    assert.equal(harness.counts.recap, 2);
  });
});
