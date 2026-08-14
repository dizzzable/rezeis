import { useRef, type ComponentProps } from 'react'

import { EmojiFieldOverlay } from '@/features/custom-emoji/emoji-field-overlay'
import type { EmojiFieldMode } from '@/features/custom-emoji/emoji-field-render'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { EmojiPicker } from './emoji-picker'

/**
 * Text input with a trailing emoji picker. Inserts the chosen emoji at the
 * caret (falls back to appending) and restores focus + selection. Standard
 * Unicode emoji render everywhere; custom-pack emoji insert as `:slug:`
 * shortcodes.
 *
 * The shortcode is what gets STORED, but it is not what the operator has to
 * read: `EmojiFieldOverlay` draws the pack picture over the idle field and
 * steps aside the moment it is focused, so the caret, selection, paste and
 * undo below are still the browser's own. See that module for why the layer
 * cannot stay up while typing.
 */
type EmojiTextInputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly emojiAriaLabel: string
  /**
   * `buttonLabel` for a field that becomes an inline-button caption — a
   * leading shortcode is drawn as the button's separate icon there, because
   * that is where the bot puts it.
   */
  readonly emojiMode?: EmojiFieldMode
}

export function EmojiTextInput({
  value,
  onChange,
  emojiAriaLabel,
  emojiMode = 'text',
  className,
  // Named rather than left in `...rest`, which would put it on the `<Input>`
  // alone: the layer paints an opaque background over that input, so a field
  // dimming by itself through `disabled:opacity-50` dims BEHIND something drawn
  // at full strength, and the control still reads as enabled. No caller passes
  // `disabled` today — wired now so the first one that does gets a field that
  // dims, instead of a bug report.
  disabled,
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
    <EmojiFieldOverlay
      value={value}
      mode={emojiMode}
      overlayClassName="pr-9"
      disabled={disabled}
      adornment={
        <div className="absolute right-1 top-1/2 -translate-y-1/2">
          <EmojiPicker onSelect={insert} ariaLabel={emojiAriaLabel} />
        </div>
      }
    >
      <Input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('pr-9', className)}
        disabled={disabled}
        {...rest}
      />
    </EmojiFieldOverlay>
  )
}
