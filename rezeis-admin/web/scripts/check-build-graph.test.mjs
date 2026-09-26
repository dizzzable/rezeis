/**
 * Unit tests for the build-graph guard's LOGIC.
 *
 * Deliberately fixture-driven and build-free. The guard's real assertion needs
 * a real `dist/` and runs in CI right after the build step (and locally via
 * `npm run check:build-graph`); wiring that into `npm test` would either make
 * the suite build the app or make it read whatever stale `dist/` happens to be
 * lying around. What IS worth testing under `npm test` is everything that can
 * be wrong about the guard itself: HTML parsing, dynamic-vs-static import
 * discrimination, graph walking, detection, and — above all — that the failure
 * messages actually name the chunk, the size and the rule.
 *
 * The one thing these tests intentionally do NOT do is assert that the marker
 * strings still match the real libraries. Fixtures built out of the same
 * constants they check would be circular. That job belongs to the guard's own
 * `marker-liveness` rule, which runs against the real dist/ and fails when a
 * marker set matches nothing at all.
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ADMIN_SHELL_WARMUP,
  DENIED_BUNDLES,
  EAGER_BYTE_BUDGET,
  EAGER_CHUNK_BUDGET,
  EAGER_SINGLETONS,
  RENDER_BLOCKING_LOCALE,
  auditDist,
  evaluate,
  findDynamicImports,
  formatReport,
  inspectChunk,
  isRelativeSpecifier,
  parseDynamicImportSpecifiers,
  parseHtmlAssetRefs,
  parseStaticImportSpecifiers,
  selectRenderBlockingChunks,
  sourceAtOffset,
  walkEagerGraph,
} from './check-build-graph.mjs'

const three = DENIED_BUNDLES.find((b) => b.id === 'three')
const charts = DENIED_BUNDLES.find((b) => b.id === 'charts')

/**
 * A dist/ report shaped like `auditDist` returns, without touching disk.
 *
 * `renderBlocking` and `sourcemapped` default to "the audit was complete" so
 * that a test about one rule is not also a test about the other two. The
 * incomplete-audit cases pass them explicitly.
 */
function report({
  eager = [],
  liveness,
  singletons,
  stylesheetBytes = 0,
  renderBlocking = ['assets/ru-AAA.js'],
  sourcemapped = 1,
} = {}) {
  const chunks = eager.map((chunk) => ({
    declared: true,
    hits: [],
    renderBlocking: false,
    ...chunk,
  }))
  return {
    distDir: '/repo/web/dist',
    eager: chunks,
    liveness: liveness ?? new Map(DENIED_BUNDLES.map((b) => [b.id, [`assets/${b.id}-lazy.js`]])),
    // Default: one copy, on an audited chunk — i.e. the singleton rules have
    // nothing to say, so a test about some other rule stays about that rule.
    singletons:
      singletons ?? new Map(EAGER_SINGLETONS.map((s) => [s.id, [chunks[0]?.rel ?? 'assets/x.js']])),
    stylesheetBytes,
    localeConsidered: renderBlocking,
    renderBlocking,
    sourcemapped,
    totalBytes: chunks.reduce((sum, c) => sum + c.bytes, 0),
    undeclared: chunks.filter((c) => !c.declared && !c.renderBlocking).map((c) => c.rel),
  }
}

describe('parseHtmlAssetRefs', () => {
  const html = `<!doctype html><html><head>
    <script type="module" crossorigin src="/assets/index-AAA.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-react-BBB.js">
    <link crossorigin rel="modulepreload" href="/assets/vendor-data-CCC.js">
    <link rel="stylesheet" crossorigin href="/assets/index-DDD.css">
    <link rel="icon" type="image/svg+xml" href="/rezeis-logo.svg" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <script src="/legacy-nomodule.js"></script>
    <script type="module" src="https://cdn.example.com/thing.js"></script>
  </head><body><div id="root"></div></body></html>`

  it('collects the module entry and every modulepreload', () => {
    const refs = parseHtmlAssetRefs(html)
    expect(refs.entry).toEqual(['/assets/index-AAA.js'])
    expect(refs.preload).toEqual(['/assets/vendor-react-BBB.js', '/assets/vendor-data-CCC.js'])
  })

  it('does not care what order the attributes are written in', () => {
    // Vite has moved `crossorigin` around between majors. A guard a formatter
    // can blind is not a guard.
    expect(parseHtmlAssetRefs(html).preload).toContain('/assets/vendor-data-CCC.js')
  })

  it('ignores non-module scripts, icons, manifests and cross-origin sources', () => {
    const refs = parseHtmlAssetRefs(html)
    expect(refs.entry).not.toContain('/legacy-nomodule.js')
    expect(refs.entry.some((h) => h.startsWith('https://'))).toBe(false)
    expect([...refs.preload, ...refs.entry]).not.toContain('/manifest.webmanifest')
  })

  it('keeps stylesheets separate — they are reported, not budgeted', () => {
    expect(parseHtmlAssetRefs(html).stylesheets).toEqual(['/assets/index-DDD.css'])
  })
})

describe('parseStaticImportSpecifiers', () => {
  it('finds static imports, side-effect imports and re-exports', () => {
    const code = [
      `import{a as b}from"./vendor-react-BBB.js";`,
      `import"./rolldown-runtime-CCC.js";`,
      `import * as ns from "./vendor-data-DDD.js";`,
      `export{x}from"./utils-EEE.js";`,
      `export*from"./more-FFF.js";`,
    ].join('\n')
    expect(parseStaticImportSpecifiers(code).sort()).toEqual([
      './more-FFF.js',
      './rolldown-runtime-CCC.js',
      './utils-EEE.js',
      './vendor-data-DDD.js',
      './vendor-react-BBB.js',
    ])
  })

  it('ignores dynamic imports and import.meta', () => {
    // This is the line between "eager" and "lazy". Counting `import()` would
    // make the budget the size of the whole app and the guard meaningless.
    const code = `const p=()=>import("./analytics-page-XYZ.js");const u=import.meta.url;`
    expect(parseStaticImportSpecifiers(code)).toEqual([])
  })
})

