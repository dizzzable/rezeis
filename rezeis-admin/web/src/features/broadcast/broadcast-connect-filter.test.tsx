/**
 * «Подключение VPN» in «Рассылки» → «Новая рассылка» → «Точные фильтры»,
 * driven the way an operator drives it, asserting the REQUESTS that go out.
 *
 * The filter only means something on the server, so what matters here is the
 * body of the draft the preview counts and the draft that is sent: one bucket
 * or none, the days and the "already helped" switch as chosen — and, every
 * single time, the companion `subscription: ['ACTIVE','LIMITED']` and the
 * `ACTIVE_SUBSCRIBERS` preset. An older panel image drops `connect`; with the
 * companion it degrades to active subscribers, without it to EVERYONE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MockInstance } from 'vitest'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import BroadcastPage from './broadcast-page'
import {
  clampConnectDays,
  connectHealthSentence,
  parseConnectPrefill,
  withoutConnectPrefill,
  type BroadcastConnectHealth,
  type BroadcastConnectPreview,
} from './connect-audience'

const LIVE: BroadcastConnectHealth = {
  state: 'live',
  checkedCoverage: 1,
  lastOkAt: '2026-09-19T09:50:00.000Z',
  lastUserWebhookAt: null,
  failingSince: null,
  coverage: { total: 40, connected: 30, verified: 10, unverified: 0 },
  firstPassHours: 0,
}

function preview(connect: Partial<BroadcastConnectPreview>, totalRecipients: number | null = 12) {
  return {
    totalRecipients,
    connect: { verified: 12, unverified: 0, health: LIVE, refusal: null, limit: 20_000, ...connect },
  }
}

function mockGet(previewBody: unknown = preview({})): MockInstance {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/broadcast/drafts') return { data: [] }
    if (path === '/admin/plans') return { data: [] }
    if (path === '/admin/broadcast/broadcast-1/audience-preview') return { data: previewBody }
    return { data: {} }
  }) as unknown as MockInstance
}

function mockPost(): MockInstance {
  return vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    if (path === '/admin/broadcast/drafts') return { data: { id: 'broadcast-1' } }
    return { data: {} }
  }) as unknown as MockInstance
}

function bodyOf(spy: MockInstance, path: string): Record<string, unknown> {
  const call = (spy.mock.calls as unknown[][]).find((args) => args[0] === path)
  if (call === undefined) throw new Error(`no request was made to ${path}`)
  return (call[1] ?? {}) as Record<string, unknown>
}

async function openCompose(route = '/'): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await loadFeatureBundle('broadcast')
  renderWithProviders(<BroadcastPage />, { route })
  if (route === '/') await user.click(screen.getByRole('button', { name: 'New broadcast' }))
  return user
}

const PAID = 'Paid and not connected'
const TRIAL = 'Trial or gift — not connected'
const COMPANION = ['ACTIVE', 'LIMITED']

async function send(user: ReturnType<typeof userEvent.setup>, postSpy: MockInstance): Promise<void> {
  await user.type(screen.getByPlaceholderText(/Enter your message here/), 'Hello')
  await user.click(screen.getByRole('button', { name: 'Create and send' }))
  await waitFor(() => {
    expect(postSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1/send', {})
  })
}

describe('«Подключение VPN» — the two chips', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('are mutually exclusive, and either can be taken back', async () => {
    mockGet()
    const user = await openCompose()
    const paid = screen.getByRole('button', { name: PAID })
    const trial = screen.getByRole('button', { name: TRIAL })
    expect(paid).toHaveAttribute('aria-pressed', 'false')
    expect(trial).toHaveAttribute('aria-pressed', 'false')

    await user.click(paid)
    expect(paid).toHaveAttribute('aria-pressed', 'true')
    expect(trial).toHaveAttribute('aria-pressed', 'false')

    await user.click(trial)
    expect(paid).toHaveAttribute('aria-pressed', 'false')
    expect(trial).toHaveAttribute('aria-pressed', 'true')

    await user.click(trial)
    expect(trial).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByLabelText('Over the last, days')).not.toBeInTheDocument()
  })

  it('shows the days (7) and "skip the helped" (on) only once a bucket is chosen', async () => {
    mockGet()
    const user = await openCompose()
    await user.click(screen.getByRole('button', { name: TRIAL }))
    expect(screen.getByLabelText('Over the last, days')).toHaveValue(7)
    expect(screen.getByRole('checkbox', { name: 'Skip customers who were already helped' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'More: VPN connection' })).toBeInTheDocument()
  })
})

describe('«Подключение VPN» — what is sent', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends connect with the companion subscription and the ACTIVE_SUBSCRIBERS preset, whatever the operator had chosen', async () => {
    mockGet()
    const postSpy = mockPost()
    const user = await openCompose()
    // The operator's own subscription chip, chosen BEFORE the connect filter.
    await user.click(screen.getByRole('button', { name: 'Expired' }))
    await user.click(screen.getByRole('button', { name: PAID }))
    const days = screen.getByLabelText('Over the last, days')
    await user.clear(days)
    await user.type(days, '14')
    await user.click(screen.getByRole('checkbox', { name: 'Skip customers who were already helped' }))

    // The companion is shown, locked: the screen says what is sent.
    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Limited' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Expired' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Expired' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Audience' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Audience' })).toHaveTextContent('Active subscribers')

    await send(user, postSpy)
    const draft = bodyOf(postSpy, '/admin/broadcast/drafts')
    expect(draft.audience).toBe('ACTIVE_SUBSCRIBERS')
    expect(draft.audienceFilter).toEqual({
      subscription: COMPANION,
      connect: { bucket: 'paid', withinDays: 14, excludeHelped: false },
    })
  })

  it('sends the companion on the PREVIEW draft too — the row that is counted is the row that is sent', async () => {
    const getSpy = mockGet()
    const postSpy = mockPost()
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { id: 'broadcast-1' } })
    const user = await openCompose()
    await user.click(screen.getByRole('button', { name: TRIAL }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))
    expect(await screen.findByText('12 recipients match')).toBeInTheDocument()
    expect(getSpy).toHaveBeenCalledWith('/admin/broadcast/broadcast-1/audience-preview')
    expect(bodyOf(postSpy, '/admin/broadcast/drafts')).toEqual({
      audience: 'ACTIVE_SUBSCRIBERS',
      audienceFilter: { subscription: COMPANION, connect: { bucket: 'trial', withinDays: 7, excludeHelped: true } },
    })

    await send(user, postSpy)
    const patched = bodyOf(patchSpy, '/admin/broadcast/drafts/broadcast-1')
    expect(patched.audience).toBe('ACTIVE_SUBSCRIBERS')
    expect(patched.audienceFilter).toEqual({
      subscription: COMPANION,
      connect: { bucket: 'trial', withinDays: 7, excludeHelped: true },
    })
  })

  it('taking the chip back sends no connect and hands the chips back to the operator', async () => {
    mockGet()
    const postSpy = mockPost()
    const user = await openCompose()
    await user.click(screen.getByRole('button', { name: 'Expired' }))
    await user.click(screen.getByRole('button', { name: PAID }))
    await user.click(screen.getByRole('button', { name: PAID }))
    expect(screen.getByRole('button', { name: 'Expired' })).toHaveAttribute('aria-pressed', 'true')
    await send(user, postSpy)
    const draft = bodyOf(postSpy, '/admin/broadcast/drafts')
    expect(draft.audience).toBe('ALL')
    expect(draft.audienceFilter).toEqual({ subscription: ['EXPIRED'] })
  })
})

describe('«Подключение VPN» — the preview', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('says how many it could not verify, and why the panel cannot tell yet', async () => {
    mockGet(
      preview({
        unverified: 30,
        health: { ...LIVE, state: 'starting', firstPassHours: 3, coverage: { total: 40, connected: 6, verified: 4, unverified: 30 } },
      }),
    )
    mockPost()
    const user = await openCompose()
    await user.click(screen.getByRole('button', { name: PAID }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))
    expect(await screen.findByText('12 recipients match')).toBeInTheDocument()
    expect(screen.getByText('30 more not verified — they will not get it')).toBeInTheDocument()
    expect(
      screen.getByText('Checking subscriptions for the first time — this takes up to 3 h. Checked so far: 10 of 40.'),
    ).toBeInTheDocument()
  })

  it('says nothing more while the signal is live and everyone is verified', async () => {
    mockGet(preview({ unverified: 0 }))
    mockPost()
    const user = await openCompose()
    await user.click(screen.getByRole('button', { name: PAID }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))
    expect(await screen.findByText('12 recipients match')).toBeInTheDocument()
    expect(screen.queryByText(/not verified/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Remnawave|first time/)).not.toBeInTheDocument()
  })

  it('names the moment Remnawave stopped answering when the panel is blind', async () => {
    mockGet(
      preview({
        unverified: 2,
        health: { ...LIVE, state: 'blind', failingSince: '2026-09-18T10:10:00.000Z' },
      }),
    )
    mockPost()
    const user = await openCompose()
    await user.click(screen.getByRole('button', { name: PAID }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))
    expect(
      await screen.findByText(
        /^We can't tell who has connected right now: Remnawave has not answered since .*2026.* and no webhooks are arriving\. Automatic help is paused\.$/,
      ),
    ).toBeInTheDocument()
  })

  it('shows the refusal instead of a count when there are too many', async () => {
    mockGet(preview({ refusal: 'too_many', verified: 23_456 }, null))
    mockPost()
    const user = await openCompose()
    await user.click(screen.getByRole('button', { name: PAID }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))
    expect(
      await screen.findByText('Too many recipients for the "not connected" filter — shorten the period'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/recipients match/)).not.toBeInTheDocument()
  })

  it('goes stale when the days change, like every other chip', async () => {
    mockGet()
    mockPost()
    vi.spyOn(api, 'patch').mockResolvedValue({ data: { id: 'broadcast-1' } })
    const user = await openCompose()
    await user.click(screen.getByRole('button', { name: PAID }))
    await user.click(screen.getByRole('button', { name: 'Check audience' }))
    expect(await screen.findByText('12 recipients match')).toBeInTheDocument()
    const days = screen.getByLabelText('Over the last, days')
    await user.clear(days)
    await user.type(days, '3')
    expect(screen.queryByText('12 recipients match')).not.toBeInTheDocument()
    expect(screen.getByText('Filters changed — check again')).toBeInTheDocument()
  })
})

describe('the link /broadcast?compose=connect-help', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('opens «New broadcast» with the bucket and the days set', async () => {
    mockGet()
    const postSpy = mockPost()
    const user = await openCompose('/broadcast?compose=connect-help&bucket=trial&days=12')
    expect(await screen.findByRole('heading', { name: 'New broadcast' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: TRIAL })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: PAID })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Over the last, days')).toHaveValue(12)
    expect(screen.getByRole('checkbox', { name: 'Skip customers who were already helped' })).toBeChecked()
    // The «Помощь с подключением» text for trials and gifts — in Russian, as
    // broadcasts are, and with no placeholder a broadcast would send literally.
    expect(screen.getByLabelText('Title')).toHaveValue('Не получилось подключиться?')
    const message = screen.getByRole('textbox', { name: 'Message text' }) as HTMLTextAreaElement
    expect(message.value.startsWith('Подписка уже работает, но VPN на ней ещё ни разу не подключался.')).toBe(true)
    expect(message.value).not.toContain('{{')

    await send(user, postSpy)
    const draft = bodyOf(postSpy, '/admin/broadcast/drafts')
    expect(draft).toMatchObject({
      audience: 'ACTIVE_SUBSCRIBERS',
      audienceFilter: { subscription: COMPANION, connect: { bucket: 'trial', withinDays: 12, excludeHelped: true } },
    })
    expect((draft.payload as { title: string }).title).toBe('Не получилось подключиться?')
  })

  it('starts «Оплатил» from the paid text', async () => {
    mockGet()
    await openCompose('/broadcast?compose=connect-help&bucket=paid&days=7')
    const message = (await screen.findByRole('textbox', { name: 'Message text' })) as HTMLTextAreaElement
    expect(message.value.startsWith('Подписка оплачена, но VPN на ней ещё ни разу не подключался.')).toBe(true)
  })

  it('clamps the days and guesses no bucket it does not know', async () => {
    mockGet()
    const user = await openCompose('/broadcast?compose=connect-help&bucket=everyone&days=45')
    expect(await screen.findByRole('heading', { name: 'New broadcast' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: PAID })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: TRIAL })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('textbox', { name: 'Message text' })).toHaveValue('')
    await user.click(screen.getByRole('button', { name: PAID }))
    expect(screen.getByLabelText('Over the last, days')).toHaveValue(30)
  })

  it('once closed, does not reopen', async () => {
    mockGet()
    const user = await openCompose('/broadcast?compose=connect-help&bucket=paid&days=7')
    expect(await screen.findByRole('heading', { name: 'New broadcast' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'New broadcast' })).not.toBeInTheDocument()
    })
    // «New broadcast» from the page is a clean form again.
    await user.click(screen.getByRole('button', { name: 'New broadcast' }))
    expect(screen.getByRole('button', { name: PAID })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('textbox', { name: 'Message text' })).toHaveValue('')
  })

  it('opens nothing without compose=connect-help', async () => {
    mockGet()
    await loadFeatureBundle('broadcast')
    renderWithProviders(<BroadcastPage />, { route: '/broadcast?bucket=paid&days=7' })
    expect(await screen.findByRole('button', { name: 'New broadcast' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'New broadcast' })).not.toBeInTheDocument()
  })
})

describe('«Подключение VPN» in Russian', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    if (i18n.language !== 'en') await i18n.changeLanguage('en')
  })

  it('reads as the owner named it', async () => {
    await i18n.changeLanguage('ru')
    await waitFor(() => {
      expect(i18n.hasResourceBundle('ru', 'translation')).toBe(true)
    })
    await loadFeatureBundle('broadcast')
    mockGet(preview({ unverified: 21 }))
    mockPost()
    const user = userEvent.setup()
    renderWithProviders(<BroadcastPage />, { route: '/broadcast?compose=connect-help&bucket=paid&days=7' })
    expect(await screen.findByRole('button', { name: 'Оплатил и не подключился' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Пробный период или подарок — не подключился' })).toBeInTheDocument()
    expect(screen.getByLabelText('За последние, дней')).toHaveValue(7)
    expect(screen.getByRole('checkbox', { name: 'Не слать тем, кому уже помогли' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Проверить аудиторию' }))
    expect(await screen.findByText('Подходит получателей: 12')).toBeInTheDocument()
    // 21 is the singular form in Russian.
    expect(screen.getByText('Ещё 21 не проверен — ему не придёт')).toBeInTheDocument()
  })
})

describe('the pure rules', () => {
  it('clamps days into 1–30 and reads nonsense as 7', () => {
    expect([0, 1, 7, 30, 31, -4].map(clampConnectDays)).toEqual([1, 1, 7, 30, 30, 1])
    expect(clampConnectDays('12')).toBe(12)
    expect(clampConnectDays('')).toBe(7)
    expect(clampConnectDays('abc')).toBe(7)
  })

  it('reads the prefill only from compose=connect-help; a missing bucket is «Оплатил»', () => {
    expect(parseConnectPrefill(new URLSearchParams('bucket=paid'))).toBeNull()
    expect(parseConnectPrefill(new URLSearchParams('compose=other&bucket=paid'))).toBeNull()
    expect(parseConnectPrefill(new URLSearchParams('compose=connect-help'))).toEqual({ bucket: 'paid', days: 7 })
    expect(parseConnectPrefill(new URLSearchParams('compose=connect-help&bucket=trial&days=3'))).toEqual({
      bucket: 'trial',
      days: 3,
    })
    expect(parseConnectPrefill(new URLSearchParams('compose=connect-help&bucket=all&days=0'))).toEqual({
      bucket: null,
      days: 1,
    })
    expect(withoutConnectPrefill(new URLSearchParams('compose=connect-help&bucket=paid&days=7&tab=x')).toString()).toBe(
      'tab=x',
    )
  })

  it('has a health sentence for every state but live', () => {
    const at = (iso: string) => `@${iso}`
    expect(connectHealthSentence(LIVE, at)).toBeNull()
    expect(connectHealthSentence({ ...LIVE, state: 'starting', firstPassHours: 0 }, at)).toEqual({
      key: 'broadcastPage.connect.health.starting',
      values: { hours: 1, done: 40, total: 40 },
    })
    expect(connectHealthSentence({ ...LIVE, state: 'webhooks_only', failingSince: 'F', lastOkAt: 'L' }, at)).toEqual({
      key: 'broadcastPage.connect.health.webhooks_only',
      values: { time: '@F' },
    })
    expect(connectHealthSentence({ ...LIVE, state: 'blind', failingSince: null, lastOkAt: 'L' }, at)?.values).toEqual({
      time: '@L',
    })
  })
})
