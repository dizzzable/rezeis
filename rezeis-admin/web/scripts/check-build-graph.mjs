#!/usr/bin/env node
/**
 * Guard the EMITTED bundle graph — specifically, what the login route
 * downloads before an operator can type a password.
 *
 * WHY THIS EXISTS SEPARATELY FROM `src/vite-manual-chunks.test.ts`
 * ---------------------------------------------------------------
 * That test pins the `manualChunks` *decision function*: given a module id,
 * which group name should it return. It is a pure-function assertion, and by
 * construction it cannot catch either of the two bugs that actually shipped:
 *
 *   1. zustand had no rule of its own, so rolldown folded it into
 *      `vendor-three` and the eager `admin-session` chunk dragged ~950 KB of
 *      three.js onto /sign-in. The decision function was never asked about
 *      zustand — there was no rule to test.
 *   2. A `vendor-charts` group merged recharts/d3 with the React copy recharts
 *      pulls through CJS interop. `manualChunks` returned `'vendor-react'` for
 *      `node_modules/react/index.js` — the RIGHT answer — and rolldown emitted
 *      React's code into `vendor-charts` anyway. The entry chunk then bound two
 *      React imports to that group and preloaded 449 KB of charting on login.
 *
 * In case 2 the decision function was correct and the output was still wrong.
 * Nothing but the build output itself can catch that. This script reads the
 * build output.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   • DENYLIST — no chunk in the login route's render-blocking graph may
 *     contain the three.js stack or the recharts/d3 charting stack. Matched by
 *     CONTENT (library-internal marker strings) and by SOURCE ATTRIBUTION (the
 *     `sources` array of the emitted sourcemap), never by chunk name: the
 *     chunk NAME is exactly what changed when the `vendor-charts` group was
 *     deleted, so a name-based rule would evaporate at the moment it matters.
 *   • BUDGET — total render-blocking bytes and chunk count stay under a
 *     ceiling.
 *   • MARKER LIVENESS — each denied library must still be findable SOMEWHERE
 *     in dist/. If a marker set matches nothing at all, the library was either
 *     dropped from the app or the marker went stale and this guard has quietly
 *     stopped guarding. Both are failures; silence is not.
 *   • LOCALE LIVENESS — the awaited locale chunk (below) must still be
 *     identifiable. If it stops being found the budget silently drops ~220 KB
 *     of real, render-blocking payload and every number here becomes a lie.
 *   • SOURCEMAP COVERAGE — the source-attribution detector needs .map files.
 *     Flipping `build.sourcemap` off would disable the precise half of the
 *     denylist without a single test going red, so its absence is a failure.
 *
 * WHAT COUNTS AS "RENDER-BLOCKING"
 * --------------------------------
 * The entry chunk's STATIC import closure, plus one deliberate exception: the
 * locale dictionary. `main.tsx` does
 *
 *     void i18nReady.finally(() => ReactDOM.createRoot(...).render(...))
 *
 * and `i18nReady` is `loadLocale(initialLocale)` — a DYNAMIC `import()` of
 * `@/i18n/ru` (219,208 B) or `@/i18n/en` (137,107 B). The walker skips dynamic
 * imports on purpose (they are the lazy routes; counting them would make the
 * budget the size of the app), but this one is awaited BEFORE the first paint.
 * Excluding it made the budget miss 17% of what an operator actually waits
 * for: 1,259,928 B measured versus 1,479,136 B really downloaded. It is
 * therefore discovered explicitly and audited like any other chunk. Only ONE
 * locale is ever fetched, so the figure used is the LARGER of the two — the
 * worst case an operator can experience, not a sum that no one pays.
 *
 * WHY A SCRIPT AND NOT A VITEST TEST
 * ----------------------------------
 * The assertion needs a real `dist/`. A vitest test has two options and both
 * are worse. Shelling out to `vite build` from inside `npm test` doubles the
 * slowest step in CI (the web job already builds). Reading a pre-existing
 * `dist/` from inside `npm test` means the test passes when `dist/` is stale
 * and skips when it is absent — a test that reports green while measuring a
 * build from last week is precisely the failure mode this whole exercise is
 * about. So: a standalone script, wired into CI immediately after the build
 * step that produced the artifacts it reads, plus `npm run check:build-graph`
 * for a human. The script's own *logic* is unit-tested against in-memory
 * fixtures by `check-build-graph.test.mjs`, which does run under `npm test`.
 *
 * Usage:  node scripts/check-build-graph.mjs [--dist <dir>]
 *   --dist   build output directory; defaults to `dist` next to package.json
 * Exit code 0 = pass, 1 = a rule was broken, 2 = the build output is unusable.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// Budgets
//
// Measured on this tree (2026-08-08, the build these numbers were fixed
// against). Every figure INCLUDES the awaited `ru` locale chunk (219,208 B) —
// see "what counts as render-blocking" above. The trend is the point — keep it
// here so the next reader can see where the line has been:
//
//   before the zustand fix     3,003,270 B  (2,784,062 static + locale) / 16 chunks
//   before the charts fix      1,915,083 B  (1,695,875 static + locale) / 14 chunks
//   CURRENT                    1,479,136 B  (1,259,928 static + locale) / 13 chunks
//
// The ceiling is the goal the fix was measured against, not the current
// number: a guard pinned to the exact measurement fails on every legitimate
// feature and gets raised reflexively until it means nothing. 1.7 MB leaves
// 220,864 B of honest headroom and still trips on either historical regression
// (by 215,083 B and 1,303,270 B respectively).
//
// The previous 1,500,000 B ceiling was set against a total that omitted the
// locale, so it advertised "~240 KB of headroom" while the real payload sat
// 20,864 B under it — re-inflating the locale dictionary by 250 KB would have
// passed cleanly. Do not lower this back without also removing the locale from
// the audited set, and do not do that.
// ─────────────────────────────────────────────────────────────────────────────
export const EAGER_BYTE_BUDGET = 1_700_000
export const EAGER_CHUNK_BUDGET = 15

/**
 * The locale dictionary `main.tsx` awaits before `createRoot().render()`.
 *
 * Discovered rather than hard-coded: the emitted filename carries a content
 * hash and the chunk is reached through a dynamic `import()`, so neither the
 * name nor the static graph can be trusted to find it. `sourcePattern` is the
 * primary detector (sourcemap attribution — `src/i18n/ru.ts` exactly, never
 * `src/i18n/features/branding.ru.ts`); `namePattern` is the fallback for a
 * build without maps, and matches only a chunk whose basename STARTS with the
 * locale code, so the ~36 per-feature `*.ru-hash.js` bundles do not qualify.
 *
 * If neither matches anything, `evaluate` fails. A silently un-audited locale
 * is how the budget lost 17% of its subject the first time.
 */
