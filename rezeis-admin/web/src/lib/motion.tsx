/**
 * Reusable motion primitives for the admin panel.
 *
 * - FadeIn:     Fade in from below
 * - StaggerList / StaggerItem:  Stagger children animations
 * - PageTransition: Full page fade/slide
 *
 * All components respect user's reduced-motion preference automatically via
 * motion's built-in handling.
 */

import type { ReactNode } from 'react'
import type { Variants, Transition, HTMLMotionProps } from 'motion/react'
import { motion, AnimatePresence, MotionConfig } from 'motion/react'

// ── Standard easing & durations ──────────────────────────────────────────────
const EASE_OUT: Transition['ease'] = [0.16, 1, 0.3, 1]

const DEFAULT_DURATION = 0.35
const STAGGER_STEP = 0.04

// ── FadeIn ───────────────────────────────────────────────────────────────────
interface FadeInProps extends HTMLMotionProps<'div'> {
  children: ReactNode
  delay?: number
  y?: number
  duration?: number
}

export function FadeIn({ children, delay = 0, y = 12, duration = DEFAULT_DURATION, ...rest }: FadeInProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, ease: EASE_OUT, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

// ── Stagger ──────────────────────────────────────────────────────────────────
const listVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: STAGGER_STEP,
      delayChildren: 0.05,
    },
  },
}

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: EASE_OUT },
  },
}

export function StaggerList({ children, className, ...rest }: HTMLMotionProps<'div'> & { children: ReactNode }) {
  return (
    <motion.div variants={listVariants} initial="hidden" animate="show" className={className} {...rest}>
      {children}
    </motion.div>
  )
}

export function StaggerItem({ children, className, ...rest }: HTMLMotionProps<'div'> & { children: ReactNode }) {
  return (
    <motion.div variants={itemVariants} className={className} {...rest}>
      {children}
    </motion.div>
  )
}

// ── PageTransition ────────────────────────────────────────────────────────────
export function PageTransition({ children, keyId }: { children: ReactNode; keyId: string }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={keyId}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.24, ease: EASE_OUT }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}

// ── HoverLift ─────────────────────────────────────────────────────────────────
/** Subtle lift on hover, snap on tap. Useful for cards. */
export function HoverLift({ children, className, ...rest }: HTMLMotionProps<'div'> & { children: ReactNode }) {
  return (
    <motion.div
      whileHover={{ y: -2, transition: { duration: 0.15 } }}
      whileTap={{ scale: 0.98, transition: { duration: 0.1 } }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

// ── Root motion config ────────────────────────────────────────────────────────
export function MotionRoot({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}

// Re-export for convenience
// eslint-disable-next-line react-refresh/only-export-components
export { motion, AnimatePresence }
