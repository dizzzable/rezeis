/**
 * «Доп. услуги» → «Настройки»: the three switches of the add-on accounting.
 *
 * Driven the way an operator drives them — click the switch, read the dialog,
 * press a button — and asserted on THE REQUESTS THAT GO OUT. The owner's rule
 * for switching off is that it is never silent: nothing leaves the page until
 * the dialog that says what switching off does NOT undo is accepted. The
 * server refuses an unconfirmed switch-off too (`confirmOff`); these cases
 * prove the page asks, and sends the confirmation only once it was given.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { usePermissionStore } from '@/features/rbac'
import { renderWithProviders } from '@/test/test-utils'
import { AddOnSwitchesCard, type AddOnSwitchState } from './add-on-switches-card'
import { formatUtcOffset, isAcceptableTimeZone, utcTime } from './remnawave-time-zone'

const DEFAULTS: readonly AddOnSwitchState[] = [
  { name: 'durableAccounting', enabled: true, defaultEnabled: true, stored: null, env: [] },
  { name: 'deviceCleanupAuto', enabled: true, defaultEnabled: true, stored: null, env: [] },
  // ON by default since 25.09.2026, once the reset instants matched live Remnawave.
  { name: 'trafficResetExpiry', enabled: true, defaultEnabled: true, stored: null, env: [] },
]

function grant(tokens: readonly string[]): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens),
    mustChangePassword: false,
    // Not 'DEV': that role passes every check, and the read-only case below
    // would pass whatever the card rendered.
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

function serve(switches: readonly AddOnSwitchState[]) {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/add-on-settings') return { data: { switches } }
    return { data: {} }
  })
  return vi.spyOn(api, 'patch').mockImplementation(async (_path: string, body?: unknown) => {
    const changes = body as Record<string, unknown>
    return {
      data: {
        switches: switches.map((entry) =>
          typeof changes[entry.name] === 'boolean' ? { ...entry, enabled: changes[entry.name] as boolean } : entry,
        ),
      },
    }
  })
}

beforeAll(async () => {
  // The words live in the lazy `addOns` bundle, which the router loads and a
  // bare render does not.
  await i18nReady
  await loadFeatureBundle('addOns')
})

describe('the add-on accounting switches', () => {
  beforeEach(() => {
    grant(['add_ons:view', 'add_ons:edit'])
  })

  afterEach(() => {
    cleanup()
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('draws the three switches as the server runs them, all ON by default, the traffic one with a caution', async () => {
    serve(DEFAULTS)
    renderWithProviders(<AddOnSwitchesCard />)

    expect(await screen.findByRole('switch', { name: 'New add-on accounting' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Remove extra devices automatically' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Traffic add-ons until the reset' })).toBeChecked()
    // The caution under the traffic switch points at the zone field below it.
    expect(screen.getByText(/Reset times follow the “Remnawave time zone” below/)).toBeInTheDocument()
    expect(screen.getAllByText('On by default')).toHaveLength(3)
    expect(screen.queryByText('Off by default')).not.toBeInTheDocument()
  })

  it('shows a switch .env decides as locked, naming the variable and its value', async () => {
    serve([
      DEFAULTS[0]!,
      { ...DEFAULTS[1]!, enabled: false, stored: true, env: [{ variable: 'ADDON_DEVICE_CLEANUP_AUTO', enabled: false }] },
      DEFAULTS[2]!,
    ])
    renderWithProviders(<AddOnSwitchesCard />)

    const locked = await screen.findByRole('switch', { name: 'Remove extra devices automatically' })
    expect(locked).not.toBeChecked()
    expect(locked).toBeDisabled()
    expect(screen.getByText('Set in .env: ADDON_DEVICE_CLEANUP_AUTO=false')).toBeInTheDocument()
    expect(screen.getByText(/delete that line and run docker compose up -d/)).toBeInTheDocument()
    // Only that one: the others stay in the operator's hands.
    expect(screen.getByRole('switch', { name: 'New add-on accounting' })).toBeEnabled()
  })

  it('says what deleting the .env line leads to, only under a switch .env decides', async () => {
    serve([
      // Held OFF by .env; nothing saved in the panel, so its default — ON — takes over.
      { ...DEFAULTS[0]!, enabled: false, env: [{ variable: 'ADDON_ENTITLEMENT_SHADOW', enabled: false }] },
      // Held OFF by .env; OFF saved in the panel, which is what takes over.
      { ...DEFAULTS[1]!, enabled: false, stored: false, env: [{ variable: 'ADDON_DEVICE_CLEANUP_AUTO', enabled: false }] },
      DEFAULTS[2]!,
    ])
    renderWithProviders(<AddOnSwitchesCard />)

    await screen.findByRole('switch', { name: 'New add-on accounting' })
    expect(
      screen.getByText(
        'If you delete the line from .env, after the restart the panel’s value applies — by default “on”. To keep it off, do not delete the line.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('If you delete the line from .env, after the restart the value saved in the panel applies: “off”.'),
    ).toBeInTheDocument()
    // Exactly those two: the switch the operator manages from here says nothing of .env.
    expect(screen.getAllByText(/If you delete the line from \.env/)).toHaveLength(2)
  })

  it('says nothing of .env while no switch is set there', async () => {
    serve(DEFAULTS)
    renderWithProviders(<AddOnSwitchesCard />)
    await screen.findByRole('switch', { name: 'New add-on accounting' })
    expect(screen.queryByText(/If you delete the line from \.env/)).not.toBeInTheDocument()
  })

  it('asks before switching OFF, says what it does not undo, and sends only once confirmed', async () => {
    const user = userEvent.setup()
    const patch = serve(DEFAULTS)
    renderWithProviders(<AddOnSwitchesCard />)

    await user.click(await screen.findByRole('switch', { name: 'New add-on accounting' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Switch off “New add-on accounting”?')).toBeInTheDocument()
    expect(within(dialog).getByText('What switching off does NOT undo:')).toBeInTheDocument()
    expect(within(dialog).getByText('Subscriptions already in the new accounting stay in it.')).toBeInTheDocument()
    expect(within(dialog).getByText('Add-ons already sold end on their dates.')).toBeInTheDocument()
    expect(patch).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/add-on-settings', { durableAccounting: false, confirmOff: true })
    expect(await screen.findByRole('switch', { name: 'New add-on accounting' })).not.toBeChecked()
  })

  it('sends nothing when the dialog is cancelled', async () => {
    const user = userEvent.setup()
    const patch = serve(DEFAULTS)
    renderWithProviders(<AddOnSwitchesCard />)

    await user.click(await screen.findByRole('switch', { name: 'Remove extra devices automatically' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Devices already removed do not come back.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(patch).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', { name: 'Remove extra devices automatically' })).toBeChecked()
  })

  it('switches ON at once, with no dialog and no confirmation sent', async () => {
    const user = userEvent.setup()
    // Switched off on the page earlier: ON is the default now.
    const patch = serve([DEFAULTS[0]!, DEFAULTS[1]!, { ...DEFAULTS[2]!, enabled: false, stored: false }])
    renderWithProviders(<AddOnSwitchesCard />)

    await user.click(await screen.findByRole('switch', { name: 'Traffic add-ons until the reset' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/add-on-settings', { trafficResetExpiry: true })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  // N1 gap 3: «Докупка трафика до сброса» carries one .env variable per reset
  // rule, and a line for one rule leaves the other rules to the switch.
  const DAY_OFF_IN_ENV: AddOnSwitchState = {
    ...DEFAULTS[2]!,
    enabled: true,
    env: [{ variable: 'ADDON_RESET_EXPIRY_DAY', enabled: false }],
    locked: false,
  }

  it('N1 gap 3: shows a switch .env sets for SOME reset rules at the value the others run with, still changeable, naming those rules', async () => {
    serve([DEFAULTS[0]!, DEFAULTS[1]!, DAY_OFF_IN_ENV])
    renderWithProviders(<AddOnSwitchesCard />)

    const toggle = await screen.findByRole('switch', { name: 'Traffic add-ons until the reset' })
    expect(toggle).toBeChecked()
    expect(toggle).toBeEnabled()
    expect(screen.getByText('Set in .env for: the daily reset — off (ADDON_RESET_EXPIRY_DAY=false)')).toBeInTheDocument()
    expect(screen.getByText('The other reset rules follow this switch, and it can be changed here.')).toBeInTheDocument()
    expect(
      screen.getByText(
        'If you delete a line from .env, after the restart its rule follows this switch. To keep that rule off, do not delete the line.',
      ),
    ).toBeInTheDocument()
    // Not the whole-switch lock.
    expect(screen.queryByText(/^Set in \.env: /)).not.toBeInTheDocument()
    expect(screen.queryByText(/delete that line and run docker compose up -d/)).not.toBeInTheDocument()
  })

  it('N1 gap 3: switching it off asks, says the rules .env sets stay as they are, and sends the change', async () => {
    const user = userEvent.setup()
    const patch = serve([DEFAULTS[0]!, DEFAULTS[1]!, DAY_OFF_IN_ENV])
    renderWithProviders(<AddOnSwitchesCard />)

    await user.click(await screen.findByRole('switch', { name: 'Traffic add-ons until the reset' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(
        'Switching off does not change the reset rules set in .env: the daily reset — off (ADDON_RESET_EXPIRY_DAY=false).',
      ),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/add-on-settings', { trafficResetExpiry: false, confirmOff: true })
  })

  it('N1 gap 3: a switch with EVERY reset rule in .env is locked, as is any switch from a panel that predates `locked`', async () => {
    serve([
      // An older panel: no `locked`, and one line locked the switch.
      { ...DEFAULTS[0]!, enabled: false, env: [{ variable: 'ADDON_ENTITLEMENT_SHADOW', enabled: false }] },
      DEFAULTS[1]!,
      {
        ...DEFAULTS[2]!,
        enabled: false,
        env: [
          { variable: 'ADDON_RESET_EXPIRY_DAY', enabled: false },
          { variable: 'ADDON_RESET_EXPIRY_WEEK', enabled: true },
          { variable: 'ADDON_RESET_EXPIRY_MONTH', enabled: true },
          { variable: 'ADDON_RESET_EXPIRY_MONTH_ROLLING', enabled: true },
        ],
        locked: true,
      },
    ])
    renderWithProviders(<AddOnSwitchesCard />)

    expect(await screen.findByRole('switch', { name: 'Traffic add-ons until the reset' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'New add-on accounting' })).toBeDisabled()
    expect(screen.queryByText(/^Set in \.env for:/)).not.toBeInTheDocument()
  })

  it('N1 gap 1: «New add-on accounting» says a traffic add-on on a plan with resets ends at the nearest reset', async () => {
    serve(DEFAULTS)
    renderWithProviders(<AddOnSwitchesCard />)

    await screen.findByRole('switch', { name: 'New add-on accounting' })
    expect(screen.getByText(/on a plan that resets traffic, until the nearest reset while “Traffic add-ons until the reset” is on/)).toBeInTheDocument()
    const ru = (await import('@/i18n/features/addOns.ru')).ru.addOnSwitches.switches.durableAccounting.description
    expect(ru).toContain('на тарифе со сбросом трафика — до ближайшего сброса')
    expect(ru).not.toContain('вместе с концом подписки')
  })

  it('leaves every switch read-only without Add-ons → Edit', async () => {
    grant(['add_ons:view'])
    serve(DEFAULTS)
    renderWithProviders(<AddOnSwitchesCard />)

    for (const name of ['New add-on accounting', 'Remove extra devices automatically', 'Traffic add-ons until the reset']) {
      expect(await screen.findByRole('switch', { name })).toBeDisabled()
    }
    expect(screen.getByText('Only a role with Add-ons → Edit can change these switches.')).toBeInTheDocument()
  })
})

/** The page's view with «Remnawave time zone» and, optionally, the daily check's verdict. */
function serveWithZone(options: {
  readonly stored: string | null
  readonly verdict?: Record<string, unknown> | null
}) {
  let stored = options.stored
  const view = () => ({
    switches: DEFAULTS,
    remnawaveTimeZone: { value: stored ?? 'UTC', stored, defaultValue: 'UTC' },
    resetScheduleCheck: options.verdict ?? { status: 'ok', timeZone: stored ?? 'UTC', checkedAt: '', mismatches: [] },
  })
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/add-on-settings') return { data: view() }
    return { data: {} }
  })
  return vi.spyOn(api, 'patch').mockImplementation(async (_path: string, body?: unknown) => {
    const zone = (body as { remnawaveTimeZone?: unknown }).remnawaveTimeZone
    if (typeof zone === 'string') stored = zone.trim() === '' ? null : zone.trim()
    return { data: view() }
  })
}

