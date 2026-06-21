import { describe, expect, it } from 'vitest'

import { insertAtCaret } from './insert-at-caret'

describe('insertAtCaret', () => {
  it('inserts at the caret preserving both sides', () => {
    const { value, caret } = insertAtCaret('Hello world', 5, 5, '😀')
    expect(value).toBe('Hello😀 world')
    expect(caret).toBe(5 + '😀'.length)
  })

  it('replaces the selected range', () => {
    const { value } = insertAtCaret('Hello world', 0, 5, 'Hi')
    expect(value).toBe('Hi world')
  })

  it('appends when caret is at the end', () => {
    const { value, caret } = insertAtCaret('abc', 3, 3, '🎁')
    expect(value).toBe('abc🎁')
    expect(caret).toBe(3 + '🎁'.length)
  })

  it('clamps out-of-range indices instead of dropping text', () => {
    const { value } = insertAtCaret('abc', 99, 99, 'X')
    expect(value).toBe('abcX')
  })

  it('clamps a reversed/negative selection', () => {
    const { value } = insertAtCaret('abc', -5, 2, 'X')
    expect(value).toBe('Xc')
  })

  it('never loses existing characters for a mid-string insert', () => {
    const original = 'промокод'
    const { value } = insertAtCaret(original, 4, 4, ':gift:')
    expect(value).toBe('пром:gift:окод')
    expect(value.replace(':gift:', '')).toBe(original)
  })
})
