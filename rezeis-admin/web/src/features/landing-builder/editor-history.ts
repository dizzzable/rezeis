/**
 * editor-history
 * ──────────────
 * Undo/redo for the landing builder, as a pure reducer over full snapshots.
 *
 * Full snapshots rather than diffs or a CRDT: a landing config is a small JSON
 * document, and the industry pattern for documents this size (Puck, Payload,
 * WordPress revisions) is snapshot-and-cap. Diff chains buy nothing here and
 * make every restore a replay.
 *
 * Two details carry most of the value:
 *
 *  - **Selection travels with the snapshot.** Undoing an edit you made in one
 *    section while looking at another, and being left staring at the unchanged
 *    section, reads as "undo did nothing".
 *
 *  - **Typing coalesces by `mergeKey`.** Without it every keystroke is an undo
 *    step and Ctrl+Z becomes useless. Merging purely on a time window is the
 *    naive version and is wrong: typing in one field, then quickly in another,
 *    would fuse two unrelated edits into one entry. Keying the merge on the
 *    field being edited means a run of keystrokes in the SAME field collapses,
 *    and moving to a different field always starts a new entry.
 *
 * Structural actions (add/remove/move/duplicate a section, apply a template or
 * a theme preset) pass no `mergeKey`, so they are always their own step — those
 * are exactly the actions a user reaches for undo after.
 *
 * Time is injected (`at`) rather than read here, so the coalescing window is
 * testable without faking timers.
 */

/** Keystrokes closer together than this in the same field collapse into one step. */
export const COALESCE_WINDOW_MS = 500

/** Upper bound on retained steps; older ones fall off the back. */
export const HISTORY_LIMIT = 100

export interface HistorySnapshot<T> {
  readonly value: T
  readonly selectedId: string | null
  /** Field identity for coalescing; `null` for a structural (never-merged) step. */
  readonly mergeKey: string | null
  readonly at: number
}

export interface HistoryState<T> {
  readonly past: readonly HistorySnapshot<T>[]
  readonly present: HistorySnapshot<T>
  readonly future: readonly HistorySnapshot<T>[]
}

export interface CommitOptions {
  readonly selectedId?: string | null
  readonly mergeKey?: string | null
  readonly at: number
}

export function initHistory<T>(value: T, selectedId: string | null = null): HistoryState<T> {
  return {
    past: [],
    present: { value, selectedId, mergeKey: null, at: 0 },
    future: [],
  }
}

/**
 * Records a new value. Coalesces into the current step when the edit continues
 * the same field within the window; otherwise pushes a new step. Any commit
 * discards the redo stack — that branch of history is no longer reachable.
 */
export function commitHistory<T>(
  state: HistoryState<T>,
  value: T,
  options: CommitOptions,
): HistoryState<T> {
  const selectedId = options.selectedId === undefined ? state.present.selectedId : options.selectedId
  const mergeKey = options.mergeKey ?? null
  const next: HistorySnapshot<T> = { value, selectedId, mergeKey, at: options.at }

  const continuesSameField =
    mergeKey !== null &&
    state.present.mergeKey === mergeKey &&
    options.at - state.present.at <= COALESCE_WINDOW_MS

  if (continuesSameField) {
    // Replace the tip: the run of keystrokes stays one undo step, but the step
    // keeps advancing its timestamp so a continuous run never splits.
    return { past: state.past, present: next, future: [] }
  }

  const past = [...state.past, state.present]
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    present: next,
    future: [],
  }
}

export function canUndo<T>(state: HistoryState<T>): boolean {
  return state.past.length > 0
}

export function canRedo<T>(state: HistoryState<T>): boolean {
  return state.future.length > 0
}

export function undoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.past.length === 0) return state
  const previous = state.past[state.past.length - 1]
  return {
    past: state.past.slice(0, -1),
    // The restored step must not absorb the next keystroke into itself, so it
    // re-enters history as a structural (non-mergeable) tip.
    present: { ...previous, mergeKey: null },
    future: [state.present, ...state.future],
  }
}

export function redoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.future.length === 0) return state
  const [next, ...rest] = state.future
  return {
    past: [...state.past, state.present],
    present: { ...next, mergeKey: null },
    future: rest,
  }
}

/**
 * Merge key for a field edit inside a section. Anything that identifies the
 * exact field works; this shape keeps it readable in tests and debugging.
 */
export function fieldMergeKey(sectionId: string, path: readonly (string | number)[]): string {
  return `section:${sectionId}:${path.join('.')}`
}
