import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import FraudSignalsPage from './fraud-page'
import {
  FRAUD_DETECTOR_CODES,
  enforceDropConnections,
  getDetectorAccuracy,
  getFraudStats,
  getFraudTopOffenders,
  getFraudTrend,
  listFraudSignals,
  runFraudDetectors,
  transitionFraudSignal,
  type FraudSignal,
  type ListFraudSignalsParams,
} from './fraud-api'

vi.mock('./fraud-api', () => ({
  listFraudSignals: vi.fn(),
  getFraudStats: vi.fn(),
  getFraudTrend: vi.fn(),
  getFraudTopOffenders: vi.fn(),
  enforceDropConnections: vi.fn(),
  transitionFraudSignal: vi.fn(),
  runFraudDetectors: vi.fn(),
  // The suppression panel the page now renders. Mocked here as well because the
  // factory REPLACES the module: a missing export is `undefined` at call time,
  // not a compile error, which is how a page-level mock silently breaks a child.
  getPendingFraudCandidates: vi.fn(),
  listFraudExemptions: vi.fn(),
  createFraudExemption: vi.fn(),
  revokeFraudExemption: vi.fn(),
  // Same reason as the exemption calls above: the factory REPLACES the module,
  // so a page-level child calling an export this list forgets gets `undefined`
  // at runtime rather than a compile error.
  getDetectorAccuracy: vi.fn(),
  FRAUD_DETECTOR_CODES: ['SUBSCRIPTION_SHARING_HWID', 'PROMO_ABUSE'],
}))

const sharingSignal: FraudSignal = {
  id: 'sig-1',
  code: 'SUBSCRIPTION_SHARING_IP',
  severity: 'HIGH',
  status: 'OPEN',
  title: 'Subscription sharing — concurrent IPs',
  description: 'User connected from 4 distinct IPs but the plan allows 2 devices.',
  score: 80,
  confidence: 75,
  affectedUserIds: ['user-1'],
  metadata: {
    kind: 'ip_sharing',
    distinctIpCount: 4,
    deviceLimit: 2,
    windowMinutes: 10,
    remnawaveUuid: 'uuid-1',
    ips: [{ ip: '1.1.1.1', countryCode: 'DE', lastSeen: '2026-06-18T12:00:00.000Z' }],
  },
  lastAction: 'notify',
  detectedAt: '2026-06-18T12:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  createdAt: '2026-06-18T12:00:00.000Z',
  updatedAt: '2026-06-18T12:00:00.000Z',
}

