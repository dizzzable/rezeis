import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import { UnsavedChangesGuard } from './unsaved-changes-guard'
import { isForceLogoutInProgress } from '@/lib/admin-session'

/**
 * The guard's own tests, which it did not have.
 *
 * Both editors that use it have tests for their own half of the story, and
 * between them they still left three ways to break this component with every
 * suite green: delete `event.returnValue = ''` and Chrome and Safari stop
 * prompting; delete the `removeEventListener` and the prompt stays armed on
 * every other page of the panel forever; mount the router dialog where there is
 * no data router and it throws. None of the three is visible from a test that
 * drives an editor, because each is a line rather than a behaviour of the page.
 */

vi.mock('@/lib/admin-session', () => ({ isForceLogoutInProgress: vi.fn(() => false) }))

const LABELS = {
  title: 'Leave without saving?',
  description: 'These edits are stored nowhere.',
  stay: 'Stay',
  leave: 'Leave',
}

afterEach(() => {
  cleanup()
  vi.mocked(isForceLogoutInProgress).mockReturnValue(false)
})

function fire(): BeforeUnloadEvent {
  const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
  window.dispatchEvent(event)
  return event
}

describe('the browser prompt', () => {
  it('stays out of the way while there is nothing to lose', () => {
    renderWithProviders(<UnsavedChangesGuard when={false} {...LABELS} />)
    expect(fire().defaultPrevented).toBe(false)
  })

  it('holds the tab once there is', () => {
    renderWithProviders(<UnsavedChangesGuard when {...LABELS} />)
    expect(fire().defaultPrevented).toBe(true)
  })

  it('sets the legacy value Chrome and Safari still gate the prompt on', () => {
    // Deleting that one line leaves `defaultPrevented` true and every other
    // test in the panel green, and silently stops the prompt in two browsers.
    //
    // jsdom implements `returnValue` with the LEGACY boolean meaning, where
    // assigning a falsy value is just another way to say `preventDefault`. So
    // reading it back through jsdom cannot tell the two apart. Shadowing the
    // accessor with a plain writable property asks the only question that
    // matters here: does our handler assign to it at all?
    renderWithProviders(<UnsavedChangesGuard when {...LABELS} />)
    const event = new Event('beforeunload', { cancelable: true })
    Object.defineProperty(event, 'returnValue', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    window.dispatchEvent(event)
    expect((event as unknown as { returnValue: unknown }).returnValue).toBe('')
  })

  it('stands down while the app is signing the operator out', () => {
    // A 401 destroys the session and then navigates to /sign-in, firing this
    // handler. Prompting there offers a "stay" on an editor whose every save
    // now 401s. Read at the moment of the event, not at the last render.
    renderWithProviders(<UnsavedChangesGuard when {...LABELS} />)
    vi.mocked(isForceLogoutInProgress).mockReturnValue(true)
    expect(fire().defaultPrevented).toBe(false)
  })

  it('lets go of the window when the editor unmounts', () => {
    // A lost cleanup is invisible: the operator leaves the editor, and every
    // other page of the panel keeps asking whether to discard changes that no
    // longer exist anywhere.
    const { unmount } = renderWithProviders(<UnsavedChangesGuard when {...LABELS} />)
    expect(fire().defaultPrevented).toBe(true)

    unmount()

    expect(fire().defaultPrevented).toBe(false)
  })

  it('re-arms and disarms as the work becomes dirty and clean again', () => {
    const { rerender } = renderWithProviders(<UnsavedChangesGuard when={false} {...LABELS} />)
    expect(fire().defaultPrevented).toBe(false)

    rerender(<UnsavedChangesGuard when {...LABELS} />)
    expect(fire().defaultPrevented).toBe(true)

    rerender(<UnsavedChangesGuard when={false} {...LABELS} />)
    expect(fire().defaultPrevented).toBe(false)
  })
})

describe('outside a data router', () => {
  it('renders no dialog and throws nothing', () => {
    // `renderWithProviders` uses a plain `MemoryRouter`, where `useBlocker`
    // throws. The component reads the router context itself precisely so a
    // caller cannot forget this — the browser prompt still works here, which
    // the first tests above already showed.
    renderWithProviders(<UnsavedChangesGuard when {...LABELS} />)
    expect(screen.queryByText(LABELS.title)).not.toBeInTheDocument()
  })
})
