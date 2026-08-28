import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'

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
