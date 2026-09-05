import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { loadFeatureBundle } from '@/i18n/i18n'
import { usePermissionStore } from '@/features/rbac'
import { renderWithProviders } from '@/test/test-utils'
import { ConnectPageEditor } from './connect-page-editor'
import { connectPageApi, type ConnectPageConfig } from './connect-page-api'

/**
 * The editor's own behaviour, which nothing was checking.
 *
 * Its pure helpers had tests from the first day; the 970 lines that USE them had
 * none, in a panel that has more than a hundred component tests. Three of the
 * defects fixed alongside this file lived in exactly that gap — the refusal that
 * reached the screen as four words, the issue list that deleted itself at the
 * first keystroke, and an hour of work that a click on the side menu threw away
 * without a dialog. Every one of them is invisible to a test of a pure function
 * and obvious to a test that renders.
 */

vi.mock('./connect-page-api', async (importOriginal) => {
  // Only the network half is faked. `moveItem`, `shapeOf`, `slugify` and the
  // rest are the real ones: a fake of the arithmetic under test would make the
  // reorder assertions below agree with themselves and with nothing else.
  const actual = await importOriginal<typeof import('./connect-page-api')>()
  return {
    ...actual,
    connectPageApi: {
      get: vi.fn(),
      validate: vi.fn(),
      replace: vi.fn(),
    },
  }
})

const CONFIG: ConnectPageConfig = {
  version: 2,
  connectScreenEnabled: false,
  icons: {},
  platforms: [
    {
      id: 'ios',
      title: { ru: 'iOS', en: 'iOS' },
      iconKey: null,
      apps: [
        {
          id: 'happ',
          name: 'Happ',
          iconKey: null,
          featured: true,
          steps: [
            {
              title: { ru: 'Добавьте', en: 'Add' },
              body: null,
              iconKey: null,
              buttons: [{ kind: 'copyLink', label: { ru: 'Копировать', en: 'Copy' } }],
            },
          ],
        },
        {
          id: 'streisand',
          name: 'Streisand',
          iconKey: null,
          featured: false,
          steps: [],
        },
      ],
    },
  ],
}

function grant(tokens: readonly string[]): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(tokens),
    mustChangePassword: false,
    // Not 'DEV': that role short-circuits every check and would make the
    // read-only assertion pass no matter what is rendered.
    role: 'ADMIN',
    rbacRoleId: null,
    error: null,
  })
}

/** The shape the editor's `issuesFromError` reads out of a refusal. */
function refusal(issues: { path: string; message: string }[]): unknown {
  return { response: { data: { statusCode: 400, code: 'CONNECT_PAGE_CATALOG_INVALID', issues } } }
}

// The test i18n runs in English, so the labels below are the English ones.
beforeEach(async () => {
  await loadFeatureBundle('subpageConfig')
  grant(['subpage_config:view', 'subpage_config:edit'])
  vi.mocked(connectPageApi.get).mockResolvedValue({ config: CONFIG, stored: true, corrupted: null })
  vi.mocked(connectPageApi.validate).mockResolvedValue({ ok: true, issues: [] })
})

afterEach(() => {
  cleanup()
  usePermissionStore.getState().reset()
  vi.clearAllMocks()
})

describe('a refused save', () => {
  it('names the rows instead of saying only that it failed', async () => {
    // End to end on the client half of the fix: the server now forwards the
    // rows past the safe exception filter, and this is where they have to land.
    vi.mocked(connectPageApi.replace).mockRejectedValue(
      refusal([
        { path: 'platforms[0].apps[1]', message: 'has no way to hand over the subscription' },
        { path: 'platforms[0]', message: 'has no recommended app' },
      ]),
    )
    renderWithProviders(<ConnectPageEditor />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Save the catalog' }))

    expect(await screen.findByText('This catalog would not work')).toBeInTheDocument()
    expect(screen.getByText('platforms[0].apps[1]')).toBeInTheDocument()
    expect(screen.getByText('has no recommended app')).toBeInTheDocument()
  })

  it('keeps the list while a row is being typed into', async () => {
    // THE BUG. The list is a checklist — twelve rows, fixed one at a time — and
    // clearing it on every edit deleted the other eleven at the first character.
    vi.mocked(connectPageApi.replace).mockRejectedValue(
      refusal([{ path: 'platforms[0]', message: 'has no recommended app' }]),
    )
    renderWithProviders(<ConnectPageEditor />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Save the catalog' }))
    expect(await screen.findByText('has no recommended app')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /iPhone and iPad/ }))
    // The exact accessible name of the Russian box: the group around the two
    // boxes carries the bare label, and typing into a group does nothing.
    await user.type(await screen.findByLabelText('Platform name (ru)'), 'X')

    expect(screen.getByText('has no recommended app')).toBeInTheDocument()
  })

  it('keeps the list but says it may be stale once a row actually moves', async () => {
    // A reorder repoints every path after it, so the addresses can now be one
    // row out. Deleting the list over that would cost the operator every other
    // row; saying so costs them nothing and is checkable in one click.
    vi.mocked(connectPageApi.replace).mockRejectedValue(
      refusal([{ path: 'platforms[0].apps[1]', message: 'has no way to hand over the subscription' }]),
    )
    renderWithProviders(<ConnectPageEditor />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Save the catalog' }))
    expect(await screen.findByText(/has no way to hand over/)).toBeInTheDocument()
    expect(screen.queryByText(/paths on the left may have shifted/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /iPhone and iPad/ }))
    const up = await screen.findAllByRole('button', { name: 'Move up' })
    await user.click(up[up.length - 1]!)

    expect(await screen.findByText(/paths on the left may have shifted/)).toBeInTheDocument()
    expect(screen.getByText(/has no way to hand over/)).toBeInTheDocument()
  })

  it('does not cry stale over an edit that moves no row', async () => {
    // The app id is a free text field, and "Two apps share the id" is one of
    // the rows that sends an operator to it. Typing there shifts nothing.
    vi.mocked(connectPageApi.replace).mockRejectedValue(
      refusal([{ path: 'platforms[0].apps[0]', message: 'Two apps share the id "happ"' }]),
    )
    renderWithProviders(<ConnectPageEditor />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Save the catalog' }))
    expect(await screen.findByText(/Two apps share the id/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /iPhone and iPad/ }))
    await user.type(await screen.findByLabelText('Platform name (ru)'), 'X')

    expect(screen.getByText(/Two apps share the id/)).toBeInTheDocument()
    expect(screen.queryByText(/paths on the left may have shifted/)).not.toBeInTheDocument()
  })
})

