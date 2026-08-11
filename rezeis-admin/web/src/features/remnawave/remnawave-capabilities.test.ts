import { beforeEach, describe, expect, it, vi } from 'vitest'

import { normalizeCapabilities, remnawaveApi } from '@/features/remnawave/remnawave-api'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const mockedGet = vi.mocked(api.get)

/**
 * `RemnawaveCapabilities` is hand-mirrored from the backend service, so the
 * only thing standing between a backend/SPA drift and a wrong branch on a live
 * panel is this guard. The three-valued unions are the sharp edge: the backend
 * really does send `'unknown'`, and a value the SPA has never heard of must
 * degrade to "we do not know" rather than being waved through by a cast.
 */

const PANEL_274 = {
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
}

/**
 * The other end of the supported range. Every union value differs from the
 * 2.7.4 payload above — `id` addressing, the `connections` family, neither
 * lookup shortcut — so a normalizer that quietly substituted 2.x defaults
 * would still pass the case above and fail here.
 */
const PANEL_321 = {
  version: '3.2.1',
  major: 3,
  minor: 2,
  patch: 1,
  supported: true,
  reachable: true,
  // ON, and this fixture has to say so: the backend computes
  // `liveIpControl: major === 3 || (major === 2 && minor >= 8)`, so 3.2.1 is
  // true and no payload the service can emit carries `false` here. 3.x did
  // remove `ip-control/*`, but it replaced the family with `connections/*` —
  // which is what `connectionsApi` below names and what the adapter reads.
  // A fixture asserting the opposite pins a shape the producer cannot
  // produce, and would have gone green over a real 3.x regression.
  liveIpControl: true,
  bandwidthNodesUsers: true,
  userAddressing: 'id',
  connectionsApi: 'connections',
  userLookups: { byTelegramId: false, byEmail: false },
}

const ALL_UNKNOWN = {
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
}

describe('normalizeCapabilities', () => {
  it('passes a well-formed 2.7.4 payload through unchanged', () => {
    expect(normalizeCapabilities(PANEL_274)).toEqual(PANEL_274)
  })

  it('passes a well-formed 3.2.1 payload through unchanged', () => {
    expect(normalizeCapabilities(PANEL_321)).toEqual(PANEL_321)
  })

  it('keeps 3.2.1 supported — the SPA must not re-derive the tested set', () => {
    // `supported` is the backend's answer (`TESTED_VERSIONS`), mirrored, not
    // recomputed. A guard that only knew about 2.x would flip this to false
    // and put an untested-version banner over a panel that is tested.
    expect(normalizeCapabilities(PANEL_321).supported).toBe(true)
  })

  it("keeps the backend's 'unknown' instead of defaulting it to a real value", () => {
    const detectionFailed = { ...PANEL_274, userAddressing: 'unknown', connectionsApi: 'unknown' }
    const caps = normalizeCapabilities(detectionFailed)
    expect(caps.userAddressing).toBe('unknown')
    expect(caps.connectionsApi).toBe('unknown')
  })

  it('degrades a union value it has never heard of to unknown', () => {
    const drifted = { ...PANEL_274, userAddressing: 'shortUuid', connectionsApi: 'sessions' }
    const caps = normalizeCapabilities(drifted)
    expect(caps.userAddressing).toBe('unknown')
    expect(caps.connectionsApi).toBe('unknown')
  })

  it('does not treat a non-boolean as an enabled capability', () => {
    // A bare cast would let the truthy string light up the Live tab against a
    // panel that has no ip-control endpoints.
    const caps = normalizeCapabilities({ ...PANEL_274, liveIpControl: 'false', supported: 1 })
    expect(caps.liveIpControl).toBe(false)
    expect(caps.supported).toBe(false)
  })

  it('survives a missing userLookups object', () => {
    const { userLookups: _dropped, ...withoutLookups } = PANEL_274
    expect(normalizeCapabilities(withoutLookups).userLookups).toEqual({
      byTelegramId: false,
      byEmail: false,
    })
  })

  it('degrades a non-object payload to the all-unknown shape', () => {
    expect(normalizeCapabilities(null)).toEqual(ALL_UNKNOWN)
    expect(normalizeCapabilities(undefined)).toEqual(ALL_UNKNOWN)
    expect(normalizeCapabilities('<html>gateway error</html>')).toEqual(ALL_UNKNOWN)
  })
})

describe('remnawaveApi.getCapabilities', () => {
  beforeEach(() => {
    mockedGet.mockReset()
  })

  it('normalizes at the fetch site rather than casting the response', async () => {
    mockedGet.mockResolvedValue({
      data: { ...PANEL_274, userAddressing: 'something-new', liveIpControl: 'yes' },
    })

    const caps = await remnawaveApi.getCapabilities()

    expect(mockedGet).toHaveBeenCalledWith('/admin/remnawave/version')
    expect(caps.userAddressing).toBe('unknown')
    expect(caps.liveIpControl).toBe(false)
  })
})