describe('parseDynamicImportSpecifiers', () => {
  it('reads the TEMPLATE-literal form rolldown actually emits', () => {
    // Verbatim shape from dist/assets/index-*.js:
    //   let t=e===`ru`?(await g(async()=>{let{ru:e}=await import(`./ru-CwSLPOkc.js`);…
    // A quote class of only `"` and `'` finds zero dynamic imports in a real
    // build, which would silently hide the locale chunk from the budget.
    const code = 'let t=e===`ru`?(await g(async()=>{let{ru:e}=await import(`./ru-CwSLPOkc.js`);return{ru:e}},[])).ru:0'
    expect(parseDynamicImportSpecifiers(code)).toEqual(['./ru-CwSLPOkc.js'])
  })

  it('reads single and double quotes too, and skips static imports', () => {
    const code = [
      `import"./eager-AAA.js";`,
      `const a=()=>import("./page-a-BBB.js");`,
      `const b=()=>import('./page-b-CCC.js');`,
      `const u=import.meta.url;`,
    ].join('\n')
    expect(parseDynamicImportSpecifiers(code).sort()).toEqual([
      './page-a-BBB.js',
      './page-b-CCC.js',
    ])
  })
})

describe('isRelativeSpecifier', () => {
  it('accepts both spellings a chunk graph uses', () => {
    expect(isRelativeSpecifier('./vendor-react.js')).toBe(true)
    expect(isRelativeSpecifier('../vendor-three.js')).toBe(true)
  })

  it('rejects bare specifiers, including ones that merely start with a dot', () => {
    expect(isRelativeSpecifier('react')).toBe(false)
    expect(isRelativeSpecifier('@scope/pkg')).toBe(false)
    expect(isRelativeSpecifier('.hidden-pkg')).toBe(false)
  })
})

describe('walkEagerGraph', () => {
  const chunks = {
    'assets/index.js': `import"./a.js";import"./nested/deep.js";const lazy=()=>import("./heavy.js");`,
    'assets/a.js': `import{x}from"./b.js";`,
    'assets/b.js': `export const x=1;import"react";`,
    'assets/heavy.js': `export const h=1;`,
    'assets/nested/deep.js': `import"../vendor-three.js";`,
    'assets/vendor-three.js': `export const t="__THREE_DEVTOOLS__";`,
  }
  const loadChunk = (rel) => chunks[rel] ?? null

  it('follows static imports transitively and stops at dynamic ones', () => {
    const { chunks: walked } = walkEagerGraph({ seeds: ['assets/index.js'], loadChunk })
    expect(walked).toEqual([
      'assets/index.js',
      'assets/a.js',
      'assets/nested/deep.js',
      'assets/b.js',
      'assets/vendor-three.js',
    ])
    expect(walked).not.toContain('assets/heavy.js')
  })

  it('follows PARENT-relative specifiers, not only "./"', () => {
    // Every fixture above used to be `./`-prefixed, so narrowing the relative
    // test from `startsWith('.')` to `startsWith('./')` passed all 25 tests
    // while walking straight past `../vendor-three.js`. A chunk emitted into a
    // subdirectory (assetsDir change, emitted worker) reaches its siblings
    // exactly that way, and the guard would have reported a clean login route
    // with three.js sitting on it.
    const { chunks: walked } = walkEagerGraph({ seeds: ['assets/nested/deep.js'], loadChunk })
    expect(walked).toContain('assets/vendor-three.js')
  })

  it('drops specifiers that resolve to nothing on disk', () => {
    // Bare specifiers and the occasional literal that merely looks like an
    // import must not inflate the eager set.
    const { chunks: walked, missing } = walkEagerGraph({ seeds: ['assets/b.js'], loadChunk })
    expect(walked).toEqual(['assets/b.js'])
    expect(missing).toEqual([])
  })

  it('reports a seed named by index.html that was never emitted', () => {
    const { missing } = walkEagerGraph({ seeds: ['assets/ghost.js'], loadChunk })
    expect(missing).toEqual(['assets/ghost.js'])
  })
})

describe('inspectChunk', () => {
  it('flags a chunk by content marker alone, with no sourcemap available', () => {
    const hits = inspectChunk({ code: `x&&${three.markers[0]}.dispatchEvent(e)` })
    expect(hits.map((h) => h.bundle.id)).toEqual(['three'])
    expect(hits[0].detections).toEqual([
      { detector: 'content marker', evidence: three.markers[0] },
    ])
  })

  it('flags a chunk by sourcemap attribution alone, with no marker in the code', () => {
    const hits = inspectChunk({
      code: `export const nothing=1`,
      sources: [
        '../../src/app/router.tsx',
        '../../node_modules/recharts/es6/chart/AreaChart.js',
        '../../node_modules/d3-scale/src/linear.js',
      ],
    })
    expect(hits.map((h) => h.bundle.id)).toEqual(['charts'])
    expect(hits[0].detections[0]).toEqual({
      detector: 'source module',
      evidence: '../../node_modules/recharts/es6/chart/AreaChart.js (+1 more module)',
    })
  })

  it('reports both detectors when both fire', () => {
    const hits = inspectChunk({
      code: `const e="${charts.markers[0]}"`,
      sources: ['../../node_modules/recharts/es6/index.js'],
    })
    expect(hits[0].detections.map((d) => d.detector)).toEqual(['content marker', 'source module'])
  })

  it('does not flag @xyflow’s interaction d3 as the charting stack', () => {
    // d3-drag/-zoom/-selection ride with the lazy bot-map page. Calling that
    // "charts" would send the next reader after the wrong manualChunks rule.
    const hits = inspectChunk({
      code: `export const g=1`,
      sources: [
        '../../node_modules/d3-drag/src/drag.js',
        '../../node_modules/d3-zoom/src/zoom.js',
        '../../node_modules/d3-selection/src/select.js',
        '../../node_modules/d3-interpolate/src/value.js',
      ],
    })
    expect(hits).toEqual([])
  })

  it('does not flag first-party code that merely mentions a recharts class name', () => {
    // `appearance-page` really does carry this string: a Tailwind arbitrary
    // variant typed by hand. It is why the markers are library internals and
    // not CSS class names.
    const hits = inspectChunk({
      code: 'className:cn(`[&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none`,t)',
      sources: ['../../src/features/branding/branding-preview.tsx'],
    })
    expect(hits).toEqual([])
  })
})