describe('leaving with work that is not saved', () => {
  it('asks the browser to hold the tab once something has been edited', async () => {
    renderWithProviders(<ConnectPageEditor />)
    const user = userEvent.setup()

    // Nothing typed yet: leaving costs nothing and must not be interrupted.
    expect(fireBeforeUnload().defaultPrevented).toBe(false)

    await user.click(await screen.findByRole('button', { name: /iPhone and iPad/ }))
    // The exact accessible name of the Russian box: the group around the two
    // boxes carries the bare label, and typing into a group does nothing.
    await user.type(await screen.findByLabelText('Platform name (ru)'), 'X')

    expect(fireBeforeUnload().defaultPrevented).toBe(true)
  })

  it('stops asking once the save has been through', async () => {
    vi.mocked(connectPageApi.replace).mockResolvedValue({ config: CONFIG, cleanedIcons: {} })
    renderWithProviders(<ConnectPageEditor />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /iPhone and iPad/ }))
    // The exact accessible name of the Russian box: the group around the two
    // boxes carries the bare label, and typing into a group does nothing.
    await user.type(await screen.findByLabelText('Platform name (ru)'), 'X')
    await user.click(screen.getByRole('button', { name: 'Save the catalog' }))

    await waitFor(() => {
      expect(vi.mocked(connectPageApi.replace)).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(fireBeforeUnload().defaultPrevented).toBe(false)
    })
  })
})

describe('a background refetch that fails under a live draft', () => {
  it('leaves the editor and its guard on screen instead of an error card', async () => {
    // The save's own `invalidateQueries` is what refetches, so this path is
    // ordinary rather than exotic: save, refetch, 500. The draft is still in
    // state — replacing the editor with an error card would hide it AND
    // unmount the unsaved-changes guard, and the next click on the side menu
    // would take the work with it without a word.
    vi.mocked(connectPageApi.get)
      .mockReset()
      .mockResolvedValueOnce({ config: CONFIG, stored: true, corrupted: null })
      .mockRejectedValue(new Error('boom'))
    vi.mocked(connectPageApi.replace).mockResolvedValue({ config: CONFIG, cleanedIcons: {} })
    renderWithProviders(<ConnectPageEditor />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /iPhone and iPad/ }))
    await user.type(await screen.findByLabelText('Platform name (ru)'), 'X')
    await user.click(screen.getByRole('button', { name: 'Save the catalog' }))

    await waitFor(() => {
      expect(vi.mocked(connectPageApi.get).mock.calls.length).toBeGreaterThan(1)
    })

    expect(screen.queryByText('Could not load the catalog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save the catalog' })).toBeInTheDocument()

    // And the guard is still armed once the draft is dirty again.
    await user.type(await screen.findByLabelText('Platform name (ru)'), 'Y')
    expect(fireBeforeUnload().defaultPrevented).toBe(true)
  })
})

describe('a role that may look but not edit', () => {
  it('refuses in words and names the token, rather than hiding the page', async () => {
    grant(['subpage_config:view'])
    renderWithProviders(<ConnectPageEditor />)

    expect(await screen.findByText(/subpage_config:edit/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save the catalog' })).not.toBeInTheDocument()
  })
})

function fireBeforeUnload(): Event {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}
