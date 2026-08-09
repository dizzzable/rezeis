import '@testing-library/jest-dom'

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
