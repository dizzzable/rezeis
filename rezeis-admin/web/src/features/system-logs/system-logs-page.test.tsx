import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import SystemLogsPage from './system-logs-page'
import {
  clearSystemLogs,
  getSystemLogLevel,
  listSystemLogs,
  setSystemLogLevel,
} from './system-logs-api'

vi.mock('./system-logs-api', () => ({
  clearSystemLogs: vi.fn(),
  getSystemLogLevel: vi.fn(),
  listSystemLogs: vi.fn(),
  setSystemLogLevel: vi.fn(),
}))

describe('SystemLogsPage accessibility', () => {
  beforeEach(() => {
    vi.mocked(getSystemLogLevel).mockResolvedValue({ level: 'log' })
    vi.mocked(listSystemLogs).mockResolvedValue({ entries: [], latestId: 0 })
    vi.mocked(setSystemLogLevel).mockResolvedValue({ level: 'log' })
    vi.mocked(clearSystemLogs).mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('uses an accessible alert dialog before clearing the log buffer', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderWithProviders(<SystemLogsPage />)

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Clear system logs?' })
    expect(dialog).toHaveTextContent('Clear the in-memory log buffer? Already-streamed lines stay.')

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(clearSystemLogs).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clear' }))

    await waitFor(() => expect(clearSystemLogs).toHaveBeenCalledTimes(1))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('gives compact log-level button groups programmatic names', async () => {
    renderWithProviders(<SystemLogsPage />)

    const activeLevelGroup = screen.getByRole('group', { name: 'Active level' })
    expect(within(activeLevelGroup).getByRole('button', { name: 'error' })).toBeInTheDocument()

    const filterGroup = screen.getByRole('group', { name: 'Filter' })
    expect(within(filterGroup).getByRole('button', { name: 'ALL' })).toBeInTheDocument()
  })
})
