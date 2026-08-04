import { useDeferredValue, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

import type { LandingConfig, LandingSection } from '../landing-builder-api'
// The landing kit — the SAME renderer reiwa serves to visitors, vendored by
// `scripts/sync-landing-kit.mjs` and byte-frozen by `live-kit-manifest.test.ts`.
// The preview must never re-implement a section: the previous hand-written
// preview drifted from production in twelve documented ways.
import { LANDING_SECTIONS, themeToCssVars } from '../live/landing-renderer'
import { LandingBg, LandingOverlay, Reveal } from '../live/landing-background'
import { LandingKitProvider } from '../live/landing-kit-context'
import type { LandingConfigPayload, LandingSection as KitSection } from '../live/landing-schema'
import { PREVIEW_KIT_BINDINGS } from './preview-kit-bindings'
// Raw CSS injected into the iframe <head> — the admin app's global CSS does not
// reach the isolated preview document, so the landing visual system must be
// shipped in explicitly. Sourced from the vendored kit, so it cannot drift.
import landingCss from '../live/landing.css?raw'
// Compiled Tailwind, scoped to the kit. `?inline` (not `?raw`) so Vite runs the
// CSS pipeline and hands back the built text — `?raw` would return the literal
// `@import "tailwindcss"` source line, which does nothing inside the iframe.
// Without this the preview has the kit's colours but none of its layout.
import previewTailwind from './preview-tailwind.css?inline'

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
 * SectionShell — builder chrome (select / reorder / hide / delete) wrapped
 * around one section. This is the ONLY admin-specific layer in the preview:
 * the section itself, its reveal animation and the background all come from the
 * kit, so what sits inside the chrome is byte-for-byte what visitors get.
 */
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
      {/* Remount on animation change so the operator replays the reveal the
          moment they pick it — the live page only ever plays it once. */}
      <Reveal key={section.animation ?? 'none'} animation={section.animation}>
        {children}
      </Reveal>
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
  // Theme resolution goes through the kit's own mapper, never a second copy —
  // `radius`, `fg` and `accent` used to apply in production but not here
  // precisely because the preview had its own reduced version of this function.
  const theme = config.theme as LandingConfigPayload['theme']
  const surface = theme?.surfaceStyle ?? 'solid'
  const rootStyle: CSSProperties = { ...themeToCssVars(theme), minHeight: '100%' }
  const bgColors =
    theme?.backgroundColors && theme.backgroundColors.length > 0
      ? theme.backgroundColors
      : theme?.colors?.primary
        ? [theme.colors.primary]
        : undefined

  if (config.sections.length === 0) {
    return (
      <div className="ls-root" data-surface={surface} style={{ ...rootStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <span className="ls-ph" style={{ fontSize: 13 }}>—</span>
      </div>
    )
  }

  return (
    <LandingKitProvider value={PREVIEW_KIT_BINDINGS}>
      <div
        className="ls-root"
        data-surface={surface}
        data-card-hover={theme?.cardHover ?? 'none'}
        data-cta={theme?.ctaStyle ?? 'none'}
        style={rootStyle}
        lang={locale}
      >
        <LandingBg
          effect={theme?.background}
          colors={bgColors}
          animate={theme?.animateBackground !== false}
        />
        <LandingOverlay
          overlay={theme?.backgroundOverlay}
          animate={theme?.animateBackground !== false}
        />
        {config.sections.map((section, index) => {
          const Component = LANDING_SECTIONS[section.type]
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
                <Component
                  section={section as unknown as KitSection}
                  locale={locale}
                  defaultLocale={config.defaultLocale}
                />
              </SectionShell>
            </div>
          )
        })}
        {dropIndex === config.sections.length && dragIndex !== null && <div className="ls-pv-dropline" />}
      </div>
    </LandingKitProvider>
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
          // Tailwind first: `landing.css` overrides utilities in places
          // (`.ls-title`, `.ls-surface`), and both live in the same cascade
          // layer here, so source order is what decides.
          styleEl.textContent = `${previewTailwind}\n${landingCss}`
          doc.head.appendChild(styleEl)
        }
        doc.documentElement.style.minHeight = '100%'
        doc.documentElement.style.margin = '0'
        body.style.minHeight = '100%'
        body.style.margin = '0'
        body.style.overflowY = 'auto'
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
