import type { ReactElement, ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { render, type RenderResult } from '@testing-library/react'
import { createQueryClient } from '@/lib/query-client'

interface RenderAppOptions {
  readonly route?: string
  readonly withRouter?: boolean
}

export function renderWithProviders(ui: ReactElement | ReactNode, options: RenderAppOptions = {}): RenderResult {
  const queryClient = createQueryClient({ isTest: true })
  const route: string = options.route ?? '/'
  if (options.withRouter === false) {
    return render(ui, {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })
  }
  return render(ui, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </QueryClientProvider>
    ),
  })
}
