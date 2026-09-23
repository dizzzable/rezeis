import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'
import { afterAll } from 'vitest'

import { outliveChartBatching, watchForCharts } from './chart-batching'

// ── The wait budget every `findBy*` and `waitFor` in this suite races ───────
//
// `vite.config.ts` already decided that waits in this suite need room under
// worker contention: it raised vitest's own `testTimeout` to 15s because
// "jsdom + Recharts/userEvent heavy specs occasionally exceed the 5s default
// under parallel worker contention (they finish in ~2s in isolation)". That
// decision was only half applied. `testTimeout` bounds the WHOLE test;
// testing-library keeps a separate budget for a single async query, and it
// was still the library default of 1000ms. So every wait in the suite gave up
// at one second no matter what the test timeout said, and the two knobs
// disagreed about the same machine.
//
// That gap is what makes contended runs randomly red. The same config file
// records it happening for real on the hosted runner — "referral-eligible-
// plans-catalog, branding, payments-tab-permissions and quick-search-overlay
// all blew their `waitFor`" — and it recurred here on 28.08.2026 in
// `quick-search-overlay`, twice in three full runs taken minutes after a
// five-minute backend suite, then six green runs once the machine settled.
//
// HOW WIDE the exposure is was measured rather than guessed: setting this to
// 1ms and running the full suite fails 486 tests across 79 of 225 files.
// Those are the tests whose assertion cannot be satisfied on the first
// synchronous check — a third of the suite's files were racing that one
// second. Fixing the assertion that happened to lose is fixing one file of
// seventy-nine.
//
// WHY 5000 and not the 15s test timeout: on a green run this costs exactly
// nothing — a wait returns the moment its element appears, so the budget is
// only ever spent by a test that is already failing. What it buys there is
// the error message. Below `testTimeout`, a blown wait fails as
// testing-library's "Unable to find an element with the text: X" plus a DOM
// dump; at or above it, vitest kills the test first and all you get is "test
// timed out". 5s clears the ~2s contended render the config observed by a
// wide margin and still leaves 10s of headroom, enough for a test with two
// sequential waits to fail with the useful message. A test with three would
// hit the test timeout on the last one — rare, and the honest trade.
//
// This does NOT weaken a guard. A component that never renders the element
// still fails; it fails five seconds later.
configure({ asyncUtilTimeout: 5000 })

// ── No spec may reach the network ───────────────────────────────────────────
//
// jsdom resolves a relative request URL against its own origin, and vitest
// sets that origin to http://localhost:3000 — the exact address
// `server.proxy['/api']` in vite.config.ts points at the admin backend. Six
// spec files render pages whose queries are never mocked (dashboard
// system-health + activity feed, plan squads, fraud partners, admin-shell
// support-ticket stats, advertising remnawave version, appearance icons), so
// a suite run fired 38 real HTTP requests at whatever was listening there.
//
// On a clean machine nothing answers and every one of them fails, which is
// the behaviour the assertions were written against. On a developer machine
// with the backend up, the same specs consume real responses instead:
// measured against a server on :3000 returning `{}`, three tests fail and two
// uncaught TypeErrors escape (`squads.map is not a function`,
// `events.map is not a function`, `(customIcons ?? []).map is not a
// function`). Whether the suite passes depended on a process outside it.
//
// So the transport is removed. Every XHR settles the way a refused
// connection settles — readyState DONE, `error`, `loadend` — which is byte
// for byte what those specs already observe on a clean machine, and no
// longer depends on port 3000. A spec that wants a real response still gets
// one the normal way: by mocking its API module (`vi.spyOn(api, 'get')`) or
// its own XMLHttpRequest, neither of which reaches this transport.
//
// `fetch` needs no equivalent guard: every call site in `src/` passes a
// relative URL, and Node's global fetch rejects those locally without
// opening a socket.
window.XMLHttpRequest.prototype.send = function blockedSend(this: XMLHttpRequest): void {
  setTimeout(() => {
    try {
      // jsdom exposes readyState as a prototype getter; shadow it so a
      // listener that checks for DONE sees a finished request.
      Object.defineProperty(this, 'readyState', { value: 4, configurable: true })
    } catch {
      /* leave jsdom's value alone if it refuses to be shadowed */
    }
    this.dispatchEvent(new window.ProgressEvent('readystatechange'))
    this.dispatchEvent(new window.ProgressEvent('error'))
    this.dispatchEvent(new window.ProgressEvent('loadend'))
  }, 0)
}

// Mock window.matchMedia for components that use media queries (e.g. CountUp)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

