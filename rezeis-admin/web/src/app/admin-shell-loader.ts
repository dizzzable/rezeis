/**
 * The admin shell's single entry point: the lazy component the router renders,
 * and the two moments the shell is fetched before anything renders it.
 *
 * WHY IT IS LAZY. The shell is the frame of every signed-in page: sidebar,
 * topbar, quick search, the notification bell and the realtime socket. /sign-in
 * has no use for it. Imported statically by the router, it put 259,657 B on the
 * login route (`app/router.tsx`).
 *
 * WHY IT IS FETCHED EARLY. Lazy on its own adds a round trip between the
 * session check and the first signed-in screen: the shell's download would only
 * start once `/me` and the permissions had answered. So it starts earlier:
 *
 *   1. At boot, when the first screen WILL be the shell. There must be a stored
 *      session and the first route must sit under the shell. `main.tsx` asks
 *      right before the first render, and that render is what starts the
 *      session check, so the two downloads overlap. Not earlier: until then the
 *      locale dictionary has the bandwidth to itself, and the first paint
 *      waits for it.
 *   2. On the sign-in form, on intent: the operator's first focus of, or input
 *      into, a field; a pointer down anywhere on the card («Войти», the passkey
 *      and provider buttons); a browser autofill of the fields. Never on mount:
 *      the desktop autofocus is the page's doing, not the operator's. Never
 *      while Save-Data is on, nor while the browser reports offline
 *      (`navigator.onLine === false`; `true` gates nothing, it only says a
 *      network interface is up). Each waits for idle time, like the glass
 *      backgrounds' warm-up (`lib/idle-prefetch.ts`), but half a second at most
 *      (INTENT_IDLE_TIMEOUT_MS).
 *
 *      The click's own request, the login POST, must leave before the shell's.
 *      Over HTTP/1.1 (six sockets, first come first served) the shell's
 *      requests, started on the spot at pointer down, took the sockets ahead
 *      of it. Measured on a throttled cold load, with the form filled and
 *      «Войти» pressed in the same instant, the POST took 890 ms instead of
 *      407. So the forms also call `warmAdminShellAfterSubmit` right after
 *      they send their request: the shell follows the POST, it does not race it.
 *
 * The OAuth return needs neither: the provider redirects to `/#oauth_token=…`,
 * a route under the shell, and the auth store reads the token at boot, so case
 * 1 covers it.
 *
 * Once the chunk is here, the shell renders without suspending
 * (`lazyWithPreload`), so the session spinner hands straight over to the
 * frame, as it did when the shell was part of the entry.
 *
 * `scripts/check-build-graph.mjs` (ADMIN_SHELL_WARMUP) allows exactly ONE
 * dynamic import of the shell in the whole build, and it has to be the one in
 * this file. A second one — a warm-up on mount, a `void import()` at boot —
 * fails the build.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { AnimationEvent } from 'react'

import { browserReportsOffline, prefetchWhenIdle, saveDataRequested } from '@/lib/idle-prefetch'
import { lazyWithPreload } from '@/lib/lazy-chunk'

export const adminShell = lazyWithPreload(() => import('@/components/layout/admin-shell'))

/** `id` of the router's layout route that renders the shell (`app/router.tsx`). */
export const ADMIN_SHELL_ROUTE_ID = 'admin-shell'

/**
 * Whether this tab's first screen will be the shell, so its download should
 * start at boot.
 *
 * Both halves matter. Without a stored session the protected routes bounce to
 * /sign-in, where the shell is not needed. Routes outside the shell (/sign-in,
 * /change-password, an unknown URL) never render it. Save-Data is deliberately
 * NOT a reason to skip here: the shell is not speculative on this path, it is
 * the next thing on screen. A browser reporting offline IS: the fetch would
 * fail for certain and leave a failed module record behind
 * (`browserReportsOffline`), while the session check fails anyway.
 */
