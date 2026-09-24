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
 * panel is this guard. The unions are the sharp edge: the backend really does
 * send `'unknown'` (for an unreadable version AND for a 2.x panel), and a value
 * the SPA has never heard of — including the retired 2.x values — must degrade
 * to "we do not know" rather than being waved through by a cast.
 */

/**
 * What the backend sends for a 2.x panel now: read, refused. `tooOld` is the
 * only flag that says so; every capability is off and both unions are
 * `'unknown'`, because this build builds no request for such a panel.
 */
const PANEL_274 = {
  version: '2.7.4',
  major: 2,
  minor: 7,
  patch: 4,
  supported: false,
  tooOld: true,
  reachable: true,
  liveIpControl: false,
  bandwidthNodesUsers: false,
  userAddressing: 'unknown',
  connectionsApi: 'unknown',
  userLookups: { byTelegramId: false, byEmail: false },
}

/**
 * A tested 3.x. Every union value and flag differs from the 2.7.4 payload
 * above, so a normalizer that quietly substituted defaults would pass one of
 * the two cases and fail the other.
 */
const PANEL_321 = {
  version: '3.2.1',
  major: 3,
  minor: 2,
  patch: 1,
  supported: true,
  tooOld: false,
  reachable: true,
  // ON, and this fixture has to say so: the backend computes
  // `liveIpControl: major === 3`, so 3.2.1 is true and no payload the service
  // can emit carries `false` here. It names `/api/connections/*` — which is
  // what `connectionsApi` below names and what the adapter reads. A fixture
  // asserting the opposite pins a shape the producer cannot produce.
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
  tooOld: false,
  reachable: false,
  liveIpControl: false,
  bandwidthNodesUsers: false,
  userAddressing: 'unknown',
  connectionsApi: 'unknown',
  userLookups: { byTelegramId: false, byEmail: false },
}

describe('normalizeCapabilities', () => {
  it('passes a well-formed 2.7.4 payload through unchanged — tooOld included', () => {
    expect(normalizeCapabilities(PANEL_274)).toEqual(PANEL_274)
    expect(normalizeCapabilities(PANEL_274).tooOld).toBe(true)
  })

  it('passes a well-formed 3.2.1 payload through unchanged', () => {
    expect(normalizeCapabilities(PANEL_321)).toEqual(PANEL_321)
  })

  it('keeps 3.2.1 supported — the SPA must not re-derive the tested set', () => {
    // `supported` is the backend's answer (`TESTED_VERSIONS`), mirrored, not
    // recomputed. A guard that re-derived it would put an untested-version
    // banner over a panel that is tested.
    expect(normalizeCapabilities(PANEL_321).supported).toBe(true)
  })

  it('does not derive tooOld from the major — the backend decides, the SPA mirrors', () => {
    // A payload without the flag is an older backend or a drift; the safe
    // reading is "not refused", the same answer the server gives an
    // unreadable version. Deriving it from `major` here would be a second
    // copy of the refusal rule.
    const { tooOld: _dropped, ...withoutFlag } = PANEL_274
    expect(normalizeCapabilities(withoutFlag).tooOld).toBe(false)
    expect(normalizeCapabilities({ ...PANEL_274, tooOld: 'true' }).tooOld).toBe(false)
  })

  it("keeps the backend's 'unknown' instead of defaulting it to a real value", () => {
    const caps = normalizeCapabilities(PANEL_274)
    expect(caps.userAddressing).toBe('unknown')
    expect(caps.connectionsApi).toBe('unknown')
  })

  it('degrades the retired 2.x union values to unknown', () => {
    // `'uuid'` and `'ip-control'` were the 2.x answers. No backend of this
    // build sends them; a payload that does is from somewhere else, and must
    // not be read as a known shape.
    const retired = { ...PANEL_321, userAddressing: 'uuid', connectionsApi: 'ip-control' }
    const caps = normalizeCapabilities(retired)
    expect(caps.userAddressing).toBe('unknown')
    expect(caps.connectionsApi).toBe('unknown')
  })

  it('degrades a union value it has never heard of to unknown', () => {
    const drifted = { ...PANEL_321, userAddressing: 'shortUuid', connectionsApi: 'sessions' }
    const caps = normalizeCapabilities(drifted)
    expect(caps.userAddressing).toBe('unknown')
    expect(caps.connectionsApi).toBe('unknown')
  })

  it('does not treat a non-boolean as an enabled capability', () => {
    // A bare cast would let the truthy string light up the Live tab against a
    // panel whose live-connections family we cannot name.
    const caps = normalizeCapabilities({ ...PANEL_274, liveIpControl: 'false', supported: 1 })
    expect(caps.liveIpControl).toBe(false)
    expect(caps.supported).toBe(false)
  })

  it('survives a missing userLookups object', () => {
    const { userLookups: _dropped, ...withoutLookups } = PANEL_321
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
      data: { ...PANEL_321, userAddressing: 'something-new', liveIpControl: 'yes' },
    })

    const caps = await remnawaveApi.getCapabilities()

    expect(mockedGet).toHaveBeenCalledWith('/admin/remnawave/version')
    expect(caps.userAddressing).toBe('unknown')
    expect(caps.liveIpControl).toBe(false)
  })
})
