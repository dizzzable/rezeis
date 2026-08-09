/**
 * A partial system-health payload must cost the operator that one section, not
 * the page.
 *
 * `SystemHealthResponse` types `vps` and `process` as required, but nothing
 * enforces it at runtime: `dashboard-api.ts` reads the response with a bare
 * `api.get<SystemHealthResponse>` cast and no schema parse. The same component
 * also renders reiwa's health, fetched from a separate service over the
 * network, where a version skew or a truncated reply is ordinary. Before this
 * guard, dereferencing a missing block threw inside render with no error
 * boundary above it, React unmounted the whole DashboardPage, and the operator
 * lost every widget because one metrics section was absent.
 *
 * These cases therefore assert the SURVIVING page, not just the absence of a
 * throw: a test that only caught the exception would still pass while the tree
 * came down around it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DashboardSystemHealth } from './dashboard-system-health'
import type { SystemHealthResponse } from './dashboard-api'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}))

const VPS = {
  cpuUsagePercent: 12,
  cpuCoreCount: 4,
  cpuModel: 'Test CPU',
  ramUsedBytes: 1_000_000,
  ramTotalBytes: 8_000_000,
  ramUsagePercent: 12.5,
  diskUsedBytes: 5_000_000,
  diskTotalBytes: 50_000_000,
  diskUsagePercent: 10,
  loadAverage: [0.1, 0.2, 0.3],
  uptimeSeconds: 3600,
  network: [{ rxBytes: 10, txBytes: 20 }],
}

const PROCESS = {
  cpuUsagePercent: 3,
  rssBytes: 400_000,
  heapUsedBytes: 200_000,
  heapTotalBytes: 300_000,
  eventLoopLagMs: 1,
  uptimeSeconds: 120,
}

/**
 * Drives the panel's OWN health (the default outer tab). `reiwaHealth` is the
 * other service's payload and is deliberately left null here — it renders in a
 * sibling tab that is not mounted, and it is the same `ServerHealth` component
 * either way.
 */
function renderHealth(health: unknown) {
  return render(
    <DashboardSystemHealth
      health={health as SystemHealthResponse}
      loading={false}
      reiwaHealth={null}
      reiwaLoading={false}
    />,
  )
}

/**
 * The tabs mount lazily: `<TabsContent value="process">` is not in the DOM
 * until its trigger is activated, so a test that only renders and asserts
 * never executes `ProcessMetrics` at all. The first version of this file did
 * exactly that — deleting the process guard entirely left all five cases
 * green. Every process-tab assertion must go through here.
 */
function openProcessTab(): void {
  const trigger = screen.getByRole('tab', {
    name: /dashboardPage\.systemHealth\.processTab/,
  })
  // Radix activates a trigger on mousedown, not click.
  fireEvent.mouseDown(trigger)

  // The helper checks itself: if activation ever stops working, every test
  // using it would go green while executing none of the code it targets —
  // which is precisely how the first version of this file passed with the
  // process guard deleted.
  expect(
    trigger.getAttribute('aria-selected'),
    'openProcessTab did not actually activate the tab, so nothing below it ' +
      'exercises ProcessMetrics',
  ).toBe('true')
}

describe('system health with a partial payload', () => {
  it('keeps the widget on screen when the VPS block is missing entirely', () => {
    renderHealth({ process: PROCESS })

    expect(
      screen.getByText('dashboardPage.systemHealth.vpsTab'),
      'the VPS tab is gone — a missing metrics block took the whole widget down ' +
        'with it, which is how the dashboard page used to unmount completely',
    ).toBeTruthy()
    expect(
      screen.getAllByText('dashboardPage.systemHealth.sectionUnavailable').length,
      'the missing block rendered nothing at all instead of saying it is unavailable',
    ).toBeGreaterThan(0)
  })

  it('keeps the process tab usable when the VPS block it borrows a total from is missing', () => {
    renderHealth({ process: PROCESS })
    openProcessTab()

    // The process tab reads `health.vps.ramTotalBytes` for "share of total".
    // It must degrade to the bare figure, not take a second tab down.
    expect(
      screen.getByText('dashboardPage.systemHealth.rss'),
      'the process tab is empty — it was brought down by the ABSENT sibling block, ' +
        'not by its own data, which is a second tab lost to one missing section',
    ).toBeTruthy()
    expect(
      screen.queryByText('dashboardPage.systemHealth.ofTotal', { exact: false }),
      'the share-of-total sublabel was rendered without a total to compute it from',
    ).toBeNull()
  })

  it('keeps the widget on screen when the process block is missing entirely', () => {
    renderHealth({ vps: VPS })
    openProcessTab()

    expect(
      screen.getByText('dashboardPage.systemHealth.vpsTab'),
      'a missing process block took the VPS tab down with it',
    ).toBeTruthy()
    expect(
      screen.getAllByText('dashboardPage.systemHealth.sectionUnavailable').length,
      'the process tab rendered nothing instead of saying its metrics are unavailable',
    ).toBeGreaterThan(0)
  })

  it('survives a payload that carries the VPS block but not its arrays', () => {
    renderHealth({ vps: { ...VPS, loadAverage: undefined, network: undefined }, process: PROCESS })

    expect(
      screen.getByText('dashboardPage.systemHealth.vpsTab'),
      'indexing loadAverage[0] / network[0] on a partial block threw just as hard ' +
        'as the missing block did',
    ).toBeTruthy()
  })

  it('still renders the real thing when the payload is complete', () => {
    renderHealth({ vps: VPS, process: PROCESS })

    expect(
      screen.queryByText('dashboardPage.systemHealth.sectionUnavailable'),
      'a complete payload was reported as unavailable — the guard is firing on ' +
        'good data, which would hide working metrics',
    ).toBeNull()
    expect(screen.getByText('Test CPU', { exact: false })).toBeTruthy()
  })
})
