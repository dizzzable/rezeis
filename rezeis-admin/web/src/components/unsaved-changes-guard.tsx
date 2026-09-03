import { useCallback, useContext, useEffect, type JSX } from 'react'
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { isForceLogoutInProgress } from '@/lib/admin-session'

/**
 * The two ways an editor with unsaved work can be left, guarded together.
 *
 * They are two mechanisms — the browser's own prompt for a reload, a close or
 * an address-bar navigation, and the router's blocker for a click on the side
 * menu — and neither covers the other. Installed separately they get installed
 * separately: the landing builder carried both for a year while the catalog
 * editor beside it carried neither, and losing an hour to a sidebar click looks
 * exactly like losing it to a closed tab. So this is ONE component and it does
 * both, because a caller cannot then remember only half of it.
 *
 * Lifted from `landing-builder-page.tsx`, which still has its own copy: its
 * version is tangled with an autosave flush on unmount, and untangling it is a
 * change to a working editor that wanted its own pass rather than a ride along
 * with this one. Until then the force-logout rule exists in two places — if you
 * change it here, change it there.
 *
 * ── Not during a forced sign-out ─────────────────────────────────────────────
 *
 * Both layers check `isForceLogoutInProgress`. A 401 destroys the session and
 * sends the document to /sign-in; without the check the operator is asked
 * whether to stay on an editor whose every save now 401s, holding edits that
 * can no longer be stored anywhere. The check is read at the moment of the
 * navigation, not when the guard last rendered.
 *
 * ── Why the blocker is a child ───────────────────────────────────────────────
 *
 * `useBlocker` throws outside a data router, and these pages also render under
 * a plain `MemoryRouter` in tests. The context read and the `beforeunload`
 * effect are unconditional hooks here; only the component that calls
 * `useBlocker` is mounted conditionally.
 */
export function UnsavedChangesGuard({
  when,
  title,
  description,
  stay,
  leave,
}: {
  /** True while there is work that leaving would discard. */
  when: boolean
  title: string
  description: string
  stay: string
  leave: string
}): JSX.Element | null {
  const inDataRouter = useContext(UNSAFE_DataRouterContext) !== null

  useEffect(() => {
    if (!when) return
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (isForceLogoutInProgress()) return
      event.preventDefault()
      // Chrome and Safari still gate the prompt on a truthy legacy value.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [when])

  if (!inDataRouter) return null
  return (
    <RouterLeaveDialog
      when={when}
      title={title}
      description={description}
      stay={stay}
      leave={leave}
    />
  )
}

function RouterLeaveDialog({
  when,
  title,
  description,
  stay,
  leave,
}: {
  when: boolean
  title: string
  description: string
  stay: string
  leave: string
}): JSX.Element {
  const shouldBlock = useCallback(() => when && !isForceLogoutInProgress(), [when])
  const blocker = useBlocker(shouldBlock)
  return (
    <AlertDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => !open && blocker.reset?.()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => blocker.reset?.()}>{stay}</AlertDialogCancel>
          <AlertDialogAction onClick={() => blocker.proceed?.()}>{leave}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
