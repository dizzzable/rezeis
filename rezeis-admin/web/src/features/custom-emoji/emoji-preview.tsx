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
}

/**
 * EmojiPreview
 * ────────────
 * Shows a custom emoji in the admin manager exactly as it animates in Telegram:
 *   • `videoUrl` (VP9 .webm)  → looping muted `<video>` (transparent alpha)
 *   • `lottieUrl` (.tgs→JSON) → Lottie animation (svg renderer)
 *   • otherwise               → the static thumbnail image
 * Mounting is deferred until the element scrolls into view so a 100-emoji pack
 * doesn't spin up 100 players at once.
 */
export function EmojiPreview({ imageUrl, lottieUrl, videoUrl, alt, className }: EmojiPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [animated, setAnimated] = useState(false)

  useEffect(() => {
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
  }, [])

  // Lottie is only used when there is no video clip (video wins).
  useEffect(() => {
    if (!visible || videoUrl || !lottieUrl) return
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
    }
  }, [visible, lottieUrl, videoUrl])

  return (
    <div
      ref={containerRef}
      className={cn('relative flex items-center justify-center rounded bg-muted', className)}
      title={alt}
    >
      {visible && videoUrl ? (
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
          <img src={imageUrl} alt={alt} className="h-full w-full rounded object-contain p-0.5" />
        )
      )}
    </div>
  )
}
