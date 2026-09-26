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
 *     contain the three.js stack, the recharts/d3 charting stack, or the admin
 *     shell and the libraries only it uses (dnd-kit, socket.io, the Radix
 *     primitives beyond the tooltip, cmdk). Matched by
 *     CONTENT (library-internal marker strings) and by SOURCE ATTRIBUTION (the
 *     `sources` array of the emitted sourcemap), never by chunk name: the
 *     chunk NAME is exactly what changed when the `vendor-charts` group was
 *     deleted, so a name-based rule would evaporate at the moment it matters.
 *     The same denylist also covers the SIGN-IN PAGE chunk and its static
 *     imports: fetched after first paint (so outside the budget), but still
 *     downloaded on /sign-in — see SIGN_IN_PAGE.
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
//   after the charts fix       1,479,136 B  (1,259,928 static + locale) / 13 chunks
//   0.9.7.70 (2026-09-25)      1,688,272 B  (1,334,178 static + 354,094 ru) / 14 chunks
//   lazy admin shell           1,391,834 B  (1,037,740 static + 354,094 ru) / 12 chunks
//   + the shell warm-up        1,392,439 B  (1,038,253 static + 354,186 ru) / 12 chunks
//   CURRENT — + reload guard   1,393,616 B  (1,039,430 static + 354,186 ru) / 12 chunks
//
// The climb to 0.9.7.70 left 11,728 B of headroom. Most of it was the admin
// shell — the frame around every signed-in page — imported statically by the
// router, with dnd-kit, socket.io and the Radix menus behind it; the shell is
// lazy now, and DENIED_BUNDLES below keeps it and those libraries off the
// route. The ceiling was deliberately NOT lowered to bank the gain: it is the
// goal the budget was set against, and the headroom (307,561 B) is what the
// next legitimate feature spends.
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
 * The chunk the router loads for /sign-in, and everything it imports
 * statically.
 *
 * NOT budgeted: it is fetched after first paint through the router's
 * `lazy()`, and the budget has always described the render-blocking graph.
 * But it IS downloaded on /sign-in before the form appears, so DENIED_BUNDLES
 * applies to it as well. Without that a denied library could leave the
 * render-blocking graph and still be downloaded on the route — which is what
 * happened in the very build that made the admin shell lazy: the whole
 * `vendor-ui` group (Select, the menus, Dialog — ~110 KB) came back with the
 * sign-in page, because the form's label and separator lived in that group.
 *
 * Discovered the way the locale is: sourcemap attribution first
 * (`src/features/auth/sign-in-page.tsx` exactly), the emitted name as the
 * fallback. If neither finds it, `evaluate` fails rather than audit nothing.
 */
export const SIGN_IN_PAGE = {
  id: 'sign-in-page',
  label: 'the sign-in page chunk app/router.tsx loads for /sign-in',
  sourcePattern: /(?:^|[\\/])src[\\/]features[\\/]auth[\\/]sign-in-page\.tsx$/,
  namePattern: /(?:^|\/)sign-in-page-[^/]*\.js$/,
}

/**
 * The admin shell may be imported lazily in exactly ONE place.
 *
 * The shell left the login route by becoming lazy, and lazy must not mean late.
 * So its download starts at boot when the first screen is the shell, or on the
 * sign-in form's first sign of intent. All of that goes through one
 * `import()` in `app/admin-shell-loader.ts`: the router renders
 * `adminShell.Component`, and the warm-ups call `adminShell.preload()`.
 *
 * The walker above ignores dynamic imports by design — they are the lazy
 * routes — and that leaves one blind spot. A second `import()` of the shell
 * would fetch it on /sign-in and the budget would never see it: say a warm-up
 * on mount instead of on intent, or a `void import()` at boot. So the rule is
 * stated over the emitted code. Every dynamic import in `dist/` that resolves
 * to the chunk carrying `admin-shell.tsx` is attributed to its source module
 * through the sourcemap, at the position of the `import(`. There must be
 * exactly one, and it must come from the loader. A static import of the shell
 * is the denylist's job (DENIED_BUNDLES → admin-shell) and fails there.
 */