describe('«Remnawave time zone»', () => {
  beforeEach(() => {
    grant(['add_ons:view', 'add_ons:edit'])
  })

  afterEach(() => {
    cleanup()
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('shows the stored zone, where it comes from, and sends only the zone when saved', async () => {
    const user = userEvent.setup()
    const patch = serveWithZone({ stored: null })
    renderWithProviders(<AddOnSwitchesCard />)

    const field = await screen.findByLabelText('Remnawave time zone')
    expect(field).toHaveValue('')
    expect(screen.getByText('Not set — UTC')).toBeInTheDocument()
    expect(screen.getByText(/the TZ line in the Remnawave server’s \.env file, or UTC when there is none/)).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    await user.type(field, 'Europe/Moscow')
    await user.click(save)

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/add-on-settings', { remnawaveTimeZone: 'Europe/Moscow' })
    await waitFor(() => expect(screen.getByLabelText('Remnawave time zone')).toHaveValue('Europe/Moscow'))
  })

  it('refuses a zone that does not exist before anything is sent', async () => {
    const user = userEvent.setup()
    const patch = serveWithZone({ stored: 'Europe/Moscow' })
    renderWithProviders(<AddOnSwitchesCard />)

    const field = await screen.findByLabelText('Remnawave time zone')
    expect(field).toHaveValue('Europe/Moscow')
    await user.clear(field)
    await user.type(field, 'Europe/Mosow')

    expect(await screen.findByRole('alert')).toHaveTextContent('There is no such time zone.')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.type(field, '{Enter}')
    expect(patch).not.toHaveBeenCalled()
  })

  it('puts the zone back to UTC with an empty field', async () => {
    const user = userEvent.setup()
    const patch = serveWithZone({ stored: 'Asia/Novosibirsk' })
    renderWithProviders(<AddOnSwitchesCard />)

    await user.clear(await screen.findByLabelText('Remnawave time zone'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/add-on-settings', { remnawaveTimeZone: '' }))
  })

  it('warns beside the field when Remnawave resets on another clock, naming what it observed', async () => {
    serveWithZone({
      stored: null,
      verdict: {
        status: 'mismatch',
        timeZone: 'UTC',
        checkedAt: '2026-09-25T10:00:00.000Z',
        mismatches: [
          {
            strategy: 'DAY',
            observedAt: '2026-09-25T03:05:00.013Z',
            expectedAt: '2026-09-25T00:05:00.000Z',
            impliedUtcOffsetMinutes: -180,
          },
        ],
      },
    })
    renderWithProviders(<AddOnSwitchesCard />)

    const warning = await screen.findByRole('status')
    expect(within(warning).getByText('Remnawave’s resets do not match this zone')).toBeInTheDocument()
    expect(
      within(warning).getByText(
        'The “Every day” reset ran at 03:05 UTC, while this zone expects it at 00:05 UTC. Remnawave seems to run in UTC−03:00.',
      ),
    ).toBeInTheDocument()
  })

  it('draws no warning while the resets agree', async () => {
    serveWithZone({ stored: 'Europe/Moscow' })
    renderWithProviders(<AddOnSwitchesCard />)
    expect(await screen.findByLabelText('Remnawave time zone')).toHaveValue('Europe/Moscow')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('is read-only without Add-ons → Edit', async () => {
    grant(['add_ons:view'])
    serveWithZone({ stored: 'Europe/Moscow' })
    renderWithProviders(<AddOnSwitchesCard />)
    expect(await screen.findByLabelText('Remnawave time zone')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('draws no field for a panel that predates the zone', async () => {
    serve(DEFAULTS)
    renderWithProviders(<AddOnSwitchesCard />)
    await screen.findByRole('switch', { name: 'New add-on accounting' })
    expect(screen.queryByLabelText('Remnawave time zone')).not.toBeInTheDocument()
  })
})

describe('the zone as the page checks and spells it', () => {
  it('takes IANA names and an empty field, and nothing Remnawave’s TZ cannot be', () => {
    for (const ok of ['', '  ', 'UTC', 'Europe/Moscow', 'Etc/GMT+3', 'America/Argentina/Salta']) {
      expect(isAcceptableTimeZone(ok)).toBe(true)
    }
    for (const bad of ['+03:00', 'UTC+3', 'Europe/Mosow', 'Moscow', 'Europe/../Moscow', `Europe/${'a'.repeat(60)}`]) {
      expect(isAcceptableTimeZone(bad)).toBe(false)
    }
  })

  it('spells offsets and times in one unambiguous zone', () => {
    expect(formatUtcOffset(180)).toBe('UTC+03:00')
    expect(formatUtcOffset(-180)).toBe('UTC−03:00')
    expect(formatUtcOffset(345)).toBe('UTC+05:45')
    expect(utcTime('2026-09-24T21:05:00.009Z')).toBe('21:05 UTC')
  })
})
