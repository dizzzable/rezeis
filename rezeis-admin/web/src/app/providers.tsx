import type { JSX, ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { I18nProvider } from '@/i18n/provider'
import { queryClient } from '@/lib/query-client'

interface ProvidersProps {
  readonly children: ReactNode
}

export function Providers({ children }: ProvidersProps): JSX.Element {
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster richColors position="top-right" />
      </QueryClientProvider>
    </I18nProvider>
  )
}
