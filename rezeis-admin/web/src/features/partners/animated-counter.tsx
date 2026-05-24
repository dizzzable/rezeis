import { useEffect, useRef, useState } from 'react'
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion'

interface AnimatedCounterProps {
  /** Target value to animate to. */
  readonly value: number
  /** Optional formatter; receives the rounded interpolated value. */
  readonly format?: (value: number) => string
  /** Animation stiffness. Higher = snappier. Defaults to 120. */
  readonly stiffness?: number
  /** Animation damping. Higher = less overshoot. Defaults to 22. */
  readonly damping?: number
  readonly className?: string
}

/**
 * Drop-in counter that smoothly animates from its previous render to the
 * incoming `value`. Honours reduced-motion preference.
 *
 * Implementation notes
 *  - Uses `useSpring` so the animation respects the user's reduced-motion
 *    preference automatically (framer-motion sets stiffness to 1000 in
 *    that mode, which is effectively instant).
 *  - We read the spring through `useTransform` so the formatter only runs
 *    on each frame, not on every component re-render.
 */
export function AnimatedCounter({
  value,
  format = (value: number) => value.toString(),
  stiffness = 120,
  damping = 22,
  className,
}: AnimatedCounterProps) {
  const prefersReducedMotion = useReducedMotion()
  const motionValue = useMotionValue(value)
  const spring = useSpring(motionValue, {
    stiffness: prefersReducedMotion ? 1000 : stiffness,
    damping: prefersReducedMotion ? 1000 : damping,
    mass: 0.8,
  })
  const display = useTransform(spring, (latest) => format(Math.round(latest)))

  const [text, setText] = useState(() => format(value))
  const lastText = useRef(text)

  useEffect(() => {
    motionValue.set(value)
    const unsubscribe = display.on('change', (next) => {
      if (next !== lastText.current) {
        lastText.current = next
        setText(next)
      }
    })
    return unsubscribe
  }, [display, motionValue, value])

  return <motion.span className={className}>{text}</motion.span>
}