export const RENDER_BLOCKING_LOCALE = {
  id: 'locale',
  label: 'the initial locale dictionary awaited by main.tsx',
  sourcePattern: /(?:^|[\\/])src[\\/]i18n[\\/](?:ru|en)\.ts$/,
  namePattern: /(?:^|\/)(?:ru|en)-[^/]*\.js$/,
}

/**
 * Libraries that must never appear in the login route's eager graph.
 *
 * `markers` are library-internal strings, not CSS class names. That
 * distinction is load-bearing: `recharts-surface` looks like a fine marker
 * until you notice `appearance-page` carries it inside a Tailwind arbitrary
 * variant (`[&_.recharts-surface]:outline-none`) written by hand in
 * first-party source. `rechartsEventEmitter` and friends only exist inside the
 * library. Every marker below was verified against the real dist/ to match
 * exactly one emitted chunk — the library's own bundle.
 *
 * `sourcePattern` is checked against the `sources` array of the chunk's
 * sourcemap (`build.sourcemap: 'hidden'` emits .map files without the trailing
 * comment). It is the precise detector; the markers are the one that keeps
 * working if sourcemaps are ever switched off. Both run; either one firing is
 * a failure, and the report says which fired.
 *
 * The charts `sourcePattern` deliberately lists only the chart-math d3
 * packages. d3-drag / d3-zoom / d3-selection / d3-interpolate / d3-color are
 * @xyflow's interaction layer and travel with the bot-map page, which is a
 * different problem with a different fix; mislabelling it "charts" would send
 * the next reader down the wrong path.
 */