describe('DENIED_BUNDLES — the admin shell and the libraries only it uses', () => {
  // Until 0.9.7.70 the router imported the shell statically and /sign-in
  // downloaded all of this before its form could paint. These entries keep it
  // off. Each pattern is checked in both directions, because the failure that
  // matters is quiet: a pattern that also matches the tooltip would fail every
  // build (and be deleted), one that misses a real path passes a regression.
  const bundle = (id) => DENIED_BUNDLES.find((b) => b.id === id)

  it('attributes the shell by its own files, not by the route files next door', () => {
    const { sourcePattern } = bundle('admin-shell')
    for (const src of [
      '../../src/components/layout/admin-shell.tsx',
      '../../src/components/layout/admin-sidebar/nav-items.tsx',
      '../../src/components/layout/admin-topbar/notification-bell.tsx',
      '../../src/components/quick-search/quick-search-overlay.tsx',
    ]) {
      expect(sourcePattern.test(src), src).toBe(true)
    }
    // The router, the session gate and the error boundary ARE on the route.
    for (const src of [
      '../../src/app/router.tsx',
      '../../src/app/protected-route.tsx',
      '../../src/components/ErrorBoundary.tsx',
      '../../src/components/layout/page-title.tsx',
      '../../src/components/layout/admin-shell-fallback.tsx',
    ]) {
      expect(sourcePattern.test(src), src).toBe(false)
    }
  })

  it('names the Radix primitives that left the route, not the tooltip that stays', () => {
    const { sourcePattern } = bundle('radix-kit')
    for (const src of [
      '../../node_modules/@radix-ui/react-select/dist/index.mjs',
      '../../node_modules/@radix-ui/react-dropdown-menu/dist/index.mjs',
      '../../node_modules/@radix-ui/react-menu/dist/index.mjs',
      '../../node_modules/@radix-ui/react-dialog/dist/index.mjs',
      '../../node_modules/@radix-ui/react-scroll-area/dist/index.mjs',
      '../../node_modules/@radix-ui/react-popover/dist/index.mjs',
    ]) {
      expect(sourcePattern.test(src), src).toBe(true)
    }
    // `TooltipProvider` is in providers.tsx: the tooltip and everything it is
    // built on are render-blocking by design.
    for (const src of [
      '../../node_modules/@radix-ui/react-tooltip/dist/index.mjs',
      '../../node_modules/@radix-ui/react-popper/dist/index.mjs',
      '../../node_modules/@radix-ui/react-dismissable-layer/dist/index.mjs',
      '../../node_modules/@radix-ui/react-presence/dist/index.mjs',
      '../../node_modules/@radix-ui/react-portal/dist/index.mjs',
      '../../node_modules/@radix-ui/react-primitive/dist/index.mjs',
      '../../node_modules/@radix-ui/react-slot/dist/index.mjs',
    ]) {
      expect(sourcePattern.test(src), src).toBe(false)
    }
  })

  it('recognises the realtime client, dnd-kit and cmdk by their packages', () => {
    for (const [id, src] of [
      ['socket-io', '../../node_modules/socket.io-client/build/esm/socket.js'],
      ['socket-io', '../../node_modules/socket.io-parser/build/esm/index.js'],
      ['socket-io', '../../node_modules/engine.io-client/build/esm/socket.js'],
      ['socket-io', '../../node_modules/engine.io-parser/build/esm/index.js'],
      ['dnd-kit', '../../node_modules/@dnd-kit/core/dist/core.esm.js'],
      ['dnd-kit', '../../node_modules/@dnd-kit/sortable/dist/sortable.esm.js'],
      ['cmdk', '../../node_modules/cmdk/dist/index.mjs'],
    ]) {
      expect(bundle(id).sourcePattern.test(src), `${id}: ${src}`).toBe(true)
    }
    expect(bundle('socket-io').sourcePattern.test('../../src/lib/realtime/use-realtime-updates.ts')).toBe(false)
  })

  it('tells the reader to look for a static import when the shell is back', () => {
    // The generic advice — hunt for the manualChunks group — is right for a
    // vendor library and wrong here: the shell comes back through an import.
    const shell = bundle('admin-shell')
    const failures = evaluate(
      report({
        eager: [
          {
            rel: 'assets/index-AAA.js',
            bytes: 400_000,
            hits: inspectChunk({ code: 'x', sources: ['../../src/components/layout/admin-shell.tsx'] }),
          },
        ],
      }),
    )
    expect(failures.map((f) => f.rule)).toEqual(['denylist'])
    const text = failures[0].lines.join('\n')
    expect(text).toContain(shell.label)
    expect(text).toContain('only inside lazy()')
    expect(text).not.toContain('build.rollupOptions.output.manualChunks')
  })
})

describe('selectRenderBlockingChunks', () => {
  // Shapes taken verbatim from a real build: the locale chunks' sourcemaps
  // carry exactly one source each.
  const ru = { rel: 'assets/ru-CwSLPOkc.js', bytes: 219_208, sources: ['../../src/i18n/ru.ts'] }
  const en = { rel: 'assets/en-BB8cJG-p.js', bytes: 137_107, sources: ['../../src/i18n/en.ts'] }
  const lazyRoute = {
    rel: 'assets/analytics-page-Q9x.js',
    bytes: 400_000,
    sources: ['../../src/features/analytics/analytics-page.tsx'],
  }
  const featureBundle = {
    rel: 'assets/branding.ru-Cq9lDOSA.js',
    bytes: 30_000,
    sources: ['../../src/i18n/features/branding.ru.ts'],
  }

  it('counts the LARGEST locale, because an operator downloads exactly one', () => {
    const picked = selectRenderBlockingChunks([en, ru, lazyRoute])
    expect(picked.chunks.map((c) => c.rel)).toEqual(['assets/ru-CwSLPOkc.js'])
    expect(picked.chunks[0].bytes).toBe(219_208)
    // Summing both would invent 137 KB nobody pays for.
    expect(picked.considered.sort()).toEqual([
      'assets/en-BB8cJG-p.js',
      'assets/ru-CwSLPOkc.js',
    ])
  })

  it('does not mistake a per-feature bundle for the core dictionary', () => {
    // `src/i18n/features/branding.ru.ts` is lazy — it loads with the branding
    // route, long after first paint. Counting the ~36 of them would put most
    // of the app back into a budget that is supposed to describe /sign-in.
    expect(selectRenderBlockingChunks([featureBundle]).chunks).toEqual([])
  })

  it('falls back to the emitted name when no sourcemap is available', () => {
    const noMaps = [
      { rel: 'assets/ru-CwSLPOkc.js', bytes: 219_208, sources: [] },
      { rel: 'assets/branding.ru-Cq9lDOSA.js', bytes: 30_000, sources: [] },
    ]
    const picked = selectRenderBlockingChunks(noMaps)
    expect(picked.chunks.map((c) => c.rel)).toEqual(['assets/ru-CwSLPOkc.js'])
  })

  it('finds nothing — and says so — when the bootstrap moved', () => {
    expect(selectRenderBlockingChunks([lazyRoute]).chunks).toEqual([])
    expect(RENDER_BLOCKING_LOCALE.sourcePattern.test('../../src/i18n/ru.ts')).toBe(true)
  })
})

