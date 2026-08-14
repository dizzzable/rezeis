/**
 * EmojiFieldOverlay — draws bot copy over the field that holds it.
 * ───────────────────────────────────────────────────────────────
 * Wraps a NATIVE `<input>` / `<textarea>` (never replaces it) and paints a
 * read-only layer on top showing `:slug:` tokens as the pack picture the panel
 * already downloaded, so the operator reads the line the way Telegram draws it
 * instead of `:tg_ios_macos_icons_25: Перейти в канал`.
 *
 * WHY AN OVERLAY THAT STEPS ASIDE, AND NOT A `contentEditable` CHIP EDITOR
 *
 * A `contentEditable` can show chips while you type, but caret, selection,
 * paste, undo and IME all become hand-written code; `emoji-text-editor.tsx` in
 * this same folder is exactly that experiment and is imported by nothing. The
 * field here stays a real form control, so every one of those behaviours is
 * still the browser's, byte for byte — including `maxLength`, autosize, and
 * `Ctrl+Z`.
 *
 * An always-on overlay is not possible either, and the reason is arithmetic
 * rather than styling: the caret is positioned by the FIELD, so the layer over
 * it must reproduce the field's metrics exactly. `:tg_ios_macos_icons_25:` is
 * 23 character cells wide and the picture is one line tall — substituting one
 * for the other moves every character after it, and the caret lands somewhere
 * the operator did not click. No amount of font matching fixes that; the two
 * lengths are simply different.
 *
 * So the layer is shown only while the field is NOT focused, and removed the
 * instant it takes focus. Idle → the operator sees emoji. Editing → the
 * operator sees, and edits, the exact stored token text with a native caret.
 * While editing, `liveStrip` keeps the rendered line visible directly under
 * the field, so the emoji never disappears from view.
 *
 * The field's value is never touched: this component takes `value` read-only
 * and renders. What is typed is what is stored.
 */
import { useMemo, useState, type FocusEvent, type JSX, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import { useEmojiCatalog } from './emoji-catalog'
import {
  hasRenderedEmoji,
  renderEmojiField,
  type EmojiFieldIcon,
  type EmojiFieldMode,
  type EmojiFieldPart,
  type EmojiFieldRender,
} from './emoji-field-render'

// The catalog — the three queries, their schemas and the Premium fallback —
// lives in `./emoji-catalog`, shared with the copy preview. It used to be
// declared here and again there, which is how the preview missed the `ready`
// gate below for a while: one rule, two wirings.

interface EmojiFieldOverlayProps {
  /** The field's current value — read-only here; rendering never rewrites it. */
  readonly value: string
  /** Which renderer this field feeds. `buttonLabel` lifts the leading token. */
  readonly mode?: EmojiFieldMode
  /** `true` for a `<textarea>`: wrap lines instead of clipping to one. */
  readonly multiline?: boolean
  /**
   * Typography + padding of the wrapped field, repeated on the layer. The
   * layer only has to line up while the field is idle, but a matching size
   * keeps the swap on focus from jumping.
   */
  readonly overlayClassName?: string
  /** Keeps the rendered line visible under the field while it is focused. */
  readonly liveStrip?: boolean
  /**
   * Pass the same value the wrapped field gets.
   *
   * The layer paints an opaque `bg-background` over the control, so a field
   * styled `disabled:opacity-50` looks fully enabled underneath it — and the
   * fields that disable themselves do it mid-save, exactly when the operator is
   * watching. The layer dims with the field instead of contradicting it.
   */
  readonly disabled?: boolean
  readonly className?: string
  /**
   * Anything absolutely positioned against the field itself — the emoji
   * picker trigger, a counter. Rendered inside the field's own box so it stays
   * put when the live strip appears, and above the layer so it stays clickable.
   */
  readonly adornment?: ReactNode
  /** The real `<Input>` / `<Textarea>`. */
  readonly children: ReactNode
}

export function EmojiFieldOverlay({
  value,
  mode = 'text',
  multiline = false,
  overlayClassName,
  liveStrip = true,
  disabled = false,
  className,
  adornment,
  children,
}: EmojiFieldOverlayProps): JSX.Element {
  const catalog = useEmojiCatalog()
  const [editing, setEditing] = useState(false)

  const render = useMemo<EmojiFieldRender>(
    () =>
      renderEmojiField(value, {
        slugs: catalog.slugs,
        slots: catalog.slots,
        mode,
        ownerHasPremium: catalog.ownerHasPremium,
      }),
    [value, catalog, mode],
  )

  // `catalog.ready` first: with an empty catalog every token resolves to
  // "unknown", so `hasRenderedEmoji` is already true and the layer would go up
  // accusing correct content of being undeliverable until the fetch lands.
  const showsEmoji = catalog.ready && hasRenderedEmoji(render)

  // The icon row waits for the same gate, and for the same reason — it just
  // fails through a different query. Promotion asks only for `ownerHasPremium`
  // plus a leading token with an id behind it, and `ownerHasPremium` falls back
  // to `true` while the studio query is still in flight. The packs and that flag
  // land separately, so a field whose packs arrived first announces "this token
  // becomes the button's own icon" on the strength of an answer nobody has given
  // yet — and for an owner without Premium the answer is no, which the row then
  // retracts a moment later. Same false alarm the layer's gate exists to stop.
  const shownIcon = catalog.ready ? render.icon : null

  // Focus moving between the field and an adornment (the picker trigger) inside
  // the same wrapper must not flicker the layer off and back on.
  //
  // KNOWN GAP, left open on purpose rather than patched with a timer. This only
  // covers controls INSIDE the wrapper. A picker passed through `adornment` is
  // therefore immune — it renders within the box this handler tests. Every
  // screen that instead places the picker as a normal-flow SIBLING is affected,
  // because it cannot move into `adornment` without dropping below the field:
  //
  //   `LocaleTextarea`                  label row above          2 fields
  //   `NotificationButtonRow`           label row above          2 fields
  //   `SystemScreenTexts`               label row above          4 fields
  //   `BotButtonEditDialog` +
  //     `BotButtonCreateDialog`         label row above          2 fields
  //   `SortableReplyButtonCard`         label row above          1 field
  //   `ScreenEditorPanel`               label row above          2 fields
  //   `ButtonEditor` (same file)        inline, right of it      2 fields
  //
  // Opening that popover blurs the field, so the layer returns for as long as
  // the popover is open and leaves again on insert: a visible flicker on every
  // pick. Fifteen fields, not the three this list used to name — an inventory
  // that reads as exhaustive and is not is worse than no inventory, because the
  // screens it omits look like screens somebody already cleared.
  //
  // The honest fix needs an API, not a heuristic — the component has to be told
  // "this control outside my box still belongs to me", e.g. an `ownedBy` ref
  // list or an explicit `suppressed` prop the caller drives from its popover
  // state. Guessing instead (a grace period after blur, or sniffing
  // `document.activeElement` for a popover role) would make the layer's timing
  // depend on how fast the operator moves, which is worse than a flicker.
  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setEditing(false)
  }

  return (
    <div className={cn('space-y-1', className)} onFocus={() => setEditing(true)} onBlur={handleBlur}>
      {shownIcon !== null && <ButtonIconRow icon={shownIcon} />}

      <div className="relative">
        {children}
        {showsEmoji && !editing && (
          <div
            aria-hidden
            data-testid="emoji-field-overlay"
            className={cn(
              // `inset-px` keeps the field's own 1px border visible around it.
              'pointer-events-none absolute inset-px overflow-hidden rounded-[5px] bg-background px-3 py-2 text-sm',
              multiline ? 'whitespace-pre-wrap break-words' : 'flex items-center whitespace-nowrap',
              // Matches the `disabled:opacity-50` the wrapped control carries.
              disabled && 'opacity-50',
              overlayClassName,
            )}
          >
            {render.parts.map((part, index) => (
              <FieldPart key={`${index}-${partKey(part)}`} part={part} mode={mode} />
            ))}
          </div>
        )}
        {adornment}
      </div>

      {showsEmoji && editing && liveStrip && (
        <p
          aria-hidden
          data-testid="emoji-field-strip"
          className={cn(
            'text-xs text-muted-foreground',
            multiline ? 'whitespace-pre-wrap break-words' : 'truncate',
          )}
        >
          {render.parts.map((part, index) => (
            <FieldPart key={`${index}-${partKey(part)}`} part={part} mode={mode} />
          ))}
        </p>
      )}
    </div>
  )
}

