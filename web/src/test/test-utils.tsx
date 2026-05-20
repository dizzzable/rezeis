import type { ReactElement, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import { i18n } from '@/i18n/i18n'

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  readonly route?: string
  readonly withRouter?: boolean
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

export function renderWithProviders(
  ui: ReactElement,
  { route = '/', withRouter = true, ...renderOptions }: RenderWithProvidersOptions = {},
): RenderResult {
  const queryClient = createTestQueryClient()

  function Wrapper({ children }: { readonly children: ReactNode }): ReactElement {
    const content: ReactNode = withRouter ? (
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    ) : (
      children
    )

    return (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>
      </I18nextProvider>
    )
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions })
}
