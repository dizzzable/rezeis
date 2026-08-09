/**
 * Bundle-chunking contract (vite.config.ts → build.rollupOptions.output.manualChunks).
 *
 * Every rule pinned here exists because a misrouted vendor package once made
 * the *login route* download something it has no use for. The eager payload
 * of `/sign-in` is whatever the entry chunk statically imports, so a single
 * wrong bucket costs hundreds of kilobytes before the operator can type a
 * password:
 *
 *   • zustand had no rule of its own → rolldown folded it into `vendor-three`
 *     → `lib/admin-session.ts` (eager) dragged 950 KB of three.js onto login.
 *   • `id.includes('/react/')` also matched `@xyflow/react` and
 *     `@number-flow/react` → React Flow landed in the always-preloaded
 *     `vendor-react` instead of the lazy bot-map page.
 *   • a `vendor-charts` group merged recharts/d3 with the React copy that
 *     recharts pulls through CJS interop → the entry bound two React imports
 *     to that chunk and preloaded 449 KB of charting on login.
 *
 * These are pure-function assertions: they do not prove the emitted graph,
 * they prove the routing decision that produced it — and the third bug above
 * is proof that the two can disagree: `manualChunks` returned 'vendor-react'
 * for `node_modules/react/index.js`, the right answer, and rolldown put React
 * in `vendor-charts` anyway. Nothing here could have caught that.
 *
 * The emitted graph is guarded separately by `scripts/check-build-graph.mjs`
 * (`npm run check:build-graph`), which runs in CI right after the build and
 * fails if the login route's static-import closure contains three.js or
 * recharts/d3 — matched by library content, not by chunk name — or exceeds
 * its byte/chunk budget. Keep both: this file catches a bad rule, that one
 * catches a bad bundle.
 */
import { describe, expect, it } from 'vitest'

import viteConfig from '../vite.config'

type ManualChunks = (id: string) => string | undefined

const output = (viteConfig.build?.rollupOptions?.output ?? {}) as {
  manualChunks?: ManualChunks
}
const manualChunks = output.manualChunks as ManualChunks

/** Absolute ids as rolldown reports them (posix, always via node_modules). */
const NM = 'V:/repo/rezeis-admin/web/node_modules/'

describe('manualChunks', () => {
  it('is configured', () => {
    expect(typeof manualChunks).toBe('function')
  })

  it('gives the state layer its own chunk instead of leaking into vendor-three', () => {
    expect(manualChunks(`${NM}zustand/esm/react.mjs`)).toBe('vendor-state')
    expect(manualChunks(`${NM}zustand/esm/middleware.mjs`)).toBe('vendor-state')
    expect(manualChunks(`${NM}use-sync-external-store/shim/index.js`)).toBe('vendor-state')
    // Nested copies (React Flow ships its own zustand) must land here too —
    // a duplicate few KB is far cheaper than another accidental 3D pull.
    expect(manualChunks(`${NM}@xyflow/react/node_modules/zustand/esm/vanilla.mjs`)).toBe(
      'vendor-state',
    )
  })

  it('keeps the whole 3D stack in the lazy vendor-three chunk', () => {
    expect(manualChunks(`${NM}three/build/three.core.js`)).toBe('vendor-three')
    expect(manualChunks(`${NM}@react-three/fiber/dist/index.js`)).toBe('vendor-three')
    expect(manualChunks(`${NM}@react-three/drei/core/index.js`)).toBe('vendor-three')
    expect(manualChunks(`${NM}postprocessing/dist/index.js`)).toBe('vendor-three')
  })

  it('keeps ogl — the DEFAULT background — out of vendor-three', () => {
    // liquidChrome is the shipped default. Bucketing its ~58 KB renderer with
    // three.js would mean switching it on costs 950 KB instead.
    expect(manualChunks(`${NM}ogl/src/index.js`)).toBe('vendor-ogl')
  })

  it('ASKS for React core, react-dom, scheduler and the router in vendor-react', () => {
    // Read the verb: this is the answer the decision function gives, not the
    // chunk React ships in. Measured on the emitted graph, `react/index.js`
    // and `react/jsx-runtime.js` land in `vendor-data` (React reaches it
    // through react-query's CJS interop) while the chunk actually NAMED
    // `vendor-react` carries react-dom, scheduler and react-router. Same
    // "right answer, wrong bundle" shape as the `vendor-charts` bug in the
    // header above — this time with no cost, because `vendor-data` is eager
    // and there is exactly one copy.
    //
    // The property that matters — one React, on the render-blocking graph —
    // is asserted where it is observable: `scripts/check-build-graph.mjs`,
    // EAGER_SINGLETONS. Do not "strengthen" this file by asserting the
    // emitted chunk name; it cannot see one.
    expect(manualChunks(`${NM}react/index.js`)).toBe('vendor-react')
    expect(manualChunks(`${NM}react/jsx-runtime.js`)).toBe('vendor-react')
    expect(manualChunks(`${NM}react-dom/client.js`)).toBe('vendor-react')
    expect(manualChunks(`${NM}scheduler/index.js`)).toBe('vendor-react')
    expect(manualChunks(`${NM}react-router/dist/production/index.js`)).toBe('vendor-react')
  })

  it('does not mistake scoped packages named "react" for React itself', () => {
    expect(manualChunks(`${NM}@xyflow/react/dist/esm/index.js`)).not.toBe('vendor-react')
    expect(manualChunks(`${NM}@number-flow/react/dist/index.mjs`)).not.toBe('vendor-react')
    expect(manualChunks(`${NM}@floating-ui/react-dom/dist/floating-ui.react-dom.mjs`)).not.toBe(
      'vendor-react',
    )
  })

  it('leaves chart libraries unassigned so they stay off the entry graph', () => {
    // Deliberate absence of a `vendor-charts` group — see the comment in
    // vite.config.ts. Grouping them put a 449 KB modulepreload on /sign-in.
    expect(manualChunks(`${NM}recharts/es6/chart/AreaChart.js`)).toBeUndefined()
    expect(manualChunks(`${NM}d3-shape/src/index.js`)).toBeUndefined()
    expect(manualChunks(`${NM}d3-scale/src/index.js`)).toBeUndefined()
    expect(manualChunks(`${NM}victory-vendor/d3-scale.js`)).toBeUndefined()
  })

  it('leaves first-party sources to rolldown (route-level splitting)', () => {
    expect(manualChunks('V:/repo/rezeis-admin/web/src/features/auth/sign-in-page.tsx')).toBeUndefined()
  })
})
