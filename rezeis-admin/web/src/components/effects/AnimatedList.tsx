/**
 * AnimatedList — renders children with staggered fade-in/slide-up
 * animations as they mount. Inspired by React Bits AnimatedList.
 *
 * Note: For AnimatePresence to work correctly, each child should have a
 * stable key. This component wraps each child in a motion.div keyed by
 * the child's own key (if it's a valid element) or falls back to index.
 */
import { type ReactNode, isValidElement } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useEffectsActive } from '@/lib/theme/effects-active'

interface AnimatedListProps {
  children: ReactNode[]
  /** Stagger delay between items in seconds */
  stagger?: number
  className?: string
}

export function AnimatedList({
  children,
  stagger = 0.05,
  className,
}: AnimatedListProps) {
  const effectsActive = useEffectsActive()

  // Bare children, no `AnimatePresence` and no per-item `motion.div`: skipping
  // only the transition props would still mount one animation driver per row
  // and keep the exit-animation bookkeeping alive on every list update.
  if (!effectsActive) {
    return <div className={className}>{children}</div>
  }

  return (
    <div className={className}>
      <AnimatePresence mode="popLayout">
        {children.map((child, index) => {
          // Prefer the child's own key for stable identity
          const key = isValidElement(child) && child.key != null
            ? child.key
            : index

          return (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{
                duration: 0.3,
                delay: index * stagger,
                ease: [0.25, 0.46, 0.45, 0.94],
              }}
            >
              {child}
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