export const DENIED_BUNDLES = [
  {
    id: 'three',
    label: 'the three.js / 3D stack',
    reason:
      'the 3D backgrounds only mount post-auth, and only when an operator opts into one. ' +
      '~950 KB of WebGL on the login route buys nothing.',
    markers: ['__THREE_DEVTOOLS__', 'THREE.WebGLRenderer'],
    sourcePattern:
      /(?:^|[\\/])node_modules[\\/](?:three|@react-three[\\/][^\\/]+|postprocessing|maath)[\\/]/,
  },
  {
    id: 'charts',
    label: 'the recharts / d3 charting stack',
    reason:
      'every chart lives behind a lazy route (analytics, dashboard, fraud, partners, ' +
      'payments, referrals, advertising, appearance). The login route renders none of them.',
    markers: ['rechartsEventEmitter', 'recharts_measurement_span', 'recharts.syncEvent.tooltip'],
    sourcePattern:
      /(?:^|[\\/])node_modules[\\/](?:recharts|victory-vendor|internmap|d3-(?:array|format|path|scale|shape|time|time-format))[\\/]/,
  },
]

/**
 * Libraries that must exist in EXACTLY ONE emitted chunk, and that chunk must
 * be on the login route's render-blocking graph.
 *
 * This exists because `manualChunks` names are not what rolldown emits.
 * Measured on this tree by sourcemap attribution: `manualChunks` returns
 * `'vendor-react'` for `node_modules/react/index.js`, and React's four
 * entry modules (`index.js`, `jsx-runtime.js`, and both `cjs/*.production.js`)
 * are emitted into `vendor-data` — with zod, axios and react-query — while the
 * chunk actually NAMED `vendor-react` holds react-dom, scheduler and
 * react-router. The same thing happens to `vendor-forms`: no such chunk is
 * emitted at all, and react-hook-form / @hookform/resolvers ride in
 * `vendor-data` too. React reaches `vendor-data` through the CJS interop of
 * its consumers there, exactly as it once reached `vendor-charts`.
 *
 * That is harmless TODAY — one copy, and `vendor-data` is eager — so the
 * chunk names are merely inaccurate. What is not harmless is either of the
 * two ways it can break, and neither is visible from the config:
 *
 *   • TWO copies of React. Two module registries, two `useState` identities:
 *     every hook in the app throws "invalid hook call". A name-based check
 *     cannot see this at all.
 *   • React drifting OFF the render-blocking graph — precisely what a
 *     reasonable-sounding "split zod/axios out of the eager set" would do,
 *     since React travels with them and not with the chunk called after it.
 *
 * So the rule is stated over the emitted graph, where it is true, instead of
 * over the config, where it is not.
 */
export const EAGER_SINGLETONS = [
  {
    id: 'react',
    label: 'React itself (react/index.js + jsx-runtime)',
    reason:
      'main.tsx statically imports React and ReactDOM, so React is render-blocking by ' +
      'construction. Two copies break every hook in the app; zero copies on the eager ' +
      'graph means it followed something lazy out of the login route.',
    sourcePattern:
      /(?:^|[\\/])node_modules[\\/]react[\\/](?:index\.js|jsx-runtime\.js|jsx-dev-runtime\.js|cjs[\\/])/,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsing helpers (unit-tested against fixtures — no build required)
// ─────────────────────────────────────────────────────────────────────────────

const TAG_RE = /<(script|link)\b([^>]*)>/gi
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g

function attributes(raw) {
  const attrs = {}
  let m
  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(raw))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return attrs
}

const isLocal = (href) => Boolean(href) && !/^[a-z]+:/i.test(href) && !href.startsWith('//')

/**
 * Pull the eager asset references out of the built index.html.
 *
 * Attribute-order agnostic on purpose: Vite has reordered `crossorigin` /
 * `rel` / `href` between majors before, and a guard that a formatting change
 * can blind is not a guard.
 *
 * @returns {{ entry: string[], preload: string[], stylesheets: string[] }}
 *          hrefs exactly as written in the HTML (usually root-absolute).
 */
export function parseHtmlAssetRefs(html) {
  const entry = []
  const preload = []
  const stylesheets = []
  let tag
  TAG_RE.lastIndex = 0
  while ((tag = TAG_RE.exec(html))) {
    const [, name, rawAttrs] = tag
    const attrs = attributes(rawAttrs)
    if (name.toLowerCase() === 'script') {
      if (attrs.type === 'module' && isLocal(attrs.src)) entry.push(attrs.src)
      continue
    }
    const rel = (attrs.rel || '').toLowerCase()
    if (rel === 'modulepreload' && isLocal(attrs.href)) preload.push(attrs.href)
    else if (rel === 'stylesheet' && isLocal(attrs.href)) stylesheets.push(attrs.href)
  }
  return { entry, preload, stylesheets }
}

const STATIC_IMPORT_RE = /\bimport\s*(?:[\w*${}\s,]*?\bfrom\s*)?["']([^"']+)["']/g
const RE_EXPORT_RE = /\bexport\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g

/**
 * Specifiers a chunk pulls in EAGERLY: static `import` and re-`export … from`.
 *
 * `import("./x.js")` (a `(` where the regex wants a quote or `from`) and
 * `import.meta` (a `.`) do not match — that is the whole point. Dynamic
 * imports are the lazy routes; counting them would make the budget meaningless.
 */
export function parseStaticImportSpecifiers(code) {
  const found = new Set()
  for (const re of [STATIC_IMPORT_RE, RE_EXPORT_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(code))) found.add(m[1])
  }
  return [...found]
}

