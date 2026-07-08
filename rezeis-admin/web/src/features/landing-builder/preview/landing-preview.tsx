import { useDeferredValue, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

import type { LandingConfig, LandingSection } from '../landing-builder-api'
import { PREVIEW_SECTIONS } from './preview-sections'
// Raw CSS injected into the iframe <head> — the admin app's global CSS does
// not reach the isolated preview document, so the landing visual system
// (backgrounds / glass / reveal) must be shipped in explicitly. Kept in
// lockstep with reiwa/web/src/features/landing/landing.css.
import landingCss from './landing.css?raw'

/**
 * LandingPreview — live preview of the DRAFT landing, rendered into an isolated
 * same-origin iframe via a React portal into the iframe's `document.body`.
 *
 * Isolation means the admin's global CSS does not leak into the preview and
 * device media queries evaluate against the simulated width. We portal into the
 * iframe's default `about:blank` document (a stable, same-origin document)
 * rather than a `srcDoc` document — `srcDoc` reparses asynchronously and
 * detaches an already-portalled node (blank-preview race). A short poll waits
 * for `contentDocument.body`, injects the stylesheet, styles the body, then
 * mounts the portal.
 *
 * The preview also carries builder chrome (select / reorder / hide / delete)
 * on hover — see `SectionShell`. Interactions are reported back via callbacks.
 */
const WIDTHS = { mobile: 390, tablet: 768, desktop: 1100 } as const
export type PreviewWidth = keyof typeof WIDTHS

interface Props {
  config: LandingConfig
  locale: string
  width: PreviewWidth
  selectedId: string | null
  onSelect: (id: string) => void
  onMove: (index: number, delta: number) => void
  onToggleVisible: (index: number) => void
  onDelete: (index: number) => void
  onReorder: (from: number, to: number) => void
}

const RADIUS_PX: Record<NonNullable<LandingConfig['theme']['radius']>, string> = {
  none: '0px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
}

function themeVars(theme: LandingConfig['theme']): CSSProperties {
  const style: Record<string, string> = {}
  const custom = theme.inherit === false
  const primary = custom ? theme.colors?.primary : undefined
  const bg = custom ? theme.colors?.bg : undefined
  style['--ls-primary'] = primary || '#22c55e'
  style['--ls-bg'] = bg || '#0a0a0a'
  if (custom && theme.radius) style['--ls-radius'] = RADIUS_PX[theme.radius]
  if (custom && theme.font?.family) style['fontFamily'] = theme.font.family
  return style as CSSProperties
}

/** Background layer — mirrors reiwa's LandingBg (CSS-only). */
function PreviewBg({ theme }: { theme: LandingConfig['theme'] }) {
  const effect = theme.background
  if (!effect || effect === 'none') return null
  const animate = theme.animateBackground !== false
  const colors =
    theme.backgroundColors && theme.backgroundColors.length > 0
      ? theme.backgroundColors
      : theme.colors?.primary
        ? [theme.colors.primary]
        : []
  const style: Record<string, string> = {}
  const [c1, c2, c3] = colors
  if (c1) style['--ls-c1'] = c1
  if (c2) style['--ls-c2'] = c2
  if (c3) style['--ls-c3'] = c3
  return (
    <div
      className={`ls-bg ls-bg--${effect}`}
      data-animate={animate ? 'on' : 'off'}
      style={style as CSSProperties}
      aria-hidden="true"
      data-ls-bg={effect}
    />
  )
}
interface ShellProps {
  section: LandingSection
  index: number
  total: number
  selected: boolean
  dragging: boolean
  onSelect: (id: string) => void
  onMove: (index: number, delta: number) => void
  onToggleVisible: (index: number) => void
  onDelete: (index: number) => void
  onDragStart: (index: number, e: React.PointerEvent) => void
  children: React.ReactNode
}

/**
 * PreviewReveal — mirrors reiwa's `Reveal` so the per-section scroll-reveal
 * animation the operator picks is visible in the builder. One-shot
 * IntersectionObserver (root = the iframe viewport, since the node lives in the
 * iframe document) toggles `is-visible`. `none`/undefined renders immediately.
 * `key`-remounting on animation change (in PreviewBody) replays the reveal so
 * the operator sees the effect the moment they select it.
 */
function PreviewReveal({ animation, children }: { animation?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!animation || animation === 'none') return undefined
    const node = ref.current
    if (node === null) return undefined
    const win = node.ownerDocument.defaultView
    if (!win || typeof win.IntersectionObserver === 'undefined') {
      setVisible(true)
      return undefined
    }
    const observer = new win.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true)
            observer.disconnect()
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -10% 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [animation])

  if (!animation || animation === 'none') return <>{children}</>
  return (
    <div ref={ref} className={`ls-reveal ls-reveal--${animation}${visible ? ' is-visible' : ''}`}>
      {children}
    </div>
  )
}

