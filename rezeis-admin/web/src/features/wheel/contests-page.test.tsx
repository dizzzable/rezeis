import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import type { Contest } from './contests-api'
import ContestsPage from './contests-page'

/**
 * «Конкурсы» after the 29.10.2026 work: the form sends who may enter, the
 * channel, the tickets and the announcement, and English copy of its own; a
 * live contest can only have its end moved; cancelling asks first; a failed
 * draw says why; the participants are listed with their tickets. And after
 * 30.10: a leaderboard from a template, prize ranges, the live board, and
 * the prizes still waiting for the operator.
 */

const HOUR = 60 * 60 * 1000

function contest(overrides: Partial<Contest>): Contest {
  return {
    id: 'c1',
    title: { ru: 'Осенний розыгрыш', en: 'Autumn draw' },
    description: { ru: 'Правила', en: 'Rules' },
    status: 'ACTIVE',
    startAt: new Date(Date.now() - HOUR).toISOString(),
    endAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    audienceFilter: null,
    maxEntries: null,
    drawnAt: null,
    drawnEntries: null,
    drawnTickets: null,
    order: 0,
    createdAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    entries: 2,
    winners: 0,
    announce: true,
    announcedAt: null,
    resultsNotifiedAt: null,
    ticketsPerPurchase: 2,
    ticketsPerReferral: 0,
    maxTicketsPerUser: null,
    channel: null,
    drawSeedHash: 'a'.repeat(64),
    drawSeed: null,
    drawError: null,
    drawErrorAt: null,
    kind: 'DRAW',
    metric: null,
    minScore: null,
    leaderboardSize: 10,
    prizeDelivery: 'AUTO',
    repeatMonthly: false,
    repeatOfId: null,
    trafficReadAt: null,
    places: 1,
    currency: 'RUB',
    pendingPrizes: 0,
    prizes: [
      {
        id: 'p1',
        place: 1,
        placeTo: null,
        kind: 'POINTS',
        title: { ru: '100 баллов', en: '100 points' },
        amount: 100,
        promoRewardType: null,
        promoPlanId: null,
        promoPlanIds: [],
        promoLifetime: null,
        keyPoolId: null,
        manualInstructions: null,
      },
    ],
    problems: [],
    ...overrides,
  }
}

/** The form counts its audience over `post` as well; this finds the save among those calls. */
function created(post: { readonly mock: { readonly calls: readonly unknown[][] } }): Record<string, unknown> {
  const call = post.mock.calls.find((args) => args[0] === '/admin/contests')
  expect(call, 'the contest was saved').toBeDefined()
  return (call as [string, Record<string, unknown>])[1]
}

function serve(contests: Contest[]): void {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/admin/contests') return { data: contests }
    if (url.endsWith('/standings')) {
      return {
        data: {
          total: 2,
          rows: [
            { rank: 1, userId: 'u1', name: 'Иван', username: null, telegramId: '111', score: 12 * 1024 ** 3 },
            { rank: 2, userId: 'u2', name: null, username: 'neo', telegramId: null, score: 1024 ** 3 / 2 },
          ],
        },
      }
    }
    if (url.endsWith('/entrants')) {
      return {
        data: {
          total: 2,
          rows: [
            { userId: 'u1', name: 'Иван', username: null, telegramId: '111', enteredAt: new Date().toISOString(), tickets: 5 },
            { userId: 'u2', name: null, username: 'neo', telegramId: null, enteredAt: new Date().toISOString(), tickets: 1 },
          ],
        },
      }
    }
    return { data: [] }
  })
}

