import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import { UserExportDialog } from './user-export-dialog'
import { getUserExportCatalog } from './user-export-api'
import { downloadCsv } from '@/features/partners/csv-download'

vi.mock('./user-export-api', async (importOriginal) => {
  // The pure helpers are the thing under test alongside the dialog; only the
  // request is faked.
  const actual = await importOriginal<typeof import('./user-export-api')>()
  return { ...actual, getUserExportCatalog: vi.fn() }
})
vi.mock('@/features/partners/csv-download', () => ({ downloadCsv: vi.fn() }))

/**
 * The dialog an operator actually presses.
 *
 * `user-export.spec.ts` on the server proves what comes out of the file;
 * `user-export-labels.test.ts` proves every column has a name. This proves the
 * three things only the dialog can get wrong: that it starts with everything
 * ticked, that a column an admin may not have is shown LOCKED rather than
 * hidden, and that the filters the operator was looking at travel with the
 * download.
 */

const CATALOG = {
  columns: [
    { id: 'reiwa_id', group: 'identity', source: 'user', elevated: false },
    { id: 'username', group: 'identity', source: 'user', elevated: false },
    { id: 'subscription_expires_at', group: 'subscription', source: 'subscription', elevated: false },
    { id: 'device_apps', group: 'devices', source: 'panel', elevated: false },
    { id: 'registration_ip', group: 'registration', source: 'user', elevated: true },
  ],
  allowElevated: true,
}

function paramsOf(): Record<string, string> {
  const call = vi.mocked(downloadCsv).mock.calls[0]?.[0]
  return (call?.params ?? {}) as Record<string, string>
}

describe('the user export dialog', () => {
  beforeEach(() => {
    vi.mocked(getUserExportCatalog).mockResolvedValue(CATALOG as never)
    vi.mocked(downloadCsv).mockResolvedValue({ truncated: false, rowCount: 12 })
    window.history.replaceState({}, '', '/users')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('opens with every column ticked', async () => {
    // The common case is a full dump. Pressing Export straight away has to be
    // the whole base, or the default silently narrows what an operator thinks
    // they exported.
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)

    await waitFor(() => expect(screen.getByText('5 of 5 columns selected')).toBeInTheDocument())
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).toBeChecked()
    }
  })

  it('sends the ticked columns and nothing else', async () => {
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)
    await waitFor(() => expect(screen.getByText('5 of 5 columns selected')).toBeInTheDocument())

    await userEvent.click(screen.getByLabelText(/Username/))
    await userEvent.click(screen.getByTestId('export-users-confirm'))

    await waitFor(() => expect(downloadCsv).toHaveBeenCalled())
    const columns = paramsOf().columns.split(',')
    expect(columns).toContain('reiwa_id')
    expect(columns).not.toContain('username')
  })

  it('carries the list filters the operator was looking at', async () => {
    // The whole point of "export what I see". The list keeps its filters in the
    // URL, so a second filter UI here would be a second population that agrees
    // most of the time — noticed only when a campaign reaches the wrong people.
    window.history.replaceState({}, '', '/users?subscriptionStatuses=ACTIVE&isBlocked=false&tab=list')
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)
    await waitFor(() => expect(screen.getByText('5 of 5 columns selected')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('export-users-confirm'))

    await waitFor(() => expect(downloadCsv).toHaveBeenCalled())
    const params = paramsOf()
    expect(params.subscriptionStatuses).toBe('ACTIVE')
    expect(params.isBlocked).toBe('false')
    // `tab` is the panel's own URL state, not a filter — sending it would have
    // the server refuse or ignore an unknown query key for no reason.
    expect(params.tab).toBeUndefined()
  })

  it('sends no query parameter the export contract does not declare', async () => {
    // THE 400 THAT LOSES THE WHOLE EXPORT. The endpoint validates with
    // `forbidNonWhitelisted`, so one undeclared key is a Bad Request over a
    // request that is otherwise perfectly good — and the operator sees a failed
    // download with nothing naming the parameter to blame. A campaign link, a
    // stale bookmark, or the page's own `tab` is all it takes.
    window.history.replaceState(
      {},
      '',
      '/users?roles=USER&utm_source=newsletter&fbclid=abc123&tab=list&somethingNew=1',
    )
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)
    await waitFor(() => expect(screen.getByText('5 of 5 columns selected')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('export-users-confirm'))

    await waitFor(() => expect(downloadCsv).toHaveBeenCalled())
    const params = paramsOf()
    expect(params.roles).toBe('USER')
    expect(Object.keys(params).sort()).toEqual(['columns', 'roles'])
  })

  it('carries the search box across, because the export is what the list shows', async () => {
    // `search` is the one export parameter the filter object does not hold, so
    // it is read across by hand — and a hand-written line is exactly the kind
    // that gets dropped when the loop around it is replaced.
    window.history.replaceState({}, '', '/users?search=%20dizzable%20&utm_campaign=x')
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)
    await waitFor(() => expect(screen.getByText('5 of 5 columns selected')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('export-users-confirm'))

    await waitFor(() => expect(downloadCsv).toHaveBeenCalled())
    expect(paramsOf().search).toBe('dizzable')
    expect(paramsOf().utm_campaign).toBeUndefined()
  })

  it('warns before a device column makes the export slow', async () => {
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)

    await waitFor(() => expect(screen.getByText(/Remnawave panel/)).toBeInTheDocument())
  })

  it('drops the warning once no device column is picked', async () => {
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)
    await waitFor(() => expect(screen.getByText(/Remnawave panel/)).toBeInTheDocument())

    await userEvent.click(screen.getByLabelText(/Client app/))

    await waitFor(() => expect(screen.queryByText(/Remnawave panel/)).not.toBeInTheDocument())
  })
})

