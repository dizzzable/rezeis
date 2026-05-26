/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // three.js (~720 KB) is the largest vendor bundle and is only ever
    // pulled in when an operator opts into a heavy 3D background. We
    // raise the warning threshold past it so the rest of the build
    // output stays signal-noise free.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            // Country-flag assets are emitted as URL strings via
            // `import.meta.glob`, so they don't show up here. The page-level
            // dictionary that maps "DE" → "/assets/DE-…svg" is small and
            // can stay co-located with the Remnawave page chunk.

            // ── 3D / GPU-effects libraries — only loaded when the
            // operator turns on a React-Bits background. Keep them
            // out of the core bundle entirely.
            if (
              id.includes('/three/') ||
              id.includes('@react-three/') ||
              id.includes('/postprocessing/') ||
              id.includes('/ogl/') ||
              id.includes('/maath/')
            ) {
              return 'vendor-three'
            }
            if (id.includes('/gsap/') || id.includes('@gsap/react')) {
              return 'vendor-gsap'
            }
            // React core
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('react-router-dom') ||
              id.includes('scheduler')
            ) {
              return 'vendor-react'
            }
            // Data layer
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
            // Charts (heavy)
            if (id.includes('recharts') || id.includes('d3-') || id.includes('victory')) {
              return 'vendor-charts'
            }
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
  },
})
