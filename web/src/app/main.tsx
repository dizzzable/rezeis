import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from '@/features/auth/auth-provider'
import { ThemeProvider } from '@/lib/theme/theme-provider'
import { AppearanceProvider } from '@/components/AppearanceProvider'
import { MotionRoot } from '@/lib/motion'
import { I18nProvider } from '@/i18n/provider'
import { LocaleBootstrapper } from '@/i18n/locale-bootstrapper'
import { installClientLogger } from '@/lib/client-logger'
import { router } from './router'
import '../index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1 minute
      retry: 1,
    },
  },
})

installClientLogger()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppearanceProvider>
          <MotionRoot>
            <I18nProvider>
              <LocaleBootstrapper>
                <TooltipProvider delayDuration={300}>
                  <AuthProvider>
                    <RouterProvider router={router} />
                    <Toaster richColors position="top-right" />
                    <ReactQueryDevtools initialIsOpen={false} />
                  </AuthProvider>
                </TooltipProvider>
              </LocaleBootstrapper>
            </I18nProvider>
          </MotionRoot>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
