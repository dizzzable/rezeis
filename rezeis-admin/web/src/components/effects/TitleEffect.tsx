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
 *     "trueFocus", "fuzzy", "shuffle", "typewriter", "proximity") fall back
 *     to rendering the children plainly, because they cannot animate
 *     arbitrary JSX. See STRING_ONLY_ANIMATIONS.
 *
 * Usage:
 *   <TitleEffect>{t('dashboardPage.title')}</TitleEffect>
 *   <TitleEffect text="Static text" />
 */
import { lazy, Suspense, useRef, type ReactNode } from 'react'
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
const Shuffle = lazy(() => import('@/components/reactbits/Shuffle'))
const TextType = lazy(() => import('@/components/reactbits/TextType'))
const VariableProximity = lazy(() => import('@/components/reactbits/VariableProximity'))

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

/**
 * Animations that need a plain string and cannot animate JSX.
 *
 * This set is also the empty-string guard. `TextType` reads
 * `textArray[currentTextIndex].length` with no guard of its own, which throws
 * on `''`; `Shuffle` takes `text: string` and `VariableProximity` takes
 * `label: string`. Membership here routes all three through the
 * `hasUsableString` check in `TitleEffect` below, which returns plain markup
 * BEFORE the `<Suspense>` boundary — so those components are never constructed
 * with an empty string.
 */
const STRING_ONLY_ANIMATIONS: ReadonlySet<TextAnimationId> = new Set<TextAnimationId>([
  'decrypted', 'blur', 'glitch', 'scrambled', 'rotating', 'trueFocus', 'fuzzy',
  'shuffle', 'typewriter', 'proximity',
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

    case 'shuffle':
      return <ShuffleInline text={text} className={className} />

    case 'typewriter':
      return <TypewriterInline text={text} className={className} />

    case 'proximity':
      return <VariableProximityInline text={text} className={className} />

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

// ── Shuffle (reactbits/Shuffle) ──────────────────────────────────────────────

/**
 * Every token below is load-bearing; none of it is decoration.
 *
 * `tag="span"` — the component defaults to `<p>`, which is a block element and
 * is invalid inside the `<h1>` both call sites render.
 *
 * `font-[inherit]!` — twice. It restores the theme font (the component stamps
 * `fontFamily: computedFont` onto every split char), and it satisfies the
 * component's own `userHasFont = /font[-[]/i.test(className)` test, which is
 * the only thing suppressing its `'Press Start 2P'` fallback. That face is not
 * a dependency of this app, so without the token every heading using this
 * effect would fall through to the generic `sans-serif`.
 *
 * The `!` on all four is not cargo cult. The component bakes
 * `uppercase text-2xl leading-none` into its own class list, and utilities at
 * equal specificity are resolved by STYLESHEET order, not class-attribute
 * order. In the emitted `@layer utilities` block, `.uppercase` is written
 * AFTER `.normal-case` — so an unprefixed `normal-case` loses and the heading
 * renders in caps. Same reasoning as the `glitch` case above.
 *
 * `visible!` — the component renders itself `invisible` until its ScrollTrigger
 * fires `onEnter`. Under `prefers-reduced-motion: reduce` that callback is
 * never scheduled at all (the `useGSAP` body returns before `setReady(true)`),
 * so the heading would stay `visibility: hidden` permanently for exactly the
 * users least able to work around it.
 */
function ShuffleInline({ text, className }: { text: string; className?: string }) {
  return (
    <Shuffle
      text={text}
      tag="span"
      textAlign="inherit"
      className={cn(
        'font-[inherit]! text-[length:inherit]! leading-[inherit]! normal-case! visible!',
        className,
      )}
      shuffleDirection="right"
      duration={0.35}
      stagger={0.03}
      shuffleTimes={1}
      animationMode="evenodd"
      triggerOnHover
    />
  )
}

// ── Typewriter (reactbits/TextType) ──────────────────────────────────────────

/**
 * `as="span"` — the component defaults to `'div'`, a block element inside an
 * `<h1>`.
 *
 * `loop={false}` — the component's default is `true`. Left alone it types the
 * page title, pauses, deletes it character by character and retypes it, for as
 * long as the page is open.
 *
 * The two-cell grid is the layout-shift fix. The component starts from
 * `displayedText === ''`, so the heading has no width until the first character
 * lands. The `opacity-0` copy occupies the same grid cell and reserves the
 * final line box from the first frame; it also stays in the accessibility tree
 * while the animated copy is `aria-hidden`, so assistive tech gets one stable
 * string instead of one announcement per keystroke. `inline-grid` keeps this
 * inline-level — a `grid` here would be the block element the contract forbids.
 */
function TypewriterInline({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('inline-grid', className)}>
      <span className="col-start-1 row-start-1 opacity-0">{text}</span>
      <span aria-hidden="true" className="col-start-1 row-start-1">
        <TextType
          as="span"
          text={text}
          loop={false}
          typingSpeed={50}
          initialDelay={0}
          showCursor
          cursorBlinkDuration={0.5}
          hideCursorWhileTyping={false}
        />
      </span>
    </span>
  )
}

// ── Variable Proximity (reactbits/VariableProximity) ─────────────────────────

/**
 * The component measures the pointer against a `containerRef` it does not own.
 * `TitleEffect` has no such element, so one is rendered here — an inline
 * `<span>`, because the contract is that this renders inside a heading that
 * already sets size and weight.
 *
 * The two font-variation strings are wiring constants, not operator controls:
 * they are raw CSS axis syntax, and `'wght' 400` → `'wght' 900` is the only
 * axis every installed face carries. The nine `@fontsource-variable/*` families
 * are all imported through their `wght.css` entry (`font-weight: 100 900`,
 * `woff2-variations`). `@fontsource/ibm-plex-mono` is static — a variation
 * setting it has no axis for is simply not applied, which is a no-op, not an
 * error.
 */
function VariableProximityInline({ text, className }: { text: string; className?: string }) {
  const boxRef = useRef<HTMLSpanElement | null>(null)

  return (
    <span ref={boxRef} className={cn('inline', className)}>
      <VariableProximity
        label={text}
        containerRef={boxRef}
        fromFontVariationSettings="'wght' 400"
        toFontVariationSettings="'wght' 900"
        radius={80}
        falloff="gaussian"
      />
    </span>
  )
}

// ── Inline Split Text ────────────────────────────────────────────────────────

function SplitTextInline({ text, className }: { text: string; className?: string }) {
  const chars = text.split('')

  return (
    <span className={cn('inline-flex', className)}>
      {/*
        The accessible copy, and the only thing assistive tech reads here.

        Every character sits in its own element, and an accessible name is built
        by trimming each element's contribution and joining what is left \u2014 so the
        element holding the space between two words trims to nothing and
        disappears. An `<h1>` reading "Promo codes" was announced as
        "Promocodes". Measured, not deduced: `computeAccessibleName` on the
        heading returned exactly that, with no space of any kind in it.
        `aria-label` on the wrapper is not the fix \u2014 that span has no role, so it
        is `generic`, and a generic element takes no name from the author.

        Roughly half the section headings in this panel are two words, and this
        animation now reaches all of them. `TypewriterInline` above already
        solves it the same way: one stable string in the tree, the animated copy
        hidden from it.
      */}
      <span className="sr-only">{text}</span>
      {chars.map((char: string, i: number) => (
        <motion.span
          key={`${char}-${i}`}
          aria-hidden="true"
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
