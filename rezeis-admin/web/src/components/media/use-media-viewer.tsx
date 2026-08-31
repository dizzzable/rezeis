import { useCallback, useState } from 'react'

import { MediaViewer } from './media-viewer'
import type { MediaViewerItem } from './kit/media-viewer-item'
import { clampIndex } from './kit/media-viewer-nav'

/**
 * Opens the media viewer from anywhere, without every caller re-plumbing the
 * same four props.
 *
 * The paging callback is why this exists rather than a `useState` per caller: a
 * caller that renders the viewer but forgets `onIndexChange` gets a viewer that
 * looks right and simply refuses to turn the page — a failure nothing about the
 * call site would reveal.
 *
 * The list is a PARAMETER, not an argument to `open`: ticket screenshots arrive
 * one at a time, and a list frozen at the moment of opening left an operator who
 * tapped the first thumbnail with a one-item viewer that never grew.
 */
export function useMediaViewer(items: readonly MediaViewerItem[]): {
  readonly open: (index: number) => void
  readonly element: React.JSX.Element | null
} {
  const [index, setIndex] = useState<number | null>(null)

  const open = useCallback((at: number) => {
    setIndex(at)
  }, [])

  const current = index === null ? -1 : clampIndex(index, items.length)
  const element =
    current >= 0 ? (
      <MediaViewer
        items={items}
        index={current}
        onIndexChange={setIndex}
        onClose={() => setIndex(null)}
      />
    ) : null

  return { open, element }
}
