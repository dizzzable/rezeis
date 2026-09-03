import { describe, expect, it } from 'vitest'

import { getErrorMessage } from './http-errors'

describe('getErrorMessage', () => {
  it('extracts NestJS-style response.data.message', () => {
    const err = { response: { data: { message: 'Plan is archived' } } }
    expect(getErrorMessage(err, 'fallback')).toBe('Plan is archived')
  })

  it('falls back to response.data.error when message is missing', () => {
    const err = { response: { data: { error: 'INVALID_INPUT' } } }
    expect(getErrorMessage(err, 'fallback')).toBe('INVALID_INPUT')
  })

  it('falls back to error.message for plain Error instances', () => {
    const err = new Error('Network unreachable')
    expect(getErrorMessage(err, 'fallback')).toBe('Network unreachable')
  })

  it('returns fallback when error is null', () => {
    expect(getErrorMessage(null, 'fallback')).toBe('fallback')
  })

  it('returns fallback when error is undefined', () => {
    expect(getErrorMessage(undefined, 'fallback')).toBe('fallback')
  })

  it('returns fallback for non-object errors', () => {
    expect(getErrorMessage('string error', 'fallback')).toBe('fallback')
    expect(getErrorMessage(42, 'fallback')).toBe('fallback')
  })

  it('prefers response.data.message over response.data.error', () => {
    const err = { response: { data: { message: 'high', error: 'low' } } }
    expect(getErrorMessage(err, 'fallback')).toBe('high')
  })

  it('prefers response.data over top-level message', () => {
    const err = { response: { data: { message: 'high' } }, message: 'low' }
    expect(getErrorMessage(err, 'fallback')).toBe('high')
  })

  it('returns fallback when response.data.message is empty string', () => {
    const err = { response: { data: { message: '' } } }
    expect(getErrorMessage(err, 'fallback')).toBe('fallback')
  })
})

describe('a validation failure', () => {
  it('reads as the fields it named, not as "Bad Request"', () => {
    // NestJS' ValidationPipe answers with one line per field and an `error`
    // of "Bad Request". Reading the latter told the operator nothing.
    const err = {
      response: {
        data: {
          message: ['weight must not be greater than 100000', 'amount must be an integer'],
          error: 'Bad Request',
        },
      },
    }

    expect(getErrorMessage(err, 'fallback')).toBe(
      'weight must not be greater than 100000; amount must be an integer',
    )
  })

  it('falls through an empty list rather than showing a blank toast', () => {
    const err = { response: { data: { message: [], error: 'Bad Request' } } }

    expect(getErrorMessage(err, 'fallback')).toBe('Bad Request')
  })
})
