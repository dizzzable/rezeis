/**
 * Service worker registration for the admin PWA.
 *
 * Uses vite-plugin-pwa's virtual `registerSW` (the plugin emits the runtime
 * registration helper even in `injectRegister: false` mode).
 *
 * TWO things are deliberately taken away from the plugin's defaults.
 *
 * 1. WHEN WE REGISTER — deferred to after `window` load + an idle period.
 *    The precache manifest is ~7 MiB across ~300 entries, and starting that
 *    download at module-eval time raced the login-critical requests (locale
 *    chunk, auth status, session probe) for bandwidth on first visit —
 *    noticeable on mobile connections. Precaching only needs to happen
 *    eventually, not before first paint.
 *
 *    The wait is BOUNDED. `window.addEventListener('load', …)` never fires
 *    while a single subresource is still stalled — one slow font or image
 *    and the service worker would simply never register for that whole
 *    session, silently. So a timer races the `load` event and whichever
 *    arrives first wins.
 *
 * 2. WHEN WE RELOAD — see `reloadWhenSafe`. In `registerType: 'autoUpdate'`
 *    the plugin's template reloads the page itself the moment the new worker
 *    activates, unless `onNeedReload` is supplied:
 *
 *        wb.addEventListener('activated', (event) => {
 *          if (event.isUpdate || event.isExternal) {
 *            if (onNeedReload) onNeedReload()
 *            else window.location.reload()
 *          }
 *        })
 *
 *    Combined with the deferral above, that default became a real defect.
 *    Registration used to happen at module eval, so a post-deploy reload
 *    landed ~0.2–0.8 s after first paint — before the operator had touched
 *    anything. Now registration waits for load + up to 3 s of idle, so the
 *    reload lands ~3–5 s in: after `autoFocus` has put the cursor in the
 *    username field and the operator has started typing. Every operator's
 *    first visit after a deploy, credentials wiped mid-word. So we take the
 *    reload over and hold it until it costs nothing.
 */

/** Idle fallback delay — also the cap requestIdleCallback is given. */
const IDLE_DELAY_MS = 3_000

/**
 * Cap on how long we will wait for `load`. A stalled subresource must not
 * cost the session its service worker.
 */
const LOAD_TIMEOUT_MS = 10_000

/** How long the page must be quiet before a visible tab may be reloaded. */
const IDLE_BEFORE_RELOAD_MS = 60_000

/** How often the "is it safe yet?" check re-runs while an update is pending. */
const RELOAD_POLL_MS = 5_000

/** Runs `callback` when the browser reports idle time (or after ~3 s on
 *  engines without requestIdleCallback — iOS Safari most notably). */
function whenIdle(callback: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => callback(), { timeout: IDLE_DELAY_MS })
  } else {
    setTimeout(callback, IDLE_DELAY_MS)
  }
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

/** Is the operator part-way through filling something in? */
function hasUnsavedInput(): boolean {
  for (const el of Array.from(document.querySelectorAll(EDITABLE))) {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== el.defaultChecked) return true
      } else if (el.value !== el.defaultValue) {
        return true
      }
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) return true
    } else if (el instanceof HTMLSelectElement) {
      if (Array.from(el.options).some((o) => o.selected !== o.defaultSelected)) return true
    } else if (el.textContent?.trim()) {
      // contenteditable has no defaultValue to compare against; any content
      // at all is treated as the operator's.
      return true
    }
  }
  return false
}

/** Is focus sitting in something the operator is typing into right now? */
function isEditing(): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && active.matches(EDITABLE)
}

/**
 * Reload for a newly activated service worker — but only at a moment where
 * throwing the document away costs the operator nothing.
 *
 * Order matters. Unsaved input vetoes a reload unconditionally, hidden tab or
 * not: a background tab with a half-filled broadcast form is exactly the one
 * you must not discard. Past that, a hidden tab is the ideal moment — nobody
 * is looking, and the operator comes back to the new version. A visible tab
 * waits for focus to leave the form controls and for the page to go quiet.
 *
 * There is no deadline on purpose. An update that never lands is a stale tab;
 * a reload that lands mid-password is lost work. The hourly `registration
 * .update()` probe keeps the worker current either way, and any ordinary
 * navigation away picks the new version up for free.
 */
function reloadWhenSafe(): void {
  let lastInteraction = Date.now()
  const noteInteraction = () => {
    lastInteraction = Date.now()
  }
  const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'input', 'focusin'] as const
  for (const type of INTERACTION_EVENTS) {
    window.addEventListener(type, noteInteraction, { capture: true, passive: true })
  }

  let timer: ReturnType<typeof setInterval> | null = null

  const attempt = (): void => {
    if (hasUnsavedInput()) return
    if (document.visibilityState !== 'hidden') {
      if (isEditing()) return
      if (Date.now() - lastInteraction < IDLE_BEFORE_RELOAD_MS) return
    }
    // Stop watching before navigating away — the reload tears this document
    // down anyway, but a rejected/blocked navigation must not leave a poll
    // running forever.
    if (timer !== null) clearInterval(timer)
    document.removeEventListener('visibilitychange', attempt)
    for (const type of INTERACTION_EVENTS) {
      window.removeEventListener(type, noteInteraction, { capture: true })
    }
    window.location.reload()
  }

  document.addEventListener('visibilitychange', attempt)
  timer = setInterval(attempt, RELOAD_POLL_MS)
  // Do not call `attempt()` synchronously: `lastInteraction` was just set, so
  // a visible tab can never qualify, and a hidden one is handled by the poll
  // a beat later. Reloading inside the activation callback is the behaviour
  // we are replacing.
}

async function registerNow(): Promise<void> {
  try {
    const { registerSW } = await import('virtual:pwa-register')

    registerSW({
      immediate: true,
      // Supplying this replaces the template's unconditional
      // `window.location.reload()` on activation. See the module comment.
      onNeedReload() {
        reloadWhenSafe()
      },
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return
        const checkForUpdate = () =>
          registration.update().catch((error: unknown) => {
            console.warn('[SW] Update check failed:', error)
          })
        void checkForUpdate()
        setInterval(() => void checkForUpdate(), 60 * 60 * 1000)
      },
    })
  } catch (error) {
    console.warn('[SW] Failed to register service worker:', error)
  }
}

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return

  if (document.readyState === 'complete') {
    whenIdle(() => void registerNow())
    return
  }

  // `load` and a hard timeout race; the first to arrive wins and the other is
  // disarmed. Without the timeout a single stalled subresource means no
  // service worker at all for the rest of the session.
  let started = false
  const start = (): void => {
    if (started) return
    started = true
    clearTimeout(timeout)
    window.removeEventListener('load', start)
    whenIdle(() => void registerNow())
  }
  const timeout = setTimeout(start, LOAD_TIMEOUT_MS)
  window.addEventListener('load', start, { once: true })
}
