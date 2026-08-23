/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false, // own manifest.webmanifest in public/
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        // Admin bundles (charts/three) exceed the 2 MiB default; raise the cap
        // so the precache manifest isn't silently truncated.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    sourcemap: 'hidden',
    // `vendor-three` (950,826 B raw / 249,022 B gzip in this tree) is the
    // largest vendor bundle and is only ever pulled in when an operator
    // opts into a heavy 3D background. We raise the warning threshold past
    // it so the rest of the build output stays signal-noise free.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            // Country-flag assets are emitted as URL strings via
            // `import.meta.glob`, so they don't show up here. The page-level
            // dictionary that maps "DE" → "/assets/DE-…svg" is small and
            // can stay co-located with the Remnawave page chunk.

            // ── State layer (zustand + its use-sync-external-store shim).
            // MUST be split out explicitly: zustand is shared between the
            // always-loaded app stores (auth/glass/appearance) and
            // @react-three/fiber, so without a rule of its own rolldown
            // buckets it into `vendor-three` — which made the eager
            // `admin-session` chunk drag ~950 KB of three.js onto the
            // login route. A dedicated ~12 KB chunk keeps the state layer
            // eager and the 3D stack lazy. (Nested copies, e.g.
            // @xyflow/react's own zustand, land here too — a few KB of
            // duplication is cheaper than another accidental 3D pull.)
            if (id.includes('/zustand/') || id.includes('use-sync-external-store')) {
              return 'vendor-state'
            }

            // ── 3D / GPU-effects libraries — only loaded when the
            // operator turns on a React-Bits background. Keep them
            // out of the core bundle entirely.
            // `ogl` is a tiny standalone WebGL lib used by the DEFAULT
            // `liquidChrome` background — keep it out of the heavy three.js
            // chunk so turning that background on pulls ~60 KB, not ~950 KB.
            // (Since the background only mounts post-auth, the login route
            // itself loads none of these.)
            if (id.includes('/ogl/')) {
              return 'vendor-ogl'
            }
            if (
              id.includes('/three/') ||
              id.includes('@react-three/') ||
              id.includes('/postprocessing/') ||
              id.includes('/maath/')
            ) {
              return 'vendor-three'
            }
            if (id.includes('/gsap/') || id.includes('@gsap/react')) {
              return 'vendor-gsap'
            }
            // React core. Match whole path segments — a bare '/react/'
            // also matches scoped packages named "react" (@xyflow/react,
            // @number-flow/react), which used to drag React Flow into this
            // always-preloaded chunk instead of the lazy bot-map page.
            //
            // ⚠ THIS NAME IS NOT WHERE REACT ENDS UP. Measured on this tree by
            // sourcemap attribution: the emitted `vendor-react` chunk holds
            // react-dom, scheduler and react-router. React ITSELF —
            // react/index.js, react/jsx-runtime.js and both cjs/*.production.js
            // — is emitted into `vendor-data`, reached through the CJS interop
            // of react-query and react-hook-form, exactly the mechanism that
            // once put React in `vendor-charts`. (`vendor-forms` below is the
            // same story and is not emitted as a chunk at all: react-hook-form
            // and @hookform/resolvers ride in `vendor-data` too.)
            //
            // Harmless today — one copy, and `vendor-data` is eager, so React
            // is still render-blocking as it must be. It stops being harmless
            // the moment someone "splits zod/axios out of the eager set": React
            // travels with THEM, not with the chunk named after it, and would
            // follow them into a lazy chunk. `scripts/check-build-graph.mjs`
            // states that invariant over the EMITTED graph (EAGER_SINGLETONS:
            // exactly one copy, on the render-blocking graph) because that is
            // where it is true. Do not trust these names; re-run
            // `npm run check:build-graph` after touching any group below.
            if (
              /\/node_modules\/(?:react|react-dom|scheduler)\//.test(id) ||
              id.includes('react-router')
            ) {
              return 'vendor-react'
            }
            // Data layer. Must stay EAGER: React is emitted into this chunk
            // (see above), so making it lazy takes React off the login route.
            if (
              id.includes('@tanstack/react-query') ||
              id.includes('/zod/') ||
              id.includes('/axios/')
            ) {
              return 'vendor-data'
            }
            // Radix UI primitives
            if (id.includes('@radix-ui/')) {
              return 'vendor-ui'
            }
            // ── Charts: deliberately NOT a manual chunk.
            // recharts/d3/victory are only imported by lazy route chunks
            // (analytics, dashboard, fraud, partners, payments, referrals,
            // advertising, appearance), so rolldown already emits them as
            // shared chunks reachable only from those routes.
            // Forcing them into one `vendor-charts` group did the opposite:
            // recharts pulls React through CJS interop, rolldown copies
            // React's CJS entry into the group, and the entry chunk then
            // binds two of its React imports to that copy — which made the
            // 449 KB chart bundle a `modulepreload` on the login route.
            // Measured on this tree: dropping the group takes the eager
            // login payload from 1,695,875 B raw / 499,321 B gzip across 13
            // chunks to 1,259,928 B / 375,533 B across 12, for +3.6 KB of
            // total build output. Do not "tidy" this back into a group
            // without re-checking dist/index.html's preload list.
            // Forms
            if (id.includes('react-hook-form') || id.includes('@hookform/')) {
              return 'vendor-forms'
            }
            // i18n
            if (id.includes('i18next') || id.includes('react-i18next')) {
              return 'vendor-i18n'
            }
            // Date helpers
            if (id.includes('date-fns') || id.includes('react-day-picker')) {
              return 'vendor-dates'
            }
            // Icons — heavy because of tree-shaking quirks across pages
            if (id.includes('lucide-react') || id.includes('react-icons')) {
              return 'vendor-icons'
            }
            // Animation primitive (Motion / framer-motion-fork)
            if (id.includes('/motion/') || id.includes('motion-dom') || id.includes('motion-utils')) {
              return 'vendor-motion'
            }
            // Remaining UI utilities
            if (
              id.includes('class-variance-authority') ||
              id.includes('clsx') ||
              id.includes('tailwind-merge') ||
              id.includes('sonner') ||
              id.includes('cmdk') ||
              id.includes('vaul')
            ) {
              return 'vendor-ui-utils'
            }
          }
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup-tests.ts'],
    // ── Worker cap. The problem here is OVERSUBSCRIPTION, not parallelism. ──
    //
    // Uncapped, vitest takes one worker per core (16 here) and each one pays
    // for its own jsdom and its own copy of the module graph. Measured on this
    // tree, 201 files, on an OTHERWISE IDLE machine — the cumulative figures
    // are vitest's own, summed across workers:
    //
    //     workers   wall     transform+import+tests+environment
    //        4      111s      ~301s
    //        8       69s      ~365s
    //       16       64s      ~910s
    //
    // Read the right-hand column before "optimising" the left one. Going from
    // 8 to 16 does roughly 2.5x the actual work to run the same 3239 tests —
    // sixteen jsdom environments and sixteen module graphs — and buys 5s, and
    // only buys it when all sixteen cores happen to be idle. That is the
    // exception, not the rule: the same machine is also running this repo's
    // backend suite, a build, an editor, or a second copy of this suite. On a
    // machine already busy the uncapped run went RED —
    // referral-eligible-plans-catalog blew its `findByRole` timeout waiting
    // for a chip that renders in ~2s in isolation, and another run put a
    // branding test at 76s. Nothing is wrong with those tests; every `waitFor`
    // in the suite is racing a machine that has been oversold.
    //
    // 8 leaves half the box free, which is what actually stops those timeouts,
    // and gives up 5s against uncapped to do it. 4 was measured too and is not
    // chosen: it buys safety beyond what the contention needs and costs 42s on
    // an idle machine — nearly double 8 — for no observed stability gain.
    //
    // Tune this for a developer running the suite, not for whatever is
    // saturating the machine this week. A number picked while several other
    // processes were hammering the box is an anecdote, not a measurement; the
    // table above was taken on an idle one, and so should its replacement be.
    //
    // ⚠ The symptom that costs the most time to diagnose: when a worker dies
    // under memory pressure, vitest's summary reads
    //
    //     Test Files  214 passed (215)
    //
    // — a total one higher than the passed count, with NOTHING listed as
    // failed and, depending on the reporter, exit code 0. That gap is a test
    // file whose worker was killed, not a file that passed. If you ever see
    // `N passed (N+1)`, you are looking at a dead worker, not a green run;
    // re-run with a lower cap rather than trusting the summary.
    //
    // An explicit `--maxWorkers` on the command line still wins — CLI options
    // override the config file — so bisecting with 1, 4 or 16 needs no edit
    // here.
    maxWorkers: 8,
    // jsdom + Recharts/userEvent heavy specs occasionally exceed the 5s default
    // under parallel worker contention (they finish in ~2s in isolation). A
    // genuinely hung test still fails — this just matches the threshold to the
    // environment so CI isn't flaky.
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 60,
        branches: 60,
        functions: 60,
        statements: 60,
      },
      exclude: [
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        '**/*.d.ts',
        'node_modules/**',
      ],
    },
  },
})