describe('evaluate — eager singletons (React)', () => {
  const eager = [
    { rel: 'assets/index-AAA.js', bytes: 300_000 },
    { rel: 'assets/vendor-data-CCC.js', bytes: 186_458 },
  ]

  it('passes when React sits in exactly one audited chunk — WHATEVER it is called', () => {
    // On this tree that chunk is `vendor-data`, not `vendor-react`. Keying on
    // the name would fail a build that is completely fine, and pass the two
    // that are not.
    const failures = evaluate(
      report({ eager, singletons: new Map([['react', ['assets/vendor-data-CCC.js']]]) }),
    )
    expect(failures).toEqual([])
  })

  it('fails when React is emitted into two chunks', () => {
    // Two module registries: every hook in the app throws "invalid hook call".
    const failures = evaluate(
      report({
        eager,
        singletons: new Map([['react', ['assets/vendor-data-CCC.js', 'assets/vendor-charts-DDD.js']]]),
      }),
    )
    expect(failures.map((f) => f.rule)).toEqual(['singleton/duplicated'])
    expect(failures[0].lines[0]).toContain('assets/vendor-charts-DDD.js')
  })

  it('fails when React drifts off the render-blocking graph', () => {
    // The concrete future the chunk-name lie sets up: "split zod/axios out of
    // the eager set" moves React with them, because React rides in
    // `vendor-data` and not in the chunk named after it.
    const failures = evaluate(
      report({ eager, singletons: new Map([['react', ['assets/lazy-analytics-EEE.js']]]) }),
    )
    expect(failures.map((f) => f.rule)).toEqual(['singleton/off-route'])
    expect(failures[0].lines.join('\n')).toContain('vendor-data')
  })

  it('fails when the pattern matches nothing, rather than passing silently', () => {
    const failures = evaluate(report({ eager, singletons: new Map([['react', []]]) }))
    expect(failures.map((f) => f.rule)).toEqual(['singleton/missing'])
  })

  it('recognises the module paths React actually ships', () => {
    const react = EAGER_SINGLETONS.find((s) => s.id === 'react')
    for (const src of [
      '../../node_modules/react/index.js',
      '../../node_modules/react/jsx-runtime.js',
      '../../node_modules/react/cjs/react.production.js',
      '../../node_modules/react/cjs/react-jsx-runtime.production.js',
    ]) {
      expect(react.sourcePattern.test(src)).toBe(true)
    }
    // …and nothing that merely lives next door.
    for (const src of [
      '../../node_modules/react-dom/client.js',
      '../../node_modules/react-router/dist/production/index.js',
      '../../node_modules/@xyflow/react/dist/esm/index.js',
      '../../node_modules/react-hook-form/dist/index.esm.mjs',
    ]) {
      expect(react.sourcePattern.test(src)).toBe(false)
    }
  })
})

describe('evaluate — audit completeness', () => {
  it('fails when the awaited locale chunk could not be identified', () => {
    // 219,208 B of the 1,479,136 B ceiling subject. Losing it quietly is how
    // the budget came to advertise headroom it did not have.
    const failures = evaluate(report({ renderBlocking: [] }))
    expect(failures.map((f) => f.rule)).toEqual(['render-blocking-locale'])
    expect(failures[0].lines.join('\n')).toContain('createRoot().render()')
  })

  it('fails when no audited chunk has a sourcemap', () => {
    // `build.sourcemap: false` removes the source-attribution detector — the
    // one that caught React copied into `vendor-charts` — and nothing else
    // changes. Marker liveness cannot see it: it only validates `markers`.
    const failures = evaluate(
      report({ eager: [{ rel: 'assets/index-AAA.js', bytes: 1000 }], sourcemapped: 0 }),
    )
    expect(failures.map((f) => f.rule)).toEqual(['sourcemap-coverage'])
    expect(failures[0].lines.join('\n')).toContain('build.sourcemap')
  })

  it('does not demand sourcemaps when there is nothing to audit', () => {
    expect(evaluate(report({ eager: [], sourcemapped: 0 }))).toEqual([])
  })
})

describe('evaluate — denylist', () => {
  const offender = {
    rel: 'assets/some-shared-chunk-Q9x.js',
    bytes: 449_231,
    hits: [
      {
        bundle: charts,
        detections: [{ detector: 'content marker', evidence: charts.markers[0] }],
      },
    ],
  }

  it('fails on a denied library no matter what the chunk is called', () => {
    // The `vendor-charts` NAME is exactly what disappeared when the group was
    // deleted. Keying on it would make this guard evaporate the moment it
    // matters, so the detection is by content and the name is only ever
    // printed as a coordinate for the human reading the log.
    const failures = evaluate(report({ eager: [offender] }))
    expect(failures.map((f) => f.rule)).toEqual(['denylist'])
    expect(failures[0].lines[0]).toContain('assets/some-shared-chunk-Q9x.js')
    expect(failures[0].lines[0]).toContain('449,231 B')
    expect(failures[0].lines[0]).toContain(charts.label)
  })

  it('does not fail a chunk merely NAMED like a denied bundle', () => {
    const failures = evaluate(
      report({ eager: [{ rel: 'assets/vendor-charts-AAA.js', bytes: 1024, hits: [] }] }),
    )
    expect(failures).toEqual([])
  })

  it('says which detector fired so the reader does not have to re-derive it', () => {
    const [failure] = evaluate(report({ eager: [offender] }))
    expect(failure.lines.join('\n')).toContain(`detected by content marker: ${charts.markers[0]}`)
  })
})

