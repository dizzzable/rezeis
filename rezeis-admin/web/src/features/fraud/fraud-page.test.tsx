import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import FraudSignalsPage from './fraud-page'
import {
  enforceDropConnections,
  getDetectorAccuracy,
  getFraudStats,
  getFraudTopOffenders,
  getFraudTrend,
  listFraudSignals,
  runFraudDetectors,
  transitionFraudSignal,
  type FraudSignal,
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
