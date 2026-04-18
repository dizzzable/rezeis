import type { ReactElement } from 'react'
import { RouterProvider } from 'react-router-dom'
import { router } from '@/app/router'
import { AuthProvider } from '@/features/auth/auth-provider'

export default function App(): ReactElement {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  )
}
