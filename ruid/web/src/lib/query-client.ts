import { QueryClient } from '@tanstack/react-query'
import { isApiUnauthorizedError } from '@/lib/api'

interface CreateQueryClientOptions {
  readonly isTest?: boolean
}

export function createQueryClient(options: CreateQueryClientOptions = {}): QueryClient {
  const isTest: boolean = options.isTest ?? false
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount: number, error: unknown): boolean => {
          if (isTest) {
            return false
          }
          if (isApiUnauthorizedError(error)) {
            return false
          }
          return failureCount < 1
        },
        staleTime: isTest ? 0 : 30000,
        refetchOnWindowFocus: false,
        gcTime: isTest ? Infinity : 5 * 60 * 1000,
      },
      mutations: {
        retry: isTest ? false : undefined,
      },
    },
  })
}

export const queryClient = createQueryClient()
