import type { ReactElement } from 'react'
import { useAuthSession } from '@/features/auth/auth-provider'

export function AuthRequiredState(): ReactElement {
  const authSession = useAuthSession()
  return (
    <div className="rounded-2xl border border-dashed border-border/80 bg-background/70 px-4 py-6 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">Authentication required</p>
      <p className="mt-2 max-w-2xl leading-6">
        {authSession.hasSessionPersistenceIssue
          ? 'Telegram bootstrap completed, but this browser did not retain the cookie-backed session. Open the app again from the Telegram Mini App on the same public origin so the session cookie can be written and read.'
          : 'Open this workspace from the Telegram Mini App or reuse an existing browser session created by Telegram bootstrap. URL-based identity lookup is no longer supported.'}
      </p>
      <p className="mt-3 max-w-2xl leading-6">
        Recovery path: reopen the app from your bot chat, attachment menu entry, or the exact Mini App link configured in `BOT_MINI_APP` for this deployment.
      </p>
    </div>
  )
}
