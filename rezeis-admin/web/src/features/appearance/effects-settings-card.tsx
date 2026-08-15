/**
 * Effects Settings Card — UI for configuring visual effects with live previews.
 * Each category shows a mini preview demonstrating where the effect applies.
 */
import { useCallback, useState, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import {
  Circle,
  Crosshair,
  Droplets,
  Ghost,
  Grid3x3,
  Sparkles,
  Target,
  Type,
  type LucideIcon,
} from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'

import {
  useEffectsStore,
  TEXT_ANIMATIONS,
  CURSOR_EFFECTS,
  CLICK_EFFECTS,
  HOVER_EFFECTS,
  CONTENT_ANIMATIONS,
  type TextAnimationId,
  type CursorEffectId,
  type ClickEffectId,
  type HoverEffectId,
  type ContentAnimationId,
} from '@/lib/theme/effects-store'
import { TitleEffect } from '@/components/effects/TitleEffect'

// ── Main component ───────────────────────────────────────────────────────────

export function EffectsSettingsCard() {
  const { t } = useTranslation()
  const effectsEnabled = useEffectsStore((s) => s.effectsEnabled)
  const setEffectsEnabled = useEffectsStore((s) => s.setEffectsEnabled)
  const reset = useEffectsStore((s) => s.reset)

  return (
    <div className="space-y-4">
      {/* Master toggle */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('effectsSettings.title')}</CardTitle>
              <CardDescription>{t('effectsSettings.description')}</CardDescription>
            </div>
            <Switch
              id="effects-master-toggle"
              checked={effectsEnabled}
              onCheckedChange={setEffectsEnabled}
              aria-label={t('effectsSettings.masterToggle')}
            />
          </div>
        </CardHeader>
      </Card>

      {effectsEnabled && (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {/* Left column */}
            <div className="space-y-4">
              <TextAnimationCard />
              <ContentAnimationCard />
              <HoverEffectCard />
            </div>

            {/* Right column */}
            <div className="space-y-4">
              <CursorEffectCard />
              <ClickEffectCard />
            </div>
          </div>

          {/* Reset */}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={reset}>
              {t('effectsSettings.resetAll')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Text Animation Card ──────────────────────────────────────────────────────

function TextAnimationCard() {
  const { t } = useTranslation()
  const textAnimation = useEffectsStore((s) => s.textAnimation)
  const setTextAnimation = useEffectsStore((s) => s.setTextAnimation)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('effectsSettings.textAnimation.title')}</CardTitle>
        <CardDescription>{t('effectsSettings.textAnimation.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>{t('effectsSettings.textAnimation.select')}</Label>
          <Select value={textAnimation} onValueChange={(v) => setTextAnimation(v as TextAnimationId)}>
            <SelectTrigger aria-label={t('effectsSettings.textAnimation.select')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEXT_ANIMATIONS.map((anim) => (
                <SelectItem key={anim.id} value={anim.id}>
                  {t(`effectsSettings.options.textAnimation.${anim.id}`, { defaultValue: anim.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Live Preview — mini page header mockup */}
        {textAnimation !== 'none' && (
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('effectsSettings.preview')}
            </Label>
            <div className="rounded-lg border bg-background/50 p-4">
              <div className="flex items-center gap-2 text-muted-foreground/50 text-[10px] mb-2">
                <div className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                {t('effectsSettings.textAnimation.previewHint')}
              </div>
              <div className="text-xl font-bold">
                <TitleEffect text={t('effectsSettings.sample.pageTitle')} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t('effectsSettings.sample.pageSubtitle')}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Content Animation Card ───────────────────────────────────────────────────

function ContentAnimationCard() {
  const { t } = useTranslation()
  const contentAnimation = useEffectsStore((s) => s.contentAnimation)
  const setContentAnimation = useEffectsStore((s) => s.setContentAnimation)
  const [replayKey, setReplayKey] = useState(0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('effectsSettings.contentAnimation.title')}</CardTitle>
        <CardDescription>{t('effectsSettings.contentAnimation.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>{t('effectsSettings.contentAnimation.select')}</Label>
          <Select value={contentAnimation} onValueChange={(v) => { setContentAnimation(v as ContentAnimationId); setReplayKey((k) => k + 1) }}>
            <SelectTrigger aria-label={t('effectsSettings.contentAnimation.select')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTENT_ANIMATIONS.map((anim) => (
                <SelectItem key={anim.id} value={anim.id}>
                  {t(`effectsSettings.options.contentAnimation.${anim.id}`, { defaultValue: anim.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Live Preview — content sections appearing */}
        {contentAnimation !== 'none' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('effectsSettings.preview')}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => setReplayKey((k) => k + 1)}
              >
                {t('effectsSettings.replay')}
              </Button>
            </div>
            <div className="rounded-lg border bg-background/50 p-3 overflow-hidden">
              <div className="flex items-center gap-2 text-muted-foreground/50 text-[10px] mb-2">
                <div className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                {t('effectsSettings.contentAnimation.previewHint')}
              </div>
              <ContentPreview key={replayKey} animation={contentAnimation} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ContentPreview({ animation }: { animation: ContentAnimationId }) {
  const getMotionProps = () => {
    switch (animation) {
      case 'gradualBlur':
        return { initial: { opacity: 0, filter: 'blur(6px)' }, animate: { opacity: 1, filter: 'blur(0px)' } }
      case 'fadeContent':
        return { initial: { opacity: 0 }, animate: { opacity: 1 } }
      default:
        return { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }
    }
  }

  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          {...getMotionProps()}
          transition={{ duration: 0.5, delay: i * 0.15 }}
          className="flex items-center gap-2"
        >
          <div className="h-6 w-6 rounded bg-primary/20 shrink-0" />
          <div className="flex-1 space-y-1">
            <div className="h-2 rounded bg-foreground/20" style={{ width: `${80 - i * 15}%` }} />
            <div className="h-1.5 rounded bg-muted-foreground/15" style={{ width: `${60 - i * 10}%` }} />
          </div>
        </motion.div>
      ))}
    </div>
  )
}

// ── Hover Effect Card ────────────────────────────────────────────────────────

function HoverEffectCard() {
  const { t } = useTranslation()
  const hoverEffect = useEffectsStore((s) => s.hoverEffect)
  const setHoverEffect = useEffectsStore((s) => s.setHoverEffect)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('effectsSettings.hoverEffect.title')}</CardTitle>
        <CardDescription>{t('effectsSettings.hoverEffect.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>{t('effectsSettings.hoverEffect.select')}</Label>
          <Select value={hoverEffect} onValueChange={(v) => setHoverEffect(v as HoverEffectId)}>
            <SelectTrigger aria-label={t('effectsSettings.hoverEffect.select')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOVER_EFFECTS.map((eff) => (
                <SelectItem key={eff.id} value={eff.id}>
                  {t(`effectsSettings.options.hoverEffect.${eff.id}`, { defaultValue: eff.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Live Preview — hover card mockup */}
        {hoverEffect !== 'none' && (
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('effectsSettings.preview')}
            </Label>
            <div className="rounded-lg border bg-background/50 p-3">
              <div className="flex items-center gap-2 text-muted-foreground/50 text-[10px] mb-2">
                <div className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                {t('effectsSettings.hoverEffect.previewHint')}
              </div>
              <HoverPreview effect={hoverEffect} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function HoverPreview({ effect }: { effect: HoverEffectId }) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLButtonElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)

  const showGlow = (x: number, y: number) => {
    if (!glowRef.current) return
    if (effect === 'spotlight') {
      glowRef.current.style.background = `radial-gradient(120px circle at ${x}px ${y}px, oklch(0.6 0.2 320 / 20%), transparent 70%)`
    } else {
      glowRef.current.style.background = `radial-gradient(80px circle at ${x}px ${y}px, oklch(1 0 0 / 15%), transparent 60%)`
    }
    glowRef.current.style.opacity = '1'
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    showGlow(e.clientX - rect.left, e.clientY - rect.top)
  }

  const handleFocus = () => {
    const rect = containerRef.current?.getBoundingClientRect()
    showGlow((rect?.width ?? 240) / 2, (rect?.height ?? 80) / 2)
  }

  const handleMouseLeave = () => {
    if (glowRef.current) glowRef.current.style.opacity = '0'
  }

  return (
    <button
      type="button"
      ref={containerRef}
      className="relative w-full cursor-pointer overflow-hidden rounded-md border bg-card/50 p-3 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleMouseLeave}
      aria-label={t('effectsSettings.hoverEffect.previewAction')}
    >
      <div
        ref={glowRef}
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200"
      />
      <div className="relative z-10 flex items-center gap-3">
        <div className="h-8 w-8 rounded bg-primary/20 flex items-center justify-center text-[10px] text-primary">
          KPI
        </div>
        <div className="flex-1">
          <div className="text-xs font-medium">{t('effectsSettings.sample.cardTitle')}</div>
          <div className="text-[10px] text-muted-foreground">{t('effectsSettings.sample.cardHint')}</div>
        </div>
        <Badge variant="secondary" className="text-[9px]">
          {effect}
        </Badge>
      </div>
    </button>
  )
}

// ── Canvas preview tiles ─────────────────────────────────────────────────────

/**
 * How one effect is caricatured inside its 400×100 preview tile.
 *
 * WHY A TABLE AT ALL. Both canvas tiles took `effect` as a `useEffect`
 * dependency and then never branched on it: the draw function was one violet
 * dot trail, so a run over all seven cursor effects produced byte-identical
 * markup and a byte-identical mark. "Прицел" and "Жидкий курсор" previewed the
 * same. A preview that answers a question it has no answer to is worse than no
 * preview — it is the operator's only evidence about what they just picked.
 *
 * WHY A CARICATURE AND NOT THE REAL EFFECT. The real ones are WebGL and fluid
 * simulations (`components/reactbits`), one GL context each, against a WebKit
 * ceiling of sixteen per page. Five of them living in a settings tab is not a
 * preview, it is an outage. So the tile promises less and keeps the promise:
 * the SHAPE of the mark, its COLOUR and how long it LIVES — the three things
 * recognisable at a glance — differ per effect, and the name and icon sit in
 * the corner so the tile still says what it is before anyone moves a pointer.
 */
type MarkShape =
  | 'splash'
  | 'blob'
  | 'ghost'
  | 'crosshair'
  | 'pixel'
  | 'reticle'
  | 'glyph'
  | 'spark'

interface PreviewStyle {
  readonly shape: MarkShape
  /** oklch hue. Distinct per effect — colour alone separates two tiles. */
  readonly hue: number
  /** Canvas pixels: radius, grid cell or font size, depending on the shape. */
  readonly size: number
  /** How long one mark survives — what separates a ghost tail from a crosshair. */
  readonly lifetimeMs: number
  readonly Icon: LucideIcon
}

type PaintedCursorEffect = Exclude<CursorEffectId, 'none'>
type PaintedClickEffect = Exclude<ClickEffectId, 'none'>

const CURSOR_PREVIEW_STYLES: Record<PaintedCursorEffect, PreviewStyle> = {
  // Soft, wide, slow — the fluid sim it stands for has no edges.
  splash: { shape: 'splash', hue: 265, size: 18, lifetimeMs: 900, Icon: Droplets },
  // One fat body that barely shrinks, so it reads as a lagging blob.
  blob: { shape: 'blob', hue: 320, size: 15, lifetimeMs: 700, Icon: Circle },
  // Small dots, longest life of the set: the tail IS the effect.
  ghost: { shape: 'ghost', hue: 220, size: 7, lifetimeMs: 1300, Icon: Ghost },
  // Full-width guides and no dot at all, dying fastest — a crosshair tracks,
  // it does not trail.
  crosshair: { shape: 'crosshair', hue: 150, size: 10, lifetimeMs: 350, Icon: Crosshair },
  // Grid-snapped hard squares with quantised alpha.
  pixelTrail: { shape: 'pixel', hue: 95, size: 10, lifetimeMs: 800, Icon: Grid3x3 },
  // Four corner brackets around an empty centre, opening as they fade.
  target: { shape: 'reticle', hue: 55, size: 13, lifetimeMs: 600, Icon: Target },
  // Actual glyphs — the only shape that draws text, because that is the effect.
  textTrail: { shape: 'glyph', hue: 25, size: 14, lifetimeMs: 1000, Icon: Type },
}

const CLICK_PREVIEW_STYLES: Record<PaintedClickEffect, PreviewStyle> = {
  spark: { shape: 'spark', hue: 320, size: 6, lifetimeMs: 400, Icon: Sparkles },
}

const TWO_PI = Math.PI * 2

/** Rays per click burst — matches `ClickSparkOverlay`'s default. */
const SPARK_RAYS = 8

interface PreviewMark {
  readonly x: number
  readonly y: number
  /** `performance.now()` at birth. */
  readonly t: number
  /** Radians. Spark rays only; every other shape leaves it at 0. */
  readonly angle: number
  /** Which glyph this mark carries. Text trail only. */
  readonly seq: number
}

function markColor(hue: number, alpha: number): string {
  return `oklch(0.68 0.19 ${hue} / ${alpha.toFixed(3)})`
}

function fillCircle(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, TWO_PI)
  ctx.fill()
}

/**
 * Paint one mark at `age` ∈ [0, 1) of its life.
 *
 * Every branch is a handful of 2D calls on a 400×100 canvas: the tile is a hint
 * about the selection, not a port of the effect, and it has to stay cheap
 * enough that five of these on one settings page cost nothing.
 */
function drawMark(
  ctx: CanvasRenderingContext2D,
  style: PreviewStyle,
  glyphs: string,
  mark: PreviewMark,
  age: number,
): void {
  const fade = 1 - age

  switch (style.shape) {
    case 'splash': {
      // Radial falloff, growing as it dies: liquid spreading, not a dot.
      const radius = style.size * (0.5 + age)
      const gradient = ctx.createRadialGradient(mark.x, mark.y, 0, mark.x, mark.y, radius)
      gradient.addColorStop(0, markColor(style.hue, fade * 0.5))
      gradient.addColorStop(1, markColor(style.hue, 0))
      ctx.fillStyle = gradient
      fillCircle(ctx, mark.x, mark.y, radius)
      break
    }
    case 'blob': {
      ctx.fillStyle = markColor(style.hue, fade * 0.45)
      fillCircle(ctx, mark.x, mark.y, style.size * (1 - age * 0.25))
      break
    }
    case 'ghost': {
      ctx.fillStyle = markColor(style.hue, fade * 0.5)
      fillCircle(ctx, mark.x, mark.y, style.size * fade + 1)
      break
    }
    case 'crosshair': {
      ctx.strokeStyle = markColor(style.hue, fade * 0.8)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, mark.y)
      ctx.lineTo(ctx.canvas.width, mark.y)
      ctx.moveTo(mark.x, 0)
      ctx.lineTo(mark.x, ctx.canvas.height)
      ctx.stroke()
      break
    }
    case 'pixel': {
      // Snapped to a grid and stepped in four alpha levels — a smooth fade
      // would look like every other trail here.
      const cell = style.size
      ctx.fillStyle = markColor(style.hue, Math.ceil(fade * 4) / 4 * 0.6)
      ctx.fillRect(Math.floor(mark.x / cell) * cell, Math.floor(mark.y / cell) * cell, cell, cell)
      break
    }
    case 'reticle': {
      const half = style.size * (1 + age * 0.6)
      const arm = style.size * 0.5
      ctx.strokeStyle = markColor(style.hue, fade)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const cx = mark.x + sx * half
          const cy = mark.y + sy * half
          ctx.moveTo(cx - sx * arm, cy)
          ctx.lineTo(cx, cy)
          ctx.lineTo(cx, cy - sy * arm)
        }
      }
      ctx.stroke()
      break
    }
    case 'glyph': {
      if (glyphs.length === 0) break
      ctx.fillStyle = markColor(style.hue, fade)
      ctx.font = `${style.size}px monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(glyphs[mark.seq % glyphs.length], mark.x, mark.y)
      break
    }
    case 'spark': {
      const dist = age * 20
      const len = fade * style.size
      ctx.strokeStyle = markColor(style.hue, fade)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(mark.x + dist * Math.cos(mark.angle), mark.y + dist * Math.sin(mark.angle))
      ctx.lineTo(
        mark.x + (dist + len) * Math.cos(mark.angle),
        mark.y + (dist + len) * Math.sin(mark.angle),
      )
      ctx.stroke()
      break
    }
  }
}

const noop = (): void => {}

/**
 * The tile's frame loop, and the only way to put marks on it.
 *
 * IDLE COSTS NOTHING, which is the point. Both tiles used to hold an
 * unconditional `requestAnimationFrame`: an operator reading the settings page
 * without touching the mouse paid two full canvas clears every frame, forever,
 * to draw an empty list. `ClickSparkOverlay` had the same loop and the same fix
 * — the loop runs only while something is alive, and `emit` wakes it. The final
 * `clearRect` has already wiped the canvas by the time the loop stops, so
 * stopping leaves nothing behind.
 */
function usePreviewMarks(
  style: PreviewStyle,
  glyphs: string,
): {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  emit: (marks: readonly PreviewMark[]) => void
} {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const marksRef = useRef<PreviewMark[]>([])
  const frameRef = useRef<number | null>(null)
  const wakeRef = useRef<() => void>(noop)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // A style change re-runs this effect; carrying marks across would paint the
    // previous effect's positions in the new effect's shape and colour.
    marksRef.current = []

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const now = performance.now()
      marksRef.current = marksRef.current.filter((mark) => now - mark.t < style.lifetimeMs)

      if (marksRef.current.length === 0) {
        frameRef.current = null
        return
      }

      for (const mark of marksRef.current) {
        drawMark(ctx, style, glyphs, mark, (now - mark.t) / style.lifetimeMs)
      }
      frameRef.current = requestAnimationFrame(draw)
    }

    wakeRef.current = () => {
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(draw)
    }

    return () => {
      // The pointer handlers outlive this closure — they belong to the
      // component, not to the effect. Dropping the wake-up is what stops a
      // mouse move that lands between this cleanup and the next run from
      // booking a frame against a `draw` that is already dead.
      wakeRef.current = noop
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      marksRef.current = []
    }
  }, [style, glyphs])

  const emit = useCallback((marks: readonly PreviewMark[]) => {
    marksRef.current.push(...marks)
    wakeRef.current()
  }, [])

  return { canvasRef, emit }
}

/**
 * The corner caption. It carries the whole answer when the tile is at rest:
 * an operator who never moves the pointer still sees which effect is selected,
 * in that effect's colour and with its own icon.
 */
function PreviewCaption({ style, children }: { style: PreviewStyle; children: ReactNode }) {
  const { Icon } = style
  return (
    <span
      className="pointer-events-none absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-md bg-background/70 px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color: markColor(style.hue, 0.95) }}
    >
      <Icon aria-hidden="true" className="h-3 w-3" />
      {children}
    </span>
  )
}

// ── Cursor Effect Card ───────────────────────────────────────────────────────

function CursorEffectCard() {
  const { t } = useTranslation()
  const cursorEffect = useEffectsStore((s) => s.cursorEffect)
  const setCursorEffect = useEffectsStore((s) => s.setCursorEffect)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('effectsSettings.cursorEffect.title')}</CardTitle>
        <CardDescription>{t('effectsSettings.cursorEffect.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>{t('effectsSettings.cursorEffect.select')}</Label>
          <Select value={cursorEffect} onValueChange={(v) => setCursorEffect(v as CursorEffectId)}>
            <SelectTrigger aria-label={t('effectsSettings.cursorEffect.select')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURSOR_EFFECTS.map((eff) => (
                <SelectItem key={eff.id} value={eff.id}>
                  {t(`effectsSettings.options.cursorEffect.${eff.id}`, { defaultValue: eff.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Live Preview — cursor area */}
        {cursorEffect !== 'none' && (
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('effectsSettings.preview')}
            </Label>
            <CursorPreview effect={cursorEffect} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CursorPreview({ effect }: { effect: PaintedCursorEffect }) {
  const { t } = useTranslation()
  // A `Record` lookup by a value that ultimately comes out of localStorage.
  // `PreviewCaption` destructures `style.Icon` immediately, so an id outside the
  // union takes the whole Appearance page down — the settings screen an operator
  // would go to in order to turn the offending effect off. `migrate` cannot save
  // them either: it runs only when the persisted version differs, so an id that
  // stops being valid without a version bump is stored, loaded and fatal.
  //
  // Same rule as the rest of this patch: decoration must degrade, never take a
  // page with it.
  const style = CURSOR_PREVIEW_STYLES[effect] ?? CURSOR_PREVIEW_STYLES.splash
  const glyphs = t('effectsSettings.cursorEffect.previewGlyphs')
  const { canvasRef, emit } = usePreviewMarks(style, glyphs)
  // Monotonic across the whole tile, so a glyph stays with its point instead of
  // changing every time the trail is filtered.
  const seqRef = useRef(0)

  const addTrailPoint = (x: number, y: number) => {
    emit([{ x, y, t: performance.now(), angle: 0, seq: seqRef.current++ }])
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1
    addTrailPoint((e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY)
  }

  const handleFocus = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    addTrailPoint(canvas.width / 2, canvas.height / 2)
  }

  return (
    <button
      type="button"
      className="relative h-[100px] w-full overflow-hidden rounded-lg border bg-background/50 cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      style={{ borderColor: markColor(style.hue, 0.35) }}
      onMouseMove={handleMouseMove}
      onFocus={handleFocus}
      onClick={handleFocus}
      aria-label={t('effectsSettings.cursorEffect.previewAction')}
    >
      <canvas
        ref={canvasRef}
        width={400}
        height={100}
        className="absolute inset-0 w-full h-full"
      />
      <PreviewCaption style={style}>
        {t(`effectsSettings.options.cursorEffect.${effect}`, { defaultValue: effect })}
      </PreviewCaption>
      <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/50 pointer-events-none">
        {t('effectsSettings.cursorEffect.previewHint')}
      </div>
    </button>
  )
}

// ── Click Effect Card ────────────────────────────────────────────────────────

function ClickEffectCard() {
  const { t } = useTranslation()
  const clickEffect = useEffectsStore((s) => s.clickEffect)
  const setClickEffect = useEffectsStore((s) => s.setClickEffect)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('effectsSettings.clickEffect.title')}</CardTitle>
        <CardDescription>{t('effectsSettings.clickEffect.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>{t('effectsSettings.clickEffect.select')}</Label>
          <Select value={clickEffect} onValueChange={(v) => setClickEffect(v as ClickEffectId)}>
            <SelectTrigger aria-label={t('effectsSettings.clickEffect.select')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLICK_EFFECTS.map((eff) => (
                <SelectItem key={eff.id} value={eff.id}>
                  {t(`effectsSettings.options.clickEffect.${eff.id}`, { defaultValue: eff.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Live Preview — click area */}
        {clickEffect !== 'none' && (
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('effectsSettings.preview')}
            </Label>
            <ClickPreview effect={clickEffect} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ClickPreview({ effect }: { effect: PaintedClickEffect }) {
  const { t } = useTranslation()
  // Same lookup, same reason as `CursorPreview` above.
  const style = CLICK_PREVIEW_STYLES[effect] ?? CLICK_PREVIEW_STYLES.spark
  const { canvasRef, emit } = usePreviewMarks(style, '')

  const addSparks = (x: number, y: number) => {
    const now = performance.now()
    emit(
      Array.from({ length: SPARK_RAYS }, (_, i) => ({
        x,
        y,
        t: now,
        angle: (TWO_PI * i) / SPARK_RAYS,
        seq: i,
      })),
    )
  }

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (e.detail === 0) {
      addSparks(canvas.width / 2, canvas.height / 2)
      return
    }

    const rect = canvas.getBoundingClientRect()
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1
    addSparks((e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY)
  }

  return (
    <button
      type="button"
      className="relative h-[100px] w-full overflow-hidden rounded-lg border bg-background/50 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      style={{ borderColor: markColor(style.hue, 0.35) }}
      onClick={handleClick}
      aria-label={t('effectsSettings.clickEffect.previewAction')}
    >
      <canvas
        ref={canvasRef}
        width={400}
        height={100}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
      <PreviewCaption style={style}>
        {t(`effectsSettings.options.clickEffect.${effect}`, { defaultValue: effect })}
      </PreviewCaption>
      <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/50">
        {t('effectsSettings.clickEffect.previewHint')}
      </div>
    </button>
  )
}
