import { describe, expect, it } from 'vitest'

import { isRecord, unwrapPayload, unwrapPayloadOrArray } from './api-utils'

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it('rejects arrays, primitives and null', () => {
    expect(isRecord([])).toBe(false)
    expect(isRecord([1, 2])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('s')).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

describe('unwrapPayload', () => {
  it('returns inner record when wrapped in { data }', () => {
    const wrapped = { data: { id: '1', name: 'Plan' } }
    expect(unwrapPayload(wrapped)).toEqual({ id: '1', name: 'Plan' })
  })

  it('returns the record itself when not wrapped', () => {
    const raw = { id: '1', name: 'Plan' }
    expect(unwrapPayload(raw)).toEqual(raw)
  })

  it('throws when value is not a record', () => {
    expect(() => unwrapPayload([1, 2])).toThrow('errors.unexpectedResponsePayload')
    expect(() => unwrapPayload(null)).toThrow('errors.unexpectedResponsePayload')
    expect(() => unwrapPayload('s')).toThrow('errors.unexpectedResponsePayload')
  })
})

describe('unwrapPayloadOrArray', () => {
  it('passes arrays through directly', () => {
    expect(unwrapPayloadOrArray([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('returns inner array when wrapped in { data: [] }', () => {
    expect(unwrapPayloadOrArray({ data: [1, 2, 3] })).toEqual([1, 2, 3])
  })

  it('returns inner record when wrapped in { data: {} }', () => {
    expect(unwrapPayloadOrArray({ data: { a: 1 } })).toEqual({ a: 1 })
  })

  it('returns the record itself when not wrapped and value is record', () => {
    expect(unwrapPayloadOrArray({ a: 1 })).toEqual({ a: 1 })
  })

  it('returns the wrapper when data field is neither record nor array', () => {
    // Edge case: { data: "string" } — wrapper itself is the record we return.
    expect(unwrapPayloadOrArray({ data: 'string-value', other: 1 })).toEqual({
      data: 'string-value',
      other: 1,
    })
  })

  it('throws when value is null or primitive', () => {
    expect(() => unwrapPayloadOrArray(null)).toThrow('errors.unexpectedResponsePayload')
    expect(() => unwrapPayloadOrArray(42)).toThrow('errors.unexpectedResponsePayload')
  })
})
