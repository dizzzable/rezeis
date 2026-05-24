import type { JSX, ReactNode } from 'react'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

import { getAuthStatus, type AuthStatusResponse } from '@/features/auth/auth-api'
import { safeGetItem } from '@/lib/safe-storage'
import { useLocaleStore } from '@/stores/locale-store'

const STORAGE_KEY = 'rezeis.admin.locale'
const SUPPORTED_LOCALES = ['ru', 'en'] as const

type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

interface LocaleBootstrapperProps {
  readonly children: ReactNode
}

function isSupportedLocale(value: string | undefined): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

function readUserLocaleSelection(): string | null {
  return safeGetItem(STORAGE_KEY)
}

/**
 * Bootstrap the SPA locale from the operator's `.env` configuration
 * (`REZEIS_DEFAULT_LOCALE`) on the very first paint.
 *
 * Behaviour:
 *  - Re-uses the existing `auth-status` query (same key as the sign-in
 *    page) to avoid a duplicate network request, and reads the
 *    operator-supplied default locale from the response.
 *  - Switches the SPA locale to the server default *only* when the user
 *    has not already chosen a different locale in this browser. The
 *    user's own choice always wins.
 */
export function LocaleBootstrapper({ children }: LocaleBootstrapperProps): JSX.Element {
  const setLocale = useLocaleStore((state) => state.setLocale)
  const currentLocale = useLocaleStore((state) => state.locale)

  const { data } = useQuery<AuthStatusResponse>({
    queryKey: ['auth-status'],
    queryFn: getAuthStatus,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })

  useEffect((): void => {
    const serverDefault = data?.defaultLocale
    if (!isSupportedLocale(serverDefault)) {
      return
    }
    // Only override the in-memory locale when the user has not made an
    // explicit choice yet (no value persisted to localStorage). This
    // keeps the operator-supplied default as a one-shot suggestion.
    const userChoice = readUserLocaleSelection()
    if (userChoice !== null && isSupportedLocale(userChoice)) {
      return
    }
    if (currentLocale === serverDefault) {
      return
    }
    setLocale(serverDefault)
  }, [data?.defaultLocale, currentLocale, setLocale])

  return <>{children}</>
}
