import { describe, expect, it } from 'vitest'

import { buildActionPayload } from './bot-button-payload'

describe('buildActionPayload', () => {
  it.each(['CALLBACK', 'SUPPORT_URL'] as const)('clears a stale target for %s actions', (actionType) => {
    expect(buildActionPayload(actionType, ' https://stale.example ')).toEqual({
      actionType,
      actionTarget: null,
    })
  })

  it('trims target values that belong to target-bearing actions', () => {
    expect(buildActionPayload('URL', ' https://example.com ')).toEqual({
      actionType: 'URL',
      actionTarget: 'https://example.com',
    })
  })

  it('normalizes an empty target to null', () => {
    expect(buildActionPayload('SCREEN', '   ')).toEqual({
      actionType: 'SCREEN',
      actionTarget: null,
    })
  })
})