function SectionShell({
  section,
  index,
  total,
  selected,
  dragging,
  onSelect,
  onMove,
  onToggleVisible,
  onDelete,
  onDragStart,
  children,
}: ShellProps) {
  return (
    <div
      className="ls-pv-section"
      data-selected={selected ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : 'false'}
      data-index={index}
      onClick={() => onSelect(section.id)}
      style={{ opacity: section.visible ? 1 : 0.4 }}
    >
      <div className="ls-pv-chrome">
        <button
          type="button"
          className="ls-pv-btn ls-pv-handle"
          title="Перетащить / Drag"
          onPointerDown={(e) => {
            e.stopPropagation()
            onDragStart(index, e)
          }}
          onClick={(e) => e.stopPropagation()}
        >
          ⠿
        </button>
        <button type="button" className="ls-pv-btn" title="Вверх / Up" onClick={(e) => { e.stopPropagation(); onMove(index, -1) }} disabled={index === 0}>↑</button>
        <button type="button" className="ls-pv-btn" title="Вниз / Down" onClick={(e) => { e.stopPropagation(); onMove(index, 1) }} disabled={index === total - 1}>↓</button>
        <button type="button" className="ls-pv-btn" title="Скрыть / Hide" onClick={(e) => { e.stopPropagation(); onToggleVisible(index) }}>{section.visible ? '👁' : '⃠'}</button>
        <button type="button" className="ls-pv-btn" title="Удалить / Delete" onClick={(e) => { e.stopPropagation(); onDelete(index) }}>✕</button>
      </div>
      <PreviewReveal key={section.animation ?? 'none'} animation={section.animation}>
        {children}
      </PreviewReveal>
    </div>
  )
}

