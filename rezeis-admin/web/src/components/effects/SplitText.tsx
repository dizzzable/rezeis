/**
 * SplitText — splits text into individual characters and animates them
 * with a staggered entrance. Inspired by React Bits SplitText.
 * Uses Motion (framer-motion) instead of GSAP to avoid extra deps.
 */
import { motion } from 'motion/react'
import { useEffectsActive } from '@/lib/theme/effects-active'
import { cn } from '@/lib/utils'

interface SplitTextProps {
  text: string
  className?: string
  /** Stagger delay between characters in seconds */
  stagger?: number
  /** Animation variant: 'fade' | 'slide' | 'scale' */
  variant?: 'fade' | 'slide' | 'scale'
}

export function SplitText({
  text,
  className,
  stagger = 0.03,
  variant = 'slide',
}: SplitTextProps) {
  const effectsActive = useEffectsActive()

  // Returning before the split, not merely skipping the transition: each
  // character is its own `motion.span` with its own animation driver, so the
  // only way for the switch to actually cost nothing is for them never to
  // exist. This is the wordmark on /sign-in.
  if (!effectsActive) {
    return <span className={className}>{text}</span>
  }

  const chars = text.split('')

  const variants = {
    fade: { initial: { opacity: 0 }, animate: { opacity: 1 } },
    slide: { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 } },
    scale: { initial: { opacity: 0, scale: 0.5 }, animate: { opacity: 1, scale: 1 } },
  }

  const selected = variants[variant]

  return (
    <span className={cn('inline-flex flex-wrap', className)} aria-label={text}>
      {chars.map((char, i) => (
        <motion.span
          key={`${char}-${i}`}
          initial={selected.initial}
          animate={selected.animate}
          transition={{
            duration: 0.4,
            delay: i * stagger,
            ease: [0.25, 0.46, 0.45, 0.94],
          }}
          aria-hidden="true"
          className="inline-block"
          style={{ whiteSpace: char === ' ' ? 'pre' : undefined }}
        >
          {char}
        </motion.span>
      ))}
    </span>
  )
}
