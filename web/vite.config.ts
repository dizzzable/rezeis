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
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            // React core
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('react-router-dom') || id.includes('scheduler')) {
              return 'vendor-react'
            }
            // Data layer
            if (id.includes('@tanstack/react-query') || id.includes('/zod/') || id.includes('/axios/')) {
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
            // Remaining UI utilities
            if (id.includes('class-variance-authority') || id.includes('clsx') || id.includes('tailwind-merge') || id.includes('sonner') || id.includes('lucide-react')) {
              return 'vendor-ui-utils'
            }
          }
          // i18n locale dictionaries — large JSON-like objects
          if (id.includes('/i18n/ru.ts') || id.includes('/i18n/en.ts')) {
            return 'locales'
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
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup-tests.ts'],
  },
})
