import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import { DetectorAccuracyPanel } from './detector-accuracy'
import { getDetectorAccuracy, type DetectorAccuracyReport } from './fraud-api'

vi.mock('./fraud-api', () => ({
  getDetectorAccuracy: vi.fn(),
}))

/**
 * The panel that closes the tuning loop: per detector code, how much of its
 * output an operator threw away as a false positive.
 *
 * The two things that would make it actively harmful are the two things tested
 * hardest here — showing a percentage derived from a handful of verdicts, and
 * letting a reader confuse "nobody has dismissed this" with "we cannot say
 * yet". Both would send somebody to change a threshold on nothing.
 */

function report(rows: DetectorAccuracyReport['rows']): DetectorAccuracyReport {
  return {
    windowDays: 30,
    since: '2026-05-19T12:00:00.000Z',
    until: '2026-06-18T12:00:00.000Z',
    minAdjudicatedForRate: 10,
    rows,
  }
}

const NOISY = {
  code: 'SUBSCRIPTION_SHARING_IP',
  total: 140,
  open: 40,
  acknowledged: 10,
  resolved: 60,
  operatorResolved: 20,
  autoResolved: 40,
  dismissed: 30,
  systemDismissed: 0,
  adjudicated: 50,
  falsePositiveRate: 60,
}

const SPARSE = {
  code: 'RAPID_CHURN',
  total: 4,
  open: 1,
  acknowledged: 0,
  resolved: 2,
  operatorResolved: 1,
  autoResolved: 1,
  dismissed: 1,
  systemDismissed: 0,
  adjudicated: 2,
  falsePositiveRate: null,
}

const CLEAN = {
  code: 'PROMO_ABUSE',
  total: 30,
  open: 2,
  acknowledged: 0,
  resolved: 28,
  operatorResolved: 28,
  autoResolved: 0,
  dismissed: 0,
  systemDismissed: 0,
  adjudicated: 28,
  falsePositiveRate: 0,
}

describe('DetectorAccuracyPanel', () => {
  // Radix's Select drives itself with Pointer Events APIs jsdom does not
  // implement, so opening one throws `hasPointerCapture is not a function`
  // before any assertion runs. Now shimmed in the shared `setup-tests.ts`,
  // because a second screen drives a Select and a third copy is how a shim
  // starts drifting between files.

  beforeEach(() => {
    vi.mocked(getDetectorAccuracy).mockResolvedValue(report([NOISY, CLEAN, SPARSE]))
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lists each detector with its counts and rate', async () => {
    renderWithProviders(<DetectorAccuracyPanel />)

    const row = (await screen.findByText('SUBSCRIPTION_SHARING_IP')).closest('tr')
    expect(row).not.toBeNull()
    const cells = within(row as HTMLElement)
    expect(cells.getByText('140')).toBeInTheDocument()
    // Open + acknowledged: signals nobody has ruled on yet.
    expect(cells.getByText('50')).toBeInTheDocument()
    expect(cells.getByText('30')).toBeInTheDocument()
    expect(cells.getByText('60%')).toBeInTheDocument()
  })

  // The auto-close count is shown but visibly apart from the operator's, so a
  // reader cannot mistake "the detector stopped seeing it" for "a person agreed
  // it was real".
  it('shows operator resolutions separately from the detector’s own', async () => {
    renderWithProviders(<DetectorAccuracyPanel />)

    const row = (await screen.findByText('SUBSCRIPTION_SHARING_IP')).closest('tr')
    const cells = within(row as HTMLElement)
    expect(cells.getByText('20')).toBeInTheDocument()
    expect(cells.getByText('(+40)')).toBeInTheDocument()
  })

  // The requirement in one case: two data points must not become a percentage.
  it('says so instead of showing a rate computed from too few verdicts', async () => {
    renderWithProviders(<DetectorAccuracyPanel />)

    const row = (await screen.findByText('RAPID_CHURN')).closest('tr')
    const cells = within(row as HTMLElement)
    expect(cells.getByText('not enough data')).toBeInTheDocument()
    // 1 of 2 is 50%, and that number must appear nowhere on this row.
    expect(cells.queryByText('50%')).toBeNull()
    // The raw counts stay visible — a code nobody has ruled on is itself worth
    // knowing, and hiding the row would hide that.
    expect(cells.getByText('4')).toBeInTheDocument()
  })

  // `null` and `0` are different answers and must not render the same way.
  it('renders a genuinely clean detector as 0%, not as “not enough data”', async () => {
    renderWithProviders(<DetectorAccuracyPanel />)

    const row = (await screen.findByText('PROMO_ABUSE')).closest('tr')
    const cells = within(row as HTMLElement)
    expect(cells.getByText('0%')).toBeInTheDocument()
    expect(cells.queryByText('not enough data')).toBeNull()
  })

  it('re-reads the report when the window changes', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DetectorAccuracyPanel />)

    await screen.findByText('SUBSCRIPTION_SHARING_IP')
    expect(getDetectorAccuracy).toHaveBeenCalledWith(30)

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'Last 7 days' }))

    await waitFor(() => {
      expect(getDetectorAccuracy).toHaveBeenCalledWith(7)
    })
  })

  // An empty window is a real answer — no detector fired — and has to read as
  // one rather than as an empty table, which reads as a broken page.
  it('explains an empty window instead of rendering an empty table', async () => {
    vi.mocked(getDetectorAccuracy).mockResolvedValue(report([]))
    renderWithProviders(<DetectorAccuracyPanel />)

    expect(
      await screen.findByText('No detector raised a signal in the last 30 days.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('surfaces a failed read rather than showing an empty report', async () => {
    vi.mocked(getDetectorAccuracy).mockRejectedValue(new Error('boom'))
    renderWithProviders(<DetectorAccuracyPanel />)

    expect(
      await screen.findByText('Could not load the detector accuracy report.'),
    ).toBeInTheDocument()
  })

  // Read-only is a property of the surface, not an accident of what it happens
  // to render today. The window selector is the only control it may have.
  it('offers no control that could change a signal', async () => {
    renderWithProviders(<DetectorAccuracyPanel />)
    await screen.findByText('SUBSCRIPTION_SHARING_IP')

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
  })
})
