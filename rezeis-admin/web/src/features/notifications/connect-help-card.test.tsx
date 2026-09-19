/**
 * «Уведомления» → «Пользовательские» → «Помощь с подключением».
 *
 * The card as the operator uses it: off by default, the trials switch greyed
 * out until the main one is on, the hours saved only when the server would
 * take them, one key per save, the signal and the last pass in words, the
 * broadcast link, and the log a page at a time. Every request is asserted on
 * what was actually sent, and the answers are what the server really returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import { ConnectHelpCard } from './connect-help-card'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

/** A bundle string, proven to be one: i18next answers a missing key with the key itself. */
function says(key: string, options?: Record<string, unknown>): string {
  const text = String(i18n.t(key, options))
  expect(text, `${key} is missing from the bundle`).not.toBe(key)
  return text
}

const LIVE_STATUS = {
  health: {
    state: 'live',
    checkedCoverage: 0.9,
    lastOkAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    lastUserWebhookAt: null,
    coverage: { total: 40, connected: 25, verified: 10, unverified: 5 },
    probe: { failingSince: null, firstPassHours: 0, backlog: 0 },
  },
  lastCycle: {
    startedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 60_000).toISOString(),
    standDown: null,
    checked: 12,
    waiting: 5,
    sent: { bot: 2, push: 1, email: 0 },
    banner: 1,
    optedOut: 0,
    merged: 0,
    skippedUnverifiable: 0,
    skippedTemplateOff: 0,
    stopped: 0,
    failed: 0,
    deferred: 0,
    leftOver: 0,
    errors: 0,
  },
  templates: { connect_help: 'active', connect_help_trial: 'active' },
  timezone: 'UTC',
}

interface ApiScript {
  settings?: unknown
  settingsFails?: boolean
  status?: unknown
  logPages?: Record<string, unknown>
}

const logCalls: Array<Record<string, unknown>> = []

function mockApi(script: ApiScript) {
  logCalls.length = 0
  // The server keeps what a PATCH saved, and a later GET reads it back.
  let stored: Record<string, unknown> = { ...((script.settings as Record<string, unknown> | undefined) ?? {}) }
  vi.spyOn(api, 'get').mockImplementation(async (path: string, config?: { params?: Record<string, unknown> }) => {
    if (path === '/admin/connect-help/settings') {
      if (script.settingsFails === true) throw new Error('500')
      return { data: stored }
    }
    if (path === '/admin/connect-help/status') return { data: script.status ?? LIVE_STATUS }
    if (path === '/admin/connect-help/log') {
      const params = config?.params ?? {}
      logCalls.push(params)
      const key = `${String(params['outcome'] ?? 'all')}:${String(params['cursor'] ?? '')}`
      return { data: script.logPages?.[key] ?? { items: [], nextCursor: null, timezone: 'UTC' } }
    }
    return { data: [] }
  })
  return vi.spyOn(api, 'patch').mockImplementation(async (_path: string, body: unknown) => {
    stored = { ...stored, ...(body as Record<string, unknown>) }
    return { data: stored }
  })
}

function grant(permissions: readonly string[]): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

async function card(): Promise<HTMLElement> {
  const title = await screen.findByText(says('notificationsPage.connectHelp.title'))
  const surface = title.closest('[data-concept-surface="card"]')
  expect(surface).not.toBeNull()
  return surface as HTMLElement
}

function switchLabelled(key: string): HTMLElement {
  return screen.getByRole('switch', { name: says(key) })
}

beforeEach(async () => {
  await loadFeatureBundle('notifications')
  grant(['notifications:view', 'settings:view', 'settings:edit'])
})

afterEach(() => {
  vi.restoreAllMocks()
  usePermissionStore.getState().reset()
})