// Mock IntersectionObserver for components using whileInView (framer-motion).
// jsdom does not implement it, so we provide a minimal stub.
class IntersectionObserverMock {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: ReadonlyArray<number> = []
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: IntersectionObserverMock,
})
Object.defineProperty(globalThis, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: IntersectionObserverMock,
})

// Mock ResizeObserver — also missing in jsdom and used by Recharts
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: ResizeObserverMock,
})
Object.defineProperty(globalThis, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: ResizeObserverMock,
})

// Pointer-capture and scroll-into-view, which jsdom does not implement.
//
// Radix's Select calls `hasPointerCapture` on the trigger during its own
// pointer-down handling, so without these an unhandled TypeError is thrown
// out of a React event handler before any assertion runs — a failure that
// reads as a broken component rather than as a missing DOM API.
//
// Shared rather than per-file: it started life inside
// `features/fraud/detector-accuracy.test.tsx` when that was the only test
// driving a Select, and a second one arrived with the blocklist screen.
const elementProto = window.Element.prototype as unknown as Record<string, unknown>;
elementProto.hasPointerCapture ??= (): boolean => false;
elementProto.setPointerCapture ??= (): void => {};
elementProto.releasePointerCapture ??= (): void => {};
elementProto.scrollIntoView ??= (): void => {};

// ── The two animation-frame globals, so REMOVING a stub cannot remove them ──
//
// Where jsdom does not define `requestAnimationFrame`/`cancelAnimationFrame`,
// a test that stubs them with `vi.stubGlobal` and then calls
// `vi.unstubAllGlobals()` in its `afterEach` does not restore them — it
// DELETES them, because there was nothing there before. Anything that
// cancels a pending frame while unmounting afterwards (Recharts, CountUp, the
// surface-usage rings) then throws `ReferenceError: cancelAnimationFrame is
// not defined` out of a cleanup, where no assertion can see it: vitest counts
// it as an unhandled error and fails the whole run with every test green.
//
// Defined here, the stub has something to restore TO. `??=` so an environment
// that does provide them keeps its own — and this one does: vitest builds
// jsdom with `pretendToBeVisual`, here and in CI alike, so both lines below
// keep jsdom's. The eight CI errors this block was written against (4f05e2cc)
// came back on 23.09.2026 with it in place; their cause is the next section.
const frameGlobals = globalThis as unknown as Record<string, unknown>;
frameGlobals['requestAnimationFrame'] ??= (frame: FrameRequestCallback): number =>
  setTimeout(() => frame(Date.now()), 0) as unknown as number;
frameGlobals['cancelAnimationFrame'] ??= (handle: number): void => {
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

// ── A chart's last notification has to land before the DOM globals go ───────
//
// Recharts 3 keeps each chart's state in its own Redux Toolkit store, built
// with `autoBatchEnhancer({ type: 'raf' })` — twice over, since RTK's default
// enhancers already carry one and Recharts appends its own. A pie, a legend
// row or a layer registering or unregistering is a batched action, and for
// each batch the enhancer queues its notification on `requestAnimationFrame`
// AND on a 100 ms `setTimeout`, whichever fires first; the winner calls the
// bare global `cancelAnimationFrame` on the other (`createRafWithFallbackTimer`
// in @reduxjs/toolkit 2.12).
//
// The frame belongs to jsdom; the fallback is a Node timer. When a file ends,
// vitest's teardown closes the jsdom window, so the frame never comes, and
// deletes every global it copied from it, `cancelAnimationFrame` included. A
// fallback still pending then fires into a process without that global and
// throws `ReferenceError: cancelAnimationFrame is not defined` outside every
// test. If another file is still running, vitest counts it against this one
// and fails the run with every test green.
//
// It takes a worker that outlives its teardown by the rest of those 100 ms —
// a loaded CI runner's does, this machine's does not. «Web quality» failed
// that way on 21.09.2026 and on 23.09.2026, both times with eight errors from
// `surface-usage-card.test.tsx`. That file queues frames by hand, so there the
// fallback is the ONLY way a chart is ever notified, and the cleanup after its
// last test unmounts four rings: four stores, two enhancers each, eight
// fallbacks. Reproduced before it was fixed: with a teardown held open 250 ms
// and a second file keeping the run alive, the file failed with those eight
// errors three times out of three.
//
// So a file that drew a chart waits out the fallback after its last test.
// Testing Library has unmounted everything by then, so nothing can queue a
// new one, and every fallback already queued fires while the globals are
// still there. Files that never drew one do not wait.
const charts = watchForCharts(document.documentElement)
afterAll(async () => {
  charts.stop()
  if (charts.drewChart()) await outliveChartBatching()
})