// Rolldown emits dynamic chunk specifiers as TEMPLATE literals
// (`await import(\`./ru-CwSLPOkc.js\`)`), so the quote class must include a
// backtick or this finds nothing at all in a real build.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g

/**
 * Specifiers a chunk pulls in LAZILY: `import("./x.js")`.
 *
 * The counterpart of `parseStaticImportSpecifiers`. Almost every hit here is a
 * lazy route and must stay out of the budget; the one exception the caller
 * picks back out is the awaited locale chunk (see RENDER_BLOCKING_LOCALE).
 */
export function parseDynamicImportSpecifiers(code) {
  const found = new Set()
  DYNAMIC_IMPORT_RE.lastIndex = 0
  let m
  while ((m = DYNAMIC_IMPORT_RE.exec(code))) found.add(m[1])
  return [...found]
}

/**
 * Is this a specifier that names a sibling chunk on disk?
 *
 * Spelled out rather than `spec.startsWith('.')` because both spellings occur:
 * rolldown emits `./name.js` between chunks in the same directory and
 * `../name.js` whenever a chunk is emitted into a subdirectory (a
 * `build.assetsDir` change, an emitted worker). A rule that only understood
 * `./` would walk straight past `../vendor-three.js` and report a clean
 * login route while three.js sat on it — and no fixture in this file used to
 * contain a `..` specifier, so the narrower spelling passed every test.
 */
export const isRelativeSpecifier = (spec) =>
  spec.startsWith('./') || spec.startsWith('../')

/**
 * Walk the static-import graph from the seed chunks.
 *
 * `loadChunk(relPath)` returns the chunk source, or null when the path does
 * not name an emitted chunk. Returning null is how bare specifiers and the
 * occasional string literal that merely looks like an import get dropped: a
 * specifier that resolves to nothing on disk cannot be something the browser
 * fetches.
 *
 * @returns {{ chunks: string[], missing: string[] }} chunks in discovery order.
 */
export function walkEagerGraph({ seeds, loadChunk }) {
  const chunks = []
  const seen = new Set()
  const missing = []
  const queue = [...seeds]
  while (queue.length) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)
    const code = loadChunk(rel)
    if (code == null) {
      // A seed came straight out of index.html, so a miss there is a broken
      // build, not a false positive from the import regex.
      if (seeds.includes(rel)) missing.push(rel)
      continue
    }
    chunks.push(rel)
    for (const spec of parseStaticImportSpecifiers(code)) {
      if (!isRelativeSpecifier(spec)) continue
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
      if (!seen.has(resolved)) queue.push(resolved)
    }
  }
  return { chunks, missing }
}

/**
 * Pick the render-blocking locale chunk out of a set of dynamic-import targets.
 *
 * @param {Array<{ rel: string, bytes: number, sources?: string[] }>} candidates
 * @param {typeof RENDER_BLOCKING_LOCALE} rule
 * @returns {{ chunks: typeof candidates, considered: string[] }}
 *          `chunks` holds at most one entry — the worst case (see below).
 */
