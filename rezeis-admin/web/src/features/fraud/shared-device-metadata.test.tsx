import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
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

/**
 * The cross-account device signal, on the page
 * ════════════════════════════════════════════
 *
 * This signal names a RELATION rather than a person, and the signals table shows
 * only how MANY accounts a row affects. Without a renderer of its own the answer
 * to "which accounts?" lives in a nested array inside a JSON dump — present, and
 * not readable at the speed an operator triages a queue at.
 *
 * The second assertion here is the one that would break quietly. The page's
 * `isSharing` flag drives both the sharing metadata renderer AND the "drop
 * connections" button, and that button enforces against `metadata.ips`. Folding
 * this code into that flag — the obvious way to get the nicer rendering — would
 * offer an enforcement action with nothing to enforce against.
 */

vi.mock('./fraud-api', () => ({
  listFraudSignals: vi.fn(),
  getFraudStats: vi.fn(),
  getFraudTrend: vi.fn(),
  getFraudTopOffenders: vi.fn(),
  enforceDropConnections: vi.fn(),
  transitionFraudSignal: vi.fn(),
  runFraudDetectors: vi.fn(),
  getPendingFraudCandidates: vi.fn(),
  listFraudExemptions: vi.fn(),
  createFraudExemption: vi.fn(),
  revokeFraudExemption: vi.fn(),
  getDetectorAccuracy: vi.fn(),
  FRAUD_DETECTOR_CODES: ['SHARED_DEVICE_MULTI_ACCOUNT'],
}))

const sharedDeviceSignal: FraudSignal = {
  id: 'sig-shared-1',
  code: 'SHARED_DEVICE_MULTI_ACCOUNT',
  severity: 'MEDIUM',
  status: 'OPEN',
  title: 'Shared device — one HWID across several accounts',
  description:
    "Device 6f2a91c0b7d4 is registered on 2 different customers' profiles (alice, bob).",
  score: 50,
  confidence: 62,
  affectedUserIds: ['user-1', 'user-2'],
  metadata: {
    kind: 'shared_hwid',
    hwid: '6f2a91c0b7d4e83a',
    accountCount: 2,
    panelProfileCount: 2,
    deviceRowCount: 2,
    descriptorAgreement: 1,
    profiles: [
      { panelUserId: 41, username: 'alice', remnawaveId: '41', userId: 'user-1' },
      { panelUserId: 87, username: 'bob', remnawaveId: '87', userId: 'user-2' },
    ],
  },
  lastAction: 'none',
  detectedAt: '2026-08-28T12:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  createdAt: '2026-08-28T12:00:00.000Z',
  updatedAt: '2026-08-28T12:00:00.000Z',
}

function mockPage(signal: FraudSignal): void {
  vi.mocked(listFraudSignals).mockResolvedValue({ items: [signal], nextCursor: null })
  vi.mocked(getFraudStats).mockResolvedValue({
    open: 1,
    acknowledged: 0,
    resolved: 0,
    dismissed: 0,
    bySeverity: { LOW: 0, MEDIUM: 1, HIGH: 0 },
  })
  vi.mocked(getFraudTrend).mockResolvedValue([])
  vi.mocked(getFraudTopOffenders).mockResolvedValue([])
  vi.mocked(runFraudDetectors).mockResolvedValue({ ok: true, processed: 0 })
  vi.mocked(transitionFraudSignal).mockResolvedValue(signal)
  vi.mocked(enforceDropConnections).mockResolvedValue({
    ok: true,
    dropped: { by: 'user', count: 0 },
  })
  vi.mocked(getDetectorAccuracy).mockResolvedValue({
    windowDays: 30,
    since: '2026-07-29T12:00:00.000Z',
    until: '2026-08-28T12:00:00.000Z',
    minAdjudicatedForRate: 10,
    rows: [],
  })
}

/** Expands the row so its metadata is mounted. */
async function expandRow(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const trigger = await screen.findByRole('button', {
    name: /Shared device — one HWID across several accounts/,
  })
  await user.click(trigger)
}

describe('a cross-account device signal on the fraud page', () => {
  beforeEach(() => {
    mockPage(sharedDeviceSignal)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('names every account the device is registered on, and the device itself', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FraudSignalsPage />)
    await expandRow(user)

    // Both owners, by the name an operator sees in Remnawave...
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    // ...and by the id the exemption form takes, for the household case.
    expect(screen.getByText('user-1')).toBeInTheDocument()
    expect(screen.getByText('user-2')).toBeInTheDocument()
    expect(screen.getByText('6f2a91c0b7d4e83a')).toBeInTheDocument()
  })

  it('offers no "drop connections" button, because the signal carries no IPs', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FraudSignalsPage />)
    await expandRow(user)

    expect(screen.queryByRole('button', { name: 'Drop connections' })).toBeNull()
  })

  it('says nothing about the descriptors while the rows agree', async () => {
    // Agreement is the ordinary case; a badge for it would be noise on every row.
    const user = userEvent.setup()
    renderWithProviders(<FraudSignalsPage />)
    await expandRow(user)

    expect(screen.queryByText('Rows describe different devices')).toBeNull()
  })

  it('flags disagreeing descriptors, which is the mitigating fact on this signal', async () => {
    // One identifier reported by devices that are demonstrably not the same
    // device means the hwid may not be tracking a machine at all — the operator
    // has to see that without opening the raw metadata.
    cleanup()
    mockPage({
      ...sharedDeviceSignal,
      metadata: { ...sharedDeviceSignal.metadata, descriptorAgreement: 0.5 },
    })
    const user = userEvent.setup()
    renderWithProviders(<FraudSignalsPage />)
    await expandRow(user)

    expect(await screen.findByText('Rows describe different devices')).toBeInTheDocument()
  })
})
