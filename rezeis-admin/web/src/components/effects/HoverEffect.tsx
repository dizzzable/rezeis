/**
 * HoverEffect — universal hover effect wrapper.
 * Reads the selected hover effect from effects-store and renders
 * the appropriate component (Spotlight, Glare, etc.).
 *
 * Usage:
 *   <HoverEffect className="rounded-lg">
 *     <Card>...</Card>
 *   </HoverEffect>
 */
import { type ReactNode } from 'react'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useEffectsStore } from '@/lib/theme/effects-store'
import { SpotlightCard } from './SpotlightCard'
import { GlareHover } from './GlareHover'

interface HoverEffectProps {
  children: ReactNode
  className?: string
}

export function HoverEffect({ children, className }: HoverEffectProps) {
  const visualEffects = useAppearanceStore((s) => s.visualEffects)
  const effectsEnabled = useEffectsStore((s) => s.effectsEnabled)
  const hoverEffect = useEffectsStore((s) => s.hoverEffect)

  const isActive = visualEffects && effectsEnabled && hoverEffect !== 'none'

  if (!isActive) {
    return <div className={className}>{children}</div>
  }

  switch (hoverEffect) {
    case 'spotlight':
      return <SpotlightCard className={className}>{children}</SpotlightCard>
    case 'glare':
      return <GlareHover className={className}>{children}</GlareHover>
    case 'electricBorder':
    case 'magnet':
      // These require more complex integration — fallback to spotlight for now
      return <SpotlightCard className={className}>{children}</SpotlightCard>
    default:
      return <div className={className}>{children}</div>
  }
}
