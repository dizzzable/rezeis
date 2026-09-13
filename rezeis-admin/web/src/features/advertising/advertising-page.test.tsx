import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

import { en as advertisingEn } from '@/i18n/features/advertising.en'
import { i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { QUIET_ZONE_MODULES } from '@/lib/qr/kit/qr-options'
import { QR_STYLE_PLAIN, drawQr, qrSvg } from '@/lib/qr/kit/qr-style'
import { renderWithProviders } from '@/test/test-utils'
import AdvertisingPage, { PLACEMENT_QR_PX } from './advertising-page'
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

// No `qrcode` mock. The placement codes are drawn by the shared kit, and the
// mock this file used to carry stubbed only `toDataURL` — under the kit it
// would make every code fail to draw and leave an empty placeholder, which
// every case below would have passed on without noticing.

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
      // Both became required: the cabinet reports one currency now, and says how
      // many conversions had no rate instead of folding them in as zero.
      currency: 'RUB',
      unconvertedConversions: 0,
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

  describe('placement QR codes', () => {
    /**
     * Operators screenshot these codes into company advertisements, so what
     * this page draws is what gets printed. It used to be its own bitmap —
     * `qrcode`'s `toDataURL` with a ONE-module quiet zone, where ISO/IEC 18004
     * asks for four. These hold it to the shared kit's plain code instead:
     * byte for byte, measured rather than trusted, and at the page's size.
     */
    const BOT = 'https://t.me/ExampleVpnBot?start=ad_abc12345'
    const WEB = 'https://cabinet.example.com/?campaign=ad_abc12345'
    const labels = advertisingEn.advertisingPage.links

    const decode = (image: HTMLElement): string => {
      const src = image.getAttribute('src') ?? ''
      const prefix = 'data:image/svg+xml;charset=utf-8,'
      expect(src.startsWith(prefix), `not an SVG data URL: ${src.slice(0, 40)}…`).toBe(true)
      return decodeURIComponent(src.slice(prefix.length))
    }

    async function renderCodes(): Promise<{ bot: HTMLElement; web: HTMLElement }> {
      vi.mocked(listAdCampaigns).mockResolvedValue([
        {
          ...campaign,
          placements: [{ ...placement, links: { botStart: BOT, miniAppStart: null, miniAppWeb: WEB } }],
        },
      ])
      // The labels are the codes' accessible names; they live in the lazy
      // feature bundle, which the router loads and a bare render does not.
      await i18nReady
      await loadFeatureBundle('advertising')
      expect(labels.qrBot).toMatch(/\S/)
      expect(labels.qrWeb).toMatch(/\S/)
      renderWithProviders(<AdvertisingPage />)
      return {
        bot: await screen.findByRole('img', { name: labels.qrBot }),
        web: await screen.findByRole('img', { name: labels.qrWeb }),
      }
    }

    it("draws each link as the kit's plain SVG, at the page's size", async () => {
      const { bot, web } = await renderCodes()
      expect(decode(bot)).toBe(await qrSvg(BOT, QR_STYLE_PLAIN, PLACEMENT_QR_PX))
      expect(decode(web)).toBe(await qrSvg(WEB, QR_STYLE_PLAIN, PLACEMENT_QR_PX))
      for (const image of [bot, web]) {
        expect(image).toHaveAttribute('width', String(PLACEMENT_QR_PX))
        expect(image).toHaveAttribute('height', String(PLACEMENT_QR_PX))
      }
    })

    it('leaves the quiet zone the standard asks for — four modules, measured off the drawn SVG', async () => {
      const { bot, web } = await renderCodes()
      for (const [link, image] of [
        [BOT, bot],
        [WEB, web],
      ] as const) {
        const side = /viewBox="0 0 (\d+) \1"/.exec(decode(image))?.[1]
        expect(side, 'the code no longer declares a square viewBox').toBeDefined()
        // The symbol's own width from its version (ISO/IEC 18004: 17 + 4v
        // modules); whatever the drawing adds around it is quiet zone.
        const modules = 17 + 4 * drawQr(link, QR_STYLE_PLAIN).version
        expect((Number(side) - modules) / 2, `quiet zone of ${link}`).toBe(4)
      }
      expect(QUIET_ZONE_MODULES).toBe(4)
    })

    it('never styles a company code — the markup is the plain writer, not the matrix renderer', async () => {
      const { bot } = await renderCodes()
      const svg = decode(bot)
      // `qrcode`'s writer paints one light path and one dark path; the styled
      // renderer paints rects and circles. A code with either was styled.
      expect(svg).toContain('shape-rendering="crispEdges"')
      expect(svg).not.toContain('<circle')
      expect(svg).not.toContain('<rect')
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
      reviewNotes: null,
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
      reviewNotes: null,
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
      reviewNotes: null,
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
