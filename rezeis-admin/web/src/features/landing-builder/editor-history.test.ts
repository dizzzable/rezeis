import { describe, expect, it } from 'vitest'

import {
  COALESCE_WINDOW_MS,
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  commitHistory,
  fieldMergeKey,
  initHistory,
  redoHistory,
  undoHistory,
} from './editor-history'

const KEY = fieldMergeKey('hero-1', ['heading', 'ru'])
const OTHER_KEY = fieldMergeKey('hero-1', ['subheading', 'ru'])

describe('editor history', () => {
  it('starts with nothing to undo or redo', () => {
    const state = initHistory('a')
    expect(canUndo(state)).toBe(false)
    expect(canRedo(state)).toBe(false)
    expect(state.present.value).toBe('a')
  })

  it('pushes a step for a structural edit', () => {
    const state = commitHistory(initHistory('a'), 'b', { at: 1000 })
    expect(canUndo(state)).toBe(true)
    expect(state.present.value).toBe('b')
    expect(undoHistory(state).present.value).toBe('a')
  })

  it('collapses a run of keystrokes in the same field into one step', () => {
    let state = initHistory('')
    state = commitHistory(state, 'h', { mergeKey: KEY, at: 1000 })
    state = commitHistory(state, 'he', { mergeKey: KEY, at: 1100 })
    state = commitHistory(state, 'hel', { mergeKey: KEY, at: 1200 })

    expect(state.present.value).toBe('hel')
    // One step back returns to the value before the run began, not to 'he'.
    expect(undoHistory(state).present.value).toBe('')
    expect(canUndo(undoHistory(state))).toBe(false)
  })

  it('keeps coalescing across a long continuous run', () => {
    // Each keystroke lands within the window of the PREVIOUS one, so the run
    // must stay a single step however long it goes on.
    let state = initHistory('')
    for (let i = 1; i <= 20; i += 1) {
      state = commitHistory(state, 'x'.repeat(i), { mergeKey: KEY, at: 1000 + i * 100 })
    }
    expect(state.past).toHaveLength(1)
    expect(undoHistory(state).present.value).toBe('')
  })

  it('starts a new step once the pause exceeds the window', () => {
    let state = initHistory('')
    state = commitHistory(state, 'a', { mergeKey: KEY, at: 1000 })
    state = commitHistory(state, 'ab', { mergeKey: KEY, at: 1000 + COALESCE_WINDOW_MS + 1 })
    expect(undoHistory(state).present.value).toBe('a')
  })

  it('never merges edits to two different fields, however fast', () => {
    // The reason coalescing is keyed on the field and not on time alone:
    // typing in one input and immediately in another are two separate edits.
    let state = initHistory('')
    state = commitHistory(state, 'a', { mergeKey: KEY, at: 1000 })
    state = commitHistory(state, 'a+b', { mergeKey: OTHER_KEY, at: 1010 })
    expect(undoHistory(state).present.value).toBe('a')
  })

  it('never merges a structural edit into a typing run', () => {
    let state = initHistory('')
    state = commitHistory(state, 'a', { mergeKey: KEY, at: 1000 })
    state = commitHistory(state, 'a+section', { at: 1010 })
    expect(undoHistory(state).present.value).toBe('a')
  })

  it('restores the selection that belonged to the step', () => {
    // Undoing an edit made in another section, while staying parked on the
    // current one, looks exactly like undo having done nothing.
    let state = initHistory('a', 'hero-1')
    state = commitHistory(state, 'b', { selectedId: 'faq-2', at: 1000 })
    const undone = undoHistory(state)
    expect(undone.present.value).toBe('a')
    expect(undone.present.selectedId).toBe('hero-1')
  })

  it('redoes an undone step and then has nothing left to redo', () => {
    let state = commitHistory(initHistory('a'), 'b', { at: 1000 })
    state = undoHistory(state)
    expect(canRedo(state)).toBe(true)
    state = redoHistory(state)
    expect(state.present.value).toBe('b')
    expect(canRedo(state)).toBe(false)
  })

  it('drops the redo branch as soon as a new edit is made', () => {
    let state = commitHistory(initHistory('a'), 'b', { at: 1000 })
    state = undoHistory(state)
    state = commitHistory(state, 'c', { at: 2000 })
    expect(canRedo(state)).toBe(false)
    expect(undoHistory(state).present.value).toBe('a')
  })

  it('does not let a keystroke merge into a step restored by undo', () => {
    // After undo the tip is a restored snapshot. If it kept its old mergeKey,
    // the next keystroke in that same field would overwrite it and the undone
    // step would be unreachable.
    let state = initHistory('')
    state = commitHistory(state, 'a', { mergeKey: KEY, at: 1000 })
    state = commitHistory(state, 'ab', { mergeKey: KEY, at: 5000 })
    state = undoHistory(state)
    state = commitHistory(state, 'aX', { mergeKey: KEY, at: 5100 })
    expect(undoHistory(state).present.value).toBe('a')
  })

  it('is a no-op at either end of the stack', () => {
    const fresh = initHistory('a')
    expect(undoHistory(fresh)).toBe(fresh)
    expect(redoHistory(fresh)).toBe(fresh)
  })

  it('caps retained steps and keeps the most recent ones', () => {
    let state = initHistory(0)
    for (let i = 1; i <= HISTORY_LIMIT + 25; i += 1) {
      state = commitHistory(state, i, { at: i * 10_000 })
    }
    expect(state.past.length).toBe(HISTORY_LIMIT)
    expect(state.present.value).toBe(HISTORY_LIMIT + 25)
    // The oldest entries fell off the back, not the newest.
    expect(state.past[state.past.length - 1].value).toBe(HISTORY_LIMIT + 24)
  })

  it('builds a distinct merge key per section and field', () => {
    expect(fieldMergeKey('a', ['heading', 'ru'])).not.toBe(fieldMergeKey('b', ['heading', 'ru']))
    expect(fieldMergeKey('a', ['heading', 'ru'])).not.toBe(fieldMergeKey('a', ['heading', 'en']))
  })
})
