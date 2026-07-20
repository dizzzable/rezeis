import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import AdvertisingPage from './advertising-page'
import {
  approveAdRequest,
  getAdOverview,
  listAdCampaigns,
  listAdRequests,
  placementSpendPayload,
  updateAdPlacement,
  type AdCampaign,
  type AdPlacement,
  type AdPlacementRequest,
} from './advertising-api'

vi.mock('./advertising-api', async () => {
  const actual = await vi.importActual<typeof import('./advertising-api')>('./advertising-api')
  return {
    ...actual,
    getAdOverview: vi.fn(),
    listAdCampaigns: vi.fn(),
    listAdRequests: vi.fn(),
    getPlacementMetrics: vi.fn(),
    getPlacementChartData: vi.fn(),
    createAdCampaign: vi.fn(),
    createAdPlacement: vi.fn(),
    updateAdPlacement: vi.fn(),
    archiveAdPlacement: vi.fn(),
    approveAdRequest: vi.fn(),
    rejectAdRequest: vi.fn(),
  }
})

const placement: AdPlacement = {
  id: 'p1',
  campaignId: 'c1',
  platform: 'YOUTUBE',
  channel: 'Tech Blogger',
  ownerType: 'COMPANY',
  partnerId: null,
  trackingCode: 'abc12345',
  payload: 'ad_abc12345',
  links: { botStart: 'https://t.me/Bot?start=ad_abc12345', miniAppStart: null, miniAppWeb: null },
  attributionWindowDays: 30,
  promoCodeId: null,
  spendAmountMinor: 300000,
  spendCurrency: 'RUB',
  signupBonusType: 'NONE',
  status: 'ACTIVE',
  createdAt: '2026-06-30T00:00:00.000Z',
  updatedAt: '2026-06-30T00:00:00.000Z',
}

const campaign: AdCampaign = {
  id: 'c1',
  name: 'October launch',
  status: 'ACTIVE',
  notes: null,
  createdBy: null,
  createdAt: '2026-06-30T00:00:00.000Z',
  updatedAt: '2026-06-30T00:00:00.000Z',
  placements: [placement],
}

