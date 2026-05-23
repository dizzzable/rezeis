/**
 * AnimatedContent — entrance animation for page content sections.
 * Reads the selected content animation from effects-store.
 * Falls back to plain div when effects are disabled.
 */
import { useMemo, type ReactNode } from 'react'
import { motion, type Variants } from 'motion/react'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import {
  useEffectsStore,
  type ContentAnimationId,
} from '@/lib/theme/effects-store'
import { cn } from '@/lib/utils'

interface AnimatedContentProps {
  children: ReactNode
  className?: string
  /** Delay before animation starts (seconds) */
  delay?: number
  /** Direction of entrance (used for `animatedContent`) */
  direction?: 'up' | 'down' | 'left' | 'right'
  /** Distance in px (used for `animatedContent`) */
  distance?: number
}

const DIRECTION_OFFSETS: Record<NonNullable<AnimatedContentProps['direction']>, { x: number; y: number }> = {
  up: { y: 1, x: 0 },
  down: { y: -1, x: 0 },
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
}

function buildVariants(animation: ContentAnimationId, distance: number, direction: NonNullable<AnimatedContentProps['direction']>): { variants: Variants; duration: number; ease: string | number[] } {
  switch (animation) {
    case 'gradualBlur':
      return {
        variants: {
          hidden: { opacity: 0, filter: 'blur(8px)' },
          visible: { opacity: 1, filter: 'blur(0px)' },
        },
        duration: 0.6,
        ease: 'easeOut',
      }
    case 'fadeContent':
      return {
        variants: {
          hidden: { opacity: 0 },
          visible: { opacity: 1 },
        },
        duration: 0.5,
        ease: 'easeOut',
      }
    case 'animatedContent':
    default: {
      const offset = DIRECTION_OFFSETS[direction]
      return {
        variants: {
          hidden: { opacity: 0, x: offset.x * distance, y: offset.y * distance },
          visible: { opacity: 1, x: 0, y: 0 },
        },
        duration: 0.5,
        ease: [0.25, 0.46, 0.45, 0.94],
      }
    }
  }
}

export function AnimatedContent({
  children,
  className,
  delay = 0,
  direction = 'up',
  distance = 20,
}: AnimatedContentProps) {
  const visualEffects = useAppearanceStore((s) => s.visualEffects)
  const effectsEnabled = useEffectsStore((s) => s.effectsEnabled)
  const contentAnimation = useEffectsStore((s) => s.contentAnimation)

  const isActive = visualEffects && effectsEnabled && contentAnimation !== 'none'

  const config = useMemo(
    () => buildVariants(contentAnimation, distance, direction),
    [contentAnimation, distance, direction],
  )

  if (!isActive) {
    return <div className={className}>{children}</div>
  }

  return (
    <motion.div
      className={cn('animated-content-effect', className)}
      variants={config.variants}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration: config.duration, delay, ease: config.ease }}
    >
      {children}
    </motion.div>
  )
}
