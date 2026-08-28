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
 *
 * The query string is preserved across a tab change. That is not incidental:
 * a page whose state lives in the URL — filters, a search term — loses all of
 * it otherwise, and loses it silently, because the tab still switches and the
 * list still renders.
 */

import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

export interface UseTabSyncResult<TTab extends string> {
  readonly activeTab: TTab
  readonly setTab: (value: string) => void
}

export function useTabSync<TTab extends string>(
  allowedTabs: readonly TTab[],
  defaultTab: TTab,
): UseTabSyncResult<TTab> {
  const {
    hash: locationHash,
    pathname: locationPathname,
    search: locationSearch,
  } = useLocation()
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
    // THE SEARCH IS CARRIED, and leaving it out silently discarded it.
    // react-router resolves a string destination with `search = ''` unless the
    // string carries one, so switching tabs wiped every query parameter on the
    // page. On Users that is the whole filter set and the search box: filter to
    // twelve rows, click Bulk to copy ids, click back to List — and the badge
    // reads 0 over every user in the install. Acting on "the twelfth row" then
    // acts on a different account.
    navigate(`${locationPathname}${locationSearch}#${tab}`, { replace: true })
  }

  return { activeTab, setTab }
}