describe('ContestsPage', () => {
  beforeAll(async () => {
    await loadFeatureBundle('contests')
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends who may enter, the channel, the tickets, the announcement and English copy', async () => {
    serve([])
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: contest({ status: 'DRAFT' }) })
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'New contest' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Title (RU)'), 'Осенний')
    await user.type(within(dialog).getByLabelText('Description (EN)'), 'Rules in English')
    await user.click(within(dialog).getByRole('button', { name: 'Active' }))
    await user.type(within(dialog).getByLabelText('Channel link'), 'https://t.me/contest_news')
    const perPurchase = within(dialog).getByLabelText('For each payment')
    await user.clear(perPurchase)
    await user.type(perPurchase, '2')
    await user.type(within(dialog).getByLabelText('Prize title (EN)'), '100 points')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/contests', expect.anything()))
    const payload = created(post)
    expect(payload).toMatchObject({
      title: { ru: 'Осенний', en: 'Осенний' },
      description: { ru: '', en: 'Rules in English' },
      audienceFilter: { subscription: ['ACTIVE'] },
      channelLink: 'https://t.me/contest_news',
      channelId: null,
      ticketsPerPurchase: 2,
      ticketsPerReferral: 0,
      maxTicketsPerUser: null,
      announce: true,
      remind: true,
    })
    expect((payload.prizes as Array<{ title: unknown }>)[0]?.title).toEqual({ ru: '', en: '100 points' })
  })

  it('starts a monthly traffic leaderboard from its template, with a range of places and a threshold in gigabytes', async () => {
    serve([])
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: contest({ status: 'DRAFT' }) })
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'New contest' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Top traffic' }))
    expect(within(dialog).getByTestId('contest-leaderboard-fields')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Channel link'), 'a leaderboard has no entries to gate').not.toBeInTheDocument()
    expect(within(dialog).getByText('Places 4–10')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Minimum for a prize place, GB'), '5')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/contests', expect.anything()))
    const payload = created(post)
    expect(payload).toMatchObject({
      title: { ru: 'Who uses the most traffic' },
      kind: 'LEADERBOARD',
      metric: 'TRAFFIC',
      minScore: 5 * 1024 ** 3,
      leaderboardSize: 10,
      prizeDelivery: 'AUTO',
      repeatMonthly: true,
    })
    expect(
      (payload.prizes as Array<{ place: number; placeTo: number | null; amount: number }>).map((prize) => [
        prize.place,
        prize.placeTo,
        prize.amount,
      ]),
    ).toEqual([
      [1, null, 1000],
      [2, null, 500],
      [3, null, 300],
      [4, 10, 100],
    ])
  })

  it('shows a running leaderboard as it stands, the prize zone marked', async () => {
    serve([contest({ kind: 'LEADERBOARD', metric: 'TRAFFIC', drawSeedHash: null, places: 1 })])
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'Leaderboard' }))
    const board = await screen.findByTestId('contest-standings')
    expect(board).toHaveTextContent('#1')
    expect(board).toHaveTextContent('Иван')
    expect(board).toHaveTextContent('12 GB')
    expect(board).toHaveTextContent('@neo')
    expect(board).toHaveTextContent('0.5 GB')
    expect(within(board).getAllByLabelText('Prize zone')).toHaveLength(1)
  })

  it('says how many prizes are still waiting to be handed over', async () => {
    serve([contest({ status: 'DRAWN', winners: 3, pendingPrizes: 2, prizeDelivery: 'REVIEW' })])
    renderWithProviders(<ContestsPage />)

    expect(await screen.findByTestId('contest-pending-prizes')).toHaveTextContent('Waiting to be handed over: 2')
    expect(screen.getByText('Prizes after a check')).toBeInTheDocument()
  })

  it('says how many people the audience takes in, and asks again when it changes', async () => {
    serve([])
    const post = vi.spyOn(api, 'post').mockImplementation(async (url: string, body?: unknown) => {
      if (url !== '/admin/contests/audience/count') return { data: contest({ status: 'DRAFT' }) }
      const filter = (body as { audienceFilter: { subscription?: string[] } | null }).audienceFilter
      return { data: { count: filter?.subscription?.includes('ACTIVE') ? 1234 : 50000 } }
    })
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'New contest' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByTestId('contest-audience-count')).toHaveTextContent('50,000'))
    await user.click(within(dialog).getByRole('button', { name: 'Active' }))
    await waitFor(() => expect(within(dialog).getByTestId('contest-audience-count')).toHaveTextContent('1,234'))
    expect(post).toHaveBeenCalledWith('/admin/contests/audience/count', { audienceFilter: { subscription: ['ACTIVE'] } })
  })

  it('copies a contest into a new draft that starts now and runs as long', async () => {
    serve([
      contest({
        status: 'DRAWN',
        startAt: new Date(Date.now() - 10 * 24 * HOUR).toISOString(),
        endAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
        ticketsPerPurchase: 3,
        remind: true,
      }),
    ])
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: contest({ status: 'DRAFT' }) })
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'Copy' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('New contest')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/contests', expect.anything()))
    const payload = created(post)
    expect(payload).toMatchObject({ title: { ru: 'Осенний розыгрыш', en: 'Autumn draw' }, ticketsPerPurchase: 3, remind: true })
    const days = (new Date(payload.endAt as string).getTime() - new Date(payload.startAt as string).getTime()) / (24 * HOUR)
    expect(days).toBeCloseTo(7, 1)
    expect(new Date(payload.startAt as string).getTime()).toBeGreaterThan(Date.now() - 5 * 60 * 1000)
  })

  it('shows what is worth a second look before a prize is handed over', async () => {
    serve([contest({ status: 'DRAWN', winners: 1, pendingPrizes: 1, prizeDelivery: 'REVIEW' })])
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/admin/contests') {
        return { data: [contest({ status: 'DRAWN', winners: 1, pendingPrizes: 1, prizeDelivery: 'REVIEW' })] }
      }
      if (url.endsWith('/winners')) {
        return {
          data: [
            {
              id: 'w1',
              contestId: 'c1',
              contestTitle: { ru: 'Топ' },
              place: 1,
              kind: 'POINTS',
              prizeTitle: { ru: '100 баллов' },
              status: 'PENDING',
              createdAt: new Date().toISOString(),
              settledAt: null,
              settledBy: null,
              settlementNote: null,
              ticketId: null,
              instructions: '',
              heldForReview: true,
              score: 12,
              signals: { accountAgeDays: 3, reviewFlags: 0, friends: { counted: 12, sharedDevice: 9, sharedIp: 11, blocked: 0 } },
              winner: { id: 'u1', name: 'Иван', username: null, telegramId: '111', email: null },
            },
          ],
        }
      }
      return { data: [] }
    })
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'Winners (1)' }))
    const signals = await screen.findByTestId('contest-winner-signals')
    expect(signals).toHaveTextContent('account 3 d old')
    expect(signals).toHaveTextContent('friends counted: 12')
    expect(signals).toHaveTextContent('same device: 9')
    expect(signals).toHaveTextContent('same IP: 11')
    expect(signals).not.toHaveTextContent('blocked')
    expect(screen.getByText('Waiting for a check: “Hand over” credits the prize')).toBeInTheDocument()
  })

  it('lets a live contest have only its wording fixed and its end moved', async () => {
    serve([contest({})])
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: contest({}) })
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/The contest is running/)).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Channel link')).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText('End and draw — later only')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patch).toHaveBeenCalled())
    const [, payload] = patch.mock.calls[0] as [string, Record<string, unknown>]
    expect(typeof payload.endAt).toBe('string')
  })

  it('asks before cancelling a live contest', async () => {
    serve([contest({})])
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: contest({ status: 'CANCELLED' }) })
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Cancel the contest?')).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()

    await user.click(within(confirm).getByRole('button', { name: 'Cancel the contest' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/contests/c1/cancel'))
  })

  it('says why a draw keeps failing', async () => {
    serve([contest({ endAt: new Date(Date.now() - HOUR).toISOString(), drawError: 'Ключи кончились' })])
    renderWithProviders(<ContestsPage />)

    expect(await screen.findByTestId('contest-draw-error')).toHaveTextContent('The draw failed: Ключи кончились')
  })

  it('lists the participants with their tickets', async () => {
    serve([contest({})])
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'Entrants' }))
    const list = await screen.findByTestId('contest-entrants')
    expect(list).toHaveTextContent('Иван')
    expect(list).toHaveTextContent('5 tickets')
    expect(list).toHaveTextContent('@neo')
    expect(list).toHaveTextContent('1 ticket')
  })

  it('shows the draw key once the contest is drawn', async () => {
    serve([contest({ status: 'DRAWN', drawSeed: 'b'.repeat(64), drawnEntries: 2, drawnTickets: 6, winners: 1 })])
    const user = userEvent.setup()
    renderWithProviders(<ContestsPage />)

    await user.click(await screen.findByRole('button', { name: 'Winners (1)' }))
    expect(await screen.findByTestId('contest-draw-seed')).toHaveTextContent('b'.repeat(64))
    expect(screen.getByText('Tickets in the draw: 6')).toBeInTheDocument()
  })
})