describe('the switches', () => {
  it('shows an install that never saved anything as off, with the trials switch greyed out', async () => {
    mockApi({ settings: {} })
    renderWithProviders(<ConnectHelpCard />)
    await card()

    const enabled = switchLabelled('notificationsPage.connectHelp.enabled.label')
    await waitFor(() => expect(enabled).toBeEnabled())
    expect(enabled).toHaveAttribute('aria-checked', 'false')
    const trials = switchLabelled('notificationsPage.connectHelp.trials.label')
    expect(trials).toHaveAttribute('aria-checked', 'false')
    expect(trials).toBeDisabled()
    expect(screen.getByLabelText(says('notificationsPage.connectHelp.delay.label'))).toHaveValue('24')
  })

  it('turns the help on with exactly one key', async () => {
    const patch = mockApi({ settings: { enabled: false, delayHours: 24, includeTrials: false } })
    renderWithProviders(<ConnectHelpCard />)
    const user = userEvent.setup()
    await card()
    const enabled = switchLabelled('notificationsPage.connectHelp.enabled.label')
    await waitFor(() => expect(enabled).toBeEnabled())

    await user.click(enabled)

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/connect-help/settings', { enabled: true })
    // The saved answer is shown: the sub-option becomes available.
    await waitFor(() => expect(switchLabelled('notificationsPage.connectHelp.trials.label')).toBeEnabled())
  })

  it('offers trials and gifts once the main switch is on, and saves only that key', async () => {
    const patch = mockApi({ settings: { enabled: true, delayHours: 24, includeTrials: false } })
    renderWithProviders(<ConnectHelpCard />)
    const user = userEvent.setup()
    await card()
    const trials = switchLabelled('notificationsPage.connectHelp.trials.label')
    await waitFor(() => expect(trials).toBeEnabled())

    await user.click(trials)

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/connect-help/settings', { includeTrials: true }))
  })

  it('saves the hours only when the server would take them', async () => {
    const patch = mockApi({ settings: { enabled: true, delayHours: 24, includeTrials: false } })
    renderWithProviders(<ConnectHelpCard />)
    const user = userEvent.setup()
    const surface = await card()
    const label = says('notificationsPage.connectHelp.delay.label')
    // The field is drawn afresh once the stored hours arrive, so it is looked
    // up after that, not before.
    await waitFor(() => expect(within(surface).getByLabelText(label)).toHaveValue('24'))
    const field = within(surface).getByLabelText(label)
    const save = within(surface).getByRole('button', { name: says('notificationsPage.connectHelp.delay.save') })
    expect(save).toBeDisabled()

    // `fireEvent.change`, not `userEvent.type`: the browser does not rewrite
    // what an operator typed, and neither may the test.
    for (const refused of ['0', '169', '1.5', '1e2']) {
      fireEvent.change(field, { target: { value: refused } })
      expect(save, refused).toBeDisabled()
      expect(within(surface).getByRole('alert')).toHaveTextContent(says('notificationsPage.connectHelp.delay.invalid'))
    }

    fireEvent.change(field, { target: { value: '36' } })
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/connect-help/settings', { delayHours: 36 }))
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('lets an operator without settings:edit read but not change', async () => {
    grant(['notifications:view'])
    mockApi({ settings: { enabled: true, delayHours: 24, includeTrials: true } })
    renderWithProviders(<ConnectHelpCard />)
    await card()

    await waitFor(() =>
      expect(switchLabelled('notificationsPage.connectHelp.enabled.label')).toHaveAttribute('aria-checked', 'true'),
    )
    expect(switchLabelled('notificationsPage.connectHelp.enabled.label')).toBeDisabled()
    expect(switchLabelled('notificationsPage.connectHelp.trials.label')).toBeDisabled()
    expect(screen.getByLabelText(says('notificationsPage.connectHelp.delay.label'))).toBeDisabled()
    expect(screen.getByText(says('notificationsPage.connectHelp.noEditRight'))).toBeInTheDocument()
  })

  it('says so, and changes nothing, when the settings cannot be read', async () => {
    mockApi({ settingsFails: true })
    renderWithProviders(<ConnectHelpCard />)
    await card()

    expect(await screen.findByText(says('notificationsPage.connectHelp.loadFailed'))).toBeInTheDocument()
    expect(switchLabelled('notificationsPage.connectHelp.enabled.label')).toBeDisabled()
  })
})

describe('what the card says', () => {
  it('words the signal and the last pass', async () => {
    mockApi({ settings: { enabled: true, delayHours: 24, includeTrials: false } })
    renderWithProviders(<ConnectHelpCard />)
    await card()

    const signal = await screen.findByTestId('connect-help-signal')
    await waitFor(() =>
      expect(signal).toHaveTextContent(
        says('notificationsPage.connectHelp.signal.live', {
          ago: says('notificationsPage.connectHelp.signal.minutesAgo', { count: 3 }),
          done: 35,
          total: 40,
        }),
      ),
    )
    const last = screen.getByTestId('connect-help-last-cycle')
    expect(last.textContent).toContain(
      says('notificationsPage.connectHelp.lastCycle.channels.bot', { count: 2 }),
    )
    expect(last.textContent).not.toContain(says('notificationsPage.connectHelp.lastCycle.channels.email', { count: 0 }))
  })

  it('says the help is paused while the panel cannot tell who connected', async () => {
    mockApi({
      settings: { enabled: true, delayHours: 24, includeTrials: false },
      status: {
        ...LIVE_STATUS,
        health: {
          ...LIVE_STATUS.health,
          state: 'blind',
          probe: { failingSince: '2026-09-19T05:00:00.000Z', firstPassHours: 0, backlog: 0 },
        },
      },
    })
    renderWithProviders(<ConnectHelpCard />)
    await card()

    const signal = await screen.findByTestId('connect-help-signal')
    await waitFor(() => expect(signal.textContent).toContain('05:00'))
    expect(signal.textContent).toContain(
      says('notificationsPage.connectHelp.signal.blind', { time: '§' }).split('§')[1],
    )
  })

  it('warns when the paid template is switched off', async () => {
    mockApi({
      settings: { enabled: true, delayHours: 24, includeTrials: false },
      status: { ...LIVE_STATUS, templates: { connect_help: 'inactive', connect_help_trial: 'active' } },
    })
    renderWithProviders(<ConnectHelpCard />)
    await card()

    expect(await screen.findByText(says('notificationsPage.connectHelp.templates.paidOff'))).toBeInTheDocument()
    expect(screen.queryByText(says('notificationsPage.connectHelp.templates.trialOff'))).toBeNull()
  })

  it('opens the broadcast draft for those already waiting', async () => {
    mockApi({ settings: {} })
    renderWithProviders(<ConnectHelpCard />)
    await card()

    expect(screen.getByRole('link', { name: says('notificationsPage.connectHelp.links.broadcast') })).toHaveAttribute(
      'href',
      '/broadcast?compose=connect-help&bucket=paid&days=7',
    )
    expect(screen.getByRole('link', { name: says('notificationsPage.connectHelp.links.botMap') })).toHaveAttribute(
      'href',
      '/bot-map',
    )
  })

  it('puts an (i) on every control', async () => {
    mockApi({ settings: {} })
    renderWithProviders(<ConnectHelpCard />)
    await card()

    for (const key of [
      'enabled.infoLabel',
      'delay.infoLabel',
      'trials.infoLabel',
      'signal.infoLabel',
      'lastCycle.infoLabel',
      'links.editInfoLabel',
      'links.broadcastInfoLabel',
      'links.logInfoLabel',
    ]) {
      expect(screen.getByRole('button', { name: says(`notificationsPage.connectHelp.${key}`) })).toBeInTheDocument()
    }
  })
})

describe('the log', () => {
  const ROW = {
    subscriptionId: 'sub-1',
    decidedAt: '2026-09-19T07:40:00.000Z',
    kind: 'paid',
    anchorAt: '2026-09-18T07:00:00.000Z',
    source: 'auto',
    outcome: 'push',
    attempts: [
      { channel: 'bot', result: 'unavailable', at: '2026-09-19T07:40:00.000Z', detail: 'bot_blocked' },
      { channel: 'push', result: 'delivered', at: '2026-09-19T07:40:01.000Z', detail: '1/1' },
    ],
    deferrals: 0,
    eventId: 'evt-1',
    connectedAt: null,
    user: { id: 'u-1', telegramId: '777', name: 'Анна', username: 'anna' },
    planName: 'Премиум',
    subscriptionStatus: 'ACTIVE',
  }

  it('opens newest first, pages on, and filters by outcome', async () => {
    mockApi({
      settings: {},
      logPages: {
        'all:': { items: [ROW], nextCursor: 'cursor-2', timezone: 'Asia/Vladivostok' },
        'all:cursor-2': {
          items: [{ ...ROW, subscriptionId: 'sub-2', user: { ...ROW.user, name: 'Борис', username: null } }],
          nextCursor: null,
          timezone: 'Asia/Vladivostok',
        },
        'banner:': { items: [], nextCursor: null, timezone: 'Asia/Vladivostok' },
      },
    })
    renderWithProviders(<ConnectHelpCard />)
    const user = userEvent.setup()
    await card()

    await user.click(screen.getByRole('button', { name: says('notificationsPage.connectHelp.links.log') }))
    const dialog = await screen.findByRole('dialog')
    const list = await within(dialog).findByTestId('connect-help-log')
    expect(list).toHaveTextContent('Анна (@anna)')
    // In the panel's zone: 07:40Z is 17:40 in Vladivostok.
    expect(list).toHaveTextContent('17:40')
    expect(list).toHaveTextContent(
      `${says('notificationsPage.connectHelp.log.attempt.channel.bot')}: ${says('notificationsPage.connectHelp.log.attempt.unavailable.bot_blocked')}`,
    )
    expect(logCalls).toEqual([{}])

    await user.click(within(dialog).getByRole('button', { name: says('notificationsPage.connectHelp.log.more') }))
    await waitFor(() => expect(within(dialog).getByTestId('connect-help-log')).toHaveTextContent('Борис'))
    expect(logCalls).toEqual([{}, { cursor: 'cursor-2' }])
    expect(within(dialog).queryByRole('button', { name: says('notificationsPage.connectHelp.log.more') })).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: says('notificationsPage.connectHelp.log.outcome.banner') }))
    expect(await within(dialog).findByText(says('notificationsPage.connectHelp.log.empty'))).toBeInTheDocument()
    expect(logCalls[logCalls.length - 1]).toEqual({ outcome: 'banner' })
  })
})