describe('FraudSignalsPage — enforcement', () => {
  beforeEach(() => {
    vi.mocked(listFraudSignals).mockResolvedValue({ items: [sharingSignal], nextCursor: null })
    vi.mocked(getFraudStats).mockResolvedValue({
      open: 1,
      acknowledged: 0,
      resolved: 0,
      dismissed: 0,
      bySeverity: { LOW: 0, MEDIUM: 0, HIGH: 1 },
    })
    vi.mocked(getFraudTrend).mockResolvedValue([])
    vi.mocked(getFraudTopOffenders).mockResolvedValue([])
    vi.mocked(runFraudDetectors).mockResolvedValue({ ok: true, processed: 0 })
    vi.mocked(transitionFraudSignal).mockResolvedValue(sharingSignal)
    vi.mocked(enforceDropConnections).mockResolvedValue({ ok: true, dropped: { by: 'user', count: 1 } })
    vi.mocked(getDetectorAccuracy).mockResolvedValue({
      windowDays: 30,
      since: '2026-05-19T12:00:00.000Z',
      until: '2026-06-18T12:00:00.000Z',
      minAdjudicatedForRate: 10,
      rows: [],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('opens a confirm dialog and drops connections for a sharing signal', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FraudSignalsPage />)

    // The sharing signal row renders with an enforcement button.
    const dropButton = await screen.findByRole('button', { name: 'Drop connections' })
    await user.click(dropButton)

    // Confirm in the dialog (exact accessible name, distinct from the row button).
    const confirmButton = await screen.findByRole('button', { name: 'Drop' })
    await user.click(confirmButton)

    await waitFor(() => {
      expect(enforceDropConnections).toHaveBeenCalledWith('sig-1', { mode: 'user' })
    })
  })
})

// ── Detector-code filter ───────────────────────────────────────────────────

/**
 * A row carrying a code that was retired from the detector plan and moved to
 * operational alerts. Nothing raises it any more and nothing auto-resolves it,
 * so it sits OPEN in the queue — and it is only reachable through the filter if
 * the filter offers codes the *current* plan does not contain.
 */
const retiredSignal: FraudSignal = {
  ...sharingSignal,
  id: 'sig-2',
  code: 'NODE_TRAFFIC_CRITICAL',
  title: 'Node traffic critical — legacy row',
  description: 'Raised before the code moved to operational alerts.',
  metadata: {},
}

/** A code in neither list — the free-text escape hatch. */
const strayCodeSignal: FraudSignal = {
  ...sharingSignal,
  id: 'sig-3',
  code: 'ANCIENT_HEURISTIC',
  title: 'Ancient heuristic — legacy row',
  description: 'A code from a release older than either list.',
  metadata: {},
}

const ALL_SIGNALS = [sharingSignal, retiredSignal, strayCodeSignal]

/** The `params` object the page handed to the API on its most recent request. */
function lastListParams(): ListFraudSignalsParams | undefined {
  return vi.mocked(listFraudSignals).mock.calls.at(-1)?.[0]
}

describe('FraudSignalsPage — detector code filter', () => {
  // Same shim, and same reason, as `detector-accuracy.test.tsx`: Radix's Select
  // drives itself with Pointer Events APIs jsdom does not implement, so opening
  // one throws before any assertion runs.
  beforeAll(() => {
    const proto = window.Element.prototype as unknown as Record<string, unknown>
    proto.hasPointerCapture ??= (): boolean => false
    proto.setPointerCapture ??= (): void => {}
    proto.releasePointerCapture ??= (): void => {}
    proto.scrollIntoView ??= (): void => {}
  })

  beforeEach(() => {
    // The list is served FROM the outgoing `code` param. That coupling is the
    // point: a page that renders a code picker but never puts `code` on the
    // request would still show all three rows here, and every assertion below
    // about what is on screen would fail. The filter cannot pass vacuously.
    vi.mocked(listFraudSignals).mockImplementation(
      async (params: ListFraudSignalsParams = {}) => ({
        items: params.code ? ALL_SIGNALS.filter((s) => s.code === params.code) : ALL_SIGNALS,
        nextCursor: null,
      }),
    )
    vi.mocked(getFraudStats).mockResolvedValue({
      open: 3,
      acknowledged: 0,
      resolved: 0,
      dismissed: 0,
      bySeverity: { LOW: 0, MEDIUM: 0, HIGH: 3 },
    })
    vi.mocked(getFraudTrend).mockResolvedValue([])
    vi.mocked(getFraudTopOffenders).mockResolvedValue([])
    vi.mocked(runFraudDetectors).mockResolvedValue({ ok: true, processed: 0 })
    vi.mocked(getDetectorAccuracy).mockResolvedValue({
      windowDays: 30,
      since: '2026-05-19T12:00:00.000Z',
      until: '2026-06-18T12:00:00.000Z',
      minAdjudicatedForRate: 10,
      rows: [],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  async function openCodeFilter(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole('combobox', { name: 'Detector code' }))
  }

  it('sends no code param until one is picked', async () => {
    renderWithProviders(<FraudSignalsPage />)

    await screen.findByText('Subscription sharing — concurrent IPs')
    // The unfiltered request must stay byte-identical to what it was before
    // this filter existed — no empty `code`, no `code: undefined`.
    expect(lastListParams()).toEqual({ limit: 50 })
    expect(screen.getByText('Node traffic critical — legacy row')).toBeInTheDocument()
  })

  it('filters by a live detector code', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FraudSignalsPage />)

    await screen.findByText('Subscription sharing — concurrent IPs')

    await openCodeFilter(user)
    await user.click(await screen.findByRole('option', { name: 'SUBSCRIPTION_SHARING_HWID' }))

    await waitFor(() => {
      expect(lastListParams()).toEqual({ limit: 50, code: 'SUBSCRIPTION_SHARING_HWID' })
    })
  })

  // The case the filter exists for. `NODE_TRAFFIC_CRITICAL` was retired from
  // the detector plan, so it is absent from `FRAUD_DETECTOR_CODES` — an option
  // list built only from that constant could never reach this row.
  it('reaches a retired code that the live detector list does not contain', async () => {
    // Self-check: if this code ever rejoins the live plan, the test below stops
    // proving anything about retired codes and must be pointed at another one.
    expect(FRAUD_DETECTOR_CODES).not.toContain('NODE_TRAFFIC_CRITICAL')

    const user = userEvent.setup()
    renderWithProviders(<FraudSignalsPage />)

    await screen.findByText('Node traffic critical — legacy row')
    expect(lastListParams()).toEqual({ limit: 50 })

    await openCodeFilter(user)
    await user.click(await screen.findByRole('option', { name: 'NODE_TRAFFIC_CRITICAL' }))

    await waitFor(() => {
      expect(lastListParams()).toEqual({ limit: 50, code: 'NODE_TRAFFIC_CRITICAL' })
    })
    // And the queue narrowed to exactly that backlog — the rows the release
    // notes tell the operator to select and dismiss.
    await waitFor(() => {
      expect(screen.queryByText('Subscription sharing — concurrent IPs')).toBeNull()
    })
    expect(screen.getByText('Node traffic critical — legacy row')).toBeInTheDocument()
  })

  // Retired codes are offered, but the plan has changed before and will again,
  // so any code at all must be reachable.
  it('accepts a code that is in neither list', async () => {
    expect(FRAUD_DETECTOR_CODES).not.toContain('ANCIENT_HEURISTIC')

    const user = userEvent.setup()
    renderWithProviders(<FraudSignalsPage />)

    await screen.findByText('Subscription sharing — concurrent IPs')

    await openCodeFilter(user)
    await user.click(await screen.findByRole('option', { name: 'Other code…' }))

    // Picking "Other code…" is not itself a filter — the view is untouched
    // until an actual code is submitted.
    expect(lastListParams()).toEqual({ limit: 50 })

    await user.type(await screen.findByLabelText('Enter a detector code'), 'ancient_heuristic')
    await user.click(screen.getByRole('button', { name: 'Apply code' }))

    await waitFor(() => {
      // Upper-cased on the way out: the backend matches `code` exactly.
      expect(lastListParams()).toEqual({ limit: 50, code: 'ANCIENT_HEURISTIC' })
    })
    expect(await screen.findByText('Ancient heuristic — legacy row')).toBeInTheDocument()
    expect(screen.queryByText('Node traffic critical — legacy row')).toBeNull()
  })

  it('drops the code param again when the filters are cleared', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FraudSignalsPage />)

    await screen.findByText('Subscription sharing — concurrent IPs')

    await openCodeFilter(user)
    await user.click(await screen.findByRole('option', { name: 'NODE_TRAFFIC_CRITICAL' }))
    await waitFor(() => {
      expect(lastListParams()).toEqual({ limit: 50, code: 'NODE_TRAFFIC_CRITICAL' })
    })

    await user.click(await screen.findByRole('button', { name: 'Clear' }))

    await waitFor(() => {
      // No `code` key at all, not `code: ''` — the same request the page made
      // on first load.
      expect(lastListParams()).toEqual({ limit: 50 })
    })
    expect(await screen.findByText('Subscription sharing — concurrent IPs')).toBeInTheDocument()
    expect(screen.getByText('Node traffic critical — legacy row')).toBeInTheDocument()
  })
})
