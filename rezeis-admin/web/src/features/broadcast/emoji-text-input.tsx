import { useRef, type ComponentProps } from 'react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { EmojiPicker } from './emoji-picker'

/**
 * Text input with a trailing emoji picker. Inserts the chosen emoji at the
 * caret (falls back to appending) and restores focus + selection. Standard
 * Unicode emoji render everywhere; custom-pack emoji insert as `:slug:`
 * shortcodes (rendered wherever the shortcode renderer runs).
 */
type EmojiTextInputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly emojiAriaLabel: string
}

export function EmojiTextInput({
  value,
  onChange,
  emojiAriaLabel,
  className,
  ...rest
}: EmojiTextInputProps) {
  const ref = useRef<HTMLInputElement>(null)

  function insert(emoji: string): void {
    const el = ref.current
    if (!el) {
      onChange(value + emoji)
      return
    }
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    const next = value.slice(0, start) + emoji + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
    })
  }

  return (
    <div className="relative">
      <Input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('pr-9', className)}
        {...rest}
      />
      <div className="absolute right-1 top-1/2 -translate-y-1/2">
        <EmojiPicker onSelect={insert} ariaLabel={emojiAriaLabel} />
      </div>
    </div>
  )
}
