/**
 * What a Recharts chart leaves running after it is gone, and how long a test
 * file has to wait for it. `setup-tests.ts` explains why it has to.
 */
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * How long Redux Toolkit holds a batched notification whose animation frame
 * has not come before sending it anyway: `createRafWithFallbackTimer(
 * window.requestAnimationFrame, 100)` in @reduxjs/toolkit 2.12, behind the
 * `autoBatchEnhancer({ type: 'raf' })` every Recharts 3 chart store is built
 * with. `chart-batching.test.tsx` fails if a chart ever leaves a notification
 * pending past the wait below.
 */
export const RTK_RAF_FALLBACK_MS = 100

/**
 * Resolves once every fallback queued before the call has fired: Node runs
 * timers in order of expiry, and this one expires after all of them.
 *
 * `node:timers/promises` rather than the global `setTimeout`, so a file that
 * left fake timers installed cannot freeze the wait.
 */
export function outliveChartBatching(): Promise<void> {
  return sleep(RTK_RAF_FALLBACK_MS + 20)
}

const CHART = '.recharts-wrapper'

export interface ChartWatch {
  /** Whether a chart has been attached under the root since the watch began. */
  readonly drewChart: () => boolean
  readonly stop: () => void
}

/**
 * Notices the first Recharts chart attached anywhere under `root`. A chart
 * attached and taken out again before the observer reports still counts: the
 * node React inserted keeps its subtree after it is removed.
 */
export function watchForCharts(root: Node): ChartWatch {
  let drew = false
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches(CHART) || node.querySelector(CHART) !== null)) {
          drew = true
          observer.disconnect()
          return
        }
      }
    }
  })
  observer.observe(root, { childList: true, subtree: true })
  return { drewChart: () => drew, stop: () => observer.disconnect() }
}