export const ADMIN_SHELL_WARMUP = {
  id: 'admin-shell/import',
  label: 'the one dynamic import of the admin shell',
  shellPattern: /(?:^|[\\/])src[\\/]components[\\/]layout[\\/]admin-shell\.tsx$/,
  loaderPattern: /(?:^|[\\/])src[\\/]app[\\/]admin-shell-loader\.ts$/,
  loader: 'src/app/admin-shell-loader.ts',
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
 * `fix`, where present, replaces the generic advice in the failure message
 * (look for the manualChunks group that carried the library in). For the
 * admin shell the usual cause is a plain static import, so it says that.
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
  // ── The admin shell, and what only it brought onto the route ──────────────
  //
  // Until 0.9.7.70 `app/router.tsx` imported the shell statically, so /sign-in
  // downloaded the frame of every signed-in page — and the four libraries
  // below with it — before its form could paint. Making the shell lazy, and
  // taking out of the eager manualChunks groups what only it used, cut the
  // route from 1,688,272 B to 1,391,834 B, at a moment when 11,728 B of
  // budget were left. Each
  // library has an entry of its own, not only the shell, because each can
  // come back WITHOUT the shell: one eager component that opens a Select, or
  // a module put back into a manualChunks group the entry reaches (the
  // `app-core` and `vendor-ui-utils` groups in vite.config.ts carried the
  // Radix dialog and cmdk onto the route exactly that way). Every marker was
  // checked against a real dist/ to match only the chunk that holds its
  // library by sourcemap.
  {
    id: 'admin-shell',
    label: 'the admin shell (sidebar, topbar, quick search)',
    reason:
      'the frame only renders behind a verified session. app/router.tsx loads it with lazy(); ' +
      'a static import of admin-shell — or of anything under admin-sidebar/, admin-topbar/ or ' +
      'quick-search/ — from a module the entry reaches brings the frame back.',
    fix: [
      `find the static import: from the entry, only app/router.tsx should name admin-shell,`,
      `and only inside lazy(). Something the entry imports statically (a provider, the router,`,
      `a store) now imports the shell or one of its parts.`,
    ],
    // A first-party string that only admin-shell.tsx carries (its session key
    // for the push re-sync). Minification keeps string literals.
    markers: ['rezeis_admin_push_resync'],
    sourcePattern:
      /(?:^|[\\/])src[\\/]components[\\/](?:layout[\\/](?:admin-shell\.tsx$|admin-sidebar[\\/]|admin-topbar[\\/])|quick-search[\\/])/,
  },
  {
    id: 'dnd-kit',
    label: 'dnd-kit (drag and drop)',
    reason: 'the sidebar reorders its items after sign-in; the login route has nothing to drag.',
    markers: ['DndDescribedBy', 'DndLiveRegion'],
    sourcePattern: /(?:^|[\\/])node_modules[\\/]@dnd-kit[\\/]/,
  },
  {
    id: 'socket-io',
    label: 'the socket.io / engine.io realtime client',
    reason: 'the realtime socket opens inside the admin shell, after the session is verified.',
    markers: ['upgradeError', 'pollComplete'],
    sourcePattern:
      /(?:^|[\\/])node_modules[\\/](?:socket\.io-client|socket\.io-parser|engine\.io-client|engine\.io-parser)[\\/]/,
  },
  {
    // The tooltip and what it is built on (popper, dismissable layer, portal,
    // presence, slot…) ARE on the route, legitimately: `TooltipProvider` sits
    // in providers.tsx. The pattern names the primitives that are not, and
    // only those — any of them on the route means the whole `vendor-ui`
    // group (88 KB at 0.9.7.70) came back with it.
    id: 'radix-kit',
    label: 'the Radix primitives beyond the tooltip (select, menus, dialogs, scroll areas…)',
    reason:
      'the login form uses none of them. Each lives in the vendor-ui group, so one eager ' +
      'import of any of them puts the whole group on the route.',
    markers: ['SelectItemAlignedPosition', 'MenuSubContent', 'DialogOverlay'],
    sourcePattern:
      /(?:^|[\\/])node_modules[\\/]@radix-ui[\\/]react-(?:select|menu|dropdown-menu|scroll-area|slider|popover|dialog|alert-dialog|checkbox|radio-group|switch|tabs|collapsible|progress|avatar)[\\/]/,
  },
  {
    id: 'cmdk',
    label: 'cmdk (command palette)',
    reason: 'only the plan form and the timezone picker use it, both on lazy routes.',
    markers: ['cmdk-list-sizer', 'cmdk-item-select'],
    sourcePattern: /(?:^|[\\/])node_modules[\\/]cmdk[\\/]/,
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
 * Every dynamic import in `code`, with the offset of its `import(`.
 *
 * Unlike `parseDynamicImportSpecifiers` this keeps duplicates: two `import()`
 * expressions of the same chunk are two import sites, and ADMIN_SHELL_WARMUP
 * counts sites.
 *
 * @returns {Array<{ spec: string, index: number }>}
 */
export function findDynamicImports(code) {
  const found = []
  const re = new RegExp(DYNAMIC_IMPORT_RE.source, 'g')
  let m
  while ((m = re.exec(code))) found.push({ spec: m[1], index: m.index })
  return found
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** One sourcemap segment (`"AAgBC"`) → its fields, still delta-encoded. */
function decodeVlqSegment(segment) {
  const fields = []
  let value = 0
  let shift = 0
  for (const char of segment) {
    const digit = BASE64.indexOf(char)
    if (digit === -1) return fields
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
      continue
    }
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  return fields
}

/**
 * The source module a position in an emitted chunk came from.
 *
 * Walks the sourcemap's `mappings` up to the position's line and takes the
 * last segment that starts at or before its column. The source index in a
 * segment is a delta from the previous segment ANYWHERE in the map, not only on
 * the same line, so every earlier line has to be read, even though only its
 * source indices matter.
 *
 * @param {{ sources?: string[], mappings?: string } | null} map
 * @param {string} code  the chunk exactly as emitted
 * @param {number} index offset in `code` (UTF-16, i.e. a JS string index)
 * @returns {string | null} the `sources` entry, or null when unmapped
 */
export function sourceAtOffset(map, code, index) {
  if (!map || typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return null
  let line = 0
  let lineStart = 0
  for (let nl = code.indexOf('\n'); nl !== -1 && nl < index; nl = code.indexOf('\n', nl + 1)) {
    line += 1
    lineStart = nl + 1
  }
  const column = index - lineStart
  const lines = map.mappings.split(';')
  let sourceIndex = 0
  let found = null
  for (let l = 0; l <= line && l < lines.length; l++) {
    let generatedColumn = 0
    for (const segment of lines[l].split(',')) {
      if (!segment) continue
      const fields = decodeVlqSegment(segment)
      generatedColumn += fields[0] ?? 0
      if (fields.length >= 4) sourceIndex += fields[1]
      if (l !== line) continue
      if (generatedColumn > column) return found
      found = fields.length >= 4 ? (map.sources[sourceIndex] ?? null) : null
    }
  }
  return found
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

/** A chunk's parsed sourcemap, or null when it was not emitted or is unreadable. */
function readChunkMap(distDir, rel) {
  const mapPath = path.join(distDir, `${rel}.map`)
  if (!existsSync(mapPath)) return null
  try {
    return JSON.parse(readFileSync(mapPath, 'utf8'))
  } catch {
    return null
  }
}

/** `sources` of a chunk's sourcemap, or [] when the map was not emitted. */
function readChunkSources(distDir, rel) {
  const parsed = readChunkMap(distDir, rel)
  return parsed && Array.isArray(parsed.sources) ? parsed.sources : []
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

  // The sign-in page and what it imports statically — downloaded on /sign-in
  // after first paint. Denylist only; see SIGN_IN_PAGE. `null` means it could
  // not be found, which `evaluate` reports instead of auditing nothing.
  const signInEntry = [...dynamicTargets.values()].find(
    (c) => c.sources.some((s) => SIGN_IN_PAGE.sourcePattern.test(s)) || SIGN_IN_PAGE.namePattern.test(c.rel),
  )
  const audited = new Set(eager.map((c) => c.rel))
  const signInPage = signInEntry
    ? walkEagerGraph({ seeds: [signInEntry.rel], loadChunk })
        .chunks.filter((rel) => !audited.has(rel))
        .map((rel) => ({
          rel,
          bytes: statSync(path.join(distDir, rel)).size,
          hits: inspectChunk(
            { code: readFileSync(path.join(distDir, rel), 'utf8'), sources: readChunkSources(distDir, rel) },
            DENIED_BUNDLES,
          ),
        }))
        .sort((a, b) => b.bytes - a.bytes)
    : null

  // Liveness: prove each marker set still matches the library somewhere.
  // Same pass locates the singleton libraries by sourcemap attribution — the
  // chunk NAME is exactly the thing that turned out to be untrustworthy.
  const liveness = new Map(DENIED_BUNDLES.map((b) => [b.id, []]))
  const singletons = new Map(EAGER_SINGLETONS.map((s) => [s.id, []]))
  // Same pass: where the admin shell lives, and every dynamic import site in
  // dist/ (ADMIN_SHELL_WARMUP). Filtered down to the shell after the loop,
  // since the shell's chunk is only known once every map has been read.
  const shellChunks = []
  const dynamicSites = []
  for (const rel of allEmittedChunks(distDir)) {
    const code = readFileSync(path.join(distDir, rel), 'utf8')
    for (const bundle of DENIED_BUNDLES) {
      if (bundle.markers.some((marker) => code.includes(marker))) liveness.get(bundle.id).push(rel)
    }
    for (const { spec, index } of findDynamicImports(code)) {
      if (!isRelativeSpecifier(spec)) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
      dynamicSites.push({ from: rel, target, index })
    }
    const sources = readChunkSources(distDir, rel)
    if (!sources.length) continue
    for (const singleton of EAGER_SINGLETONS) {
      if (sources.some((s) => singleton.sourcePattern.test(s))) singletons.get(singleton.id).push(rel)
    }
    if (sources.some((s) => ADMIN_SHELL_WARMUP.shellPattern.test(s))) shellChunks.push(rel)
  }
  const shellSet = new Set(shellChunks)
  const shellImports = dynamicSites
    .filter((site) => shellSet.has(site.target))
    .map((site) => ({
      from: site.from,
      target: site.target,
      origin: sourceAtOffset(
        readChunkMap(distDir, site.from),
        readFileSync(path.join(distDir, site.from), 'utf8'),
        site.index,
      ),
    }))

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
    signInPage,
    adminShell: { chunks: shellChunks, imports: shellImports },
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
          ...(bundle.fix
            ? bundle.fix.map((line, i) => `    ${i === 0 ? 'fix: ' : '     '}${line}`)
            : [
                `    fix: find the rule in vite.config.ts (build.rollupOptions.output.manualChunks) that`,
                `         puts this library in a group the entry reaches, and check what else landed in`,
                `         that group — the last two times, an unrelated package (zustand; React via CJS`,
                `         interop) was the thing dragging it onto /sign-in. If no group explains it, look`,
                `         for a static import of it from a module the entry reaches.`,
              ]),
        ],
      })
    }
  }

  // The sign-in page's own imports: outside the budget, not outside the route.
  for (const chunk of report.signInPage ?? []) {
    for (const { bundle, detections } of chunk.hits) {
      failures.push({
        rule: 'denylist/sign-in-page',
        lines: [
          `${chunk.rel} (${n(chunk.bytes)} B) contains ${bundle.label}, and the sign-in page imports it.`,
          ...detections.map((d) => `    detected by ${d.detector}: ${d.evidence}`),
          `    why this is a bug: ${bundle.reason}`,
          `    It is not render-blocking, so the budget does not count it — but the sign-in page`,
          `    chunk imports it statically, so every visit to /sign-in downloads it before the form`,
          `    appears.`,
          `    fix: find what the sign-in page shares with it. Last time it was a manualChunks group`,
          `         (vite.config.ts) holding both a primitive the form draws and this library — the`,
          `         form's label and separator sat in \`vendor-ui\` with Select, the menus and Dialog.`,
        ],
      })
    }
  }

  // `null` — not merely empty — means auditDist looked and found no sign-in
  // page. Fixtures that never set the field have no opinion about it.
  if (report.signInPage === null) {
    failures.push({
      rule: 'sign-in-page',
      lines: [
        `${SIGN_IN_PAGE.label} was not found among the entry's dynamic imports.`,
        `    source pattern: ${SIGN_IN_PAGE.sourcePattern}`,
        `    name pattern:   ${SIGN_IN_PAGE.namePattern}`,
        `    The denylist audits what that chunk imports, because /sign-in downloads it. Either the`,
        `    page moved or was renamed (update SIGN_IN_PAGE) or the router stopped loading it`,
        `    lazily. Do not "fix" this by deleting the check: without it a denied library can leave`,
        `    the render-blocking graph and still be downloaded on the route.`,
      ],
    })
  }

  // The admin shell: exactly one dynamic import, from the loader. Fixtures that
  // never set the field have no opinion about it.
  const shell = report.adminShell
  if (shell) {
    const { imports } = shell
    const fromLoader = imports.filter((site) => ADMIN_SHELL_WARMUP.loaderPattern.test(site.origin ?? ''))
    const describeSite = (site) =>
      `      ${site.from} → ${site.target}   (from ${site.origin ?? 'an unmapped position'})`
    if (shell.chunks.length === 0) {
      failures.push({
        rule: ADMIN_SHELL_WARMUP.id,
        lines: [
          `the admin shell (${ADMIN_SHELL_WARMUP.shellPattern}) was not found in any chunk's sourcemap.`,
          `    Either admin-shell.tsx moved or was renamed (update ADMIN_SHELL_WARMUP), or sourcemaps are`,
          `    off. Until then this rule checks nothing.`,
        ],
      })
    } else if (imports.length === 0) {
      failures.push({
        rule: ADMIN_SHELL_WARMUP.id,
        lines: [
          `no dynamic import of the admin shell (${shell.chunks.join(', ')}) was found.`,
          `    The shell is meant to load through ONE import() in ${ADMIN_SHELL_WARMUP.loader}.`,
          `    If the denylist above names the shell, it was imported statically: that is the bug.`,
          `    Otherwise the loader moved or was renamed — update ADMIN_SHELL_WARMUP.`,
        ],
      })
    } else if (imports.length > 1 || fromLoader.length !== 1) {
      failures.push({
        rule: ADMIN_SHELL_WARMUP.id,
        lines: [
          `the admin shell is imported dynamically from ${imports.length} place${imports.length === 1 ? '' : 's'}, and only ${ADMIN_SHELL_WARMUP.loader} may do it:`,
          ...imports.map(describeSite),
          `    why this is a bug: every other import() is another way for the shell to be fetched —`,
          `    e.g. on mount of the sign-in page — and the budget cannot see a dynamic import. The router`,
          `    renders adminShell.Component and the warm-ups call adminShell.preload(); use those.`,
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
  if (report.signInPage?.length) {
    lines.push('')
    lines.push(`  loaded with the sign-in page after first paint — denylist only, NOT budgeted:`)
    for (const chunk of report.signInPage) {
      const flags = chunk.hits.map((h) => `DENIED: ${h.bundle.id}`)
      lines.push(
        `  ${String(n(chunk.bytes)).padStart(11)} B  ${chunk.rel}${flags.length ? `   ← ${flags.join(', ')}` : ''}`,
      )
    }
    const pageBytes = report.signInPage.reduce((sum, c) => sum + c.bytes, 0)
    lines.push(`  ${'—'.repeat(11)}`)
    lines.push(`  ${String(n(pageBytes)).padStart(11)} B  across ${report.signInPage.length} chunks`)
  }
  if (report.adminShell?.imports.length) {
    lines.push('')
    lines.push(`  admin shell — dynamic import sites (exactly one allowed, from ${ADMIN_SHELL_WARMUP.loader}):`)
    for (const site of report.adminShell.imports) {
      lines.push(`               ${site.from} → ${site.target}   (from ${site.origin ?? 'an unmapped position'})`)
    }
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