function PreviewBody({
  config,
  locale,
  selectedId,
  dragIndex,
  dropIndex,
  onSelect,
  onMove,
  onToggleVisible,
  onDelete,
  onDragStart,
}: {
  config: LandingConfig
  locale: string
  selectedId: string | null
  dragIndex: number | null
  dropIndex: number | null
  onSelect: (id: string) => void
  onMove: (index: number, delta: number) => void
  onToggleVisible: (index: number) => void
  onDelete: (index: number) => void
  onDragStart: (index: number, e: React.PointerEvent) => void
}) {
  const primaryColor =
    config.theme.inherit === false && config.theme.colors?.primary ? config.theme.colors.primary : '#22c55e'
  const surface = config.theme.surfaceStyle ?? 'solid'
  const rootStyle: CSSProperties = { ...themeVars(config.theme), minHeight: '100%' }

  if (config.sections.length === 0) {
    return (
      <div className="ls-root" data-surface={surface} style={{ ...rootStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <span className="ls-ph" style={{ fontSize: 13 }}>—</span>
      </div>
    )
  }

  return (
    <div className="ls-root" data-surface={surface} style={rootStyle} lang={locale}>
      <PreviewBg theme={config.theme} />
      {config.sections.map((section, index) => {
        const Component = PREVIEW_SECTIONS[section.type]
        if (!Component) return null
        return (
          <div key={section.id}>
            {dropIndex === index && dragIndex !== null && <div className="ls-pv-dropline" />}
            <SectionShell
              section={section}
              index={index}
              total={config.sections.length}
              selected={selectedId === section.id}
              dragging={dragIndex === index}
              onSelect={onSelect}
              onMove={onMove}
              onToggleVisible={onToggleVisible}
              onDelete={onDelete}
              onDragStart={onDragStart}
            >
              <Component section={section} locale={locale} defaultLocale={config.defaultLocale} primaryColor={primaryColor} />
            </SectionShell>
          </div>
        )
      })}
      {dropIndex === config.sections.length && dragIndex !== null && <div className="ls-pv-dropline" />}
    </div>
  )
}
export function LandingPreview({
  config,
  locale,
  width,
  selectedId,
  onSelect,
  onMove,
  onToggleVisible,
  onDelete,
  onReorder,
}: Props) {
  const deferredConfig = useDeferredValue(config)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null)

  // Drag-reorder state (pointer-based, works inside the same-origin iframe).
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dragRef = useRef<{ from: number; to: number } | null>(null)

  // Establish the iframe body as the portal target + inject the stylesheet.
  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe === null) return undefined
    let cancelled = false
    let raf = 0

    const tryAttach = (): void => {
      if (cancelled) return
      const doc = iframe.contentDocument
      const body = doc?.body
      if (doc && body) {
        if (!doc.getElementById('ls-preview-style')) {
          const styleEl = doc.createElement('style')
          styleEl.id = 'ls-preview-style'
          styleEl.textContent = landingCss
          doc.head.appendChild(styleEl)
        }
        doc.documentElement.style.height = '100%'
        doc.documentElement.style.margin = '0'
        body.style.height = '100%'
        body.style.margin = '0'
        setMountNode(body)
        return
      }
      raf = requestAnimationFrame(tryAttach)
    }
    tryAttach()

    return () => {
      cancelled = true
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [])

  // Spotlight background: track the cursor inside the iframe and set --lx/--ly.
  // Cursor-following is vestibular motion — skip under prefers-reduced-motion.
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc || config.theme.background !== 'spotlight') return undefined
    if (config.theme.animateBackground === false) return undefined
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return undefined
    }
    let raf = 0
    const onMoveEvt = (e: PointerEvent): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const bg = doc.querySelector<HTMLElement>('[data-ls-bg="spotlight"]')
        if (!bg) return
        const rect = bg.getBoundingClientRect()
        bg.style.setProperty('--lx', `${((e.clientX - rect.left) / rect.width) * 100}%`)
        bg.style.setProperty('--ly', `${((e.clientY - rect.top) / rect.height) * 100}%`)
      })
    }
    doc.addEventListener('pointermove', onMoveEvt)
    return () => {
      doc.removeEventListener('pointermove', onMoveEvt)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [config.theme.background, config.theme.animateBackground, mountNode])

  const handleDragStart = (index: number, e: React.PointerEvent): void => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    const handle = e.currentTarget as HTMLElement
    // Capture the pointer on the handle so pointermove/pointerup keep firing
    // even when the cursor leaves the (short) iframe viewport mid-drag —
    // otherwise the gesture gets stuck with listeners leaked and dragIndex set.
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* older engines / detached node — fall back to document listeners below */
    }

    setDragIndex(index)
    setDropIndex(index)
    dragRef.current = { from: index, to: index }

    const computeDrop = (clientY: number): number => {
      const nodes = Array.from(doc.querySelectorAll<HTMLElement>('.ls-pv-section'))
      for (let i = 0; i < nodes.length; i += 1) {
        const rect = nodes[i].getBoundingClientRect()
        if (clientY < rect.top + rect.height / 2) return i
      }
      return nodes.length
    }

    const onPointerMove = (ev: PointerEvent): void => {
      const to = computeDrop(ev.clientY)
      setDropIndex(to)
      if (dragRef.current) dragRef.current.to = to
    }
    const finish = (): void => {
      handle.removeEventListener('pointermove', onPointerMove)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {
        /* capture may already be released */
      }
      const drag = dragRef.current
      if (drag) {
        // A drop index past the source shifts down by one once removed.
        const to = drag.to > drag.from ? drag.to - 1 : drag.to
        if (to !== drag.from && to >= 0) onReorder(drag.from, to)
      }
      dragRef.current = null
      setDragIndex(null)
      setDropIndex(null)
    }
    // With pointer capture, move/up/cancel all retarget to the handle element.
    handle.addEventListener('pointermove', onPointerMove)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
      <iframe
        ref={iframeRef}
        title="landing-preview"
        style={{
          width: WIDTHS[width],
          maxWidth: '100%',
          height: 640,
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          background: '#0a0a0a',
        }}
      />
      {mountNode !== null &&
        createPortal(
          <PreviewBody
            config={deferredConfig}
            locale={locale}
            selectedId={selectedId}
            dragIndex={dragIndex}
            dropIndex={dropIndex}
            onSelect={onSelect}
            onMove={onMove}
            onToggleVisible={onToggleVisible}
            onDelete={onDelete}
            onDragStart={handleDragStart}
          />,
          mountNode,
        )}
    </div>
  )
}