describe('evaluate — the sign-in page', () => {
  // Found by a smoke run of the build that made the admin shell lazy: the
  // Radix group left the render-blocking graph and was still downloaded on
  // /sign-in, because the sign-in page imported it for a label and a line.
  const radix = DENIED_BUNDLES.find((b) => b.id === 'radix-kit')
  const withPage = (signInPage, eager = [{ rel: 'assets/index-AAA.js', bytes: 1000 }]) => ({
    ...report({ eager }),
    signInPage,
  })

  it('fails when a denied library rides in with the sign-in page', () => {
    const r = withPage([
      { rel: 'assets/sign-in-page-JJJ.js', bytes: 3000, hits: [] },
      {
        rel: 'assets/vendor-ui-LLL.js',
        bytes: 88_084,
        hits: [{ bundle: radix, detections: [{ detector: 'content marker', evidence: radix.markers[0] }] }],
      },
    ])
    const failures = evaluate(r)
    expect(failures.map((f) => f.rule)).toEqual(['denylist/sign-in-page'])
    expect(failures[0].lines[0]).toContain('assets/vendor-ui-LLL.js')
    expect(failures[0].lines[0]).toContain(radix.label)
    expect(failures[0].lines.join('\n')).toContain('not render-blocking')
    expect(formatReport(r, failures)).toContain('← DENIED: radix-kit')
  })

  it('does not count the sign-in page against the budget', () => {
    // The ceiling describes the render-blocking graph and stays that: 1.69 MB
    // eager plus a 500 KB page is inside it.
    const failures = evaluate(
      withPage([{ rel: 'assets/sign-in-page-JJJ.js', bytes: 500_000, hits: [] }], [
        { rel: 'assets/index-AAA.js', bytes: 1_690_000 },
      ]),
    )
    expect(failures).toEqual([])
  })

  it('fails when the sign-in page could not be found, rather than audit nothing', () => {
    const failures = evaluate(withPage(null))
    expect(failures.map((f) => f.rule)).toEqual(['sign-in-page'])
    expect(failures[0].lines.join('\n')).toContain('SIGN_IN_PAGE')
  })
})

describe('findDynamicImports / sourceAtOffset', () => {
  it('keeps every import site, duplicates included, with its offset', () => {
    const code = 'a();const x=()=>import(`./s.js`);const y=()=>import("./s.js");'
    expect(findDynamicImports(code)).toEqual([
      { spec: './s.js', index: code.indexOf('import(`') },
      { spec: './s.js', index: code.indexOf('import("') },
    ])
  })

  it('attributes an offset to the source of the last segment at or before it', () => {
    // Line 0: col 0 → source 0, col 5 → source 1 ("K" is 5, "C" is +1).
    // Line 1: col 0 → source index 1 − 1 = 0. The source delta carries ACROSS
    // lines: a decoder that restarted it per line would answer source 1 here.
    const map = { sources: ['../../src/main.tsx', '../../src/app/admin-shell-loader.ts'], mappings: 'AAAA,KCAA;ADAA' }
    const code = 'abcdefghij\nklmnop'
    expect(sourceAtOffset(map, code, 2)).toBe('../../src/main.tsx')
    expect(sourceAtOffset(map, code, 5)).toBe('../../src/app/admin-shell-loader.ts')
    expect(sourceAtOffset(map, code, 9)).toBe('../../src/app/admin-shell-loader.ts')
    expect(sourceAtOffset(map, code, 13)).toBe('../../src/main.tsx')
  })

  it('answers null for an unmapped position or a map without mappings', () => {
    // "K" alone is a one-field segment: generated code with no source.
    expect(sourceAtOffset({ sources: ['a.ts'], mappings: 'AAAA,K' }, 'abcdefghij', 7)).toBeNull()
    expect(sourceAtOffset({ sources: ['a.ts'] }, 'abc', 1)).toBeNull()
    expect(sourceAtOffset(null, 'abc', 1)).toBeNull()
  })
})

describe('evaluate — the admin shell is imported lazily once, by its loader', () => {
  const LOADER = '../../src/app/admin-shell-loader.ts'
  const site = (from, origin) => ({ from, target: 'assets/admin-shell-S.js', origin })
  const withShell = (adminShell) => ({ ...report({ eager: [{ rel: 'assets/index-A.js', bytes: 1000 }] }), adminShell })
  const rules = (r) => evaluate(r).map((f) => f.rule)

  it('passes exactly one import, from the loader', () => {
    expect(rules(withShell({ chunks: ['assets/admin-shell-S.js'], imports: [site('assets/index-A.js', LOADER)] }))).toEqual([])
  })

  it('fails a second import — the warm-up on mount the budget cannot see', () => {
    const failures = evaluate(
      withShell({
        chunks: ['assets/admin-shell-S.js'],
        imports: [
          site('assets/index-A.js', LOADER),
          site('assets/sign-in-page-J.js', '../../src/features/auth/sign-in-page.tsx'),
        ],
      }),
    )
    expect(failures.map((f) => f.rule)).toEqual([ADMIN_SHELL_WARMUP.id])
    const text = failures[0].lines.join('\n')
    expect(text).toContain('from 2 places')
    expect(text).toContain('sign-in-page.tsx')
    expect(text).toContain('adminShell.preload()')
  })

  it('fails a single import that does not come from the loader', () => {
    expect(
      rules(withShell({ chunks: ['assets/admin-shell-S.js'], imports: [site('assets/index-A.js', '../../src/main.tsx')] })),
    ).toEqual([ADMIN_SHELL_WARMUP.id])
    // An unattributable site is not the loader either.
    expect(rules(withShell({ chunks: ['assets/admin-shell-S.js'], imports: [site('assets/index-A.js', null)] }))).toEqual([
      ADMIN_SHELL_WARMUP.id,
    ])
  })

  it('fails when nothing imports the shell lazily, and when the shell cannot be found', () => {
    const none = evaluate(withShell({ chunks: ['assets/index-A.js'], imports: [] }))
    expect(none.map((f) => f.rule)).toEqual([ADMIN_SHELL_WARMUP.id])
    expect(none[0].lines.join('\n')).toContain('imported statically')
    expect(rules(withShell({ chunks: [], imports: [] }))).toEqual([ADMIN_SHELL_WARMUP.id])
  })
})