export function shouldWarmAdminShellAtBoot(input: {
  readonly hasSession: boolean
  readonly routeIds: ReadonlyArray<string | undefined>
  readonly offline: boolean
}): boolean {
  return !input.offline && input.hasSession && input.routeIds.includes(ADMIN_SHELL_ROUTE_ID)
}

/**
 * The animation `index.css` starts on an autofilled field inside
 * `[data-autofill-watch]`.
 *
 * A browser that fills saved credentials types nothing and focuses nothing,
 * often before the operator has touched the page. An autofilled field matches
 * `:-webkit-autofill`, and an animation started by that match fires
 * `animationstart`: the cheap detector MUI and react-native-web use.
 */
export const AUTOFILL_ANIMATION = 'rezeis-autofill-detected'

/**
 * The longest an intent warm-up waits for idle time.
 *
 * Idle time usually comes at once. On a busy or hidden page it may not come for
 * seconds: in a measured run the default 4 s wait had not started the download
 * 1.5 s after the operator started typing, and it only began at «Войти». Half a
 * second keeps the idle-first manners of the backgrounds' warm-up
 * (`lib/idle-prefetch.ts`) without spending the head start that typing gives.
 */
export const INTENT_IDLE_TIMEOUT_MS = 500

export interface AdminShellIntentProps {
  readonly 'data-autofill-watch': ''
  readonly onFocusCapture: () => void
  readonly onInputCapture: () => void
  readonly onPointerDownCapture: () => void
  readonly onAnimationStartCapture: (event: AnimationEvent) => void
}

/**
 * Props for the sign-in card: they start the shell's download on the
 * operator's first sign of intent (see the header). Spread them on the element
 * that holds the form and its buttons.
 */
export function useWarmAdminShellOnIntent(): AdminShellIntentProps {
  // Armed in an effect, i.e. after the commit. The desktop autofocus
  // (`autoFocus` on the login field) focuses during the commit, so its `focus`
  // arrives here unarmed and is ignored.
  const armed = useRef(false)
  const scheduled = useRef(false)

  useEffect(() => {
    armed.current = true
    return () => {
      armed.current = false
    }
  }, [])

  const warm = useCallback(() => {
    // Offline is checked here, before the one-shot is spent, so the next sign
    // after the connection returns still warms.
    if (!armed.current || scheduled.current || saveDataRequested() || browserReportsOffline()) return
    scheduled.current = true
    // Deliberately NOT cancelled when the card unmounts, unlike the glass
    // backgrounds' warm-up. The card unmounts because sign-in succeeded, and
    // the shell is what comes next. A cancelled warm-up left the shell to load
    // after the session check: measured, the «Загрузка» spinner and ~700 ms
    // more after «Войти».
    prefetchWhenIdle(() => adminShell.preload(), { timeout: INTENT_IDLE_TIMEOUT_MS })
  }, [])

  const onAnimationStartCapture = useCallback(
    (event: AnimationEvent) => {
      if (event.animationName === AUTOFILL_ANIMATION) warm()
    },
    [warm],
  )

  return {
    'data-autofill-watch': '',
    onFocusCapture: warm,
    onInputCapture: warm,
    onPointerDownCapture: warm,
    onAnimationStartCapture,
  }
}

/**
 * For a sign-in form to call right after it sends its request (`mutate`).
 *
 * The one moment the shell is certain to be needed, and the head start a
 * pointer down cannot promise: in a real click the button is held for tens
 * of milliseconds, during which idle time can come and the shell's requests
 * would leave before the POST. Here they leave after it. The request is sent
 * in microtasks of the same task (react-query, then axios), and this runs a
 * task later. Save-Data and a browser reporting offline skip it like the
 * other warm-ups; the router then loads the shell itself after the session
 * check.
 */
export function warmAdminShellAfterSubmit(): void {
  if (saveDataRequested()) return
  setTimeout(() => {
    // Checked when the fetch would start, like `prefetchWhenIdle` does.
    if (browserReportsOffline()) return
    void adminShell.preload()
  }, 0)
}
