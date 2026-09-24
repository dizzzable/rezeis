/**
 * What «Схема»'s inspector has typed and not saved yet, and the saves still on
 * their way — so that nothing typed is lost to «Опубликовать», «Сохранить
 * позиции», a reload, a closed tab, a switch of tab, or a phone.
 *
 * The inspector saves a field when it is left (a screen's name and texts, a
 * button's caption, and since 24.09.2026 a button's link and Mini App page,
 * which were saved on every keystroke before). Leaving a field is a blur, and
 * a blur is not always there:
 *   • «Опубликовать» clicked straight after typing: the blur's save and the
 *     publish went out together, ~100 ms apart, and the publish could snapshot
 *     the draft before the save landed — the published flow without the link;
 *   • Safari and iOS do not move focus to a clicked button, so no blur at all;
 *   • a reload, a closed tab, the other tab of «Карта бота», a keyboard
 *     shortcut: the editor unmounted with the draft in it.
 * So every form of the inspector registers its drafts here (`usePendingDrafts`),
 * the page saves them all and waits for every save in flight before it
 * publishes or saves (`flush`), a form saves its drafts as it unmounts, and the
 * page asks before a reload, a close or a navigation away while anything is
 * unsaved (`isDirty`, `UnsavedChangesGuard`).
 */
import { createContext, useContext, useEffect, useRef } from 'react'

/** One form's drafts. */
export interface PendingDrafts {
  /** Saves what is typed and not saved yet — only what may be saved. */
  readonly flush: () => void
  /** Whether something typed is not saved yet. */
  readonly dirty: () => boolean
}

export interface PendingEdits {
  /** Adds a form's drafts; returns their removal. */
  register(drafts: PendingDrafts): () => void
  /** Holds a save until it settles, so `flush` waits for it. Returns it as is. */
  track<T>(save: Promise<T>): Promise<T>
  /** Saves every form's drafts, then resolves once every save in flight has settled. Never rejects. */
  flush(): Promise<void>
  /** Whether something typed is not saved yet, or a save is still on its way. */
  isDirty(): boolean
  /** `useSyncExternalStore`'s subscription: told whenever `isDirty` may have changed. */
  subscribe(listener: () => void): () => void
  /** A form's drafts may have changed: re-read `isDirty`. */
  changed(): void
}

export function createPendingEdits(): PendingEdits {
  const forms = new Set<PendingDrafts>()
  const inFlight = new Set<Promise<unknown>>()
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    register(drafts) {
      forms.add(drafts)
      changed()
      return () => {
        forms.delete(drafts)
        changed()
      }
    },
    track(save) {
      inFlight.add(save)
      changed()
      const settled = (): void => {
        inFlight.delete(save)
        changed()
      }
      save.then(settled, settled)
      return save
    },
    async flush() {
      for (const drafts of [...forms]) drafts.flush()
      // A save a flush started, or one a blur started a moment before — and
      // one that a settling save's own follow-up starts.
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
    isDirty() {
      return inFlight.size > 0 || [...forms].some((drafts) => drafts.dirty())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    changed,
  }
}

/**
 * The page's pending edits. Outside a page that provides one — a form rendered
 * on its own — a form still saves its drafts as it unmounts; nobody publishes.
 */
export const PendingEditsContext = createContext<PendingEdits>(createPendingEdits())

/**
 * Registers a form's drafts with the page for as long as the form is mounted,
 * and saves them as it unmounts. `drafts` is read at the moment of the flush,
 * so what is saved is what the form shows then. Every render tells the page
 * the drafts may have changed.
 */
export function usePendingDrafts(drafts: PendingDrafts): PendingEdits {
  const edits = useContext(PendingEditsContext)
  const latest = useRef(drafts)
  useEffect(() => {
    latest.current = drafts
    edits.changed()
  })
  useEffect(() => {
    const unregister = edits.register({
      flush: () => latest.current.flush(),
      dirty: () => latest.current.dirty(),
    })
    return () => {
      // Unmounting with a draft in it: saved, not dropped.
      latest.current.flush()
      unregister()
    }
  }, [edits])
  return edits
}