/**
 * The two regressions ADMIN_SHELL_WARMUP and the denylist split between them,
 * on a dist/ written to disk, so sourcemap attribution is part of what is tested.
 */
describe('auditDist — regressions of the lazy admin shell', () => {
  const dirs = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  /** index.html + a mapped entry + the shell + whatever `extra` adds. */
  function distWith({ entryLines, entryMap, extra = [] }) {
    const dir = mkdtempSync(join(tmpdir(), 'build-graph-shell-'))
    dirs.push(dir)
    const put = (rel, body, map) => {
      const full = join(dir, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, body)
      if (map) writeFileSync(`${full}.map`, JSON.stringify({ version: 3, ...map }))
    }
    put('index.html', '<!doctype html><script type="module" src="/assets/index-A.js"></script>')
    put('assets/index-A.js', entryLines.join('\n'), entryMap)
    put('assets/admin-shell-S.js', 'export default function Shell(){};const k="rezeis_admin_push_resync";', {
      sources: ['../../src/components/layout/admin-shell.tsx'],
    })
    for (const [rel, body, map] of extra) put(rel, body, map)
    return dir
  }

  it('fails a second dynamic import of the shell, from the sign-in page', () => {
    const dir = distWith({
      entryLines: ['const signIn=()=>import(`./sign-in-page-J.js`);', 'const shell=()=>import(`./admin-shell-S.js`);'],
      entryMap: { sources: ['../../src/main.tsx', '../../src/app/admin-shell-loader.ts'], mappings: 'AAAA;ACAA' },
      extra: [
        [
          'assets/sign-in-page-J.js',
          'useEffect(()=>{import(`./admin-shell-S.js`)},[]);export default 1;',
          { sources: ['../../src/features/auth/sign-in-page.tsx'], mappings: 'AAAA' },
        ],
      ],
    })
    const report = auditDist(dir)
    expect(report.adminShell.imports.map((s) => s.origin)).toEqual([
      '../../src/app/admin-shell-loader.ts',
      '../../src/features/auth/sign-in-page.tsx',
    ])
    expect(evaluate(report).map((f) => f.rule)).toContain(ADMIN_SHELL_WARMUP.id)
  })

  it('fails a STATIC import of the shell onto the route, even with the loader import in place', () => {
    const dir = distWith({
      entryLines: ['import"./admin-shell-S.js";', 'const shell=()=>import(`./admin-shell-S.js`);'],
      entryMap: { sources: ['../../src/main.tsx', '../../src/app/admin-shell-loader.ts'], mappings: 'AAAA;ACAA' },
    })
    const report = auditDist(dir)
    // The one import() is the allowed one...
    expect(report.adminShell.imports.map((s) => s.origin)).toEqual(['../../src/app/admin-shell-loader.ts'])
    // ...and the denylist still fails the chunk it made eager.
    const denied = evaluate(report).filter((f) => f.rule === 'denylist')
    expect(denied).toHaveLength(1)
    expect(denied[0].lines[0]).toContain('assets/admin-shell-S.js')
    expect(denied[0].lines[0]).toContain(DENIED_BUNDLES.find((b) => b.id === 'admin-shell').label)
  })
})

describe('evaluate — marker liveness', () => {
  it('fails when a denied library matches nothing anywhere in dist', () => {
    // A marker set that matches zero chunks means the denylist has been
    // passing without testing anything — the exact failure mode this whole
    // guard exists to prevent, applied to the guard itself.
    // Every other library is found; only the charting stack is not.
    const liveness = new Map(DENIED_BUNDLES.map((b) => [b.id, [`assets/${b.id}-lazy.js`]]))
    liveness.set('charts', [])
    const failures = evaluate(report({ liveness }))
    expect(failures.map((f) => f.rule)).toEqual(['marker-liveness'])
    expect(failures[0].lines[0]).toContain(charts.label)
    expect(failures[0].lines.join('\n')).toContain(JSON.stringify(charts.markers[0]))
  })

  it('passes when every denied library is still findable in a lazy chunk', () => {
    expect(evaluate(report())).toEqual([])
  })
})

describe('evaluate — budgets', () => {
  it('fails on bytes and prints actual, allowed, overage and the worst chunks', () => {
    const failures = evaluate(
      report({
        eager: [
          { rel: 'assets/index-AAA.js', bytes: 1_100_000 },
          { rel: 'assets/vendor-react-BBB.js', bytes: 700_000 },
        ],
      }),
    )
    expect(failures.map((f) => f.rule)).toEqual(['budget/bytes'])
    const text = failures[0].lines.join('\n')
    expect(text).toContain('1,800,000 B')
    expect(text).toContain(`${EAGER_BYTE_BUDGET.toLocaleString('en-US')} B ceiling`)
    expect(text).toContain('by 100,000 B')
    expect(text).toContain('assets/vendor-react-BBB.js')
  })

  it('fails on chunk count and lists every eager chunk', () => {
    const eager = Array.from({ length: EAGER_CHUNK_BUDGET + 1 }, (_, i) => ({
      rel: `assets/chunk-${i}.js`,
      bytes: 10,
    }))
    const failures = evaluate(report({ eager }))
    expect(failures.map((f) => f.rule)).toEqual(['budget/chunks'])
    expect(failures[0].lines[0]).toContain(`${EAGER_CHUNK_BUDGET + 1} eager chunks`)
    expect(failures[0].lines.join('\n')).toContain(`assets/chunk-${EAGER_CHUNK_BUDGET}.js`)
  })

  it('leaves headroom above the measured payload rather than pinning it', () => {
    // 1,479,136 B / 13 chunks measured 2026-08-08 — 1,259,928 B of static
    // closure PLUS the 219,208 B `ru` chunk main.tsx awaits. A ceiling equal
    // to the measurement fails on every legitimate feature and gets raised
    // until it means nothing; a ceiling this far above it still trips on
    // either historical regression (1,915,083 B and 3,003,270 B, same basis).
    expect(EAGER_BYTE_BUDGET).toBeGreaterThan(1_479_136)
    expect(EAGER_BYTE_BUDGET).toBeLessThan(1_915_083)
    expect(EAGER_CHUNK_BUDGET).toBeGreaterThanOrEqual(13)
    expect(EAGER_CHUNK_BUDGET).toBeLessThan(17)
  })

  it('would still have caught the locale re-inflation the old ceiling let through', () => {
    // The concrete regression the old 1.5 MB ceiling could not see: put 250 KB
    // back into the render-blocking dictionary and the payload lands at
    // 1,729,136 B. Under the old basis (locale excluded) that was 1,259,928 B
    // — nowhere near any ceiling.
    const inflated = report({
      eager: [
        { rel: 'assets/static-closure.js', bytes: 1_259_928 },
        { rel: 'assets/ru-AAA.js', bytes: 219_208 + 250_000, renderBlocking: true },
      ],
    })
    const failures = evaluate(inflated)
    expect(failures.map((f) => f.rule)).toEqual(['budget/bytes'])
    expect(failures[0].lines[0]).toContain('1,729,136 B')
  })
})