export function selectRenderBlockingChunks(candidates, rule = RENDER_BLOCKING_LOCALE) {
  const matched = candidates.filter(
    (c) => (c.sources ?? []).some((s) => rule.sourcePattern.test(s)) || rule.namePattern.test(c.rel),
  )
  if (matched.length === 0) return { chunks: [], considered: [] }
  // An operator downloads exactly one of `ru` / `en`, never both, so summing
  // them would invent bytes nobody pays. The honest number for a ceiling is
  // the largest — the worst case a real operator can land on.
  const worst = matched.reduce((a, b) => (b.bytes > a.bytes ? b : a))
  return { chunks: [worst], considered: matched.map((c) => c.rel) }
}

/**
 * Which denied libraries a single chunk contains, and how we know.
 *
 * @param {{ code: string, sources?: string[] }} chunk
 * @param {typeof DENIED_BUNDLES} denied
 * @returns {Array<{ bundle: object, detections: Array<{ detector: string, evidence: string }> }>}
 */
export function inspectChunk({ code, sources = [] }, denied = DENIED_BUNDLES) {
  const hits = []
  for (const bundle of denied) {
    const detections = []
    for (const marker of bundle.markers) {
      if (code.includes(marker)) detections.push({ detector: 'content marker', evidence: marker })
    }
    const matchedSources = sources.filter((s) => bundle.sourcePattern.test(s))
    if (matchedSources.length) {
      const extra = matchedSources.length - 1
      detections.push({
        detector: 'source module',
        evidence: `${matchedSources[0]}${extra ? ` (+${extra} more module${extra === 1 ? '' : 's'})` : ''}`,
      })
    }
    if (detections.length) hits.push({ bundle, detections })
  }
  return hits
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem side
// ─────────────────────────────────────────────────────────────────────────────

const toRel = (href) => href.replace(/^\/+/, '').split('?')[0].split('#')[0]

/** `sources` of a chunk's sourcemap, or [] when the map was not emitted. */
function readChunkSources(distDir, rel) {
  const mapPath = path.join(distDir, `${rel}.map`)
  if (!existsSync(mapPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(mapPath, 'utf8'))
    return Array.isArray(parsed.sources) ? parsed.sources : []
  } catch {
    return []
  }
}

/** Every emitted .js under dist/, relative to dist/, for the liveness scan. */
function allEmittedChunks(distDir) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js'))
        out.push(path.relative(distDir, full).split(path.sep).join('/'))
    }
  }
  walk(distDir)
  return out
}

/**
 * Read a built dist/ and describe the login route's eager payload.
 * Throws (exit code 2) when dist/ is not a usable build.
 */
