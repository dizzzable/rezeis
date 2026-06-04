/**
 * Effects Settings Card — UI for configuring visual effects with live previews.
 * Each category shows a mini preview demonstrating where the effect applies.
 */
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'

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

function CursorPreview({ effect }: { effect: CursorEffectId }) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const trailRef = useRef<Array<{ x: number; y: number; t: number }>>([])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Reset trail when effect changes so old points don't linger.
    trailRef.current = []

    let animId: number

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const now = performance.now()

      // Draw trail dots
      trailRef.current = trailRef.current.filter((p) => now - p.t < 600)
      for (const point of trailRef.current) {
        const age = (now - point.t) / 600
        const alpha = 1 - age
        const size = (1 - age) * 4 + 1

        ctx.beginPath()
        ctx.arc(point.x, point.y, size, 0, Math.PI * 2)
        ctx.fillStyle = `oklch(0.6 0.2 320 / ${alpha * 0.6})`
        ctx.fill()
      }

      animId = requestAnimationFrame(draw)
    }

    animId = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(animId)
      trailRef.current = []
    }
  }, [effect])

  const addTrailPoint = (x: number, y: number) => {
    trailRef.current.push({
      x,
      y,
      t: performance.now(),
    })
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

function ClickPreview({ effect }: { effect: ClickEffectId }) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sparksRef = useRef<Array<{ x: number; y: number; angle: number; t: number }>>([])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Reset sparks when effect changes.
    sparksRef.current = []

    let animId: number

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const now = performance.now()

      sparksRef.current = sparksRef.current.filter((s) => now - s.t < 400)
      for (const spark of sparksRef.current) {
        const age = (now - spark.t) / 400
        const dist = age * 20
        const len = (1 - age) * 6
        const x1 = spark.x + dist * Math.cos(spark.angle)
        const y1 = spark.y + dist * Math.sin(spark.angle)
        const x2 = spark.x + (dist + len) * Math.cos(spark.angle)
        const y2 = spark.y + (dist + len) * Math.sin(spark.angle)

        ctx.strokeStyle = `oklch(0.6 0.2 320 / ${1 - age})`
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }

      animId = requestAnimationFrame(draw)
    }

    animId = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(animId)
      sparksRef.current = []
    }
  }, [effect])

  const addSparks = (x: number, y: number) => {
    const now = performance.now()

    for (let i = 0; i < 8; i++) {
      sparksRef.current.push({
        x, y,
        angle: (Math.PI * 2 * i) / 8,
        t: now,
      })
    }
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
      onClick={handleClick}
      aria-label={t('effectsSettings.clickEffect.previewAction')}
    >
      <canvas
        ref={canvasRef}
        width={400}
        height={100}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
      <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/50">
        {t('effectsSettings.clickEffect.previewHint')}
      </div>
    </button>
  )
}
