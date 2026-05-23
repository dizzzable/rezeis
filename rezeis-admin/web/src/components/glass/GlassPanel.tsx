/**
 * GlassPanel — wraps content with the real Liquid Glass effect.
 * Falls back to CSS backdrop-filter in non-Chromium browsers.
 *
 * Usage:
 *   <GlassPanel element="sidebar">
 *     <SidebarContent />
 *   </GlassPanel>
 */
import { type ReactNode, lazy, Suspense } from 'react'
import { useGlassStore } from '@/lib/theme/glass-store'
import { cn } from '@/lib/utils'

const LiquidGlass = lazy(() => import('liquid-glass-react'))

interface GlassPanelProps {
  children: ReactNode
  element: 'sidebar' | 'header' | 'cards' | 'modals'
  className?: string
  /** Override corner radius */
  cornerRadius?: number
}

export function GlassPanel({
  children,
  element,
  className,
  cornerRadius,
}: GlassPanelProps) {
  const glassEnabled = useGlassStore((s) => s.glassEnabled)
  const elementSettings = useGlassStore((s) => s[element])
  const displacementScale = useGlassStore((s) => s.displacementScale)
  const aberrationIntensity = useGlassStore((s) => s.aberrationIntensity)
  const elasticity = useGlassStore((s) => s.elasticity)
  const saturation = useGlassStore((s) => s.saturation)

  // If glass is disabled globally or for this element, render children as-is
  if (!glassEnabled || !elementSettings.enabled) {
    return <div className={className}>{children}</div>
  }

  return (
    <Suspense fallback={<GlassFallback className={className} blur={elementSettings.blur}>{children}</GlassFallback>}>
      <LiquidGlass
        displacementScale={displacementScale}
        blurAmount={elementSettings.blur}
        saturation={saturation}
        aberrationIntensity={aberrationIntensity}
        elasticity={elasticity}
        cornerRadius={cornerRadius ?? 12}
        className={cn('glass-panel', className)}
      >
        {children}
      </LiquidGlass>
    </Suspense>
  )
}

/**
 * CSS-only fallback for non-Chromium browsers or while LiquidGlass loads.
 */
function GlassFallback({
  children,
  className,
  blur,
}: {
  children: ReactNode
  className?: string
  blur: number
}) {
  return (
    <div
      className={cn('glass-fallback', className)}
      style={{
        backdropFilter: `blur(${Math.round(blur * 80)}px) saturate(1.4)`,
        WebkitBackdropFilter: `blur(${Math.round(blur * 80)}px) saturate(1.4)`,
        background: 'var(--card)',
      }}
    >
      {children}
    </div>
  )
}