function partKey(part: EmojiFieldPart): string {
  return part.kind === 'text' ? part.text : part.token
}

/**
 * The leading token of a button caption does not live in the caption at all —
 * reiwa moves it to `icon_custom_emoji_id` and Telegram draws it as the
 * button's own icon. Drawing it inline would swap one lie for another, so it
 * gets its own row above the field and is absent from the caption below.
 */
function ButtonIconRow({ icon }: { readonly icon: EmojiFieldIcon }): JSX.Element {
  const { t } = useTranslation()
  const title = t('emojiField.buttonIconHint', { token: icon.token })

  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={title}>
      {icon.imageUrl !== null ? (
        <img
          src={icon.imageUrl}
          alt={icon.token}
          className="h-4 w-4 shrink-0 object-contain"
          draggable={false}
        />
      ) : (
        <span className="text-sm leading-none">{icon.glyph}</span>
      )}
      <span>{t('emojiField.buttonIconLabel')}</span>
    </span>
  )
}

function FieldPart({
  part,
  mode,
}: {
  readonly part: EmojiFieldPart
  readonly mode: EmojiFieldMode
}): JSX.Element {
  const { t } = useTranslation()

  if (part.kind === 'text') return <>{part.text}</>

  if (part.kind === 'image') {
    return (
      <img
        src={part.imageUrl}
        alt={part.token}
        title={t('emojiField.tokenImage', { token: part.token })}
        // Static art on purpose: an input is not a place to run animations.
        className="mx-0.5 inline-block h-5 w-5 shrink-0 align-text-bottom object-contain"
        draggable={false}
      />
    )
  }

  if (part.kind === 'glyph') {
    return (
      <span
        title={t(
          mode === 'buttonLabel' ? 'emojiField.tokenGlyphButton' : 'emojiField.tokenGlyph',
          { token: part.token },
        )}
      >
        {part.glyph}
      </span>
    )
  }

  return (
    <span
      title={t(
        part.reason === 'unknown' ? 'emojiField.tokenUnknown' : 'emojiField.tokenDead',
        { token: part.token },
      )}
      className="rounded bg-destructive/10 px-1 font-mono text-xs text-destructive"
    >
      {part.token}
    </span>
  )
}