describe('an export that stopped at the row ceiling', () => {
  /**
   * THE FILE ON DISK IS SHORT AND NOTHING SAID SO.
   *
   * The server has set `X-Export-Truncated` since the export shipped, and the
   * download helper threw the whole response away the moment the blob was
   * built — so the header travelled the wire and was read by nobody. An
   * operator exporting a base of 60 000 got the oldest 20 000, a green toast,
   * and a closed dialog.
   */

  beforeEach(() => {
    vi.mocked(getUserExportCatalog).mockResolvedValue(CATALOG as never)
    vi.mocked(downloadCsv).mockResolvedValue({ truncated: true, rowCount: 20000 })
    window.history.replaceState({}, '', '/users')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('tells the operator the file is incomplete, and how many rows it holds', async () => {
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)
    await waitFor(() => expect(screen.getByText('5 of 5 columns selected')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('export-users-confirm'))

    const notice = await screen.findByTestId('export-truncated')
    // The count matters as much as the warning: "incomplete" alone does not
    // tell an operator whether they are missing ten customers or forty
    // thousand. Matched loosely because the number is localised — `20,000` in
    // English, `20 000` with a non-breaking space in Russian.
    expect(notice.textContent ?? '').toMatch(/20[^\d]?000/)
    // And it is not the raw key path, which is how a missing translation
    // reaches the screen in this app.
    expect(notice.textContent ?? '').not.toMatch(/usersPage\.export\./)
  })

  it('keeps the dialog open so the warning cannot be missed', async () => {
    // A toast is gone in four seconds. "The spreadsheet you just saved is
    // missing customers" has to still be readable while the operator decides
    // what to do — and what to do is narrow the list behind this dialog.
    const onOpenChange = vi.fn()
    renderWithProviders(<UserExportDialog open onOpenChange={onOpenChange} />)
    await waitFor(() => expect(screen.getByText('5 of 5 columns selected')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('export-users-confirm'))

    await screen.findByTestId('export-truncated')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('says nothing when the file is whole', async () => {
    // Otherwise the warning is decoration: an alert that is always there is an
    // alert nobody reads.
    vi.mocked(downloadCsv).mockResolvedValue({ truncated: false, rowCount: 12 })
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)
    await waitFor(() => expect(screen.getByText('5 of 5 columns selected')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('export-users-confirm'))

    await waitFor(() => expect(downloadCsv).toHaveBeenCalled())
    expect(screen.queryByTestId('export-truncated')).not.toBeInTheDocument()
  })
})

describe('a column this admin may not have', () => {
  beforeEach(() => {
    vi.mocked(getUserExportCatalog).mockResolvedValue({
      ...CATALOG,
      allowElevated: false,
    } as never)
    vi.mocked(downloadCsv).mockResolvedValue({ truncated: false, rowCount: 12 })
    window.history.replaceState({}, '', '/users')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('is shown locked rather than hidden', async () => {
    // An operator who cannot SEE a column cannot ask for the permission that
    // would give it to them. Hiding it turns a permission boundary into a
    // feature nobody knows exists.
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)

    await waitFor(() => expect(screen.getByLabelText(/Registration IP/)).toBeInTheDocument())
    expect(screen.getByLabelText(/Registration IP/)).toBeDisabled()
  })

  it('is not ticked, and is not counted as chosen', async () => {
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)

    await waitFor(() => expect(screen.getByText('4 of 5 columns selected')).toBeInTheDocument())
    expect(screen.getByLabelText(/Registration IP/)).not.toBeChecked()
  })

  it('is not added by "select all" either', async () => {
    // Otherwise the group control adds a column the server refuses the whole
    // export over — a 403 from a button that looked like a convenience.
    renderWithProviders(<UserExportDialog open onOpenChange={() => undefined} />)
    await waitFor(() => expect(screen.getByText('4 of 5 columns selected')).toBeInTheDocument())

    const registrationGroup = screen.getByText('Registration snapshot').closest('div')
    const selectAll = registrationGroup?.querySelector('button')
    await userEvent.click(selectAll as HTMLElement)

    expect(screen.getByText('4 of 5 columns selected')).toBeInTheDocument()
  })
})
