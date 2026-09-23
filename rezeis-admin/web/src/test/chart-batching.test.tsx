/**
 * The wait `setup-tests.ts` puts after the last test of a file that drew a
 * chart, and how it knows the file drew one.
 *
 * The first case is the mechanism itself, measured on a real Recharts chart
 * rather than read from Redux Toolkit's source: frames that never come, the
 * fallback timers that deliver the notifications instead, and a wait that
 * outlasts every one of them. If a Redux Toolkit or Recharts upgrade ever
 * leaves a notification pending for longer, it fails here — not as eight
 * unhandled errors on a CI runner.
 */
import type { JSX } from 'react'
import { render, waitFor } from '@testing-library/react'
import { Pie, PieChart } from 'recharts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { outliveChartBatching, watchForCharts } from './chart-batching'

/** A chart that never animates, so every frame it asks for is its store's batching. */
function Ring(): JSX.Element {
  return (
    <PieChart width={100} height={100}>
      <Pie data={[{ value: 1 }]} dataKey="value" isAnimationActive={false} />
    </PieChart>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a chart whose animation frames never come', () => {
  it('leaves notifications pending when it is unmounted, and the wait outlasts every one of them', async () => {
    const requested: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => requested.push(frame))
    const cancelled = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelled)

    const { unmount } = render(<Ring />)
    await outliveChartBatching()
    // Each notification went out on its fallback, which cancels the frame it beat.
    expect(requested.length).toBeGreaterThan(0)
    expect(cancelled).toHaveBeenCalledTimes(requested.length)

    const beforeUnmount = requested.length
    unmount()
    // Unmounting queues more — what a file's last cleanup leaves behind.
    expect(requested.length).toBeGreaterThan(beforeUnmount)
    expect(cancelled).toHaveBeenCalledTimes(beforeUnmount)

    await outliveChartBatching()
    expect(cancelled).toHaveBeenCalledTimes(requested.length)
  })
})

describe('watchForCharts', () => {
  it('notices a chart drawn anywhere under the root', async () => {
    const charts = watchForCharts(document.body)
    render(
      <section>
        <Ring />
      </section>,
    )
    await waitFor(() => expect(charts.drewChart()).toBe(true))
    charts.stop()
  })

  it('notices a chart that is gone again before the observer reports', async () => {
    const charts = watchForCharts(document.body)
    const { unmount } = render(<Ring />)
    unmount()
    await waitFor(() => expect(charts.drewChart()).toBe(true))
    charts.stop()
  })

  it('does not take a page without a chart for one', async () => {
    const charts = watchForCharts(document.body)
    render(
      <div>
        <svg role="img" aria-label="not a chart" />
      </div>,
    )
    // Let the observer report whatever it saw.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(charts.drewChart()).toBe(false)
    charts.stop()
  })
})