/**
 * `auditDist` against a real (tiny) dist/ on disk.
 *
 * The fixture-driven tests above hand `evaluate` a finished report, which
 * means they prove the RULES and nothing about the accounting that produces
 * them. That gap is not hypothetical: replacing
 * `sourcemapped: eager.filter(c => c.sourcemapped).length` with
 * `sourcemapped: eager.length` — i.e. "every chunk has a map, always" —
 * passed all 38 of them. Everything in this block reads bytes off a disk the
 * test wrote, so an accounting mutation has nowhere to hide.
 */
describe('auditDist over a synthetic dist/', () => {
  let dist

  const entry = [
    'import"./vendor-BBB.js";',
    // Rolldown's runtime shim really is emitted without a .map in this tree —
    // so `sourcemapped` and `eager.length` differ, and a mutation that
    // conflates them shows up.
    'import"./rolldown-runtime-HHH.js";',
    // The locale main.tsx awaits — dynamic, template-literal, exactly as
    // rolldown emits it.
    'const boot=async()=>(await import(`./ru-CCC.js`)).ru;',
    'const alt=async()=>(await import(`./en-DDD.js`)).en;',
    // A lazy route. Must never be counted.
    'const page=()=>import(`./analytics-EEE.js`);',
    // The sign-in page: lazy too, so never budgeted — but its own imports
    // are downloaded on /sign-in, so the denylist reads them.
    'const signIn=()=>import(`./sign-in-page-JJJ.js`);',
    // The admin shell's one dynamic import. The map below attributes this
    // line — and only this one — to the loader module, as the real build does.
    'const shell=()=>import(`./frame-SSS.js`);',
  ].join('\n')

  // One segment per line: lines 0–5 come from main.tsx (source 0), line 6
  // from the loader (source index +1 → 1). "A" is 0 and "C" is +1 in VLQ.
  const ENTRY_MAP = {
    version: 3,
    sources: ['../../src/main.tsx', '../../src/app/admin-shell-loader.ts'],
    mappings: 'AAAA;AAAA;AAAA;AAAA;AAAA;AAAA;ACAA',
  }

  const write = (rel, body, sources) => {
    const full = join(dist, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
    if (sources) writeFileSync(`${full}.map`, JSON.stringify({ version: 3, sources }))
  }

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'build-graph-dist-'))
    write(
      'index.html',
      '<!doctype html><html><head>' +
        '<script type="module" crossorigin src="/assets/index-AAA.js"></script>' +
        '<link rel="modulepreload" crossorigin href="/assets/vendor-BBB.js">' +
        '</head><body></body></html>',
    )
    write('assets/index-AAA.js', entry)
    writeFileSync(join(dist, 'assets/index-AAA.js.map'), JSON.stringify(ENTRY_MAP))
    // Named unlike its module on purpose: the shell's chunk is found by its
    // sourcemap, never by its name (see ADMIN_SHELL_WARMUP).
    write('assets/frame-SSS.js', 'export default function Shell(){}', [
      '../../src/components/layout/admin-shell.tsx',
    ])
    write('assets/vendor-BBB.js', 'export const v=1;'.padEnd(500, ';'), [
      '../../node_modules/react/index.js',
    ])
    write('assets/rolldown-runtime-HHH.js', 'export const r=1;'.padEnd(200, ';')) // no .map
    write('assets/ru-CCC.js', 'export const ru={};'.padEnd(900, ';'), ['../../src/i18n/ru.ts'])
    write('assets/en-DDD.js', 'export const en={};'.padEnd(400, ';'), ['../../src/i18n/en.ts'])
    write('assets/analytics-EEE.js', 'export const p=1;'.padEnd(90_000, ';'), [
      '../../src/features/analytics/analytics-page.tsx',
    ])
    // Lazy chunks that keep marker-liveness satisfied, exactly as the real
    // build does (three.js and recharts exist, just not on the login route).
    write('assets/vendor-three-FFF.js', 'const d=window.__THREE_DEVTOOLS__;')
    write('assets/charts-GGG.js', 'const e="rechartsEventEmitter";')
    // …and so do the admin shell and the libraries only it uses: lazy, alive.
    for (const bundle of DENIED_BUNDLES.filter((b) => b.id !== 'three' && b.id !== 'charts')) {
      write(`assets/${bundle.id}-lazy-III.js`, `const m=${JSON.stringify(bundle.markers[0])};`)
    }
    // The sign-in page imports an eager chunk (already audited) and a small
    // shared one of its own — the shape the real label wrapper has.
    write(
      'assets/sign-in-page-JJJ.js',
      'import"./vendor-BBB.js";import"./label-KKK.js";export default 1;'.padEnd(3_000, ';'),
      ['../../src/features/auth/sign-in-page.tsx'],
    )
    write('assets/label-KKK.js', 'export const l=1;'.padEnd(700, ';'), [
      '../../node_modules/@radix-ui/react-label/dist/index.mjs',
      '../../src/components/ui/label.tsx',
    ])
  })

  afterAll(() => rmSync(dist, { recursive: true, force: true }))

  it('audits the awaited locale and leaves the lazy route out', () => {
    const report = auditDist(dist)
    const audited = report.eager.map((c) => c.rel)

    expect(audited).toContain('assets/ru-CCC.js')
    expect(audited).not.toContain('assets/analytics-EEE.js')
    expect(report.renderBlocking).toEqual(['assets/ru-CCC.js'])
    // `en` is a candidate but not counted — one locale per operator.
    expect(report.localeConsidered.sort()).toEqual(['assets/en-DDD.js', 'assets/ru-CCC.js'])
    expect(report.eager.find((c) => c.rel === 'assets/ru-CCC.js').renderBlocking).toBe(true)
  })

  it('adds the locale bytes to the total the budget is measured against', () => {
    const report = auditDist(dist)
    const locale = report.eager.find((c) => c.rel === 'assets/ru-CCC.js').bytes
    const rest = report.eager
      .filter((c) => !c.renderBlocking)
      .reduce((sum, c) => sum + c.bytes, 0)

    expect(locale).toBeGreaterThan(0)
    expect(report.totalBytes).toBe(rest + locale)
    expect(evaluate(report)).toEqual([])
  })

  it('locates React by sourcemap attribution across the whole dist', () => {
    // Accounting, not rule: the fixture's react/index.js is attributed to
    // `vendor-BBB.js`, and the lazy analytics chunk must not be picked up.
    expect([...auditDist(dist).singletons]).toEqual([['react', ['assets/vendor-BBB.js']]])
  })

  it('audits the sign-in page and its own imports, outside the budget', () => {
    const report = auditDist(dist)
    expect(report.signInPage.map((c) => c.rel)).toEqual([
      'assets/sign-in-page-JJJ.js',
      'assets/label-KKK.js',
    ])
    // The eager chunk the page also imports is audited once — as eager.
    expect(report.signInPage.map((c) => c.rel)).not.toContain('assets/vendor-BBB.js')
    // Not budgeted: the total is still the render-blocking graph alone.
    expect(report.eager.map((c) => c.rel)).not.toContain('assets/sign-in-page-JJJ.js')
    expect(report.totalBytes).toBe(report.eager.reduce((sum, c) => sum + c.bytes, 0))
    expect(evaluate(report)).toEqual([])
    expect(formatReport(report, [])).toContain('loaded with the sign-in page')
  })

  it('finds the one dynamic import of the admin shell, and the module it came from', () => {
    const { adminShell } = auditDist(dist)
    // By sourcemap, not by name: `frame-SSS.js` is the shell because its map
    // says so, and `admin-shell-lazy-III.js` (a marker-liveness stub with no
    // map) is not.
    expect(adminShell.chunks).toEqual(['assets/frame-SSS.js'])
    expect(adminShell.imports).toEqual([
      {
        from: 'assets/index-AAA.js',
        target: 'assets/frame-SSS.js',
        origin: '../../src/app/admin-shell-loader.ts',
      },
    ])
    expect(formatReport(auditDist(dist), [])).toContain('admin-shell-loader.ts')
  })

  it('counts sourcemaps that exist, not chunks that ought to have them', () => {
    // The mutation this exists for: `sourcemapped: eager.length`. The two
    // numbers must differ for that to be visible, which is why the fixture
    // carries an unmapped runtime chunk — as the real build does.
    const audited = auditDist(dist)
    expect(audited.eager).toHaveLength(4) // index, vendor, rolldown-runtime, ru
    expect(audited.sourcemapped).toBe(3) // the runtime shim has no map
  })

  it('fails with sourcemap-coverage once the .map files are gone', () => {
    const mapped = ['assets/index-AAA.js', 'assets/vendor-BBB.js', 'assets/ru-CCC.js']
    for (const rel of mapped) unlinkSync(join(dist, `${rel}.map`))
    try {
      const report = auditDist(dist)
      expect(report.sourcemapped).toBe(0)
      expect(evaluate(report).map((f) => f.rule)).toContain('sourcemap-coverage')
      // …and the locale is still found, because the NAME fallback covers it.
      expect(report.renderBlocking).toEqual(['assets/ru-CCC.js'])
    } finally {
      writeFileSync(join(dist, 'assets/index-AAA.js.map'), JSON.stringify(ENTRY_MAP))
      writeFileSync(join(dist, 'assets/vendor-BBB.js.map'), JSON.stringify({ version: 3, sources: ['../../node_modules/react/index.js'] }))
      writeFileSync(join(dist, 'assets/ru-CCC.js.map'), JSON.stringify({ version: 3, sources: ['../../src/i18n/ru.ts'] }))
    }
  })
})

