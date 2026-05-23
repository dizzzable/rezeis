/**
 * ShinyText — backward-compatible wrapper that delegates to TitleEffect.
 * The actual animation is determined by the effects-store setting.
 */
import { type ReactNode } from 'react'
import { TitleEffect } from './TitleEffect'

interface ShinyTextProps {
  children: ReactNode
  className?: string
  /** @deprecated — duration is now controlled by the effects store */
  duration?: number
  /** Whether to disable the effect regardless of global toggle */
  disabled?: boolean
}

export function ShinyText({
  children,
  className,
  disabled = false,
}: ShinyTextProps) {
  const text = typeof children === 'string' ? children : undefined

  return (
    <TitleEffect className={className} disabled={disabled} text={text}>
      {children}
    </TitleEffect>
  )
}
