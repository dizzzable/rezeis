/**
 * TitleEffect — universal text animation wrapper for page titles.
 * Reads the selected text animation from effects-store and renders
 * the appropriate React Bits component.
 *
 * Children resolution:
 *   - If a `text` prop is provided, that is used as the source string.
 *   - Otherwise, if `children` is a string, it's used directly.
 *   - For React node children that aren't strings, animations that need
 *     a string ("decrypted", "blur", "glitch", "scrambled", "rotating",
 *     "trueFocus", "fuzzy") fall back to rendering the children plainly,
 *     because they cannot animate arbitrary JSX.
 *
 * Usage:
 *   <TitleEffect>{t('dashboardPage.title')}</TitleEffect>
 *   <TitleEffect text="Static text" />
 */
import { lazy, Suspense, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { useAppearanceStore } from '@/lib/theme/appearance-store'
import {
  useEffectsStore,
  type TextAnimationId,
} from '@/lib/theme/effects-store'
import { cn } from '@/lib/utils'

// ── Lazy-loaded text animation components ────────────────────────────────────

const GradientText = lazy(() => import('@/components/reactbits/GradientText'))
const GlitchText = lazy(() => import('@/components/reactbits/GlitchText'))
const DecryptedText = lazy(() => import('@/components/reactbits/DecryptedText'))
const BlurText = lazy(() => import('@/components/reactbits/BlurText'))
const FuzzyText = lazy(() => import('@/components/reactbits/FuzzyText'))
const RotatingText = lazy(() => import('@/components/reactbits/RotatingText'))
const TrueFocus = lazy(() => import('@/components/reactbits/TrueFocus'))
const ScrambledText = lazy(() => import('@/components/reactbits/ScrambledText'))

// ── Props ────────────────────────────────────────────────────────────────────

interface TitleEffectProps {
  /** Text content — either as children or text prop */
  children?: ReactNode
  /** Alternative: pass text as string (required for some effects) */
  text?: string
  className?: string
  /** Whether to disable the effect regardless of global toggle */
  disabled?: boolean
}

/** Animations that need a plain string and cannot animate JSX. */
const STRING_ONLY_ANIMATIONS: ReadonlySet<TextAnimationId> = new Set<TextAnimationId>([
  'decrypted', 'blur', 'glitch', 'scrambled', 'rotating', 'trueFocus', 'fuzzy',
])

// ── Component ────────────────────────────────────────────────────────────────

export function TitleEffect({
  children,
  text,
  className,
  disabled = false,
}: TitleEffectProps) {
  const visualEffects = useAppearanceStore((s) => s.visualEffects)
  const effectsEnabled = useEffectsStore((s) => s.effectsEnabled)
  const textAnimation = useEffectsStore((s) => s.textAnimation)

  const isActive = visualEffects && effectsEnabled && !disabled
  const childIsString = typeof children === 'string'
  const displayText = text ?? (childIsString ? children : '')
  const hasUsableString = displayText.length > 0

  // Fallback: render plain text
  if (!isActive || textAnimation === 'none') {
    return <span className={className}>{children ?? text}</span>
  }

  // String-only animations cannot animate arbitrary JSX. If we don't have
  // a usable string (children is a non-string ReactNode and no `text`
  // prop was supplied), render plainly to avoid silently dropping content.
  if (STRING_ONLY_ANIMATIONS.has(textAnimation) && !hasUsableString) {
    return <span className={className}>{children ?? text}</span>
  }

  return (
    <Suspense fallback={<span className={className}>{children ?? text}</span>}>
      <TextAnimationRenderer
        animation={textAnimation}
        text={displayText}
        className={className}
      >
        {children}
      </TextAnimationRenderer>
    </Suspense>
  )
}

// ── Renderer ─────────────────────────────────────────────────────────────────

interface RendererProps {
  animation: TextAnimationId
  text: string
  className?: string
  children?: ReactNode
}

function TextAnimationRenderer({ animation, text, className, children }: RendererProps) {
  switch (animation) {
    case 'shiny':
      return <ShinyTextInline className={className}>{children ?? text}</ShinyTextInline>

    case 'gradient':
      return (
        <GradientText
          className={className}
          colors={['#aa1d8b', '#ff9ffc', '#5227ff']}
          animationSpeed={6}
        >
          {children ?? text}
        </GradientText>
      )

    case 'glitch':
      return (
        <GlitchText
          className={cn('text-inherit! font-[inherit]! text-[length:inherit]!', className)}
          speed={0.7}
          enableShadows={false}
        >
          {text}
        </GlitchText>
      )

    case 'decrypted':
      return (
        <span className={className}>
          <DecryptedText text={text} speed={60} revealDirection="start" />
        </span>
      )

    case 'blur':
      return (
        <span className={className}>
          <BlurText text={text} delay={50} />
        </span>
      )

    case 'split':
      return <SplitTextInline text={text} className={className} />

    case 'scrambled':
      return (
        <span className={className}>
          <ScrambledText>{text}</ScrambledText>
        </span>
      )

    case 'fuzzy':
      return (
        <span className={className}>
          <FuzzyText baseIntensity={0.2} hoverIntensity={0.5} fontSize="inherit">
            {text}
          </FuzzyText>
        </span>
      )

    case 'rotating':
      return (
        <span className={className}>
          <RotatingText texts={[text]} rotationInterval={4000} />
        </span>
      )

    case 'trueFocus':
      return (
        <span className={className}>
          <TrueFocus sentence={text} blurAmount={3} animationDuration={1} />
        </span>
      )

    case 'none':
    default:
      return <span className={className}>{children ?? text}</span>
  }
}

// ── Inline Shiny Text (same as before, no lazy needed) ───────────────────────

function ShinyTextInline({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'shiny-text-effect inline-block animate-shiny-text bg-size-[200%_100%] bg-clip-text',
        className,
      )}
      style={{
        backgroundImage:
          'linear-gradient(90deg, currentColor 40%, oklch(0.8 0.1 260 / 80%) 50%, currentColor 60%)',
        WebkitTextFillColor: 'transparent',
        animationDuration: '3s',
      }}
    >
      {children}
    </span>
  )
}

// ── Inline Split Text ────────────────────────────────────────────────────────

function SplitTextInline({ text, className }: { text: string; className?: string }) {
  const chars = text.split('')

  return (
    <span className={cn('inline-flex', className)}>
      {chars.map((char: string, i: number) => (
        <motion.span
          key={`${char}-${i}`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.03, duration: 0.3 }}
        >
          {char === ' ' ? '\u00A0' : char}
        </motion.span>
      ))}
    </span>
  )
}