describe('formatReport', () => {
  it('marks the offending chunk in the table and states the rule below it', () => {
    const failing = report({
      eager: [
        {
          rel: 'assets/some-shared-chunk-Q9x.js',
          bytes: 449_231,
          hits: [
            { bundle: three, detections: [{ detector: 'content marker', evidence: '__THREE_DEVTOOLS__' }] },
          ],
        },
      ],
    })
    const text = formatReport(failing, evaluate(failing))
    expect(text).toContain('← DENIED: three')
    expect(text).toContain('449,231 B  assets/some-shared-chunk-Q9x.js')
    expect(text).toContain('[denylist]')
    expect(text).toContain('FAIL — 1 rule violation')
  })

  it('prints the trend line and a PASS on a clean build', () => {
    const clean = report({ eager: [{ rel: 'assets/index-AAA.js', bytes: 1000 }] })
    const text = formatReport(clean, evaluate(clean))
    expect(text).toContain(`budget: ${EAGER_BYTE_BUDGET.toLocaleString('en-US')} B`)
    expect(text).toContain('PASS')
  })

  it('names chunks the entry pulls in without a preload hint', () => {
    const late = report({
      eager: [
        { rel: 'assets/index-AAA.js', bytes: 1000 },
        { rel: 'assets/late-BBB.js', bytes: 500, declared: false },
      ],
    })
    expect(formatReport(late, evaluate(late))).toContain('assets/late-BBB.js')
  })
})
