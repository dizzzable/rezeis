/**
 * AnimatedContent — entrance animation for page content sections.
 * Reads the selected content animation from effects-store.
 * Falls back to plain div when effects are disabled.
 */
import { type ReactNode } from 'react'
import { motion } from 'motion/react'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import { useEffectsStore } from '@/lib/theme/effects-store'
import { cn } from '@/lib/utils'

interface AnimatedContentProps {
  children: ReactNode
  className?: string
  /** Delay before animation starts (seconds) */
  delay?: number
  /** Direction of entrance */
  direction?: 'up' | 'down' | 'left' | 'right'
  /** Distance in px */
  distance?: number
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

  if (!isActive) {
    return <div className={className}>{children}</div>
  }

  // Gradual blur: fade in with blur
  if (contentAnimation === 'gradualBlur') {
    return (
      <motion.div
        className={cn('animated-content-effect', className)}
        initial={{ opacity: 0, filter: 'blur(8px)' }}
        whileInView={{ opacity: 1, filter: 'blur(0px)' }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.6, delay, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    )
  }

  // Fade content: simple opacity fade
  if (contentAnimation === 'fadeContent') {
    return (
      <motion.div
        className={cn('animated-content-effect', className)}
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.5, delay, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    )
  }

  // Default: animatedContent — fade + slide
  const directionMap = {
    up: { y: distance, x: 0 },
    down: { y: -distance, x: 0 },
    left: { x: distance, y: 0 },
    right: { x: -distance, y: 0 },
  }

  const offset = directionMap[direction]

  return (
    <motion.div
      className={cn('animated-content-effect', className)}
      initial={{ opacity: 0, ...offset }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{
        duration: 0.5,
        delay,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
    >
      {children}
    </motion.div>
  )
}
