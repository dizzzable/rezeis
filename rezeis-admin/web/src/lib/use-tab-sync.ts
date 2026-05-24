/**
 * useTabSync — bidirectional sync between a tab state and the URL hash.
 *
 * Reads the initial tab from `location.hash`, falling back to `defaultTab`
 * when the hash is missing or not in `allowedTabs`. Subsequent navigation
 * (browser back/forward, deep links, manual hash edits) is mirrored into
 * state via the "store-prev-prop in render" pattern documented at
 * https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
 *
 * Returns the active tab plus a `setTab(value)` function that updates
 * state and pushes a `#hash` URL fragment with `replace: true` so the
 * back button is not polluted with intra-page tab clicks.
 */

import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export interface UseTabSyncResult<TTab extends string> {
  readonly activeTab: TTab
  readonly setTab: (value: string) => void
}

export function useTabSync<TTab extends string>(
  allowedTabs: readonly TTab[],
  defaultTab: TTab,
): UseTabSyncResult<TTab> {
  const { hash: locationHash, pathname: locationPathname } = useLocation()
  const navigate = useNavigate()

  const allowedSet = allowedTabs as readonly string[]

  const parseHash = (raw: string): TTab => {
    const stripped = raw.replace('#', '')
    return allowedSet.includes(stripped) ? (stripped as TTab) : defaultTab
  }

  const [activeTab, setActiveTab] = useState<TTab>(() => parseHash(locationHash))

  // Mirror external hash changes into state without an effect.
  const [prevHash, setPrevHash] = useState<string>(locationHash)
  if (locationHash !== prevHash) {
    setPrevHash(locationHash)
    const next = parseHash(locationHash)
    if (next !== activeTab) {
      setActiveTab(next)
    }
  }

  function setTab(value: string): void {
    if (!allowedSet.includes(value)) return
    const tab = value as TTab
    setActiveTab(tab)
    navigate(`${locationPathname}#${tab}`, { replace: true })
  }

  return { activeTab, setTab }
}