export function auditDist(distDir) {
  const indexPath = path.join(distDir, 'index.html')
  if (!existsSync(indexPath)) {
    throw new Error(
      `no build output at ${indexPath}\n` +
        `  This guard reads a real build. Run \`npm run build\` first.`,
    )
  }
  const refs = parseHtmlAssetRefs(readFileSync(indexPath, 'utf8'))
  if (refs.entry.length === 0) {
    throw new Error(
      `${indexPath} has no <script type="module"> — the entry chunk could not be identified.`,
    )
  }

  const loadChunk = (rel) => {
    const full = path.join(distDir, rel)
    if (!existsSync(full) || !statSync(full).isFile()) return null
    return readFileSync(full, 'utf8')
  }

  const seeds = [...refs.entry, ...refs.preload].map(toRel)
  const { chunks, missing } = walkEagerGraph({ seeds, loadChunk })
  if (missing.length) {
    throw new Error(
      `index.html references chunks that were not emitted: ${missing.join(', ')}`,
    )
  }

  // The awaited locale chunk: reached by a DYNAMIC import, so the walk above
  // deliberately skipped it, but `main.tsx` blocks the first render on it.
  const staticSet = new Set(chunks)
  const dynamicTargets = new Map()
  for (const rel of chunks) {
    for (const spec of parseDynamicImportSpecifiers(loadChunk(rel) ?? '')) {
      if (!isRelativeSpecifier(spec)) continue
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
      if (staticSet.has(resolved) || dynamicTargets.has(resolved)) continue
      const full = path.join(distDir, resolved)
      if (!existsSync(full) || !statSync(full).isFile()) continue
      dynamicTargets.set(resolved, {
        rel: resolved,
        bytes: statSync(full).size,
        sources: readChunkSources(distDir, resolved),
      })
    }
  }
  const locale = selectRenderBlockingChunks([...dynamicTargets.values()])

  const preloadSet = new Set(refs.preload.map(toRel))
  const entrySet = new Set(refs.entry.map(toRel))
  const describe = (rel, renderBlocking) => ({
    rel,
    bytes: statSync(path.join(distDir, rel)).size,
    // `declared` = named in index.html; `discovered` = only reached by
    // following static imports, i.e. fetched without a preload hint.
    declared: preloadSet.has(rel) || entrySet.has(rel),
    renderBlocking,
    sourcemapped: existsSync(path.join(distDir, `${rel}.map`)),
    hits: inspectChunk(
      { code: readFileSync(path.join(distDir, rel), 'utf8'), sources: readChunkSources(distDir, rel) },
      DENIED_BUNDLES,
    ),
  })
  const eager = [
    ...chunks.map((rel) => describe(rel, false)),
    ...locale.chunks.map((c) => describe(c.rel, true)),
  ]
  eager.sort((a, b) => b.bytes - a.bytes)

  // Liveness: prove each marker set still matches the library somewhere.
  // Same pass locates the singleton libraries by sourcemap attribution — the
  // chunk NAME is exactly the thing that turned out to be untrustworthy.
  const liveness = new Map(DENIED_BUNDLES.map((b) => [b.id, []]))
  const singletons = new Map(EAGER_SINGLETONS.map((s) => [s.id, []]))
  for (const rel of allEmittedChunks(distDir)) {
    const code = readFileSync(path.join(distDir, rel), 'utf8')
    for (const bundle of DENIED_BUNDLES) {
      if (bundle.markers.some((marker) => code.includes(marker))) liveness.get(bundle.id).push(rel)
    }
    const sources = readChunkSources(distDir, rel)
    if (!sources.length) continue
    for (const singleton of EAGER_SINGLETONS) {
      if (sources.some((s) => singleton.sourcePattern.test(s))) singletons.get(singleton.id).push(rel)
    }
  }

  const stylesheetBytes = refs.stylesheets
    .map(toRel)
    .filter((rel) => existsSync(path.join(distDir, rel)))
    .reduce((sum, rel) => sum + statSync(path.join(distDir, rel)).size, 0)

  return {
    distDir,
    eager,
    liveness,
    singletons,
    stylesheetBytes,
    localeConsidered: locale.considered,
    // Derived from what was ACTUALLY counted, not from what was discovered.
    // Reading `locale.chunks` here would attest to the discovery step alone:
    // deleting the locale from the `eager` array above still left this
    // populated, so the guard reported PASS on a total that had silently lost
    // 219,208 B. The rule has to see the audited set.
    renderBlocking: eager.filter((c) => c.renderBlocking).map((c) => c.rel),
    sourcemapped: eager.filter((c) => c.sourcemapped).length,
    totalBytes: eager.reduce((sum, c) => sum + c.bytes, 0),
    undeclared: eager.filter((c) => !c.declared && !c.renderBlocking).map((c) => c.rel),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────

const n = (value) => value.toLocaleString('en-US')

/** @returns {Array<{ rule: string, lines: string[] }>} — empty means pass. */
export function evaluate(report, { byteBudget = EAGER_BYTE_BUDGET, chunkBudget = EAGER_CHUNK_BUDGET } = {}) {
  const failures = []

  for (const chunk of report.eager) {
    for (const { bundle, detections } of chunk.hits) {
      failures.push({
        rule: 'denylist',
        lines: [
          `${chunk.rel} (${n(chunk.bytes)} B) contains ${bundle.label}.`,
          ...detections.map((d) => `    detected by ${d.detector}: ${d.evidence}`),
          `    why this is a bug: ${bundle.reason}`,
          `    rule: no chunk reachable from the entry's STATIC import graph may contain this library.`,
          `    fix: find the rule in vite.config.ts (build.rollupOptions.output.manualChunks) that`,
          `         puts this library in a group the entry reaches, and check what else landed in`,
          `         that group — the last two times, an unrelated package (zustand; React via CJS`,
          `         interop) was the thing dragging it onto /sign-in.`,
        ],
      })
    }
  }

  for (const [id, chunks] of report.liveness) {
    if (chunks.length) continue
    const bundle = DENIED_BUNDLES.find((b) => b.id === id)
    failures.push({
      rule: 'marker-liveness',
      lines: [
        `none of the markers for ${bundle.label} match ANY chunk in ${report.distDir}.`,
        `    markers: ${bundle.markers.map((m) => JSON.stringify(m)).join(', ')}`,
        `    Either the library is no longer in the app — delete its entry in DENIED_BUNDLES —`,
        `    or the markers went stale (a library rename, a new minifier) and the denylist above`,
        `    has been passing without testing anything. Do not "fix" this by deleting the check.`,
      ],
    })
  }

  // Skipped when nothing was audited: `auditDist` already throws in that case,
  // so the only way here is a fixture, and a fixture with no chunks has no
  // opinion about where React sits.
  for (const singleton of report.eager?.length ? EAGER_SINGLETONS : []) {
    const placements = report.singletons?.get(singleton.id) ?? []
    const audited = new Set(report.eager.map((c) => c.rel))
    const offRoute = placements.filter((rel) => !audited.has(rel))

    if (placements.length === 0) {
      failures.push({
        rule: 'singleton/missing',
        lines: [
          `${singleton.label} was not found in ANY chunk in ${report.distDir}.`,
          `    pattern: ${singleton.sourcePattern}`,
          `    Either the package layout changed (update EAGER_SINGLETONS) or sourcemaps are`,
          `    off. Until then this rule is passing without checking anything.`,
        ],
      })
      continue
    }
    if (placements.length > 1) {
      failures.push({
        rule: 'singleton/duplicated',
        lines: [
          `${singleton.label} is emitted into ${placements.length} chunks: ${placements.join(', ')}.`,
          `    why this is a bug: ${singleton.reason}`,
          `    Two copies of React mean two module registries — every hook throws`,
          `    "invalid hook call" the moment both are loaded. Find which manualChunks group`,
          `    each consumer landed in; a library reaching React through CJS interop pulls a`,
          `    private copy into its own group.`,
        ],
      })
      continue
    }
    if (offRoute.length) {
      failures.push({
        rule: 'singleton/off-route',
        lines: [
          `${singleton.label} lives in ${offRoute[0]}, which is NOT on the render-blocking graph.`,
          `    why this is a bug: ${singleton.reason}`,
          `    Note the chunk NAME proves nothing here: on this tree React is emitted into`,
          `    \`vendor-data\`, not into the chunk called \`vendor-react\`. If you moved zod/axios/`,
          `    react-query out of the eager set, React went with them — put it back.`,
        ],
      })
    }
  }

  // The locale chunk is 15% of the audited payload. If it stopped being
  // findable, every number below silently shrank by that much.
  if (!report.renderBlocking?.length) {
    failures.push({
      rule: 'render-blocking-locale',
      lines: [
        `${RENDER_BLOCKING_LOCALE.label} is not in the audited set.`,
        `    dynamic-import candidates that matched: ${report.localeConsidered?.length ? report.localeConsidered.join(', ') : '(none — nothing was recognised as a locale chunk)'}`,
        `    source pattern: ${RENDER_BLOCKING_LOCALE.sourcePattern}`,
        `    name pattern:   ${RENDER_BLOCKING_LOCALE.namePattern}`,
        `    main.tsx blocks createRoot().render() on \`i18nReady\`, so this chunk is downloaded`,
        `    before the login form paints — it belongs in the budget. Either the i18n bootstrap`,
        `    moved (update RENDER_BLOCKING_LOCALE) or the locale is no longer awaited (then say so`,
        `    here and in main.tsx). Do not "fix" this by deleting the check: the budget was set`,
        `    against a total that includes it.`,
      ],
    })
  }

  // The `sourcePattern` half of the denylist reads .map files. Turning
  // `build.sourcemap` off removes it with no other symptom.
  if (report.eager?.length && report.sourcemapped === 0) {
    failures.push({
      rule: 'sourcemap-coverage',
      lines: [
        `not one of the ${report.eager.length} audited chunks has an emitted .map file.`,
        `    The denylist has two detectors. Content markers still run; SOURCE ATTRIBUTION —`,
        `    the precise one, the one that catches a library rolldown copied into a chunk under`,
        `    a different name — silently returns nothing without sourcemaps.`,
        `    Restore \`build.sourcemap\` in vite.config.ts ('hidden' emits .map files without the`,
        `    trailing comment, which is what this guard was built against).`,
      ],
    })
  }

  if (report.totalBytes > byteBudget) {
    failures.push({
      rule: 'budget/bytes',
      lines: [
        `eager payload is ${n(report.totalBytes)} B, over the ${n(byteBudget)} B ceiling by ${n(report.totalBytes - byteBudget)} B.`,
        `    biggest eager chunks:`,
        ...report.eager.slice(0, 5).map((c) => `      ${String(n(c.bytes)).padStart(11)} B  ${c.rel}`),
        `    Everything listed above is downloaded before the login form is usable. If a chunk`,
        `    there is only needed after auth, it belongs behind a dynamic import or its own`,
        `    manualChunks group — see the two worked examples in vite.config.ts.`,
      ],
    })
  }

  if (report.eager.length > chunkBudget) {
    failures.push({
      rule: 'budget/chunks',
      lines: [
        `${report.eager.length} eager chunks, over the ceiling of ${chunkBudget}.`,
        `    ${report.eager.map((c) => c.rel).join('\n    ')}`,
      ],
    })
  }

  return failures
}

export function formatReport(report, failures) {
  const lines = []
  lines.push('')
  lines.push('build-graph guard — render-blocking payload of the login route')
  lines.push(
    `  source: ${path.join(report.distDir, 'index.html')} (entry chunk + its static-import closure` +
      ` + the locale chunk main.tsx awaits)`,
  )
  lines.push('')
  for (const chunk of report.eager) {
    const flags = [
      chunk.renderBlocking ? 'AWAITED BEFORE FIRST PAINT' : '',
      chunk.declared || chunk.renderBlocking ? '' : 'NO PRELOAD HINT',
      ...chunk.hits.map((h) => `DENIED: ${h.bundle.id}`),
    ].filter(Boolean)
    lines.push(
      `  ${String(n(chunk.bytes)).padStart(11)} B  ${chunk.rel}${flags.length ? `   ← ${flags.join(', ')}` : ''}`,
    )
  }
  lines.push(`  ${'—'.repeat(11)}`)
  lines.push(
    `  ${String(n(report.totalBytes)).padStart(11)} B  across ${report.eager.length} chunks` +
      `   (budget: ${n(EAGER_BYTE_BUDGET)} B / ${EAGER_CHUNK_BUDGET} chunks)`,
  )
  if (report.localeConsidered?.length > 1) {
    lines.push(
      `               locale candidates: ${report.localeConsidered.join(', ')} — largest counted,` +
        ` an operator downloads exactly one.`,
    )
  }
  if (report.stylesheetBytes) {
    lines.push(
      `  ${String(n(report.stylesheetBytes)).padStart(11)} B  eager CSS — reported, NOT budgeted:`,
    )
    lines.push(`               these ceilings govern the JS module graph only.`)
  }
  if (report.undeclared.length) {
    lines.push('')
    lines.push(
      `  note: ${report.undeclared.length} chunk(s) are statically imported by the entry but have no`,
    )
    lines.push(`  <link rel="modulepreload"> in index.html, so the browser discovers them a round trip`)
    lines.push(`  late: ${report.undeclared.join(', ')}`)
  }

  if (failures.length === 0) {
    lines.push('')
    lines.push(`  PASS — no denied library on the login route, payload within budget.`)
    lines.push('')
    return lines.join('\n')
  }

  lines.push('')
  lines.push(`  FAIL — ${failures.length} rule violation${failures.length === 1 ? '' : 's'}:`)
  lines.push('')
  for (const failure of failures) {
    lines.push(`  [${failure.rule}] ${failure.lines[0]}`)
    for (const extra of failure.lines.slice(1)) lines.push(`  ${extra}`)
    lines.push('')
  }
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const flagIndex = argv.indexOf('--dist')
  const distDir = path.resolve(webRoot, flagIndex === -1 ? 'dist' : (argv[flagIndex + 1] ?? 'dist'))

  let report
  try {
    report = auditDist(distDir)
  } catch (error) {
    console.error(`\nbuild-graph guard — cannot read the build\n  ${error.message}\n`)
    return 2
  }
  const failures = evaluate(report)
  const text = formatReport(report, failures)
  if (failures.length) console.error(text)
  else console.log(text)
  return failures.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
