/**
 * Pure caret-insertion helper shared by the bot-map copy editors. Splices
 * `insert` into `value` over the `[start, end)` selection and reports the new
 * caret position. Indices are clamped so an out-of-range selection (or a stale
 * ref) can never drop or duplicate surrounding text.
 */
export function insertAtCaret(
  value: string,
  start: number,
  end: number,
  insert: string,
): { readonly value: string; readonly caret: number } {
  const safeStart = Math.max(0, Math.min(start, value.length))
  const safeEnd = Math.max(safeStart, Math.min(end, value.length))
  const next = value.slice(0, safeStart) + insert + value.slice(safeEnd)
  return { value: next, caret: safeStart + insert.length }
}
