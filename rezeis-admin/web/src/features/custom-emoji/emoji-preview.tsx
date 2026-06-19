import { useEffect, useRef, useState } from 'react'
import type { AnimationItem } from 'lottie-web'

import { cn } from '@/lib/utils'

interface EmojiPreviewProps {
  readonly imageUrl: string
  readonly lottieUrl: string | null
  /** Animated VP9 `.webm` (Telegram video emoji). Played as a looping muted
   *  `<video>`. Takes priority over Lottie/image so the operator sees the real
   *  animated emoji. `null`/absent → fall back to Lottie or the static image. */
  readonly videoUrl?: string | null
  readonly alt: string
  readonly className?: string
  /**
   * When the animation is allowed to play:
   *   • `auto`  (default) — mounts the player as soon as the emoji scrolls into
   *     view. Best for single / few-instance sites (inline previews, icons).
   *   • `hover` — stays a static thumbnail and only mounts the Lottie/video
   *     player on pointer hover (or keyboard focus). Best for dense grids
   *     (pickers, the emoji manager) so hundreds of emoji never spin up players
   *     at once. `forcePlay` overrides this (e.g. the currently-selected emoji).
   */
  readonly playMode?: 'auto' | 'hover'
  /** Force the animation to play regardless of `playMode` (e.g. selected). */
  readonly forcePlay?: boolean
}

/**
 * EmojiPreview
 * ────────────
 * Shows a custom emoji in the admin manager exactly as it animates in Telegram:
 *   • `videoUrl` (VP9 .webm)  → looping muted `<video>` (transparent alpha)
 *   • `lottieUrl` (.tgs→JSON) → Lottie animation (svg renderer)
 *   • otherwise               → the static thumbnail image
 * In `auto` mode mounting is deferred until the element scrolls into view; in
 * `hover` mode it is deferred until the pointer hovers (or `forcePlay`), so a
 * 100-emoji grid never spins up 100 players at once.
 */
export function EmojiPreview({
  imageUrl,
  lottieUrl,
  videoUrl,
  alt,
  className,
  playMode = 'auto',
  forcePlay = false,
}: EmojiPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [animated, setAnimated] = useState(false)

  const hoverGated = playMode === 'hover'
  // Whether the animated form (lottie/video) is allowed to mount right now.
  const active = forcePlay || (hoverGated ? hovering : visible)

  // `auto` mode only: lazily flag visibility so the player mounts on scroll-in.
  useEffect(() => {
    if (hoverGated) return
    const node = containerRef.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true)
      },
      { rootMargin: '150px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hoverGated])

  // Lottie is only used when there is no video clip (video wins).
  useEffect(() => {
    if (!active || videoUrl || !lottieUrl) return
    const node = containerRef.current
    if (!node) return
    let anim: AnimationItem | null = null
    let cancelled = false
    void import('lottie-web/build/player/lottie_light').then((mod) => {
      if (cancelled || !containerRef.current) return
      anim = (mod.default ?? mod).loadAnimation({
        container: containerRef.current,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        path: lottieUrl,
      })
      anim.addEventListener('DOMLoaded', () => setAnimated(true))
    })
    return () => {
      cancelled = true
      anim?.destroy()
      // Restore the static thumbnail when the animation unmounts (hover-out).
      setAnimated(false)
    }
  }, [active, lottieUrl, videoUrl])

  const hoverHandlers = hoverGated
    ? {
        onMouseEnter: () => setHovering(true),
        onMouseLeave: () => setHovering(false),
        onFocus: () => setHovering(true),
        onBlur: () => setHovering(false),
      }
    : {}

  return (
    <div
      ref={containerRef}
      className={cn('relative flex items-center justify-center rounded bg-muted', className)}
      title={alt}
      {...hoverHandlers}
    >
      {active && videoUrl ? (
        <video
          src={videoUrl}
          poster={imageUrl}
          autoPlay
          loop
          muted
          playsInline
          aria-label={alt}
          className="h-full w-full rounded object-contain p-0.5"
        />
      ) : (
        !animated && (
          <img
            src={imageUrl}
            alt={alt}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full w-full rounded object-contain p-0.5"
          />
        )
      )}
    </div>
  )
}
