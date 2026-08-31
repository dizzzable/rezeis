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
 */
export function useMediaViewer(): {
  readonly open: (items: readonly MediaViewerItem[], index: number) => void
  readonly element: React.JSX.Element | null
} {
  const [state, setState] = useState<{
    items: readonly MediaViewerItem[]
    index: number
  } | null>(null)

  const open = useCallback((items: readonly MediaViewerItem[], index: number) => {
    // An empty list would open a black screen with nothing but a close button.
    if (items.length === 0) return
    setState({ items, index: clampIndex(index, items.length) })
  }, [])

  const element = state ? (
    <MediaViewer
      items={state.items}
      index={state.index}
      onIndexChange={(index) => setState((prev) => (prev ? { ...prev, index } : prev))}
      onClose={() => setState(null)}
    />
  ) : null

  return { open, element }
}
