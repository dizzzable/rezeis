import type { JSX, ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth-store'

interface PublicOnlyRouteProps {
  readonly children: ReactNode
}

export function PublicOnlyRoute({ children }: PublicOnlyRouteProps): JSX.Element {
  const token: string = useAuthStore((state) => state.token)
  if (token) {
    return <Navigate replace to="/dashboard" />
  }
  return <>{children}</>
}
