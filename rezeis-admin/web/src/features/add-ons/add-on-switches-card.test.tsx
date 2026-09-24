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

const DEFAULTS: readonly AddOnSwitchState[] = [
  { name: 'durableAccounting', enabled: true, defaultEnabled: true, stored: null, env: [] },
  { name: 'deviceCleanupAuto', enabled: true, defaultEnabled: true, stored: null, env: [] },
  { name: 'trafficResetExpiry', enabled: false, defaultEnabled: false, stored: null, env: [] },
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

  it('draws the three switches as the server runs them, the traffic add-ons OFF by default with a caution', async () => {
    serve(DEFAULTS)
    renderWithProviders(<AddOnSwitchesCard />)

    expect(await screen.findByRole('switch', { name: 'New add-on accounting' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Remove extra devices automatically' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Traffic add-ons until the reset' })).not.toBeChecked()
    expect(screen.getByText(/Keep it off for now/)).toBeInTheDocument()
    expect(screen.getAllByText('On by default')).toHaveLength(2)
    expect(screen.getAllByText('Off by default')).toHaveLength(1)
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
    const patch = serve(DEFAULTS)
    renderWithProviders(<AddOnSwitchesCard />)

    await user.click(await screen.findByRole('switch', { name: 'Traffic add-ons until the reset' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/admin/add-on-settings', { trafficResetExpiry: true })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
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