describe('AdvertisingPage', () => {
  beforeEach(() => {
    vi.mocked(getAdOverview).mockResolvedValue({
      campaigns: 1,
      activePlacements: 1,
      opens: 42,
      registrations: 10,
      conversions: 3,
      revenueMinor: 900000,
    })
    vi.mocked(listAdCampaigns).mockResolvedValue([campaign])
    vi.mocked(listAdRequests).mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders the campaign and its placement tile (payload + channel)', async () => {
    renderWithProviders(<AdvertisingPage />)
    await waitFor(() => {
      expect(screen.getByText('October launch')).toBeInTheDocument()
    })
    expect(screen.getByText('ad_abc12345')).toBeInTheDocument()
    expect(screen.getByText('Tech Blogger')).toBeInTheDocument()
    // Overview opens tile value.
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('shows COMPANY spend on the placement tile', async () => {
    renderWithProviders(<AdvertisingPage />)
    await waitFor(() => {
      expect(screen.getByTestId('placement-spend')).toBeInTheDocument()
    })
    expect(screen.getByTestId('placement-spend').textContent).toMatch(/3[\s,]?000/)
  })

  it('pauses an ACTIVE placement via updateAdPlacement', async () => {
    vi.mocked(updateAdPlacement).mockResolvedValue({ ...placement, status: 'PAUSED' })
    renderWithProviders(<AdvertisingPage />)
    await waitFor(() => {
      expect(screen.getByTestId('placement-toggle-status')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('placement-toggle-status'))
    await waitFor(() => {
      expect(updateAdPlacement).toHaveBeenCalledWith('p1', { status: 'PAUSED' })
    })
  })

  it('activates a PAUSED placement via updateAdPlacement', async () => {
    vi.mocked(listAdCampaigns).mockResolvedValue([
      { ...campaign, placements: [{ ...placement, status: 'PAUSED' }] },
    ])
    vi.mocked(updateAdPlacement).mockResolvedValue({ ...placement, status: 'ACTIVE' })
    renderWithProviders(<AdvertisingPage />)
    await waitFor(() => {
      expect(screen.getByTestId('placement-toggle-status')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('placement-toggle-status'))
    await waitFor(() => {
      expect(updateAdPlacement).toHaveBeenCalledWith('p1', { status: 'ACTIVE' })
    })
  })

  it('placementSpendPayload strips PARTNER spend for create/edit helpers', () => {
    expect(placementSpendPayload('PARTNER', '500', 'RUB')).toEqual({})
    expect(placementSpendPayload('COMPANY', '500', 'RUB').spendAmountMinor).toBe(50000)
  })

  it('shows requests panel and history filter with counter terms', async () => {
    const pending: AdPlacementRequest = {
      id: 'req-pending',
      partnerId: 'partner-aaaaaaaa',
      platforms: ['TELEGRAM'],
      channel: 'Promo channel',
      notes: 'want 90d',
      proposedWindowDays: 90,
      approvedWindowDays: null,
      selfFundedBudgetNote: null,
      status: 'PENDING',
      reviewedBy: null,
      reviewedAt: null,
      campaignId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    }
    const countered: AdPlacementRequest = {
      ...pending,
      id: 'req-countered',
      channel: 'Countered channel',
      status: 'COUNTERED',
      proposedWindowDays: 90,
      approvedWindowDays: 30,
      reviewedBy: 'admin1',
      reviewedAt: '2026-07-02T00:00:00.000Z',
    }
    vi.mocked(listAdRequests).mockImplementation(async (status?: string) => {
      if (status === 'PENDING') return [pending]
      return [pending, countered]
    })

    renderWithProviders(<AdvertisingPage />)
    await waitFor(() => {
      expect(screen.getByTestId('request-row-req-pending')).toBeInTheDocument()
    })
    expect(screen.getByTestId('request-approve-window')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('requests-filter-history'))
    await waitFor(() => {
      expect(screen.getByTestId('request-row-req-countered')).toBeInTheDocument()
    })
    expect(screen.getByTestId('request-terms-counter')).toBeInTheDocument()
    expect(screen.queryByTestId('request-row-req-pending')).not.toBeInTheDocument()
  })

  it('approves as-is when window matches proposed', async () => {
    const pending: AdPlacementRequest = {
      id: 'req-approve',
      partnerId: 'partner-bbbbbbbb',
      platforms: ['TELEGRAM'],
      channel: 'As-is channel',
      notes: null,
      proposedWindowDays: 30,
      approvedWindowDays: null,
      selfFundedBudgetNote: null,
      status: 'PENDING',
      reviewedBy: null,
      reviewedAt: null,
      campaignId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(listAdRequests).mockResolvedValue([pending])
    vi.mocked(approveAdRequest).mockResolvedValue({
      request: { ...pending, status: 'ACTIVE', approvedWindowDays: 30 },
      campaign: null,
    })

    renderWithProviders(<AdvertisingPage />)
    await waitFor(() => {
      expect(screen.getByTestId('request-row-req-approve')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('request-approve'))
    await waitFor(() => {
      expect(approveAdRequest).toHaveBeenCalledWith('req-approve', 30)
    })
  })

  it('counters when moderator changes the integer window', async () => {
    const pending: AdPlacementRequest = {
      id: 'req-counter',
      partnerId: 'partner-cccccccc',
      platforms: ['YOUTUBE'],
      channel: 'Counter channel',
      notes: null,
      proposedWindowDays: 90,
      approvedWindowDays: null,
      selfFundedBudgetNote: null,
      status: 'PENDING',
      reviewedBy: null,
      reviewedAt: null,
      campaignId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    }
    vi.mocked(listAdRequests).mockResolvedValue([pending])
    vi.mocked(approveAdRequest).mockResolvedValue({
      request: { ...pending, status: 'COUNTERED', approvedWindowDays: 30 },
      campaign: null,
    })

    renderWithProviders(<AdvertisingPage />)
    await waitFor(() => {
      expect(screen.getByTestId('request-approve-window')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId('request-approve-window'), { target: { value: '30' } })
    fireEvent.click(screen.getByTestId('request-approve'))
    await waitFor(() => {
      expect(approveAdRequest).toHaveBeenCalledWith('req-counter', 30)
    })
  })
})
